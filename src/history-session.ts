import {
  createHistoryProjectionWriter,
  HISTORY_ITEM_BYTES_LIMIT,
  HISTORY_ITEM_LIMIT,
  HistoryProjectionError,
  type HistoryItem,
  type HistoryProjectionWriter,
} from "./history-projection.ts";
import { genuineUserText, parseBranch } from "./task-branch.ts";
import type { RequirementSource } from "./task-requirements.ts";
import {
  TASK_REPLAY_ENTRY_LIMIT,
  type TaskOwner,
  type TaskOwnerEvent,
  type TaskStatus,
} from "./task-owner.ts";
import {
  canonicalWorkspaceRoot,
  type OmpSessionManager,
  type OmpToolContext,
} from "./task-entry-port.ts";
import type { ExecutionRunReference } from "./execution-adapter.ts";

/**
 * G3-B1 host capture and native locator lifecycle.
 *
 * This component captures only committed current tasks into the new daily
 * instance's history projection, then publishes a small native custom entry
 * from the real main-agent `agent_end` context. It deliberately has no query,
 * resume, replay, recovery or authority-restoration path. A captured
 * projection and a visible session locator are distinct states: the locator
 * is counted only after the actual in-memory branch shows exactly one new,
 * expected custom entry.
 */

export const HISTORY_LOCATOR_CUSTOM_TYPE = "omp-agent.history.locator" as const;
export const HISTORY_LOCATOR_VERSION = 1 as const;
export const HISTORY_RUN_LOCATOR_CUSTOM_TYPE = "omp-agent.history.run-locator" as const;
export const HISTORY_RUN_LOCATOR_VERSION = 1 as const;
/** Native run locator payload, measured as compact JSON UTF-8 bytes. */
export const HISTORY_RUN_LOCATOR_DATA_BYTES_LIMIT = 4096;
/** Mirrors the execution adapter's actual returned artifact bound. */
export const HISTORY_RUN_ARTIFACT_LIMIT = 8;
/** Reuses the projection row bound; this is rows, not tasks. */
export const HISTORY_SESSION_QUEUE_LIMIT = HISTORY_ITEM_LIMIT;
/** Each item is already bounded by the projection; the queue is bounded too. */
export const HISTORY_SESSION_QUEUE_BYTES_LIMIT = HISTORY_ITEM_BYTES_LIMIT * HISTORY_ITEM_LIMIT;
/** Consumed/refused/unknown run keys retained to prevent retries. */
export const HISTORY_RUN_KEY_LIMIT = HISTORY_SESSION_QUEUE_LIMIT;
/** Strict allowlisted locator data is far smaller than this. */
export const HISTORY_LOCATOR_DATA_BYTES_LIMIT = 1024;
/** Existing replay bound reused as the complete-branch traversal budget. */
export const HISTORY_SESSION_BRANCH_ENTRY_LIMIT = TASK_REPLAY_ENTRY_LIMIT;
/** Small bounded wait; a late completion is never allowed to append. */
export const HISTORY_ENSURE_ON_DISK_TIMEOUT_MS = 2000;

const SAFE_INSTANCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RUN_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOUNDED_DIGEST = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const LOCATOR_KEYS = [
  "version",
  "instanceId",
  "ownerId",
  "historyId",
  "digest",
  "taskId",
  "taskRevision",
  "originSessionId",
] as const;
const RUN_LOCATOR_KEYS = [
  "version",
  "instanceId",
  "ownerId",
  "historyId",
  "digest",
  "taskId",
  "taskRevision",
  "requirementsDigest",
  "originSessionId",
  "runId",
  "callId",
  "runDirectory",
  "artifactIds",
  "recordWriteReturned",
  "byteIntegrity",
  "authorityRestored",
] as const;

const CAPTURE_EVENT_STATUS: Readonly<Record<string, TaskStatus>> = Object.freeze({
  task_started: "active",
  task_revised: "active",
  task_cancelled: "cancelled",
  task_accepted: "accepted",
});

export type HistoryReasonCode =
  | "capture_failed"
  | "capture_unknown"
  | "event_snapshot_mismatch"
  | "limit"
  | "source_mismatch"
  | "navigation"
  | "dispose"
  | "identity_changed"
  | "timeout"
  | "append_ambiguous"
  | "unavailable";

const REASON_CODES: readonly HistoryReasonCode[] = [
  "capture_failed",
  "capture_unknown",
  "event_snapshot_mismatch",
  "limit",
  "source_mismatch",
  "navigation",
  "dispose",
  "identity_changed",
  "timeout",
  "append_ambiguous",
  "unavailable",
];

/** Run-locator outcomes are counted separately from task captures. */
export type HistoryRunReasonCode =
  | "task_history_missing"
  | "task_history_unconfirmed"
  | "generation_changed"
  | "session_changed"
  | "source_mismatch"
  | "limit"
  | "unavailable"
  | "timeout"
  | "append_ambiguous"
  | "conflict"
  | "invalid";

const RUN_REASON_CODES: readonly HistoryRunReasonCode[] = [
  "task_history_missing",
  "task_history_unconfirmed",
  "generation_changed",
  "session_changed",
  "source_mismatch",
  "limit",
  "unavailable",
  "timeout",
  "append_ambiguous",
  "conflict",
  "invalid",
];

/** Exact allowlisted payload. No path, root, ledger text, grant or run data. */
export interface HistoryLocatorData {
  readonly version: typeof HISTORY_LOCATOR_VERSION;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly historyId: string;
  readonly digest: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly originSessionId: string;
}

/**
 * Exact allowlisted native run linkage. It carries host-observed run facts
 * only: no record-byte verification, settlement, candidate registration or
 * restored authority is claimed.
 */
export interface HistoryRunLocatorData {
  readonly version: typeof HISTORY_RUN_LOCATOR_VERSION;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly historyId: string;
  readonly digest: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly requirementsDigest: string;
  readonly originSessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly runDirectory: string;
  readonly artifactIds: readonly string[];
  readonly recordWriteReturned: true;
  readonly byteIntegrity: "not_checked";
  readonly authorityRestored: false;
}

export interface HistoryRunStatus {
  /** Distinct adapter references retained for idempotence, including refusals. */
  readonly observed: number;
  readonly visible: number;
  readonly incomplete: number;
  readonly unknown: number;
  readonly conflicts: number;
  /** Run imports holding shared pending count/byte capacity before append. */
  readonly reserved: number;
  readonly reservedBytes: number;
  readonly retainedKeys: number;
  readonly keyLimit: number;
  /** Once key capacity is exhausted, unseen references stay refused. */
  readonly keyLimitLatched: boolean;
  readonly lastReason: { readonly code: HistoryRunReasonCode; readonly detail: string } | null;
  readonly reasonCounts: Readonly<Record<HistoryRunReasonCode, number>>;
}

export interface HistorySessionStatus {
  readonly capture: "ready" | "unavailable";
  readonly locator: "ready" | "unavailable";
  readonly captured: number;
  readonly pending: number;
  readonly pendingBytes: number;
  readonly visible: number;
  readonly incomplete: number;
  readonly unknown: number;
  readonly queueLimit: number;
  readonly queueBytesLimit: number;
  /** Task pending plus admitted run reservations, within the shared limits. */
  readonly pendingTotal: number;
  readonly pendingTotalBytes: number;
  readonly lastReason: { readonly code: HistoryReasonCode; readonly detail: string } | null;
  readonly reasonCounts: Readonly<Record<HistoryReasonCode, number>>;
  readonly run: HistoryRunStatus;
}

