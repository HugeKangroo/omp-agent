import type { AuditSink } from "./audit.ts";
import { identityOf, type TaskBinding } from "./identity.ts";
import type { LoadedPolicy } from "./policy.ts";
import { BUSINESS_TOOL, STATUS_TOOL } from "./version.ts";

export const CHECK_MODES = ["allow", "deny", "throw", "timeout", "delay"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];
export const DEFAULT_CHECK_DELAY_MS = 5000;

export class CheckConfigurationError extends Error {
  override name = "CheckConfigurationError";
}

export function parseCheckMode(value: string | undefined): CheckMode {
  const mode = value ?? "allow";
  if (!CHECK_MODES.includes(mode as CheckMode)) {
    throw new CheckConfigurationError(`Unknown fixture pre-tool check mode: ${mode}.`);
  }
  return mode as CheckMode;
}

export function parseCheckDelay(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CHECK_DELAY_MS;
  const delay = Number(value);
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000) {
    throw new CheckConfigurationError("Fixture pre-tool check delay must be an integer from 0 to 60000 ms.");
  }
  return delay;
}

interface ToolCallLike {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export interface PreToolCheckContext {
  event: ToolCallLike;
  loadedPolicy: LoadedPolicy;
  binding: TaskBinding;
  mode: CheckMode;
  delayMs: number;
  audit: AuditSink;
}

export type PreToolCheckResult = { block: true; reason: string } | undefined;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * OMP's `tool_call` seam. The hook is the first enforcement layer: it denies
 * unknown tools and exercises fixture-controlled allow/deny/delay/throw/timeout
 * paths. A throwing or timed-out handler makes OMP fail closed. The business
 * tool independently rechecks policy; this hook is not an OS sandbox.
 */
export async function runPreToolCheck(context: PreToolCheckContext): Promise<PreToolCheckResult> {
  const { event, loadedPolicy, binding, mode, delayMs, audit } = context;
  const identity = identityOf(binding);
  const base = {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    policyId: loadedPolicy.policy.policyId,
    policyVersion: loadedPolicy.policy.policyVersion,
    ...identity,
  };
  audit({ type: "pre_tool_check_started", mode, ...base });

  if (event.toolName === STATUS_TOOL) {
    audit({ type: "pre_tool_check_allowed", reason: "read-only status", ...base });
    return undefined;
  }
  if (event.toolName !== BUSINESS_TOOL) {
    audit({ type: "pre_tool_check_denied", reason: "tool not in managed policy set", ...base });
    return { block: true, reason: `Tool ${event.toolName} is outside the managed policy tool set.` };
  }

  if (mode === "deny") {
    audit({ type: "pre_tool_check_denied", reason: "fixture deny", ...base });
    return { block: true, reason: "The managed pre-tool policy denied this business action." };
  }
  if (mode === "throw") {
    audit({ type: "pre_tool_check_threw", reason: "fixture throw", ...base });
    // OMP converts a handler exception into a blocked tool call.
    throw new Error("Managed pre-tool check failed (fixture throw); the business action was blocked.");
  }

  const started = Date.now();
  if (mode === "timeout" || mode === "delay") {
    audit({ type: "pre_tool_check_delayed", delayMs, ...base });
    await sleep(delayMs);
  }
  audit({ type: "pre_tool_check_allowed", elapsedMs: Date.now() - started, ...base });
  return undefined;
}
