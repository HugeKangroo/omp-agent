import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
} from "../../src/native-entry.ts";
import {
  clearPublishedTaskOwner,
  publishTaskOwner,
} from "../../src/task-entry-port.ts";
import type { TaskOwner } from "../../src/task-owner.ts";
import {
  createNativeHarnessDelegation,
  NATIVE_HARNESS_MAX_TASK_BYTES,
  type NativeHarnessBackend,
  type NativeHarnessDelegationCoordinator,
  type NativeHarnessDelegationPolicy,
  type NativeHarnessDelegationResult,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import type {
  Runner,
  WorkerRequest,
  WorkerResult,
} from "../../vendor/harness2/index.ts";

const AGENT_HARNESS = "agent_harness";
const WORK_TASK = "do the bounded delegated task";

type RegisteredTool = Parameters<NativeOmpApi["registerTool"]>[0];
type Handler = (event: unknown, context: NativeContext) => unknown;

class Host {
  readonly handlers = new Map<string, Handler[]>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly pi: NativeOmpApi;

  constructor() {
    const handlers = this.handlers;
    const tools = this.tools;
    this.pi = {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    };
  }

  async emit(type: string, event: Record<string, unknown>, context: NativeContext): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(type) ?? []) {
      result = await handler({ ...event, type }, context);
    }
    return result;
  }
}

interface Fixture {
  root: string;
  workspace: string;
  host: Host;
  entry: NativeEntryControls;
  ctx: NativeContext;
  setSessionId(value: string): void;
  setLiveCwd(value: string): void;
}

const roots: string[] = [];
const entries: NativeEntryControls[] = [];
const coordinators: NativeHarnessDelegationCoordinator[] = [];

afterEach(async () => {
  clearPublishedTaskOwner();
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  for (const entry of entries.splice(0)) entry.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g52a-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  let sessionId = "session-g52a";
  const liveCwd = workspace;
  const host = new Host();
  const ctx: NativeContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getCwd() {
        return liveCwd;
      },
    },
  };
  const entry = createNativeEntry(host.pi);
  entries.push(entry);
  return {
    root,
    workspace,
    host,
    entry,
    ctx,
    setSessionId(value) {
      sessionId = value;
    },
    setLiveCwd(value) {
      (ctx.sessionManager as { getCwd(): string }).getCwd = () => value;
    },
  };
}

async function input(f: Fixture, text: string): Promise<void> {
  await f.host.emit("input", { text, source: "rpc" }, f.ctx);
}

async function startWork(f: Fixture, prompt: string): Promise<void> {
  await input(f, prompt);
  await f.host.emit("before_agent_start", {
    reason: "prompt",
    prompt,
    systemPrompt: ["base"],
  }, f.ctx);
}

async function callHarness(f: Fixture, toolCallId = "call-1"): Promise<void> {
  await f.host.emit("tool_call", {
    toolCallId,
    toolName: AGENT_HARNESS,
    input: { task: WORK_TASK },
  }, f.ctx);
}

async function navigate(f: Fixture): Promise<void> {
  await f.host.emit("session_switch", {}, f.ctx);
}

async function endWork(f: Fixture): Promise<void> {
  await f.host.emit("agent_end", { messages: [], willContinue: false }, f.ctx);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, ms = 500): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await tick(2);
  }
}

async function settle<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test promise timed out")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function harnessBundle(): WorkerRequest["harness"] {
  return {
    schemaVersion: 1,
    id: "harness-1",
    promptAppend: "",
    toolGuidance: "",
    skills: [],
    rationale: "test",
  };
}

function workerRequest(runId: string, overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  return {
    runId,
    stage: "baseline",
    role: "solver",
    cwd: "/tmp/workspace",
    artifactDir: "/tmp/artifacts",
    prompt: "worker prompt",
    harness: harnessBundle(),
    model: "deepseek/deepseek-chat",
    maxCostUsd: 0.25,
    timeoutMs: 1000,
    ompCommand: "omp",
    ...overrides,
  };
}

function completedResult(costUsd = 0.1, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    text: "untrusted worker text",
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
    startedAt: "2026-11-16T00:00:00.000Z",
    endedAt: "2026-11-16T00:00:01.000Z",
    eventsPath: "/tmp/events.jsonl",
    status: "completed",
    ...overrides,
  };
}

function runnerFor(handler: (request: WorkerRequest) => Promise<WorkerResult>): Runner {
  return { run: handler };
}

interface Calls {
  prepare: number;
  guard: number;
  create: number;
  execute: number;
  cancel: number;
  runner: number;
  getContext: number;
  tasks: string[];
  runIds: string[];
  cancelRunIds: string[];
  requests: NativeHarnessPrepareRequest[];
  workerRequests: WorkerRequest[];
  workerSignals: (AbortSignal | undefined)[];
  workerResults: WorkerResult[];
  dispatchError: string | null;
  lateGuardError: string | null;
  guardWhilePending: string | null;
}

interface PrepareHelpers {
  guard(request: NativeHarnessPrepareRequest): void;
  backend(request: NativeHarnessPrepareRequest): NativeHarnessBackend;
}

interface Hooks {
  policy?: Partial<NativeHarnessDelegationPolicy>;
  enabled?: boolean;
  now?: () => number;
  getContext?: () => NativeContext;
  prepare?: (
    request: NativeHarnessPrepareRequest,
    context: NativeContext,
    calls: Calls,
    helpers: PrepareHelpers,
  ) => NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult>;
  create?: (task: string, calls: Calls) => unknown;
  execute?: (
    runId: string,
    runner: Runner,
    calls: Calls,
    request: NativeHarnessPrepareRequest,
  ) => Promise<unknown>;
  cancel?: (runId: string, calls: Calls) => unknown;
  runner?: Runner;
}

interface Harness {
  coordinator: NativeHarnessDelegationCoordinator;
  calls: Calls;
}

