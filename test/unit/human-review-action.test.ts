import { describe, expect, test } from "bun:test";
import { parseDeliveryArguments } from "../../src/delivery-entry.ts";

describe("C2-A request_review schema", () => {
  const selector = {
    action: "request_review",
    expectedTaskId: "task-fixture",
    expectedTaskRevision: 1,
    deliveryId: "delivery-fixture",
  };

  test("accepts only the existing exact selectors", () => {
    expect(parseDeliveryArguments(selector)).toEqual({
      action: "request_review",
      request: {
        expectedTaskId: "task-fixture",
        expectedTaskRevision: 1,
        deliveryId: "delivery-fixture",
      },
    });
  });

  test("rejects extra selector-shaped and authority-shaped fields", () => {
    for (const extra of [
      { runId: "run-other" },
      { artifactIds: ["artifact-other"] },
      { verificationReceiptId: "receipt-other" },
      { unknownModelField: true },
    ]) {
      expect(() => parseDeliveryArguments({ ...selector, ...extra })).toThrow(/selector/);
    }
    for (const extra of [
      { confirmed: true },
      { approved: true },
      { approve: true },
      { verdict: "pass" },
      { accepted: true },
      { reviewer: "model" },
      { decision: "approve" },
      { token: {} },
      { capability: {} },
      { nonce: "n" },
      { receipt: {} },
      { humanReceipt: {} },
      { humanReview: {} },
      { path: "/tmp/x" },
      { digest: "sha256:00" },
      { content: "x" },
      { timeout: 1 },
      { limits: {} },
    ]) {
      expect(() => parseDeliveryArguments({ ...selector, ...extra })).toThrow(/authority/);
    }
  });

  test("rejects missing or malformed selectors", () => {
    expect(() => parseDeliveryArguments({
      action: "request_review",
      expectedTaskId: "task-fixture",
      expectedTaskRevision: 1,
    })).toThrow(/deliveryId/);
    expect(() => parseDeliveryArguments({
      ...selector,
      expectedTaskRevision: 0,
    })).toThrow(/expectedTaskRevision/);
    expect(() => parseDeliveryArguments({
      ...selector,
      expectedTaskId: "../escape",
    })).toThrow(/expectedTaskId/);
  });
});
