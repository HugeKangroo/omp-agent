import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Bounded, non-authoritative observation helpers for the explicitly loaded
 * native work entry. Nothing here persists, accepts, verifies or grants
 * authority; it only reads explicitly selected workspace files and returns
 * plain facts about the bytes observed at that moment.
 */

export const NATIVE_WORK_INTERFACE = "omp-agent.native-work-observation.v1";
export const NATIVE_WORK_TOOL = "agent_work";
export const MAX_OUTPUT_FILES = 8;
export const MAX_OUTPUT_FILE_BYTES = 256 * 1024;
export const MAX_OUTPUT_TOTAL_BYTES = 1024 * 1024;

export type NativeFileCode = "invalid-path" | "missing" | "unsafe-path" | "changed" | "non-text" | "too-large";

export class NativeFileError extends Error {
  override name = "NativeFileError";
  constructor(message: string, readonly code: NativeFileCode) {
    super(message);
  }
}

export interface NativeFileStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface NativeFileHandle {
  stat(options: { bigint: true }): Promise<NativeFileStats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

/** Narrow file-system seam so change-during-read behavior is testable without source-cache use. */
export interface NativeFileIo {
  readonly O_RDONLY: number;
  readonly O_NOFOLLOW: number;
  realpath(target: string): Promise<string>;
  lstat(target: string, options: { bigint: true }): Promise<NativeFileStats>;
  open(target: string, flags: number): Promise<NativeFileHandle>;
}

export const nodeFileIo: NativeFileIo = {
  O_RDONLY: constants.O_RDONLY,
  O_NOFOLLOW: constants.O_NOFOLLOW ?? 0,
  realpath: (target) => realpath(target),
  lstat: (target, options) => lstat(target, options),
  open: (target, flags) => open(target, flags),
};

export interface NativeObservedFile {
  relativePath: string;
  bytes: number;
  sha256: string;
  observedAt: number;
}

/**
 * One textual read of one workspace file. The text is decoded from the same
 * buffer used for the byte count and hash; it is not a claim about later
 * filesystem state.
 */
export interface NativeWorkspaceTextSnapshot {
  readonly captureId: string;
  readonly file: Readonly<NativeObservedFile>;
  readonly text: string;
}

const issuedTextSnapshots = new WeakSet<NativeWorkspaceTextSnapshot>();

/** Source-identity check for this module only; it is not a permission grant. */
export function isNativeWorkspaceTextSnapshot(value: unknown): value is NativeWorkspaceTextSnapshot {
  return typeof value === "object" && value !== null && issuedTextSnapshots.has(value as NativeWorkspaceTextSnapshot);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Accepts one unambiguous workspace-relative POSIX path. Absolute paths,
 * traversal, drive/backslash ambiguity, empty segments and control characters
 * are rejected before any file-system call.
 */
export function validateRelativePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1024
    || value.includes("\\")
    || value.includes("\0")
    || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    throw new NativeFileError("Output file path must be a relative POSIX path.", "invalid-path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0
        || segment === "."
        || segment === ".."
        || segment.length > 255
        || /[\x00-\x1f\x7f]/.test(segment),
    )
  ) {
    throw new NativeFileError("Output file path contains an empty, traversing or unsafe segment.", "invalid-path");
  }
  return segments.join("/");
}

interface DirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface RootIdentity {
  canonical: string;
  identity: DirectoryIdentity;
}

function sameFileSignature(left: NativeFileStats, right: NativeFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function rootOf(io: NativeFileIo, root: string): Promise<RootIdentity> {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new NativeFileError("Workspace root is unavailable.", "invalid-path");
  }
  let canonical: string;
  try {
    canonical = await io.realpath(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NativeFileError("Workspace root is missing.", "missing");
    throw new NativeFileError("Workspace root could not be resolved.", "changed");
  }
  let info: NativeFileStats;
  try {
    info = await io.lstat(canonical, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NativeFileError("Workspace root is missing.", "missing");
    throw new NativeFileError("Workspace root could not be inspected.", "changed");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new NativeFileError("Workspace root is not a directory.", "unsafe-path");
  }
  return {
    canonical,
    identity: {
      path: canonical,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    },
  };
}

function changed(): NativeFileError {
  return new NativeFileError("Output file changed while it was being observed.", "changed");
}

async function recheckDirectories(
  io: NativeFileIo,
  canonicalRoot: string,
  directories: readonly DirectoryIdentity[],
): Promise<void> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await io.realpath(canonicalRoot);
  } catch {
    throw changed();
  }
  if (resolvedRoot !== canonicalRoot) throw changed();
  for (const directory of directories) {
    let resolved: string;
    try {
      resolved = await io.realpath(directory.path);
    } catch {
      throw changed();
    }
    if (resolved !== directory.path || !isContained(canonicalRoot, resolved)) throw changed();
    let info: NativeFileStats;
    try {
      info = await io.lstat(directory.path, { bigint: true });
    } catch {
      throw changed();
    }
    if (
      info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== directory.dev
      || info.ino !== directory.ino
      || info.mtimeNs !== directory.mtimeNs
      || info.ctimeNs !== directory.ctimeNs
    ) {
      throw changed();
    }
  }
}

/**
 * Reads one explicitly selected text file below the canonical workspace root.
 * Existing parents must be real directories, the final component must be a
 * regular file opened with O_NOFOLLOW, and device/inode/size/timestamps are
 * compared before and after the read. The returned hash and text describe only
 * the bytes read at `observedAt`; they are not managed provenance or future
 * state. UTF-8 is decoded with the BOM retained, so re-encoding reproduces the
 * read buffer exactly.
 */
