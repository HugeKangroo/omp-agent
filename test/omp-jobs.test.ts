import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { B1OmpSession, markActiveSessionsFailed } from "./harness/b1-run.ts";
import { MockJobService } from "./harness/job-service.ts";

const TEST_TIMEOUT = 90_000;
const integration: (name: string, fn: () => Promise<unknown>, timeoutMs?: number) => void = process.env.RUN_REAL_OMP_TEST === "1"
  ? (name, fn, timeoutMs = TEST_TIMEOUT) => test(name, async () => {
    try {
      await fn();
    } catch (error) {
      markActiveSessionsFailed(error);
      throw error;
    }
  }, timeoutMs)
  : (name, fn, _timeoutMs) => test.skip(name, fn);

type Event = Record<string, unknown>;
type Snapshot = Awaited<ReturnType<B1OmpSession["snapshot"]>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(scenario: string, options: {
  observeToolSignal?: boolean;
  jobTimeoutMs?: number;
  persistSessions?: boolean;
} = {}): Promise<{
  service: MockJobService;
  session: B1OmpSession;
}> {
  const service = await MockJobService.start();
  const session = await B1OmpSession.create({
    scenario,
    timeoutMs: 20_000,
    ...(options.persistSessions === true ? { persistSessions: true } : {}),
    jobs: {
      endpoint: service.endpoint,
      timeoutMs: options.jobTimeoutMs ?? 1_000,
      observeToolSignal: options.observeToolSignal === true,
    },
  });
  cleanups.push(async () => {
    await session.cleanup();
    await service.cleanup();
  });
  await session.start();
  return { service, session };
}

function events(snapshot: Snapshot, list: "audit" | "fixtureAudit" | "jobAudit", type: string): Event[] {
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

function ownerState(snapshot: Snapshot): Event {
  return typeof snapshot.state === "object" && snapshot.state !== null && !Array.isArray(snapshot.state) ? snapshot.state as Event : {};
}

function task(snapshot: Snapshot): Event {
  const current = ownerState(snapshot).currentTask;
  return typeof current === "object" && current !== null && !Array.isArray(current) ? current as Event : {};
}

function toolTrace(snapshot: Snapshot, type: string, id?: string): Event[] {
  return snapshot.jobToolTrace.filter((event) => event.type === type && (id === undefined || event.id === id));
}

async function waitForToolTrace(
  session: B1OmpSession,
  label: string,
  predicate: (event: Event) => boolean,
  timeoutMs = 10_000,
): Promise<Event> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const found = (await session.snapshot()).jobToolTrace.find(predicate);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out`);
    await Bun.sleep(20);
  }
}

function jobRecord(snapshot: Snapshot): { operations: Event[] } {
  const record = snapshot.jobRecord;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return { operations: [] };
  const operations = (record as Event).operations;
  return { operations: Array.isArray(operations) ? operations.filter((item): item is Event => typeof item === "object" && item !== null && !Array.isArray(item)) : [] };
}

async function recordNow(session: B1OmpSession): Promise<{ operations: Event[] }> {
  try {
    const value = JSON.parse(await readFile(session.jobRecordPath!, "utf8")) as { operations?: unknown };
    return {
      operations: Array.isArray(value.operations)
        ? value.operations.filter((item): item is Event => typeof item === "object" && item !== null && !Array.isArray(item))
        : [],
    };
  } catch {
    return { operations: [] };
  }
}

async function waitForRecord(
  session: B1OmpSession,
  label: string,
  predicate: (operation: Event) => boolean,
  timeoutMs = 10_000,
): Promise<Event> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const operation = (await recordNow(session)).operations[0];
    if (operation && predicate(operation)) return operation;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out`);
    await Bun.sleep(25);
  }
}

function expectOneTask(snapshot: Snapshot, status: "active" | "cancelled"): Event {
  return expectOneTaskAtRevision(snapshot, status, 1);
}

function expectOneTaskAtRevision(snapshot: Snapshot, status: "active" | "cancelled", revision: number): Event {
  const owner = ownerState(snapshot);
  expect(owner.tasksCreated).toBe(1);
  const current = task(snapshot);
  expect(typeof current.taskId).toBe("string");
  expect(current.status).toBe(status);
  expect(current.taskRevision).toBe(revision);
  return current;
}

