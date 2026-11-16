import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_HISTORY_LIMITS,
  NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
  decodeNativeHarnessHistoryLocator,
  inspectNativeHarnessHistory,
  type NativeHarnessHistoryDeclaredArtifact,
  type NativeHarnessHistoryInspection,
  type NativeHarnessHistoryLocator,
  type NativeHarnessHistoryReason,
} from "./native-harness-history.ts";
import type { NativeHarnessHistoryProcessOsObserver } from "./native-harness-history-process.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import {
  NATIVE_WORK_INTERFACE,
  NATIVE_WORK_TOOL,
  captureWorkspaceText,
  deepFreeze,
  nodeFileIo,
  validateRelativePath,
  type NativeFileIo,
  type NativeFileStats,
} from "./native-work.ts";
import { parseBranch, type BranchEntry } from "./task-branch.ts";

/**
 * R1b1 bounded native-history session/index leaf.
 *
 * This module owns exactly one optional OMP custom-entry index over one actual
 * main session branch. It does not own a TaskOwner, Work, report, Handoff,
 * Controller, OS process observation, resume path or a second event store.
 * Candidate facts are supplied by the caller from the existing coordinator
 * and backend diagnostics; this leaf validates their relationships but cannot
 * prove callback origin, real host wiring, restart or process state.
 *
 * One terminal publication callback owns the leaf at a time. The latch is
 * taken synchronously and released only after disk readback; overlapping
 * callbacks are refused, never queued. A started ensureOnDisk promise stays
 * observed until it settles, so a bounded wait timeout never permits a second
 * append or ensure.
 */

export const NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE =
  "omp-agent.native-harness-history.locator" as const;
export const NATIVE_HARNESS_HISTORY_SESSION_SCHEMA =
  "omp-agent.native-harness-history-session.v1" as const;
export const NATIVE_HARNESS_HISTORY_SOURCE_PROJECTION =
  "omp-agent.native-harness-source-observation.v1" as const;
export const NATIVE_HARNESS_HISTORY_REPORT_PROJECTION =
  "omp-agent.native-harness-report-observation.v1" as const;

/** Existing producer wire names, copied here so the leaf imports no state machine. */
const HARNESS_TOOL = "agent_harness" as const;
const HARNESS_RESULT_SCHEMA = "omp-agent.native-harness-tool-result.v1";
const REPORT_BINDING_SCHEMA = "omp-agent.native-harness-report-binding.v1";
const REPORT_REREAD_SCHEMA = "omp-agent.native-harness-report-reread.v1";

export const NATIVE_HARNESS_HISTORY_SESSION_LIMITS = Object.freeze({
  branchEntries: 4096,
  locators: 128,
  locatorBytes: 4096,
  pageRows: 16,
  candidates: 16,
  attempts: 128,
  ensureOnDiskMs: 2000,
  sessionFileBytes: 256 * 1024,
  sessionFileLines: 8192,
  declaredArtifacts: 8,
  resultBytes: 64 * 1024,
  reasonChars: 320,
  resultReasons: 8,
  labelChars: 256,
  pathChars: 4096,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HARNESS_DIRECTORY_PATTERN = /^omp-harness-[A-Za-z0-9]{6}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

const HARNESS_OUTCOMES = Object.freeze([
  "refused",
  "backend-completed",
  "backend-failed",
  "backend-cancelled",
  "cancelled",
  "timed-out",
  "incomplete",
  "unknown",
] as const);
const HARNESS_BACKEND_STATUSES = Object.freeze([
  "queued",
  "running",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
  "applied",
] as const);
const HARNESS_EXECUTION_STATES = Object.freeze(["not-started", "settled", "pending-unknown"] as const);
const HARNESS_TERMINATIONS = Object.freeze([
  "none",
  "cancelled",
  "deadline",
  "disposed",
  "authority-lost",
  "backend-failed",
] as const);
const HARNESS_CANCELLATIONS = Object.freeze(["none", "requested", "request-failed"] as const);
const REPORT_OUTCOMES = Object.freeze(["completed", "insufficient", "blocked"] as const);

export interface NativeHarnessHistorySessionAssociation {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName: typeof HARNESS_TOOL;
}

export interface NativeHarnessHistoryBackendFacts {
  readonly preparedRoot: string;
  readonly storeRoot: string;
  readonly inputManifestSha256: string | null;
}

/**
 * Read-only data snapshot joined by the future instanced adapter from the
 * existing coordinator operation and its unique matching backend diagnostic.
 * It is not authority and it is never queried from a model path.
 */
export interface NativeHarnessHistorySourceCandidate {
  readonly association: NativeHarnessHistorySessionAssociation;
  readonly runId: string;
  readonly backend: NativeHarnessHistoryBackendFacts;
  readonly definitionVersion: string | null;
  readonly backendSourceId: string | null;
  readonly configurationSha256: string | null;
}

export interface NativeHarnessHistorySessionOptions {
  /** Canonical host storage root; the same fixed root used by the backend. */
  readonly storageRoot: string;
  /** Actual public `pi.appendEntry`; absent leaves new publication unavailable. */
  readonly appendEntry?: (customType: string, data?: unknown) => void;
  /**
   * Narrow owning-root currentness/identity callback from the future adapter.
   * It receives the same actual context on every check so a foreign main
   * context can be refused without pinning history to a first-ever context.
   */
  readonly isOwnerCurrent: (context: unknown) => boolean;
  readonly now?: () => number;
  readonly fileIo?: NativeFileIo;
  /**
   * Optional trusted bounded OS observer. Omission keeps the old
   * uninspected process projection and starts no extra owner/OS work.
   */
  readonly processObserver?: NativeHarnessHistoryProcessOsObserver;
  /** Test seam may lower the fixed 2s persistence profile, never raise it. */
  readonly ensureOnDiskTimeoutMs?: number;
}

export type NativeHarnessHistoryPublicationOutcome =
  | "disk-confirmed"
  | "visible"
  | "already-visible"
  | "unknown"
  | "unavailable"
  | "pending"
  | "not-attempted";

export interface NativeHarnessHistoryPublication {
  readonly toolCallId: string | null;
  readonly runId: string | null;
  readonly outcome: NativeHarnessHistoryPublicationOutcome;
  readonly entryId: string | null;
  readonly locatorSha256: string | null;
  /** `observed-only` is local file readback at one moment, not durability. */
  readonly durability: "observed-only" | "unknown";
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

export interface NativeHarnessHistoryPublicationResult {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_SESSION_SCHEMA;
  readonly state: "ignored" | "published" | "partial" | "unknown" | "unavailable";
  readonly publications: readonly NativeHarnessHistoryPublication[];
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

export interface NativeHarnessHistoryListPage {
  readonly offset?: number;
  readonly limit?: number;
}

export interface NativeHarnessHistoryListRow {
  readonly entryId: string;
  readonly decode: "ok" | "invalid";
  readonly locatorSha256: string | null;
  readonly runId: string | null;
  readonly toolCallId: string | null;
  /** Label-only comparison with the current main session/workspace. */
  readonly labelCompatibility: "match" | "mismatch" | "unknown";
}

export interface NativeHarnessHistoryListResult {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_SESSION_SCHEMA;
  readonly state: "complete" | "incomplete" | "invalid" | "unavailable";
  readonly rows: readonly NativeHarnessHistoryListRow[];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
    readonly returned: number;
    readonly nextOffset: number | null;
  };
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

export interface NativeHarnessHistorySelector {
  readonly entryId: string;
  readonly locatorSha256: string;
}

export type NativeHarnessHistoryEvidenceState =
  | "match"
  | "mismatch"
  | "not-present"
  | "unavailable";

export interface NativeHarnessHistorySessionInspection {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_SESSION_SCHEMA;
  readonly state: "observed" | "partial" | "uncertain" | "unavailable" | "aborted" | "invalidated";
  readonly selector: NativeHarnessHistorySelector;
  readonly locator: NativeHarnessHistoryLocator | null;
  readonly labels: {
    readonly originSession: "match" | "mismatch" | "unknown";
    readonly workspace: "match" | "mismatch" | "unknown";
  };
  readonly evidence: {
    readonly source: NativeHarnessHistoryEvidenceState;
    readonly report: NativeHarnessHistoryEvidenceState;
  };
  readonly declaration: {
    readonly state: "absent" | "empty" | "present" | "invalid";
    readonly files: number;
    readonly reportEntryId: string | null;
    readonly problem: NativeHarnessHistoryReason | null;
  };
  readonly current: boolean;
  readonly inspection: NativeHarnessHistoryInspection | null;
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

export interface NativeHarnessHistorySessionStatus {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_SESSION_SCHEMA;
  readonly disposed: boolean;
  readonly append: "available" | "unavailable";
  readonly attempts: number;
  readonly diskConfirmed: number;
  readonly visible: number;
  readonly unknown: number;
  readonly pending: number;
  readonly unavailable: number;
  /** True while one terminal publication owns the single publication latch. */
  readonly publishing: boolean;
  /** True while an actual ensureOnDisk promise is observed but not settled. */
  readonly persistPending: boolean;
  readonly lastReason: NativeHarnessHistoryReason | null;
}

export interface NativeHarnessHistorySession {
  publishTerminal(
    context: unknown,
    actualTerminalEvent: unknown,
    hostSourceCandidates: readonly NativeHarnessHistorySourceCandidate[],
  ): Promise<NativeHarnessHistoryPublicationResult>;
  list(
    context: unknown,
    page?: NativeHarnessHistoryListPage,
  ): NativeHarnessHistoryListResult;
  inspect(
    context: unknown,
    selector: NativeHarnessHistorySelector,
    actualSignal: unknown,
  ): Promise<NativeHarnessHistorySessionInspection>;
  status(): NativeHarnessHistorySessionStatus;
  dispose(): void;
}

class ObservationFailure extends Error {
  override name = "ObservationFailure";
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
  }
}

function fail(code: string, detail: string): never {
  throw new ObservationFailure(code, detail);
}

function reason(code: string, detail: string): NativeHarnessHistoryReason {
  const flat = detail.replace(/\s+/g, " ").trim();
  const bounded = flat.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.reasonChars
    ? flat
    : `${flat.slice(0, NATIVE_HARNESS_HISTORY_SESSION_LIMITS.reasonChars - 3)}...`;
  return Object.freeze({
    code: code.length <= 64 ? code : "reason",
    detail: bounded,
  });
}

function boundedReasons(values: readonly NativeHarnessHistoryReason[]): readonly NativeHarnessHistoryReason[] {
  return Object.freeze(values.slice(0, NATIVE_HARNESS_HISTORY_SESSION_LIMITS.resultReasons));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asRecord(value: unknown, detail: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail("shape", detail);
  return value;
}

/**
 * Trusted host capability context only. The actual host composes its handler
 * context with Object.create(baseCtx), so agent/cwd/sessionManager may live on
 * the inherited chain. This structural read stays confined to that context and
 * its agent; persisted JSON, candidates and selectors keep the strict plain
 * record checks above.
 */
function capabilityRecord(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("shape", detail);
  return value as Record<string, unknown>;
}

function capabilityField(value: unknown, key: string, detail: string): unknown {
  return capabilityRecord(value, detail)[key];
}

function capabilityTextField(value: unknown, key: string, max: number, detail: string): string {
  const raw = capabilityField(value, key, detail);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || CONTROL_PATTERN.test(raw)) {
    fail("field", detail);
  }
  return raw;
}

function field(value: unknown, key: string, detail: string): unknown {
  const record = asRecord(value, detail);
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) fail("shape", detail);
  return descriptor.value;
}

function optionalField(value: unknown, key: string): unknown | undefined {
  if (!isPlainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) fail("shape", "A recorded field is not a plain data property.");
  return descriptor.value;
}

function textField(value: unknown, key: string, max: number, detail: string): string {
  const raw = field(value, key, detail);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || CONTROL_PATTERN.test(raw)) {
    fail("field", detail);
  }
  return raw;
}

function nullableTextField(value: unknown, key: string, max: number, detail: string): string | null {
  const raw = field(value, key, detail);
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || CONTROL_PATTERN.test(raw)) {
    fail("field", detail);
  }
  return raw;
}

function shaField(value: unknown, key: string, detail: string): string {
  const raw = textField(value, key, 64, detail);
  if (!SHA256_PATTERN.test(raw)) fail("field", detail);
  return raw;
}

function nullableShaField(value: unknown, key: string, detail: string): string | null {
  const raw = field(value, key, detail);
  if (raw === null) return null;
  if (typeof raw !== "string" || !SHA256_PATTERN.test(raw)) fail("field", detail);
  return raw;
}

function countField(value: unknown, key: string, max: number, detail: string): number {
  const raw = field(value, key, detail);
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) {
    fail("field", detail);
  }
  return raw as number;
}

function moneyField(value: unknown, key: string, detail: string): number {
  const raw = field(value, key, detail);
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) fail("field", detail);
  return raw;
}

function nullableMoneyField(value: unknown, key: string, detail: string): number | null {
  const raw = field(value, key, detail);
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) fail("field", detail);
  return raw;
}

function nullableCountField(value: unknown, key: string, max: number, detail: string): number | null {
  const raw = field(value, key, detail);
  if (raw === null) return null;
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) {
    fail("field", detail);
  }
  return raw as number;
}

function booleanField(value: unknown, key: string, detail: string): boolean {
  const raw = field(value, key, detail);
  if (typeof raw !== "boolean") fail("field", detail);
  return raw;
}

function enumField<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  detail: string,
): T {
  const raw = textField(value, key, 64, detail);
  if (!allowed.includes(raw as T)) fail("field", detail);
  return raw as T;
}

function nullableEnumField<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  detail: string,
): T | null {
  const raw = field(value, key, detail);
  if (raw === null) return null;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) fail("field", detail);
  return raw as T;
}

function arrayItems(value: unknown, key: string, max: number, detail: string): readonly unknown[] {
  const raw = field(value, key, detail);
  if (!Array.isArray(raw) || raw.length > max) fail("field", detail);
  const items: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (descriptor === undefined || !("value" in descriptor)) fail("field", detail);
    items.push(descriptor.value);
  }
  return items;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars
    && !value.includes("\0")
    && !CONTROL_PATTERN.test(value)
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value !== path.parse(value).root;
}

function boundedLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars
    && !CONTROL_PATTERN.test(value);
}

