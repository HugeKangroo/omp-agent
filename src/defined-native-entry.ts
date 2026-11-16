import {
  loadDefinitionSnapshot,
  type DefinitionModelRef,
  type DefinitionSkillMetadata,
  type DefinitionSnapshot,
} from "./agent-definition.ts";
import {
  AGENT_DEFINITION_FLAG,
  AGENT_DEFINITION_STATUS_COMMAND,
  AGENT_DEFINITION_TOOL,
  DEFINITION_BINDING_SCHEMA,
  DefinitionBindingController,
  type BindingHostFacts,
  type BindingModel,
  type DefinitionBindingDiagnostic,
  type DefinitionLoader,
} from "./definition-binding.ts";
import {
  createNativeEntry,
  NATIVE_WORK_CALL_INSPECTION_SCHEMA,
  type NativeCallCheckPreparation,
  type NativeContext,
  type NativeOmpApi,
  type NativeToolResult,
  type NativeWorkCallCapture,
  type NativeWorkCallInspection,
} from "./native-entry.ts";
import type { NativeInstanceReportPort } from "./native-instance-report.ts";
import { NATIVE_WORK_TOOL } from "./native-work.ts";
import {
  loadOmpDefinitionPorts,
  type OmpDefinitionPorts,
} from "./omp-native-compat.ts";
import { canonicalWorkspaceRoot, currentTaskOwner } from "./task-entry-port.ts";

/**
 * Optional explicitly loaded entry for one host-selected Agent Markdown file.
 *
 * The default package entry stays `daily-entry`. This module registers a string
 * flag synchronously, registers the failure gate before the existing native
 * observer, then starts variable native imports. Every actual host fact is read
 * through the narrow interfaces below; no OMP runtime is imported statically.
 * The internal `session_start` wait defaults to 20s and clamps overrides to
 * 25s, staying below the fixed host's 30s extension-handler deadline.
 */

export const DEFINED_NATIVE_ENTRY_VERSION = "0.1.0-defined-native.1";

const MAX_MODEL_SELECTOR_CHARS = 512;
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const MAX_STARTUP_TIMEOUT_MS = 25_000;

export interface DefinedModel {
  readonly provider: string;
  readonly id: string;
  readonly api?: string;
}

export interface DefinedNativeContext extends NativeContext {
  readonly hasUI?: boolean;
  readonly ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  readonly models?: {
    resolve?(spec: string): DefinedModel | undefined;
    current?(): DefinedModel | undefined;
  };
  readonly model?: DefinedModel | undefined;
  abort?(): void;
  hasPendingMessages?(): boolean;
}

interface DefinedCommandContext extends DefinedNativeContext {
  readonly hasUI?: boolean;
}

/**
 * Existing D1 caller surface; the fixed host projection lives in
 * `omp-native-compat.ts`.
 */
export type DefinedNativePorts = OmpDefinitionPorts;

/**
 * INTERNAL trusted-composition seam used only by the opt-in instanced entry.
 *
 * It is deliberately not a command router or registry. The sibling entry can
 * expose exactly its fixed `/agent-instances-status` display; D1 still runs
 * its own binding gate before that display, so a failed D1 binding is never
 * bypassed. A missing slot leaves the command on the existing host path.
 */
export interface DefinedNativeStatusComposition {
  readonly instanceStatus?: {
    /** True only after the sibling synchronously registered its command. */
    isRegistered(): boolean;
    /** Called only for the fixed instance status token after D1's gate allows it. */
    show(context: DefinedNativeContext): void;
  };
}

export interface DefinedNativeEntryOptions {
  /** Test/integration override; production reads the registered string flag. */
  readonly definitionPath?: string;
  /** Injected native parser/Skill ports; production imports them after registration. */
  readonly nativePorts?: DefinedNativePorts;
  /** Narrow test seam for a deferred loader or a prebuilt snapshot. */
  readonly loadDefinition?: DefinitionLoader;
  /** Bounded session_start wait; default 20s, clamped to at most 25s. */
  readonly startupTimeoutMs?: number;
  readonly diagnostic?: (event: DefinitionBindingDiagnostic) => void;
  /** INTERNAL trusted composition only; never a public command capability. */
  readonly statusComposition?: DefinedNativeStatusComposition;
  /**
   * INTERNAL trusted composition only; forwarded unchanged to
   * createNativeEntry and never read or configured from user/model input.
   */
  readonly instanceReports?: NativeInstanceReportPort;
}

