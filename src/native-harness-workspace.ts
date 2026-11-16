import { spawn, type SpawnOptions } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  sha256Hex,
  validateRelativePath,
} from "./native-work.ts";

/**
 * Narrow host-only preparation of a private Harness2 input workspace.
 *
 * The host selects every path in `hostConfig`; no model-controlled value is
 * accepted here. One call creates one unique private directory below an
 * already-private host-selected storage root, stages only the selected UTF-8
 * text files, initializes that private workspace as a local Git root, and
 * returns immutable facts about the bytes verified at return.
 *
 * This is a per-file copied snapshot. It is not an atomic multi-file snapshot,
 * an OS sandbox, a durability claim, or a promise about later source changes.
 * The future Controller adapter owns backend launch and post-run retention.
 */

export const NATIVE_HARNESS_WORKSPACE_SCHEMA = "omp-agent.native-harness-workspace.v1" as const;

export const NATIVE_HARNESS_WORKSPACE_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 256 * 1024,
  maxPathChars: 4096,
  gitTimeoutMs: 5000,
  gitOutputBytes: 4096,
});

const DEFAULT_GIT_EXECUTABLE = "/usr/bin/git";
const OWNED_PREFIX = "omp-harness-";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BIGINT_LSTAT = Object.freeze({ bigint: true as const });
const PRIVATE_DIRECTORY_OPTIONS = Object.freeze({ mode: PRIVATE_DIRECTORY_MODE });

/** Exact host data. `inputFiles` are host-selected POSIX paths below `sourceRoot`. */
export interface NativeHarnessWorkspaceHostConfig {
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly inputFiles: readonly string[];
}

/** Facts about the exact bytes verified in the private workspace at return. */
export interface NativeHarnessWorkspaceManifestEntry {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessWorkspaceDescriptor {
  readonly schema: typeof NATIVE_HARNESS_WORKSPACE_SCHEMA;
  /** Canonical source root actually read; not a rewritten or different root. */
  readonly sourceRoot: string;
  /** Unique directory created by this call and owned by the future adapter. */
  readonly preparedRoot: string;
  /** Private Git working tree containing only the selected input snapshots. */
  readonly workspaceRoot: string;
  /** Empty private sibling for the backend store; never part of the snapshot. */
  readonly storeRoot: string;
  readonly inputManifest: readonly NativeHarnessWorkspaceManifestEntry[];
  /** Hash of sorted `[relativePath, bytes, sha256]` triples, excluding timestamps. */
  readonly manifestSha256: string;
  readonly gitInitialized: true;
  readonly limitations: readonly string[];
}

export type NativeHarnessWorkspaceCheckpointPoint =
  | "after-owned-root"
  | "before-read"
  | "before-write"
  | "after-open"
  | "after-opendir"
  | "before-git"
  | "after-git";

/** Test-only observation event. Production callers must not pass test ports. */
export interface NativeHarnessWorkspaceCheckpoint {
  readonly point: NativeHarnessWorkspaceCheckpointPoint;
  readonly preparedRoot: string;
  readonly workspaceRoot: string;
  readonly storeRoot: string;
  readonly relativePath: string | null;
}

/** Narrow deterministic seams for adversarial tests; not production inputs. */
export interface NativeHarnessWorkspaceTestPorts {
  readonly gitExecutable?: string;
  readonly gitTimeoutMs?: number;
  readonly gitKillGraceMs?: number;
  readonly gitCloseGraceMs?: number;
  readonly checkpoint?: (event: NativeHarnessWorkspaceCheckpoint) => void | Promise<void>;
}

export type NativeHarnessWorkspaceFailureCode =
  | "invalid-config"
  | "invalid-root"
  | "unsafe-storage"
  | "reserved-input"
  | "duplicate-input"
  | "input-limit"
  | "unsafe-input"
  | "unsafe-destination"
  | "identity-changed"
  | "aborted"
  | "authority-lost"
  | "git-failed"
  | "git-timeout"
  | "git-cleanup-unknown"
  | "preparation-failed";

export interface NativeHarnessWorkspaceCleanup {
  readonly status: "not-needed" | "removed" | "preserved" | "unknown";
  readonly preparedRoot: string | null;
}

export class NativeHarnessWorkspaceError extends Error {
  override name = "NativeHarnessWorkspaceError";

  constructor(
    message: string,
    readonly code: NativeHarnessWorkspaceFailureCode,
    readonly preparedRoot: string | null = null,
    readonly cleanup: NativeHarnessWorkspaceCleanup["status"] = "not-needed",
    cause?: unknown,
  ) {
    super(boundedText(message, 512), cause === undefined ? undefined : { cause });
  }
}

const LIMITATIONS = Object.freeze([
  "Per-file copied snapshot of only the host-selected text files; not an atomic multi-file snapshot or an OS sandbox.",
  "Private bytes were re-read and matched to the manifest before return; source files may change afterwards.",
  "Created directories are mode 0700 and staged files mode 0600; original source permissions are not copied.",
  "Git metadata is initialized locally with a fresh home/config, an empty template and no commit, hooks or network.",
  "The shared safe source reader is bounded at 1 MiB; this profile's 256 KiB file and total limits are checked before and after that read.",
  "An already-admitted read or Git subprocess may finish after authority loss; abort is not a physical preemption claim.",
  "Root identities were checked before and after preparation; a same-user path race is still not physically excluded.",
]);

const OMITTED_DIRECTORIES = new Set([
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
  "node_modules",
  ".venv",
  "venv",
]);
// `.gitignore` is not in the vendored snapshot exclusion set, but this first
// profile refuses it so Git's exclude engine cannot silently omit a selected
// file from a later backend snapshot. The future Controller adapter must still
// compare its actual backend snapshot to the input manifest.
const AMBIENT_NAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  ".harness2-origin.json",
  ".gitignore",
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|service[-_]account[^/]*\.json)$|\.(?:pem|key|p12|pfx|keystore)$/i;

interface LiveContext {
  readonly guard: () => void;
  readonly signal: AbortSignal;
}

interface RootIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnedRoot {
  readonly path: string;
  readonly identity: RootIdentity;
  readonly workspaceRoot: string;
  readonly workspaceIdentity: RootIdentity;
  readonly storeRoot: string;
  readonly storeIdentity: RootIdentity;
  readonly gitHome: string;
  readonly gitTemplate: string;
  readonly gitHooks: string;
  readonly tmpRoot: string;
  readonly directories: readonly RootIdentity[];
}

