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
  NATIVE_HARNESS_COMPLETION_SOLVER_IDS,
  copyWitnessBase,
  type NativeHarnessBackendCompletion,
  type NativeHarnessCompletionSelection,
} from "./native-harness-completion.ts";
import { NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES } from "./native-harness-recovery-source.ts";
import { STAGE_IDS } from "../vendor/harness2/upstream/src/types.ts";
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
import {
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_CAPTURES,
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILES,
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILE_BYTES,
  NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES,
  NATIVE_HARNESS_INITIAL_INPUTS_PLAN_SCHEMA,
  NATIVE_HARNESS_INITIAL_INPUTS_PREPARED_MODE,
  type NativeHarnessInitialInputsPlan,
  type NativeHarnessReconciliationContentPlan,
} from "./native-harness-reconciliation-content.ts";

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

export type NativeHarnessContentControlReason =
  | "aborted"
  | "deadline-expired"
  | "control-unavailable";

/**
 * Fixed-mode control translation used only by the host reconciliation content
 * mode. It is not an issued output failure and cannot be supplied by an
 * arbitrary caller as success/authority. The same OutputError plumbing keeps
 * abort/deadline primary even when a bounded reader normalizes early I/O
 * errors.
 */
export function createNativeHarnessContentControlFailure(
  reason: NativeHarnessContentControlReason,
): Error {
  const code: NativeHarnessOutputFailure = reason === "aborted"
    ? "aborted"
    : reason === "deadline-expired" ? "deadline" : "io-failure";
  const error = new OutputError(code, reason);
  issuedFailures.set(error, { code, reason });
  return error;
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
  /** Initial-prepared mode only: pinned top-level `.git`, contents never walked. */
  readonly excludedDirectory: {
    readonly path: string;
    readonly identity: DirectoryIdentity;
  } | null;
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
  /** Fixed content mode only: charge validated observed size before read. */
  readonly charge?: (bytes: number) => void;
}

interface TraceExpectation {
  readonly candidate: string;
  readonly attempt: number;
  readonly traceHash: string;
}

