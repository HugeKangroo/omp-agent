import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  NATIVE_HARNESS_ACCOUNTING_RECOVERY_TRANSITION_SCHEMA,
  NativeHarnessAccountingError,
  createNativeHarnessAccountingOwner,
  createNativeHarnessRecoveryAccountingOwner,
  decodeNativeHarnessAccountingText,
  observeNativeHarnessAccountingOwner,
  openNativeHarnessAccountingOwner,
  projectNativeHarnessAccounting,
  type NativeHarnessAccountingAdmission,
  type NativeHarnessAccountingBudgetBlock,
  type NativeHarnessAccountingCheckpoint,
  type NativeHarnessAccountingContinuationEvent,
  type NativeHarnessAccountingHandle,
  type NativeHarnessAccountingPrepared,
  type NativeHarnessAccountingProjection,
  type NativeHarnessAccountingSettlement,
  type NativeHarnessAccountingTestOptions,
  type NativeHarnessRecoveryAccountingAdmission,
  type NativeHarnessRecoveryAccountingCheckpoint,
  type NativeHarnessRecoveryAccountingHandle,
} from "../../src/native-harness-accounting.ts";
import type { NativeHarnessDelegationLimits } from "../../src/native-harness-delegation.ts";
import {
  nodeFileIo,
  type NativeFileHandle,
  type NativeFileIo,
} from "../../src/native-work.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const SELECTOR = "a".repeat(64);
const CREATED_AT = 1_700_000_000_000;
const ADMITTED_AT = 1_700_000_100_000;
const LIMITS: NativeHarnessDelegationLimits = Object.freeze({
  maxRetainedOperations: 16,
  maxConcurrent: 1,
  perRunUsd: 1,
  lifetimeUsd: 5,
  maxDurationMs: 300_000,
  cleanupGraceMs: 30_000,
});
const LIMITS_TEXT = JSON.stringify(LIMITS);
const IDENTITY = { ownerId: OWNER, selectorSha256: SELECTOR };
const V2 = NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2;
const V2_TRANSITION = NATIVE_HARNESS_ACCOUNTING_RECOVERY_TRANSITION_SCHEMA;

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function hash(fill: string): string {
  return fill.repeat(64);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function prepared(n: number, root = `omp-harness-${n}`): NativeHarnessAccountingPrepared {
  return {
    preparedRelativeRoot: root,
    storeRelativeRoot: `${root}/store`,
    inputManifestSha256: hash("b"),
    sourceDescriptorSha256: hash("c"),
  };
}

function v1Row(
  n: number,
  overrides: Partial<NativeHarnessAccountingAdmission> = {},
): NativeHarnessAccountingAdmission {
  return {
    admissionId: uuid(n),
    sourceAssociationSha256: hash((n % 10).toString()),
    admittedAt: ADMITTED_AT + n,
    deadlineAt: ADMITTED_AT + n + LIMITS.maxDurationMs,
    allocatedUsd: LIMITS.perRunUsd,
    reserveRevision: n,
    prepared: null,
    runId: null,
    settlement: null,
    ...overrides,
  };
}

function v2Row(
  n: number,
  overrides: Partial<NativeHarnessRecoveryAccountingAdmission> = {},
): NativeHarnessRecoveryAccountingAdmission {
  return {
    ...v1Row(n),
    preparedRevision: null,
    runRevision: null,
    ...overrides,
  };
}

function checkpointV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: V2,
    revision: 0,
    ownerId: OWNER,
    selectorSha256: SELECTOR,
    createdAt: CREATED_AT,
    limits: LIMITS,
    budgetBlock: null,
    admissions: [],
    events: [],
    ...overrides,
  };
}

function checkpointText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireRecoveryCheckpoint(
  checkpoint: NativeHarnessAccountingCheckpoint,
): NativeHarnessRecoveryAccountingCheckpoint {
  if (checkpoint.schema !== V2) throw new Error("expected a V2 recovery checkpoint");
  return checkpoint;
}

function decodeV2(value: unknown): NativeHarnessRecoveryAccountingCheckpoint {
  return requireRecoveryCheckpoint(
    decodeNativeHarnessAccountingText(checkpointText(value), IDENTITY),
  );
}

function decodeV2Raw(text: string): NativeHarnessRecoveryAccountingCheckpoint {
  return requireRecoveryCheckpoint(
    decodeNativeHarnessAccountingText(text, IDENTITY),
  );
}

function expectDecodeV2Failure(value: unknown): void {
  expect(() => decodeV2(value)).toThrow(NativeHarnessAccountingError);
}

function claimEvent(
  revision: number,
  admissionNumber: number,
  continuationId: string,
  predecessorId: string | null,
  claimedAt: number,
): NativeHarnessAccountingContinuationEvent {
  return { revision, kind: "claim", admissionId: uuid(admissionNumber), continuationId, predecessorId, claimedAt };
}

function finishEvent(
  revision: number,
  admissionNumber: number,
  continuationId: string,
  mode: "known" | "unknown",
  observedUsd: number | null,
  concurrencyHeld: boolean,
): NativeHarnessAccountingContinuationEvent {
  return {
    revision,
    kind: "finish",
    admissionId: uuid(admissionNumber),
    continuationId,
    mode,
    observedUsd,
    concurrencyHeld,
  };
}

function observeEvent(
  revision: number,
  admissionNumber: number,
  continuationId: string | null,
  observationId: string,
  observedUsd: number,
  workerOverspend = false,
): NativeHarnessAccountingContinuationEvent {
  return {
    revision,
    kind: "observe-cost",
    admissionId: uuid(admissionNumber),
    continuationId,
    observationId,
    observedUsd,
    workerOverspend,
  };
}

