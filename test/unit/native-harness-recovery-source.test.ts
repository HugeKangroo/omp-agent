import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_RECOVERY_SOURCE_FILE,
  NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES,
  NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE,
  NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA,
  NATIVE_HARNESS_RECOVERY_SEED_SCHEMA,
  NativeHarnessRecoverySourceError,
  decodeNativeHarnessRecoverySourceText,
  prepareNativeHarnessRecoverySource,
  verifyNativeHarnessRecoverySource,
  type NativeHarnessRecoverySourceTextExpectation,
  type PreparedRecoverySource,
  type SourceInput,
} from "../../src/native-harness-recovery-source.ts";
import {
  NATIVE_HARNESS_WORKSPACE_LIMITS,
  prepareNativeHarnessWorkspace,
  type NativeHarnessWorkspaceDescriptor,
  type NativeHarnessWorkspaceManifestEntry,
} from "../../src/native-harness-workspace.ts";
import { sha256Hex } from "../../src/native-work.ts";

const bases: string[] = [];

afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMISSION_ID = "22222222-2222-4222-8222-222222222222";
const OBSERVATION_ID = "observation-0001";
const SESSION_ID = "session-0001";
const TOOL_CALL_ID = "call-0001";
const ADMITTED_AT = 1_700_000_000_123;
const MAX_DURATION_MS = 300_000;
const SOURCE_ID = (JSON.parse(
  readFileSync(new URL("../../vendor/harness2/SOURCE.json", import.meta.url), "utf8"),
) as { sourceId: string }).sourceId;

interface WorkspaceFixture {
  readonly base: string;
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly descriptor: NativeHarnessWorkspaceDescriptor;
}

interface SourceFileFixture {
  readonly relativePath: string;
  readonly content: string | Uint8Array;
}

async function makeBase(): Promise<string> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "omp-r2a2b2b-")));
  bases.push(base);
  await chmod(base, 0o700);
  return base;
}

async function makeRealWorkspace(files: readonly SourceFileFixture[]): Promise<WorkspaceFixture> {
  const base = await makeBase();
  const sourceRoot = path.join(base, "source");
  const storageRoot = path.join(base, "storage");
  await mkdir(sourceRoot, { mode: 0o755 });
  await chmod(sourceRoot, 0o755);
  await mkdir(storageRoot, { mode: 0o700 });
  await chmod(storageRoot, 0o700);
  for (const file of files) {
    const absolute = path.join(sourceRoot, ...file.relativePath.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, file.content);
    await chmod(absolute, 0o644);
  }
  const signal = new AbortController().signal;
  const descriptor = await prepareNativeHarnessWorkspace(
    { sourceRoot, storageRoot, inputFiles: files.map((file) => file.relativePath) },
    () => undefined,
    signal,
  );
  return { base, sourceRoot, storageRoot, descriptor };
}

function manifestDigest(entries: readonly NativeHarnessWorkspaceManifestEntry[]): string {
  return sha256Hex(JSON.stringify(entries.map((entry) => [
    entry.relativePath,
    entry.bytes,
    entry.sha256,
  ])));
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
    observationId: OBSERVATION_ID,
    generation: 1,
    sessionId: SESSION_ID,
    workspaceRoot: descriptor.sourceRoot,
    toolCallId: TOOL_CALL_ID,
    toolName: "agent_harness",
  };
}

function associationHash(descriptor: NativeHarnessWorkspaceDescriptor): string {
  return sha256Hex(JSON.stringify(associationDocument(descriptor)));
}

