import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  createNativeHarnessAccountingOwner,
} from "../../src/native-harness-accounting.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  createNativeHarnessDispatchInventory,
  type NativeHarnessDispatchInventoryHandle,
  type NativeHarnessDispatchIntent,
} from "../../src/native-harness-dispatch-inventory.ts";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
  prepareNativeHarnessRecoverySource,
  type PreparedRecoverySource,
  type SourceInput,
} from "../../src/native-harness-recovery-source.ts";
import {
  prepareNativeHarnessWorkspace,
  type NativeHarnessWorkspaceDescriptor,
} from "../../src/native-harness-workspace.ts";
import {
  NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS,
  NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES,
  NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA,
  planNativeHarnessReconciliationContent,
  type NativeHarnessReconciliationContentInput,
  type NativeHarnessReconciliationContentPlan,
  type NativeHarnessReconciliationContentPlanResult,
} from "../../src/native-harness-reconciliation-content.ts";
import {
  observeNativeHarnessReconciliationContent,
} from "../../src/native-harness-reconciliation-files.ts";
import type { NativeHarnessReconciliationExpectation } from "../../src/native-harness-reconciliation.ts";
import {
  observeNativeHarnessReconciliationContentBytes,
  type NativeHarnessOutputFailure,
  type NativeHarnessReconciliationContentByteResult,
} from "../../src/native-harness-output.ts";
import { copyWitnessBase } from "../../src/native-harness-completion.ts";
import { canonicalWorkerResultSha256 } from "../../src/native-harness-delegation.ts";
import {
  nodeFileIo,
  sha256Hex,
  type NativeFileHandle,
  type NativeFileIo,
} from "../../src/native-work.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import { captureSnapshot, diffWorkspace, materializeSnapshot } from "../../vendor/harness2/upstream/src/workspace.ts";
import type {
  RunRecord,
  RunRecoverySeed,
  StageId,
  StageRecord,
  WorkerResult,
  WorkspaceSnapshot,
} from "../../vendor/harness2/upstream/src/types.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const SELECTOR = "c".repeat(64);
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ADMITTED_AT = 1_700_000_000_123;
const SOURCE_DURATION_MS = 300_000;
const RUN_DURATION_MS = 120_000;
const MAX_COST_USD = 0.25;
const STAGE_ALLOCATED_USD = 0.1;
const CREATED_AT = new Date(ADMITTED_AT + 1_000).toISOString();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SOURCE_ID = (JSON.parse(
  readFileSync(new URL("../../vendor/harness2/SOURCE.json", import.meta.url), "utf8"),
) as { sourceId: string }).sourceId;
const SOURCE_TEXT = "hello from r2b2c1 content\n";
const CONTENT_CHARGE_LIMIT =
  2 * (2 * 256 * 1024 + 8 * (1024 * 1024 + 256 * 1024) + 8 * 16 * 1024) + 2 * 64 * 1024 * 1024;

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface StageFixture {
  readonly stage: StageId;
  readonly solver: boolean;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly tracePath: string;
  readonly result: WorkerResult;
  readonly artifactHash: string | null;
  readonly traceHash: string;
}

interface ContentFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly sourcePath: string;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
  readonly prepared: PreparedRecoverySource;
  readonly runDir: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly snapshotSha256: string;
  readonly stages: ReadonlyMap<StageId, StageFixture>;
  readonly runText: string;
  readonly sourceText: string;
  readonly inventoryText: string;
  readonly ownerText: string;
  readonly expected: NativeHarnessReconciliationExpectation;
  readonly now: number;
}

function associationDocument(descriptor: NativeHarnessWorkspaceDescriptor): {
  observationId: string;
  generation: number;
  sessionId: string;
  workspaceRoot: string;
  toolCallId: string;
  toolName: "agent_harness";
} {
  return {
    observationId: "observation-r2b2c1-content",
    generation: 1,
    sessionId: "session-r2b2c1-content",
    workspaceRoot: descriptor.sourceRoot,
    toolCallId: "call-r2b2c1-content",
    toolName: "agent_harness",
  };
}

function associationDigest(descriptor: NativeHarnessWorkspaceDescriptor): string {
  return sha256Hex(JSON.stringify(associationDocument(descriptor)));
}

function limitsText(): string {
  return JSON.stringify({
    maxRetainedOperations: 16,
    maxConcurrent: 1,
    perRunUsd: MAX_COST_USD,
    lifetimeUsd: 5,
    maxDurationMs: SOURCE_DURATION_MS,
    cleanupGraceMs: 40,
  });
}

function seed(descriptor: NativeHarnessWorkspaceDescriptor, prepared: PreparedRecoverySource): RunRecoverySeed {
  return {
    schema: "omp-agent.native-harness-recovery-seed.v1",
    profile: "native-auto-scoped-files.v1",
    accountingOwnerId: OWNER_ID,
    admissionId: ADMISSION_ID,
    accountingOwnerRevision: 1,
    sourceAssociationSha256: associationDigest(descriptor),
    sourceDescriptorSha256: prepared.source.sha256,
    inputManifestSha256: descriptor.manifestSha256,
    admittedAt: ADMITTED_AT,
    deadlineAt: ADMITTED_AT + SOURCE_DURATION_MS,
    allocatedCostUsd: MAX_COST_USD,
  };
}

function runRecord(descriptor: NativeHarnessWorkspaceDescriptor): RunRecord {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    workspace: descriptor.workspaceRoot,
    task: "r2b2c1 content fixture task",
    config: {
      mode: "product",
      strategy: "auto",
      model: "deepseek/deepseek-flash",
      improverModel: "deepseek/deepseek-flash",
      maxCostUsd: MAX_COST_USD,
      maxDurationMs: RUN_DURATION_MS,
      stageTimeoutMs: RUN_DURATION_MS,
      domain: "generic",
      ompCommand: process.execPath,
      adaptation: { capabilities: "fixed", reuse: false, learnMethods: false },
    },
    status: "queued",
    baseHarness: {
      schemaVersion: 1,
      id: "r2b2c1-content-fixture-harness",
      promptAppend: "",
      toolGuidance: "",
      rationale: "",
      skills: [],
    },
    libraryEntries: [],
    stages: {},
  };
}

function transition(action: Record<string, unknown>): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    ...action,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

const STAGE_SPECS: readonly { readonly stage: StageId; readonly solver: boolean; readonly attempt: number }[] = [
  { stage: "baseline", solver: true, attempt: 2 },
  { stage: "inv_edit", solver: false, attempt: 1 },
  { stage: "dom_edit", solver: false, attempt: 1 },
  { stage: "inv_probe", solver: true, attempt: 1 },
  { stage: "dom_probe", solver: true, attempt: 1 },
  { stage: "compose_edit", solver: false, attempt: 1 },
  { stage: "final", solver: true, attempt: 1 },
  { stage: "select", solver: false, attempt: 1 },
  { stage: "reflect", solver: false, attempt: 1 },
];

function attemptLayout(runDir: string, stage: StageId, attempt: number): {
  readonly attemptDir: string;
  readonly cwd: string;
  readonly artifactDir: string;
} {
  const attemptDir = path.join(runDir, "stages", stage, `attempt-${attempt}-${randomUUID()}`);
  return {
    attemptDir,
    cwd: path.join(attemptDir, "workspace"),
    artifactDir: path.join(attemptDir, "artifacts"),
  };
}

function workerResult(eventsPath: string, endedAt: string): WorkerResult {
  return {
    // Fixture result text only; never returned by the planner or byte observer.
    text: `fixture completed result for ${path.basename(path.dirname(path.dirname(eventsPath)))}`,
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
    startedAt: endedAt,
    endedAt,
    eventsPath,
    status: "completed",
    usageEstimated: false,
  };
}

