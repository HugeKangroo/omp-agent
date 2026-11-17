import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HarnessController } from "../../vendor/harness2/upstream/src/controller.ts";
import {
  RunLockedError,
  RunStore,
  StoreConflictError,
  StoreCorruptionError,
  type RunStoreLease,
} from "../../vendor/harness2/upstream/src/store.ts";
import type {
  RunConfig,
  RunRecord,
  RunRecoverySeed,
  Runner,
  WorkerRequest,
  WorkerResult,
} from "../../vendor/harness2/upstream/src/types.ts";

const SHA = (fill: string): string => fill.repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const MODEL = "fixture/model";

const PLAN_RESPONSE = JSON.stringify({
  decision: "direct",
  reason: "Bounded direct plan for the recovery-lease fixture.",
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

async function makeStore(): Promise<{ root: string; store: RunStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-recovery-lease-"));
  roots.push(root);
  return { root, store: new RunStore(path.join(root, "runs")) };
}

interface ControllerFixture {
  readonly root: string;
  readonly workspace: string;
  readonly controller: HarnessController;
  readonly store: RunStore;
  readonly calls: WorkerRequest[];
  readonly runner: Runner;
}

function fakeRunner(root: string): { runner: Runner; calls: WorkerRequest[] } {
  const calls: WorkerRequest[] = [];
  let index = 0;
  const runner: Runner = {
    async run(request: WorkerRequest): Promise<WorkerResult> {
      calls.push(request);
      const directory = path.join(root, "worker-events");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const eventsPath = path.join(directory, `${request.stage}-${index++}.jsonl`);
      await writeFile(eventsPath, "{\"type\":\"fixture\"}\n", { mode: 0o600 });
      const now = new Date().toISOString();
      const text = request.stage === "plan" ? PLAN_RESPONSE
        : request.stage === "select" ? SELECT_RESPONSE
        : "fixture candidate";
      return {
        text,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 },
        startedAt: now,
        endedAt: now,
        eventsPath,
        status: "completed",
      };
    },
  };
  return { runner, calls };
}

async function makeController(): Promise<ControllerFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-recovery-lease-controller-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const storeRoot = path.join(root, "store");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", { mode: 0o600 });
  const fake = fakeRunner(root);
  const controller = new HarnessController({ workspace, storeRoot, runner: fake.runner });
  return {
    root,
    workspace,
    controller,
    store: new RunStore(path.join(storeRoot, "runs")),
    calls: fake.calls,
    runner: fake.runner,
  };
}

function gitFixture(workspace: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`git fixture failed (${args.join(" ")}): ${result.stderr ?? result.error?.message ?? "unknown"}`);
  }
}

/** Original initial execution snapshots the workspace, so this fixture is a real local Git root. */
async function makeGitWorkspace(root: string): Promise<string> {
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await writeFile(path.join(workspace, "fixture.txt"), "fixture\n", { mode: 0o600 });
  gitFixture(workspace, ["-c", "init.defaultBranch=main", "init", "-q"]);
  gitFixture(workspace, ["add", "fixture.txt"]);
  gitFixture(workspace, [
    "-c", "user.name=Recovery Lease Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-q", "-m", "fixture",
  ]);
  return workspace;
}

async function makeGitController(): Promise<ControllerFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-recovery-lease-git-"));
  roots.push(root);
  const workspace = await makeGitWorkspace(root);
  const storeRoot = path.join(root, "store");
  const fake = fakeRunner(root);
  const controller = new HarnessController({ workspace, storeRoot, runner: fake.runner });
  return {
    root,
    workspace,
    controller,
    store: new RunStore(path.join(storeRoot, "runs")),
    calls: fake.calls,
    runner: fake.runner,
  };
}

function seed(overrides: Partial<RunRecoverySeed> = {}): RunRecoverySeed {
  const admittedAt = Date.now() - 1_000;
  return {
    schema: "omp-agent.native-harness-recovery-seed.v1",
    profile: "native-auto-scoped-files.v1",
    accountingOwnerId: OWNER_ID,
    admissionId: ADMISSION_ID,
    accountingOwnerRevision: 1,
    sourceAssociationSha256: SHA("a"),
    sourceDescriptorSha256: SHA("b"),
    inputManifestSha256: SHA("c"),
    admittedAt,
    deadlineAt: admittedAt + 300_000,
    allocatedCostUsd: 0.5,
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
    schemaVersion: 1,
    id: "run-lease-fixture",
    revision: 0,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    updatedAt: new Date(Date.now() - 1_000).toISOString(),
    workspace: "/fixture/workspace",
    task: "fixture task",
    config: {
      mode: "product",
      strategy: "auto",
      model: MODEL,
      improverModel: MODEL,
      maxCostUsd: 0.5,
      maxDurationMs: 120_000,
      stageTimeoutMs: 10_000,
      domain: "fixture",
      ompCommand: "/bin/false",
    },
    status: "queued",
    baseHarness: {
      schemaVersion: 1,
      id: "fixture-harness",
      promptAppend: "fixture prompt",
      toolGuidance: "fixture guidance",
      rationale: "fixture rationale",
      skills: [],
    },
    libraryEntries: [],
    stages: {},
  };
  return { ...base, ...overrides };
}

interface MarkedOptions {
  readonly id?: string;
  readonly admittedAt?: number;
  readonly deadlineAt?: number;
  readonly createdAt?: string;
  readonly maxDurationMs?: number;
  readonly maxCostUsd?: number;
}

