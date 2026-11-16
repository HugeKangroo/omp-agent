import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE,
  NATIVE_HARNESS_HISTORY_SESSION_SCHEMA,
  createNativeHarnessHistorySession,
  type NativeHarnessHistorySession,
  type NativeHarnessHistorySourceCandidate,
} from "../../src/native-harness-history-session.ts";
import {
  nodeFileIo,
  type NativeFileIo,
} from "../../src/native-work.ts";

const HARNESS_NAME = "omp-harness-abc123";
const RUN_ID = "run-fixture-1";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "session-r1b1";
const SOURCE_CALL_ID = "call-source-1";
const REPORT_CALL_ID = "call-report-1";
const SOURCE_CALL_ID_2 = "call-source-2";
const REPORT_CALL_ID_2 = "call-report-2";
const RUN_ID_2 = "run-fixture-2";
const OBSERVATION_ID = "native-work-1";
const GENERATION = 1;
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const ENDED_AT = "2026-01-01T00:00:01.000Z";
const ARTIFACT_TEXT = "hello artifact\n";

type Entry = Record<string, unknown> & {
  id: string;
  parentId: string | null;
  type: string;
  value?: never;
};

type DiskShape =
  | "title-auto"
  | "title-user"
  | "title-minimal"
  | "title-malformed"
  | "title-version"
  | "title-source"
  | "title-duplicate"
  | "title-after-header"
  | "title-missing-header"
  | "arbitrary-prefix"
  | "extra-session-header";

interface FixtureOptions {
  readonly append?: "native" | "noop" | "throw" | "rewrite-prefix" | "navigate";
  readonly ensure?:
    | "write"
    | "noop"
    | "throw"
    | "deferred"
    | "bom"
    | "oversize"
    | "header-mismatch"
    | "wrong-parent"
    | "duplicate-locator";
  readonly ownerCurrent?: (context: unknown) => boolean;
  readonly oversizedReport?: boolean;
  readonly withSource?: boolean;
  readonly withReport?: boolean;
  readonly duplicateSource?: boolean;
  readonly secondSource?: boolean;
  readonly holdOpen?: boolean;
  readonly reportRunId?: string;
  readonly reportSourceCallId?: string;
  readonly candidateSessionId?: string;
  readonly ensureOnDiskTimeoutMs?: number;
  readonly diskShape?: DiskShape;
}

interface HostState {
  branch: Entry[];
  leafId: string | null;
  sessionId: string;
  cwd: string;
  recordedCwd: string;
  sessionDir: string;
  sessionFile: string;
  appendCalls: number;
  ensureCalls: number;
  sequence: number;
  resolveEnsure: (() => void) | null;
  rejectEnsure: ((error: unknown) => void) | null;
  openCalls: number;
  closeCalls: number;
  openReached: Promise<void>;
  releaseOpen: () => void;
}

