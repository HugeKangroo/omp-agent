import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
  NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
  NativeHarnessAccountingError,
  createNativeHarnessAccountingOwner,
  createNativeHarnessRecoveryAccountingOwner,
  decodeNativeHarnessAccountingText,
  observeNativeHarnessAccountingOwner,
  openNativeHarnessAccountingOwner,
  projectNativeHarnessAccounting,
  type NativeHarnessAccountingAdmission,
  type NativeHarnessAccountingCheckpoint,
  type NativeHarnessAccountingHandle,
  type NativeHarnessAccountingPrepared,
  type NativeHarnessAccountingProjection,
  type NativeHarnessAccountingSettlement,
} from "../../src/native-harness-accounting.ts";
import type { NativeHarnessDelegationLimits } from "../../src/native-harness-delegation.ts";
import { nodeFileIo, sha256Hex, type NativeFileIo } from "../../src/native-work.ts";

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

function limits(overrides: Partial<NativeHarnessDelegationLimits> = {}): NativeHarnessDelegationLimits {
  return { ...LIMITS, ...overrides };
}

function prepared(n: number, root = `omp-harness-${n}`): NativeHarnessAccountingPrepared {
  return {
    preparedRelativeRoot: root,
    storeRelativeRoot: `${root}/store`,
    inputManifestSha256: hash("b"),
    sourceDescriptorSha256: hash("c"),
  };
}

function noDispatch(revision: number): NativeHarnessAccountingSettlement {
  return { revision, mode: "no-dispatch", observedUsd: 0, concurrencyHeld: false };
}

function known(revision: number, observedUsd: number): NativeHarnessAccountingSettlement {
  return { revision, mode: "known", observedUsd, concurrencyHeld: false };
}

function unknown(revision: number, observedUsd: number | null, held: boolean): NativeHarnessAccountingSettlement {
  return { revision, mode: "unknown", observedUsd, concurrencyHeld: held };
}

function row(
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

function checkpointValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_SCHEMA,
    revision: 0,
    ownerId: OWNER,
    selectorSha256: SELECTOR,
    createdAt: CREATED_AT,
    limits: limits(),
    budgetBlock: null,
    admissions: [],
    ...overrides,
  };
}

function checkpointText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function decodeValue(value: unknown): NativeHarnessAccountingCheckpoint {
  return decodeNativeHarnessAccountingText(checkpointText(value), IDENTITY);
}

function decodeRaw(text: string): NativeHarnessAccountingCheckpoint {
  return decodeNativeHarnessAccountingText(text, IDENTITY);
}

function expectDecodeFailure(value: unknown): void {
  expect(() => decodeValue(value)).toThrow(NativeHarnessAccountingError);
}

function padToBytes(text: string, bytes: number): string {
  const used = Buffer.byteLength(text, "utf8");
  if (used > bytes) throw new Error("fixture already exceeds the requested wire size");
  return text + " ".repeat(bytes - used);
}

function reserveText(admissionNumber: number, reserveRevision: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "reserve",
    admissionId: uuid(admissionNumber),
    sourceAssociationSha256: hash("a"),
    admittedAt: ADMITTED_AT + admissionNumber,
    deadlineAt: ADMITTED_AT + admissionNumber + LIMITS.maxDurationMs,
    allocatedUsd: LIMITS.perRunUsd,
    reserveRevision,
    ...overrides,
  });
}

function bindPreparedText(admissionNumber: number, value = prepared(admissionNumber)): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindPrepared",
    admissionId: uuid(admissionNumber),
    prepared: value,
  });
}

function bindRunText(admissionNumber: number, runId = uuid(100 + admissionNumber)): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "bindRun",
    admissionId: uuid(admissionNumber),
    runId,
  });
}

function settleText(
  admissionNumber: number,
  mode: "no-dispatch" | "known" | "unknown",
  observedUsd: number | null,
  held: boolean,
): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "settle",
    admissionId: uuid(admissionNumber),
    mode,
    observedUsd,
    concurrencyHeld: held,
  });
}

function blockText(admissionNumber: number): string {
  return JSON.stringify({
    schema: NATIVE_HARNESS_ACCOUNTING_TRANSITION_SCHEMA,
    action: "blockBudget",
    admissionId: uuid(admissionNumber),
  });
}

async function makeRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "omp-native-accounting-"));
  const root = await realpath(created);
  tempRoots.push(root);
  return root;
}

function namespacePath(root: string): string {
  return path.join(root, "accounting-owners");
}

function ownerDir(root: string, selector = SELECTOR): string {
  return path.join(namespacePath(root), selector);
}

function primaryPath(root: string, selector = SELECTOR): string {
  return path.join(ownerDir(root, selector), "owner.json");
}

async function createOwner(
  root: string,
  options: {
    ownerId?: string;
    selectorSha256?: string;
    createdAt?: number;
    limitsText?: string;
    fileIo?: NativeFileIo;
    hook?: (event: { readonly path: string; readonly revision: number }) => void | Promise<void>;
  } = {},
): Promise<NativeHarnessAccountingHandle> {
  return createNativeHarnessAccountingOwner(
    {
      storageRoot: root,
      selectorSha256: options.selectorSha256 ?? SELECTOR,
      ownerId: options.ownerId ?? OWNER,
      createdAt: options.createdAt ?? CREATED_AT,
      limitsText: options.limitsText ?? LIMITS_TEXT,
    },
    options.fileIo === undefined && options.hook === undefined
      ? undefined
      : {
        ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
        ...(options.hook === undefined ? {} : { testAfterPrimaryWrite: options.hook }),
      },
  );
}

