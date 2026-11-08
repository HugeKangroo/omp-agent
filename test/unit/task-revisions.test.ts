import { describe, expect, test } from "bun:test";
import {
  TaskOwner,
  type ManagedTask,
  type TaskOwnerSnapshot,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-b2a-unit-workspace";
const SESSION = "session-b2a-unit";
const NOW = "2026-11-08T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

function assistant(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  };
}

function background(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "custom_message",
    customType: "fixture.background",
    content: "BACKGROUND: revise the task",
    attribution: "agent",
  };
}

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function subject(branch: readonly unknown[], sessionId = SESSION): TaskSubject {
  return { sessionId, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner, taskRevision?: number) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: taskRevision ?? task.taskRevision };
}

function makeOwner(): { owner: TaskOwner; states: TaskOwnerSnapshot[] } {
  const states: TaskOwnerSnapshot[] = [];
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-b2a-unit",
    authorizedCapabilities: ["test-progress"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
    onStateChange: (snapshot) => states.push(snapshot),
  });
  return { owner, states };
}

function observe(owner: TaskOwner, text: string, baseLeafId = "leaf-1") {
  return owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId,
  });
}

function start(owner: TaskOwner, branch: readonly unknown[], text: string, understanding?: string): ManagedTask {
  const grant = owner.snapshot().activeGrant;
  if (!grant) throw new Error("test setup: no active grant");
  owner.observeAgentStart({ sessionId: grant.sessionId, prompt: text, reason: "prompt" });
  return owner.start(subject(branch), understanding).task;
}

function close(owner: TaskOwner, branch: readonly unknown[], userId: string, text: string): void {
  expect(owner.closeTurn({ sessionId: SESSION, branch, messages: [messageOf(user(userId, "leaf-1", text))] })).toBe(true);
}

function startTurn(owner: TaskOwner, text: string, baseLeafId: string): void {
  expect(observe(owner, text, baseLeafId).accepted).toBe(true);
  const grant = owner.snapshot().activeGrant!;
  owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  expect(owner.snapshot().activeGrant?.started).toBe(true);
  expect(grant.baselineTaskRevision).toBe(owner.snapshot().currentTask?.taskRevision ?? null);
}

