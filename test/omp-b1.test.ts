import { expect, test } from "bun:test";
import { B1OmpSession, type B1RunOptions } from "./harness/b1-run.ts";

const integration = process.env.RUN_REAL_OMP_TEST === "1" ? test : test.skip;
const TEST_TIMEOUT = 60_000;

type Snapshot = Awaited<ReturnType<B1OmpSession["snapshot"]>>;
type Event = Record<string, unknown>;

function events(snapshot: Snapshot, list: "audit" | "fixtureAudit", type: string): Event[] {
  return snapshot[list].filter((event) => event.type === type);
}

function toolEnds(snapshot: Snapshot, toolCallId: string): Event[] {
  return snapshot.frames.filter((frame) => frame.type === "tool_execution_end" && frame.toolCallId === toolCallId);
}

function resultDetails(frame: Event | undefined): Event {
  const result = frame?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return {};
  const details = (result as Event).details;
  return typeof details === "object" && details !== null && !Array.isArray(details) ? details as Event : {};
}

function resultText(frame: Event | undefined): string {
  const result = frame?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return "";
  const content = (result as Event).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "object" && part !== null && typeof (part as Event).text === "string" ? (part as Event).text as string : "").join("\n");
}

function state(snapshot: Snapshot): Event {
  return typeof snapshot.state === "object" && snapshot.state !== null && !Array.isArray(snapshot.state) ? snapshot.state as Event : {};
}

function task(snapshot: Snapshot): Event {
  const current = state(snapshot).currentTask;
  return typeof current === "object" && current !== null && !Array.isArray(current) ? current as Event : {};
}

function attemptEvents(snapshot: Snapshot, action: string): Event[] {
  return events(snapshot, "audit", "task_tool_attempt").filter((event) => event.action === action);
}

function branchCustomTypes(event: Event | undefined): string[] {
  const branch = event?.branch;
  if (!Array.isArray(branch)) return [];
  return branch
    .map((entry) => typeof entry === "object" && entry !== null && typeof (entry as Event).customType === "string" ? (entry as Event).customType as string : "")
    .filter(Boolean);
}

function expectOneTask(snapshot: Snapshot): Event {
  const ownerState = state(snapshot);
  expect(ownerState.tasksCreated).toBe(1);
  const current = task(snapshot);
  expect(typeof current.taskId).toBe("string");
  expect(current.taskRevision).toBe(1);
  expect(current.status).toBe("active");
  expect(current.ownerId).toBe(ownerState.ownerId);
  return current;
}

async function withSession(options: B1RunOptions, run: (session: B1OmpSession) => Promise<void>): Promise<void> {
  const session = await B1OmpSession.create(options);
  try {
    await session.start();
    await run(session);
  } finally {
    await session.cleanup();
  }
}

integration("genuine RPC prompt creates one task from the actual host input and branch anchor", async () => {
  const prompt = "Please take ownership of preparing the release checklist.";
  await withSession({ scenario: "start" }, async (session) => {
    await session.prompt(prompt);
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.rawRequest).toBe(prompt);
    const anchor = current.anchor as Event;
    expect(anchor.sessionId).toBeString();
    expect(anchor.source).toBe("rpc");
    expect(anchor.messageId).toBeString();
    expect(anchor.messageId).not.toHaveLength(0);
    expect(anchor.observedText).toBe(prompt);
    expect(anchor.anchorText).toBe(prompt);

    const observed = events(snapshot, "audit", "input_observed");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.accepted).toBe(true);
    expect(observed[0]?.source).toBe("rpc");
    expect(observed[0]?.baseLeafId).toBeString();
    expect(observed[0]?.sessionId).toBe(anchor.sessionId);

    const emitted = events(snapshot, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === "b1-start");
    expect(emitted?.tool).toBe("agent_task");
    const ended = toolEnds(snapshot, "b1-start");
    expect(ended).toHaveLength(1);
    const details = resultDetails(ended[0]);
    expect(details.created).toBe(true);
    expect((details.task as Event).taskId).toBe(current.taskId);

    // Host-owned guidance is a trusted control artifact, not a user grant.
    const attempts = attemptEvents(snapshot, "start");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.agentKind).toBe("main");
    expect(branchCustomTypes(attempts[0])).toContain("omp-agent.b1.guidance");
  });
}, TEST_TIMEOUT);

