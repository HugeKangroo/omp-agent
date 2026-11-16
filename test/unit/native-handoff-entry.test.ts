import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_HANDOFF_INSPECT_RESPONSE_BYTES,
  MAX_HANDOFF_OPERATION_RESPONSE_BYTES,
  createNativeHandoffCoordinator,
  createNativeHandoffEntry,
  prepareNativeHandoffReport,
  readNativeHandoffRequestDescriptor,
  type NativeHandoffCallIdentity,
  type NativeHandoffCheck,
  type NativeHandoffCoordinator,
  type NativeHandoffEntry,
  type NativeHandoffPorts,
  type NativeHandoffPreparedOperation,
  type NativeHandoffPrepareRequest,
  type NativeHandoffPrepareResult,
  type NativeHandoffReportPrepareRequest,
  type NativeHandoffRequestDescriptor,
  type NativeHandoffRootResolution,
  type NativeHandoffWorkFacts,
} from "../../src/native-handoff-entry.ts";
import {
  NativeHandoffError,
  openNativeHandoffStore,
  type HandoffBindingFacts,
  type HandoffOffer,
  type HandoffProducerRef,
  type NativeHandoffStore,
} from "../../src/native-handoff.ts";
import {
  captureWorkspaceText,
  nodeFileIo,
  type NativeFileIo,
} from "../../src/native-work.ts";
import type { NativeContext, NativeToolResult } from "../../src/native-entry.ts";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-a21b-")));
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

interface ProducerEntry {
  selector: { instanceId: string; parentToolCallId: string; envelopeSha256: string };
  ref: HandoffProducerRef;
  facts: HandoffBindingFacts;
}

interface ConsumerEntry {
  parentToolCallId: string;
  ref: object;
  facts: HandoffBindingFacts;
  completed: boolean;
}

type RefreshHook = (
  count: number,
  request: NativeHandoffPrepareRequest,
) => NativeHandoffCheck | null | undefined;

interface Fixture {
  work: NativeHandoffWorkFacts;
  producers: Map<string, ProducerEntry>;
  producersByCallId: Map<string, ProducerEntry>;
  consumers: Map<string, ConsumerEntry>;
  identifyCalls: number;
  prepareCalls: number;
  identifyOverride: ((
    actualToolCallId: string,
    prior: object | undefined,
    request: NativeHandoffRequestDescriptor,
  ) => NativeHandoffCallIdentity) | null;
  prepareOverride: ((
    request: NativeHandoffPrepareRequest,
    base: () => NativeHandoffPrepareResult,
  ) => NativeHandoffPrepareResult) | null;
  onRefresh: RefreshHook | null;
  revalidateImpl: () => unknown;
  adoptConsumerParentOverride: string | null;
  repairConsumerRef: object | null;
  callRefs: Map<string, object>;
  identityRevalidate: (() => unknown) | null;
  lastDescriptor: NativeHandoffRequestDescriptor | null;
  lastPrepareRequest: NativeHandoffPrepareRequest | null;
}

interface HarnessOptions {
  maxOperations?: number;
  fileIo?: NativeFileIo;
  now?: () => number;
  work?: Partial<NativeHandoffWorkFacts>;
}

interface Harness {
  root: string;
  rootRef: object;
  store: NativeHandoffStore;
  coordinator: NativeHandoffCoordinator;
  fixture: Fixture;
  ports: NativeHandoffPorts;
  entry: NativeHandoffEntry;
  context: NativeContext;
  subContext: NativeContext;
  resolveRoot: (context: NativeContext) => NativeHandoffRootResolution;
  opens: { count: number };
}

function selectorFor(index: number): ProducerEntry["selector"] {
  return {
    instanceId: `instance-${index}`,
    parentToolCallId: `task-${index}`,
    envelopeSha256: index.toString(16).padStart(64, "0"),
  };
}

function producerKey(selector: ProducerEntry["selector"]): string {
  return `${selector.instanceId}\u0000${selector.parentToolCallId}\u0000${selector.envelopeSha256}`;
}

function sameWork(left: NativeHandoffWorkFacts, right: NativeHandoffWorkFacts): boolean {
  return left.observationId === right.observationId
    && left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.workspaceRoot === right.workspaceRoot;
}

function copyWork(work: NativeHandoffWorkFacts): NativeHandoffWorkFacts {
  return Object.freeze({
    observationId: work.observationId,
    generation: work.generation,
    sessionId: work.sessionId,
    workspaceRoot: work.workspaceRoot,
  });
}

function addProducer(
  fixture: Fixture,
  selector: ProducerEntry["selector"],
  ref: HandoffProducerRef = {},
  callId = selector.parentToolCallId,
): ProducerEntry {
  const entry: ProducerEntry = {
    selector,
    ref,
    facts: {
      callId,
      workId: fixture.work.observationId,
      definitionVersion: "producer-v1",
    },
  };
  fixture.producers.set(producerKey(selector), entry);
  fixture.producersByCallId.set(entry.facts.callId, entry);
  return entry;
}

function addConsumer(
  fixture: Fixture,
  parentToolCallId: string,
  ref: object = {},
  completed = true,
): ConsumerEntry {
  const entry: ConsumerEntry = {
    parentToolCallId,
    ref,
    facts: {
      callId: parentToolCallId,
      workId: fixture.work.observationId,
      definitionVersion: "consumer-v1",
    },
    completed,
  };
  fixture.consumers.set(parentToolCallId, entry);
  fixture.repairConsumerRef = ref;
  return entry;
}

function makePreparedBase(
  fixture: Fixture,
  request: NativeHandoffPrepareRequest,
  work: NativeHandoffWorkFacts,
): { refresh: (context: NativeContext) => NativeHandoffCheck; revalidate: () => string | null } {
  let refreshCount = 0;
  return {
    refresh: (): NativeHandoffCheck => {
      refreshCount++;
      const override = fixture.onRefresh?.(refreshCount, request);
      if (override) return override;
      if (!sameWork(fixture.work, work)) {
        return { ok: false, reason: "the actual work changed" };
      }
      return { ok: true };
    },
    revalidate: () => fixture.revalidateImpl() as string | null,
  };
}