function setup(f: Fixture, hooks: Hooks = {}): Harness {
  const calls: Calls = {
    prepare: 0,
    guard: 0,
    create: 0,
    execute: 0,
    cancel: 0,
    runner: 0,
    getContext: 0,
    tasks: [],
    runIds: [],
    cancelRunIds: [],
    requests: [],
    workerRequests: [],
    workerSignals: [],
    workerResults: [],
    dispatchError: null,
    lateGuardError: null,
    guardWhilePending: null,
  };
  const runner = hooks.runner ?? runnerFor(async () => completedResult(0.1));

  const backendFor = (request: NativeHarnessPrepareRequest): NativeHarnessBackend => ({
    async create(task: string): Promise<unknown> {
      calls.create += 1;
      calls.tasks.push(task);
      if (hooks.create !== undefined) return await hooks.create(task, calls);
      return { runId: "run-1" };
    },
    async execute(runId: string): Promise<unknown> {
      calls.execute += 1;
      calls.runIds.push(runId);
      if (hooks.execute !== undefined) return await hooks.execute(runId, request.runner, calls, request);
      const requestWorker = workerRequest(runId);
      calls.workerRequests.push(requestWorker);
      calls.workerSignals.push(requestWorker.signal);
      calls.runner += 1;
      const result = await request.runner.run(requestWorker);
      calls.workerResults.push(result);
      return { status: result.status };
    },
    async cancel(runId: string): Promise<unknown> {
      calls.cancel += 1;
      calls.cancelRunIds.push(runId);
      if (hooks.cancel !== undefined) return await hooks.cancel(runId, calls);
    },
  });

  const helpers: PrepareHelpers = {
    guard(request) {
      calls.guard += 1;
      request.guard();
    },
    backend: backendFor,
  };

  const prepare = (
    request: NativeHarnessPrepareRequest,
    context: NativeContext,
  ): NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult> => {
    calls.prepare += 1;
    calls.requests.push(request);
    if (hooks.prepare !== undefined) return hooks.prepare(request, context, calls, helpers);
    helpers.guard(request);
    return { ok: true, backend: backendFor(request) };
  };

  const policy: NativeHarnessDelegationPolicy = {
    maxRetainedOperations: 4,
    maxConcurrent: 1,
    perRunUsd: 1,
    lifetimeUsd: 1,
    maxDurationMs: 3000,
    cleanupGraceMs: 20,
    ...hooks.policy,
  };
  const coordinator = createNativeHarnessDelegation({
    native: f.entry,
    policy,
    getContext: () => {
      calls.getContext += 1;
      return hooks.getContext === undefined ? f.ctx : hooks.getContext();
    },
    prepare,
    runner,
    ...(hooks.now === undefined ? {} : { now: hooks.now }),
    enabled: hooks.enabled ?? true,
  });
  coordinators.push(coordinator);
  return { coordinator, calls };
}

async function preparedFixture(prompt = "delegate this"): Promise<Fixture> {
  const f = await fixture();
  await startWork(f, prompt);
  await callHarness(f);
  return f;
}

