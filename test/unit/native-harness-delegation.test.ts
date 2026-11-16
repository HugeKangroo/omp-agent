import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeEntry,
  type NativeContext,
  type NativeEntryControls,
  type NativeOmpApi,
  type NativeToolResult,
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
  type NativeHarnessOutputPort,
  type NativeHarnessOutputSelection,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import {
  captureNativeHarnessOutput,
  matchesNativeHarnessOutputCapture,
  type NativeHarnessOutputCapture,
} from "../../src/native-harness-output.ts";
import {
  createNativeHarnessBackend,
  readNativeHarnessBackendCompletion,
} from "../../src/native-harness-backend.ts";
import { createNativeHarnessEntry } from "../../src/native-harness-entry.ts";
import {
  captureWorkspaceText,
  type NativeWorkspaceTextSnapshot,
} from "../../src/native-work.ts";
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

function projectionFor(result: NativeHarnessDelegationResult, text?: string): NativeToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(result) }],
    details: result,
    isError: false,
  };
}

async function emitResult(
  f: Fixture,
  toolCallId: string,
  toolResult: NativeToolResult,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await f.host.emit("tool_result", {
    toolCallId,
    toolName: AGENT_HARNESS,
    input: { task: WORK_TASK },
    content: toolResult.content,
    details: toolResult.details,
    isError: false,
    ...overrides,
  }, f.ctx);
}

function actualOutputPort(owner: () => string | null = () => null): NativeHarnessOutputPort {
  return {
    capture(backend: unknown, guard: () => void, signal: AbortSignal) {
      return captureNativeHarnessOutput(backend, guard, signal);
    },
    matches(backend: unknown, capture: unknown) {
      return matchesNativeHarnessOutputCapture(backend, capture);
    },
    revalidateOwner() {
      return owner();
    },
  };
}

