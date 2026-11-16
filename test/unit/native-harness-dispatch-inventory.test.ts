import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
  NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES,
  NativeHarnessDispatchInventoryError,
  type NativeHarnessDispatchCleanupReceipt,
  type NativeHarnessDispatchInventory,
  type NativeHarnessDispatchInventoryV1,
  type NativeHarnessDispatchInventoryV2,
  type NativeHarnessDispatchInventoryErrorCode,
  type NativeHarnessDispatchInventoryHandle,
  type NativeHarnessDispatchIntent,
  type NativeHarnessDispatchLaunch,
  type NativeHarnessDispatchProcess,
  type NativeHarnessDispatchPrompt,
  type NativeHarnessDispatchRow,
  type NativeHarnessDispatchTerminal,
  createNativeHarnessDispatchInventory,
  openNativeHarnessDispatchInventory,
} from "../../src/native-harness-dispatch-inventory.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import type {
  RunRecord,
  RunRecoveryOrigin,
  RunRecoverySeed,
  WorkerLifecycleCleanupObservedEvent,
} from "../../vendor/harness2/upstream/src/types.ts";
import { nodeFileIo, type NativeFileIo } from "../../src/native-work.ts";

const RUN_ID = "run-dispatch-inventory-1";
const ADMITTED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);
const DEADLINE_AT = ADMITTED_AT + 300_000;
const CREATED_AT = new Date(ADMITTED_AT + 1_000).toISOString();
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

interface TestRun {
  readonly root: string;
  readonly store: RunStore;
  readonly runDir: string;
  readonly record: RunRecord;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function seed(): RunRecoverySeed {
  return {
    schema: "omp-agent.native-harness-recovery-seed.v1",
    profile: "native-auto-scoped-files.v1",
    accountingOwnerId: OWNER_ID,
    admissionId: ADMISSION_ID,
    accountingOwnerRevision: 0,
    sourceAssociationSha256: HASH_A,
    sourceDescriptorSha256: HASH_B,
    inputManifestSha256: HASH_C,
    admittedAt: ADMITTED_AT,
    deadlineAt: DEADLINE_AT,
    allocatedCostUsd: 0.5,
  };
}

function makeRecord(configOverrides: Partial<RunRecord["config"]> = {}): RunRecord {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    workspace: "/fixture/workspace",
    task: "fixture task",
    config: {
      mode: "product",
      strategy: "auto",
      model: "fixture/model",
      improverModel: "fixture/model",
      maxCostUsd: 0.5,
      maxDurationMs: 60_000,
      stageTimeoutMs: 10_000,
      domain: "generic",
      ompCommand: "/bin/false",
      ...configOverrides,
    },
    status: "queued",
    baseHarness: {
      schemaVersion: 1,
      id: "fixture-harness",
      promptAppend: "fixture prompt",
      toolGuidance: "fixture guidance",
      rationale: "fixture rationale",
      skills: [],
    },
    libraryEntries: [],
    stages: {},
  };
}

async function makeRun(
  configOverrides: Partial<RunRecord["config"]> = {},
): Promise<TestRun> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-dispatch-inventory-"));
  const root = await realpath(created);
  tempRoots.push(root);
  const store = new RunStore(path.join(root, "runs"));
  const record = await store.createWithRecoveryOrigin(
    makeRecord(configOverrides),
    JSON.stringify(seed()),
  );
  return { root, store, runDir: store.runDir(RUN_ID), record };
}

async function makePlainRun(): Promise<TestRun> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-dispatch-inventory-plain-"));
  const root = await realpath(created);
  tempRoots.push(root);
  const store = new RunStore(path.join(root, "runs"));
  const record = await store.create(makeRecord());
  return { root, store, runDir: store.runDir(RUN_ID), record };
}

function inventoryPath(run: TestRun): string {
  return path.join(run.runDir, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE);
}

function runPath(run: TestRun): string {
  return path.join(run.runDir, "run.json");
}

async function readInventoryRaw(run: TestRun): Promise<string> {
  return readFile(inventoryPath(run), "utf8");
}

async function readInventoryJson(run: TestRun): Promise<{
  schema: string;
  revision: number;
  dispatches: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readInventoryRaw(run)) as {
    schema: string;
    revision: number;
    dispatches: Array<Record<string, unknown>>;
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`non-Error rejection: ${String(error)}`);
  }
  throw new Error("expected the operation to reject");
}

async function expectCode(
  promise: Promise<unknown>,
  code: NativeHarnessDispatchInventoryErrorCode,
): Promise<void> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(NativeHarnessDispatchInventoryError);
  expect((error as NativeHarnessDispatchInventoryError).code).toBe(code);
}

