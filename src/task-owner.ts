import { randomUUID } from "node:crypto";
import {
  branchUserTimestamp,
  genuineUserText,
  lastGenuineUserMessageIdentity,
  parseBranch,
  type BranchEntry,
} from "./task-branch.ts";
import {
  assertRequirementCommitBounds,
  hasRequirementSource,
  requirementProjection,
  requirementsDigest,
  revisionBaselineMatches,
  type RequirementSource,
  type RequirementsProjection,
} from "./task-requirements.ts";
import type { FrozenTaskRef } from "./execution-candidates.ts";
import {
  acceptanceRecordStorePort,
  installPreparedAcceptanceRecordSync,
  maintainInstalledAcceptanceRecordSync,
  type AcceptanceInstallResult,
  type AcceptanceRecordStorePort,
} from "./acceptance-record-store.ts";

/**
 * Generic conversational task ownership for G1-B1/B2a.
 *
 * The owner only knows about host-observed user input, an actual conversation
 * branch anchor, a current task with an append-only requirement ledger, a
 * conservative navigation binding, and a small admission port. It has no
 * domain branches, planner, or run/call identifiers. All authority fields are
 * generated or selected here, never accepted from model arguments.
 */

export const TASK_OWNER_SCHEMA_VERSION = 1 as const;
export const TASK_REVISION_START = 1 as const;
export const TASK_CONTROL_ACTIONS = ["start", "inspect", "revise", "cancel", "history"] as const;
export type TaskControlAction = (typeof TASK_CONTROL_ACTIONS)[number];
export type TaskStatus = "active" | "cancelled" | "accepted";

/** Retained tasks include the current task. History is never evicted silently. */
export const TASK_HISTORY_LIMIT = 128 as const;
/** Message anchors plus committed control replays retained per owner. */
export const TASK_REPLAY_ENTRY_LIMIT = 4096 as const;
/** History rows per read. The hard page bound also applies to cursors. */
export const TASK_HISTORY_PAGE_LIMIT = 16 as const;

/** Immutable optimistic selector. It never authorizes an action by itself. */
export interface TaskGuard {
  taskId: string;
  taskRevision: number;
}

export interface TaskHistoryRow {
  taskId: string;
  taskRevision: number;
  status: "accepted" | "cancelled";
  createdAt: string;
  terminalAt: string | null;
  anchorMessageId: string;
  anchorSessionId: string;
  anchorSource: GenuineInputSource;
  sourceCount: number;
  amendmentCount: number;
  acceptanceId: string | null;
  acceptanceInstallUnknown: boolean;
  current: boolean;
}

export interface TaskHistoryPage {
  rows: TaskHistoryRow[];
  /** Next numeric page offset, or null when the visible history is exhausted. */
  nextCursor: number | null;
  total: number;
  retention: TaskRetentionFacts;
}

export interface TaskRetentionFacts {
  tasksRetained: number;
  tasksLimit: number;
  terminalTasks: number;
  replayEntries: number;
  replayEntriesLimit: number;
}

export interface AcceptanceReference {
  acceptanceId: string;
  deliveryId: string;
  recordDigest: string;
  acceptedAt: string;
}

export type AcceptanceReservationToken = object;

export interface AcceptanceCommitResult {
  status: AcceptanceInstallStatus;
  reason: string | null;
  warnings: string[];
  acceptance: AcceptanceReference | null;
  operationCommitted: boolean | null;
}

type AcceptanceInstallStatus = AcceptanceInstallResult["status"];

interface AcceptanceReservationState {
  token: object;
  task: FrozenTaskRef;
  epoch: number;
  released: boolean;
  committed: boolean;
}

/** Bounded defensive unknown-installation facts. No recovery engine exists. */
export interface AcceptanceHazardFacts {
  task: FrozenTaskRef;
  acceptanceId: string;
  deliveryId: string;
  recordDigest: string;
  reason: string;
}

function boundedHazardReason(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}

interface AcceptanceHazard {
  task: FrozenTaskRef;
  reason: string;
  acceptanceId: string;
  deliveryId: string;
  recordDigest: string;
}
export type GenuineInputSource = "interactive" | "rpc";

export class TaskOwnerError extends Error {
  override name = "TaskOwnerError";
}

export interface InputObservation {
  sessionId: string;
  workspaceRoot: string;
  source: GenuineInputSource;
  text: string;
  observedAt: string;
  /** Branch leaf id observed immediately before OMP appends the user message. */
  baseLeafId: string;
}

export interface TaskSubject {
  sessionId: string;
  workspaceRoot: string;
  agentKind: "main" | "sub";
  /** Current root-to-leaf session branch, exactly as supplied by OMP. */
  branch: readonly unknown[];
}

export interface TaskAnchor {
  sessionId: string;
  messageId: string;
  source: GenuineInputSource;
  observedText: string;
  anchorText: string;
  observedAt: string;
}

export interface ManagedTask {
  schemaVersion: typeof TASK_OWNER_SCHEMA_VERSION;
  taskId: string;
  ownerId: string;
  /** Positive revision; increments only on accepted genuine-user amendments. */
  taskRevision: number;
  status: TaskStatus;
  /** Immutable host-observed request. Model understanding never replaces it. */
  rawRequest: string;
  /** Immutable creation anchor. */
  anchor: TaskAnchor;
  /** Original request followed by accepted amendments, in revision order. */
  requirementSources: RequirementSource[];
  /** Optional model understanding; never authoritative requirement text. */
  understanding: string | null;
  understandingRevision: number | null;
  understandingStale: boolean;
  createdAt: string;
  cancelledAt: string | null;
  /** Set exactly once when the host record installation commits. */
  acceptance: AcceptanceReference | null;
  admissions: number;
}

export interface UserTurnGrant {
  turnId: number;
  sessionId: string;
  workspaceRoot: string;
  source: GenuineInputSource;
  text: string;
  observedAt: string;
  baseLeafId: string;
  /** Owner task identity observed with this real input, before any commit. */
  baselineTaskId: string | null;
  /** Owner taskRevision observed with this real input, before any commit. */
  baselineTaskRevision: number | null;
  started: boolean;
  /** Branch entry id of the genuine user message once resolved. */
  anchorMessageId: string | null;
  /** Set when a non-user control message closed the authority window. */
  authorityClosed: boolean;
}

export type BindingState = "attached" | "detached";

export interface BindingStatus {
  state: BindingState;
  reason: string | null;
  /** Host event that detached the binding, when known. */
  event: string | null;
  sessionId: string | null;
  since: string | null;
}

export interface TaskOwnerSnapshot {
  schemaVersion: typeof TASK_OWNER_SCHEMA_VERSION;
  ownerId: string;
  workspaceRoot: string;
  tasksCreated: number;
  currentTask: ManagedTask | null;
  activeGrant: UserTurnGrant | null;
  suspended: { reason: string } | null;
  /** Navigation binding for mutations/admissions; task history is retained. */
  binding: BindingStatus;
  authorizedCapabilities: string[];
  /** Durable in-process unknown acceptance installation facts, if any. */
  acceptanceHazard: AcceptanceHazardFacts | null;
  /** Bounded counts only; full historical ledgers require explicit inspection. */
  retention: TaskRetentionFacts;
}

export interface TaskStartResult {
  created: boolean;
  task: ManagedTask;
  /** True when the returned task is retained history, never the current task. */
  historical: boolean;
}

export interface TaskRevisionResult {
  /** False when this exact host message already committed its revision. */
  revised: boolean;
  task: ManagedTask;
}

/** Bounded read-only final usability facts; never a capability token. */
export interface TaskUsabilityFacts {
  usable: boolean;
  reason: string | null;
}

export interface AdmissionDecision {
  allowed: boolean;
  reason: string | null;
  taskId: string | null;
  ownerId: string;
  taskRevision: number | null;
  /** Caller-supplied optimistic selector, never authority. */
  expectedTaskId: string | null;
  /** Caller-supplied optimistic guard, never authority. */
  expectedTaskRevision: number | null;
  anchorMessageId: string | null;
  capabilityId: string;
  actionIndex: number | null;
  status: TaskStatus | null;
}

export interface TaskControlArguments {
  action: TaskControlAction;
  understanding?: string;
  expectedTaskId?: string;
  expectedTaskRevision?: number;
  cursor?: number;
  limit?: number;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_UNDERSTANDING = 4000;
const CONTROL_KEYS = new Set([
  "action",
  "understanding",
  "expectedTaskId",
  "expectedTaskRevision",
  "cursor",
  "limit",
]);
/** Authoritative identity fields stay forbidden; expected* are selectors only. */
const MODEL_AUTHORITY_KEYS = new Set([
  "taskId",
  "taskRevision",
  "ownerId",
  "runId",
  "attemptId",
  "executionEpoch",
  "source",
  "messageId",
  "messageID",
  "anchor",
  "anchorId",
  "rawRequest",
  "rawText",
  "permissions",
  "permission",
  "budget",
  "workspaceRoot",
  "sessionId",
  "task",
  "goal",
]);
const CURSOR = /^(?:0|[1-9][0-9]{0,6})$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskOwnerError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, limit = 100_000): string {
  if (typeof value !== "string" || !value.trim()) throw new TaskOwnerError(`${label} must be non-empty text.`);
  if (value.length > limit) throw new TaskOwnerError(`${label} exceeds ${limit} characters.`);
  if (value.includes("\0")) throw new TaskOwnerError(`${label} contains a NUL character.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TaskOwnerError(`${label} is not a valid identifier.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TaskOwnerError(`${label} must be an ISO timestamp.`);
  return value;
}

function copyTask(task: ManagedTask): ManagedTask {
  return {
    ...task,
    anchor: { ...task.anchor },
    requirementSources: task.requirementSources.map((source) => ({ ...source })),
    acceptance: task.acceptance === null ? null : { ...task.acceptance },
  };
}

function frozenOf(task: ManagedTask): FrozenTaskRef {
  return {
    ownerId: task.ownerId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: requirementsDigest(task.requirementSources),
  };
}

function sameFrozen(left: FrozenTaskRef, right: FrozenTaskRef): boolean {
  return left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest === right.requirementsDigest;
}

function copyGrant(grant: UserTurnGrant): UserTurnGrant {
  return { ...grant };
}

/** Defensive copy for listener facts: primitives, arrays and plain records. */
function copyFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => copyFacts(item));
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) copy[key] = copyFacts(item);
      return copy;
    }
  }
  return value;
}

