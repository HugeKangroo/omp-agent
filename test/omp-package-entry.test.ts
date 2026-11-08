import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DAILY_MANAGED_TOOLS,
  DAILY_NATIVE_BYTES,
  DAILY_PROMPTS,
  DailyOmpSession,
} from "./harness/daily-run.ts";
import { processAlive, sha256 } from "./harness/delivery-run.ts";
import {
  buildPackageArtifact,
  sha256Bytes,
  type PackageArtifact,
} from "./harness/package-entry-gate.ts";
import {
  binaryManifest,
  captureSessionEvidence,
  captureShutdown,
  ensureEvidenceRoot,
  sourceManifest,
  writeJson,
  type CaptureOptions,
  type SessionEvidenceCapture,
} from "./harness/package-entry-evidence.ts";
import { EXPECTED_OMP_VERSION, parseOmpVersion } from "./harness/admission.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PACKAGE_OBSERVER = path.join(REPO_ROOT, "test/fixtures/package-entry-observer.mjs");
const PROBE_TOOLS = ["agent_status", "agent_write_deliverable"];
const PROFILE = "package-entry-proof";
const TEST_TIMEOUT = 85_000;
const integration: (name: string, fn: () => Promise<unknown>, timeout?: number) => void =
  process.env.RUN_REAL_OMP_TEST === "1"
    ? (name, fn, timeout) => test(name, fn, timeout ?? TEST_TIMEOUT)
    : (name, fn) => test.skip(name, fn);

const cleanups: Array<{ label: string; run: () => Promise<void> }> = [];
let bodyCompleted = false;
let bodyError: { message: string; stack: string | null } | null = null;
let completedArtifact: { tarballSha256: string; packageRoot: string } | null = null;
let evidenceRootForLedger: string | undefined;

afterAll(async () => {
  const cleanupFailures: Array<{ label: string; message: string }> = [];
  const cleanupOrder: string[] = [];
  while (cleanups.length) {
    const entry = cleanups.pop()!;
    cleanupOrder.push(entry.label);
    try {
      await entry.run();
    } catch (error) {
      cleanupFailures.push({ label: entry.label, message: (error as Error).message });
    }
  }
  const sessionFacts = sessions.map((entry) => ({
    label: entry.label,
    captured: entry.captured && entry.capture?.complete === true,
    capture: entry.capture === null ? null : {
      complete: entry.capture.complete,
      capturedAt: entry.capture.capturedAt,
      indexFile: entry.capture.indexFile,
      copies: entry.capture.copies.length,
      gaps: entry.capture.gaps,
      runs: entry.capture.runs.map((run) => ({
        name: run.name,
        runId: run.runId,
        phase: run.phase,
        unavailable: run.unavailable,
      })),
    },
    lifecycle: entry.session.finalFacts(),
  }));
  const evidenceComplete = sessionFacts.length > 0 && sessionFacts.every((entry) => entry.captured);
  const cleanupComplete = cleanupFailures.length === 0 && sessionFacts.every((entry) =>
    entry.lifecycle.cleanup?.completed === true
    && entry.lifecycle.cleanup.runtimeDeleted === true);
  const failuresClean = sessionFacts.every((entry) => entry.lifecycle.failures.length === 0);
  const success = bodyCompleted && completedArtifact !== null && evidenceComplete && cleanupComplete && failuresClean;
  const finalLedgerPath = evidenceRootForLedger === undefined
    ? null
    : path.join(evidenceRootForLedger, "final-ledger.json");
  if (evidenceRootForLedger !== undefined) {
    await writeJson(finalLedgerPath!, {
      phase: "final",
      writtenAt: new Date().toISOString(),
      evidenceRoot: evidenceRootForLedger,
      body: { completed: bodyCompleted, error: bodyError },
      artifact: completedArtifact,
      cleanupOrder,
      cleanupFailures,
      evidenceComplete,
      cleanupComplete,
      failuresClean,
      success,
      sessions: sessionFacts,
    });
  }
  if (success) {
    await writeJson(path.join(evidenceRootForLedger!, "suite-success.json"), {
      completedAt: new Date().toISOString(),
      evidenceRoot: evidenceRootForLedger,
      finalLedger: finalLedgerPath,
      artifact: completedArtifact,
      cases: ["baseline", "P1", "P2", "P3"],
    });
    return;
  }
  if (evidenceRootForLedger !== undefined) {
    await writeJson(path.join(evidenceRootForLedger, "suite-failure.json"), {
      failedAt: new Date().toISOString(),
      body: bodyError,
      cleanupFailures,
      evidenceComplete,
      cleanupComplete,
      failuresClean,
      finalLedger: finalLedgerPath,
      sessions: sessionFacts,
    });
  }
  const reasons: string[] = [];
  if (!bodyCompleted) reasons.push("test body did not complete");
  if (!evidenceComplete) reasons.push("owned session evidence is incomplete");
  if (!cleanupComplete) reasons.push("owned cleanup did not complete with a removed runtime");
  if (!failuresClean) reasons.push("a session retained failures");
  for (const failure of cleanupFailures) reasons.push(`${failure.label}: ${failure.message}`);
  if (cleanupFailures.length > 0 || (bodyCompleted && !success)) {
    throw new Error(`[package-entry] final lifecycle failure: ${reasons.join("; ")}`);
  }
});

