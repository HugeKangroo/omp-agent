import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import path from "node:path";
import type { NativeHarnessHistoryReason } from "./native-harness-history.ts";
import {
  captureWorkspaceText,
  type NativeFileIo,
  type NativeFileStats,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";
import { parseBranch, type BranchEntry } from "./task-branch.ts";

/**
 * R2-A2a2 readonly actual-session facts seam.
 *
 * This module owns only structural reads of the actual host session context,
 * the existing bounded local session-journal read/parse, and the directory pin
 * used to keep that read on one concrete directory. It owns no publication
 * latch, ensure promise, attempt table, arm, timer, owner callback or mutable
 * lifecycle state: importing or constructing anything here starts no I/O.
 *
 * A returned branch is a copied array of untrusted entries and a successful
 * journal read is one observed parse, not persistence, ownership or a
 * capability grant. Callers must keep their own late identity rechecks.
 */

export const NATIVE_HARNESS_HISTORY_SESSION_LIMITS = Object.freeze({
  branchEntries: 4096,
  locators: 128,
  locatorBytes: 4096,
  pageRows: 16,
  candidates: 16,
  attempts: 128,
  ensureOnDiskMs: 2000,
  sessionFileBytes: 256 * 1024,
  sessionFileLines: 8192,
  declaredArtifacts: 8,
  resultBytes: 64 * 1024,
  reasonChars: 320,
  resultReasons: 8,
  labelChars: 256,
  pathChars: 4096,
});

/** One lexical predicate shared by the session-fact capability and path reads. */
export const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

export class ObservationFailure extends Error {
  override name = "ObservationFailure";
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
  }
}

export function fail(code: string, detail: string): never {
  throw new ObservationFailure(code, detail);
}

export function reason(code: string, detail: string): NativeHarnessHistoryReason {
  const flat = detail.replace(/\s+/g, " ").trim();
  const bounded = flat.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.reasonChars
    ? flat
    : `${flat.slice(0, NATIVE_HARNESS_HISTORY_SESSION_LIMITS.reasonChars - 3)}...`;
  return Object.freeze({
    code: code.length <= 64 ? code : "reason",
    detail: bounded,
  });
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Trusted host capability context only. The actual host composes its handler
 * context with Object.create(baseCtx), so agent/cwd/sessionManager may live on
 * the inherited chain. This structural read stays confined to that context and
 * its agent; persisted JSON, candidates and selectors keep the strict plain
 * record checks above.
 */
function capabilityRecord(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("shape", detail);
  return value as Record<string, unknown>;
}

function capabilityField(value: unknown, key: string, detail: string): unknown {
  return capabilityRecord(value, detail)[key];
}

function capabilityTextField(value: unknown, key: string, max: number, detail: string): string {
  const raw = capabilityField(value, key, detail);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > max || CONTROL_PATTERN.test(raw)) {
    fail("field", detail);
  }
  return raw;
}

function managerCall(manager: object, name: string): unknown {
  const callable = (manager as Record<string, unknown>)[name];
  if (typeof callable !== "function") {
    fail("manager", "The session manager lacks a required structural capability.");
  }
  try {
    return Reflect.apply(callable, manager, []);
  } catch {
    fail("manager", "The session manager capability was unavailable.");
  }
}

export function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars
    && !value.includes("\0")
    && !CONTROL_PATTERN.test(value)
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value !== path.parse(value).root;
}

function boundedLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= NATIVE_HARNESS_HISTORY_SESSION_LIMITS.labelChars
    && !CONTROL_PATTERN.test(value);
}

export interface SessionBase {
  readonly manager: object;
  readonly sessionId: string;
  readonly cwd: string;
  readonly recordedCwd: string;
  readonly leafId: string | null;
  readonly branch: readonly unknown[];
}

export interface PublicationBase extends SessionBase {
  readonly sessionDir: string;
  readonly file: string;
}

export type ContextRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: NativeHarnessHistoryReason };

