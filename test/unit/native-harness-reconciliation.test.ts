import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  createNativeHarnessAccountingOwner,
  type NativeHarnessAccountingHandle,
} from "../../src/native-harness-accounting.ts";
import {
  NATIVE_HARNESS_DISPATCH_INVENTORY_FILE,
  NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA,
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
  reconcileNativeHarnessMetadata,
  type NativeHarnessReconciliationExpectation,
  type NativeHarnessReconciliationInput,
  type NativeHarnessReconciliationResult,
} from "../../src/native-harness-reconciliation.ts";
import { sha256Hex } from "../../src/native-work.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import type {
  RunRecord,
  RunRecoverySeed,
  StageId,
  StageRecord,
  WorkerResult,
} from "../../vendor/harness2/upstream/src/types.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_OWNER_ID = "33333333-3333-4333-8333-333333333333";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ADMISSION_ID = "44444444-4444-4444-8444-444444444444";
const SELECTOR = "c".repeat(64);
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ADMITTED_AT = 1_700_000_000_123;
const SOURCE_DURATION_MS = 300_000;
const RUN_DURATION_MS = 120_000;
const MAX_COST_USD = 0.25;
const STAGE_ALLOCATED_USD = 0.1;
const OBSERVED_USD = 0.1;
const CREATED_AT = new Date(ADMITTED_AT + 1_000).toISOString();
const SOURCE_ID = (JSON.parse(
  readFileSync(new URL("../../vendor/harness2/SOURCE.json", import.meta.url), "utf8"),
) as { sourceId: string }).sourceId;

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface MetadataFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
  readonly prepared: PreparedRecoverySource;
  readonly owner: NativeHarnessAccountingHandle;
  readonly run: RunRecord;
  readonly runText: string;
  readonly sourceText: string;
  readonly ownerText: string;
  readonly inventoryText: string;
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
    observationId: "observation-r2b2a",
    generation: 1,
    sessionId: "session-r2b2a",
    workspaceRoot: descriptor.sourceRoot,
    toolCallId: "call-r2b2a",
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

function runRecord(
  descriptor: NativeHarnessWorkspaceDescriptor,
  configOverrides: Partial<RunRecord["config"]> = {},
  workspace: string = descriptor.workspaceRoot,
): RunRecord {
  return {
    schemaVersion: 1,
    id: RUN_ID,
    revision: 0,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    workspace,
    task: "b2a metadata fixture task",
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
      ...configOverrides,
    },
    status: "queued",
    baseHarness: {
      schemaVersion: 1,
      id: "r2b2a-fixture-harness",
      promptAppend: "",
      toolGuidance: "",
      rationale: "",
      skills: [],
    },
    libraryEntries: [],
    stages: {},
  };
}

function workerResult(): WorkerResult {
  return {
    text: "synthetic completed worker result; not actual worker evidence",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    startedAt: CREATED_AT,
    endedAt: CREATED_AT,
    eventsPath: "/synthetic/worker-events.jsonl",
    status: "completed",
  };
}

function stageRecord(
  stage: StageId,
  cwd: string,
  attempt: number,
  layout: FixtureLayoutOptions,
): StageRecord {
  return {
    id: stage,
    status: layout.stageStatus ?? "running",
    attempt,
    cwd,
    startedAt: CREATED_AT,
    reservedCostUsd: layout.reservedCostUsd ?? STAGE_ALLOCATED_USD,
    ...(layout.stageResult === true ? { result: workerResult() } : {}),
  };
}

function transition(action: Record<string, unknown>): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    ...action,
  });
}

interface FixtureLayoutOptions {
  readonly stageAttempt?: number;
  readonly secondStage?: boolean;
  readonly foreignWorkspace?: boolean;
  readonly oldAttempt?: boolean;
  readonly stageStatus?: StageRecord["status"];
  readonly stageResult?: boolean;
  readonly reservedCostUsd?: number;
}

