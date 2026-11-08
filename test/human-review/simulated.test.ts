import { describe, expect, mock, test } from "bun:test";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  REVIEW_DEADLINE_MS,
  type HumanReviewTransportInput,
  type HumanReviewTransportResult,
} from "../../src/human-review-types.ts";

/**
 * Simulated transport only. This file runs in its own process and replaces the
 * fixed UI module before product imports; it proves the host mechanism, not a
 * real user review. C1 production remains unavailable and C2/C3 are separate.
 */

type Script = (
  input: HumanReviewTransportInput,
) => Promise<HumanReviewTransportResult> | HumanReviewTransportResult;

const scripts: Script[] = [];
let lastInput: HumanReviewTransportInput | null = null;
let calls = 0;

const uiPath = path.resolve(import.meta.dir, "../../src/human-review-ui.ts");
mock.module(uiPath, () => ({
  presentLocalHumanReview: async (input: HumanReviewTransportInput): Promise<HumanReviewTransportResult> => {
    calls += 1;
    lastInput = input;
    const script = scripts.shift();
    if (script === undefined) {
      return { kind: "unavailable", reason: "no simulated transport script remains" };
    }
    return script(input);
  },
}));

const { createHumanFixture } = await import("../harness/human-review-fixture.ts");
const { partialSpec } = await import("../harness/human-review-fixture.ts");
const { AcceptanceService } = await import("../../src/acceptance-service.ts");
const { createHash } = await import("node:crypto");

function approve(input: HumanReviewTransportInput): HumanReviewTransportResult {
  return { kind: "approve", capability: input.capability };
}

function clearTransport(): void {
  scripts.length = 0;
  lastInput = null;
  calls = 0;
}

function recordOf(root: string): { path: string; value: Record<string, any> } {
  const entries = readdirSync(root).filter((name) => name.startsWith("record-") && name.endsWith(".json"));
  expect(entries.length).toBe(1);
  const recordPath = path.join(root, entries[0]!);
  return { path: recordPath, value: JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, any> };
}

