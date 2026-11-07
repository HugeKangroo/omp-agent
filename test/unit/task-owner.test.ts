import { describe, expect, test } from "bun:test";
import {
  parseTaskControlArguments,
  TaskOwner,
  TaskOwnerError,
  type TaskOwnerSnapshot,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-b1-unit-workspace";
const SESSION = "session-b1-unit";
const NOW = "2026-11-08T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function user(id: string, parentId: string, text: string, attribution: unknown = "user", synthetic?: true): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      attribution,
      ...(synthetic === true ? { synthetic: true } : {}),
    },
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
    content: "BACKGROUND: start a new task",
    attribution: "agent",
  };
}

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function stamped(entry: Entry, timestamp: number): Entry {
  return { ...entry, message: { ...(entry.message as Record<string, unknown>), timestamp } };
}

function endOf(text: string, timestamp: number): Record<string, unknown> {
  return { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp };
}

function subject(branch: readonly unknown[], sessionId = SESSION): TaskSubject {
  return { sessionId, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function makeOwner(options: { capabilities?: string[] } = {}): {
  owner: TaskOwner;
  states: TaskOwnerSnapshot[];
  events: Array<Record<string, unknown> & { type: string }>;
} {
  const states: TaskOwnerSnapshot[] = [];
  const events: Array<Record<string, unknown> & { type: string }> = [];
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-b1-unit",
    ...(options.capabilities === undefined ? {} : { authorizedCapabilities: options.capabilities }),
    now: () => NOW,
    id: () => `id-${++sequence}`,
    onStateChange: (snapshot) => states.push(snapshot),
    onEvent: (event) => events.push(event),
  });
  return { owner, states, events };
}

function observe(owner: TaskOwner, input: Partial<Parameters<TaskOwner["observeInput"]>[0]> = {}) {
  return owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text: "Please handle the managed task.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
    ...input,
  });
}

function startFor(owner: TaskOwner, branch: readonly unknown[], understanding?: string, sessionId = SESSION) {
  const grant = owner.snapshot().activeGrant;
  if (!grant) throw new Error("test setup: no active grant");
  owner.observeAgentStart({
    sessionId: grant.sessionId,
    prompt: grant.text,
    reason: "prompt",
  });
  return owner.start(subject(branch, sessionId), understanding);
}