interface Fixture {
  readonly root: string;
  readonly storageRoot: string;
  readonly harnessRoot: string;
  readonly storeRoot: string;
  readonly mainWorkspace: string;
  readonly winnerCwd: string;
  readonly artifactPath: string;
  readonly state: HostState;
  readonly session: NativeHarnessHistorySession;
  readonly candidate: NativeHarnessHistorySourceCandidate;
  appendEntry(customType: string, data?: unknown): void;
  context(): unknown;
  dispose(): void;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.dispose();
    } catch {
      // Disposal is also asserted where relevant.
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Mirrors the fixed host title slot: JSON body padded to 255 bytes plus LF. */
function fixedTitleLine(title: string, source?: "auto" | "user"): string {
  const record: Record<string, unknown> = { type: "title", v: 1, title };
  if (source !== undefined) record.source = source;
  record.updatedAt = "2026-01-01T00:00:00.000Z";
  record.pad = "";
  const unpadded = Buffer.byteLength(JSON.stringify(record), "utf8");
  record.pad = " ".repeat(Math.max(0, 255 - unpadded));
  return `${JSON.stringify(record)}\n`;
}

function sourceDetails(runId = RUN_ID): Record<string, unknown> {
  return {
    schema: "omp-agent.native-harness-tool-result.v1",
    tool: "agent_harness",
    authority: "non-authoritative",
    resultKind: "live",
    historical: false,
    authorityFresh: true,
    outcome: "backend-completed",
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    runId,
    backendStatus: "completed",
    executionState: "settled",
    termination: "none",
    cancellation: "none",
    cancelError: null,
    deadlineAt: 1_800_000_000_000,
    elapsedMs: 12,
    cost: { allocatedUsd: 1, observedUsd: 0.1, unknownUsd: 0.9, overspendUsd: 0 },
    limitations: [],
    reason: null,
  };
}

function reportDetails(
  fixture: Pick<Fixture, "mainWorkspace">,
  options: Pick<FixtureOptions, "reportRunId" | "reportSourceCallId"> = {},
): Record<string, unknown> {
  const artifactBytes = Buffer.byteLength(ARTIFACT_TEXT, "utf8");
  const artifactSha = sha256(ARTIFACT_TEXT);
  return {
    kind: "native-work-report",
    interface: "omp-agent.native-work-observation.v1",
    authority: "non-authoritative",
    work: {
      observationId: OBSERVATION_ID,
      generation: GENERATION,
      sessionId: SESSION_ID,
      workspaceRoot: fixture.mainWorkspace,
      statusAtReport: "ended",
      request: { attribution: "matched-user-input", excerpt: null, excerptTruncated: false, note: "" },
    },
    modelDeclared: { outcome: "completed", summary: null, limitations: [] },
    observed: {
      checks: [],
      coverage: {
        selected: 0,
        observedResults: 0,
        observedErrorResults: 0,
        callsInWorkWithoutObservedResult: 0,
        callsDroppedFromWork: 0,
        unverified: [],
      },
      outputFiles: [],
    },
    recordedAt: 101,
    caveats: [],
    harnessResult: {
      facts: {
        schema: "omp-agent.native-harness-report-binding.v1",
        authority: "non-authoritative",
        modelDeclaredOutcome: "completed",
        source: {
          toolCallId: options.reportSourceCallId ?? SOURCE_CALL_ID,
          observationId: OBSERVATION_ID,
          generation: GENERATION,
          taskSha256: sha256("task"),
          promptSha256: sha256("prompt"),
          inputSha256: sha256("input"),
          observedEnvelopeSha256: sha256("envelope"),
          observedEnvelopeBytes: 42,
        },
        capture: {
          captureId: "capture-1",
          captureDigest: sha256("capture"),
          originKind: "harness2",
          completionId: "completion-1",
          runId: options.reportRunId ?? RUN_ID,
          baseSnapshotId: "base-snapshot-1",
          manifestSha256: sha256("manifest"),
          winner: {
            candidate: "baseline",
            attempt: 1,
            artifactHash: "a".repeat(64),
            traceHash: "b".repeat(64),
          },
          observedAt: 100,
        },
        files: [{
          path: "result.txt",
          kind: "add",
          mode: 0o644,
          controllerHash: sha256("controller"),
          fileSnapshotId: "file-snapshot-1",
          bytes: artifactBytes,
          sha256: artifactSha,
          observedAt: 100,
          check: null,
        }],
        coverage: {
          capturedPathCount: 1,
          selectedPathCount: 0,
          passPathCount: 0,
          failPathCount: 0,
          missingPathCount: 1,
          conditionPassCount: 0,
          conditionFailCount: 0,
          completedCoverage: false,
          missing: [{ path: "result.txt" }],
          failed: [],
        },
        filesystemFreshness: "not-rechecked",
        taskAccepted: false,
        semanticAcceptance: "not-evaluated",
      },
      reread: {
        schema: "omp-agent.native-harness-report-reread.v1",
        ok: true,
        sourceToolCallId: SOURCE_CALL_ID,
        reportToolCallId: REPORT_CALL_ID,
        reportInputSha256: sha256("report-input"),
        captureId: "capture-1",
        captureDigest: sha256("capture"),
        attempt: 1,
        startedAt: 100,
        finishedAt: 101,
        sameVersion: true,
        taskAccepted: false,
        semanticAcceptance: "not-evaluated",
      },
    },
  };
}

function hugeRelativePath(index: number): string {
  return `${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(255)}/${"d".repeat(200)}/file-${index}.txt`;
}

function makeReportProjectionOversized(report: Record<string, unknown>): void {
  const harnessResult = report.harnessResult as Record<string, unknown>;
  const facts = harnessResult.facts as Record<string, unknown>;
  const coverage = facts.coverage as Record<string, unknown>;
  const files: Record<string, unknown>[] = [];
  const missing: { path: string }[] = [];
  const failed: { path: string; checkToolCallId: string }[] = [];
  for (let index = 0; index < 8; index += 1) {
    const filePath = hugeRelativePath(index);
    missing.push({ path: filePath });
    failed.push({ path: filePath, checkToolCallId: "c".repeat(256) });
    files.push({
      path: filePath,
      kind: "add",
      mode: 0o644,
      controllerHash: sha256(`controller-${index}`),
      fileSnapshotId: "s".repeat(256),
      bytes: 1,
      sha256: sha256(`file-${index}`),
      observedAt: 100,
      check: {
        checkToolCallId: "k".repeat(256),
        computedByToolCallId: "m".repeat(256),
        checkerId: "fixture-checker",
        checkerVersion: "1",
        planSource: "fixture-plan",
        planDigest: sha256(`plan-${index}`),
        receipt: {
          checkerId: "fixture-checker",
          checkerVersion: "1",
          planDigest: sha256(`plan-${index}`),
          outcome: "pass",
          taskAccepted: false,
          semanticAcceptance: "not-evaluated",
          conditions: Array.from({ length: 32 }, (_, condition) => ({
            id: `${"i".repeat(120)}-${index}-${condition}`,
            result: "pass",
          })),
        },
      },
    });
  }
  facts.files = files;
  coverage.capturedPathCount = 8;
  coverage.selectedPathCount = 8;
  coverage.passPathCount = 8;
  coverage.failPathCount = 0;
  coverage.missingPathCount = 8;
  coverage.conditionPassCount = 256;
  coverage.conditionFailCount = 0;
  coverage.completedCoverage = false;
  coverage.missing = missing;
  coverage.failed = failed;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const created = mkdtempSync(path.join(tmpdir(), "omp-r1b1-session-"));
  const root = realpathSync(created);
  const storageRoot = root;
  const harnessRoot = path.join(root, HARNESS_NAME);
  const storeRoot = path.join(harnessRoot, "store");
  const runRoot = path.join(storeRoot, "runs", RUN_ID);
  const mainWorkspace = path.join(harnessRoot, "workspace");
  const winnerCwd = path.join(runRoot, "stages", "baseline", `attempt-1-${ATTEMPT_ID}`, "workspace");
  const artifactPath = path.join(winnerCwd, "result.txt");
  const sessionDir = path.join(root, "sessions");
  const sessionFile = path.join(sessionDir, `2026-01-01_${SESSION_ID}.jsonl`);
  mkdirSync(mainWorkspace, { recursive: true });
  mkdirSync(winnerCwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(artifactPath, ARTIFACT_TEXT, "utf8");
  writeFileSync(
    path.join(runRoot, "run.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: RUN_ID,
      revision: 3,
      createdAt: STARTED_AT,
      updatedAt: ENDED_AT,
      workspace: mainWorkspace,
      task: "fixture task",
      status: "completed",
      config: {
        mode: "product",
        strategy: "legacy",
        model: "fixture/model",
        improverModel: "fixture/model",
        maxCostUsd: 0.5,
        maxDurationMs: 5000,
        stageTimeoutMs: 5000,
        domain: "generic",
        ompCommand: "/bin/false",
      },
      baseHarness: {
        schemaVersion: 1,
        id: "fixture-harness",
        promptAppend: "fixture prompt",
        toolGuidance: "fixture guidance",
        rationale: "fixture rationale",
        skills: [],
      },
      libraryEntries: [],
      stages: {
        baseline: {
          id: "baseline",
          status: "completed",
          attempt: 1,
          cwd: winnerCwd,
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          accountedCostUsd: 0.02,
          reservedCostUsd: 0.03,
          observedCostUsd: 0.01,
          artifactHash: "a".repeat(64),
          traceHash: "b".repeat(64),
          result: {
            text: "fixture stage",
            usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
            startedAt: STARTED_AT,
            endedAt: ENDED_AT,
            eventsPath: path.join(winnerCwd, "worker-events.jsonl"),
            status: "completed",
            usageEstimated: true,
          },
        },
      },
      winner: "baseline",
    }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(runRoot, "events.jsonl"),
    [
      { schemaVersion: 1, runId: RUN_ID, timestamp: STARTED_AT, type: "stage_started", message: "started", stage: "baseline" },
      { schemaVersion: 1, runId: RUN_ID, timestamp: ENDED_AT, type: "stage_completed", message: "completed", stage: "baseline" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );

  const branch: Entry[] = [
    { id: "base-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
  ];
  if (options.withSource !== false) {
    branch.push({
      id: "source-entry",
      parentId: "base-1",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: SOURCE_CALL_ID,
        toolName: "agent_harness",
        isError: false,
        content: [{ type: "text", text: "source observed" }],
        details: sourceDetails(),
      },
    });
    if (options.duplicateSource === true) {
      branch.push({
        id: "source-entry-duplicate",
        parentId: "source-entry",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: SOURCE_CALL_ID,
          toolName: "agent_harness",
          isError: false,
          content: [{ type: "text", text: "duplicate source observed" }],
          details: sourceDetails(),
        },
      });
    }
  }
  if (options.withReport !== false && options.withSource !== false) {
    const details = reportDetails({
      mainWorkspace,
    }, {
      ...(options.reportRunId === undefined ? {} : { reportRunId: options.reportRunId }),
      ...(options.reportSourceCallId === undefined ? {} : { reportSourceCallId: options.reportSourceCallId }),
    });
    if (options.oversizedReport === true) makeReportProjectionOversized(details);
    branch.push({
      id: "report-entry",
      parentId: branch[branch.length - 1]!.id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: REPORT_CALL_ID,
        toolName: "agent_work",
        isError: false,
        content: [{ type: "text", text: "report observed" }],
        details,
      },
    });
  }
  if (options.secondSource === true) {
    branch.push({
      id: "source-entry-2",
      parentId: branch[branch.length - 1]!.id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: SOURCE_CALL_ID_2,
        toolName: "agent_harness",
        isError: false,
        content: [{ type: "text", text: "second source observed" }],
        details: sourceDetails(RUN_ID_2),
      },
    });
    const secondDetails = reportDetails(
      { mainWorkspace },
      { reportRunId: RUN_ID_2, reportSourceCallId: SOURCE_CALL_ID_2 },
    );
    const reread = (secondDetails.harnessResult as Record<string, unknown>).reread as Record<string, unknown>;
    reread.sourceToolCallId = SOURCE_CALL_ID_2;
    reread.reportToolCallId = REPORT_CALL_ID_2;
    branch.push({
      id: "report-entry-2",
      parentId: "source-entry-2",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: REPORT_CALL_ID_2,
        toolName: "agent_work",
        isError: false,
        content: [{ type: "text", text: "second report observed" }],
        details: secondDetails,
      },
    });
  }
  let openReachedResolve: (() => void) | null = null;
  let releaseOpenResolve: (() => void) | null = null;
  const openReached = new Promise<void>((resolve) => {
    openReachedResolve = resolve;
  });
  const openRelease = new Promise<void>((resolve) => {
    releaseOpenResolve = resolve;
  });
  const state: HostState = {
    branch,
    leafId: branch[branch.length - 1]!.id,
    sessionId: SESSION_ID,
    cwd: mainWorkspace,
    recordedCwd: mainWorkspace,
    sessionDir,
    sessionFile,
    appendCalls: 0,
    ensureCalls: 0,
    sequence: 0,
    resolveEnsure: null,
    rejectEnsure: null,
    openCalls: 0,
    closeCalls: 0,
    openReached,
    releaseOpen: () => {
      releaseOpenResolve?.();
    },
  };
  const writeSession = (): void => {
    const header = {
      type: "session",
      version: 3,
      id: state.sessionId,
      timestamp: STARTED_AT,
      cwd: options.ensure === "header-mismatch" ? path.join(root, "other-workspace") : state.recordedCwd,
    };
    const branch = state.branch.map((entry) => ({ ...entry }));
    if (options.ensure === "wrong-parent") {
      const last = branch[branch.length - 1];
      if (last !== undefined) last.parentId = "base-1";
    }
    if (options.ensure === "duplicate-locator") {
      const last = branch[branch.length - 1];
      if (last !== undefined && last.type === "custom") {
        branch.push({
          id: "locator-duplicate",
          parentId: last.id,
          type: "custom",
          customType: last.customType,
          data: last.data,
        });
      }
    }
    const headerLine = jsonLine(header);
    const branchText = branch.map(jsonLine).join("");
    let body = headerLine + branchText;
    switch (options.diskShape) {
      case undefined:
        break;
      case "title-auto":
        body = fixedTitleLine("Fixture session", "auto") + headerLine + branchText;
        break;
      case "title-user":
        body = fixedTitleLine("会话 ✓ タイトル", "user") + headerLine + branchText;
        break;
      case "title-minimal":
        body = jsonLine({
          type: "title",
          v: 1,
          title: "minimal",
          updatedAt: "whenever",
          pad: "x",
        }) + headerLine + branchText;
        break;
      case "title-malformed":
        body = jsonLine({ type: "title", v: 1, title: "x", updatedAt: "whenever" }) + headerLine + branchText;
        break;
      case "title-version":
        body = jsonLine({ type: "title", v: 2, title: "x", updatedAt: "whenever", pad: "" }) + headerLine + branchText;
        break;
      case "title-source":
        body = jsonLine({
          type: "title",
          v: 1,
          title: "x",
          source: "system",
          updatedAt: "whenever",
          pad: "",
        }) + headerLine + branchText;
        break;
      case "title-duplicate":
        body = fixedTitleLine("first", "auto") + headerLine + fixedTitleLine("second", "user") + branchText;
        break;
      case "title-after-header":
        body = headerLine + fixedTitleLine("late", "auto") + branchText;
        break;
      case "title-missing-header":
        body = fixedTitleLine("only", "auto") + branchText;
        break;
      case "arbitrary-prefix":
        body = jsonLine({ type: "note", v: 1 }) + headerLine + branchText;
        break;
      case "extra-session-header":
        body = fixedTitleLine("x", "auto")
          + headerLine
          + jsonLine({ type: "session", id: state.sessionId, parentId: null })
          + branchText;
        break;
    }
    if (options.ensure === "bom") {
      writeFileSync(state.sessionFile, `\uFEFF${body}`, "utf8");
      return;
    }
    if (options.ensure === "oversize") {
      writeFileSync(state.sessionFile, body + "x".repeat(300 * 1024), "utf8");
      return;
    }
    writeFileSync(state.sessionFile, body, "utf8");
  };
  const appendEntry = (customType: string, data?: unknown): void => {
    state.appendCalls += 1;
    const mode = options.append ?? "native";
    if (mode === "throw") throw new Error("fixture append failure");
    if (mode === "noop") return;
    if (mode === "rewrite-prefix") {
      const source = state.branch.find((entry) => entry.id === "source-entry");
      if (source !== undefined) {
        (source.message as Record<string, unknown>).details = sourceDetails("other-run");
      }
    }
    state.sequence += 1;
    const id = `locator-${state.sequence}`;
    state.branch.push({ id, parentId: state.leafId, type: "custom", customType, data });
    state.leafId = id;
    if (mode === "navigate") state.leafId = "base-1";
  };
  const manager = {
    getSessionId: () => state.sessionId,
    getCwd: () => state.cwd,
    getRecordedCwd: () => state.recordedCwd,
    getSessionDir: () => state.sessionDir,
    getSessionFile: () => state.sessionFile,
    getLeafId: () => state.leafId,
    getBranch: () => state.branch.slice(),
    ensureOnDisk: async () => {
      state.ensureCalls += 1;
      const mode = options.ensure ?? "write";
      if (mode === "throw") throw new Error("fixture ensure failure");
      if (mode === "noop") return;
      if (mode === "deferred") {
        await new Promise<void>((resolve, reject) => {
          state.resolveEnsure = resolve;
          state.rejectEnsure = reject;
        });
        writeSession();
        return;
      }
      writeSession();
    },
  };
  const fileIo: NativeFileIo = {
    ...nodeFileIo,
    open: async (target, flags) => {
      state.openCalls += 1;
      if (options.holdOpen === true && state.openCalls === 1) {
        openReachedResolve?.();
        await openRelease;
      }
      const handle = await nodeFileIo.open(target, flags);
      return {
        stat: (statOptions) => handle.stat(statOptions),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async () => {
          state.closeCalls += 1;
          await handle.close();
        },
      };
    },
  };
  const session = createNativeHarnessHistorySession({
    storageRoot,
    appendEntry,
    isOwnerCurrent: options.ownerCurrent ?? (() => true),
    fileIo,
    now: () => 1_000,
    ...(options.ensureOnDiskTimeoutMs === undefined ? {} : { ensureOnDiskTimeoutMs: options.ensureOnDiskTimeoutMs }),
  });
  const candidate: NativeHarnessHistorySourceCandidate = {
    association: {
      observationId: OBSERVATION_ID,
      generation: GENERATION,
      sessionId: options.candidateSessionId ?? SESSION_ID,
      workspaceRoot: mainWorkspace,
      toolCallId: SOURCE_CALL_ID,
      toolName: "agent_harness",
    },
    runId: RUN_ID,
    backend: {
      preparedRoot: harnessRoot,
      storeRoot,
      inputManifestSha256: sha256("manifest"),
    },
    definitionVersion: "definition-v1",
    backendSourceId: "c".repeat(64),
    configurationSha256: "d".repeat(64),
  };
  const fixture: Fixture = {
    root,
    storageRoot,
    harnessRoot,
    storeRoot,
    mainWorkspace,
    winnerCwd,
    artifactPath,
    state,
    session,
    candidate,
    appendEntry,
    context() {
      return {
        cwd: mainWorkspace,
        agent: { kind: "main" },
        sessionManager: manager,
      };
    },
    dispose() {
      session.dispose();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function locatorEntryId(session: NativeHarnessHistorySession, context: unknown): string {
  const listed = session.list(context, { limit: 16 });
  expect(listed.rows.length).toBe(1);
  return listed.rows[0]!.entryId;
}

interface ScopedHostProbe {
  readonly context: Record<string, unknown>;
  branchReads(): number;
}

/**
 * Synthetic host capability fixture: Object.create(baseCtx) with only ui owned;
 * agent, cwd and sessionManager are inherited. getBranch is observational.
 */
function scopedHostProbe(fixture: Fixture, onBranchRead?: (count: number) => void): ScopedHostProbe {
  const base = fixture.context() as {
    readonly agent: unknown;
    readonly cwd: string;
    readonly sessionManager: Record<string, unknown>;
  };
  let reads = 0;
  const manager: Record<string, unknown> = Object.create(base.sessionManager);
  Object.defineProperty(manager, "getBranch", {
    value: () => {
      reads += 1;
      onBranchRead?.(reads);
      return (base.sessionManager.getBranch as () => Entry[])();
    },
    enumerable: true,
    configurable: true,
  });
  const context: Record<string, unknown> = Object.create({
    agent: base.agent,
    cwd: base.cwd,
    sessionManager: manager,
  });
  context.ui = { setWidget: () => undefined };
  return { context, branchReads: () => reads };
}

function secondCandidate(fixture: Fixture): NativeHarnessHistorySourceCandidate {
  return {
    ...fixture.candidate,
    association: { ...fixture.candidate.association, toolCallId: SOURCE_CALL_ID_2 },
    runId: RUN_ID_2,
  };
}

describe("native harness history session leaf", () => {
  test("publishes one exact locator, confirms local disk readback, lists and re-queries without executing work", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(published.state).toBe("published");
    expect(published.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    const entryId = published.publications[0]?.entryId;
    const digest = published.publications[0]?.locatorSha256;
    expect(entryId).toBeTruthy();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);

    const listed = fixture.session.list(fixture.context(), { limit: 16 });
    expect(listed.state).toBe("complete");
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]?.entryId).toBe(entryId!);
    expect(listed.rows[0]?.locatorSha256).toBe(digest!);
    expect(listed.rows[0]?.labelCompatibility).toBe("match");

    const inspected = await fixture.session.inspect(
      fixture.context(),
      { entryId: entryId!, locatorSha256: digest! },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("observed");
    expect(inspected.current).toBe(true);
    expect(inspected.evidence.source).toBe("match");
    expect(inspected.evidence.report).toBe("match");
    expect(inspected.declaration.state).toBe("present");
    expect(inspected.declaration.files).toBe(1);
    expect(inspected.inspection?.artifactIntegrity.results[0]?.status).toBe("match");
    expect(inspected.inspection?.eligibility.authorityRestored).toBe(false);
    expect(inspected.inspection?.eligibility.resumeAvailable).toBe(false);
    expect(inspected.inspection?.processObservation.inspected).toBe(false);
    expect(fixture.state.appendCalls).toBe(1);

    const again = await fixture.session.inspect(
      fixture.context(),
      { entryId: entryId!, locatorSha256: digest! },
      new AbortController().signal,
    );
    expect(again.locator?.runId).toBe(RUN_ID);
    expect(again.inspection?.query.storageRoot).toBe(fixture.storageRoot);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.session.status().diskConfirmed).toBe(1);
  });

  test("duplicate callback is idempotent and does not append again", async () => {
    const fixture = makeFixture();
    const first = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const second = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(first.publications[0]?.outcome).toBe("disk-confirmed");
    expect(second.publications[0]?.outcome).toBe("already-visible");
    expect(second.publications[0]?.entryId).toBe(first.publications[0]?.entryId);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
  });

  test("continuation is ignored; missing source, ambiguous source and foreign candidate stay unavailable", async () => {
    const fixture = makeFixture();
    const ignored = await fixture.session.publishTerminal(fixture.context(), { willContinue: true }, [fixture.candidate]);
    expect(ignored.state).toBe("ignored");
    expect(fixture.state.appendCalls).toBe(0);

    const missing = makeFixture({ withSource: false, withReport: false });
    const missingResult = await missing.session.publishTerminal(missing.context(), {}, [missing.candidate]);
    expect(missingResult.publications[0]?.outcome).toBe("unavailable");
    expect(missingResult.publications[0]?.reasons[0]?.code).toBe("source-missing");
    expect(missing.state.appendCalls).toBe(0);

    const ambiguous = makeFixture({ duplicateSource: true, withReport: false });
    const ambiguousResult = await ambiguous.session.publishTerminal(ambiguous.context(), {}, [ambiguous.candidate]);
    expect(ambiguousResult.publications[0]?.outcome).toBe("unavailable");
    expect(ambiguousResult.publications[0]?.reasons[0]?.code).toBe("source-ambiguous");
    expect(ambiguous.state.appendCalls).toBe(0);

    const foreign = makeFixture({ candidateSessionId: "other-session" });
    const foreignResult = await foreign.session.publishTerminal(foreign.context(), {}, [foreign.candidate]);
    expect(foreignResult.publications[0]?.outcome).toBe("unavailable");
    expect(foreign.state.appendCalls).toBe(0);
  });

  test("report mismatch blocks publication rather than substituting another report", async () => {
    const fixture = makeFixture({ reportRunId: "other-run" });
    const result = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(result.state).toBe("unavailable");
    expect(result.publications[0]?.outcome).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(0);
  });

  test("append failure is unknown; no-op ensure is visible but never disk-confirmed", async () => {
    const appendFailure = makeFixture({ append: "throw" });
    const failed = await appendFailure.session.publishTerminal(appendFailure.context(), {}, [appendFailure.candidate]);
    expect(failed.state).toBe("unknown");
    expect(failed.publications[0]?.outcome).toBe("unknown");
    expect(appendFailure.state.appendCalls).toBe(1);

    const noEnsure = makeFixture({ ensure: "noop" });
    const visible = await noEnsure.session.publishTerminal(noEnsure.context(), {}, [noEnsure.candidate]);
    expect(visible.publications[0]?.outcome).toBe("visible");
    expect(visible.publications[0]?.reasons[0]?.code).toBe("disk-unavailable");
    expect(noEnsure.session.status().diskConfirmed).toBe(0);
    expect(noEnsure.state.appendCalls).toBe(1);
  });

  test("BOM, oversized and header-mismatched local files do not become false persistence", async () => {
    for (const ensure of ["bom", "oversize", "header-mismatch"] as const) {
      const fixture = makeFixture({ ensure });
      const result = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
      expect(result.publications[0]?.outcome).toBe("visible");
      expect(result.publications[0]?.durability).toBe("unknown");
      expect(fixture.session.status().diskConfirmed).toBe(0);
    }
  });

  test("bounded persistence timeout keeps one pending ensure and late completion never appends again", async () => {
    const fixture = makeFixture({ ensure: "deferred", ensureOnDiskTimeoutMs: 5 });
    const result = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(result.publications[0]?.outcome).toBe("visible");
    expect(result.publications[0]?.reasons[0]?.code).toBe("persist-timeout");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.resolveEnsure).not.toBeNull();
    const entryId = result.publications[0]?.entryId;
    const digest = result.publications[0]?.locatorSha256;

    fixture.state.resolveEnsure!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const again = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(again.publications[0]?.outcome).toBe("already-visible");
    expect(again.publications[0]?.entryId).toBe(entryId);
    expect(again.publications[0]?.locatorSha256).toBe(digest);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
  });

  test("one publication latch refuses a distinct evidence key while the ensure is held", async () => {
    const fixture = makeFixture({ ensure: "deferred", secondSource: true });
    const first = fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.session.status().publishing).toBe(true);
    expect(fixture.session.status().persistPending).toBe(true);

    const refused = await fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(refused.state).toBe("unknown");
    expect(refused.publications).toHaveLength(0);
    expect(refused.reasons[0]?.code).toBe("publication-pending");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.openCalls).toBe(0);

    fixture.state.resolveEnsure!();
    const firstResult = await first;
    expect(firstResult.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.session.status().publishing).toBe(false);
    expect(fixture.session.status().persistPending).toBe(false);

    const second = fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(fixture.state.appendCalls).toBe(2);
    fixture.state.resolveEnsure!();
    const secondResult = await second;
    expect(secondResult.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.state.appendCalls).toBe(2);
    expect(fixture.state.ensureCalls).toBe(2);
  });

  test("one publication latch refuses a distinct evidence key while disk readback is held", async () => {
    const fixture = makeFixture({ secondSource: true, holdOpen: true });
    const first = fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    await fixture.state.openReached;
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.openCalls).toBe(1);
    expect(fixture.session.status().publishing).toBe(true);
    expect(fixture.session.status().persistPending).toBe(false);

    const opens = fixture.state.openCalls;
    const refused = await fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(refused.state).toBe("unknown");
    expect(refused.reasons[0]?.code).toBe("publication-pending");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.openCalls).toBe(opens);

    fixture.state.releaseOpen();
    const firstResult = await first;
    expect(firstResult.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.session.status().publishing).toBe(false);

    const second = await fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(second.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.state.appendCalls).toBe(2);
    expect(fixture.state.ensureCalls).toBe(2);
  });

  test("an unsettled ensure after timeout refuses a new evidence key before append", async () => {
    const fixture = makeFixture({ ensure: "deferred", ensureOnDiskTimeoutMs: 5, secondSource: true });
    const first = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(first.publications[0]?.outcome).toBe("visible");
    expect(first.publications[0]?.reasons[0]?.code).toBe("persist-timeout");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.session.status().publishing).toBe(false);
    expect(fixture.session.status().persistPending).toBe(true);

    const refused = await fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(refused.state).toBe("unknown");
    expect(refused.publications).toHaveLength(0);
    expect(refused.reasons[0]?.code).toBe("persist-pending");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.openCalls).toBe(0);

    fixture.state.resolveEnsure!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.session.status().persistPending).toBe(false);
    expect(fixture.state.appendCalls).toBe(1);

    const second = fixture.session.publishTerminal(fixture.context(), {}, [secondCandidate(fixture)]);
    expect(fixture.state.appendCalls).toBe(2);
    expect(fixture.state.ensureCalls).toBe(2);
    fixture.state.resolveEnsure!();
    const secondResult = await second;
    expect(secondResult.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.state.appendCalls).toBe(2);
  });

  test("branch mutation during append and navigation during persistence never become success", async () => {
    const rewrite = makeFixture({ append: "rewrite-prefix" });
    const rewritten = await rewrite.session.publishTerminal(rewrite.context(), {}, [rewrite.candidate]);
    expect(rewritten.publications[0]?.outcome).toBe("unknown");
    expect(rewrite.state.appendCalls).toBe(1);

    const navigateAppend = makeFixture({ append: "navigate" });
    const navigatedAppend = await navigateAppend.session.publishTerminal(
      navigateAppend.context(),
      {},
      [navigateAppend.candidate],
    );
    expect(navigatedAppend.publications[0]?.outcome).toBe("unknown");

    const pending = makeFixture({ ensure: "deferred", ensureOnDiskTimeoutMs: 5 });
    const pendingResult = await pending.session.publishTerminal(pending.context(), {}, [pending.candidate]);
    expect(pendingResult.publications[0]?.outcome).toBe("visible");
    pending.state.sessionId = "navigated-session";
    pending.state.resolveEnsure!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pending.session.status().diskConfirmed).toBe(0);
  });

  test("branch, locator and selector caps are explicit; selector mismatch opens no files", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;

    const page = fixture.session.list(fixture.context(), { limit: 17 });
    expect(page.state).toBe("unavailable");
    expect(page.reasons[0]?.code).toBe("page-invalid");

    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const countingSession = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: () => true,
      fileIo: countingIo,
      now: () => 1_000,
    });
    const mismatch = await countingSession.inspect(
      fixture.context(),
      { entryId, locatorSha256: "e".repeat(64) },
      new AbortController().signal,
    );
    expect(mismatch.state).toBe("unavailable");
    expect(mismatch.reasons[0]?.code).toBe("selector-mismatch");
    expect(opens).toBe(0);
    countingSession.dispose();

    const corrupt = makeFixture();
    corrupt.state.branch.push({
      id: "bad-locator",
      parentId: corrupt.state.leafId,
      type: "custom",
      customType: NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE,
      data: { not: "a locator" },
    });
    corrupt.state.leafId = "bad-locator";
    const corruptList = corrupt.session.list(corrupt.context(), { limit: 16 });
    expect(corruptList.state).toBe("incomplete");
    expect(corruptList.rows[0]?.decode).toBe("invalid");
  });

  test("wrong persisted parent or duplicate persisted data is never disk-confirmed", async () => {
    for (const ensure of ["wrong-parent", "duplicate-locator"] as const) {
      const fixture = makeFixture({ ensure });
      const result = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
      expect(result.publications[0]?.outcome).toBe("visible");
      expect(result.publications[0]?.durability).toBe("unknown");
      expect(fixture.session.status().diskConfirmed).toBe(0);
    }
  });

  test("oversized optional report degrades to a source-only locator with explicit unavailability", async () => {
    const fixture = makeFixture({ oversizedReport: true });
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(published.publications[0]?.outcome).toBe("disk-confirmed");
    expect(published.publications[0]?.reasons.some((problem) => problem.code === "report-optional-unavailable")).toBe(true);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const inspected = await fixture.session.inspect(
      fixture.context(),
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.evidence.source).toBe("match");
    expect(inspected.evidence.report).toBe("not-present");
    expect(inspected.declaration.state).toBe("absent");
    expect(inspected.inspection?.artifactIntegrity.coverage).toBe("unavailable");
  });

  test("reordered source/report references are refused before store I/O", async () => {
    const first = makeFixture();
    const published = await first.session.publishTerminal(first.context(), {}, [first.candidate]);
    const locatorId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const locatorEntry = first.state.branch.find((entry) => entry.id === locatorId)! as Entry & { data?: unknown };
    const sourceEntry = structuredClone(first.state.branch.find((entry) => entry.id === "source-entry")!) as Entry;
    const reportEntry = structuredClone(first.state.branch.find((entry) => entry.id === "report-entry")!) as Entry;
    const second = makeFixture({ withSource: false, withReport: false });
    second.state.branch.push({
      id: "locator-reordered",
      parentId: "base-1",
      type: "custom",
      customType: NATIVE_HARNESS_HISTORY_SESSION_CUSTOM_TYPE,
      data: locatorEntry.data,
    });
    sourceEntry.parentId = "locator-reordered";
    second.state.branch.push(sourceEntry);
    reportEntry.parentId = "source-entry";
    second.state.branch.push(reportEntry);
    second.state.leafId = "report-entry";
    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const session = createNativeHarnessHistorySession({
      storageRoot: second.storageRoot,
      isOwnerCurrent: () => true,
      fileIo: countingIo,
      now: () => 1_000,
    });
    const inspected = await session.inspect(
      second.context(),
      { entryId: "locator-reordered", locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("unavailable");
    expect(inspected.current).toBe(false);
    expect(inspected.reasons.some((problem) => problem.code === "reference-order")).toBe(true);
    expect(opens).toBe(0);
    session.dispose();
  });

  test("navigating off the published locator never returns already-visible or appends again", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    expect(published.publications[0]?.outcome).toBe("disk-confirmed");
    expect(fixture.state.appendCalls).toBe(1);
    const index = fixture.state.branch.findIndex((entry) => entry.id === entryId);
    expect(index).toBeGreaterThan(0);
    fixture.state.branch.splice(index, 1);
    fixture.state.leafId = "report-entry";
    const again = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(again.publications[0]?.outcome).toBe("unavailable");
    expect(again.publications[0]?.reasons[0]?.code).toBe("locator-not-current");
    expect(again.publications[0]?.outcome).not.toBe("already-visible");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.session.status().diskConfirmed).toBe(1);
  });

  test("ensure throw after append stays visible and a duplicate callback never appends again", async () => {
    const fixture = makeFixture({ ensure: "throw" });
    const first = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(first.publications[0]?.outcome).toBe("visible");
    expect(first.publications[0]?.reasons[0]?.code).toBe("persist-failed");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    const second = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    expect(second.publications[0]?.outcome).toBe("already-visible");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
  });

  test("aliased storage root is refused before any file open", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const alias = path.join(fixture.root, "storage-alias");
    symlinkSync(fixture.root, alias);
    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const session = createNativeHarnessHistorySession({
      storageRoot: alias,
      isOwnerCurrent: () => true,
      fileIo: countingIo,
      now: () => 1_000,
    });
    const inspected = await session.inspect(
      fixture.context(),
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("unavailable");
    expect(inspected.reasons[0]?.code).toBe("storage-root-unavailable");
    expect(opens).toBe(0);
    session.dispose();
  });

  test("huge or accessor selectors are rejected without echo, getters or I/O", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: () => true,
      fileIo: countingIo,
      now: () => 1_000,
    });
    const huge = await session.inspect(
      fixture.context(),
      { entryId: "x".repeat(1024 * 1024), locatorSha256: digest },
      new AbortController().signal,
    );
    expect(huge.state).toBe("unavailable");
    expect(huge.selector.entryId).toBe("");
    expect(JSON.stringify(huge).length).toBeLessThan(64 * 1024);
    expect(opens).toBe(0);

    let getterReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "entryId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return entryId;
      },
    });
    Object.defineProperty(accessor, "locatorSha256", { enumerable: true, value: digest });
    const fromAccessor = await session.inspect(
      fixture.context(),
      accessor as never,
      new AbortController().signal,
    );
    expect(fromAccessor.state).toBe("unavailable");
    expect(getterReads).toBe(0);
    expect(opens).toBe(0);
    session.dispose();
  });

  test("owner callback receives the actual context and refuses an alternate main with zero I/O", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const allowed = fixture.context();
    const foreignWorkspace = path.join(fixture.root, "foreign-workspace");
    const foreignContext = {
      cwd: foreignWorkspace,
      agent: { kind: "main" },
      sessionManager: {
        getSessionId: () => "foreign-session",
        getCwd: () => foreignWorkspace,
        getRecordedCwd: () => foreignWorkspace,
        getLeafId: () => null,
        getBranch: () => [],
      },
    };
    const seen: unknown[] = [];
    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: (context) => {
        seen.push(context);
        return context === allowed;
      },
      fileIo: countingIo,
      now: () => 1_000,
    });
    const listed = session.list(foreignContext);
    expect(listed.state).toBe("unavailable");
    expect(listed.reasons[0]?.code).toBe("owner-changed");
    const inspected = await session.inspect(
      foreignContext,
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("unavailable");
    expect(inspected.reasons[0]?.code).toBe("owner-changed");
    expect(seen[0]).toBe(foreignContext);
    expect(opens).toBe(0);
    const callsBeforeStatus = seen.length;
    expect(session.status().attempts).toBe(0);
    expect(seen.length).toBe(callsBeforeStatus);
    session.dispose();
  });

  test("selector remains metadata-only and extra fields cannot select a path", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const inspected = await fixture.session.inspect(
      fixture.context(),
      { entryId, locatorSha256: digest, path: "/etc/passwd", storageRoot: "/" } as never,
      new AbortController().signal,
    );
    expect(inspected.current).toBe(true);
    expect(inspected.inspection?.query.storageRoot).toBe(fixture.storageRoot);
    expect(inspected.inspection?.query.storeRelativePath).toBe(`${HARNESS_NAME}/store/runs/${RUN_ID}`);
    expect(fixture.session.status().schema).toBe(NATIVE_HARNESS_HISTORY_SESSION_SCHEMA);
  });

  test("scoped host context with inherited capabilities publishes, lists and inspects one disk-confirmed locator", async () => {
    const seen: unknown[] = [];
    const fixture = makeFixture({
      ownerCurrent: (context) => {
        seen.push(context);
        return true;
      },
    });
    const base = fixture.context() as Record<string, unknown>;
    const scoped = Object.create(base) as Record<string, unknown>;
    scoped.ui = { setWidget: () => undefined };
    expect(Object.getPrototypeOf(scoped)).toBe(base);
    expect(Object.prototype.hasOwnProperty.call(scoped, "agent")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scoped, "cwd")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(scoped, "sessionManager")).toBe(false);

    const published = await fixture.session.publishTerminal(scoped, {}, [fixture.candidate]);
    expect(published.state).toBe("published");
    expect(published.publications[0]?.outcome).toBe("disk-confirmed");
    expect(published.publications[0]?.durability).toBe("observed-only");
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.openCalls).toBe(1);
    expect(fixture.state.closeCalls).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === scoped)).toBe(true);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;

    const listed = fixture.session.list(scoped, { limit: 16 });
    expect(listed.state).toBe("complete");
    expect(listed.rows).toHaveLength(1);
    expect(listed.rows[0]?.entryId).toBe(entryId);
    expect(listed.rows[0]?.locatorSha256).toBe(digest);
    expect(listed.rows[0]?.labelCompatibility).toBe("match");

    const inspected = await fixture.session.inspect(
      scoped,
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("observed");
    expect(inspected.current).toBe(true);
    expect(inspected.evidence.source).toBe("match");
    expect(inspected.evidence.report).toBe("match");
    expect(inspected.labels.originSession).toBe("match");
    expect(inspected.labels.workspace).toBe("match");
    expect(inspected.inspection?.processObservation.inspected).toBe(false);
    expect(inspected.inspection?.eligibility.resumeAvailable).toBe(false);
    expect(inspected.inspection?.query.storageRoot).toBe(fixture.storageRoot);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.session.status().diskConfirmed).toBe(1);
    expect(seen.every((value) => value === scoped)).toBe(true);
  });

  test("throwing host capability getters refuse within bounds and start no append, ensure or file I/O", async () => {
    const fixture = makeFixture();
    const base = fixture.context() as Record<string, unknown>;
    const cwdFailure = Object.create(base) as Record<string, unknown>;
    cwdFailure.ui = {};
    Object.defineProperty(base, "cwd", {
      configurable: true,
      get() {
        throw new Error("host context getter");
      },
    });
    const published = await fixture.session.publishTerminal(cwdFailure, {}, [fixture.candidate]);
    expect(published.state).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(0);
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.openCalls).toBe(0);
    expect(fixture.session.status().attempts).toBe(0);
    const listed = fixture.session.list(cwdFailure);
    expect(listed.state).toBe("unavailable");
    const inspected = await fixture.session.inspect(
      cwdFailure,
      { entryId: "entry", locatorSha256: "e".repeat(64) },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("unavailable");
    expect(inspected.current).toBe(false);
    expect(fixture.state.openCalls).toBe(0);

    const second = makeFixture();
    const managerBase = second.context() as Record<string, unknown>;
    const managerFailure = Object.create(managerBase) as Record<string, unknown>;
    managerFailure.ui = {};
    Object.defineProperty(managerBase, "sessionManager", {
      configurable: true,
      get() {
        throw new Error("host manager getter");
      },
    });
    const managerResult = await second.session.publishTerminal(managerFailure, {}, [second.candidate]);
    expect(managerResult.state).toBe("unavailable");
    expect(second.state.appendCalls).toBe(0);
    expect(second.state.ensureCalls).toBe(0);
    expect(second.state.openCalls).toBe(0);
  });

  test("list never returns current rows when the owner callback disposes after the session read", () => {
    const fixture = makeFixture();
    const probe = scopedHostProbe(fixture);
    let sessionRef: NativeHarnessHistorySession | undefined;
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: (context) => {
        if (context === probe.context && probe.branchReads() >= 1) sessionRef?.dispose();
        return true;
      },
      fileIo: nodeFileIo,
      now: () => 1_000,
    });
    sessionRef = session;
    const listed = session.list(probe.context, { limit: 16 });
    expect(listed.state).toBe("unavailable");
    expect(listed.rows).toHaveLength(0);
    expect(listed.reasons[0]?.code).toBe("disposed");
    expect(probe.branchReads()).toBe(1);
  });

  test("inspect starts no storage-root I/O when the owner is lost after the host read", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const probe = scopedHostProbe(fixture);
    let ioCalls = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        ioCalls += 1;
        return nodeFileIo.realpath(target);
      },
      lstat: async (target, statOptions) => {
        ioCalls += 1;
        return nodeFileIo.lstat(target, statOptions);
      },
      open: async (target, flags) => {
        ioCalls += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    let sessionRef: NativeHarnessHistorySession | undefined;
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: (context) => {
        if (context === probe.context && probe.branchReads() >= 1) sessionRef?.dispose();
        return true;
      },
      fileIo: countingIo,
      now: () => 1_000,
    });
    sessionRef = session;
    const inspected = await session.inspect(
      probe.context,
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("invalidated");
    expect(inspected.current).toBe(false);
    expect(inspected.inspection).toBeNull();
    expect(inspected.reasons.some((problem) => problem.code === "invalidated")).toBe(true);
    expect(ioCalls).toBe(0);
  });

  test("inspect never returns current after disposal on the final owner recheck", async () => {
    const fixture = makeFixture();
    const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
    const entryId = published.publications[0]!.entryId!;
    const digest = published.publications[0]!.locatorSha256!;
    const probe = scopedHostProbe(fixture);
    let opens = 0;
    const countingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    let sessionRef: NativeHarnessHistorySession | undefined;
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      isOwnerCurrent: (context) => {
        if (context === probe.context && probe.branchReads() >= 2) sessionRef?.dispose();
        return true;
      },
      fileIo: countingIo,
      now: () => 1_000,
    });
    sessionRef = session;
    const inspected = await session.inspect(
      probe.context,
      { entryId, locatorSha256: digest },
      new AbortController().signal,
    );
    expect(inspected.state).toBe("invalidated");
    expect(inspected.current).toBe(false);
    expect(inspected.inspection).toBeNull();
    expect(inspected.evidence.source).toBe("match");
    expect(inspected.reasons.some((problem) => problem.code === "invalidated")).toBe(true);
    expect(opens).toBeGreaterThan(0);
  });

  test("publication never latches disk-confirmed when the final host read disposes the leaf", async () => {
    const fixture = makeFixture();
    let opens = 0;
    let closes = 0;
    let postOpenReads = 0;
    let sessionRef: NativeHarnessHistorySession | undefined;
    const probe = scopedHostProbe(fixture, () => {
      if (opens > 0) {
        postOpenReads += 1;
        if (postOpenReads === 3) sessionRef?.dispose();
      }
    });
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        opens += 1;
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (statOptions) => handle.stat(statOptions),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            closes += 1;
            await handle.close();
          },
        };
      },
    };
    const session = createNativeHarnessHistorySession({
      storageRoot: fixture.storageRoot,
      appendEntry: fixture.appendEntry,
      isOwnerCurrent: () => true,
      fileIo: io,
      now: () => 1_000,
    });
    sessionRef = session;
    const published = await session.publishTerminal(probe.context, {}, [fixture.candidate]);
    expect(published.publications[0]?.outcome).toBe("visible");
    expect(published.publications[0]?.durability).toBe("unknown");
    expect(published.publications[0]?.reasons[0]?.code).toBe("persistence-unavailable");
    expect(session.status().diskConfirmed).toBe(0);
    expect(fixture.state.appendCalls).toBe(1);
    expect(fixture.state.ensureCalls).toBe(1);
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });

  test("real native title-slot prefixes and a non-256 minimal title stay metadata-only", async () => {
    for (const diskShape of ["title-auto", "title-user", "title-minimal"] as const) {
      const fixture = makeFixture({ diskShape });
      const published = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
      expect(published.publications[0]?.outcome).toBe("disk-confirmed");
      expect(published.publications[0]?.durability).toBe("observed-only");
      expect(fixture.session.status().diskConfirmed).toBe(1);
      const listed = fixture.session.list(fixture.context(), { limit: 16 });
      expect(listed.state).toBe("complete");
      expect(listed.rows).toHaveLength(1);
      expect(listed.rows[0]?.entryId).toBe(published.publications[0]!.entryId!);
      const firstLine = readFileSync(fixture.state.sessionFile, "utf8").split("\n")[0]!;
      expect(JSON.parse(firstLine).type).toBe("title");
    }

    const real = makeFixture({ diskShape: "title-auto" });
    const realPublished = await real.session.publishTerminal(real.context(), {}, [real.candidate]);
    expect(realPublished.publications[0]?.outcome).toBe("disk-confirmed");
    const realFirstLine = readFileSync(real.state.sessionFile, "utf8").split("\n")[0]!;
    expect(Buffer.byteLength(`${realFirstLine}\n`, "utf8")).toBe(256);
    expect(realFirstLine).toContain('"source":"auto"');

    const unicode = makeFixture({ diskShape: "title-user" });
    const unicodePublished = await unicode.session.publishTerminal(unicode.context(), {}, [unicode.candidate]);
    expect(unicodePublished.publications[0]?.outcome).toBe("disk-confirmed");
    const unicodeFirstLine = readFileSync(unicode.state.sessionFile, "utf8").split("\n")[0]!;
    expect(Buffer.byteLength(`${unicodeFirstLine}\n`, "utf8")).toBe(256);
    expect(unicodeFirstLine).toContain("会话 ✓ タイトル");
    expect(unicodeFirstLine).toContain('"source":"user"');

    const minimal = makeFixture({ diskShape: "title-minimal" });
    const minimalPublished = await minimal.session.publishTerminal(minimal.context(), {}, [minimal.candidate]);
    expect(minimalPublished.publications[0]?.outcome).toBe("disk-confirmed");
    const minimalFirstLine = readFileSync(minimal.state.sessionFile, "utf8").split("\n")[0]!;
    expect(Buffer.byteLength(`${minimalFirstLine}\n`, "utf8")).toBeLessThan(256);
    expect(minimalFirstLine).toContain('"pad":"x"');
  });

  test("malformed, misplaced, duplicate or foreign session prefixes never become disk-confirmed", async () => {
    const shapes = [
      "title-malformed",
      "title-version",
      "title-source",
      "title-duplicate",
      "title-after-header",
      "title-missing-header",
      "arbitrary-prefix",
      "extra-session-header",
    ] as const;
    for (const diskShape of shapes) {
      const fixture = makeFixture({ diskShape });
      const result = await fixture.session.publishTerminal(fixture.context(), {}, [fixture.candidate]);
      expect(result.publications[0]?.outcome).toBe("visible");
      expect(result.publications[0]?.durability).toBe("unknown");
      expect(result.publications[0]?.reasons[0]?.code).toBe("disk-unavailable");
      expect(fixture.session.status().diskConfirmed).toBe(0);
      expect(fixture.state.appendCalls).toBe(1);
      expect(fixture.state.ensureCalls).toBe(1);
    }
  });
});