async function makeFixture(
  configOverrides: Partial<RunRecord["config"]> = {},
  layout: FixtureLayoutOptions = {},
): Promise<MetadataFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2b2a-metadata-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await mkdir(sourceRoot, { mode: 0o755 });
  await mkdir(storageRoot, { mode: 0o700 });
  const inputPath = path.join(sourceRoot, "hello.txt");
  await writeFile(inputPath, "hello from r2b2a\n", "utf8");
  const descriptor = await prepareNativeHarnessWorkspace(
    { sourceRoot, storageRoot, inputFiles: ["hello.txt"] },
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
  await owner.commit(owner.snapshot().revision, transition({
    action: "settle",
    admissionId: ADMISSION_ID,
    mode: "unknown",
    observedUsd: OBSERVED_USD,
    concurrencyHeld: true,
  }));

  const store = new RunStore(path.join(descriptor.storeRoot, "runs"));
  const workspace = layout.foreignWorkspace
    ? path.join(root, "foreign-workspace")
    : descriptor.workspaceRoot;
  const created = await store.createWithRecoveryOrigin(
    runRecord(descriptor, configOverrides, workspace),
    JSON.stringify(seed(descriptor, prepared)),
  );
  const runDir = store.runDir(RUN_ID);
  const attempt = layout.oldAttempt
    ? Math.max(layout.stageAttempt ?? 2, 2)
    : layout.stageAttempt ?? 1;
  const stageIds: readonly StageId[] = layout.secondStage
    ? ["baseline", "inv_edit"]
    : ["baseline"];
  const plans = stageIds.map((stage) => {
    const attempts = layout.oldAttempt ? [1, attempt] : [attempt];
    const rows = attempts.map((rowAttempt) => {
      const attemptDir = path.join(
        runDir,
        "stages",
        stage,
        `attempt-${rowAttempt}-${randomUUID()}`,
      );
      return {
        attempt: rowAttempt,
        cwd: path.join(attemptDir, "workspace"),
        artifactDir: path.join(attemptDir, "artifacts"),
      };
    });
    const actual = rows.find((row) => row.attempt === attempt)!;
    return {
      stage,
      attempt,
      cwd: actual.cwd,
      artifactDir: actual.artifactDir,
      rows,
    };
  });
  const stages: Partial<Record<StageId, StageRecord>> = {};
  for (const plan of plans) {
    stages[plan.stage] = stageRecord(plan.stage, plan.cwd, plan.attempt, layout);
  }
  const saved = await store.save({ ...created, stages }, created.revision);
  const runText = await readFile(path.join(runDir, "run.json"), "utf8");

  const inventory: NativeHarnessDispatchInventoryHandle = await createNativeHarnessDispatchInventory({
    storeRoot: store.root,
    runId: RUN_ID,
  });
  const innerDeadlineAt = Date.parse(saved.createdAt) + RUN_DURATION_MS;
  const inventoryRows = plans.flatMap((plan) => plan.rows.map((row) => ({
    stage: plan.stage,
    ...row,
  })));
  for (const [index, row] of inventoryRows.entries()) {
    const intent: NativeHarnessDispatchIntent = {
      ordinal: index + 1,
      nonce: randomUUID(),
      stage: row.stage,
      attempt: row.attempt,
      runRevision: saved.revision,
      cwd: row.cwd,
      artifactDir: row.artifactDir,
      intentSha256: `${index}`.repeat(64),
      snapshotSha256: `${index + 1}`.repeat(64),
      innerDeadlineAt,
      requestTimeoutMs: 10_000,
      stageAllocatedCostUsd: STAGE_ALLOCATED_USD,
    };
    await inventory.intend(intent, () => undefined);
  }
  inventory.close();

  const preparedRelativeRoot = path.relative(storageRoot, descriptor.preparedRoot);
  const expected: NativeHarnessReconciliationExpectation = {
    runId: RUN_ID,
    ownerId: OWNER_ID,
    selectorSha256: SELECTOR,
    storageRoot,
    sourceRoot,
    preparedRelativeRoot,
    backendBuildSourceId: SOURCE_ID,
  };
  return {
    root,
    sourceRoot,
    storageRoot,
    descriptor,
    prepared,
    owner,
    run: saved,
    runText,
    sourceText: await readFile(path.join(descriptor.preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE), "utf8"),
    ownerText: await readFile(
      path.join(storageRoot, "accounting-owners", SELECTOR, "owner.json"),
      "utf8",
    ),
    inventoryText: await readFile(path.join(runDir, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE), "utf8"),
    expected,
    now: Date.parse(CREATED_AT) + 5_000,
  };
}

