import {
  clonePlain,
  compactExcerpt,
  deepFreeze,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_FILES,
  MAX_OUTPUT_TOTAL_BYTES,
  NATIVE_WORK_INTERFACE,
  NATIVE_WORK_TOOL,
  NativeFileError,
  nodeFileIo,
  observeWorkspaceFile,
  sha256Hex,
  validateRelativePath,
  type NativeFileIo,
  type NativeObservedFile,
} from "./native-work.ts";
import { canonicalWorkspaceRoot, currentTaskOwner } from "./task-entry-port.ts";
import {
  boundNativeInstanceReportCatalog,
  readNativeInstanceReportSelection,
  snapshotNativeInstanceReportFacts,
  unavailableNativeInstanceReportCatalog,
  type NativeInstanceReportCatalog,
  type NativeInstanceReportCheck,
  type NativeInstanceReportFacts,
  type NativeInstanceReportPort,
  type NativeInstanceReportPreparation,
  type NativeInstanceReportPrepareResult,
  type NativeInstanceReportSelection,
  type NativeReportWorkIdentity,
} from "./native-instance-report.ts";

/**
 * Explicitly loaded alternative entry for ordinary OMP-native work.
 *
 * This is deliberately not a managed task owner, planner, permission system or
 * persistence layer. It observes the main session's actual prompt/tool events
 * in bounded memory and lets the model record or inspect non-authoritative
 * per-request work facts. Native tool execution and authorization are left
 * untouched.
 */

export const NATIVE_ENTRY_VERSION = "0.1.0-native-pilot.1";

const DEFAULT_REMINDER_DEADLINE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RETAINED_WORKS = 5;
const DEFAULT_MAX_CALLS_PER_WORK = 64;
const DEFAULT_MAX_PENDING_INPUTS = 8;
const DEFAULT_MAX_REPORT_BINDINGS = 16;
const DEFAULT_MAX_REMEMBERED_CALL_IDS = 1024;
const MAX_CHECK_SELECTIONS = 24;
const MAX_SUMMARY_CHARS = 2000;
const MAX_LIMITATION_CHARS = 500;
const MAX_LIMITATIONS = 8;
const MAX_PURPOSE_CHARS = 500;
const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_REQUEST_EXCERPT_CHARS = 240;
const MAX_RESULT_EXCERPT_CHARS = 1000;

export const NATIVE_WORK_GUIDANCE = [
  "Work in the ordinary OMP native loop: understand the goal and constraints, choose methods, inspect relevant inputs, execute, actually check the result, and repair or report limits.",
  "The explicitly loaded agent_work tool records only non-authoritative per-request observations in this main session; it is not the managed TaskOwner, permission, acceptance, verification, or a replacement task system.",
  "If you use agent_work report, select only real completed tool calls from that same work, state a model-declared outcome and limitations, and distinguish observed result facts from unverified coverage. Never describe a report as accepted or globally verified. When associating one observed native instance result, copy its instanceId, parentToolCallId and envelopeSha256 from agent_work inspect into the optional instanceResult selector and include that task call in checks; outputFiles remain bytes observed during this report, not semantic acceptance.",
  "Native tools and OMP authorization are unchanged; perform proportional actual checks when supported, and otherwise report unverified or blocked outcomes plainly rather than claiming a pass.",
  "For tasks restricted to supplied evidence, separate facts and derivations the sources support from assumptions and recommendations, and treat missing information as unknown instead of adding an unrequested alternative premise. Check the final artifact and final reply against the original sources and the requested constraints, including scope and length, not just a self-written checker or keyword presence, then report remaining uncertainty honestly.",
  "This does not forbid explicitly requested hypothetical exploration, labeled as such, or proportionate curiosity in other tasks.",
].join(" ");

const NATIVE_STOP_REMINDER = [
  "Before finishing this request, either use agent_work report with real completed toolCallIds from this same work and an honest outcome/limitations, or state plainly what was not completed or checked.",
  "Do not claim verification, acceptance, or coverage beyond this plugin's observed tool results.",
  "This is a one-time advisory reminder; native tools and OMP authorization are unchanged.",
].join(" ");

/** Narrow host surface. Real OMP supplies this; no runtime is imported here. */
export interface NativeSessionManager {
  getSessionId(): string;
  /** Live session directory; /move changes this without a navigation event. */
  getCwd(): string;
}

export interface NativeContext {
  cwd: string;
  agent?: { kind?: "main" | "sub" } | null;
  sessionManager?: NativeSessionManager | null;
}

export interface NativeToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface NativeTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: "read" | "write" | "exec";
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: NativeContext,
  ): Promise<NativeToolResult>;
}

export interface NativeOmpApi {
  on(event: string, handler: (event: unknown, context: NativeContext) => unknown): void;
  registerTool(tool: NativeTool): void;
}

export interface NativeEntryOptions {
  now?: () => number;
  fileIo?: NativeFileIo;
  reminderDeadlineMs?: number;
  maxRetainedWorks?: number;
  maxCallsPerWork?: number;
  maxPendingInputs?: number;
  maxReportBindings?: number;
  maxRememberedCallIds?: number;
  /** INTERNAL trusted composition only; supplied once by the instanced entry. */
  instanceReports?: NativeInstanceReportPort;
}

export const NATIVE_WORK_CALL_INSPECTION_SCHEMA = "omp-agent.native-work-call-inspection.v1";

export interface NativeWorkCallSelector {
  readonly toolCallId: string;
  readonly toolName: string;
}

/** Primitive-only association copy; never contains Work, ObservedCall or context. */
export interface NativeWorkCallReference {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export type NativeWorkCallState = "current" | "suspended" | "ended" | "stale" | "unavailable";

export type NativeWorkCallReason =
  | "current-work"
  | "work-ended"
  | "pending-input"
  | "unknown-input-source"
  | "input-history-truncated"
  | "work-replaced"
  | "work-invalidated"
  | "work-not-retained"
  | "call-not-retained"
  | "call-rebound"
  | "call-conflicted"
  | "live-session-changed"
  | "live-workspace-changed"
  | "invalid-selector"
  | "foreign-reference"
  | "entry-disabled"
  | "entry-disposed"
  | "managed-owner-present"
  | "not-main-context"
  | "live-identity-unavailable"
  | "call-not-observed"
  | "binding-inconsistent"
  | "work-evidence-unavailable"
  | "call-evidence-unknown";

export interface NativeWorkCallInspection {
  readonly schema: typeof NATIVE_WORK_CALL_INSPECTION_SCHEMA;
  readonly authority: "non-authoritative";
  readonly state: NativeWorkCallState;
  readonly reason: NativeWorkCallReason;
  readonly association: NativeWorkCallReference | null;
  readonly workPhase: "active" | "ended" | "unknown" | null;
  readonly requestAttribution: RequestAttribution | null;
  readonly evidenceState: "available" | "unknown-source" | "unavailable" | null;
  readonly callResultState: "preflight" | "observed" | "unknown" | null;
  readonly pendingInputCount: number | null;
  readonly pendingInputsDropped: number | null;
}

export type NativeWorkCallCapture =
  | {
      readonly ok: true;
      readonly ref: NativeWorkCallReference;
      readonly inspection: NativeWorkCallInspection;
    }
  | {
      readonly ok: false;
      readonly ref: null;
      readonly inspection: NativeWorkCallInspection;
    };

export interface NativeEntryControls {
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  isEnabled(): boolean;
  dispose(): void;
  captureCall(selector: NativeWorkCallSelector, context: NativeContext): NativeWorkCallCapture;
  inspectCall(ref: unknown, context: NativeContext): NativeWorkCallInspection;
}

type WorkStatus = "active" | "ended" | "unknown";
export type RequestAttribution = "matched-user-input" | "unknown" | "unavailable";
type EvidenceState = "available" | "unknown-source" | "unavailable";
export type ReportOutcome = "completed" | "insufficient" | "blocked";
type ResultState = "preflight" | "observed" | "unknown";

interface InputEventLike {
  type: "input";
  text: string;
  source?: string;
}

interface BeforeAgentStartLike {
  type: "before_agent_start";
  reason: "prompt" | "revive";
  prompt: string;
  systemPrompt?: readonly string[];
}

interface ToolCallLike {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolResultLike {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  content: unknown;
  isError: unknown;
  details: unknown;
}

interface AgentEndLike {
  type: "agent_end";
  willContinue?: boolean;
  awaitingAsyncWork?: boolean;
}

interface SessionStopLike {
  type: "session_stop";
  signal?: AbortSignal;
  stop_hook_active?: boolean;
}

interface PendingInput {
  digest: string;
  excerpt: string;
  excerptTruncated: boolean;
  genuine: boolean;
  source: string;
  sessionId: string | null;
  workspaceRoot: string | null;
  at: number;
}

interface ObservedResult {
  observationScope: "plugin-tool-result-after-middleware";
  isErrorObserved: boolean;
  textExcerpt: string;
  textTruncated: boolean;
  textBlocks: number;
  imageBlocks: number;
  detailsPresent: boolean;
  exitCodeFromToolDetails: number | null;
  observedAt: number;
}

interface ObservedCall {
  toolCallId: string;
  toolName: string;
  preflightAt: number;
  /** Digest of canonical preflight input; null means a repeat cannot be proven identical. */
  preflightDigest: string | null;
  resultState: ResultState;
  result: ObservedResult | null;
  unknownReason: string | null;
  associationConflict: boolean;
}

interface Work {
  observationId: string;
  generation: number;
  sessionId: string | null;
  workspaceRoot: string | null;
  promptDigest: string;
  status: WorkStatus;
  requestAttribution: RequestAttribution;
  requestExcerpt: string | null;
  requestExcerptTruncated: boolean;
  evidenceState: EvidenceState;
  evidenceUnavailableReason: string | null;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  calls: ObservedCall[];
  callIndex: Map<string, ObservedCall>;
  callsDropped: number;
  report: NativeWorkReport | null;
  reportSignature: string | null;
  reminderUsed: boolean;
  reminderDeadline: number;
  invalidated: boolean;
}

interface ReportBinding {
  toolCallId: string;
  work: Work;
  call: ObservedCall;
  sessionId: string | null;
  workspaceRoot: string | null;
  unavailableReason: string | null;
}

/**
 * The entry's own one-shot stop advisory, not a request or permission. It
 * exists only so the host's preparation of that exact issued text does not
 * manufacture a second overlapping work generation.
 */
interface AdvisoryContinuation {
  work: Work;
  reminderText: string;
  sessionId: string | null;
  workspaceRoot: string | null;
  issuedAt: number;
}

interface EntryState {
  enabled: boolean;
  disabledReason: string | null;
  disposed: boolean;
  works: Work[];
  current: Work | null;
  worksDropped: number;
  pending: PendingInput[];
  pendingDropped: number;
  advisory: AdvisoryContinuation | null;
  callBindings: Map<string, { work: Work; call: ObservedCall }>;
  reportBindings: Map<string, ReportBinding>;
  /** Bounded global uniqueness memory for evidence call ids, including dropped calls/works. */
  callIdMemory: Map<string, number>;
  callIdMemorySaturated: boolean;
  nextGeneration: number;
  now: () => number;
  fileIo: NativeFileIo;
  reminderDeadlineMs: number;
  maxRetainedWorks: number;
  maxCallsPerWork: number;
  maxPendingInputs: number;
  maxReportBindings: number;
  maxRememberedCallIds: number;
  instanceReports: NativeInstanceReportPort | null;
}

export interface NativeWorkCheckReport {
  toolCallId: string;
  toolName: string;
  purpose: string;
  observationScope: "plugin-tool-result-after-middleware";
  isErrorObserved: boolean;
  exitCodeFromToolDetails: number | null;
  resultExcerpt: string;
  resultTruncated: boolean;
  observedAt: number;
}

export interface NativeWorkReport {
  kind: "native-work-report";
  interface: string;
  authority: "non-authoritative";
  work: {
    observationId: string;
    generation: number;
    sessionId: string;
    workspaceRoot: string;
    statusAtReport: "active" | "ended";
    request: {
      attribution: RequestAttribution;
      excerpt: string | null;
      excerptTruncated: boolean;
      note: string;
    };
  };
  modelDeclared: {
    outcome: ReportOutcome;
    summary: string | null;
    limitations: string[];
  };
  observed: {
    checks: NativeWorkCheckReport[];
    coverage: {
      selected: number;
      observedResults: number;
      observedErrorResults: number;
      callsInWorkWithoutObservedResult: number;
      callsDroppedFromWork: number;
      unverified: string[];
    };
    outputFiles: Array<{
      relativePath: string;
      bytes: number;
      sha256: string;
      observedAt: number;
      note: string;
    }>;
  };
  recordedAt: number;
  caveats: string[];
  /** Present only when this report explicitly selected one C1-observed result. */
  instanceResult?: NativeInstanceReportFacts;
}

interface ReportCheckArgument {
  toolCallId: string;
  purpose: string;
}

/** Immutable per-selection snapshot revalidated after every await. */
interface SelectedCheck {
  call: ObservedCall;
  result: ObservedResult;
  purpose: string;
}

type ParsedArguments =
  | { action: "inspect" }
  | {
      action: "report";
      checks: ReportCheckArgument[];
      outputFiles: string[];
      outcome: ReportOutcome;
      summary: string | null;
      limitations: string[];
      instanceResult?: NativeInstanceReportSelection;
    };

type ReportArguments = Extract<ParsedArguments, { action: "report" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Canonical, deterministic digest for comparing repeated preflight inputs. */
function canonicalInputDigest(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, (_key: string, item: unknown) => {
      if (!isRecord(item)) return item;
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    });
    return typeof serialized === "string" ? sha256Hex(serialized) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

type ActualAbortRead =
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Brand-check and read one actual host AbortSignal through the captured native
 * prototype getter. This never invokes an own `aborted` getter, so a duck or
 * proxy cannot masquerade as the host's abort state.
 */
function readActualAbortSignal(signal: unknown): ActualAbortRead {
  if (signal === undefined || signal === null) {
    return { ok: false, reason: "the actual host AbortSignal is missing" };
  }
  if (ACTUAL_ABORTED_GETTER === null) {
    return { ok: false, reason: "the host AbortSignal aborted getter is unavailable" };
  }
  try {
    const aborted: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    if (typeof aborted !== "boolean") {
      return { ok: false, reason: "the host AbortSignal aborted state is unreadable" };
    }
    return { ok: true, aborted };
  } catch {
    return { ok: false, reason: "the supplied signal is not a readable actual host AbortSignal" };
  }
}

function safeErrorText(value: unknown): string {
  try {
    if (value instanceof Error) {
      try {
        if (typeof value.message === "string") return value.message;
      } catch {
        // Fall through to a bounded generic form.
      }
      return "Error";
    }
  } catch {
    return "unreadable failure";
  }
  try {
    return String(value);
  } catch {
    return "unreadable failure";
  }
}

function boundPortReason(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : safeErrorText(value);
  const normalized = text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 317)}...`;
}

type PlainResponseFailure = "thenable" | "accessor" | "shape";

type PlainResponseRead =
  | { readonly ok: true; readonly fields: ReadonlyMap<string, unknown> }
  | { readonly ok: false; readonly failure: PlainResponseFailure };

const PREPARE_RESPONSE_KEYS = ["ok", "prepared", "reason"] as const;
const PREPARED_RESPONSE_KEYS = ["facts", "refresh", "revalidate"] as const;
const REFRESH_RESPONSE_KEYS = ["ok", "reason"] as const;

/**
 * Read one strict plain-data response shape. No accessor or `then` getter is
 * invoked: both are detected through own-property descriptors on the value and
 * its one allowed prototype. Only own data properties from the fixed key set
 * are read.
 */
function readPlainResponse(
  value: unknown,
  allowedKeys: readonly string[],
): PlainResponseRead {
  try {
    // isRecord/Array.isArray can throw on a revoked or hostile proxy.
    if (!isRecord(value)) return { ok: false, failure: "shape" };
    // Only a plain object is accepted. Checking that boundary first bounds the
    // `then` inspection to this value and Object.prototype; a proxy cannot make
    // the check walk an arbitrary or self-referential prototype chain.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, failure: "shape" };
    }
    if (Object.getOwnPropertyDescriptor(value, "then") !== undefined) {
      return { ok: false, failure: "thenable" };
    }
    if (prototype !== null
      && Object.getOwnPropertyDescriptor(prototype, "then") !== undefined) {
      return { ok: false, failure: "thenable" };
    }
    const fields = new Map<string, unknown>();
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!allowedKeys.includes(key)) return { ok: false, failure: "shape" };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) return { ok: false, failure: "shape" };
      if (!("value" in descriptor)) return { ok: false, failure: "accessor" };
      fields.set(key, descriptor.value);
    }
    return { ok: true, fields };
  } catch {
    return { ok: false, failure: "shape" };
  }
}

function plainResponseReason(
  failure: PlainResponseFailure,
  label: string,
  fallback: string,
): string {
  if (failure === "thenable") {
    return `${label} returned a thenable; synchronous plain data is required`;
  }
  if (failure === "accessor") {
    return `${label} returned an accessor property; synchronous plain data is required`;
  }
  return fallback;
}

const NATIVE_PROMISE_THEN = Promise.prototype.then;

/**
 * Detect a native Promise by brand-calling the captured Promise.prototype.then.
 * This also consumes a rejection without reading an arbitrary `then` getter or
 * awaiting any callback result. A non-Promise or thenable returns false.
 */
function consumeNativePromise(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

type PreparedPortSuccess = {
  readonly ok: true;
  readonly facts: NativeInstanceReportFacts;
  readonly refresh: () => NativeInstanceReportCheck;
  readonly revalidate: () => string | null;
};
type PortInvocationFailure = { readonly ok: false; readonly reason: string };

function invokePreparedRefresh(
  check: () => NativeInstanceReportCheck,
): NativeInstanceReportCheck {
  let raw: unknown;
  try {
    raw = check();
  } catch (error) {
    return { ok: false, reason: `instance result refresh threw: ${boundPortReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "instance result refresh returned a promise; a synchronous check is required" };
  }
  const response = readPlainResponse(raw, REFRESH_RESPONSE_KEYS);
  if (!response.ok) {
    return {
      ok: false,
      reason: plainResponseReason(
        response.failure,
        "instance result refresh",
        "instance result refresh returned an unreadable check",
      ),
    };
  }
  const ok = response.fields.get("ok");
  if (ok === true) return { ok: true };
  if (ok === false) {
    const reason = response.fields.get("reason");
    return {
      ok: false,
      reason: typeof reason === "string" && reason.length > 0
        ? boundPortReason(reason, "instance result check failed")
        : "instance result check failed without a readable reason",
    };
  }
  return { ok: false, reason: "instance result refresh returned an unknown check result" };
}