interface WorkspaceContext extends LiveContext {
  readonly ports: NormalizedPorts;
  readonly source: RootIdentity;
  readonly storage: RootIdentity;
  readonly owned: OwnedRoot;
  readonly gitEnv: NodeJS.ProcessEnv;
  readonly manifest: NativeHarnessWorkspaceManifestEntry[];
  totalBytes: number;
}

interface NormalizedPorts {
  readonly gitExecutable: string;
  readonly gitTimeoutMs: number;
  readonly gitKillGraceMs: number;
  readonly gitCloseGraceMs: number;
  readonly checkpoint: ((event: NativeHarnessWorkspaceCheckpoint) => void | Promise<void>) | null;
}

interface PreparedConfig {
  readonly sourceRoot: string;
  readonly storageRoot: string;
  readonly inputFiles: readonly string[];
}

interface RunGitResult {
  readonly closed: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: Error | null;
  readonly controlError: Error | null;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

const ACTUAL_ADD_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.addEventListener;
  } catch {
    return null;
  }
})();

const ACTUAL_REMOVE_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.removeEventListener;
  } catch {
    return null;
  }
})();

function boundedText(value: string, max: number): string {
  const raw = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const normalized = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function fail(code: NativeHarnessWorkspaceFailureCode, message: string): never {
  throw new NativeHarnessWorkspaceError(message, code);
}

/** Correct containment: `..foo` is a child, not traversal. */
function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function signalAborted(signal: unknown): boolean | null {
  if (ACTUAL_ABORTED_GETTER === null) return null;
  try {
    const value: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function assertLive(live: LiveContext): void {
  const aborted = signalAborted(live.signal);
  if (aborted === null) fail("authority-lost", "the host AbortSignal is unreadable.");
  if (aborted) fail("aborted", "preparation was aborted.");
  // This is the final synchronous authority read. The caller performs its next
  // effect immediately after this returns, with no getter or host callback in
  // between.
  try {
    live.guard();
  } catch (error) {
    throw new NativeHarnessWorkspaceError(
      "the preparation guard rejected current authority.",
      "authority-lost",
      null,
      "not-needed",
      error,
    );
  }
}

function readActualSignal(signal: unknown): AbortSignal {
  if (ACTUAL_ABORTED_GETTER === null) fail("authority-lost", "the host AbortSignal aborted getter is unavailable.");
  const aborted = signalAborted(signal);
  if (aborted === null) fail("authority-lost", "the supplied signal is not a readable host AbortSignal.");
  if (aborted) fail("aborted", "preparation was aborted before any effect.");
  return signal as AbortSignal;
}

function addAbortListener(signal: AbortSignal, listener: () => void): (() => void) | null {
  if (ACTUAL_ADD_EVENT_LISTENER === null || ACTUAL_REMOVE_EVENT_LISTENER === null) return null;
  try {
    Reflect.apply(ACTUAL_ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
  } catch {
    return null;
  }
  return () => {
    try {
      Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
    } catch {
      // The signal is already unusable or has fired; no authority is granted.
    }
  };
}

function currentUid(): number | null {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return null;
  try {
    const uid = getuid.call(process);
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
  } catch {
    return null;
  }
}

function privateDirectory(info: BigIntStats): boolean {
  return (info.mode & 0o777n) === BigInt(PRIVATE_DIRECTORY_MODE)
    && (info.mode & 0o7000n) === 0n;
}

function privateFile(info: BigIntStats): boolean {
  return (info.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE)
    && (info.mode & 0o7000n) === 0n;
}

function assertPrivateDirectory(info: BigIntStats, label: string): void {
  if (!privateDirectory(info)) {
    fail("unsafe-storage", `${label} must have mode 0700 and no special bits.`);
  }
  const uid = currentUid();
  if (uid !== null && info.uid !== BigInt(uid)) {
    fail("unsafe-storage", `${label} must be owned by the current user.`);
  }
}

function assertPathBound(value: string, label: string): void {
  if (value.length < 1 || value.length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxPathChars || value.includes("\0")) {
    fail("invalid-config", `${label} exceeds the path bound.`);
  }
}

function readRootString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxPathChars
    || value.includes("\0")
    || /[\x00-\x1f\x7f]/.test(value)
    || !path.isAbsolute(value)
  ) {
    fail("invalid-config", `${label} must be an absolute path without NUL or control characters.`);
  }
  return value;
}

type StrictFields = ReadonlyMap<string, unknown>;

function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): StrictFields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string")) return null;
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  for (const key of required) if (!fields.has(key)) return null;
  return fields;
}

function readInputList(value: unknown): string[] {
  if (!Array.isArray(value)) fail("invalid-config", "inputFiles must be a plain array.");
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail("invalid-config", "inputFiles could not be inspected.");
  }
  if (prototype !== Array.prototype) fail("invalid-config", "inputFiles must be a plain array.");
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    fail("invalid-config", "inputFiles could not be inspected.");
  }
  const length = lengthDescriptor?.value;
  if (
    typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 1
    || length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles
  ) {
    fail("invalid-config", `inputFiles must select 1-${NATIVE_HARNESS_WORKSPACE_LIMITS.maxFiles} files.`);
  }
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail("invalid-config", "inputFiles could not be inspected.");
  }
  if (keys.length !== length + 1) fail("invalid-config", "inputFiles must not contain holes or extra properties.");
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail("invalid-config", "inputFiles could not be inspected.");
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
    ) {
      fail("invalid-config", "inputFiles entries must be enumerable own data strings.");
    }
    result.push(descriptor.value);
  }
  return result;
}

function isReservedInput(relativePath: string): boolean {
  return relativePath.split("/").some((part) => {
    const lower = part.toLowerCase();
    return OMITTED_DIRECTORIES.has(lower) || AMBIENT_NAMES.has(lower) || SECRET_NAME.test(part);
  });
}