async function openOwner(
  root: string,
  options: {
    ownerId?: string;
    selectorSha256?: string;
    fileIo?: NativeFileIo;
    hook?: (event: { readonly path: string; readonly revision: number }) => void | Promise<void>;
  } = {},
): Promise<NativeHarnessAccountingHandle> {
  return openNativeHarnessAccountingOwner(
    {
      storageRoot: root,
      selectorSha256: options.selectorSha256 ?? SELECTOR,
      ownerId: options.ownerId ?? OWNER,
    },
    options.fileIo === undefined && options.hook === undefined
      ? undefined
      : {
        ...(options.fileIo === undefined ? {} : { fileIo: options.fileIo }),
        ...(options.hook === undefined ? {} : { testAfterPrimaryWrite: options.hook }),
      },
  );
}

async function reserve(handle: NativeHarnessAccountingHandle, n: number, overrides: Record<string, unknown> = {}) {
  const expected = handle.snapshot().revision;
  return handle.commit(expected, reserveText(n, expected + 1, overrides));
}

async function bindPrepared(handle: NativeHarnessAccountingHandle, n: number, value = prepared(n)) {
  const expected = handle.snapshot().revision;
  return handle.commit(expected, bindPreparedText(n, value));
}

async function bindRun(handle: NativeHarnessAccountingHandle, n: number, runId = uuid(100 + n)) {
  const expected = handle.snapshot().revision;
  return handle.commit(expected, bindRunText(n, runId));
}

async function settle(
  handle: NativeHarnessAccountingHandle,
  n: number,
  mode: "no-dispatch" | "known" | "unknown",
  observedUsd: number | null,
  held: boolean,
) {
  const expected = handle.snapshot().revision;
  return handle.commit(expected, settleText(n, mode, observedUsd, held));
}

async function block(handle: NativeHarnessAccountingHandle, n: number) {
  const expected = handle.snapshot().revision;
  return handle.commit(expected, blockText(n));
}

function projection(handle: NativeHarnessAccountingHandle): NativeHarnessAccountingProjection {
  return projectNativeHarnessAccounting(handle.snapshot());
}

async function primaryText(root: string): Promise<string> {
  return readFile(primaryPath(root), "utf8");
}

async function disturbWriteLockOwner(root: string, selector = SELECTOR): Promise<void> {
  const lockOwnerPath = path.join(ownerDir(root, selector), ".write.lock", "owner.json");
  const owner = JSON.parse(await readFile(lockOwnerPath, "utf8")) as Record<string, unknown>;
  owner.token = uuid(999);
  await writeFile(lockOwnerPath, `${JSON.stringify(owner)}\n`, "utf8");
}

