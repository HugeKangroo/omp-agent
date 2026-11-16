import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES,
  MAX_SNAPSHOT_READ_RESPONSE_BYTES,
  createNativeSnapshotEntry,
  readNativeSnapshotRequestDescriptor,
  type NativeChildCallIdentity,
  type NativeChildObservationPreparation,
  type NativeChildPorts,
  type NativeChildPrepareRequest,
  type NativeChildPrepareResult,
  type NativeChildReadEventIdentity,
  type NativeChildReadExpectation,
  type NativeSnapshotEntry,
  type NativeSnapshotObservation,
  type NativeSnapshotRootResolution,
} from "../../src/native-handoff-snapshot.ts";
import {
  createNativeHandoffCoordinator,
  getNativeHandoffCoordinatorStore,
  type NativeHandoffCoordinator,
} from "../../src/native-handoff-entry.ts";
import {
  openNativeHandoffStore,
  type HandoffCapture,
  type HandoffOffer,
  type NativeHandoffStore,
} from "../../src/native-handoff.ts";
import {
  captureWorkspaceText,
  nodeFileIo,
  type NativeWorkspaceTextSnapshot,
} from "../../src/native-work.ts";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-a21b2-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeRelative(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

interface Scope {
  readonly consumer: object;
  readonly parentTask: object;
  readonly parentTaskCallId: string;
  readonly context: NativeContext;
  readonly calls: Map<string, ChildCall>;
}

interface ChildCall {
  readonly ref: object;
  parentTaskRef: object;
  readonly facts: {
    readonly childToolCallId: string;
    readonly childToolName: string;
    readonly parentTaskCallId: string;
  };
}

interface Initial {
  readonly capture: HandoffCapture;
  readonly offer: HandoffOffer;
  readonly snapshot: NativeWorkspaceTextSnapshot;
}

interface HarnessOptions {
  readonly content?: string;
  readonly conditions?: readonly unknown[];
  readonly relativePath?: string;
}

interface Harness {
  root: string;
  rootRef: object;
  store: NativeHandoffStore;
  coordinator: NativeHandoffCoordinator;
  workRef: object;
  scopes: Map<NativeContext, Scope>;
  child: Scope;
  other: Scope;
  mainContext: NativeContext;
  ports: NativeChildPorts;
  entry: NativeSnapshotEntry;
  resolve: (context: NativeContext) => NativeSnapshotRootResolution;
  bindOffer: (offer: HandoffOffer, scope: Scope) => void;
  offerBindings: Map<string, { consumer: object; parentTask: object }>;
  initial: Initial;
  scopeSeq: number;
  identifyCalls: number;
  prepareCalls: number;
  observationPrepares: number;
  observationRefreshes: number;
  prepareHook: ((request: NativeChildPrepareRequest, h: Harness) => NativeChildPrepareResult | undefined) | null;
  identifyHook: ((
    actualToolCallId: string,
    context: NativeContext,
    prior: object | undefined,
    h: Harness,
  ) => NativeChildCallIdentity | undefined) | null;
  observationHook: ((
    event: NativeChildReadEventIdentity,
    context: NativeContext,
    expected: NativeChildReadExpectation,
    h: Harness,
  ) => NativeChildObservationPreparation | undefined) | null;
  refreshHook: ((request: NativeChildPrepareRequest, h: Harness) => { readonly ok: boolean; readonly reason?: string } | undefined) | null;
  observationRefreshHook: ((h: Harness) => { readonly ok: boolean; readonly reason?: string } | undefined) | null;
  identityRevalidateImpl: () => unknown;
  prepareRevalidateImpl: () => unknown;
  observationRevalidateImpl: () => unknown;
  resolveOverride: ((context: NativeContext) => NativeSnapshotRootResolution) | null;
}

function defaultConditions(value = "done"): readonly unknown[] {
  return [{ id: "status", kind: "json-equals", pointer: "/status", value }];
}

function subContext(root: string): NativeContext {
  return {
    cwd: root,
    agent: { kind: "sub" },
    sessionManager: { getSessionId: () => "session-1", getCwd: () => root },
  };
}

function addScope(h: Harness, context: NativeContext): Scope {
  const scope: Scope = {
    consumer: {},
    parentTask: {},
    parentTaskCallId: `parent-${++h.scopeSeq}`,
    context,
    calls: new Map(),
  };
  h.scopes.set(context, scope);
  return scope;
}

function defaultResolve(h: Harness, context: NativeContext): NativeSnapshotRootResolution {
  const scope = h.scopes.get(context);
  if (scope === undefined) return { ok: false, reason: "not a real child factory context" };
  return {
    ok: true,
    coordinator: h.coordinator,
    consumerRef: scope.consumer,
    ports: h.ports,
  };
}

function isSub(context: NativeContext): boolean {
  return context.agent?.kind === "sub";
}

function newOffer(h: Harness, scope: Scope = h.child, bind = true): HandoffOffer {
  const offer = h.store.offer(h.initial.capture);
  if (bind) h.bindOffer(offer, scope);
  return offer;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await workspace();
  const rootRef: object = {};
  const store = openNativeHandoffStore(rootRef);
  const coordinator = createNativeHandoffCoordinator(rootRef);
  const h = {} as Harness;
  Object.assign(h, {
    root,
    rootRef,
    store,
    coordinator,
    workRef: {},
    scopes: new Map<NativeContext, Scope>(),
    offerBindings: new Map<string, { consumer: object; parentTask: object }>(),
    scopeSeq: 0,
    identifyCalls: 0,
    prepareCalls: 0,
    observationPrepares: 0,
    observationRefreshes: 0,
    prepareHook: null,
    identifyHook: null,
    observationHook: null,
    refreshHook: null,
    observationRefreshHook: null,
    identityRevalidateImpl: () => null,
    prepareRevalidateImpl: () => null,
    observationRevalidateImpl: () => null,
    resolveOverride: null,
  });
  const child = addScope(h, subContext(root));
  const other = addScope(h, subContext(root));
  h.child = child;
  h.other = other;
  h.mainContext = {
    cwd: root,
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => "session-1", getCwd: () => root },
  };
  h.bindOffer = (offer: HandoffOffer, scope: Scope): void => {
    h.offerBindings.set(offer.offerId, { consumer: scope.consumer, parentTask: scope.parentTask });
    h.store.bindOfferConsumer(offer, scope.consumer, scope.parentTask, {
      callId: scope.parentTaskCallId,
      workId: "work-1",
      definitionVersion: "child-v1",
    });
  };
  h.ports = {
    identifyChildCall(actualToolCallId, context, prior) {
      h.identifyCalls++;
      if (h.identifyHook !== null) {
        const override = h.identifyHook(actualToolCallId, context, prior, h);
        if (override !== undefined) return override;
      }
      if (!isSub(context)) return { ok: false, reason: "not a sub context" };
      const scope = h.scopes.get(context);
      if (scope === undefined) return { ok: false, reason: "not a registered child context" };
      let call = scope.calls.get(actualToolCallId);
      if (call === undefined) {
        call = {
          ref: {},
          parentTaskRef: scope.parentTask,
          facts: {
            childToolCallId: actualToolCallId,
            childToolName: "agent_snapshot",
            parentTaskCallId: scope.parentTaskCallId,
          },
        };
        scope.calls.set(actualToolCallId, call);
      }
      if (prior !== undefined && prior !== call.ref) {
        return { ok: false, reason: "prior child tool call reference changed" };
      }
      return {
        ok: true,
        childToolCallRef: call.ref,
        consumerRef: scope.consumer,
        parentTaskRef: call.parentTaskRef,
        facts: call.facts,
        revalidate: () => h.identityRevalidateImpl() as string | null,
      };
    },
    prepareChild(request, context) {
      h.prepareCalls++;
      if (h.prepareHook !== null) {
        const override = h.prepareHook(request, h);
        if (override !== undefined) return override;
      }
      if (!isSub(context)) return { ok: false, reason: "not a sub context" };
      const binding = h.offerBindings.get(request.offer.offerId);
      if (binding === undefined) return { ok: false, reason: "the selected offer is not bound" };
      if (binding.consumer !== request.consumer || binding.parentTask !== request.parentTaskCall) {
        return { ok: false, reason: "the selected offer is bound to another child or parent task" };
      }
      if (request.offerView.state !== "bound") {
        return { ok: false, reason: "the selected offer is not bound" };
      }
      return {
        ok: true,
        prepared: {
          refresh() {
            if (h.refreshHook !== null) {
              const override = h.refreshHook(request, h);
              if (override !== undefined) return override as { ok: true } | { ok: false; reason: string };
            }
            return { ok: true };
          },
          revalidate: () => h.prepareRevalidateImpl() as string | null,
        },
      };
    },
    prepareReadObservation(event, context, expected) {
      h.observationPrepares++;
      if (h.observationHook !== null) {
        const override = h.observationHook(event, context, expected, h);
        if (override !== undefined) return override;
      }
      const scope = h.scopes.get(context);
      if (scope === undefined) return { ok: false, reason: "not a registered child context" };
      if (expected.consumer !== scope.consumer) return { ok: false, reason: "different consumer" };
      if (expected.parentTaskCall !== scope.parentTask) return { ok: false, reason: "different parent task" };
      if (event.toolCallId !== expected.readCallId) {
        return { ok: false, reason: "different read tool call id" };
      }
      const call = scope.calls.get(event.toolCallId);
      if (call === undefined || call.ref !== expected.readToolCall) {
        return { ok: false, reason: "different read tool call reference" };
      }
      return {
        ok: true,
        prepared: {
          refresh() {
            h.observationRefreshes++;
            if (h.observationRefreshHook !== null) {
              const override = h.observationRefreshHook(h);
              if (override !== undefined) return override as { ok: true } | { ok: false; reason: string };
            }
            return { ok: true };
          },
          revalidate: () => h.observationRevalidateImpl() as string | null,
        },
      };
    },
  };
  h.resolve = (context: NativeContext): NativeSnapshotRootResolution =>
    h.resolveOverride !== null ? h.resolveOverride(context) : defaultResolve(h, context);
  h.entry = createNativeSnapshotEntry({ resolveChildRoot: h.resolve });

  const relativePath = options.relativePath ?? "data.json";
  const content = options.content ?? '{"status":"done"}';
  const conditions = options.conditions ?? defaultConditions();
  await writeRelative(root, relativePath, content);
  const snapshot = await captureWorkspaceText(root, relativePath, nodeFileIo, 1);
  const reservation = store.reserveCapture({
    work: h.workRef,
    producer: {},
    producerFacts: { callId: "producer-1", workId: "work-1", definitionVersion: "producer-v1" },
    proposalCall: {},
    proposalFacts: { callId: "proposal-1", workId: "work-1", definitionVersion: "child-v1" },
    relativePath,
    conditions,
  });
  const commit = store.commitCapture(reservation, snapshot);
  h.initial = { capture: commit.capture, offer: commit.offer, snapshot };
  h.bindOffer(commit.offer, child);
  return h;
}