function reserveText(n: number, reserveRevision?: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "reserve",
    admissionId: uuid(n),
    sourceAssociationSha256: hash("a"),
    admittedAt: ADMITTED_AT + n,
    deadlineAt: ADMITTED_AT + n + LIMITS.maxDurationMs,
    allocatedUsd: LIMITS.perRunUsd,
    ...(reserveRevision === undefined ? {} : { reserveRevision }),
    ...overrides,
  });
}

function bindPreparedText(n: number, value = prepared(n)): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindPrepared",
    admissionId: uuid(n),
    prepared: value,
  });
}

function bindRunText(n: number, runId = uuid(100 + n)): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindRun",
    admissionId: uuid(n),
    runId,
  });
}

function settleText(
  n: number,
  mode: "no-dispatch" | "known" | "unknown",
  observedUsd: number | null,
  held: boolean,
): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "settle",
    admissionId: uuid(n),
    mode,
    observedUsd,
    concurrencyHeld: held,
  });
}

function blockText(n: number): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "blockBudget",
    admissionId: uuid(n),
  });
}

function claimText(
  n: number,
  continuationId: string,
  predecessorId: string | null,
  claimedAt: number,
): string {
  return JSON.stringify({
    schema: V2_TRANSITION,
    action: "claimContinuation",
    admissionId: uuid(n),
    continuationId,
    predecessorId,
    claimedAt,
  });
}

function finishText(
  n: number,
  continuationId: string,
  mode: "known" | "unknown",
  observedUsd: number | null,
  concurrencyHeld: boolean,
): string {
  return JSON.stringify({
    schema: V2_TRANSITION,
    action: "finishContinuation",
    admissionId: uuid(n),
    continuationId,
    mode,
    observedUsd,
    concurrencyHeld,
  });
}

function observeText(
  n: number,
  continuationId: string | null,
  observationId: string,
  observedUsd: number,
  workerOverspend = false,
): string {
  return JSON.stringify({
    schema: V2_TRANSITION,
    action: "observeCost",
    admissionId: uuid(n),
    continuationId,
    observationId,
    observedUsd,
    workerOverspend,
  });
}

async function makeRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-native-accounting-v2-"));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

function primaryPath(root: string, selector = SELECTOR): string {
  return path.join(root, "accounting-owners", selector, "owner.json");
}

async function primaryText(root: string, selector = SELECTOR): Promise<string> {
  return readFile(primaryPath(root, selector), "utf8");
}

function createOptions(root: string, overrides: Partial<{
  ownerId: string;
  selectorSha256: string;
  createdAt: number;
  limitsText: string;
}> = {}) {
  return {
    storageRoot: root,
    selectorSha256: overrides.selectorSha256 ?? SELECTOR,
    ownerId: overrides.ownerId ?? OWNER,
    createdAt: overrides.createdAt ?? CREATED_AT,
    limitsText: overrides.limitsText ?? LIMITS_TEXT,
  };
}

async function createV1(
  root: string,
  options: { limitsText?: string } = {},
): Promise<NativeHarnessAccountingHandle> {
  return createNativeHarnessAccountingOwner(createOptions(root, options));
}

async function createV2(
  root: string,
  options: {
    limitsText?: string;
    hook?: (event: { readonly path: string; readonly revision: number }) => void | Promise<void>;
  } = {},
): Promise<NativeHarnessRecoveryAccountingHandle> {
  return createNativeHarnessRecoveryAccountingOwner(
    createOptions(root, options),
    options.hook === undefined ? undefined : { testAfterPrimaryWrite: options.hook },
  );
}

async function openV2(
  root: string,
  options: {
    fileIo?: NativeFileIo;
    hook?: (event: { readonly path: string; readonly revision: number }) => void | Promise<void>;
  } = {},
): Promise<NativeHarnessRecoveryAccountingHandle> {
  const testOptions: NativeHarnessAccountingTestOptions | undefined =
    options.fileIo === undefined && options.hook === undefined
      ? undefined
      : {
        ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
        ...(options.hook === undefined ? {} : { testAfterPrimaryWrite: options.hook }),
      };
  const generic = await openNativeHarnessAccountingOwner(
    {
      storageRoot: root,
      selectorSha256: SELECTOR,
      ownerId: OWNER,
    },
    testOptions,
  );
  const initial = requireRecoveryCheckpoint(generic.snapshot());
  expect(initial.schema).toBe(V2);
  return {
    snapshot: () => requireRecoveryCheckpoint(generic.snapshot()),
    commit: async (expectedRevision, transitionText) => requireRecoveryCheckpoint(
      await generic.commit(expectedRevision, transitionText),
    ),
    close: () => generic.close(),
  };
}

async function observedV2(root: string): Promise<NativeHarnessRecoveryAccountingCheckpoint> {
  const observed = await observeNativeHarnessAccountingOwner({
    storageRoot: root,
    selectorSha256: SELECTOR,
  });
  return requireRecoveryCheckpoint(observed.checkpoint);
}

async function commit(handle: NativeHarnessRecoveryAccountingHandle, text: string) {
  return handle.commit(handle.snapshot().revision, text);
}

async function reserve(handle: NativeHarnessRecoveryAccountingHandle, n: number) {
  return commit(handle, reserveText(n, handle.snapshot().revision + 1));
}

async function bindPrepared(handle: NativeHarnessRecoveryAccountingHandle, n: number, value = prepared(n)) {
  return commit(handle, bindPreparedText(n, value));
}

async function bindRun(handle: NativeHarnessRecoveryAccountingHandle, n: number, runId = uuid(100 + n)) {
  return commit(handle, bindRunText(n, runId));
}

async function settle(
  handle: NativeHarnessRecoveryAccountingHandle,
  n: number,
  mode: "no-dispatch" | "known" | "unknown",
  observedUsd: number | null,
  held: boolean,
) {
  return commit(handle, settleText(n, mode, observedUsd, held));
}