function readHostConfig(value: unknown): PreparedConfig {
  const fields = readStrictFields(
    value,
    ["sourceRoot", "storageRoot", "inputFiles"],
    ["sourceRoot", "storageRoot", "inputFiles"],
  );
  if (fields === null) fail("invalid-config", "hostConfig must be an exact plain object with sourceRoot, storageRoot and inputFiles.");
  const sourceRoot = readRootString(fields.get("sourceRoot"), "sourceRoot");
  const storageRoot = readRootString(fields.get("storageRoot"), "storageRoot");
  const rawInputs = readInputList(fields.get("inputFiles"));
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawInputs) {
    let relative: string;
    try {
      relative = validateRelativePath(raw);
    } catch (error) {
      if (error instanceof NativeFileError) fail("invalid-config", error.message);
      throw error;
    }
    if (isReservedInput(relative)) {
      fail("reserved-input", `selected input ${relative} is a reserved ambient, dependency or secret path.`);
    }
    if (seen.has(relative)) fail("duplicate-input", `selected input ${relative} is duplicated.`);
    seen.add(relative);
    normalized.push(relative);
  }
  return { sourceRoot, storageRoot, inputFiles: Object.freeze(normalized) };
}

function readNumber(
  fields: StrictFields,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!fields.has(key)) return fallback;
  const value = fields.get(key);
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail("invalid-config", `${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function readTestPorts(value: unknown): NormalizedPorts {
  if (value === undefined) {
    return {
      gitExecutable: DEFAULT_GIT_EXECUTABLE,
      gitTimeoutMs: NATIVE_HARNESS_WORKSPACE_LIMITS.gitTimeoutMs,
      gitKillGraceMs: 500,
      gitCloseGraceMs: 2000,
      checkpoint: null,
    };
  }
  const fields = readStrictFields(
    value,
    ["gitExecutable", "gitTimeoutMs", "gitKillGraceMs", "gitCloseGraceMs", "checkpoint"],
    [],
  );
  if (fields === null) fail("invalid-config", "test ports must be an exact plain object.");
  let gitExecutable = DEFAULT_GIT_EXECUTABLE;
  if (fields.has("gitExecutable")) {
    const raw = fields.get("gitExecutable");
    if (
      typeof raw !== "string"
      || raw.length < 1
      || raw.length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxPathChars
      || raw.includes("\0")
      || !path.isAbsolute(raw)
    ) {
      fail("invalid-config", "gitExecutable must be an absolute path.");
    }
    gitExecutable = raw;
  }
  let checkpoint: NormalizedPorts["checkpoint"] = null;
  if (fields.has("checkpoint")) {
    const raw = fields.get("checkpoint");
    if (typeof raw !== "function") fail("invalid-config", "checkpoint must be a function.");
    checkpoint = raw as (event: NativeHarnessWorkspaceCheckpoint) => void | Promise<void>;
  }
  return {
    gitExecutable,
    gitTimeoutMs: readNumber(fields, "gitTimeoutMs", NATIVE_HARNESS_WORKSPACE_LIMITS.gitTimeoutMs, 1, NATIVE_HARNESS_WORKSPACE_LIMITS.gitTimeoutMs),
    gitKillGraceMs: readNumber(fields, "gitKillGraceMs", 500, 0, 5000),
    gitCloseGraceMs: readNumber(fields, "gitCloseGraceMs", 2000, 1, 5000),
    checkpoint,
  };
}

async function resolveRoot(
  live: LiveContext,
  input: string,
  label: "sourceRoot" | "storageRoot",
  requirePrivate: boolean,
): Promise<RootIdentity> {
  assertLive(live);
  let before: BigIntStats;
  try {
    before = await lstat(input, BIGINT_LSTAT);
  } catch (error) {
    if (isErrno(error, "ENOENT")) fail(requirePrivate ? "unsafe-storage" : "invalid-root", `${label} does not exist.`);
    throw error;
  }
  assertLive(live);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    fail(requirePrivate ? "unsafe-storage" : "invalid-root", `${label} must be an existing real directory, not a link.`);
  }
  if (requirePrivate) assertPrivateDirectory(before, label);
  assertLive(live);
  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch {
    fail("identity-changed", `${label} could not be resolved.`);
  }
  assertLive(live);
  assertPathBound(canonical, label);
  assertLive(live);
  let after: BigIntStats;
  try {
    after = await lstat(canonical, BIGINT_LSTAT);
  } catch {
    fail("identity-changed", `${label} changed while it was being resolved.`);
  }
  assertLive(live);
  if (
    after.isSymbolicLink()
    || !after.isDirectory()
    || after.dev !== before.dev
    || after.ino !== before.ino
  ) {
    fail("identity-changed", `${label} changed while it was being resolved.`);
  }
  if (requirePrivate) assertPrivateDirectory(after, label);
  return {
    path: canonical,
    dev: after.dev,
    ino: after.ino,
  };
}

function assertStorageOutsideSource(source: RootIdentity, storage: RootIdentity): void {
  if (isContained(source.path, storage.path) || isContained(storage.path, source.path)) {
    fail("invalid-root", "storageRoot must be strictly outside sourceRoot, not equal, inside or an ancestor.");
  }
}

async function verifyRoot(live: LiveContext, root: RootIdentity, requirePrivate: boolean): Promise<void> {
  const label = requirePrivate ? "storageRoot" : "sourceRoot";
  assertLive(live);
  let resolved: string;
  try {
    resolved = await realpath(root.path);
  } catch {
    fail("identity-changed", `${label} disappeared during preparation.`);
  }
  assertLive(live);
  if (resolved !== root.path) fail("identity-changed", `${label} was replaced or redirected during preparation.`);
  assertLive(live);
  let info: BigIntStats;
  try {
    info = await lstat(root.path, BIGINT_LSTAT);
  } catch {
    fail("identity-changed", `${label} disappeared during preparation.`);
  }
  assertLive(live);
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || info.dev !== root.dev
    || info.ino !== root.ino
  ) {
    fail("identity-changed", `${label} identity changed during preparation.`);
  }
  if (requirePrivate) assertPrivateDirectory(info, label);
}

async function inspectOwnedDirectory(
  live: LiveContext,
  target: string,
  parentCanonical: string,
  label: string,
): Promise<RootIdentity> {
  assertPathBound(target, label);
  assertLive(live);
  let first: BigIntStats;
  try {
    first = await lstat(target, BIGINT_LSTAT);
  } catch {
    fail("unsafe-destination", `${label} is missing.`);
  }
  assertLive(live);
  if (first.isSymbolicLink() || !first.isDirectory()) {
    fail("unsafe-destination", `${label} must be a real directory, not a link or special file.`);
  }
  assertPrivateDirectory(first, label);
  if (target === parentCanonical || !isContained(parentCanonical, target)) {
    fail("unsafe-destination", `${label} escaped its private parent.`);
  }
  assertLive(live);
  let resolved: string;
  try {
    resolved = await realpath(target);
  } catch {
    fail("unsafe-destination", `${label} could not be resolved.`);
  }
  assertLive(live);
  if (resolved !== target) fail("unsafe-destination", `${label} traverses a link.`);
  assertLive(live);
  let second: BigIntStats;
  try {
    second = await lstat(target, BIGINT_LSTAT);
  } catch {
    fail("identity-changed", `${label} disappeared while it was inspected.`);
  }
  assertLive(live);
  if (
    second.isSymbolicLink()
    || !second.isDirectory()
    || second.dev !== first.dev
    || second.ino !== first.ino
  ) {
    fail("identity-changed", `${label} changed while it was inspected.`);
  }
  assertPrivateDirectory(second, label);
  return {
    path: target,
    dev: second.dev,
    ino: second.ino,
  };
}

async function createOwnedDirectory(
  live: LiveContext,
  parentCanonical: string,
  target: string,
  label: string,
): Promise<RootIdentity> {
  assertPathBound(target, label);
  assertLive(live);
  try {
    await mkdir(target, PRIVATE_DIRECTORY_OPTIONS);
  } catch (error) {
    if (isErrno(error, "EEXIST")) fail("unsafe-destination", `${label} already exists; refusing to overwrite.`);
    throw error;
  }
  assertLive(live);
  return inspectOwnedDirectory(live, target, parentCanonical, label);
}

async function adoptOwnedRoot(
  live: LiveContext,
  storage: RootIdentity,
  root: string,
): Promise<RootIdentity> {
  return inspectOwnedDirectory(live, root, storage.path, "preparedRoot");
}

async function createOwnedChildren(
  live: LiveContext,
  storage: RootIdentity,
  root: string,
  rootIdentity: RootIdentity,
): Promise<OwnedRoot> {
  const workspaceRoot = path.join(root, "workspace");
  const storeRoot = path.join(root, "store");
  const gitHome = path.join(root, "git-home");
  const gitTemplate = path.join(root, "git-template");
  const gitHooks = path.join(root, "git-hooks");
  const tmpRoot = path.join(root, "tmp");
  const workspaceIdentity = await createOwnedDirectory(live, root, workspaceRoot, "workspaceRoot");
  const storeIdentity = await createOwnedDirectory(live, root, storeRoot, "storeRoot");
  const gitHomeIdentity = await createOwnedDirectory(live, root, gitHome, "git home");
  const gitTemplateIdentity = await createOwnedDirectory(live, root, gitTemplate, "git template");
  const gitHooksIdentity = await createOwnedDirectory(live, root, gitHooks, "git hooks");
  const tmpIdentity = await createOwnedDirectory(live, root, tmpRoot, "temporary directory");
  return Object.freeze({
    path: root,
    identity: rootIdentity,
    workspaceRoot,
    workspaceIdentity,
    storeRoot,
    storeIdentity,
    gitHome,
    gitTemplate,
    gitHooks,
    tmpRoot,
    directories: Object.freeze([
      rootIdentity,
      workspaceIdentity,
      storeIdentity,
      gitHomeIdentity,
      gitTemplateIdentity,
      gitHooksIdentity,
      tmpIdentity,
    ]),
  });
}

async function verifyOwnedDirectory(live: LiveContext, identity: RootIdentity): Promise<void> {
  assertLive(live);
  let resolved: string;
  try {
    resolved = await realpath(identity.path);
  } catch {
    fail("identity-changed", "a private preparation directory disappeared.");
  }
  assertLive(live);
  if (resolved !== identity.path) fail("identity-changed", "a private preparation directory was redirected.");
  assertLive(live);
  let info: BigIntStats;
  try {
    info = await lstat(identity.path, BIGINT_LSTAT);
  } catch {
    fail("identity-changed", "a private preparation directory disappeared.");
  }
  assertLive(live);
  if (
    info.isSymbolicLink()
    || !info.isDirectory()
    || info.dev !== identity.dev
    || info.ino !== identity.ino
  ) {
    fail("identity-changed", "a private preparation directory identity changed.");
  }
  assertPrivateDirectory(info, "private preparation directory");
}

async function verifyOwnedDirectories(ctx: WorkspaceContext): Promise<void> {
  for (const directory of ctx.owned.directories) await verifyOwnedDirectory(ctx, directory);
  if (path.dirname(ctx.owned.path) !== ctx.storage.path) {
    fail("identity-changed", "preparedRoot is no longer a direct child of storageRoot.");
  }
  if (path.dirname(ctx.owned.workspaceRoot) !== ctx.owned.path || path.dirname(ctx.owned.storeRoot) !== ctx.owned.path) {
    fail("identity-changed", "workspaceRoot and storeRoot are no longer preparedRoot siblings.");
  }
  if (
    isContained(ctx.owned.workspaceRoot, ctx.owned.storeRoot)
    || isContained(ctx.owned.storeRoot, ctx.owned.workspaceRoot)
  ) {
    fail("identity-changed", "workspaceRoot and storeRoot overlap.");
  }
}

async function ensureWorkspaceDirectory(
  ctx: WorkspaceContext,
  target: string,
): Promise<RootIdentity> {
  assertPathBound(target, "workspace directory");
  assertLive(ctx);
  let exists = true;
  try {
    await lstat(target, BIGINT_LSTAT);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    exists = false;
  }
  assertLive(ctx);
  if (!exists) {
    try {
      await mkdir(target, PRIVATE_DIRECTORY_OPTIONS);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    assertLive(ctx);
  }
  return inspectOwnedDirectory(ctx, target, ctx.owned.workspaceRoot, "workspace directory");
}

async function ensureWorkspaceParents(ctx: WorkspaceContext, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let cursor = ctx.owned.workspaceRoot;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(cursor, segment);
    if (next === ctx.owned.workspaceRoot || !isContained(ctx.owned.workspaceRoot, next)) {
      fail("unsafe-destination", "workspace parent escaped the private workspace.");
    }
    cursor = (await ensureWorkspaceDirectory(ctx, next)).path;
  }
  return cursor;
}

async function writePrivateFile(
  ctx: WorkspaceContext,
  destination: string,
  bytes: Buffer,
  relativePath: string,
): Promise<void> {
  assertPathBound(destination, "workspace file");
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0);
  assertLive(ctx);
  let handle;
  try {
    handle = await open(destination, flags, PRIVATE_FILE_MODE);
  } catch (error) {
    if (isErrno(error, "EEXIST") || isErrno(error, "ELOOP")) {
      fail("unsafe-destination", "the private destination already exists or is a link.");
    }
    throw error;
  }
  // The handle is inside the protected lifetime before the post-open authority
  // read, so a guard rejection cannot leave an open file descriptor behind.
  try {
    await checkpoint(ctx, "after-open", relativePath);
    assertLive(ctx);
    await handle.writeFile(bytes);
    assertLive(ctx);
    const written = await handle.stat({ bigint: true });
    assertLive(ctx);
    if (!written.isFile() || written.size !== BigInt(bytes.length)) {
      fail("preparation-failed", "the private file write did not produce the expected size.");
    }
    await handle.chmod(PRIVATE_FILE_MODE);
    assertLive(ctx);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
  await handle.close();
  assertLive(ctx);
}

async function stageFiles(ctx: WorkspaceContext, inputFiles: readonly string[]): Promise<void> {
  for (const relativePath of inputFiles) {
    await checkpoint(ctx, "before-read", relativePath);
    assertLive(ctx);
    await verifyRoot(ctx, ctx.source, false);
    assertLive(ctx);
    const segments = relativePath.split("/");
    const sourcePath = path.join(ctx.source.path, ...segments);
    assertPathBound(sourcePath, "source file");
    if (sourcePath === ctx.source.path || !isContained(ctx.source.path, sourcePath)) {
      fail("unsafe-input", "the selected source path escaped sourceRoot.");
    }
    assertLive(ctx);
    let sourceInfo: BigIntStats;
    try {
      sourceInfo = await lstat(sourcePath, BIGINT_LSTAT);
    } catch (error) {
      if (isErrno(error, "ENOENT")) fail("unsafe-input", `selected input ${relativePath} is missing.`);
      throw error;
    }
    assertLive(ctx);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
      fail("unsafe-input", `selected input ${relativePath} must be a regular non-link file.`);
    }
    if (
      sourceInfo.size > BigInt(NATIVE_HARNESS_WORKSPACE_LIMITS.maxFileBytes)
      || ctx.totalBytes + Number(sourceInfo.size) > NATIVE_HARNESS_WORKSPACE_LIMITS.maxTotalBytes
    ) {
      fail("input-limit", `selected input ${relativePath} exceeds the per-file or total byte limit.`);
    }
    const observedAt = Date.now();
    assertLive(ctx);
    let snapshot;
    try {
      // Existing safe read: a bounded 1 MiB read with O_NOFOLLOW, before/after
      // identity checks and BOM-retaining UTF-8 decoding. This module's smaller
      // 256 KiB per-file/total limits are enforced before and after that read.
      snapshot = await captureWorkspaceText(ctx.source.path, relativePath, undefined, observedAt);
    } catch (error) {
      if (error instanceof NativeFileError) {
        fail(error.code === "too-large" ? "input-limit" : "unsafe-input", error.message);
      }
      throw error;
    }
    assertLive(ctx);
    const file = snapshot.file;
    if (
      file.relativePath !== relativePath
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || file.bytes > NATIVE_HARNESS_WORKSPACE_LIMITS.maxFileBytes
      || ctx.totalBytes + file.bytes > NATIVE_HARNESS_WORKSPACE_LIMITS.maxTotalBytes
      || !/^[0-9a-f]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.observedAt)
      || file.observedAt < 0
    ) {
      fail("input-limit", `selected input ${relativePath} did not satisfy the bounded snapshot contract.`);
    }
    const bytes = Buffer.from(snapshot.text, "utf8");
    if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256) {
      fail("unsafe-input", `selected input ${relativePath} did not reproduce its observed bytes.`);
    }

    await checkpoint(ctx, "before-write", relativePath);
    assertLive(ctx);
    await verifyOwnedDirectories(ctx);
    assertLive(ctx);
    const parent = await ensureWorkspaceParents(ctx, relativePath);
    assertLive(ctx);
    const name = segments.at(-1)!;
    const destination = path.join(parent, name);
    assertPathBound(destination, "workspace file");
    if (destination === ctx.owned.workspaceRoot || !isContained(ctx.owned.workspaceRoot, destination)) {
      fail("unsafe-destination", "the private destination escaped workspaceRoot.");
    }
    await writePrivateFile(ctx, destination, bytes, relativePath);
    assertLive(ctx);
    ctx.totalBytes += bytes.length;
    ctx.manifest.push(Object.freeze({
      relativePath,
      bytes: file.bytes,
      sha256: file.sha256,
      observedAt: file.observedAt,
    }));
  }
}

async function verifyStagedFile(
  ctx: WorkspaceContext,
  entry: NativeHarnessWorkspaceManifestEntry,
): Promise<void> {
  assertLive(ctx);
  let snapshot;
  try {
    snapshot = await captureWorkspaceText(ctx.owned.workspaceRoot, entry.relativePath);
  } catch (error) {
    if (error instanceof NativeFileError) {
      fail("preparation-failed", `private snapshot ${entry.relativePath} could not be re-read: ${error.message}`);
    }
    throw error;
  }
  assertLive(ctx);
  if (
    snapshot.file.relativePath !== entry.relativePath
    || snapshot.file.bytes !== entry.bytes
    || snapshot.file.sha256 !== entry.sha256
  ) {
    fail("preparation-failed", `private snapshot ${entry.relativePath} does not match the manifest at return.`);
  }
  assertLive(ctx);
  const absolute = path.join(ctx.owned.workspaceRoot, ...entry.relativePath.split("/"));
  let info: BigIntStats;
  try {
    info = await lstat(absolute, BIGINT_LSTAT);
  } catch {
    fail("preparation-failed", `private snapshot ${entry.relativePath} disappeared before return.`);
  }
  assertLive(ctx);
  if (info.isSymbolicLink() || !info.isFile() || !privateFile(info)) {
    fail("preparation-failed", `private snapshot ${entry.relativePath} is not a mode-0600 regular file.`);
  }
}

async function verifyStagedManifest(ctx: WorkspaceContext): Promise<void> {
  for (const entry of ctx.manifest) await verifyStagedFile(ctx, entry);
}

async function verifyStoreEmpty(ctx: WorkspaceContext): Promise<void> {
  assertLive(ctx);
  let directory;
  try {
    directory = await opendir(ctx.owned.storeRoot);
  } catch {
    fail("preparation-failed", "storeRoot could not be opened.");
  }
  // The directory handle is closed on every path, including a guard rejection
  // immediately after the open and before the first entry read.
  try {
    await checkpoint(ctx, "after-opendir", null);
    assertLive(ctx);
    const first = await directory.read();
    assertLive(ctx);
    if (first !== null) fail("preparation-failed", "storeRoot must be empty at return.");
  } finally {
    await directory.close().catch(() => undefined);
  }
  assertLive(ctx);
}

function buildGitEnv(owned: OwnedRoot): NodeJS.ProcessEnv {
  return Object.freeze({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: owned.gitHome,
    XDG_CONFIG_HOME: owned.gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(owned.gitHome, ".gitconfig"),
    GIT_CEILING_DIRECTORIES: owned.path,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    TMPDIR: owned.tmpRoot,
    TMP: owned.tmpRoot,
    TEMP: owned.tmpRoot,
    LANG: "C",
    LC_ALL: "C",
    TERM: "dumb",
  });
}

function appendBounded(current: string, chunk: unknown): { text: string; truncated: boolean } {
  if (current.length >= NATIVE_HARNESS_WORKSPACE_LIMITS.gitOutputBytes) {
    return { text: current, truncated: true };
  }
  let buffer: Buffer;
  if (typeof chunk === "string") {
    buffer = Buffer.from(chunk, "utf8");
  } else if (chunk instanceof Uint8Array) {
    buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  } else {
    return { text: current, truncated: true };
  }
  const remaining = NATIVE_HARNESS_WORKSPACE_LIMITS.gitOutputBytes - current.length;
  const text = buffer.subarray(0, remaining).toString("utf8");
  return { text: `${current}${text}`, truncated: buffer.length > remaining };
}

async function runGit(
  ctx: WorkspaceContext,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunGitResult> {
  const options: SpawnOptions = {
    cwd,
    env: ctx.gitEnv,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  };
  const executable = ctx.ports.gitExecutable;
  assertLive(ctx);
  const child = spawn(executable, args, options);
  const pgid = process.platform !== "win32" && typeof child.pid === "number" ? child.pid : null;

  let closed = false;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | null = null;
  let controlError: Error | null = null;
  let code: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let resolveClose!: () => void;
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const settle = (): void => {
    if (closed) return;
    closed = true;
    resolveClose();
  };
  child.once("close", (exitCode, signal) => {
    code = exitCode;
    exitSignal = signal;
    settle();
  });
  child.once("error", (error) => {
    spawnError = error;
    if (child.pid === undefined) settle();
  });
  child.stdout?.on("data", (chunk: unknown) => {
    const next = appendBounded(stdout, chunk);
    stdout = next.text;
    stdoutTruncated = stdoutTruncated || next.truncated;
  });
  child.stderr?.on("data", (chunk: unknown) => {
    const next = appendBounded(stderr, chunk);
    stderr = next.text;
    stderrTruncated = stderrTruncated || next.truncated;
  });

  const groupState = (): "alive" | "gone" | "unknown" => {
    if (pgid === null) return "gone";
    try {
      process.kill(-pgid, 0);
      return "alive";
    } catch (error) {
      if (isErrno(error, "ESRCH")) return "gone";
      // EPERM or an unreadable result is not proof that the group is gone.
      return "unknown";
    }
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pgid !== null) {
      try {
        process.kill(-pgid, signal);
        return;
      } catch (error) {
        if (isErrno(error, "ESRCH")) return;
      }
    }
    if (child.pid !== undefined) {
      try {
        child.kill(signal);
      } catch {
        // The child was never started or has already been reaped.
      }
    }
  };
  const waitGroupGone = async (budgetMs: number): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (true) {
      const state = groupState();
      if (state === "gone") return true;
      if (state === "unknown") return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(20, remaining));
    }
  };
  const reapOwnedGroup = async (): Promise<"gone" | "unknown"> => {
    if (pgid === null) return "gone";
    const initial = groupState();
    if (initial === "gone") return "gone";
    if (initial === "unknown") return "unknown";
    signalGroup("SIGTERM");
    if (await waitGroupGone(ctx.ports.gitKillGraceMs)) return "gone";
    signalGroup("SIGKILL");
    return (await waitGroupGone(ctx.ports.gitCloseGraceMs)) ? "gone" : "unknown";
  };

  let terminationStarted = false;
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  let resolveKillSent!: () => void;
  const killSent = new Promise<void>((resolve) => {
    resolveKillSent = resolve;
  });
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const sendKill = (): void => {
    signalGroup("SIGKILL");
    resolveKillSent();
  };
  const terminate = (): void => {
    if (terminationStarted) return;
    terminationStarted = true;
    resolveTermination();
    signalGroup("SIGTERM");
    if (ctx.ports.gitKillGraceMs === 0) {
      sendKill();
      return;
    }
    killTimer = setTimeout(() => {
      sendKill();
    }, ctx.ports.gitKillGraceMs);
    (killTimer as { unref?: () => void }).unref?.();
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  (timeoutTimer as { unref?: () => void }).unref?.();
  const removeAbortListener = addAbortListener(ctx.signal, () => {
    aborted = true;
    terminate();
  });
  if (removeAbortListener === null) {
    controlError = new Error("the host AbortSignal cannot be observed for child cancellation");
    terminate();
  } else if (signalAborted(ctx.signal) === true) {
    aborted = true;
    terminate();
  }

  const first = await Promise.race([
    closePromise.then(() => "close" as const),
    termination.then(() => "termination" as const),
  ]);
  let closedInTime = first === "close";
  if (!closedInTime) {
    // A termination request has started. Wait for graceful close or for KILL
    // to be sent; the close grace must never preempt an unexecuted KILL timer.
    const killOrClose = await Promise.race([
      closePromise.then(() => "close" as const),
      killSent.then(() => "kill" as const),
    ]);
    closedInTime = killOrClose === "close" || closed;
    if (!closedInTime) {
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const grace = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), ctx.ports.gitCloseGraceMs);
        (graceTimer as { unref?: () => void }).unref?.();
      });
      closedInTime = await Promise.race([closePromise.then(() => true), grace]);
      if (graceTimer !== null) clearTimeout(graceTimer);
    }
  }
  clearTimeout(timeoutTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  removeAbortListener?.();

  const abandonWithLiveSubprocess = (): RunGitResult => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.unref();
    return {
      closed: false,
      timedOut,
      aborted,
      code,
      signal: exitSignal,
      spawnError,
      controlError,
      stdout,
      stdoutTruncated,
      stderr,
      stderrTruncated,
    };
  };
  if (!closedInTime || !closed) return abandonWithLiveSubprocess();

  // Direct-child close only proves that the child was reaped, not that a
  // redirected-stdio descendant in its detached process group is gone. Do not
  // report a closed subprocess or allow owned-directory cleanup until the
  // group is verified gone (or the host is told cleanup is unknown).
  const group = await reapOwnedGroup();
  if (group !== "gone") return abandonWithLiveSubprocess();
  return {
    closed: true,
    timedOut,
    aborted,
    code,
    signal: exitSignal,
    spawnError,
    controlError,
    stdout,
    stdoutTruncated,
    stderr,
    stderrTruncated,
  };
}

async function initGit(ctx: WorkspaceContext): Promise<void> {
  const initArgs = Object.freeze([
    "-c",
    `core.hooksPath=${ctx.owned.gitHooks}`,
    "init",
    "--quiet",
    `--template=${ctx.owned.gitTemplate}`,
    ctx.owned.workspaceRoot,
  ]);
  const init = await runGit(ctx, initArgs, ctx.owned.path, ctx.ports.gitTimeoutMs);
  if (!init.closed) {
    throw new NativeHarnessWorkspaceError(
      "git init did not close; the private area is preserved for host inspection.",
      "git-cleanup-unknown",
      ctx.owned.path,
      "preserved",
    );
  }
  assertLive(ctx);
  if (init.timedOut) {
    throw new NativeHarnessWorkspaceError("git init exceeded its bounded timeout.", "git-timeout");
  }
  if (init.controlError !== null || init.spawnError !== null || init.code !== 0 || init.signal !== null) {
    throw new NativeHarnessWorkspaceError("git init failed; no backend workspace was returned.", "git-failed");
  }

  const dotGit = path.join(ctx.owned.workspaceRoot, ".git");
  assertLive(ctx);
  let dotGitInfo: BigIntStats;
  try {
    dotGitInfo = await lstat(dotGit, BIGINT_LSTAT);
  } catch {
    fail("git-failed", "git init did not create private Git metadata.");
  }
  assertLive(ctx);
  if (dotGitInfo.isSymbolicLink() || !dotGitInfo.isDirectory()) {
    fail("git-failed", "private Git metadata is not a real directory.");
  }
  assertLive(ctx);
  let dotGitReal: string;
  try {
    dotGitReal = await realpath(dotGit);
  } catch {
    fail("git-failed", "private Git metadata could not be resolved.");
  }
  assertLive(ctx);
  if (dotGitReal !== dotGit) fail("git-failed", "private Git metadata traverses a link.");

  const revArgs = Object.freeze(["-C", ctx.owned.workspaceRoot, "rev-parse", "--show-toplevel"]);
  const rev = await runGit(ctx, revArgs, ctx.owned.path, ctx.ports.gitTimeoutMs);
  if (!rev.closed) {
    throw new NativeHarnessWorkspaceError(
      "git rev-parse did not close; the private area is preserved for host inspection.",
      "git-cleanup-unknown",
      ctx.owned.path,
      "preserved",
    );
  }
  assertLive(ctx);
  if (rev.timedOut) {
    throw new NativeHarnessWorkspaceError("git rev-parse exceeded its bounded timeout.", "git-timeout");
  }
  if (
    rev.controlError !== null
    || rev.spawnError !== null
    || rev.code !== 0
    || rev.signal !== null
    || rev.stdoutTruncated
  ) {
    throw new NativeHarnessWorkspaceError("git rev-parse failed; the private workspace root is unverified.", "git-failed");
  }
  const top = rev.stdout.trim();
  if (
    top.length < 1
    || top.length > NATIVE_HARNESS_WORKSPACE_LIMITS.maxPathChars
    || top.includes("\0")
    || /[\r\n]/.test(top)
    || !path.isAbsolute(top)
  ) {
    fail("git-failed", "git rev-parse returned an invalid root.");
  }
  assertLive(ctx);
  let canonicalTop: string;
  try {
    canonicalTop = await realpath(top);
  } catch {
    fail("git-failed", "git rev-parse root could not be resolved.");
  }
  assertLive(ctx);
  if (canonicalTop !== ctx.owned.workspaceRoot) {
    fail("git-failed", "git rev-parse did not confirm the private workspace as its actual root.");
  }
}

async function checkpoint(
  ctx: WorkspaceContext,
  point: NativeHarnessWorkspaceCheckpointPoint,
  relativePath: string | null,
): Promise<void> {
  const callback = ctx.ports.checkpoint;
  if (callback === null) return;
  const event: NativeHarnessWorkspaceCheckpoint = Object.freeze({
    point,
    preparedRoot: ctx.owned.path,
    workspaceRoot: ctx.owned.workspaceRoot,
    storeRoot: ctx.owned.storeRoot,
    relativePath,
  });
  // Test-only callback runs before the next authority read. No production
  // caller passes these ports.
  await callback(event);
}

function contentDigest(entries: readonly NativeHarnessWorkspaceManifestEntry[]): string {
  return sha256Hex(JSON.stringify(entries.map((entry) => [
    entry.relativePath,
    entry.bytes,
    entry.sha256,
  ])));
}

function buildDescriptor(ctx: WorkspaceContext): NativeHarnessWorkspaceDescriptor {
  const manifest = Object.freeze([...ctx.manifest].sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  )).map((entry) => Object.freeze({ ...entry })));
  const descriptor: NativeHarnessWorkspaceDescriptor = {
    schema: NATIVE_HARNESS_WORKSPACE_SCHEMA,
    sourceRoot: ctx.source.path,
    preparedRoot: ctx.owned.path,
    workspaceRoot: ctx.owned.workspaceRoot,
    storeRoot: ctx.owned.storeRoot,
    inputManifest: manifest,
    manifestSha256: contentDigest(manifest),
    gitInitialized: true,
    limitations: LIMITATIONS,
  };
  return deepFreeze(descriptor);
}

interface RootCleanup {
  readonly status: NativeHarnessWorkspaceCleanup["status"];
  readonly preparedRoot: string | null;
}

/**
 * Cleanup after an error. It intentionally does not consult the guard: removing
 * only this call's unique directory remains allowed after currentness is lost.
 * If the recorded identity is unavailable or no longer matches, the location is
 * preserved for the host rather than deleting a possibly replaced tree.
 */
async function cleanupPreparedRoot(
  rootPath: string,
  rootIdentity: RootIdentity | null,
  storage: RootIdentity,
  source: RootIdentity,
): Promise<RootCleanup> {
  if (rootIdentity === null) {
    return { status: "preserved", preparedRoot: rootPath };
  }
  const preserved: RootCleanup = { status: "preserved", preparedRoot: rootPath };
  try {
    const first = await lstat(rootPath, BIGINT_LSTAT);
    if (first.isSymbolicLink() || !first.isDirectory()) return preserved;
    if (first.dev !== rootIdentity.dev || first.ino !== rootIdentity.ino) return preserved;
    if (path.dirname(rootPath) !== storage.path) return preserved;
    if (!isContained(storage.path, rootPath) || rootPath === storage.path) return preserved;
    if (isContained(source.path, rootPath)) return preserved;
    const resolved = await realpath(rootPath);
    if (resolved !== rootPath) return preserved;
    const storageInfo = await lstat(storage.path, BIGINT_LSTAT);
    if (
      storageInfo.isSymbolicLink()
      || !storageInfo.isDirectory()
      || storageInfo.dev !== storage.dev
      || storageInfo.ino !== storage.ino
    ) {
      return preserved;
    }
    const again = await lstat(rootPath, BIGINT_LSTAT);
    if (
      again.isSymbolicLink()
      || !again.isDirectory()
      || again.dev !== rootIdentity.dev
      || again.ino !== rootIdentity.ino
    ) {
      return preserved;
    }
    await rm(rootPath, { recursive: true, force: false });
    return { status: "removed", preparedRoot: null };
  } catch {
    return { status: "unknown", preparedRoot: rootPath };
  }
}

function wrapError(error: unknown, cleanup: RootCleanup): NativeHarnessWorkspaceError {
  const code = error instanceof NativeHarnessWorkspaceError ? error.code : "preparation-failed";
  const message = error instanceof Error ? error.message : String(error);
  return new NativeHarnessWorkspaceError(
    message,
    code,
    cleanup.preparedRoot,
    cleanup.status,
    error,
  );
}

/**
 * Prepare one private snapshot and Git root.
 *
 * `guard` is a synchronous host authority check that must throw when the
 * original parent/session/work/signal/deadline is no longer valid. It is read
 * immediately before every new read/write/mkdir/subprocess effect and after
 * every await in this module. The actual `signal` is checked first; a guard
 * callback must not run after the signal is aborted. An already-admitted async
 * read or subprocess may finish; this is not a claim of physical preemption.
 *
 * The four-argument form with test ports is only for focused adversarial tests.
 */
export async function prepareNativeHarnessWorkspace(
  hostConfig: NativeHarnessWorkspaceHostConfig,
  guard: () => void,
  signal: AbortSignal,
  testPorts?: NativeHarnessWorkspaceTestPorts,
): Promise<NativeHarnessWorkspaceDescriptor> {
  if (typeof guard !== "function") {
    throw new NativeHarnessWorkspaceError("guard must be a synchronous host function.", "invalid-config");
  }
  const actualSignal = readActualSignal(signal);
  const ports = readTestPorts(testPorts);
  const config = readHostConfig(hostConfig);
  const live: LiveContext = { guard, signal: actualSignal };

  let source: RootIdentity | null = null;
  let storage: RootIdentity | null = null;
  let rootPath: string | null = null;
  let rootIdentity: RootIdentity | null = null;

  try {
    source = await resolveRoot(live, config.sourceRoot, "sourceRoot", false);
    storage = await resolveRoot(live, config.storageRoot, "storageRoot", true);
    assertStorageOutsideSource(source, storage);
    await verifyRoot(live, source, false);
    await verifyRoot(live, storage, true);

    const template = path.join(storage.path, OWNED_PREFIX);
    assertLive(live);
    rootPath = await mkdtemp(template);
    assertLive(live);
    assertPathBound(rootPath, "preparedRoot");
    rootIdentity = await adoptOwnedRoot(live, storage, rootPath);
    const owned = await createOwnedChildren(live, storage, rootPath, rootIdentity);
    const ctx: WorkspaceContext = {
      guard,
      signal: actualSignal,
      ports,
      source,
      storage,
      owned,
      gitEnv: buildGitEnv(owned),
      manifest: [],
      totalBytes: 0,
    };

    await checkpoint(ctx, "after-owned-root", null);
    assertLive(ctx);
    await verifyOwnedDirectories(ctx);
    await verifyRoot(ctx, source, false);
    await verifyRoot(ctx, storage, true);

    await stageFiles(ctx, config.inputFiles);

    await verifyRoot(ctx, source, false);
    await verifyRoot(ctx, storage, true);
    await verifyOwnedDirectories(ctx);
    await checkpoint(ctx, "before-git", null);
    assertLive(ctx);
    await verifyRoot(ctx, source, false);
    await verifyRoot(ctx, storage, true);
    await verifyOwnedDirectories(ctx);

    await initGit(ctx);

    await verifyRoot(ctx, source, false);
    await verifyRoot(ctx, storage, true);
    await verifyOwnedDirectories(ctx);
    await checkpoint(ctx, "after-git", null);
    assertLive(ctx);
    await verifyStagedManifest(ctx);
    await verifyStoreEmpty(ctx);
    await verifyOwnedDirectories(ctx);
    await verifyRoot(ctx, source, false);
    await verifyRoot(ctx, storage, true);

    const descriptor = buildDescriptor(ctx);
    // Final synchronous gate. The branch between this read and the return has
    // no further I/O, subprocess or host callback.
    assertLive(ctx);
    return descriptor;
  } catch (error) {
    if (rootPath === null || storage === null || source === null) {
      throw wrapError(error, { status: "not-needed", preparedRoot: null });
    }
    if (error instanceof NativeHarnessWorkspaceError && error.code === "git-cleanup-unknown") {
      throw wrapError(error, { status: "preserved", preparedRoot: rootPath });
    }
    const cleanup = await cleanupPreparedRoot(rootPath, rootIdentity, storage, source);
    throw wrapError(error, cleanup);
  }
}