interface AuthorityContext {
  readonly guard: () => void;
  readonly signal: AbortSignal;
  readonly startedAt: number;
  /** Fixed host reconciliation mode only; never set by issued capture. */
  readonly contentControl?: boolean;
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
  } catch (error) {
    // Only the fixed host reconciliation mode can translate its own live
    // guard/deadline failure; issued capture keeps the exact authority-lost
    // semantics for every thrown guard value.
    if (
      ctx.contentControl === true
      && error instanceof OutputError
      && (error.code === "aborted" || error.code === "deadline" || error.code === "io-failure")
    ) {
      throw error;
    }
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

function createGuardedIo(ctx: Omit<Context, "io">, baseIo: NativeFileIo = nodeFileIo): NativeFileIo {
  return {
    O_RDONLY: baseIo.O_RDONLY,
    O_NOFOLLOW: baseIo.O_NOFOLLOW,
    async realpath(target: string): Promise<string> {
      guardedAuthority(ctx);
      const resolved = await baseIo.realpath(target);
      guardedAuthority(ctx);
      return resolved;
    },
    async lstat(target: string, options: { bigint: true }): Promise<NativeFileStats> {
      guardedAuthority(ctx);
      const info = await baseIo.lstat(target, options);
      guardedAuthority(ctx);
      return info;
    },
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      guardedAuthority(ctx);
      // O_NONBLOCK makes a FIFO/device swap between the caller's lstat and this
      // open return immediately instead of blocking a cooperative guard. The
      // opened handle is re-inspected before any read.
      const handle = await baseIo.open(target, flags | O_NONBLOCK);
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
  readonly stage: { readonly candidate: string } | null;
  readonly allowMarker: boolean;
  readonly expectedMarkerBytes: string | null;
  readonly maxOrdinaryFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly readFiles: boolean;
  /** Fixed content mode only: charge validated observed size before read. */
  readonly charge?: (bytes: number) => void;
  /**
   * Private initial-prepared mode: exactly the top-level `.git` directory is
   * recorded as an excluded boundary and never walked. Ordinary files must be
   * mode 0600. No other call site sets this.
   */
  readonly initialPrepared?: boolean;
  /** Counts one actual ordinary-file capture start before the reader. */
  readonly onFileCapture?: () => void;
}

interface ContentReadAccounting {
  readonly charge: (bytes: number) => void;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number | null;
  /** Actual opened sizes committed so far for this one tree/pass. */
  totalBytes: number;
}

/**
 * Reserves the pre-read lstat size, then binds any larger actual opened size
 * before allocation/read. A smaller opened size is not refunded. Per-file and
 * per-tree/per-marker limits are evaluated on this same actual opened-size
 * frontier, so earlier disconnected directory lstat totals cannot authorize an
 * over-cap read. This is fixed content mode only.
 */
function createContentSizeChargingIo(
  base: NativeFileIo,
  accounting: ContentReadAccounting,
  reservedBytes: number,
): NativeFileIo {
  let reserved = reservedBytes;
  return {
    O_RDONLY: base.O_RDONLY,
    O_NOFOLLOW: base.O_NOFOLLOW,
    realpath: (target) => base.realpath(target),
    lstat: (target, options) => base.lstat(target, options),
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      const handle = await base.open(target, flags);
      let openedSizeCharged = false;
      return {
        async stat(options: { bigint: true }): Promise<NativeFileStats> {
          const info = await handle.stat(options);
          if (!openedSizeCharged) {
            openedSizeCharged = true;
            const actual = Number(info.size);
            if (!Number.isSafeInteger(actual) || actual < 0) {
              fail("io-failure", "An opened content size was not a bounded integer.");
            }
            const delta = actual > reserved ? actual - reserved : 0;
            if (delta > 0) accounting.charge(delta);
            if (actual > accounting.maxFileBytes) {
              fail("too-large", "An opened content file exceeds its fixed per-file byte bound.");
            }
            if (accounting.maxTotalBytes !== null) {
              const nextTotal = accounting.totalBytes + actual;
              if (nextTotal > accounting.maxTotalBytes) {
                fail("too-large", "Opened content files exceed their fixed aggregate byte bound.");
              }
              accounting.totalBytes = nextTotal;
            }
            reserved = actual;
          }
          return info;
        },
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
}

async function observeTextFile(
  ctx: Context,
  root: string,
  relativePath: string,
  stage: string | null,
  read: boolean,
  accounting?: ContentReadAccounting,
): Promise<ObservedTextFile> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const before = await lstatOrFail(ctx, absolute, `file ${relativePath}`);
  if (before.isSymbolicLink()) failObserved("unsafe-path", `Symbolic links are not supported: ${relativePath}`);
  if (!before.isFile()) failObserved("unsupported", `A special file is not supported: ${relativePath}`);
  const beforeSignature = signatureOf(before);
  assertOrdinaryMode(beforeSignature, relativePath);
  // Reserve the validated observed size before any allocation or read,
  // including a later per-file refusal. There is no refund or hidden retry.
  accounting?.charge(Number(before.size));
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
    snapshot = await captureWorkspaceText(
      root,
      relativePath,
      accounting === undefined
        ? ctx.io
        : createContentSizeChargingIo(ctx.io, accounting, Number(before.size)),
      Date.now(),
    );
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
  let excludedDirectory: TreeObservation["excludedDirectory"] = null;
  let directoryCount = 1;
  let fileCount = 0;
  let totalFileBytes = 0;
  let markerCount = 0;
  const contentAccounting: ContentReadAccounting | null = options.charge === undefined
    ? null
    : {
      charge: options.charge,
      maxFileBytes: options.maxFileBytes,
      maxTotalBytes: options.maxTotalBytes,
      totalBytes: 0,
    };

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

      if (options.initialPrepared === true && relativeDirectory === "" && name === ".git") {
        if (!info.isDirectory()) {
          failObserved("unsupported", "The prepared workspace .git path is not a real directory.");
        }
        const excludedIdentity = await observeRoot(ctx, absolute, "prepared workspace .git");
        directoryCount += 1;
        if (directoryCount > NATIVE_HARNESS_OUTPUT_LIMITS.maxDirectories) {
          fail("too-large", "A trusted tree exceeds the directory bound.");
        }
        entries.push({ relativePath: ".git", kind: "directory", signature });
        excludedDirectory = Object.freeze({ path: absolute, identity: excludedIdentity });
        continue;
      }

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
      if (
        options.initialPrepared === true
        && (signature.rawMode & 0o7777n) !== BigInt(NATIVE_HARNESS_INITIAL_INPUTS_PREPARED_MODE)
      ) {
        fail("unsupported", `The prepared input file mode is not exactly 0600: ${relativePath}`);
      }

      const markerName = name.toLowerCase() === ORIGIN_MARKER;
      if (markerName) {
        if (!options.allowMarker || relativeDirectory !== "" || name !== ORIGIN_MARKER || options.expectedMarkerBytes === null) {
          fail("unsupported", `An unexpected origin marker is not supported: ${relativePath}`);
        }
        if ((signature.rawMode & 0o7777n) !== 0o600n) {
          fail("unsupported", "The origin marker mode is not exactly 0600.");
        }
        options.charge?.(Number(signature.size));
        if (signature.size > BigInt(NATIVE_HARNESS_OUTPUT_LIMITS.maxMarkerBytes)) {
          fail("too-large", "The origin marker exceeds its byte bound.");
        }
        if (options.readFiles) {
          await runCheckpoint(ctx, "before-text-read", options.stage?.candidate ?? null, relativePath, Number(signature.size));
          let snapshot: NativeWorkspaceTextSnapshot;
          try {
            snapshot = await captureWorkspaceText(
              options.root,
              relativePath,
              options.charge === undefined
                ? ctx.io
                : createContentSizeChargingIo(
                  ctx.io,
                  {
                    charge: options.charge,
                    maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxMarkerBytes,
                    maxTotalBytes: null,
                    totalBytes: 0,
                  },
                  Number(signature.size),
                ),
              Date.now(),
            );
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
        // Refused before the reader; retain the validated observation charge.
        options.charge?.(Number(info.size));
        fail("too-large", `A file exceeds the supported per-file bound: ${bounded}`);
      }
      if (contentAccounting === null) {
        totalFileBytes += Number(info.size);
        if (totalFileBytes > options.maxTotalBytes) {
          options.charge?.(Number(info.size));
          fail("too-large", "A trusted tree exceeds the ordinary-file byte bound.");
        }
      }
      entries.push({ relativePath: bounded, kind: "file", signature });
      if (options.readFiles) {
        options.onFileCapture?.();
        // The reader reserves its own pre-read lstat size and binds any larger
        // actual opened size to the charge, per-file cap and aggregate cap
        // before allocation/read.
        const observed = await observeTextFile(
          ctx,
          options.root,
          bounded,
          options.stage?.candidate ?? null,
          true,
          contentAccounting ?? undefined,
        );
        files.set(bounded, observed);
      }
    }
  };

  await walk("", 0);
  if (options.initialPrepared === true && excludedDirectory === null) {
    failObserved("missing", "The prepared workspace top-level .git directory is missing.");
  }
  return {
    root: options.root,
    identity,
    entries,
    files,
    markerSignature,
    excludedDirectory,
    fileCount,
    directoryCount,
    totalFileBytes: contentAccounting?.totalBytes ?? totalFileBytes,
  };
}

function sameTree(left: TreeObservation, right: TreeObservation): boolean {
  if (!sameDirectoryIdentity(left.identity, right.identity)) return false;
  if (left.entries.length !== right.entries.length) return false;
  if (left.fileCount !== right.fileCount || left.directoryCount !== right.directoryCount) return false;
  if (left.totalFileBytes !== right.totalFileBytes) return false;
  if ((left.markerSignature === null) !== (right.markerSignature === null)) return false;
  if (left.markerSignature !== null && right.markerSignature !== null
    && !sameFileSignature(left.markerSignature, right.markerSignature)) return false;
  if ((left.excludedDirectory === null) !== (right.excludedDirectory === null)) return false;
  if (left.excludedDirectory !== null && right.excludedDirectory !== null) {
    if (left.excludedDirectory.path !== right.excludedDirectory.path) return false;
    if (!sameDirectoryIdentity(left.excludedDirectory.identity, right.excludedDirectory.identity)) return false;
  }
  for (let index = 0; index < left.entries.length; index += 1) {
    const before = left.entries[index]!;
    const after = right.entries[index]!;
    if (before.relativePath !== after.relativePath || before.kind !== after.kind) return false;
    if (!sameFileSignature(before.signature, after.signature)) return false;
  }
  return true;
}

/**
 * Fixed content mode requires a second FULL byte pass. The stat-only
 * `sameTree` comparison above is not sufficient: compare the complete path set,
 * signatures, plain bytes/digests and mode-aware Controller hashes again.
 */
function sameContentTree(left: TreeObservation, right: TreeObservation): boolean {
  if (!sameTree(left, right)) return false;
  if (left.files.size !== right.files.size) return false;
  for (const [relativePath, before] of left.files) {
    const after = right.files.get(relativePath);
    if (after === undefined) return false;
    if (
      before.relativePath !== after.relativePath
      || before.controllerHash !== after.controllerHash
      || before.snapshot.file.relativePath !== after.snapshot.file.relativePath
      || before.snapshot.file.bytes !== after.snapshot.file.bytes
      || before.snapshot.file.sha256 !== after.snapshot.file.sha256
      || !sameFileSignature(before.signature, after.signature)
    ) {
      return false;
    }
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
  selection: TraceExpectation,
  artifactDir: string,
  eventsPath: string,
  pass: TracePass,
): Promise<TraceObservation> {
  const before = await lstatOrFail(ctx, eventsPath, `${selection.candidate} trace`);
  if (before.isSymbolicLink()) fail("unsafe-path", "A stage trace is a symbolic link.");
  if (!before.isFile()) fail("unsupported", "A stage trace is not a regular file.");
  const beforeSignature = signatureOf(before);
  assertOrdinaryMode(beforeSignature, `${selection.candidate} trace`);
  // Charge the validated observed size before any allocation/open/read. A
  // later per-trace or per-pass refusal retains this charge.
  pass.charge?.(Number(before.size));
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

/**
 * Fixed ceiling for actual source/base/solver/tree/trace bytes read by the two
 * content passes. It is derived from the same fixed output limits; B2b's
 * primary document charge remains separate.
 */
const CONTENT_CHARGE_LIMIT_BYTES =
  2 * (
    2 * NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes
    + 8 * NATIVE_HARNESS_OUTPUT_LIMITS.maxStageTotalBytes
    + 8 * NATIVE_HARNESS_OUTPUT_LIMITS.maxMarkerBytes
  )
  + 2 * NATIVE_HARNESS_OUTPUT_LIMITS.maxTraceTotalBytes;
const MAX_CONTENT_STAGES = 15;
const MAX_CONTENT_SOLVERS = 8;
const SNAPSHOT_DIRECTORY_PATTERN =
  /^snapshot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface NativeHarnessReconciliationContentByteSourceFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessReconciliationContentByteBaseEntryFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
  readonly controllerHash: string;
}

export interface NativeHarnessReconciliationContentByteStageFact {
  readonly stage: string;
  readonly solver: boolean;
  readonly attempt: number;
  readonly artifactHash: string | null;
  readonly changeManifestSha256: string | null;
  readonly changeCount: number | null;
  readonly ordinaryFileCount: number | null;
  readonly directoryCount: number | null;
  readonly totalFileBytes: number | null;
  readonly trace: {
    readonly bytes: number;
    readonly sha256: string;
    readonly observedAt: number;
  };
  readonly terminalObservationKind: "runner-observation";
  readonly parent: { readonly stage: string; readonly artifactHash: string } | null;
}

export interface NativeHarnessReconciliationContentByteObservation {
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly processes: "not-inspected";
  /** Exact scope: the latest completed trees were read, not artifact history. */
  readonly artifacts: "latest-completed-bytes-checked";
  /** Old attempt result/turn contents were never read or reused. */
  readonly discardedAttemptContents: "not-verified-not-reused";
  readonly status: "stable";
  readonly observation: "two-pass";
  readonly semanticAcceptance: "not-evaluated";
  readonly sources: readonly NativeHarnessReconciliationContentByteSourceFact[];
  readonly base: {
    readonly snapshotId: string;
    readonly snapshotSha256: string;
    readonly manifestSha256: string;
    readonly entries: readonly NativeHarnessReconciliationContentByteBaseEntryFact[];
  };
  readonly stages: readonly NativeHarnessReconciliationContentByteStageFact[];
  /** Actual source/base/solver/tree/trace bytes charged for these two passes. */
  readonly chargedBytes: number;
  readonly chargeLimitBytes: number;
  readonly tracePasses: 2;
  readonly limitations: readonly string[];
}

export interface NativeHarnessReconciliationContentByteControls {
  readonly guard: () => void;
  readonly signal: AbortSignal;
  /** Fixed ceiling supplied by the host mode; a lower test ceiling is honored. */
  readonly chargeLimitBytes: number;
  /** Existing narrow file IO seam; production callers omit it. */
  readonly fileIo?: NativeFileIo;
}

export interface NativeHarnessReconciliationContentByteFailure extends NativeHarnessOutputFailureResult {
  readonly chargedBytes: number;
  readonly chargeLimitBytes: number;
  readonly tracePassesStarted: 0 | 1 | 2;
}

export type NativeHarnessReconciliationContentByteResult =
  | { readonly ok: true; readonly observation: NativeHarnessReconciliationContentByteObservation }
  | NativeHarnessReconciliationContentByteFailure;

const CONTENT_LIMITATIONS = Object.freeze([
  "Byte/hash association for latest completed stage contents only; not semantic quality, acceptance, authorship, apply or current native work.",
  "Old attempt contents are not reused and their discarded bytes are not verified.",
  "Trace bytes were hashed, not parsed; terminal lifecycle facts are copied from the original inventory and WorkerResult declarations.",
  "No resume permission, future eligibility, process query, original elapsed-deadline inference or accounting settlement is provided.",
  "Observations are intervals: a change wholly between the two passes is not excluded and later writes are not prevented.",
]);

interface OwnedContentSource {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface OwnedContentBaseEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mode: number;
  readonly controllerHash: string;
}

interface OwnedContentStage {
  readonly stage: string;
  readonly solver: boolean;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactDir: string;
  readonly eventsPath: string;
  readonly traceHash: string;
  readonly artifactHash: string | null;
  readonly terminalObservationKind: "runner-observation";
  readonly parent: { readonly stage: string; readonly artifactHash: string } | null;
}

interface OwnedContentPlan {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly runRoot: string;
  readonly sources: readonly OwnedContentSource[];
  readonly base: {
    readonly snapshotId: string;
    readonly root: string;
    readonly sourceRoot: string;
    readonly createdAt: string;
    readonly manifestSha256: string;
    readonly snapshotSha256: string;
    readonly entries: readonly OwnedContentBaseEntry[];
  };
  readonly stages: readonly OwnedContentStage[];
}

function contentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => contentCanonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${contentCanonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function contentCompareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contentNonNegativeInteger(value: unknown, max: number): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= max
    ? value
    : null;
}

function contentStageLayoutMatches(
  runRoot: string,
  stage: string,
  attempt: number,
  cwd: string,
): boolean {
  if (!isStrictlyContained(runRoot, cwd)) return false;
  const segments = path.relative(runRoot, cwd).split(path.sep);
  if (segments.length !== 4) return false;
  const [stages, stageSegment, attemptSegment, workspace] = segments;
  const prefix = `attempt-${attempt}-`;
  return stages === "stages"
    && stageSegment === stage
    && attemptSegment?.startsWith(prefix) === true
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptSegment.slice(prefix.length))
    && workspace === "workspace";
}

function readContentPlan(value: unknown): OwnedContentPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("source-unavailable", "The content plan is not an exact bounded object.");
  }
  const plan = value as NativeHarnessReconciliationContentPlan;
  if (
    plan.schema !== "omp-agent.native-harness-reconciliation-content-plan.v1"
    || plan.readOnly !== true
    || plan.resumeAvailable !== false
    || plan.processes !== "not-inspected"
  ) {
    fail("source-unavailable", "The content plan does not have the expected fixed schema.");
  }
  const storageRoot = trustedAbsolute(plan.storageRoot, "content storageRoot");
  const sourceRoot = trustedAbsolute(plan.sourceRoot, "content sourceRoot");
  const preparedRoot = trustedAbsolute(plan.preparedRoot, "content preparedRoot");
  const workspaceRoot = trustedAbsolute(plan.workspaceRoot, "content workspaceRoot");
  const storeRoot = trustedAbsolute(plan.storeRoot, "content storeRoot");
  const runRoot = trustedAbsolute(plan.runRoot, "content runRoot");
  if (
    isContained(storageRoot, sourceRoot)
    || isContained(sourceRoot, storageRoot)
    || !isStrictlyContained(storageRoot, preparedRoot)
    || !isStrictlyContained(preparedRoot, workspaceRoot)
    || !isStrictlyContained(preparedRoot, storeRoot)
    || !isStrictlyContained(storeRoot, runRoot)
  ) {
    fail("unsafe-path", "The content plan roots are not the fixed disjoint private layout.");
  }

  const rawSources = plan.sources;
  const rawBase = plan.base;
  if (!Array.isArray(rawSources) || rawSources.length < 1
    || rawSources.length > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs
    || typeof rawBase !== "object" || rawBase === null || Array.isArray(rawBase)
    || !Array.isArray(rawBase.entries)) {
    fail("source-unavailable", "The content plan source/base facts are not bounded.");
  }
  const sources: OwnedContentSource[] = [];
  const sourceByPath = new Map<string, OwnedContentSource>();
  let sourceTotal = 0;
  for (const raw of rawSources) {
    if (typeof raw !== "object" || raw === null) fail("source-unavailable", "A content source fact is unreadable.");
    const relative = boundedRelative((raw as { path?: unknown }).path);
    const bytes = (raw as { bytes?: unknown }).bytes;
    const sha256 = (raw as { sha256?: unknown }).sha256;
    if (
      !Number.isSafeInteger(bytes)
      || (bytes as number) < 0
      || (bytes as number) > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes
      || !hex64(sha256)
      || sourceByPath.has(relative)
    ) {
      fail("source-unavailable", "A content source fact is not bounded or unique.");
    }
    sourceTotal += bytes as number;
    if (sourceTotal > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes) {
      fail("too-large", "The content source manifest exceeds its total byte bound.");
    }
    const fact = Object.freeze({ path: relative, bytes: bytes as number, sha256 });
    sources.push(fact);
    sourceByPath.set(relative, fact);
  }

  const snapshotRoot = trustedAbsolute(rawBase.root, "content base root");
  const baseSourceRoot = trustedAbsolute(rawBase.sourceRoot, "content base sourceRoot");
  if (
    baseSourceRoot !== workspaceRoot
    || path.dirname(snapshotRoot) !== runRoot
    || !SNAPSHOT_DIRECTORY_PATTERN.test(path.basename(snapshotRoot))
    || typeof rawBase.snapshotId !== "string"
    || rawBase.snapshotId.length < 1
    || rawBase.snapshotId.length > 256
    || typeof rawBase.createdAt !== "string"
    || rawBase.createdAt.length < 1
    || rawBase.createdAt.length > 64
    || !hex64(rawBase.manifestSha256)
    || !hex64(rawBase.snapshotSha256)
    || rawBase.entries.length !== sources.length
  ) {
    fail("source-unavailable", "The content plan base facts are not the fixed snapshot shape.");
  }
  const entries: OwnedContentBaseEntry[] = [];
  const entryByPath = new Map<string, OwnedContentBaseEntry>();
  for (const raw of rawBase.entries) {
    if (typeof raw !== "object" || raw === null) fail("source-unavailable", "A base entry is unreadable.");
    const relative = boundedRelative((raw as { path?: unknown }).path);
    const bytes = (raw as { bytes?: unknown }).bytes;
    const sha256 = (raw as { sha256?: unknown }).sha256;
    const mode = (raw as { mode?: unknown }).mode;
    const controllerHash = (raw as { controllerHash?: unknown }).controllerHash;
    if (
      !Number.isSafeInteger(bytes)
      || (bytes as number) < 0
      || (bytes as number) > NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes
      || !hex64(sha256)
      || !Number.isSafeInteger(mode)
      || (mode as number) < 0
      || (mode as number) > 0o777
      || !hex64(controllerHash)
      || entryByPath.has(relative)
    ) {
      fail("source-unavailable", "A base entry is not bounded or unique.");
    }
    const entry = Object.freeze({
      path: relative,
      bytes: bytes as number,
      sha256,
      mode: mode as number,
      controllerHash,
    });
    entries.push(entry);
    entryByPath.set(relative, entry);
  }
  if (
    entryByPath.size !== sourceByPath.size
    || [...sourceByPath.keys()].some((relative) => {
      const entry = entryByPath.get(relative);
      const source = sourceByPath.get(relative)!;
      return entry === undefined
        || entry.bytes !== source.bytes
        || entry.sha256 !== source.sha256;
    })
  ) {
    fail("source-unavailable", "The content base entries do not exactly match the selected source manifest.");
  }
  const manifestEntries = [...sources]
    .sort((left, right) => contentCompareCodeUnit(left.path, right.path))
    .map((source) => [source.path, source.bytes, source.sha256]);
  if (sha256Hex(JSON.stringify(manifestEntries)) !== rawBase.manifestSha256) {
    fail("changed", "The content source manifest digest is inconsistent.");
  }
  const reconstructed = copyWitnessBase({
    snapshotId: rawBase.snapshotId,
    root: snapshotRoot,
    sourceRoot: baseSourceRoot,
    createdAt: rawBase.createdAt,
    checked: entries.map((entry) => ({
      path: entry.path,
      size: entry.bytes,
      mode: entry.mode,
      contentSha256: entry.sha256,
      controllerHash: entry.controllerHash,
    })),
    inputs: sources.map((source) => ({
      relativePath: source.path,
      bytes: source.bytes,
      sha256: source.sha256,
    })),
    manifestSha256: rawBase.manifestSha256,
  });
  if (
    reconstructed === null
    || sha256Hex(contentCanonicalJson(reconstructed)) !== rawBase.snapshotSha256
  ) {
    fail("changed", "The content base snapshot digest is inconsistent.");
  }

  if (!Array.isArray(plan.stages) || plan.stages.length > MAX_CONTENT_STAGES) {
    fail("source-unavailable", "The content stage plan exceeds its fixed bound.");
  }
  const stages: OwnedContentStage[] = [];
  let solverCount = 0;
  for (const raw of plan.stages) {
    if (typeof raw !== "object" || raw === null) fail("source-unavailable", "A content stage fact is unreadable.");
    const stage = (raw as { stage?: unknown }).stage;
    const solver = (raw as { solver?: unknown }).solver;
    const attempt = (raw as { attempt?: unknown }).attempt;
    const cwd = trustedAbsolute((raw as { cwd?: unknown }).cwd, "content stage cwd");
    const artifactDir = trustedAbsolute((raw as { artifactDir?: unknown }).artifactDir, "content artifactDir");
    const eventsPath = trustedAbsolute((raw as { eventsPath?: unknown }).eventsPath, "content eventsPath");
    const traceHash = (raw as { traceHash?: unknown }).traceHash;
    const artifactHash = (raw as { artifactHash?: unknown }).artifactHash;
    const terminalObservationKind = (raw as { terminalObservationKind?: unknown }).terminalObservationKind;
    const parent = (raw as { parent?: unknown }).parent;
    if (
      typeof stage !== "string"
      || !(STAGE_IDS as readonly string[]).includes(stage)
      || typeof solver !== "boolean"
      || solver !== (NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(stage)
      || !Number.isSafeInteger(attempt)
      || (attempt as number) < 1
      || !hex64(traceHash)
      || (solver ? !hex64(artifactHash) : artifactHash !== null)
      || terminalObservationKind !== "runner-observation"
      || artifactDir !== path.join(path.dirname(cwd), "artifacts")
      || eventsPath !== path.join(artifactDir, "worker-events.jsonl")
      || !contentStageLayoutMatches(runRoot, stage, attempt as number, cwd)
    ) {
      fail("source-unavailable", "A content stage fact is inconsistent with the fixed stage layout.");
    }
    if (solver) {
      solverCount += 1;
      if (solverCount > MAX_CONTENT_SOLVERS) {
        fail("source-unavailable", "The content solver tree count exceeds its fixed bound.");
      }
    }
    let parentFact: { readonly stage: string; readonly artifactHash: string } | null = null;
    if (parent !== null) {
      if (typeof parent !== "object" || Array.isArray(parent)) {
        fail("source-unavailable", "A content parent fact is unreadable.");
      }
      const parentStage = (parent as { stage?: unknown }).stage;
      const parentHash = (parent as { artifactHash?: unknown }).artifactHash;
      if (
        typeof parentStage !== "string"
        || !(NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(parentStage)
        || !hex64(parentHash)
      ) {
        fail("source-unavailable", "A content parent fact is not a completed solver reference.");
      }
      parentFact = Object.freeze({ stage: parentStage, artifactHash: parentHash });
    }
    stages.push(Object.freeze({
      stage,
      solver,
      attempt: attempt as number,
      cwd,
      artifactDir,
      eventsPath,
      traceHash,
      artifactHash: solver ? artifactHash as string : null,
      terminalObservationKind,
      parent: parentFact,
    }));
  }

  return Object.freeze({
    storageRoot,
    sourceRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    runRoot,
    sources: Object.freeze(sources),
    base: Object.freeze({
      snapshotId: rawBase.snapshotId,
      root: snapshotRoot,
      sourceRoot: baseSourceRoot,
      createdAt: rawBase.createdAt,
      manifestSha256: rawBase.manifestSha256,
      snapshotSha256: rawBase.snapshotSha256,
      entries: Object.freeze(entries),
    }),
    stages: Object.freeze(stages),
  });
}

function declaredBaseOf(plan: OwnedContentPlan): DeclaredBase {
  return {
    entries: new Map(plan.base.entries.map((entry) => [
      entry.path,
      { path: entry.path, size: entry.bytes, mode: entry.mode, hash: entry.controllerHash },
    ])),
    inputs: new Map(plan.sources.map((source) => [
      source.path,
      { relativePath: source.path, bytes: source.bytes, sha256: source.sha256 },
    ])),
  };
}

function verifyContentBaseTree(plan: OwnedContentPlan, tree: TreeObservation): void {
  if (tree.markerSignature !== null) {
    failObserved("unsupported", "The base snapshot unexpectedly contains an origin marker.");
  }
  if (tree.fileCount !== plan.base.entries.length || tree.files.size !== plan.base.entries.length) {
    failObserved("unsupported", "The base snapshot regular files do not exactly match the reconstructed manifest.");
  }
  const observedPaths = [...tree.files.keys()].sort(comparePaths);
  const expectedPaths = plan.base.entries.map((entry) => entry.path).sort(comparePaths);
  if (observedPaths.length !== expectedPaths.length
    || observedPaths.some((value, index) => value !== expectedPaths[index])) {
    failObserved("unsupported", "The base snapshot path set does not exactly match the reconstructed manifest.");
  }
  for (const entry of plan.base.entries) {
    const file = tree.files.get(entry.path);
    if (
      file === undefined
      || file.snapshot.file.bytes !== entry.bytes
      || file.snapshot.file.sha256 !== entry.sha256
      || sizeOf(file.signature) !== entry.bytes
      || file.signature.mode !== entry.mode
      || file.controllerHash !== entry.controllerHash
    ) {
      failObserved("changed", "A base snapshot input does not match the reconstructed source/manifest facts.");
    }
  }
}

function verifyContentSolverTree(
  declared: DeclaredBase,
  stage: OwnedContentStage,
  tree: TreeObservation,
): { readonly changes: ReturnType<typeof stageChanges>; readonly digest: string } {
  const changes = stageChanges(declared, tree.files);
  const digest = sha256Hex(JSON.stringify(changes));
  if (digest !== stage.artifactHash) {
    failObserved("changed", "A completed solver tree does not match its frozen artifact hash.");
  }
  return { changes, digest };
}

/**
 * Rechecks the planned parent references against the actually verified solver
 * artifact hashes, including refinement presence and a bounded acyclic chain.
 */
function verifyContentParentChain(stages: readonly OwnedContentStage[]): void {
  const byStage = new Map(stages.map((stage) => [stage.stage, stage]));
  for (const stage of stages) {
    if (stage.parent === null) {
      if (stage.stage === "refine") {
        failObserved("changed", "A completed refine stage has no current completed solver parent.");
      }
      continue;
    }
    if (!stage.solver) {
      failObserved("changed", "A non-solver content stage has an unexpected parent reference.");
    }
    const parent = byStage.get(stage.parent.stage);
    if (
      parent === undefined
      || !parent.solver
      || parent.artifactHash === null
      || parent.artifactHash !== stage.parent.artifactHash
    ) {
      failObserved("changed", "A completed solver parent reference does not match an actual solver artifact.");
    }
    const visited = new Set<string>([stage.stage]);
    let cursor = parent;
    let depth = 1;
    for (;;) {
      if (visited.has(cursor.stage) || depth > MAX_CONTENT_SOLVERS) {
        failObserved("changed", "The completed solver parent chain is cyclic or exceeds its bound.");
      }
      visited.add(cursor.stage);
      if (cursor.parent === null) break;
      const next = byStage.get(cursor.parent.stage);
      if (
        next === undefined
        || !next.solver
        || next.artifactHash === null
        || next.artifactHash !== cursor.parent.artifactHash
      ) {
        failObserved("changed", "A completed solver parent chain does not match actual solver artifacts.");
      }
      cursor = next;
      depth += 1;
    }
  }
}

async function observeContentSources(
  ctx: Context,
  plan: OwnedContentPlan,
  charge: (bytes: number) => void,
): Promise<Array<{
  readonly fact: NativeHarnessReconciliationContentByteSourceFact;
  readonly signature: FileSignature;
  readonly relativePath: string;
}>> {
  const observations = [];
  const accounting: ContentReadAccounting = {
    charge,
    maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    totalBytes: 0,
  };
  for (const source of [...plan.sources].sort((left, right) => comparePaths(left.path, right.path))) {
    const observed = await observeTextFile(ctx, plan.sourceRoot, source.path, null, true, accounting);
    if (
      observed.snapshot.file.bytes !== source.bytes
      || observed.snapshot.file.sha256 !== source.sha256
    ) {
      failObserved("changed", "A selected original source file no longer matches the source manifest.");
    }
    observations.push({
      fact: Object.freeze({
        path: source.path,
        bytes: observed.snapshot.file.bytes,
        sha256: observed.snapshot.file.sha256,
        observedAt: observed.snapshot.file.observedAt,
      }),
      signature: observed.signature,
      relativePath: source.path,
    });
  }
  return observations;
}

async function recheckContentSources(
  ctx: Context,
  plan: OwnedContentPlan,
  first: Awaited<ReturnType<typeof observeContentSources>>,
  charge: (bytes: number) => void,
): Promise<void> {
  if (first.length !== plan.sources.length) {
    failObserved("changed", "The selected source observation set changed between passes.");
  }
  const accounting: ContentReadAccounting = {
    charge,
    maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
    totalBytes: 0,
  };
  for (let index = 0; index < first.length; index += 1) {
    const expected = first[index]!;
    const again = await observeTextFile(ctx, plan.sourceRoot, expected.relativePath, null, true, accounting);
    if (
      again.snapshot.file.bytes !== expected.fact.bytes
      || again.snapshot.file.sha256 !== expected.fact.sha256
      || !sameFileSignature(expected.signature, again.signature)
    ) {
      failObserved("changed", "A selected original source file changed during the content passes.");
    }
  }
}

interface ContentSolverObservation {
  readonly stage: OwnedContentStage;
  readonly tree: TreeObservation;
  readonly changes: ReturnType<typeof stageChanges>;
  readonly digest: string;
}

/**
 * Host-only, non-issuing byte observation of the planned latest completed
 * contents. It reuses this module's original bounded tree/trace readers but
 * never calls `buildCapture`, `issuedOutputCaptures`, the issued completion
 * gate or any capture-issue path. Every returned fact is provisional byte
 * association; the outer files observation alone decides whether final
 * primaries and pins still agree.
 */
export async function observeNativeHarnessReconciliationContentBytes(
  plan: NativeHarnessReconciliationContentPlan,
  controls: NativeHarnessReconciliationContentByteControls,
): Promise<NativeHarnessReconciliationContentByteResult> {
  const startedAt = performance.now();
  const requestedLimit = controls.chargeLimitBytes;
  const chargeLimitBytes = Number.isSafeInteger(requestedLimit) && requestedLimit >= 0
    ? Math.min(requestedLimit, CONTENT_CHARGE_LIMIT_BYTES)
    : CONTENT_CHARGE_LIMIT_BYTES;
  let chargedBytes = 0;
  let tracePassesStarted: 0 | 1 | 2 = 0;
  const controlFailure: { value: OutputError | null } = { value: null };
  const charge = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      fail("io-failure", "A content byte charge was not a bounded observed size.");
    }
    if (bytes > chargeLimitBytes - chargedBytes) {
      fail("too-large", "The content byte observation charge exceeds its fixed ceiling.");
    }
    chargedBytes += bytes;
  };
  try {
    if (typeof controls !== "object" || controls === null
      || typeof controls.guard !== "function"
      || typeof AbortSignal === "undefined") {
      fail("invalid-control", "The content byte observer requires its fixed guard and actual signal.");
    }
    readActualAborted(controls.signal);
    if (controls.fileIo !== undefined) {
      const candidate = controls.fileIo;
      if (
        typeof candidate !== "object" || candidate === null
        || typeof candidate.O_RDONLY !== "number"
        || typeof candidate.O_NOFOLLOW !== "number"
        || typeof candidate.realpath !== "function"
        || typeof candidate.lstat !== "function"
        || typeof candidate.open !== "function"
      ) {
        fail("invalid-control", "The content file IO seam is not usable.");
      }
    }
    const owned = readContentPlan(plan);
    const closeError = { value: false };
    const baseContext = {
      guard: controls.guard,
      signal: controls.signal,
      startedAt,
      contentControl: true as const,
      checkpoint: null,
      directories: new Map<string, DirectoryIdentity>(),
      closeError,
      controlFailure,
    };
    if (readActualAborted(baseContext.signal)) fail("aborted", "The content observation signal was already aborted.");
    const ctx: Context = {
      ...baseContext,
      io: createGuardedIo(baseContext, controls.fileIo ?? nodeFileIo),
    };
    assertAuthority(ctx);

    const preparedIdentity = await observeRoot(ctx, owned.preparedRoot, "content preparedRoot");
    await registerAncestry(ctx, preparedIdentity, owned.workspaceRoot, "content workspaceRoot");
    await observeRoot(ctx, owned.workspaceRoot, "content workspaceRoot");
    await registerAncestry(ctx, preparedIdentity, owned.storeRoot, "content storeRoot");
    await observeRoot(ctx, owned.storeRoot, "content storeRoot");
    await registerAncestry(ctx, preparedIdentity, owned.runRoot, "content runRoot");
    const runIdentity = await observeRoot(ctx, owned.runRoot, "content runRoot");
    await observeRoot(ctx, owned.sourceRoot, "content sourceRoot");
    await registerAncestry(ctx, runIdentity, owned.base.root, "content base root");
    await observeRoot(ctx, owned.base.root, "content base root");
    for (const stage of owned.stages) {
      await registerAncestry(ctx, runIdentity, stage.cwd, `${stage.stage} cwd`);
      await observeRoot(ctx, stage.cwd, `${stage.stage} cwd`);
      await registerAncestry(ctx, runIdentity, stage.artifactDir, `${stage.stage} artifactDir`);
      await observeRoot(ctx, stage.artifactDir, `${stage.stage} artifactDir`);
    }

    const declared = declaredBaseOf(owned);
    const sourceFirst = await observeContentSources(ctx, owned, charge);
    const baseFirst = await inventoryTree(ctx, {
      root: owned.base.root,
      label: "content base snapshot",
      stage: null,
      allowMarker: false,
      expectedMarkerBytes: null,
      maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs,
      maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
      maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
      readFiles: true,
      charge,
    });
    verifyContentBaseTree(owned, baseFirst);

    const solverFirst: ContentSolverObservation[] = [];
    for (const stage of owned.stages) {
      if (!stage.solver) continue;
      const tree = await inventoryTree(ctx, {
        root: stage.cwd,
        label: `${stage.stage} content stage`,
        stage: { candidate: stage.stage },
        allowMarker: true,
        expectedMarkerBytes: JSON.stringify({
          snapshotId: owned.base.snapshotId,
          destination: stage.cwd,
        }),
        maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageOrdinaryFiles,
        maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageFileBytes,
        maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageTotalBytes,
        readFiles: true,
        charge,
      });
      if (tree.markerSignature === null) failObserved("missing", "A completed solver stage origin marker is missing.");
      const verified = verifyContentSolverTree(declared, stage, tree);
      solverFirst.push({
        stage,
        tree,
        changes: verified.changes,
        digest: verified.digest,
      });
    }
    verifyContentParentChain(owned.stages);

    tracePassesStarted = 1;
    const traceFirst = new Map<string, TraceObservation>();
    const firstTracePass: TracePass = { totalBytes: 0, charge };
    for (const stage of owned.stages) {
      const trace = await observeTrace(
        ctx,
        { candidate: stage.stage, attempt: stage.attempt, traceHash: stage.traceHash },
        stage.artifactDir,
        stage.eventsPath,
        firstTracePass,
      );
      traceFirst.set(`${stage.stage}:${stage.attempt}`, trace);
    }

    await recheckContentSources(ctx, owned, sourceFirst, charge);
    const baseSecond = await inventoryTree(ctx, {
      root: owned.base.root,
      label: "content base snapshot second pass",
      stage: null,
      allowMarker: false,
      expectedMarkerBytes: null,
      maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceInputs,
      maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
      maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxSourceTotalBytes,
      readFiles: true,
      charge,
    });
    verifyContentBaseTree(owned, baseSecond);
    if (!sameContentTree(baseFirst, baseSecond)) {
      failObserved("changed", "The base snapshot bytes or metadata changed between content passes.");
    }
    for (const first of solverFirst) {
      const second = await inventoryTree(ctx, {
        root: first.stage.cwd,
        label: `${first.stage.stage} content stage second pass`,
        stage: { candidate: first.stage.stage },
        allowMarker: true,
        expectedMarkerBytes: JSON.stringify({
          snapshotId: owned.base.snapshotId,
          destination: first.stage.cwd,
        }),
        maxOrdinaryFiles: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageOrdinaryFiles,
        maxFileBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageFileBytes,
        maxTotalBytes: NATIVE_HARNESS_OUTPUT_LIMITS.maxStageTotalBytes,
        readFiles: true,
        charge,
      });
      if (second.markerSignature === null) {
        failObserved("missing", "A completed solver stage origin marker disappeared between passes.");
      }
      const verified = verifyContentSolverTree(declared, first.stage, second);
      if (verified.digest !== first.digest || !sameContentTree(first.tree, second)) {
        failObserved("changed", "A completed solver tree changed between content passes.");
      }
    }

    tracePassesStarted = 2;
    const secondTracePass: TracePass = { totalBytes: 0, charge };
    for (const stage of owned.stages) {
      const first = traceFirst.get(`${stage.stage}:${stage.attempt}`);
      if (first === undefined) {
        failObserved("changed", "A completed stage trace disappeared between content passes.");
      }
      const second = await observeTrace(
        ctx,
        { candidate: stage.stage, attempt: stage.attempt, traceHash: stage.traceHash },
        stage.artifactDir,
        stage.eventsPath,
        secondTracePass,
      );
      if (
        second.bytes !== first.bytes
        || second.sha256 !== first.sha256
        || !sameFileSignature(first.signature, second.signature)
      ) {
        failObserved("changed", "A completed stage trace changed between content passes.");
      }
    }

    for (const [directoryPath, identity] of ctx.directories) {
      const info = await lstatOrFail(ctx, directoryPath, "content directory");
      if (
        info.isSymbolicLink()
        || !info.isDirectory()
        || !sameDirectoryIdentity(identity, directoryIdentityOf(directoryPath, info))
      ) {
        fail("changed", "A content directory identity changed during observation.");
      }
    }
    assertAuthority(ctx);
    if (closeError.value) {
      fail("io-failure", "A content file handle reported a close failure.");
    }

    const baseEntries: NativeHarnessReconciliationContentByteBaseEntryFact[] = [];
    for (const entry of owned.base.entries) {
      const file = baseFirst.files.get(entry.path);
      if (file === undefined) fail("changed", "A verified base file disappeared before its summary.");
      baseEntries.push(Object.freeze({
        path: entry.path,
        bytes: file.snapshot.file.bytes,
        sha256: file.snapshot.file.sha256,
        mode: file.signature.mode,
        controllerHash: file.controllerHash,
      }));
    }
    const stageFacts: NativeHarnessReconciliationContentByteStageFact[] = owned.stages.map((stage) => {
      const trace = traceFirst.get(`${stage.stage}:${stage.attempt}`);
      if (trace === undefined) fail("changed", "A verified stage trace disappeared before its summary.");
      const solver = solverFirst.find((candidate) => candidate.stage.stage === stage.stage);
      return Object.freeze({
        stage: stage.stage,
        solver: stage.solver,
        attempt: stage.attempt,
        artifactHash: stage.artifactHash,
        changeManifestSha256: solver?.digest ?? null,
        changeCount: solver?.changes.length ?? null,
        ordinaryFileCount: solver?.tree.fileCount ?? null,
        directoryCount: solver?.tree.directoryCount ?? null,
        totalFileBytes: solver?.tree.totalFileBytes ?? null,
        trace: Object.freeze({
          bytes: trace.bytes,
          sha256: trace.sha256,
          observedAt: trace.observedAt,
        }),
        terminalObservationKind: stage.terminalObservationKind,
        parent: stage.parent === null
          ? null
          : Object.freeze({ stage: stage.parent.stage, artifactHash: stage.parent.artifactHash }),
      });
    });
    const observation: NativeHarnessReconciliationContentByteObservation = deepFreeze({
      readOnly: true as const,
      resumeAvailable: false as const,
      processes: "not-inspected" as const,
      artifacts: "latest-completed-bytes-checked" as const,
      discardedAttemptContents: "not-verified-not-reused" as const,
      status: "stable" as const,
      observation: "two-pass" as const,
      semanticAcceptance: "not-evaluated" as const,
      sources: Object.freeze(sourceFirst.map((entry) => entry.fact)),
      base: Object.freeze({
        snapshotId: owned.base.snapshotId,
        snapshotSha256: owned.base.snapshotSha256,
        manifestSha256: owned.base.manifestSha256,
        entries: Object.freeze(baseEntries),
      }),
      stages: Object.freeze(stageFacts),
      chargedBytes,
      chargeLimitBytes,
      tracePasses: 2 as const,
      limitations: CONTENT_LIMITATIONS,
    });
    if (Buffer.byteLength(JSON.stringify(observation), "utf8")
      > NATIVE_HARNESS_OUTPUT_LIMITS.maxMetadataBytes) {
      fail("too-large", "The retained content observation metadata exceeds its byte bound.");
    }
    return { ok: true, observation };
  } catch (error) {
    const failure = controlFailure.value !== null
      ? issuedFailures.get(controlFailure.value)
      : (error instanceof OutputError ? issuedFailures.get(error) : undefined);
    if (failure !== undefined) {
      return {
        ...failureResult(failure),
        chargedBytes,
        chargeLimitBytes,
        tracePassesStarted,
      };
    }
    const nativeCode = readOwnString(error, "code");
    if (nativeCode !== null && NATIVE_FILE_FAILURE_CODES.has(nativeCode)) {
      const code: NativeHarnessOutputFailure = nativeCode === "invalid-path" ? "unsafe-path"
        : nativeCode === "non-text" ? "unsupported"
        : nativeCode as NativeHarnessOutputFailure;
      return {
        ok: false,
        code,
        reason: boundedReason(readOwnString(error, "message") ?? "A native content observation was refused."),
        chargedBytes,
        chargeLimitBytes,
        tracePassesStarted,
      };
    }
    return {
      ok: false,
      code: isErrno(error, "ENOENT") ? "missing" : isErrno(error, "ELOOP") ? "unsafe-path" : "io-failure",
      reason: isErrno(error, "ENOENT")
        ? "A content path disappeared during observation."
        : isErrno(error, "ELOOP")
          ? "A content path is a symbolic link."
          : "The content observation failed without a serializable host error.",
      chargedBytes,
      chargeLimitBytes,
      tracePassesStarted,
    };
  }
}

export interface NativeHarnessInitialInputsByteFileFact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessInitialInputsBytePreparedFileFact
  extends NativeHarnessInitialInputsByteFileFact {
  readonly mode: number;
}

export interface NativeHarnessInitialInputsByteObservation {
  readonly readOnly: true;
  readonly resumeAvailable: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly processes: "not-inspected";
  readonly status: "stable";
  readonly observation: "two-pass";
  readonly runId: string;
  readonly runSha256: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly manifestSha256: string;
  readonly source: {
    readonly root: string;
    readonly files: readonly NativeHarnessInitialInputsByteFileFact[];
    readonly totalBytes: number;
    readonly captureStarts: number;
  };
  readonly prepared: {
    readonly root: string;
    readonly mode: 0o600;
    readonly files: readonly NativeHarnessInitialInputsBytePreparedFileFact[];
    readonly totalBytes: number;
    readonly captureStarts: number;
    readonly excluded: {
      readonly path: ".git";
      readonly kind: "directory";
      readonly contents: "not-enumerated-not-hashed";
      readonly git: "not-started";
      readonly identity: "pinned-before-between-after";
    };
  };
  readonly passes: 2;
  readonly captureStarts: number;
  readonly chargedBytes: number;
  readonly chargeLimitBytes: number;
  readonly openedFiles: number;
  readonly maxConcurrentOpenedFiles: number;
  readonly close: {
    readonly attempted: number;
    readonly settled: number;
    readonly succeeded: number;
  };
  readonly limitations: readonly string[];
}

export interface NativeHarnessInitialInputsByteFailure extends NativeHarnessOutputFailureResult {
  readonly captureStarts: number;
  readonly chargedBytes: number;
  readonly chargeLimitBytes: number;
  readonly passesStarted: 0 | 1 | 2;
  readonly openedFiles: number;
  readonly close: {
    readonly attempted: number;
    readonly settled: number;
    readonly succeeded: number;
  };
  /** A file or directory close did not settle successfully. */
  readonly closeFailed?: true;
}

export type NativeHarnessInitialInputsByteResult =
  | { readonly ok: true; readonly observation: NativeHarnessInitialInputsByteObservation }
  | NativeHarnessInitialInputsByteFailure;

const INITIAL_INPUT_LIMITATIONS = Object.freeze([
  "Selected original inputs were read as UTF-8 text bytes and matched to the original manifest; unrelated source files were not inspected.",
  "The prepared workspace contained exactly the manifest ordinary files at mode 0600; the top-level .git directory was pinned as an excluded boundary and its contents were not enumerated, hashed or queried.",
  "Two actual byte passes were compared; a change wholly between observations is not excluded and later writes are not prevented.",
  "No worker, model, resume permission, completion witness, claim, conditional commit or execution is provided.",
]);

interface OwnedInitialPlan {
  readonly storageRoot: string;
  readonly sourceRoot: string;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly runSha256: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly manifestSha256: string;
  readonly sources: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

const INITIAL_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INITIAL_PREPARED_ROOT_PATTERN = /^omp-harness-[A-Za-z0-9]{6}$/;

function initialOwnField(
  value: unknown,
  key: string,
  label: string,
  code: NativeHarnessOutputFailure = "source-unavailable",
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail(code, `${label}.${key} could not be inspected.`);
  }
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || descriptor.get !== undefined
    || descriptor.set !== undefined
    || descriptor.enumerable !== true
  ) {
    fail(code, `${label}.${key} must be an enumerable own data field.`);
  }
  return descriptor.value;
}

