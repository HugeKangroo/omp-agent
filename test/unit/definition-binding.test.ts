import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadDefinitionSnapshot,
  type DefinitionModelRef,
  type DefinitionSkillMetadata,
  type DefinitionSnapshot,
  type ParseAgentPort,
  type ParseFrontmatterPort,
  type ResolveModelPort,
} from "../../src/agent-definition.ts";
import {
  AGENT_DEFINITION_TOOL,
  DEFINITION_BINDING_COMPANION_TOOLS,
  type DefinitionBindingDiagnostic,
  type DefinitionLoader,
} from "../../src/definition-binding.ts";
import {
  createDefinedNativeEntry,
  type DefinedModel,
  type DefinedNativeContext,
  type DefinedNativeEntryControls,
  type DefinedNativePorts,
  type DefinedOmpApi,
} from "../../src/defined-native-entry.ts";
import {
  NATIVE_WORK_GUIDANCE,
  type NativeContext,
  type NativeToolResult,
} from "../../src/native-entry.ts";
import { clearPublishedTaskOwner, publishTaskOwner } from "../../src/task-entry-port.ts";
import type { TaskOwner } from "../../src/task-owner.ts";

const AGENT_WORK = "agent_work";
const MAIN_MODEL: DefinedModel = { provider: "fixture", id: "main" };
const OTHER_MODEL: DefinedModel = { provider: "fixture", id: "other" };
const MODELED_MODEL: DefinedModel = { provider: "fixture", id: "model" };

type RegisteredTool = Parameters<DefinedOmpApi["registerTool"]>[0];
type RegisteredCommand = NonNullable<DefinedOmpApi["registerCommand"]>;
type Handler = (event: unknown, context: NativeContext) => unknown;

