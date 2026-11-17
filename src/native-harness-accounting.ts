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
export const NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2 = "omp-agent.native-harness-accounting.v2";
export const NATIVE_HARNESS_ACCOUNTING_RECOVERY_TRANSITION_SCHEMA =
  "omp-agent.native-harness-accounting-transition.v2";
export const NATIVE_HARNESS_ACCOUNTING_MAX_BYTES = 65_536;

const MAX_RETENTION = 16;
const MAX_POINTS = 33;
const MAX_RECOVERY_CLAIMS = 8;
const MAX_RECOVERY_FINISHES = 8;
const MAX_RECOVERY_COST_OBSERVATIONS = 64;
const MAX_RECOVERY_EVENTS = 80;
const MAX_RECOVERY_ACTIONS = 16 + 16 + 16 + 16 + 1 + MAX_RECOVERY_EVENTS;
const RECOVERY_EVENT_RESERVE_BYTES = 512;
const RECOVERY_SETTLEMENT_RESERVE_BYTES = 256;
const RECOVERY_BLOCK_RESERVE_BYTES = 256;
const RECOVERY_FORMAT_RESERVE_BYTES = 64;
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
const RECOVERY_CHECKPOINT_KEYS = [...CHECKPOINT_KEYS, "events"] as const;
const RECOVERY_ADMISSION_KEYS = [...ADMISSION_KEYS, "preparedRevision", "runRevision"] as const;
const CLAIM_EVENT_KEYS = [
  "revision",
  "kind",
  "admissionId",
  "continuationId",
  "predecessorId",
  "claimedAt",
] as const;
const FINISH_EVENT_KEYS = [
  "revision",
  "kind",
  "admissionId",
  "continuationId",
  "mode",
  "observedUsd",
  "concurrencyHeld",
] as const;
const OBSERVE_COST_EVENT_KEYS = [
  "revision",
  "kind",
  "admissionId",
  "continuationId",
  "observationId",
  "observedUsd",
  "workerOverspend",
] as const;

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

export interface NativeHarnessAccountingV1Checkpoint {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_SCHEMA;
  readonly revision: number;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly createdAt: number;
  readonly limits: NativeHarnessDelegationLimits;
  readonly budgetBlock: NativeHarnessAccountingBudgetBlock | null;
  readonly admissions: readonly NativeHarnessAccountingAdmission[];
}

export interface NativeHarnessRecoveryAccountingAdmission extends NativeHarnessAccountingAdmission {
  /** Revision consumed by the original bindPrepared, or null before it. */
  readonly preparedRevision: number | null;
  /** Revision consumed by the original bindRun, or null before it. */
  readonly runRevision: number | null;
}

export interface NativeHarnessAccountingClaimEvent {
  readonly revision: number;
  readonly kind: "claim";
  readonly admissionId: string;
  readonly continuationId: string;
  readonly predecessorId: string | null;
  readonly claimedAt: number;
}

export interface NativeHarnessAccountingFinishEvent {
  readonly revision: number;
  readonly kind: "finish";
  readonly admissionId: string;
  readonly continuationId: string;
  readonly mode: "known" | "unknown";
  readonly observedUsd: number | null;
  readonly concurrencyHeld: boolean;
}

export interface NativeHarnessAccountingObserveCostEvent {
  readonly revision: number;
  readonly kind: "observe-cost";
  readonly admissionId: string;
  readonly continuationId: string | null;
  readonly observationId: string;
  readonly observedUsd: number;
  readonly workerOverspend: boolean;
}

export type NativeHarnessAccountingContinuationEvent =
  | NativeHarnessAccountingClaimEvent
  | NativeHarnessAccountingFinishEvent
  | NativeHarnessAccountingObserveCostEvent;

export interface NativeHarnessRecoveryAccountingCheckpoint {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2;
  readonly revision: number;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly createdAt: number;
  readonly limits: NativeHarnessDelegationLimits;
  readonly budgetBlock: NativeHarnessAccountingBudgetBlock | null;
  readonly admissions: readonly NativeHarnessRecoveryAccountingAdmission[];
  readonly events: readonly NativeHarnessAccountingContinuationEvent[];
}

/** Strict discriminated union returned by generic open/decode/observe. */
export type NativeHarnessAccountingCheckpoint =
  | NativeHarnessAccountingV1Checkpoint
  | NativeHarnessRecoveryAccountingCheckpoint;

type NativeHarnessAccountingAnyCheckpoint = NativeHarnessAccountingCheckpoint;

export interface NativeHarnessAccountingProjection {
  readonly accountedUsd: number;
  readonly observedUsd: number;
  readonly unknownUsd: number;
  readonly overspendUsd: number;
  readonly activeOperations: number;
  readonly retainedOperations: number;
  readonly budgetBlocked: boolean;
}

/**
 * Pure per-admission provenance copied from one already-owned V2 checkpoint.
 * The replay highwater is raw cumulative USD and is never money-rounded here;
 * the owner projection keeps the original rounding rule. This is historical
 * fact only: it is not current permission, resume authority, a claim, an
 * occupancy grant or a dispatch token, and no field mutates an owner.
 */