function freezeFacts<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeFacts(item);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) freezeFacts(item);
    return Object.freeze(value);
  }
  return value;
}

/** Strict host-side selector normalization. It grants nothing by itself. */
function taskSelector(value: unknown): TaskGuard {
  const record = object(value, "Task selector");
  const taskId = identifier(record.taskId, "expectedTaskId");
  const taskRevision = record.taskRevision;
  if (typeof taskRevision !== "number" || !Number.isSafeInteger(taskRevision) || taskRevision <= 0) {
    throw new TaskOwnerError("expectedTaskRevision must be a positive integer copied from the host task view.");
  }
  return { taskId, taskRevision };
}

function messageKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`;
}

function controlKey(sessionId: string, messageId: string, action: "revise" | "cancel"): string {
  return `${sessionId}\0${messageId}\0${action}`;
}

/**
 * A pending observation has never started an agent and never resolved a
 * branch anchor. Only this state may be expired/replaced by later genuine
 * input, and an unrelated agent start must not consume it.
 */
function isUnresolvedPendingObservation(grant: UserTurnGrant): boolean {
  return !grant.started && grant.anchorMessageId === null && !grant.authorityClosed;
}

/**
 * Strict model-facing argument parser. Authoritative identity, permissions,
 * source and anchor fields are rejected explicitly. expectedTaskId and
 * expectedTaskRevision are allowed only as selectors copied from the host's
 * visible task facts; they never authorize an action.
 */
export function parseTaskControlArguments(value: unknown): TaskControlArguments {
  const args = object(value, "Task control arguments");
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => MODEL_AUTHORITY_KEYS.has(key));
  if (forbidden.length) {
    throw new TaskOwnerError(
      `agent_task never accepts task authority from model parameters: ${forbidden.join(", ")}. Selectors are expectedTaskId and expectedTaskRevision only, copied from host-visible task facts.`,
    );
  }
  const unknown = keys.filter((key) => !CONTROL_KEYS.has(key));
  if (unknown.length) throw new TaskOwnerError(`agent_task has unsupported field(s): ${unknown.join(", ")}.`);
  const action = args.action;
  if (typeof action !== "string" || !(TASK_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new TaskOwnerError("agent_task action must be start, inspect, revise, cancel or history.");
  }
  const selected = action as TaskControlAction;
  if (args.understanding !== undefined && action !== "start" && action !== "revise") {
    throw new TaskOwnerError("Agent understanding may be supplied only when starting or revising a task.");
  }
  const hasId = args.expectedTaskId !== undefined;
  const hasRevision = args.expectedTaskRevision !== undefined;
  if (hasId !== hasRevision) {
    throw new TaskOwnerError("expectedTaskId and expectedTaskRevision must be supplied together as one selector.");
  }
  if (action === "revise" || action === "cancel") {
    if (!hasId) {
      throw new TaskOwnerError(`agent_task ${action} requires expectedTaskId and expectedTaskRevision copied from the current host task view.`);
    }
  } else if (action === "start" || action === "history") {
    if (hasId) {
      throw new TaskOwnerError(`agent_task ${action} does not accept task selectors; only revise and cancel require them, and inspect may use them for one explicit target.`);
    }
  }
  if (args.cursor !== undefined || args.limit !== undefined) {
    if (action !== "history") throw new TaskOwnerError("cursor and limit are supported only by the history action.");
  }
  const result: TaskControlArguments = { action: selected };
  if (args.understanding !== undefined) {
    result.understanding = text(args.understanding, "Agent understanding", MAX_UNDERSTANDING).trim();
  }
  if (hasId) {
    result.expectedTaskId = identifier(args.expectedTaskId, "expectedTaskId");
    const revision = args.expectedTaskRevision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
      throw new TaskOwnerError("expectedTaskRevision must be a positive integer copied from the host task view.");
    }
    result.expectedTaskRevision = revision;
  }
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== "number" || !Number.isSafeInteger(args.cursor) || args.cursor < 0) {
      throw new TaskOwnerError("history cursor must be a non-negative integer page offset.");
    }
    result.cursor = args.cursor;
  }
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > TASK_HISTORY_PAGE_LIMIT) {
      throw new TaskOwnerError(`history limit must be an integer between 1 and ${TASK_HISTORY_PAGE_LIMIT}.`);
    }
    result.limit = args.limit;
  }
  return result;
}

export type TaskOwnerEvent = Readonly<Record<string, unknown> & { type: string; ownerId: string }>;
export type TaskOwnerListener = (event: TaskOwnerEvent) => void | Promise<void>;

export interface TaskOwnerListenerFailure {
  /** `sync` while the listener call threw; `async` for a rejected promise. */
  mode: "sync" | "async";
  eventType: string;
  error: string;
}

export interface TaskOwnerOptions {
  workspaceRoot: string;
  authorizedCapabilities?: readonly string[];
  /** Host-owned custom message types that never close a user authority window. */
  trustedControlTypes?: readonly string[];
  ownerId?: string;
  now?: () => string;
  id?: () => string;
  onStateChange?: (snapshot: TaskOwnerSnapshot) => void;
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
  /**
   * Host-only diagnostic. Listener failures never roll back a committed owner
   * event and never recursively notify subscribers.
   */
  onListenerFailure?: (failure: TaskOwnerListenerFailure) => void;
}

/**
 * Single authoritative owner. One current task is mutable at a time. A later
 * genuine user turn may start a new task only after the current task is
 * accepted or cancelled; retained history is read-only and replay-indexed.
 */
export class TaskOwner {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  private readonly capabilities: Set<string>;
  private readonly trustedControlTypes: Set<string>;
  private readonly now: () => string;
  private readonly newId: () => string;
  /** Fixed at construction from this module's lexical record-store instance. */
  private readonly recordStore: AcceptanceRecordStorePort;
  private readonly onStateChange: ((snapshot: TaskOwnerSnapshot) => void) | undefined;
  private readonly onEvent: ((event: Record<string, unknown> & { type: string }) => void) | undefined;
  private readonly onListenerFailure: ((failure: TaskOwnerListenerFailure) => void) | undefined;
  private readonly listeners = new Map<number, TaskOwnerListener>();
  private listenerSequence = 0;
  private tasksCreated = 0;
  private task: ManagedTask | undefined;
  /** Retained tasks in creation order, including the current task. */
  private readonly tasks = new Map<string, ManagedTask>();
  /** Genuine creation-message anchors, retained for idempotent replay. */
  private readonly anchorIndex = new Map<string, { taskId: string }>();
  /** Committed revise/cancel control messages, retained for replay safety. */
  private readonly controlIndex = new Map<string, { taskId: string; action: "revise" | "cancel" }>();
  private stateEpoch = 0;
  private grant: UserTurnGrant | undefined;
  private suspended: { reason: string } | undefined;
  private detached: { reason: string; event: string; sessionId: string | null; since: string } | undefined;
  private lastSessionId: string | undefined;
  private turnSequence = 0;
  private readonly closedInputs = new Set<string>();
  private acceptanceReservation: AcceptanceReservationState | undefined;
  private readonly acceptanceTokens = new WeakMap<object, AcceptanceReservationState>();
  private acceptanceEpoch = 0;
  private acceptanceHazard: AcceptanceHazard | undefined;

  private inputKey(sessionId: string, baseLeafId: string, text: string): string {
    return `${sessionId}\0${baseLeafId}\0${text}`;
  }

  private rememberClosedInput(key: string): void {
    this.closedInputs.add(key);
    if (this.closedInputs.size > 128) {
      const oldest = this.closedInputs.values().next().value;
      if (oldest !== undefined) this.closedInputs.delete(oldest);
    }
  }

  constructor(options: TaskOwnerOptions) {
    if (typeof options.workspaceRoot !== "string" || !options.workspaceRoot) {
      throw new TaskOwnerError("Task owner requires a workspace root.");
    }
    this.workspaceRoot = options.workspaceRoot;
    this.ownerId = options.ownerId === undefined ? `owner-${randomUUID()}` : identifier(options.ownerId, "ownerId");
    this.capabilities = new Set((options.authorizedCapabilities ?? []).map((item) => identifier(item, "capability id")));
    this.trustedControlTypes = new Set((options.trustedControlTypes ?? []).map((item) => identifier(item, "trusted control type")));
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.id ?? (() => randomUUID());
    this.recordStore = acceptanceRecordStorePort();
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
    this.onListenerFailure = options.onListenerFailure;
  }

  /**
   * Host-only immutable record-store port fixed at construction. The acceptance
   * coordinator captures this instance once; commit never re-reads it from an
   * external getter between the final evidence seal and fixed installation.
   */
  acceptanceRecordStore(): AcceptanceRecordStorePort {
    return this.recordStore;
  }

  /**
   * Host-only read subscription. Listeners receive immutable facts after the
   * owner has already committed the change. The returned function is the only
   * capability; no listener receives an owner handle or authority.
   */
  subscribe(listener: TaskOwnerListener): () => void {
    if (typeof listener !== "function") throw new TaskOwnerError("Task owner listener must be a function.");
    const id = ++this.listenerSequence;
    this.listeners.set(id, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(id);
    };
  }

  snapshot(): TaskOwnerSnapshot {
    return {
      schemaVersion: TASK_OWNER_SCHEMA_VERSION,
      ownerId: this.ownerId,
      workspaceRoot: this.workspaceRoot,
      tasksCreated: this.tasksCreated,
      currentTask: this.task ? copyTask(this.task) : null,
      activeGrant: this.grant ? copyGrant(this.grant) : null,
      suspended: this.suspended ? { ...this.suspended } : null,
      binding: this.bindingStatus(),
      authorizedCapabilities: [...this.capabilities].sort(),
      acceptanceHazard: this.acceptanceHazard === undefined
        ? null
        : {
            task: { ...this.acceptanceHazard.task },
            acceptanceId: this.acceptanceHazard.acceptanceId,
            deliveryId: this.acceptanceHazard.deliveryId,
            recordDigest: this.acceptanceHazard.recordDigest,
            reason: this.acceptanceHazard.reason,
          },
      retention: this.retentionFacts(),
    };
  }

  private terminalTasks(): ManagedTask[] {
    return [...this.tasks.values()].filter((task) => task.status !== "active");
  }

  private retentionFacts(): TaskRetentionFacts {
    return {
      tasksRetained: this.tasks.size,
      tasksLimit: TASK_HISTORY_LIMIT,
      terminalTasks: this.terminalTasks().length,
      replayEntries: this.anchorIndex.size + this.controlIndex.size,
      replayEntriesLimit: TASK_REPLAY_ENTRY_LIMIT,
    };
  }

  /**
   * Read-only capability-facing check. It verifies the subject's actual branch
   * still reaches the task's creation anchor; it emits no event and grants no
   * mutation or admission authority.
   */
  reachableTask(subject: TaskSubject): ManagedTask {
    this.assertSubject(subject);
    if (!this.detached) {
      if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
      this.assertTaskReachable(subject, this.task);
      return copyTask(this.task);
    }
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    throw new TaskOwnerError(
      `Task history is detached (${this.detached.reason}); no active capability binding is available.`,
    );
  }

  /** Read-only navigation binding status. It never reattaches authority. */
  bindingStatus(): BindingStatus {
    return this.detached
      ? {
        state: "detached",
        reason: this.detached.reason,
        event: this.detached.event,
        sessionId: this.detached.sessionId,
        since: this.detached.since,
      }
      : { state: "attached", reason: null, event: null, sessionId: this.lastSessionId ?? null, since: null };
  }

  private assertAttached(action: string): void {
    if (this.detached) {
      throw new TaskOwnerError(
        `${action} is unavailable: the conversation binding is detached (${this.detached.reason}). Task history remains readable but no mutation, admission or transfer is available.`,
      );
    }
  }

  /**
   * Pure, read-only final usability check for an already-authorized consumer.
   * It invokes no host callback, emits no event, consumes no reservation and
   * exposes no authority token. Callers run every host getter first, then this
   * check immediately before the side effect. `taskRevision: null` checks only
   * the immutable operation target (used for revision-old receipts), while
   * `requireActive` distinguishes a mutating consumer from a read-only query
   * of the current cancelled task.
   */
  targetUsability(
    taskId: string,
    taskRevision: number | null,
    options: { requireActive: boolean; subject?: TaskSubject },
  ): TaskUsabilityFacts {
    const deny = (reason: string): TaskUsabilityFacts => ({ usable: false, reason });
    if (this.detached) return deny(`conversation binding is detached: ${this.detached.reason}`);
    if (this.suspended) return deny(`task owner is suspended: ${this.suspended.reason}`);
    if (this.acceptanceHazard) return deny("the acceptance commit outcome is unknown");
    if (this.acceptanceReservation) return deny("an acceptance reservation is active");
    const task = this.task;
    if (!task) return deny("no managed task exists");
    if (task.taskId !== taskId) return deny("the current task is a different task");
    if (taskRevision !== null && task.taskRevision !== taskRevision) {
      return deny(`the current task is at revision ${task.taskRevision}, not ${taskRevision}`);
    }
    if (options.requireActive && task.status !== "active") {
      return deny(`the current task is ${task.status}`);
    }
    const subject = options.subject;
    if (subject !== undefined) {
      if (subject.workspaceRoot !== this.workspaceRoot) return deny("session workspace does not match the task owner workspace");
      if (subject.sessionId !== task.anchor.sessionId) return deny("task belongs to a different OMP session");
      try {
        if (!parseBranch(subject.branch).some((entry) => entry.id === task.anchor.messageId)) {
          return deny("task anchor is not in the current conversation branch");
        }
      } catch {
        return deny("the current conversation branch is not a usable task branch");
      }
    }
    return { usable: true, reason: null };
  }

  private reportHostCallbackFailure(callback: "onEvent" | "onStateChange", eventType: string, error: unknown): void {
    try {
      process.stderr.write(`${JSON.stringify({
        type: "omp_agent_task_owner",
        message: "host_callback_failed",
        callback,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
    } catch {
      // A diagnostic channel is not guaranteed.
    }
  }

  private reportListenerFailure(failure: TaskOwnerListenerFailure): void {
    try {
      this.onListenerFailure?.(failure);
    } catch {
      // Diagnostics can never affect owner state.
    }
    try {
      this.onEvent?.({ type: "task_listener_failed", ...failure });
    } catch {
      // The audit channel is host-owned and may also fail.
    }
    try {
      process.stderr.write(`${JSON.stringify({ type: "omp_agent_task_owner", message: "listener_failed", ...failure })}\n`);
    } catch {
      // A diagnostic channel is not guaranteed.
    }
  }

  private changed(event?: Record<string, unknown> & { type: string }): void {
    const facts: TaskOwnerEvent | undefined = event
      ? freezeFacts({ ...(copyFacts(event) as Record<string, unknown>), type: event.type, ownerId: this.ownerId })
      : undefined;
    // Existing host callbacks remain authoritative and fail-closed: their
    // first error is remembered, later host callbacks stop in baseline order,
    // but post-commit subscribers still observe the committed event before the
    // error is propagated to the caller.
    let hostFailed = false;
    let hostError: unknown;
    if (facts && this.onEvent) {
      try {
        this.onEvent(facts as Record<string, unknown> & { type: string });
      } catch (error) {
        hostFailed = true;
        hostError = error;
        this.reportHostCallbackFailure("onEvent", facts.type, error);
      }
    }
    if (!hostFailed) {
      try {
        this.onStateChange?.(this.snapshot());
      } catch (error) {
        hostFailed = true;
        hostError = error;
        this.reportHostCallbackFailure("onStateChange", facts?.type ?? "state_change", error);
      }
    }
    if (facts) {
      // Snapshot registrations: an unsubscribe during dispatch only affects
      // later events. Each listener gets its own frozen copy.
      const listeners = [...this.listeners.values()];
      for (const listener of listeners) {
        const delivered = freezeFacts(copyFacts(facts)) as TaskOwnerEvent;
        try {
          const result = listener(delivered);
          if (result && typeof (result as PromiseLike<void>).then === "function") {
            Promise.resolve(result).catch((error: unknown) => {
              this.reportListenerFailure({
                mode: "async",
                eventType: facts.type,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } catch (error) {
          this.reportListenerFailure({
            mode: "sync",
            eventType: facts.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (hostFailed) {
      // Preserve baseline propagation identity: the original host error is
      // rethrown even when it is `undefined`; optional listener failures never
      // reach this path.
      throw hostError;
    }
  }

  private suspend(reason: string, event?: Record<string, unknown> & { type: string }): void {
    this.grant = undefined;
    this.suspended = { reason };
    this.changed(event ?? { type: "task_owner_suspended", reason });
  }

  /**
   * Observe direct OMP input. The same event shape with the same pre-message
   * leaf is treated as a duplicate observation, not a second user message.
   * Two different real turns (different leaves) or any overlap are rejected.
   */
  observeInput(input: InputObservation): { accepted: boolean; duplicate: boolean; reason: string | null } {
    const sessionId = identifier(input.sessionId, "sessionId");
    const source = input.source;
    if (source !== "interactive" && source !== "rpc") {
      return { accepted: false, duplicate: false, reason: "unsupported input source" };
    }
    if (input.workspaceRoot !== this.workspaceRoot) {
      return { accepted: false, duplicate: false, reason: "workspace does not match the task owner" };
    }
    const raw = text(input.text, "User input");
    const observedAt = timestamp(input.observedAt, "observedAt");
    const baseLeafId = identifier(input.baseLeafId, "baseLeafId");
    if (this.closedInputs.has(this.inputKey(sessionId, baseLeafId, raw))) {
      return { accepted: false, duplicate: true, reason: "the observed user turn is already closed" };
    }
    if (this.suspended) {
      return { accepted: false, duplicate: false, reason: this.suspended.reason };
    }
    let superseded: UserTurnGrant | undefined;
    if (this.grant) {
      if (this.grant.sessionId === sessionId && this.grant.baseLeafId === baseLeafId && this.grant.text === raw) {
        return { accepted: false, duplicate: true, reason: null };
      }
      // OMP fires input for local extension commands that can finish with
      // prompt_result.agentInvoked=false and no before_agent_start/agent_end.
      // Such an observation is only pending: it never started an agent and
      // never resolved an anchor, so a later genuine input may expire it.
      // The pending-start state is matched before any authority/anchor path;
      // a started grant or any resolved anchor is never overwritten here.
      if (!isUnresolvedPendingObservation(this.grant)) {
        this.suspend("unsupported overlapping user turns", {
          type: "task_owner_overlap_rejected",
          sessionId,
          previousTurnId: this.grant.turnId,
        });
        return { accepted: false, duplicate: false, reason: "unsupported overlapping user turns" };
      }
      superseded = this.grant;
      this.rememberClosedInput(this.inputKey(superseded.sessionId, superseded.baseLeafId, superseded.text));
      this.changed({
        type: "task_observation_superseded",
        previousTurnId: superseded.turnId,
        previousSessionId: superseded.sessionId,
        previousBaseLeafId: superseded.baseLeafId,
        previousTextLength: superseded.text.length,
        sessionId,
        baseLeafId,
      });
    }
    this.lastSessionId = sessionId;
    this.grant = {
      turnId: ++this.turnSequence,
      sessionId,
      workspaceRoot: input.workspaceRoot,
      source,
      text: raw,
      observedAt,
      baseLeafId,
      baselineTaskId: this.task?.taskId ?? null,
      baselineTaskRevision: this.task?.taskRevision ?? null,
      started: false,
      anchorMessageId: null,
      authorityClosed: false,
    };
    this.changed({
      type: "genuine_input_observed",
      sessionId,
      source,
      turnId: this.grant.turnId,
      baseLeafId,
      baselineTaskId: this.grant.baselineTaskId,
      baselineTaskRevision: this.grant.baselineTaskRevision,
      textLength: raw.length,
      ...(superseded === undefined ? {} : { supersededTurnId: superseded.turnId }),
    });
    return { accepted: true, duplicate: false, reason: null };
  }

  /**
   * Called from before_agent_start. A matching prompt marks the grant started;
   * any different prompt (including background/follow-up text) closes it.
   */
  observeAgentStart(input: { sessionId: string; prompt: string; reason: string }): boolean {
    const grant = this.grant;
    if (!grant) return false;
    if (grant.sessionId !== input.sessionId) {
      this.rememberClosedInput(this.inputKey(grant.sessionId, grant.baseLeafId, grant.text));
      this.grant = undefined;
      this.changed({ type: "task_grant_closed", reason: "session changed" });
      return false;
    }
    if (input.reason !== "prompt" || input.prompt.trim() !== grant.text.trim()) {
      // A background or unmatched agent start is not identity evidence for
      // this observation. An unresolved pending observation (e.g. a local
      // command that invoked no agent) stays pending and replaceable; it is
      // not started, closed, or converted into authority. Started grants and
      // anchored observations keep the strict close behavior.
      if (isUnresolvedPendingObservation(grant)) {
        this.changed({
          type: "task_agent_start_ignored",
          reason: input.reason !== "prompt" ? "background agent start" : "different agent start prompt",
          turnId: grant.turnId,
          sessionId: input.sessionId,
        });
        return false;
      }
      this.rememberClosedInput(this.inputKey(grant.sessionId, grant.baseLeafId, grant.text));
      this.grant = undefined;
      this.changed({ type: "task_grant_closed", reason: "different agent start" });
      return false;
    }
    grant.started = true;
    this.changed({ type: "task_grant_started", turnId: grant.turnId, sessionId: grant.sessionId });
    return true;
  }

  /**
   * Close a turn only with actual identity evidence. Text equality alone is
   * not message identity, so a run end is accepted only when:
   *   - the current branch uniquely resolves this grant's anchor message, and
   *   - the run's own user message carries a matching host id, or (OMP 18.18,
   *     where agent_end user messages have no id) a host timestamp that
   *     identifies exactly one genuine branch user entry, which must be this
   *     grant's expected anchor.
   * A timestamp is not identity: an ambiguous match is refused rather than
   * revoking a newer same-text grant. Without either correlation the close is
   * refused; control authority is still closed by branch revalidation on every
   * start/cancel entry.
   */
  closeTurn(input: { sessionId: string; branch: readonly unknown[]; messages?: readonly unknown[] }): boolean {
    const grant = this.grant;
    if (!grant || grant.sessionId !== input.sessionId) return false;
    const evidence = lastGenuineUserMessageIdentity(input.messages);
    if (!evidence) {
      this.changed({ type: "turn_close_unverified", reason: "agent_end has no genuine user message", turnId: grant.turnId });
      return false;
    }
    const anchor = this.branchUserAfterBase(input.branch, grant);
    if (!anchor) {
      this.changed({ type: "turn_close_unverified", reason: "branch anchor is ambiguous", turnId: grant.turnId });
      return false;
    }
    if (grant.anchorMessageId !== null && anchor.entry.id !== grant.anchorMessageId) {
      this.changed({ type: "turn_close_unverified", reason: "branch anchor differs from the grant's resolved message", turnId: grant.turnId });
      return false;
    }
    if (evidence.id !== null) {
      if (anchor.entry.id !== evidence.id) {
        this.changed({ type: "turn_close_unverified", reason: "agent_end user message id does not match the branch anchor", turnId: grant.turnId });
        return false;
      }
    } else if (evidence.timestamp !== null) {
      // OMP 18.18 agent_end user messages carry no id; the host timestamp is
      // then the only correlation evidence. A timestamp is not identity: it is
      // accepted only when it identifies exactly one genuine user entry in the
      // branch and that entry is this grant's expected anchor. Two same-text
      // messages in the same millisecond are ambiguous and close nothing.
      const matching = parseBranch(input.branch).filter((entry) =>
        genuineUserText(entry) !== undefined && branchUserTimestamp(entry) === evidence.timestamp);
      if (matching.length !== 1 || matching[0]!.id !== anchor.entry.id) {
        this.changed({
          type: "turn_close_unverified",
          reason: matching.length > 1
            ? "agent_end timestamp is ambiguous in the branch"
            : matching.length === 0
              ? "agent_end timestamp does not identify a branch user message"
              : "agent_end timestamp identifies a different branch user message",
          turnId: grant.turnId,
        });
        return false;
      }
      this.changed({ type: "turn_close_correlated_by_timestamp", turnId: grant.turnId, messageId: anchor.entry.id });
    } else {
      this.changed({ type: "turn_close_unverified", reason: "agent_end user message has neither a matching host id nor timestamp", turnId: grant.turnId });
      return false;
    }
    if (evidence.text.trim() !== grant.text.trim() || anchor.text.trim() !== grant.text.trim()) {
      this.changed({ type: "turn_close_unverified", reason: "user text changed since observation", turnId: grant.turnId });
      return false;
    }
    this.grant = undefined;
    this.rememberClosedInput(this.inputKey(grant.sessionId, grant.baseLeafId, grant.text));
    this.changed({ type: "task_grant_closed", reason: "agent turn ended", turnId: grant.turnId, sessionId: grant.sessionId, messageId: anchor.entry.id });
    return true;
  }

  private resetTurnState(sessionId?: string): void {
    if (!this.grant && !this.suspended && this.closedInputs.size === 0) return;
    this.grant = undefined;
    this.suspended = undefined;
    this.closedInputs.clear();
    this.changed({ type: "task_owner_turn_state_reset", ...(sessionId === undefined ? {} : { sessionId }) });
  }

  /** Soft turn-state reset; it does not detach an established task. */
  sessionChanged(sessionId?: string): void {
    this.invalidateAcceptanceReservation("session changed");
    this.resetTurnState(sessionId);
  }

  /**
   * Real session_start. Same-session startup only resets turn state; a start
   * bound to a different session detaches mutations and admissions when an
   * established managed task exists. A turn grant is observation state, not
   * an execution binding: without a managed task it is cleared and the fresh
   * owner remains able to create its first task.
   */
  sessionStarted(sessionId?: string): void {
    this.invalidateAcceptanceReservation("session started");
    const previous = this.grant?.sessionId ?? this.task?.anchor.sessionId ?? this.lastSessionId;
    const hadManagedTask = this.task !== undefined;
    const changedSession = sessionId !== undefined && previous !== undefined && sessionId !== previous;
    this.resetTurnState(sessionId);
    if (changedSession && hadManagedTask) {
      this.detachBinding("session_start selected a different session", "session_start", sessionId ?? null);
      return;
    }
    this.changed({ type: "task_session_started", sessionId: sessionId ?? null });
  }

  /**
   * Actual session_switch/session_branch/session_tree navigation invalidates
   * the execution binding and clears live grants. No text, summary or
   * navigation back restores it; there is no transfer/recovery API. Only an
   * established managed task has a binding to detach; a pending or started
   * turn observation belongs to no task and is merely reset.
   */
  navigate(event: "session_switch" | "session_branch" | "session_tree", sessionId?: string): void {
    this.invalidateAcceptanceReservation(`conversation navigation (${event})`);
    const hadManagedTask = this.task !== undefined;
    this.resetTurnState(sessionId);
    if (hadManagedTask) {
      this.detachBinding(
        `conversation navigation (${event}) invalidated the execution binding`,
        event,
        sessionId ?? null,
      );
      return;
    }
    this.changed({ type: "task_navigation_without_binding", event, sessionId: sessionId ?? null });
  }

  private detachBinding(reason: string, event: string, sessionId: string | null): void {
    if (this.detached) return;
    this.detached = { reason, event, sessionId, since: this.now() };
    this.changed({ type: "task_binding_detached", reason, event, sessionId });
  }

  private branchUserAfterBase(branch: readonly unknown[], grant: UserTurnGrant): { entry: BranchEntry; text: string } | undefined {
    const entries = parseBranch(branch);
    const baseIndex = entries.findIndex((entry) => entry.id === grant.baseLeafId);
    if (baseIndex < 0) return undefined;
    const users: Array<{ entry: BranchEntry; text: string }> = [];
    for (const entry of entries.slice(baseIndex + 1)) {
      const userText = genuineUserText(entry);
      if (userText !== undefined) users.push({ entry, text: userText });
    }
    if (users.length !== 1) return undefined;
    return users[0];
  }

  /**
   * Re-resolve authority at every control entry from the current trusted
   * branch. Any custom message that is not a host-owned control artifact after
   * the observation leaf closes the authority-to-create/change window, even
   * inside one OMP run (background follow-ups do not emit before_agent_start).
   * Task-bound capability continuation does not use this path.
   *
   * This resolver is pure for a legal window: it returns a candidate anchor
   * and never writes the live grant. Capacity, target or preflight failures
   * must leave the observed grant exactly as it was. A genuine invalidated
   * authority window still closes deliberately below.
   */
  private resolveAuthorityCandidate(subject: TaskSubject, grant: UserTurnGrant): TaskAnchor {
    const entries = parseBranch(subject.branch);
    const baseIndex = entries.findIndex((entry) => entry.id === grant.baseLeafId);
    if (baseIndex < 0) {
      throw new TaskOwnerError("The user message anchor is not present in the current conversation branch.");
    }
    const users: Array<{ entry: BranchEntry; text: string }> = [];
    const blocking: string[] = [];
    for (const entry of entries.slice(baseIndex + 1)) {
      const userText = genuineUserText(entry);
      if (userText !== undefined) {
        users.push({ entry, text: userText });
        continue;
      }
      if (entry.type === "custom_message") {
        const customType = typeof entry.value.customType === "string" ? entry.value.customType : "(missing)";
        if (!this.trustedControlTypes.has(customType)) blocking.push(`custom:${customType}`);
      } else if (entry.type === "message") {
        const message = entry.value.message;
        const role = typeof message === "object" && message !== null && !Array.isArray(message)
          ? (message as Record<string, unknown>).role
          : undefined;
        if (role === "user") blocking.push("user-message");
      }
    }
    if (users.length === 0) throw new TaskOwnerError("No genuine user message exists after the observed input anchor.");
    if (users.length > 1) {
      this.suspend("unsupported overlapping user turns", {
        type: "task_owner_overlap_rejected",
        sessionId: subject.sessionId,
        anchorCount: users.length,
      });
      throw new TaskOwnerError("Multiple user messages belong to this turn; overlapping turns are unsupported in B1.");
    }
    const anchor = users[0]!;
    if (anchor.text.trim() !== grant.text.trim()) {
      throw new TaskOwnerError("The branch user message does not match the host-observed input; refusing to rebind.");
    }
    if (blocking.length) {
      grant.authorityClosed = true;
      this.grant = undefined;
      this.rememberClosedInput(this.inputKey(grant.sessionId, grant.baseLeafId, grant.text));
      this.changed({
        type: "task_authority_closed",
        sessionId: subject.sessionId,
        turnId: grant.turnId,
        messageId: anchor.entry.id,
        blockers: blocking.slice(0, 8),
      });
      throw new TaskOwnerError(
        `The user authority window was closed by a non-user control message (${blocking.slice(0, 4).join(", ")}); a background or custom trigger cannot start or change a task.`,
      );
    }
    return {
      sessionId: grant.sessionId,
      messageId: anchor.entry.id,
      source: grant.source,
      observedText: grant.text,
      anchorText: anchor.text,
      observedAt: grant.observedAt,
    };
  }

  private assertSubject(subject: TaskSubject): void {
    identifier(subject.sessionId, "sessionId");
    if (subject.workspaceRoot !== this.workspaceRoot) {
      throw new TaskOwnerError("Session workspace does not match the task owner workspace.");
    }
  }

  private assertTaskReachable(subject: TaskSubject, task: ManagedTask): void {
    if (subject.sessionId !== task.anchor.sessionId) {
      throw new TaskOwnerError("Task belongs to a different OMP session; B1 will not rebind it.");
    }
    const entries = parseBranch(subject.branch);
    if (!entries.some((entry) => entry.id === task.anchor.messageId)) {
      throw new TaskOwnerError("Task anchor is not in the current conversation branch; B1 will not assume execution rights.");
    }
  }

  /** Compare the caller's immutable selector before any state, budget or process change. */
  private assertTaskGuard(expected: TaskGuard, task: ManagedTask): void {
    if (expected.taskId !== task.taskId) {
      throw new TaskOwnerError(
        `expectedTaskId does not match the current task (${task.taskId} at taskRevision ${task.taskRevision}); no task state changed.`,
      );
    }
    if (expected.taskRevision !== task.taskRevision) {
      throw new TaskOwnerError(
        `stale expectedTaskRevision ${expected.taskRevision}; the current task is at ${task.taskRevision}. No task state changed.`,
      );
    }
  }

  /** Read-only visibility for retained target facts. */
  private taskVisible(subject: TaskSubject, task: ManagedTask): boolean {
    if (task.anchor.sessionId !== subject.sessionId) return false;
    if (this.detached) return true;
    return parseBranch(subject.branch).some((entry) => entry.id === task.anchor.messageId);
  }

  /**
   * Synchronous acceptance reservation. It blocks new admissions but does not
   * change task status and never suppresses real user cancellation, revision
   * or navigation. Only an exact owner/task/revision/requirements binding is
   * reserved, and the opaque token is instance-bound.
   */
  reserveAcceptance(subject: TaskSubject, expected: FrozenTaskRef): AcceptanceReservationToken {
    this.assertSubject(subject);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may reserve task acceptance.");
    this.assertAttached("Task acceptance");
    if (this.suspended) throw new TaskOwnerError(`Task acceptance is unavailable: ${this.suspended.reason}.`);
    if (this.acceptanceHazard) throw new TaskOwnerError(`Task acceptance outcome is unknown: ${this.acceptanceHazard.reason}.`);
    if (this.acceptanceReservation) throw new TaskOwnerError("Another acceptance reservation is active.");
    const task = this.task;
    if (!task) throw new TaskOwnerError("No managed task exists for this owner.");
    if (task.status !== "active") throw new TaskOwnerError(`The task status is ${task.status}; only an active task may reserve acceptance.`);
    if (task.acceptance !== null) throw new TaskOwnerError("The task already has an acceptance reference.");
    this.assertTaskReachable(subject, task);
    const frozen = frozenOf(task);
    if (!sameFrozen(frozen, expected)) {
      throw new TaskOwnerError("The acceptance reservation does not match the current owner task identity.");
    }
    const token = Object.freeze({});
    const state: AcceptanceReservationState = {
      token,
      task: { ...frozen },
      epoch: this.acceptanceEpoch,
      released: false,
      committed: false,
    };
    this.acceptanceTokens.set(token, state);
    this.acceptanceReservation = state;
    return token;
  }

  /** Pure synchronous reservation check; no host callback is invoked. */
  reservationCurrent(token: AcceptanceReservationToken): boolean {
    const state = typeof token === "object" && token !== null
      ? this.acceptanceTokens.get(token)
      : undefined;
    if (state === undefined
      || state.token !== token
      || state.released
      || state.committed
      || state.epoch !== this.acceptanceEpoch
      || this.acceptanceReservation !== state
      || this.acceptanceHazard !== undefined
      || this.detached !== undefined
      || this.suspended !== undefined) {
      return false;
    }
    const task = this.task;
    return task !== undefined
      && task.status === "active"
      && task.acceptance === null
      && sameFrozen(frozenOf(task), state.task);
  }

  /** Release only this caller's current reservation; stale tokens are no-ops. */
  releaseAcceptance(token: AcceptanceReservationToken): void {
    const state = typeof token === "object" && token !== null
      ? this.acceptanceTokens.get(token)
      : undefined;
    if (state === undefined || state.committed) return;
    if (this.acceptanceReservation !== state) return;
    state.released = true;
    this.acceptanceReservation = undefined;
  }

  private invalidateAcceptanceReservation(reason: string): void {
    const state = this.acceptanceReservation;
    if (state === undefined) return;
    state.released = true;
    this.acceptanceReservation = undefined;
    this.acceptanceEpoch += 1;
    this.acceptanceHazard = undefined;
    void reason;
  }

  /**
   * Final synchronous acceptance commit. The prepared record has already been
   * bounded and sealed by the host store; this method only rechecks its own
   * pure reservation/task identity, calls the fixed built-in install primitive,
   * and sets the accepted terminal fact before any notification.
   */
  commitAccepted(token: AcceptanceReservationToken, preparedRecord: object): AcceptanceCommitResult {
    const state = typeof token === "object" && token !== null
      ? this.acceptanceTokens.get(token)
      : undefined;
    if (state === undefined || !this.reservationCurrent(token)) {
      return {
        status: "not_installed",
        reason: "The acceptance reservation is stale, released or belongs to another operation.",
        warnings: [],
        acceptance: null,
        operationCommitted: false,
      };
    }
    const binding = this.recordStore.binding(preparedRecord);
    if (!sameFrozen(binding.task, state.task)) {
      throw new TaskOwnerError("The prepared acceptance record belongs to a different task identity.");
    }
    const install = installPreparedAcceptanceRecordSync(preparedRecord);
    if (install.status === "unknown") {
      state.released = true;
      this.acceptanceReservation = undefined;
      this.acceptanceEpoch += 1;
      this.acceptanceHazard = {
        task: { ...binding.task },
        reason: boundedHazardReason(install.reason ?? "the acceptance record installation could not be classified"),
        acceptanceId: binding.acceptanceId,
        deliveryId: binding.deliveryId,
        recordDigest: binding.recordDigest,
      };
      return {
        status: "unknown",
        reason: install.reason,
        warnings: [...install.warnings],
        acceptance: null,
        operationCommitted: null,
      };
    }
    if (install.status !== "installed") {
      return {
        status: install.status,
        reason: install.reason,
        warnings: [...install.warnings],
        acceptance: null,
        operationCommitted: false,
      };
    }
    const acceptance: AcceptanceReference = {
      acceptanceId: binding.acceptanceId,
      deliveryId: binding.deliveryId,
      recordDigest: binding.recordDigest,
      acceptedAt: binding.acceptedAt,
    };
    const task = this.task;
    if (!task) throw new TaskOwnerError("The owner task disappeared during acceptance installation.");
    state.committed = true;
    state.released = true;
    this.acceptanceReservation = undefined;
    this.acceptanceEpoch += 1;
    // The fixed record installation succeeded: this is an irreversible commit
    // fact. Set the terminal task state before notifications or diagnostics.
    task.status = "accepted";
    task.acceptance = acceptance;
    this.tasks.set(task.taskId, task);
    this.stateEpoch += 1;
    const warnings = [...install.warnings];
    // Only now may postcommit cleanup/fsync run. Their failure is a warning,
    // never a rollback or a different installation fact.
    try {
      warnings.push(...maintainInstalledAcceptanceRecordSync(preparedRecord));
    } catch (error) {
      warnings.push(`postcommit_maintenance_failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      this.changed({
        type: "task_accepted",
        taskId: task.taskId,
        ownerId: task.ownerId,
        taskRevision: task.taskRevision,
        acceptanceId: acceptance.acceptanceId,
        deliveryId: acceptance.deliveryId,
        recordDigest: acceptance.recordDigest,
        acceptedAt: acceptance.acceptedAt,
      });
    } catch (error) {
      warnings.push(`postcommit_notification_failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      status: "installed",
      reason: null,
      warnings,
      acceptance: { ...acceptance },
      operationCommitted: true,
    };
  }

  /** Read-only accepted terminal fact; never uses active-only verification. */
  acceptedReference(taskId: string): AcceptanceReference | null {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "accepted" || task.acceptance === null) return null;
    return { ...task.acceptance };
  }

  start(
    subject: TaskSubject,
    understanding?: string,
    validateCandidate?: (candidate: ManagedTask) => void,
  ): TaskStartResult {
    this.assertSubject(subject);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may start a managed task.");
    this.assertAttached("Task start");
    if (this.suspended) throw new TaskOwnerError(`Task start is unavailable: ${this.suspended.reason}.`);
    if (this.acceptanceHazard) {
      throw new TaskOwnerError("A previous acceptance installation outcome is unknown; a new task cannot be started while unresolved responsibility exists.");
    }
    if (this.acceptanceReservation) {
      throw new TaskOwnerError("An acceptance reservation is active; a new task cannot be started until it is released.");
    }
    const grant = this.grant;
    if (!grant || !grant.started) {
      throw new TaskOwnerError("No live genuine user turn authorizes starting a task.");
    }
    if (grant.sessionId !== subject.sessionId) {
      throw new TaskOwnerError("The live user turn belongs to another session.");
    }
    const anchor = this.resolveAuthorityCandidate(subject, grant);
    const anchorKey = messageKey(anchor.sessionId, anchor.messageId);
    // Replaying the same genuine message returns the task that message
    // created, even when it is now retained history. It never binds the
    // replay to whatever task is current later.
    const recordedAnchor = this.anchorIndex.get(anchorKey);
    if (recordedAnchor) {
      const original = this.tasks.get(recordedAnchor.taskId);
      if (!original) throw new TaskOwnerError("The recorded task anchor is no longer retained; refusing to reinterpret it as a new task.");
      this.changed({
        type: "task_duplicate_start",
        taskId: original.taskId,
        taskRevision: original.taskRevision,
        messageId: anchor.messageId,
        status: original.status,
        historical: original !== this.task,
      });
      return { created: false, task: copyTask(original), historical: original !== this.task };
    }
    // A message already consumed to revise or cancel a task is never
    // repurposed into a new task, even inside the same live turn.
    for (const action of ["revise", "cancel"] as const) {
      if (this.controlIndex.has(controlKey(anchor.sessionId, anchor.messageId, action))) {
        throw new TaskOwnerError(`This user message was already consumed to ${action} a task and cannot create a new task.`);
      }
    }
    const previous = this.task;
    if (previous && previous.status === "active") {
      throw new TaskOwnerError("The current task is still active; inspect, revise or cancel it before starting another task. An active task is never replaced implicitly.");
    }
    if (this.tasks.size >= TASK_HISTORY_LIMIT) {
      throw new TaskOwnerError(`Task retention is full (${TASK_HISTORY_LIMIT} retained tasks including the current task); no old task or anchor was evicted, and no new task was created.`);
    }
    if (this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError(`Task replay capacity is full (${TASK_REPLAY_ENTRY_LIMIT} anchor/control entries); no old replay entry was evicted, and no new task was created.`);
    }
    const taskId = identifier(`task-${this.newId()}`, "taskId");
    // A host id generator may repeat. Retained history is never overwritten:
    // reject the candidate before building or committing anything.
    if (this.tasks.has(taskId)) {
      throw new TaskOwnerError("The host-generated taskId is already retained; no existing task, anchor or history was replaced.");
    }
    const createdAt = this.now();
    const original: RequirementSource = {
      revision: TASK_REVISION_START,
      kind: "original",
      messageId: anchor.messageId,
      sessionId: anchor.sessionId,
      source: anchor.source,
      text: grant.text,
      observedAt: anchor.observedAt,
      committedAt: createdAt,
      previousRevision: null,
    };
    const requirementSources = [original];
    const understandingRevision = understanding === undefined ? null : TASK_REVISION_START;
    const projection = requirementProjection({
      taskId,
      ownerId: this.ownerId,
      taskRevision: TASK_REVISION_START,
      sources: requirementSources,
      understanding: understanding === undefined
        ? null
        : { text: understanding, revision: TASK_REVISION_START, stale: false },
    });
    assertRequirementCommitBounds({ sources: requirementSources, projection });
    const task: ManagedTask = {
      schemaVersion: TASK_OWNER_SCHEMA_VERSION,
      taskId,
      ownerId: this.ownerId,
      taskRevision: TASK_REVISION_START,
      status: "active",
      rawRequest: grant.text,
      anchor,
      requirementSources,
      understanding: understanding ?? null,
      understandingRevision,
      understandingStale: false,
      createdAt,
      cancelledAt: null,
      acceptance: null,
      admissions: 0,
    };
    // Transactional preflight: complete response/history work (the caller's
    // builder) before any owner state changes. A reentrant callback that
    // mutates this owner invalidates the candidate via the epoch check.
    const epoch = this.stateEpoch;
    const currentBefore = this.task;
    validateCandidate?.(task);
    this.assertFinalStartState(currentBefore, grant, anchorKey, epoch, task.taskId);
    // Commit the new current task, its replay index and the resolved anchor
    // without any external call between these assignments. The previous
    // terminal task stays immutable and retained.
    grant.anchorMessageId = anchor.messageId;
    this.tasks.set(task.taskId, task);
    this.anchorIndex.set(anchorKey, { taskId: task.taskId });
    this.task = task;
    this.tasksCreated += 1;
    this.stateEpoch += 1;
    this.changed({
      type: "task_started",
      taskId: task.taskId,
      ownerId: task.ownerId,
      taskRevision: task.taskRevision,
      messageId: task.anchor.messageId,
      sessionId: task.anchor.sessionId,
      source: task.anchor.source,
      ...(previous === undefined ? {} : { previousTaskId: previous.taskId, previousStatus: previous.status }),
    });
    return { created: true, task: copyTask(task), historical: false };
  }

  /** Pure final check immediately before a new-task commit. */
  private assertFinalStartState(
    currentBefore: ManagedTask | undefined,
    grantBefore: UserTurnGrant,
    anchorKey: string,
    epoch: number,
    taskId: string,
  ): void {
    if (this.detached) throw new TaskOwnerError("The conversation binding detached during preflight; no task was created.");
    if (this.suspended) throw new TaskOwnerError(`Task start became unavailable during preflight: ${this.suspended.reason}.`);
    if (this.acceptanceHazard) throw new TaskOwnerError("An unknown acceptance installation appeared during preflight; no task was created.");
    if (this.task !== currentBefore) throw new TaskOwnerError("The current task changed during preflight; no task was created.");
    if (this.grant !== grantBefore || !grantBefore.started) {
      throw new TaskOwnerError("The authorizing user turn changed during preflight; no task was created.");
    }
    if (this.anchorIndex.has(anchorKey)) throw new TaskOwnerError("This user message anchor was claimed during preflight; no task was created.");
    if (this.tasks.has(taskId)) throw new TaskOwnerError("The host-generated taskId was retained during preflight; no task was created.");
    if (this.tasks.size >= TASK_HISTORY_LIMIT || this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError("Task retention reached capacity during preflight; no task was created.");
    }
    if (this.stateEpoch !== epoch) throw new TaskOwnerError("Owner state changed during preflight; no task was created.");
  }

  /**
   * Accept a genuine user requirement amendment. The current task must be
   * targeted by the immutable expectedTaskId + expectedTaskRevision selector
   * captured from host-visible facts. Bounds and replay capacity are checked
   * on the candidate before any task field changes.
   */
  revise(
    subject: TaskSubject,
    expected: TaskGuard,
    understanding?: string,
    validateCandidate?: (candidate: ManagedTask) => void,
  ): TaskRevisionResult {
    this.assertSubject(subject);
    const target = taskSelector(expected);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may revise a managed task.");
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    this.assertTaskGuard(target, this.task);
    this.assertAttached("Task revision");
    if (this.suspended) throw new TaskOwnerError(`Task revision is unavailable: ${this.suspended.reason}.`);
    if (this.acceptanceHazard) {
      throw new TaskOwnerError("Task acceptance installation outcome is unknown; revision cannot rewrite a possibly accepted task.");
    }
    if (this.task.status === "accepted") throw new TaskOwnerError("An accepted task is terminal and cannot be revised.");
    if (this.task.status !== "active") throw new TaskOwnerError("A cancelled task cannot be revised.");
    const task = this.task;
    // Independent of any navigation hook: the creation session and anchor
    // must still be reachable on the actual current branch.
    this.assertTaskReachable(subject, task);
    const grant = this.grant;
    if (!grant || !grant.started || grant.sessionId !== subject.sessionId) {
      throw new TaskOwnerError("No live genuine user turn authorizes revising the task.");
    }
    // Current-branch proof: the amendment text comes from the actual branch
    // user entry, never from model parameters, and background/custom messages
    // after this grant's anchor close the window.
    const anchor = this.resolveAuthorityCandidate(subject, grant);
    if (anchor.messageId === task.anchor.messageId) {
      throw new TaskOwnerError("The task creation message cannot also be accepted as a requirement amendment.");
    }
    const createdBy = this.anchorIndex.get(messageKey(anchor.sessionId, anchor.messageId));
    if (createdBy && createdBy.taskId !== task.taskId) {
      throw new TaskOwnerError("This user message created a different task and cannot amend the current task.");
    }
    if (this.controlIndex.has(controlKey(anchor.sessionId, anchor.messageId, "cancel"))) {
      throw new TaskOwnerError("This user message was already consumed to cancel a task and cannot revise another task.");
    }
    const existingControl = this.controlIndex.get(controlKey(anchor.sessionId, anchor.messageId, "revise"));
    if (existingControl && existingControl.taskId !== task.taskId) {
      throw new TaskOwnerError("This user message already amended a different task and cannot amend the current task.");
    }
    if (hasRequirementSource(task.requirementSources, anchor.messageId)) {
      this.changed({ type: "task_revision_duplicate", taskId: task.taskId, messageId: anchor.messageId, taskRevision: task.taskRevision });
      return { revised: false, task: copyTask(task) };
    }
    if (existingControl) {
      throw new TaskOwnerError("The recorded revision replay is inconsistent with the current requirement ledger; refusing to commit.");
    }
    if (grant.baselineTaskId !== task.taskId || !revisionBaselineMatches(grant.baselineTaskRevision, task.taskRevision)) {
      throw new TaskOwnerError(
        `Stale requirement baseline: this input was observed against ${grant.baselineTaskId ?? "no task"} at taskRevision ${String(grant.baselineTaskRevision)}, but the owner is at ${task.taskId} taskRevision ${task.taskRevision}; the amendment was not committed.`,
      );
    }
    const revisionKey = controlKey(anchor.sessionId, anchor.messageId, "revise");
    if (this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError(`Task replay capacity is full (${TASK_REPLAY_ENTRY_LIMIT} anchor/control entries); no old entry was evicted and the amendment was not committed.`);
    }
    const nextRevision = task.taskRevision + 1;
    const committedAt = this.now();
    const amendment: RequirementSource = {
      revision: nextRevision,
      kind: "amendment",
      messageId: anchor.messageId,
      sessionId: anchor.sessionId,
      source: anchor.source,
      text: grant.text,
      observedAt: anchor.observedAt,
      committedAt,
      previousRevision: task.taskRevision,
    };
    const sources = [...task.requirementSources, amendment];
    const nextUnderstanding = understanding !== undefined
      ? { text: understanding, revision: nextRevision, stale: false }
      : task.understanding === null
        ? null
        : { text: task.understanding, revision: task.understandingRevision, stale: true };
    const projection = requirementProjection({
      taskId: task.taskId,
      ownerId: task.ownerId,
      taskRevision: nextRevision,
      sources,
      understanding: nextUnderstanding,
    });
    const candidate: ManagedTask = {
      ...task,
      taskRevision: nextRevision,
      requirementSources: sources,
      understanding: understanding !== undefined ? understanding : task.understanding,
      understandingRevision: understanding !== undefined ? nextRevision : task.understandingRevision,
      understandingStale: understanding !== undefined ? false : task.understanding !== null,
    };
    assertRequirementCommitBounds({ sources, projection });
    // Transactional preflight: validate the exact response built from the
    // candidate before this owner accepts the new revision. A reentrant
    // callback that changes the task, grant or epoch aborts the commit.
    const epoch = this.stateEpoch;
    validateCandidate?.(candidate);
    if (this.detached) throw new TaskOwnerError("The conversation binding detached during preflight; the amendment was not committed.");
    if (this.suspended) throw new TaskOwnerError("Task revision became suspended during preflight; the amendment was not committed.");
    if (this.acceptanceHazard) throw new TaskOwnerError("An unknown acceptance installation appeared during preflight; the amendment was not committed.");
    if (this.task !== task || task.taskRevision !== expected.taskRevision) {
      throw new TaskOwnerError("The current task changed during preflight; the amendment was not committed.");
    }
    if (this.grant !== grant || !grant.started) {
      throw new TaskOwnerError("The authorizing user turn changed during preflight; the amendment was not committed.");
    }
    if (this.controlIndex.has(revisionKey)) {
      throw new TaskOwnerError("This amendment was recorded concurrently during preflight; the commit was abandoned.");
    }
    if (this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError("Task replay capacity was reached during preflight; the amendment was not committed.");
    }
    if (this.stateEpoch !== epoch) throw new TaskOwnerError("Owner state changed during preflight; the amendment was not committed.");
    grant.anchorMessageId = anchor.messageId;
    this.invalidateAcceptanceReservation("task revision committed");
    this.task = candidate;
    this.tasks.set(candidate.taskId, candidate);
    this.controlIndex.set(revisionKey, { taskId: candidate.taskId, action: "revise" });
    this.stateEpoch += 1;
    this.changed({
      type: "task_revised",
      taskId: candidate.taskId,
      messageId: anchor.messageId,
      previousRevision: amendment.previousRevision,
      taskRevision: nextRevision,
      source: amendment.source,
      sessionId: amendment.sessionId,
      understandingSupplied: understanding !== undefined,
    });
    return { revised: true, task: copyTask(candidate) };
  }

  /** Read-only current requirements projection; never changes authority. */
  requirements(): RequirementsProjection {
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    return requirementProjection({
      taskId: this.task.taskId,
      ownerId: this.task.ownerId,
      taskRevision: this.task.taskRevision,
      sources: this.task.requirementSources,
      understanding: this.task.understanding === null
        ? null
        : {
          text: this.task.understanding,
          revision: this.task.understandingRevision,
          stale: this.task.understandingStale,
        },
    });
  }

  inspect(subject: TaskSubject): ManagedTask {
    this.assertSubject(subject);
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    // Detached history inspection is explicit and read-only; it deliberately
    // does not require the anchor on the current branch.
    if (!this.detached) this.assertTaskReachable(subject, this.task);
    this.changed({
      type: "task_inspected",
      taskId: this.task.taskId,
      taskRevision: this.task.taskRevision,
      binding: this.detached ? "detached" : "attached",
    });
    return copyTask(this.task);
  }

  /**
   * Explicit read-only target inspection. The selector must match the retained
   * task's actual identity; it cannot promote old history to current, register
   * candidates, or redirect the current pointer.
   */
  inspectTarget(subject: TaskSubject, expected: TaskGuard): { target: ManagedTask; historical: boolean } {
    this.assertSubject(subject);
    const selector = taskSelector(expected);
    const target = this.tasks.get(selector.taskId);
    if (!target) throw new TaskOwnerError("No retained task matches expectedTaskId; no history was disclosed.");
    if (target.taskRevision !== selector.taskRevision) {
      throw new TaskOwnerError(`stale expectedTaskRevision ${selector.taskRevision}; the retained task is at ${target.taskRevision}. No history was disclosed.`);
    }
    if (!this.taskVisible(subject, target)) {
      throw new TaskOwnerError("The requested task is not visible in this workspace, session and branch; no history was disclosed.");
    }
    if (!this.detached && target !== this.task) {
      const entries = parseBranch(subject.branch);
      if (!entries.some((entry) => entry.id === target.anchor.messageId)) {
        throw new TaskOwnerError("The requested task anchor is not visible on the current conversation branch.");
      }
    }
    const historical = target !== this.task;
    this.changed({
      type: historical ? "task_history_inspected" : "task_inspected",
      taskId: target.taskId,
      taskRevision: target.taskRevision,
      status: target.status,
      binding: this.detached ? "detached" : "attached",
    });
    return { target: copyTask(target), historical };
  }

  /**
   * Bounded read-only terminal history metadata for this owner/session.
   * Pagination is a display cursor only; it never changes the current task.
   */
  historyPage(subject: TaskSubject, cursor: number, limit: number): TaskHistoryPage {
    this.assertSubject(subject);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TaskOwnerError("history cursor must be a non-negative integer page offset.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TASK_HISTORY_PAGE_LIMIT) {
      throw new TaskOwnerError(`history limit must be an integer between 1 and ${TASK_HISTORY_PAGE_LIMIT}.`);
    }
    const visible = [...this.tasks.values()]
      .filter((task) => task.status !== "active" && this.taskVisible(subject, task))
      .reverse();
    if (cursor > visible.length) throw new TaskOwnerError("history cursor is outside the retained visible history.");
    const page = visible.slice(cursor, cursor + limit).map((task): TaskHistoryRow => {
      const row: TaskHistoryRow = {
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        status: task.status === "accepted" ? "accepted" : "cancelled",
        createdAt: task.createdAt,
        terminalAt: task.acceptance?.acceptedAt ?? task.cancelledAt,
        anchorMessageId: task.anchor.messageId,
        anchorSessionId: task.anchor.sessionId,
        anchorSource: task.anchor.source,
        sourceCount: task.requirementSources.length,
        amendmentCount: task.requirementSources.filter((source) => source.kind === "amendment").length,
        acceptanceId: task.acceptance?.acceptanceId ?? null,
        acceptanceInstallUnknown: this.acceptanceHazard?.task.taskId === task.taskId,
        current: task === this.task,
      };
      return row;
    });
    const nextCursor = cursor + page.length < visible.length ? cursor + page.length : null;
    this.changed({
      type: "task_history_read",
      cursor,
      limit,
      returned: page.length,
      total: visible.length,
    });
    return { rows: page, nextCursor, total: visible.length, retention: this.retentionFacts() };
  }

  cancel(subject: TaskSubject, expected: TaskGuard): ManagedTask {
    this.assertSubject(subject);
    const target = taskSelector(expected);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may cancel a managed task.");
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    this.assertTaskGuard(target, this.task);
    this.assertAttached("Task cancellation");
    if (this.suspended) throw new TaskOwnerError(`Task control is unavailable: ${this.suspended.reason}.`);
    if (this.acceptanceHazard) {
      throw new TaskOwnerError("Task acceptance installation outcome is unknown; cancellation cannot rewrite a possibly accepted task.");
    }
    if (this.task.status === "accepted") {
      throw new TaskOwnerError("An accepted task is terminal and cannot be cancelled.");
    }
    const task = this.task;
    this.assertTaskReachable(subject, task);
    const grant = this.grant;
    if (!grant || !grant.started || grant.sessionId !== subject.sessionId) {
      throw new TaskOwnerError("No live genuine user turn authorizes cancelling the task.");
    }
    // Task origin and current control authority are distinct: any later
    // genuine user turn in this authorized session/branch may control an
    // existing reachable task. The task's creation anchor stays immutable; the
    // current grant supplies only this control request's authority. Background
    // or custom messages after the current grant anchor still close the window.
    const anchor = this.resolveAuthorityCandidate(subject, grant);
    const createdBy = this.anchorIndex.get(messageKey(anchor.sessionId, anchor.messageId));
    if (createdBy && createdBy.taskId !== task.taskId) {
      throw new TaskOwnerError("This user message created a different task and cannot cancel the current task.");
    }
    const revisedBy = this.controlIndex.get(controlKey(anchor.sessionId, anchor.messageId, "revise"));
    if (revisedBy && revisedBy.taskId !== task.taskId) {
      throw new TaskOwnerError("This user message already amended a different task and cannot cancel the current task.");
    }
    const cancelKey = controlKey(anchor.sessionId, anchor.messageId, "cancel");
    const existingControl = this.controlIndex.get(cancelKey);
    if (existingControl && existingControl.taskId !== task.taskId) {
      throw new TaskOwnerError("This user message already cancelled a different task and cannot cancel the current task.");
    }
    if (task.status === "cancelled") {
      this.changed({ type: "task_cancel_duplicate", taskId: task.taskId, taskRevision: task.taskRevision });
      return copyTask(task);
    }
    if (!existingControl && this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError(`Task replay capacity is full (${TASK_REPLAY_ENTRY_LIMIT} anchor/control entries); no old entry was evicted and the task was not cancelled.`);
    }
    const epoch = this.stateEpoch;
    const grantBefore = this.grant;
    const cancelledAt = this.now();
    // `now` is host-owned and may reenter. Recheck purely before mutating.
    if (this.task !== task || this.stateEpoch !== epoch || this.grant !== grantBefore) {
      throw new TaskOwnerError("Owner state changed while preparing cancellation; the task was not cancelled.");
    }
    if (!existingControl && this.anchorIndex.size + this.controlIndex.size >= TASK_REPLAY_ENTRY_LIMIT) {
      throw new TaskOwnerError("Task replay capacity was reached while preparing cancellation; the task was not cancelled.");
    }
    grant.anchorMessageId = anchor.messageId;
    this.invalidateAcceptanceReservation("task cancellation committed");
    task.status = "cancelled";
    task.cancelledAt = cancelledAt;
    this.tasks.set(task.taskId, task);
    this.controlIndex.set(cancelKey, { taskId: task.taskId, action: "cancel" });
    this.stateEpoch += 1;
    this.changed({ type: "task_cancelled", taskId: task.taskId, taskRevision: task.taskRevision });
    return copyTask(task);
  }

  /**
   * The small current-task/admission port. It is deliberately not a capability
   * market: only host-authorized capability ids are accepted. The caller must
   * present the immutable expectedTaskId + expectedTaskRevision it actually
   * observed; a same revision under another task identity never matches.
   */
  admit(subject: TaskSubject, capabilityId: string, expected: TaskGuard): AdmissionDecision {
    const capability = identifier(capabilityId, "capabilityId");
    let selector: TaskGuard | null = null;
    let selectorError: string | null = null;
    try {
      selector = taskSelector(expected);
    } catch (error) {
      selector = null;
      selectorError = error instanceof Error ? error.message : String(error);
    }
    const deny = (reason: string, status: TaskStatus | null): AdmissionDecision => {
      // Freeze the facts before notification: a synchronous listener may
      // cancel this task or start another, but this result still describes
      // the admission decision that was actually made.
      const current = this.task;
      const facts = {
        taskId: current?.taskId ?? null,
        taskRevision: current?.taskRevision ?? null,
        anchorMessageId: current?.anchor.messageId ?? null,
        status,
      };
      this.changed({
        type: "capability_admission_denied",
        capabilityId: capability,
        reason,
        taskId: facts.taskId,
        expectedTaskId: selector?.taskId ?? null,
        expectedTaskRevision: selector?.taskRevision ?? null,
      });
      return {
        allowed: false,
        reason,
        taskId: facts.taskId,
        ownerId: this.ownerId,
        taskRevision: facts.taskRevision,
        expectedTaskId: selector?.taskId ?? null,
        expectedTaskRevision: selector?.taskRevision ?? null,
        anchorMessageId: facts.anchorMessageId,
        capabilityId: capability,
        actionIndex: null,
        status: facts.status,
      };
    };
    if (selector === null) {
      return deny(selectorError ?? "expectedTaskId and expectedTaskRevision must be a valid task selector", this.task?.status ?? null);
    }
    try {
      this.assertSubject(subject);
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error), this.task?.status ?? null);
    }
    if (!this.capabilities.has(capability)) return deny("capability is not authorized by the host", this.task?.status ?? null);
    if (this.detached) return deny(`conversation binding is detached: ${this.detached.reason}`, this.task?.status ?? null);
    if (this.suspended) return deny(`task admissions are suspended: ${this.suspended.reason}`, this.task?.status ?? null);
    const current = this.task;
    if (!current) return deny("no managed task exists", null);
    if (selector.taskId !== current.taskId) {
      return deny(
        `expectedTaskId ${selector.taskId} is not the current task (${current.taskId}); no admission occurred`,
        current.status,
      );
    }
    if (this.acceptanceHazard) {
      return deny("the acceptance commit outcome is unknown; no new side effect is admitted", current.status);
    }
    if (this.acceptanceReservation) {
      return deny("an acceptance reservation is active; no new side effect is admitted", current.status);
    }
    try {
      this.assertTaskReachable(subject, current);
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error), current.status);
    }
    if (current.status !== "active") {
      return deny(
        current.status === "accepted" ? "task is accepted and terminal" : "task is cancelled",
        current.status,
      );
    }
    // Optimistic, non-authoritative guard compared immediately before the
    // owned counter changes. The host mints the actual revision; the caller
    // cannot authorize or acquire a revision by naming it.
    if (selector.taskRevision !== current.taskRevision) {
      return deny(
        `stale expected taskRevision ${selector.taskRevision}; the owner is at ${current.taskRevision}`,
        current.status,
      );
    }
    const actionIndex = current.admissions + 1;
    const facts = {
      taskId: current.taskId,
      taskRevision: current.taskRevision,
      anchorMessageId: current.anchor.messageId,
      status: current.status,
    };
    current.admissions = actionIndex;
    this.stateEpoch += 1;
    // Notification may synchronously mutate this owner. Return only the
    // frozen admission facts for the task that was actually admitted.
    this.changed({
      type: "capability_admission_allowed",
      capabilityId: capability,
      taskId: facts.taskId,
      ownerId: this.ownerId,
      messageId: facts.anchorMessageId,
      taskRevision: facts.taskRevision,
      expectedTaskId: selector.taskId,
      expectedTaskRevision: selector.taskRevision,
      actionIndex,
    });
    // A synchronous notification may have cancelled/replaced the task or
    // detached the conversation. The count and allowed event stay committed,
    // but the capability must not act on a task that is no longer current.
    const retained = this.tasks.get(facts.taskId);
    const stillCurrent = this.task !== undefined
      && this.task.taskId === facts.taskId
      && this.task.taskRevision === facts.taskRevision
      && this.task.status === "active"
      && !this.detached
      && !this.suspended
      && this.acceptanceHazard === undefined
      && this.acceptanceReservation === undefined;
    let reachable = stillCurrent;
    if (reachable) {
      try {
        this.assertTaskReachable(subject, this.task!);
      } catch {
        reachable = false;
      }
    }
    if (!reachable) {
      const status = retained?.status ?? facts.status;
      this.changed({
        type: "capability_admission_revoked",
        capabilityId: capability,
        taskId: facts.taskId,
        taskRevision: facts.taskRevision,
        actionIndex,
        status,
      });
      return {
        allowed: false,
        reason: "the admitted task or conversation binding changed before the capability acted; the committed admission was revoked",
        taskId: facts.taskId,
        ownerId: this.ownerId,
        taskRevision: facts.taskRevision,
        expectedTaskId: selector.taskId,
        expectedTaskRevision: selector.taskRevision,
        anchorMessageId: facts.anchorMessageId,
        capabilityId: capability,
        actionIndex,
        status,
      };
    }
    return {
      allowed: true,
      reason: null,
      taskId: facts.taskId,
      ownerId: this.ownerId,
      taskRevision: facts.taskRevision,
      expectedTaskId: selector.taskId,
      expectedTaskRevision: selector.taskRevision,
      anchorMessageId: facts.anchorMessageId,
      capabilityId: capability,
      actionIndex,
      status: facts.status,
    };
  }
}
