import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DailyConfigError,
  loadDailyConfig,
} from "../../src/daily-config.ts";
import { createHistoryProjectionReader } from "../../src/history-projection.ts";
import {
  HISTORY_LOCATOR_CUSTOM_TYPE,
  HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
} from "../../src/history-session.ts";
import {
  createDailyEntry,
  DAILY_GUIDANCE_TYPE,
  type DailyEntryControls,
  type DailyOmpApi,
} from "../../src/daily-entry.ts";
import { DELIVERY_TOOL } from "../../src/delivery-entry.ts";
import { EXECUTION_TOOL } from "../../src/execution-adapter.ts";
import { HISTORY_TOOL } from "../../src/history-entry.ts";
import {
  clearPublishedTaskOwner,
  currentTaskOwner,
  publishTaskOwner,
  type OmpToolContext,
} from "../../src/task-entry-port.ts";
import { B1_GUIDANCE_TYPE, TASK_CONTROL_TOOL } from "../../src/task-entry.ts";
import { TaskOwner } from "../../src/task-owner.ts";
import { VERIFICATION_TOOL } from "../../src/verification-entry.ts";

const PYTHON = "/Library/Developer/CommandLineTools/usr/bin/python3";
const BUN = process.execPath;
const OWNER_ID = "owner-daily-fixture";
const EVIDENCE_GUIDANCE =
  "For evidence-based work, before finalizing, check important conclusions, summaries, questions and proposed next steps for unstated premises: whether the sources establish the claimed event, entity, time, scope, certainty and links between them. " +
  "Distinguish what sources directly establish from instructions, timestamps and assumptions; do not fill missing events, sequence or causal links from those alone. " +
  "Check that citations support the claims they accompany, not just that the references exist; remove or narrow unsupported claims, make unresolved premises explicit, and keep questions conditional where needed. " +
  "Check consistency across the document and final response. " +
  "Describe checks only within their actual coverage: execution, structure, bytes and reference checks do not establish semantic correctness; self-review and model review are fallible advice, not host acceptance. " +
  "Fixing a checker does not establish that unchanged content is correct. " +
  "Keep this check proportional and report material limitations and revisions without private reasoning or a mandatory long review table.";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<ToolResult>;
}

type Handler = (event: unknown, context: OmpToolContext) => unknown;

interface FakeHost {
  tools: Map<string, RegisteredTool>;
  handlers: Map<string, Handler[]>;
  pi: DailyOmpApi;
}

const roots: string[] = [];
const entries: DailyEntryControls[] = [];