export interface NativeHarnessRecoveryAdmissionProjection {
  readonly kind: "historical-admission-facts";
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly checkpointRevision: number;
  readonly admission: Readonly<{
    readonly admissionId: string;
    readonly sourceAssociationSha256: string;
    readonly admittedAt: number;
    readonly deadlineAt: number;
    readonly allocatedUsd: number;
    readonly reserveRevision: number;
    readonly prepared: NativeHarnessAccountingPrepared | null;
    readonly runId: string | null;
    readonly settlement: NativeHarnessAccountingSettlement | null;
    readonly preparedRevision: number | null;
    readonly runRevision: number | null;
  }>;
  /** Exact cumulative observed highwater; never money-rounded. */
  readonly observedUsd: number;
  readonly unknownSticky: boolean;
  readonly occupancyHeld: boolean;
  readonly reserveCovered: boolean;
  readonly originalSettled: boolean;
  readonly latestClaimId: string | null;
  readonly latestClaimAt: number | null;
  readonly latestClaimOpen: boolean;
  readonly remainingClaims: number;
  readonly remainingFinishes: number;
  readonly remainingCostObservations: number;
  readonly remainingEvents: number;
  readonly ownerProjection: NativeHarnessAccountingProjection;
  readonly authority: "none";
  readonly currentPermission: false;
  readonly canResume: false;
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

/**
 * V2 handle returned by explicit recovery-owner creation. Generic open
 * returns NativeHarnessAccountingHandle whose snapshot/commit expose the
 * discriminated V1|V2 union; an already-stored V2 primary keeps the same V2
 * methods at runtime, and generic observe/decode expose that same union.
 */
export interface NativeHarnessRecoveryAccountingHandle {
  snapshot(): NativeHarnessRecoveryAccountingCheckpoint;
  commit(
    expectedRevision: number,
    transitionText: string,
  ): Promise<NativeHarnessRecoveryAccountingCheckpoint>;
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

interface ParsedClaimContinuationTransition {
  readonly action: "claimContinuation";
  readonly admissionId: string;
  readonly continuationId: string;
  readonly predecessorId: string | null;
  readonly claimedAt: number;
}

interface ParsedFinishContinuationTransition {
  readonly action: "finishContinuation";
  readonly admissionId: string;
  readonly continuationId: string;
  readonly mode: "known" | "unknown";
  readonly observedUsd: number | null;
  readonly concurrencyHeld: boolean;
}

interface ParsedObserveCostTransition {
  readonly action: "observeCost";
  readonly admissionId: string;
  readonly continuationId: string | null;
  readonly observationId: string;
  readonly observedUsd: number;
  readonly workerOverspend: boolean;
}

type ParsedRecoveryTransition =
  | ParsedTransition
  | ParsedClaimContinuationTransition
  | ParsedFinishContinuationTransition
  | ParsedObserveCostTransition;

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

function readCheckpoint(value: unknown): NativeHarnessAccountingV1Checkpoint {
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

function readClaimEvent(
  value: unknown,
  label: string,
  checkpointRevision: number,
): NativeHarnessAccountingClaimEvent {
  const record = plainRecord(value, label);
  requireExactKeys(record, CLAIM_EVENT_KEYS, label);
  const revision = readSafeInteger(record.revision, `${label}.revision`, 1);
  if (revision > checkpointRevision) fail("corrupt", `${label}.revision must be within the checkpoint.`);
  if (record.kind !== "claim") fail("corrupt", `${label}.kind must be claim.`);
  const predecessorId = record.predecessorId === null
    ? null
    : readUuid(record.predecessorId, `${label}.predecessorId`);
  return Object.freeze({
    revision,
    kind: "claim" as const,
    admissionId: readUuid(record.admissionId, `${label}.admissionId`),
    continuationId: readUuid(record.continuationId, `${label}.continuationId`),
    predecessorId,
    claimedAt: readSafeInteger(record.claimedAt, `${label}.claimedAt`, 1),
  });
}

function readFinishEvent(
  value: unknown,
  label: string,
  checkpointRevision: number,
): NativeHarnessAccountingFinishEvent {
  const record = plainRecord(value, label);
  requireExactKeys(record, FINISH_EVENT_KEYS, label);
  const revision = readSafeInteger(record.revision, `${label}.revision`, 1);
  if (revision > checkpointRevision) fail("corrupt", `${label}.revision must be within the checkpoint.`);
  if (record.kind !== "finish") fail("corrupt", `${label}.kind must be finish.`);
  const mode = readSettlementMode(record.mode, label);
  if (mode === "no-dispatch") fail("corrupt", `${label}.mode must be known or unknown.`);
  const observedUsd = record.observedUsd === null
    ? null
    : readNonNegativeUsd(record.observedUsd, `${label}.observedUsd`);
  if (typeof record.concurrencyHeld !== "boolean") {
    fail("corrupt", `${label}.concurrencyHeld must be a boolean.`);
  }
  return Object.freeze({
    revision,
    kind: "finish" as const,
    admissionId: readUuid(record.admissionId, `${label}.admissionId`),
    continuationId: readUuid(record.continuationId, `${label}.continuationId`),
    mode,
    observedUsd,
    concurrencyHeld: record.concurrencyHeld,
  });
}

function readObserveCostEvent(
  value: unknown,
  label: string,
  checkpointRevision: number,
): NativeHarnessAccountingObserveCostEvent {
  const record = plainRecord(value, label);
  requireExactKeys(record, OBSERVE_COST_EVENT_KEYS, label);
  const revision = readSafeInteger(record.revision, `${label}.revision`, 1);
  if (revision > checkpointRevision) fail("corrupt", `${label}.revision must be within the checkpoint.`);
  if (record.kind !== "observe-cost") fail("corrupt", `${label}.kind must be observe-cost.`);
  if (typeof record.workerOverspend !== "boolean") {
    fail("corrupt", `${label}.workerOverspend must be a boolean.`);
  }
  return Object.freeze({
    revision,
    kind: "observe-cost" as const,
    admissionId: readUuid(record.admissionId, `${label}.admissionId`),
    continuationId: record.continuationId === null
      ? null
      : readUuid(record.continuationId, `${label}.continuationId`),
    observationId: readUuid(record.observationId, `${label}.observationId`),
    observedUsd: readNonNegativeUsd(record.observedUsd, `${label}.observedUsd`),
    workerOverspend: record.workerOverspend,
  });
}

function readRecoveryEvent(
  value: unknown,
  label: string,
  checkpointRevision: number,
): NativeHarnessAccountingContinuationEvent {
  const record = plainRecord(value, label);
  if (record.kind === "claim") return readClaimEvent(record, label, checkpointRevision);
  if (record.kind === "finish") return readFinishEvent(record, label, checkpointRevision);
  if (record.kind === "observe-cost") return readObserveCostEvent(record, label, checkpointRevision);
  fail("corrupt", `${label}.kind is not a continuation event kind.`);
}

function readCheckpointV2(value: unknown): NativeHarnessRecoveryAccountingCheckpoint {
  const record = plainRecord(value, "recovery accounting checkpoint");
  requireExactKeys(record, RECOVERY_CHECKPOINT_KEYS, "recovery accounting checkpoint");
  if (record.schema !== NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
    fail("corrupt", "accounting checkpoint schema is not v2.");
  }
  const revision = readSafeInteger(record.revision, "revision", 0);
  if (revision > MAX_RECOVERY_ACTIONS) {
    fail("corrupt", `recovery accounting revision must not exceed ${MAX_RECOVERY_ACTIONS}.`);
  }
  const ownerId = readUuid(record.ownerId, "ownerId");
  const selectorSha256 = readSha256(record.selectorSha256, "selectorSha256");
  const createdAt = readSafeInteger(record.createdAt, "createdAt", 1);
  const limits = readLimits(record.limits);
  const rawAdmissions = readArray(record.admissions, "admissions");
  const maxRows = Math.min(MAX_RETENTION, limits.maxRetainedOperations);
  if (rawAdmissions.length > maxRows) {
    fail("corrupt", `admissions must not exceed ${maxRows} rows.`);
  }

  const admissions: NativeHarnessRecoveryAccountingAdmission[] = [];
  const admissionIds = new Set<string>();
  const runIds = new Set<string>();
  const actionRevisions: number[] = [];
  let previousReserveRevision = 0;

  for (let index = 0; index < rawAdmissions.length; index += 1) {
    const label = `admissions[${index}]`;
    const row = plainRecord(rawAdmissions[index], label);
    requireExactKeys(row, RECOVERY_ADMISSION_KEYS, label);
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
    const preparedRevision = row.preparedRevision === null
      ? null
      : readSafeInteger(row.preparedRevision, `${label}.preparedRevision`, 1);
    if ((prepared === null) !== (preparedRevision === null)) {
      fail("corrupt", `${label}.prepared and preparedRevision must both be null or both be set.`);
    }
    if (preparedRevision !== null && preparedRevision <= reserveRevision) {
      fail("corrupt", `${label}.preparedRevision must follow the reservation.`);
    }
    const runId = row.runId === null ? null : readUuid(row.runId, `${label}.runId`);
    const runRevision = row.runRevision === null
      ? null
      : readSafeInteger(row.runRevision, `${label}.runRevision`, 1);
    if ((runId === null) !== (runRevision === null)) {
      fail("corrupt", `${label}.runId and runRevision must both be null or both be set.`);
    }
    if (runId !== null) {
      if (prepared === null || preparedRevision === null) {
        fail("corrupt", `${label}.runId requires prepared metadata.`);
      }
      if (runRevision! <= preparedRevision) {
        fail("corrupt", `${label}.runRevision must follow preparedRevision.`);
      }
      if (runIds.has(runId)) fail("corrupt", `${label}.runId is not unique for this owner.`);
      runIds.add(runId);
    }
    const settlement = row.settlement === null
      ? null
      : readSettlement(row.settlement, `${label}.settlement`, { runId, reserveRevision }, revision);
    if (settlement !== null) {
      if (preparedRevision !== null && settlement.revision <= preparedRevision) {
        fail("corrupt", `${label}.settlement.revision must follow preparedRevision.`);
      }
      if (runRevision !== null && settlement.revision <= runRevision) {
        fail("corrupt", `${label}.settlement.revision must follow runRevision.`);
      }
    }
    actionRevisions.push(reserveRevision);
    if (preparedRevision !== null) actionRevisions.push(preparedRevision);
    if (runRevision !== null) actionRevisions.push(runRevision);
    if (settlement !== null) actionRevisions.push(settlement.revision);
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
      preparedRevision,
      runRevision,
    }));
  }

  const budgetBlock = record.budgetBlock === null
    ? null
    : readBudgetBlock(record.budgetBlock, revision);
  if (budgetBlock !== null) {
    actionRevisions.push(budgetBlock.revision);
    const row = admissions.find((candidate) => candidate.admissionId === budgetBlock.admissionId);
    if (row === undefined) fail("corrupt", "budgetBlock must reference an existing admission.");
    if (budgetBlock.revision <= row.reserveRevision) {
      fail("corrupt", "budgetBlock must follow the referenced reservation.");
    }
    if (row.settlement !== null && budgetBlock.revision >= row.settlement.revision) {
      fail("corrupt", "budgetBlock must precede the referenced settlement.");
    }
  }

