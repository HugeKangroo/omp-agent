import { constants } from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  decodeRunHistoryText,
  decodeRunRecoveryOriginText,
  StoreCorruptionError,
  withWriteLock,
} from "../vendor/harness2/upstream/src/store.ts";
import {
  STAGE_IDS,
  type RunRecord,
  type RunRecoveryOrigin,
  type StageId,
} from "../vendor/harness2/upstream/src/types.ts";
import {
  captureWorkspaceText,
  deepFreeze,
  NativeFileError,
  nodeFileIo,
  sha256Hex,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "./native-work.ts";

/**
 * B1a storage leaf: bounded dispatch inventory for one actual recovery-origin
 * run. This module is storage, codec, CAS and append-only lifecycle data only.
 *
 * It does not create or admit a run, expose a recovery switch, mark anything
 * executable/recoverable, observe an OS process, or authorize a resume. The
 * caller supplies dispatch facts; storage cannot prove those facts came from
 * an actual StageRecord or that the caller owns the run. B1b owns the awaited
 * original Runner lifecycle sink and B1c owns original-backend creation.
 *
 * Creation and opening bind the exact actual run primary (`run.json`) in the
 * original run directory. Missing, corrupt, oversized, symlinked or
 * backup-only primaries are refused; no `.bak` or legacy sidecar is adopted,
 * repaired, re-minted or created by open. The sidecar is create-only.
 * Origin nonces, source hashes and file hashes are association evidence only;
 * they are not authenticated anti-rollback or proof against a local filesystem
 * adversary.
 *
 * The sidecar is capped at 32 dispatch rows and 256 KiB canonical UTF-8 + LF.
 * Admission reserves each open row's maximum legal terminal encoding, so
 * pathological paths reduce usable rows instead of making a legal transition
 * inherently unable to fit. Old rows are never truncated or recycled.
 *
 * innerDeadlineAt is stored exactly as the original actual value; execution
 * must gate at min(innerDeadlineAt, outerDeadlineAt), never rewrite the original
 * value to that minimum. requestTimeoutMs is the actual Controller request
 * timeout; prompt.effectiveTimeoutMs may only narrow it. No signal is persisted.
 *
 * Lifecycle facts are finite: intended -> launch-pending -> process-bound ->
 * prompt-pending -> terminal, with terminal observation allowed directly from
 * any earlier phase. Terminal is a tagged observation, not a claim that the
 * process stopped or that coverage is complete. An absent process association
 * remains unknown. No clock, PID, process-group or credential is verified here.
 *
 * The advance guard is the original execution signal/deadline check supplied by
 * the caller. It is invoked after every awaited lock/read/test hook and
 * immediately before a write. A synchronous guard that returns a Promise or
 * thenable is refused. Terminal finalization uses a separate cleanup guard and
 * deliberately does not re-apply the original live-execution guard.
 */

export const NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA =
  "omp-agent.native-harness-dispatch-inventory.v1";
export const NATIVE_HARNESS_DISPATCH_INVENTORY_FILE = "dispatch-inventory.json";
export const NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES = 256 * 1024;
export const NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES = 32;

const MAX_PATH_BYTES = 4096;
const MAX_RUNTIME_ROOT_BYTES = 1024;
/**
 * Conservative upper bound for the UTF-8 length of JSON encoding one finite
 * nonnegative ECMAScript number. Shortest round-trip decimal text is far
 * shorter than this for every finite nonnegative binary64 value; the longest
 * fixed form observed by the language algorithm is 24 bytes
 * (for example 0.0000010000000000000002). Fixed headroom keeps the storage
 * bound independent of the host's exact shortest-decimal implementation.
 */
const MAX_NUMERIC_JSON_BYTES = 32;
const TERMINAL_USAGE_COST_PROJECTION = Number.MAX_VALUE;
const TERMINAL_USAGE_COST_RESERVED_BYTES = MAX_NUMERIC_JSON_BYTES
  - Buffer.byteLength(JSON.stringify(TERMINAL_USAGE_COST_PROJECTION), "utf8");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

const INVENTORY_KEYS = ["schema", "revision", "runId", "origin", "fixed", "dispatches"] as const;
const FIXED_KEYS = ["stageTimeoutMs", "maxDurationMs", "maxCostUsd"] as const;
const ORIGIN_KEYS = [
  "createdAt",
  "nonce",
  "recordIdentitySha256",
  "runId",
  "schema",
  "seed",
] as const;
const SEED_KEYS = [
  "accountingOwnerId",
  "accountingOwnerRevision",
  "admissionId",
  "admittedAt",
  "allocatedCostUsd",
  "deadlineAt",
  "inputManifestSha256",
  "profile",
  "schema",
  "sourceAssociationSha256",
  "sourceDescriptorSha256",
] as const;
const ROW_BASE_KEYS = [
  "ordinal",
  "nonce",
  "runId",
  "runRevision",
  "stage",
  "attempt",
  "cwd",
  "artifactDir",
  "intentSha256",
  "snapshotSha256",
  "originNonce",
  "sourceAssociationSha256",
  "outerDeadlineAt",
  "innerDeadlineAt",
  "requestTimeoutMs",
  "stageAllocatedCostUsd",
  "state",
] as const;
const ROW_OPTIONAL_KEYS = ["launch", "process", "prompt", "terminal"] as const;
const INTENT_KEYS = [
  "ordinal",
  "nonce",
  "stage",
  "attempt",
  "runRevision",
  "cwd",
  "artifactDir",
  "intentSha256",
  "snapshotSha256",
  "innerDeadlineAt",
  "requestTimeoutMs",
  "stageAllocatedCostUsd",
] as const;
const LAUNCH_KEYS = ["runtimeRoot"] as const;
const PROCESS_KEYS = ["pid", "pgid", "identitySha256"] as const;
const PROMPT_KEYS = ["promptSha256", "effectiveTimeoutMs"] as const;
const TERMINAL_KEYS = [
  "outcome",
  "observationKind",
  "observedAt",
  "resultSha256",
  "usageCostUsd",
  "usageEstimated",
] as const;
const TEST_KEYS = ["fileIo", "testAfterPrimaryRead", "testAfterPrimaryWrite"] as const;
const CREATE_KEYS = ["storeRoot", "runId"] as const;
const OPEN_KEYS = ["storeRoot", "runId"] as const;

const TERMINAL_OUTCOMES = ["completed", "failed", "cancelled", "timed-out", "unknown"] as const;
const OBSERVATION_KINDS = ["runner-observation", "synthetic-fixture"] as const;
const DISPATCH_STATES = [
  "intended",
  "launch-pending",
  "process-bound",
  "prompt-pending",
  "terminal",
] as const;

export type NativeHarnessDispatchInventoryErrorCode =
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
  | "ambiguous"
  | "refused";

export class NativeHarnessDispatchInventoryError extends Error {
  override name = "NativeHarnessDispatchInventoryError";

  constructor(message: string, readonly code: NativeHarnessDispatchInventoryErrorCode) {
    super(message);
  }
}

export interface NativeHarnessDispatchInventoryFixed {
  readonly stageTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly maxCostUsd: number;
}

/**
 * Caller-owned immutable admission facts. The caller must copy attempt,
 * runRevision, cwd and artifactDir from the actual verified StageRecord;
 * WorkerRequest itself has no attempt and pathname parsing is not evidence.
 * requestTimeoutMs is the actual bounded Controller WorkerRequest timeout.
 * innerDeadlineAt is stored exactly as supplied; execution gates at
 * min(innerDeadlineAt, outerDeadlineAt) and must not rewrite it to that min.
 */
export interface NativeHarnessDispatchIntent {
  readonly ordinal: number;
  readonly nonce: string;
  readonly stage: StageId;
  readonly attempt: number;
  readonly runRevision: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly intentSha256: string;
  readonly snapshotSha256: string;
  readonly innerDeadlineAt: number;
  readonly requestTimeoutMs: number;
  readonly stageAllocatedCostUsd: number;
}

export interface NativeHarnessDispatchLaunch {
  readonly runtimeRoot: string;
}

export interface NativeHarnessDispatchProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly identitySha256: string;
}

