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