function cleanupObservation(stage: StageId): {
  type: "cleanupObserved";
  runId: string;
  stage: StageId;
  spawnAttempted: true;
  closeSeen: true;
  closeCode: number;
  closeSignal: null;
  groupObservation: "not-observed";
  groupObservedAt: string;
  hostWorkSettled: true;
  approvalWorkSettled: true;
  logFlush: "success";
} {
  return {
    type: "cleanupObserved",
    runId: RUN_ID,
    stage,
    spawnAttempted: true,
    closeSeen: true,
    closeCode: 0,
    closeSignal: null,
    groupObservation: "not-observed",
    groupObservedAt: CREATED_AT,
    hostWorkSettled: true,
    approvalWorkSettled: true,
    logFlush: "success",
  };
}

async function intend(
  inventory: NativeHarnessDispatchInventoryHandle,
  ordinal: number,
  stage: StageId,
  attempt: number,
  cwd: string,
  artifactDir: string,
  runRevision: number,
  innerDeadlineAt: number,
  snapshotSha256: string,
): Promise<string> {
  const nonce = randomUUID();
  const intent: NativeHarnessDispatchIntent = {
    ordinal,
    nonce,
    stage,
    attempt,
    runRevision,
    cwd,
    artifactDir,
    intentSha256: sha256Hex(`fixture-intent-${ordinal}`),
    snapshotSha256,
    innerDeadlineAt,
    requestTimeoutMs: 10_000,
    stageAllocatedCostUsd: STAGE_ALLOCATED_USD,
  };
  await inventory.intend(intent, () => undefined);
  return nonce;
}

async function terminalizeRunnerFixture(
  inventory: NativeHarnessDispatchInventoryHandle,
  ordinal: number,
  nonce: string,
  stage: StageId,
  result: WorkerResult,
): Promise<void> {
  // Explicit deterministic fixture lifecycle through the original inventory
  // APIs. This is not actual worker/process qualification; terminal is tagged
  // runner-observation so the supported content path is exercised, not relaxed.
  await inventory.markLaunched(ordinal, nonce, {
    runtimeRoot: path.join(process.cwd(), "fixture-runtime", `${stage}-${ordinal}-${randomUUID()}`),
    configSha256: HASH_A,
    appendixSha256: HASH_B,
    effectiveTimeoutMs: 10_000,
  }, () => undefined);
  await inventory.bindProcess(ordinal, nonce, {
    pid: process.pid,
    pgid: process.pid,
    identitySha256: HASH_A,
  }, () => undefined);
  await inventory.markPromptPending(ordinal, nonce, {
    promptSha256: HASH_B,
    promptBytes: 32,
    effectiveTimeoutMs: 10_000,
  }, () => undefined);
  await inventory.markCleanupObserved(ordinal, nonce, {
    observationKind: "runner-observation",
    observation: cleanupObservation(stage),
  }, () => undefined);
  await inventory.finalize(ordinal, nonce, {
    outcome: "completed",
    observationKind: "runner-observation",
    observedAt: Date.parse(result.endedAt),
    resultSha256: canonicalWorkerResultSha256(result),
    usageCostUsd: result.usage.costUsd,
    usageEstimated: false,
  }, () => undefined);
}

async function makeFixture(sourceFiles: readonly string[] = ["hello.txt"]): Promise<ContentFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2b2c1-content-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await mkdir(sourceRoot, { mode: 0o755 });
  await mkdir(storageRoot, { mode: 0o700 });
  const sourcePath = path.join(sourceRoot, sourceFiles[0]!);
  for (const sourceFile of sourceFiles) {
    await writeFile(
      path.join(sourceRoot, sourceFile),
      sourceFile === "hello.txt" ? SOURCE_TEXT : `${sourceFile} content\n`,
      "utf8",
    );
  }
  const descriptor = await prepareNativeHarnessWorkspace(
    { sourceRoot, storageRoot, inputFiles: sourceFiles },
    () => undefined,
    new AbortController().signal,
  );
  const sourceInput: SourceInput = {
    storageRoot,
    descriptor,
    association: associationDocument(descriptor),
    accounting: {
      ownerId: OWNER_ID,
      admissionId: ADMISSION_ID,
      reserveRevision: 1,
      sourceAssociationSha256: associationDigest(descriptor),
      admittedAt: ADMITTED_AT,
    },
    budget: {
      maxCostUsd: MAX_COST_USD,
      deadlineAt: ADMITTED_AT + SOURCE_DURATION_MS,
      maxDurationMs: SOURCE_DURATION_MS,
    },
    backendProfile: {
      model: "deepseek/deepseek-flash",
      improverModel: "deepseek/deepseek-flash",
      ompCommand: process.execPath,
      mode: "product",
      strategy: "auto",
      domain: "generic",
      adaptation: { capabilities: "fixed", reuse: false, learnMethods: false },
    },
    backendBuild: { sourceId: SOURCE_ID, sourceIntegrity: "build-label-only" },
  };
  const prepared = await prepareNativeHarnessRecoverySource(
    sourceInput,
    () => undefined,
    new AbortController().signal,
  );
  const owner = await createNativeHarnessAccountingOwner({
    storageRoot,
    selectorSha256: SELECTOR,
    ownerId: OWNER_ID,
    createdAt: ADMITTED_AT,
    limitsText: limitsText(),
  });
  await owner.commit(owner.snapshot().revision, transition({
    action: "reserve",
    admissionId: ADMISSION_ID,
    sourceAssociationSha256: associationDigest(descriptor),
    admittedAt: ADMITTED_AT,
    deadlineAt: ADMITTED_AT + SOURCE_DURATION_MS,
    allocatedUsd: MAX_COST_USD,
    reserveRevision: 1,
  }));
  await owner.commit(owner.snapshot().revision, transition({
    action: "bindPrepared",
    admissionId: ADMISSION_ID,
    prepared: prepared.accountingPrepared,
  }));
  await owner.commit(owner.snapshot().revision, transition({
    action: "bindRun",
    admissionId: ADMISSION_ID,
    runId: RUN_ID,
  }));
  owner.close();

  const store = new RunStore(path.join(descriptor.storeRoot, "runs"));
  const created = await store.createWithRecoveryOrigin(
    runRecord(descriptor),
    JSON.stringify(seed(descriptor, prepared)),
  );
  const runDir = store.runDir(RUN_ID);
  const snapshot = captureSnapshot(
    descriptor.workspaceRoot,
    path.join(runDir, `snapshot-${randomUUID()}`),
  );
  const inputManifest = new Map(descriptor.inputManifest.map((entry) => [entry.relativePath, entry]));
  const checked = snapshot.files.map((file) => {
    const input = inputManifest.get(file.path)!;
    return {
      path: file.path,
      size: file.size,
      mode: file.mode,
      contentSha256: input.sha256,
      controllerHash: file.hash,
    };
  });
  const witnessBase = copyWitnessBase({
    snapshotId: snapshot.id,
    root: snapshot.root,
    sourceRoot: snapshot.sourceRoot,
    createdAt: snapshot.createdAt,
    checked,
    inputs: descriptor.inputManifest,
    manifestSha256: descriptor.manifestSha256,
  });
  if (witnessBase === null) throw new Error("fixture witness base was not reconstructible");
  const snapshotSha256 = sha256Hex(canonicalJson(witnessBase));

  const stages = new Map<StageId, StageFixture>();
  const stageRecords: Partial<Record<StageId, StageRecord>> = {};
  let clock = Date.parse(CREATED_AT) + 10_000;
  for (const spec of STAGE_SPECS) {
    const layout = attemptLayout(runDir, spec.stage, spec.attempt);
    const endedAt = new Date(clock).toISOString();
    clock += 1_000;
    await mkdir(layout.artifactDir, { recursive: true, mode: 0o700 });
    if (spec.solver) {
      materializeSnapshot(snapshot, layout.cwd);
      await writeFile(path.join(layout.cwd, `${spec.stage}.txt`), `solver ${spec.stage}\n`, "utf8");
    } else {
      await mkdir(layout.cwd, { recursive: true, mode: 0o700 });
      await mkdir(path.join(layout.cwd, ".harness-evidence"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(layout.cwd, ".harness-evidence", `${spec.stage}.txt`), "evidence\n", "utf8");
    }
    const tracePath = path.join(layout.artifactDir, "worker-events.jsonl");
    const traceText = `${spec.stage}:${spec.attempt}:fixture trace\n`;
    await writeFile(tracePath, traceText, "utf8");
    const result = workerResult(tracePath, endedAt);
    const changes = spec.solver ? diffWorkspace(snapshot, layout.cwd) : [];
    const artifactHash = spec.solver ? sha256Hex(JSON.stringify(changes)) : null;
    const traceHash = sha256Hex(traceText);
    stages.set(spec.stage, {
      stage: spec.stage,
      solver: spec.solver,
      attempt: spec.attempt,
      cwd: layout.cwd,
      artifactDir: layout.artifactDir,
      tracePath,
      result,
      artifactHash,
      traceHash,
    });
    stageRecords[spec.stage] = {
      id: spec.stage,
      status: "completed",
      attempt: spec.attempt,
      cwd: layout.cwd,
      startedAt: endedAt,
      endedAt,
      result,
      traceHash,
      ...(artifactHash === null ? {} : { artifactHash }),
    };
  }
  const saved = await store.save({
    ...created,
    status: "completed",
    snapshot,
    stages: stageRecords,
  }, created.revision);
  const runText = await readFile(path.join(runDir, "run.json"), "utf8");
  const innerDeadlineAt = Date.parse(saved.createdAt) + RUN_DURATION_MS;

  const inventory = await createNativeHarnessDispatchInventory({
    storeRoot: store.root,
    runId: RUN_ID,
  });
  let ordinal = 0;
  const oldBaseline = attemptLayout(runDir, "baseline", 1);
  ordinal += 1;
  await intend(
    inventory,
    ordinal,
    "baseline",
    1,
    oldBaseline.cwd,
    oldBaseline.artifactDir,
    saved.revision,
    innerDeadlineAt,
    snapshotSha256,
  );
  for (const spec of STAGE_SPECS) {
    const fixture = stages.get(spec.stage)!;
    ordinal += 1;
    const nonce = await intend(
      inventory,
      ordinal,
      spec.stage,
      spec.attempt,
      fixture.cwd,
      fixture.artifactDir,
      saved.revision,
      innerDeadlineAt,
      snapshotSha256,
    );
    await terminalizeRunnerFixture(inventory, ordinal, nonce, spec.stage, fixture.result);
  }
  inventory.close();

  return {
    root,
    sourceRoot,
    storageRoot,
    sourcePath,
    descriptor,
    prepared,
    runDir,
    snapshot,
    snapshotSha256,
    stages,
    runText,
    sourceText: await readFile(path.join(descriptor.preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE), "utf8"),
    inventoryText: await readFile(path.join(runDir, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE), "utf8"),
    ownerText: await readFile(path.join(storageRoot, "accounting-owners", SELECTOR, "owner.json"), "utf8"),
    expected: {
      runId: RUN_ID,
      ownerId: OWNER_ID,
      selectorSha256: SELECTOR,
      storageRoot,
      sourceRoot,
      preparedRelativeRoot: path.relative(storageRoot, descriptor.preparedRoot),
      backendBuildSourceId: SOURCE_ID,
    },
    now: Date.parse(CREATED_AT) + 60_000,
  };
}