afterEach(async () => {
  for (const entry of entries.splice(0)) {
    try {
      entry.dispose();
    } catch {
      // The test asserts idempotence separately.
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  workspace: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-b3b2-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const configDir = path.join(root, "config");
  await mkdir(configDir, { mode: 0o700 });
  const configPath = path.join(configDir, "agent.json");
  const config = {
    schemaVersion: 1,
    workspaceRoot: workspace,
    inputs: [],
    pythonPath: PYTHON,
    bunPath: BUN,
    ...overrides,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  return { root, workspace, configPath, env: { OMP_AGENT_CONFIG: configPath } };
}

async function writeConfig(fx: Fixture, value: unknown): Promise<void> {
  await writeFile(fx.configPath, JSON.stringify(value), { mode: 0o600 });
}

function baseConfig(fx: Fixture): Record<string, unknown> {
  return {
    schemaVersion: 1,
    workspaceRoot: fx.workspace,
    inputs: [],
    pythonPath: PYTHON,
    bunPath: BUN,
  };
}

function fakeHost(options: {
  failOnTool?: string;
  failOnHandler?: string;
  afterRegister?: (tool: RegisteredTool) => void;
  appendEntry?: <T = unknown>(customType: string, data?: T) => void;
} = {}): FakeHost {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      if (options.failOnHandler === event) {
        throw new Error(`fixture handler registration failure: ${event}`);
      }
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: RegisteredTool) {
      if (options.failOnTool === tool.name) {
        throw new Error(`fixture tool registration failure: ${tool.name}`);
      }
      tools.set(tool.name, tool);
      options.afterRegister?.(tool);
    },
    ...(options.appendEntry === undefined ? {} : { appendEntry: options.appendEntry }),
  } as DailyOmpApi;
  return { tools, handlers, pi };
}

function context(workspace: string, branch: Array<Record<string, unknown>>): OmpToolContext {
  return {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "daily-session",
      getLeafId: () => (branch[branch.length - 1]?.id as string | undefined) ?? null,
      getBranch: () => branch,
    },
  };
}

function userEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

function startMessages(
  fake: FakeHost,
  ctx: OmpToolContext,
  prompt = "An ordinary prompt.",
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const handler of fake.handlers.get("before_agent_start") ?? []) {
    const result = handler({ prompt, reason: "prompt" }, ctx) as
      | { message?: Record<string, unknown> }
      | undefined;
    if (result?.message) messages.push(result.message);
  }
  return messages;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

describe("daily config", () => {
  test("minimal valid config resolves canonical workspace, default state root and empty inputs", async () => {
    const fx = await fixture();
    const config = loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace });
    expect(config.schemaVersion).toBe(1);
    expect(config.workspaceRoot).toBe(await realpath(fx.workspace));
    expect(config.stateRoot).toBe(path.join(config.workspaceRoot, ".omp-agent"));
    expect(config.inputs).toEqual([]);
    expect(config.humanReview).toBeUndefined();
    expect(config.pythonPath).toBe(PYTHON);
    expect(config.bunPath).toBe(BUN);
  });

  test("canonical workspace aliases match on either side of the comparison", async () => {
    const fx = await fixture();
    const alias = path.join(fx.root, "workspace-alias");
    await symlink(fx.workspace, alias, "dir");
    const first = loadDailyConfig({ env: fx.env, launchWorkspace: alias });
    expect(first.workspaceRoot).toBe(await realpath(fx.workspace));

    await writeConfig(fx, { ...baseConfig(fx), workspaceRoot: alias });
    const second = loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace });
    expect(second.workspaceRoot).toBe(await realpath(fx.workspace));
  });

  test("declared input whitelist uses canonical regular files outside managed state", async () => {
    const fx = await fixture();
    const inputPath = path.join(fx.root, "input.txt");
    await writeFile(inputPath, "host input\n", { mode: 0o600 });
    await writeConfig(fx, {
      ...baseConfig(fx),
      inputs: [{ id: "source", path: inputPath }],
    });
    const config = loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace });
    expect(config.inputs).toEqual([{ id: "source", path: await realpath(inputPath) }]);
  });

  test("exact human-review opt-in maps to the existing local-main-tui component; false is off", async () => {
    const fx = await fixture({ humanReview: "local-main-tui-v1" });
    expect(loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace }).humanReview)
      .toEqual({ kind: "local-main-tui", policyVersion: 1 });

    await writeConfig(fx, { ...baseConfig(fx), humanReview: false });
    expect(loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace }).humanReview).toBeUndefined();
  });

  test("missing or relative OMP_AGENT_CONFIG is refused", async () => {
    expect(() => loadDailyConfig({ env: {}, launchWorkspace: process.cwd() }))
      .toThrow(DailyConfigError);
    expect(() => loadDailyConfig({
      env: { OMP_AGENT_CONFIG: "relative.json" },
      launchWorkspace: process.cwd(),
    })).toThrow(/absolute path/);
  });

  const invalid: Array<{
    name: string;
    prepare: (fx: Fixture) => Promise<Record<string, unknown>>;
    pattern: RegExp;
  }> = [
    {
      name: "unknown top-level field",
      prepare: async (fx) => ({ ...baseConfig(fx), endpoint: "https://not-allowed" }),
      pattern: /unsupported field/,
    },
    {
      name: "unknown humanReview value",
      prepare: async (fx) => ({ ...baseConfig(fx), humanReview: "local-main-tui-v2" }),
      pattern: /humanReview/,
    },
    {
      name: "unknown input field",
      prepare: async (fx) => {
        const file = path.join(fx.root, "one.txt");
        await writeFile(file, "x");
        return { ...baseConfig(fx), inputs: [{ id: "one", path: file, credential: "no" }] };
      },
      pattern: /unsupported field/,
    },
    {
      name: "wrong schema version",
      prepare: async (fx) => ({ ...baseConfig(fx), schemaVersion: 2 }),
      pattern: /schemaVersion/,
    },
    {
      name: "missing inputs",
      prepare: async (fx) => {
        const config = baseConfig(fx);
        delete config.inputs;
        return config;
      },
      pattern: /inputs/,
    },
    {
      name: "relative workspaceRoot",
      prepare: async (fx) => ({ ...baseConfig(fx), workspaceRoot: "workspace" }),
      pattern: /workspaceRoot/,
    },
    {
      name: "workspaceRoot mismatch",
      prepare: async (fx) => {
        const other = path.join(fx.root, "other-workspace");
        await mkdir(other, { mode: 0o700 });
        return { ...baseConfig(fx), workspaceRoot: other };
      },
      pattern: /does not match/,
    },
    {
      name: "relative stateRoot",
      prepare: async (fx) => ({ ...baseConfig(fx), stateRoot: "state" }),
      pattern: /stateRoot/,
    },
    {
      name: "stateRoot equals workspace",
      prepare: async (fx) => ({ ...baseConfig(fx), stateRoot: fx.workspace }),
      pattern: /stateRoot/,
    },
    {
      name: "relative pythonPath",
      prepare: async (fx) => ({ ...baseConfig(fx), pythonPath: "python3" }),
      pattern: /pythonPath/,
    },
    {
      name: "input outside the whitelist form",
      prepare: async (fx) => ({ ...baseConfig(fx), inputs: [{ id: "one", path: "relative.txt" }] }),
      pattern: /absolute path/,
    },
    {
      name: "duplicate input id",
      prepare: async (fx) => {
        const a = path.join(fx.root, "a.txt");
        const b = path.join(fx.root, "b.txt");
        await writeFile(a, "a");
        await writeFile(b, "b");
        return {
          ...baseConfig(fx),
          inputs: [{ id: "same", path: a }, { id: "same", path: b }],
        };
      },
      pattern: /duplicates/,
    },
    {
      name: "input directory",
      prepare: async (fx) => {
        const directory = path.join(fx.root, "inputs");
        await mkdir(directory, { mode: 0o700 });
        return { ...baseConfig(fx), inputs: [{ id: "one", path: directory }] };
      },
      pattern: /regular file/,
    },
    {
      name: "input symbolic link",
      prepare: async (fx) => {
        const file = path.join(fx.root, "real.txt");
        const alias = path.join(fx.root, "alias.txt");
        await writeFile(file, "x");
        await symlink(file, alias, "file");
        return { ...baseConfig(fx), inputs: [{ id: "one", path: alias }] };
      },
      pattern: /symbolic link/,
    },
    {
      name: "input with multiple hard links",
      prepare: async (fx) => {
        const file = path.join(fx.root, "linked.txt");
        const second = path.join(fx.root, "linked-2.txt");
        await writeFile(file, "x");
        await link(file, second);
        return { ...baseConfig(fx), inputs: [{ id: "one", path: file }] };
      },
      pattern: /hard link/,
    },
    {
      name: "input inside managed state",
      prepare: async (fx) => {
        const stateRoot = path.join(fx.root, "state");
        await mkdir(stateRoot, { mode: 0o700 });
        const inside = path.join(stateRoot, "input.txt");
        await writeFile(inside, "x");
        return {
          ...baseConfig(fx),
          stateRoot,
          inputs: [{ id: "one", path: inside }],
        };
      },
      pattern: /managed internal state/,
    },
  ];

  for (const item of invalid) {
    test(`invalid config is refused: ${item.name}`, async () => {
      const fx = await fixture();
      await writeConfig(fx, await item.prepare(fx));
      expect(() => loadDailyConfig({ env: fx.env, launchWorkspace: fx.workspace }))
        .toThrow(item.pattern);
    });
  }
});

