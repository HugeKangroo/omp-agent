import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNativeHarnessAccountingOwner,
  type NativeHarnessAccountingHandle,
} from "../../src/native-harness-accounting.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE,
  NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA,
  createNativeHarnessAccountingSession,
  decodeNativeHarnessAccountingOwnerLocator,
  type NativeHarnessAccountingOwnerLocator,
  type NativeHarnessAccountingSession,
  type NativeHarnessAccountingSessionConfirmation,
  type NativeHarnessAccountingSessionResult,
} from "../../src/native-harness-accounting-session.ts";
import type { NativeHarnessDelegationLimits } from "../../src/native-harness-delegation.ts";
import { sha256Hex } from "../../src/native-work.ts";

const LIMITS: NativeHarnessDelegationLimits = Object.freeze({
  maxRetainedOperations: 16,
  maxConcurrent: 1,
  perRunUsd: 1,
  lifetimeUsd: 5,
  maxDurationMs: 300_000,
  cleanupGraceMs: 30_000,
});
const LIMITS_TEXT = JSON.stringify(LIMITS);
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

interface TestEntry extends Record<string, unknown> {
  id: string;
  parentId: string | null;
  type: string;
}

interface FixtureState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly recordedCwd: string;
  readonly sessionDir: string;
  readonly sessionFile: string;
  leafId: string | null;
  readonly entries: TestEntry[];
  ensureCalls: number;
  appendCalls: number;
  sequence: number;
  releaseEnsure: (() => void) | null;
  rejectEnsure: (() => void) | null;
}

type EnsureMode = "write" | "noop" | "defer" | "throw" | "reject";
type AppendMode = "native" | "throw-after" | "throw-before" | "noop";

interface FixtureOptions {
  readonly missingFile?: boolean;
  readonly ensurePlan?: (call: number, state: FixtureState) => EnsureMode;
  readonly appendMode?: AppendMode;
  readonly isOwnerCurrent?: (context: unknown, state: FixtureState) => boolean;
  readonly now?: () => number;
  readonly limitsText?: string;
}

interface Fixture {
  readonly root: string;
  readonly storageRoot: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile: string;
  readonly state: FixtureState;
  readonly manager: Record<string, unknown>;
  readonly context: Record<string, unknown>;
  readonly selector: string;
  readonly namespace: string;
  readonly ownerDir: string;
  readonly ownerFile: string;
  newLeaf(): NativeHarnessAccountingSession;
  write(): void;
  ownerId(): string | null;
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-association-a2a2-")));
  roots.push(root);
  const sessionDir = path.join(root, "sessions");
  const cwd = path.join(root, "workspace");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const sessionId = "session-association-a2a2";
  const sessionFile = path.join(sessionDir, "2026-01-01_session-association-a2a2.jsonl");
  const base: TestEntry = {
    id: "base-1",
    parentId: null,
    type: "message",
    message: { role: "user", content: "hello" },
  };
  const state: FixtureState = {
    sessionId,
    cwd,
    recordedCwd: cwd,
    sessionDir,
    sessionFile,
    leafId: null,
    entries: [base],
    ensureCalls: 0,
    appendCalls: 0,
    sequence: 0,
    releaseEnsure: null,
    rejectEnsure: null,
  };
  state.leafId = base.id;
  const selector = sha256Hex(JSON.stringify({
    sessionFile,
    sessionId,
    workspaceRoot: cwd,
  }));
  const namespace = path.join(root, "accounting-owners");
  const ownerDir = path.join(namespace, selector);
  const ownerFile = path.join(ownerDir, "owner.json");

  const write = (): void => {
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: state.sessionId,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: state.recordedCwd,
    });
    const body = state.entries.map((entry) => JSON.stringify(entry));
    writeFileSync(state.sessionFile, `${[header, ...body].join("\n")}\n`, "utf8");
  };

  const manager: Record<string, unknown> = {
    getSessionId(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.sessionId;
    },
    getCwd(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.cwd;
    },
    getRecordedCwd(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.recordedCwd;
    },
    getSessionDir(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.sessionDir;
    },
    getSessionFile(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.sessionFile;
    },
    getLeafId(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.leafId;
    },
    getBranch(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
      const chain: TestEntry[] = [];
      const seen = new Set<string>();
      let cursor = state.leafId;
      while (cursor !== null) {
        if (seen.has(cursor)) throw new Error("fixture branch cycle");
        seen.add(cursor);
        const entry = byId.get(cursor);
        if (entry === undefined) throw new Error("fixture branch dangling");
        chain.push(entry);
        cursor = entry.parentId;
      }
      return chain.reverse();
    },
    getEntries(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      return state.entries.slice();
    },
    ensureOnDisk(this: unknown) {
      if (this !== manager) throw new Error("fixture receiver");
      state.ensureCalls += 1;
      const mode = options.ensurePlan?.(state.ensureCalls, state) ?? "write";
      if (mode === "throw") throw new Error("fixture ensure throw");
      if (mode === "reject") return Promise.reject(new Error("fixture ensure reject"));
      if (mode === "noop") return Promise.resolve();
      if (mode === "defer") {
        return new Promise<void>((resolve, reject) => {
          state.releaseEnsure = () => {
            write();
            resolve();
          };
          state.rejectEnsure = () => reject(new Error("fixture deferred reject"));
        });
      }
      write();
      return Promise.resolve();
    },
  };

  if (options.missingFile !== true) write();

  const appendEntry = (customType: string, data?: unknown): void => {
    state.appendCalls += 1;
    const mode = options.appendMode ?? "native";
    if (mode === "throw-before") throw new Error("fixture append throw before");
    if (mode === "noop") return;
    state.sequence += 1;
    const id = `locator-${state.sequence}`;
    state.entries.push({
      id,
      parentId: state.leafId,
      type: "custom",
      customType,
      data,
    });
    state.leafId = id;
    if (mode === "throw-after") throw new Error("fixture append throw after");
  };

  const newLeaf = (): NativeHarnessAccountingSession => createNativeHarnessAccountingSession({
    storageRoot: root,
    limitsText: options.limitsText ?? LIMITS_TEXT,
    appendEntry,
    isOwnerCurrent: (context: unknown) => options.isOwnerCurrent?.(context, state) ?? true,
    now: options.now ?? (() => Date.now()),
  });

  const fixture: Fixture = {
    root,
    storageRoot: root,
    sessionId,
    cwd,
    sessionDir,
    sessionFile,
    state,
    manager,
    context: {
      cwd,
      agent: { kind: "main" },
      sessionManager: manager,
    },
    selector,
    namespace,
    ownerDir,
    ownerFile,
    newLeaf,
    write,
    ownerId() {
      try {
        const text = readFileSync(ownerFile, "utf8");
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return null;
        const value = (parsed as Record<string, unknown>).ownerId;
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },
  };
  return fixture;
}

