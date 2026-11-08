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
/** Reuses the projection row bound; this is rows, not tasks. */
export const HISTORY_SESSION_QUEUE_LIMIT = HISTORY_ITEM_LIMIT;
/** Each item is already bounded by the projection; the queue is bounded too. */
export const HISTORY_SESSION_QUEUE_BYTES_LIMIT = HISTORY_ITEM_BYTES_LIMIT * HISTORY_ITEM_LIMIT;
/** Strict allowlisted locator data is far smaller than this. */
export const HISTORY_LOCATOR_DATA_BYTES_LIMIT = 1024;
/** Existing replay bound reused as the complete-branch traversal budget. */
export const HISTORY_SESSION_BRANCH_ENTRY_LIMIT = TASK_REPLAY_ENTRY_LIMIT;
/** Small bounded wait; a late completion is never allowed to append. */
export const HISTORY_ENSURE_ON_DISK_TIMEOUT_MS = 2000;

const SAFE_INSTANCE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
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
  readonly lastReason: { readonly code: HistoryReasonCode; readonly detail: string } | null;
  readonly reasonCounts: Readonly<Record<HistoryReasonCode, number>>;
}

export interface HistorySessionControls {
  /** Readonly host diagnostics; never requirement text. */
  status(): HistorySessionStatus;
  /** Main-agent lifecycle entry point. Safe to call without awaiting. */
  handleAgentEnd(event: unknown, context: OmpToolContext): Promise<void>;
  /** Invalidate pending publish eligibility on real session navigation. */
  navigate(event: "session_start" | "session_switch" | "session_branch" | "session_tree"): void;
  /** Unsubscribe and invalidate without any asynchronous flush. */
  dispose(): void;
}

export type HistorySessionReport = (
  type: "captured" | "visible" | "incomplete" | "unknown" | "unavailable" | "navigation" | "disposed" | "ignored",
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

function dataBytes(data: HistoryLocatorData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

function sameLocatorData(value: unknown, expected: HistoryLocatorData): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...LOCATOR_KEYS].sort();
  if (keys.length !== expectedKeys.length) return false;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (keys[index] !== expectedKeys[index]) return false;
  }
  for (const key of LOCATOR_KEYS) {
    if (record[key] !== expected[key]) return false;
  }
  return true;
}

