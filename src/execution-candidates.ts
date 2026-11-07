import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Host-only registry of real archived execution candidates for G2-B1a.
 *
 * Registration is reachable only from the trusted ExecutionAdapter archive
 * path. Callers that need evidence receive a read port: an independent
 * metadata snapshot plus independent byte copies. No path, registry object or
 * Buffer held internally is ever handed out.
 */

export const CANDIDATE_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_REGISTRATION_VERSION = "candidate-registration-v1" as const;
/** Existing ceiling is 8 runs x 8 artifacts per task. */
export const MAX_CANDIDATES_PER_TASK = 64;
export const MAX_CANDIDATES_PER_RUN = 8;
export const MAX_SELECTED_ARTIFACTS = 8;
export const MAX_CANDIDATE_ARTIFACT_BYTES = 256 * 1024;
export const MAX_CANDIDATE_ARTIFACT_TOTAL_BYTES = 1024 * 1024;
export const MAX_CANDIDATE_SOURCE_BYTES = 32 * 1024;
export const MAX_CANDIDATE_INPUT_BYTES = 256 * 1024;
export const MAX_CANDIDATE_INPUT_TOTAL_BYTES = 1024 * 1024;
export const MAX_CANDIDATE_INPUTS = 8;
export const MAX_SNAPSHOTS = 64;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type CandidateErrorCode =
  | "invalid"
  | "unsafe-path"
  | "changed"
  | "limit"
  | "conflict"
  | "unknown-candidate"
  | "unknown-snapshot";

export class CandidateError extends Error {
  override name = "CandidateError";
  constructor(message: string, readonly code: CandidateErrorCode) {
    super(message);
  }
}

export interface FrozenTaskRef {
  ownerId: string;
  taskId: string;
  taskRevision: number;
  requirementsDigest: string;
}

export interface CandidateSourceRegistration {
  /** Absolute host-private staged source path. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface CandidateInputRegistration {
  id: string;
  /** Absolute host-private staged input path. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface CandidateArtifactRegistration {
  artifactId: string;
  relativePath: string;
  /** Absolute host-private archive path. */
  archivePath: string;
  bytes: number;
  sha256: string;
}

export interface CandidateProvenance {
  spawned: boolean;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  signal: string | null;
  stopReason: string | null;
  terminatedByHost: boolean;
  groupGone: boolean;
  launchStage: string;
  durationMs: number;
  watchdogArmed: boolean;
  watchdogTerminated: boolean | null;
  watchdogControlError: string | null;
  afterSpawnHostRecordError: string | null;
  finalRecordError: string | null;
  artifactExportError: string | null;
}

/** Trusted adapter-to-registry input. Never accepts model or tool JSON. */
export interface CandidateRegistration {
  task: FrozenTaskRef;
  runId: string;
  callId: string;
  privateRoot: string;
  source: CandidateSourceRegistration;
  inputs: readonly CandidateInputRegistration[];
  artifacts: readonly CandidateArtifactRegistration[];
  provenance: CandidateProvenance;
  registeredAt: string;
}

export interface CandidateSelector {
  runId: string;
  artifactIds: readonly string[];
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  sha256: string;
}

export interface CandidateArtifactSnapshot {
  artifactId: string;
  relativePath: string;
  bytes: number;
  sha256: string;
  data: Buffer;
  identity: FileIdentity;
}

export interface CandidateInputSnapshot {
  id: string;
  bytes: number;
  sha256: string;
  data: Buffer;
  identity: FileIdentity;
}

export interface CandidateSourceSnapshot {
  bytes: number;
  sha256: string;
  data: Buffer;
  identity: FileIdentity;
}

export interface CandidateSnapshot {
  schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
  snapshotId: string;
  task: FrozenTaskRef;
  runId: string;
  callId: string;
  source: CandidateSourceSnapshot;
  inputs: CandidateInputSnapshot[];
  artifacts: CandidateArtifactSnapshot[];
  provenance: CandidateProvenance;
  registeredAt: string;
  createdAt: string;
}

