import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { createFileAudit } from "./audit.ts";
import {
  DAILY_CONFIG_SCHEMA_VERSION,
  loadDailyConfig,
  type DailyConfig,
  type LoadDailyConfigOptions,
} from "./daily-config.ts";
import { DELIVERY_TOOL } from "./delivery-entry.ts";
import { EXECUTION_TOOL } from "./execution-adapter.ts";
import {
  createExecutionEntry,
  type ExecutionEntryControls,
} from "./execution-entry.ts";
import {
  createHistoryEntry,
  type HistoryEntryControls,
} from "./history-entry.ts";
import {
  createHistorySession,
  type HistorySessionControls,
} from "./history-session.ts";
import {
  clearPublishedTaskOwner,
  currentTaskOwner,
  type OmpToolContext,
} from "./task-entry-port.ts";
import { createTaskEntry } from "./task-entry.ts";
import type { TaskOwner } from "./task-owner.ts";
import type { HumanReviewHostOption } from "./human-review-types.ts";
import { VERIFICATION_TOOL } from "./verification-entry.ts";

/**
 * B3-B2 one ordinary OMP entry.
 *
 * The default export is the real extension factory. It composes the already
 * accepted task and execution factories around one fresh private instance,
 * stages all registrations so real controls exist before OMP sees them, then
 * installs shared-inactive wrappers. Only after state/audit/owner/service
 * readiness is verified do the wrappers become active. OMP native tools,
 * skills, rules, model selection and ordinary conversations are untouched.
 */

export const DAILY_ENTRY_VERSION = "0.1.0-b3b2.1";
export const DAILY_ENTRY_CAPABILITY = "local-script";
export const DAILY_INSTANCE_DIRS = ["execution", "delivery", "acceptance"] as const;
export const DAILY_GUIDANCE_TYPE = "omp-agent.daily.workflow-guidance";

/**
 * Fixed advisory text for the real daily composition. It grants nothing and
 * never substitutes tool-side checks for host verification or acceptance.
 */
const DAILY_WORKFLOW_GUIDANCE = [
  "This session composes managed task control with controlled execution, host verification and candidate delivery.",
  "Ordinary conversation needs no task.",
  "When the current genuine request should be managed, establish its task first and reuse the actual host-visible task identity and revision; do not invent selectors or blindly inspect tasks that do not exist.",
  `For files that are results of that managed task, including prose, reports and structured data, use ${EXECUTION_TOOL} to generate registered candidate files inside the managed work directory; a simple task-local Python or Bun script can write model-authored content, and supplied files must use actual authorized input handles.`,
  "Native workspace writes and shell self-tests do not create managed candidates or receipts; do not present them as such.",
  `After the intended final registered candidate, call ${VERIFICATION_TOOL} on that exact returned runId and artifactIds, and use ${DELIVERY_TOOL} preview when the user needs a readable file path.`,
  "Report the actual outcome and coverage, distinguish generated, verified and accepted, never call insufficient a pass, and never repeat verification of unchanged candidates to seek one.",
  "Keep task-local checks proportional and the final response concise; self-tests supplement host verification, and extra exploration or process narration is unnecessary when the facts already suffice.",
  "If the execution capability is absent or the user's constraints disallow this route, report the scoped limitation without fabricating a run, switching languages against the request, forcing a task, tool or file, or bypassing through native tools; an honest zero-tool answer remains valid.",
  "This is advisory workflow guidance, not authority, approval, a user request, a bypass or a forced task; native tools remain available.",
].join(" ");

export interface DailyInstance {
  instanceId: string;
  root: string;
  executionRoot: string;
  deliveryRoot: string;
  acceptanceRoot: string;
  statePath: string;
  auditPath: string;
}

export interface DailyEntryOptions extends LoadDailyConfigOptions {}

export interface DailyEntryControls {
  config: DailyConfig;
  instance: DailyInstance;
  owner: TaskOwner;
  execution: ExecutionEntryControls;
  /** B1 capture and native-locator diagnostics; no resume surface exists. */
  history: HistorySessionControls;
  /** B2a main-only read-only query over actual branch locators. */
  historyQuery: HistoryEntryControls;
  isReady(): boolean;
  dispose(): void;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface DailyTool {
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
  ): Promise<ToolResult>;
  [key: string]: unknown;
}

/** Real OMP host surface used by this composition; no runtime is imported. */
export interface DailyOmpApi {
  on(event: string, handler: (event: unknown, context: OmpToolContext) => unknown): void;
  registerTool(tool: DailyTool): void;
  /** Public OMP session custom-entry append; absent on older/minimal hosts. */
  appendEntry?<T = unknown>(customType: string, data?: T): void;
  logger?: { warn(message: string, details?: unknown): void };
}

type StagedHandler = (event: never, context: OmpToolContext) => unknown;

