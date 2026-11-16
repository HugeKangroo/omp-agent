import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_WORK_CALL_INSPECTION_SCHEMA,
  type NativeCallCheckPreparation,
  type NativeContext,
  type NativeEntryControls,
  type NativeWorkCallInspection,
  type NativeWorkCallReference,
} from "../../src/native-entry.ts";
import {
  createNativeHarnessAccountingOwner,
  decodeNativeHarnessAccountingText,
  projectNativeHarnessAccounting,
  type NativeHarnessAccountingCheckpoint,
  type NativeHarnessAccountingHandle,
  type NativeHarnessAccountingIdentity,
  type NativeHarnessAccountingPrepared,
} from "../../src/native-harness-accounting.ts";
import type {
  NativeHarnessBackend,
  NativeHarnessDelegationLimits,
  NativeHarnessPrepareRequest,
  NativeHarnessPrepareResult,
} from "../../src/native-harness-delegation.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../../vendor/harness2/index.ts";

// Transparent spy around the real A2a1 open: it only forwards the existing
// test-only after-primary-write hook and never fabricates a checkpoint. The
// captured original keeps the export's live binding from recursing. Every
// actual open/commit promise is observed only so fixture teardown can drain
// real writes before deleting its owned temporary root.
type PrimaryWriteHook = (event: { readonly path: string; readonly revision: number }) => void | Promise<void>;
let activeHook: PrimaryWriteHook | undefined;
type OpenDeliveryBarrier = (snapshotRevision: number) => void | Promise<void>;
let activeOpenBarrier: OpenDeliveryBarrier | undefined;
const accountingModule = await import("../../src/native-harness-accounting.ts");
const originalAccountingExports = Object.freeze({ ...accountingModule });
const originalOpen = accountingModule.openNativeHarnessAccountingOwner;
const pendingDurableIo = new Set<Promise<unknown>>();
let lastDurableIoAt = 0;
function trackDurableIo<T>(promise: Promise<T>): Promise<T> {
  lastDurableIoAt = Date.now();
  pendingDurableIo.add(promise);
  void promise.then(
    () => {
      lastDurableIoAt = Date.now();
      pendingDurableIo.delete(promise);
    },
    () => {
      lastDurableIoAt = Date.now();
      pendingDurableIo.delete(promise);
    },
  );
  return promise;
}
function observedHandle(handle: NativeHarnessAccountingHandle): NativeHarnessAccountingHandle {
  return {
    snapshot: () => handle.snapshot(),
    commit: (expectedRevision, transitionText) =>
      trackDurableIo(handle.commit(expectedRevision, transitionText)),
    close: () => handle.close(),
  };
}
const accountingModulePath = "../../src/native-harness-accounting.ts";
mock.module(accountingModulePath, () => ({
  ...accountingModule,
  openNativeHarnessAccountingOwner: (
    options: Parameters<typeof originalOpen>[0],
    testOptions?: Parameters<typeof originalOpen>[1],
  ) => {
    const opened = trackDurableIo(originalOpen(options, {
      ...(testOptions ?? {}),
      ...(activeHook === undefined ? {} : { testAfterPrimaryWrite: activeHook }),
    }));
    return opened.then(async (handle) => {
      const observed = observedHandle(handle);
      if (activeOpenBarrier !== undefined) {
        // Fixture-only gate: the real handle already exists and records its
        // real snapshot revision before the coordinator can use it.
        await activeOpenBarrier(handle.snapshot().revision);
      }
      return observed;
    });
  },
}));
const { createNativeHarnessDelegation } = await import("../../src/native-harness-delegation.ts");

const BASE_LIMITS: NativeHarnessDelegationLimits = Object.freeze({
  maxRetainedOperations: 16,
  maxConcurrent: 1,
  perRunUsd: 1,
  lifetimeUsd: 5,
  maxDurationMs: 300_000,
  cleanupGraceMs: 40,
});
const CREATED_AT = 1_700_000_000_000;
const CLOCK = 1_700_000_100_000;
const WORKSPACE = "/tmp/a2b1-workspace";
const TOOL = "agent_harness";

const roots: string[] = [];
const coordinators: Array<{ dispose(): void }> = [];
const teardownReleases: Array<() => void> = [];

async function drainOwnedDurableIo(ms = 2000): Promise<boolean> {
  const until = Date.now() + ms;
  // Cleanup timers can start a final write up to the grace window after the
  // release; require one quiet grace period, not just an empty set instant.
  const quietMs = BASE_LIMITS.cleanupGraceMs + 25;
  while (Date.now() < until) {
    const pending = [...pendingDurableIo];
    if (pending.length === 0 && Date.now() - lastDurableIoAt >= quietMs) return true;
    await Promise.race([
      pending.length === 0 ? tick(5) : Promise.allSettled(pending),
      tick(10),
    ]);
  }
  return pendingDurableIo.size === 0 && Date.now() - lastDurableIoAt >= quietMs;
}
afterEach(async () => {
  activeHook = undefined;
  activeOpenBarrier = undefined;
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
  for (const release of teardownReleases.splice(0)) release();
  if (!(await drainOwnedDurableIo())) {
    const preserved = roots.splice(0);
    throw new Error(
      `fixture durable IO cleanup unknown; preserved owned temporary roots: ${preserved.join(", ")}`,
    );
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  mock.restore();
  let restored = await import(accountingModulePath);
  if (restored.openNativeHarnessAccountingOwner !== originalOpen) {
    // Explicitly restore the captured real exports so this file cannot leak
    // its override into later tests.
    await mock.module(accountingModulePath, () => originalAccountingExports);
    restored = await import(accountingModulePath);
  }
  if (restored.openNativeHarnessAccountingOwner !== originalOpen) {
    throw new Error("fixture failed to restore the real accounting open export");
  }
});

function limitsFor(overrides: Partial<NativeHarnessDelegationLimits> = {}): NativeHarnessDelegationLimits {
  return Object.freeze({ ...BASE_LIMITS, ...overrides });
}

function limitsText(limits: NativeHarnessDelegationLimits): string {
  return JSON.stringify({
    maxRetainedOperations: limits.maxRetainedOperations,
    maxConcurrent: limits.maxConcurrent,
    perRunUsd: limits.perRunUsd,
    lifetimeUsd: limits.lifetimeUsd,
    maxDurationMs: limits.maxDurationMs,
    cleanupGraceMs: limits.cleanupGraceMs,
  });
}

function hash(fill: string): string {
  return createHash("sha256").update(fill, "utf8").digest("hex");
}

function identity(selectorFill = "a"): NativeHarnessAccountingIdentity {
  return Object.freeze({ ownerId: randomUUID(), selectorSha256: hash(selectorFill) });
}

async function makeRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `omp-a2b1-${label}-`)));
  roots.push(root);
  return root;
}

async function createOwner(
  root: string,
  owner: NativeHarnessAccountingIdentity,
  limits: NativeHarnessDelegationLimits,
): Promise<void> {
  const handle = await createNativeHarnessAccountingOwner({
    storageRoot: root,
    selectorSha256: owner.selectorSha256,
    ownerId: owner.ownerId,
    createdAt: CREATED_AT,
    limitsText: limitsText(limits),
  });
  handle.close();
}

function ownerPath(root: string, owner: NativeHarnessAccountingIdentity): string {
  return path.join(root, "accounting-owners", owner.selectorSha256, "owner.json");
}

async function readCheckpoint(
  root: string,
  owner: NativeHarnessAccountingIdentity,
): Promise<NativeHarnessAccountingCheckpoint> {
  const raw = await readFile(ownerPath(root, owner), "utf8");
  return decodeNativeHarnessAccountingText(raw, owner);
}

function preparedFor(n = 1): NativeHarnessAccountingPrepared {
  const preparedRelativeRoot = `omp-harness-${n}`;
  return Object.freeze({
    preparedRelativeRoot,
    storeRelativeRoot: `${preparedRelativeRoot}/store`,
    inputManifestSha256: hash("b"),
    sourceDescriptorSha256: hash("c"),
  });
}