function makeInput(descriptor: NativeHarnessWorkspaceDescriptor): SourceInput {
  return {
    storageRoot: path.dirname(descriptor.preparedRoot),
    descriptor,
    association: associationDocument(descriptor),
    accounting: {
      ownerId: OWNER_ID,
      admissionId: ADMISSION_ID,
      reserveRevision: 9,
      sourceAssociationSha256: associationHash(descriptor),
      admittedAt: ADMITTED_AT,
    },
    budget: {
      maxCostUsd: 0.25,
      deadlineAt: ADMITTED_AT + MAX_DURATION_MS,
      maxDurationMs: MAX_DURATION_MS,
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
}

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function noopGuard(): void {
  // Normal-path guard.
}

async function expectFailure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected the operation to reject");
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function modeOf(target: string): Promise<number> {
  return (await lstat(target)).mode & 0o777;
}

function sourceFileOf(descriptor: NativeHarnessWorkspaceDescriptor): string {
  return path.join(descriptor.preparedRoot, NATIVE_HARNESS_RECOVERY_SOURCE_FILE);
}

async function writeExactSource(target: string, text: string): Promise<void> {
  await writeFile(target, text);
  await chmod(target, 0o600);
}

async function prepare(
  input: SourceInput,
  guard: () => void = noopGuard,
): Promise<PreparedRecoverySource> {
  return prepareNativeHarnessRecoverySource(input, guard, freshSignal());
}

function keysOf(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>);
}

function assertNoForbiddenMetadata(text: string): void {
  for (const forbidden of [
    '"task"',
    '"token"',
    '"secret"',
    '"apiKey"',
    '"key"',
    '"env"',
    '"definition"',
    '"metadata"',
  ]) {
    expect(text.includes(forbidden)).toBe(false);
  }
}

describe("native harness recovery source", () => {
  test("writes and verifies the exact fixed document from a real owned workspace", async () => {
    const inputContent = Buffer.from("\uFEFFhello from the source\r\n", "utf8");
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: inputContent }]);
    const { descriptor } = fixture;
    const input = makeInput(descriptor);
    const prepared = await prepare(input);
    const target = sourceFileOf(descriptor);
    const raw = await readFile(target);

    expect(prepared.source.bytes).toBe(raw.length);
    expect(prepared.source.bytes).toBe(Buffer.byteLength(prepared.source.text, "utf8"));
    expect(Buffer.from(prepared.source.text, "utf8").equals(raw)).toBe(true);
    expect(prepared.source.sha256).toBe(sha256Hex(raw));
    expect(await modeOf(target)).toBe(0o600);

    const document = JSON.parse(prepared.source.text) as Record<string, unknown>;
    expect(keysOf(document)).toEqual([
      "schema",
      "profile",
      "accounting",
      "association",
      "budget",
      "workspace",
      "inputs",
      "inputManifestSha256",
      "backendProfile",
      "backendBuild",
    ]);
    expect(document.schema).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA);
    expect(document.profile).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE);
    expect(document.accounting).toEqual(input.accounting);
    expect(document.association).toEqual(input.association);
    expect(document.budget).toEqual(input.budget);
    expect(document.inputs).toEqual(descriptor.inputManifest.map((entry) => ({
      relativePath: entry.relativePath,
      bytes: entry.bytes,
      sha256: entry.sha256,
      observedAt: entry.observedAt,
    })));
    expect(document.inputManifestSha256).toBe(descriptor.manifestSha256);
    expect(document.backendProfile).toEqual(input.backendProfile);
    expect(document.backendBuild).toEqual(input.backendBuild);

    const workspace = document.workspace as Record<string, unknown>;
    const preparedRelativeRoot = path.basename(descriptor.preparedRoot);
    expect(workspace).toEqual({
      sourceRoot: descriptor.sourceRoot,
      preparedRelativeRoot,
      workspaceRelativeRoot: `${preparedRelativeRoot}/workspace`,
      storeRelativeRoot: `${preparedRelativeRoot}/store`,
    });

    const manifestEntry = descriptor.inputManifest[0]!;
    expect(manifestEntry.sha256).toBe(sha256Hex(inputContent));
    expect(manifestEntry.bytes).toBe(inputContent.length);
    expect(prepared.source.text.startsWith("{")).toBe(true);
    expect(prepared.source.text.endsWith("\n")).toBe(true);
    assertNoForbiddenMetadata(prepared.source.text);

    expect(prepared.accountingPrepared).toEqual({
      preparedRelativeRoot,
      storeRelativeRoot: `${preparedRelativeRoot}/store`,
      inputManifestSha256: descriptor.manifestSha256,
      sourceDescriptorSha256: prepared.source.sha256,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.accountingPrepared)).toBe(true);
    expect(Object.isFrozen(prepared.source)).toBe(true);
    expect(Object.isFrozen(prepared.source.pins)).toBe(true);
    expect(prepared.source.pins.map((pin) => pin.role)).toEqual([
      "storage",
      "prepared",
      "workspace",
      "store",
    ]);
    for (const pin of prepared.source.pins) {
      const actual = await lstat(pin.path, { bigint: true });
      expect(actual.isDirectory()).toBe(true);
      expect(actual.isSymbolicLink()).toBe(false);
      expect(actual.dev).toBe(pin.dev);
      expect(actual.ino).toBe(pin.ino);
    }

    const seed = JSON.parse(prepared.seedText) as Record<string, unknown>;
    expect(keysOf(seed)).toEqual([
      "schema",
      "profile",
      "accountingOwnerId",
      "admissionId",
      "accountingOwnerRevision",
      "sourceAssociationSha256",
      "sourceDescriptorSha256",
      "inputManifestSha256",
      "admittedAt",
      "deadlineAt",
      "allocatedCostUsd",
    ]);
    expect(seed.schema).toBe(NATIVE_HARNESS_RECOVERY_SEED_SCHEMA);
    expect(seed.profile).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE);
    expect(seed.accountingOwnerId).toBe(OWNER_ID);
    expect(seed.admissionId).toBe(ADMISSION_ID);
    expect(seed.accountingOwnerRevision).toBe(9);
    expect(seed.sourceAssociationSha256).toBe(input.accounting.sourceAssociationSha256);
    expect(seed.sourceDescriptorSha256).toBe(prepared.source.sha256);
    expect(seed.inputManifestSha256).toBe(descriptor.manifestSha256);
    expect(seed.admittedAt).toBe(ADMITTED_AT);
    expect(seed.deadlineAt).toBe(ADMITTED_AT + MAX_DURATION_MS);
    expect(seed.allocatedCostUsd).toBe(0.25);
    expect(Buffer.byteLength(prepared.seedText, "utf8")).toBeLessThanOrEqual(4096);

    let verifyGuardCalls = 0;
    await verifyNativeHarnessRecoverySource(
      prepared.source,
      () => { verifyGuardCalls++; },
      freshSignal(),
    );
    expect(verifyGuardCalls).toBeGreaterThan(0);

    // The prepare-time guard is not retained for a later verification.
    const stale = await expectFailure(verifyNativeHarnessRecoverySource(
      prepared.source,
      () => { throw new Error("stale authority"); },
      freshSignal(),
    ));
    expect(stale.message).toContain("guard");
  });

  test("verify refuses missing, changed, reordered and redirected sources", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const { descriptor } = fixture;
    const prepared = await prepare(makeInput(descriptor));
    const target = sourceFileOf(descriptor);
    const exactText = prepared.source.text;
    const verify = (): Promise<void> => verifyNativeHarnessRecoverySource(
      prepared.source,
      noopGuard,
      freshSignal(),
    );

    await verify();

    await unlink(target);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
    expect(await exists(target)).toBe(false);

    await writeExactSource(target, exactText);
    await verify();

    await writeExactSource(target, `${exactText} `);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);

    await writeExactSource(target, exactText);
    await verify();

    const parsed = JSON.parse(exactText) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(parsed).reverse());
    const reordered = `${JSON.stringify(reversed)}\n`;
    expect(Buffer.byteLength(reordered, "utf8")).toBe(Buffer.byteLength(exactText, "utf8"));
    await writeExactSource(target, reordered);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);

    await writeExactSource(target, exactText);
    await chmod(target, 0o644);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
    await chmod(target, 0o600);
    await verify();

    const outsideFile = path.join(fixture.base, "outside.json");
    await writeExactSource(outsideFile, exactText);
    await unlink(target);
    await symlink(outsideFile, target);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
    await unlink(target);
    await writeExactSource(target, exactText);
    await verify();

    const workspaceReal = `${descriptor.workspaceRoot}-real`;
    await rename(descriptor.workspaceRoot, workspaceReal);
    await symlink(workspaceReal, descriptor.workspaceRoot);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
    await unlink(descriptor.workspaceRoot);
    await rename(workspaceReal, descriptor.workspaceRoot);
    await verify();

    const storageReal = `${fixture.storageRoot}-real`;
    await rename(fixture.storageRoot, storageReal);
    await symlink(storageReal, fixture.storageRoot);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
    await unlink(fixture.storageRoot);
    await rename(storageReal, fixture.storageRoot);
    await verify();

    const preparedReal = `${descriptor.preparedRoot}-real`;
    await rename(descriptor.preparedRoot, preparedReal);
    await symlink(preparedReal, descriptor.preparedRoot);
    expect(await expectFailure(verify())).toBeInstanceOf(Error);
  });

  test("refuses to overwrite an existing source document", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const { descriptor } = fixture;
    const prepared = await prepare(makeInput(descriptor));
    const target = sourceFileOf(descriptor);
    const before = await readFile(target);

    const failure = await expectFailure(prepare(makeInput(descriptor)));
    expect(failure.message).toContain("already exists");
    expect((await readFile(target)).equals(before)).toBe(true);
    expect(prepared.source.bytes).toBe(before.length);
  });

  test("rejects malformed metadata before creating the fixed file", async () => {
    const fixture = await makeRealWorkspace([
      { relativePath: "a.txt", content: "a\n" },
      { relativePath: "b.txt", content: "b\n" },
    ]);
    const { descriptor } = fixture;
    const target = sourceFileOf(descriptor);
    const base = makeInput(descriptor);
    const entries = descriptor.inputManifest;

    const withDescriptor = (
      overrides: Partial<NativeHarnessWorkspaceDescriptor>,
    ): NativeHarnessWorkspaceDescriptor => ({ ...descriptor, ...overrides });

    const reversed = [...entries].reverse();
    const unsorted = withDescriptor({
      inputManifest: reversed,
      manifestSha256: manifestDigest(reversed),
    });
    const largeEntries: NativeHarnessWorkspaceManifestEntry[] = [
      { relativePath: "a.bin", bytes: 200_000, sha256: sha256Hex("a.bin"), observedAt: 1 },
      { relativePath: "b.bin", bytes: 200_000, sha256: sha256Hex("b.bin"), observedAt: 2 },
    ];
    const large = withDescriptor({
      inputManifest: largeEntries,
      manifestSha256: manifestDigest(largeEntries),
    });
    const withModel = (model: string): SourceInput => ({
      ...base,
      backendProfile: { ...base.backendProfile, model, improverModel: model },
    });
    const accessorAccounting = { ...base.accounting };
    let accessorRead = false;
    Object.defineProperty(accessorAccounting, "reserveRevision", {
      enumerable: true,
      configurable: true,
      get() {
        accessorRead = true;
        return 9;
      },
    });

    const cases: ReadonlyArray<{ readonly name: string; readonly input: SourceInput }> = [
      {
        name: "association digest",
        input: { ...base, accounting: { ...base.accounting, sourceAssociationSha256: "0".repeat(64) } },
      },
      {
        name: "uppercase hash",
        input: { ...base, accounting: { ...base.accounting, sourceAssociationSha256: "A".repeat(64) } },
      },
      {
        name: "reserve revision",
        input: { ...base, accounting: { ...base.accounting, reserveRevision: 0 } },
      },
      {
        name: "tool name",
        input: { ...base, association: { ...base.association, toolName: "agent_work" as never } },
      },
      {
        name: "workspace alias",
        input: { ...base, association: { ...base.association, workspaceRoot: `${descriptor.sourceRoot}/.` } },
      },
      {
        name: "deadline",
        input: { ...base, budget: { ...base.budget, deadlineAt: base.budget.deadlineAt + 1 } },
      },
      {
        name: "duration",
        input: {
          ...base,
          budget: {
            ...base.budget,
            maxDurationMs: 300_001,
            deadlineAt: base.accounting.admittedAt + 300_001,
          },
        },
      },
      {
        name: "manifest digest",
        input: { ...base, descriptor: withDescriptor({ manifestSha256: "0".repeat(64) }) },
      },
      {
        name: "unsorted manifest",
        input: { ...base, descriptor: unsorted },
      },
      {
        name: "manifest total bytes",
        input: { ...base, descriptor: large },
      },
      {
        name: "unknown top-level field",
        input: { ...base, task: "not allowed" } as unknown as SourceInput,
      },
      {
        name: "unknown descriptor field",
        input: {
          ...base,
          descriptor: { ...descriptor, mode: "product" } as unknown as NativeHarnessWorkspaceDescriptor,
        },
      },
      {
        name: "accessor accounting",
        input: { ...base, accounting: accessorAccounting },
      },
      {
        name: "bad build label",
        input: { ...base, backendBuild: { ...base.backendBuild, sourceId: "not-hex" } },
      },
      {
        name: "wildcard model",
        input: withModel("deepseek/deepseek-*"),
      },
      {
        name: "missing provider separator",
        input: withModel("deepseekflash"),
      },
      {
        name: "overlong model",
        input: withModel(`${"a".repeat(251)}/model`),
      },
    ];

    for (const entry of cases) {
      let guardCalls = 0;
      const failure = await expectFailure(
        prepareNativeHarnessRecoverySource(
          entry.input,
          () => { guardCalls++; },
          freshSignal(),
        ),
      );
      expect(failure.name).toBe("NativeHarnessRecoverySourceError");
      expect(guardCalls).toBe(0);
      expect(await exists(target)).toBe(false);
    }
    expect(accessorRead).toBe(false);
  });

  test("enforces the exact 16384-byte document ceiling including a rejected +1", async () => {
    const base = await makeBase();
    const sourceRoot = path.join(base, "source");
    const storageRoot = path.join(base, "storage");
    await mkdir(sourceRoot, { mode: 0o755 });
    await chmod(sourceRoot, 0o755);
    await mkdir(storageRoot, { mode: 0o700 });
    await chmod(storageRoot, 0o700);
    const preparedRoot = await mkdtemp(path.join(storageRoot, "omp-harness-"));
    await chmod(preparedRoot, 0o700);
    const workspaceRoot = path.join(preparedRoot, "workspace");
    const storeRoot = path.join(preparedRoot, "store");
    await mkdir(workspaceRoot, { mode: 0o700 });
    await mkdir(storeRoot, { mode: 0o700 });
    const quoteSegment = "\"".repeat(240);
    const longPaths = Array.from({ length: NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles }, (_, index) => (
      `p${index}-\u00E9/${quoteSegment}/${quoteSegment}/${quoteSegment}`
    )).sort();
    const entries: NativeHarnessWorkspaceManifestEntry[] = longPaths.map((relativePath, index) => ({
      relativePath,
      bytes: 0,
      sha256: sha256Hex(`protocol-${index}`),
      observedAt: index,
    }));
    // Protocol-only metadata fixture: these paths deliberately never exist in
    // sourceRoot. It is not claimed as actual workspace provenance.
    const descriptor: NativeHarnessWorkspaceDescriptor = {
      schema: "omp-agent.native-harness-workspace.v1",
      sourceRoot,
      preparedRoot,
      workspaceRoot,
      storeRoot,
      inputManifest: entries,
      manifestSha256: manifestDigest(entries),
      gitInitialized: true,
      limitations: [],
    };
    const baseInput = makeInput(descriptor);
    const trialCommand = `/${"x".repeat(4095)}`;
    const withCommand = (command: string): SourceInput => ({
      ...baseInput,
      backendProfile: { ...baseInput.backendProfile, ompCommand: command },
    });

    const trial = await expectFailure(prepare(withCommand(trialCommand)));
    const trialMatch = /document is (\d+) bytes/.exec(trial.message);
    expect(trialMatch).not.toBeNull();
    const trialBytes = Number(trialMatch![1]);
    expect(trialBytes).toBeGreaterThan(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES);

    const delta = trialBytes - NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES;
    const exactCommandLength = trialCommand.length - delta;
    expect(exactCommandLength).toBeGreaterThan(1);
    const exactCommand = `/${"x".repeat(exactCommandLength - 1)}`;
    expect(await exists(sourceFileOf(descriptor))).toBe(false);

    const plusOne = await expectFailure(prepare(withCommand(`${exactCommand}y`)));
    expect(plusOne.message).toContain(String(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES + 1));
    expect(await exists(sourceFileOf(descriptor))).toBe(false);

    const exact = await prepare(withCommand(exactCommand));
    expect(exact.source.bytes).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES);
    expect((await readFile(sourceFileOf(descriptor))).length).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES);
    const document = JSON.parse(exact.source.text) as {
      backendProfile: { model: string; ompCommand: string };
    };
    expect(document.backendProfile.model).toBe("deepseek/deepseek-flash");
    expect(document.backendProfile.ompCommand).toBe(exactCommand);
    expect(exact.source.text.includes("\u00E9")).toBe(true);
    expect(exact.source.text.includes("\\\"")).toBe(true);
    await verifyNativeHarnessRecoverySource(exact.source, noopGuard, freshSignal());
  });

  test("records post-open guard loss as a possibly written refusal and closes the handle", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const { descriptor } = fixture;
    const target = sourceFileOf(descriptor);
    let guardCalls = 0;
    let sawCreated = false;
    const guard = (): void => {
      guardCalls++;
      if (!sawCreated && existsSync(target)) {
        sawCreated = true;
        throw new Error("authority lost after open");
      }
    };

    const failure = await expectFailure(prepareNativeHarnessRecoverySource(makeInput(descriptor), guard, freshSignal()));
    expect(sawCreated).toBe(true);
    expect(guardCalls).toBeGreaterThan(0);
    expect(failure.message).toContain("guard");
    expect(await exists(target)).toBe(true);

    // macOS-only, owned-PID/target-scoped observation. This is not a portable
    // FD proof; other platforms retain the generic post-open refusal checks.
    if (process.platform === "darwin" && existsSync("/usr/sbin/lsof")) {
      const query = (): ReturnType<typeof spawnSync> => spawnSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(process.pid), "-Fn", target],
        { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5000 },
      );

      const closed = query();
      expect(closed.error).toBeUndefined();
      expect(closed.status).toBe(1);
      expect(closed.stdout).not.toContain(target);

      const control = await open(target, "r");
      try {
        const opened = query();
        expect(opened.error).toBeUndefined();
        expect(opened.status).toBe(0);
        expect(opened.stdout).toContain(target);
      } finally {
        await control.close();
      }

      const closedAgain = query();
      expect(closedAgain.error).toBeUndefined();
      expect(closedAgain.status).toBe(1);
      expect(closedAgain.stdout).not.toContain(target);
    }
  });

  test("seals the last pre-open guard against prepared-root redirection", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const { descriptor } = fixture;
    const target = sourceFileOf(descriptor);

    let enumerationCalls = 0;
    const enumerationGuard = (): void => {
      enumerationCalls++;
      if (existsSync(target)) throw new Error("post-open enumeration stop");
    };
    await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(descriptor),
      enumerationGuard,
      freshSignal(),
    ));
    expect(enumerationCalls).toBeGreaterThan(1);
    const lastPreOpenCall = enumerationCalls - 1;
    await unlink(target);

    const outside = path.join(fixture.base, "outside");
    const moved = `${descriptor.preparedRoot}-guard-moved`;
    await mkdir(outside, { mode: 0o700 });
    await chmod(outside, 0o700);
    let calls = 0;
    let redirected = false;
    const guard = (): void => {
      calls++;
      if (calls === lastPreOpenCall) {
        redirected = true;
        renameSync(descriptor.preparedRoot, moved);
        symlinkSync(outside, descriptor.preparedRoot);
      }
    };

    const failure = await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(descriptor),
      guard,
      freshSignal(),
    ));
    expect(redirected).toBe(true);
    expect(calls).toBe(lastPreOpenCall);
    expect(failure.message).not.toContain("already exists");
    expect(await exists(path.join(outside, NATIVE_HARNESS_RECOVERY_SOURCE_FILE))).toBe(false);
    expect(await exists(path.join(moved, NATIVE_HARNESS_RECOVERY_SOURCE_FILE))).toBe(false);
  });

  test("refuses thenable guards and aborted actual signals without calling caller getters", async () => {
    const thenableFixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const thenableTarget = sourceFileOf(thenableFixture.descriptor);
    const thenableGuard = (() => Promise.resolve()) as unknown as () => void;
    const thenableFailure = await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(thenableFixture.descriptor),
      thenableGuard,
      freshSignal(),
    ));
    expect(thenableFailure.message).toContain("synchronous");
    expect(await exists(thenableTarget)).toBe(false);

    const rejectedGuard = (() => Promise.reject(new Error("async guard rejected"))) as unknown as () => void;
    const rejectedFailure = await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(thenableFixture.descriptor),
      rejectedGuard,
      freshSignal(),
    ));
    expect(rejectedFailure.message).toContain("Promise");
    await new Promise((resolve) => setTimeout(resolve, 10));

    let thenCalled = false;
    const plainThenable = (() => ({
      then() {
        thenCalled = true;
      },
    })) as unknown as () => void;
    const plainFailure = await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(thenableFixture.descriptor),
      plainThenable,
      freshSignal(),
    ));
    expect(plainFailure.message).toContain("thenable");
    expect(thenCalled).toBe(false);
    expect(await exists(thenableTarget)).toBe(false);

    const abortFixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const abortTarget = sourceFileOf(abortFixture.descriptor);
    const controller = new AbortController();
    controller.abort();
    let ownGetterCalled = false;
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get() {
        ownGetterCalled = true;
        throw new Error("caller own getter must not be read");
      },
    });
    let guardCalls = 0;
    const abortFailure = await expectFailure(prepareNativeHarnessRecoverySource(
      makeInput(abortFixture.descriptor),
      () => { guardCalls++; },
      controller.signal,
    ));
    expect(abortFailure.message).toContain("aborted");
    expect(ownGetterCalled).toBe(false);
    expect(guardCalls).toBe(0);
    expect(await exists(abortTarget)).toBe(false);
  });

  test("readback rejects files above the leaf ceiling before buffering", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const { descriptor } = fixture;
    const prepared = await prepare(makeInput(descriptor));
    const target = sourceFileOf(descriptor);
    expect(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES).toBeLessThan(NATIVE_HARNESS_WORKSPACE_LIMITS.maxFileBytes);

    await writeExactSource(target, "x".repeat(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES + 1));
    const failure = await expectFailure(verifyNativeHarnessRecoverySource(
      prepared.source,
      noopGuard,
      freshSignal(),
    ));
    expect(failure.message).toContain(String(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES));
  });

  test("rejects oversized source text before UTF-8 buffering", async () => {
    const fixture = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const prepared = await prepare(makeInput(fixture.descriptor));

    const hugeText = `${"x".repeat(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)}y\n`;
    const huge = {
      ...prepared.source,
      text: hugeText,
    } as PreparedRecoverySource["source"];
    const hugeFailure = await expectFailure(verifyNativeHarnessRecoverySource(
      huge,
      noopGuard,
      freshSignal(),
    ));
    expect(hugeFailure.message).toContain("before UTF-8 encoding");

    const multibyteText = `${"\u00E9".repeat(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES / 2)}\n`;
    const multibyte = {
      ...prepared.source,
      text: multibyteText,
    } as PreparedRecoverySource["source"];
    const multibyteFailure = await expectFailure(verifyNativeHarnessRecoverySource(
      multibyte,
      noopGuard,
      freshSignal(),
    ));
    expect(multibyteFailure.message).toContain(String(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES));
  });
});

