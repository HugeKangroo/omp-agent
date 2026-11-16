import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NATIVE_HARNESS_HISTORY_SESSION_LIMITS as HISTORY_SESSION_LIMITS,
} from "../../src/native-harness-history-session.ts";
import {
  NATIVE_HARNESS_HISTORY_SESSION_LIMITS,
  ObservationFailure,
  isCanonicalAbsolutePath,
  isPlainRecord,
  parseActiveBranch,
  pinDirectory,
  readNativeHarnessSessionJournal,
  readPublicationBase,
  readSessionBase,
  sameBase,
  sameDirectoryPin,
  samePublicationBase,
  type ContextRead,
  type PublicationBase,
  type SessionDiskFile,
  type SessionJournalRead,
} from "../../src/native-harness-session-facts.ts";
import { nodeFileIo, type NativeFileIo, type NativeFileStats } from "../../src/native-work.ts";

const SESSION_ID = "session-a2a2";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PARSE_REASON = "The local session file header or entries do not match the actual session.";
const READ_REASON = "The local session file could not be read within its fixed profile.";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const created = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-facts-a2a2-")));
  roots.push(created);
  return created;
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** Mirrors the fixed host title slot: JSON body padded to 255 bytes. */
function fixedTitleLine(title: string, source?: "auto" | "user"): string {
  const record: Record<string, unknown> = { type: "title", v: 1, title };
  if (source !== undefined) record.source = source;
  record.updatedAt = TIMESTAMP;
  record.pad = "";
  const unpadded = Buffer.byteLength(JSON.stringify(record), "utf8");
  record.pad = " ".repeat(Math.max(0, 255 - unpadded));
  return JSON.stringify(record);
}

interface Journal {
  readonly root: string;
  readonly dir: string;
  readonly file: string;
  readonly cwd: string;
  readonly base: PublicationBase;
  header(overrides?: Record<string, unknown>): string;
  write(text: string): void;
  writeLines(lines: readonly string[]): void;
}