function initialOwnFields(
  value: unknown,
  allowed: readonly string[],
  label: string,
  code: NativeHarnessOutputFailure = "source-unavailable",
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${label} must be an exact plain object.`);
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code, `${label} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be an exact plain object.`);
  }
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    fail(code, `${label} contains an unsupported field.`);
  }
  const fields = new Map<string, unknown>();
  for (const key of keys as string[]) fields.set(key, initialOwnField(value, key, label, code));
  return fields;
}

function initialExactOwnObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): ReadonlyMap<string, unknown> {
  const fields = initialOwnFields(value, keys, label);
  if (fields.size !== keys.length) {
    fail("source-unavailable", `${label} must contain exactly its fixed fields.`);
  }
  return fields;
}

function initialOwnSlots(
  value: unknown,
  label: string,
  min: number,
  max: number,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail("source-unavailable", `${label} must be an exact dense array.`);
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("source-unavailable", `${label} could not be inspected.`);
  }
  if (prototype !== Array.prototype && prototype !== null) {
    fail("source-unavailable", `${label} must be an exact dense array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < min
    || lengthDescriptor.value > max
  ) {
    fail("source-unavailable", `${label} is outside its fixed slot bound.`);
  }
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) {
    fail("source-unavailable", `${label} must be a dense array with no extra properties.`);
  }
  const slots: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keys.includes(key)) {
      fail("source-unavailable", `${label} must not contain holes.`);
    }
    slots.push(initialOwnField(value, key, label));
  }
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      fail("source-unavailable", `${label} contains an unsupported slot.`);
    }
  }
  return slots;
}

