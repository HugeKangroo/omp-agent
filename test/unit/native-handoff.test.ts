import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_HANDOFF_CHAINS,
  MAX_HANDOFF_OFFERS,
  MAX_HANDOFF_READ_BYTES,
  NativeHandoffError,
  openNativeHandoffStore,
  type HandoffAdoptRequest,
  type HandoffBindingFacts,
  type HandoffCapture,
  type HandoffCaptureRequest,
  type HandoffCheckReceipt,
  type HandoffLiveFileFacts,
  type HandoffOffer,
  type HandoffReadPreparation,
  type NativeHandoffStore,
} from "../../src/native-handoff.ts";
import {
  captureWorkspaceText,
  nodeFileIo,
  type NativeWorkspaceTextSnapshot,
} from "../../src/native-work.ts";
import { matchesNativeTextCheckReceipt } from "../../src/native-snapshot-checker.ts";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-d3-a21-")));
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

async function readSnapshot(
  root: string,
  relativePath: string,
  observedAt = 1,
): Promise<NativeWorkspaceTextSnapshot> {
  return captureWorkspaceText(root, relativePath, nodeFileIo, observedAt);
}

function facts(callId: string, version = "definition-v1"): HandoffBindingFacts {
  return { callId, workId: "work-1", definitionVersion: version };
}

function live(snapshot: NativeWorkspaceTextSnapshot): HandoffLiveFileFacts {
  return {
    relativePath: snapshot.file.relativePath,
    bytes: snapshot.file.bytes,
    sha256: snapshot.file.sha256,
  };
}

