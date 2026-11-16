import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  type InstancedHarnessBackendFactory,
  type InstancedHarnessConfig,
  type InstancedModel,
  type InstancedNativeContext,
  type InstancedNativeEntryControls,
  type InstancedNativeEntryOptions,
  type InstancedNativePorts,
  type InstancedOmpApi,
  type InstancedSupportedSettings,
} from "../../src/instanced-native-entry.ts";
import {
  NATIVE_HARNESS_TOOL,
  type NativeHarnessBackend,
  type NativeHarnessDelegationPolicy,
  type NativeHarnessDelegationResult,
  type NativeHarnessOutputSelection,
  type NativeHarnessOutputSelectionCode,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import {
  createNativeHarnessBackend,
  type NativeHarnessBackendHost,
  type NativeHarnessBackendHostConfig,
} from "../../src/native-harness-backend.ts";
import type { NativeHarnessOutputCapture } from "../../src/native-harness-output.ts";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";
import { clearPublishedTaskOwner, publishTaskOwner } from "../../src/task-entry-port.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";
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
  approval?: string;
  loadMode?: string;
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
  readonly workspace?: string;
}

function makeSnapshot(spec: SnapshotSpec): DefinitionSnapshot {
  const workspace = spec.workspace ?? WORKSPACE;
  const canonicalPath = spec.canonicalPath ?? `${workspace}/.omp/agents/${spec.name}.md`;
  const model = spec.model ?? MAIN_MODEL;
  const skills = (spec.skills ?? []).map((skill) => {
    const skillPath = `${workspace}/.omp/skills/${skill.name}/SKILL.md`;
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
    workspaceRoot: workspace,
    nativeSourceLabel: "explicit",
    definition,
    skills,
    getStatus: () => ({}) as never,
  }) as DefinitionSnapshot;
}

function mainSnapshot(
  workspace = WORKSPACE,
  tools: readonly string[] = ["read", "task"],
): DefinitionSnapshot {
  return makeSnapshot({
    name: "main",
    body: "MAIN_DEFINITION_BODY",
    version: "main-v1",
    tools,
    model: MAIN_MODEL,
    selectorNull: true,
    workspace,
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
    readonly workspace?: string;
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
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
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
const actualHarnessDirs: string[] = [];

afterEach(async () => {
  for (const control of controls.splice(0)) control.dispose();
  for (const dir of actualHarnessDirs.splice(0)) await rm(dir, { recursive: true, force: true });
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
  readonly toolRegistrations: RegisteredTool[] = [];
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
        const registered = tool as RegisteredTool;
        host.tools.set(tool.name, registered);
        host.toolRegistrations.push(registered);
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
    return await this.workWithSignal(toolCallId, params, undefined, this.context);
  }

  async workWithSignal(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    context: InstancedNativeContext = this.context,
  ): Promise<NativeToolResult> {
    await this.emit("tool_call", { toolCallId, toolName: NATIVE_WORK_TOOL, input: params }, context);
    const tool = this.tools.get(NATIVE_WORK_TOOL);
    if (tool === undefined) throw new Error("agent_work was not registered");
    const result = await tool.execute(toolCallId, params, signal, undefined, context);
    await this.emit("tool_result", {
      toolCallId,
      toolName: NATIVE_WORK_TOOL,
      input: params,
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    }, context);
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

/**
 * Runs the registered real session_stop hooks in registration order without
 * awaiting, modelling a host getter that lets ordered stop reentry complete
 * synchronously inside the first capture guard.
 */
function sessionStopHooksSynchronously(host: Host): unknown[] {
  const results: unknown[] = [];
  for (const handler of host.handlers.get("session_stop") ?? []) {
    results.push(handler({
      type: "session_stop",
      signal: new AbortController().signal,
      stop_hook_active: false,
    }, host.context));
  }
  return results;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeHarnessOptions {
  readonly createGate?: Deferred<void>;
  readonly executeGate?: Deferred<void>;
  /** Per-run gates indexed by the fake run number. */
  readonly executeGates?: readonly Deferred<void>[];
  /** Holds only runs after the first, letting a prior run settle normally. */
  readonly deferExecuteAfterFirst?: Deferred<void>;
  readonly executeStatus?: "completed" | "failed" | "cancelled";
}

interface FakeHarness {
  readonly host: NativeHarnessBackendHost;
  readonly events: string[];
  readonly prepareRequests: NativeHarnessPrepareRequest[];
  readonly contexts: NativeContext[];
}

function createFakeHarness(options: FakeHarnessOptions = {}): FakeHarness {
  const events: string[] = [];
  const prepareRequests: NativeHarnessPrepareRequest[] = [];
  const contexts: NativeContext[] = [];
  let nextRun = 1;
  const backend: NativeHarnessBackend = {
    async create(_task: string): Promise<unknown> {
      events.push("create");
      if (options.createGate !== undefined) await options.createGate.promise;
      return { runId: `run-${nextRun++}` };
    },
    async execute(runId: string): Promise<unknown> {
      events.push("execute");
      if (options.executeGate !== undefined) await options.executeGate.promise;
      const runNumber = Number(runId.split("-")[1]);
      const runGate = Number.isInteger(runNumber) ? options.executeGates?.[runNumber - 1] : undefined;
      if (runGate !== undefined) await runGate.promise;
      if (options.deferExecuteAfterFirst !== undefined && runId !== "run-1") {
        await options.deferExecuteAfterFirst.promise;
      }
      return { status: options.executeStatus ?? "completed" };
    },
    async cancel(runId: string): Promise<unknown> {
      events.push(`cancel:${runId}`);
      return { requested: true };
    },
    async get(_runId: string): Promise<unknown> {
      return { status: "running" };
    },
  };
  return {
    events,
    prepareRequests,
    contexts,
    host: {
      runner: {
        async run(): Promise<never> {
          throw new Error("the fake Harness backend must not dispatch its runner");
        },
      } as unknown as NativeHarnessBackendHost["runner"],
      async prepare(request: NativeHarnessPrepareRequest, context: NativeContext): Promise<NativeHarnessPrepareResult> {
        events.push("prepare");
        prepareRequests.push(request);
        contexts.push(context);
        request.guard();
        return { ok: true, backend };
      },
      inspect: () => [],
    },
  };
}

function harnessBackendConfig(
  overrides: Partial<NativeHarnessBackendHostConfig> = {},
): NativeHarnessBackendHostConfig {
  return {
    model: "fixture/main",
    ompCommand: "/fixture/bin/omp",
    storageRoot: "/fixture/harness-store",
    inputFiles: ["selected-input.txt"],
    ...overrides,
  };
}

const HARNESS_MAIN_TOOLS = ["read", "task", NATIVE_HARNESS_TOOL] as const;

function harnessMainOptions(
  tools: readonly string[] = HARNESS_MAIN_TOOLS,
): {
  readonly main: DefinitionSnapshot;
  readonly mainTools: readonly string[];
  readonly hostActiveTools: readonly string[];
} {
  return {
    main: mainSnapshot(WORKSPACE, tools),
    mainTools: tools,
    hostActiveTools: tools,
  };
}

function harnessFixture(
  fake: FakeHarness,
  policy?: NativeHarnessDelegationPolicy,
): { readonly harness: InstancedHarnessConfig; readonly factory: InstancedHarnessBackendFactory; readonly calls: NativeHarnessBackendHostConfig[] } {
  const calls: NativeHarnessBackendHostConfig[] = [];
  return {
    harness: {
      backend: harnessBackendConfig(),
      ...(policy === undefined ? {} : { policy }),
    },
    factory(config) {
      calls.push(config);
      return fake.host;
    },
    calls,
  };
}

const ACTUAL_HARNESS_PLAN_RESPONSE = JSON.stringify({
  decision: "direct",
  reason: "Bounded output capture planning.",
  criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
  routes: [],
});

const ACTUAL_HARNESS_SELECT_RESPONSE = JSON.stringify({
  method: "model_review",
  assessments: [{
    candidate: "A",
    criteria: [{ criterionId: "task", verdict: "unknown", evidence: "Bounded test evidence." }],
    strengths: [],
    weaknesses: [],
  }],
  winner: "A",
  reason: "Bounded test selection.",
  limitations: ["Bounded test execution is not semantic acceptance."],
});

interface ActualHarnessRunner {
  readonly runner: Runner;
  readonly requests: WorkerRequest[];
}

function actualHarnessRunner(candidateText = "candidate output\n"): ActualHarnessRunner {
  const requests: WorkerRequest[] = [];
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = ACTUAL_HARNESS_PLAN_RESPONSE;
      } else if (request.stage === "select") {
        text = ACTUAL_HARNESS_SELECT_RESPONSE;
      } else if (request.stage === "baseline") {
        await writeFile(path.join(request.cwd, "candidate.txt"), candidateText, { mode: 0o600 });
        text = "baseline completed";
      }
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status: "completed",
      };
    },
  };
  return { runner, requests };
}

interface ActualHarnessCaptureFixture {
  readonly root: RootFixture;
  readonly runner: ActualHarnessRunner;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly backendConfigs: NativeHarnessBackendHostConfig[];
}

async function startActualHarnessCapture(
  options: { readonly candidateText?: string } = {},
): Promise<ActualHarnessCaptureFixture> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "omp-a22c-")));
  actualHarnessDirs.push(dir);
  const sourceRoot = path.join(dir, "source");
  const storageRoot = path.join(dir, "private");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, "a.txt"), "alpha\n", { mode: 0o600 });
  const runner = actualHarnessRunner(options.candidateText);
  const backendConfigs: NativeHarnessBackendHostConfig[] = [];
  const harness: InstancedHarnessConfig = {
    backend: {
      model: "fixture/main",
      ompCommand: "/usr/bin/fake-omp",
      storageRoot,
      inputFiles: ["a.txt"],
    },
  };
  const root = await startRoot({
    workspace: sourceRoot,
    main: mainSnapshot(sourceRoot, HARNESS_MAIN_TOOLS),
    hostActiveTools: HARNESS_MAIN_TOOLS,
    children: [childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", { workspace: sourceRoot })],
    harness,
    harnessBackendFactory(config) {
      backendConfigs.push(config);
      return createNativeHarnessBackend(config, { deterministicRunner: runner.runner });
    },
  });
  return { root, runner, sourceRoot, storageRoot, backendConfigs };
}

interface ActualHarnessExecution {
  readonly result: NativeToolResult;
  readonly event: Record<string, unknown>;
  readonly signal: AbortSignal;
}

async function executeActualHarness(
  root: RootFixture,
  toolCallId: string,
  task: string,
): Promise<ActualHarnessExecution> {
  const controller = new AbortController();
  await root.host.emit("tool_call", {
    toolCallId,
    toolName: NATIVE_HARNESS_TOOL,
    input: { task },
  }, root.host.context);
  const tool = root.host.tools.get(NATIVE_HARNESS_TOOL);
  if (tool === undefined) throw new Error("agent_harness was not registered");
  const result = await tool.execute(toolCallId, { task }, controller.signal, undefined, root.host.context);
  return {
    result,
    signal: controller.signal,
    event: {
      toolCallId,
      toolName: NATIVE_HARNESS_TOOL,
      input: { task },
      content: result.content,
      isError: result.isError === true,
      details: result.details,
    },
  };
}

async function observeActualHarness(
  root: RootFixture,
  execution: ActualHarnessExecution,
): Promise<void> {
  await root.host.emit("tool_result", execution.event, root.host.context);
}

async function hostCapture(
  root: RootFixture,
  sourceToolCallId: string,
  signal: AbortSignal = new AbortController().signal,
  context: InstancedNativeContext = root.host.context,
): Promise<NativeHarnessOutputSelection> {
  const control = root.entry.harnessCaptureOutput;
  if (control === undefined) throw new Error("host-only harness capture is unavailable");
  return await control.call(root.entry, sourceToolCallId, signal, context);
}

function expectCaptureSuccess(selection: NativeHarnessOutputSelection): NativeHarnessOutputCapture {
  if (!selection.ok) throw new Error(`capture failed: ${selection.code} ${selection.reason}`);
  return selection.capture;
}

function expectCaptureFailure(
  selection: NativeHarnessOutputSelection,
  code?: NativeHarnessOutputSelectionCode | readonly NativeHarnessOutputSelectionCode[],
): void {
  expect(selection.ok).toBe(false);
  if (selection.ok) return;
  if (code === undefined) return;
  const allowed = Array.isArray(code) ? code : [code];
  expect(allowed).toContain(selection.code);
}

async function executeHarness(
  root: RootFixture,
  toolCallId: string,
  task: string,
  signal: AbortSignal,
  context: InstancedNativeContext = root.host.context,
): Promise<NativeToolResult> {
  await root.host.emit("tool_call", {
    toolCallId,
    toolName: NATIVE_HARNESS_TOOL,
    input: { task },
  }, context);
  const tool = root.host.tools.get(NATIVE_HARNESS_TOOL);
  if (tool === undefined) throw new Error("agent_harness was not registered");
  const result = await tool.execute(toolCallId, { task }, signal, undefined, context);
  await root.host.emit("tool_result", {
    toolCallId,
    toolName: NATIVE_HARNESS_TOOL,
    input: { task },
    content: result.content,
    isError: result.isError === true,
    details: result.details,
  }, context);
  return result;
}

function startHarness(
  root: RootFixture,
  toolCallId: string,
  task: string,
  signal: AbortSignal,
  context: InstancedNativeContext = root.host.context,
): Promise<NativeToolResult> {
  return executeHarness(root, toolCallId, task, signal, context);
}

function harnessDetails(result: NativeToolResult): NativeHarnessDelegationResult {
  return result.details as NativeHarnessDelegationResult;
}

function expectHarnessRefused(result: NativeToolResult, pattern: RegExp): void {
  expect(result.isError).toBe(true);
  const details = harnessDetails(result);
  expect(details.resultKind).toBe("refused");
  expect(details.taskAccepted).toBe(false);
  expect(details.semanticAcceptance).toBe("not-evaluated");
  expect(String(details.reason)).toMatch(pattern);
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
  readonly workspace: string;
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
  readonly workspace?: string;
  readonly harness?: InstancedHarnessConfig;
  readonly harnessBackendFactory?: InstancedHarnessBackendFactory;
}

async function startRoot(options: RootOptions = {}): Promise<RootFixture> {
  const workspace = options.workspace ?? WORKSPACE;
  const main = options.main ?? mainSnapshot(workspace);
  const children = options.children ?? [childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", { workspace })];
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
    cwd: workspace,
    sessionId: "session-root",
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
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.harnessBackendFactory === undefined
      ? {}
      : { harnessBackendFactory: options.harnessBackendFactory }),
    diagnostic: (event) => host.diagnostics.push(event),
  });
  controls.push(entry);
  await host.sessionStart();
  return { host, entry, main, ports, children, loadChild, childDefinitions, limits: options.limits, workspace };
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
    cwd: options.cwd ?? root.workspace,
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

/**
 * A main-shaped context that can deliberately carry a foreign session or cwd
 * while keeping the same agent id as the bound owner.
 */
function ownerContext(options: {
  readonly agentKind?: "main" | "sub" | "unknown";
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly cwd?: string;
} = {}): InstancedNativeContext {
  const sessionId = options.sessionId ?? "session-root";
  const cwd = options.cwd ?? WORKSPACE;
  return {
    get cwd() {
      return cwd;
    },
    agent: {
      kind: options.agentKind ?? "main",
      id: options.agentId ?? "Main",
      name: "main",
      parentId: null,
      depth: 0,
    },
    hasUI: true,
    model: MAIN_MODEL,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getCwd() {
        return cwd;
      },
    },
    models: {
      current: () => MAIN_MODEL,
      resolve: () => CHILD_MODEL,
    },
    ui: {
      notify: () => undefined,
    },
    abort: () => undefined,
  } as unknown as InstancedNativeContext;
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

/**
 * Real native work: input + prompt activates the current work, and the native
 * observer records the later task tool_call that this entry only observes.
 */
async function beginWork(root: RootFixture, text: string): Promise<void> {
  await root.host.input(text, { source: "interactive" });
  await root.host.prepare(text);
}

interface ResultSpec {
  readonly isError?: boolean;
  readonly output?: string;
  readonly exitCode?: number;
  readonly aborted?: boolean;
  readonly truncated?: boolean;
  readonly error?: string;
  readonly abortReason?: string;
  readonly outputPath?: string;
}

function taskResultEvent(
  taskCallId: string,
  childId: string | null,
  agent: string,
  spec: ResultSpec = {},
): Record<string, unknown> {
  const output = spec.output ?? "child output";
  const result: Record<string, unknown> = {
    index: 0,
    ...(childId === null ? {} : { id: childId }),
    agent,
    exitCode: spec.exitCode ?? 0,
    aborted: spec.aborted ?? false,
    truncated: spec.truncated ?? false,
    output,
    ...(spec.error === undefined ? {} : { error: spec.error }),
    ...(spec.abortReason === undefined ? {} : { abortReason: spec.abortReason }),
    ...(spec.outputPath === undefined ? {} : { outputPath: spec.outputPath }),
  };
  return {
    toolCallId: taskCallId,
    toolName: "task",
    input: { agent, task: "fixture task text" },
    content: [{ type: "text", text: output }],
    isError: spec.isError ?? false,
    details: { results: [result] },
  };
}

interface ReportFixture {
  readonly root: RootFixture;
  readonly alpha: DefinitionSnapshot;
  readonly child: ChildFixture | null;
  readonly call: string;
  readonly childId: string;
}

/**
 * Real success fixture: activate native work, admit, bind the child session,
 * then run the existing Role and Skill text gates. C1 envelopes alone never
 * replace those verifications.
 */
async function reportFixture(options: {
  readonly children?: readonly DefinitionSnapshot[];
  readonly result?: ResultSpec | false;
  readonly resultEvent?: Record<string, unknown>;
  readonly close?: boolean;
  readonly verify?: boolean;
  readonly workSource?: string;
  readonly call?: string;
  readonly childId?: string;
} = {}): Promise<ReportFixture> {
  const alpha = options.children?.[0] ?? childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
  const root = await startRoot({ children: options.children ?? [alpha] });
  const text = "report fixture request";
  await root.host.input(text, { source: options.workSource ?? "interactive" });
  await root.host.prepare(text);
  const call = options.call ?? "task-report";
  const childId = options.childId ?? "ChildReport";
  await admit(root, call);
  const child = await startChild(root, call, childId);
  if (options.verify !== false) {
    await child.host.prompt(childPrompt(alpha.definition.body));
    await child.host.emitContext([]);
  }
  if (options.close === true) {
    root.host.lifecycle({
      status: "completed",
      id: childId,
      parentToolCallId: call,
      index: 0,
      agent: alpha.definition.name,
    });
    await child.host.emit("session_shutdown", {});
  }
  if (options.resultEvent !== undefined) {
    await root.host.emit("tool_result", options.resultEvent);
  } else if (options.result !== false) {
    await root.host.emit("tool_result", taskResultEvent(
      call,
      childId,
      alpha.definition.name,
      options.result ?? {},
    ));
  }
  return { root, alpha, child, call, childId };
}