async function claim(
  handle: NativeHarnessRecoveryAccountingHandle,
  n: number,
  continuationId: string,
  predecessorId: string | null,
  claimedAt: number,
) {
  return commit(handle, claimText(n, continuationId, predecessorId, claimedAt));
}

async function finish(
  handle: NativeHarnessRecoveryAccountingHandle,
  n: number,
  continuationId: string,
  mode: "known" | "unknown",
  observedUsd: number | null,
  held: boolean,
) {
  return commit(handle, finishText(n, continuationId, mode, observedUsd, held));
}

async function observe(
  handle: NativeHarnessRecoveryAccountingHandle,
  n: number,
  continuationId: string | null,
  observationId: string,
  observedUsd: number,
  workerOverspend = false,
) {
  return commit(handle, observeText(n, continuationId, observationId, observedUsd, workerOverspend));
}

function projection(handle: NativeHarnessRecoveryAccountingHandle): NativeHarnessAccountingProjection {
  return projectNativeHarnessAccounting(handle.snapshot());
}

function projectionOf(checkpoint: NativeHarnessRecoveryAccountingCheckpoint): NativeHarnessAccountingProjection {
  return projectNativeHarnessAccounting(checkpoint);
}

function known(revision: number, observedUsd: number): NativeHarnessAccountingSettlement {
  return { revision, mode: "known", observedUsd, concurrencyHeld: false };
}

function unknown(
  revision: number,
  observedUsd: number | null,
  held: boolean,
): NativeHarnessAccountingSettlement {
  return { revision, mode: "unknown", observedUsd, concurrencyHeld: held };
}

function block(revision: number, admissionNumber = 1): NativeHarnessAccountingBudgetBlock {
  return { admissionId: uuid(admissionNumber), revision, reason: "observed-worker-overspend" };
}

describe("V2 creation, version boundary and generic open", () => {
  test("V1 remains the default and refuses all three continuation actions without mutation", async () => {
    const root = await makeRoot();
    const handle = await createV1(root);
    expect(handle.snapshot().schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA);
    const beforeText = await primaryText(root);
    const before = JSON.stringify(handle.snapshot());
    for (const text of [
      claimText(1, uuid(300), null, ADMITTED_AT),
      finishText(1, uuid(300), "unknown", null, false),
      observeText(1, null, uuid(400), 0.1),
    ]) {
      await expect(handle.commit(0, text)).rejects.toMatchObject({
        name: "NativeHarnessAccountingError",
        code: "invalid-transition",
      });
      expect(handle.snapshot().revision).toBe(0);
      expect(JSON.stringify(handle.snapshot())).toBe(before);
      expect(await primaryText(root)).toBe(beforeText);
    }
    handle.close();
  });

  test("explicit V2 creation opens generically and continues without migration", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    const initial = handle.snapshot();
    expect(initial.schema).toBe(V2);
    expect(initial.events).toEqual([]);
    expect(projection(handle)).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 0,
      budgetBlocked: false,
    });

    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    const firstClaim = uuid(300);
    await claim(handle, 1, firstClaim, null, ADMITTED_AT + 10);
    const snapshot = handle.snapshot();
    expect(snapshot.admissions[0]!.preparedRevision).toBe(2);
    expect(snapshot.admissions[0]!.runRevision).toBe(3);
    expect(snapshot.events).toEqual([
      {
        revision: 4,
        kind: "claim",
        admissionId: uuid(1),
        continuationId: firstClaim,
        predecessorId: null,
        claimedAt: ADMITTED_AT + 10,
      },
    ]);
    handle.close();

    const reopened = await openV2(root);
    expect(reopened.snapshot()).toEqual(snapshot);
    await observe(reopened, 1, firstClaim, uuid(401), 0.2);
    expect(reopened.snapshot().revision).toBe(5);
    expect(reopened.snapshot().schema).toBe(V2);
    reopened.close();

    const observed = await observedV2(root);
    expect(observed.schema).toBe(V2);
    expect(observed.revision).toBe(5);
    expect(observed.events).toHaveLength(2);
    const decoded = decodeV2Raw(await primaryText(root));
    expect(decoded).toEqual(observed);
    expect(projectionOf(decoded).observedUsd).toBe(0.2);
  });

  test("an existing owner directory refuses V2 creation and never upgrades V1", async () => {
    const root = await makeRoot();
    const v1 = await createV1(root);
    expect(v1.snapshot().schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA);
    v1.close();
    const before = await primaryText(root);

    await expect(createV2(root)).rejects.toMatchObject({
      name: "NativeHarnessAccountingError",
      code: "conflict",
    });
    await expect(createV1(root)).rejects.toMatchObject({
      name: "NativeHarnessAccountingError",
      code: "conflict",
    });
    expect(await primaryText(root)).toBe(before);

    const v2Root = await makeRoot();
    const v2 = await createV2(v2Root);
    v2.close();
    await expect(createV1(v2Root)).rejects.toMatchObject({
      name: "NativeHarnessAccountingError",
      code: "conflict",
    });
    await expect(createV2(v2Root)).rejects.toMatchObject({
      name: "NativeHarnessAccountingError",
      code: "conflict",
    });
  });
});