describe("native harness recovery source pure document decoder", () => {
  async function fixture(): Promise<{
    readonly raw: string;
    readonly expected: NativeHarnessRecoverySourceTextExpectation;
    readonly prepared: PreparedRecoverySource;
    readonly fixture: WorkspaceFixture;
  }> {
    const workspace = await makeRealWorkspace([{ relativePath: "hello.txt", content: "hello\n" }]);
    const prepared = await prepare(makeInput(workspace.descriptor));
    const storageRoot = path.dirname(workspace.descriptor.preparedRoot);
    return {
      raw: await readFile(sourceFileOf(workspace.descriptor), "utf8"),
      expected: {
        storageRoot,
        sourceRoot: workspace.descriptor.sourceRoot,
        preparedRelativeRoot: path.relative(storageRoot, workspace.descriptor.preparedRoot),
      },
      prepared,
      fixture: workspace,
    };
  }

  function failure(
    raw: string,
    expected: NativeHarnessRecoverySourceTextExpectation,
  ): NativeHarnessRecoverySourceError {
    try {
      decodeNativeHarnessRecoverySourceText(raw, expected);
    } catch (error) {
      expect(error).toBeInstanceOf(NativeHarnessRecoverySourceError);
      return error as NativeHarnessRecoverySourceError;
    }
    throw new Error("expected the pure source decoder to refuse");
  }

  test("decodes the writer's exact bytes without pinning or creating a source handle", async () => {
    const f = await fixture();
    const document = decodeNativeHarnessRecoverySourceText(f.raw, f.expected);
    expect(document.sha256).toBe(f.prepared.source.sha256);
    expect(document.sha256).toBe(sha256Hex(Buffer.from(f.raw, "utf8")));
    expect(document.bytes).toBe(Buffer.byteLength(f.raw, "utf8"));
    expect(document.schema).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_SCHEMA);
    expect(document.profile).toBe(NATIVE_HARNESS_RECOVERY_SOURCE_PROFILE);
    expect(document.accounting).toEqual(JSON.parse(f.raw).accounting);
    expect(document.workspace).toEqual({
      sourceRoot: f.fixture.descriptor.sourceRoot,
      preparedRelativeRoot: f.expected.preparedRelativeRoot,
      workspaceRelativeRoot: `${f.expected.preparedRelativeRoot}/workspace`,
      storeRelativeRoot: `${f.expected.preparedRelativeRoot}/store`,
    });
    expect(document.inputs).toEqual(f.fixture.descriptor.inputManifest);
    expect(document.inputManifestSha256).toBe(f.fixture.descriptor.manifestSha256);
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.accounting)).toBe(true);
    expect("text" in document).toBe(false);
    expect("pins" in document).toBe(false);
  });

  test("preserves the exact raw SHA for reordered JSON instead of re-normalizing it", async () => {
    const f = await fixture();
    const parsed = JSON.parse(f.raw) as Record<string, unknown>;
    const reordered = `${JSON.stringify(Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right)),
    ))}\n`;
    expect(reordered).not.toBe(f.raw);
    const document = decodeNativeHarnessRecoverySourceText(reordered, f.expected);
    expect(document.sha256).toBe(sha256Hex(Buffer.from(reordered, "utf8")));
    expect(document.sha256).not.toBe(f.prepared.source.sha256);
    expect(document.inputManifestSha256).toBe(f.fixture.descriptor.manifestSha256);
  });

  test("refuses combined prepared/workspace roots above the writer's path ceiling", async () => {
    const f = await fixture();
    const parsed = JSON.parse(f.raw) as Record<string, any>;
    parsed.workspace.preparedRelativeRoot = "omp-harness-a";
    parsed.workspace.workspaceRelativeRoot = "omp-harness-a/workspace";
    parsed.workspace.storeRelativeRoot = "omp-harness-a/store";
    const raw = `${JSON.stringify(parsed)}\n`;
    const preparedFailure = failure(raw, {
      storageRoot: `/${"a".repeat(4_089)}`,
      sourceRoot: f.expected.sourceRoot,
      preparedRelativeRoot: "omp-harness-a",
    });
    expect(preparedFailure.code).toBe("invalid-input");
    expect(preparedFailure.message).toContain("expectation.preparedRoot");

    const workspaceFailure = failure(raw, {
      storageRoot: `/${"a".repeat(4_079)}`,
      sourceRoot: f.expected.sourceRoot,
      preparedRelativeRoot: "omp-harness-a",
    });
    expect(workspaceFailure.code).toBe("invalid-input");
    expect(workspaceFailure.message).toContain("workspace.workspaceRoot");
  });

  test("refuses manifest, expectation, BOM, newline and size mutations", async () => {
    const f = await fixture();
    const manifestTamper = JSON.parse(f.raw) as Record<string, any>;
    manifestTamper.inputs[0].sha256 = "0".repeat(64);
    const manifestFailure = failure(`${JSON.stringify(manifestTamper)}\n`, f.expected);
    expect(manifestFailure.code).toBe("invalid-input");
    expect(manifestFailure.message).toContain("manifest");

    const wrongRoot = failure(f.raw, { ...f.expected, sourceRoot: `${f.expected.sourceRoot}-other` });
    expect(wrongRoot.code).toBe("identity-changed");
    const wrongPrepared = failure(f.raw, { ...f.expected, preparedRelativeRoot: "omp-harness-other" });
    expect(wrongPrepared.code).toBe("identity-changed");

    const bom = failure(`\uFEFF${f.raw}`, f.expected);
    expect(bom.code).toBe("invalid-input");
    const noLf = failure(f.raw.slice(0, -1), f.expected);
    expect(noLf.code).toBe("invalid-input");
    const oversized = failure(`${"x".repeat(NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES)}y\n`, f.expected);
    expect(oversized.code).toBe("too-large");
  });
});