integration("B3a normal job: submit, running, host completion, succeeded; task stays active", async () => {
  const { service, session } = await setup("job-normal");
  await session.prompt("Please run the one experimental job.");

  const submitted = toolEnds(await session.snapshot(), "job-submit-1");
  expect(submitted).toHaveLength(1);
  const submitDetails = resultDetails(submitted[0]);
  const submitOperation = submitDetails.operation as Event;
  expect(submitDetails.action).toBe("submit");
  expect(submitOperation.externalState).toBe("running");
  expect(submitOperation.accepted).toBe(true);
  expect(submitOperation.taskRevision).toBe(1);
  expect(typeof submitOperation.operationId).toBe("string");
  expect(typeof submitOperation.callId).toBe("string");

  const running = toolEnds(await session.snapshot(), "job-query-running");
  expect(running).toHaveLength(1);
  expect((resultDetails(running[0]).operation as Event).externalState).toBe("running");

  const stats = await service.stats();
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.submitRequests).toBe(1);
  expect((await service.complete()).job.state).toBe("succeeded");
  await session.prompt("Please check the same job.");

  const succeeded = toolEnds(await session.snapshot(), "job-query-succeeded");
  expect(succeeded).toHaveLength(1);
  const succeededDetails = resultDetails(succeeded[0]);
  const operation = succeededDetails.operation as Event;
  expect(operation.externalState).toBe("succeeded");
  expect(operation.externalJobId).toBe((await service.stats()).jobs[0]?.jobId);
  expect(succeededDetails.task).toMatchObject({ taskRevision: 1, status: "active" });

  const final = await session.snapshot();
  expectOneTask(final, "active");
  expect(jobRecord(final).operations).toHaveLength(1);
  expect(events(final, "fixtureAudit", "tool_call_emitted").filter((event) => event.toolCallId === "job-query-succeeded")).toHaveLength(1);
  expect(events(final, "fixtureAudit", "tool_call_emitted").filter((event) => event.toolCallId === "job-query-running")).toHaveLength(1);
});

integration("B3a lost acknowledgement: unknown stays prewritten, repeat submit reconciles, changed payload conflicts", async () => {
  const { service, session } = await setup("job-lost-ack");
  await service.configure({ dropSubmitAck: true });
  await session.prompt("Please submit one job and reconcile any unknown acknowledgement.");

  const final = await session.snapshot();
  const lostFrame = toolEnds(final, "job-submit-lost")[0];
  const reconcileFrame = toolEnds(final, "job-submit-reconcile")[0];
  const conflictFrame = toolEnds(final, "job-submit-conflict")[0];
  const queryFrame = toolEnds(final, "job-query-after-lost")[0];
  expect(lostFrame).toBeDefined();
  expect(reconcileFrame).toBeDefined();
  expect(conflictFrame).toBeDefined();
  expect(queryFrame).toBeDefined();

  const lost = resultDetails(lostFrame).operation as Event;
  const reconciled = resultDetails(reconcileFrame).operation as Event;
  const lastQuery = resultDetails(queryFrame).operation as Event;
  expect(lost.externalState).toBe("unknown");
  expect(lost.accepted).toBe(false);
  expect(lost.externalJobId).toBeNull();
  expect(typeof lost.operationId).toBe("string");
  expect(reconciled.operationId).toBe(lost.operationId);
  expect(reconciled.payloadDigest).toBe(lost.payloadDigest);
  expect(reconciled.createdAt).toBe(lost.createdAt);
  expect(reconciled.taskRevision).toBe(1);
  expect(reconciled.externalState).toBe("running");
  expect(typeof reconciled.externalJobId).toBe("string");
  expect(lastQuery.externalState).toBe("running");
  expect(conflictFrame?.result && (conflictFrame.result as Event).isError).toBe(true);
  expect(resultText(conflictFrame)).toContain("different payload");
  expect(resultDetails(reconcileFrame).reconciled).toBe(true);

  const stats = await service.stats();
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.submitRequests).toBe(1);
  const operation = jobRecord(final).operations[0]!;
  expect(operation).toMatchObject({
    operationId: lost.operationId,
    payloadDigest: lost.payloadDigest,
    createdAt: lost.createdAt,
    taskRevision: 1,
    payload: "alpha-prototype-payload",
  });
  expect(jobRecord(final).operations).toHaveLength(1);
  expectOneTask(final, "active");
  expect(events(final, "jobAudit", "job_submit_denied")).toHaveLength(0);
  expect(events(final, "fixtureAudit", "tool_call_emitted").filter((event) => event.tool === "agent_job")).toHaveLength(4);
});

