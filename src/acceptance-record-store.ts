import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
  linkSync,
} from "node:fs";
import path from "node:path";
import type { Stats } from "node:fs";
import type { FrozenTaskRef } from "./execution-candidates.ts";

/**
 * G2-B2-B1 host-only acceptance record store.
 *
 * It prepares one bounded immutable record in a private host directory and
 * installs it with a fixed synchronous no-overwrite local primitive. It never
 * selects policy, evaluates task semantics or exposes a writable callback.
 * Prepared, installed and accepted are distinct states.
 */

export const ACCEPTANCE_RECORD_VERSION = "g2b2b1-acceptance-v1";
export const MAX_ACCEPTANCE_RECORD_BYTES = 256 * 1024;
export const ACCEPTANCE_RECORD_POLICY_SOURCE = "automatic-host-contract";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FILE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class AcceptanceRecordError extends Error {
  override name = "AcceptanceRecordError";
}

export interface AcceptanceRoot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  /** Canonical root-to-leaf directory identities, including the root itself. */
  readonly chain: ReadonlyArray<Readonly<{ path: string; dev: number; ino: number }>>;
}

interface IssuedAcceptanceRoot {
  path: string;
  dev: number;
  ino: number;
  chain: ReadonlyArray<Readonly<{ path: string; dev: number; ino: number }>>;
  executionRoot: string;
  deliveryRoot: string | null;
}

export interface PreparedAcceptanceBinding {
  acceptanceId: string;
  deliveryId: string;
  acceptedAt: string;
  task: FrozenTaskRef;
  recordDigest: string;
}

/** Bounded host-only input for one prepared acceptance record. */
export interface PrepareAcceptanceRecordInput {
  root: AcceptanceRoot;
  acceptanceId: string;
  deliveryId: string;
  acceptedAt: string;
  task: FrozenTaskRef;
  record: unknown;
}

/**
 * Immutable record-store surface sourced from one loaded store module. The
 * owner captures the instance created by its own lexical module and the
 * acceptance service uses that instance for resolve/prepare/binding/read/
 * discard. Installation and postcommit maintenance are deliberately absent:
 * only the owner's fixed commit path may call them.
 */
export interface AcceptanceRecordStorePort {
  resolveRoot(configured: string, executionRoot: string, deliveryRoot: string | null): AcceptanceRoot;
  prepare(input: PrepareAcceptanceRecordInput): object;
  binding(value: object): PreparedAcceptanceBinding;
  read(root: AcceptanceRoot, acceptanceId: string, expectedTask?: FrozenTaskRef): AcceptanceRecordRead;
  discard(value: object): string[];
}

interface PreparedState {
  root: AcceptanceRoot;
  binding: PreparedAcceptanceBinding;
  finalPath: string;
  tempPath: string;
  bytes: Buffer;
  tempDev: number;
  tempIno: number;
  attempted: boolean;
  installed: boolean;
  result: AcceptanceInstallResult | undefined;
}

export type AcceptanceInstallStatus = "installed" | "conflict" | "not_installed" | "unknown";

export interface AcceptanceInstallResult {
  status: AcceptanceInstallStatus;
  reason: string | null;
  warnings: string[];
  /** Present only after a known successful linkSync publication. */
  recordPath: string | null;
  recordDigest: string | null;
}

const prepared = new WeakMap<object, PreparedState>();
/** Immutable issuer snapshot. Caller-shaped or copied descriptors never enter it. */
const issuedRoots = new WeakMap<object, IssuedAcceptanceRoot>();
const installedRecords = new Map<string, {
  root: string;
  rootDev: number;
  rootIno: number;
  ownerId: string;
  taskId: string;
  taskRevision: number;
  requirementsDigest: string;
  dev: number;
  ino: number;
  bytes: number;
  digest: string;
}>();

function registryKey(root: AcceptanceRoot, acceptanceId: string): string {
  return `${root.dev}:${root.ino}:${root.path}\0${acceptanceId}`;
}

