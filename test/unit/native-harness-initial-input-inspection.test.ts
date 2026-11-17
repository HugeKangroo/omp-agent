import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeHarnessBackend,
  type NativeHarnessBackendHostConfig,
  type NativeHarnessExistingInspectionControl,
  type NativeHarnessExistingInspectionTarget,
} from "../../src/native-harness-backend.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  createNativeHarnessAccountingOwner,
} from "../../src/native-harness-accounting.ts";
import { NATIVE_HARNESS_COMPLETION_SOURCE_ID } from "../../src/native-harness-completion.ts";
import { openNativeHarnessDispatchInventory } from "../../src/native-harness-dispatch-inventory.ts";
import {
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES,
  planNativeHarnessInitialInputs,
  type NativeHarnessInitialInputsPlanResult,
} from "../../src/native-harness-reconciliation-content.ts";
import {
  observeNativeHarnessInitialInputsBytes,
  type NativeHarnessInitialInputsByteResult,
  type NativeHarnessReconciliationContentByteControls,
} from "../../src/native-harness-output.ts";
import { observeNativeHarnessReconciliation } from "../../src/native-harness-reconciliation-files.ts";
import type { NativeHarnessReconciliationExpectation } from "../../src/native-harness-reconciliation.ts";
import { NATIVE_HARNESS_RECOVERY_SOURCE_FILE } from "../../src/native-harness-recovery-source.ts";
import { nodeFileIo, type NativeFileHandle, type NativeFileIo } from "../../src/native-work.ts";
import type { NativeContext } from "../../src/native-entry.ts";
import type { NativeHarnessPrepareRequest } from "../../src/native-harness-delegation.ts";
import type { Runner } from "../../vendor/harness2/index.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import { captureSnapshot } from "../../vendor/harness2/upstream/src/workspace.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const SELECTOR = "a".repeat(64);
const MODEL = "deepseek/deepseek-flash";
const MAX_DURATION_MS = 120_000;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function limitsText(): string {
  return JSON.stringify({
    maxRetainedOperations: 16,
    maxConcurrent: 1,
    perRunUsd: 1,
    lifetimeUsd: 5,
    maxDurationMs: MAX_DURATION_MS,
    cleanupGraceMs: 40,
  });
}

function transition(action: Record<string, unknown>): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    ...action,
  });
}

function contextFor(cwd: string): NativeContext {
  return {
    cwd,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "r2c1b2-session",
      getCwd: () => cwd,
    },
  };
}

interface FileSpec {
  readonly path: string;
  readonly bytes: Buffer;
}

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly hostConfig: NativeHarnessBackendHostConfig;
  readonly factory: ReturnType<typeof createNativeHarnessBackend>;
  readonly preparedRoot: string;
  readonly preparedRelativeRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly runDir: string;
  readonly runPath: string;
  readonly sourcePath: string;
  readonly inventoryPath: string;
  readonly ownerPath: string;
  readonly target: NativeHarnessExistingInspectionTarget;
  readonly context: NativeContext;
  readonly expected: NativeHarnessReconciliationExpectation;
  readonly clock: { value: number };
  readonly runnerCalls: { count: number };
  readonly fileSpecs: readonly FileSpec[];
}

