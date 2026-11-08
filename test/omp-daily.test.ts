import { afterAll, expect, test } from "bun:test";
import { realpath, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  processAlive,
  sha256,
  snapshotTree,
  type DeliveryFileSnapshot,
} from "./harness/delivery-run.ts";
import {
  DAILY_MANAGED_TOOLS,
  DAILY_NATIVE_BYTES,
  DAILY_PROMPTS,
  DailyOmpSession,
  type DailyInstance,
} from "./harness/daily-run.ts";

const TEST_TIMEOUT = 180_000;
const integration: (name: string, fn: () => Promise<unknown>, timeout?: number) => void =
  process.env.RUN_REAL_OMP_TEST === "1"
    ? (name, fn, timeout) => test(name, fn, timeout ?? TEST_TIMEOUT)
    : (name, fn) => test.skip(name, fn);

const cleanups: Array<() => Promise<void>> = [];
let firstSession: DailyOmpSession | undefined;
let firstInstance: DailyInstance | undefined;
let restartedSession: DailyOmpSession | undefined;

afterAll(async () => {
  const cleanupFailures: string[] = [];
  while (cleanups.length) {
    const cleanup = cleanups.pop()!;
    try {
      await cleanup();
    } catch (error) {
      cleanupFailures.push((error as Error).message);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `[daily-test] ${cleanupFailures.length} cleanup failure(s) after test execution:\n${cleanupFailures.join("\n")}`,
    );
  }
});

type Event = Record<string, any>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function contentLine(content: string, key: string): string {
  const line = content.split("\n").find((item) => item.startsWith(`${key}: `));
  if (!line) throw new Error(`missing actual content field ${key}`);
  return line.slice(key.length + 2);
}

function previewFiles(event: Event): Array<{
  artifactId: string;
  path: string;
  sha256: string;
  bytes: number;
  name: string;
  relativePath: string;
}> {
  return JSON.parse(contentLine(String(event.content), "files")) as Array<{
    artifactId: string;
    path: string;
    sha256: string;
    bytes: number;
    name: string;
    relativePath: string;
  }>;
}

function observation(events: Event[], toolCallId: string): Event {
  const found = events.find((event) => event.type === "tool_result" && event.toolCallId === toolCallId);
  if (!found) {
    throw new Error(
      `missing actual observer tool_result ${toolCallId}; saw ${events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.toolCallId)
        .join(",")}`,
    );
  }
  return found;
}

function turns(events: Event[], marker: string): Event[] {
  return events
    .filter((event) => event.type === "model_turn" && event.marker === marker)
    .sort((left, right) => Number(left.step) - Number(right.step));
}

/**
 * Return the actual agent_deliver schema OMP placed in the model request,
 * verified against its recorded digest. This is the schema the model saw, not
 * a test-local copy.
 */
function deliverSchema(turn: Event): Event {
  const schema = turn.agentDeliverSchema as Event | null;
  expect(schema).toBeTruthy();
  expect(schema!.source).toBe("context.tools");
  expect(schema!.name).toBe("agent_deliver");
  expect(schema!.parametersTruncated).toBe(false);
  expect(typeof schema!.parametersJson).toBe("string");
  expect(schema!.schemaSha256).toBe(sha256(String(schema!.parametersJson)));
  expect(turn.model).toEqual({ provider: "daily-fixture", api: "daily-fixture-api", id: "scripted" });
  return JSON.parse(String(schema!.parametersJson)) as Event;
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

function withinOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function expectCanonicalDisjoint(
  roots: Array<{ label: string; path: string }>,
): Promise<void> {
  for (const root of roots) {
    expect(await realpath(root.path), `${root.label} is not canonical`).toBe(root.path);
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      expect(
        withinOrEqual(roots[left]!.path, roots[right]!.path)
          || withinOrEqual(roots[right]!.path, roots[left]!.path),
        `${roots[left]!.label} overlaps ${roots[right]!.label}`,
      ).toBe(false);
    }
  }
}