describe("native Harness2 host-only delegation", () => {
  test("disabled coordinator has zero host/backend effects", async () => {
    const f = await preparedFixture();
    const h = setup(f, { enabled: false });
    const signal = new AbortController().signal;
    const result = await h.coordinator.invoke("call-1", { task: WORK_TASK }, signal);
    expect(result.outcome).toBe("refused");
    expect(result.reason).toContain("disabled");
    expect(result.taskAccepted).toBe(false);
    expect(result.cost).toEqual({ allocatedUsd: 0, observedUsd: 0, unknownUsd: 0, overspendUsd: 0 });
    expect(h.calls.getContext).toBe(0);
    expect(h.calls.prepare).toBe(0);
    expect(h.calls.create).toBe(0);
    expect(h.calls.execute).toBe(0);
    expect(h.calls.runner).toBe(0);
  });

  test("normal run reuses real native association and never claims acceptance", async () => {
    const f = await preparedFixture();
    let clock = 1000;
    const h = setup(f, { now: () => clock });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", WORK_TASK, signal));

    expect(result.outcome).toBe("backend-completed");
    expect(result.resultKind).toBe("live");
    expect(result.historical).toBe(false);
    expect(result.authorityFresh).toBe(true);
    expect(result.taskAccepted).toBe(false);
    expect(result.semanticAcceptance).toBe("not-evaluated");
    expect(result.backendStatus).toBe("completed");
    expect(result.executionState).toBe("settled");
    expect(result.association).toMatchObject({
      toolCallId: "call-1",
      toolName: AGENT_HARNESS,
      sessionId: "session-g52a",
      workspaceRoot: f.workspace,
    });
    expect(result.runId).toBe("run-1");
    expect(result.deadlineAt).toBe(4000);
    expect(result.cost).toEqual({ allocatedUsd: 1, observedUsd: 0.1, unknownUsd: 0, overspendUsd: 0 });
    expect(h.calls.getContext).toBeGreaterThan(0);
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.guard).toBe(1);
    expect(h.calls.requests[0]?.budget.deadlineAt).toBe(4000);
    expect(h.calls.create).toBe(1);
    expect(h.calls.execute).toBe(1);
    expect(h.calls.runner).toBe(1);
    expect(h.calls.tasks).toEqual([WORK_TASK]);
    expect(h.calls.cancel).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cost)).toBe(true);
    expect(Object.isFrozen(result.limitations)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(WORK_TASK);

    const snapshot = h.coordinator.inspect();
    expect(snapshot.activeOperations).toBe(0);
    expect(snapshot.retainedOperations).toBe(1);
    expect(snapshot.lifetime).toMatchObject({
      accountedUsd: 0.1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
      budgetBlocked: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain(WORK_TASK);
    expect(snapshot.operations[0]).toMatchObject({ state: "settled", historical: true, concurrencyHeld: false });
  });

  test("concurrent matching duplicate returns the identical promise and prepares once", async () => {
    const f = await preparedFixture();
    const prepareGate = deferred<NativeHarnessPrepareResult>();
    const signal = new AbortController().signal;
    let innerDuringPrepare: Promise<NativeHarnessDelegationResult> | null = null;
    let h!: Harness;
    h = setup(f, {
      prepare: (request, _context, _calls, helpers) => {
        helpers.guard(request);
        innerDuringPrepare = h.coordinator.invoke("call-1", { task: WORK_TASK }, signal);
        return prepareGate.promise;
      },
    });
    const first = h.coordinator.invoke("call-1", { task: WORK_TASK }, signal);
    const second = h.coordinator.invoke("call-1", { task: WORK_TASK }, signal);
    expect(second).toBe(first);
    expect(innerDuringPrepare === first).toBe(true);
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(0);

    prepareGate.resolve({ ok: true, backend: {
      async create() {
        h.calls.create += 1;
        return { runId: "run-1" };
      },
      async execute() {
        h.calls.execute += 1;
        return { status: "completed" };
      },
      async cancel() {
        h.calls.cancel += 1;
      },
    } });
    const result = await settle(first);
    expect(await second).toBe(result);
    expect(result.outcome).toBe("backend-completed");
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(1);
    expect(h.calls.execute).toBe(1);

    const replay = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    expect(replay.historical).toBe(true);
    expect(replay.resultKind).toBe("historical");
    expect(replay.outcome).toBe(result.outcome);
    expect(h.calls.create).toBe(1);
    expect(h.calls.execute).toBe(1);
  });

  test("changed task, swapped signal and rebinding are refused without another run", async () => {
    const f = await preparedFixture();
    const createGate = deferred<unknown>();
    const h = setup(f, {
      create: () => createGate.promise,
    });
    const signalA = new AbortController().signal;
    const signalB = new AbortController().signal;
    const first = h.coordinator.invoke("call-1", { task: WORK_TASK }, signalA);

    const changedTask = await h.coordinator.invoke("call-1", { task: "different task" }, signalA);
    expect(changedTask.outcome).toBe("refused");
    expect(changedTask.reason).toContain("different task");
    const changedSignal = await h.coordinator.invoke("call-1", { task: WORK_TASK }, signalB);
    expect(changedSignal.outcome).toBe("refused");
    expect(changedSignal.reason).toContain("invocation signal");
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(1);

    createGate.resolve({ runId: "run-1" });
    const result = await settle(first);
    expect(result.outcome).toBe("backend-completed");
    expect(h.calls.create).toBe(1);
    expect(h.calls.execute).toBe(1);

    // New work with the same call id is an incompatible native association.
    await startWork(f, "new work");
    await callHarness(f, "call-1");
    const rebound = await h.coordinator.invoke("call-1", { task: WORK_TASK }, signalA);
    expect(rebound.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(1);
  });

  test("real native authority: managed owner, navigation, ended and cross-work refusals prepare nothing", async () => {
    const f = await fixture();
    await startWork(f, "first work");
    await callHarness(f, "owned");
    const h = setup(f);

    publishTaskOwner({ ownerId: "g52a-owner" } as unknown as TaskOwner);
    const owned = await h.coordinator.invoke("owned", { task: WORK_TASK }, new AbortController().signal);
    expect(owned.outcome).toBe("refused");
    expect(owned.reason).toContain("managed-owner-present");
    expect(h.calls.prepare).toBe(0);
    clearPublishedTaskOwner();

    await navigate(f);
    const navigated = await h.coordinator.invoke("owned", { task: WORK_TASK }, new AbortController().signal);
    expect(navigated.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(0);

    await startWork(f, "second work");
    await callHarness(f, "ended");
    await endWork(f);
    const ended = await h.coordinator.invoke("ended", { task: WORK_TASK }, new AbortController().signal);
    expect(ended.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(0);

    await startWork(f, "third work");
    await callHarness(f, "cross");
    await startWork(f, "fourth work");
    const crossed = await h.coordinator.invoke("cross", { task: WORK_TASK }, new AbortController().signal);
    expect(crossed.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(0);
    expect(h.calls.create).toBe(0);
  });

  test("abort before admission and stale work never call prepare", async () => {
    const f = await preparedFixture();
    const h = setup(f);
    const aborted = new AbortController();
    aborted.abort();
    const before = await h.coordinator.invoke("call-1", { task: WORK_TASK }, aborted.signal);
    expect(before.outcome).toBe("refused");
    expect(before.reason).toContain("cancelled");
    expect(h.calls.prepare).toBe(0);

    await navigate(f);
    const stale = await h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    expect(stale.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(0);
    expect(h.calls.create).toBe(0);
  });

  test("deferred prepare cancelled within grace never creates", async () => {
    const f = await preparedFixture();
    const prepareGate = deferred<NativeHarnessPrepareResult>();
    const h = setup(f, {
      prepare: (request, _context, _calls, helpers) => {
        helpers.guard(request);
        return prepareGate.promise;
      },
    });
    const abort = new AbortController();
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, abort.signal);
    await waitFor(() => h.calls.prepare === 1, "prepare start");
    abort.abort();
    prepareGate.resolve({
      ok: true,
      backend: {
        async create() {
          h.calls.create += 1;
          return { runId: "late-run" };
        },
        async execute() {
          h.calls.execute += 1;
          return { status: "completed" };
        },
        async cancel() {
          h.calls.cancel += 1;
        },
      },
    });
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("cancelled");
    expect(result.executionState).toBe("not-started");
    expect(result.cancellation).toBe("none");
    expect(h.calls.create).toBe(0);
    expect(h.calls.execute).toBe(0);
  });

  test("deferred prepare over grace retains an unknown tombstone and late backend never creates", async () => {
    const f = await preparedFixture();
    const firstWait = deferred<void>();
    const secondWait = deferred<void>();
    const h = setup(f, {
      policy: { cleanupGraceMs: 15, maxDurationMs: 500 },
      prepare: async (request, _context, calls, helpers) => {
        helpers.guard(request);
        await firstWait.promise;
        helpers.guard(request);
        calls.guardWhilePending = "ok";
        await secondWait.promise;
        try {
          helpers.guard(request);
          calls.lateGuardError = "no error";
        } catch (error) {
          calls.lateGuardError = String(error);
        }
        return { ok: true, backend: helpers.backend(request) };
      },
    });
    const abort = new AbortController();
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, abort.signal);
    await waitFor(() => h.calls.prepare === 1, "prepare start");
    firstWait.resolve();
    await waitFor(() => h.calls.guardWhilePending === "ok", "guard across pending prepare");
    abort.abort();
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cost.unknownUsd).toBe(1);
    expect(result.cost.allocatedUsd).toBe(1);
    expect(h.calls.create).toBe(0);
    expect(h.calls.guard).toBe(2);
    expect(h.coordinator.inspect().activeOperations).toBe(1);

    secondWait.resolve();
    await waitFor(() => h.calls.lateGuardError !== null, "late guard refusal");
    expect(h.calls.lateGuardError).toContain("no longer open");
    await tick(5);
    expect(h.calls.create).toBe(0);
    expect(h.calls.execute).toBe(0);
    expect((await settle(resultPromise)).executionState).toBe("pending-unknown");
  });

  test("dispose during deferred prepare aborts and retains over-grace tombstone without creating", async () => {
    const f = await preparedFixture();
    const prepareGate = deferred<NativeHarnessPrepareResult>();
    const h = setup(f, {
      policy: { cleanupGraceMs: 15, maxDurationMs: 500 },
      prepare: (request, _context, _calls, helpers) => {
        helpers.guard(request);
        return prepareGate.promise;
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await waitFor(() => h.calls.prepare === 1, "prepare start");
    h.coordinator.dispose();
    h.coordinator.dispose();
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.termination).toBe("disposed");
    expect(h.calls.create).toBe(0);
    expect(f.entry.isEnabled()).toBe(true);

    prepareGate.resolve({
      ok: true,
      backend: {
        async create() {
          h.calls.create += 1;
          return { runId: "late" };
        },
        async execute() {
          h.calls.execute += 1;
          return { status: "completed" };
        },
        async cancel() {
          h.calls.cancel += 1;
        },
      },
    });
    await tick(5);
    expect(h.calls.create).toBe(0);
    expect(h.coordinator.inspect().activeOperations).toBe(1);
  });

  test("old-work invalidation during deferred prepare refuses create", async () => {
    const f = await preparedFixture();
    const prepareGate = deferred<NativeHarnessPrepareResult>();
    const h = setup(f, {
      prepare: (request, _context, _calls, helpers) => {
        helpers.guard(request);
        return prepareGate.promise;
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await waitFor(() => h.calls.prepare === 1, "prepare start");
    await navigate(f);
    prepareGate.resolve({
      ok: true,
      backend: {
        async create() {
          h.calls.create += 1;
          return { runId: "run-1" };
        },
        async execute() {
          h.calls.execute += 1;
          return { status: "completed" };
        },
        async cancel() {
          h.calls.cancel += 1;
        },
      },
    });
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("refused");
    expect(result.authorityFresh).toBe(false);
    expect(h.calls.create).toBe(0);
    expect(h.calls.execute).toBe(0);
  });

  test("cancellation while create is pending retains runId and cancels without execute", async () => {
    const f = await preparedFixture();
    const createGate = deferred<unknown>();
    const h = setup(f, { create: () => createGate.promise });
    const abort = new AbortController();
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, abort.signal);
    await waitFor(() => h.calls.create === 1, "create dispatch");
    abort.abort();
    createGate.resolve({ runId: "run-created" });
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("cancelled");
    expect(result.cancellation).toBe("requested");
    expect(result.runId).toBe("run-created");
    expect(result.executionState).toBe("not-started");
    expect(result.cost.unknownUsd).toBe(1);
    expect(h.calls.execute).toBe(0);
    expect(h.calls.cancel).toBe(1);
    expect(h.calls.cancelRunIds).toEqual(["run-created"]);
  });

  test("deadline during create is not reset by staging and cancels the bound run", async () => {
    const f = await preparedFixture();
    let clock = 1000;
    const h = setup(f, {
      now: () => clock,
      policy: { perRunUsd: 0.5, lifetimeUsd: 1, maxDurationMs: 100, cleanupGraceMs: 20 },
      create: () => {
        clock = 1200;
        return { runId: "run-late" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("timed-out");
    expect(result.termination).toBe("deadline");
    expect(result.deadlineAt).toBe(1100);
    expect(h.calls.requests[0]?.budget.deadlineAt).toBe(1100);
    expect(result.executionState).toBe("not-started");
    expect(result.runId).toBe("run-late");
    expect(h.calls.execute).toBe(0);
    expect(h.calls.cancel).toBe(1);
    expect(result.cost.unknownUsd).toBe(0.5);
  });

  test("worker timeout is clamped to the original remaining deadline", async () => {
    const f = await preparedFixture();
    let clock = 1000;
    let seenTimeout = 0;
    const h = setup(f, {
      now: () => clock,
      policy: { maxDurationMs: 1000, cleanupGraceMs: 20 },
      create: () => {
        clock = 1500;
        return { runId: "run-1" };
      },
      runner: runnerFor(async (request) => {
        seenTimeout = request.timeoutMs;
        return completedResult(0.1);
      }),
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("backend-completed");
    expect(result.deadlineAt).toBe(2000);
    expect(h.calls.requests[0]?.budget.deadlineAt).toBe(2000);
    expect(seenTimeout).toBe(500);
  });

  test("old-work invalidation refuses new dispatch and still sends cleanup cancel", async () => {
    const f = await preparedFixture();
    const executeEntered = deferred<void>();
    const allow = deferred<void>();
    const h = setup(f, {
      execute: async (runId, runner, calls) => {
        executeEntered.resolve();
        await allow.promise;
        try {
          await runner.run(workerRequest(runId));
        } catch (error) {
          calls.dispatchError = String(error);
        }
        return { status: "failed" };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await executeEntered.promise;
    await navigate(f);
    allow.resolve();
    const result = await settle(resultPromise);
    expect(h.calls.runner).toBe(0);
    expect(h.calls.dispatchError).toContain("native call authority");
    expect(h.calls.cancel).toBe(1);
    expect(h.calls.cancelRunIds).toEqual(["run-1"]);
    expect(result.outcome).toBe("incomplete");
    expect(result.termination).toBe("authority-lost");
    expect(result.authorityFresh).toBe(false);
  });

  test("stale authority after execute never publishes backend completion", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      execute: async (runId, runner) => {
        await runner.run(workerRequest(runId));
        await navigate(f);
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("incomplete");
    expect(result.backendStatus).toBe("completed");
    expect(result.authorityFresh).toBe(false);
    expect(result.executionState).toBe("settled");
    expect(result.cost.unknownUsd).toBe(0);
    expect(result.cost.observedUsd).toBe(0.1);
  });

  test("final navigation after settled completion keeps known usage while authority stays stale", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: runnerFor(async () => completedResult(0.01)),
      execute: async (runId, runner) => {
        const result = await runner.run(workerRequest(runId, { maxCostUsd: 0.1 }));
        await navigate(f);
        return { status: result.status };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("incomplete");
    expect(result.authorityFresh).toBe(false);
    expect(result.backendStatus).toBe("completed");
    expect(result.executionState).toBe("settled");
    expect(result.cost).toEqual({ allocatedUsd: 0.5, observedUsd: 0.01, unknownUsd: 0, overspendUsd: 0 });
    expect(h.coordinator.inspect().lifetime).toMatchObject({
      accountedUsd: 0.01,
      observedUsd: 0.01,
      unknownUsd: 0,
    });
    expect(h.coordinator.inspect().activeOperations).toBe(0);
  });

  test("backend execute resolving early waits for an outstanding worker and holds capacity", async () => {
    const f = await preparedFixture();
    const workerStarted = deferred<void>();
    const workerGate = deferred<WorkerResult>();
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: runnerFor(() => {
        workerStarted.resolve();
        return workerGate.promise;
      }),
      execute: async (runId, runner) => {
        void runner.run(workerRequest(runId, { maxCostUsd: 0.1 })).catch(() => undefined);
        return { status: "completed" };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await workerStarted.promise;
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await tick(10);
    expect(settled).toBe(false);
    const pending = h.coordinator.inspect();
    expect(pending.activeOperations).toBe(1);
    expect(pending.operations[0]?.state).toBe("running");
    expect(pending.operations[0]?.concurrencyHeld).toBe(true);

    workerGate.resolve(completedResult(0.1));
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("backend-completed");
    expect(result.executionState).toBe("settled");
    expect(result.cost).toEqual({ allocatedUsd: 0.5, observedUsd: 0.1, unknownUsd: 0, overspendUsd: 0 });
    expect(h.coordinator.inspect().activeOperations).toBe(0);
  });

  test("dynamic execute-side dispatch chain is closed once execution settles", async () => {
    const f = await preparedFixture();
    let dispatches = 0;
    let active = 0;
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: runnerFor(async () => {
        dispatches += 1;
        active += 1;
        await tick(1);
        active -= 1;
        return completedResult(0.001);
      }),
      execute: async (runId, runner) => {
        let startNext!: () => void;
        startNext = () => {
          if (dispatches >= 70) return;
          void runner.run(workerRequest(runId, { maxCostUsd: 0.001, timeoutMs: 2000 }))
            .then(() => startNext(), () => undefined);
        };
        startNext();
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal), 2000);
    expect(result.outcome).toBe("backend-completed");
    expect(result.executionState).toBe("settled");
    expect(dispatches).toBeGreaterThanOrEqual(1);
    expect(dispatches).toBeLessThan(65);
    expect(active).toBe(0);
    expect(result.cost.unknownUsd).toBe(0);
    expect(result.cost.observedUsd).toBeCloseTo(dispatches * 0.001, 9);
    expect(h.coordinator.inspect().activeOperations).toBe(0);
  });

  test("early backend completion with a nonsettling worker retains unknown allocation and capacity", async () => {
    const f = await preparedFixture();
    const workerStarted = deferred<void>();
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1, maxDurationMs: 25, cleanupGraceMs: 15 },
      runner: runnerFor(() => {
        workerStarted.resolve();
        return new Promise<WorkerResult>(() => undefined);
      }),
      cancel: () => new Promise<void>(() => undefined),
      execute: async (runId, runner) => {
        void runner.run(workerRequest(runId, { maxCostUsd: 0.1 })).catch(() => undefined);
        return { status: "completed" };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await workerStarted.promise;
    const result = await settle(resultPromise, 1000);
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.backendStatus).toBeNull();
    expect(result.authorityFresh).toBe(false);
    expect(result.cost.unknownUsd).toBe(0.5);
    expect(result.cost.observedUsd).toBeNull();
    expect(h.calls.cancel).toBe(1);
    const snapshot = h.coordinator.inspect();
    expect(snapshot.activeOperations).toBe(1);
    expect(snapshot.operations[0]?.concurrencyHeld).toBe(true);
  });

  test("tool abort while worker pending combines signals, cancels once and never claims success", async () => {
    const f = await preparedFixture();
    const workerStarted = deferred<void>();
    const h = setup(f, {
      runner: runnerFor((request) => {
        h.calls.workerSignals.push(request.signal);
        workerStarted.resolve();
        return new Promise<WorkerResult>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("worker aborted")), { once: true });
        });
      }),
      execute: async (runId, runner, calls) => {
        try {
          await runner.run(workerRequest(runId));
        } catch (error) {
          calls.dispatchError = String(error);
        }
        return { status: "cancelled" };
      },
    });
    const abort = new AbortController();
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, abort.signal);
    await workerStarted.promise;
    abort.abort();
    const result = await settle(resultPromise);
    const forwarded = h.calls.workerSignals[0];
    expect(forwarded?.aborted).toBe(true);
    expect(h.calls.cancel).toBe(1);
    expect(h.calls.dispatchError).toContain("worker aborted");
    expect(result.outcome).toBe("cancelled");
    expect(result.cancellation).toBe("requested");
    expect(result.backendStatus).toBe("cancelled");
    expect(result.taskAccepted).toBe(false);
    expect(result.executionState).toBe("settled");
  });

  test("already-aborted controller worker signal is rejected before underlying dispatch", async () => {
    const f = await preparedFixture();
    const workerSignal = new AbortController();
    workerSignal.abort();
    let underlyingCalls = 0;
    const h = setup(f, {
      runner: runnerFor(async () => {
        underlyingCalls += 1;
        return completedResult(0.1);
      }),
      execute: async (runId, runner) => {
        await runner.run(workerRequest(runId, { signal: workerSignal.signal }));
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(underlyingCalls).toBe(0);
    expect(h.calls.runner).toBe(0);
    expect(result.outcome).not.toBe("backend-completed");
    expect(result.backendStatus).toBeNull();
    expect(result.executionState).toBe("settled");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(1);
    expect(result.authorityFresh).toBe(true);
  });

  test("no host callback is invoked between the final authority gate and publication", async () => {
    const f = await preparedFixture();
    let triggeredFromFinish = false;
    const h = setup(f, {
      // Mirrors the independent probe: navigate only if a clock callback is
      // reached from inside finishSlot after the final gate.
      now: () => {
        if (!triggeredFromFinish && new Error().stack?.includes("finishSlot")) {
          triggeredFromFinish = true;
          void navigate(f);
        }
        return Date.now();
      },
      runner: runnerFor(async () => completedResult(0.1)),
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(triggeredFromFinish).toBe(false);
    expect(result.outcome).toBe("backend-completed");
    expect(result.authorityFresh).toBe(true);
  });

  test("finish clock navigation happens before the final fresh gate and blocks success", async () => {
    const f = await preparedFixture();
    let navigateOnNextClock = false;
    let triggered = false;
    const h = setup(f, {
      now: () => {
        if (navigateOnNextClock && !triggered) {
          navigateOnNextClock = false;
          triggered = true;
          void navigate(f);
        }
        return Date.now();
      },
      runner: runnerFor(async () => {
        navigateOnNextClock = true;
        return completedResult(0.1);
      }),
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(triggered).toBe(true);
    expect(result.outcome).not.toBe("backend-completed");
    expect(result.authorityFresh).toBe(false);
  });

  test("dispose during the final gate clock read cannot publish completion", async () => {
    const f = await preparedFixture();
    let armed = false;
    let armedClockReads = 0;
    let triggered = false;
    let h!: Harness;
    h = setup(f, {
      now: () => {
        if (armed) armedClockReads += 1;
        if (armed && !triggered && armedClockReads === 3) {
          triggered = true;
          h.coordinator.dispose();
        }
        return Date.now();
      },
      runner: runnerFor(async () => completedResult(0.1)),
      execute: async (runId, runner) => {
        const result = await runner.run(workerRequest(runId));
        armed = true;
        return { status: result.status };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(triggered).toBe(true);
    expect(result.outcome).not.toBe("backend-completed");
    expect(result.authorityFresh).toBe(false);
    expect(result.termination).toBe("disposed");
    expect(h.calls.cancel).toBe(1);
    expect(result.cost.unknownUsd).toBe(1);
  });

  test("controller worker signal is combined into the forwarded worker signal", async () => {
    const f = await preparedFixture();
    const workerSignal = new AbortController();
    const workerGate = deferred<WorkerResult>();
    let forwarded: AbortSignal | undefined;
    const h = setup(f, {
      runner: runnerFor(async (request) => {
        forwarded = request.signal;
        return await workerGate.promise;
      }),
      execute: async (runId, runner) => {
        const result = await runner.run(workerRequest(runId, { signal: workerSignal.signal }));
        return { status: result.status };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await waitFor(() => forwarded !== undefined, "runner dispatch");
    workerSignal.abort();
    expect(forwarded?.aborted).toBe(true);
    workerGate.resolve(completedResult(0.1));
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("backend-completed");
    expect(result.cancellation).toBe("none");
  });

  test("cancellation and dispose are repeatable, thrown cancel stays visible and never overwrites execution", async () => {
    const f = await preparedFixture();
    const workerStarted = deferred<void>();
    const workerGate = deferred<WorkerResult>();
    const h = setup(f, {
      runner: runnerFor(() => {
        workerStarted.resolve();
        return workerGate.promise;
      }),
      cancel: () => {
        throw new Error("cancel boom");
      },
      execute: async (runId, runner) => {
        try {
          await runner.run(workerRequest(runId));
        } catch {
          // Keep the observed backend status separate from the plugin result.
        }
        return { status: "completed" };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await workerStarted.promise;
    expect(h.coordinator.cancel("call-1")).toBe(true);
    expect(h.coordinator.cancel("call-1")).toBe(false);
    workerGate.resolve(completedResult(0.1));
    const result = await settle(resultPromise);
    expect(h.calls.cancel).toBe(1);
    expect(result.cancellation).toBe("request-failed");
    expect(result.cancelError).toContain("cancel boom");
    expect(result.backendStatus).toBe("completed");
    expect(result.outcome).toBe("cancelled");
    expect(result.executionState).toBe("settled");
    expect(result.taskAccepted).toBe(false);

    h.coordinator.dispose();
    h.coordinator.dispose();
    expect(h.coordinator.disposed).toBe(true);
    expect(f.entry.isEnabled()).toBe(true);
    expect(h.calls.cancel).toBe(1);
  });

  test("ignored cancellation past grace keeps concurrency, allocation and the returned tombstone", async () => {
    const f = await preparedFixture();
    const workerStarted = deferred<void>();
    const workerGate = deferred<WorkerResult>();
    const h = setup(f, {
      policy: { cleanupGraceMs: 15, maxDurationMs: 500 },
      runner: runnerFor(() => {
        workerStarted.resolve();
        return workerGate.promise;
      }),
      cancel: () => new Promise<void>(() => undefined),
      execute: async (runId, runner) => {
        await runner.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const resultPromise = h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
    await workerStarted.promise;
    expect(h.coordinator.cancel("call-1")).toBe(true);
    const result = await settle(resultPromise);
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.termination).toBe("cancelled");
    expect(result.cancellation).toBe("requested");
    expect(result.cost.unknownUsd).toBe(1);
    expect(h.calls.cancel).toBe(1);
    const snapshot = h.coordinator.inspect();
    expect(snapshot.activeOperations).toBe(1);
    expect(snapshot.operations[0]?.concurrencyHeld).toBe(true);

    await callHarness(f, "call-2");
    const second = await h.coordinator.invoke("call-2", { task: "second" }, new AbortController().signal);
    expect(second.outcome).toBe("refused");
    expect(second.reason).toContain("concurrency");
    expect(h.calls.prepare).toBe(1);

    workerGate.resolve(completedResult(0.1));
    await tick(5);
    expect((await settle(resultPromise)).outcome).toBe("unknown");
    expect(h.coordinator.inspect().activeOperations).toBe(1);
  });

  test("known completed cost releases unspent lifetime reservation; aggregate budget refuses later calls", async () => {
    const f = await preparedFixture();
    await callHarness(f, "call-2");
    await callHarness(f, "call-3");
    let run = 0;
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1, maxRetainedOperations: 4 },
      create: () => ({ runId: `run-${++run}` }),
      runner: runnerFor(async () => completedResult(0.5)),
      execute: async (runId, runner) => {
        const result = await runner.run(workerRequest(runId, { maxCostUsd: 0.5 }));
        return { status: result.status };
      },
    });
    const first = await settle(h.coordinator.invoke("call-1", { task: "one" }, new AbortController().signal));
    expect(first.outcome).toBe("backend-completed");
    expect(first.cost).toEqual({ allocatedUsd: 0.5, observedUsd: 0.5, unknownUsd: 0, overspendUsd: 0 });
    expect(h.coordinator.inspect().lifetime.accountedUsd).toBe(0.5);

    const second = await settle(h.coordinator.invoke("call-2", { task: "two" }, new AbortController().signal));
    expect(second.outcome).toBe("backend-completed");
    expect(h.coordinator.inspect().lifetime.accountedUsd).toBe(1);

    const third = await h.coordinator.invoke("call-3", { task: "three" }, new AbortController().signal);
    expect(third.outcome).toBe("refused");
    expect(third.reason).toContain("lifetime");
    expect(h.calls.prepare).toBe(2);
    expect(h.calls.create).toBe(2);
  });

  test("estimated or missing usage retains the full allocation and never pretends zero", async () => {
    const f = await preparedFixture();
    await callHarness(f, "call-2");
    let run = 0;
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      create: () => ({ runId: `run-${++run}` }),
      runner: runnerFor(async () => (
        run === 1
          ? completedResult(0.1, { usageEstimated: true })
          : ({ ...completedResult(0.1), usage: undefined } as unknown as WorkerResult)
      )),
    });
    const estimated = await settle(h.coordinator.invoke("call-1", { task: "one" }, new AbortController().signal));
    expect(estimated.outcome).toBe("backend-completed");
    expect(estimated.cost.observedUsd).toBeNull();
    expect(estimated.cost.unknownUsd).toBe(0.5);
    expect(h.coordinator.inspect().lifetime.unknownUsd).toBe(0.5);

    const missing = await settle(h.coordinator.invoke("call-2", { task: "two" }, new AbortController().signal));
    expect(missing.cost.observedUsd).toBeNull();
    expect(missing.cost.unknownUsd).toBe(0.5);
    expect(h.coordinator.inspect().lifetime.unknownUsd).toBe(1);
  });

  test("thrown runner retains allocation and is reported without an unhandled rejection", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: runnerFor(async () => {
        throw new Error("runner exploded");
      }),
      execute: async (runId, runner, calls) => {
        try {
          await runner.run(workerRequest(runId));
        } catch (error) {
          calls.dispatchError = String(error);
        }
        return { status: "failed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("backend-failed");
    expect(result.backendStatus).toBe("failed");
    expect(result.cost.unknownUsd).toBe(0.5);
    expect(h.calls.dispatchError).toContain("runner exploded");
    expect(h.coordinator.inspect().lifetime.unknownUsd).toBe(0.5);
  });

  test("synchronous runner throws do not leak the in-flight bound", async () => {
    const f = await preparedFixture();
    let underlying = 0;
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: {
        run() {
          underlying += 1;
          throw new Error("synchronous worker failure");
        },
      },
      execute: async (runId, runner, calls) => {
        for (let index = 0; index < 5; index += 1) {
          try {
            await runner.run(workerRequest(runId, { maxCostUsd: 0.01 }));
          } catch (error) {
            calls.dispatchError = String(error);
          }
        }
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(underlying).toBe(5);
    expect(h.calls.dispatchError).toContain("synchronous worker failure");
    expect(result.outcome).toBe("backend-completed");
    expect(result.executionState).toBe("settled");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(0.5);
    expect(h.coordinator.inspect().activeOperations).toBe(0);
  });

  test("finite overspend is observed, stops further dispatch and blocks future calls", async () => {
    const f = await preparedFixture();
    await callHarness(f, "call-2");
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1 },
      runner: runnerFor(async () => completedResult(0.8)),
      execute: async (runId, runner, calls) => {
        calls.runner += 1;
        await runner.run(workerRequest(runId, { maxCostUsd: 0.5 }));
        try {
          await runner.run(workerRequest(runId, { maxCostUsd: 0.4 }));
        } catch (error) {
          calls.dispatchError = String(error);
        }
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("backend-completed");
    expect(result.cost.observedUsd).toBe(0.8);
    expect(result.cost.overspendUsd).toBe(0.3);
    expect(h.calls.runner).toBe(1);
    expect(h.calls.dispatchError).toContain("remaining delegation reservation");
    expect(h.coordinator.inspect().lifetime).toMatchObject({
      accountedUsd: 0.8,
      observedUsd: 0.8,
      overspendUsd: 0.3,
      budgetBlocked: true,
    });

    const blocked = await h.coordinator.invoke("call-2", { task: "blocked" }, new AbortController().signal);
    expect(blocked.outcome).toBe("refused");
    expect(blocked.reason).toContain("overspend");
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(1);
  });

  test("deadline timer aborts a pending worker and retains unknown cleanup", async () => {
    const f = await preparedFixture();
    const runnerStarted = deferred<void>();
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 1, maxDurationMs: 20, cleanupGraceMs: 15 },
      runner: runnerFor(() => {
        runnerStarted.resolve();
        return new Promise<WorkerResult>(() => undefined);
      }),
      cancel: () => new Promise<void>(() => undefined),
      execute: async (runId, runner, calls) => {
        calls.runner += 1;
        await runner.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal), 1000);
    expect(result.outcome).toBe("unknown");
    expect(result.termination).toBe("deadline");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cancellation).toBe("requested");
    expect(h.calls.cancel).toBe(1);
    expect(h.calls.runner).toBe(1);
    expect(h.coordinator.inspect().activeOperations).toBe(1);
  });

  test("malicious task input and unknown fields are refused without invoking host callbacks", async () => {
    const f = await preparedFixture();
    const h = setup(f);
    let getterCalls = 0;
    const accessorInput = Object.defineProperty({}, "task", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return WORK_TASK;
      },
    });
    const accessor = await h.coordinator.invoke("call-1", accessorInput, new AbortController().signal);
    expect(accessor.outcome).toBe("refused");
    expect(getterCalls).toBe(0);
    expect(h.calls.getContext).toBe(0);
    expect(h.calls.prepare).toBe(0);

    const unknown = await h.coordinator.invoke("call-1", { task: WORK_TASK, model: "evil/model" }, new AbortController().signal);
    expect(unknown.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(0);

    const huge = await h.coordinator.invoke("call-1", { task: "a".repeat(NATIVE_HARNESS_MAX_TASK_BYTES + 1) }, new AbortController().signal);
    expect(huge.outcome).toBe("refused");
    expect(huge.reason).toContain("UTF-8 bytes");
    expect(h.calls.prepare).toBe(0);
  });

  test("reentrant getContext admission is refused by the admission lock", async () => {
    const f = await preparedFixture();
    let coordinator!: NativeHarnessDelegationCoordinator;
    let inner: Promise<NativeHarnessDelegationResult> | null = null;
    let reentered = false;
    const h = setup(f, {
      getContext: () => {
        if (!reentered) {
          reentered = true;
          inner = coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal);
        }
        return f.ctx;
      },
    });
    coordinator = h.coordinator;
    const result = await settle(coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("backend-completed");
    expect(inner).not.toBeNull();
    const refused = await settle(inner as unknown as Promise<NativeHarnessDelegationResult>);
    expect(refused.outcome).toBe("refused");
    expect(refused.reason).toContain("reentrant");
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(1);
  });

  test("prepare that skips the guard is refused before create", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      prepare: (_request, _context, _calls, helpers) => ({ ok: true, backend: helpers.backend(_request) }),
    });
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, new AbortController().signal));
    expect(result.outcome).toBe("refused");
    expect(result.reason).toContain("guard");
    expect(h.calls.prepare).toBe(1);
    expect(h.calls.create).toBe(0);
  });

  test("exact task byte bound is admitted, one byte more is refused", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      prepare: (request, _context, _calls, helpers) => {
        helpers.guard(request);
        return { ok: false, reason: "prepared stop" };
      },
    });
    const maxTask = "a".repeat(NATIVE_HARNESS_MAX_TASK_BYTES);
    const accepted = await settle(h.coordinator.invoke("call-1", maxTask, new AbortController().signal));
    expect(accepted.outcome).toBe("refused");
    expect(accepted.reason).toContain("prepared stop");
    expect(h.calls.prepare).toBe(1);
    const over = await h.coordinator.invoke("call-1", `${maxTask}b`, new AbortController().signal);
    expect(over.outcome).toBe("refused");
    expect(h.calls.prepare).toBe(1);
  });

  test("invalid policy values and accessor policies are rejected before any effect", async () => {
    const f = await preparedFixture();
    const base = {
      native: f.entry,
      getContext: () => f.ctx,
      prepare: () => ({ ok: false as const, reason: "never" }),
      runner: runnerFor(async () => completedResult()),
      enabled: true,
    };
    const invalid: Partial<NativeHarnessDelegationPolicy>[] = [
      { maxRetainedOperations: 17 },
      { maxRetainedOperations: Number.NaN },
      { maxConcurrent: 2 },
      { perRunUsd: 0 },
      { perRunUsd: Number.POSITIVE_INFINITY },
      { perRunUsd: 1.1 },
      { perRunUsd: 0.5, lifetimeUsd: 0.4 },
      { perRunUsd: 0.5, lifetimeUsd: 5.1 },
      { maxDurationMs: 300_001 },
      { cleanupGraceMs: 30_001 },
    ];
    for (const policy of invalid) {
      expect(() => createNativeHarnessDelegation({ ...base, policy })).toThrow();
    }
    let getterCalls = 0;
    const accessorPolicy = Object.defineProperty({}, "perRunUsd", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 0.5;
      },
    });
    expect(() => createNativeHarnessDelegation({ ...base, policy: accessorPolicy as NativeHarnessDelegationPolicy })).toThrow();
    expect(getterCalls).toBe(0);
  });

  test("result and snapshot are bounded, immutable and leak no task/config/worker text", async () => {
    const f = await preparedFixture();
    const h = setup(f, {
      execute: async () => ({
        status: "completed",
        config: { secret: "SECRET-CONFIG" },
        text: "SECRET-WORKER-TEXT",
      }),
    });
    const task = `${WORK_TASK} SECRET-TASK-MARKER`;
    const result = await settle(h.coordinator.invoke("call-1", task, new AbortController().signal));
    expect(result.outcome).toBe("backend-completed");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cost)).toBe(true);
    expect(Object.isFrozen(result.limitations)).toBe(true);
    const resultText = JSON.stringify(result);
    expect(resultText).not.toContain(task);
    expect(resultText).not.toContain("SECRET-CONFIG");
    expect(resultText).not.toContain("SECRET-WORKER-TEXT");
    expect(new TextEncoder().encode(resultText).byteLength).toBeLessThan(8192);
    const snapshotText = JSON.stringify(h.coordinator.inspect());
    expect(snapshotText).not.toContain(task);
    expect(snapshotText).not.toContain("SECRET-CONFIG");
    expect(snapshotText).not.toContain("SECRET-WORKER-TEXT");
    expect(new TextEncoder().encode(snapshotText).byteLength).toBeLessThan(16 * 1024);
  });
});