async function expectThrownCode(
  call: () => unknown,
  code: NativeHarnessDispatchInventoryErrorCode,
): Promise<void> {
  let error: Error;
  try {
    await call();
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  // eslint-disable-next-line no-unreachable
  expect(error!).toBeInstanceOf(NativeHarnessDispatchInventoryError);
  expect((error! as NativeHarnessDispatchInventoryError).code).toBe(code);
}

function expectV2(inventory: NativeHarnessDispatchInventory): NativeHarnessDispatchInventoryV2 {
  expect(inventory.schema).toBe(NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2);
  return inventory as NativeHarnessDispatchInventoryV2;
}

function expectV1(inventory: NativeHarnessDispatchInventory): NativeHarnessDispatchInventoryV1 {
  expect(inventory.schema).toBe(NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA);
  return inventory as NativeHarnessDispatchInventoryV1;
}

function noop(): void {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function recordIdentity(record: RunRecord): string {
  return createHash("sha256")
    .update(canonical({
      id: record.id,
      createdAt: record.createdAt,
      workspace: record.workspace,
      task: record.task,
      config: record.config,
      baseHarness: record.baseHarness,
      libraryEntries: record.libraryEntries,
    }), "utf8")
    .digest("hex");
}

function baseIntent(run: TestRun, ordinal: number): NativeHarnessDispatchIntent {
  const attemptDir = path.join(run.runDir, "stages", "baseline", `attempt-${ordinal}`);
  return {
    ordinal,
    nonce: uuid(ordinal),
    stage: "baseline",
    attempt: ordinal,
    runRevision: ordinal,
    cwd: path.join(attemptDir, "workspace"),
    artifactDir: path.join(attemptDir, "artifacts"),
    intentSha256: HASH_B,
    snapshotSha256: HASH_A,
    innerDeadlineAt: ADMITTED_AT + 10_000 + ordinal,
    requestTimeoutMs: 8_000,
    stageAllocatedCostUsd: 0.1,
  };
}

function processFact(): NativeHarnessDispatchProcess {
  return { pid: 4242, pgid: 4242, identitySha256: HASH_C };
}

function launchFact(run: TestRun, suffix: string, overrides: Partial<NativeHarnessDispatchLaunch> = {}): NativeHarnessDispatchLaunch {
  return {
    runtimeRoot: path.join(run.root, suffix),
    configSha256: HASH_C,
    appendixSha256: HASH_D,
    effectiveTimeoutMs: 8_000,
    ...overrides,
  };
}

function promptFact(overrides: Partial<NativeHarnessDispatchPrompt> = {}): NativeHarnessDispatchPrompt {
  return {
    promptSha256: HASH_D,
    promptBytes: 1_234,
    effectiveTimeoutMs: 5_000,
    ...overrides,
  };
}

function cleanupObservation(
  overrides: Partial<WorkerLifecycleCleanupObservedEvent> = {},
): WorkerLifecycleCleanupObservedEvent {
  return {
    type: "cleanupObserved",
    runId: RUN_ID,
    stage: "baseline",
    spawnAttempted: true,
    closeSeen: true,
    closeCode: 0,
    closeSignal: null,
    groupObservation: "not-observed",
    groupObservedAt: new Date(ADMITTED_AT + 20_000).toISOString(),
    hostWorkSettled: true,
    approvalWorkSettled: true,
    logFlush: "success",
    ...overrides,
  };
}

function runnerCleanup(
  overrides: Partial<WorkerLifecycleCleanupObservedEvent> = {},
): NativeHarnessDispatchCleanupReceipt {
  return {
    observationKind: "runner-observation",
    observation: cleanupObservation(overrides),
  };
}

function preSpawnCleanup(): NativeHarnessDispatchCleanupReceipt {
  return runnerCleanup({
    spawnAttempted: false,
    closeSeen: false,
    closeCode: null,
    closeSignal: null,
    groupObservation: "unknown",
    groupObservedAt: null,
  });
}

const SYNTHETIC_CLEANUP: NativeHarnessDispatchCleanupReceipt = Object.freeze({
  observationKind: "synthetic-fixture",
});

function terminal(overrides: Partial<NativeHarnessDispatchTerminal> = {}): NativeHarnessDispatchTerminal {
  return {
    outcome: "cancelled",
    observationKind: "runner-observation",
    observedAt: ADMITTED_AT + 20_000,
    resultSha256: null,
    usageCostUsd: null,
    usageEstimated: true,
    ...overrides,
  };
}

function syntheticTerminal(overrides: Partial<NativeHarnessDispatchTerminal> = {}): NativeHarnessDispatchTerminal {
  return terminal({
    outcome: "completed",
    observationKind: "synthetic-fixture",
    resultSha256: HASH_E,
    usageCostUsd: 0.02,
    usageEstimated: false,
    ...overrides,
  });
}

function immutableFacts(row: NativeHarnessDispatchRow): Record<string, unknown> {
  return {
    ordinal: row.ordinal,
    nonce: row.nonce,
    runId: row.runId,
    runRevision: row.runRevision,
    stage: row.stage,
    attempt: row.attempt,
    cwd: row.cwd,
    artifactDir: row.artifactDir,
    intentSha256: row.intentSha256,
    snapshotSha256: row.snapshotSha256,
    originNonce: row.originNonce,
    sourceAssociationSha256: row.sourceAssociationSha256,
    outerDeadlineAt: row.outerDeadlineAt,
    innerDeadlineAt: row.innerDeadlineAt,
    requestTimeoutMs: row.requestTimeoutMs,
    stageAllocatedCostUsd: row.stageAllocatedCostUsd,
  };
}

async function createInventory(
  run: TestRun,
  options?: Parameters<typeof createNativeHarnessDispatchInventory>[1],
): Promise<NativeHarnessDispatchInventoryHandle> {
  return createNativeHarnessDispatchInventory({ storeRoot: run.store.root, runId: RUN_ID }, options);
}

async function openInventory(
  run: TestRun,
  options?: Parameters<typeof openNativeHarnessDispatchInventory>[1],
): Promise<NativeHarnessDispatchInventoryHandle> {
  return openNativeHarnessDispatchInventory({ storeRoot: run.store.root, runId: RUN_ID }, options);
}

async function completeRunner(
  handle: NativeHarnessDispatchInventoryHandle,
  run: TestRun,
  intent: NativeHarnessDispatchIntent,
  outcome: NativeHarnessDispatchTerminal["outcome"] = "completed",
): Promise<NativeHarnessDispatchInventoryV2> {
  await handle.intend(intent, noop);
  await handle.markLaunched(intent.ordinal, intent.nonce, launchFact(run, `runtime-${intent.ordinal}`), noop);
  await handle.bindProcess(intent.ordinal, intent.nonce, processFact(), noop);
  await handle.markPromptPending(intent.ordinal, intent.nonce, promptFact(), noop);
  await handle.markCleanupObserved(intent.ordinal, intent.nonce, runnerCleanup(), noop);
  return expectV2(await handle.finalize(
    intent.ordinal,
    intent.nonce,
    terminal({
      outcome,
      observationKind: "runner-observation",
      resultSha256: HASH_E,
      usageCostUsd: 0.05,
      usageEstimated: false,
    }),
    noop,
  ));
}

const LONG_TERMINAL_USAGE_COST = 0.0000010000000000000002;
const MAX_CRAFTED_RUNTIME_ROOT = `/${"\\".repeat(1_023)}`;
const MAX_CLEANUP_SIGNAL = `SIG${"X".repeat(29)}`;
const MAX_CLEANUP_OBSERVED_AT = "+275760-09-13T00:00:00.000Z";

function craftedPath(cwdBytes: number): string {
  return `/${"a".repeat(cwdBytes - 1)}`;
}

function craftedBaseFacts(
  ordinal: number,
  cwdBytes: number,
  artifactDirBytes: number,
  origin: RunRecoveryOrigin,
) {
  return {
    ordinal,
    nonce: uuid(1_000 + ordinal),
    runId: RUN_ID,
    runRevision: ordinal,
    stage: "baseline" as const,
    attempt: ordinal,
    cwd: craftedPath(cwdBytes),
    artifactDir: craftedPath(artifactDirBytes),
    intentSha256: HASH_B,
    snapshotSha256: HASH_A,
    originNonce: origin.nonce,
    sourceAssociationSha256: origin.seed.sourceAssociationSha256,
    outerDeadlineAt: origin.seed.deadlineAt,
    innerDeadlineAt: ADMITTED_AT + 10_000 + ordinal,
    requestTimeoutMs: 8_000,
    stageAllocatedCostUsd: 0.1,
  };
}

function craftedLaunch(ordinal: number, exactMax = false): NativeHarnessDispatchLaunch {
  const suffix = exactMax ? "" : ordinal.toString(36);
  const runtimeRoot = `/${"\\".repeat(MAX_CRAFTED_RUNTIME_ROOT.length - 1 - suffix.length)}${suffix}`;
  return {
    runtimeRoot,
    configSha256: "f".repeat(64),
    appendixSha256: "e".repeat(64),
    effectiveTimeoutMs: 8_000,
  };
}

function craftedProcess(): NativeHarnessDispatchProcess {
  return { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER, identitySha256: "f".repeat(64) };
}

function craftedPrompt(): NativeHarnessDispatchPrompt {
  return {
    promptSha256: "f".repeat(64),
    promptBytes: NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES,
    effectiveTimeoutMs: 8_000,
  };
}

const CRAFTED_CLEANUP: NativeHarnessDispatchCleanupReceipt = {
  observationKind: "runner-observation",
  observation: {
    type: "cleanupObserved",
    runId: RUN_ID,
    stage: "compose_edit",
    spawnAttempted: true,
    closeSeen: true,
    closeCode: -Number.MAX_SAFE_INTEGER,
    closeSignal: MAX_CLEANUP_SIGNAL,
    groupObservation: "not-observed",
    groupObservedAt: MAX_CLEANUP_OBSERVED_AT,
    hostWorkSettled: false,
    approvalWorkSettled: false,
    logFlush: "failure",
  },
};

function craftedRunnerTerminal(usageCostUsd = Number.MAX_VALUE): NativeHarnessDispatchTerminal {
  return {
    outcome: "completed",
    observationKind: "runner-observation",
    observedAt: Number.MAX_SAFE_INTEGER,
    resultSha256: "f".repeat(64),
    usageCostUsd,
    usageEstimated: false,
  };
}

function craftedTerminalRow(
  ordinal: number,
  cwdBytes: number,
  artifactDirBytes: number,
  origin: RunRecoveryOrigin,
  stage: "baseline" | "compose_edit" = "compose_edit",
  exactMaxLaunch = false,
): NativeHarnessDispatchRow {
  return {
    ...craftedBaseFacts(ordinal, cwdBytes, artifactDirBytes, origin),
    stage,
    state: "terminal",
    launch: craftedLaunch(ordinal, exactMaxLaunch),
    process: craftedProcess(),
    prompt: craftedPrompt(),
    cleanup: CRAFTED_CLEANUP,
    terminal: craftedRunnerTerminal(),
  };
}

function craftedCleanupRow(
  ordinal: number,
  cwdBytes: number,
  artifactDirBytes: number,
  origin: RunRecoveryOrigin,
  exactMaxLaunch = false,
): NativeHarnessDispatchRow {
  return {
    ...craftedBaseFacts(ordinal, cwdBytes, artifactDirBytes, origin),
    stage: "compose_edit",
    state: "cleanup-observed",
    launch: craftedLaunch(ordinal, exactMaxLaunch),
    process: craftedProcess(),
    prompt: craftedPrompt(),
    cleanup: CRAFTED_CLEANUP,
  };
}

function craftedInventoryText(
  origin: RunRecoveryOrigin,
  fixed: { readonly stageTimeoutMs: number; readonly maxDurationMs: number; readonly maxCostUsd: number },
  revision: number,
  dispatches: readonly NativeHarnessDispatchRow[],
): string {
  return `${JSON.stringify({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2,
    revision,
    runId: RUN_ID,
    origin,
    fixed: {
      stageTimeoutMs: fixed.stageTimeoutMs,
      maxDurationMs: fixed.maxDurationMs,
      maxCostUsd: fixed.maxCostUsd,
    },
    dispatches,
  }, null, 2)}\n`;
}

function craftedRows(
  roots: ReadonlyArray<{ readonly cwd: number; readonly artifactDir: number }>,
  origin: RunRecoveryOrigin,
  completed: boolean,
): NativeHarnessDispatchRow[] {
  const count = roots.length;
  const rows: NativeHarnessDispatchRow[] = roots.slice(0, count - 1).map((root, index) =>
    craftedTerminalRow(index + 1, root.cwd, root.artifactDir, origin));
  const last = roots[count - 1]!;
  rows.push(completed
    ? craftedTerminalRow(count, last.cwd, last.artifactDir, origin, "compose_edit", true)
    : craftedCleanupRow(count, last.cwd, last.artifactDir, origin, true));
  return rows;
}

function tuneCraftedCompletion(
  origin: RunRecoveryOrigin,
  fixed: { readonly stageTimeoutMs: number; readonly maxDurationMs: number; readonly maxCostUsd: number },
  count: number,
  targetBytes: number,
  currentRevision: number,
  completionRevision: number,
): {
  readonly current: NativeHarnessDispatchRow[];
  readonly completed: NativeHarnessDispatchRow[];
} {
  const roots = Array.from({ length: count }, () => ({ cwd: 3_900, artifactDir: 3_900 }));
  const completionBytes = () => Buffer.byteLength(
    craftedInventoryText(origin, fixed, completionRevision, craftedRows(roots, origin, true)),
    "utf8",
  );
  const initial = completionBytes();
  const delta = Math.trunc((targetBytes - initial) / (2 * count));
  if (delta !== 0) {
    for (const root of roots) {
      root.cwd = Math.min(4_096, Math.max(2, root.cwd + delta));
      root.artifactDir = Math.min(4_096, Math.max(2, root.artifactDir + delta));
    }
  }
  let diff = targetBytes - completionBytes();
  for (const root of roots) {
    if (diff === 0) break;
    const nextCwd = Math.min(4_096, Math.max(2, root.cwd + diff));
    diff -= nextCwd - root.cwd;
    root.cwd = nextCwd;
    if (diff === 0) break;
    const nextArtifactDir = Math.min(4_096, Math.max(2, root.artifactDir + diff));
    diff -= nextArtifactDir - root.artifactDir;
    root.artifactDir = nextArtifactDir;
  }
  if (diff !== 0) throw new Error("crafted inventory size could not be tuned to the requested byte boundary.");
  const current = craftedInventoryText(origin, fixed, currentRevision, craftedRows(roots, origin, false));
  return {
    current: craftedRows(roots, origin, false),
    completed: craftedRows(roots, origin, true),
  };
}

const WIDE_ACTUAL_CLEANUP: NativeHarnessDispatchCleanupReceipt = {
  observationKind: "runner-observation",
  observation: {
    type: "cleanupObserved",
    runId: RUN_ID,
    stage: "compose_edit",
    spawnAttempted: true,
    closeSeen: true,
    closeCode: -Number.MAX_SAFE_INTEGER,
    closeSignal: MAX_CLEANUP_SIGNAL,
    groupObservation: "not-observed",
    groupObservedAt: MAX_CLEANUP_OBSERVED_AT,
    hostWorkSettled: false,
    approvalWorkSettled: false,
    logFlush: "failure",
  },
};

const WIDE_PROJECTED_CLEANUP: NativeHarnessDispatchCleanupReceipt = {
  observationKind: "runner-observation",
  observation: {
    ...WIDE_ACTUAL_CLEANUP.observation,
    spawnAttempted: false,
    closeSeen: false,
  },
};

function craftedPreReceiptRows(
  roots: ReadonlyArray<{ readonly cwd: number; readonly artifactDir: number }>,
  origin: RunRecoveryOrigin,
  mode: "current" | "projected" | "final",
): NativeHarnessDispatchRow[] {
  const count = roots.length;
  const rows = roots.slice(0, count - 1).map((root, index) =>
    craftedTerminalRow(index + 1, root.cwd, root.artifactDir, origin));
  const last = roots[count - 1]!;
  const base = {
    ...craftedBaseFacts(count, last.cwd, last.artifactDir, origin),
    stage: "compose_edit" as const,
  };
  if (mode === "current") {
    rows.push({
      ...base,
      state: "prompt-pending",
      launch: craftedLaunch(count, true),
      process: craftedProcess(),
      prompt: craftedPrompt(),
    });
  } else {
    rows.push({
      ...base,
      state: "terminal",
      launch: craftedLaunch(count, true),
      process: craftedProcess(),
      prompt: craftedPrompt(),
      cleanup: mode === "projected" ? WIDE_PROJECTED_CLEANUP : WIDE_ACTUAL_CLEANUP,
      terminal: craftedRunnerTerminal(),
    });
  }
  return rows;
}

function tuneCraftedPreReceipt(
  origin: RunRecoveryOrigin,
  fixed: { readonly stageTimeoutMs: number; readonly maxDurationMs: number; readonly maxCostUsd: number },
  count: number,
  targetBytes: number,
  currentRevision: number,
  completionRevision: number,
): {
  readonly current: NativeHarnessDispatchRow[];
  readonly projected: NativeHarnessDispatchRow[];
  readonly final: NativeHarnessDispatchRow[];
} {
  const roots = Array.from({ length: count }, () => ({ cwd: 3_900, artifactDir: 3_900 }));
  const projectedBytes = () => Buffer.byteLength(craftedInventoryText(
    origin,
    fixed,
    completionRevision,
    craftedPreReceiptRows(roots, origin, "projected"),
  ), "utf8");
  const initial = projectedBytes();
  const delta = Math.trunc((targetBytes - initial) / (2 * count));
  if (delta !== 0) {
    for (const root of roots) {
      root.cwd = Math.min(4_096, Math.max(2, root.cwd + delta));
      root.artifactDir = Math.min(4_096, Math.max(2, root.artifactDir + delta));
    }
  }
  let diff = targetBytes - projectedBytes();
  for (const root of roots) {
    if (diff === 0) break;
    const nextCwd = Math.min(4_096, Math.max(2, root.cwd + diff));
    diff -= nextCwd - root.cwd;
    root.cwd = nextCwd;
    if (diff === 0) break;
    const nextArtifactDir = Math.min(4_096, Math.max(2, root.artifactDir + diff));
    diff -= nextArtifactDir - root.artifactDir;
    root.artifactDir = nextArtifactDir;
  }
  if (diff !== 0) throw new Error("crafted pre-receipt inventory could not be tuned to the requested byte boundary.");
  return {
    current: craftedPreReceiptRows(roots, origin, "current"),
    projected: craftedPreReceiptRows(roots, origin, "projected"),
    final: craftedPreReceiptRows(roots, origin, "final"),
  };
}

function rawV1Inventory(run: TestRun): string {
  const origin = run.record.recoveryOrigin!;
  const attemptDir = path.join(run.runDir, "stages", "baseline", "attempt-v1");
  return `${JSON.stringify({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
    revision: 7,
    runId: RUN_ID,
    origin,
    fixed: {
      stageTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxCostUsd: 0.5,
    },
    dispatches: [{
      ordinal: 1,
      nonce: uuid(500),
      runId: RUN_ID,
      runRevision: 3,
      stage: "baseline",
      attempt: 1,
      cwd: path.join(attemptDir, "workspace"),
      artifactDir: path.join(attemptDir, "artifacts"),
      intentSha256: HASH_B,
      snapshotSha256: HASH_A,
      originNonce: origin.nonce,
      sourceAssociationSha256: origin.seed.sourceAssociationSha256,
      outerDeadlineAt: origin.seed.deadlineAt,
      innerDeadlineAt: ADMITTED_AT + 10_001,
      requestTimeoutMs: 8_000,
      stageAllocatedCostUsd: 0.1,
      state: "terminal",
      launch: { runtimeRoot: path.join(run.root, "runtime-v1") },
      process: { pid: 4242, pgid: 4242, identitySha256: HASH_C },
      prompt: { promptSha256: HASH_D, effectiveTimeoutMs: 5_000 },
      terminal: {
        outcome: "completed",
        observationKind: "runner-observation",
        observedAt: ADMITTED_AT + 20_000,
        resultSha256: HASH_E,
        usageCostUsd: 0.05,
        usageEstimated: false,
      },
    }],
  }, null, 2)}\n`;
}

function countingIo(): { readonly io: NativeFileIo; writes: () => number } {
  let writeOpens = 0;
  const io: NativeFileIo = {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: (target) => nodeFileIo.realpath(target),
    lstat: (target, options) => nodeFileIo.lstat(target, options),
    open: (target, flags) => {
      if ((flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) !== 0) {
        writeOpens += 1;
      }
      return nodeFileIo.open(target, flags);
    },
  };
  return { io, writes: () => writeOpens };
}

function countingGetter<T extends object>(target: T): { readonly value: T; gets: () => number } {
  let gets = 0;
  return {
    value: new Proxy(target, {
      get: (inner, key, receiver) => {
        gets += 1;
        return Reflect.get(inner, key, receiver);
      },
    }),
    gets: () => gets,
  };
}

describe("dispatch inventory genesis binding", () => {
  test("creates v2 only for the exact actual recovery-origin run and reopens the same frozen facts", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const snapshot = expectV2(created.snapshot());
    expect(snapshot.schema).toBe("omp-agent.native-harness-dispatch-inventory.v2");
    expect(snapshot.revision).toBe(0);
    expect(snapshot.runId).toBe(RUN_ID);
    expect(snapshot.origin).toEqual(run.record.recoveryOrigin!);
    expect(snapshot.fixed).toEqual({
      stageTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxCostUsd: 0.5,
    });
    expect(snapshot.dispatches).toEqual([]);

    const raw = await readInventoryRaw(run);
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw) as { schema: string; origin: unknown; revision: number; dispatches: unknown[] };
    expect(parsed.schema).toBe(NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2);
    expect(parsed.origin).toEqual(run.record.recoveryOrigin);
    expect(parsed.revision).toBe(0);
    expect(parsed.dispatches).toEqual([]);
    expect((await stat(inventoryPath(run))).isFile()).toBe(true);
    expect(await exists(`${inventoryPath(run)}.bak`)).toBe(false);

    const opened = await openInventory(run);
    expect(opened.snapshot()).toEqual(snapshot);

    const before = await readInventoryRaw(run);
    await expectCode(createInventory(run), "conflict");
    expect(await readInventoryRaw(run)).toBe(before);
    expect((await readInventoryJson(run)).revision).toBe(0);
    created.close();
    opened.close();
  });

  test("refuses a run without a recovery origin and refuses to mint on a missing primary", async () => {
    const plain = await makePlainRun();
    await expectCode(createInventory(plain), "identity-mismatch");
    await expectCode(openInventory(plain), "identity-mismatch");
    expect(await exists(inventoryPath(plain))).toBe(false);

    const run = await makeRun();
    const backup = await readFile(runPath(run), "utf8");
    await writeFile(`${runPath(run)}.bak`, backup);
    await unlink(runPath(run));
    await expectCode(createInventory(run), "unavailable");
    await expectCode(openInventory(run), "unavailable");
    expect(await exists(inventoryPath(run))).toBe(false);
  });

  test("binds the sidecar to the actual origin, run ID and fixed run facts", async () => {
    const runA = await makeRun();
    const created = await createInventory(runA);
    const valid = await readInventoryRaw(runA);
    created.close();

    const runB = await makeRun();
    await writeFile(inventoryPath(runB), valid);
    await expectCode(openInventory(runB), "identity-mismatch");

    const changedOrigin = JSON.parse(valid) as { origin: { nonce: string } };
    changedOrigin.origin.nonce = uuid(99);
    await writeFile(inventoryPath(runA), `${JSON.stringify(changedOrigin, null, 2)}\n`);
    await expectCode(openInventory(runA), "identity-mismatch");

    const changedFixed = JSON.parse(valid) as { fixed: { stageTimeoutMs: number } };
    changedFixed.fixed.stageTimeoutMs = 9_000;
    await writeFile(inventoryPath(runA), `${JSON.stringify(changedFixed, null, 2)}\n`);
    await expectCode(openInventory(runA), "identity-mismatch");
  });
});

