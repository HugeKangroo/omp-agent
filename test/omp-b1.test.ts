import { expect, test } from "bun:test";
import { B1OmpSession, type B1RunOptions } from "./harness/b1-run.ts";
import { classifyAdmissionReceipt } from "../src/task-requirements.ts";

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

    // The context hook runs fresh before each provider callback: no task before
    // the start tool exists, then one owner-derived projection at revision 1.
    const turns = events(snapshot, "fixtureAudit", "model_turn");
    expect(turns[0]?.taskContextCount).toBe(0);
    const afterStart = turns.find((event) => event.step === 1);
    expect(afterStart?.taskContextCount).toBe(1);
    expect(afterStart?.taskContext).toMatchObject({
      kind: "omp-agent.task-context",
      availability: "current",
      task: { taskRevision: 1, status: "active" },
      binding: { state: "attached" },
      requirements: { original: { revision: 1, text: prompt }, amendments: [] },
    });
    // The context-hook input is captured before the entry appends its message.
    expect(afterStart?.contextBefore).toMatchObject({ taskContextCount: 0 });
    // The transient projection is not in the actual persisted branch.
    expect(branchCustomTypes(snapshot.fixtureSnapshot)).not.toContain("omp-agent.task-context");
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

integration("a real second prompt revises once and stale expected revisions are denied", async () => {
  const firstPrompt = "Please own the release checklist.";
  const amendment = "Please revise: prefer low latency over maximum precision.";
  await withSession({ scenario: "revise" }, async (session) => {
    await session.prompt(firstPrompt);
    const first = await session.snapshot();
    const created = expectOneTask(first);
    const creationAnchor = created.anchor as Event;
    expect(resultDetails(toolEnds(first, "b1-progress-before")[0])).toMatchObject({
      allowed: true,
      taskRevision: 1,
      actionIndex: 1,
    });

    await session.prompt(amendment);
    const snapshot = await session.snapshot();
    const ownerState = state(snapshot);
    const current = task(snapshot);
    expect(ownerState.tasksCreated).toBe(1);
    expect(current.taskId).toBe(created.taskId);
    expect(current.taskRevision).toBe(2);
    expect(current.rawRequest).toBe(firstPrompt);
    expect(current.anchor).toEqual(creationAnchor);
    expect(current.status).toBe("active");
    expect(current.understanding).toBe("revised understanding");
    expect(current.understandingRevision).toBe(2);
    expect(current.understandingStale).toBe(false);

    const sources = current.requirementSources as Event[];
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ revision: 1, kind: "original", text: firstPrompt, previousRevision: null });
    expect(sources[1]).toMatchObject({
      revision: 2,
      kind: "amendment",
      previousRevision: 1,
      text: amendment,
      source: "rpc",
    });
    // The amendment source is the actual host message, not the creation one.
    const reviseAttempt = attemptEvents(snapshot, "revise")[0];
    const revUsers = (Array.isArray(reviseAttempt?.branch) ? reviseAttempt.branch as Event[] : [])
      .filter((entry) => entry.role === "user");
    expect(revUsers).toHaveLength(2);
    expect(revUsers.at(-1)?.id).toBe(sources[1]?.messageId);
    expect(sources[1]?.messageId).not.toBe(creationAnchor.messageId);

    const firstRevision = resultDetails(toolEnds(snapshot, "b1-revise-1")[0]);
    expect(firstRevision).toMatchObject({ revised: true, task: { taskRevision: 2 } });
    const retry = resultDetails(toolEnds(snapshot, "b1-revise-2")[0]);
    expect(retry).toMatchObject({ revised: false, task: { taskRevision: 2 } });
    expect((retry.task as Event).requirementSources as Event[]).toHaveLength(2);
    expect(events(snapshot, "audit", "task_revised")).toHaveLength(1);
    expect(events(snapshot, "audit", "task_revision_duplicate")).toHaveLength(1);

    // The provider callback immediately after the accepted revise tool result
    // sees the new revision (not only the next user prompt).
    const afterReviseTurn = events(snapshot, "fixtureAudit", "model_turn").find((event) => event.step === 4);
    expect(afterReviseTurn?.taskContext).toMatchObject({
      task: { taskRevision: 2, status: "active" },
      requirements: {
        taskRevision: 2,
        original: { revision: 1, text: firstPrompt },
        amendments: [{ revision: 2, previousRevision: 1, source: "rpc", text: amendment }],
      },
    });
    expect(afterReviseTurn?.contextBefore).toMatchObject({ taskContextCount: 0 });

    const stale = toolEnds(snapshot, "b1-stale-progress");
    expect(stale).toHaveLength(1);
    expect((stale[0]?.result as Event).isError).toBe(true);
    const staleDetails = resultDetails(stale[0]);
    expect(String(staleDetails.reason)).toContain("stale expected taskRevision 1");
    expect(staleDetails.actionIndex).toBeNull();
    const accepted = resultDetails(toolEnds(snapshot, "b1-progress-after")[0]);
    expect(accepted).toMatchObject({ allowed: true, taskRevision: 2, expectedTaskRevision: 2, actionIndex: 2, counter: 2 });
    // Only the accepted revision-2 call moved the independent counter.
    expect(snapshot.counter).toEqual({ count: 2 });
    expect(task(snapshot).admissions).toBe(2);

    // The original revision-1 receipt is immutable and now classifies stale;
    // the revision-2 receipt is current. No result adoption is involved.
    const oldReceipt = resultDetails(toolEnds(first, "b1-progress-before")[0]);
    const receipt = {
      taskId: String(oldReceipt.taskId),
      ownerId: String(oldReceipt.ownerId),
      taskRevision: Number(oldReceipt.taskRevision),
      actionIndex: Number(oldReceipt.actionIndex),
    };
    expect(receipt).toMatchObject({ taskId: current.taskId, taskRevision: 1, actionIndex: 1 });
    expect(classifyAdmissionReceipt(receipt, {
      taskId: String(current.taskId),
      ownerId: ownerState.ownerId as string,
      taskRevision: Number(current.taskRevision),
      detached: false,
    })).toBe("stale-revision");
    expect(classifyAdmissionReceipt({
      taskId: String(accepted.taskId),
      ownerId: String(accepted.ownerId),
      taskRevision: Number(accepted.taskRevision),
      actionIndex: Number(accepted.actionIndex),
    }, {
      taskId: String(current.taskId),
      ownerId: ownerState.ownerId as string,
      taskRevision: Number(current.taskRevision),
      detached: false,
    })).toBe("current");
  });
}, TEST_TIMEOUT);

