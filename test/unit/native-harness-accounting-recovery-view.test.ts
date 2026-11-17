import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_ACCOUNTING_SCHEMA,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  NATIVE_HARNESS_ACCOUNTING_RECOVERY_TRANSITION_SCHEMA,
  NativeHarnessAccountingError,
  createNativeHarnessAccountingOwner,
  createNativeHarnessRecoveryAccountingOwner,
  projectNativeHarnessAccounting,
  projectNativeHarnessRecoveryAdmission,
  type NativeHarnessAccountingHandle,
  type NativeHarnessRecoveryAccountingHandle,
} from "../../src/native-harness-accounting.ts";
import type { NativeHarnessDelegationLimits } from "../../src/native-harness-delegation.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
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

async function makeRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-recovery-view-"));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

function createOptions(root: string) {
  return {
    storageRoot: root,
    selectorSha256: SELECTOR,
    ownerId: OWNER,
    createdAt: CREATED_AT,
    limitsText: LIMITS_TEXT,
  };
}

async function createV1(root: string): Promise<NativeHarnessAccountingHandle> {
  return createNativeHarnessAccountingOwner(createOptions(root));
}

async function createV2(root: string): Promise<NativeHarnessRecoveryAccountingHandle> {
  return createNativeHarnessRecoveryAccountingOwner(createOptions(root));
}

function reserveText(n: number, reserveRevision?: number): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "reserve",
    admissionId: uuid(n),
    sourceAssociationSha256: hash("a"),
    admittedAt: ADMITTED_AT + n,
    deadlineAt: ADMITTED_AT + n + LIMITS.maxDurationMs,
    allocatedUsd: LIMITS.perRunUsd,
    ...(reserveRevision === undefined ? {} : { reserveRevision }),
  });
}

function bindPreparedText(n: number): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindPrepared",
    admissionId: uuid(n),
    prepared: {
      preparedRelativeRoot: `omp-harness-${n}`,
      storeRelativeRoot: `omp-harness-${n}/store`,
      inputManifestSha256: hash("b"),
      sourceDescriptorSha256: hash("c"),
    },
  });
}

function bindRunText(n: number): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindRun",
    admissionId: uuid(n),
    runId: uuid(100 + n),
  });
}

function settleText(
  n: number,
  mode: "known" | "unknown" | "no-dispatch",
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
  held: boolean,
): string {
  return JSON.stringify({
    schema: V2_TRANSITION,
    action: "finishContinuation",
    admissionId: uuid(n),
    continuationId,
    mode,
    observedUsd,
    concurrencyHeld: held,
  });
}

function observeText(
  n: number,
  continuationId: string | null,
  observationId: string,
  observedUsd: number,
): string {
  return JSON.stringify({
    schema: V2_TRANSITION,
    action: "observeCost",
    admissionId: uuid(n),
    continuationId,
    observationId,
    observedUsd,
    workerOverspend: false,
  });
}

async function commit(handle: NativeHarnessRecoveryAccountingHandle, text: string) {
  return handle.commit(handle.snapshot().revision, text);
}

async function reserve(handle: NativeHarnessRecoveryAccountingHandle, n: number) {
  return commit(handle, reserveText(n, handle.snapshot().revision + 1));
}