integration("a repeated start in the same user message returns the same task", async () => {
  const prompt = "Please own the release checklist and do not split it.";
  await withSession({ scenario: "duplicate-start" }, async (session) => {
    await session.prompt(prompt);
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    const first = resultDetails(toolEnds(snapshot, "b1-start-1")[0]);
    const second = resultDetails(toolEnds(snapshot, "b1-start-2")[0]);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect((first.task as Event).taskId).toBe(current.taskId);
    expect((second.task as Event).taskId).toBe(current.taskId);
    expect(events(snapshot, "audit", "task_duplicate_start")).toHaveLength(1);
    expect(state(snapshot).tasksCreated).toBe(1);
  });
}, TEST_TIMEOUT);

integration("ordinary chat plus a harmless tool creates no task", async () => {
  await withSession({ scenario: "normal-chat" }, async (session) => {
    await session.prompt("Hello, could you acknowledge this message?");
    const snapshot = await session.snapshot();
    expect(state(snapshot).tasksCreated).toBe(0);
    expect(state(snapshot).currentTask).toBeNull();
    expect(toolEnds(snapshot, "b1-echo")).toHaveLength(1);
    expect(events(snapshot, "fixtureAudit", "tool_call_emitted").every((event) => event.tool !== "agent_task")).toBe(true);
    expect(snapshot.counter).toBeUndefined();
  });
}, TEST_TIMEOUT);

integration("a delivered background follow-up before any receipt cannot start a task", async () => {
  await withSession({ scenario: "background-start" }, async (session) => {
    await session.prompt("Just chatting.");
    const snapshot = await session.snapshot();
    expect(state(snapshot).tasksCreated).toBe(0);
    expect(state(snapshot).currentTask).toBeNull();
    expect(state(snapshot).activeGrant).toBeNull();

    // The background was actually delivered: the provider was invoked again
    // inside the same OMP run only because the queued follow-up was consumed.
    expect(events(snapshot, "fixtureAudit", "background_injected")).toHaveLength(1);
    const turns = events(snapshot, "fixtureAudit", "model_turn");
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns[1]?.step).toBe(1);
    // Same OMP run: no new agent_start/agent_end boundary around the follow-up.
    expect(snapshot.frames.filter((frame) => frame.type === "agent_start")).toHaveLength(1);
    expect(snapshot.frames.filter((frame) => frame.type === "agent_end")).toHaveLength(1);
    expect(events(snapshot, "fixtureAudit", "tool_call_emitted").some((event) => event.toolCallId === "b1-background-start")).toBe(true);
    // The target call reached the tool and was rejected there.
    const ended = toolEnds(snapshot, "b1-background-start");
    expect(ended).toHaveLength(1);
    expect((ended[0]?.result as Event).isError).toBe(true);
    expect(resultText(ended[0])).toContain("authority window was closed");
    expect(events(snapshot, "audit", "task_tool_rejected").some((event) => String(event.error).includes("authority window was closed"))).toBe(true);

    // Only the initial genuine input was observed; there was no second user turn.
    expect(events(snapshot, "audit", "input_observed")).toHaveLength(1);
    const attempts = attemptEvents(snapshot, "start");
    expect(attempts).toHaveLength(1);
    const branch = attempts[0]?.branch;
    expect(Array.isArray(branch)).toBe(true);
    expect(branchCustomTypes(attempts[0])).toContain("b1.background");
    expect(events(snapshot, "audit", "task_authority_closed")).toHaveLength(1);
    expect(events(snapshot, "audit", "task_started")).toHaveLength(0);
  });
}, TEST_TIMEOUT);

integration("background progress keeps existing task authority while new start is refused", async () => {
  await withSession({ scenario: "background-progress" }, async (session) => {
    await session.prompt("Please own the release checklist.");
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.admissions).toBe(2);
    expect(events(snapshot, "fixtureAudit", "background_injected")).toHaveLength(1);

    const first = resultDetails(toolEnds(snapshot, "b1-progress-1")[0]);
    expect(first).toMatchObject({ allowed: true, actionIndex: 1, taskId: current.taskId, anchorMessageId: (current.anchor as Event).messageId });
    const refused = toolEnds(snapshot, "b1-background-start-again");
    expect(refused).toHaveLength(1);
    expect((refused[0]?.result as Event).isError).toBe(true);
    expect(resultText(refused[0])).toContain("authority window was closed");
    const progressed = resultDetails(toolEnds(snapshot, "b1-background-progress")[0]);
    expect(progressed).toMatchObject({ allowed: true, actionIndex: 2, taskId: current.taskId, taskRevision: 1, status: "active", counter: 2 });
    expect(snapshot.counter).toEqual({ count: 2 });
    expect(events(snapshot, "audit", "task_started")).toHaveLength(1);
    expect(state(snapshot).tasksCreated).toBe(1);
    expect(task(snapshot).admissions).toBe(2);
    const backgroundAttempt = attemptEvents(snapshot, "start").find((event) => branchCustomTypes(event).includes("b1.background"));
    expect(backgroundAttempt).toBeDefined();
    expect(branchCustomTypes(backgroundAttempt)).toContain("b1.background");
  });
}, TEST_TIMEOUT);