function request(input: {
  work: object;
  producer: object;
  producerFacts: HandoffBindingFacts;
  proposalCall: object;
  proposalFacts: HandoffBindingFacts;
  relativePath?: string;
  conditions?: readonly unknown[];
}): HandoffCaptureRequest {
  return {
    work: input.work,
    producer: input.producer,
    producerFacts: input.producerFacts,
    proposalCall: input.proposalCall,
    proposalFacts: input.proposalFacts,
    relativePath: input.relativePath ?? "data.json",
    conditions: input.conditions ?? [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
  };
}

async function initial(
  store: NativeHandoffStore,
  root: string,
  input: {
    work: object;
    producer: object;
    producerFacts?: HandoffBindingFacts;
    proposalCall: object;
    proposalFacts?: HandoffBindingFacts;
    relativePath?: string;
    content?: string;
    observedAt?: number;
    conditions?: readonly unknown[];
  },
): Promise<{
  snapshot: NativeWorkspaceTextSnapshot;
  capture: HandoffCapture;
  offer: HandoffOffer;
}> {
  const reservation = store.reserveCapture(request({
    ...input,
    producerFacts: input.producerFacts ?? facts("producer"),
    proposalFacts: input.proposalFacts ?? facts("proposal"),
  }));
  const relativePath = input.relativePath ?? "data.json";
  await writeRelative(root, relativePath, input.content ?? '{"status":"pending"}');
  const snapshot = await readSnapshot(root, relativePath, input.observedAt ?? 1);
  const commit = store.commitCapture(reservation, snapshot);
  return { snapshot, capture: commit.capture, offer: commit.offer };
}

const defaultReadTools = new WeakMap<object, { toolCall: object; callId: string }>();
const readTools = new WeakMap<object, { toolCall: object; callId: string }>();
const defaultCheckTools = new WeakMap<object, { toolCall: object; callId: string }>();
const defaultAdoptTools = new WeakMap<object, { toolCall: object; callId: string }>();

function prepare(
  store: NativeHandoffStore,
  offer: HandoffOffer,
  consumer: object,
  parentTaskCall: object,
  toolCall?: object,
  callId = "read-call",
): HandoffReadPreparation {
  let actual = toolCall;
  if (actual === undefined) {
    const previous = defaultReadTools.get(offer);
    if (previous?.callId === callId) {
      actual = previous.toolCall;
    } else {
      actual = {};
      defaultReadTools.set(offer, { toolCall: actual, callId });
    }
  }
  const preparation = store.prepareRead(offer, consumer, parentTaskCall, actual, callId);
  readTools.set(preparation.read, { toolCall: actual, callId });
  return preparation;
}

function observed(
  store: NativeHandoffStore,
  preparation: HandoffReadPreparation,
  consumer: object,
  parentTaskCall: object,
  toolCall: object | undefined,
  callId: string,
  digest = preparation.digest,
  success = true,
): boolean {
  const actual = toolCall === undefined
    ? readTools.get(preparation.read)!.toolCall
    : toolCall;
  return store.observeReadResult(
    preparation.read,
    consumer,
    parentTaskCall,
    actual,
    callId,
    digest,
    success,
  );
}

function check(
  store: NativeHandoffStore,
  offer: HandoffOffer,
  consumer: object,
  parentTaskCall: object,
  toolCall?: object,
  callId = "check-call",
): HandoffCheckReceipt {
  let actual = toolCall;
  if (actual === undefined) {
    const previous = defaultCheckTools.get(offer);
    if (previous?.callId === callId) {
      actual = previous.toolCall;
    } else {
      actual = {};
      defaultCheckTools.set(offer, { toolCall: actual, callId });
    }
  }
  return store.check(offer, consumer, parentTaskCall, actual, callId);
}

type AdoptBody = Omit<HandoffAdoptRequest, "adoptionCall" | "adoptionCallId">;

function adopt(
  store: NativeHandoffStore,
  body: AdoptBody,
  adoptionCall?: object,
  adoptionCallId = "adopt-call",
): ReturnType<NativeHandoffStore["adopt"]> {
  let actual = adoptionCall;
  if (actual === undefined) {
    const previous = defaultAdoptTools.get(body.receipt);
    if (previous?.callId === adoptionCallId) {
      actual = previous.toolCall;
    } else {
      actual = {};
      defaultAdoptTools.set(body.receipt, { toolCall: actual, callId: adoptionCallId });
    }
  }
  return store.adopt({ ...body, adoptionCall: actual, adoptionCallId });
}

describe("native handoff store identity and limits", () => {
  test("returns one store per root and refuses replaced limits or a recreated disposed store", () => {
    const rootRef = {};
    const store = openNativeHandoffStore(rootRef, { maxCaptures: 2, maxOffers: 3 });
    expect(openNativeHandoffStore(rootRef)).toBe(store);
    expect(() => openNativeHandoffStore(rootRef, {})).toThrow(NativeHandoffError);
    expect(() => openNativeHandoffStore(rootRef, { maxCaptures: 1 })).toThrow(NativeHandoffError);

    const other = openNativeHandoffStore({}, { maxCaptures: 2 });
    expect(other).not.toBe(store);

    const empty = store.inspect();
    expect(empty.state).toBe("active");
    expect(empty.complete).toBe(true);
    expect(empty.usage.captures).toBe(0);
    expect(empty.usage.pendingBytes).toBe(0);
    expect(empty.limits.maxCaptures).toBe(2);
    expect(empty.limits.maxOffers).toBe(3);
    expect(empty.limits.maxChains).toBe(MAX_HANDOFF_CHAINS);
    expect(empty.limits.maxOffers).toBeLessThanOrEqual(MAX_HANDOFF_OFFERS);

    store.invalidate("between tests");
    expect(store.inspect().state).toBe("invalidated");
    store.dispose();
    expect(store.inspect().state).toBe("disposed");
    expect(openNativeHandoffStore(rootRef)).toBe(store);
  });

  test("does not replace a store created during limits normalization reentry", () => {
    const rootRef = {};
    let reentrant: NativeHandoffStore | undefined;
    const limits = new Proxy({ maxCaptures: 2 }, {
      getOwnPropertyDescriptor(target, property) {
        if (reentrant === undefined) reentrant = openNativeHandoffStore(rootRef);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => openNativeHandoffStore(rootRef, limits as never)).toThrow(NativeHandoffError);
    expect(reentrant).toBeDefined();
    expect(openNativeHandoffStore(rootRef)).toBe(reentrant!);
  });
});

describe("native handoff capture, read, check and repair chain", () => {
  test("V1 FAIL repairs to V2 with original provenance, distinct tool calls and ABA isolation", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer1 = {};
    const proposalCall1 = {};
    const child1 = {};
    const parentCall1 = {};
    const child2 = {};
    const parentCall2 = {};
    const child3 = {};
    const parentCall3 = {};
    const readCall1 = {};
    const checkCall1 = {};
    const adoptCall1 = {};
    const readCall2 = {};
    const checkCall2 = {};
    const adoptCall2 = {};
    const proposalFacts = facts("main-proposal", "definition-main");
    const producer1Facts = facts("producer-v1", "definition-child");
    const producer2Facts = facts("producer-v2", "definition-child-2");
    const v1 = '{"status":"pending"}\n';
    const v2 = '{"status":"done"}\n';

    const first = await initial(store, root, {
      work,
      producer: producer1,
      producerFacts: producer1Facts,
      proposalCall: proposalCall1,
      proposalFacts,
      content: v1,
      conditions: [
        { id: "done", kind: "json-equals", pointer: "/status", value: "done" },
        { id: "status", kind: "json-type", pointer: "/status", type: "string" },
      ],
    });
    expect(store.lookupCapture(first.capture.captureId)?.version).toBe(1);
    expect(store.lookupCapture(first.capture.captureId)?.proposal).toEqual(proposalFacts);
    expect(store.lookupCapture(first.capture.captureId)?.producer).toEqual(producer1Facts);
    store.bindOfferConsumer(first.offer, child1, parentCall1, facts("parent-1", "definition-child"));

    const read1 = prepare(store, first.offer, child1, parentCall1, readCall1, "read-1");
    expect(read1.view.text).toBe(v1);
    expect(read1.view.proposal).toEqual(proposalFacts);
    expect(read1.view.readCall).toEqual({ callId: "read-1" });
    expect(() => prepare(store, first.offer, child1, parentCall1, {}, "read-other")).toThrow(
      NativeHandoffError,
    );
    expect(observed(store, read1, child1, parentCall1, {}, "read-other", read1.digest, true)).toBe(false);
    expect(observed(store, read1, child1, parentCall1, readCall1, "read-1")).toBe(true);
    expect(observed(store, read1, child1, parentCall1, readCall1, "read-1")).toBe(true);

    const receipt1 = check(store, first.offer, child1, parentCall1, checkCall1, "check-1");
    expect(check(store, first.offer, child1, parentCall1, checkCall1, "check-1")).toBe(receipt1);
    expect(() => check(store, first.offer, child1, parentCall1, {}, "check-other")).toThrow(
      NativeHandoffError,
    );
    const receipt1View = store.lookupReceipt(receipt1.receiptId)!;
    expect(receipt1View.a1.outcome).toBe("fail");
    expect(receipt1View.parentBinding.callId).toBe("parent-1");
    expect(receipt1View.checkerCall.callId).toBe("check-1");
    expect(receipt1View.taskAccepted).toBe(false);
    expect(receipt1View.semanticAcceptance).toBe("not-evaluated");

    const adoption1 = adopt(store, {
      receipt: receipt1,
      capture: first.capture,
      work,
      consumer: child1,
      producer: producer1,
      file: live(first.snapshot),
    }, adoptCall1, "adopt-1");
    expect(adopt(store, {
      receipt: receipt1,
      capture: first.capture,
      work,
      consumer: child1,
      producer: producer1,
      file: live(first.snapshot),
    }, adoptCall1, "adopt-1")).toBe(adoption1);
    expect(() => adopt(store, {
      receipt: receipt1,
      capture: first.capture,
      work,
      consumer: child1,
      producer: producer1,
      file: live(first.snapshot),
    }, {}, "adopt-other")).toThrow(NativeHandoffError);
    expect(store.lookupAdoption(adoption1.adoptionId)?.outcome).toBe("fail");
    expect(store.lookupAdoption(adoption1.adoptionId)?.proposal).toEqual(proposalFacts);
    expect(store.lookupAdoption(adoption1.adoptionId)?.producer).toEqual(producer1Facts);
    expect(store.lookupAdoption(adoption1.adoptionId)?.adoptionCall.callId).toBe("adopt-1");
    expect(store.matchAdoption(adoption1, live(first.snapshot))).toBe(true);

    const repairOffer = store.offer(first.capture, adoption1);
    store.bindOfferConsumer(repairOffer, child2, parentCall2, facts("parent-2", "definition-child"));
    const repairRead = prepare(store, repairOffer, child2, parentCall2, readCall2, "read-2");
    expect(repairRead.view.feedback?.outcome).toBe("fail");
    expect(repairRead.view.feedback?.a1.outcome).toBe("fail");
    expect(repairRead.view.feedback?.proposal).toEqual(proposalFacts);
    expect(observed(store, repairRead, child2, parentCall2, readCall2, "read-2")).toBe(true);
    expect(store.lookupOffer(repairOffer.offerId)?.readUsable).toBe(true);

    const repairReservation = store.reserveRepairCapture({
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: producer2Facts,
      expectedHeadCaptureId: first.capture.captureId,
      expectedChainVersion: 1,
    });
    await writeRelative(root, "data.json", v2);
    const snapshot2 = await readSnapshot(root, "data.json", 2);
    const repaired = store.commitCapture(repairReservation, snapshot2);
    expect(store.lookupCapture(first.capture.captureId)?.version).toBe(1);
    expect(store.lookupCapture(repaired.capture.captureId)?.version).toBe(2);
    expect(store.lookupCapture(repaired.capture.captureId)?.proposal).toEqual(proposalFacts);
    expect(store.lookupCapture(repaired.capture.captureId)?.producer).toEqual(producer2Facts);

    expect(() => adopt(store, {
      receipt: receipt1,
      capture: first.capture,
      work,
      consumer: child1,
      producer: producer1,
      file: live(first.snapshot),
    }, {}, "adopt-old-1")).toThrow(NativeHandoffError);
    expect(() => adopt(store, {
      receipt: receipt1,
      capture: repaired.capture,
      work,
      consumer: child1,
      producer: child2,
      file: live(snapshot2),
    }, {}, "adopt-old-2")).toThrow(NativeHandoffError);

    store.bindOfferConsumer(repaired.offer, child3, parentCall3, facts("parent-3", "definition-child-2"));
    const read2 = prepare(store, repaired.offer, child3, parentCall3, undefined, "read-3");
    expect(read2.view.text).toBe(v2);
    expect(read2.view.plan).toBe(read1.view.plan);
    expect(read2.view.proposal).toEqual(proposalFacts);
    expect(observed(store, read2, child3, parentCall3, undefined, "read-3")).toBe(true);
    const receipt2 = check(store, repaired.offer, child3, parentCall3, checkCall2, "check-2");
    expect(store.lookupReceipt(receipt2.receiptId)?.a1.outcome).toBe("pass");
    const adoption2 = adopt(store, {
      receipt: receipt2,
      capture: repaired.capture,
      work,
      consumer: child3,
      producer: child2,
      file: live(snapshot2),
    }, adoptCall2, "adopt-2");
    expect(store.lookupAdoption(adoption2.adoptionId)?.outcome).toBe("pass");
    expect(store.lookupAdoption(adoption2.adoptionId)?.proposal).toEqual(proposalFacts);
    expect(store.lookupAdoption(adoption2.adoptionId)?.producer).toEqual(producer2Facts);
    expect(store.matchAdoption(adoption2, live(snapshot2))).toBe(true);
    expect(store.matchAdoption(adoption2, live(first.snapshot))).toBe(false);
    expect(matchesNativeTextCheckReceipt(receipt1View.a1, snapshot2, read1.view.plan)).toBe(false);

    await writeRelative(root, "data.json", v1);
    const abaReservation = store.reserveCapture(request({
      work,
      producer: producer1,
      producerFacts: producer1Facts,
      proposalCall: proposalCall1,
      proposalFacts,
      conditions: [
        { id: "done", kind: "json-equals", pointer: "/status", value: "done" },
        { id: "status", kind: "json-type", pointer: "/status", type: "string" },
      ],
    }));
    const abaSnapshot = await readSnapshot(root, "data.json", 3);
    const aba = store.commitCapture(abaReservation, abaSnapshot);
    expect(abaSnapshot.file.sha256).toBe(first.snapshot.file.sha256);
    expect(aba.capture.captureId).not.toBe(first.capture.captureId);
    expect(store.lookupCapture(aba.capture.captureId)?.chainId).not.toBe(
      store.lookupCapture(first.capture.captureId)?.chainId,
    );
    expect(() => adopt(store, {
      receipt: receipt1,
      capture: aba.capture,
      work,
      consumer: child1,
      producer: producer1,
      file: live(abaSnapshot),
    }, {}, "adopt-aba")).toThrow(NativeHandoffError);
    expect(matchesNativeTextCheckReceipt(receipt1View.a1, abaSnapshot, read1.view.plan)).toBe(false);
    expect(store.inspect().usage.captures).toBe(3);
    expect(store.inspect().usage.chains).toBe(2);
    expect(store.inspect().usage.adoptions).toBe(2);
  });
});

describe("native handoff independent offers and forged identity", () => {
  test("shares one capture across independent offers without cross-binding", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumerA = {};
    const consumerB = {};
    const consumerC = {};
    const callA = {};
    const callB = {};
    const callC = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"done"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    const offerA = store.offer(capture.capture);
    const offerB = store.offer(capture.capture);
    store.bindOfferConsumer(offerA, consumerA, callA, facts("a"));
    store.bindOfferConsumer(offerB, consumerB, callB, facts("b"));

    expect(() => prepare(store, offerA, consumerB, callB)).toThrow(NativeHandoffError);
    expect(() => check(store, offerA, consumerB, callB)).toThrow(NativeHandoffError);
    const readA = prepare(store, offerA, consumerA, callA);
    expect(readA.view.text).toBe('{"status":"done"}');
    expect(() => store.prepareRead(offerA, consumerA, callA, {}, "read-call")).toThrow(
      NativeHandoffError,
    );
    expect(observed(store, readA, consumerB, callB, undefined, "read-call")).toBe(false);
    expect(store.observeReadResult(readA.read, consumerA, callA, {}, "read-call", readA.digest, true))
      .toBe(false);
    expect(observed(store, readA, consumerA, callA, undefined, "read-call")).toBe(true);

    const receiptA = check(store, offerA, consumerA, callA);
    expect(check(store, offerA, consumerA, callA)).toBe(receiptA);
    expect(() => store.check(offerA, consumerA, callA, {}, "check-call")).toThrow(
      NativeHandoffError,
    );
    expect(() => check(store, offerA, consumerB, callB)).toThrow(NativeHandoffError);
    const receiptB = check(store, offerB, consumerB, callB);
    expect(receiptB.receiptId).not.toBe(receiptA.receiptId);
    expect(store.lookupOffer(offerA.offerId)?.checked).toBe(true);
    expect(store.lookupOffer(offerB.offerId)?.checked).toBe(true);

    const offerC = store.offer(capture.capture);
    store.bindOfferConsumer(offerC, consumerC, callC, facts("c"));
    store.markBindingFailed(offerC, "late failure");
    expect(store.lookupOffer(offerC.offerId)?.state).toBe("failed");
    expect(() => prepare(store, offerC, consumerC, callC)).toThrow(NativeHandoffError);
    expect(() => store.bindOfferConsumer(offerC, consumerC, callC, facts("c"))).toThrow(
      NativeHandoffError,
    );

    const clonedOffer = { ...offerA };
    expect(() => check(store, clonedOffer as HandoffOffer, consumerA, callA)).toThrow(
      NativeHandoffError,
    );
    const clonedCapture = { ...capture.capture };
    expect(() => store.offer(clonedCapture as HandoffCapture)).toThrow(NativeHandoffError);
    expect(store.resolveOffer(offerA.offerId)).toBe(offerA);
    expect(store.resolveCapture(capture.capture.captureId)).toBe(capture.capture);

    const otherStore = openNativeHandoffStore({});
    expect(otherStore.resolveOffer(offerA.offerId)).toBeNull();
    expect(otherStore.lookupCapture(capture.capture.captureId)).toBeNull();
    expect(() => otherStore.check(offerA, consumerA, callA, {}, "check-call")).toThrow(
      NativeHandoffError,
    );

    const adoption = adopt(store, {
      receipt: receiptA,
      capture: capture.capture,
      work,
      consumer: consumerA,
      producer,
      file: live(capture.snapshot),
    });
    expect(() => store.adopt({
      receipt: receiptA,
      capture: capture.capture,
      work,
      consumer: consumerA,
      producer,
      file: live(capture.snapshot),
      adoptionCall: {},
      adoptionCallId: "adopt-call",
    })).toThrow(NativeHandoffError);
    const adoptionView = store.lookupAdoption(adoption.adoptionId)!;
    const clonedView = JSON.parse(JSON.stringify(adoptionView)) as typeof adoptionView;
    expect(store.matchAdoption(clonedView as never, live(capture.snapshot))).toBe(false);
    expect(store.matchAdoption(adoption, live(capture.snapshot))).toBe(true);
  });

  test("new conditions create a new chain and old A1 receipt cannot replace it by identical bytes", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumer = {};
    const call = {};
    const v1 = '{"status":"pending"}';
    const first = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: v1,
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    const second = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: v1,
      conditions: [{ id: "string", kind: "json-type", pointer: "/status", type: "string" }],
    });
    expect(store.lookupCapture(first.capture.captureId)?.chainId).not.toBe(
      store.lookupCapture(second.capture.captureId)?.chainId,
    );
    expect(store.lookupCapture(first.capture.captureId)?.version).toBe(1);
    expect(store.lookupCapture(second.capture.captureId)?.version).toBe(1);
    expect(store.inspect().usage.chains).toBe(2);

    store.bindOfferConsumer(first.offer, consumer, call, facts("first"));
    const firstRead = prepare(store, first.offer, consumer, call);
    const firstReceipt = check(store, first.offer, consumer, call);
    const firstReceiptView = store.lookupReceipt(firstReceipt.receiptId)!;
    expect(firstReceiptView.a1.outcome).toBe("fail");
    expect(matchesNativeTextCheckReceipt(firstReceiptView.a1, first.snapshot, firstRead.view.plan)).toBe(true);
    expect(matchesNativeTextCheckReceipt(firstReceiptView.a1, second.snapshot, firstRead.view.plan)).toBe(false);
    expect(() => adopt(store, {
      receipt: firstReceipt,
      capture: second.capture,
      work,
      consumer,
      producer,
      file: live(second.snapshot),
    })).toThrow(NativeHandoffError);
    expect(store.lookupReceipt(firstReceipt.receiptId)?.a1.outcome).toBe("fail");
  });
});

