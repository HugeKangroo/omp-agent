import { describe, expect, test } from "bun:test";
import {
  TaskOwner,
  type TaskOwnerEvent,
  type TaskOwnerListenerFailure,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-b3a-unit-workspace";
const SESSION = "session-b3a-unit";
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

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function guard(owner: TaskOwner) {
  const task = owner.snapshot().currentTask;
  if (!task) throw new Error("test setup: no current task");
  return { taskId: task.taskId, taskRevision: task.taskRevision };
}

function observe(owner: TaskOwner, text: string, baseLeafId = "leaf-1") {
  owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId,
  });
}

function makeOwner(): {
  owner: TaskOwner;
  events: Array<Record<string, unknown> & { type: string }>;
  failures: TaskOwnerListenerFailure[];
} {
  const events: Array<Record<string, unknown> & { type: string }> = [];
  const failures: TaskOwnerListenerFailure[] = [];
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-b3a-listener",
    now: () => NOW,
    id: () => `id-${++sequence}`,
    onEvent: (event) => events.push(event),
    onListenerFailure: (failure) => failures.push(failure),
  });
  return { owner, events, failures };
}

function startTask(owner: TaskOwner): { taskId: string; branch: Entry[] } {
  const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
  observe(owner, "Please handle the managed task.");
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });
  const created = owner.start(subject(branch));
  return { taskId: created.task.taskId, branch };
}

