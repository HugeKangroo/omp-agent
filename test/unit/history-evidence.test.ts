import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkRunEvidence,
  HistoryEvidenceError,
  type RunEvidenceRequest,
  type RunEvidenceResult,
} from "../../src/history-evidence.ts";
import {
  createHistoryProjectionWriter,
  type HistoryCaptureResult,
  type HistoryInstanceLocator,
  type HistoryItem,
} from "../../src/history-projection.ts";
import {
  TaskOwner,
  type ManagedTask,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-g3a-evidence-workspace";
const SESSION = "g3a-evidence-session";
const NOW = "2026-11-09T00:00:00.000Z";
const SOURCE = Buffer.from("print('g3a evidence')\n", "utf8");
const INPUT = Buffer.from("authorized input — α\nsecond line\n", "utf8");
const ARTIFACT_FINAL = Buffer.from("final result — 42\n", "utf8");
const ARTIFACT_INTERMEDIATE = Buffer.from("intermediate result\n", "utf8");

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "g3a-evidence-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface Fixture {
  root: string;
  locator: HistoryInstanceLocator;
  owner: TaskOwner;
  task: ManagedTask;
  capture: HistoryCaptureResult;
  writer: ReturnType<typeof createHistoryProjectionWriter>;
  runRoot: string;
  recordPath: string;
  record: Record<string, unknown>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "omp-agent-g3a-evidence-"));
  const locator: HistoryInstanceLocator = {
    instanceRoot: root,
    instanceId: "instance-g3a-evidence",
    ownerId: "owner-g3a-evidence",
    workspaceRoot: WORKSPACE,
  };
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: locator.ownerId,
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const branch = [base(), user("user-1", "leaf-1", "Produce evidence.")];
  expect(owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text: "Produce evidence.",
    observedAt: NOW,
    baseLeafId: "leaf-1",
  }).accepted).toBe(true);
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Produce evidence.", reason: "prompt" });
  const task = owner.start(subject(branch)).task;
  expect(owner.closeTurn({
    sessionId: SESSION,
    branch,
    messages: [messageOf(user("user-1", "leaf-1", "Produce evidence."))],
  })).toBe(true);
  const writer = createHistoryProjectionWriter(locator);
  const capture = writer.capture(task);

  const executionRoot = path.join(root, "execution");
  const runRoot = path.join(executionRoot, "run-fixed");
  mkdirSync(path.join(runRoot, "source"), { recursive: true });
  mkdirSync(path.join(runRoot, "inputs"), { recursive: true });
  mkdirSync(path.join(runRoot, "artifacts"), { recursive: true });
  writeFileSync(path.join(runRoot, "source", "script.py"), SOURCE, { mode: 0o400 });
  writeFileSync(path.join(runRoot, "inputs", "input-1.bin"), INPUT, { mode: 0o400 });
  writeFileSync(path.join(runRoot, "artifacts", "artifact-1.bin"), ARTIFACT_FINAL, { mode: 0o400 });
  writeFileSync(path.join(runRoot, "artifacts", "artifact-2.bin"), ARTIFACT_INTERMEDIATE, { mode: 0o400 });
  const recordPath = path.join(runRoot, "record.json");
  const record = baseRecord(capture.item, runRoot, locator.ownerId);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return {
    root,
    locator,
    owner,
    task,
    capture,
    writer,
    runRoot,
    recordPath,
    record,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function baseRecord(item: HistoryItem, runRoot: string, ownerId: string): Record<string, unknown> {
  const watchdog = {
    protocol: "g2a2-watchdog-v1",
    armed: true,
    ackSent: true,
    controlEnded: true,
    watchdogTerminated: true,
    controlError: null,
    unexpectedControlEof: false,
    watchdogKilledByHost: false,
    handshakeError: null,
    triggerReason: null,
    pidGone: true,
  };
  return {
    schemaVersion: 1,
    limitsVersion: "g2a2-v1",
    runId: "run-fixed",
    callId: "call-fixed",
    taskId: item.taskId,
    ownerId,
    taskRevision: item.taskRevision,
    requirementsDigest: item.requirementsDigest,
    anchorMessageId: item.anchor.messageId,
    capabilityId: "local-script",
    runtime: "python",
    runtimeVersion: "3.9.6",
    source: { bytes: SOURCE.length, sha256: sha256(SOURCE) },
    inputs: [{
      id: "input-1",
      bytes: INPUT.length,
      sha256: sha256(INPUT),
      stagedPath: path.join(runRoot, "inputs", "input-1.bin"),
      sourcePath: "/outside/never-read-by-evidence.txt",
    }],
    interpreter: "/usr/bin/python3",
    launcher: "/launcher",
    profilePath: path.join(runRoot, "profile.sb"),
    createdAt: NOW,
    phase: "completed",
    updatedAt: NOW,
    process: {
      spawned: true,
      pid: 999_999,
      pgid: 999_999,
      exitCode: 0,
      signal: null,
      durationMs: 12,
      stopReason: null,
      terminatedByHost: false,
      groupGone: true,
      groupCheckMs: 0,
      spawnError: null,
      launchStage: "unknown",
      hostRecordError: null,
      watchdog,
    },
    watchdog,
    artifacts: [{
      artifactId: "artifact-1",
      relativePath: "result.txt",
      bytes: ARTIFACT_FINAL.length,
      sha256: sha256(ARTIFACT_FINAL),
      archiveRef: "run-fixed/artifacts/artifact-1.bin",
      verified: true,
    }, {
      artifactId: "artifact-2",
      relativePath: "intermediate.txt",
      bytes: ARTIFACT_INTERMEDIATE.length,
      sha256: sha256(ARTIFACT_INTERMEDIATE),
      archiveRef: "run-fixed/artifacts/artifact-2.bin",
      verified: true,
    }],
    artifactRejections: [],
    artifactTotalBytes: ARTIFACT_FINAL.length + ARTIFACT_INTERMEDIATE.length,
    artifactLimitReached: false,
    artifactExportError: null,
    hostRecordError: null,
    taskAccepted: false,
    candidateOnly: true,
  };
}

function writeRecord(fixture: Fixture, record: Record<string, unknown>): void {
  writeFileSync(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function rewriteReadOnly(filePath: string, bytes: Buffer): void {
  chmodSync(filePath, 0o600);
  writeFileSync(filePath, bytes);
}

function request(fixture: Fixture, overrides: Partial<RunEvidenceRequest> = {}): RunEvidenceRequest {
  return {
    instance: fixture.locator,
    item: {
      historyId: fixture.capture.item.historyId,
      digest: fixture.capture.item.digest,
      taskId: fixture.capture.item.taskId,
      taskRevision: fixture.capture.item.taskRevision,
    },
    expectedRunId: "run-fixed",
    expectedCallId: "call-fixed",
    runLocator: "run-fixed/record.json",
    artifactIds: ["artifact-1"],
    ...overrides,
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof HistoryEvidenceError) return error.code;
    throw error;
  }
  throw new Error("expected an error");
}

function expectResult(value: RunEvidenceResult): RunEvidenceResult {
  return value;
}

describe("bounded archived-run evidence", () => {
  test("binds metadata and selected archived bytes without restoring authority", () => {
    const fixture = makeFixture();
    const result = expectResult(checkRunEvidence(request(fixture)));
    expect(result.state).toBe("consistent");
    expect(result.scope).toBe("local-record-bytes-and-record-metadata");
    expect(result.metadata.state).toBe("matched");
    expect(result.metadata.checks).toEqual({
      owner: true,
      task: true,
      revision: true,
      requirementsDigest: true,
      runId: true,
      callId: true,
    });
    expect(result.bytes.state).toBe("verified");
    expect(result.bytes.source).toMatchObject({
      bytes: SOURCE.length,
      sha256: sha256(SOURCE),
      recordedBytes: SOURCE.length,
      recordedSha256: sha256(SOURCE),
      state: "matched",
    });
    expect(result.bytes.inputs).toHaveLength(1);
    expect(result.bytes.inputs[0]).toMatchObject({
      id: "input-1",
      bytes: INPUT.length,
      sha256: sha256(INPUT),
      state: "matched",
    });
    // Only the selected final artifact is read; artifact-2 is not selected.
    expect(result.bytes.artifacts).toHaveLength(1);
    expect(result.bytes.artifacts[0]).toMatchObject({
      artifactId: "artifact-1",
      relativePath: "result.txt",
      bytes: ARTIFACT_FINAL.length,
      sha256: sha256(ARTIFACT_FINAL),
      state: "matched",
    });
    expect(result.processRecorded).toMatchObject({
      state: "completed_recorded",
      phase: "completed",
      spawned: true,
      pid: 999_999,
      pgid: 999_999,
      exitCode: 0,
      processGroupGoneRecorded: true,
      watchdogArmed: true,
      watchdogTerminatedRecorded: true,
      watchdogControlEndedRecorded: true,
      controlError: null,
    });
    expect(result.processCurrent).toBe("not_checked");
    expect(result.acceptanceEvidence).toBe("not_checked");
    expect(result.candidateRegistration).toBe("not_checked");
    expect(result.branchVisibility).toBe("not_checked");
    expect(result.authorityRestored).toBe(false);
    expect(result.selection).toMatchObject({
      requested: ["artifact-1"],
      recorded: ["artifact-1", "artifact-2"],
      missing: [],
      allPresent: true,
    });
    expect(result.history).toMatchObject({
      recordedStatus: "active",
      recordedAcceptanceReference: null,
    });
    expect(Object.prototype.hasOwnProperty.call(result, "currentTaskAccepted")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "acceptedHistoryVerified")).toBe(false);
    expect(fixture.owner.snapshot().currentTask?.status).toBe("active");
    expect(fixture.owner.snapshot().currentTask?.acceptance).toBeNull();

    // An unselected intermediate archive may be absent; the selected final
    // artifact and all source/input evidence still determine this result.
    const intermediatePath = path.join(fixture.runRoot, "artifacts", "artifact-2.bin");
    const intermediateBytes = readFileSync(intermediatePath);
    unlinkSync(intermediatePath);
    expect(checkRunEvidence(request(fixture)).state).toBe("consistent");
    writeFileSync(intermediatePath, intermediateBytes);

    const both = checkRunEvidence(request(fixture, { artifactIds: ["artifact-1", "artifact-2"] }));
    expect(both.state).toBe("consistent");
    expect(both.bytes.artifacts.map((artifact) => artifact.artifactId)).toEqual(["artifact-1", "artifact-2"]);
    fixture.cleanup();
  });

  test("reports changed, missing and unsafe selected files without fallback", () => {
    const fixture = makeFixture();
    expect(checkRunEvidence(request(fixture)).state).toBe("consistent");

    const finalPath = path.join(fixture.runRoot, "artifacts", "artifact-1.bin");
    const originalFinal = readFileSync(finalPath);
    const changedFinal = Buffer.from(originalFinal);
    changedFinal[0] = changedFinal[0] === 0x66 ? 0x67 : 0x66;
    rewriteReadOnly(finalPath, changedFinal);
    const changedArtifact = checkRunEvidence(request(fixture));
    expect(changedArtifact.state).toBe("changed");
    expect(changedArtifact.bytes.artifacts[0]!.state).toBe("changed");
    rewriteReadOnly(finalPath, originalFinal);

    const inputPath = path.join(fixture.runRoot, "inputs", "input-1.bin");
    const originalInput = readFileSync(inputPath);
    const changedInput = Buffer.from(originalInput);
    changedInput[0] = changedInput[0] === 0x61 ? 0x62 : 0x61;
    rewriteReadOnly(inputPath, changedInput);
    const changedInputResult = checkRunEvidence(request(fixture));
    expect(changedInputResult.state).toBe("changed");
    expect(changedInputResult.bytes.inputs[0]!.state).toBe("changed");
    rewriteReadOnly(inputPath, originalInput);

    const sourcePath = path.join(fixture.runRoot, "source", "script.py");
    const originalSource = readFileSync(sourcePath);
    const changedSource = Buffer.from(originalSource);
    changedSource[0] = changedSource[0] === 0x70 ? 0x71 : 0x70;
    rewriteReadOnly(sourcePath, changedSource);
    const changedSourceResult = checkRunEvidence(request(fixture));
    expect(changedSourceResult.state).toBe("changed");
    expect(changedSourceResult.bytes.source?.state).toBe("changed");
    rewriteReadOnly(sourcePath, originalSource);

    unlinkSync(finalPath);
    const missingArtifact = checkRunEvidence(request(fixture));
    expect(missingArtifact.state).toBe("missing");
    expect(missingArtifact.bytes.artifacts[0]!.state).toBe("missing");
    writeFileSync(finalPath, originalFinal);

    const outsidePath = path.join(fixture.root, "outside.bin");
    writeFileSync(outsidePath, originalFinal);
    unlinkSync(finalPath);
    symlinkSync(outsidePath, finalPath);
    expect(checkRunEvidence(request(fixture)).state).toBe("changed");
    unlinkSync(finalPath);
    writeFileSync(finalPath, originalFinal);

    const artifactRoot = path.join(fixture.runRoot, "artifacts");
    const outsideArtifactRoot = path.join(fixture.root, "outside-artifacts");
    mkdirSync(outsideArtifactRoot);
    writeFileSync(path.join(outsideArtifactRoot, "artifact-1.bin"), originalFinal);
    rmSync(artifactRoot, { recursive: true, force: true });
    symlinkSync(outsideArtifactRoot, artifactRoot);
    expect(checkRunEvidence(request(fixture)).state).toBe("changed");
    rmSync(artifactRoot, { recursive: true, force: true });
    mkdirSync(artifactRoot);
    writeFileSync(path.join(artifactRoot, "artifact-1.bin"), originalFinal);
    writeFileSync(path.join(artifactRoot, "artifact-2.bin"), ARTIFACT_INTERMEDIATE);

    const missingSelection = checkRunEvidence(request(fixture, { artifactIds: ["artifact-3"] }));
    expect(missingSelection.state).toBe("mismatch");
    expect(missingSelection.selection?.missing).toEqual(["artifact-3"]);
    expect(missingSelection.bytes.state).toBe("not_checked");
    expect(checkRunEvidence(request(fixture, { artifactIds: ["artifact-1", "artifact-3"] })).state).toBe("mismatch");
    expect(codeOf(() => checkRunEvidence(request(fixture, { artifactIds: ["artifact-1", "artifact-1"] })))).toBe("invalid");
    expect(codeOf(() => checkRunEvidence(request(fixture, { artifactIds: ["artifact/1"] })))).toBe("invalid");

    const traversal = JSON.parse(readFileSync(fixture.recordPath, "utf8")) as Record<string, unknown>;
    (traversal.inputs as Array<Record<string, unknown>>)[0]!.id = "x/../../outside";
    writeRecord(fixture, traversal);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    const artifactTraversal = JSON.parse(readFileSync(fixture.recordPath, "utf8")) as Record<string, unknown>;
    (artifactTraversal.inputs as Array<Record<string, unknown>>)[0]!.id = "input-1";
    (artifactTraversal.artifacts as Array<Record<string, unknown>>)[0]!.artifactId = "x/../../outside";
    writeRecord(fixture, artifactTraversal);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    expect(fixture.root).toContain("omp-agent-g3a-evidence-");
    fixture.cleanup();
  });

  test("binds exact identity and reports malformed versions or phases honestly", () => {
    const fixture = makeFixture();
    expect(checkRunEvidence(request(fixture, {
      instance: { ...fixture.locator, ownerId: "owner-other" },
    })).state).toBe("mismatch");
    expect(checkRunEvidence(request(fixture, {
      instance: { ...fixture.locator, workspaceRoot: "/tmp/other-workspace" },
    })).state).toBe("mismatch");
    const missingHistoryRoot = mkdtempSync(path.join(tmpdir(), "omp-agent-g3a-evidence-no-history-"));
    try {
      expect(checkRunEvidence(request(fixture, {
        instance: { ...fixture.locator, instanceRoot: missingHistoryRoot, instanceId: "instance-other" },
      })).state).toBe("unavailable");
    } finally {
      rmSync(missingHistoryRoot, { recursive: true, force: true });
    }
    expect(checkRunEvidence(request(fixture, { expectedRunId: "run-other" })).state).toBe("mismatch");
    expect(checkRunEvidence(request(fixture, { expectedCallId: "call-other" })).state).toBe("mismatch");
    expect(checkRunEvidence(request(fixture, {
      item: { ...request(fixture).item, taskRevision: 2 },
    })).state).toBe("mismatch");
    expect(checkRunEvidence(request(fixture, {
      item: { ...request(fixture).item, digest: `sha256:${"0".repeat(64)}` },
    })).state).toBe("mismatch");

    const record = fixture.record;
    const wrongTask = structuredClone(record);
    wrongTask.taskId = "task-other";
    writeRecord(fixture, wrongTask);
    expect(checkRunEvidence(request(fixture)).state).toBe("mismatch");
    const wrongRevision = structuredClone(record);
    wrongRevision.taskRevision = 2;
    writeRecord(fixture, wrongRevision);
    expect(checkRunEvidence(request(fixture)).state).toBe("mismatch");
    const wrongRequirements = structuredClone(record);
    wrongRequirements.requirementsDigest = `requirements-digest-v1:sha256:${"0".repeat(64)}`;
    writeRecord(fixture, wrongRequirements);
    expect(checkRunEvidence(request(fixture)).state).toBe("mismatch");
    const wrongOwner = structuredClone(record);
    wrongOwner.ownerId = "owner-other";
    writeRecord(fixture, wrongOwner);
    expect(checkRunEvidence(request(fixture)).state).toBe("mismatch");

    const unsupported = structuredClone(record);
    unsupported.schemaVersion = 99;
    writeRecord(fixture, unsupported);
    expect(checkRunEvidence(request(fixture)).state).toBe("unsupported");
    const unsupportedLimits = structuredClone(record);
    unsupportedLimits.limitsVersion = "future";
    writeRecord(fixture, unsupportedLimits);
    expect(checkRunEvidence(request(fixture)).state).toBe("unsupported");
    const malformedBytes = structuredClone(record);
    (malformedBytes.source as Record<string, unknown>).bytes = String(SOURCE.length);
    writeRecord(fixture, malformedBytes);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    const wrongArchiveRef = structuredClone(record);
    (wrongArchiveRef.artifacts as Array<Record<string, unknown>>)[0]!.archiveRef = "elsewhere/artifact-1.bin";
    writeRecord(fixture, wrongArchiveRef);
    expect(checkRunEvidence(request(fixture)).state).toBe("mismatch");
    writeRecord(fixture, record);

    const unknownPhase = structuredClone(record);
    unknownPhase.phase = "mystery";
    writeRecord(fixture, unknownPhase);
    const unknownProcess = checkRunEvidence(request(fixture));
    expect(unknownProcess.state).toBe("unknown");
    expect(unknownProcess.processRecorded.state).toBe("unknown_recorded");

    const prepared = structuredClone(record);
    prepared.phase = "prepared";
    prepared.process = null;
    delete prepared.artifacts;
    delete prepared.artifactTotalBytes;
    writeRecord(fixture, prepared);
    const preparedResult = checkRunEvidence(request(fixture, { artifactIds: [] }));
    expect(preparedResult.state).toBe("incomplete");
    expect(preparedResult.processRecorded.state).toBe("incomplete_recorded");
    expect(preparedResult.bytes.source?.state).toBe("matched");
    expect(preparedResult.bytes.inputs[0]!.state).toBe("matched");

    const controlFalse = structuredClone(record);
    ((controlFalse.process as Record<string, unknown>).watchdog as Record<string, unknown>).controlEnded = false;
    writeRecord(fixture, controlFalse);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    const controlMissing = structuredClone(record);
    delete ((controlMissing.process as Record<string, unknown>).watchdog as Record<string, unknown>).controlEnded;
    writeRecord(fixture, controlMissing);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    const controlError = structuredClone(record);
    ((controlError.process as Record<string, unknown>).watchdog as Record<string, unknown>).controlError = "boom";
    writeRecord(fixture, controlError);
    expect(checkRunEvidence(request(fixture)).state).toBe("unknown");
    const groupMissing = structuredClone(record);
    (groupMissing.process as Record<string, unknown>).groupGone = false;
    writeRecord(fixture, groupMissing);
    expect(checkRunEvidence(request(fixture)).state).toBe("incomplete");
    const limited = structuredClone(record);
    limited.artifactLimitReached = true;
    writeRecord(fixture, limited);
    expect(checkRunEvidence(request(fixture)).state).toBe("incomplete");
    writeRecord(fixture, record);

    expect(codeOf(() => checkRunEvidence(request(fixture, { runLocator: "/etc/record.json" })))).toBe("invalid");
    expect(codeOf(() => checkRunEvidence(request(fixture, { runLocator: "run-fixed/../record.json" })))).toBe("invalid");
    expect(codeOf(() => checkRunEvidence(request(fixture, { runLocator: "run-fixed/other.json" })))).toBe("invalid");
    expect(codeOf(() => checkRunEvidence(request(fixture, { runLocator: "run-fixed/record.json\0" })))).toBe("invalid");

    const missingRecordRoot = path.join(fixture.root, "execution", "run-missing");
    mkdirSync(missingRecordRoot);
    expect(checkRunEvidence(request(fixture, { runLocator: "run-missing/record.json" })).state).toBe("missing");

    const recordBackup = readFileSync(fixture.recordPath);
    unlinkSync(fixture.recordPath);
    const outsideRecord = path.join(fixture.root, "outside-record.json");
    writeFileSync(outsideRecord, recordBackup);
    symlinkSync(outsideRecord, fixture.recordPath);
    expect(checkRunEvidence(request(fixture)).state).toBe("changed");
    unlinkSync(fixture.recordPath);
    writeFileSync(fixture.recordPath, recordBackup);
    fixture.cleanup();
  });

  test("keeps an accepted reference as recorded data only", () => {
    const fixture = makeFixture();
    const accepted: ManagedTask = structuredClone(fixture.task);
    accepted.status = "accepted";
    accepted.cancelledAt = null;
    accepted.acceptance = {
      acceptanceId: "acceptance-g3a",
      deliveryId: "delivery-g3a",
      recordDigest: `sha256:${"a".repeat(64)}`,
      acceptedAt: NOW,
    };
    const acceptedCapture = fixture.writer.capture(accepted);
    expect(acceptedCapture.status).toBe("appended");
    const beforeSnapshot = fixture.owner.snapshot();
    const result = checkRunEvidence(request(fixture, {
      item: {
        historyId: acceptedCapture.item.historyId,
        digest: acceptedCapture.item.digest,
        taskId: acceptedCapture.item.taskId,
        taskRevision: acceptedCapture.item.taskRevision,
      },
    }));
    expect(result.state).toBe("consistent");
    expect(result.history).toMatchObject({
      recordedStatus: "accepted",
      recordedAcceptanceReference: {
        acceptanceId: "acceptance-g3a",
        deliveryId: "delivery-g3a",
        recordDigest: `sha256:${"a".repeat(64)}`,
        acceptedAt: NOW,
      },
    });
    expect(result.acceptanceEvidence).toBe("not_checked");
    expect(result.authorityRestored).toBe(false);
    expect(result.candidateRegistration).toBe("not_checked");
    expect(result.branchVisibility).toBe("not_checked");
    expect(fixture.owner.snapshot().currentTask).toEqual(beforeSnapshot.currentTask);
    expect(fixture.owner.snapshot().activeGrant).toEqual(beforeSnapshot.activeGrant);
    expect(fixture.owner.snapshot().currentTask?.status).toBe("active");
    expect(fixture.owner.snapshot().currentTask?.acceptance).toBeNull();
    fixture.cleanup();
  });
});