integration("B3a host cancellation: model only cancels the task, adapter sends one unconfirmed cleanup, later query confirms", async () => {
  const { service, session } = await setup("job-cancel");
  await service.configure({ holdCancel: true });
  await session.prompt("Please submit one experimental job.");
  const submitted = toolEnds(await session.snapshot(), "job-submit-cancel");
  expect(submitted).toHaveLength(1);
  expect((resultDetails(submitted[0]).operation as Event).externalState).toBe("running");
  expect((await service.stats()).counters.submitRequests).toBe(1);

  await session.prompt("Please cancel that managed task.");
  const afterCancel = await session.snapshot();
  expectOneTask(afterCancel, "cancelled");
  const cancelCall = events(afterCancel, "fixtureAudit", "tool_call_emitted").filter((event) => event.toolCallId === "job-task-cancel");
  expect(cancelCall).toHaveLength(1);
  expect(cancelCall[0]!.tool).toBe("agent_task");
  expect(events(afterCancel, "fixtureAudit", "tool_call_emitted").filter((event) => event.tool === "agent_job")).toHaveLength(1);

  const held = await waitForRecord(session, "held cancellation", (operation) => {
    const intent = operation.cancelIntent as Event | null;
    return intent?.attempts === 1 && intent.state === "requested_unconfirmed";
  });
  expect(held.externalState).toBe("running");
  expect((await service.stats()).counters.cancelRequests).toBe(1);

  await service.confirmCancel();
  await session.prompt("Please query cleanup once and try a new submission.");
  const final = await session.snapshot();
  const query = resultDetails(toolEnds(final, "job-query-after-cancel")[0]);
  const denied = toolEnds(final, "job-submit-after-cancel")[0];
  expect((query.operation as Event).externalState).toBe("cancelled");
  expect((query.operation as Event).cancelIntent).toMatchObject({ state: "confirmed" });
  expect((query.task as Event).status).toBe("cancelled");
  expect(denied).toBeDefined();
  expect((denied!.result as Event).isError).toBe(true);
  expect(resultText(denied)).toContain("task is cancelled");
  expectOneTask(final, "cancelled");
  expect(jobRecord(final).operations).toHaveLength(1);

  const stats = await service.stats();
  expect(stats.counters.cancelRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.submitRequests).toBe(1);
  expect(jobRecord(final).operations[0]!.taskRevision).toBe(1);
});

integration("B3a completion wins cancellation; old revision result is not retagged or accepted", async () => {
  const { service, session } = await setup("job-complete-cancel");
  await session.prompt("Please submit one experimental job.");
  const submitted = toolEnds(await session.snapshot(), "job-submit-complete");
  expect(submitted).toHaveLength(1);
  expect((resultDetails(submitted[0]).operation as Event).taskRevision).toBe(1);
  expect((await service.complete()).job.state).toBe("succeeded");

  await session.prompt("Please cancel the task and inspect the completed job.");
  const final = await session.snapshot();
  expectOneTask(final, "cancelled");
  const query = resultDetails(toolEnds(final, "job-query-complete")[0]);
  const denied = toolEnds(final, "job-submit-complete-denied")[0];
  expect((query.operation as Event).externalState).toBe("succeeded");
  expect((query.operation as Event).taskRevision).toBe(1);
  expect((query.operation as Event).cancelIntent).not.toBeNull();
  expect((query.task as Event).status).toBe("cancelled");
  expect((query.task as Event).taskRevision).toBe(1);
  expect(events(final, "fixtureAudit", "tool_call_emitted").filter((event) => event.toolCallId === "job-query-complete")).toHaveLength(1);
  expect(events(final, "fixtureAudit", "tool_call_emitted").filter((event) => event.toolCallId === "job-submit-complete-denied")).toHaveLength(1);
  expect(denied).toBeDefined();
  expect((denied!.result as Event).isError).toBe(true);
  expect(resultText(denied)).toContain("task is cancelled");

  const operation = jobRecord(final).operations[0]!;
  expect(operation.externalState).toBe("succeeded");
  expect(operation.taskRevision).toBe(1);
  expect(operation.cancelIntent).not.toBeNull();
  expect(jobRecord(final).operations).toHaveLength(1);
  const stats = await service.stats();
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.cancelRequests).toBe(1);
});

