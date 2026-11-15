import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  DEFINITION_FREEZE_SCOPE,
  DEFINITION_ORIGIN,
  DEFINITION_SNAPSHOT_SCHEMA,
  type DefinitionModelRef,
  type DefinitionSnapshot,
} from "../../src/agent-definition.ts";
import {
  AGENT_DEFINITION_STATUS_COMMAND,
  AGENT_DEFINITION_TOOL,
  DEFINITION_BINDING_COMPANION_TOOLS,
  type DefinitionLoader,
} from "../../src/definition-binding.ts";
import {
  AGENT_CHILD_DEFINITIONS_FLAG,
  AGENT_INSTANCES_STATUS_COMMAND,
  createInstancedNativeEntry,
  INSTANCED_NATIVE_ENTRY_SCHEMA,
  type InstancedChildSnapshotInput,
  type InstancedEntryStatus,
  type InstancedModel,
  type InstancedNativeContext,
  type InstancedNativeEntryControls,
  type InstancedNativeEntryOptions,
  type InstancedNativePorts,
  type InstancedOmpApi,
  type InstancedSupportedSettings,
} from "../../src/instanced-native-entry.ts";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";
import { deepFreeze, NATIVE_WORK_TOOL } from "../../src/native-work.ts";

const WORKSPACE = "/workspace";
const MAIN_MODEL: InstancedModel = { provider: "fixture", id: "main" };
const CHILD_MODEL: InstancedModel = { provider: "fixture", id: "child" };
const OTHER_MODEL: InstancedModel = { provider: "fixture", id: "other" };
const SUPPORTED_SETTINGS: InstancedSupportedSettings = {
  asyncEnabled: false,
  taskBatch: false,
  taskSpeculativeLaunch: false,
  taskWorkerThreads: 0,
  taskStructured: false,
};

type RegisteredTool = {
  name: string;
  defaultInactive?: boolean;
  execute(...args: unknown[]): Promise<NativeToolResult>;
};
type Handler = (event: unknown, context: InstancedNativeContext) => unknown;
type CommandHandler = (args: string, context: InstancedNativeContext) => unknown;

interface SkillSpec {
  readonly name: string;
  readonly body: string;
}

interface SnapshotSpec {
  readonly name: string;
  readonly body: string;
  readonly version: string;
  readonly tools?: readonly string[];
  readonly model?: InstancedModel;
  readonly skills?: readonly SkillSpec[];
  readonly canonicalPath?: string;
  readonly rawContent?: string;
  readonly selectorNull?: boolean;
}

function makeSnapshot(spec: SnapshotSpec): DefinitionSnapshot {
  const canonicalPath = spec.canonicalPath ?? `${WORKSPACE}/.omp/agents/${spec.name}.md`;
  const model = spec.model ?? MAIN_MODEL;
  const skills = (spec.skills ?? []).map((skill) => {
    const skillPath = `${WORKSPACE}/.omp/skills/${skill.name}/SKILL.md`;
    return {
      name: skill.name,
      description: `${skill.name} description`,
      canonicalPath: skillPath,
      body: skill.body,
      bodySha256: "skill-body-sha",
      rawContent: `---\nname: ${skill.name}\n---\n${skill.body}\n`,
      bytes: Buffer.byteLength(skill.body),
      sha256: "skill-sha",
      frontmatter: Object.freeze({ name: skill.name, description: `${skill.name} description` }),
    };
  });
  const definition = {
    requestedPath: canonicalPath,
    canonicalPath,
    name: spec.name,
    description: `${spec.name} description`,
    body: spec.body,
    bodySha256: "body-sha",
    rawContent: spec.rawContent ?? `---\nname: ${spec.name}\n---\n${spec.body}\n`,
    bytes: Buffer.byteLength(spec.body),
    sha256: "definition-sha",
    requestedTools: [...(spec.tools ?? ["read"])],
    effectiveTools: [...(spec.tools ?? ["read"])],
    model: {
      provider: model.provider,
      id: model.id,
      selector: spec.selectorNull === true ? null : `${model.provider}/${model.id}`,
      selectorKind: spec.selectorNull === true ? "host-current" : "native-selector",
    },
    autoloadSkills: skills.map((skill) => skill.name),
    frontmatter: Object.freeze({ name: spec.name, description: `${spec.name} description` }),
  };
  return deepFreeze({
    schema: DEFINITION_SNAPSHOT_SCHEMA,
    origin: DEFINITION_ORIGIN,
    freezeScope: DEFINITION_FREEZE_SCOPE,
    version: spec.version,
    workspaceRoot: WORKSPACE,
    nativeSourceLabel: "explicit",
    definition,
    skills,
    getStatus: () => ({}) as never,
  }) as DefinitionSnapshot;
}

function mainSnapshot(): DefinitionSnapshot {
  return makeSnapshot({
    name: "main",
    body: "MAIN_DEFINITION_BODY",
    version: "main-v1",
    tools: ["read", "task"],
    model: MAIN_MODEL,
    selectorNull: true,
  });
}

function childSnapshot(
  name: string,
  body: string,
  version: string,
  options: {
    readonly tools?: readonly string[];
    readonly model?: InstancedModel;
    readonly skills?: readonly SkillSpec[];
    readonly canonicalPath?: string;
    readonly rawContent?: string;
  } = {},
): DefinitionSnapshot {
  return makeSnapshot({
    name,
    body,
    version,
    tools: options.tools ?? ["read"],
    model: options.model ?? CHILD_MODEL,
    skills: options.skills ?? [],
    ...(options.canonicalPath === undefined ? {} : { canonicalPath: options.canonicalPath }),
    ...(options.rawContent === undefined ? {} : { rawContent: options.rawContent }),
  });
}

function makePorts(overrides: Partial<InstancedNativePorts> = {}): InstancedNativePorts {
  return {
    parseAgent: () => {
      throw new Error("fixture parseAgent must not be used");
    },
    parseFrontmatter: () => {
      throw new Error("fixture parseFrontmatter must not be used");
    },
    getActiveSkills: () => [],
    discoverAgents: async () => [],
    renderRoleFrame: (body) => `⁂ Role\n${body}\n⁂ Coop`,
    renderSkillMessage: (skill, body) => ({
      message: `SKILL ${skill.name} ${skill.filePath}\n${body}`,
      details: { name: skill.name, path: skill.filePath },
    }),
    readScopedSettings: () => ({ ok: true, settings: SUPPORTED_SETTINGS }),
    ...overrides,
  };
}

const controls: InstancedNativeEntryControls[] = [];

afterEach(() => {
  for (const control of controls.splice(0)) control.dispose();
});

interface HostOptions {
  readonly agentKind?: "main" | "sub" | "unknown";
  readonly agentId?: string;
  readonly agentName?: string;
  readonly parentId?: string | null;
  readonly depth?: number;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly currentModel?: InstancedModel;
  readonly models?: ReadonlyMap<string, InstancedModel>;
  readonly activeTools?: readonly string[];
  readonly hasUI?: boolean;
  readonly bus?: TestBus;
  /** Synthetic host registrar behavior for both fixed status commands. */
  readonly commandRegistration?: "ok" | "missing" | "throws";
}

interface TestBus {
  on(event: string, handler: (data: unknown) => void): void;
  emit(event: string, data: unknown): void;
}

function createTestBus(): TestBus {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, data) {
      for (const handler of handlers.get(event) ?? []) handler(data);
    },
  };
}

class Host {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly commands = new Map<string, CommandHandler>();
  readonly bus: TestBus;
  readonly flags = new Map<string, string | boolean | undefined>();
  readonly flagRegistrations: { name: string; options: unknown }[] = [];
  readonly notifications: string[] = [];
  readonly diagnostics: { type: string; message: string }[] = [];
  readonly setActiveToolsCalls: string[][] = [];
  readonly pi: InstancedOmpApi;
  readonly context: InstancedNativeContext;
  activeTools: string[];
  currentModel: InstancedModel;
  readonly models: Map<string, InstancedModel>;
  agentKind: "main" | "sub" | "unknown";
  agentId: string;
  name: string;
  parentId: string | null;
  depth: number;
  sessionId: string;
  cwd: string;
  readonly hasUI: boolean;
  readonly commandRegistration: "ok" | "missing" | "throws";
  aborts = 0;

  constructor(options: HostOptions = {}) {
    this.agentKind = options.agentKind ?? "main";
    this.agentId = options.agentId ?? "Main";
    this.name = options.agentName ?? (this.agentKind === "main" ? "main" : "alpha");
    this.parentId = options.parentId ?? null;
    this.depth = options.depth ?? 0;
    this.sessionId = options.sessionId ?? "session-root";
    this.cwd = options.cwd ?? WORKSPACE;
    this.currentModel = options.currentModel ?? MAIN_MODEL;
    this.activeTools = [...(options.activeTools ?? ["read", "task"])];
    this.hasUI = options.hasUI ?? true;
    this.commandRegistration = options.commandRegistration ?? "ok";
    this.bus = options.bus ?? createTestBus();
    this.models = new Map(options.models ?? [
      ["fixture/main", MAIN_MODEL],
      ["fixture/child", CHILD_MODEL],
      ["fixture/other", OTHER_MODEL],
    ]);
    const host = this;
    this.context = {
      get cwd() {
        return host.cwd;
      },
      agent: {
        get kind() {
          return host.agentKind === "unknown" ? undefined : host.agentKind;
        },
        get id() {
          return host.agentId;
        },
        get name() {
          return host.name;
        },
        get parentId() {
          return host.parentId;
        },
        get depth() {
          return host.depth;
        },
      },
      hasUI: this.hasUI,
      get model() {
        return host.currentModel;
      },
      sessionManager: {
        getSessionId() {
          return host.sessionId;
        },
        getCwd() {
          return host.cwd;
        },
      },
      models: {
        current() {
          return host.currentModel;
        },
        resolve(spec: string) {
          return host.models.get(spec);
        },
      },
      ui: {
        notify(message: string) {
          host.notifications.push(message);
        },
      },
      abort() {
        host.aborts += 1;
      },
    } as unknown as InstancedNativeContext;
    this.pi = {
      on(event, handler) {
        const list = host.handlers.get(event) ?? [];
        list.push(handler);
        host.handlers.set(event, list);
      },
      registerTool(tool) {
        host.tools.set(tool.name, tool as RegisteredTool);
      },
      registerFlag(name, flagOptions) {
        host.flagRegistrations.push({ name, options: flagOptions });
      },
      getFlag(name) {
        return host.flags.get(name);
      },
      ...(host.commandRegistration === "missing" ? {} : {
        registerCommand(name: string, commandOptions: { handler: CommandHandler }) {
          if (host.commandRegistration === "throws") {
            throw new Error("synthetic status command registration failure");
          }
          host.commands.set(name, commandOptions.handler);
        },
      }),
      getActiveTools() {
        return [...host.activeTools];
      },
      async setActiveTools(tools) {
        host.setActiveToolsCalls.push([...tools]);
        host.activeTools = [...tools];
      },
      async setModel(model) {
        host.currentModel = model;
        return true;
      },
      events: host.bus,
    } as InstancedOmpApi;
  }

