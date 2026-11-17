import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
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
  NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES,
  NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS,
  NATIVE_HARNESS_RECONCILIATION_FILES_SCHEMA,
  NativeHarnessReconciliationFilesInputError,
  observeNativeHarnessReconciliationFiles,
  type NativeHarnessReconciliationFileOptions,
  type NativeHarnessReconciliationFilesResult,
} from "../../src/native-harness-reconciliation-files.ts";
import type { NativeHarnessReconciliationExpectation } from "../../src/native-harness-reconciliation.ts";
import {
  nodeFileIo,
  sha256Hex,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
} from "../../src/native-work.ts";
import { RunStore } from "../../vendor/harness2/upstream/src/store.ts";
import type {
  RunRecord,
  RunRecoverySeed,
} from "../../vendor/harness2/upstream/src/types.ts";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const SELECTOR = "c".repeat(64);
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const ADMITTED_AT = 1_700_000_000_123;
const SOURCE_DURATION_MS = 300_000;
const RUN_DURATION_MS = 120_000;
const MAX_COST_USD = 0.25;
const CREATED_AT = new Date(ADMITTED_AT + 1_000).toISOString();
const RUN_CAP = 256 * 1024;
const SOURCE_CAP = 16 * 1024;
const INVENTORY_CAP = 256 * 1024;
const OWNER_CAP = 65_536;
const SOURCE_ID = (JSON.parse(
  readFileSync(new URL("../../vendor/harness2/SOURCE.json", import.meta.url), "utf8"),
) as { sourceId: string }).sourceId;

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FilesFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
  readonly prepared: PreparedRecoverySource;
  readonly runDir: string;
  readonly expected: NativeHarnessReconciliationExpectation;
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
    observationId: "observation-r2b2b",
    generation: 1,
    sessionId: "session-r2b2b",
    workspaceRoot: descriptor.sourceRoot,
    toolCallId: "call-r2b2b",
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
    task: "b2b files fixture task",
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
      id: "r2b2b-fixture-harness",
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

async function makeFixture(): Promise<FilesFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2b2b-files-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const storageRoot = path.join(root, "storage");
  await mkdir(sourceRoot, { mode: 0o755 });
  await mkdir(storageRoot, { mode: 0o700 });
  await writeFile(path.join(sourceRoot, "hello.txt"), "hello from r2b2b\n", "utf8");
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
  owner.close();

  const store = new RunStore(path.join(descriptor.storeRoot, "runs"));
  await store.createWithRecoveryOrigin(runRecord(descriptor), JSON.stringify(seed(descriptor, prepared)));
  const inventory = await createNativeHarnessDispatchInventory({
    storeRoot: store.root,
    runId: RUN_ID,
  });
  inventory.close();

  return {
    root,
    sourceRoot,
    storageRoot,
    descriptor,
    prepared,
    runDir: store.runDir(RUN_ID),
    expected: {
      runId: RUN_ID,
      ownerId: OWNER_ID,
      selectorSha256: SELECTOR,
      storageRoot,
      sourceRoot,
      preparedRelativeRoot: path.relative(storageRoot, descriptor.preparedRoot),
      backendBuildSourceId: SOURCE_ID,
    },
  };
}

function runPath(fixture: FilesFixture): string {
  return path.join(fixture.runDir, "run.json");
}