function basePrepare(
  fixture: Fixture,
  request: NativeHandoffPrepareRequest,
): NativeHandoffPrepareResult {
  const work = copyWork(fixture.work);
  const base = makePreparedBase(fixture, request, work);
  if (request.kind === "capture-initial") {
    const producer = fixture.producers.get(producerKey(request.request.producer));
    if (producer === undefined) return { ok: false, reason: "the selected producer result is unavailable" };
    return {
      ok: true,
      prepared: {
        kind: "capture-initial",
        work,
        producer: producer.ref,
        producerFacts: producer.facts,
        proposalFacts: {
          callId: request.actualToolCallId,
          workId: work.observationId,
          definitionVersion: "handoff-main-v1",
        },
        ...base,
      },
    };
  }
  if (request.kind === "capture-repair") {
    const producer = fixture.producers.get(producerKey(request.request.producer));
    if (producer === undefined) return { ok: false, reason: "the selected repair producer result is unavailable" };
    if (fixture.repairConsumerRef === null || producer.ref !== fixture.repairConsumerRef) {
      return { ok: false, reason: "the repair producer is not the selected repair consumer" };
    }
    return {
      ok: true,
      prepared: {
        kind: "capture-repair",
        work,
        producer: producer.ref,
        producerFacts: producer.facts,
        ...base,
      },
    };
  }
  if (request.kind === "offer") {
    const producer = fixture.producersByCallId.get(request.captureView.producer.callId);
    if (producer === undefined) return { ok: false, reason: "the source producer result is unavailable" };
    return {
      ok: true,
      prepared: { kind: "offer", work, producer: producer.ref, ...base },
    };
  }
  const producer = fixture.producersByCallId.get(request.captureView.producer.callId);
  const consumer = fixture.consumers.get(request.request.consumerParentToolCallId);
  if (producer === undefined) return { ok: false, reason: "the adoption producer result is unavailable" };
  if (consumer === undefined) return { ok: false, reason: "the selected consumer is unavailable" };
  if (!consumer.completed) return { ok: false, reason: "the consumer lifecycle is not completed" };
  return {
    ok: true,
    prepared: {
      kind: "adopt",
      work,
      producer: producer.ref,
      consumer: consumer.ref,
      consumerParentToolCallId: fixture.adoptConsumerParentOverride ?? consumer.parentToolCallId,
      ...base,
    },
  };
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await workspace();
  const rootRef = {};
  const store = openNativeHandoffStore(rootRef);
  const coordinator = createNativeHandoffCoordinator(
    rootRef,
    options.maxOperations === undefined ? undefined : { maxOperations: options.maxOperations },
  );
  const opens = { count: 0 };
  const delegate = options.fileIo ?? nodeFileIo;
  const fileIo: NativeFileIo = {
    O_RDONLY: delegate.O_RDONLY,
    O_NOFOLLOW: delegate.O_NOFOLLOW,
    realpath: (target) => delegate.realpath(target),
    lstat: (target, flags) => delegate.lstat(target, flags),
    open: async (target, flags) => {
      opens.count += 1;
      return delegate.open(target, flags);
    },
  };
  const fixture: Fixture = {
    work: {
      observationId: "observation-1",
      generation: 1,
      sessionId: "session-1",
      workspaceRoot: root,
      ...options.work,
    },
    producers: new Map(),
    producersByCallId: new Map(),
    consumers: new Map(),
    identifyCalls: 0,
    prepareCalls: 0,
    identifyOverride: null,
    prepareOverride: null,
    onRefresh: null,
    revalidateImpl: () => null,
    adoptConsumerParentOverride: null,
    repairConsumerRef: null,
    callRefs: new Map(),
    identityRevalidate: null,
    lastDescriptor: null,
    lastPrepareRequest: null,
  };
  const ports: NativeHandoffPorts = {
    identifyMainCall(actualToolCallId, context, prior, descriptor) {
      fixture.identifyCalls++;
      fixture.lastDescriptor = descriptor;
      if (fixture.identifyOverride !== null) {
        return fixture.identifyOverride(actualToolCallId, prior, descriptor);
      }
      if (context.agent?.kind !== "main") return { ok: false, reason: "not a main context" };
      const work = copyWork(fixture.work);
      let callRef = fixture.callRefs.get(actualToolCallId);
      if (callRef === undefined) {
        callRef = Object.freeze({ nativeCall: actualToolCallId });
        fixture.callRefs.set(actualToolCallId, callRef);
      }
      return {
        ok: true as const,
        callRef: prior ?? callRef,
        work,
        revalidate: () => fixture.identityRevalidate === null
          ? null
          : fixture.identityRevalidate() as string | null,
      };
    },
    prepareMain(request, context) {
      fixture.prepareCalls++;
      fixture.lastPrepareRequest = request;
      if (context.agent?.kind !== "main") {
        return { ok: false, reason: "not a main context" };
      }
      const base = () => basePrepare(fixture, request);
      return fixture.prepareOverride === null
        ? base()
        : fixture.prepareOverride(request, base);
    },
  };
  const context: NativeContext = {
    cwd: root,
    agent: { kind: "main" },
    sessionManager: { getSessionId: () => "session-1", getCwd: () => root },
  };
  const subContext: NativeContext = {
    cwd: root,
    agent: { kind: "sub" },
    sessionManager: { getSessionId: () => "session-1", getCwd: () => root },
  };
  const resolveRoot = (ctx: NativeContext): NativeHandoffRootResolution =>
    ctx.agent?.kind === "main"
      ? { ok: true, coordinator, ports }
      : { ok: false, reason: "not a main context" };
  const entry = createNativeHandoffEntry({
    resolveRoot,
    now: options.now ?? (() => 1),
    fileIo,
  });
  return {
    root,
    rootRef,
    store,
    coordinator,
    fixture,
    ports,
    entry,
    context,
    subContext,
    resolveRoot,
    opens,
  };
}

function defaultConditions(value = "done"): readonly unknown[] {
  return [{ id: "status", kind: "json-equals", pointer: "/status", value }];
}

function captureParams(
  selector: ProducerEntry["selector"],
  relativePath = "data.json",
  conditions = defaultConditions(),
): Record<string, unknown> {
  return { action: "capture", producer: selector, relativePath, conditions };
}

function exec(
  harness: Harness,
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  context?: NativeContext,
): Promise<NativeToolResult> {
  return harness.entry.tool.execute(
    toolCallId,
    params,
    signal ?? new AbortController().signal,
    null,
    context ?? harness.context,
  );
}

function details(result: NativeToolResult): Record<string, unknown> {
  return (result.details ?? {}) as Record<string, unknown>;
}