export interface CandidateReadPort {
  resolveSnapshot(expectedTask: FrozenTaskRef, selector: CandidateSelector): Promise<CandidateSnapshot>;
  recheckSnapshot(snapshotId: string, expectedTask: FrozenTaskRef): Promise<CandidateSnapshot>;
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface StoredCandidate {
  key: string;
  task: FrozenTaskRef;
  runId: string;
  callId: string;
  privateRoot: string;
  directories: DirectoryIdentity[];
  source: CandidateSourceRegistration;
  inputs: CandidateInputRegistration[];
  artifact: CandidateArtifactRegistration;
  provenance: CandidateProvenance;
  registeredAt: string;
  registrationDigest: string;
}

interface SnapshotRecord {
  snapshotId: string;
  task: FrozenTaskRef;
  runId: string;
  callId: string;
  keys: string[];
  source: FileIdentity;
  inputs: Array<{ id: string; identity: FileIdentity }>;
  artifacts: Array<{ artifactId: string; identity: FileIdentity }>;
  createdAt: string;
}

interface ReadFileResult {
  data: Buffer;
  sha256: string;
  identity: FileIdentity;
  directories: DirectoryIdentity[];
}

function sha256(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CandidateError(`${label} is not a valid identifier.`, "invalid");
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CandidateError(`${label} must be a non-negative integer.`, "invalid");
  }
  return value;
}

function absolute(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new CandidateError(`${label} must be an absolute host path.`, "invalid");
  }
  return value;
}

function contained(privateRoot: string, candidate: string, label: string): void {
  const relative = path.relative(privateRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CandidateError(`${label} is outside the host-private execution root.`, "unsafe-path");
  }
}

function relativeName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\\") || path.isAbsolute(value)) {
    throw new CandidateError("Candidate relative path is invalid.", "invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /[\x00-\x1f\x7f]/.test(segment))) {
    throw new CandidateError("Candidate relative path contains an empty or traversing segment.", "invalid");
  }
  return value;
}

function normalizeTask(task: FrozenTaskRef): FrozenTaskRef {
  if (typeof task !== "object" || task === null) throw new CandidateError("Frozen task reference must be an object.", "invalid");
  const ownerId = identifier(task.ownerId, "ownerId");
  const taskId = identifier(task.taskId, "taskId");
  if (!Number.isSafeInteger(task.taskRevision) || task.taskRevision <= 0) {
    throw new CandidateError("taskRevision must be a positive integer.", "invalid");
  }
  if (typeof task.requirementsDigest !== "string" || !/^requirements-digest-v1:sha256:[0-9a-f]{64}$/.test(task.requirementsDigest)) {
    throw new CandidateError("requirementsDigest is not a frozen requirements-digest-v1 value.", "invalid");
  }
  return { ownerId, taskId, taskRevision: task.taskRevision, requirementsDigest: task.requirementsDigest };
}

function sameTask(left: FrozenTaskRef, right: FrozenTaskRef): boolean {
  return left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest === right.requirementsDigest;
}

function copyTask(task: FrozenTaskRef): FrozenTaskRef {
  return {
    ownerId: task.ownerId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: task.requirementsDigest,
  };
}