describe("dispatch inventory v1 compatibility", () => {
  test("opens an independent raw v1 fixture with exact bytes and refuses every mutation before getters, guards or IO", async () => {
    const run = await makeRun();
    const raw = rawV1Inventory(run);
    await writeFile(inventoryPath(run), raw);
    const observed = countingIo();
    let afterRead = 0;
    let afterWrite = 0;
    const handle = await openInventory(run, {
      fileIo: observed.io,
      testAfterPrimaryRead: () => { afterRead += 1; },
      testAfterPrimaryWrite: () => { afterWrite += 1; },
    });
    const snapshot = expectV1(handle.snapshot());
    expect(snapshot.revision).toBe(7);
    expect(snapshot.dispatches[0]!.state).toBe("terminal");
    expect(snapshot.dispatches[0]!.launch).toEqual({ runtimeRoot: path.join(run.root, "runtime-v1") });
    expect(snapshot.dispatches[0]!.process).toEqual(processFact());
    expect(snapshot.dispatches[0]!.prompt).toEqual({ promptSha256: HASH_D, effectiveTimeoutMs: 5_000 });
    expect(JSON.stringify(snapshot)).not.toContain(NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA_V2);
    expect(await readInventoryRaw(run)).toBe(raw);

    afterRead = 0;
    afterWrite = 0;
    const openedWritesBefore = observed.writes();
    const intent = countingGetter(baseIntent(run, 2));
    const launch = countingGetter(launchFact(run, "runtime-v2"));
    const prompt = countingGetter(promptFact());
    const process = countingGetter(processFact());
    const receipt = countingGetter(runnerCleanup());
    const term = countingGetter(terminal());
    let guardCalls = 0;
    const guard = () => { guardCalls += 1; };
    await expectThrownCode(() => handle.intend(intent.value, guard), "read-only");
    await expectThrownCode(() => handle.markLaunched(2, uuid(2), launch.value, guard), "read-only");
    await expectThrownCode(() => handle.bindProcess(2, uuid(2), process.value, guard), "read-only");
    await expectThrownCode(() => handle.markPromptPending(2, uuid(2), prompt.value, guard), "read-only");
    await expectThrownCode(() => handle.markCleanupObserved(2, uuid(2), receipt.value, guard), "read-only");
    await expectThrownCode(() => handle.finalize(1, snapshot.dispatches[0]!.nonce, term.value, guard), "read-only");
    expect(intent.gets()).toBe(0);
    expect(launch.gets()).toBe(0);
    expect(process.gets()).toBe(0);
    expect(prompt.gets()).toBe(0);
    expect(receipt.gets()).toBe(0);
    expect(term.gets()).toBe(0);
    expect(guardCalls).toBe(0);
    expect(afterRead).toBe(0);
    expect(afterWrite).toBe(0);
    expect(observed.writes()).toBe(openedWritesBefore);
    expect(await readInventoryRaw(run)).toBe(raw);
    expect(await exists(`${inventoryPath(run)}.bak`)).toBe(false);
    expect(handle.snapshot()).toBe(snapshot);
    await expectCode(createInventory(run), "conflict");
    expect(await readInventoryRaw(run)).toBe(raw);
  });
});

