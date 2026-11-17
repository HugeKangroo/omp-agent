import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  HarnessController,
  OmpRpcRunner,
  decodeRunRecoveryOriginText,
  type HarnessRecoveryInspectionView,
  type OmpProfileAuth,
  type RunConfig,
  type RunRecord,
  type RunRecoveryOrigin,
  type RunRecoverySeed,
  type Runner,
  type WorkerRequest,
  type WorkerResult,
} from "../vendor/harness2/index.ts";
import type { NativeHarnessAccountingPrepared } from "./native-harness-accounting.ts";
import type { NativeContext } from "./native-entry.ts";
import {
  createNativeHarnessDispatchInventory,
  type NativeHarnessDispatchInventoryHandle,
  type NativeHarnessDispatchInventoryTestOptions,
  type NativeHarnessDispatchIntent,
  type NativeHarnessDispatchTerminal,
} from "./native-harness-dispatch-inventory.ts";
import type {
  StageRecord,
  WorkerLifecycleCleanupObservedEvent,
  WorkerLifecycleEvent,
  WorkerLifecycleResultObservedEvent,
} from "../vendor/harness2/upstream/src/types.ts";
import {
  NATIVE_HARNESS_COMPLETION_LIMITATIONS,
  NATIVE_HARNESS_COMPLETION_LIMITS,
  NATIVE_HARNESS_COMPLETION_ORIGIN,
  NATIVE_HARNESS_COMPLETION_SCHEMA,
  NATIVE_HARNESS_COMPLETION_SOLVER_IDS,
  NATIVE_HARNESS_COMPLETION_SOURCE_ID,
  NATIVE_HARNESS_COMPLETION_SOURCE_INTEGRITY,
  boundedCompletionPath,
  boundedCompletionReason,
  boundedCompletionToken,
  boundedCompletionHash,
  completionMetadataBytes,
  copyPreparedInputs,
  copyWitnessBase,
  copyWitnessFacts,
  copyWitnessResult,
  digestBoundedResultText,
  isPositiveSafeInteger,
  readOwnData,
  sameBoundedProjection,
  sameWitnessBase,
  sameWitnessResult,
  snapshotMatchesWitnessBase,
  type NativeHarnessBackendCompletion,
  type NativeHarnessCheckedBaseInput,
  type NativeHarnessCompletionBase,
  type NativeHarnessCompletionParent,
  type NativeHarnessCompletionPreparedInput,
  type NativeHarnessCompletionSelection,
  type NativeHarnessCompletionWitness,
} from "./native-harness-completion.ts";
import {
  NATIVE_HARNESS_MAX_DURATION_MS,
  NATIVE_HARNESS_MAX_PER_RUN_USD,
  NATIVE_HARNESS_MAX_TASK_BYTES,
  canonicalWorkerResultSha256,
  type NativeHarnessAssociation,
  type NativeHarnessBackend,
  type NativeHarnessPrepareAccounting,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "./native-harness-delegation.ts";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
  NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
  NATIVE_HARNESS_RECOVERY_SEED_SCHEMA,
  prepareNativeHarnessRecoverySource,
  verifyNativeHarnessRecoverySource,
  type NativeHarnessRecoverySourceFacts,
} from "./native-harness-recovery-source.ts";
import {
  NativeHarnessWorkspaceError,
  NATIVE_HARNESS_WORKSPACE_LIMITS,
  prepareNativeHarnessWorkspace,
  type NativeHarnessWorkspaceDescriptor,
  type NativeHarnessWorkspaceManifestEntry,
} from "./native-harness-workspace.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  sha256Hex,
  validateRelativePath,
  type NativeFileIo,
} from "./native-work.ts";
import {
  observeNativeHarnessReconciliation,
  type NativeHarnessReconciliationLifecycleOptions,
  type NativeHarnessReconciliationLifecycleResult,
} from "./native-harness-reconciliation-files.ts";
import type { NativeHarnessHistorySignalQuery } from "./native-harness-history-process.ts";

/**
 * Host-only composition of the frozen 2A delegation coordinator with the
 * vendored Harness2 Controller.
 *
 * The factory creates one private input snapshot and one private run store per
 * preparation. The Controller remains the owner of scheduling, run records,
 * cancellation, worker concurrency and cleanup. This adapter adds only the
 * base-input gate that must pass immediately before every actual worker
 * dispatch, and it never applies, resumes, accepts or promotes a candidate.
 */

export const NATIVE_HARNESS_BACKEND_SCHEMA = "omp-agent.native-harness-backend.v1" as const;
export const NATIVE_HARNESS_BACKEND_MAX_RETAINED = 16;
const NATIVE_HARNESS_BACKEND_DOMAIN = "generic";

const MAX_PATH_CHARS = 4096;
const MAX_MODEL_CHARS = 256;
const MAX_REASON_CHARS = 320;
const NUMERIC_EPSILON = 1e-9;
const MODEL_PATTERN = /^([a-z0-9][a-z0-9-]*)\/([^\s,:@]+)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
/** Existing B2 inspection locator shape; not the recovery-source format. */
const PREPARED_ROOT_PATTERN = /^omp-harness-[A-Za-z0-9]{6}$/;
const EXPECTED_ADAPTATION = Object.freeze({
  capabilities: "fixed" as const,
  reuse: false,
  learnMethods: false,
});
// reuse:false prevents cross-run library loading. It does not suppress the
// Controller's own private per-run lesson write into the unique store.

/** Exact host configuration. No model task, prompt or path selector is accepted. */
export interface NativeHarnessBackendHostConfig {
  /** Exact provider/model-id, used for both solver and improver stages. */
  readonly model: string;
  /** Absolute OMP executable path. */
  readonly ompCommand: string;
  readonly auth?: OmpProfileAuth;
  /** Existing private host directory; never the task workspace. */
  readonly storageRoot: string;
  /** Host-selected POSIX paths below the association workspace root. */
  readonly inputFiles: readonly string[];
}

/** Stable, non-authoritative host inspection facts. It never contains task or worker text. */
export interface NativeHarnessBackendDiagnostic {
  readonly schema: typeof NATIVE_HARNESS_BACKEND_SCHEMA;
  readonly preparedRoot: string | null;
  readonly workspaceRoot: string | null;
  readonly storeRoot: string | null;
  readonly inputManifestSha256: string | null;
  readonly inputFileCount: number;
  readonly inputBytes: number;
  readonly runId: string | null;
  readonly backendStatus: string | null;
  readonly retainedForInspection: boolean;
  readonly reason: string | null;
}

export interface NativeHarnessBackendHost {
  readonly runner: Runner;
  prepare(request: NativeHarnessPrepareRequest, context: NativeContext): Promise<NativeHarnessPrepareResult>;
  /** Optional so existing host fakes remain valid; the actual factory always supplies it. */
  inspectExisting?(
    target: NativeHarnessExistingInspectionTarget,
    context: NativeContext,
    control: NativeHarnessExistingInspectionControl,
  ): Promise<NativeHarnessExistingInspectionResult>;
  inspect(): readonly NativeHarnessBackendDiagnostic[];
}

export const NATIVE_HARNESS_EXISTING_INSPECTION_SCHEMA =
  "omp-agent.native-harness-existing-inspection.v1" as const;
export const NATIVE_HARNESS_EXISTING_INSPECTION_MAX_BYTES = 128 * 1024;

/** Exact locator only; it is not authority and never selects a new worker. */
export interface NativeHarnessExistingInspectionTarget {
  readonly runId: string;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly preparedRelativeRoot: string;
}

/** Trusted host current-read assertion plus the actual host signal. */
export interface NativeHarnessExistingInspectionControl {
  readonly signal: AbortSignal;
  readonly guard: () => void;
}

/** Bounded readonly diagnostic; it never carries a lease, claim or commit. */
export interface NativeHarnessExistingInspectionDiagnostic {
  readonly schema: typeof NATIVE_HARNESS_EXISTING_INSPECTION_SCHEMA;
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly runId: string;
  readonly leaseOwnerSha256: string;
  readonly observation: NativeHarnessReconciliationLifecycleResult;
}

export type NativeHarnessExistingInspectionResult =
  | { readonly ok: true; readonly diagnostic: NativeHarnessExistingInspectionDiagnostic }
  | { readonly ok: false; readonly reason: string };

/**
 * Test-only seams. Production callers must omit this argument; the default
 * runner is the actual OmpRpcRunner and the default clock is Date.now.
 */
export interface NativeHarnessBackendTestOptions {
  readonly deterministicRunner?: Runner;
  readonly now?: () => number;
  /** Runs after the Controller captured its base snapshot, before the gate reads it. */
  readonly beforeBaseInputCheck?: (facts: {
    readonly runId: string;
    readonly snapshotRoot: string;
  }) => void | Promise<void>;
  /** Mutates the Controller-built worker request before any gate check. */
  readonly mutateWorkerRequest?: (request: WorkerRequest) => void;
  /** Test-only inventory read/write observation seams; production omits this. */
  readonly dispatchInventoryTestOptions?: NativeHarnessDispatchInventoryTestOptions;
  /**
   * Test-only B2 file and signal-query seams for leased inspection. The
   * actual AbortSignal always comes from the inspection control, never here.
   */
  readonly recoveryInspectionOptions?: {
    readonly fileIo?: NativeFileIo;
    readonly signalQuery?: NativeHarnessHistorySignalQuery;
  };
}

interface RecoveryInspectionTestOptions {
  readonly fileIo: NativeFileIo | null;
  readonly signalQuery: NativeHarnessHistorySignalQuery | null;
}

interface NormalizedTestOptions {
  readonly deterministicRunner: Runner | null;
  readonly now: (() => number) | null;
  readonly beforeBaseInputCheck: ((facts: {
    readonly runId: string;
    readonly snapshotRoot: string;
  }) => void | Promise<void>) | null;
  readonly mutateWorkerRequest: ((request: WorkerRequest) => void) | null;
  readonly dispatchInventoryTestOptions: NativeHarnessDispatchInventoryTestOptions | null;
  readonly recoveryInspectionOptions: RecoveryInspectionTestOptions | null;
}

interface RetainedRecord {
  preparedRoot: string | null;
  workspaceRoot: string | null;
  storeRoot: string | null;
  inputManifestSha256: string | null;
  inputFileCount: number;
  inputBytes: number;
  runId: string | null;
  backendStatus: string | null;
  retainedForInspection: boolean;
  reason: string | null;
}

interface DurableBackendState {
  readonly source: NativeHarnessRecoverySourceFacts;
  readonly seedText: string;
  readonly expectedSeed: RunRecoverySeed;
  readonly accountingPrepared: NativeHarnessAccountingPrepared;
  readonly accounting: NativeHarnessPrepareAccounting;
  readonly association: NativeHarnessAssociation;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  createAttempted: boolean;
  origin: RunRecoveryOrigin | null;
  executionRefusal: string | null;
  inventory: NativeHarnessDispatchInventoryHandle | null;
  inventoryClosed: boolean;
  closeRequested: boolean;
  readonly inventoryPending: Set<Promise<unknown>>;
  completionRows: readonly { readonly state: string; readonly ordinal: number }[] | null;
}

/** Plugin-private request bridge; consumed by this plugin's coordinator, never a model input. */
export const NATIVE_HARNESS_LIFECYCLE_FIELD = "nativeHarnessLifecycle" as const;

export interface NativeHarnessLifecycleBridge {
  readonly innerDeadlineAt: number;
  readonly assertAdvanceCurrent: () => void;
  readonly checkpoint: (event: WorkerLifecycleEvent, assertPersistable: () => void) => Promise<void>;
}

interface DurableDispatchAcknowledgement {
  cleanup: WorkerLifecycleCleanupObservedEvent | null;
  terminal: WorkerLifecycleResultObservedEvent | null;
}

interface BackendState {
  controller: HarnessController | null;
  descriptor: NativeHarnessWorkspaceDescriptor | null;
  runId: string | null;
  taskSha256: string | null;
  status: string | null;
  readonly durable: DurableBackendState | null;
  readonly record: RetainedRecord;
  readonly completion: BackendCompletionState;
}

interface WitnessSlot {
  bytes: number;
  witness: NativeHarnessCompletionWitness;
}

interface BackendCompletionState {
  sequence: number;
  readonly witnesses: WitnessSlot[];
  witnessBytes: number;
  overflow: boolean;
  overflowReason: string | null;
  witnessFailure: string | null;
  provenanceFailure: string | null;
  issued: NativeHarnessBackendCompletion | null;
  conflicted: boolean;
  conflictReason: string | null;
}

interface MatchedCompletionStage {
  readonly selection: NativeHarnessCompletionSelection;
  readonly base: NativeHarnessCompletionBase;
  readonly parent: NativeHarnessCompletionParent | null;
}

interface PrepareBudget {
  readonly maxCostUsd: number;
  readonly deadlineAt: number;
  readonly maxDurationMs: number;
}

interface GateExpectation {
  readonly state: BackendState;
  readonly host: NativeHarnessBackendHostConfig;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
  readonly budget: PrepareBudget;
  readonly options: NormalizedTestOptions;
  readonly durable: DurableBackendState | null;
}

interface PrepareFacts {
  readonly workspaceRoot: string;
  readonly budget: PrepareBudget;
  readonly signal: AbortSignal;
  readonly runner: Runner;
  readonly guard: () => void;
  readonly association: NativeHarnessAssociation | null;
  readonly accounting: NativeHarnessPrepareAccounting | null;
}

type StrictFields = ReadonlyMap<string, unknown>;

/**
 * Identity index from one actual frozen backend object to its private state.
 * This is not a run registry: it holds no extra completion capability and is
 * set exactly once by makeBackend.
 */
const BACKEND_COMPLETION_STATES = new WeakMap<object, BackendState>();

class CompletionUnavailable extends Error {}