function readInitialInputsPlan(value: unknown): OwnedInitialPlan {
  const fields = initialExactOwnObject(value, [
    "schema",
    "readOnly",
    "resumeAvailable",
    "semanticAcceptance",
    "processes",
    "storageRoot",
    "sourceRoot",
    "preparedRoot",
    "workspaceRoot",
    "storeRoot",
    "runRoot",
    "runId",
    "runSha256",
    "sourceSha256",
    "sourceBytes",
    "manifestSha256",
    "preparedMode",
    "sources",
    "excluded",
  ], "initial inputs plan");
  const schema = fields.get("schema");
  const readOnly = fields.get("readOnly");
  const resumeAvailable = fields.get("resumeAvailable");
  const semanticAcceptance = fields.get("semanticAcceptance");
  const processes = fields.get("processes");
  const preparedMode = fields.get("preparedMode");
  if (
    schema !== NATIVE_HARNESS_INITIAL_INPUTS_PLAN_SCHEMA
    || readOnly !== true
    || resumeAvailable !== false
    || semanticAcceptance !== "not-evaluated"
    || processes !== "not-inspected"
    || preparedMode !== NATIVE_HARNESS_INITIAL_INPUTS_PREPARED_MODE
  ) {
    fail("source-unavailable", "The initial inputs plan does not have the expected fixed schema.");
  }
  const storageRoot = trustedAbsolute(fields.get("storageRoot"), "initial storageRoot");
  const sourceRoot = trustedAbsolute(fields.get("sourceRoot"), "initial sourceRoot");
  const preparedRoot = trustedAbsolute(fields.get("preparedRoot"), "initial preparedRoot");
  const workspaceRoot = trustedAbsolute(fields.get("workspaceRoot"), "initial workspaceRoot");
  const storeRoot = trustedAbsolute(fields.get("storeRoot"), "initial storeRoot");
  const runRoot = trustedAbsolute(fields.get("runRoot"), "initial runRoot");
  const runId = fields.get("runId");
  if (
    typeof runId !== "string"
    || !INITIAL_RUN_ID_PATTERN.test(runId)
    || !INITIAL_PREPARED_ROOT_PATTERN.test(path.basename(preparedRoot))
  ) {
    fail("source-unavailable", "The initial inputs plan run or prepared-root identity is not the fixed shape.");
  }
  if (
    isContained(storageRoot, sourceRoot)
    || isContained(sourceRoot, storageRoot)
    || path.dirname(preparedRoot) !== storageRoot
    || workspaceRoot !== path.join(preparedRoot, "workspace")
    || storeRoot !== path.join(preparedRoot, "store")
    || runRoot !== path.join(storeRoot, "runs", runId)
  ) {
    fail("unsafe-path", "The initial inputs plan roots are not the exact original prepared layout.");
  }
  const runSha256 = fields.get("runSha256");
  const sourceSha256 = fields.get("sourceSha256");
  const manifestSha256 = fields.get("manifestSha256");
  const sourceBytes = fields.get("sourceBytes");
  if (
    !hex64(runSha256)
    || !hex64(sourceSha256)
    || !hex64(manifestSha256)
    || !Number.isSafeInteger(sourceBytes)
    || (sourceBytes as number) < 0
    || (sourceBytes as number) > NATIVE_HARNESS_RECOVERY_SOURCE_MAX_BYTES
  ) {
    fail("source-unavailable", "The initial inputs plan identity or source size is not bounded.");
  }
  const excluded = initialExactOwnObject(fields.get("excluded"), [
    "path",
    "kind",
    "contents",
    "git",
  ], "initial excluded boundary");
  if (
    excluded.get("path") !== ".git"
    || excluded.get("kind") !== "directory"
    || excluded.get("contents") !== "not-enumerated-not-hashed"
    || excluded.get("git") !== "not-started"
  ) {
    fail("source-unavailable", "The initial inputs plan does not declare the fixed .git exclusion.");
  }
  const rawSources = initialOwnSlots(
    fields.get("sources"),
    "initial sources",
    1,
    NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILES,
  );
  const sources: Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of rawSources) {
    const source = initialExactOwnObject(raw, ["path", "bytes", "sha256"], "initial source fact");
    const relative = boundedRelative(source.get("path"));
    const bytes = source.get("bytes");
    const sha256 = source.get("sha256");
    if (
      !Number.isSafeInteger(bytes)
      || (bytes as number) < 0
      || (bytes as number) > NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILE_BYTES
      || !hex64(sha256)
      || seen.has(relative)
    ) {
      fail("source-unavailable", "An initial input source fact is not bounded or unique.");
    }
    seen.add(relative);
    total += bytes as number;
    if (total > NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES) {
      fail("too-large", "The initial input manifest exceeds its total byte bound.");
    }
    sources.push(Object.freeze({ path: relative, bytes: bytes as number, sha256 }));
  }
  const expectedManifest = [...sources]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map((source) => [source.path, source.bytes, source.sha256]);
  if (sha256Hex(JSON.stringify(expectedManifest)) !== manifestSha256) {
    fail("changed", "The initial input manifest digest is inconsistent.");
  }
  return Object.freeze({
    storageRoot,
    sourceRoot,
    preparedRoot,
    workspaceRoot,
    storeRoot,
    runRoot,
    runId,
    runSha256,
    sourceSha256,
    sourceBytes: sourceBytes as number,
    manifestSha256,
    sources: Object.freeze(
      [...sources].sort((left, right) => comparePaths(left.path, right.path)),
    ),
  });
}

