import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import {
  ANSWER_PREFIX,
  DeliveryOmpSession,
  processAlive,
  sha256,
  snapshotTree,
  type DeliveryFileSnapshot,
  type DeliveryMode,
} from "./harness/delivery-run.ts";

const TEST_TIMEOUT = 120_000;
const integration: (name: string, fn: () => Promise<unknown>) => void = process.env.RUN_REAL_OMP_TEST === "1"
  ? (name, fn) => test(name, fn, TEST_TIMEOUT)
  : (name, fn) => test.skip(name, fn);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(mode: DeliveryMode): Promise<DeliveryOmpSession> {
  const session = await DeliveryOmpSession.create({ mode, timeoutMs: 30_000 });
  cleanups.push(async () => session.cleanup());
  await session.start();
  return session;
}

type Event = Record<string, any>;

function observation(events: Event[], toolCallId: string): Event {
  const found = events.find((event) => event.type === "tool_observation" && event.toolCallId === toolCallId);
  if (!found) throw new Error(`missing actual tool observation ${toolCallId}; saw ${events.filter((event) => event.type === "tool_observation").map((event) => event.toolCallId).join(",")}`);
  return found;
}

function facts(event: Event): Record<string, any> {
  return JSON.parse(String(event.content)) as Record<string, any>;
}

function contentLine(content: string, key: string): string {
  const line = content.split("\n").find((item) => item.startsWith(`${key}: `));
  if (!line) throw new Error(`missing actual content field ${key}`);
  return line.slice(key.length + 2);
}

function previewFiles(event: Event): Array<{ path: string; sha256: string; bytes: number; name: string; relativePath: string }> {
  return JSON.parse(contentLine(String(event.content), "files")) as Array<{
    path: string; sha256: string; bytes: number; name: string; relativePath: string;
  }>;
}

function comparable(files: DeliveryFileSnapshot[]): Array<Record<string, unknown>> {
  return files.map(({ relativePath, bytes, sha256: digest, ino, dev, mtimeMs, nlink, mode }) => ({
    relativePath, bytes, sha256: digest, ino, dev, mtimeMs, nlink, mode,
  }));
}

function assertCleanProcesses(record: Event): void {
  const child = record.process as Event;
  const watchdog = record.watchdog as Event;
  expect(child.spawned).toBe(true);
  expect(child.exitCode).toBe(0);
  expect(child.groupGone).toBe(true);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  expect(processAlive(Number(child.pid), true)).toBe(false);
  expect(processAlive(Number(watchdog.watchdogPid))).toBe(false);
}

async function assertCleanShutdown(session: DeliveryOmpSession): Promise<void> {
  const before = await session.fixtureEvents();
  const beforeShutdown = before.find((event) => event.type === "agent_end_fixture");
  expect(beforeShutdown).toBeTruthy();
  const shutdown = await session.shutdown();
  expect(shutdown.fallback).toEqual([]);
  expect(shutdown.exitCode).toBe(0);
  expect(shutdown.exitSignal).toBeNull();
  expect(shutdown.processGroupGone).toBe(true);
  expect(shutdown.fixtureShutdown).toBe(true);
  const after = await session.fixtureEvents();
  const closed = after.find((event) => event.type === "session_shutdown_fixture");
  expect(closed).toBeTruthy();
  expect(closed!.owner.currentTask).toEqual(beforeShutdown!.owner.currentTask);
  expect(comparable(closed!.acceptance)).toEqual(comparable(beforeShutdown!.acceptance));
}