describe("V2 continuation accounting semantics", () => {
  test("known refund is re-covered by a claim and later cycles do not duplicate allocation", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    expect(projection(handle).accountedUsd).toBe(0.2);

    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(projection(handle).unknownUsd).toBe(0);
    expect(projection(handle).activeOperations).toBe(1);

    await finish(handle, 1, claimId, "unknown", null, false);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(projection(handle).unknownUsd).toBe(1);
    expect(projection(handle).activeOperations).toBe(0);

    const second = uuid(301);
    await claim(handle, 1, second, claimId, ADMITTED_AT + 20);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(projection(handle).unknownUsd).toBe(1);
    await finish(handle, 1, second, "unknown", null, false);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(projection(handle).unknownUsd).toBe(1);
    expect(handle.snapshot().admissions[0]!.settlement).toEqual(known(4, 0.2));
  });

  test("a claim cannot re-cover refunded allocation already consumed by another admission", async () => {
    const root = await makeRoot();
    const handle = await createV2(root, {
      limitsText: JSON.stringify({ ...LIMITS, lifetimeUsd: 1.5 }),
    });
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    await reserve(handle, 2);
    expect(projection(handle).accountedUsd).toBe(1.2);
    const before = await primaryText(root);
    const revision = handle.snapshot().revision;
    await expect(claim(handle, 1, uuid(300), null, ADMITTED_AT + 10))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(before);
  });

  test("released occupancy cannot be reacquired while another admission holds it", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "unknown", 0.2, false);
    expect(projection(handle).activeOperations).toBe(0);
    await reserve(handle, 2);
    expect(projection(handle).activeOperations).toBe(1);
    await expect(claim(handle, 1, uuid(300), null, ADMITTED_AT + 10))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(projection(handle).activeOperations).toBe(1);
  });

  test("held unknown generation transfers the single occupancy instead of incrementing it", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "unknown", 0.2, true);
    expect(projection(handle).activeOperations).toBe(1);
    await claim(handle, 1, uuid(300), null, ADMITTED_AT + 10);
    expect(projection(handle).activeOperations).toBe(1);
    expect(projection(handle).unknownUsd).toBe(1);
    expect(projection(handle).accountedUsd).toBe(1);
  });

  test("originally unsettled and superseded unfinished generations become conservative unknown", async () => {
    const root = await makeRoot();
    const first = await createV2(root);
    await reserve(first, 1);
    await bindPrepared(first, 1);
    await bindRun(first, 1);
    await claim(first, 1, uuid(300), null, ADMITTED_AT + 10);
    expect(projection(first).unknownUsd).toBe(1);
    expect(projection(first).accountedUsd).toBe(1);
    await claim(first, 1, uuid(301), uuid(300), ADMITTED_AT + 20);
    expect(projection(first).unknownUsd).toBe(1);
    expect(projection(first).accountedUsd).toBe(1);
    expect(first.snapshot().events).toHaveLength(2);
    first.close();

    const secondRoot = await makeRoot();
    const second = await createV2(secondRoot);
    await reserve(second, 1);
    await bindPrepared(second, 1);
    await bindRun(second, 1);
    await settle(second, 1, "known", 0.2, false);
    await claim(second, 1, uuid(300), null, ADMITTED_AT + 10);
    expect(projection(second).unknownUsd).toBe(0);
    await claim(second, 1, uuid(301), uuid(300), ADMITTED_AT + 20);
    expect(projection(second).unknownUsd).toBe(1);
    expect(projection(second).accountedUsd).toBe(1);
  });

  test("known finish after a known claim remains known and refunds against cumulative highwater", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    await observe(handle, 1, claimId, uuid(401), 0.5);
    await finish(handle, 1, claimId, "known", 0.5, false);
    expect(projection(handle).accountedUsd).toBe(0.5);
    expect(projection(handle).unknownUsd).toBe(0);
    expect(projection(handle).overspendUsd).toBe(0);
  });
});

describe("V2 closure and replay rejection", () => {
  test("original settlement after a claim is refused live and in forged decoded history", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await claim(handle, 1, uuid(300), null, ADMITTED_AT + 10);
    const before = await primaryText(root);
    const revision = handle.snapshot().revision;
    await expect(settle(handle, 1, "known", 0.2, false))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(before);

    const forged = JSON.parse(JSON.stringify(handle.snapshot())) as Record<string, unknown>;
    forged.revision = 5;
    const admissions = forged.admissions as Record<string, unknown>[];
    admissions[0]!.settlement = known(5, 0.2);
    expectDecodeV2Failure(forged);
  });

  test("stale generation finish is refused and the latest generation is finish-once", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    const first = uuid(300);
    const second = uuid(301);
    await claim(handle, 1, first, null, ADMITTED_AT + 10);
    await claim(handle, 1, second, first, ADMITTED_AT + 20);
    const before = await primaryText(root);
    const revision = handle.snapshot().revision;
    await expect(finish(handle, 1, first, "unknown", null, false))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(before);
    await finish(handle, 1, second, "unknown", null, false);
    await expect(finish(handle, 1, second, "unknown", null, false))
      .rejects.toMatchObject({ code: "invalid-transition" });
  });

  test("predecessor, claim time and unchanged identity/limits are exact", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    const before = JSON.stringify(handle.snapshot());
    const revision = handle.snapshot().revision;
    await expect(claim(handle, 1, uuid(300), uuid(999), ADMITTED_AT + 10))
      .rejects.toMatchObject({ code: "invalid-transition" });
    await expect(claim(handle, 1, uuid(300), null, ADMITTED_AT - 1))
      .rejects.toMatchObject({ code: "invalid-transition" });
    await expect(claim(handle, 1, uuid(300), null, ADMITTED_AT + 1 + LIMITS.maxDurationMs))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(JSON.stringify(handle.snapshot())).toBe(before);
    expect(handle.snapshot().revision).toBe(revision);
    const first = uuid(300);
    await claim(handle, 1, first, null, ADMITTED_AT + LIMITS.maxDurationMs - 1);
    await expect(claim(handle, 1, uuid(301), null, ADMITTED_AT + LIMITS.maxDurationMs - 1))
      .rejects.toMatchObject({ code: "invalid-transition" });
    const snapshot = handle.snapshot();
    expect(snapshot.admissions[0]!.runId).toBe(uuid(101));
    expect(snapshot.admissions[0]!.sourceAssociationSha256).toBe(hash("a"));
    expect(snapshot.limits).toEqual(LIMITS);
    expect(snapshot.events[0]!.revision).toBe(4);
  });

  test("a forged future run binding before a claim is rejected by prefix replay", () => {
    const forged = checkpointV2({
      revision: 4,
      admissions: [
        v2Row(1, {
          reserveRevision: 1,
          prepared: prepared(1),
          preparedRevision: 3,
          runId: uuid(101),
          runRevision: 4,
        }),
      ],
      events: [claimEvent(2, 1, uuid(300), null, ADMITTED_AT + 10)],
    });
    expectDecodeV2Failure(forged);
  });

  test("forged historical reservations or overspend cannot be masked by final values", () => {
    const doubleActive = checkpointV2({
      revision: 2,
      admissions: [
        v2Row(1, { reserveRevision: 1 }),
        v2Row(2, { reserveRevision: 2 }),
      ],
    });
    expectDecodeV2Failure(doubleActive);

    const overspentClaim = checkpointV2({
      revision: 5,
      admissions: [
        v2Row(1, {
          reserveRevision: 1,
          prepared: prepared(1),
          preparedRevision: 2,
          runId: uuid(101),
          runRevision: 3,
        }),
      ],
      events: [
        observeEvent(4, 1, null, uuid(400), 2),
        claimEvent(5, 1, uuid(300), null, ADMITTED_AT + 10),
      ],
    });
    expectDecodeV2Failure(overspentClaim);

    const collidingRevision = checkpointV2({
      revision: 4,
      admissions: [
        v2Row(1, {
          reserveRevision: 1,
          prepared: prepared(1),
          preparedRevision: 2,
          runId: uuid(101),
          runRevision: 3,
        }),
      ],
      events: [observeEvent(3, 1, null, uuid(400), 0.2)],
    });
    expectDecodeV2Failure(collidingRevision);

    const gap = checkpointV2({
      revision: 6,
      admissions: [
        v2Row(1, {
          reserveRevision: 1,
          prepared: prepared(1),
          preparedRevision: 2,
          runId: uuid(101),
          runRevision: 3,
          settlement: known(6, 0.2),
        }),
      ],
      events: [
        claimEvent(4, 1, uuid(300), null, ADMITTED_AT + 10),
        finishEvent(5, 1, uuid(300), "unknown", null, false),
      ],
    });
    expectDecodeV2Failure(gap);
  });
});

