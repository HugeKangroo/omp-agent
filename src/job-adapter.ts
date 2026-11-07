import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createFileAudit, type AuditEvent, type AuditSink } from "./audit.ts";
import { writeJsonAtomicSync } from "./host-record.ts";
import { subjectFromContext, type OmpToolContext } from "./task-entry-port.ts";
import type { TaskOwner, TaskOwnerEvent } from "./task-owner.ts";

/**
 * Experimental G1-B3a: one explicit loopback external-job prototype.
 *
 * The adapter is generic. It knows a task, a host-authorized capability, a
 * bounded opaque payload and an HTTP-ish operation protocol. It has no domain
 * planner, no model loop, and no durable recovery claim. Its local record is
 * prototype evidence only.
 */

export const JOB_SCHEMA_VERSION = 1 as const;
export const JOB_TOOL = "agent_job";
export const MAX_PAYLOAD_BYTES = 4096;
export const MAX_RESPONSE_BYTES = 16 * 1024;
/**
 * Bound for the complete tool response (JSON text content plus JSON details)
 * and the retained history. History is append-only in memory/record; only the
 * displayed window is bounded, with explicit omission counts.
 */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024;

export type ExternalJobState =
  | "unknown"
  | "not_dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type CancellationIntentState = "requested_unconfirmed" | "confirmed";

export interface JobCall {
  /** Per-request trace id. The logical operation keeps its stable callId. */
  traceId: string;
  action: "submit" | "query";
  startedAt: string;
  finishedAt: string | null;
  outcome: "ok" | "error" | "unknown";
  detail: string | null;
}

export interface JobObservation {
  at: string;
  source: string;
  /** Actual remote state observed at this point; null when nothing was observed. */
  remoteState: Exclude<ExternalJobState, "unknown" | "not_dispatched"> | null;
  externalJobId: string | null;
  detail: string | null;
  /** Every result stays bound to the revision that was admitted. */
  taskRevision: number;
  cancelIntentId: string | null;
}

export interface CancellationIntent {
  cancelIntentId: string;
  requestedAt: string;
  state: CancellationIntentState;
  attempts: number;
  lastAttemptAt: string | null;
}