export async function captureWorkspaceText(
  root: string,
  relativePath: string,
  io: NativeFileIo = nodeFileIo,
  observedAt: number = Date.now(),
): Promise<NativeWorkspaceTextSnapshot> {
  const relative = validateRelativePath(relativePath);
  const rootIdentity = await rootOf(io, root);
  const canonicalRoot = rootIdentity.canonical;
  const directories: DirectoryIdentity[] = [rootIdentity.identity];
  const segments = relative.split("/");
  let parent = canonicalRoot;

  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    let info: NativeFileStats;
    try {
      info = await io.lstat(parent, { bigint: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new NativeFileError("Output file parent directory is missing.", "missing");
      throw new NativeFileError("Output file parent directory could not be inspected.", "changed");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new NativeFileError("Output file path traverses a link or non-directory.", "unsafe-path");
    }
    let canonicalParent: string;
    try {
      canonicalParent = await io.realpath(parent);
    } catch {
      throw new NativeFileError("Output file parent directory could not be resolved.", "changed");
    }
    if (canonicalParent !== parent || !isContained(canonicalRoot, canonicalParent)) {
      throw new NativeFileError("Output file parent escaped the workspace.", "unsafe-path");
    }
    directories.push({
      path: parent,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    });
  }

  const name = segments.at(-1)!;
  const absolute = path.join(parent, name);
  if (!isContained(canonicalRoot, absolute) || absolute === canonicalRoot) {
    throw new NativeFileError("Output file escapes the workspace.", "invalid-path");
  }

  let before: NativeFileStats;
  try {
    before = await io.lstat(absolute, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NativeFileError("Output file is missing.", "missing");
    throw new NativeFileError("Output file could not be inspected.", "changed");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new NativeFileError("Output file must be a regular non-link file.", "unsafe-path");
  }
  if (before.size > BigInt(MAX_OUTPUT_FILE_BYTES)) {
    throw new NativeFileError(`Output file exceeds ${MAX_OUTPUT_FILE_BYTES} bytes.`, "too-large");
  }

  let handle: NativeFileHandle | undefined;
  try {
    handle = await io.open(absolute, io.O_RDONLY | io.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw new NativeFileError("Output file is missing.", "missing");
    if (isErrno(error, "ELOOP")) throw new NativeFileError("Output file is a link.", "unsafe-path");
    throw new NativeFileError("Output file could not be opened.", "changed");
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new NativeFileError("Output file is not regular.", "unsafe-path");
    if (!sameFileSignature(before, opened)) throw changed();
    if (opened.size > BigInt(MAX_OUTPUT_FILE_BYTES)) {
      throw new NativeFileError(`Output file exceeds ${MAX_OUTPUT_FILE_BYTES} bytes.`, "too-large");
    }

    const size = Number(opened.size);
    const buffer = new Uint8Array(size);
    let read = 0;
    while (read < size) {
      const result = await handle.read(buffer, read, size - read, read);
      if (result.bytesRead <= 0) break;
      read += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (read !== size || !sameFileSignature(opened, after)) throw changed();

    // The open handle keeps the old inode alive across a rename. Recheck the
    // original directories and the current path so a swapped parent or a
    // recreated file is refused instead of returning the old bytes under the
    // requested relative name.
    await recheckDirectories(io, canonicalRoot, directories);
    let finalAtPath: NativeFileStats;
    try {
      finalAtPath = await io.lstat(absolute, { bigint: true });
    } catch {
      throw changed();
    }
    if (finalAtPath.isSymbolicLink() || !finalAtPath.isFile() || !sameFileSignature(opened, finalAtPath)) {
      throw changed();
    }

    if (buffer.includes(0)) {
      throw new NativeFileError("Output file is not UTF-8 text.", "non-text");
    }
    let text: string;
    try {
      // ignoreBOM keeps a leading UTF-8 BOM as U+FEFF in the decoded text.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new NativeFileError("Output file is not valid UTF-8 text.", "non-text");
    }
    const file: Readonly<NativeObservedFile> = Object.freeze({
      relativePath: relative,
      bytes: read,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      observedAt,
    });
    const snapshot: NativeWorkspaceTextSnapshot = Object.freeze({
      captureId: randomUUID(),
      file,
      text,
    });
    issuedTextSnapshots.add(snapshot);
    return snapshot;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Existing observation API. It returns an independent, mutable copy of the
 * plain file facts and never exposes the text or capture identity.
 */
export async function observeWorkspaceFile(
  root: string,
  relativePath: string,
  io: NativeFileIo = nodeFileIo,
  observedAt: number = Date.now(),
): Promise<NativeObservedFile> {
  const snapshot = await captureWorkspaceText(root, relativePath, io, observedAt);
  return { ...snapshot.file };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface BoundedExcerpt {
  text: string;
  truncated: boolean;
}

/** Single-line bounded excerpt for a request reference or model-declared label. */
export function compactExcerpt(value: string, max: number): BoundedExcerpt {
  // Normalize only a bounded prefix so a very large prompt cannot force a
  // full-string allocation merely to produce a short reference excerpt.
  const rawLimit = Math.max(max * 4, max);
  const raw = value.length > rawLimit ? value.slice(0, rawLimit) : value;
  const normalized = raw.replace(/\s+/g, " ").trim();
  const truncated = raw.length < value.length;
  if (normalized.length <= max) return { text: normalized, truncated };
  return { text: normalized.slice(0, max), truncated: true };
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export function clonePlain<T>(value: T): T {
  return structuredClone(value);
}