integration("native delivery: actual task/run/verify/preview/submit/inspect chain commits once and survives retry and late tools", async () => {
  const session = await setup("full");
  const inputBefore = await session.inputBytes();
  const expectedAnswer = Buffer.concat([ANSWER_PREFIX, inputBefore]);
  await session.prompt();
  const events = await session.fixtureEvents();

  const contract = events.find((event) => event.type === "contract_bound");
  expect(contract).toMatchObject({ mode: "full", complete: true });
  const validators = events.filter((event) => event.type === "validator");
  expect(validators).toHaveLength(1);
  expect(validators[0]).toMatchObject({ pass: true, actualSha256: sha256(expectedAnswer), artifactSha256: sha256(expectedAnswer) });

  const preview = observation(events, "delivery-preview");
  expect(preview.isError).not.toBe(true);
  expect(String(preview.content)).toContain("acceptanceConfigured: true");
  const delivered = previewFiles(preview);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.relativePath).toBe("answer.txt");
  expect(delivered[0]!.sha256).toBe(sha256(expectedAnswer));
  expect(delivered[0]!.bytes).toBe(expectedAnswer.length);
  expect(delivered[0]!.path.startsWith(session.deliveryRoot + "/")).toBe(true);
  const deliveredBytes = await readFile(delivered[0]!.path);
  expect(deliveredBytes).toEqual(expectedAnswer);
  expect(sha256(deliveredBytes)).toBe(delivered[0]!.sha256);

  const previewDigest = contentLine(String(preview.content), "previewDigest");
  expect(previewDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  const runEvent = observation(events, "delivery-run");
  const runId = /^run runId="([^"]+)"/m.exec(String(runEvent.content))?.[1];
  expect(runId).toBeTruthy();
  const receiptEvent = observation(events, "delivery-verify");
  const receiptId = /^receiptId: (\S+)$/m.exec(String(receiptEvent.content))?.[1];
  expect(receiptId).toBeTruthy();
  const hostReceipt = events.find((event) => event.type === "host_receipt" && event.receiptId === receiptId);
  expect(hostReceipt?.lookup?.receipt?.outcome).toBe("pass");
  expect(hostReceipt?.lookup?.receipt?.taskAccepted).toBe(false);

  const submitted = observation(events, "delivery-submit");
  expect(submitted.isError).not.toBe(true);
  const submitFacts = facts(submitted);
  expect(submitFacts.operation).toMatchObject({ outcome: "committed", operationCommitted: true, newCommit: true });
  expect(submitFacts.taskAccepted).toBe(true);
  expect(submitFacts.visibility.state).toBe("visible");
  expect(submitFacts.paths.available).toBe(true);
  expect(submitFacts.files).toHaveLength(1);
  expect(submitFacts.files[0].path).toBe(delivered[0]!.path);
  expect(submitFacts.files[0].sha256).toBe(delivered[0]!.sha256);
  const acceptance = submitFacts.acceptance;
  expect(acceptance.acceptanceId).toMatch(/^acceptance-/);
  expect(acceptance.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

  const acceptedFiles = await session.acceptanceFiles();
  expect(acceptedFiles).toHaveLength(1);
  const recordFile = acceptedFiles[0]!;
  expect(recordFile.sha256).toBe(acceptance.recordDigest);
  expect(recordFile.nlink).toBe(1);
  expect(recordFile.mode & 0o222).toBe(0);
  const record = JSON.parse(recordFile.text) as Record<string, any>;
  expect(record.acceptanceId).toBe(acceptance.acceptanceId);
  expect(record.task.taskId).toBe(submitFacts.selectors.expectedTaskId);
  expect(record.task.taskRevision).toBe(submitFacts.selectors.expectedTaskRevision);
  expect(record.delivery.deliveryId).toBe(submitFacts.selectors.deliveryId);
  expect(record.delivery.runId).toBe(runId);
  expect(record.delivery.previewDigest).toBe(previewDigest);
  expect(record.delivery.artifactIds).toEqual([submitFacts.files[0].artifactId]);
  expect(record.delivery.files[0].sha256).toBe(delivered[0]!.sha256);
  expect(record.candidate.runId).toBe(runId);
  expect(record.candidate.artifacts).toHaveLength(1);
  expect(record.candidate.artifacts[0].sha256).toBe(delivered[0]!.sha256);
  expect(record.receipt.receipt.receiptId).toBe(receiptId);
  expect(record.receipt.receipt.candidates.runId).toBe(runId);
  expect(record.receipt.receipt.outcome).toBe("pass");
  expect(record.contract.coverage.complete).toBe(true);
  expect(recordFile.text).not.toContain("DELIVERY_FIXTURE_SECRET_MUST_NOT_EXPORT");

  const owner = await session.owner();
  expect(owner?.tasksCreated).toBe(1);
  expect(owner?.currentTask.status).toBe("accepted");
  expect(owner?.currentTask.acceptance.acceptanceId).toBe(acceptance.acceptanceId);
  expect(owner?.currentTask.acceptance.recordDigest).toBe(acceptance.recordDigest);
  expect(events.filter((event) => event.type === "owner_event" && event.event?.type === "task_accepted")).toHaveLength(1);

  const records = await session.executionRecords();
  expect(records).toHaveLength(1);
  assertCleanProcesses(records[0]!);
  const artifact = records[0]!.artifacts[0];
  const archived = await readFile(`${session.executionRoot}/${artifact.archiveRef}`);
  expect(archived).toEqual(expectedAnswer);
  expect(sha256(archived)).toBe(artifact.sha256);

  const inspected = observation(events, "delivery-inspect");
  expect(inspected.isError).not.toBe(true);
  const inspectFacts = facts(inspected);
  expect(inspectFacts.operation.readOnly).toBe(true);
  expect(inspectFacts.taskAccepted).toBe(true);
  expect(inspectFacts.acceptance.acceptanceId).toBe(acceptance.acceptanceId);
  expect(inspectFacts.paths.available).toBe(true);
  expect(inspectFacts.files[0].path).toBe(delivered[0]!.path);
  expect(inspectFacts.files[0].sha256).toBe(delivered[0]!.sha256);

  const retried = observation(events, "delivery-submit-repeat");
  expect(retried.isError).not.toBe(true);
  const retryFacts = facts(retried);
  expect(retryFacts.operation).toMatchObject({ outcome: "committed", operationCommitted: true, idempotent: true, newCommit: false });
  expect(retryFacts.selectors).toEqual(submitFacts.selectors);
  expect(retryFacts.acceptance.acceptanceId).toBe(acceptance.acceptanceId);
  expect(retryFacts.acceptance.recordDigest).toBe(acceptance.recordDigest);
  expect(comparable(retried.acceptance)).toEqual(comparable(submitted.acceptance));
  expect(comparable(retried.delivery)).toEqual(comparable(submitted.delivery));
  expect(await readFile(recordFile.path)).toEqual(Buffer.from(recordFile.text, "utf8"));
  expect((await session.acceptanceFiles())[0]!.ino).toBe(recordFile.ino);

  const lateRun = observation(events, "delivery-late-run");
  expect(lateRun.isError).toBe(true);
  const lateCancel = observation(events, "delivery-late-cancel");
  expect(lateCancel.isError).toBe(true);
  const lateRevise = observation(events, "delivery-late-revise");
  expect(lateRevise.isError).toBe(true);
  for (const event of [lateRun, lateCancel, lateRevise]) {
    expect(event.owner.currentTask.status).toBe("accepted");
    expect(event.owner.currentTask.taskId).toBe(owner!.currentTask.taskId);
    expect(event.owner.currentTask.taskRevision).toBe(owner!.currentTask.taskRevision);
    expect(comparable(event.acceptance)).toEqual(comparable(submitted.acceptance));
  }
  expect(await session.executionRecords()).toHaveLength(1);
  expect(existsSync(`${records[0]!._directory}/work/LATE_SIDE_EFFECT.txt`)).toBe(false);
  expect((await snapshotTree(session.executionRoot)).some((file) => file.relativePath.includes("LATE_SIDE_EFFECT"))).toBe(false);

  const inspectedAgain = observation(events, "delivery-inspect-after-guards");
  expect(inspectedAgain.isError).not.toBe(true);
  expect(facts(inspectedAgain).acceptance.acceptanceId).toBe(acceptance.acceptanceId);
  const taskInspect = observation(events, "delivery-task-inspect");
  expect(taskInspect.isError).not.toBe(true);
  expect(facts(taskInspect).task.status).toBe("accepted");
  expect(await session.inputBytes()).toEqual(inputBefore);

  await assertCleanShutdown(session);
});