integration("case 1: one daily load preserves native tools and executes A cancelled -> B with real insufficient evidence", async () => {
  const baseline = await DailyOmpSession.create({ mode: "baseline", timeoutMs: 45_000 });
  cleanups.push(async () => baseline.cleanup());
  let baselineTools: string[] = [];
  try {
    const baselineStart = await baseline.start();
    baselineTools = baselineStart.toolNames;
    expect(baselineTools).toContain("read");
    for (const name of DAILY_MANAGED_TOOLS) expect(baselineTools).not.toContain(name);
    expect(new Set(baselineTools).size).toBe(baselineTools.length);
    expect(await baseline.providerEvents()).toEqual([]);
    const baselineShutdown = await baseline.shutdown();
    expect(baselineShutdown.fallback).toEqual([]);
    expect(baselineShutdown.exitCode).toBe(0);
    expect(baselineShutdown.exitSignal).toBeNull();
    expect(baselineShutdown.processGroupGone).toBe(true);
    await baseline.cleanup();
  } catch (error) {
    baseline.markFailure(error);
    throw error;
  }

  const session = await DailyOmpSession.create({
    mode: "daily",
    baselineTools,
    timeoutMs: 45_000,
  });
  firstSession = session;
  cleanups.push(async () => session.cleanup());

  try {
    const start = await session.start();
    firstInstance = start.instance;
    expect(firstInstance).toBeTruthy();
    const expectedTools = [...baselineTools, ...DAILY_MANAGED_TOOLS].sort();
    expect(start.toolNames).toEqual(expectedTools);
    expect(new Set(start.toolNames).size).toBe(start.toolNames.length);
    expect(start.toolNames).toContain("read");

    const initialEvents = await session.observerEvents();
    const startup = initialEvents.find((event) => event.type === "observer_startup");
    const sessionStart = initialEvents.find((event) => event.type === "session_start");
    expect(startup).toBeTruthy();
    expect(sessionStart).toBeTruthy();
    // OMP performs --cwd before extension startup, so the extension observes
    // the workspace, not the separate OS launch directory. The harness still
    // spawned from a distinct launch directory; verify that separation.
    expect(await realpath(session.launchDir)).not.toBe(await realpath(session.workspace));
    expect(startup!.processCwdReal).toBe(await realpath(session.workspace));
    expect(sessionStart!.cwdReal).toBe(await realpath(session.workspace));
    expect(sessionStart!.owner.ownerId).toBe((await session.state()).ownerId);

    let state = await session.state();
    expect(state.tasksCreated).toBe(0);
    expect(state.currentTask).toBeNull();
    expect(await session.acceptanceFiles()).toHaveLength(0);

    const inputBytes = await readFile(session.inputPath);
    const inputText = inputBytes.toString("utf8");
    const expectedA = Buffer.from(`DAILY_A\n${inputText.toUpperCase()}`, "utf8");
    const expectedB = Buffer.from(`DAILY_B\n${inputText.replaceAll("alpha", "beta")}`, "utf8");

    await session.prompt(DAILY_PROMPTS.nativeRead(session.nativeFilePath));
    const nativeEvents = await session.observerEvents();
    const nativeRead = observation(nativeEvents, "daily-native-read");
    expect(nativeRead.isError).not.toBe(true);
    expect(String(nativeRead.content)).toContain("DAILY_NATIVE_NOTICE");
    expect(nativeRead.owner.tasksCreated).toBe(0);
    expect(nativeRead.owner.currentTask).toBeNull();
    state = await session.state();
    expect(state.tasksCreated).toBe(0);
    expect(state.currentTask).toBeNull();

    let provider = await session.providerEvents();
    const nativeTurns = turns(provider, "DAILY_NATIVE_READ");
    expect(nativeTurns.map((turn) => turn.step)).toEqual([0, 1]);
    expect(nativeTurns[0]!.tools).toContain("read");
    expect(nativeTurns[0]!.call.name).toBe("read");
    expect(nativeTurns[0]!.call.arguments.path).toBe(session.nativeFilePath);

    await session.prompt(DAILY_PROMPTS.taskA);
    const stateA = await session.state();
    expect(stateA.tasksCreated).toBe(1);
    expect(stateA.currentTask.status).toBe("active");
    expect(stateA.currentTask.acceptance).toBeNull();
    const taskA = stateA.currentTask;

    provider = await session.providerEvents();
    const aTurns = turns(provider, "DAILY_TASK_A");
    expect(aTurns.map((turn) => turn.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(aTurns[0]!.call).toMatchObject({ name: "agent_task", arguments: { action: "start" } });
    expect(aTurns[1]!.call).toMatchObject({
      name: "agent_execute",
      arguments: {
        action: "run",
        runtime: "python",
        inputIds: ["alpha"],
        expectedTaskId: taskA.taskId,
        expectedTaskRevision: taskA.taskRevision,
      },
    });
    expect(aTurns[2]!.call).toMatchObject({
      name: "agent_verify",
      arguments: { action: "verify", expectedTaskId: taskA.taskId, expectedTaskRevision: taskA.taskRevision },
    });
    expect(aTurns[3]!.call).toMatchObject({
      name: "agent_deliver",
      arguments: { action: "preview", expectedTaskId: taskA.taskId, expectedTaskRevision: taskA.taskRevision },
    });
    expect(aTurns[4]!.call).toMatchObject({ name: "agent_deliver", arguments: { action: "describe" } });
    expect(aTurns[5]!.call).toMatchObject({
      name: "agent_deliver",
      arguments: {
        action: "request_review",
        expectedTaskId: taskA.taskId,
        expectedTaskRevision: taskA.taskRevision,
      },
    });

    const observerA = await session.observerEvents();
    for (const id of [
      "daily-a-start",
      "daily-a-run",
      "daily-a-verify",
      "daily-a-preview",
      "daily-a-describe",
    ]) {
      expect(observation(observerA, id)).toBeTruthy();
    }
    const startObs = observation(observerA, "daily-a-start");
    expect(String(startObs.content)).toContain(taskA.taskId);
    const runObs = observation(observerA, "daily-a-run");
    expect(runObs.isError).not.toBe(true);
    const runMatch = /^run runId="([^"]+)"/m.exec(String(runObs.content));
    expect(runMatch?.[1]).toBeTruthy();
    const runAId = runMatch![1]!;
    const verifyObs = observation(observerA, "daily-a-verify");
    expect(verifyObs.isError).not.toBe(true);
    expect(String(verifyObs.content)).toContain("taskAccepted: false");
    expect(String(verifyObs.content)).toContain("outcome: insufficient");
    expect(String(verifyObs.content)).toContain("contract: none");
    expect(String(verifyObs.content)).toMatch(/^receiptId: \S+$/m);
    const previewObs = observation(observerA, "daily-a-preview");
    expect(previewObs.isError).not.toBe(true);
    expect(String(previewObs.content)).toContain("acceptanceConfigured: true");
    expect(String(previewObs.content)).toContain("taskAccepted: false");
    expect(String(previewObs.content)).toContain("candidateEligibility: not_checked");
    const previewA = previewFiles(previewObs);
    expect(previewA).toHaveLength(1);
    expect(previewA[0]!.relativePath).toBe("result.txt");
    expect(previewA[0]!.bytes).toBe(expectedA.length);
    expect(previewA[0]!.sha256).toBe(sha256(expectedA));
    expect(previewA[0]!.path.startsWith(firstInstance!.deliveryRoot + "/")).toBe(true);
    expect(await readFile(previewA[0]!.path)).toEqual(expectedA);
    expect(JSON.parse(contentLine(String(previewObs.content), "task")).taskId).toBe(taskA.taskId);
    const describeObs = observation(observerA, "daily-a-describe");
    expect(String(describeObs.content)).toContain("humanReviewConfigured: false");
    expect(String(describeObs.content)).toContain("humanReviewMode: unconfigured");
    expect(String(describeObs.content)).not.toContain("humanReviewMode: local-main-tui\n");

    // Frozen default-off review boundary. The actual model-visible
    // agent_deliver schema omits the hidden action, so OMP rejects the call at
    // action-enum validation before any extension dispatch. No review,
    // acceptance, execution or delivery effect is permitted.
    const reviewRequestTurn = aTurns[5]!;
    expect(reviewRequestTurn.call).toMatchObject({
      name: "agent_deliver",
      arguments: { action: "request_review" },
    });
    const reviewTurn = aTurns[6]!;
    expect(reviewTurn.lastToolCallId).toBe("daily-a-request-review");
    const deliverParameters = deliverSchema(reviewRequestTurn);
    const actualActions = (deliverParameters.properties as Event).action.enum as string[];
    expect(actualActions).toEqual(["describe", "preview", "submit", "inspect"]);
    expect(actualActions).not.toContain("request_review");
    expect(deliverParameters.required).toContain("action");
    expect(String(reviewRequestTurn.agentDeliverSchema.description)).toContain("Local human review is not configured");
    for (const turn of aTurns) {
      const parameters = deliverSchema(turn);
      expect((parameters.properties as Event).action.enum).toEqual(["describe", "preview", "submit", "inspect"]);
    }
    const reviewObs = observerA.find((event) =>
      event.type === "tool_result" && event.toolCallId === "daily-a-request-review");
    // OMP validates the actual model-visible schema before extension dispatch.
    expect(reviewObs).toBeUndefined();
    const reviewResult = String(reviewTurn.lastToolResult);
    expect(reviewResult).toContain('Validation failed for tool "agent_deliver"');
    expect(reviewResult).toContain("action: must be one of the allowed enum values");
    expect(reviewResult).toContain("Received arguments:");
    expect(reviewResult).toContain('"action": "request_review"');
    // An extension-produced disabled-review result would carry these fields;
    // the accepted evidence is the schema/enum refusal instead.
    expect(reviewResult).not.toContain("humanReviewConfigured");
    expect(reviewResult).not.toContain("review.state");
    expect((await session.state()).currentTask.status).toBe("active");
    expect((await session.state()).currentTask.acceptance).toBeNull();
    expect((await session.state()).tasksCreated).toBe(1);
    expect(await session.acceptanceFiles()).toHaveLength(0);
    expect(await session.executionRecords()).toHaveLength(1);

    const rawFrames = JSON.stringify([...session.requests, ...session.frames]);
    for (const id of [
      "daily-a-run",
      "daily-a-verify",
      "daily-a-preview",
      "daily-a-describe",
      "daily-a-request-review",
    ]) {
      expect(rawFrames).toContain(id);
    }
    expect(rawFrames).toContain(taskA.taskId);

    const recordsA = await session.executionRecords();
    expect(recordsA).toHaveLength(1);
    expect(recordsA[0]!.taskId).toBe(taskA.taskId);
    expect(recordsA[0]!.runId).toBe(runAId);
    assertCleanProcesses(recordsA[0]!);
    const artifactA = recordsA[0]!.artifacts[0];
    expect(artifactA.sha256).toBe(sha256(expectedA));
    expect(await readFile(path.join(firstInstance!.executionRoot, artifactA.archiveRef))).toEqual(expectedA);

    await session.prompt(DAILY_PROMPTS.cancelA);
    const stateCancelled = await session.state();
    expect(stateCancelled.tasksCreated).toBe(1);
    expect(stateCancelled.currentTask.taskId).toBe(taskA.taskId);
    expect(stateCancelled.currentTask.status).toBe("cancelled");
    expect(stateCancelled.currentTask.acceptance).toBeNull();
    expect(await readFile(previewA[0]!.path)).toEqual(expectedA);
    expect((await session.executionRecords())).toHaveLength(1);

    await session.prompt(DAILY_PROMPTS.taskB);
    const stateB = await session.state();
    expect(stateB.tasksCreated).toBe(2);
    expect(stateB.ownerId).toBe(stateA.ownerId);
    expect(stateB.currentTask.status).toBe("active");
    expect(stateB.currentTask.taskId).not.toBe(taskA.taskId);
    expect(stateB.currentTask.acceptance).toBeNull();
    const taskB = stateB.currentTask;

    provider = await session.providerEvents();
    const bTurns = turns(provider, "DAILY_TASK_B");
    expect(bTurns.map((turn) => turn.step)).toEqual([0, 1, 2, 3, 4]);
    expect(bTurns[1]!.call).toMatchObject({
      name: "agent_execute",
      arguments: {
        action: "run",
        runtime: "python",
        inputIds: ["alpha"],
        expectedTaskId: taskB.taskId,
        expectedTaskRevision: taskB.taskRevision,
      },
    });
    const observerB = await session.observerEvents();
    const bRunId = bTurns[2]!.observed.runB.runId as string;
    const bVerifyObs = observation(observerB, "daily-b-verify");
    expect(bVerifyObs.isError).not.toBe(true);
    expect(bVerifyObs.owner.currentTask.taskId).toBe(taskB.taskId);
    const bVerify = String(bVerifyObs.content);
    expect(bVerify).toContain("taskAccepted: false");
    expect(bVerify).toContain("outcome: insufficient");
    expect(bVerify).toContain("contract: none");
    expect(bVerify).toMatch(/^receiptId: \S+$/m);
    const bVerifyTask = JSON.parse(contentLine(bVerify, "task")) as Event;
    expect(bVerifyTask.taskId).toBe(taskB.taskId);
    expect(bVerifyTask.taskRevision).toBe(taskB.taskRevision);
    expect(bVerifyTask.ownerId).toBe(stateB.ownerId);
    expect((JSON.parse(contentLine(bVerify, "candidates")) as Event).runId).toBe(bRunId);
    const bPreviewObs = observation(observerB, "daily-b-preview");
    expect(bPreviewObs.isError).not.toBe(true);
    expect(String(bPreviewObs.content)).toContain("taskAccepted: false");
    const previewB = previewFiles(bPreviewObs);
    expect(previewB).toHaveLength(1);
    expect(previewB[0]!.relativePath).toBe("result.txt");
    expect(previewB[0]!.bytes).toBe(expectedB.length);
    expect(previewB[0]!.sha256).toBe(sha256(expectedB));
    expect(previewB[0]!.sha256).not.toBe(previewA[0]!.sha256);
    expect(previewB[0]!.path.startsWith(firstInstance!.deliveryRoot + "/")).toBe(true);
    expect(await readFile(previewB[0]!.path)).toEqual(expectedB);
    expect(JSON.parse(contentLine(String(bPreviewObs.content), "task")).taskId).toBe(taskB.taskId);
    expect(await readFile(previewA[0]!.path)).toEqual(expectedA);

    const recordsB = await session.executionRecords();
    expect(recordsB).toHaveLength(2);
    const recordB = recordsB.find((record) => record.taskId === taskB.taskId);
    expect(recordB).toBeTruthy();
    expect(recordB!.runId).toBe(bRunId);
    expect(recordB!.runId).not.toBe(runAId);
    assertCleanProcesses(recordB!);
    expect(recordB!.artifacts[0].sha256).toBe(sha256(expectedB));
    expect(await readFile(path.join(firstInstance!.executionRoot, recordB!.artifacts[0].archiveRef))).toEqual(expectedB);
    expect(await session.acceptanceFiles()).toHaveLength(0);

    const beforeAdversarial = {
      task: (await session.state()).currentTask,
      records: (await session.executionRecords()).length,
      delivery: comparable(await session.deliveryFiles()),
      executionTree: (await snapshotTree(firstInstance!.executionRoot)).map((file) => file.relativePath).sort(),
    };
    const observerBefore = (await session.observerEvents()).length;
    await session.prompt(DAILY_PROMPTS.adversarial);
    const afterAdversarial = await session.state();
    expect(afterAdversarial.tasksCreated).toBe(2);
    expect(afterAdversarial.currentTask.taskId).toBe(beforeAdversarial.task.taskId);
    expect(afterAdversarial.currentTask.taskRevision).toBe(beforeAdversarial.task.taskRevision);
    expect(afterAdversarial.currentTask.status).toBe("active");
    expect((await session.executionRecords())).toHaveLength(beforeAdversarial.records);
    expect(comparable(await session.deliveryFiles())).toEqual(beforeAdversarial.delivery);
    const executionTreeAfter = (await snapshotTree(firstInstance!.executionRoot)).map((file) => file.relativePath).sort();
    expect(executionTreeAfter).toEqual(beforeAdversarial.executionTree);
    expect(executionTreeAfter.some((name) => name.includes("ADVERSARIAL_SIDE_EFFECT"))).toBe(false);

    provider = await session.providerEvents();
    const adversarialTurns = turns(provider, "DAILY_ADVERSARIAL_OLD_SELECTOR");
    expect(adversarialTurns.map((turn) => turn.step)).toEqual([0, 1]);
    expect(adversarialTurns[0]!.call).toMatchObject({
      name: "agent_execute",
      arguments: {
        action: "run",
        inputIds: [],
        expectedTaskId: taskA.taskId,
        expectedTaskRevision: taskA.taskRevision,
      },
    });
    const adversarialObserver = (await session.observerEvents()).slice(observerBefore);
    const adversarialResult = adversarialObserver.find((event) =>
      event.type === "tool_result" && event.toolCallId === "daily-adversarial-old-selector");
    expect(adversarialResult?.isError).toBe(true);
    expect(String(adversarialResult?.content)).toContain("expectedTaskId does not match the current task");
    expect(JSON.stringify([...session.requests, ...session.frames])).toContain(taskA.taskId);

    console.info("[daily-case-1] observed review boundary:", reviewObs === undefined
      ? "OMP rejected hidden request_review before extension dispatch"
      : "extension returned a disabled review result");
  } catch (error) {
    session.markFailure(error);
    throw error;
  }
});