/**
 * Final revalidation is primitive-only: null succeeds, a string refuses, and
 * any other return is refused without reading properties or `.then` except the
 * captured native Promise brand consumed above to avoid an unhandled rejection.
 */
function invokeFinalRevalidate(check: () => string | null): NativeInstanceReportCheck {
  let raw: unknown;
  try {
    raw = check();
  } catch (error) {
    return { ok: false, reason: `instance result revalidate threw: ${boundPortReason(error, "unreadable failure")}` };
  }
  if (raw === null) return { ok: true };
  if (typeof raw === "string") {
    return { ok: false, reason: boundPortReason(raw, "instance result revalidate refused") };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "instance result revalidate returned a promise; a synchronous primitive result is required" };
  }
  return { ok: false, reason: "instance result revalidate returned a non-primitive final check" };
}

/**
 * Call the internal port once and copy all callbacks before any file I/O. The
 * returned closures hold the original preparation object; no property lookup
 * on it happens during the final publication stage.
 */
function prepareReportInstance(
  port: NativeInstanceReportPort,
  selection: NativeInstanceReportSelection,
  work: NativeReportWorkIdentity,
  context: NativeContext,
): PreparedPortSuccess | PortInvocationFailure {
  let raw: unknown;
  try {
    raw = port.prepare(selection, work, context);
  } catch (error) {
    return {
      ok: false,
      reason: `instance result preparation threw: ${boundPortReason(error, "unreadable failure")}`,
    };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "instance result preparation returned a promise; synchronous preparation is required" };
  }
  const response = readPlainResponse(raw, PREPARE_RESPONSE_KEYS);
  if (!response.ok) {
    return {
      ok: false,
      reason: plainResponseReason(
        response.failure,
        "instance result preparation",
        "instance result preparation returned an unreadable result",
      ),
    };
  }
  const ok = response.fields.get("ok");
  if (ok === false) {
    const reason = response.fields.get("reason");
    return {
      ok: false,
      reason: typeof reason === "string" && reason.length > 0
        ? boundPortReason(reason, "instance result is unavailable")
        : "instance result is unavailable without a readable reason",
    };
  }
  if (ok !== true) {
    return { ok: false, reason: "instance result preparation returned an unknown result" };
  }
  const preparedValue = response.fields.get("prepared");
  if (consumeNativePromise(preparedValue)) {
    return { ok: false, reason: "instance result preparation object is a promise; synchronous preparation is required" };
  }
  const prepared = readPlainResponse(preparedValue, PREPARED_RESPONSE_KEYS);
  if (!prepared.ok) {
    return {
      ok: false,
      reason: plainResponseReason(
        prepared.failure,
        "instance result preparation object",
        "instance result preparation returned no readable preparation object",
      ),
    };
  }
  // Read facts and both methods exactly once, before any later I/O.
  const factsValue = prepared.fields.get("facts");
  const refreshValue = prepared.fields.get("refresh");
  const revalidateValue = prepared.fields.get("revalidate");
  if (typeof refreshValue !== "function" || typeof revalidateValue !== "function") {
    return { ok: false, reason: "instance result preparation did not provide synchronous refresh and revalidate methods" };
  }
  const facts = snapshotNativeInstanceReportFacts(factsValue, selection, work);
  if (!facts.ok) return { ok: false, reason: facts.reason };
  const refresh = refreshValue as (this: unknown, context: NativeContext) => NativeInstanceReportCheck;
  const revalidate = revalidateValue as (this: unknown) => string | null;
  return {
    ok: true,
    facts: facts.facts,
    refresh: () => Reflect.apply(refresh, preparedValue, [context]) as NativeInstanceReportCheck,
    revalidate: () => Reflect.apply(revalidate, preparedValue, []) as string | null,
  };
}

function inspectReportInstances(
  port: NativeInstanceReportPort | null,
  context: NativeContext,
  work: NativeReportWorkIdentity | null,
): NativeInstanceReportCatalog {
  if (port === null) {
    return unavailableNativeInstanceReportCatalog("instance result composition is not configured");
  }
  let raw: unknown;
  try {
    raw = port.inspect(context, work);
  } catch (error) {
    return unavailableNativeInstanceReportCatalog(
      `instance result inspection threw: ${boundPortReason(error, "unreadable failure")}`,
    );
  }
  if (consumeNativePromise(raw)) {
    return unavailableNativeInstanceReportCatalog("instance result inspection returned a promise; synchronous inspection is required");
  }
  return boundNativeInstanceReportCatalog(raw);
}

function readSessionId(context: NativeContext): string | null {
  try {
    const value = context.sessionManager?.getSessionId();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readWorkspace(context: NativeContext): string | null {
  try {
    // ctx.cwd may be a construction-time snapshot. The session manager's
    // getCwd is the live session identity that /move updates.
    const value = context.sessionManager?.getCwd();
    return typeof value === "string" && value.length > 0 ? canonicalWorkspaceRoot(value) : null;
  } catch {
    return null;
  }
}

function readMain(context: NativeContext): boolean {
  return context.agent?.kind === "main";
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function errorResult(message: string): NativeToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      kind: "native-work-error",
      interface: NATIVE_WORK_INTERFACE,
      authority: "non-authoritative",
      error: message,
    },
  };
}

function successResult(details: unknown, message: string): NativeToolResult {
  return {
    content: [{ type: "text", text: `${message}\n${JSON.stringify(details)}` }],
    details,
  };
}

