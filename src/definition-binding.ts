import path from "node:path";
import type {
  DefinitionModelRef,
  DefinitionSkillMetadata,
  DefinitionSnapshot,
  ResolveModelPort,
} from "./agent-definition.ts";
import { deepFreeze, NATIVE_WORK_TOOL, sha256Hex } from "./native-work.ts";

/**
 * One initial main-session definition binding per extension runtime.
 *
 * The controller owns only identity, a frozen snapshot reference and the
 * transition into a terminal failure. It has no durable store, model loop,
 * parser, discovery pass or retry. The host supplies every actual decision:
 * model resolution/setting, active tools, Skill metadata and UI facts.
 */

export const DEFINITION_BINDING_SCHEMA = "omp-agent.definition-binding.v1";
export const DEFINITION_BINDING_REPORT_SCHEMA = "omp-agent.definition-binding-report.v1";
export const AGENT_DEFINITION_TOOL = "agent_definition";
export const AGENT_DEFINITION_STATUS_COMMAND = "agent-definition-status";
export const AGENT_DEFINITION_FLAG = "agent-definition";

/** Known read-only plugin controls, never role tool requirements. */
export const DEFINITION_BINDING_COMPANION_TOOLS = Object.freeze([
  NATIVE_WORK_TOOL,
  AGENT_DEFINITION_TOOL,
] as const);

const MAX_MESSAGE_CHARS = 320;

export type DefinitionBindingPhase = "unselected" | "resolving" | "bound" | "failed" | "disposed";

export interface BindingModel {
  readonly provider: string;
  readonly id: string;
  readonly api?: string;
}

export interface BindingHostFacts {
  readonly agentKind: "main" | "sub" | "unknown";
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
  readonly hasUI: boolean;
  /** Native host fact when exposed; null means it could not be read. */
  readonly hasPendingMessages: boolean | null;
}

export interface DefinitionBindingLoadInput {
  readonly definitionPath: string;
  readonly workspaceRoot: string;
  /** Original active native tool names, already excluding plugin companions. */
  readonly availableTools: readonly string[];
  readonly currentModel: DefinitionModelRef;
  /**
   * Snapshot-facing resolver. The loader must pass this through so the
   * controller retains the actual native model object for `setModel`.
   */
  readonly resolveModel: ResolveModelPort;
}

export type DefinitionLoader = (input: DefinitionBindingLoadInput) => Promise<DefinitionSnapshot>;

export interface DefinitionBindingDependencies {
  /**
   * Constant selection seam. Undefined with `readDefinitionPath` means the
   * host flag is read once at the first main session start; an explicit null
   * means no selection.
   */
  readonly definitionPath?: string | null;
  /** Read once, lazily, because the fixed host fills extension flags after the factory. */
  readonly readDefinitionPath?: () => string | null | undefined;
  readonly loadDefinition: DefinitionLoader;
  readonly resolveModel: (selector: string) => BindingModel | undefined;
  readonly currentModel: () => BindingModel | undefined;
  readonly setModel: (model: BindingModel) => Promise<boolean>;
  readonly getActiveTools: () => readonly string[];
  readonly setActiveTools: (tools: readonly string[]) => Promise<void>;
  readonly notify?: (message: string, type: "info" | "warning" | "error") => void;
  readonly diagnose?: (event: DefinitionBindingDiagnostic) => void;
  /** A managed TaskOwner already published is a hard conflict, not a fallback. */
  readonly taskOwnerConflict?: () => boolean;
}

export type DefinitionBindingDiagnosticType =
  | "bound"
  | "failed"
  | "invalidated"
  | "blocked"
  | "prompt-aborted"
  | "native-ports-failed"
  | "startup-failed"
  | "disposed"
  | "host-error";

export interface DefinitionBindingDiagnostic {
  readonly type: DefinitionBindingDiagnosticType;
  readonly message: string;
  readonly phase: DefinitionBindingPhase;
  readonly bindingId: string | null;
  readonly version: string | null;
  readonly hasPendingMessages: boolean | null;
}

