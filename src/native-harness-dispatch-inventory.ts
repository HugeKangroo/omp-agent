import { constants } from "node:fs";
import path from "node:path";
import {
  atomicWrite,
  decodeRunHistoryText,
  decodeRunRecoveryOriginText,
  StoreConflictError,
  StoreCorruptionError,
  withWriteLock,
} from "../vendor/harness2/upstream/src/store.ts";
import {
  STAGE_IDS,
  type RunRecord,
  type RunRecoveryOrigin,
  type StageId,
  type WorkerLifecycleCleanupObservedEvent,
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
 * B1b2 storage leaf: bounded dispatch inventory for one actual
 * recovery-origin run. This module is storage, codec, CAS and append-only
 * lifecycle data only.
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
 * New creations use the v2 schema. Published v1 did not reserve cleanup
 * receipt bytes, so it is decode/open/snapshot only: every v1 mutation is
 * refused before argument access, guards, locking or write IO. There is no
 * migration, fallback, remint, receipt backfill or old-terminal rewrite.
 *
 * The sidecar is capped at 32 dispatch rows and 256 KiB canonical UTF-8 + LF.
 * For v2, admission reserves each open row's maximum legal launch + prompt +
 * cleanup + terminal encoding exactly once; already-written fields or a
 * receipt are not counted twice. Pathological rows reduce usable rows instead
 * of making a legal transition inherently unable to fit. Old rows are never
 * truncated or recycled. V1 keeps its original reservation rule.
 *
 * innerDeadlineAt is stored exactly as the original actual value; execution
 * must gate at min(innerDeadlineAt, outerDeadlineAt), never rewrite the original
 * value to that minimum. requestTimeoutMs is the actual Controller request
 * timeout. V2 launch and prompt timeouts may only narrow it, and prompt must
 * not widen launch. No signal is persisted.
 *
 * Lifecycle facts are finite:
 * v2 intended -> launch-pending -> process-bound -> prompt-pending ->
 * cleanup-observed -> terminal. A real cleanup receipt may close any
 * nonterminal failure path; an explicit synthetic receipt may close only an
 * intended row with no launch/process/prompt facts. Terminal is a tagged
 * observation, not a claim that the process stopped or that coverage is
 * complete. Receipt presence is not an all-stopped aggregate and grants no
 * current dispatch authority. An absent process association remains unknown.
 * No clock, PID, process-group or credential is verified here.
 *
 * The advance guard is the original execution signal/deadline check supplied by
 * the caller. It is invoked after every awaited lock/read/test hook and
 * immediately before a write. A synchronous guard that returns a Promise or
 * thenable is refused. Cleanup receipt and terminal finalization use a separate
 * cleanup guard and deliberately do not re-apply the original live-execution
 * guard.
 */

export const NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA =
  "omp-agent.native-harness-dispatch-inventory.v1";
export const NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2 =
  "omp-agent.native-harness-dispatch-inventory.v2";
export const NATIVE_HARNESS_DISPATCH_INVENTORY_FILE = "dispatch-inventory.json";
export const NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES = 256 * 1024;
export const NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES = 32;
export const NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES = 1_048_576;

const MAX_PATH_BYTES = 4096;
const MAX_RUNTIME_ROOT_BYTES = 1024;
/**
 * Conservative upper bound for the UTF-8 length of JSON encoding one finite
 * nonnegative ECMAScript number. Shortest round-trip decimal text is far
 * shorter than this for every finite nonnegative binary64 value; fixed
 * headroom keeps the storage bound independent of the host's exact
 * shortest-decimal implementation.
 */
const MAX_NUMERIC_JSON_BYTES = 32;
const TERMINAL_USAGE_COST_PROJECTION = Number.MAX_VALUE;
const TERMINAL_USAGE_COST_RESERVED_BYTES = MAX_NUMERIC_JSON_BYTES
  - Buffer.byteLength(JSON.stringify(TERMINAL_USAGE_COST_PROJECTION), "utf8");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const SIGNAL_TOKEN_PATTERN = /^SIG[A-Za-z0-9+._-]{0,29}$/;
const MAX_CLEANUP_SIGNAL = `SIG${"X".repeat(29)}`;
const MAX_CLEANUP_OBSERVED_AT = "+275760-09-13T00:00:00.000Z";

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
const ROW_OPTIONAL_KEYS_V1 = ["launch", "process", "prompt", "terminal"] as const;
const ROW_OPTIONAL_KEYS_V2 = ["launch", "process", "prompt", "cleanup", "terminal"] as const;
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
const LAUNCH_KEYS_V1 = ["runtimeRoot"] as const;
const LAUNCH_KEYS_V2 = [
  "runtimeRoot",
  "configSha256",
  "appendixSha256",
  "effectiveTimeoutMs",
] as const;
const PROCESS_KEYS = ["pid", "pgid", "identitySha256"] as const;
const PROMPT_KEYS_V1 = ["promptSha256", "effectiveTimeoutMs"] as const;
const PROMPT_KEYS_V2 = ["promptSha256", "promptBytes", "effectiveTimeoutMs"] as const;
const TERMINAL_KEYS = [
  "outcome",
  "observationKind",
  "observedAt",
  "resultSha256",
  "usageCostUsd",
  "usageEstimated",
] as const;
const CLEANUP_RECEIPT_KEYS = ["observationKind", "observation"] as const;
const SYNTHETIC_CLEANUP_KEYS = ["observationKind"] as const;
const CLEANUP_OBSERVATION_KEYS = [
  "type",
  "runId",
  "stage",
  "spawnAttempted",
  "closeSeen",
  "closeCode",
  "closeSignal",
  "groupObservation",
  "groupObservedAt",
  "hostWorkSettled",
  "approvalWorkSettled",
  "logFlush",
] as const;
const TEST_KEYS = ["fileIo", "testAfterPrimaryRead", "testAfterPrimaryWrite"] as const;
const CREATE_KEYS = ["storeRoot", "runId"] as const;
const OPEN_KEYS = ["storeRoot", "runId"] as const;

const TERMINAL_OUTCOMES = ["completed", "failed", "cancelled", "timed-out", "unknown"] as const;
const OBSERVATION_KINDS = ["runner-observation", "synthetic-fixture"] as const;
const GROUP_OBSERVATIONS = ["not-observed", "present", "unknown"] as const;
const LOG_FLUSHES = ["success", "failure"] as const;
const DISPATCH_STATES_V1 = [
  "intended",
  "launch-pending",
  "process-bound",
  "prompt-pending",
  "terminal",
] as const;
const DISPATCH_STATES_V2 = [
  "intended",
  "launch-pending",
  "process-bound",
  "prompt-pending",
  "cleanup-observed",
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
  | "refused"
  | "read-only";

export class NativeHarnessDispatchInventoryError extends Error {
  override name = "NativeHarnessDispatchInventoryError";

  constructor(
    message: string,
    readonly code: NativeHarnessDispatchInventoryErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface NativeHarnessDispatchInventoryFixed {
  readonly stageTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly maxCostUsd: number;
}

/**
 * Caller-owned immutable admission facts. The caller must copy attempt, cwd and
 * stage (with run ID/status evidence) from the actual verified StageRecord;
 * runRevision comes from the actual RunRecord.revision; artifactDir comes from
 * the same verified WorkerRequest, constrained to that attempt's sibling
 * artifacts path. StageRecord itself has no revision or artifactDir field.
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

/** V1 diagnostic launch shape, retained only for old-byte decoding. */
export interface NativeHarnessDispatchLaunchV1 {
  readonly runtimeRoot: string;
}

/**
 * V2 complete owned launch facts. B1c copies these from the actual preLaunch
 * event; this leaf neither renders configuration nor invents missing hashes.
 */
export interface NativeHarnessDispatchLaunch {
  readonly runtimeRoot: string;
  readonly configSha256: string;
  readonly appendixSha256: string;
  readonly effectiveTimeoutMs: number;
}

/**
 * Association-only process facts. `identitySha256` may hold the actual Runner
 * associationSha256; it is not a boot/authenticated process identity. A null
 * PID/PGID from the Runner must not be turned into a process-bound row.
 */
export interface NativeHarnessDispatchProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly identitySha256: string;
}

/** V1 diagnostic prompt shape, retained only for old-byte decoding. */
export interface NativeHarnessDispatchPromptV1 {
  readonly promptSha256: string;
  readonly effectiveTimeoutMs: number;
}

/** V2 prompt facts. promptBytes is the actual encoded RPC frame UTF-8 size. */
export interface NativeHarnessDispatchPrompt {
  readonly promptSha256: string;
  readonly promptBytes: number;
  readonly effectiveTimeoutMs: number;
}

export type NativeHarnessDispatchTerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];
export type NativeHarnessDispatchObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * Tagged terminal observation. `outcome` alone is not a stopped/complete-
 * coverage claim, and `observationKind` is descriptive data rather than
 * authority. V2 requires a prior cleanup receipt with the same
 * observationKind. A synthetic-fixture completion may omit all process facts
 * and is never evidence that an actual process ran or stopped. A
 * runner-observation completion requires the recorded launch/process/prompt
 * chain and its prior runner cleanup receipt. outcome/resultSha256 never prove
 * actual drain or stop.
 */
export interface NativeHarnessDispatchTerminal {
  readonly outcome: NativeHarnessDispatchTerminalOutcome;
  readonly observationKind: NativeHarnessDispatchObservationKind;
  readonly observedAt: number;
  readonly resultSha256: string | null;
  readonly usageCostUsd: number | null;
  readonly usageEstimated: boolean;
}

/** Exact owned cleanup receipt union. It contains no derived allStopped flag. */
export type NativeHarnessDispatchCleanupReceipt =
  | {
    readonly observationKind: "runner-observation";
    readonly observation: WorkerLifecycleCleanupObservedEvent;
  }
  | {
    readonly observationKind: "synthetic-fixture";
  };

export type NativeHarnessDispatchStateV1 = (typeof DISPATCH_STATES_V1)[number];
export type NativeHarnessDispatchState = (typeof DISPATCH_STATES_V2)[number];

export interface NativeHarnessDispatchRowV1 {
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
  readonly state: NativeHarnessDispatchStateV1;
  readonly launch?: NativeHarnessDispatchLaunchV1;
  readonly process?: NativeHarnessDispatchProcess;
  readonly prompt?: NativeHarnessDispatchPromptV1;
  readonly terminal?: NativeHarnessDispatchTerminal;
}

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
  readonly cleanup?: NativeHarnessDispatchCleanupReceipt;
  readonly terminal?: NativeHarnessDispatchTerminal;
}

export interface NativeHarnessDispatchInventoryV1 {
  readonly schema: typeof NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA;
  readonly revision: number;
  readonly runId: string;
  readonly origin: RunRecoveryOrigin;
  readonly fixed: NativeHarnessDispatchInventoryFixed;
  readonly dispatches: readonly NativeHarnessDispatchRowV1[];
}

export interface NativeHarnessDispatchInventoryV2 {
  readonly schema: typeof NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2;
  readonly revision: number;
  readonly runId: string;
  readonly origin: RunRecoveryOrigin;
  readonly fixed: NativeHarnessDispatchInventoryFixed;
  readonly dispatches: readonly NativeHarnessDispatchRow[];
}

/** Common readonly snapshot union: v1 is diagnostic, v2 is current. */
export type NativeHarnessDispatchInventory =
  | NativeHarnessDispatchInventoryV1
  | NativeHarnessDispatchInventoryV2;

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
  /** V2 only: appends exactly the next intended row. */
  intend(intent: NativeHarnessDispatchIntent, advanceGuard: () => void): Promise<NativeHarnessDispatchInventory>;
  /**
   * V2 only: records awaited PRE-SPAWN launch-pending with the complete actual
   * runtime root, config/appendix digests and effective timeout. This does not
   * mean spawn succeeded; process association is separate. No string-only
   * placeholder path is offered.
   */
  markLaunched(
    ordinal: number,
    nonce: string,
    launch: NativeHarnessDispatchLaunch,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /** V2 only: associates the actual PID/PGID facts reported by the original Runner. */
  bindProcess(
    ordinal: number,
    nonce: string,
    process: NativeHarnessDispatchProcess,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /** V2 only: records the encoded prompt digest, byte length and narrowed timeout. */
  markPromptPending(
    ordinal: number,
    nonce: string,
    prompt: NativeHarnessDispatchPrompt,
    advanceGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /**
   * V2 only: records one immutable cleanup receipt. A real observation may
   * close any nonterminal failure path; a synthetic tag may close only an
   * intended row with no launch/process/prompt facts. The separate cleanup
   * guard is not the original live-execution guard. This cannot extend
   * execution, refund budget, or grant a next dispatch.
   */
  markCleanupObserved(
    ordinal: number,
    nonce: string,
    receipt: NativeHarnessDispatchCleanupReceipt,
    cleanupGuard: () => void,
  ): Promise<NativeHarnessDispatchInventory>;
  /**
   * V2 only: records the already registered dispatch's real result observation
   * after a matching cleanup receipt. The separate cleanup guard is not the
   * original live-execution guard.
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

type BaseRowFacts = Omit<NativeHarnessDispatchRow, "state" | "launch" | "process" | "prompt" | "cleanup" | "terminal">;

function fail(code: NativeHarnessDispatchInventoryErrorCode, message: string): never {
  throw new NativeHarnessDispatchInventoryError(message, code);
}

/**
 * `withWriteLock` can refuse to release a lock whose directory identity was
 * replaced after the pinned run directory moved. That release failure replaces
 * any earlier pre-write refusal, so the inventory boundary re-expresses it as
 * `changed` and keeps the actual Store conflict as the cause. This applies only
 * before any write: post-write lock uncertainty remains `ambiguous` at its
 * existing call sites.
 */
function failPrewriteStoreConflict(error: unknown): never {
  if (!(error instanceof StoreConflictError)) throw error;
  throw new NativeHarnessDispatchInventoryError(
    "The original Store reported a lock identity conflict before an inventory write; inspect the cause for details.",
    "changed",
    { cause: error },
  );
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

function readSignedSafeInteger(
  value: unknown,
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(code, `${label} must be a signed safe integer.`);
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

function readLaunchV1(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchLaunchV1 {
  const record = readOwnedRecord(value, LAUNCH_KEYS_V1, LAUNCH_KEYS_V1, "launch fact", code);
  const runtimeRoot = typeof record.runtimeRoot === "string"
    && record.runtimeRoot.length > 0
    && path.isAbsolute(record.runtimeRoot)
    && !CONTROL_PATTERN.test(record.runtimeRoot)
    && Buffer.byteLength(record.runtimeRoot, "utf8") <= MAX_RUNTIME_ROOT_BYTES
    ? record.runtimeRoot
    : fail(code, "launch.runtimeRoot must be a bounded absolute path.");
  return Object.freeze({ runtimeRoot });
}

function readLaunchV2(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchLaunch {
  const record = readOwnedRecord(value, LAUNCH_KEYS_V2, LAUNCH_KEYS_V2, "launch fact", code);
  const runtimeRoot = typeof record.runtimeRoot === "string"
    && record.runtimeRoot.length > 0
    && path.isAbsolute(record.runtimeRoot)
    && !CONTROL_PATTERN.test(record.runtimeRoot)
    && Buffer.byteLength(record.runtimeRoot, "utf8") <= MAX_RUNTIME_ROOT_BYTES
    ? record.runtimeRoot
    : fail(code, "launch.runtimeRoot must be a bounded absolute path.");
  const configSha256 = readSha256(record.configSha256, "launch.configSha256", code);
  const appendixSha256 = readSha256(record.appendixSha256, "launch.appendixSha256", code);
  const effectiveTimeoutMs = readSafeInteger(record.effectiveTimeoutMs, "launch.effectiveTimeoutMs", 1, code);
  return Object.freeze({ runtimeRoot, configSha256, appendixSha256, effectiveTimeoutMs });
}

function readProcessValue(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchProcess {
  const record = readOwnedRecord(value, PROCESS_KEYS, PROCESS_KEYS, "process fact", code);
  const pid = readSafeInteger(record.pid, "process.pid", 1, code);
  const pgid = readSafeInteger(record.pgid, "process.pgid", 1, code);
  const identitySha256 = readSha256(record.identitySha256, "process.identitySha256", code);
  return Object.freeze({ pid, pgid, identitySha256 });
}

function readPromptV1(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchPromptV1 {
  const record = readOwnedRecord(value, PROMPT_KEYS_V1, PROMPT_KEYS_V1, "prompt fact", code);
  const promptSha256 = readSha256(record.promptSha256, "prompt.promptSha256", code);
  const effectiveTimeoutMs = readSafeInteger(record.effectiveTimeoutMs, "prompt.effectiveTimeoutMs", 1, code);
  return Object.freeze({ promptSha256, effectiveTimeoutMs });
}

function readPromptV2(value: unknown, code: NativeHarnessDispatchInventoryErrorCode): NativeHarnessDispatchPrompt {
  const record = readOwnedRecord(value, PROMPT_KEYS_V2, PROMPT_KEYS_V2, "prompt fact", code);
  const promptSha256 = readSha256(record.promptSha256, "prompt.promptSha256", code);
  const promptBytes = readSafeInteger(record.promptBytes, "prompt.promptBytes", 1, code);
  if (promptBytes > NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES) {
    fail(code, `prompt.promptBytes exceeds ${NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES}.`);
  }
  const effectiveTimeoutMs = readSafeInteger(record.effectiveTimeoutMs, "prompt.effectiveTimeoutMs", 1, code);
  return Object.freeze({ promptSha256, promptBytes, effectiveTimeoutMs });
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

function readBoolean(value: unknown, label: string, code: NativeHarnessDispatchInventoryErrorCode): boolean {
  if (typeof value !== "boolean") fail(code, `${label} must be a strict boolean.`);
  return value;
}

function readCanonicalIsoDate(
  value: unknown,
  label: string,
  code: NativeHarnessDispatchInventoryErrorCode,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 27) {
    fail(code, `${label} must be a canonical ISO date of at most 27 characters.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(code, `${label} must be a canonical ISO date of at most 27 characters.`);
  }
  return value;
}

function readCleanupReceipt(
  value: unknown,
  code: NativeHarnessDispatchInventoryErrorCode,
): NativeHarnessDispatchCleanupReceipt {
  const initial = readOwnedRecord(
    value,
    [...SYNTHETIC_CLEANUP_KEYS, "observation"],
    ["observationKind"],
    "cleanup receipt",
    code,
  );
  const kind = initial.observationKind;
  if (kind === "synthetic-fixture") {
    readOwnedRecord(value, SYNTHETIC_CLEANUP_KEYS, SYNTHETIC_CLEANUP_KEYS, "synthetic cleanup receipt", code);
    return Object.freeze({ observationKind: "synthetic-fixture" as const });
  }
  if (kind !== "runner-observation") {
    fail(code, "cleanup receipt observationKind is not a bounded tag.");
  }
  const record = readOwnedRecord(
    value,
    CLEANUP_RECEIPT_KEYS,
    CLEANUP_RECEIPT_KEYS,
    "runner cleanup receipt",
    code,
  );
  const observation = readOwnedRecord(
    record.observation,
    CLEANUP_OBSERVATION_KEYS,
    CLEANUP_OBSERVATION_KEYS,
    "cleanup observation",
    code,
  );
  if (observation.type !== "cleanupObserved") {
    fail(code, "cleanup observation type must be cleanupObserved.");
  }
  const runId = readRunId(observation.runId, code);
  const stage = readStageId(observation.stage, code);
  const spawnAttempted = readBoolean(observation.spawnAttempted, "cleanup.spawnAttempted", code);
  const closeSeen = readBoolean(observation.closeSeen, "cleanup.closeSeen", code);
  const closeCodeValue = observation.closeCode;
  const closeCode = closeCodeValue === null
    ? null
    : readSignedSafeInteger(closeCodeValue, "cleanup.closeCode", code);
  const closeSignalValue = observation.closeSignal;
  let closeSignal: string | null;
  if (closeSignalValue === null) {
    closeSignal = null;
  } else if (
    typeof closeSignalValue === "string"
    && SIGNAL_TOKEN_PATTERN.test(closeSignalValue)
    && Buffer.byteLength(closeSignalValue, "utf8") <= 32
  ) {
    closeSignal = closeSignalValue;
  } else {
    fail(code, "cleanup.closeSignal must be null or a bounded ASCII SIG token.");
  }
  const groupValue = observation.groupObservation;
  if (typeof groupValue !== "string" || !(GROUP_OBSERVATIONS as readonly string[]).includes(groupValue)) {
    fail(code, "cleanup.groupObservation is not a bounded enum value.");
  }
  const groupObservation = groupValue as (typeof GROUP_OBSERVATIONS)[number];
  const groupObservedAtValue = observation.groupObservedAt;
  const groupObservedAt = groupObservedAtValue === null
    ? null
    : readCanonicalIsoDate(groupObservedAtValue, "cleanup.groupObservedAt", code);
  const hostWorkSettled = readBoolean(observation.hostWorkSettled, "cleanup.hostWorkSettled", code);
  const approvalWorkSettled = readBoolean(observation.approvalWorkSettled, "cleanup.approvalWorkSettled", code);
  const logValue = observation.logFlush;
  if (typeof logValue !== "string" || !(LOG_FLUSHES as readonly string[]).includes(logValue)) {
    fail(code, "cleanup.logFlush is not a bounded enum value.");
  }
  if (closeSeen && closeCode === null && closeSignal === null) {
    // A seen close with neither code nor signal is shape-valid; no stop claim.
  } else if (!closeSeen && (closeCode !== null || closeSignal !== null)) {
    fail(code, "cleanup.closeCode/closeSignal cannot be present when closeSeen is false.");
  }
  if (groupObservedAt === null && groupObservation !== "unknown") {
    fail(code, "cleanup.groupObservation requires a probe time except for unknown.");
  }
  // "unknown" may carry an actual probe time: Runner.observeGroup reports an
  // attempted probe that threw as unknown plus its real observedAt. No time
  // still means no usable probe result.
  if (!spawnAttempted) {
    if (
      closeSeen
      || closeCode !== null
      || closeSignal !== null
      || groupObservedAt !== null
      || groupObservation !== "unknown"
    ) {
      fail(code, "cleanup spawnAttempted=false cannot claim close or probe facts.");
    }
  }
  const ownedObservation: WorkerLifecycleCleanupObservedEvent = Object.freeze({
    type: "cleanupObserved" as const,
    runId,
    stage,
    spawnAttempted,
    closeSeen,
    closeCode,
    closeSignal,
    groupObservation,
    groupObservedAt,
    hostWorkSettled,
    approvalWorkSettled,
    logFlush: logValue as (typeof LOG_FLUSHES)[number],
  });
  return Object.freeze({
    observationKind: "runner-observation" as const,
    observation: ownedObservation,
  });
}

function assertCleanupMatchesRow(
  row: { readonly runId: string; readonly stage: StageId },
  receipt: NativeHarnessDispatchCleanupReceipt,
  code: NativeHarnessDispatchInventoryErrorCode,
): void {
  if (receipt.observationKind === "synthetic-fixture") return;
  if (receipt.observation.runId !== row.runId) {
    fail(code, "Cleanup observation runId does not match the dispatch row.");
  }
  if (receipt.observation.stage !== row.stage) {
    fail(code, "Cleanup observation stage does not match the dispatch row.");
  }
}

function assertCleanupPrefixConsistency(
  row: { readonly launch?: unknown; readonly process?: unknown; readonly prompt?: unknown },
  receipt: NativeHarnessDispatchCleanupReceipt,
  code: NativeHarnessDispatchInventoryErrorCode,
): void {
  if (receipt.observationKind === "synthetic-fixture") {
    if (row.launch !== undefined || row.process !== undefined || row.prompt !== undefined) {
      fail(code, "Synthetic cleanup cannot describe launch/process/prompt facts.");
    }
    return;
  }
  if (row.process !== undefined && !receipt.observation.spawnAttempted) {
    fail(code, "Cleanup spawnAttempted=false contradicts a process-bound prefix.");
  }
  if (row.prompt !== undefined && !receipt.observation.spawnAttempted) {
    fail(code, "Cleanup spawnAttempted=false contradicts a prompt prefix.");
  }
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
  row: NativeHarnessDispatchRow | NativeHarnessDispatchRowV1,
): BaseRowFacts {
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

function buildRowV1(
  base: BaseRowFacts,
  state: NativeHarnessDispatchStateV1,
  additions: {
    readonly launch?: NativeHarnessDispatchLaunchV1;
    readonly process?: NativeHarnessDispatchProcess;
    readonly prompt?: NativeHarnessDispatchPromptV1;
    readonly terminal?: NativeHarnessDispatchTerminal;
  } = {},
): NativeHarnessDispatchRowV1 {
  return Object.freeze({
    ...base,
    state,
    ...(additions.launch === undefined ? {} : { launch: additions.launch }),
    ...(additions.process === undefined ? {} : { process: additions.process }),
    ...(additions.prompt === undefined ? {} : { prompt: additions.prompt }),
    ...(additions.terminal === undefined ? {} : { terminal: additions.terminal }),
  });
}

function buildRowV2(
  base: BaseRowFacts,
  state: NativeHarnessDispatchState,
  additions: {
    readonly launch?: NativeHarnessDispatchLaunch;
    readonly process?: NativeHarnessDispatchProcess;
    readonly prompt?: NativeHarnessDispatchPrompt;
    readonly cleanup?: NativeHarnessDispatchCleanupReceipt;
    readonly terminal?: NativeHarnessDispatchTerminal;
  } = {},
): NativeHarnessDispatchRow {
  return Object.freeze({
    ...base,
    state,
    ...(additions.launch === undefined ? {} : { launch: additions.launch }),
    ...(additions.process === undefined ? {} : { process: additions.process }),
    ...(additions.prompt === undefined ? {} : { prompt: additions.prompt }),
    ...(additions.cleanup === undefined ? {} : { cleanup: additions.cleanup }),
    ...(additions.terminal === undefined ? {} : { terminal: additions.terminal }),
  });
}

function buildInventoryV1(
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
  runId: string,
  revision: number,
  dispatches: readonly NativeHarnessDispatchRowV1[],
): NativeHarnessDispatchInventoryV1 {
  return deepFreeze({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
    revision,
    runId,
    origin,
    fixed,
    dispatches: dispatches.map((row) => deepFreeze(row)),
  });
}

function buildInventoryV2(
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
  runId: string,
  revision: number,
  dispatches: readonly NativeHarnessDispatchRow[],
): NativeHarnessDispatchInventoryV2 {
  return deepFreeze({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
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
 * V1 maximum legal terminal encoding projection for one nonterminal row.
 * This retains the published v1 reservation rule exactly.
 */
function worstCaseTerminalRowV1(
  row: NativeHarnessDispatchRowV1,
): NativeHarnessDispatchRowV1 {
  const launch: NativeHarnessDispatchLaunchV1 = Object.freeze({
    runtimeRoot: `/${"\\".repeat(MAX_RUNTIME_ROOT_BYTES - 1)}`,
  });
  const process: NativeHarnessDispatchProcess = Object.freeze({
    pid: Number.MAX_SAFE_INTEGER,
    pgid: Number.MAX_SAFE_INTEGER,
    identitySha256: "f".repeat(64),
  });
  const prompt: NativeHarnessDispatchPromptV1 = Object.freeze({
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
  return buildRowV1(baseRowFacts(row), "terminal", { launch, process, prompt, terminal });
}

/**
 * Widest legal size-only cleanup receipt for this row. runId/stage are copied
 * from the actual row; independent booleans use false (longer JSON than true).
 * This is a projection, never a persisted observation.
 */
function worstCaseCleanupReceipt(row: NativeHarnessDispatchRow): NativeHarnessDispatchCleanupReceipt {
  return Object.freeze({
    observationKind: "runner-observation" as const,
    observation: Object.freeze({
      type: "cleanupObserved" as const,
      runId: row.runId,
      stage: row.stage,
      // Size-only: false is one byte wider than true for every boolean.
      spawnAttempted: false,
      closeSeen: false,
      closeCode: -Number.MAX_SAFE_INTEGER,
      closeSignal: MAX_CLEANUP_SIGNAL,
      groupObservation: "not-observed" as const,
      groupObservedAt: MAX_CLEANUP_OBSERVED_AT,
      hostWorkSettled: false,
      approvalWorkSettled: false,
      logFlush: "failure" as const,
    }),
  });
}

/**
 * V2 maximum legal completion projection. The launch/prompt/fixed fields use
 * their widest legal encodings; an already-written cleanup receipt is reused
 * rather than counted twice. This is an internal size projection, never a
 * persisted row or observation claim.
 */
function worstCaseV2TerminalRow(
  row: NativeHarnessDispatchRow,
): NativeHarnessDispatchRow {
  const launch: NativeHarnessDispatchLaunch = Object.freeze({
    runtimeRoot: `/${"\\".repeat(MAX_RUNTIME_ROOT_BYTES - 1)}`,
    configSha256: "f".repeat(64),
    appendixSha256: "f".repeat(64),
    effectiveTimeoutMs: row.requestTimeoutMs,
  });
  const process: NativeHarnessDispatchProcess = Object.freeze({
    pid: Number.MAX_SAFE_INTEGER,
    pgid: Number.MAX_SAFE_INTEGER,
    identitySha256: "f".repeat(64),
  });
  const prompt: NativeHarnessDispatchPrompt = Object.freeze({
    promptSha256: "f".repeat(64),
    promptBytes: NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES,
    effectiveTimeoutMs: row.requestTimeoutMs,
  });
  const cleanup = row.state === "cleanup-observed" && row.cleanup !== undefined
    ? row.cleanup
    : worstCaseCleanupReceipt(row);
  const terminal: NativeHarnessDispatchTerminal = Object.freeze({
    outcome: "completed",
    observationKind: cleanup.observationKind,
    observedAt: Number.MAX_SAFE_INTEGER,
    resultSha256: "f".repeat(64),
    usageCostUsd: TERMINAL_USAGE_COST_PROJECTION,
    usageEstimated: false,
  });
  return buildRowV2(baseRowFacts(row), "terminal", { launch, process, prompt, cleanup, terminal });
}

function assertCapacityV1(inventory: NativeHarnessDispatchInventoryV1): void {
  if (inventory.dispatches.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const bytes = Buffer.byteLength(encodeInventory(inventory), "utf8");
  if (bytes > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES) {
    fail("too-large", `Dispatch inventory exceeds ${NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES} bytes.`);
  }
  const openRows = inventory.dispatches.filter((row) => row.state !== "terminal").length;
  const projected = buildInventoryV1(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    Number.MAX_SAFE_INTEGER,
    inventory.dispatches.map((row) =>
      row.state === "terminal" ? row : worstCaseTerminalRowV1(row)),
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

function assertCapacityV2(inventory: NativeHarnessDispatchInventoryV2): void {
  if (inventory.dispatches.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const bytes = Buffer.byteLength(encodeInventory(inventory), "utf8");
  if (bytes > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES) {
    fail("too-large", `Dispatch inventory exceeds ${NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES} bytes.`);
  }
  // Re-encode every open row at its maximum legal launch + prompt + cleanup +
  // terminal encoding, with the widest legal revision. Already-written facts
  // or a receipt are replaced by that projection, never added twice. The fixed
  // numeric allowance covers arbitrary finite usage cost encodings.
  const openRows = inventory.dispatches.filter((row) => row.state !== "terminal").length;
  const projected = buildInventoryV2(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    Number.MAX_SAFE_INTEGER,
    inventory.dispatches.map((row) =>
      row.state === "terminal" ? row : worstCaseV2TerminalRow(row)),
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

function readBaseRow(
  record: Record<string, unknown>,
  index: number,
  runId: string,
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
  deadlineBound: { readonly createdAt: number; readonly upper: number },
  nonces: Set<string>,
): BaseRowFacts {
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
  return {
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
  };
}

function readRowsV1(
  value: unknown,
  runId: string,
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
): readonly NativeHarnessDispatchRowV1[] {
  const rawRows = readArray(value, "dispatches", "corrupt");
  if (rawRows.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const allowedKeys = [...ROW_BASE_KEYS, ...ROW_OPTIONAL_KEYS_V1];
  const deadlineBound = originalInnerDeadlineBound(origin, fixed, "corrupt");
  const nonces = new Set<string>();
  const runtimeRoots = new Set<string>();
  const rows: NativeHarnessDispatchRowV1[] = [];
  for (const [index, rawRow] of rawRows.entries()) {
    const record = readOwnedRecord(rawRow, allowedKeys, ROW_BASE_KEYS, `dispatch row ${index + 1}`, "corrupt");
    const base = readBaseRow(record, index, runId, origin, fixed, deadlineBound, nonces);
    const stateValue = record.state;
    if (
      typeof stateValue !== "string"
      || !(DISPATCH_STATES_V1 as readonly string[]).includes(stateValue)
    ) {
      fail("corrupt", "Dispatch row state is not a bounded v1 lifecycle state.");
    }
    const state = stateValue as NativeHarnessDispatchStateV1;
    const hasLaunch = Object.hasOwn(record, "launch");
    const hasProcess = Object.hasOwn(record, "process");
    const hasPrompt = Object.hasOwn(record, "prompt");
    const hasTerminal = Object.hasOwn(record, "terminal");
    const launch = hasLaunch ? readLaunchV1(record.launch, "corrupt") : undefined;
    const process = hasProcess ? readProcessValue(record.process, "corrupt") : undefined;
    const prompt = hasPrompt ? readPromptV1(record.prompt, "corrupt") : undefined;
    const terminal = hasTerminal ? readTerminalValue(record.terminal, "corrupt") : undefined;
    if (process !== undefined && launch === undefined) {
      fail("corrupt", "Dispatch process association is present without launch-pending.");
    }
    if (prompt !== undefined && process === undefined) {
      fail("corrupt", "Dispatch prompt fact is present without process association.");
    }
    if (prompt !== undefined && prompt.effectiveTimeoutMs > base.requestTimeoutMs) {
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
    rows.push(buildRowV1(base, state, {
      ...(launch === undefined ? {} : { launch }),
      ...(process === undefined ? {} : { process }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(terminal === undefined ? {} : { terminal }),
    }));
  }
  return Object.freeze(rows);
}

function readRowsV2(
  value: unknown,
  runId: string,
  origin: RunRecoveryOrigin,
  fixed: NativeHarnessDispatchInventoryFixed,
): readonly NativeHarnessDispatchRow[] {
  const rawRows = readArray(value, "dispatches", "corrupt");
  if (rawRows.length > NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_DISPATCHES) {
    fail("exhausted", "Dispatch inventory exceeds the 32-row limit.");
  }
  const allowedKeys = [...ROW_BASE_KEYS, ...ROW_OPTIONAL_KEYS_V2];
  const deadlineBound = originalInnerDeadlineBound(origin, fixed, "corrupt");
  const nonces = new Set<string>();
  const runtimeRoots = new Set<string>();
  const rows: NativeHarnessDispatchRow[] = [];
  for (const [index, rawRow] of rawRows.entries()) {
    const record = readOwnedRecord(rawRow, allowedKeys, ROW_BASE_KEYS, `dispatch row ${index + 1}`, "corrupt");
    const base = readBaseRow(record, index, runId, origin, fixed, deadlineBound, nonces);
    const stateValue = record.state;
    if (
      typeof stateValue !== "string"
      || !(DISPATCH_STATES_V2 as readonly string[]).includes(stateValue)
    ) {
      fail("corrupt", "Dispatch row state is not a bounded v2 lifecycle state.");
    }
    const state = stateValue as NativeHarnessDispatchState;
    const hasLaunch = Object.hasOwn(record, "launch");
    const hasProcess = Object.hasOwn(record, "process");
    const hasPrompt = Object.hasOwn(record, "prompt");
    const hasCleanup = Object.hasOwn(record, "cleanup");
    const hasTerminal = Object.hasOwn(record, "terminal");
    const launch = hasLaunch ? readLaunchV2(record.launch, "corrupt") : undefined;
    const process = hasProcess ? readProcessValue(record.process, "corrupt") : undefined;
    const prompt = hasPrompt ? readPromptV2(record.prompt, "corrupt") : undefined;
    const cleanup = hasCleanup ? readCleanupReceipt(record.cleanup, "corrupt") : undefined;
    const terminal = hasTerminal ? readTerminalValue(record.terminal, "corrupt") : undefined;
    if (process !== undefined && launch === undefined) {
      fail("corrupt", "Dispatch process association is present without launch-pending.");
    }
    if (prompt !== undefined && process === undefined) {
      fail("corrupt", "Dispatch prompt fact is present without process association.");
    }
    if (launch !== undefined) {
      if (launch.effectiveTimeoutMs > base.requestTimeoutMs) {
        fail("corrupt", "Dispatch launch timeout is not a narrowing of the actual request timeout.");
      }
      if (runtimeRoots.has(launch.runtimeRoot)) fail("corrupt", "Dispatch runtime root is not unique.");
      runtimeRoots.add(launch.runtimeRoot);
    }
    if (prompt !== undefined && launch !== undefined && prompt.effectiveTimeoutMs > launch.effectiveTimeoutMs) {
      fail("corrupt", "Dispatch prompt timeout widens the recorded launch timeout.");
    }
    if (cleanup !== undefined) {
      assertCleanupMatchesRow(base, cleanup, "corrupt");
      assertCleanupPrefixConsistency({ launch, process, prompt }, cleanup, "corrupt");
    }
    if (state === "terminal") {
      if (terminal === undefined || cleanup === undefined) {
        fail("corrupt", "Terminal dispatch row requires a prior cleanup receipt and observation.");
      }
      if (terminal.observationKind !== cleanup.observationKind) {
        fail("corrupt", "Terminal observation kind does not match its cleanup receipt.");
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
    if (state === "cleanup-observed") {
      if (cleanup === undefined || terminal !== undefined) {
        fail("corrupt", "Cleanup-observed dispatch row has an inconsistent lifecycle shape.");
      }
    }
    if (state === "intended" && (hasLaunch || hasProcess || hasPrompt || hasCleanup)) {
      fail("corrupt", "Intended dispatch row contains later lifecycle facts.");
    }
    if (state === "launch-pending" && (launch === undefined || hasProcess || hasPrompt || hasCleanup)) {
      fail("corrupt", "Launch-pending dispatch row has an inconsistent lifecycle shape.");
    }
    if (
      state === "process-bound"
      && (launch === undefined || process === undefined || hasPrompt || hasCleanup)
    ) {
      fail("corrupt", "Process-bound dispatch row has an inconsistent lifecycle shape.");
    }
    if (
      state === "prompt-pending"
      && (launch === undefined || process === undefined || prompt === undefined || hasCleanup)
    ) {
      fail("corrupt", "Prompt-pending dispatch row has an inconsistent lifecycle shape.");
    }
    rows.push(buildRowV2(base, state, {
      ...(launch === undefined ? {} : { launch }),
      ...(process === undefined ? {} : { process }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(cleanup === undefined ? {} : { cleanup }),
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
 * V1 bytes decode with their exact original schema and are never upgraded.
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
  const revision = readSafeInteger(record.revision, "inventory.revision", 0, "corrupt");
  const runId = readRunId(record.runId, "corrupt");
  if (runId !== expectedRunId) {
    fail("identity-mismatch", "Dispatch inventory belongs to a different run.");
  }
  const origin = readOriginValue(record.origin, runId);
  const fixed = readFixed(record.fixed, "corrupt");
  if (record.schema === NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA) {
    const dispatches = readRowsV1(record.dispatches, runId, origin, fixed);
    const inventory = buildInventoryV1(origin, fixed, runId, revision, dispatches);
    assertCapacityV1(inventory);
    return inventory;
  }
  if (record.schema === NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2) {
    const dispatches = readRowsV2(record.dispatches, runId, origin, fixed);
    const inventory = buildInventoryV2(origin, fixed, runId, revision, dispatches);
    assertCapacityV2(inventory);
    return inventory;
  }
  fail("corrupt", "Dispatch inventory schema is not recognized.");
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

function nextRevision(inventory: NativeHarnessDispatchInventoryV2): number {
  if (inventory.revision >= Number.MAX_SAFE_INTEGER) {
    fail("exhausted", "Dispatch inventory revision counter is exhausted.");
  }
  return inventory.revision + 1;
}

function applyIntentV2(
  inventory: NativeHarnessDispatchInventoryV2,
  intent: NativeHarnessDispatchIntent,
): NativeHarnessDispatchInventoryV2 {
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
  const row = buildRowV2({
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
  return buildInventoryV2(
    inventory.origin,
    inventory.fixed,
    inventory.runId,
    nextRevision(inventory),
    [...inventory.dispatches, row],
  );
}

function requireRow(
  inventory: NativeHarnessDispatchInventoryV2,
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

function applyLaunchV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  nonce: string,
  launch: NativeHarnessDispatchLaunch,
): NativeHarnessDispatchInventoryV2 {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "intended") {
    fail("invalid-transition", "Launch-pending requires an intended dispatch.");
  }
  if (launch.effectiveTimeoutMs > row.requestTimeoutMs) {
    fail("invalid-input", "Launch timeout is not a narrowing of the actual request timeout.");
  }
  if (inventory.dispatches.some((candidate) => candidate.launch?.runtimeRoot === launch.runtimeRoot)) {
    fail("conflict", "Dispatch runtime root is not unique.");
  }
  const next = buildRowV2(baseRowFacts(row), "launch-pending", {
    launch,
  });
  return replaceRowV2(inventory, ordinal, next);
}

function applyProcessV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  nonce: string,
  process: NativeHarnessDispatchProcess,
): NativeHarnessDispatchInventoryV2 {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "launch-pending" || row.launch === undefined) {
    fail("invalid-transition", "Process association requires a launch-pending dispatch.");
  }
  const next = buildRowV2(baseRowFacts(row), "process-bound", { launch: row.launch, process });
  return replaceRowV2(inventory, ordinal, next);
}

function applyPromptV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  nonce: string,
  prompt: NativeHarnessDispatchPrompt,
): NativeHarnessDispatchInventoryV2 {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state !== "process-bound" || row.launch === undefined || row.process === undefined) {
    fail("invalid-transition", "Prompt-pending requires a process-bound dispatch.");
  }
  if (prompt.effectiveTimeoutMs > row.launch.effectiveTimeoutMs) {
    fail("invalid-input", "Prompt timeout widens the recorded launch timeout.");
  }
  const next = buildRowV2(baseRowFacts(row), "prompt-pending", {
    launch: row.launch,
    process: row.process,
    prompt,
  });
  return replaceRowV2(inventory, ordinal, next);
}

function applyCleanupV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  nonce: string,
  receipt: NativeHarnessDispatchCleanupReceipt,
): NativeHarnessDispatchInventoryV2 {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state === "terminal" || row.state === "cleanup-observed" || row.cleanup !== undefined) {
    fail("invalid-transition", "Cleanup receipt is immutable and can be written only once.");
  }
  if (receipt.observationKind === "synthetic-fixture" && row.state !== "intended") {
    fail("invalid-transition", "Synthetic cleanup requires an intended dispatch with no launch facts.");
  }
  assertCleanupMatchesRow(row, receipt, "invalid-input");
  assertCleanupPrefixConsistency(row, receipt, "invalid-input");
  const next = buildRowV2(baseRowFacts(row), "cleanup-observed", {
    ...(row.launch === undefined ? {} : { launch: row.launch }),
    ...(row.process === undefined ? {} : { process: row.process }),
    ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
    cleanup: receipt,
  });
  return replaceRowV2(inventory, ordinal, next);
}

function applyTerminalV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  nonce: string,
  terminal: NativeHarnessDispatchTerminal,
): NativeHarnessDispatchInventoryV2 {
  const row = requireRow(inventory, ordinal, nonce);
  if (row.state === "terminal") {
    fail("invalid-transition", "Dispatch is already terminal; terminal observations are immutable.");
  }
  if (row.state !== "cleanup-observed" || row.cleanup === undefined) {
    fail("invalid-transition", "Terminal observation requires a prior cleanup receipt.");
  }
  if (terminal.observationKind !== row.cleanup.observationKind) {
    fail("invalid-input", "Terminal observation kind does not match its cleanup receipt.");
  }
  if (
    terminal.outcome === "completed"
    && terminal.observationKind === "runner-observation"
    && (row.launch === undefined || row.process === undefined || row.prompt === undefined)
  ) {
    fail("invalid-transition", "Runner-observation completion requires the recorded launch/process/prompt chain.");
  }
  const next = buildRowV2(baseRowFacts(row), "terminal", {
    ...(row.launch === undefined ? {} : { launch: row.launch }),
    ...(row.process === undefined ? {} : { process: row.process }),
    ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
    cleanup: row.cleanup,
    terminal,
  });
  return replaceRowV2(inventory, ordinal, next);
}

function replaceRowV2(
  inventory: NativeHarnessDispatchInventoryV2,
  ordinal: number,
  row: NativeHarnessDispatchRow,
): NativeHarnessDispatchInventoryV2 {
  const dispatches = inventory.dispatches.map((candidate) =>
    candidate.ordinal === ordinal ? row : candidate);
  return buildInventoryV2(
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
  const readOnly = initial.schema === NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA;

  const commit = async (
    mutate: (inventory: NativeHarnessDispatchInventoryV2) => NativeHarnessDispatchInventoryV2,
    guard: () => void,
    guardLabel: string,
  ): Promise<NativeHarnessDispatchInventory> => {
    if (readOnly) fail("read-only", "Published v1 dispatch inventories are diagnostic and read-only.");
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
        if (observed.inventory.schema !== NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2) {
          fail("changed", "Dispatch inventory version changed during a v2 handle operation.");
        }
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
        const candidate = mutate(observed.inventory as NativeHarnessDispatchInventoryV2);
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
      if (!writeAttempted) failPrewriteStoreConflict(error);
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

  const refuseReadOnlyMutation = (): void => {
    if (readOnly) {
      fail(
        "read-only",
        "Published v1 dispatch inventories are diagnostic and read-only; no mutation or migration is available.",
      );
    }
  };

  return Object.freeze({
    snapshot: () => checkpoint,
    intend: (intent: NativeHarnessDispatchIntent, advanceGuard: () => void) => {
      refuseReadOnlyMutation();
      const owned = readIntentValue(intent);
      const guard = readGuard(advanceGuard, "advance guard");
      return commit((inventory) => applyIntentV2(inventory, owned), guard, "advance guard");
    },
    markLaunched: (
      ordinal: number,
      nonce: string,
      launch: NativeHarnessDispatchLaunch,
      advanceGuard: () => void,
    ) => {
      refuseReadOnlyMutation();
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedLaunch = readLaunchV2(launch, "invalid-input");
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyLaunchV2(inventory, ownedOrdinal, ownedNonce, ownedLaunch),
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
      refuseReadOnlyMutation();
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedProcess = readProcessValue(process, "invalid-input");
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyProcessV2(inventory, ownedOrdinal, ownedNonce, ownedProcess),
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
      refuseReadOnlyMutation();
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedPrompt = readPromptV2(prompt, "invalid-input");
      const guard = readGuard(advanceGuard, "advance guard");
      return commit(
        (inventory) => applyPromptV2(inventory, ownedOrdinal, ownedNonce, ownedPrompt),
        guard,
        "advance guard",
      );
    },
    markCleanupObserved: (
      ordinal: number,
      nonce: string,
      receipt: NativeHarnessDispatchCleanupReceipt,
      cleanupGuard: () => void,
    ) => {
      refuseReadOnlyMutation();
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedReceipt = readCleanupReceipt(receipt, "invalid-input");
      const guard = readGuard(cleanupGuard, "cleanup guard");
      return commit(
        (inventory) => applyCleanupV2(inventory, ownedOrdinal, ownedNonce, ownedReceipt),
        guard,
        "cleanup guard",
      );
    },
    finalize: (
      ordinal: number,
      nonce: string,
      terminal: NativeHarnessDispatchTerminal,
      cleanupGuard: () => void,
    ) => {
      refuseReadOnlyMutation();
      const ownedOrdinal = readOrdinal(ordinal);
      const ownedNonce = readNonce(nonce);
      const ownedTerminal = readTerminalValue(terminal, "invalid-input");
      const guard = readGuard(cleanupGuard, "terminal cleanup guard");
      return commit(
        (inventory) => applyTerminalV2(inventory, ownedOrdinal, ownedNonce, ownedTerminal),
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
 * Creates the v2 sidecar for one already-existing actual recovery-origin run.
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
      const candidate = buildInventoryV2(locked.origin, locked.fixed, owned.runId, 0, []);
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
    if (!writeAttempted) failPrewriteStoreConflict(error);
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
 * repairs nothing and returns no execution/recovery authority. V1 sidecars
 * remain readable but their handle refuses every mutation.
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