function normalizeProvenance(value: CandidateProvenance): CandidateProvenance {
  if (typeof value !== "object" || value === null) throw new CandidateError("Candidate provenance must be an object.", "invalid");
  const nullableNumber = (item: unknown, label: string): number | null => {
    if (item === null) return null;
    if (typeof item !== "number" || !Number.isSafeInteger(item)) throw new CandidateError(`${label} must be an integer or null.`, "invalid");
    return item;
  };
  const nullableString = (item: unknown, label: string, max = 200): string | null => {
    if (item === null) return null;
    if (typeof item !== "string") throw new CandidateError(`${label} must be a string or null.`, "invalid");
    return item.length <= max ? item : item.slice(0, max);
  };
  if (typeof value.spawned !== "boolean"
    || typeof value.terminatedByHost !== "boolean"
    || typeof value.groupGone !== "boolean"
    || typeof value.watchdogArmed !== "boolean"
    || (value.watchdogTerminated !== null && typeof value.watchdogTerminated !== "boolean")
    || typeof value.launchStage !== "string"
    || value.launchStage.length > 100
    || typeof value.durationMs !== "number"
    || !Number.isFinite(value.durationMs)
    || value.durationMs < 0) {
    throw new CandidateError("Candidate provenance has invalid boolean, stage or duration facts.", "invalid");
  }
  return {
    spawned: value.spawned,
    pid: nullableNumber(value.pid, "provenance.pid"),
    pgid: nullableNumber(value.pgid, "provenance.pgid"),
    exitCode: nullableNumber(value.exitCode, "provenance.exitCode"),
    signal: nullableString(value.signal, "provenance.signal"),
    stopReason: nullableString(value.stopReason, "provenance.stopReason"),
    terminatedByHost: value.terminatedByHost,
    groupGone: value.groupGone,
    launchStage: value.launchStage,
    durationMs: value.durationMs,
    watchdogArmed: value.watchdogArmed,
    watchdogTerminated: value.watchdogTerminated,
    watchdogControlError: nullableString(value.watchdogControlError, "provenance.watchdogControlError", 500),
    afterSpawnHostRecordError: nullableString(value.afterSpawnHostRecordError, "provenance.afterSpawnHostRecordError", 500),
    finalRecordError: nullableString(value.finalRecordError, "provenance.finalRecordError", 500),
    artifactExportError: nullableString(value.artifactExportError, "provenance.artifactExportError", 500),
  };
}

function copyProvenance(value: CandidateProvenance): CandidateProvenance {
  return { ...value };
}

/**
 * Read one already-validated host-private file with no symlink following, a
 * single-link check, a hard byte ceiling and a fresh identity comparison.
 */
async function pathChain(privateRoot: string, filePath: string, label: string): Promise<DirectoryIdentity[]> {
  contained(privateRoot, filePath, label);
  const rootInfo = await lstat(privateRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new CandidateError(`Host-private root for ${label} is not a real directory.`, "unsafe-path");
  }
  const canonicalRoot = await realpath(privateRoot);
  if (canonicalRoot !== privateRoot) {
    throw new CandidateError(`Host-private root for ${label} was replaced or is reached through a link.`, "unsafe-path");
  }
  const directories: DirectoryIdentity[] = [{ path: privateRoot, dev: rootInfo.dev, ino: rootInfo.ino }];
  let current = privateRoot;
  const segments = path.relative(privateRoot, filePath).split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    if (segment.length === 0) throw new CandidateError(`Path chain for ${label} is invalid.`, "unsafe-path");
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CandidateError(`Path chain for ${label} contains a link or non-directory.`, "unsafe-path");
    }
    directories.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return directories;
}

async function readPrivateFile(
  filePath: string,
  privateRoot: string,
  maxBytes: number,
  label: string,
  expectedDirectories?: readonly DirectoryIdentity[],
): Promise<ReadFileResult> {
  const directories = await pathChain(privateRoot, filePath, label);
  if (expectedDirectories !== undefined) {
    const expected = new Map(expectedDirectories.map((directory) => [directory.path, directory]));
    for (const directory of directories) {
      const recorded = expected.get(directory.path);
      if (!recorded || recorded.dev !== directory.dev || recorded.ino !== directory.ino) {
        throw new CandidateError(`A parent directory for ${label} was replaced after registration.`, "changed");
      }
    }
  }
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) throw new CandidateError(`${label} is a symbolic link.`, "unsafe-path");
  if (!before.isFile()) throw new CandidateError(`${label} is not an ordinary file.`, "unsafe-path");
  if (before.nlink !== 1) throw new CandidateError(`${label} has multiple hard links.`, "unsafe-path");
  if (before.size > maxBytes) throw new CandidateError(`${label} exceeds its byte limit.`, "limit");
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new CandidateError(`${label} changed before it was opened.`, "changed");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new CandidateError(`${label} changed while it was read.`, "changed");
    const after = await lstat(filePath);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1) {
      throw new CandidateError(`${label} changed during the read.`, "changed");
    }
    const data = Buffer.from(buffer.subarray(0, offset));
    return {
      data,
      sha256: sha256(data),
      identity: { dev: opened.dev, ino: opened.ino, size: opened.size, sha256: sha256(data) },
      directories,
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.sha256 === right.sha256;
}