function verifyAppend(
  beforeBranch: readonly unknown[],
  beforeLeaf: string,
  afterBranch: readonly unknown[],
  afterLeaf: string | null,
  expected: HistoryLocatorData,
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
  if (appended.value.customType !== HISTORY_LOCATOR_CUSTOM_TYPE) {
    return "the appended custom entry has the wrong customType";
  }
  if (!sameLocatorData(appended.value.data, expected)) {
    return "the appended custom entry data is not the exact allowlisted payload";
  }
  if (afterLeaf !== appended.id) return "the selected leaf is not the appended entry";
  return null;
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
  private readonly counts = reasonCounts();
  private pendingBytes = 0;
  private generation = 0;
  private captured = 0;
  private visible = 0;
  private incomplete = 0;
  private unknown = 0;
  private disposed = false;
  private captureState: "ready" | "unavailable";
  private locatorState: "ready" | "unavailable";
  private lastReason: { code: HistoryReasonCode; detail: string } | null = null;

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
      lastReason: this.lastReason === null ? null : Object.freeze({ ...this.lastReason }),
      reasonCounts: Object.freeze({ ...this.counts }),
    });
  }

  private note(code: HistoryReasonCode, detail: string): void {
    this.counts[code] += 1;
    this.lastReason = { code, detail: boundedDetail(detail) };
  }

  private emit(
    type: "captured" | "visible" | "incomplete" | "unknown" | "unavailable" | "navigation" | "disposed" | "ignored",
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
      if (this.pending.size >= HISTORY_SESSION_QUEUE_LIMIT
        || this.pendingBytes + bytes > HISTORY_SESSION_QUEUE_BYTES_LIMIT) {
        this.incompleteItem(
          "limit",
          `the pending locator queue is full (${this.pending.size} items, ${this.pendingBytes} bytes); no entry was evicted`,
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

  async handleAgentEnd(_event: unknown, context: OmpToolContext): Promise<void> {
    if (this.disposed) return;
    // Ordinary chat and fresh resumed sessions have nothing pending. Do not
    // touch ensureOnDisk or appendEntry in that case.
    if (this.pending.size === 0 || this.appendEntry === undefined) return;
    if (context.agent?.kind !== "main") return;
    if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
      this.note("identity_changed", "the agent_end workspace differs from the daily workspace");
      this.emit("ignored", { reason: "workspace_mismatch" });
      return;
    }

    const observed = this.readIdentity(context);
    if (!observed.ok) {
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
      if (this.disposed) return;
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
    if (batch.length === 0) return;

    try {
      await withTimeout(Promise.resolve(identity.manager.ensureOnDisk!()), this.ensureOnDiskTimeoutMs);
    } catch (error) {
      // The frozen attempt is invalid, including on timeout. Only this batch
      // is removed; captures committed concurrently are left for a later real
      // lifecycle boundary. A late resolution cannot reach an append below.
      const code: HistoryReasonCode = error instanceof EnsureOnDiskTimeoutError
        ? "timeout"
        : "unavailable";
      if (code === "unavailable") this.locatorState = "unavailable";
      this.invalidateBatch(
        batch,
        code,
        `the ensureOnDisk wait failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (this.disposed || this.generation !== attemptGeneration) return;

    const reread = this.readIdentity(context);
    if (!reread.ok) {
      this.locatorState = "unavailable";
      this.note(reread.code, reread.detail);
      this.emit("unavailable", { code: reread.code, detail: boundedDetail(reread.detail) });
      return;
    }
    if (!this.sameIdentity(identity, reread.identity)) {
      this.invalidateBatch(
        batch,
        "identity_changed",
        "the session, file or selected leaf changed while ensureOnDisk was pending",
      );
      return;
    }
    if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
      this.invalidateBatch(batch, "identity_changed", "the agent_end workspace changed while ensureOnDisk was pending");
      return;
    }

    for (const entry of batch) {
      if (this.disposed || this.generation !== attemptGeneration) return;
      if (!this.pending.has(entry.item.historyId)) continue;
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.invalidateBatch(batch, "identity_changed", "the agent_end workspace changed before append");
        return;
      }
      const pre = this.readIdentity(context);
      if (!pre.ok) {
        this.locatorState = "unavailable";
        this.invalidateBatch(batch, pre.code, pre.detail);
        return;
      }
      if (!this.sameSession(reread.identity, pre.identity)) {
        this.invalidateBatch(
          batch,
          "identity_changed",
          "the session or session file changed before append",
        );
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
        return;
      }

      // A synchronous navigation, disposal or session switch during append
      // makes the outcome possibly applied but never visible-confirmed.
      if (this.disposed || this.generation !== attemptGeneration) {
        this.unknownItem(entry, "appendEntry returned after navigation or disposal; the outcome is possibly applied");
        return;
      }
      if (canonicalWorkspaceRoot(context.cwd) !== this.workspaceRoot) {
        this.unknownItem(entry, "appendEntry returned after the workspace changed; the outcome is possibly applied");
        return;
      }
      const post = this.readIdentity(context);
      if (!post.ok) {
        this.unknownItem(entry, `the post-append session identity is unavailable: ${post.detail}`);
        return;
      }
      if (!this.sameSession(pre.identity, post.identity)) {
        this.unknownItem(entry, "appendEntry returned after the session or session file changed; the outcome is possibly applied");
        return;
      }

      let afterBranch: readonly unknown[];
      let afterLeaf: string | null;
      try {
        afterBranch = post.identity.manager.getBranch();
        afterLeaf = post.identity.manager.getLeafId();
      } catch (error) {
        this.unknownItem(entry, `the appended branch could not be re-read: ${errorMessage(error)}`);
        return;
      }
      const failure = verifyAppend(beforeBranch, beforeLeaf, afterBranch, afterLeaf, data);
      if (failure !== null) {
        this.unknownItem(entry, `appendEntry returned without one exact visible custom entry: ${failure}`);
        return;
      }
      const postMismatch = sourceMismatch(entry.item, afterBranch, post.identity.sessionId);
      if (postMismatch !== null) {
        this.unknownItem(
          entry,
          `the post-append branch no longer proves the complete ledger: ${postMismatch}`,
        );
        return;
      }

      this.removePending(entry.item.historyId);
      this.visible += 1;
      this.emit("visible", {
        historyId: entry.item.historyId,
        taskId: entry.item.taskId,
        taskRevision: entry.item.taskRevision,
        originSessionId: data.originSessionId,
        visible: this.visible,
      });
    }
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