function createCompletionState(): BackendCompletionState {
  return {
    sequence: 0,
    witnesses: [],
    witnessBytes: 0,
    overflow: false,
    overflowReason: null,
    witnessFailure: null,
    provenanceFailure: null,
    issued: null,
    conflicted: false,
    conflictReason: null,
  };
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();
const ACTUAL_PROMISE_THEN = (() => {
  try {
    return Promise.prototype.then;
  } catch {
    return null;
  }
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function boundedText(value: string, max: number): string {
  const raw = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const normalized = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function boundedReason(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error && typeof value.message === "string") {
    text = value.message;
  } else {
    try {
      text = String(value);
    } catch {
      text = "unreadable failure";
    }
  }
  const normalized = text.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "unreadable failure";
  return normalized.length <= MAX_REASON_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_REASON_CHARS - 3)}...`;
}

function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): StrictFields | null {
  if (!isRecord(value)) return null;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string")) return null;
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return null;
  return fields;
}

function readAbsolutePath(value: unknown, label: string, max = MAX_PATH_CHARS): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
    || !path.isAbsolute(value)
  ) {
    throw new Error(`${label} must be a bounded absolute path`);
  }
  return value;
}

function readModel(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > MAX_MODEL_CHARS
    || /[\x00-\x1f\x7f]/.test(value)
    || !MODEL_PATTERN.test(value)
    || /[?*]/.test(value)
  ) {
    throw new Error("model must be one exact provider/model-id without wildcards");
  }
  return value;
}

function readAuth(value: unknown): OmpProfileAuth {
  const fields = readStrictFields(value, ["kind", "agentDir"], ["kind", "agentDir"]);
  if (fields === null || fields.get("kind") !== "omp-profile") {
    throw new Error("auth must be an exact omp-profile object");
  }
  return deepFreeze({
    kind: "omp-profile" as const,
    agentDir: readAbsolutePath(fields.get("agentDir"), "auth.agentDir"),
  });
}

function readInputFiles(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("inputFiles must be a plain array");
  }
  if (value.length < 1 || value.length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles) {
    throw new Error(`inputFiles must select 1-${NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles} files`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) {
    throw new Error("inputFiles must not contain holes or extra properties");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (
      typeof key !== "string"
      || !/^(?:0|[1-9][0-9]*)$/.test(key)
      || Number(key) >= value.length
    ) {
      throw new Error("inputFiles must not contain holes or extra properties");
    }
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      throw new Error("inputFiles entries must be enumerable own data strings");
    }
    let relative: string;
    try {
      relative = validateRelativePath(descriptor.value);
    } catch (error) {
      if (error instanceof NativeFileError) throw new Error("inputFiles entries must be safe relative POSIX paths");
      throw error;
    }
    if (seen.has(relative)) throw new Error("inputFiles must not contain duplicate paths");
    seen.add(relative);
    files.push(relative);
  }
  return Object.freeze(files);
}

function readHostConfig(value: unknown): NativeHarnessBackendHostConfig {
  const fields = readStrictFields(
    value,
    ["model", "ompCommand", "auth", "storageRoot", "inputFiles"],
    ["model", "ompCommand", "storageRoot", "inputFiles"],
  );
  if (fields === null) {
    throw new Error("hostConfig must be an exact plain object with model, ompCommand, storageRoot and inputFiles");
  }
  const authValue = fields.get("auth");
  const auth = authValue === undefined ? undefined : readAuth(authValue);
  return deepFreeze({
    model: readModel(fields.get("model")),
    ompCommand: readAbsolutePath(fields.get("ompCommand"), "ompCommand"),
    storageRoot: readAbsolutePath(fields.get("storageRoot"), "storageRoot"),
    inputFiles: readInputFiles(fields.get("inputFiles")),
    ...(auth === undefined ? {} : { auth }),
  });
}

function readCallable(value: unknown, label: string): Function {
  if (typeof value !== "function") throw new Error(`${label} must be a function`);
  return value;
}

function readRunner(value: unknown, label: string): Runner {
  if (!isRecord(value)) throw new Error(`${label} must be a runner object`);
  readCallable(value.run, `${label}.run`);
  return value as unknown as Runner;
}

function readRecoveryInspectionTestOptions(value: unknown): RecoveryInspectionTestOptions | null {
  if (value === undefined) return null;
  const fields = readStrictFields(value, ["fileIo", "signalQuery"], []);
  if (fields === null) throw new Error("recoveryInspectionOptions must be an exact plain object");
  const ioValue = fields.get("fileIo");
  let fileIo: NativeFileIo | null = null;
  if (ioValue !== undefined) {
    if (typeof ioValue !== "object" || ioValue === null) {
      throw new Error("recoveryInspectionOptions.fileIo must be a native file IO seam");
    }
    const candidate = ioValue as NativeFileIo;
    if (
      typeof candidate.O_RDONLY !== "number"
      || typeof candidate.O_NOFOLLOW !== "number"
      || typeof candidate.realpath !== "function"
      || typeof candidate.lstat !== "function"
      || typeof candidate.open !== "function"
    ) {
      throw new Error("recoveryInspectionOptions.fileIo must be a native file IO seam");
    }
    fileIo = candidate;
  }
  const signalQueryValue = fields.get("signalQuery");
  if (signalQueryValue !== undefined && typeof signalQueryValue !== "function") {
    throw new Error("recoveryInspectionOptions.signalQuery must be a narrow synchronous function");
  }
  return Object.freeze({
    fileIo,
    signalQuery: signalQueryValue === undefined ? null : signalQueryValue as NativeHarnessHistorySignalQuery,
  });
}

function readTestOptions(value: unknown): NormalizedTestOptions {
  if (value === undefined) {
    return {
      deterministicRunner: null,
      now: null,
      beforeBaseInputCheck: null,
      mutateWorkerRequest: null,
      dispatchInventoryTestOptions: null,
      recoveryInspectionOptions: null,
    };
  }
  const fields = readStrictFields(
    value,
    ["deterministicRunner", "now", "beforeBaseInputCheck", "mutateWorkerRequest", "dispatchInventoryTestOptions", "recoveryInspectionOptions"],
    [],
  );
  if (fields === null) throw new Error("test options must be an exact plain object");
  const runnerValue = fields.get("deterministicRunner");
  const nowValue = fields.get("now");
  const beforeValue = fields.get("beforeBaseInputCheck");
  const mutateValue = fields.get("mutateWorkerRequest");
  if (nowValue !== undefined) readCallable(nowValue, "now");
  if (beforeValue !== undefined) readCallable(beforeValue, "beforeBaseInputCheck");
  if (mutateValue !== undefined) readCallable(mutateValue, "mutateWorkerRequest");
  return {
    deterministicRunner: runnerValue === undefined ? null : readRunner(runnerValue, "deterministicRunner"),
    now: nowValue === undefined ? null : nowValue as () => number,
    beforeBaseInputCheck: beforeValue === undefined
      ? null
      : beforeValue as NormalizedTestOptions["beforeBaseInputCheck"],
    mutateWorkerRequest: mutateValue === undefined
      ? null
      : mutateValue as (request: WorkerRequest) => void,
    dispatchInventoryTestOptions: fields.get("dispatchInventoryTestOptions") === undefined
      ? null
      : fields.get("dispatchInventoryTestOptions") as NativeHarnessDispatchInventoryTestOptions,
    recoveryInspectionOptions: readRecoveryInspectionTestOptions(fields.get("recoveryInspectionOptions")),
  };
}

function readNow(now: () => number): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw new Error("the backend clock is unavailable");
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
    throw new Error("the backend clock is unavailable");
  }
  return value;
}

function signalAborted(signal: unknown): boolean | null {
  if (ACTUAL_ABORTED_GETTER === null) return null;
  try {
    const value: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

interface OwnedExistingInspectionTarget {
  readonly runId: string;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly preparedRelativeRoot: string;
}

interface OwnedExistingInspectionControl {
  readonly signal: AbortSignal;
  readonly guard: () => void;
}

function readExistingInspectionTarget(value: unknown): OwnedExistingInspectionTarget {
  const fields = readStrictFields(
    value,
    ["runId", "ownerId", "selectorSha256", "preparedRelativeRoot"],
    ["runId", "ownerId", "selectorSha256", "preparedRelativeRoot"],
  );
  if (fields === null) {
    throw new Error("existing inspection target must be an exact plain own-data object");
  }
  const runId = fields.get("runId");
  if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) {
    throw new Error("existing inspection target.runId must be a lowercase UUID");
  }
  const ownerId = fields.get("ownerId");
  if (typeof ownerId !== "string" || !UUID_PATTERN.test(ownerId)) {
    throw new Error("existing inspection target.ownerId must be a lowercase UUID");
  }
  const selectorSha256 = fields.get("selectorSha256");
  if (typeof selectorSha256 !== "string" || !HEX_64_PATTERN.test(selectorSha256)) {
    throw new Error("existing inspection target.selectorSha256 must be 64 lowercase hexadecimal characters");
  }
  let preparedRelativeRoot: string;
  try {
    preparedRelativeRoot = validateRelativePath(fields.get("preparedRelativeRoot"));
  } catch {
    throw new Error("existing inspection target.preparedRelativeRoot must be a safe relative POSIX path");
  }
  if (!PREPARED_ROOT_PATTERN.test(preparedRelativeRoot)) {
    throw new Error(
      "existing inspection target.preparedRelativeRoot must be omp-harness- plus six ASCII alphanumerics",
    );
  }
  return Object.freeze({ runId, ownerId, selectorSha256, preparedRelativeRoot });
}

function readExistingInspectionControl(value: unknown): OwnedExistingInspectionControl {
  const fields = readStrictFields(value, ["signal", "guard"], ["signal", "guard"]);
  if (fields === null) {
    throw new Error("existing inspection control must be an exact plain own-data object");
  }
  const signal = fields.get("signal");
  const aborted = signalAborted(signal);
  if (aborted === null) {
    throw new Error("existing inspection control.signal must be an actual host AbortSignal");
  }
  if (aborted) throw new Error("existing inspection control.signal is already aborted");
  const guard = fields.get("guard");
  if (typeof guard !== "function") {
    throw new Error("existing inspection control.guard must be a function");
  }
  return Object.freeze({ signal: signal as AbortSignal, guard: guard as () => void });
}

function inspectionSignalCheck(control: OwnedExistingInspectionControl): void {
  const aborted = signalAborted(control.signal);
  if (aborted === null) throw new Error("existing inspection signal became unreadable");
  if (aborted) throw new Error("existing inspection signal is aborted");
}

function inspectionControlCheck(control: OwnedExistingInspectionControl): void {
  const result: unknown = control.guard();
  if (result !== undefined) {
    // Consume a genuine native Promise rejection; never consult a foreign then.
    observeNativePromiseSettlement(result);
    throw new Error("existing inspection guard must return undefined synchronously");
  }
  inspectionSignalCheck(control);
}

/** One fixed directory operation followed by the host's current-read check. */
async function checkedInspectionDirectory(
  target: string,
  label: string,
  control: OwnedExistingInspectionControl,
): Promise<string> {
  const resolved = await realDirectoryExact(target, label);
  inspectionControlCheck(control);
  return resolved;
}

function existingInspectionOwnerRoundsMatch(
  observation: NativeHarnessReconciliationLifecycleResult,
  leaseOwnerSha256: string,
): "match" | "unavailable" | "mismatch" {
  const lease = observation.lifecycle.controllerLease;
  const first = lease.ownerRound1;
  const second = lease.ownerRound2;
  if (
    first === null
    || second === null
    || lease.lockDirectoryRound1 !== "present"
    || lease.lockDirectoryRound2 !== "present"
    || first.state !== "observed"
    || second.state !== "observed"
    || first.ownerState !== "observed"
    || second.ownerState !== "observed"
  ) return "unavailable";
  return first.sha256 === leaseOwnerSha256 && second.sha256 === leaseOwnerSha256
    ? "match"
    : "mismatch";
}

/**
 * Returns a bounded refusal reason, or null only when the B2 lifecycle result
 * itself contains the exact two-round controller-owner proof. A stable primary
 * byte observation never substitutes for that proof.
 */
function existingInspectionRefusal(
  observation: NativeHarnessReconciliationLifecycleResult,
  leaseOwnerSha256: string,
): string | null {
  if (observation.metadataStatus === "incompatible") {
    const code = observation.lifecycle.failure?.code ?? "metadata-incompatible";
    return `existing inspection refused: metadata-incompatible/${code}`;
  }
  const failureCode = observation.lifecycle.failure?.code;
  const suffix = failureCode === undefined ? "" : `/${failureCode}`;
  if (observation.status !== "stable" || observation.observation !== "two-pass") {
    return `existing inspection refused: observation-${observation.status}${suffix}`;
  }
  if (observation.metadataStatus !== "compatible") {
    return `existing inspection refused: metadata-${observation.metadataStatus}${suffix}`;
  }
  if (
    observation.captures.length !== 8
    || observation.captures.some((capture) =>
      capture.outcome !== "captured"
      || capture.openedFiles !== 1
      || !capture.close.attempted
      || !capture.close.settled
      || !capture.close.succeeded)
    || observation.captures.some((capture) => capture.pass === 2 && capture.matchesFirstPass !== true)
    || !observation.pins.stable
    || !observation.pins.checkedAtEnd
    || observation.deadline.expired
  ) {
    return `existing inspection refused: primary-window-unstable${suffix}`;
  }
  const initial = observation.initialInputs;
  if (initial === undefined || initial.revoked) {
    return `existing inspection refused: initial-inputs-${initial === undefined ? "missing" : "revoked"}${suffix}`;
  }
  if (initial.status === "stable") {
    const initialObservation = initial.observation;
    if (
      initial.provisionalStatus !== "stable"
      || initialObservation === null
      || initialObservation.status !== "stable"
      || initialObservation.observation !== "two-pass"
      || initialObservation.passes !== 2
      || initialObservation.captureStarts !== initial.captureStarts
      || initialObservation.chargedBytes !== initial.chargedBytes
      || initialObservation.chargeLimitBytes !== initial.chargeLimitBytes
      || initialObservation.captureStarts < 1
      || initialObservation.captureStarts > 32
      || initialObservation.chargedBytes > initialObservation.chargeLimitBytes
      || initialObservation.close.attempted !== initialObservation.openedFiles
      || initialObservation.close.settled !== initialObservation.openedFiles
      || initialObservation.close.succeeded !== initialObservation.openedFiles
    ) {
      return `existing inspection refused: initial-inputs-inconsistent${suffix}`;
    }
  } else if (initial.status === "not-applicable") {
    if (initial.provisionalStatus !== "not-applicable" || initial.observation !== null) {
      return `existing inspection refused: initial-inputs-not-applicable-inconsistent${suffix}`;
    }
  } else {
    return `existing inspection refused: initial-inputs-${initial.status}${suffix}`;
  }
  if (observation.lifecycle.window.roundsStarted !== 2 || observation.lifecycle.window.expired) {
    return `existing inspection refused: lifecycle-window-${observation.lifecycle.window.roundsStarted}${suffix}`;
  }
  if (observation.lifecycle.revoked || observation.lifecycle.status !== "stable") {
    return `existing inspection refused: lifecycle-${observation.lifecycle.status}${suffix}`;
  }
  if (
    observation.lifecycle.completeAttemptCoverage.status !== "complete"
    && observation.lifecycle.completeAttemptCoverage.status !== "not-required"
  ) {
    return `existing inspection refused: attempt-coverage-${observation.lifecycle.completeAttemptCoverage.status}${suffix}`;
  }
  if (
    observation.lifecycle.controllerLease.status !== "stable"
    || observation.lifecycle.controllerLease.ownerComparison !== "stable"
  ) {
    return `existing inspection refused: controller-lease-${observation.lifecycle.controllerLease.status}${suffix}`;
  }
  const owners = existingInspectionOwnerRoundsMatch(observation, leaseOwnerSha256);
  if (owners === "unavailable") return `existing inspection refused: owner-rounds-unavailable${suffix}`;
  if (owners === "mismatch") return `existing inspection refused: owner-rounds-mismatch${suffix}`;
  return null;
}

function isThenable(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

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

/**
 * The recovery source leaf and this backend share one synchronous guard
 * contract. Durable preparation must not hide a Promise or thenable returned
 * by the host guard: a real Promise rejection is observed and refused, and a
 * foreign thenable is refused without invoking its `then`.
 */
function assertSynchronousGuardResult(result: unknown): void {
  if (observeNativePromiseSettlement(result)) {
    throw new Error("preparation guard must be synchronous and must not return a Promise");
  }
  if (isThenable(result)) {
    throw new Error("preparation guard must be synchronous and must not return a Promise or thenable");
  }
}

function readBoundedString(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function readFullAssociation(value: unknown): NativeHarnessAssociation {
  const fields = readStrictFields(
    value,
    ["observationId", "generation", "sessionId", "workspaceRoot", "toolCallId", "toolName"],
    ["observationId", "generation", "sessionId", "workspaceRoot", "toolCallId", "toolName"],
  );
  if (fields === null) throw new Error("durable prepare association must contain all six exact fields");
  const generation = fields.get("generation");
  if (
    typeof generation !== "number"
    || !Number.isSafeInteger(generation)
    || generation < 1
  ) {
    throw new Error("association.generation must be a positive safe integer");
  }
  const toolName = fields.get("toolName");
  if (toolName !== "agent_harness") throw new Error("association.toolName must be agent_harness");
  return deepFreeze({
    observationId: readBoundedString(fields.get("observationId"), "association.observationId", 1024),
    generation,
    sessionId: readBoundedString(fields.get("sessionId"), "association.sessionId", 1024),
    workspaceRoot: readAbsolutePath(fields.get("workspaceRoot"), "association.workspaceRoot"),
    toolCallId: readBoundedString(fields.get("toolCallId"), "association.toolCallId", 256),
    toolName: "agent_harness" as const,
  });
}

function readPrepareAccounting(value: unknown): NativeHarnessPrepareAccounting {
  const fields = readStrictFields(
    value,
    ["ownerId", "admissionId", "reserveRevision", "sourceAssociationSha256", "admittedAt"],
    ["ownerId", "admissionId", "reserveRevision", "sourceAssociationSha256", "admittedAt"],
  );
  if (fields === null) {
    throw new Error("durable prepare accounting must contain all five exact fields");
  }
  const ownerId = fields.get("ownerId");
  const admissionId = fields.get("admissionId");
  const reserveRevision = fields.get("reserveRevision");
  const sourceAssociationSha256 = fields.get("sourceAssociationSha256");
  const admittedAt = fields.get("admittedAt");
  if (typeof ownerId !== "string" || !UUID_PATTERN.test(ownerId)) {
    throw new Error("accounting.ownerId must be a lowercase UUID");
  }
  if (typeof admissionId !== "string" || !UUID_PATTERN.test(admissionId)) {
    throw new Error("accounting.admissionId must be a lowercase UUID");
  }
  if (
    typeof reserveRevision !== "number"
    || !Number.isSafeInteger(reserveRevision)
    || reserveRevision < 1
  ) {
    throw new Error("accounting.reserveRevision must be a positive safe integer");
  }
  if (typeof sourceAssociationSha256 !== "string" || !HEX_64_PATTERN.test(sourceAssociationSha256)) {
    throw new Error("accounting.sourceAssociationSha256 must be 64 lowercase hexadecimal characters");
  }
  if (
    typeof admittedAt !== "number"
    || !Number.isSafeInteger(admittedAt)
    || admittedAt < 1
  ) {
    throw new Error("accounting.admittedAt must be a positive safe integer");
  }
  return deepFreeze({ ownerId, admissionId, reserveRevision, sourceAssociationSha256, admittedAt });
}

function readPrepareFacts(value: unknown): PrepareFacts {
  const fields = readStrictFields(
    value,
    ["association", "budget", "signal", "runner", "guard", "accounting"],
    ["association", "budget", "signal", "runner", "guard"],
  );
  if (fields === null) throw new Error("prepare request must be an exact plain object");
  const association = fields.get("association");
  const accounting = fields.has("accounting") ? readPrepareAccounting(fields.get("accounting")) : null;
  let associationFacts: NativeHarnessAssociation | null = null;
  let workspaceRoot: string;
  if (accounting === null) {
    const associationFields = readStrictFields(
      association,
      ["observationId", "generation", "sessionId", "workspaceRoot", "toolCallId", "toolName"],
      ["workspaceRoot"],
    );
    if (associationFields === null) throw new Error("prepare association is unreadable");
    workspaceRoot = readAbsolutePath(associationFields.get("workspaceRoot"), "association.workspaceRoot");
  } else {
    associationFacts = readFullAssociation(association);
    workspaceRoot = associationFacts.workspaceRoot;
    const associationSha256 = sha256Hex(JSON.stringify({
      observationId: associationFacts.observationId,
      generation: associationFacts.generation,
      sessionId: associationFacts.sessionId,
      workspaceRoot: associationFacts.workspaceRoot,
      toolCallId: associationFacts.toolCallId,
      toolName: associationFacts.toolName,
    }));
    if (associationSha256 !== accounting.sourceAssociationSha256) {
      throw new Error("accounting.sourceAssociationSha256 does not match the owned association");
    }
  }
  const budget = readBudget(fields.get("budget"));
  if (accounting !== null) {
    if (
      budget.maxCostUsd > 1
      || budget.maxDurationMs > 300_000
      || !Number.isSafeInteger(accounting.admittedAt + budget.maxDurationMs)
      || accounting.admittedAt + budget.maxDurationMs !== budget.deadlineAt
    ) {
      throw new Error("durable prepare budget must match accounting.admittedAt and the fixed admission bounds");
    }
  }
  const signal = fields.get("signal");
  const aborted = signalAborted(signal);
  if (aborted === null) throw new Error("prepare signal is not a readable host AbortSignal");
  if (aborted) throw new Error("preparation was aborted before any effect");
  const runner = readRunner(fields.get("runner"), "prepare runner");
  const guard = readCallable(fields.get("guard"), "prepare guard");
  return {
    workspaceRoot,
    budget,
    signal: signal as AbortSignal,
    runner,
    guard: guard as () => void,
    association: associationFacts,
    accounting,
  };
}

function readBudget(value: unknown): PrepareBudget {
  const fields = readStrictFields(value, ["maxCostUsd", "deadlineAt", "maxDurationMs"], [
    "maxCostUsd",
    "deadlineAt",
    "maxDurationMs",
  ]);
  if (fields === null) throw new Error("prepare budget is unreadable");
  const maxCostUsd = fields.get("maxCostUsd");
  const deadlineAt = fields.get("deadlineAt");
  const maxDurationMs = fields.get("maxDurationMs");
  if (
    typeof maxCostUsd !== "number"
    || !Number.isFinite(maxCostUsd)
    || maxCostUsd <= 0
    || maxCostUsd > NATIVE_HARNESS_MAX_PER_RUN_USD
  ) {
    throw new Error("prepare budget maxCostUsd is outside the supported bound");
  }
  if (
    typeof deadlineAt !== "number"
    || !Number.isFinite(deadlineAt)
    || deadlineAt <= 0
    || !Number.isSafeInteger(deadlineAt)
  ) {
    throw new Error("prepare budget deadlineAt is invalid");
  }
  if (
    typeof maxDurationMs !== "number"
    || !Number.isFinite(maxDurationMs)
    || maxDurationMs <= 0
    || maxDurationMs > NATIVE_HARNESS_MAX_DURATION_MS
  ) {
    throw new Error("prepare budget maxDurationMs is outside the supported bound");
  }
  return Object.freeze({ maxCostUsd, deadlineAt, maxDurationMs });
}

function readTask(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("backend task must be a nonempty string");
  }
  if (value.includes("\0")) throw new Error("backend task must not contain NUL");
  if (Buffer.byteLength(value, "utf8") > NATIVE_HARNESS_MAX_TASK_BYTES) {
    throw new Error(`backend task exceeds ${NATIVE_HARNESS_MAX_TASK_BYTES} UTF-8 bytes`);
  }
  return value;
}

function sumInputBytes(manifest: readonly NativeHarnessWorkspaceManifestEntry[]): number {
  return manifest.reduce((total, entry) => total + entry.bytes, 0);
}

function recordFromDescriptor(
  descriptor: NativeHarnessWorkspaceDescriptor,
  retainedForInspection: boolean,
  reason: string | null,
): RetainedRecord {
  return {
    preparedRoot: descriptor.preparedRoot,
    workspaceRoot: descriptor.workspaceRoot,
    storeRoot: descriptor.storeRoot,
    inputManifestSha256: descriptor.manifestSha256,
    inputFileCount: descriptor.inputManifest.length,
    inputBytes: sumInputBytes(descriptor.inputManifest),
    runId: null,
    backendStatus: null,
    retainedForInspection,
    reason: reason === null ? null : boundedReason(reason),
  };
}

function recordFromPreparedRoot(preparedRoot: string, reason: string): RetainedRecord {
  return {
    preparedRoot,
    workspaceRoot: null,
    storeRoot: null,
    inputManifestSha256: null,
    inputFileCount: 0,
    inputBytes: 0,
    runId: null,
    backendStatus: null,
    retainedForInspection: true,
    reason: boundedReason(reason),
  };
}

function retain(records: RetainedRecord[], record: RetainedRecord): void {
  if (records.length >= NATIVE_HARNESS_BACKEND_MAX_RETAINED) records.shift();
  records.push(record);
}

function diagnosticOf(record: RetainedRecord): NativeHarnessBackendDiagnostic {
  return deepFreeze({
    schema: NATIVE_HARNESS_BACKEND_SCHEMA,
    preparedRoot: record.preparedRoot,
    workspaceRoot: record.workspaceRoot,
    storeRoot: record.storeRoot,
    inputManifestSha256: record.inputManifestSha256,
    inputFileCount: record.inputFileCount,
    inputBytes: record.inputBytes,
    runId: record.runId,
    backendStatus: record.backendStatus,
    retainedForInspection: record.retainedForInspection,
    reason: record.reason,
  });
}

function failed(reason: unknown): NativeHarnessPrepareResult {
  return { ok: false, reason: boundedReason(reason) };
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realDirectoryExact(target: string, label: string): Promise<string> {
  const absolute = path.resolve(target);
  let info;
  try {
    info = await lstat(absolute, { bigint: true });
  } catch {
    throw new Error(`${label} is missing or unreadable`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is not a real directory`);
  }
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    throw new Error(`${label} could not be resolved`);
  }
  if (resolved !== absolute) throw new Error(`${label} traverses a link`);
  return resolved;
}