async function createMarked(store: RunStore, options: MarkedOptions = {}): Promise<RunRecord> {
  const admittedAt = options.admittedAt ?? Date.now() - 1_000;
  const deadlineAt = options.deadlineAt ?? admittedAt + 300_000;
  const createdAt = options.createdAt
    ?? new Date(Math.min(admittedAt + 1_000, deadlineAt - 1_000)).toISOString();
  const maxCostUsd = options.maxCostUsd ?? 0.5;
  const maxDurationMs = options.maxDurationMs ?? 120_000;
  const value = seed({ admittedAt, deadlineAt, allocatedCostUsd: maxCostUsd });
  const base = record({
    id: options.id ?? `run-${randomUUID()}`,
    createdAt,
    updatedAt: createdAt,
    config: {
      ...record().config,
      maxCostUsd,
      maxDurationMs,
      stageTimeoutMs: Math.max(1, Math.min(10_000, maxDurationMs)),
    },
  });
  return store.createWithRecoveryOrigin(base, JSON.stringify(value));
}

async function createMarkedController(controller: HarnessController): Promise<RunRecord> {
  const admittedAt = Date.now() - 1_000;
  const value = seed({ admittedAt, deadlineAt: admittedAt + 300_000 });
  const options: Partial<RunConfig> & { model: string } = {
    model: MODEL,
    maxCostUsd: 0.5,
    maxDurationMs: 120_000,
  };
  return controller.create("marked controller fixture task", options, { recoverySeedText: JSON.stringify(value) });
}

function primaryPath(store: RunStore, id: string): string {
  return path.join(store.runDir(id), "run.json");
}
function backupPath(store: RunStore, id: string): string {
  return path.join(store.runDir(id), "run.json.bak");
}
function cancelPath(store: RunStore, id: string): string {
  return path.join(store.runDir(id), "cancel.request");
}
function ownerPath(store: RunStore, id: string): string {
  return path.join(store.runDir(id), ".run.lock", "owner.json");
}
function writeLockPath(store: RunStore, id: string): string {
  return path.join(store.runDir(id), ".write.lock");
}
async function primarySha(store: RunStore, id: string): Promise<string> {
  return sha256(await readFile(primaryPath(store, id)));
}
async function cancelText(store: RunStore, id: string): Promise<string | undefined> {
  try { return await readFile(cancelPath(store, id), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; }
  catch { return false; }
}

async function enrichFailed(store: RunStore, created: RunRecord): Promise<RunRecord> {
  const current = await store.get(created.id);
  if (current === undefined) throw new Error("fixture run missing");
  const startedAt = current.createdAt;
  const stage = {
    id: "baseline" as const,
    status: "completed" as const,
    attempt: 1,
    cwd: "/fixture/stage",
    startedAt,
    endedAt: startedAt,
    accountedCostUsd: 0.05,
    reservedCostUsd: 0,
    observedCostUsd: 0.05,
    artifactHash: SHA("e"),
    result: {
      text: "fixture candidate result",
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.05 },
      startedAt,
      endedAt: startedAt,
      eventsPath: "/fixture/events.jsonl",
      status: "completed" as const,
    },
  };
  const next: RunRecord = {
    ...current,
    status: "failed",
    error: "fixture failure",
    snapshot: {
      id: "fixture-snapshot",
      sourceRoot: "/fixture/source",
      root: "/fixture/snapshot",
      files: [{ path: "fixture.txt", hash: SHA("f"), size: 8, mode: 0o600 }],
      createdAt: startedAt,
    },
    stages: { baseline: stage },
  };
  return store.save(next, current.revision);
}

