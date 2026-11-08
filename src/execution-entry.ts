import path from "node:path";
import { createFileAudit, type AuditEvent, type AuditSink } from "./audit.ts";
import type { AcceptanceContract, TrustedContractSpec } from "./acceptance-contract.ts";
import {
  EXECUTION_TOOL,
  ExecutionAdapter,
  ExecutionAdapterError,
  executionErrorResult,
  parseExecutionArguments,
  type ExecutionInputConfig,
} from "./execution-adapter.ts";
import { currentTaskOwner, type OmpToolContext } from "./task-entry-port.ts";
import { createDeliveryEntry, type DeliveryEntryControls } from "./delivery-entry.ts";
import { DeliveryService } from "./delivery-service.ts";
import { AcceptanceService } from "./acceptance-service.ts";
import type { HumanReviewOption } from "./human-review-types.ts";
import {
  createVerificationEntry,
  type VerificationCurrentContract,
  type VerificationHostControls,
} from "./verification-entry.ts";
import type { VerificationLookup } from "./verification-service.ts";
import type { TrustedVerifier } from "./verification-service.ts";

/**
 * Explicit G2-A1 execution entry. Loaded only by a private harness after the
 * task owner exists. It registers exactly one generic capability and never
 * installs a global tool_call blocker or a second model loop.
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

export const EXECUTION_ENTRY_VERSION = "0.1.0-g2b2a.0";

const EXECUTION_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["describe", "run"],
      description: "Describe the current visible task's runtimes, limits and authorized input handles, or run one bounded task-local script.",
    },
    runtime: {
      type: "string",
      enum: ["python", "bun"],
      description: "Host-supported runtime for run. The host, not the model, selects the actual interpreter path.",
    },
    source: {
      type: "string",
      description: "Task-local UTF-8 script source for run. Not a global installation; the host enforces size and isolation.",
    },
    inputIds: {
      type: "array",
      items: { type: "string" },
      maxItems: 8,
      description: "Host-authorized input handles to copy read-only into the child sandbox. Unknown handles are refused.",
    },
    expectedTaskId: {
      type: "string",
      description: "Required for run. Optional for describe only together with expectedTaskRevision: the pair must match the currently visible task, never a retained task, and is never authority.",
    },
    expectedTaskRevision: {
      type: "integer",
      minimum: 1,
      description: "Required for run. Optional for describe only together with expectedTaskId: the pair must match the currently visible task revision and never selects history.",
    },
  },
  // OMP 18.18 repairs a closed object schema by deleting unknown keys before
  // execute. Passthrough keeps them for the strict parser, which rejects
  // host-authority fields instead of silently normalizing them.
  additionalProperties: true,
  required: ["action"],
} as const;

const DESCRIPTION = "Generic local candidate execution for the current managed task. describe reports the versioned model-visible execution view: actual host-selected Python/Bun versions, truthful limits, the current task identity/revision, authorized input handles (id, bytes, sha256, writable:false, availability) and remaining launch attempts without creating authority. describe optionally accepts BOTH expectedTaskId and expectedTaskRevision from the current host task view; when present they must match the currently visible task and never select retained history, and when absent describe remains an unguarded read of that current visible view. run executes one bounded task-local Python or Bun script in a fresh private work directory. run requires expectedTaskId and expectedTaskRevision from the current host task view; both are optimistic guards, never authority, and a missing or wrong value is rejected before admission, launch budget, staging or spawn. Inside the script, cwd is that writable workDir; OMP_WORK_DIR and OMP_INPUTS_MANIFEST are host-provided environment entries. Read OMP_INPUTS_MANIFEST as JSON; manifest.handles[inputId] is {path, bytes, sha256, writable:false} and the manifest also carries workDir, sourcePath and runtime. Pass inputIds to stage read-only copies, use only the current manifest paths, use only runtime stdlib/builtins (no installs, network or subprocess creation), and write intended candidate files as ordinary top-level files directly in the current cwd with relative paths so the host archives them; no copy-back to a host workspace is supported. Every run is fresh, and previous-run archives are not automatically readable or writable inputs. run returns the real runId/revision/runtime, observed process and watchdog facts, explicit output observed/retained/shown/omitted/truncated counts, candidate artifact rows with artifactId/relativePath/archiveRef/bytes/sha256, export rejections, host-record/control errors, taskAccepted:false and remaining attempts. Exit 0 is candidate generation only and is never task acceptance. Delivery policy: after producing the registered artifacts intended for the final candidate report, use agent_verify on that current task/revision/run/artifact selection before the final report; intermediate exploration outputs need not be verified. Script self-tests are supplementary and do not replace host-configured verification. Verification is distinct from owner acceptance, so an unavailable task-acceptance operation is not a reason to skip verification. Report the actual host outcome, coverage and remaining gaps: on fail, use feedback to repair and submit a new candidate if justified; on insufficient coverage, explain missing checks or review and never repeatedly verify the same unchanged candidate merely to seek a pass. Do not imply verified or accepted beyond evidence. If no current registered candidate exists or verification cannot act due to cancellation or unavailability, report that limitation and never invent selectors or receipts. The host chooses paths, runtime, environment and limits; paths, shell commands, environment variables, endpoints, identities, budgets and policies are not accepted from the model; unknown or host-authority fields are refused by the plugin.";

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({ type: "omp_agent_execution", message, ...(details === undefined ? {} : { details }) })}\n`);
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

/**
 * Exact, default-off environment opt-in. Absent or the exact empty string
 * means off; every other value, including whitespace-only text, is a
 * configuration error, never a permissive downgrade.
 */