async function fixtureNamed(files?: readonly FileSpec[]): Promise<Fixture> {
  const fileSpecs = files ?? [{
    path: "input.txt",
    bytes: Buffer.from("bounded initial prepared input\n", "utf8"),
  }];
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2c1b2-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  for (const spec of fileSpecs) {
    const destination = path.join(sourceRoot, ...spec.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, spec.bytes, { mode: 0o600 });
  }

  const clock = { value: Date.now() };
  const runnerCalls = { count: 0 };
  const runner: Runner = {
    async run(): Promise<never> {
      runnerCalls.count += 1;
      throw new Error("initial-input inspection must not dispatch a runner");
    },
  };
  const hostConfig: NativeHarnessBackendHostConfig = {
    model: MODEL,
    ompCommand: "/usr/bin/fake-omp",
    storageRoot,
    inputFiles: fileSpecs.map((spec) => spec.path),
  };
  const factory = createNativeHarnessBackend(hostConfig, {
    deterministicRunner: runner,
    now: () => clock.value,
  });
  const admittedAt = clock.value - 1_000;
  const association = {
    observationId: "r2c1b2-observation",
    generation: 1,
    sessionId: "r2c1b2-session",
    workspaceRoot: sourceRoot,
    toolCallId: "r2c1b2-call",
    toolName: "agent_harness" as const,
  };
  const associationSha256 = sha256(JSON.stringify({
    observationId: association.observationId,
    generation: association.generation,
    sessionId: association.sessionId,
    workspaceRoot: association.workspaceRoot,
    toolCallId: association.toolCallId,
    toolName: association.toolName,
  }));
  const request: NativeHarnessPrepareRequest = Object.freeze({
    association: Object.freeze(association),
    accounting: Object.freeze({
      ownerId: OWNER_ID,
      admissionId: ADMISSION_ID,
      reserveRevision: 1,
      sourceAssociationSha256: associationSha256,
      admittedAt,
    }),
    budget: Object.freeze({
      maxCostUsd: 1,
      deadlineAt: admittedAt + MAX_DURATION_MS,
      maxDurationMs: MAX_DURATION_MS,
    }),
    signal: new AbortController().signal,
    runner,
    guard: () => undefined,
  });
  const prepared = await factory.prepare(request, contextFor(sourceRoot));
  if (!prepared.ok) throw new Error(`durable fixture preparation failed: ${prepared.reason}`);
  if (prepared.accountingPrepared === undefined) throw new Error("durable fixture produced no accounting facts");
  const created = await prepared.backend.create("bounded initial prepared input fixture task") as { runId?: unknown };
  if (typeof created.runId !== "string") throw new Error("durable fixture created no run id");
  const runId = created.runId;
  const preparedRelativeRoot = prepared.accountingPrepared.preparedRelativeRoot;
  const preparedRoot = path.join(storageRoot, preparedRelativeRoot);
  const workspaceRoot = path.join(preparedRoot, "workspace");
  const store = new RunStore(path.join(preparedRoot, "store", "runs"));

  const owner = await createNativeHarnessAccountingOwner({
    storageRoot,
    selectorSha256: SELECTOR,
    ownerId: OWNER_ID,
    createdAt: admittedAt,
    limitsText: limitsText(),
  });
  try {
    await owner.commit(owner.snapshot().revision, transition({
      action: "reserve",
      admissionId: ADMISSION_ID,
      sourceAssociationSha256: associationSha256,
      admittedAt,
      deadlineAt: admittedAt + MAX_DURATION_MS,
      allocatedUsd: 1,
      reserveRevision: 1,
    }));
    await owner.commit(owner.snapshot().revision, transition({
      action: "bindPrepared",
      admissionId: ADMISSION_ID,
      prepared: prepared.accountingPrepared,
    }));
    await owner.commit(owner.snapshot().revision, transition({
      action: "bindRun",
      admissionId: ADMISSION_ID,
      runId,
    }));
  } finally {
    owner.close();
  }

  const runDir = store.runDir(runId);
  const expected = Object.freeze({
    runId,
    ownerId: OWNER_ID,
    selectorSha256: SELECTOR,
    storageRoot,
    sourceRoot,
    preparedRelativeRoot,
    backendBuildSourceId: NATIVE_HARNESS_COMPLETION_SOURCE_ID,
  });
  return {
    root,
    sourceRoot,
    storageRoot,
    hostConfig,
    factory,
    preparedRoot,
    preparedRelativeRoot,
    workspaceRoot,
    runId,
    store,
    runDir,
    runPath: path.join(runDir, "run.json"),
    sourcePath: path.join(preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE),
    inventoryPath: path.join(runDir, "dispatch-inventory.json"),
    ownerPath: path.join(storageRoot, "accounting-owners", SELECTOR, "owner.json"),
    target: {
      runId,
      ownerId: OWNER_ID,
      selectorSha256: SELECTOR,
      preparedRelativeRoot,
    },
    context: contextFor(sourceRoot),
    expected,
    clock,
    runnerCalls,
    fileSpecs,
  };
}

function controlFor(
  signal: AbortSignal = new AbortController().signal,
  guard: () => void = () => undefined,
): NativeHarnessExistingInspectionControl {
  return { signal, guard };
}

async function readTexts(fixture: Fixture): Promise<{
  runText: string;
  sourceText: string;
  inventoryText: string;
  ownerText: string;
}> {
  return {
    runText: await readFile(fixture.runPath, "utf8"),
    sourceText: await readFile(fixture.sourcePath, "utf8"),
    inventoryText: await readFile(fixture.inventoryPath, "utf8"),
    ownerText: await readFile(fixture.ownerPath, "utf8"),
  };
}

async function initialPlan(fixture: Fixture): Promise<NativeHarnessInitialInputsPlanResult> {
  const texts = await readTexts(fixture);
  return planNativeHarnessInitialInputs({
    ...texts,
    expected: fixture.expected,
    now: fixture.clock.value,
  });
}