integration("native delivery: deliveryRoot without acceptanceRoot previews honestly and refuses submit/inspect", async () => {
  const session = await setup("delivery-only");
  await session.prompt();
  const events = await session.fixtureEvents();

  expect(session.acceptanceRoot).toBeNull();
  expect(existsSync(`${session.root}/acceptance`)).toBe(false);
  expect(events.some((event) => event.type === "contract_bound")).toBe(false);
  expect(events.filter((event) => event.type === "validator")).toHaveLength(0);

  const preview = observation(events, "delivery-preview");
  expect(preview.isError).not.toBe(true);
  const content = String(preview.content);
  expect(content).toContain("acceptanceConfigured: false");
  expect(content).toContain("submissionAvailable: false");
  expect(content).toContain("deliveryId: delivery-");
  expect(previewFiles(preview)).toHaveLength(1);

  const submit = observation(events, "delivery-submit-unconfigured");
  expect(submit.isError).toBe(true);
  const submitFacts = facts(submit);
  expect(submitFacts.acceptanceConfigured).toBe(false);
  expect(submitFacts.operation.outcome).toBe("not_committed");
  expect(submitFacts.operation.operationCommitted).toBe(false);
  expect(submitFacts.taskAccepted).toBe(false);
  expect(submitFacts.files).toBeNull();
  expect(submitFacts.paths.available).toBe(false);
  expect(submitFacts.acceptance.acceptanceId).toBeNull();
  expect(String(submit.content)).toContain("acceptance root");

  const inspect = observation(events, "delivery-inspect-unconfigured");
  expect(inspect.isError).toBe(true);
  const inspectFacts = facts(inspect);
  expect(inspectFacts.acceptanceConfigured).toBe(false);
  expect(inspectFacts.outcome).toBe("not_inspected");
  expect(inspectFacts.taskAccepted).toBe(false);
  expect(inspectFacts.files).toBeNull();
  expect(inspectFacts.paths.available).toBe(false);
  expect(inspectFacts.acceptance.acceptanceId).toBeNull();

  const owner = await session.owner();
  expect(owner?.tasksCreated).toBe(1);
  expect(owner?.currentTask.status).toBe("active");
  expect(owner?.currentTask.acceptance).toBeNull();
  expect((await session.acceptanceFiles())).toEqual([]);
  expect(events.filter((event) => event.type === "owner_event" && event.event?.type === "task_accepted")).toHaveLength(0);
  const records = await session.executionRecords();
  expect(records).toHaveLength(1);
  assertCleanProcesses(records[0]!);
  await assertCleanShutdown(session);
});