function defaultContext(): NativeContext {
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "session-a2b1",
      getCwd: () => WORKSPACE,
    },
  };
}

interface NativeState {
  current: boolean;
}

function nativeControls(state: NativeState): NativeEntryControls {
  const base: NativeWorkCallReference = {
    observationId: "obs-a2b1",
    generation: 1,
    sessionId: "session-a2b1",
    workspaceRoot: WORKSPACE,
    toolCallId: "call-1",
    toolName: TOOL,
  };
  const refs = new Map<string, NativeWorkCallReference>();
  const refFor = (toolCallId: string): NativeWorkCallReference => {
    let ref = refs.get(toolCallId);
    if (ref === undefined) {
      ref = { ...base, toolCallId };
      refs.set(toolCallId, ref);
    }
    return ref;
  };
  const inspectionFor = (ref: NativeWorkCallReference): NativeWorkCallInspection => ({
    schema: NATIVE_WORK_CALL_INSPECTION_SCHEMA,
    authority: "non-authoritative",
    state: "current",
    reason: "current-work",
    association: ref,
    workPhase: "active",
    requestAttribution: "matched-user-input",
    evidenceState: "available",
    callResultState: "preflight",
    pendingInputCount: 0,
    pendingInputsDropped: 0,
    workPromptSha256: null,
    callInputSha256: null,
  });
  return {
    enabled: true,
    disabledReason: null,
    isEnabled: () => state.current,
    dispose() {},
    captureCall(selector: { readonly toolCallId: string }): ReturnType<NativeEntryControls["captureCall"]> {
      const ref = refFor(selector.toolCallId);
      if (!state.current) {
        return {
          ok: false,
          ref: null,
          inspection: {
            ...inspectionFor(ref),
            state: "stale",
            reason: "work-invalidated",
          },
        };
      }
      return { ok: true, ref, inspection: inspectionFor(ref) };
    },
    inspectCall(ref: unknown): NativeWorkCallInspection {
      return inspectionFor(ref as NativeWorkCallReference);
    },
    prepareCallCheck(ref: unknown): NativeCallCheckPreparation {
      const inspection = inspectionFor(ref as NativeWorkCallReference);
      if (!state.current) {
        return {
          ok: false,
          inspection: { ...inspection, state: "stale", reason: "work-invalidated" },
        };
      }
      return {
        ok: true,
        inspection,
        revalidate: () => (state.current ? null : "work-invalidated"),
      };
    },
  } as NativeEntryControls;
}

function workerRequest(runId: string, maxCostUsd = 0.2): WorkerRequest {
  return {
    runId,
    stage: "baseline",
    role: "solver",
    cwd: WORKSPACE,
    artifactDir: `${WORKSPACE}/artifacts`,
    prompt: "worker prompt",
    harness: {
      schemaVersion: 1,
      id: "harness-a2b1",
      promptAppend: "",
      toolGuidance: "",
      skills: [],
      rationale: "test",
    },
    model: "deepseek/deepseek-chat",
    maxCostUsd,
    timeoutMs: 1000,
    ompCommand: "omp",
  };
}

