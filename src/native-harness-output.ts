import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  matchesNativeHarnessBackendCompletion,
  readNativeHarnessBackendCompletion,
} from "./native-harness-backend.ts";
import {
  NATIVE_HARNESS_COMPLETION_LIMITS,
  NATIVE_HARNESS_COMPLETION_SCHEMA,
  type NativeHarnessBackendCompletion,
  type NativeHarnessCompletionSelection,
} from "./native-harness-completion.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  nodeFileIo,
  sha256Hex,
  validateRelativePath,
  type NativeFileHandle,
  type NativeFileIo,
  type NativeFileStats,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";

/**
 * Host-only, bounded observation of the complete supported regular-file change
 * set for one already-issued native Harness completion.
 *
 * This leaf starts no process, writes no files, exposes no model tool and does
 * not alter backend, completion, spend or native work state. It reads only
 * paths derived from the issued completion and retains hashes, byte counts and
 * the actual `NativeWorkspaceTextSnapshot` objects issued by `native-work.ts`.
 * It is not semantic acceptance, current work or a filesystem transaction.
 */

export const NATIVE_HARNESS_OUTPUT_SCHEMA = "omp-agent.native-harness-output-capture.v1" as const;
export const NATIVE_HARNESS_OUTPUT_ORIGIN = "harness2-native" as const;

export const NATIVE_HARNESS_OUTPUT_LIMITS = Object.freeze({
  maxSourceInputs: 8,
  maxSourceTotalBytes: 256 * 1024,
  maxOutputFiles: 8,
  maxOutputFileBytes: 256 * 1024,
  maxOutputTotalBytes: 1024 * 1024,
  maxStageOrdinaryFiles: 16,
  maxStageFileBytes: 256 * 1024,
  maxStageTotalBytes: 1024 * 1024 + 256 * 1024,
  maxDirectories: 64,
  maxEntries: 128,
  maxDepth: 16,
  maxStages: 8,
  maxTraceBytes: 32 * 1024 * 1024,
  maxTraceTotalBytes: 64 * 1024 * 1024,
  traceBufferBytes: 64 * 1024,
  maxMarkerBytes: 16 * 1024,
  maxMetadataBytes: 128 * 1024,
  maxPrivatePathChars: 4096,
  maxReasonChars: 320,
  elapsedBudgetMs: 30_000,
});

export type NativeHarnessOutputFailure =
  | "source-unavailable"
  | "invalid-control"
  | "aborted"
  | "authority-lost"
  | "deadline"
  | "unsafe-path"
  | "missing"
  | "changed"
  | "unsupported"
  | "too-large"
  | "no-output-changes"
  | "io-failure";

export interface NativeHarnessOutputFailureResult {
  readonly ok: false;
  readonly code: NativeHarnessOutputFailure;
  readonly reason: string;
  /**
   * Positive evidence that a required observation differs from the frozen or
   * previously issued facts. Absence means unavailable, uncertain, interrupted
   * or unclassified; it never means equality.
   */
  readonly observedMismatch?: true;
}

/** Fixed section label for a failed comparison; never caller text. */
export type NativeHarnessOutputVersionSection =
  | "binding"
  | "identity"
  | "winner"
  | "changes"
  | "sources"
  | "base"
  | "stages"
  | "digest";

export type NativeHarnessOutputVersionComparison =
  | { readonly ok: true; readonly sameVersion: true }
  | {
    readonly ok: false;
    readonly code: "invalid-binding" | "version-mismatch";
    readonly section: NativeHarnessOutputVersionSection;
  };

/** Fixed test-only checkpoint names. Production callers pass no ports. */
export type NativeHarnessOutputCheckpointPoint =
  | "after-directory-open"
  | "before-text-read"
  | "after-text-read"
  | "before-trace-open"
  | "after-trace-open"
  | "after-trace-read"
  | "before-final-recheck"
  | "before-issue";

/** Bounded facts for a trusted deterministic test callback; never an authority source. */
export interface NativeHarnessOutputCheckpoint {
  readonly point: NativeHarnessOutputCheckpointPoint;
  readonly stage: string | null;
  readonly relativePath: string | null;
  readonly bytes: number | null;
}

export interface NativeHarnessOutputTestPorts {
  readonly checkpoint?: (event: NativeHarnessOutputCheckpoint) => void | Promise<void>;
}

export interface NativeHarnessOutputSourceFact {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessOutputBaseFact extends NativeHarnessOutputSourceFact {
  readonly mode: number;
  readonly controllerHash: string;
}

export interface NativeHarnessOutputTraceFact {
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessOutputStageFact {
  readonly candidate: string;
  readonly attempt: number;
  readonly artifactHash: string;
  readonly changeManifestSha256: string;
  readonly changeCount: number;
  readonly ordinaryFileCount: number;
  readonly directoryCount: number;
  readonly trace: NativeHarnessOutputTraceFact;
}

/**
 * One supported regular-file output record. `snapshot` is the actual object
 * issued by `captureWorkspaceText` for the winner stage bytes observed here.
 */
export interface NativeHarnessOutputRecord {
  readonly path: string;
  readonly kind: "add" | "modify";
  readonly mode: number;
  readonly controllerHash: string;
  readonly snapshot: NativeWorkspaceTextSnapshot;
}

export interface NativeHarnessOutputWinnerFact {
  readonly candidate: string;
  readonly attempt: number;
  readonly artifactHash: string;
  readonly traceHash: string;
}

export interface NativeHarnessOutputCapture {
  readonly schema: typeof NATIVE_HARNESS_OUTPUT_SCHEMA;
  readonly captureId: string;
  readonly originKind: typeof NATIVE_HARNESS_OUTPUT_ORIGIN;
  readonly completionId: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly taskSha256: string;
  readonly baseSnapshotId: string;
  readonly manifestSha256: string;
  readonly winner: NativeHarnessOutputWinnerFact;
  readonly changes: readonly NativeHarnessOutputRecord[];
  readonly sources: readonly NativeHarnessOutputSourceFact[];
  readonly baseInputs: readonly NativeHarnessOutputBaseFact[];
  readonly stages: readonly NativeHarnessOutputStageFact[];
  readonly digest: string;
  readonly observedAt: number;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly limitations: readonly string[];
}

export type NativeHarnessOutputCaptureResult =
  | { readonly ok: true; readonly capture: NativeHarnessOutputCapture }
  | NativeHarnessOutputFailureResult;

const COMPLETION_SCHEMA = NATIVE_HARNESS_COMPLETION_SCHEMA;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const ORIGIN_MARKER = ".harness2-origin.json";
const MAX_REASON_CHARS = NATIVE_HARNESS_OUTPUT_LIMITS.maxReasonChars;
// Captured once from the native prototype so a shadowed/subclass `aborted`
// property cannot substitute user-visible state for the actual signal.
const ACTUAL_ABORTED_GETTER: ((this: AbortSignal) => unknown) | null =
  typeof AbortSignal === "undefined"
    ? null
    : Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;

const DEPENDENCY_DIRECTORIES = new Set(["node_modules", ".venv", "venv"]);
const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".harness2",
  ".harness-evidence",
  ".omp",
  ".pi",
  ".claude",
  ".codex",
  ".gemini",
  ".aws",
  ".ssh",
  ".gnupg",
  "agents.md",
  "claude.md",
  "gemini.md",
  // Only the exact top-level regular-file marker is handled before this
  // reserved check; directories and nested/case variants are refused.
  ORIGIN_MARKER,
]);
// Fixed copy of the vendor workspace secret-name policy. This leaf does not
// change or export vendor policy.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|service[-_]account[^/]*\.json)$|\.(?:pem|key|p12|pfx|keystore)$/i;

const LIMITATIONS = Object.freeze([
  "Host-only observation of supported regular-file bytes in the selected stage and frozen ancestry; not semantic acceptance, apply, authorship or current native work.",
  "Observations are over intervals: a change wholly between two observations is not excluded and writes after return are not prevented.",
  "Trace hashes are byte counts and digests only; the trace was not parsed and does not prove that semantic tests passed.",
  "No process-group cleanup, physical isolation, filesystem transaction or durable restart recovery is established.",
]);

/** Only captures issued by this module for an exact backend/completion pair. */
const issuedOutputCaptures = new WeakMap<
  NativeHarnessOutputCapture,
  { readonly backend: unknown; readonly completion: NativeHarnessBackendCompletion }
>();

interface IssuedFailure {
  readonly code: NativeHarnessOutputFailure;
  readonly reason: string;
  readonly observedMismatch?: true;
}

/**
 * Bounded failure records keyed by our own error objects. Normalizing here
 * avoids reading code/message/toString from an arbitrary thrown value.
 */
const issuedFailures = new WeakMap<OutputError, IssuedFailure>();

const NATIVE_FILE_FAILURE_CODES = new Set([
  "invalid-path",
  "missing",
  "unsafe-path",
  "changed",
  "non-text",
  "too-large",
]);

class OutputError extends Error {
  override name = "NativeHarnessOutputError";
  constructor(readonly code: NativeHarnessOutputFailure, message: string) {
    super(message);
  }
}

function boundedReason(value: string): string {
  // Keep reasons single-line primitives; never serialize a thrown object.
  const cleaned = value.replace(/[\x00-\x1f\x7f]+/g, " ");
  return cleaned.length <= MAX_REASON_CHARS ? cleaned : cleaned.slice(0, MAX_REASON_CHARS);
}