integration("native delivery: explicit partial coverage can locally pass yet commits no record and stays active", async () => {
  const session = await setup("partial");
  await session.prompt();
  const events = await session.fixtureEvents();

  const contract = events.find((event) => event.type === "contract_bound");
  expect(contract).toMatchObject({ mode: "partial", complete: false });
  const validators = events.filter((event) => event.type === "validator");
  expect(validators).toHaveLength(1);
  expect(validators[0]!.pass).toBe(true);

  const preview = observation(events, "delivery-preview");
  expect(preview.isError).not.toBe(true);
  const hostReceipt = events.find((event) => event.type === "host_receipt");
  expect(hostReceipt?.lookup?.receipt?.outcome).toBe("insufficient");
  expect(hostReceipt?.lookup?.receipt?.conditions?.[0]?.result).toBe("pass");

  const submit = observation(events, "delivery-submit-partial");
  expect(submit.isError).toBe(true);
  const submitFacts = facts(submit);
  expect(submitFacts.operation.outcome).toBe("not_committed");
  expect(submitFacts.operation.operationCommitted).toBe(false);
  expect(submitFacts.taskAccepted).toBe(false);
  expect(submitFacts.acceptance.acceptanceId).toBeNull();
  expect(submitFacts.files).toBeNull();
  expect(submitFacts.paths.available).toBe(false);
  expect(String(submit.content)).toContain("insufficient");

  const inspect = observation(events, "delivery-inspect-partial");
  const inspectFacts = facts(inspect);
  expect(inspectFacts.outcome).toBe("not_accepted");
  expect(inspectFacts.acceptance.historyCommitted).toBe(false);
  expect(inspectFacts.acceptance.acceptanceId).toBeNull();
  expect(inspectFacts.files).toBeNull();
  expect(inspectFacts.paths.available).toBe(false);

  const taskInspect = observation(events, "delivery-task-inspect-partial");
  expect(taskInspect.isError).not.toBe(true);
  expect(facts(taskInspect).task.status).toBe("active");
  expect(events.filter((event) => event.type === "validator")).toHaveLength(1);

  const owner = await session.owner();
  expect(owner?.tasksCreated).toBe(1);
  expect(owner?.currentTask.status).toBe("active");
  expect(owner?.currentTask.acceptance).toBeNull();
  expect(await session.acceptanceFiles()).toEqual([]);
  expect(events.filter((event) => event.type === "owner_event" && event.event?.type === "task_accepted")).toHaveLength(0);
  const records = await session.executionRecords();
  expect(records).toHaveLength(1);
  assertCleanProcesses(records[0]!);
  await assertCleanShutdown(session);
});