function paramsRead(offerId: string): { action: "read"; offerId: string } {
  return { action: "read", offerId };
}

function paramsCheck(offerId: string): { action: "check"; offerId: string } {
  return { action: "check", offerId };
}

function execWithSignal(
  h: Harness,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  context: NativeContext = h.child.context,
): Promise<NativeToolResult> {
  return h.entry.tool.execute(toolCallId, params, signal, null, context);
}

function exec(
  h: Harness,
  toolCallId: string,
  params: unknown,
  options: { readonly signal?: AbortSignal; readonly context?: NativeContext } = {},
): Promise<NativeToolResult> {
  return execWithSignal(
    h,
    toolCallId,
    params,
    options.signal ?? new AbortController().signal,
    options.context ?? h.child.context,
  );
}

function resultText(result: NativeToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function resultDetails(result: NativeToolResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

function resultBytes(result: NativeToolResult): number {
  return new TextEncoder().encode(JSON.stringify(result)).byteLength;
}

function offerView(h: Harness, offer: HandoffOffer) {
  const view = h.store.lookupOffer(offer.offerId);
  if (view === null) throw new Error("test offer is unavailable");
  return view;
}

function eventFor(
  h: Harness,
  scope: Scope,
  toolCallId: string,
  input: unknown,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool_result",
    toolName: "agent_snapshot",
    toolCallId,
    input,
    content: [{ type: "text", text }],
    isError: false,
    ...overrides,
  };
}

function observe(
  h: Harness,
  event: unknown,
  context: NativeContext = h.child.context,
): NativeSnapshotObservation {
  return h.entry.observeToolResult(event, context);
}

interface FreshRead {
  readonly offer: HandoffOffer;
  readonly callId: string;
  readonly params: { action: "read"; offerId: string };
  readonly text: string;
  readonly controller: AbortController;
}

async function freshRead(h: Harness, label: string, scope: Scope = h.child): Promise<FreshRead> {
  const offer = newOffer(h, scope);
  const callId = `read-${label}`;
  const params = paramsRead(offer.offerId);
  const controller = new AbortController();
  const result = await execWithSignal(h, callId, params, controller.signal, scope.context);
  expect(result.isError).toBe(false);
  return { offer, callId, params, text: resultText(result), controller };
}

describe("native child snapshot scope and identity", () => {
  test("rejects main contexts, foreign coordinators, open offers and wrong consumers", async () => {
    const h = await makeHarness();
    const main = await exec(h, "main-call", paramsRead(h.initial.offer.offerId), { context: h.mainContext });
    expect(main.isError).toBe(true);
    expect(resultDetails(main).resultKind).toBe("not-admitted");
    expect(offerView(h, h.initial.offer).readState).toBe("none");

    h.resolveOverride = (): NativeSnapshotRootResolution => ({
      ok: true,
      coordinator: { closed: false, close() {} } as unknown as NativeHandoffCoordinator,
      consumerRef: h.child.consumer,
      ports: h.ports,
    });
    const foreign = await exec(h, "foreign-call", paramsRead(h.initial.offer.offerId));
    expect(foreign.isError).toBe(true);
    expect(resultDetails(foreign).resultKind).toBe("not-admitted");
    h.resolveOverride = null;

    const open = newOffer(h, h.child, false);
    const openResult = await exec(h, "open-call", paramsRead(open.offerId));
    expect(openResult.isError).toBe(true);
    expect(offerView(h, open).state).toBe("open");
    expect(offerView(h, open).readState).toBe("none");
    expect(offerView(h, open).binding).toBeNull();

    const wrong = await exec(h, "wrong-consumer", paramsRead(h.initial.offer.offerId), {
      context: h.other.context,
    });
    expect(wrong.isError).toBe(true);
    expect(offerView(h, h.initial.offer).readState).toBe("none");
    expect(h.observationPrepares).toBe(0);
  });

  test("isolates the same actual tool call id across different children", async () => {
    const h = await makeHarness();
    const offerB = newOffer(h, h.other);
    const callId = "shared-call";
    const readA = await exec(h, callId, paramsRead(h.initial.offer.offerId), { context: h.child.context });
    const readB = await exec(h, callId, paramsRead(offerB.offerId), { context: h.other.context });
    expect(readA.isError).toBe(false);
    expect(readB.isError).toBe(false);
    const textA = resultText(readA);
    const textB = resultText(readB);
    expect(textA).not.toBe(textB);

    // An unknown call id in B's child scope is unrelated and cannot poison B.
    const foreign = observe(
      h,
      eventFor(h, h.other, "foreign-call", paramsRead(offerB.offerId), textA),
      h.other.context,
    );
    expect(foreign.kind).toBe("ignored");
    expect(offerView(h, offerB).readState).toBe("prepared");

    const observedA = observe(
      h,
      eventFor(h, h.child, callId, paramsRead(h.initial.offer.offerId), textA),
      h.child.context,
    );
    expect(observedA).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, h.initial.offer).readUsable).toBe(true);
    expect(offerView(h, offerB).readState).toBe("prepared");

    const observedB = observe(
      h,
      eventFor(h, h.other, callId, paramsRead(offerB.offerId), textB),
      h.other.context,
    );
    expect(observedB).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, offerB).readUsable).toBe(true);
  });

  test("rejects a parent task reference reused as the child tool call reference", async () => {
    const h = await makeHarness();
    h.identifyHook = (actualToolCallId, context, prior) => {
      const scope = h.scopes.get(context);
      if (scope === undefined) return { ok: false, reason: "not a child scope" };
      const ref = {};
      return {
        ok: true,
        childToolCallRef: ref,
        consumerRef: scope.consumer,
        parentTaskRef: ref,
        facts: {
          childToolCallId: actualToolCallId,
          childToolName: "agent_snapshot",
          parentTaskCallId: scope.parentTaskCallId,
        },
        revalidate: () => null,
      };
    };
    const result = await exec(h, "same-ref", paramsRead(h.initial.offer.offerId));
    expect(result.isError).toBe(true);
    expect(resultDetails(result).resultKind).toBe("not-admitted");
    expect(String(resultDetails(result).reason)).toContain("must not be the parent task reference");
    expect(offerView(h, h.initial.offer).readState).toBe("none");
  });
});

