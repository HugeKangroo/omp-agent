import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
  NativeHarnessDispatchInventoryError,
  type NativeHarnessDispatchInventoryErrorCode,
  createNativeHarnessDispatchInventory,
  openNativeHarnessDispatchInventory,
  type NativeHarnessDispatchIntent,
  type NativeHarnessDispatchInventoryHandle,
  type NativeHarnessDispatchProcess,
  type NativeHarnessDispatchRow,
  type NativeHarnessDispatchTerminal,
} from "../../src/native-harness-dispatch-inventory.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import type {
  RunRecord,
  RunRecoveryOrigin,
  RunRecoverySeed,
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
  revision: number;
  dispatches: Array<Record<string, unknown>>;
}> {
  return JSON.parse(await readInventoryRaw(run)) as {
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

function terminal(overrides: Partial<NativeHarnessDispatchTerminal> = {}): NativeHarnessDispatchTerminal {
  return {
    outcome: "cancelled",
    observationKind: "synthetic-fixture",
    observedAt: ADMITTED_AT + 20_000,
    resultSha256: null,
    usageCostUsd: null,
    usageEstimated: true,
    ...overrides,
  };
}

const LONG_TERMINAL_USAGE_COST = 0.0000010000000000000002;
const MAX_CRAFTED_RUNTIME_ROOT = `/${"\\".repeat(1_023)}`;

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

function craftedSyntheticTerminal(ordinal: number, cwdBytes: number, artifactDirBytes: number, origin: RunRecoveryOrigin) {
  return {
    ...craftedBaseFacts(ordinal, cwdBytes, artifactDirBytes, origin),
    state: "terminal" as const,
    terminal: {
      outcome: "completed" as const,
      observationKind: "synthetic-fixture" as const,
      observedAt: Number.MAX_SAFE_INTEGER,
      resultSha256: "f".repeat(64),
      usageCostUsd: LONG_TERMINAL_USAGE_COST,
      usageEstimated: false,
    },
  };
}

function craftedLaunch() {
  return { runtimeRoot: MAX_CRAFTED_RUNTIME_ROOT };
}

function craftedProcess() {
  return { pid: Number.MAX_SAFE_INTEGER, pgid: Number.MAX_SAFE_INTEGER, identitySha256: "f".repeat(64) };
}

function craftedPrompt() {
  return { promptSha256: "f".repeat(64), effectiveTimeoutMs: 8_000 };
}

function craftedRunnerTerminal() {
  return {
    outcome: "completed" as const,
    observationKind: "runner-observation" as const,
    observedAt: Number.MAX_SAFE_INTEGER,
    resultSha256: "f".repeat(64),
    usageCostUsd: LONG_TERMINAL_USAGE_COST,
    usageEstimated: false,
  };
}

function craftedOpenRow(ordinal: number, cwdBytes: number, artifactDirBytes: number, origin: RunRecoveryOrigin) {
  return {
    ...craftedBaseFacts(ordinal, cwdBytes, artifactDirBytes, origin),
    state: "prompt-pending" as const,
    launch: craftedLaunch(),
    process: craftedProcess(),
    prompt: craftedPrompt(),
  };
}

function craftedCompletedOpenRow(
  ordinal: number,
  cwdBytes: number,
  artifactDirBytes: number,
  origin: RunRecoveryOrigin,
) {
  return {
    ...craftedBaseFacts(ordinal, cwdBytes, artifactDirBytes, origin),
    state: "terminal" as const,
    launch: craftedLaunch(),
    process: craftedProcess(),
    prompt: craftedPrompt(),
    terminal: craftedRunnerTerminal(),
  };
}

function craftedInventoryText(
  origin: RunRecoveryOrigin,
  fixed: { readonly stageTimeoutMs: number; readonly maxDurationMs: number; readonly maxCostUsd: number },
  revision: number,
  dispatches: readonly NativeHarnessDispatchRow[],
): string {
  return `${JSON.stringify({
    schema: NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
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
    craftedSyntheticTerminal(index + 1, root.cwd, root.artifactDir, origin));
  const last = roots[count - 1]!;
  rows.push(completed
    ? craftedCompletedOpenRow(count, last.cwd, last.artifactDir, origin)
    : craftedOpenRow(count, last.cwd, last.artifactDir, origin));
  return rows;
}

function tuneCraftedCompletion(
  origin: RunRecoveryOrigin,
  fixed: { readonly stageTimeoutMs: number; readonly maxDurationMs: number; readonly maxCostUsd: number },
  count: number,
  targetBytes: number,
  completionRevision: number,
): {
  readonly current: NativeHarnessDispatchRow[];
  readonly completed: NativeHarnessDispatchRow[];
} {
  const roots = Array.from({ length: count }, () => ({ cwd: 3_700, artifactDir: 3_700 }));
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
  return {
    current: craftedRows(roots, origin, false),
    completed: craftedRows(roots, origin, true),
  };
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

describe("dispatch inventory genesis binding", () => {
  test("creates only for the exact actual recovery-origin run and reopens the same frozen facts", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const snapshot = created.snapshot();
    expect(snapshot.schema).toBe("omp-agent.native-harness-dispatch-inventory.v1");
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
    const parsed = JSON.parse(raw) as { origin: unknown; revision: number; dispatches: unknown[] };
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

describe("dispatch inventory lifecycle", () => {
  test("appends immutable facts, advances legally, and preserves all prior attempts", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const firstIntent = baseIntent(run, 1);

    let snapshot = await created.intend(firstIntent, noop);
    const intended = snapshot.dispatches[0]!;
    const immutable = immutableFacts(intended);
    expect(intended.state).toBe("intended");
    expect(intended.outerDeadlineAt).toBe(DEADLINE_AT);
    expect(intended.innerDeadlineAt).toBe(firstIntent.innerDeadlineAt);
    expect(intended.requestTimeoutMs).toBe(8_000);
    expect(intended.stageAllocatedCostUsd).toBe(0.1);

    snapshot = await created.markLaunched(1, firstIntent.nonce, path.join(run.root, "runtime-1"), noop);
    expect(snapshot.dispatches[0]!.state).toBe("launch-pending");
    expect(immutableFacts(snapshot.dispatches[0]!)).toEqual(immutable);

    snapshot = await created.bindProcess(1, firstIntent.nonce, processFact(), noop);
    expect(snapshot.dispatches[0]!.state).toBe("process-bound");
    expect(immutableFacts(snapshot.dispatches[0]!)).toEqual(immutable);

    snapshot = await created.markPromptPending(
      1,
      firstIntent.nonce,
      { promptSha256: HASH_D, effectiveTimeoutMs: 5_000 },
      noop,
    );
    expect(snapshot.dispatches[0]!.state).toBe("prompt-pending");
    expect(immutableFacts(snapshot.dispatches[0]!)).toEqual(immutable);

    snapshot = await created.finalize(
      1,
      firstIntent.nonce,
      terminal({
        outcome: "completed",
        observationKind: "runner-observation",
        resultSha256: HASH_E,
        usageCostUsd: 0.05,
        usageEstimated: false,
      }),
      noop,
    );
    const firstRow = snapshot.dispatches[0]!;
    expect(firstRow.state).toBe("terminal");
    expect(firstRow.launch).toEqual({ runtimeRoot: path.join(run.root, "runtime-1") });
    expect(firstRow.process).toEqual(processFact());
    expect(firstRow.prompt).toEqual({ promptSha256: HASH_D, effectiveTimeoutMs: 5_000 });
    expect(firstRow.terminal).toEqual(terminal({
      outcome: "completed",
      observationKind: "runner-observation",
      resultSha256: HASH_E,
      usageCostUsd: 0.05,
      usageEstimated: false,
    }));
    expect(immutableFacts(firstRow)).toEqual(immutable);
    expect(firstRow.outerDeadlineAt).toBe(DEADLINE_AT);
    expect(firstRow.innerDeadlineAt).toBe(firstIntent.innerDeadlineAt);
    expect(firstRow.requestTimeoutMs).toBe(8_000);
    expect(firstRow.stageAllocatedCostUsd).toBe(0.1);

    const secondIntent = baseIntent(run, 2);
    snapshot = await created.intend(secondIntent, noop);
    snapshot = await created.finalize(secondIntent.ordinal, secondIntent.nonce, terminal(), noop);
    const thirdIntent = baseIntent(run, 3);
    snapshot = await created.intend(thirdIntent, noop);

    expect(snapshot.dispatches.map((row) => [row.ordinal, row.attempt, row.state])).toEqual([
      [1, 1, "terminal"],
      [2, 2, "terminal"],
      [3, 3, "intended"],
    ]);
    expect(snapshot.dispatches[0]).toEqual(firstRow);
    expect(snapshot.origin).toEqual(run.record.recoveryOrigin!);
    expect(snapshot.fixed).toEqual({ stageTimeoutMs: 10_000, maxDurationMs: 60_000, maxCostUsd: 0.5 });

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
    const snapshot = await created.intend(intent, noop);
    expect(snapshot.dispatches[0]!.outerDeadlineAt).toBe(DEADLINE_AT);
    expect(snapshot.dispatches[0]!.innerDeadlineAt).toBe(exactInner);

    const before = await readInventoryRaw(run);
    await expectCode(
      created.intend({ ...baseIntent(run, 2), innerDeadlineAt: exactInner + 1 }, noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(before);
  });

  test("finalizes after launch without inventing a PID and refuses fake completion", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    let snapshot = await created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-unknown"), noop);
    const before = snapshot.revision;
    await expectCode(
      created.finalize(
        1,
        intent.nonce,
        terminal({
          outcome: "completed",
          observationKind: "runner-observation",
          resultSha256: HASH_E,
          usageCostUsd: 0.02,
          usageEstimated: false,
        }),
        noop,
      ),
      "invalid-transition",
    );
    expect(created.snapshot().revision).toBe(before);
    expect(created.snapshot().dispatches[0]!.state).toBe("launch-pending");

    snapshot = await created.finalize(1, intent.nonce, terminal(), noop);
    const row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.launch).toEqual({ runtimeRoot: path.join(run.root, "runtime-unknown") });
    expect(row.process).toBeUndefined();
    expect(row.prompt).toBeUndefined();
    expect(row.terminal).toEqual(terminal());
    expect(JSON.stringify(row)).not.toContain('"pid"');
  });

  test("permits explicit synthetic completion without inventing process facts", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    const before = await readInventoryRaw(run);
    await expectCode(
      created.finalize(
        1,
        intent.nonce,
        terminal({
          outcome: "completed",
          observationKind: "runner-observation",
          resultSha256: HASH_E,
          usageCostUsd: 0.02,
          usageEstimated: false,
        }),
        noop,
      ),
      "invalid-transition",
    );
    expect(await readInventoryRaw(run)).toBe(before);
    expect(created.snapshot().dispatches[0]!.state).toBe("intended");

    const snapshot = await created.finalize(
      1,
      intent.nonce,
      terminal({
        outcome: "completed",
        observationKind: "synthetic-fixture",
        resultSha256: HASH_E,
        usageCostUsd: 0.02,
        usageEstimated: false,
      }),
      noop,
    );
    const row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.launch).toBeUndefined();
    expect(row.process).toBeUndefined();
    expect(row.prompt).toBeUndefined();
    expect(row.terminal?.observationKind).toBe("synthetic-fixture");
    expect(row.terminal?.outcome).toBe("completed");

    const reopened = await openInventory(run);
    expect(reopened.snapshot().dispatches[0]!.state).toBe("terminal");
    expect(reopened.snapshot().dispatches[0]!.process).toBeUndefined();
  });

  test("refuses skipped, duplicate, conflicting and malformed transitions before mutation", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const intent = baseIntent(run, 1);
    await created.intend(intent, noop);
    const afterIntent = created.snapshot();
    const rawAfterIntent = await readInventoryRaw(run);

    await expectCode(created.bindProcess(1, intent.nonce, processFact(), noop), "invalid-transition");
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    await expectCode(created.markLaunched(1, uuid(77), path.join(run.root, "runtime-wrong"), noop), "conflict");
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    const asyncGuard = (() => Promise.resolve()) as unknown as () => void;
    await expectCode(created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-async"), asyncGuard), "invalid-input");
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    const masked = Promise.resolve();
    Object.defineProperty(masked, "then", { value: undefined });
    await expectCode(
      created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-masked"), () => masked),
      "invalid-input",
    );
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    const rejected = Promise.reject(new Error("guard rejected"));
    await expectCode(
      created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-rejected"), () => rejected),
      "invalid-input",
    );
    await Promise.resolve();
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    let thenCalls = 0;
    const foreignThenable = { then: () => { thenCalls += 1; } };
    await expectCode(
      created.markLaunched(
        1,
        intent.nonce,
        path.join(run.root, "runtime-thenable"),
        (() => foreignThenable) as unknown as () => void,
      ),
      "invalid-input",
    );
    expect(thenCalls).toBe(0);
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    await expectCode(
      created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-throw"), () => {
        throw new Error("original deadline expired");
      }),
      "refused",
    );
    expect(created.snapshot()).toEqual(afterIntent);
    expect(await readInventoryRaw(run)).toBe(rawAfterIntent);

    let snapshot = await created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-ok"), noop);
    const afterLaunch = snapshot.revision;
    await expectCode(created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-again"), noop), "invalid-transition");
    expect(created.snapshot().revision).toBe(afterLaunch);

    snapshot = await created.bindProcess(1, intent.nonce, processFact(), noop);
    const afterProcess = snapshot.revision;
    await expectCode(
      created.finalize(
        1,
        intent.nonce,
        terminal({
          outcome: "completed",
          observationKind: "runner-observation",
          resultSha256: HASH_E,
          usageCostUsd: 0.02,
          usageEstimated: false,
        }),
        noop,
      ),
      "invalid-transition",
    );
    expect(created.snapshot().revision).toBe(afterProcess);
    await expectCode(
      created.markPromptPending(1, intent.nonce, { promptSha256: HASH_D, effectiveTimeoutMs: 8_001 }, noop),
      "invalid-input",
    );
    expect(created.snapshot().revision).toBe(afterProcess);
    expect(created.snapshot().dispatches[0]!.prompt).toBeUndefined();

    snapshot = await created.markPromptPending(
      1,
      intent.nonce,
      { promptSha256: HASH_D, effectiveTimeoutMs: 5_000 },
      noop,
    );
    const finalSnapshot = await created.finalize(1, intent.nonce, terminal(), noop);
    expect(finalSnapshot.dispatches[0]!.state).toBe("terminal");
    await expectCode(created.finalize(1, intent.nonce, terminal({ outcome: "failed" }), noop), "invalid-transition");

    const rawAfterTerminal = await readInventoryRaw(run);
    await expectCode(
      created.intend({ ...baseIntent(run, 2), requestTimeoutMs: 10_001 }, noop),
      "invalid-input",
    );
    expect(await readInventoryRaw(run)).toBe(rawAfterTerminal);
  });

  test("records terminal cleanup after original abort without granting a next execution", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    const controller = new AbortController();
    const advanceGuard = () => {
      if (controller.signal.aborted) throw new Error("original signal aborted");
    };
    const intent = baseIntent(run, 1);
    await created.intend(intent, advanceGuard);
    await created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-abort"), advanceGuard);
    await created.bindProcess(1, intent.nonce, processFact(), advanceGuard);
    await created.markPromptPending(
      1,
      intent.nonce,
      { promptSha256: HASH_D, effectiveTimeoutMs: 4_000 },
      advanceGuard,
    );

    const beforeAbort = await readInventoryRaw(run);
    controller.abort();
    await expectCode(created.intend(baseIntent(run, 2), advanceGuard), "refused");
    expect(await readInventoryRaw(run)).toBe(beforeAbort);
    await expectCode(
      created.markPromptPending(
        1,
        intent.nonce,
        { promptSha256: HASH_D, effectiveTimeoutMs: 4_000 },
        advanceGuard,
      ),
      "refused",
    );
    expect(await readInventoryRaw(run)).toBe(beforeAbort);
    expect(created.snapshot().dispatches[0]!.state).toBe("prompt-pending");

    const snapshot = await created.finalize(1, intent.nonce, terminal(), noop);
    const row = snapshot.dispatches[0]!;
    expect(row.state).toBe("terminal");
    expect(row.prompt).toEqual({ promptSha256: HASH_D, effectiveTimeoutMs: 4_000 });
    expect(row.terminal).toEqual(terminal());
    expect(row.terminal!.usageCostUsd).toBeNull();

    const afterCleanup = await readInventoryRaw(run);
    await expectCode(created.intend(baseIntent(run, 2), advanceGuard), "refused");
    expect(await readInventoryRaw(run)).toBe(afterCleanup);
    await expectCode(created.markLaunched(1, intent.nonce, path.join(run.root, "runtime-next"), noop), "invalid-transition");
    await expectCode(created.finalize(1, intent.nonce, terminal({ outcome: "failed" }), noop), "invalid-transition");
    expect(Object.keys(snapshot).sort()).toEqual([
      "dispatches",
      "fixed",
      "origin",
      "revision",
      "runId",
      "schema",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("recoverable");
    expect(JSON.stringify(snapshot)).not.toContain("executable");
  });
});

describe("dispatch inventory limits and concurrency", () => {
  test("admits 32 normal rows, refuses the 33rd, and refuses pathological sizes before mutation", async () => {
    const run = await makeRun();
    const created = await createInventory(run);
    for (let ordinal = 1; ordinal <= 32; ordinal += 1) {
      await created.intend(baseIntent(run, ordinal), noop);
    }
    const full = created.snapshot();
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
    const largeSnapshot = largeHandle.snapshot();
    expect(largeSnapshot.dispatches.length).toBeLessThan(32);
    expect(largeSnapshot.revision).toBe(largeSnapshot.dispatches.length);
    expect((await readInventoryJson(largeRun)).dispatches.length).toBe(largeSnapshot.dispatches.length);
    const openRows = largeSnapshot.dispatches.filter((row) => row.state !== "terminal").length;
    expect(openRows).toBeGreaterThan(0);
    expect(Buffer.byteLength(lastRaw, "utf8")).toBeGreaterThan(150_000);
    // A previous full-reserve-per-open-row check would now reject even though
    // each open row can still reach its maximum legal terminal encoding.
    expect(Buffer.byteLength(lastRaw, "utf8") + openRows * 4_096)
      .toBeGreaterThan(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);

    const maxRuntimeRoot = `/${"\\".repeat(1_023)}`;
    await largeHandle.markLaunched(1, firstLarge.nonce, maxRuntimeRoot, noop);
    await largeHandle.bindProcess(1, firstLarge.nonce, {
      pid: Number.MAX_SAFE_INTEGER,
      pgid: Number.MAX_SAFE_INTEGER,
      identitySha256: "f".repeat(64),
    }, noop);
    await largeHandle.markPromptPending(1, firstLarge.nonce, {
      promptSha256: "f".repeat(64),
      effectiveTimeoutMs: 8_000,
    }, noop);
    const terminalSnapshot = await largeHandle.finalize(
      1,
      firstLarge.nonce,
      terminal({
        outcome: "completed",
        observationKind: "runner-observation",
        resultSha256: "f".repeat(64),
        usageCostUsd: 0.1,
        usageEstimated: false,
      }),
      noop,
    );
    expect(terminalSnapshot.dispatches[0]!.state).toBe("terminal");
    expect(Buffer.byteLength(await readInventoryRaw(largeRun), "utf8"))
      .toBeLessThanOrEqual(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES);
  });

  test("reserves the longest legal terminal value and refuses one byte past the capacity boundary", async () => {
    const run = await makeRun();
    const seed = await createInventory(run);
    const origin = seed.snapshot().origin;
    const fixed = seed.snapshot().fixed;
    seed.close();

    const count = 31;
    const currentRevision = 9;
    const completionRevision = 10;
    // The reservation includes 14 bytes for the widest possible revision
    // (16 digits instead of 2) and 8 bytes for the longest numeric encoding.
    const acceptedCompletionBytes = NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES - 22;
    const accepted = tuneCraftedCompletion(
      origin,
      fixed,
      count,
      acceptedCompletionBytes,
      completionRevision,
    );
    const acceptedCurrent = craftedInventoryText(origin, fixed, currentRevision, accepted.current);
    await writeFile(inventoryPath(run), acceptedCurrent);
    const handle = await openInventory(run);
    expect(handle.snapshot().revision).toBe(currentRevision);

    const beforeAdmission = await readInventoryRaw(run);
    await expectCode(handle.intend(baseIntent(run, 32), noop), "too-large");
    expect(await readInventoryRaw(run)).toBe(beforeAdmission);
    expect(handle.snapshot().revision).toBe(currentRevision);

    const lastNonce = accepted.current[count - 1]!.nonce;
    const finalized = await handle.finalize(
      count,
      lastNonce,
      craftedRunnerTerminal(),
      noop,
    );
    const saved = await readInventoryRaw(run);
    expect(Buffer.byteLength(saved, "utf8")).toBe(acceptedCompletionBytes);
    expect(Buffer.byteLength(saved, "utf8")).toBeGreaterThan(NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES - 32);
    expect(saved).toBe(craftedInventoryText(origin, fixed, completionRevision, accepted.completed));
    expect(finalized.revision).toBe(completionRevision);
    expect(finalized.dispatches.every((row) => row.state === "terminal")).toBe(true);
    handle.close();

    const rejectedCompletionBytes = NATIVE_HARNESS_DISPATCH_INVENTORY_MAX_BYTES + 1;
    const rejected = tuneCraftedCompletion(
      origin,
      fixed,
      count,
      rejectedCompletionBytes,
      completionRevision,
    );
    const rejectedCurrent = craftedInventoryText(origin, fixed, currentRevision, rejected.current);
    await writeFile(inventoryPath(run), rejectedCurrent);
    await expectCode(openInventory(run), "too-large");
    expect(await readInventoryRaw(run)).toBe(rejectedCurrent);
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
    const seed = await createInventory(run);
    seed.close();
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
      handle.markLaunched(1, intent.nonce, path.join(run.root, "runtime-poisoned"), noop),
      "ambiguous",
    );
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
  });

  test("poisons when the advance guard fails after the short lock releases but before final acknowledgement", async () => {
    const run = await makeRun();
    const seed = await createInventory(run);
    seed.close();
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
      handle.markLaunched(1, intent.nonce, path.join(run.root, "runtime-poisoned"), noop),
      "ambiguous",
    );
    expect(await readInventoryRaw(run)).toBe(saved);
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().dispatches[0]!.state).toBe("intended");
  });

  test("poisons when the handle closes during a normal post-write hook return", async () => {
    const run = await makeRun();
    const seed = await createInventory(run);
    seed.close();
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
      handle.markLaunched(1, intent.nonce, path.join(run.root, "runtime-poisoned"), noop),
      "closed",
    );
    expect(await readInventoryRaw(run)).toBe(saved);
    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
  });

  test("detects stale two-handle CAS and same-revision changed bytes without writing", async () => {
    const run = await makeRun();
    const seed = await createInventory(run);
    seed.close();
    const first = await openInventory(run);
    const second = await openInventory(run);
    const firstIntent = baseIntent(run, 1);
    await first.intend(firstIntent, noop);
    const afterFirst = await readInventoryRaw(run);
    expect((await readInventoryJson(run)).revision).toBe(1);

    await expectCode(second.intend(baseIntent(run, 2), noop), "conflict");
    expect(await readInventoryRaw(run)).toBe(afterFirst);
    expect((await readInventoryJson(run)).dispatches.length).toBe(1);

    const third = await openInventory(run);
    const parsed = JSON.parse(afterFirst) as {
      dispatches: Array<{ innerDeadlineAt: number }>;
    };
    parsed.dispatches[0]!.innerDeadlineAt += 1;
    await writeFile(inventoryPath(run), `${JSON.stringify(parsed, null, 2)}\n`);
    const altered = await readInventoryRaw(run);
    await expectCode(third.intend(baseIntent(run, 2), noop), "changed");
    expect(await readInventoryRaw(run)).toBe(altered);
    expect((await readInventoryJson(run)).dispatches.length).toBe(1);
  });

  test("poisons the local handle on post-write ambiguity while preserving the actual committed bytes", async () => {
    const run = await makeRun();
    const seed = await createInventory(run);
    seed.close();
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

    await expectCode(handle.markLaunched(1, intent.nonce, path.join(run.root, "runtime-poisoned"), noop), "ambiguous");
    expect(await readInventoryRaw(run)).toBe(raw);

    const reopened = await openInventory(run);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().dispatches[0]!.state).toBe("intended");
  });

  test("stops the next write when cancellation or a deadline lands during an awaited test hook", async () => {
    for (const mode of ["cancellation", "deadline"] as const) {
      const run = await makeRun();
      const seed = await createInventory(run);
      seed.close();
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