describe("TaskOwner host-only event subscription", () => {
  test("subscribers receive committed immutable facts and unsubscribe stops later delivery", () => {
    const { owner } = makeOwner();
    const received: TaskOwnerEvent[] = [];
    const unsubscribe = owner.subscribe((event) => {
      received.push(event);
      if (event.type === "task_started") {
        // The owner has already committed this task before listener delivery.
        expect(owner.snapshot().currentTask?.taskId).toBe(event.taskId as string);
        expect(Object.isFrozen(event)).toBe(true);
        expect(() => {
          (event as { taskRevision?: unknown }).taskRevision = "mutated";
        }).toThrow();
        expect(owner.snapshot().currentTask?.taskRevision).toBe(1);
      }
    });
    const { taskId } = startTask(owner);
    expect(received.map((event) => event.type)).toContain("task_started");
    const started = received.find((event) => event.type === "task_started")!;
    expect(started).toMatchObject({
      type: "task_started",
      taskId,
      ownerId: owner.ownerId,
      messageId: "user-1",
      source: "rpc",
    });
    unsubscribe();
    const count = received.length;
    owner.inspect(subject([base(), user("user-1", "leaf-1", "Please handle the managed task.")]));
    expect(received.length).toBe(count);
  });

  test("synchronous listener throws are isolated with a visible diagnostic", () => {
    const { owner, events, failures } = makeOwner();
    const observed: string[] = [];
    owner.subscribe(() => {
      throw new Error("listener boom");
    });
    owner.subscribe((event) => {
      observed.push(event.type);
    });
    const { taskId, branch } = startTask(owner);

    expect(observed).toContain("task_started");
    expect(failures).toContainEqual({ mode: "sync", eventType: "task_started", error: "listener boom" });
    expect(events.filter((event) => event.type === "task_listener_failed" && event.eventType === "task_started")).toHaveLength(1);
    expect(owner.snapshot().currentTask?.taskId).toBe(taskId);

    // A committed cancellation is not rolled back by a throwing listener.
    owner.closeTurn({
      sessionId: SESSION,
      branch,
      messages: [{ ...(user("user-1", "leaf-1", "Please handle the managed task.").message as Record<string, unknown>), id: "user-1" }],
    });
    const taskBranch = [
      ...branch,
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Please cancel the managed task."),
    ];
    observe(owner, "Please cancel the managed task.", "assistant-1");
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });
    owner.cancel(subject(taskBranch), guard(owner));
    expect(owner.snapshot().currentTask?.status).toBe("cancelled");
    expect(observed).toContain("task_cancelled");
    expect(failures.filter((failure) => failure.eventType === "task_cancelled")).toHaveLength(1);
  });

  test("authoritative host callback errors propagate after subscribers observe committed cancellation", () => {
    const failures: TaskOwnerListenerFailure[] = [];
    let sequence = 0;
    const owner = new TaskOwner({
      workspaceRoot: WORKSPACE,
      ownerId: "owner-b3a-host-error",
      now: () => NOW,
      id: () => `id-${++sequence}`,
      onEvent: (event) => {
        if (event.type === "task_cancelled") throw new Error("host audit failed");
      },
      onListenerFailure: (failure) => failures.push(failure),
    });
    const seen: string[] = [];
    owner.subscribe((event) => {
      seen.push(event.type);
    });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner, "Please handle the managed task.");
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });
    owner.start(subject(branch));
    owner.closeTurn({
      sessionId: SESSION,
      branch,
      messages: [{ ...(user("user-1", "leaf-1", "Please handle the managed task.").message as Record<string, unknown>), id: "user-1" }],
    });
    const taskBranch = [
      ...branch,
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Please cancel the managed task."),
    ];
    observe(owner, "Please cancel the managed task.", "assistant-1");
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });

    expect(() => owner.cancel(subject(taskBranch), guard(owner))).toThrow("host audit failed");
    expect(seen).toContain("task_cancelled");
    expect(owner.snapshot().currentTask?.status).toBe("cancelled");
    // A host callback error is not an optional-listener failure.
    expect(failures).toHaveLength(0);
  });

  test("a host callback throwing undefined is still propagated after subscribers run", () => {
    let sequence = 0;
    const owner = new TaskOwner({
      workspaceRoot: WORKSPACE,
      ownerId: "owner-b3a-host-undefined",
      now: () => NOW,
      id: () => `id-${++sequence}`,
      onEvent: (event) => {
        if (event.type === "task_cancelled") throw undefined;
      },
    });
    const seen: string[] = [];
    owner.subscribe((event) => {
      seen.push(event.type);
    });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner, "Please handle the managed task.");
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });
    owner.start(subject(branch));
    owner.closeTurn({
      sessionId: SESSION,
      branch,
      messages: [{ ...(user("user-1", "leaf-1", "Please handle the managed task.").message as Record<string, unknown>), id: "user-1" }],
    });
    const taskBranch = [
      ...branch,
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Please cancel the managed task."),
    ];
    observe(owner, "Please cancel the managed task.", "assistant-1");
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });

    let caught = false;
    try {
      owner.cancel(subject(taskBranch), guard(owner));
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(seen).toContain("task_cancelled");
    expect(owner.snapshot().currentTask?.status).toBe("cancelled");
  });

  test("async listener rejection is isolated and other subscribers still run", async () => {
    const { owner, events, failures } = makeOwner();
    const observed: string[] = [];
    owner.subscribe(async () => {
      await Promise.resolve();
      throw new Error("async listener boom");
    });
    owner.subscribe((event) => {
      observed.push(event.type);
    });
    startTask(owner);
    await Bun.sleep(20);
    expect(observed).toContain("task_started");
    expect(failures).toContainEqual({ mode: "async", eventType: "task_started", error: "async listener boom" });
    expect(events.filter((event) => event.type === "task_listener_failed" && event.mode === "async" && event.eventType === "task_started")).toHaveLength(1);
  });

  test("each listener receives an independent frozen copy with no owner alias", () => {
    const { owner } = makeOwner();
    const copies: TaskOwnerEvent[] = [];
    const seen: number[] = [];
    owner.subscribe((event) => {
      if (event.type === "task_started") copies.push(event);
    });
    owner.subscribe((event) => {
      if (event.type === "task_started") {
        copies.push(event);
        seen.push(event.taskRevision as number);
      }
    });
    const { taskId } = startTask(owner);
    expect(seen).toEqual([1]);
    expect(copies).toHaveLength(2);
    expect(copies[0]).not.toBe(copies[1]);
    expect(Object.isFrozen(copies[0])).toBe(true);
    expect(Object.isFrozen(copies[1])).toBe(true);
    expect(owner.snapshot().currentTask?.taskId).toBe(taskId);
    expect(owner.snapshot().currentTask?.taskRevision).toBe(1);
  });
});