function canonicalSha(value: unknown): string | null {
  const fingerprint = fingerprintNativeJson(value);
  return fingerprint.ok ? fingerprint.sha256 : null;
}

function canonicalBytes(value: unknown): number | null {
  const fingerprint = fingerprintNativeJson(value);
  return fingerprint.ok ? fingerprint.bytes : null;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftSha = canonicalSha(left);
  const rightSha = canonicalSha(right);
  return leftSha !== null && rightSha !== null && leftSha === rightSha;
}

function dataText(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

function managerCall(manager: object, name: string): unknown {
  const callable = (manager as Record<string, unknown>)[name];
  if (typeof callable !== "function") {
    fail("manager", "The session manager lacks a required structural capability.");
  }
  try {
    return Reflect.apply(callable, manager, []);
  } catch {
    fail("manager", "The session manager capability was unavailable.");
  }
}

interface SessionBase {
  readonly manager: object;
  readonly sessionId: string;
  readonly cwd: string;
  readonly recordedCwd: string;
  readonly leafId: string | null;
  readonly branch: readonly unknown[];
}

interface PublicationBase extends SessionBase {
  readonly sessionDir: string;
  readonly file: string;
}

type ContextRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: NativeHarnessHistoryReason };

function readSessionBase(context: unknown): ContextRead<SessionBase> {
  try {
    const record = capabilityRecord(context, "The actual main context is unavailable.");
    const agent = capabilityField(record, "agent", "The actual main agent kind is unavailable.");
    if (capabilityField(agent, "kind", "The actual main agent kind is unavailable") !== "main") {
      return {
        ok: false,
        code: "not-main",
        reason: reason("not-main", "Only the actual main session may publish or query native history."),
      };
    }
    const contextCwd = capabilityTextField(
      record,
      "cwd",
      NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars,
      "The actual context workspace is unavailable.",
    );
    if (!isCanonicalAbsolutePath(contextCwd)) fail("cwd", "The actual context workspace is not canonical.");
    const manager = capabilityField(record, "sessionManager", "The actual session manager is unavailable.");
    if (typeof manager !== "object" || manager === null) fail("manager", "The actual session manager is unavailable.");
    const sessionIdRaw = managerCall(manager, "getSessionId");
    if (!boundedLabel(sessionIdRaw)) fail("session", "The actual session id is unavailable.");
    const cwdRaw = managerCall(manager, "getCwd");
    if (!isCanonicalAbsolutePath(cwdRaw)) fail("session", "The live session workspace is not canonical.");
    if (path.resolve(contextCwd) !== cwdRaw) fail("session", "The context and live session workspaces differ.");
    const recordedCwdRaw = managerCall(manager, "getRecordedCwd");
    if (!isCanonicalAbsolutePath(recordedCwdRaw)) fail("session", "The recorded session workspace is not canonical.");
    const leafRaw = managerCall(manager, "getLeafId");
    if (leafRaw !== null && !boundedLabel(leafRaw)) fail("session", "The selected session leaf is unavailable.");
    const branchRaw = managerCall(manager, "getBranch");
    if (!Array.isArray(branchRaw)) fail("branch", "The actual session branch is not an array.");
    if (branchRaw.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
      fail("branch", "The actual session branch exceeds its fixed traversal bound.");
    }
    return {
      ok: true,
      value: {
        manager,
        sessionId: sessionIdRaw,
        cwd: cwdRaw,
        recordedCwd: recordedCwdRaw,
        leafId: leafRaw === null ? null : leafRaw,
        branch: [...branchRaw],
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ObservationFailure ? error.code : "session",
      reason: reason(
        "session-unavailable",
        error instanceof ObservationFailure
          ? error.detail
          : "The actual session identity could not be read.",
      ),
    };
  }
}

function readPublicationBase(context: unknown): ContextRead<PublicationBase> {
  const base = readSessionBase(context);
  if (!base.ok) return base;
  try {
    const directory = managerCall(base.value.manager, "getSessionDir");
    if (!isCanonicalAbsolutePath(directory)) fail("session", "The actual session directory is not canonical.");
    const file = managerCall(base.value.manager, "getSessionFile");
    if (typeof file !== "string" || !isCanonicalAbsolutePath(file)) {
      fail("session", "The actual local session file is unavailable.");
    }
    if (path.dirname(file) !== directory) fail("session", "The session file is not directly below its session directory.");
    const name = path.basename(file);
    if (
      name.length === 0
      || name.length > 255
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || CONTROL_PATTERN.test(name)
    ) {
      fail("session", "The actual session file name is not a plain child name.");
    }
    return { ok: true, value: { ...base.value, sessionDir: directory, file } };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ObservationFailure ? error.code : "session",
      reason: reason(
        "session-file-unavailable",
        error instanceof ObservationFailure
          ? error.detail
          : "The actual local session file could not be read.",
      ),
    };
  }
}

function sameBase(left: SessionBase, right: SessionBase): boolean {
  return left.manager === right.manager
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.recordedCwd === right.recordedCwd;
}

function samePublicationBase(left: PublicationBase, right: PublicationBase): boolean {
  return sameBase(left, right) && left.sessionDir === right.sessionDir && left.file === right.file;
}