function countingIo(opens: string[]): NativeFileIo {
  return {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: (target) => nodeFileIo.realpath(target),
    lstat: (target, options) => nodeFileIo.lstat(target, options),
    open: (target, flags) => {
      opens.push(target);
      return nodeFileIo.open(target, flags);
    },
  };
}

function controlsFor(
  io: NativeFileIo,
  overrides: Partial<NativeHarnessReconciliationContentByteControls> = {},
): NativeHarnessReconciliationContentByteControls {
  return {
    guard: () => undefined,
    signal: new AbortController().signal,
    chargeLimitBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
    fileIo: io,
    ...overrides,
  };
}

async function observeInitial(
  fixture: Fixture,
  io: NativeFileIo = nodeFileIo,
): Promise<NativeHarnessInitialInputsByteResult> {
  const planned = await initialPlan(fixture);
  if (planned.status !== "planned") throw new Error(`fixture initial plan is ${planned.status}`);
  return observeNativeHarnessInitialInputsBytes(planned.plan, controlsFor(io));
}

async function snapshotPrimary(fixture: Fixture): Promise<{
  readonly run: string;
  readonly source: string;
  readonly inventory: string;
  readonly owner: string;
  readonly revision: number;
}> {
  const record = await fixture.store.get(fixture.runId);
  if (record === undefined) throw new Error("fixture run disappeared");
  return {
    run: (await readFile(fixture.runPath)).toString("base64"),
    source: (await readFile(fixture.sourcePath)).toString("base64"),
    inventory: (await readFile(fixture.inventoryPath)).toString("base64"),
    owner: (await readFile(fixture.ownerPath)).toString("base64"),
    revision: record.revision,
  };
}

async function assertPrimaryUnchanged(
  fixture: Fixture,
  before: Awaited<ReturnType<typeof snapshotPrimary>>,
): Promise<void> {
  expect(await snapshotPrimary(fixture)).toEqual(before);
}

async function assertLeaseFree(fixture: Fixture): Promise<void> {
  const release = await fixture.store.acquire(fixture.runId);
  await release();
}

function preparedInputPath(fixture: Fixture, relativePath: string): string {
  return path.join(fixture.workspaceRoot, ...relativePath.split("/"));
}