describe("V2 observations, duplicates and sticky conditions", () => {
  test("cumulative highwater spans original work and generations; lower late facts add zero cost", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await observe(handle, 1, null, uuid(400), 0.2);
    await settle(handle, 1, "known", 0.2, false);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    await observe(handle, 1, claimId, uuid(401), 0.5);
    await finish(handle, 1, claimId, "known", 0.5, false);
    await observe(handle, 1, null, uuid(402), 0.7);
    expect(projection(handle).observedUsd).toBe(0.7);
    expect(projection(handle).accountedUsd).toBe(0.7);

    const revision = handle.snapshot().revision;
    const events = handle.snapshot().events.length;
    await observe(handle, 1, claimId, uuid(403), 0.6);
    expect(handle.snapshot().revision).toBe(revision + 1);
    expect(handle.snapshot().events).toHaveLength(events + 1);
    expect(projection(handle).observedUsd).toBe(0.7);
    expect(projection(handle).accountedUsd).toBe(0.7);
  });

  test("exact same-key observation is idempotent on current CAS; stale and changed facts refuse", async () => {
    const root = await makeRoot();
    let hookCalls = 0;
    const handle = await createV2(root, {
      hook: () => {
        hookCalls += 1;
      },
    });
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.1, false);
    const firstClaim = uuid(300);
    await claim(handle, 1, firstClaim, null, ADMITTED_AT + 10);
    const observationId = uuid(400);
    const text = observeText(1, firstClaim, observationId, 0.2);
    await commit(handle, text);
    const beforeText = await primaryText(root);
    const beforeRevision = handle.snapshot().revision;
    const beforeEvents = handle.snapshot().events.length;
    hookCalls = 0;

    await commit(handle, text);
    expect(handle.snapshot().revision).toBe(beforeRevision);
    expect(handle.snapshot().events.length).toBe(beforeEvents);
    expect(hookCalls).toBe(0);
    expect(await primaryText(root)).toBe(beforeText);

    await expect(handle.commit(beforeRevision - 1, text)).rejects.toMatchObject({ code: "conflict" });
    await expect(commit(handle, observeText(1, firstClaim, observationId, 0.3)))
      .rejects.toMatchObject({ code: "conflict" });
    const secondClaim = uuid(301);
    await claim(handle, 1, secondClaim, firstClaim, ADMITTED_AT + 20);
    await expect(commit(handle, observeText(1, secondClaim, observationId, 0.2)))
      .rejects.toMatchObject({ code: "conflict" });
    await finish(handle, 1, secondClaim, "unknown", null, false);
    await reserve(handle, 2);
    await bindPrepared(handle, 2);
    await bindRun(handle, 2);
    await expect(commit(handle, observeText(2, null, observationId, 0.2)))
      .rejects.toMatchObject({ code: "conflict" });
    expect(handle.snapshot().revision).toBe(beforeRevision + 5);
  });

  test("duplicate current observation refuses after the read closes the handle", async () => {
    const root = await makeRoot();
    const seed = await createV2(root);
    await reserve(seed, 1);
    await bindPrepared(seed, 1);
    await bindRun(seed, 1);
    await settle(seed, 1, "known", 0.1, false);
    const claimId = uuid(300);
    await claim(seed, 1, claimId, null, ADMITTED_AT + 10);
    const duplicate = observeText(1, claimId, uuid(400), 0.2);
    await commit(seed, duplicate);
    seed.close();

    let armed = false;
    let actualCloseObserved = false;
    let opened: NativeHarnessRecoveryAccountingHandle | undefined;
    let hookCalls = 0;
    const wrappingIo: NativeFileIo = {
      ...nodeFileIo,
      open: async (target, flags): Promise<NativeFileHandle> => {
        const actual = await nodeFileIo.open(target, flags);
        return {
          stat: (options) => actual.stat(options),
          read: (buffer, offset, length, position) => actual.read(buffer, offset, length, position),
          close: async () => {
            await actual.close();
            actualCloseObserved = true;
            if (armed) {
              armed = false;
              opened?.close();
            }
          },
        };
      },
    };

    opened = await openV2(root, {
      fileIo: wrappingIo,
      hook: () => {
        hookCalls += 1;
      },
    });
    const beforeText = await primaryText(root);
    const beforeRevision = opened.snapshot().revision;
    armed = true;
    actualCloseObserved = false;
    hookCalls = 0;
    try {
      await expect(opened.commit(beforeRevision, duplicate))
        .rejects.toMatchObject({ code: "closed" });
      expect(actualCloseObserved).toBe(true);
      expect(opened.snapshot().revision).toBe(beforeRevision);
      expect(await primaryText(root)).toBe(beforeText);
      expect(hookCalls).toBe(0);
    } finally {
      opened.close();
    }
  });

  test("unknown finish retains the allocation and never refunds it", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    await finish(handle, 1, claimId, "unknown", 0.4, false);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(projection(handle).unknownUsd).toBe(1);
    expect(projection(handle).activeOperations).toBe(0);
  });

  test("workerOverspend is sticky even below allocation and blocks new claims/reserves", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.1, false);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    await observe(handle, 1, claimId, uuid(400), 0.2, true);
    expect(projection(handle).budgetBlocked).toBe(true);
    expect(projection(handle).overspendUsd).toBe(0);
    const revision = handle.snapshot().revision;
    await expect(claim(handle, 1, uuid(301), claimId, ADMITTED_AT + 20))
      .rejects.toMatchObject({ code: "invalid-transition" });
    await expect(reserve(handle, 2)).rejects.toMatchObject({ code: "invalid-transition" });
    expect(handle.snapshot().revision).toBe(revision);
    await observe(handle, 1, claimId, uuid(401), 0.3);
    await finish(handle, 1, claimId, "known", 0.3, false);
    expect(projection(handle).budgetBlocked).toBe(true);
  });

  test("owner lifetime-only excess is sticky without per-run overspend", async () => {
    const root = await makeRoot();
    const handle = await createV2(root, {
      limitsText: JSON.stringify({ ...LIMITS, lifetimeUsd: 1.5 }),
    });
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    await reserve(handle, 2);
    await bindPrepared(handle, 2);
    await bindRun(handle, 2);
    await observe(handle, 1, null, uuid(400), 0.8);
    expect(projection(handle).accountedUsd).toBe(1.8);
    expect(projection(handle).overspendUsd).toBe(0);
    expect(projection(handle).budgetBlocked).toBe(true);
    const revision = handle.snapshot().revision;
    await expect(reserve(handle, 3)).rejects.toMatchObject({ code: "invalid-transition" });
    await expect(claim(handle, 1, uuid(300), null, ADMITTED_AT + 10))
      .rejects.toMatchObject({ code: "invalid-transition" });
    expect(handle.snapshot().revision).toBe(revision);
  });

  test("late bookkeeping is bookable after block while new claims and reserves remain blocked", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    await observe(handle, 1, claimId, uuid(400), 0.2, true);
    await observe(handle, 1, claimId, uuid(401), 0.3);
    await finish(handle, 1, claimId, "unknown", 0.3, false);
    expect(projection(handle).budgetBlocked).toBe(true);
    await expect(claim(handle, 1, uuid(301), claimId, ADMITTED_AT + 20))
      .rejects.toMatchObject({ code: "invalid-transition" });
    await expect(reserve(handle, 2)).rejects.toMatchObject({ code: "invalid-transition" });
  });

  test("successive sub-epsilon cumulative facts are not lost to per-delta rounding", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await observe(handle, 1, null, uuid(400), 0.4e-9);
    await observe(handle, 1, null, uuid(401), 0.8e-9);
    expect(projection(handle).observedUsd).toBe(1e-9);
    expect(projection(handle).accountedUsd).toBe(1);
  });
});