function parseArguments(value: unknown): ParsedArguments {
  if (!isRecord(value)) throw new Error("agent_work arguments must be an object.");
  const keys = Object.keys(value);
  if (value.action === "inspect") {
    const unknown = keys.filter((key) => key !== "action");
    if (unknown.length > 0) throw new Error(`agent_work inspect has unsupported field(s): ${unknown.join(", ")}.`);
    return { action: "inspect" };
  }
  if (value.action !== "report") throw new Error("agent_work action must be inspect or report.");

  const allowed = new Set([
    "action",
    "checks",
    "outputFiles",
    "outcome",
    "summary",
    "limitations",
    "instanceResult",
  ]);
  const unsupported = keys.filter((key) => !allowed.has(key));
  if (unsupported.length > 0) throw new Error(`agent_work report has unsupported field(s): ${unsupported.join(", ")}.`);

  if (value.outcome !== "completed" && value.outcome !== "insufficient" && value.outcome !== "blocked") {
    throw new Error("agent_work report outcome must be completed, insufficient or blocked.");
  }
  const outcome: ReportOutcome = value.outcome;

  const rawChecks = value.checks ?? [];
  if (!Array.isArray(rawChecks) || rawChecks.length > MAX_CHECK_SELECTIONS) {
    throw new Error(`agent_work checks must be an array of at most ${MAX_CHECK_SELECTIONS} selections.`);
  }
  const seen = new Set<string>();
  const checks = rawChecks.map((item, index): ReportCheckArgument => {
    if (!isRecord(item)) throw new Error(`agent_work checks[${index}] must be an object.`);
    const itemKeys = Object.keys(item);
    const extra = itemKeys.filter((key) => key !== "toolCallId" && key !== "purpose");
    if (extra.length > 0) throw new Error(`agent_work checks[${index}] has unsupported field(s): ${extra.join(", ")}.`);
    const toolCallId = item.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length < 1 || toolCallId.length > MAX_TOOL_CALL_ID_CHARS) {
      throw new Error(`agent_work checks[${index}].toolCallId must be a non-empty observed call id.`);
    }
    if (seen.has(toolCallId)) throw new Error(`agent_work checks selects duplicate toolCallId ${JSON.stringify(toolCallId)}.`);
    seen.add(toolCallId);
    const purpose = typeof item.purpose === "string" ? item.purpose.trim() : "";
    if (purpose.length < 1 || purpose.length > MAX_PURPOSE_CHARS) {
      throw new Error(`agent_work checks[${index}].purpose must be model-declared text of 1-${MAX_PURPOSE_CHARS} characters.`);
    }
    return { toolCallId, purpose };
  });

  const rawFiles = value.outputFiles ?? [];
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_OUTPUT_FILES) {
    throw new Error(`agent_work outputFiles must be an array of at most ${MAX_OUTPUT_FILES} paths.`);
  }
  const outputFiles = rawFiles.map((item, index) => {
    try {
      return validateRelativePath(item);
    } catch (error) {
      throw new Error(`agent_work outputFiles[${index}] is refused: ${errorMessage(error)}`);
    }
  });
  if (new Set(outputFiles).size !== outputFiles.length) {
    throw new Error("agent_work outputFiles must be unique.");
  }

  const rawSummary = value.summary;
  if (rawSummary !== undefined && typeof rawSummary !== "string") throw new Error("agent_work summary must be a string.");
  if (typeof rawSummary === "string" && rawSummary.length > MAX_SUMMARY_CHARS) {
    throw new Error(`agent_work summary must be at most ${MAX_SUMMARY_CHARS} characters.`);
  }
  const summary = typeof rawSummary === "string" && rawSummary.trim().length > 0 ? rawSummary.trim() : null;

  const rawLimitations = value.limitations ?? [];
  if (!Array.isArray(rawLimitations) || rawLimitations.length > MAX_LIMITATIONS) {
    throw new Error(`agent_work limitations must be an array of at most ${MAX_LIMITATIONS} strings.`);
  }
  const limitations = rawLimitations.map((item, index) => {
    if (typeof item !== "string") throw new Error(`agent_work limitations[${index}] must be a string.`);
    const text = item.trim();
    if (text.length < 1 || text.length > MAX_LIMITATION_CHARS) {
      throw new Error(`agent_work limitations[${index}] must be 1-${MAX_LIMITATION_CHARS} characters.`);
    }
    return text;
  });

  let instanceResult: NativeInstanceReportSelection | undefined;
  if (Object.hasOwn(value, "instanceResult")) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "instanceResult");
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("agent_work instanceResult must be an own data field, not an accessor.");
    }
    const read = readNativeInstanceReportSelection(descriptor.value);
    if (!read.ok) throw new Error(`agent_work ${read.reason}`);
    instanceResult = read.selection;
  }

  return {
    action: "report",
    checks,
    outputFiles,
    outcome,
    summary,
    limitations,
    ...(instanceResult === undefined ? {} : { instanceResult }),
  };
}

function createState(options: NativeEntryOptions): EntryState {
  return {
    enabled: true,
    disabledReason: null,
    disposed: false,
    works: [],
    current: null,
    worksDropped: 0,
    pending: [],
    pendingDropped: 0,
    advisory: null,
    callBindings: new Map(),
    reportBindings: new Map(),
    callIdMemory: new Map(),
    callIdMemorySaturated: false,
    nextGeneration: 0,
    now: options.now ?? Date.now,
    fileIo: options.fileIo ?? nodeFileIo,
    reminderDeadlineMs: clampInteger(options.reminderDeadlineMs, DEFAULT_REMINDER_DEADLINE_MS, 1000, 60 * 60 * 1000),
    maxRetainedWorks: clampInteger(options.maxRetainedWorks, DEFAULT_MAX_RETAINED_WORKS, 1, 10),
    maxCallsPerWork: clampInteger(options.maxCallsPerWork, DEFAULT_MAX_CALLS_PER_WORK, 1, 128),
    maxPendingInputs: clampInteger(options.maxPendingInputs, DEFAULT_MAX_PENDING_INPUTS, 1, 32),
    maxReportBindings: clampInteger(options.maxReportBindings, DEFAULT_MAX_REPORT_BINDINGS, 4, 64),
    maxRememberedCallIds: clampInteger(options.maxRememberedCallIds, DEFAULT_MAX_REMEMBERED_CALL_IDS, 2, 8192),
    instanceReports: options.instanceReports ?? null,
  };
}

function clearWorkBindings(state: EntryState, work: Work): void {
  for (const call of work.calls) {
    const binding = state.callBindings.get(call.toolCallId);
    // A newer work may own this id now; only remove this work's own binding.
    if (binding !== undefined && binding.work === work && binding.call === call) {
      state.callBindings.delete(call.toolCallId);
    }
  }
  for (const [toolCallId, binding] of state.reportBindings) {
    if (binding.work === work) state.reportBindings.delete(toolCallId);
  }
}

function invalidateCurrent(state: EntryState, reason: string): void {
  state.advisory = null;
  const work = state.current;
  if (work !== null) {
    if (work.status === "active") {
      work.status = "unknown";
      work.endedAt = state.now();
      work.endReason = reason;
    }
    work.invalidated = true;
    work.evidenceState = "unavailable";
    work.evidenceUnavailableReason = reason;
    clearWorkBindings(state, work);
  }
  state.current = null;
  state.pending = [];
}

function invalidateAll(state: EntryState, reason: string): void {
  state.advisory = null;
  for (const work of state.works) {
    if (work.status === "active") {
      work.status = "unknown";
      work.endedAt = state.now();
      work.endReason = reason;
    }
    work.invalidated = true;
    work.evidenceState = "unavailable";
    work.evidenceUnavailableReason = reason;
    clearWorkBindings(state, work);
  }
  state.current = null;
  state.pending = [];
}

function disable(state: EntryState, reason: string): void {
  if (state.disposed) return;
  state.enabled = false;
  state.disabledReason = reason;
  invalidateAll(state, reason);
}

function disposeState(state: EntryState, reason: string): void {
  if (state.disposed) return;
  state.disposed = true;
  state.enabled = false;
  state.disabledReason = reason;
  invalidateAll(state, reason);
  state.callBindings.clear();
  state.reportBindings.clear();
  state.callIdMemory.clear();
}

function usable(state: EntryState): boolean {
  if (state.disposed || !state.enabled) return false;
  if (currentTaskOwner() !== undefined) {
    disable(state, "a managed TaskOwner is already published; this native work entry is disabled.");
    return false;
  }
  return true;
}

function prunePending(state: EntryState): void {
  while (state.pending.length > state.maxPendingInputs) {
    state.pending.shift();
    state.pendingDropped++;
  }
}

function pruneWorks(state: EntryState): void {
  while (state.works.length > state.maxRetainedWorks) {
    const removed = state.works.shift();
    if (removed === undefined) break;
    if (state.advisory !== null && state.advisory.work === removed) state.advisory = null;
    removed.invalidated = true;
    removed.evidenceState = "unavailable";
    removed.evidenceUnavailableReason = "retained work history was truncated";
    clearWorkBindings(state, removed);
    if (state.current === removed) state.current = null;
    state.worksDropped++;
  }
}

function pruneReportBindings(state: EntryState): void {
  while (state.reportBindings.size > state.maxReportBindings) {
    const oldest = state.reportBindings.keys().next().value;
    if (oldest === undefined) break;
    state.reportBindings.delete(oldest);
  }
}

/** A captured binding must still be the live routing entry for this exact call. */
function invalidateReportRouting(state: EntryState, toolCallId: string, call: ObservedCall): void {
  const binding = state.reportBindings.get(toolCallId);
  if (binding !== undefined && binding.call === call) state.reportBindings.delete(toolCallId);
}

function createReportBinding(work: Work, call: ObservedCall): ReportBinding {
  let unavailableReason: string | null = null;
  if (work.evidenceState === "unavailable") {
    unavailableReason = work.evidenceUnavailableReason ?? "work evidence is unavailable";
  } else if (work.sessionId === null || work.workspaceRoot === null) {
    unavailableReason = "session or workspace identity is unavailable";
  }
  return {
    toolCallId: call.toolCallId,
    work,
    call,
    sessionId: work.sessionId,
    workspaceRoot: work.workspaceRoot,
    unavailableReason,
  };
}

/**
 * Bounded global uniqueness memory for every hook-observed call id. Once the
 * guard is full, new evidence and new report routing ids are withheld; native
 * tool dispatch is untouched and already-retained bindings remain usable.
 */
function claimCallIdUniqueness(
  state: EntryState,
  work: Work,
  toolCallId: string,
): string | null {
  const priorGeneration = state.callIdMemory.get(toolCallId);
  if (priorGeneration !== undefined) {
    return priorGeneration === work.generation
      ? "the call id was previously observed in this work but is no longer retained"
      : "the call id was already observed in another work generation";
  }
  if (state.callIdMemorySaturated) {
    return "the bounded call-id uniqueness guard is full; uniqueness cannot be established";
  }
  state.callIdMemory.set(toolCallId, work.generation);
  if (state.callIdMemory.size >= state.maxRememberedCallIds) state.callIdMemorySaturated = true;
  return null;
}

type PendingMatch =
  | { kind: "none" }
  | { kind: "one"; input: PendingInput }
  | { kind: "many"; count: number };

function pendingInputMatches(
  input: PendingInput,
  digest: string,
  sessionId: string | null,
  workspaceRoot: string | null,
): boolean {
  return input.digest === digest
    && input.sessionId === sessionId
    && input.workspaceRoot === workspaceRoot;
}

function consumePending(
  state: EntryState,
  digest: string,
  sessionId: string | null,
  workspaceRoot: string | null,
): PendingMatch {
  const matches = state.pending.filter((input) =>
    pendingInputMatches(input, digest, sessionId, workspaceRoot),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) {
    state.pending = state.pending.filter((input) => input !== matches[0]);
    return { kind: "one", input: matches[0]! };
  }
  state.pending = state.pending.filter((input) => !matches.includes(input));
  return { kind: "many", count: matches.length };
}

/**
 * True only for the exact advisory text this entry issued for the same current
 * work, live session/workspace and still-valid deadline. Any pending ingress
 * breaks the association; content matching alone is never sufficient.
 */
function advisoryContinuationMatches(
  state: EntryState,
  work: Work | null,
  prompt: string,
  sessionId: string | null,
  workspaceRoot: string | null,
  at: number,
): boolean {
  const advisory = state.advisory;
  return advisory !== null
    && work !== null
    && state.current === work
    && advisory.work === work
    && work.status === "active"
    && !work.invalidated
    && work.reminderUsed
    && advisory.reminderText === prompt
    && advisory.sessionId === sessionId
    && advisory.workspaceRoot === workspaceRoot
    && work.sessionId === sessionId
    && work.workspaceRoot === workspaceRoot
    && sessionId !== null
    && workspaceRoot !== null
    && at >= advisory.issuedAt
    && at <= work.reminderDeadline
    && state.pending.length === 0;
}

function activateWork(state: EntryState, event: BeforeAgentStartLike, context: NativeContext): Work | null {
  if (event.reason !== "prompt") return null;
  const prompt = typeof event.prompt === "string" ? event.prompt : "";
  const digest = sha256Hex(prompt);
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  const now = state.now();
  const current = state.current;

  if (advisoryContinuationMatches(state, current, prompt, sessionId, workspaceRoot, now)) {
    // The host prepared this entry's own one-time advisory. It refreshes the
    // existing work generation rather than creating another request.
    return current;
  }

  const samePreparedReentry = current !== null
    && current.status === "active"
    && current.promptDigest === digest
    && current.sessionId === sessionId
    && current.workspaceRoot === workspaceRoot;

  if (samePreparedReentry) {
    const freshIngress = state.pending.some((input) =>
      pendingInputMatches(input, digest, sessionId, workspaceRoot),
    );
    if (!freshIngress) {
      // Policy-refresh re-entry for the same prepared input: the same work
      // generation and its reminder state stay intact.
      return current;
    }
  }

  // Nothing below may inherit the issued advisory association.
  state.advisory = null;

  let overlap = false;
  let overlapReason: string | null = null;
  let ambiguousReentry = false;
  if (samePreparedReentry) {
    // A new same-text input arrived while this work was active. The host event
    // does not say whether this preparation belongs to that new ingress or is
    // a repeat for the old request, so do not let the old association claim it.
    ambiguousReentry = true;
    const reason = "a new same-text ingress arrived while this work was active; request association is ambiguous";
    current.status = "unknown";
    current.endedAt = now;
    current.endReason = reason;
    current.invalidated = true;
    current.evidenceState = "unavailable";
    current.evidenceUnavailableReason = reason;
    clearWorkBindings(state, current);
  } else if (current !== null && current.status === "active") {
    overlap = true;
    overlapReason = "a different prompt was prepared while this work was still active; association is ambiguous";
    current.status = "unknown";
    current.endedAt = now;
    current.endReason = overlapReason;
    current.invalidated = true;
    current.evidenceState = "unavailable";
    current.evidenceUnavailableReason = overlapReason;
    clearWorkBindings(state, current);
  }

  const match = consumePending(state, digest, sessionId, workspaceRoot);
  let requestAttribution: RequestAttribution = "unknown";
  let requestExcerpt: string | null = null;
  let requestExcerptTruncated = false;
  let evidenceState: EvidenceState = "unknown-source";
  let evidenceUnavailableReason: string | null = null;

  if (ambiguousReentry) {
    requestAttribution = "unknown";
    evidenceState = "unknown-source";
  } else if (overlap) {
    requestAttribution = "unavailable";
    evidenceState = "unavailable";
    evidenceUnavailableReason = overlapReason;
  } else if (sessionId === null || workspaceRoot === null) {
    requestAttribution = "unavailable";
    evidenceState = "unavailable";
    evidenceUnavailableReason = "the main session or workspace identity is unavailable";
  } else if (match.kind === "one") {
    if (match.input.genuine) {
      requestAttribution = "matched-user-input";
      requestExcerpt = match.input.excerpt;
      requestExcerptTruncated = match.input.excerptTruncated;
      evidenceState = "available";
    } else {
      requestAttribution = "unavailable";
      evidenceState = "unavailable";
      evidenceUnavailableReason = "the matched request source is not genuine user input";
    }
  } else if (match.kind === "many") {
    requestAttribution = "unknown";
    evidenceState = "unavailable";
    evidenceUnavailableReason = "multiple pending inputs matched the prepared prompt; source attribution is ambiguous";
  }

  const generation = ++state.nextGeneration;
  const work: Work = {
    observationId: `native-work-${generation}`,
    generation,
    sessionId,
    workspaceRoot,
    promptDigest: digest,
    status: "active",
    requestAttribution,
    requestExcerpt,
    requestExcerptTruncated,
    evidenceState,
    evidenceUnavailableReason,
    startedAt: now,
    endedAt: null,
    endReason: null,
    calls: [],
    callIndex: new Map(),
    callsDropped: 0,
    report: null,
    reportSignature: null,
    reminderUsed: false,
    reminderDeadline: now + state.reminderDeadlineMs,
    invalidated: false,
  };
  state.current = work;
  state.works.push(work);
  pruneWorks(state);
  return state.current === work ? work : null;
}