function parseActiveBranch(branch: readonly unknown[], leafId: string | null): BranchEntry[] {
  if (branch.length === 0) {
    if (leafId !== null) fail("branch", "The selected leaf is set but the branch is empty.");
    return [];
  }
  if (branch.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
    fail("branch", "The session branch exceeds its fixed traversal bound.");
  }
  let entries: BranchEntry[];
  try {
    entries = parseBranch(branch);
  } catch {
    fail("branch", "The session branch is malformed.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const expectedParent = index === 0 ? null : entries[index - 1]!.id;
    if (entries[index]!.parentId !== expectedParent) {
      fail("branch", "The session branch is not one contiguous ancestor chain.");
    }
  }
  if (leafId === null || entries[entries.length - 1]!.id !== leafId) {
    fail("branch", "The selected leaf is not the actual branch end.");
  }
  return entries;
}

interface NormalizedSource {
  readonly entry: BranchEntry;
  readonly index: number;
  readonly entryId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly toolCallId: string;
}

interface NormalizedReport {
  readonly entry: BranchEntry;
  readonly index: number;
  readonly entryId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly toolCallId: string;
  readonly outcome: typeof REPORT_OUTCOMES[number];
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

interface EvidenceReference {
  readonly entryId: string;
  readonly sha256: string;
}

function toolResultMessage(entry: BranchEntry): Record<string, unknown> {
  if (entry.type !== "message") fail("shape", "The selected transcript entry is not a message.");
  const message = field(entry.value, "message", "The selected transcript message is unavailable.");
  const record = asRecord(message, "The selected transcript message is unavailable.");
  if (field(record, "role", "The selected transcript message role is unavailable.") !== "toolResult") {
    fail("shape", "The selected transcript message is not a tool result.");
  }
  return record;
}

function sourceProjection(entry: BranchEntry, expectedRunId: string, expectedToolCallId: string): NormalizedSource {
  const message = toolResultMessage(entry);
  const toolCallId = textField(message, "toolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The source tool-call id is unavailable.");
  if (toolCallId !== expectedToolCallId) fail("source", "The source tool-call id does not match the candidate.");
  const toolName = textField(message, "toolName", 64, "The source tool name is unavailable.");
  if (toolName !== HARNESS_TOOL) fail("source", "The source tool result is not the native Harness tool.");
  const errorValue = optionalField(message, "isError");
  if (errorValue !== undefined && typeof errorValue !== "boolean") fail("source", "The source error flag is malformed.");
  const details = field(message, "details", "The source result details are unavailable.");
  const record = asRecord(details, "The source result details are unavailable.");
  if (enumField(record, "schema", [HARNESS_RESULT_SCHEMA] as const, "The source result schema is unsupported.") !== HARNESS_RESULT_SCHEMA) {
    fail("source", "The source result schema is unsupported.");
  }
  if (enumField(record, "tool", [HARNESS_TOOL] as const, "The source result tool is unsupported.") !== HARNESS_TOOL) {
    fail("source", "The source result tool is unsupported.");
  }
  if (enumField(record, "authority", ["non-authoritative"] as const, "The source result authority label is unsupported.") !== "non-authoritative") {
    fail("source", "The source result authority label is unsupported.");
  }
  const resultKind = enumField(record, "resultKind", ["refused", "live", "historical"] as const, "The source result kind is unsupported.");
  if (booleanField(record, "historical", "The source historical flag is malformed.") !== (resultKind === "historical")) {
    fail("source", "The source historical flag contradicts its result kind.");
  }
  const authorityFresh = booleanField(record, "authorityFresh", "The source authority freshness flag is malformed.");
  const outcome = enumField(record, "outcome", HARNESS_OUTCOMES, "The source outcome is unsupported.");
  if (booleanField(record, "taskAccepted", "The source acceptance flag is malformed") !== false) {
    fail("source", "The source result must not claim task acceptance.");
  }
  if (enumField(record, "semanticAcceptance", ["not-evaluated"] as const, "The source semantic acceptance label is unsupported.") !== "not-evaluated") {
    fail("source", "The source result must not claim semantic acceptance.");
  }
  const runId = nullableTextField(record, "runId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The source run id is unavailable.");
  if (runId === null || runId !== expectedRunId) fail("source", "The source run id does not match the candidate.");
  const backendStatus = nullableEnumField(record, "backendStatus", HARNESS_BACKEND_STATUSES, "The source backend status is unsupported.");
  const executionState = enumField(record, "executionState", HARNESS_EXECUTION_STATES, "The source execution state is unsupported.");
  const termination = enumField(record, "termination", HARNESS_TERMINATIONS, "The source termination is unsupported.");
  const cancellation = enumField(record, "cancellation", HARNESS_CANCELLATIONS, "The source cancellation state is unsupported.");
  const deadlineAt = nullableCountField(record, "deadlineAt", Number.MAX_SAFE_INTEGER, "The source deadline is malformed.");
  const elapsedMs = countField(record, "elapsedMs", Number.MAX_SAFE_INTEGER, "The source elapsed time is malformed.");
  const cost = asRecord(field(record, "cost", "The source cost is unavailable."), "The source cost is unavailable.");
  const allocatedUsd = moneyField(cost, "allocatedUsd", "The source allocated cost is malformed.");
  const observedUsd = nullableMoneyField(cost, "observedUsd", "The source observed cost is malformed.");
  const unknownUsd = moneyField(cost, "unknownUsd", "The source unknown cost is malformed.");
  const overspendUsd = moneyField(cost, "overspendUsd", "The source overspend cost is malformed.");
  // Free-text result excerpts, reasons and limitations are deliberately not
  // part of the projection. The fingerprint covers the stable result facts.
  const projection = Object.freeze({
    projection: NATIVE_HARNESS_HISTORY_SOURCE_PROJECTION,
    toolCallId,
    toolName,
    isError: errorValue === true,
    resultKind,
    historical: resultKind === "historical",
    authorityFresh,
    outcome,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
    runId,
    backendStatus,
    executionState,
    termination,
    cancellation,
    deadlineAt,
    elapsedMs,
    cost: { allocatedUsd, observedUsd, unknownUsd, overspendUsd },
  });
  const fingerprint = fingerprintNativeJson(projection);
  if (!fingerprint.ok) fail("source", "The source result projection is not canonically encodable.");
  return {
    entry,
    index: -1,
    entryId: entry.id,
    sha256: fingerprint.sha256,
    bytes: fingerprint.bytes,
    toolCallId,
  };
}

interface ReportExpectation {
  readonly runId: string;
  readonly toolCallId: string;
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

function reportClaim(entry: BranchEntry): { readonly toolCallId: string | null; readonly runId: string | null } {
  try {
    const message = toolResultMessage(entry);
    if (optionalField(message, "toolName") !== NATIVE_WORK_TOOL) {
      return { toolCallId: null, runId: null };
    }
    const details = optionalField(message, "details");
    const harnessResult = optionalField(details, "harnessResult");
    const facts = optionalField(harnessResult, "facts");
    const source = optionalField(facts, "source");
    const capture = optionalField(facts, "capture");
    const toolCallId = optionalField(source, "toolCallId");
    const runId = optionalField(capture, "runId");
    return {
      toolCallId: typeof toolCallId === "string" ? toolCallId : null,
      runId: typeof runId === "string" ? runId : null,
    };
  } catch {
    return { toolCallId: null, runId: null };
  }
}

function reportProjection(entry: BranchEntry, expected: ReportExpectation): NormalizedReport {
  const message = toolResultMessage(entry);
  const toolCallId = textField(
    message,
    "toolCallId",
    NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars,
    "The report tool-call id is unavailable.",
  );
  const toolName = textField(message, "toolName", 64, "The report tool name is unavailable.");
  if (toolName !== NATIVE_WORK_TOOL) fail("report", "The selected report is not an agent_work result.");
  const errorValue = optionalField(message, "isError");
  if (errorValue === true) fail("report", "A failed agent_work result is not a report.");
  if (errorValue !== undefined && typeof errorValue !== "boolean") fail("report", "The report error flag is malformed.");
  const details = asRecord(field(message, "details", "The report details are unavailable."), "The report details are unavailable.");
  if (enumField(details, "kind", ["native-work-report"] as const, "The report kind is unsupported.") !== "native-work-report") {
    fail("report", "The report kind is unsupported.");
  }
  if (enumField(details, "interface", [NATIVE_WORK_INTERFACE] as const, "The report interface is unsupported.") !== NATIVE_WORK_INTERFACE) {
    fail("report", "The report interface is unsupported.");
  }
  if (enumField(details, "authority", ["non-authoritative"] as const, "The report authority label is unsupported.") !== "non-authoritative") {
    fail("report", "The report authority label is unsupported.");
  }
  const work = asRecord(field(details, "work", "The report work identity is unavailable."), "The report work identity is unavailable.");
  const observationId = textField(work, "observationId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report work observation is unavailable.");
  const generation = countField(work, "generation", Number.MAX_SAFE_INTEGER, "The report work generation is malformed.");
  const workSessionId = textField(work, "sessionId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report work session is unavailable.");
  const workWorkspaceRoot = textField(work, "workspaceRoot", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars, "The report work workspace is unavailable.");
  const statusAtReport = enumField(work, "statusAtReport", ["active", "ended"] as const, "The report work status is unsupported.");
  if (observationId !== expected.observationId || generation !== expected.generation) {
    fail("report", "The report work identity does not match the candidate association.");
  }
  if (workSessionId !== expected.sessionId || workWorkspaceRoot !== expected.workspaceRoot) {
    fail("report", "The report work session or workspace does not match the candidate association.");
  }
  const modelDeclared = asRecord(
    field(details, "modelDeclared", "The report model declaration is unavailable."),
    "The report model declaration is unavailable.",
  );
  const outcome = enumField(modelDeclared, "outcome", REPORT_OUTCOMES, "The report outcome is unsupported.");
  const harnessResult = asRecord(
    field(details, "harnessResult", "The report Harness binding is unavailable."),
    "The report Harness binding is unavailable.",
  );
  const facts = asRecord(
    field(harnessResult, "facts", "The report Harness facts are unavailable."),
    "The report Harness facts are unavailable.",
  );
  if (enumField(facts, "schema", [REPORT_BINDING_SCHEMA] as const, "The report Harness facts schema is unsupported.") !== REPORT_BINDING_SCHEMA) {
    fail("report", "The report Harness facts schema is unsupported.");
  }
  if (enumField(facts, "authority", ["non-authoritative"] as const, "The report Harness facts authority is unsupported.") !== "non-authoritative") {
    fail("report", "The report Harness facts authority is unsupported.");
  }
  if (enumField(facts, "modelDeclaredOutcome", REPORT_OUTCOMES, "The report Harness outcome is unsupported.") !== outcome) {
    fail("report", "The report and its Harness facts declare different outcomes.");
  }
  if (booleanField(facts, "taskAccepted", "The report Harness acceptance flag is malformed.") !== false) {
    fail("report", "The report Harness facts must not claim task acceptance.");
  }
  if (enumField(facts, "semanticAcceptance", ["not-evaluated"] as const, "The report Harness semantic label is unsupported.") !== "not-evaluated") {
    fail("report", "The report Harness facts must not claim semantic acceptance.");
  }
  if (enumField(facts, "filesystemFreshness", ["not-rechecked"] as const, "The report freshness label is unsupported.") !== "not-rechecked") {
    fail("report", "The report freshness label is unsupported.");
  }
  const source = asRecord(field(facts, "source", "The report source facts are unavailable."), "The report source facts are unavailable.");
  const sourceToolCallId = textField(source, "toolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report source id is unavailable.");
  const sourceObservationId = textField(source, "observationId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report source observation is unavailable.");
  const sourceGeneration = countField(source, "generation", Number.MAX_SAFE_INTEGER, "The report source generation is malformed.");
  if (sourceToolCallId !== expected.toolCallId
    || sourceObservationId !== expected.observationId
    || sourceGeneration !== expected.generation) {
    fail("report", "The report source facts do not match the candidate association.");
  }
  const taskSha256 = shaField(source, "taskSha256", "The report task digest is malformed.");
  const promptSha256 = shaField(source, "promptSha256", "The report prompt digest is malformed.");
  const inputSha256 = shaField(source, "inputSha256", "The report input digest is malformed.");
  const observedEnvelopeSha256 = shaField(source, "observedEnvelopeSha256", "The report envelope digest is malformed.");
  const observedEnvelopeBytes = countField(source, "observedEnvelopeBytes", Number.MAX_SAFE_INTEGER, "The report envelope size is malformed.");
  const capture = asRecord(field(facts, "capture", "The report capture facts are unavailable."), "The report capture facts are unavailable.");
  const captureId = textField(capture, "captureId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report capture id is unavailable.");
  const captureDigest = shaField(capture, "captureDigest", "The report capture digest is malformed.");
  const originKind = textField(capture, "originKind", 64, "The report capture origin is unavailable.");
  const completionId = textField(capture, "completionId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report completion id is unavailable.");
  const captureRunId = textField(capture, "runId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report capture run id is unavailable.");
  if (captureRunId !== expected.runId) fail("report", "The report capture run id does not match the candidate run.");
  const baseSnapshotId = textField(capture, "baseSnapshotId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report base snapshot is unavailable.");
  const manifestSha256 = shaField(capture, "manifestSha256", "The report manifest digest is malformed.");
  const winner = asRecord(field(capture, "winner", "The report winner facts are unavailable."), "The report winner facts are unavailable.");
  const winnerCandidate = textField(winner, "candidate", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report winner is unavailable.");
  const winnerAttempt = countField(winner, "attempt", Number.MAX_SAFE_INTEGER, "The report winner attempt is malformed.");
  if (winnerAttempt < 1) fail("report", "The report winner attempt is malformed.");
  const winnerArtifactHash = shaField(winner, "artifactHash", "The report artifact digest is malformed.");
  const winnerTraceHash = shaField(winner, "traceHash", "The report trace digest is malformed.");
  const captureObservedAt = countField(capture, "observedAt", Number.MAX_SAFE_INTEGER, "The report capture time is malformed.");
  const rawFiles = arrayItems(facts, "files", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.declaredArtifacts, "The report file facts exceed their bound.");
  const files: Record<string, unknown>[] = [];
  const declaredFiles: { path: string; bytes: number; sha256: string }[] = [];
  for (const raw of rawFiles) {
    const file = asRecord(raw, "A report file fact is malformed.");
    const filePath = textField(file, "path", 1024, "A report file path is unavailable.");
    let relativePath: string;
    try {
      relativePath = validateRelativePath(filePath);
    } catch {
      fail("report", "A report file path is not an unambiguous workspace-relative path.");
    }
    const kind = enumField(file, "kind", ["add", "modify"] as const, "A report file kind is unsupported.");
    const mode = countField(file, "mode", 0o7777, "A report file mode is malformed.");
    const controllerHash = shaField(file, "controllerHash", "A report file controller digest is malformed.");
    const fileSnapshotId = textField(file, "fileSnapshotId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "A report file snapshot id is unavailable.");
    const bytes = countField(file, "bytes", NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes, "A report file size is malformed.");
    const sha256 = shaField(file, "sha256", "A report file digest is malformed.");
    const observedAt = countField(file, "observedAt", Number.MAX_SAFE_INTEGER, "A report file time is malformed.");
    const checkRaw = field(file, "check", "A report file check is unavailable.");
    let check: Record<string, unknown> | null = null;
    if (checkRaw !== null) {
      const checkRecord = asRecord(checkRaw, "A report file check is malformed.");
      const checkToolCallId = textField(checkRecord, "checkToolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "A report check id is unavailable.");
      const computedByToolCallId = textField(checkRecord, "computedByToolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "A report check source id is unavailable.");
      const checkerId = textField(checkRecord, "checkerId", 128, "A report checker id is unavailable.");
      const checkerVersion = textField(checkRecord, "checkerVersion", 128, "A report checker version is unavailable.");
      const planSource = textField(checkRecord, "planSource", 128, "A report check plan source is unavailable.");
      const planDigest = shaField(checkRecord, "planDigest", "A report check plan digest is malformed.");
      const receipt = asRecord(field(checkRecord, "receipt", "A report check receipt is unavailable."), "A report check receipt is unavailable.");
      const receiptCheckerId = textField(receipt, "checkerId", 128, "A report receipt checker id is unavailable.");
      const receiptCheckerVersion = textField(receipt, "checkerVersion", 128, "A report receipt checker version is unavailable.");
      const receiptPlanDigest = shaField(receipt, "planDigest", "A report receipt plan digest is malformed.");
      const receiptOutcome = enumField(receipt, "outcome", ["pass", "fail"] as const, "A report receipt outcome is unsupported.");
      if (booleanField(receipt, "taskAccepted", "A report receipt acceptance flag is malformed.") !== false) {
        fail("report", "A report receipt must not claim task acceptance.");
      }
      if (enumField(receipt, "semanticAcceptance", ["not-evaluated"] as const, "A report receipt semantic label is unsupported.") !== "not-evaluated") {
        fail("report", "A report receipt must not claim semantic acceptance.");
      }
      if (receiptCheckerId !== checkerId
        || receiptCheckerVersion !== checkerVersion
        || receiptPlanDigest !== planDigest) {
        fail("report", "A report check receipt contradicts its check facts.");
      }
      const conditionsRaw = arrayItems(receipt, "conditions", 32, "A report receipt condition set exceeds its bound.");
      const conditions: { id: string; result: "pass" | "fail" }[] = [];
      for (const conditionRaw of conditionsRaw) {
        const condition = asRecord(conditionRaw, "A report receipt condition is malformed.");
        conditions.push({
          id: textField(condition, "id", 128, "A report receipt condition id is unavailable."),
          result: enumField(condition, "result", ["pass", "fail"] as const, "A report receipt condition result is unsupported."),
        });
      }
      if (receiptOutcome === "pass" && conditions.some((condition) => condition.result === "fail")) {
        fail("report", "A passing report receipt contains a failing condition.");
      }
      check = {
        checkToolCallId,
        computedByToolCallId,
        checkerId,
        checkerVersion,
        planSource,
        planDigest,
        receipt: {
          checkerId: receiptCheckerId,
          checkerVersion: receiptCheckerVersion,
          planDigest: receiptPlanDigest,
          outcome: receiptOutcome,
          taskAccepted: false as const,
          semanticAcceptance: "not-evaluated" as const,
          conditions,
        },
      };
    }
    files.push({
      path: relativePath,
      kind,
      mode,
      controllerHash,
      fileSnapshotId,
      bytes,
      sha256,
      observedAt,
      check,
    });
    declaredFiles.push({ path: relativePath, bytes, sha256 });
  }
  const coverage = asRecord(field(facts, "coverage", "The report coverage facts are unavailable."), "The report coverage facts are unavailable.");
  const coverageProjection = {
    capturedPathCount: countField(coverage, "capturedPathCount", 64, "The report captured path count is malformed."),
    selectedPathCount: countField(coverage, "selectedPathCount", 64, "The report selected path count is malformed."),
    passPathCount: countField(coverage, "passPathCount", 64, "The report pass count is malformed."),
    failPathCount: countField(coverage, "failPathCount", 64, "The report fail count is malformed."),
    missingPathCount: countField(coverage, "missingPathCount", 64, "The report missing count is malformed."),
    conditionPassCount: countField(coverage, "conditionPassCount", 1024, "The report condition pass count is malformed."),
    conditionFailCount: countField(coverage, "conditionFailCount", 1024, "The report condition fail count is malformed."),
    completedCoverage: booleanField(coverage, "completedCoverage", "The report coverage flag is malformed."),
    missing: arrayItems(coverage, "missing", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.declaredArtifacts, "The report missing path list exceeds its bound.").map((item) => {
      const missing = asRecord(item, "A report missing path is malformed.");
      const missingPath = textField(missing, "path", 1024, "A report missing path is unavailable.");
      try {
        return { path: validateRelativePath(missingPath) };
      } catch {
        fail("report", "A report missing path is not workspace-relative.");
      }
    }),
    failed: arrayItems(coverage, "failed", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.declaredArtifacts, "The report failed path list exceeds its bound.").map((item) => {
      const failed = asRecord(item, "A report failed path is malformed.");
      const failedPath = textField(failed, "path", 1024, "A report failed path is unavailable.");
      try {
        return {
          path: validateRelativePath(failedPath),
          checkToolCallId: textField(failed, "checkToolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "A report failed check id is unavailable."),
        };
      } catch {
        fail("report", "A report failed path is not workspace-relative.");
      }
    }),
  };
  const reread = asRecord(
    field(harnessResult, "reread", "The report reread facts are unavailable."),
    "The report reread facts are unavailable.",
  );
  if (enumField(reread, "schema", [REPORT_REREAD_SCHEMA] as const, "The report reread schema is unsupported.") !== REPORT_REREAD_SCHEMA) {
    fail("report", "The report reread schema is unsupported.");
  }
  if (booleanField(reread, "ok", "The report reread flag is malformed.") !== true) {
    fail("report", "The report reread did not succeed.");
  }
  if (booleanField(reread, "sameVersion", "The report reread version flag is malformed.") !== true) {
    fail("report", "The report reread version is not the same as the capture.");
  }
  if (booleanField(reread, "taskAccepted", "The report reread acceptance flag is malformed.") !== false
    || enumField(reread, "semanticAcceptance", ["not-evaluated"] as const, "The report reread semantic label is unsupported.") !== "not-evaluated") {
    fail("report", "The report reread must not claim acceptance.");
  }
  const rereadSourceId = textField(reread, "sourceToolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report reread source id is unavailable.");
  const rereadReportId = textField(reread, "reportToolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report reread report id is unavailable.");
  const rereadInputSha256 = shaField(reread, "reportInputSha256", "The report reread input digest is malformed.");
  const rereadCaptureId = textField(reread, "captureId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The report reread capture id is unavailable.");
  const rereadCaptureDigest = shaField(reread, "captureDigest", "The report reread capture digest is malformed.");
  const rereadAttempt = countField(reread, "attempt", 4, "The report reread attempt is malformed.");
  if (rereadAttempt < 1) fail("report", "The report reread attempt is malformed.");
  const rereadStartedAt = countField(reread, "startedAt", Number.MAX_SAFE_INTEGER, "The report reread start is malformed.");
  const rereadFinishedAt = countField(reread, "finishedAt", Number.MAX_SAFE_INTEGER, "The report reread end is malformed.");
  if (rereadFinishedAt < rereadStartedAt) fail("report", "The report reread interval is inverted.");
  if (rereadSourceId !== expected.toolCallId
    || rereadReportId !== toolCallId
    || rereadCaptureId !== captureId
    || rereadCaptureDigest !== captureDigest) {
    fail("report", "The report reread facts do not match the selected source, report or capture.");
  }
  const projection = Object.freeze({
    projection: NATIVE_HARNESS_HISTORY_REPORT_PROJECTION,
    toolCallId,
    isError: false as const,
    work: {
      observationId,
      generation,
      sessionId: workSessionId,
      workspaceRoot: workWorkspaceRoot,
      statusAtReport,
    },
    outcome,
    harness: {
      facts: {
        schema: REPORT_BINDING_SCHEMA,
        authority: "non-authoritative" as const,
        modelDeclaredOutcome: outcome,
        source: {
          toolCallId: sourceToolCallId,
          observationId: sourceObservationId,
          generation: sourceGeneration,
          taskSha256,
          promptSha256,
          inputSha256,
          observedEnvelopeSha256,
          observedEnvelopeBytes,
        },
        capture: {
          captureId,
          captureDigest,
          originKind,
          completionId,
          runId: captureRunId,
          baseSnapshotId,
          manifestSha256,
          winner: {
            candidate: winnerCandidate,
            attempt: winnerAttempt,
            artifactHash: winnerArtifactHash,
            traceHash: winnerTraceHash,
          },
          observedAt: captureObservedAt,
        },
        files,
        coverage: coverageProjection,
        filesystemFreshness: "not-rechecked" as const,
        taskAccepted: false as const,
        semanticAcceptance: "not-evaluated" as const,
      },
      reread: {
        schema: REPORT_REREAD_SCHEMA,
        sourceToolCallId: rereadSourceId,
        reportToolCallId: rereadReportId,
        reportInputSha256: rereadInputSha256,
        captureId: rereadCaptureId,
        captureDigest: rereadCaptureDigest,
        attempt: rereadAttempt,
        startedAt: rereadStartedAt,
        finishedAt: rereadFinishedAt,
        sameVersion: true as const,
        taskAccepted: false as const,
        semanticAcceptance: "not-evaluated" as const,
      },
    },
  });
  const fingerprint = fingerprintNativeJson(projection);
  if (!fingerprint.ok) {
    if (fingerprint.reason === "encoding-byte-limit") {
      fail("report-oversized", "The selected report projection exceeds the fixed canonical encoding bound.");
    }
    fail("report", "The report projection is not canonically encodable.");
  }
  return {
    entry,
    index: -1,
    entryId: entry.id,
    sha256: fingerprint.sha256,
    bytes: fingerprint.bytes,
    toolCallId,
    outcome,
    files: Object.freeze(declaredFiles),
  };
}

interface LocatorEvidence {
  readonly source: EvidenceReference;
  readonly report: EvidenceReference | null;
}

function buildLocator(
  candidate: ParsedCandidate,
  source: NormalizedSource,
  report: NormalizedReport | null,
  sessionId: string,
): { readonly locator: NativeHarnessHistoryLocator; readonly sha256: string; readonly bytes: number; readonly evidenceKey: string } {
  const sourceReference: EvidenceReference = Object.freeze({
    entryId: source.entryId,
    sha256: source.sha256,
  });
  const reportReference: EvidenceReference | null = report === null
    ? null
    : Object.freeze({ entryId: report.entryId, sha256: report.sha256 });
  const raw = {
    schema: NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
    version: 1,
    originSessionId: sessionId,
    workspacePath: candidate.association.workspaceRoot,
    source: {
      toolCallId: candidate.association.toolCallId,
      observationId: candidate.association.observationId,
      generation: candidate.association.generation,
    },
    runId: candidate.runId,
    storeRelativePath: candidate.storeRelativePath,
    inputManifestSha256: candidate.backend.inputManifestSha256,
    definitionVersion: candidate.definitionVersion,
    backendSourceId: candidate.backendSourceId,
    configurationSha256: candidate.configurationSha256,
    evidence: { source: sourceReference, report: reportReference },
  };
  const text = dataText(raw);
  if (text === null) fail("locator", "The locator data is not text-encodable.");
  const decoded = decodeNativeHarnessHistoryLocator(text);
  if (!decoded.ok) fail("locator", "The locator data is not decoder-compatible.");
  if (decoded.bytes > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locatorBytes) {
    fail("locator", "The locator data exceeds its fixed byte bound.");
  }
  const evidenceKey = canonicalSha({
    originSessionId: sessionId,
    workspacePath: candidate.association.workspaceRoot,
    runId: candidate.runId,
    source: sourceReference,
    report: reportReference,
  });
  if (evidenceKey === null) fail("locator", "The locator evidence key is not canonically encodable.");
  return { locator: decoded.locator, sha256: decoded.sha256, bytes: decoded.bytes, evidenceKey };
}

interface ParsedCandidate {
  readonly association: NativeHarnessHistorySessionAssociation;
  readonly runId: string;
  readonly storeRelativePath: string;
  readonly backend: NativeHarnessHistoryBackendFacts;
  readonly definitionVersion: string | null;
  readonly backendSourceId: string | null;
  readonly configurationSha256: string | null;
  readonly key: string;
}

function parseCandidate(value: unknown, base: SessionBase, storageRoot: string): ParsedCandidate {
  const record = asRecord(value, "A host history candidate is unavailable.");
  const associationRaw = asRecord(field(record, "association", "A host candidate association is unavailable."), "A host candidate association is unavailable.");
  const observationId = textField(associationRaw, "observationId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The candidate observation id is unavailable.");
  const generation = countField(associationRaw, "generation", Number.MAX_SAFE_INTEGER, "The candidate generation is malformed.");
  const sessionId = textField(associationRaw, "sessionId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The candidate session id is unavailable.");
  const workspaceRoot = textField(associationRaw, "workspaceRoot", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars, "The candidate workspace is unavailable.");
  const toolCallId = textField(associationRaw, "toolCallId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The candidate tool-call id is unavailable.");
  const toolName = textField(associationRaw, "toolName", 64, "The candidate tool name is unavailable.");
  if (toolName !== HARNESS_TOOL) fail("candidate", "The candidate association is not for the native Harness tool.");
  if (!isCanonicalAbsolutePath(workspaceRoot) || workspaceRoot !== base.cwd) {
    fail("candidate", "The candidate workspace is not the actual main workspace.");
  }
  if (sessionId !== base.sessionId) fail("candidate", "The candidate session is not the actual main session.");
  const runId = textField(record, "runId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The candidate run id is unavailable.");
  if (!ID_PATTERN.test(runId)) fail("candidate", "The candidate run id is not a supported identifier.");
  const backendRaw = asRecord(field(record, "backend", "A host candidate backend is unavailable."), "A host candidate backend is unavailable.");
  const preparedRoot = textField(backendRaw, "preparedRoot", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars, "The candidate prepared root is unavailable.");
  const storeRoot = textField(backendRaw, "storeRoot", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars, "The candidate store root is unavailable.");
  const inputManifestSha256 = nullableShaField(backendRaw, "inputManifestSha256", "The candidate input manifest digest is malformed.");
  if (!isCanonicalAbsolutePath(preparedRoot) || !isCanonicalAbsolutePath(storeRoot)) {
    fail("candidate", "The candidate backend roots are not canonical.");
  }
  if (path.dirname(preparedRoot) !== storageRoot) {
    fail("candidate", "The candidate prepared root is not a direct child of the host storage root.");
  }
  const harnessDirectory = path.basename(preparedRoot);
  if (!HARNESS_DIRECTORY_PATTERN.test(harnessDirectory)) {
    fail("candidate", "The candidate prepared root is not a fixed harness directory.");
  }
  if (storeRoot !== path.join(preparedRoot, "store")) {
    fail("candidate", "The candidate store root is not the prepared root's store.");
  }
  const definitionVersion = nullableTextField(record, "definitionVersion", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The candidate definition label is malformed.");
  const backendSourceId = nullableShaField(record, "backendSourceId", "The candidate backend source label is malformed.");
  const configurationSha256 = nullableShaField(record, "configurationSha256", "The candidate configuration label is malformed.");
  const storeRelativePath = `${harnessDirectory}/store/runs/${runId}`;
  const normalized = {
    association: Object.freeze({
      observationId,
      generation,
      sessionId,
      workspaceRoot,
      toolCallId,
      toolName: HARNESS_TOOL as typeof HARNESS_TOOL,
    }),
    runId,
    storeRelativePath,
    backend: Object.freeze({ preparedRoot, storeRoot, inputManifestSha256 }),
    definitionVersion,
    backendSourceId,
    configurationSha256,
  };
  const key = canonicalSha(normalized);
  if (key === null) fail("candidate", "The candidate is not canonically encodable.");
  return Object.freeze({ ...normalized, key });
}

interface ResolvedPublication {
  readonly candidate: ParsedCandidate;
  readonly source: NormalizedSource;
  readonly report: NormalizedReport | null;
  readonly locator: NativeHarnessHistoryLocator;
  readonly locatorSha256: string;
  readonly locatorBytes: number;
  readonly evidenceKey: string;
  readonly sourceReference: EvidenceReference;
  readonly reportReference: EvidenceReference | null;
  readonly reportProblem: NativeHarnessHistoryReason | null;
}

function resolvePublication(
  base: SessionBase,
  entries: BranchEntry[],
  candidate: ParsedCandidate,
): ResolvedPublication {
  const sourceMatches: BranchEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    try {
      const message = toolResultMessage(entry);
      if (optionalField(message, "toolCallId") === candidate.association.toolCallId) sourceMatches.push(entry);
    } catch {
      // A non-tool-result or unreadable message cannot be the exact source.
    }
  }
  if (sourceMatches.length === 0) fail("source-missing", "The exact source tool result is absent from the current branch.");
  if (sourceMatches.length > 1) fail("source-ambiguous", "More than one source tool result matches the candidate.");
  const sourceEntry = sourceMatches[0]!;
  const sourceIndex = entries.findIndex((entry) => entry.id === sourceEntry.id);
  if (sourceIndex < 0) fail("source-missing", "The exact source tool result is absent from the current branch.");
  const source = sourceProjection(sourceEntry, candidate.runId, candidate.association.toolCallId);
  (source as { index: number }).index = sourceIndex;

  const reports: NormalizedReport[] = [];
  let claimedReportCount = 0;
  let reportProblem: NativeHarnessHistoryReason | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    const claim = reportClaim(entry);
    if (claim.toolCallId !== candidate.association.toolCallId && claim.runId !== candidate.runId) continue;
    claimedReportCount += 1;
    if (index <= sourceIndex) {
      fail("report-ambiguous", "A claimed report entry precedes the selected source.");
    }
    try {
      const report = reportProjection(entry, {
        runId: candidate.runId,
        toolCallId: candidate.association.toolCallId,
        observationId: candidate.association.observationId,
        generation: candidate.association.generation,
        sessionId: candidate.association.sessionId,
        workspaceRoot: candidate.association.workspaceRoot,
      });
      (report as { index: number }).index = index;
      reports.push(report);
    } catch (error) {
      if (error instanceof ObservationFailure && error.code === "report-oversized") {
        // The source history remains valid. The optional report/artifact
        // declaration is explicitly unavailable, never truncated.
        reportProblem = reason("report-optional-unavailable", error.detail);
        continue;
      }
      throw error;
    }
  }
  if (claimedReportCount > 1 || reports.length > 1) {
    fail("report-ambiguous", "More than one agent_work report matches the selected source.");
  }
  const report = reports[0] ?? null;
  const built = buildLocator(candidate, source, report, base.sessionId);
  return {
    candidate,
    source,
    report,
    locator: built.locator,
    locatorSha256: built.sha256,
    locatorBytes: built.bytes,
    evidenceKey: built.evidenceKey,
    sourceReference: { entryId: source.entryId, sha256: source.sha256 },
    reportReference: report === null ? null : { entryId: report.entryId, sha256: report.sha256 },
    reportProblem,
  };
}

interface ExistingLocator {
  readonly entry: BranchEntry;
  readonly index: number;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly evidenceKey: string | null;
  readonly decoded: NativeHarnessHistoryLocator | null;
}

function scanLocators(entries: BranchEntry[]): ExistingLocator[] {
  const locators: ExistingLocator[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.value.customType !== NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE) continue;
    const data = entry.value.data;
    const text = dataText(data);
    const fingerprint = fingerprintNativeJson(data);
    const decoded = text === null ? null : decodeNativeHarnessHistoryLocator(text);
    const locator = decoded !== null && decoded.ok ? decoded.locator : null;
    const evidenceKey = locator === null
      ? null
      : canonicalSha({
        originSessionId: locator.originSessionId,
        workspacePath: locator.workspacePath,
        runId: locator.runId,
        source: locator.evidence?.source ?? null,
        report: locator.evidence?.report ?? null,
      });
    locators.push({
      entry,
      index,
      sha256: decoded !== null && decoded.ok ? decoded.sha256 : null,
      bytes: fingerprint.ok ? fingerprint.bytes : null,
      evidenceKey,
      decoded: locator,
    });
  }
  return locators;
}

/**
 * A contiguous persisted branch must keep source before report before the
 * selected locator. Fingerprints alone cannot prove that order.
 */
function referenceOrderProblem(
  entries: readonly BranchEntry[],
  selectedIndex: number,
  sourceReference: EvidenceReference | null,
  reportReference: EvidenceReference | null,
): NativeHarnessHistoryReason | null {
  if (sourceReference === null) return null;
  const sourceIndex = entries.findIndex((entry) => entry.id === sourceReference.entryId);
  if (sourceIndex < 0) return null;
  if (sourceIndex >= selectedIndex) {
    return reason("reference-order", "The source entry is not before the selected locator.");
  }
  if (reportReference !== null) {
    const reportIndex = entries.findIndex((entry) => entry.id === reportReference.entryId);
    if (reportIndex < 0) return null;
    if (reportIndex <= sourceIndex || reportIndex >= selectedIndex) {
      return reason("reference-order", "The report entry is not between the source and the selected locator.");
    }
  }
  return null;
}

function branchLocatorProblem(locators: readonly ExistingLocator[]): NativeHarnessHistoryReason | null {
  if (locators.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locators) {
    return reason("branch-locator-limit", "The current branch exceeds the fixed native-locator bound.");
  }
  if (locators.some((locator) => locator.bytes === null || locator.bytes > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locatorBytes)) {
    return reason("branch-locator-oversized", "A native locator on the current branch exceeds its fixed byte bound.");
  }
  if (locators.some((locator) => locator.decoded === null)) {
    return reason("branch-locator-invalid", "A native locator on the current branch is not decoder-compatible.");
  }
  return null;
}

interface AttemptLatch {
  status: "pending" | "visible" | "disk-confirmed" | "unknown" | "unavailable";
  entryId: string | null;
  locatorSha256: string | null;
  reason: NativeHarnessHistoryReason | null;
}

interface PreparedRow {
  readonly candidateKey: string | null;
  readonly toolCallId: string | null;
  readonly runId: string | null;
  readonly planned: ResolvedPublication | null;
  readonly outcome: NativeHarnessHistoryPublicationOutcome | null;
  readonly entryId: string | null;
  readonly locatorSha256: string | null;
  readonly durability: "observed-only" | "unknown";
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

function publicationRow(
  candidate: ParsedCandidate | null,
  outcome: NativeHarnessHistoryPublicationOutcome,
  entryId: string | null,
  locatorSha256: string | null,
  reasons: readonly NativeHarnessHistoryReason[],
  durability: "observed-only" | "unknown" = "unknown",
): NativeHarnessHistoryPublication {
  return deepFreeze({
    toolCallId: candidate?.association.toolCallId ?? null,
    runId: candidate?.runId ?? null,
    outcome,
    entryId,
    locatorSha256,
    durability,
    reasons: boundedReasons(reasons),
  });
}

function nowValue(options: NativeHarnessHistorySessionOptions): number {
  try {
    const value = options.now === undefined ? Date.now() : options.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function readTimeout(options: NativeHarnessHistorySessionOptions): number {
  const value = options.ensureOnDiskTimeoutMs;
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return NATIVE_HARNESS_HISTORY_SESSION_LIMITS.ensureOnDiskMs;
  }
  return Math.min(value, NATIVE_HARNESS_HISTORY_SESSION_LIMITS.ensureOnDiskMs);
}

function withNonBlocking(io: NativeFileIo): NativeFileIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: (target) => io.realpath(target),
    lstat: (target, options) => io.lstat(target, options),
    open: (target, flags) => io.open(target, flags | nonBlocking),
  };
}

interface DirectoryPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function sameDirectoryIdentity(left: DirectoryPin, right: NativeFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryPin(left: DirectoryPin, right: DirectoryPin): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function pinDirectory(directory: string, io: NativeFileIo): Promise<DirectoryPin | null> {
  try {
    const resolved = await io.realpath(directory);
    if (resolved !== directory) return null;
    const info = await io.lstat(directory, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    return {
      path: directory,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  } catch {
    return null;
  }
}

async function directoryStillCurrent(pin: DirectoryPin, io: NativeFileIo): Promise<boolean> {
  try {
    const resolved = await io.realpath(pin.path);
    if (resolved !== pin.path) return false;
    const info = await io.lstat(pin.path, { bigint: true });
    return !info.isSymbolicLink() && info.isDirectory() && sameDirectoryIdentity(pin, info);
  } catch {
    return false;
  }
}

function bindPinnedDirectory(io: NativeFileIo, pin: DirectoryPin): NativeFileIo {
  const changed = (): never => {
    throw fail("disk", "The trusted session directory identity changed before readback.");
  };
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: async (target) => {
      const resolved = await io.realpath(target);
      if (path.normalize(target) === pin.path && resolved !== pin.path) changed();
      return resolved;
    },
    lstat: async (target, options) => {
      const info = await io.lstat(target, options);
      if (path.normalize(target) === pin.path) {
        if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryIdentity(pin, info)) changed();
      }
      return info;
    },
    open: (target, flags) => io.open(target, flags),
  };
}

interface SessionDiskEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly value: Record<string, unknown>;
}

interface SessionDiskFile {
  readonly header: Record<string, unknown>;
  readonly entries: readonly SessionDiskEntry[];
  readonly byId: ReadonlyMap<string, SessionDiskEntry>;
}

function isSessionTitleSlot(value: Record<string, unknown>): boolean {
  if (value.type !== "title" || value.v !== 1) return false;
  if (typeof value.title !== "string" || typeof value.updatedAt !== "string" || typeof value.pad !== "string") {
    return false;
  }
  const source = value.source;
  return source === undefined || source === "auto" || source === "user";
}

function parseSessionFile(text: string, sessionId: string, recordedCwd: string): SessionDiskFile | null {
  if (Buffer.byteLength(text, "utf8") > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileBytes) return null;
  if (text.includes("\0")) return null;
  const lines = text.split("\n");
  if (lines.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileLines) return null;
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  let header: Record<string, unknown> | null = null;
  let bodyStart = 0;
  const entries: SessionDiskEntry[] = [];
  const byId = new Map<string, SessionDiskEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (index === 0) {
      if (!isPlainRecord(parsed)) return null;
      if (parsed.type === "session") {
        header = parsed;
        bodyStart = 1;
        continue;
      }
      // The actual fixed host may write one title metadata slot as the first
      // physical line. It is optional, may appear at most once and is never
      // branch evidence; its serialized byte size and padding are not parser
      // requirements.
      if (!isSessionTitleSlot(parsed)) return null;
      const next = lines[1];
      if (next === undefined || next.length === 0) return null;
      let headerParsed: unknown;
      try {
        headerParsed = JSON.parse(next);
      } catch {
        return null;
      }
      if (!isPlainRecord(headerParsed) || headerParsed.type !== "session") return null;
      header = headerParsed;
      bodyStart = 2;
      index = 1;
      continue;
    }
    if (!isPlainRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (parsed.parentId !== null && typeof parsed.parentId !== "string") return null;
    if (typeof parsed.type !== "string") return null;
    // Exactly one session header is allowed; no later title slot or foreign
    // header may masquerade as an entry, even with id/parentId present.
    if (parsed.type === "session" || parsed.type === "title") return null;
    if (byId.has(parsed.id)) return null;
    const entry: SessionDiskEntry = {
      id: parsed.id,
      parentId: parsed.parentId,
      type: parsed.type,
      value: parsed,
    };
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  if (header === null || bodyStart === 0) return null;
  if (header.id !== sessionId) return null;
  if (header.cwd !== recordedCwd) return null;
  return { header, entries, byId };
}

function diskEntryMatchesSource(entry: SessionDiskEntry | undefined, reference: EvidenceReference): boolean {
  if (entry === undefined) return false;
  try {
    const branchEntry: BranchEntry = {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      value: entry.value,
    };
    const message = toolResultMessage(branchEntry);
    const toolName = optionalField(message, "toolName");
    if (toolName !== HARNESS_TOOL) return false;
    const toolCallId = optionalField(message, "toolCallId");
    if (typeof toolCallId !== "string") return false;
    // Recompute the same projection through the source normalization path.
    const source = sourceProjection(branchEntry, sourceRunIdFromRaw(message), toolCallId);
    return source.sha256 === reference.sha256;
  } catch {
    return false;
  }
}

function sourceRunIdFromRaw(message: Record<string, unknown>): string {
  const details = asRecord(optionalField(message, "details"), "The source result details are unavailable.");
  const runId = optionalField(details, "runId");
  if (typeof runId !== "string" || !ID_PATTERN.test(runId)) {
    fail("source", "The source run id is unavailable.");
  }
  return runId;
}

function diskEntryMatchesReport(entry: SessionDiskEntry | undefined, reference: EvidenceReference, expected: ReportExpectation): boolean {
  if (entry === undefined) return false;
  try {
    const branchEntry: BranchEntry = {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      value: entry.value,
    };
    const message = toolResultMessage(branchEntry);
    if (optionalField(message, "toolName") !== NATIVE_WORK_TOOL) return false;
    const report = reportProjection(branchEntry, expected);
    return report.sha256 === reference.sha256;
  } catch {
    return false;
  }
}

interface DiskConfirmation {
  readonly ok: boolean;
  readonly reason: NativeHarnessHistoryReason | null;
}

async function confirmSessionDisk(
  base: PublicationBase,
  expectedEntryId: string,
  expectedParentId: string,
  expectedData: NativeHarnessHistoryLocator,
  expectedSource: EvidenceReference,
  expectedReport: EvidenceReference | null,
  reportExpectation: ReportExpectation | null,
  io: NativeFileIo,
  guard: () => boolean,
  observedAt: number,
): Promise<DiskConfirmation> {
  const pin = await pinDirectory(base.sessionDir, io);
  if (pin === null) {
    return { ok: false, reason: reason("disk-unavailable", "The trusted session directory could not be pinned.") };
  }
  // Revalidate after the pin await and before any file open. A held pin with a
  // disposed/navigated owner starts no further read.
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed before disk readback.") };
  }
  const scoped = bindPinnedDirectory(withNonBlocking(io), pin);
  let snapshot;
  try {
    snapshot = await captureWorkspaceText(base.sessionDir, path.basename(base.file), scoped, observedAt);
  } catch {
    return { ok: false, reason: reason("disk-unavailable", "The local session file could not be read within its fixed profile.") };
  }
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed during disk readback.") };
  }
  if (!(await directoryStillCurrent(pin, io))) {
    return { ok: false, reason: reason("disk-unavailable", "The trusted session directory identity changed during readback.") };
  }
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed after directory recheck.") };
  }
  const parsed = parseSessionFile(snapshot.text, base.sessionId, base.recordedCwd);
  if (parsed === null) {
    return { ok: false, reason: reason("disk-unavailable", "The local session file header or entries do not match the actual session.") };
  }
  let matchingLocatorCount = 0;
  let foundLocator: SessionDiskEntry | undefined;
  for (const entry of parsed.entries) {
    if (entry.type !== "custom" || entry.value.customType !== NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE) continue;
    if (!sameCanonical(entry.value.data, expectedData)) continue;
    matchingLocatorCount += 1;
    if (entry.id === expectedEntryId) foundLocator = entry;
  }
  if (matchingLocatorCount !== 1 || foundLocator === undefined || foundLocator.id !== expectedEntryId) {
    return { ok: false, reason: reason("disk-unavailable", "The local session file does not contain exactly one exact expected locator.") };
  }
  const sourceEntry = parsed.byId.get(expectedSource.entryId);
  if (!diskEntryMatchesSource(sourceEntry, expectedSource)) {
    return { ok: false, reason: reason("disk-unavailable", "The referenced source entry is not present with its exact fingerprint.") };
  }
  if (expectedReport !== null) {
    if (reportExpectation === null) {
      return { ok: false, reason: reason("disk-unavailable", "The report expectation is unavailable.") };
    }
    const reportEntry = parsed.byId.get(expectedReport.entryId);
    if (!diskEntryMatchesReport(reportEntry, expectedReport, reportExpectation)) {
      return { ok: false, reason: reason("disk-unavailable", "The referenced report entry is not present with its exact fingerprint.") };
    }
  }
  if (foundLocator.parentId !== expectedParentId || !parsed.byId.has(expectedParentId)) {
    return { ok: false, reason: reason("disk-unavailable", "The persisted locator parent is not the actual pre-append leaf.") };
  }
  const ancestors = new Set<string>();
  let cursor: string | null = foundLocator.parentId;
  let steps = 0;
  while (cursor !== null) {
    steps += 1;
    if (steps > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries || ancestors.has(cursor)) {
      return { ok: false, reason: reason("disk-unavailable", "The persisted locator ancestor chain is cyclic or over bound.") };
    }
    ancestors.add(cursor);
    const ancestor = parsed.byId.get(cursor);
    if (ancestor === undefined) {
      return { ok: false, reason: reason("disk-unavailable", "The persisted locator ancestor chain is dangling.") };
    }
    cursor = ancestor.parentId;
  }
  if (!ancestors.has(expectedSource.entryId)
    || (expectedReport !== null && !ancestors.has(expectedReport.entryId))) {
    return { ok: false, reason: reason("disk-unavailable", "The referenced source or report is not on the persisted locator ancestor chain.") };
  }
  return { ok: true, reason: null };
}

function sameBranchPrefix(
  before: readonly BranchEntry[],
  after: readonly BranchEntry[],
): boolean {
  if (after.length <= before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index]!.id !== after[index]!.id) return false;
    if (before[index]!.parentId !== after[index]!.parentId) return false;
  }
  return true;
}

function timeoutOutcome<T>(promise: Promise<T>, milliseconds: number): Promise<"settled" | "failed" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: "settled" | "failed" | "timeout"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), milliseconds);
    promise.then(
      () => finish("settled"),
      () => finish("failed"),
    );
  });
}

