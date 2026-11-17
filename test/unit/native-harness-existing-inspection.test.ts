import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeHarnessBackend,
  NATIVE_HARNESS_EXISTING_INSPECTION_MAX_BYTES,
  NATIVE_HARNESS_EXISTING_INSPECTION_SCHEMA,
  type NativeHarnessBackendHostConfig,
  type NativeHarnessExistingInspectionControl,
  type NativeHarnessExistingInspectionTarget,
} from "../../src/native-harness-backend.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  createNativeHarnessAccountingOwner,
} from "../../src/native-harness-accounting.ts";
import { NATIVE_HARNESS_COMPLETION_SOURCE_ID } from "../../src/native-harness-completion.ts";
import { NATIVE_HARNESS_RECOVERY_SOURCE_FILE } from "../../src/native-harness-recovery-source.ts";
import { nodeFileIo, type NativeFileIo } from "../../src/native-work.ts";
import type { NativeContext } from "../../src/native-entry.ts";
import type { NativeHarnessPrepareRequest } from "../../src/native-harness-delegation.ts";
import {
  HarnessController,
  type HarnessRecoveryInspectionView,
  type Runner,
} from "../../vendor/harness2/index.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const SELECTOR = "a".repeat(64);
const MODEL = "deepseek/deepseek-flash";
const INPUT_FILE = "input.txt";
const MAX_DURATION_MS = 120_000;
const SHA_PATTERN = /^[a-f0-9]{64}$/;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("operation rejected with a non-Error value");
  }
  throw new Error("operation unexpectedly succeeded");
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
      getSessionId: () => "r2c1b1-session",
      getCwd: () => cwd,
    },
  };
}

interface Clock {
  value: number;
}

interface Fixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly hostConfig: NativeHarnessBackendHostConfig;
  readonly factory: ReturnType<typeof createNativeHarnessBackend>;
  readonly preparedRoot: string;
  readonly preparedRelativeRoot: string;
  readonly runId: string;
  readonly store: RunStore;
  readonly runDir: string;
  readonly runPath: string;
  readonly sourcePath: string;
  readonly inventoryPath: string;
  readonly ownerPath: string;
  readonly target: NativeHarnessExistingInspectionTarget;
  readonly context: NativeContext;
  readonly clock: Clock;
  readonly runnerCalls: { count: number };
}

interface FixtureOptions {
  readonly clock?: Clock;
}