describe("check and read observation semantics", () => {
  test("check runs without read; read becomes usable only after exact tool_result observation", async () => {
    const h = await makeHarness();
    const check = await exec(h, "check-1", paramsCheck(h.initial.offer.offerId));
    expect(check.isError).toBe(false);
    expect(resultBytes(check)).toBeLessThanOrEqual(MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES);
    const checkPayload = JSON.parse(resultText(check)) as Record<string, unknown>;
    expect(checkPayload.action).toBe("check");
    expect(checkPayload.outcome).toBe("pass");
    expect(checkPayload.taskAccepted).toBe(false);
    expect(checkPayload.semanticAcceptance).toBe("not-evaluated");
    expect(offerView(h, h.initial.offer).checked).toBe(true);
    expect(offerView(h, h.initial.offer).readState).toBe("none");

    const read = await exec(h, "read-1", paramsRead(h.initial.offer.offerId));
    expect(read.isError).toBe(false);
    expect(read.details).toBeUndefined();
    expect(read.content).toHaveLength(1);
    expect(read.content[0]?.type).toBe("text");
    const viewText = read.content[0]!.text;
    expect(resultBytes(read)).toBeLessThanOrEqual(MAX_SNAPSHOT_READ_RESPONSE_BYTES);
    const view = JSON.parse(viewText) as Record<string, unknown>;
    expect(view.schema).toBe("omp-agent.native-handoff-read.v1");
    expect(offerView(h, h.initial.offer).readState).toBe("prepared");
    expect(offerView(h, h.initial.offer).readDelivered).toBe(false);
    expect(offerView(h, h.initial.offer).readUsable).toBe(false);

    const unrelated = observe(h, eventFor(h, h.child, "other-call", paramsRead(h.initial.offer.offerId), viewText));
    expect(unrelated.kind).toBe("ignored");
    expect(offerView(h, h.initial.offer).readState).toBe("prepared");

    const wrongInput = observe(h, eventFor(h, h.child, "read-1", paramsCheck(h.initial.offer.offerId), viewText));
    expect(wrongInput.kind).toBe("observed");
    expect(wrongInput).toMatchObject({ success: false });
    expect(offerView(h, h.initial.offer).readState).toBe("failed");
    expect(offerView(h, h.initial.offer).readUsable).toBe(false);

    const second = await freshRead(h, "second");
    const exact = observe(h, eventFor(h, h.child, second.callId, second.params, second.text));
    expect(exact).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, second.offer).readState).toBe("delivered");
    expect(offerView(h, second.offer).readDelivered).toBe(true);
    expect(offerView(h, second.offer).readUsable).toBe(true);
  });

  test("normal check and a reachable escaped-id plan both pass the precommit projection", async () => {
    const normal = await makeHarness();
    const normalCheck = await exec(normal, "check-normal", paramsCheck(normal.initial.offer.offerId));
    expect(normalCheck.isError).toBe(false);
    expect(resultBytes(normalCheck)).toBeLessThanOrEqual(MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES);

    const mixedBase = `${"\uD800".repeat(70)}${"\"".repeat(6)}${"\\".repeat(6)}`;
    const conditions = Array.from({ length: 32 }, (_, index) => ({
      id: `${mixedBase}${index}`,
      kind: "text-includes" as const,
      value: "x",
    }));
    const extreme = await makeHarness({ content: "x", conditions });
    const extremeCheck = await exec(
      extreme,
      "check-extreme",
      paramsCheck(extreme.initial.offer.offerId),
    );
    expect(extremeCheck.isError).toBe(false);
    expect(resultBytes(extremeCheck)).toBeLessThanOrEqual(MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES);
    const payload = JSON.parse(resultText(extremeCheck)) as Record<string, unknown>;
    expect(payload.outcome).toBe("pass");
    expect((payload.conditions as unknown[]).length).toBe(32);
  });

  test("exact payload forms and authenticated conflicts are monotonic", async () => {
    const h = await makeHarness();

    const undefinedDetails = await freshRead(h, "undefined-details");
    const undefinedObserved = observe(
      h,
      eventFor(h, h.child, undefinedDetails.callId, undefinedDetails.params, undefinedDetails.text, {
        details: undefined,
      }),
    );
    expect(undefinedObserved).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, undefinedDetails.offer).readUsable).toBe(true);

    const nullDetails = await freshRead(h, "null-details");
    const nullObserved = observe(
      h,
      eventFor(h, h.child, nullDetails.callId, nullDetails.params, nullDetails.text, { details: null }),
    );
    expect(nullObserved).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, nullDetails.offer).readUsable).toBe(false);

    const extraImage = await freshRead(h, "extra-image");
    const imageObserved = observe(
      h,
      eventFor(h, h.child, extraImage.callId, extraImage.params, extraImage.text, {
        content: [
          { type: "text", text: extraImage.text },
          { type: "image", data: "aGVsbG8=" },
        ],
      }),
    );
    expect(imageObserved).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, extraImage.offer).readUsable).toBe(false);

    const errorTrue = await freshRead(h, "error-true");
    const errorObserved = observe(
      h,
      eventFor(h, h.child, errorTrue.callId, errorTrue.params, errorTrue.text, { isError: true }),
    );
    expect(errorObserved).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, errorTrue.offer).readUsable).toBe(false);

    const changedText = await freshRead(h, "changed-text");
    const changedObserved = observe(
      h,
      eventFor(h, h.child, changedText.callId, changedText.params, `${changedText.text} `),
    );
    expect(changedObserved).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, changedText.offer).readUsable).toBe(false);

    const successThenConflict = await freshRead(h, "success-conflict");
    const firstSuccess = observe(
      h,
      eventFor(h, h.child, successThenConflict.callId, successThenConflict.params, successThenConflict.text),
    );
    expect(firstSuccess).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, successThenConflict.offer).readUsable).toBe(true);
    const conflict = observe(
      h,
      eventFor(h, h.child, successThenConflict.callId, successThenConflict.params, `${successThenConflict.text} `),
    );
    expect(conflict).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, successThenConflict.offer).readDelivered).toBe(true);
    expect(offerView(h, successThenConflict.offer).readUsable).toBe(false);
    const exactAgain = observe(
      h,
      eventFor(h, h.child, successThenConflict.callId, successThenConflict.params, successThenConflict.text),
    );
    expect(exactAgain).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, successThenConflict.offer).readUsable).toBe(false);
  });

  test("a genuine same-call changed effective input is a terminal observation failure", async () => {
    const h = await makeHarness();
    const read = await freshRead(h, "changed-input");
    const changedAction = observe(
      h,
      eventFor(h, h.child, read.callId, paramsCheck(read.offer.offerId), read.text),
    );
    expect(changedAction).toMatchObject({ kind: "observed", success: false });
    expect(h.observationPrepares).toBe(1);
    expect(offerView(h, read.offer).readState).toBe("failed");

    const read2 = await freshRead(h, "malformed-input");
    const malformed = observe(
      h,
      eventFor(h, h.child, read2.callId, { action: "read", offerId: read2.offer.offerId, extra: 1 }, read2.text),
    );
    expect(malformed).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, read2.offer).readState).toBe("failed");

    const readOffer = await freshRead(h, "wrong-offer-input");
    const otherOffer = newOffer(h);
    const wrongOffer = observe(
      h,
      eventFor(h, h.child, readOffer.callId, paramsRead(otherOffer.offerId), readOffer.text),
    );
    expect(wrongOffer).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, readOffer.offer).readState).toBe("failed");

    const read3 = await freshRead(h, "unrelated");
    const wrongTool = observe(
      h,
      eventFor(h, h.child, read3.callId, read3.params, read3.text, { toolName: "other_tool" }),
    );
    expect(wrongTool.kind).toBe("ignored");
    expect(offerView(h, read3.offer).readState).toBe("prepared");
    const exact = observe(h, eventFor(h, h.child, read3.callId, read3.params, read3.text));
    expect(exact).toMatchObject({ kind: "observed", success: true });
  });

  test("revoked or accessor payload reflection is an authenticated failure, not a thrown observer", async () => {
    const h = await makeHarness();
    const read = await freshRead(h, "revoked");
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const event = eventFor(h, h.child, read.callId, read.params, read.text, { content: revoked.proxy });
    const observed = observe(h, event);
    expect(observed).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, read.offer).readState).toBe("failed");

    const read2 = await freshRead(h, "accessor");
    const event2 = eventFor(h, h.child, read2.callId, read2.params, read2.text);
    Object.defineProperty(event2, "isError", {
      enumerable: true,
      get(): never {
        throw new Error("blocked getter");
      },
    });
    const observed2 = observe(h, event2);
    expect(observed2).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, read2.offer).readState).toBe("failed");
  });
});