export function parseHumanReviewEnv(value: string | undefined): HumanReviewOption | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "local-main-tui-v1") {
    throw new ExecutionAdapterError("OMP_AGENT_HUMAN_REVIEW must be exactly local-main-tui-v1 when set.");
  }
  return { kind: "local-main-tui", policyVersion: 1 };
}

export interface ExecutionEntryOptions {
  root: string;
  inputs?: readonly ExecutionInputConfig[];
  capabilityId?: string;
  auditPath?: string;
  pythonPath?: string;
  bunPath?: string;
  launcherPath?: string;
  dispatchWallMs?: number;
  terminationGraceMs?: number;
  /** Host-only trusted verifier implementations; never model-selectable. */
  trustedVerifiers?: readonly TrustedVerifier[];
  /**
   * Explicit absolute host delivery root. When absent, no delivery tool is
   * registered and no delivery files can be created.
   */
  deliveryRoot?: string;
  /**
   * Explicit absolute private host root for acceptance records. Available only
   * together with deliveryRoot; no model tool is exposed in B2-B1.
   */
  acceptanceRoot?: string;
  /**
   * Default-off human review capability. When enabled, `agent_deliver`
   * exposes the explicit request_review action for the actual local main TUI.
   */
  humanReview?: HumanReviewOption;
}

export interface ExecutionEntryControls {
  adapter: ExecutionAdapter;
  bindContract(context: OmpToolContext, spec: TrustedContractSpec): AcceptanceContract;
  lookup(context: OmpToolContext, receiptId: string): Promise<VerificationLookup | null>;
  currentContract(context: OmpToolContext): VerificationCurrentContract;
  /** Present only when the host explicitly configured a delivery root. */
  delivery?: DeliveryService;
  /** Present only when both deliveryRoot and acceptanceRoot are configured. */
  acceptance?: AcceptanceService;
  dispose(): void;
}

/**
 * Build the entry around the already-published owner. Exported for the private
 * harness and unit tests; the default export is the OMP factory.
 */