async function waitForStats(
  service: MockJobService,
  label: string,
  predicate: (stats: Awaited<ReturnType<MockJobService["stats"]>>) => boolean,
  timeoutMs = 10_000,
): Promise<Awaited<ReturnType<MockJobService["stats"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const stats = await service.stats();
    if (predicate(stats)) return stats;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out`);
    await Bun.sleep(20);
  }
}

async function waitForSnapshot(
  session: B1OmpSession,
  label: string,
  predicate: (snapshot: Snapshot) => boolean,
  timeoutMs = 10_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = await session.snapshot();
    if (predicate(snapshot)) return snapshot;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out`);
    await Bun.sleep(25);
  }
}

integration("B3b native query abort: genuine OMP signal ends the local HTTP wait; task and remote job unchanged", async () => {
  const { service, session } = await setup("job-abort-query", { observeToolSignal: true, jobTimeoutMs: 5_000 });
  await session.prompt("Please submit the one experimental job.");
  const submittedSnapshot = await session.snapshot();
  const submitted = jobRecord(submittedSnapshot).operations[0]!;
  expect(submitted.externalState).toBe("running");
  const operationId = submitted.operationId as string;
  const queriesBefore = (await service.stats()).counters.queryRequests;

  await service.configure({ delayedQueryMs: 3_000 });
  const pending = session.promptAborted("Please query the current job; the host will interrupt the wait.");
  const entered = await waitForToolTrace(session, "genuine tool entry", (event) =>
    event.type === "tool_enter" && event.id === "job-query-aborted");
  await waitForStats(service, "delayed query reached service", (stats) => stats.counters.queryRequests === queriesBefore + 1);
  const aborting = session.abort();
  await pending;
  await aborting;

  const signalAbort = await waitForToolTrace(session, "genuine tool signal abort", (event) =>
    event.type === "actual_signal_abort" && event.id === "job-query-aborted");
  const returned = await waitForToolTrace(session, "aborted tool return", (event) =>
    event.type === "tool_return" && event.id === "job-query-aborted");
  expect(entered.signalPresent).toBe(true);
  expect(Number(entered.at)).toBeLessThanOrEqual(Number(signalAbort.at));
  expect(signalAbort.signalPresent).toBe(true);
  expect(String(signalAbort.reason)).toContain("Interrupted by user");
  expect(returned.signalPresent).toBe(true);
  expect(returned.aborted).toBe(true);
  expect(returned.isError).toBe(true);
  expect(Number(returned.at) - Number(signalAbort.at)).toBeLessThan(1_500);
  expect(Number(returned.durationMs)).toBeLessThan(1_500);

  const interrupted = await waitForSnapshot(session, "aborted call recorded", (snapshot) => {
    const operation = jobRecord(snapshot).operations[0];
    if (!operation) return false;
    const calls = operation.calls as Event[];
    const observations = operation.observations as Event[];
    return calls.at(-1)?.outcome === "aborted"
      && observations.some((observation) => observation.source === "query_aborted");
  });
  const interruptedOperation = jobRecord(interrupted).operations[0]!;
  expect(interruptedOperation.externalState).toBe("running");
  expect(interruptedOperation.taskRevision).toBe(1);
  const interruptedObservations = interruptedOperation.observations as Event[];
  expect(interruptedObservations.filter((observation) => observation.source === "query")).toHaveLength(0);
  expectOneTask(interrupted, "active");
  expect((await service.stats()).counters.cancelRequests).toBe(0);

  await service.configure({ delayedQueryMs: 0 });
  await session.prompt("Please query the same job now.");
  const resumed = await session.snapshot();
  const resumedQuery = resultDetails(toolEnds(resumed, "job-query-after-abort")[0]);
  expect((resumedQuery.operation as Event).operationId).toBe(operationId);
  expect((resumedQuery.operation as Event).externalState).toBe("running");
  expect((resumedQuery.task as Event).status).toBe("active");
  expectOneTask(resumed, "active");
  const stats = await service.stats();
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.cancelRequests).toBe(0);
  expect(stats.counters.queryRequests).toBe(queriesBefore + 2);
});