integration("case 2: normal stop and restart create a fresh instance without rehydrating the original two tasks", async () => {
  if (firstSession === undefined || firstInstance === undefined) {
    throw new Error("case 2 requires the first daily session from case 1");
  }
  let applicableSession: DailyOmpSession = firstSession;
  try {
    const oldStateBefore = await firstSession.state();
    expect(oldStateBefore.tasksCreated).toBe(2);
    const oldCurrent = oldStateBefore.currentTask;
    const shutdown = await firstSession.shutdown();
    expect(shutdown.fallback).toEqual([]);
    expect(shutdown.exitCode).toBe(0);
    expect(shutdown.exitSignal).toBeNull();
    expect(shutdown.processGroupGone).toBe(true);
    expect(shutdown.observerShutdown).toBe(true);

    const oldTreeAfterShutdown = await firstSession.instanceTree(firstInstance);
    const oldInstanceRoot = firstInstance.root;
    const oldInstanceId = firstInstance.instanceId;

    const restarted = await DailyOmpSession.restartFrom(firstSession);
    restartedSession = restarted;
    applicableSession = restarted;
    cleanups.push(async () => restarted.cleanup());
    const start = await restarted.start();
    expect(start.instance).toBeTruthy();
    const newInstance = start.instance!;
    expect(newInstance.instanceId).not.toBe(oldInstanceId);
    expect(newInstance.root).not.toBe(oldInstanceRoot);
    expect(newInstance.root.startsWith(firstSession.dailyStateRoot! + "/instances/")).toBe(true);
    expect(oldInstanceRoot.startsWith(firstSession.dailyStateRoot! + "/instances/")).toBe(true);

    expect(
      withinOrEqual(oldInstanceRoot, newInstance.root)
        || withinOrEqual(newInstance.root, oldInstanceRoot),
      "the old and new instance roots overlap",
    ).toBe(false);
    await expectCanonicalDisjoint([
      { label: "old execution", path: firstInstance.executionRoot },
      { label: "old delivery", path: firstInstance.deliveryRoot },
      { label: "old acceptance", path: firstInstance.acceptanceRoot },
      { label: "new execution", path: newInstance.executionRoot },
      { label: "new delivery", path: newInstance.deliveryRoot },
      { label: "new acceptance", path: newInstance.acceptanceRoot },
    ]);
    for (const root of [
      newInstance.executionRoot,
      newInstance.deliveryRoot,
      newInstance.acceptanceRoot,
    ]) {
      expect(root.startsWith(newInstance.root + "/")).toBe(true);
    }

    const oldTreeAfterRestart = await restarted.instanceTree(firstInstance);
    expect(comparable(oldTreeAfterRestart)).toEqual(comparable(oldTreeAfterShutdown));
    const oldState = JSON.parse(await readFile(firstInstance.statePath, "utf8")) as Event;
    expect(oldState.tasksCreated).toBe(2);
    expect(oldState.currentTask.taskId).toBe(oldCurrent.taskId);
    expect(oldState.currentTask.status).toBe("active");

    const newState = await restarted.state();
    expect(newState.tasksCreated).toBe(0);
    expect(newState.currentTask).toBeNull();
    expect(newState.ownerId).not.toBe(oldState.ownerId);
    const newAudit = await readFile(newInstance.auditPath, "utf8");
    expect(newAudit).toContain(`"type":"daily_entry_ready"`);
    expect(newAudit).not.toContain(`"type":"task_started"`);
    expect(newAudit).not.toContain(`"type":"task_tool_attempt"`);
    expect(await restarted.providerEvents()).toEqual([]);
    const newObserver = await restarted.observerEvents();
    expect(newObserver.filter((event) => event.type === "agent_start")).toEqual([]);
    expect(newObserver.filter((event) => event.type === "tool_result")).toEqual([]);
    expect(newObserver.find((event) => event.type === "session_start")?.owner?.tasksCreated).toBe(0);

    const ids = (await readdir(path.join(firstSession.dailyStateRoot!, "instances")))
      .filter((name) => !name.startsWith("."))
      .sort();
    expect(ids).toEqual([oldInstanceId, newInstance.instanceId].sort());

    // The restarted process must stop normally, not through afterAll signals.
    const restartedShutdown = await restarted.shutdown();
    expect(restartedShutdown.fallback).toEqual([]);
    expect(restartedShutdown.exitCode).toBe(0);
    expect(restartedShutdown.exitSignal).toBeNull();
    expect(restartedShutdown.processGroupGone).toBe(true);
    expect(restartedShutdown.observerShutdown).toBe(true);
  } catch (error) {
    applicableSession.markFailure(error);
    throw error;
  }
});