export interface HistorySessionControls {
  /** Readonly host diagnostics; never requirement text. */
  status(): HistorySessionStatus;
  /** Main-agent lifecycle entry point. Safe to call without awaiting. */
  handleAgentEnd(
    event: unknown,
    context: OmpToolContext,
    runReferences?: readonly ExecutionRunReference[],
  ): Promise<void>;
  /** Invalidate pending publish eligibility on real session navigation. */
  navigate(event: "session_start" | "session_switch" | "session_branch" | "session_tree"): void;
  /** Unsubscribe and invalidate without any asynchronous flush. */
  dispose(): void;
}

export type HistorySessionReport = (
  type: "captured" | "visible" | "incomplete" | "unknown" | "unavailable" | "navigation" | "disposed" | "ignored"
    | "run_visible" | "run_incomplete" | "run_unknown",
  details: Readonly<Record<string, unknown>>,
) => void;

export interface HistorySessionOptions {
  owner: TaskOwner;
  /** Existing private instance root created by the daily composition. */
  instanceRoot: string;
  instanceId: string;
  workspaceRoot: string;
  /** Host public `pi.appendEntry`; absent means locators are unavailable. */
  appendEntry?: (customType: string, data?: unknown) => void;
  report?: HistorySessionReport;
  /** Test/embedding bound override; defaults to the frozen small wait. */
  ensureOnDiskTimeoutMs?: number;
}

interface PendingLocator {
  readonly item: HistoryItem;
  readonly generation: number;
  readonly bytes: number;
}

/** Retained only for an already-visible ACTIVE task-history row. */
interface ConfirmedTaskHistory {
  readonly item: HistoryItem;
  readonly generation: number;
}

interface SeenRunReference {
  readonly fingerprint: string;
  readonly state: "visible" | "incomplete" | "unknown";
}

interface ValidRunReference {
  readonly reference: ExecutionRunReference;
  readonly key: string;
  readonly fingerprint: string;
}

interface RunReservation {
  readonly fingerprint: string;
  readonly bytes: number;
}

interface SessionIdentity {
  readonly manager: OmpSessionManager;
  readonly sessionId: string;
  readonly file: string;
  readonly leafId: string;
}

type IdentityResult =
  | { readonly ok: true; readonly identity: SessionIdentity }
  | { readonly ok: false; readonly code: HistoryReasonCode; readonly detail: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedDetail(detail: string): string {
  const singleLine = detail.replace(/\s+/g, " ").trim();
  return singleLine.length <= 320 ? singleLine : `${singleLine.slice(0, 317)}...`;
}

function reasonCounts(): Record<HistoryReasonCode, number> {
  return Object.fromEntries(REASON_CODES.map((code) => [code, 0])) as Record<HistoryReasonCode, number>;
}

function freezeItem(item: HistoryItem): HistoryItem {
  return Object.freeze({
    ...item,
    anchor: Object.freeze({ ...item.anchor }),
    requirementSources: Object.freeze(
      item.requirementSources.map((source) => Object.freeze({ ...source })),
    ) as unknown as RequirementSource[],
    acceptance: item.acceptance === null ? null : Object.freeze({ ...item.acceptance }),
  });
}

function locatorData(
  instanceId: string,
  ownerId: string,
  item: HistoryItem,
): HistoryLocatorData {
  return {
    version: HISTORY_LOCATOR_VERSION,
    instanceId,
    ownerId,
    historyId: item.historyId,
    digest: item.digest,
    taskId: item.taskId,
    taskRevision: item.taskRevision,
    originSessionId: item.anchor.sessionId,
  };
}

function dataBytes(data: HistoryLocatorData | HistoryRunLocatorData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function runReasonCounts(): Record<HistoryRunReasonCode, number> {
  return Object.fromEntries(RUN_REASON_CODES.map((code) => [code, 0])) as Record<HistoryRunReasonCode, number>;
}

function taskHistoryKey(
  ownerId: string,
  taskId: string,
  taskRevision: number,
  requirementsDigest: string,
): string {
  return [ownerId, taskId, taskRevision, requirementsDigest].join("\u0000");
}

function runReferenceKey(reference: ExecutionRunReference): string {
  return [reference.ownerId, reference.taskId, reference.taskRevision, reference.runId, reference.callId]
    .join("\u0000");
}

function runReferenceFingerprint(reference: ExecutionRunReference): string {
  return JSON.stringify({
    ownerId: reference.ownerId,
    taskId: reference.taskId,
    taskRevision: reference.taskRevision,
    requirementsDigest: reference.requirementsDigest,
    runId: reference.runId,
    callId: reference.callId,
    runDirectory: reference.runDirectory,
    artifactIds: [...reference.artifactIds],
    recordWriteReturned: reference.recordWriteReturned,
    byteIntegrity: reference.byteIntegrity,
    authorityRestored: reference.authorityRestored,
  });
}

function boundedString(value: unknown, limit: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= limit
    && !value.includes("\u0000");
}

function validateRunReference(
  value: unknown,
  ownerId: string,
): { readonly ok: true; readonly reference: ExecutionRunReference } | { readonly ok: false; readonly detail: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, detail: "the run reference is not an object" };
  }
  const reference = value as ExecutionRunReference;
  if (!boundedString(reference.ownerId, 256) || reference.ownerId !== ownerId) {
    return { ok: false, detail: "the run reference owner does not match this composition" };
  }
  if (!boundedString(reference.taskId, 128)
    || !Number.isSafeInteger(reference.taskRevision)
    || reference.taskRevision < 1
    || !boundedString(reference.requirementsDigest, 256)
    || !BOUNDED_DIGEST.test(reference.requirementsDigest)
    || !boundedString(reference.runId, 128)
    || !SAFE_RUN_TOKEN.test(reference.runId)
    || !boundedString(reference.callId, 128)
    || !SAFE_RUN_TOKEN.test(reference.callId)
    || !boundedString(reference.runDirectory, 128)
    || !SAFE_RUN_TOKEN.test(reference.runDirectory)) {
    return { ok: false, detail: "the run reference has an invalid bounded identity" };
  }
  if (!Array.isArray(reference.artifactIds)
    || reference.artifactIds.length > HISTORY_RUN_ARTIFACT_LIMIT) {
    return { ok: false, detail: "the run reference artifact set exceeds its bound" };
  }
  const seen = new Set<string>();
  for (const artifactId of reference.artifactIds) {
    if (typeof artifactId !== "string"
      || !SAFE_RUN_TOKEN.test(artifactId)
      || seen.has(artifactId)) {
      return { ok: false, detail: "the run reference artifact set is invalid or duplicated" };
    }
    seen.add(artifactId);
  }
  if (reference.recordWriteReturned !== true
    || reference.byteIntegrity !== "not_checked"
    || reference.authorityRestored !== false) {
    return { ok: false, detail: "the run reference evidence qualifiers are invalid" };
  }
  return { ok: true, reference };
}

function runLocatorData(
  instanceId: string,
  ownerId: string,
  task: ConfirmedTaskHistory,
  reference: ExecutionRunReference,
): HistoryRunLocatorData {
  return {
    version: HISTORY_RUN_LOCATOR_VERSION,
    instanceId,
    ownerId,
    historyId: task.item.historyId,
    digest: task.item.digest,
    taskId: task.item.taskId,
    taskRevision: task.item.taskRevision,
    requirementsDigest: task.item.requirementsDigest,
    originSessionId: task.item.anchor.sessionId,
    runId: reference.runId,
    callId: reference.callId,
    runDirectory: reference.runDirectory,
    artifactIds: [...reference.artifactIds],
    recordWriteReturned: true,
    byteIntegrity: "not_checked",
    authorityRestored: false,
  };
}

function sameExpectedValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => actual[index] === value);
  }
  return actual === expected;
}