type StagedRegistration =
  | { kind: "handler"; event: string; handler: StagedHandler }
  | { kind: "tool"; tool: DailyTool };

interface StagingApi {
  on(event: string, handler: StagedHandler): void;
  registerTool(tool: DailyTool): void;
}

interface TaskEntryControls {
  owner: TaskOwner;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({
      type: "omp_agent_daily_entry",
      message,
      ...(details === undefined ? {} : { details }),
    })}\n`);
  } catch {
    // A diagnostic channel is not guaranteed.
  }
}

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Create each missing component as a real 0700 directory; never chmod existing. */
function ensurePrivateDirectory(target: string): void {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`state directory component is a symbolic link: ${cursor}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`state directory component is not a directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing) mkdirSync(directory, { mode: 0o700 });
  const created = lstatSync(resolved);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error("state directory was not created as a real directory");
  }
}

/**
 * Fresh host instance. Existing instance directories are never scanned,
 * rehydrated, replaced or removed; a collision is refused by mkdirSync.
 */
export function prepareDailyInstance(config: DailyConfig): DailyInstance {
  ensurePrivateDirectory(config.stateRoot);
  const instancesRoot = path.join(config.stateRoot, "instances");
  ensurePrivateDirectory(instancesRoot);
  const instanceId = randomUUID();
  const root = path.join(instancesRoot, instanceId);
  mkdirSync(root, { mode: 0o700 });
  const roots: Record<(typeof DAILY_INSTANCE_DIRS)[number], string> = {
    execution: path.join(root, "execution"),
    delivery: path.join(root, "delivery"),
    acceptance: path.join(root, "acceptance"),
  };
  for (const name of DAILY_INSTANCE_DIRS) {
    mkdirSync(roots[name], { mode: 0o700 });
    const info = lstatSync(roots[name]);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`daily instance root ${name} is not a real directory`);
    }
  }
  const statePath = path.join(root, "task-state.json");
  const auditPath = path.join(root, "audit.jsonl");
  for (const name of DAILY_INSTANCE_DIRS) {
    const component = roots[name];
    if (withinOrEqual(component, statePath) || withinOrEqual(component, auditPath)) {
      throw new Error("daily task state or audit overlaps a delivery/execution/acceptance root");
    }
  }
  const executionRoot = roots.execution;
  const deliveryRoot = roots.delivery;
  const acceptanceRoot = roots.acceptance;
  if (withinOrEqual(executionRoot, deliveryRoot)
    || withinOrEqual(executionRoot, acceptanceRoot)
    || withinOrEqual(deliveryRoot, executionRoot)
    || withinOrEqual(deliveryRoot, acceptanceRoot)
    || withinOrEqual(acceptanceRoot, executionRoot)
    || withinOrEqual(acceptanceRoot, deliveryRoot)) {
    throw new Error("daily execution, delivery and acceptance roots must not overlap");
  }
  return {
    instanceId,
    root,
    executionRoot,
    deliveryRoot,
    acceptanceRoot,
    statePath,
    auditPath,
  };
}

function createStaging(): { api: StagingApi; entries: StagedRegistration[] } {
  const entries: StagedRegistration[] = [];
  let open = true;
  const api: StagingApi = {
    on(event, handler) {
      if (!open) throw new Error("daily registration staging is closed");
      entries.push({ kind: "handler", event, handler });
    },
    registerTool(tool) {
      if (!open) throw new Error("daily registration staging is closed");
      entries.push({ kind: "tool", tool });
    },
  };
  return { api, entries };
}

function inactiveToolResult(name: string): ToolResult {
  return {
    content: [{
      type: "text",
      text: `${name}: the daily entry is not active; no managed effect occurred.`,
    }],
    details: { error: "daily_entry_inactive", tool: name },
    isError: true,
  };
}

function readStateSnapshot(instance: DailyInstance): Record<string, unknown> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(instance.statePath);
  } catch (error) {
    throw new Error(`managed task state was not persisted at startup: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("managed task state is not valid JSON after startup.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("managed task state is not a snapshot object after startup.");
  }
  return value as Record<string, unknown>;
}

function auditText(instance: DailyInstance): string {
  try {
    return readFileSync(instance.auditPath, "utf8");
  } catch (error) {
    throw new Error(`managed startup audit was not written: ${errorMessage(error)}`);
  }
}

/**
 * Build one daily composition. Exported for focused tests and a future
 * explicit onboarding path; the default export below is the OMP factory.
 */