function boundedStoreDiagnostic(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AcceptanceRecordError(`${label} must be a valid identifier.`);
  }
  return value;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalize(configured: string, label: string): string {
  if (typeof configured !== "string" || !path.isAbsolute(configured)) {
    throw new AcceptanceRecordError(`${label} must be an explicit absolute host path.`);
  }
  const resolved = path.resolve(configured);
  const name = path.basename(resolved);
  if (!name || name === "." || name === "..") {
    throw new AcceptanceRecordError(`${label} must name a directory.`);
  }
  if (existsSync(resolved)) {
    const info = lstatSync(resolved);
    if (info.isSymbolicLink()) throw new AcceptanceRecordError(`${label} must not be a symbolic link.`);
    if (!info.isDirectory()) throw new AcceptanceRecordError(`${label} must be an existing directory.`);
    const canonical = realpathSync(resolved);
    const canonicalInfo = lstatSync(canonical);
    if (!canonicalInfo.isDirectory()) throw new AcceptanceRecordError(`${label} did not resolve to a real directory.`);
    return canonical;
  }
  const parent = path.dirname(resolved);
  if (!existsSync(parent)) throw new AcceptanceRecordError(`${label}'s parent must already exist.`);
  const parentInfo = lstatSync(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new AcceptanceRecordError(`${label}'s parent must be a real directory.`);
  }
  try {
    mkdirSync(resolved, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const created = lstatSync(resolved);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new AcceptanceRecordError(`${label} was not created as a real directory.`);
  }
  return realpathSync(resolved);
}

function chainOf(canonical: string, label: string): Array<{ path: string; dev: number; ino: number }> {
  const parsed = path.parse(canonical);
  const chain: Array<{ path: string; dev: number; ino: number }> = [];
  let current = parsed.root;
  for (;;) {
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AcceptanceRecordError(`A canonical ${label} ancestor is not a real directory.`);
    }
    chain.push({ path: current, dev: info.dev, ino: info.ino });
    if (current === canonical) break;
    const relative = canonical.slice(current.length).split(path.sep).filter(Boolean);
    if (relative.length === 0) break;
    current = path.join(current, relative[0]!);
  }
  const leaf = chain[chain.length - 1];
  if (!leaf || leaf.path !== canonical) {
    throw new AcceptanceRecordError(`${label} canonical ancestry could not be proven.`);
  }
  return chain;
}

function assertRoot(root: AcceptanceRoot): IssuedAcceptanceRoot {
  if (typeof root !== "object" || root === null) {
    throw new AcceptanceRecordError("The acceptance root descriptor is not the privately issued canonical ancestry.");
  }
  const issued = issuedRoots.get(root);
  if (issued === undefined) {
    throw new AcceptanceRecordError("The acceptance root descriptor is copied or forged; it is not the privately issued canonical ancestry.");
  }
  if (!path.isAbsolute(issued.path)) {
    throw new AcceptanceRecordError("The acceptance root is not an absolute host directory.");
  }
  if (!Array.isArray(issued.chain) || issued.chain.length === 0) {
    throw new AcceptanceRecordError("The acceptance root ancestry is unavailable.");
  }
  for (const recorded of issued.chain) {
    if (typeof recorded !== "object"
      || recorded === null
      || !path.isAbsolute(recorded.path)
      || !Number.isSafeInteger(recorded.dev)
      || !Number.isSafeInteger(recorded.ino)) {
      throw new AcceptanceRecordError("The acceptance root ancestry is malformed.");
    }
    const info = lstatSync(recorded.path);
    if (info.isSymbolicLink()
      || !info.isDirectory()
      || info.dev !== recorded.dev
      || info.ino !== recorded.ino) {
      throw new AcceptanceRecordError("The acceptance root or one of its ancestors changed.");
    }
  }
  const leaf = issued.chain[issued.chain.length - 1]!;
  if (leaf.path !== issued.path || leaf.dev !== issued.dev || leaf.ino !== issued.ino) {
    throw new AcceptanceRecordError("The acceptance root ancestry does not prove the configured leaf.");
  }
  let canonical: string;
  try {
    canonical = realpathSync(issued.path);
  } catch {
    throw new AcceptanceRecordError("The acceptance root cannot be resolved to a real directory.");
  }
  if (canonical !== issued.path) {
    throw new AcceptanceRecordError("The acceptance root is not its own resolved canonical path.");
  }
  const expected = chainOf(issued.path, "acceptance root");
  if (expected.length !== issued.chain.length
    || expected.some((entry, index) => {
      const recorded = issued.chain[index]!;
      return recorded.path !== entry.path || recorded.dev !== entry.dev || recorded.ino !== entry.ino;
    })) {
    throw new AcceptanceRecordError("The acceptance root ancestry does not match the complete canonical ancestry.");
  }
  const info = lstatSync(issued.path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== issued.dev || info.ino !== issued.ino) {
    throw new AcceptanceRecordError("The acceptance root changed.");
  }
  if ((statSync(issued.path).mode & 0o077) !== 0) {
    throw new AcceptanceRecordError("The acceptance root must be private to the host user.");
  }
  for (const [label, other] of [
    ["executionRoot", issued.executionRoot],
    ["deliveryRoot", issued.deliveryRoot],
  ] as const) {
    if (other === null) continue;
    if (within(issued.path, other) || within(other, issued.path)) {
      throw new AcceptanceRecordError(`acceptanceRoot must not equal or overlap ${label}.`);
    }
  }
  return issued;
}