integration("B3b native submit abort before acceptance: unknown original operation, late effect continues, later query reconciles without a duplicate POST", async () => {
  const { service, session } = await setup("job-abort-submit", { observeToolSignal: true, jobTimeoutMs: 5_000 });
  await service.configure({ holdSubmitAccept: true });
  const pending = session.promptAborted("Please submit the one experimental job; the host will interrupt the held acknowledgement.");
  await waitForStats(service, "held submit reached service", (stats) => stats.counters.submitRequests === 1);
  const aborting = session.abort();
  await pending;
  await aborting;

  const recorded = await waitForSnapshot(session, "aborted submit recorded", (snapshot) => {
    const operation = jobRecord(snapshot).operations[0];
    const calls = operation?.calls as Event[] | undefined;
    return calls?.at(-1)?.outcome === "aborted";
  });
  const operation = jobRecord(recorded).operations[0]!;
  expect(operation.externalState).toBe("unknown");
  expect(operation.dispatch).toBe("sent");
  expect(operation.externalJobId).toBeNull();
  expect(operation.taskRevision).toBe(1);
  expect((operation.observations as Event[]).some((observation) => observation.source === "submit_aborted")).toBe(true);
  const operationId = operation.operationId as string;
  const digest = operation.payloadDigest as string;
  expect((await service.stats()).counters.actualCreates).toBe(0);

  await service.releaseSubmit();
  const released = await waitForStats(service, "held submit created after abort", (stats) => stats.counters.actualCreates === 1);
  expect(released.counters.submitRequests).toBe(1);

  await session.prompt("Please query the original operation now.");
  const resumed = await session.snapshot();
  const query = resultDetails(toolEnds(resumed, "job-query-after-submit-abort")[0]);
  expect((query.operation as Event).operationId).toBe(operationId);
  expect((query.operation as Event).payloadDigest).toBe(digest);
  expect((query.operation as Event).externalState).toBe("running");
  expect((query.task as Event).status).toBe("active");
  expectOneTask(resumed, "active");
  const stats = await service.stats();
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.cancelRequests).toBe(0);
});

integration("B3b native submit abort after actual creation but held acknowledgement: unknown retained, job continues, query reconciles", async () => {
  const { service, session } = await setup("job-abort-submit", { observeToolSignal: true, jobTimeoutMs: 5_000 });
  await service.configure({ holdSubmitAck: true });
  const pending = session.promptAborted("Please submit the one job; the service will create it but the host will interrupt the held acknowledgement.");
  await waitForStats(service, "job created before held acknowledgement", (stats) =>
    stats.counters.submitRequests === 1 && stats.counters.actualCreates === 1);
  const created = await service.stats();
  expect(created.jobs[0]?.state).toBe("running");
  const pendingOperation = await waitForRecord(session, "pending held acknowledgement is unknown before abort", (operation) =>
    operation.dispatch === "sent" && operation.externalState === "unknown");
  expect(pendingOperation.accepted).toBe(false);
  expect(pendingOperation.externalJobId).toBeNull();
  const aborting = session.abort();
  await pending;
  await aborting;

  const recorded = await waitForSnapshot(session, "aborted accepted submit recorded", (snapshot) => {
    const operation = jobRecord(snapshot).operations[0];
    const calls = operation?.calls as Event[] | undefined;
    return calls?.at(-1)?.outcome === "aborted";
  });
  const operation = jobRecord(recorded).operations[0]!;
  expect(operation.externalState).toBe("unknown");
  expect(operation.dispatch).toBe("sent");
  expect(operation.accepted).toBe(false);
  expect(operation.externalJobId).toBeNull();
  expect(operation.taskRevision).toBe(1);
  const operationId = operation.operationId as string;
  expect((await service.stats()).counters.actualCreates).toBe(1);
  expect((await service.stats()).jobs[0]?.state).toBe("running");

  await service.releaseSubmitAck();
  await session.prompt("Please query the original operation after the held acknowledgement.");
  const resumed = await session.snapshot();
  const query = resultDetails(toolEnds(resumed, "job-query-after-submit-abort")[0]);
  expect((query.operation as Event).operationId).toBe(operationId);
  expect((query.operation as Event).externalState).toBe("running");
  expect(typeof (query.operation as Event).externalJobId).toBe("string");
  expect((query.task as Event).status).toBe("active");
  expectOneTask(resumed, "active");
  const stats = await service.stats();
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.cancelRequests).toBe(0);
});