describe("native handoff reservations, capacity and repair use", () => {
  test("overlapping reserves, abandon, double commit and failed commit release exactly once", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({}, {
      maxRetainedBytes: 600 * 1024,
      maxCaptures: 3,
      maxOffers: 3,
    });
    const work = {};
    const producer = {};
    const proposalCall = {};
    const baseRequest = request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
    });
    const r1 = store.reserveCapture(baseRequest);
    const r2 = store.reserveCapture(baseRequest);
    expect(store.inspect().usage.pendingReservations).toBe(2);
    expect(store.inspect().usage.pendingBytes).toBe(512 * 1024);
    expect(() => store.reserveCapture(baseRequest)).toThrow(NativeHandoffError);

    await writeRelative(root, "data.json", '{"status":"done"}');
    const snapshot = await readSnapshot(root, "data.json", 1);
    store.abandonCapture(r2);
    store.abandonCapture(r2);
    expect(store.inspect().usage.pendingReservations).toBe(1);
    expect(store.inspect().usage.pendingBytes).toBe(256 * 1024);
    expect(() => store.commitCapture(r2, snapshot)).toThrow(NativeHandoffError);

    const committed = store.commitCapture(r1, snapshot);
    expect(store.lookupCapture(committed.capture.captureId)).not.toBeNull();
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.retainedBytes).toBe(snapshot.file.bytes);
    expect(() => store.commitCapture(r1, snapshot)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.captures).toBe(1);

    const r3 = store.reserveCapture(baseRequest);
    const forged = { ...snapshot } as NativeWorkspaceTextSnapshot;
    expect(() => store.commitCapture(r3, forged)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.inspect().usage.pendingReservations).toBe(0);

    const r4 = store.reserveCapture(baseRequest);
    await writeRelative(root, "other.json", '{"status":"done"}');
    const other = await readSnapshot(root, "other.json", 2);
    expect(() => store.commitCapture(r4, other)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.offers).toBe(1);

    const r5 = store.reserveCapture(baseRequest);
    store.abandonCapture(r5);
    expect(store.inspect().usage.pendingReservations).toBe(0);
  });

  test("stale concurrent repairs compete, source head is guarded, and failures release", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const child1 = {};
    const child2 = {};
    const call1 = {};
    const call2 = {};
    const first = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(first.offer, child1, call1, facts("child-1"));
    const firstRead = prepare(store, first.offer, child1, call1);
    expect(observed(store, firstRead, child1, call1, undefined, "read-call")).toBe(true);
    const receipt = check(store, first.offer, child1, call1);
    const adoption = adopt(store, {
      receipt,
      capture: first.capture,
      work,
      consumer: child1,
      producer,
      file: live(first.snapshot),
    });
    const repairOffer = store.offer(first.capture, adoption);
    store.bindOfferConsumer(repairOffer, child2, call2, facts("child-2"));
    const repairRead = prepare(store, repairOffer, child2, call2);
    expect(observed(store, repairRead, child2, call2, undefined, "read-call")).toBe(true);

    const repairRequest = {
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: first.capture.captureId,
      expectedChainVersion: 1,
    };
    const r1 = store.reserveRepairCapture(repairRequest);
    const r2 = store.reserveRepairCapture(repairRequest);
    expect(store.inspect().usage.pendingReservations).toBe(2);

    await writeRelative(root, "data.json", '{"status":"done"}');
    const snapshot2 = await readSnapshot(root, "data.json", 2);
    const winner = store.commitCapture(r1, snapshot2);
    expect(store.lookupCapture(winner.capture.captureId)?.version).toBe(2);
    expect(store.inspect().usage.pendingReservations).toBe(1);

    await writeRelative(root, "data.json", '{"status":"done","late":true}');
    const snapshot3 = await readSnapshot(root, "data.json", 3);
    expect(() => store.commitCapture(r2, snapshot3)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.chains).toBe(1);
    expect(store.inspect().usage.captures).toBe(2);
    expect(store.inspect().usage.offers).toBe(3);
    expect(() => store.commitCapture(r2, snapshot3)).toThrow(NativeHandoffError);
    expect(() => store.reserveRepairCapture({
      ...repairRequest,
      expectedHeadCaptureId: winner.capture.captureId,
      expectedChainVersion: 2,
    })).toThrow(NativeHandoffError);
  });

  test("binding failure after a reserve releases repair commit without advancing the chain", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const child1 = {};
    const child2 = {};
    const call1 = {};
    const call2 = {};
    const first = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(first.offer, child1, call1, facts("child-1"));
    const firstRead = prepare(store, first.offer, child1, call1);
    expect(observed(store, firstRead, child1, call1, undefined, "read-call")).toBe(true);
    const receipt = check(store, first.offer, child1, call1);
    const adoption = adopt(store, {
      receipt,
      capture: first.capture,
      work,
      consumer: child1,
      producer,
      file: live(first.snapshot),
    });
    const repairOffer = store.offer(first.capture, adoption);
    store.bindOfferConsumer(repairOffer, child2, call2, facts("child-2"));
    const repairRead = prepare(store, repairOffer, child2, call2);
    expect(observed(store, repairRead, child2, call2, undefined, "read-call")).toBe(true);
    const reservation = store.reserveRepairCapture({
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: first.capture.captureId,
      expectedChainVersion: 1,
    });
    store.markBindingFailed(repairOffer, "changed after reserve");
    await writeRelative(root, "data.json", '{"status":"done"}');
    const snapshot2 = await readSnapshot(root, "data.json", 2);
    expect(() => store.commitCapture(reservation, snapshot2)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.chains).toBe(1);
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.lookupCapture(first.capture.captureId)?.version).toBe(1);
  });
});