/**
 * Resolve the explicit private host record root. It must not equal or contain
 * the execution or delivery root (and may not be contained by them).
 */
export function resolveAcceptanceRoot(
  configured: string,
  executionRoot: string,
  deliveryRoot: string | null,
): AcceptanceRoot {
  const canonical = canonicalize(configured, "acceptanceRoot");
  const execution = existsSync(executionRoot) ? realpathSync(executionRoot) : path.resolve(executionRoot);
  const delivery = deliveryRoot === null ? null : (existsSync(deliveryRoot) ? realpathSync(deliveryRoot) : path.resolve(deliveryRoot));
  for (const [label, other] of [["executionRoot", execution], ["deliveryRoot", delivery]] as const) {
    if (other === null) continue;
    if (within(canonical, other) || within(other, canonical)) {
      throw new AcceptanceRecordError(`acceptanceRoot must not equal or overlap ${label}.`);
    }
  }
  const info = lstatSync(canonical);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new AcceptanceRecordError("acceptanceRoot is not a real directory.");
  }
  if ((statSync(canonical).mode & 0o077) !== 0) {
    throw new AcceptanceRecordError("acceptanceRoot must be private to the host user.");
  }
  const chain = Object.freeze(chainOf(canonical, "acceptanceRoot").map((entry) => Object.freeze({ ...entry })));
  const root: AcceptanceRoot = Object.freeze({
    path: canonical,
    dev: info.dev,
    ino: info.ino,
    chain,
  });
  issuedRoots.set(root, Object.freeze({
    path: canonical,
    dev: info.dev,
    ino: info.ino,
    chain,
    executionRoot: execution,
    deliveryRoot: delivery,
  }));
  return root;
}

const ACCEPTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Strictly bounded canonical host time. Noncanonical input is refused, never stored. */
function canonicalAcceptedAt(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24 || !ACCEPTED_AT.test(value)) {
    throw new AcceptanceRecordError("acceptedAt must be a bounded canonical ISO-8601 UTC timestamp.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new AcceptanceRecordError("acceptedAt must be a real calendar instant in canonical ISO-8601 UTC form.");
  }
  return value;
}

function fileComponent(value: unknown, label: string): string {
  if (typeof value !== "string" || !FILE_COMPONENT.test(value) || value === "." || value === "..") {
    throw new AcceptanceRecordError(`${label} must be a safe filename component.`);
  }
  return value;
}

function recordFileName(acceptanceId: string): string {
  return `record-${fileComponent(acceptanceId, "acceptanceId")}.json`;
}

