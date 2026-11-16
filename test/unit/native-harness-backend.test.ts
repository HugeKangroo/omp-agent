import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeHarnessBackend,
  matchesNativeHarnessBackendCompletion,
  NATIVE_HARNESS_BACKEND_MAX_RETAINED,
  readNativeHarnessBackendCompletion,
  type NativeHarnessBackendHostConfig,
  type NativeHarnessBackendTestOptions,
} from "../../src/native-harness-backend.ts";
import type { NativeHarnessBackendCompletion } from "../../src/native-harness-completion.ts";
import {
  NATIVE_HARNESS_MAX_DURATION_MS,
  NATIVE_HARNESS_MAX_TASK_BYTES,
  type NativeHarnessBackend,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import type { NativeContext } from "../../src/native-entry.ts";
import { NATIVE_HARNESS_RECOVERY_SOURCE_FILE } from "../../src/native-harness-recovery-source.ts";
import { nodeFileIo } from "../../src/native-work.ts";
import { HarnessController, type Runner, type WorkerRequest, type WorkerResult } from "../../vendor/harness2/index.ts";

const PLAN_RESPONSE = JSON.stringify({
  decision: "direct",
  reason: "Bounded test plan for a clear narrow task.",
  criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
  routes: [],
});

const SELECT_RESPONSE = JSON.stringify({
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

const EXPLORE_PLAN_RESPONSE = JSON.stringify({
  decision: "explore",
  reason: "Bounded test exploration.",
  criteria: [{ id: "task", description: "Fulfill the requested bounded task.", kind: "requirement" }],
  routes: [
    {
      id: "route_1",
      name: "Route one",
      approach: "Bounded first approach.",
      assumptions: [],
      tradeoffs: [],
    },
    {
      id: "route_2",
      name: "Route two",
      approach: "Bounded second approach.",
      assumptions: [],
      tradeoffs: [],
    },
  ],
});

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly host: NativeHarnessBackendHostConfig;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-g52b-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "private");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, "a.txt"), "alpha\n", { mode: 0o600 });
  await writeFile(path.join(sourceRoot, "b.txt"), "beta\n", { mode: 0o600 });
  return {
    root,
    sourceRoot,
    storageRoot,
    host: {
      model: "deepseek/deepseek-chat",
      ompCommand: "/usr/bin/fake-omp",
      storageRoot,
      inputFiles: ["a.txt", "b.txt"],
    },
  };
}

function contextFor(f: Fixture): NativeContext {
  return {
    cwd: f.sourceRoot,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "g52b-session",
      getCwd: () => f.sourceRoot,
    },
  };
}

interface RequestOverrides {
  readonly budget?: NativeHarnessPrepareRequest["budget"];
  readonly signal?: AbortSignal;
  readonly runner?: Runner;
  readonly guard?: () => void;
}

function prepareRequest(f: Fixture, runner: Runner, overrides: RequestOverrides = {}): NativeHarnessPrepareRequest {
  return Object.freeze({
    association: Object.freeze({
      observationId: "observation-g52b",
      generation: 1,
      sessionId: "g52b-session",
      workspaceRoot: f.sourceRoot,
      toolCallId: "call-g52b",
      toolName: "agent_harness" as const,
    }),
    budget: Object.freeze(overrides.budget ?? {
      maxCostUsd: 1,
      deadlineAt: Date.now() + 120_000,
      maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS,
    }),
    signal: overrides.signal ?? new AbortController().signal,
    runner: overrides.runner ?? runner,
    guard: overrides.guard ?? (() => undefined),
  });
}

const DURABLE_OWNER_ID = "11111111-1111-4111-8111-111111111111";
const DURABLE_ADMISSION_ID = "22222222-2222-4222-8222-222222222222";

function durableAssociation(f: Fixture): {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly toolCallId: string;
  readonly toolName: "agent_harness";
} {
  return {
    observationId: "durable-observation",
    generation: 1,
    sessionId: "durable-session",
    workspaceRoot: f.sourceRoot,
    toolCallId: "durable-call",
    toolName: "agent_harness" as const,
  };
}

function associationDigest(association: ReturnType<typeof durableAssociation>): string {
  return createHash("sha256").update(JSON.stringify({
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
    toolCallId: association.toolCallId,
    toolName: association.toolName,
  })).digest("hex");
}

function durableRequest(
  f: Fixture,
  runner: Runner,
  options: {
    readonly admittedAt?: number;
    readonly maxDurationMs?: number;
    readonly signal?: AbortSignal;
    readonly guard?: () => void;
  } = {},
): NativeHarnessPrepareRequest {
  const association = durableAssociation(f);
  const admittedAt = options.admittedAt ?? Date.now() - 1_000;
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  return Object.freeze({
    association: Object.freeze(association),
    accounting: Object.freeze({
      ownerId: DURABLE_OWNER_ID,
      admissionId: DURABLE_ADMISSION_ID,
      reserveRevision: 1,
      sourceAssociationSha256: associationDigest(association),
      admittedAt,
    }),
    budget: Object.freeze({
      maxCostUsd: 1,
      deadlineAt: admittedAt + maxDurationMs,
      maxDurationMs,
    }),
    signal: options.signal ?? new AbortController().signal,
    runner,
    guard: options.guard ?? (() => undefined),
  });
}

async function preparedRootOf(
  factory: ReturnType<typeof createNativeHarnessBackend>,
): Promise<string> {
  const root = factory.inspect().at(-1)?.preparedRoot;
  if (root === null || root === undefined) throw new Error("no prepared root was retained");
  return root;
}

async function withCreateSpy<T>(
  transform: (record: Awaited<ReturnType<HarnessController["create"]>>) => unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const original = HarnessController.prototype.create;
  const patched = async function (
    this: HarnessController,
    ...args: Parameters<HarnessController["create"]>
  ): Promise<Awaited<ReturnType<HarnessController["create"]>>> {
    const record = await original.apply(this, args);
    return transform(record) as Awaited<ReturnType<HarnessController["create"]>>;
  };
  HarnessController.prototype.create = patched;
  try {
    return await fn();
  } finally {
    HarnessController.prototype.create = original;
  }
}

async function withGetSpy<T>(
  transform: (record: NonNullable<Awaited<ReturnType<HarnessController["get"]>>>) => unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const original = HarnessController.prototype.get;
  const patched = async function (
    this: HarnessController,
    id: string,
  ): Promise<Awaited<ReturnType<HarnessController["get"]>>> {
    const record = await original.call(this, id);
    return record === undefined
      ? undefined
      : transform(record) as Awaited<ReturnType<HarnessController["get"]>>;
  };
  HarnessController.prototype.get = patched;
  try {
    return await fn();
  } finally {
    HarnessController.prototype.get = original;
  }
}

async function withControllerDispatchCounters<T>(
  fn: () => Promise<T>,
): Promise<{ readonly value: T; readonly createCalls: number; readonly executeCalls: number }> {
  const originalCreate = HarnessController.prototype.create;
  const originalExecute = HarnessController.prototype.execute;
  let createCalls = 0;
  let executeCalls = 0;
  const patchedCreate = async function (
    this: HarnessController,
    ...args: Parameters<HarnessController["create"]>
  ): Promise<Awaited<ReturnType<HarnessController["create"]>>> {
    createCalls += 1;
    return originalCreate.apply(this, args);
  };
  const patchedExecute = async function (
    this: HarnessController,
    ...args: Parameters<HarnessController["execute"]>
  ): Promise<Awaited<ReturnType<HarnessController["execute"]>>> {
    executeCalls += 1;
    return originalExecute.apply(this, args);
  };
  HarnessController.prototype.create = patchedCreate;
  HarnessController.prototype.execute = patchedExecute;
  try {
    return { value: await fn(), createCalls, executeCalls };
  } finally {
    HarnessController.prototype.create = originalCreate;
    HarnessController.prototype.execute = originalExecute;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function settle<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test promise timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

interface DeterministicRunner {
  readonly runner: Runner;
  readonly requests: WorkerRequest[];
  readonly results: WorkerResult[];
  readonly baselineStarted: Promise<WorkerRequest>;
}

function deterministicRunner(options: {
  blockBaseline?: boolean;
  eventsFile?: string;
  failBaselineOnce?: boolean;
  hugeBaselineText?: boolean;
  hugeSelectText?: boolean;
} = {}): DeterministicRunner {
  const requests: WorkerRequest[] = [];
  const results: WorkerResult[] = [];
  const started = deferred<WorkerRequest>();
  const eventsFile = options.eventsFile ?? "worker-events.jsonl";
  let pendingBaselineFailures = options.failBaselineOnce === true ? 1 : 0;
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      if (options.blockBaseline === true && request.stage === "baseline") {
        started.resolve(request);
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted === true) {
            resolve();
            return;
          }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
        const eventsPath = path.join(request.artifactDir, eventsFile);
        await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
        const result: WorkerResult = {
          text: "",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          eventsPath,
          status: "cancelled",
        };
        results.push(result);
        return result;
      }
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, eventsFile);
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = PLAN_RESPONSE;
      } else if (request.stage === "select") {
        text = options.hugeSelectText === true ? "x".repeat(1024 * 1024 + 1) : SELECT_RESPONSE;
      } else if (request.stage === "baseline") {
        await writeFile(path.join(request.cwd, "candidate.txt"), "candidate\n", { mode: 0o600 });
        text = "baseline completed";
      }
      let status: WorkerResult["status"] = "completed";
      let error: string | undefined;
      if (request.stage === "baseline" && pendingBaselineFailures > 0) {
        pendingBaselineFailures -= 1;
        status = "failed";
        error = "fixture baseline failure";
        text = "baseline failed";
      }
      if (request.stage === "baseline" && options.hugeBaselineText === true) {
        text = "x".repeat(1024 * 1024 + 1);
      }
      const result: WorkerResult = {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status,
        ...(error === undefined ? {} : { error }),
      };
      results.push(result);
      return result;
    },
  };
  return { runner, requests, results, baselineStarted: started.promise };
}