  async emit(type: string, event: Record<string, unknown>, context: InstancedNativeContext = this.context): Promise<unknown> {
    let current = event;
    let last: unknown;
    for (const handler of this.handlers.get(type) ?? []) {
      const result = await handler({ ...current, type }, context);
      last = result;
      if (type === "input" && isRecord(result)) {
        if (result.handled === true) return result;
        if (typeof result.text === "string") current = { ...current, text: result.text };
        if ("images" in result) current = { ...current, images: result.images };
      }
      if (type === "tool_call" && isRecord(result) && result.block === true) return result;
      if (type === "before_agent_start" && isRecord(result) && Array.isArray(result.systemPrompt)) {
        current = { ...current, systemPrompt: result.systemPrompt };
      }
    }
    return last;
  }

  async sessionStart(): Promise<void> {
    await this.emit("session_start", {});
  }

  async input(
    text: string,
    options: { readonly source?: string; readonly images?: unknown } = {},
  ): Promise<unknown> {
    return await this.emit("input", {
      text,
      source: options.source ?? "rpc",
      ...("images" in options ? { images: options.images } : {}),
    });
  }

  async prepare(prompt: string): Promise<unknown> {
    return await this.emit("before_agent_start", {
      reason: "prompt",
      prompt,
      systemPrompt: ["base"],
    });
  }

  /**
   * Minimal fixed-runner analogue: apply input transforms, stop on handled,
   * otherwise dispatch the transformed slash command name to this fake
   * registry. The dispatch control proves command-collision assertions.
   */
  async submit(
    text: string,
    options: { readonly source?: string; readonly images?: unknown } = {},
  ): Promise<{ readonly handled: boolean; readonly command?: string }> {
    let current: Record<string, unknown> = {
      text,
      source: options.source ?? "rpc",
      ...("images" in options ? { images: options.images } : {}),
    };
    for (const handler of this.handlers.get("input") ?? []) {
      const result = await handler({ ...current, type: "input" }, this.context);
      if (isRecord(result)) {
        if (result.handled === true) return { handled: true };
        if (typeof result.text === "string") current = { ...current, text: result.text };
        if ("images" in result) current = { ...current, images: result.images };
      }
    }
    const trimmed = String(current.text).trim();
    const match = /^\/([^\s]+)(?:\s+(.*))?$/s.exec(trimmed);
    const name = match?.[1];
    if (name !== undefined) {
      const command = this.commands.get(name);
      if (command !== undefined) {
        await command(match?.[2] ?? "", this.context);
        return { handled: false, command: name };
      }
    }
    return { handled: false };
  }

  async observe(toolCallId: string, toolName: string, text: string): Promise<void> {
    await this.emit("tool_call", { toolCallId, toolName, input: {} });
    await this.emit("tool_result", {
      toolCallId,
      toolName,
      input: {},
      content: [{ type: "text", text }],
      isError: false,
    });
  }

  async work(toolCallId: string, params: unknown): Promise<NativeToolResult> {
    await this.emit("tool_call", { toolCallId, toolName: NATIVE_WORK_TOOL, input: params });
    const tool = this.tools.get(NATIVE_WORK_TOOL);
    if (tool === undefined) throw new Error("agent_work was not registered");
    const result = await tool.execute(toolCallId, params, undefined, undefined, this.context);
    await this.emit("tool_result", {
      toolCallId,
      toolName: NATIVE_WORK_TOOL,
      input: params,
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    });
    return result;
  }

  async stop(): Promise<{ continue?: boolean; additionalContext?: string } | undefined> {
    const handlers = this.handlers.get("session_stop") ?? [];
    let advisory: { continue?: boolean; additionalContext?: string } | undefined;
    for (const handler of handlers) {
      const result = await handler({
        type: "session_stop",
        signal: new AbortController().signal,
        stop_hook_active: false,
      }, this.context);
      if (advisory === undefined && isRecord(result) && result.continue === true) {
        advisory = result as { continue?: boolean; additionalContext?: string };
      }
    }
    return advisory;
  }

  async prompt(systemPrompt: readonly string[]): Promise<unknown> {
    return await this.emit("before_agent_start", {
      reason: "prompt",
      prompt: "fixture prompt",
      systemPrompt: [...systemPrompt],
    });
  }

  async emitContext(messages: readonly unknown[]): Promise<unknown> {
    return await this.emit("context", { messages: [...messages] });
  }

  async task(toolCallId: string, input: unknown): Promise<unknown> {
    return await this.emit("tool_call", { toolCallId, toolName: "task", input });
  }

  lifecycle(data: Record<string, unknown>): void {
    this.bus.emit("task:subagent:lifecycle", data);
  }

  command(name: string, args = ""): unknown {
    const handler = this.commands.get(name);
    if (handler === undefined) throw new Error(`command ${name} not registered`);
    return handler(args, this.context);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockedReason(value: unknown): string {
  return isRecord(value) && value.block === true && typeof value.reason === "string" ? value.reason : "";
}

interface RootFixture {
  readonly host: Host;
  readonly entry: InstancedNativeEntryControls;
  readonly main: DefinitionSnapshot;
  readonly ports: InstancedNativePorts;
  readonly children: readonly DefinitionSnapshot[];
  readonly loadChild: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>;
  readonly childDefinitions: readonly string[];
  readonly limits: InstancedNativeEntryOptions["limits"];
}

interface RootOptions {
  readonly children?: readonly DefinitionSnapshot[];
  readonly childDefinitions?: readonly string[];
  readonly discover?: (cwd: string) => Promise<readonly { name: string; filePath: string; source: string }[]>;
  readonly loadChild?: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>;
  readonly ports?: Partial<InstancedNativePorts>;
  readonly limits?: InstancedNativeEntryOptions["limits"];
  readonly mainTools?: readonly string[];
  readonly main?: DefinitionSnapshot;
  readonly hostActiveTools?: readonly string[];
  readonly commandRegistration?: "ok" | "missing" | "throws";
}

async function startRoot(options: RootOptions = {}): Promise<RootFixture> {
  const main = options.main ?? mainSnapshot();
  const children = options.children ?? [childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1")];
  const childDefinitions = options.childDefinitions ?? children.map((child) => child.definition.requestedPath);
  const byPath = new Map(children.map((child) => [child.definition.requestedPath, child]));
  const loadChild = options.loadChild ?? (async (input: InstancedChildSnapshotInput) => {
    const snapshot = byPath.get(input.definitionPath);
    if (snapshot === undefined) throw new Error(`no fixture snapshot for ${input.definitionPath}`);
    return snapshot;
  });
  const ports = makePorts({
    discoverAgents: options.discover ?? (async () => children.map((child) => ({
      name: child.definition.name,
      filePath: child.definition.canonicalPath,
      source: "project",
    }))),
    ...options.ports,
  });
  const host = new Host({
    activeTools: options.hostActiveTools ?? (options.mainTools ?? ["read", "task"]),
    ...(options.commandRegistration === undefined ? {} : { commandRegistration: options.commandRegistration }),
  });
  const entry = createInstancedNativeEntry(host.pi, {
    mainDefinitionPath: main.definition.canonicalPath,
    childDefinitions,
    nativePorts: ports,
    loadMainDefinition: async () => main,
    loadChildDefinition: loadChild,
    startupTimeoutMs: 5_000,
    admissionTimeoutMs: 5_000,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    diagnostic: (event) => host.diagnostics.push(event),
  });
  controls.push(entry);
  await host.sessionStart();
  return { host, entry, main, ports, children, loadChild, childDefinitions, limits: options.limits };
}

interface ChildFixture {
  readonly host: Host;
  readonly entry: InstancedNativeEntryControls;
}

async function startChild(
  root: RootFixture,
  taskCallId: string,
  childId: string,
  options: {
    readonly currentModel?: InstancedModel;
    readonly activeTools?: readonly string[];
    readonly sessionId?: string;
    readonly cwd?: string;
    readonly parentId?: string | null;
    readonly depth?: number;
    readonly lifecycle?: boolean;
    readonly agentName?: string;
    readonly bus?: TestBus;
  } = {},
): Promise<ChildFixture> {
  if (options.lifecycle !== false) {
    root.host.lifecycle({
      status: "started",
      id: childId,
      parentToolCallId: taskCallId,
      index: 0,
      agent: options.agentName ?? "alpha",
    });
  }
  const host = new Host({
    agentKind: "sub",
    agentId: childId,
    ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
    parentId: options.parentId === undefined ? "Main" : options.parentId,
    depth: options.depth ?? 1,
    sessionId: options.sessionId ?? `session-${childId}`,
    cwd: options.cwd ?? WORKSPACE,
    currentModel: options.currentModel ?? CHILD_MODEL,
    activeTools: options.activeTools ?? ["read"],
    ...(options.bus === undefined ? {} : { bus: options.bus }),
  });
  const entry = createInstancedNativeEntry(host.pi, {
    mainDefinitionPath: root.main.definition.canonicalPath,
    childDefinitions: root.childDefinitions,
    nativePorts: root.ports,
    loadMainDefinition: async () => root.main,
    loadChildDefinition: root.loadChild,
    startupTimeoutMs: 5_000,
    admissionTimeoutMs: 5_000,
    ...(root.limits === undefined ? {} : { limits: root.limits }),
    diagnostic: (event) => host.diagnostics.push(event),
  });
  controls.push(entry);
  await host.sessionStart();
  return { host, entry };
}

async function admit(
  root: RootFixture,
  taskCallId: string,
  agent = "alpha",
  task = "fixture task text",
): Promise<void> {
  const result = await root.host.task(taskCallId, { agent, task, solutionSpace: "fixture", i: "intent" });
  if (isRecord(result) && result.block === true) {
    throw new Error(`admission was blocked: ${String(result.reason)}`);
  }
}

async function spawn(root: RootFixture, agent = "alpha"): Promise<unknown> {
  return await root.host.emit("before_subagent_spawn", {
    invocationKind: "task",
    agent,
    spawnKey: "fixture-call:0",
  });
}

function expectedRoleFrame(body: string): string {
  return `⁂ Role\n${body}\n⁂ Coop`;
}

function childPrompt(body: string): string[] {
  return [`${expectedRoleFrame(body)}\n⁂ Completion\nchild-rest`, "base-coop"];
}

function skillMessage(snapshot: DefinitionSnapshot): Record<string, unknown> {
  const skill = snapshot.skills[0]!;
  return {
    role: "custom",
    customType: "skill-prompt",
    display: false,
    attribution: "agent",
    details: { name: skill.name, path: skill.canonicalPath },
    content: `SKILL ${skill.name} ${skill.canonicalPath}\n${skill.body.trim()}`,
  };
}

function status(root: RootFixture): InstancedEntryStatus {
  return root.entry.getStatus();
}

async function inspectWork(root: RootFixture, toolCallId: string): Promise<Record<string, any>> {
  const result = await root.host.work(toolCallId, { action: "inspect" });
  expect(result.isError).not.toBe(true);
  return result.details as Record<string, any>;
}

function records(root: RootFixture): InstancedEntryStatus["instances"] {
  return root.entry.getStatus().instances;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not settle");
}

describe("opt-in native instance entry", () => {
  test("composition marks both companions defaultInactive and D1 activates them on the main root", async () => {
    const root = await startRoot();
    expect(root.host.flagRegistrations.map((flag) => flag.name)).toContain(AGENT_CHILD_DEFINITIONS_FLAG);
    expect(root.host.tools.get(AGENT_DEFINITION_TOOL)?.defaultInactive).toBe(true);
    expect(root.host.tools.get(NATIVE_WORK_TOOL)?.defaultInactive).toBe(true);
    expect(root.host.setActiveToolsCalls.at(-1)).toEqual(
      [...DEFINITION_BINDING_COMPANION_TOOLS, "read", "task"].sort(),
    );
    expect(status(root).phase).toBe("ready");
    expect(status(root).selections.map((selection) => selection.name)).toEqual(["alpha"]);
    expect(status(root).main.phase).toBe("bound");
    expect(root.entry.controller.phase).toBe("bound");
  });

  test("binds only the actual lifecycle child identity and keeps two instances on one version isolated", async () => {
    const root = await startRoot({
      children: [
        childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
          skills: [{ name: "alpha-skill", body: "ALPHA_SKILL_BODY" }],
        }),
      ],
    });
    root.host.lifecycle({ status: "started", id: "Ghost", parentToolCallId: "missing", index: 0, agent: "alpha" });
    expect(records(root)).toEqual([]);
    expect(status(root).lastRefusal?.code).toBe("lifecycle-unknown");

    await admit(root, "task-a");
    expect(records(root)).toHaveLength(1);
    expect(records(root)[0]!.childId).toBeNull();
    root.host.lifecycle({ status: "started", id: "ChildA", parentToolCallId: "task-a", index: 0, agent: "alpha" });
    root.host.lifecycle({ status: "started", id: "ChildA", parentToolCallId: "task-a", index: 0, agent: "alpha" });
    const childA = await startChild(root, "task-a", "ChildA", { lifecycle: false });
    expect(records(root)[0]!.childId).toBe("ChildA");
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.version).toBe("alpha-v1");

    await admit(root, "task-b");
    root.host.lifecycle({ status: "started", id: "ChildB", parentToolCallId: "task-b", index: 0, agent: "alpha" });
    const childB = await startChild(root, "task-b", "ChildB", { lifecycle: false });
    const bound = records(root);
    expect(bound).toHaveLength(2);
    expect(bound[0]!.childSessionId).toBe("session-ChildA");
    expect(bound[1]!.childSessionId).toBe("session-ChildB");
    expect(bound[0]!.version).toBe("alpha-v1");
    expect(bound[1]!.version).toBe("alpha-v1");

    const alpha = root.children[0]!;
    await childA.host.prompt(childPrompt(alpha.definition.body));
    await childA.host.emitContext([skillMessage(alpha)]);
    await childB.host.prompt(childPrompt(alpha.definition.body));
    expect(childA.host.aborts).toBe(0);
    expect(childB.host.aborts).toBe(0);
    expect(records(root)[0]!.roleGate).toBe("verified");
    expect(records(root)[0]!.skillGate).toBe("verified");
    expect(records(root)[1]!.roleGate).toBe("verified");

    // Context isolation: only B sees a tampered Skill message.
    await childB.host.emitContext([{ ...skillMessage(alpha), content: "TAMPERED" }]);
    expect(childB.host.aborts).toBe(1);
    expect(records(root)[1]!.phase).toBe("refused");
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.skillGate).toBe("verified");
  });

