import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ExecutionOmpSession } from "./harness/execution-run.ts";

const TEST_TIMEOUT = 90_000;
const integration: (name: string, fn: () => Promise<unknown>) => void = process.env.RUN_REAL_OMP_TEST === "1"
  ? (name, fn) => test(name, fn, TEST_TIMEOUT)
  : (name, fn) => test.skip(name, fn);

type Event = Record<string, unknown>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(scenario: string, options: { dispatchWallMs?: number } = {}): Promise<ExecutionOmpSession> {
  const session = await ExecutionOmpSession.create({
    scenario,
    timeoutMs: 25_000,
    ...(options.dispatchWallMs === undefined ? {} : { dispatchWallMs: options.dispatchWallMs }),
  });
  cleanups.push(async () => session.cleanup());
  await session.start();
  return session;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifacts(record: Event): Event[] {
  return Array.isArray(record.artifacts) ? record.artifacts as Event[] : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitGone(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

function watchdogOf(record: Event): Event {
  return record.watchdog as Event;
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(filePath).exists())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await Bun.sleep(20);
  }
}

integration("native G2-A1: real OMP registers agent_task/agent_execute, describe then run, and a host verifies the artifact", async () => {
  const session = await setup("normal");
  const inputBefore = await readFile(session.inputPath);
  await session.prompt("Run the local candidate against the authorized alpha input.");

  const snapshot = await session.snapshot();
  const record = snapshot.record!;
  expect(record.phase).toBe("completed");
  expect(record.taskRevision).toBe(1);
  expect(record.taskAccepted).toBe(false);
  expect(record.candidateOnly).toBe(true);
  const process = record.process as Event;
  expect(process.spawned).toBe(true);
  expect(process.exitCode).toBe(0);
  expect(process.groupGone).toBe(true);
  expect(process.stopReason).toBeNull();
  const watchdog = watchdogOf(record);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.ackSent).toBe(true);
  expect(watchdog.triggerReason).toBe("script_exit");
  expect(watchdog.watchdogExitObserved).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  expect(await waitGone(Number(process.pid))).toBe(true);
  expect(await waitGone(Number(watchdog.watchdogPid))).toBe(true);
  const events = await session.watchdogEvents();
  expect(events.some((event) => event.event === "armed")).toBe(true);
  expect(events.some((event) => event.event === "watchdog_exit")).toBe(true);

  const reported = artifacts(record);
  const artifact = reported.find((item) => item.relativePath === "native-result.txt");
  expect(artifact).toBeTruthy();
  const archived = await readFile(path.join(session.executionRoot, String(artifact!.archiveRef)));
  expect(`sha256:${sha256(archived)}`).toBe(String(artifact!.sha256));
  expect(archived.toString("utf8")).toBe(`${sha256(inputBefore)}\n`);
  expect(await readFile(session.inputPath)).toEqual(inputBefore);

  const emitted = snapshot.fixtureAudit
    .filter((event) => event.type === "tool_call_emitted")
    .map((event) => String(event.tool));
  expect(emitted).toContain("agent_task");
  expect(emitted.filter((name) => name === "agent_execute").length).toBe(2);
  const describeTurn = snapshot.fixtureAudit.find((event) =>
    event.type === "model_turn" && String(event.lastToolResult).includes("local Python/Bun candidate execution is available"));
  expect(describeTurn).toBeTruthy();
  const toolsSeen = snapshot.fixtureAudit.find((event) => event.type === "model_turn" && Array.isArray(event.tools));
  expect((toolsSeen!.tools as string[]).sort()).toEqual(["agent_execute", "agent_task"]);

  const completed = snapshot.executionAudit.filter((event) => event.type === "execution_completed");
  expect(completed.length).toBe(1);
  expect(snapshot.executionAudit.some((event) => event.type === "execution_failed")).toBe(false);
  expect(Number(completed[0]!.artifacts)).toBeGreaterThanOrEqual(1);

  // Tool success and exit 0 never auto-accept the task.
  expect(snapshot.audit.some((event) => event.type === "task_accepted")).toBe(false);
});