export function readSessionBase(context: unknown): ContextRead<SessionBase> {
  try {
    const record = capabilityRecord(context, "The actual main context is unavailable.");
    const agent = capabilityField(record, "agent", "The actual main agent kind is unavailable.");
    if (capabilityField(agent, "kind", "The actual main agent kind is unavailable") !== "main") {
      return {
        ok: false,
        code: "not-main",
        reason: reason("not-main", "Only the actual main session may publish or query native history."),
      };
    }
    const contextCwd = capabilityTextField(
      record,
      "cwd",
      NATIVE_HARNESS_HISTORY_SESSION_LIMITS.pathChars,
      "The actual context workspace is unavailable.",
    );
    if (!isCanonicalAbsolutePath(contextCwd)) fail("cwd", "The actual context workspace is not canonical.");
    const manager = capabilityField(record, "sessionManager", "The actual session manager is unavailable.");
    if (typeof manager !== "object" || manager === null) fail("manager", "The actual session manager is unavailable.");
    const sessionIdRaw = managerCall(manager, "getSessionId");
    if (!boundedLabel(sessionIdRaw)) fail("session", "The actual session id is unavailable.");
    const cwdRaw = managerCall(manager, "getCwd");
    if (!isCanonicalAbsolutePath(cwdRaw)) fail("session", "The live session workspace is not canonical.");
    if (path.resolve(contextCwd) !== cwdRaw) fail("session", "The context and live session workspaces differ.");
    const recordedCwdRaw = managerCall(manager, "getRecordedCwd");
    if (!isCanonicalAbsolutePath(recordedCwdRaw)) fail("session", "The recorded session workspace is not canonical.");
    const leafRaw = managerCall(manager, "getLeafId");
    if (leafRaw !== null && !boundedLabel(leafRaw)) fail("session", "The selected session leaf is unavailable.");
    const branchRaw = managerCall(manager, "getBranch");
    if (!Array.isArray(branchRaw)) fail("branch", "The actual session branch is not an array.");
    if (branchRaw.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
      fail("branch", "The actual session branch exceeds its fixed traversal bound.");
    }
    return {
      ok: true,
      value: {
        manager,
        sessionId: sessionIdRaw,
        cwd: cwdRaw,
        recordedCwd: recordedCwdRaw,
        leafId: leafRaw === null ? null : leafRaw,
        branch: [...branchRaw],
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ObservationFailure ? error.code : "session",
      reason: reason(
        "session-unavailable",
        error instanceof ObservationFailure
          ? error.detail
          : "The actual session identity could not be read.",
      ),
    };
  }
}

export function readPublicationBase(context: unknown): ContextRead<PublicationBase> {
  const base = readSessionBase(context);
  if (!base.ok) return base;
  try {
    const directory = managerCall(base.value.manager, "getSessionDir");
    if (!isCanonicalAbsolutePath(directory)) fail("session", "The actual session directory is not canonical.");
    const file = managerCall(base.value.manager, "getSessionFile");
    if (typeof file !== "string" || !isCanonicalAbsolutePath(file)) {
      fail("session", "The actual local session file is unavailable.");
    }
    if (path.dirname(file) !== directory) fail("session", "The session file is not directly below its session directory.");
    const name = path.basename(file);
    if (
      name.length === 0
      || name.length > 255
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")
      || CONTROL_PATTERN.test(name)
    ) {
      fail("session", "The actual session file name is not a plain child name.");
    }
    return { ok: true, value: { ...base.value, sessionDir: directory, file } };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ObservationFailure ? error.code : "session",
      reason: reason(
        "session-file-unavailable",
        error instanceof ObservationFailure
          ? error.detail
          : "The actual local session file could not be read.",
      ),
    };
  }
}

export function sameBase(left: SessionBase, right: SessionBase): boolean {
  return left.manager === right.manager
    && left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.recordedCwd === right.recordedCwd;
}

export function samePublicationBase(left: PublicationBase, right: PublicationBase): boolean {
  return sameBase(left, right) && left.sessionDir === right.sessionDir && left.file === right.file;
}

export function parseActiveBranch(branch: readonly unknown[], leafId: string | null): BranchEntry[] {
  if (branch.length === 0) {
    if (leafId !== null) fail("branch", "The selected leaf is set but the branch is empty.");
    return [];
  }
  if (branch.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries) {
    fail("branch", "The session branch exceeds its fixed traversal bound.");
  }
  let entries: BranchEntry[];
  try {
    entries = parseBranch(branch);
  } catch {
    fail("branch", "The session branch is malformed.");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const expectedParent = index === 0 ? null : entries[index - 1]!.id;
    if (entries[index]!.parentId !== expectedParent) {
      fail("branch", "The session branch is not one contiguous ancestor chain.");
    }
  }
  if (leafId === null || entries[entries.length - 1]!.id !== leafId) {
    fail("branch", "The selected leaf is not the actual branch end.");
  }
  return entries;
}

export interface DirectoryPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function withNonBlocking(io: NativeFileIo): NativeFileIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: (target) => io.realpath(target),
    lstat: (target, options) => io.lstat(target, options),
    open: (target, flags) => io.open(target, flags | nonBlocking),
  };
}

function sameDirectoryIdentity(left: DirectoryPin, right: NativeFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function sameDirectoryPin(left: DirectoryPin, right: DirectoryPin): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function pinDirectory(directory: string, io: NativeFileIo): Promise<DirectoryPin | null> {
  try {
    const resolved = await io.realpath(directory);
    if (resolved !== directory) return null;
    const info = await io.lstat(directory, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) return null;
    return {
      path: directory,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    };
  } catch {
    return null;
  }
}

async function directoryStillCurrent(pin: DirectoryPin, io: NativeFileIo): Promise<boolean> {
  try {
    const resolved = await io.realpath(pin.path);
    if (resolved !== pin.path) return false;
    const info = await io.lstat(pin.path, { bigint: true });
    return !info.isSymbolicLink() && info.isDirectory() && sameDirectoryIdentity(pin, info);
  } catch {
    return false;
  }
}

function bindPinnedDirectory(io: NativeFileIo, pin: DirectoryPin): NativeFileIo {
  const changed = (): never => {
    throw fail("disk", "The trusted session directory identity changed before readback.");
  };
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: async (target) => {
      const resolved = await io.realpath(target);
      if (path.normalize(target) === pin.path && resolved !== pin.path) changed();
      return resolved;
    },
    lstat: async (target, options) => {
      const info = await io.lstat(target, options);
      if (path.normalize(target) === pin.path) {
        if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryIdentity(pin, info)) changed();
      }
      return info;
    },
    open: (target, flags) => io.open(target, flags),
  };
}