describe("V2 caps, byte reservation and refusals", () => {
  test("eight claims are accepted and the ninth is explicitly exhausted", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.1, false);
    let predecessor: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const id = uuid(300 + index);
      await claim(handle, 1, id, predecessor, ADMITTED_AT + 10 + index);
      predecessor = id;
    }
    expect(handle.snapshot().events.filter((event) => event.kind === "claim")).toHaveLength(8);
    const before = await primaryText(root);
    const revision = handle.snapshot().revision;
    await expect(claim(handle, 1, uuid(320), predecessor, ADMITTED_AT + 30))
      .rejects.toMatchObject({ code: "exhausted" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(before);
  });

  test("sixty-four costs are accepted, the sixty-fifth refuses, and a duplicate still acknowledges", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.1, false);
    const claimId = uuid(300);
    await claim(handle, 1, claimId, null, ADMITTED_AT + 10);
    let firstText = "";
    for (let index = 0; index < 64; index += 1) {
      const text = observeText(1, claimId, uuid(400 + index), index + 1);
      if (index === 0) firstText = text;
      await commit(handle, text);
    }
    const revision = handle.snapshot().revision;
    const before = await primaryText(root);
    await expect(commit(handle, observeText(1, claimId, uuid(500), 0.5)))
      .rejects.toMatchObject({ code: "exhausted" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(before);
    await commit(handle, firstText);
    expect(handle.snapshot().revision).toBe(revision);
    await expect(reserve(handle, 2)).rejects.toMatchObject({ code: "exhausted" });
    await expect(claim(handle, 1, uuid(301), claimId, ADMITTED_AT + 20))
      .rejects.toMatchObject({ code: "exhausted" });
    await finish(handle, 1, claimId, "known", 64, false);
    expect(projection(handle).accountedUsd).toBe(64);
  });

  test("eight finish events are retained and a finished latest generation cannot finish again", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    let predecessor: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const id = uuid(300 + index);
      await claim(handle, 1, id, predecessor, ADMITTED_AT + 10 + index);
      await finish(handle, 1, id, "unknown", null, false);
      predecessor = id;
    }
    expect(handle.snapshot().events.filter((event) => event.kind === "finish")).toHaveLength(8);
    await expect(finish(handle, 1, predecessor!, "unknown", null, false))
      .rejects.toMatchObject({ code: "invalid-transition" });
    await expect(claim(handle, 1, uuid(320), predecessor, ADMITTED_AT + 40))
      .rejects.toMatchObject({ code: "exhausted" });
  });

  test("encoded event increments stay within the 512-byte reservation for representative wide integers", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    const big = 8_999_999_999_900_000;
    await commit(handle, reserveText(1, 1, {
      admittedAt: big,
      deadlineAt: big + LIMITS.maxDurationMs,
    }));
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.1, false);
    const withBinds = await primaryText(root);
    const claimId = uuid(300);
    const claimAccepted = await claim(handle, 1, claimId, null, big + 1_000);
    const claimDelta = Buffer.byteLength(await primaryText(root), "utf8") - Buffer.byteLength(withBinds, "utf8");
    expect(claimDelta).toBeGreaterThan(0);
    expect(claimDelta).toBeLessThanOrEqual(512);
    const beforeFinish = await primaryText(root);
    await finish(handle, 1, claimId, "known", Number.MAX_SAFE_INTEGER, false);
    const finishDelta = Buffer.byteLength(await primaryText(root), "utf8") - Buffer.byteLength(beforeFinish, "utf8");
    expect(finishDelta).toBeGreaterThan(0);
    expect(finishDelta).toBeLessThanOrEqual(512);
    const beforeObserve = await primaryText(root);
    await observe(handle, 1, claimId, uuid(400), Number.MAX_SAFE_INTEGER);
    const observeDelta = Buffer.byteLength(await primaryText(root), "utf8") - Buffer.byteLength(beforeObserve, "utf8");
    expect(observeDelta).toBeGreaterThan(0);
    expect(observeDelta).toBeLessThanOrEqual(512);
    expect(claimAccepted.revision).toBe(5);
  });

  test("real-file 24-character fractional cost, non-null predecessor and 9-to-10 revision growth stay within 512 bytes", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    const longFraction = 0.0000012345678901234567;
    expect(JSON.stringify(longFraction).length).toBe(24);
    const bytes = async () => Buffer.byteLength(await primaryText(root), "utf8");

    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.5, false);

    const firstClaim = uuid(600);
    const secondClaim = uuid(601);
    const thirdClaim = uuid(602);
    await claim(handle, 1, firstClaim, null, ADMITTED_AT + 10);
    await finish(handle, 1, firstClaim, "known", 0.75, false);

    const beforeObservation = await bytes();
    const beforeObservationProjection = projection(handle);
    await observe(handle, 1, null, uuid(700), longFraction);
    const observationDelta = (await bytes()) - beforeObservation;
    const afterObservationProjection = projection(handle);
    const observedEvents = handle.snapshot().events.filter((event) => event.kind === "observe-cost");
    expect(observedEvents).toHaveLength(1);
    expect(observedEvents[0]!.observedUsd).toBe(longFraction);
    expect(await primaryText(root)).toContain(JSON.stringify(longFraction));
    expect(afterObservationProjection.accountedUsd).toBe(beforeObservationProjection.accountedUsd);
    expect(afterObservationProjection.observedUsd).toBe(beforeObservationProjection.observedUsd);
    expect(observationDelta).toBeGreaterThan(0);
    expect(observationDelta).toBeLessThanOrEqual(512);
    expect(handle.snapshot().revision).toBe(7);

    const beforeSecondClaim = await bytes();
    await claim(handle, 1, secondClaim, firstClaim, ADMITTED_AT + 20);
    const secondClaimDelta = (await bytes()) - beforeSecondClaim;
    expect(secondClaimDelta).toBeGreaterThan(0);
    expect(secondClaimDelta).toBeLessThanOrEqual(512);
    expect(handle.snapshot().revision).toBe(8);

    await finish(handle, 1, secondClaim, "known", 0.9, false);
    const beforeCrossing = await primaryText(root);
    expect(handle.snapshot().revision).toBe(9);
    expect(beforeCrossing).toContain('\n  "revision": 9,\n');
    const beforeCrossingBytes = Buffer.byteLength(beforeCrossing, "utf8");
    await claim(handle, 1, thirdClaim, secondClaim, ADMITTED_AT + 30);
    const afterCrossing = await primaryText(root);
    const crossingDelta = Buffer.byteLength(afterCrossing, "utf8") - beforeCrossingBytes;
    expect(handle.snapshot().revision).toBe(10);
    expect(afterCrossing).toContain('\n  "revision": 10,\n');
    expect(crossingDelta).toBeGreaterThan(0);
    expect(crossingDelta).toBeLessThanOrEqual(512);
    expect(projection(handle).overspendUsd).toBe(0);

    console.log(
      `R2-C2a actual UTF8 deltas: 24-char observe=${observationDelta}, non-null predecessor claim=${secondClaimDelta}, 9-to-10 claim=${crossingDelta}`,
    );
  });

  test("encoded settlement and budget-block increments stay within 256 bytes", async () => {
    const settleRoot = await makeRoot();
    const settled = await createV2(settleRoot);
    await reserve(settled, 1);
    await bindPrepared(settled, 1);
    await bindRun(settled, 1);
    const beforeSettle = await primaryText(settleRoot);
    await settle(settled, 1, "known", Number.MAX_SAFE_INTEGER, false);
    const settleDelta = Buffer.byteLength(await primaryText(settleRoot), "utf8")
      - Buffer.byteLength(beforeSettle, "utf8");
    expect(settleDelta).toBeGreaterThan(0);
    expect(settleDelta).toBeLessThanOrEqual(256);

    const blockRoot = await makeRoot();
    const blocked = await createV2(blockRoot);
    await reserve(blocked, 1);
    const beforeBlock = await primaryText(blockRoot);
    await commit(blocked, blockText(1));
    const blockDelta = Buffer.byteLength(await primaryText(blockRoot), "utf8")
      - Buffer.byteLength(beforeBlock, "utf8");
    expect(blockDelta).toBeGreaterThan(0);
    expect(blockDelta).toBeLessThanOrEqual(256);
  });

  test("near-limit multibyte/path fixture retains real tails and refuses overflow without changing bytes", async () => {
    const root = await makeRoot();
    const longRoot = `${"é".repeat(240)}/${"ß".repeat(240)}/${"ø".repeat(200)}`;
    const handle = await createV2(root);
    for (let n = 1; n <= 6; n += 1) {
      await reserve(handle, n);
      await bindPrepared(handle, n, prepared(n, longRoot));
      await bindRun(handle, n);
      await settle(handle, n, "known", 0.1, false);
    }
    const claimId = uuid(300);
    await claim(handle, 6, claimId, null, ADMITTED_AT + 10);
    const beforeFinish = await primaryText(root);
    const encodedBytes = Buffer.byteLength(beforeFinish, "utf8");
    const reserved = 79 * 512 + 256 + 64;
    expect(encodedBytes + reserved).toBeLessThanOrEqual(NATIVE_HARNESS_ACCOUNTING_MAX_BYTES);
    expect(encodedBytes + reserved).toBeGreaterThan(60_000);
    await finish(handle, 6, claimId, "unknown", null, false);
    expect(handle.snapshot().events.filter((event) => event.kind === "finish")).toHaveLength(1);
    expect(projection(handle).accountedUsd).toBe(1.5);

    await reserve(handle, 7);
    expect(projection(handle).accountedUsd).toBe(2.5);
    const maxRoot = `${"é".repeat(255)}/${"é".repeat(255)}/${"é".repeat(255)}/${"é".repeat(250)}`;
    const beforeRefusal = await primaryText(root);
    const revision = handle.snapshot().revision;
    await expect(commit(handle, bindPreparedText(7, prepared(7, maxRoot))))
      .rejects.toMatchObject({ code: "too-large" });
    expect(handle.snapshot().revision).toBe(revision);
    expect(await primaryText(root)).toBe(beforeRefusal);
  });

  test("a forged settled tail that would exceed the reserved bound is rejected", async () => {
    const longRoot = `${"é".repeat(240)}/${"ß".repeat(240)}/${"ø".repeat(200)}`;
    const admissions: NativeHarnessRecoveryAccountingAdmission[] = [];
    for (let n = 1; n <= 16; n += 1) {
      const reserveRevision = 1 + (n - 1) * 4;
      admissions.push(v2Row(n, {
        reserveRevision,
        prepared: prepared(n, longRoot),
        preparedRevision: reserveRevision + 1,
        runId: uuid(100 + n),
        runRevision: reserveRevision + 2,
        settlement: known(reserveRevision + 3, 0.1),
      }));
    }
    const forged = checkpointV2({
      revision: 64,
      admissions,
    });
    expectDecodeV2Failure(forged);
  });
});