export interface DefinitionBindingStatus {
  readonly schema: typeof DEFINITION_BINDING_SCHEMA;
  readonly phase: DefinitionBindingPhase;
  readonly blocked: boolean;
  readonly restartRequired: boolean;
  /** Native abort does not promise to clear queued messages. */
  readonly nativeQueuedMessagesMayBeRetained: boolean;
  readonly hasPendingMessages: boolean | null;
  readonly failure: string | null;
  readonly bindingId: string | null;
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
  readonly version: string | null;
  readonly definitionName: string | null;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly selector: string | null;
    readonly selectorKind: "host-current" | "provider-id" | "native-selector";
  } | null;
  readonly effectiveTools: readonly string[];
  readonly roleTools: readonly string[];
  readonly selectedSource: {
    readonly kind: "explicit-host-path";
    readonly definitionPath: string;
  } | null;
  readonly freezeScope: "initial-text" | null;
  readonly generation: number;
  readonly navigationEpoch: number;
  readonly failureEpoch: number;
}

export interface DefinitionBindingReport {
  readonly schema: typeof DEFINITION_BINDING_REPORT_SCHEMA;
  readonly authority: "non-authoritative";
  readonly bindingId: string;
  readonly version: string;
  readonly definitionName: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly selectedSource: {
    readonly kind: "explicit-host-path";
    readonly definitionPath: string;
  };
  readonly freezeScope: "initial-text";
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly selector: string | null;
    readonly selectorKind: "host-current" | "provider-id" | "native-selector";
  };
  readonly effectiveTools: readonly string[];
  readonly roleTools: readonly string[];
}

export interface DefinitionBindingPromptDecision {
  readonly allow: boolean;
  /** Complete replacement array, or null when no definition block applies. */
  readonly systemPrompt: readonly string[] | null;
}

export interface DefinitionBindingToolCallDecision {
  readonly block: true;
  readonly reason: string;
}

interface BoundBinding {
  readonly bindingId: string;
  readonly snapshot: DefinitionSnapshot;
  readonly facts: BindingHostFacts;
  readonly effectiveTools: readonly string[];
  readonly roleTools: readonly string[];
}

interface SelectedPath {
  readonly path: string | null;
  readonly failure: string | null;
}