interface OwnedInitialControls {
  readonly guard: () => void;
  readonly signal: AbortSignal;
  readonly chargeLimitBytes: number | null;
  readonly fileIo: NativeFileIo | null;
}

function readInitialControls(value: unknown): OwnedInitialControls {
  const fields = initialOwnFields(
    value,
    ["guard", "signal", "chargeLimitBytes", "fileIo"],
    "initial-input controls",
    "invalid-control",
  );
  const guard = fields.get("guard");
  const signal = fields.get("signal");
  if (typeof guard !== "function") {
    fail("invalid-control", "The initial-input observer requires a guard function.");
  }
  const rawLimit = fields.get("chargeLimitBytes");
  let chargeLimitBytes: number | null = null;
  if (rawLimit !== undefined) {
    if (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 0) {
      fail("invalid-control", "The initial-input charge limit is not a bounded non-negative integer.");
    }
    chargeLimitBytes = rawLimit as number;
  }
  const rawFileIo = fields.get("fileIo");
  let fileIo: NativeFileIo | null = null;
  if (rawFileIo !== undefined) {
    if (
      typeof rawFileIo !== "object" || rawFileIo === null
      || typeof (rawFileIo as NativeFileIo).O_RDONLY !== "number"
      || typeof (rawFileIo as NativeFileIo).O_NOFOLLOW !== "number"
      || typeof (rawFileIo as NativeFileIo).realpath !== "function"
      || typeof (rawFileIo as NativeFileIo).lstat !== "function"
      || typeof (rawFileIo as NativeFileIo).open !== "function"
    ) {
      fail("invalid-control", "The initial-input file IO seam is not usable.");
    }
    fileIo = rawFileIo as NativeFileIo;
  }
  readActualAborted(signal);
  return Object.freeze({
    guard: guard as () => void,
    signal: signal as AbortSignal,
    chargeLimitBytes,
    fileIo,
  });
}

