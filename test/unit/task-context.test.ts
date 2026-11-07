import { describe, expect, test } from "bun:test";
import {
  MAX_TASK_CONTEXT_BYTES,
  TASK_CONTEXT_TYPE,
  buildTaskContextMessage,
  buildUnavailableTaskContextMessage,
} from "../../src/task-context.ts";
import { encodedUtf8Bytes, requirementProjection, type RequirementSource } from "../../src/task-requirements.ts";
import type { BindingStatus } from "../../src/task-owner.ts";

const NOW = "2026-11-08T00:00:00.000Z";
const TIMESTAMP = 1_760_000_000_000;

function source(revision: number, text: string, kind: "original" | "amendment"): RequirementSource {
  return {
    revision,
    kind,
    messageId: `user-${revision}`,
    sessionId: "session-context",
    source: revision === 1 ? "interactive" : "rpc",
    text,
    observedAt: NOW,
    committedAt: NOW,
    previousRevision: revision === 1 ? null : revision - 1,
  };
}

const attached: BindingStatus = {
  state: "attached",
  reason: null,
  event: null,
  sessionId: "session-context",
  since: null,
};

function input(binding: BindingStatus = attached, texts = ["Original request.", "Amendment with Chinese 约束 😀."]) {
  const sources = [source(1, texts[0]!, "original")];
  if (texts[1] !== undefined) sources.push(source(2, texts[1]!, "amendment"));
  const requirements = requirementProjection({
    taskId: "task-context",
    ownerId: "owner-context",
    taskRevision: sources.length,
    sources,
    understanding: { text: "Non-authoritative working note.", revision: sources.length, stale: false },
  });
  return {
    task: {
      taskId: "task-context",
      taskRevision: sources.length,
      status: "active" as const,
      createdAt: NOW,
      cancelledAt: null,
      anchor: { messageId: "user-1", sessionId: "session-context" },
    },
    binding,
    requirements,
    authorizedCapabilities: ["test-progress"],
  };
}

describe("bounded task context projection", () => {
  test("normal view restates complete ordered sources with provenance and detached copy", () => {
    const inputValue = input();
    const built = buildTaskContextMessage(inputValue, TIMESTAMP);
    expect(built.fallback).toBe(false);
    expect(built.bytes).toBe(encodedUtf8Bytes(built.message));
    expect(built.bytes).toBeLessThanOrEqual(MAX_TASK_CONTEXT_BYTES);
    expect(built.message).toMatchObject({
      role: "custom",
      customType: TASK_CONTEXT_TYPE,
      display: false,
      attribution: "agent",
      timestamp: TIMESTAMP,
    });
    const parsed = JSON.parse(built.message.content) as typeof built.view;
    expect(parsed).toEqual(built.view);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "omp-agent.task-context",
      availability: "current",
      task: {
        taskId: "task-context",
        taskRevision: 2,
        status: "active",
        anchor: { messageId: "user-1", sessionId: "session-context" },
      },
      binding: { state: "attached" },
      authorizedCapabilities: ["test-progress"],
    });
    const view = parsed as {
      provenance: Record<string, string>;
      requirements: {
        original: { revision: number; text: string };
        amendments: Array<{ revision: number; previousRevision: number; source: string; text: string }>;
        understanding: { text: string; revision: number; stale: boolean } | null;
      };
    };
    expect(view.provenance).toEqual({
      requirements: "host-observed-sources",
      understanding: "non-authoritative-model-note",
    });
    expect(view.requirements.original).toMatchObject({ revision: 1, text: "Original request." });
    expect(view.requirements.amendments).toHaveLength(1);
    expect(view.requirements.amendments[0]).toMatchObject({
      revision: 2,
      previousRevision: 1,
      source: "rpc",
      text: "Amendment with Chinese 约束 😀.",
    });
    expect(view.requirements.understanding).toMatchObject({
      text: "Non-authoritative working note.",
      revision: 2,
      stale: false,
    });

    // Returned input and output are not aliases.
    (built.view as { requirements: { original: { text: string } } }).requirements.original.text = "FORGED";
    expect(inputValue.requirements.original.text).toBe("Original request.");
  });

  test("detached binding is explicit read-only/unavailable while keeping complete sources", () => {
    const detached: BindingStatus = {
      state: "detached",
      reason: "conversation navigation (session_tree) invalidated the execution binding",
      event: "session_tree",
      sessionId: "session-context",
      since: NOW,
    };
    const built = buildTaskContextMessage(input(detached), TIMESTAMP);
    expect(built.fallback).toBe(false);
    expect(built.view).toMatchObject({
      availability: "read-only-unavailable",
      binding: {
        state: "detached",
        reason: "conversation navigation (session_tree) invalidated the execution binding",
        event: "session_tree",
      },
    });
    expect((built.view as { requirements: { original: { text: string } } }).requirements.original.text).toBe("Original request.");
  });

  test("an over-bound complete projection returns a small visible marker instead of truncation", () => {
    const inputValue = input(attached, ["x".repeat(200 * 1024), "amendment"]);
    const built = buildTaskContextMessage(inputValue, TIMESTAMP);
    expect(built.fallback).toBe(true);
    expect(built.bytes).toBeLessThanOrEqual(MAX_TASK_CONTEXT_BYTES);
    expect(built.message.content).not.toContain("x".repeat(1024));
    expect(built.view).toMatchObject({
      state: "unavailable",
      kind: "omp-agent.task-context",
      task: { taskId: "task-context", taskRevision: 2, status: "active" },
    });
    expect(String((built.view as { reason: string }).reason)).toContain("no requirement text was truncated");
  });

  test("the internal-failure marker is bounded and carries no partial constraints", () => {
    const built = buildUnavailableTaskContextMessage({
      reason: "projection failed",
      task: { taskId: "task-context", taskRevision: 2, status: "cancelled" },
      binding: { state: "attached", reason: null },
    }, TIMESTAMP);
    expect(built.fallback).toBe(true);
    expect(built.bytes).toBeLessThanOrEqual(MAX_TASK_CONTEXT_BYTES);
    expect(built.view).toMatchObject({
      state: "unavailable",
      reason: "projection failed",
      task: { taskId: "task-context", taskRevision: 2, status: "cancelled" },
    });
  });
});