integration("a background revise attempt is denied while authorized background progress continues", async () => {
  await withSession({ scenario: "background-revise" }, async (session) => {
    await session.prompt("Please own the release checklist.");
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(events(snapshot, "fixtureAudit", "background_injected")).toHaveLength(1);
    expect(events(snapshot, "fixtureAudit", "tool_call_emitted").some((event) => event.toolCallId === "b1-background-revise")).toBe(true);

    const denied = toolEnds(snapshot, "b1-background-revise");
    expect(denied).toHaveLength(1);
    expect((denied[0]?.result as Event).isError).toBe(true);
    expect(resultText(denied[0])).toContain("authority window was closed");
    expect(current.taskRevision).toBe(1);
    expect(current.requirementSources as Event[]).toHaveLength(1);

    const progress = resultDetails(toolEnds(snapshot, "b1-background-progress")[0]);
    expect(progress).toMatchObject({ allowed: true, taskRevision: 1, expectedTaskRevision: 1, actionIndex: 1 });
    expect(snapshot.counter).toEqual({ count: 1 });
    expect(events(snapshot, "audit", "task_revised")).toHaveLength(0);
    expect(state(snapshot).tasksCreated).toBe(1);
    expect(task(snapshot).taskRevision).toBe(1);
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

integration("native tree navigation to an older assistant detaches capability authority for a real later turn and a fresh session", async () => {
  const firstPrompt = "OWN_TASK: please own the release checklist for the navigation test.";
  const secondPrompt = "SECOND_OBSERVATION: record one more harmless follow-up on the same task.";
  const navigationPrompt = "AFTER_NAVIGATION: report whether the capability is still authorized.";
  const freshPrompt = "FRESH_SESSION: report whether the capability is still authorized here.";
  await withSession({ scenario: "navigation-detach", persistSessions: true }, async (session) => {
    await session.prompt(firstPrompt);
    const first = await session.snapshot();
    const created = expectOneTask(first);
    const creationAnchor = created.anchor as Event;
    expect(creationAnchor.messageId).toBeString();
    const originalSessionId = creationAnchor.sessionId;
    expect(originalSessionId).toBeString();

    // Real same-branch later turn: the ordinary B1 positive still works, and
    // one correct revision-1 capability is admitted before navigation.
    await session.prompt(secondPrompt);
    const second = await session.snapshot();
    expect(state(second).tasksCreated).toBe(1);
    expect(state(second).binding).toMatchObject({ state: "attached", sessionId: originalSessionId });
    expect(task(second).taskId).toBe(created.taskId);
    expect(task(second).rawRequest).toBe(firstPrompt);
    expect(task(second).taskRevision).toBe(1);
    expect((task(second).anchor as Event).messageId).toBe(creationAnchor.messageId);
    expect(task(second).requirementSources as Event[]).toHaveLength(1);
    const admitted = resultDetails(toolEnds(second, "b1-progress")[0]);
    expect(admitted).toMatchObject({ allowed: true, taskId: created.taskId, taskRevision: 1, expectedTaskRevision: 1, actionIndex: 1, counter: 1 });
    expect(second.counter).toEqual({ count: 1 });

    // Choose the navigation target from the actual native branch snapshot:
    // an assistant entry after the creation user anchor and before the leaf
    // produced by the later turn. OMP navigates to an assistant entry itself
    // (navigating to the original user entry would go BEFORE it).
    const branchSnapshot = await session.waitForFixture("branch with the later turn", (value) => {
      const branch = value.branch;
      return value.label === "agent_end" && Array.isArray(branch)
        && (branch as Event[]).some((entry) => entry.role === "user" && entry.text === secondPrompt);
    });
    expect(branchSnapshot.sessionId).toBe(originalSessionId);
    const branch = branchSnapshot.branch as Event[];
    const anchorIndex = branch.findIndex((entry) => entry.id === creationAnchor.messageId);
    const laterUserIndex = branch.findIndex((entry) => entry.role === "user" && entry.text === secondPrompt);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);
    expect(laterUserIndex).toBeGreaterThan(anchorIndex);
    const targetIndex = branch.findIndex((entry, index) => index > anchorIndex && index < laterUserIndex
      && entry.role === "assistant" && typeof entry.text === "string" && entry.text.startsWith("DONE: first prompt"));
    expect(targetIndex).toBeGreaterThan(anchorIndex);
    const targetId = branch[targetIndex]?.id;
    expect(targetId).toBeString();
    const oldLeafId = branchSnapshot.leafId;
    expect(oldLeafId).toBeString();
    expect(oldLeafId).not.toBe(targetId);
    expect(branch.some((entry) => entry.id === oldLeafId)).toBe(true);

    // Native command lifecycle through ExtensionCommandContext.navigateTree.
    await session.command(`/b1navigate ${targetId}`);
    const navigation = await session.waitForFixture("native navigation command", (value) => value.label === "after_navigation_command");
    expect(navigation.sessionId).toBe(originalSessionId);
    const navigationBranch = navigation.branch as Event[];
    expect(navigationBranch.some((entry) => entry.id === creationAnchor.messageId)).toBe(true);
    expect(navigationBranch.some((entry) => entry.id === targetId)).toBe(true);
    expect(navigationBranch.some((entry) => entry.id === oldLeafId)).toBe(false);
    expect(navigation.entryIds as string[]).toContain(oldLeafId as string);
    const navigationOwner = navigation.owner as Event;
    expect(navigationOwner.binding).toMatchObject({ state: "detached", event: "session_tree" });
    expect((navigationOwner.currentTask as Event).taskId).toBe(created.taskId);

    const afterNavigation = await session.snapshot();
    const begin = events(afterNavigation, "fixtureAudit", "navigation_command_begin").find((event) => event.target === targetId);
    const completed = events(afterNavigation, "fixtureAudit", "navigation_command_result").find((event) => event.target === targetId);
    expect(begin).toBeDefined();
    expect(completed).toBeDefined();
    expect(begin?.sessionId).toBe(originalSessionId);
    expect(completed?.sessionId).toBe(originalSessionId);
    expect(events(afterNavigation, "fixtureAudit", "native_hook")
      .some((event) => event.name === "session_tree" && event.sessionId === originalSessionId)).toBe(true);
    expect(events(afterNavigation, "audit", "task_binding_detached")
      .some((event) => event.event === "session_tree")).toBe(true);
    expect(state(afterNavigation).binding).toMatchObject({ state: "detached", event: "session_tree" });
    expect(state(afterNavigation).tasksCreated).toBe(1);
    expect(task(afterNavigation).taskId).toBe(created.taskId);
    expect(task(afterNavigation).rawRequest).toBe(firstPrompt);
    expect(task(afterNavigation).taskRevision).toBe(1);
    expect((task(afterNavigation).anchor as Event).messageId).toBe(creationAnchor.messageId);
    expect(afterNavigation.counter).toEqual({ count: 1 });

    // A real new user prompt still emits the actual tool call; the tool result
    // proves a detached denial without moving the independent counter.
    await session.prompt(navigationPrompt);
    const afterDenial = await session.snapshot();
    const emitted = events(afterDenial, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === "b1-detached-progress");
    expect(emitted).toBeDefined();
    expect(emitted?.tool).toBe("agent_test_capability");
    expect(emitted?.arguments).toMatchObject({ action: "progress", expectedTaskRevision: 1 });
    const deniedFrames = toolEnds(afterDenial, "b1-detached-progress");
    expect(deniedFrames).toHaveLength(1);
    expect((deniedFrames[0]?.result as Event).isError).toBe(true);
    const denied = resultDetails(deniedFrames[0]);
    expect(denied).toMatchObject({
      allowed: false,
      taskId: created.taskId,
      taskRevision: 1,
      expectedTaskRevision: 1,
      actionIndex: null,
      counter: null,
    });
    expect(String(denied.reason)).toContain("conversation binding is detached");
    expect(events(afterDenial, "audit", "capability_admission_denied")
      .some((event) => String(event.reason).includes("detached"))).toBe(true);
    expect(afterDenial.counter).toEqual({ count: 1 });
    expect(state(afterDenial).tasksCreated).toBe(1);
    expect(state(afterDenial).binding).toMatchObject({ state: "detached" });
    const detachedContextTurns = events(afterDenial, "fixtureAudit", "model_turn").filter((event) => {
      const context = event.taskContext;
      return typeof context === "object" && context !== null
        && (context as Event).binding !== undefined
        && ((context as Event).binding as Event).state === "detached";
    });
    expect(detachedContextTurns.length).toBeGreaterThanOrEqual(1);
    expect(detachedContextTurns.at(-1)?.taskContext).toMatchObject({
      availability: "read-only-unavailable",
      binding: { state: "detached", event: "session_tree" },
      requirements: { original: { text: firstPrompt } },
    });
    expect(task(afterDenial).taskId).toBe(created.taskId);
    expect(task(afterDenial).rawRequest).toBe(firstPrompt);
    expect(task(afterDenial).taskRevision).toBe(1);
    expect(task(afterDenial).status).toBe("active");
    expect((task(afterDenial).anchor as Event).messageId).toBe(creationAnchor.messageId);

    // Native session replacement, then another real prompt in the new session.
    const replacement = await session.newSession();
    expect(replacement.success).toBe(true);
    const switched = await session.waitForFixture("different native session", (value) => typeof value.sessionId === "string" && value.sessionId !== originalSessionId);
    expect(switched.sessionId).not.toBe(originalSessionId);
    expect(events(await session.snapshot(), "fixtureAudit", "native_hook")
      .some((event) => (event.name === "session_switch" || event.name === "session_start") && event.sessionId === switched.sessionId)).toBe(true);

    await session.prompt(freshPrompt);
    const afterFresh = await session.snapshot();
    const freshSnapshot = await session.fixtureSnapshot();
    expect(freshSnapshot?.sessionId).toBe(switched.sessionId);
    const freshEmitted = events(afterFresh, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === "b1-fresh-session-progress");
    expect(freshEmitted).toBeDefined();
    expect(freshEmitted?.tool).toBe("agent_test_capability");
    const freshFrames = toolEnds(afterFresh, "b1-fresh-session-progress");
    expect(freshFrames).toHaveLength(1);
    expect((freshFrames[0]?.result as Event).isError).toBe(true);
    const freshDenied = resultDetails(freshFrames[0]);
    expect(freshDenied.allowed).toBe(false);
    expect(String(freshDenied.reason)).toContain("conversation binding is detached");
    expect(freshDenied.expectedTaskRevision).toBe(1);
    expect(freshDenied.actionIndex).toBeNull();
    expect(afterFresh.counter).toEqual({ count: 1 });
    expect(state(afterFresh).tasksCreated).toBe(1);
    expect(state(afterFresh).binding).toMatchObject({ state: "detached" });
    expect(task(afterFresh).taskId).toBe(created.taskId);
    expect(task(afterFresh).rawRequest).toBe(firstPrompt);
    expect(task(afterFresh).taskRevision).toBe(1);
    expect(task(afterFresh).status).toBe("active");
    expect(events(afterFresh, "audit", "input_observed")
      .filter((event) => event.accepted === true).length).toBeGreaterThanOrEqual(4);
  });
}, TEST_TIMEOUT);

integration("a local non-navigating command with agentInvoked=false does not block the next genuine task", async () => {
  await withSession({ scenario: "start" }, async (session) => {
    const command = await session.command("/b1noop");
    expect(command.agentInvoked).toBe(false);
    const afterCommand = await session.snapshot();
    expect(events(afterCommand, "fixtureAudit", "noop_command")).toHaveLength(1);
    const ownerAfterCommand = state(afterCommand);
    expect(ownerAfterCommand.tasksCreated).toBe(0);
    expect(ownerAfterCommand.currentTask).toBeNull();
    // The command input is only a pending observation: no start candidate ran.
    expect(ownerAfterCommand.activeGrant).toMatchObject({ started: false, anchorMessageId: null });
    expect(ownerAfterCommand.suspended).toBeNull();
    expect(events(afterCommand, "audit", "task_started")).toHaveLength(0);

    const request = "Please own the release checklist after the local command.";
    await session.prompt(request);
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.rawRequest).toBe(request);
    expect(state(snapshot).suspended).toBeNull();
    expect(events(snapshot, "audit", "task_observation_superseded")).toHaveLength(1);
    expect(events(snapshot, "audit", "task_owner_overlap_rejected")).toHaveLength(0);
    expect(events(snapshot, "audit", "task_owner_suspended")).toHaveLength(0);
    expect(events(snapshot, "audit", "input_observed").filter((event) => event.accepted === true)).toHaveLength(2);
    expect(resultDetails(toolEnds(snapshot, "b1-start")[0]).created).toBe(true);
  });
}, TEST_TIMEOUT);

integration("a pending local command before a real session replacement does not detach the first task", async () => {
  const request = "请创建并管理发布检查清单任务。";
  await withSession({ scenario: "start" }, async (session) => {
    const originalSessionId = (await session.fixtureSnapshot())?.sessionId;
    expect(originalSessionId).toBeString();

    const command = await session.command("/b1noop");
    expect(command.agentInvoked).toBe(false);
    const afterCommand = await session.snapshot();
    const ownerAfterCommand = state(afterCommand);
    expect(events(afterCommand, "fixtureAudit", "noop_command")).toHaveLength(1);
    expect(ownerAfterCommand.tasksCreated).toBe(0);
    expect(ownerAfterCommand.currentTask).toBeNull();
    expect(ownerAfterCommand.activeGrant).toMatchObject({ text: "/b1noop", started: false, anchorMessageId: null });
    expect(ownerAfterCommand.binding).toMatchObject({ state: "attached" });

    const replacement = await session.newSession();
    expect(replacement.success).toBe(true);
    const switched = await session.waitForFixture("different native session", (value) => typeof value.sessionId === "string" && value.sessionId !== originalSessionId);
    expect(switched.sessionId).not.toBe(originalSessionId);
    expect(events(await session.snapshot(), "fixtureAudit", "native_hook")
      .some((event) => (event.name === "session_switch" || event.name === "session_start") && event.sessionId === switched.sessionId)).toBe(true);

    const afterSwitch = await session.snapshot();
    const ownerAfterSwitch = state(afterSwitch);
    expect(ownerAfterSwitch.tasksCreated).toBe(0);
    expect(ownerAfterSwitch.currentTask).toBeNull();
    expect(ownerAfterSwitch.activeGrant).toBeNull();
    expect(ownerAfterSwitch.suspended).toBeNull();
    expect(ownerAfterSwitch.binding).toMatchObject({ state: "attached", reason: null, event: null });
    expect(events(afterSwitch, "audit", "task_binding_detached")).toHaveLength(0);

    await session.prompt(request);
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.rawRequest).toBe(request);
    const anchor = current.anchor as Event;
    expect(anchor.sessionId).toBe(switched.sessionId);
    expect(anchor.sessionId).not.toBe(originalSessionId);
    expect(anchor.source).toBe("rpc");
    expect(anchor.messageId).toBeString();
    expect(anchor.messageId).not.toHaveLength(0);
    expect(anchor.observedText).toBe(request);
    expect(anchor.anchorText).toBe(request);
    expect(state(snapshot).binding).toMatchObject({ state: "attached", reason: null, event: null });
    expect(state(snapshot).suspended).toBeNull();
    expect(events(snapshot, "audit", "task_started")).toHaveLength(1);
    expect(events(snapshot, "audit", "task_binding_detached")).toHaveLength(0);
    expect(events(snapshot, "audit", "task_observation_superseded")).toHaveLength(0);
    expect(events(snapshot, "audit", "task_owner_suspended")).toHaveLength(0);

    const emitted = events(snapshot, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === "b1-start");
    expect(emitted?.tool).toBe("agent_task");
    const ended = toolEnds(snapshot, "b1-start");
    expect(ended).toHaveLength(1);
    const details = resultDetails(ended[0]);
    expect(details.created).toBe(true);
    expect((details.task as Event).taskId).toBe(current.taskId);
    expect((details.task as Event).rawRequest).toBe(request);
    expect(((details.task as Event).anchor as Event).sessionId).toBe(switched.sessionId);
    expect(((details.task as Event).anchor as Event).messageId).toBe(anchor.messageId);

    const finalFixture = await session.fixtureSnapshot();
    expect(finalFixture?.sessionId).toBe(switched.sessionId);
    expect(finalFixture?.entryIds as unknown[]).toContain(anchor.messageId);
    const persistedAnchor = (finalFixture?.branch as Event[]).find((entry) => entry.id === anchor.messageId);
    expect(persistedAnchor).toMatchObject({ type: "message", role: "user", text: request });
  });
}, TEST_TIMEOUT);

integration("a local command after an existing task does not prevent the next genuine revision", async () => {
  const firstPrompt = "Please own the release checklist before the local command.";
  const amendment = "Please revise: keep the original task and prefer low latency.";
  await withSession({ scenario: "command-then-revise" }, async (session) => {
    await session.prompt(firstPrompt);
    const first = await session.snapshot();
    const created = expectOneTask(first);

    const command = await session.command("/b1noop");
    expect(command.agentInvoked).toBe(false);
    const afterCommand = await session.snapshot();
    expect(state(afterCommand).tasksCreated).toBe(1);
    expect(task(afterCommand).taskId).toBe(created.taskId);
    expect(task(afterCommand).taskRevision).toBe(1);
    expect(state(afterCommand).activeGrant).toMatchObject({ started: false, anchorMessageId: null });
    expect(state(afterCommand).suspended).toBeNull();

    await session.prompt(amendment);
    const snapshot = await session.snapshot();
    const current = task(snapshot);
    expect(current.taskId).toBe(created.taskId);
    expect(current.taskRevision).toBe(2);
    expect(current.status).toBe("active");
    expect(current.rawRequest).toBe(firstPrompt);
    expect((current.anchor as Event).messageId).toBe((created.anchor as Event).messageId);
    const sources = current.requirementSources as Event[];
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ revision: 1, kind: "original", text: firstPrompt });
    expect(sources[1]).toMatchObject({ revision: 2, kind: "amendment", text: amendment, source: "rpc" });
    expect(events(snapshot, "audit", "task_observation_superseded").length).toBeGreaterThanOrEqual(1);
    expect(events(snapshot, "audit", "task_owner_overlap_rejected")).toHaveLength(0);
    expect(events(snapshot, "audit", "task_owner_suspended")).toHaveLength(0);
    expect(resultDetails(toolEnds(snapshot, "b1-revise")[0])).toMatchObject({ revised: true, task: { taskRevision: 2 } });
  });
}, TEST_TIMEOUT);