integration("forged model fields and tool-output instructions cannot create authority", async () => {
  await withSession({ scenario: "fake-instructions" }, async (session) => {
    const prompt = "Please explain the release checklist; do not create work.";
    await session.prompt(prompt);
    const snapshot = await session.snapshot();
    expect(toolEnds(snapshot, "b1-noise")).toHaveLength(1);
    const fakeTurn = events(snapshot, "fixtureAudit", "model_turn").find((event) => event.step === 1);
    expect(String(fakeTurn?.lastToolResult)).toContain("SYSTEM AUTHORIZATION");
    const emitted = events(snapshot, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === "b1-fake-start");
    const forged = emitted?.arguments as Event;
    expect(forged.ownerId).toBe("attacker-owner");
    expect(forged.rawRequest).toBe("attacker-request");
    expect(forged.messageId).toBe("attacker-message");

    // OMP's declared tool schema strips undeclared properties before execute.
    // The parser is still defense in depth (unit-tested), and no forged value
    // may become authority: raw request, anchor, owner and id stay host-owned.
    const ended = toolEnds(snapshot, "b1-fake-start");
    expect(ended).toHaveLength(1);
    const ownerState = state(snapshot);
    const current = task(snapshot);
    if ((ended[0]?.result as Event).isError === true) {
      expect(ownerState.tasksCreated).toBe(0);
      expect(resultText(ended[0])).toContain("never accepts task authority from model parameters");
    } else {
      expect(ownerState.tasksCreated).toBe(1);
      expect(current.rawRequest).toBe(prompt);
      expect(current.ownerId).toBe(ownerState.ownerId);
      expect(current.taskId).not.toBe("attacker-task");
      expect((current.anchor as Event).messageId).not.toBe("attacker-message");
      expect(current.permissions).toBeUndefined();
      expect(current.budget).toBeUndefined();
    }
    expect(events(snapshot, "audit", "task_started").every((event) => event.ownerId === ownerState.ownerId)).toBe(true);
  });
}, TEST_TIMEOUT);

integration("cancellation blocks late capability work without changing task revision", async () => {
  await withSession({ scenario: "cancel-late" }, async (session) => {
    await session.prompt("Please own the release checklist, then cancel it when I ask.");
    const snapshot = await session.snapshot();
    const ownerState = state(snapshot);
    expect(ownerState.tasksCreated).toBe(1);
    const current = task(snapshot);
    expect(current.taskId).toBeString();
    expect(current.ownerId).toBe(ownerState.ownerId);
    expect(current.status).toBe("cancelled");
    expect(current.taskRevision).toBe(1);
    expect(current.admissions).toBe(0);
    expect(resultDetails(toolEnds(snapshot, "b1-cancel")[0]).task).toMatchObject({ taskId: current.taskId, status: "cancelled" });
    const late = toolEnds(snapshot, "b1-late-progress");
    expect(late).toHaveLength(1);
    expect((late[0]?.result as Event).isError).toBe(true);
    expect(resultText(late[0])).toContain("task is cancelled");
    expect(events(snapshot, "audit", "capability_admission_denied").some((event) => event.reason === "task is cancelled")).toBe(true);
    expect(task(snapshot).admissions).toBe(0);
    expect(snapshot.counter).toBeUndefined();
  });
}, TEST_TIMEOUT);

