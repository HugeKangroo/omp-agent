import { describe, expect, test } from "bun:test";
import {
  parseTaskControlArguments,
  TaskOwner,
  TaskOwnerError,
  TASK_HISTORY_LIMIT,
  TASK_REPLAY_ENTRY_LIMIT,
  type ManagedTask,
  type TaskOwnerEvent,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-b3a-continuity-workspace";
const SESSION = "session-b3a-continuity";
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

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function subject(branch: readonly unknown[], sessionId = SESSION): TaskSubject {
  return { sessionId, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: task.taskRevision };
}

interface Harness {
  owner: TaskOwner;
  events: Array<Record<string, unknown> & { type: string }>;
  entries: Entry[];
  nextTurn(text: string): void;
  startCurrent(understanding?: string): void;
}

function harness(options: {
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
} = {}): Harness {
  const events: Array<Record<string, unknown> & { type: string }> = [];
  let sequence = 0;
  let turn = 0;
  const entries: Entry[] = [base()];
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-b3a-continuity",
    authorizedCapabilities: ["test-progress"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  let currentText = "";
  const scope = (): { branch: Entry[] } => ({ branch: entries });

  const api: Harness = {
    owner,
    events,
    entries,
    nextTurn(text: string) {
      const lastUser = [...entries].reverse().find((entry) => entry.type === "message"
        && (entry.message as Record<string, unknown>).role === "user");
      if (lastUser) {
        owner.closeTurn({
          sessionId: SESSION,
          branch: entries,
          messages: [messageOf(lastUser)],
        });
      }
      turn += 1;
      const assistantId = `assistant-${turn}`;
      entries.push(assistant(assistantId, lastUser?.id ?? "leaf-1"));
      const userId = `user-${turn + 1}`;
      entries.push(user(userId, assistantId, text));
      currentText = text;
      expect(owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: WORKSPACE,
        source: "rpc",
        text,
        observedAt: NOW,
        baseLeafId: assistantId,
      }).accepted).toBe(true);
      owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
    },
    startCurrent(understanding?: string) {
      owner.start(subject(scope().branch), understanding);
    },
  };
  // First genuine message.
  entries.push(user("user-1", "leaf-1", "Initial managed request."));
  currentText = "Initial managed request.";
  expect(owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text: currentText,
    observedAt: NOW,
    baseLeafId: "leaf-1",
  }).accepted).toBe(true);
  owner.observeAgentStart({ sessionId: SESSION, prompt: currentText, reason: "prompt" });
  return api;
}

function cancelCurrent(h: Harness): ManagedTask {
  return h.owner.cancel(subject(h.entries), guard(h.owner));
}