async function fixtureNamed(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2c1b1-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await mkdir(sourceRoot, { mode: 0o700 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, INPUT_FILE), "bounded existing inspection input\n", { mode: 0o600 });

  const clock = options.clock ?? { value: Date.now() };
  const runnerCalls = { count: 0 };
  const runner: Runner = {
    async run(): Promise<never> {
      runnerCalls.count += 1;
      throw new Error("existing inspection must not dispatch a runner");
    },
  };
  const hostConfig: NativeHarnessBackendHostConfig = {
    model: MODEL,
    ompCommand: "/usr/bin/fake-omp",
    storageRoot,
    inputFiles: [INPUT_FILE],
  };
  const factory = createNativeHarnessBackend(hostConfig, {
    deterministicRunner: runner,
    now: () => clock.value,
  });
  const admittedAt = clock.value - 1_000;
  const association = {
    observationId: "r2c1b1-observation",
    generation: 1,
    sessionId: "r2c1b1-session",
    workspaceRoot: sourceRoot,
    toolCallId: "r2c1b1-call",
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
  const created = await prepared.backend.create("bounded existing inspection fixture task") as { runId?: unknown };
  if (typeof created.runId !== "string") throw new Error("durable fixture created no run id");
  const runId = created.runId;
  const preparedRelativeRoot = prepared.accountingPrepared.preparedRelativeRoot;
  const preparedRoot = path.join(storageRoot, preparedRelativeRoot);
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
  return {
    root,
    sourceRoot,
    storageRoot,
    hostConfig,
    factory,
    preparedRoot,
    preparedRelativeRoot,
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
    clock,
    runnerCalls,
  };
}

function controlFor(
  signal: AbortSignal = new AbortController().signal,
  guard: () => void = () => undefined,
): NativeHarnessExistingInspectionControl {
  return { signal, guard };
}

function controllerFor(
  fixture: Fixture,
  recoveryInspector?: (view: HarnessRecoveryInspectionView, signal: AbortSignal) => void | Promise<void>,
): HarnessController {
  return new HarnessController({
    workspace: path.join(fixture.preparedRoot, "workspace"),
    storeRoot: path.join(fixture.preparedRoot, "store"),
    ...(recoveryInspector === undefined ? {} : { recoveryInspector }),
  });
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

async function assertPrimaryUnchanged(fixture: Fixture, before: Awaited<ReturnType<typeof snapshotPrimary>>): Promise<void> {
  expect(await snapshotPrimary(fixture)).toEqual(before);
  expect(await exists(path.join(fixture.runDir, "cancel.request"))).toBe(false);
  expect(await exists(path.join(fixture.runDir, ".run.lock"))).toBe(false);
  const prepared = (await readdir(fixture.storageRoot)).filter((name) => name.startsWith("omp-harness-"));
  expect(prepared).toEqual([fixture.preparedRelativeRoot]);
  expect(await readdir(path.join(fixture.preparedRoot, "store", "runs"))).toEqual([fixture.runId]);
}

async function assertLeaseFree(fixture: Fixture): Promise<void> {
  const release = await fixture.store.acquire(fixture.runId);
  await release();
}

describe("R2-C1b1 actual Controller-owned existing-run inspection", () => {
  test("returns a readonly diagnostic only after the original lease is released", async () => {
    const fixture = await fixtureNamed();
    const before = await snapshotPrimary(fixture);
    let guardCalls = 0;
    const control = controlFor(new AbortController().signal, () => {
      guardCalls += 1;
      expect(guardCalls).toBeGreaterThan(0);
      return undefined;
    });

    const result = await fixture.factory.inspectExisting(fixture.target, fixture.context, control);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.diagnostic.schema).toBe(NATIVE_HARNESS_EXISTING_INSPECTION_SCHEMA);
    expect(result.diagnostic.readOnly).toBe(true);
    expect(result.diagnostic.resumeAvailable).toBe(false);
    expect(result.diagnostic.runId).toBe(fixture.runId);
    expect(result.diagnostic.leaseOwnerSha256).toMatch(SHA_PATTERN);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(Object.isFrozen(result.diagnostic.observation)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8"))
      .toBeLessThanOrEqual(NATIVE_HARNESS_EXISTING_INSPECTION_MAX_BYTES);

    const observation = result.diagnostic.observation;
    expect(observation.schema).toBe("omp-agent.native-harness-reconciliation-lifecycle.v1");
    expect(observation.readOnly).toBe(true);
    expect(observation.resumeAvailable).toBe(false);
    expect(observation.status).toBe("stable");
    expect(observation.observation).toBe("two-pass");
    expect(observation.metadataStatus).toBe("compatible");
    expect(observation.metadata?.build.sourceId).toBe(NATIVE_HARNESS_COMPLETION_SOURCE_ID);
    expect(observation.deadline.expired).toBe(false);
    expect(observation.pins).toEqual({ directoryCount: 7, checkedAtEnd: true, stable: true });
    expect(observation.lifecycle.status).toBe("stable");
    expect(observation.lifecycle.revoked).toBe(false);
    expect(observation.lifecycle.window.roundsStarted).toBe(2);
    expect(observation.lifecycle.completeAttemptCoverage.status).toBe("not-required");
    expect(observation.lifecycle.controllerLease.status).toBe("stable");
    expect(observation.lifecycle.controllerLease.ownerComparison).toBe("stable");
    expect(observation.lifecycle.controllerLease.ownerRound1?.state).toBe("observed");
    expect(observation.lifecycle.controllerLease.ownerRound2?.state).toBe("observed");
    expect(observation.lifecycle.controllerLease.ownerRound1?.sha256).toBe(result.diagnostic.leaseOwnerSha256);
    expect(observation.lifecycle.controllerLease.ownerRound2?.sha256).toBe(result.diagnostic.leaseOwnerSha256);
    expect(observation.lifecycle.controllerLease.ownerPid).toBe(process.pid);
    expect(observation.processes).toBe("two-round-signal0-observed");
    // Zero attempts are explicitly not an input-byte verification.
    expect(observation.content.status).toBe("not-required");
    expect(observation.content.planner).toBe("not-required");
    expect(observation.artifacts).toBe("auxiliary-owner-and-cancel-files-checked");
    expect(fixture.runnerCalls.count).toBe(0);
    expect(guardCalls).toBeGreaterThanOrEqual(4);

    await assertPrimaryUnchanged(fixture, before);
    await assertLeaseFree(fixture);
  });
});

describe("R2-C1b1 existing inspection refusals and ownership", () => {
  test("constructor captures an own-data inspector once and refuses an accessor", async () => {
    const fixture = await fixtureNamed();
    const controller = controllerFor(fixture, () => undefined);
    expect(controller).toBeInstanceOf(HarnessController);

    let getterCalls = 0;
    expect(() => new HarnessController({
      workspace: path.join(fixture.preparedRoot, "workspace"),
      storeRoot: path.join(fixture.preparedRoot, "store"),
      get recoveryInspector() {
        getterCalls += 1;
        return () => undefined;
      },
    })).toThrow(/own-data/);
    expect(getterCalls).toBe(0);
  });

  test("missing controller observer refuses before any lease", async () => {
    const fixture = await fixtureNamed();
    const controller = controllerFor(fixture);
    const error = await rejection(controller.inspectWithRecoveryLease(
      fixture.runId,
      new AbortController().signal,
    ));
    expect(error.message).toMatch(/not configured/);
    expect(await exists(path.join(fixture.runDir, ".run.lock"))).toBe(false);
    await assertLeaseFree(fixture);
  });

  test("invalid target, context and control refuse before observer IO", async () => {
    const fixture = await fixtureNamed();
    const before = await snapshotPrimary(fixture);
    let guardCalls = 0;
    const control = controlFor(new AbortController().signal, () => {
      guardCalls += 1;
    });
    let getterCalls = 0;
    const getterTarget = {
      get runId() {
        getterCalls += 1;
        return fixture.runId;
      },
      ownerId: OWNER_ID,
      selectorSha256: SELECTOR,
      preparedRelativeRoot: fixture.preparedRelativeRoot,
    } as unknown as NativeHarnessExistingInspectionTarget;
    const cases: readonly [
      NativeHarnessExistingInspectionTarget,
      NativeContext,
      NativeHarnessExistingInspectionControl,
      RegExp,
    ][] = [
      [{ ...fixture.target, extra: true } as unknown as NativeHarnessExistingInspectionTarget, fixture.context, control, /exact plain own-data/],
      [getterTarget, fixture.context, control, /exact plain own-data/],
      [{ ...fixture.target, runId: "run-not-a-uuid" }, fixture.context, control, /lowercase UUID/],
      [{ ...fixture.target, preparedRelativeRoot: `${fixture.preparedRelativeRoot}/nested` }, fixture.context, control, /six ASCII alphanumerics|safe relative POSIX path/],
      [{ ...fixture.target, preparedRelativeRoot: "omp-harness-" }, fixture.context, control, /six ASCII alphanumerics/],
      [{ ...fixture.target, preparedRelativeRoot: "omp-harness-abcde" }, fixture.context, control, /six ASCII alphanumerics/],
      [{ ...fixture.target, preparedRelativeRoot: "omp-harness-abcdefg" }, fixture.context, control, /six ASCII alphanumerics/],
      [{ ...fixture.target, preparedRelativeRoot: "omp-harness-abcdeé" }, fixture.context, control, /six ASCII alphanumerics/],
      [fixture.target, { get cwd() { throw new Error("cwd getter"); } } as unknown as NativeContext, control, /cwd/],
      [fixture.target, fixture.context, { ...control, signal: { aborted: false } as unknown as AbortSignal }, /actual host AbortSignal/],
      [fixture.target, fixture.context, { signal: control.signal, get guard() { throw new Error("guard getter"); } } as unknown as NativeHarnessExistingInspectionControl, /exact plain own-data/],
    ];
    for (const [target, context, controlValue, pattern] of cases) {
      const result = await fixture.factory.inspectExisting(target, context, controlValue);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(pattern);
    }
    expect(guardCalls).toBe(0);
    expect(getterCalls).toBe(0);
    expect(fixture.runnerCalls.count).toBe(0);
    await assertPrimaryUnchanged(fixture, before);
    await assertLeaseFree(fixture);

    const aborted = new AbortController();
    aborted.abort();
    const abortedResult = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(aborted.signal),
    );
    expect(abortedResult.ok).toBe(false);
    if (!abortedResult.ok) expect(abortedResult.reason).toMatch(/already aborted/);
    await assertLeaseFree(fixture);
  });

  test("nonvoid guard returns and foreign thenables refuse without invoking then", async () => {
    const fixture = await fixtureNamed();
    const promiseGuard = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(new AbortController().signal, (() => Promise.resolve()) as unknown as () => void),
    );
    expect(promiseGuard.ok).toBe(false);
    if (!promiseGuard.ok) expect(promiseGuard.reason).toMatch(/undefined/);

    let thenCalls = 0;
    const thenable = {
      then() {
        thenCalls += 1;
        return undefined;
      },
    };
    const thenableGuard = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(new AbortController().signal, (() => thenable) as unknown as () => void),
    );
    expect(thenableGuard.ok).toBe(false);
    if (!thenableGuard.ok) expect(thenableGuard.reason).toMatch(/undefined/);
    expect(thenCalls).toBe(0);
    await assertLeaseFree(fixture);
  });

  test("a foreign active lease refuses without deleting the foreign owner", async () => {
    const fixture = await fixtureNamed();
    const before = await snapshotPrimary(fixture);
    const foreign = await fixture.store.acquireWithContext(fixture.runId);
    try {
      const result = await fixture.factory.inspectExisting(
        fixture.target,
        fixture.context,
        controlFor(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/locked|lease|owner/i);
      await foreign.assertCurrent();
      expect(await exists(path.join(fixture.runDir, ".run.lock", "owner.json"))).toBe(true);
      // The foreign lock is intentionally still held; the primary bytes are
      // checked only after its owner releases below.
      expect((await readFile(fixture.runPath)).toString("base64")).toBe(before.run);
    } finally {
      await foreign.release();
    }
    await assertPrimaryUnchanged(fixture, before);
    await assertLeaseFree(fixture);
  });
});