integration("real OMP compaction preserves authoritative requirements and denies hostile summary control", async () => {
  const padding = " bounded-context".repeat(90);
  const firstPrompt = `CONSTRAINT_SENTINEL_ALPHA: preserve the original release checklist exactly.${padding}`;
  const amendment = `CONSTRAINT_SENTINEL_BETA: amend the checklist to prefer low latency.${padding}`;
  const harmless = `HARMLESS_TURN: ordinary later context after both requirements.${padding}`;
  const postPrompt = "POST_COMPACT_AMENDMENT: keep both sentinels and add a verification step.";
  await withSession({ scenario: "compaction", persistSessions: true }, async (session) => {
    await session.prompt(firstPrompt);
    const first = await session.snapshot();
    const created = expectOneTask(first);
    const creationAnchor = created.anchor as Event;
    expect(creationAnchor.messageId).toBeString();
    expect(task(first).requirementSources as Event[]).toHaveLength(1);

    await session.prompt(amendment);
    const revised = await session.snapshot();
    expect(task(revised).taskRevision).toBe(2);
    expect(task(revised).requirementSources as Event[]).toHaveLength(2);
    expect((task(revised).requirementSources as Event[])[1]).toMatchObject({ revision: 2, text: amendment });

    await session.prompt(harmless);
    const beforeCompact = await session.snapshot();
    const beforeOwner = state(beforeCompact);
    expect(beforeOwner.tasksCreated).toBe(1);
    expect(task(beforeCompact).taskRevision).toBe(2);
    expect(beforeOwner.binding).toMatchObject({ state: "attached" });
    expect(beforeOwner.activeGrant).toBeNull();
    expect(beforeOwner.authorizedCapabilities).toEqual(["test-progress"]);

    await session.compact("fixture compaction without a remote summarizer");
    const compactEnd = session.frames.filter((frame) => frame.type === "manual_compaction_end").at(-1);
    expect(compactEnd?.aborted).toBe(false);
    const compactFixture = await session.waitForAudit("fixture session_before_compact", (event) => event.type === "session_before_compact_fixture");
    expect(compactFixture.firstKeptEntryId).toBeString();
    const preCompactBranch = beforeCompact.fixtureSnapshot?.branch as Event[];
    const harmlessEntry = preCompactBranch.find((entry) => entry.role === "user"
      && typeof entry.text === "string" && entry.text.startsWith("HARMLESS_TURN"));
    expect(harmlessEntry?.id).toBeString();
    expect(compactFixture.firstKeptEntryId).toBe(harmlessEntry?.id);
    expect(compactFixture.summary).toContain("SUMMARY_ATTACK_COMPACT");
    await session.waitForAudit("fixture session_compact", (event) => event.type === "session_compact_fixture");
    const afterCompactSnapshot = await session.fixtureSnapshot();
    expect(afterCompactSnapshot?.label).toBe("session_compact");
    const compactBranch = afterCompactSnapshot?.branch as Event[];
    expect(compactBranch.some((entry) => entry.id === creationAnchor.messageId)).toBe(true);
    const compactBranchCustomTypes = afterCompactSnapshot ? branchCustomTypes(afterCompactSnapshot) : [];
    expect(compactBranchCustomTypes).not.toContain("omp-agent.task-context");
    // The session_compact hook snapshot is taken before the background attack.
    // Compaction itself changes no task state, revision, binding or permission.
    expect(afterCompactSnapshot?.owner).toEqual(beforeCompact.fixtureSnapshot?.owner);

    await session.waitForAudit("compaction background attack completion", (event) => event.type === "compaction_attack_finished", 20_000);
    await Bun.sleep(200);
    const attacked = await session.snapshot();
    const attackedTask = task(attacked);
    const beforeTask = task(beforeCompact);
    expect(state(attacked).tasksCreated).toBe(1);
    expect(attackedTask.taskId).toBe(created.taskId);
    expect(attackedTask.ownerId).toBe(beforeTask.ownerId);
    expect(attackedTask.taskRevision).toBe(2);
    expect(attackedTask.status).toBe("active");
    expect(attackedTask.admissions).toBe(1);
    expect(beforeTask.admissions).toBe(0);
    expect((attackedTask.anchor as Event).messageId).toBe(creationAnchor.messageId);
    expect(attackedTask.requirementSources).toEqual(beforeTask.requirementSources);
    expect(state(attacked).binding).toEqual(beforeOwner.binding);
    expect(state(attacked).authorizedCapabilities).toEqual(beforeOwner.authorizedCapabilities);
    expect(events(attacked, "audit", "task_binding_detached")).toHaveLength(0);
    expect(events(attacked, "audit", "task_cancelled")).toHaveLength(0);
    expect(events(attacked, "audit", "task_started")).toHaveLength(1);
    expect(events(attacked, "audit", "task_revised")).toHaveLength(1);

    const attackCalls = [
      { id: "b1-after-compact-cancel", tool: "agent_task" },
      { id: "b1-after-compact-start", tool: "agent_task" },
      { id: "b1-after-compact-revise", tool: "agent_task" },
      { id: "b1-after-compact-progress", tool: "agent_test_capability" },
    ];
    const emitted = events(attacked, "fixtureAudit", "tool_call_emitted");
    const turns = events(attacked, "fixtureAudit", "model_turn");
    for (const [index, attack] of attackCalls.entries()) {
      const matches = emitted.filter((event) => event.toolCallId === attack.id);
      expect(matches).toHaveLength(1);
      const emission = matches[0]!;
      expect(emission.tool).toBe(attack.tool);
      expect(typeof attack.id).toBe("string");
      expect(attack.id.length).toBeGreaterThan(0);
      const turn = turns.find((event) => event.step === emission.step);
      expect(turn?.step).toBe(5 + index);
      expect(turn).toBeDefined();
      // The context-hook input before injection is the actual compacted base
      // context: both old requirement sentinels are absent there.
      expect(turn?.contextBefore).toMatchObject({
        messageCount: expect.any(Number),
        taskContextCount: 0,
        alphaPresent: false,
        betaPresent: false,
      });
      expect(turn?.taskContextCount).toBe(1);
      expect(turn?.taskContext).toMatchObject({
        kind: "omp-agent.task-context",
        availability: "current",
        task: { taskId: created.taskId, taskRevision: 2, status: "active" },
        binding: { state: "attached" },
        requirements: {
          taskRevision: 2,
          original: { revision: 1, text: firstPrompt },
          amendments: [{ revision: 2, text: amendment }],
        },
      });
      // The hostile summary actually reached the provider for exactly these
      // attack turns, scoped by the non-empty tool call id above.
      expect(turn?.summaryPresent).toBe(true);
    }

    for (const deniedCall of attackCalls.slice(0, 3)) {
      const ended = toolEnds(attacked, deniedCall.id);
      expect(ended).toHaveLength(1);
      expect((ended[0]?.result as Event).isError).toBe(true);
      expect(resultText(ended[0])).toContain("No live genuine user turn");
    }
    const allowedProgress = resultDetails(toolEnds(attacked, "b1-after-compact-progress")[0]);
    expect(allowedProgress).toMatchObject({
      allowed: true,
      taskId: created.taskId,
      taskRevision: 2,
      expectedTaskRevision: 2,
      actionIndex: 1,
      status: "active",
      counter: 1,
    });
    expect(attacked.counter).toEqual({ count: 1 });

    // A later genuine user message can inspect and revise the same task using
    // its actual new branch anchor; compaction did not synthesize navigation.
    await session.prompt(postPrompt);
    const afterPost = await session.snapshot();
    const postTask = task(afterPost);
    expect(postTask.taskId).toBe(created.taskId);
    expect(postTask.taskRevision).toBe(3);
    expect(postTask.status).toBe("active");
    expect(postTask.rawRequest).toBe(firstPrompt);
    expect((postTask.anchor as Event).messageId).toBe(creationAnchor.messageId);
    const sources = postTask.requirementSources as Event[];
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({ revision: 1, kind: "original", text: firstPrompt });
    expect(sources[1]).toMatchObject({ revision: 2, kind: "amendment", text: amendment });
    expect(sources[2]).toMatchObject({ revision: 3, kind: "amendment", previousRevision: 2, source: "rpc", text: postPrompt });
    expect((sources[2]!.messageId as string)).not.toBe(creationAnchor.messageId);
    const inspected = resultDetails(toolEnds(afterPost, "b1-post-compact-inspect")[0]);
    expect(inspected.task).toMatchObject({ taskId: created.taskId, taskRevision: 2, status: "active" });
    expect(inspected.requirements).toMatchObject({
      taskRevision: 2,
      original: { revision: 1, text: firstPrompt },
      amendments: [{ revision: 2, text: amendment }],
    });
    expect(resultDetails(toolEnds(afterPost, "b1-post-compact-revise")[0])).toMatchObject({ revised: true, task: { taskRevision: 3 } });
    expect(resultDetails(toolEnds(afterPost, "b1-post-compact-revise-retry")[0])).toMatchObject({ revised: false, task: { taskRevision: 3 } });
    expect(events(afterPost, "audit", "task_revised")).toHaveLength(2);
    expect(events(afterPost, "audit", "task_revision_duplicate")).toHaveLength(1);
    expect(state(afterPost).binding).toMatchObject({ state: "attached" });
    expect(events(afterPost, "audit", "task_binding_detached")).toHaveLength(0);
    expect(afterPost.counter).toEqual({ count: 1 });

    // The same-loop provider callback after the post-compaction revise sees
    // revision 3 immediately, not only after a new prompt.
    const afterPostReviseTurn = events(afterPost, "fixtureAudit", "model_turn").find((event) => event.step === 12);
    expect(afterPostReviseTurn?.taskContext).toMatchObject({
      task: { taskRevision: 3, status: "active" },
      requirements: { taskRevision: 3, amendments: [{ revision: 2 }, { revision: 3, text: postPrompt }] },
    });
    expect(branchCustomTypes(await session.fixtureSnapshot())).not.toContain("omp-agent.task-context");
  });
}, TEST_TIMEOUT);

