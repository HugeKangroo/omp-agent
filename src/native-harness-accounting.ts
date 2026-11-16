import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, withWriteLock } from "../vendor/harness2/upstream/src/store.ts";
import type { NativeHarnessDelegationLimits } from "./native-harness-delegation.ts";
import {
  captureWorkspaceText,
  deepFreeze,
  NativeFileError,
  nodeFileIo,
  validateRelativePath,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "./native-work.ts";

/**
 * Fixed accounting-owner checkpoint for the existing native coordinator.
 *
 * This module is storage, codec, CAS and projection only. Direct construction
 * of the coordinator with its optional accounting port uses it, the optional
 * durable backend source/origin path reuses it, and the optional instanced
 * entry now connects the original session association to it only when the host
 * explicitly sets durableAccounting; that wiring adds no resume authority. It
 * is not a second budget allocator, execution ledger, recovery authority or
 * session registry.
 * No identifier accepted or stored here grants authority. The trusted private
 * storage root is a host precondition; this leaf does not discover it.
 */

export const NATIVE_HARNESS_ACCOUNTING_SCHEMA = "omp-agent.native-harness-accounting.v1";
export const NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA =
  "omp-agent.native-harness-accounting-transition.v1";
export const NATIVE_HARNESS_ACCOUNTING_MAX_BYTES = 65_536;

const MAX_RETENTION = 16;
const MAX_POINTS = 33;
const USD_EPSILON = 1e-9;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const MAX_BYTES_BIGINT = BigInt(NATIVE_HARNESS_ACCOUNTING_MAX_BYTES);

const CHECKPOINT_KEYS = [
  "schema",
  "revision",
  "ownerId",
  "selectorSha256",
  "createdAt",
  "limits",
  "budgetBlock",
  "admissions",
] as const;
const LIMIT_KEYS = [
  "maxRetainedOperations",
  "maxConcurrent",
  "perRunUsd",
  "lifetimeUsd",
  "maxDurationMs",
  "cleanupGraceMs",
] as const;
const ADMISSION_KEYS = [
  "admissionId",
  "sourceAssociationSha256",
  "admittedAt",
  "deadlineAt",
  "allocatedUsd",
  "reserveRevision",
  "prepared",
  "runId",
  "settlement",
] as const;
const PREPARED_KEYS = [
  "preparedRelativeRoot",
  "storeRelativeRoot",
  "inputManifestSha256",
  "sourceDescriptorSha256",
] as const;
const SETTLEMENT_KEYS = ["revision", "mode", "observedUsd", "concurrencyHeld"] as const;
const BUDGET_BLOCK_KEYS = ["admissionId", "revision", "reason"] as const;

export type NativeHarnessAccountingErrorCode =
  | "invalid-input"
  | "invalid-transition"
  | "identity-mismatch"
  | "corrupt"
  | "unavailable"
  | "unsafe-path"
  | "changed"
  | "too-large"
  | "conflict"
  | "exhausted"
  | "closed"
  | "ambiguous";

export class NativeHarnessAccountingError extends Error {
  override name = "NativeHarnessAccountingError";

  constructor(message: string, readonly code: NativeHarnessAccountingErrorCode) {
    super(message);
  }
}

export interface NativeHarnessAccountingIdentity {
  readonly ownerId: string;
  readonly selectorSha256: string;
}

export interface NativeHarnessAccountingPrepared {
  readonly preparedRelativeRoot: string;
  readonly storeRelativeRoot: string;
  readonly inputManifestSha256: string;
  readonly sourceDescriptorSha256: string;
}

export type NativeHarnessAccountingSettlementMode = "no-dispatch" | "known" | "unknown";

export interface NativeHarnessAccountingSettlement {
  readonly revision: number;
  readonly mode: NativeHarnessAccountingSettlementMode;
  readonly observedUsd: number | null;
  readonly concurrencyHeld: boolean;
}

export interface NativeHarnessAccountingAdmission {
  readonly admissionId: string;
  readonly sourceAssociationSha256: string;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly allocatedUsd: number;
  readonly reserveRevision: number;
  readonly prepared: NativeHarnessAccountingPrepared | null;
  readonly runId: string | null;
  readonly settlement: NativeHarnessAccountingSettlement | null;
}

export interface NativeHarnessAccountingBudgetBlock {
  readonly admissionId: string;
  readonly revision: number;
  readonly reason: "observed-worker-overspend";
}

export interface NativeHarnessAccountingCheckpoint {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_SCHEMA;
  readonly revision: number;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly createdAt: number;
  readonly limits: NativeHarnessDelegationLimits;
  readonly budgetBlock: NativeHarnessAccountingBudgetBlock | null;
  readonly admissions: readonly NativeHarnessAccountingAdmission[];
}

export interface NativeHarnessAccountingProjection {
  readonly accountedUsd: number;
  readonly observedUsd: number;
  readonly unknownUsd: number;
  readonly overspendUsd: number;
  readonly activeOperations: number;
  readonly retainedOperations: number;
  readonly budgetBlocked: boolean;
}

export interface NativeHarnessAccountingCreateOptions {
  readonly storageRoot: string;
  readonly selectorSha256: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly limitsText: string;
}

export interface NativeHarnessAccountingOpenOptions {
  readonly storageRoot: string;
  readonly selectorSha256: string;
  readonly ownerId: string;
}

export interface NativeHarnessAccountingObserveOptions {
  readonly storageRoot: string;
  readonly selectorSha256: string;
}

/**
 * Readonly discovery result for a crash between owner creation and durable
 * locator confirmation. The observed ownerId is data, not a permission; only
 * an exact open/commit handle is mutable, and this result never is one.
 */
export interface NativeHarnessAccountingObservation {
  readonly identity: NativeHarnessAccountingIdentity;
  readonly checkpoint: NativeHarnessAccountingCheckpoint;
}

/**
 * Test-only seams. The after-write hook runs only after the imported actual
 * atomicWrite has returned. It cannot replace the writer or fabricate
 * persistence. Production code supplies no hook; there is no environment
 * switch and this is not a coordinator/host callback port.
 */
export interface NativeHarnessAccountingTestOptions {
  readonly fileIo?: NativeFileIo;
  readonly testAfterPrimaryWrite?: (event: {
    readonly path: string;
    readonly revision: number;
  }) => void | Promise<void>;
}

export interface NativeHarnessAccountingHandle {
  /** The last checkpoint owned by this handle, frozen. */
  snapshot(): NativeHarnessAccountingCheckpoint;
  /** One CAS attempt at exactly expectedRevision. */
  commit(expectedRevision: number, transitionText: string): Promise<NativeHarnessAccountingCheckpoint>;
  /** Invalidates this handle for later mutations; performs no I/O or deletion. */
  close(): void;
}

interface PinnedDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnerPins {
  readonly root: PinnedDirectory;
  readonly namespace: PinnedDirectory;
  readonly owner: PinnedDirectory;
  readonly primaryPath: string;
  readonly relativePrimaryPath: string;
}

interface ParsedReserveTransition {
  readonly action: "reserve";
  readonly admissionId: string;
  readonly sourceAssociationSha256: string;
  readonly admittedAt: number;
  readonly deadlineAt: number;
  readonly allocatedUsd: number;
  readonly reserveRevision?: number;
}

interface ParsedBindPreparedTransition {
  readonly action: "bindPrepared";
  readonly admissionId: string;
  readonly prepared: NativeHarnessAccountingPrepared;
}

interface ParsedBindRunTransition {
  readonly action: "bindRun";
  readonly admissionId: string;
  readonly runId: string;
}

interface ParsedSettleTransition {
  readonly action: "settle";
  readonly admissionId: string;
  readonly mode: NativeHarnessAccountingSettlementMode;
  readonly observedUsd: number | null;
  readonly concurrencyHeld: boolean;
}

interface ParsedBlockBudgetTransition {
  readonly action: "blockBudget";
  readonly admissionId: string;
}

type ParsedTransition =
  | ParsedReserveTransition
  | ParsedBindPreparedTransition
  | ParsedBindRunTransition
  | ParsedSettleTransition
  | ParsedBlockBudgetTransition;

function fail(code: NativeHarnessAccountingErrorCode, message: string): never {
  throw new NativeHarnessAccountingError(message, code);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function plainRecord(value: unknown, label: string, code: NativeHarnessAccountingErrorCode = "corrupt"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${label} must be a plain own-data object.`);
  }
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail(code, `${label} must be a plain own-data object.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain own-data object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(code, `${label} must contain only own data properties.`);
    }
  }
  return record;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): void {
  if (!hasExactKeys(record, keys)) fail(code, `${label} has unexpected or missing fields.`);
}

function requireAllowedKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  code: NativeHarnessAccountingErrorCode = "invalid-input",
): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail(code, `${label} has an unsupported field.`);
  }
}

function readArray(value: unknown, label: string, code: NativeHarnessAccountingErrorCode = "corrupt"): readonly unknown[] {
  if (!Array.isArray(value)) fail(code, `${label} must be an array.`);
  return value;
}

function readSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(code, `${label} must be a safe integer at least ${minimum}.`);
  }
  return value as number;
}

function readSafeRangeNumber(
  value: unknown,
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    fail(code, `${label} must be a finite safe-range number.`);
  }
  return value;
}

function readNonNegativeUsd(
  value: unknown,
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): number {
  const number = readSafeRangeNumber(value, label, code);
  if (number < 0) fail(code, `${label} must be nonnegative.`);
  return number;
}

function readFiniteNumber(
  value: unknown,
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(code, `${label} must be a finite number.`);
  }
  return value;
}

function readSha256(
  value: unknown,
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} must be 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function readUuid(
  value: unknown,
  label: string,
  code: NativeHarnessAccountingErrorCode = "corrupt",
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(code, `${label} must be a canonical lowercase UUID.`);
  }
  return value;
}

function readStorageRoot(value: unknown): string {
  if (typeof value !== "string"
    || value.length < 2
    || value.length > 4096
    || CONTROL_PATTERN.test(value)
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || value === path.parse(value).root) {
    fail("invalid-input", "storageRoot must be a canonical absolute non-root path.");
  }
  return value;
}

function readRelativePath(value: unknown, label: string): string {
  try {
    return validateRelativePath(value);
  } catch (error) {
    const detail = error instanceof NativeFileError ? error.message : "unsafe path";
    fail("corrupt", `${label} is not a valid native relative path: ${detail}`);
  }
}

function readLimits(value: unknown): NativeHarnessDelegationLimits {
  const record = plainRecord(value, "limits");
  requireExactKeys(record, LIMIT_KEYS, "limits");
  const maxRetainedOperations = readSafeInteger(record.maxRetainedOperations, "limits.maxRetainedOperations", 1);
  if (maxRetainedOperations > MAX_RETENTION) {
    fail("corrupt", `limits.maxRetainedOperations must not exceed ${MAX_RETENTION}.`);
  }
  const maxConcurrent = readSafeInteger(record.maxConcurrent, "limits.maxConcurrent", 1);
  if (maxConcurrent !== 1) fail("corrupt", "limits.maxConcurrent must be exactly 1.");
  const perRunUsd = readFiniteNumber(record.perRunUsd, "limits.perRunUsd");
  if (!(perRunUsd > 0) || perRunUsd > 1) fail("corrupt", "limits.perRunUsd must be in (0, 1].");
  const lifetimeUsd = readFiniteNumber(record.lifetimeUsd, "limits.lifetimeUsd");
  if (lifetimeUsd < perRunUsd || lifetimeUsd > 5) {
    fail("corrupt", "limits.lifetimeUsd must be at least perRunUsd and at most 5.");
  }
  const maxDurationMs = readFiniteNumber(record.maxDurationMs, "limits.maxDurationMs");
  if (!(maxDurationMs > 0) || maxDurationMs > 300_000) {
    fail("corrupt", "limits.maxDurationMs must be in (0, 300000].");
  }
  const cleanupGraceMs = readFiniteNumber(record.cleanupGraceMs, "limits.cleanupGraceMs");
  if (!(cleanupGraceMs > 0) || cleanupGraceMs > 30_000) {
    fail("corrupt", "limits.cleanupGraceMs must be in (0, 30000].");
  }
  return Object.freeze({
    maxRetainedOperations,
    maxConcurrent,
    perRunUsd,
    lifetimeUsd,
    maxDurationMs,
    cleanupGraceMs,
  });
}

function readPrepared(value: unknown, label: string): NativeHarnessAccountingPrepared {
  const record = plainRecord(value, label);
  requireExactKeys(record, PREPARED_KEYS, label);
  const preparedRelativeRoot = readRelativePath(record.preparedRelativeRoot, `${label}.preparedRelativeRoot`);
  const storeRelativeRoot = readRelativePath(record.storeRelativeRoot, `${label}.storeRelativeRoot`);
  if (storeRelativeRoot !== `${preparedRelativeRoot}/store`) {
    fail("corrupt", `${label}.storeRelativeRoot must be preparedRelativeRoot + '/store'.`);
  }
  return Object.freeze({
    preparedRelativeRoot,
    storeRelativeRoot,
    inputManifestSha256: readSha256(record.inputManifestSha256, `${label}.inputManifestSha256`),
    sourceDescriptorSha256: readSha256(record.sourceDescriptorSha256, `${label}.sourceDescriptorSha256`),
  });
}

function readSettlementMode(value: unknown, label: string): NativeHarnessAccountingSettlementMode {
  if (value !== "no-dispatch" && value !== "known" && value !== "unknown") {
    fail("corrupt", `${label}.mode must be no-dispatch, known or unknown.`);
  }
  return value;
}