function boundMessage(value: string): string {
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_MESSAGE_CHARS) return normalized;
  return `${normalized.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSelectedPath(value: unknown): SelectedPath {
  if (typeof value !== "string" || value.length === 0) {
    return { path: null, failure: "No explicit --agent-definition absolute path was selected." };
  }
  if (value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) {
    return { path: null, failure: "The --agent-definition selection must be one absolute path." };
  }
  if (path.resolve(value) !== value) {
    return { path: null, failure: "The --agent-definition selection must be a normalized absolute path." };
  }
  return { path: value, failure: null };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return [...value] as string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSorted(left);
  const b = uniqueSorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function asModel(value: unknown): BindingModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider.length === 0) return undefined;
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  return value as BindingModel;
}

function modelIdentity(value: BindingModel): DefinitionModelRef {
  return { provider: value.provider, id: value.id };
}

function sameModel(left: BindingModel | undefined, right: DefinitionModelRef): boolean {
  return left !== undefined && left.provider === right.provider && left.id === right.id;
}

function copyBindingFacts(facts: BindingHostFacts): BindingHostFacts {
  return {
    agentKind: facts.agentKind,
    sessionId: facts.sessionId,
    workspaceRoot: facts.workspaceRoot,
    hasUI: facts.hasUI,
    hasPendingMessages: facts.hasPendingMessages,
  };
}

function sameBindingIdentity(left: BindingHostFacts, right: BindingHostFacts): boolean {
  return left.agentKind === "main"
    && right.agentKind === "main"
    && left.sessionId !== null
    && left.sessionId === right.sessionId
    && left.workspaceRoot !== null
    && left.workspaceRoot === right.workspaceRoot;
}

function promptBlock(snapshot: DefinitionSnapshot): string {
  const sections = [
    "Selected agent definition (initial text only; referenced external resources are not frozen):",
    `name: ${snapshot.definition.name}`,
    `version: ${snapshot.version}`,
    "",
    snapshot.definition.body,
  ];
  for (const skill of snapshot.skills) {
    sections.push(
      "",
      `Selected Skill initial text: ${skill.name}`,
      `skill sha256: ${skill.sha256}`,
      "",
      skill.body,
    );
  }
  return sections.join("\n");
}

function phaseReason(phase: DefinitionBindingPhase): string {
  switch (phase) {
    case "unselected":
      return "no main-session definition binding has started";
    case "resolving":
      return "the definition binding is still resolving";
    case "failed":
      return "the definition binding has failed";
    case "disposed":
      return "the definition binding was disposed";
    case "bound":
      return "the definition binding is active";
  }
}

export class DefinitionBindingController {
  readonly #deps: DefinitionBindingDependencies;
  #selectedPath: string | null;
  #pathResolved: boolean;
  #phase: DefinitionBindingPhase;
  #failure: string | null;
  #generation = 0;
  #navigationEpoch = 0;
  #failureEpoch = 0;
  #binding: BoundBinding | null = null;
  #attempt: Promise<void> | null = null;
  #hasPendingMessages: boolean | null = null;
  #hasUI = false;
  #sessionRequired = false;
  #lastBlockedDiagnostic: string | null = null;

  constructor(deps: DefinitionBindingDependencies) {
    this.#deps = deps;
    const deferredPath = deps.definitionPath === undefined && deps.readDefinitionPath !== undefined;
    if (deferredPath) {
      this.#selectedPath = null;
      this.#pathResolved = false;
      this.#failure = null;
      this.#phase = "unselected";
      return;
    }
    const selected = normalizeSelectedPath(deps.definitionPath);
    this.#selectedPath = selected.path;
    this.#pathResolved = true;
    this.#failure = selected.failure;
    this.#phase = selected.failure === null ? "unselected" : "failed";
    if (selected.failure !== null) {
      this.#failureEpoch = 1;
      this.#sessionRequired = true;
      this.#emit("failed", selected.failure);
    }
  }

  get phase(): DefinitionBindingPhase {
    return this.#phase;
  }

  /** Resolves when the current (or most recent) binding attempt settles. */
  whenIdle(): Promise<void> {
    return this.#attempt ?? Promise.resolve();
  }

  getStatus(): DefinitionBindingStatus {
    const binding = this.#binding;
    const snapshot = binding?.snapshot ?? null;
    const selectedPath = this.#selectedPath;
    return deepFreeze({
      schema: DEFINITION_BINDING_SCHEMA,
      phase: this.#phase,
      blocked: this.#phase !== "bound",
      restartRequired: this.#sessionRequired,
      nativeQueuedMessagesMayBeRetained: this.#sessionRequired,
      hasPendingMessages: this.#hasPendingMessages,
      failure: this.#failure,
      bindingId: binding?.bindingId ?? null,
      sessionId: binding?.facts.sessionId ?? null,
      workspaceRoot: binding?.facts.workspaceRoot ?? null,
      version: snapshot?.version ?? null,
      definitionName: snapshot?.definition.name ?? null,
      model: snapshot === null
        ? null
        : {
            provider: snapshot.definition.model.provider,
            id: snapshot.definition.model.id,
            selector: snapshot.definition.model.selector,
            selectorKind: snapshot.definition.model.selectorKind,
          },
      effectiveTools: binding === null ? [] : [...binding.effectiveTools],
      roleTools: snapshot === null ? [] : [...snapshot.definition.effectiveTools],
      selectedSource: selectedPath === null
        ? null
        : { kind: "explicit-host-path", definitionPath: selectedPath },
      freezeScope: snapshot === null ? null : snapshot.freezeScope,
      generation: this.#generation,
      navigationEpoch: this.#navigationEpoch,
      failureEpoch: this.#failureEpoch,
    });
  }

  /** Actual attached binding for observation enrichment; null unless bound. */
  getReportBinding(): DefinitionBindingReport | null {
    const binding = this.#binding;
    const selectedPath = this.#selectedPath;
    if (this.#phase !== "bound" || binding === null || selectedPath === null) return null;
    const snapshot = binding.snapshot;
    return deepFreeze({
      schema: DEFINITION_BINDING_REPORT_SCHEMA,
      authority: "non-authoritative",
      bindingId: binding.bindingId,
      version: snapshot.version,
      definitionName: snapshot.definition.name,
      sessionId: binding.facts.sessionId!,
      workspaceRoot: binding.facts.workspaceRoot!,
      selectedSource: { kind: "explicit-host-path", definitionPath: selectedPath },
      freezeScope: "initial-text",
      model: {
        provider: snapshot.definition.model.provider,
        id: snapshot.definition.model.id,
        selector: snapshot.definition.model.selector,
        selectorKind: snapshot.definition.model.selectorKind,
      },
      effectiveTools: [...binding.effectiveTools],
      roleTools: [...binding.roleTools],
    });
  }

  beginSession(inputFacts: BindingHostFacts, recheck?: () => BindingHostFacts): void {
    if (this.#phase === "disposed") return;
    const facts = copyBindingFacts(inputFacts);
    this.#observe(facts);
    if (facts.agentKind === "sub") {
      if (this.#phase !== "failed") {
        this.#generation++;
        this.#phase = "failed";
        this.#failure = "Subagent sessions never bind or pretend to hold the main definition.";
        this.#failureEpoch++;
        this.#sessionRequired = false;
        this.#binding = null;
        this.#emit("failed", this.#failure);
      }
      return;
    }
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      this.#notifyBlocked(this.#failure ?? "agent identity is unavailable");
      return;
    }
    // A pre-existing terminal failure (selection or native import) is never
    // reset by a later path read or session start.
    if (this.#phase === "failed") {
      const reason = this.#failure ?? phaseReason(this.#phase);
      this.#notifyBlocked(reason);
      this.#emit("failed", reason);
      return;
    }
    if (this.#phase !== "unselected") {
      this.#invalidate(
        "A main session started after a binding attempt; a new OMP process is required.",
        true,
      );
      return;
    }
    if (!this.#pathResolved && !this.#resolvePathOnce()) return;
    if (this.#selectedPath === null) {
      const reason = this.#failure ?? "No explicit --agent-definition absolute path was selected.";
      this.#failCurrent(reason, false);
      return;
    }
    if (facts.sessionId === null || facts.workspaceRoot === null) {
      this.#failCurrent(
        "The main session identity is unavailable; definition binding requires a live session id and canonical workspace.",
        false,
      );
      return;
    }
    if (this.#taskOwnerConflict()) {
      this.#failCurrent("A managed TaskOwner is already published; definition binding is refused.", false);
      return;
    }

    this.#generation++;
    const attempt = this.#generation;
    this.#phase = "resolving";
    this.#failure = null;
    this.#binding = null;
    this.#sessionRequired = false;
    this.#lastBlockedDiagnostic = null;
    this.#attempt = this.#bind(facts, attempt, recheck ?? (() => facts));
  }

  onInput(facts: BindingHostFacts): { handled: true } | undefined {
    this.#observe(facts);
    if (facts.agentKind === "sub") return undefined;
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      this.#notifyBlocked(this.#failure ?? "agent identity is unavailable");
      return { handled: true };
    }
    try {
      const check = this.#check(facts);
      if (check.ok) return undefined;
      this.#notifyBlocked(check.reason);
      this.#blockedDiagnostic("blocked", "input", check.reason);
      return { handled: true };
    } catch (error) {
      this.#hostError("input", error);
      this.#notifyBlocked(this.#failure ?? "definition binding check failed");
      return { handled: true };
    }
  }

  beforeAgentStart(
    facts: BindingHostFacts,
    basePrompt: readonly string[],
    abort: () => void,
    readPendingMessages?: () => boolean | null,
  ): DefinitionBindingPromptDecision {
    this.#observe(facts);
    if (facts.agentKind === "sub") return { allow: true, systemPrompt: null };
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      try {
        abort();
      } catch {
        // Best effort only.
      }
      this.#notifyBlocked(this.#failure ?? "agent identity is unavailable");
      this.#emit(
        "prompt-aborted",
        "Prompt aborted because agent identity is unavailable; ctx.abort() was requested. Native messages may remain queued and require a restart; this entry does not clear host queues.",
      );
      return { allow: false, systemPrompt: null };
    }
    try {
      const check = this.#check(facts);
      if (check.ok) {
        if (this.#binding !== null) {
          return {
            allow: true,
            systemPrompt: [...basePrompt, promptBlock(this.#binding.snapshot)],
          };
        }
        // The state machine cannot be bound without a binding, but never
        // silently pass a prompt if it is.
        this.#failCurrent("The bound definition snapshot is unavailable.", false);
      }
      const reason = check.ok ? (this.#failure ?? "the bound definition snapshot is unavailable") : check.reason;
      try {
        abort();
      } catch {
        // Host abort is synchronous best effort; the binding is already unsafe.
      }
      if (readPendingMessages !== undefined) {
        try {
          const pending = readPendingMessages();
          if (typeof pending === "boolean") this.#hasPendingMessages = pending;
        } catch {
          // Keep the prior host fact.
        }
      }
      this.#notifyBlocked(reason);
      this.#emit(
        "prompt-aborted",
        `Prompt aborted because ${reason}; ctx.abort() was requested. Native messages may remain queued and require a restart; this entry does not clear host queues.`,
      );
      return { allow: false, systemPrompt: null };
    } catch (error) {
      try {
        abort();
      } catch {
        // Best effort only.
      }
      this.#hostError("before_agent_start", error);
      return { allow: false, systemPrompt: null };
    }
  }

  toolCall(facts: BindingHostFacts, toolName: string): DefinitionBindingToolCallDecision | undefined {
    this.#observe(facts);
    if (facts.agentKind === "sub") return undefined;
    if (toolName === AGENT_DEFINITION_TOOL) return undefined;
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      return {
        block: true,
        reason: boundMessage("Definition binding unavailable: agent identity is unavailable. No tool ran."),
      };
    }
    try {
      const check = this.#check(facts);
      if (check.ok) return undefined;
      const reason = boundMessage(`Definition binding unavailable: ${check.reason}. No tool ran.`);
      this.#blockedDiagnostic("blocked", "tool_call", check.reason);
      return { block: true, reason };
    } catch (error) {
      this.#hostError("tool_call", error);
      return {
        block: true,
        reason: boundMessage(`Definition binding check failed: ${errorMessage(error)}. No tool ran.`),
      };
    }
  }

  /** Native observer execution/observation is allowed only while the main binding is valid. */
  allowsObservation(facts: BindingHostFacts): boolean {
    this.#observe(facts);
    if (facts.agentKind === "sub") return true;
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      return false;
    }
    try {
      return this.#check(facts).ok;
    } catch (error) {
      this.#hostError("native observation", error);
      return false;
    }
  }

  allowsToolExecution(facts: BindingHostFacts): boolean {
    return this.allowsObservation(facts);
  }

  onNavigation(reason: string, facts: BindingHostFacts): void {
    if (this.#phase === "disposed") return;
    this.#observe(facts);
    if (facts.agentKind === "sub") return;
    if (facts.agentKind === "unknown") {
      this.#failUnknownIdentity();
      return;
    }
    this.#invalidate(
      `Main-session ${reason} invalidated the definition binding; a new OMP session is required.`,
      true,
    );
  }

  dispose(reason: string): void {
    if (this.#phase === "disposed") return;
    this.#generation++;
    this.#phase = "disposed";
    this.#failure = boundMessage(reason);
    this.#failureEpoch++;
    this.#sessionRequired = true;
    this.#binding = null;
    this.#emit("disposed", this.#failure);
  }

  nativePortsFailed(reason: string): void {
    if (this.#phase === "disposed" || this.#phase === "bound") return;
    this.#failCurrent(reason, false, "native-ports-failed");
  }

  startupFailed(reason: string): void {
    if (this.#phase === "disposed" || this.#phase === "bound") return;
    this.#failCurrent(reason, false, "startup-failed");
  }

  hostError(surface: string, error: unknown): void {
    if (this.#phase === "disposed") return;
    this.#failCurrent(`Host ${surface} error: ${errorMessage(error)}`, false, "host-error");
  }

  async #bind(inputFacts: BindingHostFacts, attempt: number, recheck: () => BindingHostFacts): Promise<void> {
    const facts = copyBindingFacts(inputFacts);
    const definitionPath = this.#selectedPath;
    if (definitionPath === null) return;
    try {
      const controlTools = new Set<string>(DEFINITION_BINDING_COMPANION_TOOLS);
      const actualTools = this.#readTools();
      const availableTools = actualTools.filter((name) => !controlTools.has(name));
      const currentModel = this.#readCurrentModel();
      if (currentModel === undefined) {
        this.#failAttempt(attempt, "The main session has no current native model; definition binding is refused.", false);
        return;
      }
      if (this.#taskOwnerConflict()) {
        this.#failAttempt(attempt, "A managed TaskOwner is already published; definition binding is refused.", false);
        return;
      }

      const resolvedModels = new Map<string, BindingModel>();
      const resolveModel: ResolveModelPort = (selector) => {
        const resolved = this.#resolveModel(selector);
        if (resolved === undefined) return undefined;
        resolvedModels.set(selector, resolved);
        return modelIdentity(resolved);
      };

      const snapshot = await this.#deps.loadDefinition({
        definitionPath,
        workspaceRoot: facts.workspaceRoot!,
        availableTools,
        currentModel: modelIdentity(currentModel),
        resolveModel,
      });
      if (!this.#attemptCurrent(attempt)) return;

      const finalFacts = this.#readFacts(recheck);
      this.#observe(finalFacts);
      if (!sameBindingIdentity(facts, finalFacts)) {
        this.#failAttempt(attempt, "The main session or workspace changed while the definition was loading.", true);
        return;
      }
      if (this.#taskOwnerConflict()) {
        this.#failAttempt(attempt, "A managed TaskOwner was published while the definition was loading.", false);
        return;
      }
      if (snapshot.workspaceRoot !== facts.workspaceRoot) {
        this.#failAttempt(attempt, "The snapshot workspace differs from the bound main workspace.", false);
        return;
      }

      const companions = uniqueSorted([...controlTools]);
      const availableSet = new Set(availableTools);
      const roleTools = uniqueSorted(snapshot.definition.effectiveTools);
      if (roleTools.some((name) => controlTools.has(name) || !availableSet.has(name))) {
        this.#failAttempt(attempt, "The snapshot tool set is not a subset of the original active native tools.", false);
        return;
      }

      // Never repair a user's tool change by re-enabling the captured set.
      if (!sameSet(this.#readTools(), actualTools)) {
        this.#failAttempt(
          attempt,
          "The actual active tools changed while the definition was loading; they were not restored or widened.",
          false,
        );
        return;
      }
      const modelBeforeSet = this.#readCurrentModel();
      if (!sameModel(modelBeforeSet, currentModel)) {
        this.#failAttempt(
          attempt,
          "The actual model changed while the definition was loading; it was not overwritten.",
          false,
        );
        return;
      }

      const snapshotModel = snapshot.definition.model;
      let target: BindingModel | undefined;
      if (snapshotModel.selector === null) {
        target = currentModel;
      } else {
        target = resolvedModels.get(snapshotModel.selector);
      }
      if (target === undefined || !sameModel(target, snapshotModel)) {
        this.#failAttempt(attempt, "The actual resolved native model object is unavailable or mismatched.", false);
        return;
      }
      if (snapshotModel.selector !== null) {
        const applied = await this.#deps.setModel(target);
        if (!this.#attemptCurrent(attempt)) return;
        if (!applied) {
          this.#failAttempt(attempt, "The native model setter returned false; no bound definition is published.", false);
          return;
        }
      }
      const actualModel = this.#readCurrentModel();
      if (!sameModel(actualModel, snapshotModel)) {
        this.#failAttempt(attempt, "The actual native model does not match the selected definition model.", false);
        return;
      }
      // A model setter can have side effects, so the original tool set is
      // rechecked before any tool change.
      if (!sameSet(this.#readTools(), actualTools)) {
        this.#failAttempt(
          attempt,
          "The actual active tools changed while the model was being applied; they were not restored or widened.",
          false,
        );
        return;
      }

      const desiredTools = uniqueSorted([...companions, ...roleTools]);
      const beforeTools = this.#readTools();
      if (!sameSet(beforeTools, desiredTools)) {
        await this.#deps.setActiveTools(desiredTools);
        if (!this.#attemptCurrent(attempt)) return;
      }
      const afterTools = this.#readTools();
      if (!sameSet(afterTools, desiredTools)) {
        this.#failAttempt(attempt, "The actual active tool set does not match the effective definition tools.", false);
        return;
      }

      const publishFacts = this.#readFacts(recheck);
      this.#observe(publishFacts);
      if (!sameBindingIdentity(facts, publishFacts)) {
        this.#failAttempt(attempt, "The main session or workspace changed while model/tools were being applied.", true);
        return;
      }
      if (this.#taskOwnerConflict()) {
        this.#failAttempt(attempt, "A managed TaskOwner was published while model/tools were being applied.", false);
        return;
      }
      // Final model/tool gate immediately before publishing. An async tool
      // setter (or any host side effect) must not be able to publish a stale
      // model or a different active set.
      if (!sameModel(this.#readCurrentModel(), snapshotModel)) {
        this.#failAttempt(attempt, "The actual model changed while tools were being applied; no bound definition was published.", false);
        return;
      }
      const finalTools = this.#readTools();
      if (!sameSet(finalTools, desiredTools)) {
        this.#failAttempt(attempt, "The actual active tools changed immediately before publishing; no bound definition was published.", false);
        return;
      }
      if (!this.#attemptCurrent(attempt)) return;

      const bindingId = `binding-${attempt}-${sha256Hex(
        `${facts.sessionId}\n${facts.workspaceRoot}\n${snapshot.version}`,
      ).slice(0, 16)}`;
      this.#binding = {
        bindingId,
        snapshot,
        facts: copyBindingFacts(publishFacts),
        effectiveTools: uniqueSorted(finalTools),
        roleTools,
      };
      this.#phase = "bound";
      this.#failure = null;
      this.#sessionRequired = false;
      this.#emit("bound", `Definition binding published for ${snapshot.definition.name}.`);
    } catch (error) {
      if (this.#attemptCurrent(attempt)) {
        this.#failAttempt(attempt, `Definition binding failed: ${errorMessage(error)}`, false);
      }
    }
  }

  #attemptCurrent(attempt: number): boolean {
    return this.#phase === "resolving" && this.#generation === attempt;
  }

  #resolvePathOnce(): boolean {
    if (this.#pathResolved) return true;
    this.#pathResolved = true;
    const reader = this.#deps.readDefinitionPath;
    if (reader === undefined) {
      this.#failCurrent("No explicit --agent-definition absolute path was selected.", false);
      return false;
    }
    let value: string | null | undefined;
    try {
      value = reader();
    } catch (error) {
      this.#failCurrent(`Reading --agent-definition failed: ${errorMessage(error)}`, false);
      return false;
    }
    const selected = normalizeSelectedPath(value);
    this.#selectedPath = selected.path;
    if (selected.failure !== null) {
      this.#failCurrent(selected.failure, false);
      return false;
    }
    return true;
  }

  #failUnknownIdentity(): void {
    if (this.#phase === "disposed" || this.#phase === "failed") return;
    this.#failCurrent(
      "Agent identity is unavailable; definition binding is fail-closed and never assumes main.",
      false,
    );
  }

  #readFacts(recheck: () => BindingHostFacts): BindingHostFacts {
    const facts = recheck();
    if (typeof facts !== "object" || facts === null) {
      throw new Error("Host identity reader returned no facts.");
    }
    return facts;
  }

  #readTools(): string[] {
    return stringList(this.#deps.getActiveTools(), "Host active tools");
  }

  #readCurrentModel(): BindingModel | undefined {
    return asModel(this.#deps.currentModel());
  }

  #resolveModel(selector: string): BindingModel | undefined {
    const value = this.#deps.resolveModel(selector);
    return asModel(value);
  }

  #taskOwnerConflict(): boolean {
    if (this.#deps.taskOwnerConflict === undefined) return false;
    try {
      return this.#deps.taskOwnerConflict();
    } catch {
      return true;
    }
  }

  #check(facts: BindingHostFacts): { ok: true } | { ok: false; reason: string } {
    this.#observe(facts);
    if (this.#phase !== "bound" || this.#binding === null) {
      return { ok: false, reason: this.#failure ?? phaseReason(this.#phase) };
    }
    if (!sameBindingIdentity(this.#binding.facts, facts)) {
      this.#failCurrent(
        "The live session id or canonical workspace differs from the bound main identity.",
        true,
      );
      return { ok: false, reason: this.#failure! };
    }
    if (this.#taskOwnerConflict()) {
      this.#failCurrent("A managed TaskOwner is now published; the definition binding is refused.", false);
      return { ok: false, reason: this.#failure! };
    }
    const model = this.#readCurrentModel();
    if (!sameModel(model, this.#binding.snapshot.definition.model)) {
      this.#failCurrent("The actual model changed after binding; the definition binding is failed.", false);
      return { ok: false, reason: this.#failure! };
    }
    const tools = this.#readTools();
    if (!sameSet(tools, this.#binding.effectiveTools)) {
      this.#failCurrent("The actual active tools changed after binding; the definition binding is failed.", false);
      return { ok: false, reason: this.#failure! };
    }
    return { ok: true };
  }

  #observe(facts: BindingHostFacts): void {
    this.#hasUI = facts.hasUI === true;
    if (typeof facts.hasPendingMessages === "boolean") {
      this.#hasPendingMessages = facts.hasPendingMessages;
    }
  }

  #failCurrent(
    reason: string,
    navigation: boolean,
    type: "failed" | "invalidated" | "native-ports-failed" | "startup-failed" | "host-error" = "failed",
  ): void {
    if (this.#phase === "disposed") return;
    this.#generation++;
    this.#phase = "failed";
    this.#failure = boundMessage(reason);
    this.#failureEpoch++;
    this.#sessionRequired = true;
    if (navigation) this.#navigationEpoch++;
    this.#binding = null;
    this.#emit(type, this.#failure);
  }

  #invalidate(reason: string, navigation: boolean): void {
    this.#failCurrent(reason, navigation, "invalidated");
  }

  #failAttempt(attempt: number, reason: string, navigation: boolean): void {
    if (!this.#attemptCurrent(attempt)) return;
    this.#failCurrent(reason, navigation);
  }

  #notifyBlocked(reason: string): void {
    if (!this.#hasUI || this.#deps.notify === undefined) return;
    try {
      this.#deps.notify(boundMessage(`Definition binding blocked: ${reason}`), "error");
    } catch {
      // UI failure must not become a host throw.
    }
  }

  #blockedDiagnostic(
    type: "blocked",
    surface: "input" | "tool_call",
    reason: string,
  ): void {
    const key = `${surface}:${this.#phase}:${reason}`;
    if (this.#lastBlockedDiagnostic === key) return;
    this.#lastBlockedDiagnostic = key;
    this.#emit(type, `${surface} blocked: ${reason}`);
  }

  #hostError(surface: string, error: unknown): void {
    try {
      this.hostError(surface, error);
    } catch {
      // No host throw.
    }
  }

  #emit(type: DefinitionBindingDiagnosticType, message: string): void {
    if (this.#deps.diagnose === undefined) return;
    try {
      this.#deps.diagnose({
        type,
        message: boundMessage(message),
        phase: this.#phase,
        bindingId: this.#binding?.bindingId ?? null,
        version: this.#binding?.snapshot.version ?? null,
        hasPendingMessages: this.#hasPendingMessages,
      });
    } catch {
      // Observability must not break the gate.
    }
  }
}