describe("native accounting codec", () => {
  test("decodes a valid reserve and projects only owned frozen facts", () => {
    const value = checkpointValue({ revision: 1, admissions: [row(1)] });
    const checkpoint = decodeValue(value);
    const projected = projectNativeHarnessAccounting(checkpoint);
    expect(checkpoint.schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA);
    expect(checkpoint.ownerId).toBe(OWNER);
    expect(checkpoint.selectorSha256).toBe(SELECTOR);
    expect(checkpoint.admissions).toHaveLength(1);
    expect(projected).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(Object.isFrozen(checkpoint)).toBe(true);
    expect(Object.isFrozen(checkpoint.admissions)).toBe(true);
    expect(Object.isFrozen(checkpoint.admissions[0])).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(() => {
      (checkpoint as unknown as { revision: number }).revision = 9;
    }).toThrow();
  });

  test("rejects unknown, missing and non-data fields without stripping", () => {
    const unknownTop = checkpointValue({ extra: true });
    expectDecodeFailure(unknownTop);
    const missingTop = checkpointValue();
    delete missingTop.createdAt;
    expectDecodeFailure(missingTop);
    const unknownRow = checkpointValue({ revision: 1, admissions: [row(1)] });
    (unknownRow.admissions as Record<string, unknown>[])[0]!.extra = true;
    expectDecodeFailure(unknownRow);
    const unknownLimits = checkpointValue({ limits: { ...limits(), extra: true } });
    expectDecodeFailure(unknownLimits);
    const unknownPrepared = checkpointValue({
      revision: 2,
      admissions: [row(1, { prepared: { ...prepared(1), extra: true } as NativeHarnessAccountingPrepared })],
    });
    expectDecodeFailure(unknownPrepared);
    expect(() => decodeRaw("\uFEFF{}")).toThrow(NativeHarnessAccountingError);
  });

  test("rejects duplicate admissions, reservation points, settlement revisions and run ids", () => {
    expectDecodeFailure(checkpointValue({
      revision: 2,
      admissions: [row(1), row(2, { admissionId: uuid(1), reserveRevision: 2 })],
    }));
    expectDecodeFailure(checkpointValue({
      revision: 2,
      admissions: [row(1), row(2, { reserveRevision: 1 })],
    }));
    expectDecodeFailure(checkpointValue({
      revision: 4,
      admissions: [
        row(1, { settlement: noDispatch(3) }),
        row(2, { reserveRevision: 2, settlement: noDispatch(3) }),
      ],
    }));
    expectDecodeFailure(checkpointValue({
      revision: 6,
      admissions: [
        row(1, { prepared: prepared(1), runId: uuid(101) }),
        row(2, { prepared: prepared(2), runId: uuid(101) }),
      ],
    }));
  });

  test("rejects unsafe, fractional-in-wrong-place and out-of-range limits and numbers", () => {
    expectDecodeFailure(checkpointValue({ limits: limits({ maxRetainedOperations: 1.5 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ maxConcurrent: 2 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ perRunUsd: 0 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ perRunUsd: 1.5 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ perRunUsd: 1, lifetimeUsd: 0.5 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ lifetimeUsd: 6 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ maxDurationMs: 0 }) }));
    expectDecodeFailure(checkpointValue({ limits: limits({ cleanupGraceMs: 30_001 }) }));
    expectDecodeFailure(checkpointValue({ revision: Number.MAX_SAFE_INTEGER + 1 }));
    expectDecodeFailure(checkpointValue({
      revision: 2,
      admissions: [row(1, { settlement: unknown(2, Number.MAX_SAFE_INTEGER + 1, false) })],
    }));
  });

  test("accepts fractional policy values and exact fractional deadlines", () => {
    const fractional = limits({
      maxRetainedOperations: 2,
      perRunUsd: 0.5,
      lifetimeUsd: 0.5,
      maxDurationMs: 1000.5,
      cleanupGraceMs: 100.5,
    });
    const value = checkpointValue({
      revision: 1,
      limits: fractional,
      admissions: [row(1, {
        allocatedUsd: 0.5,
        admittedAt: ADMITTED_AT,
        deadlineAt: ADMITTED_AT + 1000.5,
      })],
    });
    const projected = projectNativeHarnessAccounting(decodeValue(value));
    expect(projected.accountedUsd).toBe(0.5);
    expect(projected.retainedOperations).toBe(1);
  });

  test("rejects malformed identifiers, hashes, paths and cross-field bindings", () => {
    expectDecodeFailure(checkpointValue({ selectorSha256: SELECTOR.toUpperCase() }));
    expectDecodeFailure(checkpointValue({ ownerId: OWNER.charAt(0) === "1" ? `A${OWNER.slice(1)}` : OWNER }));
    expectDecodeFailure(checkpointValue({ revision: 1, admissions: [row(1, { sourceAssociationSha256: "abc" })] }));
    expectDecodeFailure(checkpointValue({ revision: 2, admissions: [row(1, {
      prepared: { ...prepared(1), preparedRelativeRoot: "../escape" },
    })] }));
    expectDecodeFailure(checkpointValue({ revision: 2, admissions: [row(1, {
      prepared: { ...prepared(1), storeRelativeRoot: "other/store" },
    })] }));
    expectDecodeFailure(checkpointValue({ revision: 2, admissions: [row(1, {
      prepared: { ...prepared(1), inputManifestSha256: hash("B").toUpperCase() },
    })] }));
    expectDecodeFailure(checkpointValue({ revision: 4, admissions: [row(1, {
      prepared: prepared(1),
      runId: uuid(101),
      settlement: noDispatch(2),
    })] }));
    expectDecodeFailure(checkpointValue({ revision: 2, admissions: [row(1, { runId: uuid(101) })] }));
    expectDecodeFailure(checkpointValue({ revision: 4, admissions: [row(1, {
      prepared: prepared(1),
      runId: uuid(101),
      settlement: known(2, 0.2),
      deadlineAt: ADMITTED_AT + 1 + LIMITS.maxDurationMs + 1,
    })] }));
    expectDecodeFailure(checkpointValue({ revision: 1, admissions: [row(1, { allocatedUsd: 0.5 })] }));
    expectDecodeFailure(checkpointValue({ revision: 8, admissions: [row(1, {
      prepared: prepared(1),
      runId: uuid(101),
      settlement: known(2, 0.2),
    }), row(2, { prepared: prepared(2), runId: uuid(102), settlement: { revision: 2, mode: "unknown", observedUsd: 0, concurrencyHeld: false } })] }));
  });

  test("rejects budget blocks that precede reservations or follow settlements", () => {
    expectDecodeFailure(checkpointValue({
      revision: 3,
      admissions: [row(1), row(2, { reserveRevision: 3 })],
      budgetBlock: { admissionId: uuid(2), revision: 2, reason: "observed-worker-overspend" },
    }));
    expectDecodeFailure(checkpointValue({
      revision: 3,
      admissions: [row(1, { settlement: unknown(2, 0.2, false) })],
      budgetBlock: { admissionId: uuid(1), revision: 3, reason: "observed-worker-overspend" },
    }));
    expectDecodeFailure(checkpointValue({
      revision: 3,
      admissions: [row(1, { settlement: unknown(2, 0.2, false) })],
      budgetBlock: { admissionId: uuid(1), revision: 2, reason: "observed-worker-overspend" },
    }));
    expectDecodeFailure(checkpointValue({
      revision: 2,
      admissions: [row(1)],
      budgetBlock: { admissionId: uuid(9), revision: 2, reason: "observed-worker-overspend" },
    }));
  });

  test("rejects a historical prefix that a later settlement makes look complete", () => {
    expectDecodeFailure(checkpointValue({
      revision: 3,
      admissions: [
        row(1, { settlement: noDispatch(3) }),
        row(2),
      ],
    }));
    const tight = limits({ perRunUsd: 1, lifetimeUsd: 1, maxRetainedOperations: 2 });
    expectDecodeFailure(checkpointValue({
      revision: 6,
      limits: tight,
      admissions: [
        row(1, { prepared: prepared(1), runId: uuid(101), settlement: known(2, 1) }),
        row(2, { reserveRevision: 3, settlement: noDispatch(6) }),
      ],
    }));
    expectDecodeFailure(checkpointValue({
      revision: 4,
      admissions: [
        row(1, { settlement: unknown(3, 0.2, false) }),
        row(2, { reserveRevision: 4 }),
      ],
      budgetBlock: { admissionId: uuid(1), revision: 2, reason: "observed-worker-overspend" },
    }));
  });

  test("accepts early reservations followed by a later sticky block", () => {
    const checkpoint = decodeValue(checkpointValue({
      revision: 4,
      admissions: [
        row(1, { settlement: unknown(2, 0.2, false) }),
        row(2, { reserveRevision: 3 }),
      ],
      budgetBlock: { admissionId: uuid(2), revision: 4, reason: "observed-worker-overspend" },
    }));
    const projected = projectNativeHarnessAccounting(checkpoint);
    expect(projected).toEqual({
      accountedUsd: 2,
      observedUsd: 0.2,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 2,
      budgetBlocked: true,
    });
  });

  test("enforces fixed revision arithmetic, empty zero, first reservation and block presence", () => {
    expectDecodeFailure(checkpointValue({ revision: 1 }));
    expectDecodeFailure(checkpointValue({ revision: 0, admissions: [row(1)] }));
    expectDecodeFailure(checkpointValue({ revision: 2, admissions: [row(1, { reserveRevision: 2 })] }));
    expectDecodeFailure(checkpointValue({
      revision: 3,
      admissions: [row(1, {
        reserveRevision: 2,
        prepared: prepared(1),
        settlement: noDispatch(3),
      })],
    }));
    expectDecodeFailure(checkpointValue({
      revision: 5,
      admissions: [row(1, {
        prepared: prepared(1),
        runId: uuid(101),
        settlement: known(3, 0.2),
      })],
    }));

    const complete = decodeValue(checkpointValue({
      revision: 4,
      admissions: [row(1, {
        prepared: prepared(1),
        runId: uuid(101),
        settlement: known(4, 0.2),
      })],
    }));
    expect(complete.revision).toBe(4);
    expect(projectNativeHarnessAccounting(complete).accountedUsd).toBe(0.2);
  });

  test("enforces the 65536-byte wire bound inclusively and measures multibyte text", () => {
    const multibyteRoot = `src-${"é".repeat(200)}-"quoted`;
    const value = checkpointValue({
      revision: 2,
      admissions: [row(1, { prepared: prepared(1, multibyteRoot) })],
    });
    const wire = checkpointText(value);
    expect(Buffer.byteLength(wire, "utf8")).toBeGreaterThan(wire.length);

    const inclusive = padToBytes(wire, NATIVE_HARNESS_ACCOUNTING_MAX_BYTES);
    expect(Buffer.byteLength(inclusive, "utf8")).toBe(NATIVE_HARNESS_ACCOUNTING_MAX_BYTES);
    expect(inclusive.length).toBeLessThan(NATIVE_HARNESS_ACCOUNTING_MAX_BYTES);
    expect(decodeRaw(inclusive).revision).toBe(2);

    const over = padToBytes(wire, NATIVE_HARNESS_ACCOUNTING_MAX_BYTES + 1);
    expect(() => decodeRaw(over)).toThrow(NativeHarnessAccountingError);
  });
});