function sourcePath(fixture: FilesFixture): string {
  return path.join(fixture.descriptor.preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
}

function inventoryPath(fixture: FilesFixture): string {
  return path.join(fixture.runDir, NATIVE_HARNESS_DISPATCH_INVENTORY_FILE);
}

function ownerPath(fixture: FilesFixture): string {
  return path.join(fixture.storageRoot, "accounting-owners", SELECTOR, "owner.json");
}

interface InstrumentedIo {
  readonly io: NativeFileIo;
  readonly calls: { realpath: number; lstat: number; open: number; read: number };
  readonly reads: Map<string, number>;
  readonly opens: { target: string; flags: number }[];
  readonly maxActive: () => number;
}

function instrumentedIo(): InstrumentedIo {
  const calls = { realpath: 0, lstat: 0, open: 0, read: 0 };
  const reads = new Map<string, number>();
  const opens: { target: string; flags: number }[] = [];
  let active = 0;
  let maximum = 0;
  const io: NativeFileIo = {
    ...nodeFileIo,
    realpath: async (target) => {
      calls.realpath += 1;
      return nodeFileIo.realpath(target);
    },
    lstat: async (target, options) => {
      calls.lstat += 1;
      return nodeFileIo.lstat(target, options);
    },
    open: async (target: string, flags: number): Promise<NativeFileHandle> => {
      calls.open += 1;
      opens.push({ target, flags });
      const handle = await nodeFileIo.open(target, flags);
      active += 1;
      maximum = Math.max(maximum, active);
      return {
        stat: (options) => handle.stat(options),
        read: async (buffer, offset, length, position) => {
          calls.read += 1;
          reads.set(target, (reads.get(target) ?? 0) + 1);
          return handle.read(buffer, offset, length, position);
        },
        close: async () => {
          try {
            await handle.close();
          } finally {
            active -= 1;
          }
        },
      };
    },
  };
  return { io, calls, reads, opens, maxActive: () => maximum };
}

function statView(info: NativeFileStats, overrides: {
  readonly dev?: bigint;
  readonly ino?: bigint;
  readonly size?: bigint;
  readonly mtimeNs?: bigint;
  readonly ctimeNs?: bigint;
  readonly file?: boolean;
}): NativeFileStats {
  return {
    dev: overrides.dev ?? info.dev,
    ino: overrides.ino ?? info.ino,
    size: overrides.size ?? info.size,
    mtimeNs: overrides.mtimeNs ?? info.mtimeNs,
    ctimeNs: overrides.ctimeNs ?? info.ctimeNs,
    isFile: () => overrides.file ?? info.isFile(),
    isDirectory: () => info.isDirectory(),
    isSymbolicLink: () => info.isSymbolicLink(),
  };
}

async function factsOf(files: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    const info = await lstat(file, { bigint: true });
    parts.push(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
  }
  return parts.join("|");
}

describe("native harness reconciliation files", () => {
  test("reads the four exact primaries twice and returns bounded stable facts", async () => {
    const fixture = await makeFixture();
    const watched = [runPath(fixture), sourcePath(fixture), inventoryPath(fixture), ownerPath(fixture)];
    const before = await factsOf(watched);
    const instrument = instrumentedIo();
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: instrument.io,
    });

    expect(result.schema).toBe(NATIVE_HARNESS_RECONCILIATION_FILES_SCHEMA);
    expect(result.status).toBe("stable");
    expect(result.observation).toBe("two-pass");
    expect(result.reasons).toEqual([]);
    expect(result.readOnly).toBe(true);
    expect(result.resumeAvailable).toBe(false);
    expect(result.processes).toBe("not-inspected");
    expect(result.artifacts).toBe("not-inspected");
    expect(result.captures).toHaveLength(8);
    expect(result.captures.map((capture) => [capture.pass, capture.file, capture.outcome])).toEqual([
      [1, "run", "captured"],
      [1, "source", "captured"],
      [1, "inventory", "captured"],
      [1, "owner", "captured"],
      [2, "run", "captured"],
      [2, "source", "captured"],
      [2, "inventory", "captured"],
      [2, "owner", "captured"],
    ]);
    expect(result.chargedBytes).toBe(NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES);
    expect(result.chargedBytes).toBe(2 * (RUN_CAP + SOURCE_CAP + INVENTORY_CAP + OWNER_CAP));
    expect(result.chargeLimitBytes).toBe(NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES);
    expect(result.openedFiles).toBe(8);
    expect(result.maxConcurrentOpenedFiles).toBe(1);
    expect(instrument.maxActive()).toBe(1);
    expect(result.close).toEqual({ attempted: 8, settled: 8, succeeded: 8 });
    expect(result.pins).toEqual({ directoryCount: 7, checkedAtEnd: true, stable: true });
    expect(result.deadline.budgetMs).toBe(NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS);
    expect(result.deadline.soft).toBe(true);
    expect(result.deadline.cleanupMayExceedDeadline).toBe(true);
    expect(result.deadline.expired).toBe(false);
    expect(result.metadataStatus).toBe("compatible");
    expect(result.metadata?.metadata).toEqual({ compatible: true, reasons: [] });
    expect(result.metadata?.coverage.status).toBe("complete");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.captures)).toBe(true);
    expect(Object.isFrozen(result.captures[0]!.close)).toBe(true);
    expect(Object.isFrozen(result.reasons)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("b2b files fixture task");
    expect(JSON.stringify(result)).not.toContain("hello from r2b2b");
    expect(await factsOf(watched)).toBe(before);

    for (const capture of result.captures) {
      expect(capture.bytes).not.toBeNull();
      expect(capture.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(capture.close).toEqual({ attempted: true, settled: true, succeeded: true });
      expect(capture.openedFiles).toBe(1);
    }
    expect(result.captures[4]!.matchesFirstPass).toBe(true);
    expect(result.captures.at(-1)!.matchesFirstPass).toBe(true);
    expect(instrument.reads.get(runPath(fixture))).toBe(2);
  });

  test("refuses a missing primary even when a backup is present", async () => {
    const fixture = await makeFixture();
    await rename(runPath(fixture), `${runPath(fixture)}.bak`);
    const instrument = instrumentedIo();
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: instrument.io,
    });

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("missing");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      pass: 1,
      file: "run",
      outcome: "refused",
      reason: "missing",
      chargedBytes: RUN_CAP,
      bytes: null,
      sha256: null,
      openedFiles: 0,
    });
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.openedFiles).toBe(0);
    expect(result.observation).toBe("partial");
    expect(result.metadata).toBeNull();
    expect(result.metadataStatus).toBe("not-observed");
    expect(instrument.opens).toHaveLength(0);
  });

  test("charges and refuses each oversized primary before any allocation or read", async () => {
    const cases: readonly {
      readonly cap: number;
      readonly file: (fixture: FilesFixture) => string;
      readonly expectedCaptures: number;
      readonly expectedCharged: number;
    }[] = [
      { cap: RUN_CAP, file: runPath, expectedCaptures: 1, expectedCharged: RUN_CAP },
      {
        cap: SOURCE_CAP,
        file: sourcePath,
        expectedCaptures: 2,
        expectedCharged: RUN_CAP + SOURCE_CAP,
      },
      {
        cap: INVENTORY_CAP,
        file: inventoryPath,
        expectedCaptures: 3,
        expectedCharged: RUN_CAP + SOURCE_CAP + INVENTORY_CAP,
      },
      {
        cap: OWNER_CAP,
        file: ownerPath,
        expectedCaptures: 4,
        expectedCharged: RUN_CAP + SOURCE_CAP + INVENTORY_CAP + OWNER_CAP,
      },
    ];
    for (const testCase of cases) {
      const fixture = await makeFixture();
      const target = testCase.file(fixture);
      await writeFile(target, "x".repeat(testCase.cap + 1));
      const instrument = instrumentedIo();
      const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
        fileIo: instrument.io,
      });
      const last = result.captures.at(-1)!;
      expect(last.outcome).toBe("refused");
      expect(last.reason).toBe("too-large");
      expect(last.chargedBytes).toBe(testCase.cap);
      expect(result.captures).toHaveLength(testCase.expectedCaptures);
      expect(result.chargedBytes).toBe(testCase.expectedCharged);
      expect(result.status).toBe("unavailable");
      expect(result.reasons).toContain("too-large");
      expect(result.metadata).toBeNull();
      expect(instrument.reads.get(target) ?? 0).toBe(0);
      expect(instrument.opens.some((open) => open.target === target)).toBe(false);
    }
  });

  test("refuses a symlinked primary before open", async () => {
    const fixture = await makeFixture();
    const target = sourcePath(fixture);
    await rm(target);
    await symlink(path.join(fixture.sourceRoot, "hello.txt"), target);
    const instrument = instrumentedIo();
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: instrument.io,
    });

    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("unsafe-path");
    expect(result.captures).toHaveLength(2);
    expect(result.captures[1]).toMatchObject({
      file: "source",
      outcome: "refused",
      reason: "unsafe-path",
      chargedBytes: SOURCE_CAP,
    });
    expect(result.chargedBytes).toBe(RUN_CAP + SOURCE_CAP);
    expect(result.metadata).toBeNull();
    expect(instrument.reads.get(target) ?? 0).toBe(0);
  });

  test("uses O_NONBLOCK and refuses a nonregular opened stat without reading", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    let openedFlags = 0;
    let openedStatCalls = 0;
    let readCalls = 0;
    let closed = 0;
    const nonBlocking = constants.O_NONBLOCK ?? 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      lstat: async (candidate, options) => {
        const info = await nodeFileIo.lstat(candidate, options);
        if (candidate === target) return statView(info, { file: true });
        return info;
      },
      open: async (candidate, flags) => {
        openedFlags = flags;
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: async (): Promise<NativeFileStats> => {
            openedStatCalls += 1;
            return statView(await handle.stat({ bigint: true }), { file: false, size: 1n });
          },
          read: async () => {
            readCalls += 1;
            return { bytesRead: 0 };
          },
          close: async () => {
            closed += 1;
            await handle.close();
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    if (nonBlocking !== 0) expect(openedFlags & nonBlocking).toBe(nonBlocking);
    expect(openedStatCalls).toBe(1);
    expect(readCalls).toBe(0);
    expect(closed).toBe(1);
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("unsafe-path");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      file: "run",
      outcome: "refused",
      reason: "unsafe-path",
      chargedBytes: RUN_CAP,
      openedFiles: 1,
    });
    expect(result.close).toEqual({ attempted: 1, settled: 1, succeeded: 1 });
    expect(result.chargedBytes).toBe(RUN_CAP);
  });

  test("detects changed bytes on the same revision between passes", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    let mutated = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            if (!mutated && candidate === target) {
              mutated = true;
              const parsed = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
              parsed.task = "same revision, changed bytes";
              await writeFile(target, `${JSON.stringify(parsed)}\n`, "utf8");
            }
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    expect(mutated).toBe(true);
    expect(result.status).toBe("different");
    expect(result.reasons).toContain("changed");
    expect(result.captures).toHaveLength(5);
    expect(result.captures[4]).toMatchObject({
      pass: 2,
      file: "run",
      outcome: "captured",
      matchesFirstPass: false,
      chargedBytes: RUN_CAP,
    });
    expect(result.chargedBytes).toBe(RUN_CAP + SOURCE_CAP + INVENTORY_CAP + OWNER_CAP + RUN_CAP);
    expect(result.observation).toBe("partial");
    expect(result.metadata).toBeNull();
    expect(result.metadataStatus).toBe("not-observed");
  });

  test("detects identical bytes replaced by a new inode between passes", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    let replaced = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      lstat: async (candidate, options) => {
        const info = await nodeFileIo.lstat(candidate, options);
        if (!info.isDirectory()) return info;
        return statView(info, { mtimeNs: 0n, ctimeNs: 0n });
      },
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            if (!replaced && candidate === target) {
              replaced = true;
              const contents = await readFile(target);
              const replacement = `${target}.replacement`;
              await writeFile(replacement, contents);
              await rename(replacement, target);
            }
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    expect(replaced).toBe(true);
    expect(result.status).toBe("different");
    expect(result.reasons).toContain("changed");
    expect(result.reasons).not.toContain("parent-changed");
    expect(result.captures).toHaveLength(5);
    expect(result.captures[4]).toMatchObject({
      pass: 2,
      file: "run",
      outcome: "captured",
      matchesFirstPass: false,
    });
    expect(result.observation).toBe("partial");
    expect(result.metadata).toBeNull();
  });

  test("detects a replaced parent directory identity", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    let replaced = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            if (!replaced && candidate === target) {
              replaced = true;
              await rename(fixture.runDir, `${fixture.runDir}.old`);
              await mkdir(fixture.runDir, { mode: 0o700 });
            }
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    expect(replaced).toBe(true);
    expect(result.status).toBe("different");
    expect(result.reasons).toContain("parent-changed");
    expect(result.captures).toHaveLength(2);
    expect(result.captures.at(-1)).toMatchObject({
      pass: 1,
      file: "source",
      outcome: "refused",
      reason: "parent-changed",
    });
    expect(result.chargedBytes).toBe(RUN_CAP + SOURCE_CAP);
    expect(result.pins.stable).toBe(false);
    expect(result.metadata).toBeNull();
  });

  test("seals pinned parents after the last clock callback before open", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    const startedAt = 1_700_000_000_000;
    const oldRunDir = `${fixture.runDir}.old`;
    const foreign = path.join(fixture.root, "foreign-run");
    let armed = false;
    let swapped = false;
    let foreignOpens = 0;
    let foreignReads = 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      lstat: async (candidate, options) => {
        const info = await nodeFileIo.lstat(candidate, options);
        if (candidate === target) armed = true;
        return info;
      },
      open: async (candidate, flags) => {
        if (swapped && candidate === target) foreignOpens += 1;
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (swapped && candidate === target) foreignReads += 1;
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      now: () => {
        if (armed && !swapped) {
          swapped = true;
          renameSync(fixture.runDir, oldRunDir);
          mkdirSync(foreign, { mode: 0o700 });
          writeFileSync(path.join(foreign, "run.json"), "{ \"foreign\": true }\n");
          symlinkSync(foreign, fixture.runDir);
        }
        return startedAt;
      },
    });

    expect(swapped).toBe(true);
    expect(foreignOpens).toBe(0);
    expect(foreignReads).toBe(0);
    expect(result.status).toBe("different");
    expect(result.reasons).toContain("parent-changed");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      file: "run",
      outcome: "refused",
      reason: "parent-changed",
      chargedBytes: RUN_CAP,
    });
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.pins.stable).toBe(false);
    expect(result.metadata).toBeNull();
  });

  test("refuses growth past a narrow cap seen on the opened handle before read", async () => {
    const fixture = await makeFixture();
    const target = sourcePath(fixture);
    let grew = false;
    let sourceReads = 0;
    let sourceCloses = 0;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        if (!grew && candidate === target) {
          grew = true;
          await writeFile(target, "x".repeat(SOURCE_CAP + 1));
        }
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (candidate === target) sourceReads += 1;
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            if (candidate === target) sourceCloses += 1;
            await handle.close();
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    expect(grew).toBe(true);
    expect(sourceReads).toBe(0);
    expect(sourceCloses).toBe(1);
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("too-large");
    expect(result.captures).toHaveLength(2);
    expect(result.captures[1]).toMatchObject({
      file: "source",
      outcome: "refused",
      reason: "too-large",
      chargedBytes: SOURCE_CAP,
      openedFiles: 1,
    });
    expect(result.chargedBytes).toBe(RUN_CAP + SOURCE_CAP);
    expect(result.close).toEqual({ attempted: 2, settled: 2, succeeded: 2 });
    expect(result.metadata).toBeNull();
  });

  test("keeps a final-pin EIO unavailable instead of claiming a change", async () => {
    const fixture = await makeFixture();
    let closed = 0;
    let allClosed = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (allClosed) throw Object.assign(new Error("injected final-pin EIO"), { code: "EIO" });
        return nodeFileIo.realpath(target);
      },
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            closed += 1;
            if (closed === 8) allClosed = true;
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

    expect(closed).toBe(8);
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("io-failed");
    expect(result.reasons).not.toContain("parent-changed");
    expect(result.pins.stable).toBe(false);
    expect(result.pins.checkedAtEnd).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.metadataStatus).toBe("not-observed");
  });

  test("refuses a backward clock instead of extending the window", async () => {
    const fixture = await makeFixture();
    const startedAt = 1_700_000_000_000;
    let calls = 0;
    const instrument = instrumentedIo();
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: instrument.io,
      now: () => {
        calls += 1;
        return calls === 1 ? startedAt : startedAt - 1;
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("io-failed");
    expect(result.captures).toHaveLength(0);
    expect(result.chargedBytes).toBe(0);
    expect(result.deadline.expired).toBe(false);
    expect(result.deadline.checkedAt).toBe(startedAt);
    expect(result.metadata).toBeNull();
    expect(instrument.calls).toEqual({ realpath: 0, lstat: 0, open: 0, read: 0 });
  });

  test("observes the deadline after a settled first-pin rejection", async () => {
    const fixture = await makeFixture();
    const startedAt = 1_700_000_000_000;
    let expired = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (!expired && target === fixture.storageRoot) {
          expired = true;
          throw Object.assign(new Error("injected missing"), { code: "ENOENT" });
        }
        return nodeFileIo.realpath(target);
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      now: () => expired ? startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS : startedAt,
    });

    expect(result.status).toBe("expired");
    expect(result.reasons).toContain("deadline-expired");
    expect(result.reasons).toContain("missing");
    expect(result.captures).toHaveLength(0);
    expect(result.chargedBytes).toBe(0);
    expect(result.deadline.expired).toBe(true);
    expect(result.deadline.checkedAt).toBe(startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS);
    expect(result.metadata).toBeNull();
  });

  test("refuses invalid expectations and signals before any IO", async () => {
    const fixture = await makeFixture();
    const cases: readonly {
      readonly expectation: NativeHarnessReconciliationExpectation;
      readonly options?: NativeHarnessReconciliationFileOptions;
    }[] = [
      { expectation: { ...fixture.expected, runId: "../escape" } },
      { expectation: { ...fixture.expected, preparedRelativeRoot: "omp-harness-short" } },
      { expectation: { ...fixture.expected, storageRoot: `${fixture.storageRoot}/` } },
      { expectation: { ...fixture.expected, sourceRoot: path.join(fixture.storageRoot, "source") } },
      {
        expectation: fixture.expected,
        options: { signal: {} as AbortSignal },
      },
    ];
    for (const testCase of cases) {
      const instrument = instrumentedIo();
      await expect(observeNativeHarnessReconciliationFiles(testCase.expectation, {
        ...testCase.options,
        fileIo: instrument.io,
      })).rejects.toThrow(NativeHarnessReconciliationFilesInputError);
      expect(instrument.calls).toEqual({ realpath: 0, lstat: 0, open: 0, read: 0 });
      expect(instrument.opens).toHaveLength(0);
      expect(instrument.reads.size).toBe(0);
    }
  });

  test("copies the expectation before the first await", async () => {
    const fixture = await makeFixture();
    const mutable = { ...fixture.expected };
    let mutated = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      realpath: async (target) => {
        if (!mutated) {
          mutated = true;
          mutable.runId = "99999999-9999-4999-8999-999999999999";
          mutable.storageRoot = "/nonexistent/replacement";
          mutable.preparedRelativeRoot = "omp-harness-AAAAAA";
        }
        return nodeFileIo.realpath(target);
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(mutable, { fileIo: io });

    expect(mutated).toBe(true);
    expect(result.status).toBe("stable");
    expect(result.metadataStatus).toBe("compatible");
    expect(result.chargedBytes).toBe(NATIVE_HARNESS_RECONCILIATION_FILES_CHARGED_BYTES);
  });

  test("stops after the single deadline instead of extending it per await", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    const startedAt = 1_700_000_000_000;
    let expired = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            if (!expired && candidate === target) expired = true;
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      now: () => expired ? startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS : startedAt,
    });

    expect(result.status).toBe("expired");
    expect(result.reasons).toContain("deadline-expired");
    expect(result.captures).toHaveLength(1);
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.deadline.deadlineAt).toBe(startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS);
    expect(result.deadline.expired).toBe(true);
    expect(result.deadline.soft).toBe(true);
    expect(result.metadata).toBeNull();
  });

  test("stops starting captures after abort without skipping the original close", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    const controller = new AbortController();
    let closeSettled = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            await handle.close();
            closeSettled = true;
            if (candidate === target) controller.abort();
          },
        };
      },
    };
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      signal: controller.signal,
    });

    expect(closeSettled).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.reasons).toContain("aborted");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]!.close).toEqual({ attempted: true, settled: true, succeeded: true });
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.metadata).toBeNull();
  });

  test("holds the outer promise while a real read is held after the deadline", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    const startedAt = 1_700_000_000_000;
    let expired = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    let heldOnce = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            if (!heldOnce && candidate === target) {
              heldOnce = true;
              started();
              await held;
            }
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    };
    let settled = false;
    const pending = observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      now: () => expired ? startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS : startedAt,
    }).then((result) => {
      settled = true;
      return result;
    });
    let assertionFailure: unknown = null;
    try {
      await readStarted;
      expired = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
    } catch (error) {
      assertionFailure = error;
    } finally {
      release();
    }
    const result = await pending;
    if (assertionFailure !== null) throw assertionFailure;
    expect(settled).toBe(true);
    expect(result.status).toBe("expired");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      file: "run",
      outcome: "refused",
      reason: "deadline-expired",
      chargedBytes: RUN_CAP,
      close: { attempted: true, settled: true, succeeded: true },
    });
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.deadline.expired).toBe(true);
    expect(result.metadata).toBeNull();
  });

  test("holds the outer promise while a real close is held after abort", async () => {
    const fixture = await makeFixture();
    const target = runPath(fixture);
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const closeStarted = new Promise<void>((resolve) => { started = resolve; });
    let heldOnce = false;
    const io: NativeFileIo = {
      ...nodeFileIo,
      open: async (candidate, flags) => {
        const handle = await nodeFileIo.open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
          close: async () => {
            if (!heldOnce && candidate === target) {
              heldOnce = true;
              started();
              await held;
            }
            await handle.close();
          },
        };
      },
    };
    let settled = false;
    const pending = observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: io,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    let assertionFailure: unknown = null;
    try {
      await closeStarted;
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
    } catch (error) {
      assertionFailure = error;
    } finally {
      release();
    }
    const result = await pending;
    if (assertionFailure !== null) throw assertionFailure;
    expect(settled).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]).toMatchObject({
      file: "run",
      outcome: "captured",
      close: { attempted: true, settled: true, succeeded: true },
    });
    expect(result.chargedBytes).toBe(RUN_CAP);
    expect(result.metadata).toBeNull();
  });

  test("refuses stable facts when the original close rejects Error, null or undefined", async () => {
    for (const rejection of [new Error("close failed"), null, undefined]) {
      const fixture = await makeFixture();
      let opens = 0;
      const io: NativeFileIo = {
        ...nodeFileIo,
        open: async (candidate, flags) => {
          opens += 1;
          const handle = await nodeFileIo.open(candidate, flags);
          return {
            stat: (options) => handle.stat(options),
            read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async () => {
              await handle.close();
              throw rejection;
            },
          };
        },
      };
      const result = await observeNativeHarnessReconciliationFiles(fixture.expected, { fileIo: io });

      expect(opens).toBe(1);
      expect(result.status).toBe("unknown");
      expect(result.reasons).toContain("close-failed");
      expect(result.captures).toHaveLength(1);
      expect(result.captures[0]).toMatchObject({
        outcome: "refused",
        reason: "close-failed",
        chargedBytes: RUN_CAP,
        openedFiles: 1,
      });
      expect(result.chargedBytes).toBe(RUN_CAP);
      expect(result.close).toEqual({ attempted: 1, settled: 1, succeeded: 0 });
      expect(result.metadata).toBeNull();
      expect(result.metadataStatus).toBe("not-observed");
    }
  });

  test("closes a handle that fulfills open after abort or deadline", async () => {
    for (const mode of ["abort", "deadline"] as const) {
      const fixture = await makeFixture();
      const target = runPath(fixture);
      const controller = new AbortController();
      const startedAt = 1_700_000_000_000;
      let expired = false;
      let actualClosed = 0;
      const io: NativeFileIo = {
        ...nodeFileIo,
        open: async (candidate, flags) => {
          const handle = await nodeFileIo.open(candidate, flags);
          if (candidate === target) {
            if (mode === "abort") controller.abort();
            else expired = true;
          }
          return {
            stat: (options) => handle.stat(options),
            read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
            close: async () => {
              actualClosed += 1;
              await handle.close();
            },
          };
        },
      };
      const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
        fileIo: io,
        ...(mode === "abort" ? { signal: controller.signal } : {}),
        ...(mode === "deadline"
          ? { now: () => expired ? startedAt + NATIVE_HARNESS_RECONCILIATION_FILES_DEADLINE_MS : startedAt }
          : {}),
      });

      expect(actualClosed).toBe(1);
      expect(result.captures).toHaveLength(1);
      expect(result.captures[0]).toMatchObject({
        file: "run",
        outcome: "refused",
        chargedBytes: RUN_CAP,
        openedFiles: 1,
      });
      expect(result.openedFiles).toBe(1);
      expect(result.close).toEqual({ attempted: 1, settled: 1, succeeded: 1 });
      expect(result.chargedBytes).toBe(RUN_CAP);
      expect(result.metadata).toBeNull();
      if (mode === "abort") {
        expect(result.status).toBe("aborted");
        expect(result.captures[0]!.reason).toBe("aborted");
      } else {
        expect(result.status).toBe("expired");
        expect(result.captures[0]!.reason).toBe("deadline-expired");
      }
    }
  });

  test("reports stable files with incompatible metadata as a separate status", async () => {
    const fixture = await makeFixture();
    const target = sourcePath(fixture);
    const parsed = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
    parsed.budget.maxCostUsd = 0.2;
    await writeFile(target, `${JSON.stringify(parsed)}\n`, "utf8");
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected);

    expect(result.status).toBe("stable");
    expect(result.reasons).toEqual([]);
    expect(result.observation).toBe("two-pass");
    expect(result.metadataStatus).toBe("incompatible");
    expect(result.metadata?.metadata.compatible).toBe(false);
    expect(result.metadata?.metadata.reasons).toContain("run-allocation-mismatch");
    expect(result.pins.stable).toBe(true);
    expect(Object.hasOwn(result, "recoverable")).toBe(false);
    expect(Object.hasOwn(result, "eligible")).toBe(false);
  });

  test("refuses an already-aborted signal before any primary read", async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    controller.abort();
    const instrument = instrumentedIo();
    const result = await observeNativeHarnessReconciliationFiles(fixture.expected, {
      fileIo: instrument.io,
      signal: controller.signal,
    });

    expect(result.status).toBe("aborted");
    expect(result.captures).toHaveLength(0);
    expect(result.chargedBytes).toBe(0);
    expect(result.pins.stable).toBe(false);
    expect(result.metadata).toBeNull();
    expect(instrument.opens).toHaveLength(0);
    expect(instrument.reads.size).toBe(0);
  });
});