  const rawEvents = readArray(record.events, "events");
  if (rawEvents.length > MAX_RECOVERY_EVENTS) {
    fail("corrupt", `events must not exceed ${MAX_RECOVERY_EVENTS} rows.`);
  }
  const events: NativeHarnessAccountingContinuationEvent[] = [];
  const claimIds = new Set<string>();
  const observationIds = new Set<string>();
  let claims = 0;
  let finishes = 0;
  let costs = 0;
  let previousEventRevision = 0;
  for (let index = 0; index < rawEvents.length; index += 1) {
    const label = `events[${index}]`;
    const event = readRecoveryEvent(rawEvents[index], label, revision);
    if (event.revision <= previousEventRevision) {
      fail("corrupt", "events must have strictly increasing revisions.");
    }
    previousEventRevision = event.revision;
    if (event.kind === "claim") {
      claims += 1;
      if (claims > MAX_RECOVERY_CLAIMS) fail("corrupt", `claim events must not exceed ${MAX_RECOVERY_CLAIMS}.`);
      if (claimIds.has(event.continuationId)) {
        fail("corrupt", `${label}.continuationId is not unique for this owner.`);
      }
      claimIds.add(event.continuationId);
    } else if (event.kind === "finish") {
      finishes += 1;
      if (finishes > MAX_RECOVERY_FINISHES) {
        fail("corrupt", `finish events must not exceed ${MAX_RECOVERY_FINISHES}.`);
      }
    } else {
      costs += 1;
      if (costs > MAX_RECOVERY_COST_OBSERVATIONS) {
        fail("corrupt", `observe-cost events must not exceed ${MAX_RECOVERY_COST_OBSERVATIONS}.`);
      }
      if (observationIds.has(event.observationId)) {
        fail("corrupt", `${label}.observationId is not unique for this owner.`);
      }
      observationIds.add(event.observationId);
    }
    actionRevisions.push(event.revision);
    events.push(event);
  }

  if (actionRevisions.length !== revision) {
    fail("corrupt", "recovery accounting revision must equal the exact owned action count.");
  }
  const sortedRevisions = [...actionRevisions].sort((left, right) => left - right);
  for (let index = 0; index < sortedRevisions.length; index += 1) {
    if (sortedRevisions[index] !== index + 1) {
      fail("corrupt", "recovery accounting revisions must be contiguous with no collisions or gaps.");
    }
  }
  if (admissions.length === 0 && revision !== 0) {
    fail("corrupt", "An empty recovery checkpoint must be revision 0.");
  }
  if (admissions.length > 0 && admissions[0]!.reserveRevision !== 1) {
    fail("corrupt", "The first recovery reservation must use revision 1.");
  }

  return deepFreeze({
    schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
    revision,
    ownerId,
    selectorSha256,
    createdAt,
    limits,
    budgetBlock,
    admissions: Object.freeze(admissions),
    events: Object.freeze(events),
  });
}

function readAnyCheckpoint(value: unknown): NativeHarnessAccountingAnyCheckpoint {
  const record = plainRecord(value, "accounting checkpoint");
  if (record.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
    return readCheckpointV2(record);
  }
  return readCheckpoint(record);
}