integration("a background follow-up after a local command cannot consume the pending genuine observation", async () => {
  const command = "/b1noopbackground";
  const request = "Please own the release checklist after the background attempt.";
  await withSession({ scenario: "command-background-pending" }, async (session) => {
    const completed = await session.command(command);
    expect(completed.agentInvoked).toBe(false);
    await session.waitForAudit("pending background completion", (event) => event.type === "pending_background_finished", 20_000);
    await Bun.sleep(250);

    const afterBackground = await session.snapshot();
    expect(events(afterBackground, "fixtureAudit", "pending_background_injected")).toHaveLength(1);
    expect(events(afterBackground, "fixtureAudit", "tool_call_emitted").some((event) => event.toolCallId === "b1-pending-bg-start")).toBe(true);
    const denied = toolEnds(afterBackground, "b1-pending-bg-start");
    expect(denied).toHaveLength(1);
    expect((denied[0]?.result as Event).isError).toBe(true);
    expect(resultText(denied[0])).toContain("No live genuine user turn");
    expect(state(afterBackground).tasksCreated).toBe(0);
    expect(state(afterBackground).currentTask).toBeNull();
    expect(state(afterBackground).suspended).toBeNull();
    // Actual OMP did not emit before_agent_start for this follow-up, so the
    // pending observation is preserved without a mismatch event; no real
    // agent_end or background control closed or started it either.
    expect(events(afterBackground, "audit", "task_grant_closed")).toHaveLength(0);
    expect(events(afterBackground, "audit", "task_owner_suspended")).toHaveLength(0);
    // The local-command observation is still pending, not started or consumed.
    expect(state(afterBackground).activeGrant).toMatchObject({
      text: command,
      started: false,
      anchorMessageId: null,
    });

    await session.prompt(request);
    const snapshot = await session.snapshot();
    const current = expectOneTask(snapshot);
    expect(current.rawRequest).toBe(request);
    expect(state(snapshot).suspended).toBeNull();
    expect(events(snapshot, "audit", "task_observation_superseded")).toHaveLength(1);
    expect(events(snapshot, "audit", "task_owner_overlap_rejected")).toHaveLength(0);
    expect(events(snapshot, "audit", "task_owner_suspended")).toHaveLength(0);
    expect(resultDetails(toolEnds(snapshot, "b1-pending-genuine-start")[0]).created).toBe(true);
  });
}, TEST_TIMEOUT);