async function createOwner(
  fixture: Fixture,
  ownerId = OWNER,
  selector = fixture.selector,
): Promise<NativeHarnessAccountingHandle> {
  const handle = await createNativeHarnessAccountingOwner({
    storageRoot: fixture.storageRoot,
    selectorSha256: selector,
    ownerId,
    createdAt: 1_700_000_000_000,
    limitsText: LIMITS_TEXT,
  });
  handle.close();
  return handle;
}

function mainSignal(): AbortSignal {
  return new AbortController().signal;
}

async function ensure(
  leaf: NativeHarnessAccountingSession,
  fixture: Fixture,
  overrides: {
    readonly context?: unknown;
    readonly signal?: unknown;
    readonly deadlineAt?: number;
  } = {},
): Promise<NativeHarnessAccountingSessionResult> {
  return leaf.ensure(
    overrides.context ?? fixture.context,
    overrides.signal ?? mainSignal(),
    overrides.deadlineAt ?? Date.now() + 60_000,
  );
}

function confirmed(result: NativeHarnessAccountingSessionResult): NativeHarnessAccountingSessionConfirmation {
  expect(result.state).toBe("confirmed");
  if (result.state !== "confirmed") throw new Error("expected a confirmed association");
  return result;
}

function locatorData(ownerId: string, selector: string): NativeHarnessAccountingOwnerLocator {
  return {
    schema: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA,
    ownerId,
    selectorSha256: selector,
    ownerRelativePath: `accounting-owners/${selector}/owner.json`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, milliseconds = 1_000): Promise<void> {
  const end = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("fixture wait timed out");
    await sleep(1);
  }
}

/** A second manager object with identical session paths and state. */
function replacementManager(fixture: Fixture): Record<string, unknown> {
  const state = fixture.state;
  const branch = (): TestEntry[] => {
    const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
    const chain: TestEntry[] = [];
    const seen = new Set<string>();
    let cursor = state.leafId;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error("fixture branch cycle");
      seen.add(cursor);
      const entry = byId.get(cursor);
      if (entry === undefined) throw new Error("fixture branch dangling");
      chain.push(entry);
      cursor = entry.parentId;
    }
    return chain.reverse();
  };
  return {
    getSessionId: () => state.sessionId,
    getCwd: () => state.cwd,
    getRecordedCwd: () => state.recordedCwd,
    getSessionDir: () => state.sessionDir,
    getSessionFile: () => state.sessionFile,
    getLeafId: () => state.leafId,
    getBranch: branch,
    getEntries: () => state.entries.slice(),
    ensureOnDisk: () => {
      state.ensureCalls += 1;
      fixture.write();
      return Promise.resolve();
    },
  };
}