interface InitialInputCounters {
  captureStarts: number;
  chargedBytes: number;
  openedFiles: number;
  activeFiles: number;
  maxConcurrentOpenedFiles: number;
  closeAttempted: number;
  closeSettled: number;
  closeSucceeded: number;
  closeFailed: boolean;
}

function initialCountingIo(base: NativeFileIo, counters: InitialInputCounters): NativeFileIo {
  return {
    O_RDONLY: base.O_RDONLY,
    O_NOFOLLOW: base.O_NOFOLLOW,
    realpath: (target) => base.realpath(target),
    lstat: (target, options) => base.lstat(target, options),
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      const handle = await base.open(target, flags);
      counters.openedFiles += 1;
      counters.activeFiles += 1;
      if (counters.activeFiles > counters.maxConcurrentOpenedFiles) {
        counters.maxConcurrentOpenedFiles = counters.activeFiles;
      }
      // One actual close attempt per handle: a duplicate wrapper close reuses
      // the first settled promise and can never call the host handle again.
      let closePromise: Promise<void> | null = null;
      return {
        stat: (options) => handle.stat(options),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close(): Promise<void> {
          if (closePromise !== null) return closePromise;
          counters.closeAttempted += 1;
          closePromise = (async () => {
            try {
              await handle.close();
              // A failed close leaves the real descriptor state unknown; it is
              // never counted as a released handle.
              counters.closeSucceeded += 1;
              counters.activeFiles -= 1;
            } catch (error) {
              counters.closeFailed = true;
              throw error;
            } finally {
              counters.closeSettled += 1;
            }
          })();
          return closePromise;
        },
      };
    },
  };
}