describe("native handoff read observation and encoding", () => {
  test("read encoding includes escaping and feedback; digest must match exactly", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({}, { maxReadBytes: 4096 });
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumer = {};
    const call = {};
    const control = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "control.txt",
      content: "\n".repeat(3000),
      conditions: [{ id: "newline", kind: "text-includes", value: "\n" }],
    });
    store.bindOfferConsumer(control.offer, consumer, call, facts("control"));
    expect(() => prepare(store, control.offer, consumer, call)).toThrow(NativeHandoffError);
    expect(store.lookupOffer(control.offer.offerId)?.readDelivered).toBe(false);

    const small = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "small.txt",
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    store.bindOfferConsumer(small.offer, consumer, call, facts("small"));
    const read = prepare(store, small.offer, consumer, call);
    expect(read.view.text).toBe("ok");
    expect(observed(store, read, consumer, call, undefined, "read-call")).toBe(true);
    expect(observed(store, read, consumer, call, undefined, "read-call")).toBe(true);
    expect(observed(store, read, consumer, call, undefined, "read-call", "b".repeat(64))).toBe(false);
    expect(observed(store, read, consumer, call, undefined, "read-call", read.digest, false)).toBe(false);
    expect(observed(store, read, consumer, call, undefined, "read-call")).toBe(false);
    expect(store.lookupOffer(small.offer.offerId)?.readDelivered).toBe(true);
    expect(store.lookupOffer(small.offer.offerId)?.readUsable).toBe(false);

    const failed = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "feedback.txt",
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    const child1 = {};
    const child2 = {};
    const call1 = {};
    const call2 = {};
    store.bindOfferConsumer(failed.offer, child1, call1, facts("feedback-checker"));
    const failedRead = prepare(store, failed.offer, child1, call1);
    expect(observed(store, failedRead, child1, call1, undefined, "read-call")).toBe(true);
    const receipt = check(store, failed.offer, child1, call1);
    const adoption = adopt(store, {
      receipt,
      capture: failed.capture,
      work,
      consumer: child1,
      producer,
      file: live(failed.snapshot),
    });
    const repairOffer = store.offer(failed.capture, adoption);
    store.bindOfferConsumer(repairOffer, child2, call2, facts("feedback-repair"));
    const repairRead = prepare(store, repairOffer, child2, call2);
    expect(repairRead.view.feedback?.a1.outcome).toBe("fail");
    expect(new TextEncoder().encode(JSON.stringify(repairRead.view)).byteLength)
      .toBeLessThanOrEqual(4096);
    expect(repairRead.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(observed(store, repairRead, child2, call2, undefined, "read-call")).toBe(true);
    expect(MAX_HANDOFF_READ_BYTES).toBe(256 * 1024);
  });

  test("same-call read conflicts are sticky while wrong refs do not poison", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumer = {};
    const parentCall = {};
    const readCall = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    store.bindOfferConsumer(capture.offer, consumer, parentCall, facts("consumer"));
    const read = prepare(store, capture.offer, consumer, parentCall, readCall, "read-1");
    expect(observed(store, read, consumer, parentCall, {}, "wrong-call", read.digest, true)).toBe(false);
    expect(observed(store, read, consumer, parentCall, readCall, "read-1")).toBe(true);
    expect(store.lookupOffer(capture.offer.offerId)?.readUsable).toBe(true);
    expect(observed(store, read, consumer, parentCall, readCall, "read-1", "c".repeat(64))).toBe(false);
    expect(store.lookupOffer(capture.offer.offerId)?.readDelivered).toBe(true);
    expect(store.lookupOffer(capture.offer.offerId)?.readState).toBe("failed");
    expect(store.lookupOffer(capture.offer.offerId)?.readUsable).toBe(false);
    expect(observed(store, read, consumer, parentCall, readCall, "read-1")).toBe(false);

    const secondOffer = store.offer(capture.capture);
    store.bindOfferConsumer(secondOffer, consumer, parentCall, facts("consumer-2"));
    const secondRead = prepare(store, secondOffer, consumer, parentCall, undefined, "read-2");
    expect(observed(store, secondRead, consumer, parentCall, undefined, "read-2", secondRead.digest, false)).toBe(false);
    expect(observed(store, secondRead, consumer, parentCall, undefined, "read-2")).toBe(false);
    expect(store.lookupOffer(secondOffer.offerId)?.readState).toBe("failed");
    expect(store.lookupOffer(secondOffer.offerId)?.readDelivered).toBe(false);
    expect(store.lookupOffer(secondOffer.offerId)?.readUsable).toBe(false);
  });
});

