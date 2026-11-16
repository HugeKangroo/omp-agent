import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeRunRecoveryOriginText } from "../../vendor/harness2/index.ts";
import {
  RunStore,
  StoreConflictError,
  StoreCorruptionError,
  readRegular,
} from "../../vendor/harness2/upstream/src/store.ts";
import type { RunRecord, RunRecoveryOrigin, RunRecoverySeed } from "../../vendor/harness2/upstream/src/types.ts";

const RUN_ID = "run-recovery-fixture-1";
const ADMITTED_AT = Date.UTC(2026, 0, 1, 0, 0, 0);
const DEADLINE_AT = ADMITTED_AT + 300_000;
const CREATED_AT = new Date(ADMITTED_AT + 1_000).toISOString();
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "33333333-3333-4333-8333-333333333333";
const SHA = (fill: string): string => fill.repeat(64);

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

async function makeStore(): Promise<{ root: string; store: RunStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-recovery-origin-"));
  tempRoots.push(root);
  return { root, store: new RunStore(path.join(root, "runs")) };
}

function seed(overrides: Partial<RunRecoverySeed> = {}): RunRecoverySeed {
  return {
    schema: "omp-agent.native-harness-recovery-seed.v1",
    profile: "native-auto-scoped-files.v1",
    accountingOwnerId: OWNER_ID,
    admissionId: ADMISSION_ID,
    accountingOwnerRevision: 0,
    sourceAssociationSha256: SHA("a"),
    sourceDescriptorSha256: SHA("b"),
    inputManifestSha256: SHA("c"),
    admittedAt: ADMITTED_AT,
    deadlineAt: DEADLINE_AT,
    allocatedCostUsd: 0.5,
    ...overrides,
  };
}

function seedText(mutate?: (value: Record<string, unknown>) => void): string {
  const value = seed() as unknown as Record<string, unknown>;
  if (mutate !== undefined) mutate(value);
  return JSON.stringify(value);
}

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
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
  return { ...base, ...overrides };
}

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

function makeOrigin(record: RunRecord): RunRecoveryOrigin {
  return {
    schema: "omp-agent.native-harness-recovery-origin.v1",
    nonce: NONCE,
    runId: record.id,
    createdAt: record.createdAt,
    recordIdentitySha256: recordIdentity(record),
    seed: seed(),
  };
}

function originBytes(id: string, createdAt: string): number {
  const preview = makeRecord({ id, createdAt, updatedAt: createdAt });
  return Buffer.byteLength(JSON.stringify(makeOrigin(preview)), "utf8");
}