describe("R2-C1a issued run lease context", () => {
  test("uses the exact original owner bytes and retains exclusivity", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);

    expect(Object.isFrozen(lease)).toBe(true);
    expect(lease.ownerSha256).toMatch(/^[a-f0-9]{64}$/);
    const raw = await readFile(ownerPath(store, created.id));
    const owner = JSON.parse(raw.toString("utf8")) as { pid: number; token: string; createdAt: string };
    expect(raw.toString("utf8")).toBe(`${JSON.stringify(owner, null, 2)}\n`);
    expect(lease.ownerSha256).toBe(sha256(raw));
    expect(owner.pid).toBe(process.pid);
    expect(owner.token).toMatch(UUID);
    expect(owner.createdAt).toBe(new Date(Date.parse(owner.createdAt)).toISOString());
    await lease.assertCurrent();

    const second = await rejection(store.acquire(created.id));
    expect(second).toBeInstanceOf(RunLockedError);

    await lease.release();
    expect(await rejection(lease.assertCurrent())).toBeInstanceOf(StoreConflictError);
    const nextRelease = await store.acquire(created.id);
    await nextRelease();
  });

  test("acquireWithContext captures its root before the first await", async () => {
    const { root, store } = await makeStore();
    const created = await createMarked(store);
    const originalRoot = store.root;
    const originalDirectory = path.join(originalRoot, created.id);
    const retargeted = path.join(root, "retargeted-absent");
    const pending = store.acquireWithContext(created.id);
    // The call has yielded at its first filesystem await; retarget the public
    // data property before validation/issuance resumes.
    Object.defineProperty(store, "root", { value: retargeted });
    const lease = await pending;
    try {
      await lease.assertCurrent();
      expect(await exists(path.join(originalDirectory, ".run.lock", "owner.json"))).toBe(true);
      expect(await exists(retargeted)).toBe(false);
    } finally {
      await lease.release();
    }
    expect(await exists(path.join(originalDirectory, ".run.lock"))).toBe(false);
  });

  test("copied, lookalike, foreign, other-run and released contexts cannot commit", async () => {
    const { root, store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const signal = new AbortController().signal;
    const attempt = (candidate: RunStoreLease, runId = created.id): Promise<RunRecord> =>
      store.commitRecoveryInterrupted(candidate, runId, created.revision, expectedPrimary, null, signal, () => {});

    expect(await rejection(attempt({ ...lease }))).toBeInstanceOf(StoreConflictError);
    const lookalike = {
      ownerSha256: lease.ownerSha256,
      assertCurrent: lease.assertCurrent,
      release: lease.release,
    };
    expect(await rejection(attempt(lookalike))).toBeInstanceOf(StoreConflictError);

    const otherStore = new RunStore(path.join(root, "other-runs"));
    const otherCreated = await createMarked(otherStore, { id: "run-other-store" });
    const otherLease = await otherStore.acquireWithContext(otherCreated.id);
    const foreign = await rejection(attempt(otherLease));
    expect(foreign).toBeInstanceOf(StoreConflictError);
    expect(foreign.message).toContain("issued by this Store");
    await otherLease.release();

    const second = await createMarked(store, { id: "run-second-lease" });
    const secondLease = await store.acquireWithContext(second.id);
    const wrongRun = await rejection(attempt(secondLease, created.id));
    expect(wrongRun).toBeInstanceOf(StoreConflictError);
    await secondLease.release();
    expect(await rejection(attempt(secondLease, created.id))).toBeInstanceOf(StoreConflictError);

    expect(await store.get(created.id)).toEqual(created);
    await lease.release();
  });

  test("changed owner bytes or a replaced lock identity refuse release and are preserved", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const ownerFile = ownerPath(store, created.id);
    const lockDirectory = path.join(store.runDir(created.id), ".run.lock");
    const original = await readFile(ownerFile, "utf8");
    const owner = JSON.parse(original) as { pid: number; token: string; createdAt: string };
    const changed = `${JSON.stringify({
      ...owner,
      createdAt: new Date(Date.parse(owner.createdAt) + 1_000).toISOString(),
    }, null, 2)}\n`;

    await writeFile(ownerFile, changed, { mode: 0o600 });
    expect((await rejection(lease.assertCurrent())).message).toContain("ownership changed");
    expect((await rejection(lease.release())).message).toContain("ownership changed");
    expect(await readFile(ownerFile, "utf8")).toBe(changed);

    await writeFile(ownerFile, original, { mode: 0o600 });
    await rm(lockDirectory, { recursive: true, force: true });
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(ownerFile, original, { mode: 0o600 });
    expect((await rejection(lease.assertCurrent())).message).toMatch(/replaced|ownership changed/);
    expect((await rejection(lease.release())).message).toMatch(/replaced|ownership changed/);
    expect((await stat(lockDirectory)).isDirectory()).toBe(true);
    expect(await readFile(ownerFile, "utf8")).toBe(original);
  }, 20_000);

  test("an in-flight commit conflicts with release and a second commit", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    let calls = 0;
    let pausedResolve!: () => void;
    let gateResolve!: () => void;
    const paused = new Promise<void>((resolve) => { pausedResolve = resolve; });
    const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
    const currentness = (): Promise<void> | void => {
      calls += 1;
      if (calls === 1) { pausedResolve(); return gate; }
      return undefined;
    };
    const signal = new AbortController().signal;
    const pending = store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      signal,
      currentness,
    );
    let saved: RunRecord | undefined;
    try {
      await paused;

      expect(await rejection(lease.release())).toBeInstanceOf(StoreConflictError);
      const second = await rejection(store.commitRecoveryInterrupted(
        lease,
        created.id,
        created.revision,
        expectedPrimary,
        null,
        signal,
        () => {},
      ));
      expect(second).toBeInstanceOf(StoreConflictError);
      expect((await store.get(created.id))?.status).toBe("queued");

      gateResolve();
      saved = await pending;
    } finally {
      gateResolve();
      await pending.catch(() => {});
    }
    expect(saved?.status).toBe("interrupted");
    expect(saved?.revision).toBe(created.revision + 1);
    await lease.release();
  }, 20_000);
});