export interface NativeHarnessDispatchPrompt {
  readonly promptSha256: string;
  readonly effectiveTimeoutMs: number;
}

export type NativeHarnessDispatchTerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];
export type NativeHarnessDispatchObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Tagged terminal observation. `outcome` alone is not a stopped/complete-
 * coverage claim, and `observationKind` is descriptive data rather than
 * authority. B1b must add actual bounded cleanup/drain/exit observations at
 * the awaited Runner sink; this storage-only B1a shape does not fabricate them.
 * A synthetic-fixture completion may omit all process facts and is never
 * evidence that an actual process ran or stopped. A runner-observation
 * completion requires the recorded launch/process/prompt chain.
 * outcome/resultSha256 never prove actual drain or stop. B1b must record a
 * bounded cleanupReceipt before deleting runtime/worker-owner; a missing
 * receipt stays unknown forever and old terminal rows are not retroactively
 * backfilled. This B1a shape intentionally adds no guessed OS/cleanup fields.
 */
export interface NativeHarnessDispatchTerminal {
  readonly outcome: NativeHarnessDispatchTerminalOutcome;
  readonly observationKind: NativeHarnessDispatchObservationKind;
  readonly observedAt: number;
  readonly resultSha256: string | null;
  readonly usageCostUsd: number | null;
  readonly usageEstimated: boolean;
}

export type NativeHarnessDispatchState = (typeof DISPATCH_STATES)[number];

export interface NativeHarnessDispatchRow {
  readonly ordinal: number;
  readonly nonce: string;
  readonly runId: string;
  readonly runRevision: number;
  readonly stage: StageId;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly intentSha256: string;
  readonly snapshotSha256: string;
  readonly originNonce: string;
  readonly sourceAssociationSha256: string;
  readonly outerDeadlineAt: number;
  readonly innerDeadlineAt: number;
  readonly requestTimeoutMs: number;
  readonly stageAllocatedCostUsd: number;
  readonly state: NativeHarnessDispatchState;
  readonly launch?: NativeHarnessDispatchLaunch;
  readonly process?: NativeHarnessDispatchProcess;
  readonly prompt?: NativeHarnessDispatchPrompt;
  readonly terminal?: NativeHarnessDispatchTerminal;
}

export interface NativeHarnessDispatchInventory {
  readonly schema: typeof NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA;
  readonly revision: number;
  readonly runId: string;
  readonly origin: RunRecoveryOrigin;
  readonly fixed: NativeHarnessDispatchInventoryFixed;
  readonly dispatches: readonly NativeHarnessDispatchRow[];
}

export interface NativeHarnessDispatchInventoryIdentity {
  readonly runId: string;
}

export interface NativeHarnessDispatchInventoryCreateOptions {
  /** Canonical actual RunStore root (controller.store.root, normally the runs directory), not outer descriptor.storeRoot. */
  readonly storeRoot: string;
  readonly runId: string;
}

export interface NativeHarnessDispatchInventoryOpenOptions {
  /** Canonical actual RunStore root (controller.store.root, normally the runs directory), not outer descriptor.storeRoot. */
  readonly storeRoot: string;
  readonly runId: string;
}

/**
 * Test-only seams. `testAfterPrimaryRead` runs after the bounded CAS read and
 * before a mutation is built; `testAfterPrimaryWrite` runs only after the
 * imported actual atomicWrite has returned. They cannot replace the writer or
 * fabricate persistence. Production callers pass none.
 */
export interface NativeHarnessDispatchInventoryTestOptions {
  readonly fileIo?: NativeFileIo;
  readonly testAfterPrimaryRead?: (event: {
    readonly path: string;
    readonly revision: number;
  }) => void | Promise<void>;
  readonly testAfterPrimaryWrite?: (event: {
    readonly path: string;
    readonly revision: number;
  }) => void | Promise<void>;
}