function fail(code: NativeHarnessOutputFailure, reason: string, observedMismatch?: true): never {
  const normalized = boundedReason(reason);
  const error = new OutputError(code, normalized);
  issuedFailures.set(
    error,
    observedMismatch === true
      ? { code, reason: normalized, observedMismatch: true }
      : { code, reason: normalized },
  );
  throw error;
}

/** Mark only a positively established inequality, shape or required absence. */
function failObserved(code: NativeHarnessOutputFailure, reason: string): never {
  return fail(code, reason, true);
}

/** Reads the marker only from this leaf's own issued failure entry. */
function issuedObservedMismatch(error: unknown): true | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return issuedFailures.get(error as OutputError)?.observedMismatch;
}

function failureResult(failure: IssuedFailure): NativeHarnessOutputFailureResult {
  return failure.observedMismatch === true
    ? { ok: false, code: failure.code, reason: failure.reason, observedMismatch: true }
    : { ok: false, code: failure.code, reason: failure.reason };
}

function isErrno(error: unknown, code: string): boolean {
  return readOwnString(error, "code") === code;
}

function readOwnString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string") {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

function rejectControlResult(value: unknown, label: string): void {
  // The guard contract is exactly `undefined`. Any other value, including a
  // thenable or a proxy with a throwing getter, is refused without reading it.
  if (value !== undefined) {
    fail("invalid-control", `${label} must return undefined synchronously.`);
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isStrictlyContained(root: string, candidate: string): boolean {
  return candidate !== root && isContained(root, candidate);
}

function trustedAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxPrivatePathChars
    || !path.isAbsolute(value)
    || path.resolve(value) !== value
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail("unsafe-path", `${label} is not a bounded canonical absolute path.`);
  }
  return value;
}

function boundedRelative(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024) {
    fail("unsafe-path", "A relative path exceeds the 1024-character capture profile bound.");
  }
  try {
    return validateRelativePath(value);
  } catch (error) {
    if (error instanceof NativeFileError) {
      fail("unsafe-path", "A relative path is not an unambiguous workspace path.");
    }
    throw error;
  }
}

function isReservedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return DEPENDENCY_DIRECTORIES.has(lower) || PROTECTED_SEGMENTS.has(lower) || SECRET_NAME.test(segment);
}