export function createExecutionEntry(pi: OmpApi, options: ExecutionEntryOptions): ExecutionEntryControls {
  const owner = currentTaskOwner();
  if (!owner) throw new ExecutionAdapterError("The task owner must be loaded before the execution entry.");
  if (!path.isAbsolute(options.root)) throw new ExecutionAdapterError("Execution root must be absolute.");
  if (options.acceptanceRoot !== undefined) {
    if (options.deliveryRoot === undefined) {
      throw new ExecutionAdapterError("acceptanceRoot requires an explicit deliveryRoot.");
    }
    if (!path.isAbsolute(options.acceptanceRoot)) {
      throw new ExecutionAdapterError("acceptanceRoot must be an explicit absolute host path.");
    }
  }
  if (options.humanReview !== undefined && options.humanReview !== false) {
    if (options.deliveryRoot === undefined || options.acceptanceRoot === undefined) {
      throw new ExecutionAdapterError("humanReview requires explicit deliveryRoot and acceptanceRoot.");
    }
    const value = options.humanReview as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ExecutionAdapterError("humanReview must be false or an explicit local-main-tui host option.");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2
      || !keys.includes("kind")
      || !keys.includes("policyVersion")
      || record.kind !== "local-main-tui"
      || record.policyVersion !== 1) {
      throw new ExecutionAdapterError("humanReview must be {kind:'local-main-tui', policyVersion:1}.");
    }
  }
  const audit = createFileAudit(options.auditPath);
  const adapter = new ExecutionAdapter(owner, {
    root: options.root,
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
    ...(options.capabilityId === undefined ? {} : { capabilityId: options.capabilityId }),
    ...(options.auditPath === undefined ? {} : { auditPath: options.auditPath }),
    ...(options.pythonPath === undefined ? {} : { pythonPath: options.pythonPath }),
    ...(options.bunPath === undefined ? {} : { bunPath: options.bunPath }),
    ...(options.launcherPath === undefined ? {} : { launcherPath: options.launcherPath }),
    ...(options.dispatchWallMs === undefined ? {} : { dispatchWallMs: options.dispatchWallMs }),
    ...(options.terminationGraceMs === undefined ? {} : { terminationGraceMs: options.terminationGraceMs }),
  });
  safeAudit(audit, { type: "execution_entry_started", version: EXECUTION_ENTRY_VERSION });

  let disposed = false;
  let verification: VerificationHostControls;
  try {
    verification = createVerificationEntry(pi, {
      owner,
      candidates: adapter.candidates,
      workspaceRoot: owner.workspaceRoot,
      ...(options.trustedVerifiers === undefined ? {} : { trustedVerifiers: options.trustedVerifiers }),
    });
  } catch (error) {
    adapter.dispose();
    throw error;
  }

  // The fourth tool exists only on an explicit absolute host delivery root.
  // A misconfigured root fails closed: every already-created service is
  // released and the already-registered handlers fail closed. Acceptance is
  // validated and constructed before the tool is registered so a failed
  // opt-in cannot leave an operative delivery handler behind.
  let deliveryService: DeliveryService | undefined;
  let acceptanceService: AcceptanceService | undefined;
  let deliveryEntry: DeliveryEntryControls | undefined;
  if (options.deliveryRoot !== undefined) {
    try {
      deliveryService = new DeliveryService({
        owner,
        candidates: adapter.candidates,
        activity: () => adapter.activitySnapshot(),
        currentContract: verification.currentContract,
        lookup: verification.lookup,
        deliveryRoot: options.deliveryRoot,
        executionRoot: options.root,
      });
      if (options.acceptanceRoot !== undefined) {
        acceptanceService = new AcceptanceService({
          owner,
          delivery: deliveryService,
          activity: () => adapter.activitySnapshot(),
          acceptanceRoot: options.acceptanceRoot,
          executionRoot: options.root,
          ...(options.humanReview === undefined ? {} : { humanReview: options.humanReview }),
        });
      }
      deliveryService.setAcceptanceConfigured(acceptanceService !== undefined);
      deliveryEntry = createDeliveryEntry(pi, {
        owner,
        service: deliveryService,
        ...(acceptanceService === undefined ? {} : { acceptance: acceptanceService }),
      });
    } catch (error) {
      deliveryEntry?.dispose();
      acceptanceService?.dispose();
      deliveryService?.dispose();
      verification.dispose();
      adapter.dispose();
      throw error;
    }
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    acceptanceService?.dispose();
    deliveryEntry?.dispose();
    verification.dispose();
    adapter.dispose();
  };

  const ownerStillCurrent = (): boolean => currentTaskOwner() === owner;
  const ownerChangedResult = (): ReturnType<typeof executionErrorResult> => {
    safeAudit(audit, { type: "execution_tool_rejected", error: "the published task owner changed" });
    return executionErrorResult(
      "the managed task owner changed; this entry can no longer act for the current task.",
      { taskAccepted: null, currentTaskStatus: null },
    );
  };

  try {
    pi.registerTool({
      name: EXECUTION_TOOL,
      label: "Generic local execution",
      description: DESCRIPTION,
      parameters: EXECUTION_PARAMETERS,
      approval: "exec",
      loadMode: "essential",
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        if (disposed) {
          return executionErrorResult(
            "the execution entry is disposed; no effect occurred.",
            { taskAccepted: null, currentTaskStatus: null },
          );
        }
        if (!ownerStillCurrent()) return ownerChangedResult();
        try {
          const parsed = parseExecutionArguments(params);
          if (signal?.aborted) {
            safeAudit(audit, { type: "execution_tool_aborted", action: parsed.action });
            return executionErrorResult(
              "the call was aborted before the execution adapter acted; no effect occurred.",
              adapter.visibleTerminalFacts(context),
            );
          }
          safeAudit(audit, {
            type: "execution_tool_attempt",
            action: parsed.action,
            runtime: parsed.action === "run" ? parsed.runtime : null,
            sessionId: context.sessionManager?.getSessionId() ?? null,
            agentKind: context.agent?.kind === "main" ? "main" : "sub",
          });
          // The audit sink is a host callback and may replace the published
          // owner. Never rebind this already-created adapter to another owner.
          if (!ownerStillCurrent()) return ownerChangedResult();
          if (parsed.action === "describe") {
            const described = await adapter.describe(context, parsed);
            // The adapter's own await may cross a microtask boundary after a
            // host callback changes the published owner or the entry disposes.
            // Re-seal at the entry before any describe metadata is returned.
            if (disposed) {
              return executionErrorResult(
                "the execution entry is disposed; no effect occurred.",
                { taskAccepted: null, currentTaskStatus: null },
              );
            }
            if (!ownerStillCurrent()) return ownerChangedResult();
            return described;
          }
          return await adapter.run(context, parsed, signal);
        } catch (error) {
          safeAudit(audit, { type: "execution_tool_rejected", error: errorMessage(error) });
          return executionErrorResult(errorMessage(error), adapter.visibleTerminalFacts(context));
        }
      },
    });
  } catch (error) {
    dispose();
    throw error;
  }
  safeAudit(audit, { type: "execution_tool_registered", name: EXECUTION_TOOL });

  try {
    pi.on("session_shutdown", () => {
      dispose();
      return undefined;
    });
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    adapter,
    bindContract: verification.bindContract,
    lookup: verification.lookup,
    currentContract: verification.currentContract,
    ...(deliveryService === undefined ? {} : { delivery: deliveryService }),
    ...(acceptanceService === undefined ? {} : { acceptance: acceptanceService }),
    dispose,
  };
}