async function instanceCatalog(root: RootFixture, toolCallId = "inspect-instance-results"): Promise<Record<string, any>> {
  const result = await root.host.work(toolCallId, { action: "inspect" });
  expect(result.isError).not.toBe(true);
  return (result.details as Record<string, any>).instanceResults;
}

function catalogRow(catalog: Record<string, any>, parentToolCallId: string): Record<string, any> {
  const row = catalog.items.find((item: Record<string, any>) => item.parentToolCallId === parentToolCallId);
  if (row === undefined) throw new Error(`no catalog row for ${parentToolCallId}`);
  return row;
}

function selectedReportParams(row: Record<string, any>, call = row.parentToolCallId): Record<string, unknown> {
  return {
    action: "report",
    checks: [{ toolCallId: call, purpose: "delegated work" }],
    outputFiles: [],
    outcome: "completed",
    instanceResult: {
      instanceId: row.instanceId,
      parentToolCallId: call,
      envelopeSha256: row.envelopeSha256,
    },
  };
}

async function selectedReport(
  root: RootFixture,
  params: Record<string, unknown>,
  options: {
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
    readonly context?: InstancedNativeContext;
  } = {},
): Promise<NativeToolResult> {
  return await root.host.workWithSignal(
    options.toolCallId ?? "report-instance-result",
    params,
    options.signal ?? new AbortController().signal,
    options.context ?? root.host.context,
  );
}

function expectReportRefused(result: NativeToolResult, pattern: RegExp): void {
  expect(result.isError).toBe(true);
  expect(String((result.content[0] as { text?: string } | undefined)?.text ?? "")).toMatch(pattern);
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

  test("captures the task preflight through the native observer and keeps that exact ref after the async load", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaderStarted = false;
    let loads = 0;
    const root = await startRoot({
      children: [alpha],
      loadChild: async (input) => {
        expect(input.definitionPath).toBe(alpha.definition.requestedPath);
        loads += 1;
        if (loads === 1) return alpha;
        loaderStarted = true;
        await gate;
        return alpha;
      },
    });
    await beginWork(root, "fixture request");
    const admission = root.host.task("task-ref", { agent: "alpha", task: "fixture task text" });
    await waitFor(() => loaderStarted);
    expect(records(root)).toEqual([]);
    release();
    expect(blockedReason(await admission)).toBe("");

    const admitted = records(root)[0]!;
    expect(admitted.observation.work.scope).toBe("last-owner-main-hook");
    expect("scope" in admitted.observation).toBe(false);
    expect(admitted.observation.work.capture).toBe("captured");
    expect(admitted.observation.work.captureReason).toBeNull();
    expect(admitted.observation.work.hook).toBe("tool_call");
    expect(admitted.observation.work.inspection?.state).toBe("current");
    expect(admitted.observation.work.inspection?.association?.toolCallId).toBe("task-ref");
    expect(Object.isFrozen(admitted.observation)).toBe(true);
    expect(Object.isFrozen(admitted.observation.work)).toBe(true);
    const generation = admitted.observation.work.inspection!.association!.generation;

    await root.host.emit("agent_end", {});
    const ended = records(root)[0]!;
    expect(ended.observation.work.hook).toBe("agent_end");
    expect(ended.observation.work.inspection?.state).toBe("ended");
    expect(ended.observation.work.inspection?.reason).toBe("work-ended");
    expect(ended.observation.work.inspection?.association?.generation).toBe(generation);

    await root.host.emit("tool_result", taskResultEvent("task-ref", null, "alpha", {
      isError: true,
      exitCode: 1,
      output: "failed child",
    }));
    const observed = records(root)[0]!;
    expect(observed.observation.work.inspection?.association?.generation).toBe(generation);
    expect(observed.observation.result.observation?.state).toBe("observed");
    expect(observed.observation.result.observation?.link).toBe("call-only");
    expect(observed.observation.result.observation?.outcome).toBe("failed-envelope");
  });

  test("a missing native capture is explicit unavailability and never blocks admission or recaptures at result", async () => {
    const root = await startRoot();
    // No input/before_agent_start: the native observer has no current work and
    // cannot have recorded this call. Admission behavior must stay unchanged.
    await admit(root, "task-nocapture");
    const admitted = records(root)[0]!;
    expect(admitted.phase).toBe("admitted");
    expect(status(root).phase).toBe("ready");
    expect(admitted.observation.work.capture).toBe("unavailable");
    expect(admitted.observation.work.captureReason).toContain("call-not-observed");
    expect(admitted.observation.work.inspection?.state).toBe("unavailable");
    expect(admitted.observation.work.inspection?.reason).toBe("call-not-observed");
    expect(admitted.observation.work.inspection?.association).toBeNull();

    await root.host.emit("tool_result", taskResultEvent("task-nocapture", null, "alpha", {
      isError: true,
      exitCode: 1,
    }));
    const later = records(root)[0]!;
    expect(later.observation.work.capture).toBe("unavailable");
    expect(later.observation.work.inspection?.reason).toBe("call-not-observed");
    expect(later.observation.result.observation?.state).toBe("observed");
    expect(later.observation.result.observation?.link).toBe("call-only");
  });

  test("pending ingress during the async load suspends the stored work association without gating the task", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaderStarted = false;
    let loads = 0;
    const root = await startRoot({
      children: [alpha],
      loadChild: async () => {
        loads += 1;
        if (loads === 1) return alpha;
        loaderStarted = true;
        await gate;
        return alpha;
      },
    });
    await beginWork(root, "first request");
    const admission = root.host.task("task-suspended", { agent: "alpha", task: "fixture task text" });
    await waitFor(() => loaderStarted);
    await root.host.input("second request", { source: "interactive" });
    release();
    expect(blockedReason(await admission)).toBe("");
    const admitted = records(root)[0]!;
    expect(admitted.phase).toBe("admitted");
    expect(admitted.observation.work.capture).toBe("captured");
    expect(admitted.observation.work.inspection?.state).toBe("suspended");
    expect(admitted.observation.work.inspection?.reason).toBe("pending-input");
    expect(status(root).phase).toBe("ready");
  });

  test("fresh work after a completed work keeps the old association stale and admits a new call on its own scope", async () => {
    const root = await startRoot();
    await beginWork(root, "first request");
    await admit(root, "task-old-work");
    const oldGeneration = records(root)[0]!.observation.work.inspection!.association!.generation;
    await root.host.emit("agent_end", {});
    expect(records(root)[0]!.observation.work.inspection?.state).toBe("ended");

    await beginWork(root, "second request");
    const old = records(root)[0]!;
    expect(old.observation.work.hook).toBe("before_agent_start");
    expect(old.observation.work.inspection?.state).toBe("stale");
    expect(old.observation.work.inspection?.reason).toBe("work-replaced");
    expect(old.observation.work.inspection?.association?.generation).toBe(oldGeneration);

    await admit(root, "task-new-work");
    const both = records(root);
    expect(both).toHaveLength(2);
    expect(both[1]!.observation.work.hook).toBe("tool_call");
    expect(both[1]!.observation.work.inspection?.state).toBe("current");
    expect(both[1]!.observation.work.inspection?.association?.generation).not.toBe(oldGeneration);
    expect(both[0]!.observation.work.inspection?.state).toBe("stale");
    expect(status(root).phase).toBe("ready");
  });

  test("two children on one definition keep distinct identities, work scopes and results", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "first request");
    await admit(root, "task-one");
    root.host.lifecycle({ status: "started", id: "ChildOne", parentToolCallId: "task-one", index: 0, agent: "alpha" });
    await startChild(root, "task-one", "ChildOne", { lifecycle: false });
    const firstGeneration = records(root)[0]!.observation.work.inspection!.association!.generation;

    await root.host.emit("agent_end", {});
    await beginWork(root, "second request");
    await admit(root, "task-two");
    root.host.lifecycle({ status: "started", id: "ChildTwo", parentToolCallId: "task-two", index: 0, agent: "alpha" });
    await startChild(root, "task-two", "ChildTwo", { lifecycle: false });
    const two = records(root);
    expect(two).toHaveLength(2);
    expect(two[0]!.childId).toBe("ChildOne");
    expect(two[1]!.childId).toBe("ChildTwo");
    expect(two[0]!.observation.work.inspection?.state).toBe("stale");
    expect(two[1]!.observation.work.inspection?.state).toBe("current");
    expect(two[1]!.observation.work.inspection?.association?.generation).not.toBe(firstGeneration);

    // V1 result arrives only after V2 was admitted; it must stay on record 1.
    await root.host.emit("tool_result", taskResultEvent("task-one", "ChildOne", "alpha", {
      output: "one output",
    }));
    await root.host.emit("tool_result", taskResultEvent("task-two", "ChildTwo", "alpha", {
      output: "two output",
    }));
    const [one, second] = records(root);
    expect(one!.observation.result.observation?.state).toBe("observed");
    expect(one!.observation.result.observation?.association?.instanceId).toBe(one!.id);
    expect(one!.observation.result.observation?.association?.childId).toBe("ChildOne");
    expect(one!.observation.result.observation?.association?.childSessionId).toBe("session-ChildOne");
    expect(one!.observation.result.observation?.output?.excerpt).toBe("one output");
    expect(second!.observation.result.observation?.association?.instanceId).toBe(second!.id);
    expect(second!.observation.result.observation?.association?.childId).toBe("ChildTwo");
    expect(second!.observation.result.observation?.output?.excerpt).toBe("two output");
  });

  test("a completed child shutdown still allows a completed envelope as observation only", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "completed request");
    await admit(root, "task-completed");
    root.host.lifecycle({ status: "started", id: "CompletedChild", parentToolCallId: "task-completed", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-completed", "CompletedChild", { lifecycle: false });
    expect(records(root)[0]!.phase).toBe("bound");

    root.host.lifecycle({
      status: "completed",
      id: "CompletedChild",
      parentToolCallId: "task-completed",
      index: 0,
      agent: "alpha",
    });
    await child.host.emit("session_shutdown", {});
    expect(records(root)[0]!.phase).toBe("closed");

    await root.host.emit("tool_result", taskResultEvent("task-completed", "CompletedChild", "alpha", {
      output: "done",
    }));
    const observed = records(root)[0]!;
    expect(observed.phase).toBe("closed");
    expect(observed.lifecycle).toBe("completed");
    expect(observed.observation.lifecycleEvidence).toEqual({ completed: true, failed: false, aborted: false });
    expect(observed.observation.result.observation?.state).toBe("observed");
    expect(observed.observation.result.observation?.outcome).toBe("completed-envelope");
    expect(observed.observation.result.observation?.semanticAcceptance).toBe("not-evaluated");
    expect(observed.observation.conflict).toBeNull();
    expect(observed.taskResultObserved).toBe(true);
  });

  test("a nested abort stays distinct from outer success and a late completed lifecycle cannot erase it", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "abort request");
    await admit(root, "task-abort");
    root.host.lifecycle({ status: "started", id: "AbortChild", parentToolCallId: "task-abort", index: 0, agent: "alpha" });
    await startChild(root, "task-abort", "AbortChild", { lifecycle: false });
    await root.host.emit("agent_end", {});

    await root.host.emit("tool_result", taskResultEvent("task-abort", "AbortChild", "alpha", {
      isError: false,
      exitCode: 1,
      aborted: true,
      abortReason: "child cancelled",
      output: "partial",
    }));
    let observed = records(root)[0]!;
    const result = observed.observation.result.observation!;
    expect(result.state).toBe("observed");
    expect(result.outcome).toBe("aborted-envelope");
    expect(result.link).toBe("instance");
    expect(result.confirmedChildAbort).toBe(true);
    expect(result.parentCancellation).toBe("unknown");
    expect(result.semanticAcceptance).toBe("not-evaluated");
    expect(result.native?.isError).toBe(false);
    expect(result.native?.aborted).toBe(true);

    root.host.lifecycle({
      status: "completed",
      id: "AbortChild",
      parentToolCallId: "task-abort",
      index: 0,
      agent: "alpha",
    });
    observed = records(root)[0]!;
    expect(observed.observation.lifecycleEvidence).toEqual({ completed: true, failed: false, aborted: false });
    expect(observed.observation.result.observation?.outcome).toBe("aborted-envelope");
    expect(observed.observation.conflict?.code).toBe("lifecycle-completed-result-aborted");
    const sticky = observed.observation.conflict;

    // A duplicate envelope is idempotent and cannot rehabilitate the conflict.
    await root.host.emit("tool_result", taskResultEvent("task-abort", "AbortChild", "alpha", {
      isError: false,
      exitCode: 1,
      aborted: true,
      abortReason: "child cancelled",
      output: "partial",
    }));
    expect(records(root)[0]!.observation.conflict).toEqual(sticky);
  });

  test("foreign main, cwd, child and reentrant navigation contexts cannot attach a result or refresh a record", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "foreign request");
    await admit(root, "task-foreign");
    root.host.lifecycle({ status: "started", id: "ForeignChild", parentToolCallId: "task-foreign", index: 0, agent: "alpha" });
    const child = await startChild(root, "task-foreign", "ForeignChild", { lifecycle: false });
    const recordBefore = records(root)[0]!;
    const event = taskResultEvent("task-foreign", "ForeignChild", "alpha", { output: "foreign output" });

    const makeContext = (options: {
      readonly agentId?: string;
      readonly sessionId?: string;
      readonly cwd?: string;
      readonly onSession?: () => void;
    }): InstancedNativeContext => {
      let fired = false;
      return {
        get cwd() {
          return options.cwd ?? WORKSPACE;
        },
        agent: {
          kind: "main",
          id: options.agentId ?? "Main",
          name: "main",
          parentId: null,
          depth: 0,
        },
        hasUI: false,
        model: MAIN_MODEL,
        sessionManager: {
          getSessionId() {
            if (!fired) {
              fired = true;
              options.onSession?.();
            }
            return options.sessionId ?? "session-root";
          },
          getCwd() {
            return options.cwd ?? WORKSPACE;
          },
        },
        models: {
          current: () => MAIN_MODEL,
          resolve: () => CHILD_MODEL,
        },
      } as unknown as InstancedNativeContext;
    };

    await root.host.emit("tool_result", event, makeContext({ agentId: "OtherMain", sessionId: "session-other" }));
    await root.host.emit("tool_result", event, makeContext({ cwd: "/foreign-workspace" }));
    await root.host.emit("tool_result", event, makeContext({ sessionId: "session-other" }));
    await child.host.emit("tool_result", event);
    let unchanged = records(root)[0]!;
    expect(unchanged.observation.result.observation).toBeNull();
    expect(unchanged.observation.work.hook).toBe(recordBefore.observation.work.hook);
    expect(status(root).phase).toBe("ready");

    // Reentrant navigation during the identity read invalidates the root and
    // must not let the outer observation write into the old record.
    await root.host.emit("tool_result", event, makeContext({
      onSession: () => {
        for (const handler of root.host.handlers.get("session_switch") ?? []) {
          void handler({ type: "session_switch" }, root.host.context);
        }
      },
    }));
    unchanged = records(root)[0]!;
    expect(unchanged.observation.result.observation).toBeNull();
    expect(unchanged.observation.work.inspection).toBeNull();
    expect(unchanged.observation.work.invalidatedReason).not.toBeNull();
    expect(status(root).phase).toBe("closed");
  });

  test("foreign main ending events cannot refresh or invalidate the bound owner observation", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "owner ending request");
    await admit(root, "task-owner-ending");

    // The real owner end first refreshes the record and invalidates the
    // unbound admission; later foreign events must preserve those facts.
    await root.host.emit("agent_end", {});
    const ended = records(root)[0]!;
    expect(ended.observation.work.scope).toBe("last-owner-main-hook");
    expect(ended.observation.work.hook).toBe("agent_end");
    expect(ended.observation.work.inspection?.state).toBe("ended");
    expect(ended.phase).toBe("refused");
    expect(ended.refusalCode).toBe("work-ended");
    const generation = ended.observation.work.inspection!.association!.generation;
    const workEpoch = status(root).root?.workEpoch;

    for (const hook of ["agent_end", "session_stop"] as const) {
      for (const foreign of [{ sessionId: "session-foreign" }, { cwd: "/foreign-workspace" }]) {
        await root.host.emit(hook, {}, ownerContext(foreign));
        const unchanged = records(root)[0]!;
        expect(unchanged.observation.work.hook).toBe("agent_end");
        expect(unchanged.observation.work.inspection?.state).toBe("ended");
        expect(unchanged.observation.work.inspection?.association?.generation).toBe(generation);
        expect(unchanged.phase).toBe("refused");
        expect(status(root).root?.workEpoch).toBe(workEpoch);
        expect(status(root).phase).toBe("ready");
        expect(status(root).failure).toBeNull();
      }
    }
  });

  test("a host session change read during post-load inspection is refused by the final identity validation", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "inspect session drift request");
    const native = root.entry.nativeEntry;
    const originalInspect = native.inspectCall;
    try {
      native.inspectCall = (ref, context) => {
        // Simulates a host getter read during inspection mutating the live session.
        root.host.sessionId = "session-mutated-during-inspection";
        return originalInspect(ref, context);
      };
      const refused = await root.host.task("task-inspect-session", { agent: "alpha", task: "drift" });
      expect(blockedReason(refused)).toContain("identity changed");
      expect(status(root).phase).toBe("failed");
      expect(status(root).failure).toContain("identity changed");
      expect(status(root).instances).toEqual([]);
    } finally {
      native.inspectCall = originalInspect;
    }
  });

  test("a host tool change read during post-load inspection is refused by the final tools validation", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "inspect tools drift request");
    const native = root.entry.nativeEntry;
    const originalInspect = native.inspectCall;
    try {
      native.inspectCall = (ref, context) => {
        // Simulates a host getter read during inspection mutating the live tools.
        root.host.activeTools = ["read", "task", "write"];
        return originalInspect(ref, context);
      };
      const refused = await root.host.task("task-inspect-tools", { agent: "alpha", task: "drift" });
      expect(blockedReason(refused)).toContain("active tools changed");
      expect(status(root).phase).toBe("failed");
      expect(status(root).failure).toContain("active tools changed");
      expect(status(root).instances).toEqual([]);
    } finally {
      native.inspectCall = originalInspect;
    }
  });

  test("an inspection failure is observation unavailability and never blocks a valid admission", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "inspection unavailable request");
    const native = root.entry.nativeEntry;
    const originalInspect = native.inspectCall;
    try {
      native.inspectCall = () => {
        throw new Error("synthetic inspection failure");
      };
      const result = await root.host.task("task-inspect-unavailable", { agent: "alpha", task: "inspection unavailable" });
      expect(blockedReason(result)).toBe("");
      const admitted = records(root)[0]!;
      expect(admitted.phase).toBe("admitted");
      expect(admitted.observation.work.capture).toBe("captured");
      expect(admitted.observation.work.hook).toBe("tool_call");
      expect(admitted.observation.work.inspection).toBeNull();
      expect(admitted.observation.work.error).toContain("synthetic inspection failure");
      expect(status(root).phase).toBe("ready");
    } finally {
      native.inspectCall = originalInspect;
    }
  });

  test("getStatus only replays the last hook observation and navigation marks it unavailable", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "status request");
    await admit(root, "task-status-observe");
    root.host.lifecycle({ status: "started", id: "StatusObsChild", parentToolCallId: "task-status-observe", index: 0, agent: "alpha" });
    await startChild(root, "task-status-observe", "StatusObsChild", { lifecycle: false });
    const first = status(root);
    const second = status(root);
    expect(second).not.toBe(first);
    expect(second.instances[0]!.observation.work.hook).toBe("tool_call");
    expect(second.instances[0]!.observation.work.inspection?.state).toBe("current");

    root.host.lifecycle({
      status: "completed",
      id: "StatusObsChild",
      parentToolCallId: "task-status-observe",
      index: 0,
      agent: "alpha",
    });
    expect(records(root)[0]!.observation.work.hook).toBe("tool_call");
    const afterLifecycle = status(root);
    expect(afterLifecycle.instances[0]!.observation.work.inspection?.state).toBe("current");

    await root.host.emit("agent_end", {});
    expect(records(root)[0]!.observation.work.hook).toBe("agent_end");
    expect(records(root)[0]!.observation.work.inspection?.state).toBe("ended");

    // The host may change the session UUID before navigation; explicit
    // invalidation must still prevent an apparent live current claim.
    root.host.sessionId = "session-after-navigation";
    await root.host.emit("session_switch", {});
    const closed = status(root);
    expect(closed.phase).toBe("closed");
    expect(closed.instances[0]!.observation.work.inspection).toBeNull();
    expect(closed.instances[0]!.observation.work.invalidatedReason).not.toBeNull();
  });

  test("duplicate, mutated, conflicting and unavailable result observations stay bounded and sticky", async () => {
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const root = await startRoot({ children: [alpha] });
    await beginWork(root, "result request");
    await admit(root, "task-result");
    root.host.lifecycle({ status: "started", id: "ResultChild", parentToolCallId: "task-result", index: 0, agent: "alpha" });
    await startChild(root, "task-result", "ResultChild", { lifecycle: false });

    const original = taskResultEvent("task-result", "ResultChild", "alpha", { output: "original output" });
    const pristine = structuredClone(original);
    await root.host.emit("tool_result", original);
    const first = records(root)[0]!.observation.result.observation!;
    expect(first.state).toBe("observed");
    expect(first.output?.excerpt).toBe("original output");
    expect(first.conflict).toBeNull();

    await root.host.emit("tool_result", structuredClone(pristine));
    const duplicate = records(root)[0]!.observation.result.observation!;
    expect(duplicate.state).toBe("observed");
    expect(duplicate.envelope.sha256).toBe(first.envelope.sha256);
    expect(duplicate.conflict).toBeNull();

    // Mutation of the emitted object must not alias the retained snapshot.
    (original.content as { text: string }[])[0]!.text = "MUTATED OUTPUT";
    ((original.details as { results: { output: string }[] }).results[0]!).output = "MUTATED OUTPUT";
    expect(JSON.stringify(status(root))).not.toContain("MUTATED OUTPUT");
    expect(records(root)[0]!.observation.result.observation?.output?.excerpt).toBe("original output");

    await root.host.emit("tool_result", original);
    const conflicted = records(root)[0]!.observation.result.observation!;
    expect(conflicted.state).toBe("conflicted");
    expect(conflicted.reason).toBe("observation-conflict");
    expect(conflicted.conflict?.reason).toBe("envelope-digest-mismatch");
    expect(conflicted.output?.excerpt).toBe("original output");

    await root.host.emit("tool_result", pristine);
    const stillConflicted = records(root)[0]!.observation.result.observation!;
    expect(stillConflicted.state).toBe("conflicted");
    expect(stillConflicted.conflict?.reason).toBe("envelope-digest-mismatch");

    // An unavailable first observation is also never rehabilitated.
    await admit(root, "task-unavailable-result");
    await root.host.emit("tool_result", {
      toolCallId: "task-unavailable-result",
      toolName: "task",
      content: [],
      isError: true,
    });
    const unavailable = records(root)[1]!.observation.result.observation!;
    expect(unavailable.state).toBe("unavailable");
    expect(unavailable.reason).toBe("details-missing");
    await root.host.emit("tool_result", taskResultEvent("task-unavailable-result", null, "alpha", {
      isError: true,
      exitCode: 1,
    }));
    const stillUnavailable = records(root)[1]!.observation.result.observation!;
    expect(stillUnavailable.state).toBe("unavailable");
    expect(stillUnavailable.reason).toBe("details-missing");
  });

  test("lifecycle terminal evidence is retained when a later status overwrites the visible lifecycle", async () => {
    const root = await startRoot();
    await admit(root, "task-terminal-evidence");
    root.host.lifecycle({
      status: "started",
      id: "EvidenceChild",
      parentToolCallId: "task-terminal-evidence",
      index: 0,
      agent: "alpha",
    });
    root.host.lifecycle({
      status: "completed",
      id: "EvidenceChild",
      parentToolCallId: "task-terminal-evidence",
      index: 0,
      agent: "alpha",
    });
    root.host.lifecycle({
      status: "aborted",
      id: "EvidenceChild",
      parentToolCallId: "task-terminal-evidence",
      index: 0,
      agent: "alpha",
    });
    const record = records(root)[0]!;
    expect(record.lifecycle).toBe("aborted");
    expect(record.lifecycleTerminal).toBe(true);
    expect(record.observation.lifecycleEvidence).toEqual({ completed: true, failed: false, aborted: true });
    expect(record.observation.conflict).toBeNull();
  });

  test("a throwing event reflection becomes explicit observation unavailability without gating", async () => {
    const root = await startRoot();
    await admit(root, "task-reflection");
    const reflected = new Proxy({}, {
      get(target, property) {
        if (property === "toolName") return "task";
        if (property === "toolCallId") return "task-reflection";
        return Reflect.get(target, property);
      },
      getOwnPropertyDescriptor() {
        throw new Error("synthetic reflection failure");
      },
    });
    const handler = root.host.handlers.get("tool_result")?.at(-1);
    if (handler === undefined) throw new Error("tool_result handler is missing");
    await handler(reflected, root.host.context);
    const record = records(root)[0]!;
    expect(record.observation.result.observation?.state).toBe("unavailable");
    expect(record.observation.result.observation?.reason).toBe("event-unreadable");
    expect(record.observation.result.error).toBeNull();
    expect(status(root).phase).toBe("ready");
  });
});