function explorationEvaluation(stage: "review" | "select", runId: string): string {
  const candidates = stage === "review"
    ? ["baseline", "route_1", "route_2"]
    : ["baseline", "route_1", "route_2", "refine"];
  const ordered = [...candidates].sort((left, right) => {
    const leftHash = createHash("sha256").update(`${runId}:${left}`).digest("hex");
    const rightHash = createHash("sha256").update(`${runId}:${right}`).digest("hex");
    return leftHash.localeCompare(rightHash);
  });
  const label = (candidate: string): string => {
    const index = ordered.indexOf(candidate);
    if (index < 0) throw new Error("fixture candidate is not evaluated");
    return String.fromCharCode(65 + index);
  };
  const winner = stage === "review" ? "route_2" : "refine";
  return JSON.stringify({
    assessments: ordered.map((candidate) => ({
      candidate: label(candidate),
      criteria: [{ criterionId: "task", verdict: "unknown", evidence: "Bounded fixture evidence." }],
      strengths: [],
      weaknesses: [],
    })),
    winner: label(winner),
    reason: "Bounded fixture selection.",
    limitations: ["Bounded fixture execution is not semantic acceptance."],
    ...(stage === "review"
      ? { refinement: { candidate: label("route_2"), instructions: "Refine the bounded route." } }
      : {}),
  });
}

function exploreRunner(): DeterministicRunner {
  const requests: WorkerRequest[] = [];
  const results: WorkerResult[] = [];
  const started = deferred<WorkerRequest>();
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      requests.push(request);
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = EXPLORE_PLAN_RESPONSE;
      } else if (request.stage === "review" || request.stage === "select") {
        text = explorationEvaluation(request.stage, request.runId);
      } else if (request.stage === "reflect") {
        text = "bounded non-lesson response";
      } else {
        await writeFile(path.join(request.cwd, `${request.stage}.txt`), `${request.stage}\n`, { mode: 0o600 });
        text = `${request.stage} completed`;
      }
      const result: WorkerResult = {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        eventsPath,
        status: "completed",
      };
      results.push(result);
      return result;
    },
  };
  return { runner, requests, results, baselineStarted: started.promise };
}

async function prepareBackend(
  factory: ReturnType<typeof createNativeHarnessBackend>,
  f: Fixture,
  request: NativeHarnessPrepareRequest,
): Promise<{ backend: NativeHarnessBackend; result: NativeHarnessPrepareResult }> {
  const result = await factory.prepare(request, contextFor(f));
  if (!result.ok) throw new Error(`prepare failed: ${result.reason}`);
  return { backend: result.backend, result };
}

async function requiredRunId(backend: NativeHarnessBackend, task = "bounded test task"): Promise<string> {
  const created = await backend.create(task) as { readonly runId?: unknown };
  if (typeof created.runId !== "string") throw new Error("backend create returned no runId");
  return created.runId;
}