integration("case 3: invalid host config fails closed without managed authority or foreign-state reset", async () => {
  const session = await DailyOmpSession.create({ mode: "invalid", timeoutMs: 45_000 });
  cleanups.push(async () => session.cleanup());
  try {
    const sentinelPath = path.join(session.dailyStateRoot!, "foreign-sentinel.txt");
    const sentinelBefore = await readFile(sentinelPath);
    const start = await session.start();
    expect(start.instance).toBeUndefined();
    expect(start.toolNames).toContain("read");
    for (const name of DAILY_MANAGED_TOOLS) expect(start.toolNames).not.toContain(name);
    expect(new Set(start.toolNames).size).toBe(start.toolNames.length);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const frames = JSON.stringify(session.frames);
      if (session.stderrText().includes("daily_entry_disabled")
        || frames.includes("daily_entry_disabled")) break;
      await Bun.sleep(25);
    }
    const extensionEvidence = `${session.stderrText()}\n${JSON.stringify(session.frames)}`;
    expect(extensionEvidence).toContain("daily_entry_disabled");
    expect(extensionEvidence).toMatch(/schemaVersion|OMP_AGENT_CONFIG/);

    const instancesRoot = path.join(session.dailyStateRoot!, "instances");
    expect(await readdir(instancesRoot)).toEqual([]);
    expect(session.stderrText()).not.toContain("daily_entry_ready");

    await session.prompt(DAILY_PROMPTS.nativeRead(session.nativeFilePath));
    const observer = await session.observerEvents();
    const nativeRead = observation(observer, "daily-native-read");
    expect(nativeRead.isError).not.toBe(true);
    expect(String(nativeRead.content)).toContain(DAILY_NATIVE_BYTES.toString("utf8").split("\n")[0]!);
    expect(nativeRead.owner).toBeNull();
    expect(await readFile(sentinelPath)).toEqual(sentinelBefore);
    expect(await readdir(instancesRoot)).toEqual([]);

    const shutdown = await session.shutdown();
    expect(shutdown.fallback).toEqual([]);
    expect(shutdown.exitCode).toBe(0);
    expect(shutdown.exitSignal).toBeNull();
    expect(shutdown.processGroupGone).toBe(true);
    expect(shutdown.observerShutdown).toBe(true);
  } catch (error) {
    session.markFailure(error);
    throw error;
  }
});