interface SkillFixture {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

interface DefinitionFixture {
  readonly root: string;
  readonly workspace: string;
  readonly definitionPath: string;
  readonly ports: DefinedNativePorts;
  readonly selectedSkills: readonly string[];
}

interface DefinitionOptions {
  readonly name: string;
  readonly description?: string;
  readonly body: string;
  /** Undefined means omitted; an array (including []) is explicit. */
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly skills?: readonly SkillFixture[];
  readonly selectedSkills?: readonly string[];
}

const roots: string[] = [];
const controls: DefinedNativeEntryControls[] = [];

afterEach(async () => {
  clearPublishedTaskOwner();
  for (const control of controls.splice(0)) control.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function definitionFixture(options: DefinitionOptions): Promise<DefinitionFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-binding-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const definitionPath = path.join(root, "Agent.md");
  const selectedSkills = [...(options.selectedSkills ?? [])];
  const frontmatter: Record<string, unknown> = {
    name: options.name,
    description: options.description ?? `${options.name} description`,
  };
  if (options.tools !== undefined) frontmatter.tools = [...options.tools];
  if (options.model !== undefined) frontmatter.model = options.model;
  if (selectedSkills.length > 0) frontmatter.autoloadSkills = selectedSkills;

  const frontmatterText = [
    "---",
    `name: ${options.name}`,
    `description: ${String(frontmatter.description)}`,
    ...(options.tools === undefined ? [] : [`tools: [${options.tools.map((tool) => JSON.stringify(tool)).join(", ")}]`]),
    ...(options.model === undefined ? [] : [`model: ${options.model}`]),
    ...(selectedSkills.length === 0 ? [] : [`autoloadSkills: [${selectedSkills.map((name) => JSON.stringify(name)).join(", ")}]`]),
    "---",
  ].join("\n");
  await writeFile(definitionPath, `${frontmatterText}\n${options.body}\n`, "utf8");

  const byPath = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();
  byPath.set(definitionPath, { frontmatter, body: options.body });
  const skillMetadata: DefinitionSkillMetadata[] = [];
  for (const skill of options.skills ?? []) {
    const skillDir = path.join(root, "skills", skill.name);
    await mkdir(skillDir, { recursive: true, mode: 0o700 });
    const skillPath = path.join(skillDir, "SKILL.md");
    await writeFile(
      skillPath,
      `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`,
      "utf8",
    );
    byPath.set(skillPath, {
      frontmatter: { name: skill.name, description: skill.description },
      body: skill.body,
    });
    skillMetadata.push({ name: skill.name, description: skill.description, filePath: skillPath });
  }

  const parseFrontmatter: ParseFrontmatterPort = (_content, parseOptions) => {
    const value = byPath.get(parseOptions.location);
    if (value === undefined) throw new Error(`unknown fixture path ${parseOptions.location}`);
    return { frontmatter: { ...value.frontmatter }, body: value.body };
  };
  const parseAgent: ParseAgentPort = (filePath) => {
    const value = byPath.get(filePath);
    if (value === undefined) throw new Error(`unknown fixture path ${filePath}`);
    return {
      name: value.frontmatter.name,
      description: value.frontmatter.description,
      systemPrompt: value.body,
      ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
      ...(options.model === undefined ? {} : { model: [options.model] }),
      ...(selectedSkills.length === 0 ? {} : { autoloadSkills: [...selectedSkills] }),
    };
  };
  return {
    root,
    workspace,
    definitionPath,
    selectedSkills,
    ports: {
      parseAgent,
      parseFrontmatter,
      getActiveSkills: () => skillMetadata.map((skill) => ({ ...skill })),
    },
  };
}

async function loadFixtureSnapshot(
  fixture: DefinitionFixture,
  resolveModel: ResolveModelPort,
  availableTools: readonly string[],
  currentModel: DefinitionModelRef,
): Promise<DefinitionSnapshot> {
  return await loadDefinitionSnapshot({
    definitionPath: fixture.definitionPath,
    workspaceRoot: fixture.workspace,
    parseAgent: fixture.ports.parseAgent,
    parseFrontmatter: fixture.ports.parseFrontmatter,
    availableSkills: fixture.ports.getActiveSkills().map((value) => value as DefinitionSkillMetadata),
    availableTools,
    currentModel,
    resolveModel,
    nativeSource: "explicit",
  });
}

interface HostOptions {
  readonly activeTools?: readonly string[];
  readonly currentModel?: DefinedModel;
  readonly models?: ReadonlyMap<string, DefinedModel>;
  readonly setModelResult?: boolean | Promise<boolean>;
  readonly setModelEffect?: (host: Host) => void | Promise<void>;
  readonly setActiveToolsError?: Error;
  readonly setActiveToolsEffect?: (host: Host) => void | Promise<void>;
  readonly hasPending?: boolean;
  readonly hasUI?: boolean;
  readonly sessionId?: string;
  readonly liveCwd?: string;
  readonly agentKind?: "main" | "sub" | "unknown";
  /** Synthetic host registrar behavior for the read-only status command. */
  readonly commandRegistration?: "ok" | "missing" | "throws";
}

class Host {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly commands = new Map<string, (args: string, context: DefinedNativeContext) => unknown>();
  readonly notifications: string[] = [];
  readonly diagnostics: DefinitionBindingDiagnostic[] = [];
  readonly modelCalls: DefinedModel[] = [];
  readonly toolSets: string[][] = [];
  readonly pi: DefinedOmpApi;
  readonly context: DefinedNativeContext;
  activeTools: string[];
  currentModel: DefinedModel | undefined;
  models: Map<string, DefinedModel>;
  setModelResult: boolean | Promise<boolean>;
  setModelEffect: ((host: Host) => void | Promise<void>) | undefined;
  setActiveToolsError: Error | undefined;
  setActiveToolsEffect: ((host: Host) => void | Promise<void>) | undefined;
  hasPending: boolean;
  hasUI: boolean;
  sessionId: string;
  liveCwd: string;
  agentKind: "main" | "sub" | "unknown";
  commandRegistration: "ok" | "missing" | "throws";
  modelResolveCalls = 0;
  aborts = 0;
  flag: string | undefined;
  setModelStarted: Promise<void>;
  private readonly markSetModelStarted: () => void;

  constructor(options: HostOptions = {}) {
    this.activeTools = [...(options.activeTools ?? ["read", "write", ...DEFINITION_BINDING_COMPANION_TOOLS])];
    this.currentModel = options.currentModel ?? MAIN_MODEL;
    this.models = new Map(options.models ?? [
      ["fixture/main", MAIN_MODEL],
      ["fixture/other", OTHER_MODEL],
      ["fixture/model", MODELED_MODEL],
    ]);
    this.setModelResult = options.setModelResult ?? true;
    this.setModelEffect = options.setModelEffect;
    this.setActiveToolsError = options.setActiveToolsError;
    this.setActiveToolsEffect = options.setActiveToolsEffect;
    this.hasPending = options.hasPending ?? false;
    this.hasUI = options.hasUI ?? true;
    this.sessionId = options.sessionId ?? "session-main-a";
    this.liveCwd = options.liveCwd ?? "";
    this.agentKind = options.agentKind ?? "main";
    this.commandRegistration = options.commandRegistration ?? "ok";
    this.flag = undefined;
    let mark!: () => void;
    this.setModelStarted = new Promise<void>((resolve) => {
      mark = resolve;
    });
    this.markSetModelStarted = mark;

    const host = this;
    this.context = {
      get cwd() {
        return host.liveCwd;
      },
      get agent() {
        // Tests can simulate an unsupported runtime identity beyond the public type.
        return { kind: host.agentKind } as NonNullable<NativeContext["agent"]>;
      },
      get hasUI() {
        return host.hasUI;
      },
      get model() {
        return host.currentModel;
      },
      sessionManager: {
        getSessionId() {
          return host.sessionId;
        },
        getCwd() {
          return host.liveCwd;
        },
      },
      ui: {
        notify(message: string) {
          host.notifications.push(message);
        },
      },
      models: {
        current() {
          return host.currentModel;
        },
        resolve(spec: string) {
          host.modelResolveCalls += 1;
          return host.models.get(spec);
        },
      },
      abort() {
        host.aborts += 1;
      },
      hasPendingMessages() {
        return host.hasPending;
      },
    };
    const registerCommand: RegisteredCommand | undefined = host.commandRegistration === "missing"
      ? undefined
      : (name, commandOptions) => {
          if (host.commandRegistration === "throws") {
            throw new Error("synthetic status command registration failure");
          }
          host.commands.set(name, commandOptions.handler);
        };
    this.pi = {
      on(event, handler) {
        const list = host.handlers.get(event) ?? [];
        list.push(handler);
        host.handlers.set(event, list);
      },
      registerTool(tool) {
        host.tools.set(tool.name, tool);
      },
      registerFlag(name, flagOptions) {
        expect(name).toBe("agent-definition");
        expect(flagOptions.type).toBe("string");
      },
      getFlag() {
        return host.flag;
      },
      ...(registerCommand === undefined ? {} : { registerCommand }),
      getActiveTools() {
        return [...host.activeTools];
      },
      async setActiveTools(tools) {
        if (host.setActiveToolsError !== undefined) throw host.setActiveToolsError;
        host.toolSets.push([...tools]);
        host.activeTools = [...tools];
        await host.setActiveToolsEffect?.(host);
      },
      async setModel(model) {
        host.modelCalls.push(model);
        host.markSetModelStarted();
        const applied = await host.setModelResult;
        if (applied) host.currentModel = model;
        await host.setModelEffect?.(host);
        return applied;
      },
    };
  }

  async emit(type: string, event: Record<string, unknown>, context: NativeContext = this.context): Promise<unknown> {
    let current = event;
    let last: unknown;
    for (const handler of this.handlers.get(type) ?? []) {
      const result = await handler({ ...current, type }, context);
      last = result;
      if (type === "input" && isRecord(result) && result.handled === true) return result;
      if (type === "tool_call" && isRecord(result) && result.block === true) return result;
      if (type === "before_agent_start" && isRecord(result) && Array.isArray(result.systemPrompt)) {
        current = { ...current, systemPrompt: result.systemPrompt };
      }
    }
    return last;
  }

  async sessionStart(context: NativeContext = this.context): Promise<void> {
    await this.emit("session_start", {}, context);
  }

  async input(text: string, context: NativeContext = this.context): Promise<unknown> {
    return await this.emit("input", { text, source: "rpc" }, context);
  }

  async prompt(prompt: string, context: NativeContext = this.context): Promise<{ systemPrompt?: string[] } | undefined> {
    return await this.emit("before_agent_start", {
      reason: "prompt",
      prompt,
      systemPrompt: ["base-prompt"],
    }, context) as { systemPrompt?: string[] } | undefined;
  }

  async observe(toolCallId: string, toolName: string, text: string, context: NativeContext = this.context): Promise<void> {
    await this.emit("tool_call", { toolCallId, toolName, input: {} }, context);
    await this.emit("tool_result", {
      toolCallId,
      toolName,
      input: {},
      content: [{ type: "text", text }],
      isError: false,
    }, context);
  }

  async callTool(
    toolName: string,
    toolCallId: string,
    params: unknown,
    context: NativeContext = this.context,
  ): Promise<NativeToolResult | { readonly blocked: unknown }> {
    const gate = await this.emit("tool_call", { toolCallId, toolName, input: params }, context);
    if (isRecord(gate) && gate.block === true) return { blocked: gate };
    const tool = this.tools.get(toolName);
    if (tool === undefined) throw new Error(`${toolName} was not registered`);
    const result = await tool.execute(toolCallId, params, undefined, undefined, context);
    await this.emit("tool_result", {
      toolCallId,
      toolName,
      input: params,
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    }, context);
    return result;
  }

  async report(toolCallId: string, checks: Array<{ toolCallId: string; purpose: string }>): Promise<NativeToolResult> {
    const result = await this.callTool(AGENT_WORK, toolCallId, {
      action: "report",
      checks,
      outcome: "completed",
      limitations: [],
    });
    if ("blocked" in result) throw new Error("agent_work was unexpectedly blocked");
    return result;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newHost(fixture: DefinitionFixture, options: HostOptions = {}): Host {
  const host = new Host({
    liveCwd: fixture.workspace,
    ...options,
  });
  return host;
}

function startEntry(
  host: Host,
  fixture: DefinitionFixture,
  options: {
    readonly loadDefinition?: DefinitionLoader;
    readonly definitionPath?: string;
    readonly useFlag?: boolean;
    readonly startupTimeoutMs?: number;
  } = {},
): DefinedNativeEntryControls {
  const control = createDefinedNativeEntry(host.pi, {
    ...(options.useFlag === true
      ? {}
      : { definitionPath: options.definitionPath ?? fixture.definitionPath }),
    nativePorts: fixture.ports,
    diagnostic: (event) => host.diagnostics.push(event),
    ...(options.loadDefinition === undefined ? {} : { loadDefinition: options.loadDefinition }),
    ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
  });
  controls.push(control);
  return control;
}

function reportDetails(result: NativeToolResult): Record<string, any> {
  expect(result.isError).not.toBe(true);
  return result.details as Record<string, any>;
}

function statusOf(control: DefinedNativeEntryControls): Record<string, any> {
  return control.controller.getStatus();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not settle");
}

describe("optional main definition binding", () => {
  test("blocks input while resolving, then publishes one actual host binding", async () => {
    const fixture = await definitionFixture({
      name: "alpha",
      body: "ALPHA_DEFINITION_BODY",
      tools: ["read"],
    });
    const host = newHost(fixture);
    let release!: (snapshot: DefinitionSnapshot) => void;
    const deferredSnapshot = new Promise<DefinitionSnapshot>((resolve) => {
      release = resolve;
    });
    const snapshot = await loadFixtureSnapshot(
      fixture,
      (selector) => host.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const control = startEntry(host, fixture, { loadDefinition: () => deferredSnapshot });

    let startupResolved = false;
    const startup = host.sessionStart().then(() => {
      startupResolved = true;
    });
    await waitFor(() => statusOf(control).phase === "resolving");
    expect(startupResolved).toBe(false);
    expect(await host.input("queued while resolving")).toEqual({ handled: true });
    expect(statusOf(control).blocked).toBe(true);
    expect(host.notifications.at(-1)).toContain("still resolving");

    release(snapshot);
    await startup;
    expect(startupResolved).toBe(true);
    const status = statusOf(control);
    expect(status.phase).toBe("bound");
    expect(status.bindingId).toMatch(/^binding-1-/);
    expect(status.version).toBe(snapshot.version);
    expect(status.selectedSource).toEqual({ kind: "explicit-host-path", definitionPath: fixture.definitionPath });
    expect(status.freezeScope).toBe("initial-text");
    expect(status.effectiveTools).toEqual(["agent_definition", "agent_work", "read"]);
    expect(status.roleTools).toEqual(["read"]);

    expect(await host.input("now allowed")).toBeUndefined();
    const prompt = await host.prompt("now allowed");
    expect(prompt?.systemPrompt?.[0]).toBe("base-prompt");
    expect(prompt?.systemPrompt?.join("\n")).toContain("ALPHA_DEFINITION_BODY");
  });

  test("reads the --agent-definition flag once at first main start, not in the factory", async () => {
    const fixture = await definitionFixture({
      name: "flag-timing",
      body: "FLAG_TIMING_BODY",
      tools: ["read"],
    });
    const host = newHost(fixture);
    host.flag = undefined;
    const control = startEntry(host, fixture, { useFlag: true });
    expect(statusOf(control).phase).toBe("unselected");
    expect(await host.input("before host startup")).toEqual({ handled: true });

    host.flag = fixture.definitionPath;
    await host.sessionStart();
    await control.controller.whenIdle();
    const bound = statusOf(control);
    expect(bound.phase).toBe("bound");
    expect(bound.selectedSource).toEqual({ kind: "explicit-host-path", definitionPath: fixture.definitionPath });

    // The value is read once. A later flag mutation cannot reselect.
    host.flag = "/tmp/other-agent.md";
    expect(await host.input("after startup")).toBeUndefined();
    expect(statusOf(control).version).toBe(bound.version);
  });

  test("a pre-existing native import failure is not reset by a late path read", async () => {
    const fixture = await definitionFixture({ name: "late-path", body: "body", tools: ["read"] });
    const host = newHost(fixture);
    host.flag = undefined;
    const control = startEntry(host, fixture, {
      useFlag: true,
      loadDefinition: async () => {
        throw new Error("late loader must not run");
      },
    });
    control.controller.nativePortsFailed("Native module import failed: synthetic");
    host.flag = fixture.definitionPath;
    await host.sessionStart();
    await control.controller.whenIdle();
    const status = statusOf(control);
    expect(status.phase).toBe("failed");
    expect(status.failure).toContain("synthetic");
    expect(status.failure).not.toContain("select");
    expect(await host.input("blocked")).toEqual({ handled: true });
  });

  test("startup waits for binding, but a timeout fails closed and late success cannot revive it", async () => {
    const fixture = await definitionFixture({
      name: "startup-timeout",
      body: "TIMEOUT_BODY",
      tools: ["read"],
    });
    let release!: (snapshot: DefinitionSnapshot) => void;
    const pending = new Promise<DefinitionSnapshot>((resolve) => {
      release = resolve;
    });
    const snapshot = await loadFixtureSnapshot(
      fixture,
      (selector) => new Map<string, DefinedModel>([
        ["fixture/main", MAIN_MODEL],
        ["fixture/model", MODELED_MODEL],
      ]).get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const host = newHost(fixture);
    const control = startEntry(host, fixture, {
      loadDefinition: () => pending,
      startupTimeoutMs: 5,
    });
    await host.sessionStart();
    const timedOut = statusOf(control);
    expect(timedOut.phase).toBe("failed");
    expect(timedOut.failure).toContain("timed out");
    expect(timedOut.restartRequired).toBe(true);
    expect(timedOut.bindingId).toBeNull();

    release(snapshot);
    await control.controller.whenIdle();
    expect(statusOf(control).phase).toBe("failed");
    expect(statusOf(control).bindingId).toBeNull();
    expect(await host.input("after timeout")).toEqual({ handled: true });
  });

  test("an oversized startup override clamps below the host's fixed 30 s deadline", async () => {
    const fixture = await definitionFixture({
      name: "startup-clamp",
      body: "CLAMP_BODY",
      tools: ["read"],
    });
    const host = newHost(fixture);
    const control = startEntry(host, fixture, {
      loadDefinition: () => new Promise<DefinitionSnapshot>(() => {}),
      startupTimeoutMs: 1_000_000,
    });
    jest.useFakeTimers();
    try {
      void host.sessionStart();
      expect(statusOf(control).phase).toBe("resolving");

      jest.advanceTimersByTime(24_999);
      // Flush timeout/race continuations without advancing fake time further.
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(statusOf(control).phase).toBe("resolving");

      jest.advanceTimersByTime(1);
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      const timedOut = statusOf(control);
      expect(timedOut.phase).toBe("failed");
      expect(timedOut.failure).toContain("timed out after 25000ms");
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects missing model, inactive tool and missing Skill without a fallback", async () => {
    const cases: Array<{ fixture: DefinitionFixture; pattern: RegExp }> = [];
    const missingModel = await definitionFixture({
      name: "missing-model",
      body: "body",
      model: "native/missing",
    });
    cases.push({ fixture: missingModel, pattern: /no exact model/ });

    const missingTool = await definitionFixture({
      name: "missing-tool",
      body: "body",
      tools: ["not_active"],
    });
    cases.push({ fixture: missingTool, pattern: /not currently active/ });

    const missingSkill = await definitionFixture({
      name: "missing-skill",
      body: "body",
      selectedSkills: ["absent-skill"],
    });
    cases.push({ fixture: missingSkill, pattern: /missing Skill/ });

    for (const entry of cases) {
      const host = newHost(entry.fixture);
      const control = startEntry(host, entry.fixture);
      await host.sessionStart();
      await control.controller.whenIdle();
      const status = statusOf(control);
      expect(status.phase).toBe("failed");
      expect(status.failure).toMatch(entry.pattern);
      expect(status.bindingId).toBeNull();
      expect(status.restartRequired).toBe(true);
      expect(status.nativeQueuedMessagesMayBeRetained).toBe(true);
      expect(host.modelCalls).toHaveLength(0);
      expect(await host.input("must not run")).toEqual({ handled: true });
      const toolCall = await host.emit("tool_call", { toolCallId: "blocked", toolName: "read", input: {} });
      expect(toolCall).toMatchObject({ block: true });
      expect(host.diagnostics.some((event) => event.type === "failed")).toBe(true);
      control.dispose();
    }
  });

  test("binds two distinct definitions; omitted tools inherit while explicit [] keeps companions only", async () => {
    const inherited = await definitionFixture({
      name: "inherited",
      body: "INHERITED_BODY",
    });
    const inheritedHost = newHost(inherited);
    const inheritedControl = startEntry(inheritedHost, inherited);
    await inheritedHost.sessionStart();
    await inheritedControl.controller.whenIdle();
    const inheritedStatus = statusOf(inheritedControl);
    expect(inheritedStatus.phase).toBe("bound");
    expect(inheritedStatus.roleTools).toEqual(["read", "write"]);
    expect(inheritedStatus.effectiveTools).toEqual(["agent_definition", "agent_work", "read", "write"]);
    expect(inheritedHost.toolSets).toHaveLength(0);

    const explicitEmpty = await definitionFixture({
      name: "empty",
      body: "EMPTY_BODY",
      tools: [],
    });
    const emptyHost = newHost(explicitEmpty);
    const emptyControl = startEntry(emptyHost, explicitEmpty);
    await emptyHost.sessionStart();
    await emptyControl.controller.whenIdle();
    const emptyStatus = statusOf(emptyControl);
    expect(emptyStatus.phase).toBe("bound");
    expect(emptyStatus.roleTools).toEqual([]);
    expect(emptyStatus.effectiveTools).toEqual(["agent_definition", "agent_work"]);
    expect(emptyStatus.version).not.toBe(inheritedStatus.version);
    expect(emptyHost.toolSets.at(-1)).toEqual(["agent_definition", "agent_work"]);

    const statusTool = await emptyHost.callTool(AGENT_DEFINITION_TOOL, "status-1", {});
    expect("blocked" in statusTool).toBe(false);
    const statusResult = statusTool as NativeToolResult;
    expect(statusResult.isError).not.toBe(true);
    const text = statusResult.content[0]?.text ?? "";
    const parsed = JSON.parse(text) as Record<string, any>;
    expect(parsed.bindingId).toBe(emptyStatus.bindingId);
    expect(parsed.version).toBe(emptyStatus.version);
    expect(parsed.model).toEqual({
      provider: "fixture",
      id: "main",
      selector: null,
      selectorKind: "host-current",
    });
    expect(parsed.effectiveTools).toEqual(["agent_definition", "agent_work"]);
    expect(parsed.freezeScope).toBe("initial-text");
  });

  test("status tool and command refresh drift and never write raw RPC stdout", async () => {
    const toolFixture = await definitionFixture({ name: "status-drift", body: "body", tools: ["read"] });
    const toolHost = newHost(toolFixture);
    const toolControl = startEntry(toolHost, toolFixture);
    await toolHost.sessionStart();
    await toolControl.controller.whenIdle();
    expect(statusOf(toolControl).phase).toBe("bound");
    toolHost.currentModel = OTHER_MODEL;
    const toolResult = await toolHost.callTool(AGENT_DEFINITION_TOOL, "status-drift-call", {});
    expect("blocked" in toolResult).toBe(false);
    const result = toolResult as NativeToolResult;
    expect(result.isError).not.toBe(true);
    const refreshed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any>;
    expect(refreshed.phase).toBe("failed");
    expect(refreshed.bindingId).toBeNull();
    expect(refreshed.failure).toContain("model changed");

    const commandFixture = await definitionFixture({ name: "command-drift", body: "body", tools: ["read"] });
    const commandHost = newHost(commandFixture, { hasUI: false });
    const commandControl = startEntry(commandHost, commandFixture);
    await commandHost.sessionStart();
    await commandControl.controller.whenIdle();
    expect(statusOf(commandControl).phase).toBe("bound");
    commandHost.currentModel = OTHER_MODEL;
    const command = commandHost.commands.get("agent-definition-status");
    expect(command).toBeDefined();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await command!("", commandHost.context);
    } finally {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    }
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("agent_definition_status");
    expect(stderr.join("")).toContain("phase");
    expect(stderr.join("")).toContain("failed");
    expect(stderr.join("")).toContain("model changed");
  });

  test("exact registered status command survives a failed binding without rebinding or invoking setters", async () => {
    const fixture = await definitionFixture({
      name: "failed-status",
      body: "body",
      selectedSkills: ["absent-skill"],
    });
    const host = newHost(fixture);
    let loaderCalls = 0;
    const loadDefinition: DefinitionLoader = async (input) => {
      loaderCalls += 1;
      return await loadDefinitionSnapshot({
        definitionPath: input.definitionPath,
        workspaceRoot: input.workspaceRoot,
        parseAgent: fixture.ports.parseAgent,
        parseFrontmatter: fixture.ports.parseFrontmatter,
        availableSkills: fixture.ports.getActiveSkills().map((skill) => skill as DefinitionSkillMetadata),
        availableTools: input.availableTools,
        currentModel: input.currentModel,
        resolveModel: input.resolveModel,
        nativeSource: "explicit",
      });
    };
    const control = startEntry(host, fixture, { loadDefinition });
    await host.sessionStart();
    await control.controller.whenIdle();
    const failed = statusOf(control);
    expect(failed.phase).toBe("failed");
    expect(failed.failure).toContain("missing Skill");
    expect(loaderCalls).toBe(1);

    expect(await host.input("ordinary failed work")).toEqual({ handled: true });
    expect(await host.input("  /agent-definition-status  ")).toBeUndefined();
    expect(await host.input("/agent-definition-status extra")).toEqual({ handled: true });
    expect(await host.input("//agent-definition-status")).toEqual({ handled: true });
    expect(await host.input("agent-definition-status")).toEqual({ handled: true });
    expect(await host.input("/agent-definition-status-other")).toEqual({ handled: true });

    const command = host.commands.get("agent-definition-status");
    expect(command).toBeDefined();
    const before = {
      loads: loaderCalls,
      modelCalls: host.modelCalls.length,
      toolSets: host.toolSets.length,
      modelResolves: host.modelResolveCalls,
      aborts: host.aborts,
    };
    await command!("ignored arguments", host.context);
    expect(host.notifications.at(-1)).toContain('"phase":"failed"');
    expect(host.notifications.at(-1)).toContain("missing Skill");
    expect(loaderCalls).toBe(before.loads);
    expect(host.modelCalls).toHaveLength(before.modelCalls);
    expect(host.toolSets).toHaveLength(before.toolSets);
    expect(host.modelResolveCalls).toBe(before.modelResolves);
    expect(host.aborts).toBe(before.aborts);
    expect(statusOf(control).phase).toBe("failed");
    expect(statusOf(control).bindingId).toBeNull();

    // An unexpected prompt dispatch for the same text remains aborted.
    expect(await host.prompt("/agent-definition-status")).toBeUndefined();
    expect(host.aborts).toBe(before.aborts + 1);
  });

  test("the status input exception exists only after successful command registration", async () => {
    for (const commandRegistration of ["missing", "throws"] as const) {
      const fixture = await definitionFixture({
        name: `registration-${commandRegistration}`,
        body: "body",
        selectedSkills: ["absent-skill"],
      });
      const host = newHost(fixture, { commandRegistration });
      const control = startEntry(host, fixture);
      await host.sessionStart();
      await control.controller.whenIdle();
      expect(statusOf(control).phase).toBe("failed");
      expect(host.commands.has("agent-definition-status")).toBe(false);
      expect(await host.input("/agent-definition-status")).toEqual({ handled: true });
      expect(await host.input("  /agent-definition-status  ")).toEqual({ handled: true });
      control.dispose();
    }
  });

  test("unknown identity still gates the exact status command", async () => {
    const fixture = await definitionFixture({ name: "unknown-command", body: "body" });
    const host = newHost(fixture, { agentKind: "unknown" });
    const control = startEntry(host, fixture);
    await host.sessionStart();
    expect(host.commands.has("agent-definition-status")).toBe(true);
    expect(await host.input("/agent-definition-status")).toEqual({ handled: true });
    expect(await host.input("  /agent-definition-status  ")).toEqual({ handled: true });
    const status = statusOf(control);
    expect(status.phase).toBe("failed");
    expect(status.failure).toContain("identity is unavailable");
    control.dispose();
  });

  test("model setter false, tool setter failure and later drift fail explicitly", async () => {
    const modeled = await definitionFixture({
      name: "modeled",
      body: "body",
      tools: ["read"],
      model: "fixture/model",
    });
    const modelHost = newHost(modeled, { setModelResult: false });
    const modelControl = startEntry(modelHost, modeled);
    await modelHost.sessionStart();
    await modelControl.controller.whenIdle();
    expect(statusOf(modelControl).phase).toBe("failed");
    expect(statusOf(modelControl).failure).toContain("model setter returned false");
    expect(modelHost.modelCalls).toHaveLength(1);

    const empty = await definitionFixture({ name: "empty-tools", body: "body", tools: [] });
    const toolHost = newHost(empty, { setActiveToolsError: new Error("tool setter failed") });
    const toolControl = startEntry(toolHost, empty);
    await toolHost.sessionStart();
    await toolControl.controller.whenIdle();
    expect(statusOf(toolControl).phase).toBe("failed");
    expect(statusOf(toolControl).failure).toContain("tool setter failed");

    const driftFixture = await definitionFixture({
      name: "drift",
      body: "body",
      tools: ["read"],
    });
    const driftHost = newHost(driftFixture);
    const driftControl = startEntry(driftHost, driftFixture);
    await driftHost.sessionStart();
    await driftControl.controller.whenIdle();
    expect(statusOf(driftControl).phase).toBe("bound");

    driftHost.currentModel = OTHER_MODEL;
    expect(await driftHost.input("drift")).toEqual({ handled: true });
    expect(statusOf(driftControl).phase).toBe("failed");
    expect(statusOf(driftControl).failure).toContain("model changed");
    expect(driftHost.aborts).toBe(0);

    const toolsFixture = await definitionFixture({
      name: "tool-drift",
      body: "body",
      tools: ["read"],
    });
    const toolsHost = newHost(toolsFixture);
    const toolsControl = startEntry(toolsHost, toolsFixture);
    await toolsHost.sessionStart();
    await toolsControl.controller.whenIdle();
    toolsHost.activeTools = [...toolsHost.activeTools, "bash"];
    expect(await toolsHost.input("tool drift")).toEqual({ handled: true });
    expect(statusOf(toolsControl).phase).toBe("failed");
    expect(statusOf(toolsControl).failure).toContain("tools changed");
  });

  test("host tool/model changes during load or async apply fail instead of being overwritten", async () => {
    const toolFixture = await definitionFixture({
      name: "load-tool-change",
      body: "body",
      tools: ["read", "write"],
    });
    const toolHost = newHost(toolFixture);
    let releaseTools!: (snapshot: DefinitionSnapshot) => void;
    const pendingTools = new Promise<DefinitionSnapshot>((resolve) => {
      releaseTools = resolve;
    });
    const toolSnapshot = await loadFixtureSnapshot(
      toolFixture,
      (selector) => toolHost.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const toolControl = startEntry(toolHost, toolFixture, { loadDefinition: () => pendingTools });
    const toolStartup = toolHost.sessionStart();
    await waitFor(() => statusOf(toolControl).phase === "resolving");
    toolHost.activeTools = toolHost.activeTools.filter((name) => name !== "write");
    const changedTools = [...toolHost.activeTools];
    releaseTools(toolSnapshot);
    await toolStartup;
    await toolControl.controller.whenIdle();
    expect(statusOf(toolControl).phase).toBe("failed");
    expect(statusOf(toolControl).failure).toContain("tools changed while the definition was loading");
    expect(toolHost.toolSets).toHaveLength(0);
    expect(toolHost.activeTools).toEqual(changedTools);
    expect(toolHost.activeTools).not.toContain("write");

    const modelFixture = await definitionFixture({
      name: "load-model-change",
      body: "body",
      tools: ["read"],
    });
    const modelHost = newHost(modelFixture);
    let releaseModel!: (snapshot: DefinitionSnapshot) => void;
    const pendingModel = new Promise<DefinitionSnapshot>((resolve) => {
      releaseModel = resolve;
    });
    const modelSnapshot = await loadFixtureSnapshot(
      modelFixture,
      (selector) => modelHost.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const modelControl = startEntry(modelHost, modelFixture, { loadDefinition: () => pendingModel });
    const modelStartup = modelHost.sessionStart();
    await waitFor(() => statusOf(modelControl).phase === "resolving");
    modelHost.currentModel = OTHER_MODEL;
    releaseModel(modelSnapshot);
    await modelStartup;
    await modelControl.controller.whenIdle();
    expect(statusOf(modelControl).phase).toBe("failed");
    expect(statusOf(modelControl).failure).toContain("model changed while the definition was loading");
    expect(modelHost.modelCalls).toHaveLength(0);

    const explicitFixture = await definitionFixture({
      name: "explicit-model-race",
      body: "body",
      tools: ["read"],
      model: "fixture/model",
    });
    const explicitHost = newHost(explicitFixture);
    let releaseExplicit!: (snapshot: DefinitionSnapshot) => void;
    const pendingExplicit = new Promise<DefinitionSnapshot>((resolve) => {
      releaseExplicit = resolve;
    });
    const explicitSnapshot = await loadFixtureSnapshot(
      explicitFixture,
      (selector) => explicitHost.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const explicitControl = startEntry(explicitHost, explicitFixture, { loadDefinition: () => pendingExplicit });
    const explicitStartup = explicitHost.sessionStart();
    await waitFor(() => statusOf(explicitControl).phase === "resolving");
    explicitHost.currentModel = OTHER_MODEL;
    releaseExplicit(explicitSnapshot);
    await explicitStartup;
    await explicitControl.controller.whenIdle();
    expect(statusOf(explicitControl).phase).toBe("failed");
    expect(statusOf(explicitControl).failure).toContain("model changed while the definition was loading");
    expect(explicitHost.modelCalls).toHaveLength(0);

    const asyncToolsFixture = await definitionFixture({
      name: "async-tool-model-change",
      body: "body",
      tools: [],
    });
    const asyncToolsHost = newHost(asyncToolsFixture, {
      setActiveToolsEffect(host) {
        host.currentModel = OTHER_MODEL;
      },
    });
    const asyncToolsControl = startEntry(asyncToolsHost, asyncToolsFixture);
    await asyncToolsHost.sessionStart();
    await asyncToolsControl.controller.whenIdle();
    expect(statusOf(asyncToolsControl).phase).toBe("failed");
    expect(statusOf(asyncToolsControl).failure).toContain("model changed while tools were being applied");
    expect(statusOf(asyncToolsControl).bindingId).toBeNull();

    const setterToolsFixture = await definitionFixture({
      name: "setter-tool-change",
      body: "body",
      tools: ["read", "write"],
      model: "fixture/model",
    });
    const setterToolsHost = newHost(setterToolsFixture, {
      setModelEffect(host) {
        host.activeTools = host.activeTools.filter((name) => name !== "write");
      },
    });
    const setterToolsControl = startEntry(setterToolsHost, setterToolsFixture);
    await setterToolsHost.sessionStart();
    await setterToolsControl.controller.whenIdle();
    expect(statusOf(setterToolsControl).phase).toBe("failed");
    expect(statusOf(setterToolsControl).failure).toContain("tools changed while the model was being applied");
    expect(setterToolsHost.toolSets).toHaveLength(0);
  });

  test("navigation, workspace/session change and dispose cancel late binding", async () => {
    const navigationFixture = await definitionFixture({
      name: "navigation",
      body: "NAVIGATION_BODY",
      tools: ["read"],
    });
    const navigationHost = newHost(navigationFixture);
    let releaseNavigation!: (snapshot: DefinitionSnapshot) => void;
    const navigationSnapshot = new Promise<DefinitionSnapshot>((resolve) => {
      releaseNavigation = resolve;
    });
    const navigationSnapshotValue = await loadFixtureSnapshot(
      navigationFixture,
      (selector) => navigationHost.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const navigationControl = startEntry(navigationHost, navigationFixture, {
      loadDefinition: () => navigationSnapshot,
    });
    const navigationStartup = navigationHost.sessionStart();
    await waitFor(() => statusOf(navigationControl).phase === "resolving");
    await navigationHost.emit("session_branch", { reason: "branch" });
    releaseNavigation(navigationSnapshotValue);
    await navigationStartup;
    await navigationControl.controller.whenIdle();
    expect(statusOf(navigationControl).phase).toBe("failed");
    expect(statusOf(navigationControl).failure).toContain("session_branch");
    expect(statusOf(navigationControl).navigationEpoch).toBe(1);

    const setterFixture = await definitionFixture({
      name: "setter-race",
      body: "body",
      tools: ["read"],
      model: "fixture/model",
    });
    let releaseSetter!: (value: boolean) => void;
    const setterResult = new Promise<boolean>((resolve) => {
      releaseSetter = resolve;
    });
    const setterHost = newHost(setterFixture, { setModelResult: setterResult });
    const setterControl = startEntry(setterHost, setterFixture);
    const setterStartup = setterHost.sessionStart();
    await setterHost.setModelStarted;
    expect(statusOf(setterControl).phase).toBe("resolving");
    await setterHost.emit("session_clear", {});
    releaseSetter(true);
    await setterStartup;
    await setterControl.controller.whenIdle();
    expect(statusOf(setterControl).phase).toBe("failed");
    expect(statusOf(setterControl).failure).toContain("session_clear");

    const disposeFixture = await definitionFixture({
      name: "dispose-race",
      body: "body",
      tools: ["read"],
    });
    const disposeHost = newHost(disposeFixture);
    let releaseDispose!: (snapshot: DefinitionSnapshot) => void;
    const disposeSnapshot = new Promise<DefinitionSnapshot>((resolve) => {
      releaseDispose = resolve;
    });
    const disposeSnapshotValue = await loadFixtureSnapshot(
      disposeFixture,
      (selector) => disposeHost.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const disposeControl = startEntry(disposeHost, disposeFixture, {
      loadDefinition: () => disposeSnapshot,
    });
    const disposeStartup = disposeHost.sessionStart();
    await waitFor(() => statusOf(disposeControl).phase === "resolving");
    disposeControl.dispose();
    releaseDispose(disposeSnapshotValue);
    await disposeStartup;
    await disposeControl.controller.whenIdle();
    expect(statusOf(disposeControl).phase).toBe("disposed");
  });

  test("session id and live cwd changes never bind across identity", async () => {
    const fixture = await definitionFixture({ name: "identity", body: "body", tools: ["read"] });
    const host = newHost(fixture);
    const control = startEntry(host, fixture);
    await host.sessionStart();
    await control.controller.whenIdle();
    expect(statusOf(control).phase).toBe("bound");

    host.sessionId = "session-main-b";
    expect(await host.input("wrong session")).toEqual({ handled: true });
    expect(statusOf(control).phase).toBe("failed");
    expect(statusOf(control).failure).toContain("session id");

    const movedFixture = await definitionFixture({ name: "moved", body: "body", tools: ["read"] });
    const movedHost = newHost(movedFixture);
    const movedControl = startEntry(movedHost, movedFixture);
    await movedHost.sessionStart();
    await movedControl.controller.whenIdle();
    const otherWorkspace = path.join(movedFixture.root, "other-workspace");
    await mkdir(otherWorkspace, { mode: 0o700 });
    movedHost.liveCwd = await realpath(otherWorkspace);
    expect(await movedHost.input("moved")).toEqual({ handled: true });
    expect(statusOf(movedControl).phase).toBe("failed");
    expect(statusOf(movedControl).failure).toContain("workspace");
  });

  test("unknown or absent agent identity fails closed instead of assuming main", async () => {
    const fixture = await definitionFixture({ name: "unknown", body: "body", tools: ["read"] });
    const host = newHost(fixture, { agentKind: "unknown" });
    const control = startEntry(host, fixture);
    await host.sessionStart();
    const status = statusOf(control);
    expect(status.phase).toBe("failed");
    expect(status.failure).toContain("identity is unavailable");
    expect(status.restartRequired).toBe(true);
    expect(status.bindingId).toBeNull();
    expect(await host.input("unknown input")).toEqual({ handled: true });
    expect(await host.prompt("unknown prompt")).toBeUndefined();
    expect(host.aborts).toBe(1);
    expect(await host.emit("tool_call", { toolCallId: "unknown-call", toolName: "read", input: {} }))
      .toMatchObject({ block: true });
    const diagnostic = await host.callTool(AGENT_DEFINITION_TOOL, "unknown-status", {});
    expect("blocked" in diagnostic).toBe(false);
    const diagnosticResult = diagnostic as NativeToolResult;
    expect(diagnosticResult.isError).toBe(true);
    expect(diagnosticResult.content[0]?.text).toContain("identity is unknown");
    const command = host.commands.get("agent-definition-status");
    expect(command).toBeDefined();
    await command!("", host.context);
    expect(host.notifications.at(-1)).toContain("identity is unknown");
    expect(host.notifications.at(-1)).not.toContain("bindingId");

    const absentFixture = await definitionFixture({ name: "absent", body: "body", tools: ["read"] });
    const absentHost = newHost(absentFixture);
    const absentControl = startEntry(absentHost, absentFixture);
    const absentContext: NativeContext = {
      cwd: absentHost.liveCwd,
      sessionManager: {
        getSessionId: () => absentHost.sessionId,
        getCwd: () => absentHost.liveCwd,
      },
    };
    await absentHost.emit("session_start", {}, absentContext);
    expect(statusOf(absentControl).phase).toBe("failed");
    expect(statusOf(absentControl).failure).toContain("identity is unavailable");
    expect(await absentHost.input("absent", absentContext)).toEqual({ handled: true });
    expect(await absentHost.emit("tool_call", { toolCallId: "absent-call", toolName: "read", input: {} }, absentContext))
      .toMatchObject({ block: true });
  });

  test("managed TaskOwner conflicts fail and subagents never pretend main policy", async () => {
    const ownerFixture = await definitionFixture({ name: "owner", body: "body", tools: ["read"] });
    publishTaskOwner({ ownerId: "fixture-owner" } as unknown as TaskOwner);
    const ownerHost = newHost(ownerFixture);
    const ownerControl = startEntry(ownerHost, ownerFixture);
    await ownerHost.sessionStart();
    await ownerControl.controller.whenIdle();
    expect(statusOf(ownerControl).phase).toBe("failed");
    expect(statusOf(ownerControl).failure).toContain("TaskOwner");
    expect(ownerHost.modelCalls).toHaveLength(0);
    clearPublishedTaskOwner();

    const subFixture = await definitionFixture({ name: "sub", body: "SUB_BODY", tools: ["read"] });
    const subHost = newHost(subFixture, { agentKind: "sub" });
    const subControl = startEntry(subHost, subFixture);
    await subHost.sessionStart();
    const subStatus = statusOf(subControl);
    expect(subStatus.phase).toBe("failed");
    expect(subStatus.failure).toContain("Subagent");
    expect(subStatus.restartRequired).toBe(false);
    expect(await subHost.input("sub input stays native")).toBeUndefined();
    expect(await subHost.prompt("sub prompt")).toBeUndefined();
    expect(await subHost.emit("tool_call", { toolCallId: "sub-call", toolName: "read", input: {} })).toBeUndefined();
    expect(subHost.modelCalls).toHaveLength(0);
  });

  test("wrapped native guidance and agent_work report carry the actual binding without merging revisions", async () => {
    const fixture = await definitionFixture({
      name: "composed",
      description: "composed description",
      body: "COMPOSED_DEFINITION_BODY",
      tools: ["read"],
      skills: [{
        name: "composed-skill",
        description: "skill description",
        body: "COMPOSED_SKILL_BODY",
      }],
      selectedSkills: ["composed-skill"],
    });
    const host = newHost(fixture);
    const control = startEntry(host, fixture);
    await host.sessionStart();
    await control.controller.whenIdle();
    const bound = statusOf(control);
    expect(bound.phase).toBe("bound");

    await host.input("first work");
    const firstPrompt = await host.prompt("first work");
    const firstText = firstPrompt?.systemPrompt?.join("\n") ?? "";
    expect(firstText).toContain("COMPOSED_DEFINITION_BODY");
    expect(firstText).toContain("COMPOSED_SKILL_BODY");
    expect(firstText.split(NATIVE_WORK_GUIDANCE)).toHaveLength(2);

    await host.observe("read-1", "read", "read result one");
    const firstReport = reportDetails(await host.report("report-1", [{
      toolCallId: "read-1",
      purpose: "read the first input",
    }]));
    expect(firstReport.definitionBinding).toMatchObject({
      authority: "non-authoritative",
      bindingId: bound.bindingId,
      version: bound.version,
      freezeScope: "initial-text",
    });
    const firstWork = String(firstReport.work.observationId);

    await host.emit("agent_end", { willContinue: false });
    await host.input("second work");
    const secondPrompt = await host.prompt("second work");
    expect(secondPrompt?.systemPrompt?.join("\n")).toContain("COMPOSED_DEFINITION_BODY");
    await host.observe("read-2", "read", "read result two");
    const secondReport = reportDetails(await host.report("report-2", [{
      toolCallId: "read-2",
      purpose: "read the second input",
    }]));
    expect(secondReport.definitionBinding.version).toBe(bound.version);
    expect(secondReport.definitionBinding.bindingId).toBe(bound.bindingId);
    expect(String(secondReport.work.observationId)).not.toBe(firstWork);
    expect(statusOf(control).version).toBe(bound.version);
  });

  test("before_agent_start aborts failed ingress and status never claims settlement", async () => {
    const fixture = await definitionFixture({
      name: "failed-abort",
      body: "body",
      tools: ["not_active"],
    });
    const host = newHost(fixture, { hasPending: true });
    const control = startEntry(host, fixture);
    await host.sessionStart();
    await control.controller.whenIdle();
    const failed = statusOf(control);
    expect(failed.phase).toBe("failed");
    expect(failed.blocked).toBe(true);
    expect(failed.restartRequired).toBe(true);
    expect(failed.nativeQueuedMessagesMayBeRetained).toBe(true);
    expect(failed.hasPendingMessages).toBe(true);

    expect(await host.prompt("aborted prompt")).toBeUndefined();
    expect(host.aborts).toBe(1);
    const aborted = host.diagnostics.find((event) => event.type === "prompt-aborted");
    expect(aborted?.message).toContain("ctx.abort() was requested");
    expect(aborted?.message).toContain("may remain queued");
    expect(aborted?.message).not.toContain("settled");
    expect(aborted?.hasPendingMessages).toBe(true);

    const blockedTool = await host.emit("tool_call", { toolCallId: "blocked-tool", toolName: "read", input: {} });
    expect(blockedTool).toMatchObject({ block: true });
    expect(await host.emit("tool_call", { toolCallId: "status-call", toolName: AGENT_DEFINITION_TOOL, input: {} })).toBeUndefined();
  });

  test("snapshot text is fixed for the process and status copies are immutable", async () => {
    const fixture = await definitionFixture({ name: "fixed", body: "FIXED_BODY", tools: ["read"] });
    const host = newHost(fixture);
    let calls = 0;
    const original = await loadFixtureSnapshot(
      fixture,
      (selector) => host.models.get(selector),
      ["read", "write"],
      MAIN_MODEL,
    );
    const control = startEntry(host, fixture, {
      loadDefinition: async () => {
        calls += 1;
        return original;
      },
    });
    await host.sessionStart();
    await control.controller.whenIdle();
    expect(calls).toBe(1);
    const first = await host.prompt("first");
    expect(first?.systemPrompt?.join("\n")).toContain("FIXED_BODY");
    await writeFile(fixture.definitionPath, "---\nname: fixed\ndescription: changed\n---\nCHANGED_BODY\n", "utf8");
    const second = await host.prompt("second");
    expect(second?.systemPrompt?.join("\n")).toContain("FIXED_BODY");
    expect(second?.systemPrompt?.join("\n")).not.toContain("CHANGED_BODY");
    expect(calls).toBe(1);

    const status = statusOf(control);
    expect(() => {
      (status as { phase: string }).phase = "failed";
    }).toThrow();
    expect(() => {
      (status.effectiveTools as string[]).push("bash");
    }).toThrow();
    expect(statusOf(control).effectiveTools).not.toContain("bash");

    const replacement = await definitionFixture({ name: "fixed", body: "CHANGED_BODY", tools: ["read"] });
    const replacementHost = newHost(replacement);
    const replacementControl = startEntry(replacementHost, replacement);
    await replacementHost.sessionStart();
    await replacementControl.controller.whenIdle();
    expect(statusOf(replacementControl).version).not.toBe(status.version);
  });
});