function text(result: NativeToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function resultBytes(result: NativeToolResult): number {
  return new TextEncoder().encode(JSON.stringify(result)).byteLength;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string result field");
  return value;
}

let readCounter = 0;
let checkCounter = 0;

function bindReadCheck(
  store: NativeHandoffStore,
  offerId: string,
  consumer: object,
  parentCall: object,
  fixture: Fixture,
): { receiptId: string; readDigest: string } {
  const offer = store.resolveOffer(offerId);
  if (offer === null) throw new Error("test offer is unavailable");
  store.bindOfferConsumer(offer, consumer, parentCall, {
    callId: "consumer-task",
    workId: fixture.work.observationId,
    definitionVersion: "consumer-v1",
  });
  const readTool = {};
  const readCallId = `read-${++readCounter}`;
  const prepared = store.prepareRead(offer, consumer, parentCall, readTool, readCallId);
  const observed = store.observeReadResult(
    prepared.read,
    consumer,
    parentCall,
    readTool,
    readCallId,
    prepared.digest,
    true,
  );
  expect(observed).toBe(true);
  const checkTool = {};
  const receipt = store.check(offer, consumer, parentCall, checkTool, `check-${++checkCounter}`);
  return { receiptId: receipt.receiptId, readDigest: prepared.digest };
}

function deferredIo(): {
  io: NativeFileIo;
  gate: Promise<void>;
  release: () => void;
} {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const io: NativeFileIo = {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: (target) => nodeFileIo.realpath(target),
    lstat: (target, flags) => nodeFileIo.lstat(target, flags),
    open: async (target, flags) => {
      await gate;
      return nodeFileIo.open(target, flags);
    },
  };
  return {
    io,
    gate,
    release: () => {
      if (release !== null) {
        release();
        release = null;
      }
    },
  };
}

function hookedIo(hook: () => void): NativeFileIo {
  return {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: (target) => nodeFileIo.realpath(target),
    lstat: (target, flags) => nodeFileIo.lstat(target, flags),
    open: async (target, flags) => {
      hook();
      return nodeFileIo.open(target, flags);
    },
  };
}

describe("bounded agent_handoff main entry", () => {
  test("captures, offers and adopts real temp-file facts with compact responses", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));

    const captured = await exec(harness, "call-capture", captureParams(producer.selector));
    expect(details(captured).resultKind).toBe("historical-operation-result");
    expect(details(captured).operationOutcome).toBe("succeeded");
    expect(details(captured).taskAccepted).toBe(false);
    expect(details(captured).semanticAcceptance).toBe("not-evaluated");
    expect(details(captured).proposalCallId).toBe("call-capture");
    expect(details(captured).producerCallId).toBe(producer.facts.callId);
    expect(details(captured).producerCallId).not.toBe(details(captured).proposalCallId);
    expect(resultBytes(captured)).toBeLessThanOrEqual(MAX_HANDOFF_OPERATION_RESPONSE_BYTES);
    const captureId = asString(details(captured).captureId);
    const initialOfferId = asString(details(captured).offerId);

    const view = harness.store.lookupCapture(captureId);
    expect(view?.proposal.callId).toBe("call-capture");
    expect(view?.producer.callId).toBe(producer.facts.callId);
    expect(view?.initial).toBe(true);

    const offered = await exec(harness, "call-offer", { action: "offer", captureId });
    expect(details(offered).resultKind).toBe("historical-operation-result");
    expect(details(offered).captureId).toBe(captureId);
    expect(harness.store.inspect().usage.offers).toBe(2);

    const consumer = {};
    const parentCall = {};
    addConsumer(harness.fixture, "consumer-parent", consumer, true);
    const { receiptId } = bindReadCheck(harness.store, initialOfferId, consumer, parentCall, harness.fixture);
    expect(harness.store.lookupReceipt(receiptId)?.outcome).toBe("fail");

    const adopted = await exec(harness, "call-adopt", {
      action: "adopt",
      receiptId,
      captureId,
      consumerParentToolCallId: "consumer-parent",
    });
    expect(details(adopted).resultKind).toBe("historical-operation-result");
    expect(details(adopted).outcome).toBe("fail");
    expect(details(adopted).taskAccepted).toBe(false);
    expect(details(adopted).semanticAcceptance).toBe("not-evaluated");
    expect(harness.store.inspect().usage.adoptions).toBe(1);

    const inspection = await exec(harness, "call-inspect", { action: "inspect" });
    expect(details(inspection).resultKind).toBe("inspection");
    const inspectView = details(inspection).inspect as { usage: { captures: number; adoptions: number } };
    expect(inspectView.usage.captures).toBe(1);
    expect(inspectView.usage.adoptions).toBe(1);
    expect(resultBytes(inspection)).toBeLessThanOrEqual(MAX_HANDOFF_INSPECT_RESPONSE_BYTES);
  });

  test("repairs inherit the original path and frozen plan while recording a new producer", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));

    const captured = await exec(harness, "call-capture", captureParams(producer.selector));
    const captureId = asString(details(captured).captureId);
    const initialOfferId = asString(details(captured).offerId);
    const initialPlan = asString(details(captured).planDigest);
    const initialView = harness.store.lookupCapture(captureId);
    expect(initialView).not.toBeNull();

    const consumer = {};
    const parentCall = {};
    addConsumer(harness.fixture, "consumer-parent", consumer, true);
    const { receiptId } = bindReadCheck(harness.store, initialOfferId, consumer, parentCall, harness.fixture);
    const adopted = await exec(harness, "call-adopt-fail", {
      action: "adopt",
      receiptId,
      captureId,
      consumerParentToolCallId: "consumer-parent",
    });
    expect(details(adopted).outcome).toBe("fail");
    const failAdoptionId = asString(details(adopted).adoptionId);

    const offered = await exec(harness, "call-offer-repair", {
      action: "offer",
      captureId,
      failAdoptionId,
    });
    expect(details(offered).resultKind).toBe("historical-operation-result");
    const repairOfferId = asString(details(offered).offerId);
    await writeRelative(harness.root, "data.json", '{"status":"done"}');
    bindReadCheck(harness.store, repairOfferId, consumer, parentCall, harness.fixture);

    const repairProducer = addProducer(harness.fixture, selectorFor(2), consumer);
    const repaired = await exec(harness, "call-repair", {
      action: "capture",
      producer: repairProducer.selector,
      fromOfferId: repairOfferId,
    });
    expect(details(repaired).resultKind).toBe("historical-operation-result");
    const repairedId = asString(details(repaired).captureId);
    expect(details(repaired).version).toBe(2);
    expect(details(repaired).baseCaptureId).toBe(captureId);
    expect(details(repaired).repairOfferId).toBe(repairOfferId);
    expect(details(repaired).planDigest).toBe(initialPlan);
    expect(details(repaired).initial).toBe(false);

    const repairView = harness.store.lookupCapture(repairedId);
    expect(repairView?.relativePath).toBe(initialView?.relativePath);
    expect(repairView?.planDigest).toBe(initialPlan);
    expect(repairView?.proposal.callId).toBe("call-capture");
    expect(repairView?.producer.callId).toBe(repairProducer.facts.callId);
    expect(repairView?.producer.callId).not.toBe("call-capture");
  });

  test("strictly refuses unknown, exclusive and accessor fields", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));

    const bad = [
      { action: "capture", producer: producer.selector },
      { action: "capture", producer: producer.selector, relativePath: "data.json", conditions: defaultConditions(), fromOfferId: "offer-1" },
      { action: "capture", producer: producer.selector, relativePath: "data.json", conditions: defaultConditions(), extra: true },
      { action: "offer" },
      { action: "adopt", receiptId: "r", captureId: "c" },
      { action: "inspect", extra: true },
      { action: "other" },
    ];
    for (let index = 0; index < bad.length; index++) {
      const result = await exec(harness, `bad-${index}`, bad[index]);
      expect(details(result).resultKind).toBe("not-admitted");
      expect(text(result).length).toBeGreaterThan(0);
    }

    let getterCalls = 0;
    const accessor = { action: "capture", producer: producer.selector, relativePath: "data.json" };
    Object.defineProperty(accessor, "conditions", {
      enumerable: true,
      get() {
        getterCalls++;
        return defaultConditions();
      },
    });
    const accessorResult = await exec(harness, "bad-accessor", accessor);
    expect(details(accessorResult).resultKind).toBe("not-admitted");
    expect(getterCalls).toBe(0);

    const usage = harness.store.inspect().usage;
    expect(usage.captures).toBe(0);
    expect(usage.chains).toBe(0);
    expect(harness.fixture.prepareCalls).toBe(0);
  });

  test("refuses wrong main/sub identity, foreign coordinators and missing ports", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));

    const sub = await exec(harness, "call-sub", captureParams(producer.selector), undefined, harness.subContext);
    expect(details(sub).resultKind).toBe("not-admitted");
    expect(harness.store.inspect().usage.captures).toBe(0);

    const foreign = createNativeHandoffEntry({
      resolveRoot: () => ({
        ok: true,
        coordinator: { closed: false, close() {} } as NativeHandoffCoordinator,
        ports: harness.ports,
      }),
      now: () => 1,
      fileIo: nodeFileIo,
    });
    const foreignResult = await foreign.tool.execute(
      "call-foreign",
      captureParams(producer.selector),
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(foreignResult).resultKind).toBe("not-admitted");

    const missingPorts = createNativeHandoffEntry({
      resolveRoot: () => ({
        ok: true,
        coordinator: harness.coordinator,
        ports: {} as NativeHandoffPorts,
      }),
      now: () => 1,
      fileIo: nodeFileIo,
    });
    const missingResult = await missingPorts.tool.execute(
      "call-missing-ports",
      captureParams(producer.selector),
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(missingResult).resultKind).toBe("not-admitted");

    const ok = await exec(harness, "call-main", captureParams(producer.selector));
    expect(details(ok).resultKind).toBe("historical-operation-result");
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("refuses missing, duck, accessor and proxy AbortSignals without reading their state", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const missing = await harness.entry.tool.execute("signal-call", params, undefined, null, harness.context);
    expect(details(missing).resultKind).toBe("not-admitted");

    const duck = await harness.entry.tool.execute(
      "signal-call",
      params,
      { aborted: false } as unknown as AbortSignal,
      null,
      harness.context,
    );
    expect(details(duck).resultKind).toBe("not-admitted");

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "aborted", {
      get() {
        getterCalls++;
        return false;
      },
    });
    const accessorResult = await harness.entry.tool.execute(
      "signal-call",
      params,
      accessor as unknown as AbortSignal,
      null,
      harness.context,
    );
    expect(details(accessorResult).resultKind).toBe("not-admitted");
    expect(getterCalls).toBe(0);

    let proxyGets = 0;
    const real = new AbortController().signal;
    const proxy = new Proxy(real, {
      get() {
        proxyGets++;
        throw new Error("proxy getter must not run");
      },
    });
    const proxyResult = await harness.entry.tool.execute(
      "signal-call",
      params,
      proxy,
      null,
      harness.context,
    );
    expect(details(proxyResult).resultKind).toBe("not-admitted");
    expect(proxyGets).toBe(0);

    const valid = await exec(harness, "signal-call", params);
    expect(details(valid).resultKind).toBe("historical-operation-result");
  });

  test("refuses async or malformed trusted gates before publication", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const asyncIdentifyEntry = createNativeHandoffEntry({
      resolveRoot: () => ({ ok: true, coordinator: harness.coordinator, ports: {
        identifyMainCall: (async () => ({ ok: true, callRef: {}, work: harness.fixture.work })) as never,
        prepareMain: (() => ({ ok: false, reason: "unused" })) as never,
      } }),
      now: () => 1,
      fileIo: nodeFileIo,
    });
    const asyncIdentify = await asyncIdentifyEntry.tool.execute(
      "async-identify",
      params,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(asyncIdentify).resultKind).toBe("not-admitted");
    expect(harness.store.inspect().usage.captures).toBe(0);

    const asyncPrepareEntry = createNativeHandoffEntry({
      resolveRoot: () => ({ ok: true, coordinator: harness.coordinator, ports: {
        identifyMainCall: harness.ports.identifyMainCall,
        prepareMain: (async () => ({ ok: false, reason: "not synchronous" })) as never,
      } }),
      now: () => 1,
      fileIo: nodeFileIo,
    });
    const asyncPrepare = await asyncPrepareEntry.tool.execute(
      "async-prepare",
      params,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(asyncPrepare).resultKind).toBe("historical-operation-result");
    expect(details(asyncPrepare).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);

    const replay = await asyncPrepareEntry.tool.execute(
      "async-prepare",
      params,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(replay).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);

    harness.fixture.onRefresh = () => Promise.resolve({ ok: true }) as never;
    const asyncRefresh = await exec(harness, "async-refresh", params);
    expect(details(asyncRefresh).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
    harness.fixture.onRefresh = null;

    harness.fixture.revalidateImpl = () => ({ ok: true });
    const objectRevalidate = await exec(harness, "object-revalidate", params);
    expect(details(objectRevalidate).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
  });

  test("copies bounded input and enforces the preflight request digest", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    const originalConditions = params.conditions as Array<{ value: string }>;

    const pending = exec(harness, "copy-call", params);
    (params as Record<string, unknown>).relativePath = "other.json";
    originalConditions[0]!.value = "changed";
    const captured = await pending;
    expect(details(captured).resultKind).toBe("historical-operation-result");
    const descriptor = harness.fixture.lastDescriptor;
    expect(descriptor?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(harness.fixture.lastPrepareRequest?.requestDigest).toBe(descriptor?.digest);
    expect(descriptor?.params.action).toBe("capture");
    if (descriptor?.params.action !== "capture" || descriptor.params.mode !== "initial") {
      throw new Error("expected an initial capture descriptor");
    }
    expect(descriptor.params.relativePath).toBe("data.json");
    expect((descriptor.params.conditions[0] as { value: string }).value).toBe("done");
    const captureId = asString(details(captured).captureId);
    expect(harness.store.lookupCapture(captureId)?.relativePath).toBe("data.json");

    const replay = await exec(harness, "copy-call", captureParams(producer.selector));
    expect(details(replay).captureId).toBe(captureId);
    expect(harness.store.inspect().usage.captures).toBe(1);

    const conflicting = await exec(harness, "copy-call", captureParams(producer.selector, "data.json", defaultConditions("other")));
    expect(details(conflicting).resultKind).toBe("conflict");
    expect(details(conflicting).stickyConflict).toBe(true);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("joins concurrent same-call execution with one prepare, read and commit", async () => {
    const gate = deferredIo();
    const harness = await makeHarness({ fileIo: gate.io });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const first = exec(harness, "concurrent-call", params);
    const second = exec(harness, "concurrent-call", params);
    gate.release();
    const [a, b] = await Promise.all([first, second]);

    expect(details(a).resultKind).toBe("historical-operation-result");
    expect(details(b).resultKind).toBe("historical-operation-result");
    expect(details(a).captureId).toBe(details(b).captureId);
    expect(harness.fixture.prepareCalls).toBe(1);
    expect(harness.opens.count).toBe(1);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("does not merge different actual calls with identical parameters", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const first = await exec(harness, "different-call-a", params);
    const second = await exec(harness, "different-call-b", params);
    expect(details(first).captureId).not.toBe(details(second).captureId);
    expect(harness.fixture.prepareCalls).toBe(2);
    expect(harness.opens.count).toBe(2);
    expect(harness.store.inspect().usage.captures).toBe(2);
  });

  test("refuses a changed original native call reference on replay", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const captured = await exec(harness, "reference-call", params);
    const captureId = asString(details(captured).captureId);
    harness.fixture.identifyOverride = (_id, prior) => ({
      ok: true,
      callRef: Object.freeze({ nativeCall: "swapped" }),
      work: copyWork(harness.fixture.work),
      revalidate: () => null,
    });
    const refused = await exec(harness, "reference-call", params);
    expect(details(refused).resultKind).toBe("not-admitted");
    expect(harness.store.inspect().usage.captures).toBe(1);
    expect(harness.opens.count).toBe(1);

    harness.fixture.identifyOverride = null;
    const replayed = await exec(harness, "reference-call", params);
    expect(details(replayed).captureId).toBe(captureId);
    expect(harness.store.inspect().usage.captures).toBe(1);
    expect(harness.opens.count).toBe(1);
  });

  test("sticks a during-I/O conflict and releases the pending reservation", async () => {
    let conflictPromise: Promise<NativeToolResult> | null = null;
    const gate = deferredIo();
    const conflictIo: NativeFileIo = {
      ...gate.io,
      open: async (target, flags) => {
        conflictPromise = exec(
          harness,
          "conflict-call",
          captureParams(producer.selector, "data.json", defaultConditions("other")),
        );
        return gate.io.open(target, flags);
      },
    };
    const harness = await makeHarness({ fileIo: conflictIo });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const first = exec(harness, "conflict-call", captureParams(producer.selector));
    gate.release();
    const result = await first;
    expect(details(result).resultKind).toBe("historical-operation-result");
    expect(details(result).operationOutcome).toBe("failed");
    expect(conflictPromise).not.toBeNull();
    const conflictResult = await conflictPromise!;
    expect(details(conflictResult).resultKind).toBe("conflict");
    expect(harness.fixture.prepareCalls).toBe(1);
    expect(harness.opens.count).toBe(1);
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);

    const replay = await exec(harness, "conflict-call", captureParams(producer.selector));
    expect(details(replay).resultKind).toBe("conflict");
    expect(harness.store.inspect().usage.captures).toBe(0);
  });

  test("closes the root during I/O without publishing or resurrecting it", async () => {
    const harness = await makeHarness();
    harness.entry.dispose();
    const closeEntry = createNativeHandoffEntry({
      resolveRoot: harness.resolveRoot,
      now: () => 1,
      fileIo: hookedIo(() => harness.coordinator.close()),
    });
    const entry = closeEntry;
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const result = await entry.tool.execute(
      "closed-call",
      captureParams(producer.selector),
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(result).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
    expect(harness.store.inspect().state).toBe("active");

    const newCall = await entry.tool.execute(
      "post-close-call",
      captureParams(producer.selector),
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(newCall).resultKind).toBe("not-admitted");
    const again = createNativeHandoffCoordinator(harness.rootRef);
    expect(again).toBe(harness.coordinator);
    expect(again.closed).toBe(true);
    expect(harness.store.inspect().usage.captures).toBe(0);
    closeEntry.dispose();
  });

  test("aborts publication when the actual work changes during I/O", async () => {
    const harness = await makeHarness();
    harness.entry.dispose();
    const workEntry = createNativeHandoffEntry({
      resolveRoot: harness.resolveRoot,
      now: () => 1,
      fileIo: hookedIo(() => {
        harness.fixture.work = Object.freeze({
          ...harness.fixture.work,
          generation: 2,
        });
      }),
    });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const result = await workEntry.tool.execute(
      "work-change-call",
      captureParams(producer.selector),
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(result).resultKind).toBe("historical-operation-result");
    expect(details(result).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
    workEntry.dispose();
  });

  test("treats a missing file as terminal for the same call and retries only with a new call", async () => {
    const harness = await makeHarness();
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector, "missing.json");

    const missing = await exec(harness, "missing-call", params);
    expect(details(missing).resultKind).toBe("historical-operation-result");
    expect(details(missing).operationOutcome).toBe("failed");
    expect(details(missing).reason).toContain("missing");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
    const opensAfterMissing = harness.opens.count;

    await writeRelative(harness.root, "missing.json", '{"status":"pending"}');
    const replay = await exec(harness, "missing-call", params);
    expect(details(replay).operationOutcome).toBe("failed");
    expect(details(replay).reason).toBe(details(missing).reason);
    expect(harness.opens.count).toBe(opensAfterMissing);
    expect(harness.store.inspect().usage.captures).toBe(0);

    const retry = await exec(harness, "missing-call-new", params);
    expect(details(retry).operationOutcome).toBe("succeeded");
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("keeps old replays available at capacity and refuses new operations", async () => {
    const harness = await makeHarness({ maxOperations: 1 });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);

    const first = await exec(harness, "capacity-call", params);
    const captureId = asString(details(first).captureId);
    const opens = harness.opens.count;
    const second = await exec(harness, "capacity-call-2", params);
    expect(details(second).resultKind).toBe("not-admitted");
    expect(harness.store.inspect().usage.captures).toBe(1);

    const replay = await exec(harness, "capacity-call", params);
    expect(details(replay).captureId).toBe(captureId);
    expect(harness.opens.count).toBe(opens);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("cancels only the joining wait, not the original operation", async () => {
    const gate = deferredIo();
    const harness = await makeHarness({ fileIo: gate.io });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    const ownerSignal = new AbortController();
    const joinerSignal = new AbortController();

    const owner = exec(harness, "join-call", params, ownerSignal.signal);
    const joiner = exec(harness, "join-call", params, joinerSignal.signal);
    joinerSignal.abort();
    const cancelled = await joiner;
    expect(details(cancelled).resultKind).toBe("not-admitted");
    expect(details(cancelled).reason).toContain("cancelled");
    gate.release();
    const completed = await owner;
    expect(details(completed).resultKind).toBe("historical-operation-result");
    expect(details(completed).operationOutcome).toBe("succeeded");
    expect(harness.store.inspect().usage.captures).toBe(1);
    expect(harness.opens.count).toBe(1);
  });

  test("final host refresh re-entry cannot bypass the pure slot gate", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    let reentered: Promise<NativeToolResult> | null = null;
    harness.fixture.onRefresh = (count) => {
      if (count === 2) {
        reentered = exec(
          harness,
          "reentry-call",
          captureParams(producer.selector, "data.json", defaultConditions("other")),
        );
      }
      return null;
    };
    const result = await exec(harness, "reentry-call", captureParams(producer.selector));
    expect(details(result).resultKind).toBe("historical-operation-result");
    expect(details(result).operationOutcome).toBe("failed");
    expect(reentered).not.toBeNull();
    const conflictResult = await reentered!;
    expect(details(conflictResult).resultKind).toBe("conflict");
    expect(harness.fixture.prepareCalls).toBe(1);
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);
  });

  test("refuses cross-work offers at the core binding matcher", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const captured = await exec(harness, "work-a-call", captureParams(producer.selector));
    const captureId = asString(details(captured).captureId);
    expect(harness.store.inspect().usage.offers).toBe(1);

    harness.fixture.work = Object.freeze({
      ...harness.fixture.work,
      observationId: "observation-2",
      generation: 2,
    });
    const offered = await exec(harness, "work-b-offer", { action: "offer", captureId });
    expect(details(offered).resultKind).toBe("historical-operation-result");
    expect(details(offered).operationOutcome).toBe("failed");
    expect(details(offered).reason).toContain("not bound");
    expect(harness.store.inspect().usage.offers).toBe(1);
  });

  test("refuses uncompleted or mismatched consumers before adoption I/O", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const captured = await exec(harness, "adopt-capture", captureParams(producer.selector));
    const captureId = asString(details(captured).captureId);
    const offerId = asString(details(captured).offerId);
    const consumer = {};
    const parentCall = {};
    addConsumer(harness.fixture, "consumer-parent", consumer, false);
    const { receiptId } = bindReadCheck(harness.store, offerId, consumer, parentCall, harness.fixture);
    const opens = harness.opens.count;

    const incomplete = await exec(harness, "adopt-incomplete", {
      action: "adopt",
      receiptId,
      captureId,
      consumerParentToolCallId: "consumer-parent",
    });
    expect(details(incomplete).operationOutcome).toBe("failed");
    expect(details(incomplete).reason).toContain("not completed");
    expect(harness.opens.count).toBe(opens);
    expect(harness.store.inspect().usage.adoptions).toBe(0);

    harness.fixture.consumers.get("consumer-parent")!.completed = true;
    harness.fixture.adoptConsumerParentOverride = "different-parent";
    const mismatched = await exec(harness, "adopt-mismatch", {
      action: "adopt",
      receiptId,
      captureId,
      consumerParentToolCallId: "consumer-parent",
    });
    expect(details(mismatched).operationOutcome).toBe("failed");
    expect(details(mismatched).reason).toContain("consumer parent");
    expect(harness.opens.count).toBe(opens);
    expect(harness.store.inspect().usage.adoptions).toBe(0);

    harness.fixture.adoptConsumerParentOverride = null;
    const adopted = await exec(harness, "adopt-success", {
      action: "adopt",
      receiptId,
      captureId,
      consumerParentToolCallId: "consumer-parent",
    });
    expect(details(adopted).operationOutcome).toBe("succeeded");
    expect(details(adopted).outcome).toBe("fail");
    expect(harness.store.inspect().usage.adoptions).toBe(1);
  });

  test("reports genuine post-commit response failure without rerunning or claiming no commit", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    const originalLookup = harness.store.lookupCapture;
    Object.defineProperty(harness.store, "lookupCapture", {
      configurable: true,
      value: () => {
        throw new Error("post-commit response failure");
      },
    });
    let captured: NativeToolResult;
    try {
      captured = await exec(harness, "post-commit-call", params);
    } finally {
      Object.defineProperty(harness.store, "lookupCapture", {
        configurable: true,
        value: originalLookup,
      });
    }
    expect(details(captured).committed).toBe(true);
    expect(details(captured).operationOutcome).toBe("committed-response-unavailable");
    expect(details(captured).captureId).toBeTruthy();
    expect(details(captured).offerId).toBeTruthy();
    expect(harness.store.inspect().usage.captures).toBe(1);
    const opens = harness.opens.count;

    const replay = await exec(harness, "post-commit-call", params);
    expect(details(replay).operationOutcome).toBe("committed-response-unavailable");
    expect(details(replay).captureId).toBe(details(captured).captureId);
    expect(harness.opens.count).toBe(opens);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("inspect stays slot-free and entry disposal leaves the root store alive", async () => {
    const harness = await makeHarness({ maxOperations: 1 });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    await exec(harness, "slot-capture", captureParams(producer.selector));

    const inspection = await exec(harness, "slot-free-inspect", { action: "inspect" });
    expect(details(inspection).resultKind).toBe("inspection");
    expect(resultBytes(inspection)).toBeLessThanOrEqual(MAX_HANDOFF_INSPECT_RESPONSE_BYTES);

    const capacity = await exec(harness, "slot-new-call", captureParams(producer.selector));
    expect(details(capacity).resultKind).toBe("not-admitted");

    harness.entry.dispose();
    const disposed = await exec(harness, "slot-free-inspect", { action: "inspect" });
    expect(details(disposed).resultKind).toBe("not-admitted");
    expect(harness.coordinator.closed).toBe(false);
    expect(harness.store.inspect().state).toBe("active");
    expect(harness.store.inspect().usage.captures).toBe(1);

    const secondEntry = createNativeHandoffEntry({
      resolveRoot: harness.resolveRoot,
      now: () => 1,
      fileIo: nodeFileIo,
    });
    const secondInspect = await secondEntry.tool.execute(
      "second-entry-inspect",
      { action: "inspect" },
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(secondInspect).resultKind).toBe("inspection");
    secondEntry.dispose();
    expect(harness.store.inspect().state).toBe("active");
  });
});


describe("handoff entry review regressions", () => {
  test("identify reentry joins the operation created during the callback", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    let inner: Promise<NativeToolResult> | null = null;
    let first = true;
    harness.fixture.identifyOverride = (_id, _prior) => {
      if (first) {
        first = false;
        harness.fixture.identifyOverride = null;
        inner = exec(harness, "identify-reentry", params);
      }
      return {
        ok: true,
        callRef: harness.fixture.callRefs.get("identify-reentry")!,
        work: copyWork(harness.fixture.work),
        revalidate: () => null,
      };
    };

    const outer = await exec(harness, "identify-reentry", params);
    expect(inner).not.toBeNull();
    const innerResult = await inner!;
    expect(details(outer).operationOutcome).toBe("succeeded");
    expect(details(innerResult).operationOutcome).toBe("succeeded");
    expect(details(outer).captureId).toBe(details(innerResult).captureId);
    expect(harness.fixture.prepareCalls).toBe(1);
    expect(harness.opens.count).toBe(1);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("prepare reentry joins the deferred operation promise instead of starting again", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    let inner: Promise<NativeToolResult> | null = null;
    let first = true;
    harness.fixture.prepareOverride = (request, base) => {
      if (first) {
        first = false;
        inner = exec(harness, "prepare-reentry", params);
      }
      return base();
    };

    const outer = await exec(harness, "prepare-reentry", params);
    expect(inner).not.toBeNull();
    const innerResult = await inner!;
    expect(details(outer).operationOutcome).toBe("succeeded");
    expect(details(innerResult).operationOutcome).toBe("succeeded");
    expect(details(outer).captureId).toBe(details(innerResult).captureId);
    expect(harness.fixture.prepareCalls).toBe(1);
    expect(harness.opens.count).toBe(1);
    expect(harness.store.inspect().usage.captures).toBe(1);
  });

  test("pre-effect close, dispose and abort happen before file-system effects", async () => {
    const closeHarness = await makeHarness();
    await writeRelative(closeHarness.root, "data.json", '{"status":"pending"}');
    const closeProducer = addProducer(closeHarness.fixture, selectorFor(1));
    closeHarness.fixture.onRefresh = (count) => {
      if (count === 1) closeHarness.coordinator.close();
      return null;
    };
    const closed = await exec(closeHarness, "pre-close", captureParams(closeProducer.selector));
    expect(details(closed).operationOutcome).toBe("failed");
    expect(closeHarness.opens.count).toBe(0);
    expect(closeHarness.store.inspect().usage.pendingReservations).toBe(0);
    expect(closeHarness.store.inspect().usage.captures).toBe(0);

    const abortHarness = await makeHarness();
    await writeRelative(abortHarness.root, "data.json", '{"status":"pending"}');
    const abortProducer = addProducer(abortHarness.fixture, selectorFor(1));
    const controller = new AbortController();
    const clockEntry = createNativeHandoffEntry({
      resolveRoot: abortHarness.resolveRoot,
      now: () => {
        controller.abort();
        return 1;
      },
      fileIo: nodeFileIo,
    });
    const aborted = await clockEntry.tool.execute(
      "pre-abort",
      captureParams(abortProducer.selector),
      controller.signal,
      null,
      abortHarness.context,
    );
    expect(details(aborted).operationOutcome).toBe("failed");
    expect(abortHarness.store.inspect().usage.captures).toBe(0);
    expect(abortHarness.store.inspect().usage.pendingReservations).toBe(0);
    clockEntry.dispose();

    const disposeHarness = await makeHarness();
    await writeRelative(disposeHarness.root, "data.json", '{"status":"pending"}');
    const disposeProducer = addProducer(disposeHarness.fixture, selectorFor(1));
    let disposedEntry: NativeHandoffEntry | null = null;
    disposedEntry = createNativeHandoffEntry({
      resolveRoot: disposeHarness.resolveRoot,
      now: () => {
        disposedEntry!.dispose();
        return 1;
      },
      fileIo: nodeFileIo,
    });
    const disposed = await disposedEntry.tool.execute(
      "pre-dispose",
      captureParams(disposeProducer.selector),
      new AbortController().signal,
      null,
      disposeHarness.context,
    );
    expect(details(disposed).operationOutcome).toBe("failed");
    expect(disposeHarness.store.inspect().usage.captures).toBe(0);
    expect(disposeHarness.store.inspect().usage.pendingReservations).toBe(0);
  });

  test("preserves malformed input shapes for A1 and refuses reflection failures", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));

    const protoCondition: Record<string, unknown> = {
      id: "status",
      kind: "json-equals",
      pointer: "/status",
      value: "done",
    };
    Object.defineProperty(protoCondition, "__proto__", {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const protoResult = await exec(
      harness,
      "proto-call",
      captureParams(producer.selector, "data.json", [protoCondition]),
    );
    expect(details(protoResult).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.opens.count).toBe(0);

    const conditions = [{ id: "status", kind: "json-equals", pointer: "/status", value: "done" }];
    Object.defineProperty(conditions, "0", {
      value: conditions[0],
      enumerable: false,
      configurable: true,
      writable: true,
    });
    const nonEnumerable = await exec(
      harness,
      "non-enumerable-call",
      captureParams(producer.selector, "data.json", conditions),
    );
    expect(details(nonEnumerable).resultKind).toBe("not-admitted");

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const revoked = await harness.entry.tool.execute(
      "revoked-call",
      revocable.proxy,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(revoked).resultKind).toBe("not-admitted");
    expect(harness.store.inspect().usage.captures).toBe(0);
  });

  test("rejects coordinator option accessors without replacing the existing coordinator", async () => {
    const rootRef = {};
    const first = createNativeHandoffCoordinator(rootRef, { maxOperations: 1 });
    let getterCalls = 0;
    const options = Object.defineProperty({}, "maxOperations", {
      enumerable: true,
      get() {
        getterCalls++;
        return 5;
      },
    });
    expect(() => createNativeHandoffCoordinator(rootRef, options as never)).toThrow(NativeHandoffError);
    expect(getterCalls).toBe(0);
    const again = createNativeHandoffCoordinator(rootRef, { maxOperations: 64 });
    expect(again).toBe(first);
    expect(again.closed).toBe(false);

    const secondRoot = {};
    expect(createNativeHandoffCoordinator(secondRoot, {})).not.toBe(first);
  });

  test("owner cancellation during I/O releases the reservation and stays terminal for that call", async () => {
    const harness = await makeHarness();
    harness.entry.dispose();
    const controller = new AbortController();
    const abortEntry = createNativeHandoffEntry({
      resolveRoot: harness.resolveRoot,
      now: () => 1,
      fileIo: hookedIo(() => controller.abort()),
    });
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    const cancelled = await abortEntry.tool.execute(
      "io-abort-call",
      params,
      controller.signal,
      null,
      harness.context,
    );
    expect(details(cancelled).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);
    expect(harness.store.inspect().usage.pendingReservations).toBe(0);

    const replay = await abortEntry.tool.execute(
      "io-abort-call",
      params,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(replay).operationOutcome).toBe("failed");
    expect(harness.store.inspect().usage.captures).toBe(0);

    const retry = await abortEntry.tool.execute(
      "io-abort-call-new",
      params,
      new AbortController().signal,
      null,
      harness.context,
    );
    expect(details(retry).operationOutcome).toBe("succeeded");
    expect(harness.store.inspect().usage.captures).toBe(1);
    abortEntry.dispose();
  });

  test("bounds mutation responses for maximal quoted paths and unicode call ids", async () => {
    const harness = await makeHarness();
    const segment = '"'.repeat(200);
    const relativePath = [segment, segment, segment, `${segment.slice(0, 197)}.js`].join("/");
    await writeRelative(harness.root, relativePath, '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const callId = "𐀀".repeat(120);
    const captured = await exec(harness, callId, captureParams(producer.selector, relativePath));
    expect(details(captured).operationOutcome).toBe("succeeded");
    expect(resultBytes(captured)).toBeLessThanOrEqual(MAX_HANDOFF_OPERATION_RESPONSE_BYTES);
    const captureId = asString(details(captured).captureId);
    expect(harness.store.lookupCapture(captureId)?.relativePath).toBe(relativePath);
  });

  test("identity pure revalidate blocks cached replay and inspect", async () => {
    const harness = await makeHarness();
    await writeRelative(harness.root, "data.json", '{"status":"pending"}');
    const producer = addProducer(harness.fixture, selectorFor(1));
    const params = captureParams(producer.selector);
    const captured = await exec(harness, "identity-call", params);
    const captureId = asString(details(captured).captureId);
    const opens = harness.opens.count;

    const originalOverride = harness.fixture.identifyOverride;
    harness.fixture.identifyOverride = (_id, _prior) => ({
      ok: true,
      callRef: harness.fixture.callRefs.get("identity-call")!,
      work: copyWork(harness.fixture.work),
    } as never);
    const missingPure = await exec(harness, "identity-call", params);
    expect(details(missingPure).resultKind).toBe("not-admitted");
    harness.fixture.identifyOverride = originalOverride;

    harness.fixture.identityRevalidate = () => "native call identity is stale";
    const replay = await exec(harness, "identity-call", params);
    expect(details(replay).resultKind).toBe("not-admitted");
    expect(details(replay).reason).toContain("stale");
    expect(harness.opens.count).toBe(opens);
    expect(harness.store.inspect().usage.captures).toBe(1);

    const inspection = await exec(harness, "identity-inspect", { action: "inspect" });
    expect(details(inspection).resultKind).toBe("not-admitted");

    harness.fixture.identityRevalidate = null;
    const recovered = await exec(harness, "identity-call", params);
    expect(details(recovered).captureId).toBe(captureId);
    expect(harness.opens.count).toBe(opens);
  });
});

interface PassReportSetup {
  harness: Harness;
  producer: ProducerEntry;
  consumer: object;
  parentCall: object;
  captureId: string;
  offerId: string;
  adoptionId: string;
  receiptId: string;
}

async function passReportSetup(
  options: HarnessOptions = {},
  observeAdoption?: (input: {
    harness: Harness;
    adoptionId: string;
    producer: ProducerEntry;
    consumer: object;
    parentCall: object;
  }) => void,
): Promise<PassReportSetup> {
  const harness = await makeHarness(options);
  await writeRelative(harness.root, "data.json", '{"status":"done"}');
  const producer = addProducer(harness.fixture, selectorFor(1));
  const captured = await exec(harness, "call-capture", captureParams(producer.selector));
  expect(details(captured).operationOutcome).toBe("succeeded");
  const captureId = asString(details(captured).captureId);
  const offerId = asString(details(captured).offerId);

  const consumer = {};
  const parentCall = {};
  addConsumer(harness.fixture, "consumer-parent", consumer, true);
  const { receiptId } = bindReadCheck(harness.store, offerId, consumer, parentCall, harness.fixture);
  expect(harness.store.lookupReceipt(receiptId)?.outcome).toBe("pass");

  if (observeAdoption !== undefined) {
    const originalAdopt = harness.store.adopt.bind(harness.store);
    harness.store.adopt = (request) => {
      const adoption = originalAdopt(request);
      observeAdoption({
        harness,
        adoptionId: adoption.adoptionId,
        producer,
        consumer,
        parentCall,
      });
      return adoption;
    };
  }

  const adopted = await exec(harness, "call-adopt", {
    action: "adopt",
    receiptId,
    captureId,
    consumerParentToolCallId: "consumer-parent",
  });
  expect(details(adopted).operationOutcome).toBe("succeeded");
  expect(details(adopted).outcome).toBe("pass");
  return {
    harness,
    producer,
    consumer,
    parentCall,
    captureId,
    offerId,
    adoptionId: asString(details(adopted).adoptionId),
    receiptId,
  };
}

function reportRequest(
  setup: Pick<PassReportSetup, "harness" | "producer" | "consumer" | "parentCall" | "adoptionId">,
  overrides: Partial<NativeHandoffReportPrepareRequest> = {},
): NativeHandoffReportPrepareRequest {
  return {
    adoptionId: setup.adoptionId,
    work: copyWork(setup.harness.fixture.work),
    producer: setup.producer.ref,
    consumer: setup.consumer,
    consumerParentTaskCall: setup.parentCall,
    ...overrides,
  };
}

describe("native handoff report preparation", () => {
  test("prepares exact PASS core facts and refuses changed refs or foreign coordinators", async () => {
    const setup = await passReportSetup();
    const prepared = prepareNativeHandoffReport(setup.harness.coordinator, reportRequest(setup));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(`report preparation failed: ${prepared.reason}`);
    const adoptionView = setup.harness.store.lookupAdoption(setup.adoptionId)!;
    const captureView = setup.harness.store.lookupCapture(setup.captureId)!;
    expect(prepared.prepared.facts.adoption).toEqual(adoptionView);
    expect(prepared.prepared.facts.adoption.outcome).toBe("pass");
    expect(prepared.prepared.facts.adoption.taskAccepted).toBe(false);
    expect(prepared.prepared.facts.adoption.semanticAcceptance).toBe("not-evaluated");
    expect(prepared.prepared.facts.snapshotId).toBe(captureView.snapshotId);
    expect(prepared.prepared.facts.checkerId).toBe(captureView.checkerId);
    expect(prepared.prepared.facts.checkerVersion).toBe(captureView.checkerVersion);
    expect(Object.isFrozen(prepared.prepared.facts)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(prepared.prepared.facts)).byteLength)
      .toBeLessThanOrEqual(32 * 1024);
    expect(prepared.prepared.revalidate()).toBeNull();
    expect(prepared.prepared.revalidate()).toBeNull();

    const wrongWork = {
      observationId: "other-observation",
      generation: 1,
      sessionId: "session-1",
      workspaceRoot: setup.harness.root,
    };
    for (const overrides of [
      { producer: {} },
      { consumer: {} },
      { consumerParentTaskCall: {} },
      { work: wrongWork },
    ]) {
      const rejected = prepareNativeHandoffReport(
        setup.harness.coordinator,
        reportRequest(setup, overrides),
      );
      expect(rejected.ok).toBe(false);
    }

    const clone = { ...setup.harness.coordinator } as NativeHandoffCoordinator;
    expect(prepareNativeHandoffReport(clone, reportRequest(setup)).ok).toBe(false);
    const foreign = await makeHarness();
    expect(prepareNativeHandoffReport(foreign.coordinator, reportRequest(setup)).ok).toBe(false);
  });

  test("refuses FAIL adoption and missing, conflicted or closed original adopt slots", async () => {
    const setup = await passReportSetup();

    await writeRelative(setup.harness.root, "pending.json", '{"status":"pending"}');
    const failedProducer = addProducer(setup.harness.fixture, selectorFor(2));
    const failedCapture = await exec(
      setup.harness,
      "call-capture-fail",
      captureParams(failedProducer.selector, "pending.json"),
    );
    const failedCaptureId = asString(details(failedCapture).captureId);
    const failedOfferId = asString(details(failedCapture).offerId);
    const failedConsumer = {};
    const failedParentCall = {};
    addConsumer(setup.harness.fixture, "failed-parent", failedConsumer, true);
    const { receiptId: failedReceiptId } = bindReadCheck(
      setup.harness.store,
      failedOfferId,
      failedConsumer,
      failedParentCall,
      setup.harness.fixture,
    );
    expect(setup.harness.store.lookupReceipt(failedReceiptId)?.outcome).toBe("fail");
    const failedAdopted = await exec(setup.harness, "call-adopt-fail", {
      action: "adopt",
      receiptId: failedReceiptId,
      captureId: failedCaptureId,
      consumerParentToolCallId: "failed-parent",
    });
    expect(details(failedAdopted).outcome).toBe("fail");
    expect(prepareNativeHandoffReport(setup.harness.coordinator, {
      adoptionId: asString(details(failedAdopted).adoptionId),
      work: copyWork(setup.harness.fixture.work),
      producer: failedProducer.ref,
      consumer: failedConsumer,
      consumerParentTaskCall: failedParentCall,
    }).ok).toBe(false);

    // A real core-issued PASS adoption with no entry operation slot cannot be
    // promoted through the coordinator helper.
    const coreWork = {};
    const coreProducer = {};
    const coreConsumer = {};
    const coreParentCall = {};
    const coreAdoptionCall = {};
    const coreReservation = setup.harness.store.reserveCapture({
      work: coreWork,
      producer: coreProducer,
      producerFacts: { callId: "core-producer", workId: "core-work", definitionVersion: "v1" },
      proposalCall: {},
      proposalFacts: { callId: "core-proposal", workId: "core-work", definitionVersion: "v1" },
      relativePath: "core-pass.json",
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    await writeRelative(setup.harness.root, "core-pass.json", '{"status":"done"}');
    const coreSnapshot = await captureWorkspaceText(
      setup.harness.root,
      "core-pass.json",
      nodeFileIo,
      1,
    );
    const coreCommit = setup.harness.store.commitCapture(coreReservation, coreSnapshot);
    setup.harness.store.bindOfferConsumer(coreCommit.offer, coreConsumer, coreParentCall, {
      callId: "core-consumer",
      workId: "core-work",
      definitionVersion: "v1",
    });
    const coreReadTool = {};
    const coreRead = setup.harness.store.prepareRead(
      coreCommit.offer,
      coreConsumer,
      coreParentCall,
      coreReadTool,
      "core-read",
    );
    expect(setup.harness.store.observeReadResult(
      coreRead.read,
      coreConsumer,
      coreParentCall,
      coreReadTool,
      "core-read",
      coreRead.digest,
      true,
    )).toBe(true);
    const coreReceipt = setup.harness.store.check(
      coreCommit.offer,
      coreConsumer,
      coreParentCall,
      {},
      "core-check",
    );
    const coreAdoption = setup.harness.store.adopt({
      receipt: coreReceipt,
      capture: coreCommit.capture,
      work: coreWork,
      consumer: coreConsumer,
      producer: coreProducer,
      file: {
        relativePath: coreSnapshot.file.relativePath,
        bytes: coreSnapshot.file.bytes,
        sha256: coreSnapshot.file.sha256,
      },
      adoptionCall: coreAdoptionCall,
      adoptionCallId: "core-adopt",
    });
    const missingSlot = prepareNativeHandoffReport(setup.harness.coordinator, {
      adoptionId: coreAdoption.adoptionId,
      work: copyWork(setup.harness.fixture.work),
      producer: coreProducer,
      consumer: coreConsumer,
      consumerParentTaskCall: coreParentCall,
    });
    expect(missingSlot.ok).toBe(false);
    expect(missingSlot.ok ? "" : missingSlot.reason).toContain("slot");

    const conflicted = await exec(setup.harness, "call-adopt", {
      action: "adopt",
      receiptId: setup.receiptId,
      captureId: setup.captureId,
      consumerParentToolCallId: "different-parent",
    });
    expect(details(conflicted).resultKind).toBe("conflict");
    expect(details(conflicted).stickyConflict).toBe(true);
    expect(prepareNativeHandoffReport(
      setup.harness.coordinator,
      reportRequest(setup),
    ).ok).toBe(false);

    setup.harness.coordinator.close();
    expect(prepareNativeHandoffReport(
      setup.harness.coordinator,
      reportRequest(setup),
    ).ok).toBe(false);
  });

  test("observes a real running adopt slot and succeeds only after settlement", async () => {
    const observation: { value: ReturnType<typeof prepareNativeHandoffReport> | null } = {
      value: null,
    };
    const setup = await passReportSetup({}, ({ harness, adoptionId, producer, consumer, parentCall }) => {
      observation.value = prepareNativeHandoffReport(harness.coordinator, {
        adoptionId,
        work: copyWork(harness.fixture.work),
        producer: producer.ref,
        consumer,
        consumerParentTaskCall: parentCall,
      });
    });
    if (observation.value === null) throw new Error("running adopt observation was not captured");
    const running = observation.value;
    expect(running.ok).toBe(false);
    expect(running.ok ? "" : running.reason).toContain("not settled");
    expect(prepareNativeHandoffReport(
      setup.harness.coordinator,
      reportRequest(setup),
    ).ok).toBe(true);
  });

  test("prepared revalidate follows the original slot, offer and store lifetime", async () => {
    const setup = await passReportSetup();
    const prepared = prepareNativeHandoffReport(setup.harness.coordinator, reportRequest(setup));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(`report preparation failed: ${prepared.reason}`);
    expect(prepared.prepared.revalidate()).toBeNull();
    expect(prepared.prepared.revalidate()).toBeNull();
    const offer = setup.harness.store.resolveOffer(setup.offerId);
    expect(offer).not.toBeNull();
    setup.harness.store.markBindingFailed(offer!, "late offer failure");
    expect(prepared.prepared.revalidate()).not.toBeNull();
    expect(prepared.prepared.revalidate()).not.toBeNull();

    const invalidated = await passReportSetup();
    const invalidatedPrepared = prepareNativeHandoffReport(
      invalidated.harness.coordinator,
      reportRequest(invalidated),
    );
    expect(invalidatedPrepared.ok).toBe(true);
    if (!invalidatedPrepared.ok) throw new Error("invalidated setup did not prepare");
    invalidated.harness.store.invalidate("test invalidation");
    expect(invalidatedPrepared.prepared.revalidate()).not.toBeNull();

    const disposed = await passReportSetup();
    const disposedPrepared = prepareNativeHandoffReport(
      disposed.harness.coordinator,
      reportRequest(disposed),
    );
    expect(disposedPrepared.ok).toBe(true);
    if (!disposedPrepared.ok) throw new Error("disposed setup did not prepare");
    disposed.harness.store.dispose();
    expect(disposedPrepared.prepared.revalidate()).not.toBeNull();
  });

  test("refuses revoked proxies and accessors without reading or throwing", async () => {
    const setup = await passReportSetup();
    const valid = reportRequest(setup);

    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    expect(() => prepareNativeHandoffReport(
      setup.harness.coordinator,
      revoked.proxy as never,
    )).not.toThrow();
    expect(prepareNativeHandoffReport(
      setup.harness.coordinator,
      revoked.proxy as never,
    ).ok).toBe(false);

    const revokedWork = Proxy.revocable({
      observationId: "observation-1",
      generation: 1,
      sessionId: "session-1",
      workspaceRoot: setup.harness.root,
    }, {});
    revokedWork.revoke();
    expect(() => prepareNativeHandoffReport(setup.harness.coordinator, reportRequest(setup, {
      work: revokedWork.proxy,
    }))).not.toThrow();
    expect(prepareNativeHandoffReport(setup.harness.coordinator, reportRequest(setup, {
      work: revokedWork.proxy,
    })).ok).toBe(false);

    let getterReads = 0;
    const accessor = {
      adoptionId: valid.adoptionId,
      work: valid.work,
      producer: valid.producer,
      consumer: valid.consumer,
    };
    Object.defineProperty(accessor, "consumerParentTaskCall", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("report request accessor must not run");
      },
    });
    expect(prepareNativeHandoffReport(
      setup.harness.coordinator,
      accessor as never,
    ).ok).toBe(false);
    expect(getterReads).toBe(0);
  });

  test("exports the same strict main descriptor parser for trusted report composition", () => {
    const inspect = readNativeHandoffRequestDescriptor({ action: "inspect" });
    expect(inspect.ok).toBe(true);
    if (!inspect.ok) throw new Error(`inspect descriptor refused: ${inspect.reason}`);
    expect(inspect.descriptor.action).toBe("inspect");
    expect(inspect.descriptor.params).toEqual({ action: "inspect" });
    expect(inspect.descriptor.digest).toMatch(/^[0-9a-f]{64}$/);

    const unknown = readNativeHandoffRequestDescriptor({ action: "inspect", extra: true });
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? "" : unknown.reason).toContain("unsupported");

    const revoked = Proxy.revocable({ action: "inspect" }, {});
    revoked.revoke();
    expect(() => readNativeHandoffRequestDescriptor(revoked.proxy)).not.toThrow();
    expect(readNativeHandoffRequestDescriptor(revoked.proxy).ok).toBe(false);
  });
});