  test("a new source version is frozen only for new instances and does not mutate old text", async () => {
    const alphaV1 = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const alphaV2 = childSnapshot("alpha", "ALPHA_BODY_V2", "alpha-v2");
    let current = alphaV1;
    const root = await startRoot({
      children: [alphaV1],
      loadChild: async () => current,
    });
    await admit(root, "task-v1");
    root.host.lifecycle({ status: "started", id: "ChildV1", parentToolCallId: "task-v1", index: 0, agent: "alpha" });
    const childV1 = await startChild(root, "task-v1", "ChildV1", { lifecycle: false });
    await childV1.host.prompt(childPrompt("ALPHA_BODY_V1"));
    expect(childV1.host.aborts).toBe(0);

    current = alphaV2;
    await admit(root, "task-v2");
    root.host.lifecycle({ status: "started", id: "ChildV2", parentToolCallId: "task-v2", index: 0, agent: "alpha" });
    const childV2 = await startChild(root, "task-v2", "ChildV2", { lifecycle: false });
    await childV2.host.prompt(childPrompt("ALPHA_BODY_V2"));
    expect(childV2.host.aborts).toBe(0);

    const bound = records(root);
    expect(bound[0]!.version).toBe("alpha-v1");
    expect(bound[1]!.version).toBe("alpha-v2");
    // Old instance still verifies V1 and refuses V2; new load did not rewrite it.
    await childV1.host.prompt(childPrompt("ALPHA_BODY_V2"));
    expect(childV1.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[1]!.phase).toBe("bound");
  });

  test("refuses a native discovery winner that is not the explicit selected path", async () => {
    const alpha = childSnapshot("alpha", "ALPHA", "alpha-v1");
    const root = await startRoot({
      children: [alpha],
      discover: async () => [{
        name: "alpha",
        filePath: `${WORKSPACE}/.omp/agents/other.md`,
        source: "project",
      }],
    });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("exact explicit child path");
    expect(status(root).selections).toEqual([]);
    expect(status(root).main.phase).toBe("bound");
  });

  test("refuses a selected path discovered outside project/user sources", async () => {
    const alpha = childSnapshot("alpha", "ALPHA", "alpha-v1");
    const root = await startRoot({
      children: [alpha],
      discover: async () => [{ name: "alpha", filePath: alpha.definition.canonicalPath, source: "bundled" }],
    });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("project/user");
  });

  test("rejects unknown raw task fields, missing required values and unknown agents without admission", async () => {
    const root = await startRoot();
    for (const [index, input] of [
      { agent: "alpha", task: "ok", model: "fixture/other" },
      { agent: "alpha", task: "ok", resume: true },
      { agent: "alpha", task: "" },
      { agent: "unknown", task: "ok" },
      { task: "ok" },
      "not-an-object",
    ].entries()) {
      const result = await root.host.task(`bad-${index}`, input);
      expect(isRecord(result) && result.block).toBe(true);
      expect(records(root)).toHaveLength(0);
    }
    expect(status(root).phase).toBe("ready");
    await admit(root, "good");
    expect(records(root)).toHaveLength(1);
    const duplicate = await root.host.task("good", { agent: "alpha", task: "again" });
    expect(blockedReason(duplicate)).toContain("already used");
    expect(records(root)).toHaveLength(1);
    expect(JSON.stringify(status(root))).not.toContain("fixture task text");
    expect(JSON.stringify(status(root))).not.toContain("ALPHA_BODY_V1");
  });

  test("a conflicting started lifecycle refuses the admission without rewriting its identity", async () => {
    const root = await startRoot();
    await admit(root, "task-conflict");
    root.host.lifecycle({ status: "started", id: "FirstChild", parentToolCallId: "task-conflict", index: 0, agent: "alpha" });
    root.host.lifecycle({ status: "started", id: "SecondChild", parentToolCallId: "task-conflict", index: 0, agent: "alpha" });
    expect(records(root)[0]!.childId).toBe("FirstChild");
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("lifecycle-conflict");
    root.host.lifecycle({ status: "started", id: "SecondChild", parentToolCallId: "task-conflict", index: 0, agent: "alpha" });
    expect(records(root)[0]!.childId).toBe("FirstChild");
  });

  test("a child loader refusal fails startup closed with no selection authority", async () => {
    const root = await startRoot({
      loadChild: async () => {
        throw new Error("missing model dependency");
      },
    });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("missing model dependency");
    expect(status(root).selections).toEqual([]);
    expect(records(root)).toEqual([]);
    expect(status(root).main.phase).toBe("bound");
  });

  test("a malformed empty child selection fails startup closed", async () => {
    const root = await startRoot({ childDefinitions: [] });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("must select 1-");
    expect(status(root).selections).toEqual([]);
  });