const ORIGIN_FIELDS = [
  "schema",
  "nonce",
  "runId",
  "createdAt",
  "recordIdentitySha256",
  "seed",
] as const;
const ORIGIN_SEED_FIELDS = [
  "schema",
  "profile",
  "accountingOwnerId",
  "admissionId",
  "accountingOwnerRevision",
  "sourceAssociationSha256",
  "sourceDescriptorSha256",
  "inputManifestSha256",
  "admittedAt",
  "deadlineAt",
  "allocatedCostUsd",
] as const;

function boundedOriginString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`recovery origin ${label} is unreadable`);
  }
  return value;
}

/**
 * Validate the four seed numbers before JSON serialization. A non-number can
 * carry a toJSON hook; NaN/Infinity serialize to null; an unsafe integer may
 * round. The vendor decoder still owns the full admission ranges.
 */
function boundedOriginNumber(value: unknown, label: string, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`recovery origin seed ${label} is not a finite number`);
  }
  if (integer && !Number.isSafeInteger(value)) {
    throw new Error(`recovery origin seed ${label} is not a safe integer`);
  }
  return value;
}

/**
 * Explicit bounded own-data projection of the actual record's origin. The
 * vendor decoder then checks the fixed shape and run ID. It does not by itself
 * prove the surrounding record identity; the Store get/create already did.
 */
function originFromRecord(record: RunRecord, runId: string): RunRecoveryOrigin {
  const originValue = readOwnData(record, "recoveryOrigin");
  if (!originValue.present || !originValue.readable) {
    throw new Error("actual run record has no readable recovery origin");
  }
  const fields = readStrictFields(originValue.value, ORIGIN_FIELDS, ORIGIN_FIELDS);
  if (fields === null) throw new Error("actual run recovery origin is malformed");
  const seedFields = readStrictFields(fields.get("seed"), ORIGIN_SEED_FIELDS, ORIGIN_SEED_FIELDS);
  if (seedFields === null) throw new Error("actual run recovery seed is malformed");
  const projection = {
    schema: boundedOriginString(fields.get("schema"), "schema", 64),
    nonce: boundedOriginString(fields.get("nonce"), "nonce", 64),
    runId: boundedOriginString(fields.get("runId"), "runId", 64),
    createdAt: boundedOriginString(fields.get("createdAt"), "createdAt", 64),
    recordIdentitySha256: boundedOriginString(fields.get("recordIdentitySha256"), "recordIdentity", 64),
    seed: {
      schema: boundedOriginString(seedFields.get("schema"), "seed schema", 64),
      profile: boundedOriginString(seedFields.get("profile"), "seed profile", 64),
      accountingOwnerId: boundedOriginString(seedFields.get("accountingOwnerId"), "seed owner", 64),
      admissionId: boundedOriginString(seedFields.get("admissionId"), "seed admission", 64),
      accountingOwnerRevision: boundedOriginNumber(
        seedFields.get("accountingOwnerRevision"),
        "accountingOwnerRevision",
        true,
      ),
      sourceAssociationSha256: boundedOriginString(seedFields.get("sourceAssociationSha256"), "seed association", 64),
      sourceDescriptorSha256: boundedOriginString(seedFields.get("sourceDescriptorSha256"), "seed descriptor", 64),
      inputManifestSha256: boundedOriginString(seedFields.get("inputManifestSha256"), "seed manifest", 64),
      admittedAt: boundedOriginNumber(seedFields.get("admittedAt"), "admittedAt", true),
      deadlineAt: boundedOriginNumber(seedFields.get("deadlineAt"), "deadlineAt", true),
      allocatedCostUsd: boundedOriginNumber(seedFields.get("allocatedCostUsd"), "allocatedCostUsd", false),
    },
  };
  const decoded = decodeRunRecoveryOriginText(JSON.stringify(projection), runId);
  const recordCreatedAt = readOwnData(record, "createdAt").value;
  if (decoded.createdAt !== recordCreatedAt) {
    throw new Error("recovery origin createdAt does not match the actual initial record");
  }
  return decoded;
}

function sameOriginSeed(left: RunRecoverySeed, right: RunRecoverySeed): boolean {
  return ORIGIN_SEED_FIELDS.every((key) => left[key] === right[key]);
}

function sameRecoveryOrigin(left: RunRecoveryOrigin, right: RunRecoveryOrigin): boolean {
  return left.schema === right.schema
    && left.nonce === right.nonce
    && left.runId === right.runId
    && left.createdAt === right.createdAt
    && left.recordIdentitySha256 === right.recordIdentitySha256
    && sameOriginSeed(left.seed, right.seed);
}