describe("conversational task ownership", () => {
  test("start uses the host-observed request, source, session and branch anchor", () => {
    const { owner, states } = makeOwner();
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    expect(observe(owner).accepted).toBe(true);
    const result = startFor(owner, branch, "model thinks this is about a widget");

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({
      schemaVersion: 1,
      taskId: "task-id-1",
      ownerId: "owner-b1-unit",
      taskRevision: 1,
      status: "active",
      rawRequest: "Please handle the managed task.",
      understanding: "model thinks this is about a widget",
      admissions: 0,
      cancelledAt: null,
    });
    expect(result.task.anchor).toEqual({
      sessionId: SESSION,
      messageId: "user-1",
      source: "rpc",
      observedText: "Please handle the managed task.",
      anchorText: "Please handle the managed task.",
      observedAt: NOW,
    });
    expect(owner.snapshot()).toMatchObject({ tasksCreated: 1 });
    expect(states.at(-1)?.currentTask?.taskId).toBe("task-id-1");
    expect(states.at(-1)?.activeGrant?.source).toBe("rpc");
    expect(states.at(-1)?.activeGrant?.sessionId).toBe(SESSION);
  });

  test("duplicate and concurrent starts for one host message return the same task", async () => {
    const { owner, states } = makeOwner();
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => owner.start(subject(branch), "first")),
      Promise.resolve().then(() => owner.start(subject(branch), "second")),
    ]);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.task.taskId).toBe(second.task.taskId);
    expect(owner.snapshot().tasksCreated).toBe(1);
    expect(new Set(states.flatMap((state) => state.currentTask ? [state.currentTask.taskId] : [])).size).toBe(1);
  });

  test("identical text in a different real user message is rejected, not merged", () => {
    const { owner } = makeOwner();
    const firstBranch = [base(), user("user-1", "leaf-1", "Same words.")];
    observe(owner, { text: "Same words." });
    const first = startFor(owner, firstBranch);
    expect(first.created).toBe(true);
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [messageOf(user("user-1", "leaf-1", "Same words."))] })).toBe(true);

    const secondBranch = [
      base(),
      user("user-1", "leaf-1", "Same words."),
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Same words."),
    ];
    expect(observe(owner, { text: "Same words.", baseLeafId: "assistant-1" }).accepted).toBe(true);
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Same words.", reason: "prompt" });
    expect(() => owner.start(subject(secondBranch))).toThrow(/different user message/);
    expect(owner.snapshot().tasksCreated).toBe(1);
    expect(owner.snapshot().currentTask?.anchor.messageId).toBe("user-1");
  });

  test("model-supplied identity, source, anchor, permission and budget fields are rejected", () => {
    for (const key of [
      "taskId", "taskRevision", "ownerId", "runId", "attemptId", "executionEpoch",
      "source", "messageId", "anchorId", "rawRequest", "permissions", "budget", "sessionId", "goal",
    ]) {
      expect(() => parseTaskControlArguments({ action: "start", [key]: "attacker" })).toThrow(TaskOwnerError);
    }
    expect(() => parseTaskControlArguments({ action: "inspect", understanding: "irrelevant" })).toThrow(/only when starting/);
    expect(() => parseTaskControlArguments({ action: "destroy" })).toThrow(/action must be/);
    expect(parseTaskControlArguments({ action: "start", understanding: "  separate understanding  " }))
      .toEqual({ action: "start", understanding: "separate understanding" });
  });

  test("a background start before any task has no fresh grant and creates nothing", () => {
    const { owner } = makeOwner();
    const chatBranch = [base(), user("user-1", "leaf-1", "Just chatting.")];
    observe(owner, { text: "Just chatting." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Just chatting.", reason: "prompt" });
    expect(owner.closeTurn({ sessionId: SESSION, branch: chatBranch, messages: [messageOf(user("user-1", "leaf-1", "Just chatting."))] })).toBe(true);

    const backgroundBranch = [
      base(),
      user("user-1", "leaf-1", "Just chatting."),
      assistant("assistant-1", "user-1"),
      background("background-1", "assistant-1"),
    ];
    expect(() => owner.start(subject(backgroundBranch))).toThrow(/No live genuine user turn/);
    expect(owner.snapshot().tasksCreated).toBe(0);
    expect(owner.snapshot().currentTask).toBeNull();
  });

  test("background progress uses the authorized admission port without creating another task", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    const created = startFor(owner, branch);
    const backgroundBranch = [...branch, assistant("assistant-1", "user-1"), background("background-1", "assistant-1")];
    expect(owner.closeTurn({ sessionId: SESSION, branch, messages: [messageOf(user("user-1", "leaf-1", "Please handle the managed task."))] })).toBe(true);

    const first = owner.admit(subject(backgroundBranch), "test-progress", 1);
    expect(first).toMatchObject({
      allowed: true,
      taskId: created.task.taskId,
      ownerId: created.task.ownerId,
      taskRevision: 1,
      anchorMessageId: "user-1",
      capabilityId: "test-progress",
      actionIndex: 1,
      status: "active",
    });
    const second = owner.admit(subject(backgroundBranch), "test-progress", 1);
    expect(second.actionIndex).toBe(2);
    expect(owner.snapshot().tasksCreated).toBe(1);
    expect(owner.snapshot().currentTask?.admissions).toBe(2);
    expect(owner.snapshot().currentTask?.taskRevision).toBe(1);

    const unauthorized = owner.admit(subject(backgroundBranch), "not-registered", 1);
    expect(unauthorized).toMatchObject({ allowed: false, reason: "capability is not authorized by the host", actionIndex: null });
    expect(owner.snapshot().currentTask?.admissions).toBe(2);
  });

  test("cancellation is rechecked at the actual capability entry and keeps taskRevision", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    const created = startFor(owner, branch);
    expect(created.task.taskRevision).toBe(1);
    const cancelled = owner.cancel(subject(branch));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.taskRevision).toBe(1);
    expect(cancelled.cancelledAt).toBe(NOW);
    expect(owner.cancel(subject(branch)).status).toBe("cancelled");

    const denied = owner.admit(subject(branch), "test-progress", 1);
    expect(denied).toMatchObject({ allowed: false, reason: "task is cancelled", status: "cancelled", actionIndex: null });
    expect(owner.snapshot().currentTask?.admissions).toBe(0);
    expect(owner.snapshot().currentTask?.taskRevision).toBe(1);
  });

  test("inspection is read-only; cross-session and anchor-less branches are rejected", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    const created = startFor(owner, branch);
    const backgroundBranch = [...branch, assistant("assistant-1", "user-1"), background("background-1", "assistant-1")];
    expect(owner.inspect(subject(backgroundBranch))).toMatchObject({ taskId: created.task.taskId, taskRevision: 1 });
    expect(owner.snapshot().currentTask?.admissions).toBe(0);

    expect(() => owner.inspect(subject(backgroundBranch, "other-session"))).toThrow(/different OMP session/);
    const unrelatedBranch = [base("leaf-9"), user("user-9", "leaf-9", "Unrelated.")];
    expect(() => owner.inspect(subject(unrelatedBranch))).toThrow(/anchor is not in the current conversation branch/);
    expect(owner.admit(subject(unrelatedBranch), "test-progress", 1)).toMatchObject({
      allowed: false,
      reason: "Task anchor is not in the current conversation branch; B1 will not assume execution rights.",
    });
  });

  test("a stale agent_end cannot revoke an unrelated newer grant", () => {
    const { owner } = makeOwner();
    const firstBranch = [base(), user("user-1", "leaf-1", "First request.")];
    observe(owner, { text: "First request." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "First request.", reason: "prompt" });
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [messageOf(user("user-1", "leaf-1", "First request."))] })).toBe(true);

    const secondBranch = [
      base(),
      user("user-1", "leaf-1", "First request."),
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Second request."),
    ];
    observe(owner, { text: "Second request.", baseLeafId: "assistant-1" });
    expect(owner.snapshot().activeGrant?.text).toBe("Second request.");

    // A delayed end from the first turn has the old run user and old branch.
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [messageOf(user("user-1", "leaf-1", "First request."))] })).toBe(false);
    expect(owner.closeTurn({ sessionId: SESSION, branch: secondBranch, messages: [messageOf(user("user-1", "leaf-1", "First request."))] })).toBe(false);
    expect(owner.snapshot().activeGrant?.text).toBe("Second request.");

    owner.observeAgentStart({ sessionId: SESSION, prompt: "Second request.", reason: "prompt" });
    const result = owner.start(subject(secondBranch));
    expect(result.created).toBe(true);
    expect(result.task.rawRequest).toBe("Second request.");
    expect(result.task.anchor.messageId).toBe("user-2");
  });

  test("overlapping genuine turns are conservatively rejected, then a session change resets turn state", () => {
    const { owner } = makeOwner();
    const firstBranch = [base(), user("user-1", "leaf-1", "First request.")];
    expect(observe(owner, { text: "First request." }).accepted).toBe(true);
    owner.observeAgentStart({ sessionId: SESSION, prompt: "First request.", reason: "prompt" });
    const overlap = observe(owner, { text: "Steering request." });
    expect(overlap.accepted).toBe(false);
    expect(overlap.reason).toBe("unsupported overlapping user turns");
    expect(owner.snapshot().suspended?.reason).toBe("unsupported overlapping user turns");
    expect(owner.snapshot().activeGrant).toBeNull();
    owner.observeAgentStart({ sessionId: SESSION, prompt: "First request.", reason: "prompt" });
    expect(() => owner.start(subject(firstBranch))).toThrow(/Task start is unavailable/);
    expect(owner.snapshot().tasksCreated).toBe(0);

    owner.sessionChanged("session-b1-next");
    expect(owner.snapshot().suspended).toBeNull();
    expect(observe(owner, { sessionId: "session-b1-next", text: "Fresh request.", baseLeafId: "leaf-2" }).accepted).toBe(true);
  });

  test("a never-started unresolved observation is superseded, and its replay stays closed", () => {
    const { owner, events } = makeOwner();
    const commandText = "/b1noop no agent will start";
    const request = "Please handle the managed task.";
    expect(observe(owner, { text: commandText }).accepted).toBe(true);
    expect(owner.snapshot().activeGrant).toMatchObject({
      text: commandText,
      started: false,
      anchorMessageId: null,
    });
    expect(observe(owner, { text: request }).accepted).toBe(true);
    expect(owner.snapshot().suspended).toBeNull();
    expect(owner.snapshot().activeGrant).toMatchObject({
      text: request,
      started: false,
      anchorMessageId: null,
    });
    expect(owner.snapshot().activeGrant?.turnId).not.toBe(1);
    const superseded = events.find((event) => event.type === "task_observation_superseded");
    expect(superseded).toMatchObject({
      previousTurnId: 1,
      previousSessionId: SESSION,
      previousBaseLeafId: "leaf-1",
      previousTextLength: commandText.length,
    });
    expect(events.filter((event) => event.type === "task_observation_superseded")).toHaveLength(1);

    // The superseded observation is closed for anti-replay, not merely forgotten.
    expect(observe(owner, { text: commandText })).toMatchObject({
      accepted: false,
      duplicate: true,
      reason: "the observed user turn is already closed",
    });
    const branch = [base(), user("user-1", "leaf-1", request)];
    owner.observeAgentStart({ sessionId: SESSION, prompt: request, reason: "prompt" });
    expect(owner.start(subject(branch)).created).toBe(true);
    expect(owner.snapshot().currentTask?.rawRequest).toBe(request);
  });

  test("navigation without a managed task clears observation without creating a detached binding", () => {
    const NEXT = "session-b1-next";
    const request = "请创建并管理发布检查清单任务。";

    const startFirstTask = (owner: TaskOwner, sessionId: string): void => {
      expect(observe(owner, { sessionId, text: request, baseLeafId: "leaf-2" }).accepted).toBe(true);
      expect(owner.observeAgentStart({ sessionId, prompt: request, reason: "prompt" })).toBe(true);
      const branch = [base("leaf-2"), user("user-2", "leaf-2", request)];
      expect(owner.start(subject(branch, sessionId)).created).toBe(true);
      expect(owner.snapshot().tasksCreated).toBe(1);
      expect(owner.snapshot().currentTask?.anchor).toMatchObject({ sessionId, messageId: "user-2" });
      expect(owner.bindingStatus()).toMatchObject({ state: "attached", reason: null, event: null });
    };

    for (const event of ["session_start", "session_switch", "session_tree"] as const) {
      const { owner, events } = makeOwner();
      expect(observe(owner, { text: "/b1noop pending local command" }).accepted).toBe(true);
      if (event === "session_start") owner.sessionStarted(NEXT);
      else owner.navigate(event, NEXT);
      expect(owner.snapshot().activeGrant).toBeNull();
      expect(owner.snapshot().suspended).toBeNull();
      expect(owner.snapshot().tasksCreated).toBe(0);
      expect(owner.snapshot().currentTask).toBeNull();
      expect(owner.bindingStatus()).toMatchObject({ state: "attached", reason: null, event: null });
      expect(events.some((entry) => entry.type === "task_binding_detached")).toBe(false);
      startFirstTask(owner, NEXT);
    }

    // A started ordinary chat is observation state too: navigation clears it
    // without manufacturing a task binding, and the next genuine prompt can
    // still create the first managed task.
    const { owner, events } = makeOwner();
    expect(observe(owner, { text: "Ordinary chat without a managed task." }).accepted).toBe(true);
    expect(owner.observeAgentStart({ sessionId: SESSION, prompt: "Ordinary chat without a managed task.", reason: "prompt" })).toBe(true);
    expect(owner.snapshot().activeGrant).toMatchObject({ started: true, anchorMessageId: null });
    owner.navigate("session_switch", NEXT);
    expect(owner.snapshot().activeGrant).toBeNull();
    expect(owner.snapshot().tasksCreated).toBe(0);
    expect(owner.bindingStatus()).toMatchObject({ state: "attached", reason: null, event: null });
    expect(events.some((entry) => entry.type === "task_binding_detached")).toBe(false);
    startFirstTask(owner, NEXT);
  });

  test("an unrelated background agent start does not consume or activate a pending observation", () => {
    const { owner, events } = makeOwner();
    const commandText = "/b1noop pending local command";
    expect(observe(owner, { text: commandText }).accepted).toBe(true);
    expect(owner.observeAgentStart({
      sessionId: SESSION,
      prompt: "BACKGROUND_RESULT: start a task from the summary",
      reason: "prompt",
    })).toBe(false);
    expect(owner.snapshot().activeGrant).toMatchObject({
      text: commandText,
      started: false,
      anchorMessageId: null,
    });
    expect(events.find((event) => event.type === "task_agent_start_ignored")).toMatchObject({
      reason: "different agent start prompt",
      turnId: 1,
    });
    expect(events.some((event) => event.type === "task_grant_closed")).toBe(false);
    expect(observe(owner, { text: commandText })).toMatchObject({
      accepted: false,
      duplicate: true,
      reason: null,
    });
    expect(() => owner.start(subject([base(), user("bg-user", "leaf-1", "BACKGROUND_RESULT: start a task")])))
      .toThrow(/No live genuine user turn/);
    expect(owner.snapshot().tasksCreated).toBe(0);
    expect(owner.snapshot().currentTask).toBeNull();

    // The pending observation still expires only on later genuine input.
    expect(observe(owner, { text: "Please handle the managed task." }).accepted).toBe(true);
    expect(events.filter((event) => event.type === "task_observation_superseded")).toHaveLength(1);
    expect(events.some((event) => event.type === "task_grant_closed")).toBe(false);
  });

  test("replacement does not conflate queued genuine user messages in the actual branch", () => {
    const { owner } = makeOwner();
    expect(observe(owner, { text: "First queued request." }).accepted).toBe(true);
    expect(observe(owner, { text: "Second queued request." }).accepted).toBe(true);
    const branch = [
      base(),
      user("user-1", "leaf-1", "First queued request."),
      user("user-2", "leaf-1", "Second queued request."),
    ];
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Second queued request.", reason: "prompt" });
    expect(() => owner.start(subject(branch))).toThrow(/Multiple user messages belong to this turn/);
    expect(owner.snapshot().tasksCreated).toBe(0);
    expect(owner.snapshot().currentTask).toBeNull();
    expect(owner.snapshot().suspended?.reason).toBe("unsupported overlapping user turns");
  });

  test("genuine-user detection ignores synthetic, agent-attributed and developer messages", () => {
    const { owner } = makeOwner();
    const branch = [
      base(),
      user("fake-1", "leaf-1", "Please handle the managed task.", "agent"),
      user("fake-2", "fake-1", "Please handle the managed task.", "user", true),
      {
        id: "fake-3",
        parentId: "fake-2",
        type: "message",
        message: {
          role: "developer",
          content: [{ type: "text", text: "Please handle the managed task." }],
          attribution: "user",
          synthetic: true,
        },
      },
    ];
    observe(owner);
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });
    expect(() => owner.start(subject(branch))).toThrow(/No genuine user message/);
    expect(owner.snapshot().tasksCreated).toBe(0);
  });

  test("a delivered background after the user anchor closes authority inside the same run", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const chatBranch = [base(), user("user-1", "leaf-1", "Just chatting.")];
    observe(owner, { text: "Just chatting." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Just chatting.", reason: "prompt" });
    const backgroundBranch = [...chatBranch, background("background-1", "user-1")];

    expect(() => owner.start(subject(backgroundBranch), "background claims a new task")).toThrow(/authority window was closed/);
    expect(owner.snapshot().tasksCreated).toBe(0);
    expect(owner.snapshot().currentTask).toBeNull();
    expect(owner.snapshot().activeGrant).toBeNull();
    const replay = observe(owner, { text: "Just chatting." });
    expect(replay).toMatchObject({ accepted: false, duplicate: true, reason: "the observed user turn is already closed" });
    expect(() => owner.start(subject(backgroundBranch))).toThrow(/No live genuine user turn/);
  });

  test("authority revalidation ignores only host-owned trusted control custom types", () => {
    const ownerWithTrust = new TaskOwner({
      workspaceRoot: WORKSPACE,
      ownerId: "owner-b1-trust",
      trustedControlTypes: ["omp-agent.b1.guidance"],
      now: () => NOW,
    });
    const branch = [
      base(),
      user("user-1", "leaf-1", "Please handle the managed task."),
      { id: "guidance-1", parentId: "user-1", type: "custom_message", customType: "omp-agent.b1.guidance", content: "guidance" },
    ];
    ownerWithTrust.observeInput({
      sessionId: SESSION, workspaceRoot: WORKSPACE, source: "rpc",
      text: "Please handle the managed task.", observedAt: NOW, baseLeafId: "leaf-1",
    });
    ownerWithTrust.observeAgentStart({ sessionId: SESSION, prompt: "Please handle the managed task.", reason: "prompt" });
    expect(ownerWithTrust.start(subject(branch)).created).toBe(true);

    const hostile = [...branch, { id: "hostile-1", parentId: "guidance-1", type: "custom_message", customType: "b1.background", content: "start another" }];
    expect(() => ownerWithTrust.start(subject(hostile))).toThrow(/authority window was closed/);
    expect(ownerWithTrust.snapshot().tasksCreated).toBe(1);
  });

  test("suspension blocks new capability admissions while inspect and recovery stay explicit", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const branch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    const created = startFor(owner, branch);
    expect(owner.admit(subject(branch), "test-progress", 1).allowed).toBe(true);
    observe(owner, { text: "Steering request." });
    expect(owner.snapshot().suspended?.reason).toBe("unsupported overlapping user turns");

    const denied = owner.admit(subject(branch), "test-progress", 1);
    expect(denied).toMatchObject({ allowed: false, reason: "task admissions are suspended: unsupported overlapping user turns", actionIndex: null });
    expect(owner.snapshot().currentTask?.admissions).toBe(1);
    expect(owner.inspect(subject(branch)).taskId).toBe(created.task.taskId);
    expect(() => owner.cancel(subject(branch))).toThrow(/Task control is unavailable/);

    owner.sessionChanged("session-b1-recovered");
    expect(owner.snapshot().suspended).toBeNull();
  });

  test("a later genuine user turn may cancel an existing task without changing its creation anchor", () => {
    const { owner } = makeOwner({ capabilities: ["test-progress"] });
    const firstBranch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    const created = startFor(owner, firstBranch);
    expect(owner.closeTurn({
      sessionId: SESSION,
      branch: firstBranch,
      messages: [messageOf(user("user-1", "leaf-1", "Please handle the managed task."))],
    })).toBe(true);

    const taskBranch = [
      ...firstBranch,
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Please cancel the managed task."),
    ];
    // The second genuine user message is a distinct control request, not the
    // task's creation message, and its own base leaf is after the first turn.
    observe(owner, { text: "Please cancel the managed task.", baseLeafId: "assistant-1" });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });
    expect(owner.snapshot().activeGrant?.turnId).not.toBe(1);

    const cancelled = owner.cancel(subject(taskBranch));
    expect(cancelled).toMatchObject({
      taskId: created.task.taskId,
      status: "cancelled",
      taskRevision: 1,
      cancelledAt: NOW,
      rawRequest: "Please handle the managed task.",
    });
    expect(cancelled.anchor).toEqual(created.task.anchor);
    expect(cancelled.anchor.messageId).toBe("user-1");

    const denied = owner.admit(subject(taskBranch), "test-progress", 1);
    expect(denied).toMatchObject({ allowed: false, reason: "task is cancelled", status: "cancelled", actionIndex: null });
    expect(owner.snapshot().currentTask?.admissions).toBe(0);
    expect(owner.snapshot().currentTask?.taskRevision).toBe(1);
  });

  test("cancel refuses a live grant whose genuine anchor is missing from the branch", () => {
    const { owner } = makeOwner();
    const firstBranch = [base(), user("user-1", "leaf-1", "Please handle the managed task.")];
    observe(owner);
    startFor(owner, firstBranch);
    expect(owner.closeTurn({
      sessionId: SESSION,
      branch: firstBranch,
      messages: [messageOf(user("user-1", "leaf-1", "Please handle the managed task."))],
    })).toBe(true);

    observe(owner, { text: "Please cancel the managed task.", baseLeafId: "assistant-1" });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });
    // The current grant's base leaf is absent from this branch; only the task's old anchor is.
    expect(() => owner.cancel(subject(firstBranch)))
      .toThrow(/anchor is not present|does not match the host-observed input/);
    expect(owner.snapshot().currentTask?.status).toBe("active");
  });

  test("agent_end without host message identity cannot close a newer same-text grant", () => {
    const { owner } = makeOwner();
    const firstBranch = [base(), user("user-1", "leaf-1", "Same words.")];
    observe(owner, { text: "Same words." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Same words.", reason: "prompt" });
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [messageOf(user("user-1", "leaf-1", "Same words."))] })).toBe(true);

    const secondBranch = [
      base(),
      user("user-1", "leaf-1", "Same words."),
      assistant("assistant-1", "user-1"),
      user("user-2", "assistant-1", "Same words."),
    ];
    observe(owner, { text: "Same words.", baseLeafId: "assistant-1" });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Same words.", reason: "prompt" });

    expect(owner.closeTurn({
      sessionId: SESSION,
      branch: secondBranch,
      messages: [messageOf(user("user-1", "leaf-1", "Same words."))],
    })).toBe(false);
    expect(owner.closeTurn({ sessionId: SESSION, branch: secondBranch, messages: [{ role: "user", content: "Same words.", attribution: "user" }] })).toBe(false);
    expect(owner.snapshot().activeGrant?.text).toBe("Same words.");
    expect(owner.start(subject(secondBranch)).task.anchor.messageId).toBe("user-2");
  });

  test("an ambiguous timestamp cannot let an old same-text end close a newer grant", () => {
    const { owner } = makeOwner();
    const T = 1_760_000_000_000;
    const firstBranch = [base(), stamped(user("user-1", "leaf-1", "Same words."), T)];
    observe(owner, { text: "Same words." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Same words.", reason: "prompt" });
    // Normal completion: the host timestamp uniquely identifies this anchor.
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [endOf("Same words.", T)] })).toBe(true);

    const secondBranch = [
      base(),
      stamped(user("user-1", "leaf-1", "Same words."), T),
      assistant("assistant-1", "user-1"),
      stamped(user("user-2", "assistant-1", "Same words."), T),
    ];
    observe(owner, { text: "Same words.", baseLeafId: "assistant-1" });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Same words.", reason: "prompt" });

    // Delayed end from the first turn: no host id, same text, same millisecond
    // timestamp as both genuine user entries in the branch.
    expect(owner.closeTurn({ sessionId: SESSION, branch: secondBranch, messages: [endOf("Same words.", T)] })).toBe(false);
    expect(owner.snapshot().activeGrant?.text).toBe("Same words.");
    expect(owner.start(subject(secondBranch)).task.anchor.messageId).toBe("user-2");
  });

  test("a distinct older timestamp cannot close the current turn, while the current timestamp can", () => {
    const { owner } = makeOwner();
    const T1 = 1_760_000_000_000;
    const T2 = T1 + 1;
    const firstBranch = [base(), stamped(user("user-1", "leaf-1", "First request."), T1)];
    observe(owner, { text: "First request." });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "First request.", reason: "prompt" });
    expect(owner.closeTurn({ sessionId: SESSION, branch: firstBranch, messages: [endOf("First request.", T1)] })).toBe(true);

    const secondBranch = [
      base(),
      stamped(user("user-1", "leaf-1", "First request."), T1),
      assistant("assistant-1", "user-1"),
      stamped(user("user-2", "assistant-1", "Second request."), T2),
    ];
    observe(owner, { text: "Second request.", baseLeafId: "assistant-1" });
    owner.observeAgentStart({ sessionId: SESSION, prompt: "Second request.", reason: "prompt" });

    expect(owner.closeTurn({ sessionId: SESSION, branch: secondBranch, messages: [endOf("First request.", T1)] })).toBe(false);
    expect(owner.snapshot().activeGrant?.text).toBe("Second request.");
    expect(owner.closeTurn({ sessionId: SESSION, branch: secondBranch, messages: [endOf("Second request.", T2)] })).toBe(true);
    expect(owner.snapshot().activeGrant).toBeNull();
  });
});