describe("R2-C1a generation-aware marked cancellation", () => {
  test("successive marked requests write unique bounded generations, even when cancelled", async () => {
    const fixture = await makeController();
    const created = await createMarkedController(fixture.controller);
    await fixture.controller.cancel(created.id);

    const firstBytes = await readFile(cancelPath(fixture.store, created.id));
    const first = firstBytes.toString("utf8");
    expect(first).toMatch(/^cancel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/);
    expect(firstBytes.byteLength).toBeLessThanOrEqual(64);
    expect((await stat(cancelPath(fixture.store, created.id))).mode & 0o777).toBe(0o600);

    const recordNow = await fixture.controller.get(created.id);
    if (recordNow === undefined) throw new Error("fixture run missing");
    await fixture.store.save({ ...recordNow, status: "cancelled" }, recordNow.revision);
    await fixture.controller.cancel(created.id);
    const second = (await readFile(cancelPath(fixture.store, created.id))).toString("utf8");
    expect(second).not.toBe(first);
    expect(second).toMatch(/^cancel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/);

    await writeFile(cancelPath(fixture.store, created.id), "cancel:unknown\n", { mode: 0o600 });
    const corrupt = await rejection(fixture.controller.cancel(created.id));
    expect(corrupt).toBeInstanceOf(StoreCorruptionError);
    expect(await readFile(cancelPath(fixture.store, created.id), "utf8")).toBe("cancel:unknown\n");

    const valid = `cancel:${randomUUID()}\n`;
    await writeFile(cancelPath(fixture.store, created.id), valid, { mode: 0o600 });
    const writeLock = writeLockPath(fixture.store, created.id);
    await mkdir(writeLock, { mode: 0o700 });
    await writeFile(
      path.join(writeLock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const locked = await rejection(fixture.controller.cancel(created.id));
    expect(locked).toBeInstanceOf(RunLockedError);
    expect(await readFile(cancelPath(fixture.store, created.id), "utf8")).toBe(valid);
    await rm(writeLock, { recursive: true, force: true });
    expect(fixture.calls).toHaveLength(0);
  }, 20_000);

  test("concurrent marked requests remain distinct generations", async () => {
    const fixture = await makeController();
    const created = await createMarkedController(fixture.controller);
    const [first, second] = await Promise.all([
      fixture.store.requestMarkedCancellation(created.id),
      fixture.store.requestMarkedCancellation(created.id),
    ]);
    expect(first.status).toBe("requested");
    expect(second.status).toBe("requested");
    expect(first.generation).not.toBe(second.generation);
    const final = await cancelText(fixture.store, created.id);
    expect(final === first.generation || final === second.generation).toBe(true);
    expect(final).toMatch(/^cancel:[0-9a-f-]{36}\n$/);
    expect(fixture.calls).toHaveLength(0);
  }, 20_000);

  test("a runtime store.root retarget cannot redirect a marked cancellation request", async () => {
    const { root, store } = await makeStore();
    const created = await createMarked(store);
    const originalDirectory = path.join(store.root, created.id);
    const originalPrimary = await readFile(path.join(originalDirectory, "run.json"));
    const foreignRoot = path.join(root, "foreign-runs");
    const foreignDirectory = path.join(foreignRoot, created.id);
    await mkdir(foreignDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(foreignDirectory, "run.json"), originalPrimary, { mode: 0o600 });

    const pending = store.requestMarkedCancellation(created.id);
    // The operation captures its target directory synchronously. Retarget the
    // runtime-writable data property before the first lock await resumes.
    Object.defineProperty(store, "root", { value: foreignRoot });
    const request = await pending;
    if (request.generation === null) throw new Error("fixture generation missing");

    expect(request.status).toBe("requested");
    expect(request.generation).toMatch(/^cancel:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/);
    expect(Buffer.byteLength(request.generation, "utf8")).toBeLessThanOrEqual(64);
    expect(request.generationSha256).toBe(sha256(request.generation));
    const originalCancel = await readFile(path.join(originalDirectory, "cancel.request"));
    expect(originalCancel.toString("utf8")).toBe(request.generation);
    expect(originalCancel.byteLength).toBeLessThanOrEqual(64);
    expect(await exists(path.join(foreignDirectory, "cancel.request"))).toBe(false);
    expect(await readFile(path.join(originalDirectory, "run.json"))).toEqual(originalPrimary);
    expect(await readFile(path.join(foreignDirectory, "run.json"))).toEqual(originalPrimary);
    expect(await exists(path.join(originalDirectory, ".write.lock"))).toBe(false);
    expect(await exists(path.join(foreignDirectory, ".write.lock"))).toBe(false);
  }, 20_000);

  test("a newer generation before commit refuses without clearing the request", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const first = await store.requestMarkedCancellation(created.id);
    if (first.generationSha256 === null) throw new Error("fixture generation missing");
    const newer = await store.requestMarkedCancellation(created.id);
    const newerBytes = await readFile(cancelPath(store, created.id));
    expect(newer.generation).not.toBe(first.generation);

    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      await primarySha(store, created.id),
      first.generationSha256,
      new AbortController().signal,
      () => {},
    ));
    expect(error).toBeInstanceOf(StoreConflictError);
    expect(await readFile(cancelPath(store, created.id))).toEqual(newerBytes);
    expect((await store.get(created.id))?.revision).toBe(created.revision);
    await lease.release();
  }, 20_000);
});

