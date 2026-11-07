import { describe, expect, test } from "bun:test";
import {
  MAX_REQUIREMENT_SOURCES,
  MAX_SOURCE_LEDGER_BYTES,
  RequirementBoundsError,
  assertRequirementCommitBounds,
  assertSourceLedgerBounds,
  classifyAdmissionReceipt,
  encodedUtf8Bytes,
  requirementProjection,
  revisionBaselineMatches,
  type RequirementSource,
} from "../../src/task-requirements.ts";

function source(revision: number, text: string, kind: "original" | "amendment" = revision === 1 ? "original" : "amendment"): RequirementSource {
  return {
    revision,
    kind,
    messageId: `user-${revision}`,
    sessionId: "session-pure",
    source: "rpc",
    text,
    observedAt: "2026-11-08T00:00:00.000Z",
    committedAt: "2026-11-08T00:00:01.000Z",
    previousRevision: revision === 1 ? null : revision - 1,
  };
}

function projectionOf(sources: RequirementSource[], revision = sources.length) {
  return requirementProjection({
    taskId: "task-pure",
    ownerId: "owner-pure",
    taskRevision: revision,
    sources,
    understanding: null,
  });
}

describe("requirement encoding and bounds", () => {
  test("one UTF-8 JSON encoding helper is used for ASCII, Chinese, emoji and escapes", () => {
    const text = "约束：保持低延迟 😀 \"quoted\" \\ backslash";
    expect(encodedUtf8Bytes(text)).toBe(new TextEncoder().encode(JSON.stringify(text)).byteLength);
    expect(encodedUtf8Bytes(text)).toBeGreaterThan(text.length);
    expect(encodedUtf8Bytes("中文")).toBe(8); // 2 CJK chars + the JSON quotes
    expect(encodedUtf8Bytes("😀")).toBe(6); // surrogate pair + the JSON quotes
    expect(encodedUtf8Bytes('"')).toBe(4); // escaped quote + JSON quotes
  });

  test("source ledger accepts the exact byte boundary and rejects one byte over atomically", () => {
    const base = source(1, "");
    const baseBytes = encodedUtf8Bytes([base]);
    const exact = [source(1, "a".repeat(MAX_SOURCE_LEDGER_BYTES - baseBytes))];
    expect(encodedUtf8Bytes(exact)).toBe(MAX_SOURCE_LEDGER_BYTES);
    expect(() => assertSourceLedgerBounds(exact)).not.toThrow();
    const over = [source(1, `${"a".repeat(MAX_SOURCE_LEDGER_BYTES - baseBytes)}b`)];
    expect(encodedUtf8Bytes(over)).toBe(MAX_SOURCE_LEDGER_BYTES + 1);
    expect(() => assertSourceLedgerBounds(over)).toThrow(RequirementBoundsError);
    expect(() => assertSourceLedgerBounds(over)).toThrow(/TOO_LARGE/);
    expect(over[0]!.text).toHaveLength(MAX_SOURCE_LEDGER_BYTES - baseBytes + 1);
  });

  test("record cap includes the original and rejects the 33rd source", () => {
    const sources: RequirementSource[] = [];
    for (let revision = 1; revision <= MAX_REQUIREMENT_SOURCES; revision += 1) {
      sources.push(source(revision, `r${revision}`));
    }
    expect(() => assertSourceLedgerBounds(sources)).not.toThrow();
    expect(() => assertSourceLedgerBounds([...sources, source(33, "extra")])).toThrow(/TOO_LARGE/);
  });

  test("projection and response envelopes have their own byte checks", () => {
    const sources = [source(1, "original")];
    const projection = projectionOf(sources);
    expect(() => assertRequirementCommitBounds({ sources, projection })).not.toThrow();
    const oversized = { ...projection, amendments: [{ ...projection.amendments[0], text: "x".repeat(200 * 1024) }] };
    expect(() => assertRequirementCommitBounds({ sources, projection: oversized as typeof projection }))
      .toThrow(/current requirements projection/);
    expect(() => assertRequirementCommitBounds({
      sources,
      projection,
      response: { text: "x".repeat(300 * 1024) },
    })).toThrow(/response envelope/);
  });

  test("projection keeps the original plus ordered amendments without truncation", () => {
    const sources = [source(1, "原要求"), source(2, "补充要求 😀"), source(3, "third")];
    const projection = projectionOf(sources, 3);
    expect(projection.authoritative).toBe("host-observed-sources");
    expect(projection.original.text).toBe("原要求");
    expect(projection.amendments.map((item) => item.revision)).toEqual([2, 3]);
    expect(projection.amendments.map((item) => item.text)).toEqual(["补充要求 😀", "third"]);
    expect(projection.taskRevision).toBe(3);
  });
});

describe("admission receipt compatibility", () => {
  const receipt = { taskId: "task-1", ownerId: "owner-1", taskRevision: 1, actionIndex: 3 };
  const context = { taskId: "task-1", ownerId: "owner-1", taskRevision: 1, detached: false };

  test("classifies current, stale revision, detached, other task and other owner", () => {
    expect(classifyAdmissionReceipt(receipt, context)).toBe("current");
    expect(classifyAdmissionReceipt(receipt, { ...context, taskRevision: 2 })).toBe("stale-revision");
    expect(classifyAdmissionReceipt(receipt, { ...context, detached: true })).toBe("detached");
    expect(classifyAdmissionReceipt(receipt, { ...context, taskId: "task-2" })).toBe("other-task");
    expect(classifyAdmissionReceipt(receipt, { ...context, ownerId: "owner-2" })).toBe("other-owner");
  });

  test("a receipt is a fixed original record, not a mutable current-state view", () => {
    const original = Object.freeze({ ...receipt });
    const later = { ...context, taskRevision: 2 };
    expect(classifyAdmissionReceipt(original, later)).toBe("stale-revision");
    expect(original).toEqual({ taskId: "task-1", ownerId: "owner-1", taskRevision: 1, actionIndex: 3 });
  });

  test("the revision baseline helper is strict", () => {
    expect(revisionBaselineMatches(1, 1)).toBe(true);
    expect(revisionBaselineMatches(1, 2)).toBe(false);
    expect(revisionBaselineMatches(null, 1)).toBe(false);
  });
});