  test("rejects scoped-settings drift and keeps the read-only status command available while D1 stays healthy", async () => {
    const root = await startRoot({
      ports: {
        readScopedSettings: () => ({
          ok: true,
          settings: { ...SUPPORTED_SETTINGS, taskBatch: true },
        }),
      },
    });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("task.batch");
    expect(status(root).main.phase).toBe("bound");
    const displayed = root.host.notifications.length;
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(await root.host.input(`/${AGENT_DEFINITION_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 2);
    const instanceStatus = JSON.parse(String(root.host.notifications.at(-2)));
    expect(instanceStatus.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(instanceStatus.phase).toBe("failed");
    expect(instanceStatus.main.phase).toBe("bound");
    expect(JSON.parse(String(root.host.notifications.at(-1))).phase).toBe("bound");
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const notified = root.host.notifications.at(-1);
    expect(notified).toBeDefined();
    const parsed = JSON.parse(String(notified));
    expect(parsed.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(parsed.phase).toBe("failed");
    expect(parsed.main.phase).toBe("bound");
  });

  test("refuses child model and exact-tool drift, then rejects reentry", async () => {
    const root = await startRoot();
    await admit(root, "task-model");
    root.host.lifecycle({ status: "started", id: "ModelChild", parentToolCallId: "task-model", index: 0, agent: "alpha" });
    const modelChild = await startChild(root, "task-model", "ModelChild", {
      lifecycle: false,
      currentModel: OTHER_MODEL,
    });
    expect(modelChild.host.aborts).toBe(1);
    expect(records(root)[0]!.refusalCode).toBe("child-model");
    await modelChild.host.sessionStart();
    expect(modelChild.host.aborts).toBe(2);
    expect(records(root)[0]!.phase).toBe("refused");
    await modelChild.host.emit("session_shutdown", {});
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.closedReason).toBe("child session shutdown");

    await admit(root, "task-tools");
    root.host.lifecycle({ status: "started", id: "ToolChild", parentToolCallId: "task-tools", index: 0, agent: "alpha" });
    const toolChild = await startChild(root, "task-tools", "ToolChild", {
      lifecycle: false,
      activeTools: ["read", NATIVE_WORK_TOOL],
    });
    expect(toolChild.host.aborts).toBe(1);
    expect(records(root)[1]!.refusalCode).toBe("child-tools");
  });

  test("keeps Role and Skill refusals sticky across the native four-attempt retry", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_ROLE", "alpha-v1", {
      skills: [{ name: "alpha-skill", body: "SKILL_BODY" }],
    });
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-sticky");
    root.host.lifecycle({ status: "started", id: "StickyChild", parentToolCallId: "task-sticky", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-sticky", "StickyChild", { lifecycle: false });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await child.host.prompt(childPrompt("TAMPERED_ROLE"));
    }
    expect(child.host.aborts).toBe(4);
    expect(records(root)[0]!.roleGate).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("role-frame-mismatch");
    // A later correct prompt cannot revive the refused instance.
    await child.host.prompt(childPrompt("ALPHA_ROLE"));
    expect(child.host.aborts).toBe(5);
    expect(records(root)[0]!.roleVerifications).toBe(0);

    await admit(root, "task-skill-sticky");
    root.host.lifecycle({ status: "started", id: "SkillChild", parentToolCallId: "task-skill-sticky", index: 0, agent: "alpha" });
    const skillChild = await startChild(root, "task-skill-sticky", "SkillChild", { lifecycle: false });
    await skillChild.host.prompt(childPrompt("ALPHA_ROLE"));
    await skillChild.host.emitContext([{ ...skillMessage(alpha), content: "TAMPERED_SKILL" }]);
    expect(skillChild.host.aborts).toBe(1);
    expect(records(root)[1]!.skillGate).toBe("refused");
    expect(records(root)[1]!.refusalCode).toBe("skill-content-mismatch");
    await skillChild.host.emitContext([skillMessage(alpha)]);
    expect(skillChild.host.aborts).toBe(2);
    expect(records(root)[1]!.skillVerifications).toBe(0);
  });

  test("a stale async load is not published after parent work ends", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    let release!: (snapshot: DefinitionSnapshot) => void;
    let started!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deferred = new Promise<DefinitionSnapshot>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const root = await startRoot({
      children: [alpha],
      loadChild: async () => {
        calls += 1;
        if (calls === 1) return alpha;
        started();
        return await deferred;
      },
    });
    const first = root.host.task("task-stale", { agent: "alpha", task: "stale task" });
    await loadStarted;
    await root.host.emit("agent_end", {});
    release(alpha);
    const firstResult = await first;
    expect(isRecord(firstResult) && firstResult.block).toBe(true);
    expect(status(root).instances).toEqual([]);
    expect(status(root).pending).toEqual([]);
  });

  test("root navigation refuses a late load and a second main root cannot steal authority", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    let release!: (snapshot: DefinitionSnapshot) => void;
    let started!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deferred = new Promise<DefinitionSnapshot>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const root = await startRoot({
      children: [alpha],
      loadChild: async () => {
        calls += 1;
        if (calls === 1) return alpha;
        started();
        return await deferred;
      },
    });
    const first = root.host.task("task-nav", { agent: "alpha", task: "nav task" });
    await loadStarted;
    await root.host.emit("session_switch", {});
    release(alpha);
    const firstResult = await first;
    expect(isRecord(firstResult) && firstResult.block).toBe(true);
    expect(status(root).phase).toBe("closed");
    expect(status(root).instances).toEqual([]);
    root.host.lifecycle({ status: "started", id: "LateChild", parentToolCallId: "task-nav", index: 0, agent: "alpha" });
    expect(status(root).instances).toEqual([]);

    // A second main root cannot steal or reset the closed first root.
    const secondHost = new Host({ activeTools: ["read", "task"] });
    const secondEntry = createInstancedNativeEntry(secondHost.pi, {
      mainDefinitionPath: root.main.definition.canonicalPath,
      childDefinitions: root.childDefinitions,
      nativePorts: root.ports,
      loadMainDefinition: async () => root.main,
      loadChildDefinition: root.loadChild,
      startupTimeoutMs: 1_000,
    });
    controls.push(secondEntry);
    await secondHost.sessionStart();
    expect(secondEntry.getStatus().factory.ownsRoot).toBe(false);
    expect(secondEntry.getStatus().factory.refusedReason).toContain("replacement main root");
    expect(status(root).phase).toBe("closed");
  });

  test("enforces the record cap without evicting a live binding", async () => {
    const alpha = childSnapshot("alpha", "ALPHA", "alpha-v1");
    const beta = childSnapshot("beta", "BETA", "beta-v1");
    const root = await startRoot({
      children: [alpha, beta],
      limits: { maxRecords: 1, maxPending: 1, maxRetainedTextBytes: 1024 },
    });
    await admit(root, "task-one", "alpha");
    const second = await root.host.task("task-two", { agent: "beta", task: "beta task" });
    expect(blockedReason(second)).toContain("capacity");
    expect(records(root)).toHaveLength(1);
    expect(records(root)[0]!.childId).toBeNull();
  });

  test("enforces the retained-text cap", async () => {
    const root = await startRoot({
      children: [childSnapshot("alpha", "ALPHA_BODY_TOO_LARGE", "alpha-v1")],
      limits: { maxRetainedTextBytes: 4 },
    });
    const blocked = await root.host.task("task-text", { agent: "alpha", task: "text task" });
    expect(blockedReason(blocked)).toContain("retained initial-text capacity");
    expect(records(root)).toHaveLength(0);
  });

  test("enforces the pending-admission cap", async () => {
    const alpha = childSnapshot("alpha", "ALPHA", "alpha-v1");
    let release!: (snapshot: DefinitionSnapshot) => void;
    let started!: () => void;
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deferred = new Promise<DefinitionSnapshot>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const root = await startRoot({
      children: [alpha],
      limits: { maxPending: 1, maxRecords: 4, maxRetainedTextBytes: 1024 },
      loadChild: async () => {
        calls += 1;
        if (calls === 1) return alpha;
        started();
        return await deferred;
      },
    });
    const pending = root.host.task("task-pending", { agent: "alpha", task: "pending task" });
    await loadStarted;
    const second = await root.host.task("task-second", { agent: "alpha", task: "second task" });
    expect(blockedReason(second)).toContain("pending-admission capacity");
    release(alpha);
    const pendingResult = await pending;
    expect(isRecord(pendingResult) && pendingResult.block).toBe(false);
    expect(records(root)).toHaveLength(1);
  });

  test("enforces the selected-definition cap", async () => {
    const root = await startRoot({
      children: [
        childSnapshot("alpha", "ALPHA", "alpha-v1"),
        childSnapshot("beta", "BETA", "beta-v1"),
      ],
      limits: { maxDefinitions: 1 },
    });
    expect(status(root).phase).toBe("failed");
    expect(status(root).failure).toContain("must select");
  });

  test("a terminal lifecycle must match the child plus available parent call/index identity", async () => {
    const root = await startRoot();
    await admit(root, "task-term");
    root.host.lifecycle({ status: "started", id: "TermChild", parentToolCallId: "task-term", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-term", "TermChild", { lifecycle: false });
    void child;
    root.host.lifecycle({ status: "completed", id: "UnknownChild", parentToolCallId: "task-term", index: 0, agent: "alpha" });
    expect(records(root)[0]!.lifecycle).toBe("started");
    expect(records(root)[0]!.phase).toBe("bound");
    root.host.lifecycle({ status: "completed", id: "TermChild", parentToolCallId: "other-call", index: 0, agent: "alpha" });
    expect(records(root)[0]!.lifecycle).toBe("started");
    expect(records(root)[0]!.lifecycleTerminal).toBe(false);
    root.host.lifecycle({ status: "completed", id: "TermChild", parentToolCallId: "task-term", index: 1, agent: "alpha" });
    expect(records(root)[0]!.lifecycle).toBe("started");
    root.host.lifecycle({ status: "completed", id: "TermChild", parentToolCallId: "task-term", index: 0, agent: "alpha" });
    expect(records(root)[0]!.lifecycle).toBe("completed");
    expect(records(root)[0]!.lifecycleTerminal).toBe(true);
    expect(records(root)[0]!.phase).toBe("closed");
  });

  test("later child model or tool drift is refused after binding", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-late-drift");
    root.host.lifecycle({ status: "started", id: "DriftChild", parentToolCallId: "task-late-drift", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-late-drift", "DriftChild", { lifecycle: false });
    await child.host.prompt(childPrompt(alpha.definition.body));
    expect(child.host.aborts).toBe(0);
    child.host.activeTools = ["read", NATIVE_WORK_TOOL];
    await child.host.prompt(childPrompt(alpha.definition.body));
    expect(child.host.aborts).toBe(1);
    expect(records(root)[0]!.refusalCode).toBe("child-tools");
    expect(records(root)[0]!.phase).toBe("refused");
  });

  test("status is fresh, frozen, body-free and cleanup closes late events", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_SECRET_BODY", "alpha-v1", {
      skills: [{ name: "secret-skill", body: "SKILL_SECRET_BODY" }],
    });
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-status", "alpha", "TASK_SECRET_TEXT");
    root.host.lifecycle({ status: "started", id: "StatusChild", parentToolCallId: "task-status", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-status", "StatusChild", { lifecycle: false });
    await child.host.prompt(childPrompt(alpha.definition.body));
    await child.host.emitContext([skillMessage(alpha)]);
    const before = status(root);
    const serialized = JSON.stringify(before);
    expect(serialized).not.toContain("ALPHA_SECRET_BODY");
    expect(serialized).not.toContain("SKILL_SECRET_BODY");
    expect(serialized).not.toContain("TASK_SECRET_TEXT");
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.instances)).toBe(true);
    try {
      (before.instances[0] as { phase: string }).phase = "tampered";
    } catch {
      // Frozen in strict mode.
    }
    expect(status(root).instances[0]!.phase).toBe("bound");

    root.host.lifecycle({ status: "completed", id: "StatusChild", parentToolCallId: "task-status", index: 0, agent: "alpha" });
    expect(status(root).instances[0]!.lifecycle).toBe("completed");
    expect(status(root).instances[0]!.lifecycleTerminal).toBe(true);
    await child.host.emit("tool_result", {
      toolCallId: "child-tool",
      toolName: "read",
      content: "ignored",
      isError: false,
    });
    await child.host.emit("session_shutdown", {});
    expect(status(root).instances[0]!.phase).toBe("closed");
    await child.host.sessionStart();
    expect(child.host.aborts).toBeGreaterThan(0);
    expect(status(root).instances[0]!.childSessionId).toBe("session-StatusChild");
    expect(status(root).instances[0]!.childId).toBe("StatusChild");
  });

  test("later child gates require the frozen UUID, cwd, parent, depth and name", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const drifts: {
      readonly label: string;
      readonly apply: (host: Host) => void;
    }[] = [
      { label: "session UUID", apply: (host) => { host.sessionId = "session-drifted"; } },
      { label: "cwd", apply: (host) => { host.cwd = "/workspace-drifted"; } },
      { label: "parent id", apply: (host) => { host.parentId = "OtherParent"; } },
      { label: "depth", apply: (host) => { host.depth = 2; } },
      { label: "agent name", apply: (host) => { host.name = "beta"; } },
    ];
    for (const [index, drift] of drifts.entries()) {
      const root = await startRoot({ children: [alpha] });
      const call = `task-drift-${index}`;
      const childId = `DriftChild${index}`;
      await admit(root, call);
      root.host.lifecycle({ status: "started", id: childId, parentToolCallId: call, index: 0, agent: "alpha" });
      const child = await startChild(root, call, childId, { lifecycle: false });
      expect(records(root)[0]!.phase).toBe("bound");
      expect(child.host.aborts).toBe(0);
      const original = {
        sessionId: child.host.sessionId,
        cwd: child.host.cwd,
        parentId: child.host.parentId,
        depth: child.host.depth,
        name: child.host.name,
      };
      const before = child.host.aborts;
      drift.apply(child.host);
      const input = await child.host.input(`drifted ${drift.label}`);
      expect(isRecord(input) && input.handled).toBe(true);
      expect(child.host.aborts).toBe(before + 1);
      expect(records(root)[0]!.phase).toBe("refused");
      expect(records(root)[0]!.refusalCode).toBe("child-identity");
      // The drifted context cannot close the tombstone through shutdown.
      await child.host.emit("session_shutdown", {});
      expect(records(root)[0]!.closedReason).toBeNull();
      // The original frozen child facts still close the refused record.
      Object.assign(child.host, original);
      await child.host.emit("session_shutdown", {});
      expect(records(root)[0]!.phase).toBe("refused");
      expect(records(root)[0]!.closedReason).toBe("child session shutdown");
      root.entry.dispose();
    }
  });

  test("every later child gate rejects a drifted child identity", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1", {
      skills: [{ name: "alpha-skill", body: "ALPHA_SKILL_BODY" }],
    });
    const gates: {
      readonly name: string;
      readonly run: (host: Host) => Promise<void>;
    }[] = [
      {
        name: "input",
        async run(host) {
          const result = await host.input("drifted input");
          expect(isRecord(result) && result.handled).toBe(true);
        },
      },
      {
        name: "before_agent_start",
        async run(host) {
          await host.prompt(childPrompt(alpha.definition.body));
        },
      },
      {
        name: "context",
        async run(host) {
          await host.emitContext([skillMessage(alpha)]);
        },
      },
      {
        name: "tool_call",
        async run(host) {
          const result = await host.emit("tool_call", { toolName: "read", toolCallId: "drifted-tool" });
          expect(blockedReason(result)).toContain("refused");
        },
      },
    ];
    for (const [index, gate] of gates.entries()) {
      const root = await startRoot({ children: [alpha] });
      const call = `task-gate-${index}`;
      const childId = `GateChild${index}`;
      await admit(root, call);
      root.host.lifecycle({ status: "started", id: childId, parentToolCallId: call, index: 0, agent: "alpha" });
      const child = await startChild(root, call, childId, { lifecycle: false });
      expect(records(root)[0]!.phase).toBe("bound");
      expect(child.host.aborts).toBe(0);
      child.host.sessionId = `session-drifted-${gate.name}`;
      await gate.run(child.host);
      expect(records(root)[0]!.phase).toBe("refused");
      expect(records(root)[0]!.refusalCode).toBe("child-identity");
      if (gate.name !== "tool_call") expect(child.host.aborts).toBe(1);
      // The original context can no longer revive the refused binding.
      child.host.sessionId = `session-${childId}`;
      await child.host.prompt(childPrompt(alpha.definition.body));
      expect(child.host.aborts).toBe(gate.name === "tool_call" ? 1 : 2);
      root.entry.dispose();
    }
  });

  test("child navigation with the host's new UUID refuses the owning record and cannot revive", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-nav-drift");
    root.host.lifecycle({ status: "started", id: "NavDriftChild", parentToolCallId: "task-nav-drift", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-nav-drift", "NavDriftChild", { lifecycle: false });
    expect(records(root)[0]!.phase).toBe("bound");
    const frozenSession = child.host.sessionId;
    // Fixed host emits session_switch after changing the session UUID.
    child.host.sessionId = "session-navigated";
    await child.host.emit("session_switch", {});
    expect(child.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("child-identity");
    // Switching back cannot revive the refused instance.
    child.host.sessionId = frozenSession;
    await child.host.prompt(childPrompt(alpha.definition.body));
    expect(child.host.aborts).toBe(2);
    expect(records(root)[0]!.phase).toBe("refused");
  });

  test("binds only the actual agent name and lets the original child shutdown close a refusal", async () => {
    const root = await startRoot();
    await admit(root, "task-name");
    root.host.lifecycle({ status: "started", id: "NameChild", parentToolCallId: "task-name", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-name", "NameChild", { lifecycle: false, agentName: "beta" });
    expect(child.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("child-name");
    await child.host.emit("session_shutdown", {});
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.closedReason).toBe("child session shutdown");
  });

  test("a conflicting lifecycle session file refuses a duplicate without rewriting child identity", async () => {
    const root = await startRoot();
    await admit(root, "task-session-file");
    root.host.lifecycle({
      status: "started",
      id: "FileChild",
      parentToolCallId: "task-session-file",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/file-a.jsonl",
    });
    root.host.lifecycle({
      status: "completed",
      id: "FileChild",
      parentToolCallId: "task-session-file",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/file-b.jsonl",
    });
    expect(records(root)[0]!.lifecycle).toBe("started");
    expect(records(root)[0]!.lifecycleTerminal).toBe(false);
    expect(status(root).lastRefusal?.code).toBe("lifecycle-terminal-conflict");
    root.host.lifecycle({
      status: "started",
      id: "FileChild",
      parentToolCallId: "task-session-file",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/file-a.jsonl",
    });
    expect(records(root)[0]!.phase).toBe("admitted");
    expect(records(root)[0]!.childId).toBe("FileChild");
    expect(records(root)[0]!.refusalCode).toBeNull();
    root.host.lifecycle({
      status: "started",
      id: "FileChild",
      parentToolCallId: "task-session-file",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/file-b.jsonl",
    });
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("lifecycle-conflict");
    expect(records(root)[0]!.childId).toBe("FileChild");
    const child = await startChild(root, "task-session-file", "FileChild", { lifecycle: false });
    expect(child.host.aborts).toBe(1);
    expect(records(root)[0]!.childSessionId).toBeNull();
  });

  test("a different factory with an identical child id cannot borrow or close the bound record", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-foreign", "alpha", "foreign task");
    root.host.lifecycle({ status: "started", id: "ForeignChild", parentToolCallId: "task-foreign", index: 0, agent: "alpha" });
    const original = await startChild(root, "task-foreign", "ForeignChild", { lifecycle: false });
    expect(records(root)[0]!.phase).toBe("bound");

    // This factory sees the same child id and context, but it did not freeze
    // the binding. It may not bind, gate, navigate or close the record.
    const foreign = await startChild(root, "task-foreign", "ForeignChild");
    expect(foreign.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.closedReason).toBeNull();

    const foreignInput = await foreign.host.input("foreign input");
    expect(isRecord(foreignInput) && foreignInput.handled).toBe(true);
    expect(foreign.host.aborts).toBe(2);
    expect(records(root)[0]!.phase).toBe("bound");
    await foreign.host.prompt(childPrompt(alpha.definition.body));
    expect(foreign.host.aborts).toBe(3);
    const foreignTool = await foreign.host.emit("tool_call", { toolName: "read", toolCallId: "foreign-tool" });
    expect(blockedReason(foreignTool)).toContain("refused");
    await foreign.host.emit("session_switch", {});
    await foreign.host.emit("session_shutdown", {});
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.closedReason).toBeNull();

    // The original factory and exact child facts still pass the later gates.
    await original.host.prompt(childPrompt(alpha.definition.body));
    expect(original.host.aborts).toBe(0);
    expect(records(root)[0]!.roleGate).toBe("verified");
  });

  test("disposed root A events and child hooks cannot attach to or close fresh root B", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const rootA = await startRoot({ children: [alpha] });
    await admit(rootA, "task-reused");
    rootA.host.lifecycle({
      status: "started",
      id: "ReusedChild",
      parentToolCallId: "task-reused",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/a.jsonl",
    });
    const childA = await startChild(rootA, "task-reused", "ReusedChild", { lifecycle: false });
    expect(records(rootA)[0]!.phase).toBe("bound");
    rootA.entry.dispose();

    const rootB = await startRoot({ children: [alpha] });
    expect(status(rootB).phase).toBe("ready");
    expect(status(rootB).root?.epoch).toBe(0);
    await admit(rootB, "task-reused");
    rootB.host.lifecycle({
      status: "started",
      id: "ReusedChild",
      parentToolCallId: "task-reused",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/b.jsonl",
    });
    const childB = await startChild(rootB, "task-reused", "ReusedChild", { lifecycle: false });
    expect(records(rootB)[0]!.phase).toBe("bound");
    expect(records(rootB)[0]!.childSessionId).toBe("session-ReusedChild");

    // Old bus events are ignored: root A's factory is disposed and its bus is
    // retired, even though root B reused the call and child ids.
    rootA.host.lifecycle({
      status: "started",
      id: "ReusedChild",
      parentToolCallId: "task-reused",
      index: 0,
      agent: "alpha",
      sessionFile: "/sessions/a.jsonl",
    });
    rootA.host.lifecycle({ status: "completed", id: "ReusedChild", parentToolCallId: "task-reused", index: 0, agent: "alpha" });
    expect(records(rootB)[0]!.lifecycle).toBe("started");
    expect(records(rootB)[0]!.lifecycleTerminal).toBe(false);

    // Old child hooks cannot borrow or close root B's reused child id.
    const beforeAborts = childA.host.aborts;
    const oldInput = await childA.host.input("old child input");
    expect(isRecord(oldInput) && oldInput.handled).toBe(true);
    expect(childA.host.aborts).toBe(beforeAborts + 1);
    await childA.host.emit("session_switch", {});
    await childA.host.emit("session_shutdown", {});
    expect(records(rootB)[0]!.phase).toBe("bound");
    expect(records(rootB)[0]!.closedReason).toBeNull();

    // The matching new child factory still closes its own record.
    await childB.host.emit("session_shutdown", {});
    expect(records(rootB)[0]!.phase).toBe("closed");
  });

  test("an unbound child factory created under root A cannot adopt fresh root B", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const rootA = await startRoot({ children: [alpha] });
    // No admission yet: this factory is created under A but never freezes.
    const orphan = await startChild(rootA, "task-orphan-a", "OrphanChild", { lifecycle: false });
    expect(orphan.host.aborts).toBe(1);
    rootA.entry.dispose();

    const rootB = await startRoot({ children: [alpha] });
    await admit(rootB, "task-orphan-b");
    rootB.host.lifecycle({ status: "started", id: "OrphanChild", parentToolCallId: "task-orphan-b", index: 0, agent: "alpha" });
    await orphan.host.sessionStart();
    expect(orphan.host.aborts).toBe(2);
    expect(records(rootB)[0]!.phase).toBe("admitted");
    expect(records(rootB)[0]!.childSessionId).toBeNull();
    expect(records(rootB)[0]!.childId).toBe("OrphanChild");
  });

  test("refuses a replacement root on a bus used by a disposed root", async () => {
    const root = await startRoot();
    root.entry.dispose();
    const replacement = createInstancedNativeEntry(root.host.pi, {
      mainDefinitionPath: root.main.definition.canonicalPath,
      childDefinitions: root.childDefinitions,
      nativePorts: root.ports,
      loadMainDefinition: async () => root.main,
      loadChildDefinition: root.loadChild,
      startupTimeoutMs: 1_000,
      diagnostic: (event) => root.host.diagnostics.push(event),
    });
    controls.push(replacement);
    await root.host.sessionStart();
    const replacementStatus = replacement.getStatus();
    expect(replacementStatus.factory.ownsRoot).toBe(false);
    expect(replacementStatus.factory.refusedReason).toContain("fresh bus/process");
    expect(replacementStatus.phase).toBe("unselected");
    expect(root.host.diagnostics.some((event) => event.type === "root-bus-retired")).toBe(true);
  });

  test("keeps a child factory working on the shared parent bus", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-shared-bus");
    root.host.lifecycle({ status: "started", id: "SharedBusChild", parentToolCallId: "task-shared-bus", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-shared-bus", "SharedBusChild", {
      lifecycle: false,
      bus: root.host.bus,
    });
    expect(records(root)[0]!.phase).toBe("bound");
    await child.host.prompt(childPrompt(alpha.definition.body));
    expect(child.host.aborts).toBe(0);
    expect(records(root)[0]!.roleGate).toBe("verified");
    await child.host.emit("session_shutdown", {});
    expect(records(root)[0]!.phase).toBe("closed");
  });

  test("one child factory cannot bind a second native child record", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-first-child");
    root.host.lifecycle({ status: "started", id: "FirstChild", parentToolCallId: "task-first-child", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-first-child", "FirstChild", { lifecycle: false });
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.childSessionId).toBe("session-FirstChild");

    await admit(root, "task-second-child");
    root.host.lifecycle({ status: "started", id: "SecondChild", parentToolCallId: "task-second-child", index: 0, agent: "alpha" });
    // Reuse the same factory with a different native child session.
    child.host.agentId = "SecondChild";
    child.host.sessionId = "session-SecondChild";
    await child.host.sessionStart();
    expect(child.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("bound");
    expect(records(root)[0]!.childSessionId).toBe("session-FirstChild");
    expect(records(root)[1]!.phase).toBe("admitted");
    expect(records(root)[1]!.childId).toBe("SecondChild");
    expect(records(root)[1]!.childSessionId).toBeNull();
  });

  test("a terminal factory refusal cannot later bind a child", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await admit(root, "task-refused-factory");
    root.host.lifecycle({ status: "started", id: "RefusedFactoryChild", parentToolCallId: "task-refused-factory", index: 0, agent: "alpha" });
    const host = new Host({
      agentKind: "unknown",
      agentId: "RefusedFactoryChild",
      sessionId: "session-RefusedFactoryChild",
      currentModel: CHILD_MODEL,
      activeTools: ["read"],
    });
    const entry = createInstancedNativeEntry(host.pi, {
      mainDefinitionPath: root.main.definition.canonicalPath,
      childDefinitions: root.childDefinitions,
      nativePorts: root.ports,
      loadMainDefinition: async () => root.main,
      loadChildDefinition: root.loadChild,
      startupTimeoutMs: 5_000,
      admissionTimeoutMs: 5_000,
    });
    controls.push(entry);
    await host.sessionStart();
    expect(host.aborts).toBe(1);
    expect(entry.getStatus().factory.refusedReason).toContain("Unknown agent identity");

    host.agentKind = "sub";
    await host.sessionStart();
    expect(host.aborts).toBe(2);
    expect(records(root)[0]!.phase).toBe("admitted");
    expect(records(root)[0]!.childId).toBe("RefusedFactoryChild");
    expect(records(root)[0]!.childSessionId).toBeNull();
  });

  test("parent work ending invalidates a published admission before child session start", async () => {
    const root = await startRoot();
    await admit(root, "task-work-end");
    expect(records(root)[0]!.phase).toBe("admitted");
    expect(blockedReason(await spawn(root, "alpha"))).toBe("");
    await root.host.emit("agent_end", {});
    expect(status(root).root?.workEpoch).toBe(1);
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("work-ended");
    expect(blockedReason(await spawn(root, "alpha"))).toContain("no admitted task call");

    root.host.lifecycle({ status: "started", id: "StaleWorkChild", parentToolCallId: "task-work-end", index: 0, agent: "alpha" });
    expect(records(root)[0]!.childId).toBeNull();
    const staleChild = await startChild(root, "task-work-end", "StaleWorkChild", { lifecycle: false });
    expect(staleChild.host.aborts).toBe(1);
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.childSessionId).toBeNull();

    await admit(root, "task-after-work");
    expect(records(root)[1]!.phase).toBe("admitted");
    root.host.lifecycle({ status: "started", id: "FreshWorkChild", parentToolCallId: "task-after-work", index: 0, agent: "alpha" });
    const freshChild = await startChild(root, "task-after-work", "FreshWorkChild", { lifecycle: false });
    expect(freshChild.host.aborts).toBe(0);
    expect(records(root)[1]!.phase).toBe("bound");
  });

  test("parent work ending invalidates a started lifecycle that never bound the child", async () => {
    const root = await startRoot();
    await admit(root, "task-started-unbound");
    root.host.lifecycle({ status: "started", id: "StartedUnboundChild", parentToolCallId: "task-started-unbound", index: 0, agent: "alpha" });
    expect(records(root)[0]!.childId).toBe("StartedUnboundChild");
    expect(records(root)[0]!.phase).toBe("admitted");
    await root.host.emit("session_stop", {});
    expect(records(root)[0]!.phase).toBe("refused");
    expect(records(root)[0]!.refusalCode).toBe("work-ended");
    expect(records(root)[0]!.childId).toBe("StartedUnboundChild");

    const staleChild = await startChild(root, "task-started-unbound", "StartedUnboundChild", { lifecycle: false });
    expect(staleChild.host.aborts).toBe(1);
    expect(records(root)[0]!.childSessionId).toBeNull();
    expect(records(root)[0]!.phase).toBe("refused");

    await admit(root, "task-new-work");
    root.host.lifecycle({ status: "started", id: "NewWorkChild", parentToolCallId: "task-new-work", index: 0, agent: "alpha" });
    const freshChild = await startChild(root, "task-new-work", "NewWorkChild", { lifecycle: false });
    expect(freshChild.host.aborts).toBe(0);
    expect(records(root)[1]!.phase).toBe("bound");
  });

  test("maxRecords=1 allows the first admitted spawn, start and bind but refuses the second admission", async () => {
    const alpha = childSnapshot("alpha", "ALPHA", "alpha-v1");
    const beta = childSnapshot("beta", "BETA", "beta-v1");
    const root = await startRoot({
      children: [alpha, beta],
      limits: { maxRecords: 1, maxPending: 1 },
    });
    await admit(root, "task-first", "alpha");
    expect(blockedReason(await spawn(root, "alpha"))).toBe("");
    root.host.lifecycle({ status: "started", id: "FirstChild", parentToolCallId: "task-first", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-first", "FirstChild", { lifecycle: false });
    expect(child.host.aborts).toBe(0);
    expect(records(root)[0]!.phase).toBe("bound");
    const second = await root.host.task("task-second", { agent: "beta", task: "second task" });
    expect(blockedReason(second)).toContain("capacity");
    expect(records(root)).toHaveLength(1);
    expect(records(root)[0]!.childId).toBe("FirstChild");
  });

  test("allows D1 and instance status input after the instance root closes", async () => {
    const root = await startRoot();
    expect(status(root).phase).toBe("ready");
    expect(status(root).main.phase).toBe("bound");
    await root.host.emit("session_shutdown", {});
    expect(status(root).phase).toBe("closed");
    // D1's own input gate still diagnoses its closed binding locally, and it
    // still authorizes the instance status token first. A closed D1 gate means
    // the instance status is not displayed by the local slot.
    expect(await root.host.input(`/${AGENT_DEFINITION_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(JSON.parse(String(root.host.notifications.at(-1))).phase).toBe("disposed");
    const beforeInstance = root.host.notifications.length;
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(beforeInstance + 1);
    expect(root.host.notifications.at(-1)).not.toContain(INSTANCED_NATIVE_ENTRY_SCHEMA);
    // The instance status command remains directly registered and observable.
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const notified = JSON.parse(String(root.host.notifications.at(-1)));
    expect(notified.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(notified.phase).toBe("closed");
  });

  test("a disposed instance entry still reports its read-only status directly", async () => {
    const root = await startRoot();
    expect(status(root).phase).toBe("ready");
    root.entry.dispose();
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const shown = JSON.parse(String(root.host.notifications.at(-1)));
    expect(shown.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(shown.phase).toBe("closed");
    expect(shown.factory.disposed).toBe(true);
  });

  test("local instance and D1 status input preserve active and ended work state", async () => {
    const root = await startRoot();
    expect(status(root).phase).toBe("ready");
    expect(status(root).main.phase).toBe("bound");
    await root.host.input("instance status work");
    await root.host.prepare("instance status work");
    await root.host.observe("instance-status-read", "read", "observed");
    const before = await inspectWork(root, "inspect-instance-status-before");
    expect(before.current.status).toBe("active");
    expect(before.pendingInputs.count).toBe(0);

    const displayed = root.host.notifications.length;
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(await root.host.input(`/${AGENT_DEFINITION_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 2);
    const instanceStatus = JSON.parse(String(root.host.notifications.at(-2)));
    expect(instanceStatus.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(instanceStatus.phase).toBe("ready");
    expect(instanceStatus.main.phase).toBe("bound");
    expect(JSON.parse(String(root.host.notifications.at(-1))).phase).toBe("bound");

    const after = await inspectWork(root, "inspect-instance-status-after");
    expect(after.current.observationId).toBe(before.current.observationId);
    expect(after.current.generation).toBe(before.current.generation);
    expect(after.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL))
      .toEqual(before.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL));
    expect(after.current.reminder).toEqual(before.current.reminder);
    expect(after.pendingInputs.count).toBe(0);

    await root.host.emit("agent_end", { willContinue: false });
    const endedBefore = await inspectWork(root, "inspect-instance-status-ended-before");
    expect(endedBefore.current.status).toBe("ended");
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 3);
    const endedAfter = await inspectWork(root, "inspect-instance-status-ended-after");
    expect(endedAfter.current.status).toBe("ended");
    expect(endedAfter.current.observationId).toBe(endedBefore.current.observationId);
    expect(endedAfter.current.generation).toBe(endedBefore.current.generation);
    expect(endedAfter.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL))
      .toEqual(endedBefore.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL));
    expect(endedAfter.current.reminder).toEqual(endedBefore.current.reminder);
    expect(endedAfter.pendingInputs.count).toBe(0);
  });

  test("local instance status input neither clears nor manufactures pending ingress", async () => {
    const root = await startRoot();
    await root.host.input("pending instance ingress");
    const before = await inspectWork(root, "inspect-instance-pending-before");
    expect(before.current).toBeNull();
    expect(before.pendingInputs.count).toBe(1);
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    const afterStatus = await inspectWork(root, "inspect-instance-pending-after-status");
    expect(afterStatus.current).toBeNull();
    expect(afterStatus.pendingInputs.count).toBe(1);

    await root.host.prepare("pending instance ingress");
    const prepared = await inspectWork(root, "inspect-instance-pending-prepared");
    expect(prepared.current.request.attribution).toBe("matched-user-input");
    expect(prepared.current.request.excerpt).toBe("pending instance ingress");
    expect(prepared.pendingInputs.count).toBe(0);
  });

  test("repeated identical pending ingress keeps its ambiguity across a local status input", async () => {
    const root = await startRoot();
    await root.host.input("ambiguous instance ingress");
    await root.host.input("ambiguous instance ingress");
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    await root.host.prepare("ambiguous instance ingress");
    const ambiguous = await inspectWork(root, "inspect-instance-ambiguous");
    expect(ambiguous.current.request.attribution).toBe("unknown");
    expect(ambiguous.current.evidence.unavailableReason).toContain("ambiguous");
    expect(ambiguous.pendingInputs.count).toBe(0);
  });

  test("local instance status input preserves the issued one-shot advisory", async () => {
    const root = await startRoot();
    await root.host.input("instance advisory work");
    await root.host.prepare("instance advisory work");
    await root.host.observe("instance-advisory-read", "read", "observed");
    const before = await inspectWork(root, "inspect-instance-advisory-before");
    const reminder = await root.host.stop();
    expect(reminder?.continue).toBe(true);
    const reminderText = String(reminder?.additionalContext);
    expect(reminderText).toContain("one-time advisory");

    const displayed = root.host.notifications.length;
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(await root.host.input(`/${AGENT_DEFINITION_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 2);

    await root.host.prepare(reminderText);
    const after = await inspectWork(root, "inspect-instance-advisory-after");
    expect(after.current.observationId).toBe(before.current.observationId);
    expect(after.current.generation).toBe(before.current.generation);
    expect(after.current.request.attribution).toBe("matched-user-input");
    expect(after.current.reminder.used).toBe(true);
    expect(after.pendingInputs.count).toBe(0);
    expect((await root.host.stop())?.continue).not.toBe(true);
  });

  test("throwing status displays during early input are consumed without failing the root or work state", async () => {
    const root = await startRoot();
    expect(status(root).phase).toBe("ready");
    expect(status(root).main.phase).toBe("bound");

    await root.host.input("notify throw work");
    await root.host.prepare("notify throw work");
    await root.host.observe("notify-throw-read", "read", "observed");
    const reminder = await root.host.stop();
    expect(reminder?.continue).toBe(true);
    await root.host.input("pending notify throw input");

    const before = await inspectWork(root, "inspect-notify-throw-before");
    expect(before.current.status).toBe("active");
    expect(before.current.request.excerpt).toBe("notify throw work");
    expect(before.current.reminder.used).toBe(true);
    expect(before.pendingInputs.count).toBe(1);

    let laterInputRuns = 0;
    root.host.handlers.get("input")!.push(() => {
      laterInputRuns += 1;
      return undefined;
    });
    const displayed = root.host.notifications.length;
    const ui = root.host.context.ui as { notify?: () => void };
    const notify = ui.notify;
    if (notify === undefined) throw new Error("expected a UI notifier");
    let displayCalls = 0;
    ui.notify = () => {
      displayCalls += 1;
      throw new Error("synthetic status display failure");
    };
    try {
      for (const command of [AGENT_DEFINITION_STATUS_COMMAND, AGENT_INSTANCES_STATUS_COMMAND]) {
        expect(await root.host.input(`/${command}`)).toEqual({ handled: true });
      }
    } finally {
      ui.notify = notify;
    }
    expect(displayCalls).toBe(2);
    expect(laterInputRuns).toBe(0);
    expect(root.host.notifications).toHaveLength(displayed);
    expect(status(root).phase).toBe("ready");
    expect(status(root).main.phase).toBe("bound");

    const after = await inspectWork(root, "inspect-notify-throw-after");
    expect(after.current.observationId).toBe(before.current.observationId);
    expect(after.current.generation).toBe(before.current.generation);
    expect(after.current.request).toEqual(before.current.request);
    expect(after.current.reminder).toEqual(before.current.reminder);
    expect(after.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL))
      .toEqual(before.current.calls.filter((call: any) => call.toolName !== NATIVE_WORK_TOOL));
    expect(after.pendingInputs.count).toBe(1);
    expect((await root.host.stop())?.continue).not.toBe(true);

    await root.host.emit("agent_end", { willContinue: false });
    await root.host.prepare("pending notify throw input");
    const pendingPrepared = await inspectWork(root, "inspect-notify-throw-pending");
    expect(pendingPrepared.current.request.attribution).toBe("matched-user-input");
    expect(pendingPrepared.current.request.excerpt).toBe("pending notify throw input");
    expect(pendingPrepared.pendingInputs.count).toBe(0);
  });

  test("instance status is displayed for a failed instance root but not past a failed D1 gate", async () => {
    const failedInstance = await startRoot({ childDefinitions: [] });
    expect(status(failedInstance).phase).toBe("failed");
    expect(status(failedInstance).main.phase).toBe("bound");
    const displayed = failedInstance.host.notifications.length;
    expect(await failedInstance.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(failedInstance.host.notifications).toHaveLength(displayed + 1);
    const shown = JSON.parse(String(failedInstance.host.notifications.at(-1)));
    expect(shown.schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(shown.phase).toBe("failed");
    expect(shown.main.phase).toBe("bound");
    failedInstance.entry.dispose();

    const failedD1 = await startRoot();
    failedD1.host.currentModel = OTHER_MODEL;
    const beforeD1 = failedD1.host.notifications.length;
    expect(await failedD1.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(failedD1.host.notifications).toHaveLength(beforeD1 + 1);
    expect(failedD1.host.notifications.at(-1)).not.toContain(INSTANCED_NATIVE_ENTRY_SCHEMA);
    expect(status(failedD1).phase).toBe("ready");
    expect(status(failedD1).main.phase).toBe("failed");
  });

  test("missing or throwing registrars get local unavailable diagnostics for both reserved commands", async () => {
    for (const commandRegistration of ["missing", "throws"] as const) {
      const root = await startRoot({ commandRegistration });
      expect(status(root).phase).toBe("ready");
      expect(status(root).main.phase).toBe("bound");
      expect(root.host.commands.size).toBe(0);
      const displayed = root.host.notifications.length;
      expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
      expect(root.host.notifications).toHaveLength(displayed + 1);
      expect(root.host.notifications.at(-1)).toContain("agent-instances-status is unavailable");
      expect(root.host.notifications.at(-1)).not.toContain(INSTANCED_NATIVE_ENTRY_SCHEMA);
      expect(await root.host.input(`/${AGENT_DEFINITION_STATUS_COMMAND}`)).toEqual({ handled: true });
      expect(root.host.notifications).toHaveLength(displayed + 2);
      expect(root.host.notifications.at(-1)).toContain("agent-definition-status is unavailable");
      expect(root.host.notifications.at(-1)).not.toContain('"phase"');
      expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND} extra`)).toEqual({ handled: true });
      expect(root.host.notifications.at(-1)).toContain("accepts no arguments or images");
      expect(root.host.notifications).toHaveLength(displayed + 3);
      root.entry.dispose();
    }
  });

  test("malformed instance diagnostics are refused locally without queueing attachments", async () => {
    const root = await startRoot();
    await root.host.input("pending before instance diagnostics");
    const displayed = root.host.notifications.length;
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND} extra`)).toEqual({ handled: true });
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`, { images: [{ type: "image" }] }))
      .toEqual({ handled: true });
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`, { images: null }))
      .toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 3);
    for (const notification of root.host.notifications.slice(displayed)) {
      expect(notification).toContain("accepts no arguments or images");
    }
    const pending = await inspectWork(root, "inspect-instance-malformed-pending");
    expect(pending.current).toBeNull();
    expect(pending.pendingInputs.count).toBe(1);

    expect(await root.host.input(`\t/${AGENT_INSTANCES_STATUS_COMMAND}\n`, { images: [] }))
      .toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 4);
    expect(JSON.parse(String(root.host.notifications.at(-1))).schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);

    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}`, { source: "extension" })).toBeUndefined();
    expect(root.host.notifications).toHaveLength(displayed + 4);
    expect(await root.host.input(`/${AGENT_INSTANCES_STATUS_COMMAND}-other`)).toBeUndefined();
    const existingPath = await inspectWork(root, "inspect-instance-existing-path");
    expect(existingPath.pendingInputs.count).toBe(3);
  });

  test("earlier instance-status transforms are handled; later transforms and same-name commands do not run", async () => {
    const root = await startRoot();
    let transformAway = false;
    const entryHandlers = root.host.handlers.get("input") ?? [];
    root.host.handlers.set("input", [(event) => {
      if (!isRecord(event) || typeof event.text !== "string") return undefined;
      if (event.text === "/to-instance-status") return { text: `/${AGENT_INSTANCES_STATUS_COMMAND}` };
      if (event.text === `/${AGENT_INSTANCES_STATUS_COMMAND}` && transformAway) {
        return { text: "ordinary transformed instance input" };
      }
      return undefined;
    }, ...entryHandlers]);

    const displayed = root.host.notifications.length;
    expect(await root.host.submit("/to-instance-status")).toEqual({ handled: true });
    expect(root.host.notifications).toHaveLength(displayed + 1);
    expect(JSON.parse(String(root.host.notifications.at(-1))).schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);

    transformAway = true;
    expect(await root.host.submit(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: false });
    expect(root.host.notifications).toHaveLength(displayed + 1);

    transformAway = false;
    let laterTransforms = 0;
    root.host.handlers.get("input")!.push((event) => {
      if (isRecord(event) && event.text === `/${AGENT_INSTANCES_STATUS_COMMAND}`) {
        laterTransforms += 1;
        return { text: `/${AGENT_INSTANCES_STATUS_COMMAND} extra` };
      }
      return undefined;
    });
    let sameNameCommandRuns = 0;
    root.host.commands.set(AGENT_INSTANCES_STATUS_COMMAND, () => {
      sameNameCommandRuns += 1;
    });
    expect(await root.host.submit(`/${AGENT_INSTANCES_STATUS_COMMAND}`)).toEqual({ handled: true });
    expect(laterTransforms).toBe(0);
    expect(sameNameCommandRuns).toBe(0);
    expect(JSON.parse(String(root.host.notifications.at(-1))).schema).toBe(INSTANCED_NATIVE_ENTRY_SCHEMA);

    // Control: the same driver really does dispatch a non-reserved command
    // when the input stage does not handle it.
    let controlCommandRuns = 0;
    root.host.commands.set("control-diagnostic", () => {
      controlCommandRuns += 1;
    });
    expect(await root.host.submit("/control-diagnostic")).toEqual({
      handled: false,
      command: "control-diagnostic",
    });
    expect(controlCommandRuns).toBe(1);
  });

  test("bounds status views with an explicit budget while small views stay fully detailed", async () => {
    const root = await startRoot();
    await admit(root, "task-view");
    root.host.lifecycle({ status: "started", id: "ViewChild", parentToolCallId: "task-view", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-view", "ViewChild", { lifecycle: false });
    await child.host.prompt(childPrompt("ALPHA_BODY_V1"));
    const current = status(root);
    const view = current.view;
    if (!view.complete) throw new Error("expected a complete status view");
    expect(view.budgetBytes).toBe(64 * 1024);
    expect(view.detailBytes).toBeGreaterThan(0);
    expect(view.detailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(current.selections.map((selection) => selection.name)).toEqual(["alpha"]);
    expect(current.instances).toHaveLength(1);
    expect(current.instances[0]!.phase).toBe("bound");
    expect(current.pending).toEqual([]);
    expect(current.capacity.records).toEqual({ used: 1, limit: 64 });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(current), "utf8")).toBeLessThanOrEqual(64 * 1024);
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const commandText = String(root.host.notifications.at(-1));
    expect(Buffer.byteLength(commandText, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(commandText)).toEqual(JSON.parse(JSON.stringify(current)));
  });

  test("bounds 64 legal long-tool-name records while keeping the live binding intact", async () => {
    const longTool = "a".repeat(20_000);
    const rawContent = `---\nname: huge\nmodel: fixture/child\ntools:\n  - ${longTool}\n---\nA\n`;
    const huge = childSnapshot("huge", "A", "huge-v1", { tools: [longTool], rawContent });
    const main = makeSnapshot({
      name: "main",
      body: "MAIN_DEFINITION_BODY",
      version: "main-v1",
      tools: ["read", "task", longTool],
      model: MAIN_MODEL,
      selectorNull: true,
    });
    expect(Buffer.byteLength(longTool)).toBe(20_000);
    expect(Buffer.byteLength(rawContent)).toBeLessThan(64 * 1024);
    const root = await startRoot({ main, hostActiveTools: ["read", "task", longTool], children: [huge] });
    await admit(root, "task-huge-0", "huge");
    root.host.lifecycle({ status: "started", id: "HugeChild", parentToolCallId: "task-huge-0", index: 0, agent: "huge" });
    const child = await startChild(root, "task-huge-0", "HugeChild", {
      lifecycle: false,
      agentName: "huge",
      activeTools: [longTool],
    });
    await child.host.prompt(childPrompt("A"));
    expect(child.host.aborts).toBe(0);
    for (let index = 1; index < 64; index += 1) await admit(root, `task-huge-${index}`, "huge");
    const summary = status(root);
    const view = summary.view;
    if (view.complete) throw new Error("expected an encoded-size-limit summary");
    expect(view.budgetBytes).toBe(64 * 1024);
    expect(view.reason).toBe("encoded-size-limit");
    expect(view.detailBytes).toBeGreaterThan(64 * 1024);
    expect(view.detailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(view.omitted).toEqual({
      selections: 1,
      pending: 0,
      instances: 64,
      instancePhases: { admitted: 63, bound: 1, refused: 0, closed: 0 },
    });
    expect(summary.selections).toEqual([]);
    expect(summary.pending).toEqual([]);
    expect(summary.instances).toEqual([]);
    expect(summary.capacity.records.used).toBe(64);
    expect(summary.root?.workspaceRoot).toBe(WORKSPACE);
    expect(summary.main.phase).toBe("bound");
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Object.isFrozen(summary.view)).toBe(true);
    expect(status(root)).not.toBe(summary);

    const refused = await root.host.task("task-huge-overflow", { agent: "huge", task: "one more" });
    expect(blockedReason(refused)).toContain("Instance record capacity (64)");
    await child.host.prompt(childPrompt("A"));
    expect(child.host.aborts).toBe(0);
    const after = status(root);
    const afterView = after.view;
    if (afterView.complete || afterView.reason !== "encoded-size-limit") {
      throw new Error("expected the retained summary");
    }
    expect(afterView.omitted.instances).toBe(64);
    expect(afterView.omitted.instancePhases.bound).toBe(1);

    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const commandText = String(root.host.notifications.at(-1));
    expect(Buffer.byteLength(commandText, "utf8")).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(commandText);
    expect(parsed.view).toEqual(JSON.parse(JSON.stringify(afterView)));
    expect(parsed.instances).toEqual([]);
    expect(parsed.selections).toEqual([]);
    expect(parsed.pending).toEqual([]);
    expect(parsed.capacity.records.used).toBe(64);
    // Same nested envelope shape as `stderr("agent_instances_status", { text })`.
    const envelope = JSON.stringify({
      type: "omp_agent_instanced_native_entry",
      message: "agent_instances_status",
      details: { text: commandText },
    });
    expect(Buffer.byteLength(envelope, "utf8")).toBeLessThan(1024 * 1024);
  });

  test("measures encoded JSON bytes rather than characters for escapable names", async () => {
    const multibyteTool = `q"\\${"😀".repeat(9_000)}`;
    const canonicalPath = `${WORKSPACE}/.omp/agents/probe\u0001.md`;
    const rawContent = `---\nname: encoded\nmodel: fixture/child\ntools:\n  - ${multibyteTool}\n---\nA\n`;
    const encoded = childSnapshot("encoded", "A", "encoded-v1", {
      tools: [multibyteTool],
      canonicalPath,
      rawContent,
    });
    const main = makeSnapshot({
      name: "main",
      body: "MAIN_DEFINITION_BODY",
      version: "main-v1",
      tools: ["read", "task", multibyteTool],
      model: MAIN_MODEL,
      selectorNull: true,
    });
    expect(Buffer.byteLength(rawContent)).toBeLessThan(64 * 1024);
    // The repeated name stays below the char budget below, but its encoded
    // JSON is well above it: three copies (selection plus two instances).
    expect(multibyteTool.length * 3).toBeLessThan(64 * 1024);
    const root = await startRoot({ main, hostActiveTools: ["read", "task", multibyteTool], children: [encoded] });
    await admit(root, "task-encoded-0", "encoded");
    await admit(root, "task-encoded-1", "encoded");
    const current = status(root);
    const view = current.view;
    if (view.complete) throw new Error("expected an encoded-byte summary");
    expect(view.detailBytes).toBeGreaterThan(64 * 1024);
    expect(view.omitted).toEqual({
      selections: 1,
      pending: 0,
      instances: 2,
      instancePhases: { admitted: 2, bound: 0, refused: 0, closed: 0 },
    });
    expect(Buffer.byteLength(JSON.stringify(current), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(String(JSON.stringify(current))).not.toContain("\u0001");
  });

  test("status fallback reports unavailable state instead of an observed empty snapshot", async () => {
    const root = await startRoot();
    await admit(root, "task-status-fault");
    root.host.lifecycle({
      status: "started",
      id: "FaultChild",
      parentToolCallId: "task-status-fault",
      index: 0,
      agent: "alpha",
    });
    await startChild(root, "task-status-fault", "FaultChild", { lifecycle: false });
    expect(records(root)).toHaveLength(1);
    expect(records(root)[0]!.phase).toBe("bound");

    const controller = root.entry.controller;
    const originalGetStatus = controller.getStatus;
    controller.getStatus = () => {
      throw new Error("injected controller status read failure");
    };
    try {
      const unavailable = root.entry.getStatus();
      if (unavailable.view.complete || unavailable.view.reason !== "status-unavailable") {
        throw new Error("expected a status-unavailable view");
      }
      expect(unavailable.view.budgetBytes).toBe(64 * 1024);
      expect(unavailable.view.detailBytes).toBeNull();
      expect(unavailable.view.detailSha256).toBeNull();
      expect(unavailable.view.fallbackBytes).toBeGreaterThan(0);
      expect(unavailable.view.fallbackSha256).toMatch(/^[0-9a-f]{64}$/);
      const { view: measuredView, ...fallbackPayload } = unavailable;
      const fallbackJson = JSON.stringify(fallbackPayload);
      expect(measuredView.fallbackBytes).toBe(Buffer.byteLength(fallbackJson, "utf8"));
      expect(measuredView.fallbackSha256).toBe(createHash("sha256").update(fallbackJson).digest("hex"));
      expect(unavailable.view.omitted).toEqual({
        selections: null,
        pending: null,
        instances: null,
        instancePhases: null,
      });
      expect(unavailable.view.unavailable).toEqual(expect.arrayContaining([
        "selections",
        "pending",
        "instances",
        "capacity.used",
      ]));
      expect(unavailable.phase).toBe("failed");
      expect(unavailable.failure).toContain("injected controller status read failure");
      expect(unavailable.selections).toEqual([]);
      expect(unavailable.pending).toEqual([]);
      expect(unavailable.instances).toEqual([]);
      expect(unavailable.capacity).toEqual({
        definitions: { used: null, limit: 8 },
        pending: { used: null, limit: 16 },
        records: { used: null, limit: 64 },
        retainedTextBytes: { used: null, limit: 8 * 1024 * 1024 },
        usedToolCallIds: null,
        toolCallIdLimit: 80,
      });
      expect(unavailable.main.phase).toBe("unavailable");
      expect(Object.isFrozen(unavailable)).toBe(true);
      expect(Object.isFrozen(unavailable.view)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(unavailable), "utf8")).toBeLessThanOrEqual(64 * 1024);

      const second = root.entry.getStatus();
      expect(second).not.toBe(unavailable);
      if (second.view.complete || second.view.reason !== "status-unavailable") {
        throw new Error("expected a fresh unavailable view");
      }
      expect(second.view.reason).toBe("status-unavailable");

      root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
      const notified = JSON.parse(String(root.host.notifications.at(-1)));
      expect(notified.view.complete).toBe(false);
      expect(notified.view.reason).toBe("status-unavailable");
      expect(notified.view.detailBytes).toBeNull();
      expect(notified.view.omitted.instances).toBeNull();
      expect(notified.instances).toEqual([]);
      expect(notified.selections).toEqual([]);
      expect(notified.capacity.records.used).toBeNull();
      expect(notified.capacity.records.limit).toBe(64);
      expect(Buffer.byteLength(String(root.host.notifications.at(-1)), "utf8")).toBeLessThanOrEqual(64 * 1024);
    } finally {
      controller.getStatus = originalGetStatus;
    }

    const restored = root.entry.getStatus();
    expect(restored.view.complete).toBe(true);
    expect(restored.phase).toBe("ready");
    expect(restored.instances).toHaveLength(1);
    expect(restored.instances[0]!.childId).toBe("FaultChild");
    expect(restored.instances[0]!.phase).toBe("bound");
    expect(restored.capacity.records.used).toBe(1);
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const restoredCommand = JSON.parse(String(root.host.notifications.at(-1)));
    expect(restoredCommand.view.complete).toBe(true);
    expect(restoredCommand.instances).toHaveLength(1);
    expect(restoredCommand.instances[0].childId).toBe("FaultChild");
  });

  test("applies the bounded view to failed and nonowner status routes", async () => {
    const root = await startRoot({ childDefinitions: [] });
    expect(status(root).phase).toBe("failed");
    const failed = status(root).view;
    if (!failed.complete) throw new Error("expected a complete failed-root view");
    expect(failed.budgetBytes).toBe(64 * 1024);
    expect(status(root).failure).toContain("must select 1-");
    root.host.command(AGENT_INSTANCES_STATUS_COMMAND);
    const failedCommand = JSON.parse(String(root.host.notifications.at(-1)));
    expect(failedCommand.view.complete).toBe(true);
    expect(failedCommand.view.budgetBytes).toBe(64 * 1024);
    expect(failedCommand.failure).toContain("must select 1-");

    const secondHost = new Host({ activeTools: ["read", "task"] });
    const secondEntry = createInstancedNativeEntry(secondHost.pi, {
      mainDefinitionPath: root.main.definition.canonicalPath,
      childDefinitions: root.childDefinitions,
      nativePorts: root.ports,
      loadMainDefinition: async () => root.main,
      loadChildDefinition: root.loadChild,
      startupTimeoutMs: 1_000,
    });
    controls.push(secondEntry);
    await secondHost.sessionStart();
    const second = secondEntry.getStatus();
    const secondView = second.view;
    if (!secondView.complete) throw new Error("expected a complete nonowner view");
    expect(secondView.budgetBytes).toBe(64 * 1024);
    expect(second.factory.ownsRoot).toBe(false);
    expect(second.instances).toEqual([]);
    expect(second.selections).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(64 * 1024);
    secondHost.command(AGENT_INSTANCES_STATUS_COMMAND);
    const secondCommand = JSON.parse(String(secondHost.notifications.at(-1)));
    expect(secondCommand.view.complete).toBe(true);
    expect(secondCommand.factory.ownsRoot).toBe(false);
  });
});