export interface DefinedNativeEntryControls {
  readonly controller: DefinitionBindingController;
  readonly nativeEntry: ReturnType<typeof createNativeEntry>;
  dispose(): void;
}

type NativeTool = Parameters<NativeOmpApi["registerTool"]>[0];
type NativeToolOutcome = Awaited<ReturnType<NativeTool["execute"]>>;
type CommandHandler = (args: string, context: DefinedCommandContext) => Promise<void> | void;

export interface DefinedOmpApi extends NativeOmpApi {
  registerFlag?(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag?(name: string): boolean | string | undefined;
  registerCommand?(
    name: string,
    options: { description?: string; handler: CommandHandler; getArgumentCompletions?: unknown },
  ): void;
  getActiveTools?(): string[];
  setActiveTools?(toolNames: string[]): Promise<void>;
  setModel?(model: DefinedModel): Promise<boolean>;
}

const CLEANUP_EVENTS = new Set([
  "session_start",
  "session_switch",
  "session_branch",
  "session_tree",
  "session_clear",
  "session_shutdown",
]);

const NAVIGATION_EVENTS = [
  "session_switch",
  "session_branch",
  "session_tree",
  "session_clear",
] as const;

function boundMessage(value: string): string {
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= 320) return normalized;
  return `${normalized.slice(0, 317)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const STATUS_COMMAND_INPUT = `/${AGENT_DEFINITION_STATUS_COMMAND}`;
// The sibling entry owns this reserved name; D1 only recognizes it when that
// entry supplies the fixed composition slot below. This is not a command
// registry lookup.
const INSTANCE_STATUS_COMMAND_INPUT = "/agent-instances-status";

type DiagnosticCommand = "definition" | "instances";
type DiagnosticInput =
  | { readonly kind: "exact"; readonly command: DiagnosticCommand }
  | { readonly kind: "malformed"; readonly command: DiagnosticCommand };

/**
 * The fixed host runs the `input` hook before slash-command dispatch. Recognize
 * only the two fixed diagnostic tokens after earlier transforms, from genuine
 * interactive/RPC ingress, and never create a general slash-command bypass.
 *
 * - Exact token, no images: successful diagnostic syntax.
 * - Exact token with nonempty or malformed images: malformed diagnostic syntax.
 * - Token followed by whitespace arguments: malformed diagnostic syntax.
 * - Prefix/suffix/lookalike names and ordinary prose: not recognized.
 *
 * Arguments are refused locally below rather than queued as task text or
 * dispatched to an observer/provider.
 */
function classifyDiagnosticInput(event: unknown): DiagnosticInput | null {
  if (!isRecord(event) || typeof event.text !== "string") return null;
  if (event.source !== "interactive" && event.source !== "rpc") return null;
  const trimmed = event.text.trim();
  const commands: readonly (readonly [DiagnosticCommand, string])[] = [
    ["definition", STATUS_COMMAND_INPUT],
    ["instances", INSTANCE_STATUS_COMMAND_INPUT],
  ];
  for (const [command, token] of commands) {
    if (trimmed === token) {
      const images = event.images;
      if (images !== undefined && (!Array.isArray(images) || images.length !== 0)) {
        return { kind: "malformed", command };
      }
      return { kind: "exact", command };
    }
    if (trimmed.length > token.length
      && trimmed.startsWith(token)
      && /\s/.test(trimmed[token.length] ?? "")) {
      return { kind: "malformed", command };
    }
  }
  return null;
}

function stderr(message: string, details?: unknown): void {
  try {
    process.stderr.write(`${JSON.stringify({
      type: "omp_agent_defined_native_entry",
      message,
      ...(details === undefined ? {} : { details }),
    })}\n`);
  } catch {
    // Observability must not break the host.
  }
}

function asModel(value: unknown): DefinedModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider.length === 0) return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  return value as DefinedModel;
}

function readPendingMessages(context: NativeContext): boolean | null {
  const ctx = context as DefinedNativeContext;
  try {
    const value = ctx.hasPendingMessages?.();
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function readFacts(context: NativeContext): BindingHostFacts {
  const ctx = context as DefinedNativeContext;
  let sessionId: string | null = null;
  let workspaceRoot: string | null = null;
  try {
    const value = ctx.sessionManager?.getSessionId();
    if (typeof value === "string" && value.length > 0) sessionId = value;
  } catch {
    // Identity unavailable; the controller fails closed for a main session.
  }
  try {
    // The live session-manager cwd is what /move updates. ctx.cwd alone is a
    // construction-time snapshot and is never used as a binding identity.
    const value = ctx.sessionManager?.getCwd();
    if (typeof value === "string" && value.length > 0) {
      workspaceRoot = canonicalWorkspaceRoot(value);
    }
  } catch {
    // Identity unavailable; the controller fails closed for a main session.
  }
  const agentKind = ctx.agent?.kind === "main"
    ? "main"
    : ctx.agent?.kind === "sub"
      ? "sub"
      : "unknown";
  return {
    agentKind,
    sessionId,
    workspaceRoot,
    hasUI: ctx.hasUI === true,
    hasPendingMessages: readPendingMessages(context),
  };
}

function readCurrentModel(context: NativeContext): DefinedModel | undefined {
  const ctx = context as DefinedNativeContext;
  try {
    const model = asModel(ctx.models?.current?.());
    if (model !== undefined) return model;
  } catch {
    // Fall through to the direct host model field.
  }
  try {
    return asModel(ctx.model);
  } catch {
    return undefined;
  }
}

function resolveModel(context: NativeContext, selector: string): DefinedModel | undefined {
  if (selector.length === 0 || selector.length > MAX_MODEL_SELECTOR_CHARS) return undefined;
  const ctx = context as DefinedNativeContext;
  try {
    return asModel(ctx.models?.resolve?.(selector));
  } catch {
    throw new Error(`Native model resolution failed for ${JSON.stringify(selector)}.`);
  }
}

function readSkillMetadata(raw: unknown): DefinitionSkillMetadata[] {
  if (!Array.isArray(raw)) {
    throw new Error("getActiveSkills() did not return the native Skill array.");
  }
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Active Skill[${index}] metadata is not an object.`);
    }
    const { name, description, filePath } = entry;
    if (typeof name !== "string" || name.length === 0
      || typeof description !== "string"
      || typeof filePath !== "string" || filePath.length === 0) {
      throw new Error(`Active Skill[${index}] lacks native name/filePath/description metadata.`);
    }
    return { name, description, filePath };
  });
}

function startupTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_STARTUP_TIMEOUT_MS;
  return Math.min(MAX_STARTUP_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

async function awaitBindingStartup(
  controller: DefinitionBindingController,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      controller.whenIdle().then(() => "settled" as const),
      timeout,
    ]);
    if (outcome === "timeout" && controller.phase === "resolving") {
      controller.startupFailed(
        `Definition binding startup timed out after ${timeoutMs}ms; restart is required and a late load cannot revive it.`,
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function nativeLoader(portsPromise: Promise<DefinedNativePorts>): DefinitionLoader {
  return async (input) => {
    const ports = await portsPromise;
    return loadDefinitionSnapshot({
      definitionPath: input.definitionPath,
      workspaceRoot: input.workspaceRoot,
      parseAgent: ports.parseAgent,
      parseFrontmatter: ports.parseFrontmatter,
      availableSkills: readSkillMetadata(ports.getActiveSkills()),
      availableTools: input.availableTools,
      currentModel: input.currentModel,
      resolveModel: input.resolveModel,
      nativeSource: "explicit",
    });
  };
}

function nativeToolError(message: string, status: ReturnType<DefinitionBindingController["getStatus"]>): NativeToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: {
      kind: "definition-binding-error",
      schema: DEFINITION_BINDING_SCHEMA,
      authority: "non-authoritative",
      phase: status.phase,
      failure: status.failure,
      restartRequired: status.restartRequired,
      nativeQueuedMessagesMayBeRetained: status.nativeQueuedMessagesMayBeRetained,
      hasPendingMessages: status.hasPendingMessages,
    },
  };
}