function inputOf(
  fixture: ContentFixture,
  overrides: Partial<NativeHarnessReconciliationContentInput> = {},
): NativeHarnessReconciliationContentInput {
  return {
    runText: fixture.runText,
    sourceText: fixture.sourceText,
    inventoryText: fixture.inventoryText,
    ownerText: fixture.ownerText,
    expected: fixture.expected,
    now: fixture.now,
    ...overrides,
  };
}

function planned(result: NativeHarnessReconciliationContentPlanResult): NativeHarnessReconciliationContentPlan {
  expect(result.status).toBe("planned");
  if (result.status !== "planned") throw new Error(`expected planned, got ${result.reasons.join(",")}`);
  return result.plan;
}

function mutateJson(text: string, mutate: (value: Record<string, any>) => void): string {
  const value = JSON.parse(text) as Record<string, any>;
  mutate(value);
  return `${JSON.stringify(value)}\n`;
}

function inventoryRow(text: string, stage: string, attempt: number): Record<string, any> {
  const value = JSON.parse(text) as Record<string, any>;
  const row = value.dispatches.find((candidate: Record<string, any>) =>
    candidate.stage === stage && candidate.attempt === attempt);
  if (row === undefined) throw new Error(`fixture row missing: ${stage}:${attempt}`);
  return row;
}

async function observe(
  plan: NativeHarnessReconciliationContentPlan,
  options: {
    readonly fileIo?: NativeFileIo;
    readonly chargeLimitBytes?: number;
  } = {},
): Promise<NativeHarnessReconciliationContentByteResult> {
  const controller = new AbortController();
  return observeNativeHarnessReconciliationContentBytes(plan, {
    guard: () => undefined,
    signal: controller.signal,
    chargeLimitBytes: options.chargeLimitBytes ?? 50 * 1024 * 1024,
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
  });
}

function wrapHandle(
  handle: NativeFileHandle,
  close?: () => Promise<void>,
): NativeFileHandle {
  return {
    stat: (options) => handle.stat(options),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    close: close === undefined ? () => handle.close() : close,
  };
}

interface CountingIo {
  readonly io: NativeFileIo;
  readonly opens: Map<string, number>;
  readonly reads: Map<string, number>;
  readonly closes: Map<string, number>;
}

function countingIo(): CountingIo {
  const opens = new Map<string, number>();
  const reads = new Map<string, number>();
  const closes = new Map<string, number>();
  const increment = (map: Map<string, number>, target: string, by = 1): void => {
    map.set(target, (map.get(target) ?? 0) + by);
  };
  return {
    opens,
    reads,
    closes,
    io: {
      ...nodeFileIo,
      async open(target, flags) {
        increment(opens, target);
        const handle = await nodeFileIo.open(target, flags);
        return {
          stat: (options) => handle.stat(options),
          async read(buffer, offset, length, position) {
            const result = await handle.read(buffer, offset, length, position);
            increment(reads, target, result.bytesRead);
            return result;
          },
          async close() {
            increment(closes, target);
            await handle.close();
          },
        };
      },
    },
  };
}

function primaryPaths(fixture: ContentFixture): {
  readonly run: string;
  readonly source: string;
  readonly inventory: string;
  readonly owner: string;
} {
  return {
    run: path.join(fixture.runDir, "run.json"),
    source: path.join(fixture.descriptor.preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE),
    inventory: path.join(fixture.runDir, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE),
    owner: path.join(fixture.storageRoot, "accounting-owners", SELECTOR, "owner.json"),
  };
}

