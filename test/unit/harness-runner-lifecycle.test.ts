import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OmpRpcRunner } from "../../vendor/harness2/index.ts";
import type {
  WorkerLifecycleCleanupObservedEvent,
  WorkerLifecycleEvent,
  WorkerLifecyclePort,
  WorkerRequest,
} from "../../vendor/harness2/upstream/src/types.ts";

const FIXTURE_SOURCE = path.resolve(import.meta.dir, "../fixtures/harness-lifecycle-worker.mjs");
const TEST_TIMEOUT = 15_000;
const roots: string[] = [];
const runtimeRoots = new Set<string>();
const ownedPids = new Set<number>();
const helperStartedMarkers = new Set<string>();
let fixtureCleanupFailure: string | undefined;

function assertFixtureSetupAllowed(): void {
  if (fixtureCleanupFailure !== undefined) {
    throw new Error(`Fixture cleanup is latched after an unconfirmed owned-resource cleanup; refusing new roots/helpers. ${fixtureCleanupFailure}`);
  }
}

type LifecycleHook = (
  event: WorkerLifecycleEvent,
  assertPersistable: () => void,
  lifecycle: TestLifecycle,
) => void | Promise<void>;

interface TestLifecycle extends WorkerLifecyclePort {
  events: WorkerLifecycleEvent[];
  hooks: Partial<Record<WorkerLifecycleEvent["type"], LifecycleHook>>;
  current: boolean;
  currentCalls: number;
  active: boolean;
  overlap: boolean;
}

interface LifecycleOptions {
  cleanupGraceMs?: number;
  current?: boolean;
  hooks?: Partial<Record<WorkerLifecycleEvent["type"], LifecycleHook>>;
}

function makeLifecycle(options: LifecycleOptions = {}): TestLifecycle {
  const lifecycle: TestLifecycle = {
    cleanupGraceMs: options.cleanupGraceMs ?? 4000,
    current: options.current ?? true,
    currentCalls: 0,
    events: [],
    hooks: options.hooks ?? {},
    active: false,
    overlap: false,
    assertAdvanceCurrent(): void {
      lifecycle.currentCalls += 1;
      if (!lifecycle.current) throw new Error("lifecycle authority is stale");
    },
    async checkpoint(event: WorkerLifecycleEvent, assertPersistable: () => void): Promise<void> {
      if (event.type === "preLaunch") runtimeRoots.add(event.runtimeRoot);
      if (event.type === "processBound" && event.pid !== null) ownedPids.add(event.pid);
      if (lifecycle.active) lifecycle.overlap = true;
      lifecycle.active = true;
      lifecycle.events.push(event);
      try {
        const hook = lifecycle.hooks[event.type];
        if (hook) await hook(event, assertPersistable, lifecycle);
      } finally {
        lifecycle.active = false;
      }
    },
  };
  return lifecycle;
}

async function makeRunRoot(): Promise<string> {
  assertFixtureSetupAllowed();
  const root = await mkdtemp(path.join(tmpdir(), "omp-runner-lifecycle-test-"));
  roots.push(root);
  return root;
}

function helperCommand(root: string, mode: string): string {
  assertFixtureSetupAllowed();
  const target = path.join(root, `harness-lifecycle-worker-${mode}.mjs`);
  writeFileSync(target, readFileSync(FIXTURE_SOURCE), { mode: 0o700 });
  chmodSync(target, 0o700);
  helperStartedMarkers.add(`${target}.started`);
  return target;
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    OPENAI_API_KEY: "lifecycle-fixture-not-a-real-key",
    TMPDIR: tmpdir(),
  };
}

function makeRequest(root: string, helper: string, overrides: Partial<WorkerRequest> = {}): WorkerRequest {
  const cwd = path.join(root, "source");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, "note.txt"), "fixture\n", { mode: 0o600 });
  return {
    runId: "run-lifecycle-fixture",
    stage: "baseline",
    role: "solver",
    cwd,
    artifactDir: path.join(root, "artifact"),
    prompt: "Lifecycle prompt @absolute and ^caret stay data.",
    harness: { schemaVersion: 1, id: "lifecycle", promptAppend: "appendix", toolGuidance: "tools", skills: [], rationale: "fixture" },
    model: "openai/lifecycle-fixture",
    maxCostUsd: 0.01,
    timeoutMs: 5000,
    ompCommand: helper,
    ...overrides,
  };
}