function onInput(state: EntryState, event: InputEventLike, context: NativeContext): void {
  if (!usable(state) || !readMain(context)) return;
  const text = typeof event.text === "string" ? event.text : "";
  if (text.trim().length === 0) return;
  // Fresh ingress can never inherit the entry's own continuation association.
  state.advisory = null;
  const source = typeof event.source === "string" ? event.source : "unknown";
  const excerpt = compactExcerpt(text, MAX_REQUEST_EXCERPT_CHARS);
  state.pending.push({
    digest: sha256Hex(text),
    excerpt: excerpt.text,
    excerptTruncated: excerpt.truncated,
    genuine: source === "interactive" || source === "rpc",
    source,
    sessionId: readSessionId(context),
    workspaceRoot: readWorkspace(context),
    at: state.now(),
  });
  prunePending(state);
}

function onBeforeAgentStart(
  state: EntryState,
  event: BeforeAgentStartLike,
  context: NativeContext,
): { systemPrompt: string[] } | undefined {
  if (!usable(state) || !readMain(context)) return undefined;
  if (event.reason === "prompt") activateWork(state, event, context);
  const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [];
  return { systemPrompt: [...base, NATIVE_WORK_GUIDANCE] };
}

function recordToolCall(state: EntryState, event: ToolCallLike, context: NativeContext): void {
  if (!usable(state) || !readMain(context)) return;
  const work = state.current;
  if (work === null || work.status !== "active" || work.invalidated) return;
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  if (sessionId !== work.sessionId || workspaceRoot !== work.workspaceRoot) {
    invalidateCurrent(state, "session or workspace changed before a tool call was observed");
    return;
  }
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  if (toolCallId.length < 1 || toolCallId.length > MAX_TOOL_CALL_ID_CHARS || toolName.length < 1) return;

  const input = isRecord(event.input) ? event.input : null;
  const preflightDigest = toolName === NATIVE_WORK_TOOL ? canonicalInputDigest(event.input) : null;
  const existing = work.callIndex.get(toolCallId);
  if (existing !== undefined) {
    const conflictingIdentity = existing.toolName !== toolName
      || (toolName === NATIVE_WORK_TOOL && (preflightDigest === null || preflightDigest !== existing.preflightDigest));
    if (conflictingIdentity) {
      existing.resultState = "unknown";
      existing.result = null;
      existing.unknownReason = "conflicting tool identity or preflight input for the same call id";
      existing.associationConflict = true;
      invalidateReportRouting(state, toolCallId, existing);
      return;
    }
    if (toolName === NATIVE_WORK_TOOL && input?.action === "report" && !existing.associationConflict) {
      const binding = state.reportBindings.get(toolCallId);
      if (binding === undefined) {
        // An identical wrapper repeat may restore a routing entry that bounded
        // pruning removed; the exact retained call remains the association.
        state.reportBindings.set(toolCallId, createReportBinding(work, existing));
        pruneReportBindings(state);
      } else if (binding.work !== work || binding.call !== existing) {
        existing.resultState = "unknown";
        existing.result = null;
        existing.unknownReason = "conflicting report routing for the same call id";
        existing.associationConflict = true;
        state.reportBindings.delete(toolCallId);
      }
    }
    return;
  }

  // Host ids are run-scoped, not globally unique across retained prompts. A
  // bounded global memory keeps reused ids ambiguous even after the owning call
  // or work has been evicted from visible retention. Report routing ids use the
  // same guard; a full guard withholds new routing without touching native dispatch.
  const priorReportBinding = state.reportBindings.get(toolCallId);
  let reuseConflictReason = claimCallIdUniqueness(state, work, toolCallId);
  if (reuseConflictReason === null && priorReportBinding !== undefined) {
    reuseConflictReason = "the call id was already bound to an agent_work report preflight that is no longer current";
  }

  // This preflight now owns the id; any older agent_work routing is stale.
  state.reportBindings.delete(toolCallId);
  const call: ObservedCall = {
    toolCallId,
    toolName,
    preflightAt: state.now(),
    preflightDigest,
    resultState: reuseConflictReason === null ? "preflight" : "unknown",
    result: null,
    unknownReason: reuseConflictReason,
    associationConflict: reuseConflictReason !== null,
  };
  work.calls.push(call);
  work.callIndex.set(toolCallId, call);
  state.callBindings.set(toolCallId, { work, call });
  if (work.calls.length > state.maxCallsPerWork) {
    const dropped = work.calls.shift();
    if (dropped !== undefined) {
      if (work.callIndex.get(dropped.toolCallId) === dropped) work.callIndex.delete(dropped.toolCallId);
      const droppedBinding = state.callBindings.get(dropped.toolCallId);
      if (droppedBinding !== undefined && droppedBinding.call === dropped) {
        state.callBindings.delete(dropped.toolCallId);
      }
      const droppedReport = state.reportBindings.get(dropped.toolCallId);
      if (droppedReport !== undefined && droppedReport.work === work) {
        state.reportBindings.delete(dropped.toolCallId);
      }
      work.callsDropped++;
    }
  }

  if (toolName === NATIVE_WORK_TOOL && input?.action === "report") {
    // Bind even a conflicted report preflight so every later attempt resolves
    // to its own ambiguous routing entry instead of an unrelated work.
    state.reportBindings.set(toolCallId, createReportBinding(work, call));
    pruneReportBindings(state);
  }
}

function onToolResult(state: EntryState, event: ToolResultLike, context: NativeContext): void {
  if (!usable(state) || !readMain(context)) return;
  const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (toolCallId.length < 1) return;
  const binding = state.callBindings.get(toolCallId);
  if (binding === undefined) return;
  const call = binding.call;
  if (call.associationConflict) {
    // Once multiple identities/call generations claimed this id, a later
    // matching name does not establish a unique association.
    invalidateReportRouting(state, toolCallId, call);
    call.resultState = "unknown";
    call.result = null;
    call.unknownReason ??= "an identity conflict was observed for this call id; no result can be attributed";
    return;
  }
  if (call.toolName !== event.toolName) {
    invalidateReportRouting(state, toolCallId, call);
    call.resultState = "unknown";
    call.result = null;
    call.unknownReason = "tool_result identity does not match the preflight call";
    call.associationConflict = true;
    return;
  }
  const work = binding.work;
  if (work.invalidated) {
    invalidateReportRouting(state, toolCallId, call);
    call.resultState = "unknown";
    call.unknownReason = "the work association was invalidated before the result";
    return;
  }
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  if (sessionId !== work.sessionId || workspaceRoot !== work.workspaceRoot) {
    invalidateReportRouting(state, toolCallId, call);
    call.resultState = "unknown";
    call.unknownReason = "session or workspace changed before the tool result";
    return;
  }
  if (call.resultState === "observed") return;

  const content = Array.isArray(event.content) ? event.content : [];
  let excerptText = "";
  let excerptTruncated = false;
  let textBlocks = 0;
  let imageBlocks = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textBlocks++;
      if (excerptText.length >= MAX_RESULT_EXCERPT_CHARS) {
        excerptTruncated = true;
        continue;
      }
      const separator = excerptText.length > 0 ? "\n" : "";
      const room = MAX_RESULT_EXCERPT_CHARS - excerptText.length - separator.length;
      if (room <= 0) {
        excerptTruncated = true;
        continue;
      }
      const piece = block.text.slice(0, room);
      excerptText += separator + piece;
      if (piece.length < block.text.length) excerptTruncated = true;
    } else if (block.type === "image") {
      imageBlocks++;
    }
  }
  const details = isRecord(event.details) ? event.details : null;
  const exitCode = details !== null
    && typeof details.exitCode === "number"
    && Number.isFinite(details.exitCode)
    ? details.exitCode
    : null;
  call.result = {
    observationScope: "plugin-tool-result-after-middleware",
    isErrorObserved: event.isError === true,
    textExcerpt: excerptText,
    textTruncated: excerptTruncated,
    textBlocks,
    imageBlocks,
    detailsPresent: event.details !== undefined && event.details !== null,
    exitCodeFromToolDetails: exitCode,
    observedAt: state.now(),
  };
  call.resultState = "observed";
  call.unknownReason = null;
}

function onAgentEnd(state: EntryState, event: AgentEndLike, context: NativeContext): void {
  if (!usable(state) || !readMain(context)) return;
  if (event.willContinue === true || event.awaitingAsyncWork === true) return;
  const work = state.current;
  if (work === null || work.status !== "active" || work.invalidated) return;
  work.status = "ended";
  work.endedAt = state.now();
  work.endReason = "terminal agent_end";
  if (state.advisory !== null && state.advisory.work === work) state.advisory = null;
}

function onSessionStop(state: EntryState, event: SessionStopLike, context: NativeContext): unknown {
  if (!usable(state) || !readMain(context)) return undefined;
  const work = state.current;
  if (
    work === null
    || (work.status !== "active" && work.status !== "ended")
    || work.invalidated
    || work.report !== null
    || work.reminderUsed
    || work.evidenceState === "unavailable"
  ) {
    return undefined;
  }
  // Ordinary no-tool conversation must finish without a forced extra round.
  // Remind only after observable tool-using work, and only while no immutable
  // report covers it.
  const hasObservedToolWork = work.calls.some(
    (call) => call.toolName !== NATIVE_WORK_TOOL && call.resultState === "observed" && call.result !== null,
  );
  if (!hasObservedToolWork) return undefined;
  const at = state.now();
  if (at > work.reminderDeadline) return undefined;
  if (isAborted(event.signal)) return undefined;
  // Consume the one-shot budget before returning the advisory continuation.
  work.reminderUsed = true;
  if (work.status === "ended") {
    // Some hosts settle the terminal end before the stop pass observes it. The
    // continuation belongs to the same work generation, so reopen only its
    // finalization window instead of creating a new request/work.
    work.status = "active";
    work.endedAt = null;
    work.endReason = "finalization continuation on the same work";
  }
  // Bind the exact issued advisory to this work only when no queued ingress
  // could make the next preparation ambiguous. This is an observation of our
  // own continuation, not permission and not a general synthetic-prompt rule.
  state.advisory = state.pending.length === 0
    && work.sessionId !== null
    && work.workspaceRoot !== null
    ? {
        work,
        reminderText: NATIVE_STOP_REMINDER,
        sessionId: work.sessionId,
        workspaceRoot: work.workspaceRoot,
        issuedAt: at,
      }
    : null;
  return { continue: true, additionalContext: NATIVE_STOP_REMINDER };
}

function onNavigation(state: EntryState, context: NativeContext, reason: string): void {
  if (state.disposed) return;
  if (currentTaskOwner() !== undefined) {
    disable(state, "a managed TaskOwner is already published; this native work entry is disabled.");
    return;
  }
  if (!readMain(context)) return;
  invalidateCurrent(state, reason);
}

function reportSignature(work: Work, parsed: ReportArguments): string {
  const checks = [...parsed.checks]
    .sort((left, right) => (left.toolCallId < right.toolCallId ? -1 : left.toolCallId > right.toolCallId ? 1 : 0))
    .map((check) => [check.toolCallId, check.purpose]);
  return sha256Hex(JSON.stringify({
    work: work.observationId,
    checks,
    outputFiles: [...parsed.outputFiles].sort(),
    outcome: parsed.outcome,
    summary: parsed.summary ?? "",
    limitations: parsed.limitations,
    ...(parsed.instanceResult === undefined ? {} : { instanceResult: parsed.instanceResult }),
  }));
}

function requestNote(attribution: RequestAttribution): string {
  if (attribution === "matched-user-input") {
    return "Matched one genuine ingress input at preparation time; the excerpt is a reference, not authority.";
  }
  if (attribution === "unavailable") {
    return "Request attribution is unavailable; no genuine user input was established for this work.";
  }
  return "No unique genuine ingress input matched; request attribution is unknown.";
}