/** Same sorted-key recursive encoding as the original Runner's result digest. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function readOwnValue(value: unknown, key: string): unknown {
  const own = readOwnData(value, key);
  if (!own.present || !own.readable) throw new Error(`actual dispatch fact ${key} is unreadable`);
  return own.value;
}

function durableDeadlineExpired(durable: DurableBackendState, current: number): boolean {
  return Math.floor(durable.deadlineAt - current) < 1;
}

function assertDurableSignal(durable: DurableBackendState): void {
  const aborted = signalAborted(durable.signal);
  if (aborted === null) throw new Error("durable backend original signal is unreadable");
  if (aborted) throw new Error("durable backend original signal is aborted");
}

function durableLocalGuard(
  state: BackendState,
  durable: DurableBackendState,
  now: () => number,
  workerSignal?: unknown,
): () => void {
  return () => {
    if (state.durable !== durable) throw new Error("durable backend state is not this preparation");
    // The clock is a host callback and may synchronously abort a signal. Read
    // it first, then perform the final actual signal observations.
    if (durableDeadlineExpired(durable, readNow(now))) {
      throw new Error("the admitted delegation deadline expired");
    }
    assertDurableSignal(durable);
    if (workerSignal !== undefined) {
      const workerAborted = signalAborted(workerSignal);
      if (workerAborted === null) throw new Error("durable worker signal is unreadable");
      if (workerAborted) throw new Error("durable worker signal is aborted");
    }
  };
}

/** The final leaf may be absent because OmpRpcRunner creates artifactDir after this gate. */
async function assertConfinedDirectoryAllowMissingLeaf(
  root: string,
  target: string,
  label: string,
): Promise<void> {
  const absolute = path.resolve(target);
  if (absolute === root || !isContained(root, absolute)) throw new Error(`${label} escapes the private run area`);
  const segments = path.relative(root, absolute).split(path.sep);
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw new Error(`${label} could not be inspected`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} traverses a non-directory or link`);
    }
    let resolved: string;
    try {
      resolved = await realpath(cursor);
    } catch {
      throw new Error(`${label} could not be resolved`);
    }
    if (resolved !== cursor) throw new Error(`${label} traverses a link`);
  }
}

function sameAuth(expected: OmpProfileAuth | undefined, actual: unknown): boolean {
  if (expected === undefined) return actual === undefined;
  const fields = readStrictFields(actual, ["kind", "agentDir"], ["kind", "agentDir"]);
  return fields !== null
    && fields.get("kind") === "omp-profile"
    && fields.get("agentDir") === expected.agentDir;
}

function assertRecordConfig(
  record: RunRecord,
  runId: string,
  expected: GateExpectation,
): void {
  if (record.id !== runId) throw new Error("run record id does not match the requested run");
  if (record.schemaVersion !== 1) throw new Error("run record schema is not the fixed non-adaptive schema");
  if (path.resolve(record.workspace) !== expected.descriptor.workspaceRoot) {
    throw new Error("run record workspace is not the prepared private workspace");
  }
  if (record.status !== "running") throw new Error("run record is not running");
  if (expected.state.taskSha256 === null || sha256Hex(record.task) !== expected.state.taskSha256) {
    throw new Error("run record task is not the actual created task");
  }
  const config = record.config;
  if (config.strategy !== "auto" || config.mode !== "product" || config.domain !== NATIVE_HARNESS_BACKEND_DOMAIN) {
    throw new Error("run configuration is not the fixed auto/product/generic profile");
  }
  if (config.model !== expected.host.model || config.improverModel !== expected.host.model) {
    throw new Error("run model or improver model is not the fixed host model");
  }
  if (config.ompCommand !== expected.host.ompCommand) {
    throw new Error("run ompCommand is not the fixed host executable");
  }
  if (!sameAuth(expected.host.auth, config.auth)) {
    throw new Error("run authentication source is not the fixed host authentication source");
  }
  if (config.execution !== undefined) {
    throw new Error("run configuration contains a native execution override");
  }
  const adaptation = config.adaptation;
  if (
    adaptation === undefined
    || adaptation.capabilities !== EXPECTED_ADAPTATION.capabilities
    || adaptation.reuse !== EXPECTED_ADAPTATION.reuse
    || adaptation.learnMethods !== EXPECTED_ADAPTATION.learnMethods
  ) {
    throw new Error("run adaptation policy is not the fixed host policy");
  }
  if (config.maxCostUsd !== expected.budget.maxCostUsd) {
    throw new Error("run cost budget is not the admitted delegation budget");
  }
  if (
    !Number.isFinite(config.maxDurationMs)
    || config.maxDurationMs <= 0
    || config.maxDurationMs > expected.budget.maxDurationMs + NUMERIC_EPSILON
  ) {
    throw new Error("run duration budget exceeds the admitted delegation budget");
  }
  if (
    !Number.isFinite(config.stageTimeoutMs)
    || config.stageTimeoutMs <= 0
    || config.stageTimeoutMs > config.maxDurationMs
  ) {
    throw new Error("run stage timeout is outside the admitted duration budget");
  }
}

async function verifyRunRecord(
  controller: HarnessController,
  runId: string,
  expected: GateExpectation,
): Promise<RunRecord> {
  const record = await controller.get(runId);
  if (record === undefined) throw new Error("actual Harness2 run record is missing");
  assertRecordConfig(record, runId, expected);
  if (record.snapshot === undefined) throw new Error("actual Harness2 base snapshot is missing");
  const snapshot = record.snapshot;
  if (typeof snapshot.root !== "string" || typeof snapshot.sourceRoot !== "string") {
    throw new Error("actual Harness2 base snapshot is unreadable");
  }
  const runRoot = controller.store.runDir(runId);
  await realDirectoryExact(runRoot, "private run store");
  const workspaceReal = await realDirectoryExact(expected.descriptor.workspaceRoot, "prepared private workspace");
  const sourceReal = await realDirectoryExact(snapshot.sourceRoot, "base snapshot source root");
  if (sourceReal !== workspaceReal) throw new Error("base snapshot source root is not the prepared private workspace");
  const snapshotReal = await realDirectoryExact(snapshot.root, "base snapshot root");
  if (snapshotReal !== path.resolve(snapshot.root) || !isContained(runRoot, snapshotReal)) {
    throw new Error("base snapshot root is outside the private run store");
  }
  if (expected.durable !== null) {
    const sealed = expected.durable.origin;
    if (sealed === null) throw new Error("durable run has no accepted initial recovery origin");
    const observed = originFromRecord(record, runId);
    if (!sameRecoveryOrigin(sealed, observed)) {
      throw new Error("actual run recovery origin or seed changed after creation");
    }
  }
  return record;
}

function assertWorkerRequest(request: WorkerRequest, expected: GateExpectation): void {
  if (expected.state.runId === null) throw new Error("backend run id is unavailable");
  if (request.runId !== expected.state.runId) {
    throw new Error("worker request run id is not the actual backend-created run");
  }
  if (request.model !== expected.host.model) {
    throw new Error("worker request model is not the fixed host model");
  }
  if (request.ompCommand !== expected.host.ompCommand) {
    throw new Error("worker request ompCommand is not the fixed host executable");
  }
  if (!sameAuth(expected.host.auth, request.auth)) {
    throw new Error("worker request authentication source is not the fixed host authentication source");
  }
  if (request.execution !== undefined) {
    throw new Error("worker request contains a native execution override");
  }
  if (
    request.generatedExtensions !== undefined
    && (!Array.isArray(request.generatedExtensions) || request.generatedExtensions.length !== 0)
  ) {
    throw new Error("worker request contains generated native extensions");
  }
  if (
    !Number.isFinite(request.maxCostUsd)
    || request.maxCostUsd <= 0
    || request.maxCostUsd > expected.budget.maxCostUsd + NUMERIC_EPSILON
  ) {
    throw new Error("worker request cost allocation is outside the admitted budget");
  }
  if (
    !Number.isFinite(request.timeoutMs)
    || request.timeoutMs <= 0
    || request.timeoutMs > expected.budget.maxDurationMs
  ) {
    throw new Error("worker request timeout is outside the admitted duration budget");
  }
  if (
    typeof request.cwd !== "string"
    || typeof request.artifactDir !== "string"
    || request.cwd.length > MAX_PATH_CHARS
    || request.artifactDir.length > MAX_PATH_CHARS
    || !path.isAbsolute(request.cwd)
    || !path.isAbsolute(request.artifactDir)
  ) {
    throw new Error("worker request cwd and artifactDir must be bounded absolute paths");
  }
}

async function verifyRequestPaths(request: WorkerRequest, expected: GateExpectation): Promise<void> {
  const runRoot = path.resolve(expected.descriptor.storeRoot, "runs", expected.state.runId!);
  await realDirectoryExact(runRoot, "private run store");
  const cwd = path.resolve(request.cwd);
  if (cwd === runRoot || !isContained(runRoot, cwd)) {
    throw new Error("worker request cwd escapes the actual private run area");
  }
  await realDirectoryExact(cwd, "worker request cwd");
  await assertConfinedDirectoryAllowMissingLeaf(runRoot, request.artifactDir, "worker request artifactDir");
}

function assertManifestPaths(
  record: RunRecord,
  expected: GateExpectation,
): readonly NativeHarnessWorkspaceManifestEntry[] {
  const snapshot = record.snapshot;
  if (snapshot === undefined) throw new Error("actual Harness2 base snapshot is missing");
  if (!Array.isArray(snapshot.files)) {
    throw new Error("actual Harness2 base snapshot files are unreadable");
  }
  const hostManifest = [...expected.descriptor.inputManifest]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (snapshot.files.length !== hostManifest.length) {
    throw new Error("base snapshot file count does not exactly match the host input manifest");
  }
  if (!snapshot.files.every((entry) => isRecord(entry) && typeof entry.path === "string")) {
    throw new Error("actual Harness2 base snapshot files are unreadable");
  }
  const actual = [...snapshot.files].sort((left, right) => left.path.localeCompare(right.path));
  for (let index = 0; index < hostManifest.length; index += 1) {
    if (actual[index]!.path !== hostManifest[index]!.relativePath) {
      throw new Error("base snapshot file paths do not exactly match the host input manifest");
    }
  }
  return hostManifest;
}

function snapshotBytesHash(mode: number, bytes: Uint8Array): string {
  return sha256Hex(Buffer.concat([Buffer.from(`${mode.toString(8)}\0`, "utf8"), bytes]));
}

async function verifySnapshotFiles(
  record: RunRecord,
  expected: GateExpectation,
  hostManifest: readonly NativeHarnessWorkspaceManifestEntry[],
  checked?: NativeHarnessCheckedBaseInput[],
): Promise<void> {
  const snapshot = record.snapshot;
  if (snapshot === undefined) throw new Error("actual Harness2 base snapshot is missing");
  const entries = new Map(snapshot.files.map((entry) => [entry.path, entry]));
  for (const hostEntry of hostManifest) {
    const declared = entries.get(hostEntry.relativePath);
    if (declared === undefined) throw new Error("base snapshot entry is missing");
    let captured;
    try {
      captured = await captureWorkspaceText(snapshot.root, hostEntry.relativePath);
    } catch {
      throw new Error("base snapshot input is missing, changed, unsafe or unreadable");
    }
    if (
      captured.file.bytes !== hostEntry.bytes
      || captured.file.sha256 !== hostEntry.sha256
      || declared.size !== captured.file.bytes
    ) {
      throw new Error("base snapshot input bytes do not match the host input manifest");
    }
    let info;
    try {
      info = await lstat(path.join(snapshot.root, hostEntry.relativePath), { bigint: true });
    } catch {
      throw new Error("base snapshot input metadata is unreadable");
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("base snapshot input is not a regular non-link file");
    }
    const mode = Number(info.mode & 0o777n);
    if (declared.mode !== mode) throw new Error("base snapshot input mode does not match its manifest entry");
    const bytes = Buffer.from(captured.text, "utf8");
    if (declared.hash !== snapshotBytesHash(mode, bytes)) {
      throw new Error("base snapshot input hash does not match its declared manifest entry");
    }
    checked?.push(Object.freeze({
      path: hostEntry.relativePath,
      size: captured.file.bytes,
      mode,
      contentSha256: captured.file.sha256,
      controllerHash: declared.hash,
    }));
  }
}

function blockWitnessOverflow(completion: BackendCompletionState, reason: string): null {
  if (!completion.overflow) {
    completion.overflow = true;
    completion.overflowReason = boundedCompletionReason(reason);
  }
  completion.witnessFailure ??= completion.overflowReason;
  return null;
}

function storeCompletionWitness(
  completion: BackendCompletionState,
  witness: NativeHarnessCompletionWitness,
): number | null {
  if (completion.overflow) return null;
  if (completion.witnesses.length >= NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnesses) {
    return blockWitnessOverflow(completion, "witness capacity exceeded");
  }
  const bytes = completionMetadataBytes(witness);
  if (bytes === null || bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnessMetadataBytes) {
    completion.witnessFailure ??= "witness metadata exceeded its bound";
    return null;
  }
  if (completion.witnessBytes + bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnessTotalBytes) {
    return blockWitnessOverflow(completion, "witness metadata budget exceeded");
  }
  completion.witnessBytes += bytes;
  completion.witnesses.push({ bytes, witness });
  return completion.witnesses.length - 1;
}

/**
 * Reserves one actual dispatch observation. Any copy/shape failure is retained
 * as bounded unavailability; it never refuses the worker call.
 */
function reserveCompletionWitness(
  expected: GateExpectation,
  request: WorkerRequest,
  checkedRecord: RunRecord,
  finalRecord: RunRecord,
  checkedInputs: readonly NativeHarnessCheckedBaseInput[],
): number | null {
  const completion = expected.state.completion;
  completion.sequence += 1;
  const sequence = completion.sequence;
  try {
    if (completion.overflow) return null;
    const runId = readOwnData(request, "runId").value;
    const stage = readOwnData(request, "stage").value;
    const role = readOwnData(request, "role").value;
    const cwd = readOwnData(request, "cwd").value;
    const artifactDir = readOwnData(request, "artifactDir").value;
    const model = readOwnData(request, "model").value;

    const checkedSnapshot = readOwnData(checkedRecord, "snapshot").value;
    const base = copyWitnessBase({
      snapshotId: readOwnData(checkedSnapshot, "id").value,
      root: readOwnData(checkedSnapshot, "root").value,
      sourceRoot: readOwnData(checkedSnapshot, "sourceRoot").value,
      createdAt: readOwnData(checkedSnapshot, "createdAt").value,
      checked: checkedInputs,
      inputs: expected.descriptor.inputManifest,
      manifestSha256: expected.descriptor.manifestSha256,
    });

    const stages = readOwnData(finalRecord, "stages").value;
    const finalStage = typeof stage === "string" ? readOwnData(stages, stage).value : undefined;
    const finalStageStatus = readOwnData(finalStage, "status").value;
    const finalStageId = readOwnData(finalStage, "id").value;
    const finalStageCwd = readOwnData(finalStage, "cwd").value;
    const attempt = readOwnData(finalStage, "attempt").value;
    const parentValue = readOwnData(finalStage, "parentStage");
    const parentHashValue = readOwnData(finalStage, "parentArtifactHash");
    let parent: NativeHarnessCompletionParent | null = null;
    let parentProblem: string | null = null;
    if (!parentValue.present && !parentHashValue.present) {
      parent = null;
    } else if (
      parentValue.present
      && parentHashValue.present
      && parentValue.readable
      && parentHashValue.readable
    ) {
      const parentCandidate = boundedCompletionToken(parentValue.value, 64);
      const parentHash = boundedCompletionHash(parentHashValue.value);
      if (
        parentCandidate === null
        || parentHash === null
        || !(NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(parentCandidate)
      ) {
        parentProblem = "final dispatch stage parent reference is invalid";
      } else {
        parent = Object.freeze({ candidate: parentCandidate, artifactHash: parentHash });
      }
    } else {
      parentProblem = "final dispatch stage parent reference is incomplete or unreadable";
    }

    let problem: string | null = null;
    if (base === null) {
      problem = "checked base snapshot facts could not be copied";
    } else if (
      finalStageStatus !== "running"
      || finalStageId !== stage
      || finalStageCwd !== cwd
      || !isPositiveSafeInteger(attempt)
    ) {
      problem = "final dispatch stage facts do not match the actual Runner request";
    } else if (parentProblem !== null) {
      problem = parentProblem;
    } else {
      const finalSnapshot = readOwnData(finalRecord, "snapshot").value;
      if (!snapshotMatchesWitnessBase(finalSnapshot, base)) {
        problem = "final run record snapshot does not exactly match the checked base snapshot";
      }
    }
    if (problem !== null) {
      completion.provenanceFailure ??= problem;
      completion.witnessFailure ??= problem;
    }

    const facts = copyWitnessFacts({
      sequence,
      runId,
      stage,
      role,
      cwd,
      artifactDir,
      model,
      attempt,
      parent,
      base,
    });
    if (facts === null) {
      completion.witnessFailure ??= "dispatch witness facts could not be copied";
    }
    const witness = deepFreeze({
      sequence,
      facts,
      result: null,
      failure: facts === null ? "dispatch witness facts could not be copied" : problem,
      eligible: facts !== null && base !== null && problem === null,
    });
    return storeCompletionWitness(completion, witness);
  } catch {
    completion.witnessFailure ??= "dispatch witness copy failed";
    return null;
  }
}

/** Records the actual Runner return (or thrown invocation) without altering it. */
function settleCompletionWitness(
  expected: GateExpectation,
  index: number | null,
  returned: WorkerResult | null,
  didThrow: boolean,
): void {
  if (index === null) return;
  const completion = expected.state.completion;
  const slot = completion.witnesses[index];
  if (slot === undefined) return;
  try {
    const pending = slot.witness;
    let settled: NativeHarnessCompletionWitness;
    if (didThrow) {
      settled = deepFreeze({
        sequence: pending.sequence,
        facts: pending.facts,
        result: null,
        failure: "Runner invocation threw",
        eligible: false,
      });
    } else {
      const copied = copyWitnessResult(returned);
      if (copied.result === null) {
        completion.witnessFailure ??= copied.failure ?? "witness result facts are unavailable";
      }
      settled = deepFreeze({
        sequence: pending.sequence,
        facts: pending.facts,
        result: copied.result,
        failure: copied.failure,
        eligible: pending.eligible && copied.result !== null,
      });
    }
    let bytes = completionMetadataBytes(settled);
    if (bytes === null || bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnessMetadataBytes) {
      completion.witnessFailure ??= "result witness metadata exceeded its bound";
      settled = deepFreeze({
        sequence: pending.sequence,
        facts: pending.facts,
        result: null,
        failure: "result witness metadata exceeded its bound",
        eligible: false,
      });
      bytes = completionMetadataBytes(settled);
    }
    if (bytes === null || bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnessMetadataBytes) {
      completion.witnessFailure ??= "witness metadata exceeded its bound";
      settled = deepFreeze({
        sequence: pending.sequence,
        facts: null,
        result: null,
        failure: "witness metadata exceeded its bound",
        eligible: false,
      });
      bytes = completionMetadataBytes(settled);
    }
    if (bytes === null) {
      completion.witnessFailure ??= "witness metadata could not be encoded";
      return;
    }
    if (completion.witnessBytes - slot.bytes + bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxWitnessTotalBytes) {
      completion.overflow = true;
      completion.overflowReason ??= "witness metadata budget exceeded";
      completion.witnessFailure ??= completion.overflowReason;
      return;
    }
    completion.witnessBytes = completion.witnessBytes - slot.bytes + bytes;
    slot.bytes = bytes;
    slot.witness = settled;
  } catch {
    completion.witnessFailure ??= "witness settlement failed";
  }
}

interface FrozenDispatchTuple {
  readonly stage: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly runRevision: number;
  readonly stageAllocatedCostUsd: number;
  readonly parentStage: unknown;
  readonly parentArtifactHash: unknown;
}

function sameDispatchTuple(record: RunRecord, tuple: FrozenDispatchTuple, request: WorkerRequest): void {
  if (readOwnValue(record, "revision") !== tuple.runRevision) {
    throw new Error("durable dispatch run revision changed after inventory association");
  }
  const stages = readOwnValue(record, "stages");
  const stage = readOwnValue(stages, tuple.stage);
  if (readOwnValue(stage, "id") !== tuple.stage
    || readOwnValue(stage, "status") !== "running"
    || readOwnValue(stage, "attempt") !== tuple.attempt
    || readOwnValue(stage, "cwd") !== tuple.cwd
    || readOwnValue(stage, "reservedCostUsd") !== tuple.stageAllocatedCostUsd
    || (readOwnData(stage, "parentStage").value ?? null) !== tuple.parentStage
    || (readOwnData(stage, "parentArtifactHash").value ?? null) !== tuple.parentArtifactHash) {
    throw new Error("durable dispatch stage facts changed after inventory association");
  }
  if (request.cwd !== tuple.cwd
    || path.resolve(request.artifactDir) !== tuple.artifactDir
    || request.maxCostUsd !== tuple.stageAllocatedCostUsd) {
    throw new Error("durable worker request facts changed after inventory association");
  }
}

function assertSameDigestInputs(
  request: WorkerRequest,
  facts: {
    readonly role: unknown;
    readonly model: unknown;
    readonly prompt: unknown;
    readonly harnessCanonical: string;
    readonly timeoutMs: unknown;
    readonly maxCostUsd: unknown;
  },
): void {
  if (readOwnValue(request, "role") !== facts.role
    || readOwnValue(request, "model") !== facts.model
    || readOwnValue(request, "prompt") !== facts.prompt
    || readOwnValue(request, "timeoutMs") !== facts.timeoutMs
    || readOwnValue(request, "maxCostUsd") !== facts.maxCostUsd
    || canonicalJson(readOwnValue(request, "harness")) !== facts.harnessCanonical) {
    throw new Error("durable worker request digest inputs changed after inventory association");
  }
}

const MAX_OWNED_REQUEST_FIELDS = 128;
const MAX_OWNED_HARNESS_DEPTH = 8;
const MAX_OWNED_HARNESS_NODES = 4096;

function copyBoundedOwnedValue(value: unknown, state: { nodes: number }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_OWNED_HARNESS_NODES || depth > MAX_OWNED_HARNESS_DEPTH) {
    throw new Error("durable worker harness exceeds the bounded owned copy");
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("durable worker harness array exceeds the bounded owned copy");
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("durable worker harness array contains an accessor or hole");
      }
      items.push(copyBoundedOwnedValue(descriptor.value, state, depth + 1));
    }
    return Object.freeze(items);
  }
  if (value !== null && typeof value === "object") {
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("durable worker harness contains symbol properties");
    }
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > 64) throw new Error("durable worker harness object exceeds the bounded owned copy");
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new Error("durable worker harness contains an accessor property");
      }
      copy[key] = copyBoundedOwnedValue(descriptor.value, state, depth + 1);
    }
    return Object.freeze(copy);
  }
  return value;
}

/**
 * Owns the exact payload the durable gate later dispatches. The original
 * Controller request can be mutated by a host clock before the coordinator's
 * shallow copy; allocating this copy before any later callback makes the
 * digest and the forwarded bytes the same owned values. The nested harness,
 * bounded auth data and an admitted empty generated-extension list are
 * deep-copied without invoking accessors and frozen; signal, host handlers and
 * other actual host references stay by reference.
 */
function copyOwnedDispatchRequest(request: WorkerRequest): WorkerRequest {
  if (!isRecord(request)) throw new Error("durable worker request is not an object");
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("durable worker request uses an unsupported prototype");
  }
  const keys = Reflect.ownKeys(request);
  if (keys.length > MAX_OWNED_REQUEST_FIELDS || keys.some((key) => typeof key !== "string")) {
    throw new Error("durable worker request contains unsupported or excessive fields");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("durable worker request contains an accessor property");
    }
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const ownedHarness = copyBoundedOwnedValue(readOwnValue(request, "harness"), { nodes: 0 });
  Object.defineProperty(copy, "harness", {
    value: ownedHarness,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  const authDescriptor = Object.getOwnPropertyDescriptor(copy, "auth");
  if (authDescriptor !== undefined) {
    // Auth is bounded own data (kind/agentDir). Keep the same values and
    // optional presence while preventing later retained-object mutation;
    // signal and host handler references remain the actual originals.
    Object.defineProperty(copy, "auth", {
      value: copyBoundedOwnedValue(authDescriptor.value, { nodes: 0 }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  const extensionDescriptor = Object.getOwnPropertyDescriptor(copy, "generatedExtensions");
  if (extensionDescriptor !== undefined) {
    // Only the admitted empty list is owned; absent/undefined presence is
    // preserved and an originally invalid or nonempty value is left for the
    // existing host gate to refuse before dispatch.
    const extensions = extensionDescriptor.value;
    Object.defineProperty(copy, "generatedExtensions", {
      value: Array.isArray(extensions) && extensions.length === 0
        ? copyBoundedOwnedValue(extensions, { nodes: 0 })
        : extensions,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return copy as unknown as WorkerRequest;
}

async function createDurableDispatchBridge(
  expected: GateExpectation,
  request: WorkerRequest,
  checkedRecord: RunRecord,
  finalRecord: RunRecord,
  checkedInputs: readonly NativeHarnessCheckedBaseInput[],
  controller: HarnessController,
): Promise<{ readonly bridge: NativeHarnessLifecycleBridge; readonly acknowledgement: DurableDispatchAcknowledgement }> {
  const durable = expected.durable;
  if (durable === null) throw new Error("durable dispatch binding requires durable preparation");
  const durableState = expected.state;
  const now = expected.options.now ?? Date.now;
  const inventory = durable.inventory;
  if (inventory === null || durable.inventoryClosed) {
    throw new Error("durable dispatch inventory is unavailable");
  }
  if (durable.origin === null) throw new Error("durable run has no accepted initial recovery origin");
  if (durable.executionRefusal !== null) {
    throw new Error("durable run execution was refused after creation");
  }
  if (durableState.runId === null || durableState.runId !== request.runId) {
    throw new Error("durable worker request does not name the actual created run");
  }

  const stages = readOwnValue(finalRecord, "stages");
  const stageRecord = readOwnValue(stages, request.stage) as StageRecord;
  const stageId = readOwnValue(stageRecord, "id");
  const stageStatus = readOwnValue(stageRecord, "status");
  const attempt = readOwnValue(stageRecord, "attempt");
  const stageCwd = readOwnValue(stageRecord, "cwd");
  const reservedCostUsd = readOwnValue(stageRecord, "reservedCostUsd");
  if (stageId !== request.stage
    || stageStatus !== "running"
    || typeof stageCwd !== "string"
    || stageCwd !== request.cwd
    || !isPositiveSafeInteger(attempt)) {
    throw new Error("actual durable StageRecord does not match the worker dispatch");
  }
  if (typeof reservedCostUsd !== "number"
    || !Number.isFinite(reservedCostUsd)
    || reservedCostUsd <= 0
    || reservedCostUsd !== request.maxCostUsd) {
    throw new Error("actual StageRecord reservation does not match the worker allocation");
  }
  const artifactDir = path.resolve(request.artifactDir);
  if (artifactDir !== path.join(path.dirname(path.resolve(stageCwd)), "artifacts")) {
    throw new Error("worker artifactDir is not the constrained sibling of the actual stage attempt");
  }
  const runRevision = readOwnValue(finalRecord, "revision");
  if (!Number.isSafeInteger(runRevision) || (runRevision as number) < 0) {
    throw new Error("actual RunRecord revision is unreadable");
  }
  const runCreatedAt = readOwnValue(finalRecord, "createdAt");
  const runConfig = readOwnValue(finalRecord, "config");
  const maxDurationMs = readOwnValue(runConfig, "maxDurationMs");
  if (typeof maxDurationMs !== "number" || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error("actual RunRecord duration facts are unreadable");
  }
  if (typeof runCreatedAt !== "string") throw new Error("actual RunRecord createdAt is unreadable");
  const innerDeadlineAt = Date.parse(runCreatedAt) + maxDurationMs;
  if (!Number.isSafeInteger(innerDeadlineAt) || innerDeadlineAt < 1) {
    throw new Error("actual inner execution deadline is unreadable");
  }
  const executionDeadlineAt = Math.min(innerDeadlineAt, durable.deadlineAt);
  const checkedSnapshot = readOwnValue(checkedRecord, "snapshot");
  const checkedBase = copyWitnessBase({
    snapshotId: readOwnValue(checkedSnapshot, "id"),
    root: readOwnValue(checkedSnapshot, "root"),
    sourceRoot: readOwnValue(checkedSnapshot, "sourceRoot"),
    createdAt: readOwnValue(checkedSnapshot, "createdAt"),
    checked: checkedInputs,
    inputs: expected.descriptor.inputManifest,
    manifestSha256: expected.descriptor.manifestSha256,
  });
  if (checkedBase === null) {
    throw new Error("actually checked base snapshot facts could not be copied");
  }
  if (!snapshotMatchesWitnessBase(readOwnValue(finalRecord, "snapshot"), checkedBase)) {
    throw new Error("final run record snapshot does not match the actually checked base snapshot");
  }
  const snapshotSha256 = sha256Hex(canonicalJson(checkedBase));
  const role = readOwnValue(request, "role");
  const model = readOwnValue(request, "model");
  const prompt = readOwnValue(request, "prompt");
  const timeoutMs = readOwnValue(request, "timeoutMs");
  const maxCostUsd = readOwnValue(request, "maxCostUsd");
  if (typeof prompt !== "string" || typeof timeoutMs !== "number" || typeof maxCostUsd !== "number") {
    throw new Error("durable worker request digest inputs are unreadable");
  }
  const harnessCanonical = canonicalJson(readOwnValue(request, "harness"));
  const parentStage = readOwnData(stageRecord, "parentStage").value ?? null;
  const parentArtifactHash = readOwnData(stageRecord, "parentArtifactHash").value ?? null;
  const digestFacts = Object.freeze({ role, model, prompt, harnessCanonical, timeoutMs, maxCostUsd });
  const intentSha256 = sha256Hex(canonicalJson({
    runId: request.runId,
    runRevision,
    stage: request.stage,
    role,
    attempt,
    cwd: stageCwd,
    artifactDir,
    model,
    maxCostUsd,
    timeoutMs,
    promptSha256: sha256Hex(prompt),
    harnessSha256: sha256Hex(harnessCanonical),
    parentStage,
    parentArtifactHash,
    innerDeadlineAt,
    outerDeadlineAt: durable.deadlineAt,
  }));
  const tuple: FrozenDispatchTuple = Object.freeze({
    stage: request.stage,
    attempt: attempt as number,
    cwd: stageCwd,
    artifactDir,
    runRevision: runRevision as number,
    stageAllocatedCostUsd: reservedCostUsd,
    parentStage,
    parentArtifactHash,
  });
  const ordinal = inventory.snapshot().dispatches.length + 1;
  const nonce = randomUUID();
  const advanceGuard = (): void => {
    // Callback-rich clocks first. A clock may abort the signal or reenter; all
    // intrinsic signal reads and pure local facts follow them.
    const current = readNow(now);
    if (current >= executionDeadlineAt) {
      throw new Error("the actual inner or outer execution deadline expired");
    }
    if (durableDeadlineExpired(durable, current)) {
      throw new Error("the admitted delegation deadline expired");
    }
    const durableAborted = signalAborted(durable.signal);
    if (durableAborted === null) throw new Error("durable backend original signal is unreadable");
    if (durableAborted) throw new Error("durable backend original signal is aborted");
    const workerAborted = signalAborted(request.signal);
    if (workerAborted === null) throw new Error("durable worker signal is unreadable");
    if (workerAborted) throw new Error("durable worker signal is aborted");
    if (durableState.durable !== durable) throw new Error("durable backend state is not this preparation");
    if (durable.inventory !== inventory || durable.inventoryClosed) {
      throw new Error("durable dispatch inventory is no longer this run's open handle");
    }
    if (durable.executionRefusal !== null) throw new Error(durable.executionRefusal);
  };

  advanceGuard();
  const intent: NativeHarnessDispatchIntent = Object.freeze({
    ordinal,
    nonce,
    stage: request.stage,
    attempt: attempt as number,
    runRevision: runRevision as number,
    cwd: stageCwd,
    artifactDir,
    intentSha256,
    snapshotSha256,
    innerDeadlineAt,
    requestTimeoutMs: request.timeoutMs,
    stageAllocatedCostUsd: reservedCostUsd,
  });
  await inventory.intend(intent, advanceGuard);
  advanceGuard();
  // Recheck the exact same actual tuple after the inventory effect; never bind
  // a later attempt or a changed revision to the already appended intent.
  const reread = await verifyRunRecord(controller, request.runId, expected);
  sameDispatchTuple(reread, tuple, request);
  assertSameDigestInputs(request, digestFacts);
  if (!snapshotMatchesWitnessBase(readOwnValue(reread, "snapshot"), checkedBase)) {
    throw new Error("post-intent run record snapshot does not match the actually checked base snapshot");
  }
  advanceGuard();

  const acknowledgement: DurableDispatchAcknowledgement = { cleanup: null, terminal: null };
  const checkpoint = (event: WorkerLifecycleEvent, assertPersistable: () => void): Promise<void> => {
    if (durable.inventory !== inventory || durable.inventoryClosed || durable.closeRequested) {
      throw new Error("durable dispatch inventory is no longer this run's open handle");
    }
    if (event.runId !== request.runId || event.stage !== request.stage) {
      throw new Error("worker lifecycle event does not match the bound dispatch");
    }
    const advance = (): void => {
      // Original backend binding/currentness first; the Runner-supplied
      // per-operation assertion is last. Only pure local facts follow it.
      advanceGuard();
      assertPersistable();
      if (durable.inventory !== inventory || durable.inventoryClosed) {
        throw new Error("durable dispatch inventory is no longer this run's open handle");
      }
      if (durable.executionRefusal !== null) throw new Error(durable.executionRefusal);
    };
    const cleanup = (): void => {
      // Already-started cleanup/result persistence is owned by the original
      // per-operation assertion. closeRequested only closes NEW checkpoints at
      // execution end; it is not execution authority over this operation.
      if (durable.inventory !== inventory || durable.inventoryClosed) {
        throw new Error("durable dispatch inventory is no longer this run's open handle");
      }
      assertPersistable();
      if (durable.inventory !== inventory || durable.inventoryClosed) {
        throw new Error("durable dispatch inventory is no longer this run's open handle");
      }
    };
    let operation: Promise<unknown>;
    switch (event.type) {
      case "preLaunch":
        operation = inventory.markLaunched(ordinal, nonce, Object.freeze({
          runtimeRoot: event.runtimeRoot,
          configSha256: event.configSha256,
          appendixSha256: event.appendixSha256,
          effectiveTimeoutMs: event.timeoutMs,
        }), advance);
        break;
      case "processBound":
        if (event.pid === null || event.pgid === null) {
          throw new Error("the original Runner reported no actual process identity");
        }
        operation = inventory.bindProcess(ordinal, nonce, Object.freeze({
          pid: event.pid,
          pgid: event.pgid,
          identitySha256: event.associationSha256,
        }), advance);
        break;
      case "prePrompt":
        operation = inventory.markPromptPending(ordinal, nonce, Object.freeze({
          promptSha256: event.promptSha256,
          promptBytes: event.promptBytes,
          effectiveTimeoutMs: event.timeoutMs,
        }), advance);
        break;
      case "cleanupObserved":
        operation = inventory.markCleanupObserved(ordinal, nonce, Object.freeze({
          observationKind: "runner-observation" as const,
          observation: event,
        }), cleanup);
        break;
      case "resultObserved": {
        const observedAt = Date.parse(event.endedAt);
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
          throw new Error("worker result endedAt is not a bounded timestamp");
        }
        const terminal: NativeHarnessDispatchTerminal = Object.freeze({
          outcome: event.status === "timed_out" ? "timed-out" : event.status,
          observationKind: "runner-observation" as const,
          observedAt,
          resultSha256: event.resultSha256,
          usageCostUsd: event.usage.costUsd,
          usageEstimated: event.usageEstimated,
        });
        operation = inventory.finalize(ordinal, nonce, terminal, cleanup);
        break;
      }
      default:
        throw new Error("worker lifecycle event type is not supported");
    }
    const tracked = Promise.resolve(operation).then((value) => {
      if (event.type === "cleanupObserved") acknowledgement.cleanup = event;
      else if (event.type === "resultObserved") acknowledgement.terminal = event;
      return value;
    });
    durable.inventoryPending.add(tracked);
    const forget = (): void => { durable.inventoryPending.delete(tracked); };
    void tracked.then(forget, forget);
    return tracked.then(() => undefined);
  };

  return Object.freeze({
    bridge: Object.freeze({
      innerDeadlineAt,
      assertAdvanceCurrent: () => { advanceGuard(); },
      checkpoint,
    }),
    acknowledgement,
  });
}

function durableResultConsistency(
  acknowledgement: DurableDispatchAcknowledgement,
  result: WorkerResult,
): string | null {
  try {
    const terminal = acknowledgement.terminal;
    if (terminal === null) return "durable dispatch has no acknowledged terminal observation";
    if (acknowledgement.cleanup === null) return "durable dispatch has no acknowledged cleanup observation";
    const usage = readOwnValue(result, "usage");
    if (terminal.status !== readOwnValue(result, "status")
      || terminal.usage.inputTokens !== readOwnValue(usage, "inputTokens")
      || terminal.usage.outputTokens !== readOwnValue(usage, "outputTokens")
      || terminal.usage.costUsd !== readOwnValue(usage, "costUsd")
      || terminal.startedAt !== readOwnValue(result, "startedAt")
      || terminal.endedAt !== readOwnValue(result, "endedAt")
      || terminal.usageEstimated !== (readOwnData(result, "usageEstimated").value === true)) {
      return "durable terminal fields do not match the returned WorkerResult";
    }
    if (terminal.resultSha256 !== canonicalWorkerResultSha256(result)) {
      return "durable terminal digest does not match the returned WorkerResult";
    }
    return null;
  } catch {
    return "returned WorkerResult or durable terminal observation is unreadable";
  }
}

function createBaseInputGateRunner(
  underlying: Runner,
  expected: GateExpectation,
): Runner {
  return Object.freeze({
    async run(request: WorkerRequest): Promise<WorkerResult> {
      const controller = expected.state.controller;
      if (controller === null) throw new Error("actual Harness2 controller is unavailable");
      expected.options.mutateWorkerRequest?.(request);
      // Own the exact durable dispatch payload immediately after the
      // synchronous test seam and before any await. Every gate, path/record
      // read, snapshot, digest and forwarded call uses this same object; a
      // retained original cannot change model/ompCommand/execution/prompt/
      // harness after this point. Legacy requests keep their original object.
      const dispatchRequest = expected.durable === null
        ? request
        : copyOwnedDispatchRequest(request);
      assertWorkerRequest(dispatchRequest, expected);
      await verifyRequestPaths(dispatchRequest, expected);
      let record = await verifyRunRecord(controller, dispatchRequest.runId, expected);
      if (expected.options.beforeBaseInputCheck !== null) {
        const snapshotRoot = record.snapshot?.root;
        if (snapshotRoot === undefined) throw new Error("actual Harness2 base snapshot is missing");
        await expected.options.beforeBaseInputCheck(Object.freeze({
          runId: dispatchRequest.runId,
          snapshotRoot,
        }));
        record = await verifyRunRecord(controller, dispatchRequest.runId, expected);
      }
      if (expected.durable !== null) {
        const durable = expected.durable;
        if (durable.executionRefusal !== null) {
          throw new Error("durable run execution was refused after creation");
        }
        if (expected.state.runId === null || expected.state.runId !== dispatchRequest.runId) {
          throw new Error("durable worker request does not name the actual created run");
        }
        const workerAborted = signalAborted(dispatchRequest.signal);
        if (workerAborted === null) throw new Error("durable worker signal is missing or unreadable");
        if (workerAborted) throw new Error("durable worker signal is aborted");
        const guard = durableLocalGuard(
          expected.state,
          durable,
          expected.options.now ?? Date.now,
          dispatchRequest.signal,
        );
        await verifyNativeHarnessRecoverySource(
          durable.source,
          guard,
          dispatchRequest.signal as AbortSignal,
        );
        // Re-read the pure request/path checks after the asynchronous source
        // observation. The final record reread below follows the snapshot read.
        assertWorkerRequest(dispatchRequest, expected);
        await verifyRequestPaths(dispatchRequest, expected);
      }
      const hostManifest = assertManifestPaths(record, expected);
      const checkedInputs: NativeHarnessCheckedBaseInput[] = [];
      await verifySnapshotFiles(record, expected, hostManifest, checkedInputs);
      const checkedRecord = record;
      // Re-read current Controller state after every asynchronous base-input
      // observation. A refusal here stops only worker dispatch; the Controller
      // may still settle its own private run record. No provider dispatch or
      // original-source write follows a refused gate.
      const finalRecord = await verifyRunRecord(controller, dispatchRequest.runId, expected);
      // The later reread is not byte-checked. Its snapshot must match the facts
      // actually checked above before the dispatch witness can support output.
      // A mismatch makes completion origin unavailable; it never refuses the
      // existing worker call or changes Controller accounting.
      const witnessIndex = reserveCompletionWitness(
        expected,
        dispatchRequest,
        checkedRecord,
        finalRecord,
        checkedInputs,
      );
      let durableDispatch: DurableDispatchAcknowledgement | null = null;
      if (expected.durable !== null) {
        // Fresh final gate after every asynchronous source/path/record check
        // and the synchronous witness copy. No earlier gate is carried across
        // this I/O. The underlying coordinator still performs its own final
        // native/currentness/budget gate.
        durableLocalGuard(
          expected.state,
          expected.durable,
          expected.options.now ?? Date.now,
          dispatchRequest.signal,
        )();
        if (
          Object.getOwnPropertyDescriptor(dispatchRequest, "lifecycle") !== undefined
          || Object.getOwnPropertyDescriptor(dispatchRequest, NATIVE_HARNESS_LIFECYCLE_FIELD) !== undefined
        ) {
          throw new Error("durable worker request already contains an ambiguous lifecycle bridge");
        }
        const binding = await createDurableDispatchBridge(
          expected,
          dispatchRequest,
          checkedRecord,
          finalRecord,
          checkedInputs,
          controller,
        );
        durableDispatch = binding.acknowledgement;
        Object.defineProperty(dispatchRequest, NATIVE_HARNESS_LIFECYCLE_FIELD, {
          value: binding.bridge,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        // The owned top-level fields and nested harness are frozen before the
        // actual Runner invocation. The coordinator still copies the request
        // and may only narrow timeoutMs/signal on its own copy.
        Object.freeze(dispatchRequest);
      }
      let result: WorkerResult;
      try {
        result = await underlying.run(dispatchRequest);
      } catch (error) {
        settleCompletionWitness(expected, witnessIndex, null, true);
        throw error;
      }
      if (durableDispatch !== null) {
        const problem = durableResultConsistency(durableDispatch, result);
        if (problem !== null) {
          settleCompletionWitness(expected, witnessIndex, null, true);
          throw new Error(problem);
        }
      }
      settleCompletionWitness(expected, witnessIndex, result, false);
      return result;
    },
  });
}

interface PreparedCompletionFacts {
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly manifestSha256: string;
  readonly inputs: readonly NativeHarnessCompletionPreparedInput[];
}

function copyPreparedCompletionFacts(
  descriptor: NativeHarnessWorkspaceDescriptor,
): PreparedCompletionFacts {
  const sourceRoot = boundedCompletionPath(readOwnData(descriptor, "sourceRoot").value);
  const preparedRoot = boundedCompletionPath(readOwnData(descriptor, "preparedRoot").value);
  const workspaceRoot = boundedCompletionPath(readOwnData(descriptor, "workspaceRoot").value);
  const storeRoot = boundedCompletionPath(readOwnData(descriptor, "storeRoot").value);
  const manifestSha256 = boundedCompletionHash(readOwnData(descriptor, "manifestSha256").value);
  const inputs = copyPreparedInputs(readOwnData(descriptor, "inputManifest").value);
  if (
    sourceRoot === null
    || preparedRoot === null
    || workspaceRoot === null
    || storeRoot === null
    || manifestSha256 === null
    || inputs === null
  ) {
    throw new CompletionUnavailable("prepared descriptor facts could not be copied");
  }
  return deepFreeze({ sourceRoot, preparedRoot, workspaceRoot, storeRoot, manifestSha256, inputs });
}

function witnessBaseMatchesPrepared(
  base: NativeHarnessCompletionBase,
  prepared: PreparedCompletionFacts,
): boolean {
  if (base.sourceRoot !== prepared.workspaceRoot || base.manifestSha256 !== prepared.manifestSha256) {
    return false;
  }
  if (base.inputs.length !== prepared.inputs.length) return false;
  for (let index = 0; index < base.inputs.length; index += 1) {
    const checked = base.inputs[index]!;
    const declared = prepared.inputs[index]!;
    if (
      checked.path !== declared.relativePath
      || checked.size !== declared.bytes
      || checked.contentSha256 !== declared.sha256
    ) {
      return false;
    }
  }
  return true;
}

function readStageParent(stageValue: unknown): NativeHarnessCompletionParent | null {
  const candidate = readOwnData(stageValue, "parentStage");
  const artifactHash = readOwnData(stageValue, "parentArtifactHash");
  if (!candidate.present && !artifactHash.present) return null;
  if (!candidate.present || !artifactHash.present || !candidate.readable || !artifactHash.readable) {
    throw new CompletionUnavailable("dispatch stage parent reference is incomplete or unreadable");
  }
  const candidateText = boundedCompletionToken(candidate.value, 64);
  const hashText = boundedCompletionHash(artifactHash.value);
  if (
    candidateText === null
    || hashText === null
    || !(NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(candidateText)
  ) {
    throw new CompletionUnavailable("dispatch stage parent reference is invalid");
  }
  return Object.freeze({ candidate: candidateText, artifactHash: hashText });
}

function sameCompletionParent(
  left: NativeHarnessCompletionParent | null,
  right: NativeHarnessCompletionParent | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.candidate === right.candidate && left.artifactHash === right.artifactHash;
}

function matchCompletionStage(
  completion: BackendCompletionState,
  runId: string,
  candidate: string,
  stageValue: unknown,
  prepared: PreparedCompletionFacts,
  expectedBase: NativeHarnessCompletionBase | null,
): MatchedCompletionStage {
  if (readOwnData(stageValue, "status").value !== "completed") {
    throw new CompletionUnavailable(`${candidate} stage is not completed`);
  }
  if (readOwnData(stageValue, "id").value !== candidate) {
    throw new CompletionUnavailable(`${candidate} stage identity does not match`);
  }
  const attempt = readOwnData(stageValue, "attempt").value;
  if (!isPositiveSafeInteger(attempt)) {
    throw new CompletionUnavailable(`${candidate} stage attempt is unavailable`);
  }
  const cwd = boundedCompletionPath(readOwnData(stageValue, "cwd").value);
  if (cwd === null) throw new CompletionUnavailable(`${candidate} stage cwd is unavailable`);
  const artifactHash = boundedCompletionHash(readOwnData(stageValue, "artifactHash").value);
  if (artifactHash === null) throw new CompletionUnavailable(`${candidate} artifact hash is unavailable`);
  const traceHash = boundedCompletionHash(readOwnData(stageValue, "traceHash").value);
  if (traceHash === null) throw new CompletionUnavailable(`${candidate} trace hash is unavailable`);
  const stageParent = readStageParent(stageValue);

  const copied = copyWitnessResult(readOwnData(stageValue, "result").value);
  if (copied.result === null) {
    throw new CompletionUnavailable(`${candidate} result facts are unavailable`);
  }
  const result = copied.result;
  if (result.status !== "completed") {
    throw new CompletionUnavailable(`${candidate} result is not completed`);
  }

  const matches: Array<{ readonly witness: NativeHarnessCompletionWitness }> = [];
  for (const slot of completion.witnesses) {
    const witness = slot.witness;
    if (!witness.eligible || witness.facts === null || witness.result === null) continue;
    const facts = witness.facts;
    if (
      facts.runId !== runId
      || facts.stage !== candidate
      || facts.role !== "solver"
      || facts.attempt !== attempt
      || facts.cwd !== cwd
    ) {
      continue;
    }
    if (!sameCompletionParent(facts.parent, stageParent)) continue;
    if (facts.base === null || !witnessBaseMatchesPrepared(facts.base, prepared)) continue;
    if (expectedBase !== null && !sameWitnessBase(facts.base, expectedBase)) continue;
    if (result.eventsPath !== path.join(facts.artifactDir, "worker-events.jsonl")) continue;
    if (witness.result.eventsPath !== result.eventsPath) continue;
    if (!sameWitnessResult(witness.result, result)) continue;
    matches.push({ witness });
  }
  if (matches.length !== 1) {
    throw new CompletionUnavailable(
      matches.length === 0
        ? `${candidate} has no matching completed dispatch witness`
        : `${candidate} has ambiguous matching dispatch witnesses`,
    );
  }
  const matched = matches[0]!.witness;
  const facts = matched.facts!;
  const returned = matched.result!;
  const base = facts.base!;
  return {
    selection: Object.freeze({
      candidate,
      attempt,
      cwd,
      artifactHash,
      traceHash,
      witnessSequence: matched.sequence,
      artifactDir: facts.artifactDir,
      eventsPath: returned.eventsPath,
      resultStatus: "completed" as const,
      startedAt: returned.startedAt,
      endedAt: returned.endedAt,
      textBytes: returned.textBytes,
      textSha256: returned.textSha256,
    }),
    base,
    parent: stageParent,
  };
}

function failCompletion(completion: BackendCompletionState, reason: unknown): void {
  completion.conflicted = true;
  completion.conflictReason ??= boundedCompletionReason(reason);
}

/** Builds one immutable projection from the actual completed execution. */
function buildNativeHarnessCompletion(
  state: BackendState,
  record: RunRecord,
  host: NativeHarnessBackendHostConfig,
  completionId: string,
): NativeHarnessBackendCompletion {
  const completion = state.completion;
  if (completion.provenanceFailure !== null) {
    throw new CompletionUnavailable(completion.provenanceFailure);
  }
  if (completion.overflow) {
    throw new CompletionUnavailable(completion.overflowReason ?? "witness metadata budget exceeded");
  }
  if (completion.witnessFailure !== null) {
    throw new CompletionUnavailable(completion.witnessFailure);
  }
  if (state.runId === null || state.taskSha256 === null || state.descriptor === null) {
    throw new CompletionUnavailable("backend completion state is not the actual created run");
  }
  const runId = state.runId;
  const prepared = copyPreparedCompletionFacts(state.descriptor);
  if (readOwnData(record, "status").value !== "completed") {
    throw new CompletionUnavailable("run record status is not completed");
  }
  if (readOwnData(record, "id").value !== runId) {
    throw new CompletionUnavailable("run record id is not the backend-created run");
  }
  if (readOwnData(record, "workspace").value !== prepared.workspaceRoot) {
    throw new CompletionUnavailable("run record workspace is not the prepared private workspace");
  }
  const task = readOwnData(record, "task").value;
  if (typeof task !== "string" || sha256Hex(task) !== state.taskSha256) {
    throw new CompletionUnavailable("run record task is not the actual created task");
  }
  const config = readOwnData(record, "config").value;
  if (
    readOwnData(config, "strategy").value !== "auto"
    || readOwnData(config, "mode").value !== "product"
    || readOwnData(config, "domain").value !== NATIVE_HARNESS_BACKEND_DOMAIN
  ) {
    throw new CompletionUnavailable("run configuration is not the fixed auto/product/generic profile");
  }
  if (
    readOwnData(config, "model").value !== host.model
    || readOwnData(config, "improverModel").value !== host.model
  ) {
    throw new CompletionUnavailable("run model is not the fixed host model");
  }
  if (readOwnData(config, "ompCommand").value !== host.ompCommand) {
    throw new CompletionUnavailable("run ompCommand is not the fixed host executable");
  }
  if (!sameAuth(host.auth, readOwnData(config, "auth").value)) {
    throw new CompletionUnavailable("run authentication source is not the fixed host authentication source");
  }
  if (readOwnData(config, "execution").present) {
    throw new CompletionUnavailable("run configuration contains a native execution override");
  }
  const adaptation = readOwnData(config, "adaptation").value;
  if (
    readOwnData(adaptation, "capabilities").value !== EXPECTED_ADAPTATION.capabilities
    || readOwnData(adaptation, "reuse").value !== EXPECTED_ADAPTATION.reuse
    || readOwnData(adaptation, "learnMethods").value !== EXPECTED_ADAPTATION.learnMethods
  ) {
    throw new CompletionUnavailable("run adaptation policy is not the fixed host policy");
  }

  const snapshot = readOwnData(record, "snapshot").value;
  if (snapshot === null || typeof snapshot !== "object") {
    throw new CompletionUnavailable("actual Harness2 base snapshot is missing");
  }
  const stages = readOwnData(record, "stages").value;
  if (stages === null || typeof stages !== "object") {
    throw new CompletionUnavailable("actual Harness2 stages are unavailable");
  }
  const winner = readOwnData(record, "winner").value;
  if (
    typeof winner !== "string"
    || !(NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(winner)
  ) {
    throw new CompletionUnavailable("selected candidate is not a fixed solver stage");
  }
  const winnerStage = readOwnData(stages, winner).value;
  const winnerMatch = matchCompletionStage(completion, runId, winner, winnerStage, prepared, null);
  if (!snapshotMatchesWitnessBase(snapshot, winnerMatch.base)) {
    throw new CompletionUnavailable("run record snapshot does not exactly match the checked base snapshot");
  }
  const runRoot = path.join(prepared.storeRoot, "runs", runId);
  if (
    winnerMatch.base.root !== path.resolve(winnerMatch.base.root)
    || !isContained(runRoot, winnerMatch.base.root)
  ) {
    throw new CompletionUnavailable("base snapshot root is not confined to the private run store");
  }

  if (winner === "refine") {
    if (winnerMatch.parent === null) {
      throw new CompletionUnavailable("refine has no matching dispatch parent");
    }
  } else if (winnerMatch.parent !== null) {
    throw new CompletionUnavailable("non-refine candidate has an unexpected dispatch parent");
  }

  const ancestry: NativeHarnessCompletionSelection[] = [];
  const visited = new Set<string>([winner]);
  let currentParent = winnerMatch.parent;
  while (currentParent !== null) {
    const parentId = currentParent.candidate;
    if (visited.has(parentId)) throw new CompletionUnavailable("refinement ancestry contains a cycle");
    if (ancestry.length >= NATIVE_HARNESS_COMPLETION_LIMITS.maxAncestryStages) {
      throw new CompletionUnavailable("refinement ancestry exceeds its bound");
    }
    visited.add(parentId);
    const parentStage = readOwnData(stages, parentId).value;
    const parentMatch = matchCompletionStage(
      completion,
      runId,
      parentId,
      parentStage,
      prepared,
      winnerMatch.base,
    );
    if (parentMatch.selection.artifactHash !== currentParent.artifactHash) {
      throw new CompletionUnavailable("refinement parent artifact hash does not match the child reference");
    }
    ancestry.push(parentMatch.selection);
    currentParent = parentMatch.parent;
  }

  const issued: NativeHarnessBackendCompletion = deepFreeze({
    schema: NATIVE_HARNESS_COMPLETION_SCHEMA,
    origin: NATIVE_HARNESS_COMPLETION_ORIGIN,
    completionId,
    sourceId: NATIVE_HARNESS_COMPLETION_SOURCE_ID,
    sourceIntegrity: NATIVE_HARNESS_COMPLETION_SOURCE_INTEGRITY,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    runId,
    taskSha256: state.taskSha256,
    model: host.model,
    profile: { strategy: "auto" as const, mode: "product" as const, domain: "generic" as const },
    prepared,
    base: {
      snapshotId: winnerMatch.base.snapshotId,
      root: winnerMatch.base.root,
      sourceRoot: winnerMatch.base.sourceRoot,
      createdAt: winnerMatch.base.createdAt,
      manifestSha256: winnerMatch.base.manifestSha256,
      entries: winnerMatch.base.entries,
    },
    winner: winnerMatch.selection,
    ancestry,
    limitations: NATIVE_HARNESS_COMPLETION_LIMITATIONS,
  });
  const bytes = completionMetadataBytes(issued);
  if (bytes === null || bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxCompletionMetadataBytes) {
    throw new CompletionUnavailable("completion metadata exceeded its bound");
  }
  return issued;
}

/**
 * Observes one fulfilled execute. The first completed observation may issue;
 * every later fulfilled observation is compared with the sealed facts and a
 * difference makes completion availability sticky-unavailable.
 */
function observeNativeHarnessCompletion(
  state: BackendState,
  record: RunRecord,
  host: NativeHarnessBackendHostConfig,
): void {
  const completion = state.completion;
  if (completion.conflicted) return;
  if (completion.issued !== null) {
    try {
      if (readOwnData(record, "status").value !== "completed") {
        throw new CompletionUnavailable("repeated execute status is not the sealed completed status");
      }
      const observed = buildNativeHarnessCompletion(state, record, host, completion.issued.completionId);
      if (!sameBoundedProjection(observed, completion.issued)) {
        throw new CompletionUnavailable("repeated completion observation does not match the issued facts");
      }
    } catch (error) {
      failCompletion(
        completion,
        error instanceof CompletionUnavailable ? error.message : "completion projection failed",
      );
    }
    return;
  }
  if (readOwnData(record, "status").value !== "completed") return;
  try {
    completion.issued = buildNativeHarnessCompletion(state, record, host, randomUUID());
  } catch (error) {
    failCompletion(
      completion,
      error instanceof CompletionUnavailable ? error.message : "completion projection failed",
    );
  }
}

function makeBackend(
  state: BackendState,
  host: NativeHarnessBackendHostConfig,
  budget: PrepareBudget,
  now: () => number,
  testOptions: NormalizedTestOptions,
): NativeHarnessBackend & { inspect(): NativeHarnessBackendDiagnostic } {
  const requireController = (): HarnessController => {
    if (state.controller === null) throw new Error("actual Harness2 controller is unavailable");
    return state.controller;
  };
  const requireCreated = (runId: string): HarnessController => {
    if (state.runId === null) throw new Error("backend has not created a run");
    if (runId !== state.runId) throw new Error("requested run id is not the backend-created run");
    return requireController();
  };
  const backend = {
    async create(task: string): Promise<unknown> {
      const boundedTask = readTask(task);
      const durable = state.durable;
      if (durable !== null) {
        // Install the one-attempt latch synchronously, before any clock
        // callback or await. A pending, fulfilled or rejected attempt never
        // permits a second Controller.create.
        if (durable.createAttempted) {
          throw new Error("durable backend run creation was already attempted");
        }
        durable.createAttempted = true;
        assertDurableSignal(durable);
        if (durableDeadlineExpired(durable, readNow(now))) {
          throw new Error("the admitted delegation deadline expired before backend run creation");
        }
        const verifyGuard = durableLocalGuard(state, durable, now);
        await verifyNativeHarnessRecoverySource(durable.source, verifyGuard, durable.signal);
        // New source I/O consumes the original window. Re-read the actual
        // clock and signal, then narrow the inner config by what remains.
        const current = readNow(now);
        assertDurableSignal(durable);
        const remaining = Math.floor(durable.deadlineAt - current);
        if (!Number.isFinite(remaining) || remaining < 1) {
          throw new Error("the admitted delegation deadline expired during backend run creation");
        }
        const maxDurationMs = Math.min(
          remaining,
          Math.floor(budget.maxDurationMs),
          NATIVE_HARNESS_MAX_DURATION_MS,
        );
        if (maxDurationMs < 1) throw new Error("the admitted delegation duration is exhausted");
        const controller = requireController();
        const config: Partial<RunConfig> & { model: string } = {
          mode: "product",
          strategy: "auto",
          model: host.model,
          improverModel: host.model,
          maxCostUsd: budget.maxCostUsd,
          maxDurationMs,
          stageTimeoutMs: maxDurationMs,
          domain: NATIVE_HARNESS_BACKEND_DOMAIN,
          ompCommand: host.ompCommand,
          ...(host.auth === undefined ? {} : { auth: host.auth }),
          adaptation: EXPECTED_ADAPTATION,
        };
        const created = await controller.create(boundedTask, config, {
          recoverySeedText: durable.seedText,
        });
        const createdId = readOwnData(created, "id").value;
        if (typeof createdId !== "string" || !UUID_PATTERN.test(createdId)) {
          throw new Error("actual Harness2 create returned no canonical run ID");
        }
        // Preserve the known created association before any pure origin check.
        // No later abort, clock change or origin mismatch discards this ID.
        state.runId = createdId;
        state.taskSha256 = sha256Hex(boundedTask);
        // Read the initial status as own data, never through a getter. A
        // malformed or unreadable status is a noncritical diagnostic: the
        // known ID is retained and execution becomes sticky-refused.
        const statusValue = readOwnData(created, "status");
        if (!statusValue.readable || statusValue.value !== "queued") {
          state.status = "unknown";
          state.record.backendStatus = "unknown";
          durable.executionRefusal = "created run initial status is unreadable or malformed";
        } else {
          state.status = "queued";
          state.record.backendStatus = "queued";
        }
        state.record.runId = createdId;
        state.record.retainedForInspection = true;
        try {
          const origin = originFromRecord(created, createdId);
          if (!sameOriginSeed(origin.seed, durable.expectedSeed)) {
            throw new Error("actual initial recovery origin seed does not match the prepared source");
          }
          durable.origin = origin;
        } catch (error) {
          if (durable.executionRefusal === null) {
            durable.executionRefusal = boundedReason(
              `created run recovery origin did not match the prepared source: ${boundedReason(error)}`,
            );
          }
        }
        if (durable.origin !== null && durable.executionRefusal === null) {
          let handle: NativeHarnessDispatchInventoryHandle | null = null;
          try {
            const guard = durableLocalGuard(state, durable, now);
            guard();
            handle = await createNativeHarnessDispatchInventory(
              { storeRoot: controller.store.root, runId: createdId },
              testOptions.dispatchInventoryTestOptions ?? undefined,
            );
            guard();
            durable.inventory = handle;
          } catch (error) {
            if (handle !== null && durable.inventory !== handle) handle.close();
            durable.executionRefusal = boundedReason(
              `durable dispatch inventory creation failed: ${boundedReason(error)}`,
            );
          }
        }
        return { runId: createdId };
      }
      const current = readNow(now);
      const remaining = Math.floor(budget.deadlineAt - current);
      if (!Number.isFinite(remaining) || remaining < 1) {
        throw new Error("the admitted delegation deadline expired before backend run creation");
      }
      const maxDurationMs = Math.min(
        remaining,
        Math.floor(budget.maxDurationMs),
        NATIVE_HARNESS_MAX_DURATION_MS,
      );
      if (maxDurationMs < 1) throw new Error("the admitted delegation duration is exhausted");
      const controller = requireController();
      const config: Partial<RunConfig> & { model: string } = {
        mode: "product",
        strategy: "auto",
        model: host.model,
        improverModel: host.model,
        maxCostUsd: budget.maxCostUsd,
        maxDurationMs,
        stageTimeoutMs: maxDurationMs,
        domain: NATIVE_HARNESS_BACKEND_DOMAIN,
        ompCommand: host.ompCommand,
        ...(host.auth === undefined ? {} : { auth: host.auth }),
        adaptation: EXPECTED_ADAPTATION,
      };
      const record = await controller.create(boundedTask, config);
      state.runId = record.id;
      state.taskSha256 = sha256Hex(boundedTask);
      state.status = record.status;
      state.record.runId = record.id;
      state.record.backendStatus = record.status;
      state.record.retainedForInspection = true;
      return { runId: record.id };
    },
    async execute(runId: string): Promise<unknown> {
      const controller = requireCreated(runId);
      if (state.durable !== null) {
        if (state.durable.executionRefusal !== null) {
          throw new Error(state.durable.executionRefusal);
        }
        // The clock callback may synchronously abort. Read it before the final
        // actual signal observation so an abort during the callback is seen.
        if (durableDeadlineExpired(state.durable, readNow(now))) {
          throw new Error("the admitted delegation deadline expired before backend execution");
        }
        assertDurableSignal(state.durable);
      }
      let record: RunRecord;
      try {
        record = await controller.execute(runId);
      } finally {
        const durable = state.durable;
        if (durable !== null && durable.inventory !== null && !durable.inventoryClosed) {
          // No new lifecycle write may start once original execution ended.
          // Already-started operations may settle before the close.
          durable.closeRequested = true;
          // Runner rejection is not proof that its checkpoint work settled.
          // Keep each original operation and close only after actual settlement.
          while (durable.inventoryPending.size > 0) {
            await Promise.allSettled([...durable.inventoryPending]);
          }
          durable.completionRows = durable.inventory.snapshot().dispatches.map((row) => ({
            state: row.state,
            ordinal: row.ordinal,
          }));
          durable.inventory.close();
          durable.inventoryClosed = true;
        }
      }
      state.status = record.status;
      state.record.backendStatus = record.status;
      state.record.retainedForInspection = true;
      // A completed durable run is accepted only when every bound dispatch has
      // its own acknowledged terminal. Passing a port is not consumption; a
      // Runner that ignored the bridge leaves intended rows and no witness.
      const durable = state.durable;
      if (durable !== null && record.status === "completed") {
        const rows = durable.completionRows;
        const unresolved = rows?.find((row) => row.state !== "terminal");
        if (rows === null || rows.length === 0 || unresolved !== undefined) {
          failCompletion(
            state.completion,
            rows === null
              ? "durable dispatch inventory is unavailable for completion"
              : rows.length === 0
                ? "durable run completed without a bound dispatch"
                : `durable dispatch ${unresolved!.ordinal} lifecycle is ${unresolved!.state}`,
          );
        } else {
          observeNativeHarnessCompletion(state, record, host);
        }
      } else {
        observeNativeHarnessCompletion(state, record, host);
      }
      return { status: record.status };
    },
    async cancel(runId: string): Promise<unknown> {
      const controller = requireCreated(runId);
      await controller.cancel(runId);
      const record = await controller.get(runId);
      if (record !== undefined) {
        state.status = record.status;
        state.record.backendStatus = record.status;
      }
      return { requested: true, status: state.status };
    },
    async get(runId: string): Promise<unknown> {
      const controller = requireCreated(runId);
      const record = await controller.get(runId);
      if (record === undefined) return null;
      state.status = record.status;
      state.record.backendStatus = record.status;
      return { status: record.status };
    },
    inspect(): NativeHarnessBackendDiagnostic {
      return diagnosticOf(state.record);
    },
  };
  const frozen = Object.freeze(backend);
  BACKEND_COMPLETION_STATES.set(frozen, state);
  return frozen;
}

export function createNativeHarnessBackend(
  hostConfig: NativeHarnessBackendHostConfig,
  testOptions?: NativeHarnessBackendTestOptions,
): NativeHarnessBackendHost & {
  readonly inspectExisting: (
    target: NativeHarnessExistingInspectionTarget,
    context: NativeContext,
    control: NativeHarnessExistingInspectionControl,
  ) => Promise<NativeHarnessExistingInspectionResult>;
} {
  const host = readHostConfig(hostConfig);
  const options = readTestOptions(testOptions);
  const runner = options.deterministicRunner ?? new OmpRpcRunner();
  const records: RetainedRecord[] = [];
  const now = options.now ?? Date.now;

  async function prepare(
    requestValue: NativeHarnessPrepareRequest,
    _context: NativeContext,
  ): Promise<NativeHarnessPrepareResult> {
    let request: PrepareFacts;
    try {
      request = readPrepareFacts(requestValue);
    } catch (error) {
      return failed(error);
    }

    // Budget validation has no filesystem effect and does not consume authority.
    let current: number;
    try {
      current = readNow(now);
    } catch (error) {
      return failed(error);
    }
    if (Math.floor(request.budget.deadlineAt - current) < 1) {
      return failed("the admitted delegation deadline has expired before preparation");
    }

    // Durable preparation validates every host guard return synchronously,
    // then re-reads the actual signal after the guard (and after any deadline
    // clock callback) before the next effect. Legacy preparation invokes the
    // original guard exactly as before. This wrapper is local and is never
    // captured after preparation returns.
    const checkedGuard = (
      deadlineMessage: string | null = null,
      abortedMessage = "preparation was aborted before the next effect",
    ): void => {
      if (request.accounting === null) {
        request.guard();
        return;
      }
      assertSynchronousGuardResult(request.guard());
      if (
        deadlineMessage !== null
        && Math.floor(request.budget.deadlineAt - readNow(now)) < 1
      ) {
        throw new Error(deadlineMessage);
      }
      const aborted = signalAborted(request.signal);
      if (aborted === null) throw new Error("preparation signal is unreadable");
      if (aborted) throw new Error(abortedMessage);
    };

    // This guard opens only for preparation. It is never captured by the
    // backend or consulted after this function returns.
    try {
      checkedGuard();
    } catch (error) {
      return failed(`prepared authority was rejected: ${boundedReason(error)}`);
    }

    let descriptor: NativeHarnessWorkspaceDescriptor;
    try {
      descriptor = await prepareNativeHarnessWorkspace(
        {
          sourceRoot: request.workspaceRoot,
          storageRoot: host.storageRoot,
          inputFiles: host.inputFiles,
        },
        checkedGuard,
        request.signal,
      );
    } catch (error) {
      if (
        error instanceof NativeHarnessWorkspaceError
        && error.preparedRoot !== null
        && error.cleanup !== "removed"
      ) {
        retain(records, recordFromPreparedRoot(error.preparedRoot, error.message));
      }
      return failed(error);
    }

    let currentAfter: number;
    try {
      currentAfter = readNow(now);
    } catch (error) {
      retain(records, recordFromDescriptor(descriptor, true, `${boundedReason(error)}`));
      return failed(error);
    }
    if (Math.floor(request.budget.deadlineAt - currentAfter) < 1) {
      const reason = "the admitted delegation deadline expired during preparation";
      retain(records, recordFromDescriptor(descriptor, true, reason));
      return failed(reason);
    }
    const abortedAfter = signalAborted(request.signal);
    if (abortedAfter === null || abortedAfter) {
      const reason = "preparation signal became unreadable or aborted after the private workspace was created";
      retain(records, recordFromDescriptor(descriptor, true, reason));
      return failed(reason);
    }

    let durable: DurableBackendState | null = null;
    if (request.accounting !== null && request.association !== null) {
      try {
        const prepareGuard = (): void => {
          checkedGuard(
            "the admitted delegation deadline expired before recovery source creation",
            "preparation was aborted before recovery source creation",
          );
        };
        prepareGuard();
        const canonicalStorageRoot = await realDirectoryExact(host.storageRoot, "host storage root");
        prepareGuard();
        const prepared = await prepareNativeHarnessRecoverySource(
          {
            storageRoot: canonicalStorageRoot,
            descriptor,
            association: request.association,
            accounting: request.accounting,
            budget: request.budget,
            backendProfile: {
              model: host.model,
              improverModel: host.model,
              ompCommand: host.ompCommand,
              mode: "product",
              strategy: "auto",
              domain: NATIVE_HARNESS_BACKEND_DOMAIN,
              adaptation: EXPECTED_ADAPTATION,
            },
            backendBuild: {
              sourceId: NATIVE_HARNESS_COMPLETION_SOURCE_ID,
              sourceIntegrity: NATIVE_HARNESS_COMPLETION_SOURCE_INTEGRITY,
            },
          },
          prepareGuard,
          request.signal,
        );
        // Final synchronous preparation authority read. checkedGuard validates
        // the guard return, then the deadline clock callback, then the actual
        // signal. No await follows before the original Controller is
        // constructed.
        checkedGuard(
          "the admitted delegation deadline expired during recovery source creation",
          "preparation was aborted after recovery source creation",
        );
        durable = {
          source: prepared.source,
          seedText: prepared.seedText,
          expectedSeed: Object.freeze({
            schema: NATIVE_HARNESS_RECOVERY_SEED_SCHEMA,
            profile: NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
            accountingOwnerId: request.accounting.ownerId,
            admissionId: request.accounting.admissionId,
            accountingOwnerRevision: request.accounting.reserveRevision,
            sourceAssociationSha256: request.accounting.sourceAssociationSha256,
            sourceDescriptorSha256: prepared.source.sha256,
            inputManifestSha256: descriptor.manifestSha256,
            admittedAt: request.accounting.admittedAt,
            deadlineAt: request.budget.deadlineAt,
            allocatedCostUsd: request.budget.maxCostUsd,
          }),
          accountingPrepared: prepared.accountingPrepared,
          accounting: request.accounting,
          association: request.association,
          signal: request.signal,
          deadlineAt: request.budget.deadlineAt,
          createAttempted: false,
          origin: null,
          executionRefusal: null,
          inventory: null,
          inventoryClosed: false,
          closeRequested: false,
          inventoryPending: new Set(),
          completionRows: null,
        };
      } catch (error) {
        const reason = `recovery source preparation failed: ${boundedReason(error)}`;
        retain(records, recordFromDescriptor(descriptor, true, reason));
        return failed(reason);
      }
    } else {
      // Legacy preparation retains its exact final authority read: no source
      // effect, seed, origin or new accounting field is produced.
      try {
        checkedGuard();
      } catch (error) {
        const reason = `prepared authority was rejected after the private workspace was created: ${boundedReason(error)}`;
        retain(records, recordFromDescriptor(descriptor, true, reason));
        return failed(reason);
      }
    }

    const record = recordFromDescriptor(descriptor, false, null);
    retain(records, record);
    const state: BackendState = {
      controller: null,
      descriptor,
      runId: null,
      taskSha256: null,
      status: null,
      durable,
      record,
      completion: createCompletionState(),
    };
    const expected: GateExpectation = {
      state,
      host,
      descriptor,
      budget: request.budget,
      options,
      durable,
    };
    try {
      const gateRunner = createBaseInputGateRunner(request.runner, expected);
      const controller = new HarnessController({
        workspace: descriptor.workspaceRoot,
        storeRoot: descriptor.storeRoot,
        runner: gateRunner,
      });
      state.controller = controller;
    } catch (error) {
      const reason = `actual Harness2 controller construction failed: ${boundedReason(error)}`;
      record.retainedForInspection = true;
      record.reason = boundedReason(reason);
      return failed(reason);
    }

    try {
      return {
        ok: true,
        backend: makeBackend(state, host, request.budget, now, options),
        ...(durable === null ? {} : { accountingPrepared: durable.accountingPrepared }),
      };
    } catch (error) {
      const reason = `actual Harness2 backend construction failed: ${boundedReason(error)}`;
      record.retainedForInspection = true;
      record.reason = boundedReason(reason);
      return failed(reason);
    }
  }

  async function inspectExisting(
    targetValue: NativeHarnessExistingInspectionTarget,
    context: NativeContext,
    controlValue: NativeHarnessExistingInspectionControl,
  ): Promise<NativeHarnessExistingInspectionResult> {
    try {
      // Own every caller value before the first await. The target is only a
      // locator; the original lease, observer and source root remain fixed.
      const target = readExistingInspectionTarget(targetValue);
      const control = readExistingInspectionControl(controlValue);
      const cwd = readOwnData(context, "cwd");
      if (!cwd.readable || typeof cwd.value !== "string") {
        throw new Error("existing inspection context.cwd must be one own string");
      }
      const sourceRootInput = readAbsolutePath(cwd.value, "context.cwd");
      if (path.normalize(sourceRootInput) !== sourceRootInput) {
        throw new Error("existing inspection context.cwd must be a canonical absolute path");
      }
      inspectionControlCheck(control);

      const storageRoot = await checkedInspectionDirectory(host.storageRoot, "host storage root", control);
      const preparedRoot = path.join(storageRoot, target.preparedRelativeRoot);
      if (path.dirname(preparedRoot) !== storageRoot) {
        throw new Error("existing inspection prepared root must be a direct child of the host storage root");
      }
      await checkedInspectionDirectory(preparedRoot, "prepared root", control);
      const workspaceRoot = path.join(preparedRoot, "workspace");
      const storeRoot = path.join(preparedRoot, "store");
      await checkedInspectionDirectory(workspaceRoot, "prepared workspace", control);
      await checkedInspectionDirectory(storeRoot, "prepared store", control);
      const sourceRoot = await checkedInspectionDirectory(sourceRootInput, "inspection source root", control);

      const expected = Object.freeze({
        runId: target.runId,
        ownerId: target.ownerId,
        selectorSha256: target.selectorSha256,
        storageRoot,
        sourceRoot,
        preparedRelativeRoot: target.preparedRelativeRoot,
        backendBuildSourceId: NATIVE_HARNESS_COMPLETION_SOURCE_ID,
      });
      const seams = options.recoveryInspectionOptions;
      const observationOptions = (signal: AbortSignal): NativeHarnessReconciliationLifecycleOptions => ({
        signal,
        now,
        verifyInitialPreparedInputs: true,
        ...(seams?.fileIo === null || seams?.fileIo === undefined ? {} : { fileIo: seams.fileIo }),
        ...(seams?.signalQuery === null || seams?.signalQuery === undefined ? {} : { signalQuery: seams.signalQuery }),
      });
      const captured: {
        observation: NativeHarnessReconciliationLifecycleResult | null;
        leaseOwnerSha256: string | null;
      } = { observation: null, leaseOwnerSha256: null };
      const inspector = async (
        view: HarnessRecoveryInspectionView,
        signal: AbortSignal,
      ): Promise<void> => {
        inspectionControlCheck(control);
        await view.assertCurrent();
        inspectionControlCheck(control);
        const observation = await observeNativeHarnessReconciliation(expected, observationOptions(signal));
        inspectionControlCheck(control);
        await view.assertCurrent();
        inspectionControlCheck(control);
        captured.observation = observation;
        captured.leaseOwnerSha256 = view.ownerSha256;
      };
      const controller = new HarnessController({
        workspace: workspaceRoot,
        storeRoot,
        runner,
        recoveryInspector: inspector,
      });
      inspectionControlCheck(control);
      await controller.inspectWithRecoveryLease(target.runId, control.signal);

      // The Controller's lease is released. The host guard runs before the
      // final clock callback; the actual signal is then read again after the
      // clock and after the pure wire build, immediately before return.
      inspectionControlCheck(control);
      const finalNow = readNow(now);
      const observation = captured.observation;
      const ownerSha256 = captured.leaseOwnerSha256;
      if (observation === null || ownerSha256 === null) {
        return { ok: false, reason: "existing inspection refused: no leased observation" };
      }
      if (!HEX_64_PATTERN.test(ownerSha256)) {
        return { ok: false, reason: "existing inspection refused: lease-owner-unreadable" };
      }
      if (finalNow < observation.deadline.checkedAt) {
        return { ok: false, reason: "existing inspection refused: final-clock-backward" };
      }
      if (finalNow >= observation.deadline.deadlineAt) {
        return { ok: false, reason: "existing inspection refused: final-clock-expired" };
      }
      const refusal = existingInspectionRefusal(observation, ownerSha256);
      if (refusal !== null) return { ok: false, reason: boundedReason(refusal) };
      const diagnostic: NativeHarnessExistingInspectionDiagnostic = deepFreeze({
        schema: NATIVE_HARNESS_EXISTING_INSPECTION_SCHEMA,
        readOnly: true as const,
        resumeAvailable: false as const,
        runId: target.runId,
        leaseOwnerSha256: ownerSha256,
        observation,
      });
      const wire = deepFreeze({ ok: true as const, diagnostic });
      if (
        Buffer.byteLength(JSON.stringify(wire), "utf8")
        > NATIVE_HARNESS_EXISTING_INSPECTION_MAX_BYTES
      ) {
        return { ok: false, reason: "existing inspection refused: result-exceeds-128KiB" };
      }
      inspectionSignalCheck(control);
      return wire;
    } catch (error) {
      return { ok: false, reason: boundedReason(error) };
    }
  }

  return Object.freeze({
    runner,
    prepare,
    inspectExisting,
    inspect(): readonly NativeHarnessBackendDiagnostic[] {
      return deepFreeze(records.map(diagnosticOf));
    },
  });
}

/**
 * Returns only the completion already issued by this exact actual backend.
 * Synchronous; no filesystem, host callback, model call or reflection on the
 * supplied value. A foreign object, clone or proxy is not an association key.
 */
export function readNativeHarnessBackendCompletion(
  backend: unknown,
): { readonly ok: true; readonly completion: NativeHarnessBackendCompletion }
  | { readonly ok: false; readonly reason: string } {
  const state = typeof backend === "object" && backend !== null
    ? BACKEND_COMPLETION_STATES.get(backend)
    : undefined;
  if (state === undefined) {
    return { ok: false, reason: "unknown native harness backend object" };
  }
  const completion = state.completion;
  if (completion.conflicted) {
    return {
      ok: false,
      reason: completion.conflictReason ?? "native completion is unavailable",
    };
  }
  if (completion.issued !== null) {
    return { ok: true, completion: completion.issued };
  }
  return { ok: false, reason: "no native completion has been issued" };
}

/**
 * True only for the same exact backend object and the same exact completion
 * object, while the completion state has not observed a mismatch.
 */
export function matchesNativeHarnessBackendCompletion(
  backend: unknown,
  completion: unknown,
): boolean {
  const state = typeof backend === "object" && backend !== null
    ? BACKEND_COMPLETION_STATES.get(backend)
    : undefined;
  if (state === undefined) return false;
  if (state.completion.conflicted) return false;
  const issued = state.completion.issued;
  return issued !== null && issued === completion;
}