function ioWithOpen(open: NativeFileIo["open"]): NativeFileIo {
  return {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: (target) => nodeFileIo.realpath(target),
    lstat: (target, options) => nodeFileIo.lstat(target, options),
    open,
  };
}

function seamFactory(fixture: Fixture, fileIo?: NativeFileIo): ReturnType<typeof createNativeHarnessBackend> {
  const runner: Runner = {
    async run(): Promise<never> {
      throw new Error("seamed existing inspection must not dispatch a runner");
    },
  };
  return createNativeHarnessBackend(fixture.hostConfig, {
    deterministicRunner: runner,
    now: () => fixture.clock.value,
    ...(fileIo === undefined ? {} : { recoveryInspectionOptions: { fileIo } }),
  });
}

describe("R2-C1b1 Controller observer protocol and lease release", () => {
  test("inspector failure, nonvoid and foreign thenables release the original lease", async () => {
    const fixture = await fixtureNamed();
    const signal = new AbortController().signal;
    const thrown = controllerFor(fixture, () => { throw new Error("observer failed"); });
    const thrownError = await rejection(thrown.inspectWithRecoveryLease(fixture.runId, signal));
    expect(thrownError.message).toMatch(/observer failed/);
    await assertLeaseFree(fixture);

    const nonvoid = controllerFor(
      fixture,
      (() => 42) as unknown as (view: HarnessRecoveryInspectionView, signal: AbortSignal) => void,
    );
    const nonvoidError = await rejection(nonvoid.inspectWithRecoveryLease(fixture.runId, signal));
    expect(nonvoidError.message).toMatch(/undefined|native Promise/);
    await assertLeaseFree(fixture);

    let thenCalls = 0;
    const thenable = {
      then() {
        thenCalls += 1;
        return undefined;
      },
    };
    const foreign = controllerFor(
      fixture,
      (() => thenable) as unknown as (view: HarnessRecoveryInspectionView, signal: AbortSignal) => void,
    );
    const foreignError = await rejection(foreign.inspectWithRecoveryLease(fixture.runId, signal));
    expect(foreignError.message).toMatch(/undefined|native Promise/);
    expect(thenCalls).toBe(0);
    await assertLeaseFree(fixture);

    const aborted = new AbortController();
    const aborting = controllerFor(fixture, () => { aborted.abort(); });
    const abortError = await rejection(aborting.inspectWithRecoveryLease(fixture.runId, aborted.signal));
    expect(abortError.message).toMatch(/aborted/);
    await assertLeaseFree(fixture);

    const fakeSignal = { aborted: false } as unknown as AbortSignal;
    const fakeError = await rejection(controllerFor(fixture, () => undefined).inspectWithRecoveryLease(fixture.runId, fakeSignal));
    expect(fakeError.message).toMatch(/actual AbortSignal/);
    await assertLeaseFree(fixture);
  });

  test("refuses shadowed promise shapes without reading their accessors", async () => {
    const fixture = await fixtureNamed();
    let touched = false;
    const shadowed = Promise.resolve(undefined);
    Object.defineProperty(shadowed, "then", {
      get() {
        touched = true;
        throw new Error("shadow then must not be read");
      },
    });
    Object.defineProperty(shadowed, "constructor", {
      get() {
        touched = true;
        throw new Error("shadow constructor must not be read");
      },
    });
    const controller = controllerFor(fixture, () => shadowed);
    const error = await rejection(controller.inspectWithRecoveryLease(fixture.runId, new AbortController().signal));
    expect(error.message).toMatch(/undefined|native Promise/);
    expect(touched).toBe(false);
    await assertLeaseFree(fixture);
  });

  test("settles ordinary async success and rejection with the lease released", async () => {
    const fixture = await fixtureNamed();
    const signal = new AbortController().signal;
    const success = controllerFor(fixture, async () => {
      await Promise.resolve();
    });
    await success.inspectWithRecoveryLease(fixture.runId, signal);
    await assertLeaseFree(fixture);

    const failure = controllerFor(fixture, async () => {
      await Promise.resolve();
      throw new Error("async observer failed");
    });
    const error = await rejection(failure.inspectWithRecoveryLease(fixture.runId, signal));
    expect(error.message).toMatch(/async observer failed/);
    await assertLeaseFree(fixture);
    expect(fixture.runnerCalls.count).toBe(0);
  });

  test("refuses a pending Promise subclass before species or foreign then", async () => {
    const fixture = await fixtureNamed();
    let speciesCalls = 0;
    let foreignThenCalls = 0;
    let resolveOriginal: ((value: undefined) => void) | undefined;
    class HostileNativePromise extends Promise<undefined> {
      static get [Symbol.species](): any {
        speciesCalls += 1;
        return function ForeignSpecies(
          executor: (resolve: (value: undefined) => void, reject: (reason?: unknown) => void) => void,
        ) {
          executor(() => undefined, () => undefined);
          return {
            then(resolve: (value: undefined) => void): void {
              foreignThenCalls += 1;
              resolve(undefined);
            },
          };
        };
      }
    }
    try {
      const pending = new HostileNativePromise((resolve) => {
        resolveOriginal = (value) => resolve(value);
      });
      const controller = controllerFor(fixture, () => pending);
      const error = await rejection(
        controller.inspectWithRecoveryLease(fixture.runId, new AbortController().signal),
      );
      expect(error.message).toMatch(/undefined|native Promise/);
      expect(speciesCalls).toBe(0);
      expect(foreignThenCalls).toBe(0);
      expect(fixture.runnerCalls.count).toBe(0);
      expect(await exists(path.join(fixture.runDir, ".run.lock"))).toBe(false);
      await assertLeaseFree(fixture);
    } finally {
      resolveOriginal?.(undefined);
      await Promise.resolve();
    }
  });

  test("the view is frozen, minimal and refuses after release", async () => {
    const fixture = await fixtureNamed();
    const captured: { view: HarnessRecoveryInspectionView | null } = { view: null };
    const controller = controllerFor(fixture, (view) => { captured.view = view; });
    await controller.inspectWithRecoveryLease(fixture.runId, new AbortController().signal);
    const view = captured.view;
    if (view === null) throw new Error("inspector did not receive a view");
    expect(Object.isFrozen(view)).toBe(true);
    expect(Reflect.ownKeys(view).sort()).toEqual(["assertCurrent", "ownerSha256", "runId"]);
    expect("release" in view).toBe(false);
    expect("token" in view).toBe(false);
    expect("commit" in view).toBe(false);
    expect(view.ownerSha256).toMatch(SHA_PATTERN);
    const afterRelease = await rejection(view.assertCurrent());
    expect(afterRelease).toBeInstanceOf(Error);
    await assertLeaseFree(fixture);
  });

  test("adverse inspection leaves marked execute and resume closed", async () => {
    const fixture = await fixtureNamed();
    const bad = controllerFor(
      fixture,
      (() => 7) as unknown as (view: HarnessRecoveryInspectionView, signal: AbortSignal) => void,
    );
    await rejection(bad.inspectWithRecoveryLease(fixture.runId, new AbortController().signal));
    const current = await fixture.store.get(fixture.runId);
    if (current === undefined) throw new Error("fixture run disappeared");
    await fixture.store.save({
      ...current,
      status: "failed",
      error: "fixture noninitial marked record",
    }, current.revision);
    const closed = controllerFor(fixture);
    const executeError = await rejection(closed.execute(fixture.runId));
    expect(executeError.message).toMatch(/original initial record|guarded continuation/i);
    const resumeError = await rejection(closed.resume(fixture.runId));
    expect(resumeError.message).toMatch(/cannot resume|guarded continuation/i);
    expect(fixture.runnerCalls.count).toBe(0);
    await assertLeaseFree(fixture);
  });
});