describe("dispatch inventory sidecar isolation", () => {
  test("refuses missing, corrupt, oversized, symlink and backup-only sidecars without adopting bytes", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const valid = await readInventoryRaw(run);
    created.close();

    await unlink(inventoryPath(run));
    await expectCode(openInventory(run), "unavailable");
    expect(await exists(inventoryPath(run))).toBe(false);

    await writeFile(`${inventoryPath(run)}.bak`, valid);
    await expectCode(openInventory(run), "unavailable");
    expect(await exists(inventoryPath(run))).toBe(false);
    await expectCode(createInventory(run), "conflict");
    expect(await exists(inventoryPath(run))).toBe(false);

    await writeFile(inventoryPath(run), "{not canonical json");
    await expectCode(openInventory(run), "corrupt");
    expect(await readFile(`${inventoryPath(run)}.bak`, "utf8")).toBe(valid);

    await writeFile(inventoryPath(run), "x".repeat(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES + 1));
    await expectCode(openInventory(run), "too-large");

    const target = path.join(run.root, "valid-inventory-target.json");
    await writeFile(target, valid);
    await unlink(inventoryPath(run));
    await symlink(target, inventoryPath(run));
    await expectCode(openInventory(run), "unsafe-path");

    await unlink(inventoryPath(run));
    await writeFile(path.join(run.runDir, "dispatch-inventory.legacy.json"), valid);
    await expectCode(openInventory(run), "unavailable");
    expect(await exists(inventoryPath(run))).toBe(false);
  });

  test("rejects an afterRead run-directory substitution before writing the wrong target", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const valid = await readInventoryRaw(run);
    created.close();

    const moved = path.join(run.root, "moved-run");
    const substitute = path.join(run.root, "substitute-run");
    await mkdir(substitute);
    await writeFile(path.join(substitute, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE), valid);
    let fired = false;
    const handle = await openInventory(run, {
      testAfterPrimaryRead: async () => {
        if (fired) return;
        fired = true;
        await rename(run.runDir, moved);
        const lockOwner = await readFile(path.join(moved, ".write.lock", "owner.json"), "utf8");
        await mkdir(path.join(substitute, ".write.lock"));
        await writeFile(path.join(substitute, ".write.lock", "owner.json"), lockOwner);
        await symlink(substitute, run.runDir);
      },
    });
    const beforeSubstitute = await readFile(
      path.join(substitute, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE),
      "utf8",
    );
    await expectCode(handle.intend(baseIntent(run, 1), noop), "changed");
    expect(await readFile(path.join(substitute, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE), "utf8"))
      .toBe(beforeSubstitute);
    expect(await readFile(path.join(moved, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE), "utf8"))
      .toBe(valid);
    expect(handle.snapshot().revision).toBe(0);
  });
});