function buildReport(
  work: Work,
  parsed: ReportArguments,
  sessionId: string,
  workspaceRoot: string,
  selected: SelectedCheck[],
  files: NativeObservedFile[],
  recordedAt: number,
  instanceResult: NativeInstanceReportFacts | undefined,
): NativeWorkReport {
  const checks: NativeWorkCheckReport[] = selected.map(({ call, result, purpose }) => ({
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    purpose,
    observationScope: "plugin-tool-result-after-middleware",
    isErrorObserved: result.isErrorObserved,
    exitCodeFromToolDetails: result.exitCodeFromToolDetails,
    resultExcerpt: result.textExcerpt,
    resultTruncated: result.textTruncated,
    observedAt: result.observedAt,
  }));

  const unverified: string[] = [];
  if (checks.length === 0) {
    unverified.push("No completed tool calls were selected; no check coverage is claimed.");
  }
  for (const check of checks) {
    unverified.push(
      `Check ${check.toolCallId}: purpose is model-declared; the observed result does not prove it checked that property.`,
    );
    if (check.isErrorObserved) {
      unverified.push(`Check ${check.toolCallId}: observed isError=true is recorded as a failed observation, not a pass.`);
    } else {
      unverified.push(
        `Check ${check.toolCallId}: observed isError=false is not semantic proof or proof the check was meaningful.`,
      );
    }
    if (check.exitCodeFromToolDetails === null) {
      unverified.push(
        `Check ${check.toolCallId}: no numeric exitCode was observed in tool details; subprocess/check exit is not established.`,
      );
    } else {
      unverified.push(
        `Check ${check.toolCallId}: exitCode is a host tool-detail value, not semantic validation.`,
      );
    }
  }
  for (const file of files) {
    unverified.push(
      `File ${file.relativePath}: bytes and sha256 observed at report time; not managed provenance, future immutability, independent check coverage, or proof a selected check inspected that version.`,
    );
  }
  if (instanceResult !== undefined) {
    unverified.push(
      `Selected result ${instanceResult.result.instanceId}/${instanceResult.result.parentToolCallId}: output files are bytes read during this report, not the child's original delivered version, exclusive authorship, a commit-time filesystem snapshot, or an atomic multi-file snapshot.`,
    );
    unverified.push(
      "The selected result envelope is a tool-result-middleware observation; semanticAcceptance remains not-evaluated.",
    );
  }

  const statusAtReport = work.status === "ended" ? "ended" : "active";
  const report: NativeWorkReport = {
    kind: "native-work-report",
    interface: NATIVE_WORK_INTERFACE,
    authority: "non-authoritative",
    work: {
      observationId: work.observationId,
      generation: work.generation,
      sessionId,
      workspaceRoot,
      statusAtReport,
      request: {
        attribution: work.requestAttribution,
        excerpt: work.requestExcerpt,
        excerptTruncated: work.requestExcerptTruncated,
        note: requestNote(work.requestAttribution),
      },
    },
    modelDeclared: {
      outcome: parsed.outcome,
      summary: parsed.summary,
      limitations: [...parsed.limitations],
    },
    observed: {
      checks,
      coverage: {
        selected: checks.length,
        observedResults: checks.length,
        observedErrorResults: checks.filter((check) => check.isErrorObserved).length,
        callsInWorkWithoutObservedResult: work.calls.filter(
          (call) => call.toolName !== NATIVE_WORK_TOOL && call.resultState !== "observed",
        ).length,
        callsDroppedFromWork: work.callsDropped,
        unverified,
      },
      outputFiles: files.map((file) => ({
        relativePath: file.relativePath,
        bytes: file.bytes,
        sha256: file.sha256,
        observedAt: file.observedAt,
        note: "bytes observed now; not managed provenance, future file state, independent check coverage, or acceptance.",
      })),
    },
    recordedAt,
    caveats: [
      "Non-authoritative per-request work observation; not the managed TaskOwner task, permission, acceptance, or verification.",
      "Tool result facts are this plugin's tool_result hook observation after any earlier middleware; they are not untouched native output.",
      "Tool names, success flags, file bytes and hashes do not establish semantic correctness or full check coverage.",
      "No host-level independent verification or global acceptance was performed.",
    ],
    ...(instanceResult === undefined ? {} : { instanceResult }),
  };
  return deepFreeze(report);
}

function callSelectable(state: EntryState, work: Work, call: ObservedCall): boolean {
  return state.current === work
    && work.status === "active"
    && !work.invalidated
    && work.evidenceState !== "unavailable"
    && call.toolName !== NATIVE_WORK_TOOL
    && !call.associationConflict
    && call.resultState === "observed"
    && call.result !== null;
}

function callView(state: EntryState, work: Work, call: ObservedCall): Record<string, unknown> {
  const result = call.result;
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    selectable: callSelectable(state, work, call),
    resultState: call.resultState,
    associationConflict: call.associationConflict,
    unknownReason: call.unknownReason,
    preflightAt: call.preflightAt,
    observationScope: result?.observationScope ?? null,
    isErrorObserved: result?.isErrorObserved ?? null,
    resultExcerpt: result?.textExcerpt ?? null,
    resultTruncated: result?.textTruncated ?? null,
    textBlocks: result?.textBlocks ?? null,
    imageBlocks: result?.imageBlocks ?? null,
    detailsPresent: result?.detailsPresent ?? null,
    exitCodeFromToolDetails: result?.exitCodeFromToolDetails ?? null,
    observedAt: result?.observedAt ?? null,
  };
}

function workView(state: EntryState, work: Work, at: number): Record<string, unknown> {
  return {
    observationId: work.observationId,
    generation: work.generation,
    sessionId: work.sessionId,
    workspaceRoot: work.workspaceRoot,
    status: work.status,
    reportState: work.report === null ? "not-reported" : "reported",
    outcome: work.report?.modelDeclared.outcome ?? null,
    request: {
      attribution: work.requestAttribution,
      excerpt: work.requestExcerpt,
      excerptTruncated: work.requestExcerptTruncated,
      note: requestNote(work.requestAttribution),
    },
    evidence: {
      state: work.evidenceState,
      unavailableReason: work.evidenceUnavailableReason,
    },
    startedAt: work.startedAt,
    endedAt: work.endedAt,
    endReason: work.endReason,
    invalidated: work.invalidated,
    reminder: {
      used: work.reminderUsed,
      deadline: work.reminderDeadline,
      expired: at > work.reminderDeadline,
    },
    calls: work.calls.map((call) => callView(state, work, call)),
    callsDropped: work.callsDropped,
    report: work.report === null ? null : clonePlain(work.report),
  };
}

function workSummary(state: EntryState, work: Work): Record<string, unknown> {
  return {
    observationId: work.observationId,
    generation: work.generation,
    status: work.status,
    reportState: work.report === null ? "not-reported" : "reported",
    outcome: work.report?.modelDeclared.outcome ?? null,
    startedAt: work.startedAt,
    endedAt: work.endedAt,
    endReason: work.endReason,
    calls: work.calls.length,
    callsDropped: work.callsDropped,
    recordedAt: work.report?.recordedAt ?? null,
  };
}

function inspectWorkIdentity(work: Work | null): {
  observationId: string;
  generation: number;
  sessionId: string | null;
  workspaceRoot: string | null;
} | null {
  return work === null
    ? null
    : {
        observationId: work.observationId,
        generation: work.generation,
        sessionId: work.sessionId,
        workspaceRoot: work.workspaceRoot,
      };
}

function sameInspectWorkIdentity(
  left: ReturnType<typeof inspectWorkIdentity>,
  right: ReturnType<typeof inspectWorkIdentity>,
): boolean {
  if (left === null || right === null) return left === right;
  return left.observationId === right.observationId
    && left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.workspaceRoot === right.workspaceRoot;
}

/**
 * Judge only captured native state after every inspect host read. An available
 * catalog requires the same active work, available matched evidence and zero
 * pending/dropped ingress; an id-only comparison is not enough.
 */
function inspectCatalogStateFailure(
  state: EntryState,
  expectedWorkIdentity: ReturnType<typeof inspectWorkIdentity>,
): string | null {
  const work = state.current;
  if (work === null
    || !sameInspectWorkIdentity(expectedWorkIdentity, inspectWorkIdentity(work))) {
    return "the current work identity changed while the instance result port was reading; no candidate catalog is trusted";
  }
  if (work.invalidated || work.status !== "active") {
    return "the current work is no longer active; no candidate catalog is trusted";
  }
  if (work.evidenceState !== "available") {
    return "the current work evidence is unavailable; no candidate catalog is trusted";
  }
  if (work.requestAttribution !== "matched-user-input") {
    return "the current work request attribution is not a matched genuine input; no candidate catalog is trusted";
  }
  if (state.pending.length > 0 || state.pendingDropped > 0) {
    return "pending or dropped ingress changed while the instance result port was reading; no candidate catalog is trusted";
  }
  return null;
}

function inspectResult(state: EntryState, context: NativeContext): NativeToolResult {
  // The port may reenter host/state code. Finish its host reads and the final
  // host/current identity reads before building any inspection view; a changed
  // identity invalidates the candidate catalog instead of returning stale
  // context or a stale work view.
  let preMain: boolean | null = null;
  let preSessionId: string | null = null;
  let preWorkspaceRoot: string | null = null;
  if (state.instanceReports !== null) {
    preMain = readMain(context);
    preSessionId = readSessionId(context);
    preWorkspaceRoot = readWorkspace(context);
  }
  const preWorkIdentity = inspectWorkIdentity(state.current);
  const portWork = preWorkIdentity !== null
    && preWorkIdentity.sessionId !== null
    && preWorkIdentity.workspaceRoot !== null
    ? Object.freeze({
        observationId: preWorkIdentity.observationId,
        generation: preWorkIdentity.generation,
        sessionId: preWorkIdentity.sessionId,
        workspaceRoot: preWorkIdentity.workspaceRoot,
      })
    : null;
  let instanceResults = inspectReportInstances(state.instanceReports, context, portWork);

  // Finish all host reads, then apply a pure currentness decision so a
  // reentrant getter cannot leave a stale work labelled as current.
  // now is also an injected host callback; finish it before reading the live
  // snapshot and before the pure decision.
  const at = state.now();
  const main = readMain(context);
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  const owner = currentTaskOwner();

  if (preMain !== null
    && (preMain !== main
      || preSessionId !== sessionId
      || preWorkspaceRoot !== workspaceRoot
      || !sameInspectWorkIdentity(preWorkIdentity, inspectWorkIdentity(state.current)))) {
    instanceResults = unavailableNativeInstanceReportCatalog(
      "inspect context or current work identity changed while the instance result port was reading; no candidate catalog is trusted",
    );
  }

  if (!state.disposed && state.enabled) {
    if (owner !== undefined) {
      disable(state, "a managed TaskOwner is already published; this native work entry is disabled.");
    } else if (!main) {
      invalidateCurrent(state, "the main session context changed before inspection");
    } else if (
      state.current !== null
      && (state.current.sessionId !== sessionId || state.current.workspaceRoot !== workspaceRoot)
    ) {
      invalidateCurrent(state, "session or workspace changed before inspection");
    }
  }

  // The port may have computed an available row before a later host getter
  // queued ingress or changed evidence without changing the work id. Judge the
  // complete captured state now, after all host reads and base invalidations.
  if (state.instanceReports !== null && instanceResults.state === "available") {
    const catalogFailure = inspectCatalogStateFailure(state, preWorkIdentity);
    if (catalogFailure !== null) {
      instanceResults = unavailableNativeInstanceReportCatalog(catalogFailure);
    }
  }

  const current = state.current === null ? null : workView(state, state.current, at);
  const details = {
    kind: "native-work-inspect",
    interface: NATIVE_WORK_INTERFACE,
    authority: "non-authoritative",
    enabled: state.enabled,
    disabledReason: state.disabledReason,
    current,
    retainedWorks: {
      count: state.works.length,
      dropped: state.worksDropped,
      items: state.works.map((work) => workSummary(state, work)),
    },
    pendingInputs: {
      count: state.pending.length,
      dropped: state.pendingDropped,
    },
    instanceResults,
    bounds: {
      maxRetainedWorks: state.maxRetainedWorks,
      maxCallsPerWork: state.maxCallsPerWork,
      maxPendingInputs: state.maxPendingInputs,
      maxReportBindings: state.maxReportBindings,
      maxRememberedCallIds: state.maxRememberedCallIds,
      rememberedCallIds: state.callIdMemory.size,
      callIdMemorySaturated: state.callIdMemorySaturated,
    },
    notes: [
      "This is a per-request work observation, not the managed TaskOwner task, permission, acceptance, or verification.",
      "Report facts are immutable once recorded; conflicting repeats are refused.",
      "Calls without an observed tool_result cannot be selected. agent_work calls are never selectable as checks.",
      "Older calls/works beyond the bounded retention are dropped and cannot be selected.",
      "Reused or previously seen call ids, ids evicted from retention, and new ids after the bounded uniqueness guard fills stay ambiguous and are never selectable.",
      "agent_work report routing uses the same bounded uniqueness guard; once it fills, new report routing ids are withheld while already-retained bindings remain replayable.",
      "The current work is compared with the live session id and sessionManager.getCwd() identity; /clear, /move and navigation invalidate it.",
      "instanceResults lists bounded inspection-time candidate selectors; presence or absence is not permission, and the final report revalidates the exact result, work and lifecycle.",
      "A selected result associates output file bytes read during that report; it does not establish original child delivery, exclusive authorship, commit-time file state or semantic acceptance.",
    ],
  };
  return successResult(details, "Non-authoritative native work inspection.");
}