describe("native recovery per-admission projection", () => {
  test("projects original bindings, claim replay, raw highwater and owner-wide slots", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    const c1 = uuid(500);
    const c2 = uuid(501);
    const c3 = uuid(502);

    await reserve(handle, 1);
    await commit(handle, bindPreparedText(1));
    await commit(handle, bindRunText(1));
    await commit(handle, settleText(1, "known", 0.2, false));
    await commit(handle, claimText(1, c1, null, ADMITTED_AT + 11));
    await commit(handle, observeText(1, c1, uuid(600), 0.3000000001));
    await commit(handle, finishText(1, c1, "known", 0.3000000001, false));

    await reserve(handle, 2);
    await commit(handle, bindPreparedText(2));
    await commit(handle, bindRunText(2));
    await commit(handle, claimText(2, c2, null, ADMITTED_AT + 22));
    await commit(handle, claimText(2, c3, c2, ADMITTED_AT + 23));
    await commit(handle, observeText(2, c3, uuid(601), 0.4000000002));
    await commit(handle, finishText(2, c3, "unknown", 0.4000000002, false));

    await reserve(handle, 3);

    const checkpoint = handle.snapshot();
    expect(checkpoint.schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2);
    expect(checkpoint.revision).toBe(15);

    const a = projectNativeHarnessRecoveryAdmission(checkpoint, uuid(1));
    expect(a.kind).toBe("historical-admission-facts");
    expect(a.ownerId).toBe(OWNER);
    expect(a.selectorSha256).toBe(SELECTOR);
    expect(a.checkpointRevision).toBe(15);
    expect(a.currentPermission).toBe(false);
    expect(a.canResume).toBe(false);
    expect(a.authority).toBe("none");

    const rowA = checkpoint.admissions.find((row) => row.admissionId === uuid(1))!;
    expect(a.admission.admissionId).toBe(rowA.admissionId);
    expect(a.admission.sourceAssociationSha256).toBe(rowA.sourceAssociationSha256);
    expect(a.admission.admittedAt).toBe(rowA.admittedAt);
    expect(a.admission.deadlineAt).toBe(rowA.deadlineAt);
    expect(a.admission.allocatedUsd).toBe(rowA.allocatedUsd);
    expect(a.admission.reserveRevision).toBe(rowA.reserveRevision);
    expect(a.admission.prepared).toEqual(rowA.prepared);
    expect(a.admission.runId).toBe(rowA.runId);
    expect(a.admission.settlement).toEqual(rowA.settlement);
    expect(a.admission.preparedRevision).toBe(rowA.preparedRevision);
    expect(a.admission.runRevision).toBe(rowA.runRevision);

    // Settlement, claim, late cumulative cost and known finish.
    expect(a.originalSettled).toBe(true);
    expect(a.unknownSticky).toBe(false);
    expect(a.occupancyHeld).toBe(false);
    expect(a.reserveCovered).toBe(false);
    expect(a.latestClaimId).toBe(c1);
    expect(a.latestClaimAt).toBe(ADMITTED_AT + 11);
    expect(a.latestClaimOpen).toBe(false);
    // Raw sub-nanodollar highwater, not the money-rounded 0.3.
    expect(a.observedUsd).toBe(0.3000000001);
    expect(a.ownerProjection.observedUsd).toBe(0.7);

    // Originally unsettled, claim then supersession, unknown late cost and
    // unknown finish. Its own highwater is not the owner maximum nor A's.
    const b = projectNativeHarnessRecoveryAdmission(checkpoint, uuid(2));
    expect(b.originalSettled).toBe(false);
    expect(b.unknownSticky).toBe(true);
    expect(b.occupancyHeld).toBe(false);
    expect(b.reserveCovered).toBe(true);
    expect(b.latestClaimId).toBe(c3);
    expect(b.latestClaimAt).toBe(ADMITTED_AT + 23);
    expect(b.latestClaimOpen).toBe(false);
    expect(b.observedUsd).toBe(0.4000000002);
    expect(b.observedUsd).not.toBe(a.observedUsd);

    // Untouched unsettled admission remains held with zero own usage.
    const c = projectNativeHarnessRecoveryAdmission(checkpoint, uuid(3));
    expect(c.originalSettled).toBe(false);
    expect(c.unknownSticky).toBe(false);
    expect(c.occupancyHeld).toBe(true);
    expect(c.reserveCovered).toBe(true);
    expect(c.latestClaimId).toBeNull();
    expect(c.latestClaimAt).toBeNull();
    expect(c.latestClaimOpen).toBe(false);
    expect(c.observedUsd).toBe(0);

    expect(a.remainingClaims).toBe(5);
    expect(a.remainingFinishes).toBe(6);
    expect(a.remainingCostObservations).toBe(62);
    expect(a.remainingEvents).toBe(73);
    expect(a.ownerProjection).toEqual(projectNativeHarnessAccounting(checkpoint));

    // Caller mutation of the projected input cannot retarget the result.
    const mutable = JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>;
    const before = projectNativeHarnessRecoveryAdmission(mutable, uuid(1));
    const admissionRows = mutable.admissions as Record<string, unknown>[];
    admissionRows[0]!.allocatedUsd = 9;
    admissionRows[0]!.deadlineAt = 1;
    mutable.ownerId = OTHER_OWNER;
    mutable.selectorSha256 = hash("f");
    mutable.events = [];
    mutable.revision = 0;
    expect(before.observedUsd).toBe(0.3000000001);
    expect(before.admission.deadlineAt).toBe(rowA.deadlineAt);
    expect(before.admission.allocatedUsd).toBe(rowA.allocatedUsd);
    expect(before.ownerId).toBe(OWNER);
    expect(before.selectorSha256).toBe(SELECTOR);
    expect(before.remainingEvents).toBe(73);

    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.admission)).toBe(true);
    expect(Object.isFrozen(a.admission.prepared)).toBe(true);
    expect(Object.isFrozen(a.admission.settlement)).toBe(true);
    expect(Object.isFrozen(a.ownerProjection)).toBe(true);
    expect(() => {
      (a as { observedUsd: number }).observedUsd = 0;
    }).toThrow();
    expect(() => {
      (a.admission as { deadlineAt: number }).deadlineAt = 0;
    }).toThrow();
  });

  test("64 cost rows leave zero cost and sixteen event slots at the fixed caps", async () => {
    const root = await makeRoot();
    const handle = await createV2(root);
    await reserve(handle, 1);
    await commit(handle, bindPreparedText(1));
    await commit(handle, bindRunText(1));
    for (let index = 0; index < 64; index += 1) {
      await commit(handle, observeText(1, null, uuid(1_000 + index), 0.001));
    }
    const checkpoint = handle.snapshot();
    expect(checkpoint.revision).toBe(67);
    expect(checkpoint.events).toHaveLength(64);
    const projection = projectNativeHarnessRecoveryAdmission(checkpoint, uuid(1));
    expect(projection.remainingClaims).toBe(8);
    expect(projection.remainingFinishes).toBe(8);
    expect(projection.remainingCostObservations).toBe(0);
    expect(projection.remainingEvents).toBe(16);
    expect(projection.observedUsd).toBe(0.001);
    expect(projection.originalSettled).toBe(false);
    expect(projection.occupancyHeld).toBe(true);
  });

  test("refuses V1, malformed and missing ids, and an invalid replayed timeline", async () => {
    const v1Root = await makeRoot();
    const v1 = await createV1(v1Root);
    expect(() => projectNativeHarnessRecoveryAdmission(v1.snapshot(), uuid(1))).toThrow(
      NativeHarnessAccountingError,
    );
    v1.close();

    const root = await makeRoot();
    const handle = await createV2(root);
    const checkpoint = handle.snapshot();
    expect(checkpoint.schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2);

    expect(() => projectNativeHarnessRecoveryAdmission(checkpoint, null)).toThrow(
      NativeHarnessAccountingError,
    );
    expect(() => projectNativeHarnessRecoveryAdmission(checkpoint, 42)).toThrow(
      NativeHarnessAccountingError,
    );
    expect(() => projectNativeHarnessRecoveryAdmission(checkpoint, "not-a-uuid")).toThrow(
      NativeHarnessAccountingError,
    );
    expect(() => projectNativeHarnessRecoveryAdmission(checkpoint, uuid(999))).toThrow(
      NativeHarnessAccountingError,
    );

    await reserve(handle, 1);
    const reserved = handle.snapshot();
    const forged = {
      ...JSON.parse(JSON.stringify(reserved)),
      revision: 2,
      events: [
        {
          revision: 2,
          kind: "claim",
          admissionId: uuid(1),
          continuationId: uuid(700),
          predecessorId: null,
          claimedAt: ADMITTED_AT + 2,
        },
      ],
    };
    expect(() => projectNativeHarnessRecoveryAdmission(forged, uuid(1))).toThrow(
      NativeHarnessAccountingError,
    );
  });

  test("V1 default creation is unchanged by the new projection", async () => {
    const root = await makeRoot();
    const handle = await createV1(root);
    const snapshot = handle.snapshot();
    expect(snapshot.schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA);
    expect(projectNativeHarnessAccounting(snapshot)).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 0,
      budgetBlocked: false,
    });
    handle.close();
  });
});