async function readRecord(storeRoot: string, runId: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(storeRoot, "runs", runId, "run.json"), "utf8")) as Record<string, any>;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe("G5-2B actual Harness2 backend adapter", () => {
  test("prepare, one create and auto execute produce a completed private run without touching the source workspace", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    let preparationDone = false;
    const guard = () => {
      if (preparationDone) throw new Error("preparation guard is closed");
    };
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner, { guard }));
    preparationDone = true;
    const runId = await requiredRunId(backend, "bounded test task");
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");

    const diagnostic = factory.inspect().at(-1)!;
    expect(diagnostic.runId).toBe(runId);
    expect(diagnostic.backendStatus).toBe("completed");
    expect(diagnostic.inputManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(diagnostic.inputFileCount).toBe(2);
    expect(diagnostic.inputBytes).toBe(11);
    expect(diagnostic.retainedForInspection).toBe(true);
    expect(diagnostic.reason).toBeNull();
    expect(diagnostic.storeRoot).not.toBeNull();
    expect(diagnostic.workspaceRoot).not.toBeNull();
    const serializedDiagnostics = JSON.stringify(factory.inspect());
    expect(serializedDiagnostics).not.toContain("bounded test task");
    expect(serializedDiagnostics).not.toContain(f.host.model);
    expect(serializedDiagnostics).not.toContain("baseline completed");
    expect(serializedDiagnostics).not.toContain("candidate\n");

    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.status).toBe("completed");
    expect(record.task).toBe("bounded test task");
    expect(record.appliedAt).toBeUndefined();
    expect(record.winner).toBe("baseline");
    expect(record.stages.plan.status).toBe("completed");
    expect(record.stages.baseline.status).toBe("completed");
    expect(record.stages.select.status).toBe("completed");
    expect(record.stages.baseline.result.text).toBe("baseline completed");

    expect(det.requests.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);
    const runArea = path.join(diagnostic.storeRoot!, "runs", runId);
    for (const request of det.requests) {
      expect(request.runId).toBe(runId);
      expect(request.model).toBe(f.host.model);
      expect(request.ompCommand).toBe(f.host.ompCommand);
      expect(request.execution).toBeUndefined();
      expect(request.generatedExtensions).toBeUndefined();
      expect(request.cwd.startsWith(`${path.join(runArea, "stages")}${path.sep}`)).toBe(true);
      expect(request.artifactDir.startsWith(`${path.join(runArea, "stages")}${path.sep}`)).toBe(true);
    }

    expect(await readFile(path.join(f.sourceRoot, "a.txt"), "utf8")).toBe("alpha\n");
    expect(await readFile(path.join(f.sourceRoot, "b.txt"), "utf8")).toBe("beta\n");
    expect(await exists(path.join(f.sourceRoot, "candidate.txt"))).toBe(false);
    const events = await readFile(path.join(runArea, "events.jsonl"), "utf8");
    expect(events).not.toContain('"type":"applied"');
  });

  test("dispatch uses the prepare-provided guarded runner, not the factory runner", async () => {
    const f = await fixture();
    const factoryRunner = deterministicRunner();
    const providedRunner = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: factoryRunner.runner });
    expect(factory.runner).toBe(factoryRunner.runner);
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, providedRunner.runner));
    const runId = await requiredRunId(backend);
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    expect(factoryRunner.requests).toHaveLength(0);
    expect(providedRunner.requests.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);
    for (const request of providedRunner.requests) expect(request.runId).toBe(runId);
  });

  test("queued cancellation goes through the actual Controller with zero worker dispatch", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    await backend.cancel(runId);
    const queued = await backend.get!(runId) as { readonly status?: unknown } | null;
    expect(queued?.status).toBe("queued");
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("cancelled");
    expect(det.requests).toHaveLength(0);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.status).toBe("cancelled");
    expect(record.appliedAt).toBeUndefined();
  });

  test("active cancellation aborts the in-flight worker and never applies", async () => {
    const f = await fixture();
    const det = deterministicRunner({ blockBaseline: true });
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const execution = backend.execute(runId) as Promise<{ readonly status?: unknown }>;
    await settle(det.baselineStarted);
    await backend.cancel(runId);
    const executed = await settle(execution);
    expect(executed.status).toBe("cancelled");
    expect(det.requests.map((request) => request.stage)).toEqual(["plan", "baseline"]);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.status).toBe("cancelled");
    expect(record.appliedAt).toBeUndefined();
    expect(record.stages.select).toBeUndefined();
  });

  test("create accepts only a bounded string task", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    await expect(backend.create("   ")).rejects.toThrow("nonempty");
    await expect(backend.create({ task: "object form" } as unknown as string)).rejects.toThrow("nonempty");
    await expect(backend.create("x".repeat(NATIVE_HARNESS_MAX_TASK_BYTES + 1))).rejects.toThrow("exceeds");
    const runId = await requiredRunId(backend);
    expect(det.requests).toHaveLength(0);
    expect(runId.length).toBeGreaterThan(0);
  });

  test("invalid host configuration and model/path overrides are rejected before any effect", async () => {
    const f = await fixture();
    expect(() => createNativeHarnessBackend({
      ...f.host,
      modelPath: "/tmp/override",
    } as unknown as NativeHarnessBackendHostConfig)).toThrow("exact plain object");
    expect(() => createNativeHarnessBackend({ ...f.host, model: "openai/gpt*" })).toThrow("model");
    expect(() => createNativeHarnessBackend({ ...f.host, model: "/tmp/model" })).toThrow("model");
    expect(() => createNativeHarnessBackend({ ...f.host, ompCommand: "omp" })).toThrow("absolute");
    expect(() => createNativeHarnessBackend({ ...f.host, storageRoot: "relative/private" })).toThrow("absolute");
    expect(() => createNativeHarnessBackend({
      ...f.host,
      inputFiles: ["a.txt", "a.txt"],
    })).toThrow("duplicate");
    expect(() => createNativeHarnessBackend({
      ...f.host,
      inputFiles: ["../outside.txt"],
    })).toThrow("relative");
  });

  test("expired deadline, pre-aborted signal and rejected guard prepare nothing", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });

    const expired = await factory.prepare(prepareRequest(f, factory.runner, {
      budget: { maxCostUsd: 1, deadlineAt: Date.now() - 1, maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS },
    }), contextFor(f));
    expect(expired.ok).toBe(false);
    expect(factory.inspect()).toHaveLength(0);

    const aborted = new AbortController();
    aborted.abort();
    const preAborted = await factory.prepare(prepareRequest(f, factory.runner, {
      signal: aborted.signal,
    }), contextFor(f));
    expect(preAborted.ok).toBe(false);
    expect(factory.inspect()).toHaveLength(0);

    const rejected = await factory.prepare(prepareRequest(f, factory.runner, {
      guard: () => {
        throw new Error("authority lost");
      },
    }), contextFor(f));
    expect(rejected.ok).toBe(false);
    expect(factory.inspect()).toHaveLength(0);
    expect(det.requests).toHaveLength(0);
  });

  test("create recomputes the remaining duration instead of resetting the admitted deadline", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    let clock = 1_800_000_000_000;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => clock,
    });
    const budget = {
      maxCostUsd: 1,
      deadlineAt: clock + 60_000,
      maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS,
    };
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner, { budget }));
    clock += 50_000;
    const runId = await requiredRunId(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.config.maxDurationMs).toBeGreaterThan(0);
    expect(record.config.maxDurationMs).toBeLessThanOrEqual(10_000);
    expect(record.config.maxDurationMs).toBeLessThan(60_000);
    expect(record.config.stageTimeoutMs).toBe(record.config.maxDurationMs);
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
  });

  test("changed, missing, symlinked and extra base snapshot inputs fail closed before dispatch", async () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (snapshotRoot: string, runDir: string, f: Fixture) => Promise<void>;
    }> = [
      {
        name: "changed",
        async mutate(snapshotRoot) {
          await writeFile(path.join(snapshotRoot, "a.txt"), "tampered\n", { mode: 0o600 });
        },
      },
      {
        name: "missing",
        async mutate(snapshotRoot) {
          await unlink(path.join(snapshotRoot, "a.txt"));
        },
      },
      {
        name: "symlink",
        async mutate(snapshotRoot, _runDir, f) {
          const target = path.join(snapshotRoot, "a.txt");
          await unlink(target);
          await symlink(path.join(f.sourceRoot, "a.txt"), target);
        },
      },
      {
        name: "extra",
        async mutate(snapshotRoot, runDir) {
          await writeFile(path.join(snapshotRoot, "extra.txt"), "extra\n", { mode: 0o600 });
          const recordPath = path.join(runDir, "run.json");
          const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>;
          record.snapshot.files.push({
            path: "extra.txt",
            hash: "0".repeat(64),
            size: 6,
            mode: 0o600,
          });
          await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
        },
      },
    ];

    for (const item of cases) {
      const f = await fixture();
      const det = deterministicRunner();
      const factory = createNativeHarnessBackend(f.host, {
        deterministicRunner: det.runner,
        async beforeBaseInputCheck(facts) {
          await item.mutate(facts.snapshotRoot, path.dirname(facts.snapshotRoot), f);
        },
      });
      const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
      const runId = await requiredRunId(backend);
      const executed = await backend.execute(runId) as { readonly status?: unknown };
      expect(executed.status, item.name).toBe("failed");
      expect(det.requests, item.name).toHaveLength(0);
      expect(factory.inspect().at(-1)!.backendStatus, item.name).toBe("failed");
    }
  });

  test("ambient global Git ignore that omits a selected input refuses zero worker calls", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);

    const ignoreFile = path.join(f.root, "ambient-global-ignore");
    const gitConfig = path.join(f.root, "ambient-gitconfig");
    await writeFile(ignoreFile, "a.txt\n", { mode: 0o600 });
    await writeFile(gitConfig, `[core]\n\texcludesFile = ${ignoreFile}\n`, { mode: 0o600 });
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    let executed: { readonly status?: unknown };
    try {
      executed = await backend.execute(runId) as { readonly status?: unknown };
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(executed.status).toBe("failed");
    expect(det.requests).toHaveLength(0);
    const diagnostic = factory.inspect().at(-1)!;
    expect(diagnostic.backendStatus).toBe("failed");
    expect(await readFile(path.join(f.sourceRoot, "a.txt"), "utf8")).toBe("alpha\n");
  });

  test("worker request run, model, cwd and artifact scope overrides fail closed before dispatch", async () => {
    const mutations: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (request: WorkerRequest, f: Fixture) => void;
    }> = [
      {
        name: "run id",
        mutate(request) {
          request.runId = "not-the-created-run";
        },
      },
      {
        name: "model",
        mutate(request) {
          request.model = "other/model";
        },
      },
      {
        name: "omp command",
        mutate(request) {
          request.ompCommand = "/usr/bin/other-omp";
        },
      },
      {
        name: "authentication source",
        mutate(request, f) {
          request.auth = { kind: "omp-profile", agentDir: path.join(f.root, "other-agent") };
        },
      },
      {
        name: "cost allocation",
        mutate(request) {
          request.maxCostUsd = 2;
        },
      },
      {
        name: "timeout allocation",
        mutate(request) {
          request.timeoutMs = NATIVE_HARNESS_MAX_DURATION_MS + 1;
        },
      },
      {
        name: "generated extensions",
        mutate(request) {
          request.generatedExtensions = [{}] as never;
        },
      },
      {
        name: "cwd",
        mutate(request, f) {
          request.cwd = f.sourceRoot;
        },
      },
      {
        name: "artifact dir",
        mutate(request, f) {
          request.artifactDir = path.join(f.sourceRoot, "artifacts");
        },
      },
      {
        name: "execution override",
        mutate(request) {
          request.execution = {
            kind: "omp-native",
            tools: ["read"],
            approvalMode: "yolo",
            approval: {},
            source: "test",
          };
        },
      },
    ];

    for (const item of mutations) {
      const f = await fixture();
      const det = deterministicRunner();
      let mutate: ((request: WorkerRequest) => void) | null = null;
      const factory = createNativeHarnessBackend(f.host, {
        deterministicRunner: det.runner,
        mutateWorkerRequest(request) {
          mutate?.(request);
        },
      });
      const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
      const runId = await requiredRunId(backend);
      mutate = (request) => item.mutate(request, f);
      const executed = await backend.execute(runId) as { readonly status?: unknown };
      expect(executed.status, item.name).toBe("failed");
      expect(det.requests, item.name).toHaveLength(0);
    }
  });

  test("failed post-snapshot preparation retains bounded host inspection locations", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const base = 1_800_000_000_000;
    let clock = base;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => clock,
    });
    const attempts = NATIVE_HARNESS_BACKEND_MAX_RETAINED + 1;
    for (let index = 0; index < attempts; index += 1) {
      clock = base;
      const result = await factory.prepare(prepareRequest(f, factory.runner, {
        budget: {
          maxCostUsd: 1,
          deadlineAt: base + 5_000,
          maxDurationMs: NATIVE_HARNESS_MAX_DURATION_MS,
        },
        guard: () => {
          clock = base + 6_000;
        },
      }), contextFor(f));
      expect(result.ok).toBe(false);
    }
    const diagnostics = factory.inspect();
    expect(diagnostics).toHaveLength(NATIVE_HARNESS_BACKEND_MAX_RETAINED);
    expect(diagnostics.every((entry) => entry.retainedForInspection)).toBe(true);
    expect(diagnostics.every((entry) => entry.preparedRoot !== null)).toBe(true);
    expect(diagnostics.every((entry) => entry.reason?.includes("expired during preparation") === true)).toBe(true);
    expect(new Set(diagnostics.map((entry) => entry.preparedRoot)).size).toBe(NATIVE_HARNESS_BACKEND_MAX_RETAINED);
    expect(det.requests).toHaveLength(0);
  });
});