interface LiveContextSnapshot {
  main: boolean;
  sessionId: string | null;
  workspaceRoot: string | null;
  owner: unknown;
  aborted: boolean;
  disposed: boolean;
  enabled: boolean;
}

/** Read every host-owned value first; callers then judge a pure snapshot. */
function readLiveContext(
  state: EntryState,
  context: NativeContext,
  signal: AbortSignal | undefined,
): LiveContextSnapshot {
  return {
    main: readMain(context),
    sessionId: readSessionId(context),
    workspaceRoot: readWorkspace(context),
    owner: currentTaskOwner(),
    aborted: isAborted(signal),
    disposed: state.disposed,
    enabled: state.enabled,
  };
}

function currentnessFailure(
  state: EntryState,
  live: LiveContextSnapshot,
  binding: ReportBinding,
  work: Work,
  phase: "report" | "final" | "replay",
): NativeToolResult | null {
  const when = phase === "final"
    ? "while observing outputs"
    : phase === "replay"
      ? "before replaying a report"
      : "before recording";
  if (live.disposed || !live.enabled) {
    return errorResult("agent_work report refused: the entry is disabled or disposed. No report was recorded.");
  }
  if (live.owner !== undefined) {
    disable(state, "a managed TaskOwner is already published; this native work entry is disabled.");
    return errorResult("agent_work report refused: a managed TaskOwner is now published. No report was recorded.");
  }
  if (!live.main) {
    return errorResult("agent_work report refused: the main session context is unavailable. No report was recorded.");
  }
  if (live.sessionId === null || live.workspaceRoot === null) {
    return errorResult("agent_work report refused: the live session or workspace identity is unavailable. No report was recorded.");
  }
  if (live.sessionId !== binding.sessionId || live.workspaceRoot !== binding.workspaceRoot) {
    return errorResult(`agent_work report refused: the live session or workspace changed ${when}. No report was recorded.`);
  }
  if (work.invalidated || state.current !== work || work.status !== "active") {
    return errorResult(`agent_work report refused: the work association changed or is no longer the current live work ${when}. No report was recorded.`);
  }
  if (work.evidenceState === "unavailable") {
    return errorResult(
      `agent_work report refused: ${work.evidenceUnavailableReason ?? "work evidence is unavailable"}. No report was recorded.`,
    );
  }
  if (live.aborted) {
    return errorResult(`agent_work report was cancelled ${when}. No report was recorded.`);
  }
  return null;
}

/**
 * The report operation's own preflight must still be the unique, retained,
 * unconflicted routing entry. No parameter or current-work fallback is used.
 */
function reportRoutingFailure(
  state: EntryState,
  toolCallId: string,
  binding: ReportBinding,
): NativeToolResult | null {
  if (state.reportBindings.get(toolCallId) !== binding) {
    return errorResult(
      "agent_work report refused: its tool_call preflight routing was overwritten or evicted and is ambiguous. No report was recorded.",
    );
  }
  const work = binding.work;
  const call = binding.call;
  if (
    work.callIndex.get(toolCallId) !== call
    || state.callBindings.get(toolCallId)?.call !== call
  ) {
    return errorResult(
      "agent_work report refused: its tool_call preflight call is no longer retained for this work. No report was recorded.",
    );
  }
  if (call.toolName !== NATIVE_WORK_TOOL || call.associationConflict) {
    return errorResult(
      "agent_work report refused: its tool_call preflight identity is conflicted or ambiguous. No report was recorded.",
    );
  }
  const rememberedGeneration = state.callIdMemory.get(toolCallId);
  if (rememberedGeneration !== work.generation) {
    return errorResult(
      "agent_work report refused: its tool_call preflight call id has no unique same-work memory entry. No report was recorded.",
    );
  }
  return null;
}

function selectChecks(
  state: EntryState,
  work: Work,
  checks: readonly ReportCheckArgument[],
): { selected: SelectedCheck[] } | { error: NativeToolResult } {
  const selected: SelectedCheck[] = [];
  const unavailable: string[] = [];
  for (const check of checks) {
    const call = work.callIndex.get(check.toolCallId);
    if (call === undefined) {
      unavailable.push(`${JSON.stringify(check.toolCallId)} (not retained in this work)`);
      continue;
    }
    if (call.toolName === NATIVE_WORK_TOOL) {
      unavailable.push(`${JSON.stringify(check.toolCallId)} (agent_work calls cannot be checks)`);
      continue;
    }
    if (!callSelectable(state, work, call) || call.result === null) {
      unavailable.push(`${JSON.stringify(check.toolCallId)} (no completed observed result)`);
      continue;
    }
    selected.push({ call, result: call.result, purpose: check.purpose });
  }
  if (unavailable.length > 0) {
    return {
      error: errorResult(
        `agent_work report refused; select only real completed calls from this same work: ${unavailable.join("; ")}. No report was recorded.`,
      ),
    };
  }
  return { selected };
}

/** The selected call object, result object and availability must be unchanged. */
function revalidateSelected(
  state: EntryState,
  work: Work,
  selected: readonly SelectedCheck[],
): NativeToolResult | null {
  for (const item of selected) {
    if (
      work.callIndex.get(item.call.toolCallId) !== item.call
      || !callSelectable(state, work, item.call)
      || item.call.result !== item.result
    ) {
      return errorResult(
        "agent_work report refused: selected call evidence changed or became ambiguous while observing outputs. No report was recorded.",
      );
    }
  }
  return null;
}

function workedIdentity(work: Work): NativeReportWorkIdentity | null {
  if (work.sessionId === null || work.workspaceRoot === null) return null;
  return Object.freeze({
    observationId: work.observationId,
    generation: work.generation,
    sessionId: work.sessionId,
    workspaceRoot: work.workspaceRoot,
  });
}

function selectedParent(
  selected: readonly SelectedCheck[],
  selection: NativeInstanceReportSelection,
): { parent: SelectedCheck } | { error: NativeToolResult } {
  const parent = selected.find((item) => item.call.toolCallId === selection.parentToolCallId);
  if (parent === undefined) {
    return {
      error: errorResult(
        `agent_work report refused: instanceResult.parentToolCallId ${JSON.stringify(selection.parentToolCallId)} must be selected in checks as the actual task call. No report was recorded.`,
      ),
    };
  }
  if (parent.call.toolName !== "task") {
    return {
      error: errorResult(
        "agent_work report refused: instanceResult.parentToolCallId must identify an actual observed task call. No report was recorded.",
      ),
    };
  }
  return { parent };
}

/**
 * The selected path additionally requires a genuine source, no queued or
 * dropped ingress and the unchanged current parent task call. classifyCallAssociation
 * remains the single pure association classifier; these checks make the
 * selected requirement explicit instead of relying on generic currentness.
 */
function selectedCurrentnessFailure(
  state: EntryState,
  work: Work,
  parent: SelectedCheck,
): NativeToolResult | null {
  if (state.pendingDropped > 0) {
    return errorResult(
      "agent_work report refused: queued ingress was dropped, so the selected instance result association is ambiguous. No report was recorded.",
    );
  }
  if (state.pending.length > 0) {
    return errorResult(
      "agent_work report refused: a new input is pending, so the selected instance result association is ambiguous. No report was recorded.",
    );
  }
  if (work.requestAttribution !== "matched-user-input" || work.evidenceState !== "available") {
    return errorResult(
      "agent_work report refused: the selected instance result requires a genuine matched request source and available work evidence. No report was recorded.",
    );
  }
  if (!callSelectable(state, work, parent.call) || parent.call.result !== parent.result) {
    return errorResult(
      "agent_work report refused: the selected parent task call changed or is no longer selectable. No report was recorded.",
    );
  }
  const classification = classifyCallAssociation(state, work, parent.call);
  if (classification.state !== "current") {
    return errorResult(
      `agent_work report refused: the selected parent task call is no longer current (${classification.reason}). No report was recorded.`,
    );
  }
  return null;
}

type SelectedLiveRead =
  | { readonly ok: true; readonly live: LiveContextSnapshot }
  | { readonly ok: false; readonly result: NativeToolResult };

/** Complete host context reads first, then read the actual host signal last. */
function readSelectedLiveContext(
  state: EntryState,
  context: NativeContext,
  signal: unknown,
  when: string,
): SelectedLiveRead {
  const main = readMain(context);
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  const owner = currentTaskOwner();
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) {
    return {
      ok: false,
      result: errorResult(`agent_work report refused: ${signalRead.reason} ${when}. No report was recorded.`),
    };
  }
  return {
    ok: true,
    live: {
      main,
      sessionId,
      workspaceRoot,
      owner,
      aborted: signalRead.aborted,
      disposed: state.disposed,
      enabled: state.enabled,
    },
  };
}

function selectedSignalFailure(signal: unknown, when: string): NativeToolResult | null {
  const read = readActualAbortSignal(signal);
  if (!read.ok) {
    return errorResult(`agent_work report refused: ${read.reason} ${when}. No report was recorded.`);
  }
  if (read.aborted) {
    return errorResult(`agent_work report was cancelled ${when}. No report was recorded.`);
  }
  return null;
}

async function executeSelectedReport(
  state: EntryState,
  toolCallId: string,
  parsed: ReportArguments,
  selection: NativeInstanceReportSelection,
  signal: unknown,
  context: NativeContext,
): Promise<NativeToolResult> {
  const port = state.instanceReports;
  if (port === null) {
    return errorResult(
      "agent_work report refused: the explicit instanceResult selection is unavailable because no instance result composition is configured. No report was recorded.",
    );
  }
  const initialSignal = selectedSignalFailure(signal, "before report preparation");
  if (initialSignal !== null) return initialSignal;

  const binding = state.reportBindings.get(toolCallId);
  if (binding === undefined) {
    return errorResult("agent_work report context is unavailable: no matching tool_call preflight was observed for this call id.");
  }
  const initialRouting = reportRoutingFailure(state, toolCallId, binding);
  if (initialRouting !== null) return initialRouting;
  if (binding.unavailableReason !== null) {
    return errorResult(`agent_work report is unavailable for this work: ${binding.unavailableReason}. No report was recorded.`);
  }
  const work = binding.work;
  if (work.invalidated) {
    return errorResult("agent_work report refused because its work association was invalidated. No report was recorded.");
  }
  if (work.evidenceState === "unavailable") {
    return errorResult(
      `agent_work report refused: ${work.evidenceUnavailableReason ?? "work evidence is unavailable"}. No report was recorded.`,
    );
  }
  if (work.sessionId === null || work.workspaceRoot === null) {
    return errorResult("agent_work report refused: session or workspace identity is unavailable. No report was recorded.");
  }

  const initialSelection = selectChecks(state, work, parsed.checks);
  if ("error" in initialSelection) return initialSelection.error;
  const initialParent = selectedParent(initialSelection.selected, selection);
  if ("error" in initialParent) return initialParent.error;

  // Capture the report work and selected result, then finish all preparation
  // metadata reads before the first file I/O.
  const workIdentity = workedIdentity(work);
  if (workIdentity === null) {
    return errorResult("agent_work report refused: session or workspace identity is unavailable. No report was recorded.");
  }
  const prepared = prepareReportInstance(port, selection, workIdentity, context);
  if (!prepared.ok) {
    return errorResult(`agent_work report refused: ${prepared.reason}. No report was recorded.`);
  }
  const instanceFacts = prepared.facts;
  const preRefresh = invokePreparedRefresh(() => prepared.refresh());
  if (!preRefresh.ok) {
    return errorResult(`agent_work report refused: ${preRefresh.reason}. No report was recorded.`);
  }
  const preLive = readSelectedLiveContext(state, context, signal, "while preparing the selected result");
  if (!preLive.ok) return preLive.result;
  const preRevalidate = invokeFinalRevalidate(prepared.revalidate);
  if (!preRevalidate.ok) {
    return errorResult(`agent_work report refused: ${preRevalidate.reason}. No report was recorded.`);
  }
  // Native pure gates follow the primitive revalidate success.
  const preProblem = currentnessFailure(state, preLive.live, binding, work, "report");
  if (preProblem !== null) return preProblem;
  const preRouting = reportRoutingFailure(state, toolCallId, binding);
  if (preRouting !== null) return preRouting;
  const preSelected = selectedCurrentnessFailure(state, work, initialParent.parent);
  if (preSelected !== null) return preSelected;
  const preRevalidatedSelected = revalidateSelected(state, work, initialSelection.selected);
  if (preRevalidatedSelected !== null) return preRevalidatedSelected;

  const signature = reportSignature(work, parsed);
  if (work.report !== null) {
    if (work.reportSignature === signature) {
      return successResult(
        clonePlain(work.report),
        "Existing identical report observed; files were not reread and the original recordedAt is preserved.",
      );
    }
    return errorResult("agent_work report refused: a different report is already recorded for this work and cannot be rewritten.");
  }

  const files: NativeObservedFile[] = [];
  let totalBytes = 0;
  for (const relativePath of parsed.outputFiles) {
    const beforeFileSignal = selectedSignalFailure(signal, "while observing output files");
    if (beforeFileSignal !== null) return beforeFileSignal;
    const beforeFileSelected = selectedCurrentnessFailure(state, work, initialParent.parent);
    if (beforeFileSelected !== null) return beforeFileSelected;
    let file: NativeObservedFile;
    try {
      file = await observeWorkspaceFile(work.workspaceRoot, relativePath, state.fileIo, state.now());
    } catch (error) {
      const code = error instanceof NativeFileError ? ` (${error.code})` : "";
      return errorResult(
        `agent_work report refused output file ${JSON.stringify(relativePath)}${code}: ${errorMessage(error)} No report was recorded.`,
      );
    }
    totalBytes += file.bytes;
    if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
      return errorResult(
        `agent_work report refused: observed output files exceed ${MAX_OUTPUT_TOTAL_BYTES} bytes. No report was recorded.`,
      );
    }
    files.push(file);
  }

  // The synchronous refresh and its strict response shape check finish before
  // any final host or clock read. The already-captured pure revalidate callback
  // runs after all host reads, then only pure native checks may precede
  // publication.
  const finalRefresh = invokePreparedRefresh(prepared.refresh);
  if (!finalRefresh.ok) {
    return errorResult(`agent_work report refused: ${finalRefresh.reason}. No report was recorded.`);
  }
  const recordedAt = state.now();
  const finalLive = readSelectedLiveContext(state, context, signal, "while observing outputs");
  if (!finalLive.ok) return finalLive.result;
  const finalRevalidate = invokeFinalRevalidate(prepared.revalidate);
  if (!finalRevalidate.ok) {
    return errorResult(`agent_work report refused: ${finalRevalidate.reason}. No report was recorded.`);
  }

  // No callback property lookup, host getter or await may follow this point.
  const finalProblem = currentnessFailure(state, finalLive.live, binding, work, "final");
  if (finalProblem !== null) return finalProblem;
  const finalRouting = reportRoutingFailure(state, toolCallId, binding);
  if (finalRouting !== null) return finalRouting;
  const finalSelected = selectedCurrentnessFailure(state, work, initialParent.parent);
  if (finalSelected !== null) return finalSelected;
  const finalSignature = reportSignature(work, parsed);
  const invalidatedSelected = revalidateSelected(state, work, initialSelection.selected);
  if (invalidatedSelected !== null) return invalidatedSelected;
  if (work.report !== null) {
    if (work.reportSignature === finalSignature) {
      return successResult(
        clonePlain(work.report),
        "Existing identical report observed; this invocation's file reads were not published and the original recordedAt and byte observations are preserved.",
      );
    }
    return errorResult("agent_work report refused: a different report is already recorded for this work and cannot be rewritten.");
  }

  const report = buildReport(
    work,
    parsed,
    work.sessionId,
    work.workspaceRoot,
    initialSelection.selected,
    files,
    recordedAt,
    instanceFacts,
  );
  work.report = report;
  work.reportSignature = finalSignature;
  return successResult(
    clonePlain(report),
    "Recorded non-authoritative native work observations associated with one observed instance result; this is not semantic acceptance or verification.",
  );
}

