import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createFileAudit, type AuditEvent, type AuditSink } from "./audit.ts";
import { businessErrorOutcome, executeDeliverable, ReceiptStore, type BusinessRuntime } from "./business.ts";
import { writeJsonAtomicSync } from "./host-record.ts";
import {
  assertNoArguments,
  identityOf,
  parseTaskBinding,
  type TaskBinding,
} from "./identity.ts";
import {
  loadPolicy,
  policyIdentity,
  type LoadedPolicy,
} from "./policy.ts";
import { parseCheckDelay, parseCheckMode, runPreToolCheck, type CheckMode } from "./policy-check.ts";
import { TaskState } from "./task-state.ts";
import {
  BUSINESS_TOOL,
  EXTENSION_VERSION,
  READINESS_SCHEMA_VERSION,
  STATUS_TOOL,
} from "./version.ts";

/** Narrow structural contract: OMP injects the API; no OMP runtime is bundled or imported. */
interface OmpContext {
  cwd: string;
}

interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

interface MessageEndEvent {
  message: unknown;
}

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
    context: OmpContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean }>;
}

interface OmpApi {
  on(event: "tool_call", handler: (event: ToolCallEvent, context: OmpContext) => unknown): void;
  on(event: "message_end", handler: (event: MessageEndEvent, context: OmpContext) => unknown): void;
  on(event: "agent_end" | "session_start" | "session_shutdown", handler: (event: unknown, context: OmpContext) => unknown): void;
  on(event: "input", handler: (event: unknown, context: OmpContext) => unknown): void;
  registerTool(tool: OmpTool): void;
  logger?: { warn(message: string, details?: unknown): void };
}

interface ReadyRuntime {
  loadedPolicy: LoadedPolicy;
  binding: TaskBinding;
  canonicalWorkspaceRoot: string;
  checkMode: CheckMode;
  checkDelayMs: number;
  state: TaskState;
  statusPath: string;
  readinessPath: string;
  audit: AuditSink;
  business: BusinessRuntime;
}

type AuditFailOn = "business_written" | "business_written_persistent";

interface ReadinessRecord {
  schemaVersion: typeof READINESS_SCHEMA_VERSION;
  extensionVersion: string;
  ready: boolean;
  reason: string | null;
  tools: string[];
  policy: { id: string; version: number; scope: string; sha256: string } | null;
  binding: (ReturnType<typeof identityOf> & { workspaceRoot?: string }) | null;
  fixture: {
    checkMode: CheckMode | null;
    checkDelayMs: number | null;
    revocable: boolean;
    auditFailOn: AuditFailOn | null;
  };
  expectedPolicySha256: string | null;
}

class StartupError extends Error {
  override name = "StartupError";
}

const STATUS_PARAMETERS = { type: "object", properties: {}, additionalProperties: false, required: [] } as const;
const BUSINESS_PARAMETERS = {
  type: "object",
  properties: {
    content: { type: "string", description: "Exact UTF-8 content of the policy-bound deliverable." },
  },
  additionalProperties: false,
  required: ["content"],
} as const;

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || !value.trim()) throw new StartupError(`${name} is required for managed readiness.`);
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function writeReadiness(filePath: string, record: ReadinessRecord): void {
  writeJsonAtomicSync(filePath, record);
}

function assistantText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "assistant") return "";
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recovery-path audit only. The original tool outcome has priority: an
 * unavailable audit store must not replace a written artifact with a bare
 * transport error. A stderr diagnostic remains best-effort as well.
 */
function auditRecovery(audit: AuditSink, event: AuditEvent): void {
  try {
    audit(event);
  } catch (error) {
    try {
      process.stderr.write(`${JSON.stringify({
        type: "audit_write_failed",
        event: event.type,
        error: errorMessage(error),
      })}\n`);
    } catch {
      // No diagnostic channel is guaranteed; never mask the operation result.
    }
  }
}

/**
 * Thin injected extension factory. Readiness is derived from host-selected
 * policy/binding files and the tools actually registered; it is not a banner.
 */