function registrationDigest(candidate: Omit<StoredCandidate, "key" | "registrationDigest">): string {
  // Explicit field order; registeredAt is excluded so an idempotent retry with
  // a later host timestamp still matches the original real registration.
  const encoded = JSON.stringify({
    version: CANDIDATE_REGISTRATION_VERSION,
    task: candidate.task,
    runId: candidate.runId,
    callId: candidate.callId,
    privateRoot: candidate.privateRoot,
    source: candidate.source,
    inputs: candidate.inputs,
    artifact: candidate.artifact,
    provenance: candidate.provenance,
  });
  return sha256(encoded);
}

/**
 * Instance-local candidate registry. The adapter owns the writer; external
 * callers receive only the CandidateReadPort returned by `readPort()`.
 */
export class CandidateRegistry {
  private readonly candidates = new Map<string, StoredCandidate>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly pendingRegistrations = new Map<string, { digest: string; taskId: string; runId: string }>();
  private readonly pendingSnapshotIds = new Set<string>();
  private snapshotReservations = 0;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options: { now?: () => string; id?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.id ?? (() => randomUUID());
  }

  readPort(): CandidateReadPort {
    return Object.freeze({
      resolveSnapshot: (expectedTask: FrozenTaskRef, selector: CandidateSelector) => this.resolveSnapshot(expectedTask, selector),
      recheckSnapshot: (snapshotId: string, expectedTask: FrozenTaskRef) => this.recheckSnapshot(snapshotId, expectedTask),
    });
  }