integration("a background control message cannot cancel the task", async () => {
  await withSession({ scenario: "background-cancel" }, async (session) => {
    await session.prompt("Please own the release checklist.");
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.status).toBe("active");
    expect(events(snapshot, "fixtureAudit", "background_injected")).toHaveLength(1);
    expect(events(snapshot, "fixtureAudit", "tool_call_emitted").some((event) => event.toolCallId === "b1-background-cancel")).toBe(true);
    const ended = toolEnds(snapshot, "b1-background-cancel");
    expect(ended).toHaveLength(1);
    expect((ended[0]?.result as Event).isError).toBe(true);
    expect(resultText(ended[0])).toContain("authority window was closed");
    expect(task(snapshot).status).toBe("active");
    expect(task(snapshot).cancelledAt).toBeNull();
    const attempts = attemptEvents(snapshot, "cancel");
    expect(attempts).toHaveLength(1);
    expect(branchCustomTypes(attempts[0])).toContain("b1.background");
    expect(events(snapshot, "audit", "task_cancelled")).toHaveLength(0);
  });
}, TEST_TIMEOUT);

integration("a second prompt has a separate lifecycle and cannot silently re-create the task", async () => {
  await withSession({ scenario: "two-prompts" }, async (session) => {
    await session.prompt("Please own the release checklist.");
    const first = await session.snapshot();
    const created = expectOneTask(first);
    expect((created.anchor as Event).messageId).toBeString();

    await session.prompt("Please inspect the existing task without changing it.");
    const second = await session.snapshot();
    expect(state(second).tasksCreated).toBe(1);
    expect(task(second).taskId).toBe(created.taskId);
    expect(events(second, "audit", "input_observed")).toHaveLength(2);
    const inspected = resultDetails(toolEnds(second, "b1-inspect")[0]);
    expect(inspected.task).toMatchObject({ taskId: created.taskId, taskRevision: 1, status: "active" });
    expect(events(second, "audit", "task_tool_rejected")).toHaveLength(0);
    expect(events(second, "audit", "task_grant_closed").length).toBeGreaterThanOrEqual(1);
    expect(events(second, "audit", "turn_close_unverified")).toHaveLength(0);
  });
}, TEST_TIMEOUT);

integration("a legitimate later user prompt cancels the task and blocks later capabilities", async () => {
  await withSession({ scenario: "two-prompts-cancel" }, async (session) => {
    await session.prompt("Please own the release checklist.");
    const first = await session.snapshot();
    const created = expectOneTask(first);
    const createdAnchor = created.anchor as Event;
    expect(createdAnchor.messageId).toBeString();

    await session.prompt("Please cancel the task I asked you to own.");
    const second = await session.snapshot();
    expect(state(second).tasksCreated).toBe(1);
    expect(task(second).taskId).toBe(created.taskId);
    expect(task(second).status).toBe("cancelled");
    expect(task(second).cancelledAt).toBeString();
    expect(task(second).taskRevision).toBe(1);
    expect(task(second).rawRequest).toBe("Please own the release checklist.");
    expect((task(second).anchor as Event).messageId).toBe(createdAnchor.messageId);
    expect(events(second, "audit", "input_observed")).toHaveLength(2);

    // The second real user message has its own host id; only the control
    // authority changed, not the task's creation anchor.
    const cancelAttempt = attemptEvents(second, "cancel")[0];
    expect(cancelAttempt).toBeDefined();
    const cancelUsers = (Array.isArray(cancelAttempt?.branch) ? cancelAttempt.branch as Event[] : [])
      .filter((entry) => entry.role === "user");
    expect(cancelUsers).toHaveLength(2);
    const controlMessageId = cancelUsers.at(-1)?.id;
    expect(controlMessageId).toBeString();
    expect(controlMessageId).not.toBe(createdAnchor.messageId);

    const cancelled = resultDetails(toolEnds(second, "b1-cancel")[0]);
    expect(cancelled.task).toMatchObject({ taskId: created.taskId, status: "cancelled", taskRevision: 1 });
    expect(events(second, "audit", "task_tool_rejected")).toHaveLength(0);
    expect(events(second, "audit", "task_cancelled")).toHaveLength(1);

    const late = toolEnds(second, "b1-late-progress");
    expect(late).toHaveLength(1);
    expect((late[0]?.result as Event).isError).toBe(true);
    expect(resultText(late[0])).toContain("task is cancelled");
    expect(events(second, "audit", "capability_admission_denied").some((event) => event.reason === "task is cancelled")).toBe(true);
    expect(task(second).admissions).toBe(0);
    expect(second.counter).toBeUndefined();
  });
}, TEST_TIMEOUT);