integration("B3b native disconnect: OMP SIGKILL leaves the independent service job running; host controller observes it, not plugin recovery", async () => {
  const { service, session } = await setup("job-kill", { observeToolSignal: true });
  await session.prompt("Please submit the one experimental job.");
  const before = await session.snapshot();
  const operation = jobRecord(before).operations[0]!;
  expect(operation.externalState).toBe("running");
  const operationId = operation.operationId as string;
  const processId = session.processId!;

  await session.killProcessGroup("SIGKILL");
  await expect(async () => process.kill(-processId, 0)).toThrow();
  expect(() => process.kill(service.pid, 0)).not.toThrow();

  const controllerResponse = await fetch(`${service.endpoint}/jobs/${encodeURIComponent(operationId)}`);
  expect(controllerResponse.status).toBe(200);
  const controllerValue = await controllerResponse.json() as Event;
  expect(controllerValue.state).toBe("running");
  expect(controllerValue.operationId).toBe(operationId);

  const after = await session.snapshot();
  expect(jobRecord(after).operations).toHaveLength(1);
  expect(jobRecord(after).operations[0]!.operationId).toBe(operationId);
  expectOneTask(after, "active");
  const stats = await service.stats();
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.cancelRequests).toBe(0);
  expect(stats.counters.actualCancels).toBe(0);
  // Controller observation is not plugin recovery, task acceptance, or a
  // remote cancellation. The service is still running and no new submit exists.
});

integration("B3b native parallel submit/cancel: early 404 is unconfirmed, release converges on one confirmed same-intent cancel", async () => {
  const { service, session } = await setup("job-parallel-cancel", { observeToolSignal: true, jobTimeoutMs: 5_000 });
  await service.configure({ holdSubmitAccept: true, delayedQueryMs: 800 });
  const pending = session.prompt("Please submit one job and cancel the managed task in the same batch.");
  await waitForStats(service, "held submit reached service", (stats) => stats.counters.submitRequests === 1);
  const cancelled = await waitForSnapshot(session, "task cancellation committed", (snapshot) =>
    task(snapshot).status === "cancelled");
  expect(jobRecord(cancelled).operations[0]?.externalState).not.toBe("cancelled");
  await waitForStats(service, "early cancel and cleanup query", (stats) =>
    stats.counters.cancelRequests === 1 && stats.counters.queryRequests >= 1);
  expect((await service.stats()).counters.actualCreates).toBe(0);
  expect((await recordNow(session)).operations[0]?.cancelIntent).toMatchObject({
    attempts: 1,
    state: "requested_unconfirmed",
  });

  await service.releaseSubmit();
  await pending;
  const confirmed = await waitForRecord(session, "confirmed cancellation", (operation) => {
    const intent = operation.cancelIntent as Event | null;
    return intent?.state === "confirmed" && operation.externalState === "cancelled";
  });
  expect(confirmed.taskRevision).toBe(1);
  const final = await session.snapshot();
  expectOneTask(final, "cancelled");
  const emitted = events(final, "fixtureAudit", "tool_call_emitted");
  expect(emitted.filter((event) => event.toolCallId === "job-submit-raced")).toHaveLength(1);
  expect(emitted.filter((event) => event.toolCallId === "job-task-cancel-raced")).toHaveLength(1);
  expect(emitted.filter((event) => event.tool === "agent_job" && (event.arguments as Event)?.action === "cancel")).toHaveLength(0);
  const stats = await service.stats();
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expect(stats.counters.cancelRequests).toBeGreaterThanOrEqual(2);
  expect(stats.counters.actualCancels).toBe(1);
});