function money(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function projectCheckpoint(checkpoint: NativeHarnessAccountingV1Checkpoint): NativeHarnessAccountingProjection {
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

interface RecoveryAdmissionState {
  readonly row: NativeHarnessRecoveryAccountingAdmission;
  highwater: number;
  unknownSticky: boolean;
  occupancyHeld: boolean;
  reserveCovered: boolean;
  originalSettled: boolean;
  preparedBoundRevision: number | null;
  runBoundRevision: number | null;
  readonly claimIds: Set<string>;
  claimCount: number;
  latestClaimId: string | null;
  latestClaimAt: number | null;
  latestClaimOpen: boolean;
}

interface RecoveryReplay {
  readonly states: RecoveryAdmissionState[];
  readonly byId: Map<string, RecoveryAdmissionState>;
  claims: number;
  finishes: number;
  costs: number;
  observationIds: Set<string>;
  workerOverspend: boolean;
  sawBudgetBlock: boolean;
  lifetimeExceeded: boolean;
}

type RecoveryPoint =
  | { readonly kind: "reserve"; readonly revision: number; readonly row: NativeHarnessRecoveryAccountingAdmission }
  | { readonly kind: "bind-prepared"; readonly revision: number; readonly row: NativeHarnessRecoveryAccountingAdmission }
  | { readonly kind: "bind-run"; readonly revision: number; readonly row: NativeHarnessRecoveryAccountingAdmission }
  | { readonly kind: "settle"; readonly revision: number; readonly row: NativeHarnessRecoveryAccountingAdmission }
  | { readonly kind: "block"; readonly revision: number }
  | { readonly kind: "claim"; readonly revision: number; readonly event: NativeHarnessAccountingClaimEvent }
  | { readonly kind: "finish"; readonly revision: number; readonly event: NativeHarnessAccountingFinishEvent }
  | { readonly kind: "observe"; readonly revision: number; readonly event: NativeHarnessAccountingObserveCostEvent };

function recoveryContribution(state: RecoveryAdmissionState): number {
  const allocation = state.row.allocatedUsd;
  return state.reserveCovered ? Math.max(allocation, state.highwater) : state.highwater;
}

function recoveryTotals(replay: RecoveryReplay): {
  readonly accountedUsd: number;
  readonly observedUsd: number;
  readonly unknownUsd: number;
  readonly overspendUsd: number;
  readonly activeOperations: number;
} {
  let accountedUsd = 0;
  let observedUsd = 0;
  let unknownUsd = 0;
  let overspendUsd = 0;
  let activeOperations = 0;
  for (const state of replay.states) {
    const allocation = state.row.allocatedUsd;
    accountedUsd += recoveryContribution(state);
    observedUsd += state.highwater;
    if (state.unknownSticky) unknownUsd += allocation;
    if (state.highwater > allocation) overspendUsd += state.highwater - allocation;
    if (state.occupancyHeld) activeOperations += 1;
  }
  return { accountedUsd, observedUsd, unknownUsd, overspendUsd, activeOperations };
}

function recoveryBudgetBlocked(
  replay: RecoveryReplay,
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
): boolean {
  if (replay.sawBudgetBlock || replay.workerOverspend || replay.lifetimeExceeded) return true;
  const totals = recoveryTotals(replay);
  if (totals.accountedUsd > checkpoint.limits.lifetimeUsd + USD_EPSILON) return true;
  return replay.states.some((state) => state.highwater > state.row.allocatedUsd);
}

function recordRecoveryLifetime(
  replay: RecoveryReplay,
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
): void {
  if (recoveryTotals(replay).accountedUsd > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
    replay.lifetimeExceeded = true;
  }
}

function replayRecoveryCheckpoint(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
): RecoveryReplay {
  const points: RecoveryPoint[] = [];
  for (const row of checkpoint.admissions) {
    points.push({ kind: "reserve", revision: row.reserveRevision, row });
    if (row.preparedRevision !== null) {
      points.push({ kind: "bind-prepared", revision: row.preparedRevision, row });
    }
    if (row.runRevision !== null) {
      points.push({ kind: "bind-run", revision: row.runRevision, row });
    }
    if (row.settlement !== null) {
      points.push({ kind: "settle", revision: row.settlement.revision, row });
    }
  }
  if (checkpoint.budgetBlock !== null) {
    points.push({ kind: "block", revision: checkpoint.budgetBlock.revision });
  }
  for (const event of checkpoint.events) {
    if (event.kind === "claim") {
      points.push({ kind: "claim", revision: event.revision, event });
    } else if (event.kind === "finish") {
      points.push({ kind: "finish", revision: event.revision, event });
    } else {
      points.push({ kind: "observe", revision: event.revision, event });
    }
  }
  points.sort((left, right) => left.revision - right.revision);
  if (points.length !== checkpoint.revision) {
    fail("corrupt", "Recovery replay does not contain exactly one point per owned action.");
  }

  const replay: RecoveryReplay = {
    states: [],
    byId: new Map(),
    claims: 0,
    finishes: 0,
    costs: 0,
    observationIds: new Set(),
    workerOverspend: false,
    sawBudgetBlock: false,
    lifetimeExceeded: false,
  };

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.revision !== index + 1) {
      fail("corrupt", "Recovery replay revisions must be contiguous with no collisions or gaps.");
    }

    if (point.kind === "reserve") {
      if (point.row.reserveRevision !== point.revision) {
        fail("corrupt", "A recovery reservation point does not match its stored revision.");
      }
      if (replay.byId.has(point.row.admissionId)) {
        fail("corrupt", "A recovery reservation is repeated.");
      }
      if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
        fail("corrupt", "A historical reservation follows exhausted cost-observation capacity.");
      }
      if (replay.states.length >= checkpoint.limits.maxRetainedOperations) {
        fail("corrupt", "A historical reservation exceeds maxRetainedOperations.");
      }
      const totals = recoveryTotals(replay);
      if (totals.activeOperations >= checkpoint.limits.maxConcurrent) {
        fail("corrupt", "A historical reservation exceeds maxConcurrent.");
      }
      if (recoveryBudgetBlocked(replay, checkpoint)) {
        fail("corrupt", "A historical reservation follows a sticky budget block.");
      }
      if (totals.accountedUsd + point.row.allocatedUsd
        > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
        fail("corrupt", "A historical reservation exceeds the lifetime budget at its own prefix.");
      }
      const state: RecoveryAdmissionState = {
        row: point.row,
        highwater: 0,
        unknownSticky: false,
        occupancyHeld: true,
        reserveCovered: true,
        originalSettled: false,
        preparedBoundRevision: null,
        runBoundRevision: null,
        claimIds: new Set(),
        claimCount: 0,
        latestClaimId: null,
        latestClaimAt: null,
        latestClaimOpen: false,
      };
      replay.states.push(state);
      replay.byId.set(point.row.admissionId, state);
      recordRecoveryLifetime(replay, checkpoint);
      continue;
    }

    if (point.kind === "block") {
      if (checkpoint.budgetBlock === null || checkpoint.budgetBlock.revision !== point.revision) {
        fail("corrupt", "A budget-block point does not match the stored block.");
      }
      const state = replay.byId.get(checkpoint.budgetBlock.admissionId);
      if (state === undefined) fail("corrupt", "budgetBlock precedes its referenced reservation.");
      if (state.originalSettled) fail("corrupt", "budgetBlock follows the referenced settlement.");
      if (state.claimCount !== 0) {
        fail("corrupt", "budgetBlock follows a continuation claim on the referenced admission.");
      }
      replay.sawBudgetBlock = true;
      continue;
    }

    if (point.kind === "claim") {
      const event = point.event;
      const state = replay.byId.get(event.admissionId);
      if (state === undefined) fail("corrupt", "A claim references an unknown admission.");
      if (state.runBoundRevision === null) {
        fail("corrupt", "A claim precedes its original run binding.");
      }
      if (replay.claims >= MAX_RECOVERY_CLAIMS) {
        fail("corrupt", "Claim events exceed the owner cap.");
      }
      if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
        fail("corrupt", "A claim follows exhausted cost-observation capacity.");
      }
      if (event.predecessorId !== state.latestClaimId) {
        fail("corrupt", "A claim predecessor is not the exact latest claim or null.");
      }
      if (event.claimedAt < state.row.admittedAt
        || (state.latestClaimAt !== null && event.claimedAt < state.latestClaimAt)
        || !(event.claimedAt < state.row.deadlineAt)) {
        fail("corrupt", "A claim time is outside the admitted/latest/deadline window.");
      }
      const totals = recoveryTotals(replay);
      if (recoveryBudgetBlocked(replay, checkpoint)) {
        fail("corrupt", "A claim follows a sticky budget block.");
      }
      if (!(state.highwater < state.row.allocatedUsd)) {
        fail("corrupt", "A claim has zero known remaining allocation.");
      }
      if (!state.occupancyHeld
        && totals.activeOperations >= checkpoint.limits.maxConcurrent) {
        fail("corrupt", "A claim would exceed maxConcurrent while reacquiring occupancy.");
      }
      if (!state.reserveCovered) {
        const recover = Math.max(0, state.row.allocatedUsd - state.highwater);
        if (totals.accountedUsd + recover > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
          fail("corrupt", "A claim cannot re-cover released allocation within the current lifetime budget.");
        }
      }
      if (!state.originalSettled) state.unknownSticky = true;
      if (state.latestClaimId !== null && state.latestClaimOpen) state.unknownSticky = true;
      state.occupancyHeld = true;
      state.reserveCovered = true;
      state.claimIds.add(event.continuationId);
      state.claimCount += 1;
      state.latestClaimId = event.continuationId;
      state.latestClaimAt = event.claimedAt;
      state.latestClaimOpen = true;
      replay.claims += 1;
      recordRecoveryLifetime(replay, checkpoint);
      continue;
    }

    if (point.kind === "finish") {
      const event = point.event;
      const state = replay.byId.get(event.admissionId);
      if (state === undefined) fail("corrupt", "A finish references an unknown admission.");
      if (state.latestClaimId === null || event.continuationId !== state.latestClaimId
        || !state.latestClaimOpen) {
        fail("corrupt", "A finish is not for the latest unfinished claim generation.");
      }
      if (replay.finishes >= MAX_RECOVERY_FINISHES) {
        fail("corrupt", "Finish events exceed the owner cap.");
      }
      if (!state.occupancyHeld) fail("corrupt", "A finish generation does not hold occupancy.");
      if (event.mode === "known") {
        if (state.unknownSticky) fail("corrupt", "A known finish follows historical unknown usage.");
        if (typeof event.observedUsd !== "number" || event.observedUsd < state.highwater) {
          fail("corrupt", "A known finish is below the cumulative observed highwater.");
        }
        if (event.concurrencyHeld) fail("corrupt", "A known finish cannot retain occupancy.");
        state.highwater = event.observedUsd;
        state.reserveCovered = false;
        state.occupancyHeld = false;
      } else {
        state.unknownSticky = true;
        state.reserveCovered = true;
        if (typeof event.observedUsd === "number") {
          state.highwater = Math.max(state.highwater, event.observedUsd);
        }
        state.occupancyHeld = event.concurrencyHeld;
      }
      state.latestClaimOpen = false;
      replay.finishes += 1;
      recordRecoveryLifetime(replay, checkpoint);
      continue;
    }

    if (point.kind === "observe") {
      const event = point.event;
      const state = replay.byId.get(event.admissionId);
      if (state === undefined) fail("corrupt", "A cost observation references an unknown admission.");
      if (state.runBoundRevision === null) {
        fail("corrupt", "A cost observation precedes its original run binding.");
      }
      if (event.continuationId !== null && !state.claimIds.has(event.continuationId)) {
        fail("corrupt", "A cost observation references an unseen claim generation.");
      }
      if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
        fail("corrupt", "Cost observations exceed the owner cap.");
      }
      if (replay.observationIds.has(event.observationId)) {
        fail("corrupt", "A cost observationId is not unique for this owner.");
      }
      replay.observationIds.add(event.observationId);
      state.highwater = Math.max(state.highwater, event.observedUsd);
      if (event.workerOverspend) replay.workerOverspend = true;
      replay.costs += 1;
      recordRecoveryLifetime(replay, checkpoint);
      continue;
    }

    const state = replay.byId.get(point.row.admissionId);
    if (state === undefined) fail("corrupt", "A bind or settlement references an unknown admission.");

    if (point.kind === "bind-prepared") {
      if (state.originalSettled) fail("corrupt", "A bind follows the original settlement.");
      if (state.claimCount !== 0) fail("corrupt", "A bind follows the first continuation claim.");
      if (state.preparedBoundRevision !== null) fail("corrupt", "Prepared metadata is bound twice.");
      if (point.row.prepared === null || point.row.preparedRevision !== point.revision) {
        fail("corrupt", "A prepared bind point does not match its stored revision.");
      }
      state.preparedBoundRevision = point.revision;
      continue;
    }

    if (point.kind === "bind-run") {
      if (state.originalSettled) fail("corrupt", "A run bind follows the original settlement.");
      if (state.claimCount !== 0) fail("corrupt", "A run bind follows the first continuation claim.");
      if (state.preparedBoundRevision === null) {
        fail("corrupt", "A run bind precedes its prepared bind.");
      }
      if (state.runBoundRevision !== null) fail("corrupt", "A runId is bound twice.");
      if (point.row.runId === null || point.row.runRevision !== point.revision) {
        fail("corrupt", "A run bind point does not match its stored revision.");
      }
      state.runBoundRevision = point.revision;
      continue;
    }

    if (point.row.settlement === null || point.row.settlement.revision !== point.revision) {
      fail("corrupt", "A settlement point does not match its stored revision.");
    }
    if (state.originalSettled) fail("corrupt", "An admission is settled twice.");
    if (state.claimCount !== 0) fail("corrupt", "An original settlement follows a continuation claim.");
    const settlement = point.row.settlement;
    if (settlement.mode === "known") {
      if (state.runBoundRevision === null) fail("corrupt", "A known settlement precedes its run binding.");
      if (typeof settlement.observedUsd !== "number" || settlement.observedUsd < state.highwater) {
        fail("corrupt", "A known settlement is below the cumulative observed highwater.");
      }
      if (!state.occupancyHeld) fail("corrupt", "A known settlement releases unheld occupancy.");
      state.highwater = settlement.observedUsd;
      state.reserveCovered = false;
      state.occupancyHeld = false;
    } else if (settlement.mode === "unknown") {
      if (!state.occupancyHeld) fail("corrupt", "An unknown settlement releases unheld occupancy.");
      state.unknownSticky = true;
      state.reserveCovered = true;
      if (typeof settlement.observedUsd === "number") {
        state.highwater = Math.max(state.highwater, settlement.observedUsd);
      }
      state.occupancyHeld = settlement.concurrencyHeld;
    } else {
      if (state.highwater !== 0) fail("corrupt", "A no-dispatch settlement has observed cost.");
      if (!state.occupancyHeld) fail("corrupt", "A no-dispatch settlement releases unheld occupancy.");
      state.reserveCovered = false;
      state.occupancyHeld = false;
    }
    state.originalSettled = true;
    recordRecoveryLifetime(replay, checkpoint);
  }

  if (replay.states.length !== checkpoint.admissions.length) {
    fail("corrupt", "Recovery replay state count does not match the admission rows.");
  }
  if (replay.claims > MAX_RECOVERY_CLAIMS
    || replay.finishes > MAX_RECOVERY_FINISHES
    || replay.costs > MAX_RECOVERY_COST_OBSERVATIONS) {
    fail("corrupt", "Recovery event caps are exceeded.");
  }
  const totals = recoveryTotals(replay);
  if (![totals.accountedUsd, totals.observedUsd, totals.unknownUsd, totals.overspendUsd]
    .every(Number.isFinite)) {
    fail("corrupt", "Recovery accounting totals are not finite.");
  }
  return replay;
}

