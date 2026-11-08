import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  EXECUTION_LIMITS,
  EXECUTION_LIMITS_VERSION,
  EXECUTION_RUNTIMES,
  EXECUTION_SCHEMA_VERSION,
  type ExecutionRuntime,
} from "./execution-adapter.ts";
import {
  createHistoryProjectionReader,
  HistoryProjectionError,
  type HistoryInspectSelector,
  type HistoryInstanceLocator,
  type HistoryItem,
  type HistoryProjectionReader,
} from "./history-projection.ts";
import type { AcceptanceReference } from "./task-owner.ts";

/**
 * G3-A read-only evidence for one already-archived execution run.
 *
 * The host supplies an actual history item selector and a relative run-record
 * locator. This module re-reads the history file, the run record under the
 * selected instance's execution root, the recorded script source, staged
 * inputs and caller-selected archived artifacts. A locator is a hint, never
 * permission. It does not scan other instances, read original external source
 * paths, probe or signal recorded PIDs, restore a grant, register a candidate,
 * verify a task, or change any acceptance state.
 */

export const RUN_EVIDENCE_VERSION = "g3a-run-evidence-v1" as const;
export const RUN_EVIDENCE_SCOPE = "local-record-bytes-and-record-metadata" as const;
export const RUN_RECORD_FILE_NAME = "record.json" as const;
/** Run records are bounded host JSON; this is not an execution output limit. */
export const MAX_RUN_RECORD_BYTES = 256 * 1024;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_RUN_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Filesystem component, not a logical task/run id: slash and traversal are excluded. */
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type RunEvidenceState =
  | "consistent"
  | "incomplete"
  | "changed"
  | "missing"
  | "mismatch"
  | "unsupported"
  | "unknown"
  | "unavailable";

export class HistoryEvidenceError extends Error {
  override name = "HistoryEvidenceError";
  constructor(message: string, readonly code: "invalid") {
    super(message);
  }
}

export interface HistoryItemReference {
  historyId: string;
  digest: string;
  /** Actual task fields from the inspected item; rechecked against the file. */
  taskId: string;
  taskRevision: number;
}

export interface RunEvidenceRequest {
  instance: HistoryInstanceLocator;
  /** Selector returned by the instance reader; full content is re-read here. */
  item: HistoryItemReference;
  expectedRunId: string;
  expectedCallId: string;
  /** Relative to the instance execution root, e.g. `run-abc/record.json`. */
  runLocator: string;
  /** Exact archived artifact set selected by the caller; never a glob. */
  artifactIds: readonly string[];
}

export type RunEvidenceFileState = "matched" | "changed" | "missing";

export interface RunEvidenceSourceFacts {
  locator: string;
  bytes: number | null;
  sha256: string | null;
  recordedBytes: number;
  recordedSha256: string;
  state: RunEvidenceFileState;
}

export interface RunEvidenceInputFacts extends RunEvidenceSourceFacts {
  id: string;
}

export interface RunEvidenceArtifactFacts extends RunEvidenceSourceFacts {
  artifactId: string;
  relativePath: string;
}

export interface RunEvidenceMetadata {
  state: "matched" | "mismatch" | "unsupported" | "unavailable" | "not_checked";
  checks: {
    owner: boolean | null;
    task: boolean | null;
    revision: boolean | null;
    requirementsDigest: boolean | null;
    runId: boolean | null;
    callId: boolean | null;
  };
  reason: string | null;
}

export interface RunEvidenceBytes {
  state: "verified" | "incomplete" | "changed" | "missing" | "not_checked";
  source: RunEvidenceSourceFacts | null;
  inputs: RunEvidenceInputFacts[];
  artifacts: RunEvidenceArtifactFacts[];
}

export interface RunEvidenceProcess {
  state: "completed_recorded" | "incomplete_recorded" | "unknown_recorded" | "not_checked";
  phase: string | null;
  spawned: boolean | null;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  signal: string | null;
  stopReason: string | null;
  terminatedByHost: boolean | null;
  processGroupGoneRecorded: boolean | null;
  watchdogArmed: boolean | null;
  watchdogTerminatedRecorded: boolean | null;
  watchdogControlEndedRecorded: boolean | null;
  controlError: string | null;
  hostRecordError: string | null;
  artifactExportError: string | null;
  problems: string[];
}

export interface RunEvidenceHistory {
  historyId: string;
  digest: string;
  taskId: string;
  taskRevision: number;
  recordedStatus: HistoryItem["recordedStatus"];
  requirementsDigest: string;
  recordedAcceptanceReference: AcceptanceReference | null;
}

export interface RunEvidenceRun {
  runId: string;
  callId: string;
  locator: string;
  schemaVersion: number | null;
  limitsVersion: string | null;
}

export interface RunEvidenceSelection {
  requested: string[];
  recorded: string[];
  missing: string[];
  allPresent: boolean;
}

export interface RunEvidenceResult {
  version: typeof RUN_EVIDENCE_VERSION;
  scope: typeof RUN_EVIDENCE_SCOPE;
  state: RunEvidenceState;
  reason: string | null;
  instance: { instance: string; owner: string; workspace: string } | null;
  history: RunEvidenceHistory | null;
  run: RunEvidenceRun | null;
  metadata: RunEvidenceMetadata;
  bytes: RunEvidenceBytes;
  processRecorded: RunEvidenceProcess;
  /** A completed record never proves the current process state. */
  processCurrent: "not_checked";
  acceptanceEvidence: "not_checked";
  candidateRegistration: "not_checked";
  branchVisibility: "not_checked";
  authorityRestored: false;
  evidence: "local-record";
  selection: RunEvidenceSelection | null;
}

interface NormalizedRunEvidenceRequest {
  instance: HistoryInstanceLocator;
  historyId: string;
  historyDigest: string;
  expectedTaskId: string;
  expectedTaskRevision: number;
  expectedRunId: string;
  expectedCallId: string;
  runDir: string;
  recordLocator: string;
  artifactIds: string[];
}