describe("native handoff metadata, inspection and caps", () => {
  test("read metadata charges the full wrapper minus text and shared plan", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumer = {};
    const call = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "héllo-漢字.txt",
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    store.bindOfferConsumer(capture.offer, consumer, call, facts("metadata"));
    const before = store.inspect().usage.metadataBytes;
    const read = prepare(store, capture.offer, consumer, call);
    const after = store.inspect().usage.metadataBytes;
    const expected = new TextEncoder().encode(JSON.stringify({
      ...read.view,
      text: "",
      plan: {
        checkerId: read.view.plan.checkerId,
        checkerVersion: read.view.plan.checkerVersion,
        schemaVersion: read.view.plan.schemaVersion,
        digest: read.view.plan.digest,
      },
    })).byteLength + 512;
    expect(after - before).toBe(expected);
    expect(after).toBeLessThanOrEqual(store.inspect().limits.maxMetadataBytes);
  });

  test("multibyte binding metadata is exact, sticky, and never exceeds the cap", async () => {
    const root = await workspace();
    const cap = 19 * 1024;
    const store = openNativeHandoffStore({}, { maxMetadataBytes: cap });
    const work = {};
    const producer = {};
    const proposalCall = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    let lastOffer: HandoffOffer = capture.offer;
    for (let index = 0; index < MAX_HANDOFF_OFFERS; index++) {
      try {
        lastOffer = store.offer(capture.capture);
      } catch {
        break;
      }
    }
    const hugeFacts: HandoffBindingFacts = {
      callId: "漢".repeat(256),
      workId: "漢".repeat(256),
      definitionVersion: "漢".repeat(256),
    };
    expect(() => store.bindOfferConsumer(lastOffer, {}, {}, hugeFacts)).toThrow(NativeHandoffError);
    expect(store.lookupOffer(lastOffer.offerId)?.state).toBe("failed");
    expect(store.lookupOffer(lastOffer.offerId)?.failureReason).toBe("binding-metadata");
    expect(store.inspect().usage.metadataBytes).toBeLessThanOrEqual(cap);
  });

  test("count and inspect caps report exact totals with explicit omission and no text", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({}, {
      maxCaptures: 2,
      maxOffers: 4,
      maxInspectBytes: 2048,
    });
    const work = {};
    const producer = {};
    const proposalCall = {};
    const marker = "INSPECT-TEXT-MUST-NOT-APPEAR";
    const first = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "a.txt",
      content: marker,
      conditions: [{ id: "marker", kind: "text-includes", value: marker }],
    });
    const second = await initial(store, root, {
      work,
      producer,
      proposalCall,
      relativePath: "b.txt",
      content: marker,
      conditions: [{ id: "marker", kind: "text-includes", value: marker }],
    });
    store.offer(first.capture);
    store.offer(second.capture);
    expect(store.inspect().usage.offers).toBe(4);
    expect(() => store.offer(first.capture)).toThrow(NativeHandoffError);
    expect(() => store.reserveCapture(request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
      relativePath: "c.txt",
    }))).toThrow(NativeHandoffError);

    const inspect = store.inspect();
    expect(inspect.usage.captures).toBe(2);
    expect(inspect.usage.offers).toBe(4);
    expect(inspect.usage.chains).toBe(2);
    expect(inspect.captures.total).toBe(2);
    expect(inspect.offers.total).toBe(4);
    expect(inspect.complete).toBe(false);
    const omitted = inspect.chains.omitted + inspect.captures.omitted
      + inspect.offers.omitted + inspect.receipts.omitted + inspect.adoptions.omitted;
    expect(omitted).toBeGreaterThan(0);
    expect(inspect.chains.items.length + inspect.chains.omitted).toBe(inspect.chains.total);
    expect(inspect.captures.items.length + inspect.captures.omitted).toBe(inspect.captures.total);
    expect(inspect.offers.items.length + inspect.offers.omitted).toBe(inspect.offers.total);
    expect(JSON.stringify(inspect)).not.toContain(marker);

    const metadataStore = openNativeHandoffStore({}, { maxMetadataBytes: 1024 });
    expect(() => metadataStore.reserveCapture(request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
    }))).toThrow(NativeHandoffError);
    const metadataInspect = metadataStore.inspect();
    expect(metadataInspect.usage.metadataBytes).toBeLessThanOrEqual(1024);
    expect(metadataInspect.usage.pendingReservations).toBe(0);
    expect(metadataInspect.usage.captures).toBe(0);
  });

  test("receipt and adoption caps reject without overwriting historical records", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({}, { maxReceipts: 2, maxAdoptions: 1 });
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumerA = {};
    const consumerB = {};
    const consumerC = {};
    const callA = {};
    const callB = {};
    const callC = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"done"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    const offerA = capture.offer;
    const offerB = store.offer(capture.capture);
    const offerC = store.offer(capture.capture);
    store.bindOfferConsumer(offerA, consumerA, callA, facts("a"));
    store.bindOfferConsumer(offerB, consumerB, callB, facts("b"));
    store.bindOfferConsumer(offerC, consumerC, callC, facts("c"));
    const receiptA = check(store, offerA, consumerA, callA);
    const receiptB = check(store, offerB, consumerB, callB);
    expect(() => check(store, offerC, consumerC, callC)).toThrow(NativeHandoffError);
    expect(store.lookupOffer(offerC.offerId)?.checked).toBe(false);

    const adoption = adopt(store, {
      receipt: receiptA,
      capture: capture.capture,
      work,
      consumer: consumerA,
      producer,
      file: live(capture.snapshot),
    });
    expect(store.lookupAdoption(adoption.adoptionId)?.outcome).toBe("pass");
    expect(() => adopt(store, {
      receipt: receiptB,
      capture: capture.capture,
      work,
      consumer: consumerB,
      producer,
      file: live(capture.snapshot),
    })).toThrow(NativeHandoffError);
    expect(store.inspect().usage.receipts).toBe(2);
    expect(store.inspect().usage.adoptions).toBe(1);
  });
});