function recoveryReserveBytes(checkpoint: {
  readonly budgetBlock: NativeHarnessAccountingBudgetBlock | null;
  readonly admissions: readonly { readonly settlement: NativeHarnessAccountingSettlement | null }[];
  readonly events: readonly NativeHarnessAccountingContinuationEvent[];
}): number {
  let claims = 0;
  let finishes = 0;
  let costs = 0;
  for (const event of checkpoint.events) {
    if (event.kind === "claim") claims += 1;
    else if (event.kind === "finish") finishes += 1;
    else costs += 1;
  }
  const remainingEvents = (MAX_RECOVERY_CLAIMS - claims)
    + (MAX_RECOVERY_FINISHES - finishes)
    + (MAX_RECOVERY_COST_OBSERVATIONS - costs);
  const nullSettlements = checkpoint.admissions.filter(
    (row) => row.settlement === null,
  ).length;
  return remainingEvents * RECOVERY_EVENT_RESERVE_BYTES
    + nullSettlements * RECOVERY_SETTLEMENT_RESERVE_BYTES
    + (checkpoint.budgetBlock === null ? RECOVERY_BLOCK_RESERVE_BYTES : 0)
    + RECOVERY_FORMAT_RESERVE_BYTES;
}

function assertRecoveryReservedBytes(
  encodedBytes: number,
  checkpoint: {
    readonly budgetBlock: NativeHarnessAccountingBudgetBlock | null;
    readonly admissions: readonly { readonly settlement: NativeHarnessAccountingSettlement | null }[];
    readonly events: readonly NativeHarnessAccountingContinuationEvent[];
  },
): void {
  if (encodedBytes + recoveryReserveBytes(checkpoint) > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES) {
    fail(
      "too-large",
      `Serialized recovery checkpoint plus its finite reserved tail exceeds ${NATIVE_HARNESS_ACCOUNTING_MAX_BYTES} bytes.`,
    );
  }
}

function recoveryPrefixCheckpoint(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
  revision: number,
): NativeHarnessRecoveryAccountingCheckpoint {
  const admissions = checkpoint.admissions
    .filter((row) => row.reserveRevision <= revision)
    .map((row) => {
      const preparedEnacted = row.preparedRevision !== null && row.preparedRevision <= revision;
      const runEnacted = row.runRevision !== null && row.runRevision <= revision;
      const settlementEnacted = row.settlement !== null && row.settlement.revision <= revision;
      return {
        admissionId: row.admissionId,
        sourceAssociationSha256: row.sourceAssociationSha256,
        admittedAt: row.admittedAt,
        deadlineAt: row.deadlineAt,
        allocatedUsd: row.allocatedUsd,
        reserveRevision: row.reserveRevision,
        prepared: preparedEnacted ? row.prepared : null,
        runId: runEnacted ? row.runId : null,
        settlement: settlementEnacted ? row.settlement : null,
        preparedRevision: preparedEnacted ? row.preparedRevision : null,
        runRevision: runEnacted ? row.runRevision : null,
      };
    });
  const events = checkpoint.events.filter((event) => event.revision <= revision);
  const budgetBlock = checkpoint.budgetBlock !== null && checkpoint.budgetBlock.revision <= revision
    ? checkpoint.budgetBlock
    : null;
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
    revision,
    ownerId: checkpoint.ownerId,
    selectorSha256: checkpoint.selectorSha256,
    createdAt: checkpoint.createdAt,
    limits: checkpoint.limits,
    budgetBlock,
    admissions,
    events,
  };
}

function assertRecoveryPrefixCapacity(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
): void {
  for (let revision = 0; revision <= checkpoint.revision; revision += 1) {
    const prefix = recoveryPrefixCheckpoint(checkpoint, revision);
    const encoded = encodeCheckpoint(prefix);
    assertRecoveryReservedBytes(Buffer.byteLength(encoded, "utf8"), prefix);
  }
}

function projectRecoveryReplay(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
  replay: RecoveryReplay,
): NativeHarnessAccountingProjection {
  const totals = recoveryTotals(replay);
  assertRecoveryReservedBytes(
    Buffer.byteLength(encodeCheckpoint(checkpoint), "utf8"),
    checkpoint,
  );
  assertRecoveryPrefixCapacity(checkpoint);
  return deepFreeze({
    accountedUsd: money(totals.accountedUsd),
    observedUsd: money(totals.observedUsd),
    unknownUsd: money(totals.unknownUsd),
    overspendUsd: money(totals.overspendUsd),
    activeOperations: totals.activeOperations,
    retainedOperations: replay.states.length,
    budgetBlocked: recoveryBudgetBlocked(replay, checkpoint),
  });
}

function projectCheckpointV2(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
): NativeHarnessAccountingProjection {
  return projectRecoveryReplay(checkpoint, replayRecoveryCheckpoint(checkpoint));
}

function projectAnyCheckpoint(
  checkpoint: NativeHarnessAccountingAnyCheckpoint,
): NativeHarnessAccountingProjection {
  return checkpoint.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2
    ? projectCheckpointV2(checkpoint)
    : projectCheckpoint(checkpoint);
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
  const checkpoint = readAnyCheckpoint(value);
  if (checkpoint.selectorSha256 !== expected.selectorSha256
    || (expected.ownerId !== undefined && checkpoint.ownerId !== expected.ownerId)) {
    fail("identity-mismatch", "Accounting checkpoint identity does not match the expected owner/selector.");
  }
  if (checkpoint.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
    assertRecoveryReservedBytes(Buffer.byteLength(raw, "utf8"), checkpoint);
  }
  projectAnyCheckpoint(checkpoint);
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
  return projectAnyCheckpoint(readAnyCheckpoint(checkpoint));
}

