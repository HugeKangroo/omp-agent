import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import {
  TASK_HISTORY_LIMIT,
  TASK_HISTORY_PAGE_LIMIT,
  type AcceptanceReference,
  type GenuineInputSource,
  type ManagedTask,
  type TaskStatus,
} from "./task-owner.ts";
import {
  MAX_REQUIREMENT_SOURCES,
  RequirementBoundsError,
  requirementsDigest,
  type RequirementSource,
} from "./task-requirements.ts";

/**
 * G3-A host-only, bounded history projection.
 *
 * A host explicitly chooses one existing private instance and passes one
 * committed ManagedTask snapshot. This module writes a small local record for
 * later offline inspection. It does not scan instances, select a root from
 * model/environment input, restore an owner, grant, candidate or task pointer,
 * or claim that a local file proves authority. There is no daily-entry wiring
 * in G3-A.
 */

export const HISTORY_PROJECTION_FORMAT = "omp-agent.history-index" as const;
export const HISTORY_PROJECTION_SCHEMA_VERSION = 1 as const;
export const HISTORY_INDEX_FILE_NAME = "history-index.json" as const;
export const HISTORY_ITEM_DIGEST_VERSION = "history-item-v1" as const;
export const HISTORY_ID_VERSION = "history-id-v1" as const;
/** Reuses the owner's existing retained-task and page bounds. */
export const HISTORY_ITEM_LIMIT = TASK_HISTORY_LIMIT;
export const HISTORY_PAGE_LIMIT = TASK_HISTORY_PAGE_LIMIT;
/** One projected item, measured as compact JSON UTF-8 bytes. */
export const HISTORY_ITEM_BYTES_LIMIT = 128 * 1024;
/** Entire history-index.json file. Overflow is refused before writing. */
export const HISTORY_FILE_BYTES_LIMIT = 1024 * 1024;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type HistoryProjectionErrorCode =
  | "invalid"
  | "conflict"
  | "limit"
  | "too-large"
  | "unsupported"
  | "unavailable"
  | "changed"
  | "mismatch"
  | "not-found"
  | "write-failed"
  | "unknown";

export class HistoryProjectionError extends Error {
  override name = "HistoryProjectionError";
  constructor(message: string, readonly code: HistoryProjectionErrorCode) {
    super(message);
  }
}

/** Explicit host locator. Every field comes from an already-created instance. */
export interface HistoryInstanceLocator {
  /** Existing private instance root; history-index.json is created directly here. */
  instanceRoot: string;
  instanceId: string;
  ownerId: string;
  workspaceRoot: string;
}

export interface HistoryItemAnchor {
  sessionId: string;
  messageId: string;
  source: GenuineInputSource;
  observedAt: string;
}

/** One immutable, content-addressed history row. */
export interface HistoryItem {
  /** Deterministic opaque selector derived from the complete projected body. */
  historyId: string;
  /** Content digest, not a signature or authority proof. */
  digest: string;
  taskId: string;
  taskRevision: number;
  recordedStatus: TaskStatus;
  createdAt: string;
  cancelledAt: string | null;
  anchor: HistoryItemAnchor;
  /** Complete, untruncated, host-observed requirement ledger. */
  requirementSources: RequirementSource[];
  /** Recomputed from the complete ledger using the existing owner helper. */
  requirementsDigest: string;
  /** Recorded acceptance reference only; acceptance evidence is not checked here. */
  acceptance: AcceptanceReference | null;
}

export interface HistoryIndex {
  format: typeof HISTORY_PROJECTION_FORMAT;
  schemaVersion: typeof HISTORY_PROJECTION_SCHEMA_VERSION;
  instance: string;
  owner: string;
  workspace: string;
  items: HistoryItem[];
}

export interface HistoryItemSummary {
  historyId: string;
  digest: string;
  taskId: string;
  taskRevision: number;
  recordedStatus: TaskStatus;
  createdAt: string;
  cancelledAt: string | null;
  anchorMessageId: string;
  anchorSessionId: string;
  anchorSource: GenuineInputSource;
  sourceCount: number;
  amendmentCount: number;
  requirementsDigest: string;
  acceptanceId: string | null;
}

export interface HistoryListOptions {
  cursor?: number;
  limit?: number;
}

export interface HistoryListPage {
  format: typeof HISTORY_PROJECTION_FORMAT;
  schemaVersion: typeof HISTORY_PROJECTION_SCHEMA_VERSION;
  instance: string;
  owner: string;
  workspace: string;
  items: HistoryItemSummary[];
  nextCursor: number | null;
  total: number;
  fileDigest: string;
  evidence: "local-record";
  authorityRestored: false;
  branchVisibility: "not_checked";
}

export interface HistoryInspectSelector {
  historyId: string;
  digest: string;
  expectedOwnerId: string;
  expectedTaskId: string;
  expectedTaskRevision: number;
}

export interface HistoryInspection {
  format: typeof HISTORY_PROJECTION_FORMAT;
  schemaVersion: typeof HISTORY_PROJECTION_SCHEMA_VERSION;
  instance: string;
  owner: string;
  workspace: string;
  item: HistoryItem;
  fileDigest: string;
  itemDigestMatchesContent: true;
  evidence: "local-record";
  authorityRestored: false;
  branchVisibility: "not_checked";
  acceptanceEvidence: "not_checked";
  candidateRegistration: "not_checked";
}

export interface HistoryCaptureResult {
  status: "created" | "appended" | "unchanged";
  item: HistoryItem;
  itemCount: number;
  fileDigest: string;
  evidence: "local-record";
  authorityRestored: false;
  branchVisibility: "not_checked";
  acceptanceEvidence: "not_checked";
  candidateRegistration: "not_checked";
}

interface ResolvedHistoryInstance {
  instanceRoot: string;
  indexPath: string;
  instanceId: string;
  ownerId: string;
  workspaceRoot: string;
  rootDev: number;
  rootIno: number;
}