function inputOf(
  f: MetadataFixture,
  overrides: Partial<NativeHarnessReconciliationInput> = {},
): NativeHarnessReconciliationInput {
  return {
    runText: f.runText,
    sourceText: f.sourceText,
    inventoryText: f.inventoryText,
    ownerText: f.ownerText,
    expected: f.expected,
    now: f.now,
    ...overrides,
  };
}

function mutateJson(text: string, mutate: (value: Record<string, any>) => void): string {
  const value = JSON.parse(text) as Record<string, any>;
  mutate(value);
  return `${JSON.stringify(value)}\n`;
}

function reasonList(result: NativeHarnessReconciliationResult): readonly string[] {
  return result.metadata.reasons;
}

let fixture: MetadataFixture;

beforeAll(async () => {
  fixture = await makeFixture();
});

describe("native harness metadata reconciliation", () => {
  test("joins exact real-temp metadata and preserves unknown cost and held concurrency", () => {
    const result = reconcileNativeHarnessMetadata(inputOf(fixture));
    expect(result.schema).toBe("omp-agent.native-harness-reconciliation.v1");
    expect(result.metadata).toEqual({ compatible: true, reasons: [] });
    expect(result.readOnly).toBe(true);
    expect(result.resumeAvailable).toBe(false);
    expect(result.processes).toBe("not-inspected");
    expect(result.artifacts).toBe("not-inspected");
    expect(result.run?.id).toBe(RUN_ID);
    expect(result.source?.sha256).toBe(fixture.prepared.source.sha256);
    expect(result.source?.inputManifestSha256).toBe(fixture.descriptor.manifestSha256);
    expect(result.owner?.projection).toEqual({
      accountedUsd: MAX_COST_USD,
      observedUsd: 0.1,
      unknownUsd: MAX_COST_USD,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(result.owner?.admission?.settlement).toEqual({
      revision: 4,
      mode: "unknown",
      observedUsd: OBSERVED_USD,
      concurrencyHeld: true,
    });
    expect(result.inventory?.schema).toBe("v2");
    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.latest?.state).toBe("intended");
    expect(result.coverage.latest?.layoutMatches).toBe(true);
    expect(result.coverage.stages[0]?.layoutMatches).toBe(true);
    expect(result.reservation).toEqual({
      status: "checked",
      stage: "baseline",
      attempt: 1,
      actualReservedCostUsd: STAGE_ALLOCATED_USD,
      inventoryAllocatedCostUsd: STAGE_ALLOCATED_USD,
      matches: true,
      checks: [{
        stage: "baseline",
        attempt: 1,
        actualReservedCostUsd: STAGE_ALLOCATED_USD,
        inventoryAllocatedCostUsd: STAGE_ALLOCATED_USD,
        matches: true,
      }],
    });
    expect(result.deadline).toEqual({
      innerDeadlineAt: Date.parse(CREATED_AT) + RUN_DURATION_MS,
      outerDeadlineAt: ADMITTED_AT + SOURCE_DURATION_MS,
      gateDeadlineAt: Date.parse(CREATED_AT) + RUN_DURATION_MS,
      observedAt: fixture.now,
      expired: false,
    });
    expect(result.build.labelCompatible).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metadata.reasons)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("b2a metadata fixture task");
  });

  test("uses only the four supplied texts: removing the real roots leaves the pure call unchanged", async () => {
    const own = await makeFixture();
    const captured = inputOf(own);
    await rm(own.root, { recursive: true, force: true });
    const result = reconcileNativeHarnessMetadata(captured);
    expect(result.metadata.compatible).toBe(true);
    expect(result.coverage.status).toBe("complete");
    expect(result.owner?.projection.unknownUsd).toBe(MAX_COST_USD);
  });

  test("refuses missing, corrupt, v1 and oversized inventory with bounded reasons", () => {
    const corrupt = reconcileNativeHarnessMetadata(inputOf(fixture, { inventoryText: "{" }));
    expect(corrupt.metadata.compatible).toBe(false);
    expect(reasonList(corrupt)).toContain("inventory-invalid");
    expect(corrupt.coverage.status).toBe("unknown");

    const v1Text = mutateJson(fixture.inventoryText, (value) => {
      value.schema = NATIVE_HARNESS_DISPATCH_INVENTORY_SCHEMA;
    });
    const v1 = reconcileNativeHarnessMetadata(inputOf(fixture, { inventoryText: v1Text }));
    expect(v1.metadata.compatible).toBe(false);
    expect(reasonList(v1)).toContain("inventory-v1-diagnostic-only");
    expect(v1.coverage.status).toBe("unknown");

    const oversized = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: "x".repeat(256 * 1024 + 1),
    }));
    expect(reasonList(oversized)).toEqual(["inventory-too-large"]);
    expect(oversized.coverage.reasons).toContain("coverage-unavailable");
  });

  test("refuses owner identity, admission and reserve-revision mismatches", () => {
    const wrongOwner = reconcileNativeHarnessMetadata(inputOf(fixture, {
      ownerText: mutateJson(fixture.ownerText, (value) => {
        value.ownerId = SECOND_OWNER_ID;
      }),
    }));
    expect(reasonList(wrongOwner)).toContain("accounting-identity-mismatch");

    const wrongAdmission = reconcileNativeHarnessMetadata(inputOf(fixture, {
      ownerText: mutateJson(fixture.ownerText, (value) => {
        value.admissions[0].admissionId = SECOND_ADMISSION_ID;
      }),
    }));
    expect(reasonList(wrongAdmission)).toContain("accounting-admission-mismatch");

    const wrongRevision = reconcileNativeHarnessMetadata(inputOf(fixture, {
      runText: mutateJson(fixture.runText, (value) => {
        value.recoveryOrigin.seed.accountingOwnerRevision = 2;
      }),
    }));
    expect(reasonList(wrongRevision)).toContain("source-reserve-revision-mismatch");
  });

  test("refuses reordered source bytes and source expectation drift", () => {
    const parsed = JSON.parse(fixture.sourceText) as Record<string, unknown>;
    const reordered = `${JSON.stringify(Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
    ))}\n`;
    const result = reconcileNativeHarnessMetadata(inputOf(fixture, { sourceText: reordered }));
    expect(reasonList(result)).toContain("source-descriptor-sha-mismatch");
    expect(result.source?.sha256).toBe(sha256Hex(Buffer.from(reordered, "utf8")));
    expect(result.source?.sha256).not.toBe(fixture.prepared.source.sha256);

    const wrongRoot = reconcileNativeHarnessMetadata(inputOf(fixture, {
      expected: { ...fixture.expected, sourceRoot: `${fixture.expected.sourceRoot}-other` },
    }));
    expect(reasonList(wrongRoot)).toContain("source-identity-mismatch");
  });

  test("refuses origin and fixed budget drift", () => {
    const originDrift = reconcileNativeHarnessMetadata(inputOf(fixture, {
      runText: mutateJson(fixture.runText, (value) => {
        value.recoveryOrigin.createdAt = new Date(Date.parse(CREATED_AT) + 1).toISOString();
      }),
    }));
    expect(reasonList(originDrift)).toContain("run-invalid");

    const deadlineDrift = reconcileNativeHarnessMetadata(inputOf(fixture, {
      runText: mutateJson(fixture.runText, (value) => {
        value.recoveryOrigin.seed.deadlineAt -= 1;
      }),
    }));
    expect(reasonList(deadlineDrift)).toContain("source-deadline-mismatch");

    const fixedDrift = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        value.fixed.maxCostUsd = 0.5;
      }),
    }));
    expect(reasonList(fixedDrift)).toContain("inventory-fixed-mismatch");
  });

  test("reports attempt gaps, extras, duplicates, revision drift and path mismatch separately", () => {
    const extra = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        value.dispatches[0].attempt = 2;
      }),
    }));
    expect(extra.metadata.compatible).toBe(true);
    expect(extra.coverage.status).toBe("unknown");
    expect(extra.coverage.reasons).toContain("attempt-extra");
    expect(extra.coverage.reasons).toContain("latest-stage-mismatch");

    const revision = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        value.dispatches[0].runRevision = fixture.run.revision + 1;
      }),
    }));
    expect(revision.metadata.compatible).toBe(true);
    expect(revision.coverage.reasons).toContain("coverage-row-association-mismatch");

    const duplicate = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        const row = { ...value.dispatches[0] };
        row.ordinal = 2;
        row.nonce = randomUUID();
        value.dispatches.push(row);
      }),
    }));
    expect(duplicate.coverage.reasons).toContain("attempt-duplicate");

    const missing = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        value.dispatches = [];
      }),
    }));
    expect(missing.coverage.reasons).toContain("attempt-missing");

    const pathDrift = reconcileNativeHarnessMetadata(inputOf(fixture, {
      inventoryText: mutateJson(fixture.inventoryText, (value) => {
        value.dispatches[0].cwd = path.join(fixture.root, "other-cwd");
      }),
    }));
    expect(pathDrift.coverage.reasons).toContain("latest-path-mismatch");
    expect(pathDrift.coverage.reasons).toContain("latest-artifact-path-mismatch");
  });

  test("observes an elapsed deadline at min(inner, outer) without rewriting it", () => {
    const gate = Math.min(
      Date.parse(CREATED_AT) + RUN_DURATION_MS,
      ADMITTED_AT + SOURCE_DURATION_MS,
    );
    const result = reconcileNativeHarnessMetadata(inputOf(fixture, { now: gate }));
    expect(result.metadata.compatible).toBe(true);
    expect(result.deadline.expired).toBe(true);
    expect(result.deadline.gateDeadlineAt).toBe(gate);
    expect(result.deadline.innerDeadlineAt).toBe(Date.parse(CREATED_AT) + RUN_DURATION_MS);
    expect(result.deadline.outerDeadlineAt).toBe(ADMITTED_AT + SOURCE_DURATION_MS);
  });

  test("separates run profile mismatches from build-label compatibility", async () => {
    const alternate = await makeFixture({ domain: "other-domain" });
    const profile = reconcileNativeHarnessMetadata(inputOf(alternate));
    expect(reasonList(profile)).toContain("run-profile-mismatch");

    const otherBuild = reconcileNativeHarnessMetadata(inputOf(fixture, {
      expected: { ...fixture.expected, backendBuildSourceId: "f".repeat(64) },
    }));
    expect(otherBuild.metadata.compatible).toBe(true);
    expect(otherBuild.build.labelCompatible).toBe(false);
    expect(otherBuild.build.sourceIntegrity).toBe("build-label-only");
  });

  test("refuses a run workspace outside the exact private prepared workspace", async () => {
    const foreign = await makeFixture({}, { foreignWorkspace: true });
    const result = reconcileNativeHarnessMetadata(inputOf(foreign));
    expect(reasonList(result)).toContain("run-workspace-mismatch");
    expect(result.metadata.compatible).toBe(false);
    expect(result.coverage.status).toBe("complete");
  });

  test("returns promptly for a safe-integer enormous recorded attempt without looping to it", async () => {
    const giant = await makeFixture({}, { stageAttempt: Number.MAX_SAFE_INTEGER });
    const started = performance.now();
    const result = reconcileNativeHarnessMetadata(inputOf(giant));
    const elapsed = performance.now() - started;
    expect(result.coverage.status).toBe("unknown");
    expect(result.coverage.reasons).toContain("attempt-gap");
    expect(result.coverage.stages[0]?.actualAttempt).toBe(Number.MAX_SAFE_INTEGER);
    expect(elapsed).toBeLessThan(1_000);
  });

  test("checks every stage's latest row and every running reservation, not only the last row", async () => {
    const two = await makeFixture({}, { secondStage: true });
    const pathDrift = reconcileNativeHarnessMetadata(inputOf(two, {
      inventoryText: mutateJson(two.inventoryText, (value) => {
        value.dispatches[0].cwd = path.join(two.root, "other-cwd");
      }),
    }));
    expect(pathDrift.coverage.status).toBe("unknown");
    expect(pathDrift.coverage.reasons).toContain("latest-path-mismatch");
    expect(pathDrift.coverage.latest?.stage).toBe("inv_edit");
    expect(pathDrift.coverage.latest?.cwdMatches).toBe(true);
    const baseline = pathDrift.coverage.stages.find((stage) => stage.stage === "baseline");
    expect(baseline?.cwdMatches).toBe(false);
    expect(baseline?.layoutMatches).toBe(false);

    const allocation = reconcileNativeHarnessMetadata(inputOf(two, {
      inventoryText: mutateJson(two.inventoryText, (value) => {
        value.dispatches[0].stageAllocatedCostUsd = 0.05;
      }),
    }));
    expect(allocation.metadata.compatible).toBe(true);
    expect(allocation.coverage.status).toBe("unknown");
    expect(allocation.coverage.reasons).toContain("stage-reservation-mismatch");
    expect(allocation.reservation.status).toBe("mismatch");
    expect(allocation.reservation.matches).toBe(false);
    expect(allocation.reservation.checks).toHaveLength(2);
    expect(allocation.reservation.checks.find((check) => check.stage === "baseline")?.matches).toBe(false);
    expect(allocation.reservation.checks.find((check) => check.stage === "inv_edit")?.matches).toBe(true);
  });

  test("refuses an old attempt row moved with its artifacts to a foreign run root", async () => {
    const old = await makeFixture({}, { oldAttempt: true });
    const foreignRunRoot = path.join(old.root, "foreign-run");
    const moved = mutateJson(old.inventoryText, (value) => {
      const attemptDir = path.join(
        foreignRunRoot,
        "stages",
        "baseline",
        `attempt-1-${randomUUID()}`,
      );
      value.dispatches[0].cwd = path.join(attemptDir, "workspace");
      value.dispatches[0].artifactDir = path.join(attemptDir, "artifacts");
    });
    const result = reconcileNativeHarnessMetadata(inputOf(old, { inventoryText: moved }));
    expect(result.coverage.status).toBe("unknown");
    expect(result.coverage.reasons).toContain("coverage-row-association-mismatch");
    expect(result.coverage.latest?.attempt).toBe(2);
    expect(result.coverage.latest?.cwdMatches).toBe(true);
    expect(result.coverage.stages[0]?.complete).toBe(false);
    expect(result.reservation.status).toBe("checked");
  });

  test("keeps running + completed result + reserved0 consistent and skips reservation comparison", async () => {
    const intermediate = await makeFixture({}, { stageResult: true, reservedCostUsd: 0 });
    const result = reconcileNativeHarnessMetadata(inputOf(intermediate));
    expect(result.metadata.compatible).toBe(true);
    expect(result.coverage.status).toBe("complete");
    expect(result.reservation.status).toBe("not-applicable");
    expect(result.reservation.checks).toEqual([]);
    expect(result.coverage.latest?.actualStatus).toBe("running");
    expect(result.coverage.latest?.resultObserved).toBe(true);
    expect(result.coverage.latest?.resultStatus).toBe("completed");
  });

  test("keeps a failed StageRecord distinct from its completed WorkerResult", async () => {
    const failed = await makeFixture({}, {
      stageStatus: "failed",
      stageResult: true,
      reservedCostUsd: 0,
    });
    const terminal = mutateJson(failed.inventoryText, (value) => {
      value.dispatches[0].state = "terminal";
      value.dispatches[0].cleanup = { observationKind: "synthetic-fixture" };
      value.dispatches[0].terminal = {
        outcome: "failed",
        observationKind: "synthetic-fixture",
        observedAt: failed.now,
        resultSha256: null,
        usageCostUsd: null,
        usageEstimated: false,
      };
    });
    const result = reconcileNativeHarnessMetadata(inputOf(failed, { inventoryText: terminal }));
    expect(result.metadata.compatible).toBe(true);
    expect(result.coverage.status).toBe("complete");
    expect(result.reservation.status).toBe("not-applicable");
    expect(result.coverage.latest?.actualStatus).toBe("failed");
    expect(result.coverage.latest?.state).toBe("terminal");
    expect(result.coverage.latest?.terminalOutcome).toBe("failed");
    expect(result.coverage.latest?.resultObserved).toBe(true);
    expect(result.coverage.latest?.resultStatus).toBe("completed");
  });

  test("does not equate StageRecord status with inventory terminal state", () => {
    const terminal = mutateJson(fixture.inventoryText, (value) => {
      value.dispatches[0].state = "terminal";
      value.dispatches[0].cleanup = { observationKind: "synthetic-fixture" };
      value.dispatches[0].terminal = {
        outcome: "failed",
        observationKind: "synthetic-fixture",
        observedAt: fixture.now,
        resultSha256: null,
        usageCostUsd: null,
        usageEstimated: false,
      };
    });
    const result = reconcileNativeHarnessMetadata(inputOf(fixture, { inventoryText: terminal }));
    expect(result.coverage.latest?.state).toBe("terminal");
    expect(result.coverage.latest?.actualStatus).toBe("running");
    expect(result.coverage.latest?.resultObserved).toBe(false);
    expect(reasonList(result)).not.toContain("run-profile-mismatch");
  });
});