function requireCompletion(backend: NativeHarnessBackend): NativeHarnessBackendCompletion {
  const observed = readNativeHarnessBackendCompletion(backend);
  if (!observed.ok) throw new Error(`completion unavailable: ${observed.reason}`);
  return observed.completion;
}

describe("G5-3A1 host-only actual backend completion", () => {
  test("actual completed solver dispatch issues one bounded host-only completion", async () => {
    const f = await fixture();
    const agentDir = path.join(f.root, "agent-profile");
    const host: NativeHarnessBackendHostConfig = {
      ...f.host,
      auth: { kind: "omp-profile", agentDir },
    };
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend, "completion task");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);

    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    const completion = requireCompletion(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    const baseline = record.stages.baseline;
    const baselineRequest = det.requests.find((request) => request.stage === "baseline")!;

    expect(completion.schema).toBe("omp-agent.native-harness-backend-completion.v1");
    expect(completion.origin).toBe("harness2-native");
    expect(completion.taskAccepted).toBe(false);
    expect(completion.semanticAcceptance).toBe("not-evaluated");
    expect(completion.runId).toBe(runId);
    expect(completion.taskSha256).toBe(createHash("sha256").update("completion task").digest("hex"));
    expect(completion.model).toBe(host.model);
    expect(completion.profile).toEqual({ strategy: "auto", mode: "product", domain: "generic" });
    expect(completion.sourceId).toMatch(/^[a-f0-9]{64}$/);

    expect(completion.prepared.sourceRoot).toBe(f.sourceRoot);
    expect(completion.prepared.preparedRoot).toBe(diagnostic.preparedRoot!);
    expect(completion.prepared.workspaceRoot).toBe(diagnostic.workspaceRoot!);
    expect(completion.prepared.storeRoot).toBe(diagnostic.storeRoot!);
    expect(completion.prepared.manifestSha256).toBe(diagnostic.inputManifestSha256!);
    expect(completion.prepared.inputs).toEqual([
      {
        relativePath: "a.txt",
        bytes: 6,
        sha256: createHash("sha256").update("alpha\n").digest("hex"),
      },
      {
        relativePath: "b.txt",
        bytes: 5,
        sha256: createHash("sha256").update("beta\n").digest("hex"),
      },
    ]);

    expect(completion.base.snapshotId).toBe(record.snapshot.id);
    expect(completion.base.root).toBe(record.snapshot.root);
    expect(completion.base.sourceRoot).toBe(record.snapshot.sourceRoot);
    expect(completion.base.createdAt).toBe(record.snapshot.createdAt);
    expect(completion.base.manifestSha256).toBe(diagnostic.inputManifestSha256!);
    const expectedEntries = [...record.snapshot.files]
      .map((entry: Record<string, any>) => ({
        path: entry.path,
        size: entry.size,
        mode: entry.mode,
        hash: entry.hash,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(completion.base.entries).toEqual(expectedEntries);

    expect(completion.winner.candidate).toBe("baseline");
    expect(completion.winner.attempt).toBe(baseline.attempt);
    expect(completion.winner.cwd).toBe(baseline.cwd);
    expect(completion.winner.cwd).toBe(baselineRequest.cwd);
    expect(completion.winner.artifactDir).toBe(baselineRequest.artifactDir);
    expect(completion.winner.eventsPath).toBe(path.join(baselineRequest.artifactDir, "worker-events.jsonl"));
    expect(completion.winner.artifactHash).toBe(baseline.artifactHash);
    expect(completion.winner.traceHash).toBe(baseline.traceHash);
    expect(completion.winner.resultStatus).toBe("completed");
    expect(completion.winner.startedAt).toBe(baseline.result.startedAt);
    expect(completion.winner.endedAt).toBe(baseline.result.endedAt);
    expect(completion.winner.textBytes).toBe(Buffer.byteLength("baseline completed", "utf8"));
    expect(completion.winner.textSha256)
      .toBe(createHash("sha256").update("baseline completed").digest("hex"));
    expect(completion.ancestry).toEqual([]);
    expect(completion.limitations.length).toBeGreaterThan(0);

    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(true);
    const again = readNativeHarnessBackendCompletion(backend);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.completion).toBe(completion);
    expect(matchesNativeHarnessBackendCompletion(backend, { ...completion })).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, JSON.parse(JSON.stringify(completion)))).toBe(false);
    expect(matchesNativeHarnessBackendCompletion({ ...backend }, completion)).toBe(false);

    expect(Object.isFrozen(completion)).toBe(true);
    expect(Object.isFrozen(completion.winner)).toBe(true);
    expect(Object.isFrozen(completion.prepared.inputs)).toBe(true);
    const serialized = JSON.stringify(completion);
    expect(serialized).not.toContain("completion task");
    expect(serialized).not.toContain("baseline completed");
    expect(serialized).not.toContain("agentDir");
    expect(serialized).not.toContain("agent-profile");
    expect(serialized).not.toContain("\"prompt\"");
    expect(serialized).not.toContain("\"auth\"");
  });

  test("a completed disk short circuit without a real witness cannot issue authority", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const recordPath = path.join(diagnostic.storeRoot!, "runs", runId, "run.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>;
    record.status = "completed";
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });

    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    expect(det.requests).toHaveLength(0);
    const observed = readNativeHarnessBackendCompletion(backend);
    expect(observed.ok).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, {
      runId,
      winner: { candidate: "baseline" },
    })).toBe(false);
  });

  test("wrong actual dispatch stage, role or cwd makes output origin unavailable", async () => {
    const mutations: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (request: WorkerRequest) => void;
    }> = [
      {
        name: "stage",
        mutate(request) {
          request.stage = "final";
        },
      },
      {
        name: "role",
        mutate(request) {
          request.role = "selector";
        },
      },
      {
        name: "cwd",
        mutate(request) {
          request.cwd = path.dirname(request.artifactDir);
        },
      },
    ];

    for (const item of mutations) {
      const f = await fixture();
      const det = deterministicRunner();
      let mutate: ((request: WorkerRequest) => void) | null = null;
      const factory = createNativeHarnessBackend(f.host, {
        deterministicRunner: det.runner,
        mutateWorkerRequest(request) {
          mutate?.(request);
        },
      });
      const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
      const runId = await requiredRunId(backend);
      mutate = item.mutate;
      const executed = await backend.execute(runId) as { readonly status?: unknown };
      expect(executed.status, item.name).toBe("completed");
      expect(readNativeHarnessBackendCompletion(backend).ok, item.name).toBe(false);
    }
  });

  test("post-dispatch request, result and disk mutation never changes sealed facts", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    await backend.execute(runId);
    const completion = requireCompletion(backend);
    const before = JSON.stringify(completion);
    const index = det.requests.findIndex((request) => request.stage === "baseline");
    const baselineRequest = det.requests[index]!;
    const baselineResult = det.results[index]!;
    baselineRequest.cwd = f.sourceRoot;
    baselineRequest.artifactDir = path.join(f.sourceRoot, "outside-artifacts");
    baselineResult.text = "mutated result";
    baselineResult.eventsPath = path.join(f.sourceRoot, "outside-events.jsonl");
    const diagnostic = factory.inspect().at(-1)!;
    const recordPath = path.join(diagnostic.storeRoot!, "runs", runId, "run.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>;
    record.stages.baseline.result.text = "disk mutation";
    record.snapshot.id = "forged-snapshot";
    record.task = "mutated task";
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });

    expect(JSON.stringify(requireCompletion(backend))).toBe(before);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(true);
    const status = await backend.get!(runId) as { readonly status?: unknown };
    expect(status.status).toBe("completed");
    expect(JSON.stringify(requireCompletion(backend))).toBe(before);
  });

  test("identical repeated execute keeps the object; an observed mismatch is sticky", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    await backend.execute(runId);
    const completion = requireCompletion(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const recordPath = path.join(diagnostic.storeRoot!, "runs", runId, "run.json");
    const original = await readFile(recordPath, "utf8");

    const repeated = await backend.execute(runId) as { readonly status?: unknown };
    expect(repeated.status).toBe("completed");
    const repeatedRead = readNativeHarnessBackendCompletion(backend);
    expect(repeatedRead.ok).toBe(true);
    if (repeatedRead.ok) expect(repeatedRead.completion).toBe(completion);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(true);

    const changed = JSON.parse(original) as Record<string, any>;
    changed.stages.baseline.result.text = "tampered record";
    await writeFile(recordPath, JSON.stringify(changed), { mode: 0o600 });
    const observedMismatch = await backend.execute(runId) as { readonly status?: unknown };
    expect(observedMismatch.status).toBe("completed");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(false);

    await writeFile(recordPath, original, { mode: 0o600 });
    const restored = await backend.execute(runId) as { readonly status?: unknown };
    expect(restored.status).toBe("completed");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(false);
  });

  test("a changed applied status after issue is an observed mismatch", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    await backend.execute(runId);
    const completion = requireCompletion(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const recordPath = path.join(diagnostic.storeRoot!, "runs", runId, "run.json");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, any>;
    record.status = "applied";
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("applied");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(false);
  });

  test("multiple attempts match the selected final completed attempt", async () => {
    const f = await fixture();
    const det = deterministicRunner({ failBaselineOnce: true });
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);

    const failed = await backend.execute(runId) as { readonly status?: unknown };
    expect(failed.status).toBe("failed");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(det.requests.filter((request) => request.stage === "baseline")).toHaveLength(1);

    const completed = await backend.execute(runId) as { readonly status?: unknown };
    expect(completed.status).toBe("completed");
    expect(det.requests.filter((request) => request.stage === "baseline")).toHaveLength(2);
    const completion = requireCompletion(backend);
    expect(completion.winner.candidate).toBe("baseline");
    expect(completion.winner.attempt).toBe(2);
    expect(completion.winner.textSha256)
      .toBe(createHash("sha256").update("baseline completed").digest("hex"));

    await backend.cancel(runId);
    expect(matchesNativeHarnessBackendCompletion(backend, completion)).toBe(true);
    expect(requireCompletion(backend)).toBe(completion);
  });

  test("cancel after a failed execution cannot turn it into a completion source", async () => {
    const f = await fixture();
    const det = deterministicRunner({ failBaselineOnce: true });
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const failed = await backend.execute(runId) as { readonly status?: unknown };
    expect(failed.status).toBe("failed");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    await backend.cancel(runId);
    const cancelled = await backend.execute(runId) as { readonly status?: unknown };
    expect(cancelled.status).toBe("cancelled");
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(det.requests.filter((request) => request.stage === "baseline")).toHaveLength(1);
  });

  test("result text over the retained bound fails output origin without changing execution", async () => {
    const f = await fixture();
    const det = deterministicRunner({ hugeBaselineText: true });
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    expect(det.requests.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.status).toBe("completed");
    expect(record.stages.baseline.status).toBe("completed");
    expect(record.stages.baseline.result.text.length).toBe(1024 * 1024 + 1);
    expect(record.stages.baseline.accountedCostUsd).toBe(0.01);
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
  });

  test("a non-winning witness text overflow makes the output source unavailable", async () => {
    const f = await fixture();
    const det = deterministicRunner({ hugeSelectText: true });
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    expect(det.requests.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.status).toBe("completed");
    expect(record.winner).toBe("baseline");
    expect(record.stages.select.status).toBe("completed");
    expect(record.stages.select.result.text.length).toBe(1024 * 1024 + 1);
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
  });

  test("a legitimate refinement parent is retained with matching artifact lineage", async () => {
    const f = await fixture();
    const det = exploreRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    const executed = await backend.execute(runId) as { readonly status?: unknown };
    expect(executed.status).toBe("completed");
    const completion = requireCompletion(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const record = await readRecord(diagnostic.storeRoot!, runId);
    const refineRequest = det.requests.find((request) => request.stage === "refine")!;
    const routeRequest = det.requests.find((request) => request.stage === "route_2")!;

    expect(record.winner).toBe("refine");
    expect(completion.winner.candidate).toBe("refine");
    expect(completion.winner.cwd).toBe(refineRequest.cwd);
    expect(completion.winner.artifactHash).toBe(record.stages.refine.artifactHash);
    expect(completion.winner.traceHash).toBe(record.stages.refine.traceHash);
    expect(completion.winner.eventsPath).toBe(path.join(refineRequest.artifactDir, "worker-events.jsonl"));

    expect(completion.ancestry).toHaveLength(1);
    const parent = completion.ancestry[0]!;
    expect(parent.candidate).toBe("route_2");
    expect(parent.cwd).toBe(routeRequest.cwd);
    expect(parent.artifactHash).toBe(record.stages.route_2.artifactHash);
    expect(parent.artifactHash).toBe(record.stages.refine.parentArtifactHash);
    expect(parent.traceHash).toBe(record.stages.route_2.traceHash);
    expect(parent.eventsPath).toBe(path.join(routeRequest.artifactDir, "worker-events.jsonl"));
    expect(parent.witnessSequence).toBeLessThan(completion.winner.witnessSequence);
  });

  test("foreign, proxied and copied values cannot resolve or match authority", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, prepareRequest(f, factory.runner));
    const runId = await requiredRunId(backend);
    await backend.execute(runId);
    const completion = requireCompletion(backend);

    let accesses = 0;
    const hostile = new Proxy({}, {
      get() {
        accesses += 1;
        throw new Error("property access must not occur");
      },
      getPrototypeOf() {
        accesses += 1;
        throw new Error("prototype access must not occur");
      },
      ownKeys() {
        accesses += 1;
        throw new Error("key access must not occur");
      },
    });
    const proxiedBackend = new Proxy(backend, {
      get() {
        accesses += 1;
        throw new Error("property access must not occur");
      },
      getPrototypeOf() {
        accesses += 1;
        throw new Error("prototype access must not occur");
      },
      ownKeys() {
        accesses += 1;
        throw new Error("key access must not occur");
      },
    });

    expect(readNativeHarnessBackendCompletion(proxiedBackend).ok).toBe(false);
    expect(readNativeHarnessBackendCompletion(hostile).ok).toBe(false);
    expect(readNativeHarnessBackendCompletion({ ...backend }).ok).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(proxiedBackend, completion)).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, hostile)).toBe(false);
    expect(matchesNativeHarnessBackendCompletion(backend, { ...completion })).toBe(false);
    expect(accesses).toBe(0);
  });
});