async function observeComposed(
  fixture: ContentFixture,
  options: {
    readonly fileIo?: NativeFileIo;
    readonly signal?: AbortSignal;
    readonly now?: () => number;
  } = {},
) {
  return observeNativeHarnessReconciliationContent(fixture.expected, {
    ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

describe("native harness reconciliation content", () => {
  test("plans and observes all nine completed traces, four solver trees, and runner-only terminals", async () => {
    const fixture = await makeFixture();
    const result = planNativeHarnessReconciliationContent(inputOf(fixture));
    const plan = planned(result);
    expect(result.metadata.metadata.compatible).toBe(true);
    expect(plan.base.snapshotSha256).toBe(fixture.snapshotSha256);
    expect(plan.base.entries).toHaveLength(1);
    expect(plan.sources).toEqual([{
      path: "hello.txt",
      bytes: Buffer.byteLength(SOURCE_TEXT, "utf8"),
      sha256: sha256Hex(SOURCE_TEXT),
    }]);
    expect(plan.stages).toHaveLength(9);
    expect(plan.stages.filter((stage) => stage.solver)).toHaveLength(4);
    expect(plan.stages.every((stage) => stage.terminalObservationKind === "runner-observation")).toBe(true);
    expect(plan.stages.some((stage) => stage.stage === "baseline" && stage.attempt === 1)).toBe(false);

    const counted = countingIo();
    const observed = await observe(plan, { fileIo: counted.io });
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error(observed.reason);
    expect(observed.observation.observation).toBe("two-pass");
    expect(observed.observation.artifacts).toBe("latest-completed-bytes-checked");
    expect(observed.observation.discardedAttemptContents).toBe("not-verified-not-reused");
    expect(observed.observation.sources).toHaveLength(1);
    expect(observed.observation.base.entries).toHaveLength(1);
    expect(observed.observation.stages).toHaveLength(9);
    expect(observed.observation.tracePasses).toBe(2);
    expect(observed.observation.chargedBytes).toBeGreaterThan(0);
    expect(observed.observation.chargedBytes).toBeLessThanOrEqual(CONTENT_CHARGE_LIMIT);
    for (const stage of observed.observation.stages) {
      const fixtureStage = fixture.stages.get(stage.stage as StageId)!;
      expect(stage.trace.sha256).toBe(fixtureStage.traceHash);
      expect(stage.trace.bytes).toBe(Buffer.byteLength(`${stage.stage}:${stage.attempt}:fixture trace\n`, "utf8"));
      if (stage.solver) {
        expect(stage.artifactHash).toBe(fixtureStage.artifactHash);
        expect(stage.changeManifestSha256).toBe(fixtureStage.artifactHash);
        expect(stage.changeCount).toBe(1);
        expect(stage.ordinaryFileCount).toBe(2);
        expect(stage.directoryCount).toBe(1);
      } else {
        expect(stage.artifactHash).toBeNull();
        expect(stage.changeManifestSha256).toBeNull();
        expect(stage.ordinaryFileCount).toBeNull();
      }
    }

    // Real wrapped-handle counters: every full second pass must read the bytes
    // again, not merely restat them.
    const sourceBytes = Buffer.byteLength(SOURCE_TEXT, "utf8");
    const baseFile = path.join(fixture.snapshot.root, "hello.txt");
    const solverFile = path.join(fixture.stages.get("baseline")!.cwd, "baseline.txt");
    const solverBytes = Buffer.byteLength("solver baseline\n", "utf8");
    expect(counted.reads.get(fixture.sourcePath)).toBe(sourceBytes * 2);
    expect(counted.reads.get(baseFile)).toBe(sourceBytes * 2);
    expect(counted.reads.get(solverFile)).toBe(solverBytes * 2);
    expect(counted.closes.get(fixture.sourcePath)).toBe(2);
    expect(counted.closes.get(baseFile)).toBe(2);
    expect(counted.closes.get(solverFile)).toBe(2);
    for (const stage of plan.stages) {
      const fixtureStage = fixture.stages.get(stage.stage)!;
      const traceBytes = Buffer.byteLength(`${stage.stage}:${stage.attempt}:fixture trace\n`, "utf8");
      expect(counted.reads.get(fixtureStage.tracePath)).toBe(traceBytes * 2);
      expect(counted.closes.get(fixtureStage.tracePath)).toBe(2);
    }
  }, 20_000);

  test("rejects synthetic-fixture terminal facts as non-reusable", async () => {
    const fixture = await makeFixture();
    const inventoryText = mutateJson(fixture.inventoryText, (value) => {
      const row = value.dispatches.find((candidate: Record<string, any>) =>
        candidate.stage === "reflect" && candidate.attempt === 1);
      delete row.launch;
      delete row.process;
      delete row.prompt;
      row.state = "terminal";
      row.cleanup = { observationKind: "synthetic-fixture" };
      row.terminal = {
        outcome: "completed",
        observationKind: "synthetic-fixture",
        observedAt: Date.parse(fixture.stages.get("reflect")!.result.endedAt),
        resultSha256: canonicalWorkerResultSha256(fixture.stages.get("reflect")!.result),
        usageCostUsd: 0.01,
        usageEstimated: false,
      };
    });
    const result = planNativeHarnessReconciliationContent(inputOf(fixture, { inventoryText }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reasons).toContain("stage-terminal-mismatch");
    }
  }, 20_000);

  test("rejects a latest result digest mutation even when cost is unchanged", async () => {
    const fixture = await makeFixture();
    const runText = mutateJson(fixture.runText, (value) => {
      value.stages.baseline.result.text = `${value.stages.baseline.result.text} tampered`;
    });
    const result = planNativeHarnessReconciliationContent(inputOf(fixture, { runText }));
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reasons).toContain("stage-terminal-mismatch");
    }
  }, 20_000);

  test("rejects wrong fixed trace paths and missing trace hashes", async () => {
    const fixture = await makeFixture();
    const wrongPath = mutateJson(fixture.runText, (value) => {
      value.stages.baseline.result.eventsPath = path.join(fixture.runDir, "elsewhere.jsonl");
    });
    const wrong = planNativeHarnessReconciliationContent(inputOf(fixture, { runText: wrongPath }));
    expect(wrong.status).toBe("unavailable");
    if (wrong.status === "unavailable") expect(wrong.reasons).toContain("stage-trace-path-mismatch");

    const missing = mutateJson(fixture.runText, (value) => {
      delete value.stages.baseline.traceHash;
    });
    const absent = planNativeHarnessReconciliationContent(inputOf(fixture, { runText: missing }));
    expect(absent.status).toBe("unavailable");
    if (absent.status === "unavailable") expect(absent.reasons).toContain("stage-trace-hash-missing");
  }, 20_000);

  test("rejects base digest drift, parent drift, and parent cycles", async () => {
    const fixture = await makeFixture();
    const baseDrift = mutateJson(fixture.inventoryText, (value) => {
      value.dispatches[0].snapshotSha256 = "d".repeat(64);
    });
    const base = planNativeHarnessReconciliationContent(inputOf(fixture, { inventoryText: baseDrift }));
    expect(base.status).toBe("unavailable");
    if (base.status === "unavailable") expect(base.reasons).toContain("base-snapshot-digest-mismatch");

    const drift = mutateJson(fixture.runText, (value) => {
      value.stages.baseline.parentStage = "final";
      value.stages.baseline.parentArtifactHash = HASH_A;
    });
    const drifted = planNativeHarnessReconciliationContent(inputOf(fixture, { runText: drift }));
    expect(drifted.status).toBe("unavailable");
    if (drifted.status === "unavailable") {
      // The original run decoder already enforces parent artifact equality; the
      // planner independently refuses the same drift if it reaches the join.
      expect(drifted.reasons).toContain("metadata-incompatible");
    }

    const cycle = mutateJson(fixture.runText, (value) => {
      value.stages.baseline.parentStage = "final";
      value.stages.baseline.parentArtifactHash = value.stages.final.artifactHash;
      value.stages.final.parentStage = "baseline";
      value.stages.final.parentArtifactHash = value.stages.baseline.artifactHash;
    });
    const cyclic = planNativeHarnessReconciliationContent(inputOf(fixture, { runText: cycle }));
    expect(cyclic.status).toBe("unavailable");
    if (cyclic.status === "unavailable") expect(cyclic.reasons).toContain("parent-cycle");
  }, 20_000);

  test("treats snapshotless zero-attempt content as not required and attempted content as unavailable", async () => {
    const fixture = await makeFixture();
    const snapshotlessRun = mutateJson(fixture.runText, (value) => {
      delete value.snapshot;
      value.stages = {};
    });
    const emptyInventory = mutateJson(fixture.inventoryText, (value) => {
      value.dispatches = [];
    });
    const notRequired = planNativeHarnessReconciliationContent(inputOf(fixture, {
      runText: snapshotlessRun,
      inventoryText: emptyInventory,
    }));
    expect(notRequired.status).toBe("not-required");
    if (notRequired.status === "not-required") {
      expect(notRequired.reasons).toEqual(["snapshot-not-required"]);
    }

    const snapshotlessAttemptedRun = mutateJson(fixture.runText, (value) => {
      delete value.snapshot;
    });
    const attempted = planNativeHarnessReconciliationContent(inputOf(fixture, {
      runText: snapshotlessAttemptedRun,
    }));
    expect(attempted.status).toBe("unavailable");
    if (attempted.status === "unavailable") expect(attempted.reasons).toContain("snapshot-missing");
  }, 20_000);

  test("copies caller input once and refuses accessors without invoking them", async () => {
    const fixture = await makeFixture();
    const input = inputOf(fixture);
    let reads = 0;
    const changing = new Proxy(input, {
      getOwnPropertyDescriptor(target, key) {
        if (key === "runText") {
          reads += 1;
          return {
            value: reads === 1 ? target.runText : "{\"changed\":true}\n",
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const result = planNativeHarnessReconciliationContent(changing);
    expect(result.status).toBe("planned");
    expect(reads).toBe(1);

    let getterReads = 0;
    const accessor = { ...input };
    Object.defineProperty(accessor, "runText", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return input.runText;
      },
    });
    expect(() => planNativeHarnessReconciliationContent(accessor)).toThrow();
    expect(getterReads).toBe(0);
  }, 20_000);

  test("observer refuses source/base byte or mode mismatches", async () => {
    const fixture = await makeFixture();
    const plan = planned(planNativeHarnessReconciliationContent(inputOf(fixture)));

    await writeFile(fixture.sourcePath, "source changed\n", "utf8");
    const sourceChanged = await observe(plan);
    expect(sourceChanged.ok).toBe(false);
    if (!sourceChanged.ok) expect(sourceChanged.code).toBe("changed");
    await writeFile(fixture.sourcePath, SOURCE_TEXT, "utf8");

    const basePath = path.join(fixture.snapshot.root, "hello.txt");
    await chmod(basePath, 0o644);
    const baseMode = await observe(plan);
    expect(baseMode.ok).toBe(false);
    if (!baseMode.ok) expect(["changed", "unsupported"]).toContain(baseMode.code);
    await chmod(basePath, 0o600);
  }, 20_000);

  test("observer refuses solver add/extra/delete/mode/protected/binary mismatches", async () => {
    const cases: readonly {
      readonly name: string;
      readonly mutate: (fixture: ContentFixture) => Promise<void>;
      readonly code: NativeHarnessOutputFailure;
    }[] = [
      {
        name: "extra",
        code: "changed",
        mutate: async (fixture) => {
          await writeFile(path.join(fixture.stages.get("baseline")!.cwd, "extra.txt"), "extra\n", "utf8");
        },
      },
      {
        name: "modify",
        code: "changed",
        mutate: async (fixture) => {
          await appendFile(
            path.join(fixture.stages.get("baseline")!.cwd, "baseline.txt"),
            "modified after fixture\n",
            "utf8",
          );
        },
      },
      {
        name: "delete",
        code: "unsupported",
        mutate: async (fixture) => {
          await unlink(path.join(fixture.stages.get("baseline")!.cwd, "hello.txt"));
        },
      },
      {
        name: "mode",
        code: "unsupported",
        mutate: async (fixture) => {
          await chmod(path.join(fixture.stages.get("baseline")!.cwd, "hello.txt"), 0o644);
        },
      },
      {
        name: "protected",
        code: "unsupported",
        mutate: async (fixture) => {
          await writeFile(path.join(fixture.stages.get("baseline")!.cwd, ".env"), "SECRET=1\n", "utf8");
        },
      },
      {
        name: "binary",
        code: "unsupported",
        mutate: async (fixture) => {
          await writeFile(path.join(fixture.stages.get("baseline")!.cwd, "baseline.txt"), Buffer.from([0, 1, 2]));
        },
      },
    ];
    for (const entry of cases) {
      const fixture = await makeFixture();
      const plan = planned(planNativeHarnessReconciliationContent(inputOf(fixture)));
      await entry.mutate(fixture);
      const observed = await observe(plan);
      expect({ name: entry.name, ok: observed.ok }).toEqual({ name: entry.name, ok: false });
      if (!observed.ok) expect({ name: entry.name, code: observed.code }).toEqual({ name: entry.name, code: entry.code });
    }
  }, 60_000);

  test("refuses capacity before any content read", async () => {
    const fixture = await makeFixture();
    const plan = planned(planNativeHarnessReconciliationContent(inputOf(fixture)));
    let opens = 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        opens += 1;
        return nodeFileIo.open(target, flags);
      },
    };
    const observed = await observe(plan, { fileIo: io, chargeLimitBytes: 0 });
    expect(observed.ok).toBe(false);
    if (!observed.ok) {
      expect(observed.code).toBe("too-large");
      expect(observed.chargedBytes).toBe(0);
      expect(observed.tracePassesStarted).toBe(0);
    }
    expect(opens).toBe(0);
  }, 20_000);

  test("retains failing read charge and covers a grown opened file", async () => {
    const fixture = await makeFixture();
    const plan = planned(planNativeHarnessReconciliationContent(inputOf(fixture)));
    const sourceBytes = Buffer.byteLength(SOURCE_TEXT, "utf8");
    const failingIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== fixture.sourcePath) return handle;
        return wrapHandle(handle, async () => {
          await handle.close();
        });
      },
    };
    // Replace read for the selected source only by reopening through a narrow wrapper.
    const rejectingIo: NativeFileIo = {
      ...failingIo,
      async open(target, flags) {
        const handle = await failingIo.open(target, flags);
        if (target !== fixture.sourcePath) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: async () => {
            throw new Error("injected read failure");
          },
          close: () => handle.close(),
        };
      },
    };
    const failed = await observe(plan, { fileIo: rejectingIo });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.code).toBe("io-failure");
      expect(failed.chargedBytes).toBeGreaterThanOrEqual(sourceBytes);
    }

    let sourceLstats = 0;
    const growingIo: NativeFileIo = {
      ...nodeFileIo,
      async lstat(target, options) {
        const info = await nodeFileIo.lstat(target, options);
        if (target === fixture.sourcePath) {
          sourceLstats += 1;
          if (sourceLstats === 2) {
            await appendFile(fixture.sourcePath, "grown before read\n", "utf8");
            return nodeFileIo.lstat(target, options);
          }
        }
        return info;
      },
    };
    const grown = await observe(planned(planNativeHarnessReconciliationContent(inputOf(fixture))), {
      fileIo: growingIo,
    });
    expect(grown.ok).toBe(false);
    if (!grown.ok) {
      expect(grown.chargedBytes).toBeGreaterThanOrEqual(sourceBytes + Buffer.byteLength("grown before read\n", "utf8"));
    }

    // Growth between the pre-read reservation and the actual opened stat:
    // the explicit global ceiling is smaller than the grown opened size, so
    // the delta must be refused before any read while the reservation stays.
    await writeFile(fixture.sourcePath, SOURCE_TEXT, "utf8");
    const openGrowth = "grown at open\n";
    let limitedReads = 0;
    let limitedCloses = 0;
    let grewAtOpen = false;
    const limitedIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        if (target === fixture.sourcePath && !grewAtOpen) {
          grewAtOpen = true;
          await appendFile(target, openGrowth, "utf8");
        }
        const handle = await nodeFileIo.open(target, flags);
        if (target !== fixture.sourcePath) return handle;
        return {
          stat: (options) => handle.stat(options),
          async read(buffer, offset, length, position) {
            limitedReads += 1;
            return handle.read(buffer, offset, length, position);
          },
          async close() {
            limitedCloses += 1;
            await handle.close();
          },
        };
      },
    };
    const limited = await observe(plan, {
      fileIo: limitedIo,
      chargeLimitBytes: sourceBytes + 10,
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.code).toBe("too-large");
      expect(limited.chargedBytes).toBe(sourceBytes);
      expect(limited.chargedBytes).toBeLessThanOrEqual(sourceBytes + 10);
    }
    expect(limitedReads).toBe(0);
    expect(limitedCloses).toBe(1);
  }, 20_000);

  test("refuses marker and per-tree growth above actual opened-size caps before read", async () => {
    const markerFixture = await makeFixture();
    const markerPlan = planned(planNativeHarnessReconciliationContent(inputOf(markerFixture)));
    const markerPath = path.join(
      markerFixture.stages.get("baseline")!.cwd,
      ".harness2-origin.json",
    );
    let markerLstats = 0;
    let markerOpens = 0;
    let markerReads = 0;
    let markerCloses = 0;
    const markerIo: NativeFileIo = {
      ...nodeFileIo,
      async lstat(target, options) {
        const info = await nodeFileIo.lstat(target, options);
        if (target === markerPath) {
          markerLstats += 1;
          if (markerLstats === 2) {
            await appendFile(markerPath, "x".repeat(20 * 1024), "utf8");
            return nodeFileIo.lstat(target, options);
          }
        }
        return info;
      },
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== markerPath) return handle;
        markerOpens += 1;
        return {
          stat: (options) => handle.stat(options),
          async read(buffer, offset, length, position) {
            markerReads += 1;
            return handle.read(buffer, offset, length, position);
          },
          async close() {
            markerCloses += 1;
            await handle.close();
          },
        };
      },
    };
    const markerObserved = await observe(markerPlan, { fileIo: markerIo });
    expect(markerObserved.ok).toBe(false);
    if (!markerObserved.ok) {
      expect(markerObserved.code).toBe("too-large");
      expect(markerObserved.chargedBytes).toBeGreaterThanOrEqual(20 * 1024);
    }
    expect(markerOpens).toBe(1);
    expect(markerReads).toBe(0);
    expect(markerCloses).toBe(1);

    const treeFixture = await makeFixture(["hello.txt", "second.txt"]);
    const treePlan = planned(planNativeHarnessReconciliationContent(inputOf(treeFixture)));
    const baseTargets = new Set([
      path.join(treeFixture.snapshot.root, "hello.txt"),
      path.join(treeFixture.snapshot.root, "second.txt"),
    ]);
    const lstatCounts = new Map<string, number>();
    const treeOpens = new Map<string, number>();
    const treeReads = new Map<string, number>();
    const treeCloses = new Map<string, number>();
    const bump = (map: Map<string, number>, target: string, by = 1): void => {
      map.set(target, (map.get(target) ?? 0) + by);
    };
    const treeIo: NativeFileIo = {
      ...nodeFileIo,
      async lstat(target, options) {
        const info = await nodeFileIo.lstat(target, options);
        if (baseTargets.has(target)) {
          const count = (lstatCounts.get(target) ?? 0) + 1;
          lstatCounts.set(target, count);
          if (count === 2) {
            await appendFile(target, "y".repeat(150 * 1024), "utf8");
            return nodeFileIo.lstat(target, options);
          }
        }
        return info;
      },
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (!baseTargets.has(target)) return handle;
        bump(treeOpens, target);
        return {
          stat: (options) => handle.stat(options),
          async read(buffer, offset, length, position) {
            bump(treeReads, target);
            return handle.read(buffer, offset, length, position);
          },
          async close() {
            bump(treeCloses, target);
            await handle.close();
          },
        };
      },
    };
    const treeObserved = await observe(treePlan, { fileIo: treeIo });
    expect(treeObserved.ok).toBe(false);
    if (!treeObserved.ok) {
      expect(treeObserved.code).toBe("too-large");
      expect(treeObserved.chargedBytes).toBeGreaterThanOrEqual(300 * 1024);
    }
    // The first grown file fits the per-tree ordinary cap and is read; the
    // second crosses the aggregate cap before allocation/read. Both opened
    // handles are closed exactly once.
    const firstBase = path.join(treeFixture.snapshot.root, "hello.txt");
    const secondBase = path.join(treeFixture.snapshot.root, "second.txt");
    expect(treeOpens.get(firstBase)).toBe(1);
    expect(treeReads.get(firstBase)).toBe(1);
    expect(treeCloses.get(firstBase)).toBe(1);
    expect(treeOpens.get(secondBase)).toBe(1);
    expect(treeReads.get(secondBase) ?? 0).toBe(0);
    expect(treeCloses.get(secondBase)).toBe(1);
  }, 30_000);

  test("detects full second-pass tree and trace byte changes", async () => {
    const treeFixture = await makeFixture();
    const treePlan = planned(planNativeHarnessReconciliationContent(inputOf(treeFixture)));
    const trigger = path.join(treeFixture.stages.get("baseline")!.cwd, "baseline.txt");
    const basePath = path.join(treeFixture.snapshot.root, "hello.txt");
    let treeMutated = false;
    const treeIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== trigger) return handle;
        return wrapHandle(handle, async () => {
          await handle.close();
          if (!treeMutated) {
            treeMutated = true;
            await writeFile(basePath, "base changed between passes\n", "utf8");
          }
        });
      },
    };
    const treeObserved = await observe(treePlan, { fileIo: treeIo });
    expect(treeObserved.ok).toBe(false);
    if (!treeObserved.ok) expect(treeObserved.code).toBe("changed");

    const traceFixture = await makeFixture();
    const tracePlan = planned(planNativeHarnessReconciliationContent(inputOf(traceFixture)));
    const tracePath = traceFixture.stages.get("baseline")!.tracePath;
    let traceMutated = false;
    const traceIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== tracePath) return handle;
        return wrapHandle(handle, async () => {
          await handle.close();
          if (!traceMutated) {
            traceMutated = true;
            await writeFile(tracePath, "baseline:2:tampered between passes\n", "utf8");
          }
        });
      },
    };
    const traceObserved = await observe(tracePlan, { fileIo: traceIo });
    expect(traceObserved.ok).toBe(false);
    if (!traceObserved.ok) expect(traceObserved.code).toBe("changed");
  }, 30_000);

  test("composes stable primary files with bounded two-pass content", async () => {
    const fixture = await makeFixture();
    const counted = countingIo();
    const result = await observeComposed(fixture, { fileIo: counted.io });

    expect(result.schema).toBe(NATIVE_HARNESS_RECONCILIATION_CONTENT_SCHEMA);
    expect(result.readOnly).toBe(true);
    expect(result.resumeAvailable).toBe(false);
    expect(result.processes).toBe("not-inspected");
    expect(result.artifacts).toBe("latest-completed-bytes-checked");
    expect(result.discardedAttemptContents).toBe("not-verified-not-reused");
    expect(result.status).toBe("stable");
    expect(result.observation).toBe("two-pass");
    expect(result.reasons).toEqual([]);
    expect(result.captures).toHaveLength(8);
    expect(result.openedFiles).toBe(8);
    expect(result.close).toEqual({ attempted: 8, settled: 8, succeeded: 8 });
    expect(result.pins).toEqual({ directoryCount: 7, checkedAtEnd: true, stable: true });
    expect(result.deadline.budgetMs).toBe(NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS);
    expect(result.deadline.soft).toBe(true);
    expect(result.deadline.cleanupMayExceedDeadline).toBe(true);
    expect(result.metadataStatus).toBe("compatible");

    expect(result.content.planner).toBe("planned");
    expect(result.content.status).toBe("stable");
    expect(result.content.provisionalStatus).toBe("stable");
    expect(result.content.revoked).toBe(false);
    expect(result.content.revokedReasons).toEqual([]);
    expect(result.content.planReasons).toEqual([]);
    expect(result.content.failure).toBeNull();
    expect(result.content.tracePassesStarted).toBe(2);
    const observation = result.content.observation;
    expect(observation).not.toBeNull();
    expect(observation!.artifacts).toBe("latest-completed-bytes-checked");
    expect(observation!.discardedAttemptContents).toBe("not-verified-not-reused");
    expect(observation!.semanticAcceptance).toBe("not-evaluated");
    expect(observation!.tracePasses).toBe(2);
    expect(result.content.chargedBytes).toBe(observation!.chargedBytes);
    expect(result.content.chargeLimitBytes).toBe(observation!.chargeLimitBytes);

    const sourceBytes = Buffer.byteLength(SOURCE_TEXT, "utf8");
    const baseFile = path.join(fixture.snapshot.root, "hello.txt");
    const solverFile = path.join(fixture.stages.get("baseline")!.cwd, "baseline.txt");
    expect(counted.reads.get(fixture.sourcePath)).toBe(sourceBytes * 2);
    expect(counted.reads.get(baseFile)).toBe(sourceBytes * 2);
    expect(counted.reads.get(solverFile)).toBe(Buffer.byteLength("solver baseline\n", "utf8") * 2);
    for (const stage of fixture.stages.values()) {
      expect(counted.reads.get(stage.tracePath))
        .toBe(Buffer.byteLength(`${stage.stage}:${stage.attempt}:fixture trace\n`, "utf8") * 2);
    }
    expect(JSON.stringify(result)).not.toContain("r2b2c1 content fixture task");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8"))
      .toBeLessThanOrEqual(NATIVE_HARNESS_RECONCILIATION_CONTENT_MAX_METADATA_BYTES);
  }, 30_000);

  test("keeps primary files stable while composed content reports a byte difference", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.sourcePath, "source changed for composition\n", "utf8");
    const result = await observeComposed(fixture);

    expect(result.status).toBe("stable");
    expect(result.content.planner).toBe("planned");
    expect(result.content.status).toBe("different");
    expect(result.content.provisionalStatus).toBe("different");
    expect(result.content.revoked).toBe(false);
    expect(result.content.observation).toBeNull();
    expect(result.artifacts).toBe("partial-bytes-not-retained");
    expect(result.content.failure).toEqual({
      code: "changed",
      reason: expect.stringContaining("source"),
      observedMismatch: true,
    });
    expect(result.content.chargedBytes).toBeGreaterThan(0);
    expect(result.content.tracePassesStarted).toBe(0);
  }, 30_000);

  test("legacy changed code without observedMismatch stays unavailable", async () => {
    const fixture = await makeFixture();
    const markerPath = path.join(
      fixture.stages.get("baseline")!.cwd,
      ".harness2-origin.json",
    );
    let mutated = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (!mutated && target === markerPath) {
          mutated = true;
          // The marker changed after its directory lstat and after open; the
          // reused reader reports code `changed` without positive mismatch
          // evidence, so the composed axis must stay unavailable.
          await appendFile(markerPath, " ", "utf8");
        }
        return handle;
      },
    };
    const result = await observeComposed(fixture, { fileIo: io });
    expect(mutated).toBe(true);
    expect(result.status).toBe("stable");
    expect(result.content.status).toBe("unavailable");
    expect(result.content.failure?.code).toBe("changed");
    expect(result.content.failure?.observedMismatch).toBeUndefined();
    expect(result.content.observation).toBeNull();
    expect(result.artifacts).toBe("partial-bytes-not-retained");
  }, 30_000);

  test("final primary byte mutation after content starts revokes stable content", async () => {
    const fixture = await makeFixture();
    const runPath = primaryPaths(fixture).run;
    let mutated = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (!mutated && target === fixture.sourcePath) {
          mutated = true;
          writeFileSync(
            runPath,
            fixture.runText.replace("r2b2c1 content fixture task", "R2b2c1 content fixture task"),
            "utf8",
          );
        }
        return handle;
      },
    };
    const result = await observeComposed(fixture, { fileIo: io });

    expect(mutated).toBe(true);
    expect(result.status).toBe("different");
    expect(result.reasons).toContain("changed");
    expect(result.metadata).toBeNull();
    expect(result.metadataStatus).toBe("not-observed");
    expect(result.content.status).toBe("revoked");
    expect(result.content.provisionalStatus).toBe("stable");
    expect(result.content.revoked).toBe(true);
    expect(result.content.revokedReasons).toContain("changed");
    expect(result.content.observation).toBeNull();
    expect(result.artifacts).toBe("not-retained-after-primary-refusal");
    expect(result.content.chargedBytes).toBeGreaterThan(0);
  }, 30_000);

  test("final pin identity change or error revokes stable content", async () => {
    const replaced = await makeFixture();
    const replacementOwnerPath = primaryPaths(replaced).owner;
    const accountingRoot = path.join(replaced.storageRoot, "accounting-owners");
    let replacementOwnerOpens = 0;
    const replacementIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== replacementOwnerPath) return handle;
        replacementOwnerOpens += 1;
        if (replacementOwnerOpens !== 2) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            renameSync(accountingRoot, `${accountingRoot}-old`);
            mkdirSync(accountingRoot, { mode: 0o700 });
          },
        };
      },
    };
    const changed = await observeComposed(replaced, { fileIo: replacementIo });
    expect(replacementOwnerOpens).toBe(2);
    expect(changed.status).toBe("different");
    expect(changed.pins).toEqual({ directoryCount: 7, checkedAtEnd: true, stable: false });
    expect(changed.content.status).toBe("revoked");
    expect(changed.content.provisionalStatus).toBe("stable");
    expect(changed.content.revokedReasons).toContain("parent-changed");
    expect(changed.content.observation).toBeNull();

    const failed = await makeFixture();
    const failedOwnerPath = primaryPaths(failed).owner;
    const failedAccountingRoot = path.join(failed.storageRoot, "accounting-owners");
    let failedOwnerOpens = 0;
    let pinError = false;
    const failedIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== failedOwnerPath) return handle;
        failedOwnerOpens += 1;
        if (failedOwnerOpens !== 2) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            pinError = true;
          },
        };
      },
      async realpath(target) {
        if (pinError && target === failedAccountingRoot) {
          throw Object.assign(new Error("injected final pin EIO"), { code: "EIO" });
        }
        return nodeFileIo.realpath(target);
      },
    };
    const errored = await observeComposed(failed, { fileIo: failedIo });
    expect(failedOwnerOpens).toBe(2);
    expect(errored.status).toBe("unavailable");
    expect(errored.reasons).toContain("io-failed");
    expect(errored.pins.checkedAtEnd).toBe(false);
    expect(errored.content.status).toBe("revoked");
    expect(errored.content.provisionalStatus).toBe("stable");
    expect(errored.content.revokedReasons).toContain("io-failed");
    expect(errored.content.observation).toBeNull();
  }, 30_000);

  test("queued abort after the last pin check revokes stable content", async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    const startedAt = 1_700_000_000_000;
    const ownerPath = primaryPaths(fixture).owner;
    const selectorRoot = path.join(fixture.storageRoot, "accounting-owners", SELECTOR);
    let ownerOpens = 0;
    let finalPhase = false;
    let queueOnNextClock = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== ownerPath) return handle;
        ownerOpens += 1;
        const openNumber = ownerOpens;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            if (openNumber === 2) finalPhase = true;
          },
        };
      },
      async lstat(target, options) {
        const info = await nodeFileIo.lstat(target, options);
        if (finalPhase && target === selectorRoot) queueOnNextClock = true;
        return info;
      },
    };
    const result = await observeComposed(fixture, {
      fileIo: io,
      signal: controller.signal,
      now: () => {
        if (queueOnNextClock) {
          queueOnNextClock = false;
          queueMicrotask(() => controller.abort());
        }
        return startedAt;
      },
    });
    expect(ownerOpens).toBe(2);
    expect(finalPhase).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.content.status).toBe("revoked");
    expect(result.content.provisionalStatus).toBe("stable");
    expect(result.content.revoked).toBe(true);
    expect(result.content.observation).toBeNull();
    expect(result.artifacts).toBe("not-retained-after-primary-refusal");
  }, 30_000);

  test("shares one 30s window across content and the final primary pass without reset", async () => {
    const startedAt = 1_700_000_000_000;
    const intermediate = startedAt + NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS / 6;

    const contentFixture = await makeFixture();
    const contentOwnerPath = primaryPaths(contentFixture).owner;
    let contentTime = startedAt;
    let contentOwnerOpens = 0;
    const contentIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        if (target === contentFixture.sourcePath) {
          contentTime = startedAt + NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS;
        }
        const handle = await nodeFileIo.open(target, flags);
        if (target !== contentOwnerPath) return handle;
        contentOwnerOpens += 1;
        const openNumber = contentOwnerOpens;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            if (openNumber === 1) contentTime = intermediate;
          },
        };
      },
    };
    const contentResult = await observeComposed(contentFixture, {
      fileIo: contentIo,
      now: () => contentTime,
    });
    expect(contentOwnerOpens).toBe(1);
    expect(contentResult.deadline.budgetMs).toBe(NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS);
    expect(contentResult.deadline.deadlineAt)
      .toBe(startedAt + NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS);
    expect(contentResult.status).toBe("expired");
    expect(contentResult.content.status).toBe("expired");
    expect(contentResult.content.provisionalStatus).toBe("expired");
    expect(contentResult.content.failure?.code).toBe("deadline");
    expect(contentResult.content.observation).toBeNull();

    const finalFixture = await makeFixture();
    const runPath = primaryPaths(finalFixture).run;
    const contentTracePath = finalFixture.stages.get("baseline")!.tracePath;
    let finalTime = startedAt;
    let runOpens = 0;
    let traceCloses = 0;
    const finalIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        if (target === runPath) {
          runOpens += 1;
          if (runOpens === 2) {
            finalTime = startedAt + NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS;
          }
        }
        const handle = await nodeFileIo.open(target, flags);
        if (target !== contentTracePath) return handle;
        traceCloses += 1;
        const closeNumber = traceCloses;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            if (closeNumber === 1) finalTime = intermediate;
          },
        };
      },
    };
    const finalResult = await observeComposed(finalFixture, {
      fileIo: finalIo,
      now: () => finalTime,
    });
    expect(runOpens).toBe(2);
    expect(traceCloses).toBe(2);
    expect(finalResult.deadline.deadlineAt)
      .toBe(startedAt + NATIVE_HARNESS_RECONCILIATION_CONTENT_DEADLINE_MS);
    expect(finalResult.deadline.expired).toBe(true);
    expect(finalResult.status).toBe("expired");
    expect(finalResult.content.status).toBe("revoked");
    expect(finalResult.content.provisionalStatus).toBe("stable");
    expect(finalResult.content.revoked).toBe(true);
    expect(finalResult.content.observation).toBeNull();
  }, 30_000);

  test("settles abort, held close, and rejected content close before returning", async () => {
    const aborted = await makeFixture();
    const controller = new AbortController();
    const abortIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        if (target === aborted.sourcePath) controller.abort();
        return nodeFileIo.open(target, flags);
      },
    };
    const abortedResult = await observeComposed(aborted, {
      fileIo: abortIo,
      signal: controller.signal,
    });
    expect(abortedResult.status).toBe("aborted");
    expect(abortedResult.content.status).toBe("aborted");
    expect(abortedResult.content.failure?.code).toBe("aborted");
    expect(abortedResult.content.observation).toBeNull();

    const heldFixture = await makeFixture();
    const heldController = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let closeStarted!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => { closeStarted = resolve; });
    let heldOnce = false;
    const heldIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== heldFixture.sourcePath) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            if (!heldOnce) {
              heldOnce = true;
              closeStarted();
              await held;
            }
            await handle.close();
          },
        };
      },
    };
    let settled = false;
    const pending = observeComposed(heldFixture, {
      fileIo: heldIo,
      signal: heldController.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    let assertionFailure: unknown = null;
    try {
      await closeStartedPromise;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      heldController.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
    } catch (error) {
      assertionFailure = error;
    } finally {
      release();
    }
    const heldResult = await pending;
    if (assertionFailure !== null) throw assertionFailure;
    expect(settled).toBe(true);
    expect(heldResult.status).toBe("aborted");
    expect(heldResult.content.status).toBe("aborted");
    expect(heldResult.content.failure?.code).toBe("aborted");

    const failed = await makeFixture();
    let closeFailed = false;
    const closeFailureIo: NativeFileIo = {
      ...nodeFileIo,
      async open(target, flags) {
        const handle = await nodeFileIo.open(target, flags);
        if (target !== failed.sourcePath) return handle;
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            closeFailed = true;
            throw new Error("injected content close failure");
          },
        };
      },
    };
    const failedResult = await observeComposed(failed, { fileIo: closeFailureIo });
    expect(closeFailed).toBe(true);
    expect(failedResult.status).toBe("stable");
    expect(failedResult.content.status).toBe("unavailable");
    expect(failedResult.content.failure?.code).toBe("io-failure");
    expect(failedResult.content.observation).toBeNull();
  }, 30_000);

  test("a refused first-pass primary prevents content planning and artifact IO", async () => {
    const fixture = await makeFixture();
    const paths = primaryPaths(fixture);
    await unlink(paths.run);
    const counted = countingIo();
    const result = await observeComposed(fixture, { fileIo: counted.io });
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("missing");
    expect(result.content.planner).toBe("not-run");
    expect(result.content.status).toBe("not-observed");
    expect(result.content.provisionalStatus).toBe("not-observed");
    expect(result.content.observation).toBeNull();
    expect(result.content.chargedBytes).toBe(0);
    expect(result.artifacts).toBe("not-inspected");
    expect(counted.opens.has(fixture.sourcePath)).toBe(false);
    expect(counted.opens.has(path.join(fixture.snapshot.root, "hello.txt"))).toBe(false);
  }, 30_000);

  test("no-content and invalid metadata take no artifact byte IO", async () => {
    const empty = await makeFixture();
    const emptyPaths = primaryPaths(empty);
    const emptyPrimaries = new Set(Object.values(emptyPaths));
    writeFileSync(
      emptyPaths.run,
      mutateJson(empty.runText, (value) => {
        delete value.snapshot;
        value.stages = {};
      }),
      "utf8",
    );
    writeFileSync(
      emptyPaths.inventory,
      mutateJson(empty.inventoryText, (value) => {
        value.dispatches = [];
      }),
      "utf8",
    );
    const emptyCounted = countingIo();
    const emptyResult = await observeComposed(empty, { fileIo: emptyCounted.io });
    expect(emptyResult.status).toBe("stable");
    expect(emptyResult.content.planner).toBe("not-required");
    expect(emptyResult.content.status).toBe("not-required");
    expect(emptyResult.content.provisionalStatus).toBe("not-required");
    expect(emptyResult.content.planReasons).toEqual(["snapshot-not-required"]);
    expect(emptyResult.content.observation).toBeNull();
    expect(emptyResult.content.chargedBytes).toBe(0);
    expect(emptyResult.artifacts).toBe("not-inspected");
    expect([...emptyCounted.opens.keys()].every((target) => emptyPrimaries.has(target))).toBe(true);
    for (const target of emptyPrimaries) expect(emptyCounted.opens.get(target)).toBe(2);

    const invalid = await makeFixture();
    const invalidPaths = primaryPaths(invalid);
    const invalidPrimaries = new Set(Object.values(invalidPaths));
    writeFileSync(
      invalidPaths.run,
      mutateJson(invalid.runText, (value) => {
        value.config.mode = "manual";
      }),
      "utf8",
    );
    const invalidCounted = countingIo();
    const invalidResult = await observeComposed(invalid, { fileIo: invalidCounted.io });
    expect(invalidResult.status).toBe("stable");
    expect(invalidResult.content.planner).toBe("unavailable");
    expect(invalidResult.content.status).toBe("unavailable");
    expect(invalidResult.content.observation).toBeNull();
    expect(invalidResult.content.chargedBytes).toBe(0);
    expect(invalidResult.artifacts).toBe("not-inspected");
    expect([...invalidCounted.opens.keys()].every((target) => invalidPrimaries.has(target))).toBe(true);
  }, 30_000);
});