describe("G2-B2-C1 simulated human/hybrid transport", () => {
  test("no-contract human approval installs one exact v2 record through the same owner", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      scripts.push(approve);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("committed");
      expect(result.operation.outcome).toBe("committed");
      expect(result.operation.taskAccepted).toBe(true);
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
      const reference = f.owner.snapshot().currentTask!.acceptance!;
      expect(result.operation.acceptance).toEqual(reference);

      const record = recordOf(f.acceptanceRoot);
      expect(`sha256:${createHash("sha256").update(readFileSync(record.path)).digest("hex")}`).toBe(reference.recordDigest);
      expect(record.value.schemaVersion).toBe(2);
      expect(record.value.version).toBe("acceptance-record-v2");
      expect(record.value.policy).toEqual({ source: "human-review", version: "human-review-policy-v1" });
      expect(record.value.contract).toBeNull();
      expect(record.value.receipt).toEqual({ receipt: null, digest: null, snapshotId: null });
      expect(record.value.humanReview.decision).toBe("approve");
      expect(record.value.humanReview.interactionSource).toBe("local-main-tui-component");
      expect(record.value.humanReview.display.complete).toBe(true);
      expect(record.value.humanReview.display.contentTruncated).toBe(false);
      expect(record.value.humanReview.display.fileCount).toBe(1);
      expect(record.value.humanReview.assessment.reviewedRequirementRevisions).toEqual([1]);
      expect(record.value.humanReview.assessment.automaticEvidenceState).toBe("none");
      expect(record.value.evidence.humanReviewReceiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(record.value.humanReview.binding.deliveryId).toBe(preview.deliveryId);
      expect(record.value.humanReview.binding.artifacts).toHaveLength(1);
      expect(JSON.stringify(record.value)).not.toContain("token");

      const callsBeforeReplay = calls;
      const replay = await f.request(preview.deliveryId);
      expect(replay.review.state).toBe("committed");
      expect(replay.operation.outcome).toBe("committed");
      expect(replay.operation.idempotent).toBe(true);
      expect(calls).toBe(callsBeforeReplay);
      expect(readdirSync(f.acceptanceRoot).filter((name) => name.startsWith("record-"))).toHaveLength(1);

      const inspected = await f.inspect(preview.deliveryId);
      expect(inspected.acceptance).toEqual(reference);
      expect(inspected.record.state).toBe("intact");
      expect(inspected.current.state).toBe("visible");
    } finally {
      await f.cleanup();
    }
  });

  test("partial automatic evidence produces hybrid v2 without rewriting the receipt", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      f.bind(partialSpec());
      const run = await f.run();
      const receiptId = await f.verify(run.runId, run.artifactIds);
      const before = await f.entry.lookup(f.ctx, receiptId);
      const preview = await f.preview(run.runId, run.artifactIds, receiptId);
      scripts.push(approve);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("committed");
      const record = recordOf(f.acceptanceRoot).value;
      expect(record.policy).toEqual({ source: "hybrid-human-review", version: "human-review-policy-v1" });
      expect(record.contract).not.toBeNull();
      expect(record.receipt.receipt.outcome).toBe("insufficient");
      expect(record.receipt.receipt.taskAccepted).toBe(false);
      expect(record.receipt.digest).toBe(before!.reviewFacts!.receiptDigest);
      expect(record.humanReview.assessment.automaticCheckIds).toEqual(["answer"]);
      expect(record.humanReview.assessment.automaticEvidenceState).toBe("partial");
      expect(record.humanReview.assessment.humanSupplementRequiredRevisions).toEqual([]);
      expect(JSON.stringify(record.receipt.receipt)).toBe(JSON.stringify(before!.receipt));
      expect(record.receipt.receipt.outcome).toBe("insufficient");
      expect(record.receipt.receipt.taskAccepted).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("contract without a current receipt is rejected before transport", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      f.bind(partialSpec());
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      scripts.push(approve);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("rejected");
      expect(result.operation.outcome).toBe("not_committed");
      expect(scripts).toHaveLength(1);
      expect(calls).toBe(0);
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("a returned capability that is not the issued object cannot approve", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      scripts.push(() => ({ kind: "approve", capability: {} }));
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("invalidated");
      expect(result.operation.outcome).toBe("not_committed");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("late approval after cancellation or navigation cannot install", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      scripts.push((input) => {
        entered();
        return new Promise<HumanReviewTransportResult>((resolve) => {
          release = () => resolve({ kind: "approve", capability: input.capability });
        });
      });
      const controller = new AbortController();
      const pending = f.request(preview.deliveryId, controller.signal);
      await enteredPromise;
      controller.abort();
      release();
      const result = await pending;
      expect(result.review.state).toBe("cancelled");
      expect(result.operation.outcome).toBe("not_committed");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }

    clearTransport();
    const g = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await g.run();
      const preview = await g.preview(run.runId, run.artifactIds);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      scripts.push((input) => {
        entered();
        return new Promise<HumanReviewTransportResult>((resolve) => {
          release = () => resolve({ kind: "approve", capability: input.capability });
        });
      });
      const pending = g.request(preview.deliveryId);
      await enteredPromise;
      g.owner.navigate("session_branch");
      release();
      const result = await pending;
      expect(result.review.state).toBe("invalidated");
      expect(result.operation.outcome).toBe("not_committed");
      expect(readdirSync(g.acceptanceRoot)).toEqual([]);
    } finally {
      await g.cleanup();
    }
  });

  test("monotonic elapsed at 300000 ms expires a late approval even if the timer did not fire", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    const originalNow = performance.now;
    let fakeNow = originalNow();
    performance.now = () => fakeNow;
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      scripts.push((input) => {
        entered();
        return new Promise<HumanReviewTransportResult>((resolve) => {
          release = () => resolve({ kind: "approve", capability: input.capability });
        });
      });
      const pending = f.request(preview.deliveryId);
      await enteredPromise;
      fakeNow += 300_000;
      release();
      const result = await pending;
      expect(result.review.state).toBe("expired");
      expect(result.operation.outcome).toBe("not_committed");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      performance.now = originalNow;
      await f.cleanup();
    }
  });

  test("the review timer schedules only the remaining deadline after slow host now/id callbacks", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    const nowDescriptor = Object.getOwnPropertyDescriptor(performance, "now")!;
    const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    let monotonic = 1_000_000;
    const scheduled: Array<{ delay: number; cleared: boolean }> = [];
    const handles = new Map<unknown, { delay: number; cleared: boolean }>();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const service = new AcceptanceService({
      owner: f.owner,
      delivery: f.entry.delivery!,
      activity: () => f.entry.adapter.activitySnapshot(),
      acceptanceRoot: f.acceptanceRoot,
      executionRoot: f.root,
      humanReview: { kind: "local-main-tui", policyVersion: 1 },
      // The actual host callback advances one second after the reservation was
      // taken and before the review timer is created.
      now: () => {
        monotonic += 1_000;
        return "2026-11-08T00:00:00.000Z";
      },
    });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      scripts.push(() => ({ kind: "reject", reason: "simulated rejection after timer observation" }));
      Object.defineProperty(performance, "now", { ...nowDescriptor, configurable: true, value: () => monotonic });
      Object.defineProperty(globalThis, "setTimeout", {
        ...setDescriptor,
        configurable: true,
        value: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          const observation = { delay: Number(delay ?? 0), cleared: false };
          scheduled.push(observation);
          const handle = realSetTimeout(callback, delay, ...args);
          handles.set(handle, observation);
          return handle;
        },
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        ...clearDescriptor,
        configurable: true,
        value: (handle: unknown) => {
          const observation = handles.get(handle);
          if (observation !== undefined) observation.cleared = true;
          return realClearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      });
      const review = service.requestHumanReview(f.ctx, f.selector(preview.deliveryId));
      const guarded = new Promise<never>((_, reject) => {
        watchdog = realSetTimeout(() => reject(new Error("the review did not settle")), 15_000);
      });
      const result = await Promise.race([review, guarded]);
      expect(result.review.state).toBe("rejected");
      expect(result.operation.outcome).toBe("not_committed");
      expect(result.operation.operationCommitted).toBe(false);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      const deadlineTimers = scheduled.filter(
        (row) => row.delay === REVIEW_DEADLINE_MS || row.delay === REVIEW_DEADLINE_MS - 1_000,
      );
      expect(deadlineTimers).toEqual([{ delay: REVIEW_DEADLINE_MS - 1_000, cleared: true }]);
    } finally {
      service.dispose();
      if (watchdog !== undefined) realClearTimeout(watchdog);
      for (const handle of handles.keys()) realClearTimeout(handle as ReturnType<typeof setTimeout>);
      Object.defineProperty(globalThis, "setTimeout", setDescriptor);
      Object.defineProperty(globalThis, "clearTimeout", clearDescriptor);
      Object.defineProperty(performance, "now", nowDescriptor);
      clearTransport();
      await f.cleanup();
    }
  });

  test("busy/unresolved execution activity blocks review before transport", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    const originalSnapshot = f.entry.adapter.activitySnapshot.bind(f.entry.adapter);
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      f.entry.adapter.activitySnapshot = () => ({ ...originalSnapshot(), busy: true });
      scripts.push(approve);
      const result = await f.request(preview.deliveryId);
      expect(result.review.state).toBe("unavailable");
      expect(result.operation.outcome).toBe("not_committed");
      expect(calls).toBe(0);
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      f.entry.adapter.activitySnapshot = originalSnapshot;
      await f.cleanup();
    }
  });

  test("same-length tamper after presentation invalidates the approval without a new binding", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      scripts.push((input) => {
        entered();
        return new Promise<HumanReviewTransportResult>((resolve) => {
          release = () => resolve({ kind: "approve", capability: input.capability });
        });
      });
      const pending = f.request(preview.deliveryId);
      await enteredPromise;
      const filePath = path.join(f.deliveryRoot, preview.deliveryId, "candidate-01.txt");
      expect(readFileSync(filePath, "utf8")).toBe("42\n");
      chmodSync(filePath, 0o600);
      writeFileSync(filePath, "99\n");
      release();
      const result = await pending;
      expect(result.review.state).toBe("invalidated");
      expect(result.operation.outcome).toBe("not_committed");
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("a throwing host clock after reservation releases it for the next valid review", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    let nowCalls = 0;
    const throwing = new AcceptanceService({
      owner: f.owner,
      delivery: f.entry.delivery!,
      activity: () => f.entry.adapter.activitySnapshot(),
      acceptanceRoot: f.acceptanceRoot,
      executionRoot: f.root,
      humanReview: { kind: "local-main-tui", policyVersion: 1 },
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) throw new Error("injected host clock failure");
        return "2026-11-08T00:00:00.000Z";
      },
    });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const failed = await throwing.requestHumanReview(f.ctx, f.selector(preview.deliveryId));
      expect(nowCalls).toBe(1);
      expect(failed.review.state).toBe("unavailable");
      expect(failed.operation.outcome).toBe("not_committed");
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
      scripts.push(approve);
      const committed = await f.request(preview.deliveryId);
      expect(committed.review.state).toBe("committed");
      expect(f.owner.snapshot().currentTask!.status).toBe("accepted");
    } finally {
      throwing.dispose();
      await f.cleanup();
    }
  });

  test("a second AcceptanceService cannot use the pending reservation or the first capability", async () => {
    clearTransport();
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    const second = new AcceptanceService({
      owner: f.owner,
      delivery: f.entry.delivery!,
      activity: () => f.entry.adapter.activitySnapshot(),
      acceptanceRoot: f.acceptanceRoot,
      executionRoot: f.root,
      humanReview: { kind: "local-main-tui", policyVersion: 1 },
    });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      scripts.push((input) => {
        entered();
        return new Promise<HumanReviewTransportResult>((resolve) => {
          release = () => resolve({ kind: "approve", capability: input.capability });
        });
      });
      const first = f.request(preview.deliveryId);
      await enteredPromise;
      const competing = await second.requestHumanReview(f.ctx, f.selector(preview.deliveryId));
      expect(competing.review.state).toBe("unavailable");
      expect(competing.operation.outcome).toBe("not_committed");
      expect(calls).toBe(1);
      release();
      const committed = await first;
      expect(committed.review.state).toBe("committed");
      await expect(second.requestHumanReview(f.ctx, f.selector(preview.deliveryId))).resolves.toMatchObject({
        review: { state: "committed" },
      });
    } finally {
      second.dispose();
      await f.cleanup();
    }
  });
});