function completed(costUsd: number): WorkerResult {
  return {
    text: "worker text",
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
    startedAt: "2026-11-17T00:00:00.000Z",
    endedAt: "2026-11-17T00:00:01.000Z",
    eventsPath: `${WORKSPACE}/events.jsonl`,
    status: "completed",
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function canonicalResultSha256(result: WorkerResult): string {
  return createHash("sha256").update(canonicalJson(result)).digest("hex");
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

async function waitFor(predicate: () => boolean, label: string, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await tick(2);
  }
}

async function waitForAsync(predicate: () => Promise<boolean>, label: string, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await tick(2);
  }
}

interface BackendScript {
  create(): Promise<unknown> | unknown;
  execute?(runId: string, runner: Runner | null): Promise<unknown> | unknown;
  cancel?(runId: string): Promise<unknown> | unknown;
}

function scriptedBackend(script: BackendScript): {
  readonly backend: NativeHarnessBackend;
  readonly calls: { create: number; execute: number; cancel: string[] };
  setRunner(runner: Runner): void;
} {
  let runner: Runner | null = null;
  const calls = { create: 0, execute: 0, cancel: [] as string[] };
  const backend: NativeHarnessBackend = {
    async create(): Promise<unknown> {
      calls.create += 1;
      return await script.create();
    },
    async execute(runId: string): Promise<unknown> {
      calls.execute += 1;
      return script.execute === undefined ? { status: "completed" } : await script.execute(runId, runner);
    },
    async cancel(runId: string): Promise<unknown> {
      calls.cancel.push(runId);
      return script.cancel === undefined ? {} : await script.cancel(runId);
    },
  };
  return {
    backend,
    calls,
    setRunner(value: Runner): void {
      runner = value;
    },
  };
}

interface HarnessOptions {
  readonly root: string;
  readonly owner: NativeHarnessAccountingIdentity;
  readonly policy?: Partial<NativeHarnessDelegationLimits>;
  readonly prepare: (
    request: NativeHarnessPrepareRequest,
    context: NativeContext,
  ) => NativeHarnessPrepareResult | Promise<NativeHarnessPrepareResult>;
  readonly runner?: Runner;
  readonly context?: NativeContext;
  readonly getContext?: () => NativeContext;
  readonly native?: NativeState;
  readonly now?: () => number;
  readonly associate?: () => Promise<NativeHarnessAccountingIdentity>;
}

function harness(options: HarnessOptions): {
  readonly coordinator: ReturnType<typeof createNativeHarnessDelegation>;
  readonly associateCalls: Array<{
    readonly context: NativeContext;
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
    readonly limitsText: string;
  }>;
  readonly prepareCalls: NativeHarnessPrepareRequest[];
  readonly context: NativeContext;
  readonly nativeState: NativeState;
} {
  const policy = limitsFor(options.policy);
  const context = options.context ?? defaultContext();
  const nativeState = options.native ?? { current: true };
  const associateCalls: Array<{
    readonly context: NativeContext;
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
    readonly limitsText: string;
  }> = [];
  const prepareCalls: NativeHarnessPrepareRequest[] = [];
  const coordinator = createNativeHarnessDelegation({
    native: nativeControls(nativeState),
    policy,
    getContext: options.getContext ?? (() => context),
    prepare: (request, callbackContext) => {
      prepareCalls.push(request);
      request.guard();
      return options.prepare(request, callbackContext);
    },
    runner: options.runner ?? { run: async () => completed(0.01) },
    now: options.now ?? (() => CLOCK),
    enabled: true,
    accounting: {
      storageRoot: options.root,
      associate: async (callContext, signal, deadlineAt, normalizedLimitsText) => {
        associateCalls.push({
          context: callContext,
          signal,
          deadlineAt,
          limitsText: normalizedLimitsText,
        });
        return options.associate === undefined
          ? options.owner
          : await options.associate();
      },
    },
  });
  coordinators.push(coordinator);
  return { coordinator, associateCalls, prepareCalls, context, nativeState };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function invoke(
  coordinator: ReturnType<typeof createNativeHarnessDelegation>,
  callId: string,
  task = "do the bounded task",
  invocationSignal: AbortSignal = signal(),
): ReturnType<typeof coordinator.invoke> {
  return coordinator.invoke(callId, { task }, invocationSignal);
}

describe("native harness delegation durable accounting", () => {
  test("constructor is inert; fresh context, signal, deadline and fixed limits; one reserve for one call", async () => {
    const root = await makeRoot("base");
    const owner = identity("a");
    await createOwner(root, owner, limitsFor());
    const heldPrepare = deferred<NativeHarnessPrepareResult>();
    teardownReleases.push(() => heldPrepare.resolve({ ok: false, reason: "teardown" }));
    let prepareEntered = false;
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      runner: { run: async () => completed(0.1) },
      prepare: async (request) => {
        prepareEntered = true;
        be.setRunner(request.runner);
        return await heldPrepare.promise;
      },
    });

    expect(h.associateCalls).toHaveLength(0);
    expect(h.prepareCalls).toHaveLength(0);
    expect((await readCheckpoint(root, owner)).revision).toBe(0);
    expect(h.coordinator.inspect().accounting).toEqual({
      observation: "unloaded",
      revision: null,
      lastCheckpoint: null,
      reason: null,
    });

    const invocation = new AbortController();
    const first = invoke(h.coordinator, "call-1", "do the bounded task", invocation.signal);
    const replay = invoke(h.coordinator, "call-1", "do the bounded task", invocation.signal);
    expect(replay).toBe(first);
    await waitFor(() => prepareEntered, "prepare entry");
    const prepareRequest = h.prepareCalls[0]!;
    const reserved = await readCheckpoint(root, owner);
    expect(reserved.revision).toBe(1);
    expect(reserved.admissions).toHaveLength(1);
    const reservedRow = reserved.admissions[0]!;
    const expectedSourceAssociationSha256 = hash(JSON.stringify({
      observationId: prepareRequest.association.observationId,
      generation: prepareRequest.association.generation,
      sessionId: prepareRequest.association.sessionId,
      workspaceRoot: prepareRequest.association.workspaceRoot,
      toolCallId: prepareRequest.association.toolCallId,
      toolName: prepareRequest.association.toolName,
    }));
    expect(prepareRequest.accounting).toBeDefined();
    expect(Object.keys(prepareRequest.accounting!).sort()).toEqual([
      "admissionId",
      "admittedAt",
      "ownerId",
      "reserveRevision",
      "sourceAssociationSha256",
    ].sort());
    expect(prepareRequest.accounting).toEqual({
      ownerId: owner.ownerId,
      admissionId: reservedRow.admissionId,
      reserveRevision: reservedRow.reserveRevision,
      sourceAssociationSha256: expectedSourceAssociationSha256,
      admittedAt: reservedRow.admittedAt,
    });
    expect(reservedRow.sourceAssociationSha256).toBe(expectedSourceAssociationSha256);
    expect(reservedRow.admittedAt).toBe(CLOCK);
    expect(reservedRow.deadlineAt).toBe(prepareRequest.budget.deadlineAt);
    expect(reservedRow.deadlineAt).toBe(CLOCK + BASE_LIMITS.maxDurationMs);
    expect(reservedRow.allocatedUsd).toBe(prepareRequest.budget.maxCostUsd);
    expect(reservedRow.allocatedUsd).toBe(BASE_LIMITS.perRunUsd);
    expect(reservedRow.reserveRevision).toBe(1);
    expect(reservedRow.settlement).toBeNull();
    expect(h.associateCalls).toHaveLength(1);
    expect(h.associateCalls[0]!.context).toBe(h.context);
    expect(h.associateCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.associateCalls[0]!.signal).not.toBe(invocation.signal);
    expect(h.associateCalls[0]!.deadlineAt).toBe(CLOCK + BASE_LIMITS.maxDurationMs);
    expect(h.associateCalls[0]!.limitsText).toBe(limitsText(limitsFor()));

    const changedTask = await invoke(h.coordinator, "call-1", "different task", invocation.signal);
    expect(changedTask.resultKind).toBe("refused");
    const changedSignal = await invoke(h.coordinator, "call-1", "do the bounded task", signal());
    expect(changedSignal.resultKind).toBe("refused");
    expect(h.associateCalls).toHaveLength(1);

    heldPrepare.resolve({
      ok: true,
      backend: be.backend,
      accountingPrepared: preparedFor(1),
    });
    const result = await first;
    expect(result.resultKind).toBe("live");
    expect(result.outcome).toBe("backend-completed");
    expect(result.authorityFresh).toBe(true);
    expect(result.cost).toEqual({
      allocatedUsd: 1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
    });
    expect(be.calls).toEqual({ create: 1, execute: 1, cancel: [] });

    let checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(4);
    expect(checkpoint.admissions).toHaveLength(1);
    expect(checkpoint.admissions[0]!.reserveRevision).toBe(1);
    expect(checkpoint.admissions[0]!.prepared).toEqual(preparedFor(1));
    expect(checkpoint.admissions[0]!.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "known",
      observedUsd: 0.1,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 0.1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(h.coordinator.inspect().accounting?.observation).toBe("observed");
    expect(h.coordinator.inspect().accounting?.revision).toBe(4);
    expect(h.coordinator.inspect().lifetime.observedUsd).toBe(0.1);

    // A new coordinator over the same owner preserves the UUID row, count and
    // real amount; a no-dispatch admission adds a distinct admission id.
    const second = harness({
      root,
      owner,
      prepare: async () => ({ ok: false, reason: "no preparation" }),
    });
    const refused = await invoke(second.coordinator, "call-2");
    expect(refused.resultKind).toBe("live");
    expect(refused.outcome).toBe("refused");
    expect(second.associateCalls).toHaveLength(1);
    checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(6);
    expect(checkpoint.admissions).toHaveLength(2);
    expect(checkpoint.admissions[0]!.admissionId).not.toBe(checkpoint.admissions[1]!.admissionId);
    expect(checkpoint.admissions[1]!.settlement).toEqual({
      revision: 6,
      mode: "no-dispatch",
      observedUsd: 0,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 0.1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 2,
      budgetBlocked: false,
    });
  });

  test("missing owner, foreign identity and limit conflict refuse before prepare or create", async () => {
    const root = await makeRoot("refuse");
    const missing = harness({
      root: path.join(root, "absent"),
      owner: identity("b"),
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const missingResult = await invoke(missing.coordinator, "call-missing");
    expect(missingResult.resultKind).toBe("live");
    expect(missingResult.outcome).toBe("refused");
    expect(missingResult.reason).toContain("owner open");
    expect(missing.associateCalls).toHaveLength(1);
    expect(missing.prepareCalls).toHaveLength(0);
    expect(missing.coordinator.inspect().accounting?.observation).toBe("unavailable");

    const stored = identity("c");
    await createOwner(root, stored, limitsFor());
    const foreign = harness({
      root,
      owner: { ownerId: randomUUID(), selectorSha256: stored.selectorSha256 },
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const foreignResult = await invoke(foreign.coordinator, "call-foreign");
    expect(foreignResult.resultKind).toBe("live");
    expect(foreignResult.outcome).toBe("refused");
    expect(foreign.prepareCalls).toHaveLength(0);

    const conflict = identity("d");
    await createOwner(root, conflict, limitsFor({ perRunUsd: 0.5 }));
    const conflictHarness = harness({
      root,
      owner: conflict,
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const conflictResult = await invoke(conflictHarness.coordinator, "call-conflict");
    expect(conflictResult.resultKind).toBe("live");
    expect(conflictResult.outcome).toBe("refused");
    expect(conflictResult.reason).toContain("limits differ");
    expect(conflictHarness.prepareCalls).toHaveLength(0);
    expect(conflictHarness.coordinator.inspect().accounting?.observation).toBe("unavailable");
    expect(conflictHarness.coordinator.inspect().accounting?.observation).not.toBe("pending");
    expect((await readCheckpoint(root, conflict)).revision).toBe(0);
  });

  test("missing or malformed accountingPrepared refuses before create and settles no-dispatch", async () => {
    const root = await makeRoot("prepared");
    const owner = identity("e");
    await createOwner(root, owner, limitsFor());
    const be = scriptedBackend({ create: () => ({ runId: randomUUID() }) });
    let mode = 0;
    const h = harness({
      root,
      owner,
      prepare: async (request) => {
        be.setRunner(request.runner);
        if (mode === 0) {
          return { ok: true, backend: be.backend };
        }
        return {
          ok: true,
          backend: be.backend,
          accountingPrepared: {
            preparedRelativeRoot: "/absolute",
            storeRelativeRoot: "/absolute/store",
            inputManifestSha256: hash("b"),
            sourceDescriptorSha256: hash("c"),
          },
        };
      },
    });
    const missing = await invoke(h.coordinator, "call-missing");
    expect(missing.resultKind).toBe("live");
    expect(missing.outcome).toBe("refused");
    expect(missing.reason).toContain("accountingPrepared");
    mode = 1;
    const malformed = await invoke(h.coordinator, "call-malformed");
    expect(malformed.resultKind).toBe("live");
    expect(malformed.outcome).toBe("refused");
    expect(be.calls.create).toBe(0);
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.admissions.map((row) => row.settlement?.mode)).toEqual([
      "no-dispatch",
      "no-dispatch",
    ]);
    expect(checkpoint.admissions.every((row) => row.prepared === null && row.runId === null)).toBe(true);
  });

  test("unknown create stays charged and held; a known runId is cancelled immediately", async () => {
    const root = await makeRoot("create");
    const throwingOwner = identity("f");
    await createOwner(root, throwingOwner, limitsFor());
    const throwing = scriptedBackend({
      create: () => {
        throw new Error("create failed");
      },
    });
    const first = harness({
      root,
      owner: throwingOwner,
      prepare: async (request) => {
        throwing.setRunner(request.runner);
        return { ok: true, backend: throwing.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const firstSignal = signal();
    const failed = await invoke(first.coordinator, "call-create", "do the bounded task", firstSignal);
    expect(failed.outcome).toBe("unknown");
    // Execute was never dispatched, so the original execution-state shape
    // stays "not-started" while durable charge/held and unknown outcome remain.
    expect(failed.executionState).toBe("not-started");
    let checkpoint = await readCheckpoint(root, throwingOwner);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 3,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    const again = await invoke(first.coordinator, "call-create", "do the bounded task", firstSignal);
    expect(again.resultKind).toBe("historical");
    expect(throwing.calls.create).toBe(1);

    const runId = randomUUID();
    const execution = deferred<unknown>();
    teardownReleases.push(() => execution.resolve({ status: "completed" }));
    const cancelling = scriptedBackend({
      create: () => ({ runId }),
      execute: async () => await execution.promise,
    });
    const otherOwner = identity("h");
    await createOwner(root, otherOwner, limitsFor());
    const live = harness({
      root,
      owner: otherOwner,
      prepare: async (request) => {
        cancelling.setRunner(request.runner);
        return { ok: true, backend: cancelling.backend, accountingPrepared: preparedFor(2) };
      },
    });
    const pending = invoke(live.coordinator, "call-cancel");
    await waitFor(() => cancelling.calls.execute === 1, "execute entry");
    live.coordinator.cancel("call-cancel");
    await waitFor(() => cancelling.calls.cancel.length === 1, "backend cancel");
    expect(cancelling.calls.cancel).toEqual([runId]);
    execution.resolve({ status: "completed" });
    const cancelled = await pending;
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.authorityFresh).toBe(false);
    checkpoint = await readCheckpoint(root, otherOwner);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(checkpoint).activeOperations).toBe(0);
  });

  test("a created run that fails bindRun is not executed and is cancelled", async () => {
    const root = await makeRoot("link");
    const owner = identity("i");
    await createOwner(root, owner, limitsFor());
    const be = scriptedBackend({
      create: () => ({ runId: "run-not-a-uuid" }),
      execute: () => {
        throw new Error("execute must not run");
      },
    });
    const h = harness({
      root,
      owner,
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const result = await invoke(h.coordinator, "call-link");
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("not-started");
    expect(be.calls.execute).toBe(0);
    expect(be.calls.cancel).toEqual(["run-not-a-uuid"]);
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.admissions[0]!.runId).toBeNull();
    expect(checkpoint.admissions[0]!.settlement?.mode).toBe("unknown");
    expect(checkpoint.admissions[0]!.settlement?.concurrencyHeld).toBe(true);
  });

  test("a cancellation requested before create resolves cancels the run before held bindRun", async () => {
    const root = await makeRoot("held-link");
    const owner = identity("i2");
    await createOwner(root, owner, limitsFor());
    const entered = deferred<void>();
    const release = deferred<void>();
    teardownReleases.push(() => release.resolve(undefined));
    let bindWrites = 0;
    activeHook = async (event) => {
      if (event.revision !== 3) return;
      bindWrites += 1;
      entered.resolve(undefined);
      await release.promise;
    };
    const created = deferred<unknown>();
    teardownReleases.push(() => created.resolve({ runId: randomUUID() }));
    const be = scriptedBackend({
      create: async () => await created.promise,
      execute: () => {
        throw new Error("execute must not run");
      },
    });
    const h = harness({
      root,
      owner,
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const pending = invoke(h.coordinator, "call-held-bind");
    await waitFor(() => be.calls.create === 1, "create entry");
    h.coordinator.cancel("call-held-bind");
    expect(be.calls.cancel).toEqual([]);

    const runId = randomUUID();
    created.resolve({ runId });
    await entered.promise;
    // The known run is cancellable before the durable link await completes.
    expect(be.calls.cancel).toEqual([runId]);
    expect(be.calls.execute).toBe(0);
    release.resolve(undefined);
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
    expect(bindWrites).toBe(1);
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(4);
    expect(checkpoint.admissions[0]!.runId).toBe(runId);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: false,
    });
  });

  test("preparation receives the fresh post-reserve main context", async () => {
    const root = await makeRoot("fresh-context");
    const owner = identity("i3");
    await createOwner(root, owner, limitsFor());
    const contextA = defaultContext();
    const contextB = defaultContext();
    let current = contextA;
    const entered = deferred<void>();
    const release = deferred<void>();
    teardownReleases.push(() => release.resolve(undefined));
    activeHook = async (event) => {
      if (event.revision !== 1) return;
      entered.resolve(undefined);
      await release.promise;
    };
    const preparedContexts: NativeContext[] = [];
    const h = harness({
      root,
      owner,
      getContext: () => current,
      prepare: async (_request, context) => {
        preparedContexts.push(context);
        return { ok: false, reason: "stop after context proof" };
      },
    });
    const pending = invoke(h.coordinator, "call-context");
    await entered.promise;
    current = contextB;
    release.resolve(undefined);
    const result = await pending;
    expect(result.resultKind).toBe("live");
    expect(result.outcome).toBe("refused");
    expect(preparedContexts).toEqual([contextB]);
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(2);
    expect(checkpoint.admissions[0]!.settlement?.mode).toBe("no-dispatch");
  });

  test("projection modes no-dispatch, known, unknown-held and unknown-released are real checkpoints", async () => {
    const root = await makeRoot("modes");

    const noDispatchOwner = identity("j");
    await createOwner(root, noDispatchOwner, limitsFor());
    const noDispatch = harness({
      root,
      owner: noDispatchOwner,
      prepare: async () => ({ ok: false, reason: "preparation refused" }),
    });
    expect((await invoke(noDispatch.coordinator, "call-nd")).outcome).toBe("refused");
    expect(projectNativeHarnessAccounting(await readCheckpoint(root, noDispatchOwner))).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });

    const knownOwner = identity("k");
    await createOwner(root, knownOwner, limitsFor());
    const knownBackend = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const known = harness({
      root,
      owner: knownOwner,
      runner: { run: async () => completed(0.1) },
      prepare: async (request) => {
        knownBackend.setRunner(request.runner);
        return { ok: true, backend: knownBackend.backend, accountingPrepared: preparedFor(1) };
      },
    });
    expect((await invoke(known.coordinator, "call-known")).outcome).toBe("backend-completed");
    expect(projectNativeHarnessAccounting(await readCheckpoint(root, knownOwner))).toEqual({
      accountedUsd: 0.1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });

    const heldFalseOwner = identity("l");
    await createOwner(root, heldFalseOwner, limitsFor());
    const settledBackend = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: () => ({ status: "completed" }),
    });
    const heldFalse = harness({
      root,
      owner: heldFalseOwner,
      prepare: async (request) => {
        settledBackend.setRunner(request.runner);
        return { ok: true, backend: settledBackend.backend, accountingPrepared: preparedFor(1) };
      },
    });
    expect((await invoke(heldFalse.coordinator, "call-held-false")).outcome).toBe("backend-completed");
    const heldFalseCheckpoint = await readCheckpoint(root, heldFalseOwner);
    expect(heldFalseCheckpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(heldFalseCheckpoint)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });

    const heldTrueOwner = identity("m");
    await createOwner(root, heldTrueOwner, limitsFor());
    const failedBackend = scriptedBackend({
      create: () => {
        throw new Error("create unknown");
      },
    });
    const heldTrue = harness({
      root,
      owner: heldTrueOwner,
      prepare: async (request) => {
        failedBackend.setRunner(request.runner);
        return { ok: true, backend: failedBackend.backend, accountingPrepared: preparedFor(1) };
      },
    });
    expect((await invoke(heldTrue.coordinator, "call-held-true")).outcome).toBe("unknown");
    const heldTrueCheckpoint = await readCheckpoint(root, heldTrueOwner);
    expect(heldTrueCheckpoint.admissions[0]!.settlement).toEqual({
      revision: 3,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    expect(projectNativeHarnessAccounting(heldTrueCheckpoint)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });
  });

  test("retained-operation exhaustion refuses the seventeenth admission from a new factory", async () => {
    const root = await makeRoot("retained");
    const owner = identity("n");
    await createOwner(root, owner, limitsFor());
    const h = harness({
      root,
      owner,
      prepare: async () => ({ ok: false, reason: "no preparation" }),
    });
    for (let index = 0; index < 16; index += 1) {
      const result = await invoke(h.coordinator, `call-fill-${index}`);
      expect(result.outcome).toBe("refused");
    }
    expect(h.associateCalls).toHaveLength(16);
    expect(h.prepareCalls).toHaveLength(16);
    const local = await invoke(h.coordinator, "call-fill-17");
    expect(local.resultKind).toBe("refused");
    expect(h.associateCalls).toHaveLength(16);
    const fresh = harness({
      root,
      owner,
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const refused = await invoke(fresh.coordinator, "call-fill-17");
    expect(refused.resultKind).toBe("live");
    expect(refused.outcome).toBe("refused");
    expect(refused.reason).toContain("retained-operation limit");
    expect(fresh.associateCalls).toHaveLength(1);
    expect(fresh.prepareCalls).toHaveLength(0);
    expect((await readCheckpoint(root, owner)).admissions).toHaveLength(16);
  });

  test("lifetime exhaustion refuses the sixth admission only after a fresh exact-open", async () => {
    const root = await makeRoot("lifetime");
    const owner = identity("o");
    await createOwner(root, owner, limitsFor());
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: () => ({ status: "completed" }),
    });
    const h = harness({
      root,
      owner,
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    for (let index = 0; index < 5; index += 1) {
      expect((await invoke(h.coordinator, `call-budget-${index}`)).outcome).toBe("backend-completed");
    }
    expect(projectNativeHarnessAccounting(await readCheckpoint(root, owner)).accountedUsd).toBe(5);
    const fresh = harness({
      root,
      owner,
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const refused = await invoke(fresh.coordinator, "call-budget-5");
    expect(refused.resultKind).toBe("live");
    expect(refused.outcome).toBe("refused");
    expect(refused.reason).toContain("lifetime budget");
    expect(fresh.prepareCalls).toHaveLength(0);
    expect((await readCheckpoint(root, owner)).admissions).toHaveLength(5);
  });

  test("worker overspend persists blockBudget before settlement and blocks a fresh coordinator", async () => {
    const root = await makeRoot("block");
    const owner = identity("p");
    await createOwner(root, owner, limitsFor());
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId, 0.2));
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      runner: { run: async () => completed(0.4) },
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const result = await invoke(h.coordinator, "call-overspend");
    expect(result.outcome).toBe("backend-completed");
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.budgetBlock).toEqual({
      admissionId: checkpoint.admissions[0]!.admissionId,
      revision: 4,
      reason: "observed-worker-overspend",
    });
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 5,
      mode: "known",
      observedUsd: 0.4,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(checkpoint).budgetBlocked).toBe(true);

    const fresh = harness({
      root,
      owner,
      prepare: async () => {
        throw new Error("prepare must not run");
      },
    });
    const refused = await invoke(fresh.coordinator, "call-after-block");
    expect(refused.resultKind).toBe("live");
    expect(refused.outcome).toBe("refused");
    expect(refused.reason).toContain("blocked");
    expect(fresh.prepareCalls).toHaveLength(0);
    expect((await readCheckpoint(root, owner)).admissions).toHaveLength(1);
  });

  test("a held settle write does not resolve early, gives unknown, and never attempts a second settlement", async () => {
    const root = await makeRoot("pending");
    const owner = identity("q");
    await createOwner(root, owner, limitsFor());
    const entered = deferred<void>();
    const release = deferred<void>();
    teardownReleases.push(() => release.resolve(undefined));
    let settleWrites = 0;
    activeHook = async (event) => {
      if (event.revision !== 4) return;
      settleWrites += 1;
      entered.resolve(undefined);
      await release.promise;
    };
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      runner: { run: async () => completed(0.1) },
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const pending = invoke(h.coordinator, "call-pending");
    await entered.promise;
    h.coordinator.cancel("call-pending");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick(15);
    expect(settled).toBe(false);
    const result = await pending;
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.authorityFresh).toBe(false);
    expect(h.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
    expect(h.coordinator.inspect().accounting?.observation).toBe("unavailable");

    release.resolve(undefined);
    await waitForAsync(async () => {
      const checkpoint = await readCheckpoint(root, owner);
      return checkpoint.admissions[0]!.settlement !== null;
    }, "real settlement bytes");
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(4);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "known",
      observedUsd: 0.1,
      concurrencyHeld: false,
    });
    await tick(20);
    expect(settleWrites).toBe(1);
    expect((await readCheckpoint(root, owner)).revision).toBe(4);
    expect(result.outcome).toBe("unknown");
  });

  test("a write that completed but whose acknowledgement throws retains the real primary", async () => {
    const root = await makeRoot("ambiguous");
    const owner = identity("r");
    await createOwner(root, owner, limitsFor());
    let settleWrites = 0;
    activeHook = (event) => {
      if (event.revision !== 4) return;
      settleWrites += 1;
      throw new Error("acknowledgement failed");
    };
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      runner: { run: async () => completed(0.1) },
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const result = await invoke(h.coordinator, "call-ambiguous");
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(h.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
    expect(h.coordinator.inspect().accounting?.observation).toBe("unavailable");
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(4);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "known",
      observedUsd: 0.1,
      concurrencyHeld: false,
    });
    await tick(20);
    expect(settleWrites).toBe(1);
    expect((await readCheckpoint(root, owner)).revision).toBe(4);
  });

  test("holding trusted prepare beyond the grace window keeps unknown held with no late settlement", async () => {
    const root = await makeRoot("prepare");
    const owner = identity("s");
    await createOwner(root, owner, limitsFor());
    const held = deferred<NativeHarnessPrepareResult>();
    teardownReleases.push(() => held.resolve({ ok: false, reason: "teardown" }));
    let prepareEntered = false;
    const be = scriptedBackend({ create: () => ({ runId: randomUUID() }) });
    const h = harness({
      root,
      owner,
      prepare: async (request) => {
        prepareEntered = true;
        be.setRunner(request.runner);
        return await held.promise;
      },
    });
    const pending = invoke(h.coordinator, "call-prepare");
    await waitFor(() => prepareEntered, "prepare entry");
    h.coordinator.cancel("call-prepare");
    const result = await pending;
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.authorityFresh).toBe(false);
    expect(h.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
    await waitForAsync(async () => (await readCheckpoint(root, owner)).revision === 2, "terminal settle bytes");
    let checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(2);
    expect(checkpoint.admissions[0]!.prepared).toBeNull();
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 2,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });

    held.resolve({ ok: true, backend: be.backend, accountingPrepared: preparedFor(1) });
    await tick(30);
    expect(be.calls.create).toBe(0);
    expect(be.calls.execute).toBe(0);
    checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(2);
    expect(checkpoint.admissions[0]!.settlement?.mode).toBe("unknown");
    expect(h.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
    expect(h.coordinator.inspect().activeOperations).toBe(1);
  });

  test("a post-settlement authority change downgrades publication without losing known cost", async () => {
    const root = await makeRoot("late-authority");
    const owner = identity("t");
    await createOwner(root, owner, limitsFor());
    const context = defaultContext();
    activeHook = (event) => {
      if (event.revision === 4) {
        (context.agent as { kind: string }).kind = "sub";
      }
    };
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        await runner!.run(workerRequest(runId));
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      context,
      runner: { run: async () => completed(0.1) },
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const result = await invoke(h.coordinator, "call-late");
    expect(result.outcome).toBe("incomplete");
    expect(result.authorityFresh).toBe(false);
    expect(result.cost).toEqual({
      allocatedUsd: 1,
      observedUsd: 0.1,
      unknownUsd: 0,
      overspendUsd: 0,
    });
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 4,
      mode: "known",
      observedUsd: 0.1,
      concurrencyHeld: false,
    });
  });

  test("two coordinators sharing one owner do not use a stale active cache as refusal authority", async () => {
    const root = await makeRoot("cache");
    const owner = identity("u");
    await createOwner(root, owner, limitsFor());
    const execution = deferred<unknown>();
    teardownReleases.push(() => execution.resolve({ status: "completed" }));
    const runId = randomUUID();
    const firstBackend = scriptedBackend({
      create: () => ({ runId }),
      execute: async () => await execution.promise,
    });
    const first = harness({
      root,
      owner,
      prepare: async (request) => {
        firstBackend.setRunner(request.runner);
        return { ok: true, backend: firstBackend.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const active = invoke(first.coordinator, "call-active");
    await waitFor(() => firstBackend.calls.execute === 1, "first execute");

    const secondPrepared = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: () => ({ status: "completed" }),
    });
    const second = harness({
      root,
      owner,
      prepare: async (request) => {
        secondPrepared.setRunner(request.runner);
        return { ok: true, backend: secondPrepared.backend, accountingPrepared: preparedFor(2) };
      },
    });
    const refusedWhileHeld = await invoke(second.coordinator, "call-second-held");
    expect(refusedWhileHeld.resultKind).toBe("live");
    expect(refusedWhileHeld.outcome).toBe("refused");
    expect(refusedWhileHeld.reason).toContain("concurrency");
    expect(second.prepareCalls).toHaveLength(0);
    expect(second.coordinator.inspect().accounting?.observation).toBe("observed");

    first.coordinator.cancel("call-active");
    await waitFor(() => firstBackend.calls.cancel.length === 1, "first cancel");
    execution.resolve({ status: "completed" });
    expect((await active).outcome).toBe("cancelled");
    expect(projectNativeHarnessAccounting(await readCheckpoint(root, owner)).activeOperations).toBe(0);

    const admitted = await invoke(second.coordinator, "call-second");
    expect(admitted.resultKind).toBe("live");
    expect(admitted.outcome).toBe("backend-completed");
    expect(secondPrepared.calls.create).toBe(1);
    const checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.admissions).toHaveLength(2);
    expect(projectNativeHarnessAccounting(checkpoint).activeOperations).toBe(0);
  });

  test("two coordinators opened at revision zero race one real reserve; one prepare settles no-dispatch", async () => {
    const root = await makeRoot("cas");
    const owner = identity("v");
    await createOwner(root, owner, limitsFor());

    const openedRevisions: number[] = [];
    const bothOpened = deferred<void>();
    let openCount = 0;
    activeOpenBarrier = async (revision) => {
      openedRevisions.push(revision);
      openCount += 1;
      if (openCount === 2) bothOpened.resolve(undefined);
      await bothOpened.promise;
    };
    teardownReleases.push(() => bothOpened.resolve(undefined));

    let prepareEntries = 0;
    const heldPrepare = deferred<NativeHarnessPrepareResult>();
    teardownReleases.push(() => heldPrepare.resolve({ ok: false, reason: "teardown" }));
    const be = scriptedBackend({ create: () => ({ runId: randomUUID() }) });
    const prepare = async (request: NativeHarnessPrepareRequest): Promise<NativeHarnessPrepareResult> => {
      prepareEntries += 1;
      be.setRunner(request.runner);
      return await heldPrepare.promise;
    };
    const first = harness({ root, owner, prepare });
    const second = harness({ root, owner, prepare });
    const invocation = new AbortController();
    const firstCall = invoke(first.coordinator, "call-cas-a", "first task", invocation.signal);
    const secondCall = invoke(second.coordinator, "call-cas-b", "second task", invocation.signal);
    const raced = await Promise.race([
      firstCall.then((result) => ({ harness: first, result })),
      secondCall.then((result) => ({ harness: second, result })),
    ]);
    expect(raced.result.resultKind).toBe("live");
    expect(raced.result.outcome).toBe("refused");
    const winner = raced.harness === first ? second : first;

    expect(openedRevisions).toEqual([0, 0]);
    expect(prepareEntries).toBe(1);
    expect(raced.harness.prepareCalls).toHaveLength(0);
    expect(winner.prepareCalls).toHaveLength(1);
    expect(be.calls).toEqual({ create: 0, execute: 0, cancel: [] });

    let checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(1);
    expect(checkpoint.admissions).toHaveLength(1);
    expect(checkpoint.admissions[0]!.reserveRevision).toBe(1);
    expect(checkpoint.admissions[0]!.settlement).toBeNull();
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });

    heldPrepare.resolve({ ok: false, reason: "deny after observed race" });
    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    const winnerResult = winner === first ? firstResult : secondResult;
    expect(winnerResult.resultKind).toBe("live");
    expect(winnerResult.outcome).toBe("refused");
    expect(raced.harness.prepareCalls).toHaveLength(0);
    expect(winner.prepareCalls).toHaveLength(1);

    checkpoint = await readCheckpoint(root, owner);
    expect(checkpoint.revision).toBe(2);
    expect(checkpoint.admissions).toHaveLength(1);
    expect(checkpoint.admissions[0]!.reserveRevision).toBe(1);
    expect(checkpoint.admissions[0]!.runId).toBeNull();
    expect(checkpoint.admissions[0]!.prepared).toBeNull();
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: 2,
      mode: "no-dispatch",
      observedUsd: 0,
      concurrencyHeld: false,
    });
    expect(projectNativeHarnessAccounting(checkpoint)).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(be.calls).toEqual({ create: 0, execute: 0, cancel: [] });
  });

  function syntheticLifecycleBridge(): Record<string, unknown> {
    // Clearly synthetic event-shaped protocol input: no OS or actual-worker
    // evidence is claimed by this unit fixture.
    return Object.freeze({
      innerDeadlineAt: CLOCK + 100_000,
      assertAdvanceCurrent(): void {},
      async checkpoint(_event: unknown, assertPersistable: () => void): Promise<void> {
        assertPersistable();
      },
    });
  }

  async function bridgeInvocation(
    ignorePort: boolean,
  ): Promise<{
    readonly result: Awaited<ReturnType<ReturnType<typeof createNativeHarnessDelegation>["invoke"]>>;
    readonly checkpoint: NativeHarnessAccountingCheckpoint;
  }> {
    const root = await makeRoot(ignorePort ? "ignored-port" : "mismatched-ack");
    const owner = identity(ignorePort ? "ip" : "ma");
    await createOwner(root, owner, limitsFor());
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, runner) => {
        const request = workerRequest(runId) as WorkerRequest & Record<string, unknown>;
        request.nativeHarnessLifecycle = syntheticLifecycleBridge();
        // The opt-in Runner decides whether to consume the translated port.
        // The ignored case returns an ordinary completed result without it.
        await runner!.run(request);
        return { status: "completed" };
      },
    });
    const syntheticRunner: Runner = {
      async run(request: WorkerRequest): Promise<WorkerResult> {
        const lifecycle = request.lifecycle as unknown as {
          checkpoint(event: unknown, assert: () => void): Promise<void>;
        };
        if (!ignorePort) {
          const pass = (): void => {};
          await lifecycle.checkpoint(Object.freeze({
            type: "cleanupObserved",
            runId: request.runId,
            stage: "baseline",
            spawnAttempted: false,
            closeSeen: false,
            closeCode: null,
            closeSignal: null,
            groupObservation: "unknown",
            groupObservedAt: null,
            hostWorkSettled: true,
            approvalWorkSettled: true,
            logFlush: "success",
          }), pass);
          await lifecycle.checkpoint(Object.freeze({
            type: "resultObserved",
            runId: request.runId,
            stage: "baseline",
            resultSha256: "0".repeat(64),
            status: "completed",
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
            startedAt: "2026-11-17T00:00:00.000Z",
            endedAt: "2026-11-17T00:00:01.000Z",
            usageEstimated: false,
          }), pass);
        }
        return completed(0.1);
      },
    };
    const h = harness({
      root,
      owner,
      runner: syntheticRunner,
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    const result = await invoke(h.coordinator, `call-${ignorePort ? "ignored" : "mismatch"}`);
    return { result, checkpoint: await readCheckpoint(root, owner) };
  }

  test("an ignored opt-in port remains intended/unknown with the full reservation", async () => {
    const { result, checkpoint } = await bridgeInvocation(true);
    expect(result.outcome).toBe("unknown");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(1);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: checkpoint.admissions[0]!.settlement!.revision,
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
  }, 10_000);

  test("a mismatched acknowledged result scalar/digest keeps unknown occupancy", async () => {
    const { result, checkpoint } = await bridgeInvocation(false);
    expect(result.outcome).toBe("unknown");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(1);
    expect(checkpoint.admissions[0]!.settlement?.mode).toBe("unknown");
    expect(checkpoint.admissions[0]!.settlement?.concurrencyHeld).toBe(true);
  }, 10_000);

  interface TrackedBridge {
    readonly bridge: Record<string, unknown>;
    readonly calls: unknown[];
  }

  function trackedLifecycleBridge(
    onCheckpoint?: (event: Record<string, unknown>, assertPersistable: () => void) => void | Promise<void>,
  ): TrackedBridge {
    const calls: unknown[] = [];
    const bridge = Object.freeze({
      innerDeadlineAt: CLOCK + 100_000,
      assertAdvanceCurrent(): void {},
      async checkpoint(event: unknown, assertPersistable: () => void): Promise<void> {
        calls.push(event);
        if (onCheckpoint === undefined) assertPersistable();
        else await onCheckpoint(event as Record<string, unknown>, assertPersistable);
      },
    });
    return { bridge, calls };
  }

  interface LifecycleSetupOptions {
    readonly policy?: Partial<NativeHarnessDelegationLimits>;
    readonly now?: () => number;
    readonly runner?: Runner;
    readonly execute?: (
      runId: string,
      guarded: Runner,
      request: WorkerRequest & Record<string, unknown>,
    ) => Promise<unknown>;
  }

  async function setupLifecycleDispatch(
    label: string,
    bridge: Record<string, unknown>,
    options: LifecycleSetupOptions = {},
  ): Promise<{
    readonly root: string;
    readonly owner: NativeHarnessAccountingIdentity;
    readonly coordinator: ReturnType<typeof createNativeHarnessDelegation>;
    readonly requests: WorkerRequest[];
    readonly start: (callId?: string) => ReturnType<ReturnType<typeof createNativeHarnessDelegation>["invoke"]>;
  }> {
    const root = await makeRoot(label);
    const owner = identity(label);
    await createOwner(root, owner, limitsFor(options.policy));
    const requests: WorkerRequest[] = [];
    const be = scriptedBackend({
      create: () => ({ runId: randomUUID() }),
      execute: async (runId, guarded) => {
        const request = workerRequest(runId) as WorkerRequest & Record<string, unknown>;
        request.nativeHarnessLifecycle = bridge;
        requests.push(request);
        if (options.execute !== undefined) return options.execute(runId, guarded!, request);
        await guarded!.run(request);
        return { status: "completed" };
      },
    });
    const h = harness({
      root,
      owner,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.now === undefined ? {} : { now: options.now }),
      runner: options.runner ?? { run: async () => completed(0.02) },
      prepare: async (request) => {
        be.setRunner(request.runner);
        return { ok: true, backend: be.backend, accountingPrepared: preparedFor(1) };
      },
    });
    return {
      root,
      owner,
      coordinator: h.coordinator,
      requests,
      start: (callId = `call-${label}`) => invoke(h.coordinator, callId),
    };
  }

  const SYNTHETIC_CONFIG_SHA256 = "c".repeat(64);
  const SYNTHETIC_APPENDIX_SHA256 = "d".repeat(64);

  function lifecycleCleanupEvent(
    request: WorkerRequest,
  ): Record<string, unknown> {
    return {
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
  }

  function lifecycleResultEvent(
    request: WorkerRequest,
    result: WorkerResult,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      type: "resultObserved",
      runId: request.runId,
      stage: request.stage,
      resultSha256: canonicalResultSha256(result),
      status: result.status,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
      },
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      usageEstimated: result.usageEstimated === true,
      ...overrides,
    };
  }

  function lifecyclePort(request: WorkerRequest): {
    checkpoint(event: unknown, assertPersistable: () => void): Promise<void>;
    assertAdvanceCurrent(): void;
  } {
    return request.lifecycle as unknown as {
      checkpoint(event: unknown, assertPersistable: () => void): Promise<void>;
      assertAdvanceCurrent(): void;
    };
  }

  test("split result mismatch: exact event scalars with a wrong digest refuses", async () => {
    const actual = completed(0.1);
    const tracked = trackedLifecycleBridge();
    const runner: Runner = {
      async run(request): Promise<WorkerResult> {
        const port = lifecyclePort(request);
        await port.checkpoint(lifecycleCleanupEvent(request), () => {});
        await port.checkpoint(lifecycleResultEvent(request, actual, {
          resultSha256: "0".repeat(64),
        }), () => {});
        return actual;
      },
    };
    const setup = await setupLifecycleDispatch("split-digest", tracked.bridge, { runner });
    const result = await setup.start();
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cost).toEqual({
      allocatedUsd: 1,
      observedUsd: null,
      unknownUsd: 1,
      overspendUsd: 0,
    });
    expect(tracked.calls).toHaveLength(2);
    expect(setup.requests).toHaveLength(1);
    const checkpoint = await readCheckpoint(setup.root, setup.owner);
    expect(checkpoint.admissions[0]!.settlement).toMatchObject({
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
  }, 10_000);

  test("split result mismatch: exact canonical digest with one wrong scalar refuses", async () => {
    const actual = completed(0.1);
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly overrides: Record<string, unknown>;
    }> = [
      { name: "cost", overrides: { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } } },
      { name: "status", overrides: { status: "failed" } },
      { name: "time", overrides: { endedAt: "2026-11-17T00:00:02.000Z" } },
    ];
    for (const variant of variants) {
      const tracked = trackedLifecycleBridge();
      const runner: Runner = {
        async run(request): Promise<WorkerResult> {
          const port = lifecyclePort(request);
          await port.checkpoint(lifecycleCleanupEvent(request), () => {});
          await port.checkpoint(lifecycleResultEvent(request, actual, variant.overrides), () => {});
          return actual;
        },
      };
      const setup = await setupLifecycleDispatch(`split-${variant.name}`, tracked.bridge, { runner });
      const result = await setup.start(`call-split-${variant.name}`);
      expect(result.outcome, variant.name).toBe("unknown");
      expect(result.executionState, variant.name).toBe("pending-unknown");
      expect(result.cost.unknownUsd, variant.name).toBe(1);
      expect(result.cost.observedUsd, variant.name).toBeNull();
      expect(tracked.calls, variant.name).toHaveLength(2);
      expect(setup.requests, variant.name).toHaveLength(1);
      const checkpoint = await readCheckpoint(setup.root, setup.owner);
      expect(checkpoint.admissions[0]!.settlement?.concurrencyHeld, variant.name).toBe(true);
      expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld, variant.name).toBe(true);
    }
  }, 20_000);

  test("a swallowed sink failure sticks: later valid-looking events make no sink calls", async () => {
    const actual = completed(0.1);
    const tracked = trackedLifecycleBridge((event) => {
      if (event.type === "preLaunch") throw new Error("synthetic sink refusal");
    });
    let checkpointAttempts = 0;
    const runner: Runner = {
      async run(request): Promise<WorkerResult> {
        const port = lifecyclePort(request);
        const preLaunch = {
          type: "preLaunch",
          runId: request.runId,
          stage: request.stage,
          runtimeRoot: WORKSPACE,
          timeoutMs: 1000,
          configSha256: SYNTHETIC_CONFIG_SHA256,
          appendixSha256: SYNTHETIC_APPENDIX_SHA256,
        };
        for (const event of [
          preLaunch,
          lifecycleCleanupEvent(request),
          lifecycleResultEvent(request, actual),
        ]) {
          checkpointAttempts += 1;
          try {
            await port.checkpoint(event, () => {});
          } catch {
            // The Runner deliberately swallows the first refusal and offers
            // later valid-looking events.
          }
        }
        return actual;
      },
    };
    const setup = await setupLifecycleDispatch("swallowed", tracked.bridge, { runner });
    const result = await setup.start();
    expect(checkpointAttempts).toBe(3);
    expect(tracked.calls).toHaveLength(1);
    expect((tracked.calls[0] as Record<string, unknown>).type).toBe("preLaunch");
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(1);
    const checkpoint = await readCheckpoint(setup.root, setup.owner);
    expect(checkpoint.admissions[0]!.settlement).toMatchObject({
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
  }, 10_000);

  test("a held checkpoint released after cancellation refuses advancement but allows cleanup persistence", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const tracked = trackedLifecycleBridge(async (event, assertPersistable) => {
      if (event.type === "preLaunch") {
        entered.resolve(undefined);
        await release.promise;
      }
      assertPersistable();
    });
    const observed: { advanceError: string | null } = { advanceError: null };
    const runner: Runner = {
      async run(request): Promise<WorkerResult> {
        const port = lifecyclePort(request);
        await port.checkpoint({
          type: "preLaunch",
          runId: request.runId,
          stage: request.stage,
          runtimeRoot: WORKSPACE,
          timeoutMs: 1000,
          configSha256: SYNTHETIC_CONFIG_SHA256,
          appendixSha256: SYNTHETIC_APPENDIX_SHA256,
        }, () => {});
        try {
          port.assertAdvanceCurrent();
        } catch (error) {
          observed.advanceError = (error as Error).message;
        }
        // Cleanup persistence is owned by the original per-operation
        // assertion, not resurrected execution authority.
        await port.checkpoint(lifecycleCleanupEvent(request), () => {});
        return completed(0.1);
      },
    };
    const setup = await setupLifecycleDispatch("held-cancel", tracked.bridge, { runner });
    const pending = setup.start("call-held-cancel");
    await entered.promise;
    setup.coordinator.cancel("call-held-cancel");
    release.resolve(undefined);
    const result = await pending;
    expect(observed.advanceError).toContain("cancelled");
    expect(tracked.calls.map((event) => (event as Record<string, unknown>).type))
      .toEqual(["preLaunch", "cleanupObserved"]);
    expect(result.outcome).toBe("cancelled");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cost.observedUsd).toBeNull();
    expect(result.cost.unknownUsd).toBe(1);
    const checkpoint = await readCheckpoint(setup.root, setup.owner);
    expect(checkpoint.admissions[0]!.settlement?.concurrencyHeld).toBe(true);
  }, 10_000);

  test("late lifecycle completion after published pending-unknown changes no accounting", async () => {
    const actual = completed(0.1);
    const tracked = trackedLifecycleBridge();
    const workerStarted = deferred<void>();
    const workerResult = deferred<WorkerResult>();
    const holdExecution = deferred<unknown>();
    const guardedState: { promise: Promise<WorkerResult> | null } = { promise: null };
    let released = false;
    const releaseAll = (): void => {
      if (released) return;
      released = true;
      workerResult.resolve(actual);
      holdExecution.resolve({ status: "completed" });
    };
    teardownReleases.push(releaseAll);
    const setup = await setupLifecycleDispatch("late-completion", tracked.bridge, {
      policy: { cleanupGraceMs: 20 },
      runner: {
        async run(request): Promise<WorkerResult> {
          const port = lifecyclePort(request);
          // Acknowledge the exact matching cleanup and result first. The only
          // remaining unknown source at publication is the delayed settlement.
          await port.checkpoint(lifecycleCleanupEvent(request), () => {});
          await port.checkpoint(lifecycleResultEvent(request, actual), () => {});
          workerStarted.resolve(undefined);
          return await workerResult.promise;
        },
      },
      execute: async (_runId, guarded, request) => {
        guardedState.promise = guarded.run(request);
        void guardedState.promise.catch(() => undefined);
        return await holdExecution.promise;
      },
    });
    const pending = setup.start("call-late-completion");
    await workerStarted.promise;
    expect(tracked.calls).toHaveLength(2);
    // Cancellation starts the single original cleanup-grace timer. The
    // acknowledged worker still stays in flight past publication.
    setup.coordinator.cancel("call-late-completion");
    const result = await pending;
    expect(result.outcome).toBe("unknown");
    expect(result.executionState).toBe("pending-unknown");
    expect(result.cost.unknownUsd).toBe(1);
    expect(result.cost.observedUsd).toBeNull();
    expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
    await waitForAsync(async () =>
      (await readCheckpoint(setup.root, setup.owner)).admissions[0]!.settlement !== null,
    "published unknown settlement bytes");
    const before = await readCheckpoint(setup.root, setup.owner);
    expect(before.admissions[0]!.settlement).toMatchObject({
      mode: "unknown",
      observedUsd: null,
      concurrencyHeld: true,
    });
    try {
      // Release the exact acknowledged result and await the actual original
      // guarded dispatch promise before claiming the late branch observed it.
      workerResult.resolve(actual);
      await guardedState.promise!;
      const after = await readCheckpoint(setup.root, setup.owner);
      expect(after).toEqual(before);
      expect(tracked.calls).toHaveLength(2);
      expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(true);
      expect(setup.coordinator.inspect().operations[0]!.cost.unknownUsd).toBe(1);
      expect(setup.coordinator.inspect().operations[0]!.cost.observedUsd).toBeNull();
    } finally {
      releaseAll();
      if (guardedState.promise !== null) await guardedState.promise.catch(() => undefined);
    }
  }, 10_000);

  test("dispatchClosed before publication does not make a settling lifecycle worker late", async () => {
    const actual = completed(0.1);
    const tracked = trackedLifecycleBridge();
    const workerStarted = deferred<void>();
    const releaseWorker = deferred<void>();
    teardownReleases.push(() => releaseWorker.resolve(undefined));
    const runner: Runner = {
      async run(request): Promise<WorkerResult> {
        workerStarted.resolve(undefined);
        const port = lifecyclePort(request);
        await port.checkpoint(lifecycleCleanupEvent(request), () => {});
        await port.checkpoint(lifecycleResultEvent(request, actual), () => {});
        await releaseWorker.promise;
        return actual;
      },
    };
    const setup = await setupLifecycleDispatch("dispatch-closed", tracked.bridge, {
      runner,
      execute: async (_runId, guarded, request) => {
        void guarded.run(request).catch(() => undefined);
        return { status: "completed" };
      },
    });
    const pending = setup.start("call-dispatch-closed");
    await workerStarted.promise;
    // Let the backend execute promise settle so dispatchClosed is set while
    // this already-dispatched worker is still pending.
    await tick(10);
    releaseWorker.resolve(undefined);
    const result = await pending;
    expect(result.outcome).toBe("backend-completed");
    expect(result.executionState).toBe("settled");
    expect(result.cost.observedUsd).toBe(0.1);
    expect(result.cost.unknownUsd).toBe(0);
    expect(tracked.calls).toHaveLength(2);
    const checkpoint = await readCheckpoint(setup.root, setup.owner);
    expect(checkpoint.admissions[0]!.settlement).toEqual({
      revision: checkpoint.admissions[0]!.settlement!.revision,
      mode: "known",
      observedUsd: 0.1,
      concurrencyHeld: false,
    });
    expect(setup.coordinator.inspect().operations[0]!.concurrencyHeld).toBe(false);
  }, 10_000);
});