describe("operation identity, lifecycle and bounds", () => {
  test("joins the same running call once, then conflicts stick after success", async () => {
    const h = await makeHarness();
    const params = paramsRead(h.initial.offer.offerId);
    let joining: Promise<NativeToolResult> | null = null;
    h.prepareHook = (request) => {
      if (request.actualToolCallId === "join-call" && joining === null) {
        joining = exec(h, "join-call", params);
      }
      return undefined;
    };
    const firstPromise = exec(h, "join-call", params);
    const joinPromise = joining;
    expect(joinPromise).not.toBeNull();
    const [first, second] = await Promise.all([firstPromise, joinPromise!]);
    expect(h.prepareCalls).toBe(1);
    expect(first.isError).toBe(false);
    expect(resultText(first)).toBe(resultText(second));
    expect(offerView(h, h.initial.offer).readState).toBe("prepared");

    const exact = observe(h, eventFor(h, h.child, "join-call", params, resultText(first)));
    expect(exact).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, h.initial.offer).readUsable).toBe(true);

    const other = newOffer(h);
    const conflict = await exec(h, "join-call", paramsRead(other.offerId));
    expect(conflict.isError).toBe(true);
    expect(resultDetails(conflict).resultKind).toBe("conflict");
    // No tool_result is needed: the genuine same-call execute conflict already
    // revoked core usability through the original issued refs.
    expect(offerView(h, h.initial.offer).readDelivered).toBe(true);
    expect(offerView(h, h.initial.offer).readUsable).toBe(false);

    const replay = await exec(h, "join-call", params);
    expect(resultDetails(replay).resultKind).toBe("conflict");

    // A later event cannot restore usability; historical delivered remains.
    const afterConflict = observe(h, eventFor(h, h.child, "join-call", params, resultText(first)));
    expect(afterConflict).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, h.initial.offer).readDelivered).toBe(true);
    expect(offerView(h, h.initial.offer).readUsable).toBe(false);
  });

  test("changed execute request before read confirmation makes the later read unusable", async () => {
    const h = await makeHarness();
    const read = await freshRead(h, "before-conflict");
    const other = newOffer(h);
    const conflict = await exec(h, read.callId, paramsRead(other.offerId));
    expect(resultDetails(conflict).resultKind).toBe("conflict");
    // The conflict itself marks the core read failed; no event is required.
    expect(offerView(h, read.offer).readState).toBe("failed");
    expect(offerView(h, read.offer).readDelivered).toBe(false);
    expect(offerView(h, read.offer).readUsable).toBe(false);

    const exact = observe(h, eventFor(h, h.child, read.callId, read.params, read.text));
    expect(exact).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, read.offer).readState).toBe("failed");
    expect(offerView(h, read.offer).readUsable).toBe(false);
    const retry = observe(h, eventFor(h, h.child, read.callId, read.params, read.text));
    expect(retry).toMatchObject({ kind: "observed", success: false });
    expect(offerView(h, read.offer).readUsable).toBe(false);
  });

  test("terminal prepare failure is cached for the same call and a new call retries", async () => {
    const h = await makeHarness();
    const open = newOffer(h, h.child, false);
    const first = await exec(h, "terminal-call", paramsRead(open.offerId));
    expect(first.isError).toBe(true);
    const prepares = h.prepareCalls;
    const second = await exec(h, "terminal-call", paramsRead(open.offerId));
    expect(second.isError).toBe(true);
    expect(resultDetails(second).resultKind).toBe("historical-operation-result");
    expect(h.prepareCalls).toBe(prepares);

    const retry = await exec(h, "new-call", paramsRead(h.initial.offer.offerId));
    expect(retry.isError).toBe(false);
  });

  test("bounded child operation capacity rejects the 65th distinct call", async () => {
    const h = await makeHarness();
    const open = newOffer(h, h.child, false);
    for (let index = 0; index < 64; index++) {
      const result = await exec(h, `capacity-${index}`, paramsRead(open.offerId));
      expect(result.isError).toBe(true);
    }
    const rejected = await exec(h, "capacity-64", paramsRead(open.offerId));
    expect(rejected.isError).toBe(true);
    expect(resultDetails(rejected).resultKind).toBe("not-admitted");
    expect(String(resultDetails(rejected).reason)).toContain("capacity");
  });

  test("historical results are replayed from a copy callers cannot poison", async () => {
    const h = await makeHarness();
    const check = await exec(h, "clone-check", paramsCheck(h.initial.offer.offerId));
    expect(check.isError).toBe(false);
    const originalCheckText = resultText(check);
    (check.content[0] as { text: string }).text = "mutated";
    const checkReplay = await exec(h, "clone-check", paramsCheck(h.initial.offer.offerId));
    expect(resultText(checkReplay)).toBe(originalCheckText);

    const read = await exec(h, "clone-read", paramsRead(h.initial.offer.offerId));
    expect(read.isError).toBe(false);
    const originalReadText = resultText(read);
    (read.content[0] as { text: string }).text = "mutated read";
    const readReplay = await exec(h, "clone-read", paramsRead(h.initial.offer.offerId));
    expect(resultText(readReplay)).toBe(originalReadText);
  });
});