  async register(registration: CandidateRegistration): Promise<{ registered: number; idempotent: number }> {
    const task = normalizeTask(registration.task);
    const runId = identifier(registration.runId, "runId");
    const callId = identifier(registration.callId, "callId");
    const privateRoot = absolute(registration.privateRoot, "privateRoot");
    const registeredAt = typeof registration.registeredAt === "string" && !Number.isNaN(Date.parse(registration.registeredAt))
      ? registration.registeredAt
      : this.now();
    if (!Array.isArray(registration.artifacts) || registration.artifacts.length < 1
      || registration.artifacts.length > MAX_CANDIDATES_PER_RUN) {
      throw new CandidateError(`A registration must contain 1-${MAX_CANDIDATES_PER_RUN} artifacts.`, "limit");
    }
    if (!Array.isArray(registration.inputs) || registration.inputs.length > MAX_CANDIDATE_INPUTS) {
      throw new CandidateError(`A registration may contain at most ${MAX_CANDIDATE_INPUTS} inputs.`, "limit");
    }
    const source = {
      path: absolute(registration.source.path, "source.path"),
      bytes: nonNegativeInteger(registration.source.bytes, "source.bytes"),
      sha256: identifier(registration.source.sha256, "source.sha256"),
    };
    if (source.bytes > MAX_CANDIDATE_SOURCE_BYTES) throw new CandidateError("Source exceeds its byte limit.", "limit");
    const seenInputs = new Set<string>();
    const inputs = registration.inputs.map((input) => {
      const id = identifier(input.id, "input.id");
      if (seenInputs.has(id)) throw new CandidateError(`Input id is duplicated: ${id}.`, "invalid");
      seenInputs.add(id);
      const bytes = nonNegativeInteger(input.bytes, "input.bytes");
      if (bytes > MAX_CANDIDATE_INPUT_BYTES) throw new CandidateError(`Input ${id} exceeds its byte limit.`, "limit");
      return {
        id,
        path: absolute(input.path, "input.path"),
        bytes,
        sha256: identifier(input.sha256, "input.sha256"),
      };
    });
    const totalInputs = inputs.reduce((total, input) => total + input.bytes, 0);
    if (totalInputs > MAX_CANDIDATE_INPUT_TOTAL_BYTES) throw new CandidateError("Inputs exceed their total byte limit.", "limit");

    const seenArtifacts = new Set<string>();
    let totalArtifacts = 0;
    const baseEntries: Array<Omit<StoredCandidate, "key" | "registrationDigest" | "directories">> = [];
    for (const artifact of registration.artifacts) {
      const artifactId = identifier(artifact.artifactId, "artifactId");
      if (seenArtifacts.has(artifactId)) throw new CandidateError(`Artifact id is duplicated in one registration: ${artifactId}.`, "invalid");
      seenArtifacts.add(artifactId);
      const bytes = nonNegativeInteger(artifact.bytes, "artifact.bytes");
      if (bytes > MAX_CANDIDATE_ARTIFACT_BYTES) throw new CandidateError(`Artifact ${artifactId} exceeds its byte limit.`, "limit");
      totalArtifacts += bytes;
      if (totalArtifacts > MAX_CANDIDATE_ARTIFACT_TOTAL_BYTES) {
        throw new CandidateError("Artifacts exceed their total byte limit.", "limit");
      }
      baseEntries.push({
        task: copyTask(task),
        runId,
        callId,
        privateRoot,
        source: { ...source },
        inputs: inputs.map((input) => ({ ...input })),
        artifact: {
          artifactId,
          relativePath: relativeName(artifact.relativePath),
          archivePath: absolute(artifact.archivePath, "artifact.archivePath"),
          bytes,
          sha256: identifier(artifact.sha256, "artifact.sha256"),
        },
        provenance: normalizeProvenance(registration.provenance),
        registeredAt,
      });
    }

    // Reserve keys synchronously before any await. A concurrent registration
    // with the same key either waits behind this reservation (idempotent) or
    // is rejected for a conflicting identity; it cannot be overwritten later.
    const reserved: string[] = [];
    const pending: Array<{ key: string; digest: string; entry: Omit<StoredCandidate, "key" | "registrationDigest" | "directories"> }> = [];
    let idempotent = 0;
    let existingForTask = 0;
    let existingForRun = 0;
    let otherPendingForTask = 0;
    let otherPendingForRun = 0;
    for (const existing of this.candidates.values()) {
      if (existing.task.taskId === task.taskId) existingForTask += 1;
      if (existing.task.taskId === task.taskId && existing.runId === runId) existingForRun += 1;
    }
    for (const pending of this.pendingRegistrations.values()) {
      if (pending.taskId === task.taskId) otherPendingForTask += 1;
      if (pending.taskId === task.taskId && pending.runId === runId) otherPendingForRun += 1;
    }
    try {
      for (const entry of baseEntries) {
        const key = `${runId}\0${entry.artifact.artifactId}`;
        const digest = registrationDigest({ ...entry, directories: [] });
        const existing = this.candidates.get(key);
        if (existing) {
          if (existing.registrationDigest !== digest) {
            throw new CandidateError(`Candidate ${key} is already registered with different facts.`, "conflict");
          }
          idempotent += 1;
          continue;
        }
        const inFlight = this.pendingRegistrations.get(key);
        if (inFlight) {
          if (inFlight.digest !== digest) {
            throw new CandidateError(`Candidate ${key} is being registered with different facts.`, "conflict");
          }
          throw new CandidateError(`Candidate ${key} registration is already in flight; retry after it settles.`, "conflict");
        }
        if (existingForTask + otherPendingForTask + pending.length + 1 > MAX_CANDIDATES_PER_TASK) {
          throw new CandidateError(`Task ${task.taskId} would exceed ${MAX_CANDIDATES_PER_TASK} registered candidates.`, "limit");
        }
        if (existingForRun + otherPendingForRun + pending.length + 1 > MAX_CANDIDATES_PER_RUN) {
          throw new CandidateError(`Run ${runId} would exceed ${MAX_CANDIDATES_PER_RUN} registered candidates.`, "limit");
        }
        this.pendingRegistrations.set(key, { digest, taskId: task.taskId, runId });
        reserved.push(key);
        pending.push({ key, digest, entry });
      }
    } catch (error) {
      for (const key of reserved) this.pendingRegistrations.delete(key);
      throw error;
    }

    try {
      // Verify every actual byte before mutating candidate state. A failed
      // registration must not hide the run or leave a partial candidate set.
      const sourceRead = await readPrivateFile(source.path, privateRoot, MAX_CANDIDATE_SOURCE_BYTES, "staged source");
      if (sourceRead.data.length !== source.bytes || sourceRead.sha256 !== source.sha256) {
        throw new CandidateError("Staged source does not match its registered byte count or digest.", "changed");
      }
      const inputReads = new Map<string, ReadFileResult>();
      for (const input of inputs) {
        const result = await readPrivateFile(input.path, privateRoot, MAX_CANDIDATE_INPUT_BYTES, `staged input ${input.id}`);
        if (result.data.length !== input.bytes || result.sha256 !== input.sha256) {
          throw new CandidateError(`Staged input ${input.id} does not match its registered byte count or digest.`, "changed");
        }
        inputReads.set(input.id, result);
      }
      const artifactReads = new Map<string, ReadFileResult>();
      for (const entry of pending) {
        const result = await readPrivateFile(
          entry.entry.artifact.archivePath,
          privateRoot,
          MAX_CANDIDATE_ARTIFACT_BYTES,
          `archived artifact ${entry.entry.artifact.artifactId}`,
        );
        if (result.data.length !== entry.entry.artifact.bytes || result.sha256 !== entry.entry.artifact.sha256) {
          throw new CandidateError(`Archived artifact ${entry.entry.artifact.artifactId} does not match its registered byte count or digest.`, "changed");
        }
        artifactReads.set(entry.entry.artifact.artifactId, result);
      }

      const directoryUnion = new Map<string, DirectoryIdentity>();
      const remember = (directories: readonly DirectoryIdentity[]): void => {
        for (const directory of directories) {
          const previous = directoryUnion.get(directory.path);
          if (previous && (previous.dev !== directory.dev || previous.ino !== directory.ino)) {
            throw new CandidateError("A host-private directory identity changed during registration.", "changed");
          }
          directoryUnion.set(directory.path, { ...directory });
        }
      };
      remember(sourceRead.directories);
      for (const result of inputReads.values()) remember(result.directories);
      for (const result of artifactReads.values()) remember(result.directories);
      const directories = [...directoryUnion.values()].map((directory) => ({ ...directory }));

      let registered = 0;
      for (const item of pending) {
        const existing = this.candidates.get(item.key);
        if (existing) {
          if (existing.registrationDigest !== item.digest) {
            throw new CandidateError(`Candidate ${item.key} was registered with different facts.`, "conflict");
          }
          idempotent += 1;
          continue;
        }
        this.candidates.set(item.key, {
          ...item.entry,
          directories: directories.map((directory) => ({ ...directory })),
          key: item.key,
          registrationDigest: item.digest,
        });
        registered += 1;
      }
      return { registered, idempotent };
    } finally {
      for (const key of reserved) this.pendingRegistrations.delete(key);
    }
  }