/**
 * Initial-only sticky effect guard. Once any initial file close fails, every
 * later initial capture start, open, lstat or realpath is refused immediately;
 * the already-open handles are still allowed to close. It never applies to the
 * issued capture/content paths.
 */
function initialEffectIo(
  base: NativeFileIo,
  halted: () => void,
): NativeFileIo {
  return {
    O_RDONLY: base.O_RDONLY,
    O_NOFOLLOW: base.O_NOFOLLOW,
    async realpath(target: string): Promise<string> {
      halted();
      const resolved = await base.realpath(target);
      halted();
      return resolved;
    },
    async lstat(target: string, options: { bigint: true }): Promise<NativeFileStats> {
      halted();
      const info = await base.lstat(target, options);
      halted();
      return info;
    },
    async open(target: string, flags: number): Promise<NativeFileHandle> {
      halted();
      const handle = await base.open(target, flags);
      try {
        halted();
      } catch (error) {
        try {
          await handle.close();
        } catch {
          // The sticky halt remains the reported failure; the fresh handle is
          // still closed through its single wrapper attempt.
        }
        throw error;
      }
      return {
        stat: (options) => handle.stat(options),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close(),
      };
    },
  };
}

function initialFailureCounters(
  counters: InitialInputCounters,
  chargeLimitBytes: number,
  passesStarted: 0 | 1 | 2,
  closeError: boolean,
): Pick<
  NativeHarnessInitialInputsByteFailure,
  | "captureStarts"
  | "chargedBytes"
  | "chargeLimitBytes"
  | "passesStarted"
  | "openedFiles"
  | "close"
  | "closeFailed"
> {
  return {
    captureStarts: counters.captureStarts,
    chargedBytes: counters.chargedBytes,
    chargeLimitBytes,
    passesStarted,
    openedFiles: counters.openedFiles,
    close: {
      attempted: counters.closeAttempted,
      settled: counters.closeSettled,
      succeeded: counters.closeSucceeded,
    },
    ...(counters.closeFailed || closeError ? { closeFailed: true as const } : {}),
  };
}

function preparedInitialTreeOptions(
  plan: OwnedInitialPlan,
  charge: (bytes: number) => void,
  startCapture: () => void,
): TreeOptions {
  return {
    root: plan.workspaceRoot,
    label: "initial prepared workspace",
    stage: null,
    allowMarker: false,
    expectedMarkerBytes: null,
    maxOrdinaryFiles: NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILES,
    maxFileBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILE_BYTES,
    maxTotalBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES,
    readFiles: true,
    charge,
    initialPrepared: true,
    onFileCapture: startCapture,
  };
}

async function observeInitialSources(
  ctx: Context,
  plan: OwnedInitialPlan,
  charge: (bytes: number) => void,
  startCapture: () => void,
): Promise<Array<NativeHarnessInitialInputsByteFileFact & { readonly signature: FileSignature }>> {
  const accounting: ContentReadAccounting = {
    charge,
    maxFileBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILE_BYTES,
    maxTotalBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES,
    totalBytes: 0,
  };
  const observedFacts = [];
  for (const source of plan.sources) {
    startCapture();
    const observed = await observeTextFile(ctx, plan.sourceRoot, source.path, null, true, accounting);
    if (
      observed.snapshot.file.bytes !== source.bytes
      || observed.snapshot.file.sha256 !== source.sha256
    ) {
      failObserved("changed", "A selected original source file no longer matches the source manifest.");
    }
    observedFacts.push(Object.freeze({
      path: source.path,
      bytes: observed.snapshot.file.bytes,
      sha256: observed.snapshot.file.sha256,
      observedAt: observed.snapshot.file.observedAt,
      signature: observed.signature,
    }));
  }
  return observedFacts;
}

async function recheckInitialSources(
  ctx: Context,
  plan: OwnedInitialPlan,
  first: Awaited<ReturnType<typeof observeInitialSources>>,
  charge: (bytes: number) => void,
  startCapture: () => void,
): Promise<void> {
  if (first.length !== plan.sources.length) {
    failObserved("changed", "The selected source observation set changed between passes.");
  }
  const accounting: ContentReadAccounting = {
    charge,
    maxFileBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_FILE_BYTES,
    maxTotalBytes: NATIVE_HARNESS_INITIAL_INPUTS_MAX_TOTAL_BYTES,
    totalBytes: 0,
  };
  for (let index = 0; index < first.length; index += 1) {
    const expected = first[index]!;
    startCapture();
    const again = await observeTextFile(ctx, plan.sourceRoot, expected.path, null, true, accounting);
    if (
      again.snapshot.file.bytes !== expected.bytes
      || again.snapshot.file.sha256 !== expected.sha256
      || !sameFileSignature(expected.signature, again.signature)
    ) {
      failObserved("changed", "A selected original source file changed between initial-input passes.");
    }
  }
}

function verifyInitialPreparedTree(plan: OwnedInitialPlan, tree: TreeObservation): void {
  if (tree.markerSignature !== null) {
    failObserved("unsupported", "The initial prepared workspace unexpectedly contains an origin marker.");
  }
  if (tree.excludedDirectory === null) {
    failObserved("missing", "The initial prepared workspace .git directory is missing.");
  }
  if (tree.fileCount !== plan.sources.length || tree.files.size !== plan.sources.length) {
    failObserved("unsupported", "The initial prepared regular files do not exactly match the input manifest.");
  }
  for (const source of plan.sources) {
    const file = tree.files.get(source.path);
    if (file === undefined) {
      failObserved("changed", "An initial prepared input is missing or extra ordinary files are present.");
    }
    if (
      file.snapshot.file.bytes !== source.bytes
      || file.snapshot.file.sha256 !== source.sha256
      || sizeOf(file.signature) !== source.bytes
      || file.signature.mode !== NATIVE_HARNESS_INITIAL_INPUTS_PREPARED_MODE
    ) {
      failObserved("changed", "An initial prepared input does not match its manifest bytes or mode 0600.");
    }
  }
}