function annotateAgentWorkResult(
  controller: DefinitionBindingController,
  toolName: string,
  result: NativeToolOutcome,
): NativeToolOutcome {
  if (toolName !== NATIVE_WORK_TOOL) return result;
  const binding = controller.getReportBinding();
  if (binding === null) return result;
  const line = [
    `Definition binding observation: ${binding.bindingId}`,
    `version=${binding.version}`,
    `model=${binding.model.provider}/${binding.model.id}`,
    `tools=${binding.effectiveTools.join(",")}`,
    `freezeScope=${binding.freezeScope}`,
    "authority=non-authoritative",
  ].join(" ");
  const details = isRecord(result.details)
    ? { ...result.details, definitionBinding: binding }
    : { definitionBinding: binding };
  return {
    ...result,
    content: [...result.content, { type: "text", text: line }],
    details,
  };
}

function guardedNativeApi(
  pi: DefinedOmpApi,
  controller: DefinitionBindingController,
  touch: (context: NativeContext) => void,
): NativeOmpApi {
  return {
    on(event, handler) {
      if (CLEANUP_EVENTS.has(event)) {
        pi.on(event, handler);
        return;
      }
      pi.on(event, (value, context) => {
        touch(context);
        let allowed = false;
        try {
          allowed = controller.allowsObservation(readFacts(context));
        } catch {
          allowed = false;
        }
        if (!allowed) return undefined;
        return handler(value, context);
      });
    },
    registerTool(tool) {
      pi.registerTool({
        ...tool,
        async execute(toolCallId, params, signal, onUpdate, context) {
          touch(context);
          const facts = readFacts(context);
          let allowed = false;
          try {
            allowed = controller.allowsToolExecution(facts);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            const status = controller.getStatus();
            return nativeToolError(
              boundMessage(`Blocked: ${status.failure ?? `definition binding phase is ${status.phase}`}. No tool ran.`),
              status,
            );
          }
          const result = await tool.execute(toolCallId, params, signal, onUpdate, context);
          return annotateAgentWorkResult(controller, tool.name, result);
        },
      });
    },
  };
}

function registerDefinitionTool(pi: DefinedOmpApi, controller: DefinitionBindingController): void {
  try {
    pi.registerTool({
      name: AGENT_DEFINITION_TOOL,
      label: "Agent definition binding status",
      description:
        "Read-only status of the explicitly selected Agent definition binding. Returns phase, failure, bindingId, session, workspace, version, model, effective/role tools, selected source and freeze scope. It cannot select or change a definition.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      approval: "read",
      loadMode: "essential",
      async execute(_toolCallId, _params, _signal, _onUpdate, context) {
        const facts = readFacts(context);
        if (facts.agentKind !== "main") {
          return {
            content: [{
              type: "text",
              text: `agent_definition is read-only main-session status; the current agent identity is ${facts.agentKind} and has no main binding.`,
            }],
            isError: true,
            details: {
              kind: "definition-binding-status-error",
              schema: DEFINITION_BINDING_SCHEMA,
              authority: "non-authoritative",
              agentKind: facts.agentKind,
            },
          };
        }
        // Status is read-only but must not report a stale bound state after a
        // host model/tool/session change. The check may terminalize the binding.
        controller.allowsObservation(facts);
        const status = controller.getStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status) }],
          details: status,
        };
      },
    });
  } catch (error) {
    controller.startupFailed(`agent_definition tool registration failed: ${errorMessage(error)}`);
  }
}

function showStatusText(
  context: DefinedNativeContext,
  text: string,
  type: "info" | "warning",
  event: string,
): void {
  try {
    if (context.hasUI === true && typeof context.ui?.notify === "function") {
      context.ui.notify(text, type);
      return;
    }
    // Never write raw JSON to stdout: the host owns that stream in RPC.
    stderr(event, { text });
  } catch {
    // A status display failure is not a binding decision.
  }
}