integration("native delivery: an early assertion failure still verifies actual execution processes before cleanup", async () => {
  const session = await setup("full");
  await session.prompt();
  const records = await session.executionRecords();
  expect(records).toHaveLength(1);
  const child = records[0]!.process as Event;
  const watchdog = records[0]!.watchdog as Event;
  expect(child.spawned).toBe(true);
  expect(child.groupGone).toBe(true);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  const scriptPid = Number(child.pid);
  const scriptPgid = Number(child.pgid);
  const watchdogPid = Number(watchdog.watchdogPid);
  expect(processAlive(scriptPid)).toBe(false);
  expect(processAlive(scriptPgid, true)).toBe(false);
  expect(processAlive(watchdogPid)).toBe(false);

  let earlyFailure: unknown;
  try {
    expect(records).toHaveLength(2);
  } catch (error) {
    earlyFailure = error;
  }
  expect(earlyFailure).toBeInstanceOf(Error);

  await session.cleanup();
  expect(existsSync(session.root)).toBe(false);
  expect(processAlive(scriptPid)).toBe(false);
  expect(processAlive(scriptPgid, true)).toBe(false);
  expect(processAlive(watchdogPid)).toBe(false);
});

integration("native delivery: cleanup fails closed when a completed run has unknown watchdog identity", async () => {
  const session = await setup("full");
  await session.prompt();
  const records = await session.executionRecords();
  expect(records).toHaveLength(1);
  const record = records[0]!;
  const child = record.process as Event;
  const watchdog = record.watchdog as Event;
  expect(record.phase).toBe("completed");
  expect(child.spawned).toBe(true);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  const scriptPid = Number(child.pid);
  const scriptPgid = Number(child.pgid);
  const watchdogPid = Number(watchdog.watchdogPid);
  expect(processAlive(scriptPid)).toBe(false);
  expect(processAlive(scriptPgid, true)).toBe(false);
  expect(processAlive(watchdogPid)).toBe(false);

  const recordPath = `${record._directory}/record.json`;
  const original = await readFile(recordPath);
  // Harness fault injection, not a product result: replace only the completed
  // watchdog handshake with unknown identity evidence while retaining the
  // actual script pid/pgid. Cleanup must not infer "no watcher" from it.
  const injected = JSON.parse(original.toString("utf8")) as Event;
  (injected.process as Event).watchdog = { armed: false };
  delete injected.watchdog;
  const injectedBytes = Buffer.from(`${JSON.stringify(injected, null, 2)}\n`, "utf8");
  try {
    await writeFile(recordPath, injectedBytes);
    let failure: unknown;
    try {
      await session.cleanup();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("process evidence unavailable");
    expect((failure as Error).message).toContain("evidence is insufficient");
    expect((failure as Error).message).toContain(`retaining ${session.root}`);
    expect(existsSync(session.root)).toBe(true);
    expect(await readFile(recordPath)).toEqual(injectedBytes);
  } finally {
    if (existsSync(session.root)) await writeFile(recordPath, original);
  }

  await session.cleanup();
  expect(existsSync(session.root)).toBe(false);
  for (const [pid, group] of [[scriptPid, false], [scriptPgid, true], [watchdogPid, false]] as const) {
    expect(processAlive(pid, group)).toBe(false);
  }
});