type Event = Record<string, any>;
type SessionEntry = {
  label: string;
  session: DailyOmpSession;
  captured: boolean;
  capture: SessionEvidenceCapture | null;
  captureOptions: CaptureOptions;
};

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

function observation(events: Event[], toolCallId: string): Event {
  const found = events.find((event) => event.type === "tool_result" && event.toolCallId === toolCallId);
  if (!found) {
    throw new Error(`missing actual observer tool_result ${toolCallId}; saw ${
      events.filter((event) => event.type === "tool_result").map((event) => event.toolCallId).join(",")
    }`);
  }
  return found;
}

function turns(events: Event[], marker: string): Event[] {
  return events
    .filter((event) => event.type === "model_turn" && event.marker === marker)
    .sort((left, right) => Number(left.step) - Number(right.step));
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

async function failureCaptureOptions(entry: SessionEntry): Promise<CaptureOptions> {
  const options: CaptureOptions = { ...entry.captureOptions };
  if (options.authorizedInputPaths === undefined && entry.session.mode === "daily") {
    options.authorizedInputPaths = [entry.session.inputPath];
  }
  if (options.providerToolCallSources === undefined) {
    try {
      const sources = (await entry.session.providerEvents())
        .map((event) => event?.call?.arguments?.source)
        .filter((value): value is string => typeof value === "string");
      if (sources.length > 0) options.providerToolCallSources = sources;
    } catch {
      // The capture index records any unavailable provider binding explicitly.
    }
  }
  return options;
}

async function capture(
  entry: SessionEntry,
  evidenceRoot: string,
  extra: Record<string, unknown>,
  options: CaptureOptions = {},
): Promise<void> {
  entry.captureOptions = options;
  const result = await captureSessionEvidence(evidenceRoot, entry.label, entry.session, extra, options);
  entry.capture = result;
  entry.captured = result.complete;
  if (!result.complete) {
    const details = result.gaps.map((item) => `${item.requirement} [${item.kind}]: ${item.reason}`).join("; ");
    throw new Error(`[package-entry] incomplete evidence for ${entry.label}: ${details}`);
  }
}

async function assertNormalShutdown(session: DailyOmpSession, evidenceRoot: string, label: string): Promise<Event> {
  const shutdown = await session.shutdown();
  expect(shutdown.fallback).toEqual([]);
  expect(shutdown.exitCode).toBe(0);
  expect(shutdown.exitSignal).toBeNull();
  expect(shutdown.processGroupGone).toBe(true);
  expect(shutdown.observerShutdown).toBe(true);
  await captureShutdown(evidenceRoot, label, shutdown);
  return shutdown as unknown as Event;
}

function addSession(label: string, session: DailyOmpSession): SessionEntry {
  const entry: SessionEntry = { label, session, captured: false, capture: null, captureOptions: {} };
  sessions.push(entry);
  cleanups.push({ label, run: async () => session.cleanup() });
  return entry;
}

const sessions: SessionEntry[] = [];

integration("package entry P1/P2/P3: checkout manifest, genuine tarball, missing-config fail-closed", async () => {
  expect(process.env.RUN_REAL_OMP_TEST).toBe("1");
  const evidenceRoot = await ensureEvidenceRoot(REPO_ROOT);
  evidenceRootForLedger = evidenceRoot;
  const runtimeFailures = path.join(evidenceRoot, "runtime-failures");
  process.env.OMP_AGENT_DAILY_EVIDENCE_ROOT = runtimeFailures;
  const requestedOmp = process.env.OMP_COMMAND || "omp";
  const ompPath = requestedOmp.includes("/")
    ? path.resolve(requestedOmp)
    : Bun.which(requestedOmp) ?? requestedOmp;
  const ompVersion = spawnOmpVersion(ompPath);
  expect(ompVersion).toBe(EXPECTED_OMP_VERSION);
  const ompBinary = await binaryManifest(ompPath, ompVersion);
  const bunBinary = await binaryManifest(process.execPath, Bun.version);
  if (!(await Bun.file(path.join(evidenceRoot, "source-binary-manifest.json")).exists())) {
    await writeJson(path.join(evidenceRoot, "source-binary-manifest.json"), {
      capturedAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      source: sourceManifest(REPO_ROOT),
      binaries: { omp: ompBinary, bun: bunBinary },
    });
  }

  let artifact: PackageArtifact | undefined;
  let current: SessionEntry | undefined;
  try {
    artifact = await buildPackageArtifact({
      repoRoot: REPO_ROOT,
      artifactRoot: path.join(evidenceRoot, "artifact"),
    });
    const packageJson = artifact.packageJson as Record<string, any>;
    expect(packageJson.name).toBe("omp-agent");
    expect(packageJson.type).toBe("module");
    expect(packageJson.private).toBe(true);
    expect(packageJson.omp).toEqual({ extensions: ["./src/daily-entry.ts"] });
    expect(packageJson.files).toContain("scripts/isolated-exec.py");
    expect(packageJson.files).not.toContain("test");
    expect(artifact.entries.some((entry) => entry.path === "package/src/daily-entry.ts")).toBe(true);
    expect(artifact.entries.some((entry) => entry.path === "package/src/human-review-runtime.mjs")).toBe(true);
    expect(artifact.entries.some((entry) => entry.path === "package/src/human-review-runtime.d.mts")).toBe(true);
    expect(artifact.entries.some((entry) => entry.path === "package/package.json")).toBe(true);
    expect(artifact.entries.some((entry) => entry.path === "package/scripts/isolated-exec.py")).toBe(true);
    expect(artifact.mutation.rejected).toBe(true);
    await writeJson(path.join(evidenceRoot, "artifact-manifest.json"), {
      capturedAt: new Date().toISOString(),
      repoRoot: REPO_ROOT,
      tarballPath: artifact.tarballPath,
      tarballBytes: artifact.tarballBytes,
      tarballSha256: artifact.tarballSha256,
      packageRoot: artifact.packageRoot,
      packCommand: artifact.packCommand,
      packStdout: artifact.packStdout,
      packStderr: artifact.packStderr,
      packageJson,
      entries: artifact.entries,
      expectedPaths: artifact.expectedPaths,
      mutation: artifact.mutation,
    });

    const baseline = await DailyOmpSession.create({
      mode: "baseline",
      timeoutMs: 45_000,
      observerPath: PACKAGE_OBSERVER,
      observerPortPath: path.join(artifact.packageRoot, "src/task-entry-port.ts"),
      productDirectory: artifact.packageRoot,
      profile: PROFILE,
    });
    const baselineEntry = addSession("baseline", baseline);
    current = baselineEntry;
    const baselineStart = await baseline.start();
    const baselineTools = baselineStart.toolNames;
    expect(baselineTools).toContain("read");
    for (const name of DAILY_MANAGED_TOOLS) expect(baselineTools).not.toContain(name);
    for (const name of PROBE_TOOLS) expect(baselineTools).not.toContain(name);
    expect(new Set(baselineTools).size).toBe(baselineTools.length);
    expect(await baseline.providerEvents()).toEqual([]);
    const baselineShutdown = await assertNormalShutdown(baseline, evidenceRoot, "baseline");
    await capture(baselineEntry, evidenceRoot, { case: "baseline", toolNames: baselineTools, shutdown: baselineShutdown });
    current = undefined;

    // P1: the selected product is the checkout package directory. OMP must
    // resolve package.json#omp.extensions to the daily composition.
    const p1 = await DailyOmpSession.create({
      mode: "daily",
      timeoutMs: 45_000,
      baselineTools,
      entryDirectory: REPO_ROOT,
      observerPath: PACKAGE_OBSERVER,
      observerPortPath: path.join(REPO_ROOT, "src/task-entry-port.ts"),
      productDirectory: REPO_ROOT,
      profile: PROFILE,
    });
    const p1Entry = addSession("p1-source-package-root", p1);
    current = p1Entry;
    const p1Start = await p1.start();
    expect(p1Start.instance).toBeTruthy();
    expect(p1Start.toolNames).toEqual([...baselineTools, ...DAILY_MANAGED_TOOLS].sort());
    for (const name of PROBE_TOOLS) expect(p1Start.toolNames).not.toContain(name);
    const p1Descriptor = p1.launchDescriptor() as Event;
    expect(p1Descriptor.entryDirectory).toBe(REPO_ROOT);
    expect(p1Descriptor.argv).toContain(REPO_ROOT);
    expect(p1Descriptor.argv).not.toContain(path.join(REPO_ROOT, "src/daily-entry.ts"));
    const p1State = await p1.state();
    expect(p1State.tasksCreated).toBe(0);
    expect(p1State.currentTask).toBeNull();
    const p1Instances = await readdir(path.join(p1.dailyStateRoot!, "instances"));
    expect(p1Instances).toEqual([p1Start.instance!.instanceId]);
    const p1Startup = (await p1.observerEvents()).find((event) => event.type === "observer_startup");
    expect(p1Startup?.portRealpath).toBe(await realpath(path.join(REPO_ROOT, "src/task-entry-port.ts")));
    expect(p1Startup?.productRealpath).toBe(await realpath(REPO_ROOT));
    const p1SessionStart = (await p1.observerEvents()).find((event) => event.type === "session_start");
    expect(p1SessionStart?.owner?.ownerId).toBe(p1State.ownerId);
    const p1Audit = await readFile(p1Start.instance!.auditPath, "utf8");
    expect(p1Audit).toContain(`"type":"daily_entry_ready"`);
    expect(p1Audit).not.toContain(`"type":"task_started"`);
    await p1.prompt(DAILY_PROMPTS.nativeRead(p1.nativeFilePath));
    const p1Native = observation(await p1.observerEvents(), "daily-native-read");
    expect(p1Native.isError).not.toBe(true);
    expect(String(p1Native.content)).toContain(DAILY_NATIVE_BYTES.toString("utf8").split("\n")[0]!);
    expect(p1Native.owner?.tasksCreated).toBe(0);
    expect((await p1.state()).tasksCreated).toBe(0);
    const p1Shutdown = await assertNormalShutdown(p1, evidenceRoot, "p1-source-package-root");
    await capture(p1Entry, evidenceRoot, {
      case: "P1",
      toolNames: p1Start.toolNames,
      instance: p1Start.instance,
      state: p1State,
      instances: p1Instances,
      descriptor: p1Descriptor,
      shutdown: p1Shutdown,
    });
    current = undefined;

    // P2: load the extracted genuine package directory, then perform one
    // deterministic managed task through real execution, verification and
    // preview. All product module/launcher resolution must stay in the
    // extracted artifact.
    const p2 = await DailyOmpSession.create({
      mode: "daily",
      timeoutMs: 45_000,
      baselineTools,
      entryDirectory: artifact.packageRoot,
      observerPath: PACKAGE_OBSERVER,
      observerPortPath: path.join(artifact.packageRoot, "src/task-entry-port.ts"),
      productDirectory: artifact.packageRoot,
      profile: PROFILE,
    });
    const p2Entry = addSession("p2-artifact", p2);
    current = p2Entry;
    const p2Start = await p2.start();
    expect(p2Start.instance).toBeTruthy();
    expect(p2Start.toolNames).toEqual([...baselineTools, ...DAILY_MANAGED_TOOLS].sort());
    const p2Descriptor = p2.launchDescriptor() as Event;
    expect(p2Descriptor.entryDirectory).toBe(artifact.packageRoot);
    expect(p2Descriptor.observerPortPath).toBe(path.join(artifact.packageRoot, "src/task-entry-port.ts"));
    expect(p2Descriptor.argv).toContain(artifact.packageRoot);
    expect((p2Descriptor.argv as string[]).filter((value) => value.startsWith(`${REPO_ROOT}/src/`))).toEqual([]);
    expect(p2Descriptor.argv).not.toContain(path.join(REPO_ROOT, "src/daily-entry.ts"));
    const p2Startup = (await p2.observerEvents()).find((event) => event.type === "observer_startup");
    expect(p2Startup?.productRealpath).toBe(await realpath(artifact.packageRoot));
    expect(p2Startup?.portRealpath).toBe(await realpath(path.join(artifact.packageRoot, "src/task-entry-port.ts")));
    expect(p2Startup?.portRealpath?.startsWith(`${await realpath(artifact.packageRoot)}/`)).toBe(true);

    const inputBytes = await readFile(p2.inputPath);
    const expected = Buffer.from(`DAILY_A\n${inputBytes.toString("utf8").toUpperCase()}`, "utf8");
    await p2.prompt(DAILY_PROMPTS.taskA);
    const p2State = await p2.state();
    expect(p2State.tasksCreated).toBe(1);
    expect(p2State.currentTask.status).toBe("active");
    expect(p2State.currentTask.acceptance).toBeNull();
    const taskId = p2State.currentTask.taskId as string;

    const provider = await p2.providerEvents();
    const aTurns = turns(provider, "DAILY_TASK_A");
    expect(aTurns.map((turn) => turn.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(aTurns[0]!.call).toMatchObject({ name: "agent_task", arguments: { action: "start" } });
    expect(aTurns[1]!.call).toMatchObject({
      name: "agent_execute",
      arguments: {
        action: "run",
        runtime: "python",
        inputIds: ["alpha"],
        expectedTaskId: taskId,
        expectedTaskRevision: p2State.currentTask.taskRevision,
      },
    });
    expect(aTurns[2]!.call).toMatchObject({
      name: "agent_verify",
      arguments: { action: "verify", expectedTaskId: taskId, expectedTaskRevision: p2State.currentTask.taskRevision },
    });
    expect(aTurns[3]!.call).toMatchObject({
      name: "agent_deliver",
      arguments: { action: "preview", expectedTaskId: taskId, expectedTaskRevision: p2State.currentTask.taskRevision },
    });
    expect(aTurns[4]!.call).toMatchObject({ name: "agent_deliver", arguments: { action: "describe" } });
    expect(aTurns[5]!.call).toMatchObject({
      name: "agent_deliver",
      arguments: {
        action: "request_review",
        expectedTaskId: taskId,
        expectedTaskRevision: p2State.currentTask.taskRevision,
      },
    });

    const p2Observer = await p2.observerEvents();
    const runObs = observation(p2Observer, "daily-a-run");
    expect(runObs.isError).not.toBe(true);
    const runId = /^run runId="([^"]+)"/m.exec(String(runObs.content))?.[1];
    expect(runId).toBeTruthy();
    const verifyObs = observation(p2Observer, "daily-a-verify");
    expect(verifyObs.isError).not.toBe(true);
    expect(String(verifyObs.content)).toContain("taskAccepted: false");
    expect(String(verifyObs.content)).toContain("outcome: insufficient");
    expect(String(verifyObs.content)).toContain("contract: none");
    const previewObs = observation(p2Observer, "daily-a-preview");
    expect(previewObs.isError).not.toBe(true);
    expect(String(previewObs.content)).toContain("acceptanceConfigured: true");
    expect(String(previewObs.content)).toContain("taskAccepted: false");
    const preview = previewFiles(previewObs);
    expect(preview).toHaveLength(1);
    expect(preview[0]!.relativePath).toBe("result.txt");
    expect(preview[0]!.bytes).toBe(expected.length);
    expect(preview[0]!.sha256).toBe(sha256(expected));
    expect(preview[0]!.path.startsWith(p2Start.instance!.deliveryRoot + "/")).toBe(true);
    expect(await readFile(preview[0]!.path)).toEqual(expected);
    expect(JSON.parse(contentLine(String(previewObs.content), "task")).taskId).toBe(taskId);
    expect(await p2.acceptanceFiles()).toHaveLength(0);

    const records = await p2.executionRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.taskId).toBe(taskId);
    expect(record.runId).toBe(runId);
    expect(record.launcher).toBe(path.join(artifact.packageRoot, "scripts/isolated-exec.py"));
    expect(record.launcher.startsWith(`${artifact.packageRoot}/`)).toBe(true);
    expect(sha256Bytes(await readFile(record.launcher))).toBe(sha256Bytes(await readFile(
      path.join(REPO_ROOT, "scripts/isolated-exec.py"),
    )));
    expect(record.source.sha256).toBe(sha256(String(aTurns[1]!.call.arguments.source)));
    expect(record.inputs).toHaveLength(1);
    expect(record.inputs[0].id).toBe("alpha");
    expect(record.inputs[0].sha256).toBe(sha256(inputBytes));
    expect(record.inputs[0].bytes).toBe(inputBytes.byteLength);
    expect(record.artifacts).toHaveLength(1);
    expect(record.artifacts[0].sha256).toBe(sha256(expected));
    expect(await readFile(path.join(p2Start.instance!.executionRoot, record.artifacts[0].archiveRef))).toEqual(expected);
    assertCleanProcesses(record);

    const p2Shutdown = await assertNormalShutdown(p2, evidenceRoot, "p2-artifact");
    await capture(p2Entry, evidenceRoot, {
      case: "P2",
      toolNames: p2Start.toolNames,
      instance: p2Start.instance,
      state: p2State,
      descriptor: p2Descriptor,
      providerEvents: provider,
      observerEvents: p2Observer,
      executionRecord: record,
      preview,
      expectedArtifactSha256: sha256(expected),
      shutdown: p2Shutdown,
    }, {
      expectedRunIds: [runId!],
      authorizedInputPaths: [p2.inputPath],
      providerToolCallSources: provider
        .map((event) => event?.call?.arguments?.source)
        .filter((value): value is string => typeof value === "string"),
      expectedDeliveryPaths: preview.map((file) => file.path),
    });
    current = undefined;

    // P3: the same genuine artifact without OMP_AGENT_CONFIG must fail closed
    // while leaving OMP native tools usable and creating no owner/instance.
    const p3 = await DailyOmpSession.create({
      mode: "missing-config",
      timeoutMs: 45_000,
      baselineTools,
      entryDirectory: artifact.packageRoot,
      observerPath: PACKAGE_OBSERVER,
      observerPortPath: path.join(artifact.packageRoot, "src/task-entry-port.ts"),
      productDirectory: artifact.packageRoot,
      profile: PROFILE,
    });
    const p3Entry = addSession("p3-artifact-missing-config", p3);
    current = p3Entry;
    const sentinelPath = path.join(p3.workspace, "foreign-sentinel.txt");
    const sentinelBytes = Buffer.from("ordinary sentinel must survive package-entry startup\n", "utf8");
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });
    expect(p3.dailyConfigPath).toBeNull();
    const p3Start = await p3.start();
    expect(p3Start.instance).toBeUndefined();
    expect(p3Start.toolNames).toEqual(baselineTools);
    for (const name of PROBE_TOOLS) expect(p3Start.toolNames).not.toContain(name);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const evidence = `${p3.stderrText()}\n${JSON.stringify(p3.frames)}`;
      if (evidence.includes("daily_entry_disabled")) break;
      await Bun.sleep(25);
    }
    const extensionEvidence = `${p3.stderrText()}\n${JSON.stringify(p3.frames)}`;
    expect(extensionEvidence).toContain("daily_entry_disabled");
    expect(extensionEvidence).toMatch(/OMP_AGENT_CONFIG|configuration|config/);
    expect(extensionEvidence).not.toContain("daily_entry_ready");
    const p3Startup = (await p3.observerEvents()).find((event) => event.type === "observer_startup");
    expect(p3Startup?.owner).toBeNull();
    const p3SessionStart = (await p3.observerEvents()).find((event) => event.type === "session_start");
    expect(p3SessionStart?.owner).toBeNull();
    await p3.prompt(DAILY_PROMPTS.nativeRead(p3.nativeFilePath));
    const p3Native = observation(await p3.observerEvents(), "daily-native-read");
    expect(p3Native.isError).not.toBe(true);
    expect(String(p3Native.content)).toContain(DAILY_NATIVE_BYTES.toString("utf8").split("\n")[0]!);
    expect(p3Native.owner).toBeNull();
    expect(await readFile(sentinelPath)).toEqual(sentinelBytes);
    await expect(readdir(path.join(p3.workspace, ".omp-agent"))).rejects.toThrow();
    const p3Shutdown = await assertNormalShutdown(p3, evidenceRoot, "p3-artifact-missing-config");
    await capture(p3Entry, evidenceRoot, {
      case: "P3",
      toolNames: p3Start.toolNames,
      descriptor: p3.launchDescriptor(),
      extensionEvidence,
      sentinelPath,
      sentinelSha256: sha256Bytes(sentinelBytes),
      shutdown: p3Shutdown,
    });
    current = undefined;
    completedArtifact = { tarballSha256: artifact.tarballSha256, packageRoot: artifact.packageRoot };
    bodyCompleted = true;
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    bodyError = { message: original.message, stack: original.stack ?? null };
    // Mark only the actually-current session, and do it before any capture
    // attempt, so the original cause survives into cleanup/export.
    current?.session.markFailure(original);
    const captureFailures: string[] = [];
    for (const entry of sessions) {
      if (entry.captured) continue;
      try {
        const result = await captureSessionEvidence(evidenceRoot, entry.label, entry.session, {
          case: entry.label,
          failure: original.message,
          stderr: entry.session.stderrText(),
        }, await failureCaptureOptions(entry));
        entry.capture = result;
        entry.captured = result.complete;
        if (!result.complete) {
          const message = `${entry.label}: ${
            result.gaps.map((item) => `${item.requirement} [${item.kind}]: ${item.reason}`).join("; ")
          }`;
          captureFailures.push(message);
          entry.session.markFailure(new Error(`evidence capture incomplete: ${message}`));
        }
      } catch (captureError) {
        const message = `${entry.label}: capture failed: ${(captureError as Error).message}`;
        captureFailures.push(message);
        entry.session.markFailure(new Error(`evidence capture failed: ${(captureError as Error).message}`));
      }
    }
    await writeJson(path.join(evidenceRoot, "suite-failure.json"), {
      failedAt: new Date().toISOString(),
      message: original.message,
      stack: original.stack ?? null,
      current: current?.label ?? null,
      captureFailures,
    });
    if (captureFailures.length > 0) {
      throw new Error(
        `${original.message}\n[package-entry] evidence capture incomplete: ${captureFailures.join(" | ")}`,
      );
    }
    throw original;
  }
});

function spawnOmpVersion(command: string): string {
  const result = spawnSync(command, ["--version"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8192,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`OMP version check failed: ${result.error?.message ?? result.stderr}`);
  }
  return parseOmpVersion(result.stdout);
}