/** Context read count inside the selected report's final refresh/live checks. */
const LATE_REPORT_CONTEXT_READ = 56;

function reentrantContext(
  real: InstancedNativeContext,
  atRead: number,
  effect: () => void,
): { readonly context: InstancedNativeContext; fired(): boolean } {
  let count = 0;
  let didFire = false;
  const context = new Proxy({} as InstancedNativeContext, {
    get(_target, property) {
      count += 1;
      if (!didFire && count === atRead) {
        didFire = true;
        effect();
      }
      return (real as unknown as Record<PropertyKey, unknown>)[property];
    },
  });
  return { context, fired: () => didFire };
}

describe("C2 fixed instance report port", () => {
  test("reports one selector after real Role and Skill gates plus normal child close", async () => {
    const fixture = await reportFixture({ close: true });
    const record = records(fixture.root)[0]!;
    expect(record.roleGate).toBe("verified");
    expect(record.skillGate).toBe("verified");
    expect(record.roleRefusalCode).toBeNull();
    expect(record.skillRefusalCode).toBeNull();
    expect(record.phase).toBe("closed");
    const observation = record.observation.result.observation!;
    expect(observation.state).toBe("observed");
    expect(observation.reason).toBe("observed-envelope");
    expect(observation.link).toBe("instance");
    expect(observation.outcome).toBe("completed-envelope");

    const inspected = await inspectWork(fixture.root, "inspect-success");
    const catalog = inspected.instanceResults;
    expect(catalog.state).toBe("available");
    const row = catalogRow(catalog, fixture.call);
    expect(row.available).toBe(true);
    expect(row.envelopeSha256).toBe(observation.envelope.sha256);

    const result = await selectedReport(
      fixture.root,
      selectedReportParams(row),
      { toolCallId: "report-verified-closed" },
    );
    expect(result.isError).not.toBe(true);
    const details = result.details as Record<string, any>;
    expect(details.instanceResult).toMatchObject({
      result: {
        instanceId: row.instanceId,
        parentToolCallId: fixture.call,
        index: 0,
        childId: fixture.childId,
        childSessionId: `session-${fixture.childId}`,
        agentName: "alpha",
        parentSessionId: "session-root",
        workspaceRoot: WORKSPACE,
        rootEpoch: 0,
        definitionVersion: "alpha-v1",
      },
      work: {
        observationId: (inspected.current as Record<string, any>).observationId,
        generation: (inspected.current as Record<string, any>).generation,
        sessionId: "session-root",
        workspaceRoot: WORKSPACE,
        toolCallId: fixture.call,
        toolName: "task",
      },
      envelope: {
        sha256: row.envelopeSha256,
        bytes: observation.envelope.bytes,
        scope: "tool-result-middleware",
      },
      artifactBasis: "observed-during-report",
      semanticAcceptance: "not-evaluated",
    });
    expect(details.observed.outputFiles).toEqual([]);

    // Direct status remains a stored replay: it neither refreshes nor mutates
    // the C1 observation or the recorded report.
    const before = JSON.stringify(records(fixture.root)[0]!.observation);
    fixture.root.entry.getStatus();
    expect(JSON.stringify(records(fixture.root)[0]!.observation)).toBe(before);
    expect((await inspectWork(fixture.root, "inspect-after-report")).current.report.recordedAt)
      .toBe(details.recordedAt);
  });

  test("a completed-shaped C1 envelope cannot replace missing Role or Skill verification", async () => {
    const fixture = await reportFixture({ verify: false, close: true });
    const record = records(fixture.root)[0]!;
    expect(record.roleGate).toBe("unobserved");
    expect(record.skillGate).toBe("unobserved");
    const catalog = await instanceCatalog(fixture.root);
    const row = catalogRow(catalog, fixture.call);
    expect(row.available).toBe(false);
    expect(row.reason).toContain("Role and Skill gates");
    const result = await selectedReport(fixture.root, selectedReportParams(row), {
      toolCallId: "report-unverified-gates",
    });
    expectReportRefused(result, /Role and Skill gates|No report was recorded/);
    expect((await inspectWork(fixture.root, "inspect-unverified-gates")).current.report ?? null).toBeNull();
  });

  test("two same-definition children keep distinct selectors and the v1 result stays v1 after v2", async () => {
    const alphaV1 = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const alphaV2 = childSnapshot("alpha", "ALPHA_BODY_V2", "alpha-v2");
    let current = alphaV1;
    const root = await startRoot({
      children: [alphaV1],
      loadChild: async () => current,
    });
    await beginWork(root, "two child report request");
    await admit(root, "task-child-a");
    const childA = await startChild(root, "task-child-a", "ChildA");
    await childA.host.prompt(childPrompt(alphaV1.definition.body));
    await childA.host.emitContext([]);
    root.host.lifecycle({
      status: "completed",
      id: "ChildA",
      parentToolCallId: "task-child-a",
      index: 0,
      agent: "alpha",
    });
    await root.host.emit("tool_result", taskResultEvent("task-child-a", "ChildA", "alpha", {
      output: "child A output",
    }));

    current = alphaV2;
    await admit(root, "task-child-b");
    const childB = await startChild(root, "task-child-b", "ChildB");
    await childB.host.prompt(childPrompt(alphaV2.definition.body));
    await childB.host.emitContext([]);
    root.host.lifecycle({
      status: "completed",
      id: "ChildB",
      parentToolCallId: "task-child-b",
      index: 0,
      agent: "alpha",
    });
    await root.host.emit("tool_result", taskResultEvent("task-child-b", "ChildB", "alpha", {
      output: "child B output",
    }));

    const instances = records(root);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.childId).toBe("ChildA");
    expect(instances[1]!.childId).toBe("ChildB");
    expect(instances[0]!.version).toBe("alpha-v1");
    expect(instances[1]!.version).toBe("alpha-v2");
    expect(instances[0]!.roleGate).toBe("verified");
    expect(instances[1]!.roleGate).toBe("verified");
    expect(instances[0]!.skillGate).toBe("verified");
    expect(instances[1]!.skillGate).toBe("verified");

    const catalog = await instanceCatalog(root);
    const rowA = catalogRow(catalog, "task-child-a");
    const rowB = catalogRow(catalog, "task-child-b");
    expect(rowA.instanceId).not.toBe(rowB.instanceId);
    expect(rowA.available).toBe(true);
    expect(rowB.available).toBe(true);
    expect(rowA.envelopeSha256).not.toBe(rowB.envelopeSha256);

    const result = await selectedReport(root, selectedReportParams(rowA), {
      toolCallId: "report-v1-after-v2",
    });
    expect(result.isError).not.toBe(true);
    const facts = (result.details as Record<string, any>).instanceResult;
    expect(facts.result.childId).toBe("ChildA");
    expect(facts.result.definitionVersion).toBe("alpha-v1");
    expect(facts.envelope.sha256).toBe(rowA.envelopeSha256);
    expect(facts.result.instanceId).toBe(instances[0]!.id);
  });

  test("refuses absent, unavailable, call-only, failed and aborted C1 observations", async () => {
    const unavailableEvent = {
      toolCallId: "task-report",
      toolName: "task",
      content: [],
      isError: true,
    };
    const cases: {
      readonly name: string;
      readonly options: Parameters<typeof reportFixture>[0];
    }[] = [
      { name: "absent", options: { result: false } },
      { name: "unavailable", options: { resultEvent: unavailableEvent } },
      {
        name: "call-only",
        options: { resultEvent: taskResultEvent("task-report", null, "alpha") },
      },
      {
        name: "failed",
        options: { result: { isError: true, exitCode: 1, error: "child failed" } },
      },
      { name: "aborted", options: { result: { aborted: true } } },
    ];
    for (const item of cases) {
      const fixture = await reportFixture(item.options);
      const catalog = await instanceCatalog(fixture.root);
      const row = catalogRow(catalog, fixture.call);
      expect(row.available).toBe(false);
      expect(row.reason).toBeTruthy();
      const params = selectedReportParams({
        ...row,
        envelopeSha256: row.envelopeSha256 ?? "0".repeat(64),
      });
      const result = await selectedReport(fixture.root, params, {
        toolCallId: `report-refused-${item.name}`,
      });
      expectReportRefused(result, /No report was recorded/);
      const after = await inspectWork(fixture.root, `inspect-refused-${item.name}`);
      expect(after.current.report ?? null).toBeNull();
      fixture.root.entry.dispose();
    }
  });

  test("refuses unknown call, instance and digest selectors plus a foreign main context", async () => {
    const fixture = await reportFixture({ close: true });
    const catalog = await instanceCatalog(fixture.root);
    const row = catalogRow(catalog, fixture.call);
    const valid = selectedReportParams(row);

    const wrongParent = {
      ...valid,
      instanceResult: {
        ...(valid.instanceResult as Record<string, unknown>),
        parentToolCallId: "task-unknown",
      },
    };
    expectReportRefused(
      await selectedReport(fixture.root, wrongParent, { toolCallId: "report-wrong-parent" }),
      /must be selected in checks|No report was recorded/,
    );

    const wrongInstance = {
      ...valid,
      instanceResult: {
        ...(valid.instanceResult as Record<string, unknown>),
        instanceId: "instance-unknown",
      },
    };
    expectReportRefused(
      await selectedReport(fixture.root, wrongInstance, { toolCallId: "report-wrong-instance" }),
      /no retained instance record|No report was recorded/,
    );

    const wrongDigest = {
      ...valid,
      instanceResult: {
        ...(valid.instanceResult as Record<string, unknown>),
        envelopeSha256: "1".repeat(64),
      },
    };
    expectReportRefused(
      await selectedReport(fixture.root, wrongDigest, { toolCallId: "report-wrong-digest" }),
      /does not match|No report was recorded/,
    );

    expectReportRefused(
      await selectedReport(fixture.root, valid, {
        toolCallId: "report-foreign-main",
        context: ownerContext({ agentId: "OtherMain" }),
      }),
      /actual main agent|owner|No report was recorded/,
    );
    expect((await inspectWork(fixture.root, "inspect-after-bad-selectors")).current.report ?? null).toBeNull();
  });

  test("identical canonical C1 duplicates replay the receipt, later conflicts refuse history", async () => {
    const fixture = await reportFixture({ close: true });
    const catalog = await instanceCatalog(fixture.root, "inspect-replay");
    const row = catalogRow(catalog, fixture.call);
    const params = selectedReportParams(row);
    const original = await selectedReport(fixture.root, params, {
      toolCallId: "report-replay-original",
    });
    expect(original.isError).not.toBe(true);
    const originalDetails = original.details as Record<string, any>;
    const frozen = records(fixture.root)[0]!.observation.result.observation;

    await fixture.root.host.emit("tool_result", taskResultEvent(fixture.call, fixture.childId, "alpha"));
    expect(records(fixture.root)[0]!.observation.result.observation).toBe(frozen);
    const replay = await selectedReport(fixture.root, params, {
      toolCallId: "report-replay-identical",
    });
    expect(replay.isError).not.toBe(true);
    const replayDetails = replay.details as Record<string, any>;
    expect(replayDetails.recordedAt).toBe(originalDetails.recordedAt);
    expect(replayDetails.instanceResult).toEqual(originalDetails.instanceResult);

    await fixture.root.host.emit("tool_result", taskResultEvent(fixture.call, fixture.childId, "alpha", {
      output: "changed after publication",
    }));
    const conflicted = records(fixture.root)[0]!.observation.result.observation!;
    expect(conflicted.state).toBe("conflicted");
    expect(conflicted).not.toBe(frozen);
    expectReportRefused(
      await selectedReport(fixture.root, params, { toolCallId: "report-replay-after-conflict" }),
      /conflict|No report was recorded/,
    );
    expect((await inspectWork(fixture.root, "inspect-after-conflict")).current.report.recordedAt)
      .toBe(originalDetails.recordedAt);
  });

  test("new identical input, unknown source and ended work refuse without publication", async () => {
    const pendingFixture = await reportFixture({ close: true });
    const pendingCatalog = await instanceCatalog(pendingFixture.root, "inspect-pending");
    const pendingRow = catalogRow(pendingCatalog, pendingFixture.call);
    await pendingFixture.root.host.input("report fixture request", { source: "interactive" });
    expectReportRefused(
      await selectedReport(pendingFixture.root, selectedReportParams(pendingRow), {
        toolCallId: "report-pending-identical-input",
      }),
      /pending|input|No report was recorded/,
    );
    expect((await inspectWork(pendingFixture.root, "inspect-pending-after")).current.report ?? null).toBeNull();
    pendingFixture.root.entry.dispose();

    const unknownFixture = await reportFixture({ close: true, workSource: "plugin" });
    const unknownCatalog = await instanceCatalog(unknownFixture.root, "inspect-unknown-source");
    expect(unknownCatalog.state).toBe("unavailable");
    expect(unknownCatalog.total).toBeNull();
    const unknownRecord = records(unknownFixture.root)[0]!;
    const unknownObservation = unknownRecord.observation.result.observation!;
    expectReportRefused(
      await selectedReport(unknownFixture.root, {
        action: "report",
        checks: [{ toolCallId: unknownFixture.call, purpose: "delegated work" }],
        outputFiles: [],
        outcome: "completed",
        instanceResult: {
          instanceId: unknownRecord.id,
          parentToolCallId: unknownFixture.call,
          envelopeSha256: unknownObservation.envelope.sha256,
        },
      }, { toolCallId: "report-unknown-source" }),
      /source|evidence|work|No report was recorded/,
    );
    unknownFixture.root.entry.dispose();

    const endedFixture = await reportFixture({ close: true });
    const endedCatalog = await instanceCatalog(endedFixture.root, "inspect-ended");
    const endedRow = catalogRow(endedCatalog, endedFixture.call);
    await endedFixture.root.host.emit("agent_end", {});
    await endedFixture.root.host.input("replacement request", { source: "interactive" });
    await endedFixture.root.host.prepare("replacement request");
    expectReportRefused(
      await selectedReport(endedFixture.root, selectedReportParams(endedRow), {
        toolCallId: "report-after-work-reopen",
      }),
      /not retained|work|No report was recorded/,
    );
  });

  test("a late getter that closes the instance root or disposes the factory refuses publication", async () => {
    const closeFixture = await reportFixture({ close: true });
    const closeCatalog = await instanceCatalog(closeFixture.root, "inspect-reentry-close");
    const closeRow = catalogRow(closeCatalog, closeFixture.call);
    const closeTrigger = reentrantContext(
      closeFixture.root.host.context,
      LATE_REPORT_CONTEXT_READ,
      () => {
        const handler = closeFixture.root.host.handlers.get("session_shutdown")?.at(-1);
        if (handler === undefined) throw new Error("session_shutdown handler is missing");
        handler({}, closeFixture.root.host.context);
      },
    );
    expectReportRefused(
      await selectedReport(closeFixture.root, selectedReportParams(closeRow), {
        toolCallId: "report-reentry-root-close",
        context: closeTrigger.context,
      }),
      /disposed|root|No report was recorded/,
    );
    expect(closeTrigger.fired()).toBe(true);
    closeFixture.root.entry.dispose();

    const disposeFixture = await reportFixture({ close: true });
    const disposeCatalog = await instanceCatalog(disposeFixture.root, "inspect-reentry-dispose");
    const disposeRow = catalogRow(disposeCatalog, disposeFixture.call);
    const disposeTrigger = reentrantContext(
      disposeFixture.root.host.context,
      LATE_REPORT_CONTEXT_READ,
      () => disposeFixture.root.entry.dispose(),
    );
    expectReportRefused(
      await selectedReport(disposeFixture.root, selectedReportParams(disposeRow), {
        toolCallId: "report-reentry-dispose",
        context: disposeTrigger.context,
      }),
      /disposed|root|No report was recorded/,
    );
    expect(disposeTrigger.fired()).toBe(true);
  });

  test("a late getter that changes the frozen C1 result or lifecycle is refused by pure revalidation", async () => {
    const conflictFixture = await reportFixture({ close: true });
    const conflictCatalog = await instanceCatalog(conflictFixture.root, "inspect-reentry-c1");
    const conflictRow = catalogRow(conflictCatalog, conflictFixture.call);
    const frozen = records(conflictFixture.root)[0]!.observation.result.observation!;
    const conflictTrigger = reentrantContext(
      conflictFixture.root.host.context,
      LATE_REPORT_CONTEXT_READ,
      () => {
        const handler = conflictFixture.root.host.handlers.get("tool_result")?.at(-1);
        if (handler === undefined) throw new Error("tool_result handler is missing");
        handler(taskResultEvent(
          conflictFixture.call,
          conflictFixture.childId,
          "alpha",
          { output: "late conflicting result" },
        ), conflictFixture.root.host.context);
      },
    );
    expectReportRefused(
      await selectedReport(conflictFixture.root, selectedReportParams(conflictRow), {
        toolCallId: "report-reentry-c1-conflict",
        context: conflictTrigger.context,
      }),
      /changed|conflict|No report was recorded/,
    );
    expect(conflictTrigger.fired()).toBe(true);
    const conflicted = records(conflictFixture.root)[0]!.observation.result.observation!;
    expect(conflicted.state).toBe("conflicted");
    expect(conflicted).not.toBe(frozen);
    expect((await inspectWork(conflictFixture.root, "inspect-reentry-c1-after")).current.report ?? null).toBeNull();
    conflictFixture.root.entry.dispose();

    const lifecycleFixture = await reportFixture({ close: true });
    const lifecycleCatalog = await instanceCatalog(lifecycleFixture.root, "inspect-reentry-lifecycle");
    const lifecycleRow = catalogRow(lifecycleCatalog, lifecycleFixture.call);
    const lifecycleTrigger = reentrantContext(
      lifecycleFixture.root.host.context,
      LATE_REPORT_CONTEXT_READ,
      () => lifecycleFixture.root.host.lifecycle({
        status: "aborted",
        id: lifecycleFixture.childId,
        parentToolCallId: lifecycleFixture.call,
        index: 0,
        agent: "alpha",
      }),
    );
    expectReportRefused(
      await selectedReport(lifecycleFixture.root, selectedReportParams(lifecycleRow), {
        toolCallId: "report-reentry-lifecycle",
        context: lifecycleTrigger.context,
      }),
      /lifecycle|abort|No report was recorded/,
    );
    expect(lifecycleTrigger.fired()).toBe(true);
    expect(records(lifecycleFixture.root)[0]!.observation.lifecycleEvidence.aborted).toBe(true);
    expect((await inspectWork(lifecycleFixture.root, "inspect-reentry-lifecycle-after")).current.report ?? null).toBeNull();
  });
});