interface StableFileRead {
  data: Buffer;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string;
}

interface OwnedIndex {
  index: HistoryIndex;
  file: StableFileRead;
}

const HEADER_KEYS = ["format", "schemaVersion", "instance", "owner", "workspace", "items"] as const;
const ITEM_KEYS = [
  "historyId",
  "digest",
  "taskId",
  "taskRevision",
  "recordedStatus",
  "createdAt",
  "cancelledAt",
  "anchor",
  "requirementSources",
  "requirementsDigest",
  "acceptance",
] as const;
const ANCHOR_KEYS = ["sessionId", "messageId", "source", "observedAt"] as const;
const SOURCE_KEYS = [
  "revision",
  "kind",
  "messageId",
  "sessionId",
  "source",
  "text",
  "observedAt",
  "committedAt",
  "previousRevision",
] as const;
const ACCEPTANCE_KEYS = ["acceptanceId", "deliveryId", "recordDigest", "acceptedAt"] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256Tag(data: Uint8Array | string): string {
  return `sha256:${sha256Hex(data)}`;
}

function invalid(message: string): never {
  throw new HistoryProjectionError(message, "invalid");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${label} has missing or unknown fields.`);
  }
}

function text(value: unknown, label: string, limit = 100_000): string {
  if (typeof value !== "string" || value.length < 1) invalid(`${label} must be non-empty text.`);
  if (value.length > limit) invalid(`${label} exceeds ${limit} characters.`);
  if (value.includes("\0")) invalid(`${label} contains a NUL character.`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} is not a valid identifier.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) invalid(`${label} must be an ISO timestamp.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${label} must be a non-negative integer.`);
  return value;
}

function digestTag(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) invalid(`${label} must be a sha256 digest.`);
  return value;
}

function sourceOf(value: unknown, label: string): GenuineInputSource {
  if (value !== "interactive" && value !== "rpc") invalid(`${label} must be interactive or rpc.`);
  return value;
}

function statusOf(value: unknown): TaskStatus {
  if (value !== "active" && value !== "cancelled" && value !== "accepted") {
    invalid("recordedStatus must be active, cancelled or accepted.");
  }
  return value;
}

function lstatMaybe(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new HistoryProjectionError(`Could not inspect ${filePath}: ${errorMessage(error)}`, "unavailable");
  }
}

function resolveHistoryInstance(locator: HistoryInstanceLocator): ResolvedHistoryInstance {
  if (typeof locator !== "object" || locator === null || Array.isArray(locator)) {
    invalid("History instance locator must be an object.");
  }
  const rawRoot = text(locator.instanceRoot, "instanceRoot", 4096);
  if (!path.isAbsolute(rawRoot)) invalid("instanceRoot must be an absolute host path.");
  const instanceId = identifier(locator.instanceId, "instanceId");
  const ownerId = identifier(locator.ownerId, "ownerId");
  const workspaceRoot = text(locator.workspaceRoot, "workspaceRoot", 4096);
  if (!path.isAbsolute(workspaceRoot)) invalid("workspaceRoot must be an absolute host path.");

  const initial = lstatMaybe(rawRoot);
  if (initial === null) throw new HistoryProjectionError("The selected instance root does not exist.", "unavailable");
  if (initial.isSymbolicLink()) invalid("instanceRoot must not be a symbolic link.");
  if (!initial.isDirectory()) invalid("instanceRoot must be a real directory.");
  let instanceRoot: string;
  try {
    instanceRoot = realpathSync(rawRoot);
  } catch (error) {
    throw new HistoryProjectionError(`The instance root cannot be resolved: ${errorMessage(error)}`, "unavailable");
  }
  const canonical = lstatSync(instanceRoot);
  if (canonical.isSymbolicLink() || !canonical.isDirectory()) {
    invalid("The canonical instance root is not a real directory.");
  }
  return {
    instanceRoot,
    indexPath: path.join(instanceRoot, HISTORY_INDEX_FILE_NAME),
    instanceId,
    ownerId,
    workspaceRoot,
    rootDev: canonical.dev,
    rootIno: canonical.ino,
  };
}

function assertRootUnchanged(resolved: ResolvedHistoryInstance): void {
  let current: Stats;
  try {
    current = lstatSync(resolved.instanceRoot);
  } catch (error) {
    throw new HistoryProjectionError(`The instance root is unavailable: ${errorMessage(error)}`, "unavailable");
  }
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new HistoryProjectionError("The instance root is no longer a real directory.", "changed");
  }
  if (current.dev !== resolved.rootDev || current.ino !== resolved.rootIno) {
    throw new HistoryProjectionError("The instance root identity changed.", "changed");
  }
  let canonical: string;
  try {
    canonical = realpathSync(resolved.instanceRoot);
  } catch {
    throw new HistoryProjectionError("The instance root can no longer be resolved.", "changed");
  }
  if (canonical !== resolved.instanceRoot) {
    throw new HistoryProjectionError("The instance root canonical path changed.", "changed");
  }
}

function readStableFile(filePath: string, maxBytes: number, label: string): StableFileRead {
  const before = lstatMaybe(filePath);
  if (before === null) throw new HistoryProjectionError(`${label} is missing.`, "unavailable");
  if (before.isSymbolicLink()) throw new HistoryProjectionError(`${label} is a symbolic link.`, "changed");
  if (!before.isFile()) throw new HistoryProjectionError(`${label} is not an ordinary file.`, "changed");
  if (before.nlink !== 1) throw new HistoryProjectionError(`${label} has multiple links.`, "changed");
  if (before.size > maxBytes) {
    throw new HistoryProjectionError(`${label} is ${before.size} bytes; the limit is ${maxBytes}.`, "too-large");
  }
  let canonicalBefore: string;
  try {
    canonicalBefore = realpathSync(filePath);
  } catch (error) {
    throw new HistoryProjectionError(`${label} cannot be resolved before reading: ${errorMessage(error)}`, "changed");
  }
  if (canonicalBefore !== filePath) {
    throw new HistoryProjectionError(`${label} is reached through a symbolic link or alternate path.`, "changed");
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
      throw new HistoryProjectionError(`${label} changed before it was opened.`, "changed");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== opened.size) throw new HistoryProjectionError(`${label} changed while it was read.`, "changed");
    const after = fstatSync(handle);
    if (after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new HistoryProjectionError(`${label} changed during the read.`, "changed");
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
      throw new HistoryProjectionError(`${label} was replaced during the read.`, "changed");
    }
    const data = Buffer.from(buffer.subarray(0, offset));
    return {
      data,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
      digest: sha256Tag(data),
    };
  } catch (error) {
    if (error instanceof HistoryProjectionError) throw error;
    throw new HistoryProjectionError(`${label} could not be read: ${errorMessage(error)}`, "changed");
  } finally {
    if (handle >= 0) {
      try { closeSync(handle); } catch { /* descriptor already closed */ }
    }
  }
}

function canonicalSource(source: RequirementSource): Record<string, unknown> {
  return {
    revision: source.revision,
    kind: source.kind,
    messageId: source.messageId,
    sessionId: source.sessionId,
    source: source.source,
    text: source.text,
    observedAt: source.observedAt,
    committedAt: source.committedAt,
    previousRevision: source.previousRevision,
  };
}

function canonicalAcceptance(reference: AcceptanceReference): Record<string, unknown> {
  return {
    acceptanceId: reference.acceptanceId,
    deliveryId: reference.deliveryId,
    recordDigest: reference.recordDigest,
    acceptedAt: reference.acceptedAt,
  };
}

interface ProjectedBody {
  taskId: string;
  taskRevision: number;
  recordedStatus: TaskStatus;
  createdAt: string;
  cancelledAt: string | null;
  anchor: HistoryItemAnchor;
  requirementSources: RequirementSource[];
  requirementsDigest: string;
  acceptance: AcceptanceReference | null;
}

function canonicalBody(body: ProjectedBody): Record<string, unknown> {
  return {
    taskId: body.taskId,
    taskRevision: body.taskRevision,
    recordedStatus: body.recordedStatus,
    createdAt: body.createdAt,
    cancelledAt: body.cancelledAt,
    anchor: {
      sessionId: body.anchor.sessionId,
      messageId: body.anchor.messageId,
      source: body.anchor.source,
      observedAt: body.anchor.observedAt,
    },
    requirementSources: body.requirementSources.map(canonicalSource),
    requirementsDigest: body.requirementsDigest,
    acceptance: body.acceptance === null ? null : canonicalAcceptance(body.acceptance),
  };
}

function deriveIdentity(
  resolved: ResolvedHistoryInstance,
  body: ProjectedBody,
): { historyId: string; digest: string } {
  const canonical = canonicalBody(body);
  const identityEncoded = JSON.stringify({
    version: HISTORY_ID_VERSION,
    format: HISTORY_PROJECTION_FORMAT,
    schemaVersion: HISTORY_PROJECTION_SCHEMA_VERSION,
    instance: resolved.instanceId,
    owner: resolved.ownerId,
    workspace: resolved.workspaceRoot,
    item: canonical,
  });
  const historyId = `history-${sha256Hex(identityEncoded)}`;
  const digestEncoded = JSON.stringify({
    version: HISTORY_ITEM_DIGEST_VERSION,
    format: HISTORY_PROJECTION_FORMAT,
    schemaVersion: HISTORY_PROJECTION_SCHEMA_VERSION,
    instance: resolved.instanceId,
    owner: resolved.ownerId,
    workspace: resolved.workspaceRoot,
    item: {
      historyId,
      ...canonical,
    },
  });
  return {
    historyId,
    digest: `${HISTORY_ITEM_DIGEST_VERSION}:${sha256Tag(digestEncoded)}`,
  };
}

function parseSource(value: unknown, index: number): RequirementSource {
  const record = object(value, `requirementSources[${index}]`);
  exactKeys(record, SOURCE_KEYS, `requirementSources[${index}]`);
  const revision = positiveInteger(record.revision, `requirementSources[${index}].revision`);
  if (record.kind !== "original" && record.kind !== "amendment") {
    invalid(`requirementSources[${index}].kind must be original or amendment.`);
  }
  const previousRevision = record.previousRevision === null
    ? null
    : positiveInteger(record.previousRevision, `requirementSources[${index}].previousRevision`);
  return {
    revision,
    kind: record.kind,
    messageId: identifier(record.messageId, `requirementSources[${index}].messageId`),
    sessionId: identifier(record.sessionId, `requirementSources[${index}].sessionId`),
    source: sourceOf(record.source, `requirementSources[${index}].source`),
    text: text(record.text, `requirementSources[${index}].text`),
    observedAt: timestamp(record.observedAt, `requirementSources[${index}].observedAt`),
    committedAt: timestamp(record.committedAt, `requirementSources[${index}].committedAt`),
    previousRevision,
  };
}

function parseSources(
  value: unknown,
  taskRevision: number,
  anchor: HistoryItemAnchor,
): RequirementSource[] {
  if (!Array.isArray(value)) invalid("requirementSources must be an array.");
  if (value.length < 1 || value.length > MAX_REQUIREMENT_SOURCES) {
    invalid(`requirementSources must contain 1-${MAX_REQUIREMENT_SOURCES} complete records.`);
  }
  const sources = value.map((source, index) => parseSource(source, index));
  const original = sources[0]!;
  if (original.revision !== 1 || original.kind !== "original" || original.previousRevision !== null) {
    invalid("The first requirement source must be original revision 1.");
  }
  if (original.messageId !== anchor.messageId
    || original.sessionId !== anchor.sessionId
    || original.source !== anchor.source
    || original.observedAt !== anchor.observedAt) {
    invalid("The original requirement source contradicts the task creation anchor.");
  }
  const seen = new Set<string>([original.messageId]);
  for (let index = 1; index < sources.length; index += 1) {
    const source = sources[index]!;
    if (source.kind !== "amendment"
      || source.revision !== index + 1
      || source.previousRevision !== index
      || source.sessionId !== anchor.sessionId) {
      throw new HistoryProjectionError("The requirement source chain is incomplete or out of order.", "invalid");
    }
    if (seen.has(source.messageId)) invalid("The requirement source chain repeats a message id.");
    seen.add(source.messageId);
  }
  if (sources.length !== taskRevision) {
    invalid("The requirement source count does not match taskRevision.");
  }
  return sources;
}

function parseAcceptance(value: unknown): AcceptanceReference | null {
  if (value === null) return null;
  const record = object(value, "acceptance");
  exactKeys(record, ACCEPTANCE_KEYS, "acceptance");
  return {
    acceptanceId: identifier(record.acceptanceId, "acceptance.acceptanceId"),
    deliveryId: identifier(record.deliveryId, "acceptance.deliveryId"),
    recordDigest: digestTag(record.recordDigest, "acceptance.recordDigest"),
    acceptedAt: timestamp(record.acceptedAt, "acceptance.acceptedAt"),
  };
}

/** Strict disk-reader schema: only the four persisted projection fields. */
function parseAnchor(value: unknown): HistoryItemAnchor {
  const record = object(value, "anchor");
  exactKeys(record, ANCHOR_KEYS, "anchor");
  return {
    sessionId: identifier(record.sessionId, "anchor.sessionId"),
    messageId: identifier(record.messageId, "anchor.messageId"),
    source: sourceOf(record.source, "anchor.source"),
    observedAt: timestamp(record.observedAt, "anchor.observedAt"),
  };
}

/**
 * Real owner anchors also carry observedText and anchorText. Those fields are
 * not projected; the four persisted fields are validated and copied.
 */
function projectInputAnchor(value: unknown): HistoryItemAnchor {
  const record = object(value, "ManagedTask.anchor");
  return {
    sessionId: identifier(record.sessionId, "anchor.sessionId"),
    messageId: identifier(record.messageId, "anchor.messageId"),
    source: sourceOf(record.source, "anchor.source"),
    observedAt: timestamp(record.observedAt, "anchor.observedAt"),
  };
}

function assertRecordedState(
  status: TaskStatus,
  cancelledAt: string | null,
  acceptance: AcceptanceReference | null,
): void {
  if (status === "active") {
    if (cancelledAt !== null || acceptance !== null) invalid("An active record cannot have cancellation or acceptance facts.");
    return;
  }
  if (status === "cancelled") {
    if (cancelledAt === null || acceptance !== null) invalid("A cancelled record must have cancelledAt and no acceptance reference.");
    return;
  }
  if (cancelledAt !== null || acceptance === null) {
    invalid("An accepted record must have an acceptance reference and no cancellation time.");
  }
}

function parseItem(value: unknown, resolved: ResolvedHistoryInstance): HistoryItem {
  const record = object(value, "history item");
  exactKeys(record, ITEM_KEYS, "history item");
  const historyId = text(record.historyId, "historyId", 128);
  const digest = text(record.digest, "digest", 256);
  const taskId = identifier(record.taskId, "taskId");
  const taskRevision = positiveInteger(record.taskRevision, "taskRevision");
  const recordedStatus = statusOf(record.recordedStatus);
  const createdAt = timestamp(record.createdAt, "createdAt");
  const cancelledAt = record.cancelledAt === null ? null : timestamp(record.cancelledAt, "cancelledAt");
  const anchor = parseAnchor(record.anchor);
  const requirementSources = parseSources(record.requirementSources, taskRevision, anchor);
  const acceptance = parseAcceptance(record.acceptance);
  assertRecordedState(recordedStatus, cancelledAt, acceptance);
  let computedDigest: string;
  try {
    computedDigest = requirementsDigest(requirementSources);
  } catch (error) {
    throw new HistoryProjectionError(`The requirement ledger is invalid: ${errorMessage(error)}`, "invalid");
  }
  if (record.requirementsDigest !== computedDigest) {
    invalid("The stored requirementsDigest does not match the complete requirement source ledger.");
  }
  const body: ProjectedBody = {
    taskId,
    taskRevision,
    recordedStatus,
    createdAt,
    cancelledAt,
    anchor,
    requirementSources,
    requirementsDigest: computedDigest,
    acceptance,
  };
  const derived = deriveIdentity(resolved, body);
  if (historyId !== derived.historyId) invalid("The historyId does not match the complete projection.");
  if (digest !== derived.digest) invalid("The item digest does not match the complete projection.");
  const item: HistoryItem = {
    historyId,
    digest,
    ...body,
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > HISTORY_ITEM_BYTES_LIMIT) {
    throw new HistoryProjectionError("A history item exceeds its byte limit.", "too-large");
  }
  return item;
}

function parseIndexBytes(bytes: Buffer, resolved: ResolvedHistoryInstance): HistoryIndex {
  let textValue: string;
  try {
    textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistoryProjectionError("history-index.json is not valid UTF-8.", "unsupported");
  }
  let value: unknown;
  try {
    value = JSON.parse(textValue) as unknown;
  } catch {
    throw new HistoryProjectionError("history-index.json is not valid JSON.", "unsupported");
  }
  const record = object(value, "history index");
  exactKeys(record, HEADER_KEYS, "history index");
  if (record.format !== HISTORY_PROJECTION_FORMAT) {
    throw new HistoryProjectionError("The history index format is unsupported.", "unsupported");
  }
  if (record.schemaVersion !== HISTORY_PROJECTION_SCHEMA_VERSION) {
    throw new HistoryProjectionError("The history index schema version is unsupported.", "unsupported");
  }
  if (record.instance !== resolved.instanceId
    || record.owner !== resolved.ownerId
    || record.workspace !== resolved.workspaceRoot) {
    throw new HistoryProjectionError("The history index identity does not match the selected instance.", "mismatch");
  }
  if (!Array.isArray(record.items)) invalid("history index items must be an array.");
  if (record.items.length > HISTORY_ITEM_LIMIT) {
    throw new HistoryProjectionError("The history index exceeds its item limit.", "too-large");
  }
  const items = record.items.map((item) => parseItem(item, resolved));
  const ids = new Set<string>();
  const revisionFacts = new Map<string, { requirementsDigest: string; createdAt: string; anchor: HistoryItemAnchor; statuses: Set<TaskStatus> }>();
  const taskOrigins = new Map<string, { createdAt: string; anchor: HistoryItemAnchor; firstSource: string }>();
  const taskItems = new Map<string, HistoryItem[]>();
  for (const item of items) {
    if (ids.has(item.historyId)) invalid("The history index repeats a historyId.");
    ids.add(item.historyId);
    const revisionKey = `${item.taskId}\0${item.taskRevision}`;
    const existing = revisionFacts.get(revisionKey);
    if (existing !== undefined) {
      if (existing.requirementsDigest !== item.requirementsDigest
        || existing.createdAt !== item.createdAt
        || existing.anchor.sessionId !== item.anchor.sessionId
        || existing.anchor.messageId !== item.anchor.messageId
        || existing.anchor.source !== item.anchor.source
        || existing.anchor.observedAt !== item.anchor.observedAt) {
        invalid("The history index contains conflicting facts for one task revision.");
      }
      if (existing.statuses.has(item.recordedStatus)) {
        invalid("The history index contains two independent rows for the same recorded status.");
      }
      existing.statuses.add(item.recordedStatus);
    } else {
      revisionFacts.set(revisionKey, {
        requirementsDigest: item.requirementsDigest,
        createdAt: item.createdAt,
        anchor: item.anchor,
        statuses: new Set([item.recordedStatus]),
      });
    }
    const taskRows = taskItems.get(item.taskId);
    if (taskRows === undefined) taskItems.set(item.taskId, [item]);
    else taskRows.push(item);
    const firstSource = JSON.stringify(canonicalSource(item.requirementSources[0]!));
    const origin = taskOrigins.get(item.taskId);
    if (origin === undefined) {
      taskOrigins.set(item.taskId, {
        createdAt: item.createdAt,
        anchor: item.anchor,
        firstSource,
      });
    } else if (origin.createdAt !== item.createdAt
      || origin.anchor.sessionId !== item.anchor.sessionId
      || origin.anchor.messageId !== item.anchor.messageId
      || origin.anchor.source !== item.anchor.source
      || origin.anchor.observedAt !== item.anchor.observedAt
      || origin.firstSource !== firstSource) {
      invalid("The history index contains a contradictory task creation anchor.");
    }
  }
  for (const rows of taskItems.values()) {
    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        const leftItem = rows[left]!;
        const rightItem = rows[right]!;
        const shared = Math.min(leftItem.requirementSources.length, rightItem.requirementSources.length);
        for (let index = 0; index < shared; index += 1) {
          if (JSON.stringify(canonicalSource(leftItem.requirementSources[index]!))
            !== JSON.stringify(canonicalSource(rightItem.requirementSources[index]!))) {
            invalid("The history index contains a divergent shared requirement source prefix.");
          }
        }
      }
    }
  }
  return {
    format: HISTORY_PROJECTION_FORMAT,
    schemaVersion: HISTORY_PROJECTION_SCHEMA_VERSION,
    instance: resolved.instanceId,
    owner: resolved.ownerId,
    workspace: resolved.workspaceRoot,
    items,
  };
}

function serializeIndex(index: HistoryIndex): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(index, null, 2);
  } catch (error) {
    throw new HistoryProjectionError(`The history index is not JSON-encodable: ${errorMessage(error)}`, "invalid");
  }
  return Buffer.from(`${encoded}\n`, "utf8");
}

function assertFileBound(bytes: Buffer): void {
  if (bytes.length > HISTORY_FILE_BYTES_LIMIT) {
    throw new HistoryProjectionError(
      `The history index would be ${bytes.length} bytes; the limit is ${HISTORY_FILE_BYTES_LIMIT}.`,
      "too-large",
    );
  }
}

function copySources(sources: readonly RequirementSource[]): RequirementSource[] {
  return sources.map((source) => ({ ...source }));
}

function copyAcceptance(reference: AcceptanceReference | null): AcceptanceReference | null {
  return reference === null ? null : { ...reference };
}

function copyItem(item: HistoryItem): HistoryItem {
  return {
    ...item,
    anchor: { ...item.anchor },
    requirementSources: copySources(item.requirementSources),
    acceptance: copyAcceptance(item.acceptance),
  };
}

function buildItem(task: ManagedTask, resolved: ResolvedHistoryInstance): HistoryItem {
  const record = object(task, "ManagedTask");
  if (record.schemaVersion !== 1) invalid("ManagedTask schemaVersion is unsupported.");
  if (record.ownerId !== resolved.ownerId) {
    throw new HistoryProjectionError("The task owner does not match the selected history instance.", "mismatch");
  }
  const taskId = identifier(record.taskId, "taskId");
  const taskRevision = positiveInteger(record.taskRevision, "taskRevision");
  const recordedStatus = statusOf(record.status);
  const createdAt = timestamp(record.createdAt, "createdAt");
  const cancelledAt = record.cancelledAt === null ? null : timestamp(record.cancelledAt, "cancelledAt");
  const acceptance = parseAcceptance(record.acceptance);
  assertRecordedState(recordedStatus, cancelledAt, acceptance);
  const anchor = projectInputAnchor(record.anchor);
  const requirementSources = parseSources(record.requirementSources, taskRevision, anchor);
  let computedDigest: string;
  try {
    computedDigest = requirementsDigest(requirementSources);
  } catch (error) {
    const code = error instanceof RequirementBoundsError && error.message.includes("TOO_LARGE") ? "too-large" : "invalid";
    throw new HistoryProjectionError(`The requirement ledger is invalid: ${errorMessage(error)}`, code);
  }
  const body: ProjectedBody = {
    taskId,
    taskRevision,
    recordedStatus,
    createdAt,
    cancelledAt,
    anchor,
    requirementSources,
    requirementsDigest: computedDigest,
    acceptance,
  };
  const derived = deriveIdentity(resolved, body);
  const item: HistoryItem = {
    historyId: derived.historyId,
    digest: derived.digest,
    ...body,
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > HISTORY_ITEM_BYTES_LIMIT) {
    throw new HistoryProjectionError("The projected history item exceeds its byte limit.", "too-large");
  }
  return item;
}

function sameAnchor(left: HistoryItemAnchor, right: HistoryItemAnchor): boolean {
  return left.sessionId === right.sessionId
    && left.messageId === right.messageId
    && left.source === right.source
    && left.observedAt === right.observedAt;
}

function assertProjectionConsistent(existing: readonly HistoryItem[], desired: HistoryItem): void {
  for (const item of existing) {
    if (item.taskId !== desired.taskId) continue;
    if (item.createdAt !== desired.createdAt || !sameAnchor(item.anchor, desired.anchor)) {
      throw new HistoryProjectionError("The task creation anchor conflicts with retained history.", "conflict");
    }
    if (item.taskRevision === desired.taskRevision) {
      if (item.requirementsDigest !== desired.requirementsDigest) {
        throw new HistoryProjectionError("The requirement ledger conflicts with retained history for this revision.", "conflict");
      }
      if (item.recordedStatus === desired.recordedStatus) {
        throw new HistoryProjectionError("The same task revision and status already has a different retained projection.", "conflict");
      }
      continue;
    }
    const shared = Math.min(item.requirementSources.length, desired.requirementSources.length);
    for (let index = 0; index < shared; index += 1) {
      if (JSON.stringify(canonicalSource(item.requirementSources[index]!))
        !== JSON.stringify(canonicalSource(desired.requirementSources[index]!))) {
        throw new HistoryProjectionError("The requirement source chain conflicts with retained history.", "conflict");
      }
    }
  }
}

function writeAll(handle: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(handle, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new HistoryProjectionError("The initial history index was not fully written.", "write-failed");
    offset += written;
  }
}

function writeTemporaryBytes(temporary: string, bytes: Buffer): void {
  let handle = -1;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeAll(handle, bytes);
    fsyncSync(handle);
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size !== bytes.length) {
      throw new HistoryProjectionError("The temporary history index has an unexpected identity.", "write-failed");
    }
  } finally {
    if (handle >= 0) {
      try { closeSync(handle); } catch { /* already closed */ }
    }
  }
}

function cleanupTemporary(temporary: string): void {
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      // A leftover unique temporary file never replaces the owned index. The
      // caller still receives its original failure or uncertainty result.
    }
  }
}

/**
 * Initial creation uses a no-overwrite link publication after the complete
 * candidate bytes have been written, fsynced and read back from the temporary
 * inode. A post-link verification failure is reported as possibly applied,
 * never as an unchanged instance or a confirmed capture.
 */
function publishInitialIndex(filePath: string, bytes: Buffer): StableFileRead {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.history-index.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeTemporaryBytes(temporary, bytes);
    const roundTrip = readStableFile(temporary, HISTORY_FILE_BYTES_LIMIT, "temporary history index");
    if (!roundTrip.data.equals(bytes)) {
      throw new HistoryProjectionError("The temporary history index did not round-trip.", "write-failed");
    }
    try {
      linkSync(temporary, filePath);
    } catch (error) {
      const existing = lstatMaybe(filePath);
      if (existing !== null || errorCode(error) === "EEXIST") {
        throw new HistoryProjectionError("A history index already exists at the selected instance.", "conflict");
      }
      throw new HistoryProjectionError(`The initial history index link failed: ${errorMessage(error)}`, "write-failed");
    }
    // The temporary link is now redundant. Remove it before the stable read so
    // the published file has the expected single-link identity.
    try {
      unlinkSync(temporary);
    } catch (error) {
      throw new HistoryProjectionError(
        `The history index may have been published, but its temporary link could not be removed: ${errorMessage(error)}`,
        "unknown",
      );
    }
    let finalRead: StableFileRead;
    try {
      finalRead = readStableFile(filePath, HISTORY_FILE_BYTES_LIMIT, "history index");
    } catch (error) {
      throw new HistoryProjectionError(
        `The history index may have been published, but its read-back could not be confirmed: ${errorMessage(error)}`,
        "unknown",
      );
    }
    if (!finalRead.data.equals(bytes)) {
      throw new HistoryProjectionError(
        "The history index may have been published with unexpected bytes.",
        "unknown",
      );
    }
    return finalRead;
  } finally {
    cleanupTemporary(temporary);
  }
}

/**
 * Atomic replacement for an index already created by this writer. All candidate
 * bytes are written to a new inode, fsynced, checked and only then renamed over
 * the owned path. Failures before rename leave the previous bytes in place.
 */
function publishReplacementIndex(
  filePath: string,
  bytes: Buffer,
  expected: { dev: number; ino: number; size: number; digest: string },
): void {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.history-index.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeTemporaryBytes(temporary, bytes);
    const roundTrip = readStableFile(temporary, HISTORY_FILE_BYTES_LIMIT, "temporary history index");
    if (!roundTrip.data.equals(bytes)) {
      throw new HistoryProjectionError("The temporary history index did not round-trip.", "write-failed");
    }
    let target: StableFileRead;
    try {
      target = readStableFile(filePath, HISTORY_FILE_BYTES_LIMIT, "owned history index");
    } catch {
      throw new HistoryProjectionError("The owned history index changed before publication.", "changed");
    }
    if (target.dev !== expected.dev
      || target.ino !== expected.ino
      || target.size !== expected.size
      || target.digest !== expected.digest) {
      throw new HistoryProjectionError("The owned history index bytes changed before publication.", "changed");
    }
    try {
      renameSync(temporary, filePath);
    } catch (error) {
      throw new HistoryProjectionError(
        `The history index replacement was not published: ${errorMessage(error)}`,
        "write-failed",
      );
    }
  } finally {
    cleanupTemporary(temporary);
  }
}

export class HistoryProjectionWriter {
  readonly instanceRoot: string;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly indexPath: string;
  private readonly resolved: ResolvedHistoryInstance;
  private initialized = false;
  private lastIdentity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; digest: string } | undefined;

  constructor(locator: HistoryInstanceLocator) {
    this.resolved = resolveHistoryInstance(locator);
    this.instanceRoot = this.resolved.instanceRoot;
    this.instanceId = this.resolved.instanceId;
    this.ownerId = this.resolved.ownerId;
    this.workspaceRoot = this.resolved.workspaceRoot;
    this.indexPath = this.resolved.indexPath;
  }

  private readOwnedIndex(): OwnedIndex {
    assertRootUnchanged(this.resolved);
    const file = readStableFile(this.resolved.indexPath, HISTORY_FILE_BYTES_LIMIT, "history index");
    const expected = this.lastIdentity;
    if (expected === undefined
      || file.dev !== expected.dev
      || file.ino !== expected.ino
      || file.size !== expected.size
      || file.mtimeMs !== expected.mtimeMs
      || file.ctimeMs !== expected.ctimeMs
      || file.digest !== expected.digest) {
      throw new HistoryProjectionError("The history index changed outside this writer.", "changed");
    }
    const index = parseIndexBytes(file.data, this.resolved);
    return { index, file };
  }

  /**
   * Capture one host-supplied committed task snapshot. Structural validation is
   * local consistency checking only; it does not authenticate the caller.
   */
  capture(task: ManagedTask): HistoryCaptureResult {
    const desired = buildItem(task, this.resolved);
    assertRootUnchanged(this.resolved);
    if (!this.initialized) {
      const existing = lstatMaybe(this.resolved.indexPath);
      if (existing !== null) {
        throw new HistoryProjectionError("A pre-existing history index is never adopted or overwritten.", "conflict");
      }
      const index: HistoryIndex = {
        format: HISTORY_PROJECTION_FORMAT,
        schemaVersion: HISTORY_PROJECTION_SCHEMA_VERSION,
        instance: this.resolved.instanceId,
        owner: this.resolved.ownerId,
        workspace: this.resolved.workspaceRoot,
        items: [desired],
      };
      const bytes = serializeIndex(index);
      assertFileBound(bytes);
      const readBack = publishInitialIndex(this.resolved.indexPath, bytes);
      let parsed: HistoryIndex;
      try {
        parsed = parseIndexBytes(readBack.data, this.resolved);
      } catch (error) {
        throw new HistoryProjectionError(
          `The history index may have been published, but its read-back could not be confirmed: ${errorMessage(error)}`,
          "unknown",
        );
      }
      if (parsed.items.length !== 1 || parsed.items[0]!.historyId !== desired.historyId || parsed.items[0]!.digest !== desired.digest) {
        throw new HistoryProjectionError(
          "The history index may have been published without the expected projection.",
          "unknown",
        );
      }
      this.initialized = true;
      this.lastIdentity = {
        dev: readBack.dev,
        ino: readBack.ino,
        size: readBack.size,
        mtimeMs: readBack.mtimeMs,
        ctimeMs: readBack.ctimeMs,
        digest: readBack.digest,
      };
      return {
        status: "created",
        item: copyItem(desired),
        itemCount: 1,
        fileDigest: readBack.digest,
        evidence: "local-record",
        authorityRestored: false,
        branchVisibility: "not_checked",
        acceptanceEvidence: "not_checked",
        candidateRegistration: "not_checked",
      };
    }

    const current = this.readOwnedIndex();
    const existingItem = current.index.items.find((item) => item.historyId === desired.historyId);
    if (existingItem !== undefined) {
      if (existingItem.digest !== desired.digest) {
        throw new HistoryProjectionError("The same history id has different content.", "conflict");
      }
      return {
        status: "unchanged",
        item: copyItem(existingItem),
        itemCount: current.index.items.length,
        fileDigest: current.file.digest,
        evidence: "local-record",
        authorityRestored: false,
        branchVisibility: "not_checked",
        acceptanceEvidence: "not_checked",
        candidateRegistration: "not_checked",
      };
    }
    assertProjectionConsistent(current.index.items, desired);
    if (current.index.items.length >= HISTORY_ITEM_LIMIT) {
      throw new HistoryProjectionError(
        `History retention is full (${HISTORY_ITEM_LIMIT} items); no old row was evicted.`,
        "limit",
      );
    }
    const next: HistoryIndex = {
      ...current.index,
      items: [...current.index.items, desired],
    };
    const bytes = serializeIndex(next);
    assertFileBound(bytes);
    try {
      publishReplacementIndex(this.resolved.indexPath, bytes, current.file);
    } catch (error) {
      if (error instanceof HistoryProjectionError) throw error;
      throw new HistoryProjectionError(`The history index replacement was not published: ${errorMessage(error)}`, "write-failed");
    }
    let readBack: StableFileRead;
    try {
      readBack = readStableFile(this.resolved.indexPath, HISTORY_FILE_BYTES_LIMIT, "history index");
    } catch (error) {
      throw new HistoryProjectionError(
        `The history index replacement may have been published, but its read-back could not be confirmed: ${errorMessage(error)}`,
        "unknown",
      );
    }
    if (!readBack.data.equals(bytes)) {
      throw new HistoryProjectionError(
        "The history index replacement may have been published with unexpected bytes.",
        "unknown",
      );
    }
    let parsed: HistoryIndex;
    try {
      parsed = parseIndexBytes(readBack.data, this.resolved);
    } catch (error) {
      throw new HistoryProjectionError(
        `The history index replacement may have been published, but its content could not be confirmed: ${errorMessage(error)}`,
        "unknown",
      );
    }
    const last = parsed.items[parsed.items.length - 1];
    if (parsed.items.length !== current.index.items.length + 1
      || last === undefined
      || last.historyId !== desired.historyId
      || last.digest !== desired.digest) {
      throw new HistoryProjectionError(
        "The history index replacement may have been published without the expected projection.",
        "unknown",
      );
    }
    this.lastIdentity = {
      dev: readBack.dev,
      ino: readBack.ino,
      size: readBack.size,
      mtimeMs: readBack.mtimeMs,
      ctimeMs: readBack.ctimeMs,
      digest: readBack.digest,
    };
    return {
      status: "appended",
      item: copyItem(desired),
      itemCount: parsed.items.length,
      fileDigest: readBack.digest,
      evidence: "local-record",
      authorityRestored: false,
      branchVisibility: "not_checked",
      acceptanceEvidence: "not_checked",
      candidateRegistration: "not_checked",
    };
  }
}

export class HistoryProjectionReader {
  readonly instanceRoot: string;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly indexPath: string;
  private readonly resolved: ResolvedHistoryInstance;

  constructor(locator: HistoryInstanceLocator) {
    this.resolved = resolveHistoryInstance(locator);
    this.instanceRoot = this.resolved.instanceRoot;
    this.instanceId = this.resolved.instanceId;
    this.ownerId = this.resolved.ownerId;
    this.workspaceRoot = this.resolved.workspaceRoot;
    this.indexPath = this.resolved.indexPath;
  }

  private readIndex(): OwnedIndex {
    assertRootUnchanged(this.resolved);
    const file = readStableFile(this.resolved.indexPath, HISTORY_FILE_BYTES_LIMIT, "history index");
    return { index: parseIndexBytes(file.data, this.resolved), file };
  }

  /** Bounded summaries only; no requirement text, paths or owner state. */
  list(options: HistoryListOptions = {}): HistoryListPage {
    if (typeof options !== "object" || options === null || Array.isArray(options)) invalid("History list options must be an object.");
    const cursor = options.cursor === undefined ? 0 : nonNegativeInteger(options.cursor, "cursor");
    const limit = options.limit === undefined ? HISTORY_PAGE_LIMIT : positiveInteger(options.limit, "limit");
    if (limit > HISTORY_PAGE_LIMIT) invalid(`limit must be between 1 and ${HISTORY_PAGE_LIMIT}.`);
    const { index, file } = this.readIndex();
    if (cursor > index.items.length) invalid("cursor is outside the retained history.");
    const page = index.items.slice(cursor, cursor + limit).map((item): HistoryItemSummary => ({
      historyId: item.historyId,
      digest: item.digest,
      taskId: item.taskId,
      taskRevision: item.taskRevision,
      recordedStatus: item.recordedStatus,
      createdAt: item.createdAt,
      cancelledAt: item.cancelledAt,
      anchorMessageId: item.anchor.messageId,
      anchorSessionId: item.anchor.sessionId,
      anchorSource: item.anchor.source,
      sourceCount: item.requirementSources.length,
      amendmentCount: item.requirementSources.filter((source) => source.kind === "amendment").length,
      requirementsDigest: item.requirementsDigest,
      acceptanceId: item.acceptance?.acceptanceId ?? null,
    }));
    return {
      format: index.format,
      schemaVersion: index.schemaVersion,
      instance: index.instance,
      owner: index.owner,
      workspace: index.workspace,
      items: page,
      nextCursor: cursor + page.length < index.items.length ? cursor + page.length : null,
      total: index.items.length,
      fileDigest: file.digest,
      evidence: "local-record",
      authorityRestored: false,
      branchVisibility: "not_checked",
    };
  }

  /**
   * Re-read the actual file and require the exact selector. There is no
   * fallback to the newest or current record.
   */
  inspect(selector: HistoryInspectSelector): HistoryInspection {
    if (typeof selector !== "object" || selector === null || Array.isArray(selector)) invalid("History inspection selector must be an object.");
    const historyId = text(selector.historyId, "historyId", 128);
    const digest = text(selector.digest, "digest", 256);
    const expectedOwnerId = identifier(selector.expectedOwnerId, "expectedOwnerId");
    const expectedTaskId = identifier(selector.expectedTaskId, "expectedTaskId");
    const expectedTaskRevision = positiveInteger(selector.expectedTaskRevision, "expectedTaskRevision");
    if (expectedOwnerId !== this.ownerId) {
      throw new HistoryProjectionError("The expected owner does not match the selected history instance.", "mismatch");
    }
    const { index, file } = this.readIndex();
    const item = index.items.find((candidate) => candidate.historyId === historyId);
    if (item === undefined) throw new HistoryProjectionError("No retained history item matches historyId.", "not-found");
    if (item.digest !== digest) {
      throw new HistoryProjectionError("The item digest does not match the selected history id.", "mismatch");
    }
    if (item.taskId !== expectedTaskId || item.taskRevision !== expectedTaskRevision) {
      throw new HistoryProjectionError("The history item does not match the expected task identity and revision.", "mismatch");
    }
    return {
      format: index.format,
      schemaVersion: index.schemaVersion,
      instance: index.instance,
      owner: index.owner,
      workspace: index.workspace,
      item: copyItem(item),
      fileDigest: file.digest,
      itemDigestMatchesContent: true,
      evidence: "local-record",
      authorityRestored: false,
      branchVisibility: "not_checked",
      acceptanceEvidence: "not_checked",
      candidateRegistration: "not_checked",
    };
  }
}

export function createHistoryProjectionWriter(locator: HistoryInstanceLocator): HistoryProjectionWriter {
  return new HistoryProjectionWriter(locator);
}

export function createHistoryProjectionReader(locator: HistoryInstanceLocator): HistoryProjectionReader {
  return new HistoryProjectionReader(locator);
}

export { sha256Tag as historySha256Tag };
