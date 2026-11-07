import { randomUUID } from "node:crypto";

/**
 * Generic conversational task ownership for G1-B1.
 *
 * The owner only knows about host-observed user input, an actual conversation
 * branch anchor, a current task, and a small admission port. It has no domain
 * branches, planner, or run/call identifiers: those activities do not exist in
 * B1. All authority fields are generated or selected here, never accepted from
 * model arguments.
 */

export const TASK_OWNER_SCHEMA_VERSION = 1 as const;
export const TASK_REVISION = 1 as const;
export const TASK_CONTROL_ACTIONS = ["start", "inspect", "cancel"] as const;
export type TaskControlAction = (typeof TASK_CONTROL_ACTIONS)[number];
export type TaskStatus = "active" | "cancelled";
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
  taskRevision: typeof TASK_REVISION;
  status: TaskStatus;
  /** Immutable host-observed request. Model understanding never replaces it. */
  rawRequest: string;
  anchor: TaskAnchor;
  understanding: string | null;
  createdAt: string;
  cancelledAt: string | null;
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
  started: boolean;
  /** Branch entry id of the genuine user message once resolved. */
  anchorMessageId: string | null;
  /** Set when a non-user control message closed the authority window. */
  authorityClosed: boolean;
}

export interface TaskOwnerSnapshot {
  schemaVersion: typeof TASK_OWNER_SCHEMA_VERSION;
  ownerId: string;
  workspaceRoot: string;
  tasksCreated: number;
  currentTask: ManagedTask | null;
  activeGrant: UserTurnGrant | null;
  suspended: { reason: string } | null;
  authorizedCapabilities: string[];
}

export interface TaskStartResult {
  created: boolean;
  task: ManagedTask;
}

export interface AdmissionDecision {
  allowed: boolean;
  reason: string | null;
  taskId: string | null;
  ownerId: string;
  taskRevision: number | null;
  anchorMessageId: string | null;
  capabilityId: string;
  actionIndex: number | null;
  status: TaskStatus | null;
}

export interface TaskControlArguments {
  action: TaskControlAction;
  understanding?: string;
}

interface BranchEntry {
  id: string;
  parentId: string | null;
  type: string;
  value: Record<string, unknown>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_UNDERSTANDING = 4000;
const CONTROL_KEYS = new Set(["action", "understanding"]);
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

function parseBranch(branch: readonly unknown[]): BranchEntry[] {
  if (!Array.isArray(branch)) throw new TaskOwnerError("Task conversation branch must be an array.");
  const entries: BranchEntry[] = [];
  const seen = new Set<string>();
  for (const value of branch) {
    const entry = object(value, "Conversation branch entry");
    const id = identifier(entry.id, "Conversation branch entry id");
    if (seen.has(id)) throw new TaskOwnerError("Conversation branch contains duplicate entry ids.");
    seen.add(id);
    const parentId = entry.parentId;
    if (parentId !== null && typeof parentId !== "string") {
      throw new TaskOwnerError("Conversation branch entry parentId must be a string or null.");
    }
    entries.push({ id, parentId, type: typeof entry.type === "string" ? entry.type : "", value: entry });
  }
  return entries;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function genuineUserText(entry: BranchEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.value.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || record.synthetic === true || record.attribution !== "user") return undefined;
  const content = messageText(record);
  return content.trim() ? content : undefined;
}

/** Host message identity for agent_end correlation, when OMP supplies it. */
function lastGenuineUserMessageIdentity(messages: unknown): { id: string | null; timestamp: number | null; text: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" || record.synthetic === true || record.attribution !== "user") continue;
    const content = messageText(record);
    if (!content.trim()) continue;
    const candidate = record.id ?? record.messageId ?? record.messageID;
    return {
      id: typeof candidate === "string" && IDENTIFIER.test(candidate) ? candidate : null,
      timestamp: typeof record.timestamp === "number" && Number.isFinite(record.timestamp) ? record.timestamp : null,
      text: content,
    };
  }
  return undefined;
}