describe("native handoff invalidation, monotonic failure and strict boundaries", () => {
  test("invalidation blocks mutable operations while historical views and matches remain", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const reservation = store.reserveCapture(request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
    }));
    await writeRelative(root, "data.json", '{"status":"pending"}');
    const snapshot = await readSnapshot(root, "data.json", 1);
    store.invalidate("between reserve and commit");
    expect(() => store.commitCapture(reservation, snapshot)).toThrow(NativeHandoffError);
    expect(store.inspect().state).toBe("invalidated");
    expect(store.inspect().usage.captures).toBe(0);
    expect(store.inspect().usage.pendingReservations).toBe(0);

    const historicalStore = openNativeHandoffStore({});
    const historical = await initial(historicalStore, root, {
      work,
      producer,
      proposalCall,
      relativePath: "history.json",
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    const child = {};
    const childCall = {};
    historicalStore.bindOfferConsumer(historical.offer, child, childCall, facts("child"));
    const read = prepare(historicalStore, historical.offer, child, childCall);
    expect(observed(historicalStore, read, child, childCall, undefined, "read-call")).toBe(true);
    const receipt = check(historicalStore, historical.offer, child, childCall);
    const adoption = adopt(historicalStore, {
      receipt,
      capture: historical.capture,
      work,
      consumer: child,
      producer,
      file: live(historical.snapshot),
    });
    historicalStore.invalidate("root observed invalidation");
    expect(historicalStore.lookupCapture(historical.capture.captureId)).not.toBeNull();
    expect(historicalStore.lookupReceipt(receipt.receiptId)?.a1.outcome).toBe("fail");
    expect(historicalStore.lookupAdoption(adoption.adoptionId)?.outcome).toBe("fail");
    expect(historicalStore.matchAdoption(adoption, live(historical.snapshot))).toBe(true);
    expect(() => historicalStore.offer(historical.capture, adoption)).toThrow(NativeHandoffError);
    expect(() => historicalStore.adopt({
      receipt,
      capture: historical.capture,
      work,
      consumer: child,
      producer,
      file: live(historical.snapshot),
      adoptionCall: {},
      adoptionCallId: "late-adopt",
    })).toThrow(NativeHandoffError);
    historicalStore.dispose();
    expect(historicalStore.inspect().state).toBe("disposed");
    expect(historicalStore.lookupCapture(historical.capture.captureId)).not.toBeNull();
    expect(historicalStore.matchAdoption(adoption, live(historical.snapshot))).toBe(true);
  });

  test("markBindingFailed after receipt is historical, blocks new adoption and delivered repair use", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const child = {};
    const parentCall = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(capture.offer, child, parentCall, facts("child"));
    const read = prepare(store, capture.offer, child, parentCall);
    expect(observed(store, read, child, parentCall, undefined, "read-call")).toBe(true);
    const receipt = check(store, capture.offer, child, parentCall);
    store.markBindingFailed(capture.offer, "late failure");
    expect(store.lookupReceipt(receipt.receiptId)?.a1.outcome).toBe("fail");
    expect(store.lookupOffer(capture.offer.offerId)?.state).toBe("failed");
    expect(store.lookupOffer(capture.offer.offerId)?.readDelivered).toBe(true);
    expect(store.lookupOffer(capture.offer.offerId)?.readUsable).toBe(false);
    expect(observed(store, read, child, parentCall, undefined, "read-call")).toBe(false);
    expect(() => adopt(store, {
      receipt,
      capture: capture.capture,
      work,
      consumer: child,
      producer,
      file: live(capture.snapshot),
    })).toThrow(NativeHandoffError);
    expect(store.inspect().usage.adoptions).toBe(0);
  });

  test("repair commit rechecks a conflict observed after reserve and releases", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const child1 = {};
    const child2 = {};
    const call1 = {};
    const call2 = {};
    const first = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(first.offer, child1, call1, facts("child-1"));
    const firstRead = prepare(store, first.offer, child1, call1);
    expect(observed(store, firstRead, child1, call1, undefined, "read-call")).toBe(true);
    const receipt = check(store, first.offer, child1, call1);
    const adoption = adopt(store, {
      receipt,
      capture: first.capture,
      work,
      consumer: child1,
      producer,
      file: live(first.snapshot),
    });
    const repairOffer = store.offer(first.capture, adoption);
    store.bindOfferConsumer(repairOffer, child2, call2, facts("child-2"));
    const repairRead = prepare(store, repairOffer, child2, call2);
    expect(observed(store, repairRead, child2, call2, undefined, "read-call")).toBe(true);
    const reservation = store.reserveRepairCapture({
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: first.capture.captureId,
      expectedChainVersion: 1,
    });
    expect(observed(store, repairRead, child2, call2, undefined, "read-call", "d".repeat(64))).toBe(false);
    expect(store.lookupOffer(repairOffer.offerId)?.readUsable).toBe(false);
    await writeRelative(root, "data.json", '{"status":"done"}');
    const snapshot2 = await readSnapshot(root, "data.json", 2);
    expect(() => store.commitCapture(reservation, snapshot2)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.lookupCapture(first.capture.captureId)?.version).toBe(1);
  });

  test("rejects caller source, accessors, unsafe paths and malformed reasons without half-state", async () => {
    const store = openNativeHandoffStore({});
    const root = await workspace();
    const work = {};
    const producer = {};
    const proposalCall = {};
    const base = request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
    });

    expect(() => store.reserveCapture({ ...base, source: "user" } as never)).toThrow(NativeHandoffError);
    expect(store.inspect().pending.reservations).toBe(0);

    let accessorCalls = 0;
    const accessorConditions = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessorConditions, "conditions", {
      enumerable: true,
      get() {
        accessorCalls++;
        return [];
      },
    });
    expect(() => store.reserveCapture(accessorConditions as never)).toThrow(NativeHandoffError);
    expect(accessorCalls).toBe(0);

    const accessorFacts: Record<string, unknown> = {
      workId: "work-1",
      definitionVersion: "definition-v1",
    };
    Object.defineProperty(accessorFacts, "callId", {
      enumerable: true,
      get() {
        accessorCalls++;
        return "call";
      },
    });
    expect(() => store.reserveCapture({ ...base, producerFacts: accessorFacts } as never)).toThrow(
      NativeHandoffError,
    );
    expect(accessorCalls).toBe(0);

    expect(() => store.reserveCapture(request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
      relativePath: "../escape.txt",
    }))).toThrow(NativeHandoffError);
    expect(() => store.reserveCapture(request({
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall,
      proposalFacts: facts("proposal"),
      conditions: [],
    }))).toThrow();
    expect(store.inspect().pending.reservations).toBe(0);

    expect(() => store.reserveRepairCapture({
      fromOffer: {},
      work,
      producer,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: "missing",
      expectedChainVersion: 1,
      conditions: [{ id: "x", kind: "json-valid" }],
    } as never)).toThrow(NativeHandoffError);
    expect(store.inspect().pending.reservations).toBe(0);

    expect(() => store.invalidate(123 as never)).toThrow(NativeHandoffError);
    expect(store.inspect().state).toBe("active");

    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    const freshOffer = store.offer(capture.capture);
    expect(() => store.markBindingFailed(freshOffer, 123 as never)).toThrow(NativeHandoffError);
    expect(store.lookupOffer(freshOffer.offerId)?.state).toBe("open");

    expect(store.resolveCapture("missing")).toBeNull();
    expect(store.resolveOffer("missing")).toBeNull();
    expect(store.resolveCheckReceipt("missing")).toBeNull();
    expect(store.resolveAdoption("missing")).toBeNull();
    expect(store.lookupCapture("missing")).toBeNull();
    expect(store.lookupOffer("missing")).toBeNull();
    expect(store.lookupReceipt("missing")).toBeNull();
    expect(store.lookupAdoption("missing")).toBeNull();
    expect(() => store.offer("missing" as never)).toThrow(NativeHandoffError);
    expect(() => store.abandonCapture("missing" as never)).toThrow(NativeHandoffError);
  });

  test("active recheck after external fact normalization prevents half-binding or half-adoption", async () => {
    const root = await workspace();
    const bindStore = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const bindCapture = await initial(bindStore, root, {
      work,
      producer,
      proposalCall,
      relativePath: "bind.txt",
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    const proxyFacts = new Proxy({
      callId: "call",
      workId: "work-1",
      definitionVersion: "definition-v1",
    }, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "callId") bindStore.invalidate("proxy facts");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => bindStore.bindOfferConsumer(bindCapture.offer, {}, {}, proxyFacts)).toThrow(
      NativeHandoffError,
    );
    expect(bindStore.inspect().state).toBe("invalidated");
    expect(bindStore.lookupOffer(bindCapture.offer.offerId)?.state).toBe("open");

    const adoptStore = openNativeHandoffStore({});
    const adoptCapture = await initial(adoptStore, root, {
      work,
      producer,
      proposalCall,
      relativePath: "adopt.txt",
      content: "ok",
      conditions: [{ id: "ok", kind: "text-includes", value: "ok" }],
    });
    const child = {};
    const childCall = {};
    adoptStore.bindOfferConsumer(adoptCapture.offer, child, childCall, facts("child"));
    const receipt = check(adoptStore, adoptCapture.offer, child, childCall);
    const liveFile = {
      relativePath: adoptCapture.snapshot.file.relativePath,
      bytes: adoptCapture.snapshot.file.bytes,
      sha256: adoptCapture.snapshot.file.sha256,
    };
    const proxyFile = new Proxy(liveFile, {
      getOwnPropertyDescriptor(target, property) {
        if (property === "relativePath") adoptStore.invalidate("proxy live file");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => adoptStore.adopt({
      receipt,
      capture: adoptCapture.capture,
      work,
      consumer: child,
      producer,
      file: proxyFile as HandoffLiveFileFacts,
      adoptionCall: {},
      adoptionCallId: "adopt-proxy",
    })).toThrow(NativeHandoffError);
    expect(adoptStore.inspect().state).toBe("invalidated");
    expect(adoptStore.inspect().usage.adoptions).toBe(0);
  });
});

describe("native handoff repair feedback and direct tool-call identity", () => {
  test("direct tool calls keep opaque refs distinct even with the same callId", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const consumer = {};
    const parentCall = {};
    const readCall = {};
    const checkCall = {};
    const adoptionCall = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"done"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(capture.offer, consumer, parentCall, facts("direct"));

    const read = store.prepareRead(capture.offer, consumer, parentCall, readCall, "read-1");
    expect(() => store.prepareRead(capture.offer, consumer, parentCall, {}, "read-1")).toThrow(
      NativeHandoffError,
    );
    expect(store.prepareRead(capture.offer, consumer, parentCall, readCall, "read-1").digest)
      .toBe(read.digest);
    expect(store.observeReadResult(read.read, consumer, parentCall, {}, "read-1", read.digest, true))
      .toBe(false);
    expect(store.lookupOffer(capture.offer.offerId)?.readState).toBe("prepared");
    expect(store.lookupOffer(capture.offer.offerId)?.readDelivered).toBe(false);
    expect(store.observeReadResult(
      read.read,
      consumer,
      parentCall,
      readCall,
      "read-1",
      read.digest,
      true,
    )).toBe(true);
    expect(store.lookupOffer(capture.offer.offerId)?.readUsable).toBe(true);

    const receipt = store.check(capture.offer, consumer, parentCall, checkCall, "check-1");
    expect(() => store.check(capture.offer, consumer, parentCall, {}, "check-1")).toThrow(
      NativeHandoffError,
    );
    expect(store.check(capture.offer, consumer, parentCall, checkCall, "check-1")).toBe(receipt);

    const body = {
      receipt,
      capture: capture.capture,
      work,
      consumer,
      producer,
      file: live(capture.snapshot),
    };
    const adoption = store.adopt({ ...body, adoptionCall, adoptionCallId: "adopt-1" });
    expect(store.adopt({ ...body, adoptionCall, adoptionCallId: "adopt-1" })).toBe(adoption);
    expect(() => store.adopt({ ...body, adoptionCall: {}, adoptionCallId: "adopt-1" })).toThrow(
      NativeHandoffError,
    );
    expect(() => store.adopt({ ...body, adoptionCall, adoptionCallId: "adopt-other" })).toThrow(
      NativeHandoffError,
    );

    const consumer2 = {};
    const parentCall2 = {};
    const secondOffer = store.offer(capture.capture);
    store.bindOfferConsumer(secondOffer, consumer2, parentCall2, facts("direct-2"));
    const secondReceipt = store.check(secondOffer, consumer2, parentCall2, {}, "check-2");
    expect(() => store.adopt({
      receipt: secondReceipt,
      capture: capture.capture,
      work,
      consumer: consumer2,
      producer,
      file: live(capture.snapshot),
      adoptionCall,
      adoptionCallId: "adopt-1",
    })).toThrow(NativeHandoffError);
    expect(store.inspect().usage.adoptions).toBe(1);

    expect(store.adopt({
      receipt: secondReceipt,
      capture: capture.capture,
      work,
      consumer: consumer2,
      producer,
      file: live(capture.snapshot),
      adoptionCall: {},
      adoptionCallId: "adopt-2",
    })).not.toBe(adoption);
    expect(store.inspect().usage.adoptions).toBe(2);
  });

  test("a failed original checker offer keeps history but cannot seed repair", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const proposalCall = {};
    const child1 = {};
    const parentCall1 = {};
    const child2 = {};
    const parentCall2 = {};
    const capture = await initial(store, root, {
      work,
      producer,
      proposalCall,
      content: '{"status":"pending"}',
      conditions: [{ id: "done", kind: "json-equals", pointer: "/status", value: "done" }],
    });
    store.bindOfferConsumer(capture.offer, child1, parentCall1, facts("checker"));
    const read = prepare(store, capture.offer, child1, parentCall1);
    expect(observed(store, read, child1, parentCall1, undefined, "read-call")).toBe(true);
    const receipt = check(store, capture.offer, child1, parentCall1);
    const adoption = adopt(store, {
      receipt,
      capture: capture.capture,
      work,
      consumer: child1,
      producer,
      file: live(capture.snapshot),
    });
    expect(store.lookupAdoption(adoption.adoptionId)?.outcome).toBe("fail");

    const repairOffer = store.offer(capture.capture, adoption);
    store.bindOfferConsumer(repairOffer, child2, parentCall2, facts("repair"));
    const repairRead = prepare(store, repairOffer, child2, parentCall2);
    expect(observed(store, repairRead, child2, parentCall2, undefined, "read-call")).toBe(true);
    const reservation = store.reserveRepairCapture({
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: capture.capture.captureId,
      expectedChainVersion: 1,
    });

    store.markBindingFailed(capture.offer, "checker failed after adoption");
    expect(store.lookupOffer(capture.offer.offerId)?.state).toBe("failed");
    expect(store.lookupOffer(capture.offer.offerId)?.readDelivered).toBe(true);
    expect(store.lookupOffer(capture.offer.offerId)?.readUsable).toBe(false);
    expect(store.lookupReceipt(receipt.receiptId)?.a1.outcome).toBe("fail");
    expect(store.lookupAdoption(adoption.adoptionId)?.outcome).toBe("fail");
    expect(store.matchAdoption(adoption, live(capture.snapshot))).toBe(true);

    expect(() => store.offer(capture.capture, adoption)).toThrow(NativeHandoffError);
    expect(() => store.reserveRepairCapture({
      fromOffer: repairOffer,
      work,
      producer: child2,
      producerFacts: facts("repair"),
      expectedHeadCaptureId: capture.capture.captureId,
      expectedChainVersion: 1,
    })).toThrow(NativeHandoffError);
    expect(store.inspect().usage.pendingReservations).toBe(1);

    await writeRelative(root, "data.json", '{"status":"done"}');
    const snapshot2 = await readSnapshot(root, "data.json", 2);
    expect(() => store.commitCapture(reservation, snapshot2)).toThrow(NativeHandoffError);
    expect(store.inspect().usage.pendingReservations).toBe(0);
    expect(store.inspect().usage.chains).toBe(1);
    expect(store.inspect().usage.captures).toBe(1);
    expect(store.lookupCapture(capture.capture.captureId)?.version).toBe(1);
    expect(store.lookupOffer(repairOffer.offerId)?.readDelivered).toBe(true);
    expect(store.lookupAdoption(adoption.adoptionId)?.outcome).toBe("fail");
  });
});