export function createDailyEntry(pi: DailyOmpApi, options: DailyEntryOptions = {}): DailyEntryControls {
  if (currentTaskOwner() !== undefined) {
    throw new Error(
      "A managed task owner is already published. Refusing to replace or clear it; stop the other entry, then restart OMP.",
    );
  }

  const config = loadDailyConfig(options);
  const instance = prepareDailyInstance(config);
  const staging = createStaging();

  let active = false;
  let disposed = false;
  let taskEntry: TaskEntryControls | undefined;
  let execution: ExecutionEntryControls | undefined;
  let history: HistorySessionControls | undefined;
  let historyQuery: HistoryEntryControls | undefined;
  let orphanOwner: TaskOwner | undefined;

  const disposeServices = (): void => {
    if (disposed) return;
    disposed = true;
    active = false;
    try {
      historyQuery?.dispose();
    } catch (error) {
      stderr("history_query_dispose_failed", { error: errorMessage(error) });
    }
    try {
      history?.dispose();
    } catch (error) {
      stderr("history_dispose_failed", { error: errorMessage(error) });
    }
    try {
      execution?.dispose();
    } catch (error) {
      stderr("execution_dispose_failed", { error: errorMessage(error) });
    }
    try {
      taskEntry?.dispose();
    } catch (error) {
      stderr("task_owner_dispose_failed", { error: errorMessage(error) });
    }
    if (taskEntry === undefined && orphanOwner !== undefined) {
      try {
        clearPublishedTaskOwner(orphanOwner);
      } catch (error) {
        stderr("orphan_owner_clear_failed", { error: errorMessage(error) });
      }
    }
  };

  try {
    const beforeTaskOwner = currentTaskOwner();
    if (beforeTaskOwner !== undefined) {
      throw new Error(
        "A managed task owner was published during daily configuration; refusing to replace or clear it.",
      );
    }
    let createdTaskEntry: TaskEntryControls;
    try {
      createdTaskEntry = createTaskEntry(
        staging.api as unknown as Parameters<typeof createTaskEntry>[0],
        {
          workspaceRoot: config.workspaceRoot,
          statePath: instance.statePath,
          auditPath: instance.auditPath,
          capabilities: [DAILY_ENTRY_CAPABILITY],
          additionalTrustedControlTypes: [DAILY_GUIDANCE_TYPE],
        },
      );
    } catch (error) {
      const published = currentTaskOwner();
      if (beforeTaskOwner === undefined && published !== undefined) orphanOwner = published;
      throw error;
    }
    taskEntry = createdTaskEntry;
    if (currentTaskOwner() !== taskEntry.owner) {
      throw new Error(
        "The published managed task owner changed during task composition; refusing to let execution capture a replacement.",
      );
    }

    // The history component subscribes synchronously to this owner before the
    // composition is active. It captures only the four committed task events
    // and publishes from the real main-agent end handler staged below.
    const historyAudit = createFileAudit(instance.auditPath);
    const createdHistory = createHistorySession({
      owner: taskEntry.owner,
      instanceRoot: instance.root,
      instanceId: instance.instanceId,
      workspaceRoot: config.workspaceRoot,
      ...(pi.appendEntry === undefined ? {} : {
        appendEntry: (customType: string, data?: unknown) => pi.appendEntry?.(customType, data),
      }),
      report: (type, details) => {
        try {
          historyAudit({ type: `history_${type}`, ...details });
        } catch {
          // The existing audit channel may be unavailable; capture continues.
        }
        if (type === "unknown" || type === "unavailable") {
          try {
            pi.logger?.warn(`history ${type}`, details);
          } catch {
            // Host logging is optional.
          }
        }
      },
    });
    history = createdHistory;
    if (currentTaskOwner() !== taskEntry.owner) {
      throw new Error(
        "The published managed task owner changed during history composition; refusing mixed services.",
      );
    }

    // The query is a separate read-only view over B1 locators. It never reads
    // the owner, creates a task or restores authority.
    const publishedOwner = taskEntry.owner;
    const createdHistoryQuery = createHistoryEntry(
      { registerTool: (tool) => staging.api.registerTool(tool) },
      {
        stateRoot: config.stateRoot,
        workspaceRoot: config.workspaceRoot,
        isCurrentComposition: () => !disposed && active && currentTaskOwner() === publishedOwner,
      },
    );
    historyQuery = createdHistoryQuery;

    // Navigation invalidates old pending locator eligibility and every issued
    // query selector/cursor before any later turn can look like a similar
    // source. Subagent lifecycle events cannot consume the main composition.
    for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
      staging.api.on(eventName, (_event, context) => {
        if (context.agent?.kind === "sub") return undefined;
        createdHistory.navigate(eventName);
        createdHistoryQuery.navigate(eventName);
        return undefined;
      });
    }
    // Registered after the task-entry agent_end handler because task entry
    // staged its handlers first. Only this actual main-agent context may
    // publish pending locators.
    staging.api.on("agent_end", async (event, context) => {
      try {
        await createdHistory.handleAgentEnd(event, context);
      } catch (error) {
        stderr("history_agent_end_failed", { error: errorMessage(error) });
      }
      return undefined;
    });

    const executionControls = createExecutionEntry(
      staging.api as unknown as Parameters<typeof createExecutionEntry>[0],
      {
        root: instance.executionRoot,
        inputs: config.inputs,
        capabilityId: DAILY_ENTRY_CAPABILITY,
        auditPath: instance.auditPath,
        ...(config.pythonPath === undefined ? {} : { pythonPath: config.pythonPath }),
        ...(config.bunPath === undefined ? {} : { bunPath: config.bunPath }),
        deliveryRoot: instance.deliveryRoot,
        acceptanceRoot: instance.acceptanceRoot,
        ...(config.humanReview === undefined ? {} : { humanReview: config.humanReview }),
      },
    );
    execution = executionControls;
    if (currentTaskOwner() !== taskEntry.owner) {
      throw new Error(
        "The published managed task owner changed during execution composition; refusing mixed services.",
      );
    }
    if (execution.delivery === undefined || execution.acceptance === undefined) {
      throw new Error("daily execution composition did not assemble delivery and acceptance.");
    }

    // A separate fixed message beside the task entry's own guidance. Extension
    // dispatch collects every handler's message, so this does not replace or
    // rewrite task-control guidance. It is main-only, ignores prompt input,
    // and remains inactive until the whole composition is ready.
    staging.api.on("before_agent_start", (_event, context) => {
      if (context.agent?.kind !== "main") return undefined;
      return {
        message: {
          customType: DAILY_GUIDANCE_TYPE,
          content: DAILY_WORKFLOW_GUIDANCE,
          display: false,
          attribution: "agent" as const,
        },
      };
    });

    // Install shared-inactive wrappers. Every real registration remains
    // inactive until the final readiness checks below succeed.
    const host = pi;
    for (const entry of staging.entries) {
      if (entry.kind === "handler") {
        host.on(entry.event, (event, context) => {
          if (!active) return undefined;
          if (entry.event === "session_shutdown") {
            // Deactivate before any inner shutdown disposal or owner clearing.
            disposeServices();
            return undefined;
          }
          return (entry.handler as unknown as (event: unknown, context: OmpToolContext) => unknown)(
            event,
            context,
          );
        });
      } else {
        const tool = entry.tool;
        host.registerTool({
          ...tool,
          async execute(toolCallId, params, signal, onUpdate, context) {
            if (!active) return inactiveToolResult(tool.name);
            return await tool.execute(toolCallId, params, signal, onUpdate, context);
          },
        });
      }
    }

    // Real readiness: the published owner is still exactly ours, the task
    // state is persisted with our identity, both composition audit markers
    // exist, and the assembled human-review component matches config.
    if (currentTaskOwner() !== taskEntry.owner) {
      throw new Error(
        "The published managed task owner changed during registration; refusing readiness and leaving the replacement untouched.",
      );
    }
    const snapshot = readStateSnapshot(instance);
    if (snapshot.schemaVersion !== 1
      || snapshot.ownerId !== taskEntry.owner.ownerId
      || snapshot.workspaceRoot !== config.workspaceRoot) {
      throw new Error("Persisted managed task state does not match this daily instance.");
    }
    const before = auditText(instance);
    for (const marker of [
      `"type":"entry_started"`,
      `"type":"execution_entry_started"`,
    ]) {
      if (!before.includes(marker)) {
        throw new Error(`Managed startup audit is missing required marker ${marker}.`);
      }
    }
    const expectedHumanReview = config.humanReview !== undefined;
    if (execution.acceptance.humanReviewConfigured() !== expectedHumanReview) {
      throw new Error("Assembled human-review component does not match the host configuration.");
    }

    createFileAudit(instance.auditPath)({
      type: "daily_entry_ready",
      version: DAILY_ENTRY_VERSION,
      configSchemaVersion: DAILY_CONFIG_SCHEMA_VERSION,
      instanceId: instance.instanceId,
      workspaceRoot: config.workspaceRoot,
      stateRoot: config.stateRoot,
      inputs: config.inputs.length,
      humanReview: expectedHumanReview ? "local-main-tui-v1" : "off",
      capability: DAILY_ENTRY_CAPABILITY,
    });
    active = true;
    return {
      config,
      instance,
      owner: taskEntry.owner,
      execution,
      history: createdHistory,
      historyQuery: createdHistoryQuery,
      isReady: () => active,
      dispose: disposeServices,
    };
  } catch (error) {
    disposeServices();
    throw error;
  }
}

export default function dailyEntry(pi: DailyOmpApi): void {
  try {
    createDailyEntry(pi);
  } catch (error) {
    stderr("daily_entry_disabled", { reason: errorMessage(error) });
  }
}