describe("R2-C1a conditional interrupted transition", () => {
  test("commits under the original write lock and preserves identity, budget, stages and costs", async () => {
    const { store } = await makeStore();
    const initial = await createMarked(store);
    const enriched = await enrichFailed(store, initial);
    const lease = await store.acquireWithContext(initial.id);
    const request = await store.requestMarkedCancellation(initial.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const saved = await store.commitRecoveryInterrupted(
      lease,
      initial.id,
      enriched.revision,
      await primarySha(store, initial.id),
      request.generationSha256,
      new AbortController().signal,
      async () => {},
    );

    expect(saved.status).toBe("interrupted");
    expect(saved.revision).toBe(enriched.revision + 1);
    expect(saved.createdAt).toBe(enriched.createdAt);
    expect(saved.task).toBe(enriched.task);
    expect(saved.workspace).toBe(enriched.workspace);
    expect(saved.config).toEqual(enriched.config);
    expect(saved.recoveryOrigin).toEqual(enriched.recoveryOrigin);
    expect(JSON.stringify(saved.recoveryOrigin)).toBe(JSON.stringify(enriched.recoveryOrigin));
    expect(saved.snapshot).toEqual(enriched.snapshot);
    expect(saved.stages).toEqual(enriched.stages);
    expect(saved.winner).toBe(enriched.winner);
    expect(saved.selectionReason).toBe(enriched.selectionReason);
    expect(saved.error).toBe(enriched.error);
    expect(saved.updatedAt).toBe(new Date(Date.parse(saved.updatedAt)).toISOString());

    const backup = JSON.parse(await readFile(backupPath(store, initial.id), "utf8")) as RunRecord;
    expect(backup).toEqual(enriched);
    expect(await cancelText(store, initial.id)).toBeUndefined();

    const newer = await store.requestMarkedCancellation(initial.id);
    expect(newer.status).toBe("requested");
    expect(await cancelText(store, initial.id)).toBe(newer.generation!);
    expect((await store.get(initial.id))?.status).toBe("interrupted");
    await lease.release();
  }, 20_000);

  test("a runtime store.root retarget cannot redirect a lease-owned commit", async () => {
    const { root, store } = await makeStore();
    const created = await createMarked(store);
    const originalRoot = store.root;
    const originalDirectory = path.join(originalRoot, created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const foreignRoot = path.join(root, "foreign-runs");
    await mkdir(foreignRoot, { mode: 0o700 });
    await cp(originalDirectory, path.join(foreignRoot, created.id), { recursive: true });
    const originalPrimary = await readFile(path.join(originalDirectory, "run.json"));
    const foreignPrimary = await readFile(path.join(foreignRoot, created.id, "run.json"));
    const foreignCancel = await readFile(path.join(foreignRoot, created.id, "cancel.request"));
    const lease = await store.acquireWithContext(created.id);
    let retargeted = false;
    const currentness = (): void => {
      if (retargeted) return;
      retargeted = true;
      Object.defineProperty(store, "root", { value: foreignRoot });
    };
    try {
      const saved = await store.commitRecoveryInterrupted(
        lease,
        created.id,
        created.revision,
        sha256(originalPrimary),
        request.generationSha256,
        new AbortController().signal,
        currentness,
      );
      expect(saved.status).toBe("interrupted");
      expect(saved.revision).toBe(created.revision + 1);
      expect(retargeted).toBe(true);

      const originalAfter = JSON.parse(await readFile(path.join(originalDirectory, "run.json"), "utf8")) as RunRecord;
      expect(originalAfter.status).toBe("interrupted");
      expect(originalAfter.revision).toBe(created.revision + 1);
      expect(await readFile(path.join(originalDirectory, "run.json.bak"))).toEqual(originalPrimary);
      expect(await exists(path.join(originalDirectory, "cancel.request"))).toBe(false);

      expect(await readFile(path.join(foreignRoot, created.id, "run.json"))).toEqual(foreignPrimary);
      expect(await readFile(path.join(foreignRoot, created.id, "cancel.request"))).toEqual(foreignCancel);
      expect(await exists(path.join(foreignRoot, created.id, ".run.lock"))).toBe(false);
      await lease.assertCurrent();
    } finally {
      await lease.release();
    }
    expect(await exists(path.join(originalDirectory, ".run.lock"))).toBe(false);
  }, 20_000);

  test("stale primary bytes at the same revision refuse and leave the cancel marker", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const before = await readFile(primaryPath(store, created.id));

    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      SHA("0"),
      request.generationSha256,
      new AbortController().signal,
      () => {},
    ));
    expect(error).toBeInstanceOf(StoreConflictError);
    expect(await readFile(primaryPath(store, created.id))).toEqual(before);
    expect(await cancelText(store, created.id)).toBe(request.generation!);
    await lease.release();
  }, 20_000);

  test("unmarked records, structural signals and unsafe arguments fail closed", async () => {
    const { store } = await makeStore();
    const plain = record({ id: "run-plain-no-origin" });
    await store.create(plain);
    const plainLease = await store.acquireWithContext(plain.id);
    const unmarked = await rejection(store.commitRecoveryInterrupted(
      plainLease,
      plain.id,
      plain.revision,
      await primarySha(store, plain.id),
      null,
      new AbortController().signal,
      () => {},
    ));
    expect(unmarked).toBeInstanceOf(StoreConflictError);
    expect((await store.get(plain.id))?.revision).toBe(plain.revision);
    await plainLease.release();

    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const structural = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      { aborted: false } as unknown as AbortSignal,
      () => {},
    ));
    expect(structural).toBeInstanceOf(StoreConflictError);

    const aborted = new AbortController();
    aborted.abort();
    expect(await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      aborted.signal,
      () => {},
    ))).toBeInstanceOf(Error);

    const spoofedPrototype = Object.create(AbortSignal.prototype) as AbortSignal;
    expect(await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      spoofedPrototype,
      () => {},
    ))).toBeInstanceOf(StoreConflictError);

    const shadowController = new AbortController();
    Object.defineProperty(shadowController.signal, "aborted", { configurable: true, get: () => false });
    shadowController.abort();
    expect(await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      shadowController.signal,
      () => {},
    ))).toBeInstanceOf(Error);

    expect(await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      SHA("0"),
      "not-a-sha",
      new AbortController().signal,
      () => {},
    ))).toBeInstanceOf(StoreConflictError);
    expect((await store.get(created.id))?.revision).toBe(created.revision);
    await lease.release();
  }, 20_000);

  test("host currentness failures never become authority", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    let thenGetterCalls = 0;
    const cases: Array<readonly [string, () => unknown]> = [
      ["throws", () => { throw new Error("host stale"); }],
      ["false", () => false],
      ["fulfilled nonvoid", async () => false],
      ["rejected", () => Promise.reject(new Error("host rejected"))],
      ["plain thenable", () => ({ then() { return undefined; } })],
      ["then getter", () => Object.defineProperty({}, "then", {
        get() { thenGetterCalls += 1; throw new Error("then getter must not be read"); },
      })],
    ];
    for (const [label, currentness] of cases) {
      const error = await rejection(store.commitRecoveryInterrupted(
        lease,
        created.id,
        created.revision,
        expectedPrimary,
        null,
        new AbortController().signal,
        currentness as never,
      ));
      expect(error).toBeInstanceOf(Error);
      expect(label.length).toBeGreaterThan(0);
      expect((await store.get(created.id))?.revision).toBe(created.revision);
    }
    expect(thenGetterCalls).toBe(0);
    expect(await cancelText(store, created.id)).toBeUndefined();
    await lease.release();
  }, 20_000);

  test("unsafe and pre-admission clocks fail each operation, and a restored clock is not sticky", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const originalNow = Date.now;
    try {
      Date.now = () => -1;
      const unsafe = await rejection(store.commitRecoveryInterrupted(
        lease, created.id, created.revision, expectedPrimary, null, new AbortController().signal, () => {},
      ));
      expect(unsafe.message).toContain("safe positive");
      expect((await store.get(created.id))?.revision).toBe(created.revision);

      Date.now = () => created.recoveryOrigin!.seed.admittedAt - 1;
      const beforeAdmission = await rejection(store.commitRecoveryInterrupted(
        lease, created.id, created.revision, expectedPrimary, null, new AbortController().signal, () => {},
      ));
      expect(beforeAdmission.message).toContain("predates original admission");
      expect((await store.get(created.id))?.revision).toBe(created.revision);
    } finally {
      Date.now = originalNow;
    }

    const saved = await store.commitRecoveryInterrupted(
      lease, created.id, created.revision, expectedPrimary, null, new AbortController().signal, () => {},
    );
    expect(saved.status).toBe("interrupted");
    expect(saved.revision).toBe(created.revision + 1);
    await lease.release();
  }, 20_000);

  test("both original deadlines refuse the transition without extension", async () => {
    const outerStore = (await makeStore()).store;
    const now = Date.now();
    const outerDeadline = now - 1_000;
    const outerCreated = new Date(outerDeadline - 1_000).toISOString();
    const outer = await createMarked(outerStore, {
      id: "run-outer-deadline",
      admittedAt: outerDeadline - 300_000,
      deadlineAt: outerDeadline,
      createdAt: outerCreated,
      maxDurationMs: 600_000,
    });
    const outerLease = await outerStore.acquireWithContext(outer.id);
    const outerBefore = await readFile(primaryPath(outerStore, outer.id));
    const outerError = await rejection(outerStore.commitRecoveryInterrupted(
      outerLease,
      outer.id,
      outer.revision,
      await primarySha(outerStore, outer.id),
      null,
      new AbortController().signal,
      () => {},
    ));
    expect(outerError.message).toContain("deadline");
    expect(await readFile(primaryPath(outerStore, outer.id))).toEqual(outerBefore);
    await outerLease.release();

    const innerStore = (await makeStore()).store;
    const innerAdmitted = Date.now() - 10_000;
    const inner = await createMarked(innerStore, {
      id: "run-inner-deadline",
      admittedAt: innerAdmitted,
      deadlineAt: innerAdmitted + 300_000,
      createdAt: new Date(innerAdmitted + 5_000).toISOString(),
      maxDurationMs: 1,
    });
    const innerLease = await innerStore.acquireWithContext(inner.id);
    const innerBefore = await readFile(primaryPath(innerStore, inner.id));
    const innerError = await rejection(innerStore.commitRecoveryInterrupted(
      innerLease,
      inner.id,
      inner.revision,
      await primarySha(innerStore, inner.id),
      null,
      new AbortController().signal,
      () => {},
    ));
    expect(innerError.message).toContain("deadline");
    expect(await readFile(primaryPath(innerStore, inner.id))).toEqual(innerBefore);
    await innerLease.release();
  }, 20_000);

  test("a same-revision primary replacement after the host hook is not overwritten", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const replacement = { ...created, status: "failed" as const, error: "external replacement" };
    const replacementText = `${JSON.stringify(replacement, null, 2)}\n`;
    let calls = 0;
    const currentness = async (): Promise<void> => {
      calls += 1;
      if (calls === 2) await writeFile(primaryPath(store, created.id), replacementText, { mode: 0o600 });
    };
    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      new AbortController().signal,
      currentness,
    ));
    expect(error.message).toContain("changed before publication");
    expect(await readFile(primaryPath(store, created.id), "utf8")).toBe(replacementText);
    expect(await readFile(cancelPath(store, created.id)).catch(() => undefined)).toBeUndefined();
    await lease.release();
  }, 20_000);

  test("host work during primary temp IO cannot overwrite a replaced primary", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const replacement = { ...created, status: "failed" as const, error: "external temp replacement" };
    const replacementText = `${JSON.stringify(replacement, null, 2)}\n`;
    let calls = 0;
    const currentness = async (): Promise<void> => {
      calls += 1;
      if (calls === 4) await writeFile(primaryPath(store, created.id), replacementText, { mode: 0o600 });
    };
    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      expectedPrimary,
      null,
      new AbortController().signal,
      currentness,
    ));
    expect(error.message).toContain("changed before publication");
    expect(await readFile(primaryPath(store, created.id), "utf8")).toBe(replacementText);
    expect(await cancelText(store, created.id)).toBeUndefined();
    await lease.release();
  }, 20_000);

  test("clock rollback during publication is refused within the same commit", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const before = await readFile(primaryPath(store, created.id));
    const originalNow = Date.now;
    let fakeNow = originalNow();
    Date.now = () => fakeNow;
    let calls = 0;
    const currentness = (): void => {
      calls += 1;
      if (calls === 3) fakeNow += 1_000;
      if (calls === 4) fakeNow -= 500;
    };
    try {
      const error = await rejection(store.commitRecoveryInterrupted(
        lease,
        created.id,
        created.revision,
        expectedPrimary,
        null,
        new AbortController().signal,
        currentness,
      ));
      expect(error.message).toContain("moved backwards");
      expect(await readFile(primaryPath(store, created.id))).toEqual(before);
      expect(await cancelText(store, created.id)).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
    expect((await store.get(created.id))?.status).toBe("queued");
    await lease.release();
  }, 20_000);

  test("a backup publication failure keeps the cancel generation and primary", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const before = await readFile(primaryPath(store, created.id));
    await mkdir(backupPath(store, created.id), { recursive: true, mode: 0o700 });

    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      await primarySha(store, created.id),
      request.generationSha256,
      new AbortController().signal,
      () => {},
    ));
    expect(error).toBeInstanceOf(Error);
    expect(await readFile(primaryPath(store, created.id))).toEqual(before);
    expect(await cancelText(store, created.id)).toBe(request.generation!);
    expect((await store.get(created.id))?.revision).toBe(created.revision);
    await lease.release();
  }, 20_000);

  test("failure after primary publication retains the checkpoint and the cancel marker", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const currentness = async (): Promise<void> => {
      const raw = await readFile(primaryPath(store, created.id), "utf8").catch(() => undefined);
      if (raw === undefined) return;
      if ((JSON.parse(raw) as { status?: unknown }).status === "interrupted") {
        throw new Error("host currentness closed after publication");
      }
    };
    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      await primarySha(store, created.id),
      request.generationSha256,
      new AbortController().signal,
      currentness,
    ));
    expect(error.message).toContain("after publication");

    const stored = await store.get(created.id);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.revision).toBe(created.revision + 1);
    expect(await cancelText(store, created.id)).toBe(request.generation!);
    const backup = JSON.parse(await readFile(backupPath(store, created.id), "utf8")) as RunRecord;
    expect(backup.status).toBe("queued");
    expect(backup.revision).toBe(created.revision);
    await lease.release();
  }, 20_000);

  test("a changed marker after publication fails the clear and is retained", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const replacement = `cancel:${randomUUID()}\n`;
    const currentness = async (): Promise<void> => {
      const raw = await readFile(primaryPath(store, created.id), "utf8").catch(() => undefined);
      if (raw === undefined) return;
      if ((JSON.parse(raw) as { status?: unknown }).status === "interrupted") {
        await writeFile(cancelPath(store, created.id), replacement, { mode: 0o600 });
      }
    };
    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      await primarySha(store, created.id),
      request.generationSha256,
      new AbortController().signal,
      currentness,
    ));
    expect(error).toBeInstanceOf(StoreConflictError);

    const stored = await store.get(created.id);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.revision).toBe(created.revision + 1);
    expect(await cancelText(store, created.id)).toBe(replacement);
    expect(await cancelText(store, created.id)).not.toBe(request.generation!);
    await lease.release();
  }, 20_000);

  test("a final post-consumption currentness failure reports actual partial state", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const request = await store.requestMarkedCancellation(created.id);
    if (request.generationSha256 === null) throw new Error("fixture generation missing");
    const currentness = async (): Promise<void> => {
      const raw = await readFile(primaryPath(store, created.id), "utf8").catch(() => undefined);
      if (raw === undefined) return;
      if ((JSON.parse(raw) as { status?: unknown }).status !== "interrupted") return;
      if (await cancelText(store, created.id) === undefined) {
        throw new Error("host currentness closed after consumption");
      }
    };
    const error = await rejection(store.commitRecoveryInterrupted(
      lease,
      created.id,
      created.revision,
      await primarySha(store, created.id),
      request.generationSha256,
      new AbortController().signal,
      currentness,
    ));
    expect(error.message).toContain("after consumption");
    const stored = await store.get(created.id);
    expect(stored?.status).toBe("interrupted");
    expect(stored?.revision).toBe(created.revision + 1);
    expect(await cancelText(store, created.id)).toBeUndefined();
    await lease.release();
  }, 20_000);

  test("the final seal runs only after the short write lock has fully released", async () => {
    const { store } = await makeStore();
    const created = await createMarked(store);
    const lease = await store.acquireWithContext(created.id);
    const expectedPrimary = await primarySha(store, created.id);
    const writeLock = writeLockPath(store, created.id);
    const originalNow = Date.now;
    const base = originalNow();
    let writeLockObserved = false;
    // Simulate an original deadline reached during the short-lock release:
    // the clock is valid while `.write.lock` exists and expired once the
    // helper has fully removed it. No fs function is replaced.
    Date.now = () => {
      if (existsSync(writeLock)) { writeLockObserved = true; return base; }
      return writeLockObserved ? base + 10_000_000 : base;
    };
    try {
      const error = await rejection(store.commitRecoveryInterrupted(
        lease,
        created.id,
        created.revision,
        expectedPrimary,
        null,
        new AbortController().signal,
        () => {},
      ));
      expect(error).toBeInstanceOf(StoreConflictError);
      expect(error.message).toContain("committed");
      expect(error.message).toContain("deadline");
      expect(writeLockObserved).toBe(true);
      expect(await exists(writeLock)).toBe(false);

      const stored = JSON.parse(await readFile(path.join(store.root, created.id, "run.json"), "utf8")) as RunRecord;
      expect(stored.status).toBe("interrupted");
      expect(stored.revision).toBe(created.revision + 1);
      expect(await exists(path.join(store.root, created.id, "cancel.request"))).toBe(false);
      await lease.assertCurrent();
    } finally {
      Date.now = originalNow;
      await lease.release();
    }
  }, 20_000);
});