function showDefinitionStatus(
  controller: DefinitionBindingController,
  context: DefinedNativeContext,
): void {
  const facts = readFacts(context);
  if (facts.agentKind === "main") {
    // Refresh actual host facts before reading the frozen status; a stale
    // bound claim after a model/tool change is not allowed.
    controller.allowsObservation(facts);
  }
  const text = facts.agentKind === "main"
    ? JSON.stringify(controller.getStatus())
    : `agent-definition-status is main-session status only; the current agent identity is ${facts.agentKind} and has no main binding.`;
  showStatusText(context, text, facts.agentKind === "main" ? "info" : "warning", "agent_definition_status");
}

function showDefinitionStatusUnavailable(context: DefinedNativeContext): void {
  showStatusText(
    context,
    "agent-definition-status is unavailable: the host did not register the command; no binding status was read.",
    "warning",
    "agent_definition_status_refused",
  );
}

function showDiagnosticSyntaxRefused(context: DefinedNativeContext, command: "definition" | "instances"): void {
  const name = command === "definition" ? "agent-definition-status" : "agent-instances-status";
  showStatusText(
    context,
    `${name} accepts no arguments or images; no command ran.`,
    "warning",
    command === "definition" ? "agent_definition_status_refused" : "agent_instances_status_refused",
  );
}

function registerStatusCommand(pi: DefinedOmpApi, controller: DefinitionBindingController): boolean {
  if (typeof pi.registerCommand !== "function") return false;
  try {
    pi.registerCommand(AGENT_DEFINITION_STATUS_COMMAND, {
      description: "Show read-only agent definition binding status.",
      handler(_args, context) {
        showDefinitionStatus(controller, context);
      },
    });
    return true;
  } catch (error) {
    stderr("status_command_registration_failed", { reason: errorMessage(error) });
    return false;
  }
}

interface DefinitionPathSelection {
  readonly constant?: string;
  readonly read?: () => string | null | undefined;
}

/**
 * The fixed host runs the extension factory before it applies extension CLI
 * flag values, so `getFlag` must be read once at the first session start.
 * Registration itself stays synchronous and happens here.
 */
function registerDefinitionSelection(
  pi: DefinedOmpApi,
  options: DefinedNativeEntryOptions,
): DefinitionPathSelection {
  try {
    pi.registerFlag?.(AGENT_DEFINITION_FLAG, {
      description: "Explicit absolute Agent Markdown path for this optional main-session definition binding.",
      type: "string",
    });
  } catch (error) {
    stderr("flag_registration_failed", { reason: errorMessage(error) });
  }
  if (options.definitionPath !== undefined) return { constant: options.definitionPath };
  let read = false;
  let cached: string | undefined;
  return {
    read() {
      if (read) return cached;
      read = true;
      let value: boolean | string | undefined;
      try {
        value = pi.getFlag?.(AGENT_DEFINITION_FLAG);
      } catch (error) {
        throw new Error(`Host getFlag failed: ${errorMessage(error)}`);
      }
      cached = typeof value === "string" ? value : undefined;
      return cached;
    },
  };
}

function unavailableNativeWorkCallInspection(): NativeWorkCallInspection {
  return Object.freeze({
    schema: NATIVE_WORK_CALL_INSPECTION_SCHEMA,
    authority: "non-authoritative",
    state: "unavailable",
    reason: "entry-disabled",
    association: null,
    workPhase: null,
    requestAttribution: null,
    evidenceState: null,
    callResultState: null,
    pendingInputCount: null,
    pendingInputsDropped: null,
  } satisfies NativeWorkCallInspection);
}

function unavailableNativeWorkCallCapture(): NativeWorkCallCapture {
  return Object.freeze({
    ok: false,
    ref: null,
    inspection: unavailableNativeWorkCallInspection(),
  } satisfies NativeWorkCallCapture);
}

function unavailableNativeCallCheckPreparation(): NativeCallCheckPreparation {
  return Object.freeze({
    ok: false,
    inspection: unavailableNativeWorkCallInspection(),
  } satisfies NativeCallCheckPreparation);
}

