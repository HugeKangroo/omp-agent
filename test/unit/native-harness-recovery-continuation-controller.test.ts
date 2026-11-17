import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  HarnessController,
  accountedCost,
  type HarnessRecoveryCasFacts,
  type HarnessRecoveryContinuationHooks,
  type HarnessRecoveryInspectionView,
  type HarnessRecoverySettlementFacts,
} from "../../vendor/harness2/upstream/src/controller.ts";
import {
  RunStore,
  StoreConflictError,
  atomicWrite,
} from "../../vendor/harness2/upstream/src/store.ts";
import type { RunEvent, RunRecord, Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/upstream/src/types.ts";

const SHA = (fill: string): string => fill.repeat(64);
const MODEL = "fixture/model";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";

const PLAN_RESPONSE = JSON.stringify({
  decision: "direct",
  reason: "Bounded direct plan for the continuation fixture.",
  criteria: [{ id: "task", description: "Fulfill the bounded fixture task.", kind: "requirement" }],
  routes: [],
});
const SELECT_RESPONSE = JSON.stringify({
  method: "model_review",
  assessments: [{
    candidate: "A",
    criteria: [{ criterionId: "task", verdict: "unknown", evidence: "Bounded fixture evidence." }],
    strengths: [],
    weaknesses: [],
  }],
  winner: "A",
  reason: "Bounded fixture selection.",
  limitations: ["Bounded fixture execution is not semantic acceptance."],
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) {
    if (error instanceof Error) return error;
    throw new Error("operation rejected with a non-Error value");
  }
  throw new Error("operation unexpectedly succeeded");
}

interface BaseFixture {
  readonly root: string;
  readonly workspace: string;
  readonly storeRoot: string;
}

function gitFixture(workspace: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git fixture failed (${args.join(" ")}): ${result.stderr ?? result.error?.message ?? "unknown"}`);
  }
}

async function makeBase(): Promise<BaseFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-recovery-continuation-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", { mode: 0o600 });
  gitFixture(workspace, ["-c", "init.defaultBranch=main", "init", "-q"]);
  gitFixture(workspace, ["add", "fixture.txt"]);
  gitFixture(workspace, [
    "-c", "user.name=Recovery Continuation Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-q", "-m", "fixture",
  ]);
  return { root, workspace, storeRoot: path.join(root, "store") };
}

function primaryPath(storeRoot: string, id: string): string {
  return path.join(storeRoot, "runs", id, "run.json");
}
function backupPath(storeRoot: string, id: string): string {
  return path.join(storeRoot, "runs", id, "run.json.bak");
}
function cancelPath(storeRoot: string, id: string): string {
  return path.join(storeRoot, "runs", id, "cancel.request");
}
function lockPath(storeRoot: string, id: string): string {
  return path.join(storeRoot, "runs", id, ".run.lock");
}

function seed(overrides: { admittedAt?: number; deadlineAt?: number } = {}) {
  const admittedAt = overrides.admittedAt ?? Date.now() - 1_000;
  return {
    schema: "omp-agent.native-harness-recovery-seed.v1" as const,
    profile: "native-auto-scoped-files.v1" as const,
    accountingOwnerId: OWNER_ID,
    admissionId: ADMISSION_ID,
    accountingOwnerRevision: 1,
    sourceAssociationSha256: SHA("a"),
    sourceDescriptorSha256: SHA("b"),
    inputManifestSha256: SHA("c"),
    admittedAt,
    deadlineAt: overrides.deadlineAt ?? admittedAt + 300_000,
    allocatedCostUsd: 0.5,
  };
}

async function createMarked(controller: HarnessController, overrides: { admittedAt?: number; deadlineAt?: number } = {}): Promise<RunRecord> {
  return controller.create("marked continuation fixture task", {
    model: MODEL,
    maxCostUsd: 0.5,
    maxDurationMs: 120_000,
    stageTimeoutMs: 10_000,
  }, { recoverySeedText: JSON.stringify(seed(overrides)) });
}

function stageResult(text: string): WorkerResult {
  const now = new Date().toISOString();
  return {
    text,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
    startedAt: now,
    endedAt: now,
    eventsPath: path.join(tmpdir(), `fixture-${randomUUID()}.jsonl`),
    status: "completed",
  };
}

/** Prior cancelled run: plan/select already completed, baseline has an unfinished attempt. */
async function enrichCancelled(store: RunStore, created: RunRecord): Promise<RunRecord> {
  const startedAt = new Date(Date.now() - 500).toISOString();
  const cwd = path.join(store.root, created.id, "fixture-stage");
  const select = {
    id: "select" as const,
    status: "completed" as const,
    attempt: 1,
    cwd,
    startedAt,
    endedAt: startedAt,
    accountedCostUsd: 0.05,
    result: stageResult(SELECT_RESPONSE),
  };
  const plan = {
    id: "plan" as const,
    status: "completed" as const,
    attempt: 1,
    cwd,
    startedAt,
    endedAt: startedAt,
    accountedCostUsd: 0.02,
    result: stageResult(PLAN_RESPONSE),
  };
  const baseline = {
    id: "baseline" as const,
    status: "running" as const,
    attempt: 2,
    cwd,
    startedAt,
    harness: created.baseHarness,
    accountedCostUsd: 0.12,
    reservedCostUsd: 0.06,
    observedCostUsd: 0.03,
  };
  return store.save({
    ...created,
    status: "cancelled",
    error: "prior interrupted attempt",
    stages: { ...created.stages, plan, select, baseline },
  }, created.revision);
}

async function readFacts(storeRoot: string, id: string): Promise<HarnessRecoveryCasFacts> {
  const primary = await readFile(primaryPath(storeRoot, id));
  const parsed = JSON.parse(primary.toString("utf8")) as { revision: number };
  const cancel = await readFile(cancelPath(storeRoot, id)).catch(() => undefined);
  return {
    expectedRevision: parsed.revision,
    expectedPrimarySha256: sha256(primary),
    expectedCancelSha256: cancel === undefined ? null : sha256(cancel),
  };
}

interface ScriptedRunner {
  readonly runner: Runner;
  readonly calls: WorkerRequest[];
}

function scriptedRunner(root: string, onRun?: (request: WorkerRequest) => void): ScriptedRunner {
  const calls: WorkerRequest[] = [];
  let index = 0;
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      calls.push(request);
      onRun?.(request);
      const directory = path.join(root, "worker-events");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(directory, `${request.stage}-${index++}.jsonl`);
      await writeFile(eventsPath, "{\"type\":\"fixture\"}\n", { mode: 0o600 });
      return {
        ...stageResult(request.stage === "plan" ? PLAN_RESPONSE
          : request.stage === "select" ? SELECT_RESPONSE
          : "fixture candidate"),
        eventsPath,
      };
    },
  };
  return { runner, calls };
}

function hooks(control: Partial<HarnessRecoveryContinuationHooks> & Pick<HarnessRecoveryContinuationHooks, "prepare">): HarnessRecoveryContinuationHooks {
  return {
    prepare: control.prepare,
    refreshCurrent: control.refreshCurrent ?? (() => {}),
    revalidateCurrent: control.revalidateCurrent ?? (() => {}),
    settled: control.settled ?? (() => {}),
  };
}

describe("R2-C2b2a actual same-lease continuation", () => {
  test("unconfigured, malformed and fake/preaborted controls refuse before lease effects", async () => {
    const base = await makeBase();
    const calls: WorkerRequest[] = [];
    const plain = scriptedRunner(base.root);
    calls.push(...plain.calls);
    const unconfigured = new HarnessController({ ...base, runner: plain.runner });
    const created = await createMarked(unconfigured);
    const before = await readFile(primaryPath(base.storeRoot, created.id));

    const missing = await rejection(unconfigured.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(missing.message).toMatch(/not configured/i);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
    expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(before);
    expect(plain.calls).toHaveLength(0);

    let settledCalls = 0;
    const configured = new HarnessController({
      ...base,
      runner: plain.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, created.id),
        settled: () => { settledCalls += 1; },
      }),
    });

    const malformed = await rejection(configured.continueWithRecoveryLease("bad id/with slash", new AbortController().signal));
    expect(malformed.message).toMatch(/valid run id/i);
    const fake = await rejection(configured.continueWithRecoveryLease(created.id, { aborted: false } as unknown as AbortSignal));
    expect(fake.message).toMatch(/actual AbortSignal/);
    const abortedController = new AbortController();
    abortedController.abort();
    const preaborted = await rejection(configured.continueWithRecoveryLease(created.id, abortedController.signal));
    expect(preaborted.message).toMatch(/already aborted/);
    expect(settledCalls).toBe(0);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
    expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(before);
    expect(plain.calls).toHaveLength(0);
  }, 15_000);

  test("configured hooks do not reopen original marked execute or resume", async () => {
    const base = await makeBase();
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => {
          throw new Error("continuation prepare must not be called");
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const marker = await readFile(cancelPath(base.storeRoot, created.id));
    const primary = await readFile(primaryPath(base.storeRoot, created.id));
    const executed = await rejection(controller.execute(created.id));
    expect(executed.message).toMatch(/initial record|guarded continuation/i);
    const resumed = await rejection(controller.resume(created.id));
    expect(resumed.message).toMatch(/guarded continuation|marked recovery/i);
    expect(await readFile(cancelPath(base.storeRoot, created.id))).toEqual(marker);
    expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(primary);
    expect(scripted.calls).toHaveLength(0);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 15_000);

  test("only exact own-data continuation hooks are adopted", async () => {
    const base = await makeBase();
    const good = {
      prepare: async () => ({ expectedRevision: 0, expectedPrimarySha256: SHA("a"), expectedCancelSha256: null }),
      refreshCurrent: () => {},
      revalidateCurrent: () => {},
      settled: () => {},
    };
    const accessorOptions = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessorOptions, "recoveryContinuation", {
      configurable: true,
      get() { throw new Error("must not read accessor"); },
    });
    expect(() => new HarnessController(accessorOptions as never)).toThrow(/own-data/);
    expect(() => new HarnessController({ ...base, recoveryContinuation: Object.create(good) } as never))
      .toThrow(/plain own-data/);
    expect(() => new HarnessController({ ...base, recoveryContinuation: { ...good, extra: true } } as never))
      .toThrow(/exactly/);
    expect(() => new HarnessController({ ...base, recoveryContinuation: { ...good, prepare: 7 } } as never))
      .toThrow(/prepare/);
    const symbolHooks = { ...good } as Record<PropertyKey, unknown>;
    symbolHooks[Symbol("extra")] = () => {};
    expect(() => new HarnessController({ ...base, recoveryContinuation: symbolHooks } as never))
      .toThrow(/symbol/);

    let prepareCalls = 0;
    let refreshCalls = 0;
    const captured = { ...good };
    const controller = new HarnessController({
      ...base,
      runner: scriptedRunner(base.root).runner,
      recoveryContinuation: captured,
    });
    captured.refreshCurrent = () => { refreshCalls += 1; };
    captured.prepare = async () => { prepareCalls += 1; throw new Error("replaced prepare must not run"); };
    const created = await createMarked(controller);
    // Capture happened at construction: the replacement prepare is not used.
    const viaHooks: HarnessRecoveryContinuationHooks = captured;
    expect(viaHooks.refreshCurrent).not.toBe((controller as unknown as { recoveryContinuation: HarnessRecoveryContinuationHooks }).recoveryContinuation.refreshCurrent);
    expect(prepareCalls).toBe(0);
    expect(refreshCalls).toBe(0);
  }, 15_000);

  test("commits and executes the original record on one actual lease", async () => {
    const base = await makeBase();
    let runId = "";
    let ownerSha = "";
    let runnerSawLock = false;
    let runnerSawOwner = false;
    let settledCalls = 0;
    let settledFacts: HarnessRecoverySettlementFacts | undefined;
    let retainedView: HarnessRecoveryInspectionView | undefined;
    let releaseSettled!: () => void;
    const settledGate = new Promise<void>(resolve => { releaseSettled = resolve; });
    let settledEntered!: () => void;
    const entered = new Promise<void>(resolve => { settledEntered = resolve; });
    const scripted = scriptedRunner(base.root, request => {
      if (request.stage !== "baseline") return;
      runnerSawLock = existsSync(lockPath(base.storeRoot, request.runId));
      const owner = readFileSync(path.join(lockPath(base.storeRoot, request.runId), "owner.json"));
      runnerSawOwner = sha256(owner) === ownerSha;
    });
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async (view, signal) => {
          retainedView = view;
          ownerSha = view.ownerSha256;
          await view.assertCurrent();
          expect(signal).toBeInstanceOf(AbortSignal);
          return readFacts(base.storeRoot, runId);
        },
        refreshCurrent: async () => {},
        revalidateCurrent: () => {},
        settled: async (view, _signal, facts) => {
          settledCalls += 1;
          settledFacts = facts;
          expect(existsSync(lockPath(base.storeRoot, runId))).toBe(true);
          await view.assertCurrent();
          settledEntered();
          await settledGate;
          await view.assertCurrent();
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    const enriched = await enrichCancelled(store, created);
    const beforeSelect = structuredClone(enriched.stages.select);
    await controller.cancel(created.id);

    const pending = controller.continueWithRecoveryLease(created.id, new AbortController().signal);
    const first = await Promise.race([
      entered.then(() => "settled" as const),
      pending.then(() => "finished" as const, () => "failed" as const),
    ]);
    expect(first).toBe("settled");
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(true);
    expect(settledFacts).toBeDefined();
    releaseSettled();
    const result = await pending;

    expect(result.status).toBe("completed");
    expect(result.createdAt).toBe(enriched.createdAt);
    expect(result.task).toBe(enriched.task);
    expect(result.workspace).toBe(enriched.workspace);
    expect(result.config).toEqual(enriched.config);
    expect(result.recoveryOrigin).toEqual(enriched.recoveryOrigin);
    expect(result.stages.select).toEqual(beforeSelect!);
    expect(result.stages.baseline?.attempt).toBe(3);
    expect(result.stages.baseline?.accountedCostUsd).toBeCloseTo(0.121, 6);
    expect(result.stages.select?.accountedCostUsd).toBe(0.05);
    expect(accountedCost(result)).toBeCloseTo(0.191, 6);
    expect(result.stages.plan?.status).toBe("completed");
    expect(scripted.calls.map(request => request.stage)).toEqual(["baseline"]);
    expect(runnerSawLock).toBe(true);
    expect(runnerSawOwner).toBe(true);
    expect(settledCalls).toBe(1);
    expect(settledFacts).toEqual({
      prepareEntered: true,
      prepareReturned: true,
      commitEntered: true,
      commitConfirmed: true,
      executionEntered: true,
      executionSettled: true,
    });
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
    expect(existsSync(cancelPath(base.storeRoot, created.id))).toBe(false);
    expect(await store.list()).toHaveLength(1);
    if (retainedView === undefined) throw new Error("prepare view was not captured");
    const closed = await rejection(retainedView.assertCurrent());
    expect(closed).toBeInstanceOf(StoreConflictError);
    expect(closed.message).toMatch(/no longer active/);
  }, 20_000);

  test("stale CAS facts and a newer cancellation generation never dispatch", async () => {
    const base = await makeBase();
    let runId = "";
    let mode: "revision" | "primary" | "cancel" | "changed-generation" = "revision";
    let facts: HarnessRecoveryCasFacts | undefined;
    let refreshCalls = 0;
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => {
          const actual = facts ?? await readFacts(base.storeRoot, runId);
          facts = actual;
          if (mode === "revision") return { ...actual, expectedRevision: actual.expectedRevision + 1 };
          if (mode === "primary") return { ...actual, expectedPrimarySha256: SHA("f") };
          if (mode === "cancel") return { ...actual, expectedCancelSha256: SHA("e") };
          return actual;
        },
        refreshCurrent: async () => {
          refreshCalls += 1;
          if (mode === "changed-generation" && refreshCalls === 1) {
            await writeFile(cancelPath(base.storeRoot, runId), `cancel:${randomUUID()}\n`, { mode: 0o600 });
          }
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const primaryBefore = await readFile(primaryPath(base.storeRoot, created.id));
    const cancelBefore = await readFile(cancelPath(base.storeRoot, created.id));

    for (const current of ["revision", "primary", "cancel"] as const) {
      mode = current;
      const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
      expect(error).toBeInstanceOf(Error);
      expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(primaryBefore);
      expect(await readFile(cancelPath(base.storeRoot, created.id))).toEqual(cancelBefore);
      expect((await store.get(created.id))?.status).toBe("cancelled");
    }

    mode = "changed-generation";
    refreshCalls = 0;
    const changed = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(changed).toBeInstanceOf(StoreConflictError);
    expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(primaryBefore);
    const newer = await readFile(cancelPath(base.storeRoot, created.id));
    expect(newer).not.toEqual(cancelBefore);
    expect(scripted.calls).toHaveLength(0);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("prepare and settled failures retain the lease until the hooks actually settle", async () => {
    const base = await makeBase();
    let runId = "";
    let prepareEntered = false;
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
    let settledCalls = 0;
    let settledFacts: HarnessRecoverySettlementFacts | undefined;
    const controller = new HarnessController({
      ...base,
      runner: scriptedRunner(base.root).runner,
      recoveryContinuation: hooks({
        prepare: async (view) => {
          prepareEntered = true;
          await view.assertCurrent();
          await prepareGate;
          throw new Error("prepare failed after side effect");
        },
        settled: async (view, _signal, facts) => {
          settledCalls += 1;
          settledFacts = facts;
          expect(existsSync(lockPath(base.storeRoot, runId))).toBe(true);
          await view.assertCurrent();
        },
      }),
    });
    const created = await createMarked(controller);
    runId = created.id;
    const pending = controller.continueWithRecoveryLease(created.id, new AbortController().signal);
    const outcome = pending.then(() => "resolved" as const, () => "rejected" as const);
    while (!prepareEntered) await Bun.sleep(5);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(true);
    expect(await Promise.race([outcome, Bun.sleep(50).then(() => "waiting" as const)])).toBe("waiting");
    releasePrepare();
    const error = await rejection(pending);
    expect(error.message).toMatch(/prepare failed after side effect/);
    expect(settledCalls).toBe(1);
    expect(settledFacts).toEqual({
      prepareEntered: true,
      prepareReturned: false,
      commitEntered: false,
      commitConfirmed: false,
      executionEntered: false,
      executionSettled: false,
    });
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);

    let secondId = "";
    let throwCalls = 0;
    const secondScripted = scriptedRunner(base.root);
    const throwing = new HarnessController({
      ...base,
      runner: secondScripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, secondId),
        settled: () => { throwCalls += 1; throw new Error("settlement hook failed"); },
      }),
    });
    const second = await createMarked(throwing);
    secondId = second.id;
    const settledError = await rejection(throwing.continueWithRecoveryLease(second.id, new AbortController().signal));
    expect(settledError.message).toMatch(/settlement hook failed/);
    expect(throwCalls).toBe(1);
    expect(secondScripted.calls.map(request => request.stage)).toEqual(["plan", "baseline", "select"]);
    expect(existsSync(lockPath(base.storeRoot, second.id))).toBe(false);
  }, 20_000);

  test("external abort aborts the internal runner signal and prevents the next stage", async () => {
    const base = await makeBase();
    let runId = "";
    let runnerStarted!: () => void;
    const started = new Promise<void>(resolve => { runnerStarted = resolve; });
    let settledUnderLease = false;
    const calls: WorkerRequest[] = [];
    let internalSignal: AbortSignal | undefined;
    const runner: Runner = {
      async run(request: WorkerRequest): Promise<WorkerResult> {
        calls.push(request);
        internalSignal = request.signal;
        runnerStarted();
        await new Promise<void>(resolve => {
          if (request.signal?.aborted) { resolve(); return; }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          ...stageResult("fixture candidate"),
          status: "cancelled",
          error: "Cancellation requested",
        };
      },
    };
    const controller = new HarnessController({
      ...base,
      runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        settled: async (view) => {
          settledUnderLease = existsSync(lockPath(base.storeRoot, runId));
          await view.assertCurrent();
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const external = new AbortController();
    const pending = controller.continueWithRecoveryLease(created.id, external.signal);
    await started;
    expect((await rejection(controller.execute(created.id))).message).toMatch(/continuation is active/);
    expect((await rejection(controller.resume(created.id))).message).toMatch(/continuation is active/);
    external.abort();
    const error = await rejection(pending);
    expect(error.message).toMatch(/aborted after lease release/);
    const stored = await store.get(created.id);
    expect(stored?.status).toBe("cancelled");
    expect(calls.map(request => request.stage)).toEqual(["baseline"]);
    expect(internalSignal?.aborted).toBe(true);
    expect(settledUnderLease).toBe(true);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
    // Listener removal is static in the finally path; a second abort cannot
    // observe it because AbortSignal fires only once.
    external.abort();
  }, 20_000);

  test("synchronous final seals close rename windows for atomicWrite and commit publication", async () => {
    const base = await makeBase();
    const target = path.join(base.root, "atomic.txt");
    await writeFile(target, "old\n", { mode: 0o600 });
    let stale = false;
    const blocked = await rejection(atomicWrite(target, "new\n", async () => {
      await Promise.resolve();
      stale = true;
    }, () => {
      if (stale) throw new Error("currentness changed after await");
    }));
    expect(blocked.message).toMatch(/currentness changed/);
    expect(await readFile(target, "utf8")).toBe("old\n");
    const thenableSeal = await rejection(atomicWrite(target, "new\n", undefined, (() => Promise.resolve()) as never));
    expect(thenableSeal).toBeInstanceOf(StoreConflictError);
    expect(await readFile(target, "utf8")).toBe("old\n");

    const abortedWindow = new AbortController();
    const secondTarget = path.join(base.root, "aborted.txt");
    await writeFile(secondTarget, "old\n", { mode: 0o600 });
    const abortedSeal = await rejection(atomicWrite(secondTarget, "new\n", async () => {
      await Promise.resolve();
      abortedWindow.abort();
    }, () => {
      if (abortedWindow.signal.aborted) throw new Error("aborted in final async window");
    }));
    expect(abortedSeal.message).toMatch(/final async window/);
    expect(await readFile(secondTarget, "utf8")).toBe("old\n");

    let unhandled = 0;
    const observe = (): void => { unhandled += 1; };
    process.on("unhandledRejection", observe);
    try {
      const rejectedSeal = await rejection(atomicWrite(target, "new\n", undefined,
        (() => Promise.reject(new Error("async seal"))) as never));
      expect(rejectedSeal).toBeInstanceOf(StoreConflictError);
      await Bun.sleep(10);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", observe);
    }
    expect(await readFile(target, "utf8")).toBe("old\n");

    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(new HarnessController({ ...base, runner: scriptedRunner(base.root).runner }));
    const enriched = await enrichCancelled(store, created);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const lease = await store.acquireWithContext(created.id);
    const primaryBefore = await readFile(primaryPath(base.storeRoot, created.id));
    const cancelBefore = await readFile(cancelPath(base.storeRoot, created.id));
    let sealCalls = 0;
    let failedAtPrimaryWindow = false;
    const finalSeal = (): void => {
      sealCalls += 1;
      if (!existsSync(backupPath(base.storeRoot, created.id))) return;
      if (!readFileSync(backupPath(base.storeRoot, created.id)).equals(primaryBefore)) return;
      failedAtPrimaryWindow = true;
      throw new Error("stale after backup publication");
    };
    try {
      const error = await rejection(store.commitRecoveryInterrupted(
        lease,
        created.id,
        enriched.revision,
        sha256(primaryBefore),
        request.generationSha256,
        new AbortController().signal,
        () => {},
        finalSeal,
      ));
      expect(error.message).toMatch(/stale after backup publication/);
      expect(sealCalls).toBeGreaterThan(1);
      expect(failedAtPrimaryWindow).toBe(true);
      expect(await readFile(primaryPath(base.storeRoot, created.id))).toEqual(primaryBefore);
      expect(await readFile(backupPath(base.storeRoot, created.id))).toEqual(primaryBefore);
      expect(await readFile(cancelPath(base.storeRoot, created.id))).toEqual(cancelBefore);
      expect((await store.get(created.id))?.status).toBe("cancelled");
      expect((await store.get(created.id))?.revision).toBe(enriched.revision);
    } finally {
      await lease.release();
    }
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("a rejected async pure seal is refused synchronously without an unhandled rejection", async () => {
    const base = await makeBase();
    let runId = "";
    let unhandled = 0;
    const observe = (): void => { unhandled += 1; };
    process.on("unhandledRejection", observe);
    try {
      const scripted = scriptedRunner(base.root);
      const controller = new HarnessController({
        ...base,
        runner: scripted.runner,
        recoveryContinuation: hooks({
          prepare: async () => readFacts(base.storeRoot, runId),
          revalidateCurrent: (() => Promise.reject(new Error("async pure seal"))) as never,
        }),
      });
      const created = await createMarked(controller);
      runId = created.id;
      const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
      expect(error.message).toMatch(/return undefined synchronously/);
      await Bun.sleep(10);
      expect(unhandled).toBe(0);
      expect(scripted.calls).toHaveLength(0);
      expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
    } finally {
      process.off("unhandledRejection", observe);
    }
  }, 15_000);

  test("settled accepts only a genuine native Promise<void> and releases only after it settles", async () => {
    const base = await makeBase();
    let runId = "";
    let mode: "thenable" | "subclass" | "nonvoid" = "thenable";
    let thenGetterCalls = 0;
    let settledCalls = 0;
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        settled: (() => {
          settledCalls += 1;
          if (mode === "thenable") {
            return {
              get then() {
                thenGetterCalls += 1;
                throw new Error("foreign then getter must not be read");
              },
            };
          }
          if (mode === "subclass") {
            const Subclass = class extends Promise<void> {};
            return new Subclass(resolve => resolve());
          }
          return (async () => 7)();
        }) as never,
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    for (const current of ["thenable", "subclass", "nonvoid"] as const) {
      mode = current;
      const created = await createMarked(controller);
      runId = created.id;
      const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
      if (current === "nonvoid") expect(error.message).toMatch(/resolve undefined/);
      else expect(error.message).toMatch(/genuine native Promise/);
      expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
      expect((await store.get(created.id))?.status).toBe("completed");
    }
    expect(thenGetterCalls).toBe(0);
    expect(settledCalls).toBe(3);
  }, 20_000);

  test("throwing undefined still rejects instead of becoming a success ACK", async () => {
    const base = await makeBase();
    const prepareScripted = scriptedRunner(base.root);
    const prepareFailure = new HarnessController({
      ...base,
      runner: prepareScripted.runner,
      recoveryContinuation: hooks({
        prepare: (() => { throw undefined; }) as never,
      }),
    });
    const first = await createMarked(prepareFailure);
    let prepareRejected = false;
    let prepareValue: unknown = "sentinel";
    try {
      await prepareFailure.continueWithRecoveryLease(first.id, new AbortController().signal);
    } catch (error) {
      prepareRejected = true;
      prepareValue = error;
    }
    expect(prepareRejected).toBe(true);
    expect(prepareValue).toBeUndefined();
    expect(prepareScripted.calls).toHaveLength(0);
    expect(existsSync(lockPath(base.storeRoot, first.id))).toBe(false);

    let runId = "";
    const settledScripted = scriptedRunner(base.root);
    const settledFailure = new HarnessController({
      ...base,
      runner: settledScripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        settled: (() => { throw undefined; }) as never,
      }),
    });
    const second = await createMarked(settledFailure);
    runId = second.id;
    let settledRejected = false;
    let settledValue: unknown = "sentinel";
    try {
      await settledFailure.continueWithRecoveryLease(second.id, new AbortController().signal);
    } catch (error) {
      settledRejected = true;
      settledValue = error;
    }
    expect(settledRejected).toBe(true);
    expect(settledValue).toBeUndefined();
    expect(settledScripted.calls.map(request => request.stage)).toEqual(["plan", "baseline", "select"]);
    expect(existsSync(lockPath(base.storeRoot, second.id))).toBe(false);
  }, 20_000);

  test("invalid currentness at stage_started prevents the actual dispatch", async () => {
    const base = await makeBase();
    let runId = "";
    let stageStarted = false;
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        revalidateCurrent: () => {
          if (stageStarted) throw new Error("invalidated at stage_started");
        },
      }),
    });
    const originalAppend = controller.store.appendEvent.bind(controller.store);
    const instrumented = controller.store as unknown as { appendEvent: (event: RunEvent) => Promise<void> };
    instrumented.appendEvent = async (event: RunEvent): Promise<void> => {
      await originalAppend(event);
      if (event.type === "stage_started") stageStarted = true;
    };
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(error.message).toMatch(/invalidated at stage_started/);
    expect(scripted.calls).toHaveLength(0);
    expect((await store.get(created.id))?.status).not.toBe("completed");
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("final ACK refuses when settlement outlives the original deadline", async () => {
    const base = await makeBase();
    let runId = "";
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        settled: async () => {
          expect(existsSync(lockPath(base.storeRoot, runId))).toBe(true);
          await Bun.sleep(900);
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller, {
      admittedAt: Date.now() - 1_000,
      deadlineAt: Date.now() + 600,
    });
    runId = created.id;
    const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(error.message).toMatch(/deadline expired/);
    expect(scripted.calls.map(request => request.stage)).toEqual(["plan", "baseline", "select"]);
    expect((await store.get(created.id))?.status).toBe("completed");
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("an abort inside the final pure seal is seen by the last intrinsic check", async () => {
    const base = await makeBase();
    let runId = "";
    const external = new AbortController();
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        revalidateCurrent: () => {
          if (existsSync(primaryPath(base.storeRoot, runId)) && !existsSync(lockPath(base.storeRoot, runId))) {
            external.abort();
          }
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    const error = await rejection(controller.continueWithRecoveryLease(created.id, external.signal));
    expect(error.message).toMatch(/aborted after lease release/);
    expect((await store.get(created.id))?.status).toBe("completed");
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("postcommit refresh invalidation preserves the committed record and dispatches nothing", async () => {
    const base = await makeBase();
    let runId = "";
    let refreshCalls = 0;
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        refreshCurrent: async () => {
          refreshCalls += 1;
          // Commit's checkpoints total seven calls; 8 is the post-commit refresh.
          if (refreshCalls === 8) throw new Error("host closed after commit");
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    const enriched = await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(error.message).toMatch(/host closed after commit/);
    const stored = await store.get(created.id);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.revision).toBe(enriched.revision + 1);
    expect(existsSync(cancelPath(base.storeRoot, created.id))).toBe(false);
    expect(scripted.calls).toHaveLength(0);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("the postrelease pure seal can refuse ACK after completed publication", async () => {
    const base = await makeBase();
    let runId = "";
    const scripted = scriptedRunner(base.root);
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async () => readFacts(base.storeRoot, runId),
        revalidateCurrent: () => {
          if (existsSync(primaryPath(base.storeRoot, runId)) && !existsSync(lockPath(base.storeRoot, runId))) {
            throw new Error("host closed after lease release");
          }
        },
      }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const error = await rejection(controller.continueWithRecoveryLease(created.id, new AbortController().signal));
    expect(error.message).toMatch(/after lease release/);
    const stored = await store.get(created.id);
    expect(stored?.status).toBe("completed");
    expect(scripted.calls.map(request => request.stage)).toEqual(["baseline"]);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);

  test("the effective original deadline aborts execution without renewing the run", async () => {
    const base = await makeBase();
    let runId = "";
    let runnerStarted!: () => void;
    const started = new Promise<void>(resolve => { runnerStarted = resolve; });
    const calls: WorkerRequest[] = [];
    const runner: Runner = {
      async run(request: WorkerRequest): Promise<WorkerResult> {
        calls.push(request);
        runnerStarted();
        await new Promise<void>(resolve => {
          if (request.signal?.aborted) { resolve(); return; }
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          ...stageResult("fixture candidate"),
          status: "cancelled",
          error: "Original recovery deadline expired",
        };
      },
    };
    const controller = new HarnessController({
      ...base,
      runner,
      recoveryContinuation: hooks({ prepare: async () => readFacts(base.storeRoot, runId) }),
    });
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const admittedAt = Date.now() - 1_000;
    const created = await createMarked(controller, { admittedAt, deadlineAt: Date.now() + 900 });
    runId = created.id;
    const enriched = await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const beforeConfig = structuredClone(enriched.config);
    const beforeOrigin = structuredClone(enriched.recoveryOrigin);
    const pending = controller.continueWithRecoveryLease(created.id, new AbortController().signal);
    await started;
    const error = await rejection(pending);
    expect(error.message).toMatch(/deadline expired/);

    const result = await store.get(created.id);
    if (result === undefined) throw new Error("fixture run missing");
    expect(result.status).toBe("cancelled");
    expect(result.config).toEqual(beforeConfig);
    expect(result.recoveryOrigin).toEqual(beforeOrigin);
    expect(result.createdAt).toBe(enriched.createdAt);
    expect(calls.map(request => request.stage)).toEqual(["baseline"]);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(900);
    const baseline = result.stages.baseline;
    expect(baseline?.attempt).toBe(3);
    expect(baseline?.accountedCostUsd).toBeGreaterThanOrEqual(0.12);
    expect(baseline?.reservedCostUsd).toBe(0);
    expect(accountedCost(result)).toBeGreaterThanOrEqual(0.17);
    expect(await store.list()).toHaveLength(1);
    expect(existsSync(lockPath(base.storeRoot, created.id))).toBe(false);
  }, 20_000);
});

describe("R2-C2b2a target capture", () => {
  test("controller, store roots and runner cannot be retargeted after construction or during prepare", async () => {
    const base = await makeBase();
    const foreign = await makeBase();
    const scripted = scriptedRunner(base.root);
    const foreignCalls: WorkerRequest[] = [];
    const foreignRunner: Runner = {
      async run() {
        foreignCalls.push({} as WorkerRequest);
        throw new Error("foreign runner must not run");
      },
    };
    let runId = "";
    let blocked = 0;
    let retainedView: HarnessRecoveryInspectionView | undefined;
    const controller = new HarnessController({
      ...base,
      runner: scripted.runner,
      recoveryContinuation: hooks({
        prepare: async (view) => {
          retainedView = view;
          for (const mutate of [
            () => { (controller as unknown as { store: RunStore }).store = new RunStore(foreign.storeRoot); },
            () => { Object.defineProperty(controller.store, "root", { value: foreign.storeRoot }); },
            () => { Object.defineProperty(controller.library, "root", { value: foreign.storeRoot }); },
            () => { (controller as unknown as { runner: Runner }).runner = foreignRunner; },
            () => { (controller as unknown as { workspace: string }).workspace = foreign.workspace; },
            () => { (controller as unknown as { storeRoot: string }).storeRoot = foreign.storeRoot; },
          ]) {
            try { mutate(); }
            catch { blocked += 1; }
          }
          return readFacts(base.storeRoot, runId);
        },
      }),
    });
    // Mutating the original runner object after capture cannot retarget the forwarding runner.
    (scripted.runner as unknown as { run: Runner["run"] }).run = foreignRunner.run;
    const store = new RunStore(path.join(base.storeRoot, "runs"));
    const created = await createMarked(controller);
    runId = created.id;
    await enrichCancelled(store, created);
    await controller.cancel(created.id);
    const result = await controller.continueWithRecoveryLease(created.id, new AbortController().signal);

    expect(blocked).toBe(6);
    expect(result.status).toBe("completed");
    expect(scripted.calls.map(request => request.stage)).toEqual(["baseline"]);
    expect(foreignCalls).toHaveLength(0);
    expect(await store.list()).toHaveLength(1);
    expect(existsSync(path.join(foreign.storeRoot, "runs", created.id))).toBe(false);
    if (retainedView === undefined) throw new Error("prepare view was not captured");
    expect((await rejection(retainedView.assertCurrent())).message).toMatch(/no longer active/);
  }, 20_000);
});