describe("native accounting owner files", () => {
  test("creates a private fresh checkpoint that reopens with exact identity and limits", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const snapshot = handle.snapshot();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.ownerId).toBe(OWNER);
    expect(snapshot.selectorSha256).toBe(SELECTOR);
    expect(snapshot.createdAt).toBe(CREATED_AT);
    expect(snapshot.limits).toEqual(LIMITS);
    expect(snapshot.budgetBlock).toBeNull();
    expect(snapshot.admissions).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.limits)).toBe(true);
    expect(() => {
      (snapshot.limits as unknown as { perRunUsd: number }).perRunUsd = 2;
    }).toThrow();

    expect((await stat(primaryPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(ownerDir(root))).mode & 0o777).toBe(0o700);
    expect(await readdir(ownerDir(root))).toEqual(["owner.json"]);

    const reopened = await openOwner(root);
    expect(reopened.snapshot()).toEqual(snapshot);
    expect(projectNativeHarnessAccounting(reopened.snapshot())).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 0,
      budgetBlocked: false,
    });
    expect(await primaryText(root)).toBe(checkpointText(snapshot));
  });

  test("refuses wrong owner, wrong selector and an existing empty or partial owner directory", async () => {
    const root = await makeRoot();
    await createOwner(root);
    const before = await primaryText(root);
    const wrongOwner = "22222222-2222-4222-8222-222222222222";
    await expect(openOwner(root, { ownerId: wrongOwner })).rejects.toThrow(NativeHarnessAccountingError);
    await expect(openOwner(root, { selectorSha256: hash("e") })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
    expect(await readdir(namespacePath(root))).toEqual([SELECTOR]);

    const emptyRoot = await makeRoot();
    await mkdir(ownerDir(emptyRoot), { recursive: true, mode: 0o700 });
    await expect(createOwner(emptyRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(emptyRoot))).toEqual([]);

    const partialRoot = await makeRoot();
    await mkdir(ownerDir(partialRoot), { recursive: true, mode: 0o700 });
    await writeFile(path.join(ownerDir(partialRoot), "partial.txt"), "partial", "utf8");
    await expect(createOwner(partialRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(partialRoot))).toEqual(["partial.txt"]);
  });

  test("missing, .bak-only and corrupted primaries refuse without repair or fallback", async () => {
    const missingRoot = await makeRoot();
    await createOwner(missingRoot);
    await rm(primaryPath(missingRoot));
    await expect(openOwner(missingRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(missingRoot))).toEqual([]);

    const backupRoot = await makeRoot();
    await createOwner(backupRoot);
    const original = await primaryText(backupRoot);
    const backupPath = `${primaryPath(backupRoot)}.bak`;
    await rename(primaryPath(backupRoot), backupPath);
    await expect(openOwner(backupRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readFile(backupPath, "utf8")).toBe(original);
    expect(await readdir(ownerDir(backupRoot))).toEqual(["owner.json.bak"]);

    const corruptRoot = await makeRoot();
    await createOwner(corruptRoot);
    await writeFile(primaryPath(corruptRoot), "{", "utf8");
    await expect(openOwner(corruptRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(corruptRoot)).toBe("{");
    expect(await readdir(ownerDir(corruptRoot))).toEqual(["owner.json"]);
  });

  test("reads exactly 65536 bytes but refuses 65537 and refuses a link or directory primary", async () => {
    const root = await makeRoot();
    await createOwner(root);
    const baseline = checkpointText(checkpointValue());
    await writeFile(primaryPath(root), padToBytes(baseline, NATIVE_HARNESS_ACCOUNTING_MAX_BYTES), "utf8");
    const reopened = await openOwner(root);
    expect(reopened.snapshot().revision).toBe(0);

    const oversized = padToBytes(baseline, NATIVE_HARNESS_ACCOUNTING_MAX_BYTES + 1);
    await writeFile(primaryPath(root), oversized, "utf8");
    await expect(openOwner(root)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(oversized);

    const linkRoot = await makeRoot();
    await createOwner(linkRoot);
    const realPath = path.join(ownerDir(linkRoot), "real.json");
    await rename(primaryPath(linkRoot), realPath);
    await symlink("real.json", primaryPath(linkRoot));
    const realBytes = await readFile(realPath, "utf8");
    await expect(openOwner(linkRoot)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readFile(realPath, "utf8")).toBe(realBytes);
    expect((await readdir(ownerDir(linkRoot))).sort()).toEqual(["owner.json", "real.json"]);

    const directoryRoot = await makeRoot();
    await createOwner(directoryRoot);
    await rm(primaryPath(directoryRoot));
    await mkdir(primaryPath(directoryRoot));
    await expect(openOwner(directoryRoot)).rejects.toThrow(NativeHarnessAccountingError);
  });

  test("refuses a storage-root identity change during the pinned read", async () => {
    const root = await makeRoot();
    await createOwner(root);
    const before = await primaryText(root);
    let rootRealpathCalls = 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (target === root) {
          rootRealpathCalls += 1;
          if (rootRealpathCalls >= 3) return `${root}-alias`;
        }
        return nodeFileIo.realpath(target);
      },
    };
    await expect(openOwner(root, { fileIo: io })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
  });

  test("a disappeared primary or owner refuses without recreating either", async () => {
    const missingPrimaryRoot = await makeRoot();
    await createOwner(missingPrimaryRoot);
    const primaryHandle = await openOwner(missingPrimaryRoot);
    await rm(primaryPath(missingPrimaryRoot));
    await expect(primaryHandle.commit(0, reserveText(1, 1)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(missingPrimaryRoot))).toEqual([]);

    const missingOwnerRoot = await makeRoot();
    await createOwner(missingOwnerRoot);
    const ownerHandle = await openOwner(missingOwnerRoot);
    await rm(ownerDir(missingOwnerRoot), { recursive: true });
    await expect(ownerHandle.commit(0, reserveText(1, 1)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(namespacePath(missingOwnerRoot))).toEqual([]);
  });

  test("close and an unavailable primary never invoke the after-write hook", async () => {
    const root = await makeRoot();
    await createOwner(root);
    let calls = 0;
    const handle = await openOwner(root, {
      hook: () => {
        calls += 1;
      },
    });
    handle.close();
    const before = await primaryText(root);
    await expect(handle.commit(0, reserveText(1, 1))).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
    expect(calls).toBe(0);
    expect(handle.snapshot().revision).toBe(0);

    const missingRoot = await makeRoot();
    await createOwner(missingRoot);
    await rm(primaryPath(missingRoot));
    let missingCalls = 0;
    await expect(openOwner(missingRoot, {
      hook: () => {
        missingCalls += 1;
      },
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(missingCalls).toBe(0);
  });
});

describe("native accounting readonly discovery", () => {
  test("observes an existing owner UUID and exact-opens it without writing", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const before = await primaryText(root);
    const beforeEntries = await readdir(ownerDir(root));

    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });
    expect(observed.identity).toEqual(IDENTITY);
    expect(observed.checkpoint).toEqual(handle.snapshot());
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.identity)).toBe(true);
    expect(Object.isFrozen(observed.checkpoint)).toBe(true);
    expect(await primaryText(root)).toBe(before);
    expect(await readdir(ownerDir(root))).toEqual(beforeEntries);

    const reopened = await openOwner(root, { ownerId: observed.identity.ownerId });
    expect(reopened.snapshot()).toEqual(handle.snapshot());
    expect(await primaryText(root)).toBe(before);
  });

  test("observes the exact raw primary SHA-256 and byte count from that single read", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const raw = await readFile(primaryPath(root));
    const statBefore = await stat(primaryPath(root));
    const entriesBefore = await readdir(ownerDir(root));

    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });

    expect(observed.identity).toEqual(IDENTITY);
    expect(observed.checkpoint).toEqual(handle.snapshot());
    expect(observed.primarySha256).toBe(sha256Hex(raw));
    expect(observed.primaryBytes).toBe(raw.length);
    expect(Object.isFrozen(observed)).toBe(true);
    expect((await readFile(primaryPath(root))).equals(raw)).toBe(true);
    const statAfter = await stat(primaryPath(root));
    expect(statAfter.dev).toBe(statBefore.dev);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(await readdir(ownerDir(root))).toEqual(entriesBefore);
  });

  test("returns raw primary facts for an existing V2 owner", async () => {
    const root = await makeRoot();
    const handle = await createNativeHarnessRecoveryAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
      ownerId: OWNER,
      createdAt: CREATED_AT,
      limitsText: LIMITS_TEXT,
    });
    const raw = await readFile(primaryPath(root));

    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });

    expect(observed.checkpoint.schema).toBe(NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2);
    expect(observed.checkpoint).toEqual(handle.snapshot());
    expect(observed.primarySha256).toBe(sha256Hex(raw));
    expect(observed.primaryBytes).toBe(raw.length);
  });

  test("raw SHA follows whitespace while the decoded checkpoint stays equal", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const original = await readFile(primaryPath(root), "utf8");
    const compact = `${JSON.stringify(JSON.parse(original))}\n`;
    expect(compact).not.toBe(original);
    expect(decodeRaw(compact)).toEqual(handle.snapshot());
    await writeFile(primaryPath(root), compact, "utf8");

    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });

    expect(observed.checkpoint).toEqual(handle.snapshot());
    expect(observed.primarySha256).toBe(sha256Hex(Buffer.from(compact, "utf8")));
    expect(observed.primarySha256).not.toBe(sha256Hex(Buffer.from(original, "utf8")));
    expect(observed.primaryBytes).toBe(Buffer.byteLength(compact, "utf8"));
    expect(observed.primaryBytes).not.toBe(Buffer.byteLength(original, "utf8"));
  });

  test("missing and partial owners refuse without creating anything", async () => {
    const emptyRoot = await makeRoot();
    const emptyBefore = await readdir(emptyRoot);
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: emptyRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(emptyRoot)).toEqual(emptyBefore);

    const partialRoot = await makeRoot();
    await mkdir(ownerDir(partialRoot), { recursive: true, mode: 0o700 });
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: partialRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(partialRoot))).toEqual([]);

    const missingRoot = await makeRoot();
    await createOwner(missingRoot);
    await rm(primaryPath(missingRoot));
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: missingRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(ownerDir(missingRoot))).toEqual([]);
  });

  test("corrupt, projection-invalid, .bak-only and selector-mismatched owners refuse", async () => {
    const corruptRoot = await makeRoot();
    await createOwner(corruptRoot);
    await writeFile(primaryPath(corruptRoot), "{", "utf8");
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: corruptRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(corruptRoot)).toBe("{");

    const historyRoot = await makeRoot();
    await createOwner(historyRoot);
    const impossible = checkpointText(checkpointValue({
      revision: 3,
      admissions: [
        row(1, { settlement: noDispatch(3) }),
        row(2),
      ],
    }));
    await writeFile(primaryPath(historyRoot), impossible, "utf8");
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: historyRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(historyRoot)).toBe(impossible);

    const backupRoot = await makeRoot();
    await createOwner(backupRoot);
    const backup = `${primaryPath(backupRoot)}.bak`;
    const original = await primaryText(backupRoot);
    await rename(primaryPath(backupRoot), backup);
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: backupRoot,
      selectorSha256: SELECTOR,
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readFile(backup, "utf8")).toBe(original);
    expect(await readdir(ownerDir(backupRoot))).toEqual(["owner.json.bak"]);

    const selectorRoot = await makeRoot();
    await createOwner(selectorRoot);
    const selectorBefore = await primaryText(selectorRoot);
    await expect(observeNativeHarnessAccountingOwner({
      storageRoot: selectorRoot,
      selectorSha256: hash("e"),
    })).rejects.toThrow(NativeHarnessAccountingError);
    expect(await readdir(namespacePath(selectorRoot))).toEqual([SELECTOR]);
    expect(await primaryText(selectorRoot)).toBe(selectorBefore);
  });
});