function assertNoReservedSegment(relativePath: string): void {
  for (const segment of relativePath.split("/")) {
    if (isReservedSegment(segment)) {
      fail("unsupported", `Protected or dependency path is not supported: ${relativePath}`);
    }
  }
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

interface FileSignature {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  /** Complete observed st_mode, including special permission bits. */
  readonly rawMode: bigint;
  /** Ordinary permission bits used by the Controller mode-aware hash. */
  readonly mode: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function signatureOf(info: NativeFileStats): FileSignature {
  const mode = (info as NativeFileStats & { readonly mode?: unknown }).mode;
  if (typeof mode !== "bigint") fail("io-failure", "A file mode was not observed by the filesystem seam.");
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    rawMode: mode,
    mode: Number(mode & 0o777n),
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function directoryIdentityOf(target: string, info: NativeFileStats): DirectoryIdentity {
  return { path: target, dev: info.dev, ino: info.ino, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

function sameFileSignature(left: FileSignature, right: FileSignature): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.rawMode === right.rawMode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function observeRoot(ctx: Context, expected: string, label: string): Promise<DirectoryIdentity> {
  const info = await lstatOrFail(ctx, expected, label);
  if (info.isSymbolicLink()) fail("unsafe-path", `${label} is a symbolic link.`);
  if (!info.isDirectory()) fail("unsafe-path", `${label} is not a directory.`);
  let resolved: string;
  try {
    resolved = await ctx.io.realpath(expected);
  } catch (error) {
    if (error instanceof OutputError) throw error;
    fail("changed", `${label} could not be resolved canonically.`);
  }
  if (resolved !== expected) fail("unsafe-path", `${label} is not the expected canonical path.`);
  const identity = directoryIdentityOf(expected, info);
  const existing = ctx.directories.get(expected);
  if (existing !== undefined) {
    if (!sameDirectoryIdentity(existing, identity)) {
      fail("changed", `${label} changed during capture.`);
    }
    return existing;
  }
  ctx.directories.set(expected, identity);
  return identity;
}

function assertOrdinaryMode(signature: FileSignature, relativePath: string): void {
  if ((signature.rawMode & 0o7000n) !== 0n) {
    fail("unsupported", `Special file permission bits are not supported: ${relativePath}`);
  }
}

function controllerHash(mode: number, bytes: Uint8Array): string {
  return createHash("sha256")
    .update(Buffer.from(`${mode.toString(8)}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function rawBytesOf(snapshot: NativeWorkspaceTextSnapshot): Buffer {
  const bytes = Buffer.from(snapshot.text, "utf8");
  if (bytes.length !== snapshot.file.bytes || sha256Hex(bytes) !== snapshot.file.sha256) {
    fail("changed", "Decoded text bytes no longer match the issued snapshot facts.");
  }
  return bytes;
}

interface ObservedTextFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly snapshot: NativeWorkspaceTextSnapshot;
  readonly signature: FileSignature;
  readonly controllerHash: string;
}

interface TreeEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly signature: FileSignature;
}

interface TreeObservation {
  readonly root: string;
  readonly identity: DirectoryIdentity;
  readonly entries: readonly TreeEntry[];
  readonly files: ReadonlyMap<string, ObservedTextFile>;
  readonly markerSignature: FileSignature | null;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalFileBytes: number;
}

interface TraceObservation {
  readonly candidate: string;
  readonly attempt: number;
  readonly artifactDir: string;
  readonly eventsPath: string;
  readonly artifactIdentity: DirectoryIdentity;
  readonly signature: FileSignature;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

interface TracePass {
  totalBytes: number;
}

interface AuthorityContext {
  readonly guard: () => void;
  readonly signal: AbortSignal;
  readonly startedAt: number;
}

interface Context extends AuthorityContext {
  readonly checkpoint: ((event: NativeHarnessOutputCheckpoint) => void | Promise<void>) | null;
  readonly io: NativeFileIo;
  readonly directories: Map<string, DirectoryIdentity>;
  readonly closeError: { value: boolean };
  readonly controlFailure: { value: OutputError | null };
}

function readActualAborted(signal: unknown): boolean {
  if (ACTUAL_ABORTED_GETTER === null || typeof signal !== "object" || signal === null) {
    fail("invalid-control", "An actual AbortSignal is required.");
  }
  try {
    return Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []) === true;
  } catch {
    fail("invalid-control", "An actual AbortSignal is required.");
  }
}

function assertAuthority(ctx: AuthorityContext): void {
  if (readActualAborted(ctx.signal)) fail("aborted", "The capture signal was aborted.");
  let result: unknown;
  try {
    result = ctx.guard();
  } catch {
    fail("authority-lost", "The trusted guard refused the capture.");
  }
  rejectControlResult(result, "The trusted guard");
  if (readActualAborted(ctx.signal)) fail("aborted", "The capture signal was aborted during a guard check.");
  if (performance.now() - ctx.startedAt > NATIVE_HARNESS_OUTPUT_LIMITS.elapsedBudgetMs) {
    fail("deadline", "The cooperative capture elapsed budget was exceeded.");
  }
}

/**
 * Shared helper wrappers sometimes convert any thrown value into their own
 * refusal code. Retain the actual control refusal so the outer capture result
 * still reports aborted/authority-lost/deadline rather than a generic drift.
 */
function guardedAuthority(
  ctx: AuthorityContext & { readonly controlFailure: { value: OutputError | null } },
): void {
  try {
    assertAuthority(ctx);
  } catch (error) {
    if (error instanceof OutputError) ctx.controlFailure.value ??= error;
    throw error;
  }
}

function createGuardedIo(ctx: Omit<Context, "io">): NativeFileIo {
  return {
    O_RDONLY: nodeFileIo.O_RDONLY,
    O_NOFOLLOW: nodeFileIo.O_NOFOLLOW,
    async realpath(target: string): Promise<string> {
      guardedAuthority(ctx);
      const resolved = await nodeFileIo.realpath(target);
      guardedAuthority(ctx);
      return resolved;
    },
    async lstat(target: string, options: { bigint: true }): Promise<NativeFileStats> {
      guardedAuthority(ctx);
      const info = await nodeFileIo.lstat(target, options);
      guardedAuthority(ctx);
      return info;
    },
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      guardedAuthority(ctx);
      // O_NONBLOCK makes a FIFO/device swap between the caller's lstat and this
      // open return immediately instead of blocking a cooperative guard. The
      // opened handle is re-inspected before any read.
      const handle = await nodeFileIo.open(target, flags | O_NONBLOCK);
      // The protected cleanup lifetime starts immediately; no guard or
      // checkpoint runs between the successful open and this try block.
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.isSymbolicLink() || !opened.isFile()) {
          failObserved("unsupported", "An opened handle is not a regular non-link file.");
        }
        return {
          async stat(options: { bigint: true }): Promise<NativeFileStats> {
            guardedAuthority(ctx);
            const info = await handle.stat(options);
            guardedAuthority(ctx);
            return info;
          },
          async read(
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number,
          ): Promise<{ bytesRead: number }> {
            guardedAuthority(ctx);
            const result = await handle.read(buffer, offset, length, position);
            guardedAuthority(ctx);
            return result;
          },
          async close(): Promise<void> {
            try {
              await handle.close();
            } catch (error) {
              ctx.closeError.value = true;
              throw error;
            }
          },
        };
      } catch (error) {
        try {
          await handle.close();
        } catch {
          ctx.closeError.value = true;
        }
        throw error;
      }
    },
  };
}

async function runCheckpoint(
  ctx: Context,
  point: NativeHarnessOutputCheckpointPoint,
  stage: string | null,
  relativePath: string | null,
  bytes: number | null,
): Promise<void> {
  if (ctx.checkpoint === null) return;
  const event = Object.freeze({
    point,
    stage,
    relativePath: relativePath === null ? null : relativePath.slice(0, 1024),
    bytes,
  });
  try {
    await ctx.checkpoint(event);
  } catch {
    fail("authority-lost", "A trusted capture checkpoint refused the observation.");
  }
  assertAuthority(ctx);
}

async function lstatOrFail(ctx: Context, absolute: string, label: string): Promise<NativeFileStats> {
  try {
    return await ctx.io.lstat(absolute, { bigint: true });
  } catch (error) {
    if (error instanceof OutputError) throw error;
    if (isErrno(error, "ENOENT")) failObserved("missing", `${label} is missing.`);
    fail("io-failure", `${label} could not be inspected.`);
  }
}

async function registerAncestry(ctx: Context, root: DirectoryIdentity, target: string, label: string): Promise<void> {
  if (!isContained(root.path, target)) fail("unsafe-path", `${label} is outside its trusted prepared root.`);
  if (target === root.path) return;
  const segments = path.relative(root.path, target).split(path.sep).filter(Boolean);
  let cursor = root.path;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const info = await lstatOrFail(ctx, cursor, `${label} ancestry`);
    if (info.isSymbolicLink()) fail("unsafe-path", `${label} ancestry contains a symbolic link.`);
    if (!info.isDirectory()) fail("unsafe-path", `${label} ancestry contains a non-directory.`);
    let resolved: string;
    try {
      resolved = await ctx.io.realpath(cursor);
    } catch (error) {
      if (error instanceof OutputError) throw error;
      fail("changed", `${label} ancestry could not be resolved.`);
    }
    if (resolved !== cursor) fail("unsafe-path", `${label} ancestry is not canonical.`);
    const identity = directoryIdentityOf(cursor, info);
    const existing = ctx.directories.get(cursor);
    if (existing !== undefined) {
      if (!sameDirectoryIdentity(existing, identity)) {
        fail("changed", `${label} ancestry changed during capture.`);
      }
    } else {
      ctx.directories.set(cursor, identity);
    }
  }
}

async function readDirectoryNames(ctx: Context, absolute: string, stage: string | null): Promise<string[]> {
  assertAuthority(ctx);
  let directory;
  try {
    directory = await opendir(absolute);
  } catch (error) {
    if (isErrno(error, "ENOENT")) failObserved("missing", "A trusted directory disappeared.");
    fail("io-failure", "A trusted directory could not be opened.");
  }
  // The protected cleanup lifetime starts before the checkpoint can throw.
  try {
    await runCheckpoint(ctx, "after-directory-open", stage, null, null);
    const names: string[] = [];
    for (;;) {
      let entry;
      try {
        entry = await directory.read();
      } catch {
        fail("io-failure", "A trusted directory could not be read.");
      }
      assertAuthority(ctx);
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxEntries) {
        fail("too-large", "A trusted directory exceeds the entry bound.");
      }
    }
    return names.sort(comparePaths);
  } finally {
    try {
      await directory.close();
    } catch {
      ctx.closeError.value = true;
    }
  }
}

interface TreeOptions {
  readonly root: string;
  readonly label: string;
  readonly stage: NativeHarnessCompletionSelection | null;
  readonly allowMarker: boolean;
  readonly expectedMarkerBytes: string | null;
  readonly maxOrdinaryFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly readFiles: boolean;
}

async function observeTextFile(
  ctx: Context,
  root: string,
  relativePath: string,
  stage: string | null,
  read: boolean,
): Promise<ObservedTextFile> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const before = await lstatOrFail(ctx, absolute, `file ${relativePath}`);
  if (before.isSymbolicLink()) failObserved("unsafe-path", `Symbolic links are not supported: ${relativePath}`);
  if (!before.isFile()) failObserved("unsupported", `A special file is not supported: ${relativePath}`);
  const beforeSignature = signatureOf(before);
  assertOrdinaryMode(beforeSignature, relativePath);
  if (before.size > BigInt(NATIVE_HARNESS_OUTPUT_LIMITS.maxStageFileBytes)) {
    fail("too-large", `Stage file exceeds the supported per-file bound: ${relativePath}`);
  }
  if (!read) {
    // Recheck-only pass: lstat facts are compared by the caller. The snapshot
    // is only needed for first-pass bytes; this branch is never used to issue.
    fail("io-failure", "Internal recheck requested a text snapshot.");
  }
  await runCheckpoint(ctx, "before-text-read", stage, relativePath, Number(before.size));
  let snapshot: NativeWorkspaceTextSnapshot;
  try {
    snapshot = await captureWorkspaceText(root, relativePath, ctx.io, Date.now());
  } catch (error) {
    if (error instanceof OutputError) throw error;
    if (error instanceof NativeFileError) {
      switch (error.code) {
        case "invalid-path": fail("unsafe-path", `Unsupported relative path: ${relativePath}`);
        case "missing": fail("missing", `File is missing: ${relativePath}`);
        case "unsafe-path": fail("unsafe-path", `Unsafe file kind or path: ${relativePath}`);
        case "changed": fail("changed", `File changed while being read: ${relativePath}`);
        case "non-text": fail("unsupported", `File is not supported UTF-8 text: ${relativePath}`);
        case "too-large": fail("too-large", `File exceeds the supported per-file bound: ${relativePath}`);
      }
    }
    fail("io-failure", `File could not be read: ${relativePath}`);
  }
  await runCheckpoint(ctx, "after-text-read", stage, relativePath, snapshot.file.bytes);
  const after = await lstatOrFail(ctx, absolute, `file ${relativePath}`);
  if (after.isSymbolicLink() || !after.isFile() || !sameFileSignature(beforeSignature, signatureOf(after))) {
    failObserved("changed", `File identity or mode changed during capture: ${relativePath}`);
  }
  if (snapshot.file.relativePath !== relativePath) {
    fail("changed", `Issued snapshot path differs from the observed path: ${relativePath}`);
  }
  const bytes = rawBytesOf(snapshot);
  return {
    relativePath,
    absolutePath: absolute,
    snapshot,
    signature: beforeSignature,
    controllerHash: controllerHash(beforeSignature.mode, bytes),
  };
}

async function inventoryTree(ctx: Context, options: TreeOptions): Promise<TreeObservation> {
  const identity = ctx.directories.get(options.root) ?? await observeRoot(ctx, options.root, options.label);
  const entries: TreeEntry[] = [];
  const files = new Map<string, ObservedTextFile>();
  let markerSignature: FileSignature | null = null;
  let directoryCount = 1;
  let fileCount = 0;
  let totalFileBytes = 0;
  let markerCount = 0;

  const walk = async (relativeDirectory: string, depth: number): Promise<void> => {
    const absoluteDirectory = relativeDirectory === ""
      ? options.root
      : path.join(options.root, ...relativeDirectory.split("/"));
    const names = await readDirectoryNames(ctx, absoluteDirectory, options.stage?.candidate ?? null);
    for (const name of names) {
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      if (relativePath.split("/").length > NATIVE_HARNESS_OUTPUT_LIMITS.maxDepth) {
        fail("too-large", "A trusted tree exceeds the directory depth bound.");
      }
      if (entries.length + markerCount >= NATIVE_HARNESS_OUTPUT_LIMITS.maxEntries) {
        fail("too-large", "A trusted tree exceeds the entry bound.");
      }
      const absolute = path.join(options.root, ...relativePath.split("/"));
      const info = await lstatOrFail(ctx, absolute, `tree entry ${relativePath}`);
      if (info.isSymbolicLink()) failObserved("unsafe-path", `Symbolic links are not supported: ${relativePath}`);
      const signature = signatureOf(info);

      if (info.isDirectory()) {
        const bounded = boundedRelative(relativePath);
        assertNoReservedSegment(bounded);
        directoryCount += 1;
        if (directoryCount > NATIVE_HARNESS_OUTPUT_LIMITS.maxDirectories) {
          fail("too-large", "A trusted tree exceeds the directory bound.");
        }
        entries.push({ relativePath: bounded, kind: "directory", signature });
        await walk(bounded, depth + 1);
        continue;
      }

      if (!info.isFile()) {
        failObserved("unsupported", `A special file is not supported: ${relativePath}`);
      }

      const markerName = name.toLowerCase() === ORIGIN_MARKER;
      if (markerName) {
        if (!options.allowMarker || relativeDirectory !== "" || name !== ORIGIN_MARKER || options.expectedMarkerBytes === null) {
          fail("unsupported", `An unexpected origin marker is not supported: ${relativePath}`);
        }
        if ((signature.rawMode & 0o7777n) !== 0o600n) {
          fail("unsupported", "The origin marker mode is not exactly 0600.");
        }
        if (signature.size > BigInt(NATIVE_HARNESS_OUTPUT_LIMITS.maxMarkerBytes)) {
          fail("too-large", "The origin marker exceeds its byte bound.");
        }
        if (options.readFiles) {
          await runCheckpoint(ctx, "before-text-read", options.stage?.candidate ?? null, relativePath, Number(signature.size));
          let snapshot: NativeWorkspaceTextSnapshot;
          try {
            snapshot = await captureWorkspaceText(options.root, relativePath, ctx.io, Date.now());
          } catch (error) {
            if (error instanceof OutputError) throw error;
            fail("changed", "The origin marker could not be read unchanged.");
          }
          await runCheckpoint(ctx, "after-text-read", options.stage?.candidate ?? null, relativePath, snapshot.file.bytes);
          if (snapshot.text !== options.expectedMarkerBytes) {
            failObserved("changed", "The origin marker bytes do not match the fixed materialized marker.");
          }
          const after = await lstatOrFail(ctx, absolute, "origin marker");
          if (!after.isFile() || after.isSymbolicLink() || !sameFileSignature(signature, signatureOf(after))) {
            failObserved("changed", "The origin marker changed during capture.");
          }
        }
        markerSignature = signature;
        markerCount = 1;
        continue;
      }

      const bounded = boundedRelative(relativePath);
      assertNoReservedSegment(bounded);
      fileCount += 1;
      if (fileCount > options.maxOrdinaryFiles) {
        fail("too-large", "A trusted tree exceeds the ordinary-file bound.");
      }
      if (info.size > BigInt(options.maxFileBytes)) {
        fail("too-large", `A file exceeds the supported per-file bound: ${bounded}`);
      }
      totalFileBytes += Number(info.size);
      if (totalFileBytes > options.maxTotalBytes) {
        fail("too-large", "A trusted tree exceeds the ordinary-file byte bound.");
      }
      entries.push({ relativePath: bounded, kind: "file", signature });
      if (options.readFiles) {
        const observed = await observeTextFile(ctx, options.root, bounded, options.stage?.candidate ?? null, true);
        files.set(bounded, observed);
      }
    }
  };

  await walk("", 0);
  return { root: options.root, identity, entries, files, markerSignature, fileCount, directoryCount, totalFileBytes };
}

function sameTree(left: TreeObservation, right: TreeObservation): boolean {
  if (!sameDirectoryIdentity(left.identity, right.identity)) return false;
  if (left.entries.length !== right.entries.length) return false;
  if (left.fileCount !== right.fileCount || left.directoryCount !== right.directoryCount) return false;
  if (left.totalFileBytes !== right.totalFileBytes) return false;
  if ((left.markerSignature === null) !== (right.markerSignature === null)) return false;
  if (left.markerSignature !== null && right.markerSignature !== null
    && !sameFileSignature(left.markerSignature, right.markerSignature)) return false;
  for (let index = 0; index < left.entries.length; index += 1) {
    const before = left.entries[index]!;
    const after = right.entries[index]!;
    if (before.relativePath !== after.relativePath || before.kind !== after.kind) return false;
    if (!sameFileSignature(before.signature, after.signature)) return false;
  }
  return true;
}

interface DeclaredBase {
  readonly entries: ReadonlyMap<string, { readonly path: string; readonly size: number; readonly mode: number; readonly hash: string }>;
  readonly inputs: ReadonlyMap<string, { readonly relativePath: string; readonly bytes: number; readonly sha256: string }>;
}

function declareBase(completion: NativeHarnessBackendCompletion): DeclaredBase {
  if (completion.schema !== COMPLETION_SCHEMA || completion.origin !== NATIVE_HARNESS_OUTPUT_ORIGIN) {
    fail("source-unavailable", "The issued completion does not have the expected schema and origin.");
  }
  if (
    !Array.isArray(completion.prepared.inputs)
    || completion.prepared.inputs.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs
    || !Array.isArray(completion.base.entries)
    || completion.base.entries.length !== completion.prepared.inputs.length
  ) {
    fail("source-unavailable", "The issued completion input and base manifests are not usable.");
  }
  const inputs = new Map<string, { relativePath: string; bytes: number; sha256: string }>();
  let totalBytes = 0;
  for (const input of completion.prepared.inputs) {
    const relativePath = boundedRelative(input.relativePath);
    if (
      !Number.isSafeInteger(input.bytes)
      || input.bytes < 0
      || input.bytes > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes
      || !hex64(input.sha256)
      || inputs.has(relativePath)
    ) {
      fail("source-unavailable", "The issued completion input manifest is not usable.");
    }
    totalBytes += input.bytes;
    if (totalBytes > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes) {
      fail("too-large", "The issued inputs exceed the supported total byte bound.");
    }
    inputs.set(relativePath, { relativePath, bytes: input.bytes, sha256: input.sha256 });
  }
  const entries = new Map<string, { path: string; size: number; mode: number; hash: string }>();
  for (const entry of completion.base.entries) {
    const relativePath = boundedRelative(entry.path);
    if (
      !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || !Number.isSafeInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o777
      || !hex64(entry.hash)
      || entries.has(relativePath)
    ) {
      fail("source-unavailable", "The issued base manifest is not usable.");
    }
    entries.set(relativePath, { path: relativePath, size: entry.size, mode: entry.mode, hash: entry.hash });
  }
  return { entries, inputs };
}

function verifyInputManifestDigest(completion: NativeHarnessBackendCompletion): void {
  const sorted = [...completion.prepared.inputs]
    .map((input) => ({
      relativePath: boundedRelative(input.relativePath),
      bytes: input.bytes,
      sha256: input.sha256,
    }))
    .sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  const digest = sha256Hex(JSON.stringify(sorted.map((input) => [
    input.relativePath,
    input.bytes,
    input.sha256,
  ])));
  if (digest !== completion.prepared.manifestSha256 || digest !== completion.base.manifestSha256) {
    fail("changed", "The issued input manifest digest is inconsistent.");
  }
}

async function observeSources(
  ctx: Context,
  completion: NativeHarnessBackendCompletion,
  declared: DeclaredBase,
): Promise<Array<{ fact: NativeHarnessOutputSourceFact; signature: FileSignature; root: string; relativePath: string }>> {
  const sourceRoot = trustedAbsolute(completion.prepared.sourceRoot, "prepared sourceRoot");
  const preparedRoot = trustedAbsolute(completion.prepared.preparedRoot, "prepared preparedRoot");
  if (isContained(preparedRoot, sourceRoot) || isContained(sourceRoot, preparedRoot)) {
    fail("unsafe-path", "The original source root and private prepared root are not disjoint.");
  }
  await observeRoot(ctx, preparedRoot, "prepared preparedRoot");
  await observeRoot(ctx, sourceRoot, "prepared sourceRoot");
  const observations = [];
  let total = 0;
  for (const input of [...declared.inputs.values()].sort((left, right) => comparePaths(left.relativePath, right.relativePath))) {
    let observed: ObservedTextFile;
    try {
      observed = await observeTextFile(ctx, sourceRoot, input.relativePath, null, true);
    } catch (error) {
      if (error instanceof OutputError && error.code === "missing") {
        fail(
          "source-unavailable",
          "A selected original source file is no longer available.",
          issuedObservedMismatch(error),
        );
      }
      throw error;
    }
    if (observed.snapshot.file.bytes !== input.bytes || observed.snapshot.file.sha256 !== input.sha256) {
      failObserved("changed", "A selected original source file no longer matches the frozen input manifest.");
    }
    total += input.bytes;
    if (total > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes) {
      fail("too-large", "Original sources exceed the supported total byte bound.");
    }
    observations.push({
      fact: {
        relativePath: input.relativePath,
        bytes: observed.snapshot.file.bytes,
        sha256: observed.snapshot.file.sha256,
        observedAt: observed.snapshot.file.observedAt,
      },
      signature: observed.signature,
      root: sourceRoot,
      relativePath: input.relativePath,
    });
  }
  return observations;
}

async function observeBase(
  ctx: Context,
  completion: NativeHarnessBackendCompletion,
  declared: DeclaredBase,
): Promise<TreeObservation> {
  const preparedRoot = trustedAbsolute(completion.prepared.preparedRoot, "prepared preparedRoot");
  const preparedIdentity = ctx.directories.get(preparedRoot);
  if (preparedIdentity === undefined) fail("io-failure", "The prepared root was not observed.");
  const storeRoot = trustedAbsolute(completion.prepared.storeRoot, "prepared storeRoot");
  if (!isStrictlyContained(preparedRoot, storeRoot)) fail("unsafe-path", "The store root is not below the prepared root.");
  await registerAncestry(ctx, preparedIdentity, storeRoot, "prepared storeRoot");
  const runRoot = path.join(storeRoot, "runs", completion.runId);
  const baseRoot = trustedAbsolute(completion.base.root, "base snapshot root");
  if (!isStrictlyContained(runRoot, baseRoot)) fail("unsafe-path", "The base snapshot root is outside the private run area.");
  await registerAncestry(ctx, preparedIdentity, baseRoot, "base snapshot root");
  const identity = await observeRoot(ctx, baseRoot, "base snapshot root");
  const tree = await inventoryTree(ctx, {
    root: baseRoot,
    label: "base snapshot",
    stage: null,
    allowMarker: false,
    expectedMarkerBytes: null,
    maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs,
    maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    readFiles: true,
  });
  if (!sameDirectoryIdentity(identity, tree.identity)) fail("changed", "The base snapshot root changed during inventory.");
  if (tree.fileCount !== declared.entries.size || tree.files.size !== declared.entries.size) {
    failObserved("unsupported", "The base snapshot regular files do not exactly match the frozen base manifest.");
  }
  const observedPaths = [...tree.files.keys()].sort(comparePaths);
  const declaredPaths = [...declared.entries.keys()].sort(comparePaths);
  if (observedPaths.length !== declaredPaths.length) {
    fail("unsupported", "The base snapshot regular files do not exactly match the frozen base manifest.");
  }
  for (let index = 0; index < observedPaths.length; index += 1) {
    if (observedPaths[index] !== declaredPaths[index]) {
      failObserved("unsupported", "The base snapshot regular files do not exactly match the frozen base manifest.");
    }
  }
  for (const [relativePath, file] of tree.files) {
    const entry = declared.entries.get(relativePath);
    const input = declared.inputs.get(relativePath);
    if (entry === undefined || input === undefined) {
      fail("unsupported", "The base snapshot contains an unexpected regular file.");
    }
    const signature = file.signature;
    const snapshot = file.snapshot;
    if (
      snapshot.file.bytes !== input.bytes
      || snapshot.file.sha256 !== input.sha256
      || sizeOf(signature) !== entry.size
      || signature.mode !== entry.mode
      || file.controllerHash !== entry.hash
    ) {
      failObserved("changed", "A base snapshot input does not match the frozen manifests.");
    }
  }
  return tree;
}

function sizeOf(signature: FileSignature): number {
  return Number(signature.size);
}

interface StageObservation {
  readonly selection: NativeHarnessCompletionSelection;
  readonly tree: TreeObservation;
  readonly changes: readonly { readonly path: string; readonly kind: "add" | "modify"; readonly beforeHash?: string; readonly afterHash: string }[];
  readonly trace: TraceObservation;
}

function stageChanges(
  base: DeclaredBase,
  stageFiles: ReadonlyMap<string, ObservedTextFile>,
): Array<{ path: string; kind: "add" | "modify"; beforeHash?: string; afterHash: string }> {
  const paths = [...new Set([...base.entries.keys(), ...stageFiles.keys()])].sort(comparePaths);
  const changes: Array<{ path: string; kind: "add" | "modify"; beforeHash?: string; afterHash: string }> = [];
  for (const relativePath of paths) {
    const before = base.entries.get(relativePath);
    const after = stageFiles.get(relativePath);
    if (before !== undefined && after === undefined) {
      fail("unsupported", `Deletion is not supported by this capture profile: ${relativePath}`);
    }
    if (before === undefined && after !== undefined) {
      changes.push({ path: relativePath, kind: "add", afterHash: after.controllerHash });
      continue;
    }
    if (before === undefined || after === undefined) continue;
    if (before.mode !== after.signature.mode) {
      failObserved("unsupported", `A mode-only or content-plus-mode change is not supported: ${relativePath}`);
    }
    if (before.hash === after.controllerHash) continue;
    changes.push({
      path: relativePath,
      kind: "modify",
      beforeHash: before.hash,
      afterHash: after.controllerHash,
    });
  }
  return changes;
}

async function verifyStageRoots(
  ctx: Context,
  completion: NativeHarnessBackendCompletion,
): Promise<{ preparedRoot: string; storeRoot: string; runRoot: string; baseSnapshotId: string }> {
  const preparedRoot = trustedAbsolute(completion.prepared.preparedRoot, "prepared preparedRoot");
  const preparedIdentity = await observeRoot(ctx, preparedRoot, "prepared preparedRoot");
  const workspaceRoot = trustedAbsolute(completion.prepared.workspaceRoot, "prepared workspaceRoot");
  if (!isStrictlyContained(preparedRoot, workspaceRoot)) {
    fail("unsafe-path", "The prepared private workspace is not below the prepared root.");
  }
  await registerAncestry(ctx, preparedIdentity, workspaceRoot, "prepared workspaceRoot");
  if (completion.base.sourceRoot !== workspaceRoot) {
    fail("changed", "The base snapshot source root is not the prepared private workspace.");
  }
  await observeRoot(ctx, workspaceRoot, "prepared workspaceRoot");
  const storeRoot = trustedAbsolute(completion.prepared.storeRoot, "prepared storeRoot");
  if (!isStrictlyContained(preparedRoot, storeRoot)) fail("unsafe-path", "The store root is not below the prepared root.");
  await registerAncestry(ctx, preparedIdentity, storeRoot, "prepared storeRoot");
  const runRoot = path.join(storeRoot, "runs", completion.runId);
  return { preparedRoot, storeRoot, runRoot, baseSnapshotId: completion.base.snapshotId };
}

function selectionOrder(completion: NativeHarnessBackendCompletion): NativeHarnessCompletionSelection[] {
  const winner = completion.winner;
  if (winner === null || typeof winner !== "object") fail("source-unavailable", "The winner selection is not usable.");
  if (!Array.isArray(completion.ancestry) || completion.ancestry.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxStages) {
    fail("source-unavailable", "The completion ancestry is not bounded or usable.");
  }
  if (completion.ancestry.length + 1 > NATIVE_HARNESS_OUTPUT_LIMITS.maxStages) {
    fail("too-large", "The completion ancestry exceeds the supported stage bound.");
  }
  if (winner.candidate === "refine") {
    if (completion.ancestry.length < 1) fail("changed", "A refine winner has no frozen parent chain.");
  } else if (completion.ancestry.length !== 0) {
    fail("changed", "A non-refine winner has an unexpected frozen parent chain.");
  }
  const seen = new Set<string>([winner.candidate]);
  for (const stage of completion.ancestry) {
    if (typeof stage.candidate !== "string" || seen.has(stage.candidate)) {
      fail("changed", "The completion ancestry contains a duplicate or invalid candidate.");
    }
    seen.add(stage.candidate);
  }
  return [winner, ...completion.ancestry];
}

async function observeStages(
  ctx: Context,
  completion: NativeHarnessBackendCompletion,
  base: DeclaredBase,
  roots: { runRoot: string; baseSnapshotId: string; preparedRoot: string },
): Promise<StageObservation[]> {
  const selections = selectionOrder(completion);
  const preparedIdentity = ctx.directories.get(roots.preparedRoot);
  if (preparedIdentity === undefined) fail("io-failure", "The prepared root was not observed.");
  const observations: StageObservation[] = [];
  const tracePass: TracePass = { totalBytes: 0 };
  for (const selection of selections) {
    if (typeof selection.attempt !== "number" || !Number.isSafeInteger(selection.attempt) || selection.attempt < 1) {
      fail("source-unavailable", "A selected stage attempt is not usable.");
    }
    if (!hex64(selection.artifactHash) || !hex64(selection.traceHash)) {
      fail("source-unavailable", "A selected stage artifact or trace hash is not usable.");
    }
    const cwd = trustedAbsolute(selection.cwd, `${selection.candidate} cwd`);
    const artifactDir = trustedAbsolute(selection.artifactDir, `${selection.candidate} artifactDir`);
    const eventsPath = trustedAbsolute(selection.eventsPath, `${selection.candidate} eventsPath`);
    if (!isStrictlyContained(roots.runRoot, cwd) || !isStrictlyContained(roots.runRoot, artifactDir)) {
      fail("unsafe-path", "A selected stage path is outside the private run area.");
    }
    if (eventsPath !== path.join(artifactDir, "worker-events.jsonl")) {
      fail("changed", "A selected stage trace path is not the witnessed artifact trace.");
    }
    await registerAncestry(ctx, preparedIdentity, cwd, `${selection.candidate} cwd`);
    await registerAncestry(ctx, preparedIdentity, artifactDir, `${selection.candidate} artifactDir`);
    const stageIdentity = await observeRoot(ctx, cwd, `${selection.candidate} cwd`);
    await observeRoot(ctx, artifactDir, `${selection.candidate} artifactDir`);
    const expectedMarker = JSON.stringify({
      snapshotId: roots.baseSnapshotId,
      destination: stageIdentity.path,
    });
    const tree = await inventoryTree(ctx, {
      root: cwd,
      label: `${selection.candidate} stage`,
      stage: selection,
      allowMarker: true,
      expectedMarkerBytes: expectedMarker,
      maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageOrdinaryFiles,
      maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageFileBytes,
      maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageTotalBytes,
      readFiles: true,
    });
    if (tree.markerSignature === null) failObserved("missing", "The stage origin marker is missing.");
    if (!sameDirectoryIdentity(stageIdentity, tree.identity)) fail("changed", "A stage root changed during inventory.");
    const changes = stageChanges(base, tree.files);
    const manifestDigest = sha256Hex(JSON.stringify(changes));
    if (manifestDigest !== selection.artifactHash) {
      failObserved("changed", "A stage change manifest does not match its frozen artifact hash.");
    }
    const trace = await observeTrace(ctx, selection, artifactDir, eventsPath, tracePass);
    observations.push({ selection, tree, changes, trace });
  }
  return observations;
}

async function observeTrace(
  ctx: Context,
  selection: NativeHarnessCompletionSelection,
  artifactDir: string,
  eventsPath: string,
  pass: TracePass,
): Promise<TraceObservation> {
  const before = await lstatOrFail(ctx, eventsPath, `${selection.candidate} trace`);
  if (before.isSymbolicLink()) fail("unsafe-path", "A stage trace is a symbolic link.");
  if (!before.isFile()) fail("unsupported", "A stage trace is not a regular file.");
  const beforeSignature = signatureOf(before);
  assertOrdinaryMode(beforeSignature, `${selection.candidate} trace`);
  if (before.size > BigInt(NATIVE_HARNESS_OUTPUT_LIMITS.maxTraceBytes)) {
    fail("too-large", "A stage trace exceeds the per-trace byte bound.");
  }
  if (pass.totalBytes + Number(before.size) > NATIVE_HARNESS_OUTPUT_LIMITS.maxTraceTotalBytes) {
    fail("too-large", "The trace observation pass exceeds its total byte bound.");
  }
  await runCheckpoint(ctx, "before-trace-open", selection.candidate, path.basename(eventsPath), Number(before.size));
  let handle: NativeFileHandle | undefined;
  try {
    try {
      handle = await ctx.io.open(eventsPath, ctx.io.O_RDONLY | ctx.io.O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      if (error instanceof OutputError) throw error;
      if (isErrno(error, "ENOENT")) failObserved("missing", "A stage trace disappeared.");
      if (isErrno(error, "ELOOP")) fail("unsafe-path", "A stage trace is a symbolic link.");
      fail("io-failure", "A stage trace could not be opened.");
    }
    // The handle is inside this protected cleanup lifetime before the
    // post-open checkpoint is invoked.
    let opened: NativeFileStats;
    try {
      opened = await handle.stat({ bigint: true });
    } catch (error) {
      if (error instanceof OutputError) throw error;
      fail("io-failure", "A stage trace handle could not be inspected.");
    }
    if (!opened.isFile() || !sameFileSignature(beforeSignature, signatureOf(opened))) {
      failObserved("changed", "A stage trace changed before it was read.");
    }
    await runCheckpoint(ctx, "after-trace-open", selection.candidate, path.basename(eventsPath), Number(opened.size));
    const size = Number(opened.size);
    if (size > NATIVE_HARNESS_OUTPUT_LIMITS.maxTraceBytes) {
      fail("too-large", "A stage trace exceeds the per-trace byte bound.");
    }
    const buffer = new Uint8Array(NATIVE_HARNESS_OUTPUT_LIMITS.traceBufferBytes);
    const hash = createHash("sha256");
    let position = 0;
    while (position < size) {
      assertAuthority(ctx);
      const length = Math.min(buffer.length, size - position);
      let result;
      try {
        result = await handle.read(buffer, 0, length, position);
      } catch (error) {
        if (error instanceof OutputError) throw error;
        fail("io-failure", "A stage trace could not be read.");
      }
      if (result.bytesRead <= 0) failObserved("changed", "A stage trace ended before its observed size.");
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
      assertAuthority(ctx);
    }
    if (position !== size) failObserved("changed", "A stage trace did not read its observed size.");
    let after: NativeFileStats;
    try {
      after = await handle.stat({ bigint: true });
    } catch (error) {
      if (error instanceof OutputError) throw error;
      fail("io-failure", "A stage trace handle could not be rechecked.");
    }
    if (!sameFileSignature(signatureOf(opened), signatureOf(after))) {
      failObserved("changed", "A stage trace changed while it was being read.");
    }
    pass.totalBytes += size;
    await runCheckpoint(ctx, "after-trace-read", selection.candidate, path.basename(eventsPath), size);
    const finalizedAtPath = await lstatOrFail(ctx, eventsPath, `${selection.candidate} trace`);
    if (
      finalizedAtPath.isSymbolicLink()
      || !finalizedAtPath.isFile()
      || !sameFileSignature(signatureOf(opened), signatureOf(finalizedAtPath))
    ) {
      failObserved("changed", "A stage trace path changed after it was read.");
    }
    const artifactIdentity = ctx.directories.get(artifactDir);
    if (artifactIdentity === undefined) fail("io-failure", "The stage artifact directory was not observed.");
    const artifactNow = await lstatOrFail(ctx, artifactDir, `${selection.candidate} artifactDir`);
    if (
      artifactNow.isSymbolicLink()
      || !artifactNow.isDirectory()
      || !sameDirectoryIdentity(artifactIdentity, directoryIdentityOf(artifactDir, artifactNow))
    ) {
      fail("changed", "A stage artifact directory changed during capture.");
    }
    const digest = hash.digest("hex");
    if (digest !== selection.traceHash) {
      failObserved("changed", "A stage trace does not match its frozen trace hash.");
    }
    return {
      candidate: selection.candidate,
      attempt: selection.attempt,
      artifactDir,
      eventsPath,
      artifactIdentity,
      signature: beforeSignature,
      bytes: size,
      sha256: digest,
      observedAt: Date.now(),
    };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        ctx.closeError.value = true;
      }
    }
  }
}

async function recheckSources(
  ctx: Context,
  observations: Awaited<ReturnType<typeof observeSources>>,
): Promise<void> {
  for (const observation of observations) {
    const again = await observeTextFile(ctx, observation.root, observation.relativePath, null, true);
    if (
      again.snapshot.file.bytes !== observation.fact.bytes
      || again.snapshot.file.sha256 !== observation.fact.sha256
      || !sameFileSignature(observation.signature, again.signature)
    ) {
      failObserved("changed", "An original source file changed during capture.");
    }
  }
}

async function recheckTree(ctx: Context, tree: TreeObservation, options: Omit<TreeOptions, "readFiles">): Promise<void> {
  const again = await inventoryTree(ctx, { ...options, readFiles: false });
  if (!sameTree(tree, again)) {
    failObserved("changed", "A captured private tree changed during capture.");
  }
}

async function recheckTraceObservations(
  ctx: Context,
  stages: readonly StageObservation[],
): Promise<void> {
  const pass: TracePass = { totalBytes: 0 };
  for (const stage of stages) {
    const again = await observeTrace(ctx, stage.selection, stage.trace.artifactDir, stage.trace.eventsPath, pass);
    if (again.bytes !== stage.trace.bytes || again.sha256 !== stage.trace.sha256
      || !sameFileSignature(stage.trace.signature, again.signature)) {
      failObserved("changed", "A stage trace changed during capture.");
    }
  }
}

function captureDigest(
  completion: NativeHarnessBackendCompletion,
  changes: readonly NativeHarnessOutputRecord[],
  stages: readonly NativeHarnessOutputStageFact[],
): string {
  const changeFacts = [...changes]
    .map((record) => [
      record.path,
      record.kind,
      record.mode,
      record.snapshot.file.bytes,
      record.snapshot.file.sha256,
      record.controllerHash,
    ])
    .sort((left, right) => comparePaths(String(left[0]), String(right[0])));
  const stageFacts = [...stages]
    .map((stage) => [stage.candidate, stage.attempt, stage.trace.bytes, stage.trace.sha256])
    .sort((left, right) => {
      const byCandidate = comparePaths(String(left[0]), String(right[0]));
      return byCandidate !== 0 ? byCandidate : Number(left[1]) - Number(right[1]);
    });
  return sha256Hex(JSON.stringify([
    NATIVE_HARNESS_OUTPUT_SCHEMA,
    completion.completionId,
    completion.sourceId,
    completion.runId,
    completion.taskSha256,
    completion.base.snapshotId,
    completion.prepared.manifestSha256,
    completion.winner.candidate,
    completion.winner.attempt,
    completion.winner.artifactHash,
    changeFacts,
    stageFacts,
  ]));
}

function metadataBytes(capture: NativeHarnessOutputCapture): number {
  const projection = {
    schema: capture.schema,
    captureId: capture.captureId,
    originKind: capture.originKind,
    completionId: capture.completionId,
    sourceId: capture.sourceId,
    runId: capture.runId,
    taskSha256: capture.taskSha256,
    baseSnapshotId: capture.baseSnapshotId,
    manifestSha256: capture.manifestSha256,
    winner: capture.winner,
    changes: capture.changes.map((record) => ({
      path: record.path,
      kind: record.kind,
      mode: record.mode,
      controllerHash: record.controllerHash,
      file: record.snapshot.file,
    })),
    sources: capture.sources,
    baseInputs: capture.baseInputs,
    stages: capture.stages,
    digest: capture.digest,
    observedAt: capture.observedAt,
    taskAccepted: capture.taskAccepted,
    semanticAcceptance: capture.semanticAcceptance,
    limitations: capture.limitations,
  };
  return Buffer.byteLength(JSON.stringify(projection), "utf8");
}

function buildCapture(
  completion: NativeHarnessBackendCompletion,
  sources: readonly NativeHarnessOutputSourceFact[],
  baseInputs: readonly NativeHarnessOutputBaseFact[],
  stages: readonly StageObservation[],
): NativeHarnessOutputCapture {
  const winner = stages.find((stage) => stage.selection.candidate === completion.winner.candidate);
  if (winner === undefined) fail("changed", "The winner stage was not observed.");
  if (winner.changes.length === 0) fail("no-output-changes", "The winner stage has no supported regular-file changes.");
  if (winner.changes.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxOutputFiles) {
    fail("too-large", "The winner change set exceeds the output file bound.");
  }
  let totalTextBytes = 0;
  const changes: NativeHarnessOutputRecord[] = [];
  for (const change of winner.changes) {
    const file = winner.tree.files.get(change.path);
    if (file === undefined) fail("changed", "An output change has no observed stage file.");
    if (change.kind === "modify" && change.beforeHash === undefined) {
      fail("changed", "A modify record has no before hash.");
    }
    if (file.snapshot.file.bytes > NATIVE_HARNESS_OUTPUT_LIMITS.maxOutputFileBytes) {
      fail("too-large", "An output file exceeds the supported per-file bound.");
    }
    totalTextBytes += file.snapshot.file.bytes;
    if (totalTextBytes > NATIVE_HARNESS_OUTPUT_LIMITS.maxOutputTotalBytes) {
      fail("too-large", "The output text exceeds the supported total byte bound.");
    }
    changes.push({
      path: change.path,
      kind: change.kind,
      mode: file.signature.mode,
      controllerHash: file.controllerHash,
      snapshot: file.snapshot,
    });
  }
  changes.sort((left, right) => comparePaths(left.path, right.path));

  const stageFacts: NativeHarnessOutputStageFact[] = [...stages]
    .map((stage) => ({
      candidate: stage.selection.candidate,
      attempt: stage.selection.attempt,
      artifactHash: stage.selection.artifactHash,
      changeManifestSha256: sha256Hex(JSON.stringify(stage.changes)),
      changeCount: stage.changes.length,
      ordinaryFileCount: stage.tree.fileCount,
      directoryCount: stage.tree.directoryCount,
      trace: {
        bytes: stage.trace.bytes,
        sha256: stage.trace.sha256,
        observedAt: stage.trace.observedAt,
      },
    }))
    .sort((left, right) => comparePaths(left.candidate, right.candidate));

  for (const stage of stageFacts) {
    if (stage.changeManifestSha256 !== stage.artifactHash) {
      failObserved("changed", "A stage change manifest changed before capture issue.");
    }
  }

  const capture: NativeHarnessOutputCapture = {
    schema: NATIVE_HARNESS_OUTPUT_SCHEMA,
    captureId: randomUUID(),
    originKind: NATIVE_HARNESS_OUTPUT_ORIGIN,
    completionId: completion.completionId,
    sourceId: completion.sourceId,
    runId: completion.runId,
    taskSha256: completion.taskSha256,
    baseSnapshotId: completion.base.snapshotId,
    manifestSha256: completion.prepared.manifestSha256,
    winner: {
      candidate: completion.winner.candidate,
      attempt: completion.winner.attempt,
      artifactHash: completion.winner.artifactHash,
      traceHash: completion.winner.traceHash,
    },
    changes,
    sources: [...sources],
    baseInputs: [...baseInputs],
    stages: stageFacts,
    digest: captureDigest(completion, changes, stageFacts),
    observedAt: Date.now(),
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    limitations: LIMITATIONS,
  };
  deepFreeze(capture);
  const bytes = metadataBytes(capture);
  if (bytes > NATIVE_HARNESS_OUTPUT_LIMITS.maxMetadataBytes) {
    fail("too-large", "The retained capture metadata exceeds its byte bound.");
  }
  return capture;
}

function validateControls(guard: unknown, signal: unknown, testPorts: unknown): {
  guard: () => void;
  signal: AbortSignal;
  checkpoint: ((event: NativeHarnessOutputCheckpoint) => void | Promise<void>) | null;
} {
  if (typeof guard !== "function") {
    fail("invalid-control", "The trusted guard must be a synchronous function.");
  }
  if (typeof AbortSignal === "undefined") {
    fail("invalid-control", "An actual AbortSignal is required.");
  }
  readActualAborted(signal);
  let checkpoint: ((event: NativeHarnessOutputCheckpoint) => void | Promise<void>) | null = null;
  if (testPorts !== undefined) {
    if (typeof testPorts !== "object" || testPorts === null || Array.isArray(testPorts)) {
      fail("invalid-control", "Test ports must be a plain object when supplied.");
    }
    const candidate = (testPorts as { readonly checkpoint?: unknown }).checkpoint;
    if (candidate !== undefined) {
      if (typeof candidate !== "function") {
        fail("invalid-control", "The test checkpoint must be a function when supplied.");
      }
      checkpoint = candidate as (event: NativeHarnessOutputCheckpoint) => void | Promise<void>;
    }
  }
  return { guard: guard as () => void, signal: signal as AbortSignal, checkpoint };
}

/**
 * Captures the complete supported regular-file change set of one actual issued
 * completion. One invocation yields either one immutable capture or a bounded
 * failure. It has no replay, cache or poison registry and retains no partial
 * payload. Independent concurrent calls are not coordinated by this leaf.
 */
export async function captureNativeHarnessOutput(
  backend: unknown,
  guard: () => void,
  signal: AbortSignal,
  testPorts?: NativeHarnessOutputTestPorts,
): Promise<NativeHarnessOutputCaptureResult> {
  const startedAt = performance.now();
  const controlFailure: { value: OutputError | null } = { value: null };
  try {
    const controls = validateControls(guard, signal, testPorts);
    const closeError = { value: false };
    const baseContext = {
      guard: controls.guard,
      signal: controls.signal,
      checkpoint: controls.checkpoint,
      startedAt,
      directories: new Map<string, DirectoryIdentity>(),
      closeError,
      controlFailure,
    };
    if (readActualAborted(baseContext.signal)) fail("aborted", "The capture signal was already aborted.");
    const ctx: Context = { ...baseContext, io: createGuardedIo(baseContext) };
    assertAuthority(ctx);

    const read = readNativeHarnessBackendCompletion(backend);
    if (!read.ok) fail("source-unavailable", read.reason);
    const completion = read.completion;
    if (completion.schema !== COMPLETION_SCHEMA || completion.origin !== NATIVE_HARNESS_OUTPUT_ORIGIN) {
      fail("source-unavailable", "The issued completion has an unexpected schema or origin.");
    }
    if (
      completion.taskAccepted !== false
      || completion.semanticAcceptance !== "not-evaluated"
      || typeof completion.completionId !== "string"
      || completion.completionId.length < 1
      || completion.completionId.length > 256
      || typeof completion.runId !== "string"
      || completion.runId.length < 1
      || completion.runId.length > 256
      || !hex64(completion.taskSha256)
      || typeof completion.base.snapshotId !== "string"
      || completion.base.snapshotId.length < 1
      || completion.base.snapshotId.length > 256
      || !hex64(completion.prepared.manifestSha256)
    ) {
      fail("source-unavailable", "The issued completion identity fields are not usable.");
    }

    const declared = declareBase(completion);
    verifyInputManifestDigest(completion);
    const roots = await verifyStageRoots(ctx, completion);

    const sourceObservations = await observeSources(ctx, completion, declared);
    const baseTree = await observeBase(ctx, completion, declared);
    const stages = await observeStages(ctx, completion, declared, roots);

    const sourceFacts = sourceObservations.map((observation) => observation.fact);
    const baseFacts: NativeHarnessOutputBaseFact[] = [...baseTree.files.values()]
      .sort((left, right) => comparePaths(left.relativePath, right.relativePath))
      .map((file) => ({
        relativePath: file.relativePath,
        bytes: file.snapshot.file.bytes,
        sha256: file.snapshot.file.sha256,
        mode: file.signature.mode,
        controllerHash: file.controllerHash,
        observedAt: file.snapshot.file.observedAt,
      }));

    await runCheckpoint(ctx, "before-final-recheck", null, null, null);
    await recheckSources(ctx, sourceObservations);
    await recheckTree(ctx, baseTree, {
      root: baseTree.root,
      label: "base snapshot",
      stage: null,
      allowMarker: false,
      expectedMarkerBytes: null,
      maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs,
      maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
      maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    });
    for (const stage of stages) {
      const expectedMarker = JSON.stringify({
        snapshotId: completion.base.snapshotId,
        destination: stage.tree.identity.path,
      });
      await recheckTree(ctx, stage.tree, {
        root: stage.tree.root,
        label: `${stage.selection.candidate} stage`,
        stage: stage.selection,
        allowMarker: true,
        expectedMarkerBytes: expectedMarker,
        maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageOrdinaryFiles,
        maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageFileBytes,
        maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageTotalBytes,
      });
    }
    await recheckTraceObservations(ctx, stages);
    for (const [directoryPath, identity] of ctx.directories) {
      const info = await lstatOrFail(ctx, directoryPath, "trusted directory");
      if (
        info.isSymbolicLink()
        || !info.isDirectory()
        || info.dev !== identity.dev
        || info.ino !== identity.ino
      ) {
        fail("changed", "A trusted directory identity changed during capture.");
      }
    }

    const capture = buildCapture(completion, sourceFacts, baseFacts, stages);
    if (!Object.isFrozen(capture) || !Object.isFrozen(capture.changes)) {
      fail("io-failure", "The capture draft was not frozen before issue.");
    }
    await runCheckpoint(ctx, "before-issue", null, null, null);

    // Final external authority checks, in order: the trusted guard runs
    // first; the genuine native signal getter and a fresh monotonic clock
    // observation follow; then only pure object/completion checks and the
    // synchronous WeakMap linkage before issuance. No await or filesystem
    // read follows the final guard.
    assertLastGuard(ctx);
    if (readActualAborted(ctx.signal)) fail("aborted", "The capture signal was aborted before issue.");
    if (performance.now() - ctx.startedAt > NATIVE_HARNESS_OUTPUT_LIMITS.elapsedBudgetMs) {
      fail("deadline", "The cooperative capture elapsed budget was exceeded before issue.");
    }
    if (!matchesNativeHarnessBackendCompletion(backend, completion)) {
      fail("authority-lost", "The issued completion is no longer associated with this backend.");
    }
    if (ctx.closeError.value) {
      fail("io-failure", "A guarded file handle reported a close failure.");
    }
    issuedOutputCaptures.set(capture, { backend, completion });
    return { ok: true, capture };
  } catch (error) {
    if (controlFailure.value !== null) {
      const failure = issuedFailures.get(controlFailure.value);
      if (failure !== undefined) {
        return failureResult(failure);
      }
    }
    if (typeof error === "object" && error !== null) {
      const failure = issuedFailures.get(error as OutputError);
      if (failure !== undefined) {
        return failureResult(failure);
      }
    }
    const nativeCode = readOwnString(error, "code");
    if (nativeCode !== null && NATIVE_FILE_FAILURE_CODES.has(nativeCode)) {
      const code: NativeHarnessOutputFailure = nativeCode === "invalid-path" ? "unsafe-path"
        : nativeCode === "non-text" ? "unsupported"
        : nativeCode as NativeHarnessOutputFailure;
      const reason = readOwnString(error, "message") ?? "A native file observation was refused.";
      return { ok: false, code, reason: boundedReason(reason) };
    }
    if (isErrno(error, "ENOENT")) {
      return { ok: false, code: "missing", reason: "A trusted path disappeared during capture." };
    }
    if (isErrno(error, "ELOOP")) {
      return { ok: false, code: "unsafe-path", reason: "A trusted path is a symbolic link." };
    }
    return { ok: false, code: "io-failure", reason: "The capture failed without a serializable host error." };
  }
}

function assertLastGuard(ctx: Context): void {
  let result: unknown;
  try {
    result = ctx.guard();
  } catch {
    fail("authority-lost", "The trusted guard refused the final capture commit.");
  }
  rejectControlResult(result, "The trusted guard");
}

/**
 * True only for the exact capture object issued by this module for the same
 * exact backend and completion objects, while that completion association is
 * still unconflicted. This matcher performs no I/O, callback, freshness or
 * current-work inference.
 */
export function matchesNativeHarnessOutputCapture(backend: unknown, capture: unknown): boolean {
  if (typeof backend !== "object" || backend === null) return false;
  if (typeof capture !== "object" || capture === null) return false;
  const issued = issuedOutputCaptures.get(capture as NativeHarnessOutputCapture);
  if (issued === undefined) return false;
  if (issued.backend !== backend) return false;
  return matchesNativeHarnessBackendCompletion(backend, issued.completion);
}

const SAME_ISSUED_VERSION: NativeHarnessOutputVersionComparison = Object.freeze({
  ok: true as const,
  sameVersion: true as const,
});

function invalidBinding(section: NativeHarnessOutputVersionSection): NativeHarnessOutputVersionComparison {
  return Object.freeze({ ok: false as const, code: "invalid-binding" as const, section });
}

function versionMismatch(section: NativeHarnessOutputVersionSection): NativeHarnessOutputVersionComparison {
  return Object.freeze({ ok: false as const, code: "version-mismatch" as const, section });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasIssuedCaptureShape(value: NativeHarnessOutputCapture): boolean {
  return value.schema === NATIVE_HARNESS_OUTPUT_SCHEMA
    && value.originKind === NATIVE_HARNESS_OUTPUT_ORIGIN
    && isRecord(value.winner)
    && Array.isArray(value.changes)
    && Array.isArray(value.sources)
    && Array.isArray(value.baseInputs)
    && Array.isArray(value.stages);
}

/**
 * Compares two captures that this module genuinely issued for the same exact
 * backend and original completion object. Authentication happens before any
 * capture field is read. The result is a fixed section label only; this
 * performs no I/O, callback, clock, coercion, deep copy or freshness check and
 * deliberately ignores capture IDs, file-snapshot IDs and observation
 * timestamps. Equality of two historical observations does not establish when
 * the second was obtained, later stability, current native work or acceptance.
 */
export function compareNativeHarnessOutputVersion(
  backend: unknown,
  original: unknown,
  reread: unknown,
): NativeHarnessOutputVersionComparison {
  if (typeof backend !== "object" || backend === null) return invalidBinding("binding");
  if (typeof original !== "object" || original === null) return invalidBinding("binding");
  if (typeof reread !== "object" || reread === null) return invalidBinding("binding");
  const originalEntry = issuedOutputCaptures.get(original as NativeHarnessOutputCapture);
  const rereadEntry = issuedOutputCaptures.get(reread as NativeHarnessOutputCapture);
  if (originalEntry === undefined || rereadEntry === undefined) return invalidBinding("binding");
  if (original === reread) return invalidBinding("binding");
  if (originalEntry.backend !== backend || rereadEntry.backend !== backend) return invalidBinding("binding");
  if (originalEntry.completion !== rereadEntry.completion) return invalidBinding("binding");
  if (!matchesNativeHarnessBackendCompletion(backend, originalEntry.completion)) {
    return invalidBinding("binding");
  }

  const left = original as NativeHarnessOutputCapture;
  const right = reread as NativeHarnessOutputCapture;
  if (!hasIssuedCaptureShape(left) || !hasIssuedCaptureShape(right)) return invalidBinding("binding");

  if (
    left.schema !== right.schema
    || left.originKind !== right.originKind
    || left.completionId !== right.completionId
    || left.sourceId !== right.sourceId
    || left.runId !== right.runId
    || left.taskSha256 !== right.taskSha256
    || left.baseSnapshotId !== right.baseSnapshotId
    || left.manifestSha256 !== right.manifestSha256
  ) {
    return versionMismatch("identity");
  }

  const leftWinner = left.winner;
  const rightWinner = right.winner;
  if (!isRecord(leftWinner) || !isRecord(rightWinner)) return invalidBinding("winner");
  if (
    leftWinner.candidate !== rightWinner.candidate
    || leftWinner.attempt !== rightWinner.attempt
    || leftWinner.artifactHash !== rightWinner.artifactHash
    || leftWinner.traceHash !== rightWinner.traceHash
  ) {
    return versionMismatch("winner");
  }

  if (left.changes.length !== right.changes.length) return versionMismatch("changes");
  for (let index = 0; index < left.changes.length; index += 1) {
    const leftChange = left.changes[index];
    const rightChange = right.changes[index];
    if (
      leftChange === undefined
      || rightChange === undefined
      || !isRecord(leftChange.snapshot)
      || !isRecord(rightChange.snapshot)
      || !isRecord(leftChange.snapshot.file)
      || !isRecord(rightChange.snapshot.file)
    ) {
      return invalidBinding("changes");
    }
    if (
      leftChange.path !== rightChange.path
      || leftChange.kind !== rightChange.kind
      || leftChange.mode !== rightChange.mode
      || leftChange.controllerHash !== rightChange.controllerHash
      || leftChange.snapshot.file.relativePath !== rightChange.snapshot.file.relativePath
      || leftChange.snapshot.file.bytes !== rightChange.snapshot.file.bytes
      || leftChange.snapshot.file.sha256 !== rightChange.snapshot.file.sha256
      || leftChange.snapshot.text !== rightChange.snapshot.text
    ) {
      return versionMismatch("changes");
    }
  }

  if (left.sources.length !== right.sources.length) return versionMismatch("sources");
  for (let index = 0; index < left.sources.length; index += 1) {
    const leftSource = left.sources[index];
    const rightSource = right.sources[index];
    if (leftSource === undefined || rightSource === undefined || !isRecord(leftSource) || !isRecord(rightSource)) {
      return invalidBinding("sources");
    }
    if (
      leftSource.relativePath !== rightSource.relativePath
      || leftSource.bytes !== rightSource.bytes
      || leftSource.sha256 !== rightSource.sha256
    ) {
      return versionMismatch("sources");
    }
  }

  if (left.baseInputs.length !== right.baseInputs.length) return versionMismatch("base");
  for (let index = 0; index < left.baseInputs.length; index += 1) {
    const leftBase = left.baseInputs[index];
    const rightBase = right.baseInputs[index];
    if (leftBase === undefined || rightBase === undefined || !isRecord(leftBase) || !isRecord(rightBase)) {
      return invalidBinding("base");
    }
    if (
      leftBase.relativePath !== rightBase.relativePath
      || leftBase.bytes !== rightBase.bytes
      || leftBase.sha256 !== rightBase.sha256
      || leftBase.mode !== rightBase.mode
      || leftBase.controllerHash !== rightBase.controllerHash
    ) {
      return versionMismatch("base");
    }
  }

  if (left.stages.length !== right.stages.length) return versionMismatch("stages");
  for (let index = 0; index < left.stages.length; index += 1) {
    const leftStage = left.stages[index];
    const rightStage = right.stages[index];
    if (
      leftStage === undefined
      || rightStage === undefined
      || !isRecord(leftStage)
      || !isRecord(rightStage)
      || !isRecord(leftStage.trace)
      || !isRecord(rightStage.trace)
    ) {
      return invalidBinding("stages");
    }
    if (
      leftStage.candidate !== rightStage.candidate
      || leftStage.attempt !== rightStage.attempt
      || leftStage.artifactHash !== rightStage.artifactHash
      || leftStage.changeManifestSha256 !== rightStage.changeManifestSha256
      || leftStage.changeCount !== rightStage.changeCount
      || leftStage.ordinaryFileCount !== rightStage.ordinaryFileCount
      || leftStage.directoryCount !== rightStage.directoryCount
      || leftStage.trace.bytes !== rightStage.trace.bytes
      || leftStage.trace.sha256 !== rightStage.trace.sha256
    ) {
      return versionMismatch("stages");
    }
  }

  if (left.digest !== right.digest) return versionMismatch("digest");

  // Repeat the pure binding check after comparison: no capture field is read
  // through an unauthenticated object and no await can interleave here.
  if (
    issuedOutputCaptures.get(original as NativeHarnessOutputCapture) !== originalEntry
    || issuedOutputCaptures.get(reread as NativeHarnessOutputCapture) !== rereadEntry
    || originalEntry.backend !== backend
    || rereadEntry.backend !== backend
    || originalEntry.completion !== rereadEntry.completion
    || !matchesNativeHarnessBackendCompletion(backend, originalEntry.completion)
  ) {
    return invalidBinding("binding");
  }
  return SAME_ISSUED_VERSION;
}