function ignoredPublication(
  problems: readonly NativeHarnessHistoryReason[],
): NativeHarnessHistoryPublicationResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
    state: "ignored",
    publications: [],
    reasons: boundedReasons(problems),
  });
}

/**
 * Bounded refusal for a callback that was deliberately not attempted because
 * another publication or an actual persistence wait still owns the leaf.
 */
function deferredPublication(code: string, detail: string): NativeHarnessHistoryPublicationResult {
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
    state: "unknown" as const,
    publications: [],
    reasons: boundedReasons([reason(code, detail)]),
  });
}

function aggregatePublication(
  publications: readonly NativeHarnessHistoryPublication[],
  fallbackReasons: readonly NativeHarnessHistoryReason[],
): NativeHarnessHistoryPublicationResult {
  const outcomes = new Set(publications.map((publication) => publication.outcome));
  let state: NativeHarnessHistoryPublicationResult["state"];
  if (outcomes.size === 0) {
    state = fallbackReasons.length > 0 ? "unavailable" : "ignored";
  } else if (outcomes.has("unknown") || outcomes.has("pending")) {
    state = "unknown";
  } else if (outcomes.has("disk-confirmed") || outcomes.has("visible") || outcomes.has("already-visible")) {
    state = outcomes.has("unavailable") || outcomes.has("not-attempted") ? "partial" : "published";
  } else {
    state = "unavailable";
  }
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
    state,
    publications,
    reasons: boundedReasons(fallbackReasons),
  });
}

