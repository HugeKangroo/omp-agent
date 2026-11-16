import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
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
  NATIVE_HARNESS_BACKEND_MAX_RETAINED,
  type NativeHarnessBackendHostConfig,
  type NativeHarnessBackendTestOptions,
} from "../../src/native-harness-backend.ts";
import {
  NATIVE_HARNESS_MAX_DURATION_MS,
  NATIVE_HARNESS_MAX_TASK_BYTES,
  type NativeHarnessBackend,
  type NativeHarnessPrepareRequest,
  type NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import type { NativeContext } from "../../src/native-entry.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

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
  readonly baselineStarted: Promise<WorkerRequest>;
}

function deterministicRunner(options: { blockBaseline?: boolean } = {}): DeterministicRunner {
  const requests: WorkerRequest[] = [];
  const started = deferred<WorkerRequest>();
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
        const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
        await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
        return {
          text: "",
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          eventsPath,
          status: "cancelled",
        };
      }
      await mkdir(request.artifactDir, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(request.artifactDir, "worker-events.jsonl");
      await writeFile(eventsPath, `${JSON.stringify({ type: "fixture", stage: request.stage })}\n`, { mode: 0o600 });
      let text = "stage completed";
      if (request.stage === "plan") {
        text = PLAN_RESPONSE;
      } else if (request.stage === "select") {
        text = SELECT_RESPONSE;
      } else if (request.stage === "baseline") {
        await writeFile(path.join(request.cwd, "candidate.txt"), "candidate\n", { mode: 0o600 });
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
  return { runner, requests, baselineStarted: started.promise };
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