describe("native accounting transitions", () => {
  test("known 0.20 replaces the 1.00 reservation without adding it twice", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    expect(projection(handle)).toEqual({
      accountedUsd: 0.2,
      observedUsd: 0.2,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(handle.snapshot().admissions[0]!.settlement).toEqual(known(4, 0.2));
  });

  test("unknown null retains the reservation and unknown 0.20 does not charge 1.20", async () => {
    const nullRoot = await makeRoot();
    const nullHandle = await createOwner(nullRoot);
    await reserve(nullHandle, 1);
    await settle(nullHandle, 1, "unknown", null, false);
    expect(projection(nullHandle)).toEqual({
      accountedUsd: 1,
      observedUsd: 0,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    expect(nullHandle.snapshot().admissions[0]!.settlement!.observedUsd).toBeNull();

    const lowRoot = await makeRoot();
    const lowHandle = await createOwner(lowRoot);
    await reserve(lowHandle, 1);
    await settle(lowHandle, 1, "unknown", 0.2, false);
    expect(projection(lowHandle)).toEqual({
      accountedUsd: 1,
      observedUsd: 0.2,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
  });

  test("unknown 1.20 charges 1.20, records overspend and blocks further reserves", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await settle(handle, 1, "unknown", 1.2, false);
    expect(projection(handle)).toEqual({
      accountedUsd: 1.2,
      observedUsd: 1.2,
      unknownUsd: 1,
      overspendUsd: 0.2,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: true,
    });
    const before = await primaryText(root);
    await expect(reserve(handle, 2)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
  });

  test("a worker overspend block below the whole-run allocation stays sticky", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await block(handle, 1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "known", 0.2, false);
    expect(projection(handle)).toEqual({
      accountedUsd: 0.2,
      observedUsd: 0.2,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: true,
    });
    const before = await primaryText(root);
    await expect(block(handle, 1)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
  });

  test("unknown held true pins concurrency; held false releases it while retaining cost", async () => {
    const heldRoot = await makeRoot();
    const heldHandle = await createOwner(heldRoot);
    await reserve(heldHandle, 1);
    await settle(heldHandle, 1, "unknown", 0.2, true);
    expect(projection(heldHandle).activeOperations).toBe(1);
    await expect(reserve(heldHandle, 2)).rejects.toThrow(NativeHarnessAccountingError);

    const releasedRoot = await makeRoot();
    const releasedHandle = await createOwner(releasedRoot);
    await reserve(releasedHandle, 1);
    await settle(releasedHandle, 1, "unknown", 0.2, false);
    await reserve(releasedHandle, 2);
    expect(projection(releasedHandle)).toEqual({
      accountedUsd: 2,
      observedUsd: 0.2,
      unknownUsd: 1,
      overspendUsd: 0,
      activeOperations: 1,
      retainedOperations: 2,
      budgetBlocked: false,
    });
  });

  test("no-dispatch releases the amount but retains the lifetime row", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await bindPrepared(handle, 1);
    await settle(handle, 1, "no-dispatch", 0, false);
    expect(projection(handle)).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 1,
      budgetBlocked: false,
    });
    await reserve(handle, 2);
    expect(projection(handle).retainedOperations).toBe(2);
  });

  test("five unknown settled rows exhaust the 5.00 lifetime budget", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    for (let n = 1; n <= 5; n += 1) {
      await reserve(handle, n);
      await settle(handle, n, "unknown", null, false);
    }
    expect(projection(handle)).toEqual({
      accountedUsd: 5,
      observedUsd: 0,
      unknownUsd: 5,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 5,
      budgetBlocked: false,
    });
    const before = await primaryText(root);
    await expect(reserve(handle, 6)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
  });

  test("sixteen no-dispatch rows exhaust retention after reopen", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    for (let n = 1; n <= 16; n += 1) {
      await reserve(handle, n);
      await settle(handle, n, "no-dispatch", 0, false);
    }
    handle.close();
    const reopened = await openOwner(root);
    expect(projection(reopened)).toEqual({
      accountedUsd: 0,
      observedUsd: 0,
      unknownUsd: 0,
      overspendUsd: 0,
      activeOperations: 0,
      retainedOperations: 16,
      budgetBlocked: false,
    });
    const before = await primaryText(root);
    await expect(reserve(reopened, 17)).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(before);
  });

  test("settled history cannot be rewritten or cleared", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await settle(handle, 1, "no-dispatch", 0, false);
    const settled = await primaryText(root);
    await expect(handle.commit(2, settleText(1, "no-dispatch", 0, false)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(settled);
    await expect(handle.commit(2, blockText(1))).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(settled);
  });

  test("reserve revision survives prepared/run links and later settlements", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const reserveRevision = (await reserve(handle, 1)).admissions[0]!.reserveRevision;
    expect(reserveRevision).toBe(1);
    await bindPrepared(handle, 1);
    await bindRun(handle, 1);
    await settle(handle, 1, "unknown", 0.2, false);
    handle.close();
    const reopened = await openOwner(root);
    const admission = reopened.snapshot().admissions[0]!;
    expect(admission.reserveRevision).toBe(1);
    expect(admission.prepared).toEqual(prepared(1));
    expect(admission.runId).toBe(uuid(101));
    expect(admission.settlement).toEqual(unknown(4, 0.2, false));
  });

  test("two independent handles at the same revision allow at most one CAS write", async () => {
    const root = await makeRoot();
    const first = await createOwner(root);
    const second = await openOwner(root);
    const results = await Promise.allSettled([
      first.commit(0, reserveText(1, 1)),
      second.commit(0, reserveText(2, 1)),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const reopened = await openOwner(root);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().admissions).toHaveLength(1);
    const winner = reopened.snapshot().admissions[0]!.admissionId;
    expect([uuid(1), uuid(2)]).toContain(winner);

    const staleBefore = await primaryText(root);
    await expect(second.commit(0, reserveText(3, 1))).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(staleBefore);
  });

  test("an identical stale transition also refuses without a second revision", async () => {
    const root = await makeRoot();
    const first = await createOwner(root);
    const second = await openOwner(root);
    const text = reserveText(1, 1);
    const results = await Promise.allSettled([
      first.commit(0, text),
      second.commit(0, text),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const reopened = await openOwner(root);
    expect(reopened.snapshot().revision).toBe(1);
    expect(reopened.snapshot().admissions).toHaveLength(1);
  });

  test("a real write followed by a thrown hook is ambiguous, never rolled back", async () => {
    const root = await makeRoot();
    const initial = await createOwner(root);
    await reserve(initial, 1);
    let hookCalls = 0;
    const handle = await openOwner(root, {
      hook: () => {
        hookCalls += 1;
        throw new Error("lost acknowledgement");
      },
    });
    await expect(handle.commit(1, settleText(1, "unknown", 0.2, false)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(hookCalls).toBe(1);
    expect(handle.snapshot().revision).toBe(1);

    const onDisk = decodeRaw(await primaryText(root));
    expect(onDisk.revision).toBe(2);
    expect(onDisk.admissions[0]!.settlement).toEqual(unknown(2, 0.2, false));

    await expect(handle.commit(1, settleText(1, "unknown", 0.2, false)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(hookCalls).toBe(1);

    const reopened = await openOwner(root);
    expect(reopened.snapshot().revision).toBe(2);
    expect(projection(reopened).observedUsd).toBe(0.2);
  });

  test("a close during the final pre-write pin await leaves the old primary", async () => {
    const root = await makeRoot();
    const initial = await createOwner(root);
    await reserve(initial, 1);
    const before = await primaryText(root);
    let ownerRealpathCalls = 0;
    let resumeGate: (() => void) | undefined;
    let markReached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resumeGate = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (target === ownerDir(root)) {
          ownerRealpathCalls += 1;
          if (ownerRealpathCalls === 6) {
            markReached?.();
            await gate;
          }
        }
        return nodeFileIo.realpath(target);
      },
    };
    const handle = await openOwner(root, { fileIo: io });
    ownerRealpathCalls = 0;
    const pending = handle.commit(1, settleText(1, "unknown", 0.2, false));
    await Promise.race([
      reached,
      pending.then(
        () => {
          throw new Error("commit finished before reaching the final pre-write pin check");
        },
        (error) => {
          throw error;
        },
      ),
    ]);
    handle.close();
    resumeGate?.();
    await expect(pending).rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "closed" });
    expect(await primaryText(root)).toBe(before);
    expect(handle.snapshot().revision).toBe(1);
  });

  test("a post-write lock release failure is ambiguous and cannot be replayed", async () => {
    const root = await makeRoot();
    const initial = await createOwner(root);
    await reserve(initial, 1);
    const before = await primaryText(root);
    const handle = await openOwner(root, {
      hook: async () => {
        await disturbWriteLockOwner(root);
      },
    });
    await expect(handle.commit(1, settleText(1, "unknown", 0.2, false)))
      .rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "ambiguous" });
    expect(handle.snapshot().revision).toBe(2);
    expect(await primaryText(root)).not.toBe(before);
    const onDisk = decodeRaw(await primaryText(root));
    expect(onDisk.revision).toBe(2);
    expect(onDisk.admissions[0]!.settlement).toEqual(unknown(2, 0.2, false));

    const after = await primaryText(root);
    await expect(handle.commit(handle.snapshot().revision, reserveText(2, 3)))
      .rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "ambiguous" });
    expect(await primaryText(root)).toBe(after);

    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });
    expect(observed.checkpoint.revision).toBe(2);
    expect(observed.checkpoint.admissions[0]!.settlement).toEqual(unknown(2, 0.2, false));
  });

  test("initial creation maps a post-write lock release failure to ambiguous without a handle", async () => {
    const root = await makeRoot();
    let hookCalls = 0;
    await expect(createOwner(root, {
      hook: async () => {
        hookCalls += 1;
        await disturbWriteLockOwner(root);
      },
    })).rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "ambiguous" });
    expect(hookCalls).toBe(1);
    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });
    expect(observed.checkpoint.revision).toBe(0);
    expect(observed.checkpoint.admissions).toEqual([]);
  });

  test("a final post-lock root pin failure after a real create write is ambiguous, leaves revision 0", async () => {
    const root = await makeRoot();
    let postWrite = false;
    let postWriteRootRealpaths = 0;
    let writtenRevision: number | undefined;
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (postWrite && target === root) {
          postWriteRootRealpaths += 1;
          if (postWriteRootRealpaths === 2) {
            throw new Error("final root observation failed after lock release");
          }
        }
        return nodeFileIo.realpath(target);
      },
    };
    let returned: NativeHarnessAccountingHandle | undefined;
    try {
      returned = await createOwner(root, {
        fileIo: io,
        hook: async () => {
          writtenRevision = decodeRaw(await primaryText(root)).revision;
          postWrite = true;
        },
      });
    } catch (error) {
      expect(error).toMatchObject({ name: "NativeHarnessAccountingError", code: "ambiguous" });
      expect((error as Error).message).toContain("write or lock release is ambiguous");
    }
    expect(returned).toBeUndefined();
    expect(writtenRevision).toBe(0);
    expect(postWrite).toBe(true);
    expect(postWriteRootRealpaths).toBe(2);

    expect(decodeRaw(await primaryText(root)).revision).toBe(0);
    const observed = await observeNativeHarnessAccountingOwner({
      storageRoot: root,
      selectorSha256: SELECTOR,
    });
    expect(observed.checkpoint.revision).toBe(0);
    expect(observed.checkpoint.admissions).toEqual([]);
    const reopened = await openOwner(root);
    expect(reopened.snapshot().revision).toBe(0);
    expect(reopened.snapshot().admissions).toEqual([]);
    reopened.close();
  });

  test("a same-revision disk change outside identity and limits refuses before write", async () => {
    const admissionRoot = await makeRoot();
    const admissionHandle = await createOwner(admissionRoot);
    await reserve(admissionHandle, 1);
    await settle(admissionHandle, 1, "no-dispatch", 0, false);
    await writeFile(primaryPath(admissionRoot), checkpointText(checkpointValue({
      revision: 2,
      admissions: [row(1, {
        sourceAssociationSha256: hash("f"),
        settlement: noDispatch(2),
      })],
    })), "utf8");
    const admissionAltered = await primaryText(admissionRoot);
    await expect(admissionHandle.commit(2, reserveText(2, 3)))
      .rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "changed" });
    expect(await primaryText(admissionRoot)).toBe(admissionAltered);

    const settlementRoot = await makeRoot();
    const settlementHandle = await createOwner(settlementRoot);
    await reserve(settlementHandle, 1);
    await settle(settlementHandle, 1, "unknown", 0.2, false);
    await writeFile(primaryPath(settlementRoot), checkpointText(checkpointValue({
      revision: 2,
      admissions: [row(1, { settlement: noDispatch(2) })],
    })), "utf8");
    const settlementAltered = await primaryText(settlementRoot);
    await expect(settlementHandle.commit(2, reserveText(2, 3)))
      .rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "changed" });
    expect(await primaryText(settlementRoot)).toBe(settlementAltered);

    const blockRoot = await makeRoot();
    const blockHandle = await createOwner(blockRoot);
    await reserve(blockHandle, 1);
    await bindPrepared(blockHandle, 1);
    await bindRun(blockHandle, 1);
    await block(blockHandle, 1);
    await writeFile(primaryPath(blockRoot), checkpointText(checkpointValue({
      revision: 4,
      admissions: [row(1, { prepared: prepared(1), runId: uuid(101) })],
      budgetBlock: { admissionId: uuid(1), revision: 3, reason: "observed-worker-overspend" },
    })), "utf8");
    const blockAltered = await primaryText(blockRoot);
    await expect(blockHandle.commit(4, settleText(1, "known", 0.2, false)))
      .rejects.toMatchObject({ name: "NativeHarnessAccountingError", code: "changed" });
    expect(await primaryText(blockRoot)).toBe(blockAltered);
  });

  test("invalid transitions and exhausted reservations leave the primary unchanged", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    const initial = await primaryText(root);
    await expect(handle.commit(0, reserveText(1, 1, { allocatedUsd: 0.5 })))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(initial);
    await expect(handle.commit(0, blockText(9))).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(initial);
    await expect(handle.commit(0, "{}")).rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(initial);

    await reserve(handle, 1);
    const reserved = await primaryText(root);
    await expect(handle.commit(1, settleText(1, "known", 0.2, false)))
      .rejects.toThrow(NativeHarnessAccountingError);
    expect(await primaryText(root)).toBe(reserved);
    await expect(handle.commit(1, blockText(1))).resolves.toBeDefined();
  });

  test("unknown reservations are never automatically refunded by runId absence", async () => {
    const root = await makeRoot();
    const handle = await createOwner(root);
    await reserve(handle, 1);
    await settle(handle, 1, "unknown", null, false);
    expect(projection(handle).unknownUsd).toBe(1);
    expect(projection(handle).accountedUsd).toBe(1);
    expect(handle.snapshot().admissions[0]!.runId).toBeNull();
  });
});