async function executeReport(
  state: EntryState,
  toolCallId: string,
  parsed: ReportArguments,
  signal: AbortSignal | undefined,
  context: NativeContext,
): Promise<NativeToolResult> {
  if (parsed.instanceResult !== undefined) {
    return executeSelectedReport(state, toolCallId, parsed, parsed.instanceResult, signal, context);
  }
  if (isAborted(signal)) return errorResult("agent_work report was cancelled before any effect; no report was recorded.");
  const binding = state.reportBindings.get(toolCallId);
  if (binding === undefined) {
    return errorResult("agent_work report context is unavailable: no matching tool_call preflight was observed for this call id.");
  }
  const initialRouting = reportRoutingFailure(state, toolCallId, binding);
  if (initialRouting !== null) return initialRouting;
  if (binding.unavailableReason !== null) {
    return errorResult(`agent_work report is unavailable for this work: ${binding.unavailableReason}. No report was recorded.`);
  }
  const work = binding.work;
  if (work.invalidated) {
    return errorResult("agent_work report refused because its work association was invalidated. No report was recorded.");
  }
  if (work.evidenceState === "unavailable") {
    return errorResult(
      `agent_work report refused: ${work.evidenceUnavailableReason ?? "work evidence is unavailable"}. No report was recorded.`,
    );
  }
  if (work.sessionId === null || work.workspaceRoot === null) {
    return errorResult("agent_work report refused: session or workspace identity is unavailable. No report was recorded.");
  }

  // Finish host reads before judging currentness; reentrant getters may have
  // changed the live session/workspace/main/owner or invalidated the work.
  const initialLive = readLiveContext(state, context, signal);
  const initialProblem = currentnessFailure(state, initialLive, binding, work, "report");
  if (initialProblem !== null) return initialProblem;
  const initialRoutingAfterReads = reportRoutingFailure(state, toolCallId, binding);
  if (initialRoutingAfterReads !== null) return initialRoutingAfterReads;

  const signature = reportSignature(work, parsed);
  if (work.report !== null) {
    const replayLive = readLiveContext(state, context, signal);
    const replayProblem = currentnessFailure(state, replayLive, binding, work, "replay");
    if (replayProblem !== null) return replayProblem;
    const replayRouting = reportRoutingFailure(state, toolCallId, binding);
    if (replayRouting !== null) return replayRouting;
    const replaySelection = selectChecks(state, work, parsed.checks);
    if ("error" in replaySelection) return replaySelection.error;
    if (work.reportSignature === signature) {
      return successResult(clonePlain(work.report), "Existing identical report observed; it was not changed.");
    }
    return errorResult("agent_work report refused: a different report is already recorded for this work and cannot be rewritten.");
  }

  const selection = selectChecks(state, work, parsed.checks);
  if ("error" in selection) return selection.error;
  const selected = selection.selected;

  const files: NativeObservedFile[] = [];
  let totalBytes = 0;
  for (const relativePath of parsed.outputFiles) {
    if (isAborted(signal)) {
      return errorResult("agent_work report was cancelled while observing output files. No report was recorded.");
    }
    let file: NativeObservedFile;
    try {
      file = await observeWorkspaceFile(work.workspaceRoot, relativePath, state.fileIo, state.now());
    } catch (error) {
      const code = error instanceof NativeFileError ? ` (${error.code})` : "";
      return errorResult(
        `agent_work report refused output file ${JSON.stringify(relativePath)}${code}: ${errorMessage(error)} No report was recorded.`,
      );
    }
    totalBytes += file.bytes;
    if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
      return errorResult(
        `agent_work report refused: observed output files exceed ${MAX_OUTPUT_TOTAL_BYTES} bytes. No report was recorded.`,
      );
    }
    files.push(file);
  }

  // Final host reads, then pure currentness, then exact selected evidence
  // identity/availability. No await or host getter may follow revalidation
  // before the report is published.
  // The injected clock and every host getter must finish before judging.
  const recordedAt = state.now();
  const finalLive = readLiveContext(state, context, signal);
  const finalProblem = currentnessFailure(state, finalLive, binding, work, "final");
  if (finalProblem !== null) return finalProblem;
  const finalRouting = reportRoutingFailure(state, toolCallId, binding);
  if (finalRouting !== null) return finalRouting;

  const finalSignature = reportSignature(work, parsed);
  const invalidatedSelected = revalidateSelected(state, work, selected);
  if (invalidatedSelected !== null) return invalidatedSelected;
  if (work.report !== null) {
    if (work.reportSignature === finalSignature) {
      return successResult(clonePlain(work.report), "Existing identical report observed; it was not changed.");
    }
    return errorResult("agent_work report refused: a different report is already recorded for this work and cannot be rewritten.");
  }

  const report = buildReport(
    work,
    parsed,
    work.sessionId,
    work.workspaceRoot,
    selected,
    files,
    recordedAt,
    undefined,
  );
  work.report = report;
  work.reportSignature = finalSignature;
  return successResult(
    clonePlain(report),
    "Recorded non-authoritative native work observations; this is not managed acceptance or verification.",
  );
}

async function executeTool(
  state: EntryState,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  context: NativeContext,
): Promise<NativeToolResult> {
  if (state.disposed || !state.enabled) {
    return errorResult(`agent_work is disabled: ${state.disabledReason ?? "the entry is disposed"}. No effect occurred.`);
  }
  if (currentTaskOwner() !== undefined) {
    disable(state, "a managed TaskOwner is already published; this native work entry is disabled.");
    return errorResult("agent_work refused: a managed TaskOwner is now published. No effect occurred.");
  }
  if (!readMain(context)) {
    return errorResult("agent_work only records the main session's work; subagent calls are refused and no effect occurred.");
  }

  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(params);
  } catch (error) {
    return errorResult(errorMessage(error));
  }
  if (parsed.action === "inspect") return inspectResult(state, context);
  return executeReport(state, toolCallId, parsed, signal, context);
}

interface CallPortHost {
  readonly main: boolean;
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
  readonly ownerKnown: boolean;
  readonly ownerPresent: boolean;
}

interface ReadCallSelector {
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}

interface CallClassification {
  readonly state: NativeWorkCallState;
  readonly reason: NativeWorkCallReason;
}

function readCallSelector(selector: unknown): ReadCallSelector {
  let toolCallId: unknown;
  let toolName: unknown;
  try {
    if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
      return { ok: false, toolCallId: "", toolName: "" };
    }
    const record = selector as Record<string, unknown>;
    // Read both fields before judging so a reentrant selector getter is not
    // partially observed and then trusted.
    toolCallId = record.toolCallId;
    toolName = record.toolName;
  } catch {
    return { ok: false, toolCallId: "", toolName: "" };
  }
  const ok = typeof toolCallId === "string"
    && toolCallId.length >= 1
    && toolCallId.length <= MAX_TOOL_CALL_ID_CHARS
    && typeof toolName === "string"
    && toolName.length >= 1;
  return {
    ok,
    toolCallId: typeof toolCallId === "string" ? toolCallId : "",
    toolName: typeof toolName === "string" ? toolName : "",
  };
}

function readCallPortHost(context: NativeContext): CallPortHost {
  // Every context/selector getter is read before the final global ownership
  // read. A reentrant session/cwd getter may publish a managed owner, so the
  // owner must be observed last and then judged against a fresh state/Maps
  // read by the caller.
  const sessionId = readSessionId(context);
  const workspaceRoot = readWorkspace(context);
  let main = false;
  try {
    main = context.agent?.kind === "main";
  } catch {
    main = false;
  }
  let ownerKnown = true;
  let ownerPresent = false;
  try {
    ownerPresent = currentTaskOwner() !== undefined;
  } catch {
    ownerKnown = false;
  }
  return {
    main,
    sessionId,
    workspaceRoot,
    ownerKnown,
    ownerPresent,
  };
}

function callEntryFailure(state: EntryState, host: CallPortHost): NativeWorkCallReason | null {
  if (state.disposed) return "entry-disposed";
  if (!state.enabled) return "entry-disabled";
  if (!host.ownerKnown) return "live-identity-unavailable";
  if (host.ownerPresent) return "managed-owner-present";
  if (!host.main) return "not-main-context";
  if (host.sessionId === null || host.workspaceRoot === null) return "live-identity-unavailable";
  return null;
}

function referenceCopy(source: NativeWorkCallReference): NativeWorkCallReference {
  return deepFreeze({
    observationId: source.observationId,
    generation: source.generation,
    sessionId: source.sessionId,
    workspaceRoot: source.workspaceRoot,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
  });
}

function callInspection(
  state: EntryState,
  stateName: NativeWorkCallState,
  reason: NativeWorkCallReason,
  association: NativeWorkCallReference | null,
  work: Work | null,
  call: ObservedCall | null,
): NativeWorkCallInspection {
  return deepFreeze({
    schema: NATIVE_WORK_CALL_INSPECTION_SCHEMA,
    authority: "non-authoritative",
    state: stateName,
    reason,
    association: association === null ? null : referenceCopy(association),
    workPhase: work === null ? null : work.status,
    requestAttribution: work === null ? null : work.requestAttribution,
    evidenceState: work === null ? null : work.evidenceState,
    callResultState: call === null ? null : call.resultState,
    pendingInputCount: work === null ? null : state.pending.length,
    pendingInputsDropped: work === null ? null : state.pendingDropped,
  });
}

function captureFailure(
  state: EntryState,
  stateName: NativeWorkCallState,
  reason: NativeWorkCallReason,
  work: Work | null = null,
  call: ObservedCall | null = null,
): NativeWorkCallCapture {
  return deepFreeze({
    ok: false as const,
    ref: null,
    inspection: callInspection(state, stateName, reason, null, work, call),
  });
}