describe("R2-C1a Controller continuation closure", () => {
  test("initial marked create/execute still uses the original path", async () => {
    const fixture = await makeGitController();
    const created = await createMarkedController(fixture.controller);
    expect(created.recoveryOrigin).toBeDefined();
    const executed = await fixture.controller.execute(created.id);
    expect(executed.status).toBe("completed");
    expect(fixture.calls.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);

    const repeated = await fixture.controller.execute(created.id);
    expect(repeated.status).toBe("completed");
    expect(fixture.calls).toHaveLength(3);
  }, 30_000);

  test("marked resume and noninitial execute launch zero workers and mutate no record", async () => {
    const fixture = await makeController();
    const created = await createMarkedController(fixture.controller);
    await fixture.controller.cancel(created.id);
    const marker = await readFile(cancelPath(fixture.store, created.id));
    const before = await readFile(primaryPath(fixture.store, created.id));

    const resumed = await rejection(fixture.controller.resume(created.id));
    expect(resumed.message).toMatch(/guarded continuation|marked recovery/i);
    expect(await readFile(cancelPath(fixture.store, created.id))).toEqual(marker);
    expect(await readFile(primaryPath(fixture.store, created.id))).toEqual(before);
    expect(fixture.calls).toHaveLength(0);

    const extraArgs = (fixture.controller.resume as unknown as (...args: unknown[]) => Promise<unknown>)
      .call(fixture.controller, created.id, "extra", { ignored: true });
    expect((await rejection(extraArgs)).message).toMatch(/guarded continuation|marked recovery/i);
    expect(fixture.calls).toHaveLength(0);

    const failed = await createMarkedController(fixture.controller);
    const stored = await fixture.controller.get(failed.id);
    if (stored === undefined) throw new Error("fixture run missing");
    await fixture.store.save({ ...stored, status: "failed" }, stored.revision);
    const failedMarker = await fixture.store.requestMarkedCancellation(failed.id);
    const failedBefore = await readFile(primaryPath(fixture.store, failed.id));
    const executed = await rejection(fixture.controller.execute(failed.id));
    expect(executed.message).toMatch(/initial record|guarded continuation/i);
    expect(await readFile(primaryPath(fixture.store, failed.id))).toEqual(failedBefore);
    expect(await cancelText(fixture.store, failed.id)).toBe(failedMarker.generation!);
    expect(fixture.calls).toHaveLength(0);

    const queuedHistory = await createMarkedController(fixture.controller);
    const historyRecord = await fixture.controller.get(queuedHistory.id);
    if (historyRecord === undefined) throw new Error("fixture run missing");
    await fixture.store.save({ ...historyRecord }, historyRecord.revision);
    const historyMarker = await fixture.store.requestMarkedCancellation(queuedHistory.id);
    const queuedError = await rejection(fixture.controller.execute(queuedHistory.id));
    expect(queuedError.message).toMatch(/initial record|guarded continuation/i);
    expect(await cancelText(fixture.store, queuedHistory.id)).toBe(historyMarker.generation!);
    expect(fixture.calls).toHaveLength(0);

    const cancelled = await createMarkedController(fixture.controller);
    const cancelledRecord = await fixture.controller.get(cancelled.id);
    if (cancelledRecord === undefined) throw new Error("fixture run missing");
    await fixture.store.save({ ...cancelledRecord, status: "cancelled" }, cancelledRecord.revision);
    await fixture.controller.cancel(cancelled.id);
    const cancelledMarker = await readFile(cancelPath(fixture.store, cancelled.id));
    const cancelledBefore = await readFile(primaryPath(fixture.store, cancelled.id));
    const cancelledError = await rejection(fixture.controller.execute(cancelled.id));
    expect(cancelledError.message).toMatch(/initial record|guarded continuation/i);
    expect(await readFile(primaryPath(fixture.store, cancelled.id))).toEqual(cancelledBefore);
    expect(await readFile(cancelPath(fixture.store, cancelled.id))).toEqual(cancelledMarker);
    expect(fixture.calls).toHaveLength(0);
  }, 30_000);

  test("unmarked cancel/resume retains the original legacy path", async () => {
    const fixture = await makeGitController();
    const options: Partial<RunConfig> & { model: string } = {
      model: MODEL,
      maxCostUsd: 0.5,
      maxDurationMs: 120_000,
    };
    const created = await fixture.controller.create("legacy unmarked task", options);
    expect(created.recoveryOrigin).toBeUndefined();
    await fixture.controller.cancel(created.id);
    expect(await readFile(cancelPath(fixture.store, created.id), "utf8")).toBe("cancel\n");
    await fixture.controller.cancel(created.id);
    expect(await readFile(cancelPath(fixture.store, created.id), "utf8")).toBe("cancel\n");

    const resumed = await fixture.controller.resume(created.id);
    expect(resumed.status).toBe("completed");
    expect(await exists(cancelPath(fixture.store, created.id))).toBe(false);
    expect(fixture.calls.map((request) => request.stage)).toEqual(["plan", "baseline", "select"]);
  }, 30_000);
});