function copyRecoveryAdmissionRow(
  row: NativeHarnessRecoveryAccountingAdmission,
): NativeHarnessRecoveryAdmissionProjection["admission"] {
  return Object.freeze({
    admissionId: row.admissionId,
    sourceAssociationSha256: row.sourceAssociationSha256,
    admittedAt: row.admittedAt,
    deadlineAt: row.deadlineAt,
    allocatedUsd: row.allocatedUsd,
    reserveRevision: row.reserveRevision,
    prepared: row.prepared === null
      ? null
      : Object.freeze({
        preparedRelativeRoot: row.prepared.preparedRelativeRoot,
        storeRelativeRoot: row.prepared.storeRelativeRoot,
        inputManifestSha256: row.prepared.inputManifestSha256,
        sourceDescriptorSha256: row.prepared.sourceDescriptorSha256,
      }),
    runId: row.runId,
    settlement: row.settlement === null
      ? null
      : Object.freeze({
        revision: row.settlement.revision,
        mode: row.settlement.mode,
        observedUsd: row.settlement.observedUsd,
        concurrencyHeld: row.settlement.concurrencyHeld,
      }),
    preparedRevision: row.preparedRevision,
    runRevision: row.runRevision,
  });
}

/**
 * Pure readonly per-admission projection of one already-owned V2 checkpoint.
 * It revalidates through the original strict V2 codec and private replay, then
 * copies only plain data. V1, malformed ids, missing admissions and impossible
 * timelines refuse; no V1 row is ever cast, migrated or upgraded. The raw
 * replay highwater is returned exactly as stored, unlike the owner projection
 * which keeps the original money rounding.
 */