function journal(): Journal {
  const root = tempRoot();
  const dir = path.join(root, "sessions");
  const cwd = path.join(root, "workspace");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01_${SESSION_ID}.jsonl`);
  const base: PublicationBase = {
    manager: {},
    sessionId: SESSION_ID,
    cwd,
    recordedCwd: cwd,
    leafId: null,
    branch: [],
    sessionDir: dir,
    file,
  };
  return {
    root,
    dir,
    file,
    cwd,
    base,
    header(overrides = {}) {
      return jsonLine({
        type: "session",
        version: 3,
        id: SESSION_ID,
        timestamp: TIMESTAMP,
        cwd,
        ...overrides,
      });
    },
    write(text) {
      writeFileSync(file, text, "utf8");
    },
    writeLines(lines) {
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    },
  };
}

function entryLine(
  id: string,
  parentId: string | null,
  type: string,
  extra: Record<string, unknown> = {},
): string {
  return jsonLine({ id, parentId, type, ...extra });
}

async function readJournal(
  target: Journal,
  io: NativeFileIo = nodeFileIo,
  guard: () => boolean = () => true,
): Promise<SessionJournalRead> {
  return readNativeHarnessSessionJournal(target.base, io, guard, 1_000);
}

function expectRead(result: SessionJournalRead): SessionDiskFile {
  if (!result.ok) {
    throw new Error(`expected a parsed journal, received ${result.reason.code}: ${result.reason.detail}`);
  }
  return result.value;
}

function expectJournalFailure(result: SessionJournalRead, detail: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason.code).toBe("disk-unavailable");
  expect(result.reason.detail).toBe(detail);
}

function expectContextFailure(
  read: ContextRead<unknown>,
  code: string,
  reasonCode: string,
  detail: string,
): void {
  expect(read.ok).toBe(false);
  if (read.ok) return;
  expect(read.code).toBe(code);
  expect(read.reason.code).toBe(reasonCode);
  expect(read.reason.detail).toBe(detail);
}

function thrown(run: () => unknown): ObservationFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof ObservationFailure) return error;
    throw error;
  }
  throw new Error("Expected an ObservationFailure.");
}

interface ContextState {
  sessionId: string;
  cwd: string;
  recordedCwd: string;
  sessionDir: string;
  file: string;
  leafId: string | null;
  branch: unknown[];
  calls: string[];
  foreignReceiver: boolean;
}

interface HostContext {
  readonly manager: Record<string, unknown>;
  readonly state: ContextState;
  inherited(): Record<string, unknown>;
  plain(): Record<string, unknown>;
}

/**
 * Actual-shaped structural host: agent/cwd/sessionManager live on the
 * prototype chain and every manager method observes its receiver.
 */
function hostContext(): HostContext {
  const root = tempRoot();
  const workspace = path.join(root, "workspace");
  const sessionDir = path.join(root, "sessions");
  const state: ContextState = {
    sessionId: SESSION_ID,
    cwd: workspace,
    recordedCwd: workspace,
    sessionDir,
    file: path.join(sessionDir, `2026-01-01_${SESSION_ID}.jsonl`),
    leafId: "entry-b",
    branch: [
      { id: "entry-a", parentId: null, type: "custom" },
      { id: "entry-b", parentId: "entry-a", type: "message" },
    ],
    calls: [],
    foreignReceiver: false,
  };
  const manager: Record<string, unknown> = {};
  const bind = (name: string, read: () => unknown): void => {
    manager[name] = function (this: unknown) {
      state.calls.push(name);
      if (this !== manager) state.foreignReceiver = true;
      return read();
    };
  };
  bind("getSessionId", () => state.sessionId);
  bind("getCwd", () => state.cwd);
  bind("getRecordedCwd", () => state.recordedCwd);
  bind("getLeafId", () => state.leafId);
  bind("getBranch", () => state.branch.slice());
  bind("getSessionDir", () => state.sessionDir);
  bind("getSessionFile", () => state.file);
  return {
    manager,
    state,
    inherited() {
      const context: Record<string, unknown> = Object.create({
        agent: { kind: "main" },
        cwd: state.cwd,
        sessionManager: manager,
      });
      context.ui = { setWidget: () => undefined };
      return context;
    },
    plain() {
      return { agent: { kind: "main" }, cwd: state.cwd, sessionManager: manager };
    },
  };
}

function newStats(info: NativeFileStats, patch: Partial<NativeFileStats>): NativeFileStats {
  return {
    ...info,
    ...patch,
    isFile: () => info.isFile(),
    isDirectory: () => info.isDirectory(),
    isSymbolicLink: () => info.isSymbolicLink(),
  };
}

interface IoProbe {
  readonly io: NativeFileIo;
  readonly counts: { realpath: number; lstat: number; open: number; close: number; dirLstat: number };
  readonly flags: number[];
}

/** Forwards to the real NativeFileIo and counts, without replacing the reader. */
function ioProbe(options: { dir?: string; alterDirAtLstat?: number } = {}): IoProbe {
  const counts = { realpath: 0, lstat: 0, open: 0, close: 0, dirLstat: 0 };
  const flags: number[] = [];
  const dir = options.dir ?? null;
  const io: NativeFileIo = {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    realpath: async (target) => {
      counts.realpath += 1;
      return nodeFileIo.realpath(target);
    },
    lstat: async (target, statOptions) => {
      counts.lstat += 1;
      const info = await nodeFileIo.lstat(target, statOptions);
      if (dir !== null && target === dir) {
        counts.dirLstat += 1;
        if (counts.dirLstat === options.alterDirAtLstat) {
          return newStats(info, { ino: info.ino + 1n });
        }
      }
      return info;
    },
    open: async (target, openFlags) => {
      counts.open += 1;
      flags.push(openFlags);
      const handle = await nodeFileIo.open(target, openFlags);
      return {
        stat: (statOptions) => handle.stat(statOptions),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: async () => {
          counts.close += 1;
          await handle.close();
        },
      };
    },
  };
  return { io, counts, flags };
}

describe("native harness session facts", () => {
  test("history re-exports the same frozen caps object", () => {
    expect(HISTORY_SESSION_LIMITS).toBe(NATIVE_HARNESS_HISTORY_SESSION_LIMITS);
    expect(Object.isFrozen(NATIVE_HARNESS_HISTORY_SESSION_LIMITS)).toBe(true);
    expect(NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileBytes).toBe(256 * 1024);
    expect(NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileLines).toBe(8192);
    expect(NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries).toBe(4096);
  });

  test("plain-record and canonical-path predicates keep their boundaries", () => {
    expect(isPlainRecord({ id: "x" })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord(Object.create({ id: "x" }))).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord(new (class Fixture {})())).toBe(false);
    expect(isPlainRecord(null)).toBe(false);

    expect(isCanonicalAbsolutePath("/tmp/omp-facts-a2a2")).toBe(true);
    expect(isCanonicalAbsolutePath("/tmp//omp-facts-a2a2")).toBe(false);
    expect(isCanonicalAbsolutePath("/tmp/./omp-facts-a2a2")).toBe(false);
    expect(isCanonicalAbsolutePath("relative/path")).toBe(false);
    expect(isCanonicalAbsolutePath("/")).toBe(false);
    expect(isCanonicalAbsolutePath("/tmp/bad\n")).toBe(false);
    expect(isCanonicalAbsolutePath(`/tmp/${"x".repeat(4096)}`)).toBe(false);
  });

  test("inherited actual host context yields the exact base and receiver", () => {
    const host = hostContext();
    const read = readSessionBase(host.inherited());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.manager).toBe(host.manager);
    expect(read.value.sessionId).toBe(SESSION_ID);
    expect(read.value.cwd).toBe(host.state.cwd);
    expect(read.value.recordedCwd).toBe(host.state.recordedCwd);
    expect(read.value.leafId).toBe("entry-b");
    expect(read.value.branch).toEqual(host.state.branch);
    expect(read.value.branch).not.toBe(host.state.branch);
    expect(host.state.foreignReceiver).toBe(false);
    // No ensure, append, locator or capability beyond these five reads.
    expect(host.state.calls).toEqual([
      "getSessionId",
      "getCwd",
      "getRecordedCwd",
      "getLeafId",
      "getBranch",
    ]);

    const beforePublication = host.state.calls.length;
    const publication = readPublicationBase(host.plain());
    expect(publication.ok).toBe(true);
    if (!publication.ok) return;
    expect(publication.value.sessionDir).toBe(host.state.sessionDir);
    expect(publication.value.file).toBe(host.state.file);
    expect(host.state.calls.slice(beforePublication)).toEqual([
      "getSessionId",
      "getCwd",
      "getRecordedCwd",
      "getLeafId",
      "getBranch",
      "getSessionDir",
      "getSessionFile",
    ]);

    expect(sameBase(read.value, publication.value)).toBe(true);
    expect(samePublicationBase(publication.value, publication.value)).toBe(true);
    host.state.sessionId = "session-other";
    const changed = readSessionBase(host.plain());
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(sameBase(read.value, changed.value)).toBe(false);
    expect(samePublicationBase(publication.value, { ...publication.value, file: "/tmp/other.jsonl" })).toBe(false);
  });

  test("missing, throwing, mismatched and non-main host facts stay bounded", () => {
    expectContextFailure(
      readSessionBase(null),
      "shape",
      "session-unavailable",
      "The actual main context is unavailable.",
    );
    expectContextFailure(
      readSessionBase({}),
      "shape",
      "session-unavailable",
      "The actual main agent kind is unavailable",
    );

    expectContextFailure(
      readSessionBase(Object.create({ agent: { kind: "subagent" } })),
      "not-main",
      "not-main",
      "Only the actual main session may publish or query native history.",
    );

    const mismatched = hostContext();
    const mismatchContext = mismatched.inherited();
    mismatched.state.cwd = "/tmp/omp-facts-elsewhere";
    expectContextFailure(
      readSessionBase(mismatchContext),
      "session",
      "session-unavailable",
      "The context and live session workspaces differ.",
    );

    const nonCanonical = hostContext();
    nonCanonical.state.cwd = `${nonCanonical.state.cwd}/./nested`;
    expectContextFailure(
      readSessionBase(nonCanonical.inherited()),
      "cwd",
      "session-unavailable",
      "The actual context workspace is not canonical.",
    );

    const missingCall = hostContext();
    delete missingCall.manager.getLeafId;
    expectContextFailure(
      readSessionBase(missingCall.inherited()),
      "manager",
      "session-unavailable",
      "The session manager lacks a required structural capability.",
    );

    const throwing = hostContext();
    throwing.manager.getBranch = () => {
      throw new Error("fixture capability failure");
    };
    expectContextFailure(
      readSessionBase(throwing.inherited()),
      "manager",
      "session-unavailable",
      "The session manager capability was unavailable.",
    );

    const overBranch = hostContext();
    overBranch.state.branch = Array.from({ length: 4097 }, () => ({}));
    expectContextFailure(
      readSessionBase(overBranch.inherited()),
      "branch",
      "session-unavailable",
      "The actual session branch exceeds its fixed traversal bound.",
    );

    const badLeaf = hostContext();
    badLeaf.state.leafId = "bad\nleaf";
    expectContextFailure(
      readSessionBase(badLeaf.inherited()),
      "session",
      "session-unavailable",
      "The selected session leaf is unavailable.",
    );

    const badFile = hostContext();
    badFile.state.file = path.join(badFile.state.sessionDir, "nested", "session.jsonl");
    expectContextFailure(
      readPublicationBase(badFile.inherited()),
      "session",
      "session-file-unavailable",
      "The session file is not directly below its session directory.",
    );

    const relativeDir = hostContext();
    relativeDir.state.sessionDir = "sessions";
    expectContextFailure(
      readPublicationBase(relativeDir.inherited()),
      "session",
      "session-file-unavailable",
      "The actual session directory is not canonical.",
    );
  });

  test("active branch parse keeps the contiguous-chain contract", () => {
    const entries = parseActiveBranch([
      { id: "entry-a", parentId: null, type: "custom" },
      { id: "entry-b", parentId: "entry-a", type: "message" },
    ], "entry-b");
    expect(entries.map((entry) => entry.id)).toEqual(["entry-a", "entry-b"]);
    expect(parseActiveBranch([], null)).toEqual([]);

    expect(thrown(() => parseActiveBranch([], "entry-b")).code).toBe("branch");
    expect(thrown(() => parseActiveBranch([], "entry-b")).detail)
      .toBe("The selected leaf is set but the branch is empty.");
    expect(thrown(() => parseActiveBranch([
      { id: "entry-a", parentId: null, type: "custom" },
      { id: "entry-b", parentId: "entry-a", type: "message" },
    ], "entry-a")).detail).toBe("The selected leaf is not the actual branch end.");
    expect(thrown(() => parseActiveBranch([
      { id: "entry-a", parentId: null, type: "custom" },
      { id: "entry-b", parentId: null, type: "message" },
    ], "entry-b")).detail).toBe("The session branch is not one contiguous ancestor chain.");
    expect(thrown(() => parseActiveBranch([
      { id: "entry-a", parentId: null, type: "custom" },
      { id: "entry-a", parentId: "entry-a", type: "message" },
    ], "entry-a")).detail).toBe("The session branch is malformed.");
    expect(thrown(() => parseActiveBranch(
      Array.from({ length: 4097 }, () => ({})),
      null,
    )).detail).toBe("The session branch exceeds its fixed traversal bound.");
  });

  test("header-only, real title prefixes and exact header facts are accepted", async () => {
    const headerOnly = journal();
    headerOnly.writeLines([headerOnly.header()]);
    const bare = expectRead(await readJournal(headerOnly));
    expect(bare.header.id).toBe(SESSION_ID);
    expect(bare.header.cwd).toBe(headerOnly.cwd);
    expect(bare.entries).toEqual([]);
    expect(bare.byId.size).toBe(0);

    const titles = [
      fixedTitleLine("Fixture session", "auto"),
      fixedTitleLine("会话 ✓ タイトル", "user"),
      jsonLine({ type: "title", v: 1, title: "minimal", updatedAt: "whenever", pad: "x" }),
    ];
    for (const title of titles) {
      const withTitle = journal();
      withTitle.writeLines([
        title,
        withTitle.header(),
        entryLine("entry-a", null, "custom", { customType: "fixture", data: { note: "kept" } }),
        entryLine("entry-b", "entry-a", "message", { message: { role: "assistant" } }),
      ]);
      const parsed = expectRead(await readJournal(withTitle));
      expect(parsed.entries.map((entry) => entry.id)).toEqual(["entry-a", "entry-b"]);
      expect(parsed.entries[0]!.parentId).toBeNull();
      expect(parsed.entries[0]!.value.data).toEqual({ note: "kept" });
      expect(parsed.byId.get("entry-b")?.type).toBe("message");
      expect(parsed.entries.some((entry) => entry.type === "title")).toBe(false);
    }
  });

  test("mismatched, malformed, duplicated and foreign rows keep the pinned refusal", async () => {
    const cases: readonly [string, (target: Journal) => void][] = [
      ["foreign header id", (target) => target.writeLines([target.header({ id: "session-other" })])],
      ["mismatched recorded cwd", (target) => target.writeLines([target.header({ cwd: "/tmp/other" })])],
      ["arbitrary prefix", (target) => target.writeLines([jsonLine({ type: "note", v: 1 }), target.header()])],
      ["title without pad", (target) => target.writeLines([
        jsonLine({ type: "title", v: 1, title: "x", updatedAt: "whenever" }),
        target.header(),
      ])],
      ["title version", (target) => target.writeLines([
        jsonLine({ type: "title", v: 2, title: "x", updatedAt: "whenever", pad: "" }),
        target.header(),
      ])],
      ["title source", (target) => target.writeLines([
        jsonLine({ type: "title", v: 1, title: "x", source: "system", updatedAt: "whenever", pad: "" }),
        target.header(),
      ])],
      ["duplicate title", (target) => target.writeLines([
        fixedTitleLine("first", "auto"),
        target.header(),
        fixedTitleLine("second", "user"),
      ])],
      ["title after header", (target) => target.writeLines([target.header(), fixedTitleLine("late", "auto")])],
      ["title without header", (target) => target.writeLines([
        fixedTitleLine("only", "auto"),
        entryLine("entry-a", null, "custom"),
      ])],
      ["second session header", (target) => target.writeLines([
        target.header(),
        jsonLine({ type: "session", id: SESSION_ID, parentId: null }),
      ])],
      ["duplicate entry ids", (target) => target.writeLines([
        target.header(),
        entryLine("entry-a", null, "custom"),
        entryLine("entry-a", "entry-a", "message"),
      ])],
      ["corrupt row", (target) => target.write(`${target.header()}\nnot json\n`)],
      ["missing parentId", (target) => target.writeLines([
        target.header(),
        jsonLine({ id: "entry-a", type: "custom" }),
      ])],
      ["entry without header", (target) => target.writeLines([entryLine("entry-a", null, "custom")])],
      ["empty first line", (target) => target.write(`\n${target.header()}\n`)],
      ["BOM prefix", (target) => target.write(`\uFEFF${target.header()}\n`)],
    ];
    for (const [label, build] of cases) {
      const target = journal();
      build(target);
      const result = await readJournal(target);
      if (result.ok) throw new Error(`${label} was accepted`);
      expectJournalFailure(result, PARSE_REASON);
    }
  });

  test("journal size and line bounds stay fixed", async () => {
    const oversize = journal();
    oversize.write(`${oversize.header()}\n${"x".repeat(300 * 1024)}`);
    expectJournalFailure(await readJournal(oversize), READ_REASON);

    const overLines = journal();
    overLines.write(`${Array.from({ length: 8193 }, () => "{}").join("\n")}\n`);
    expectJournalFailure(await readJournal(overLines), PARSE_REASON);
  });

  test("pinDirectory and sameDirectoryPin keep the exact identity fields", async () => {
    const host = hostContext();
    mkdirSync(host.state.sessionDir, { recursive: true });
    const pin = await pinDirectory(host.state.sessionDir, nodeFileIo);
    if (pin === null) throw new Error("expected a pinned directory");
    expect(pin.path).toBe(host.state.sessionDir);
    expect(sameDirectoryPin(pin, pin)).toBe(true);
    expect(sameDirectoryPin(pin, { ...pin, mtimeNs: pin.mtimeNs + 1n })).toBe(false);
    expect(sameDirectoryPin(pin, { ...pin, path: `${pin.path}-other` })).toBe(false);
    expect(await pinDirectory(path.join(host.state.sessionDir, "missing"), nodeFileIo)).toBeNull();
  });

  test("one restricted open and close reads the current journal", async () => {
    const target = journal();
    target.writeLines([target.header(), entryLine("entry-a", null, "custom")]);
    const probe = ioProbe();
    const parsed = expectRead(await readJournal(target, probe.io));
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["entry-a"]);
    expect(probe.counts.open).toBe(1);
    expect(probe.counts.close).toBe(1);
    expect(probe.flags).toEqual([
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    ]);
  });

  test("a lost guard before the open starts no file read", async () => {
    const target = journal();
    target.writeLines([target.header()]);
    const probe = ioProbe();
    let calls = 0;
    const result = await readNativeHarnessSessionJournal(
      target.base,
      probe.io,
      () => {
        calls += 1;
        return false;
      },
      1_000,
    );
    expectJournalFailure(result, "The owner, session or branch changed before disk readback.");
    expect(calls).toBe(1);
    expect(probe.counts.open).toBe(0);
    expect(probe.counts.close).toBe(0);
  });

  test("a lost guard after the read closes the handle and refuses the bytes", async () => {
    const target = journal();
    target.writeLines([target.header()]);
    const probe = ioProbe();
    let calls = 0;
    const result = await readNativeHarnessSessionJournal(
      target.base,
      probe.io,
      () => {
        calls += 1;
        return calls === 1;
      },
      1_000,
    );
    expectJournalFailure(result, "The owner, session or branch changed during disk readback.");
    expect(calls).toBe(2);
    expect(probe.counts.open).toBe(1);
    expect(probe.counts.close).toBe(1);
  });

  test("a directory identity change after the read keeps the pinned refusal", async () => {
    const target = journal();
    target.writeLines([target.header()]);
    const probe = ioProbe({ dir: target.dir, alterDirAtLstat: 4 });
    const result = await readJournal(target, probe.io);
    expectJournalFailure(result, "The trusted session directory identity changed during readback.");
    expect(probe.counts.open).toBe(1);
    expect(probe.counts.close).toBe(1);
  });

  test("unreadable and non-text journals fail with the fixed read profile", async () => {
    const missing = journal();
    const missingProbe = ioProbe();
    expectJournalFailure(await readJournal(missing, missingProbe.io), READ_REASON);
    expect(missingProbe.counts.open).toBe(0);

    const nonText = journal();
    nonText.write(`${nonText.header()}\n{"id":"entry-a","parentId":null,"type":"bad\u0000"}\n`);
    const nonTextProbe = ioProbe();
    expectJournalFailure(await readJournal(nonText, nonTextProbe.io), READ_REASON);
    expect(nonTextProbe.counts.open).toBe(1);
    expect(nonTextProbe.counts.close).toBe(1);
  });
});