export function createDefinedNativeEntry(
  pi: DefinedOmpApi,
  options: DefinedNativeEntryOptions = {},
): DefinedNativeEntryControls {
  const selection = registerDefinitionSelection(pi, options);
  const bindingStartupTimeoutMs = startupTimeout(options.startupTimeoutMs);
  let activeContext: DefinedNativeContext | null = null;
  const touch = (context: NativeContext): void => {
    activeContext = context as DefinedNativeContext;
  };
  const ports = deferred<DefinedNativePorts>();
  // Avoid unhandled rejection when nothing binds (for example an unselected
  // extension instance that never receives a main session).
  void ports.promise.catch(() => undefined);
  const loader = options.loadDefinition ?? nativeLoader(ports.promise);
  const controller = new DefinitionBindingController({
    ...(selection.constant === undefined ? {} : { definitionPath: selection.constant }),
    ...(selection.read === undefined ? {} : { readDefinitionPath: selection.read }),
    loadDefinition: loader,
    resolveModel(selector) {
      return activeContext === null ? undefined : resolveModel(activeContext, selector);
    },
    currentModel() {
      return activeContext === null ? undefined : readCurrentModel(activeContext);
    },
    async setModel(model: BindingModel) {
      if (typeof pi.setModel !== "function") throw new Error("Host setModel is unavailable.");
      return await pi.setModel(model);
    },
    getActiveTools() {
      if (typeof pi.getActiveTools !== "function") throw new Error("Host getActiveTools is unavailable.");
      const tools = pi.getActiveTools();
      if (!Array.isArray(tools)) throw new Error("Host getActiveTools returned no array.");
      return tools;
    },
    async setActiveTools(tools) {
      if (typeof pi.setActiveTools !== "function") throw new Error("Host setActiveTools is unavailable.");
      await pi.setActiveTools([...tools]);
    },
    notify(message, type) {
      const context = activeContext;
      if (context?.hasUI !== true || typeof context.ui?.notify !== "function") return;
      try {
        context.ui.notify(message, type);
      } catch {
        // UI failure must not break the gate.
      }
    },
    diagnose: options.diagnostic ?? ((event) => stderr(event.type, event)),
    taskOwnerConflict: () => currentTaskOwner() !== undefined,
  });

  const statusCommandRegistered = registerStatusCommand(pi, controller);
  registerDefinitionTool(pi, controller);

  // Gate handlers are registered first so the runner observes their veto
  // before the wrapped native observer.
  pi.on("input", (event, context) => {
    touch(context);
    try {
      const facts = readFacts(context);
      if (facts.agentKind === "main") {
        const diagnostic = classifyDiagnosticInput(event);
        if (diagnostic?.command === "definition") {
          // The definition diagnostic must remain able to explain a failed or
          // resolving binding, so it precedes controller.onInput. Successful
          // display requires the host's own registration; otherwise the same
          // recognized token gets a local refusal, never a status/binding
          // bypass and never the observer/provider path.
          if (diagnostic.kind === "exact" && statusCommandRegistered) {
            try {
              showDefinitionStatus(controller, context);
            } catch {
              // The recognized diagnostic is consumed even when display fails.
            }
          } else if (diagnostic.kind === "malformed") {
            showDiagnosticSyntaxRefused(context, "definition");
          } else {
            showDefinitionStatusUnavailable(context);
          }
          return { handled: true };
        }
        const composition = options.statusComposition?.instanceStatus;
        if (diagnostic?.command === "instances" && composition !== undefined) {
          // Instance status cannot bypass D1 authorization: failed, resolving,
          // closed or unknown D1 states keep their existing gate decision.
          const gate = controller.onInput(facts);
          if (gate !== undefined) return gate;
          if (diagnostic.kind === "malformed") {
            showDiagnosticSyntaxRefused(context, "instances");
          } else if (composition.isRegistered()) {
            try {
              composition.show(context);
            } catch {
              // The recognized diagnostic is consumed even when display fails.
            }
          } else {
            showStatusText(
              context,
              "agent-instances-status is unavailable: the host did not register the command; no instance status was read.",
              "warning",
              "agent_instances_status_refused",
            );
          }
          return { handled: true };
        }
      }
      return controller.onInput(facts);
    } catch (error) {
      controller.hostError("input", error);
      return { handled: true };
    }
  });
  pi.on("before_agent_start", (event, context) => {
    touch(context);
    const value = event as { systemPrompt?: unknown };
    const base = Array.isArray(value.systemPrompt)
      ? value.systemPrompt.filter((item): item is string => typeof item === "string")
      : [];
    try {
      const decision = controller.beforeAgentStart(
        readFacts(context),
        base,
        () => {
          try {
            (context as DefinedNativeContext).abort?.();
          } catch {
            // Synchronous best effort; the gate remains closed.
          }
        },
        () => readPendingMessages(context),
      );
      return decision.allow && decision.systemPrompt !== null
        ? { systemPrompt: [...decision.systemPrompt] }
        : undefined;
    } catch (error) {
      try {
        (context as DefinedNativeContext).abort?.();
      } catch {
        // Best effort only.
      }
      controller.hostError("before_agent_start", error);
      return undefined;
    }
  });
  pi.on("tool_call", (event, context) => {
    touch(context);
    const value = event as { toolName?: unknown };
    try {
      return controller.toolCall(
        readFacts(context),
        typeof value.toolName === "string" ? value.toolName : "",
      );
    } catch (error) {
      controller.hostError("tool_call", error);
      return { block: true, reason: boundMessage(`Definition binding check failed: ${errorMessage(error)}. No tool ran.`) };
    }
  });

  pi.on("session_start", async (_event, context) => {
    touch(context);
    try {
      controller.beginSession(readFacts(context), () => readFacts(context));
      // The host awaits session_start before it is ready. Keep the wait
      // bounded so a hung native load cannot block startup indefinitely.
      await awaitBindingStartup(controller, bindingStartupTimeoutMs);
    } catch (error) {
      controller.hostError("session_start", error);
    }
  });
  for (const event of NAVIGATION_EVENTS) {
    pi.on(event, (_value, context) => {
      touch(context);
      try {
        controller.onNavigation(event, readFacts(context));
      } catch (error) {
        controller.hostError(event, error);
      }
    });
  }
  pi.on("session_shutdown", (_event, context) => {
    touch(context);
    controller.dispose("session shutdown invalidated the definition binding");
  });

  let nativeEntry: ReturnType<typeof createNativeEntry>;
  try {
    nativeEntry = createNativeEntry(
      guardedNativeApi(pi, controller, touch),
      options.instanceReports === undefined ? {} : { instanceReports: options.instanceReports },
    );
  } catch (error) {
    controller.startupFailed(`Native observer composition failed: ${errorMessage(error)}`);
    nativeEntry = {
      get enabled() {
        return false;
      },
      get disabledReason() {
        return "native observer composition failed";
      },
      isEnabled() {
        return false;
      },
      dispose() {
        // The binding controller owns failure state.
      },
      captureCall() {
        return unavailableNativeWorkCallCapture();
      },
      inspectCall() {
        return unavailableNativeWorkCallInspection();
      },
      prepareCallCheck() {
        return unavailableNativeCallCheckPreparation();
      },
    };
  }

  // Native dynamic imports start only after gate and observer registration.
  if (options.loadDefinition === undefined) {
    if (options.nativePorts !== undefined) {
      ports.resolve(options.nativePorts);
    } else {
      void loadOmpDefinitionPorts().then(
        (value) => ports.resolve(value),
        (error: unknown) => {
          const reason = `Native module import failed: ${errorMessage(error)}`;
          ports.reject(error);
          controller.nativePortsFailed(reason);
        },
      );
    }
  }

  return {
    controller,
    nativeEntry,
    dispose() {
      controller.dispose("definition binding disposed by its owner");
      nativeEntry.dispose();
    },
  };
}

export default function definedNativeEntry(pi: DefinedOmpApi): void {
  try {
    createDefinedNativeEntry(pi);
  } catch (error) {
    stderr("defined_native_entry_disabled", { reason: errorMessage(error) });
  }
}