function eventOfType<T extends WorkerLifecycleEvent["type"]>(
  lifecycle: TestLifecycle,
  type: T,
): Extract<WorkerLifecycleEvent, { type: T }> | undefined {
  return lifecycle.events.find((event): event is Extract<WorkerLifecycleEvent, { type: T }> => event.type === type);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function resultDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error("bounded test condition was not reached");
    await sleep(10);
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupGone(pid: number, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (groupExists(pid)) {
    if (Date.now() >= until) throw new Error(`owned helper process group ${pid} did not reach ESRCH within ${timeoutMs}ms`);
    await sleep(10);
  }
}

function retainedOwnedPaths(): string[] {
  return [...new Set([...runtimeRoots, ...roots, ...helperStartedMarkers])].filter((value) => existsSync(value));
}

afterEach(async () => {
  const cleanupFailures: string[] = [];
  const pids = new Set<number>(ownedPids);
  for (const marker of helperStartedMarkers) {
    if (!existsSync(marker)) continue;
    const pidText = readFileSync(marker, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) {
      cleanupFailures.push(`helper PID marker ${marker} does not contain a positive decimal PID`);
      continue;
    }
    pids.add(Number(pidText));
  }
  for (const pid of pids) {
    if (groupExists(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") cleanupFailures.push(`SIGKILL for owned group ${pid} failed: ${code ?? String(error)}`);
      }
    }
    try {
      await waitForGroupGone(pid);
    } catch (error) {
      cleanupFailures.push((error as Error).message);
    }
  }
  if (cleanupFailures.length > 0) {
    const diagnostic = `Owned helper cleanup was not confirmed for process group(s) ${[...pids].join(", ") || "(none)"}; `
      + `retained ${retainedOwnedPaths().length} exact recovery path(s): ${retainedOwnedPaths().join(", ")}: ${cleanupFailures.join("; ")}`;
    fixtureCleanupFailure ??= diagnostic;
    throw new Error(diagnostic);
  }
  ownedPids.clear();
  if (fixtureCleanupFailure !== undefined) {
    const retained = retainedOwnedPaths();
    throw new Error(`Fixture cleanup remains latched after an earlier unconfirmed owned-resource cleanup; `
      + `retained ${retained.length} exact recovery path(s): ${retained.join(", ")}. ${fixtureCleanupFailure}`);
  }
  const pathFailures: string[] = [];
  const remainingRuntime = new Set<string>();
  for (const root of runtimeRoots) {
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) {
      remainingRuntime.add(root);
      pathFailures.push(`${root}: ${(error as Error).message}`);
    }
  }
  runtimeRoots.clear();
  for (const root of remainingRuntime) runtimeRoots.add(root);
  if (pathFailures.length > 0) {
    const diagnostic = `Owned runtime cleanup was not confirmed; retained ${retainedOwnedPaths().length} exact recovery path(s): `
      + `${retainedOwnedPaths().join(", ")}: ${pathFailures.join("; ")}`;
    fixtureCleanupFailure ??= diagnostic;
    throw new Error(diagnostic);
  }
  const remainingRoots: string[] = [];
  for (const root of roots) {
    try { await rm(root, { recursive: true, force: true }); }
    catch (error) {
      remainingRoots.push(root);
      pathFailures.push(`${root}: ${(error as Error).message}`);
    }
  }
  roots.length = 0;
  roots.push(...remainingRoots);
  if (pathFailures.length > 0) {
    const diagnostic = `Owned run-root cleanup was not confirmed; retained ${retainedOwnedPaths().length} exact recovery path(s): `
      + `${retainedOwnedPaths().join(", ")}: ${pathFailures.join("; ")}`;
    fixtureCleanupFailure ??= diagnostic;
    throw new Error(diagnostic);
  }
  runtimeRoots.clear();
  helperStartedMarkers.clear();
  roots.length = 0;
});