describe("R2-C1b1 active changes, aborts and final clock", () => {
  test("a primary change during the direct B2 read refuses leased success", async () => {
    const fixture = await fixtureNamed();
    let runOpens = 0;
    const io = ioWithOpen(async (target, flags) => {
      if (target === fixture.runPath) {
        runOpens += 1;
        if (runOpens === 2) {
          const raw = await readFile(target, "utf8");
          await writeFile(target, `${raw} `, { mode: 0o600 });
        }
      }
      return nodeFileIo.open(target, flags);
    });
    const result = await seamFactory(fixture, io).inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/observation-(different|unavailable)|primary-window-unstable|changed/);
    expect(runOpens).toBeGreaterThanOrEqual(2);
    await assertLeaseFree(fixture);
  });

  test("an aborted control signal during B2 refuses and releases the lease", async () => {
    const fixture = await fixtureNamed();
    const aborted = new AbortController();
    let firstOpen = true;
    const io = ioWithOpen(async (target, flags) => {
      if (firstOpen) {
        firstOpen = false;
        aborted.abort();
      }
      return nodeFileIo.open(target, flags);
    });
    const result = await seamFactory(fixture, io).inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(aborted.signal),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aborted/);
    expect(firstOpen).toBe(false);
    await assertLeaseFree(fixture);
  });

  test("a guard lost before observation refuses without B2 reads", async () => {
    const fixture = await fixtureNamed();
    let calls = 0;
    const guard = (): void => {
      calls += 1;
      if (calls === 2) throw new Error("authority lost");
    };
    const result = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(new AbortController().signal, guard),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/authority lost/);
    expect(calls).toBe(2);
    await assertLeaseFree(fixture);
  });

  test("abort and backward or expired final clocks refuse after release", async () => {
    const abortedFixture = await fixtureNamed();
    const aborted = new AbortController();
    let abortCalls = 0;
    const abortGuard = (): void => {
      abortCalls += 1;
      if (abortCalls === 12) aborted.abort();
    };
    const abortResult = await abortedFixture.factory.inspectExisting(
      abortedFixture.target,
      abortedFixture.context,
      controlFor(aborted.signal, abortGuard),
    );
    expect(abortResult.ok).toBe(false);
    if (!abortResult.ok) expect(abortResult.reason).toMatch(/aborted/);
    expect(abortCalls).toBe(12);
    await assertLeaseFree(abortedFixture);

    const backwardFixture = await fixtureNamed();
    let backwardCalls = 0;
    const backwardGuard = (): void => {
      backwardCalls += 1;
      if (backwardCalls === 12) backwardFixture.clock.value -= 1_000;
    };
    const backwardResult = await backwardFixture.factory.inspectExisting(
      backwardFixture.target,
      backwardFixture.context,
      controlFor(new AbortController().signal, backwardGuard),
    );
    expect(backwardResult.ok).toBe(false);
    if (!backwardResult.ok) expect(backwardResult.reason).toMatch(/final-clock-backward/);
    expect(backwardCalls).toBe(12);
    await assertLeaseFree(backwardFixture);

    const expiredFixture = await fixtureNamed();
    let expiredCalls = 0;
    const expiredGuard = (): void => {
      expiredCalls += 1;
      if (expiredCalls === 12) expiredFixture.clock.value += 10_000_000;
    };
    const expiredResult = await expiredFixture.factory.inspectExisting(
      expiredFixture.target,
      expiredFixture.context,
      controlFor(new AbortController().signal, expiredGuard),
    );
    expect(expiredResult.ok).toBe(false);
    if (!expiredResult.ok) expect(expiredResult.reason).toMatch(/final-clock-expired/);
    expect(expiredCalls).toBe(12);
    await assertLeaseFree(expiredFixture);
  });

  test("a clock callback abort after release refuses before any diagnostic", async () => {
    const fixture = await fixtureNamed();
    const aborted = new AbortController();
    let abortOnNextNow = false;
    const runner: Runner = {
      async run(): Promise<never> {
        throw new Error("clock-abort inspection must not dispatch a runner");
      },
    };
    const factory = createNativeHarnessBackend(fixture.hostConfig, {
      deterministicRunner: runner,
      now: () => {
        if (abortOnNextNow) {
          abortOnNextNow = false;
          aborted.abort();
        }
        return fixture.clock.value;
      },
    });
    let calls = 0;
    const guard = (): void => {
      calls += 1;
      if (calls === 12) abortOnNextNow = true;
    };
    const result = await factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(aborted.signal, guard),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aborted/);
    expect("diagnostic" in result).toBe(false);
    expect(calls).toBe(12);
    expect(abortOnNextNow).toBe(false);
    await assertLeaseFree(fixture);
  });
});