describe("historical capture binding matcher", () => {
  test("matches only the exact issued capture, work and producer references", async () => {
    const root = await workspace();
    const store = openNativeHandoffStore({});
    const work = {};
    const producer = {};
    const capture = await initial(store, root, {
      work,
      producer,
      producerFacts: facts("producer"),
      proposalCall: {},
      proposalFacts: facts("proposal"),
    });

    expect(store.matchesCaptureBinding(capture.capture, work, producer)).toBe(true);
    expect(store.matchesCaptureBinding({ ...capture.capture }, work, producer)).toBe(false);
    expect(store.matchesCaptureBinding(capture.capture, {}, producer)).toBe(false);
    expect(store.matchesCaptureBinding(capture.capture, work, {})).toBe(false);
    expect(store.matchesCaptureBinding(null as never, work, producer)).toBe(false);

    const otherStore = openNativeHandoffStore({});
    expect(otherStore.matchesCaptureBinding(capture.capture, work, producer)).toBe(false);

    const accessed: string[] = [];
    const hostile = new Proxy({}, {
      get(_target, key) {
        accessed.push(String(key));
        throw new Error("capture handle getter must not run");
      },
    });
    expect(store.matchesCaptureBinding(hostile as never, work, producer)).toBe(false);
    expect(accessed).toEqual([]);

    store.invalidate("historical test");
    expect(store.matchesCaptureBinding(capture.capture, work, producer)).toBe(true);
  });
});
