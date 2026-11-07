import { encodedUtf8Bytes, type RequirementsProjection } from "./task-requirements.ts";
import type { BindingStatus } from "./task-owner.ts";

/**
 * Pure, bounded read-only projection injected as one transient OMP custom
 * message before each model call. It is derived from owner state only: the
 * model summary is never a requirement source. This module commits nothing.
 */

export const TASK_CONTEXT_TYPE = "omp-agent.task-context" as const;
/** Complete UTF-8 JSON envelope of the injected custom message. */
export const MAX_TASK_CONTEXT_BYTES = 128 * 1024;

export interface TaskContextTask {
  taskId: string;
  taskRevision: number;
  status: "active" | "cancelled";
  createdAt: string;
  cancelledAt: string | null;
  anchor: {
    messageId: string;
    sessionId: string;
  };
}

export interface TaskContextInput {
  task: TaskContextTask;
  binding: BindingStatus;
  requirements: RequirementsProjection;
  authorizedCapabilities: readonly string[];
}

export interface TaskContextView {
  schemaVersion: 1;
  kind: typeof TASK_CONTEXT_TYPE;
  guidance: string;
  provenance: {
    requirements: "host-observed-sources";
    understanding: "non-authoritative-model-note";
  };
  /** Detached history is readable but unavailable for mutation/admission. */
  availability: "current" | "read-only-unavailable";
  task: TaskContextTask;
  binding: BindingStatus;
  requirements: RequirementsProjection;
  authorizedCapabilities: string[];
}

export interface TaskContextUnavailable {
  schemaVersion: 1;
  kind: typeof TASK_CONTEXT_TYPE;
  state: "unavailable";
  reason: string;
  task: {
    taskId: string;
    taskRevision: number;
    status: "active" | "cancelled";
  };
  binding: {
    state: BindingStatus["state"];
    reason: string | null;
  };
}

export interface TaskContextEnvelope {
  message: {
    role: "custom";
    customType: typeof TASK_CONTEXT_TYPE;
    content: string;
    display: false;
    attribution: "agent";
    timestamp: number;
  };
  view: TaskContextView | TaskContextUnavailable;
  bytes: number;
  fallback: boolean;
}

const GUIDANCE = "Host-owned task state for this conversation. The requirement sources (original request and ordered amendments) are authoritative host-observed text; understanding is a non-authoritative model note, and a compaction summary or previous context message is not a requirement source. This message is context, not a user request and not permission: start, revise and cancel still require a live genuine user turn and are revalidated at the actual branch anchor. If the binding is detached, the task is read-only and unavailable for mutation or admission; it cannot be reattached or granted authority by this state.";

function envelope(view: TaskContextView | TaskContextUnavailable, timestamp: number): TaskContextEnvelope {
  const message = {
    role: "custom" as const,
    customType: TASK_CONTEXT_TYPE,
    content: JSON.stringify(view),
    display: false as const,
    attribution: "agent" as const,
    timestamp,
  };
  return { message, view, bytes: encodedUtf8Bytes(message), fallback: false };
}

/**
 * Build the bounded transient context message. The normal view restates the
 * complete requirement projection. If that complete envelope cannot fit the
 * 128 KiB bound, return a small visible state-unavailable marker instead of
 * truncating constraints or pretending the full view exists.
 */
export function buildTaskContextMessage(input: TaskContextInput, timestamp: number): TaskContextEnvelope {
  const view: TaskContextView = {
    schemaVersion: 1,
    kind: TASK_CONTEXT_TYPE,
    guidance: GUIDANCE,
    provenance: {
      requirements: "host-observed-sources",
      understanding: "non-authoritative-model-note",
    },
    availability: input.binding.state === "detached" ? "read-only-unavailable" : "current",
    task: {
      ...input.task,
      anchor: { ...input.task.anchor },
    },
    binding: { ...input.binding },
    requirements: structuredClone(input.requirements),
    authorizedCapabilities: [...input.authorizedCapabilities].sort(),
  };
  const full = envelope(view, timestamp);
  if (full.bytes <= MAX_TASK_CONTEXT_BYTES) return full;

  const unavailable = buildUnavailableTaskContextMessage({
    reason: `The complete task-context projection exceeds the ${MAX_TASK_CONTEXT_BYTES}-byte bound. The host owner still holds the authoritative requirement records; no requirement text was truncated or replaced here.`,
    task: {
      taskId: input.task.taskId,
      taskRevision: input.task.taskRevision,
      status: input.task.status,
    },
    binding: {
      state: input.binding.state,
      reason: input.binding.reason,
    },
  }, timestamp);
  unavailable.fallback = true;
  return unavailable;
}

/**
 * Small conservative marker used when the full projection cannot be produced
 * or cannot fit. It never carries partial requirement text.
 */
export function buildUnavailableTaskContextMessage(input: {
  reason: string;
  task?: { taskId: string; taskRevision: number; status: "active" | "cancelled" };
  binding?: { state: BindingStatus["state"]; reason: string | null };
}, timestamp: number): TaskContextEnvelope {
  const marker: TaskContextUnavailable = {
    schemaVersion: 1,
    kind: TASK_CONTEXT_TYPE,
    state: "unavailable",
    reason: input.reason,
    task: input.task ?? { taskId: "unavailable", taskRevision: 0, status: "active" },
    binding: input.binding ?? { state: "detached", reason: null },
  };
  const unavailable = envelope(marker, timestamp);
  unavailable.fallback = true;
  if (unavailable.bytes > MAX_TASK_CONTEXT_BYTES) {
    throw new Error("The task-context state-unavailable marker exceeds its own bounded envelope.");
  }
  return unavailable;
}