describe("signals, close, dispose and encoding bounds", () => {
  test("requires a real execute signal and refuses late cancellation before core", async () => {
    const h = await makeHarness();
    const params = paramsRead(h.initial.offer.offerId);
    const missing = await execWithSignal(h, "missing-signal", params, undefined);
    expect(resultDetails(missing).resultKind).toBe("not-admitted");
    const duck = await execWithSignal(h, "duck-signal", params, { aborted: false } as unknown as AbortSignal);
    expect(resultDetails(duck).resultKind).toBe("not-admitted");
    const aborted = new AbortController();
    aborted.abort();
    const abortedResult = await execWithSignal(h, "aborted-signal", params, aborted.signal);
    expect(resultDetails(abortedResult).resultKind).toBe("not-admitted");
    expect(offerView(h, h.initial.offer).readState).toBe("none");

    const late = new AbortController();
    h.prepareHook = (request) => {
      if (request.actualToolCallId === "late-abort") late.abort();
      return undefined;
    };
    const lateResult = await execWithSignal(h, "late-abort", params, late.signal);
    expect(lateResult.isError).toBe(true);
    expect(resultDetails(lateResult).operationOutcome).toBe("failed");
    expect(offerView(h, h.initial.offer).readState).toBe("none");
    const prepareCount = h.prepareCalls;
    const retry = await execWithSignal(h, "late-abort", params, late.signal);
    expect(retry.isError).toBe(true);
    expect(h.prepareCalls).toBe(prepareCount);
    const fresh = await exec(h, "after-late", params);
    expect(fresh.isError).toBe(false);
  });

  test("root close during prepare is terminal, and the closed root refuses later calls", async () => {
    const h = await makeHarness();
    h.prepareHook = () => {
      h.coordinator.close();
      return undefined;
    };
    const closed = await exec(h, "close-call", paramsRead(h.initial.offer.offerId));
    expect(closed.isError).toBe(true);
    expect(resultDetails(closed).operationOutcome).toBe("failed");
    expect(offerView(h, h.initial.offer).readState).toBe("none");
    const after = await exec(h, "after-close", paramsRead(h.initial.offer.offerId));
    expect(resultDetails(after).resultKind).toBe("not-admitted");
    expect(getNativeHandoffCoordinatorStore(h.coordinator)).toBeNull();
  });

  test("final sub-context getter reentry is refused", async () => {
    const h = await makeHarness();
    const flakyContext = subContext(h.root);
    let reads = 0;
    Object.defineProperty(flakyContext, "agent", {
      enumerable: true,
      get() {
        reads++;
        return { kind: reads < 3 ? "sub" : "main" };
      },
    });
    const flakyScope = addScope(h, flakyContext);
    const offer = newOffer(h, flakyScope);
    const result = await exec(h, "flaky-context", paramsRead(offer.offerId), { context: flakyContext });
    expect(result.isError).toBe(true);
    expect(resultDetails(result).operationOutcome).toBe("failed");
    expect(offerView(h, offer).readState).toBe("none");
  });

  test("disposing one entry leaves another entry's pending read and completed history intact", async () => {
    const h = await makeHarness();
    const entryB = createNativeSnapshotEntry({ resolveChildRoot: h.resolve });
    const offerA = newOffer(h);
    const offerB = newOffer(h);
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const readA = await execWithSignal(h, "entry-a-read", paramsRead(offerA.offerId), controllerA.signal);
    const readB = await entryB.tool.execute(
      "entry-b-read",
      paramsRead(offerB.offerId),
      controllerB.signal,
      null,
      h.child.context,
    );
    expect(readA.isError).toBe(false);
    expect(readB.isError).toBe(false);
    expect(offerView(h, offerA).readState).toBe("prepared");
    expect(offerView(h, offerB).readState).toBe("prepared");

    h.entry.dispose();
    const aObserver = h.entry.observeToolResult(
      eventFor(h, h.child, "entry-a-read", paramsRead(offerA.offerId), resultText(readA)),
      h.child.context,
    );
    expect(aObserver.kind).toBe("ignored");
    expect(offerView(h, offerA).readUsable).toBe(false);

    const bObserved = entryB.observeToolResult(
      eventFor(h, h.child, "entry-b-read", paramsRead(offerB.offerId), resultText(readB)),
      h.child.context,
    );
    expect(bObserved).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, offerB).readUsable).toBe(true);

    const offerC = newOffer(h);
    const readC = await entryB.tool.execute(
      "entry-b-new",
      paramsRead(offerC.offerId),
      new AbortController().signal,
      null,
      h.child.context,
    );
    expect(readC.isError).toBe(false);
  });

  test("dispose during observation refresh or revalidate cannot gain success", async () => {
    const h = await makeHarness();
    const read = await freshRead(h, "dispose-during");
    h.observationRefreshHook = () => {
      h.entry.dispose();
      return { ok: true };
    };
    const observed = observe(h, eventFor(h, h.child, read.callId, read.params, read.text));
    expect(observed.kind).not.toBe("observed");
    expect(offerView(h, read.offer).readState).toBe("prepared");
    expect(offerView(h, read.offer).readDelivered).toBe(false);
    expect(offerView(h, read.offer).readUsable).toBe(false);

    const h2 = await makeHarness();
    const read2 = await freshRead(h2, "dispose-revalidate");
    h2.observationRevalidateImpl = () => {
      h2.entry.dispose();
      return null;
    };
    const observed2 = observe(h2, eventFor(h2, h2.child, read2.callId, read2.params, read2.text));
    expect(observed2.kind).not.toBe("observed");
    expect(offerView(h2, read2.offer).readDelivered).toBe(false);
    expect(offerView(h2, read2.offer).readUsable).toBe(false);
  });

  test("successful observation survives normal signal cleanup and entry dispose", async () => {
    const h = await makeHarness();
    const controller = new AbortController();
    const read = await execWithSignal(
      h,
      "shutdown-read",
      paramsRead(h.initial.offer.offerId),
      controller.signal,
    );
    expect(read.isError).toBe(false);
    const observed = observe(
      h,
      eventFor(h, h.child, "shutdown-read", paramsRead(h.initial.offer.offerId), resultText(read)),
    );
    expect(observed).toMatchObject({ kind: "observed", success: true });
    expect(offerView(h, h.initial.offer).readUsable).toBe(true);

    controller.abort();
    h.entry.dispose();
    expect(offerView(h, h.initial.offer).readDelivered).toBe(true);
    expect(offerView(h, h.initial.offer).readUsable).toBe(true);
    const afterDispose = observe(
      h,
      eventFor(h, h.child, "shutdown-read", paramsRead(h.initial.offer.offerId), resultText(read)),
    );
    expect(afterDispose.kind).toBe("ignored");
    expect(offerView(h, h.initial.offer).readDelivered).toBe(true);
    expect(offerView(h, h.initial.offer).readUsable).toBe(true);
  });

  test("outer read encoding over 256 KiB is an honest prepared failure; check still runs", async () => {
    const content = "\"".repeat(70_000);
    const conditions = [{ id: "has-quote", kind: "text-includes", value: "\"" }];
    const h = await makeHarness({ content, conditions });
    const read = await exec(h, "big-read", paramsRead(h.initial.offer.offerId));
    expect(read.isError).toBe(true);
    const details = resultDetails(read);
    expect(details.resultKind).toBe("historical-operation-result");
    expect(details.operationOutcome).toBe("failed");
    expect(details.readPrepared).toBe(true);
    expect(typeof details.readId).toBe("string");
    expect(resultBytes(read)).toBeLessThanOrEqual(MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES);
    expect(offerView(h, h.initial.offer).readState).toBe("prepared");
    expect(offerView(h, h.initial.offer).readDelivered).toBe(false);
    expect(offerView(h, h.initial.offer).readUsable).toBe(false);

    const check = await exec(h, "big-check", paramsCheck(h.initial.offer.offerId));
    expect(check.isError).toBe(false);
    expect(JSON.parse(resultText(check)).outcome).toBe("pass");
    expect(offerView(h, h.initial.offer).checked).toBe(true);
  });

  test("the internal preflight descriptor reader uses the exact same bounded parser", () => {
    const parsed = readNativeSnapshotRequestDescriptor({ action: "read", offerId: "offer-1" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.descriptor.action).toBe("read");
    expect(parsed.descriptor.params).toEqual({ action: "read", offerId: "offer-1" });
    expect(parsed.descriptor.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(readNativeSnapshotRequestDescriptor({ action: "read", offerId: "offer-1", path: "x" }))
      .toEqual({ ok: false, reason: expect.any(String) });
    expect(readNativeSnapshotRequestDescriptor({ action: "write", offerId: "offer-1" }).ok)
      .toBe(false);
  });
});