integration("B3b native revision/session replacement: old revision receipt retained; detached session is denied before HTTP while host cleanup finishes", async () => {
  const { service, session } = await setup("job-revise-replace", { observeToolSignal: true, jobTimeoutMs: 20_000, persistSessions: true });
  await session.prompt("Please submit the one experimental job at revision 1.");
  const submitted = jobRecord(await session.snapshot()).operations[0]!;
  const operationId = submitted.operationId as string;
  expect(submitted.taskRevision).toBe(1);

  await session.prompt("Please revise the requirement and then query the job.");
  const revised = await session.snapshot();
  const revisedQuery = resultDetails(toolEnds(revised, "job-query-after-revise")[0]);
  expect((revisedQuery.operation as Event).taskRevision).toBe(1);
  expect((revisedQuery.operation as Event).externalState).toBe("running");
  expect((revisedQuery.task as Event).taskRevision).toBe(2);
  expect((revisedQuery.task as Event).status).toBe("active");
  expectOneTaskAtRevision(revised, "active", 2);

  await service.configure({ holdCancelResponse: true });
  await session.prompt("Please cancel the managed task.");
  await waitForStats(service, "held cancellation response", (stats) => stats.counters.cancelRequests === 1);
  expectOneTaskAtRevision(await session.snapshot(), "cancelled", 2);
  const beforeReplacement = await service.stats();

  await session.newSession();
  await session.prompt("NEW_SESSION_JOB: query and submit the old job from the replacement session.");
  const replaced = await session.snapshot();
  const deniedQuery = toolEnds(replaced, "job-query-new-session")[0];
  const deniedSubmit = toolEnds(replaced, "job-submit-new-session")[0];
  expect(deniedQuery).toBeDefined();
  expect(deniedSubmit).toBeDefined();
  const jobReplay = events(replaced, "fixtureAudit", "replayed_task_ref").find((event) => event.branch === "new-session-job");
  expect(jobReplay).toBeDefined();
  expect(jobReplay?.source).toBe("tool-result");
  expect(typeof jobReplay?.sourceToolCallId).toBe("string");
  expect(typeof jobReplay?.sourceSequence).toBe("number");
  expect(events(replaced, "fixtureAudit", "observed_tool_result_ref")
    .some((event) => event.toolCallId === jobReplay?.sourceToolCallId
      && event.sequence === jobReplay?.sourceSequence
      && event.expectedTaskId === jobReplay?.expectedTaskId
      && event.expectedTaskRevision === jobReplay?.expectedTaskRevision)).toBe(true);
  for (const toolCallId of ["job-query-new-session", "job-submit-new-session"]) {
    const emitted = events(replaced, "fixtureAudit", "tool_call_emitted").find((event) => event.toolCallId === toolCallId);
    expect(emitted?.arguments).toMatchObject({
      expectedTaskId: jobReplay?.expectedTaskId,
      expectedTaskRevision: jobReplay?.expectedTaskRevision,
    });
  }
  expect((deniedQuery!.result as Event).isError).toBe(true);
  expect((deniedSubmit!.result as Event).isError).toBe(true);
  expect(resultText(deniedQuery)).toMatch(/unavailable|detached|different OMP session|anchor is not in the current conversation branch/);
  expect(resultText(deniedSubmit)).toMatch(/unavailable|detached|different OMP session|anchor is not in the current conversation branch/);
  const deniedStats = await service.stats();
  expect(deniedStats.counters.queryRequests).toBe(beforeReplacement.counters.queryRequests);
  expect(deniedStats.counters.submitRequests).toBe(beforeReplacement.counters.submitRequests);

  await service.releaseCancelResponse();
  const cleanup = await waitForRecord(session, "cleanup continues after session replacement", (operation) =>
    (operation.cancelIntent as Event | null)?.state === "confirmed");
  expect(cleanup.operationId).toBe(operationId);
  expect(cleanup.externalState).toBe("cancelled");
  const stats = await service.stats();
  expect(stats.counters.cancelRequests).toBe(1);
  expect(stats.counters.actualCancels).toBe(1);
  expect(stats.counters.submitRequests).toBe(1);
  expect(stats.counters.actualCreates).toBe(1);
  expectOneTaskAtRevision(await session.snapshot(), "cancelled", 2);
});