const HANDOFF_TASK_PREFIX = "Complete assignment thoroughly:\n\n";

async function tempWorkspace(): Promise<string> {
  return await realpath(await mkdtemp(path.join(tmpdir(), "omp-a22-")));
}

function isBlocked(value: unknown): value is { block: true; reason: string } {
  return isRecord(value) && value.block === true;
}

async function handoffCall(
  root: RootFixture,
  callId: string,
  params: Record<string, unknown>,
): Promise<NativeToolResult> {
  const preflight = await root.host.emit("tool_call", {
    toolCallId: callId,
    toolName: "agent_handoff",
    input: params,
  });
  if (isBlocked(preflight)) throw new Error(`handoff preflight blocked: ${preflight.reason}`);
  const tool = root.host.tools.get("agent_handoff");
  if (tool === undefined) throw new Error("agent_handoff was not registered");
  const result = await tool.execute(callId, params, new AbortController().signal, undefined, root.host.context);
  await root.host.emit("tool_result", {
    toolCallId: callId,
    toolName: "agent_handoff",
    input: params,
    content: result.content,
    isError: result.isError === true,
    details: result.details,
  });
  return result;
}

function details(result: NativeToolResult): Record<string, any> {
  if (result.isError === true) {
    throw new Error(`tool failed: ${String((result.content[0] as { text?: string } | undefined)?.text ?? "")}`);
  }
  return result.details as Record<string, any>;
}

function snapshotDetails(result: NativeToolResult): Record<string, any> {
  if (result.isError === true) {
    throw new Error(`snapshot tool failed: ${String((result.content[0] as { text?: string } | undefined)?.text ?? "")}`);
  }
  const text = (result.content[0] as { text?: string } | undefined)?.text;
  if (typeof text !== "string") throw new Error("snapshot result has no text payload");
  return JSON.parse(text) as Record<string, any>;
}

async function snapshotCall(
  child: ChildFixture,
  callId: string,
  params: Record<string, unknown>,
): Promise<NativeToolResult> {
  const preflight = await child.host.emit("tool_call", {
    toolCallId: callId,
    toolName: "agent_snapshot",
    input: params,
  });
  if (isBlocked(preflight)) throw new Error(`snapshot preflight blocked: ${preflight.reason}`);
  const tool = child.host.tools.get("agent_snapshot");
  if (tool === undefined) throw new Error("agent_snapshot was not registered");
  const result = await tool.execute(callId, params, new AbortController().signal, undefined, child.host.context);
  await child.host.emit("tool_result", {
    toolCallId: callId,
    toolName: "agent_snapshot",
    input: params,
    content: result.content,
    isError: result.isError === true,
    details: result.details,
  });
  return result;
}

function handoffTaskResult(
  call: string,
  childId: string,
  agent: string,
  task: string,
  output: string,
): Record<string, unknown> {
  return {
    toolCallId: call,
    toolName: "task",
    input: { agent, task },
    content: [{ type: "text", text: output }],
    isError: false,
    details: {
      results: [{
        index: 0,
        id: childId,
        agent,
        exitCode: 0,
        aborted: false,
        truncated: false,
        output,
      }],
    },
  };
}

async function admitHandoffTask(
  root: RootFixture,
  call: string,
  task: string,
): Promise<void> {
  const result = await root.host.task(call, { agent: "alpha", task });
  if (isBlocked(result)) throw new Error(`handoff task blocked: ${result.reason}`);
}

async function handoffChild(
  root: RootFixture,
  call: string,
  childId: string,
  task: string,
): Promise<ChildFixture> {
  return await handoffChildPrompt(root, call, childId, HANDOFF_TASK_PREFIX + task);
}

async function handoffChildPrompt(
  root: RootFixture,
  call: string,
  childId: string,
  prompt: string,
  contextPrompt = prompt,
): Promise<ChildFixture> {
  const child = await startChild(root, call, childId, {
    activeTools: ["read", "agent_snapshot"],
  });
  const body = root.children[0]!.definition.body;
  await child.host.emit("before_agent_start", {
    reason: "prompt",
    prompt,
    systemPrompt: childPrompt(body),
  });
  await child.host.emit("context", {
    messages: [{ role: "user", content: contextPrompt }],
  });
  return child;
}

function statusRecord(root: RootFixture, call: string): InstancedEntryStatus["instances"][number] {
  const record = records(root).find((entry) => entry.parentToolCallId === call);
  if (record === undefined) throw new Error(`no status record for ${call}`);
  return record;
}

function envelopeSha(record: InstancedEntryStatus["instances"][number]): string {
  const value = record.observation.result.observation?.envelope.sha256;
  if (typeof value !== "string") throw new Error("no observed envelope sha");
  return value;
}

function producerSelector(record: InstancedEntryStatus["instances"][number]): Record<string, string> {
  return {
    instanceId: record.id,
    parentToolCallId: record.parentToolCallId,
    envelopeSha256: envelopeSha(record),
  };
}

interface HandoffBase {
  readonly workspace: string;
  readonly root: RootFixture;
  readonly alphaBody: string;
  readonly producerCall: string;
  readonly producerChildId: string;
  readonly captureId: string;
  readonly offerId: string;
  cleanup(): Promise<void>;
}

/**
 * One ordinary source producer, its actual observed result, and an initial
 * capture/offer produced by the registered main tool. IDs below always come
 * from these actual outputs; no core handle or private token is manufactured.
 */