describe("R2-C1b1 captured targets and metadata refusal", () => {
  test("post-call target, context, control and host mutation cannot retarget inspection", async () => {
    const first = await fixtureNamed();
    const second = await fixtureNamed();
    const beforeFirst = await snapshotPrimary(first);
    const beforeSecond = await snapshotPrimary(second);
    const target = { ...first.target } as { -readonly [K in keyof NativeHarnessExistingInspectionTarget]: NativeHarnessExistingInspectionTarget[K] };
    const context = { ...first.context } as NativeContext;
    const control = controlFor() as { -readonly [K in keyof NativeHarnessExistingInspectionControl]: NativeHarnessExistingInspectionControl[K] };
    const pending = first.factory.inspectExisting(target, context, control);
    target.runId = second.runId;
    target.ownerId = second.target.ownerId;
    target.selectorSha256 = second.target.selectorSha256;
    target.preparedRelativeRoot = second.preparedRelativeRoot;
    context.cwd = second.sourceRoot;
    control.guard = () => { throw new Error("retargeted guard"); };
    (first.hostConfig as { storageRoot: string }).storageRoot = second.storageRoot;

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.diagnostic.runId).toBe(first.runId);
    expect(result.diagnostic.observation.metadata?.source?.sourceRoot).toBe(first.sourceRoot);
    expect(result.diagnostic.observation.lifecycle.controllerLease.ownerRound1?.sha256)
      .toBe(result.diagnostic.leaseOwnerSha256);
    await assertPrimaryUnchanged(first, beforeFirst);
    await assertPrimaryUnchanged(second, beforeSecond);
  });

  test("metadata incompatibility is a specific bounded refusal, never a leased success", async () => {
    const fixture = await fixtureNamed();
    // Change only the stable source document's profile so the primary bytes
    // remain two-pass stable while the B2 metadata join is incompatible.
    const rawSource = JSON.parse(await readFile(fixture.sourcePath, "utf8")) as {
      backendProfile: { model: string; improverModel: string };
    };
    rawSource.backendProfile.model = "deepseek/other-model";
    rawSource.backendProfile.improverModel = "deepseek/other-model";
    await writeFile(fixture.sourcePath, `${JSON.stringify(rawSource, null, 2)}\n`, { mode: 0o600 });
    const runBytes = (await readFile(fixture.runPath)).toString("base64");
    const sourceBytes = (await readFile(fixture.sourcePath)).toString("base64");
    const inventoryBytes = (await readFile(fixture.inventoryPath)).toString("base64");
    const ownerBytes = (await readFile(fixture.ownerPath)).toString("base64");

    const result = await fixture.factory.inspectExisting(
      fixture.target,
      fixture.context,
      controlFor(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/metadata-incompatible/);
      expect(result.reason).toMatch(/lifecycle-metadata-refused/);
      expect(Buffer.byteLength(result.reason, "utf8")).toBeLessThanOrEqual(320);
    }
    expect("diagnostic" in result).toBe(false);
    expect(await readFile(fixture.runPath)).toEqual(Buffer.from(runBytes, "base64"));
    expect(await readFile(fixture.sourcePath)).toEqual(Buffer.from(sourceBytes, "base64"));
    expect(await readFile(fixture.inventoryPath)).toEqual(Buffer.from(inventoryBytes, "base64"));
    expect(await readFile(fixture.ownerPath)).toEqual(Buffer.from(ownerBytes, "base64"));
    expect(await exists(path.join(fixture.runDir, ".run.lock"))).toBe(false);
    await assertLeaseFree(fixture);
  });
});