describe("native accounting-owner session association", () => {
  test("constructor starts zero I/O and rejects invalid fixed config", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-association-zero-")));
    roots.push(root);
    expect(readdirSync(root)).toEqual([]);
    let appends = 0;
    const leaf = createNativeHarnessAccountingSession({
      storageRoot: root,
      limitsText: LIMITS_TEXT,
      appendEntry: () => {
        appends += 1;
      },
      isOwnerCurrent: () => true,
    });
    expect(readdirSync(root)).toEqual([]);
    expect(appends).toBe(0);
    leaf.dispose();

    expect(() => createNativeHarnessAccountingSession({
      storageRoot: "relative/root",
      limitsText: LIMITS_TEXT,
      appendEntry: () => undefined,
      isOwnerCurrent: () => true,
    })).toThrow();
    expect(() => createNativeHarnessAccountingSession({
      storageRoot: root,
      limitsText: "",
      appendEntry: () => undefined,
      isOwnerCurrent: () => true,
    })).toThrow();
    expect(() => createNativeHarnessAccountingSession({
      storageRoot: root,
      limitsText: LIMITS_TEXT,
      appendEntry: undefined as unknown as (customType: string, data?: unknown) => void,
      isOwnerCurrent: () => true,
    })).toThrow();
  });

  test("fresh association confirms one exact locator and reuses it on the same and a new instance", async () => {
    const fixture = makeFixture({ missingFile: true });
    expect(existsSync(fixture.sessionFile)).toBe(false);
    const first = fixture.newLeaf();
    const result = confirmed(await ensure(first, fixture));
    expect(existsSync(fixture.sessionFile)).toBe(true);
    expect(result.created).toBe(true);
    expect(result.confirmation).toBe("observed-only");
    expect(result.identity.selectorSha256).toBe(fixture.selector);
    expect(result.locator.ownerRelativePath).toBe(`accounting-owners/${fixture.selector}/owner.json`);
    expect(result.locatorEntryIds).toHaveLength(1);
    expect(fixture.ownerId()).toBe(result.identity.ownerId);
    expect(fixture.state.appendCalls).toBe(1);
    expect(readFileSync(fixture.sessionFile, "utf8")).toContain(result.locatorEntryIds[0]!);
    expect(Object.isFrozen(result)).toBe(true);

    const second = confirmed(await ensure(first, fixture));
    expect(second.identity.ownerId).toBe(result.identity.ownerId);
    expect(second.locatorEntryIds).toEqual(result.locatorEntryIds);
    expect(second.created).toBe(false);
    expect(fixture.state.appendCalls).toBe(1);

    const fresh = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(fresh.identity.ownerId).toBe(result.identity.ownerId);
    expect(fresh.locatorEntryIds).toEqual(result.locatorEntryIds);
    expect(fixture.state.appendCalls).toBe(1);

    const inherited: Record<string, unknown> = Object.create({
      cwd: fixture.cwd,
      agent: { kind: "main" },
      sessionManager: fixture.manager,
    });
    inherited.ui = { setWidget: () => undefined };
    const inheritedResult = confirmed(await ensure(first, fixture, { context: inherited }));
    expect(inheritedResult.identity.ownerId).toBe(result.identity.ownerId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("foreign main context, pre-aborted signal and expired deadline have zero effects", async () => {
    const fixture = makeFixture();
    const leaf = fixture.newLeaf();
    const foreign = {
      cwd: fixture.cwd,
      agent: { kind: "sub" },
      sessionManager: fixture.manager,
    };
    const foreignResult = await ensure(leaf, fixture, { context: foreign });
    expect(foreignResult.state).toBe("invalidated");
    expect(fixture.state.ensureCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const aborted = await ensure(leaf, fixture, { signal: controller.signal });
    expect(aborted.state).toBe("invalidated");
    expect(fixture.state.ensureCalls).toBe(0);

    const expired = await ensure(leaf, fixture, { deadlineAt: Date.now() - 1 });
    expect(expired.state).toBe("invalidated");
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.appendCalls).toBe(0);
    expect(readdirSync(fixture.root).sort()).toEqual(["sessions", "workspace"]);
  });

  test("same-instance overlap refuses before a second ensure or append", async () => {
    const fixture = makeFixture({ ensurePlan: (call) => (call === 1 ? "defer" : "write") });
    const leaf = fixture.newLeaf();
    const firstPromise = ensure(leaf, fixture);
    expect(fixture.state.ensureCalls).toBe(1);
    const overlap = await ensure(leaf, fixture);
    expect(overlap.state).toBe("pending");
    expect(fixture.state.ensureCalls).toBe(1);
    expect(fixture.state.appendCalls).toBe(0);
    fixture.state.releaseEnsure?.();
    const first = confirmed(await firstPromise);
    expect(first.created).toBe(true);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("reentrant clock and owner callbacks see the active operation and cannot start another", async () => {
    let clockFixture!: Fixture;
    let clockLeaf!: NativeHarnessAccountingSession;
    let clockInner: Promise<NativeHarnessAccountingSessionResult> | null = null;
    let clockReentered = false;
    clockFixture = makeFixture({
      now: () => {
        if (!clockReentered) {
          clockReentered = true;
          clockInner = clockLeaf.ensure(clockFixture.context, mainSignal(), Date.now() + 60_000);
        }
        return Date.now();
      },
    });
    clockLeaf = clockFixture.newLeaf();
    const clockOuter = confirmed(await ensure(clockLeaf, clockFixture));
    expect(clockOuter.created).toBe(true);
    expect((await clockInner!).state).toBe("pending");
    expect(clockFixture.state.ensureCalls).toBe(2);
    expect(clockFixture.state.appendCalls).toBe(1);

    let ownerFixture!: Fixture;
    let ownerLeaf!: NativeHarnessAccountingSession;
    let ownerInner: Promise<NativeHarnessAccountingSessionResult> | null = null;
    let ownerReentered = false;
    ownerFixture = makeFixture({
      isOwnerCurrent: () => {
        if (!ownerReentered) {
          ownerReentered = true;
          ownerInner = ownerLeaf.ensure(ownerFixture.context, mainSignal(), Date.now() + 60_000);
        }
        return true;
      },
    });
    ownerLeaf = ownerFixture.newLeaf();
    expect((await ensure(ownerLeaf, ownerFixture)).state).toBe("confirmed");
    expect((await ownerInner!).state).toBe("pending");
    expect(ownerFixture.state.ensureCalls).toBe(2);
    expect(ownerFixture.state.appendCalls).toBe(1);
  });

  test("owner callback abort and clock disposal before create have zero following effects", async () => {
    const controller = new AbortController();
    let aborted = false;
    const abortFixture = makeFixture({
      isOwnerCurrent: (_context, state) => {
        if (state.ensureCalls >= 1 && !aborted) {
          aborted = true;
          controller.abort();
        }
        return true;
      },
    });
    const abortResult = await ensure(abortFixture.newLeaf(), abortFixture, { signal: controller.signal });
    expect(abortResult.state).toBe("invalidated");
    expect(abortFixture.state.ensureCalls).toBe(1);
    expect(abortFixture.state.appendCalls).toBe(0);
    expect(existsSync(abortFixture.namespace)).toBe(false);

    let disposalFixture!: Fixture;
    let disposalLeaf!: NativeHarnessAccountingSession;
    let disposedOnce = false;
    disposalFixture = makeFixture({
      now: () => {
        if (disposalFixture.state.ensureCalls >= 1 && !disposedOnce) {
          disposedOnce = true;
          disposalLeaf.dispose();
        }
        return Date.now();
      },
    });
    disposalLeaf = disposalFixture.newLeaf();
    const disposalResult = await ensure(disposalLeaf, disposalFixture);
    expect(disposalResult.state).toBe("invalidated");
    expect(disposalFixture.state.ensureCalls).toBe(1);
    expect(disposalFixture.state.appendCalls).toBe(0);
    expect(existsSync(disposalFixture.namespace)).toBe(false);
  });

  test("the exact final pre-create clock read disposes, aborts or swaps the manager before owner creation", async () => {
    let baseline!: Fixture;
    const ordinals: { ordinal: number; namespacePresent: boolean }[] = [];
    baseline = makeFixture({
      missingFile: true,
      now: () => {
        ordinals.push({
          ordinal: ordinals.length + 1,
          namespacePresent: existsSync(baseline.namespace),
        });
        return Date.now();
      },
    });
    const baselineResult = confirmed(await ensure(baseline.newLeaf(), baseline));
    expect(baselineResult.created).toBe(true);
    expect(baseline.ownerId()).toBe(baselineResult.identity.ownerId);
    expect(existsSync(baseline.namespace)).toBe(true);
    const absent = ordinals.filter((call) => !call.namespacePresent);
    expect(absent.length).toBeGreaterThan(1);
    const createdAtOrdinal = absent[absent.length - 1]!.ordinal;
    expect(ordinals.some((call) => call.ordinal > createdAtOrdinal && call.namespacePresent)).toBe(true);

    let disposalFixture!: Fixture;
    let disposalLeaf!: NativeHarnessAccountingSession;
    let disposalOrdinal = 0;
    let disposalTriggered = false;
    disposalFixture = makeFixture({
      missingFile: true,
      now: () => {
        disposalOrdinal += 1;
        if (disposalOrdinal === createdAtOrdinal) {
          disposalTriggered = true;
          disposalLeaf.dispose();
        }
        return Date.now();
      },
    });
    disposalLeaf = disposalFixture.newLeaf();
    const disposalResult = await ensure(disposalLeaf, disposalFixture);
    expect(disposalTriggered).toBe(true);
    expect(disposalOrdinal).toBe(createdAtOrdinal);
    expect(disposalResult.state).toBe("invalidated");
    expect(disposalFixture.state.ensureCalls).toBe(1);
    expect(disposalFixture.state.appendCalls).toBe(0);
    expect(existsSync(disposalFixture.namespace)).toBe(false);

    const controller = new AbortController();
    let abortFixture!: Fixture;
    let abortOrdinal = 0;
    let abortTriggered = false;
    abortFixture = makeFixture({
      missingFile: true,
      now: () => {
        abortOrdinal += 1;
        if (abortOrdinal === createdAtOrdinal) {
          abortTriggered = true;
          controller.abort();
        }
        return Date.now();
      },
    });
    const abortResult = await ensure(abortFixture.newLeaf(), abortFixture, { signal: controller.signal });
    expect(abortTriggered).toBe(true);
    expect(abortOrdinal).toBe(createdAtOrdinal);
    expect(abortResult.state).toBe("invalidated");
    expect(abortFixture.state.ensureCalls).toBe(1);
    expect(abortFixture.state.appendCalls).toBe(0);
    expect(existsSync(abortFixture.namespace)).toBe(false);

    let swapFixture!: Fixture;
    let swapOrdinal = 0;
    let swapTriggered = false;
    swapFixture = makeFixture({
      missingFile: true,
      now: () => {
        swapOrdinal += 1;
        if (swapOrdinal === createdAtOrdinal) {
          swapTriggered = true;
          swapFixture.context.sessionManager = replacementManager(swapFixture);
        }
        return Date.now();
      },
    });
    const swapResult = await ensure(swapFixture.newLeaf(), swapFixture);
    expect(swapTriggered).toBe(true);
    expect(swapOrdinal).toBe(createdAtOrdinal);
    expect(swapResult.state).toBe("invalidated");
    expect(swapFixture.state.ensureCalls).toBe(1);
    expect(swapFixture.state.appendCalls).toBe(0);
    expect(existsSync(swapFixture.namespace)).toBe(false);
  });

  test("the exact ensureOnDisk capability getter disposes, aborts or swaps the manager before the method call", async () => {
    let disposalFixture!: Fixture;
    let disposalLeaf!: NativeHarnessAccountingSession;
    let disposalTriggered = false;
    disposalFixture = makeFixture();
    const disposalOriginal = disposalFixture.manager.ensureOnDisk;
    disposalLeaf = disposalFixture.newLeaf();
    Object.defineProperty(disposalFixture.manager, "ensureOnDisk", {
      configurable: true,
      enumerable: true,
      get() {
        disposalTriggered = true;
        disposalLeaf.dispose();
        return disposalOriginal;
      },
    });
    const disposalResult = await ensure(disposalLeaf, disposalFixture);
    expect(disposalTriggered).toBe(true);
    expect(disposalResult.state).toBe("invalidated");
    expect(disposalFixture.state.ensureCalls).toBe(0);
    expect(disposalFixture.state.appendCalls).toBe(0);
    expect(existsSync(disposalFixture.namespace)).toBe(false);

    const controller = new AbortController();
    let abortFixture!: Fixture;
    let abortLeaf!: NativeHarnessAccountingSession;
    let abortTriggered = false;
    abortFixture = makeFixture();
    const abortOriginal = abortFixture.manager.ensureOnDisk;
    abortLeaf = abortFixture.newLeaf();
    Object.defineProperty(abortFixture.manager, "ensureOnDisk", {
      configurable: true,
      enumerable: true,
      get() {
        abortTriggered = true;
        controller.abort();
        return abortOriginal;
      },
    });
    const abortResult = await ensure(abortLeaf, abortFixture, { signal: controller.signal });
    expect(abortTriggered).toBe(true);
    expect(abortResult.state).toBe("invalidated");
    expect(abortFixture.state.ensureCalls).toBe(0);
    expect(abortFixture.state.appendCalls).toBe(0);
    expect(existsSync(abortFixture.namespace)).toBe(false);

    const swapFixture = makeFixture();
    const swapOriginal = swapFixture.manager.ensureOnDisk;
    const swapLeaf = swapFixture.newLeaf();
    const oldManager = swapFixture.manager;
    Object.defineProperty(swapFixture.manager, "ensureOnDisk", {
      configurable: true,
      enumerable: true,
      get() {
        swapFixture.context.sessionManager = replacementManager(swapFixture);
        return swapOriginal;
      },
    });
    const swapResult = await ensure(swapLeaf, swapFixture);
    expect(swapFixture.context.sessionManager).not.toBe(oldManager);
    expect(swapResult.state).toBe("invalidated");
    expect(swapFixture.state.ensureCalls).toBe(0);
    expect(swapFixture.state.appendCalls).toBe(0);
    expect(existsSync(swapFixture.namespace)).toBe(false);
  });

  test("exact manager replacement during held ensure refuses before append or confirmation", async () => {
    const beforeAppend = makeFixture({ ensurePlan: (call) => (call === 1 ? "defer" : "write") });
    const beforeLeaf = beforeAppend.newLeaf();
    const beforePending = ensure(beforeLeaf, beforeAppend);
    expect(beforeAppend.state.ensureCalls).toBe(1);
    beforeAppend.context.sessionManager = replacementManager(beforeAppend);
    beforeAppend.state.releaseEnsure?.();
    const beforeResult = await beforePending;
    expect(beforeResult.state).toBe("invalidated");
    expect(beforeAppend.state.appendCalls).toBe(0);
    expect(existsSync(beforeAppend.namespace)).toBe(false);

    const afterAppend = makeFixture({
      ensurePlan: (call) => {
        if (call === 1) return "write";
        if (call === 2) return "defer";
        return "write";
      },
    });
    const afterLeaf = afterAppend.newLeaf();
    const afterPending = ensure(afterLeaf, afterAppend);
    await waitFor(() => afterAppend.state.appendCalls === 1 && afterAppend.state.ensureCalls === 2);
    const entryId = afterAppend.state.entries[afterAppend.state.entries.length - 1]!.id;
    afterAppend.context.sessionManager = replacementManager(afterAppend);
    afterAppend.state.releaseEnsure?.();
    const afterResult = await afterPending;
    expect(afterResult.state).toBe("invalidated");
    expect(afterAppend.state.appendCalls).toBe(1);

    const fresh = confirmed(await ensure(afterAppend.newLeaf(), afterAppend));
    expect(fresh.locatorEntryIds).toContain(entryId);
    expect(afterAppend.state.appendCalls).toBe(1);
  });

  test("manager replacement at the last pre-append owner callback refuses before the original append", async () => {
    let zeroAppendChecks = 0;
    const calibration = makeFixture({
      isOwnerCurrent: (_context, state) => {
        if (state.appendCalls === 0) zeroAppendChecks += 1;
        return true;
      },
    });
    confirmed(await ensure(calibration.newLeaf(), calibration));
    expect(zeroAppendChecks).toBeGreaterThan(1);

    let checks = 0;
    let triggered = false;
    let fixture!: Fixture;
    fixture = makeFixture({
      isOwnerCurrent: (_context, state) => {
        if (state.appendCalls === 0) {
          checks += 1;
          if (checks === zeroAppendChecks) {
            triggered = true;
            fixture.context.sessionManager = replacementManager(fixture);
          }
        }
        return true;
      },
    });
    const result = await ensure(fixture.newLeaf(), fixture);
    expect(triggered).toBe(true);
    expect(checks).toBe(zeroAppendChecks);
    expect(result.state).toBe("invalidated");
    expect(fixture.state.appendCalls).toBe(0);
  });

  test("the last owner callback can replace the manager without confirming", async () => {
    let ownerChecks = 0;
    const calibration = makeFixture({
      isOwnerCurrent: () => {
        ownerChecks += 1;
        return true;
      },
    });
    expect(confirmed(await ensure(calibration.newLeaf(), calibration)).created).toBe(true);
    expect(ownerChecks).toBeGreaterThan(2);

    let checks = 0;
    let triggered = false;
    let fixture!: Fixture;
    fixture = makeFixture({
      isOwnerCurrent: () => {
        checks += 1;
        if (checks === ownerChecks) {
          triggered = true;
          fixture.context.sessionManager = replacementManager(fixture);
        }
        return true;
      },
    });
    const result = await ensure(fixture.newLeaf(), fixture);
    expect(triggered).toBe(true);
    expect(checks).toBe(ownerChecks);
    expect(result.state).toBe("invalidated");
    expect(fixture.state.appendCalls).toBe(1);
    const entryId = fixture.state.entries[fixture.state.entries.length - 1]!.id;
    expect(fixture.ownerId()).not.toBeNull();

    const replacement = fixture.context.sessionManager;
    const fresh = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(fixture.context.sessionManager).toBe(replacement);
    expect(fresh.locatorEntryIds).toContain(entryId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("a queued abort after the inner final callback blocks confirmed delivery", async () => {
    let calibrationChecks = 0;
    const calibration = makeFixture({
      isOwnerCurrent: () => {
        calibrationChecks += 1;
        return true;
      },
    });
    confirmed(await ensure(calibration.newLeaf(), calibration));
    expect(calibrationChecks).toBeGreaterThan(3);
    const target = calibrationChecks;

    const controller = new AbortController();
    let checks = 0;
    const fixture = makeFixture({
      isOwnerCurrent: () => {
        checks += 1;
        if (checks === target - 1) {
          queueMicrotask(() => controller.abort());
        }
        return true;
      },
    });
    const leaf = fixture.newLeaf();
    const result = await ensure(leaf, fixture, { signal: controller.signal });
    expect(result.state).toBe("invalidated");
    expect(checks).toBe(target);
    expect(fixture.state.appendCalls).toBe(1);
    const entryId = fixture.state.entries[fixture.state.entries.length - 1]!.id;
    const fresh = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(fresh.locatorEntryIds).toContain(entryId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("an existing owner without a locator reuses its UUID and completes the first association", async () => {
    const fixture = makeFixture();
    await createOwner(fixture);
    const result = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(result.created).toBe(false);
    expect(result.identity.ownerId).toBe(OWNER);
    expect(fixture.ownerId()).toBe(OWNER);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("an existing locator with a missing owner refuses without creation", async () => {
    const fixture = makeFixture();
    const first = confirmed(await ensure(fixture.newLeaf(), fixture));
    rmSync(fixture.ownerDir, { recursive: true, force: true });
    const result = await ensure(fixture.newLeaf(), fixture);
    expect(result.state).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(1);
    expect(existsSync(fixture.ownerFile)).toBe(false);
    expect(fixture.ownerId()).toBeNull();
    expect(first.locatorEntryIds).toHaveLength(1);
  });

  test("same-session branch navigation reuses an off-branch locator", async () => {
    const fixture = makeFixture();
    const leaf = fixture.newLeaf();
    const first = confirmed(await ensure(leaf, fixture));
    fixture.state.leafId = "base-1";
    const second = confirmed(await ensure(leaf, fixture));
    expect(second.identity.ownerId).toBe(first.identity.ownerId);
    expect(second.locatorEntryIds).toEqual(first.locatorEntryIds);
    expect(fixture.state.appendCalls).toBe(1);
    const fresh = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(fresh.identity.ownerId).toBe(first.identity.ownerId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("empty, .bak-only and corrupt owner directories refuse without creation", async () => {
    const empty = makeFixture();
    mkdirSync(empty.ownerDir, { recursive: true });
    const emptyResult = await ensure(empty.newLeaf(), empty);
    expect(emptyResult.state).toBe("unavailable");
    expect(empty.state.appendCalls).toBe(0);
    expect(readdirSync(empty.ownerDir)).toEqual([]);

    const backup = makeFixture();
    await createOwner(backup);
    renameSync(backup.ownerFile, `${backup.ownerFile}.bak`);
    const backupResult = await ensure(backup.newLeaf(), backup);
    expect(backupResult.state).toBe("unavailable");
    expect(backup.state.appendCalls).toBe(0);
    expect(readdirSync(backup.ownerDir)).toEqual(["owner.json.bak"]);

    const corrupt = makeFixture();
    mkdirSync(corrupt.ownerDir, { recursive: true });
    writeFileSync(corrupt.ownerFile, "{\"not\":\"an owner\"}\n", "utf8");
    const corruptResult = await ensure(corrupt.newLeaf(), corrupt);
    expect(corruptResult.state).toBe("unavailable");
    expect(corrupt.state.appendCalls).toBe(0);
    expect(readFileSync(corrupt.ownerFile, "utf8")).toBe("{\"not\":\"an owner\"}\n");
  });

  test("a permission error on an existing owner refuses without creation or replacement", async () => {
    const fixture = makeFixture();
    await createOwner(fixture);
    chmodSync(fixture.ownerFile, 0o000);
    try {
      const result = await ensure(fixture.newLeaf(), fixture);
      expect(result.state).toBe("unavailable");
      expect(fixture.state.appendCalls).toBe(0);
      expect(readdirSync(fixture.ownerDir)).toEqual(["owner.json"]);
    } finally {
      chmodSync(fixture.ownerFile, 0o600);
    }
  });

  test("memory-only locator refuses until its exact disk entry is observed", async () => {
    const fixture = makeFixture({
      ensurePlan: (call) => {
        if (call === 1) return "write";
        if (call === 2) return "defer";
        if (call === 3) return "noop";
        return "write";
      },
    });
    const oldLeaf = fixture.newLeaf();
    const oldPending = await ensure(oldLeaf, fixture, { deadlineAt: Date.now() + 40 });
    expect(oldPending.state).toBe("pending");
    expect(fixture.state.appendCalls).toBe(1);
    const entryId = fixture.state.entries[fixture.state.entries.length - 1]!.id;
    const ownerId = fixture.ownerId();
    expect(ownerId).not.toBeNull();
    fixture.state.leafId = "base-1";
    oldLeaf.dispose();

    const newLeaf = fixture.newLeaf();
    const blocked = await ensure(newLeaf, fixture);
    expect(blocked.state).toBe("pending");
    expect(fixture.state.appendCalls).toBe(1);

    fixture.state.releaseEnsure?.();
    await sleep(20);
    const confirmedResult = confirmed(await ensure(newLeaf, fixture));
    expect(confirmedResult.identity.ownerId).toBe(ownerId!);
    expect(confirmedResult.locatorEntryIds).toContain(entryId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("append throw after insertion is confirmed on retry without a second append", async () => {
    const fixture = makeFixture({ appendMode: "throw-after" });
    const leaf = fixture.newLeaf();
    const first = await ensure(leaf, fixture);
    expect(first.state).toBe("pending");
    expect(fixture.state.appendCalls).toBe(1);
    const entryId = fixture.state.entries[fixture.state.entries.length - 1]!.id;
    const retry = confirmed(await ensure(leaf, fixture));
    expect(retry.locatorEntryIds).toContain(entryId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("append throw before insertion and append no-op remain unconfirmed in the same instance", async () => {
    for (const mode of ["throw-before", "noop"] as const) {
      const fixture = makeFixture({ appendMode: mode });
      const leaf = fixture.newLeaf();
      const first = await ensure(leaf, fixture);
      expect(first.state).toBe("pending");
      expect(fixture.state.appendCalls).toBe(1);
      const retry = await ensure(leaf, fixture);
      expect(retry.state).toBe("pending");
      expect(fixture.state.appendCalls).toBe(1);
    }
  });

  test("ensure rejection and no-op never confirm or duplicate an append", async () => {
    const rejected = makeFixture({
      ensurePlan: (call) => {
        if (call === 1) return "write";
        if (call === 2) return "reject";
        return "write";
      },
    });
    const rejectedLeaf = rejected.newLeaf();
    const rejectedFirst = await ensure(rejectedLeaf, rejected);
    expect(rejectedFirst.state).toBe("unavailable");
    expect(rejected.state.appendCalls).toBe(1);
    const rejectedRetry = confirmed(await ensure(rejectedLeaf, rejected));
    expect(rejectedRetry.locatorEntryIds).toHaveLength(1);
    expect(rejected.state.appendCalls).toBe(1);

    const noop = makeFixture({
      ensurePlan: (call) => {
        if (call === 1) return "write";
        if (call === 2) return "noop";
        return "write";
      },
    });
    const noopLeaf = noop.newLeaf();
    const noopFirst = await ensure(noopLeaf, noop);
    expect(noopFirst.state).toBe("pending");
    expect(noop.state.appendCalls).toBe(1);
    const noopRetry = confirmed(await ensure(noopLeaf, noop));
    expect(noopRetry.locatorEntryIds).toHaveLength(1);
    expect(noop.state.appendCalls).toBe(1);
  });

  test("owner-current callback disposal after append cannot confirm locally", async () => {
    let leaf: NativeHarnessAccountingSession;
    const fixture = makeFixture({
      isOwnerCurrent: (_context, state) => {
        if (state.appendCalls > 0) leaf.dispose();
        return true;
      },
    });
    leaf = fixture.newLeaf();
    const result = await ensure(leaf, fixture);
    expect(result.state).toBe("invalidated");
    expect(fixture.state.appendCalls).toBe(1);
    const entryId = fixture.state.entries[fixture.state.entries.length - 1]!.id;
    const fresh = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(fresh.locatorEntryIds).toContain(entryId);
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("getEntries missing, throwing, oversized and duplicate ids refuse", async () => {
    const missing = makeFixture();
    delete missing.manager.getEntries;
    expect((await ensure(missing.newLeaf(), missing)).state).toBe("unavailable");
    expect(missing.state.appendCalls).toBe(0);

    const throwing = makeFixture();
    throwing.manager.getEntries = () => {
      throw new Error("fixture getEntries throw");
    };
    expect((await ensure(throwing.newLeaf(), throwing)).state).toBe("unavailable");
    expect(throwing.state.appendCalls).toBe(0);

    const oversized = makeFixture({ ensurePlan: () => "noop" });
    writeFileSync(
      oversized.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: oversized.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: oversized.cwd,
      })}\n`,
      "utf8",
    );
    for (let index = 0; index < 8192; index += 1) {
      oversized.state.entries.push({
        id: `extra-${index}`,
        parentId: null,
        type: "message",
      });
    }
    expect(oversized.state.entries.length).toBe(8193);
    expect((await ensure(oversized.newLeaf(), oversized)).state).toBe("unavailable");
    expect(oversized.state.appendCalls).toBe(0);

    const duplicate = makeFixture({ ensurePlan: () => "noop" });
    writeFileSync(
      duplicate.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: duplicate.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: duplicate.cwd,
      })}\n`,
      "utf8",
    );
    duplicate.state.entries.push(
      { id: "duplicate", parentId: null, type: "message" },
      { id: "duplicate", parentId: null, type: "message" },
    );
    expect((await ensure(duplicate.newLeaf(), duplicate)).state).toBe("unavailable");
    expect(duplicate.state.appendCalls).toBe(0);

    const getter = makeFixture({ ensurePlan: () => "noop" });
    writeFileSync(
      getter.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: getter.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: getter.cwd,
      })}\n`,
      "utf8",
    );
    const hostile: Record<string, unknown> = { id: "hostile-1", parentId: null };
    Object.defineProperty(hostile, "type", {
      enumerable: true,
      get() {
        throw new Error("fixture type getter");
      },
    });
    getter.state.entries.push(hostile as unknown as TestEntry);
    expect((await ensure(getter.newLeaf(), getter)).state).toBe("unavailable");
    expect(getter.state.appendCalls).toBe(0);
  });

  test("equal duplicate locators deduplicate and conflicting or malformed locators refuse", async () => {
    const fixture = makeFixture();
    const first = confirmed(await ensure(fixture.newLeaf(), fixture));
    fixture.state.entries.push({
      id: "duplicate-locator",
      parentId: "base-1",
      type: "custom",
      customType: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE,
      data: { ...first.locator },
    });
    fixture.write();
    const deduped = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(deduped.identity.ownerId).toBe(first.identity.ownerId);
    expect(deduped.locatorEntryIds).toHaveLength(2);
    expect(fixture.state.appendCalls).toBe(1);

    fixture.state.entries.push({
      id: "conflicting-locator",
      parentId: "base-1",
      type: "custom",
      customType: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE,
      data: locatorData(OTHER_OWNER, fixture.selector),
    });
    fixture.write();
    expect((await ensure(fixture.newLeaf(), fixture)).state).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(1);

    fixture.state.entries.pop();
    fixture.state.entries.push({
      id: "malformed-locator",
      parentId: "base-1",
      type: "custom",
      customType: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE,
      data: { schema: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA, ownerId: first.identity.ownerId },
    });
    fixture.write();
    expect((await ensure(fixture.newLeaf(), fixture)).state).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(1);
  });

  test("locator codec enforces exact 4096-byte, BOM, field and fixed-path rules", () => {
    const selector = "b".repeat(64);
    const locator = locatorData(OWNER, selector);
    const text = JSON.stringify(locator);
    expect(decodeNativeHarnessAccountingOwnerLocator(text)).toEqual(locator);
    const padded = `${text}${" ".repeat(4096 - Buffer.byteLength(text, "utf8"))}`;
    expect(Buffer.byteLength(padded, "utf8")).toBe(4096);
    expect(decodeNativeHarnessAccountingOwnerLocator(padded)).toEqual(locator);
    expect(decodeNativeHarnessAccountingOwnerLocator(`${padded} `)).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator(`\uFEFF${text}`)).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator(JSON.stringify({ ...locator, extra: 1 }))).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator(JSON.stringify({
      ...locator,
      ownerRelativePath: "accounting-owners/other/owner.json",
    }))).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator(JSON.stringify({
      ...locator,
      ownerId: null,
    }))).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator(JSON.stringify({
      ...locator,
      selectorSha256: 7,
    }))).toBeNull();
    expect(decodeNativeHarnessAccountingOwnerLocator("not-json")).toBeNull();
  });

  test("oversized session journal refuses without append", async () => {
    const fixture = makeFixture({ ensurePlan: () => "noop" });
    writeFileSync(fixture.sessionFile, "x".repeat(300 * 1024), "utf8");
    const result = await ensure(fixture.newLeaf(), fixture);
    expect(result.state).toBe("unavailable");
    expect(fixture.state.appendCalls).toBe(0);
  });

  test("an unrelated message body getter is never read by the locator scan", async () => {
    const fixture = makeFixture({
      ensurePlan: (call) => (call === 1 ? "noop" : "write"),
    });
    let bodyReads = 0;
    const trap: TestEntry = { id: "trap-1", parentId: null, type: "message" };
    Object.defineProperty(trap, "message", {
      enumerable: false,
      get() {
        bodyReads += 1;
        throw new Error("fixture message body read");
      },
    });
    fixture.state.entries.push(trap);
    writeFileSync(
      fixture.sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: fixture.sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: fixture.cwd,
      })}\n${JSON.stringify(fixture.state.entries[0])}\n`,
      "utf8",
    );
    const result = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(result.state).toBe("confirmed");
    expect(bodyReads).toBe(0);
  });

  test("concurrent leaves keep one stored owner and at most one append", async () => {
    const fixture = makeFixture();
    const leaves = Array.from({ length: 6 }, () => fixture.newLeaf());
    const results = await Promise.all(leaves.map((leaf) => ensure(leaf, fixture, {
      deadlineAt: Date.now() + 5_000,
    })));
    expect(readdirSync(fixture.namespace)).toHaveLength(1);
    const stored = fixture.ownerId();
    expect(stored).not.toBeNull();
    for (const result of results) {
      if (result.state === "confirmed") {
        expect(result.identity.ownerId).toBe(stored!);
      }
    }
    expect(fixture.state.appendCalls).toBeLessThanOrEqual(1);
    const final = confirmed(await ensure(fixture.newLeaf(), fixture));
    expect(final.identity.ownerId).toBe(stored!);
    expect(fixture.state.appendCalls).toBe(1);
    expect(readdirSync(fixture.namespace)).toHaveLength(1);
  });
});