function sameExactData(value: unknown, expected: object, expectedKeys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const ordered = [...expectedKeys].sort();
  if (keys.length !== ordered.length) return false;
  for (let index = 0; index < ordered.length; index += 1) {
    if (keys[index] !== ordered[index]) return false;
  }
  const expectedRecord = expected as Record<string, unknown>;
  for (const key of expectedKeys) {
    if (!sameExpectedValue(record[key], expectedRecord[key])) return false;
  }
  return true;
}

function verifyAppend(
  beforeBranch: readonly unknown[],
  beforeLeaf: string,
  afterBranch: readonly unknown[],
  afterLeaf: string | null,
  customType: string,
  expected: object,
  expectedKeys: readonly string[],
): string | null {
  if (!Array.isArray(afterBranch)) return "the session branch is not an array after append";
  if (afterBranch.length !== beforeBranch.length + 1) {
    return `the branch grew from ${beforeBranch.length} to ${afterBranch.length} entries`;
  }
  if (afterBranch.length > HISTORY_SESSION_BRANCH_ENTRY_LIMIT) {
    return `the branch exceeds the ${HISTORY_SESSION_BRANCH_ENTRY_LIMIT}-entry traversal budget`;
  }
  const beforeIds = new Set<string>();
  for (let index = 0; index < beforeBranch.length; index += 1) {
    const before = beforeBranch[index];
    const after = afterBranch[index];
    if (typeof before !== "object" || before === null || Array.isArray(before)
      || typeof after !== "object" || after === null || Array.isArray(after)) {
      return "the branch prefix is not an object";
    }
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    if (left.id !== right.id || left.parentId !== right.parentId) {
      return "the existing branch prefix changed";
    }
    if (typeof left.id !== "string") return "the existing branch prefix id is not text";
    beforeIds.add(left.id);
  }
  let entries;
  try {
    entries = parseBranch(afterBranch);
  } catch (error) {
    return `the resulting branch is malformed: ${errorMessage(error)}`;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const expectedParent = index === 0 ? null : entries[index - 1]!.id;
    if (entries[index]!.parentId !== expectedParent) {
      return "the resulting branch does not form one continuous parent chain";
    }
  }
  const appended = entries[entries.length - 1]!;
  if (beforeIds.has(appended.id)) return "the appended entry reuses an existing entry id";
  if (appended.parentId !== beforeLeaf) return "the appended entry parent is not the previous leaf";
  if (appended.type !== "custom") return "the appended entry is not type custom";
  if (appended.value.customType !== customType) {
    return "the appended custom entry has the wrong customType";
  }
  if (!sameExactData(appended.value.data, expected, expectedKeys)) {
    return "the appended custom entry data is not the exact allowlisted payload";
  }
  if (afterLeaf !== appended.id) return "the selected leaf is not the appended entry";
  return null;
}

type TaskLocatorPath =
  | { readonly ok: true; readonly index: number }
  | {
    readonly ok: false;
    readonly reason: "task_history_unconfirmed" | "source_mismatch";
    readonly detail: string;
  };

/**
 * The retained visible flag is not current path visibility. Require exactly
 * one exact task locator for this row, with no changed duplicate claiming the
 * same history id, and validate the complete source ledger in its prefix.
 */
function taskLocatorPath(
  item: HistoryItem,
  branch: readonly unknown[],
  sessionId: string,
  instanceId: string,
  ownerId: string,
): TaskLocatorPath {
  let entries;
  try {
    entries = parseBranch(branch);
  } catch (error) {
    return {
      ok: false,
      reason: "task_history_unconfirmed",
      detail: `the actual branch is not a valid path: ${errorMessage(error)}`,
    };
  }
  const expected = locatorData(instanceId, ownerId, item);
  const exact: number[] = [];
  const claiming: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.value.customType !== HISTORY_LOCATOR_CUSTOM_TYPE) continue;
    const data = entry.value.data;
    const historyId = typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).historyId
      : undefined;
    if (historyId === item.historyId) claiming.push(index);
    if (sameExactData(data, expected, LOCATOR_KEYS)) exact.push(index);
  }
  if (exact.length === 0 && claiming.length === 0) {
    return {
      ok: false,
      reason: "task_history_unconfirmed",
      detail: "the exact task-history locator is absent from the actual branch",
    };
  }
  if (exact.length !== 1) {
    return {
      ok: false,
      reason: "task_history_unconfirmed",
      detail: "the actual branch must contain exactly one exact task-history locator for this row",
    };
  }
  if (claiming.length !== exact.length) {
    return {
      ok: false,
      reason: "task_history_unconfirmed",
      detail: "a task-history locator for this row has changed payload",
    };
  }
  const index = exact[0]!;
  const mismatch = sourceMismatch(item, branch.slice(0, index), sessionId);
  if (mismatch !== null) {
    return {
      ok: false,
      reason: "source_mismatch",
      detail: `the task locator prefix does not prove the complete ledger: ${mismatch}`,
    };
  }
  return { ok: true, index };
}

function sourceMismatch(
  item: HistoryItem,
  branch: readonly unknown[],
  sessionId: string,
): string | null {
  if (!Array.isArray(branch)) return "the session branch is not an array";
  if (branch.length > HISTORY_SESSION_BRANCH_ENTRY_LIMIT) {
    return `the branch exceeds the ${HISTORY_SESSION_BRANCH_ENTRY_LIMIT}-entry traversal budget`;
  }
  let entries;
  try {
    entries = parseBranch(branch);
  } catch (error) {
    return `the branch could not be parsed: ${errorMessage(error)}`;
  }
  if (item.anchor.sessionId !== sessionId) {
    return "the task creation session differs from the actual session";
  }
  const sources = item.requirementSources;
  if (sources.length < 1 || sources.length !== item.taskRevision) {
    return "the requirement ledger is incomplete";
  }
  const original = sources[0]!;
  if (original.kind !== "original"
    || original.revision !== 1
    || original.previousRevision !== null
    || original.messageId !== item.anchor.messageId
    || original.sessionId !== item.anchor.sessionId
    || original.source !== item.anchor.source) {
    return "the original requirement source contradicts the task creation anchor";
  }
  const byId = new Map(entries.map((entry, index) => [entry.id, { entry, index }]));
  let previousIndex = -1;
  const seen = new Set<string>();
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    if (index > 0 && (source.kind !== "amendment"
      || source.revision !== index + 1
      || source.previousRevision !== index)) {
      return "the amendment source chain is incomplete or out of order";
    }
    if (source.sessionId !== sessionId) {
      return `requirement source ${index + 1} belongs to another session`;
    }
    if (seen.has(source.messageId)) {
      return `requirement source ${index + 1} repeats a message id`;
    }
    seen.add(source.messageId);
    const found = byId.get(source.messageId);
    if (found === undefined) {
      return `requirement ${source.kind} source ${index + 1} is absent from the actual branch`;
    }
    if (found.index <= previousIndex) {
      return "the requirement sources are out of branch order";
    }
    previousIndex = found.index;
    const text = genuineUserText(found.entry);
    if (text === undefined) {
      return `requirement source ${index + 1} is not a genuine user entry`;
    }
    if (text.trim() !== source.text.trim()) {
      return `requirement source ${index + 1} text differs from the actual branch`;
    }
  }
  return null;
}

class EnsureOnDiskTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EnsureOnDiskTimeoutError(`ensureOnDisk did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class HistorySession implements HistorySessionControls {
  private readonly owner: TaskOwner;
  private readonly instanceId: string;
  private readonly workspaceRoot: string;
  private readonly appendEntry: ((customType: string, data?: unknown) => void) | undefined;
  private readonly report: HistorySessionReport | undefined;
  private readonly ensureOnDiskTimeoutMs: number;
  private readonly writer: HistoryProjectionWriter | undefined;
  private readonly unsubscribe: (() => void) | undefined;
  private readonly pending = new Map<string, PendingLocator>();
  private readonly known = new Set<string>();
  /** Visible ACTIVE rows retained by exact original identity and generation. */
  private readonly confirmed = new Map<string, ConfirmedTaskHistory>();
  /** Bounded consumed/refused/unknown adapter keys; never retried. */
  private readonly seenRuns = new Map<string, SeenRunReference>();
  /** Admitted run keys holding shared count/byte capacity before append. */
  private readonly runReservations = new Map<string, RunReservation>();
  private readonly counts = reasonCounts();
  private readonly runCounts = runReasonCounts();
  private pendingBytes = 0;
  private runReservationBytes = 0;
  private runKeyLimitLatched = false;
  private generation = 0;
  private captured = 0;
  private visible = 0;
  private incomplete = 0;
  private unknown = 0;
  private runVisible = 0;
  private runIncomplete = 0;
  private runUnknown = 0;
  private runConflicts = 0;
  private disposed = false;
  private captureState: "ready" | "unavailable";
  private locatorState: "ready" | "unavailable";
  private lastReason: { code: HistoryReasonCode; detail: string } | null = null;
  private runLastReason: { code: HistoryRunReasonCode; detail: string } | null = null;

  constructor(options: HistorySessionOptions) {
    this.owner = options.owner;
    this.instanceId = options.instanceId;
    this.workspaceRoot = options.workspaceRoot;
    this.appendEntry = options.appendEntry;
    this.report = options.report;
    this.ensureOnDiskTimeoutMs = options.ensureOnDiskTimeoutMs === undefined
      || !Number.isSafeInteger(options.ensureOnDiskTimeoutMs)
      || options.ensureOnDiskTimeoutMs < 1
      ? HISTORY_ENSURE_ON_DISK_TIMEOUT_MS
      : Math.min(options.ensureOnDiskTimeoutMs, 30_000);
    this.locatorState = options.appendEntry === undefined ? "unavailable" : "ready";
    if (options.appendEntry === undefined) {
      this.note("unavailable", "the host does not expose appendEntry; locators remain unavailable");
    }

    if (!SAFE_INSTANCE_COMPONENT.test(options.instanceId)) {
      this.writer = undefined;
      this.captureState = "unavailable";
      this.note("unavailable", "instanceId is not a safe single path component");
    } else {
      try {
        this.writer = createHistoryProjectionWriter({
          instanceRoot: options.instanceRoot,
          instanceId: options.instanceId,
          ownerId: options.owner.ownerId,
          workspaceRoot: options.workspaceRoot,
        });
        this.captureState = "ready";
      } catch (error) {
        this.writer = undefined;
        this.captureState = "unavailable";
        this.note("unavailable", `history projection is unavailable: ${errorMessage(error)}`);
      }
    }

    if (this.writer === undefined) {
      this.unsubscribe = undefined;
      return;
    }
    try {
      this.unsubscribe = options.owner.subscribe((event) => this.onOwnerEvent(event));
    } catch (error) {
      this.captureState = "unavailable";
      this.note("unavailable", `history subscription failed: ${errorMessage(error)}`);
    }
  }

  status(): HistorySessionStatus {
    return Object.freeze({
      capture: this.captureState,
      locator: this.locatorState,
      captured: this.captured,
      pending: this.pending.size,
      pendingBytes: this.pendingBytes,
      visible: this.visible,
      incomplete: this.incomplete,
      unknown: this.unknown,
      queueLimit: HISTORY_SESSION_QUEUE_LIMIT,
      queueBytesLimit: HISTORY_SESSION_QUEUE_BYTES_LIMIT,
      pendingTotal: this.pending.size + this.runReservations.size,
      pendingTotalBytes: this.pendingBytes + this.runReservationBytes,
      lastReason: this.lastReason === null ? null : Object.freeze({ ...this.lastReason }),
      reasonCounts: Object.freeze({ ...this.counts }),
      run: Object.freeze({
        observed: this.seenRuns.size,
        visible: this.runVisible,
        incomplete: this.runIncomplete,
        unknown: this.runUnknown,
        conflicts: this.runConflicts,
        reserved: this.runReservations.size,
        reservedBytes: this.runReservationBytes,
        retainedKeys: this.seenRuns.size,
        keyLimit: HISTORY_RUN_KEY_LIMIT,
        keyLimitLatched: this.runKeyLimitLatched,
        lastReason: this.runLastReason === null ? null : Object.freeze({ ...this.runLastReason }),
        reasonCounts: Object.freeze({ ...this.runCounts }),
      }),
    });
  }

  private note(code: HistoryReasonCode, detail: string): void {
    this.counts[code] += 1;
    this.lastReason = { code, detail: boundedDetail(detail) };
  }

  private noteRun(code: HistoryRunReasonCode, detail: string): void {
    this.runCounts[code] += 1;
    this.runLastReason = { code, detail: boundedDetail(detail) };
  }

  private emit(
    type: "captured" | "visible" | "incomplete" | "unknown" | "unavailable" | "navigation" | "disposed" | "ignored"
      | "run_visible" | "run_incomplete" | "run_unknown",
    details: Record<string, unknown>,
  ): void {
    if (this.report === undefined) return;
    try {
      this.report(type, Object.freeze({ ...details }));
    } catch {
      // Diagnostics never affect capture, owner state or the host lifecycle.
    }
  }

  private onOwnerEvent(event: TaskOwnerEvent): void {
    if (this.disposed || this.writer === undefined || this.captureState !== "ready") return;
    const expectedStatus = CAPTURE_EVENT_STATUS[event.type];
    if (expectedStatus === undefined) return;
    try {
      // No await belongs before this snapshot read: the frozen event carries
      // identity but no snapshot or host context.
      const snapshot = this.owner.snapshot();
      const task = snapshot.currentTask;
      if (task === null) {
        this.incompleteEvent("event_snapshot_mismatch", "the committed event has no current task");
        return;
      }
      if (event.ownerId !== this.owner.ownerId
        || event.taskId !== task.taskId
        || event.taskRevision !== task.taskRevision) {
        this.incompleteEvent(
          "event_snapshot_mismatch",
          "the committed event identity does not match the synchronous current task snapshot",
        );
        return;
      }
      if (task.status !== expectedStatus) {
        this.incompleteEvent(
          "event_snapshot_mismatch",
          `the current task status ${task.status} does not match the event expectation ${expectedStatus}`,
        );
        return;
      }
      if (event.type === "task_accepted") {
        const acceptance = task.acceptance;
        if (acceptance === null
          || event.acceptanceId !== acceptance.acceptanceId
          || event.deliveryId !== acceptance.deliveryId
          || event.recordDigest !== acceptance.recordDigest
          || event.acceptedAt !== acceptance.acceptedAt) {
          this.incompleteEvent(
            "event_snapshot_mismatch",
            "the committed acceptance event fields do not match the accepted task reference",
          );
          return;
        }
      }
      const result = this.writer.capture(task);
      if (this.known.has(result.item.historyId)) return;
      this.known.add(result.item.historyId);
      this.captured += 1;
      const item = freezeItem(result.item);
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
      } catch (error) {
        this.incompleteItem("capture_failed", `the immutable item could not be sized: ${errorMessage(error)}`);
        return;
      }
      if (bytes > HISTORY_ITEM_BYTES_LIMIT) {
        this.incompleteItem("limit", "the projected item exceeds its byte bound");
        return;
      }
      if (this.pending.size + this.runReservations.size >= HISTORY_SESSION_QUEUE_LIMIT
        || this.pendingBytes + this.runReservationBytes + bytes > HISTORY_SESSION_QUEUE_BYTES_LIMIT) {
        this.incompleteItem(
          "limit",
          `the shared pending queue is full (${this.pending.size + this.runReservations.size} items, ${this.pendingBytes + this.runReservationBytes} bytes); no entry was evicted`,
        );
        return;
      }
      this.pending.set(item.historyId, {
        item,
        generation: this.generation,
        bytes,
      });
      this.pendingBytes += bytes;
      this.emit("captured", {
        historyId: item.historyId,
        taskId: item.taskId,
        taskRevision: item.taskRevision,
        recordedStatus: item.recordedStatus,
        projectionStatus: result.status,
        pending: this.pending.size,
      });
    } catch (error) {
      if (error instanceof HistoryProjectionError && error.code === "unknown") {
        this.captureUnknown(errorMessage(error));
        return;
      }
      // A prepublication projection failure never changes the already
      // committed owner state.
      this.incompleteEvent("capture_failed", `history capture failed: ${errorMessage(error)}`);
    }
  }

  /**
   * A projection `unknown` error means publication may have happened but its
   * read-back was not confirmed. It is neither a confirmed capture nor an
   * unchanged instance, so it increments `unknown`, not `captured` or
   * `incomplete`, and no historyId is invented for it. The writer is disabled
   * for future captures because it would otherwise have to guess at the
   * retained index state.
   */
  private captureUnknown(detail: string): void {
    this.captureState = "unavailable";
    this.unknown += 1;
    const text = `the history projection may have been applied, but its read-back was not confirmed: ${detail}; future history captures are disabled`;
    this.note("capture_unknown", text);
    this.emit("unknown", {
      code: "capture_unknown",
      detail: boundedDetail(text),
      unknown: this.unknown,
      possiblyApplied: true,
      capture: this.captureState,
    });
  }

  private incompleteEvent(code: HistoryReasonCode, detail: string): void {
    this.incomplete += 1;
    this.note(code, detail);
    this.emit("incomplete", { code, detail: boundedDetail(detail), incomplete: this.incomplete });
  }

  private incompleteItem(code: HistoryReasonCode, detail: string, entry?: PendingLocator): void {
    if (entry !== undefined) this.removePending(entry.item.historyId);
    this.incomplete += 1;
    this.note(code, detail);
    this.emit("incomplete", {
      code,
      detail: boundedDetail(detail),
      incomplete: this.incomplete,
      ...(entry === undefined ? {} : { historyId: entry.item.historyId }),
    });
  }

  private unknownItem(entry: PendingLocator, detail: string): void {
    this.removePending(entry.item.historyId);
    this.unknown += 1;
    this.note("append_ambiguous", detail);
    this.emit("unknown", {
      code: "append_ambiguous",
      detail: boundedDetail(detail),
      unknown: this.unknown,
      historyId: entry.item.historyId,
    });
  }

  private removePending(historyId: string): PendingLocator | undefined {
    const entry = this.pending.get(historyId);
    if (entry === undefined) return undefined;
    this.pending.delete(historyId);
    this.pendingBytes -= entry.bytes;
    return entry;
  }

  private invalidatePending(code: "navigation" | "dispose", detail: string): number {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.removePending(entry.item.historyId);
      this.incomplete += 1;
      this.note(code, detail);
      this.emit("incomplete", {
        code,
        detail: boundedDetail(detail),
        incomplete: this.incomplete,
        historyId: entry.item.historyId,
      });
    }
    return entries.length;
  }

  /** Invalidate only the frozen attempt batch; concurrent captures stay pending. */
  private invalidateBatch(
    batch: readonly PendingLocator[],
    code: HistoryReasonCode,
    detail: string,
  ): void {
    for (const entry of batch) {
      if (!this.pending.has(entry.item.historyId)) continue;
      this.incompleteItem(code, detail, entry);
    }
  }

  private releaseRunReservation(entry: ValidRunReference): void {
    const reservation = this.runReservations.get(entry.key);
    if (reservation === undefined) return;
    this.runReservations.delete(entry.key);
    this.runReservationBytes -= reservation.bytes;
  }

  private releaseRunReservations(entries: readonly ValidRunReference[]): void {
    for (const entry of entries) this.releaseRunReservation(entry);
  }

  private latchRunKeys(detail: string): void {
    if (this.runKeyLimitLatched) return;
    this.runKeyLimitLatched = true;
    this.noteRun("limit", detail);
  }

  /**
   * Admitted keys are retained before any append. Once the bounded key set is
   * full, a latch refuses every unseen reference instead of forgetting it and
   * accepting it again on a later call.
   */
  private markRun(
    entry: ValidRunReference,
    state: SeenRunReference["state"],
  ): boolean {
    const existing = this.seenRuns.get(entry.key);
    if (existing !== undefined) {
      if (existing.fingerprint !== entry.fingerprint) {
        this.runConflicts += 1;
        this.noteRun("conflict", "the same run key was offered with different identity or artifacts");
      }
      return false;
    }
    const reserved = this.runReservations.has(entry.key);
    if (!reserved) {
      if (this.runKeyLimitLatched) return false;
      if (this.seenRuns.size + this.runReservations.size >= HISTORY_RUN_KEY_LIMIT) {
        this.latchRunKeys("the retained run-key bound is full; all unseen references are refused");
        return false;
      }
    }
    this.releaseRunReservation(entry);
    this.seenRuns.set(entry.key, Object.freeze({ fingerprint: entry.fingerprint, state }));
    return true;
  }

  private refuseRun(
    entry: ValidRunReference,
    code: HistoryRunReasonCode,
    detail: string,
  ): void {
    const known = this.seenRuns.has(entry.key);
    if (!this.markRun(entry, "incomplete")) {
      if (known) return;
      // Unretainable keys are latched state, not a rejected-id collection.
      this.runIncomplete += 1;
      this.noteRun(code, detail);
      this.emit("run_incomplete", {
        code,
        detail: boundedDetail(detail),
        runId: entry.reference.runId,
        callId: entry.reference.callId,
        taskId: entry.reference.taskId,
        taskRevision: entry.reference.taskRevision,
        runIncomplete: this.runIncomplete,
      });
      return;
    }
    this.runIncomplete += 1;
    this.noteRun(code, detail);
    this.emit("run_incomplete", {
      code,
      detail: boundedDetail(detail),
      runId: entry.reference.runId,
      callId: entry.reference.callId,
      taskId: entry.reference.taskId,
      taskRevision: entry.reference.taskRevision,
      runIncomplete: this.runIncomplete,
    });
  }

  private reserveRunImports(imports: readonly ValidRunReference[]): ValidRunReference[] {
    const reserved: ValidRunReference[] = [];
    for (const entry of imports) {
      if (this.seenRuns.has(entry.key) || this.runReservations.has(entry.key)) continue;
      if (this.runKeyLimitLatched) {
        this.refuseRun(entry, "limit", "run-key capacity was exhausted; unseen references stay refused");
        continue;
      }
      if (this.seenRuns.size + this.runReservations.size >= HISTORY_RUN_KEY_LIMIT) {
        this.latchRunKeys("the retained run-key bound is full; all unseen references are refused");
        this.refuseRun(entry, "limit", "the retained run-key bound is full; no key was evicted");
        continue;
      }
      if (this.pending.size + this.runReservations.size >= HISTORY_SESSION_QUEUE_LIMIT) {
        this.refuseRun(entry, "limit", "the shared pending count is full; no entry was evicted");
        continue;
      }
      const bytes = HISTORY_RUN_LOCATOR_DATA_BYTES_LIMIT;
      if (this.pendingBytes + this.runReservationBytes + bytes > HISTORY_SESSION_QUEUE_BYTES_LIMIT) {
        this.refuseRun(entry, "limit", "the shared pending byte bound is full; no entry was evicted");
        continue;
      }
      this.runReservations.set(entry.key, Object.freeze({ fingerprint: entry.fingerprint, bytes }));
      this.runReservationBytes += bytes;
      reserved.push(entry);
    }
    return reserved;
  }

  private refuseRunImports(
    imports: readonly ValidRunReference[],
    code: HistoryRunReasonCode,
    detail: string,
  ): void {
    for (const entry of imports) this.refuseRun(entry, code, detail);
  }

  private unknownRun(entry: ValidRunReference, detail: string): void {
    if (!this.markRun(entry, "unknown")) return;
    this.runUnknown += 1;
    this.noteRun("append_ambiguous", detail);
    this.emit("run_unknown", {
      code: "append_ambiguous",
      detail: boundedDetail(detail),
      runId: entry.reference.runId,
      callId: entry.reference.callId,
      taskId: entry.reference.taskId,
      taskRevision: entry.reference.taskRevision,
      runUnknown: this.runUnknown,
      possiblyApplied: true,
    });
  }

  private noteRunConflict(entry: ValidRunReference): void {
    this.runConflicts += 1;
    this.noteRun("conflict", `the same run key was offered with different identity or artifacts: ${entry.reference.runId}`);
  }

  private prepareRunImports(runReferences: readonly ExecutionRunReference[]): ValidRunReference[] {
    const imports: ValidRunReference[] = [];
    const local = new Map<string, string>();
    for (const raw of runReferences) {
      const validated = validateRunReference(raw, this.owner.ownerId);
      if (!validated.ok) {
        this.runIncomplete += 1;
        this.noteRun("invalid", validated.detail);
        this.emit("run_incomplete", {
          code: "invalid",
          detail: boundedDetail(validated.detail),
          runIncomplete: this.runIncomplete,
        });
        continue;
      }
      const reference = validated.reference;
      const key = runReferenceKey(reference);
      const fingerprint = runReferenceFingerprint(reference);
      const existing = this.seenRuns.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          this.noteRunConflict({ reference, key, fingerprint });
        }
        continue;
      }
      const reserved = this.runReservations.get(key);
      if (reserved !== undefined) {
        if (reserved.fingerprint !== fingerprint) {
          this.noteRunConflict({ reference, key, fingerprint });
        }
        continue;
      }
      const localFingerprint = local.get(key);
      if (localFingerprint !== undefined) {
        if (localFingerprint !== fingerprint) {
          this.noteRunConflict({ reference, key, fingerprint });
        }
        continue;
      }
      local.set(key, fingerprint);
      imports.push({ reference, key, fingerprint });
    }
    return imports;
  }

  private matchConfirmedRun(reference: ExecutionRunReference): ConfirmedTaskHistory | undefined {
    const key = taskHistoryKey(
      this.owner.ownerId,
      reference.taskId,
      reference.taskRevision,
      reference.requirementsDigest,
    );
    return this.confirmed.get(key);
  }

  private hasPendingTask(reference: ExecutionRunReference): boolean {
    for (const entry of this.pending.values()) {
      if (entry.item.taskId === reference.taskId
        && entry.item.taskRevision === reference.taskRevision
        && entry.item.requirementsDigest === reference.requirementsDigest) {
        return true;
      }
    }
    return false;
  }

  private rememberConfirmedTask(entry: PendingLocator): void {
    if (entry.item.recordedStatus !== "active") return;
    const key = taskHistoryKey(
      this.owner.ownerId,
      entry.item.taskId,
      entry.item.taskRevision,
      entry.item.requirementsDigest,
    );
    if (this.confirmed.has(key)) return;
    if (this.confirmed.size >= HISTORY_SESSION_QUEUE_LIMIT) {
      this.noteRun("limit", "the retained confirmed task-history association bound is full");
      return;
    }
    this.confirmed.set(key, Object.freeze({ item: entry.item, generation: entry.generation }));
  }

  private readIdentity(context: OmpToolContext): IdentityResult {
    const manager = context.sessionManager;
    if (manager === undefined) {
      return { ok: false, code: "unavailable", detail: "the session manager is unavailable" };
    }
    if (typeof manager.getSessionId !== "function"
      || typeof manager.getLeafId !== "function"
      || typeof manager.getBranch !== "function"
      || typeof manager.getSessionFile !== "function"
      || typeof manager.ensureOnDisk !== "function") {
      return {
        ok: false,
        code: "unavailable",
        detail: "the session manager lacks the required session-file or persistence API",
      };
    }
    try {
      const sessionId = manager.getSessionId();
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return { ok: false, code: "unavailable", detail: "the session id is not available" };
      }
      const file = manager.getSessionFile();
      if (typeof file !== "string" || file.length === 0) {
        return { ok: false, code: "unavailable", detail: "the session is not persistent on disk" };
      }
      const leafId = manager.getLeafId();
      if (typeof leafId !== "string" || leafId.length === 0) {
        return { ok: false, code: "unavailable", detail: "the selected session leaf is not available" };
      }
      return { ok: true, identity: { manager, sessionId, file, leafId } };
    } catch (error) {
      return {
        ok: false,
        code: "unavailable",
        detail: `the session metadata could not be read: ${errorMessage(error)}`,
      };
    }
  }

  private sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
    return this.sameSession(left, right) && left.leafId === right.leafId;
  }

  private sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
    return left.manager === right.manager
      && left.sessionId === right.sessionId
      && left.file === right.file;
  }

  async handleAgentEnd(
    _event: unknown,
    context: OmpToolContext,
    runReferences: readonly ExecutionRunReference[] = [],
  ): Promise<void> {
    if (this.disposed) return;
    // Ordinary chat and fresh resumed sessions have nothing pending. Do not
    // touch ensureOnDisk or appendEntry in that case.
    if (this.pending.size === 0 && runReferences.length === 0) return;
    if (context.agent?.kind !== "main") return;
    if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
      this.note("identity_changed", "the agent_end workspace differs from the daily workspace");
      this.emit("ignored", { reason: "workspace_mismatch" });
      return;
    }
    let imports = this.prepareRunImports(runReferences);
    let importsReserved = false;
    if (this.pending.size === 0) {
      if (imports.length === 0 || this.appendEntry === undefined) return;
      const matchable: ValidRunReference[] = [];
      const missing: ValidRunReference[] = [];
      for (const entry of imports) {
        if (this.matchConfirmedRun(entry.reference) === undefined) missing.push(entry);
        else matchable.push(entry);
      }
      // Reserve eligible keys before refusing missing ones so historical
      // capacity cannot be consumed by references that can never publish.
      imports = this.reserveRunImports(matchable);
      importsReserved = true;
      this.refuseRunImports(
        missing,
        "task_history_missing",
        "no confirmed active task-history row matches this run reference",
      );
      if (imports.length === 0) return;
    } else if (this.appendEntry === undefined) {
      return;
    }

    const observed = this.readIdentity(context);
    if (!observed.ok) {
      if (importsReserved) this.releaseRunReservations(imports);
      this.locatorState = "unavailable";
      this.note(observed.code, observed.detail);
      this.emit("unavailable", { code: observed.code, detail: boundedDetail(observed.detail) });
      return;
    }
    this.locatorState = "ready";
    const identity = observed.identity;

    // Freeze the eligible batch before any await. A reentrant or concurrent
    // commit after this point belongs to a later real lifecycle boundary.
    const attemptGeneration = this.generation;
    const batch: PendingLocator[] = [];
    for (const entry of [...this.pending.values()]) {
      if (this.disposed) {
        if (importsReserved) this.releaseRunReservations(imports);
        return;
      }
      if (entry.generation !== attemptGeneration) {
        this.incompleteItem("navigation", "the locator generation changed before publication", entry);
        continue;
      }
      if (entry.item.anchor.sessionId !== identity.sessionId) {
        this.incompleteItem(
          "identity_changed",
          "the captured task belongs to a different session; it is never attached to this one",
          entry,
        );
        continue;
      }
      batch.push(entry);
    }
    if (!importsReserved) {
      imports = this.reserveRunImports(imports);
      importsReserved = true;
    }
    if (batch.length === 0 && imports.length === 0) return;

    try {
      await withTimeout(Promise.resolve(identity.manager.ensureOnDisk!()), this.ensureOnDiskTimeoutMs);
    } catch (error) {
      // The frozen attempt is invalid, including on timeout. Only this batch
      // is removed; captures committed concurrently are left for a later real
      // lifecycle boundary. A late resolution cannot reach an append below.
      const code: HistoryReasonCode = error instanceof EnsureOnDiskTimeoutError
        ? "timeout"
        : "unavailable";
      const runCode: HistoryRunReasonCode = error instanceof EnsureOnDiskTimeoutError
        ? "timeout"
        : "unavailable";
      if (code === "unavailable") this.locatorState = "unavailable";
      this.invalidateBatch(
        batch,
        code,
        `the ensureOnDisk wait failed: ${errorMessage(error)}`,
      );
      this.refuseRunImports(imports, runCode, `the ensureOnDisk wait failed: ${errorMessage(error)}`);
      return;
    }
    if (this.disposed || this.generation !== attemptGeneration) {
      this.refuseRunImports(
        imports,
        this.disposed ? "unavailable" : "generation_changed",
        this.disposed
          ? "the history session was disposed before run publication"
          : "the locator generation changed before run publication",
      );
      return;
    }

    const reread = this.readIdentity(context);
    if (!reread.ok) {
      this.locatorState = "unavailable";
      this.note(reread.code, reread.detail);
      this.emit("unavailable", { code: reread.code, detail: boundedDetail(reread.detail) });
      this.refuseRunImports(imports, "unavailable", reread.detail);
      return;
    }
    if (!this.sameIdentity(identity, reread.identity)) {
      this.invalidateBatch(
        batch,
        "identity_changed",
        "the session, file or selected leaf changed while ensureOnDisk was pending",
      );
      this.refuseRunImports(
        imports,
        "session_changed",
        "the session, file or selected leaf changed while ensureOnDisk was pending",
      );
      return;
    }
    if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
      this.invalidateBatch(batch, "identity_changed", "the agent_end workspace changed while ensureOnDisk was pending");
      this.refuseRunImports(imports, "session_changed", "the agent_end workspace changed while ensureOnDisk was pending");
      return;
    }

    for (const entry of batch) {
      if (this.disposed || this.generation !== attemptGeneration) {
        this.refuseRunImports(
          imports,
          this.disposed ? "unavailable" : "generation_changed",
          this.disposed
            ? "the history session was disposed before run publication"
            : "the locator generation changed before run publication",
        );
        return;
      }
      if (!this.pending.has(entry.item.historyId)) continue;
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.invalidateBatch(batch, "identity_changed", "the agent_end workspace changed before append");
        this.refuseRunImports(imports, "session_changed", "the agent_end workspace changed before append");
        return;
      }
      const pre = this.readIdentity(context);
      if (!pre.ok) {
        this.locatorState = "unavailable";
        this.invalidateBatch(batch, pre.code, pre.detail);
        this.refuseRunImports(imports, "unavailable", pre.detail);
        return;
      }
      if (!this.sameSession(reread.identity, pre.identity)) {
        this.invalidateBatch(
          batch,
          "identity_changed",
          "the session or session file changed before append",
        );
        this.refuseRunImports(imports, "session_changed", "the session or session file changed before append");
        return;
      }

      // The actual pre-append path must prove the complete source ledger.
      let beforeBranch: readonly unknown[];
      let beforeLeaf: string | null;
      try {
        beforeBranch = pre.identity.manager.getBranch();
        beforeLeaf = pre.identity.manager.getLeafId();
      } catch (error) {
        this.locatorState = "unavailable";
        this.invalidateBatch(
          batch,
          "unavailable",
          `the actual pre-append branch could not be read: ${errorMessage(error)}`,
        );
        this.refuseRunImports(
          imports,
          "unavailable",
          `the actual pre-append branch could not be read: ${errorMessage(error)}`,
        );
        return;
      }
      if (!Array.isArray(beforeBranch)
        || typeof beforeLeaf !== "string"
        || beforeLeaf.length === 0
        || beforeBranch.length === 0
        || (beforeBranch[beforeBranch.length - 1] as { id?: unknown } | undefined)?.id !== beforeLeaf) {
        this.invalidateBatch(
          batch,
          "identity_changed",
          "the selected leaf is not the actual pre-append branch end",
        );
        this.refuseRunImports(imports, "session_changed", "the selected leaf is not the actual pre-append branch end");
        return;
      }
      const mismatch = sourceMismatch(entry.item, beforeBranch, pre.identity.sessionId);
      if (mismatch !== null) {
        this.incompleteItem("source_mismatch", mismatch, entry);
        continue;
      }

      const data = locatorData(this.instanceId, this.owner.ownerId, entry.item);
      let bytes: number;
      try {
        bytes = dataBytes(data);
      } catch (error) {
        this.incompleteItem("limit", `the locator payload could not be sized: ${errorMessage(error)}`, entry);
        continue;
      }
      if (bytes > HISTORY_LOCATOR_DATA_BYTES_LIMIT) {
        this.incompleteItem("limit", "the locator payload exceeds its byte bound", entry);
        continue;
      }

      try {
        this.appendEntry!(HISTORY_LOCATOR_CUSTOM_TYPE, data);
      } catch (error) {
        this.unknownItem(entry, `appendEntry threw; the outcome is possibly applied: ${errorMessage(error)}`);
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator append outcome is unknown; no orphan run locator is emitted",
        );
        return;
      }

      // A synchronous navigation, disposal or session switch during append
      // makes the outcome possibly applied but never visible-confirmed.
      if (this.disposed || this.generation !== attemptGeneration) {
        this.unknownItem(entry, "appendEntry returned after navigation or disposal; the outcome is possibly applied");
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator append outcome is unknown; no orphan run locator is emitted",
        );
        return;
      }
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.unknownItem(entry, "appendEntry returned after the workspace changed; the outcome is possibly applied");
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator append outcome is unknown; no orphan run locator is emitted",
        );
        return;
      }
      const post = this.readIdentity(context);
      if (!post.ok) {
        this.unknownItem(entry, `the post-append session identity is unavailable: ${post.detail}`);
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator visibility was not confirmed; no orphan run locator is emitted",
        );
        return;
      }
      if (!this.sameSession(pre.identity, post.identity)) {
        this.unknownItem(entry, "appendEntry returned after the session or session file changed; the outcome is possibly applied");
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator visibility was not confirmed; no orphan run locator is emitted",
        );
        return;
      }

      let afterBranch: readonly unknown[];
      let afterLeaf: string | null;
      try {
        afterBranch = post.identity.manager.getBranch();
        afterLeaf = post.identity.manager.getLeafId();
      } catch (error) {
        this.unknownItem(entry, `the appended branch could not be re-read: ${errorMessage(error)}`);
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator visibility was not confirmed; no orphan run locator is emitted",
        );
        return;
      }
      const failure = verifyAppend(
        beforeBranch,
        beforeLeaf,
        afterBranch,
        afterLeaf,
        HISTORY_LOCATOR_CUSTOM_TYPE,
        data,
        LOCATOR_KEYS,
      );
      if (failure !== null) {
        this.unknownItem(entry, `appendEntry returned without one exact visible custom entry: ${failure}`);
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator visibility was not confirmed; no orphan run locator is emitted",
        );
        return;
      }
      const postMismatch = sourceMismatch(entry.item, afterBranch, post.identity.sessionId);
      if (postMismatch !== null) {
        this.unknownItem(
          entry,
          `the post-append branch no longer proves the complete ledger: ${postMismatch}`,
        );
        this.refuseRunImports(
          imports,
          "task_history_unconfirmed",
          "the task locator visibility was not confirmed; no orphan run locator is emitted",
        );
        return;
      }

      this.removePending(entry.item.historyId);
      this.visible += 1;
      this.rememberConfirmedTask(entry);
      this.emit("visible", {
        historyId: entry.item.historyId,
        taskId: entry.item.taskId,
        taskRevision: entry.item.taskRevision,
        originSessionId: data.originSessionId,
        visible: this.visible,
      });
    }

    // Run locators are published only after task locators, and only when the
    // exact ACTIVE task row is visible on this actual path at its original
    // capture generation. Capacity is rechecked from live shared accounting,
    // including after any reentrant capture triggered by a report callback.
    for (let index = 0; index < imports.length; index += 1) {
      const entry = imports[index]!;
      if (this.seenRuns.has(entry.key)) {
        this.releaseRunReservation(entry);
        continue;
      }
      if (this.disposed || this.generation !== attemptGeneration) {
        this.refuseRunImports(
          imports.slice(index),
          this.disposed ? "unavailable" : "generation_changed",
          this.disposed
            ? "the history session was disposed before run publication"
            : "the locator generation changed before run publication",
        );
        return;
      }
      if (this.pending.size + this.runReservations.size > HISTORY_SESSION_QUEUE_LIMIT
        || this.pendingBytes + this.runReservationBytes > HISTORY_SESSION_QUEUE_BYTES_LIMIT) {
        this.refuseRun(entry, "limit", "the shared pending task/run bound is full; no entry was evicted");
        continue;
      }
      const association = this.matchConfirmedRun(entry.reference);
      if (association === undefined) {
        this.refuseRun(
          entry,
          this.hasPendingTask(entry.reference) ? "task_history_unconfirmed" : "task_history_missing",
          "no confirmed active task-history row matches this run reference",
        );
        continue;
      }
      if (association.generation !== attemptGeneration) {
        this.refuseRun(
          entry,
          "generation_changed",
          "the task-history row belongs to an older capture generation; the run is never relabeled",
        );
        continue;
      }
      if (association.item.anchor.sessionId !== identity.sessionId) {
        this.refuseRun(
          entry,
          "session_changed",
          "the matched task-history row belongs to a different session",
        );
        continue;
      }
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.refuseRunImports(
          imports.slice(index),
          "session_changed",
          "the agent_end workspace changed before run append",
        );
        return;
      }
      const pre = this.readIdentity(context);
      if (!pre.ok) {
        this.locatorState = "unavailable";
        this.refuseRunImports(imports.slice(index), "unavailable", pre.detail);
        return;
      }
      if (!this.sameSession(reread.identity, pre.identity)) {
        this.refuseRunImports(
          imports.slice(index),
          "session_changed",
          "the session or session file changed before run append",
        );
        return;
      }

      let beforeBranch: readonly unknown[];
      let beforeLeaf: string | null;
      try {
        beforeBranch = pre.identity.manager.getBranch();
        beforeLeaf = pre.identity.manager.getLeafId();
      } catch (error) {
        this.locatorState = "unavailable";
        this.refuseRunImports(
          imports.slice(index),
          "unavailable",
          `the actual pre-append branch could not be read: ${errorMessage(error)}`,
        );
        return;
      }
      if (!Array.isArray(beforeBranch)
        || typeof beforeLeaf !== "string"
        || beforeLeaf.length === 0
        || beforeBranch.length === 0
        || (beforeBranch[beforeBranch.length - 1] as { id?: unknown } | undefined)?.id !== beforeLeaf) {
        this.refuseRunImports(
          imports.slice(index),
          "session_changed",
          "the selected leaf is not the actual pre-append branch end",
        );
        return;
      }
      const locator = taskLocatorPath(
        association.item,
        beforeBranch,
        pre.identity.sessionId,
        this.instanceId,
        this.owner.ownerId,
      );
      if (!locator.ok) {
        this.refuseRun(entry, locator.reason, locator.detail);
        continue;
      }

      const data = runLocatorData(this.instanceId, this.owner.ownerId, association, entry.reference);
      let bytes: number;
      try {
        bytes = dataBytes(data);
      } catch (error) {
        this.refuseRun(entry, "limit", `the run locator payload could not be sized: ${errorMessage(error)}`);
        continue;
      }
      if (bytes > HISTORY_RUN_LOCATOR_DATA_BYTES_LIMIT) {
        this.refuseRun(entry, "limit", "the run locator payload exceeds its byte bound");
        continue;
      }

      try {
        this.appendEntry!(HISTORY_RUN_LOCATOR_CUSTOM_TYPE, data);
      } catch (error) {
        this.unknownRun(entry, `appendEntry threw; the outcome is possibly applied: ${errorMessage(error)}`);
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      if (this.disposed || this.generation !== attemptGeneration) {
        this.unknownRun(entry, "appendEntry returned after navigation or disposal; the outcome is possibly applied");
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.unknownRun(entry, "appendEntry returned after the workspace changed; the outcome is possibly applied");
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      const post = this.readIdentity(context);
      if (!post.ok) {
        this.unknownRun(entry, `the post-append session identity is unavailable: ${post.detail}`);
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      if (!this.sameSession(pre.identity, post.identity)) {
        this.unknownRun(entry, "appendEntry returned after the session or session file changed; the outcome is possibly applied");
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }

      let afterBranch: readonly unknown[];
      let afterLeaf: string | null;
      try {
        afterBranch = post.identity.manager.getBranch();
        afterLeaf = post.identity.manager.getLeafId();
      } catch (error) {
        this.unknownRun(entry, `the appended branch could not be re-read: ${errorMessage(error)}`);
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      const failure = verifyAppend(
        beforeBranch,
        beforeLeaf,
        afterBranch,
        afterLeaf,
        HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
        data,
        RUN_LOCATOR_KEYS,
      );
      if (failure !== null) {
        this.unknownRun(entry, `appendEntry returned without one exact visible run entry: ${failure}`);
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }
      const postLocator = taskLocatorPath(
        association.item,
        afterBranch,
        post.identity.sessionId,
        this.instanceId,
        this.owner.ownerId,
      );
      if (!postLocator.ok) {
        this.unknownRun(
          entry,
          `the post-append branch no longer proves the exact task locator: ${postLocator.detail}`,
        );
        this.releaseRunReservations(imports.slice(index + 1));
        return;
      }

      if (!this.markRun(entry, "visible")) continue;
      this.runVisible += 1;
      this.emit("run_visible", {
        historyId: association.item.historyId,
        taskId: association.item.taskId,
        taskRevision: association.item.taskRevision,
        runId: entry.reference.runId,
        callId: entry.reference.callId,
        originSessionId: data.originSessionId,
        runVisible: this.runVisible,
      });
    }
    this.releaseRunReservations(imports);
  }

  navigate(event: "session_start" | "session_switch" | "session_branch" | "session_tree"): void {
    if (this.disposed) return;
    this.generation += 1;
    const invalidated = this.invalidatePending("navigation", `${event} invalidated pending locators`);
    if (invalidated > 0) this.emit("navigation", { event, invalidated });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    try {
      this.unsubscribe?.();
    } catch {
      // Cleanup is best-effort; no asynchronous flush is started.
    }
    const invalidated = this.invalidatePending("dispose", "disposal invalidated pending locators");
    if (invalidated > 0) this.emit("disposed", { invalidated });
  }
}

export function createHistorySession(options: HistorySessionOptions): HistorySessionControls {
  return new HistorySession(options);
}
