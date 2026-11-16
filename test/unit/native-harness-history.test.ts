import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeRunEventsText,
  decodeRunHistoryText,
} from "../../vendor/harness2/index.ts";
import { StoreCorruptionError } from "../../vendor/harness2/upstream/src/store.ts";
import {
  NATIVE_HARNESS_HISTORY_LIMITS,
  NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
  decodeNativeHarnessHistoryLocator,
  inspectNativeHarnessHistory,
  isNativeHarnessHistoryLocator,
  type NativeHarnessHistoryDeclaredArtifact,
  type NativeHarnessHistoryInspection,
  type NativeHarnessHistoryLocator,
  type NativeHarnessHistoryLocatorDecodeReason,
} from "../../src/native-harness-history.ts";
import {
  nodeFileIo,
  type NativeFileHandle,
  type NativeFileIo,
} from "../../src/native-work.ts";

const HARNESS_NAME = "omp-harness-abc123";
const RUN_ID = "run-fixture-1";
const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = "2026-01-01T00:00:00.000Z";
const ENDED_AT = "2026-01-01T00:00:01.000Z";
const SECRET_TASK = "SECRET-TASK-TEXT-DO-NOT-LEAK";
const SECRET_STAGE = "SECRET-STAGE-RESULT-TEXT-DO-NOT-LEAK";
const SECRET_EVENT = "SECRET-EVENT-MESSAGE-DO-NOT-LEAK";
const SECRET_ARTIFACT = "SECRET-ARTIFACT-BYTES-DO-NOT-LEAK";
const ARTIFACT_CONTENT = `\uFEFF${SECRET_ARTIFACT}\nalpha\nbeta\n`;

type JsonRecord = Record<string, unknown>;

interface MutableRun extends JsonRecord {
  schemaVersion: number;
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  task: string;
  status: string;
  config: JsonRecord;
  baseHarness: JsonRecord;
  libraryEntries: unknown[];
  stages: Record<string, JsonRecord>;
  winner: string;
}

interface Fixture {
  readonly root: string;
  readonly harnessDir: string;
  readonly storeRelative: string;
  readonly runDir: string;
  readonly runPath: string;
  readonly backupPath: string;
  readonly eventsPath: string;
  readonly originalMainWorkspace: string;
  readonly mainWorkspace: string;
  readonly winnerCwd: string;
  readonly artifactPath: string;
  locatorText: string;
  run: MutableRun;
}

interface InspectOptions {
  readonly locator?: NativeHarnessHistoryLocator;
  readonly declaredArtifacts?: readonly NativeHarnessHistoryDeclaredArtifact[] | null;
  readonly signal?: AbortSignal;
  readonly fileIo?: NativeFileIo;
  readonly now?: () => number;
  readonly storageRoot?: string;
}

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function makeTempRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-native-history-"));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

function makeRun(fixture: Omit<Fixture, "locatorText" | "run">): MutableRun {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    revision: 3,
    createdAt: STARTED_AT,
    updatedAt: ENDED_AT,
    workspace: fixture.mainWorkspace,
    task: SECRET_TASK,
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
        cwd: fixture.winnerCwd,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        accountedCostUsd: 0.02,
        reservedCostUsd: 0.03,
        observedCostUsd: 0.01,
        artifactHash: "a".repeat(64),
        traceHash: "b".repeat(64),
        result: {
          text: SECRET_STAGE,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
          startedAt: STARTED_AT,
          endedAt: ENDED_AT,
          eventsPath: path.join(fixture.winnerCwd, "worker-events.jsonl"),
          status: "completed",
          usageEstimated: true,
        },
      },
    },
    winner: "baseline",
  };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function locatorText(fixture: Pick<Fixture, "originalMainWorkspace" | "storeRelative">): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
    version: 1,
    originSessionId: "session-fixture",
    workspacePath: fixture.originalMainWorkspace,
    source: {
      toolCallId: "tool-call-fixture",
      observationId: "observation-fixture",
      generation: 0,
    },
    runId: RUN_ID,
    storeRelativePath: fixture.storeRelative,
    inputManifestSha256: "1".repeat(64),
    definitionVersion: "definition-fixture-v1",
    backendSourceId: "2".repeat(64),
    configurationSha256: "3".repeat(64),
    evidence: {
      source: { entryId: "entry-source", sha256: "4".repeat(64) },
      report: { entryId: "entry-report", sha256: "5".repeat(64) },
    },
  });
}