async function handoffBase(options: {
  readonly loadChild?: (input: InstancedChildSnapshotInput) => Promise<DefinitionSnapshot>;
  readonly fileStatus?: "pass" | "fail";
} = {}): Promise<HandoffBase> {
  const workspace = await tempWorkspace();
  const tools = ["read", "task", "agent_handoff", "agent_snapshot"];
  const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
    tools: ["read", "agent_snapshot"],
    workspace,
  });
  const root = await startRoot({
    workspace,
    main: mainSnapshot(workspace, tools),
    children: [alpha],
    mainTools: tools,
    hostActiveTools: tools,
    ...(options.loadChild === undefined ? {} : { loadChild: options.loadChild }),
  });
  await writeFile(
    path.join(workspace, "data.json"),
    `${JSON.stringify({ status: options.fileStatus ?? "pass" })}\n`,
    "utf8",
  );
  await root.host.input("handoff work", { source: "interactive" });
  await root.host.prepare("handoff work");
  const producerCall = "task-producer";
  const producerChildId = "ChildProducer";
  await admit(root, producerCall, "alpha", "produce handoff source");
  const producer = await startChild(root, producerCall, producerChildId, {
    activeTools: ["read", "agent_snapshot"],
  });
  await producer.host.prompt(childPrompt(alpha.definition.body));
  await producer.host.emitContext([]);
  await root.host.emit("tool_result", handoffTaskResult(
    producerCall,
    producerChildId,
    "alpha",
    "produce handoff source",
    "producer output",
  ));
  root.host.lifecycle({
    status: "completed",
    id: producerChildId,
    parentToolCallId: producerCall,
    index: 0,
    agent: "alpha",
  });
  await producer.host.emit("session_shutdown", {});
  const capture = details(await handoffCall(root, "handoff-capture-base", {
    action: "capture",
    producer: producerSelector(statusRecord(root, producerCall)),
    relativePath: "data.json",
    conditions: [{ id: "status", kind: "json-equals", pointer: "/status", value: "pass" }],
  }));
  return {
    workspace,
    root,
    alphaBody: alpha.definition.body,
    producerCall,
    producerChildId,
    captureId: capture.captureId as string,
    offerId: capture.offerId as string,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

async function publishHandoffOffer(
  root: RootFixture,
  callId: string,
  captureId: string,
): Promise<string> {
  const offer = details(await handoffCall(root, callId, { action: "offer", captureId }));
  return offer.offerId as string;
}

async function completeHandoffConsumer(
  root: RootFixture,
  options: {
    readonly call: string;
    readonly childId: string;
    readonly offerId: string;
    readonly task: string;
    readonly receiptCall: string;
    readonly checkCall: string;
    readonly output: string;
  },
): Promise<{ readonly child: ChildFixture; readonly receiptId: string }> {
  const admitted = await root.host.task(options.call, { agent: "alpha", task: options.task });
  if (isBlocked(admitted)) throw new Error(`handoff consumer blocked: ${admitted.reason}`);
  const child = await handoffChild(root, options.call, options.childId, options.task);
  const receipt = snapshotDetails(await snapshotCall(child, options.receiptCall, {
    action: "check",
    offerId: options.offerId,
  }));
  await root.host.emit("tool_result", handoffTaskResult(
    options.call,
    options.childId,
    "alpha",
    options.task,
    options.output,
  ));
  root.host.lifecycle({
    status: "completed",
    id: options.childId,
    parentToolCallId: options.call,
    index: 0,
    agent: "alpha",
  });
  await child.host.emit("session_shutdown", {});
  return { child, receiptId: receipt.receiptId as string };
}

describe("actual instanced handoff composition", () => {
  test("registered main/child tools close capture, read, FAIL repair, PASS adoption, report and sticky preflight refusal", async () => {
    const workspace = await tempWorkspace();
    try {
      const tools = ["read", "task", "agent_handoff", "agent_snapshot"];
      const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
        tools: ["read", "agent_snapshot"],
        workspace,
      });
      const root = await startRoot({
        workspace,
        main: mainSnapshot(workspace, tools),
        children: [alpha],
        mainTools: tools,
        hostActiveTools: tools,
      });
      expect(root.host.tools.get("agent_handoff")?.defaultInactive).toBe(true);
      expect(root.host.tools.get("agent_snapshot")?.defaultInactive).toBe(true);
      await writeFile(path.join(workspace, "data.json"), '{"status":"fail"}\n', "utf8");
      await root.host.input("handoff work", { source: "interactive" });
      await root.host.prepare("handoff work");

      // Ordinary producer instance: stable token exists even without an offer.
      await admit(root, "task-producer", "alpha", "produce v1");
      const producer = await startChild(root, "task-producer", "ChildProducer", {
        activeTools: ["read", "agent_snapshot"],
      });
      await producer.host.prompt(childPrompt(alpha.definition.body));
      await producer.host.emitContext([]);
      await root.host.emit("tool_result", handoffTaskResult(
        "task-producer",
        "ChildProducer",
        "alpha",
        "produce v1",
        "producer v1 output",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildProducer",
        parentToolCallId: "task-producer",
        index: 0,
        agent: "alpha",
      });
      await producer.host.emit("session_shutdown", {});

      const producerRow = statusRecord(root, "task-producer");
      const capture = details(await handoffCall(root, "handoff-capture-v1", {
        action: "capture",
        producer: producerSelector(producerRow),
        relativePath: "data.json",
        conditions: [{ id: "status", kind: "json-equals", pointer: "/status", value: "pass" }],
      }));
      expect(typeof capture.captureId).toBe("string");
      expect(typeof capture.offerId).toBe("string");
      const captureV1 = capture.captureId as string;
      const offerV1 = capture.offerId as string;

      // Native call result is observed; the same original ref still replays
      // its cached handoff result.
      const captureReplay = details(await handoffCall(root, "handoff-capture-v1", {
        action: "capture",
        producer: producerSelector(producerRow),
        relativePath: "data.json",
        conditions: [{ id: "status", kind: "json-equals", pointer: "/status", value: "pass" }],
      }));
      expect(captureReplay.captureId).toBe(captureV1);

      const testerTask = `OMP_HANDOFF_REF_V1 ${offerV1}\nCheck the captured file.`;
      await admitHandoffTask(root, "task-tester-1", testerTask);
      const tester1 = await handoffChild(root, "task-tester-1", "ChildTester1", testerTask);
      const failReceipt = snapshotDetails(await snapshotCall(tester1, "snapshot-check-fail", {
        action: "check",
        offerId: offerV1,
      }));
      await root.host.emit("tool_result", handoffTaskResult(
        "task-tester-1",
        "ChildTester1",
        "alpha",
        testerTask,
        "FAIL result",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildTester1",
        parentToolCallId: "task-tester-1",
        index: 0,
        agent: "alpha",
      });
      await tester1.host.emit("session_shutdown", {});
      const failAdoption = details(await handoffCall(root, "handoff-adopt-fail", {
        action: "adopt",
        receiptId: failReceipt.receiptId,
        captureId: captureV1,
        consumerParentToolCallId: "task-tester-1",
      }));
      expect(failAdoption.outcome).toBe("fail");

      const repairOffer = details(await handoffCall(root, "handoff-offer-repair", {
        action: "offer",
        captureId: captureV1,
        failAdoptionId: failAdoption.adoptionId,
      }));
      const offerRepair = repairOffer.offerId as string;
      const repairTask = `OMP_HANDOFF_REF_V1 ${offerRepair}\nRead the old snapshot, update the file, then return.`;
      await admitHandoffTask(root, "task-repair", repairTask);
      const repairChild = await handoffChild(root, "task-repair", "ChildRepair", repairTask);
      const read = snapshotDetails(await snapshotCall(repairChild, "snapshot-read-repair", {
        action: "read",
        offerId: offerRepair,
      }));
      expect(typeof read.readId).toBe("string");
      await writeFile(path.join(workspace, "data.json"), '{"status":"pass"}\n', "utf8");
      await root.host.emit("tool_result", handoffTaskResult(
        "task-repair",
        "ChildRepair",
        "alpha",
        repairTask,
        "repair result",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildRepair",
        parentToolCallId: "task-repair",
        index: 0,
        agent: "alpha",
      });
      await repairChild.host.emit("session_shutdown", {});
      const repairRow = statusRecord(root, "task-repair");
      const repairCapture = details(await handoffCall(root, "handoff-capture-v2", {
        action: "capture",
        producer: producerSelector(repairRow),
        fromOfferId: offerRepair,
      }));
      const captureV2 = repairCapture.captureId as string;
      const offerV2 = repairCapture.offerId as string;
      expect(captureV2).not.toBe(captureV1);

      // The old V1 receipt cannot be adopted against the V2 capture.
      const oldReceiptResult = await handoffCall(root, "handoff-adopt-old-receipt", {
        action: "adopt",
        receiptId: failReceipt.receiptId,
        captureId: captureV2,
        consumerParentToolCallId: "task-tester-1",
      });
      expect(oldReceiptResult.isError).toBe(true);

      const testerTask2 = `OMP_HANDOFF_REF_V1 ${offerV2}\nCheck the repaired file.`;
      await admitHandoffTask(root, "task-tester-2", testerTask2);
      const tester2 = await handoffChild(root, "task-tester-2", "ChildTester2", testerTask2);
      const passReceipt = snapshotDetails(await snapshotCall(tester2, "snapshot-check-pass", {
        action: "check",
        offerId: offerV2,
      }));
      await root.host.emit("tool_result", handoffTaskResult(
        "task-tester-2",
        "ChildTester2",
        "alpha",
        testerTask2,
        "PASS result",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildTester2",
        parentToolCallId: "task-tester-2",
        index: 0,
        agent: "alpha",
      });
      await tester2.host.emit("session_shutdown", {});
      const passAdoption = details(await handoffCall(root, "handoff-adopt-pass", {
        action: "adopt",
        receiptId: passReceipt.receiptId,
        captureId: captureV2,
        consumerParentToolCallId: "task-tester-2",
      }));
      expect(passAdoption.outcome).toBe("pass");

      const repairRowAfter = statusRecord(root, "task-repair");
      const reportParams = {
        action: "report",
        checks: [{ toolCallId: "task-repair", purpose: "delegated repair" }],
        outputFiles: ["data.json"],
        outcome: "completed",
        instanceResult: {
          instanceId: repairRowAfter.id,
          parentToolCallId: "task-repair",
          envelopeSha256: envelopeSha(repairRowAfter),
        },
        handoffAdoptionId: passAdoption.adoptionId,
      };
      const report = await selectedReport(root, reportParams, { toolCallId: "report-handoff-pass" });
      const reportDetails = details(report);
      expect(reportDetails.instanceResult?.handoff?.adoption?.outcome).toBe("pass");

      // Reading the same adopted call's input reflectively must sticky-fail
      // the existing preflight instead of escaping to the outer hook catch.
      const toolCallHandler = root.host.handlers.get("tool_call")?.at(-1);
      if (toolCallHandler === undefined) throw new Error("tool_call handler is missing");
      const throwingInput = {
        toolCallId: "handoff-adopt-pass",
        toolName: "agent_handoff",
        get input(): never {
          throw new Error("synthetic input read failure");
        },
      };
      const reflected = await toolCallHandler(throwingInput, root.host.context);
      expect(isBlocked(reflected)).toBe(true);
      expect(blockedReason(reflected)).toMatch(/unreadable input/i);
      const reflectedReport = await selectedReport(root, reportParams, {
        toolCallId: "report-handoff-reflected-input",
      });
      expect(reflectedReport.isError).toBe(true);

      // A later same-call parameter conflict is sticky and invalidates the
      // original adoption for any final report.
      const conflict = await root.host.emit("tool_call", {
        toolCallId: "handoff-adopt-pass",
        toolName: "agent_handoff",
        input: {
          action: "adopt",
          receiptId: "other-receipt",
          captureId: "other-capture",
          consumerParentToolCallId: "other-consumer",
          unknownField: true,
        },
      });
      expect(isBlocked(conflict)).toBe(true);
      const refusedReport = await selectedReport(root, reportParams, {
        toolCallId: "report-handoff-sticky",
      });
      expect(refusedReport.isError).toBe(true);
      expect(String((refusedReport.content[0] as { text?: string } | undefined)?.text ?? ""))
        .toMatch(/preflight|failed|No report was recorded/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  test("a source producer that fails during async definition load cannot bind a later offer consumption", async () => {
    const workspace = await tempWorkspace();
    try {
      const tools = ["read", "task", "agent_handoff", "agent_snapshot"];
      const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
        tools: ["read", "agent_snapshot"],
        workspace,
      });
      const byPath = new Map([[alpha.definition.requestedPath, alpha]]);
      let delay = false;
      let startedResolve!: () => void;
      let releaseResolve!: () => void;
      const started = new Promise<void>((resolve) => { startedResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const loadChild = async (input: InstancedChildSnapshotInput): Promise<DefinitionSnapshot> => {
        if (delay) {
          startedResolve();
          await release;
        }
        const snapshot = byPath.get(input.definitionPath);
        if (snapshot === undefined) throw new Error(`no fixture snapshot for ${input.definitionPath}`);
        return snapshot;
      };
      const root = await startRoot({
        workspace,
        main: mainSnapshot(workspace, tools),
        children: [alpha],
        mainTools: tools,
        hostActiveTools: tools,
        loadChild,
      });
      await writeFile(path.join(workspace, "data.json"), '{"status":"fail"}\n', "utf8");
      await root.host.input("handoff work", { source: "interactive" });
      await root.host.prepare("handoff work");

      await admit(root, "task-producer", "alpha", "produce v1");
      const producer = await startChild(root, "task-producer", "ChildProducer", {
        activeTools: ["read", "agent_snapshot"],
      });
      await producer.host.prompt(childPrompt(alpha.definition.body));
      await producer.host.emitContext([]);
      await root.host.emit("tool_result", handoffTaskResult(
        "task-producer",
        "ChildProducer",
        "alpha",
        "produce v1",
        "producer v1 output",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildProducer",
        parentToolCallId: "task-producer",
        index: 0,
        agent: "alpha",
      });
      await producer.host.emit("session_shutdown", {});
      const capture = details(await handoffCall(root, "handoff-capture-stale", {
        action: "capture",
        producer: producerSelector(statusRecord(root, "task-producer")),
        relativePath: "data.json",
        conditions: [{ id: "status", kind: "json-equals", pointer: "/status", value: "pass" }],
      }));
      const task = `OMP_HANDOFF_REF_V1 ${capture.offerId}\nCheck the file.`;

      delay = true;
      const pending = root.host.task("task-stale", { agent: "alpha", task });
      await started;
      // The source producer is ordinary (no handoffOffer), so this lifecycle
      // failure cannot invalidate through the consumer path. The reservation
      // must still reject at final bind.
      root.host.lifecycle({
        status: "failed",
        id: "ChildProducer",
        parentToolCallId: "task-producer",
        index: 0,
        agent: "alpha",
      });
      releaseResolve();
      const blocked = await pending;
      expect(isBlocked(blocked)).toBe(true);
      expect(blockedReason(blocked)).toMatch(/reservation local gate/i);
      expect(blockedReason(blocked)).toMatch(/lifecycle.*failure|failure or abort/i);
      const second = await root.host.task("task-stale-2", { agent: "alpha", task });
      expect(isBlocked(second)).toBe(true);
      expect(String((second as { reason?: string }).reason)).toMatch(/permanent|reservation|offer/i);
      expect(records(root).filter((record) => record.parentToolCallId === "task-stale")).toHaveLength(0);
      expect(records(root).filter((record) => record.parentToolCallId === "task-stale-2")).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  test("two async task admissions reserve one offer before loading; the loser and a failed load leave permanent failed reservations", async () => {
    let mode: "normal" | "hold" | "throw" = "normal";
    let loadCount = 0;
    let barrier: {
      readonly started: Promise<void>;
      readonly released: Promise<void>;
      start(): void;
      release(): void;
    } | null = null;
    const makeBarrier = () => {
      let started!: () => void;
      let release!: () => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      const releasedPromise = new Promise<void>((resolve) => { release = resolve; });
      return {
        started: startedPromise,
        released: releasedPromise,
        start: started,
        release,
      };
    };
    const workspace = await tempWorkspace();
    const tools = ["read", "task", "agent_handoff", "agent_snapshot"];
    const alpha = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
      tools: ["read", "agent_snapshot"],
      workspace,
    });
    const byPath = new Map([[alpha.definition.requestedPath, alpha]]);
    const root = await startRoot({
      workspace,
      main: mainSnapshot(workspace, tools),
      children: [alpha],
      mainTools: tools,
      hostActiveTools: tools,
      async loadChild(input: InstancedChildSnapshotInput): Promise<DefinitionSnapshot> {
        loadCount += 1;
        if (mode !== "normal") {
          if (barrier === null) throw new Error("loader barrier is missing");
          const active = barrier;
          active.start();
          await active.released;
          if (mode === "throw") throw new Error("synthetic definition load failure");
        }
        const snapshot = byPath.get(input.definitionPath);
        if (snapshot === undefined) throw new Error(`no fixture snapshot for ${input.definitionPath}`);
        return snapshot;
      },
    });
    try {
      await writeFile(path.join(workspace, "data.json"), '{"status":"pass"}\n', "utf8");
      await root.host.input("handoff work", { source: "interactive" });
      await root.host.prepare("handoff work");
      await admit(root, "task-producer", "alpha", "produce handoff source");
      const producer = await startChild(root, "task-producer", "ChildProducer", {
        activeTools: ["read", "agent_snapshot"],
      });
      await producer.host.prompt(childPrompt(alpha.definition.body));
      await producer.host.emitContext([]);
      await root.host.emit("tool_result", handoffTaskResult(
        "task-producer",
        "ChildProducer",
        "alpha",
        "produce handoff source",
        "producer output",
      ));
      root.host.lifecycle({
        status: "completed",
        id: "ChildProducer",
        parentToolCallId: "task-producer",
        index: 0,
        agent: "alpha",
      });
      await producer.host.emit("session_shutdown", {});
      const capture = details(await handoffCall(root, "handoff-capture-base", {
        action: "capture",
        producer: producerSelector(statusRecord(root, "task-producer")),
        relativePath: "data.json",
        conditions: [{ id: "status", kind: "json-equals", pointer: "/status", value: "pass" }],
      }));
      const offer = capture.offerId as string;
      const captureId = capture.captureId as string;
      const task = `OMP_HANDOFF_REF_V1 ${offer}\nCheck the competing offer.`;
      const before = loadCount;
      barrier = makeBarrier();
      mode = "hold";
      const first = root.host.task("task-compete-1", { agent: "alpha", task });
      await barrier.started;
      expect(loadCount).toBe(before + 1);
      const second = await root.host.task("task-compete-2", { agent: "alpha", task });
      expect(isBlocked(second)).toBe(true);
      expect(blockedReason(second)).toMatch(/already has a permanent consumption reservation/i);
      // The reservation is taken before definition loading, so the losing
      // admission never asks the loader for a snapshot.
      expect(loadCount).toBe(before + 1);
      const third = await root.host.task("task-compete-3", { agent: "alpha", task });
      expect(isBlocked(third)).toBe(true);
      expect(loadCount).toBe(before + 1);
      barrier.release();
      const firstResult = await first;
      expect(isBlocked(firstResult)).toBe(false);
      expect(records(root).filter((record) => record.parentToolCallId === "task-compete-1"))
        .toHaveLength(1);
      expect(records(root).filter((record) => record.parentToolCallId === "task-compete-2"))
        .toHaveLength(0);
      expect(records(root).filter((record) => record.parentToolCallId === "task-compete-3"))
        .toHaveLength(0);
      const afterBind = await root.host.task("task-compete-4", { agent: "alpha", task });
      expect(isBlocked(afterBind)).toBe(true);
      expect(loadCount).toBe(before + 1);

      // A late failing load never releases its reservation for reuse.
      const failedOffer = await publishHandoffOffer(root, "handoff-offer-failed-load", captureId);
      const failedTask = `OMP_HANDOFF_REF_V1 ${failedOffer}\nCheck the failed load offer.`;
      const failedBefore = loadCount;
      barrier = makeBarrier();
      mode = "throw";
      const failed = root.host.task("task-load-fail", { agent: "alpha", task: failedTask });
      await barrier.started;
      expect(loadCount).toBe(failedBefore + 1);
      barrier.release();
      const failedResult = await failed;
      expect(isBlocked(failedResult)).toBe(true);
      const retry = await root.host.task("task-load-retry", { agent: "alpha", task: failedTask });
      expect(isBlocked(retry)).toBe(true);
      expect(blockedReason(retry)).toMatch(/permanent|reservation/i);
      expect(loadCount).toBe(failedBefore + 1);
      expect(records(root).filter((record) => record.parentToolCallId === "task-load-fail"))
        .toHaveLength(0);
      expect(records(root).filter((record) => record.parentToolCallId === "task-load-retry"))
        .toHaveLength(0);
    } finally {
      mode = "normal";
      await rm(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  test("changed parent task result input invalidates its handoff receipt while a no-ref task still observes the changed input, and new work rejects the old offer", async () => {
    const base = await handoffBase();
    try {
      const secondOffer = await publishHandoffOffer(base.root, "handoff-offer-second", base.captureId);
      const consumerTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\nCheck changed input.`;
      const admitted = await base.root.host.task("task-input-consumer", { agent: "alpha", task: consumerTask });
      expect(isBlocked(admitted)).toBe(false);
      const child = await handoffChild(base.root, "task-input-consumer", "ChildInputConsumer", consumerTask);
      const receipt = snapshotDetails(await snapshotCall(child, "snapshot-input-receipt", {
        action: "check",
        offerId: base.offerId,
      }));
      const changedTask = `${consumerTask}\nchanged body`;
      await base.root.host.emit("tool_result", handoffTaskResult(
        "task-input-consumer",
        "ChildInputConsumer",
        "alpha",
        changedTask,
        "PASS result",
      ));
      const consumer = statusRecord(base.root, "task-input-consumer");
      expect(consumer.phase).toBe("refused");
      expect(consumer.refusalCode).toBe("handoff-task-result-input");
      const adopt = await handoffCall(base.root, "handoff-adopt-invalid-input", {
        action: "adopt",
        receiptId: receipt.receiptId,
        captureId: base.captureId,
        consumerParentToolCallId: "task-input-consumer",
      });
      expect(adopt.isError).toBe(true);
      const reuse = await base.root.host.task("task-input-reuse", { agent: "alpha", task: consumerTask });
      expect(isBlocked(reuse)).toBe(true);
      expect(blockedReason(reuse)).toMatch(/permanent|reservation|offer|failed/i);

      // The input mismatch rule is scoped to handoff admissions. A normal
      // no-reference task keeps its prior observation behavior.
      const normalTask = "normal task body";
      const normalAdmitted = await base.root.host.task("task-normal-input", { agent: "alpha", task: normalTask });
      expect(isBlocked(normalAdmitted)).toBe(false);
      await startChild(base.root, "task-normal-input", "ChildNormalInput", {
        activeTools: ["read", "agent_snapshot"],
      });
      await base.root.host.emit("tool_result", handoffTaskResult(
        "task-normal-input",
        "ChildNormalInput",
        "alpha",
        `${normalTask} changed`,
        "normal output",
      ));
      const normal = statusRecord(base.root, "task-normal-input");
      expect(normal.refusalCode).toBeNull();
      expect(normal.taskResultObserved).toBe(true);
      expect(normal.observation.result.observation?.state).toBe("observed");

      // A new parent work generation invalidates the remaining old offer.
      await base.root.host.emit("agent_end", {});
      await base.root.host.input("next handoff work", { source: "interactive" });
      await base.root.host.prepare("next handoff work");
      const staleTask = `OMP_HANDOFF_REF_V1 ${secondOffer}\nCheck after new work.`;
      const stale = await base.root.host.task("task-old-offer-new-work", { agent: "alpha", task: staleTask });
      expect(isBlocked(stale)).toBe(true);
      const staleRetry = await base.root.host.task("task-old-offer-new-work-2", { agent: "alpha", task: staleTask });
      expect(isBlocked(staleRetry)).toBe(true);
      expect(blockedReason(staleRetry)).toMatch(/permanent|reservation/i);
      expect(records(base.root).filter((record) => record.parentToolCallId === "task-old-offer-new-work"))
        .toHaveLength(0);
      expect(records(base.root).filter((record) => record.parentToolCallId === "task-old-offer-new-work-2"))
        .toHaveLength(0);
    } finally {
      await base.cleanup();
    }
  }, 20_000);

  test("changed full prompt or context task cannot check/read the same offer, and drifted child context refuses its prepared call", async () => {
    const base = await handoffBase();
    try {
      const promptTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\nCheck prompt identity.`;
      const promptAdmission = await base.root.host.task("task-wrong-prompt", { agent: "alpha", task: promptTask });
      expect(isBlocked(promptAdmission)).toBe(false);
      const wrongPromptChild = await startChild(base.root, "task-wrong-prompt", "ChildWrongPrompt", {
        activeTools: ["read", "agent_snapshot"],
      });
      await wrongPromptChild.host.emit("before_agent_start", {
        reason: "prompt",
        prompt: `${HANDOFF_TASK_PREFIX}${promptTask}\nchanged`,
        systemPrompt: childPrompt(base.alphaBody),
      });
      const promptRow = statusRecord(base.root, "task-wrong-prompt");
      expect(promptRow.phase).toBe("refused");
      expect(promptRow.refusalCode).toBe("handoff-task-prompt");
      const promptCheck = await wrongPromptChild.host.emit("tool_call", {
        toolCallId: "snapshot-wrong-prompt",
        toolName: "agent_snapshot",
        input: { action: "check", offerId: base.offerId },
      });
      expect(isBlocked(promptCheck)).toBe(true);

      const contextOffer = await publishHandoffOffer(base.root, "handoff-offer-context", base.captureId);
      const contextTask = `OMP_HANDOFF_REF_V1 ${contextOffer}\nCheck context identity.`;
      const contextAdmission = await base.root.host.task("task-wrong-context", { agent: "alpha", task: contextTask });
      expect(isBlocked(contextAdmission)).toBe(false);
      const wrongContextChild = await startChild(base.root, "task-wrong-context", "ChildWrongContext", {
        activeTools: ["read", "agent_snapshot"],
      });
      await wrongContextChild.host.emit("before_agent_start", {
        reason: "prompt",
        prompt: `${HANDOFF_TASK_PREFIX}${contextTask}`,
        systemPrompt: childPrompt(base.alphaBody),
      });
      await wrongContextChild.host.emit("context", {
        messages: [{ role: "user", content: `${HANDOFF_TASK_PREFIX}${contextTask}\nchanged` }],
      });
      const contextRow = statusRecord(base.root, "task-wrong-context");
      expect(contextRow.phase).toBe("refused");
      expect(contextRow.refusalCode).toBe("handoff-task-context");
      const contextCheck = await wrongContextChild.host.emit("tool_call", {
        toolCallId: "snapshot-wrong-context",
        toolName: "agent_snapshot",
        input: { action: "check", offerId: contextOffer },
      });
      expect(isBlocked(contextCheck)).toBe(true);

      const driftOffer = await publishHandoffOffer(base.root, "handoff-offer-drift", base.captureId);
      const driftTask = `OMP_HANDOFF_REF_V1 ${driftOffer}\nCheck drifted child context.`;
      const driftAdmission = await base.root.host.task("task-child-drift", { agent: "alpha", task: driftTask });
      expect(isBlocked(driftAdmission)).toBe(false);
      const driftChild = await handoffChild(base.root, "task-child-drift", "ChildDrift", driftTask);
      const prepared = await driftChild.host.emit("tool_call", {
        toolCallId: "snapshot-drift-child",
        toolName: "agent_snapshot",
        input: { action: "check", offerId: driftOffer },
      });
      expect(isBlocked(prepared)).toBe(false);
      // The preflight passed, then the real child context changed before
      // commit. The captured pure revalidation must refuse the execution.
      driftChild.host.currentModel = OTHER_MODEL;
      const snapshotTool = driftChild.host.tools.get("agent_snapshot");
      if (snapshotTool === undefined) throw new Error("agent_snapshot was not registered");
      const refused = await snapshotTool.execute(
        "snapshot-drift-child",
        { action: "check", offerId: driftOffer },
        new AbortController().signal,
        undefined,
        driftChild.host.context,
      );
      expect(refused.isError).toBe(true);
      expect(statusRecord(base.root, "task-child-drift").refusalCode).toBe("child-model");
      driftChild.entry.dispose();
    } finally {
      await base.cleanup();
    }
  }, 20_000);

  test("raw CRLF/CR handoff tasks with outer whitespace render to the exact normalized prompt and context", async () => {
    const base = await handoffBase();
    try {
      const crlfTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\r\nKeep  interior spaces.\r\n\r\nKeep blank line.\r\n `;
      const crlfPrompt = `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${base.offerId}\nKeep  interior spaces.\n\nKeep blank line.`;
      await admitHandoffTask(base.root, "task-render-crlf", crlfTask);
      const crlfChild = await handoffChildPrompt(
        base.root,
        "task-render-crlf",
        "ChildRenderCrlf",
        crlfPrompt,
      );
      expect(statusRecord(base.root, "task-render-crlf")).toMatchObject({
        phase: "bound",
        refusalCode: null,
      });
      const crlfCheck = snapshotDetails(await snapshotCall(crlfChild, "snapshot-render-crlf", {
        action: "check",
        offerId: base.offerId,
      }));
      expect(crlfCheck.outcome).toBe("pass");
      expect(typeof crlfCheck.receiptId).toBe("string");

      const crOffer = await publishHandoffOffer(base.root, "handoff-offer-render-cr", base.captureId);
      const crTask = `OMP_HANDOFF_REF_V1 ${crOffer}\rKeep  interior spaces.\r\rKeep blank line.\r `;
      const crPrompt = `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${crOffer}\nKeep  interior spaces.\n\nKeep blank line.`;
      await admitHandoffTask(base.root, "task-render-cr", crTask);
      const crChild = await handoffChildPrompt(
        base.root,
        "task-render-cr",
        "ChildRenderCr",
        crPrompt,
      );
      const crCheck = snapshotDetails(await snapshotCall(crChild, "snapshot-render-cr", {
        action: "check",
        offerId: crOffer,
      }));
      expect(crCheck.outcome).toBe("pass");
      expect(typeof crCheck.receiptId).toBe("string");
    } finally {
      await base.cleanup();
    }
  }, 20_000);

  test("interior Markdown spacing survives rendering while an interior-space or one-character mutation refuses", async () => {
    const base = await handoffBase();
    try {
      const rawTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\r\nKeep  two spaces.\r\n\r\nKeep blank line.\r\n`;
      const expected = `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${base.offerId}\nKeep  two spaces.\n\nKeep blank line.`;
      await admitHandoffTask(base.root, "task-render-interior", rawTask);
      const correct = await handoffChildPrompt(
        base.root,
        "task-render-interior",
        "ChildRenderInterior",
        expected,
      );
      const correctCheck = snapshotDetails(await snapshotCall(correct, "snapshot-render-interior", {
        action: "check",
        offerId: base.offerId,
      }));
      expect(correctCheck.outcome).toBe("pass");

      const promptOffer = await publishHandoffOffer(
        base.root,
        "handoff-offer-render-prompt-mutation",
        base.captureId,
      );
      const promptTask = `OMP_HANDOFF_REF_V1 ${promptOffer}\r\nKeep  two spaces.\r\n\r\nKeep blank line.\r\n`;
      await admitHandoffTask(base.root, "task-render-prompt-mutation", promptTask);
      const promptChild = await startChild(
        base.root,
        "task-render-prompt-mutation",
        "ChildRenderPromptMutation",
        { activeTools: ["read", "agent_snapshot"] },
      );
      await promptChild.host.emit("before_agent_start", {
        reason: "prompt",
        prompt: `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${promptOffer}\nKeep two spaces.\n\nKeep blank line.`,
        systemPrompt: childPrompt(base.alphaBody),
      });
      const promptRow = statusRecord(base.root, "task-render-prompt-mutation");
      expect(promptRow.phase).toBe("refused");
      expect(promptRow.refusalCode).toBe("handoff-task-prompt");
      expect(isBlocked(await promptChild.host.emit("tool_call", {
        toolCallId: "snapshot-render-prompt-mutation",
        toolName: "agent_snapshot",
        input: { action: "check", offerId: promptOffer },
      }))).toBe(true);

      const contextOffer = await publishHandoffOffer(
        base.root,
        "handoff-offer-render-context-mutation",
        base.captureId,
      );
      const contextTask = `OMP_HANDOFF_REF_V1 ${contextOffer}\r\nKeep  two spaces.\r\n\r\nKeep blank line.\r\n`;
      await admitHandoffTask(base.root, "task-render-context-mutation", contextTask);
      const contextChild = await startChild(
        base.root,
        "task-render-context-mutation",
        "ChildRenderContextMutation",
        { activeTools: ["read", "agent_snapshot"] },
      );
      await contextChild.host.emit("before_agent_start", {
        reason: "prompt",
        prompt: `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${contextOffer}\nKeep  two spaces.\n\nKeep blank line.`,
        systemPrompt: childPrompt(base.alphaBody),
      });
      await contextChild.host.emit("context", {
        messages: [{
          role: "user",
          content: `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${contextOffer}\nKeep  two spaces.\n\nKeep blank line`,
        }],
      });
      const contextRow = statusRecord(base.root, "task-render-context-mutation");
      expect(contextRow.phase).toBe("refused");
      expect(contextRow.refusalCode).toBe("handoff-task-context");
      expect(isBlocked(await contextChild.host.emit("tool_call", {
        toolCallId: "snapshot-render-context-mutation",
        toolName: "agent_snapshot",
        input: { action: "check", offerId: contextOffer },
      }))).toBe(true);
    } finally {
      await base.cleanup();
    }
  }, 20_000);

  test("a normalized parent task result input remains a digest conflict and cannot adopt", async () => {
    const base = await handoffBase();
    try {
      const rawTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\r\nCheck  digest.\r\n\r\nKeep blank line.\r\n`;
      const expected = `${HANDOFF_TASK_PREFIX}OMP_HANDOFF_REF_V1 ${base.offerId}\nCheck  digest.\n\nKeep blank line.`;
      await admitHandoffTask(base.root, "task-render-result-digest", rawTask);
      const child = await handoffChildPrompt(
        base.root,
        "task-render-result-digest",
        "ChildRenderResultDigest",
        expected,
      );
      const receipt = snapshotDetails(await snapshotCall(child, "snapshot-render-result-digest", {
        action: "check",
        offerId: base.offerId,
      }));
      expect(receipt.outcome).toBe("pass");

      const normalizedTask = rawTask.trim().replace(/\r\n?/g, "\n");
      expect(normalizedTask).not.toBe(rawTask);
      await base.root.host.emit("tool_result", handoffTaskResult(
        "task-render-result-digest",
        "ChildRenderResultDigest",
        "alpha",
        normalizedTask,
        "PASS result",
      ));
      const row = statusRecord(base.root, "task-render-result-digest");
      expect(row.refusalCode).toBe("handoff-task-result-input");
      const adopt = await handoffCall(base.root, "handoff-adopt-render-normalized-input", {
        action: "adopt",
        receiptId: receipt.receiptId,
        captureId: base.captureId,
        consumerParentToolCallId: "task-render-result-digest",
      });
      expect(adopt.isError).toBe(true);
    } finally {
      await base.cleanup();
    }
  }, 20_000);

  test("actual failure after normal completed+shutdown invalidates the adopted consumer report and adoption eligibility", async () => {
    const base = await handoffBase();
    try {
      const consumerTask = `OMP_HANDOFF_REF_V1 ${base.offerId}\nCheck completed consumer.`;
      const consumer = await completeHandoffConsumer(base.root, {
        call: "task-failed-after-complete",
        childId: "ChildFailedAfterComplete",
        offerId: base.offerId,
        task: consumerTask,
        receiptCall: "snapshot-completed-receipt",
        checkCall: "snapshot-completed-check",
        output: "PASS result",
      });
      const adoption = details(await handoffCall(base.root, "handoff-adopt-completed", {
        action: "adopt",
        receiptId: consumer.receiptId,
        captureId: base.captureId,
        consumerParentToolCallId: "task-failed-after-complete",
      }));
      expect(adoption.outcome).toBe("pass");
      const producerRow = statusRecord(base.root, base.producerCall);
      const reportParams = {
        action: "report",
        checks: [{ toolCallId: base.producerCall, purpose: "delegated source" }],
        outputFiles: ["data.json"],
        outcome: "completed",
        instanceResult: {
          instanceId: producerRow.id,
          parentToolCallId: base.producerCall,
          envelopeSha256: envelopeSha(producerRow),
        },
        handoffAdoptionId: adoption.adoptionId,
      };
      const accepted = await selectedReport(base.root, reportParams, { toolCallId: "report-completed-consumer" });
      expect(accepted.isError).not.toBe(true);

      // The normal completed+shutdown above is accepted; a real failed
      // lifecycle arriving later must still invalidate adoption/report.
      base.root.host.lifecycle({
        status: "failed",
        id: "ChildFailedAfterComplete",
        parentToolCallId: "task-failed-after-complete",
        index: 0,
        agent: "alpha",
      });
      const consumerRow = statusRecord(base.root, "task-failed-after-complete");
      expect(consumerRow.observation.lifecycleEvidence.failed).toBe(true);
      expect(consumerRow.observation.conflict?.code).toBe("lifecycle-failed-result-completed");
      expectReportRefused(
        await selectedReport(base.root, reportParams, { toolCallId: "report-after-consumer-failure" }),
        /failed|conflict|adoption|No report was recorded/i,
      );
      const readopt = await handoffCall(base.root, "handoff-adopt-after-failure", {
        action: "adopt",
        receiptId: consumer.receiptId,
        captureId: base.captureId,
        consumerParentToolCallId: "task-failed-after-complete",
      });
      expect(readopt.isError).toBe(true);
    } finally {
      await base.cleanup();
    }
  }, 20_000);
});

describe("actual instanced Harness composition", () => {
  test("absent config registers no tool and creates no backend or coordinator", async () => {
    const fake = createFakeHarness();
    let factoryCalls = 0;
    const root = await startRoot({
      harnessBackendFactory(config) {
        factoryCalls += 1;
        expect(config.model).toBe("fixture/main");
        return fake.host;
      },
    });
    expect(root.host.tools.has(NATIVE_HARNESS_TOOL)).toBe(false);
    expect(root.entry.harnessInspect).toBeUndefined();
    expect(factoryCalls).toBe(0);
    expect(fake.events).toEqual([]);
    expect(root.entry.getStatus().phase).toBe("ready");
    expect(root.host.toolRegistrations.filter((tool) => tool.name === NATIVE_WORK_TOOL)).toHaveLength(1);
  });

  test("selected main tool executes through the existing 2A native call and one observer", async () => {
    const fake = createFakeHarness();
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    const tool = root.host.tools.get(NATIVE_HARNESS_TOOL);
    expect(tool !== undefined).toBe(true);
    expect(tool!.approval).toBe("exec");
    expect(tool!.defaultInactive).toBe(true);
    expect(harness.calls).toHaveLength(1);
    expect(fake.events).toEqual([]);
    expect(root.host.toolRegistrations.filter((entry) => entry.name === NATIVE_WORK_TOOL)).toHaveLength(1);

    await beginWork(root, "selected harness work");
    const controller = new AbortController();
    const result = await executeHarness(root, "harness-call-1", "bounded task", controller.signal);
    expect(result.isError).not.toBe(true);
    const details = harnessDetails(result);
    expect(details.outcome).toBe("backend-completed");
    expect(details.taskAccepted).toBe(false);
    expect(details.semanticAcceptance).toBe("not-evaluated");
    expect(fake.events).toEqual(["prepare", "create", "execute"]);
    expect(fake.prepareRequests).toHaveLength(1);
    expect(fake.prepareRequests[0]!.association.toolCallId).toBe("harness-call-1");
    expect(fake.contexts[0]).toBe(root.host.context);
    const inspection = root.entry.harnessInspect?.(root.host.context);
    expect(inspection?.authority).toBe("non-authoritative");
    expect(inspection?.available).toBe(true);
    expect(inspection?.coordinator?.retainedOperations).toBe(1);
    expect(inspection?.backend).toEqual([]);
  });

  test("unselected or inactive harness tool is refused with no backend effect", async () => {
    const fake = createFakeHarness();
    const harness = harnessFixture(fake);
    const root = await startRoot({
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    expect(root.host.tools.has(NATIVE_HARNESS_TOOL)).toBe(true);
    expect(harness.calls).toHaveLength(0);
    expect(fake.events).toEqual([]);

    const result = await root.host.tools.get(NATIVE_HARNESS_TOOL)!.execute(
      "unselected-harness-call",
      { task: "must not run" },
      new AbortController().signal,
      undefined,
      root.host.context,
    );
    expectHarnessRefused(result, /not enabled and explicitly selected/);
    expect(harness.calls).toHaveLength(0);
    expect(fake.events).toEqual([]);
  });

  test("child attempts and child/foreign direct contexts refuse before preparation", async () => {
    const fake = createFakeHarness();
    const harness = harnessFixture(fake);
    const childDefinition = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1", {
      tools: ["read", NATIVE_HARNESS_TOOL],
    });
    const root = await startRoot({
      children: [childDefinition],
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "child harness refusal work");
    await admit(root, "task-child-harness");
    await spawn(root);
    const child = await startChild(root, "task-child-harness", "ChildHarness", {
      activeTools: ["read", NATIVE_HARNESS_TOOL],
    });
    const blocked = await child.host.emit("tool_call", {
      toolCallId: "child-harness-call",
      toolName: NATIVE_HARNESS_TOOL,
      input: { task: "child must not run" },
    });
    expect(isRecord(blocked) && blocked.block).toBe(true);
    expect(blockedReason(blocked)).toMatch(/owning actual main root/);

    const childContext = child.host.context;
    let direct = await root.host.tools.get(NATIVE_HARNESS_TOOL)!.execute(
      "child-context-harness-call",
      { task: "must not run" },
      new AbortController().signal,
      undefined,
      childContext,
    );
    expectHarnessRefused(direct, /owning actual main root/);

    const foreignHost = new Host({
      agentKind: "main",
      agentId: "Other",
      sessionId: "session-other",
      cwd: root.workspace,
      activeTools: ["read", "task", NATIVE_HARNESS_TOOL],
    });
    direct = await root.host.tools.get(NATIVE_HARNESS_TOOL)!.execute(
      "foreign-context-harness-call",
      { task: "must not run" },
      new AbortController().signal,
      undefined,
      foreignHost.context,
    );
    expectHarnessRefused(direct, /owning main root/);
    expect(harness.calls).toHaveLength(1);
    expect(fake.events).toEqual([]);
  });

  test("original execute signal cancels the admitted run and backend run id", async () => {
    const createGate = deferred<void>();
    const fake = createFakeHarness({ createGate });
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "abort harness work");
    const controller = new AbortController();
    const running = startHarness(root, "harness-abort-call", "abort this run", controller.signal);
    await waitFor(() => fake.events.includes("create"));
    controller.abort();
    createGate.resolve();
    const result = await running;
    expect(harnessDetails(result).outcome).toBe("cancelled");
    expect(harnessDetails(result).cancellation).toBe("requested");
    expect(fake.events).toContain("cancel:run-1");
    expect(fake.events.filter((event) => event === "execute")).toHaveLength(0);
  });

  test("same-call replay returns history without a second run", async () => {
    const fake = createFakeHarness();
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "replay harness work");
    const signal = new AbortController().signal;
    const first = await executeHarness(root, "harness-replay-call", "replay task", signal);
    expect(harnessDetails(first).historical).toBe(false);
    const creates = fake.events.filter((event) => event === "create").length;
    await root.host.emit("tool_call", {
      toolCallId: "harness-replay-call",
      toolName: NATIVE_HARNESS_TOOL,
      input: { task: "replay task" },
    });
    const replay = await root.host.tools.get(NATIVE_HARNESS_TOOL)!.execute(
      "harness-replay-call",
      { task: "replay task" },
      signal,
      undefined,
      root.host.context,
    );
    expect(harnessDetails(replay).historical).toBe(true);
    expect(harnessDetails(replay).resultKind).toBe("historical");
    expect(fake.events.filter((event) => event === "create")).toHaveLength(creates);
  });

  test("rejected parallel ids cannot hide a later admitted run from work-end cancel", async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const fake = createFakeHarness({ executeGates: [firstGate, secondGate] });
    const harness = harnessFixture(fake, { perRunUsd: 0.1, lifetimeUsd: 1 });
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "parallel tracking work");
    const first = startHarness(
      root,
      "active-1",
      "first admitted task",
      new AbortController().signal,
    );
    await waitFor(() => fake.events.includes("execute"));
    for (let index = 2; index <= 16; index += 1) {
      const rejected = await executeHarness(
        root,
        `rejected-${index}`,
        `parallel rejected ${index}`,
        new AbortController().signal,
      );
      expect(harnessDetails(rejected).outcome).toBe("refused");
    }
    expect(fake.prepareRequests).toHaveLength(1);
    firstGate.resolve();
    await first;

    const secondSignal = new AbortController();
    const second = startHarness(root, "active-17", "second admitted task", secondSignal.signal);
    await waitFor(() => fake.events.filter((event) => event === "execute").length >= 2);
    await root.host.emit("agent_end", {});
    await waitFor(() => fake.events.includes("cancel:run-2"));
    expect(fake.prepareRequests).toHaveLength(2);
    expect(fake.prepareRequests[1]!.signal.aborted).toBe(true);
    secondGate.resolve();
    const result = await second;
    expect(harnessDetails(result).outcome).toBe("cancelled");
  });

  test("same-id changed task or signal refusal cannot untrack the original active run", async () => {
    const gate = deferred<void>();
    const fake = createFakeHarness({ executeGates: [gate] });
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "same id tracking work");
    const originalSignal = new AbortController();
    const original = startHarness(root, "same-id-active", "original task", originalSignal.signal);
    await waitFor(() => fake.events.includes("execute"));

    const changedTask = await executeHarness(
      root,
      "same-id-active",
      "different task",
      originalSignal.signal,
    );
    expectHarnessRefused(changedTask, /different task/);
    const changedSignal = await executeHarness(
      root,
      "same-id-active",
      "original task",
      new AbortController().signal,
    );
    expectHarnessRefused(changedSignal, /invocation signal/);

    await root.host.emit("agent_end", {});
    await waitFor(() => fake.events.includes("cancel:run-1"));
    gate.resolve();
    const result = await original;
    expect(harnessDetails(result).outcome).toBe("cancelled");
  });

  test("owner work-end cancels the active run without resetting the lifetime ledger", async () => {
    const executeGate = deferred<void>();
    const fake = createFakeHarness({ deferExecuteAfterFirst: executeGate });
    const harness = harnessFixture(fake, { perRunUsd: 1, lifetimeUsd: 2 });
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "first budget work");
    const first = await executeHarness(
      root,
      "harness-budget-1",
      "first bounded task",
      new AbortController().signal,
    );
    expect(harnessDetails(first).outcome).toBe("backend-completed");
    await root.host.emit("agent_end", {});
    await beginWork(root, "second budget work");

    const running = startHarness(
      root,
      "harness-budget-2",
      "second bounded task",
      new AbortController().signal,
    );
    await waitFor(() => fake.events.filter((event) => event === "execute").length >= 2);
    await root.host.emit("agent_end", {});
    await waitFor(() => fake.events.includes("cancel:run-2"));
    executeGate.resolve();
    const second = await running;
    expect(harnessDetails(second).outcome).toBe("cancelled");
    expect(harnessDetails(second).cancellation).toBe("requested");
    await beginWork(root, "third budget work");

    const third = await executeHarness(
      root,
      "harness-budget-3",
      "third bounded task",
      new AbortController().signal,
    );
    expectHarnessRefused(third, /lifetime delegation budget/);
    expect(fake.events.filter((event) => event === "create")).toHaveLength(2);
  });

  test("main navigation, shutdown and disposal cancel the owner run", async () => {
    for (const action of ["navigation", "shutdown", "dispose"] as const) {
      const executeGate = deferred<void>();
      const fake = createFakeHarness({ executeGate });
      const harness = harnessFixture(fake);
      const root = await startRoot({
        ...harnessMainOptions(),
        harness: harness.harness,
        harnessBackendFactory: harness.factory,
      });
      await beginWork(root, `${action} harness work`);
      const running = startHarness(
        root,
        `harness-${action}`,
        `${action} bounded task`,
        new AbortController().signal,
      );
      await waitFor(() => fake.events.includes("execute"));
      if (action === "navigation") {
        await root.host.emit("session_switch", {});
      } else if (action === "shutdown") {
        await root.host.emit("session_shutdown", {});
      } else {
        root.entry.dispose();
      }
      await waitFor(() => fake.events.includes("cancel:run-1"));
      executeGate.resolve();
      const result = await running;
      expect(harnessDetails(result).authorityFresh).toBe(false);
      expect(["cancelled", "incomplete"]).toContain(harnessDetails(result).outcome);
      root.entry.dispose();
    }
  });

  test("foreign main work-end issues no owner backend cancel", async () => {
    const executeGate = deferred<void>();
    const fake = createFakeHarness({ executeGate });
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "foreign work-end owner work");
    const running = startHarness(
      root,
      "harness-foreign-work-end",
      "owner work remains active",
      new AbortController().signal,
    );
    await waitFor(() => fake.events.includes("execute"));
    await root.host.emit("agent_end", {}, ownerContext({ agentId: "Other" }));
    expect(fake.events).not.toContain("cancel:run-1");
    executeGate.resolve();
    const result = await running;
    // The instance owner filter did not request cancellation. The wrapped
    // native observer still ends the same session/cwd work, so the final 2A
    // gate refuses freshness rather than fabricating completion.
    expect(harnessDetails(result).cancellation).toBe("none");
    expect(harnessDetails(result).authorityFresh).toBe(false);
    expect(harnessDetails(result).outcome).toBe("incomplete");
    expect(fake.events.filter((event) => event.startsWith("cancel:"))).toHaveLength(0);
  });

  test("a rejected competing call cannot swap the active execute context", async () => {
    const createGate = deferred<void>();
    const fake = createFakeHarness({ createGate });
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "original context work");
    const running = startHarness(
      root,
      "harness-original-context",
      "original bounded task",
      new AbortController().signal,
    );
    await waitFor(() => fake.events.includes("create"));
    const foreignHost = new Host({
      agentKind: "main",
      agentId: "Other",
      sessionId: "session-other",
      cwd: root.workspace,
      activeTools: ["read", "task", NATIVE_HARNESS_TOOL],
    });
    const competing = await root.host.tools.get(NATIVE_HARNESS_TOOL)!.execute(
      "harness-competing-context",
      { task: "competing bounded task" },
      new AbortController().signal,
      undefined,
      foreignHost.context,
    );
    expectHarnessRefused(competing, /owning main root/);
    createGate.resolve();
    const result = await running;
    expect(harnessDetails(result).outcome).toBe("backend-completed");
    expect(harnessDetails(result).authorityFresh).toBe(true);
    expect(fake.events.filter((event) => event === "create")).toHaveLength(1);
    expect(fake.events).not.toContain("cancel:run-1");
  });

  test("model, tools and settings drift refuse and cancel an active run", async () => {
    const drifts = ["model", "tools", "settings"] as const;
    for (const drift of drifts) {
      const createGate = deferred<void>();
      const fake = createFakeHarness({ createGate });
      const harness = harnessFixture(fake);
      const root = await startRoot({
        ...harnessMainOptions(),
        harness: harness.harness,
        harnessBackendFactory: harness.factory,
      });
      await beginWork(root, `${drift} drift work`);
      const running = startHarness(
        root,
        `harness-drift-${drift}`,
        `${drift} drift task`,
        new AbortController().signal,
      );
      await waitFor(() => fake.events.includes("create"));
      if (drift === "model") {
        root.host.currentModel = OTHER_MODEL;
      } else if (drift === "tools") {
        root.host.activeTools = ["read", "task", NATIVE_HARNESS_TOOL, "extra-tool"];
      } else {
        (root.ports as { readScopedSettings: () => unknown }).readScopedSettings = () => ({
          ok: true,
          settings: { ...SUPPORTED_SETTINGS, taskBatch: true },
        });
      }
      createGate.resolve();
      const result = await running;
      expect(harnessDetails(result).authorityFresh).toBe(false);
      expect(["cancelled", "incomplete"]).toContain(harnessDetails(result).outcome);
      expect(fake.events).toContain("cancel:run-1");
      expect(fake.events.filter((event) => event === "execute")).toHaveLength(0);
      root.entry.dispose();
    }
  });

  test("factory navigation during admission cannot resurrect a closed root", async () => {
    const fake = createFakeHarness();
    const main = mainSnapshot(WORKSPACE, HARNESS_MAIN_TOOLS);
    const child = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const host = new Host({ cwd: WORKSPACE, sessionId: "session-root", activeTools: HARNESS_MAIN_TOOLS });
    let entered = 0;
    const entry = createInstancedNativeEntry(host.pi, {
      mainDefinitionPath: main.definition.canonicalPath,
      childDefinitions: [child.definition.requestedPath],
      nativePorts: makePorts({
        discoverAgents: async () => [{
          name: child.definition.name,
          filePath: child.definition.canonicalPath,
          source: "project",
        }],
      }),
      loadMainDefinition: async () => main,
      loadChildDefinition: async () => child,
      startupTimeoutMs: 5_000,
      harness: { backend: harnessBackendConfig() },
      harnessBackendFactory: () => {
        entered += 1;
        const handlers = host.handlers.get("session_clear") ?? [];
        handlers.at(-1)!({ type: "session_clear" }, host.context);
        return fake.host;
      },
    });
    controls.push(entry);
    await host.sessionStart();
    const value = entry.getStatus();
    expect(entered).toBe(1);
    expect(value.phase).toBe("closed");
    expect(value.restartRequired).toBe(true);
    expect(fake.events).toEqual([]);
  });

  test("factory disposal during admission cannot resurrect the disposed entry", async () => {
    const fake = createFakeHarness();
    const main = mainSnapshot(WORKSPACE, HARNESS_MAIN_TOOLS);
    const child = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const host = new Host({ cwd: WORKSPACE, sessionId: "session-root", activeTools: HARNESS_MAIN_TOOLS });
    let entry!: InstancedNativeEntryControls;
    let entered = 0;
    entry = createInstancedNativeEntry(host.pi, {
      mainDefinitionPath: main.definition.canonicalPath,
      childDefinitions: [child.definition.requestedPath],
      nativePorts: makePorts({
        discoverAgents: async () => [{
          name: child.definition.name,
          filePath: child.definition.canonicalPath,
          source: "project",
        }],
      }),
      loadMainDefinition: async () => main,
      loadChildDefinition: async () => child,
      startupTimeoutMs: 5_000,
      harness: { backend: harnessBackendConfig() },
      harnessBackendFactory: () => {
        entered += 1;
        entry.dispose();
        return fake.host;
      },
    });
    controls.push(entry);
    await host.sessionStart();
    const value = entry.getStatus();
    expect(entered).toBe(1);
    expect(value.phase).toBe("closed");
    expect(fake.events).toEqual([]);
  });

  test("late factory callback closes the ready root without reopening it", async () => {
    const fake = createFakeHarness();
    const main = mainSnapshot(WORKSPACE, HARNESS_MAIN_TOOLS);
    const child = childSnapshot("alpha", "ALPHA_BODY_V1", "alpha-v1");
    const host = new Host({ cwd: WORKSPACE, sessionId: "session-root", activeTools: HARNESS_MAIN_TOOLS });
    const entry = createInstancedNativeEntry(host.pi, {
      mainDefinitionPath: main.definition.canonicalPath,
      childDefinitions: [child.definition.requestedPath],
      nativePorts: makePorts({
        discoverAgents: async () => [{
          name: child.definition.name,
          filePath: child.definition.canonicalPath,
          source: "project",
        }],
      }),
      loadMainDefinition: async () => main,
      loadChildDefinition: async () => child,
      startupTimeoutMs: 5_000,
      harness: { backend: harnessBackendConfig() },
      harnessBackendFactory: () => {
        setTimeout(() => {
          const handlers = host.handlers.get("session_switch") ?? [];
          handlers.at(-1)!({ type: "session_switch" }, host.context);
        }, 0);
        return fake.host;
      },
    });
    controls.push(entry);
    await host.sessionStart();
    expect(entry.getStatus().phase).toBe("ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(entry.getStatus().phase).toBe("closed");
    expect(entry.getStatus().restartRequired).toBe(true);
    expect(fake.events).toEqual([]);
  });

  test("normal child admission remains unchanged when Harness is selected on the main root", async () => {
    const fake = createFakeHarness();
    const harness = harnessFixture(fake);
    const root = await startRoot({
      ...harnessMainOptions(),
      harness: harness.harness,
      harnessBackendFactory: harness.factory,
    });
    await beginWork(root, "normal child work under harness root");
    await admit(root, "task-normal-child");
    await spawn(root);
    await startChild(root, "task-normal-child", "ChildNormal");
    expect(records(root)[0]?.phase).toBe("bound");
    expect(fake.events).toEqual([]);
    expect(harness.calls).toHaveLength(1);
  });
});

describe("actual instanced Harness host-only output capture", () => {
  test("ordinary main output is captured only after native observation and preserves source facts", async () => {
    const fixture = await startActualHarnessCapture({ candidateText: "known output\n" });
    await beginWork(fixture.root, "host capture work");
    const execution = await executeActualHarness(fixture.root, "capture-call", "bounded capture task");
    const details = harnessDetails(execution.result);
    expect(details.outcome).toBe("backend-completed");
    expect(details.authorityFresh).toBe(true);
    const runnerCalls = fixture.runner.requests.length;
    const before = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
    expect(before?.available).toBe(true);
    expect(before?.coordinator?.operations[0]?.output.state).toBe("idle");

    const early = await hostCapture(fixture.root, "capture-call");
    expectCaptureFailure(early, "not-ready");
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    expect(await readFile(path.join(fixture.sourceRoot, "a.txt"), "utf8")).toBe("alpha\n");
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();

    await observeActualHarness(fixture.root, execution);
    const controller = new AbortController();
    const selection = await hostCapture(fixture.root, "capture-call", controller.signal);
    if (!selection.ok) throw new Error(`capture failed: ${selection.code} ${selection.reason}`);
    expect(selection.observation).toBe("captured-now");
    expect(selection.filesystemFreshness).toBe("observed-during-capture");
    expect(String(selection.runId)).toBe(String(details.runId));
    expect(selection.association.toolCallId).toBe("capture-call");
    expect(String(selection.association.sessionId)).toBe("session-root");
    expect(String(selection.association.workspaceRoot)).toBe(fixture.sourceRoot);
    expect(selection.taskSha256).toBe(createHash("sha256").update("bounded capture task").digest("hex"));
    expect(selection.expectedResultSha256).toBe(selection.observedResultSha256);
    expect(selection.taskAccepted).toBe(false);
    expect(selection.semanticAcceptance).toBe("not-evaluated");

    const capture = selection.capture;
    expect(capture.schema).toBe("omp-agent.native-harness-output-capture.v1");
    expect(String(capture.runId)).toBe(String(details.runId));
    expect(capture.taskSha256).toBe(selection.taskSha256);
    expect(capture.changes).toHaveLength(1);
    const change = capture.changes[0]!;
    expect(change.path).toBe("candidate.txt");
    expect(change.kind).toBe("add");
    expect(change.snapshot.text).toBe("known output\n");
    expect(change.snapshot.file.sha256)
      .toBe(createHash("sha256").update("known output\n").digest("hex"));
    expect(controller.signal.aborted).toBe(false);
    expect(fixture.runner.requests.length).toBe(runnerCalls);

    expect(await readFile(path.join(fixture.sourceRoot, "a.txt"), "utf8")).toBe("alpha\n");
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
    const afterDetails = harnessDetails(execution.result);
    expect(afterDetails.cost).toEqual(details.cost);
    expect(afterDetails.runId).toBe(details.runId);
    expect(afterDetails.executionState).toBe("settled");
    expect(afterDetails.outcome).toBe("backend-completed");
    const after = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
    expect(after?.available).toBe(true);
    expect(after?.coordinator?.output.retainedCaptures).toBe(1);
    expect(after?.coordinator?.output.active).toBe(false);
    expect(after?.coordinator?.operations[0]?.output.state).toBe("captured");
  }, 30_000);

  test("earlier result rewrites prevent capture and same-id correction stays sticky", async () => {
    const rewrites: readonly [string, (event: Record<string, unknown>) => Record<string, unknown>][] = [
      ["content", (event) => ({ ...event, content: [{ type: "text", text: "rewritten result content" }] })],
      ["details", (event) => ({ ...event, details: { ...(event.details as object), tampered: true } })],
      ["input", (event) => ({ ...event, input: { task: "rewritten result input" } })],
      ["error", (event) => ({ ...event, isError: true })],
    ];
    for (const [name, rewrite] of rewrites) {
      const fixture = await startActualHarnessCapture();
      const call = `rewrite-${name}-call`;
      await beginWork(fixture.root, `${name} rewritten result work`);
      const execution = await executeActualHarness(fixture.root, call, `bounded ${name} rewrite task`);
      await fixture.root.host.emit("tool_result", rewrite(execution.event), fixture.root.host.context);
      const runnerCalls = fixture.runner.requests.length;
      expectCaptureFailure(await hostCapture(fixture.root, call), "source-conflict");

      await observeActualHarness(fixture.root, execution);
      expectCaptureFailure(await hostCapture(fixture.root, call), "source-conflict");
      expect(fixture.runner.requests.length).toBe(runnerCalls);
      await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
      fixture.root.entry.dispose();
    }
  }, 60_000);

  test("an equal duplicate observation does not break the prepared capture check", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "duplicate observation work");
    const execution = await executeActualHarness(fixture.root, "duplicate-call", "bounded duplicate task");
    await observeActualHarness(fixture.root, execution);
    await observeActualHarness(fixture.root, execution);
    const selection = await hostCapture(fixture.root, "duplicate-call");
    if (!selection.ok) throw new Error(`capture failed: ${selection.code} ${selection.reason}`);
    expect(selection.observation).toBe("captured-now");
    expect(selection.expectedResultSha256).toBe(selection.observedResultSha256);
    const after = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
    expect(after?.coordinator?.output.retainedCaptures).toBe(1);
  }, 30_000);

  test("child, foreign, factory, signal, id, model/tool and work drift refuse without new runs", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "capture refusal work");
    const execution = await executeActualHarness(fixture.root, "refusal-call", "bounded refusal task");
    await observeActualHarness(fixture.root, execution);
    const runnerCalls = fixture.runner.requests.length;

    const childContext = ownerContext({
      agentKind: "sub",
      agentId: "ChildCapture",
      sessionId: "session-child-capture",
      cwd: fixture.sourceRoot,
    });
    expectCaptureFailure(
      await hostCapture(fixture.root, "refusal-call", new AbortController().signal, childContext),
      "authority-lost",
    );
    const foreignContext = ownerContext({
      agentId: "OtherCapture",
      sessionId: "session-other-capture",
      cwd: fixture.sourceRoot,
    });
    expectCaptureFailure(
      await hostCapture(fixture.root, "refusal-call", new AbortController().signal, foreignContext),
      "authority-lost",
    );
    expectCaptureFailure(await hostCapture(fixture.root, "unknown-capture-call"), "not-ready");
    const missingSignal = await fixture.root.entry.harnessCaptureOutput!(
      "refusal-call",
      undefined as unknown as AbortSignal,
      fixture.root.host.context,
    );
    expectCaptureFailure(missingSignal, "invalid-caller");

    const foreignMain = mainSnapshot(fixture.sourceRoot, HARNESS_MAIN_TOOLS);
    const foreignHost = new Host({
      cwd: fixture.sourceRoot,
      sessionId: "session-foreign-capture",
      activeTools: HARNESS_MAIN_TOOLS,
    });
    const foreignEntry = createInstancedNativeEntry(foreignHost.pi, {
      mainDefinitionPath: foreignMain.definition.canonicalPath,
      childDefinitions: [],
      nativePorts: makePorts(),
      loadMainDefinition: async () => foreignMain,
      startupTimeoutMs: 5_000,
      harness: { backend: harnessBackendConfig({ storageRoot: fixture.storageRoot }) },
      harnessBackendFactory: () => {
        throw new Error("a foreign non-root factory must not construct a backend");
      },
    });
    controls.push(foreignEntry);
    const wrongFactory = await foreignEntry.harnessCaptureOutput!(
      "refusal-call",
      new AbortController().signal,
      fixture.root.host.context,
    );
    expectCaptureFailure(wrongFactory, "authority-lost");

    expect(fixture.runner.requests.length).toBe(runnerCalls);
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();

    const accepted = await hostCapture(fixture.root, "refusal-call");
    if (!accepted.ok) throw new Error(`capture failed after restoration: ${accepted.code} ${accepted.reason}`);
    expect(accepted.observation).toBe("captured-now");

    await fixture.root.host.input("pending capture input", { source: "interactive" });
    expectCaptureFailure(await hostCapture(fixture.root, "refusal-call"), ["authority-lost", "source-conflict"]);
    await fixture.root.host.emit("agent_end", {});
    expectCaptureFailure(await hostCapture(fixture.root, "refusal-call"), ["authority-lost", "source-conflict"]);
    expect(fixture.runner.requests.length).toBe(runnerCalls);
  }, 30_000);

  test("late main tool drift refuses without a new run or workspace write", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "tool drift capture work");
    const execution = await executeActualHarness(fixture.root, "tool-drift-call", "bounded tool drift task");
    await observeActualHarness(fixture.root, execution);
    const runnerCalls = fixture.runner.requests.length;
    fixture.root.host.activeTools = [...HARNESS_MAIN_TOOLS, "extra-capture-tool"];
    expectCaptureFailure(await hostCapture(fixture.root, "tool-drift-call"), "authority-lost");
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  test("late main model drift refuses without a new run or workspace write", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "model drift capture work");
    const execution = await executeActualHarness(fixture.root, "model-drift-call", "bounded model drift task");
    await observeActualHarness(fixture.root, execution);
    const runnerCalls = fixture.runner.requests.length;
    fixture.root.host.currentModel = OTHER_MODEL;
    expectCaptureFailure(await hostCapture(fixture.root, "model-drift-call"), "authority-lost");
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  test("a late managed owner appearance refuses without a new run or workspace write", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "owner appearance capture work");
    const execution = await executeActualHarness(fixture.root, "owner-capture-call", "bounded owner capture task");
    await observeActualHarness(fixture.root, execution);
    const runnerCalls = fixture.runner.requests.length;
    try {
      publishTaskOwner({} as unknown as Parameters<typeof publishTaskOwner>[0]);
      expectCaptureFailure(await hostCapture(fixture.root, "owner-capture-call"), "authority-lost");
    } finally {
      clearPublishedTaskOwner();
    }
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  test("a closed root refuses host capture without a new run or workspace write", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "closed root capture work");
    const execution = await executeActualHarness(fixture.root, "closed-capture-call", "bounded closed capture task");
    await observeActualHarness(fixture.root, execution);
    const runnerCalls = fixture.runner.requests.length;
    fixture.root.entry.dispose();
    expectCaptureFailure(await hostCapture(fixture.root, "closed-capture-call"), "authority-lost");
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();
  }, 30_000);

  test("active output reads are cancelled only through the existing lifecycle tracking", async () => {
    for (const action of ["agent_end", "session_stop", "navigation", "dispose"] as const) {
      const fixture = await startActualHarnessCapture();
      await beginWork(fixture.root, `${action} capture work`);
      const execution = await executeActualHarness(fixture.root, `${action}-capture-call`, "bounded cancellation task");
      await observeActualHarness(fixture.root, execution);
      const runnerCalls = fixture.runner.requests.length;
      const sourceDetails = harnessDetails(execution.result);
      const requestController = new AbortController();
      const pending = hostCapture(fixture.root, `${action}-capture-call`, requestController.signal);
      const activeDuringRead = fixture.root.entry.harnessInspect?.(fixture.root.host.context)
        ?.coordinator?.output.active;
      expect(activeDuringRead).toBe(true);

      let ending: Promise<unknown>;
      if (action === "agent_end") {
        ending = fixture.root.host.emit("agent_end", {});
      } else if (action === "session_stop") {
        ending = fixture.root.host.emit("session_stop", {});
      } else if (action === "navigation") {
        ending = fixture.root.host.emit("session_switch", {});
      } else {
        fixture.root.entry.dispose();
        ending = Promise.resolve();
      }
      if (action === "agent_end" || action === "session_stop") {
        const activeAfterCancel = fixture.root.entry.harnessInspect?.(fixture.root.host.context)
          ?.coordinator?.output.active;
        expect(activeAfterCancel).toBe(true);
      }

      const selection = await pending;
      await ending;
      expectCaptureFailure(selection, ["cancelled", "authority-lost"]);
      expect(requestController.signal.aborted).toBe(false);
      expect(fixture.runner.requests.length).toBe(runnerCalls);
      const afterDetails = harnessDetails(execution.result);
      expect(afterDetails.cost).toEqual(sourceDetails.cost);
      expect(afterDetails.runId).toBe(sourceDetails.runId);
      expect(afterDetails.executionState).toBe("settled");
      expect(afterDetails.outcome).toBe("backend-completed");
      expect(afterDetails.cancellation).toBe("none");
      expect(afterDetails.cancelError).toBeNull();
      await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();

      if (action === "agent_end" || action === "session_stop") {
        const inspection = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
        expect(inspection?.coordinator?.output.active).toBe(false);
        expect(inspection?.coordinator?.output.retainedCaptures).toBe(0);
        expect(inspection?.coordinator?.operations[0]?.output.state).toBe("failed");
      }
      fixture.root.entry.dispose();
    }
  }, 60_000);

  test("ordered synchronous session_stop during the first capture guard cancels the now-tracked source", async () => {
    const fixture = await startActualHarnessCapture();
    await beginWork(fixture.root, "synchronous stop capture work");
    const execution = await executeActualHarness(
      fixture.root,
      "synchronous-stop-call",
      "bounded synchronous stop task",
    );
    await observeActualHarness(fixture.root, execution);
    const sourceDetails = harnessDetails(execution.result);
    expect(sourceDetails.outcome).toBe("backend-completed");
    expect(sourceDetails.executionState).toBe("settled");
    const runnerCalls = fixture.runner.requests.length;
    const workEpochBefore = status(fixture.root).root?.workEpoch;

    const context = fixture.root.host.context;
    const sessionManager = (context as unknown as {
      sessionManager: { getSessionId(): string; getCwd(): string };
    }).sessionManager;
    const readSessionId = sessionManager.getSessionId.bind(sessionManager);
    let fired = false;
    let inspecting = false;
    const trigger = {
      calls: 0,
      active: false,
      reservedBytes: -1,
      retainedCaptures: -1,
      stopResults: [] as unknown[],
    };
    sessionManager.getSessionId = () => {
      if (!fired && !inspecting) {
        inspecting = true;
        let active = false;
        let reservedBytes = -1;
        let retainedCaptures = -1;
        try {
          const output = fixture.root.entry.harnessInspect?.(context)?.coordinator?.output;
          if (output?.active === true) {
            active = true;
            reservedBytes = output.reservedBytes;
            retainedCaptures = output.retainedCaptures;
          }
        } finally {
          inspecting = false;
        }
        if (active) {
          fired = true;
          trigger.calls += 1;
          trigger.active = true;
          trigger.reservedBytes = reservedBytes;
          trigger.retainedCaptures = retainedCaptures;
          trigger.stopResults = sessionStopHooksSynchronously(fixture.root.host);
        }
      }
      return readSessionId();
    };

    const pending = hostCapture(fixture.root, "synchronous-stop-call");
    expect(trigger.calls).toBe(1);
    expect(trigger.active).toBe(true);
    expect(trigger.reservedBytes).toBe(1_048_576);
    expect(trigger.retainedCaptures).toBe(0);
    expect(trigger.stopResults.length).toBe(fixture.root.host.handlers.get("session_stop")?.length ?? 0);
    expect(trigger.stopResults.some((result) => isRecord(result) && result.continue === true)).toBe(true);
    expect(status(fixture.root).root?.workEpoch).toBe((workEpochBefore ?? 0) + 1);

    const held = fixture.root.entry.harnessInspect?.(fixture.root.host.context)?.coordinator?.output;
    expect(held?.active).toBe(true);
    expect(held?.reservedBytes).toBe(1_048_576);

    const selection = await pending;
    expectCaptureFailure(selection, "cancelled");
    expect(fixture.runner.requests.length).toBe(runnerCalls);
    const afterDetails = harnessDetails(execution.result);
    expect(afterDetails.cost).toEqual(sourceDetails.cost);
    expect(afterDetails.runId).toBe(sourceDetails.runId);
    expect(afterDetails.executionState).toBe("settled");
    expect(afterDetails.outcome).toBe("backend-completed");
    expect(afterDetails.cancellation).toBe("none");
    expect(afterDetails.cancelError).toBeNull();
    await expect(readFile(path.join(fixture.sourceRoot, "candidate.txt"), "utf8")).rejects.toThrow();

    const after = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
    expect(after?.coordinator?.output.active).toBe(false);
    expect(after?.coordinator?.output.retainedCaptures).toBe(0);
    expect(after?.coordinator?.output.retainedBytes).toBe(0);
    expect(after?.coordinator?.output.reservedBytes).toBe(0);
    expect(after?.coordinator?.operations[0]?.output.state).toBe("failed");
  }, 30_000);

  test("same-signal joins one leaf reservation while a different signal refusal leaves it tracked", async () => {
    const joinedFixture = await startActualHarnessCapture();
    await beginWork(joinedFixture.root, "joined capture work");
    const joinedExecution = await executeActualHarness(
      joinedFixture.root,
      "joined-capture-call",
      "bounded joined task",
    );
    await observeActualHarness(joinedFixture.root, joinedExecution);
    const joinedCalls = joinedFixture.runner.requests.length;
    const sharedController = new AbortController();
    const first = hostCapture(joinedFixture.root, "joined-capture-call", sharedController.signal);
    const second = hostCapture(joinedFixture.root, "joined-capture-call", sharedController.signal);
    const [firstSelection, secondSelection] = await Promise.all([first, second]);
    if (!firstSelection.ok || !secondSelection.ok) {
      throw new Error(`joined capture failed: ${!firstSelection.ok ? firstSelection.code : "first-ok"}/${!secondSelection.ok ? secondSelection.code : "second-ok"}`);
    }
    expect(firstSelection.observation).toBe("captured-now");
    expect(secondSelection.observation).toBe("captured-now");
    expect(firstSelection.capture).toBe(secondSelection.capture);
    expect(sharedController.signal.aborted).toBe(false);
    expect(joinedFixture.runner.requests.length).toBe(joinedCalls);
    const joinedInspection = joinedFixture.root.entry.harnessInspect?.(joinedFixture.root.host.context);
    expect(joinedInspection?.coordinator?.output.retainedCaptures).toBe(1);
    expect(joinedInspection?.coordinator?.output.active).toBe(false);
    joinedFixture.root.entry.dispose();

    const trackedFixture = await startActualHarnessCapture();
    await beginWork(trackedFixture.root, "different signal capture work");
    const trackedExecution = await executeActualHarness(
      trackedFixture.root,
      "different-signal-call",
      "bounded different signal task",
    );
    await observeActualHarness(trackedFixture.root, trackedExecution);
    const trackedCalls = trackedFixture.runner.requests.length;
    const ownerController = new AbortController();
    const ownerRead = hostCapture(trackedFixture.root, "different-signal-call", ownerController.signal);
    const refusedRead = hostCapture(
      trackedFixture.root,
      "different-signal-call",
      new AbortController().signal,
    );
    const ending = trackedFixture.root.host.emit("agent_end", {});
    const refused = await refusedRead;
    expectCaptureFailure(refused, "capacity");
    const ownerSelection = await ownerRead;
    await ending;
    expectCaptureFailure(ownerSelection, ["cancelled", "authority-lost"]);
    expect(ownerController.signal.aborted).toBe(false);
    expect(trackedFixture.runner.requests.length).toBe(trackedCalls);
    const trackedInspection = trackedFixture.root.entry.harnessInspect?.(trackedFixture.root.host.context);
    expect(trackedInspection?.coordinator?.output.active).toBe(false);
    expect(trackedInspection?.coordinator?.output.retainedCaptures).toBe(0);
    expect(trackedInspection?.coordinator?.operations[0]?.output.state).toBe("failed");
  }, 60_000);

  test("cached capture returns the exact historical object without rechecking disk", async () => {
    const fixture = await startActualHarnessCapture({ candidateText: "cached output\n" });
    await beginWork(fixture.root, "cached capture work");
    const execution = await executeActualHarness(fixture.root, "cached-capture-call", "bounded cached task");
    await observeActualHarness(fixture.root, execution);
    const fresh = await hostCapture(fixture.root, "cached-capture-call");
    if (!fresh.ok) throw new Error(`capture failed: ${fresh.code} ${fresh.reason}`);
    expect(fresh.observation).toBe("captured-now");

    const cached = await hostCapture(fixture.root, "cached-capture-call", new AbortController().signal);
    if (!cached.ok) throw new Error(`cached capture failed: ${cached.code} ${cached.reason}`);
    expect(cached.observation).toBe("cached-historical");
    expect(cached.filesystemFreshness).toBe("not-rechecked");
    expect(cached.capture).toBe(fresh.capture);
    expect(cached.observedResultSha256).toBe(fresh.observedResultSha256);

    await writeFile(path.join(fixture.sourceRoot, "candidate.txt"), "disk mutation after capture\n", { mode: 0o600 });
    const afterMutation = await hostCapture(fixture.root, "cached-capture-call", new AbortController().signal);
    if (!afterMutation.ok) throw new Error(`post-mutation capture failed: ${afterMutation.code} ${afterMutation.reason}`);
    expect(afterMutation.observation).toBe("cached-historical");
    expect(afterMutation.filesystemFreshness).toBe("not-rechecked");
    expect(afterMutation.capture).toBe(fresh.capture);
    const inspection = fixture.root.entry.harnessInspect?.(fixture.root.host.context);
    expect(inspection?.coordinator?.output.retainedCaptures).toBe(1);
    expect(inspection?.coordinator?.output.active).toBe(false);
  }, 30_000);

  test("absent Harness config exposes no host capture control", async () => {
    const root = await startRoot();
    expect(root.entry.harnessCaptureOutput).toBeUndefined();
    expect(root.entry.harnessInspect).toBeUndefined();
    expect(root.entry.getStatus().phase).toBe("ready");
  });
});