describe("B2a requirement revisions", () => {
  test("accepted amendment appends one source and keeps identity, request and anchor immutable", () => {
    const { owner } = makeOwner();
    const first = [base(), user("user-1", "leaf-1", "Original request.")];
    observe(owner, "Original request.");
    const created = start(owner, first, "Original request.", "initial understanding");
    close(owner, first, "user-1", "Original request.");

    const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Use low latency, keep recall.")];
    startTurn(owner, "Use low latency, keep recall.", "assistant-1");
    const result = owner.revise(subject(second), guard(owner), "revised understanding");

    expect(result.revised).toBe(true);
    expect(result.task.taskRevision).toBe(2);
    expect(result.task.taskId).toBe(created.taskId);
    expect(result.task.ownerId).toBe(created.ownerId);
    expect(result.task.rawRequest).toBe("Original request.");
    expect(result.task.anchor).toEqual(created.anchor);
    expect(result.task.createdAt).toBe(NOW);
    expect(result.task.requirementSources).toHaveLength(2);
    expect(result.task.requirementSources[0]).toMatchObject({ revision: 1, kind: "original", text: "Original request.", previousRevision: null });
    expect(result.task.requirementSources[1]).toMatchObject({
      revision: 2,
      kind: "amendment",
      previousRevision: 1,
      messageId: "user-2",
      sessionId: SESSION,
      source: "rpc",
      text: "Use low latency, keep recall.",
      observedAt: NOW,
      committedAt: NOW,
    });
    expect(result.task.understanding).toBe("revised understanding");
    expect(result.task.understandingRevision).toBe(2);
    expect(result.task.understandingStale).toBe(false);

    const projection = owner.requirements();
    expect(projection.original.text).toBe("Original request.");
    expect(projection.amendments.map((item) => item.text)).toEqual(["Use low latency, keep recall."]);
    expect(projection.taskRevision).toBe(2);
  });

  test("a same-host-message retry returns the committed revision once even though its baseline is older", () => {
    const { owner } = makeOwner();
    const first = [base(), user("user-1", "leaf-1", "Original request.")];
    observe(owner, "Original request.");
    start(owner, first, "Original request.");
    close(owner, first, "user-1", "Original request.");
    const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Amended request.")];
    startTurn(owner, "Amended request.", "assistant-1");

    expect(owner.revise(subject(second), guard(owner), "first understanding").revised).toBe(true);
    const baselineAfterCommit = owner.snapshot().activeGrant!.baselineTaskRevision;
    expect(baselineAfterCommit).toBe(1);
    expect(owner.snapshot().currentTask!.taskRevision).toBe(2);

    const retry = owner.revise(subject(second), guard(owner), "ignored retry understanding");
    expect(retry.revised).toBe(false);
    expect(retry.task.taskRevision).toBe(2);
    expect(retry.task.requirementSources).toHaveLength(2);
    expect(retry.task.understanding).toBe("first understanding");
    expect(owner.snapshot().tasksCreated).toBe(1);
  });

  test("the same text from a distinct genuine message is not deduplicated and does not reset requirements", () => {
    const { owner } = makeOwner();
    const first = [base(), user("user-1", "leaf-1", "Original request.")];
    observe(owner, "Original request.");
    start(owner, first, "Original request.", "bound understanding");
    close(owner, first, "user-1", "Original request.");

    const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Same amendment words.")];
    startTurn(owner, "Same amendment words.", "assistant-1");
    // No understanding on revise: prior understanding becomes stale, never current.
    expect(owner.revise(subject(second), guard(owner)).task.understandingStale).toBe(true);
    expect(owner.snapshot().currentTask!.understanding).toBe("bound understanding");
    expect(owner.snapshot().currentTask!.understandingRevision).toBe(1);
    close(owner, second, "user-2", "Same amendment words.");

    const third = [...second, assistant("assistant-2", "user-2"), user("user-3", "assistant-2", "Same amendment words.")];
    startTurn(owner, "Same amendment words.", "assistant-2");
    const result = owner.revise(subject(third), guard(owner));
    expect(result.revised).toBe(true);
    expect(result.task.taskRevision).toBe(3);
    expect(result.task.requirementSources.map((item) => item.messageId)).toEqual(["user-1", "user-2", "user-3"]);
    expect(result.task.requirementSources.map((item) => item.previousRevision)).toEqual([null, 1, 2]);
  });

  test("the creation message cannot also be an amendment and understanding-only reads never bump revision", () => {
    const { owner } = makeOwner();
    const branch = [base(), user("user-1", "leaf-1", "Original request.")];
    observe(owner, "Original request.");
    start(owner, branch, "Original request.", "u1");
    expect(() => owner.revise(subject(branch), guard(owner), "creation retry")).toThrow(/creation message cannot/);
    expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
    expect(owner.inspect(subject(branch)).taskRevision).toBe(1);
    expect(owner.requirements().taskRevision).toBe(1);
    expect(owner.admit(subject(branch), "test-progress", guard(owner)).allowed).toBe(true);
    expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
    expect(owner.snapshot().currentTask!.requirementSources).toHaveLength(1);
  });

  test("background, cancelled, detached and stale-baseline revisions are refused without changing requirements", () => {
    {
      const { owner } = makeOwner();
      const branch = [base(), user("user-1", "leaf-1", "Original request.")];
      observe(owner, "Original request.");
      start(owner, branch, "Original request.");
      const backgroundBranch = [...branch, background("background-1", "user-1")];
      expect(() => owner.revise(subject(backgroundBranch), guard(owner))).toThrow(/authority window was closed/);
      expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
      expect(owner.snapshot().currentTask!.requirementSources).toHaveLength(1);
    }
    {
      const { owner } = makeOwner();
      const branch = [base(), user("user-1", "leaf-1", "Original request.")];
      observe(owner, "Original request.");
      start(owner, branch, "Original request.");
      owner.cancel(subject(branch), guard(owner));
      expect(() => owner.revise(subject(branch), guard(owner))).toThrow(/cancelled task cannot be revised/);
      expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
    }
    {
      const { owner } = makeOwner();
      const first = [base(), user("user-1", "leaf-1", "Original request.")];
      observe(owner, "Original request.");
      start(owner, first, "Original request.");
      owner.navigate("session_branch", SESSION);
      expect(owner.bindingStatus()).toMatchObject({ state: "detached", event: "session_branch" });
      expect(() => owner.revise(subject(first), guard(owner))).toThrow(/binding is detached/);
      expect(() => owner.cancel(subject(first), guard(owner))).toThrow(/binding is detached/);
      expect(owner.admit(subject(first), "test-progress", guard(owner))).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("conversation binding is detached"),
      });
      expect(owner.inspect(subject(first)).taskId).toBe(owner.snapshot().currentTask!.taskId);
      expect(owner.bindingStatus().state).toBe("detached");
      expect(() => owner.start(subject(first))).toThrow(/binding is detached/);
    }
    {
      const { owner } = makeOwner();
      const first = [base(), user("user-1", "leaf-1", "Original request.")];
      observe(owner, "Original request.");
      start(owner, first, "Original request.");
      close(owner, first, "user-1", "Original request.");
      const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Amendment.")];
      startTurn(owner, "Amendment.", "assistant-1");
      // Simulate a concurrent accepted amendment between observation and commit.
      (owner as unknown as { task: { taskRevision: number } }).task.taskRevision = 2;
      expect(() => owner.revise(subject(second), guard(owner))).toThrow(/Stale requirement baseline/);
      expect(owner.snapshot().currentTask!.taskRevision).toBe(2);
      expect(owner.snapshot().currentTask!.requirementSources).toHaveLength(1);
    }
  });

  test("a different session_start or navigation detaches, while a fresh startup still starts a task", () => {
    {
      const { owner } = makeOwner();
      const first = [base(), user("user-1", "leaf-1", "Original request.")];
      observe(owner, "Original request.");
      start(owner, first, "Original request.");
      owner.sessionStarted("session-other");
      expect(owner.bindingStatus().state).toBe("detached");
      expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
    }
    {
      const { owner } = makeOwner();
      owner.sessionStarted("session-fresh");
      expect(owner.bindingStatus().state).toBe("attached");
      const branch = [base(), user("user-1", "leaf-1", "Fresh request.")];
      observe(owner, "Fresh request.");
      expect(start(owner, branch, "Fresh request.").taskRevision).toBe(1);
    }
  });

  test("TOO_LARGE rejects starts and amendments before owner/revision/ledger or admission changes", () => {
    {
      const { owner } = makeOwner();
      const big = "a".repeat(70 * 1024);
      const branch = [base(), user("user-1", "leaf-1", big)];
      observe(owner, big);
      expect(() => start(owner, branch, big)).toThrow(/TOO_LARGE/);
      expect(owner.snapshot().tasksCreated).toBe(0);
      expect(owner.snapshot().currentTask).toBeNull();
    }
    {
      const { owner } = makeOwner();
      const firstText = "a".repeat(40 * 1024);
      const first = [base(), user("user-1", "leaf-1", firstText)];
      observe(owner, firstText);
      start(owner, first, firstText);
      close(owner, first, "user-1", firstText);
      expect(owner.admit(subject(first), "test-progress", guard(owner)).actionIndex).toBe(1);
      const amendmentText = "b".repeat(40 * 1024);
      const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", amendmentText)];
      startTurn(owner, amendmentText, "assistant-1");
      expect(() => owner.revise(subject(second), guard(owner))).toThrow(/TOO_LARGE/);
      expect(owner.snapshot().currentTask!.taskRevision).toBe(1);
      expect(owner.snapshot().currentTask!.requirementSources).toHaveLength(1);
      expect(owner.snapshot().currentTask!.requirementSources[0]!.text).toBe(firstText);
      expect(owner.snapshot().currentTask!.admissions).toBe(1);
      expect(owner.snapshot().activeGrant?.started).toBe(true);
    }
  });

  test("admission guard: planned revision 1 is rejected after revise 2 and does not move the counter", () => {
    const { owner } = makeOwner();
    const first = [base(), user("user-1", "leaf-1", "Original request.")];
    observe(owner, "Original request.");
    start(owner, first, "Original request.");
    close(owner, first, "user-1", "Original request.");
    const second = [...first, assistant("assistant-1", "user-1"), user("user-2", "assistant-1", "Amendment.")];
    startTurn(owner, "Amendment.", "assistant-1");
    owner.revise(subject(second), guard(owner));

    const stale = owner.admit(subject(second), "test-progress", guard(owner, 1));
    expect(stale).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("stale expected taskRevision 1"),
      taskRevision: 2,
      expectedTaskRevision: 1,
      actionIndex: null,
    });
    expect(owner.snapshot().currentTask!.admissions).toBe(0);
    const current = owner.admit(subject(second), "test-progress", guard(owner, 2));
    expect(current).toMatchObject({ allowed: true, taskRevision: 2, expectedTaskRevision: 2, actionIndex: 1 });
    expect(owner.snapshot().currentTask!.taskRevision).toBe(2);
    expect(owner.snapshot().currentTask!.admissions).toBe(1);
    expect(owner.admit(subject(second), "test-progress", guard(owner, 0))).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("expectedTaskRevision must be a positive integer"),
      actionIndex: null,
    });
  });
});