describe("R2-C1b2 actual initial prepared-input inspection", () => {
  test("plans and reads one real source/prepared input twice with .git excluded", async () => {
    const fixture = await fixtureNamed();
    const before = await snapshotPrimary(fixture);
    const planned = await initialPlan(fixture);
    expect(planned.status).toBe("planned");
    if (planned.status !== "planned") throw new Error(planned.reasons.join(","));
    expect(planned.plan.schema).toBe("omp-agent.native-harness-initial-prepared-inputs-plan.v1");
    expect(planned.plan.sources.length).toBe(1);
    expect(planned.plan.excluded).toEqual({
      path: ".git",
      kind: "directory",
      contents: "not-enumerated-not-hashed",
      git: "not-started",
    });
    expect(Object.isFrozen(planned.plan)).toBe(true);

    const opens: string[] = [];
    const result = await observeNativeHarnessInitialInputsBytes(
      planned.plan,
      controlsFor(countingIo(opens)),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    const observation = result.observation;
    expect(observation.status).toBe("stable");
    expect(observation.observation).toBe("two-pass");
    expect(observation.passes).toBe(2);
    expect(observation.captureStarts).toBe(4);
    expect(observation.chargedBytes).toBe(fixture.fileSpecs[0]!.bytes.length * 4);
    expect(observation.chargeLimitBytes).toBe(NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES);
    expect(observation.openedFiles).toBe(4);
    expect(observation.maxConcurrentOpenedFiles).toBe(1);
    expect(observation.close).toEqual({ attempted: 4, settled: 4, succeeded: 4 });
    expect(observation.source.files.map((file) => file.path)).toEqual(["input.txt"]);
    expect(observation.prepared.files.map((file) => file.path)).toEqual(["input.txt"]);
    expect(observation.prepared.files[0]!.mode).toBe(0o600);
    expect(observation.prepared.excluded.contents).toBe("not-enumerated-not-hashed");
    expect(observation.prepared.excluded.identity).toBe("pinned-before-between-after");

    const sourcePath = path.join(fixture.sourceRoot, "input.txt");
    const preparedPath = preparedInputPath(fixture, "input.txt");
    expect(opens.filter((target) => target === sourcePath).length).toBe(2);
    expect(opens.filter((target) => target === preparedPath).length).toBe(2);
    expect(opens.some((target) => target.startsWith(path.join(fixture.workspaceRoot, ".git") + path.sep)))
      .toBe(false);
    expect(fixture.runnerCalls.count).toBe(0);
    await assertPrimaryUnchanged(fixture, before);

    const inspected = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(),
    );
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) throw new Error(inspected.reason);
    const axis = inspected.diagnostic.observation.initialInputs;
    expect(axis?.status).toBe("stable");
    expect(axis?.observation?.captureStarts).toBe(4);
    expect(axis?.readOnly).toBe(true);
    expect(axis?.resumeAvailable).toBe(false);
    expect(axis?.semanticAcceptance).toBe("not-evaluated");
    expect(inspected.diagnostic.observation.content.status).toBe("not-required");
    expect(fixture.runnerCalls.count).toBe(0);
    await assertLeaseFree(fixture);
  });

  test("reads the actual eight-file 256 KiB total boundary with 32 capture starts", async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `inputs/${index + 1}.txt`,
      bytes: Buffer.alloc(32 * 1024, 65 + index),
    }));
    expect(files.reduce((sum, file) => sum + file.bytes.length, 0))
      .toBe(NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES);
    const fixture = await fixtureNamed(files);
    const result = await observeInitial(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
    expect(result.observation.passes).toBe(2);
    expect(result.observation.captureStarts).toBe(32);
    expect(result.observation.chargedBytes).toBe(4 * NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES);
    expect(result.observation.source.totalBytes).toBe(NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES);
    expect(result.observation.prepared.totalBytes).toBe(NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES);
    expect(result.observation.prepared.files.length).toBe(8);
    expect(fixture.runnerCalls.count).toBe(0);
  });

  test("default off adds no initial axis and reads no input bytes", async () => {
    const fixture = await fixtureNamed();
    const opens: string[] = [];
    const result = await observeNativeHarnessReconciliation(fixture.expected, {
      signal: new AbortController().signal,
      now: () => fixture.clock.value,
      fileIo: countingIo(opens),
    });
    expect(Object.hasOwn(result, "initialInputs")).toBe(false);
    expect(result.content.status).toBe("not-required");
    const sourcePath = path.join(fixture.sourceRoot, "input.txt");
    const preparedPath = preparedInputPath(fixture, "input.txt");
    expect(opens).not.toContain(sourcePath);
    expect(opens).not.toContain(preparedPath);
    expect(fixture.runnerCalls.count).toBe(0);
  });

  test("an actual snapshot keeps the old content path and marks initial not-applicable", async () => {
    const fixture = await fixtureNamed();
    const record = await fixture.store.get(fixture.runId);
    if (record === undefined) throw new Error("fixture run disappeared");
    const snapshot = captureSnapshot(
      fixture.workspaceRoot,
      path.join(fixture.runDir, `snapshot-${randomUUID()}`),
    );
    await fixture.store.save({ ...record, snapshot }, record.revision);

    const opens: string[] = [];
    const result = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(new AbortController().signal, () => undefined),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const observation = result.diagnostic.observation;
    expect(observation.initialInputs?.status).toBe("not-applicable");
    expect(observation.initialInputs?.observation).toBeNull();
    expect(observation.content.status).toBe("stable");
    expect(observation.content.observation).not.toBeNull();
    expect(fixture.runnerCalls.count).toBe(0);
    await assertLeaseFree(fixture);
  });

  test("missing snapshot with a stage or dispatch refuses the initial axis", async () => {
    const fixture = await fixtureNamed();
    const record = await fixture.store.get(fixture.runId);
    if (record === undefined) throw new Error("fixture run disappeared");
    const startedAt = new Date(Date.parse(record.createdAt) + 1_000).toISOString();
    const stage = {
      id: "baseline" as const,
      status: "running" as const,
      attempt: 1,
      cwd: path.join(fixture.runDir, "stages", "baseline", `attempt-1-${randomUUID()}`, "workspace"),
      startedAt,
    };
    await fixture.store.save({
      ...record,
      updatedAt: startedAt,
      stages: { ...record.stages, baseline: stage },
    }, record.revision);
    const stagePlan = await initialPlan(fixture);
    expect(stagePlan.status).toBe("unavailable");
    if (stagePlan.status === "unavailable") {
      expect(stagePlan.reasons.length).toBeGreaterThan(0);
    }

    const dispatchFixture = await fixtureNamed();
    const dispatchRecord = await dispatchFixture.store.get(dispatchFixture.runId);
    if (dispatchRecord === undefined) throw new Error("dispatch fixture run disappeared");
    const inventory = await openNativeHarnessDispatchInventory({
      storeRoot: dispatchFixture.store.root,
      runId: dispatchFixture.runId,
    });
    try {
      const attemptDir = path.join(
        dispatchFixture.runDir,
        "stages",
        "baseline",
        `attempt-1-${randomUUID()}`,
      );
      await inventory.intend({
        ordinal: 1,
        nonce: randomUUID(),
        stage: "baseline",
        attempt: 1,
        runRevision: dispatchRecord.revision,
        cwd: path.join(attemptDir, "workspace"),
        artifactDir: path.join(attemptDir, "artifacts"),
        intentSha256: "a".repeat(64),
        snapshotSha256: "b".repeat(64),
        innerDeadlineAt: Date.parse(dispatchRecord.createdAt) + 1_000,
        requestTimeoutMs: 1_000,
        stageAllocatedCostUsd: 0.1,
      }, () => undefined);
    } finally {
      inventory.close();
    }
    const dispatchPlan = await initialPlan(dispatchFixture);
    expect(dispatchPlan.status).toBe("unavailable");
    if (dispatchPlan.status === "unavailable") {
      expect(dispatchPlan.reasons.length).toBeGreaterThan(0);
    }
    expect(dispatchFixture.runnerCalls.count).toBe(0);
  });

  test("source and prepared same-length tamper, missing and extra files refuse", async () => {
    const sourceTamper = await fixtureNamed();
    const sourceBytes = sourceTamper.fileSpecs[0]!.bytes;
    await writeFile(
      path.join(sourceTamper.sourceRoot, "input.txt"),
      Buffer.concat([Buffer.from("X"), sourceBytes.subarray(1)]),
      { mode: 0o600 },
    );
    const sourceResult = await observeInitial(sourceTamper);
    expect(sourceResult.ok).toBe(false);
    if (!sourceResult.ok) {
      expect(sourceResult.code).toBe("changed");
      expect(sourceResult.observedMismatch).toBe(true);
      expect(sourceResult.captureStarts).toBe(1);
    }

    const preparedTamper = await fixtureNamed();
    const preparedBytes = preparedTamper.fileSpecs[0]!.bytes;
    await writeFile(
      preparedInputPath(preparedTamper, "input.txt"),
      Buffer.concat([Buffer.from("Y"), preparedBytes.subarray(1)]),
      { mode: 0o600 },
    );
    const preparedResult = await observeInitial(preparedTamper);
    expect(preparedResult.ok).toBe(false);
    if (!preparedResult.ok) {
      expect(preparedResult.code).toBe("changed");
      expect(preparedResult.observedMismatch).toBe(true);
      expect(preparedResult.captureStarts).toBe(2);
    }

    const preparedMissing = await fixtureNamed();
    await unlink(preparedInputPath(preparedMissing, "input.txt"));
    const missingResult = await observeInitial(preparedMissing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.observedMismatch).toBe(true);

    const preparedExtra = await fixtureNamed();
    await writeFile(preparedInputPath(preparedExtra, "extra.txt"), "extra\n", { mode: 0o600 });
    const extraResult = await observeInitial(preparedExtra);
    expect(extraResult.ok).toBe(false);
    if (!extraResult.ok) expect(extraResult.observedMismatch).toBe(true);

    const sourceMissing = await fixtureNamed();
    await unlink(path.join(sourceMissing.sourceRoot, "input.txt"));
    const sourceMissingResult = await observeInitial(sourceMissing);
    expect(sourceMissingResult.ok).toBe(false);
    if (!sourceMissingResult.ok) expect(sourceMissingResult.code).toBe("missing");
  });

  test(".git must be the real top-level directory; missing, file, link and special refuse", async () => {
    const fixture = await fixtureNamed();
    const git = path.join(fixture.workspaceRoot, ".git");
    const saved = path.join(fixture.root, "git-saved");
    await rename(git, saved);

    const missing = await observeInitial(fixture);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("missing");
      expect(missing.observedMismatch).toBe(true);
    }

    await writeFile(git, "not a git directory\n", { mode: 0o600 });
    const file = await observeInitial(fixture);
    expect(file.ok).toBe(false);
    if (!file.ok) {
      expect(file.code).toBe("unsupported");
      expect(file.observedMismatch).toBe(true);
    }
    await unlink(git);

    const target = path.join(fixture.root, "git-target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, git);
    const link = await observeInitial(fixture);
    expect(link.ok).toBe(false);
    if (!link.ok) {
      expect(link.code).toBe("unsafe-path");
      expect(link.observedMismatch).toBe(true);
    }
    await unlink(git);

    execFileSync("mkfifo", [git]);
    const special = await observeInitial(fixture);
    expect(special.ok).toBe(false);
    if (!special.ok) {
      expect(special.code).toBe("unsupported");
      expect(special.observedMismatch).toBe(true);
    }
    await unlink(git);
    expect(await exists(git)).toBe(false);
    expect(await exists(saved)).toBe(true);
  });

  test("a same-length source change between passes cannot produce a stable initial axis", async () => {
    const fixture = await fixtureNamed();
    const sourcePath = path.join(fixture.sourceRoot, "input.txt");
    const original = fixture.fileSpecs[0]!.bytes;
    let sourceOpens = 0;
    const io: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        if (target === sourcePath) {
          sourceOpens += 1;
          if (sourceOpens === 2) {
            await writeFile(
              target,
              Buffer.concat([Buffer.from("Z"), original.subarray(1)]),
              { mode: 0o600 },
            );
          }
        }
        return nodeFileIo.open(target, flags);
      },
    };
    const result = await observeInitial(fixture, io);
    expect(sourceOpens).toBe(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("changed");
      expect(result.captureStarts).toBe(3);
      expect(result.passesStarted).toBe(2);
      expect(result.close.attempted).toBeGreaterThan(0);
    }
  });

  test("opened-size growth beyond the pre-open lstat refuses per-file and aggregate", async () => {
    const small = await fixtureNamed();
    const prepared = preparedInputPath(small, "input.txt");
    let opens = 0;
    const growthIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        if (target === prepared) {
          opens += 1;
          if (opens === 1) {
            await writeFile(target, Buffer.alloc(262_145, 66), { mode: 0o600 });
          }
        }
        return nodeFileIo.open(target, flags);
      },
    };
    const perFile = await observeInitial(small, growthIo);
    expect(perFile.ok).toBe(false);
    if (!perFile.ok) {
      expect(perFile.code).toBe("too-large");
      expect(perFile.chargedBytes).toBeLessThanOrEqual(NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES);
    }
    expect(opens).toBe(1);

    const boundary = await fixtureNamed([
      { path: "a.txt", bytes: Buffer.alloc(131_072, 65) },
      { path: "b.txt", bytes: Buffer.alloc(131_072, 66) },
    ]);
    const secondPrepared = preparedInputPath(boundary, "b.txt");
    let secondOpens = 0;
    const totalIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        if (target === secondPrepared) {
          secondOpens += 1;
          if (secondOpens === 1) {
            await writeFile(target, Buffer.alloc(131_073, 67), { mode: 0o600 });
          }
        }
        return nodeFileIo.open(target, flags);
      },
    };
    const aggregate = await observeInitial(boundary, totalIo);
    expect(aggregate.ok).toBe(false);
    if (!aggregate.ok) {
      expect(aggregate.code).toBe("too-large");
      expect(aggregate.chargedBytes).toBeLessThanOrEqual(NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES);
    }
    expect(secondOpens).toBe(1);
  });

  test("final primary change revokes a stable initial observation but retains counters", async () => {
    const fixture = await fixtureNamed();
    let runOpens = 0;
    const io: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        if (target === fixture.runPath) {
          runOpens += 1;
          if (runOpens === 2) {
            const raw = await readFile(target, "utf8");
            await writeFile(target, `${raw} `, { mode: 0o600 });
          }
        }
        return nodeFileIo.open(target, flags);
      },
    };
    const result = await observeNativeHarnessReconciliation(fixture.expected, {
      signal: new AbortController().signal,
      now: () => fixture.clock.value,
      verifyInitialPreparedInputs: true,
      fileIo: io,
    });
    expect(result.status).not.toBe("stable");
    expect(result.initialInputs?.status).toBe("revoked");
    expect(result.initialInputs?.provisionalStatus).toBe("stable");
    expect(result.initialInputs?.revoked).toBe(true);
    expect(result.initialInputs?.observation).toBeNull();
    expect(result.initialInputs?.chargedBytes).toBeGreaterThan(0);
    expect(result.initialInputs?.close.attempted).toBeGreaterThan(0);
    expect(runOpens).toBeGreaterThanOrEqual(2);
  });

  test("abort, last input close expiry and close failure cannot leave an initial stable proof", async () => {
    const aborted = await fixtureNamed();
    const controller = new AbortController();
    const prepared = preparedInputPath(aborted, "input.txt");
    let abortOnce = true;
    const abortIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        if (target === prepared && abortOnce) {
          abortOnce = false;
          controller.abort();
        }
        return nodeFileIo.open(target, flags);
      },
    };
    const abortedResult = await observeNativeHarnessReconciliation(aborted.expected, {
      signal: controller.signal,
      now: () => aborted.clock.value,
      verifyInitialPreparedInputs: true,
      fileIo: abortIo,
    });
    expect(abortedResult.initialInputs?.status).toBe("aborted");
    expect(abortedResult.initialInputs?.observation).toBeNull();

    const expired = await fixtureNamed();
    const inputPaths = new Set([
      path.join(expired.sourceRoot, "input.txt"),
      preparedInputPath(expired, "input.txt"),
    ]);
    let inputCloses = 0;
    const expiryIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        const handle = await nodeFileIo.open(target, flags);
        let closed = false;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            if (!closed) {
              closed = true;
              if (inputPaths.has(target)) {
                inputCloses += 1;
                if (inputCloses === 4) expired.clock.value += 60_000;
              }
            }
            await handle.close();
          },
        };
      },
    };
    const expiredResult = await observeNativeHarnessReconciliation(expired.expected, {
      signal: new AbortController().signal,
      now: () => expired.clock.value,
      verifyInitialPreparedInputs: true,
      fileIo: expiryIo,
    });
    expect(inputCloses).toBe(4);
    expect(expiredResult.initialInputs?.status).toBe("expired");
    expect(expiredResult.initialInputs?.observation).toBeNull();

    const closeFailure = await fixtureNamed();
    const closePath = preparedInputPath(closeFailure, "input.txt");
    let failedOnce = false;
    const closeIo: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        const handle = await nodeFileIo.open(target, flags);
        let closed = false;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            if (!closed) {
              closed = true;
              await handle.close();
              if (target === closePath && !failedOnce) {
                failedOnce = true;
                throw new Error("fixture input close failure");
              }
              return;
            }
            await handle.close();
          },
        };
      },
    };
    const closeResult = await observeNativeHarnessReconciliation(closeFailure.expected, {
      signal: new AbortController().signal,
      now: () => closeFailure.clock.value,
      verifyInitialPreparedInputs: true,
      fileIo: closeIo,
    });
    expect(failedOnce).toBe(true);
    expect(closeResult.initialInputs?.status).not.toBe("stable");
    expect(closeResult.initialInputs?.observation).toBeNull();
    expect(closeResult.initialInputs?.failure?.code).toBe("io-failure");
    expect(closeResult.initialInputs?.close.attempted).toBeGreaterThan(0);
    expect(closeResult.initialInputs?.close.succeeded)
      .toBeLessThan(closeResult.initialInputs?.close.attempted ?? 0);
  });

  test("plan and control accessors are never invoked, and caller mutation cannot retarget", async () => {
    const fixture = await fixtureNamed();
    const planned = await initialPlan(fixture);
    if (planned.status !== "planned") throw new Error("fixture initial plan is not planned");

    let planGetterCalls = 0;
    const getterPlan = { ...planned.plan } as Record<string, unknown>;
    Object.defineProperty(getterPlan, "storageRoot", {
      enumerable: true,
      get() {
        planGetterCalls += 1;
        return planned.plan.storageRoot;
      },
    });
    const opens: string[] = [];
    const getterResult = await observeNativeHarnessInitialInputsBytes(
      getterPlan as unknown as typeof planned.plan,
      controlsFor(countingIo(opens)),
    );
    expect(getterResult.ok).toBe(false);
    if (!getterResult.ok) expect(getterResult.code).toBe("source-unavailable");
    expect(planGetterCalls).toBe(0);
    expect(opens.length).toBe(0);

    let ioGetterCalls = 0;
    const controlWithGetter = {
      guard: () => undefined,
      signal: new AbortController().signal,
      chargeLimitBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
      get fileIo() {
        ioGetterCalls += 1;
        return nodeFileIo;
      },
    } as unknown as NativeHarnessReconciliationContentByteControls;
    const controlGetterResult = await observeNativeHarnessInitialInputsBytes(planned.plan, controlWithGetter);
    expect(controlGetterResult.ok).toBe(false);
    if (!controlGetterResult.ok) expect(controlGetterResult.code).toBe("invalid-control");
    expect(ioGetterCalls).toBe(0);

    const mutableControls: {
      guard: () => void;
      signal: AbortSignal;
      chargeLimitBytes: number;
      fileIo: NativeFileIo;
    } = {
      guard: () => undefined,
      signal: new AbortController().signal,
      chargeLimitBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
      fileIo: nodeFileIo,
    };
    const pending = observeNativeHarnessInitialInputsBytes(planned.plan, mutableControls);
    const replacement = new AbortController();
    replacement.abort();
    mutableControls.guard = () => {
      throw new Error("replacement guard must not be used");
    };
    mutableControls.signal = replacement.signal;
    mutableControls.chargeLimitBytes = 0;
    mutableControls.fileIo = {
      ...nodeFileIo,
      open: async () => {
        throw new Error("replacement IO must not be used");
      },
    };
    const stable = await pending;
    expect(stable.ok).toBe(true);
    if (stable.ok) expect(stable.observation.status).toBe("stable");
  });

  test("a first input close rejection without a real close halts every later open", async () => {
    const fixture = await fixtureNamed([
      { path: "a.txt", bytes: Buffer.from("alpha input\n", "utf8") },
      { path: "b.txt", bytes: Buffer.from("beta input\n", "utf8") },
    ]);
    const before = await snapshotPrimary(fixture);
    const sourceBefore = await Promise.all(fixture.fileSpecs.map((spec) =>
      readFile(path.join(fixture.sourceRoot, ...spec.path.split("/")))));
    const inputPaths = new Set(fixture.fileSpecs.flatMap((spec) => [
      path.join(fixture.sourceRoot, ...spec.path.split("/")),
      preparedInputPath(fixture, spec.path),
    ]));
    const primaryPaths = new Set([
      fixture.runPath,
      fixture.sourcePath,
      fixture.inventoryPath,
      fixture.ownerPath,
    ]);
    type Category = "input" | "primary" | "aux";
    interface Entry {
      readonly path: string;
      readonly category: Category;
      readonly afterFailure: boolean;
      closed: boolean;
    }
    const entries: Entry[] = [];
    const retained: Array<{ readonly handle: NativeFileHandle; readonly entry: Entry }> = [];
    let active = 0;
    let maxActive = 0;
    let injected = false;
    const io: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: (target, options) => nodeFileIo.lstat(target, options),
      open: async (target, flags) => {
        const handle = await nodeFileIo.open(target, flags);
        const category: Category = inputPaths.has(target)
          ? "input"
          : primaryPaths.has(target) ? "primary" : "aux";
        const entry: Entry = { path: target, category, afterFailure: injected, closed: false };
        entries.push(entry);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            if (!injected && category === "input") {
              injected = true;
              retained.push({ handle, entry });
              throw new Error("fixture: the real input descriptor intentionally remains open");
            }
            await handle.close();
            if (!entry.closed) {
              entry.closed = true;
              active -= 1;
            }
          },
        };
      },
    };
    const backend = createNativeHarnessBackend(fixture.hostConfig, {
      deterministicRunner: {
        async run(): Promise<never> {
          fixture.runnerCalls.count += 1;
          throw new Error("close-failure inspection must not dispatch a runner");
        },
      },
      now: () => fixture.clock.value,
      recoveryInspectionOptions: { fileIo: io },
    });
    let result: Awaited<ReturnType<typeof backend.inspectExisting>> | null = null;
    try {
      result = await backend.inspectExisting(fixture.target, fixture.context, controlFor());
      // The observer has returned; the deliberately retained descriptor is
      // still open, so every post-failure open is visible here.
      expect(maxActive).toBe(1);
      expect(entries.filter((entry) => entry.afterFailure)).toEqual([]);
      const primaries = entries.filter((entry) => entry.category === "primary");
      expect(primaries.length).toBe(4);
      expect(primaries.every((entry) => entry.closed)).toBe(true);
      expect(entries.filter((entry) => entry.category === "input").length).toBe(1);
      expect(active).toBe(1);
    } finally {
      for (const item of retained) {
        if (item.entry.closed) continue;
        await item.handle.close();
        item.entry.closed = true;
        active -= 1;
      }
    }
    expect(active).toBe(0);
    expect(result).not.toBeNull();
    if (result === null) throw new Error("inspection produced no result");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason)
        .toBe("existing inspection refused: observation-unavailable/initial-inputs-close-unconfirmed");
    }
    expect(fixture.runnerCalls.count).toBe(0);
    await assertPrimaryUnchanged(fixture, before);
    expect(await Promise.all(fixture.fileSpecs.map((spec) =>
      readFile(path.join(fixture.sourceRoot, ...spec.path.split("/")))))).toEqual(sourceBefore);
    await assertLeaseFree(fixture);
  });
});