describe("daily composition", () => {
  test("ready composition creates one owner, one fresh instance and all managed tools", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);

    expect(entry.isReady()).toBe(true);
    expect(currentTaskOwner()).toBe(entry.owner);
    expect([...fake.tools.keys()].sort()).toEqual(
      [TASK_CONTROL_TOOL, EXECUTION_TOOL, VERIFICATION_TOOL, DELIVERY_TOOL, HISTORY_TOOL].sort(),
    );
    expect(entry.execution.delivery?.deliveryRootPath()).toBe(entry.instance.deliveryRoot);
    expect(entry.execution.acceptance?.humanReviewConfigured()).toBe(false);
    expect(entry.owner.snapshot().authorizedCapabilities).toEqual(["local-script"]);
    expect(entry.history.status()).toMatchObject({
      capture: "ready",
      locator: "unavailable",
      captured: 0,
      pending: 0,
      visible: 0,
      incomplete: 0,
      unknown: 0,
    });

    const state = JSON.parse(await readFile(entry.instance.statePath, "utf8")) as Record<string, unknown>;
    expect(state.schemaVersion).toBe(1);
    expect(state.ownerId).toBe(entry.owner.ownerId);
    expect(state.workspaceRoot).toBe(entry.config.workspaceRoot);
    const audit = await readFile(entry.instance.auditPath, "utf8");
    expect(audit).toContain('"type":"entry_started"');
    expect(audit).toContain('"type":"execution_entry_started"');
    expect(audit).toContain('"type":"daily_entry_ready"');

    const roots = [entry.instance.executionRoot, entry.instance.deliveryRoot, entry.instance.acceptanceRoot];
    for (let i = 0; i < roots.length; i += 1) {
      for (let j = i + 1; j < roots.length; j += 1) {
        expect(within(roots[i]!, roots[j]!)).toBe(false);
        expect(within(roots[j]!, roots[i]!)).toBe(false);
      }
      expect(within(entry.instance.root, roots[i]!)).toBe(true);
    }
    expect(await mode(entry.instance.root)).toBe(0o700);
    for (const root of roots) expect(await mode(root)).toBe(0o700);
    expect(await mode(entry.instance.statePath)).toBe(0o600);
    expect(await mode(entry.instance.auditPath)).toBe(0o600);
  });

  test("active main composition adds fixed workflow guidance beside task guidance", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);

    const messages = startMessages(fake, context(fx.workspace, []));
    const daily = messages.filter((message) => message.customType === DAILY_GUIDANCE_TYPE);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({ display: false, attribution: "agent" });
    const content = daily[0]!.content;
    expect(typeof content).toBe("string");
    expect(content).toContain(EXECUTION_TOOL);
    expect(content).toContain(VERIFICATION_TOOL);
    expect(content).toContain(DELIVERY_TOOL);
    expect(content).toContain("Native workspace writes and shell self-tests do not create managed candidates or receipts");
    expect(content).toContain(EVIDENCE_GUIDANCE);
    expect(String(content).split(EVIDENCE_GUIDANCE)).toHaveLength(2);
    expect(messages.filter((message) => message.customType === B1_GUIDANCE_TYPE)).toHaveLength(1);
  });

  test("workflow guidance is main-only and disappears when disposed", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const main = context(fx.workspace, []);
    const hasDailyGuidance = (ctx: OmpToolContext): boolean =>
      startMessages(fake, ctx).some((message) => message.customType === DAILY_GUIDANCE_TYPE);
    expect(hasDailyGuidance(main)).toBe(true);

    const sub = { ...main, agent: { kind: "sub" as const } };
    expect(hasDailyGuidance(sub)).toBe(false);

    entry.dispose();
    expect(hasDailyGuidance(main)).toBe(false);
  });

  test("successive startups create fresh instances and preserve previous files", async () => {
    const fx = await fixture();
    const first = createDailyEntry(fakeHost().pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(first);
    const firstState = await readFile(first.instance.statePath, "utf8");
    first.dispose();
    expect(currentTaskOwner()).toBeUndefined();

    const second = createDailyEntry(fakeHost().pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(second);
    expect(second.instance.root).not.toBe(first.instance.root);
    expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
    expect(await readFile(first.instance.statePath, "utf8")).toBe(firstState);
    const firstAudit = await readFile(first.instance.auditPath, "utf8");
    expect(firstAudit).toContain('"type":"daily_entry_ready"');
    expect(firstAudit).toContain('"instanceId":"' + first.instance.instanceId + '"');
    expect(firstAudit).toContain('"type":"execution_adapter_disposed"');
    expect((await stat(first.instance.root)).isDirectory()).toBe(true);
    expect((await stat(second.instance.root)).isDirectory()).toBe(true);
  });

  test("an existing published owner is preserved and never replaced", async () => {
    const fx = await fixture();
    const foreign = new TaskOwner({ workspaceRoot: fx.workspace, ownerId: OWNER_ID });
    publishTaskOwner(foreign);
    const fake = fakeHost();
    expect(() => createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace }))
      .toThrow(/already published/);
    expect(currentTaskOwner()).toBe(foreign);
    expect(fake.tools.size).toBe(0);
    expect(fake.handlers.size).toBe(0);
    clearPublishedTaskOwner(foreign);
  });

  test("a second composition in the same process refuses and leaves the ready owner intact", async () => {
    const fx = await fixture();
    const first = createDailyEntry(fakeHost().pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(first);
    const secondHost = fakeHost();
    expect(() => createDailyEntry(secondHost.pi, { env: fx.env, launchWorkspace: fx.workspace }))
      .toThrow(/already published/);
    expect(currentTaskOwner()).toBe(first.owner);
    expect(first.isReady()).toBe(true);
    expect(secondHost.tools.size).toBe(0);
  });

  test("partial registration failure leaves installed handlers and tools inert", async () => {
    const fx = await fixture();
    const fake = fakeHost({ failOnTool: VERIFICATION_TOOL });
    expect(() => createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace }))
      .toThrow(/fixture tool registration failure/);
    expect(currentTaskOwner()).toBeUndefined();
    expect(fake.tools.has(TASK_CONTROL_TOOL)).toBe(true);
    expect(fake.tools.has(HISTORY_TOOL)).toBe(true);
    expect(fake.tools.has(VERIFICATION_TOOL)).toBe(false);

    const ctx = context(fx.workspace, []);
    const history = await fake.tools.get(HISTORY_TOOL)!.execute(
      "call-history",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(history.isError).toBe(true);
    expect(history.content[0]!.text).toContain("not active");
    const result = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-1",
      { action: "inspect" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not active");
    const input = fake.handlers.get("input")?.[0];
    expect(input).toBeDefined();
    expect(input!({ text: "do managed work", source: "rpc" }, ctx)).toBeUndefined();
    expect(startMessages(fake, ctx)).toEqual([]);
    expect(currentTaskOwner()).toBeUndefined();
    const shutdown = fake.handlers.get("session_shutdown")?.[0];
    expect(() => shutdown?.({}, ctx)).not.toThrow();
    expect(() => shutdown?.({}, ctx)).not.toThrow();
  });

  test("a registration callback that publishes another owner is rejected without clearing it", async () => {
    const fx = await fixture();
    let foreign: TaskOwner | undefined;
    const fake = fakeHost({
      afterRegister(tool) {
        if (tool.name !== EXECUTION_TOOL) return;
        foreign = new TaskOwner({ workspaceRoot: fx.workspace, ownerId: "owner-daily-replacement" });
        publishTaskOwner(foreign);
      },
    });
    expect(() => createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace }))
      .toThrow(/owner changed/);
    expect(foreign).toBeDefined();
    expect(currentTaskOwner()).toBe(foreign!);
    const result = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-1",
      { action: "inspect" },
      undefined,
      undefined,
      context(fx.workspace, []),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not active");
    clearPublishedTaskOwner(foreign!);
  });

  test("dispose and shutdown are idempotent, deactivate first and preserve records", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    expect(entry.isReady()).toBe(true);

    entry.dispose();
    entry.dispose();
    expect(entry.isReady()).toBe(false);
    expect(currentTaskOwner()).toBeUndefined();
    expect(entry.historyQuery.status()).toMatchObject({ disposed: true, view: "none", selectors: 0 });
    const historyResult = await fake.tools.get(HISTORY_TOOL)!.execute(
      "call-history",
      { action: "list" },
      undefined,
      undefined,
      context(fx.workspace, []),
    );
    expect(historyResult.isError).toBe(true);
    expect(historyResult.content[0]!.text).toContain("not active");
    const result = await fake.tools.get(EXECUTION_TOOL)!.execute(
      "call-1",
      { action: "describe" },
      undefined,
      undefined,
      context(fx.workspace, []),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not active");

    const shutdown = fake.handlers.get("session_shutdown")![0]!;
    expect(() => shutdown({}, context(fx.workspace, []))).not.toThrow();
    expect(() => shutdown({}, context(fx.workspace, []))).not.toThrow();
    expect(currentTaskOwner()).toBeUndefined();
    expect((await stat(entry.instance.statePath)).isFile()).toBe(true);
    expect(await readFile(entry.instance.auditPath, "utf8")).toContain('"type":"daily_entry_ready"');
  });

  test("the same owner and store survive ordinary successive turns", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    let leafId = "leaf-1";
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-session",
        getLeafId: () => leafId,
        getBranch: () => branch,
      },
    };

    branch.push(userEntry("user-1", "leaf-1", "Own the first managed turn."));
    fake.handlers.get("input")![0]!({ text: "Own the first managed turn.", source: "rpc" }, ctx);
    const guidance = startMessages(fake, ctx, "Own the first managed turn.");
    expect(guidance.some((message) => message.customType === DAILY_GUIDANCE_TYPE)).toBe(true);
    let guidanceParent = "user-1";
    for (const [index, message] of guidance.entries()) {
      const id = `guidance-${index + 1}`;
      branch.push({
        id,
        parentId: guidanceParent,
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: message.display,
        attribution: message.attribution,
      });
      guidanceParent = id;
    }
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError).toBeUndefined();
    const task = entry.owner.snapshot().currentTask!;
    expect(task.status).toBe("active");

    branch.push({
      id: "assistant-1",
      parentId: guidanceParent,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "working" }], attribution: "agent" },
    });
    fake.handlers.get("agent_end")![0]!({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Own the first managed turn." }],
        attribution: "user",
        id: "user-1",
      }],
    }, ctx);
    leafId = "assistant-1";
    expect(currentTaskOwner()).toBe(entry.owner);
    expect(entry.isReady()).toBe(true);

    branch.push(userEntry("user-2", "assistant-1", "A later ordinary turn."));
    fake.handlers.get("input")![0]!({ text: "A later ordinary turn.", source: "rpc" }, ctx);
    fake.handlers.get("before_agent_start")![0]!(
      { prompt: "A later ordinary turn.", reason: "prompt" },
      ctx,
    );
    const inspected = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-inspect",
      { action: "inspect" },
      undefined,
      undefined,
      ctx,
    );
    expect(inspected.isError).toBeUndefined();
    const details = inspected.details as { task: { taskId: string; taskRevision: number } };
    expect(details.task.taskId).toBe(task.taskId);
    expect(details.task.taskRevision).toBe(task.taskRevision);
    expect(currentTaskOwner()).toBe(entry.owner);
    expect(entry.owner.snapshot().currentTask!.taskId).toBe(task.taskId);
  });

  test("scattered legacy environment enables and roots do not override the host config", async () => {
    const fx = await fixture();
    const fake = fakeHost();
    const env: NodeJS.ProcessEnv = {
      ...fx.env,
      OMP_AGENT_HUMAN_REVIEW: "local-main-tui-v1",
      OMP_AGENT_EXECUTION_ROOT: "/definitely/not/execution",
      OMP_AGENT_DELIVERY_ROOT: "/definitely/not/delivery",
      OMP_AGENT_ACCEPTANCE_ROOT: "/definitely/not/acceptance",
      OMP_AGENT_EXECUTION_INPUTS: "not-json",
    };
    const entry = createDailyEntry(fake.pi, { env, launchWorkspace: fx.workspace });
    entries.push(entry);
    expect(entry.execution.acceptance?.humanReviewConfigured()).toBe(false);
    expect(entry.execution.delivery?.deliveryRootPath()).toBe(entry.instance.deliveryRoot);
    expect(entry.isReady()).toBe(true);
  });

  test("explicit config opt-in enables the existing human review component", async () => {
    const fx = await fixture({ humanReview: "local-main-tui-v1" });
    const entry = createDailyEntry(fakeHost().pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    expect(entry.execution.acceptance?.humanReviewConfigured()).toBe(true);
  });

  test("daily history captures a real task commit and publishes one exact native locator from main agent_end", async () => {
    const fx = await fixture();
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    let leafId = "leaf-1";
    let ensureCalls = 0;
    const appendCalls: Array<{ customType: string; data: unknown }> = [];
    const appendEntry = <T = unknown>(customType: string, data?: T): void => {
      appendCalls.push({ customType, data });
      const id = `locator-${appendCalls.length}`;
      branch.push({ id, parentId: leafId, type: "custom", customType, data });
      leafId = id;
    };
    const fake = fakeHost({ appendEntry });
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const sessionFile = path.join(fx.root, "history-session.jsonl");
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-history-session",
        getLeafId: () => leafId,
        getBranch: () => branch.slice(),
        getSessionFile: () => sessionFile,
        ensureOnDisk: async () => { ensureCalls += 1; },
      },
    };

    branch.push(userEntry("user-1", "leaf-1", "Own this history task."));
    fake.handlers.get("input")![0]!({ text: "Own this history task.", source: "rpc" }, ctx);
    startMessages(fake, ctx, "Own this history task.");
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError).toBeUndefined();
    const task = entry.owner.snapshot().currentTask!;
    expect(entry.history.status()).toMatchObject({ captured: 1, pending: 1, visible: 0 });
    expect(appendCalls).toHaveLength(0);

    branch.push({
      id: "assistant-1",
      parentId: "user-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    });
    leafId = "assistant-1";
    const taskEnd = fake.handlers.get("agent_end")![0]!;
    const historyEnd = fake.handlers.get("agent_end")![1]!;
    expect(taskEnd).toBeDefined();
    expect(historyEnd).toBeDefined();
    taskEnd({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Own this history task." }],
        attribution: "user",
        id: "user-1",
      }],
    }, ctx);
    await historyEnd({}, ctx);

    expect(ensureCalls).toBe(1);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.customType).toBe(HISTORY_LOCATOR_CUSTOM_TYPE);
    const locator = branch.at(-1)!;
    expect(locator).toMatchObject({
      type: "custom",
      customType: HISTORY_LOCATOR_CUSTOM_TYPE,
      parentId: "assistant-1",
    });
    expect(leafId).toBe(locator.id as string);
    const reader = createHistoryProjectionReader({
      instanceRoot: entry.instance.root,
      instanceId: entry.instance.instanceId,
      ownerId: entry.owner.ownerId,
      workspaceRoot: entry.config.workspaceRoot,
    });
    const page = reader.list({ limit: 16 });
    expect(page.total).toBe(1);
    const data = locator.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual([
      "digest",
      "historyId",
      "instanceId",
      "originSessionId",
      "ownerId",
      "taskId",
      "taskRevision",
      "version",
    ]);
    expect(data).toEqual({
      version: 1,
      instanceId: entry.instance.instanceId,
      ownerId: entry.owner.ownerId,
      historyId: page.items[0]!.historyId,
      digest: page.items[0]!.digest,
      taskId: task.taskId,
      taskRevision: 1,
      originSessionId: "daily-history-session",
    });
    expect(entry.history.status()).toMatchObject({
      pending: 0,
      visible: 1,
      incomplete: 0,
      unknown: 0,
    });
    expect(entry.owner.snapshot().currentTask).toMatchObject({
      taskId: task.taskId,
      taskRevision: 1,
      status: "active",
    });

    const ownerBeforeQuery = entry.owner.snapshot();
    const indexBeforeQuery = await readFile(path.join(entry.instance.root, "history-index.json"));
    const branchLengthBeforeQuery = branch.length;
    const ensureBeforeQuery = ensureCalls;
    const appendBeforeQuery = appendCalls.length;
    const listed = await fake.tools.get(HISTORY_TOOL)!.execute(
      "call-history-list",
      { action: "list" },
      undefined,
      undefined,
      ctx,
    );
    expect(listed.isError).toBeUndefined();
    expect(listed.details).toBeUndefined();
    const listBody = JSON.parse(listed.content[0]!.text) as Record<string, unknown>;
    expect(listBody).toMatchObject({
      schemaVersion: "agent-history-view-v1",
      action: "list",
      scope: "selected_branch",
      result: "visible_history",
    });
    const listItems = listBody.items as Array<Record<string, unknown>>;
    expect(listItems).toHaveLength(1);
    expect(listItems[0]).toMatchObject({
      taskId: task.taskId,
      taskRevision: 1,
      recordedStatus: "active",
      sourceCount: 1,
      amendmentCount: 0,
    });
    expect(listItems[0]!.selector).toMatch(/^hsel_[0-9a-f]{32}$/);
    const inspectedHistory = await fake.tools.get(HISTORY_TOOL)!.execute(
      "call-history-inspect",
      { action: "inspect", selector: listItems[0]!.selector },
      undefined,
      undefined,
      ctx,
    );
    expect(inspectedHistory.isError).toBeUndefined();
    const inspectBody = JSON.parse(inspectedHistory.content[0]!.text) as Record<string, unknown>;
    expect(inspectBody).toMatchObject({
      schemaVersion: "agent-history-view-v1",
      action: "inspect",
      scope: "selected_branch",
    });
    const inspection = inspectBody.item as {
      taskId: string;
      taskRevision: number;
      recordedStatus: string;
      anchor: { sessionId: string };
      requirementSources: Array<{ text: string; kind: string }>;
    };
    expect(inspection).toMatchObject({
      taskId: task.taskId,
      taskRevision: 1,
      recordedStatus: "active",
      anchor: { sessionId: "daily-history-session" },
    });
    expect(inspection.requirementSources).toHaveLength(1);
    expect(inspection.requirementSources[0]).toMatchObject({
      kind: "original",
      text: "Own this history task.",
    });

    branch.push({
      id: "assistant-after-list",
      parentId: leafId,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "later" }] },
    });
    leafId = "assistant-after-list";
    branch.push({
      id: "tool-result-after-list",
      parentId: leafId,
      type: "toolResult",
      toolName: "read",
      data: {},
    });
    leafId = "tool-result-after-list";
    const inspectedAfterAppend = await fake.tools.get(HISTORY_TOOL)!.execute(
      "call-history-inspect-again",
      { action: "inspect", selector: listItems[0]!.selector },
      undefined,
      undefined,
      ctx,
    );
    expect(inspectedAfterAppend.isError).toBeUndefined();
    expect(JSON.parse(inspectedAfterAppend.content[0]!.text).item).toEqual(inspection);

    expect(entry.owner.snapshot()).toEqual(ownerBeforeQuery);
    expect(await readFile(path.join(entry.instance.root, "history-index.json"))).toEqual(indexBeforeQuery);
    expect(branch).toHaveLength(branchLengthBeforeQuery + 2);
    expect(ensureCalls).toBe(ensureBeforeQuery);
    expect(appendCalls).toHaveLength(appendBeforeQuery);
    expect(entry.history.status()).toMatchObject({ pending: 0, visible: 1, incomplete: 0, unknown: 0 });

    expect([...fake.tools.keys()].sort()).toEqual(
      [TASK_CONTROL_TOOL, EXECUTION_TOOL, VERIFICATION_TOOL, DELIVERY_TOOL, HISTORY_TOOL].sort(),
    );

    entry.dispose();
    expect(entry.historyQuery.status()).toMatchObject({ disposed: true, view: "none", selectors: 0 });
    expect(entry.history.status().pending).toBe(0);
    expect(entry.history.status().visible).toBe(1);
  });

  test("daily publishes the task locator before a real execution run locator from the same main agent_end", async () => {
    const fx = await fixture();
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    let leafId = "leaf-1";
    let ensureCalls = 0;
    const appendCalls: Array<{ customType: string; data: unknown }> = [];
    const appendEntry = <T = unknown>(customType: string, data?: T): void => {
      appendCalls.push({ customType, data });
      const id = `entry-${appendCalls.length}`;
      branch.push({ id, parentId: leafId, type: "custom", customType, data });
      leafId = id;
    };
    const fake = fakeHost({ appendEntry });
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const sessionFile = path.join(fx.root, "daily-run-session.jsonl");
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-run-session",
        getLeafId: () => leafId,
        getBranch: () => branch.slice(),
        getSessionFile: () => sessionFile,
        ensureOnDisk: async () => { ensureCalls += 1; },
      },
    };

    branch.push(userEntry("user-1", "leaf-1", "Generate the daily artifact."));
    fake.handlers.get("input")![0]!({ text: "Generate the daily artifact.", source: "rpc" }, ctx);
    startMessages(fake, ctx, "Generate the daily artifact.");
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError).toBeUndefined();
    const task = entry.owner.snapshot().currentTask!;
    expect(entry.history.status()).toMatchObject({ captured: 1, pending: 1, visible: 0 });

    const executed = await fake.tools.get(EXECUTION_TOOL)!.execute(
      "call-execute",
      {
        action: "run",
        runtime: "python",
        source: "open('daily-run.txt', 'wb').write(b'daily artifact bytes\\n')\n",
        expectedTaskId: task.taskId,
        expectedTaskRevision: 1,
      },
      undefined,
      undefined,
      ctx,
    );
    expect(executed.isError).toBeUndefined();
    const executionDetails = executed.details as Record<string, any>;
    expect(executionDetails.artifacts).toHaveLength(1);
    expect(executionDetails.taskId).toBe(task.taskId);
    expect(entry.history.status()).toMatchObject({ captured: 1, pending: 1, visible: 0, run: { visible: 0 } });

    branch.push({
      id: "assistant-1",
      parentId: "user-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "working" }] },
    });
    leafId = "assistant-1";
    const taskEnd = fake.handlers.get("agent_end")![0]!;
    const historyEnd = fake.handlers.get("agent_end")![1]!;
    taskEnd({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Generate the daily artifact." }],
        attribution: "user",
        id: "user-1",
      }],
    }, ctx);
    await historyEnd({}, ctx);

    expect(ensureCalls).toBe(1);
    expect(appendCalls.map((call) => call.customType)).toEqual([
      HISTORY_LOCATOR_CUSTOM_TYPE,
      HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
    ]);
    const reader = createHistoryProjectionReader({
      instanceRoot: entry.instance.root,
      instanceId: entry.instance.instanceId,
      ownerId: entry.owner.ownerId,
      workspaceRoot: entry.config.workspaceRoot,
    });
    const page = reader.list({ limit: 16 });
    expect(page.total).toBe(1);
    const runData = appendCalls[1]!.data as Record<string, unknown>;
    const runDirectory = String(executionDetails.hostRecordRef).split("/")[0]!;
    expect(runData).toEqual({
      version: 1,
      instanceId: entry.instance.instanceId,
      ownerId: entry.owner.ownerId,
      historyId: page.items[0]!.historyId,
      digest: page.items[0]!.digest,
      taskId: task.taskId,
      taskRevision: 1,
      requirementsDigest: page.items[0]!.requirementsDigest,
      originSessionId: "daily-run-session",
      runId: executionDetails.runId,
      callId: executionDetails.callId,
      runDirectory,
      artifactIds: executionDetails.artifacts.map((artifact: any) => artifact.artifactId),
      recordWriteReturned: true,
      byteIntegrity: "not_checked",
      authorityRestored: false,
    });
    const record = JSON.parse(await readFile(
      path.join(entry.instance.executionRoot, runDirectory, "record.json"),
      "utf8",
    ));
    expect(record.phase).toBe("completed");
    expect(record.runId).toBe(executionDetails.runId);
    expect(record.callId).toBe(executionDetails.callId);
    expect(record.taskId).toBe(task.taskId);
    expect(record.taskRevision).toBe(1);
    expect(record.artifacts.map((artifact: any) => artifact.artifactId))
      .toEqual(runData.artifactIds);
    const artifact = record.artifacts[0];
    expect(await readFile(path.join(entry.instance.executionRoot, artifact.archiveRef), "utf8"))
      .toBe("daily artifact bytes\n");
    expect(entry.history.status()).toMatchObject({
      pending: 0,
      visible: 1,
      run: { observed: 1, visible: 1, incomplete: 0, unknown: 0 },
    });

    await historyEnd({}, ctx);
    expect(appendCalls).toHaveLength(2);
    expect(ensureCalls).toBe(1);
    expect(entry.owner.snapshot().currentTask).toMatchObject({
      taskId: task.taskId,
      taskRevision: 1,
      status: "active",
    });
  });

  test("guarded describe withholds metadata when the published owner is replaced during input await", async () => {
    const fx = await fixture();
    const inputPath = path.join(fx.root, "describe-input.txt");
    await writeFile(inputPath, "describe input\n", { mode: 0o600 });
    await writeConfig(fx, {
      ...baseConfig(fx),
      inputs: [{ id: "alpha", path: inputPath }],
    });
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-describe-race",
        getLeafId: () => "leaf-1",
        getBranch: () => branch.slice(),
      },
    };
    branch.push(userEntry("user-1", "leaf-1", "Describe only."));
    fake.handlers.get("input")![0]!({ text: "Describe only.", source: "rpc" }, ctx);
    startMessages(fake, ctx, "Describe only.");
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError, JSON.stringify(started.details)).toBeUndefined();
    const task = entry.owner.snapshot().currentTask!;
    const valid = await fake.tools.get(EXECUTION_TOOL)!.execute(
      "call-describe-valid",
      { action: "describe", expectedTaskId: task.taskId, expectedTaskRevision: 1 },
      undefined,
      undefined,
      ctx,
    );
    expect(valid.isError).toBeUndefined();
    expect(valid.details).toMatchObject({ action: "describe", taskId: task.taskId, taskRevision: 1 });
    expect(valid.content[0]!.text).toContain("describe-input.txt");
    const wrong = await fake.tools.get(EXECUTION_TOOL)!.execute(
      "call-describe-wrong",
      { action: "describe", expectedTaskId: task.taskId, expectedTaskRevision: 2 },
      undefined,
      undefined,
      ctx,
    );
    expect(wrong.isError).toBe(true);
    expect((wrong.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
    expect(JSON.stringify(wrong)).not.toContain("describe-input.txt");
    const pending = fake.tools.get(EXECUTION_TOOL)!.execute(
      "call-describe",
      { action: "describe", expectedTaskId: task.taskId, expectedTaskRevision: 1 },
      undefined,
      undefined,
      ctx,
    );
    // The entry parsed and began input inspection; the old owner stays
    // attached and unchanged. Replacing the published owner must refuse the
    // already-running describe before it can return input metadata.
    const foreign = new TaskOwner({ workspaceRoot: fx.workspace, ownerId: "owner-daily-foreign" });
    publishTaskOwner(foreign);
    try {
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("owner");
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("describe-input.txt");
      expect(currentTaskOwner()).toBe(foreign);
      expect(entry.owner.bindingStatus().state).toBe("attached");
      expect(entry.owner.snapshot().currentTask).toMatchObject({
        taskId: task.taskId,
        taskRevision: 1,
        status: "active",
        admissions: 0,
        acceptance: null,
      });
    } finally {
      clearPublishedTaskOwner(foreign);
    }
  });

  test("guarded describe rechecks a foreign publish at the entry microtask boundary", async () => {
    const fx = await fixture();
    const inputPath = path.join(fx.root, "describe-boundary-input.txt");
    await writeFile(inputPath, "boundary input\n", { mode: 0o600 });
    await writeConfig(fx, {
      ...baseConfig(fx),
      inputs: [{ id: "alpha", path: inputPath }],
    });
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    const foreign = new TaskOwner({ workspaceRoot: fx.workspace, ownerId: "owner-daily-boundary" });
    let branchReads = 0;
    let armed = false;
    let publishedByGetter = false;
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-describe-boundary",
        getLeafId: () => "leaf-1",
        getBranch: () => {
          branchReads += 1;
          if (armed && branchReads === 2) {
            // Queue after the adapter's final context inspection and internal
            // seal but before the entry's continuation of
            // `await adapter.describe` runs.
            queueMicrotask(() => {
              publishTaskOwner(foreign);
              publishedByGetter = true;
            });
          }
          return branch.slice();
        },
      },
    };
    branch.push(userEntry("user-1", "leaf-1", "Describe only."));
    fake.handlers.get("input")![0]!({ text: "Describe only.", source: "rpc" }, ctx);
    startMessages(fake, ctx, "Describe only.");
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError, JSON.stringify(started.details)).toBeUndefined();
    // Start's branch reads happen while the getter is unarmed, so no foreign
    // publish may occur before this describe is armed.
    expect(currentTaskOwner()).toBe(entry.owner);
    expect(publishedByGetter).toBe(false);
    const task = entry.owner.snapshot().currentTask!;
    // Count only this describe's reads. The second read is the adapter's final
    // context inspection after the real input await.
    branchReads = 0;
    armed = true;
    try {
      const result = await fake.tools.get(EXECUTION_TOOL)!.execute(
        "call-describe-boundary",
        { action: "describe", expectedTaskId: task.taskId, expectedTaskRevision: 1 },
        undefined,
        undefined,
        ctx,
      );
      expect(publishedByGetter).toBe(true);
      expect(branchReads).toBe(2);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("owner");
      expect(result.content[0]!.text).toContain("this entry can no longer act for the current task");
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("boundary-input.txt");
      expect(currentTaskOwner()).toBe(foreign);
      expect(entry.owner.bindingStatus().state).toBe("attached");
      expect(entry.owner.snapshot().currentTask).toMatchObject({
        taskId: task.taskId,
        taskRevision: 1,
        status: "active",
      });
      const audit = await readFile(entry.instance.auditPath, "utf8");
      expect(audit).toContain('"type":"execution_tool_rejected"');
      expect(audit).not.toContain('"type":"execution_describe_withheld"');
    } finally {
      clearPublishedTaskOwner(foreign);
    }
  });

  test("guarded describe withholds metadata when the published owner is cleared during input await", async () => {
    const fx = await fixture();
    const inputPath = path.join(fx.root, "describe-clear-input.txt");
    await writeFile(inputPath, "clear input\n", { mode: 0o600 });
    await writeConfig(fx, {
      ...baseConfig(fx),
      inputs: [{ id: "alpha", path: inputPath }],
    });
    const fake = fakeHost();
    const entry = createDailyEntry(fake.pi, { env: fx.env, launchWorkspace: fx.workspace });
    entries.push(entry);
    const branch: Array<Record<string, unknown>> = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    ];
    const ctx: OmpToolContext = {
      cwd: fx.workspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "daily-describe-clear",
        getLeafId: () => "leaf-1",
        getBranch: () => branch.slice(),
      },
    };
    branch.push(userEntry("user-1", "leaf-1", "Describe only."));
    fake.handlers.get("input")![0]!({ text: "Describe only.", source: "rpc" }, ctx);
    startMessages(fake, ctx, "Describe only.");
    const started = await fake.tools.get(TASK_CONTROL_TOOL)!.execute(
      "call-start",
      { action: "start" },
      undefined,
      undefined,
      ctx,
    );
    expect(started.isError, JSON.stringify(started.details)).toBeUndefined();
    const task = entry.owner.snapshot().currentTask!;
    try {
      const pending = fake.tools.get(EXECUTION_TOOL)!.execute(
        "call-describe-clear",
        { action: "describe", expectedTaskId: task.taskId, expectedTaskRevision: 1 },
        undefined,
        undefined,
        ctx,
      );
      clearPublishedTaskOwner();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("owner");
      expect((result.details as Record<string, unknown>).authorizedInputs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("clear-input.txt");
      expect(currentTaskOwner()).toBeUndefined();
      expect(entry.owner.bindingStatus().state).toBe("attached");
      expect(entry.owner.snapshot().currentTask).toMatchObject({
        taskId: task.taskId,
        taskRevision: 1,
        status: "active",
        admissions: 0,
        acceptance: null,
      });
      const audit = await readFile(entry.instance.auditPath, "utf8");
      expect(audit).toContain('"type":"execution_tool_rejected"');
      expect(audit).not.toContain('"type":"execution_describe_withheld"');
    } finally {
      clearPublishedTaskOwner();
    }
  });
});