export interface NativeHarnessDispatchInventoryHandle {
  /** The last inventory owned by this handle, deeply frozen. */
  snapshot(): NativeHarnessDispatchInventory;
  /** Appends exactly the next intended row. */
  intend(intent: NativeHarnessDispatchIntent, advanceGuard: () => void): Promise<NativeHarnessDispatchInventory>;
  /**
   * Records awaited PRE-SPAWN launch-pending with the actual unique runtime
   * root. This does not mean spawn succeeded; process association is separate.
   */
  markLaunched(
    ordinal: number,
    nonce: string,
    runtimeRoot: string,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /** Associates the actual PID/PGID facts reported by the original Runner. */
  bindProcess(
    ordinal: number,
    nonce: string,
    process: NativeHarnessDispatchProcess,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /** Records the encoded prompt digest and, at most, a narrowed timeout. */
  markPromptPending(
    ordinal: number,
    nonce: string,
    prompt: NativeHarnessDispatchPrompt,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /**
   * Records the already registered dispatch's real cleanup/result observation.
   * The separate cleanup guard is not the original live-execution guard. This
   * cannot extend execution, refund budget, or grant a next dispatch.
   */
  finalize(
    ordinal: number,
    nonce: string,
    terminal: NativeHarnessDispatchTerminal,
    cleanupGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /** Invalidates this handle for later mutations; performs no I/O or deletion. */
  close(): void;
}

interface PinnedDirectory {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface InventoryPins {
  readonly root: PinnedDirectory;
  readonly run: PinnedDirectory;
  readonly primaryPath: string;
  readonly relativePrimaryPath: string;
}

interface ResolvedTestOptions {
  readonly io: NativeFileIo;
  readonly afterRead:
    | ((event: { readonly path: string; readonly revision: number }) => void | Promise<void>)
    | undefined;
  readonly afterWrite:
    | ((event: { readonly path: string; readonly revision: number }) => void | Promise<void>)
    | undefined;
}

interface GenesisFacts {
  readonly origin: RunRecoveryOrigin;
  readonly fixed: NativeHarnessDispatchInventoryFixed;
}

interface EncodedInventory {
  readonly inventory: NativeHarnessDispatchInventory;
  readonly encoded: string;
}

function fail(code: NativeHarnessDispatchInventoryErrorCode, message: string): never {
  throw new NativeHarnessDispatchInventoryError(message, code);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function readOwnedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode = "invalid-input",
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a plain data object.`);
  }
  const keys = Reflect.ownKeys(value);
  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      fail(code, `${label} has an unexpected symbol field.`);
    }
    if (!allowedKeys.includes(key)) {
      fail(code, `${label} has an unexpected field.`);
    }
    stringKeys.push(key);
  }
  for (const key of requiredKeys) {
    if (!stringKeys.includes(key)) fail(code, `${label} is missing a required field.`);
  }
  const owned: Record<string, unknown> = {};
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(code, `${label} must contain own data properties only.`);
    }
    owned[key] = descriptor.value;
  }
  return owned;
}

function readArray(value: unknown, label: string, code: NativeHarnessDispatchInventoryErrorCode): readonly unknown[] {
  if (!Array.isArray(value)) fail(code, `${label} must be an array.`);
  return value;
}

function readSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  code: NativeHarnessDispatchInventoryErrorCode,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail(code, `${label} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function readPositiveFinite(
  value: unknown,
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(code, `${label} must be a positive finite number.`);
  }
  return value;
}

function readSha256(
  value: unknown,
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode,
): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function readUuid(
  value: unknown,
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode,
): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    fail(code, `${label} must be a lowercase UUID.`);
  }
  return value;
}

function readRunId(
  value: unknown,
  code: NativeHarnessDispatchInventoryErrorCode,
): string {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    fail(code, "runId must be 1-128 ASCII letters, digits, underscores or hyphens.");
  }
  return value;
}

function readAbsolutePath(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || !path.isAbsolute(value)
    || CONTROL_PATTERN.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail("invalid-input", `${label} must be a bounded absolute path without control characters.`);
  }
  return value;
}

function readStageId(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): StageId {
  if (typeof value !== "string" || !(STAGE_IDS as readonly string[]).includes(value)) {
    fail(code, "stage is not a known Harness2 stage ID.");
  }
  return value as StageId;
}

function readFixed(
  value: unknown,
  code: NativeHarnessDispatchInventoryErrorCode,
): NativeHarnessDispatchInventoryFixed {
  const record = readOwnedRecord(value, FIXED_KEYS, FIXED_KEYS, "fixed inventory facts", code);
  const stageTimeoutMs = readSafeInteger(record.stageTimeoutMs, "fixed.stageTimeoutMs", 1, code);
  const maxDurationMs = readSafeInteger(record.maxDurationMs, "fixed.maxDurationMs", 1, code);
  const maxCostUsd = readPositiveFinite(record.maxCostUsd, "fixed.maxCostUsd", code);
  if (stageTimeoutMs > maxDurationMs) {
    fail(code, "fixed.stageTimeoutMs exceeds the original run duration.");
  }
  return Object.freeze({ stageTimeoutMs, maxDurationMs, maxCostUsd });
}

function mapDecodeError(error: unknown): never {
  if (error instanceof StoreCorruptionError) fail("corrupt", error.message);
  if (error instanceof RangeError) fail("too-large", error.message);
  throw error;
}

function readOriginValue(value: unknown, expectedRunId: string): RunRecoveryOrigin {
  const record = readOwnedRecord(value, ORIGIN_KEYS, ORIGIN_KEYS, "recovery origin", "corrupt");
  let decoded: RunRecoveryOrigin;
  try {
    decoded = decodeRunRecoveryOriginText(JSON.stringify(record), expectedRunId);
  } catch (error) {
    mapDecodeError(error);
  }
  return decoded;
}

function sameOrigin(left: RunRecoveryOrigin, right: RunRecoveryOrigin): boolean {
  return left.schema === right.schema
    && left.nonce === right.nonce
    && left.runId === right.runId
    && left.createdAt === right.createdAt
    && left.recordIdentitySha256 === right.recordIdentitySha256
    && SEED_KEYS.every((key) => left.seed[key] === right.seed[key]);
}

function sameFixed(
  left: NativeHarnessDispatchInventoryFixed,
  right: NativeHarnessDispatchInventoryFixed,
): boolean {
  return left.stageTimeoutMs === right.stageTimeoutMs
    && left.maxDurationMs === right.maxDurationMs
    && left.maxCostUsd === right.maxCostUsd;
}

function readLaunch(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchLaunch {
  const record = readOwnedRecord(value, LAUNCH_KEYS, LAUNCH_KEYS, "launch fact", code);
  const runtimeRoot = typeof record.runtimeRoot === "string"
    && record.runtimeRoot.length > 0
    && path.isAbsolute(record.runtimeRoot)
    && !CONTROL_PATTERN.test(record.runtimeRoot)
    && Buffer.byteLength(record.runtimeRoot, "utf8") <= MAX_RUNTIME_ROOT_BYTES
    ? record.runtimeRoot
    : fail(code, "launch.runtimeRoot must be a bounded absolute path.");
  return Object.freeze({ runtimeRoot });
}

function readProcessValue(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchProcess {
  const record = readOwnedRecord(value, PROCESS_KEYS, PROCESS_KEYS, "process fact", code);
  const pid = readSafeInteger(record.pid, "process.pid", 1, code);
  const pgid = readSafeInteger(record.pgid, "process.pgid", 1, code);
  const identitySha256 = readSha256(record.identitySha256, "process.identitySha256", code);
  return Object.freeze({ pid, pgid, identitySha256 });
}

function readPromptValue(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchPrompt {
  const record = readOwnedRecord(value, PROMPT_KEYS, PROMPT_KEYS, "prompt fact", code);
  const promptSha256 = readSha256(record.promptSha256, "prompt.promptSha256", code);
  const effectiveTimeoutMs = readSafeInteger(record.effectiveTimeoutMs, "prompt.effectiveTimeoutMs", 1, code);
  return Object.freeze({ promptSha256, effectiveTimeoutMs });
}

function readTerminalValue(
  value: unknown,
  code: NativeHarnessDispatchInventoryErrorCode,
): NativeHarnessDispatchTerminal {
  const record = readOwnedRecord(value, TERMINAL_KEYS, TERMINAL_KEYS, "terminal observation", code);
  const outcomeValue = record.outcome;
  if (
    typeof outcomeValue !== "string"
    || !(TERMINAL_OUTCOMES as readonly string[]).includes(outcomeValue)
  ) {
    fail(code, "terminal.outcome is not a bounded observation outcome.");
  }
  const observationValue = record.observationKind;
  if (
    typeof observationValue !== "string"
    || !(OBSERVATION_KINDS as readonly string[]).includes(observationValue)
  ) {
    fail(code, "terminal.observationKind is not a bounded observation tag.");
  }
  const observedAt = readSafeInteger(record.observedAt, "terminal.observedAt", 0, code);
  const resultValue = record.resultSha256;
  const resultSha256 = resultValue === null ? null : readSha256(resultValue, "terminal.resultSha256", code);
  const usageValue = record.usageCostUsd;
  let usageCostUsd: number | null;
  if (usageValue === null) usageCostUsd = null;
  else if (typeof usageValue === "number" && Number.isFinite(usageValue) && usageValue >= 0) usageCostUsd = usageValue;
  else fail(code, "terminal.usageCostUsd must be null or a finite nonnegative number.");
  if (typeof record.usageEstimated !== "boolean") {
    fail(code, "terminal.usageEstimated must be a boolean observation.");
  }
  return Object.freeze({
    outcome: outcomeValue as NativeHarnessDispatchTerminalOutcome,
    observationKind: observationValue as NativeHarnessDispatchObservationKind,
    observedAt,
    resultSha256,
    usageCostUsd,
    usageEstimated: record.usageEstimated,
  });
}

function readIntentValue(value: unknown): NativeHarnessDispatchIntent {
  const record = readOwnedRecord(value, INTENT_KEYS, INTENT_KEYS, "dispatch intent");
  const ordinal = readSafeInteger(record.ordinal, "intent.ordinal", 1, "invalid-input");
  const nonce = readUuid(record.nonce, "intent.nonce", "invalid-input");
  const stage = readStageId(record.stage, "invalid-input");
  const attempt = readSafeInteger(record.attempt, "intent.attempt", 1, "invalid-input");
  const runRevision = readSafeInteger(record.runRevision, "intent.runRevision", 0, "invalid-input");
  const cwd = readAbsolutePath(record.cwd, "intent.cwd", MAX_PATH_BYTES);
  const artifactDir = readAbsolutePath(record.artifactDir, "intent.artifactDir", MAX_PATH_BYTES);
  const intentSha256 = readSha256(record.intentSha256, "intent.intentSha256", "invalid-input");
  const snapshotSha256 = readSha256(record.snapshotSha256, "intent.snapshotSha256", "invalid-input");
  const innerDeadlineAt = readSafeInteger(record.innerDeadlineAt, "intent.innerDeadlineAt", 1, "invalid-input");
  const requestTimeoutMs = readSafeInteger(record.requestTimeoutMs, "intent.requestTimeoutMs", 1, "invalid-input");
  const stageAllocatedCostUsd = readPositiveFinite(
    record.stageAllocatedCostUsd,
    "intent.stageAllocatedCostUsd",
    "invalid-input",
  );
  return Object.freeze({
    ordinal,
    nonce,
    stage,
    attempt,
    runRevision,
    cwd,
    artifactDir,
    intentSha256,
    snapshotSha256,
    innerDeadlineAt,
    requestTimeoutMs,
    stageAllocatedCostUsd,
  });
}

function readOrdinal(value: unknown): number {
  return readSafeInteger(value, "ordinal", 1, "invalid-input");
}

function readNonce(value: unknown): string {
  return readUuid(value, "nonce", "invalid-input");
}

function readGuard(value: unknown, label: string): () => void {
  if (typeof value !== "function") {
    fail("invalid-input", `${label} must be a synchronous function.`);
  }
  return value as () => void;
}

const ACTUAL_PROMISE_THEN = (() => {
  try {
    return Promise.prototype.then;
  } catch {
    return null;
  }
})();

function observeNativePromiseSettlement(value: unknown): boolean {
  if (ACTUAL_PROMISE_THEN === null) return false;
  try {
    // Native then brand-checks the receiver. A real Promise gets two handlers
    // attached solely to consume a possible rejection; an arbitrary thenable
    // throws here and is never assimilated or invoked.
    Reflect.apply(ACTUAL_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { readonly then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function runGuard(guard: () => void, label: string): void {
  let returned: unknown;
  try {
    returned = guard();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "guard refused";
    fail("refused", `${label} refused this storage operation: ${detail}`);
  }
  // Brand-check through the intrinsic first so masked native Promises are
  // refused and rejected native Promises are observed, not left unhandled.
  if (observeNativePromiseSettlement(returned)) {
    fail("invalid-input", `${label} returned a Promise; async guards are refused.`);
  }
  if (isThenable(returned)) {
    fail("invalid-input", `${label} returned a thenable; async guards are refused.`);
  }
}

function baseRowFacts(
  row: NativeHarnessDispatchRow,
): Omit<NativeHarnessDispatchRow, "state" | "launch" | "process" | "prompt" | "terminal"> {
  return {
    ordinal: row.ordinal,
    nonce: row.nonce,
    runId: row.runId,
    runRevision: row.runRevision,
    stage: row.stage,
    attempt: row.attempt,
    cwd: row.cwd,
    artifactDir: row.artifactDir,
    intentSha256: row.intentSha256,
    snapshotSha256: row.snapshotSha256,
    originNonce: row.originNonce,
    sourceAssociationSha256: row.sourceAssociationSha256,
    outerDeadlineAt: row.outerDeadlineAt,
    innerDeadlineAt: row.innerDeadlineAt,
    requestTimeoutMs: row.requestTimeoutMs,
    stageAllocatedCostUsd: row.stageAllocatedCostUsd,
  };
}

function buildRow(
  base: Omit<NativeHarnessDispatchRow, "state" | "launch" | "process" | "prompt" | "terminal">,
  state: NativeHarnessDispatchState,
  additions: {
    readonly launch?: NativeHarnessDispatchLaunch;
    readonly process?: NativeHarnessDispatchProcess;
    readonly prompt?: NativeHarnessDispatchPrompt;
    readonly terminal?: NativeHarnessDispatchTerminal;
  } = {},
): NativeHarnessDispatchRow {
  return Object.freeze({
    ordinal: base.ordinal,
    nonce: base.nonce,
    runId: base.runId,
    runRevision: base.runRevision,
    stage: base.stage,
    attempt: base.attempt,
    cwd: base.cwd,
    artifactDir: base.artifactDir,
    intentSha256: base.intentSha256,
    snapshotSha256: base.snapshotSha256,
    originNonce: base.originNonce,
    sourceAssociationSha256: base.sourceAssociationSha256,
    outerDeadlineAt: base.outerDeadlineAt,
    innerDeadlineAt: base.innerDeadlineAt,
    requestTimeoutMs: base.requestTimeoutMs,
    stageAllocatedCostUsd: base.stageAllocatedCostUsd,
    state,
    ...(additions.launch === undefined ? {} : { launch: additions.launch }),
    ...(additions.process === undefined ? {} : { process: additions.process }),
    ...(additions.prompt === undefined ? {} : { prompt: additions.prompt }),
    ...(additions.terminal === undefined ? {} : { terminal: additions.terminal }),
  });
}

function buildInventory(
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
  runId: string,
  revision: number,
  dispatches: readonly NativeHarnessDispatchRow[],
): NativeHarnessDispatchInventory {
  return deepFreeze({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
    revision,
    runId,
    origin,
    fixed,
    dispatches: dispatches.map((row) => deepFreeze(row)),
  });
}

function encodeInventory(inventory: NativeHarnessDispatchInventory): string {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

/**
 * Maximum legal terminal encoding projection for one nonterminal row.
 * runtimeRoot uses the maximum raw path length in backslashes, which JSON
 * escapes to the longest possible path form. Numeric fields whose legal
 * domain is a safe integer use the safe-integer maximum. usageCostUsd is the
 * only arbitrary finite nonnegative number; its field is represented by
 * Number.MAX_VALUE here, and the caller adds the documented numeric encoding
 * allowance for every open row. This is an internal size projection, not a
 * persisted row or a process claim.
 */
function worstCaseTerminalRow(
  row: NativeHarnessDispatchRow,
): NativeHarnessDispatchRow {
  const launch: NativeHarnessDispatchLaunch = Object.freeze({
    runtimeRoot: `/${"\\".repeat(MAX_RUNTIME_ROOT_BYTES - 1)}`,
  });
  const process: NativeHarnessDispatchProcess = Object.freeze({
    pid: Number.MAX_SAFE_INTEGER,
    pgid: Number.MAX_SAFE_INTEGER,
    identitySha256: "f".repeat(64),
  });
  const prompt: NativeHarnessDispatchPrompt = Object.freeze({
    promptSha256: "f".repeat(64),
    effectiveTimeoutMs: row.requestTimeoutMs,
  });
  const terminal: NativeHarnessDispatchTerminal = Object.freeze({
    outcome: "completed",
    observationKind: "runner-observation",
    observedAt: Number.MAX_SAFE_INTEGER,
    resultSha256: "f".repeat(64),
    usageCostUsd: TERMINAL_USAGE_COST_PROJECTION,
    usageEstimated: false,
  });
  return buildRow(baseRowFacts(row), "terminal", { launch, process, prompt, terminal });
}

function assertCapacity(inventory: NativeHarnessDispatchInventory): void {
  if (inventory.dispatches.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const bytes = Buffer.byteLength(encodeInventory(inventory), "utf8");
  if (bytes > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES) {
    fail("too-large", `Dispatch inventory exceeds ${NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES} bytes.`);
  }
  // Re-encode the whole inventory with every open row at its maximum legal
  // terminal encoding and with the widest legal revision. The fixed numeric
  // allowance covers the longest JSON number text that Number.MAX_VALUE does
  // not itself demonstrate (usageEstimated false and the 16-digit revision are
  // already in the projection). Already-written launch/process/prompt fields
  // are replaced by that projection, never counted a second time; terminal
  // rows remain exact.
  const openRows = inventory.dispatches.filter((row) => row.state !== "terminal").length;
  const projected = buildInventory(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    Number.MAX_SAFE_INTEGER,
    inventory.dispatches.map((row) =>
      row.state === "terminal" ? row : worstCaseTerminalRow(row)),
  );
  const projectedBytes = Buffer.byteLength(encodeInventory(projected), "utf8")
    + openRows * TERMINAL_USAGE_COST_RESERVED_BYTES;
  if (projectedBytes > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES) {
    fail(
      "too-large",
      "Dispatch inventory lacks bounded completion capacity; reduce path/row size before admitting another dispatch.",
    );
  }
}

function originalInnerDeadlineBound(
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
  code: NativeHarnessDispatchInventoryErrorCode,
): { readonly createdAt: number; readonly upper: number } {
  const createdAt = Date.parse(origin.createdAt);
  const upper = createdAt + fixed.maxDurationMs;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(upper)) {
    fail(code, "Original createdAt/duration cannot bound the actual inner deadline.");
  }
  return Object.freeze({ createdAt, upper });
}

function encodeAndValidate(
  inventory: NativeHarnessDispatchInventory,
  runId: string,
): EncodedInventory {
  const encoded = encodeInventory(inventory);
  const validated = decodeNativeHarnessDispatchInventoryText(encoded, { runId });
  return { inventory: validated, encoded };
}

function readRows(
  value: unknown,
  runId: string,
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
): readonly NativeHarnessDispatchRow[] {
  const rawRows = readArray(value, "dispatches", "corrupt");
  if (rawRows.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const allowedKeys = [...ROW_BASE_KEYS, ...ROW_OPTIONAL_KEYS];
  const deadlineBound = originalInnerDeadlineBound(origin, fixed, "corrupt");
  const nonces = new Set<string>();
  const runtimeRoots = new Set<string>();
  const rows: NativeHarnessDispatchRow[] = [];
  for (const [index, rawRow] of rawRows.entries()) {
    const record = readOwnedRecord(rawRow, allowedKeys, ROW_BASE_KEYS, `dispatch row ${index + 1}`, "corrupt");
    const ordinal = readSafeInteger(record.ordinal, "row.ordinal", 1, "corrupt");
    if (ordinal !== index + 1) {
      fail("corrupt", "Dispatch ordinals must be contiguous and append-only.");
    }
    const nonce = readUuid(record.nonce, "row.nonce", "corrupt");
    if (nonces.has(nonce)) fail("corrupt", "Dispatch nonce is not unique.");
    nonces.add(nonce);
    const rowRunId = readRunId(record.runId, "corrupt");
    if (rowRunId !== runId) fail("identity-mismatch", "Dispatch row belongs to a different run.");
    const runRevision = readSafeInteger(record.runRevision, "row.runRevision", 0, "corrupt");
    const stage = readStageId(record.stage, "corrupt");
    const attempt = readSafeInteger(record.attempt, "row.attempt", 1, "corrupt");
    const cwd = readAbsolutePath(record.cwd, "row.cwd", MAX_PATH_BYTES);
    const artifactDir = readAbsolutePath(record.artifactDir, "row.artifactDir", MAX_PATH_BYTES);
    const intentSha256 = readSha256(record.intentSha256, "row.intentSha256", "corrupt");
    const snapshotSha256 = readSha256(record.snapshotSha256, "row.snapshotSha256", "corrupt");
    const originNonce = readUuid(record.originNonce, "row.originNonce", "corrupt");
    if (originNonce !== origin.nonce) fail("corrupt", "Dispatch row origin nonce does not match genesis.");
    const sourceAssociationSha256 = readSha256(
      record.sourceAssociationSha256,
      "row.sourceAssociationSha256",
      "corrupt",
    );
    if (sourceAssociationSha256 !== origin.seed.sourceAssociationSha256) {
      fail("corrupt", "Dispatch row source association does not match genesis.");
    }
    const outerDeadlineAt = readSafeInteger(record.outerDeadlineAt, "row.outerDeadlineAt", 1, "corrupt");
    if (outerDeadlineAt !== origin.seed.deadlineAt) {
      fail("corrupt", "Dispatch row outer deadline does not match the original admission.");
    }
    const innerDeadlineAt = readSafeInteger(record.innerDeadlineAt, "row.innerDeadlineAt", 1, "corrupt");
    if (innerDeadlineAt <= deadlineBound.createdAt || innerDeadlineAt > deadlineBound.upper) {
      fail("corrupt", "Dispatch row inner deadline is outside the original createdAt/duration bound.");
    }
    const requestTimeoutMs = readSafeInteger(record.requestTimeoutMs, "row.requestTimeoutMs", 1, "corrupt");
    if (requestTimeoutMs > fixed.stageTimeoutMs) {
      fail("corrupt", "Dispatch request timeout exceeds the original stage timeout.");
    }
    const stageAllocatedCostUsd = readPositiveFinite(
      record.stageAllocatedCostUsd,
      "row.stageAllocatedCostUsd",
      "corrupt",
    );
    if (stageAllocatedCostUsd > origin.seed.allocatedCostUsd) {
      fail("corrupt", "Dispatch row allocation exceeds the original run allocation.");
    }
    const stateValue = record.state;
    if (
      typeof stateValue !== "string"
      || !(DISPATCH_STATES as readonly string[]).includes(stateValue)
    ) {
      fail("corrupt", "Dispatch row state is not a bounded lifecycle state.");
    }
    const state = stateValue as NativeHarnessDispatchState;
    const hasLaunch = Object.hasOwn(record, "launch");
    const hasProcess = Object.hasOwn(record, "process");
    const hasPrompt = Object.hasOwn(record, "prompt");
    const hasTerminal = Object.hasOwn(record, "terminal");
    const launch = hasLaunch ? readLaunch(record.launch, "corrupt") : undefined;
    const process = hasProcess ? readProcessValue(record.process, "corrupt") : undefined;
    const prompt = hasPrompt ? readPromptValue(record.prompt, "corrupt") : undefined;
    const terminal = hasTerminal ? readTerminalValue(record.terminal, "corrupt") : undefined;
    if (process !== undefined && launch === undefined) {
      fail("corrupt", "Dispatch process association is present without launch-pending.");
    }
    if (prompt !== undefined && process === undefined) {
      fail("corrupt", "Dispatch prompt fact is present without process association.");
    }
    if (prompt !== undefined && prompt.effectiveTimeoutMs > requestTimeoutMs) {
      fail("corrupt", "Dispatch effective timeout is not a narrowing of the actual request timeout.");
    }
    if (launch !== undefined) {
      if (runtimeRoots.has(launch.runtimeRoot)) fail("corrupt", "Dispatch runtime root is not unique.");
      runtimeRoots.add(launch.runtimeRoot);
    }
    if (state === "terminal") {
      if (terminal === undefined) {
        fail("corrupt", "Terminal dispatch row has an inconsistent observation shape.");
      }
      if (
        terminal.outcome === "completed"
        && terminal.observationKind === "runner-observation"
        && (launch === undefined || process === undefined || prompt === undefined)
      ) {
        fail("corrupt", "A runner-observation completion requires the recorded launch/process/prompt chain.");
      }
    } else if (terminal !== undefined) {
      fail("corrupt", "Non-terminal dispatch row contains a terminal observation.");
    }
    if (state === "intended" && (hasLaunch || hasProcess || hasPrompt)) {
      fail("corrupt", "Intended dispatch row contains later lifecycle facts.");
    }
    if (state === "launch-pending" && (launch === undefined || hasProcess || hasPrompt)) {
      fail("corrupt", "Launch-pending dispatch row has an inconsistent lifecycle shape.");
    }
    if (state === "process-bound" && (launch === undefined || process === undefined || hasPrompt)) {
      fail("corrupt", "Process-bound dispatch row has an inconsistent lifecycle shape.");
    }
    if (
      state === "prompt-pending"
      && (launch === undefined || process === undefined || prompt === undefined)
    ) {
      fail("corrupt", "Prompt-pending dispatch row has an inconsistent lifecycle shape.");
    }
    rows.push(buildRow({
      ordinal,
      nonce,
      runId: rowRunId,
      runRevision,
      stage,
      attempt,
      cwd,
      artifactDir,
      intentSha256,
      snapshotSha256,
      originNonce,
      sourceAssociationSha256,
      outerDeadlineAt,
      innerDeadlineAt,
      requestTimeoutMs,
      stageAllocatedCostUsd,
    }, state, {
      ...(launch === undefined ? {} : { launch }),
      ...(process === undefined ? {} : { process }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(terminal === undefined ? {} : { terminal }),
    }));
  }
  return Object.freeze(rows);
}

/**
 * Pure bounded decoder for one already-read inventory text. It checks shape,
 * limits, append-only ordinals, immutable associations, lifecycle consistency
 * and reserved completion capacity. It cannot verify the actual run primary or
 * the caller's truthfulness; create/open perform the run binding separately.
 */
export function decodeNativeHarnessDispatchInventoryText(
  raw: string,
  expected: NativeHarnessDispatchInventoryIdentity,
): NativeHarnessDispatchInventory {
  if (typeof raw !== "string") fail("corrupt", "Dispatch inventory must be UTF-8 text.");
  const expectedRunId = readRunId(expected?.runId, "invalid-input");
  if (Buffer.byteLength(raw, "utf8") > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES) {
    fail("too-large", `Dispatch inventory exceeds ${NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES} bytes.`);
  }
  if (raw.length === 0 || !raw.endsWith("\n")) {
    fail("corrupt", "Dispatch inventory is empty or missing its final LF. No fallback was applied.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", "Dispatch inventory is not valid JSON. No fallback was applied.");
  }
  const record = readOwnedRecord(parsed, INVENTORY_KEYS, INVENTORY_KEYS, "dispatch inventory", "corrupt");
  if (record.schema !== NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA) {
    fail("corrupt", "Dispatch inventory schema is not recognized.");
  }
  const revision = readSafeInteger(record.revision, "inventory.revision", 0, "corrupt");
  const runId = readRunId(record.runId, "corrupt");
  if (runId !== expectedRunId) {
    fail("identity-mismatch", "Dispatch inventory belongs to a different run.");
  }
  const origin = readOriginValue(record.origin, runId);
  const fixed = readFixed(record.fixed, "corrupt");
  const dispatches = readRows(record.dispatches, runId, origin, fixed);
  const inventory = buildInventory(origin, fixed, runId, revision, dispatches);
  assertCapacity(inventory);
  return inventory;
}

function pinExistingDirectory(io: NativeFileIo, directory: string): Promise<PinnedDirectory> {
  return (async () => {
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
  })();
}

async function verifyPins(io: NativeFileIo, pins: readonly PinnedDirectory[]): Promise<void> {
  for (const pin of pins) {
    let current: PinnedDirectory;
    try {
      current = await pinExistingDirectory(io, pin.path);
    } catch (error) {
      if (error instanceof NativeHarnessDispatchInventoryError) {
        fail("changed", `Pinned directory changed before this operation: ${error.message}`);
      }
      throw error;
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
      return info;
    },
    open: async (target, flags): Promise<NativeFileHandle> => {
      const handle = await io.open(target, flags | nonBlocking);
      return {
        stat: (options) => handle.stat(options),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
}

function mapNativeFileError(error: NativeFileError): NativeHarnessDispatchInventoryError {
  const code: NativeHarnessDispatchInventoryErrorCode =
    error.code === "missing" ? "unavailable"
      : error.code === "too-large" ? "too-large"
        : error.code === "unsafe-path" ? "unsafe-path"
          : error.code === "non-text" ? "corrupt"
            : error.code === "changed" ? "changed"
              : "invalid-input";
  return new NativeHarnessDispatchInventoryError(error.message, code);
}

async function captureBoundedText(
  io: NativeFileIo,
  root: string,
  relativePath: string,
  pins: readonly PinnedDirectory[],
) {
  const boundedIo = withBoundedPinnedIo(io, pins);
  try {
    return await captureWorkspaceText(root, relativePath, boundedIo);
  } catch (error) {
    if (error instanceof NativeHarnessDispatchInventoryError) throw error;
    if (error instanceof NativeFileError) throw mapNativeFileError(error);
    throw error;
  }
}

async function pinInventory(
  io: NativeFileIo,
  storeRoot: string,
  runId: string,
): Promise<InventoryPins> {
  const root = await pinExistingDirectory(io, storeRoot);
  const runPath = path.join(storeRoot, runId);
  if (path.basename(runPath) !== runId) {
    fail("identity-mismatch", "Run directory does not match the requested run ID.");
  }
  const run = await pinExistingDirectory(io, runPath);
  await verifyPins(io, [root, run]);
  return Object.freeze({
    root,
    run,
    primaryPath: path.join(runPath, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE),
    relativePrimaryPath: NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  });
}

function readGenesisFacts(record: RunRecord, expectedRunId: string): GenesisFacts {
  if (record.id !== expectedRunId) {
    fail("identity-mismatch", "Actual run record does not match the requested run ID.");
  }
  if (record.recoveryOrigin === undefined) {
    fail("identity-mismatch", "Actual run has no recovery origin; dispatch inventory cannot be bound.");
  }
  const origin = readOriginValue(record.recoveryOrigin, expectedRunId);
  const config = record.config;
  const fixed = readFixed({
    stageTimeoutMs: config.stageTimeoutMs,
    maxDurationMs: config.maxDurationMs,
    maxCostUsd: config.maxCostUsd,
  }, "corrupt");
  if (fixed.maxCostUsd !== origin.seed.allocatedCostUsd) {
    fail("identity-mismatch", "Actual run allocation does not match its recovery origin.");
  }
  return Object.freeze({ origin, fixed });
}

async function readRunGenesis(
  io: NativeFileIo,
  pins: InventoryPins,
  runId: string,
): Promise<GenesisFacts> {
  const snapshot = await captureBoundedText(io, pins.run.path, "run.json", [pins.root, pins.run]);
  let record: RunRecord;
  try {
    record = decodeRunHistoryText(snapshot.text, runId);
  } catch (error) {
    mapDecodeError(error);
  }
  return readGenesisFacts(record, runId);
}

async function readInventoryPrimary(
  io: NativeFileIo,
  pins: InventoryPins,
  runId: string,
): Promise<{ readonly inventory: NativeHarnessDispatchInventory; readonly sha256: string }> {
  const snapshot = await captureBoundedText(
    io,
    pins.run.path,
    pins.relativePrimaryPath,
    [pins.root, pins.run],
  );
  const inventory = decodeNativeHarnessDispatchInventoryText(snapshot.text, { runId });
  return Object.freeze({ inventory, sha256: snapshot.file.sha256 });
}

function readTestOptions(value: unknown): ResolvedTestOptions {
  if (value === undefined) return { io: nodeFileIo, afterRead: undefined, afterWrite: undefined };
  const record = readOwnedRecord(value, TEST_KEYS, [], "test options");
  const io = record.fileIo === undefined ? nodeFileIo : record.fileIo;
  if (
    io === null
    || typeof io !== "object"
    || typeof (io as NativeFileIo).realpath !== "function"
    || typeof (io as NativeFileIo).lstat !== "function"
    || typeof (io as NativeFileIo).open !== "function"
  ) {
    fail("invalid-input", "test fileIo is not a native file IO seam.");
  }
  const afterRead = record.testAfterPrimaryRead;
  const afterWrite = record.testAfterPrimaryWrite;
  if (afterRead !== undefined && typeof afterRead !== "function") {
    fail("invalid-input", "testAfterPrimaryRead must be a function.");
  }
  if (afterWrite !== undefined && typeof afterWrite !== "function") {
    fail("invalid-input", "testAfterPrimaryWrite must be a function.");
  }
  return {
    io: io as NativeFileIo,
    afterRead: afterRead as ResolvedTestOptions["afterRead"],
    afterWrite: afterWrite as ResolvedTestOptions["afterWrite"],
  };
}

function readLocation(
  value: unknown,
  keys: readonly string[],
  label: string,
): { readonly storeRoot: string; readonly runId: string } {
  const record = readOwnedRecord(value, keys, keys, label);
  const storeRoot = readAbsolutePath(record.storeRoot, "storeRoot", MAX_PATH_BYTES);
  const runId = readRunId(record.runId, "invalid-input");
  return Object.freeze({ storeRoot, runId });
}

async function assertFreshInventory(io: NativeFileIo, primaryPath: string): Promise<void> {
  for (const candidate of [primaryPath, `${primaryPath}.bak`]) {
    try {
      await io.lstat(candidate, { bigint: true });
      fail("conflict", "Dispatch inventory path already exists; creation is create-only.");
    } catch (error) {
      if (error instanceof NativeHarnessDispatchInventoryError) throw error;
      if (!isErrno(error, "ENOENT")) fail("unavailable", "Dispatch inventory path could not be inspected.");
    }
  }
}

function nextRevision(inventory: NativeHarnessDispatchInventory): number {
  if (inventory.revision >= Number.MAX_SAFE_INTEGER) {
    fail("exhausted", "Dispatch inventory revision counter is exhausted.");
  }
  return inventory.revision + 1;
}

function applyIntent(
  inventory: NativeHarnessDispatchInventory,
  intent: NativeHarnessDispatchIntent,
): NativeHarnessDispatchInventory {
  if (inventory.dispatches.length >= NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory row limit is exhausted.");
  }
  if (intent.ordinal !== inventory.dispatches.length + 1) {
    fail("invalid-transition", "Dispatch ordinal is not the next append-only ordinal.");
  }
  if (inventory.dispatches.some((row) => row.nonce === intent.nonce)) {
    fail("conflict", "Dispatch nonce already exists.");
  }
  const deadlineBound = originalInnerDeadlineBound(inventory.origin, inventory.fixed, "corrupt");
  if (intent.innerDeadlineAt <= deadlineBound.createdAt || intent.innerDeadlineAt > deadlineBound.upper) {
    fail("invalid-input", "Dispatch inner deadline is outside the original createdAt/duration bound.");
  }
  if (intent.requestTimeoutMs > inventory.fixed.stageTimeoutMs) {
    fail("invalid-input", "Dispatch request timeout exceeds the original stage timeout.");
  }
  if (intent.stageAllocatedCostUsd > inventory.origin.seed.allocatedCostUsd) {
    fail("invalid-input", "Dispatch allocation exceeds the original run allocation.");
  }
  const row = buildRow({
    ordinal: intent.ordinal,
    nonce: intent.nonce,
    runId: inventory.runId,
    runRevision: intent.runRevision,
    stage: intent.stage,
    attempt: intent.attempt,
    cwd: intent.cwd,
    artifactDir: intent.artifactDir,
    intentSha256: intent.intentSha256,
    snapshotSha256: intent.snapshotSha256,
    originNonce: inventory.origin.nonce,
    sourceAssociationSha256: inventory.origin.seed.sourceAssociationSha256,
    outerDeadlineAt: inventory.origin.seed.deadlineAt,
    innerDeadlineAt: intent.innerDeadlineAt,
    requestTimeoutMs: intent.requestTimeoutMs,
    stageAllocatedCostUsd: intent.stageAllocatedCostUsd,
  }, "intended");
  return buildInventory(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    nextRevision(inventory),
    [...inventory.dispatches, row],
  );
}

function requireRow(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  nonce: string,
): NativeHarnessDispatchRow {
  const row = inventory.dispatches[ordinal - 1];
  if (row === undefined || row.ordinal !== ordinal) {
    fail("invalid-transition", "Dispatch row does not exist at this ordinal.");
  }
  if (row.nonce !== nonce) {
    fail("conflict", "Dispatch nonce does not match the registered row.");
  }
  return row;
}

function applyLaunch(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  nonce: string,
  runtimeRoot: string,
): NativeHarnessDispatchInventory {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "intended") {
    fail("invalid-transition", "Launch-pending requires an intended dispatch.");
  }
  if (inventory.dispatches.some((candidate) => candidate.launch?.runtimeRoot === runtimeRoot)) {
    fail("conflict", "Dispatch runtime root is not unique.");
  }
  const next = buildRow(baseRowFacts(row), "launch-pending", {
    launch: Object.freeze({ runtimeRoot }),
  });
  return replaceRow(inventory, ordinal, next);
}

function applyProcess(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  nonce: string,
  process: NativeHarnessDispatchProcess,
): NativeHarnessDispatchInventory {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "launch-pending" || row.launch === undefined) {
    fail("invalid-transition", "Process association requires a launch-pending dispatch.");
  }
  const next = buildRow(baseRowFacts(row), "process-bound", { launch: row.launch, process });
  return replaceRow(inventory, ordinal, next);
}

function applyPrompt(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  nonce: string,
  prompt: NativeHarnessDispatchPrompt,
): NativeHarnessDispatchInventory {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "process-bound" || row.launch === undefined || row.process === undefined) {
    fail("invalid-transition", "Prompt-pending requires a process-bound dispatch.");
  }
  if (prompt.effectiveTimeoutMs > row.requestTimeoutMs) {
    fail("invalid-input", "Effective timeout is not a narrowing of the actual request timeout.");
  }
  const next = buildRow(baseRowFacts(row), "prompt-pending", {
    launch: row.launch,
    process: row.process,
    prompt,
  });
  return replaceRow(inventory, ordinal, next);
}

function applyTerminal(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  nonce: string,
  terminal: NativeHarnessDispatchTerminal,
): NativeHarnessDispatchInventory {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state === "terminal") {
    fail("invalid-transition", "Dispatch is already terminal; terminal observations are immutable.");
  }
  if (
    terminal.outcome === "completed"
    && terminal.observationKind === "runner-observation"
    && (row.launch === undefined || row.process === undefined || row.prompt === undefined)
  ) {
    fail("invalid-transition", "Runner-observation completion requires the recorded launch/process/prompt chain.");
  }
  const next = buildRow(baseRowFacts(row), "terminal", {
    ...(row.launch === undefined ? {} : { launch: row.launch }),
    ...(row.process === undefined ? {} : { process: row.process }),
    ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
    terminal,
  });
  return replaceRow(inventory, ordinal, next);
}

function replaceRow(
  inventory: NativeHarnessDispatchInventory,
  ordinal: number,
  row: NativeHarnessDispatchRow,
): NativeHarnessDispatchInventory {
  const dispatches = inventory.dispatches.map((candidate) =>
    candidate.ordinal === ordinal ? row : candidate);
  return buildInventory(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    nextRevision(inventory),
    dispatches,
  );
}

function makeHandle(
  initial: NativeHarnessDispatchInventory,
  initialSha256: string,
  pins: InventoryPins,
  test: ResolvedTestOptions,
  runId: string,
): NativeHarnessDispatchInventoryHandle {
  let checkpoint = initial;
  let rawSha256 = initialSha256;
  let closed = false;
  let poisoned = false;

  const commit = async (
    mutate: (inventory: NativeHarnessDispatchInventory) => NativeHarnessDispatchInventory,
    guard: () => void,
    guardLabel: string,
  ): Promise<NativeHarnessDispatchInventory> => {
    if (closed) fail("closed", "Dispatch inventory handle is closed.");
    if (poisoned) fail("ambiguous", "Dispatch inventory handle is poisoned by an ambiguous write.");
    runGuard(guard, guardLabel);
    await verifyPins(test.io, [pins.root, pins.run]);
    runGuard(guard, guardLabel);

    let writeAttempted = false;
    let committed: NativeHarnessDispatchInventory | undefined;
    try {
      committed = await withWriteLock(pins.run.path, async () => {
        if (closed) fail("closed", "Dispatch inventory handle is closed.");
        if (poisoned) fail("ambiguous", "Dispatch inventory handle is poisoned by an ambiguous write.");
        runGuard(guard, guardLabel);
        await verifyPins(test.io, [pins.root, pins.run]);
        runGuard(guard, guardLabel);
        const observed = await readInventoryPrimary(test.io, pins, runId);
        runGuard(guard, guardLabel);
        if (observed.inventory.revision !== checkpoint.revision) {
          fail("conflict", "Dispatch inventory revision changed before commit.");
        }
        if (observed.sha256 !== rawSha256) {
          fail("changed", "Dispatch inventory bytes changed at the same revision.");
        }
        if (JSON.stringify(observed.inventory) !== JSON.stringify(checkpoint)) {
          fail("changed", "Dispatch inventory no longer matches the complete handle snapshot at this revision.");
        }
        const genesis = await readRunGenesis(test.io, pins, runId);
        runGuard(guard, guardLabel);
        if (!sameOrigin(genesis.origin, checkpoint.origin)) {
          fail("identity-mismatch", "Actual run recovery origin changed after inventory binding.");
        }
        if (!sameFixed(genesis.fixed, checkpoint.fixed)) {
          fail("identity-mismatch", "Actual run fixed facts changed after inventory binding.");
        }
        await verifyPins(test.io, [pins.root, pins.run]);
        runGuard(guard, guardLabel);
        if (test.afterRead !== undefined) {
          await test.afterRead({ path: pins.primaryPath, revision: observed.inventory.revision });
          runGuard(guard, guardLabel);
        }
        if (closed) fail("closed", "Dispatch inventory handle is closed.");
        if (poisoned) fail("ambiguous", "Dispatch inventory handle is poisoned by an ambiguous write.");
        const candidate = mutate(observed.inventory);
        const encoded = encodeAndValidate(candidate, runId);
        // The afterRead hook is reentrant and awaited. Re-verify the original
        // pinned run directory after it and after candidate validation, then
        // guard/closed-check again, before the only write effect.
        await verifyPins(test.io, [pins.root, pins.run]);
        runGuard(guard, guardLabel);
        if (closed) fail("closed", "Dispatch inventory handle is closed.");
        if (poisoned) fail("ambiguous", "Dispatch inventory handle is poisoned by an ambiguous write.");
        writeAttempted = true;
        try {
          await atomicWrite(pins.primaryPath, encoded.encoded);
        } catch (error) {
          poisoned = true;
          const detail = error instanceof Error ? error.message : "write failed";
          fail("ambiguous", `Dispatch inventory write is ambiguous; explicit re-observation is required: ${detail}`);
        }
        try {
          if (test.afterWrite !== undefined) {
            await test.afterWrite({ path: pins.primaryPath, revision: encoded.inventory.revision });
          }
          // A write is already committed. Any later guard/closed/pin
          // uncertainty is ambiguous, never a successful local checkpoint.
          runGuard(guard, guardLabel);
          if (closed) fail("closed", "Dispatch inventory handle is closed.");
          await verifyPins(test.io, [pins.root, pins.run]);
          runGuard(guard, guardLabel);
          if (closed) fail("closed", "Dispatch inventory handle is closed.");
        } catch (error) {
          poisoned = true;
          const detail = error instanceof Error ? error.message : "after-write verification failed";
          fail("ambiguous", `Dispatch inventory write acknowledgement is ambiguous; explicit re-observation is required: ${detail}`);
        }
        checkpoint = encoded.inventory;
        rawSha256 = sha256Hex(encoded.encoded);
        return checkpoint;
      });
    } catch (error) {
      if (!writeAttempted) throw error;
      poisoned = true;
      if (error instanceof NativeHarnessDispatchInventoryError && error.code === "ambiguous") throw error;
      const detail = error instanceof Error ? error.message : "lock release failed";
      fail("ambiguous", `Dispatch inventory write or lock release is ambiguous; explicit re-observation is required: ${detail}`);
    }
    if (committed === undefined) {
      fail("ambiguous", "Dispatch inventory commit returned no acknowledgement.");
    }
    if (writeAttempted) {
      try {
        // The outer short lock release is awaited too. Recheck the same
        // operation guard and local handle before claiming acknowledgement.
        runGuard(guard, guardLabel);
        if (closed) fail("closed", "Dispatch inventory handle is closed.");
      } catch (error) {
        poisoned = true;
        const detail = error instanceof Error ? error.message : "final acknowledgement failed";
        fail("ambiguous", `Dispatch inventory final acknowledgement is ambiguous; explicit re-observation is required: ${detail}`);
      }
    }
    return committed;
  };

  return Object.freeze({
    snapshot: () => checkpoint,
    intend: (intent: NativeHarnessDispatchIntent, advanceGuard: () => void) => {
      const owned = readIntentValue(intent);
      const guard = readGuard(advanceGuard, "advance guard");
      return commit((inventory) => applyIntent(inventory, owned), guard, "advance guard");
    },
    markLaunched: (
      ordinal: number,
      nonce: string,
      runtimeRoot: string,
      advanceGuard: () => void,
    ) => {
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedRoot = readAbsolutePath(runtimeRoot, "runtimeRoot", MAX_RUNTIME_ROOT_BYTES);
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyLaunch(inventory, ownedOrdinal, ownedNonce, ownedRoot),
        guard,
        "advance guard",
      );
    },
    bindProcess: (
      ordinal: number,
      nonce: string,
      process: NativeHarnessDispatchProcess,
      advanceGuard: () => void,
    ) => {
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedProcess = readProcessValue(process, "invalid-input");
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyProcess(inventory, ownedOrdinal, ownedNonce, ownedProcess),
        guard,
        "advance guard",
      );
    },
    markPromptPending: (
      ordinal: number,
      nonce: string,
      prompt: NativeHarnessDispatchPrompt,
      advanceGuard: () => void,
    ) => {
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedPrompt = readPromptValue(prompt, "invalid-input");
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyPrompt(inventory, ownedOrdinal, ownedNonce, ownedPrompt),
        guard,
        "advance guard",
      );
    },
    finalize: (
      ordinal: number,
      nonce: string,
      terminal: NativeHarnessDispatchTerminal,
      cleanupGuard: () => void,
    ) => {
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedTerminal = readTerminalValue(terminal, "invalid-input");
      const guard = readGuard(cleanupGuard, "terminal cleanup guard");
      return commit(
        (inventory) => applyTerminal(inventory, ownedOrdinal, ownedNonce, ownedTerminal),
        guard,
        "terminal cleanup guard",
      );
    },
    close: () => {
      closed = true;
    },
  });
}

/**
 * Creates the sidecar for one already-existing actual recovery-origin run.
 * The run primary is re-read under the original short run-directory write lock
 * and must still match the exact genesis origin/fixed facts. EEXIST, including
 * a `.bak` sibling, refuses; no existing bytes are adopted or overwritten.
 *
 * The caller must supply only its actual newly created run. This storage API
 * cannot prove that ownership, stage attempts, paths or prompt digests are
 * true; those remain caller/integration obligations.
 */
export async function createNativeHarnessDispatchInventory(
  options: NativeHarnessDispatchInventoryCreateOptions,
  testOptions?: NativeHarnessDispatchInventoryTestOptions,
): Promise<NativeHarnessDispatchInventoryHandle> {
  const owned = readLocation(options, CREATE_KEYS, "create options");
  const test = readTestOptions(testOptions);
  const pins = await pinInventory(test.io, owned.storeRoot, owned.runId);
  const before = await readRunGenesis(test.io, pins, owned.runId);
  await verifyPins(test.io, [pins.root, pins.run]);

  let writeAttempted = false;
  let written: EncodedInventory | undefined;
  try {
    await withWriteLock(pins.run.path, async () => {
      await verifyPins(test.io, [pins.root, pins.run]);
      const locked = await readRunGenesis(test.io, pins, owned.runId);
      if (!sameOrigin(before.origin, locked.origin) || !sameFixed(before.fixed, locked.fixed)) {
        fail("changed", "Actual run genesis changed before inventory creation.");
      }
      await assertFreshInventory(test.io, pins.primaryPath);
      const candidate = buildInventory(locked.origin, locked.fixed, owned.runId, 0, []);
      const encoded = encodeAndValidate(candidate, owned.runId);
      await verifyPins(test.io, [pins.root, pins.run]);
      written = encoded;
      writeAttempted = true;
      try {
        await atomicWrite(pins.primaryPath, encoded.encoded);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "write failed";
        fail("ambiguous", `Initial dispatch inventory write is ambiguous: ${detail}`);
      }
      try {
        if (test.afterWrite !== undefined) {
          await test.afterWrite({ path: pins.primaryPath, revision: encoded.inventory.revision });
        }
        await verifyPins(test.io, [pins.root, pins.run]);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "after-write verification failed";
        fail("ambiguous", `Initial dispatch inventory acknowledgement is ambiguous: ${detail}`);
      }
    });
  } catch (error) {
    if (!writeAttempted) throw error;
    if (error instanceof NativeHarnessDispatchInventoryError && error.code === "ambiguous") throw error;
    const detail = error instanceof Error ? error.message : "lock release failed";
    fail("ambiguous", `Initial dispatch inventory write or lock release is ambiguous: ${detail}`);
  }
  if (written === undefined) fail("ambiguous", "Initial dispatch inventory acknowledgement is unavailable.");
  return makeHandle(written.inventory, sha256Hex(written.encoded), pins, test, owned.runId);
}

/**
 * Opens one existing sidecar after binding it to the exact actual run primary.
 * Missing/corrupt/oversized/symlinked primaries, a missing sidecar, an origin
 * or fixed-fact mismatch, and backup-only state all refuse. Open creates and
 * repairs nothing and returns no execution/recovery authority.
 */
export async function openNativeHarnessDispatchInventory(
  options: NativeHarnessDispatchInventoryOpenOptions,
  testOptions?: NativeHarnessDispatchInventoryTestOptions,
): Promise<NativeHarnessDispatchInventoryHandle> {
  const owned = readLocation(options, OPEN_KEYS, "open options");
  const test = readTestOptions(testOptions);
  const pins = await pinInventory(test.io, owned.storeRoot, owned.runId);
  const genesis = await readRunGenesis(test.io, pins, owned.runId);
  const observed = await readInventoryPrimary(test.io, pins, owned.runId);
  if (!sameOrigin(observed.inventory.origin, genesis.origin)) {
    fail("identity-mismatch", "Dispatch inventory recovery origin does not match the actual run.");
  }
  if (!sameFixed(observed.inventory.fixed, genesis.fixed)) {
    fail("identity-mismatch", "Dispatch inventory fixed facts do not match the actual run.");
  }
  await verifyPins(test.io, [pins.root, pins.run]);
  return makeHandle(observed.inventory, observed.sha256, pins, test, owned.runId);
}