describe("dispatch inventory v2 lifecycle", () => {
  test("appends immutable facts, preserves launch digests and prompt bytes, and completes after cleanup", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    const launch = launchFact(run, "runtime-1");
    const prompt = promptFact({ promptBytes: 4_096, effectiveTimeoutMs: 5_000 });

    let snapshot = expectV2(await created.intend(intent, noop));
    const intended = snapshot.dispatches[0]!;
    const immutable = immutableFacts(intended);
    await created.markLaunched(1, intent.nonce, launch, noop);
    await created.bindProcess(1, intent.nonce, processFact(), noop);
    await created.markPromptPending(1, intent.nonce, prompt, noop);
    snapshot = expectV2(await created.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop));
    let row = snapshot.dispatches[0]!;
    expect(row.state).toBe("cleanup-observed");
    expect(row.launch).toEqual(launch);
    expect(row.process).toEqual(processFact());
    expect(row.prompt).toEqual(prompt);
    expect(row.cleanup).toEqual(runnerCleanup());
    expect(row.terminal).toBeUndefined();
    expect(immutableFacts(row)).toEqual(immutable);

    snapshot = expectV2(await created.finalize(
      1,
      intent.nonce,
      terminal({
        outcome: "completed",
        observationKind: "runner-observation",
        resultSha256: HASH_E,
        usageCostUsd: 0.05,
        usageEstimated: false,
      }),
      noop,
    ));
    row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.launch).toEqual(launch);
    expect(row.process).toEqual(processFact());
    expect(row.prompt).toEqual(prompt);
    expect(row.prompt!.promptBytes).toBe(4_096);
    expect(row.cleanup).toEqual(runnerCleanup());
    expect(row.terminal!.observationKind).toBe("runner-observation");
    expect(immutableFacts(row)).toEqual(immutable);
    expect(row.launch!.configSha256).toBe(HASH_C);
    expect(row.launch!.appendixSha256).toBe(HASH_D);

    const secondIntent = baseIntent(run, 2);
    await created.intend(secondIntent, noop);
    await created.markLaunched(2, secondIntent.nonce, launchFact(run, "runtime-2"), noop);
    await created.bindProcess(2, secondIntent.nonce, processFact(), noop);
    await created.markPromptPending(2, secondIntent.nonce, promptFact(), noop);
    await created.markCleanupObserved(2, secondIntent.nonce, runnerCleanup(), noop);
    await created.finalize(2, secondIntent.nonce, terminal({ outcome: "failed" }), noop);
    const thirdIntent = baseIntent(run, 3);
    await created.intend(thirdIntent, noop);

    snapshot = expectV2(created.snapshot());
    expect(snapshot.dispatches.map((candidate) => [candidate.ordinal, candidate.attempt, candidate.state])).toEqual([
      [1, 1, "terminal"],
      [2, 2, "terminal"],
      [3, 3, "intended"],
    ]);
    expect(snapshot.dispatches[0]).toEqual(row);
    expect(snapshot.origin).toEqual(run.record.recoveryOrigin!);

    created.close();
    const opened = await openInventory(run);
    expect(opened.snapshot()).toEqual(snapshot);
    opened.close();
  });

  test("preserves the exact actual inner deadline even when it is later than outer", async () => {
    const run = await makeRun({ maxDurationMs: 600_000 });
    const created = await createInventory(run);
    const exactInner = Date.parse(run.record.createdAt) + 600_000;
    expect(exactInner).toBeGreaterThan(DEADLINE_AT);
    const intent = { ...baseIntent(run, 1), innerDeadlineAt: exactInner };
    const snapshot = expectV2(await created.intend(intent, noop));
    expect(snapshot.dispatches[0]!.outerDeadlineAt).toBe(DEADLINE_AT);
    expect(snapshot.dispatches[0]!.innerDeadlineAt).toBe(exactInner);

    const before = await readInventoryRaw(run);
    await expectCode(
      created.intend({ ...baseIntent(run, 2), innerDeadlineAt: exactInner + 1 }, noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(before);
  });

  test("rejects missing digests, oversized prompt frames and timeout widening without mutation", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    const afterIntent = await readInventoryRaw(run);

    const missingDigest = { ...launchFact(run, "runtime-missing"), configSha256: "short" } as unknown as NativeHarnessDispatchLaunch;
    await expectThrownCode(
      () => created.markLaunched(1, intent.nonce, missingDigest, noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(afterIntent);

    await expectThrownCode(
      () => created.markLaunched(1, intent.nonce, launchFact(run, "runtime-wide", { effectiveTimeoutMs: 8_001 }), noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(afterIntent);

    const launch = launchFact(run, "runtime-ok", { effectiveTimeoutMs: 8_000 });
    await created.markLaunched(1, intent.nonce, launch, noop);
    await created.bindProcess(1, intent.nonce, processFact(), noop);
    const afterProcess = await readInventoryRaw(run);
    await expectThrownCode(
      () => created.markPromptPending(1, intent.nonce, promptFact({ effectiveTimeoutMs: 8_001 }), noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(afterProcess);
    await expectThrownCode(
      () => created.markPromptPending(1, intent.nonce, promptFact({ promptBytes: NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES + 1 }), noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(afterProcess);
    await expectThrownCode(
      () => created.markPromptPending(1, intent.nonce, promptFact({ promptBytes: 0 }), noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(afterProcess);

    const snapshot = expectV2(await created.markPromptPending(
      1,
      intent.nonce,
      promptFact({ promptBytes: NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES, effectiveTimeoutMs: 8_000 }),
      noop,
    ));
    expect(snapshot.dispatches[0]!.prompt).toEqual({
      promptSha256: HASH_D,
      promptBytes: NATIVE_HARNESS_DISPATCH_PROMPT_MAX_BYTES,
      effectiveTimeoutMs: 8_000,
    });
  });

  test("closes every failure prefix with an actual receipt and preserves the complete prefix", async () => {
    const cases = [
      {
        name: "intended",
        prepare: async (
          _handle: NativeHarnessDispatchInventoryHandle,
          _intent: NativeHarnessDispatchIntent,
          _run: TestRun,
        ): Promise<void> => {},
        receipt: preSpawnCleanup,
        outcome: "failed" as const,
      },
      {
        name: "launch-pending",
        prepare: async (
          handle: NativeHarnessDispatchInventoryHandle,
          intent: NativeHarnessDispatchIntent,
          run: TestRun,
        ): Promise<void> => {
          await handle.markLaunched(intent.ordinal, intent.nonce, launchFact(run, `runtime-${intent.ordinal}`), noop);
        },
        receipt: preSpawnCleanup,
        outcome: "failed" as const,
      },
      {
        name: "process-bound",
        prepare: async (
          handle: NativeHarnessDispatchInventoryHandle,
          intent: NativeHarnessDispatchIntent,
          run: TestRun,
        ): Promise<void> => {
          await handle.markLaunched(intent.ordinal, intent.nonce, launchFact(run, `runtime-${intent.ordinal}`), noop);
          await handle.bindProcess(intent.ordinal, intent.nonce, processFact(), noop);
        },
        receipt: runnerCleanup,
        outcome: "failed" as const,
      },
      {
        name: "prompt-pending",
        prepare: async (
          handle: NativeHarnessDispatchInventoryHandle,
          intent: NativeHarnessDispatchIntent,
          run: TestRun,
        ): Promise<void> => {
          await handle.markLaunched(intent.ordinal, intent.nonce, launchFact(run, `runtime-${intent.ordinal}`), noop);
          await handle.bindProcess(intent.ordinal, intent.nonce, processFact(), noop);
          await handle.markPromptPending(intent.ordinal, intent.nonce, promptFact(), noop);
        },
        receipt: runnerCleanup,
        outcome: "completed" as const,
      },
    ];
    for (const entry of cases) {
      const run = await makeRun();
      const handle = await createInventory(run);
      const intent = baseIntent(run, 1);
      await handle.intend(intent, noop);
      const prefix = expectV2(handle.snapshot());
      await entry.prepare(handle, intent, run);
      const beforeCleanup = expectV2(handle.snapshot());
      const cleaned = expectV2(await handle.markCleanupObserved(1, intent.nonce, entry.receipt(), noop));
      const row = cleaned.dispatches[0]!;
      expect(row.state).toBe("cleanup-observed");
      expect(row.cleanup).toEqual(entry.receipt());
      expect(row.ordinal).toBe(1);
      expect(row.launch).toEqual(beforeCleanup.dispatches[0]!.launch);
      expect(row.process).toEqual(beforeCleanup.dispatches[0]!.process);
      expect(row.prompt).toEqual(beforeCleanup.dispatches[0]!.prompt);
      expect(immutableFacts(row)).toEqual(immutableFacts(prefix.dispatches[0]!));
      const done = expectV2(await handle.finalize(
        1,
        intent.nonce,
        terminal({ outcome: entry.outcome, observationKind: "runner-observation" }),
        noop,
      ));
      expect(done.dispatches[0]!.state).toBe("terminal");
      expect(done.dispatches[0]!.cleanup).toEqual(entry.receipt());
      handle.close();
    }
  });

  test("permits explicit synthetic closure only on an intended row and never fabricates process facts", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    const before = await readInventoryRaw(run);
    await expectCode(created.finalize(1, intent.nonce, syntheticTerminal(), noop), "invalid-transition");
    expect(await readInventoryRaw(run)).toBe(before);

    let snapshot = expectV2(await created.markCleanupObserved(1, intent.nonce, SYNTHETIC_CLEANUP, noop));
    let row = snapshot.dispatches[0]!;
    expect(row.state).toBe("cleanup-observed");
    expect(row.launch).toBeUndefined();
    expect(row.process).toBeUndefined();
    expect(row.prompt).toBeUndefined();
    expect(row.cleanup).toEqual(SYNTHETIC_CLEANUP);

    snapshot = expectV2(await created.finalize(1, intent.nonce, syntheticTerminal(), noop));
    row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.launch).toBeUndefined();
    expect(row.process).toBeUndefined();
    expect(row.prompt).toBeUndefined();
    expect(row.terminal?.observationKind).toBe("synthetic-fixture");
    expect(row.terminal?.outcome).toBe("completed");
    expect(JSON.stringify(row)).not.toContain('"pid"');

    const reopened = await openInventory(run);
    const reopenedRow = expectV2(reopened.snapshot()).dispatches[0]!;
    expect(reopenedRow.state).toBe("terminal");
    expect(reopenedRow.process).toBeUndefined();
    expect(reopenedRow.cleanup).toEqual(SYNTHETIC_CLEANUP);

    const launchedRun = await makeRun();
    const launched = await createInventory(launchedRun);
    const launchedIntent = baseIntent(launchedRun, 1);
    await launched.intend(launchedIntent, noop);
    await launched.markLaunched(1, launchedIntent.nonce, launchFact(launchedRun, "runtime-synthetic"), noop);
    const launchedRaw = await readInventoryRaw(launchedRun);
    await expectCode(
      launched.markCleanupObserved(1, launchedIntent.nonce, SYNTHETIC_CLEANUP, noop),
      "invalid-transition",
    );
    expect(await readInventoryRaw(launchedRun)).toBe(launchedRaw);
  });

  test("validates cleanup receipt own data before invoking any accessor", async () => {
    const run = await makeRun();
    const handle = await createInventory(run);
    const intent = baseIntent(run, 1);
    await handle.intend(intent, noop);
    const before = await readInventoryRaw(run);

    let kindGets = 0;
    const accessorReceipt = {} as Record<string, unknown>;
    Object.defineProperty(accessorReceipt, "observationKind", {
      enumerable: true,
      get: () => {
        kindGets += 1;
        return "synthetic-fixture";
      },
    });
    await expectThrownCode(
      () => handle.markCleanupObserved(
        1,
        intent.nonce,
        accessorReceipt as unknown as NativeHarnessDispatchCleanupReceipt,
        noop,
      ),
      "invalid-input",
    );
    expect(kindGets).toBe(0);

    let runIdGets = 0;
    const accessorObservation = { ...cleanupObservation() };
    Object.defineProperty(accessorObservation, "runId", {
      enumerable: true,
      get: () => {
        runIdGets += 1;
        return RUN_ID;
      },
    });
    await expectThrownCode(
      () => handle.markCleanupObserved(
        1,
        intent.nonce,
        {
          observationKind: "runner-observation",
          observation: accessorObservation,
        },
        noop,
      ),
      "invalid-input",
    );
    expect(runIdGets).toBe(0);
    expect(await readInventoryRaw(run)).toBe(before);
    expect(handle.snapshot().dispatches[0]!.state).toBe("intended");
  });

  test("refuses missing, duplicate, contradictory and post-cleanup advances without mutation", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    await created.markLaunched(1, intent.nonce, launchFact(run, "runtime-guards"), noop);
    await created.bindProcess(1, intent.nonce, processFact(), noop);
    await created.markPromptPending(1, intent.nonce, promptFact(), noop);

    let before = await readInventoryRaw(run);
    await expectCode(created.finalize(1, intent.nonce, terminal({ outcome: "failed" }), noop), "invalid-transition");
    expect(await readInventoryRaw(run)).toBe(before);

    const contradictory: Array<[NativeHarnessDispatchCleanupReceipt, NativeHarnessDispatchInventoryErrorCode]> = [
      [runnerCleanup({ spawnAttempted: false }), "invalid-input"],
      [runnerCleanup({ closeSeen: false, closeCode: 0 }), "invalid-input"],
      [runnerCleanup({ closeSeen: false, closeSignal: "SIGTERM" }), "invalid-input"],
      [runnerCleanup({ groupObservation: "present", groupObservedAt: null }), "invalid-input"],
      [runnerCleanup({ closeCode: 1.5 as unknown as number }), "invalid-input"],
      [runnerCleanup({ closeSignal: "SIG\u00e9" }), "invalid-input"],
      [runnerCleanup({ groupObservedAt: "2026-01-01T00:00:10Z" }), "invalid-input"],
      [runnerCleanup({ runId: "other-run" }), "invalid-input"],
      [runnerCleanup({ stage: "final" }), "invalid-input"],
      [{ observationKind: "runner-observation", observation: { ...cleanupObservation(), extra: true } } as unknown as NativeHarnessDispatchCleanupReceipt, "invalid-input"],
    ];
    for (const [receipt, code] of contradictory) {
      await expectThrownCode(
        () => created.markCleanupObserved(1, intent.nonce, receipt, noop),
        code,
      );
      expect(await readInventoryRaw(run)).toBe(before);
      expect(created.snapshot().dispatches[0]!.state).toBe("prompt-pending");
    }

    // Runner.observeGroup reports an attempted probe that threw as unknown
    // with its actual observation time; that is a valid event shape.
    const attemptedUnknown = runnerCleanup({ groupObservation: "unknown" });
    const cleaned = expectV2(await created.markCleanupObserved(1, intent.nonce, attemptedUnknown, noop));
    expect(cleaned.dispatches[0]!.state).toBe("cleanup-observed");
    expect(cleaned.dispatches[0]!.cleanup).toEqual(attemptedUnknown);
    before = await readInventoryRaw(run);
    await expectCode(created.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop), "invalid-transition");
    expect(await readInventoryRaw(run)).toBe(before);
    await expectCode(created.markLaunched(1, intent.nonce, launchFact(run, "runtime-after"), noop), "invalid-transition");
    await expectCode(created.bindProcess(1, intent.nonce, processFact(), noop), "invalid-transition");
    await expectCode(created.markPromptPending(1, intent.nonce, promptFact(), noop), "invalid-transition");
    await expectCode(
      created.finalize(1, intent.nonce, syntheticTerminal(), noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(before);

    const done = expectV2(await created.finalize(1, intent.nonce, terminal({ outcome: "cancelled" }), noop));
    expect(done.dispatches[0]!.state).toBe("terminal");
    const afterTerminal = await readInventoryRaw(run);
    await expectCode(created.finalize(1, intent.nonce, terminal({ outcome: "failed" }), noop), "invalid-transition");
    await expectCode(created.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop), "invalid-transition");
    expect(await readInventoryRaw(run)).toBe(afterTerminal);

    const syntheticRun = await makeRun();
    const synthetic = await createInventory(syntheticRun);
    const syntheticIntent = baseIntent(syntheticRun, 1);
    await synthetic.intend(syntheticIntent, noop);
    const syntheticBefore = await readInventoryRaw(syntheticRun);
    await expectThrownCode(
      () => synthetic.markCleanupObserved(1, syntheticIntent.nonce, { observationKind: "synthetic-fixture", pid: 1 } as unknown as NativeHarnessDispatchCleanupReceipt, noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(syntheticRun)).toBe(syntheticBefore);
  });

  test("keeps the original advance guard aborted while independent cleanup persists receipt and terminal", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const controller = new AbortController();
    const advanceGuard = () => {
      if (controller.signal.aborted) throw new Error("original signal aborted");
    };
    const intent = baseIntent(run, 1);
    await created.intend(intent, advanceGuard);
    await created.markLaunched(1, intent.nonce, launchFact(run, "runtime-abort"), advanceGuard);
    await created.bindProcess(1, intent.nonce, processFact(), advanceGuard);
    await created.markPromptPending(1, intent.nonce, promptFact(), advanceGuard);

    const beforeAbort = await readInventoryRaw(run);
    controller.abort();
    await expectCode(created.intend(baseIntent(run, 2), advanceGuard), "refused");
    expect(await readInventoryRaw(run)).toBe(beforeAbort);
    await expectCode(created.markPromptPending(1, intent.nonce, promptFact(), advanceGuard), "refused");
    expect(await readInventoryRaw(run)).toBe(beforeAbort);
    expect(created.snapshot().dispatches[0]!.state).toBe("prompt-pending");

    let snapshot = expectV2(await created.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop));
    expect(snapshot.dispatches[0]!.state).toBe("cleanup-observed");
    snapshot = expectV2(await created.finalize(1, intent.nonce, terminal({ outcome: "cancelled" }), noop));
    const row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.prompt).toEqual(promptFact());
    expect(row.cleanup).toEqual(runnerCleanup());
    expect(row.terminal!.usageCostUsd).toBeNull();

    const afterCleanup = await readInventoryRaw(run);
    await expectCode(created.intend(baseIntent(run, 2), advanceGuard), "refused");
    expect(await readInventoryRaw(run)).toBe(afterCleanup);
    expect(JSON.stringify(snapshot)).not.toContain("recoverable");
    expect(JSON.stringify(snapshot)).not.toContain("executable");
  });
});

describe("dispatch inventory limits and concurrency", () => {
  test("admits 32 normal v2 rows, refuses the 33rd, and refuses pathological sizes before mutation", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    for (let ordinal = 1; ordinal <= 32; ordinal += 1) {
      await created.intend(baseIntent(run, ordinal), noop);
    }
    const full = expectV2(created.snapshot());
    expect(full.revision).toBe(32);
    expect(full.dispatches.length).toBe(32);
    expect((await readInventoryJson(run)).dispatches.length).toBe(32);

    const beforeFull = await readInventoryRaw(run);
    await expectCode(created.intend(baseIntent(run, 33), noop), "exhausted");
    expect(await readInventoryRaw(run)).toBe(beforeFull);
    expect(created.snapshot()).toEqual(full);

    const largeRun = await makeRun();
    const large = `/${"a".repeat(4_090)}`;
    const firstLarge = { ...baseIntent(largeRun, 1), cwd: large, artifactDir: large };
    const largeHandle = await createInventory(largeRun);
    let lastRaw = await readInventoryRaw(largeRun);
    let failure: Error | undefined;
    for (let ordinal = 1; ordinal <= 32; ordinal += 1) {
      const before = lastRaw;
      try {
        await largeHandle.intend(
          ordinal === 1 ? firstLarge : { ...baseIntent(largeRun, ordinal), cwd: large, artifactDir: large },
          noop,
        );
        lastRaw = await readInventoryRaw(largeRun);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        expect(await readInventoryRaw(largeRun)).toBe(before);
        break;
      }
    }
    expect(failure).toBeInstanceOf(NativeHarnessDispatchInventoryError);
    expect((failure as NativeHarnessDispatchInventoryError).code).toBe("too-large");
    const largeSnapshot = expectV2(largeHandle.snapshot());
    expect(largeSnapshot.dispatches.length).toBeLessThan(32);
    expect(largeSnapshot.revision).toBe(largeSnapshot.dispatches.length);
    expect((await readInventoryJson(largeRun)).dispatches.length).toBe(largeSnapshot.dispatches.length);
    expect(largeSnapshot.dispatches.filter((row) => row.state !== "terminal").length).toBeGreaterThan(0);

    await largeHandle.markLaunched(1, firstLarge.nonce, {
      runtimeRoot: MAX_CRAFTED_RUNTIME_ROOT,
      configSha256: "f".repeat(64),
      appendixSha256: "e".repeat(64),
      effectiveTimeoutMs: 8_000,
    }, noop);
    await largeHandle.bindProcess(1, firstLarge.nonce, craftedProcess(), noop);
    await largeHandle.markPromptPending(1, firstLarge.nonce, craftedPrompt(), noop);
    await largeHandle.markCleanupObserved(1, firstLarge.nonce, runnerCleanup(), noop);
    const terminalSnapshot = expectV2(await largeHandle.finalize(
      1,
      firstLarge.nonce,
      terminal({
        outcome: "completed",
        observationKind: "runner-observation",
        resultSha256: "f".repeat(64),
        usageCostUsd: LONG_TERMINAL_USAGE_COST,
        usageEstimated: false,
      }),
      noop,
    ));
    expect(terminalSnapshot.dispatches[0]!.state).toBe("terminal");
    expect(Buffer.byteLength(await readInventoryRaw(largeRun), "utf8"))
      .toBeLessThanOrEqual(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);
  });

  test("accepts an exact last-byte v2 completion and refuses one byte past admission capacity", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    const origin = seedHandle.snapshot().origin;
    const fixed = seedHandle.snapshot().fixed;
    seedHandle.close();

    const count = 31;
    const currentRevision = Number.MAX_SAFE_INTEGER - 1;
    const completionRevision = Number.MAX_SAFE_INTEGER;
    const numericReserve = 32 - Buffer.byteLength(JSON.stringify(Number.MAX_VALUE), "utf8");

    // Codec/open evidence: an all-terminal inventory at the widest revision
    // fills the actual 256 KiB cap exactly, including negative closeCode,
    // longest signal/date, false booleans and widest numeric encodings.
    const exact = tuneCraftedCompletion(
      origin,
      fixed,
      count,
      NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
      currentRevision,
      completionRevision,
    );
    const exactText = craftedInventoryText(origin, fixed, completionRevision, exact.completed);
    await writeFile(inventoryPath(run), exactText);
    const exactHandle = await openInventory(run);
    const exactSnapshot = expectV2(exactHandle.snapshot());
    expect(Buffer.byteLength(exactText, "utf8")).toBe(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);
    expect(exactSnapshot.revision).toBe(completionRevision);
    expect(exactSnapshot.dispatches.every((candidate) => candidate.state === "terminal")).toBe(true);
    exactHandle.close();
    expect(await readInventoryRaw(run)).toBe(exactText);

    // One open row still reserves the documented arbitrary-finite-number
    // allowance when projected to its maximum terminal encoding.
    const admissionCompletionBytes = NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES - numericReserve;
    const accepted = tuneCraftedCompletion(
      origin,
      fixed,
      count,
      admissionCompletionBytes,
      currentRevision,
      completionRevision,
    );
    const acceptedCurrent = craftedInventoryText(origin, fixed, currentRevision, accepted.current);
    await writeFile(inventoryPath(run), acceptedCurrent);
    const handle = await openInventory(run);
    expect(expectV2(handle.snapshot()).revision).toBe(currentRevision);

    const beforeAdmission = await readInventoryRaw(run);
    await expectCode(handle.intend(baseIntent(run, 32), noop), "too-large");
    expect(await readInventoryRaw(run)).toBe(beforeAdmission);
    expect(expectV2(handle.snapshot()).revision).toBe(currentRevision);

    const lastNonce = accepted.current[count - 1]!.nonce;
    const finalized = expectV2(await handle.finalize(
      count,
      lastNonce,
      craftedRunnerTerminal(Number.MAX_VALUE),
      noop,
    ));
    const saved = await readInventoryRaw(run);
    expect(Buffer.byteLength(saved, "utf8")).toBe(admissionCompletionBytes);
    expect(saved).toBe(craftedInventoryText(origin, fixed, completionRevision, accepted.completed));
    expect(finalized.revision).toBe(completionRevision);
    expect(finalized.dispatches.every((candidate) => candidate.state === "terminal")).toBe(true);
    handle.close();

    const rejected = tuneCraftedCompletion(
      origin,
      fixed,
      count,
      admissionCompletionBytes + 1,
      currentRevision,
      completionRevision,
    );
    const rejectedCurrent = craftedInventoryText(origin, fixed, currentRevision, rejected.current);
    await writeFile(inventoryPath(run), rejectedCurrent);
    await expectCode(openInventory(run), "too-large");
    expect(await readInventoryRaw(run)).toBe(rejectedCurrent);
  });

  test("reserves the full pre-receipt cleanup width before any receipt is written", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    const origin = seedHandle.snapshot().origin;
    const fixed = seedHandle.snapshot().fixed;
    seedHandle.close();

    const count = 31;
    const currentRevision = Number.MAX_SAFE_INTEGER - 2;
    const completionRevision = Number.MAX_SAFE_INTEGER;
    const numericReserve = 32 - Buffer.byteLength(JSON.stringify(Number.MAX_VALUE), "utf8");
    const tightTarget = NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES - numericReserve;

    const tight = tuneCraftedPreReceipt(
      origin,
      fixed,
      count,
      tightTarget,
      currentRevision,
      completionRevision,
    );
    const tightProjected = craftedInventoryText(origin, fixed, completionRevision, tight.projected);
    expect(Buffer.byteLength(tightProjected, "utf8") + numericReserve)
      .toBe(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);
    const tightCurrent = craftedInventoryText(origin, fixed, currentRevision, tight.current);
    await writeFile(inventoryPath(run), tightCurrent);
    const handle = await openInventory(run);
    expect(expectV2(handle.snapshot()).revision).toBe(currentRevision);

    const lastNonce = tight.current[count - 1]!.nonce;
    // The actual-shaped receipt uses true for spawn/close, so it is narrower
    // than the conservative size-only projection, but the write must fit.
    await handle.markCleanupObserved(count, lastNonce, WIDE_ACTUAL_CLEANUP, noop);
    expect(expectV2(handle.snapshot()).revision).toBe(currentRevision + 1);
    await handle.finalize(count, lastNonce, craftedRunnerTerminal(Number.MAX_VALUE), noop);
    const saved = await readInventoryRaw(run);
    expect(saved).toBe(craftedInventoryText(origin, fixed, completionRevision, tight.final));
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);
    expect(expectV2(handle.snapshot()).revision).toBe(completionRevision);
    handle.close();

    // One byte past admission must refuse before any cleanup receipt write.
    const over = tuneCraftedPreReceipt(
      origin,
      fixed,
      count,
      tightTarget + 1,
      currentRevision,
      completionRevision,
    );
    const overCurrent = craftedInventoryText(origin, fixed, currentRevision, over.current);
    await writeFile(inventoryPath(run), overCurrent);
    await expectCode(openInventory(run), "too-large");
    expect(await readInventoryRaw(run)).toBe(overCurrent);
  });

  test("refuses actual run origin or fixed drift under the same short lock", async () => {
    const run = await makeRun();
    const handle = await createInventory(run);
    const intent = baseIntent(run, 1);

    const fixedDrift = JSON.parse(await readFile(runPath(run), "utf8")) as RunRecord;
    fixedDrift.config.stageTimeoutMs = 9_000;
    fixedDrift.revision += 1;
    fixedDrift.updatedAt = new Date(Date.parse(fixedDrift.updatedAt) + 1).toISOString();
    fixedDrift.recoveryOrigin!.recordIdentitySha256 = recordIdentity(fixedDrift);
    await writeFile(runPath(run), `${JSON.stringify(fixedDrift, null, 2)}\n`);
    const before = await readInventoryRaw(run);
    await expectCode(handle.intend(intent, noop), "identity-mismatch");
    expect(await readInventoryRaw(run)).toBe(before);

    const originDrift = JSON.parse(await readFile(runPath(run), "utf8")) as RunRecord;
    originDrift.config = run.record.config;
    originDrift.revision += 1;
    originDrift.recoveryOrigin!.nonce = uuid(99);
    originDrift.recoveryOrigin!.recordIdentitySha256 = recordIdentity(originDrift);
    await writeFile(runPath(run), `${JSON.stringify(originDrift, null, 2)}\n`);
    await expectCode(handle.intend(intent, noop), "identity-mismatch");
    expect(await readInventoryRaw(run)).toBe(before);
    expect(handle.snapshot().revision).toBe(0);
  });

  test("poisons when a normal post-write hook return is followed by an abort during post-write verification", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    seedHandle.close();
    let armed = false;
    let aborted = false;
    const io: NativeFileIo = {
      O_RDONLY: nodeFileIo.O_RDONLY,
      O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
      realpath: (target) => nodeFileIo.realpath(target),
      lstat: async (target, options) => {
        const info = await nodeFileIo.lstat(target, options);
        if (armed && target === run.runDir) aborted = true;
        return info;
      },
      open: (target, flags) => nodeFileIo.open(target, flags),
    };
    const handle = await openInventory(run, {
      fileIo: io,
      testAfterPrimaryWrite: () => {
        armed = true;
      },
    });
    const guard = () => {
      if (aborted) throw new Error("aborted after write");
    };
    const intent = baseIntent(run, 1);
    await expectCode(handle.intend(intent, guard), "ambiguous");
    expect(handle.snapshot().revision).toBe(0);
    const committed = await readInventoryJson(run);
    expect(committed.revision).toBe(1);
    expect(committed.dispatches[0]!.state).toBe("intended");
    await expectCode(
      handle.markLaunched(1, intent.nonce, launchFact(run, "runtime-poisoned"), noop),
      "ambiguous",
    );
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
  });

  test("poisons when the advance guard fails after the short lock releases but before final acknowledgement", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    seedHandle.close();
    let wrote = false;
    const handle = await openInventory(run, {
      testAfterPrimaryWrite: () => {
        wrote = true;
      },
    });
    const guard = () => {
      if (!wrote) return;
      if (existsSync(path.join(run.runDir, ".write.lock"))) return;
      throw new Error("aborted after short lock release");
    };
    const intent = baseIntent(run, 1);
    await expectCode(handle.intend(intent, guard), "ambiguous");
    const saved = await readInventoryRaw(run);
    const parsed = JSON.parse(saved) as { revision: number; dispatches: Array<{ state: string }> };
    expect(parsed.revision).toBe(1);
    expect(parsed.dispatches[0]!.state).toBe("intended");
    await expectCode(
      handle.markLaunched(1, intent.nonce, launchFact(run, "runtime-poisoned"), noop),
      "ambiguous",
    );
    expect(await readInventoryRaw(run)).toBe(saved);
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().dispatches[0]!.state).toBe("intended");
  });

  test("poisons when the handle closes during a normal post-write hook return", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    seedHandle.close();
    let handle: NativeHarnessDispatchInventoryHandle | undefined;
    handle = await openInventory(run, {
      testAfterPrimaryWrite: () => {
        handle!.close();
      },
    });
    const intent = baseIntent(run, 1);
    await expectCode(handle.intend(intent, noop), "ambiguous");
    const saved = await readInventoryRaw(run);
    const parsed = JSON.parse(saved) as { revision: number; dispatches: Array<{ state: string }> };
    expect(parsed.revision).toBe(1);
    expect(parsed.dispatches[0]!.state).toBe("intended");
    await expectCode(
      handle.markLaunched(1, intent.nonce, launchFact(run, "runtime-poisoned"), noop),
      "closed",
    );
    expect(await readInventoryRaw(run)).toBe(saved);
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
  });

  test("detects stale two-handle CAS on intent and cleanup without writing", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    seedHandle.close();
    const first = await openInventory(run);
    const second = await openInventory(run);
    const firstIntent = baseIntent(run, 1);
    await first.intend(firstIntent, noop);
    const afterFirst = await readInventoryRaw(run);
    expect((await readInventoryJson(run)).revision).toBe(1);

    await expectCode(second.intend(baseIntent(run, 2), noop), "conflict");
    expect(await readInventoryRaw(run)).toBe(afterFirst);
    expect((await readInventoryJson(run)).dispatches.length).toBe(1);

    await first.markLaunched(1, firstIntent.nonce, launchFact(run, "runtime-cas"), noop);
    await first.bindProcess(1, firstIntent.nonce, processFact(), noop);
    await first.markPromptPending(1, firstIntent.nonce, promptFact(), noop);
    const beforeCleanupCas = await readInventoryRaw(run);
    const cleanupFirst = await openInventory(run);
    const cleanupSecond = await openInventory(run);
    await cleanupFirst.markCleanupObserved(1, firstIntent.nonce, runnerCleanup(), noop);
    const afterCleanup = await readInventoryRaw(run);
    await expectCode(cleanupSecond.markCleanupObserved(1, firstIntent.nonce, runnerCleanup(), noop), "conflict");
    expect(await readInventoryRaw(run)).toBe(afterCleanup);
    expect(afterCleanup).not.toBe(beforeCleanupCas);
    expect((await readInventoryJson(run)).dispatches[0]!.state).toBe("cleanup-observed");
  });

  test("poisons the local handle on post-write cleanup ambiguity while preserving committed receipt bytes", async () => {
    const run = await makeRun();
    const built = await createInventory(run);
    const intent = baseIntent(run, 1);
    await built.intend(intent, noop);
    await built.markLaunched(1, intent.nonce, launchFact(run, "runtime-ambiguous-cleanup"), noop);
    await built.bindProcess(1, intent.nonce, processFact(), noop);
    await built.markPromptPending(1, intent.nonce, promptFact(), noop);
    built.close();

    const handle = await openInventory(run, {
      testAfterPrimaryWrite: () => {
        throw new Error("acknowledgement lost");
      },
    });
    const before = handle.snapshot();
    await expectCode(handle.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop), "ambiguous");
    expect(handle.snapshot()).toEqual(before);
    const committed = await readInventoryJson(run);
    expect(committed.dispatches[0]!.state).toBe("cleanup-observed");
    const raw = await readInventoryRaw(run);
    await expectCode(handle.markCleanupObserved(1, intent.nonce, runnerCleanup(), noop), "ambiguous");
    expect(await readInventoryRaw(run)).toBe(raw);

    const reopened = await openInventory(run);
    const row = expectV2(reopened.snapshot()).dispatches[0]!;
    expect(row.state).toBe("cleanup-observed");
    expect(row.cleanup).toEqual(runnerCleanup());
  });

  test("poisons the local handle on post-write ambiguity while preserving the actual committed bytes", async () => {
    const run = await makeRun();
    const seedHandle = await createInventory(run);
    seedHandle.close();
    const handle = await openInventory(run, {
      testAfterPrimaryWrite: () => {
        throw new Error("acknowledgement lost");
      },
    });
    const before = handle.snapshot();
    const intent = baseIntent(run, 1);
    await expectCode(handle.intend(intent, noop), "ambiguous");
    expect(handle.snapshot()).toEqual(before);
    const committed = await readInventoryJson(run);
    expect(committed.revision).toBe(1);
    expect(committed.dispatches[0]!.state).toBe("intended");
    const raw = await readInventoryRaw(run);

    await expectCode(handle.markLaunched(1, intent.nonce, launchFact(run, "runtime-poisoned"), noop), "ambiguous");
    expect(await readInventoryRaw(run)).toBe(raw);

    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().dispatches[0]!.state).toBe("intended");
  });

  test("stops the next write when cancellation or a deadline lands during an awaited test hook", async () => {
    for (const mode of ["cancellation", "deadline"] as const) {
      const run = await makeRun();
      const seedHandle = await createInventory(run);
      seedHandle.close();
      const controller = new AbortController();
      let expired = false;
      const handle = await openInventory(run, {
        testAfterPrimaryRead: async () => {
          if (mode === "cancellation") controller.abort();
          else expired = true;
        },
      });
      const guard = () => {
        if (mode === "cancellation" ? controller.signal.aborted : expired) {
          throw new Error(mode === "cancellation" ? "original signal aborted" : "original deadline expired");
        }
      };
      const before = await readInventoryRaw(run);
      await expectCode(handle.intend(baseIntent(run, 1), guard), "refused");
      expect(await readInventoryRaw(run)).toBe(before);
      expect(handle.snapshot().revision).toBe(0);
      expect(handle.snapshot().dispatches).toEqual([]);

      const reopened = await openInventory(run);
      await reopened.intend(baseIntent(run, 1), noop);
      expect(reopened.snapshot().dispatches.length).toBe(1);
    }
  });
});