describe("R2-A2b2c durable backend source and initial origin wiring", () => {
  test("legacy preparation writes no recovery source, result field or record origin", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend, result } = await prepareBackend(factory, f, prepareRequest(f, det.runner));
    expect("accountingPrepared" in result).toBe(false);
    const preparedRoot = await preparedRootOf(factory);
    expect(await exists(path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE))).toBe(false);
    const runId = await requiredRunId(backend);
    const record = await readRecord(factory.inspect().at(-1)!.storeRoot!, runId);
    expect(record.recoveryOrigin).toBeUndefined();
  });

  test("malformed or mismatched durable accounting rejects without legacy fallback", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const base = durableRequest(f, det.runner);
    const missing = { ...base, accounting: undefined } as unknown as NativeHarnessPrepareRequest;
    const missingResult = await factory.prepare(missing, contextFor(f));
    expect(missingResult.ok).toBe(false);
    expect(factory.inspect().length).toBe(0);
    const mismatched = {
      ...base,
      accounting: { ...base.accounting!, sourceAssociationSha256: "0".repeat(64) },
    } as NativeHarnessPrepareRequest;
    const mismatchedResult = await factory.prepare(mismatched, contextFor(f));
    expect(mismatchedResult.ok).toBe(false);
    if (!mismatchedResult.ok) expect(mismatchedResult.reason).toContain("sourceAssociationSha256");
    expect(factory.inspect().length).toBe(0);
  });

  test("durable prepare writes exact source and binds the initial origin through completion", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const admittedAt = Date.now() - 1_000;
    const request = durableRequest(f, det.runner, { admittedAt, maxDurationMs: 120_000 });
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => admittedAt + 1_000,
    });
    const { backend, result } = await prepareBackend(factory, f, request);
    if (!result.ok || result.accountingPrepared === undefined) {
      throw new Error("durable prepare returned no accountingPrepared facts");
    }
    const preparedRoot = await preparedRootOf(factory);
    const raw = await readFile(path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE), "utf8");
    const document = JSON.parse(raw) as Record<string, any>;
    expect(createHash("sha256").update(raw).digest("hex")).toBe(result.accountingPrepared.sourceDescriptorSha256);
    expect(document.accounting.reserveRevision).toBe(1);
    expect(document.budget.deadlineAt).toBe(request.budget.deadlineAt);
    expect(document.budget.maxDurationMs).toBe(120_000);
    expect(document.inputManifestSha256).toBe(result.accountingPrepared.inputManifestSha256);
    const diagnostic = factory.inspect().at(-1)!;
    expect(result.accountingPrepared.inputManifestSha256).toBe(diagnostic.inputManifestSha256!);

    const runId = await requiredRunId(backend, "durable bounded task");
    const record = await readRecord(diagnostic.storeRoot!, runId);
    expect(record.task).toBe("durable bounded task");
    expect(record.recoveryOrigin.runId).toBe(runId);
    expect(record.recoveryOrigin.createdAt).toBe(record.createdAt);
    expect(record.recoveryOrigin.seed).toMatchObject({
      accountingOwnerId: DURABLE_OWNER_ID,
      admissionId: DURABLE_ADMISSION_ID,
      accountingOwnerRevision: 1,
      sourceAssociationSha256: request.accounting!.sourceAssociationSha256,
      sourceDescriptorSha256: result.accountingPrepared.sourceDescriptorSha256,
      inputManifestSha256: result.accountingPrepared.inputManifestSha256,
      admittedAt,
      deadlineAt: request.budget.deadlineAt,
      allocatedCostUsd: 1,
    });
    const executed = await backend.execute(runId) as { status?: unknown };
    // The deterministic Runner ignores the private bridge. Its dispatch stays
    // an intended/unacknowledged row and no accepted completion is issued.
    expect(executed.status).toBe("failed");
    expect(det.requests).toHaveLength(1);
    const inventory = JSON.parse(await readFile(
      path.join(diagnostic.storeRoot!, "runs", runId, "dispatch-inventory.json"),
      "utf8",
    )) as Record<string, any>;
    expect(inventory.dispatches).toHaveLength(1);
    expect(inventory.dispatches[0].state).toBe("intended");
    expect(inventory.dispatches[0].launch).toBeUndefined();
    expect(inventory.dispatches[0].process).toBeUndefined();
    expect(inventory.dispatches[0].prompt).toBeUndefined();
    expect(inventory.dispatches[0].cleanup).toBeUndefined();
    expect(inventory.dispatches[0].terminal).toBeUndefined();
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
  });

  test("durable create is one attempt across reentrant and post-success calls", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    let backend!: NativeHarnessBackend;
    let armed = false;
    let reentrant: Promise<void> | null = null;
    let reentrantError: unknown = null;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        if (armed && reentrant === null) {
          reentrant = backend.create("reentrant task").then(
            () => undefined,
            (error: unknown) => { reentrantError = error; },
          ) as Promise<void>;
        }
        return Date.now();
      },
    });
    const prepared = await prepareBackend(factory, f, durableRequest(f, det.runner));
    backend = prepared.backend;
    armed = true;
    const runId = await requiredRunId(backend);
    await reentrant!;
    expect(reentrantError).toBeInstanceOf(Error);
    await expect(backend.create("second task")).rejects.toThrow(/already attempted/);
    const storeRoot = factory.inspect().at(-1)!.storeRoot!;
    expect(await readdir(path.join(storeRoot, "runs"))).toEqual([runId]);
  });

  test("changed source bytes block create and every worker dispatch", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    const preparedRoot = await preparedRootOf(factory);
    const sourcePath = path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
    await writeFile(sourcePath, `${await readFile(sourcePath, "utf8")} `, { mode: 0o600 });
    await expect(backend.create("bounded task")).rejects.toThrow();
    expect(await exists(path.join(factory.inspect().at(-1)!.storeRoot!, "runs"))).toBe(false);

    const second = await fixture();
    const secondDet = deterministicRunner();
    const secondFactory = createNativeHarnessBackend(second.host, { deterministicRunner: secondDet.runner });
    const secondPrepare = await prepareBackend(secondFactory, second, durableRequest(second, secondDet.runner));
    const runId = await requiredRunId(secondPrepare.backend);
    const secondRoot = await preparedRootOf(secondFactory);
    await writeFile(
      path.join(secondRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE),
      `${await readFile(path.join(secondRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE), "utf8")} `,
      { mode: 0o600 },
    );
    try {
      await secondPrepare.backend.execute(runId);
    } catch {
      // The Controller may settle the run as failed; dispatch is the assertion.
    }
    expect(secondDet.requests.length).toBe(0);
  });

  test("a different valid-shaped origin seed blocks the worker before the runner", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    const runId = await requiredRunId(backend);
    await withGetSpy((record) => {
      const clone = structuredClone(record);
      if (clone.recoveryOrigin !== undefined) clone.recoveryOrigin.seed.accountingOwnerRevision += 1;
      return clone;
    }, async () => {
      try {
        await backend.execute(runId);
      } catch {
        // The origin gate refuses dispatch; the Controller may settle failure.
      }
    });
    expect(det.requests.length).toBe(0);
    expect(await backend.get!(runId)).not.toBeNull();
  });

  test("retained request mutation after intent cannot change the owned forwarded payload", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    let retained: WorkerRequest | null = null;
    let retainedExtensions: WorkerRequest["generatedExtensions"] = undefined;
    let originalPrompt = "";
    let originalHarnessCanonical = "";
    let armed = false;
    let mutated = false;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      mutateWorkerRequest(request) {
        retained = request;
        request.generatedExtensions = [];
        retainedExtensions = request.generatedExtensions;
        originalPrompt = request.prompt;
        originalHarnessCanonical = JSON.stringify(request.harness);
      },
      now: () => {
        if (armed && !mutated && retained !== null) {
          mutated = true;
          retained.prompt = "mutated retained prompt";
          retainedExtensions!.push({} as never);
          try {
            (retained.harness as { promptAppend: string }).promptAppend = "mutated nested harness";
          } catch {
            // A frozen original harness is replaced below to model a changed
            // retained reference; the owned copy must not follow either.
          }
          retained.harness = Object.freeze({
            ...retained.harness,
            promptAppend: "replaced retained harness",
          });
        }
        return Date.now();
      },
      dispatchInventoryTestOptions: {
        testAfterPrimaryWrite(event) {
          if (event.revision >= 1) armed = true;
        },
      },
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    const runId = await requiredRunId(backend);
    try {
      await backend.execute(runId);
    } catch {
      // The deterministic Runner ignores the private bridge; dispatch remains
      // intended and the Controller may settle the run as failed.
    }
    expect(mutated).toBe(true);
    expect(retained).not.toBeNull();
    expect(retained!.prompt).toBe("mutated retained prompt");
    expect(retainedExtensions).toHaveLength(1);
    expect(det.requests).toHaveLength(1);
    expect(det.requests[0]!.prompt).toBe(originalPrompt);
    expect(JSON.stringify(det.requests[0]!.harness)).toBe(originalHarnessCanonical);
    expect(det.requests[0]!.harness).not.toBe(retained!.harness);
    expect(det.requests[0]!.generatedExtensions).toEqual([]);
    expect(det.requests[0]!.generatedExtensions).not.toBe(retainedExtensions);
    expect(Object.isFrozen(det.requests[0]!.generatedExtensions)).toBe(true);
    expect(Object.isFrozen(det.requests[0]!)).toBe(true);
  });

  test("post-copy original model, ompCommand and execution mutation cannot evade host checks", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const retained: { value: WorkerRequest | null } = { value: null };
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      mutateWorkerRequest(request) {
        retained.value = request;
      },
      beforeBaseInputCheck() {
        const request = retained.value;
        if (request === null) throw new Error("worker request was not retained");
        // These mutations happen after the owned copy and its first gate. They
        // must not change the payload that is actually checked or forwarded.
        request.model = "other/model";
        request.ompCommand = "/usr/bin/other-omp";
        request.execution = {
          kind: "omp-native",
          tools: ["read"],
          approvalMode: "yolo",
          approval: {},
          source: "test",
        };
      },
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    const runId = await requiredRunId(backend);
    try {
      await backend.execute(runId);
    } catch {
      // The deterministic Runner ignores the private bridge; the assertion is
      // the exact owned payload actually forwarded.
    }
    expect(det.requests).toHaveLength(1);
    expect(det.requests[0]!.model).toBe(f.host.model);
    expect(det.requests[0]!.ompCommand).toBe(f.host.ompCommand);
    expect(det.requests[0]!.execution).toBeUndefined();
    expect(retained.value!.model).toBe("other/model");
    expect(retained.value!.ompCommand).toBe("/usr/bin/other-omp");
    expect(retained.value!.execution).toBeDefined();
  });

  test("held cleanup write settles before close while new retained-port writes refuse", async () => {
    const f = await fixture();
    const writeHeld = deferred<void>();
    const releaseWrite = deferred<void>();
    let armed = false;
    let held = false;
    const fileIo = {
      ...nodeFileIo,
      async lstat(target: string, options: { bigint: true }) {
        const result = await nodeFileIo.lstat(target, options);
        if (armed && !held) {
          held = true;
          writeHeld.resolve(undefined);
          await releaseWrite.promise;
        }
        return result;
      },
    };
    let retainedBridge: {
      checkpoint(event: unknown, assertPersistable: () => void): Promise<void>;
    } | null = null;
    let retainedRunId = "";
    let retainedStage = "";
    let assertionCalls = 0;
    const runner: Runner = {
      async run(request: WorkerRequest): Promise<WorkerResult> {
        const bridge = (request as unknown as {
          nativeHarnessLifecycle?: { checkpoint(event: unknown, assert: () => void): Promise<void> };
        }).nativeHarnessLifecycle;
        if (bridge === undefined) throw new Error("private lifecycle bridge is missing");
        retainedBridge = bridge;
        retainedRunId = request.runId;
        retainedStage = request.stage;
        const cleanup = {
          type: "cleanupObserved",
          runId: request.runId,
          stage: request.stage,
          spawnAttempted: false,
          closeSeen: false,
          closeCode: null,
          closeSignal: null,
          groupObservation: "unknown",
          groupObservedAt: null,
          hostWorkSettled: true,
          approvalWorkSettled: true,
          logFlush: "success",
        };
        // Start, but do not await, the already-started cleanup operation. The
        // file-I/O seam holds it before the inventory write lock, so original
        // execution can end independently and closeRequested can latch.
        armed = true;
        void bridge.checkpoint(cleanup, () => {
          assertionCalls += 1;
        }).catch(() => undefined);
        await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
        const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
        await writeFile(eventsPath, "{}\n", { mode: 0o600 });
        return {
          text: "not a bounded plan response",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          eventsPath,
          status: "completed",
        };
      },
    };
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: runner,
      dispatchInventoryTestOptions: { fileIo },
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, runner));
    const runId = await requiredRunId(backend);
    const diagnostic = factory.inspect().at(-1)!;
    const inventoryPath = path.join(diagnostic.storeRoot!, "runs", runId, "dispatch-inventory.json");
    const execution = backend.execute(runId);
    void execution.catch(() => undefined);

    // Probe an unsupported event: before close it refuses on event type, and
    // after execution end the NEW-entry guard refuses before any storage call.
    const probe = () => ({ type: "unsupported", runId: retainedRunId, stage: retainedStage });
    let released = false;
    const releaseHeld = (): void => {
      if (released) return;
      released = true;
      releaseWrite.resolve(undefined);
    };
    try {
      // Do not outlive an early original settlement while waiting for the
      // held cleanup write; the finally below releases and observes it anyway.
      await settle(Promise.race([
        writeHeld.promise,
        execution.then(() => undefined, () => undefined),
      ]), 5000);
      const until = Date.now() + 2000;
      let closeObserved = false;
      while (Date.now() < until) {
        try {
          await retainedBridge!.checkpoint(probe(), () => undefined);
          throw new Error("unsupported event was unexpectedly accepted");
        } catch (error) {
          const message = (error as Error).message;
          if (message.includes("no longer this run's open handle")) {
            closeObserved = true;
            break;
          }
          if (!message.includes("event type is not supported")) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(closeObserved).toBe(true);
      // A valid-looking new terminal entry must also refuse while the already
      // started cleanup write is still held.
      await expect((async () => retainedBridge!.checkpoint({
        type: "resultObserved",
        runId: retainedRunId,
        stage: retainedStage,
        resultSha256: "0".repeat(64),
        status: "completed",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(1).toISOString(),
        usageEstimated: false,
      }, () => undefined))()).rejects.toThrow(/no longer this run's open handle/);
      const beforeRelease = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
      expect(beforeRelease.dispatches[0].state).toBe("intended");
      expect(beforeRelease.dispatches[0].cleanup).toBeUndefined();
    } finally {
      // Always drop the held original operation and observe its real promise
      // before the test ends, even if an assertion above failed.
      releaseHeld();
      await settle(execution, 5000).catch(() => undefined);
    }
    expect(assertionCalls).toBeGreaterThanOrEqual(1);
    const afterRelease = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
    expect(afterRelease.dispatches[0].cleanup).toBeDefined();
    await expect((async () => retainedBridge!.checkpoint(probe(), () => undefined))())
      .rejects.toThrow(/no longer this run's open handle/);
    const afterRefusal = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
    expect(afterRefusal.revision).toBe(afterRelease.revision);
  });

  test("durable worker allocation and artifact path mismatch refuse zero worker calls", async () => {
    const mutations: ReadonlyArray<{
      readonly name: string;
      readonly mutate: (request: WorkerRequest) => void;
    }> = [
      {
        name: "allocation",
        mutate(request) {
          request.maxCostUsd = 0.5;
        },
      },
      {
        name: "artifact path",
        mutate(request) {
          request.artifactDir = path.join(path.dirname(request.artifactDir), "other-artifacts");
        },
      },
    ];
    for (const item of mutations) {
      const f = await fixture();
      const det = deterministicRunner();
      let mutate: ((request: WorkerRequest) => void) | null = null;
      const factory = createNativeHarnessBackend(f.host, {
        deterministicRunner: det.runner,
        mutateWorkerRequest(request) {
          mutate?.(request);
        },
      });
      const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
      const runId = await requiredRunId(backend);
      mutate = item.mutate;
      try {
        await backend.execute(runId);
      } catch {
        // The durable stage/path binding refuses before underlying dispatch.
      }
      expect(det.requests, item.name).toHaveLength(0);
      expect(await backend.get!(runId), item.name).not.toBeNull();
    }
  });

  test("dispatch inventory creation failure keeps the known run id, get and cancel usable", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    const diagnostic = factory.inspect().at(-1)!;
    let runId = "";
    await withCreateSpy(async (record) => {
      await mkdir(path.join(diagnostic.storeRoot!, "runs", record.id, "dispatch-inventory.json"), {
        recursive: true,
        mode: 0o700,
      });
      return record;
    }, async () => {
      runId = await requiredRunId(backend);
    });
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(backend.execute(runId)).rejects.toThrow(/inventory creation failed/);
    expect(det.requests).toHaveLength(0);
    expect(await backend.get!(runId)).not.toBeNull();
    const cancelled = await backend.cancel(runId) as { readonly requested?: unknown };
    expect(cancelled.requested).toBe(true);
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
  });

  test("abort immediately after fulfilled create keeps the known ID and blocks execute", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const abort = new AbortController();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner, { signal: abort.signal }));
    let runId = "";
    await withCreateSpy((record) => {
      abort.abort();
      return record;
    }, async () => {
      runId = await requiredRunId(backend);
    });
    expect(typeof runId).toBe("string");
    expect(await backend.get!(runId)).not.toBeNull();
    await expect(backend.execute(runId)).rejects.toThrow(/aborted/);
    expect(det.requests.length).toBe(0);
    const cancelled = await backend.cancel(runId) as { requested?: unknown };
    expect(cancelled.requested).toBe(true);
  });

  test("origin mismatch after fulfilled create keeps the ID, refuses execution and stays sticky", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    let runId = "";
    await withCreateSpy((record) => {
      const clone = structuredClone(record);
      if (clone.recoveryOrigin !== undefined) clone.recoveryOrigin.seed.admissionId = "33333333-3333-4333-8333-333333333333";
      return clone;
    }, async () => {
      runId = await requiredRunId(backend);
    });
    expect(await backend.get!(runId)).not.toBeNull();
    await expect(backend.execute(runId)).rejects.toThrow(/recovery origin/);
    expect(await backend.get!(runId)).not.toBeNull();
    await expect(backend.execute(runId)).rejects.toThrow(/recovery origin/);
    expect(det.requests.length).toBe(0);
    const cancelled = await backend.cancel(runId) as { requested?: unknown };
    expect(cancelled.requested).toBe(true);
  });

  test("a fulfilled create clone with a seed toJSON sentinel is refused without serialization", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    let sentinelCalls = 0;
    let runId = "";
    await withCreateSpy((record) => {
      const clone = structuredClone(record) as Record<string, any>;
      clone.recoveryOrigin.seed.accountingOwnerRevision = {
        toJSON() {
          sentinelCalls += 1;
          return 1;
        },
      };
      return clone;
    }, async () => {
      runId = await requiredRunId(backend);
    });
    expect(sentinelCalls).toBe(0);
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const diagnostic = factory.inspect().at(-1)!;
    expect(diagnostic.runId).toBe(runId);
    const stored = await readRecord(diagnostic.storeRoot!, runId);
    expect(stored.status).toBe("queued");
    expect(stored.recoveryOrigin.seed.accountingOwnerRevision).toBe(1);
    await expect(backend.execute(runId)).rejects.toThrow(/recovery origin/);
    await expect(backend.execute(runId)).rejects.toThrow(/recovery origin/);
    const observed = await backend.get!(runId) as { readonly status?: unknown } | null;
    expect(observed?.status).toBe("queued");
    const cancelled = await backend.cancel(runId) as { readonly requested?: unknown };
    expect(cancelled.requested).toBe(true);
    await expect(backend.create("second task")).rejects.toThrow(/already attempted/);
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(det.requests).toHaveLength(0);
  });

  test("unreadable initial created status keeps the known ID but refuses execution", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner));
    let statusGetterCalls = 0;
    let runId = "";
    await withCreateSpy((record) => {
      const clone = structuredClone(record) as Record<string, any>;
      Object.defineProperty(clone, "status", {
        enumerable: true,
        configurable: true,
        get() {
          statusGetterCalls += 1;
          throw new Error("status getter must not be invoked");
        },
      });
      return clone;
    }, async () => {
      runId = await requiredRunId(backend);
    });
    expect(statusGetterCalls).toBe(0);
    const diagnostic = factory.inspect().at(-1)!;
    expect(diagnostic.runId).toBe(runId);
    expect(diagnostic.backendStatus).toBe("unknown");
    const stored = await readRecord(diagnostic.storeRoot!, runId);
    expect(stored.status).toBe("queued");
    await expect(backend.execute(runId)).rejects.toThrow(/status/);
    await expect(backend.execute(runId)).rejects.toThrow(/status/);
    const observed = await backend.get!(runId) as { readonly status?: unknown } | null;
    expect(observed?.status).toBe("queued");
    const cancelled = await backend.cancel(runId) as { readonly requested?: unknown };
    expect(cancelled.requested).toBe(true);
    expect(readNativeHarnessBackendCompletion(backend).ok).toBe(false);
    expect(det.requests).toHaveLength(0);
  });

  test("a durable guard that returns a rejected Promise is observed and refused", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    let clockCalls = 0;
    let armed = false;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        clockCalls += 1;
        // The second backend clock read follows private workspace preparation
        // and precedes the first durable guard check.
        if (clockCalls === 2) armed = true;
        return Date.now();
      },
    });
    let guardCalls = 0;
    const guard = () => {
      guardCalls += 1;
      return armed
        ? Promise.reject(new Error("durable guard returned a Promise"))
        : undefined;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let result: NativeHarnessPrepareResult | null = null;
    try {
      result = await factory.prepare(durableRequest(f, det.runner, { guard }), contextFor(f));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(guardCalls).toBeGreaterThan(0);
    expect(result?.ok).toBe(false);
    if (result !== null && !result.ok) expect(result.reason).toMatch(/synchronous/);
    expect(unhandled).toHaveLength(0);
    const diagnostics = factory.inspect();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.retainedForInspection).toBe(true);
    expect(diagnostics[0]!.reason).toMatch(/synchronous/);
    expect(det.requests).toHaveLength(0);
  });

  test("a durable guard that returns a foreign thenable is refused without invoking it", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    let clockCalls = 0;
    let armed = false;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) armed = true;
        return Date.now();
      },
    });
    let guardCalls = 0;
    let foreignThenCalls = 0;
    const guard = () => {
      guardCalls += 1;
      if (armed) {
        return {
          then() {
            foreignThenCalls += 1;
            throw new Error("foreign then must not run");
          },
        };
      }
      return undefined;
    };
    const result = await factory.prepare(durableRequest(f, det.runner, { guard }), contextFor(f));
    expect(guardCalls).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/synchronous/);
    expect(foreignThenCalls).toBe(0);
    const diagnostics = factory.inspect();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.reason).toMatch(/synchronous/);
    expect(det.requests).toHaveLength(0);
  });

  test("an initial durable guard returning a rejected Promise is observed and refused before workspace", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    let guardCalls = 0;
    const guard = (): Promise<never> => {
      guardCalls += 1;
      return Promise.reject(new Error("initial durable guard returned a Promise"));
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const checked = await withControllerDispatchCounters(async () => {
        const prepared = await factory.prepare(durableRequest(f, det.runner, { guard }), contextFor(f));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return prepared;
      });
      expect(guardCalls).toBe(1);
      expect(checked.value.ok).toBe(false);
      if (!checked.value.ok) expect(checked.value.reason).toMatch(/synchronous/);
      expect(unhandled).toHaveLength(0);
      expect(checked.createCalls).toBe(0);
      expect(checked.executeCalls).toBe(0);
      expect(factory.inspect()).toHaveLength(0);
      expect(det.requests).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a workspace durable guard returning a foreign thenable after the initial void is refused without invoking it", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const factory = createNativeHarnessBackend(f.host, { deterministicRunner: det.runner });
    let guardCalls = 0;
    let foreignThenCalls = 0;
    const guard = () => {
      guardCalls += 1;
      if (guardCalls === 1) return undefined;
      return {
        then() {
          foreignThenCalls += 1;
          throw new Error("foreign then must not run");
        },
      };
    };
    const checked = await withControllerDispatchCounters(async () => {
      const prepared = await factory.prepare(durableRequest(f, det.runner, { guard }), contextFor(f));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return prepared;
    });
    expect(guardCalls).toBe(2);
    expect(checked.value.ok).toBe(false);
    if (!checked.value.ok) expect(checked.value.reason).toMatch(/preparation guard/);
    expect(foreignThenCalls).toBe(0);
    expect(checked.createCalls).toBe(0);
    expect(checked.executeCalls).toBe(0);
    expect(factory.inspect()).toHaveLength(0);
    expect(det.requests).toHaveLength(0);
  });

  test("a clock abort during the first source guard is observed before the next effect", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const abort = new AbortController();
    let clockCalls = 0;
    let guardCalls = 0;
    let guardCallsAtAbort = 0;
    const guard = (): void => {
      guardCalls += 1;
    };
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 3) {
          guardCallsAtAbort = guardCalls;
          abort.abort();
        }
        return Date.now();
      },
    });
    const result = await factory.prepare(durableRequest(f, det.runner, {
      signal: abort.signal,
      guard,
    }), contextFor(f));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(clockCalls).toBe(3);
    expect(guardCallsAtAbort).toBeGreaterThan(1);
    expect(guardCalls).toBe(guardCallsAtAbort);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aborted/);
    const diagnostics = factory.inspect();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.retainedForInspection).toBe(true);
    expect(det.requests).toHaveLength(0);
  });

  test("abort inside the execute clock callback is observed before Controller.execute", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const abort = new AbortController();
    let abortOnNow = false;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        if (abortOnNow) abort.abort();
        return Date.now();
      },
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner, { signal: abort.signal }));
    const runId = await requiredRunId(backend);
    let executeCalls = 0;
    const originalExecute = HarnessController.prototype.execute;
    const patchedExecute = async function (
      this: HarnessController,
      ...args: Parameters<HarnessController["execute"]>
    ): Promise<Awaited<ReturnType<HarnessController["execute"]>>> {
      executeCalls += 1;
      return originalExecute.apply(this, args);
    };
    HarnessController.prototype.execute = patchedExecute;
    try {
      abortOnNow = true;
      await expect(backend.execute(runId)).rejects.toThrow(/aborted/);
    } finally {
      HarnessController.prototype.execute = originalExecute;
    }
    expect(executeCalls).toBe(0);
    expect(det.requests.length).toBe(0);
  });

  test("abort inside the worker final-gate clock callback blocks underlying dispatch", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const abort = new AbortController();
    let abortOnNow = false;
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => {
        if (abortOnNow) {
          abortOnNow = false;
          abort.abort();
        }
        return Date.now();
      },
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner, { signal: abort.signal }));
    const runId = await requiredRunId(backend);
    let getCalls = 0;
    await withGetSpy((record) => {
      getCalls += 1;
      // The second backend get is the final record reread. Arm the next clock
      // callback, which is the fresh gate immediately before underlying.run.
      if (getCalls === 2) abortOnNow = true;
      return record;
    }, async () => {
      try {
        await backend.execute(runId);
      } catch {
        // The final gate refuses dispatch; Controller accounting may settle.
      }
    });
    expect(getCalls).toBeGreaterThanOrEqual(2);
    expect(det.requests.length).toBe(0);
  });

  test("closed prepare guard is not reused and source I/O consumes the original window", async () => {
    const f = await fixture();
    const det = deterministicRunner();
    const admittedAt = Date.now() - 1_000;
    let guardCalls = 0;
    let closed = false;
    const guard = (): void => {
      guardCalls += 1;
      if (closed) throw new Error("prepare guard is closed");
    };
    const clock = { now: admittedAt };
    const factory = createNativeHarnessBackend(f.host, {
      deterministicRunner: det.runner,
      now: () => clock.now,
    });
    const { backend } = await prepareBackend(factory, f, durableRequest(f, det.runner, {
      admittedAt,
      maxDurationMs: 120_000,
      guard,
    }));
    const callsAfterPrepare = guardCalls;
    expect(callsAfterPrepare).toBeGreaterThan(0);
    closed = true;
    clock.now = admittedAt + 100_000;
    const runId = await requiredRunId(backend);
    expect(guardCalls).toBe(callsAfterPrepare);
    const record = await readRecord(factory.inspect().at(-1)!.storeRoot!, runId);
    expect(record.config.maxDurationMs).toBeLessThanOrEqual(20_000);
    expect(record.config.stageTimeoutMs).toBeLessThanOrEqual(record.config.maxDurationMs);
    const executed = await backend.execute(runId) as { status?: unknown };
    // The run was created with a ~20s inner duration at a synthetic clock
    // already ~99s beyond its real createdAt. The durable dispatch gate must
    // refuse before the underlying Runner adds a dispatch.
    expect(executed.status).toBe("failed");
    expect(guardCalls).toBe(callsAfterPrepare);
    expect(det.requests).toHaveLength(0);
    clock.now = admittedAt + 120_000;
    await expect(backend.execute(runId)).rejects.toThrow(/deadline/);
    expect(det.requests).toHaveLength(0);
  });
});
