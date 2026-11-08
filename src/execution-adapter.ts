import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import type { Duplex } from "node:stream";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createFileAudit, type AuditEvent, type AuditSink } from "./audit.ts";
import {
  CandidateRegistry,
  type CandidateReadPort,
  type FrozenTaskRef,
} from "./execution-candidates.ts";
import { writeJsonAtomicSync } from "./host-record.ts";
import { requirementsDigest } from "./task-requirements.ts";
import {
  currentTaskOwner,
  subjectFromContext,
  type OmpToolContext,
} from "./task-entry-port.ts";
import type {
  BindingStatus,
  ManagedTask,
  TaskOwner,
  TaskOwnerEvent,
  TaskSubject,
} from "./task-owner.ts";

/**
 * G2-A1 generic single-task local script capability.
 *
 * The adapter is intentionally domain-free: it knows one task, one host
 * authorized capability, two host-selected runtimes, bounded source and
 * authorized input copies, a real OS sandbox, a wall-clock deadline, bounded
 * output and candidate artifact export. The model chooses only method and code;
 * the host chooses every path, runtime, environment entry and limit.
 */

export const EXECUTION_SCHEMA_VERSION = 1 as const;
export const EXECUTION_TOOL = "agent_execute";
export const EXECUTION_LIMITS_VERSION = "g2a2-v1" as const;
/**
 * The model-visible projection is versioned independently from host records.
 * Only tool content text reaches an OpenAI-completions model; details are
 * never serialized into the provider request.
 */
export const EXECUTION_MODEL_VIEW_VERSION = "g2a3-model-view-v1" as const;
export const EXECUTION_RUNTIMES = ["python", "bun"] as const;
export type ExecutionRuntime = (typeof EXECUTION_RUNTIMES)[number];

export const EXECUTION_LIMITS = {
  version: EXECUTION_LIMITS_VERSION,
  maxInputs: 8,
  maxInputBytes: 256 * 1024,
  maxTotalInputBytes: 1024 * 1024,
  maxSourceBytes: 32 * 1024,
  maxDispatches: 8,
  dispatchWallMs: 10_000,
  terminationGraceMs: 250,
  maxRetainedOutputBytes: 64 * 1024,
  maxFileSizeBytes: 256 * 1024,
  maxArtifacts: 8,
  maxArtifactTotalBytes: 1024 * 1024,
  maxToolResponseBytes: 128 * 1024,
} as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RESPONSE_LOG_PREVIEW_BYTES = 4096;
const MAX_SCAN_ENTRIES = 256;
const WATCHDOG_PROTOCOL = "g2a2-watchdog-v1" as const;
const WATCHDOG_CONTROL_MAX_LINE_BYTES = 4096;
const WATCHDOG_CONTROL_MAX_TOTAL_BYTES = 64 * 1024;
const WATCHDOG_CONTROL_MAX_EVENTS = 16;
const WATCHDOG_SETTLE_MS = 2000;
/** Bounded latch of dispatched runs whose external completion is unproven. */
const MAX_UNRESOLVED_COMPLETIONS = 64;
/** Per-run reason list stays small and stable. */
const MAX_UNRESOLVED_REASONS = 8;
// A terminal control message is a claim, not proof that the direct child
// exited. Allow only a small bounded window for the OS 'exit' event to be
// delivered before treating the watchdog loss as real.
const WATCHDOG_CHILD_EXIT_DRAIN_MS = 100;
/**
 * Exit code 111 is also a legal untrusted-script exit. The separate trusted
 * control channel distinguishes a pre-exec handshake failure from a settled
 * child; a numeric 111 after a validated acknowledgement still cannot prove
 * that no untrusted code executed.
 */
type LaunchStage = "spawn_failed" | "handshake_failed" | "child_ran" | "unknown";
const FORBIDDEN_RUN_KEYS = new Set([
  "command", "shell", "argv", "args", "path", "paths", "filePath", "inputPath",
  "cwd", "workDir", "home", "env", "environment", "endpoint", "url", "host",
  "port", "interpreter", "runtimePath", "bunPath", "pythonPath", "taskId",
  "ownerId", "capabilityId", "runId", "callId", "executionId", "budget",
  "policy", "permissions", "permission", "timeout", "limits", "sandbox",
  "profile", "outputPath", "artifactId", "token", "secret", "goal", "rawRequest",
  "revision",
]);

export class ExecutionAdapterError extends Error {
  override name = "ExecutionAdapterError";
}

export interface ExecutionInputConfig {
  id: string;
  /** Absolute host-authorized regular file path. Never a model argument. */
  path: string;
}

export interface ExecutionConfig {
  /** Host-owned root for fresh private run directories and auditable records. */
  root: string;
  inputs?: readonly ExecutionInputConfig[];
  capabilityId?: string;
  auditPath?: string;
  pythonPath?: string;
  bunPath?: string;
  launcherPath?: string;
  sandboxExecPath?: string;
  dispatchWallMs?: number;
  terminationGraceMs?: number;
  /** Host-owned record storage seam; defaults to the atomic JSON writer. */
  recordWriter?: (filePath: string, value: unknown) => void;
  now?: () => string;
  id?: () => string;
}

export interface ExecutionToolContext extends OmpToolContext {}

export interface ExecutionToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export type ExecutionArguments =
  | { action: "describe" }
  | {
    action: "run";
    runtime: ExecutionRuntime;
    source: string;
    inputIds: string[];
    expectedTaskId: string;
    expectedTaskRevision: number;
  };

export interface ExecutionRuntimeInfo {
  name: ExecutionRuntime;
  version: string;
  executable: string;
}

interface PreparedInput {
  id: string;
  sourcePath: string;
  stagedPath: string;
  bytes: number;
  sha256: string;
}

interface PreparedRun {
  runId: string;
  callId: string;
  runRoot: string;
  sourceRoot: string;
  inputRoot: string;
  workRoot: string;
  tmpRoot: string;
  artifactRoot: string;
  sourcePath: string;
  manifestPath: string;
  profilePath: string;
  profileSha256: string;
  watchdogLogPath: string;
  sourceBytes: number;
  sourceSha256: string;
  inputs: PreparedInput[];
  requirementsDigest: string;
  interpreter: string;
  interpreterArgs: string[];
  childEnv: NodeJS.ProcessEnv;
}

type StopReason =
  | "timeout"
  | "abort_signal"
  | "owner_cancelled"
  | "binding_detached"
  | "task_revised"
  | "output_limit"
  | "host_record_failure"
  | "watchdog_handshake_failed"
  | "watchdog_lost"
  | "disposed";

interface WatchdogArmedFacts {
  protocol: string;
  armed: true;
  watchdogPid: number;
  watchdogSid: number;
  watchdogPgid: number;
  scriptPid: number;
  supervisorPid: number;
  deadlineBasis: "python-monotonic";
  durationMs: number;
  graceMs: number;
  armedAtMonotonic: number;
  deadlineMonotonic: number;
  configToken: string;
  runtime: ExecutionRuntime;
  profileSha256: string;
  parentVerified: true;
  scriptIsSessionLeader: true;
  stdioClosed: true;
  environmentKeys: string[];
  signalsIgnored: true;
}

interface WatchdogOutcome {
  protocol: string;
  armed: boolean;
  watchdogPid: number | null;
  watchdogSid: number | null;
  scriptPid: number | null;
  supervisorPid: number;
  deadlineBasis: string | null;
  durationMs: number;
  graceMs: number;
  armedAtMonotonic: number | null;
  deadlineMonotonic: number | null;
  handshakeMs: number;
  handshakeError: string | null;
  ackAttempted: boolean;
  ackSent: boolean;
  triggerReason: string | null;
  termSent: boolean;
  killSent: boolean;
  watchdogExitObserved: boolean;
  watchdogExitConfirmed: boolean;
  childExitObserved: boolean;
  controlEnded: boolean;
  controlError: string | null;
  unexpectedControlEof: boolean;
  controlEventLimit: number;
  controlEventsRejected: number;
  controlStreamBytes: number;
  controlBytesDiscarded: number;
  controlEvents: Array<Record<string, unknown>>;
  logRef: string;
  logAvailable: boolean;
  pidGone: boolean | null;
  watchdogTerminated: boolean | null;
  watchdogKilledByHost: boolean;
  pidReuseCaveat: string;
}

interface DispatchOutcome {
  spawned: boolean;
  spawnError: string | null;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  observedBytes: number;
  retainedBytes: number;
  decodedTextBytes: number;
  droppedIncompleteBytes: number;
  invalidEncoding: boolean;
  truncated: boolean;
  observedAfterRetentionBytes: number;
  logText: string;
  stopReason: StopReason | null;
  terminatedByHost: boolean;
  groupGone: boolean;
  groupCheckMs: number;
  launchStage: LaunchStage;
  hostRecordError: string | null;
  childExitObserved: boolean;
  watchdog: WatchdogOutcome;
}

interface RunBudget {
  /** Reservation converted into a launch attempt, including OS spawn failure. */
  attempted: number;
  /** Attempts for which the OS actually returned a child pid. */
  dispatched: number;
  reserved: number;
}

interface ActiveRun {
  runId: string;
  taskId: string;
  taskRevision: number;
  stop: (reason: StopReason) => void;
}

/** Frozen identity of the task the current reservation was taken for. */
export interface ExecutionBusyTask {
  taskId: string;
  taskRevision: number;
}

/**
 * A run that was actually dispatched but whose external completion could not
 * be proven from trusted host facts. The identity is frozen at admission and
 * is never relabeled from a later owner snapshot.
 */
export interface ExecutionUnresolvedCompletion {
  runId: string;
  taskId: string;
  taskRevision: number;
  reasonCodes: string[];
}

/** Read-only defensive copy of the adapter's observable activity. */
export interface ExecutionActivitySnapshot {
  ownerId: string;
  capabilityId: string;
  disposed: boolean;
  busy: boolean;
  busyTask: ExecutionBusyTask | null;
  activeRunId: string | null;
  unresolvedCompletions: ExecutionUnresolvedCompletion[];
  /** Oldest completions dropped from the bounded latch, if any. */
  unresolvedOmitted: number;
}

interface ArtifactRecord {
  artifactId: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  archiveRef: string;
  verified: boolean;
}

interface ArtifactRejection {
  relativePath: string;
  reason: string;
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hexDigest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runtime facts leave the adapter as fresh plain copies. The internal records
 * are frozen, so a caller mutating a describe/run response can never rewrite
 * the version evidence used by a later execution or host record.
 */
function runtimeSnapshot(info: ExecutionRuntimeInfo): ExecutionRuntimeInfo {
  return { name: info.name, version: info.version, executable: info.executable };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registration errors can embed host-private archive paths. When the final
 * conversation/task visibility withholds output and artifact references, the
 * model projection must still report that registration failed without
 * exposing those paths. The projection does not expose paths.
 */
function withheldRegistrationError(error: unknown): string {
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
  const safeCode = code !== null && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : null;
  return safeCode === null
    ? "candidate registration failed; diagnostic withheld because model visibility is withheld"
    : `candidate registration failed: ${safeCode}; diagnostic withheld because model visibility is withheld`;
}

function absolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new ExecutionAdapterError(`${label} must be absolute.`);
  return value;
}

/** Host-local Bun discovery used only when no explicit bunPath is configured. */
export function discoverBunPath(): string {
  const runtime = process.execPath;
  if (runtime && /^bun(?:\.exe)?$/i.test(path.basename(runtime))) return runtime;
  const bun = (globalThis as { Bun?: { which?: (name: string) => string | null } }).Bun;
  if (bun !== undefined && typeof bun.which === "function") {
    const found = bun.which("bun");
    if (found !== null && found !== "") return found;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "bun.exe" : "bun");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching; absence is reported below, never replaced by a personal path.
    }
  }
  throw new ExecutionAdapterError("No host Bun executable was found; configure bunPath explicitly.");
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ExecutionAdapterError(`${label} must be a positive integer.`);
  }
  return value;
}

function boundedHostMs(value: number | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ExecutionAdapterError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new ExecutionAdapterError(`${label} is not a valid identifier.`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExecutionAdapterError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Strict model-facing parser. Every path, identity, environment, budget,
 * interpreter and policy field is rejected rather than ignored.
 */
export function parseExecutionArguments(value: unknown, limits = EXECUTION_LIMITS): ExecutionArguments {
  const args = object(value, "agent_execute arguments");
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => FORBIDDEN_RUN_KEYS.has(key));
  if (forbidden.length) {
    throw new ExecutionAdapterError(
      `agent_execute never accepts host authority or path fields: ${forbidden.join(", ")}.`,
    );
  }
  const action = args.action;
  if (action !== "describe" && action !== "run") {
    throw new ExecutionAdapterError("agent_execute action must be describe or run.");
  }
  if (action === "describe") {
    const unknown = keys.filter((key) => key !== "action");
    if (unknown.length) throw new ExecutionAdapterError(`agent_execute describe has unsupported field(s): ${unknown.join(", ")}.`);
    return { action };
  }
  const unknown = keys.filter((key) => !["action", "runtime", "source", "inputIds", "expectedTaskId", "expectedTaskRevision"].includes(key));
  if (unknown.length) throw new ExecutionAdapterError(`agent_execute run has unsupported field(s): ${unknown.join(", ")}.`);
  const expectedTaskId = identifier(args.expectedTaskId, "expectedTaskId");
  const runtime = args.runtime;
  if (runtime !== "python" && runtime !== "bun") {
    throw new ExecutionAdapterError("agent_execute runtime must be python or bun.");
  }
  const source = args.source;
  if (typeof source !== "string" || !source.trim()) {
    throw new ExecutionAdapterError("agent_execute source must be non-empty UTF-8 text.");
  }
  if (source.includes("\0")) throw new ExecutionAdapterError("agent_execute source contains a NUL character.");
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > limits.maxSourceBytes) {
    throw new ExecutionAdapterError(`agent_execute source exceeds ${limits.maxSourceBytes} UTF-8 bytes.`);
  }
  const rawIds = args.inputIds ?? [];
  if (!Array.isArray(rawIds)) throw new ExecutionAdapterError("agent_execute inputIds must be an array.");
  if (rawIds.length > limits.maxInputs) {
    throw new ExecutionAdapterError(`agent_execute inputIds exceeds ${limits.maxInputs} handles.`);
  }
  const inputIds: string[] = [];
  for (const raw of rawIds) {
    const id = identifier(raw, "inputId");
    if (inputIds.includes(id)) throw new ExecutionAdapterError(`agent_execute inputId is duplicated: ${id}.`);
    inputIds.push(id);
  }
  return {
    action: "run",
    runtime,
    source,
    inputIds,
    expectedTaskId,
    expectedTaskRevision: positiveInteger(args.expectedTaskRevision, "expectedTaskRevision"),
  };
}

function inputName(filePath: string): string {
  const name = path.basename(filePath);
  return name.length > 96 ? `${name.slice(0, 96)}…` : name;
}

async function inspectInput(filePath: string, maxBytes: number): Promise<{ bytes: number; sha256: string }> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) throw new ExecutionAdapterError("authorized input is a symbolic link");
  if (!info.isFile()) throw new ExecutionAdapterError("authorized input is not a regular file");
  if (info.nlink !== 1) throw new ExecutionAdapterError("authorized input has multiple hard links");
  if (info.size > maxBytes) throw new ExecutionAdapterError("authorized input exceeds the per-input byte limit");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new ExecutionAdapterError("authorized input changed while it was opened");
    }
    const bytes = await handle.readFile();
    return { bytes: bytes.length, sha256: digest(bytes) };
  } finally {
    await handle.close();
  }
}

function runtimeVersion(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024,
  });
  if (result.error) throw new ExecutionAdapterError(`cannot execute host-selected runtime ${executable}: ${result.error.message}`);
  if (result.status !== 0) throw new ExecutionAdapterError(`host-selected runtime ${executable} failed its preflight.`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function preflightPython(executable: string): ExecutionRuntimeInfo {
  const text = runtimeVersion(executable, ["--version"]);
  const match = /Python\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!match) throw new ExecutionAdapterError("host-selected Python did not report a concrete version.");
  return { name: "python", version: match[1]!, executable: path.basename(executable) };
}

function preflightBun(executable: string, options: { requireNoInstall: boolean }): ExecutionRuntimeInfo {
  const text = runtimeVersion(executable, ["--version"]);
  const version = text.split(/\s+/).find((part) => /^\d+\.\d+\.\d+/.test(part));
  if (!version) throw new ExecutionAdapterError("host-selected Bun did not report a concrete version.");
  const help = runtimeVersion(executable, ["run", "--help"]);
  if (!help.includes("--no-env-file")) {
    throw new ExecutionAdapterError("host-selected Bun does not support --no-env-file; refusing execution.");
  }
  if (options.requireNoInstall && !help.includes("--no-install")) {
    throw new ExecutionAdapterError("host-selected Bun does not support --no-install; refusing execution.");
  }
  return { name: "bun", version, executable: path.basename(executable) };
}

function profileLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Default-deny sandbox profile. The candidate profile from the independently
 * verified probe is the starting point, not copied as proof: the small set of
 * runtime read roots is derived from the actual host-selected binaries.
 */
export function sandboxProfile(options: {
  interpreterPath: string;
  sourceRoot: string;
  inputRoot: string;
  workRoot: string;
}): string {
  const realInterpreter = options.interpreterPath;
  const pythonFramework = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework";
  const roots = [
    '(literal "/")',
    '(subpath "/System/Library")',
    '(subpath "/usr/lib")',
    '(subpath "/usr/share/zoneinfo")',
    `(literal ${profileLiteral(realInterpreter)})`,
    `(subpath ${profileLiteral(options.sourceRoot)})`,
    `(subpath ${profileLiteral(options.inputRoot)})`,
    `(subpath ${profileLiteral(options.workRoot)})`,
    '(literal "/dev/null")',
    '(literal "/dev/random")',
    '(literal "/dev/urandom")',
    '(literal "/etc/localtime")',
    '(literal "/private/etc/localtime")',
  ];
  if (realInterpreter.includes("CommandLineTools")) {
    roots.push(`(subpath ${profileLiteral(pythonFramework)})`);
    roots.push('(literal "/Library/Developer/CommandLineTools/usr/Python3")');
  }
  // Broad sysctl-read leaks another same-user process's argv/environment via
  // KERN_PROCARGS/KERN_PROCARGS2, even though the child environment is clean.
  // Deny sysctl and process-info explicitly, then re-allow only the fixed
  // read-only names needed by the runtimes plus their own process info. The
  // `(target self)` exception is required: Bun aborts without it.
  const sysctlNames = [
    "hw.activecpu", "hw.availcpu", "hw.byteorder", "hw.cachelinesize", "hw.cpufamily",
    "hw.cputype", "hw.logicalcpu", "hw.logicalcpu_max", "hw.machine", "hw.memsize",
    "hw.model", "hw.ncpu", "hw.pagesize", "hw.pagesize_compat", "hw.physicalcpu",
    "hw.physicalcpu_max", "kern.osrelease", "kern.osversion", "kern.ostype",
    "kern.osproductversion", "kern.version", "kern.maxfilesperproc", "sysctl.name2oid",
  ];
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    "(deny process-fork)",
    "(deny file-link)",
    "(allow process-exec)",
    "(deny sysctl*)",
    `(allow sysctl-read (sysctl-name ${sysctlNames.map(profileLiteral).join(" ")}) (sysctl-name-prefix "hw.optional."))`,
    "(allow file-read-metadata)",
    "(allow file-read*",
    ...roots.map((line) => `  ${line}`),
    ")",
    "(allow file-write*",
    `  (subpath ${profileLiteral(options.workRoot)})`,
    '  (literal "/dev/null")',
    ")",
    "(deny process-info*)",
    "(allow process-info* (target self))",
    "",
  ].join("\n");
}