describe("B3-A continuous task lifecycle", () => {
  test("a cancelled task is retained while a later genuine anchor starts a new task", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Cancel this task.");
    const cancelled = cancelCurrent(h);
    expect(cancelled.taskId).toBe(a.taskId);
    expect(cancelled.status).toBe("cancelled");

    h.nextTurn("Start a second managed task.");
    const b = h.owner.start(subject(h.entries)).task;
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.status).toBe("active");
    expect(h.owner.snapshot().currentTask?.taskId).toBe(b.taskId);

    const history = h.owner.historyPage(subject(h.entries), 0, 16);
    expect(history.total).toBe(1);
    expect(history.rows[0]).toMatchObject({
      taskId: a.taskId,
      taskRevision: 1,
      status: "cancelled",
      anchorMessageId: "user-1",
      sourceCount: 1,
      current: false,
    });
    expect(history.retention).toMatchObject({
      tasksRetained: 2,
      tasksLimit: TASK_HISTORY_LIMIT,
      terminalTasks: 1,
    });

    const target = h.owner.inspectTarget(subject(h.entries), { taskId: a.taskId, taskRevision: 1 });
    expect(target.historical).toBe(true);
    expect(target.target.status).toBe("cancelled");
    expect(target.target.rawRequest).toBe("Initial managed request.");
    expect(target.target.requirementSources).toHaveLength(1);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(b.taskId);
  });

  test("an active task is never replaced implicitly by a new genuine message", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Please replace it.");
    expect(() => h.owner.start(subject(h.entries))).toThrow(/still active|never replaced implicitly/);
    expect(h.owner.snapshot().tasksCreated).toBe(1);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(a.taskId);
  });

  test("same-anchor replay returns the original task; same text on a new message is distinct", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    const replay = h.owner.start(subject(h.entries));
    expect(replay).toMatchObject({ created: false, historical: false });
    expect(replay.task.taskId).toBe(a.taskId);
    expect(h.owner.snapshot().tasksCreated).toBe(1);

    h.nextTurn("Cancel this task.");
    cancelCurrent(h);
    h.nextTurn("Initial managed request.");
    const b = h.owner.start(subject(h.entries)).task;
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.rawRequest).toBe(a.rawRequest);
    expect(b.anchor.messageId).not.toBe(a.anchor.messageId);
    expect(h.owner.snapshot().tasksCreated).toBe(2);
  });

  test("a cancellation message cannot be repurposed to create the next task", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Cancel this and then start another.");
    cancelCurrent(h);
    expect(() => h.owner.start(subject(h.entries))).toThrow(/already consumed to cancel/);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(a.taskId);
    expect(h.owner.snapshot().currentTask?.status).toBe("cancelled");
    expect(h.owner.snapshot().tasksCreated).toBe(1);
  });

  test("old same-revision selectors never target a newer task", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Cancel this task.");
    cancelCurrent(h);
    h.nextTurn("Start a second task.");
    const b = h.owner.start(subject(h.entries)).task;

    expect(() => h.owner.cancel(subject(h.entries), { taskId: a.taskId, taskRevision: 1 }))
      .toThrow(/expectedTaskId does not match the current task/);
    expect(b.status).toBe("active");
    expect(h.owner.snapshot().currentTask?.taskId).toBe(b.taskId);

    // A late amendment message for B may not use A's selector either.
    h.nextTurn("Amend the current task.");
    expect(() => h.owner.revise(subject(h.entries), { taskId: a.taskId, taskRevision: 1 }))
      .toThrow(/expectedTaskId does not match the current task/);
    expect(h.owner.snapshot().currentTask?.taskRevision).toBe(1);
    expect(h.owner.snapshot().currentTask?.requirementSources).toHaveLength(1);

    const denied = h.owner.admit(subject(h.entries), "test-progress", { taskId: a.taskId, taskRevision: 1 });
    expect(denied).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("is not the current task"),
      actionIndex: null,
    });
    expect(h.owner.snapshot().currentTask?.admissions).toBe(0);
  });

  test("missing and stale guards are rejected before task, grant or admission mutation", () => {
    const h = harness();
    h.owner.start(subject(h.entries));
    h.nextTurn("Amend the current task.");
    const before = h.owner.snapshot();

    expect(() => h.owner.revise(subject(h.entries), undefined as unknown as never)).toThrow(/Task selector/);
    expect(() => h.owner.revise(subject(h.entries), { taskId: before.currentTask!.taskId, taskRevision: 2 }))
      .toThrow(/stale expectedTaskRevision/);
    expect(() => h.owner.cancel(subject(h.entries), { taskId: "task-other", taskRevision: 1 }))
      .toThrow(/expectedTaskId does not match/);
    const after = h.owner.snapshot();
    expect(after.currentTask).toMatchObject({
      taskId: before.currentTask!.taskId,
      taskRevision: 1,
      status: "active",
      admissions: 0,
    });
    expect(after.currentTask!.requirementSources).toHaveLength(1);
    expect(after.activeGrant?.started).toBe(true);
    expect(after.retention.replayEntries).toBe(before.retention.replayEntries);
  });

  test("admission revocation keeps the committed count/action index without relabelling the next task", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.owner.subscribe((event: TaskOwnerEvent) => {
      if (event.type === "capability_admission_allowed") {
        h.owner.cancel(subject(h.entries), guard(h.owner));
      }
    });
    const decision = h.owner.admit(subject(h.entries), "test-progress", { taskId: a.taskId, taskRevision: 1 });
    expect(decision).toMatchObject({
      allowed: false,
      taskId: a.taskId,
      taskRevision: 1,
      actionIndex: 1,
      status: "cancelled",
      reason: expect.stringContaining("revoked"),
    });
    expect(h.owner.snapshot().currentTask?.admissions).toBe(1);
    expect(h.events.some((event) => event.type === "capability_admission_revoked"
      && event.taskId === a.taskId && event.actionIndex === 1)).toBe(true);
  });

  test("history is session/branch scoped, paginated, defensive and never moves the current pointer", () => {
    const h = harness();
    const tasks: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      if (index === 0) h.owner.start(subject(h.entries));
      else {
        h.nextTurn(`Start task ${index}`);
        h.owner.start(subject(h.entries));
      }
      tasks.push(h.owner.snapshot().currentTask!.taskId);
      h.nextTurn(`Cancel task ${index}`);
      cancelCurrent(h);
    }
    h.nextTurn("Start current task");
    const current = h.owner.start(subject(h.entries)).task;

    const first = h.owner.historyPage(subject(h.entries), 0, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.rows.map((row) => row.taskId)).toEqual([tasks[2]!, tasks[1]!]);
    expect(first.nextCursor).toBe(2);
    const second = h.owner.historyPage(subject(h.entries), 2, 2);
    expect(second.rows.map((row) => row.taskId)).toEqual([tasks[0]!]);
    expect(second.nextCursor).toBeNull();
    expect(h.owner.snapshot().currentTask?.taskId).toBe(current.taskId);

    first.rows[0]!.taskId = "tampered";
    expect(h.owner.historyPage(subject(h.entries), 0, 2).rows[0]!.taskId).toBe(tasks[2]!);

    expect(h.owner.historyPage(subject(h.entries, "session-other"), 0, 2).total).toBe(0);
    const unrelated = [base("leaf-9"), user("user-9", "leaf-9", "Unrelated.")];
    expect(h.owner.historyPage(subject(unrelated), 0, 2).total).toBe(0);
    expect(() => h.owner.inspectTarget(subject(unrelated), { taskId: tasks[0]!, taskRevision: 1 }))
      .toThrow(/not visible/);
    expect(() => h.owner.inspectTarget(subject(h.entries), { taskId: tasks[0]!, taskRevision: 2 }))
      .toThrow(/stale expectedTaskRevision/);
    expect(() => h.owner.historyPage(subject(h.entries), 0, 17)).toThrow(/between 1 and 16/);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(current.taskId);
  });

  test("task retention capacity rejects atomically without evicting terminal history", () => {
    const h = harness();
    h.owner.start(subject(h.entries));
    for (let index = 1; index < TASK_HISTORY_LIMIT; index += 1) {
      h.nextTurn(`Cancel task ${index}`);
      cancelCurrent(h);
      h.nextTurn(`Start task ${index}`);
      h.owner.start(subject(h.entries));
    }
    expect(h.owner.snapshot().retention.tasksRetained).toBe(TASK_HISTORY_LIMIT);
    const last = h.owner.snapshot().currentTask!;
    h.nextTurn("Cancel the final retained task");
    cancelCurrent(h);
    h.nextTurn("This task cannot be retained");
    expect(() => h.owner.start(subject(h.entries))).toThrow(/retention is full/);
    expect(h.owner.snapshot().tasksCreated).toBe(TASK_HISTORY_LIMIT);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(last.taskId);
    expect(h.owner.snapshot().currentTask?.status).toBe("cancelled");
    expect(h.owner.historyPage(subject(h.entries), 0, 16).total).toBe(TASK_HISTORY_LIMIT);
  });

  test("replay capacity rejects before mutation and preserves the cancelled task", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Cancel this task.");
    const control = (h.owner as unknown as { controlIndex: Map<string, unknown> }).controlIndex;
    const anchor = (h.owner as unknown as { anchorIndex: Map<string, unknown> }).anchorIndex;
    for (let index = 0; index < TASK_REPLAY_ENTRY_LIMIT - anchor.size - 1; index += 1) {
      control.set(`fixture\0${index}`, { taskId: a.taskId, action: "revise" });
    }
    expect(control.size + anchor.size).toBe(TASK_REPLAY_ENTRY_LIMIT - 1);
    cancelCurrent(h);
    expect(h.owner.snapshot().currentTask?.status).toBe("cancelled");
    expect(h.owner.snapshot().retention.replayEntries).toBe(TASK_REPLAY_ENTRY_LIMIT);

    h.nextTurn("Start after replay capacity");
    expect(() => h.owner.start(subject(h.entries))).toThrow(/replay capacity is full/);
    expect(h.owner.snapshot().tasksCreated).toBe(1);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(a.taskId);
    expect(h.owner.snapshot().currentTask?.status).toBe("cancelled");
  });

  test("unknown acceptance installation latches block a next task and survive current-task changes", () => {
    const h = harness();
    const a = h.owner.start(subject(h.entries)).task;
    h.nextTurn("Cancel this task.");
    cancelCurrent(h);
    const internals = h.owner as unknown as {
      acceptanceHazard?: {
        task: { ownerId: string; taskId: string; taskRevision: number; requirementsDigest: string };
        reason: string;
        acceptanceId: string;
        deliveryId: string;
        recordDigest: string;
      };
    };
    internals.acceptanceHazard = {
      task: { ownerId: a.ownerId, taskId: a.taskId, taskRevision: 1, requirementsDigest: "sha256:fixture" },
      reason: "fixture unknown installation",
      acceptanceId: "acceptance-fixture",
      deliveryId: "delivery-fixture",
      recordDigest: "sha256:record",
    };
    h.nextTurn("Start despite unknown");
    expect(() => h.owner.start(subject(h.entries))).toThrow(/outcome is unknown/);
    h.nextTurn("Amend despite unknown");
    expect(() => h.owner.revise(subject(h.entries), { taskId: a.taskId, taskRevision: 1 }))
      .toThrow(/outcome is unknown/);
    expect(h.owner.snapshot().acceptanceHazard?.task.taskId).toBe(a.taskId);
    expect(h.owner.snapshot().currentTask?.taskId).toBe(a.taskId);
  });

  test("reentrant preflight and postcommit notification failures preserve bounded identity", () => {
    {
      const h = harness();
      const a = h.owner.start(subject(h.entries)).task;
      h.nextTurn("Cancel this task.");
      cancelCurrent(h);
      h.nextTurn("Start a second task.");
      expect(() => h.owner.start(subject(h.entries), undefined, () => {
        h.owner.navigate("session_tree", SESSION);
      })).toThrow(/detached/);
      expect(h.owner.snapshot().tasksCreated).toBe(1);
      expect(h.owner.snapshot().currentTask?.taskId).toBe(a.taskId);
      expect(h.owner.bindingStatus().state).toBe("detached");
    }
    {
      let h!: Harness;
      let fail = false;
      h = harness({
        onEvent: (event) => {
          if (fail && event.type === "task_started") throw new Error("postcommit start notification failed");
        },
      });
      const a = h.owner.start(subject(h.entries)).task;
      h.nextTurn("Cancel this task.");
      cancelCurrent(h);
      h.nextTurn("Start a second task.");
      fail = true;
      expect(() => h.owner.start(subject(h.entries))).toThrow("postcommit start notification failed");
      const current = h.owner.snapshot().currentTask!;
      expect(current.taskId).not.toBe(a.taskId);
      expect(current.status).toBe("active");
      expect(h.owner.historyPage(subject(h.entries), 0, 16).rows[0]?.taskId).toBe(a.taskId);
      const repaired = h.owner.start(subject(h.entries));
      expect(repaired.created).toBe(false);
      expect(repaired.task.taskId).toBe(current.taskId);
    }
  });
});

