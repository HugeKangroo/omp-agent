import path from "node:path";
import {
  createFileAudit,
  type AuditEvent,
  type AuditSink,
} from "./audit.ts";
import {
  JOB_TOOL,
  JobAdapter,
  JobAdapterError,
  parseJobToolArguments,
} from "./job-adapter.ts";
import { currentTaskOwner, type OmpToolContext } from "./task-entry-port.ts";

/**
 * Explicit G1-B3a experimental entry. Loaded only by the private harness after
 * the B1 task entry. It never installs globally and never selects a profile.
 *
 * Host-only configuration (environment):
 * - OMP_AGENT_JOB_ENDPOINT: http://127.0.0.1:<ephemeral-port>
 * - OMP_AGENT_JOB_RECORD_PATH: absolute local record path
 * - OMP_AGENT_JOB_AUDIT_PATH: optional absolute JSONL audit path
 * - OMP_AGENT_JOB_CAPABILITY: host-authorized active-business capability id
 * - OMP_AGENT_JOB_TIMEOUT_MS: optional host request timeout
 *
 * The model supplies only action/payload/expectedTaskRevision. It cannot
 * choose endpoints, operation/job/call/task/owner ids, faults or budgets.
 */

interface OmpTool {
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
    context: OmpToolContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
}

interface OmpApi {
  on(event: "session_shutdown", handler: (event: unknown, context: OmpToolContext) => unknown): void;
  registerTool(tool: OmpTool): void;
}

export const JOB_ENTRY_VERSION = "0.1.0-g1b3a.0";

const JOB_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["submit", "query"],
      description: "Submit the one logical job for this task, or query the registered operation.",
    },
    expectedTaskRevision: {
      type: "integer",
      minimum: 1,
      description: "Optimistic guard for submit only. The owner rechecks it at admission.",
    },
    payload: {
      type: "string",
      description: "Bounded opaque job payload for submit. Repeated identical payloads reconcile; a different payload conflicts.",
    },
  },
  additionalProperties: false,
  required: ["action"],
} as const;

const DESCRIPTION = "Experimental one-job adapter. Submit a bounded opaque payload for the current managed task, or query the same host-registered operation. The host chooses the loopback service, operation ids, capability and cancellation. Submit requires expectedTaskRevision; the owner may deny it. Repeating the identical payload queries the existing operation and never creates a second one. Query reports the actual external state; tool success is not task acceptance. Cancellation is host-driven after agent_task cancel.";

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({ type: "omp_agent_job", message, ...(details === undefined ? {} : { details }) })}\n`);
  } catch {
    // A diagnostic channel is not guaranteed.
  }
}

function safeAudit(audit: AuditSink, event: AuditEvent): void {
  try {
    audit(event);
  } catch (error) {
    stderr("audit_write_failed", { event: event.type, error: error instanceof Error ? error.message : String(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

const MAX_ERROR_BYTES = 8 * 1024;

function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; details: unknown; isError: true } {
  const text = `${JOB_TOOL}: ${message}`;
  const bounded = Buffer.byteLength(text, "utf8") > MAX_ERROR_BYTES ? `${text.slice(0, MAX_ERROR_BYTES)}…` : text;
  return { content: [{ type: "text", text: bounded }], details: { error: message.slice(0, 1000) }, isError: true };
}

export function createJobEntry(pi: OmpApi, options: {
  endpoint: string;
  recordPath: string;
  auditPath?: string;
  capabilityId: string;
  timeoutMs?: number;
}): { adapter: JobAdapter; dispose(): void } {
  const owner = currentTaskOwner();
  if (!owner) throw new JobAdapterError("The B1 task owner must be loaded before the job entry.");
  if (!path.isAbsolute(options.recordPath)) throw new JobAdapterError("Job record path must be absolute.");
  const audit = createFileAudit(options.auditPath);
  const adapter = new JobAdapter(owner, {
    endpoint: options.endpoint,
    recordPath: options.recordPath,
    capabilityId: options.capabilityId,
    ...(options.auditPath === undefined ? {} : { auditPath: options.auditPath }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  safeAudit(audit, { type: "job_entry_started", version: JOB_ENTRY_VERSION, endpoint: adapter.endpoint });

  pi.registerTool({
    name: JOB_TOOL,
    label: "Experimental external job",
    description: DESCRIPTION,
    parameters: JOB_PARAMETERS,
    approval: "write",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      try {
        const parsed = parseJobToolArguments(params);
        if (signal?.aborted) {
          safeAudit(audit, { type: "job_tool_aborted", action: parsed.action });
          return errorResult("the call was aborted before the job adapter acted.");
        }
        safeAudit(audit, {
          type: "job_tool_attempt",
          action: parsed.action,
          sessionId: context.sessionManager?.getSessionId() ?? null,
          agentKind: context.agent?.kind === "main" ? "main" : "sub",
        });
        if (parsed.action === "submit") {
          return await adapter.submit(context, {
            expectedTaskRevision: parsed.expectedTaskRevision!,
            payload: parsed.payload!,
          });
        }
        return await adapter.query(context);
      } catch (error) {
        safeAudit(audit, { type: "job_tool_rejected", error: errorMessage(error) });
        return errorResult(errorMessage(error));
      }
    },
  });
  safeAudit(audit, { type: "job_tool_registered", name: JOB_TOOL });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    adapter.dispose();
  };
  pi.on("session_shutdown", () => {
    dispose();
    return undefined;
  });
  return { adapter, dispose };
}

export default function b3JobEntry(pi: OmpApi): void {
  const endpoint = optionalEnv("OMP_AGENT_JOB_ENDPOINT");
  const recordPath = optionalEnv("OMP_AGENT_JOB_RECORD_PATH");
  const capabilityId = optionalEnv("OMP_AGENT_JOB_CAPABILITY");
  const auditPath = optionalEnv("OMP_AGENT_JOB_AUDIT_PATH");
  if (!endpoint || !recordPath || !capabilityId) {
    stderr("entry_disabled", {
      reason: "OMP_AGENT_JOB_ENDPOINT, OMP_AGENT_JOB_RECORD_PATH and OMP_AGENT_JOB_CAPABILITY are required; no tool registered.",
    });
    return;
  }
  if (!path.isAbsolute(recordPath)) {
    stderr("entry_disabled", { reason: "OMP_AGENT_JOB_RECORD_PATH must be absolute; no tool registered." });
    return;
  }
  const timeout = optionalEnv("OMP_AGENT_JOB_TIMEOUT_MS");
  let timeoutMs: number | undefined;
  if (timeout !== undefined) {
    const parsed = Number(timeout);
    if (!Number.isSafeInteger(parsed) || parsed < 50 || parsed > 60_000) {
      stderr("entry_disabled", { reason: "OMP_AGENT_JOB_TIMEOUT_MS must be an integer between 50 and 60000." });
      return;
    }
    timeoutMs = parsed;
  }
  try {
    createJobEntry(pi, {
      endpoint,
      recordPath,
      capabilityId,
      ...(auditPath === undefined ? {} : { auditPath }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    stderr("entry_start_failed", { error: errorMessage(error) });
  }
}