function tempFileName(acceptanceId: string): string {
  return `.tmp-${fileComponent(acceptanceId, "acceptanceId")}-${randomUUID()}.json`;
}

function readExactSync(filePath: string, maxBytes: number): {
  data: Buffer;
  dev: number;
  ino: number;
  size: number;
} {
  const before = lstatSync(filePath);
  if (before.isSymbolicLink()) throw new AcceptanceRecordError("The record is a symbolic link.");
  if (!before.isFile()) throw new AcceptanceRecordError("The record is not an ordinary file.");
  if (before.size > maxBytes) throw new AcceptanceRecordError("The record exceeds its byte budget.");
  const handle = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size) {
      throw new AcceptanceRecordError("The record changed before it was opened.");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) throw new AcceptanceRecordError("The record changed while it was read.");
    const openedAfter = fstatSync(handle);
    if (openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || openedAfter.size !== opened.size) {
      throw new AcceptanceRecordError("The record changed during the read.");
    }
    const after = lstatSync(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new AcceptanceRecordError("The record path was replaced during the read.");
    }
    return {
      data: Buffer.from(buffer.subarray(0, offset)),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
    };
  } finally {
    closeSync(handle);
  }
}

function cleanupTempIdentity(tempPath: string, dev: number, ino: number): string[] {
  const warnings: string[] = [];
  try {
    const info = lstatSync(tempPath);
    if (info.isSymbolicLink() || !info.isFile() || info.dev !== dev || info.ino !== ino) {
      warnings.push("prepared_temp_cleanup_withheld: the temporary record identity changed");
      return warnings;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return warnings;
    warnings.push(`prepared_temp_cleanup_withheld: ${errorMessage(error)}`);
    return warnings;
  }
  try {
    unlinkSync(tempPath);
  } catch (error) {
    warnings.push(`prepared_temp_cleanup_failed: ${errorMessage(error)}`);
  }
  return warnings;
}

function cleanupOwnTemp(state: PreparedState): string[] {
  return cleanupTempIdentity(state.tempPath, state.tempDev, state.tempIno);
}

/**
 * Write one bounded record to a host-private `wx` temporary file, fsync and
 * verify its exact bytes. The returned object is opaque to model-facing code.
 */
export function prepareAcceptanceRecord(input: PrepareAcceptanceRecordInput): object {
  const issued = assertRoot(input.root);
  const root = input.root;
  const acceptanceId = fileComponent(input.acceptanceId, "acceptanceId");
  const deliveryId = identifier(input.deliveryId, "deliveryId");
  const acceptedAt = canonicalAcceptedAt(input.acceptedAt);
  const task: FrozenTaskRef = {
    ownerId: identifier(input.task.ownerId, "ownerId"),
    taskId: identifier(input.task.taskId, "taskId"),
    taskRevision: input.task.taskRevision,
    requirementsDigest: identifier(input.task.requirementsDigest, "requirementsDigest"),
  };
  if (!Number.isSafeInteger(task.taskRevision) || task.taskRevision <= 0) {
    throw new AcceptanceRecordError("taskRevision must be a positive integer.");
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(input.record);
  } catch {
    throw new AcceptanceRecordError("The acceptance record is not JSON-encodable.");
  }
  if (encoded === undefined) throw new AcceptanceRecordError("The acceptance record is not JSON-encodable.");
  const bytes = Buffer.from(encoded, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_ACCEPTANCE_RECORD_BYTES) {
    throw new AcceptanceRecordError(`The acceptance record must be 1-${MAX_ACCEPTANCE_RECORD_BYTES} UTF-8 bytes.`);
  }
  const finalPath = path.join(issued.path, recordFileName(acceptanceId));
  if (existsSync(finalPath)) {
    throw new AcceptanceRecordError("An acceptance record already exists for this acceptance id.");
  }
  let tempPath = "";
  let handle = -1;
  let tempDev = 0;
  let tempIno = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(issued.path, tempFileName(acceptanceId));
    try {
      handle = openSync(candidate, "wx", 0o400);
      tempPath = candidate;
      const opened = fstatSync(handle);
      tempDev = opened.dev;
      tempIno = opened.ino;
      break;
    } catch (error) {
      if (handle >= 0) {
        closeSync(handle);
        handle = -1;
        tempPath = "";
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (handle < 0 || !tempPath) throw new AcceptanceRecordError("Could not allocate a unique temporary acceptance record.");
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new AcceptanceRecordError("The temporary acceptance record was not fully written.");
      offset += written;
    }
    fsyncSync(handle);
    const opened = fstatSync(handle);
    if (opened.dev !== tempDev || opened.ino !== tempIno || opened.size !== bytes.length) {
      throw new AcceptanceRecordError("The temporary acceptance record changed while it was written.");
    }
  } catch (error) {
    closeSync(handle);
    cleanupTempIdentity(tempPath, tempDev, tempIno);
    throw error;
  }
  closeSync(handle);
  try {
    const info = lstatSync(tempPath);
    if (info.isSymbolicLink()
      || !info.isFile()
      || info.dev !== tempDev
      || info.ino !== tempIno
      || info.size !== bytes.length) {
      throw new AcceptanceRecordError("The temporary acceptance record has an unexpected identity or size.");
    }
    const readBack = readExactSync(tempPath, MAX_ACCEPTANCE_RECORD_BYTES);
    if (readBack.dev !== tempDev || readBack.ino !== tempIno || !readBack.data.equals(bytes)) {
      throw new AcceptanceRecordError("The temporary acceptance record did not round-trip to the same bytes.");
    }
  } catch (error) {
    cleanupTempIdentity(tempPath, tempDev, tempIno);
    throw error;
  }
  const binding: PreparedAcceptanceBinding = {
    acceptanceId,
    deliveryId,
    acceptedAt,
    task,
    recordDigest: sha256(bytes),
  };
  const state: PreparedState = {
    root,
    binding,
    finalPath,
    tempPath,
    bytes,
    tempDev,
    tempIno,
    attempted: false,
    installed: false,
    result: undefined,
  };
  const token = Object.freeze({});
  prepared.set(token, state);
  return token;
}

/** Host-only safe binding read; a copied or forged prepared object is refused. */
export function preparedAcceptanceBinding(value: object): PreparedAcceptanceBinding {
  const state = typeof value === "object" && value !== null ? prepared.get(value) : undefined;
  if (state === undefined) throw new AcceptanceRecordError("The prepared acceptance record was not issued by this store.");
  return {
    ...state.binding,
    task: { ...state.binding.task },
  };
}

function lstatMaybe(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Fixed synchronous no-overwrite installation. `linkSync` is the commit
 * point; a successful return is irreversible even if later cleanup fails.
 * There is no user-supplied writer or validator in this path.
 */
export function installPreparedAcceptanceRecordSync(value: object): AcceptanceInstallResult {
  const state = typeof value === "object" && value !== null ? prepared.get(value) : undefined;
  if (state === undefined) throw new AcceptanceRecordError("The prepared acceptance record was not issued by this store.");
  if (state.attempted) throw new AcceptanceRecordError("A prepared acceptance record can be installed only once.");
  state.attempted = true;
  const warnings: string[] = [];
  const result = (status: AcceptanceInstallStatus, reason: string | null): AcceptanceInstallResult => ({
    status,
    reason,
    warnings,
    recordPath: status === "installed" ? state.finalPath : null,
    recordDigest: status === "installed" ? state.binding.recordDigest : null,
  });
  let issued: IssuedAcceptanceRoot;
  try {
    issued = assertRoot(state.root);
  } catch (error) {
    warnings.push(...cleanupOwnTemp(state));
    return result("not_installed", errorMessage(error));
  }
  try {
    const temp = lstatSync(state.tempPath);
    if (temp.isSymbolicLink()
      || !temp.isFile()
      || temp.dev !== state.tempDev
      || temp.ino !== state.tempIno
      || temp.size !== state.bytes.length) {
      warnings.push("prepared_record_identity_changed");
      return result("not_installed", "The prepared record temporary file changed before installation.");
    }
    const rechecked = readExactSync(state.tempPath, MAX_ACCEPTANCE_RECORD_BYTES);
    if (!rechecked.data.equals(state.bytes)) {
      warnings.push("prepared_record_bytes_changed");
      return result("not_installed", "The prepared record bytes changed before installation.");
    }
  } catch (error) {
    warnings.push(...cleanupOwnTemp(state));
    return result("not_installed", `The prepared record could not be rechecked: ${errorMessage(error)}`);
  }
  let existing: Stats | null;
  try {
    existing = lstatMaybe(state.finalPath);
  } catch (error) {
    // No link was attempted, so the record cannot have been installed.
    warnings.push(...cleanupOwnTemp(state));
    return result("not_installed", `The final record path could not be checked: ${errorMessage(error)}`);
  }
  if (existing !== null) {
    warnings.push(...cleanupOwnTemp(state));
    return result("conflict", "An object already exists at the host-generated acceptance record path.");
  }
  const markInstalled = (): AcceptanceInstallResult => {
    state.installed = true;
    installedRecords.set(registryKey(issued, state.binding.acceptanceId), {
      root: issued.path,
      rootDev: issued.dev,
      rootIno: issued.ino,
      ownerId: state.binding.task.ownerId,
      taskId: state.binding.task.taskId,
      taskRevision: state.binding.task.taskRevision,
      requirementsDigest: state.binding.task.requirementsDigest,
      dev: state.tempDev,
      ino: state.tempIno,
      bytes: state.bytes.length,
      digest: state.binding.recordDigest,
    });
    state.result = result("installed", null);
    return state.result;
  };
  try {
    linkSync(state.tempPath, state.finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A thrown link is normally a known failed link. It may be proven installed
    // only when the final path is the exact same inode and bytes as our own
    // prepared temporary file; unrelated identical JSON is never adopted.
    try {
      const after = lstatMaybe(state.finalPath);
      if (after === null) {
        warnings.push(...cleanupOwnTemp(state));
        return result("not_installed", `The no-overwrite record link failed (${code ?? errorMessage(error)}).`);
      }
      if (after.isSymbolicLink()
        || !after.isFile()
        || after.dev !== state.tempDev
        || after.ino !== state.tempIno
        || after.size !== state.bytes.length) {
        warnings.push(...cleanupOwnTemp(state));
        return result("conflict", "The acceptance record target exists and is not this prepared file.");
      }
      const finalRead = readExactSync(state.finalPath, MAX_ACCEPTANCE_RECORD_BYTES);
      if (finalRead.dev !== state.tempDev
        || finalRead.ino !== state.tempIno
        || !finalRead.data.equals(state.bytes)) {
        return result("unknown", "The record link failed and the final path could not be proven to contain this prepared file.");
      }
      warnings.push(boundedStoreDiagnostic(
        `record_link_reported_error_after_installation: ${code ?? errorMessage(error)}`,
        240,
      ));
      return markInstalled();
    } catch (checkError) {
      return result("unknown", `The record link failed and the final path could not be classified: ${checkError instanceof Error ? checkError.message : String(checkError)}`);
    }
  }
  // linkSync returned success: this is a known committed publication.
  return markInstalled();
}

/**
 * Discard an un-attempted prepared record before any link was attempted. This
 * removes only the store's proven temporary inode and never a final record.
 */
export function discardPreparedAcceptanceRecordSync(value: object): string[] {
  const state = typeof value === "object" && value !== null ? prepared.get(value) : undefined;
  if (state === undefined || state.installed || state.attempted) return [];
  return cleanupOwnTemp(state);
}

/**
 * Postcommit maintenance. Call only after the owner has installed the accepted
 * terminal fact. Cleanup and directory fsync failures are warnings; they never
 * change the already-committed installation fact.
 */
export function maintainInstalledAcceptanceRecordSync(value: object): string[] {
  const state = typeof value === "object" && value !== null ? prepared.get(value) : undefined;
  if (state === undefined || !state.installed) {
    return ["postcommit_maintenance_skipped: the record was not installed by this store"];
  }
  const warnings: string[] = [];
  warnings.push(...cleanupOwnTemp(state));
  try {
    const issued = assertRoot(state.root);
    const dir = openSync(issued.path, constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    warnings.push(`acceptance_root_fsync_failed: ${errorMessage(error)}`);
  }
  return warnings;
}

export interface AcceptanceRecordRead {
  state: "intact" | "missing" | "changed" | "unavailable";
  reason: string | null;
  bytes: number | null;
  digest: string | null;
}

/** Read the one accepted record without interpreting task semantics. */
export function readAcceptanceRecord(
  root: AcceptanceRoot,
  acceptanceId: string,
  expectedTask?: FrozenTaskRef,
): AcceptanceRecordRead {
  try {
    const issued = assertRoot(root);
    const filePath = path.join(issued.path, recordFileName(acceptanceId));
    const info = lstatMaybe(filePath);
    if (info === null) return { state: "missing", reason: "the acceptance record file is missing", bytes: null, digest: null };
    if (info.isSymbolicLink() || !info.isFile()) {
      return { state: "changed", reason: "the acceptance record path is not an ordinary file", bytes: null, digest: null };
    }
    if (info.size > MAX_ACCEPTANCE_RECORD_BYTES) {
      return { state: "changed", reason: "the acceptance record exceeds its byte budget", bytes: info.size, digest: null };
    }
    const registered = installedRecords.get(registryKey(issued, acceptanceId));
    if (registered === undefined
      || registered.root !== issued.path
      || registered.rootDev !== issued.dev
      || registered.rootIno !== issued.ino) {
      return { state: "unavailable", reason: "this process did not install that acceptance record under this root", bytes: null, digest: null };
    }
    if (expectedTask !== undefined
      && (registered.ownerId !== expectedTask.ownerId
        || registered.taskId !== expectedTask.taskId
        || registered.taskRevision !== expectedTask.taskRevision
        || registered.requirementsDigest !== expectedTask.requirementsDigest)) {
      return { state: "unavailable", reason: "the installed acceptance record belongs to a different task binding", bytes: null, digest: null };
    }
    const read = readExactSync(filePath, MAX_ACCEPTANCE_RECORD_BYTES);
    if (read.dev !== registered.dev
      || read.ino !== registered.ino
      || read.size !== registered.bytes) {
      return {
        state: "changed",
        reason: "the installed acceptance record was replaced by a different file identity",
        bytes: read.size,
        digest: sha256(read.data),
      };
    }
    const digest = sha256(read.data);
    if (digest !== registered.digest) {
      return { state: "changed", reason: "the installed acceptance record bytes changed", bytes: read.size, digest };
    }
    return {
      state: "intact",
      reason: null,
      bytes: read.size,
      digest,
    };
  } catch (error) {
    return { state: "unavailable", reason: errorMessage(error), bytes: null, digest: null };
  }
}

/** Record path helper for host diagnostics only; never model-facing. */
export function acceptanceRecordPath(root: AcceptanceRoot, acceptanceId: string): string {
  return path.join(assertRoot(root).path, recordFileName(acceptanceId));
}

/**
 * One frozen port bound to this module instance's private issuer registries.
 * Owner construction captures it; the acceptance coordinator captures the
 * owner's instance before any await. Callers cannot inject a port or writer.
 */
const RECORD_STORE_PORT: AcceptanceRecordStorePort = Object.freeze({
  resolveRoot: resolveAcceptanceRoot,
  prepare: prepareAcceptanceRecord,
  binding: preparedAcceptanceBinding,
  read: readAcceptanceRecord,
  discard: discardPreparedAcceptanceRecordSync,
});

export function acceptanceRecordStorePort(): AcceptanceRecordStorePort {
  return RECORD_STORE_PORT;
}

export { within as acceptancePathWithin };