  private reserveSnapshotId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshotId = `candidate-snapshot-${this.newId()}`;
      if (this.snapshots.has(snapshotId) || this.pendingSnapshotIds.has(snapshotId)) continue;
      this.pendingSnapshotIds.add(snapshotId);
      return snapshotId;
    }
    throw new CandidateError("Could not allocate a unique candidate snapshot id.", "limit");
  }

  async resolveSnapshot(expectedTask: FrozenTaskRef, selector: CandidateSelector): Promise<CandidateSnapshot> {
    const task = normalizeTask(expectedTask);
    const runId = identifier(selector.runId, "selector.runId");
    if (!Array.isArray(selector.artifactIds) || selector.artifactIds.length < 1
      || selector.artifactIds.length > MAX_SELECTED_ARTIFACTS) {
      throw new CandidateError(`Select 1-${MAX_SELECTED_ARTIFACTS} artifacts from the same run.`, "limit");
    }
    const artifactIds = selector.artifactIds.map((artifactId) => identifier(artifactId, "selector.artifactId"));
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new CandidateError("Selected artifact ids must be unique.", "invalid");
    }
    const records = artifactIds.map((artifactId) => {
      const key = `${runId}\0${artifactId}`;
      const candidate = this.candidates.get(key);
      if (!candidate) throw new CandidateError(`No registered candidate for run/artifact ${key}.`, "unknown-candidate");
      if (candidate.runId !== runId) throw new CandidateError("Candidate run identity mismatch.", "unknown-candidate");
      if (!sameTask(candidate.task, task)) {
        throw new CandidateError("Candidate was frozen for a different owner/task/revision/requirements identity.", "unknown-candidate");
      }
      return candidate;
    });
    // All selected candidates come from one run, so the run-level source,
    // inputs and provenance must be identical by construction.
    const first = records[0]!;
    for (const record of records) {
      if (record.callId !== first.callId
        || record.privateRoot !== first.privateRoot
        || JSON.stringify(record.source) !== JSON.stringify(first.source)
        || JSON.stringify(record.inputs) !== JSON.stringify(first.inputs)
        || JSON.stringify(record.provenance) !== JSON.stringify(first.provenance)) {
        throw new CandidateError("Selected candidates do not share one real run registration.", "conflict");
      }
    }
    // Reserve snapshot capacity before the first await. Existing snapshot
    // handles are never evicted; a full registry rejects explicitly.
    if (this.snapshots.size + this.snapshotReservations >= MAX_SNAPSHOTS) {
      throw new CandidateError(`Candidate snapshot capacity (${MAX_SNAPSHOTS}) is exhausted; existing handles were retained.`, "limit");
    }
    const snapshotId = this.reserveSnapshotId();
    this.snapshotReservations += 1;
    try {
      const sourceRead = await readPrivateFile(
        first.source.path,
        first.privateRoot,
        MAX_CANDIDATE_SOURCE_BYTES,
        "staged source",
        first.directories,
      );
      if (sourceRead.sha256 !== first.source.sha256 || sourceRead.data.length !== first.source.bytes) {
        throw new CandidateError("Staged source changed since registration.", "changed");
      }
      const inputReads: ReadFileResult[] = [];
      for (const input of first.inputs) {
        const result = await readPrivateFile(
          input.path,
          first.privateRoot,
          MAX_CANDIDATE_INPUT_BYTES,
          `staged input ${input.id}`,
          first.directories,
        );
        if (result.sha256 !== input.sha256 || result.data.length !== input.bytes) {
          throw new CandidateError(`Staged input ${input.id} changed since registration.`, "changed");
        }
        inputReads.push(result);
      }
      const artifactReads: ReadFileResult[] = [];
      let total = 0;
      for (const record of records) {
        const result = await readPrivateFile(
          record.artifact.archivePath,
          record.privateRoot,
          MAX_CANDIDATE_ARTIFACT_BYTES,
          `archived artifact ${record.artifact.artifactId}`,
          record.directories,
        );
        if (result.sha256 !== record.artifact.sha256 || result.data.length !== record.artifact.bytes) {
          throw new CandidateError(`Archived artifact ${record.artifact.artifactId} changed since registration.`, "changed");
        }
        total += result.data.length;
        if (total > MAX_CANDIDATE_ARTIFACT_TOTAL_BYTES) {
          throw new CandidateError("Selected artifacts exceed their total byte limit.", "limit");
        }
        artifactReads.push(result);
      }
      const snapshot: SnapshotRecord = {
        snapshotId,
        task: copyTask(task),
        runId,
        callId: first.callId,
        keys: records.map((record) => record.key),
        source: sourceRead.identity,
        inputs: first.inputs.map((input, index) => ({ id: input.id, identity: inputReads[index]!.identity })),
        artifacts: records.map((record, index) => ({
          artifactId: record.artifact.artifactId,
          identity: artifactReads[index]!.identity,
        })),
        createdAt: this.now(),
      };
      this.snapshots.set(snapshotId, snapshot);
      return this.copySnapshot(snapshot, first, sourceRead, inputReads, artifactReads, records);
    } finally {
      this.snapshotReservations -= 1;
      this.pendingSnapshotIds.delete(snapshotId);
    }
  }

  async recheckSnapshot(snapshotId: string, expectedTask: FrozenTaskRef): Promise<CandidateSnapshot> {
    if (typeof snapshotId !== "string" || snapshotId.length < 1 || snapshotId.length > 256) {
      throw new CandidateError("Snapshot id is invalid.", "invalid");
    }
    const task = normalizeTask(expectedTask);
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new CandidateError("Snapshot is not a host-issued candidate snapshot.", "unknown-snapshot");
    if (!sameTask(snapshot.task, task)) {
      throw new CandidateError("Snapshot belongs to a different owner/task/revision/requirements identity.", "unknown-snapshot");
    }
    const records: StoredCandidate[] = [];
    for (const key of snapshot.keys) {
      const candidate = this.candidates.get(key);
      if (!candidate) throw new CandidateError("A registered candidate is no longer present.", "unknown-candidate");
      if (!sameTask(candidate.task, snapshot.task)) {
        throw new CandidateError("Registered candidate identity changed.", "changed");
      }
      records.push(candidate);
    }
    const first = records[0]!;
    const sourceRead = await readPrivateFile(
      first.source.path,
      first.privateRoot,
      MAX_CANDIDATE_SOURCE_BYTES,
      "staged source",
      first.directories,
    );
    if (!sameIdentity(sourceRead.identity, snapshot.source)) {
      throw new CandidateError("Staged source identity or digest changed after snapshot.", "changed");
    }
    const inputReads: ReadFileResult[] = [];
    for (let index = 0; index < first.inputs.length; index += 1) {
      const input = first.inputs[index]!;
      const result = await readPrivateFile(
        input.path,
        first.privateRoot,
        MAX_CANDIDATE_INPUT_BYTES,
        `staged input ${input.id}`,
        first.directories,
      );
      const recorded = snapshot.inputs[index];
      if (!recorded || recorded.id !== input.id || !sameIdentity(result.identity, recorded.identity)) {
        throw new CandidateError(`Staged input ${input.id} changed after snapshot.`, "changed");
      }
      if (result.sha256 !== input.sha256 || result.data.length !== input.bytes) {
        throw new CandidateError(`Staged input ${input.id} no longer matches its registration.`, "changed");
      }
      inputReads.push(result);
    }
    const artifactReads: ReadFileResult[] = [];
    let total = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const result = await readPrivateFile(
        record.artifact.archivePath,
        record.privateRoot,
        MAX_CANDIDATE_ARTIFACT_BYTES,
        `archived artifact ${record.artifact.artifactId}`,
        record.directories,
      );
      const recorded = snapshot.artifacts[index];
      if (!recorded || recorded.artifactId !== record.artifact.artifactId
        || !sameIdentity(result.identity, recorded.identity)) {
        throw new CandidateError(`Archived artifact ${record.artifact.artifactId} was replaced or changed.`, "changed");
      }
      if (result.sha256 !== record.artifact.sha256 || result.data.length !== record.artifact.bytes) {
        throw new CandidateError(`Archived artifact ${record.artifact.artifactId} no longer matches its registration.`, "changed");
      }
      total += result.data.length;
      if (total > MAX_CANDIDATE_ARTIFACT_TOTAL_BYTES) {
        throw new CandidateError("Selected artifacts exceed their total byte limit.", "limit");
      }
      artifactReads.push(result);
    }
    return this.copySnapshot(snapshot, first, sourceRead, inputReads, artifactReads, records);
  }

  private copySnapshot(
    snapshot: SnapshotRecord,
    candidate: StoredCandidate,
    source: ReadFileResult,
    inputs: ReadFileResult[],
    artifacts: ReadFileResult[],
    records: StoredCandidate[] = [],
  ): CandidateSnapshot {
    return {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      snapshotId: snapshot.snapshotId,
      task: copyTask(snapshot.task),
      runId: snapshot.runId,
      callId: snapshot.callId,
      source: {
        bytes: source.data.length,
        sha256: source.sha256,
        data: Buffer.from(source.data),
        identity: { ...source.identity },
      },
      inputs: candidate.inputs.map((input, index) => {
        const result = inputs[index]!;
        return {
          id: input.id,
          bytes: result.data.length,
          sha256: result.sha256,
          data: Buffer.from(result.data),
          identity: { ...result.identity },
        };
      }),
      artifacts: artifacts.map((result, index) => {
        const selectedArtifact = records[index]!.artifact;
        return {
          artifactId: selectedArtifact.artifactId,
          relativePath: selectedArtifact.relativePath,
          bytes: result.data.length,
          sha256: result.sha256,
          data: Buffer.from(result.data),
          identity: { ...result.identity },
        };
      }),
      provenance: copyProvenance(candidate.provenance),
      registeredAt: candidate.registeredAt,
      createdAt: snapshot.createdAt,
    };
  }
}