function outputCandidateRunner(): Runner {
  return runnerFor(async (request) => {
    await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
    const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
    await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
    let text = "stage completed";
    if (request.stage === "plan") {
      text = JSON.stringify({
        decision: "direct",
        reason: "Bounded output capture planning.",
        criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
        routes: [],
      });
    } else if (request.stage === "baseline") {
      await writeFile(path.join(request.cwd, "candidate.txt"), "candidate 0\n", { mode: 0o600 });
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
  });
}

function syntheticCapture(
  snapshot: NativeWorkspaceTextSnapshot,
  copies: number,
  task: string,
): NativeHarnessOutputCapture {
  return {
    schema: "omp-agent.native-harness-output-capture.v1",
    captureId: `synthetic-${snapshot.captureId}`,
    originKind: "harness2-native",
    completionId: "synthetic-completion",
    sourceId: "synthetic-source",
    runId: "run-1",
    taskSha256: createHash("sha256").update(task, "utf8").digest("hex"),
    baseSnapshotId: "synthetic-base",
    manifestSha256: "0".repeat(64),
    winner: { candidate: "baseline", attempt: 1, artifactHash: "0".repeat(64), traceHash: "0".repeat(64) },
    changes: Array.from({ length: copies }, () => ({
      path: "candidate.txt",
      kind: "add" as const,
      mode: 0o600,
      controllerHash: "0".repeat(64),
      snapshot,
    })),
    sources: [],
    baseInputs: [],
    stages: [],
    digest: "0".repeat(64),
    observedAt: 1,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    limitations: [],
  };
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
  output?: NativeHarnessOutputPort;
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
    ...(hooks.output === undefined ? {} : { output: hooks.output }),
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

  test("missing or malformed output ports keep execution available", async () => {
    const absent = await preparedFixture();
    const absentHarness = setup(absent);
    const absentSignal = new AbortController().signal;
    const absentResult = await settle(absentHarness.coordinator.invoke("call-1", { task: WORK_TASK }, absentSignal));
    expect(absentResult.outcome).toBe("backend-completed");
    const absentRegistration = absentHarness.coordinator.registerToolResultProjection(
      "call-1",
      absentResult,
      projectionFor(absentResult),
      absentSignal,
    );
    expect(absentRegistration.ok).toBe(false);
    const absentCapture = await settle(absentHarness.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(absentCapture.ok).toBe(false);
    if (!absentCapture.ok) expect(absentCapture.code).toBe("output-unavailable");

    const malformed = await preparedFixture();
    const malformedHarness = setup(malformed, {
      output: { capture: 1 } as unknown as NativeHarnessOutputPort,
    });
    const malformedResult = await settle(malformedHarness.coordinator.invoke(
      "call-1",
      { task: WORK_TASK },
      new AbortController().signal,
    ));
    expect(malformedResult.outcome).toBe("backend-completed");
    const malformedCapture = await settle(malformedHarness.coordinator.captureOutput(
      "call-1",
      new AbortController().signal,
    ));
    expect(malformedCapture.ok).toBe(false);
    if (!malformedCapture.ok) expect(malformedCapture.code).toBe("output-unavailable");
  });

  test("a copied response, foreign id or changed projection cannot register a source", async () => {
    const f = await preparedFixture();
    const h = setup(f, { output: actualOutputPort() });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const copied = { ...result } as NativeHarnessDelegationResult;
    const copiedRegistration = h.coordinator.registerToolResultProjection(
      "call-1",
      copied,
      projectionFor(result),
      signal,
    );
    expect(copiedRegistration.ok).toBe(false);
    expect(copiedRegistration.reason).toContain("exact retained original result");
    const foreignId = h.coordinator.registerToolResultProjection(
      "call-foreign",
      result,
      projectionFor(result),
      signal,
    );
    expect(foreignId.ok).toBe(false);
    const wrongSignal = h.coordinator.registerToolResultProjection(
      "call-1",
      result,
      projectionFor(result),
      new AbortController().signal,
    );
    expect(wrongSignal.ok).toBe(false);
  });

  test("registration is pending until the real event; changed content prevents capture", async () => {
    const f = await preparedFixture();
    const h = setup(f, { output: actualOutputPort() });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    const first = h.coordinator.registerToolResultProjection("call-1", result, wire, signal);
    const second = h.coordinator.registerToolResultProjection("call-1", result, wire, signal);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const pending = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.code).toBe("not-ready");

    await emitResult(f, "call-1", wire);
    await emitResult(f, "call-1", wire, { content: [{ type: "text", text: "changed" }] });
    const conflicted = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.code).toBe("source-conflict");
    expect(h.coordinator.inspect().operations[0]!.output.registered).toBe(true);
  });

  test("pure owner predicate refusals fail closed before any capture leaf call", async () => {
    const f = await preparedFixture();
    let mode: "null" | "string" | "promise" | "rejectPromise" | "throw" | "false" = "null";
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      capture(backend: unknown, guard: () => void, signal: AbortSignal) {
        captureCalls += 1;
        return captureNativeHarnessOutput(backend, guard, signal);
      },
      matches(backend: unknown, capture: unknown) {
        return matchesNativeHarnessOutputCapture(backend, capture);
      },
      revalidateOwner() {
        if (mode === "string") return "the owner was replaced";
        if (mode === "throw") throw new Error("owner callback exploded");
        if (mode === "promise") return Promise.resolve(null) as unknown as string | null;
        if (mode === "rejectPromise") return Promise.reject(new Error("owner rejection")) as unknown as string | null;
        if (mode === "false") return false as unknown as string | null;
        return null;
      },
    };
    const h = setup(f, { output: port });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    expect(h.coordinator.registerToolResultProjection("call-1", result, wire, signal).ok).toBe(true);
    await emitResult(f, "call-1", wire);
    for (const next of ["string", "promise", "rejectPromise", "throw", "false"] as const) {
      mode = next;
      const refused = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("authority-lost");
      expect(captureCalls).toBe(0);
    }
    mode = "null";
    const accepted = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.code).not.toBe("authority-lost");
    expect(captureCalls).toBe(1);
  });

  test("a refused reentrant registration does not clear the outer registration lock", async () => {
    const f = await preparedFixture();
    let registrationStarted = false;
    let reentered = false;
    const nestedRegistrations: Array<
      ReturnType<NativeHarnessDelegationCoordinator["registerToolResultProjection"]>
    > = [];
    let coordinatorRef: NativeHarnessDelegationCoordinator | null = null;
    let sourceResult: NativeHarnessDelegationResult | null = null;
    let sourceWire: NativeToolResult | null = null;
    let sourceSignal: AbortSignal | null = null;
    const h = setup(f, {
      output: actualOutputPort(),
      getContext() {
        if (registrationStarted && !reentered && coordinatorRef !== null
          && sourceResult !== null && sourceWire !== null && sourceSignal !== null) {
          reentered = true;
          const nested = coordinatorRef.registerToolResultProjection(
            "call-1",
            sourceResult,
            sourceWire,
            sourceSignal,
          );
          nestedRegistrations.push(nested);
        }
        return f.ctx;
      },
    });
    coordinatorRef = h.coordinator;
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    sourceResult = result;
    sourceWire = wire;
    sourceSignal = signal;
    registrationStarted = true;
    const registered = h.coordinator.registerToolResultProjection("call-1", result, wire, signal);
    expect(registered.ok).toBe(true);
    expect(reentered).toBe(true);
    expect(nestedRegistrations).toHaveLength(1);
    const nestedRefusal = nestedRegistrations[0]!;
    expect(nestedRefusal.ok).toBe(false);
    expect(nestedRefusal.reason).not.toBeNull();
    if (nestedRefusal.reason !== null) {
      expect(nestedRefusal.reason).toContain("already in progress");
    }
    expect(h.coordinator.inspect().operations[0]!.output.registered).toBe(true);
  });

  test("a rejected native matcher promise is observed and refused without unhandled rejection", async () => {
    const f = await preparedFixture();
    await writeFile(path.join(f.workspace, "tiny.txt"), "x", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, "tiny.txt");
    const h = setup(f, {
      output: {
        async capture() {
          return { ok: true as const, capture: syntheticCapture(snapshot, 1, WORK_TASK) };
        },
        matches() {
          return Promise.reject(new Error("matcher rejection")) as unknown as boolean;
        },
        revalidateOwner() {
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    expect(h.coordinator.registerToolResultProjection("call-1", result, wire, signal).ok).toBe(true);
    await emitResult(f, "call-1", wire);
    const selection = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(selection.ok).toBe(false);
    if (!selection.ok) expect(selection.code).toBe("source-conflict");
    const snapshotState = h.coordinator.inspect();
    expect(snapshotState.output.retainedCaptures).toBe(0);
    expect(snapshotState.output.reservedBytes).toBe(0);
  });

  test("same-slot reentrancy joins one capture; another signal or Slot cannot steal capacity", async () => {
    const f = await preparedFixture();
    await callHarness(f, "call-2");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captureCalls = 0;
    const port: NativeHarnessOutputPort = {
      capture(backend: unknown, guard: () => void, signal: AbortSignal) {
        captureCalls += 1;
        return gate.then(() => captureNativeHarnessOutput(backend, guard, signal));
      },
      matches(backend: unknown, capture: unknown) {
        return matchesNativeHarnessOutputCapture(backend, capture);
      },
      revalidateOwner() {
        return null;
      },
    };
    const h = setup(f, {
      output: port,
      policy: { perRunUsd: 1, lifetimeUsd: 2 },
    });
    const signal1 = new AbortController().signal;
    const result1 = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal1));
    const wire1 = projectionFor(result1);
    expect(h.coordinator.registerToolResultProjection("call-1", result1, wire1, signal1).ok).toBe(true);
    await emitResult(f, "call-1", wire1);

    const signal2 = new AbortController().signal;
    const result2 = await settle(h.coordinator.invoke("call-2", { task: WORK_TASK }, signal2));
    const wire2 = projectionFor(result2);
    expect(h.coordinator.registerToolResultProjection("call-2", result2, wire2, signal2).ok).toBe(true);
    await emitResult(f, "call-2", wire2);

    const sharedSignal = new AbortController().signal;
    const first = h.coordinator.captureOutput("call-1", sharedSignal);
    const joined = h.coordinator.captureOutput("call-1", sharedSignal);
    expect(joined).toBe(first);
    expect(captureCalls).toBe(1);
    const otherSignal = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(otherSignal.ok).toBe(false);
    if (!otherSignal.ok) expect(otherSignal.code).toBe("capacity");
    const otherSlot = await settle(h.coordinator.captureOutput("call-2", new AbortController().signal));
    expect(otherSlot.ok).toBe(false);
    if (!otherSlot.ok) expect(otherSlot.code).toBe("capacity");
    expect(h.coordinator.inspect().output.reservedBytes).toBe(1024 * 1024);
    release();
    const captured = await settle(first);
    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.code).not.toBe("capacity");
    expect(captureCalls).toBe(1);
    const snapshot = h.coordinator.inspect();
    expect(snapshot.output.reservedBytes).toBe(0);
    expect(snapshot.output.active).toBe(false);
    expect(snapshot.output.retainedCaptures).toBe(0);
    expect(snapshot.operations[0]!.output.state).toBe("failed");
  });

  test("retained capture count is bounded at eight with once-only accounting", async () => {
    const f = await preparedFixture();
    await writeFile(path.join(f.workspace, "tiny.txt"), "x", { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, "tiny.txt");
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 5, maxRetainedOperations: 16 },
      output: {
        async capture() {
          return { ok: true as const, capture: syntheticCapture(snapshot, 1, WORK_TASK) };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return null;
        },
      },
    });
    const ids = Array.from({ length: 9 }, (_, index) => `call-${index + 1}`);
    for (const id of ids) {
      await callHarness(f, id);
      const signal = new AbortController().signal;
      const result = await settle(h.coordinator.invoke(id, { task: WORK_TASK }, signal));
      const wire = projectionFor(result);
      expect(h.coordinator.registerToolResultProjection(id, result, wire, signal).ok).toBe(true);
      await emitResult(f, id, wire);
    }
    for (const id of ids.slice(0, 8)) {
      const selected = await settle(h.coordinator.captureOutput(id, new AbortController().signal));
      expect(selected.ok).toBe(true);
    }
    const ninth = await settle(h.coordinator.captureOutput(ids[8]!, new AbortController().signal));
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.code).toBe("capacity");
    const snapshotState = h.coordinator.inspect();
    expect(snapshotState.output.retainedCaptures).toBe(8);
    expect(snapshotState.output.retainedBytes).toBe(8);
    expect(snapshotState.output.reservedBytes).toBe(0);
    expect(snapshotState.output.active).toBe(false);
  });

  test("retained plus reserved output bytes are bounded at two MiB", async () => {
    const f = await preparedFixture();
    const bytes = 250 * 1024;
    await writeFile(path.join(f.workspace, "large.txt"), "a".repeat(bytes), { mode: 0o600 });
    const snapshot = await captureWorkspaceText(f.workspace, "large.txt");
    const h = setup(f, {
      policy: { perRunUsd: 0.5, lifetimeUsd: 5 },
      output: {
        async capture() {
          return { ok: true as const, capture: syntheticCapture(snapshot, 4, WORK_TASK) };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return null;
        },
      },
    });
    for (const id of ["call-1", "call-2", "call-3"]) {
      await callHarness(f, id);
      const signal = new AbortController().signal;
      const result = await settle(h.coordinator.invoke(id, { task: WORK_TASK }, signal));
      const wire = projectionFor(result);
      expect(h.coordinator.registerToolResultProjection(id, result, wire, signal).ok).toBe(true);
      await emitResult(f, id, wire);
    }
    for (const id of ["call-1", "call-2"]) {
      const selected = await settle(h.coordinator.captureOutput(id, new AbortController().signal));
      expect(selected.ok).toBe(true);
    }
    const third = await settle(h.coordinator.captureOutput("call-3", new AbortController().signal));
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe("capacity");
    const snapshotState = h.coordinator.inspect();
    expect(snapshotState.output.retainedCaptures).toBe(2);
    expect(snapshotState.output.retainedBytes).toBe(bytes * 8);
    expect(snapshotState.output.reservedBytes).toBe(0);
  });

  test("running same-signal joins revalidate scope and preserve the owner promise", async () => {
    const f = await preparedFixture();
    let currentContext: NativeContext = f.ctx;
    let owner = "null";
    const reentry: { value: Promise<NativeHarnessOutputSelection> | null } = { value: null };
    let coordinatorRef: NativeHarnessDelegationCoordinator | null = null;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sharedSignal = new AbortController().signal;
    const h = setup(f, {
      getContext: () => currentContext,
      output: {
        capture(backend: unknown, guard: () => void, signal: AbortSignal) {
          if (coordinatorRef !== null) {
            // Synchronous leaf reentry must observe the already-installed promise.
            reentry.value = coordinatorRef.captureOutput("call-1", sharedSignal);
          }
          return gate.then(() => captureNativeHarnessOutput(backend, guard, signal));
        },
        matches(backend: unknown, capture: unknown) {
          return matchesNativeHarnessOutputCapture(backend, capture);
        },
        revalidateOwner() {
          if (owner === "string") return "the owner was replaced";
          return null;
        },
      },
    });
    coordinatorRef = h.coordinator;
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    expect(h.coordinator.registerToolResultProjection("call-1", result, wire, signal).ok).toBe(true);
    await emitResult(f, "call-1", wire);

    const first = h.coordinator.captureOutput("call-1", sharedSignal);
    expect(reentry.value).not.toBeNull();
    expect(reentry.value).toBe(first);

    currentContext = { ...f.ctx, agent: { kind: "sub" } };
    const foreign = await settle(h.coordinator.captureOutput("call-1", sharedSignal));
    expect(foreign).not.toBe(first);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("authority-lost");

    currentContext = f.ctx;
    owner = "string";
    const ownerRefused = await settle(h.coordinator.captureOutput("call-1", sharedSignal));
    expect(ownerRefused.ok).toBe(false);
    if (!ownerRefused.ok) expect(ownerRefused.code).toBe("authority-lost");

    owner = "null";
    const legitimate = h.coordinator.captureOutput("call-1", sharedSignal);
    expect(legitimate).toBe(first);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(1024 * 1024);
    release();
    const settled = await settle(first);
    expect(settled.ok).toBe(false);
    if (!settled.ok) expect(settled.code).not.toBe("capacity");
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
  });

  test("cancel during capture aborts only the capture; admitted failure is terminal", async () => {
    const f = await preparedFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup(f, {
      output: {
        capture(backend: unknown, guard: () => void, signal: AbortSignal) {
          return gate.then(() => captureNativeHarnessOutput(backend, guard, signal));
        },
        matches(backend: unknown, capture: unknown) {
          return matchesNativeHarnessOutputCapture(backend, capture);
        },
        revalidateOwner() {
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    expect(h.coordinator.registerToolResultProjection("call-1", result, wire, signal).ok).toBe(true);
    await emitResult(f, "call-1", wire);
    const inFlight = h.coordinator.captureOutput("call-1", new AbortController().signal);
    expect(h.coordinator.cancel("call-1")).toBe(true);
    expect(h.calls.cancel).toBe(0);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(1024 * 1024);
    release();
    const cancelled = await settle(inFlight);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe("cancelled");
    expect(h.calls.cancel).toBe(0);
    const repeated = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(repeated).toBe(cancelled);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(0);
    expect(h.coordinator.inspect().operations[0]!.output.state).toBe("failed");
    expect(h.coordinator.cancel("call-1")).toBe(false);
  });

  test("an admitted leaf failure remains terminal after capacity is restored", async () => {
    const f = await preparedFixture();
    let captureCalls = 0;
    const h = setup(f, {
      output: {
        async capture() {
          captureCalls += 1;
          return { ok: false as const, code: "changed" as const, reason: "source changed" };
        },
        matches() {
          return true;
        },
        revalidateOwner() {
          return null;
        },
      },
    });
    const signal = new AbortController().signal;
    const result = await settle(h.coordinator.invoke("call-1", { task: WORK_TASK }, signal));
    const wire = projectionFor(result);
    expect(h.coordinator.registerToolResultProjection("call-1", result, wire, signal).ok).toBe(true);
    await emitResult(f, "call-1", wire);
    const failed = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.code).toBe("source-conflict");
    const restored = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(restored).toBe(failed);
    expect(captureCalls).toBe(1);
    expect(h.coordinator.inspect().output.reservedBytes).toBe(0);
    expect(h.coordinator.inspect().output.retainedCaptures).toBe(0);
    expect(h.coordinator.inspect().operations[0]!.output.state).toBe("failed");
  });

  test("actual native controls, backend, runner and output leaf register and capture once", async () => {
    const f = await fixture();
    await writeFile(path.join(f.workspace, "a.txt"), "alpha\n", { mode: 0o600 });
    await startWork(f, "capture the bounded output");
    await callHarness(f);
    const storageRoot = path.join(f.root, "private");
    await mkdir(storageRoot, { mode: 0o700 });
    const runner = outputCandidateRunner();
    const factory = createNativeHarnessBackend({
      model: "deepseek/deepseek-chat",
      ompCommand: "/usr/bin/fake-omp",
      storageRoot,
      inputFiles: ["a.txt"],
    }, { deterministicRunner: runner });
    let preparedBackend: NativeHarnessBackend | null = null;
    const h = setup(f, {
      runner,
      output: actualOutputPort(),
      prepare(request, context, calls) {
        calls.guard += 1;
        request.guard();
        return factory.prepare(request, context).then((prepared) => {
          if (prepared.ok) preparedBackend = prepared.backend;
          return prepared;
        });
      },
    });
    const scopes: string[] = [];
    const entry = createNativeHarnessEntry({
      resolveRoot() {
        return {
          ok: true,
          root: {
            coordinator: h.coordinator,
            runWithContext<T>(_context: NativeContext, toolCallId: string, operation: () => Promise<T>): Promise<T> {
              scopes.push(toolCallId);
              return operation();
            },
            diagnostics: () => [],
          },
        };
      },
    });
    const signal = new AbortController().signal;
    const toolResult = await entry.tool.execute(
      "call-1",
      { task: WORK_TASK },
      signal,
      undefined,
      f.ctx,
    );
    expect(toolResult.isError).toBeUndefined();
    expect(scopes).toEqual(["call-1"]);
    expect(Object.isFrozen(toolResult)).toBe(true);
    expect(Object.isFrozen(toolResult.details)).toBe(true);
    const projected = toolResult.details as Record<string, unknown>;
    expect(projected.resultKind).toBe("live");
    expect(projected.taskAccepted).toBe(false);

    await f.host.emit("tool_result", {
      toolCallId: "call-1",
      toolName: AGENT_HARNESS,
      input: { task: WORK_TASK },
      content: toolResult.content,
      details: toolResult.details,
      isError: false,
    }, f.ctx);

    const captureSignal = new AbortController().signal;
    const first = h.coordinator.captureOutput("call-1", captureSignal);
    const joined = h.coordinator.captureOutput("call-1", captureSignal);
    expect(joined).toBe(first);
    const selection = await settle(first) as NativeHarnessOutputSelection;
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.observation).toBe("captured-now");
    expect(selection.filesystemFreshness).toBe("observed-during-capture");
    expect(selection.capture.changes).toHaveLength(1);
    expect(selection.capture.changes[0]!.path).toBe("candidate.txt");
    expect(selection.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");
    expect(selection.taskSha256).toBe(createHash("sha256").update(WORK_TASK, "utf8").digest("hex"));
    expect(selection.expectedResultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(selection.observedResultSha256).toBe(selection.expectedResultSha256);
    expect(selection.taskAccepted).toBe(false);
    expect(selection.semanticAcceptance).toBe("not-evaluated");
    expect(preparedBackend).not.toBeNull();
    expect(matchesNativeHarnessOutputCapture(preparedBackend, selection.capture)).toBe(true);

    const cached = await settle(h.coordinator.captureOutput("call-1", new AbortController().signal));
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.observation).toBe("cached-historical");
    expect(cached.filesystemFreshness).toBe("not-rechecked");
    expect(cached.capture).toBe(selection.capture);
    expect(cached.capture.captureId).toBe(selection.capture.captureId);

    const completion = readNativeHarnessBackendCompletion(preparedBackend);
    if (!completion.ok) throw new Error(completion.reason);
    await writeFile(
      path.join(completion.completion.winner.cwd, "candidate.txt"),
      "changed after capture\n",
      { mode: 0o600 },
    );
    expect(selection.capture.changes[0]!.snapshot.text).toBe("candidate 0\n");
    const snapshot = h.coordinator.inspect();
    expect(snapshot.output.retainedCaptures).toBe(1);
    expect(snapshot.output.retainedBytes).toBeGreaterThan(0);
    expect(snapshot.output.reservedBytes).toBe(0);
    expect(snapshot.output.active).toBe(false);
    expect(snapshot.operations[0]!.output.registered).toBe(true);
    expect(snapshot.operations[0]!.output.captureId).toBe(selection.capture.captureId);
    expect(snapshot.operations[0]!.output.observedResultSha256).toBe(selection.observedResultSha256);
    const snapshotText = JSON.stringify(snapshot);
    expect(snapshotText).not.toContain("candidate 0");
    expect(snapshotText).not.toContain(WORK_TASK);
  });
});