export interface JobOperationSnapshot {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  operationId: string;
  callId: string;
  taskId: string;
  ownerId: string;
  taskRevision: number;
  anchorMessageId: string | null;
  capabilityId: string;
  payloadDigest: string;
  payloadBytes: number;
  payload: string;
  dispatch: "not_started" | "sent";
  accepted: boolean;
  externalJobId: string | null;
  externalState: ExternalJobState;
  cancelIntent: CancellationIntent | null;
  calls: JobCall[];
  observations: JobObservation[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface HostJobConfig {
  /** Host-selected loopback endpoint. Never a model argument. */
  endpoint: string;
  /** Absolute host record path. Prototype evidence, not restart recovery. */
  recordPath: string;
  auditPath?: string;
  /** Host-authorized capability id for active business admission. */
  capabilityId: string;
  /** Host-selected request timeout; never a model argument. */
  timeoutMs?: number;
  now?: () => string;
  id?: () => string;
}

export interface JobToolContext extends OmpToolContext {}

export interface JobToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export class JobAdapterError extends Error {
  override name = "JobAdapterError";
}

interface JobRecord {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  adapterId: string;
  endpoint: string;
  updatedAt: string;
  operations: JobOperationSnapshot[];
}

interface RemoteResponse {
  state: "running" | "succeeded" | "failed" | "cancelled";
  jobId: string;
  replayed: boolean;
  digest: string;
}

interface QueryRemoteOutcome {
  ok: boolean;
  fresh: boolean;
  callOutcome: JobCall["outcome"];
  remoteState: RemoteResponse["state"] | null;
  error: string | null;
}

function querySummary(outcome: QueryRemoteOutcome): Record<string, unknown> {
  return {
    outcome: outcome.ok ? "ok" : outcome.fresh ? "stale" : "unverified",
    fresh: outcome.fresh,
    remoteState: outcome.remoteState,
    error: outcome.error,
  };
}

const SUBMIT_KEYS = new Set(["action", "expectedTaskRevision", "payload"]);
const QUERY_KEYS = new Set(["action"]);
const FORBIDDEN_KEYS = new Set([
  "operationId", "operationID", "jobId", "jobID", "callId", "taskId", "ownerId",
  "endpoint", "url", "serviceUrl", "cancelIntentId", "fault", "faults", "budget",
  "permission", "permissions", "token", "secret", "capability", "capabilityId",
  "expectedTaskId", "revision", "rawRequest", "goal",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JobAdapterError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function positiveRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new JobAdapterError("expectedTaskRevision must be a positive integer.");
  }
  return value;
}

function boundedPayload(value: unknown): string {
  if (typeof value !== "string" || !value.length) throw new JobAdapterError("payload must be non-empty text.");
  if (value.includes("\0")) throw new JobAdapterError("payload contains a NUL character.");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new JobAdapterError(`payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function digestOf(payload: string): string {
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    return Object.freeze(value);
  }
  return value;
}

function boundedText(value: unknown, limit = 500): string {
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseState(value: unknown): RemoteResponse["state"] | undefined {
  return value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : undefined;
}

function loopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JobAdapterError("Host job endpoint must be an absolute loopback URL.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new JobAdapterError("Host job endpoint must be http://127.0.0.1:<ephemeral-port>.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new JobAdapterError("Host job endpoint must not carry credentials, query parameters or fragments.");
  }
  return url.origin;
}

/** Strict model-facing parser. Host endpoints and all identifiers are rejected. */
export function parseJobToolArguments(value: unknown): {
  action: "submit" | "query";
  expectedTaskRevision?: number;
  payload?: string;
} {
  const args = object(value, "agent_job arguments");
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => FORBIDDEN_KEYS.has(key));
  if (forbidden.length) {
    throw new JobAdapterError(
      `agent_job never accepts host/job authority from model parameters: ${forbidden.join(", ")}.`,
    );
  }
  if (args.action !== "submit" && args.action !== "query") {
    throw new JobAdapterError("agent_job action must be submit or query; cancellation is host-driven.");
  }
  const allowed = args.action === "submit" ? SUBMIT_KEYS : QUERY_KEYS;
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length) throw new JobAdapterError(`agent_job has unsupported field(s): ${unknown.join(", ")}.`);
  if (args.action === "query") return { action: "query" };
  if (!("expectedTaskRevision" in args)) throw new JobAdapterError("agent_job submit requires expectedTaskRevision.");
  if (!("payload" in args)) throw new JobAdapterError("agent_job submit requires payload.");
  return {
    action: "submit",
    expectedTaskRevision: positiveRevision(args.expectedTaskRevision),
    payload: boundedPayload(args.payload),
  };
}

/**
 * One registered logical operation per prototype task. This is a deliberate
 * B3a prototype limit, not a kernel or TaskOwner constraint.
 */
export class JobAdapter {
  readonly adapterId: string;
  readonly endpoint: string;
  readonly capabilityId: string;
  readonly operationIds: string[] = [];

  private readonly owner: TaskOwner;
  private readonly recordPath: string;
  private readonly audit: AuditSink;
  private readonly timeoutMs: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly operations = new Map<string, JobOperationSnapshot>();
  private readonly byTask = new Map<string, string>();
  private readonly cleanupQueue: string[] = [];
  private readonly cleanupActive = new Set<string>();
  /** A wakeup arrived while the same intent was in flight; reconcile once more. */
  private readonly cleanupDirty = new Set<string>();
  private cleanupRunning = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(owner: TaskOwner, config: HostJobConfig) {
    if (!path.isAbsolute(config.recordPath)) throw new JobAdapterError("Job record path must be absolute.");
    this.owner = owner;
    this.endpoint = loopbackEndpoint(config.endpoint);
    this.recordPath = config.recordPath;
    this.capabilityId = config.capabilityId;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 50 || this.timeoutMs > 60_000) {
      throw new JobAdapterError("Job timeout must be an integer between 50 and 60000 ms.");
    }
    this.now = config.now ?? (() => new Date().toISOString());
    this.newId = config.id ?? (() => randomUUID());
    this.audit = createFileAudit(config.auditPath);
    this.adapterId = `job-adapter-${this.newId()}`;
    this.persist();
    this.safeAudit({ type: "job_adapter_started", adapterId: this.adapterId, endpoint: this.endpoint });
    this.unsubscribe = owner.subscribe((event) => this.onOwnerEvent(event));
  }

  private safeAudit(event: AuditEvent): void {
    try {
      this.audit(event);
    } catch {
      // Audit failure never changes job or task state.
    }
  }

  private onOwnerEvent(event: TaskOwnerEvent): void {
    if (this.disposed) return;
    if (event.type !== "task_cancelled" || typeof event.taskId !== "string") return;
    const operationId = this.byTask.get(event.taskId);
    if (!operationId) return;
    const operation = this.operations.get(operationId);
    if (!operation || operation.ownerId !== this.owner.ownerId) return;
    if (!operation.cancelIntent) {
      operation.cancelIntent = {
        cancelIntentId: `cancel-${this.newId()}`,
        requestedAt: this.now(),
        state: "requested_unconfirmed",
        attempts: 0,
        lastAttemptAt: null,
      };
      operation.updatedAt = this.now();
      this.persist();
      this.safeAudit({
        type: "job_cancel_intent",
        operationId,
        cancelIntentId: operation.cancelIntent.cancelIntentId,
        taskId: operation.taskId,
        taskRevision: operation.taskRevision,
      });
    }
    this.scheduleCleanup(operationId);
  }

  private scheduleCleanup(operationId: string): void {
    if (this.disposed) return;
    // A wakeup during an in-flight attempt is not dropped: mark it dirty and
    // run one more bounded reconciliation for the SAME intent afterwards.
    if (this.cleanupActive.has(operationId)) {
      this.cleanupDirty.add(operationId);
      return;
    }
    if (!this.cleanupQueue.includes(operationId)) this.cleanupQueue.push(operationId);
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    void this.drainCleanup();
  }

  private async drainCleanup(): Promise<void> {
    try {
      while (this.cleanupQueue.length && !this.disposed) {
        const operationId = this.cleanupQueue.shift()!;
        this.cleanupActive.add(operationId);
        try {
          await this.cleanupOnce(operationId);
        } catch (error) {
          this.recordCancellationFailure(operationId, errorMessage(error));
        } finally {
          this.cleanupActive.delete(operationId);
          if (this.cleanupDirty.delete(operationId) && !this.disposed) {
            if (!this.cleanupQueue.includes(operationId)) this.cleanupQueue.push(operationId);
          }
        }
      }
    } finally {
      this.cleanupRunning = false;
      if (this.cleanupQueue.length && !this.disposed) this.scheduleCleanup(this.cleanupQueue[0]!);
    }
  }

  private operationFor(operationId: string): JobOperationSnapshot | undefined {
    return this.operations.get(operationId);
  }

  private recordCancellationFailure(operationId: string, message: string): void {
    const operation = this.operationFor(operationId);
    if (!operation) return;
    operation.lastError = message;
    operation.updatedAt = this.now();
    this.observe(operation, {
      source: "cancel_transport_error",
      remoteState: null,
      externalJobId: operation.externalJobId,
      detail: message,
      cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
    });
    this.persist();
  }

  private observe(
    operation: JobOperationSnapshot,
    observation: Omit<JobObservation, "at" | "taskRevision">,
  ): void {
    // Append-only evidence. Display/output bounding never erases a failure or
    // verification fact from the host record.
    operation.observations.push({
      at: this.now(),
      taskRevision: operation.taskRevision,
      ...observation,
    });
    operation.updatedAt = this.now();
  }

  private applyRemoteState(operation: JobOperationSnapshot, state: RemoteResponse["state"]): void {
    const current = operation.externalState;
    // Terminal facts are never downgraded by a stale late response. A late
    // submit/query observation still records the response, but it cannot
    // retag the operation or resurrect a cancelled/succeeded effect.
    if (current === "succeeded" || current === "failed" || current === "cancelled") return;
    operation.externalState = state;
    if (state !== "running") operation.accepted = true;
  }

  private persist(): void {
    const record: JobRecord = {
      schemaVersion: JOB_SCHEMA_VERSION,
      adapterId: this.adapterId,
      endpoint: this.endpoint,
      updatedAt: this.now(),
      operations: [...this.operations.values()].map((operation) => copy(operation)),
    };
    writeJsonAtomicSync(this.recordPath, record);
  }

  snapshot(operationId: string): JobOperationSnapshot | undefined {
    const operation = this.operations.get(operationId);
    return operation ? freeze(copy(operation)) : undefined;
  }

  private async request(
    method: "GET" | "POST",
    requestPath: string,
    body?: unknown,
  ): Promise<{ status: number; value: Record<string, unknown> | undefined }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}${requestPath}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new JobAdapterError(`Job service response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      }
      let value: Record<string, unknown> | undefined;
      if (bytes.byteLength) {
        try {
          const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            value = parsed as Record<string, unknown>;
          } else {
            throw new JobAdapterError("Job service returned a non-object JSON response.");
          }
        } catch (error) {
          if (error instanceof JobAdapterError) throw error;
          throw new JobAdapterError(`Job service returned invalid JSON: ${errorMessage(error)}`);
        }
      }
      return { status: response.status, value };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Validate the complete remote identity before touching accepted/jobId/state.
   * The returned facts are the only ones later applied to the operation.
   */
  private responseState(value: Record<string, unknown> | undefined, operation: JobOperationSnapshot): RemoteResponse {
    if (!value) throw new JobAdapterError("Job service response was empty.");
    if (value.operationId !== operation.operationId) {
      throw new JobAdapterError("Job service response carries a mismatched operationId; last verified facts are unchanged.");
    }
    if (value.digest !== operation.payloadDigest) {
      throw new JobAdapterError("Job service response carries a missing or mismatched request digest; last verified facts are unchanged.");
    }
    const state = parseState(value.state);
    if (!state) throw new JobAdapterError("Job service response carries an invalid actual job state; last verified facts are unchanged.");
    if (typeof value.jobId !== "string" || !value.jobId) {
      throw new JobAdapterError("Job service response carries no valid jobId; last verified facts are unchanged.");
    }
    if (value.jobId.length > 200) {
      throw new JobAdapterError("Job service response carries an overlong jobId; last verified facts are unchanged.");
    }
    const jobId = value.jobId;
    if (operation.externalJobId !== null && operation.externalJobId !== jobId) {
      throw new JobAdapterError("Job service response changed the jobId for the same operation; last verified facts are unchanged.");
    }
    return {
      state,
      jobId,
      replayed: value.replayed === true,
      digest: operation.payloadDigest,
    };
  }

  private taskContext(context: JobToolContext): {
    subject: ReturnType<typeof subjectFromContext>;
    taskId: string;
    taskRevision: number;
    taskStatus: string;
    sessionId: string;
  } {
    const snapshot = this.owner.snapshot();
    const subject = subjectFromContext(context, this.owner.workspaceRoot);
    if (snapshot.binding.state !== "attached") {
      throw new JobAdapterError("agent_job is unavailable: the conversation binding is detached.");
    }
    if (snapshot.suspended) throw new JobAdapterError(`agent_job is unavailable: ${snapshot.suspended.reason}.`);
    // Read-only reachability of the actual creation anchor in this branch, not
    // just a session id or an attached flag.
    const task = this.owner.reachableTask(subject);
    return {
      subject,
      taskId: task.taskId,
      taskRevision: task.taskRevision,
      taskStatus: task.status,
      sessionId: subject.sessionId,
    };
  }

  /** A failed/invalid response may not overwrite a previously verified state. */
  private markSubmitUnverified(operation: JobOperationSnapshot, state: ExternalJobState): void {
    if (operation.externalState === "not_dispatched" || operation.externalState === "unknown") {
      operation.externalState = state;
    }
  }

  async submit(context: JobToolContext, args: { expectedTaskRevision: number; payload: string }): Promise<JobToolResult> {
    if (this.disposed) throw new JobAdapterError("Job adapter is disposed.");
    const traceId = `job-trace-${this.newId()}`;
    const scope = this.taskContext(context);
    const payload = boundedPayload(args.payload);
    const digest = digestOf(payload);
    const existingId = this.byTask.get(scope.taskId);
    if (existingId) {
      const existing = this.operations.get(existingId)!;
      if (existing.payloadDigest !== digest) {
        this.safeAudit({
          type: "job_submit_conflict",
          traceId,
          operationId: existing.operationId,
          taskId: scope.taskId,
        });
        throw new JobAdapterError(
          "A different payload is already registered for this prototype task; B3a permits one logical job per task.",
        );
      }
      if (scope.taskStatus !== "active") {
        throw new JobAdapterError("New job submission is denied: the task is cancelled.");
      }
      if (existing.taskRevision !== scope.taskRevision) {
        throw new JobAdapterError(
          `New job submission is denied: the registered operation is bound to taskRevision ${existing.taskRevision}, current is ${scope.taskRevision}. Old operations are never replayed as new work.`,
        );
      }
      if (scope.taskRevision !== args.expectedTaskRevision) {
        throw new JobAdapterError(
          `Stale expected taskRevision ${args.expectedTaskRevision}; the owner is at ${scope.taskRevision}.`,
        );
      }
      const call = this.startCall(existing, "submit", traceId);
      const outcome = await this.queryRemote(existing, "submit_reconcile");
      this.finishCall(existing, call, outcome.callOutcome, outcome.error);
      this.persist();
      return this.result(
        "submit",
        existing,
        { reconciled: true, traceId, reconciliation: querySummary(outcome) },
        !outcome.ok,
      );
    }

    const decision = this.owner.admit(scope.subject, this.capabilityId, args.expectedTaskRevision);
    if (!decision.allowed) {
      this.safeAudit({ type: "job_submit_denied", traceId, reason: decision.reason });
      throw new JobAdapterError(`Job admission denied: ${decision.reason}`);
    }
    const operation: JobOperationSnapshot = {
      schemaVersion: JOB_SCHEMA_VERSION,
      operationId: `job-op-${this.newId()}`,
      callId: `job-call-${this.newId()}`,
      taskId: scope.taskId,
      ownerId: this.owner.ownerId,
      taskRevision: decision.taskRevision!,
      anchorMessageId: decision.anchorMessageId,
      capabilityId: this.capabilityId,
      payloadDigest: digest,
      payloadBytes: Buffer.byteLength(payload, "utf8"),
      payload,
      dispatch: "not_started",
      accepted: false,
      externalJobId: null,
      externalState: "not_dispatched",
      cancelIntent: null,
      calls: [],
      observations: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      lastError: null,
    };
    this.operations.set(operation.operationId, operation);
    this.byTask.set(operation.taskId, operation.operationId);
    this.operationIds.push(operation.operationId);
    const call = this.startCall(operation, "submit", traceId);
    // Persist the host-minted IDs, digest and payload before any transport.
    this.observe(operation, {
      source: "host_registered",
      remoteState: null,
      externalJobId: null,
      detail: "logical operation registered before transport",
      cancelIntentId: null,
    });
    this.persist();
    this.safeAudit({
      type: "job_submit_admitted",
      callId: operation.callId,
      traceId,
      operationId: operation.operationId,
      taskId: operation.taskId,
      taskRevision: operation.taskRevision,
      payloadDigest: operation.payloadDigest,
      payloadBytes: operation.payloadBytes,
      actionIndex: decision.actionIndex,
    });

    // Independent immediate pre-transport recheck: status, revision, binding
    // and task/owner identity must still match. This is not another admission.
    const current = this.owner.snapshot();
    const task = current.currentTask;
    const stillAllowed = current.binding.state === "attached"
      && current.suspended === null
      && task !== null
      && task.taskId === operation.taskId
      && task.ownerId === operation.ownerId
      && task.status === "active"
      && task.taskRevision === operation.taskRevision;
    if (!stillAllowed) {
      operation.lastError = "task state changed between admission and first transport; dispatch stopped";
      this.observe(operation, {
        source: "preflight_guard",
        remoteState: null,
        externalJobId: null,
        detail: operation.lastError,
        cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
      });
      this.finishCall(operation, call, "error", operation.lastError);
      this.persist();
      return this.result("submit", operation, { reconciled: false }, true);
    }

    operation.dispatch = "sent";
    operation.updatedAt = this.now();
    this.persist();
    try {
      const response = await this.request("POST", "/jobs", {
        operationId: operation.operationId,
        digest: operation.payloadDigest,
        payload: operation.payload,
      });
      if (response.status >= 400) {
        // A dispatched submit can have created the job before any 4xx/5xx,
        // proxy error or conflict response. HTTP status alone is not
        // identity-bound evidence of no effect. Keep the operation unknown
        // (or its earlier verified state), never replay it, and never claim
        // not_dispatched/failed/zero effect.
        this.markSubmitUnverified(operation, "unknown");
        const serviceError = boundedText(response.value?.error, 200);
        operation.lastError = `job service HTTP ${response.status}${serviceError ? `: ${serviceError}` : ""}; external state is unverified`;
        this.observe(operation, {
          source: "submit_http_error",
          remoteState: null,
          externalJobId: operation.externalJobId,
          detail: operation.lastError,
          cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
        });
        this.finishCall(operation, call, "unknown", operation.lastError);
        this.persist();
        return this.result("submit", operation, { reconciled: false }, true);
      }
      // Full operationId + digest + stable jobId + actual state are validated
      // here, before any accepted/jobId/state field changes.
      const remote = this.responseState(response.value, operation);
      operation.accepted = true;
      operation.externalJobId = remote.jobId;
      this.applyRemoteState(operation, remote.state);
      this.observe(operation, {
        source: "submit_response",
        remoteState: remote.state,
        externalJobId: operation.externalJobId,
        detail: remote.replayed ? "idempotent replay" : null,
        cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
      });
      this.finishCall(operation, call, "ok", null);
      this.persist();
      if (operation.cancelIntent) this.scheduleCleanup(operation.operationId);
      return this.result("submit", operation, { reconciled: remote.replayed, traceId }, false);
    } catch (error) {
      // Accepted-then-lost-ack is indistinguishable here from a transport
      // failure before acceptance. Never mint a new id or claim zero effect,
      // and never downgrade a verified remote fact on a late invalid response.
      this.markSubmitUnverified(operation, "unknown");
      operation.lastError = errorMessage(error);
      this.observe(operation, {
        source: "submit_transport_error",
        remoteState: null,
        externalJobId: operation.externalJobId,
        detail: operation.lastError,
        cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
      });
      this.finishCall(operation, call, "unknown", operation.lastError);
      this.persist();
      if (operation.cancelIntent) this.scheduleCleanup(operation.operationId);
      return this.result("submit", operation, { reconciled: false }, false);
    }
  }

  async query(context: JobToolContext): Promise<JobToolResult> {
    if (this.disposed) throw new JobAdapterError("Job adapter is disposed.");
    const traceId = `job-trace-${this.newId()}`;
    const scope = this.taskContext(context);
    const operationId = this.byTask.get(scope.taskId);
    if (!operationId) throw new JobAdapterError("No job operation is registered for this task.");
    const operation = this.operations.get(operationId)!;
    const call = this.startCall(operation, "query", traceId);
    if (operation.dispatch === "not_started") {
      this.finishCall(operation, call, "ok", "operation was never dispatched");
      this.persist();
      return this.result("query", operation, {
        traceId,
        query: { outcome: "ok", fresh: false, remoteState: "not_dispatched", error: null },
      }, false);
    }
    const outcome = await this.queryRemote(operation, "query");
    this.finishCall(operation, call, outcome.callOutcome, outcome.error);
    this.persist();
    if (operation.cancelIntent && operation.cancelIntent.state === "requested_unconfirmed"
      && (operation.externalState === "running" || operation.externalState === "unknown")) {
      // Reconcile/retry the SAME intent, not a new cancellation.
      this.scheduleCleanup(operation.operationId);
    }
    return this.result("query", operation, { traceId, query: querySummary(outcome) }, !outcome.ok);
  }

  private startCall(operation: JobOperationSnapshot, action: "submit" | "query", traceId: string): JobCall {
    const call: JobCall = {
      traceId,
      action,
      startedAt: this.now(),
      finishedAt: null,
      outcome: "unknown",
      detail: null,
    };
    operation.calls.push(call);
    return call;
  }

  private finishCall(operation: JobOperationSnapshot, call: JobCall, outcome: JobCall["outcome"], detail: string | null): void {
    call.finishedAt = this.now();
    call.outcome = outcome;
    call.detail = detail === null ? null : boundedText(detail, 500);
    operation.updatedAt = this.now();
  }

  private async queryRemote(operation: JobOperationSnapshot, source: string): Promise<QueryRemoteOutcome> {
    try {
      const response = await this.request("GET", `/jobs/${encodeURIComponent(operation.operationId)}`);
      if (response.status === 404) {
        // Not found is not proof that no job will appear: an accepted submit
        // may still be in flight. Preserve any verified state, but this
        // request itself has no fresh evidence.
        if (operation.externalState === "not_dispatched" || operation.externalState === "unknown") {
          operation.externalState = "unknown";
        }
        const detail = "job service has not observed the operation; this query is unverified";
        operation.lastError = detail;
        this.observe(operation, {
          source: `${source}_not_found`,
          remoteState: null,
          externalJobId: operation.externalJobId,
          detail,
          cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
        });
        return { ok: false, fresh: false, callOutcome: "unknown", remoteState: null, error: detail };
      }
      if (response.status >= 400) throw new JobAdapterError(`job query failed with HTTP ${response.status}`);
      const remote = this.responseState(response.value, operation);
      operation.accepted = true;
      operation.externalJobId = remote.jobId;
      this.applyRemoteState(operation, remote.state);
      this.observe(operation, {
        source,
        remoteState: remote.state,
        externalJobId: operation.externalJobId,
        detail: null,
        cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
      });
      if (operation.cancelIntent && remote.state === "cancelled") {
        operation.cancelIntent.state = "confirmed";
        operation.cancelIntent.lastAttemptAt = this.now();
      }
      operation.lastError = null;
      return { ok: true, fresh: true, callOutcome: "ok", remoteState: remote.state, error: null };
    } catch (error) {
      operation.lastError = errorMessage(error);
      this.observe(operation, {
        source: `${source}_transport_error`,
        remoteState: null,
        externalJobId: operation.externalJobId,
        detail: operation.lastError,
        cancelIntentId: operation.cancelIntent?.cancelIntentId ?? null,
      });
      return { ok: false, fresh: false, callOutcome: "unknown", remoteState: null, error: operation.lastError };
    }
  }

  private async cleanupOnce(operationId: string): Promise<void> {
    if (this.disposed) return;
    const operation = this.operations.get(operationId);
    if (!operation || !operation.cancelIntent) return;
    if (operation.cancelIntent.state === "confirmed") return;
    if (operation.ownerId !== this.owner.ownerId) return;
    if (operation.dispatch === "not_started") {
      operation.cancelIntent.state = "confirmed";
      operation.externalState = "not_dispatched";
      operation.updatedAt = this.now();
      this.observe(operation, {
        source: "cancel_local_not_dispatched",
        remoteState: null,
        externalJobId: null,
        detail: "cancellation noted before first transport; nothing was dispatched",
        cancelIntentId: operation.cancelIntent.cancelIntentId,
      });
      this.persist();
      return;
    }
    operation.cancelIntent.attempts += 1;
    operation.cancelIntent.lastAttemptAt = this.now();
    operation.updatedAt = this.now();
    this.persist();
    try {
      const response = await this.request("POST", `/jobs/${encodeURIComponent(operation.operationId)}/cancel`, {
        cancelIntentId: operation.cancelIntent.cancelIntentId,
      });
      if (response.status === 404) {
        // The possibly in-flight submit may not be visible yet. Keep the same
        // intent unconfirmed and try to reconcile by operation id.
        this.observe(operation, {
          source: "cancel_not_found",
          remoteState: null,
          externalJobId: operation.externalJobId,
          detail: "cancel target not yet observed; absence is not proof",
          cancelIntentId: operation.cancelIntent.cancelIntentId,
        });
        await this.queryRemote(operation, "cancel_not_found_query");
        this.persist();
        this.safeAudit({
          type: "job_cancel_observed",
          operationId,
          cancelIntentId: operation.cancelIntent.cancelIntentId,
          state: "requested_unconfirmed",
          remoteState: operation.externalState,
        });
        return;
      }
      if (response.status >= 400) throw new JobAdapterError(`job cancel failed with HTTP ${response.status}`);
      const remote = this.responseState(response.value, operation);
      operation.accepted = true;
      operation.externalJobId = remote.jobId;
      this.applyRemoteState(operation, remote.state);
      if (remote.state === "cancelled") {
        operation.cancelIntent.state = "confirmed";
      }
      this.observe(operation, {
        source: "cancel_response",
        remoteState: remote.state,
        externalJobId: operation.externalJobId,
        detail: remote.state === "cancelled"
          ? "cancellation confirmed"
          : `cancellation unconfirmed; remote state is ${remote.state}`,
        cancelIntentId: operation.cancelIntent.cancelIntentId,
      });
      operation.lastError = null;
      this.persist();
      this.safeAudit({
        type: "job_cancel_observed",
        operationId,
        cancelIntentId: operation.cancelIntent.cancelIntentId,
        state: operation.cancelIntent.state,
        remoteState: operation.externalState,
      });
    } catch (error) {
      // Lost cancel acknowledgement is not cancellation.
      operation.lastError = errorMessage(error);
      this.observe(operation, {
        source: "cancel_transport_error",
        remoteState: null,
        externalJobId: operation.externalJobId,
        detail: operation.lastError,
        cancelIntentId: operation.cancelIntent.cancelIntentId,
      });
      this.persist();
      this.safeAudit({
        type: "job_cancel_observed",
        operationId,
        cancelIntentId: operation.cancelIntent.cancelIntentId,
        state: "requested_unconfirmed",
        error: operation.lastError,
      });
    }
  }

  private result(
    action: "submit" | "query",
    operation: JobOperationSnapshot,
    extra: Record<string, unknown>,
    isError: boolean,
  ): JobToolResult {
    const task = this.owner.snapshot();
    const totalObservations = operation.observations.length;
    const totalCalls = operation.calls.length;
    let shownObservations = totalObservations;
    let shownCalls = totalCalls;
    let includePayload = true;

    const build = (): Record<string, unknown> => {
      const displayed = copy(operation) as JobOperationSnapshot & { display?: Record<string, unknown> };
      displayed.calls = displayed.calls.slice(totalCalls - shownCalls);
      displayed.observations = displayed.observations.slice(totalObservations - shownObservations);
      if (!includePayload) displayed.payload = "";
      displayed.display = {
        window: "latest",
        observationsShown: shownObservations,
        observationsOmitted: totalObservations - shownObservations,
        callsShown: shownCalls,
        callsOmitted: totalCalls - shownCalls,
        payloadIncluded: includePayload,
      };
      return {
        schemaVersion: JOB_SCHEMA_VERSION,
        tool: JOB_TOOL,
        action,
        ...extra,
        operation: displayed,
        /** Read-only owner facts. A job query never accepts or mutates the task. */
        task: {
          taskId: operation.taskId,
          taskRevision: task.currentTask?.taskId === operation.taskId ? task.currentTask.taskRevision : null,
          status: task.currentTask?.taskId === operation.taskId ? task.currentTask.status : null,
          binding: task.binding.state,
        },
        history: {
          retained: { observations: totalObservations, calls: totalCalls },
          shown: { observations: shownObservations, calls: shownCalls },
          omitted: {
            observations: totalObservations - shownObservations,
            calls: totalCalls - shownCalls,
          },
          retainedAllInHostRecord: true,
          retainedIn: "host record (prototype evidence; not restart recovery)",
        },
        note: operation.externalState === "unknown"
          ? "External state is unknown; the operation id and request digest remain the only safe reconciliation keys. Do not mint a new operation."
          : "Tool success is not task acceptance; task status comes only from the owner.",
      };
    };

    let details = freeze(copy(build()));
    let text = JSON.stringify(details);
    // Exact size of the complete returned envelope (content is itself JSON
    // text, so escaping is counted once more); not just the inner JSON bytes.
    const envelopeBytes = (): number => Buffer.byteLength(JSON.stringify({
      content: [{ type: "text", text }],
      details,
      ...(isError ? { isError: true } : {}),
    }), "utf8");
    // An oversize display must never turn an already-committed effect into a
    // false operation failure.
    while (envelopeBytes() > MAX_TOOL_RESULT_BYTES) {
      if (shownObservations > 0) shownObservations -= 1;
      else if (shownCalls > 0) shownCalls -= 1;
      else if (includePayload) includePayload = false;
      else break;
      details = freeze(copy(build()));
      text = JSON.stringify(details);
    }
    return {
      content: [{ type: "text", text }],
      details: details as Record<string, unknown>,
      ...(isError ? { isError: true } : {}),
    };
  }

  /** Stop local activity. Unresolved remote facts remain unresolved. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.safeAudit({ type: "job_adapter_disposed", adapterId: this.adapterId, unresolved: this.unresolvedOperationIds() });
  }

  unresolvedOperationIds(): string[] {
    return [...this.operations.values()]
      .filter((operation) => operation.externalState === "unknown" || operation.externalState === "running")
      .map((operation) => operation.operationId);
  }
}