function readSettlement(
  value: unknown,
  label: string,
  row: { readonly runId: string | null; readonly reserveRevision: number },
  checkpointRevision: number,
): NativeHarnessAccountingSettlement {
  const record = plainRecord(value, label);
  requireExactKeys(record, SETTLEMENT_KEYS, label);
  const revision = readSafeInteger(record.revision, `${label}.revision`, 1);
  if (revision <= row.reserveRevision || revision > checkpointRevision) {
    fail("corrupt", `${label}.revision must be after the reservation and within the checkpoint.`);
  }
  const mode = readSettlementMode(record.mode, label);
  const observedUsd = record.observedUsd === null
    ? null
    : readNonNegativeUsd(record.observedUsd, `${label}.observedUsd`);
  if (typeof record.concurrencyHeld !== "boolean") {
    fail("corrupt", `${label}.concurrencyHeld must be a boolean.`);
  }
  const concurrencyHeld = record.concurrencyHeld;
  if (mode === "no-dispatch"
    && (observedUsd !== 0 || concurrencyHeld !== false || row.runId !== null)) {
    fail("corrupt", `${label} no-dispatch requires observedUsd 0, held false and no runId.`);
  }
  if (mode === "known"
    && (row.runId === null || typeof observedUsd !== "number" || concurrencyHeld !== false)) {
    fail("corrupt", `${label} known requires a runId, numeric observedUsd and held false.`);
  }
  return Object.freeze({ revision, mode, observedUsd, concurrencyHeld });
}

function readBudgetBlock(value: unknown, checkpointRevision: number): NativeHarnessAccountingBudgetBlock {
  const record = plainRecord(value, "budgetBlock");
  requireExactKeys(record, BUDGET_BLOCK_KEYS, "budgetBlock");
  const admissionId = readUuid(record.admissionId, "budgetBlock.admissionId");
  const revision = readSafeInteger(record.revision, "budgetBlock.revision", 1);
  if (revision > checkpointRevision) {
    fail("corrupt", "budgetBlock.revision must be within the checkpoint.");
  }
  if (record.reason !== "observed-worker-overspend") {
    fail("corrupt", "budgetBlock.reason must be observed-worker-overspend.");
  }
  return Object.freeze({ admissionId, revision, reason: "observed-worker-overspend" as const });
}

function readCheckpoint(value: unknown): NativeHarnessAccountingCheckpoint {
  const record = plainRecord(value, "accounting checkpoint");
  requireExactKeys(record, CHECKPOINT_KEYS, "accounting checkpoint");
  if (record.schema !== NATIVE_HARNESS_ACCOUNTING_SCHEMA) {
    fail("corrupt", "accounting checkpoint schema is not v1.");
  }
  const revision = readSafeInteger(record.revision, "revision", 0);
  const ownerId = readUuid(record.ownerId, "ownerId");
  const selectorSha256 = readSha256(record.selectorSha256, "selectorSha256");
  const createdAt = readSafeInteger(record.createdAt, "createdAt", 1);
  const limits = readLimits(record.limits);
  const rawAdmissions = readArray(record.admissions, "admissions");
  const maxRows = Math.min(MAX_RETENTION, limits.maxRetainedOperations);
  if (rawAdmissions.length > maxRows) {
    fail("corrupt", `admissions must not exceed ${maxRows} rows.`);
  }

  const admissions: NativeHarnessAccountingAdmission[] = [];
  const admissionIds = new Set<string>();
  const runIds = new Set<string>();
  const revisions = new Set<number>();
  let previousReserveRevision = 0;

  for (let index = 0; index < rawAdmissions.length; index += 1) {
    const label = `admissions[${index}]`;
    const row = plainRecord(rawAdmissions[index], label);
    requireExactKeys(row, ADMISSION_KEYS, label);
    const admissionId = readUuid(row.admissionId, `${label}.admissionId`);
    if (admissionIds.has(admissionId)) fail("corrupt", `${label}.admissionId is not unique.`);
    admissionIds.add(admissionId);
    const sourceAssociationSha256 = readSha256(
      row.sourceAssociationSha256,
      `${label}.sourceAssociationSha256`,
    );
    const admittedAt = readSafeInteger(row.admittedAt, `${label}.admittedAt`, 1);
    const deadlineAt = readSafeRangeNumber(row.deadlineAt, `${label}.deadlineAt`);
    if (!(deadlineAt > admittedAt) || deadlineAt !== admittedAt + limits.maxDurationMs) {
      fail("corrupt", `${label}.deadlineAt must be admittedAt + limits.maxDurationMs and later.`);
    }
    const allocatedUsd = readSafeRangeNumber(row.allocatedUsd, `${label}.allocatedUsd`);
    if (allocatedUsd !== limits.perRunUsd) {
      fail("corrupt", `${label}.allocatedUsd must equal limits.perRunUsd.`);
    }
    const reserveRevision = readSafeInteger(row.reserveRevision, `${label}.reserveRevision`, 1);
    if (reserveRevision > revision || reserveRevision <= previousReserveRevision) {
      fail("corrupt", `${label}.reserveRevision must increase with row creation and stay within the checkpoint.`);
    }
    previousReserveRevision = reserveRevision;
    const prepared = row.prepared === null ? null : readPrepared(row.prepared, `${label}.prepared`);
    const runId = row.runId === null ? null : readUuid(row.runId, `${label}.runId`);
    if (runId !== null) {
      if (prepared === null) fail("corrupt", `${label}.runId requires prepared metadata.`);
      if (runIds.has(runId)) fail("corrupt", `${label}.runId is not unique for this owner.`);
      runIds.add(runId);
    }
    const settlement = row.settlement === null
      ? null
      : readSettlement(row.settlement, `${label}.settlement`, { runId, reserveRevision }, revision);
    if (revisions.has(reserveRevision)) fail("corrupt", `${label}.reserveRevision collides with another revision.`);
    revisions.add(reserveRevision);
    if (settlement !== null) {
      if (revisions.has(settlement.revision)) {
        fail("corrupt", `${label}.settlement.revision collides with another revision.`);
      }
      revisions.add(settlement.revision);
    }
    admissions.push(Object.freeze({
      admissionId,
      sourceAssociationSha256,
      admittedAt,
      deadlineAt,
      allocatedUsd,
      reserveRevision,
      prepared,
      runId,
      settlement,
    }));
  }

  const budgetBlock = record.budgetBlock === null
    ? null
    : readBudgetBlock(record.budgetBlock, revision);
  if (budgetBlock !== null) {
    if (revisions.has(budgetBlock.revision)) {
      fail("corrupt", "budgetBlock.revision collides with a reservation or settlement.");
    }
    revisions.add(budgetBlock.revision);
    const row = admissions.find((candidate) => candidate.admissionId === budgetBlock.admissionId);
    if (row === undefined) fail("corrupt", "budgetBlock must reference an existing admission.");
    if (budgetBlock.revision <= row.reserveRevision) {
      fail("corrupt", "budgetBlock must follow the referenced reservation.");
    }
    if (row.settlement !== null && budgetBlock.revision >= row.settlement.revision) {
      fail("corrupt", "budgetBlock must precede the referenced settlement.");
    }
  }

  const actionCount = admissions.length
    + admissions.filter((row) => row.prepared !== null).length
    + admissions.filter((row) => row.runId !== null).length
    + admissions.filter((row) => row.settlement !== null).length
    + (budgetBlock === null ? 0 : 1);
  if (revision !== actionCount) {
    fail("corrupt", "accounting revision must equal the fixed owned action count.");
  }
  if (admissions.length === 0) {
    if (revision !== 0 || budgetBlock !== null) {
      fail("corrupt", "An empty accounting checkpoint must be revision 0 with no budget block.");
    }
  } else if (admissions[0]!.reserveRevision !== 1) {
    fail("corrupt", "The first reservation must use revision 1.");
  }

  const points = admissions.length
    + admissions.filter((row) => row.settlement !== null).length
    + (budgetBlock === null ? 0 : 1);
  if (points > MAX_POINTS) fail("corrupt", `accounting history must not exceed ${MAX_POINTS} timeline points.`);

  return deepFreeze({
    schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA,
    revision,
    ownerId,
    selectorSha256,
    createdAt,
    limits,
    budgetBlock,
    admissions: Object.freeze(admissions),
  });
}