export default async function ompAgentExtension(pi: OmpApi): Promise<void> {
  const readinessPath = optionalEnv(process.env, "OMP_AGENT_READY_PATH");
  const statusPath = optionalEnv(process.env, "OMP_AGENT_STATUS_PATH");
  const auditFailOnValue = optionalEnv(process.env, "OMP_AGENT_FIXTURE_AUDIT_FAIL_ON");
  const auditFailOn: AuditFailOn | undefined = auditFailOnValue === "business_written"
    || auditFailOnValue === "business_written_persistent"
    ? auditFailOnValue
    : undefined;
  const fileAudit = createFileAudit(optionalEnv(process.env, "OMP_AGENT_AUDIT_PATH"));
  let auditFailed = false;
  const audit: AuditSink = auditFailOn === undefined
    ? fileAudit
    : (event) => {
        if (auditFailOn === "business_written" && event.type === "business_written") {
          throw new Error("Fixture audit failure injected after the business write.");
        }
        if (auditFailOn === "business_written_persistent" && (auditFailed || event.type === "business_written")) {
          auditFailed = true;
          throw new Error("Fixture audit failure injected after the business write persists.");
        }
        fileAudit(event);
      };
  let runtime: ReadyRuntime | undefined;
  let startupReason = "";
  let bindingForFailure: TaskBinding | undefined;
  let expectedPolicySha: string | null = null;
  let fixtureMode: CheckMode | null = null;
  let fixtureDelay: number | null = null;

  try {
    if (auditFailOnValue !== undefined && auditFailOn === undefined) {
      throw new StartupError("OMP_AGENT_FIXTURE_AUDIT_FAIL_ON has an unsupported value.");
    }
    audit({ type: "extension_factory_started", extensionVersion: EXTENSION_VERSION, pid: process.pid });
    const policyPath = requiredEnv(process.env, "OMP_AGENT_POLICY_PATH");
    expectedPolicySha = requiredEnv(process.env, "OMP_AGENT_POLICY_SHA256");
    const bindingPath = requiredEnv(process.env, "OMP_AGENT_BINDING_PATH");
    if (!readinessPath) throw new StartupError("OMP_AGENT_READY_PATH is required for managed readiness.");
    if (!statusPath) throw new StartupError("OMP_AGENT_STATUS_PATH is required for managed state evidence.");

    const bindingBytes = await readFile(bindingPath);
    if (bindingBytes.length > 64 * 1024) throw new StartupError("Task binding file is too large.");
    let bindingValue: unknown;
    try {
      bindingValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bindingBytes));
    } catch {
      throw new StartupError("Task binding file is not valid UTF-8 JSON.");
    }
    bindingForFailure = parseTaskBinding(bindingValue);
    const loadedPolicy = await loadPolicy(policyPath, expectedPolicySha);
    const canonicalWorkspaceRoot = await realpath(bindingForFailure.workspaceRoot);
    const workspaceInfo = await realpath(path.dirname(canonicalWorkspaceRoot));
    if (!workspaceInfo || !canonicalWorkspaceRoot.startsWith(path.parse(canonicalWorkspaceRoot).root)) {
      throw new StartupError("Bound workspace root is not a usable absolute directory.");
    }

    const modeValue = optionalEnv(process.env, "OMP_AGENT_FIXTURE_CHECK_MODE");
    const delayValue = optionalEnv(process.env, "OMP_AGENT_FIXTURE_CHECK_DELAY_MS");
    if (loadedPolicy.policy.scope === "product" && (modeValue !== undefined || delayValue !== undefined || auditFailOnValue !== undefined)) {
      throw new StartupError("Fixture check and fault knobs are forbidden for a product-scope policy.");
    }
    fixtureMode = modeValue === undefined ? null : parseCheckMode(modeValue);
    fixtureDelay = delayValue === undefined ? null : parseCheckDelay(delayValue);
    const checkMode = fixtureMode ?? "allow";
    const checkDelayMs = fixtureDelay ?? parseCheckDelay(undefined);

    const revokePath = optionalEnv(process.env, "OMP_AGENT_REVOKE_PATH");
    if (revokePath !== undefined && !path.isAbsolute(revokePath)) {
      throw new StartupError("OMP_AGENT_REVOKE_PATH must be absolute when supplied.");
    }

    const state = new TaskState(bindingForFailure, loadedPolicy);
    const receipts = new ReceiptStore();
    runtime = {
      loadedPolicy,
      binding: Object.freeze({ ...bindingForFailure, workspaceRoot: canonicalWorkspaceRoot }),
      canonicalWorkspaceRoot,
      checkMode,
      checkDelayMs,
      state,
      statusPath,
      readinessPath,
      audit,
      business: {
        loadedPolicy,
        binding: Object.freeze({ ...bindingForFailure, workspaceRoot: canonicalWorkspaceRoot }),
        canonicalWorkspaceRoot,
        receipts,
        audit,
        ...(revokePath === undefined ? {} : { revokePath }),
      },
    };
    audit({
      type: "extension_ready",
      extensionVersion: EXTENSION_VERSION,
      ...identityOf(bindingForFailure),
      policy: policyIdentity(loadedPolicy),
      checkMode,
    });
    try {
      state.persist(statusPath);
    } catch (error) {
      audit({ type: "state_persist_failed", stage: "startup", error: errorMessage(error) });
    }
  } catch (error) {
    startupReason = errorMessage(error);
    audit({ type: "extension_not_ready", extensionVersion: EXTENSION_VERSION, reason: startupReason });
  }

  const buildReadiness = (): ReadinessRecord => {
    if (!runtime) {
      return {
        schemaVersion: READINESS_SCHEMA_VERSION,
        extensionVersion: EXTENSION_VERSION,
        ready: false,
        reason: startupReason || "Managed policy is not ready.",
        tools: [STATUS_TOOL],
        policy: null,
        binding: bindingForFailure ? identityOf(bindingForFailure) : null,
        fixture: {
          checkMode: fixtureMode,
          checkDelayMs: fixtureDelay,
          revocable: false,
          auditFailOn: auditFailOn ?? null,
        },
        expectedPolicySha256: expectedPolicySha,
      };
    }
    return {
      schemaVersion: READINESS_SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      ready: true,
      reason: null,
      tools: [STATUS_TOOL, BUSINESS_TOOL],
      policy: policyIdentity(runtime.loadedPolicy),
      binding: { ...identityOf(runtime.binding), workspaceRoot: runtime.canonicalWorkspaceRoot },
      fixture: {
        checkMode: runtime.checkMode,
        checkDelayMs: runtime.checkDelayMs,
        revocable: runtime.business.revokePath !== undefined,
        auditFailOn: auditFailOn === "business_written" ? "business_written" : null,
      },
      expectedPolicySha256: runtime.loadedPolicy.fingerprint,
    };
  };

  if (readinessPath) {
    try {
      writeReadiness(readinessPath, buildReadiness());
    } catch (error) {
      audit({ type: "readiness_write_failed", error: errorMessage(error) });
    }
  }

  const statusResult = (): { content: Array<{ type: "text"; text: string }>; details: unknown } => {
    if (!runtime) {
      return {
        content: [{ type: "text", text: `agent_status: not ready: ${startupReason || "managed policy unavailable"}` }],
        details: { ready: false, reason: startupReason || "managed policy unavailable", tools: [STATUS_TOOL] },
      };
    }
    const snapshot = runtime.state.snapshot();
    return {
      content: [{ type: "text", text: JSON.stringify({ ready: true, ...snapshot }) }],
      details: { ready: true, ...snapshot },
    };
  };

  pi.registerTool({
    name: STATUS_TOOL,
    label: "Managed agent status",
    description: "Read-only managed-plugin readiness and task-state fixture. It never writes artifacts or accepts tasks.",
    parameters: STATUS_PARAMETERS,
    approval: "read",
    loadMode: "essential",
    async execute(_toolCallId, params, _signal, _onUpdate, _context) {
      try {
        assertNoArguments(params, STATUS_TOOL);
      } catch (error) {
        return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
      }
      audit({ type: "status_tool_called", ready: runtime !== undefined });
      const result = statusResult();
      return { content: result.content, details: result.details };
    },
  });
  audit({ type: "tool_registered", name: STATUS_TOOL, loadMode: "essential" });

  if (runtime) {
    const ready = runtime;
    pi.registerTool({
      name: BUSINESS_TOOL,
      label: "Write managed deliverable",
      description: "Write exactly one policy-bound deliverable for the host-bound task. Identity, revision, owner, run, attempt and epoch come from trusted host configuration, never from tool parameters. Duplicate dispatch is a no-op.",
      parameters: BUSINESS_PARAMETERS,
      approval: "write",
      loadMode: "essential",
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        const identity = identityOf(ready.binding);
        if (signal?.aborted) {
          ready.audit({ type: "business_cancelled", ...identity });
          return { content: [{ type: "text", text: "Business action cancelled before execution." }], isError: true, details: { applied: false, cancelled: true } };
        }
        let cwd: string;
        try {
          cwd = await realpath(context.cwd);
        } catch {
          ready.audit({ type: "business_denied_workspace", ...identity, reason: "cwd unavailable" });
          return { content: [{ type: "text", text: "Session workspace is unavailable; business action denied." }], isError: true };
        }
        if (cwd !== ready.canonicalWorkspaceRoot) {
          ready.audit({ type: "business_denied_workspace", ...identity, reason: "cwd differs from bound workspace" });
          return { content: [{ type: "text", text: "Session workspace differs from the trusted task binding; business action denied." }], isError: true };
        }
        try {
          const outcome = await executeDeliverable(ready.business, params);
          if (outcome.receipt) {
            ready.state.recordOperation(outcome.receipt);
            try {
              ready.state.persist(ready.statusPath);
            } catch (error) {
              auditRecovery(ready.audit, { type: "state_persist_failed", stage: "business", error: errorMessage(error) });
            }
          }
          return outcome.result;
        } catch (error) {
          const outcome = businessErrorOutcome(error);
          auditRecovery(ready.audit, {
            type: "business_failure_reported",
            ...identity,
            details: outcome.details,
            reason: errorMessage(error),
          });
          return { content: outcome.content, isError: true, details: outcome.details };
        }
      },
    });
    audit({ type: "tool_registered", name: BUSINESS_TOOL, loadMode: "essential" });
  }

  pi.on("tool_call", async (event) => {
    if (!runtime) {
      if (event.toolName === STATUS_TOOL) {
        audit({ type: "pre_tool_check_allowed", toolName: event.toolName, reason: "read-only status; plugin not ready" });
        return undefined;
      }
      audit({ type: "pre_tool_check_denied", toolName: event.toolName, reason: "managed policy not ready" });
      return { block: true, reason: "Managed policy is not ready; tool execution is blocked." };
    }
    return runPreToolCheck({
      event,
      loadedPolicy: runtime.loadedPolicy,
      binding: runtime.binding,
      mode: runtime.checkMode,
      delayMs: runtime.checkDelayMs,
      audit: runtime.audit,
    });
  });

  pi.on("message_end", (event) => {
    if (!runtime) return;
    const text = assistantText(event.message);
    if (!text.trim()) return;
    runtime.state.recordModelClaim(text);
    const completionLike = /\b(done|complete|completed|finished|success)\b/i.test(text);
    auditRecovery(runtime.audit, { type: "model_claim_recorded", ...identityOf(runtime.binding), completionLike });
    try {
      runtime.state.persist(runtime.statusPath);
    } catch (error) {
      auditRecovery(runtime.audit, { type: "state_persist_failed", stage: "message_end", error: errorMessage(error) });
    }
  });

  pi.on("agent_end", () => {
    if (!runtime) return;
    runtime.state.recordSessionSignal("agent_end");
    auditRecovery(runtime.audit, { type: "session_signal_recorded", signal: "agent_end", ...identityOf(runtime.binding) });
    try {
      runtime.state.persist(runtime.statusPath);
    } catch (error) {
      auditRecovery(runtime.audit, { type: "state_persist_failed", stage: "agent_end", error: errorMessage(error) });
    }
  });

  pi.on("session_start", () => {
    if (!runtime) return;
    runtime.state.recordSessionSignal("session_start");
    auditRecovery(runtime.audit, { type: "session_signal_recorded", signal: "session_start", ...identityOf(runtime.binding) });
    try {
      runtime.state.persist(runtime.statusPath);
    } catch (error) {
      auditRecovery(runtime.audit, { type: "state_persist_failed", stage: "session_start", error: errorMessage(error) });
    }
  });

  pi.on("session_shutdown", () => {
    if (!runtime) return;
    runtime.state.recordSessionSignal("session_shutdown");
    try {
      runtime.state.persist(runtime.statusPath);
    } catch (error) {
      auditRecovery(runtime.audit, { type: "state_persist_failed", stage: "session_shutdown", error: errorMessage(error) });
    }
  });

  pi.on("input", (event) => {
    if (!runtime) return;
    const source = typeof event === "object" && event !== null && "source" in event
      ? (event as { source?: unknown }).source
      : undefined;
    auditRecovery(runtime.audit, { type: "input_observed", source: typeof source === "string" ? source : "unknown", ...identityOf(runtime.binding) });
    if (source === "extension") {
      // Background/tool-origin content is observation only. Task identity is fixed
      // by the host binding, so no text can authorize a fresh task.
      auditRecovery(runtime.audit, { type: "input_background_not_authorized", ...identityOf(runtime.binding) });
    }
    return undefined;
  });
}