export interface SessionDiskEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly value: Record<string, unknown>;
}

export interface SessionDiskFile {
  readonly header: Record<string, unknown>;
  readonly entries: readonly SessionDiskEntry[];
  readonly byId: ReadonlyMap<string, SessionDiskEntry>;
}

function isSessionTitleSlot(value: Record<string, unknown>): boolean {
  if (value.type !== "title" || value.v !== 1) return false;
  if (typeof value.title !== "string" || typeof value.updatedAt !== "string" || typeof value.pad !== "string") {
    return false;
  }
  const source = value.source;
  return source === undefined || source === "auto" || source === "user";
}

function parseSessionFile(text: string, sessionId: string, recordedCwd: string): SessionDiskFile | null {
  if (Buffer.byteLength(text, "utf8") > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileBytes) return null;
  if (text.includes("\0")) return null;
  const lines = text.split("\n");
  if (lines.length > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.sessionFileLines) return null;
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return null;
  let header: Record<string, unknown> | null = null;
  let bodyStart = 0;
  const entries: SessionDiskEntry[] = [];
  const byId = new Map<string, SessionDiskEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    if (index === 0) {
      if (!isPlainRecord(parsed)) return null;
      if (parsed.type === "session") {
        header = parsed;
        bodyStart = 1;
        continue;
      }
      // The actual fixed host may write one title metadata slot as the first
      // physical line. It is optional, may appear at most once and is never
      // branch evidence; its serialized byte size and padding are not parser
      // requirements.
      if (!isSessionTitleSlot(parsed)) return null;
      const next = lines[1];
      if (next === undefined || next.length === 0) return null;
      let headerParsed: unknown;
      try {
        headerParsed = JSON.parse(next);
      } catch {
        return null;
      }
      if (!isPlainRecord(headerParsed) || headerParsed.type !== "session") return null;
      header = headerParsed;
      bodyStart = 2;
      index = 1;
      continue;
    }
    if (!isPlainRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    if (parsed.parentId !== null && typeof parsed.parentId !== "string") return null;
    if (typeof parsed.type !== "string") return null;
    // Exactly one session header is allowed; no later title slot or foreign
    // header may masquerade as an entry, even with id/parentId present.
    if (parsed.type === "session" || parsed.type === "title") return null;
    if (byId.has(parsed.id)) return null;
    const entry: SessionDiskEntry = {
      id: parsed.id,
      parentId: parsed.parentId,
      type: parsed.type,
      value: parsed,
    };
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  if (header === null || bodyStart === 0) return null;
  if (header.id !== sessionId) return null;
  if (header.cwd !== recordedCwd) return null;
  return { header, entries, byId };
}

export type SessionJournalRead =
  | { readonly ok: true; readonly value: SessionDiskFile }
  | { readonly ok: false; readonly reason: NativeHarnessHistoryReason };

/**
 * One bounded read of the actual session journal below its pinned directory:
 * pin, guard, restricted open/read, guard, directory recheck, guard, parse.
 *
 * This is exactly the former `confirmSessionDisk` read prefix. It returns the
 * parsed observation only; it does not decide persistence, current ownership or
 * any evidence relationship, and it starts no append or ensure.
 */
export async function readNativeHarnessSessionJournal(
  base: PublicationBase,
  io: NativeFileIo,
  guard: () => boolean,
  observedAt: number,
): Promise<SessionJournalRead> {
  const pin = await pinDirectory(base.sessionDir, io);
  if (pin === null) {
    return { ok: false, reason: reason("disk-unavailable", "The trusted session directory could not be pinned.") };
  }
  // Revalidate after the pin await and before any file open. A held pin with a
  // disposed/navigated owner starts no further read.
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed before disk readback.") };
  }
  const scoped = bindPinnedDirectory(withNonBlocking(io), pin);
  let snapshot: NativeWorkspaceTextSnapshot;
  try {
    snapshot = await captureWorkspaceText(base.sessionDir, path.basename(base.file), scoped, observedAt);
  } catch {
    return { ok: false, reason: reason("disk-unavailable", "The local session file could not be read within its fixed profile.") };
  }
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed during disk readback.") };
  }
  if (!(await directoryStillCurrent(pin, io))) {
    return { ok: false, reason: reason("disk-unavailable", "The trusted session directory identity changed during readback.") };
  }
  if (!guard()) {
    return { ok: false, reason: reason("disk-unavailable", "The owner, session or branch changed after directory recheck.") };
  }
  const parsed = parseSessionFile(snapshot.text, base.sessionId, base.recordedCwd);
  if (parsed === null) {
    return { ok: false, reason: reason("disk-unavailable", "The local session file header or entries do not match the actual session.") };
  }
  return { ok: true, value: parsed };
}
