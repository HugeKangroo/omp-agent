import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { B1OmpSession } from "./harness/b1-run.ts";
import { MockJobService } from "./harness/job-service.ts";

const integration = process.env.RUN_REAL_OMP_TEST === "1" ? test : test.skip;
const TEST_TIMEOUT = 90_000;

type Event = Record<string, unknown>;
type Snapshot = Awaited<ReturnType<B1OmpSession["snapshot"]>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(scenario: string): Promise<{
  service: MockJobService;
  session: B1OmpSession;
}> {
  const service = await MockJobService.start();
  const session = await B1OmpSession.create({
    scenario,
    timeoutMs: 20_000,
    jobs: { endpoint: service.endpoint, timeoutMs: 1_000 },
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
  const owner = ownerState(snapshot);
  expect(owner.tasksCreated).toBe(1);
  const current = task(snapshot);
  expect(typeof current.taskId).toBe("string");
  expect(current.status).toBe(status);
  expect(current.taskRevision).toBe(1);
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