function safeAudit(audit: AuditSink, event: AuditEvent): void {
  try {
    audit(event);
  } catch {
    // Diagnostics never affect execution state.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function watchdogInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * Bounded reader for the trusted launcher/watchdog event stream. Untrusted
 * stdout/stderr are never consulted for readiness, identity or progress.
 */
class BoundedControlReader {
  private buffer = Buffer.alloc(0);
  private stopped = false;
  totalBytes = 0;
  discardedBytes = 0;

  constructor(
    private readonly onMessage: (message: Record<string, unknown>) => void,
    private readonly onError: (message: string) => void,
  ) {}

  push(bytes: Buffer): void {
    this.totalBytes += bytes.length;
    if (this.stopped) {
      this.discardedBytes += bytes.length;
      return;
    }
    if (this.totalBytes > WATCHDOG_CONTROL_MAX_TOTAL_BYTES) {
      this.stop("watchdog control stream exceeded its total byte limit");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (!this.stopped) {
      const end = this.buffer.indexOf(10);
      if (end < 0) break;
      if (end > WATCHDOG_CONTROL_MAX_LINE_BYTES) {
        this.stop("watchdog control line exceeded its byte limit");
        return;
      }
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (!line.length) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(line);
      } catch {
        this.stop("watchdog control line is not valid UTF-8");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.stop("watchdog control line is not valid JSON");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.stop("watchdog control message is not an object");
        return;
      }
      this.onMessage(parsed as Record<string, unknown>);
    }
    if (!this.stopped && this.buffer.length > WATCHDOG_CONTROL_MAX_LINE_BYTES) {
      this.stop("watchdog control line exceeded its byte limit");
    }
  }

  end(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.buffer.length > 0) this.onError("watchdog control stream ended with a partial line");
  }

  private stop(message: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.onError(message);
  }
}

function validateArmedFacts(
  message: Record<string, unknown>,
  expected: {
    supervisorPid: number;
    scriptPid: number;
    durationMs: number;
    graceMs: number;
    configToken: string;
    runtime: ExecutionRuntime;
    profileSha256: string;
  },
): WatchdogArmedFacts | string {
  const keys = [
    "type", "protocol", "armed", "watchdogPid", "watchdogSid", "watchdogPgid",
    "scriptPid", "supervisorPid", "deadlineBasis", "durationMs", "graceMs",
    "armedAtMonotonic", "deadlineMonotonic", "configToken", "runtime",
    "profileSha256", "parentVerified", "scriptIsSessionLeader", "stdioClosed",
    "environmentKeys", "signalsIgnored",
  ].sort();
  if (JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(keys)) {
    return "armed record does not match the expected schema";
  }
  if (message.type !== "armed" || message.protocol !== WATCHDOG_PROTOCOL || message.armed !== true) {
    return "armed record has the wrong type or protocol";
  }
  if (!watchdogInteger(message.watchdogPid, 2, 2 ** 31 - 1)
    || !watchdogInteger(message.watchdogSid, 2, 2 ** 31 - 1)
    || !watchdogInteger(message.watchdogPgid, 2, 2 ** 31 - 1)) {
    return "armed record has an invalid watchdog identity";
  }
  if (message.watchdogSid !== message.watchdogPid || message.watchdogPgid !== message.watchdogPid) {
    return "watchdog is not an independent session and process-group leader";
  }
  if (message.scriptPid !== expected.scriptPid) return "armed record does not match the actual script PID";
  if (message.supervisorPid !== expected.supervisorPid) return "armed record does not match the host supervisor PID";
  if (message.watchdogPid === message.scriptPid || message.watchdogPid === message.supervisorPid) {
    return "watchdog identity collides with a known process";
  }
  if (message.deadlineBasis !== "python-monotonic") return "deadline basis is not the shared Python monotonic clock";
  if (message.durationMs !== expected.durationMs) return "independent deadline duration does not match the host configuration";
  if (message.graceMs !== expected.graceMs) return "watchdog termination grace does not match the host configuration";
  if (message.configToken !== expected.configToken) return "armed record does not match the per-run configuration token";
  if (message.runtime !== expected.runtime) return "armed record runtime does not match the actual run";
  if (message.profileSha256 !== expected.profileSha256) return "armed record does not match the actual sandbox profile";
  if (message.parentVerified !== true || message.scriptIsSessionLeader !== true || message.stdioClosed !== true) {
    return "launcher trust-boundary verification did not succeed";
  }
  if (message.signalsIgnored !== true) return "watchdog termination-signal isolation is absent";
  const environmentKeys = message.environmentKeys;
  if (!Array.isArray(environmentKeys)
    || environmentKeys.length !== 2
    || environmentKeys[0] !== "LC_ALL"
    || environmentKeys[1] !== "PATH") {
    return "watchdog retained an unexpected environment";
  }
  if (typeof message.armedAtMonotonic !== "number" || !Number.isFinite(message.armedAtMonotonic)
    || typeof message.deadlineMonotonic !== "number" || !Number.isFinite(message.deadlineMonotonic)
    || message.deadlineMonotonic <= message.armedAtMonotonic
    || message.deadlineMonotonic - message.armedAtMonotonic > expected.durationMs / 1000 + 1) {
    return "armed record has an inconsistent independent deadline";
  }
  return {
    protocol: WATCHDOG_PROTOCOL,
    armed: true,
    watchdogPid: message.watchdogPid,
    watchdogSid: message.watchdogSid,
    watchdogPgid: message.watchdogPgid,
    scriptPid: message.scriptPid,
    supervisorPid: message.supervisorPid,
    deadlineBasis: "python-monotonic",
    durationMs: message.durationMs,
    graceMs: message.graceMs,
    armedAtMonotonic: message.armedAtMonotonic,
    deadlineMonotonic: message.deadlineMonotonic,
    configToken: message.configToken,
    runtime: message.runtime as ExecutionRuntime,
    profileSha256: message.profileSha256,
    parentVerified: true,
    scriptIsSessionLeader: true,
    stdioClosed: true,
    environmentKeys: ["LC_ALL", "PATH"],
    signalsIgnored: true,
  };
}

type WatchdogTriggerReason = "script_exit" | "supervisor_exit" | "absolute_deadline";

interface ControlLifecycle {
  triggerSeen: boolean;
  triggerReason: WatchdogTriggerReason | null;
  triggerScriptExitObserved: boolean;
  termSeen: boolean;
  killSeen: boolean;
  exitSeen: boolean;
  failureSeen: boolean;
}

const CONTROL_EVENT_IDENTITY_KEYS = ["type", "protocol", "watchdogPid", "scriptPid", "supervisorPid"] as const;

function exactKeys(message: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(message).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateControlEvent(
  message: Record<string, unknown>,
  armed: WatchdogArmedFacts,
  lifecycle: ControlLifecycle,
): string | undefined {
  if (message.protocol !== WATCHDOG_PROTOCOL) return "watchdog event protocol mismatch";
  if (!watchdogInteger(message.watchdogPid, 2, 2 ** 31 - 1)
    || !watchdogInteger(message.scriptPid, 2, 2 ** 31 - 1)
    || !watchdogInteger(message.supervisorPid, 2, 2 ** 31 - 1)) {
    return "watchdog event has an invalid process identity";
  }
  if (message.watchdogPid !== armed.watchdogPid
    || message.scriptPid !== armed.scriptPid
    || message.supervisorPid !== armed.supervisorPid) {
    return "watchdog event identity mismatch";
  }
  if (message.type === "armed") return "duplicate watchdog armed record";
  if (lifecycle.exitSeen) return "watchdog event arrived after the terminal exit record";
  if (lifecycle.failureSeen) return "watchdog event arrived after a failure record";
  switch (message.type) {
    case "trigger": {
      if (lifecycle.triggerSeen) return "duplicate watchdog trigger";
      if (!exactKeys(message, [...CONTROL_EVENT_IDENTITY_KEYS, "reason", "scriptExitObserved"])) {
        return "watchdog trigger event does not match the expected schema";
      }
      if (message.reason !== "script_exit"
        && message.reason !== "supervisor_exit"
        && message.reason !== "absolute_deadline") {
        return "watchdog trigger reason is not recognized";
      }
      if (typeof message.scriptExitObserved !== "boolean") return "watchdog trigger is missing the exit observation";
      if (message.reason === "script_exit" && message.scriptExitObserved !== true) {
        return "script_exit trigger contradicts its exit observation";
      }
      if (message.reason !== "script_exit" && message.scriptExitObserved !== false) {
        return "non-script trigger contradicts its exit observation";
      }
      return undefined;
    }
    case "term_sent": {
      if (!lifecycle.triggerSeen) return "term_sent arrived before a trigger";
      if (lifecycle.termSeen) return "duplicate term_sent";
      if (lifecycle.triggerScriptExitObserved) return "term_sent contradicts an observed script exit";
      if (!exactKeys(message, [...CONTROL_EVENT_IDENTITY_KEYS, "sent"])) {
        return "watchdog term event does not match the expected schema";
      }
      if (typeof message.sent !== "boolean") return "watchdog signal event is missing its result";
      return undefined;
    }
    case "kill_sent": {
      if (!lifecycle.termSeen) return "kill_sent arrived before term_sent";
      if (lifecycle.killSeen) return "duplicate kill_sent";
      if (!exactKeys(message, [...CONTROL_EVENT_IDENTITY_KEYS, "sent"])) {
        return "watchdog kill event does not match the expected schema";
      }
      if (typeof message.sent !== "boolean") return "watchdog signal event is missing its result";
      return undefined;
    }
    case "watchdog_exit": {
      if (!lifecycle.triggerSeen) return "watchdog_exit arrived before a trigger";
      if (lifecycle.exitSeen) return "duplicate watchdog_exit";
      if (!exactKeys(message, [...CONTROL_EVENT_IDENTITY_KEYS, "reason", "scriptExitObserved"])) {
        return "watchdog exit event does not match the expected schema";
      }
      if (message.reason !== lifecycle.triggerReason) {
        return "watchdog exit reason contradicts the trigger reason";
      }
      if (typeof message.scriptExitObserved !== "boolean") return "watchdog exit event is missing the exit observation";
      if (message.reason === "script_exit" && message.scriptExitObserved !== true) {
        return "script_exit terminal contradicts its exit observation";
      }
      return undefined;
    }
    case "watchdog_failure": {
      if (lifecycle.failureSeen) return "duplicate watchdog_failure";
      if (!exactKeys(message, [...CONTROL_EVENT_IDENTITY_KEYS, "error"])) {
        return "watchdog failure event does not match the expected schema";
      }
      if (typeof message.error !== "string" || message.error.length < 1 || message.error.length > 200) {
        return "watchdog failure event is malformed";
      }
      return undefined;
    }
    default:
      return `unknown watchdog event: ${String(message.type)}`;
  }
}

function watchdogSnapshot(
  armed: WatchdogArmedFacts | null,
  events: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    protocol: WATCHDOG_PROTOCOL,
    armed: armed !== null,
    watchdogPid: armed?.watchdogPid ?? null,
    watchdogSid: armed?.watchdogSid ?? null,
    scriptPid: armed?.scriptPid ?? null,
    supervisorPid: armed?.supervisorPid ?? null,
    deadlineBasis: armed?.deadlineBasis ?? null,
    durationMs: armed?.durationMs ?? null,
    graceMs: armed?.graceMs ?? null,
    armedAtMonotonic: armed?.armedAtMonotonic ?? null,
    deadlineMonotonic: armed?.deadlineMonotonic ?? null,
    controlEvents: [...events],
    pidReuseCaveat: "numeric process-group/PID checks are bounded local facts; PID reuse is not proven and unrelated PIDs are never inspected",
  };
}

function scalar(value: unknown, limit = 500): unknown {
  return typeof value === "string" && value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function errorResult(
  message: string,
  terminal?: { taskAccepted: boolean | null; currentTaskStatus: string | null },
): ExecutionToolResult {
  const text = `${EXECUTION_TOOL}: ${message}`;
  const bounded = Buffer.byteLength(text, "utf8") > 8 * 1024 ? `${text.slice(0, 8 * 1024)}…` : text;
  if (terminal === undefined) {
    // Appended after bounding so the no-acceptance fact survives a truncated
    // diagnostic. This stage has no visible task read to project.
    return {
      content: [{ type: "text", text: `${bounded}\ntaskAccepted: false` }],
      details: { error: message.slice(0, 2000), taskAccepted: false },
      isError: true,
    };
  }
  // Appended after bounding so the actual visible terminal fact survives a
  // truncated diagnostic.
  return {
    content: [{
      type: "text",
      text: `${bounded}\ntaskAccepted: ${terminal.taskAccepted}\ncurrentTaskStatus: ${terminal.currentTaskStatus ?? "null"}`,
    }],
    details: {
      error: message.slice(0, 2000),
      taskAccepted: terminal.taskAccepted,
      currentTaskStatus: terminal.currentTaskStatus,
    },
    isError: true,
  };
}

export function assertExecutionResponseBound(result: ExecutionToolResult): void {
  const bytes = responseByteLength(result);
  if (bytes > EXECUTION_LIMITS.maxToolResponseBytes) {
    throw new ExecutionAdapterError(
      `agent_execute response envelope is ${bytes} bytes; the limit is ${EXECUTION_LIMITS.maxToolResponseBytes}.`,
    );
  }
}

function responseByteLength(result: ExecutionToolResult): number {
  // Measure exactly what the caller receives, including JSON escapes and the
  // duplicated preview text in content and details.
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

/**
 * Trim a UTF-8 preview without cutting a code point. The previous byte slice
 * could end mid-sequence and decode a fabricated U+FFFD into model-visible
 * content. shownBytes/omittedBytes are always measured on the emitted text.
 */
function utf8Window(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

const OUTPUT_DECODING_POLICY = "utf8-invalid-to-replacement; incomplete-trailing-capture-dropped";

interface DecodedCapture {
  text: string;
  decodedTextBytes: number;
  droppedIncompleteBytes: number;
  invalidEncoding: boolean;
}

/**
 * Decode a byte-bounded capture without fabricating a replacement code point
 * for a code point split by the capture cap. Bytes actually decoded as invalid
 * are replaced with U+FFFD; literal U+FFFD in valid UTF-8 remains distinct
 * because invalidEncoding is false there.
 */
function utf8LeadLength(first: number): number {
  if (first < 0x80) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 1;
}

/** True only when the bytes are a valid, still-pending UTF-8 prefix. */
function isPendingUtf8Prefix(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function decodeCapturedOutput(bytes: Buffer, captureTruncated: boolean): DecodedCapture {
  let end = bytes.length;
  if (captureTruncated) {
    // Only a cap split, never a complete stream, may end in a valid but
    // incomplete UTF-8 prefix. Invalid leads (C0/C1/F5..F7/FF) are left for
    // replacement decoding and invalidEncoding=true.
    let lead = end - 1;
    let continuations = 0;
    while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80 && continuations < 3) {
      lead -= 1;
      continuations += 1;
    }
    if (lead >= 0) {
      const expected = utf8LeadLength(bytes[lead]!);
      if (expected > 1 && end - lead < expected && isPendingUtf8Prefix(bytes.subarray(lead, end))) {
        end = lead;
      }
    }
  }
  const captured = bytes.subarray(0, end);
  let invalidEncoding = false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(captured);
  } catch {
    invalidEncoding = true;
  }
  const text = captured.toString("utf8");
  return {
    text,
    decodedTextBytes: Buffer.byteLength(text, "utf8"),
    droppedIncompleteBytes: bytes.length - end,
    invalidEncoding,
  };
}

function copiedRejection(item: ArtifactRejection): ArtifactRejection {
  return { relativePath: item.relativePath, reason: item.reason };
}

function copiedArtifact(item: ArtifactRecord): ArtifactRecord {
  return {
    artifactId: item.artifactId,
    relativePath: item.relativePath,
    bytes: item.bytes,
    sha256: item.sha256,
    archiveRef: item.archiveRef,
    verified: item.verified,
  };
}

/**
 * Conservative completion classification from trusted process-control facts.
 * `launchStage === "unknown"` is deliberately not a reason: it records the
 * observation boundary for interpreter startup after an acknowledged handshake,
 * not whether the external run ended.
 */
function unresolvedReasonCodes(outcome: DispatchOutcome): string[] {
  if (!outcome.spawned) return [];
  const reasons: string[] = [];
  if (outcome.spawnError !== null) reasons.push("spawn_or_termination_error");
  if (!outcome.groupGone) reasons.push("process_group_unconfirmed");
  // A host-forced watchdog kill after the known PID and the script group are
  // both verified gone is confirmed cleanup, not an unknown completion. Keep
  // protocol/control reasons only when that settlement is not proven.
  const hostKillSettled = outcome.watchdog.watchdogKilledByHost === true
    && outcome.watchdog.pidGone === true
    && outcome.groupGone;
  if (!hostKillSettled) {
    if (!outcome.watchdog.armed) {
      reasons.push("watchdog_arm_unconfirmed");
    } else {
      if (outcome.watchdog.watchdogTerminated !== true) reasons.push("watchdog_exit_unconfirmed");
      if (outcome.watchdog.controlError !== null) reasons.push("watchdog_control_unconfirmed");
      if (outcome.watchdog.unexpectedControlEof) reasons.push("watchdog_control_eof");
      if (!outcome.watchdog.controlEnded) reasons.push("watchdog_control_not_ended");
    }
  }
  if (outcome.hostRecordError !== null) reasons.push("after_spawn_host_record_unconfirmed");
  return reasons.slice(0, MAX_UNRESOLVED_REASONS);
}

function copiedWatchdog(item: WatchdogOutcome): WatchdogOutcome {
  return {
    ...item,
    controlEvents: item.controlEvents.map((event) => ({ ...event })),
  };
}

const MODEL_VIEW_ARTIFACT_ROWS = EXECUTION_LIMITS.maxArtifacts;
const MODEL_VIEW_REJECTION_ROWS = 8;
const MODEL_VIEW_SCALAR_CHARS = 500;

/** Quoted, escaped and bounded so control characters stay unambiguous. */
function modelString(value: unknown, limit = MODEL_VIEW_SCALAR_CHARS): string {
  if (value === null || value === undefined) return "null";
  const text = typeof value === "string" ? value : String(value);
  return JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text);
}

const MODEL_VIEW_IO_CONTRACT = [
  "I/O contract (generic host API, not task-specific):",
  "- Every run starts in a fresh writable workDir, and that directory is the script process cwd.",
  "- The host sets OMP_WORK_DIR and OMP_INPUTS_MANIFEST in the script environment.",
  "- Read OMP_INPUTS_MANIFEST as JSON. manifest.handles[inputId] is {path, bytes, sha256, writable:false}; the manifest also carries workDir, sourcePath and runtime.",
  "- Pass inputIds to run so the host stages read-only copies. Use only the current manifest's paths; never guess a host workspace, private archive or previous-run directory.",
  "- Use only runtime stdlib/builtins. Package installs, network access and process forking are unavailable.",
  "- Write intended candidate files as ordinary top-level files directly in the current cwd, using relative paths. The host archives them automatically after the process group settles; no copy-back to a host workspace is needed or possible.",
  "- Every run is fresh. Previous-run artifacts/archives are not automatically readable or writable inputs to a later run; re-importing an artifact as an input is not supported.",
  "- Generic Python manifest read: import json, os; manifest = json.load(open(os.environ[\"OMP_INPUTS_MANIFEST\"], encoding=\"utf-8\")); path = manifest[\"handles\"][inputId][\"path\"]",
].join("\n");

interface ModelViewWindow {
  artifactsShown: number;
  rejectionsShown: number;
  previewBytes: number;
}

const MODEL_VIEW_INITIAL_WINDOW: ModelViewWindow = {
  artifactsShown: MODEL_VIEW_ARTIFACT_ROWS,
  rejectionsShown: MODEL_VIEW_REJECTION_ROWS,
  previewBytes: RESPONSE_LOG_PREVIEW_BYTES,
};

interface DescribeModelViewFacts {
  taskId: string;
  taskRevision: number;
  taskStatus: string;
  taskAccepted: boolean | null;
  binding: BindingStatus;
  runtimes: Record<ExecutionRuntime, ExecutionRuntimeInfo>;
  limits: Record<string, number | string>;
  authorizedInputs: Array<Record<string, unknown>>;
  dispatchBudget: { limit: number; attempted: number; dispatched: number; reserved: number };
}

function renderDescribeModelView(facts: DescribeModelViewFacts): string {
  const lines: string[] = [];
  lines.push(`${EXECUTION_TOOL} model-visible execution view ${EXECUTION_MODEL_VIEW_VERSION}`);
  lines.push("action=describe");
  lines.push(`task taskId=${modelString(facts.taskId)} taskRevision=${facts.taskRevision} taskStatus=${modelString(facts.taskStatus)} taskAccepted=${facts.taskAccepted === null ? "null" : facts.taskAccepted}`);
  lines.push(`binding state=${modelString(facts.binding.state)} reason=${modelString(facts.binding.reason)}`);
  lines.push(facts.taskAccepted === false
    ? "authority candidateOnly=true taskAccepted=false; describe grants no execution authority and tool success is not task acceptance."
    : "authority candidateOnly=true; describe grants no execution authority and tool success is not task acceptance.");
  lines.push("runtimes:");
  for (const runtime of EXECUTION_RUNTIMES) {
    const info = facts.runtimes[runtime];
    lines.push(`- name=${modelString(runtime)} version=${modelString(info.version)} hostSelected=true available=true`);
  }
  lines.push("authorizedInputs:");
  if (facts.authorizedInputs.length === 0) {
    lines.push("- none");
  } else {
    for (const input of facts.authorizedInputs) {
      lines.push(`- id=${modelString(input.id)} name=${modelString(input.name)} bytes=${String(input.bytes ?? "unknown")} sha256=${modelString(input.sha256)} writable=false available=${String(input.available)} reason=${modelString(input.reason)}`);
    }
  }
  lines.push(`limits: version=${modelString(facts.limits.version)} maxInputs=${String(facts.limits.maxInputs)} maxInputBytes=${String(facts.limits.maxInputBytes)} maxTotalInputBytes=${String(facts.limits.maxTotalInputBytes)} maxSourceBytes=${String(facts.limits.maxSourceBytes)} maxDispatches=${String(facts.limits.maxDispatches)} dispatchWallMs=${String(facts.limits.dispatchWallMs)} maxRetainedOutputBytes=${String(facts.limits.maxRetainedOutputBytes)} maxArtifacts=${String(facts.limits.maxArtifacts)} maxArtifactTotalBytes=${String(facts.limits.maxArtifactTotalBytes)} maxFileSizeBytes=${String(facts.limits.maxFileSizeBytes)} maxToolResponseBytes=${String(facts.limits.maxToolResponseBytes)}`);
  lines.push(`attempts: limit=${facts.dispatchBudget.limit} attempted=${facts.dispatchBudget.attempted} dispatched=${facts.dispatchBudget.dispatched} reserved=${facts.dispatchBudget.reserved} remaining=${Math.max(0, facts.dispatchBudget.limit - facts.dispatchBudget.attempted - facts.dispatchBudget.reserved)}`);
  lines.push(MODEL_VIEW_IO_CONTRACT);
  return lines.join("\n");
}

interface RunModelViewFacts {
  schemaVersion: number;
  limitsVersion: string;
  runId: string;
  callId: string;
  taskId: string;
  ownerId: string;
  taskRevision: number;
  anchorMessageId: string | null;
  runtime: ExecutionRuntime;
  runtimeVersion: string;
  availableRuntimes: Record<ExecutionRuntime, ExecutionRuntimeInfo>;
  limits: Record<string, number | string>;
  source: { bytes: number; sha256: string };
  inputs: Array<{ id: string; bytes: number; sha256: string }>;
  dispatch: {
    spawned: boolean;
    pid: number | null;
    pgid: number | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    reason: string;
    durationMs: number;
    terminatedByHost: boolean;
    processGroupVerifiedGone: boolean;
    spawnError: string | null;
    launchStage: LaunchStage;
    launchStageNote: string;
    wrapperExitObserved: boolean;
    userCodeStart: string;
    watchdogArmed: boolean;
    watchdogTerminated: boolean | null;
    childExitObserved: boolean;
    hostRecordError: string | null;
  };
  watchdog: WatchdogOutcome;
  hostRecordErrors: { afterSpawn: string | null; finalRecord: string | null; artifactExport: string | null };
  requirementsDigest: string;
  candidateRegistration: { registered: number; idempotent: number } | null;
  candidateRegistrationError: string | null;
  output: {
    observedBytes: number;
    retainedBytes: number;
    decodedTextBytes: number;
    droppedIncompleteBytes: number;
    invalidEncoding: boolean;
    truncated: boolean;
    observedAfterRetentionBytes: number;
    text: string;
  };
  artifacts: readonly ArtifactRecord[];
  artifactRejections: readonly ArtifactRejection[];
  artifactTotalBytes: number;
  artifactLimitReached: boolean;
  bindingBefore: "attached";
  bindingAfter: BindingStatus;
  taskAfterStatus: string | null;
  taskStillReachable: boolean;
  visible: boolean;
  withheldReason: string | null;
  attemptBudget: { limit: number; attempted: number; dispatched: number; reserved: number };
  hostRecordRef: string;
  isError: boolean;
}

function modelRows(facts: RunModelViewFacts, window: ModelViewWindow): {
  artifacts: readonly ArtifactRecord[];
  rejections: readonly ArtifactRejection[];
  preview: string;
  shownBytes: number;
  omittedBytes: number;
  previewTruncated: boolean;
} {
  const artifacts = facts.visible ? facts.artifacts.slice(0, window.artifactsShown) : [];
  const rejections = facts.visible ? facts.artifactRejections.slice(0, window.rejectionsShown) : [];
  const preview = facts.visible ? utf8Window(facts.output.text, window.previewBytes) : "";
  const shownBytes = Buffer.byteLength(preview, "utf8");
  return {
    artifacts,
    rejections,
    preview,
    shownBytes,
    omittedBytes: Math.max(0, facts.output.decodedTextBytes - shownBytes),
    previewTruncated: shownBytes < facts.output.decodedTextBytes,
  };
}

function renderRunModelView(facts: RunModelViewFacts, window: ModelViewWindow): string {
  const rows = modelRows(facts, window);
  const lines: string[] = [];
  lines.push(`${EXECUTION_TOOL} model-visible execution view ${EXECUTION_MODEL_VIEW_VERSION}`);
  lines.push("action=run");
  lines.push(`run runId=${modelString(facts.runId)} callId=${modelString(facts.callId)} taskId=${modelString(facts.taskId)} taskRevision=${facts.taskRevision} ownerId=${modelString(facts.ownerId)}`);
  lines.push(`runtime name=${modelString(facts.runtime)} version=${modelString(facts.runtimeVersion)} sourceBytes=${facts.source.bytes} sourceSha256=${modelString(facts.source.sha256)}`);
  lines.push(`availableRuntimes: python=${modelString(facts.availableRuntimes.python.version)} bun=${modelString(facts.availableRuntimes.bun.version)}`);
  lines.push(`limits: version=${modelString(facts.limits.version)} maxInputs=${String(facts.limits.maxInputs)} maxInputBytes=${String(facts.limits.maxInputBytes)} maxTotalInputBytes=${String(facts.limits.maxTotalInputBytes)} maxSourceBytes=${String(facts.limits.maxSourceBytes)} maxDispatches=${String(facts.limits.maxDispatches)} dispatchWallMs=${String(facts.limits.dispatchWallMs)} maxRetainedOutputBytes=${String(facts.limits.maxRetainedOutputBytes)} maxArtifacts=${String(facts.limits.maxArtifacts)} maxArtifactTotalBytes=${String(facts.limits.maxArtifactTotalBytes)} maxFileSizeBytes=${String(facts.limits.maxFileSizeBytes)} maxToolResponseBytes=${String(facts.limits.maxToolResponseBytes)}`);
  lines.push("inputs selected for this run:");
  if (facts.inputs.length === 0) {
    lines.push("- none");
  } else {
    for (const input of facts.inputs) {
      lines.push(`- id=${modelString(input.id)} bytes=${input.bytes} sha256=${modelString(input.sha256)} writable=false`);
    }
  }
  lines.push(`authority candidateOnly=true taskAccepted=false toolIsError=${facts.isError}`);
  lines.push(`visibility visible=${facts.visible} bindingAfter=${modelString(facts.bindingAfter.state)} taskStillReachable=${facts.taskStillReachable} taskStatusAfter=${modelString(facts.taskAfterStatus)} withheldReason=${modelString(facts.withheldReason)}`);
  const dispatch = facts.dispatch;
  lines.push(`dispatch spawned=${dispatch.spawned} pid=${String(dispatch.pid)} pgid=${String(dispatch.pgid)} exitCode=${String(dispatch.exitCode)} signal=${modelString(dispatch.signal)} stopReason=${modelString(dispatch.reason)} durationMs=${dispatch.durationMs} terminatedByHost=${dispatch.terminatedByHost} processGroupVerifiedGone=${dispatch.processGroupVerifiedGone}`);
  lines.push(`launch stage=${modelString(dispatch.launchStage)} userCodeStart=${modelString(dispatch.userCodeStart)} wrapperExitObserved=${dispatch.wrapperExitObserved} note=${modelString(dispatch.launchStageNote)} spawnError=${modelString(dispatch.spawnError)}`);
  lines.push(`watchdog protocol=${modelString(facts.watchdog.protocol)} armed=${facts.watchdog.armed} ackSent=${facts.watchdog.ackSent} triggerReason=${modelString(facts.watchdog.triggerReason)} controlError=${modelString(facts.watchdog.controlError)} unexpectedControlEof=${facts.watchdog.unexpectedControlEof} watchdogTerminated=${String(facts.watchdog.watchdogTerminated)} killedByHost=${facts.watchdog.watchdogKilledByHost}`);
  lines.push(`hostRecordErrors afterSpawn=${modelString(facts.hostRecordErrors.afterSpawn)} finalRecord=${modelString(facts.hostRecordErrors.finalRecord)} artifactExport=${modelString(facts.hostRecordErrors.artifactExport)} hostRecordError=${modelString(dispatch.hostRecordError)}`);
  lines.push(`output observedBytes=${facts.output.observedBytes} retainedBytes=${facts.output.retainedBytes} decodedTextBytes=${facts.output.decodedTextBytes} shownBytes=${rows.shownBytes} omittedBytes=${rows.omittedBytes} truncated=${facts.output.truncated} observedAfterRetentionBytes=${facts.output.observedAfterRetentionBytes} previewTruncated=${rows.previewTruncated} droppedIncompleteBytes=${facts.output.droppedIncompleteBytes} invalidEncoding=${facts.output.invalidEncoding} decodingPolicy=${modelString(OUTPUT_DECODING_POLICY)}`);
  if (facts.visible) {
    lines.push("outputPreviewBegin (merged stdout+stderr; model-visible; an absent preview is empty)");
    lines.push(rows.preview);
    lines.push("outputPreviewEnd");
  } else {
    lines.push("outputPreviewWithheld=true (output remains only in the host record)");
  }
  const artifactTotal = facts.artifacts.length;
  lines.push(`artifacts total=${artifactTotal} shown=${rows.artifacts.length} omitted=${artifactTotal - rows.artifacts.length} withheld=${!facts.visible}`);
  for (const artifact of rows.artifacts) {
    lines.push(`- artifactId=${modelString(artifact.artifactId)} relativePath=${modelString(artifact.relativePath)} archiveRef=${modelString(artifact.archiveRef)} bytes=${artifact.bytes} sha256=${modelString(artifact.sha256)} verified=${artifact.verified} (host-side ref; not readable from the script)`);
  }
  const rejectionTotal = facts.artifactRejections.length;
  lines.push(`artifactRejections total=${rejectionTotal} shown=${rows.rejections.length} omitted=${rejectionTotal - rows.rejections.length} withheld=${!facts.visible} artifactTotalBytes=${facts.artifactTotalBytes} artifactLimitReached=${facts.artifactLimitReached}`);
  for (const rejection of rows.rejections) {
    lines.push(`- relativePath=${modelString(rejection.relativePath)} reason=${modelString(rejection.reason)}`);
  }
  lines.push(`attempts limit=${facts.attemptBudget.limit} attempted=${facts.attemptBudget.attempted} dispatched=${facts.attemptBudget.dispatched} reserved=${facts.attemptBudget.reserved} remaining=${Math.max(0, facts.attemptBudget.limit - facts.attemptBudget.attempted - facts.attemptBudget.reserved)}`);
  lines.push(`requirementsDigest=${modelString(facts.requirementsDigest)}`);
  lines.push(`candidateRegistration=${facts.candidateRegistration === null ? "none" : JSON.stringify(facts.candidateRegistration)} candidateRegistrationError=${modelString(facts.candidateRegistrationError)}`);
  lines.push(`hostRecordRef=${modelString(facts.hostRecordRef)} hostOwned=true scriptReadable=false`);
  lines.push("note: exit code 0 and exported artifacts are candidate generation only; the task is not accepted. No model claim is verification evidence.");
  lines.push(MODEL_VIEW_IO_CONTRACT);
  return lines.join("\n");
}

function assembleRunResponse(
  facts: RunModelViewFacts,
  window: ModelViewWindow,
  compact = false,
): ExecutionToolResult {
  const rows = modelRows(facts, window);
  const artifactTotal = facts.artifacts.length;
  const rejectionTotal = facts.artifactRejections.length;
  const watchdog = compact
    ? {
      protocol: facts.watchdog.protocol,
      armed: facts.watchdog.armed,
      ackSent: facts.watchdog.ackSent,
      triggerReason: scalar(facts.watchdog.triggerReason, MODEL_VIEW_SCALAR_CHARS),
      controlError: scalar(facts.watchdog.controlError, MODEL_VIEW_SCALAR_CHARS),
      unexpectedControlEof: facts.watchdog.unexpectedControlEof,
      watchdogTerminated: facts.watchdog.watchdogTerminated,
      watchdogKilledByHost: facts.watchdog.watchdogKilledByHost,
      controlEvents: [],
      controlEventsShown: 0,
      controlEventsOmitted: facts.watchdog.controlEvents.length,
      logRef: facts.watchdog.logRef,
    }
    : copiedWatchdog(facts.watchdog);
  const dispatch = compact
    ? Object.fromEntries(Object.entries(facts.dispatch).map(([key, value]) => [key, scalar(value, MODEL_VIEW_SCALAR_CHARS)]))
    : { ...facts.dispatch };
  const details: Record<string, unknown> = {
    action: "run",
    modelViewVersion: EXECUTION_MODEL_VIEW_VERSION,
    schemaVersion: facts.schemaVersion,
    limitsVersion: facts.limitsVersion,
    runId: facts.runId,
    callId: facts.callId,
    taskId: facts.taskId,
    ownerId: facts.ownerId,
    taskRevision: facts.taskRevision,
    anchorMessageId: facts.anchorMessageId,
    requirementsDigest: facts.requirementsDigest,
    runtime: facts.runtime,
    runtimeVersion: facts.runtimeVersion,
    source: { ...facts.source },
    inputs: facts.inputs.map((input) => ({ ...input })),
    dispatch,
    watchdog,
    hostRecordErrors: compact
      ? Object.fromEntries(Object.entries(facts.hostRecordErrors)
        .map(([key, value]) => [key, scalar(value, MODEL_VIEW_SCALAR_CHARS)]))
      : { ...facts.hostRecordErrors },
    candidateRegistration: facts.candidateRegistration === null ? null : { ...facts.candidateRegistration },
    candidateRegistrationError: facts.candidateRegistrationError,
    output: {
      observedBytes: facts.output.observedBytes,
      retainedBytes: facts.output.retainedBytes,
      decodedTextBytes: facts.output.decodedTextBytes,
      droppedIncompleteBytes: facts.output.droppedIncompleteBytes,
      invalidEncoding: facts.output.invalidEncoding,
      decodingPolicy: OUTPUT_DECODING_POLICY,
      shownBytes: rows.shownBytes,
      omittedBytes: rows.omittedBytes,
      responsePreviewBytes: rows.shownBytes,
      omittedFromResponseBytes: rows.omittedBytes,
      truncated: facts.output.truncated,
      previewTruncated: rows.previewTruncated,
      observedAfterRetentionBytes: facts.output.observedAfterRetentionBytes,
      text: rows.preview,
      hostRecordRef: facts.hostRecordRef,
    },
    artifacts: rows.artifacts.map(copiedArtifact),
    artifactsTotal: artifactTotal,
    artifactsShown: rows.artifacts.length,
    artifactsOmitted: artifactTotal - rows.artifacts.length,
    artifactsWithheld: !facts.visible,
    artifactsRecordRef: facts.hostRecordRef,
    artifactRejections: rows.rejections.map(copiedRejection),
    artifactRejectionsTotal: rejectionTotal,
    artifactRejectionsShown: rows.rejections.length,
    artifactRejectionsOmitted: rejectionTotal - rows.rejections.length,
    artifactRejectionsWithheld: !facts.visible,
    artifactRejectionsRecordRef: facts.hostRecordRef,
    artifactTotalBytes: facts.artifactTotalBytes,
    artifactLimitReached: facts.artifactLimitReached,
    bindingBefore: facts.bindingBefore,
    bindingAfter: { ...facts.bindingAfter },
    taskAfterStatus: facts.taskAfterStatus,
    taskStillReachable: facts.taskStillReachable,
    visible: facts.visible,
    withheldReason: facts.withheldReason,
    attemptBudget: { ...facts.attemptBudget },
    candidateOnly: true,
    taskAccepted: false,
    note: "A zero exit code is candidate generation only, not task acceptance. No model claim is verification evidence.",
    hostRecordRef: facts.hostRecordRef,
  };
  return {
    content: [{ type: "text", text: renderRunModelView(facts, window) }],
    details,
    ...(facts.isError ? { isError: true } : {}),
  };
}

/**
 * A completed local execution is already committed host evidence. Response
 * size pressure trims only the projection window (artifact rows, rejection
 * rows, model-visible output preview); the content view is rebuilt for every
 * window so a full unbounded text copy never survives while details shrink.
 * Full arrays/text remain in the host record.
 */
function boundedRunResponse(facts: RunModelViewFacts): ExecutionToolResult {
  const windows: ModelViewWindow[] = [
    MODEL_VIEW_INITIAL_WINDOW,
    { artifactsShown: MODEL_VIEW_ARTIFACT_ROWS, rejectionsShown: 4, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: MODEL_VIEW_ARTIFACT_ROWS, rejectionsShown: 2, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: MODEL_VIEW_ARTIFACT_ROWS, rejectionsShown: 1, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: MODEL_VIEW_ARTIFACT_ROWS, rejectionsShown: 0, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: 4, rejectionsShown: 0, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: 2, rejectionsShown: 0, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: 1, rejectionsShown: 0, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: 0, rejectionsShown: 0, previewBytes: RESPONSE_LOG_PREVIEW_BYTES },
    { artifactsShown: 0, rejectionsShown: 0, previewBytes: 2048 },
    { artifactsShown: 0, rejectionsShown: 0, previewBytes: 1024 },
    { artifactsShown: 0, rejectionsShown: 0, previewBytes: 256 },
    { artifactsShown: 0, rejectionsShown: 0, previewBytes: 0 },
  ];
  for (const window of windows) {
    const result = assembleRunResponse(facts, window);
    if (responseByteLength(result) <= EXECUTION_LIMITS.maxToolResponseBytes) return result;
  }
  // The compact details drop only already-counted watchdog event rows and
  // scalarize strings; run/process/record facts stay present.
  return assembleRunResponse(facts, { artifactsShown: 0, rejectionsShown: 0, previewBytes: 0 }, true);
}

export class ExecutionAdapter {
  private readonly owner: TaskOwner;
  private readonly workspaceRoot: string;
  private readonly root: string;
  private readonly configInputs: readonly ExecutionInputConfig[];
  private readonly capabilityId: string;
  private readonly audit: AuditSink;
  private readonly pythonPath: string;
  private readonly bunPath: string;
  private readonly launcherPath: string;
  private readonly sandboxExecPath: string;
  private readonly dispatchWallMs: number;
  private readonly terminationGraceMs: number;
  private readonly recordWriter: (filePath: string, value: unknown) => void;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly runtimes: Record<ExecutionRuntime, ExecutionRuntimeInfo>;
  private readonly candidateRegistry: CandidateRegistry;
  readonly candidates: CandidateReadPort;
  private readonly ownerId: string;
  private readonly budgets = new Map<string, RunBudget>();
  private readonly unresolved = new Map<string, ExecutionUnresolvedCompletion>();
  private unresolvedOmitted = 0;
  private readonly unsubscribe: () => void;
  private active: ActiveRun | undefined;
  private busyTask: ExecutionBusyTask | null = null;
  private busy = false;
  private disposed = false;

  constructor(owner: TaskOwner, config: ExecutionConfig) {
    this.owner = owner;
    this.ownerId = owner.snapshot().ownerId;
    this.workspaceRoot = owner.workspaceRoot;
    const configuredRoot = absolute(config.root, "Execution root");
    this.root = existsSync(configuredRoot) ? realpathSync(configuredRoot) : configuredRoot;
    this.configInputs = [...(config.inputs ?? [])];
    if (this.configInputs.length > EXECUTION_LIMITS.maxInputs) {
      throw new ExecutionAdapterError(`Host execution input manifest exceeds ${EXECUTION_LIMITS.maxInputs} handles.`);
    }
    const seen = new Set<string>();
    for (const input of this.configInputs) {
      const id = identifier(input.id, "Host execution input id");
      if (seen.has(id)) throw new ExecutionAdapterError(`Host execution input id is duplicated: ${id}.`);
      seen.add(id);
      absolute(input.path, "Host execution input path");
    }
    this.capabilityId = identifier(config.capabilityId ?? "local-script", "Execution capability id");
    this.audit = createFileAudit(config.auditPath);
    this.pythonPath = absolute(
      config.pythonPath ?? "/Library/Developer/CommandLineTools/usr/bin/python3",
      "Host Python path",
    );
    this.bunPath = absolute(config.bunPath ?? discoverBunPath(), "Host Bun path");
    this.launcherPath = absolute(
      config.launcherPath ?? path.resolve(import.meta.dir, "../scripts/isolated-exec.py"),
      "Trusted launcher path",
    );
    this.sandboxExecPath = absolute(config.sandboxExecPath ?? "/usr/bin/sandbox-exec", "sandbox-exec path");
    this.dispatchWallMs = boundedHostMs(
      config.dispatchWallMs,
      EXECUTION_LIMITS.dispatchWallMs,
      "dispatchWallMs",
      100,
      60_000,
    );
    this.terminationGraceMs = boundedHostMs(
      config.terminationGraceMs,
      EXECUTION_LIMITS.terminationGraceMs,
      "terminationGraceMs",
      20,
      5000,
    );
    this.recordWriter = config.recordWriter ?? writeJsonAtomicSync;
    this.now = config.now ?? (() => new Date().toISOString());
    this.newId = config.id ?? (() => randomUUID());
    this.candidateRegistry = new CandidateRegistry({ now: this.now, id: this.newId });
    this.candidates = this.candidateRegistry.readPort();
    if (!existsSync(this.root)) throw new ExecutionAdapterError("Host execution root does not exist.");
    if (!existsSync(this.launcherPath)) throw new ExecutionAdapterError("Trusted execution launcher is unavailable.");
    if (!existsSync(this.sandboxExecPath)) throw new ExecutionAdapterError("sandbox-exec is unavailable; refusing execution.");
    this.runtimes = {
      python: Object.freeze(preflightPython(this.pythonPath)),
      bun: Object.freeze(preflightBun(this.bunPath, { requireNoInstall: true })),
    };
    this.unsubscribe = owner.subscribe((event) => this.ownerEvent(event));
    safeAudit(this.audit, {
      type: "execution_adapter_started",
      version: EXECUTION_LIMITS_VERSION,
      capabilityId: this.capabilityId,
      inputs: this.configInputs.length,
      python: this.runtimes.python.version,
      bun: this.runtimes.bun.version,
    });
  }

  private ownerEvent(event: TaskOwnerEvent): void {
    const active = this.active;
    if (!active) return;
    if (event.type === "task_cancelled") this.stopActive(active, "owner_cancelled", event);
    else if (event.type === "task_binding_detached") this.stopActive(active, "binding_detached", event);
    else if (event.type === "task_revised" && event.taskId === active.taskId) this.stopActive(active, "task_revised", event);
  }

  private stopActive(active: ActiveRun, reason: StopReason, event: TaskOwnerEvent): void {
    active.stop(reason);
    safeAudit(this.audit, {
      type: "execution_owner_stop",
      runId: active.runId,
      taskId: active.taskId,
      taskRevision: active.taskRevision,
      reason,
      ownerEvent: event.type,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) this.active.stop("disposed");
    this.unsubscribe();
    safeAudit(this.audit, { type: "execution_adapter_disposed" });
  }

  /**
   * Synchronous, defensive activity facts for host policy and delivery. It
   * calls no host callback (no now/id/audit), exposes no controller/array and
   * never uses the owner's current task to relabel an old reservation or run.
   * Dispose and revision changes do not clear an unresolved completion.
   */
  activitySnapshot(): ExecutionActivitySnapshot {
    return {
      ownerId: this.ownerId,
      capabilityId: this.capabilityId,
      disposed: this.disposed,
      busy: this.busy,
      busyTask: this.busyTask === null ? null : { ...this.busyTask },
      activeRunId: this.active?.runId ?? null,
      unresolvedCompletions: [...this.unresolved.values()].map((item) => ({
        runId: item.runId,
        taskId: item.taskId,
        taskRevision: item.taskRevision,
        reasonCodes: [...item.reasonCodes],
      })),
      unresolvedOmitted: this.unresolvedOmitted,
    };
  }

  /**
   * Actual visible terminal facts for a rejection. A tool that did not perform
   * acceptance never proves the current task is unaccepted: visible accepted
   * stays true, a visible non-accepted task is false, and unavailable,
   * disposed, detached, changed or unknown-hazard states are null. Context
   * getters are followed by pure owner/task identity rechecks.
   */
  visibleTerminalFacts(context: OmpToolContext): {
    taskAccepted: boolean | null;
    currentTaskStatus: string | null;
  } {
    const unavailable = { taskAccepted: null, currentTaskStatus: null } as const;
    const published = currentTaskOwner();
    // The entry always constructs this adapter around the published owner.
    // Direct host/test construction may leave it unpublished; only a different
    // live published owner proves a replacement.
    const requirePublished = published !== undefined;
    if (this.disposed || (requirePublished && published !== this.owner)) return unavailable;
    try {
      const before = this.owner.snapshot();
      if (before.binding.state !== "attached") return unavailable;
      const subject = subjectFromContext(context, this.workspaceRoot);
      if (subject.agentKind !== "main") return unavailable;
      const task = this.owner.reachableTask(subject);
      if (this.disposed || (requirePublished && currentTaskOwner() !== this.owner)) return unavailable;
      const after = this.owner.snapshot();
      if (after.binding.state !== "attached") return unavailable;
      const finalTask = after.currentTask;
      if (finalTask === null
        || finalTask.taskId !== task.taskId
        || finalTask.taskRevision !== task.taskRevision
        || finalTask.status !== task.status) {
        return unavailable;
      }
      return {
        taskAccepted: after.acceptanceHazard !== null
          ? null
          : finalTask.status === "accepted",
        currentTaskStatus: finalTask.status,
      };
    } catch {
      return unavailable;
    }
  }

  private rejectionResult(message: string, context: OmpToolContext): ExecutionToolResult {
    return errorResult(message, this.visibleTerminalFacts(context));
  }

  /** Merge bounded reasons for one real dispatched run; identity never changes. */
  private latchUnresolved(
    runId: string,
    taskId: string,
    taskRevision: number,
    reasons: readonly string[],
  ): void {
    if (reasons.length === 0) return;
    const existing = this.unresolved.get(runId);
    if (existing) {
      const merged = new Set(existing.reasonCodes);
      for (const reason of reasons) merged.add(reason);
      existing.reasonCodes = [...merged].slice(0, MAX_UNRESOLVED_REASONS);
      return;
    }
    if (this.unresolved.size >= MAX_UNRESOLVED_COMPLETIONS) {
      const oldest = this.unresolved.keys().next();
      if (oldest.done !== true) {
        this.unresolved.delete(oldest.value);
        this.unresolvedOmitted += 1;
      }
    }
    this.unresolved.set(runId, {
      runId,
      taskId,
      taskRevision,
      reasonCodes: [...new Set(reasons)].slice(0, MAX_UNRESOLVED_REASONS),
    });
    safeAudit(this.audit, {
      type: "execution_completion_unconfirmed",
      runId,
      taskId,
      taskRevision,
      reasons: [...new Set(reasons)].slice(0, MAX_UNRESOLVED_REASONS),
    });
  }

  async describe(context: ExecutionToolContext): Promise<ExecutionToolResult> {
    if (this.disposed) return this.rejectionResult("the execution adapter is disposed.", context);
    try {
      const subject = subjectFromContext(context, this.workspaceRoot);
      this.owner.reachableTask(subject);
      const inputs: Array<Record<string, unknown>> = [];
      for (const input of this.configInputs) {
        try {
          const metadata = await inspectInput(input.path, EXECUTION_LIMITS.maxInputBytes);
          inputs.push({
            id: input.id,
            name: inputName(input.path),
            bytes: metadata.bytes,
            sha256: metadata.sha256,
            authorized: true,
            writable: false,
            available: true,
          });
        } catch (error) {
          inputs.push({
            id: input.id,
            name: inputName(input.path),
            authorized: true,
            writable: false,
            available: false,
            reason: errorMessage(error),
          });
        }
      }
      // Input inspection awaited host filesystem work. Rebuild the subject from
      // the actual live context; never expose metadata derived from a captured
      // branch or a binding that detached during inspection.
      if (this.disposed) return this.rejectionResult("the execution adapter is disposed.", context);
      let task: ManagedTask;
      try {
        task = this.owner.reachableTask(subjectFromContext(context, this.workspaceRoot));
      } catch (error) {
        safeAudit(this.audit, { type: "execution_describe_withheld", error: errorMessage(error) });
        return this.rejectionResult(`describe was withheld: ${errorMessage(error)}`, context);
      }
      if (this.owner.bindingStatus().state !== "attached") {
        safeAudit(this.audit, { type: "execution_describe_withheld", error: "binding detached during describe" });
        return this.rejectionResult("describe was withheld: the conversation binding detached during input inspection.", context);
      }
      const budget = this.budgets.get(task.taskId);
      const limits: Record<string, number | string> = {
        ...EXECUTION_LIMITS,
        dispatchWallMs: this.dispatchWallMs,
        terminationGraceMs: this.terminationGraceMs,
      };
      const binding = this.owner.bindingStatus();
      const dispatchBudget = {
        limit: EXECUTION_LIMITS.maxDispatches,
        attempted: budget?.attempted ?? 0,
        dispatched: budget?.dispatched ?? 0,
        reserved: budget?.reserved ?? 0,
      };
      const taskAccepted = task.status === "accepted"
        ? true
        : this.owner.snapshot().acceptanceHazard !== null
          ? null
          : false;
      const response: ExecutionToolResult = {
        content: [{
          type: "text",
          text: renderDescribeModelView({
            taskId: task.taskId,
            taskRevision: task.taskRevision,
            taskStatus: task.status,
            taskAccepted,
            binding,
            runtimes: {
              python: runtimeSnapshot(this.runtimes.python),
              bun: runtimeSnapshot(this.runtimes.bun),
            },
            limits,
            authorizedInputs: inputs,
            dispatchBudget,
          }),
        }],
        details: {
          action: "describe",
          modelViewVersion: EXECUTION_MODEL_VIEW_VERSION,
          schemaVersion: EXECUTION_SCHEMA_VERSION,
          limitsVersion: EXECUTION_LIMITS_VERSION,
          taskId: task.taskId,
          taskRevision: task.taskRevision,
          taskStatus: task.status,
          binding,
          candidateOnly: true,
          taskAccepted,
          runtimes: {
            python: runtimeSnapshot(this.runtimes.python),
            bun: runtimeSnapshot(this.runtimes.bun),
          },
          limits,
          artifactPolicy: {
            scope: "top-level ordinary files directly inside the writable work directory",
            subdirectories: "not exported",
            scanEntries: MAX_SCAN_ENTRIES,
            symlinks: "rejected",
            hardLinks: "rejected",
            specialFiles: "rejected before read",
            oversize: "rejected before read",
          },
          authorizedInputs: inputs,
          dispatchBudget: {
            limit: EXECUTION_LIMITS.maxDispatches,
            attempted: budget?.attempted ?? 0,
            dispatched: budget?.dispatched ?? 0,
            reserved: budget?.reserved ?? 0,
          },
          sandbox: {
            mechanism: "macOS sandbox-exec default-deny profile",
            network: false,
            processFork: false,
            fileLink: false,
            externalSignals: false,
            failureMode: "fail-closed; no unsandboxed fallback",
            metadataCaveat: "global file metadata reads are permitted; path metadata is not claimed secret",
            hostLifetime: "a trusted separate-session watchdog independently terminates the script on supervisor death or its own absolute deadline; the TypeScript timer, abort and owner-cancel paths remain auxiliary",
          },
          supervision: {
            protocol: WATCHDOG_PROTOCOL,
            armedHandshake: "required before untrusted interpreter exec",
            deadlineBasis: "trusted launcher Python monotonic clock, computed immediately before watchdog fork",
            parentDeath: true,
            termination: "SIGTERM then bounded grace then SIGKILL; queued script exit is drained first",
            pidReuseCaveat: "bounded local prototype; numeric process-group reuse is not proven impossible and unrelated PIDs are never inspected",
            guarantees: "no hard memory limit, aggregate disk quota or adversarial multi-tenant isolation is added",
          },
          notes: [
            "Inputs enter the child only after host authorization and a fresh read-only copy on an independent inode.",
            "Artifacts are exported only after the process group and watchdog are verified settled; exit code 0 is not task acceptance.",
            "No hard memory limit or aggregate disk quota is claimed for this prototype.",
            "The watchdog log and control pipe are evidence/control channels, never script-authored authority.",
          ],
        },
      };
      assertExecutionResponseBound(response);
      return response;
    } catch (error) {
      safeAudit(this.audit, { type: "execution_describe_rejected", error: errorMessage(error) });
      return this.rejectionResult(errorMessage(error), context);
    }
  }

  async run(
    context: ExecutionToolContext,
    args: Extract<ExecutionArguments, { action: "run" }>,
    signal?: AbortSignal,
  ): Promise<ExecutionToolResult> {
    // Synchronous reservation happens before the first await: a second call
    // observes busy even while this call is still admitting or staging.
    if (this.disposed) return this.rejectionResult("the execution adapter is disposed.", context);
    if (signal?.aborted) {
      return this.rejectionResult("the call was aborted before admission; no process was started and no dispatch budget was used.", context);
    }
    if (typeof args.expectedTaskId !== "string" || !IDENTIFIER.test(args.expectedTaskId)) {
      return this.rejectionResult("expectedTaskId is required and must be a valid task identifier; no admission, budget or process occurred.", context);
    }
    let subject: TaskSubject;
    let current: ManagedTask;
    try {
      subject = subjectFromContext(context, this.workspaceRoot);
      current = this.owner.reachableTask(subject);
    } catch (error) {
      return this.rejectionResult(errorMessage(error), context);
    }
    if (current.taskId !== args.expectedTaskId) {
      return errorResult("expectedTaskId does not match the current task; no admission, budget or process occurred.", this.visibleTerminalFacts(context));
    }
    if (this.busy) {
      safeAudit(this.audit, { type: "execution_busy_rejected", taskId: current.taskId, taskRevision: current.taskRevision });
      return this.rejectionResult("another execution is already active in this adapter; the second call was not admitted or spawned.", context);
    }
    const allowedIds = new Set(this.configInputs.map((input) => input.id));
    const unknown = args.inputIds.filter((inputId) => !allowedIds.has(inputId));
    if (unknown.length) {
      return this.rejectionResult(`input handle(s) are not host-authorized: ${unknown.join(", ")}. No admission or process was started.`, context);
    }
    const budget = this.budgetFor(current.taskId);
    if (budget.attempted + budget.reserved >= EXECUTION_LIMITS.maxDispatches) {
      safeAudit(this.audit, {
        type: "execution_budget_rejected",
        taskId: current.taskId,
        attempted: budget.attempted,
        dispatched: budget.dispatched,
        reserved: budget.reserved,
      });
      return this.rejectionResult(
        `this task has used ${budget.attempted} of ${EXECUTION_LIMITS.maxDispatches} launch attempts (${budget.dispatched} actual spawns); no process was started.`,
        context,
      );
    }
    this.busy = true;
    // Freeze the task identity from the actual task read at the same
    // synchronous reservation point. No later owner snapshot may relabel it.
    this.busyTask = { taskId: current.taskId, taskRevision: current.taskRevision };
    budget.reserved += 1;
    let attemptedDispatch = false;
    let recordPersisted = false;
    let finalAuditSent = false;
    let runId: string | undefined;
    let preparedRoot: string | undefined;
    let dispatchTaskId: string | undefined;
    let dispatchTaskRevision: number | undefined;
    let possiblyDispatched = false;
    let dispatchOutcomeClassified = false;
    let finalHostRecordConfirmed = false;
    try {
      if (current.taskRevision !== args.expectedTaskRevision) {
        return errorResult(
          `stale expectedTaskRevision ${args.expectedTaskRevision}; the owner is at ${current.taskRevision}. No admission or spawn occurred.`,
          this.visibleTerminalFacts(context),
        );
      }
      const decision = this.owner.admit(subject, this.capabilityId, args.expectedTaskRevision);
      if (!decision.allowed) {
        safeAudit(this.audit, {
          type: "execution_admission_denied",
          capabilityId: this.capabilityId,
          reason: decision.reason,
          taskId: decision.taskId,
          expectedTaskRevision: args.expectedTaskRevision,
        });
        return errorResult(
          `execution was not admitted: ${decision.reason ?? "owner denied the call"}.`,
          this.visibleTerminalFacts(context),
        );
      }
      if (decision.taskId !== args.expectedTaskId) {
        return this.rejectionResult("the admitted task identity differs from expectedTaskId; no process was started.", context);
      }
      // Admission is not a license to use a later revision: re-read the actual
      // task and binding after the owner's synchronous decision.
      let fresh: ManagedTask;
      try {
        fresh = this.owner.reachableTask(subject);
      } catch (error) {
        return this.rejectionResult(`no process was started: ${errorMessage(error)}`, context);
      }
      if (fresh.taskId !== decision.taskId
        || fresh.taskId !== args.expectedTaskId
        || fresh.taskRevision !== decision.taskRevision
        || fresh.status !== "active") {
        return errorResult(
          "the task changed between admission and preparation; no process was started.",
          this.visibleTerminalFacts(context),
        );
      }
      if (this.owner.bindingStatus().state !== "attached") {
        return this.rejectionResult("the conversation binding detached before preparation; no process was started.", context);
      }
      // Freeze the requirements identity at the actual admission point. Later
      // preparation, callbacks or amendments must never relabel this run with
      // a newer owner revision or digest.
      const frozenRequirementsDigest = requirementsDigest(fresh.requirementSources);
      const frozenTask: FrozenTaskRef = {
        ownerId: decision.ownerId,
        taskId: decision.taskId,
        taskRevision: decision.taskRevision,
        requirementsDigest: frozenRequirementsDigest,
      };
      runId = `run-${this.newId()}`;
      const callId = `call-${this.newId()}`;
      const runtimeInfo = runtimeSnapshot(this.runtimes[args.runtime]);
      const prepared = await this.prepare(
        runId,
        callId,
        args,
        decision.taskId,
        decision.taskRevision,
        frozenRequirementsDigest,
        runtimeInfo,
        signal,
      );
      preparedRoot = prepared.runRoot;
      if (this.disposed || signal?.aborted) {
        await rm(prepared.runRoot, { recursive: true, force: true });
        safeAudit(this.audit, {
          type: "execution_aborted_before_spawn",
          runId,
          callId,
          reason: this.disposed ? "adapter_disposed" : "call_aborted",
        });
        return this.rejectionResult("the call was aborted after staging; the staged files were removed and no process was started.", context);
      }
      // Rebuild the subject from the actual live OMP context. The subject
      // captured before staging may be stale; a disposed adapter or a changed
      // conversation/task must never reach an external spawn.
      let liveSubject: TaskSubject;
      let beforeSpawn: ManagedTask;
      try {
        liveSubject = subjectFromContext(context, this.workspaceRoot);
        beforeSpawn = this.owner.reachableTask(liveSubject);
      } catch (error) {
        await rm(prepared.runRoot, { recursive: true, force: true });
        return this.rejectionResult(`the live conversation context is no longer usable: ${errorMessage(error)}. No process was started.`, context);
      }
      if (this.disposed
        || beforeSpawn.taskId !== decision.taskId
        || beforeSpawn.taskId !== args.expectedTaskId
        || beforeSpawn.taskRevision !== decision.taskRevision
        || beforeSpawn.status !== "active"
        || this.owner.bindingStatus().state !== "attached") {
        await rm(prepared.runRoot, { recursive: true, force: true });
        return this.rejectionResult("the task or conversation binding changed immediately before spawn; no process was started.", context);
      }

      const recordPath = path.join(prepared.runRoot, "record.json");
      const baseRecord = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        limitsVersion: EXECUTION_LIMITS_VERSION,
        runId,
        callId,
        taskId: decision.taskId,
        ownerId: decision.ownerId,
        taskRevision: decision.taskRevision,
        requirementsDigest: frozenRequirementsDigest,
        anchorMessageId: decision.anchorMessageId,
        capabilityId: this.capabilityId,
        runtime: args.runtime,
        runtimeVersion: runtimeInfo.version,
        source: { bytes: prepared.sourceBytes, sha256: prepared.sourceSha256 },
        inputs: prepared.inputs.map((input) => ({
          id: input.id,
          bytes: input.bytes,
          sha256: input.sha256,
          stagedPath: input.stagedPath,
          sourcePath: input.sourcePath,
        })),
        interpreter: prepared.interpreter,
        launcher: this.launcherPath,
        profilePath: prepared.profilePath,
        createdAt: this.now(),
        phase: "prepared",
        process: null,
      };
      // Persist the host-owned run identity before any external spawn.
      this.recordWriter(recordPath, baseRecord);
      recordPersisted = true;
      safeAudit(this.audit, {
        type: "execution_prepared",
        runId,
        callId,
        taskId: decision.taskId,
        taskRevision: decision.taskRevision,
        runtime: args.runtime,
        sourceSha256: prepared.sourceSha256,
        inputs: prepared.inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
      });

      // Host callbacks above are synchronous and may dispose the adapter,
      // detach the binding, cancel/revise the task or abort the signal. Recheck
      // the actual live facts after every one of them and immediately before
      // the only OS spawn. A prepared record is rewritten as not_dispatched.
      const revoked = this.preDispatchRevocation(context, decision.taskId, decision.taskRevision, signal);
      if (revoked !== undefined) {
        this.recordNotDispatched(recordPath, baseRecord, revoked);
        safeAudit(this.audit, {
          type: "execution_revoked_before_spawn",
          runId,
          callId,
          taskId: decision.taskId,
          taskRevision: decision.taskRevision,
          reason: revoked,
        });
        return this.rejectionResult(`no process was started: ${revoked}.`, context);
      }

      budget.reserved -= 1;
      budget.attempted += 1;
      attemptedDispatch = true;
      dispatchTaskId = decision.taskId;
      dispatchTaskRevision = decision.taskRevision;
      let stop: (reason: StopReason) => void = () => undefined;
      const active: ActiveRun = {
        runId,
        taskId: decision.taskId,
        taskRevision: decision.taskRevision,
        stop: (reason) => stop(reason),
      };
      this.active = active;
      possiblyDispatched = true;
      let outcome: DispatchOutcome;
      try {
        outcome = await this.dispatch(
          prepared,
          args.runtime,
          runtimeInfo,
          recordPath,
          baseRecord,
          signal,
          (stopHandler) => {
            stop = stopHandler;
          },
          () => {
            budget.dispatched += 1;
          },
        );
      } finally {
        if (this.active === active) this.active = undefined;
      }
      // Completion is classified only from actual process-control and host
      // record facts. launchStage "unknown" after an ACK is not evidence that
      // the external run is still unfinished. Outcome classification alone is
      // not final host completion accounting: only a persisted completed
      // record confirms that below.
      dispatchOutcomeClassified = true;
      possiblyDispatched = outcome.spawned;
      this.latchUnresolved(runId, decision.taskId, decision.taskRevision, unresolvedReasonCodes(outcome));

      let artifacts: ArtifactRecord[] = [];
      let rejections: ArtifactRejection[] = [];
      let artifactTotalBytes = 0;
      let stoppedAtLimit = false;
      let artifactExportError: string | null = null;
      if (outcome.groupGone) {
        try {
          ({ artifacts, rejections, artifactTotalBytes, stoppedAtLimit } = await this.exportArtifacts(runId, prepared));
        } catch (error) {
          artifactExportError = errorMessage(error);
          rejections = [{ relativePath: ".", reason: `artifact export failed: ${artifactExportError}` }];
        }
      } else {
        rejections = [{ relativePath: ".", reason: "process group not verified gone; no artifact export" }];
      }
      const bindingAtRecord = this.owner.bindingStatus();
      let taskAtRecord: ManagedTask | undefined;
      try {
        taskAtRecord = this.owner.reachableTask(subjectFromContext(context, this.workspaceRoot));
      } catch {
        taskAtRecord = undefined;
      }
      const visibleAtRecord = bindingAtRecord.state === "attached"
        && taskAtRecord !== undefined
        && taskAtRecord.taskId === decision.taskId
        && taskAtRecord.taskRevision === decision.taskRevision;
      const withheldReasonAtRecord = visibleAtRecord
        ? null
        : "conversation binding or task reachability changed after the run; output and artifact paths remain in the host record";
      const dispatchBudget = this.budgetFor(decision.taskId);
      const record = {
        ...baseRecord,
        phase: "completed",
        updatedAt: this.now(),
        process: {
          spawned: outcome.spawned,
          pid: outcome.pid,
          pgid: outcome.pgid,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          durationMs: outcome.durationMs,
          stopReason: outcome.stopReason,
          terminatedByHost: outcome.terminatedByHost,
          groupGone: outcome.groupGone,
          groupCheckMs: outcome.groupCheckMs,
          spawnError: outcome.spawnError,
          launchStage: outcome.launchStage,
          hostRecordError: outcome.hostRecordError,
          watchdog: copiedWatchdog(outcome.watchdog),
        },
        watchdog: copiedWatchdog(outcome.watchdog),
        output: {
          observedBytes: outcome.observedBytes,
          retainedBytes: outcome.retainedBytes,
          decodedTextBytes: outcome.decodedTextBytes,
          droppedIncompleteBytes: outcome.droppedIncompleteBytes,
          invalidEncoding: outcome.invalidEncoding,
          decodingPolicy: OUTPUT_DECODING_POLICY,
          observedAfterRetentionBytes: outcome.observedAfterRetentionBytes,
          truncated: outcome.truncated,
          text: outcome.logText,
        },
        artifacts: artifacts.map(copiedArtifact),
        artifactRejections: rejections.map(copiedRejection),
        artifactTotalBytes,
        artifactLimitReached: stoppedAtLimit,
        artifactExportError,
        hostRecordError: outcome.hostRecordError,
        bindingAfter: { ...bindingAtRecord },
        withheldReason: withheldReasonAtRecord,
        taskAccepted: false,
        candidateOnly: true,
      };
      let finalRecordError: string | null = null;
      try {
        this.recordWriter(recordPath, record);
        finalHostRecordConfirmed = true;
      } catch (error) {
        finalRecordError = `final host record write failed: ${errorMessage(error)}`;
        safeAudit(this.audit, { type: "execution_record_write_failed", runId, error: finalRecordError });
        // A missing final record means the durable completion account is
        // unproven only when an external process actually exists. A trusted
        // known-no-spawn outcome keeps this as a host-record diagnostic and
        // never creates an unresolved external run.
        if (possiblyDispatched) {
          this.latchUnresolved(runId, decision.taskId, decision.taskRevision, ["final_host_record_unconfirmed"]);
        }
      }
      // Register actual archived candidates only after the trusted archive
      // path has completed. The frozen task/digest was captured at admission;
      // a callback above may have revised the owner, but this old run can never
      // be relabeled as the new revision. Registration failure is recorded and
      // never changes the real execution, artifact or cost facts.
      let candidateRegistration: { registered: number; idempotent: number } | null = null;
      let candidateRegistrationError: string | null = null;
      let candidateRegistrationErrorWhenWithheld: string | null = null;
      if (artifacts.length > 0) {
        try {
          candidateRegistration = await this.candidateRegistry.register({
            task: frozenTask,
            runId,
            callId: prepared.callId,
            privateRoot: this.root,
            source: {
              path: prepared.sourcePath,
              bytes: prepared.sourceBytes,
              sha256: prepared.sourceSha256,
            },
            inputs: prepared.inputs.map((input) => ({
              id: input.id,
              path: input.stagedPath,
              bytes: input.bytes,
              sha256: input.sha256,
            })),
            artifacts: artifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              relativePath: artifact.relativePath,
              archivePath: path.join(prepared.artifactRoot, `${artifact.artifactId}.bin`),
              bytes: artifact.bytes,
              sha256: artifact.sha256,
            })),
            provenance: {
              spawned: outcome.spawned,
              pid: outcome.pid,
              pgid: outcome.pgid,
              exitCode: outcome.exitCode,
              signal: outcome.signal,
              stopReason: outcome.stopReason,
              terminatedByHost: outcome.terminatedByHost,
              groupGone: outcome.groupGone,
              launchStage: outcome.launchStage,
              durationMs: outcome.durationMs,
              watchdogArmed: outcome.watchdog.armed,
              watchdogTerminated: outcome.watchdog.watchdogTerminated,
              watchdogControlError: outcome.watchdog.controlError,
              afterSpawnHostRecordError: outcome.hostRecordError,
              finalRecordError,
              artifactExportError,
            },
            registeredAt: this.now(),
          });
        } catch (error) {
          candidateRegistrationError = errorMessage(error).slice(0, 500);
          candidateRegistrationErrorWhenWithheld = withheldRegistrationError(error);
          safeAudit(this.audit, {
            type: "execution_candidate_registration_failed",
            runId,
            taskId: decision.taskId,
            taskRevision: decision.taskRevision,
            error: candidateRegistrationError,
          });
        }
      }
      // The final record callback is a trusted host callback. It may
      // synchronously navigate, detach or revise the live task. Re-read the
      // actual session/task immediately before projecting model-visible output;
      // a snapshot taken before that callback is not sufficient.
      let finalTask: ManagedTask | undefined;
      try {
        finalTask = this.owner.reachableTask(subjectFromContext(context, this.workspaceRoot));
      } catch {
        finalTask = undefined;
      }
      const finalBinding = this.owner.bindingStatus();
      const visible = finalBinding.state === "attached"
        && finalTask !== undefined
        && finalTask.taskId === decision.taskId
        && finalTask.taskRevision === decision.taskRevision;
      const withheldReason = visible
        ? null
        : "conversation binding or task reachability changed after the run; output and artifact paths remain in the host record";
      const hostRecordRef = `${path.basename(prepared.runRoot)}/record.json`;
      const attemptBudget = {
        limit: EXECUTION_LIMITS.maxDispatches,
        attempted: dispatchBudget.attempted,
        dispatched: dispatchBudget.dispatched,
        reserved: dispatchBudget.reserved,
      };
      const isError = outcome.spawnError !== null
        || outcome.launchStage === "handshake_failed"
        || !outcome.watchdog.armed
        || !outcome.watchdog.ackSent
        || outcome.watchdog.watchdogTerminated !== true
        || outcome.watchdog.controlError !== null
        || outcome.watchdog.unexpectedControlEof
        || outcome.watchdog.watchdogKilledByHost
        || outcome.hostRecordError !== null
        || finalRecordError !== null
        || artifactExportError !== null
        || !outcome.groupGone
        || outcome.stopReason === "timeout"
        || (outcome.spawned && outcome.exitCode !== 0 && !outcome.terminatedByHost);
      const facts: RunModelViewFacts = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        limitsVersion: EXECUTION_LIMITS_VERSION,
        runId,
        callId,
        taskId: decision.taskId,
        ownerId: decision.ownerId,
        taskRevision: decision.taskRevision,
        anchorMessageId: decision.anchorMessageId,
        runtime: args.runtime,
        runtimeVersion: runtimeInfo.version,
        availableRuntimes: {
          python: runtimeSnapshot(this.runtimes.python),
          bun: runtimeSnapshot(this.runtimes.bun),
        },
        limits: {
          ...EXECUTION_LIMITS,
          dispatchWallMs: this.dispatchWallMs,
          terminationGraceMs: this.terminationGraceMs,
        },
        source: { bytes: prepared.sourceBytes, sha256: prepared.sourceSha256 },
        inputs: prepared.inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
        dispatch: {
          spawned: outcome.spawned,
          pid: outcome.pid,
          pgid: outcome.pgid,
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          reason: outcome.stopReason ?? (outcome.exitCode === 0 ? "exited_zero" : "exited_nonzero"),
          durationMs: outcome.durationMs,
          terminatedByHost: outcome.terminatedByHost,
          processGroupVerifiedGone: outcome.groupGone,
          spawnError: outcome.spawnError,
          launchStage: outcome.launchStage,
          launchStageNote: outcome.watchdog.ackSent
            ? "armed handshake acknowledged; user-code start is not independently proven, so exit/signal/artifacts are observations of the launched wrapper; exit code 111 alone is not proof of pre-exec launcher failure or that no untrusted code ran"
            : outcome.launchStage === "handshake_failed"
              ? "the trusted armed handshake did not complete; no acknowledgement was sent, so untrusted code was not started by a correctly handled launch"
              : "the acknowledgement outcome is unproven; the wrapper exit and actual return code are reported as observed facts",
          wrapperExitObserved: outcome.exitCode !== null || outcome.signal !== null,
          userCodeStart: outcome.watchdog.ackSent ? "unproven" : "not_acknowledged",
          watchdogArmed: outcome.watchdog.armed,
          watchdogTerminated: outcome.watchdog.watchdogTerminated,
          childExitObserved: outcome.childExitObserved,
          hostRecordError: outcome.hostRecordError,
        },
        watchdog: copiedWatchdog(outcome.watchdog),
        hostRecordErrors: {
          afterSpawn: outcome.hostRecordError,
          finalRecord: finalRecordError,
          artifactExport: artifactExportError,
        },
        requirementsDigest: frozenTask.requirementsDigest,
        candidateRegistration,
        candidateRegistrationError: visible || candidateRegistrationError === null
          ? candidateRegistrationError
          : candidateRegistrationErrorWhenWithheld,
        output: {
          observedBytes: outcome.observedBytes,
          retainedBytes: outcome.retainedBytes,
          decodedTextBytes: outcome.decodedTextBytes,
          droppedIncompleteBytes: outcome.droppedIncompleteBytes,
          invalidEncoding: outcome.invalidEncoding,
          truncated: outcome.truncated,
          observedAfterRetentionBytes: outcome.observedAfterRetentionBytes,
          text: outcome.logText,
        },
        artifacts: artifacts.map(copiedArtifact),
        artifactRejections: rejections.map(copiedRejection),
        artifactTotalBytes,
        artifactLimitReached: stoppedAtLimit,
        bindingBefore: "attached",
        bindingAfter: { ...finalBinding },
        taskAfterStatus: finalTask?.status ?? null,
        taskStillReachable: finalTask !== undefined,
        visible,
        withheldReason,
        attemptBudget,
        hostRecordRef,
        isError,
      };
      const initialProjection = assembleRunResponse(facts, MODEL_VIEW_INITIAL_WINDOW);
      const boundedBeforeFinalCheck = boundedRunResponse(facts);
      safeAudit(this.audit, {
        type: "execution_completed",
        runId,
        callId,
        taskId: decision.taskId,
        taskRevision: decision.taskRevision,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stopReason: outcome.stopReason,
        groupGone: outcome.groupGone,
        watchdogArmed: outcome.watchdog.armed,
        watchdogTerminated: outcome.watchdog.watchdogTerminated,
        watchdogTriggerReason: outcome.watchdog.triggerReason,
        watchdogControlError: outcome.watchdog.controlError,
        artifacts: artifacts.length,
        artifactRejections: rejections.length,
        visible,
        responseBytes: responseByteLength(boundedBeforeFinalCheck),
        responseWindowTrimmed: responseByteLength(initialProjection) > responseByteLength(boundedBeforeFinalCheck),
      });
      finalAuditSent = true;
      // execution_completed is the final synchronous host callback. It may
      // navigate, detach or revise the live task. Re-read the actual
      // subject/binding after it and rebuild both content and details from
      // the resulting visibility. No host callback runs after this point.
      let finalTaskAfterAudit: ManagedTask | undefined;
      try {
        finalTaskAfterAudit = this.owner.reachableTask(subjectFromContext(context, this.workspaceRoot));
      } catch {
        finalTaskAfterAudit = undefined;
      }
      const finalBindingAfterAudit = this.owner.bindingStatus();
      const finalVisible = finalBindingAfterAudit.state === "attached"
        && finalTaskAfterAudit !== undefined
        && finalTaskAfterAudit.taskId === decision.taskId
        && finalTaskAfterAudit.taskRevision === decision.taskRevision;
      const finalWithheldReason = finalVisible
        ? null
        : "conversation binding or task reachability changed after the run; output and artifact paths remain in the host record";
      return boundedRunResponse({
        ...facts,
        candidateRegistrationError: finalVisible || candidateRegistrationError === null
          ? candidateRegistrationError
          : candidateRegistrationErrorWhenWithheld,
        bindingAfter: { ...finalBindingAfterAudit },
        taskAfterStatus: finalTaskAfterAudit?.status ?? null,
        taskStillReachable: finalTaskAfterAudit !== undefined,
        visible: finalVisible,
        withheldReason: finalWithheldReason,
      });
    } catch (error) {
      // A throw after a possible/actual dispatch but before the final completed
      // host record leaves external completion unproven. Observed process
      // cleanup alone is not final host completion accounting. Known no-spawn
      // outcomes and earlier preparation/admission failures never latch.
      if (attemptedDispatch
        && possiblyDispatched
        && runId !== undefined
        && dispatchTaskId !== undefined
        && dispatchTaskRevision !== undefined
        && !finalHostRecordConfirmed) {
        this.latchUnresolved(
          runId,
          dispatchTaskId,
          dispatchTaskRevision,
          [dispatchOutcomeClassified ? "final_host_record_unconfirmed" : "dispatch_outcome_unconfirmed"],
        );
      }
      if (!finalAuditSent) {
        safeAudit(this.audit, {
          type: "execution_failed",
          runId: runId ?? null,
          taskId: current.taskId,
          error: errorMessage(error),
        });
      }
      return this.rejectionResult(errorMessage(error), context);
    } finally {
      // Bookkeeping release is unconditional: a rejected staging cleanup must
      // never leave the adapter falsely busy or retain a stale busy task.
      try {
        if (!attemptedDispatch) {
          budget.reserved = Math.max(0, budget.reserved - 1);
          if (preparedRoot && !recordPersisted) {
            // No untrusted process ever existed and no host run record was
            // committed; remove the explicitly owned staging tree.
            try {
              await rm(preparedRoot, { recursive: true, force: true });
            } catch (error) {
              safeAudit(this.audit, {
                type: "execution_staging_cleanup_failed",
                runId: runId ?? null,
                root: preparedRoot,
                error: errorMessage(error),
              });
            }
          }
        }
      } finally {
        this.busy = false;
        this.busyTask = null;
      }
    }
  }

  private preDispatchRevocation(
    context: ExecutionToolContext,
    taskId: string,
    taskRevision: number,
    signal: AbortSignal | undefined,
  ): string | undefined {
    if (this.disposed) return "the execution adapter was disposed before spawn";
    if (signal?.aborted) return "the call was aborted before spawn";
    let live: ManagedTask;
    try {
      live = this.owner.reachableTask(subjectFromContext(context, this.workspaceRoot));
    } catch (error) {
      return `the live conversation context is no longer usable: ${errorMessage(error)}`;
    }
    if (live.taskId !== taskId) return "the managed task identity changed before spawn";
    if (live.taskRevision !== taskRevision) {
      return `the task revision changed from ${taskRevision} to ${live.taskRevision} before spawn`;
    }
    if (live.status !== "active") return `the task status is ${live.status} before spawn`;
    if (this.owner.bindingStatus().state !== "attached") {
      return "the conversation binding detached before spawn";
    }
    return undefined;
  }

  private recordNotDispatched(recordPath: string, baseRecord: Record<string, unknown>, reason: string): void {
    try {
      this.recordWriter(recordPath, {
        ...baseRecord,
        phase: "not_dispatched",
        updatedAt: this.now(),
        dispatch: {
          spawned: false,
          pid: null,
          pgid: null,
          exitCode: null,
          signal: null,
          reason: "not_dispatched",
          detail: reason,
        },
        process: null,
        notDispatchedReason: reason,
      });
    } catch (error) {
      // The earlier prepared record is still truthful (no process exists);
      // a failed rewrite must never turn this into a dispatch.
      safeAudit(this.audit, {
        type: "execution_not_dispatched_record_failed",
        runId: baseRecord.runId ?? null,
        error: errorMessage(error),
      });
    }
  }

  private budgetFor(taskId: string): RunBudget {
    const current = this.budgets.get(taskId);
    if (current) return current;
    const created = { attempted: 0, dispatched: 0, reserved: 0 };
    this.budgets.set(taskId, created);
    return created;
  }

  private async prepare(
    runId: string,
    callId: string,
    args: Extract<ExecutionArguments, { action: "run" }>,
    taskId: string,
    taskRevision: number,
    requirementsDigestValue: string,
    runtimeInfo: ExecutionRuntimeInfo,
    signal?: AbortSignal,
  ): Promise<PreparedRun> {
    const runRoot = await mkdtemp(path.join(this.root, "run-"));
    try {
      return await this.prepareIn(
        runRoot,
        runId,
        callId,
        args,
        taskId,
        taskRevision,
        requirementsDigestValue,
        runtimeInfo,
        signal,
      );
    } catch (error) {
      // A preparation failure never leaves a private staging tree behind and
      // never starts untrusted code. The failure itself is audited.
      await rm(runRoot, { recursive: true, force: true });
      safeAudit(this.audit, {
        type: "execution_preparation_failed",
        runId,
        callId,
        taskId,
        taskRevision,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private async prepareIn(
    runRoot: string,
    runId: string,
    callId: string,
    args: Extract<ExecutionArguments, { action: "run" }>,
    taskId: string,
    taskRevision: number,
    requirementsDigestValue: string,
    runtimeInfo: ExecutionRuntimeInfo,
    signal?: AbortSignal,
  ): Promise<PreparedRun> {
    const sourceRoot = path.join(runRoot, "source");
    const inputRoot = path.join(runRoot, "inputs");
    const workRoot = path.join(runRoot, "work");
    const tmpRoot = path.join(workRoot, "tmp");
    const artifactRoot = path.join(runRoot, "artifacts");
    await mkdir(sourceRoot, { mode: 0o700 });
    await mkdir(inputRoot, { mode: 0o700 });
    await mkdir(workRoot, { mode: 0o700 });
    await mkdir(tmpRoot, { mode: 0o700 });
    await mkdir(artifactRoot, { mode: 0o700 });

    const sourceBytes = Buffer.from(args.source, "utf8");
    if (sourceBytes.length > EXECUTION_LIMITS.maxSourceBytes) {
      throw new ExecutionAdapterError("source exceeds the UTF-8 byte limit.");
    }
    const extension = args.runtime === "python" ? "py" : "ts";
    const sourcePath = path.join(sourceRoot, `script.${extension}`);
    await writeFile(sourcePath, sourceBytes, { flag: "wx", mode: 0o400 });
    const sourceSha256 = digest(sourceBytes);

    const selected = args.inputIds.map((inputId) => {
      const input = this.configInputs.find((candidate) => candidate.id === inputId);
      if (!input) throw new ExecutionAdapterError(`input handle is not host-authorized: ${inputId}.`);
      return input;
    });
    let totalBytes = 0;
    const inputs: PreparedInput[] = [];
    for (const input of selected) {
      if (signal?.aborted) throw new ExecutionAdapterError("the call was aborted while staging inputs.");
      const before = await lstat(input.path);
      if (before.isSymbolicLink()) {
        throw new ExecutionAdapterError(`authorized input ${input.id} is a symbolic link.`);
      }
      if (!before.isFile()) {
        throw new ExecutionAdapterError(`authorized input ${input.id} is not a regular file.`);
      }
      if (before.nlink !== 1) throw new ExecutionAdapterError(`authorized input ${input.id} has multiple hard links.`);
      if (before.size > EXECUTION_LIMITS.maxInputBytes) {
        throw new ExecutionAdapterError(`authorized input ${input.id} exceeds the per-input byte limit.`);
      }
      if (totalBytes + before.size > EXECUTION_LIMITS.maxTotalInputBytes) {
        throw new ExecutionAdapterError("selected inputs exceed the total byte limit.");
      }
      const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      let after: Awaited<ReturnType<typeof lstat>>;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new ExecutionAdapterError(`authorized input ${input.id} changed while it was opened.`);
        }
        bytes = await handle.readFile();
        after = await lstat(input.path);
      } finally {
        await handle.close();
      }
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== before.size) {
        throw new ExecutionAdapterError(`authorized input ${input.id} changed during staging.`);
      }
      if (bytes.length !== before.size) {
        throw new ExecutionAdapterError(`authorized input ${input.id} produced an unexpected byte count.`);
      }
      totalBytes += bytes.length;
      const stagedPath = path.join(inputRoot, `${input.id}.bin`);
      await writeFile(stagedPath, bytes, { flag: "wx", mode: 0o400 });
      const staged = await lstat(stagedPath);
      if (!staged.isFile() || staged.nlink !== 1 || staged.size !== bytes.length) {
        throw new ExecutionAdapterError(`staged input ${input.id} failed its independent-inode check.`);
      }
      const stagedBytes = await readFile(stagedPath);
      const sha256 = digest(stagedBytes);
      if (sha256 !== digest(bytes)) throw new ExecutionAdapterError(`staged input ${input.id} failed copy verification.`);
      inputs.push({
        id: input.id,
        sourcePath: input.path,
        stagedPath,
        bytes: bytes.length,
        sha256,
      });
    }

    const manifestPath = path.join(inputRoot, "manifest.json");
    const manifest = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      handles: Object.fromEntries(inputs.map((input) => [input.id, {
        path: input.stagedPath,
        bytes: input.bytes,
        sha256: input.sha256,
        writable: false,
      }])),
      workDir: workRoot,
      sourcePath,
      runtime: args.runtime,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o400 });

    const interpreter = args.runtime === "python" ? this.pythonPath : this.bunPath;
    const realInterpreter = await realpath(interpreter);
    const interpreterArgs = args.runtime === "python"
      ? ["-I", "-B", sourcePath]
      : ["run", "--no-env-file", "--no-install", sourcePath];
    const profilePath = path.join(runRoot, "profile.sb");
    const profileBytes = Buffer.from(sandboxProfile({
      interpreterPath: realInterpreter,
      sourceRoot,
      inputRoot,
      workRoot,
    }), "utf8");
    const profileSha256 = hexDigest(profileBytes);
    await writeFile(profilePath, profileBytes, { flag: "wx", mode: 0o600 });
    const childEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      TMPDIR: tmpRoot,
      OMP_EXEC_RUNTIME: runtimeInfo.name,
      OMP_WORK_DIR: workRoot,
      OMP_INPUTS_MANIFEST: manifestPath,
    };
    safeAudit(this.audit, {
      type: "execution_staged",
      runId,
      callId,
      taskId,
      taskRevision,
      inputs: inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
      sourceBytes: sourceBytes.length,
      sourceSha256,
    });
    return {
      runId,
      callId,
      runRoot,
      sourceRoot,
      inputRoot,
      workRoot,
      tmpRoot,
      artifactRoot,
      sourcePath,
      manifestPath,
      profilePath,
      profileSha256,
      watchdogLogPath: path.join(runRoot, "watchdog.jsonl"),
      sourceBytes: sourceBytes.length,
      sourceSha256,
      inputs,
      requirementsDigest: requirementsDigestValue,
      interpreter,
      interpreterArgs,
      childEnv,
    };
  }

  private async dispatch(
    prepared: PreparedRun,
    runtime: ExecutionRuntime,
    runtimeInfo: ExecutionRuntimeInfo,
    recordPath: string,
    baseRecord: Record<string, unknown>,
    signal: AbortSignal | undefined,
    registerStop: (stop: (reason: StopReason) => void) => void,
    onSpawned: () => void,
  ): Promise<DispatchOutcome> {
    const startedAt = Date.now();
    const configToken = randomUUID();
    const watchdogLogRef = `${path.basename(prepared.runRoot)}/watchdog.jsonl`;
    let child: ChildProcess;
    try {
      child = spawn(
        this.pythonPath,
        [
          "-I", "-B", this.launcherPath,
          "--profile", prepared.profilePath,
          "--fsize", String(EXECUTION_LIMITS.maxFileSizeBytes),
          "--supervisor-pid", String(process.pid),
          "--deadline-ms", String(this.dispatchWallMs),
          "--grace-ms", String(this.terminationGraceMs),
          "--control-fd", "3",
          "--ack-fd", "4",
          "--watchdog-log", prepared.watchdogLogPath,
          "--config-token", configToken,
          "--runtime", runtime,
          "--",
          prepared.interpreter,
          ...prepared.interpreterArgs,
        ],
        {
          cwd: prepared.workRoot,
          env: prepared.childEnv,
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      return {
        spawned: false,
        spawnError: errorMessage(error),
        pid: null,
        pgid: null,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        observedBytes: 0,
        retainedBytes: 0,
        decodedTextBytes: 0,
        droppedIncompleteBytes: 0,
        invalidEncoding: false,
        truncated: false,
        observedAfterRetentionBytes: 0,
        logText: "",
        stopReason: null,
        terminatedByHost: false,
        groupGone: true,
        groupCheckMs: 0,
        launchStage: "spawn_failed",
        hostRecordError: null,
        childExitObserved: false,
        watchdog: {
          protocol: WATCHDOG_PROTOCOL,
          armed: false,
          watchdogPid: null,
          watchdogSid: null,
          scriptPid: null,
          supervisorPid: process.pid,
          deadlineBasis: null,
          durationMs: this.dispatchWallMs,
          graceMs: this.terminationGraceMs,
          armedAtMonotonic: null,
          deadlineMonotonic: null,
          handshakeMs: 0,
          handshakeError: "no process was spawned",
          ackAttempted: false,
          ackSent: false,
          triggerReason: null,
          termSent: false,
          killSent: false,
          watchdogExitObserved: false,
          watchdogExitConfirmed: false,
          childExitObserved: false,
          controlEnded: false,
          controlError: null,
          unexpectedControlEof: false,
          controlEventLimit: WATCHDOG_CONTROL_MAX_EVENTS,
          controlEventsRejected: 0,
          controlStreamBytes: 0,
          controlBytesDiscarded: 0,
          controlEvents: [],
          logRef: watchdogLogRef,
          logAvailable: false,
          pidGone: null,
          watchdogTerminated: null,
          watchdogKilledByHost: false,
          pidReuseCaveat: "numeric process-group/PID checks are bounded local facts; PID reuse is not proven and unrelated PIDs are never inspected",
        },
      };
    }
    // Ownership of the actual child starts here. Attach an error sink before
    // anything else so no error can be unhandled, then arm stdout/stderr,
    // close, deadline, abort and owner-stop before any fallible host I/O.
    let spawnError: string | null = null;
    child.on("error", (error) => {
      spawnError = errorMessage(error);
    });
    const pid = child.pid ?? null;
    if (pid === null) {
      try { child.kill("SIGKILL"); } catch { /* no pid means no group handle */ }
      throw new ExecutionAdapterError("spawned execution process has no pid; the child was killed where possible.");
    }
    const pgid = pid;
    let observedBytes = 0;
    let observedAfterRetention = 0;
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let truncated = false;
    let stopReason: StopReason | null = null;
    let terminatedByHost = false;
    let groupCheckMs = 0;
    let closed = false;
    let childExitObserved = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let hostRecordError: string | null = null;
    let termination: Promise<void> | undefined;
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
    const requestStop = (reason: StopReason): void => {
      if (!stopReason) stopReason = reason;
      if (termination) return;
      terminatedByHost = true;
      termination = (async () => {
        try { process.kill(-pgid, "SIGTERM"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") spawnError = `SIGTERM failed: ${errorMessage(error)}`;
        }
        await Promise.race([closePromise, delay(this.terminationGraceMs)]);
        if (!closed && groupAlive(pgid)) {
          try { process.kill(-pgid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") spawnError = `SIGKILL failed: ${errorMessage(error)}`;
          }
        }
        const deadline = Date.now() + 2000;
        while (!closed && Date.now() < deadline) await delay(10);
        while (groupAlive(pgid) && Date.now() < deadline) await delay(10);
      })();
    };
    registerStop(requestStop);
    const controlStream = (child.stdio[3] ?? null) as unknown as Duplex | null;
    const ackStream = (child.stdio[4] ?? null) as unknown as Duplex | null;
    let armed: WatchdogArmedFacts | null = null;
    let handshakeError: string | null = null;
    let ackAttempted = false;
    let ackSent = false;
    let controlError: string | null = null;
    let controlEnded = false;
    let watchdogExitObserved = false;
    let watchdogExitConfirmed = false;
    let triggerReason: string | null = null;
    let termSent = false;
    let killSent = false;
    let unexpectedControlEof = false;
    let watchdogKilledByHost = false;
    let handshakeMs = 0;
    let controlEventsRejected = 0;
    let controlLossTask: Promise<void> | undefined;
    const controlEvents: Array<Record<string, unknown>> = [];
    const lifecycle: ControlLifecycle = {
      triggerSeen: false,
      triggerReason: null,
      triggerScriptExitObserved: false,
      termSeen: false,
      killSeen: false,
      exitSeen: false,
      failureSeen: false,
    };
    const recordControlRejection = (message: string): void => {
      // The first protocol error is authoritative; later benign records must
      // never replace it or become trusted history.
      controlEventsRejected += 1;
      if (controlError === null) controlError = message;
      if (armed === null && handshakeError === null) handshakeError = message;
      if (!closed && !stopReason) {
        requestStop(armed === null ? "watchdog_handshake_failed" : "watchdog_lost");
      }
    };
    const verifyControlLoss = (): void => {
      if (controlLossTask) return;
      controlLossTask = (async () => {
        if (armed === null || !controlEnded || stopReason !== null) return;
        if (!watchdogExitObserved) {
          unexpectedControlEof = true;
          if (controlError === null) {
            controlError = "watchdog control stream ended without a terminal event";
          }
        } else if (childExitObserved) {
          watchdogExitConfirmed = true;
          return;
        }
        if (childExitObserved) return;
        const drainDeadline = Date.now() + WATCHDOG_CHILD_EXIT_DRAIN_MS;
        while (!childExitObserved && !closed && stopReason === null && Date.now() < drainDeadline) {
          await delay(5);
        }
        if (childExitObserved) {
          if (watchdogExitObserved) watchdogExitConfirmed = true;
          return;
        }
        if (closed || stopReason !== null) return;
        if (watchdogExitObserved && controlError === null) {
          controlError = "watchdog terminal event claimed script exit while the actual child was still running";
          unexpectedControlEof = true;
        }
        requestStop("watchdog_lost");
      })();
    };
    const endControl = (): void => {
      if (controlEnded) return;
      controlEnded = true;
      parser.end();
      if (closed) {
        if (armed !== null && watchdogExitObserved && childExitObserved) watchdogExitConfirmed = true;
        return;
      }
      if (armed === null) {
        if (!stopReason) requestStop("watchdog_handshake_failed");
        return;
      }
      verifyControlLoss();
    };
    const handleControlError = (message: string): void => {
      if (controlError === null) controlError = message;
      if (armed === null && handshakeError === null) handshakeError = message;
      if (!closed && !stopReason) {
        requestStop(armed === null ? "watchdog_handshake_failed" : "watchdog_lost");
      }
    };
    const handleControlMessage = (message: Record<string, unknown>): void => {
      if (controlEnded || controlError !== null || handshakeError !== null) {
        controlEventsRejected += 1;
        return;
      }
      if (armed === null) {
        const validated = validateArmedFacts(message, {
          supervisorPid: process.pid,
          scriptPid: pid,
          durationMs: this.dispatchWallMs,
          graceMs: this.terminationGraceMs,
          configToken,
          runtime,
          profileSha256: prepared.profileSha256,
        });
        if (typeof validated === "string") {
          recordControlRejection(validated);
          return;
        }
        armed = validated;
        handshakeMs = Date.now() - startedAt;
        return;
      }
      const invalid = validateControlEvent(message, armed, lifecycle);
      if (invalid !== undefined) {
        recordControlRejection(invalid);
        return;
      }
      if (controlEvents.length >= WATCHDOG_CONTROL_MAX_EVENTS) {
        recordControlRejection(
          `watchdog control event limit ${WATCHDOG_CONTROL_MAX_EVENTS} exceeded; retained ${controlEvents.length} earlier events`,
        );
        return;
      }
      controlEvents.push({
        type: message.type,
        ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
        ...(typeof message.sent === "boolean" ? { sent: message.sent } : {}),
        ...(typeof message.scriptExitObserved === "boolean"
          ? { scriptExitObserved: message.scriptExitObserved }
          : {}),
        ...(typeof message.error === "string" ? { error: message.error.slice(0, 200) } : {}),
      });
      switch (message.type) {
        case "trigger":
          lifecycle.triggerSeen = true;
          lifecycle.triggerReason = message.reason as WatchdogTriggerReason;
          lifecycle.triggerScriptExitObserved = message.scriptExitObserved as boolean;
          triggerReason = message.reason as string;
          break;
        case "term_sent":
          lifecycle.termSeen = true;
          if (message.sent === true) termSent = true;
          break;
        case "kill_sent":
          lifecycle.killSeen = true;
          if (message.sent === true) killSent = true;
          break;
        case "watchdog_exit":
          lifecycle.exitSeen = true;
          watchdogExitObserved = true;
          if (childExitObserved) watchdogExitConfirmed = true;
          break;
        case "watchdog_failure":
          lifecycle.failureSeen = true;
          controlError = `watchdog failure: ${String(message.error)}`;
          if (!closed && !stopReason) requestStop("watchdog_lost");
          break;
      }
    };
    const parser = new BoundedControlReader(handleControlMessage, handleControlError);
    controlStream?.on("data", (bytes: Buffer) => parser.push(bytes));
    controlStream?.on("end", endControl);
    controlStream?.on("close", endControl);
    controlStream?.on("error", (error: Error) => {
      handleControlError(`watchdog control channel error: ${errorMessage(error)}`);
      endControl();
    });
    ackStream?.on("error", (error: Error) => {
      if (!ackSent) {
        handshakeError = `acknowledgement channel error: ${errorMessage(error)}`;
        if (!closed && !stopReason) requestStop("watchdog_handshake_failed");
      }
    });
    const onChunk = (bytes: Buffer): void => {
      observedBytes += bytes.length;
      const remaining = EXECUTION_LIMITS.maxRetainedOutputBytes - retainedBytes;
      if (remaining > 0) {
        const take = Math.min(remaining, bytes.length);
        chunks.push(bytes.subarray(0, take));
        retainedBytes += take;
        if (take < bytes.length) observedAfterRetention += bytes.length - take;
      } else {
        observedAfterRetention += bytes.length;
      }
      if (observedBytes > EXECUTION_LIMITS.maxRetainedOutputBytes && !truncated) {
        truncated = true;
        requestStop("output_limit");
      }
    };
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", onChunk);
    // 'exit' proves the direct child exited. 'close' additionally waits for
    // inherited stdio pipes, so it must never be used as that proof.
    child.on("exit", () => {
      childExitObserved = true;
    });
    const closedPromise = new Promise<void>((resolve) => {
      child.on("close", (code, exit) => {
        closed = true;
        exitCode = code;
        exitSignal = exit;
        closeResolve?.();
        resolve();
      });
    });
    const timer = setTimeout(() => requestStop("timeout"), this.dispatchWallMs);
    const onAbort = (): void => requestStop("abort_signal");
    signal?.addEventListener("abort", onAbort, { once: true });

    onSpawned();

    // The host must see a validated, registered watchdog before the trusted
    // launcher is allowed to exec the untrusted interpreter. A timeout, EOF,
    // malformed record, identity/config mismatch or host-record fault means
    // no acknowledgement and no untrusted execution.
    const handshakeDeadline = Date.now() + Math.max(1000, Math.min(5000, this.dispatchWallMs));
    while (armed === null && !closed && stopReason === null && handshakeError === null
      && Date.now() < handshakeDeadline) {
      await delay(5);
    }
    if (armed === null && handshakeError === null) {
      handshakeError = closed
        ? "launcher exited before the armed handshake"
        : stopReason !== null
          ? `armed handshake ended because ${stopReason}`
          : "armed handshake timed out";
    }
    // The watchdog record is assigned from the control callback. Keep an
    // explicitly typed snapshot so control-flow narrowing of the closure
    // variable cannot erase the actual runtime state.
    const observedArmed = armed as unknown as WatchdogArmedFacts | null;
    if (observedArmed !== null) {
      const runningWatchdog = watchdogSnapshot(observedArmed, controlEvents);
      try {
        this.recordWriter(recordPath, {
          ...baseRecord,
          phase: "running",
          process: { pid, pgid, detachedSessionLeader: true, startedAt: this.now(), watchdog: runningWatchdog },
          watchdog: runningWatchdog,
        });
      } catch (error) {
        hostRecordError = `host record write failed after spawn: ${errorMessage(error)}`;
        if (!stopReason) requestStop("host_record_failure");
      }
    }
    if (observedArmed !== null && !closed && stopReason === null && controlError === null && hostRecordError === null) {
      ackAttempted = true;
      const acknowledgement = `${JSON.stringify({
        type: "ack",
        protocol: WATCHDOG_PROTOCOL,
        configToken,
        scriptPid: pid,
        supervisorPid: process.pid,
      })}\n`;
      ackSent = await new Promise<boolean>((resolve) => {
        if (!ackStream) {
          handshakeError = "acknowledgement channel is unavailable";
          resolve(false);
          return;
        }
        let settled = false;
        let ackTimer: ReturnType<typeof setTimeout>;
        const finish = (ok: boolean, error?: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(ackTimer);
          if (error !== undefined) handshakeError = error;
          resolve(ok);
        };
        ackTimer = setTimeout(() => finish(false, "acknowledgement write timed out"), 1000);
        try {
          ackStream.write(acknowledgement, (error?: Error | null) => {
            if (error) finish(false, `acknowledgement write failed: ${errorMessage(error)}`);
            else finish(true);
          });
        } catch (error) {
          finish(false, `acknowledgement write failed: ${errorMessage(error)}`);
        }
      });
      if (ackSent) {
        try { ackStream?.end(); } catch { /* channel already closing */ }
      } else if (!stopReason) {
        requestStop("watchdog_handshake_failed");
      }
    } else if (observedArmed !== null && !closed && !stopReason && !ackSent) {
      requestStop(hostRecordError !== null ? "host_record_failure" : "watchdog_handshake_failed");
    }
    if (observedArmed === null && !closed && !stopReason) {
      requestStop("watchdog_handshake_failed");
    }
    if (!ackSent) {
      try { ackStream?.destroy(); } catch { /* channel already closed */ }
    }

    try {
      await closedPromise;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (termination) await termination;
      else if (groupAlive(pgid)) {
        // The direct child exited but a left-over group member must not be
        // reported as verified gone. This prototype denies fork, so this is a
        // fail-closed diagnostic rather than an expected descendant tree.
        requestStop("host_record_failure");
        await termination;
      }
    }
    const groupCheckStart = Date.now();
    while (groupAlive(pgid) && Date.now() - groupCheckStart < 2000) await delay(10);
    groupCheckMs = Date.now() - groupCheckStart;
    const groupGone = !groupAlive(pgid);

    // Normal completion requires both the actual script group gone and the
    // watchdog process gone. Control EOF alone only proves its writer closed;
    // it is not a process-exit proof. The watchdog keeps the writer open until
    // just before exit, so EOF plus a bounded known-PID check are combined.
    let pidGone: boolean | null = null;
    if (observedArmed === null) {
      const settleDeadline = Date.now() + 500;
      while (!controlEnded && Date.now() < settleDeadline) await delay(10);
    } else {
      if (!controlEnded) {
        const settleDeadline = Date.now() + WATCHDOG_SETTLE_MS;
        while (!controlEnded && Date.now() < settleDeadline) await delay(10);
        if (!controlEnded && pidAlive(observedArmed.watchdogPid)) {
          // The control writer is still open, so this known PID is the
          // watchdog rather than a reused unrelated process. Kill it to avoid
          // leaking a watchdog when the host must return.
          watchdogKilledByHost = true;
          try { process.kill(observedArmed.watchdogPid, "SIGKILL"); } catch { /* already gone */ }
          const killDeadline = Date.now() + 500;
          while (!controlEnded && Date.now() < killDeadline) await delay(10);
        }
      }
      const pidDeadline = Date.now() + WATCHDOG_SETTLE_MS;
      while (pidAlive(observedArmed.watchdogPid) && Date.now() < pidDeadline) await delay(10);
      pidGone = !pidAlive(observedArmed.watchdogPid);
      if (pidGone && !controlEnded) {
        const controlDeadline = Date.now() + 500;
        while (!controlEnded && Date.now() < controlDeadline) await delay(10);
      }
      if (!controlEnded && controlError === null) {
        controlError = "watchdog did not close its control stream";
      }
    }
    if (observedArmed !== null && controlEnded && !watchdogExitObserved && !watchdogKilledByHost) {
      unexpectedControlEof = true;
    }
    if (!controlEnded) {
      try { controlStream?.destroy(); } catch { /* channel already closed */ }
    }
    if (controlLossTask) await controlLossTask;
    const watchdog: WatchdogOutcome = {
      protocol: WATCHDOG_PROTOCOL,
      armed: observedArmed !== null,
      watchdogPid: observedArmed?.watchdogPid ?? null,
      watchdogSid: observedArmed?.watchdogSid ?? null,
      scriptPid: observedArmed?.scriptPid ?? null,
      supervisorPid: process.pid,
      deadlineBasis: observedArmed?.deadlineBasis ?? null,
      durationMs: observedArmed?.durationMs ?? this.dispatchWallMs,
      graceMs: observedArmed?.graceMs ?? this.terminationGraceMs,
      armedAtMonotonic: observedArmed?.armedAtMonotonic ?? null,
      deadlineMonotonic: observedArmed?.deadlineMonotonic ?? null,
      handshakeMs,
      handshakeError,
      ackAttempted,
      ackSent,
      triggerReason,
      termSent,
      killSent,
      watchdogExitObserved,
      watchdogExitConfirmed,
      childExitObserved,
      controlEnded,
      controlError: controlError ?? (observedArmed === null ? handshakeError : null),
      unexpectedControlEof,
      controlEventLimit: WATCHDOG_CONTROL_MAX_EVENTS,
      controlEventsRejected,
      controlStreamBytes: parser.totalBytes,
      controlBytesDiscarded: parser.discardedBytes,
      controlEvents: controlEvents.slice(-WATCHDOG_CONTROL_MAX_EVENTS),
      logRef: watchdogLogRef,
      logAvailable: existsSync(prepared.watchdogLogPath),
      pidGone,
      watchdogTerminated: observedArmed === null ? null : pidGone === true,
      watchdogKilledByHost,
      pidReuseCaveat: "numeric process-group/PID checks are bounded local facts; PID reuse is not proven and unrelated PIDs are never inspected",
    };
    // Acknowledging the armed record does not prove that the interpreter
    // started, so launchStage stays unknown after ACK. Actual wrapper exit,
    // signal, output and artifacts remain observed execution facts; only 111
    // without host termination keeps the A1 ambiguity error.
    const launchStage: LaunchStage = observedArmed === null
      ? "handshake_failed"
      : !ackSent
        ? (ackAttempted ? "unknown" : "handshake_failed")
        : "unknown";
    const durationMs = Date.now() - startedAt;
    const decodedOutput = decodeCapturedOutput(Buffer.concat(chunks), truncated);
    const logText = decodedOutput.text;
    safeAudit(this.audit, {
      type: "execution_process_settled",
      runId: prepared.runId,
      pid,
      pgid,
      runtime,
      runtimeVersion: runtimeInfo.version,
      exitCode,
      signal: exitSignal,
      stopReason,
      groupGone,
      durationMs,
      observedBytes,
      retainedBytes,
      truncated,
      hostRecordError,
      watchdogArmed: watchdog.armed,
      watchdogPid: watchdog.watchdogPid,
      watchdogTerminated: watchdog.watchdogTerminated,
      watchdogTriggerReason: watchdog.triggerReason,
      watchdogControlError: watchdog.controlError,
      launchStage,
    });
    return {
      spawned: true,
      spawnError,
      pid,
      pgid,
      exitCode,
      signal: exitSignal,
      durationMs,
      observedBytes,
      retainedBytes,
      decodedTextBytes: decodedOutput.decodedTextBytes,
      droppedIncompleteBytes: decodedOutput.droppedIncompleteBytes,
      invalidEncoding: decodedOutput.invalidEncoding,
      truncated,
      observedAfterRetentionBytes: observedAfterRetention,
      logText,
      stopReason,
      terminatedByHost,
      groupGone,
      groupCheckMs,
      launchStage,
      hostRecordError,
      childExitObserved,
      watchdog,
    };
  }

  private async exportArtifacts(runId: string, prepared: PreparedRun): Promise<{
    artifacts: ArtifactRecord[];
    rejections: ArtifactRejection[];
    artifactTotalBytes: number;
    stoppedAtLimit: boolean;
  }> {
    const artifacts: ArtifactRecord[] = [];
    const rejections: ArtifactRejection[] = [];
    let total = 0;
    let stoppedAtLimit = false;
    // Bounded, non-recursive scan. Only ordinary files directly in the
    // writable work root are candidates; directories are never traversed, so
    // neither a deep tree nor an empty-directory flood can consume host work.
    const directory = await opendir(prepared.workRoot);
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_SCAN_ENTRIES) {
          stoppedAtLimit = true;
          rejections.push({ relativePath: ".", reason: `directory entry limit ${MAX_SCAN_ENTRIES} exceeded` });
          break;
        }
        const childRelative = entry.name;
        if (childRelative === "tmp") continue;
        if (entry.isDirectory()) {
          rejections.push({ relativePath: childRelative, reason: "subdirectories are not exported" });
          continue;
        }
        const absolutePath = path.join(prepared.workRoot, childRelative);
        if (path.dirname(absolutePath) !== prepared.workRoot) {
          rejections.push({ relativePath: childRelative, reason: "path escaped the writable work root" });
          continue;
        }
        if (entry.isSymbolicLink()) {
          rejections.push({ relativePath: childRelative, reason: "symbolic link" });
          continue;
        }
        if (artifacts.length >= EXECUTION_LIMITS.maxArtifacts) {
          stoppedAtLimit = true;
          rejections.push({ relativePath: childRelative, reason: "artifact count limit" });
          continue;
        }
        if (total >= EXECUTION_LIMITS.maxArtifactTotalBytes) {
          stoppedAtLimit = true;
          rejections.push({ relativePath: childRelative, reason: "artifact total byte limit" });
          continue;
        }
        let info;
        try {
          info = await lstat(absolutePath);
        } catch (error) {
          rejections.push({ relativePath: childRelative, reason: `stat failed: ${errorMessage(error)}` });
          continue;
        }
        if (info.isSymbolicLink()) {
          rejections.push({ relativePath: childRelative, reason: "symbolic link" });
          continue;
        }
        if (!info.isFile()) {
          rejections.push({ relativePath: childRelative, reason: "FIFO, device or other non-ordinary file" });
          continue;
        }
        if (info.nlink !== 1) {
          rejections.push({ relativePath: childRelative, reason: "multiple hard links" });
          continue;
        }
        const remaining = EXECUTION_LIMITS.maxArtifactTotalBytes - total;
        if (info.size > remaining) {
          // Reject from metadata before any potentially blocking read.
          stoppedAtLimit = true;
          rejections.push({ relativePath: childRelative, reason: "artifact total byte limit" });
          continue;
        }
        let bytes: Buffer;
        try {
          const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1
              || opened.dev !== info.dev || opened.ino !== info.ino
              || opened.size !== info.size) {
              rejections.push({ relativePath: childRelative, reason: "file identity changed before open" });
              continue;
            }
            if (opened.size > EXECUTION_LIMITS.maxFileSizeBytes) {
              stoppedAtLimit = true;
              rejections.push({ relativePath: childRelative, reason: "per-artifact byte limit" });
              continue;
            }
            bytes = await handle.readFile();
          } finally {
            await handle.close();
          }
        } catch (error) {
          rejections.push({ relativePath: childRelative, reason: `open/read failed: ${errorMessage(error)}` });
          continue;
        }
        if (bytes.length !== info.size || total + bytes.length > EXECUTION_LIMITS.maxArtifactTotalBytes) {
          rejections.push({ relativePath: childRelative, reason: "file changed during export" });
          continue;
        }
        const artifactId = `artifact-${artifacts.length + 1}`;
        const archivePath = path.join(prepared.artifactRoot, `${artifactId}.bin`);
        await writeFile(archivePath, bytes, { flag: "wx", mode: 0o400 });
        const archived = await readFile(archivePath);
        const sha256 = digest(bytes);
        const verified = digest(archived) === sha256 && archived.length === bytes.length;
        if (!verified) {
          rejections.push({ relativePath: childRelative, reason: "archived copy failed hash verification" });
          continue;
        }
        total += bytes.length;
        artifacts.push({
          artifactId,
          relativePath: childRelative,
          bytes: bytes.length,
          sha256,
          archiveRef: `${path.basename(prepared.runRoot)}/artifacts/${artifactId}.bin`,
          verified,
        });
      }
    } finally {
      // The async iterator already closes the directory on completion, break
      // or throw; a second close would turn a successful run into ERR_DIR_CLOSED.
    }
    safeAudit(this.audit, {
      type: "execution_artifacts_exported",
      runId,
      artifacts: artifacts.length,
      rejected: rejections.length,
      bytes: total,
      stoppedAtLimit,
    });
    return { artifacts, rejections, artifactTotalBytes: total, stoppedAtLimit };
  }

}

export { errorResult as executionErrorResult };