function branchUserTimestamp(entry: BranchEntry): number | null {
  const message = entry.value.message;
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    const value = (message as Record<string, unknown>).timestamp;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const value = entry.value.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function copyTask(task: ManagedTask): ManagedTask {
  return { ...task, anchor: { ...task.anchor } };
}

function copyGrant(grant: UserTurnGrant): UserTurnGrant {
  return { ...grant };
}

/**
 * Strict model-facing argument parser. Identity, permissions, source and
 * anchor fields are rejected explicitly even though the tool schema also
 * filters unknown properties before execution.
 */
export function parseTaskControlArguments(value: unknown): TaskControlArguments {
  const args = object(value, "Task control arguments");
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => MODEL_AUTHORITY_KEYS.has(key));
  if (forbidden.length) {
    throw new TaskOwnerError(
      `agent_task never accepts task authority from model parameters: ${forbidden.join(", ")}.`,
    );
  }
  const unknown = keys.filter((key) => !CONTROL_KEYS.has(key));
  if (unknown.length) throw new TaskOwnerError(`agent_task has unsupported field(s): ${unknown.join(", ")}.`);
  const action = args.action;
  if (typeof action !== "string" || !(TASK_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new TaskOwnerError("agent_task action must be start, inspect or cancel.");
  }
  if (args.understanding !== undefined && action !== "start") {
    throw new TaskOwnerError("Agent understanding may be supplied only when starting a task.");
  }
  if (args.understanding === undefined) return { action: action as TaskControlAction };
  const understanding = text(args.understanding, "Agent understanding", MAX_UNDERSTANDING).trim();
  return { action: action as TaskControlAction, understanding };
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
}

/**
 * Single authoritative owner. At most one current task exists in B1; a new
 * user message may inspect/cancel it when authorized, but cannot silently
 * adopt or re-anchor it.
 */
export class TaskOwner {
  readonly workspaceRoot: string;
  readonly ownerId: string;
  private readonly capabilities: Set<string>;
  private readonly trustedControlTypes: Set<string>;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly onStateChange: ((snapshot: TaskOwnerSnapshot) => void) | undefined;
  private readonly onEvent: ((event: Record<string, unknown> & { type: string }) => void) | undefined;
  private tasksCreated = 0;
  private task: ManagedTask | undefined;
  private grant: UserTurnGrant | undefined;
  private suspended: { reason: string } | undefined;
  private turnSequence = 0;
  private readonly closedInputs = new Set<string>();

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
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
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
      authorizedCapabilities: [...this.capabilities].sort(),
    };
  }

  private changed(event?: Record<string, unknown> & { type: string }): void {
    if (event && this.onEvent) this.onEvent({ ...event, ownerId: this.ownerId });
    this.onStateChange?.(this.snapshot());
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
    if (this.grant) {
      if (this.grant.sessionId === sessionId && this.grant.baseLeafId === baseLeafId && this.grant.text === raw) {
        return { accepted: false, duplicate: true, reason: null };
      }
      this.suspend("unsupported overlapping user turns", {
        type: "task_owner_overlap_rejected",
        sessionId,
        previousTurnId: this.grant.turnId,
      });
      return { accepted: false, duplicate: false, reason: "unsupported overlapping user turns" };
    }
    this.grant = {
      turnId: ++this.turnSequence,
      sessionId,
      workspaceRoot: input.workspaceRoot,
      source,
      text: raw,
      observedAt,
      baseLeafId,
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
      textLength: raw.length,
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

  /** Session/branch navigation invalidates any pending turn grant. */
  sessionChanged(sessionId?: string): void {
    if (!this.grant && !this.suspended && this.closedInputs.size === 0) return;
    this.grant = undefined;
    this.suspended = undefined;
    this.closedInputs.clear();
    this.changed({ type: "task_owner_turn_state_reset", ...(sessionId === undefined ? {} : { sessionId }) });
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
   */
  private resolveAuthority(subject: TaskSubject, grant: UserTurnGrant): TaskAnchor {
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
    grant.anchorMessageId = anchor.entry.id;
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

  start(subject: TaskSubject, understanding?: string): TaskStartResult {
    this.assertSubject(subject);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may start a managed task.");
    if (this.suspended) throw new TaskOwnerError(`Task start is unavailable: ${this.suspended.reason}.`);
    const grant = this.grant;
    if (!grant || !grant.started) {
      throw new TaskOwnerError("No live genuine user turn authorizes starting a task.");
    }
    if (grant.sessionId !== subject.sessionId) {
      throw new TaskOwnerError("The live user turn belongs to another session.");
    }
    const anchor = this.resolveAuthority(subject, grant);
    if (this.task) {
      if (this.task.anchor.messageId === anchor.messageId) {
        this.changed({ type: "task_duplicate_start", taskId: this.task.taskId, messageId: anchor.messageId });
        return { created: false, task: copyTask(this.task) };
      }
      throw new TaskOwnerError("A task already belongs to a different user message; B1 does not merge or rebind tasks.");
    }
    const task: ManagedTask = {
      schemaVersion: TASK_OWNER_SCHEMA_VERSION,
      taskId: identifier(`task-${this.newId()}`, "taskId"),
      ownerId: this.ownerId,
      taskRevision: TASK_REVISION,
      status: "active",
      rawRequest: grant.text,
      anchor,
      understanding: understanding ?? null,
      createdAt: this.now(),
      cancelledAt: null,
      admissions: 0,
    };
    this.task = task;
    this.tasksCreated += 1;
    this.changed({
      type: "task_started",
      taskId: task.taskId,
      ownerId: task.ownerId,
      messageId: task.anchor.messageId,
      sessionId: task.anchor.sessionId,
      source: task.anchor.source,
    });
    return { created: true, task: copyTask(task) };
  }

  inspect(subject: TaskSubject): ManagedTask {
    this.assertSubject(subject);
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    this.assertTaskReachable(subject, this.task);
    this.changed({ type: "task_inspected", taskId: this.task.taskId });
    return copyTask(this.task);
  }

  cancel(subject: TaskSubject): ManagedTask {
    this.assertSubject(subject);
    if (subject.agentKind !== "main") throw new TaskOwnerError("Only the main OMP session may cancel a managed task.");
    if (this.suspended) throw new TaskOwnerError(`Task control is unavailable: ${this.suspended.reason}.`);
    if (!this.task) throw new TaskOwnerError("No managed task exists for this owner.");
    this.assertTaskReachable(subject, this.task);
    const grant = this.grant;
    if (!grant || !grant.started || grant.sessionId !== subject.sessionId) {
      throw new TaskOwnerError("No live genuine user turn authorizes cancelling the task.");
    }
    // Task origin and current control authority are distinct: any later
    // genuine user turn in this authorized session/branch may control an
    // existing reachable task. The task's creation anchor stays immutable; the
    // current grant supplies only this control request's authority. Background
    // or custom messages after the current grant anchor still close the window.
    this.resolveAuthority(subject, grant);
    if (this.task.status === "cancelled") {
      this.changed({ type: "task_cancel_duplicate", taskId: this.task.taskId });
      return copyTask(this.task);
    }
    this.task.status = "cancelled";
    this.task.cancelledAt = this.now();
    this.changed({ type: "task_cancelled", taskId: this.task.taskId, taskRevision: this.task.taskRevision });
    return copyTask(this.task);
  }

  /**
   * The small current-task/admission port. It is deliberately not a capability
   * market: only host-authorized capability ids are accepted, and cancellation
   * is re-read at this entry point immediately before the capability acts.
   */
  admit(subject: TaskSubject, capabilityId: string): AdmissionDecision {
    const capability = identifier(capabilityId, "capabilityId");
    const deny = (reason: string, status: TaskStatus | null): AdmissionDecision => {
      this.changed({ type: "capability_admission_denied", capabilityId: capability, reason, taskId: this.task?.taskId ?? null });
      return {
        allowed: false,
        reason,
        taskId: this.task?.taskId ?? null,
        ownerId: this.ownerId,
        taskRevision: this.task?.taskRevision ?? null,
        anchorMessageId: this.task?.anchor.messageId ?? null,
        capabilityId: capability,
        actionIndex: null,
        status,
      };
    };
    try {
      this.assertSubject(subject);
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error), this.task?.status ?? null);
    }
    if (!this.capabilities.has(capability)) return deny("capability is not authorized by the host", this.task?.status ?? null);
    if (this.suspended) return deny(`task admissions are suspended: ${this.suspended.reason}`, this.task?.status ?? null);
    if (!this.task) return deny("no managed task exists", null);
    try {
      this.assertTaskReachable(subject, this.task);
    } catch (error) {
      return deny(error instanceof Error ? error.message : String(error), this.task.status);
    }
    if (this.task.status !== "active") return deny("task is cancelled", this.task.status);
    this.task.admissions += 1;
    this.changed({
      type: "capability_admission_allowed",
      capabilityId: capability,
      taskId: this.task.taskId,
      ownerId: this.ownerId,
      messageId: this.task.anchor.messageId,
      actionIndex: this.task.admissions,
    });
    return {
      allowed: true,
      reason: null,
      taskId: this.task.taskId,
      ownerId: this.ownerId,
      taskRevision: this.task.taskRevision,
      anchorMessageId: this.task.anchor.messageId,
      capabilityId: capability,
      actionIndex: this.task.admissions,
      status: this.task.status,
    };
  }
}