function eventsText(): string {
  const events = [
    {
      schemaVersion: 1,
      runId: RUN_ID,
      timestamp: STARTED_AT,
      type: "stage_started",
      message: SECRET_EVENT,
      stage: "baseline",
    },
    {
      schemaVersion: 1,
      runId: RUN_ID,
      timestamp: ENDED_AT,
      type: "stage_completed",
      message: "baseline completed",
      stage: "baseline",
    },
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function writeRun(fixture: Fixture): Promise<void> {
  await writeFile(fixture.runPath, serialize(fixture.run), "utf8");
}

async function makeFixture(): Promise<Fixture> {
  const root = await makeTempRoot();
  const harnessDir = path.join(root, HARNESS_NAME);
  const storeRelative = `${HARNESS_NAME}/store/runs/${RUN_ID}`;
  const runDir = path.join(root, storeRelative);
  const runPath = path.join(runDir, "run.json");
  const backupPath = `${runPath}.bak`;
  const eventsPath = path.join(runDir, "events.jsonl");
  const originalMainWorkspace = path.join(root, "original-main-workspace");
  const mainWorkspace = path.join(harnessDir, "workspace");
  const winnerCwd = path.join(
    runDir,
    "stages",
    "baseline",
    `attempt-1-${ATTEMPT_ID}`,
    "workspace",
  );
  const artifactPath = path.join(winnerCwd, "result.txt");
  await mkdir(winnerCwd, { recursive: true });
  await mkdir(mainWorkspace, { recursive: true });
  await mkdir(originalMainWorkspace, { recursive: true });
  const base = {
    root,
    harnessDir,
    storeRelative,
    runDir,
    runPath,
    backupPath,
    eventsPath,
    originalMainWorkspace,
    mainWorkspace,
    winnerCwd,
    artifactPath,
  };
  const run = makeRun(base);
  const fixture: Fixture = {
    ...base,
    locatorText: locatorText(base),
    run,
  };
  await writeRun(fixture);
  await writeFile(
    fixture.backupPath,
    serialize({ ...run, revision: run.revision - 1, task: "BACKUP-SECRET-TASK" }),
    "utf8",
  );
  await writeFile(fixture.eventsPath, eventsText(), "utf8");
  await writeFile(fixture.artifactPath, ARTIFACT_CONTENT, "utf8");
  return fixture;
}

function decodedLocator(text: string): NativeHarnessHistoryLocator {
  const decoded = decodeNativeHarnessHistoryLocator(text);
  if (!decoded.ok) throw new Error(`fixture locator decode failed: ${decoded.reason}`);
  return decoded.locator;
}

async function inspectFixture(
  fixture: Fixture,
  options: InspectOptions = {},
): Promise<NativeHarnessHistoryInspection> {
  const locator = options.locator ?? decodedLocator(fixture.locatorText);
  return inspectNativeHarnessHistory({
    storageRoot: options.storageRoot ?? fixture.root,
    locator,
    declaredArtifacts: options.declaredArtifacts ?? null,
    signal: options.signal ?? new AbortController().signal,
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function declaredArtifact(
  relativePath = "result.txt",
  content: string = ARTIFACT_CONTENT,
): NativeHarnessHistoryDeclaredArtifact {
  return {
    relativePath,
    bytes: utf8Bytes(content),
    sha256: sha256(content),
    declaredAt: STARTED_AT,
    declaredByEntryId: "entry-report",
  };
}

async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = path.join(directory, name);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        entries.push(`${prefix}${name}/`);
        await visit(absolute, `${prefix}${name}/`);
      } else if (info.isFile()) {
        entries.push(`${prefix}${name}:${info.size}:${sha256(await readFile(absolute))}`);
      } else {
        entries.push(`${prefix}${name}:other`);
      }
    }
  };
  await visit(root, "");
  return entries;
}

function countingIo(): { io: NativeFileIo; opened: string[]; flags: number[] } {
  const opened: string[] = [];
  const flags: number[] = [];
  return {
    opened,
    flags,
    io: {
      ...nodeFileIo,
      open: async (target, openFlags) => {
        opened.push(target);
        flags.push(openFlags);
        return nodeFileIo.open(target, openFlags);
      },
    },
  };
}

function expectFailure(text: string, reason: NativeHarnessHistoryLocatorDecodeReason): void {
  const decoded = decodeNativeHarnessHistoryLocator(text);
  expect(decoded.ok).toBe(false);
  if (!decoded.ok) expect(decoded.reason).toBe(reason);
}

describe("bounded native history locator", () => {
  test("accepts one canonical version-1 locator and rejects unknown or oversized fields", async () => {
    const fixture = await makeFixture();
    const decoded = decodeNativeHarnessHistoryLocator(fixture.locatorText);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(decoded.bytes).toBeLessThanOrEqual(NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes);
    expect(decoded.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(isNativeHarnessHistoryLocator(decoded.locator)).toBe(true);
    expect(Object.isFrozen(decoded.locator)).toBe(true);
    expect(decoded.locator.runId).toBe(RUN_ID);
    expect(decoded.locator.storeRelativePath).toBe(fixture.storeRelative);

    const unknownField = JSON.stringify({
      ...JSON.parse(fixture.locatorText),
      extra: "not-known",
    });
    expectFailure(unknownField, "locator-shape");

    const wrongPath = JSON.stringify({
      ...JSON.parse(fixture.locatorText),
      storeRelativePath: `${HARNESS_NAME}/store/runs/other-run`,
    });
    expectFailure(wrongPath, "locator-field");

    const noncanonicalWorkspace = JSON.stringify({
      ...JSON.parse(fixture.locatorText),
      workspacePath: `${fixture.root}/a/../b`,
    });
    expectFailure(noncanonicalWorkspace, "locator-field");

    const oversized = JSON.stringify({
      ...JSON.parse(fixture.locatorText),
      originSessionId: "x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes),
    });
    expectFailure(oversized, "locator-oversized");
  });
});

describe("readonly history projection", () => {
  test("observes a valid record, events and one declared BOM artifact without leaking text or writing", async () => {
    const fixture = await makeFixture();
    const before = await snapshotTree(fixture.root);
    let tick = 1_000;
    const result = await inspectFixture(fixture, {
      declaredArtifacts: [declaredArtifact()],
      now: () => {
        tick += 1;
        return tick;
      },
    });
    const after = await snapshotTree(fixture.root);

    expect(result.state).toBe("observed");
    expect(result.recorded.state).toBe("observed");
    expect(result.recorded.runId).toBe(RUN_ID);
    expect(result.recorded.status).toBe("completed");
    expect(result.recorded.revision).toBe(3);
    expect(result.recorded.stages).toHaveLength(1);
    expect(result.recorded.stages[0]?.id).toBe("baseline");
    expect(result.recorded.stages[0]?.attempt).toBe(1);
    expect(result.recorded.events.state).toBe("observed");
    expect(result.recorded.events.rows).toBe(2);
    expect(result.recorded.runFile?.bytes).toBeGreaterThan(0);
    expect(result.recorded.runFile?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.recorded.runFile?.observedAt).toBeGreaterThan(1_000);

    expect(fixture.originalMainWorkspace).not.toBe(fixture.mainWorkspace);
    expect(result.originCompatibility.workspace.declared).toBe(fixture.originalMainWorkspace);
    expect(result.originCompatibility.workspace.recorded).toBeNull();
    expect(result.originCompatibility.workspace.result).toBe("unavailable");
    expect(result.originCompatibility.workspaceLayout).toBe("match");
    expect(result.originCompatibility.currentAdoption).toBe(false);
    expect(result.originCompatibility.definitionVersion.result).toBe("unavailable");

    expect(result.accounting.costTotal.usd).toBeNull();
    expect(result.accounting.costTotal.source).toBe("unknown");
    expect(result.accounting.outerLifetime).toBe("unknown");
    expect(result.accounting.originalDeadline).toBe("unknown");
    expect(result.accounting.stages[0]?.observed.usd).toBe(0.01);
    expect(result.accounting.stages[0]?.reserved.usd).toBe(0.03);
    expect(result.accounting.stages[0]?.accounted.usd).toBe(0.02);
    expect(result.accounting.stages[0]?.usageEstimated).toBe(true);

    expect(result.processObservation.inspected).toBe(false);
    expect(result.processObservation.controller.state).toBe("unknown");
    expect(result.processObservation.workers.coverage).toBe("unknown");
    expect(result.eligibility).toEqual({
      readOnly: true,
      authorityRestored: false,
      resumeAvailable: false,
      liveAttach: "unsupported",
      recoverableFormat: false,
      missingForResume: [
        "R2 pre-effect provenance and durable budget/deadline association",
        "verified coverage that every original controller and worker stopped",
        "a current explicit user resume intent",
        "a durable accounting owner for unknown allocations",
      ],
      limitations: [
        "This inspection cannot resume, cancel, apply, accept or attach to a run.",
        "The R1a locator is factual history, not signed provenance or an execution capability.",
        "Mandatory R2 and R3 remain open.",
      ],
    });

    expect(result.artifactIntegrity.state).toBe("declared-files-matched");
    expect(result.artifactIntegrity.coverage).toBe("declared-files-only");
    expect(result.artifactIntegrity.mode).toBe("not-checked");
    expect(result.artifactIntegrity.tree).toBe("not-checked");
    expect(result.artifactIntegrity.traces).toBe("not-checked");
    expect(result.artifactIntegrity.provenance).toBe("not-restored");
    expect(result.artifactIntegrity.results[0]?.status).toBe("match");
    expect(result.artifactIntegrity.results[0]?.observedBytes).toBe(utf8Bytes(ARTIFACT_CONTENT));
    expect(result.artifactIntegrity.results[0]?.observedSha256).toBe(sha256(ARTIFACT_CONTENT));
    expect(result.artifactIntegrity.results[0]?.hashMatch).toBe(true);

    expect(result.query.observedBytes).toBe(
      (result.recorded.runFile?.bytes ?? 0)
      + (result.recorded.events.file?.bytes ?? 0)
      + (result.artifactIntegrity.results[0]?.observedBytes ?? 0),
    );
    expect(result.query.observedBytes).toBeLessThanOrEqual(NATIVE_HARNESS_HISTORY_LIMITS.queryBytes);
    expect(result.query.readBudget.failedReads).toBe(0);
    expect(result.query.readBudget.outcome).toBe("within-budget");
    expect(result.query.artifactReadBudget.observedBytes).toBe(
      result.artifactIntegrity.results[0]?.observedBytes ?? 0,
    );
    expect(result.artifactIntegrity.complete).toBe(true);
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(NATIVE_HARNESS_HISTORY_LIMITS.resultBytes);
    expect(before).toEqual(after);
    const serialized = JSON.stringify(result);
    for (const secret of [
      SECRET_TASK,
      SECRET_STAGE,
      SECRET_EVENT,
      SECRET_ARTIFACT,
      "BACKUP-SECRET-TASK",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("missing, corrupt or mismatched primary stays unavailable and never falls back to a backup", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.runPath, "{not-json", "utf8");
    const before = await snapshotTree(fixture.root);
    const corrupt = await inspectFixture(fixture);
    const afterCorrupt = await snapshotTree(fixture.root);
    expect(corrupt.state).toBe("unavailable");
    expect(corrupt.recorded.state).toBe("unavailable");
    expect(corrupt.reasons.map((reason) => reason.code)).toContain("run-decode-failed");
    expect(corrupt.artifactIntegrity.state).toBe("unavailable");
    expect(before).toEqual(afterCorrupt);

    await rm(fixture.runPath);
    const missing = await inspectFixture(fixture);
    expect(missing.state).toBe("unavailable");
    expect(missing.reasons.map((reason) => reason.code)).toContain("run-missing");
    expect(missing.recorded.runId).toBe(RUN_ID);
    expect(missing.query.observedBytes).toBe(0);
    expect(missing.query.readBudget.chargedBytes).toBeGreaterThanOrEqual(
      NATIVE_HARNESS_HISTORY_LIMITS.runBytes,
    );
    expect(missing.query.readBudget.failedReads).toBe(1);
    expect(missing.query.readBudget.outcome).toBe("unknown-usage");

    await writeFile(fixture.runPath, serialize({ ...fixture.run, id: "run-other" }), "utf8");
    const mismatched = await inspectFixture(fixture);
    expect(mismatched.state).toBe("unavailable");
    expect(mismatched.reasons.map((reason) => reason.code)).toContain("run-decode-failed");
    expect(await readFile(fixture.backupPath, "utf8")).toContain("BACKUP-SECRET-TASK");

    await writeFile(fixture.runPath, "x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.runBytes + 1), "utf8");
    const oversized = await inspectFixture(fixture);
    expect(oversized.state).toBe("unavailable");
    expect(oversized.reasons.map((reason) => reason.code)).toContain("run-profile-unavailable");
    expect(oversized.artifactIntegrity.state).toBe("unavailable");
  });

  test("missing, empty, torn and oversized events stay distinct from a complete empty history", async () => {
    const fixture = await makeFixture();
    await rm(fixture.eventsPath);
    const missing = await inspectFixture(fixture);
    expect(missing.state).toBe("partial");
    expect(missing.recorded.state).toBe("observed");
    expect(missing.recorded.events.state).toBe("unavailable");
    expect(missing.reasons.map((reason) => reason.code)).toContain("events-missing");

    await writeFile(fixture.eventsPath, "", "utf8");
    const empty = await inspectFixture(fixture);
    expect(empty.state).toBe("observed");
    expect(empty.recorded.events.state).toBe("empty");
    expect(empty.recorded.events.rows).toBe(0);
    expect(empty.recorded.events.file?.bytes).toBe(0);

    await writeFile(fixture.eventsPath, eventsText().slice(0, -1), "utf8");
    const torn = await inspectFixture(fixture);
    expect(torn.state).toBe("partial");
    expect(torn.recorded.events.state).toBe("unavailable");
    expect(torn.reasons.map((reason) => reason.code)).toContain("events-decode-failed");

    await writeFile(fixture.eventsPath, "x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes + 1), "utf8");
    const oversized = await inspectFixture(fixture);
    expect(oversized.state).toBe("partial");
    expect(oversized.recorded.events.state).toBe("unavailable");
    expect(oversized.reasons.map((reason) => reason.code)).toContain("events-profile-unavailable");
  });

  test("keeps the original main workspace distinct from the copied private harness workspace", async () => {
    const fixture = await makeFixture();
    expect(fixture.originalMainWorkspace).not.toBe(fixture.mainWorkspace);
    expect(fixture.run.workspace).toBe(fixture.mainWorkspace);
    const result = await inspectFixture(fixture);
    expect(result.state).toBe("observed");
    expect(result.originCompatibility.workspace.declared).toBe(fixture.originalMainWorkspace);
    expect(result.originCompatibility.workspace.recorded).toBeNull();
    expect(result.originCompatibility.workspace.result).toBe("unavailable");
    expect(result.originCompatibility.workspaceLayout).toBe("match");
  });

  test("withholds an unbounded recorded workspace and keeps the final wire bounded", async () => {
    const fixture = await makeFixture();
    const marker = "UNBOUNDED-WORKSPACE-MARKER";
    fixture.run.workspace = `${marker}${"x".repeat(100_000)}`;
    await writeRun(fixture);
    const result = await inspectFixture(fixture);
    expect(result.originCompatibility.workspace.recorded).toBeNull();
    expect(result.originCompatibility.workspace.result).toBe("unavailable");
    expect(result.originCompatibility.workspaceLayout).toBe("mismatch");
    expect(utf8Bytes(JSON.stringify(result))).toBeLessThanOrEqual(
      NATIVE_HARNESS_HISTORY_LIMITS.resultBytes,
    );
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  test("withholds an unvalidated stage.endedAt object and its nested fields", async () => {
    const fixture = await makeFixture();
    const baseline = fixture.run.stages.baseline;
    if (baseline === undefined) throw new Error("fixture baseline missing");
    baseline.endedAt = {
      task: "SECRET-ENDED-AT-TASK",
      auth: "SECRET-ENDED-AT-AUTH",
    };
    await writeRun(fixture);
    const result = await inspectFixture(fixture);
    expect(result.recorded.stages[0]?.endedAt).toBeNull();
    expect(result.reasons.map((reason) => reason.code)).toContain("stage-ended-at-withheld");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-ENDED-AT-TASK");
    expect(serialized).not.toContain("SECRET-ENDED-AT-AUTH");
    expect(utf8Bytes(serialized)).toBeLessThanOrEqual(NATIVE_HARNESS_HISTORY_LIMITS.resultBytes);
  });

  test("missing stage cost fields remain null/unknown and an unknown top-level field is not leaked", async () => {
    const fixture = await makeFixture();
    const baseline = fixture.run.stages.baseline;
    if (baseline === undefined) throw new Error("fixture baseline missing");
    delete baseline.accountedCostUsd;
    delete baseline.reservedCostUsd;
    delete baseline.observedCostUsd;
    const result = (baseline.result as JsonRecord).usageEstimated;
    expect(result).toBe(true);
    delete (baseline.result as JsonRecord).usageEstimated;
    fixture.run.vendorExtra = { hidden: "SECRET-VENDOR-EXTRA" };
    await writeRun(fixture);

    const inspection = await inspectFixture(fixture);
    const stage = inspection.accounting.stages[0];
    expect(stage?.observed).toEqual({ usd: null, source: "unknown" });
    expect(stage?.reserved).toEqual({ usd: null, source: "unknown" });
    expect(stage?.accounted).toEqual({ usd: null, source: "unknown" });
    expect(stage?.resultKnown).toBe(true);
    expect(stage?.usageEstimated).toBeNull();
    expect(inspection.accounting.costTotal.usd).toBeNull();
    expect(JSON.stringify(inspection)).not.toContain("SECRET-VENDOR-EXTRA");
  });
});

describe("bounded vendor history decoders", () => {
  test("accepts valid text, rejects torn/mismatched/BOM corruption and maps profile limits to RangeError", async () => {
    const fixture = await makeFixture();
    const record = decodeRunHistoryText(JSON.stringify(fixture.run), RUN_ID);
    expect(record.id).toBe(RUN_ID);
    expect(decodeRunEventsText(eventsText(), RUN_ID)).toHaveLength(2);
    expect(decodeRunEventsText("", RUN_ID)).toEqual([]);

    expect(() => decodeRunHistoryText("\uFEFF" + JSON.stringify(fixture.run), RUN_ID))
      .toThrow(StoreCorruptionError);
    expect(() => decodeRunHistoryText(JSON.stringify(fixture.run), "run-other"))
      .toThrow(StoreCorruptionError);
    expect(() => decodeRunEventsText(eventsText().slice(0, -1), RUN_ID))
      .toThrow(StoreCorruptionError);
    expect(() => decodeRunEventsText(eventsText(), "run-other"))
      .toThrow(StoreCorruptionError);

    let runLimitError: unknown = null;
    try {
      decodeRunHistoryText("x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.runBytes + 1), RUN_ID);
    } catch (error) {
      runLimitError = error;
    }
    expect(runLimitError).toBeInstanceOf(RangeError);
    expect(runLimitError).not.toBeInstanceOf(StoreCorruptionError);

    let eventsLimitError: unknown = null;
    try {
      decodeRunEventsText("x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes + 1), RUN_ID);
    } catch (error) {
      eventsLimitError = error;
    }
    expect(eventsLimitError).toBeInstanceOf(RangeError);
    expect(eventsLimitError).not.toBeInstanceOf(StoreCorruptionError);

    const rowLine = JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      timestamp: STARTED_AT,
      type: "x",
      message: "",
    });
    const manyRows = `${Array.from({ length: 4097 }, () => rowLine).join("\n")}\n`;
    expect(() => decodeRunEventsText(manyRows, RUN_ID)).toThrow(RangeError);
  });
});

describe("declared artifact and winner boundaries", () => {
  test("distinguishes missing, changed, non-text, oversize and invalid declarations without extra reads", async () => {
    const fixture = await makeFixture();

    await rm(fixture.artifactPath);
    const missing = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(missing.artifactIntegrity.state).toBe("unavailable");
    expect(missing.artifactIntegrity.results[0]?.status).toBe("missing");

    await writeFile(fixture.artifactPath, "changed content\n", "utf8");
    const changed = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(changed.artifactIntegrity.results[0]?.status).toBe("content-mismatch");
    expect(changed.artifactIntegrity.results[0]?.bytesMatch).toBe(false);
    expect(changed.artifactIntegrity.results[0]?.hashMatch).toBe(false);
    expect(changed.state).toBe("partial");

    await writeFile(fixture.artifactPath, new Uint8Array([0x66, 0x00, 0x66]));
    const nonText = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(nonText.artifactIntegrity.results[0]?.status).toBe("non-text");

    await writeFile(fixture.artifactPath, Buffer.alloc(NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes + 1, 0x61));
    const oversize = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(oversize.artifactIntegrity.results[0]?.status).toBe("oversize");

    const counting = countingIo();
    const declarationOversize = await inspectFixture(fixture, {
      declaredArtifacts: [{
        relativePath: "result.txt",
        bytes: NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes + 1,
        sha256: "a".repeat(64),
      }],
      fileIo: counting.io,
    });
    expect(declarationOversize.artifactIntegrity.manifest).toBe("invalid");
    expect(declarationOversize.reasons.map((reason) => reason.code))
      .toContain("artifact-declaration-oversize");
    expect(counting.opened.some((target) => target.endsWith("result.txt"))).toBe(false);

    const totalCounting = countingIo();
    const totalDeclarations = Array.from({ length: 5 }, (_, index) => ({
      relativePath: `artifact-${index}.txt`,
      bytes: NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes,
      sha256: "b".repeat(64),
    }));
    const total = await inspectFixture(fixture, {
      declaredArtifacts: totalDeclarations,
      fileIo: totalCounting.io,
    });
    expect(total.artifactIntegrity.manifest).toBe("invalid");
    expect(total.reasons.map((reason) => reason.code)).toContain("artifact-declaration-total");
    expect(totalCounting.opened.some((target) => target.endsWith(".txt"))).toBe(false);

    const emptyCounting = countingIo();
    const empty = await inspectFixture(fixture, {
      declaredArtifacts: [],
      fileIo: emptyCounting.io,
    });
    expect(empty.artifactIntegrity.manifest).toBe("empty");
    expect(empty.artifactIntegrity.state).toBe("unavailable");
    expect(empty.reasons.map((reason) => reason.code)).toContain("artifact-manifest-empty");

    const traversal = await inspectFixture(fixture, {
      declaredArtifacts: [{ relativePath: "../escape.txt", bytes: 1, sha256: "c".repeat(64) }],
      fileIo: countingIo().io,
    });
    expect(traversal.artifactIntegrity.manifest).toBe("invalid");
    expect(traversal.reasons.map((reason) => reason.code)).toContain("artifact-declaration-invalid-path");
  });

  test("enforces the independent artifact-read allowance and truthful budget metadata", async () => {
    const fixture = await makeFixture();
    const declarations: NativeHarnessHistoryDeclaredArtifact[] = [];
    for (let index = 0; index < NATIVE_HARNESS_HISTORY_LIMITS.maxDeclaredArtifacts; index += 1) {
      await writeFile(
        path.join(fixture.winnerCwd, `large-${index}.txt`),
        "x".repeat(NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes),
        "utf8",
      );
      declarations.push({ relativePath: `large-${index}.txt`, bytes: 1, sha256: sha256("x") });
    }
    const result = await inspectFixture(fixture, { declaredArtifacts: declarations });
    const statuses = result.artifactIntegrity.results.map((entry) => entry.status);
    expect(statuses).toContain("artifact-budget-exhausted");
    expect(statuses).not.toContain("query-budget-exhausted");
    expect(result.query.artifactReadBudget.limitBytes).toBe(
      NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes,
    );
    expect(result.query.artifactReadBudget.chargedBytes).toBeLessThanOrEqual(
      NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes,
    );
    expect(result.query.artifactReadBudget.observedBytes).toBeLessThanOrEqual(
      NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes,
    );
    expect(result.query.artifactReadBudget.failedReads).toBe(0);
    expect(result.query.observedBytes).toBeLessThanOrEqual(NATIVE_HARNESS_HISTORY_LIMITS.queryBytes);
    expect(result.artifactIntegrity.state).toBe("partial");
    expect(result.artifactIntegrity.complete).toBe(true);
    expect(result.state).toBe("partial");
    expect(result.reasons.map((reason) => reason.code)).toContain("artifact-budget-exhausted");
  });

  test("does not mark a partial artifact prefix matched after an abort", async () => {
    const fixture = await makeFixture();
    const secondContent = "second\n";
    await writeFile(path.join(fixture.winnerCwd, "second.txt"), secondContent, "utf8");
    const controller = new AbortController();
    let abortedOnClose = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags): Promise<NativeFileHandle> => {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== fixture.artifactPath || abortedOnClose) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            abortedOnClose = true;
            controller.abort();
          },
        };
      },
    };
    const result = await inspectFixture(fixture, {
      declaredArtifacts: [
        declaredArtifact(),
        { relativePath: "second.txt", bytes: utf8Bytes(secondContent), sha256: sha256(secondContent) },
      ],
      fileIo: io,
      signal: controller.signal,
    });
    expect(abortedOnClose).toBe(true);
    expect(result.state).toBe("aborted");
    expect(result.artifactIntegrity.declaredCount).toBe(2);
    expect(result.artifactIntegrity.observedCount).toBe(1);
    expect(result.artifactIntegrity.matchedCount).toBe(1);
    expect(result.artifactIntegrity.complete).toBe(false);
    expect(result.artifactIntegrity.state).toBe("partial");
  });

  test("refuses artifact reads for a mismatched winner, attempt or selected run", async () => {
    const fixture = await makeFixture();
    const baseline = fixture.run.stages.baseline;
    if (baseline === undefined) throw new Error("fixture baseline missing");
    baseline.cwd = fixture.mainWorkspace;
    await writeRun(fixture);
    const counting = countingIo();
    const wrongCwd = await inspectFixture(fixture, {
      declaredArtifacts: [declaredArtifact()],
      fileIo: counting.io,
    });
    expect(wrongCwd.artifactIntegrity.state).toBe("unavailable");
    expect(wrongCwd.reasons.map((reason) => reason.code)).toContain("winner-workspace-invalid");
    expect(counting.opened.some((target) => target.endsWith("result.txt"))).toBe(false);

    baseline.cwd = fixture.winnerCwd;
    baseline.attempt = 2;
    await writeRun(fixture);
    const wrongAttempt = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(wrongAttempt.artifactIntegrity.state).toBe("unavailable");
    expect(wrongAttempt.reasons.map((reason) => reason.code)).toContain("winner-workspace-invalid");

    baseline.attempt = 1;
    fixture.run.id = "run-other";
    await writeRun(fixture);
    const wrongRun = await inspectFixture(fixture, { declaredArtifacts: [declaredArtifact()] });
    expect(wrongRun.state).toBe("unavailable");
    expect(wrongRun.reasons.map((reason) => reason.code)).toContain("run-decode-failed");
  });

  test("rejects a symlinked store component, a configured root alias and artifact traversal", async () => {
    const fixture = await makeFixture();
    const movedStore = path.join(fixture.root, "moved-store");
    await rename(path.join(fixture.harnessDir, "store"), movedStore);
    await symlink(movedStore, path.join(fixture.harnessDir, "store"));
    const symlinked = await inspectFixture(fixture);
    expect(symlinked.state).toBe("unavailable");
    expect(symlinked.reasons.map((reason) => reason.code)).toContain("run-unsafe-path");

    const aliasFixture = await makeFixture();
    const alias = path.join(aliasFixture.root, "root-alias");
    await symlink(aliasFixture.root, alias);
    const counting = countingIo();
    const aliasResult = await inspectFixture(aliasFixture, {
      storageRoot: alias,
      fileIo: counting.io,
    });
    expect(aliasResult.state).toBe("unavailable");
    expect(aliasResult.reasons.map((reason) => reason.code)).toContain("storage-root-alias");
    expect(counting.opened).toHaveLength(0);

    const traversal = await inspectFixture(aliasFixture, {
      declaredArtifacts: [{ relativePath: "../escape.txt", bytes: 1, sha256: "d".repeat(64) }],
    });
    expect(traversal.artifactIntegrity.manifest).toBe("invalid");
  });
});

describe("file IO seams and abort draining", () => {
  test("adds O_NONBLOCK to every read open and detects a concurrent run replacement", async () => {
    const fixture = await makeFixture();
    const counting = countingIo();
    const normal = await inspectFixture(fixture, {
      declaredArtifacts: [declaredArtifact()],
      fileIo: counting.io,
    });
    expect(normal.state).toBe("observed");
    expect(counting.opened.length).toBeGreaterThan(0);
    for (const flags of counting.flags) {
      expect((flags & (constants.O_NONBLOCK ?? 0)) !== 0).toBe(true);
      expect((flags & nodeFileIo.O_NOFOLLOW) !== 0).toBe(true);
    }

    const replacementFixture = await makeFixture();
    let replaced = false;
    const replacementIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags) => {
        const handle = await nodeFileIo.open(target, flags);
        if (!replaced && target === replacementFixture.runPath) {
          replaced = true;
          const temporary = `${replacementFixture.runPath}.replacement`;
          await writeFile(temporary, serialize({ ...replacementFixture.run, revision: 99 }), "utf8");
          await rename(temporary, replacementFixture.runPath);
        }
        return handle;
      },
    };
    const replacedResult = await inspectFixture(replacementFixture, { fileIo: replacementIo });
    expect(replaced).toBe(true);
    expect(replacedResult.state).toBe("unavailable");
    expect(replacedResult.reasons.map((reason) => reason.code)).toContain("run-changed");
    expect(replacedResult.query.observedBytes).toBe(0);
    expect(replacedResult.query.readBudget.failedReads).toBe(1);
    expect(replacedResult.query.readBudget.chargedBytes).toBeGreaterThanOrEqual(
      NATIVE_HARNESS_HISTORY_LIMITS.runBytes,
    );
    expect(replacedResult.query.readBudget.outcome).toBe("unknown-usage");
  });

  test("a root replacement during events observation becomes uncertainty, not success", async () => {
    const fixture = await makeFixture();
    const movedRoot = `${fixture.root}-moved`;
    tempRoots.push(movedRoot);
    let replaced = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      lstat: async (target, options) => {
        if (!replaced && target === fixture.eventsPath) {
          replaced = true;
          const before = await nodeFileIo.lstat(target, options);
          await rename(fixture.root, movedRoot);
          await mkdir(fixture.root);
          return before;
        }
        return nodeFileIo.lstat(target, options);
      },
    };
    const result = await inspectFixture(fixture, { fileIo: io });
    expect(replaced).toBe(true);
    expect(result.state).toBe("uncertain");
    expect(result.reasons.map((reason) => reason.code)).toContain("storage-root-changed");
  });

  test("binds rootOf to the pinned root so a replaced symlink cannot open outside files", async () => {
    const fixture = await makeFixture();
    const outside = path.join(
      path.dirname(fixture.root),
      `${path.basename(fixture.root)}-outside`,
    );
    const moved = path.join(
      path.dirname(fixture.root),
      `${path.basename(fixture.root)}-moved`,
    );
    tempRoots.push(outside, moved);
    const outsideRunDir = path.join(outside, HARNESS_NAME, "store", "runs", RUN_ID);
    await mkdir(outsideRunDir, { recursive: true });
    await writeFile(path.join(outsideRunDir, "run.json"), serialize(fixture.run), "utf8");
    await writeFile(path.join(outsideRunDir, "events.jsonl"), eventsText(), "utf8");

    let realpathCalls = 0;
    let replaced = false;
    const externalOpens: string[] = [];
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        realpathCalls += 1;
        if (!replaced && target === fixture.root && realpathCalls >= 2) {
          replaced = true;
          await rename(fixture.root, moved);
          await symlink(outside, fixture.root);
        }
        return nodeFileIo.realpath(target);
      },
      open: async (target, flags) => {
        if (target.startsWith(`${outside}${path.sep}`)) externalOpens.push(target);
        return nodeFileIo.open(target, flags);
      },
    };
    const result = await inspectFixture(fixture, { fileIo: io });
    expect(replaced).toBe(true);
    expect(externalOpens).toHaveLength(0);
    expect(result.state).toBe("unavailable");
    expect(result.reasons.map((reason) => reason.code)).toContain("run-changed");
  });

  test("aborts when the signal changes during the post-run root recheck before events", async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    let runClosed = false;
    let abortedDuringRootCheck = false;
    const eventsOpens: string[] = [];
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags): Promise<NativeFileHandle> => {
        if (target === fixture.eventsPath) eventsOpens.push(target);
        const handle = await nodeFileIo.open(target, flags);
        if (target !== fixture.runPath) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            runClosed = true;
          },
        };
      },
      realpath: async (target) => {
        if (runClosed && !abortedDuringRootCheck && target === fixture.root) {
          abortedDuringRootCheck = true;
          controller.abort();
        }
        return nodeFileIo.realpath(target);
      },
    };
    const result = await inspectFixture(fixture, { fileIo: io, signal: controller.signal });
    expect(runClosed).toBe(true);
    expect(abortedDuringRootCheck).toBe(true);
    expect(eventsOpens).toHaveLength(0);
    expect(result.state).toBe("aborted");
    expect(result.reasons.map((reason) => reason.code)).toContain("query-aborted");
  });

  test("an abort during a held read drains and closes the opened file before returning aborted", async () => {
    const fixture = await makeFixture();
    let releaseRead: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let delayed = false;
    let closed = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags): Promise<NativeFileHandle> => {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== fixture.runPath) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (!delayed) {
              delayed = true;
              readStarted();
              await gate;
            }
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    };
    const controller = new AbortController();
    const pending = inspectFixture(fixture, { fileIo: io, signal: controller.signal });
    await Promise.race([
      started,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("the held read did not start")), 2_000);
      }),
    ]);
    expect(closed).toBe(false);
    controller.abort();
    releaseRead();
    const result = await pending;
    expect(result.state).toBe("aborted");
    expect(result.reasons.map((reason) => reason.code)).toContain("query-aborted");
    expect(closed).toBe(true);
  });
});