function statusResult(
  disposed: boolean,
  appendAvailable: boolean,
  attempts: ReadonlyMap<string, AttemptLatch>,
  lastReason: NativeHarnessHistoryReason | null,
  publishing: boolean,
  persistPending: boolean,
): NativeHarnessHistorySessionStatus {
  let diskConfirmed = 0;
  let visible = 0;
  let unknown = 0;
  let pending = 0;
  let unavailable = 0;
  for (const latch of attempts.values()) {
    if (latch.status === "disk-confirmed") diskConfirmed += 1;
    else if (latch.status === "visible") visible += 1;
    else if (latch.status === "unknown") unknown += 1;
    else if (latch.status === "pending") pending += 1;
    else unavailable += 1;
  }
  return deepFreeze({
    schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
    disposed,
    append: appendAvailable ? "available" : "unavailable",
    attempts: attempts.size,
    diskConfirmed,
    visible,
    unknown,
    pending,
    unavailable,
    publishing,
    persistPending,
    lastReason,
  });
}

export function createNativeHarnessHistorySession(
  options: NativeHarnessHistorySessionOptions,
): NativeHarnessHistorySession {
  if (!isCanonicalAbsolutePath(options.storageRoot)) {
    throw new Error("Native history session storageRoot must be a canonical absolute path.");
  }
  const storageRoot = options.storageRoot;
  const io = options.fileIo ?? nodeFileIo;
  const ensureTimeoutMs = readTimeout(options);
  const attempts = new Map<string, AttemptLatch>();
  let disposed = false;
  let lastReason: NativeHarnessHistoryReason | null = null;
  /** One actual OMP persistence promise stays observed until it settles. */
  let pendingEnsure: Promise<unknown> | null = null;
  /**
   * One terminal publication callback owns publication at a time. The latch
   * is taken synchronously before the first await and released only after the
   * complete call, including disk readback, finishes. Overlapping callbacks
   * are refused rather than queued, so they can never append or read.
   */
  let publishing = false;

  function ownerCurrent(context: unknown): boolean {
    if (disposed) return false;
    let current: boolean;
    try {
      current = options.isOwnerCurrent(context) === true;
    } catch {
      return false;
    }
    // The host callback may reenter this leaf and dispose it. A leaf disposed
    // during the callback is never current regardless of the returned flag.
    return current && !disposed;
  }

  function rememberAttempt(key: string, latch: AttemptLatch): void {
    if (attempts.size >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.attempts) {
      for (const [candidateKey, value] of attempts) {
        if (value.status !== "pending" && value.status !== "unknown") {
          attempts.delete(candidateKey);
          break;
        }
      }
    }
    if (attempts.size >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.attempts) return;
    attempts.set(key, latch);
  }

  function setLatch(key: string, latch: AttemptLatch): void {
    if (!attempts.has(key)) {
      rememberAttempt(key, latch);
      return;
    }
    attempts.set(key, latch);
  }

  async function publishOne(
    candidate: ParsedCandidate,
    planned: ResolvedPublication,
    initialBase: PublicationBase,
    context: unknown,
    attemptKey: string,
  ): Promise<{ readonly publication: NativeHarnessHistoryPublication; readonly stop: boolean }> {
    const reportReasons = planned.reportProblem === null ? [] : [planned.reportProblem];
    const publishRow = (
      outcome: NativeHarnessHistoryPublicationOutcome,
      entryId: string | null,
      locatorSha256: string | null,
      reasons: readonly NativeHarnessHistoryReason[],
      durability: "observed-only" | "unknown" = "unknown",
    ): NativeHarnessHistoryPublication =>
      publicationRow(candidate, outcome, entryId, locatorSha256, [...reasons, ...reportReasons], durability);
    if (disposed) {
      return {
        publication: publishRow( "unavailable", null, null, [
          reason("disposed", "The history session was disposed before publication."),
        ]),
        stop: true,
      };
    }
    if (!ownerCurrent(context)) {
      setLatch(attemptKey, {
        status: "unavailable",
        entryId: null,
        locatorSha256: null,
        reason: reason("owner-changed", "The owning native root is no longer current."),
      });
      return {
        publication: publishRow( "unavailable", null, null, [
          reason("owner-changed", "The owning native root is no longer current."),
        ]),
        stop: true,
      };
    }
    const fresh = readPublicationBase(context);
    if (!fresh.ok) {
      setLatch(attemptKey, {
        status: "unavailable",
        entryId: null,
        locatorSha256: null,
        reason: fresh.reason,
      });
      return { publication: publishRow( "unavailable", null, null, [fresh.reason]), stop: false };
    }
    if (!samePublicationBase(initialBase, fresh.value)) {
      const problem = reason("identity-changed", "The actual main session identity changed before publication.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    let freshEntries: BranchEntry[];
    try {
      freshEntries = parseActiveBranch(fresh.value.branch, fresh.value.leafId);
    } catch (error) {
      const problem = reason(
        "branch-invalid",
        error instanceof ObservationFailure ? error.detail : "The actual session branch is malformed.",
      );
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    if (freshEntries.length >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
      const problem = reason("branch-limit", "The actual session branch has no room for another locator.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    const existing = scanLocators(freshEntries);
    const existingProblem = branchLocatorProblem(existing);
    if (existingProblem !== null) {
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: existingProblem });
      return { publication: publishRow( "unavailable", null, null, [existingProblem]), stop: false };
    }
    const exact = existing.filter((locator) => locator.sha256 === planned.locatorSha256);
    if (exact.length > 1) {
      const problem = reason("duplicate-locator", "More than one exact native locator is visible on the current branch.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    if (exact.length === 1) {
      const latch: AttemptLatch = {
        status: "visible",
        entryId: exact[0]!.entry.id,
        locatorSha256: planned.locatorSha256,
        reason: null,
      };
      setLatch(attemptKey, latch);
      return {
        publication: publishRow( "already-visible", exact[0]!.entry.id, planned.locatorSha256, [], "unknown"),
        stop: false,
      };
    }
    if (existing.some((locator) => locator.evidenceKey === planned.evidenceKey)) {
      const problem = reason("duplicate-evidence", "A different locator already claims this exact source/report evidence tuple.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    if (existing.length >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locators) {
      const problem = reason("branch-locator-limit", "The current branch already retains the maximum number of native locators.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    const resolved = resolvePublication(fresh.value, freshEntries, candidate);
    if (resolved.locatorSha256 !== planned.locatorSha256) {
      const problem = reason("source-changed", "The selected source or report changed before publication.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    const appendEntry = options.appendEntry;
    if (appendEntry === undefined) {
      const problem = reason("append-unavailable", "The host does not expose the actual appendEntry transport.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    const beforeLeaf = fresh.value.leafId;
    if (beforeLeaf === null) {
      const problem = reason("branch-invalid", "The actual session has no selected leaf for append.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: false };
    }
    if (!ownerCurrent(context)) {
      const problem = reason("owner-changed", "The owning native root is no longer current before append.");
      setLatch(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: problem });
      return { publication: publishRow( "unavailable", null, null, [problem]), stop: true };
    }
    try {
      appendEntry(NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE, resolved.locator);
    } catch {
      const problem = reason("append-unknown", "appendEntry threw; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    if (disposed || !ownerCurrent(context)) {
      const problem = reason("append-unknown", "appendEntry returned after disposal or owner change; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    const after = readPublicationBase(context);
    if (!after.ok || !samePublicationBase(initialBase, after.value)) {
      const problem = reason("append-unknown", "The actual session identity changed during append; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    let afterEntries: BranchEntry[];
    try {
      afterEntries = parseActiveBranch(after.value.branch, after.value.leafId);
    } catch {
      const problem = reason("append-unknown", "The appended branch could not be read as one contiguous chain; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    if (!sameBranchPrefix(freshEntries, afterEntries) || afterEntries.length !== freshEntries.length + 1) {
      const problem = reason("append-unknown", "The branch did not grow by exactly the expected locator; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    const appended = afterEntries[afterEntries.length - 1]!;
    const expectedEntryCount = afterEntries.filter((entry) => entry.id === appended.id).length;
    if (expectedEntryCount !== 1
      || appended.parentId !== beforeLeaf
      || appended.type !== "custom"
      || appended.value.customType !== NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE
      || !sameCanonical(appended.value.data, resolved.locator)
      || after.value.leafId !== appended.id) {
      const problem = reason("append-unknown", "The visible custom entry is not the exact expected locator; the outcome is possibly applied.");
      setLatch(attemptKey, { status: "unknown", entryId: null, locatorSha256: null, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", null, null, [problem]), stop: true };
    }
    let afterResolved: ResolvedPublication;
    try {
      afterResolved = resolvePublication(after.value, afterEntries, candidate);
    } catch (error) {
      const problem = reason(
        "append-unknown",
        error instanceof ObservationFailure
          ? error.detail
          : "The appended branch no longer proves the selected source and report.",
      );
      setLatch(attemptKey, { status: "unknown", entryId: appended.id, locatorSha256: resolved.locatorSha256, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", appended.id, resolved.locatorSha256, [problem]), stop: true };
    }
    if (afterResolved.locatorSha256 !== resolved.locatorSha256) {
      const problem = reason("append-unknown", "The appended branch no longer proves the exact expected locator.");
      setLatch(attemptKey, { status: "unknown", entryId: appended.id, locatorSha256: resolved.locatorSha256, reason: problem });
      lastReason = problem;
      return { publication: publishRow( "unknown", appended.id, resolved.locatorSha256, [problem]), stop: true };
    }
    setLatch(attemptKey, {
      status: "visible",
      entryId: appended.id,
      locatorSha256: resolved.locatorSha256,
      reason: null,
    });
    lastReason = null;

    const ensureOnDisk = (after.value.manager as Record<string, unknown>).ensureOnDisk;
    if (typeof ensureOnDisk !== "function") {
      const problem = reason("persistence-unavailable", "The actual session manager has no ensureOnDisk capability.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (!ownerCurrent(context)) {
      const problem = reason("persistence-unavailable", "The owning native root changed before the persistence wait.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    // A previous unsettled persistence wait is refused at publishTerminal
    // entry; within one call pendingEnsure is only set immediately below.
    let ensureResult: "settled" | "failed" | "timeout";
    try {
      const actualEnsure = Promise.resolve(Reflect.apply(ensureOnDisk, after.value.manager, []));
      pendingEnsure = actualEnsure;
      void actualEnsure.then(
        () => {
          if (pendingEnsure === actualEnsure) pendingEnsure = null;
        },
        () => {
          if (pendingEnsure === actualEnsure) pendingEnsure = null;
        },
      );
      ensureResult = await timeoutOutcome(actualEnsure, ensureTimeoutMs);
    } catch {
      ensureResult = "failed";
    }
    if (ensureResult !== "settled") {
      const problem = reason(
        ensureResult === "timeout" ? "persist-timeout" : "persist-failed",
        ensureResult === "timeout"
          ? "The bounded persistence wait elapsed; the entry is visible but local confirmation is unavailable."
          : "The actual ensureOnDisk wait failed; the entry is visible but local confirmation is unavailable.",
      );
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (disposed || !ownerCurrent(context)) {
      const problem = reason("persistence-unavailable", "The history session was disposed or the owner changed after persistence.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    const afterPersist = readPublicationBase(context);
    if (!afterPersist.ok || !samePublicationBase(initialBase, afterPersist.value)) {
      const problem = reason("persistence-unavailable", "The actual session identity changed while persistence was pending.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    let persistedEntries: BranchEntry[];
    try {
      persistedEntries = parseActiveBranch(afterPersist.value.branch, afterPersist.value.leafId);
    } catch {
      const problem = reason("persistence-unavailable", "The session branch is malformed after persistence.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (afterPersist.value.leafId !== appended.id) {
      const problem = reason("persistence-unavailable", "The selected leaf changed while persistence was pending.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    const preDisk = resolvePublication(afterPersist.value, persistedEntries, candidate);
    if (preDisk.locatorSha256 !== resolved.locatorSha256) {
      const problem = reason("persistence-unavailable", "The source or report changed while persistence was pending.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (!ownerCurrent(context)) {
      const problem = reason("persistence-unavailable", "The owning native root changed before disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    const reportExpectation: ReportExpectation | null = preDisk.report === null
      ? null
      : {
        runId: candidate.runId,
        toolCallId: candidate.association.toolCallId,
        observationId: candidate.association.observationId,
        generation: candidate.association.generation,
        sessionId: candidate.association.sessionId,
        workspaceRoot: candidate.association.workspaceRoot,
      };
    // Synchronous original-currentness guard for every disk await boundary.
    // It starts no I/O and stops further opens after a held pin is invalidated.
    const currentForDisk = (): boolean => {
      if (disposed || !ownerCurrent(context)) return false;
      const fresh = readPublicationBase(context);
      if (!fresh.ok || !samePublicationBase(afterPersist.value, fresh.value)) return false;
      if (fresh.value.leafId !== appended.id) return false;
      try {
        const freshEntries = parseActiveBranch(fresh.value.branch, fresh.value.leafId);
        if (freshEntries.length !== persistedEntries.length) return false;
        for (let index = 0; index < freshEntries.length; index += 1) {
          if (freshEntries[index]!.id !== persistedEntries[index]!.id) return false;
          if (freshEntries[index]!.parentId !== persistedEntries[index]!.parentId) return false;
        }
        const selected = scanLocators(freshEntries).find((locator) => locator.entry.id === appended.id);
        if (selected === undefined || selected.sha256 !== resolved.locatorSha256) return false;
        if (resolvePublication(fresh.value, freshEntries, candidate).locatorSha256 !== resolved.locatorSha256) {
          return false;
        }
        // Manager callbacks in the fresh read may have reentered and disposed
        // or replaced the owner; the disk guard must not stay current.
        return !disposed && ownerCurrent(context);
      } catch {
        return false;
      }
    };
    const confirmation = await confirmSessionDisk(
      afterPersist.value,
      appended.id,
      beforeLeaf,
      resolved.locator,
      preDisk.sourceReference,
      preDisk.reportReference,
      reportExpectation,
      io,
      currentForDisk,
      nowValue(options),
    );
    if (!confirmation.ok) {
      const problem = confirmation.reason ?? reason("disk-unavailable", "Local disk confirmation is unavailable.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (disposed || !ownerCurrent(context)) {
      const problem = reason("disk-unavailable", "The history session or owner changed after disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    const afterDisk = readPublicationBase(context);
    if (!afterDisk.ok || !samePublicationBase(initialBase, afterDisk.value)) {
      const problem = reason("disk-unavailable", "The actual session identity changed after disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    let finalEntries: BranchEntry[];
    try {
      finalEntries = parseActiveBranch(afterDisk.value.branch, afterDisk.value.leafId);
    } catch {
      const problem = reason("disk-unavailable", "The session branch is malformed after disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    if (afterDisk.value.leafId !== appended.id) {
      const problem = reason("disk-unavailable", "The selected leaf changed after disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    const finalResolved = resolvePublication(afterDisk.value, finalEntries, candidate);
    if (finalResolved.locatorSha256 !== resolved.locatorSha256) {
      const problem = reason("disk-unavailable", "The source or report changed after disk readback.");
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    // Last host reads and branch projections above may have reentered and
    // disposed the leaf or replaced the owner. Never latch disk confirmation
    // after that loss.
    if (disposed || !ownerCurrent(context)) {
      const problem = reason(
        "persistence-unavailable",
        "The history session was disposed or the owner changed before the final disk confirmation.",
      );
      const latch = attempts.get(attemptKey);
      if (latch !== undefined) setLatch(attemptKey, { ...latch, reason: problem });
      lastReason = problem;
      return {
        publication: publishRow( "visible", appended.id, resolved.locatorSha256, [problem]),
        stop: true,
      };
    }
    setLatch(attemptKey, {
      status: "disk-confirmed",
      entryId: appended.id,
      locatorSha256: resolved.locatorSha256,
      reason: null,
    });
    lastReason = null;
    return {
      publication: publishRow( "disk-confirmed", appended.id, resolved.locatorSha256, [], "observed-only"),
      stop: false,
    };
  }

  const session: NativeHarnessHistorySession = {
    async publishTerminal(context, actualTerminalEvent, hostSourceCandidates) {
      if (disposed) {
        return aggregatePublication([], [reason("disposed", "The history session is disposed.")]);
      }
      if (pendingEnsure !== null) {
        return deferredPublication(
          "persist-pending",
          "An earlier actual persistence wait has not settled yet; no new append, ensure or read was started.",
        );
      }
      let eventRecord: Record<string, unknown>;
      try {
        eventRecord = asRecord(actualTerminalEvent, "The actual terminal event is unavailable.");
      } catch {
        return aggregatePublication([], [reason("terminal-unavailable", "The actual terminal event is unavailable.")]);
      }
      const willContinue = optionalField(eventRecord, "willContinue");
      const awaitingAsyncWork = optionalField(eventRecord, "awaitingAsyncWork");
      if (willContinue === true || awaitingAsyncWork === true) {
        return ignoredPublication([
          reason("non-terminal", "A continuation or awaited async work is not a terminal publication boundary."),
        ]);
      }
      const initial = readPublicationBase(context);
      if (!initial.ok) {
        if (initial.code === "not-main") return aggregatePublication([], [initial.reason]);
        return aggregatePublication([], [initial.reason]);
      }
      if (!ownerCurrent(context)) {
        return aggregatePublication([], [reason("owner-changed", "The owning native root is not current.")]);
      }
      if (!Array.isArray(hostSourceCandidates)) {
        return aggregatePublication([], [reason("candidate-invalid", "Host source candidates are not an array.")]);
      }
      if (hostSourceCandidates.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.candidates) {
        return aggregatePublication([], [
          reason("candidate-limit", "Host source candidates exceed the fixed retained-operation bound."),
        ]);
      }
      let initialEntries: BranchEntry[];
      try {
        initialEntries = parseActiveBranch(initial.value.branch, initial.value.leafId);
      } catch (error) {
        return aggregatePublication([], [
          reason(
            "branch-invalid",
            error instanceof ObservationFailure ? error.detail : "The actual session branch is malformed.",
          ),
        ]);
      }
      const initialLocators = scanLocators(initialEntries);
      const initialLocatorProblem = branchLocatorProblem(initialLocators);
      if (initialLocatorProblem !== null) return aggregatePublication([], [initialLocatorProblem]);
      if (initialEntries.length >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
        return aggregatePublication([], [reason("branch-limit", "The actual session branch has no room for another locator.")]);
      }
      if (hostSourceCandidates.length === 0) {
        return ignoredPublication([reason("no-candidates", "No host source candidates were supplied.")]);
      }
      const parsed: ParsedCandidate[] = [];
      const rows: PreparedRow[] = [];
      const byToolCall = new Map<string, ParsedCandidate[]>();
      for (const raw of hostSourceCandidates) {
        try {
          const candidate = parseCandidate(raw, initial.value, storageRoot);
          parsed.push(candidate);
          const group = byToolCall.get(candidate.association.toolCallId) ?? [];
          group.push(candidate);
          byToolCall.set(candidate.association.toolCallId, group);
        } catch (error) {
          rows.push({
            candidateKey: null,
            toolCallId: null,
            runId: null,
            planned: null,
            outcome: "unavailable",
            entryId: null,
            locatorSha256: null,
            durability: "unknown",
            reasons: [
              reason(
                "candidate-invalid",
                error instanceof ObservationFailure ? error.detail : "A host source candidate is unavailable.",
              ),
            ],
          });
        }
      }
      const ambiguousToolCalls = new Set<string>();
      for (const [toolCallId, group] of byToolCall) {
        const keys = new Set(group.map((candidate) => candidate.key));
        if (keys.size > 1) ambiguousToolCalls.add(toolCallId);
      }
      for (const candidate of parsed) {
        if (ambiguousToolCalls.has(candidate.association.toolCallId)) {
          rows.push({
            candidateKey: candidate.key,
            toolCallId: candidate.association.toolCallId,
            runId: candidate.runId,
            planned: null,
            outcome: "unavailable",
            entryId: null,
            locatorSha256: null,
            durability: "unknown",
            reasons: [reason("candidate-ambiguous", "Two different candidates claim the same source tool call.")],
          });
          continue;
        }
        try {
          const planned = resolvePublication(initial.value, initialEntries, candidate);
          rows.push({
            candidateKey: candidate.key,
            toolCallId: candidate.association.toolCallId,
            runId: candidate.runId,
            planned,
            outcome: null,
            entryId: null,
            locatorSha256: planned.locatorSha256,
            durability: "unknown",
            reasons: planned.reportProblem === null ? [] : [planned.reportProblem],
          });
        } catch (error) {
          rows.push({
            candidateKey: candidate.key,
            toolCallId: candidate.association.toolCallId,
            runId: candidate.runId,
            planned: null,
            outcome: "unavailable",
            entryId: null,
            locatorSha256: null,
            durability: "unknown",
            reasons: [
              reason(
                error instanceof ObservationFailure
                  ? error.code === "source-missing" ? "source-missing" : error.code
                  : "publication-unavailable",
                error instanceof ObservationFailure
                  ? error.detail
                  : "The source/report evidence could not be resolved.",
              ),
            ],
          });
        }
      }
      const publications: NativeHarnessHistoryPublication[] = [];
      let stop = false;
      for (const row of rows) {
        if (row.outcome !== null) {
          publications.push(
            publicationRow(
              row.candidateKey === null ? null : parsed.find((candidate) => candidate.key === row.candidateKey) ?? null,
              row.outcome,
              row.entryId,
              row.locatorSha256,
              row.reasons,
              row.durability,
            ),
          );
          continue;
        }
        if (stop || row.planned === null || row.candidateKey === null) {
          publications.push(
            publicationRow(
              parsed.find((candidate) => candidate.key === row.candidateKey) ?? null,
              "not-attempted",
              null,
              row.locatorSha256,
              [reason("not-attempted", "Publication stopped after an earlier possibly-applied attempt.")],
            ),
          );
          continue;
        }
        const candidate = parsed.find((value) => value.key === row.candidateKey)!;
        const attemptKey = canonicalSha({
          candidate: candidate.key,
          source: row.planned.sourceReference,
          report: row.planned.reportReference,
        });
        if (attemptKey === null) {
          publications.push(publicationRow(candidate, "unavailable", null, null, [
            reason("candidate-invalid", "The attempted publication key is not canonically encodable."),
          ]));
          continue;
        }
        const latched = attempts.get(attemptKey);
        if (latched !== undefined) {
          if (latched.status === "pending") {
            publications.push(publicationRow(candidate, "unknown", null, null, [
              reason("attempt-pending", "The same source/report attempt is still pending."),
            ]));
            stop = true;
            continue;
          }
          if (latched.status === "unknown") {
            publications.push(publicationRow(candidate, "unknown", latched.entryId, latched.locatorSha256, [
              latched.reason ?? reason("attempt-unknown", "The attempt outcome is possibly applied."),
            ]));
            stop = true;
            continue;
          }
          if (latched.status === "visible" || latched.status === "disk-confirmed") {
            const currentLocator = latched.entryId === null || latched.locatorSha256 === null
              ? undefined
              : initialLocators.find((locator) =>
                locator.entry.id === latched.entryId && locator.sha256 === latched.locatorSha256);
            if (currentLocator === undefined) {
              publications.push(publicationRow(candidate, "unavailable", null, null, [
                reason(
                  "locator-not-current",
                  "The previously published locator is no longer on the current branch; no append was attempted.",
                ),
              ]));
              stop = true;
              continue;
            }
            publications.push(publicationRow(
              candidate,
              "already-visible",
              latched.entryId,
              latched.locatorSha256,
              latched.reason === null ? [] : [latched.reason],
              latched.status === "disk-confirmed" ? "observed-only" : "unknown",
            ));
            continue;
          }
          publications.push(publicationRow(candidate, "unavailable", null, null, [
            latched.reason ?? reason("attempt-unavailable", "The attempt was already unavailable."),
          ]));
          continue;
        }
        if (attempts.size >= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.attempts) {
          rememberAttempt(attemptKey, { status: "unavailable", entryId: null, locatorSha256: null, reason: null });
          if (!attempts.has(attemptKey)) {
            publications.push(publicationRow(candidate, "unavailable", null, null, [
              reason("attempt-limit", "The bounded attempt latch is full of ambiguous attempts."),
            ]));
            stop = true;
            continue;
          }
        } else {
          attempts.set(attemptKey, {
            status: "pending",
            entryId: null,
            locatorSha256: row.planned.locatorSha256,
            reason: null,
          });
        }
        const result = await publishOne(candidate, row.planned, initial.value, context, attemptKey);
        publications.push(result.publication);
        if (result.publication.outcome === "unknown") stop = true;
        if (result.stop) stop = true;
      }
      return aggregatePublication(publications, []);
    },

    list(context, page) {
      if (disposed) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          rows: [],
          page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([reason("disposed", "The history session is disposed.")]),
        });
      }
      if (!ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          rows: [],
          page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([reason("owner-changed", "The owning native root is not current.")]),
        });
      }
      const read = readSessionBase(context);
      if (!read.ok) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          rows: [],
          page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([read.reason]),
        });
      }
      const offset = page?.offset ?? 0;
      const limit = page?.limit ?? NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pageRows;
      if (
        !Number.isSafeInteger(offset)
        || offset < 0
        || offset > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locators
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pageRows
      ) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          rows: [],
          page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([reason("page-invalid", "The history page bounds are invalid.")]),
        });
      }
      let entries: BranchEntry[];
      try {
        entries = parseActiveBranch(read.value.branch, read.value.leafId);
      } catch (error) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalid" as const,
          rows: [],
          page: { offset, limit, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([
            reason(
              "branch-invalid",
              error instanceof ObservationFailure ? error.detail : "The current session branch is malformed.",
            ),
          ]),
        });
      }
      const locators = scanLocators(entries);
      const rows: NativeHarnessHistoryListRow[] = [];
      let invalid = locators.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locators;
      for (const locator of locators) {
        if (locator.decoded === null || locator.sha256 === null || locator.bytes === null || locator.bytes > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.locatorBytes) {
          invalid = true;
          rows.push({
            entryId: locator.entry.id,
            decode: "invalid",
            locatorSha256: null,
            runId: null,
            toolCallId: null,
            labelCompatibility: "unknown",
          });
          continue;
        }
        const originMatch = locator.decoded.originSessionId === read.value.sessionId;
        const workspaceMatch = locator.decoded.workspacePath === read.value.cwd;
        rows.push({
          entryId: locator.entry.id,
          decode: "ok",
          locatorSha256: locator.sha256,
          runId: locator.decoded.runId,
          toolCallId: locator.decoded.source.toolCallId,
          labelCompatibility: originMatch && workspaceMatch ? "match" : "mismatch",
        });
      }
      const pageRows = rows.slice(offset, offset + limit);
      const nextOffset = offset + pageRows.length < rows.length ? offset + pageRows.length : null;
      // Manager reads and branch projections above may have reentered and
      // disposed the leaf or replaced the owner; never return current rows then.
      if (disposed || !ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          rows: [],
          page: { offset: 0, limit: 0, total: 0, returned: 0, nextOffset: null },
          reasons: boundedReasons([
            disposed
              ? reason("disposed", "The history session is disposed.")
              : reason("owner-changed", "The owning native root is not current."),
          ]),
        });
      }
      return deepFreeze({
        schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
        state: invalid ? "incomplete" : "complete",
        rows: pageRows,
        page: { offset, limit, total: rows.length, returned: pageRows.length, nextOffset },
        reasons: boundedReasons(
          invalid
            ? [reason("branch-incomplete", "The current branch contains invalid or excess native locators.")]
            : [],
        ),
      });
    },

    async inspect(context, selector, actualSignal) {
      // Descriptor-only and bounded before any rejection echo. Invalid or
      // accessor fields become empty strings; raw caller text never returns.
      const selectorEntryId = (() => {
        try {
          const raw = optionalField(selector, "entryId");
          return typeof raw === "string"
            && raw.length > 0
            && raw.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars
            && !CONTROL_PATTERN.test(raw)
            ? raw
            : "";
        } catch {
          return "";
        }
      })();
      const selectorSha256 = (() => {
        try {
          const raw = optionalField(selector, "locatorSha256");
          return typeof raw === "string" && SHA256_PATTERN.test(raw) ? raw : "";
        } catch {
          return "";
        }
      })();
      const fallbackSelector: NativeHarnessHistorySelector = {
        entryId: selectorEntryId,
        locatorSha256: selectorSha256,
      };
      const unavailable = (state: NativeHarnessHistorySessionInspection["state"], problems: readonly NativeHarnessHistoryReason[]): NativeHarnessHistorySessionInspection =>
        deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state,
          selector: fallbackSelector,
          locator: null,
          labels: { originSession: "unknown" as const, workspace: "unknown" as const },
          evidence: { source: "unavailable" as const, report: "unavailable" as const },
          declaration: {
            state: "absent" as const,
            files: 0,
            reportEntryId: null,
            problem: problems[0] ?? null,
          },
          current: false,
          inspection: null,
          reasons: boundedReasons(problems),
        });
      if (disposed) return unavailable("unavailable", [reason("disposed", "The history session is disposed.")]);
      if (!ownerCurrent(context)) {
        return unavailable("unavailable", [reason("owner-changed", "The owning native root is not current.")]);
      }
      if (!isPlainRecord(selector)) {
        return unavailable("unavailable", [reason("selector-invalid", "The history selector is unavailable.")]);
      }
      let entryId: string;
      let locatorSha256: string;
      try {
        entryId = textField(selector, "entryId", NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars, "The selector entry id is unavailable.");
        locatorSha256 = shaField(selector, "locatorSha256", "The selector locator digest is malformed.");
      } catch {
        return unavailable("unavailable", [reason("selector-invalid", "The history selector is unavailable.")]);
      }
      const read = readSessionBase(context);
      if (!read.ok) return unavailable("unavailable", [read.reason]);
      let entries: BranchEntry[];
      try {
        entries = parseActiveBranch(read.value.branch, read.value.leafId);
      } catch (error) {
        return unavailable("unavailable", [
          reason(
            "branch-invalid",
            error instanceof ObservationFailure ? error.detail : "The current session branch is malformed.",
          ),
        ]);
      }
      const locators = scanLocators(entries);
      const locatorProblem = branchLocatorProblem(locators);
      if (locatorProblem !== null) return unavailable("unavailable", [locatorProblem]);
      const selected = locators.find((locator) => locator.entry.id === entryId);
      if (selected === undefined) {
        return unavailable("unavailable", [reason("selector-absent", "The selector entry is absent from the current branch.")]);
      }
      if (selected.sha256 === null || selected.sha256 !== locatorSha256 || selected.decoded === null) {
        return unavailable("unavailable", [reason("selector-mismatch", "The selector locator digest does not match the current branch entry.")]);
      }
      const locator = selected.decoded;
      const signal = readActualAbortSignal(actualSignal);
      if (!signal.ok) {
        return unavailable("unavailable", [reason("abort-signal-unavailable", "The actual host AbortSignal is missing or unreadable.")]);
      }
      if (signal.aborted) {
        return unavailable("aborted", [reason("query-aborted", "The host AbortSignal was aborted; no history I/O was started.")]);
      }
      const labels = {
        originSession: locator.originSessionId === read.value.sessionId ? "match" as const : "mismatch" as const,
        workspace: locator.workspacePath === read.value.cwd ? "match" as const : "mismatch" as const,
      };
      const problems: NativeHarnessHistoryReason[] = [];
      if (labels.originSession === "mismatch") {
        problems.push(reason("origin-session-mismatch", "The locator origin session label differs from the current session; it remains historical."));
      }
      if (labels.workspace === "mismatch") {
        problems.push(reason("workspace-mismatch", "The locator workspace label differs from the current main workspace; it is not adopted as current."));
      }
      let evidenceSource: NativeHarnessHistoryEvidenceState = "unavailable";
      let evidenceReport: NativeHarnessHistoryEvidenceState = locator.evidence?.report === null ? "not-present" : "unavailable";
      let declaredArtifacts: readonly NativeHarnessHistoryDeclaredArtifact[] | null = null;
      let declaration: NativeHarnessHistorySessionInspection["declaration"] = {
        state: "absent",
        files: 0,
        reportEntryId: null,
        problem: reason("artifact-manifest-absent", "No referenced historical Harness report supplies declared files."),
      };
      let sourceReference: EvidenceReference | null = locator.evidence?.source ?? null;
      let reportReference: EvidenceReference | null = locator.evidence?.report ?? null;
      let reportExpectation: ReportExpectation | null = null;
      if (sourceReference !== null) {
        if (locator.source.toolCallId === null || locator.source.observationId === null || locator.source.generation === null) {
          evidenceSource = "unavailable";
          problems.push(reason("source-label-unavailable", "The locator does not carry complete source labels."));
          sourceReference = null;
        } else {
          const sourceEntry = entries.find((entry) => entry.id === sourceReference!.entryId);
          if (sourceEntry === undefined) {
            evidenceSource = "mismatch";
            problems.push(reason("source-entry-missing", "The referenced source entry is absent from the current branch."));
          } else {
            try {
              const normalized = sourceProjection(sourceEntry, locator.runId, locator.source.toolCallId);
              if (normalized.sha256 !== sourceReference.sha256) {
                evidenceSource = "mismatch";
                problems.push(reason("source-entry-changed", "The referenced source entry no longer matches its recorded fingerprint."));
              } else {
                evidenceSource = "match";
              }
            } catch {
              evidenceSource = "mismatch";
              problems.push(reason("source-entry-invalid", "The referenced source entry is no longer a valid native Harness result."));
            }
          }
        }
      }
      if (reportReference !== null) {
        if (locator.source.toolCallId === null || locator.source.observationId === null || locator.source.generation === null) {
          evidenceReport = "unavailable";
        } else {
          const reportEntry = entries.find((entry) => entry.id === reportReference!.entryId);
          if (reportEntry === undefined) {
            evidenceReport = "mismatch";
            problems.push(reason("report-entry-missing", "The referenced report entry is absent from the current branch."));
          } else {
            reportExpectation = {
              runId: locator.runId,
              toolCallId: locator.source.toolCallId,
              observationId: locator.source.observationId,
              generation: locator.source.generation,
              sessionId: locator.originSessionId,
              workspaceRoot: locator.workspacePath,
            };
            try {
              const normalized = reportProjection(reportEntry, reportExpectation);
              if (normalized.sha256 !== reportReference.sha256) {
                evidenceReport = "mismatch";
                problems.push(reason("report-entry-changed", "The referenced report entry no longer matches its recorded fingerprint."));
              } else {
                evidenceReport = "match";
                if (normalized.files.length === 0) {
                  declaration = {
                    state: "empty",
                    files: 0,
                    reportEntryId: normalized.entryId,
                    problem: reason("artifact-manifest-empty", "The referenced report declares no file artifacts."),
                  };
                  declaredArtifacts = [];
                } else {
                  declaration = {
                    state: "present",
                    files: normalized.files.length,
                    reportEntryId: normalized.entryId,
                    problem: null,
                  };
                  declaredArtifacts = normalized.files.map((file) => Object.freeze({
                    relativePath: file.path,
                    bytes: file.bytes,
                    sha256: file.sha256,
                    declaredAt: null,
                    declaredByEntryId: normalized.entryId,
                  }));
                }
              }
            } catch (error) {
              evidenceReport = "unavailable";
              problems.push(reason(
                "report-entry-invalid",
                error instanceof ObservationFailure
                  ? error.detail
                  : "The referenced report entry is unavailable.",
              ));
            }
          }
        }
      }
      if (evidenceSource !== "match") {
        problems.push(reason("artifact-manifest-unavailable", "No verified source/report pair supplies declared artifacts."));
        declaration = {
          state: "invalid",
          files: 0,
          reportEntryId: reportReference?.entryId ?? null,
          problem: reason("artifact-manifest-unavailable", "The artifact declaration is unavailable, not empty or complete."),
        };
        declaredArtifacts = null;
      }
      const orderProblem = referenceOrderProblem(entries, selected.index, sourceReference, reportReference);
      if (orderProblem !== null) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([...problems, orderProblem]),
        });
      }
      // Host reads and branch projections above may have reentered and
      // disposed the leaf or replaced the owner; start no storage-root I/O then.
      if (disposed || !ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The history session or owning root changed before the storage-root query."),
          ]),
        });
      }
      const rootBefore = await pinDirectory(storageRoot, io);
      if (disposed || !ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The history session or owning root changed before the storage-root query."),
          ]),
        });
      }
      if (rootBefore === null) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "unavailable" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("storage-root-unavailable", "The configured storage root is missing, aliased or not a directory."),
          ]),
        });
      }
      const startedRead = await inspectNativeHarnessHistory({
        storageRoot,
        locator,
        declaredArtifacts,
        signal: actualSignal as AbortSignal,
        fileIo: io,
        now: () => nowValue(options),
        ...(options.processObserver === undefined ? {} : { processObserver: options.processObserver }),
      });
      const rootAfter = await pinDirectory(storageRoot, io);
      if (rootAfter === null || !sameDirectoryPin(rootBefore, rootAfter)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The storage root identity changed during the history query."),
          ]),
        });
      }
      if (disposed || !ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The history session or owning root changed during the query."),
          ]),
        });
      }
      const after = readSessionBase(context);
      if (!after.ok || !sameBase(read.value, after.value)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The actual main session identity changed during the query."),
          ]),
        });
      }
      let afterEntries: BranchEntry[];
      try {
        afterEntries = parseActiveBranch(after.value.branch, after.value.leafId);
      } catch {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The current session branch changed during the query."),
          ]),
        });
      }
      const afterLocators = scanLocators(afterEntries);
      const afterSelected = afterLocators.find((locator) => locator.entry.id === entryId);
      if (afterSelected === undefined || afterSelected.sha256 !== locatorSha256) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The selected locator changed or left the current branch during the query."),
          ]),
        });
      }
      const lateOrder = referenceOrderProblem(
        afterEntries,
        afterSelected.index,
        sourceReference,
        reportReference,
      );
      if (lateOrder !== null) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            lateOrder,
            reason("invalidated", "The reference order changed during the query."),
          ]),
        });
      }
      if (sourceReference !== null) {
        const afterSource = afterEntries.find((entry) => entry.id === sourceReference!.entryId);
        if (afterSource === undefined || locator.source.toolCallId === null) {
          return deepFreeze({
            schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
            state: "invalidated" as const,
            selector: { entryId, locatorSha256 },
            locator,
            labels,
            evidence: { source: evidenceSource, report: evidenceReport },
            declaration,
            current: false,
            inspection: null,
            reasons: boundedReasons([
              ...problems,
              reason("invalidated", "The referenced source entry left the current branch during the query."),
            ]),
          });
        }
        try {
          const again = sourceProjection(afterSource, locator.runId, locator.source.toolCallId);
          if (again.sha256 !== sourceReference.sha256) {
            return deepFreeze({
              schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
              state: "invalidated" as const,
              selector: { entryId, locatorSha256 },
              locator,
              labels,
              evidence: { source: evidenceSource, report: evidenceReport },
              declaration,
              current: false,
              inspection: null,
              reasons: boundedReasons([
                ...problems,
                reason("invalidated", "The referenced source entry changed during the query."),
              ]),
            });
          }
        } catch {
          return deepFreeze({
            schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
            state: "invalidated" as const,
            selector: { entryId, locatorSha256 },
            locator,
            labels,
            evidence: { source: evidenceSource, report: evidenceReport },
            declaration,
            current: false,
            inspection: null,
            reasons: boundedReasons([
              ...problems,
              reason("invalidated", "The referenced source entry became invalid during the query."),
            ]),
          });
        }
      }
      if (reportReference !== null && reportExpectation !== null) {
        const afterReport = afterEntries.find((entry) => entry.id === reportReference!.entryId);
        if (afterReport === undefined) {
          return deepFreeze({
            schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
            state: "invalidated" as const,
            selector: { entryId, locatorSha256 },
            locator,
            labels,
            evidence: { source: evidenceSource, report: evidenceReport },
            declaration,
            current: false,
            inspection: null,
            reasons: boundedReasons([
              ...problems,
              reason("invalidated", "The referenced report entry left the current branch during the query."),
            ]),
          });
        }
        try {
          const again = reportProjection(afterReport, reportExpectation);
          if (again.sha256 !== reportReference.sha256) {
            return deepFreeze({
              schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
              state: "invalidated" as const,
              selector: { entryId, locatorSha256 },
              locator,
              labels,
              evidence: { source: evidenceSource, report: evidenceReport },
              declaration,
              current: false,
              inspection: null,
              reasons: boundedReasons([
                ...problems,
                reason("invalidated", "The referenced report entry changed during the query."),
              ]),
            });
          }
        } catch {
          return deepFreeze({
            schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
            state: "invalidated" as const,
            selector: { entryId, locatorSha256 },
            locator,
            labels,
            evidence: { source: evidenceSource, report: evidenceReport },
            declaration,
            current: false,
            inspection: null,
            reasons: boundedReasons([
              ...problems,
              reason("invalidated", "The referenced report entry became invalid during the query."),
            ]),
          });
        }
      }
      // The final session read and all branch projections above may have
      // reentered and disposed the leaf or replaced the owner; never mark that
      // result current.
      if (disposed || !ownerCurrent(context)) {
        return deepFreeze({
          schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
          state: "invalidated" as const,
          selector: { entryId, locatorSha256 },
          locator,
          labels,
          evidence: { source: evidenceSource, report: evidenceReport },
          declaration,
          current: false,
          inspection: null,
          reasons: boundedReasons([
            ...problems,
            reason("invalidated", "The history session or owning root changed before the inspection result."),
          ]),
        });
      }
      const result: NativeHarnessHistorySessionInspection = {
        schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
        state: startedRead.state === "aborted"
          ? "aborted"
          : evidenceSource === "match" && evidenceReport !== "mismatch" && declaration.state !== "invalid"
            ? startedRead.state
            : "partial",
        selector: { entryId, locatorSha256 },
        locator,
        labels,
        evidence: { source: evidenceSource, report: evidenceReport },
        declaration,
        current: true,
        inspection: startedRead,
        reasons: boundedReasons(problems),
      };
      const fingerprint = fingerprintNativeJson(result);
      if (fingerprint.ok && fingerprint.bytes <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.resultBytes) {
        return deepFreeze(result);
      }
      return deepFreeze({
        schema: NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
        state: "partial" as const,
        selector: { entryId, locatorSha256 },
        locator,
        labels,
        evidence: { source: evidenceSource, report: evidenceReport },
        declaration,
        current: true,
        inspection: null,
        reasons: boundedReasons([
          ...problems,
          reason("projection-oversized", "The combined history projection exceeds its fixed 64 KiB result bound."),
        ]),
      });
    },

    status() {
      return statusResult(
        disposed,
        options.appendEntry !== undefined,
        attempts,
        lastReason,
        publishing,
        pendingEnsure !== null,
      );
    },

    dispose() {
      disposed = true;
    },
  };
  return {
    ...session,
    async publishTerminal(
      context: unknown,
      actualTerminalEvent: unknown,
      hostSourceCandidates: readonly NativeHarnessHistorySourceCandidate[],
    ): Promise<NativeHarnessHistoryPublicationResult> {
      if (publishing) {
        return deferredPublication(
          "publication-pending",
          "Another terminal publication callback currently owns the leaf; no append, ensure or read was started.",
        );
      }
      publishing = true;
      try {
        return await session.publishTerminal(context, actualTerminalEvent, hostSourceCandidates);
      } finally {
        publishing = false;
      }
    },
  };
}