export function projectNativeHarnessRecoveryAdmission(
  checkpoint: unknown,
  admissionId: unknown,
): NativeHarnessRecoveryAdmissionProjection {
  const checked = readAnyCheckpoint(checkpoint);
  if (checked.schema !== NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
    fail(
      "invalid-input",
      "Recovery admission projection requires an explicit V2 checkpoint; V1 remains ordinary/diagnostic and is not cast or upgraded.",
    );
  }
  const exactAdmissionId = readUuid(admissionId, "admissionId", "invalid-input");
  const replay = replayRecoveryCheckpoint(checked);
  const state = replay.byId.get(exactAdmissionId);
  if (state === undefined) {
    fail("invalid-input", "The checkpoint has no admission with this exact id; nothing was projected.");
  }
  const ownerProjection = projectRecoveryReplay(checked, replay);
  return deepFreeze({
    kind: "historical-admission-facts" as const,
    ownerId: checked.ownerId,
    selectorSha256: checked.selectorSha256,
    checkpointRevision: checked.revision,
    admission: copyRecoveryAdmissionRow(state.row),
    observedUsd: state.highwater,
    unknownSticky: state.unknownSticky,
    occupancyHeld: state.occupancyHeld,
    reserveCovered: state.reserveCovered,
    originalSettled: state.originalSettled,
    latestClaimId: state.latestClaimId,
    latestClaimAt: state.latestClaimAt,
    latestClaimOpen: state.latestClaimOpen,
    remainingClaims: MAX_RECOVERY_CLAIMS - replay.claims,
    remainingFinishes: MAX_RECOVERY_FINISHES - replay.finishes,
    remainingCostObservations: MAX_RECOVERY_COST_OBSERVATIONS - replay.costs,
    remainingEvents: MAX_RECOVERY_EVENTS - checked.events.length,
    ownerProjection,
    authority: "none" as const,
    currentPermission: false as const,
    canResume: false as const,
  });
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

function parseV1TransitionRecord(record: Record<string, unknown>): ParsedTransition {
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

function parseTransitionRecord(text: unknown): Record<string, unknown> {
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
  return plainRecord(value, "transition", "invalid-transition");
}

function parseTransitionText(text: unknown): ParsedTransition {
  const record = parseTransitionRecord(text);
  if (record.schema !== NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA) {
    fail("invalid-transition", "Transition schema is not v1.");
  }
  return parseV1TransitionRecord(record);
}

function parseRecoveryClaimTransition(
  record: Record<string, unknown>,
): ParsedClaimContinuationTransition {
  requireExactKeys(
    record,
    ["schema", "action", "admissionId", "continuationId", "predecessorId", "claimedAt"],
    "claimContinuation transition",
    "invalid-transition",
  );
  return {
    action: "claimContinuation",
    admissionId: readUuid(record.admissionId, "claimContinuation.admissionId", "invalid-transition"),
    continuationId: readUuid(
      record.continuationId,
      "claimContinuation.continuationId",
      "invalid-transition",
    ),
    predecessorId: record.predecessorId === null
      ? null
      : readUuid(record.predecessorId, "claimContinuation.predecessorId", "invalid-transition"),
    claimedAt: readSafeInteger(
      record.claimedAt,
      "claimContinuation.claimedAt",
      1,
      "invalid-transition",
    ),
  };
}

function parseRecoveryFinishTransition(
  record: Record<string, unknown>,
): ParsedFinishContinuationTransition {
  requireExactKeys(
    record,
    ["schema", "action", "admissionId", "continuationId", "mode", "observedUsd", "concurrencyHeld"],
    "finishContinuation transition",
    "invalid-transition",
  );
  let mode: "known" | "unknown";
  if (record.mode === "known") mode = "known";
  else if (record.mode === "unknown") mode = "unknown";
  else fail("invalid-transition", "finishContinuation.mode must be known or unknown.");
  if (typeof record.concurrencyHeld !== "boolean") {
    fail("invalid-transition", "finishContinuation.concurrencyHeld must be a boolean.");
  }
  const observedUsd = record.observedUsd === null
    ? null
    : readNonNegativeUsd(record.observedUsd, "finishContinuation.observedUsd", "invalid-transition");
  if (mode === "known" && typeof observedUsd !== "number") {
    fail("invalid-transition", "finishContinuation known requires numeric observedUsd.");
  }
  if (mode === "known" && record.concurrencyHeld !== false) {
    fail("invalid-transition", "finishContinuation known requires concurrencyHeld false.");
  }
  return {
    action: "finishContinuation",
    admissionId: readUuid(record.admissionId, "finishContinuation.admissionId", "invalid-transition"),
    continuationId: readUuid(
      record.continuationId,
      "finishContinuation.continuationId",
      "invalid-transition",
    ),
    mode,
    observedUsd,
    concurrencyHeld: record.concurrencyHeld,
  };
}

function parseRecoveryObserveCostTransition(
  record: Record<string, unknown>,
): ParsedObserveCostTransition {
  requireExactKeys(
    record,
    [
      "schema",
      "action",
      "admissionId",
      "continuationId",
      "observationId",
      "observedUsd",
      "workerOverspend",
    ],
    "observeCost transition",
    "invalid-transition",
  );
  if (typeof record.workerOverspend !== "boolean") {
    fail("invalid-transition", "observeCost.workerOverspend must be a boolean.");
  }
  return {
    action: "observeCost",
    admissionId: readUuid(record.admissionId, "observeCost.admissionId", "invalid-transition"),
    continuationId: record.continuationId === null
      ? null
      : readUuid(record.continuationId, "observeCost.continuationId", "invalid-transition"),
    observationId: readUuid(record.observationId, "observeCost.observationId", "invalid-transition"),
    observedUsd: readNonNegativeUsd(
      record.observedUsd,
      "observeCost.observedUsd",
      "invalid-transition",
    ),
    workerOverspend: record.workerOverspend,
  };
}

function parseRecoveryTransitionText(text: unknown): ParsedRecoveryTransition {
  const record = parseTransitionRecord(text);
  if (record.schema === NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA) {
    return parseV1TransitionRecord(record);
  }
  if (record.schema !== NATIVE_HARNESS_ACCOUNTING_RECOVERY_TRANSITION_SCHEMA) {
    fail("invalid-transition", "Transition schema is neither the supported v1 nor recovery v2 schema.");
  }
  if (record.action === "claimContinuation") return parseRecoveryClaimTransition(record);
  if (record.action === "finishContinuation") return parseRecoveryFinishTransition(record);
  if (record.action === "observeCost") return parseRecoveryObserveCostTransition(record);
  fail("invalid-transition", "Recovery transition action is not supported.");
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
  checkpoint: NativeHarnessAccountingV1Checkpoint,
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

function copyRecoveryAdmission(
  row: NativeHarnessRecoveryAccountingAdmission,
): Record<string, unknown> {
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
    preparedRevision: row.preparedRevision,
    runRevision: row.runRevision,
  };
}

function applyTransitionV2(
  checkpoint: NativeHarnessRecoveryAccountingCheckpoint,
  transition: ParsedRecoveryTransition,
  nextRevision: number,
): Record<string, unknown> {
  const replay = replayRecoveryCheckpoint(checkpoint);
  const rows = checkpoint.admissions.map(copyRecoveryAdmission);
  const events: Record<string, unknown>[] = checkpoint.events.map((event) => ({ ...event }));
  const candidate: Record<string, unknown> = {
    schema: checkpoint.schema,
    revision: nextRevision,
    ownerId: checkpoint.ownerId,
    selectorSha256: checkpoint.selectorSha256,
    createdAt: checkpoint.createdAt,
    limits: { ...checkpoint.limits },
    budgetBlock: checkpoint.budgetBlock === null ? null : { ...checkpoint.budgetBlock },
    admissions: rows,
    events,
  };

  if (transition.action === "reserve") {
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
    if (replay.states.length >= checkpoint.limits.maxRetainedOperations) {
      fail("invalid-transition", "Reserve would exceed maxRetainedOperations.");
    }
    if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
      fail("exhausted", "Reserve is refused after all cost-observation events are used.");
    }
    const totals = recoveryTotals(replay);
    if (totals.activeOperations >= checkpoint.limits.maxConcurrent) {
      fail("invalid-transition", "Reserve would exceed maxConcurrent.");
    }
    if (recoveryBudgetBlocked(replay, checkpoint)) {
      fail("invalid-transition", "Reserve follows a sticky budget block.");
    }
    if (totals.accountedUsd + checkpoint.limits.perRunUsd
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
      preparedRevision: null,
      runRevision: null,
    });
    return candidate;
  }

  const index = rows.findIndex((row) => row.admissionId === transition.admissionId);
  if (index < 0) fail("invalid-transition", "Transition references an unknown admission.");
  const row = rows[index]!;
  const state = replay.byId.get(transition.admissionId);
  if (state === undefined) fail("invalid-transition", "Transition state is unavailable.");
  const totals = recoveryTotals(replay);

  if (transition.action === "bindPrepared") {
    if (state.originalSettled) fail("invalid-transition", "Cannot bind prepared metadata after settlement.");
    if (state.claimCount !== 0) {
      fail("invalid-transition", "Original prepared binding is closed after the first continuation claim.");
    }
    if (row.prepared !== null) fail("invalid-transition", "Prepared metadata is already bound.");
    rows[index] = { ...row, prepared: { ...transition.prepared }, preparedRevision: nextRevision };
    return candidate;
  }

  if (transition.action === "bindRun") {
    if (state.originalSettled) fail("invalid-transition", "Cannot bind runId after settlement.");
    if (state.claimCount !== 0) {
      fail("invalid-transition", "Original run binding is closed after the first continuation claim.");
    }
    if (row.prepared === null) fail("invalid-transition", "runId requires already-bound prepared metadata.");
    if (row.runId !== null) fail("invalid-transition", "runId is already bound.");
    if (rows.some((other, otherIndex) => otherIndex !== index && other.runId === transition.runId)) {
      fail("invalid-transition", "runId must be unique for this owner.");
    }
    rows[index] = { ...row, runId: transition.runId, runRevision: nextRevision };
    return candidate;
  }

  if (transition.action === "blockBudget") {
    if (checkpoint.budgetBlock !== null) {
      fail("invalid-transition", "A sticky budget block already exists.");
    }
    if (state.originalSettled) fail("invalid-transition", "blockBudget requires an unsettled admission.");
    if (state.claimCount !== 0) {
      fail("invalid-transition", "Original blockBudget is closed after the first continuation claim.");
    }
    candidate.budgetBlock = {
      admissionId: transition.admissionId,
      revision: nextRevision,
      reason: "observed-worker-overspend",
    };
    return candidate;
  }

  if (transition.action === "settle") {
    if (state.originalSettled) fail("invalid-transition", "Admission is already settled.");
    if (state.claimCount !== 0) {
      fail("invalid-transition", "Original settlement is closed after the first continuation claim.");
    }
    if (!state.occupancyHeld) {
      fail("invalid-transition", "Original settlement requires the original occupancy.");
    }
    if (transition.mode === "no-dispatch") {
      if (row.runId !== null || state.runBoundRevision !== null
        || transition.observedUsd !== 0 || transition.concurrencyHeld !== false) {
        fail("invalid-transition", "no-dispatch requires observedUsd 0, held false and no runId.");
      }
    } else if (transition.mode === "known") {
      if (row.runId === null || state.runBoundRevision === null
        || typeof transition.observedUsd !== "number"
        || transition.observedUsd < state.highwater
        || transition.concurrencyHeld !== false) {
        fail("invalid-transition", "known settlement requires a runId, held false and observedUsd at or above the highwater.");
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

  if (transition.action === "claimContinuation") {
    if (state.runBoundRevision === null) {
      fail("invalid-transition", "A continuation claim requires an already bound original run.");
    }
    if (replay.claims >= MAX_RECOVERY_CLAIMS) {
      fail("exhausted", "Continuation claim events are exhausted.");
    }
    if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
      fail("exhausted", "Continuation claims are refused after all cost-observation events are used.");
    }
    if (transition.predecessorId !== state.latestClaimId) {
      fail("invalid-transition", "Claim predecessorId must be the exact latest claim or null.");
    }
    if (transition.claimedAt < state.row.admittedAt
      || (state.latestClaimAt !== null && transition.claimedAt < state.latestClaimAt)
      || !(transition.claimedAt < state.row.deadlineAt)) {
      fail("invalid-transition", "Claim claimedAt must be admittedAt-or-later, monotonic and before deadlineAt.");
    }
    if (checkpoint.events.some(
      (event) => event.kind === "claim" && event.continuationId === transition.continuationId,
    )) {
      fail("conflict", "Claim continuationId is not unique for this owner.");
    }
    if (recoveryBudgetBlocked(replay, checkpoint)) {
      fail("invalid-transition", "Claim follows a sticky budget block.");
    }
    if (!(state.highwater < state.row.allocatedUsd)) {
      fail("invalid-transition", "Claim has zero known remaining allocation.");
    }
    if (!state.occupancyHeld && totals.activeOperations >= checkpoint.limits.maxConcurrent) {
      fail("invalid-transition", "Claim cannot reacquire occupancy beyond maxConcurrent.");
    }
    if (!state.reserveCovered) {
      const recover = Math.max(0, state.row.allocatedUsd - state.highwater);
      if (totals.accountedUsd + recover > checkpoint.limits.lifetimeUsd + USD_EPSILON) {
        fail("invalid-transition", "Claim cannot re-cover released allocation within the current lifetime budget.");
      }
    }
    events.push({
      revision: nextRevision,
      kind: "claim",
      admissionId: transition.admissionId,
      continuationId: transition.continuationId,
      predecessorId: transition.predecessorId,
      claimedAt: transition.claimedAt,
    });
    return candidate;
  }

  if (transition.action === "finishContinuation") {
    if (state.latestClaimId === null || transition.continuationId !== state.latestClaimId
      || !state.latestClaimOpen) {
      fail("invalid-transition", "Finish must reference the latest unfinished claim generation.");
    }
    if (replay.finishes >= MAX_RECOVERY_FINISHES) {
      fail("exhausted", "Continuation finish events are exhausted.");
    }
    if (!state.occupancyHeld) {
      fail("invalid-transition", "Finish generation does not hold occupancy.");
    }
    if (transition.mode === "known") {
      if (state.unknownSticky) {
        fail("invalid-transition", "Known finish is refused after historical unknown usage.");
      }
      if (typeof transition.observedUsd !== "number"
        || transition.observedUsd < state.highwater) {
        fail("invalid-transition", "Known finish requires cumulative cost at or above the highwater.");
      }
    }
    events.push({
      revision: nextRevision,
      kind: "finish",
      admissionId: transition.admissionId,
      continuationId: transition.continuationId,
      mode: transition.mode,
      observedUsd: transition.observedUsd,
      concurrencyHeld: transition.concurrencyHeld,
    });
    return candidate;
  }

  if (state.runBoundRevision === null) {
    fail("invalid-transition", "A cost observation requires an already bound original run.");
  }
  if (transition.continuationId !== null
    && !checkpoint.events.some(
      (event) => event.kind === "claim"
        && event.admissionId === transition.admissionId
        && event.continuationId === transition.continuationId,
    )) {
    fail("invalid-transition", "Cost observation references an unseen claim generation.");
  }
  if (replay.costs >= MAX_RECOVERY_COST_OBSERVATIONS) {
    fail("exhausted", "Cost-observation events are exhausted.");
  }
  if (checkpoint.events.some(
    (event) => event.kind === "observe-cost" && event.observationId === transition.observationId,
  )) {
    fail("conflict", "Cost observationId is already recorded with a different fact.");
  }
  events.push({
    revision: nextRevision,
    kind: "observe-cost",
    admissionId: transition.admissionId,
    continuationId: transition.continuationId,
    observationId: transition.observationId,
    observedUsd: transition.observedUsd,
    workerOverspend: transition.workerOverspend,
  });
  return candidate;
}

function encodeCheckpoint(checkpoint: unknown): string {
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
  initial: NativeHarnessAccountingV1Checkpoint,
  pins: OwnerPins,
  io: NativeFileIo,
  hook: NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"],
): NativeHarnessAccountingHandle;
function makeHandle(
  initial: NativeHarnessRecoveryAccountingCheckpoint,
  pins: OwnerPins,
  io: NativeFileIo,
  hook: NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"],
): NativeHarnessRecoveryAccountingHandle;
function makeHandle(
  initial: NativeHarnessAccountingAnyCheckpoint,
  pins: OwnerPins,
  io: NativeFileIo,
  hook: NativeHarnessAccountingTestOptions["testAfterPrimaryWrite"],
): NativeHarnessAccountingHandle | NativeHarnessRecoveryAccountingHandle {
  let checkpoint: NativeHarnessAccountingAnyCheckpoint = initial;
  const version = initial.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2 ? 2 : 1;
  let closed = false;
  let poisoned = false;

  const commit = async (
    expectedRevision: number,
    transitionText: string,
  ): Promise<NativeHarnessAccountingAnyCheckpoint> => {
    if (closed) fail("closed", "Accounting handle is closed.");
    if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail("invalid-input", "expectedRevision must be a nonnegative safe integer.");
    }
    if (expectedRevision !== checkpoint.revision) {
      fail("conflict", "Accounting handle revision is stale.");
    }
    const transition = version === 1
      ? parseTransitionText(transitionText)
      : parseRecoveryTransitionText(transitionText);
    await verifyPins(io, [pins.root, pins.namespace, pins.owner]);

    let writeAttempted = false;
    try {
      return await withWriteLock(pins.owner.path, async () => {
        if (closed) fail("closed", "Accounting handle is closed.");
        if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
        await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        const raw = await readPrimary(io, pins);
        const disk = decodeCheckpointText(raw, {
          ownerId: checkpoint.ownerId,
          selectorSha256: checkpoint.selectorSha256,
        });
        await verifyPins(io, [pins.root, pins.namespace, pins.owner]);
        if ((disk.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) !== (version === 2)) {
          fail("changed", "Accounting checkpoint schema changed across this handle.");
        }
        if (disk.revision !== expectedRevision) {
          fail("conflict", "Accounting checkpoint revision changed before commit.");
        }
        if (JSON.stringify(disk) !== JSON.stringify(checkpoint)) {
          fail("changed", "Accounting checkpoint no longer matches the complete handle snapshot at this revision.");
        }
        if (version === 2 && transition.action === "observeCost") {
          const existing = (disk as NativeHarnessRecoveryAccountingCheckpoint).events.find(
            (event) => event.kind === "observe-cost"
              && event.observationId === transition.observationId,
          );
          if (existing !== undefined) {
            if (existing.kind !== "observe-cost"
              || existing.admissionId !== transition.admissionId
              || existing.continuationId !== transition.continuationId
              || existing.observedUsd !== transition.observedUsd
              || existing.workerOverspend !== transition.workerOverspend) {
              fail("conflict", "Cost observationId is already recorded with a different fact.");
            }
            if (closed) fail("closed", "Accounting handle is closed.");
            if (poisoned) fail("ambiguous", "Accounting handle is poisoned by an ambiguous write.");
            return checkpoint;
          }
        }
        if (disk.revision >= Number.MAX_SAFE_INTEGER) {
          fail("exhausted", "Accounting checkpoint revision counter is exhausted.");
        }
        const nextRevision = disk.revision + 1;
        const candidate = version === 1
          ? applyTransition(
            disk as NativeHarnessAccountingV1Checkpoint,
            transition as ParsedTransition,
            nextRevision,
          )
          : applyTransitionV2(
            disk as NativeHarnessRecoveryAccountingCheckpoint,
            transition as ParsedRecoveryTransition,
            nextRevision,
          );
        const validated = version === 1
          ? readCheckpoint(candidate)
          : readCheckpointV2(candidate);
        projectAnyCheckpoint(validated);
        const encoded = encodeCheckpoint(validated);
        assertEncodedSize(encoded);
        if (version === 2) {
          assertRecoveryReservedBytes(
            Buffer.byteLength(encoded, "utf8"),
            validated as NativeHarnessRecoveryAccountingCheckpoint,
          );
        }
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
  }) as NativeHarnessAccountingHandle | NativeHarnessRecoveryAccountingHandle;
}

/**
 * Creates a genuinely fresh owner directory and initial revision-0 checkpoint.
 * The supplied limits text is used exactly; no policy defaults or second
 * normalization are applied. EEXIST refuses even for an empty owner directory.
 */
function createAccountingOwnerAtVersion(
  options: NativeHarnessAccountingCreateOptions,
  testOptions: NativeHarnessAccountingTestOptions | undefined,
  version: 1,
): Promise<NativeHarnessAccountingHandle>;
function createAccountingOwnerAtVersion(
  options: NativeHarnessAccountingCreateOptions,
  testOptions: NativeHarnessAccountingTestOptions | undefined,
  version: 2,
): Promise<NativeHarnessRecoveryAccountingHandle>;
async function createAccountingOwnerAtVersion(
  options: NativeHarnessAccountingCreateOptions,
  testOptions: NativeHarnessAccountingTestOptions | undefined,
  version: 1 | 2,
): Promise<NativeHarnessAccountingHandle | NativeHarnessRecoveryAccountingHandle> {
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

  const checkpoint: NativeHarnessAccountingAnyCheckpoint = version === 1
    ? readCheckpoint({
      schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA,
      revision: 0,
      ownerId: owned.ownerId,
      selectorSha256: owned.selectorSha256,
      createdAt: owned.createdAt,
      limits,
      budgetBlock: null,
      admissions: [],
    })
    : readCheckpointV2({
      schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
      revision: 0,
      ownerId: owned.ownerId,
      selectorSha256: owned.selectorSha256,
      createdAt: owned.createdAt,
      limits,
      budgetBlock: null,
      admissions: [],
      events: [],
    });
  projectAnyCheckpoint(checkpoint);
  const encoded = encodeCheckpoint(checkpoint);
  assertEncodedSize(encoded);
  if (version === 2) {
    assertRecoveryReservedBytes(
      Buffer.byteLength(encoded, "utf8"),
      checkpoint as NativeHarnessRecoveryAccountingCheckpoint,
    );
  }
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
  return checkpoint.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2
    ? makeHandle(checkpoint, pins, test.io, test.hook)
    : makeHandle(checkpoint, pins, test.io, test.hook);
}

/**
 * Creates a genuinely fresh V1 owner directory and initial revision-0
 * checkpoint. This default factory never creates or upgrades the V2
 * continuation schema.
 */
export async function createNativeHarnessAccountingOwner(
  options: NativeHarnessAccountingCreateOptions,
  testOptions?: NativeHarnessAccountingTestOptions,
): Promise<NativeHarnessAccountingHandle> {
  return await createAccountingOwnerAtVersion(options, testOptions, 1);
}

/**
 * Creates a genuinely fresh V2 owner using the same owner path, fresh-directory
 * refusal, pins, write lock, atomic writer and poisoning rules. It is an
 * explicit foundation only; it grants no recovery or dispatch authority and
 * performs no migration from an existing V1 owner.
 */
export async function createNativeHarnessRecoveryAccountingOwner(
  options: NativeHarnessAccountingCreateOptions,
  testOptions?: NativeHarnessAccountingTestOptions,
): Promise<NativeHarnessRecoveryAccountingHandle> {
  return await createAccountingOwnerAtVersion(options, testOptions, 2);
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
  const checkpoint = decodeCheckpointText(raw, {
    ownerId: owned.ownerId,
    selectorSha256: owned.selectorSha256,
  });
  await verifyPins(test.io, [pins.root, pins.namespace, pins.owner]);
  if (checkpoint.schema === NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
    return makeHandle(checkpoint, pins, test.io, test.hook);
  }
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