function classifyCallAssociation(
  state: EntryState,
  work: Work,
  call: ObservedCall,
): CallClassification {
  if (work.evidenceState === "unavailable") {
    return { state: "unavailable", reason: "work-evidence-unavailable" };
  }
  if (call.resultState === "unknown") {
    return { state: "unavailable", reason: "call-evidence-unknown" };
  }
  if (state.pendingDropped > 0) {
    return { state: "suspended", reason: "input-history-truncated" };
  }
  if (state.pending.length > 0) {
    return { state: "suspended", reason: "pending-input" };
  }
  if (work.evidenceState === "unknown-source" || work.requestAttribution !== "matched-user-input") {
    return { state: "suspended", reason: "unknown-input-source" };
  }
  if (work.status === "ended") return { state: "ended", reason: "work-ended" };
  if (work.status === "active") return { state: "current", reason: "current-work" };
  return { state: "unavailable", reason: "binding-inconsistent" };
}

function captureCall(
  state: EntryState,
  issuedReferences: WeakSet<object>,
  selector: unknown,
  context: NativeContext,
): NativeWorkCallCapture {
  // Potential getters finish before any state/Maps judgement.
  const selected = readCallSelector(selector);
  const host = readCallPortHost(context);
  const entryFailure = callEntryFailure(state, host);
  if (!selected.ok) return captureFailure(state, "unavailable", "invalid-selector");
  if (entryFailure !== null) return captureFailure(state, "unavailable", entryFailure);

  const toolCallId = selected.toolCallId;
  const binding = state.callBindings.get(toolCallId);
  if (binding === undefined) return captureFailure(state, "unavailable", "call-not-observed");
  const work = binding.work;
  const call = binding.call;
  if (call.toolCallId !== toolCallId || call.toolName !== selected.toolName) {
    return captureFailure(state, "unavailable", "call-not-observed", work, call);
  }
  if (!state.works.includes(work)) {
    return captureFailure(state, "stale", "work-not-retained", work, call);
  }
  if (work.invalidated) {
    return captureFailure(state, "stale", "work-invalidated", work, call);
  }
  if (work.callIndex.get(toolCallId) !== call || state.callBindings.get(toolCallId) !== binding) {
    return captureFailure(state, "unavailable", "binding-inconsistent", work, call);
  }
  if (call.associationConflict) {
    return captureFailure(state, "stale", "call-conflicted", work, call);
  }
  if (state.callIdMemory.get(toolCallId) !== work.generation) {
    return captureFailure(state, "unavailable", "binding-inconsistent", work, call);
  }
  if (state.current !== work) {
    return captureFailure(state, "stale", "work-replaced", work, call);
  }
  if (work.sessionId === null || work.workspaceRoot === null) {
    return captureFailure(state, "unavailable", "work-evidence-unavailable", work, call);
  }
  if (host.sessionId !== work.sessionId) {
    return captureFailure(state, "stale", "live-session-changed", work, call);
  }
  if (host.workspaceRoot !== work.workspaceRoot) {
    return captureFailure(state, "stale", "live-workspace-changed", work, call);
  }

  const classification = classifyCallAssociation(state, work, call);
  if (classification.state !== "current"
    && classification.state !== "suspended"
    && classification.state !== "ended") {
    return captureFailure(state, classification.state, classification.reason, work, call);
  }

  const ref: NativeWorkCallReference = {
    observationId: work.observationId,
    generation: work.generation,
    sessionId: work.sessionId,
    workspaceRoot: work.workspaceRoot,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
  };
  issuedReferences.add(ref);
  deepFreeze(ref);
  return deepFreeze({
    ok: true as const,
    ref,
    inspection: callInspection(
      state,
      classification.state,
      classification.reason,
      ref,
      work,
      call,
    ),
  });
}

function readIssuedReference(ref: unknown): NativeWorkCallReference | null {
  try {
    const record = ref as Record<string, unknown>;
    const observationId = record.observationId;
    const generation = record.generation;
    const sessionId = record.sessionId;
    const workspaceRoot = record.workspaceRoot;
    const toolCallId = record.toolCallId;
    const toolName = record.toolName;
    if (
      typeof observationId !== "string"
      || observationId.length < 1
      || typeof generation !== "number"
      || !Number.isSafeInteger(generation)
      || generation < 1
      || typeof sessionId !== "string"
      || sessionId.length < 1
      || typeof workspaceRoot !== "string"
      || workspaceRoot.length < 1
      || typeof toolCallId !== "string"
      || toolCallId.length < 1
      || toolCallId.length > MAX_TOOL_CALL_ID_CHARS
      || typeof toolName !== "string"
      || toolName.length < 1
    ) {
      return null;
    }
    return {
      observationId,
      generation,
      sessionId,
      workspaceRoot,
      toolCallId,
      toolName,
    };
  } catch {
    return null;
  }
}

function inspectCall(
  state: EntryState,
  issuedReferences: WeakSet<object>,
  ref: unknown,
  context: NativeContext,
): NativeWorkCallInspection {
  // Membership is checked before reading any ref getter. Clones, JSON copies
  // and refs issued by another controls instance are foreign.
  if (ref === null
    || (typeof ref !== "object" && typeof ref !== "function")
    || !issuedReferences.has(ref as object)) {
    return callInspection(state, "unavailable", "foreign-reference", null, null, null);
  }
  const observed = readIssuedReference(ref);
  if (observed === null) {
    return callInspection(state, "unavailable", "foreign-reference", null, null, null);
  }
  const host = readCallPortHost(context);
  const entryFailure = callEntryFailure(state, host);
  if (entryFailure !== null) {
    return callInspection(state, "unavailable", entryFailure, observed, null, null);
  }

  const work = state.works.find((candidate) =>
    candidate.observationId === observed.observationId
    && candidate.generation === observed.generation
  ) ?? null;
  if (work === null) {
    return callInspection(state, "stale", "work-not-retained", observed, null, null);
  }
  if (work.sessionId !== observed.sessionId || work.workspaceRoot !== observed.workspaceRoot) {
    return callInspection(state, "stale", "work-replaced", observed, work, null);
  }
  if (work.invalidated) {
    return callInspection(state, "stale", "work-invalidated", observed, work, null);
  }
  const call = work.callIndex.get(observed.toolCallId);
  if (call === undefined) {
    return callInspection(state, "stale", "call-not-retained", observed, work, null);
  }
  if (call.toolCallId !== observed.toolCallId || call.toolName !== observed.toolName) {
    return callInspection(state, "stale", "call-rebound", observed, work, call);
  }
  const binding = state.callBindings.get(observed.toolCallId);
  if (binding === undefined) {
    return callInspection(state, "stale", "call-not-retained", observed, work, call);
  }
  if (binding.work !== work || binding.call !== call) {
    return callInspection(state, "stale", "call-rebound", observed, work, call);
  }
  if (call.associationConflict) {
    return callInspection(state, "stale", "call-conflicted", observed, work, call);
  }
  if (state.callIdMemory.get(observed.toolCallId) !== work.generation) {
    return callInspection(state, "stale", "call-rebound", observed, work, call);
  }
  if (state.current !== work) {
    return callInspection(state, "stale", "work-replaced", observed, work, call);
  }
  if (work.sessionId === null || work.workspaceRoot === null) {
    return callInspection(state, "unavailable", "work-evidence-unavailable", observed, work, call);
  }
  if (host.sessionId !== work.sessionId) {
    return callInspection(state, "stale", "live-session-changed", observed, work, call);
  }
  if (host.workspaceRoot !== work.workspaceRoot) {
    return callInspection(state, "stale", "live-workspace-changed", observed, work, call);
  }

  const classification = classifyCallAssociation(state, work, call);
  return callInspection(
    state,
    classification.state,
    classification.reason,
    observed,
    work,
    call,
  );
}

function createControls(state: EntryState): NativeEntryControls {
  const issuedReferences = new WeakSet<object>();
  return {
    get enabled() {
      return state.enabled;
    },
    get disabledReason() {
      return state.disabledReason;
    },
    isEnabled() {
      return state.enabled && !state.disposed;
    },
    dispose() {
      disposeState(state, "disposed by the host or test owner");
    },
    captureCall(selector, context) {
      return captureCall(state, issuedReferences, selector, context);
    },
    inspectCall(ref, context) {
      return inspectCall(state, issuedReferences, ref, context);
    },
  };
}

const AGENT_WORK_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["inspect", "report"],
      description: "Inspect retained non-authoritative work facts, or report real completed calls from this same work.",
    },
    checks: {
      type: "array",
      maxItems: MAX_CHECK_SELECTIONS,
      items: {
        type: "object",
        properties: {
          toolCallId: { type: "string", description: "Exact id of a completed tool call observed in this same work." },
          purpose: { type: "string", description: "Model-declared purpose of that call, not a host verification claim." },
        },
        required: ["toolCallId", "purpose"],
        additionalProperties: false,
      },
      description: "Completed calls to record; agent_work calls and calls without observed results cannot be selected.",
    },
    outputFiles: {
      type: "array",
      maxItems: MAX_OUTPUT_FILES,
      items: { type: "string" },
      description: `Optional workspace-relative UTF-8 text files (max ${MAX_OUTPUT_FILES}, ${MAX_OUTPUT_FILE_BYTES} bytes each, ${MAX_OUTPUT_TOTAL_BYTES} total).`,
    },
    outcome: {
      type: "string",
      enum: ["completed", "insufficient", "blocked"],
      description: "Model-declared request outcome. This is not host acceptance.",
    },
    summary: {
      type: "string",
      maxLength: MAX_SUMMARY_CHARS,
      description: "Optional concise model-declared summary.",
    },
    limitations: {
      type: "array",
      maxItems: MAX_LIMITATIONS,
      items: { type: "string", maxLength: MAX_LIMITATION_CHARS },
      description: "Model-declared limitations or unverified coverage.",
    },
    instanceResult: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_CALL_ID_CHARS,
          description: "Observed instance id copied exactly from agent_work inspect instanceResults.",
        },
        parentToolCallId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TOOL_CALL_ID_CHARS,
          description: "Observed parent task call id; it must also appear in checks.",
        },
        envelopeSha256: {
          type: "string",
          pattern: "^[0-9a-f]{64}$",
          description: "Lowercase sha256 of the observed complete task tool_result envelope.",
        },
      },
      required: ["instanceId", "parentToolCallId", "envelopeSha256"],
      additionalProperties: false,
      description: "Optional one observed native instance result for this report. Selectors come only from inspect; byte/file observations do not establish semantic acceptance.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export function createNativeEntry(pi: NativeOmpApi, options: NativeEntryOptions = {}): NativeEntryControls {
  const state = createState(options);
  if (currentTaskOwner() !== undefined) {
    state.enabled = false;
    state.disabledReason = "a managed TaskOwner is already published; this native work entry is disabled.";
    return createControls(state);
  }

  try {
    pi.registerTool({
      name: NATIVE_WORK_TOOL,
      label: "Native work observation",
      description:
        "Inspect or record bounded non-authoritative observations of the current main-session work. inspect shows retained work, observed call facts, and bounded candidate selectors for observed native instance results. report selects only real completed tool call ids from this same work, with model-declared purposes, outcome and limitations, plus optional workspace-relative text output files. An optional instanceResult selector associates all reported output files with exactly one observed result; its parent task call must be in checks and its ids/digest must come from inspect. Selected file hashes are bytes read during the report, not original child delivery, exclusive authorship, commit-time filesystem state, semantic acceptance or verification. It creates no managed task, authority, acceptance or verification, blocks no native tool, and reports this plugin's tool_result observations after any earlier middleware. agent_work calls cannot be selected as checks.",
      parameters: AGENT_WORK_PARAMETERS,
      approval: "read",
      loadMode: "essential",
      execute: (toolCallId, params, signal, _onUpdate, context) =>
        executeTool(state, toolCallId, params, signal, context),
    });
    pi.on("input", (event, context) => onInput(state, event as InputEventLike, context));
    pi.on("before_agent_start", (event, context) => onBeforeAgentStart(state, event as BeforeAgentStartLike, context));
    pi.on("tool_call", (event, context) => {
      recordToolCall(state, event as ToolCallLike, context);
    });
    pi.on("tool_result", (event, context) => {
      onToolResult(state, event as ToolResultLike, context);
    });
    pi.on("agent_end", (event, context) => onAgentEnd(state, event as AgentEndLike, context));
    pi.on("session_stop", (event, context) => onSessionStop(state, event as SessionStopLike, context));
    pi.on("session_start", (_event, context) => onNavigation(state, context, "session start invalidated live observations"));
    pi.on("session_switch", (_event, context) => onNavigation(state, context, "session switch invalidated live observations"));
    pi.on("session_branch", (_event, context) => onNavigation(state, context, "session branch invalidated live observations"));
    pi.on("session_tree", (_event, context) => onNavigation(state, context, "session tree navigation invalidated live observations"));
    pi.on("session_clear", (_event, context) => onNavigation(state, context, "session clear invalidated live observations"));
    pi.on("session_shutdown", (_event, context) => {
      if (readMain(context)) disposeState(state, "session shutdown disabled callbacks");
    });
  } catch (error) {
    disposeState(state, "registration failed");
    throw error;
  }
  return createControls(state);
}

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({
      type: "omp_agent_native_entry",
      message,
      ...(details === undefined ? {} : { details }),
    })}\n`);
  } catch {
    // Observability must not break the host.
  }
}

export default function nativeEntry(pi: NativeOmpApi): void {
  try {
    createNativeEntry(pi);
  } catch (error) {
    stderr("native_entry_disabled", { reason: errorMessage(error) });
  }
}
