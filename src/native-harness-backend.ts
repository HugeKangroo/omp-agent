import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  HarnessController,
  OmpRpcRunner,
  type OmpProfileAuth,
  type RunConfig,
  type RunRecord,
  type Runner,
  type WorkerRequest,
  type WorkerResult,
} from "../vendor/harness2/index.ts";
import type { NativeContext } from "./native-entry.ts";
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
  type NativeHarnessBackend,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "./native-harness-delegation.ts";
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
} from "./native-work.ts";

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
  inspect(): readonly NativeHarnessBackendDiagnostic[];
}

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
}

interface NormalizedTestOptions {
  readonly deterministicRunner: Runner | null;
  readonly now: (() => number) | null;
  readonly beforeBaseInputCheck: ((facts: {
    readonly runId: string;
    readonly snapshotRoot: string;
  }) => void | Promise<void>) | null;
  readonly mutateWorkerRequest: ((request: WorkerRequest) => void) | null;
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

interface BackendState {
  controller: HarnessController | null;
  descriptor: NativeHarnessWorkspaceDescriptor | null;
  runId: string | null;
  taskSha256: string | null;
  status: string | null;
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
}

interface PrepareFacts {
  readonly workspaceRoot: string;
  readonly budget: PrepareBudget;
  readonly signal: AbortSignal;
  readonly runner: Runner;
  readonly guard: () => void;
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

function readTestOptions(value: unknown): NormalizedTestOptions {
  if (value === undefined) {
    return {
      deterministicRunner: null,
      now: null,
      beforeBaseInputCheck: null,
      mutateWorkerRequest: null,
    };
  }
  const fields = readStrictFields(
    value,
    ["deterministicRunner", "now", "beforeBaseInputCheck", "mutateWorkerRequest"],
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

function readPrepareFacts(value: unknown): PrepareFacts {
  const fields = readStrictFields(
    value,
    ["association", "budget", "signal", "runner", "guard"],
    ["association", "budget", "signal", "runner", "guard"],
  );
  if (fields === null) throw new Error("prepare request must be an exact plain object");
  const association = fields.get("association");
  const associationFields = readStrictFields(
    association,
    ["observationId", "generation", "sessionId", "workspaceRoot", "toolCallId", "toolName"],
    ["workspaceRoot"],
  );
  if (associationFields === null) throw new Error("prepare association is unreadable");
  const workspaceRoot = readAbsolutePath(associationFields.get("workspaceRoot"), "association.workspaceRoot");
  const budget = readBudget(fields.get("budget"));
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

function createBaseInputGateRunner(
  underlying: Runner,
  expected: GateExpectation,
): Runner {
  return Object.freeze({
    async run(request: WorkerRequest): Promise<WorkerResult> {
      const controller = expected.state.controller;
      if (controller === null) throw new Error("actual Harness2 controller is unavailable");
      expected.options.mutateWorkerRequest?.(request);
      assertWorkerRequest(request, expected);
      await verifyRequestPaths(request, expected);
      let record = await verifyRunRecord(controller, request.runId, expected);
      if (expected.options.beforeBaseInputCheck !== null) {
        const snapshotRoot = record.snapshot?.root;
        if (snapshotRoot === undefined) throw new Error("actual Harness2 base snapshot is missing");
        await expected.options.beforeBaseInputCheck(Object.freeze({
          runId: request.runId,
          snapshotRoot,
        }));
        record = await verifyRunRecord(controller, request.runId, expected);
      }
      const hostManifest = assertManifestPaths(record, expected);
      const checkedInputs: NativeHarnessCheckedBaseInput[] = [];
      await verifySnapshotFiles(record, expected, hostManifest, checkedInputs);
      const checkedRecord = record;
      // Re-read current Controller state after every asynchronous base-input
      // observation. A refusal here stops only worker dispatch; the Controller
      // may still settle its own private run record. No provider dispatch or
      // original-source write follows a refused gate.
      const finalRecord = await verifyRunRecord(controller, request.runId, expected);
      // The later reread is not byte-checked. Its snapshot must match the facts
      // actually checked above before the dispatch witness can support output.
      // A mismatch makes completion origin unavailable; it never refuses the
      // existing worker call or changes Controller accounting.
      const witnessIndex = reserveCompletionWitness(
        expected,
        request,
        checkedRecord,
        finalRecord,
        checkedInputs,
      );
      let result: WorkerResult;
      try {
        result = await underlying.run(request);
      } catch (error) {
        settleCompletionWitness(expected, witnessIndex, null, true);
        throw error;
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
      const record = await controller.execute(runId);
      state.status = record.status;
      state.record.backendStatus = record.status;
      state.record.retainedForInspection = true;
      // Observe this fulfilled execute before returning the existing status.
      // A projection failure never changes the result or hides the
      // Controller's settled accounting.
      observeNativeHarnessCompletion(state, record, host);
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
): NativeHarnessBackendHost {
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

    // This guard opens only for preparation. It is never captured by the
    // backend or consulted after this function returns.
    try {
      request.guard();
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
        request.guard,
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

    // Final synchronous preparation authority read. No await follows before
    // the Controller is constructed.
    try {
      request.guard();
    } catch (error) {
      const reason = `prepared authority was rejected after the private workspace was created: ${boundedReason(error)}`;
      retain(records, recordFromDescriptor(descriptor, true, reason));
      return failed(reason);
    }

    const record = recordFromDescriptor(descriptor, false, null);
    retain(records, record);
    const state: BackendState = {
      controller: null,
      descriptor,
      runId: null,
      taskSha256: null,
      status: null,
      record,
      completion: createCompletionState(),
    };
    const expected: GateExpectation = {
      state,
      host,
      descriptor,
      budget: request.budget,
      options,
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
        backend: makeBackend(state, host, request.budget, now),
      };
    } catch (error) {
      const reason = `actual Harness2 backend construction failed: ${boundedReason(error)}`;
      record.retainedForInspection = true;
      record.reason = boundedReason(reason);
      return failed(reason);
    }
  }

  return Object.freeze({
    runner,
    prepare,
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