function money(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function projectCheckpoint(checkpoint: NativeHarnessAccountingCheckpoint): NativeHarnessAccountingProjection {
  type Point =
    | { readonly kind: "reserve"; readonly revision: number; readonly row: NativeHarnessAccountingAdmission }
    | {
      readonly kind: "settle";
      readonly revision: number;
      readonly row: NativeHarnessAccountingAdmission;
      readonly settlement: NativeHarnessAccountingSettlement;
    }
    | {
      readonly kind: "block";
      readonly revision: number;
      readonly block: NativeHarnessAccountingBudgetBlock;
    };

  const points: Point[] = [];
  const byId = new Map<string, NativeHarnessAccountingAdmission>();
  for (const row of checkpoint.admissions) {
    byId.set(row.admissionId, row);
    points.push({ kind: "reserve", revision: row.reserveRevision, row });
    if (row.settlement !== null) {
      points.push({ kind: "settle", revision: row.settlement.revision, row, settlement: row.settlement });
    }
  }
  if (checkpoint.budgetBlock !== null) {
    points.push({ kind: "block", revision: checkpoint.budgetBlock.revision, block: checkpoint.budgetBlock });
  }
  if (points.length > MAX_POINTS) fail("corrupt", `accounting history must not exceed ${MAX_POINTS} timeline points.`);
  points.sort((left, right) => left.revision - right.revision);

  let accountedUsd = 0;
  let observedUsd = 0;
  let unknownUsd = 0;
  let overspendUsd = 0;
  let activeOperations = 0;
  let retainedOperations = 0;
  let budgetBlocked = false;
  const reserved = new Set<string>();
  const settled = new Set<string>();

  for (const point of points) {
    if (point.kind === "reserve") {
      const row = point.row;
      if (reserved.has(row.admissionId) || settled.has(row.admissionId)) {
        fail("corrupt", "A reservation point is repeated or follows settlement.");
      }
      if (retainedOperations >= checkpoint.limits.maxRetainedOperations) {
        fail("corrupt", "A historical reservation exceeds maxRetainedOperations.");
      }
      if (activeOperations >= checkpoint.limits.maxConcurrent) {
        fail("corrupt", "A historical reservation exceeds maxConcurrent.");
      }
      if (budgetBlocked) fail("corrupt", "A historical reservation follows a sticky budget block.");
      if (accountedUsd + row.allocatedUsd > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
        fail("corrupt", "A historical reservation exceeds the lifetime budget at its own prefix.");
      }
      accountedUsd += row.allocatedUsd;
      activeOperations += 1;
      retainedOperations += 1;
      reserved.add(row.admissionId);
      continue;
    }

    if (point.kind === "block") {
      const row = byId.get(point.block.admissionId);
      if (row === undefined || !reserved.has(row.admissionId)) {
        fail("corrupt", "budgetBlock precedes its referenced reservation.");
      }
      if (settled.has(row.admissionId)
        || (row.settlement !== null && row.settlement.revision <= point.revision)) {
        fail("corrupt", "budgetBlock does not precede the referenced settlement.");
      }
      budgetBlocked = true;
      continue;
    }

    const row = point.row;
    if (!reserved.has(row.admissionId) || settled.has(row.admissionId)) {
      fail("corrupt", "A settlement point is not paired with exactly one earlier reservation.");
    }
    settled.add(row.admissionId);
    const allocation = row.allocatedUsd;
    const observed = point.settlement.observedUsd ?? 0;
    if (point.settlement.mode === "no-dispatch") {
      accountedUsd = money(Math.max(0, accountedUsd - allocation));
      activeOperations -= 1;
    } else if (point.settlement.mode === "known") {
      accountedUsd = money(accountedUsd + observed - allocation);
      if (accountedUsd < 0) accountedUsd = 0;
      observedUsd = money(observedUsd + observed);
      const extra = Math.max(0, observed - allocation);
      if (extra > 0) {
        overspendUsd = money(overspendUsd + extra);
        budgetBlocked = true;
      }
      activeOperations -= 1;
    } else {
      const extra = Math.max(0, observed - allocation);
      accountedUsd = money(accountedUsd + extra);
      observedUsd = money(observedUsd + observed);
      unknownUsd = money(unknownUsd + allocation);
      if (extra > 0) {
        overspendUsd = money(overspendUsd + extra);
        budgetBlocked = true;
      }
      if (!point.settlement.concurrencyHeld) activeOperations -= 1;
    }
    if (activeOperations < 0) fail("corrupt", "Settlement released concurrency that was not held.");
  }

  if (retainedOperations !== checkpoint.admissions.length) {
    fail("corrupt", "Retained operation count does not match the admission rows.");
  }
  if (![accountedUsd, observedUsd, unknownUsd, overspendUsd].every(Number.isFinite)) {
    fail("corrupt", "Accounting totals are not finite.");
  }
  return deepFreeze({
    accountedUsd,
    observedUsd,
    unknownUsd,
    overspendUsd,
    activeOperations,
    retainedOperations,
    budgetBlocked,
  });
}

function decodeCheckpointText(
  raw: unknown,
  expected: { readonly ownerId?: string; readonly selectorSha256: string },
): NativeHarnessAccountingCheckpoint {
  if (typeof raw !== "string") fail("corrupt", "Accounting checkpoint text must be a string.");
  if (Buffer.byteLength(raw, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail("too-large", `Accounting checkpoint text exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("corrupt", "Accounting checkpoint text is not valid JSON. No fallback was applied.");
  }
  const checkpoint = readCheckpoint(value);
  if (checkpoint.selectorSha256 !== expected.selectorSha256
    || (expected.ownerId !== undefined && checkpoint.ownerId !== expected.ownerId)) {
    fail("identity-mismatch", "Accounting checkpoint identity does not match the expected owner/selector.");
  }
  projectCheckpoint(checkpoint);
  return checkpoint;
}

/**
 * Pure bounded decoder for one already-read primary text. Size is checked in
 * UTF-8 wire bytes before JSON.parse; unknown fields, duplicate semantic
 * points, impossible historical prefixes and cross-field inconsistencies are
 * refused. No BOM stripping, defaulting, backup read or repair occurs.
 */
export function decodeNativeHarnessAccountingText(
  raw: string,
  expectedIdentity: NativeHarnessAccountingIdentity,
): NativeHarnessAccountingCheckpoint {
  if (typeof raw !== "string") fail("corrupt", "Accounting checkpoint text must be a string.");
  const identityRecord = plainRecord(expectedIdentity, "expectedIdentity", "invalid-input");
  requireExactKeys(identityRecord, ["ownerId", "selectorSha256"], "expectedIdentity", "invalid-input");
  const ownerId = readUuid(identityRecord.ownerId, "expectedIdentity.ownerId", "invalid-input");
  const selectorSha256 = readSha256(
    identityRecord.selectorSha256,
    "expectedIdentity.selectorSha256",
    "invalid-input",
  );
  return decodeCheckpointText(raw, { ownerId, selectorSha256 });
}

/** Pure bounded projection. Revalidates the complete known shape and timeline. */
export function projectNativeHarnessAccounting(checkpoint: unknown): NativeHarnessAccountingProjection {
  return projectCheckpoint(readCheckpoint(checkpoint));
}

function parseLimitsText(text: unknown): NativeHarnessDelegationLimits {
  if (typeof text !== "string") fail("invalid-input", "limitsText must be JSON text.");
  if (Buffer.byteLength(text, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail("invalid-input", `limitsText exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("invalid-input", "limitsText is not valid JSON.");
  }
  try {
    return readLimits(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid limits";
    fail("invalid-input", `limitsText is invalid: ${detail}`);
  }
}

function parseReserveTransition(value: Record<string, unknown>): ParsedReserveTransition {
  const baseKeys = [
    "schema",
    "action",
    "admissionId",
    "sourceAssociationSha256",
    "admittedAt",
    "deadlineAt",
    "allocatedUsd",
  ] as const;
  const withRevision = [...baseKeys, "reserveRevision"];
  if (!hasExactKeys(value, baseKeys) && !hasExactKeys(value, withRevision)) {
    fail("invalid-transition", "reserve transition has unexpected or missing fields.");
  }
  const reserveRevision = value.reserveRevision === undefined
    ? undefined
    : readSafeInteger(value.reserveRevision, "reserve.reserveRevision", 1, "invalid-transition");
  return {
    action: "reserve",
    admissionId: readUuid(value.admissionId, "reserve.admissionId", "invalid-transition"),
    sourceAssociationSha256: readSha256(
      value.sourceAssociationSha256,
      "reserve.sourceAssociationSha256",
      "invalid-transition",
    ),
    admittedAt: readSafeInteger(value.admittedAt, "reserve.admittedAt", 1, "invalid-transition"),
    deadlineAt: readSafeRangeNumber(value.deadlineAt, "reserve.deadlineAt", "invalid-transition"),
    allocatedUsd: readSafeRangeNumber(value.allocatedUsd, "reserve.allocatedUsd", "invalid-transition"),
    ...(reserveRevision === undefined ? {} : { reserveRevision }),
  };
}

function parseSettleTransition(value: Record<string, unknown>): ParsedSettleTransition {
  const baseKeys = ["schema", "action", "admissionId", "mode", "observedUsd"] as const;
  const heldKeys = [...baseKeys, "held"];
  const concurrencyHeldKeys = [...baseKeys, "concurrencyHeld"];
  if (!hasExactKeys(value, heldKeys) && !hasExactKeys(value, concurrencyHeldKeys)) {
    fail("invalid-transition", "settle transition has unexpected or missing fields.");
  }
  const mode = readSettlementMode(value.mode, "settle");
  if (mode === "known" && (typeof value.observedUsd !== "number" || value.observedUsd === null)) {
    fail("invalid-transition", "settle known requires numeric observedUsd.");
  }
  const observedUsd = value.observedUsd === null
    ? null
    : readNonNegativeUsd(value.observedUsd, "settle.observedUsd", "invalid-transition");
  const heldValue = value.held === undefined ? value.concurrencyHeld : value.held;
  if (typeof heldValue !== "boolean") fail("invalid-transition", "settle held must be a boolean.");
  return {
    action: "settle",
    admissionId: readUuid(value.admissionId, "settle.admissionId", "invalid-transition"),
    mode,
    observedUsd,
    concurrencyHeld: heldValue,
  };
}

function parseTransitionText(text: unknown): ParsedTransition {
  if (typeof text !== "string") fail("invalid-transition", "Transition must be JSON text.");
  if (Buffer.byteLength(text, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail("too-large", `Transition text exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("invalid-transition", "Transition text is not valid JSON.");
  }
  const record = plainRecord(value, "transition", "invalid-transition");
  if (record.schema !== NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA) {
    fail("invalid-transition", "Transition schema is not v1.");
  }
  if (record.action === "reserve") return parseReserveTransition(record);
  if (record.action === "bindPrepared") {
    requireExactKeys(record, ["schema", "action", "admissionId", "prepared"], "bindPrepared transition", "invalid-transition");
    return {
      action: "bindPrepared",
      admissionId: readUuid(record.admissionId, "bindPrepared.admissionId", "invalid-transition"),
      prepared: readPrepared(record.prepared, "bindPrepared.prepared"),
    };
  }
  if (record.action === "bindRun") {
    requireExactKeys(record, ["schema", "action", "admissionId", "runId"], "bindRun transition", "invalid-transition");
    return {
      action: "bindRun",
      admissionId: readUuid(record.admissionId, "bindRun.admissionId", "invalid-transition"),
      runId: readUuid(record.runId, "bindRun.runId", "invalid-transition"),
    };
  }
  if (record.action === "settle") return parseSettleTransition(record);
  if (record.action === "blockBudget") {
    requireExactKeys(record, ["schema", "action", "admissionId"], "blockBudget transition", "invalid-transition");
    return {
      action: "blockBudget",
      admissionId: readUuid(record.admissionId, "blockBudget.admissionId", "invalid-transition"),
    };
  }
  fail("invalid-transition", "Transition action is not supported.");
}

function copyAdmission(row: NativeHarnessAccountingAdmission): Record<string, unknown> {
  return {
    admissionId: row.admissionId,
    sourceAssociationSha256: row.sourceAssociationSha256,
    admittedAt: row.admittedAt,
    deadlineAt: row.deadlineAt,
    allocatedUsd: row.allocatedUsd,
    reserveRevision: row.reserveRevision,
    prepared: row.prepared === null ? null : { ...row.prepared },
    runId: row.runId,
    settlement: row.settlement === null ? null : { ...row.settlement },
  };
}

function applyTransition(
  checkpoint: NativeHarnessAccountingCheckpoint,
  transition: ParsedTransition,
  nextRevision: number,
): Record<string, unknown> {
  const rows = checkpoint.admissions.map(copyAdmission);
  const candidate: Record<string, unknown> = {
    schema: checkpoint.schema,
    revision: nextRevision,
    ownerId: checkpoint.ownerId,
    selectorSha256: checkpoint.selectorSha256,
    createdAt: checkpoint.createdAt,
    limits: { ...checkpoint.limits },
    budgetBlock: checkpoint.budgetBlock === null ? null : { ...checkpoint.budgetBlock },
    admissions: rows,
  };

  if (transition.action === "reserve") {
    const projection = projectCheckpoint(checkpoint);
    if (rows.some((row) => row.admissionId === transition.admissionId)) {
      fail("invalid-transition", "Reserve admissionId already exists.");
    }
    if (transition.deadlineAt !== transition.admittedAt + checkpoint.limits.maxDurationMs
      || !(transition.deadlineAt > transition.admittedAt)) {
      fail("invalid-transition", "Reserve deadlineAt must equal admittedAt + limits.maxDurationMs and be later.");
    }
    if (transition.allocatedUsd !== checkpoint.limits.perRunUsd) {
      fail("invalid-transition", "Reserve allocatedUsd must equal the stored limits.perRunUsd.");
    }
    const reserveRevision = transition.reserveRevision ?? nextRevision;
    if (reserveRevision !== nextRevision) {
      fail("invalid-transition", "Reserve reserveRevision must be the consumed revision.");
    }
    if (projection.retainedOperations >= checkpoint.limits.maxRetainedOperations) {
      fail("invalid-transition", "Reserve would exceed maxRetainedOperations.");
    }
    if (projection.activeOperations >= checkpoint.limits.maxConcurrent) {
      fail("invalid-transition", "Reserve would exceed maxConcurrent.");
    }
    if (projection.budgetBlocked) {
      fail("invalid-transition", "Reserve follows a sticky budget block.");
    }
    if (projection.accountedUsd + checkpoint.limits.perRunUsd
      > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
      fail("invalid-transition", "Reserve would exceed the lifetime accounting budget.");
    }
    rows.push({
      admissionId: transition.admissionId,
      sourceAssociationSha256: transition.sourceAssociationSha256,
      admittedAt: transition.admittedAt,
      deadlineAt: transition.deadlineAt,
      allocatedUsd: transition.allocatedUsd,
      reserveRevision,
      prepared: null,
      runId: null,
      settlement: null,
    });
    return candidate;
  }

  const index = rows.findIndex((row) => row.admissionId === transition.admissionId);
  if (index < 0) fail("invalid-transition", "Transition references an unknown admission.");
  const row = rows[index]!;

  if (transition.action === "bindPrepared") {
    if (row.settlement !== null) fail("invalid-transition", "Cannot bind prepared metadata after settlement.");
    if (row.prepared !== null) fail("invalid-transition", "Prepared metadata is already bound.");
    rows[index] = { ...row, prepared: { ...transition.prepared } };
    return candidate;
  }

  if (transition.action === "bindRun") {
    if (row.settlement !== null) fail("invalid-transition", "Cannot bind runId after settlement.");
    if (row.prepared === null) fail("invalid-transition", "runId requires already-bound prepared metadata.");
    if (row.runId !== null) fail("invalid-transition", "runId is already bound.");
    if (rows.some((other, otherIndex) => otherIndex !== index && other.runId === transition.runId)) {
      fail("invalid-transition", "runId must be unique for this owner.");
    }
    rows[index] = { ...row, runId: transition.runId };
    return candidate;
  }

  if (transition.action === "blockBudget") {
    if (checkpoint.budgetBlock !== null) {
      fail("invalid-transition", "A sticky budget block already exists.");
    }
    if (row.settlement !== null) {
      fail("invalid-transition", "blockBudget requires an unsettled admission.");
    }
    candidate.budgetBlock = {
      admissionId: transition.admissionId,
      revision: nextRevision,
      reason: "observed-worker-overspend",
    };
    return candidate;
  }

  if (row.settlement !== null) fail("invalid-transition", "Admission is already settled.");
  if (transition.mode === "no-dispatch") {
    if (row.runId !== null || transition.observedUsd !== 0 || transition.concurrencyHeld !== false) {
      fail("invalid-transition", "no-dispatch requires observedUsd 0, held false and no runId.");
    }
  } else if (transition.mode === "known") {
    if (row.runId === null || typeof transition.observedUsd !== "number"
      || transition.concurrencyHeld !== false) {
      fail("invalid-transition", "known settlement requires a runId, numeric observedUsd and held false.");
    }
  }
  rows[index] = {
    ...row,
    settlement: {
      revision: nextRevision,
      mode: transition.mode,
      observedUsd: transition.observedUsd,
      concurrencyHeld: transition.concurrencyHeld,
    },
  };
  return candidate;
}

function encodeCheckpoint(checkpoint: NativeHarnessAccountingCheckpoint): string {
  return `${JSON.stringify(checkpoint, null, 2)}\n`;
}

function assertEncodedSize(encoded: string): void {
  if (Buffer.byteLength(encoded, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail("too-large", `Serialized accounting checkpoint exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
  }
}

async function pinExistingDirectory(io: NativeFileIo, directory: string): Promise<PinnedDirectory> {
  let resolved: string;
  try {
    resolved = await io.realpath(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) fail("unavailable", `Directory is missing: ${directory}`);
    fail("changed", `Directory could not be resolved: ${directory}`);
  }
  if (resolved !== directory) fail("unsafe-path", `Directory is an alias or symlink: ${directory}`);
  let info: NativeFileStats;
  try {
    info = await io.lstat(directory, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) fail("unavailable", `Directory is missing: ${directory}`);
    fail("changed", `Directory could not be inspected: ${directory}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail("unsafe-path", `Path is not a regular directory: ${directory}`);
  }
  return Object.freeze({ path: directory, dev: info.dev, ino: info.ino });
}

async function verifyPins(io: NativeFileIo, pins: readonly PinnedDirectory[]): Promise<void> {
  for (const pin of pins) {
    let current: PinnedDirectory;
    try {
      current = await pinExistingDirectory(io, pin.path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "directory unavailable";
      fail("changed", `Pinned directory changed before this operation: ${detail}`);
    }
    if (current.dev !== pin.dev || current.ino !== pin.ino) {
      fail("changed", "Pinned directory identity changed before this operation.");
    }
  }
}

function withBoundedPinnedIo(io: NativeFileIo, pins: readonly PinnedDirectory[]): NativeFileIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  const byPath = new Map(pins.map((pin) => [path.normalize(pin.path), pin]));
  const changed = (): never => fail("changed", "A pinned directory identity changed during the read.");
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: async (target) => {
      const resolved = await io.realpath(target);
      const pin = byPath.get(path.normalize(target));
      if (pin !== undefined && resolved !== pin.path) changed();
      return resolved;
    },
    lstat: async (target, options) => {
      const info = await io.lstat(target, options);
      const pin = byPath.get(path.normalize(target));
      if (pin !== undefined) {
        if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== pin.dev || info.ino !== pin.ino) {
          changed();
        }
      }
      if (info.isFile() && info.size > MAX_BYTES_BIGINT) {
        fail("too-large", `Accounting primary exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
      }
      return info;
    },
    open: async (target, flags): Promise<NativeFileHandle> => {
      const handle = await io.open(target, flags | nonBlocking);
      return {
        stat: async (options) => {
          const info = await handle.stat(options);
          if (info.isFile() && info.size > MAX_BYTES_BIGINT) {
            fail("too-large", `Accounting primary exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
          }
          return info;
        },
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
}

function mapNativeFileError(error: NativeFileError): NativeHarnessAccountingError {
  const code: NativeHarnessAccountingErrorCode =
    error.code === "missing" ? "unavailable"
      : error.code === "too-large" ? "too-large"
        : error.code === "unsafe-path" ? "unsafe-path"
          : error.code === "non-text" ? "corrupt"
            : error.code === "changed" ? "changed"
              : "invalid-input";
  return new NativeHarnessAccountingError(error.message, code);
}

async function readPrimary(io: NativeFileIo, pins: OwnerPins): Promise<string> {
  const boundedIo = withBoundedPinnedIo(io, [pins.root, pins.namespace, pins.owner]);
  let snapshot;
  try {
    snapshot = await captureWorkspaceText(pins.root.path, pins.relativePrimaryPath, boundedIo);
  } catch (error) {
    if (error instanceof NativeHarnessAccountingError) throw error;
    if (error instanceof NativeFileError) throw mapNativeFileError(error);
    throw error;
  }
  if (snapshot.file.bytes > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES
    || Buffer.byteLength(snapshot.text, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail("too-large", `Accounting primary exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`);
  }
  return snapshot.text;
}

function readTestOptions(value: unknown): {
  readonly io: NativeFileIo;
  readonly hook: NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"];
} {
  if (value === undefined) return { io: nodeFileIo, hook: undefined };
  const record = plainRecord(value, "testOptions", "invalid-input");
  requireAllowedKeys(record, ["fileIo", "testAfterPrimaryWrite"], "testOptions");
  const io = record.fileIo === undefined ? nodeFileIo : record.fileIo as NativeFileIo;
  const hook = record.testAfterPrimaryWrite;
  if (hook !== undefined && typeof hook !== "function") {
    fail("invalid-input", "testAfterPrimaryWrite must be a function.");
  }
  return { io, hook: hook as NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"] };
}

function readCreateOptions(value: unknown): NativeHarnessAccountingCreateOptions {
  const record = plainRecord(value, "create options", "invalid-input");
  requireExactKeys(record, ["storageRoot", "selectorSha256", "ownerId", "createdAt", "limitsText"], "create options", "invalid-input");
  return {
    storageRoot: readStorageRoot(record.storageRoot),
    selectorSha256: readSha256(record.selectorSha256, "selectorSha256", "invalid-input"),
    ownerId: readUuid(record.ownerId, "ownerId", "invalid-input"),
    createdAt: readSafeInteger(record.createdAt, "createdAt", 1, "invalid-input"),
    limitsText: (() => {
      if (typeof record.limitsText !== "string") fail("invalid-input", "limitsText must be JSON text.");
      return record.limitsText;
    })(),
  };
}

function readOpenOptions(value: unknown): NativeHarnessAccountingOpenOptions {
  const record = plainRecord(value, "open options", "invalid-input");
  requireExactKeys(record, ["storageRoot", "selectorSha256", "ownerId"], "open options", "invalid-input");
  return {
    storageRoot: readStorageRoot(record.storageRoot),
    selectorSha256: readSha256(record.selectorSha256, "selectorSha256", "invalid-input"),
    ownerId: readUuid(record.ownerId, "ownerId", "invalid-input"),
  };
}

function readObserveOptions(value: unknown): NativeHarnessAccountingObserveOptions {
  const record = plainRecord(value, "observe options", "invalid-input");
  requireExactKeys(record, ["storageRoot", "selectorSha256"], "observe options", "invalid-input");
  return {
    storageRoot: readStorageRoot(record.storageRoot),
    selectorSha256: readSha256(record.selectorSha256, "selectorSha256", "invalid-input"),
  };
}

function ownerPaths(storageRoot: string, selectorSha256: string): {
  readonly namespacePath: string;
  readonly ownerPath: string;
  readonly primaryPath: string;
  readonly relativePrimaryPath: string;
} {
  const namespacePath = path.join(storageRoot, "accounting-owners");
  const ownerPath = path.join(namespacePath, selectorSha256);
  const relativePrimaryPath = `accounting-owners/${selectorSha256}/owner.json`;
  return {
    namespacePath,
    ownerPath,
    primaryPath: path.join(ownerPath, "owner.json"),
    relativePrimaryPath,
  };
}

async function pinExistingOwner(
  io: NativeFileIo,
  storageRoot: string,
  selectorSha256: string,
): Promise<OwnerPins> {
  const paths = ownerPaths(storageRoot, selectorSha256);
  const root = await pinExistingDirectory(io, storageRoot);
  const namespace = await pinExistingDirectory(io, paths.namespacePath);
  const owner = await pinExistingDirectory(io, paths.ownerPath);
  const pins: OwnerPins = {
    root,
    namespace,
    owner,
    primaryPath: paths.primaryPath,
    relativePrimaryPath: paths.relativePrimaryPath,
  };
  await verifyPins(io, [root, namespace, owner]);
  return pins;
}

function makeHandle(
  initial: NativeHarnessAccountingCheckpoint,
  pins: OwnerPins,
  io: NativeFileIo,
  hook: NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"],
): NativeHarnessAccountingHandle {
  let checkpoint = initial;
  let closed = false;
  let poisoned = false;

  const commit = async (
    expectedRevision: number,
    transitionText: string,
  ): Promise<NativeHarnessAccountingCheckpoint> => {
    if (closed) fail("closed", "Accounting handle is closed.");
    if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("invalid-input", "expectedRevision must be a nonnegative safe integer.");
    }
    if (expectedRevision !== checkpoint.revision) {
      fail("conflict", "Accounting handle revision is stale.");
    }
    const transition = parseTransitionText(transitionText);
    await verifyPins(io, [pins.root, pins.namespace, pins.owner]);

    let writeAttempted = false;
    try {
      return await withWriteLock(pins.owner.path, async () => {
        if (closed) fail("closed", "Accounting handle is closed.");
        if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
        await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        const raw = await readPrimary(io, pins);
        const disk = decodeNativeHarnessAccountingText(raw, {
          ownerId: checkpoint.ownerId,
          selectorSha256: checkpoint.selectorSha256,
        });
        await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        if (disk.revision !== expectedRevision) {
          fail("conflict", "Accounting checkpoint revision changed before commit.");
        }
        if (JSON.stringify(disk) !== JSON.stringify(checkpoint)) {
          fail("changed", "Accounting checkpoint no longer matches the complete handle snapshot at this revision.");
        }
        if (disk.revision >= Number.MAX_SAFE_INTEGER) {
          fail("exhausted", "Accounting checkpoint revision counter is exhausted.");
        }
        const nextRevision = disk.revision + 1;
        const candidate = applyTransition(disk, transition, nextRevision);
        const validated = readCheckpoint(candidate);
        projectCheckpoint(validated);
        const encoded = encodeCheckpoint(validated);
        assertEncodedSize(encoded);
        if (closed) fail("closed", "Accounting handle is closed.");
        await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        if (closed) fail("closed", "Accounting handle is closed.");
        if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
        writeAttempted = true;
        try {
          await atomicWrite(pins.primaryPath, encoded);
        } catch (error) {
          poisoned = true;
          const detail = error instanceof Error ? error.message : "write failed";
          fail("ambiguous", `Accounting primary write is ambiguous; explicit re-observation is required: ${detail}`);
        }
        try {
          if (hook !== undefined) {
            await hook(Object.freeze({ path: pins.primaryPath, revision: nextRevision }));
          }
          await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        } catch (error) {
          poisoned = true;
          const detail = error instanceof Error ? error.message : "after-write verification failed";
          fail("ambiguous", `Accounting primary write acknowledgement is ambiguous; explicit re-observation is required: ${detail}`);
        }
        checkpoint = validated;
        return validated;
      });
    } catch (error) {
      if (!writeAttempted) throw error;
      poisoned = true;
      if (error instanceof NativeHarnessAccountingError && error.code === "ambiguous") throw error;
      const detail = error instanceof Error ? error.message : "lock release failed";
      fail("ambiguous", `Accounting primary write or lock release is ambiguous; explicit re-observation is required: ${detail}`);
    }
  };

  return Object.freeze({
    snapshot: () => checkpoint,
    commit,
    close: () => {
      closed = true;
    },
  });
}

/**
 * Creates a genuinely fresh owner directory and initial revision-0 checkpoint.
 * The supplied limits text is used exactly; no policy defaults or second
 * normalization are applied. EEXIST refuses even for an empty owner directory.
 */
export async function createNativeHarnessAccountingOwner(
  options: NativeHarnessAccountingCreateOptions,
  testOptions?: NativeHarnessAccountingTestOptions,
): Promise<NativeHarnessAccountingHandle> {
  const owned = readCreateOptions(options);
  const test = readTestOptions(testOptions);
  const limits = parseLimitsText(owned.limitsText);
  const paths = ownerPaths(owned.storageRoot, owned.selectorSha256);
  const root = await pinExistingDirectory(test.io, owned.storageRoot);

  try {
    await mkdir(paths.namespacePath, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) fail("unavailable", "Accounting namespace could not be created.");
  }
  const namespace = await pinExistingDirectory(test.io, paths.namespacePath);
  await verifyPins(test.io, [root, namespace]);

  try {
    await mkdir(paths.ownerPath, { mode: 0o700 });
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      fail("conflict", "Accounting owner directory already exists; a fresh directory is required.");
    }
    fail("unavailable", "Accounting owner directory could not be created.");
  }
  const owner = await pinExistingDirectory(test.io, paths.ownerPath);
  await verifyPins(test.io, [root, namespace, owner]);

  const checkpoint = readCheckpoint({
    schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA,
    revision: 0,
    ownerId: owned.ownerId,
    selectorSha256: owned.selectorSha256,
    createdAt: owned.createdAt,
    limits,
    budgetBlock: null,
    admissions: [],
  });
  projectCheckpoint(checkpoint);
  const encoded = encodeCheckpoint(checkpoint);
  assertEncodedSize(encoded);
  const pins: OwnerPins = {
    root,
    namespace,
    owner,
    primaryPath: paths.primaryPath,
    relativePrimaryPath: paths.relativePrimaryPath,
  };

  let writeAttempted = false;
  try {
    await withWriteLock(paths.ownerPath, async () => {
      await verifyPins(test.io, [root, namespace, owner]);
      for (const existingPath of [paths.primaryPath, `${paths.primaryPath}.bak`]) {
        try {
          await test.io.lstat(existingPath, { bigint: true });
          fail("conflict", "Accounting owner directory is not fresh.");
        } catch (error) {
          if (error instanceof NativeHarnessAccountingError) throw error;
          if (!isErrno(error, "ENOENT")) fail("unavailable", "Accounting owner directory could not be inspected.");
        }
      }
      await verifyPins(test.io, [root, namespace, owner]);
      writeAttempted = true;
      try {
        await atomicWrite(paths.primaryPath, encoded);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "write failed";
        fail("ambiguous", `Initial accounting checkpoint write is ambiguous: ${detail}`);
      }
      try {
        if (test.hook !== undefined) {
          await test.hook(Object.freeze({ path: paths.primaryPath, revision: 0 }));
        }
        await verifyPins(test.io, [root, namespace, owner]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "after-write verification failed";
        fail("ambiguous", `Initial accounting checkpoint acknowledgement is ambiguous: ${detail}`);
      }
    });
    await verifyPins(test.io, [root, namespace, owner]);
  } catch (error) {
    if (!writeAttempted) throw error;
    if (error instanceof NativeHarnessAccountingError && error.code === "ambiguous") throw error;
    const detail = error instanceof Error ? error.message : "lock release failed";
    fail("ambiguous", `Initial accounting checkpoint write or lock release is ambiguous: ${detail}`);
  }
  return makeHandle(checkpoint, pins, test.io, test.hook);
}

/**
 * Opens one existing owner primary. It creates or repairs nothing, never reads
 * a .bak, and verifies the pinned root/namespace/owner identities before and
 * after the bounded read.
 */
export async function openNativeHarnessAccountingOwner(
  options: NativeHarnessAccountingOpenOptions,
  testOptions?: NativeHarnessAccountingTestOptions,
): Promise<NativeHarnessAccountingHandle> {
  const owned = readOpenOptions(options);
  const test = readTestOptions(testOptions);
  const pins = await pinExistingOwner(test.io, owned.storageRoot, owned.selectorSha256);
  const raw = await readPrimary(test.io, pins);
  const checkpoint = decodeNativeHarnessAccountingText(raw, {
    ownerId: owned.ownerId,
    selectorSha256: owned.selectorSha256,
  });
  await verifyPins(test.io, [pins.root, pins.namespace, pins.owner]);
  return makeHandle(checkpoint, pins, test.io, test.hook);
}

/**
 * Readonly discovery for a crash between owner creation and durable locator
 * confirmation. It accepts the canonical storage root and selector only,
 * reuses the same pinned bounded reader/codec, and returns the observed owner
 * identity plus its frozen checkpoint. It never mints an ownerId, creates or
 * changes directories, reads a .bak, or returns a handle. A missing, partial,
 * corrupt or selector-mismatched primary refuses.
 */
export async function observeNativeHarnessAccountingOwner(
  options: NativeHarnessAccountingObserveOptions,
): Promise<NativeHarnessAccountingObservation> {
  const owned = readObserveOptions(options);
  const pins = await pinExistingOwner(nodeFileIo, owned.storageRoot, owned.selectorSha256);
  const raw = await readPrimary(nodeFileIo, pins);
  const checkpoint = decodeCheckpointText(raw, { selectorSha256: owned.selectorSha256 });
  await verifyPins(nodeFileIo, [pins.root, pins.namespace, pins.owner]);
  return deepFreeze({
    identity: Object.freeze({
      ownerId: checkpoint.ownerId,
      selectorSha256: checkpoint.selectorSha256,
    }),
    checkpoint,
  });
}