describe("V2 CAS, ambiguity and ownership", () => {
  test("two real V2 handles admit at most one stale CAS writer", async () => {
    const root = await makeRoot();
    const first = await createV2(root);
    const second = await openV2(root);
    const results = await Promise.allSettled([
      first.commit(0, reserveText(1, 1)),
      second.commit(0, reserveText(2, 1)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const reopened = await openV2(root);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().admissions).toHaveLength(1);
    const winner = reopened.snapshot().admissions[0]!.admissionId;
    expect([uuid(1), uuid(2)]).toContain(winner);
    const before = await primaryText(root);
    await expect(second.commit(0, reserveText(3, 1))).rejects.toMatchObject({ code: "conflict" });
    expect(await primaryText(root)).toBe(before);
  });

  test("a V2 post-write acknowledgement failure poisons the handle without rollback", async () => {
    const root = await makeRoot();
    const initial = await createV2(root);
    await reserve(initial, 1);
    const handle = await openV2(root, {
      hook: async () => {
        throw new Error("injected acknowledgement failure");
      },
    });
    const before = await primaryText(root);
    await expect(handle.commit(1, bindPreparedText(1)))
      .rejects.toMatchObject({ code: "ambiguous" });
    expect(await primaryText(root)).not.toBe(before);
    const onDisk = decodeV2Raw(await primaryText(root));
    expect(onDisk.revision).toBe(2);
    expect(onDisk.admissions[0]!.preparedRevision).toBe(2);
    const after = await primaryText(root);
    await expect(handle.commit(handle.snapshot().revision, bindRunText(1)))
      .rejects.toMatchObject({ code: "ambiguous" });
    expect(await primaryText(root)).toBe(after);
    expect(handle.snapshot().revision).toBe(1);
  });

  test("snapshots are frozen and reject caller mutation after commit", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    const accepted = await reserve(handle, 1);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.admissions)).toBe(true);
    expect(Object.isFrozen(accepted.admissions[0])).toBe(true);
    expect(Object.isFrozen(handle.snapshot())).toBe(true);
    expect(() => {
      (handle.snapshot() as { revision: number }).revision = 99;
    }).toThrow();
    expect(handle.snapshot().revision).toBe(1);
    await expect(handle.commit(1, reserveText(2, 50)))
      .rejects.toMatchObject({ code: "invalid-transition" });
  });
});
