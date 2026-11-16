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
  runId: string | null;
  taskSha256: string | null;
  status: string | null;
  readonly record: RetainedRecord;
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
      await verifySnapshotFiles(record, expected, hostManifest);
      // Re-read current Controller state after every asynchronous base-input
      // observation. A refusal here stops only worker dispatch; the Controller
      // may still settle its own private run record. No provider dispatch or
      // original-source write follows a refused gate.
      await verifyRunRecord(controller, request.runId, expected);
      return await underlying.run(request);
    },
  });
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
  return Object.freeze(backend);
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
      runId: null,
      taskSha256: null,
      status: null,
      record,
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