/**
 * Reads the selected original inputs and the exact initial prepared workspace
 * twice: source pass 1, prepared pass 1, source pass 2, prepared pass 2. It
 * pins the layout and the excluded top-level `.git` directory without walking
 * it, and never calls the snapshot/base/stage capture generators.
 */
export async function observeNativeHarnessInitialInputsBytes(
  plan: NativeHarnessInitialInputsPlan,
  controls: NativeHarnessReconciliationContentByteControls,
): Promise<NativeHarnessInitialInputsByteResult> {
  const startedAt = performance.now();
  let chargeLimitBytes: number = NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES;
  const counters: InitialInputCounters = {
    captureStarts: 0,
    chargedBytes: 0,
    openedFiles: 0,
    activeFiles: 0,
    maxConcurrentOpenedFiles: 0,
    closeAttempted: 0,
    closeSettled: 0,
    closeSucceeded: 0,
    closeFailed: false,
  };
  let passesStarted: 0 | 1 | 2 = 0;
  const controlFailure: { value: OutputError | null } = { value: null };
  const closeError = { value: false };
  const halt = (): void => {
    if (counters.closeFailed || closeError.value) {
      fail(
        "io-failure",
        "An initial-input file handle did not confirm a successful close; no later initial-input effect was started.",
      );
    }
  };
  const charge = (bytes: number): void => {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      fail("io-failure", "An initial-input byte charge was not a bounded observed size.");
    }
    if (bytes > chargeLimitBytes - counters.chargedBytes) {
      fail("too-large", "The initial-input observation charge exceeds its fixed ceiling.");
    }
    counters.chargedBytes += bytes;
  };
  const startCapture = (): void => {
    halt();
    if (counters.captureStarts >= NATIVE_HARNESS_INITIAL_INPUTS_MAX_CAPTURES) {
      fail("too-large", "The initial-input observation exceeds its fixed capture-start bound.");
    }
    counters.captureStarts += 1;
  };
  try {
    if (typeof AbortSignal === "undefined") {
      fail("invalid-control", "The initial-input observer requires its fixed guard and actual signal.");
    }
    // Capture every control field once, before any plan read, callback or
    // await. Later caller mutation cannot replace the guard, signal or IO.
    const ownedControls = readInitialControls(controls);
    if (ownedControls.chargeLimitBytes !== null) {
      chargeLimitBytes = Math.min(
        ownedControls.chargeLimitBytes,
        NATIVE_HARNESS_INITIAL_INPUTS_MAX_CHARGED_BYTES,
      );
    }
    if (readActualAborted(ownedControls.signal)) {
      fail("aborted", "The initial-input observation signal was already aborted.");
    }
    const owned = readInitialInputsPlan(plan);
    const baseContext = {
      guard: ownedControls.guard,
      signal: ownedControls.signal,
      startedAt,
      contentControl: true as const,
      checkpoint: null,
      directories: new Map<string, DirectoryIdentity>(),
      closeError,
      controlFailure,
    };
    const countingIo = initialCountingIo(ownedControls.fileIo ?? nodeFileIo, counters);
    const ctx: Context = {
      ...baseContext,
      io: createGuardedIo(baseContext, initialEffectIo(countingIo, halt)),
    };
    assertAuthority(ctx);

    const storageIdentity = await observeRoot(ctx, owned.storageRoot, "initial storageRoot");
    await registerAncestry(ctx, storageIdentity, owned.preparedRoot, "initial preparedRoot");
    const preparedIdentity = await observeRoot(ctx, owned.preparedRoot, "initial preparedRoot");
    await registerAncestry(ctx, preparedIdentity, owned.workspaceRoot, "initial workspaceRoot");
    await observeRoot(ctx, owned.workspaceRoot, "initial workspaceRoot");
    await registerAncestry(ctx, preparedIdentity, owned.storeRoot, "initial storeRoot");
    await observeRoot(ctx, owned.storeRoot, "initial storeRoot");
    await registerAncestry(ctx, preparedIdentity, owned.runRoot, "initial runRoot");
    await observeRoot(ctx, owned.runRoot, "initial runRoot");
    await observeRoot(ctx, owned.sourceRoot, "initial sourceRoot");

    passesStarted = 1;
    const sourceFirst = await observeInitialSources(ctx, owned, charge, startCapture);
    const preparedFirst = await inventoryTree(
      ctx,
      preparedInitialTreeOptions(owned, charge, startCapture),
    );
    verifyInitialPreparedTree(owned, preparedFirst);

    passesStarted = 2;
    await recheckInitialSources(ctx, owned, sourceFirst, charge, startCapture);
    const preparedSecond = await inventoryTree(
      ctx,
      preparedInitialTreeOptions(owned, charge, startCapture),
    );
    verifyInitialPreparedTree(owned, preparedSecond);
    if (!sameContentTree(preparedFirst, preparedSecond)) {
      failObserved("changed", "The initial prepared workspace changed between byte passes.");
    }

    for (const [directoryPath, identity] of ctx.directories) {
      const info = await lstatOrFail(ctx, directoryPath, "initial-input directory");
      if (
        info.isSymbolicLink()
        || !info.isDirectory()
        || !sameDirectoryIdentity(identity, directoryIdentityOf(directoryPath, info))
      ) {
        fail("changed", "An initial-input directory identity changed during observation.");
      }
    }
    assertAuthority(ctx);
    if (closeError.value || counters.closeFailed || counters.activeFiles !== 0) {
      fail("io-failure", "An initial-input file handle reported a close failure or remained open.");
    }

    const preparedFiles = owned.sources.map((source) => {
      const file = preparedSecond.files.get(source.path);
      if (file === undefined) fail("changed", "A verified initial prepared file disappeared before its summary.");
      return Object.freeze({
        path: source.path,
        bytes: file.snapshot.file.bytes,
        sha256: file.snapshot.file.sha256,
        mode: file.signature.mode,
        observedAt: file.snapshot.file.observedAt,
      });
    });
    const sourceTotalBytes = sourceFirst.reduce((sum, fact) => sum + fact.bytes, 0);
    const preparedTotalBytes = preparedFiles.reduce((sum, fact) => sum + fact.bytes, 0);
    const sourceCaptureStarts = sourceFirst.length * 2;
    const preparedCaptureStarts = preparedFirst.files.size + preparedSecond.files.size;
    const observation: NativeHarnessInitialInputsByteObservation = deepFreeze({
      readOnly: true as const,
      resumeAvailable: false as const,
      semanticAcceptance: "not-evaluated" as const,
      processes: "not-inspected" as const,
      status: "stable" as const,
      observation: "two-pass" as const,
      runId: owned.runId,
      runSha256: owned.runSha256,
      sourceSha256: owned.sourceSha256,
      sourceBytes: owned.sourceBytes,
      manifestSha256: owned.manifestSha256,
      source: Object.freeze({
        root: owned.sourceRoot,
        files: Object.freeze(sourceFirst.map((fact) => Object.freeze({
          path: fact.path,
          bytes: fact.bytes,
          sha256: fact.sha256,
          observedAt: fact.observedAt,
        }))),
        totalBytes: sourceTotalBytes,
        captureStarts: sourceCaptureStarts,
      }),
      prepared: Object.freeze({
        root: owned.workspaceRoot,
        mode: NATIVE_HARNESS_INITIAL_INPUTS_PREPARED_MODE,
        files: Object.freeze(preparedFiles),
        totalBytes: preparedTotalBytes,
        captureStarts: preparedCaptureStarts,
        excluded: Object.freeze({
          path: ".git" as const,
          kind: "directory" as const,
          contents: "not-enumerated-not-hashed" as const,
          git: "not-started" as const,
          identity: "pinned-before-between-after" as const,
        }),
      }),
      passes: 2 as const,
      captureStarts: counters.captureStarts,
      chargedBytes: counters.chargedBytes,
      chargeLimitBytes,
      openedFiles: counters.openedFiles,
      maxConcurrentOpenedFiles: counters.maxConcurrentOpenedFiles,
      close: Object.freeze({
        attempted: counters.closeAttempted,
        settled: counters.closeSettled,
        succeeded: counters.closeSucceeded,
      }),
      limitations: INITIAL_INPUT_LIMITATIONS,
    });
    if (Buffer.byteLength(JSON.stringify(observation), "utf8")
      > NATIVE_HARNESS_OUTPUT_LIMITS.maxMetadataBytes) {
      fail("too-large", "The retained initial-input metadata exceeds its byte bound.");
    }
    return { ok: true, observation };
  } catch (error) {
    const failure = controlFailure.value !== null
      ? issuedFailures.get(controlFailure.value)
      : (error instanceof OutputError ? issuedFailures.get(error) : undefined);
    if (failure !== undefined) {
      return {
        ...failureResult(failure),
        ...initialFailureCounters(counters, chargeLimitBytes, passesStarted, closeError.value),
      };
    }
    const nativeCode = readOwnString(error, "code");
    if (nativeCode !== null && NATIVE_FILE_FAILURE_CODES.has(nativeCode)) {
      const code: NativeHarnessOutputFailure = nativeCode === "invalid-path" ? "unsafe-path"
        : nativeCode === "non-text" ? "unsupported"
        : nativeCode as NativeHarnessOutputFailure;
      return {
        ok: false,
        code,
        reason: boundedReason(readOwnString(error, "message") ?? "An initial-input observation was refused."),
        ...initialFailureCounters(counters, chargeLimitBytes, passesStarted, closeError.value),
      };
    }
    return {
      ok: false,
      code: isErrno(error, "ENOENT") ? "missing" : isErrno(error, "ELOOP") ? "unsafe-path" : "io-failure",
      reason: isErrno(error, "ENOENT")
        ? "An initial-input path disappeared during observation."
        : isErrno(error, "ELOOP")
          ? "An initial-input path is a symbolic link."
          : "The initial-input observation failed without a serializable host error.",
      ...initialFailureCounters(counters, chargeLimitBytes, passesStarted, closeError.value),
    };
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