function primaryPath(root: string, id = RUN_ID): string {
  return path.join(root, "runs", id, "run.json");
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

async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

describe("creation-bound recovery origin storage", () => {
  test("creates one store-issued origin inside the initial primary", async () => {
    const { root, store } = await makeStore();
    const created = await store.createWithRecoveryOrigin(makeRecord(), seedText());

    expect(created.revision).toBe(0);
    expect(created.status).toBe("queued");
    expect(created.stages).toEqual({});
    expect(created.snapshot).toBeUndefined();
    expect(created.winner).toBeUndefined();
    const origin = created.recoveryOrigin;
    if (origin === undefined) throw new Error("creation did not record an origin");
    expect(origin.schema).toBe("omp-agent.native-harness-recovery-origin.v1");
    expect(origin.runId).toBe(RUN_ID);
    expect(origin.createdAt).toBe(CREATED_AT);
    expect(origin.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(origin.recordIdentitySha256).toBe(recordIdentity(created));
    expect(origin.seed).toEqual(seed());
    expect(Object.isFrozen(origin)).toBe(true);
    expect(Object.isFrozen(origin.seed)).toBe(true);

    const parsed = JSON.parse(await readText(primaryPath(root))) as Record<string, unknown>;
    expect(parsed.recoveryOrigin).toEqual(origin);
    expect(Object.keys(parsed.recoveryOrigin as Record<string, unknown>).sort()).toEqual([
      "createdAt",
      "nonce",
      "recordIdentitySha256",
      "runId",
      "schema",
      "seed",
    ]);
    expect(Object.keys((parsed.recoveryOrigin as { seed: Record<string, unknown> }).seed).sort()).toEqual([
      "accountingOwnerId",
      "accountingOwnerRevision",
      "admissionId",
      "admittedAt",
      "allocatedCostUsd",
      "deadlineAt",
      "inputManifestSha256",
      "profile",
      "schema",
      "sourceAssociationSha256",
      "sourceDescriptorSha256",
    ]);
    for (const forbidden of ["recoverable", "authorized", "budgetComplete", "pid", "signal", "snapshotId"]) {
      expect(JSON.stringify(parsed.recoveryOrigin)).not.toContain(forbidden);
    }

    const reread = await store.get(RUN_ID);
    expect(reread?.recoveryOrigin).toEqual(origin);
    const decoded = decodeRunRecoveryOriginText(JSON.stringify(origin), RUN_ID);
    expect(decoded).toEqual(origin);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.seed)).toBe(true);
  });

  test("keeps ordinary create/get/save unmarked and legacy schemaVersion unchanged", async () => {
    const { root, store } = await makeStore();
    const created = await store.create(makeRecord());
    expect(Object.hasOwn(created, "recoveryOrigin")).toBe(false);
    expect(created.schemaVersion).toBe(1);

    const loaded = await store.get(RUN_ID);
    if (loaded === undefined) throw new Error("ordinary run was not readable");
    expect(Object.hasOwn(loaded, "recoveryOrigin")).toBe(false);

    const saved = await store.save({ ...loaded, status: "running" }, 0);
    expect(saved.revision).toBe(1);
    expect(saved.status).toBe("running");
    expect(Object.hasOwn(saved, "recoveryOrigin")).toBe(false);
    expect(saved.schemaVersion).toBe(1);
    const parsed = JSON.parse(await readText(primaryPath(root))) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "recoveryOrigin")).toBe(false);
  });

  test("decodes only shape and expected run identity, not record identity", async () => {
    const { store } = await makeStore();
    const created = await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const origin = created.recoveryOrigin;
    if (origin === undefined) throw new Error("creation did not record an origin");

    const zeroIdentity = { ...structuredClone(origin), recordIdentitySha256: SHA("0") };
    expect(decodeRunRecoveryOriginText(JSON.stringify(zeroIdentity), RUN_ID).recordIdentitySha256).toBe(SHA("0"));

    expect(() => decodeRunRecoveryOriginText("\uFEFF" + JSON.stringify(origin), RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText(JSON.stringify(origin), "run-other")).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText("not json", RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText("null", RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText(JSON.stringify({ ...origin, extra: true }), RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText(JSON.stringify({ ...origin, nonce: "NOT-A-UUID" }), RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText(JSON.stringify({ ...origin, seed: { ...origin.seed, deadlineAt: ADMITTED_AT } }), RUN_ID)).toThrow(StoreCorruptionError);
    expect(() => decodeRunRecoveryOriginText(JSON.stringify(origin), "bad id!")).toThrow(StoreCorruptionError);
  });

  test("enforces seed and origin raw byte ceilings before parsing", async () => {
    const { store } = await makeStore();
    const base = JSON.stringify(seed());
    const seedPadding = 4096 - Buffer.byteLength(base, "utf8");
    const accepted = `${" ".repeat(seedPadding)}${base}`;
    expect(Buffer.byteLength(accepted, "utf8")).toBe(4096);
    const oversize = `${accepted} `;
    const oversizedError = await rejection(store.createWithRecoveryOrigin(makeRecord({ id: "run-seed-over" }), oversize));
    expect(oversizedError).toBeInstanceOf(RangeError);
    const multibyteError = await rejection(
      store.createWithRecoveryOrigin(makeRecord({ id: "run-seed-multibyte" }), "\u00e9".repeat(2049)),
    );
    expect(multibyteError).toBeInstanceOf(RangeError);

    const created = await store.createWithRecoveryOrigin(makeRecord(), accepted);
    const origin = created.recoveryOrigin;
    if (origin === undefined) throw new Error("creation did not record an origin");
    const originText = JSON.stringify(origin);
    const originPadding = 8192 - Buffer.byteLength(originText, "utf8");
    const acceptedOrigin = `${" ".repeat(originPadding)}${originText}`;
    expect(Buffer.byteLength(acceptedOrigin, "utf8")).toBe(8192);
    expect(decodeRunRecoveryOriginText(acceptedOrigin, RUN_ID)).toEqual(origin);
    expect(() => decodeRunRecoveryOriginText(`${acceptedOrigin} `, RUN_ID)).toThrow(RangeError);
  });

  test("bounds the embedded origin encoding before write and on re-read", async () => {
    const { root, store } = await makeStore();
    const atCapId = "run-origin-at-cap";
    const overCapId = "run-origin-over-cap";
    // Extended fractional seconds stay parseable and keep the same millisecond.
    const longCreatedAt = (zeros: number): string => `2026-01-01T00:00:01.${"0".repeat(zeros)}Z`;
    const atCapCreatedAt = longCreatedAt(3 + (8192 - originBytes(atCapId, CREATED_AT)));
    const overCapCreatedAt = longCreatedAt(3 + (8193 - originBytes(overCapId, CREATED_AT)));
    expect(Date.parse(atCapCreatedAt)).toBe(Date.parse(CREATED_AT));
    expect(Date.parse(overCapCreatedAt)).toBe(Date.parse(CREATED_AT));

    const exact = await store.createWithRecoveryOrigin(
      makeRecord({ id: atCapId, createdAt: atCapCreatedAt, updatedAt: atCapCreatedAt }),
      seedText(),
    );
    expect(Buffer.byteLength(JSON.stringify(exact.recoveryOrigin), "utf8")).toBe(8192);

    const over = await rejection(store.createWithRecoveryOrigin(
      makeRecord({ id: overCapId, createdAt: overCapCreatedAt, updatedAt: overCapCreatedAt }),
      seedText(),
    ));
    expect(over).toBeInstanceOf(RangeError);
    expect(await readRegular(primaryPath(root, overCapId))).toBeUndefined();

    const plain = await makeStore();
    const embeddedId = "run-embedded-over";
    const embeddedCreatedAt = longCreatedAt(3 + (8193 - originBytes(embeddedId, CREATED_AT)));
    const ordinary = await plain.store.create(makeRecord({ id: embeddedId }));
    const oversize = { ...ordinary, createdAt: embeddedCreatedAt };
    const embedded = await rejection(plain.store.save({ ...oversize, recoveryOrigin: makeOrigin(oversize) }, 0));
    expect(embedded).toBeInstanceOf(RangeError);

    const primary = primaryPath(plain.root, embeddedId);
    const stored = JSON.parse(await readText(primary)) as Record<string, unknown>;
    stored.createdAt = embeddedCreatedAt;
    stored.recoveryOrigin = makeOrigin({ ...ordinary, createdAt: embeddedCreatedAt });
    await writeFile(primary, JSON.stringify(stored));
    const reread = await rejection(plain.store.get("run-embedded-over"));
    expect(reread).toBeInstanceOf(StoreCorruptionError);
  });

  test("rejects malformed, unsafe or inconsistent seeds before touching storage", async () => {
    const { root, store } = await makeStore();
    const cases: Array<[string, string]> = [
      ["wrong schema", seedText((value) => { value.schema = "omp-agent.native-harness-recovery-seed.v2"; })],
      ["wrong profile", seedText((value) => { value.profile = "native-auto-scoped-files.v2"; })],
      ["extra key", seedText((value) => { value.extra = true; })],
      ["missing key", seedText((value) => { delete value.deadlineAt; })],
      ["null seed", "null"],
      ["array seed", "[]"],
      ["uppercase UUID", seedText((value) => { value.accountingOwnerId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"; })],
      ["unsafe revision", seedText((value) => { value.accountingOwnerRevision = Number.MAX_SAFE_INTEGER + 1; })],
      ["string revision", seedText((value) => { value.accountingOwnerRevision = "0"; })],
      ["uppercase hash", seedText((value) => { value.inputManifestSha256 = SHA("A"); })],
      ["short hash", seedText((value) => { value.sourceDescriptorSha256 = "a".repeat(63); })],
      ["inverted window", seedText((value) => { value.deadlineAt = ADMITTED_AT - 1; })],
      ["extended window", seedText((value) => { value.deadlineAt = ADMITTED_AT + 300_001; })],
      ["zero cost", seedText((value) => { value.allocatedCostUsd = 0; })],
      ["oversize cost", seedText((value) => { value.allocatedCostUsd = 1.0001; })],
      ["BOM seed", "\uFEFF" + JSON.stringify(seed())],
    ];
    for (const [index, [label, text]] of cases.entries()) {
      let error: unknown;
      try { await store.createWithRecoveryOrigin(makeRecord({ id: `run-seed-${index}` }), text); }
      catch (caught) { error = caught; }
      if (!(error instanceof StoreCorruptionError)) {
        throw new Error(`${label}: expected StoreCorruptionError, received ${error instanceof Error ? `${error.name}: ${error.message}` : "success"}`);
      }
      expect(await readRegular(path.join(root, "runs", `run-seed-${index}`, "run.json"))).toBeUndefined();
    }
  });

  test("rejects inconsistent initial records and caller-minted origins", async () => {
    const { store } = await makeStore();
    const goodSeed = seedText();
    const execution = {
      kind: "omp-native" as const,
      tools: ["read"],
      approvalMode: "always-ask" as const,
      approval: {},
      source: "fixture",
    };
    const cases: Array<[string, RunRecord, string]> = [
      ["not queued", makeRecord({ id: "run-not-queued", status: "running" }), "version/status"],
      ["not auto", makeRecord({ id: "run-not-auto", config: { ...makeRecord().config, strategy: "legacy" } }), "product/auto"],
      ["execution profile", makeRecord({ id: "run-execution", config: { ...makeRecord().config, execution } }), "execution profile"],
      ["zero cost", makeRecord({ id: "run-zero-cost", config: { ...makeRecord().config, maxCostUsd: 0 } }), "budgets"],
      ["zero duration", makeRecord({ id: "run-zero-duration", config: { ...makeRecord().config, maxDurationMs: 0 } }), "budgets"],
      ["cost mismatch", makeRecord({ id: "run-cost-mismatch", config: { ...makeRecord().config, maxCostUsd: 0.4 } }), "allocation matches"],
      ["created before admission", makeRecord({ id: "run-early", createdAt: new Date(ADMITTED_AT - 1).toISOString() }), "inside the original admission interval"],
      ["created at deadline", makeRecord({ id: "run-late", createdAt: new Date(DEADLINE_AT).toISOString() }), "inside the original admission interval"],
      ["stages present", makeRecord({
        id: "run-stages",
        stages: { baseline: { id: "baseline", status: "running", attempt: 1, cwd: "/fixture", startedAt: CREATED_AT } },
      }), "undispatched"],
    ];
    for (const [label, record, message] of cases) {
      const error = await rejection(store.createWithRecoveryOrigin(record, goodSeed));
      if (!error.message.includes(message)) throw new Error(`${label}: unexpected refusal ${error.message}`);
    }

    const created = await store.createWithRecoveryOrigin(makeRecord(), goodSeed);
    const regularCreate = await rejection(store.create({ ...created }));
    expect(regularCreate).toBeInstanceOf(StoreConflictError);
    const explicitCreate = await rejection(store.createWithRecoveryOrigin({ ...created }, goodSeed));
    expect(explicitCreate).toBeInstanceOf(StoreConflictError);

    const ownUndefined = { ...makeRecord({ id: "run-own-undefined" }), recoveryOrigin: undefined } as unknown as RunRecord;
    const undefinedError = await rejection(store.createWithRecoveryOrigin(ownUndefined, goodSeed));
    expect(undefinedError).toBeInstanceOf(StoreConflictError);

    const malformedStore = new RunStore(path.join((await makeStore()).root, "runs"));
    const ordinary = await malformedStore.create(makeRecord({ id: "run-malformed" }));
    const nullOrigin = { ...ordinary, recoveryOrigin: null } as unknown as RunRecord;
    const nullError = await rejection(malformedStore.save(nullOrigin, 0));
    expect(nullError.message).toContain("run.recoveryOrigin");
    const undefinedOrigin = { ...ordinary, recoveryOrigin: undefined } as unknown as RunRecord;
    const undefinedOriginError = await rejection(malformedStore.save(undefinedOrigin, 0));
    expect(undefinedOriginError.message).toContain("run.recoveryOrigin present");
  });

  test("refuses to attach an origin to an occupied or previously used directory", async () => {
    const { root, store } = await makeStore();
    await mkdir(path.join(root, "runs", RUN_ID), { recursive: true });
    const emptyError = await rejection(store.createWithRecoveryOrigin(makeRecord(), seedText()));
    expect(emptyError).toBeInstanceOf(StoreConflictError);
    expect(await readRegular(primaryPath(root))).toBeUndefined();
    await writeFile(path.join(root, "runs", RUN_ID, "run.json.tmp"), "partial");
    const partialError = await rejection(store.createWithRecoveryOrigin(makeRecord(), seedText()));
    expect(partialError).toBeInstanceOf(StoreConflictError);
    expect(await readRegular(primaryPath(root))).toBeUndefined();
    await rm(path.join(root, "runs", RUN_ID), { recursive: true, force: true });

    const ordinary = await store.create(makeRecord());
    const primaryError = await rejection(store.createWithRecoveryOrigin(makeRecord(), seedText()));
    expect(primaryError).toBeInstanceOf(StoreConflictError);
    expect((await store.get(RUN_ID))?.recoveryOrigin).toBeUndefined();
    expect(ordinary.revision).toBe(0);

    const withBackup = await store.save({ ...(await store.get(RUN_ID))!, status: "running" }, 0);
    expect(withBackup.revision).toBe(1);
    const backupError = await rejection(store.createWithRecoveryOrigin(makeRecord(), seedText()));
    expect(backupError).toBeInstanceOf(StoreConflictError);
    expect((await store.get(RUN_ID))?.recoveryOrigin).toBeUndefined();
  });

  test("CAS loser leaves the marked primary and backup byte-identical", async () => {
    const { root, store } = await makeStore();
    const second = new RunStore(path.join(root, "runs"));
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const firstView = await store.get(RUN_ID);
    const secondView = await second.get(RUN_ID);
    if (firstView === undefined || secondView === undefined) throw new Error("fixture run missing");

    const winner = await store.save({ ...firstView, status: "running" }, 0);
    expect(winner.revision).toBe(1);
    const primaryBefore = await readText(primaryPath(root));
    const backupBefore = await readText(`${primaryPath(root)}.bak`);

    const conflict = await rejection(second.save({ ...secondView, status: "failed" }, 0));
    expect(conflict).toBeInstanceOf(StoreConflictError);
    expect(await readText(primaryPath(root))).toBe(primaryBefore);
    expect(await readText(`${primaryPath(root)}.bak`)).toBe(backupBefore);
    const current = await store.get(RUN_ID);
    expect(current?.status).toBe("running");
    expect(current?.revision).toBe(1);
  });

  test("concurrent saves from two stores have exactly one CAS winner", async () => {
    const { root, store } = await makeStore();
    const second = new RunStore(path.join(root, "runs"));
    const created = await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const initialOrigin = created.recoveryOrigin;
    if (initialOrigin === undefined) throw new Error("creation did not record an origin");
    const firstView = await store.get(RUN_ID);
    const secondView = await second.get(RUN_ID);
    if (firstView === undefined || secondView === undefined) throw new Error("fixture run missing");

    const results = await Promise.allSettled([
      store.save({ ...firstView, status: "running" }, 0),
      second.save({ ...secondView, status: "failed" }, 0),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0];
    if (loser === undefined || loser.status !== "rejected") throw new Error("missing rejected result");
    expect(loser.reason).toBeInstanceOf(StoreConflictError);

    const winner = fulfilled[0];
    if (winner === undefined || winner.status !== "fulfilled") throw new Error("missing fulfilled result");
    expect(winner.value.revision).toBe(1);
    expect(winner.value.id).toBe(RUN_ID);
    expect(winner.value.createdAt).toBe(CREATED_AT);
    expect(winner.value.recoveryOrigin).toEqual(initialOrigin);

    const current = await store.get(RUN_ID);
    expect(current?.revision).toBe(1);
    expect(current?.createdAt).toBe(CREATED_AT);
    expect(current?.recoveryOrigin).toEqual(initialOrigin);
    expect(current?.status).toBe(winner.value.status);
  });

  test("save uses the admitted caller identity after the first await", async () => {
    const { store } = await makeStore();
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const loaded = await store.get(RUN_ID);
    if (loaded === undefined) throw new Error("fixture run missing");

    const mutable = structuredClone(loaded);
    mutable.status = "running";
    const pending = store.save(mutable, 0);
    mutable.id = "run-retargeted";
    mutable.revision = 99;
    mutable.status = "failed";
    const saved = await pending;

    expect(saved.id).toBe(RUN_ID);
    expect(saved.revision).toBe(1);
    expect(saved.status).toBe("running");
    expect((await store.get(RUN_ID))?.status).toBe("running");
    expect(await store.get("run-retargeted")).toBeUndefined();
  });

  test("marked save forbids origin or protected identity mutation but allows progress", async () => {
    const { store } = await makeStore();
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const initial = await store.get(RUN_ID);
    if (initial === undefined) throw new Error("fixture run missing");

    const progressed = await store.save({
      ...initial,
      status: "running",
      stages: {
        baseline: { id: "baseline", status: "running", attempt: 1, cwd: "/fixture", startedAt: CREATED_AT },
      },
    }, 0);
    expect(progressed.revision).toBe(1);
    expect(progressed.createdAt).toBe(CREATED_AT);
    expect(progressed.recoveryOrigin).toEqual(initial.recoveryOrigin);
    expect(JSON.stringify(progressed.recoveryOrigin)).toBe(JSON.stringify(initial.recoveryOrigin));

    const { recoveryOrigin: omitted, ...withoutOrigin } = structuredClone(progressed);
    void omitted;
    const removed = await rejection(store.save(withoutOrigin as RunRecord, 1));
    expect(removed).toBeInstanceOf(StoreConflictError);

    const cloned = structuredClone(progressed);
    if (cloned.recoveryOrigin === undefined) throw new Error("fixture origin missing");
    cloned.recoveryOrigin.nonce = "44444444-4444-4444-8444-444444444444";
    const changed = await rejection(store.save(cloned, 1));
    expect(changed).toBeInstanceOf(StoreConflictError);

    const changedSeed = structuredClone(progressed);
    if (changedSeed.recoveryOrigin === undefined) throw new Error("fixture origin missing");
    changedSeed.recoveryOrigin.seed.inputManifestSha256 = SHA("d");
    const changedSeedError = await rejection(store.save(changedSeed, 1));
    expect(changedSeedError).toBeInstanceOf(StoreConflictError);

    const workspaceError = await rejection(store.save({ ...structuredClone(progressed), workspace: "/elsewhere" }, 1));
    expect(workspaceError.message).toContain("recovery origin record identity");
    const createdError = await rejection(
      store.save({ ...structuredClone(progressed), createdAt: new Date(ADMITTED_AT + 2_000).toISOString() }, 1),
    );
    expect(createdError.message).toContain("recovery origin createdAt");
    const configError = await rejection(store.save({
      ...structuredClone(progressed),
      config: { ...progressed.config, maxCostUsd: 0.4 },
    }, 1));
    expect(configError.message).toContain("recovery origin record identity");

    const unmarkedStore = new RunStore(path.join((await makeStore()).root, "runs"));
    const plain = await unmarkedStore.create(makeRecord({ id: "run-plain" }));
    const added = await rejection(unmarkedStore.save({ ...plain, recoveryOrigin: makeOrigin(plain) }, 0));
    expect(added).toBeInstanceOf(StoreConflictError);
    expect((await unmarkedStore.get("run-plain"))?.recoveryOrigin).toBeUndefined();
  });

  test("refuses backup rollback of marked or declared origins without changing bytes", async () => {
    const { root, store } = await makeStore();
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    await store.save({ ...(await store.get(RUN_ID))!, status: "running" }, 0);
    const primary = primaryPath(root);
    const backup = `${primary}.bak`;
    const backupBytes = await readText(backup);
    await unlink(primary);
    const missing = await rejection(store.recover(RUN_ID));
    expect(missing).toBeInstanceOf(StoreConflictError);
    expect(await readText(backup)).toBe(backupBytes);
    expect(await readRegular(primary)).toBeUndefined();

    const corruptBytes = "{ torn primary\n";
    await writeFile(primary, corruptBytes);
    const corrupt = await rejection(store.recover(RUN_ID));
    expect(corrupt).toBeInstanceOf(StoreConflictError);
    expect(await readText(primary)).toBe(corruptBytes);
    expect(await readText(backup)).toBe(backupBytes);

    const plain = await makeStore();
    await plain.store.create(makeRecord());
    await plain.store.save({ ...(await plain.store.get(RUN_ID))!, status: "running" }, 0);
    const plainPrimary = primaryPath(plain.root);
    const plainBackup = `${plainPrimary}.bak`;
    const plainBackupBytes = await readText(plainBackup);
    await writeFile(plainPrimary, JSON.stringify({ recoveryOrigin: null }));
    const declared = await rejection(plain.store.recover(RUN_ID));
    expect(declared).toBeInstanceOf(StoreConflictError);
    expect(await readText(plainPrimary)).toBe(JSON.stringify({ recoveryOrigin: null }));
    expect(await readText(plainBackup)).toBe(plainBackupBytes);
  });

  test("keeps unmarked backup recovery behavior", async () => {
    const { root, store } = await makeStore();
    await store.create(makeRecord());
    const backup = await store.save({ ...(await store.get(RUN_ID))!, status: "running" }, 0);
    expect(backup.revision).toBe(1);
    const primary = primaryPath(root);
    await writeFile(primary, "destroyed");
    const recovered = await store.recover(RUN_ID);
    expect(recovered.revision).toBe(2);
    expect(recovered.status).toBe("queued");
    expect(recovered.recoveryOrigin).toBeUndefined();
    expect((await store.get(RUN_ID))?.revision).toBe(2);
  });

  test("pre-rename backup failure leaves the marked primary intact", async () => {
    const { root, store } = await makeStore();
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    await store.save({ ...(await store.get(RUN_ID))!, status: "running" }, 0);
    const current = await store.get(RUN_ID);
    if (current === undefined) throw new Error("fixture run missing");
    const primary = primaryPath(root);
    const backup = `${primary}.bak`;
    const primaryBytes = await readText(primary);
    await rm(backup);
    await mkdir(backup);

    const error = await rejection(store.save({ ...current, status: "failed" }, current.revision));
    expect(error).toBeInstanceOf(Error);
    expect(await readText(primary)).toBe(primaryBytes);
    const reread = await store.get(RUN_ID);
    expect(reread?.revision).toBe(current.revision);
    expect(reread?.status).toBe("running");
    expect(reread?.recoveryOrigin).toEqual(current.recoveryOrigin);
  });

  test("creates a private run file and directory", async () => {
    const { root, store } = await makeStore();
    await store.createWithRecoveryOrigin(makeRecord(), seedText());
    const directoryMode = (await stat(path.join(root, "runs", RUN_ID))).mode & 0o777;
    const fileMode = (await stat(primaryPath(root))).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });
});

describe("recovery origin wrapper boundary", () => {
  test("exports the pure decoder and no writable RunStore", async () => {
    const wrapper = await import("../../vendor/harness2/index.ts");
    expect(typeof wrapper.decodeRunRecoveryOriginText).toBe("function");
    expect("RunStore" in wrapper).toBe(false);
  });
});