function parseInputManifest(value: string | undefined): ExecutionInputConfig[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ExecutionAdapterError("OMP_AGENT_EXECUTION_INPUTS must be a JSON array of {id,path} records.");
  }
  if (!Array.isArray(parsed)) {
    throw new ExecutionAdapterError("OMP_AGENT_EXECUTION_INPUTS must be a JSON array of {id,path} records.");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ExecutionAdapterError("each execution input must be an {id,path} record.");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.path !== "string") {
      throw new ExecutionAdapterError("each execution input must have string id and path fields.");
    }
    return { id: record.id, path: record.path };
  });
}

export default function g2a1ExecutionEntry(pi: OmpApi): void {
  const root = optionalEnv("OMP_AGENT_EXECUTION_ROOT");
  if (!root || !path.isAbsolute(root)) {
    stderr("entry_disabled", {
      reason: "OMP_AGENT_EXECUTION_ROOT must be an absolute path; no execution tool was registered.",
    });
    return;
  }
  let inputs: ExecutionInputConfig[];
  try {
    inputs = parseInputManifest(optionalEnv("OMP_AGENT_EXECUTION_INPUTS"));
  } catch (error) {
    stderr("entry_disabled", { reason: errorMessage(error) });
    return;
  }
  const timeoutText = optionalEnv("OMP_AGENT_EXECUTION_TIMEOUT_MS");
  let dispatchWallMs: number | undefined;
  if (timeoutText !== undefined) {
    const parsed = Number(timeoutText);
    if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
      stderr("entry_disabled", { reason: "OMP_AGENT_EXECUTION_TIMEOUT_MS must be an integer between 100 and 60000." });
      return;
    }
    dispatchWallMs = parsed;
  }
  let humanReview: HumanReviewOption | undefined;
  try {
    humanReview = parseHumanReviewEnv(process.env.OMP_AGENT_HUMAN_REVIEW);
  } catch (error) {
    stderr("entry_disabled", { reason: errorMessage(error) });
    return;
  }
  const deliveryRoot = optionalEnv("OMP_AGENT_DELIVERY_ROOT");
  const acceptanceRoot = optionalEnv("OMP_AGENT_ACCEPTANCE_ROOT");
  if (humanReview !== undefined && (deliveryRoot === undefined || acceptanceRoot === undefined)) {
    stderr("entry_disabled", {
      reason: "OMP_AGENT_HUMAN_REVIEW=local-main-tui-v1 requires OMP_AGENT_DELIVERY_ROOT and OMP_AGENT_ACCEPTANCE_ROOT.",
    });
    return;
  }
  try {
    createExecutionEntry(pi, {
      root,
      inputs,
      ...(optionalEnv("OMP_AGENT_EXECUTION_CAPABILITY") === undefined
        ? {}
        : { capabilityId: optionalEnv("OMP_AGENT_EXECUTION_CAPABILITY")! }),
      ...(optionalEnv("OMP_AGENT_EXECUTION_AUDIT_PATH") === undefined
        ? {}
        : { auditPath: optionalEnv("OMP_AGENT_EXECUTION_AUDIT_PATH")! }),
      ...(optionalEnv("OMP_AGENT_EXECUTION_PYTHON") === undefined
        ? {}
        : { pythonPath: optionalEnv("OMP_AGENT_EXECUTION_PYTHON")! }),
      ...(optionalEnv("OMP_AGENT_EXECUTION_BUN") === undefined
        ? {}
        : { bunPath: optionalEnv("OMP_AGENT_EXECUTION_BUN")! }),
      ...(optionalEnv("OMP_AGENT_EXECUTION_LAUNCHER") === undefined
        ? {}
        : { launcherPath: optionalEnv("OMP_AGENT_EXECUTION_LAUNCHER")! }),
      ...(dispatchWallMs === undefined ? {} : { dispatchWallMs }),
      ...(deliveryRoot === undefined ? {} : { deliveryRoot }),
      ...(acceptanceRoot === undefined ? {} : { acceptanceRoot }),
      ...(humanReview === undefined ? {} : { humanReview }),
    });
  } catch (error) {
    stderr("entry_disabled", { reason: errorMessage(error) });
  }
}