integration("native G2-A2: Bun candidate is verified and both script and watchdog are gone", async () => {
  const session = await setup("normal_bun");
  const inputBefore = await readFile(session.inputPath);
  await session.prompt("Run the local Bun candidate against the authorized alpha input.");
  const snapshot = await session.snapshot();
  const record = snapshot.record!;
  expect(record.phase).toBe("completed");
  const process = record.process as Event;
  expect(process.exitCode).toBe(0);
  expect(process.groupGone).toBe(true);
  const watchdog = watchdogOf(record);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.ackSent).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  expect(await waitGone(Number(process.pid))).toBe(true);
  expect(await waitGone(Number(watchdog.watchdogPid))).toBe(true);
  const artifact = artifacts(record).find((item) => item.relativePath === "native-result.txt");
  expect(artifact).toBeTruthy();
  const archived = await readFile(path.join(session.executionRoot, String(artifact!.archiveRef)));
  expect(`sha256:${sha256(archived)}`).toBe(String(artifact!.sha256));
  expect(archived.toString("utf8")).toBe(`${sha256(inputBefore)}\n`);
  expect(await readFile(session.inputPath)).toEqual(inputBefore);
  expect(snapshot.executionAudit.some((event) => event.type === "execution_failed")).toBe(false);
});

integration("native G2-A2: SIGKILL of OMP leaves the watchdog to terminate the script without a completion marker", async () => {
  const session = await setup("host_death", { dispatchWallMs: 10_000 });
  try {
    const pending = session.prompt("Run the supervised candidate; the host will be killed.").catch(() => undefined);
    const armedRecord = await session.waitForArmed();
    const process = armedRecord.process as Event;
    const watchdog = watchdogOf(armedRecord);
    const runDir = (await session.latestRunDir())!;
    const workDir = path.join(runDir, "work");
    await waitForFile(path.join(workDir, "ready.marker"));
    const marker = Number((await readFile(path.join(workDir, "ready.marker"), "utf8")).trim());
    expect(marker).toBe(Number(process.pid));
    expect(watchdog.armed).toBe(true);
    expect(watchdog.watchdogPid).not.toBe(1);
    expect(watchdog.scriptPid).toBe(process.pid);
    expect(Number(watchdog.watchdogSid)).toBe(Number(watchdog.watchdogPid));

    await session.killHostGroup();

    // Check absence before any fallback cleanup. These PIDs are the original
    // trusted control-record IDs, not values read from script stdout.
    const scriptGone = await waitGone(Number(process.pid), 4000);
    const watchdogGone = await waitGone(Number(watchdog.watchdogPid), 4000);
    expect(scriptGone).toBe(true);
    expect(watchdogGone).toBe(true);
    expect(await Bun.file(path.join(workDir, "finished.txt")).exists()).toBe(false);
    expect((await readFile(path.join(workDir, "fd3.txt"), "utf8")).trim()).not.toBe("writable");
    const events = await session.watchdogEvents();
    const trigger = events.find((event) => event.event === "trigger");
    expect(trigger?.reason).toBe("supervisor_exit");
    expect(events.some((event) => event.event === "term_sent")).toBe(true);
    expect(events.some((event) => event.event === "kill_sent")).toBe(true);
    expect(events.some((event) => event.event === "watchdog_exit")).toBe(true);
    await pending;
  } finally {
    await session.cleanup();
  }
});

integration("native G2-A2: independent deadline stops the script while the OMP timer is stalled", async () => {
  const session = await setup("deadline_watchdog", { dispatchWallMs: 600 });
  try {
    const pending = session.prompt("Run the supervised candidate; the host will stall.").catch(() => undefined);
    const armedRecord = await session.waitForArmed();
    const process = armedRecord.process as Event;
    const watchdog = watchdogOf(armedRecord);
    const runDir = (await session.latestRunDir())!;
    const workDir = path.join(runDir, "work");
    await waitForFile(path.join(workDir, "ready.marker"));
    const marker = Number((await readFile(path.join(workDir, "ready.marker"), "utf8")).trim());
    expect(marker).toBe(Number(process.pid));

    await session.signalHostGroup("SIGSTOP");
    await Bun.sleep(1800);
    await session.signalHostGroup("SIGCONT");
    await pending;

    const scriptGone = await waitGone(Number(process.pid), 4000);
    const watchdogGone = await waitGone(Number(watchdog.watchdogPid), 4000);
    expect(scriptGone).toBe(true);
    expect(watchdogGone).toBe(true);
    expect(await Bun.file(path.join(workDir, "finished.txt")).exists()).toBe(false);
    const events = await session.watchdogEvents();
    const trigger = events.find((event) => event.event === "trigger");
    expect(trigger?.reason).toBe("absolute_deadline");
    expect(events.some((event) => event.event === "term_sent")).toBe(true);
    expect(events.some((event) => event.event === "kill_sent" || event.event === "watchdog_exit")).toBe(true);
    const finalRecord = await session.latestExecutionRecord();
    expect((finalRecord?.watchdog as Event | undefined)?.triggerReason).toBe("absolute_deadline");
  } finally {
    await session.cleanup();
  }
});