describe("B3-A strict argument surface", () => {
  test("selectors are required for revise/cancel, optional only for inspect, and history pages are bounded", () => {
    expect(parseTaskControlArguments({ action: "revise", expectedTaskId: "task-a", expectedTaskRevision: 1 }))
      .toEqual({ action: "revise", expectedTaskId: "task-a", expectedTaskRevision: 1 });
    expect(parseTaskControlArguments({ action: "cancel", expectedTaskId: "task-a", expectedTaskRevision: 1 }))
      .toEqual({ action: "cancel", expectedTaskId: "task-a", expectedTaskRevision: 1 });
    expect(parseTaskControlArguments({ action: "inspect", expectedTaskId: "task-a", expectedTaskRevision: 1 }))
      .toEqual({ action: "inspect", expectedTaskId: "task-a", expectedTaskRevision: 1 });
    expect(parseTaskControlArguments({ action: "inspect" })).toEqual({ action: "inspect" });
    expect(parseTaskControlArguments({ action: "history", cursor: 4, limit: 16 })).toEqual({ action: "history", cursor: 4, limit: 16 });
    expect(() => parseTaskControlArguments({ action: "revise" })).toThrow(/requires expectedTaskId/);
    expect(() => parseTaskControlArguments({ action: "cancel" })).toThrow(/requires expectedTaskId/);
    expect(() => parseTaskControlArguments({ action: "revise", expectedTaskId: "task-a" })).toThrow(/supplied together/);
    expect(() => parseTaskControlArguments({ action: "start", expectedTaskId: "task-a", expectedTaskRevision: 1 }))
      .toThrow(/does not accept task selectors/);
    expect(() => parseTaskControlArguments({ action: "history", expectedTaskId: "task-a", expectedTaskRevision: 1 }))
      .toThrow(/does not accept task selectors/);
    expect(() => parseTaskControlArguments({ action: "inspect", expectedTaskId: "task-a", expectedTaskRevision: 0 }))
      .toThrow(/positive integer/);
    expect(() => parseTaskControlArguments({ action: "revise", expectedTaskId: "task-a", expectedTaskRevision: 1, cursor: 0 }))
      .toThrow(/only by the history action/);
    expect(() => parseTaskControlArguments({ action: "history", limit: 17 })).toThrow(/between 1 and 16/);
    expect(() => parseTaskControlArguments({ action: "history", cursor: -1 })).toThrow(/non-negative/);
    expect(() => parseTaskControlArguments({ action: "revise", taskId: "task-a", expectedTaskRevision: 1 }))
      .toThrow(/never accepts task authority/);
  });
});