describe("R2-B1b1 original Runner lifecycle", () => {
  test("no-sink path keeps legacy completion behavior", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const request = makeRequest(root, helper);
    const result = await new OmpRpcRunner({ env: runnerEnvironment() }).run(request);

    expect(result.status).toBe("completed");
    expect(result.text).toBe("lifecycle fixture result");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(result.usageEstimated).toBeUndefined();
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(false);
    expect(readFileSync(result.eventsPath, "utf8")).toContain('"type":"prompt_result"');
  }, TEST_TIMEOUT);

  test("preLaunch refusal never spawns and rejects", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({ hooks: { preLaunch: () => { throw new Error("prelaunch refused"); } } });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("prelaunch refused");
    expect(lifecycle.events.map((event) => event.type)).toEqual(["preLaunch"]);
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(launched).toBeDefined();
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(`${helper}.started`)).toBe(false);
    expect(existsSync(`${helper}.prompt`)).toBe(false);
  }, TEST_TIMEOUT);

  test("held preLaunch checkpoint past the cleanup deadline never spawns or late-acknowledges", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = makeLifecycle({
      cleanupGraceMs: 150,
      hooks: { preLaunch: async () => { await gate; } },
    });
    const request = makeRequest(root, helper, { lifecycle, timeoutMs: 70 });
    const running = new OmpRpcRunner({ env: runnerEnvironment() }).run(request);

    await waitFor(() => lifecycle.events.some((event) => event.type === "preLaunch"));
    await expect(running).rejects.toThrow(/did not settle/);
    release();
    await sleep(60);
    expect(lifecycle.events.map((event) => event.type)).toEqual(["preLaunch"]);
    expect(existsSync(`${helper}.started`)).toBe(false);
  }, TEST_TIMEOUT);

  test("late preLaunch acknowledgement within budget yields timed_out without spawn", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({
      cleanupGraceMs: 800,
      hooks: { preLaunch: async () => { await sleep(180); } },
    });
    const request = makeRequest(root, helper, { lifecycle, timeoutMs: 70 });
    const result = await new OmpRpcRunner({ env: runnerEnvironment() }).run(request);

    expect(result.status).toBe("timed_out");
    const cleanup = eventOfType(lifecycle, "cleanupObserved");
    expect(cleanup).toBeDefined();
    expect(cleanup!.spawnAttempted).toBe(false);
    expect(cleanup!.closeSeen).toBe(false);
    expect(cleanup!.groupObservation).toBe("unknown");
    expect(cleanup!.groupObservedAt).toBeNull();
    expect(cleanup!.hostWorkSettled).toBe(true);
    expect(cleanup!.approvalWorkSettled).toBe(true);
    expect(cleanup!.logFlush).toBe("success");
    const observed = eventOfType(lifecycle, "resultObserved");
    expect(observed).toBeDefined();
    expect(observed!.status).toBe("timed_out");
    expect(observed!.resultSha256).toBe(resultDigest(result));
    expect(existsSync(`${helper}.started`)).toBe(false);
    expect(existsSync(`${helper}.prompt`)).toBe(false);
  }, TEST_TIMEOUT);

  test("processBound refusal blocks prompt, cleans the owned group and retains evidence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({ hooks: { processBound: () => { throw new Error("process boundary refused"); } } });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("process boundary refused");
    const bound = eventOfType(lifecycle, "processBound");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(bound).toBeDefined();
    expect(bound!.pid).toBeNumber();
    expect(launched).toBeDefined();
    expect(existsSync(`${helper}.prompt`)).toBe(false);
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved" || event.type === "resultObserved")).toBe(false);
    await waitFor(() => !groupExists(bound!.pid!));
  }, TEST_TIMEOUT);

  test("prePrompt refusal blocks send, cleans the owned group and retains evidence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({ hooks: { prePrompt: () => { throw new Error("preprompt refused"); } } });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("preprompt refused");
    const bound = eventOfType(lifecycle, "processBound");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(bound).toBeDefined();
    expect(existsSync(`${helper}.prompt`)).toBe(false);
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved" || event.type === "resultObserved")).toBe(false);
    await waitFor(() => !groupExists(bound!.pid!));
  }, TEST_TIMEOUT);

  test("prePrompt currentness loss refuses prompt and retains evidence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({
      hooks: {
        prePrompt: (_event, _guard, state) => { (state as { current: boolean }).current = false; },
      },
    });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("lifecycle authority is stale");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(existsSync(`${helper}.prompt`)).toBe(false);
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved" || event.type === "resultObserved")).toBe(false);
  }, TEST_TIMEOUT);

  test("successful lifecycle observes exact prompt bytes, cleanup facts and final digest", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const ownerPath = path.join(root, "artifact", "worker-owner.json");
    const eventsPath = path.join(root, "artifact", "worker-events.jsonl");
    let promptObservedSha = "";
    let promptObservedBytes = 0;
    let ownerPresentAtReceipt = false;
    let runtimePresentAtReceipt = false;
    let guardAllowed = false;
    let retainedGuard: (() => void) | undefined;
    let logFramesAtReceipt = "";
    const lifecycle = makeLifecycle({
      hooks: {
        cleanupObserved: (event, assertPersistable) => {
          retainedGuard = assertPersistable;
          assertPersistable();
          guardAllowed = true;
          const promptBytes = readFileSync(`${helper}.prompt`);
          promptObservedSha = sha256(promptBytes);
          promptObservedBytes = promptBytes.byteLength;
          const launched = eventOfType(lifecycle, "preLaunch");
          ownerPresentAtReceipt = existsSync(ownerPath);
          runtimePresentAtReceipt = launched !== undefined && existsSync(launched.runtimeRoot);
          logFramesAtReceipt = readFileSync(eventsPath, "utf8");
        },
      },
    });
    const request = makeRequest(root, helper, { lifecycle });
    const result = await new OmpRpcRunner({ env: runnerEnvironment() }).run(request);
    const exactDigest = resultDigest(result);

    const prompt = eventOfType(lifecycle, "prePrompt");
    const cleanup = eventOfType(lifecycle, "cleanupObserved");
    const observed = eventOfType(lifecycle, "resultObserved");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(result.status).toBe("completed");
    expect(prompt).toBeDefined();
    expect(promptObservedSha).toBe(prompt!.promptSha256);
    expect(promptObservedBytes).toBe(prompt!.promptBytes);
    expect(prompt!.promptBytes).toBe(readFileSync(`${helper}.prompt`).byteLength);
    expect(prompt!.timeoutMs).toBe(request.timeoutMs);
    expect(readFileSync(`${helper}.prompt`, "utf8")).toContain("\\u0040");
    expect(readFileSync(`${helper}.prompt`, "utf8")).toContain("\\u005e");
    expect(ownerPresentAtReceipt).toBe(true);
    expect(runtimePresentAtReceipt).toBe(true);
    expect(logFramesAtReceipt).toContain('"type":"prompt_result"');
    expect(guardAllowed).toBe(true);
    expect(existsSync(ownerPath)).toBe(false);
    expect(existsSync(launched!.runtimeRoot)).toBe(false);
    expect(cleanup).toBeDefined();
    expect(Object.isFrozen(cleanup!)).toBe(true);
    expect(cleanup!.runId).toBe(request.runId);
    expect(cleanup!.stage).toBe(request.stage);
    expect(cleanup!.spawnAttempted).toBe(true);
    expect(cleanup!.closeSeen).toBe(true);
    expect(cleanup!.closeCode).toBe(0);
    expect(cleanup!.closeSignal).toBeNull();
    expect(cleanup!.groupObservation).toBe("not-observed");
    expect(cleanup!.groupObservedAt).toBeString();
    expect(cleanup!.hostWorkSettled).toBe(true);
    expect(cleanup!.approvalWorkSettled).toBe(true);
    expect(cleanup!.logFlush).toBe("success");
    expect(() => retainedGuard!()).toThrow(/no longer permitted/);
    expect(observed).toBeDefined();
    expect(observed!.resultSha256).toBe(exactDigest);
    expect(observed!.status).toBe("completed");
    expect(observed!.usage).toEqual(result.usage);
    expect(Object.isFrozen(observed!.usage)).toBe(true);
    expect(observed!.usage).not.toBe(result.usage);
    expect(observed!.startedAt).toBe(result.startedAt);
    expect(observed!.endedAt).toBe(result.endedAt);
    expect(observed!.usageEstimated).toBe(false);
    expect(lifecycle.events.map((event) => event.type)).toEqual([
      "preLaunch", "processBound", "prePrompt", "cleanupObserved", "resultObserved",
    ]);
    const usageCopy = observed!.usage;
    result.usage.costUsd = 99;
    expect(usageCopy.costUsd).toBe(0);
  }, TEST_TIMEOUT);

  test("delayed approval work drains before the cleanup receipt and return", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "approval-delay");
    let releaseApproval!: () => void;
    let approvalStarted = false;
    let approvalFinished = false;
    let approvalFinishedAtReceipt = false;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const lifecycle = makeLifecycle({
      hooks: {
        cleanupObserved: (_event, assertPersistable) => {
          assertPersistable();
          approvalFinishedAtReceipt = approvalFinished;
        },
      },
    });
    const request = makeRequest(root, helper, {
      lifecycle,
      approval: async () => {
        approvalStarted = true;
        await approvalGate;
        approvalFinished = true;
        return true;
      },
    });
    const running = new OmpRpcRunner({ env: runnerEnvironment() }).run(request);
    await waitFor(() => approvalStarted);
    await sleep(80);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved")).toBe(false);
    releaseApproval();
    const result = await running;

    const cleanup = eventOfType(lifecycle, "cleanupObserved");
    expect(result.status).toBe("completed");
    expect(cleanup).toBeDefined();
    expect(cleanup!.hostWorkSettled).toBe(true);
    expect(cleanup!.approvalWorkSettled).toBe(true);
    expect(approvalFinishedAtReceipt).toBe(true);
    expect(approvalFinished).toBe(true);
  }, TEST_TIMEOUT);

  test("cleanup receipt refusal retains runtime and ownership evidence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({ hooks: { cleanupObserved: () => { throw new Error("receipt refused"); } } });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("receipt refused");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(launched).toBeDefined();
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
    expect(existsSync(`${helper}.prompt`)).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(false);
  }, TEST_TIMEOUT);

  test("owner deletion failure is reflected in the exact final result and digest", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const ownerPath = path.join(root, "artifact", "worker-owner.json");
    let runtimeRoot = "";
    const lifecycle = makeLifecycle({
      hooks: {
        prePrompt: () => {
          unlinkSync(ownerPath);
          mkdirSync(ownerPath);
          writeFileSync(path.join(ownerPath, "held.txt"), "held\n", { mode: 0o600 });
        },
        cleanupObserved: (event, assertPersistable) => {
          assertPersistable();
          const launched = eventOfType(lifecycle, "preLaunch");
          runtimeRoot = launched!.runtimeRoot;
        },
      },
    });
    const request = makeRequest(root, helper, { lifecycle });
    let delayedObservations = 0;
    const result = await new OmpRpcRunner({
      env: runnerEnvironment(),
      holdLifecycleRemovalObservationForTests: async () => { delayedObservations += 1; },
    }).run(request);

    expect(result.status).toBe("failed");
    expect(delayedObservations).toBe(2);
    expect(result.error).toContain("ownership record");
    expect(result.usageEstimated).toBeUndefined();
    expect(existsSync(runtimeRoot)).toBe(false);
    expect(existsSync(ownerPath)).toBe(true);
    const observed = eventOfType(lifecycle, "resultObserved");
    expect(observed).toBeDefined();
    expect(observed!.status).toBe("failed");
    expect(observed!.resultSha256).toBe(resultDigest(result));
  }, TEST_TIMEOUT);

  test("held optional runtime removal past the cleanup deadline rejects without later effects", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let removalStarted = false;
    let observations = 0;
    let releaseObservedRemoval!: () => void;
    const observedRemovalGate = new Promise<void>((resolve) => { releaseObservedRemoval = resolve; });
    let rawOutcome: "pending" | "fulfilled" | "rejected" = "pending";
    let rawFailure: unknown;
    const lifecycle = makeLifecycle({ cleanupGraceMs: 500 });
    const runner = new OmpRpcRunner({
      env: runnerEnvironment(),
      holdLifecycleRemovalObservationForTests: (removal) => {
        observations += 1;
        removalStarted = true;
        const raw = removal.then(
          () => { rawOutcome = "fulfilled"; },
          (failure) => { rawOutcome = "rejected"; rawFailure = failure; throw failure; },
        );
        return observedRemovalGate.then(() => raw);
      },
    });
    const request = makeRequest(root, helper, { lifecycle });
    const ownerPath = path.join(request.artifactDir, "worker-owner.json");
    const running = runner.run(request);

    await waitFor(() => removalStarted);
    const cleanup = eventOfType(lifecycle, "cleanupObserved");
    expect(cleanup).toBeDefined();
    expect(cleanup!.spawnAttempted).toBe(true);
    await expect(running).rejects.toThrow(/removal observation settled/);

    expect(observations).toBe(1);
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(false);
    expect(existsSync(ownerPath)).toBe(true);
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(launched).toBeDefined();
    // The original runtime rm may already have completed while its observation was held.
    releaseObservedRemoval();
    await waitFor(() => rawOutcome !== "pending");
    expect(String(rawOutcome)).toBe("fulfilled");
    expect(rawFailure).toBeUndefined();
    await waitFor(() => !existsSync(launched!.runtimeRoot));
    await sleep(40);
    expect(observations).toBe(1);
    expect(existsSync(ownerPath)).toBe(true);
    expect(lifecycle.events.map((event) => event.type)).toEqual([
      "preLaunch", "processBound", "prePrompt", "cleanupObserved",
    ]);
  }, TEST_TIMEOUT);

  test("result observation refusal rejects without returning an alternate result", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const lifecycle = makeLifecycle({ hooks: { resultObserved: () => { throw new Error("terminal refused"); } } });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow("terminal refused");
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(true);
    expect(existsSync(`${helper}.prompt`)).toBe(true);
    expect(existsSync(launched!.runtimeRoot)).toBe(false);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(false);
  }, TEST_TIMEOUT);

  test("a pending prePrompt checkpoint revokes its guard and precedes cleanup persistence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let release!: () => void;
    let pendingResolved = false;
    let cleanupAfterPending = false;
    let guardRefused = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = makeLifecycle({
      cleanupGraceMs: 2000,
      hooks: {
        prePrompt: async (_event, assertPersistable) => {
          await gate;
          pendingResolved = true;
          try { assertPersistable(); } catch { guardRefused = true; }
        },
        cleanupObserved: () => { cleanupAfterPending = pendingResolved; },
      },
    });
    const request = makeRequest(root, helper, { lifecycle, timeoutMs: 5000 });
    const controller = new AbortController();
    const running = new OmpRpcRunner({ env: runnerEnvironment() }).run({ ...request, signal: controller.signal });
    await waitFor(() => lifecycle.events.some((event) => event.type === "prePrompt"));
    controller.abort();
    await sleep(80);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved")).toBe(false);
    release();
    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(cleanupAfterPending).toBe(true);
    expect(guardRefused).toBe(true);
    expect(lifecycle.overlap).toBe(false);
    expect(existsSync(`${helper}.prompt`)).toBe(false);
  }, TEST_TIMEOUT);

  test("one cleanup budget is shared across shutdown, approval drain and log drain", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "approval-delay");
    let releaseApproval!: () => void;
    let approvalStartedAt = 0;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const lifecycle = makeLifecycle({ cleanupGraceMs: 200 });
    const request = makeRequest(root, helper, {
      lifecycle,
      approval: async () => {
        approvalStartedAt = Date.now();
        await approvalGate;
        return true;
      },
    });
    const running = new OmpRpcRunner({ env: runnerEnvironment() }).run(request);
    await waitFor(() => approvalStartedAt > 0);
    await expect(running).rejects.toThrow(/log flush|cleanup deadline|did not settle/);
    const elapsed = Date.now() - approvalStartedAt;
    releaseApproval();

    expect(elapsed).toBeLessThan(900);
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved" || event.type === "resultObserved")).toBe(false);
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
  }, TEST_TIMEOUT);

  test("async or foreign currentness returns are refused without spawn or then access", async () => {
    const nativeRoot = await makeRunRoot();
    const nativeHelper = helperCommand(nativeRoot, "normal");
    const nativeLifecycle = makeLifecycle();
    nativeLifecycle.assertAdvanceCurrent = (() => Promise.reject(new Error("rejected async guard"))) as () => void;
    const nativeRequest = makeRequest(nativeRoot, nativeHelper, { lifecycle: nativeLifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(nativeRequest))
      .rejects.toThrow(/must not return a Promise/);
    expect(existsSync(`${nativeHelper}.started`)).toBe(false);
    expect(nativeLifecycle.events.map((event) => event.type)).toEqual(["preLaunch"]);

    const foreignRoot = await makeRunRoot();
    const foreignHelper = helperCommand(foreignRoot, "normal");
    let thenReads = 0;
    const thenable = Object.defineProperty({}, "then", {
      get() {
        thenReads += 1;
        return () => { throw new Error("foreign then must not be invoked"); };
      },
    });
    const foreignLifecycle = makeLifecycle();
    foreignLifecycle.assertAdvanceCurrent = (() => thenable) as () => void;
    const foreignRequest = makeRequest(foreignRoot, foreignHelper, { lifecycle: foreignLifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(foreignRequest))
      .rejects.toThrow(/must be synchronous and return void/);
    expect(thenReads).toBe(0);
    expect(existsSync(`${foreignHelper}.started`)).toBe(false);
  }, TEST_TIMEOUT);

  test("lifecycle accessors are refused without reading them and never spawn", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let accessorReads = 0;
    const port: Record<string, unknown> = {
      cleanupGraceMs: 100,
      assertAdvanceCurrent: () => undefined,
      checkpoint: async () => undefined,
    };
    Object.defineProperty(port, "checkpoint", {
      get() {
        accessorReads += 1;
        throw new Error("accessor must not be read");
      },
    });
    const request = makeRequest(root, helper, { lifecycle: port as unknown as WorkerLifecyclePort });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow(/data property/);
    expect(accessorReads).toBe(0);
    expect(existsSync(`${helper}.started`)).toBe(false);
  }, TEST_TIMEOUT);

  test("a WorkerRequest.lifecycle accessor is refused without invocation or spawn", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let accessorReads = 0;
    const request = makeRequest(root, helper);
    Object.defineProperty(request, "lifecycle", {
      get() {
        accessorReads += 1;
        throw new Error("request accessor must not be read");
      },
    });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request)).rejects.toThrow(/own data property/);
    expect(accessorReads).toBe(0);
    expect(existsSync(`${helper}.started`)).toBe(false);
  }, TEST_TIMEOUT);

  test("an own aborted=false shadow cannot mask the intrinsic signal state", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "aborted", { value: false, configurable: true });
    const request = makeRequest(root, helper, { signal: controller.signal });
    const result = await new OmpRpcRunner({ env: runnerEnvironment() }).run(request);

    expect(result.status).toBe("cancelled");
    expect(existsSync(`${helper}.started`)).toBe(false);
    expect(existsSync(`${helper}.prompt`)).toBe(false);
  }, TEST_TIMEOUT);

  test("a reentrant abort inside the currentness callback refuses spawn", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    const controller = new AbortController();
    const lifecycle = makeLifecycle({
      hooks: {
        cleanupObserved: (_event, assertPersistable) => { assertPersistable(); },
      },
    });
    lifecycle.assertAdvanceCurrent = () => { controller.abort(); };
    const request = makeRequest(root, helper, { lifecycle, signal: controller.signal });
    const result = await new OmpRpcRunner({ env: runnerEnvironment() }).run(request);

    expect(result.status).toBe("cancelled");
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved")).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(true);
    expect(existsSync(`${helper}.started`)).toBe(false);
    expect(existsSync(`${helper}.prompt`)).toBe(false);
  }, TEST_TIMEOUT);

  test("expired cleanup acknowledgement retains runtime and ownership evidence", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = makeLifecycle({
      cleanupGraceMs: 150,
      hooks: { cleanupObserved: async () => { await gate; } },
    });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request))
      .rejects.toThrow(/did not settle before the cleanup deadline/);
    release();
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved")).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(false);
    expect(existsSync(launched!.runtimeRoot)).toBe(true);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(true);
  }, TEST_TIMEOUT);

  test("expired result acknowledgement throws after acknowledged cleanup", async () => {
    const root = await makeRunRoot();
    const helper = helperCommand(root, "normal");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lifecycle = makeLifecycle({
      cleanupGraceMs: 200,
      hooks: { resultObserved: async () => { await gate; } },
    });
    const request = makeRequest(root, helper, { lifecycle });

    await expect(new OmpRpcRunner({ env: runnerEnvironment() }).run(request))
      .rejects.toThrow(/did not settle before the cleanup deadline/);
    release();
    const launched = eventOfType(lifecycle, "preLaunch");
    expect(lifecycle.events.some((event) => event.type === "cleanupObserved")).toBe(true);
    expect(lifecycle.events.some((event) => event.type === "resultObserved")).toBe(true);
    expect(existsSync(`${helper}.prompt`)).toBe(true);
    expect(existsSync(launched!.runtimeRoot)).toBe(false);
    expect(existsSync(path.join(request.artifactDir, "worker-owner.json"))).toBe(false);
  }, TEST_TIMEOUT);
});