integration("native G2-A1: genuine user cancellation stops a long running script and does not accept the task", async () => {
  const session = await setup("cancel", { dispatchWallMs: 8_000 });
  await session.prompt("Start the candidate, then cancel the managed task while it runs.");

  const snapshot = await session.snapshot();
  const record = snapshot.record!;
  expect(record.phase).toBe("completed");
  expect(record.taskRevision).toBe(1);
  const process = record.process as Event;
  expect(process.spawned).toBe(true);
  expect(process.groupGone).toBe(true);
  expect(process.stopReason).toBe("owner_cancelled");
  expect(Number(process.durationMs)).toBeLessThan(7_000);
  expect(record.taskAccepted).toBe(false);
  const watchdog = watchdogOf(record);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  expect(await waitGone(Number(process.pid))).toBe(true);
  expect(await waitGone(Number(watchdog.watchdogPid))).toBe(true);
  expect(snapshot.audit.some((event) => event.type === "task_cancelled")).toBe(true);
  expect(snapshot.executionAudit.some((event) => event.type === "execution_owner_stop")).toBe(true);

  // The real agent_task cancel was forwarded only after the sandbox script
  // published its own ready marker; no extra authority tool existed.
  const toolsSeen = snapshot.fixtureAudit.find((event) => event.type === "model_turn" && Array.isArray(event.tools));
  expect((toolsSeen!.tools as string[]).sort()).toEqual(["agent_execute", "agent_task"]);
  const emitted = snapshot.fixtureAudit
    .filter((event) => event.type === "tool_call_emitted")
    .map((event) => String(event.tool));
  expect(emitted.filter((name) => name === "agent_task").length).toBe(2);
  expect(emitted).not.toContain("agent_test_delay_cancel");
  const forwarded = snapshot.fixtureAudit.find((event) =>
    event.type === "task_entry_cancel_gate" && event.event === "forwarded");
  expect(forwarded).toBeTruthy();
  expect(forwarded!.tool).toBe("agent_task");
  expect(forwarded!.action).toBe("cancel");
  expect(forwarded!.pid).toBe(Number(process.pid));
  expect(Number(forwarded!.marker)).toBe(Number(process.pid));
  expect(String(forwarded!.markerPath)).toContain("ready.marker");
});

integration("native G2-A1: an RPC abort of the agent stops the actual running process without cancelling the task", async () => {
  const session = await setup("abort", { dispatchWallMs: 10_000 });
  const completed = await session.promptAbortedWhileRunning("Run the long candidate; the host will interrupt the agent.");
  expect(completed.phase).toBe("completed");

  const snapshot = await session.snapshot();
  const record = snapshot.record!;
  expect(record.phase).toBe("completed");
  const process = record.process as Event;
  expect(process.spawned).toBe(true);
  expect(process.groupGone).toBe(true);
  expect(process.stopReason).toBe("abort_signal");
  expect(record.taskAccepted).toBe(false);
  const watchdog = watchdogOf(record);
  expect(watchdog.armed).toBe(true);
  expect(watchdog.watchdogTerminated).toBe(true);
  expect(await waitGone(Number(process.pid))).toBe(true);
  expect(await waitGone(Number(watchdog.watchdogPid))).toBe(true);
  expect(snapshot.audit.some((event) => event.type === "task_cancelled")).toBe(false);
  expect(snapshot.executionAudit.some((event) => event.type === "execution_owner_stop")).toBe(false);
});