interface ProcessFacts {
  spawned: boolean | null;
  pid: number | null;
  pgid: number | null;
  exitCode: number | null;
  signal: string | null;
  stopReason: string | null;
  terminatedByHost: boolean | null;
  groupGone: boolean | null;
  spawnError: string | null;
  launchStage: string | null;
  hostRecordError: string | null;
  watchdogArmed: boolean | null;
  watchdogAckSent: boolean | null;
  watchdogTerminated: boolean | null;
  watchdogControlEnded: boolean | null;
  controlError: string | null;
  unexpectedControlEof: boolean | null;
  watchdogKilledByHost: boolean | null;
  handshakeError: string | null;
}

interface RunRecordView {
  schemaVersion: number;
  limitsVersion: string;
  runId: string;
  callId: string;
  taskId: string;
  ownerId: string;
  taskRevision: number;
  requirementsDigest: string;
  runtime: ExecutionRuntime;
  phase: string;
  source: { bytes: number; sha256: string };
  inputs: Array<{ id: string; bytes: number; sha256: string }>;
  artifacts: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string; archiveRef: string | null }>;
  artifactTotalBytes: number;
  artifactLimitReached: boolean;
  artifactRejections: number;
  artifactExportError: string | null;
  hostRecordError: string | null;
  process: ProcessFacts | null;
}

interface RunPaths {
  executionRoot: string;
  runRoot: string;
  recordPath: string;
  executionDev: number;
  executionIno: number;
  runDev: number;
  runIno: number;
}

interface StableEvidenceFile {
  data: Buffer;
  digest: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

class EvidenceProblem extends Error {
  override name = "EvidenceProblem";
  constructor(
    message: string,
    readonly state: "unsupported" | "unknown" | "mismatch" | "missing" | "changed" | "unavailable",
  ) {
    super(message);
  }
}

interface SingleFileVerification {
  state: RunEvidenceFileState;
  facts: RunEvidenceSourceFacts;
  file: StableEvidenceFile | null;
}

interface ObservedRunFile {
  path: string;
  maxBytes: number;
  label: string;
  file: StableEvidenceFile;
}

interface RunByteVerification {
  bytes: RunEvidenceBytes;
  observed: ObservedRunFile[];
}

function requestInvalid(message: string): never {
  throw new HistoryEvidenceError(message, "invalid");
}

function recordObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidenceProblem(`${label} must be an object.`, "unknown");
  }
  return value as Record<string, unknown>;
}

function requestObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) requestInvalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function sha256Tag(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function text(value: unknown, label: string, limit = 4096): string {
  if (typeof value !== "string" || value.length < 1) requestInvalid(`${label} must be non-empty text.`);
  if (value.length > limit) requestInvalid(`${label} exceeds ${limit} characters.`);
  if (value.includes("\0")) requestInvalid(`${label} contains a NUL character.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) requestInvalid(`${label} is not a valid identifier.`);
  return value;
}

function pathComponent(value: unknown, label: string): string {
  if (typeof value !== "string"
    || !SAFE_PATH_COMPONENT.test(value)
    || value === "."
    || value === "..") {
    requestInvalid(`${label} is not a safe individual path component.`);
  }
  return value;
}

function recordPathComponent(value: unknown, label: string): string {
  const component = recordText(value, label);
  if (!SAFE_PATH_COMPONENT.test(component) || component === "." || component === "..") {
    throw new EvidenceProblem(`${label} is not a safe individual path component.`, "unknown");
  }
  return component;
}

function containedChild(root: string, name: string): string {
  const target = path.join(root, name);
  if (path.dirname(target) !== root || path.basename(target) !== name) {
    throw new EvidenceProblem("A recorded path component escaped its evidence root.", "unknown");
  }
  return target;
}

function assertEvidenceDirectory(runRoot: string, name: string): string {
  const directory = path.join(runRoot, name);
  if (path.dirname(directory) !== runRoot) {
    throw new EvidenceProblem("An evidence directory escaped the run root.", "unknown");
  }
  const info = lstatMaybe(directory);
  if (info === null) throw new EvidenceProblem(`${name} directory is missing.`, "missing");
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new EvidenceProblem(`${name} is not a real directory.`, "changed");
  }
  let canonical: string;
  try {
    canonical = realpathSync(directory);
  } catch (error) {
    throw new EvidenceProblem(`${name} cannot be resolved: ${errorMessage(error)}`, "changed");
  }
  if (canonical !== directory) {
    throw new EvidenceProblem(`${name} is reached through a symbolic link or alternate path.`, "changed");
  }
  return directory;
}

function recordText(value: unknown, label: string, state: "unsupported" | "unknown" = "unknown"): string {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") || value.length > 100_000) {
    throw new EvidenceProblem(`${label} is missing or malformed.`, state);
  }
  return value;
}

function recordNullableText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 100_000) {
    throw new EvidenceProblem(`${label} must be text or null.`, "unknown");
  }
  return value;
}

function recordBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new EvidenceProblem(`${label} must be boolean or null.`, "unknown");
  return value;
}

function recordInteger(value: unknown, label: string, allowNull = true): number | null {
  if ((value === undefined || value === null) && allowNull) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceProblem(`${label} must be an actual non-negative integer.`, "unknown");
  }
  return value;
}

function recordPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new EvidenceProblem(`${label} must be a positive integer.`, "unknown");
  }
  return value;
}

function recordBytes(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EvidenceProblem(`${label} must be an actual byte count.`, "unknown");
  }
  if (value > max) throw new EvidenceProblem(`${label} exceeds the execution byte limit.`, "unsupported");
  return value;
}

function recordDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new EvidenceProblem(`${label} must be a sha256 digest.`, "unknown");
  }
  return value;
}

function normalizeRequest(request: RunEvidenceRequest): NormalizedRunEvidenceRequest {
  const record = requestObject(request, "Run evidence request");
  const instance = requestObject(record.instance, "instance") as unknown as HistoryInstanceLocator;
  const item = requestObject(record.item, "item");
  const historyId = text(item.historyId, "item.historyId", 128);
  const historyDigest = text(item.digest, "item.digest", 256);
  const expectedTaskId = identifier(item.taskId, "item.taskId");
  if (typeof item.taskRevision !== "number" || !Number.isSafeInteger(item.taskRevision) || item.taskRevision < 1) {
    requestInvalid("item.taskRevision must be a positive integer.");
  }
  const expectedTaskRevision = item.taskRevision;
  const expectedRunId = identifier(record.expectedRunId, "expectedRunId");
  const expectedCallId = identifier(record.expectedCallId, "expectedCallId");
  const rawLocator = text(record.runLocator, "runLocator", 512);
  if (rawLocator.includes("\\") || path.isAbsolute(rawLocator)) {
    requestInvalid("runLocator must be a relative POSIX run-record locator.");
  }
  const segments = rawLocator.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    requestInvalid("runLocator contains an empty, current or traversing segment.");
  }
  if (segments.length !== 1 && !(segments.length === 2 && segments[1] === RUN_RECORD_FILE_NAME)) {
    requestInvalid(`runLocator must name a run directory or its ${RUN_RECORD_FILE_NAME}.`);
  }
  const runDir = segments[0]!;
  if (!SAFE_RUN_COMPONENT.test(runDir)) requestInvalid("runLocator run directory is not a safe path component.");
  const artifactIdsValue = record.artifactIds;
  if (!Array.isArray(artifactIdsValue)) requestInvalid("artifactIds must be an array.");
  if (artifactIdsValue.length > EXECUTION_LIMITS.maxArtifacts) {
    requestInvalid(`artifactIds exceeds ${EXECUTION_LIMITS.maxArtifacts} selected artifacts.`);
  }
  const artifactIds = artifactIdsValue.map((value, index) => pathComponent(value, `artifactIds[${index}]`));
  if (new Set(artifactIds).size !== artifactIds.length) requestInvalid("artifactIds must not repeat an artifact id.");
  return {
    instance,
    historyId,
    historyDigest,
    expectedTaskId,
    expectedTaskRevision,
    expectedRunId,
    expectedCallId,
    runDir,
    recordLocator: `${runDir}/${RUN_RECORD_FILE_NAME}`,
    artifactIds,
  };
}

function emptyMetadata(): RunEvidenceMetadata {
  return {
    state: "not_checked",
    checks: {
      owner: null,
      task: null,
      revision: null,
      requirementsDigest: null,
      runId: null,
      callId: null,
    },
    reason: null,
  };
}

function emptyBytes(): RunEvidenceBytes {
  return { state: "not_checked", source: null, inputs: [], artifacts: [] };
}

function emptyProcess(): RunEvidenceProcess {
  return {
    state: "not_checked",
    phase: null,
    spawned: null,
    pid: null,
    pgid: null,
    exitCode: null,
    signal: null,
    stopReason: null,
    terminatedByHost: null,
    processGroupGoneRecorded: null,
    watchdogArmed: null,
    watchdogTerminatedRecorded: null,
    watchdogControlEndedRecorded: null,
    controlError: null,
    hostRecordError: null,
    artifactExportError: null,
    problems: [],
  };
}

function baseResult(): RunEvidenceResult {
  return {
    version: RUN_EVIDENCE_VERSION,
    scope: RUN_EVIDENCE_SCOPE,
    state: "unknown",
    reason: null,
    instance: null,
    history: null,
    run: null,
    metadata: emptyMetadata(),
    bytes: emptyBytes(),
    processRecorded: emptyProcess(),
    processCurrent: "not_checked",
    acceptanceEvidence: "not_checked",
    candidateRegistration: "not_checked",
    branchVisibility: "not_checked",
    authorityRestored: false,
    evidence: "local-record",
    selection: null,
  };
}

function historyFacts(item: HistoryItem): RunEvidenceHistory {
  return {
    historyId: item.historyId,
    digest: item.digest,
    taskId: item.taskId,
    taskRevision: item.taskRevision,
    recordedStatus: item.recordedStatus,
    requirementsDigest: item.requirementsDigest,
    recordedAcceptanceReference: item.acceptance === null ? null : { ...item.acceptance },
  };
}

function mapProjectionState(error: HistoryProjectionError): RunEvidenceState {
  if (error.code === "unavailable") return "unavailable";
  if (error.code === "changed") return "changed";
  if (error.code === "too-large" || error.code === "unsupported") return "unsupported";
  if (error.code === "not-found" || error.code === "mismatch" || error.code === "invalid" || error.code === "conflict" || error.code === "limit") {
    return "mismatch";
  }
  return "unknown";
}

function lstatMaybe(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new EvidenceProblem(`Could not inspect a run path: ${errorMessage(error)}`, "unavailable");
  }
}

function resolveRunPaths(instanceRoot: string, runDir: string): RunPaths {
  const executionRoot = path.join(instanceRoot, "execution");
  const execution = lstatMaybe(executionRoot);
  if (execution === null) throw new EvidenceProblem("The selected instance has no execution root.", "unavailable");
  if (execution.isSymbolicLink() || !execution.isDirectory()) {
    throw new EvidenceProblem("The instance execution root is not a real directory.", "changed");
  }
  let canonicalExecution: string;
  try {
    canonicalExecution = realpathSync(executionRoot);
  } catch (error) {
    throw new EvidenceProblem(`The execution root cannot be resolved: ${errorMessage(error)}`, "unavailable");
  }
  if (canonicalExecution !== executionRoot) {
    throw new EvidenceProblem("The execution root is not its own canonical path.", "changed");
  }
  const runRoot = path.join(executionRoot, runDir);
  const run = lstatMaybe(runRoot);
  if (run === null) throw new EvidenceProblem("The selected run directory is missing.", "missing");
  if (run.isSymbolicLink() || !run.isDirectory() || path.dirname(runRoot) !== executionRoot) {
    throw new EvidenceProblem("The selected run path is not a real directory below the execution root.", "changed");
  }
  let canonicalRun: string;
  try {
    canonicalRun = realpathSync(runRoot);
  } catch (error) {
    throw new EvidenceProblem(`The run directory cannot be resolved: ${errorMessage(error)}`, "changed");
  }
  if (canonicalRun !== runRoot) {
    throw new EvidenceProblem("The run directory contains a symbolic link or alternate path.", "changed");
  }
  return {
    executionRoot,
    runRoot,
    recordPath: path.join(runRoot, RUN_RECORD_FILE_NAME),
    executionDev: execution.dev,
    executionIno: execution.ino,
    runDev: run.dev,
    runIno: run.ino,
  };
}

function readStableEvidenceFile(filePath: string, maxBytes: number, label: string): StableEvidenceFile {
  const before = lstatMaybe(filePath);
  if (before === null) throw new EvidenceProblem(`${label} is missing.`, "missing");
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new EvidenceProblem(`${label} is not a single ordinary file.`, "changed");
  }
  if (before.size > maxBytes) {
    throw new EvidenceProblem(`${label} exceeds its byte limit (${before.size} > ${maxBytes}).`, "changed");
  }
  let canonicalBefore: string;
  try {
    canonicalBefore = realpathSync(filePath);
  } catch (error) {
    throw new EvidenceProblem(`${label} cannot be resolved before reading: ${errorMessage(error)}`, "changed");
  }
  if (canonicalBefore !== filePath) {
    throw new EvidenceProblem(`${label} is reached through a symbolic link or alternate path.`, "changed");
  }
  let handle = -1;
  try {
    handle = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(handle);
    if (!opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      throw new EvidenceProblem(`${label} changed before it was opened.`, "changed");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) throw new EvidenceProblem(`${label} changed while it was read.`, "changed");
    const after = fstatSync(handle);
    if (after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new EvidenceProblem(`${label} changed during the read.`, "changed");
    }
    const afterPath = lstatSync(filePath);
    if (afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.nlink !== 1
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterPath.size !== opened.size
      || afterPath.mtimeMs !== opened.mtimeMs
      || afterPath.ctimeMs !== opened.ctimeMs) {
      throw new EvidenceProblem(`${label} was replaced during the read.`, "changed");
    }
    let canonical: string;
    try {
      canonical = realpathSync(filePath);
    } catch (error) {
      throw new EvidenceProblem(`${label} can no longer be resolved: ${errorMessage(error)}`, "changed");
    }
    if (canonical !== filePath) {
      throw new EvidenceProblem(`${label} is reached through a symbolic link or alternate path.`, "changed");
    }
    const data = Buffer.from(buffer.subarray(0, offset));
    return {
      data,
      digest: sha256Tag(data),
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } catch (error) {
    if (error instanceof EvidenceProblem) throw error;
    throw new EvidenceProblem(`${label} could not be read: ${errorMessage(error)}`, "changed");
  } finally {
    if (handle >= 0) {
      try { closeSync(handle); } catch { /* descriptor already closed */ }
    }
  }
}

function parseProcess(value: unknown): ProcessFacts | null {
  if (value === null || value === undefined) return null;
  const processRecord = recordObject(value, "record.process");
  const watchdogValue = processRecord.watchdog;
  const watchdog = watchdogValue === null || watchdogValue === undefined
    ? null
    : recordObject(watchdogValue, "record.process.watchdog");
  return {
    spawned: recordBoolean(processRecord.spawned, "process.spawned"),
    pid: recordInteger(processRecord.pid, "process.pid"),
    pgid: recordInteger(processRecord.pgid, "process.pgid"),
    exitCode: recordInteger(processRecord.exitCode, "process.exitCode"),
    signal: recordNullableText(processRecord.signal, "process.signal"),
    stopReason: recordNullableText(processRecord.stopReason, "process.stopReason"),
    terminatedByHost: recordBoolean(processRecord.terminatedByHost, "process.terminatedByHost"),
    groupGone: recordBoolean(processRecord.groupGone, "process.groupGone"),
    spawnError: recordNullableText(processRecord.spawnError, "process.spawnError"),
    launchStage: recordNullableText(processRecord.launchStage, "process.launchStage"),
    hostRecordError: recordNullableText(processRecord.hostRecordError, "process.hostRecordError"),
    watchdogArmed: watchdog === null ? null : recordBoolean(watchdog.armed, "watchdog.armed"),
    watchdogAckSent: watchdog === null ? null : recordBoolean(watchdog.ackSent, "watchdog.ackSent"),
    watchdogTerminated: watchdog === null ? null : recordBoolean(watchdog.watchdogTerminated, "watchdog.watchdogTerminated"),
    watchdogControlEnded: watchdog === null ? null : recordBoolean(watchdog.controlEnded, "watchdog.controlEnded"),
    controlError: watchdog === null ? null : recordNullableText(watchdog.controlError, "watchdog.controlError"),
    unexpectedControlEof: watchdog === null ? null : recordBoolean(watchdog.unexpectedControlEof, "watchdog.unexpectedControlEof"),
    watchdogKilledByHost: watchdog === null ? null : recordBoolean(watchdog.watchdogKilledByHost, "watchdog.watchdogKilledByHost"),
    handshakeError: watchdog === null ? null : recordNullableText(watchdog.handshakeError, "watchdog.handshakeError"),
  };
}

function parseArtifactRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 1024
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new EvidenceProblem(`${label} is not a safe single component.`, "unknown");
  }
  return value;
}

function parseRunRecord(data: Buffer, runDir: string): RunRecordView {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new EvidenceProblem("The run record is not valid UTF-8.", "unsupported");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new EvidenceProblem("The run record is not valid JSON.", "unsupported");
  }
  const record = recordObject(value, "run record");
  if (record.schemaVersion !== EXECUTION_SCHEMA_VERSION) {
    throw new EvidenceProblem("The run record schema version is unsupported.", "unsupported");
  }
  const limitsVersion = recordText(record.limitsVersion, "limitsVersion", "unsupported");
  if (limitsVersion !== EXECUTION_LIMITS_VERSION) {
    throw new EvidenceProblem("The run record limits version is unsupported.", "unsupported");
  }
  const runtimeValue = recordText(record.runtime, "runtime", "unsupported");
  if (!(EXECUTION_RUNTIMES as readonly string[]).includes(runtimeValue)) {
    throw new EvidenceProblem("The run record runtime is unsupported.", "unsupported");
  }
  const sourceValue = recordObject(record.source, "record.source");
  const source = {
    bytes: recordBytes(sourceValue.bytes, "source.bytes", EXECUTION_LIMITS.maxSourceBytes),
    sha256: recordDigest(sourceValue.sha256, "source.sha256"),
  };
  if (!Array.isArray(record.inputs)) throw new EvidenceProblem("record.inputs must be an array.", "unknown");
  if (record.inputs.length > EXECUTION_LIMITS.maxInputs) {
    throw new EvidenceProblem("The run record exceeds the input count limit.", "unsupported");
  }
  const inputIds = new Set<string>();
  let inputTotal = 0;
  const inputs = record.inputs.map((input, index): { id: string; bytes: number; sha256: string } => {
    const row = recordObject(input, `record.inputs[${index}]`);
    const id = recordPathComponent(row.id, `record.inputs[${index}].id`);
    if (inputIds.has(id)) throw new EvidenceProblem("The run record repeats an input id.", "unknown");
    inputIds.add(id);
    const bytes = recordBytes(row.bytes, `record.inputs[${index}].bytes`, EXECUTION_LIMITS.maxInputBytes);
    inputTotal += bytes;
    if (inputTotal > EXECUTION_LIMITS.maxTotalInputBytes) {
      throw new EvidenceProblem("The run record exceeds the total input byte limit.", "unsupported");
    }
    return {
      id,
      bytes,
      sha256: recordDigest(row.sha256, `record.inputs[${index}].sha256`),
    };
  });

  let artifactsValue: unknown = record.artifacts;
  if (artifactsValue === undefined && record.phase === "completed") {
    throw new EvidenceProblem("A completed record has no artifacts array.", "unknown");
  }
  if (artifactsValue === undefined) artifactsValue = [];
  if (!Array.isArray(artifactsValue)) throw new EvidenceProblem("record.artifacts must be an array.", "unknown");
  if (artifactsValue.length > EXECUTION_LIMITS.maxArtifacts) {
    throw new EvidenceProblem("The run record exceeds the artifact count limit.", "unsupported");
  }
  const artifactIds = new Set<string>();
  const relativePaths = new Set<string>();
  let artifactTotal = 0;
  const artifacts = artifactsValue.map((artifact, index): {
    artifactId: string;
    relativePath: string;
    bytes: number;
    sha256: string;
    archiveRef: string | null;
  } => {
    const row = recordObject(artifact, `record.artifacts[${index}]`);
    const artifactId = recordPathComponent(row.artifactId, `record.artifacts[${index}].artifactId`);
    if (artifactIds.has(artifactId)) throw new EvidenceProblem("The run record repeats an artifact id.", "unknown");
    artifactIds.add(artifactId);
    const relativePath = parseArtifactRelativePath(row.relativePath, `record.artifacts[${index}].relativePath`);
    if (relativePaths.has(relativePath)) throw new EvidenceProblem("The run record repeats an artifact relativePath.", "unknown");
    relativePaths.add(relativePath);
    const bytes = recordBytes(row.bytes, `record.artifacts[${index}].bytes`, EXECUTION_LIMITS.maxFileSizeBytes);
    artifactTotal += bytes;
    if (artifactTotal > EXECUTION_LIMITS.maxArtifactTotalBytes) {
      throw new EvidenceProblem("The run record exceeds the total artifact byte limit.", "unsupported");
    }
    const archiveRef = row.archiveRef === undefined
      ? null
      : recordText(row.archiveRef, `record.artifacts[${index}].archiveRef`);
    const expectedRef = `${runDir}/artifacts/${artifactId}.bin`;
    if (archiveRef !== null && archiveRef !== expectedRef) {
      throw new EvidenceProblem("An artifact archiveRef contradicts the recorded run layout.", "mismatch");
    }
    return {
      artifactId,
      relativePath,
      bytes,
      sha256: recordDigest(row.sha256, `record.artifacts[${index}].sha256`),
      archiveRef,
    };
  });
  if (record.artifactTotalBytes !== undefined) {
    if (record.artifactTotalBytes !== artifactTotal) {
      throw new EvidenceProblem("artifactTotalBytes contradicts the archived artifact set.", "mismatch");
    }
  }
  const artifactLimitReached = record.artifactLimitReached === undefined
    ? false
    : recordBoolean(record.artifactLimitReached, "artifactLimitReached");
  if (artifactLimitReached === null) throw new EvidenceProblem("artifactLimitReached must be boolean.", "unknown");
  const artifactRejections = record.artifactRejections === undefined ? [] : record.artifactRejections;
  if (!Array.isArray(artifactRejections)) throw new EvidenceProblem("artifactRejections must be an array.", "unknown");
  const artifactExportError = recordNullableText(record.artifactExportError, "artifactExportError");
  const hostRecordError = recordNullableText(record.hostRecordError, "hostRecordError");
  const process = parseProcess(record.process);
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    limitsVersion,
    runId: recordText(record.runId, "runId"),
    callId: recordText(record.callId, "callId"),
    taskId: recordText(record.taskId, "taskId"),
    ownerId: recordText(record.ownerId, "ownerId"),
    taskRevision: recordPositiveInteger(record.taskRevision, "taskRevision"),
    requirementsDigest: recordText(record.requirementsDigest, "requirementsDigest"),
    runtime: runtimeValue as ExecutionRuntime,
    phase: recordText(record.phase, "phase"),
    source,
    inputs,
    artifacts,
    artifactTotalBytes: artifactTotal,
    artifactLimitReached,
    artifactRejections: artifactRejections.length,
    artifactExportError,
    hostRecordError,
    process,
  };
}

function runFacts(record: RunRecordView, locator: string): RunEvidenceRun {
  return {
    runId: record.runId,
    callId: record.callId,
    locator,
    schemaVersion: record.schemaVersion,
    limitsVersion: record.limitsVersion,
  };
}

function metadataFor(record: RunRecordView, item: HistoryItem, owner: string, expectedRunId: string, expectedCallId: string): RunEvidenceMetadata {
  const checks = {
    owner: record.ownerId === owner,
    task: record.taskId === item.taskId,
    revision: record.taskRevision === item.taskRevision,
    requirementsDigest: record.requirementsDigest === item.requirementsDigest,
    runId: record.runId === expectedRunId,
    callId: record.callId === expectedCallId,
  };
  const failed = (Object.entries(checks) as Array<[string, boolean]>).find(([, value]) => !value);
  return {
    state: failed === undefined ? "matched" : "mismatch",
    checks,
    reason: failed === undefined ? null : `run record ${failed[0]} does not match the selected expectation`,
  };
}

function selectionFacts(requested: readonly string[], record: RunRecordView): RunEvidenceSelection {
  const recorded = record.artifacts.map((artifact) => artifact.artifactId);
  const recordedSet = new Set(recorded);
  const missing = requested.filter((value) => !recordedSet.has(value));
  return {
    requested: [...requested],
    recorded,
    missing,
    allPresent: missing.length === 0,
  };
}

function verifyOne(
  absolutePath: string,
  locator: string,
  recordedBytes: number,
  recordedSha256: string,
  maxBytes: number,
): SingleFileVerification {
  const baseFacts = {
    locator,
    bytes: null,
    sha256: null,
    recordedBytes,
    recordedSha256,
    state: "missing" as RunEvidenceFileState,
  };
  try {
    const file = readStableEvidenceFile(absolutePath, maxBytes, locator);
    const actual = {
      ...baseFacts,
      bytes: file.size,
      sha256: file.digest,
      state: "changed" as RunEvidenceFileState,
    };
    if (file.size !== recordedBytes || file.digest !== recordedSha256) {
      return { state: "changed", facts: actual, file };
    }
    return { state: "matched", facts: { ...actual, state: "matched" }, file };
  } catch (error) {
    if (error instanceof EvidenceProblem && error.state === "missing") {
      return { state: "missing", facts: baseFacts, file: null };
    }
    return { state: "changed", facts: baseFacts, file: null };
  }
}

function verifyRunBytes(
  record: RunRecordView,
  paths: RunPaths,
  runDir: string,
  selectedArtifactIds: readonly string[],
): RunByteVerification {
  const extension = record.runtime === "python" ? "py" : "ts";
  const sourceRoot = assertEvidenceDirectory(paths.runRoot, "source");
  const inputRoot = assertEvidenceDirectory(paths.runRoot, "inputs");
  const artifactRoot = assertEvidenceDirectory(paths.runRoot, "artifacts");
  const observed: ObservedRunFile[] = [];
  const sourceName = `script.${extension}`;
  const sourcePath = containedChild(sourceRoot, sourceName);
  const sourceLocator = `${runDir}/source/${sourceName}`;
  const sourceResult = verifyOne(
    sourcePath,
    sourceLocator,
    record.source.bytes,
    record.source.sha256,
    EXECUTION_LIMITS.maxSourceBytes,
  );
  if (sourceResult.file !== null) {
    observed.push({ path: sourcePath, maxBytes: EXECUTION_LIMITS.maxSourceBytes, label: sourceLocator, file: sourceResult.file });
  }
  const inputs: RunEvidenceInputFacts[] = [];
  let inputsState: RunEvidenceFileState = "matched";
  for (const input of record.inputs) {
    const inputName = `${input.id}.bin`;
    const inputPath = containedChild(inputRoot, inputName);
    const locator = `${runDir}/inputs/${inputName}`;
    const result = verifyOne(
      inputPath,
      locator,
      input.bytes,
      input.sha256,
      EXECUTION_LIMITS.maxInputBytes,
    );
    if (result.state === "missing") inputsState = "missing";
    else if (result.state === "changed" && inputsState !== "missing") inputsState = "changed";
    if (result.file !== null) {
      observed.push({ path: inputPath, maxBytes: EXECUTION_LIMITS.maxInputBytes, label: locator, file: result.file });
    }
    inputs.push({ id: input.id, ...result.facts });
  }
  const recordedById = new Map(record.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const artifacts: RunEvidenceArtifactFacts[] = [];
  let artifactsState: RunEvidenceFileState = "matched";
  for (const artifactId of selectedArtifactIds) {
    const artifact = recordedById.get(artifactId);
    if (artifact === undefined) {
      throw new EvidenceProblem("A selected artifact id is absent from the run record.", "mismatch");
    }
    const artifactName = `${artifact.artifactId}.bin`;
    const artifactPath = containedChild(artifactRoot, artifactName);
    const locator = `${runDir}/artifacts/${artifactName}`;
    const result = verifyOne(
      artifactPath,
      locator,
      artifact.bytes,
      artifact.sha256,
      EXECUTION_LIMITS.maxFileSizeBytes,
    );
    if (result.state === "missing") artifactsState = "missing";
    else if (result.state === "changed" && artifactsState !== "missing") artifactsState = "changed";
    if (result.file !== null) {
      observed.push({ path: artifactPath, maxBytes: EXECUTION_LIMITS.maxFileSizeBytes, label: locator, file: result.file });
    }
    artifacts.push({
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      ...result.facts,
    });
  }
  const states = [sourceResult.state, inputsState, artifactsState];
  const bytes = (state: RunEvidenceBytes["state"]): RunEvidenceBytes => ({
    state,
    source: sourceResult.facts,
    inputs,
    artifacts,
  });
  if (states.includes("missing")) return { bytes: bytes("missing"), observed };
  if (states.includes("changed")) return { bytes: bytes("changed"), observed };
  if (record.artifactLimitReached || record.artifactRejections > 0 || record.artifactExportError !== null) {
    return { bytes: bytes("incomplete"), observed };
  }
  return { bytes: bytes("verified"), observed };
}

function classifyProcess(record: RunRecordView): RunEvidenceProcess {
  const facts = emptyProcess();
  facts.phase = record.phase;
  facts.artifactExportError = record.artifactExportError;
  facts.hostRecordError = record.hostRecordError;
  if (record.process === null) {
    if (record.phase === "prepared" || record.phase === "running" || record.phase === "not_dispatched") {
      facts.state = "incomplete_recorded";
      facts.problems.push(`run record phase is ${record.phase}`);
    } else {
      facts.state = "unknown_recorded";
      facts.problems.push("completed run record has no process facts");
    }
    return facts;
  }
  const process = record.process;
  facts.spawned = process.spawned;
  facts.pid = process.pid;
  facts.pgid = process.pgid;
  facts.exitCode = process.exitCode;
  facts.signal = process.signal;
  facts.stopReason = process.stopReason;
  facts.terminatedByHost = process.terminatedByHost;
  facts.processGroupGoneRecorded = process.groupGone;
  facts.watchdogArmed = process.watchdogArmed;
  facts.watchdogTerminatedRecorded = process.watchdogTerminated;
  facts.watchdogControlEndedRecorded = process.watchdogControlEnded;
  facts.controlError = process.controlError;
  facts.hostRecordError = record.hostRecordError ?? process.hostRecordError;
  if (record.phase !== "completed") {
    if (record.phase === "prepared" || record.phase === "running" || record.phase === "not_dispatched") {
      facts.state = "incomplete_recorded";
      facts.problems.push(`run record phase is ${record.phase}`);
    } else {
      facts.state = "unknown_recorded";
      facts.problems.push(`unrecognized run record phase ${record.phase}`);
    }
    return facts;
  }
  const unknown: string[] = [];
  const incomplete: string[] = [];
  if (process.controlError !== null) unknown.push("watchdog control error recorded");
  if (process.unexpectedControlEof === true) unknown.push("unexpected watchdog control EOF recorded");
  if (process.watchdogKilledByHost === true) unknown.push("watchdog was killed by the host");
  if (process.handshakeError !== null) unknown.push("watchdog handshake error recorded");
  if (process.watchdogArmed !== true) unknown.push("watchdog was not recorded armed");
  if (process.watchdogAckSent !== true) unknown.push("launch acknowledgement was not recorded");
  if (process.watchdogTerminated !== true) unknown.push("watchdog termination was not recorded");
  if (process.watchdogControlEnded !== true) unknown.push("watchdog control stream completion was not recorded");
  if (facts.hostRecordError !== null) unknown.push("host record failure recorded");
  if (process.spawned !== true) incomplete.push("no spawned process was recorded");
  if (process.groupGone !== true) incomplete.push("process group was not recorded gone");
  if (process.spawnError !== null) incomplete.push("spawn failure was recorded");
  if (record.artifactLimitReached) incomplete.push("artifact export limit was reached");
  if (record.artifactRejections > 0) incomplete.push("artifact export rejected entries");
  if (record.artifactExportError !== null) incomplete.push("artifact export failed");
  if (unknown.length > 0) {
    facts.state = "unknown_recorded";
    facts.problems.push(...unknown, ...incomplete);
  } else if (incomplete.length > 0) {
    facts.state = "incomplete_recorded";
    facts.problems.push(...incomplete);
  } else {
    facts.state = "completed_recorded";
  }
  return facts;
}

function recheckEvidence(
  paths: RunPaths,
  initialRecord: StableEvidenceFile,
  reader: HistoryProjectionReader,
  selector: HistoryInspectSelector,
  initialItemDigest: string,
  observed: readonly ObservedRunFile[],
): void {
  const execution = lstatMaybe(paths.executionRoot);
  if (execution === null
    || execution.isSymbolicLink()
    || !execution.isDirectory()
    || execution.dev !== paths.executionDev
    || execution.ino !== paths.executionIno) {
    throw new EvidenceProblem("The execution root changed during evidence reading.", "changed");
  }
  const run = lstatMaybe(paths.runRoot);
  if (run === null
    || run.isSymbolicLink()
    || !run.isDirectory()
    || run.dev !== paths.runDev
    || run.ino !== paths.runIno) {
    throw new EvidenceProblem("The run directory changed during evidence reading.", "changed");
  }
  try {
    const again = reader.inspect(selector);
    if (again.item.digest !== initialItemDigest) {
      throw new EvidenceProblem("The selected history item changed during evidence reading.", "changed");
    }
  } catch (error) {
    if (error instanceof EvidenceProblem) throw error;
    throw new EvidenceProblem("The selected history item changed or became unavailable.", "changed");
  }
  let current: StableEvidenceFile;
  try {
    current = readStableEvidenceFile(paths.recordPath, MAX_RUN_RECORD_BYTES, "run record");
  } catch {
    throw new EvidenceProblem("The run record changed during evidence reading.", "changed");
  }
  if (current.dev !== initialRecord.dev
    || current.ino !== initialRecord.ino
    || current.size !== initialRecord.size
    || current.mtimeMs !== initialRecord.mtimeMs
    || current.ctimeMs !== initialRecord.ctimeMs
    || current.digest !== initialRecord.digest) {
    throw new EvidenceProblem("The run record changed during evidence reading.", "changed");
  }
  for (const item of observed) {
    let currentFile: StableEvidenceFile;
    try {
      currentFile = readStableEvidenceFile(item.path, item.maxBytes, item.label);
    } catch {
      throw new EvidenceProblem(`${item.label} changed during evidence reading.`, "changed");
    }
    if (currentFile.dev !== item.file.dev
      || currentFile.ino !== item.file.ino
      || currentFile.size !== item.file.size
      || currentFile.mtimeMs !== item.file.mtimeMs
      || currentFile.ctimeMs !== item.file.ctimeMs
      || currentFile.digest !== item.file.digest) {
      throw new EvidenceProblem(`${item.label} changed during evidence reading.`, "changed");
    }
  }
}

function overallState(
  metadata: RunEvidenceMetadata,
  selection: RunEvidenceSelection,
  bytes: RunEvidenceBytes,
  processRecorded: RunEvidenceProcess,
): RunEvidenceState {
  if (metadata.state !== "matched") return "mismatch";
  if (!selection.allPresent) return "mismatch";
  if (bytes.state === "missing") return "missing";
  if (bytes.state === "changed") return "changed";
  if (bytes.state === "not_checked") return "unknown";
  if (processRecorded.state === "unknown_recorded") return "unknown";
  if (bytes.state === "incomplete" || processRecorded.state === "incomplete_recorded") return "incomplete";
  if (processRecorded.state === "completed_recorded") return "consistent";
  return "unknown";
}

/**
 * Verify one host-selected archived run and exact selected artifact set.
 * Returns explicit state axes; malformed request syntax throws.
 */
export function checkRunEvidence(request: RunEvidenceRequest): RunEvidenceResult {
  const normalized = normalizeRequest(request);
  const result = baseResult();
  let reader: ReturnType<typeof createHistoryProjectionReader>;
  try {
    reader = createHistoryProjectionReader(normalized.instance);
  } catch (error) {
    if (error instanceof HistoryProjectionError) {
      result.state = mapProjectionState(error);
      result.reason = error.message;
      return result;
    }
    result.state = "unavailable";
    result.reason = errorMessage(error);
    return result;
  }
  let item: HistoryItem;
  try {
    const inspection = reader.inspect({
      historyId: normalized.historyId,
      digest: normalized.historyDigest,
      expectedOwnerId: normalized.instance.ownerId,
      expectedTaskId: normalized.expectedTaskId,
      expectedTaskRevision: normalized.expectedTaskRevision,
    });
    item = inspection.item;
    result.instance = {
      instance: inspection.instance,
      owner: inspection.owner,
      workspace: inspection.workspace,
    };
  } catch (error) {
    if (error instanceof HistoryProjectionError) {
      result.state = mapProjectionState(error);
      result.reason = error.message;
      return result;
    }
    result.state = "unavailable";
    result.reason = errorMessage(error);
    return result;
  }
  result.history = historyFacts(item);
  try {
    const paths = resolveRunPaths(reader.instanceRoot, normalized.runDir);
    const recordFile = readStableEvidenceFile(paths.recordPath, MAX_RUN_RECORD_BYTES, "run record");
    const record = parseRunRecord(recordFile.data, normalized.runDir);
    const metadata = metadataFor(
      record,
      item,
      normalized.instance.ownerId,
      normalized.expectedRunId,
      normalized.expectedCallId,
    );
    const selection = selectionFacts(normalized.artifactIds, record);
    result.run = runFacts(record, normalized.recordLocator);
    result.metadata = metadata;
    result.selection = selection;
    if (metadata.state !== "matched") {
      result.state = "mismatch";
      result.reason = metadata.reason;
      return result;
    }
    if (!selection.allPresent) {
      result.state = "mismatch";
      result.reason = `selected artifact id(s) are absent from the run record: ${selection.missing.join(", ")}`;
      return result;
    }
    const byteVerification = verifyRunBytes(record, paths, normalized.runDir, normalized.artifactIds);
    const byteFacts = byteVerification.bytes;
    const processRecorded = classifyProcess(record);
    result.bytes = byteFacts;
    result.processRecorded = processRecorded;
    recheckEvidence(
      paths,
      recordFile,
      reader,
      {
        historyId: normalized.historyId,
        digest: normalized.historyDigest,
        expectedOwnerId: normalized.instance.ownerId,
        expectedTaskId: normalized.expectedTaskId,
        expectedTaskRevision: normalized.expectedTaskRevision,
      },
      item.digest,
      byteVerification.observed,
    );
    result.state = overallState(metadata, selection, byteFacts, processRecorded);
    result.reason = result.state === "consistent"
      ? null
      : processRecorded.state === "unknown_recorded" || processRecorded.state === "incomplete_recorded"
        ? processRecorded.problems.join("; ") || "recorded run process state is not a reliable completion fact"
        : byteFacts.state === "incomplete"
          ? "archived artifact export was incomplete"
          : null;
    return result;
  } catch (error) {
    if (error instanceof EvidenceProblem) {
      result.state = error.state;
      result.reason = error.message;
      return result;
    }
    if (error instanceof HistoryProjectionError) {
      result.state = mapProjectionState(error);
      result.reason = error.message;
      return result;
    }
    result.state = "unknown";
    result.reason = errorMessage(error);
    return result;
  }
}
