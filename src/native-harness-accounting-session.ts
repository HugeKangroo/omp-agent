import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_ACCOUNTING_MAX_BYTES,
  NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2,
  NativeHarnessAccountingError,
  createNativeHarnessAccountingOwner,
  createNativeHarnessRecoveryAccountingOwner,
  observeNativeHarnessAccountingOwner,
  type NativeHarnessAccountingHandle,
  type NativeHarnessAccountingObservation,
  type NativeHarnessRecoveryAccountingHandle,
} from "./native-harness-accounting.ts";
import type { NativeHarnessHistoryReason } from "./native-harness-history.ts";
import {
  NATIVE_HARNESS_HISTORY_SESSION_LIMITS,
  ObservationFailure,
  fail,
  isCanonicalAbsolutePath,
  isPlainRecord,
  parseActiveBranch,
  pinDirectory,
  readNativeHarnessSessionJournal,
  readPublicationBase,
  reason,
  samePublicationBase,
  type DirectoryPin,
  type PublicationBase,
  type SessionDiskEntry,
  type SessionDiskFile,
} from "./native-harness-session-facts.ts";
import {
  deepFreeze,
  nodeFileIo,
  sha256Hex,
  type NativeFileIo,
} from "./native-work.ts";

/**
 * R2-A2a2 host-only accounting-owner association.
 *
 * This leaf binds one actual main session to one fixed A2a1 accounting owner by
 * appending and observing one bounded locator custom entry. It performs no
 * accounting transition, reservation, authorization, original-run resume or
 * host wiring. Success means only that the owner association was observed on
 * disk at one moment.
 */

export const NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE =
  "native-harness-accounting-owner.v1" as const;
export const NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA =
  "omp-agent.native-harness-accounting-owner-locator.v1" as const;
export const NATIVE_HARNESS_ACCOUNTING_SESSION_SCHEMA =
  "omp-agent.native-harness-accounting-session.v1" as const;

const OWNER_LOCATOR_KEYS = [
  "schema",
  "ownerId",
  "selectorSha256",
  "ownerRelativePath",
] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const MAX_LOCATOR_BYTES = 4096;
const MAX_MEMORY_ENTRIES = 8192;
const MAX_LOCATOR_ENTRIES = 128;
const MAX_RESULT_REASONS = 4;
const MAX_ENTRY_LABEL = 256;

export interface NativeHarnessAccountingOwnerLocator {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA;
  readonly ownerId: string;
  readonly selectorSha256: string;
  readonly ownerRelativePath: string;
}

export interface NativeHarnessAccountingSessionOptions {
  /** Canonical host storage root shared with the fixed backend/accounting leaf. */
  readonly storageRoot: string;
  /** Original immutable limits for a genuinely new owner only. */
  readonly limitsText: string;
  /** Actual public synchronous host append capability. */
  readonly appendEntry: (customType: string, data?: unknown) => void;
  /** Narrow owning-root currentness callback; receives the actual context. */
  readonly isOwnerCurrent: (context: unknown) => boolean;
  readonly now?: () => number;
  /**
   * Fixed constructor-time opt-in. Only a genuinely new owner created by this
   * leaf uses the explicit V2 recovery schema when true. Existing owners are
   * never migrated or upgraded, and this grants no continuation authority.
   */
  readonly recoveryAccounting?: boolean;
}

export interface NativeHarnessAccountingExistingIdentity {
  readonly ownerId: string;
  readonly selectorSha256: string;
}

export type NativeHarnessAccountingSessionFailureState =
  | "pending"
  | "unavailable"
  | "invalidated";

export interface NativeHarnessAccountingSessionFailure {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_SESSION_SCHEMA;
  readonly state: NativeHarnessAccountingSessionFailureState;
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

export interface NativeHarnessAccountingSessionConfirmation {
  readonly schema: typeof NATIVE_HARNESS_ACCOUNTING_SESSION_SCHEMA;
  readonly state: "confirmed";
  readonly identity: Readonly<{
    readonly ownerId: string;
    readonly selectorSha256: string;
  }>;
  readonly locator: NativeHarnessAccountingOwnerLocator;
  readonly locatorEntryIds: readonly string[];
  readonly confirmation: "observed-only";
  readonly created: boolean;
}

export type NativeHarnessAccountingSessionResult =
  | NativeHarnessAccountingSessionConfirmation
  | NativeHarnessAccountingSessionFailure;

export interface NativeHarnessAccountingSession {
  ensure(
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult>;
  /**
   * Reads only an already-persisted association and the exact existing V2
   * owner. It never ensures, creates, appends, repairs or returns authority.
   */
  observeExisting(
    context: unknown,
    expectedIdentity: NativeHarnessAccountingExistingIdentity,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult>;
  /** Local invalidation only; no I/O, deletion, refund or rollback. */
  dispose(): void;
}

interface StableSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly recordedCwd: string;
  readonly sessionDir: string;
  readonly file: string;
}

interface SelectedAssociation {
  readonly session: StableSession;
  readonly selectorSha256: string;
  readonly ownerId: string;
}

interface PendingAppend {
  readonly session: StableSession;
  readonly selectorSha256: string;
  readonly locator: NativeHarnessAccountingOwnerLocator;
  readonly parentId: string;
  readonly entryId: string | null;
}

interface MemoryLocatorEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly locator: NativeHarnessAccountingOwnerLocator;
}

interface MemoryScan {
  readonly ids: ReadonlySet<string>;
  readonly locators: readonly MemoryLocatorEntry[];
}

interface JournalLocatorEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly locator: NativeHarnessAccountingOwnerLocator;
}

interface AssociationObservation {
  readonly journal: SessionDiskFile;
  readonly locators: readonly NativeHarnessAccountingOwnerLocator[];
  readonly locator: NativeHarnessAccountingOwnerLocator | null;
  readonly entryIds: readonly string[];
  readonly memoryOnly: boolean;
  readonly journalEntries: readonly JournalLocatorEntry[];
}

interface ObservationFailureResult {
  readonly ok: false;
  readonly failure: NativeHarnessAccountingSessionFailure;
}

interface ObservationSuccess {
  readonly ok: true;
  readonly value: AssociationObservation;
}

function boundedReasons(values: readonly NativeHarnessHistoryReason[]): readonly NativeHarnessHistoryReason[] {
  return Object.freeze(values.slice(0, MAX_RESULT_REASONS));
}

function refusal(
  state: NativeHarnessAccountingSessionFailureState,
  values: readonly NativeHarnessHistoryReason[],
): NativeHarnessAccountingSessionFailure {
  return deepFreeze({
    schema: NATIVE_HARNESS_ACCOUNTING_SESSION_SCHEMA,
    state,
    reasons: boundedReasons(values),
  });
}

function confirmation(
  identity: { readonly ownerId: string; readonly selectorSha256: string },
  locator: NativeHarnessAccountingOwnerLocator,
  locatorEntryIds: readonly string[],
  created: boolean,
): NativeHarnessAccountingSessionConfirmation {
  return deepFreeze({
    schema: NATIVE_HARNESS_ACCOUNTING_SESSION_SCHEMA,
    state: "confirmed" as const,
    identity: Object.freeze({
      ownerId: identity.ownerId,
      selectorSha256: identity.selectorSha256,
    }),
    locator,
    locatorEntryIds: Object.freeze([...new Set(locatorEntryIds)].slice(0, MAX_LOCATOR_ENTRIES)),
    confirmation: "observed-only" as const,
    created,
  });
}

function errorReason(
  error: unknown,
  code: string,
  detail: string,
): NativeHarnessHistoryReason {
  return error instanceof ObservationFailure
    ? reason(error.code, error.detail)
    : reason(code, detail);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function ownData(value: object, key: string, detail: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) fail("shape", detail);
  return descriptor.value;
}

/**
 * Reads one exact own-data field without invoking host code. Accessors,
 * absent required fields and unreadable descriptors refuse as branch data.
 */
function branchOwnData(value: object, key: string, required: boolean): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    fail("branch", "The actual session final branch entry is unreadable.");
  }
  if (descriptor === undefined) {
    if (required) fail("branch", "The actual session final branch entry lacks own data.");
    return undefined;
  }
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    fail("branch", "The actual session final branch entry is not plain own data.");
  }
  return descriptor.value;
}

/**
 * Copies only own-data id, parentId and optional type from the already-captured
 * bounded final branch into fresh plain entry records. Required fields must be
 * own data; a type accessor refuses without invoking it and a missing type
 * becomes the empty string. Unrelated payload fields are not copied and no
 * accessor runs, so the sealed base cannot run host code after capture.
 */
function copyFinalBranchEntries(branch: readonly unknown[]): Record<string, unknown>[] {
  const copies: Record<string, unknown>[] = [];
  for (let index = 0; index < branch.length; index += 1) {
    const value: unknown = branch[index];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("branch", "The actual session final branch entry is not a plain record.");
    }
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch {
      fail("branch", "The actual session final branch entry is unreadable.");
    }
    if (prototype !== Object.prototype && prototype !== null) {
      fail("branch", "The actual session final branch entry is not a plain record.");
    }
    const id = branchOwnData(value, "id", true);
    const parentId = branchOwnData(value, "parentId", true);
    const type = branchOwnData(value, "type", false);
    copies.push({ id, parentId, type: typeof type === "string" ? type : "" });
  }
  return copies;
}

/**
 * Constructor-only own-data read. An accessor or non-boolean is a fixed
 * configuration error; an absent own field means the original V1 default.
 * The captured value never re-reads the caller's options object.
 */
function readRecoveryAccountingOption(options: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(options, "recoveryAccounting");
  if (descriptor === undefined) return false;
  if (!("value" in descriptor)) {
    throw new Error("Native accounting session recoveryAccounting must be own data, not an accessor.");
  }
  if (descriptor.value === undefined) return false;
  if (typeof descriptor.value !== "boolean") {
    throw new Error("Native accounting session recoveryAccounting must be a boolean when supplied.");
  }
  return descriptor.value;
}

/**
 * Copies exact own-data expected identity before any await or host callback.
 * Prototypes, symbols, accessors, extras and malformed UUID/SHA values refuse.
 */
function readExistingIdentity(value: unknown): NativeHarnessAccountingExistingIdentity {
  if (!isPlainRecord(value)) fail("shape", "The expected accounting identity must be a plain object.");
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail("shape", "The expected accounting identity must not carry symbol fields.");
  }
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== 2
    || !names.includes("ownerId")
    || !names.includes("selectorSha256")
  ) {
    fail("shape", "The expected accounting identity must have exactly ownerId and selectorSha256.");
  }
  const ownerId = ownData(value, "ownerId", "The expected accounting owner id is unavailable.");
  const selectorSha256 = ownData(value, "selectorSha256", "The expected accounting selector is unavailable.");
  if (typeof ownerId !== "string" || !UUID_PATTERN.test(ownerId)) {
    fail("shape", "The expected accounting owner id must be a canonical lowercase UUID.");
  }
  if (typeof selectorSha256 !== "string" || !SHA256_PATTERN.test(selectorSha256)) {
    fail("shape", "The expected accounting selector must be 64 lowercase hexadecimal characters.");
  }
  return Object.freeze({ ownerId, selectorSha256 });
}

function boundedField(value: string, detail: string): string {
  if (value.length === 0 || value.length > MAX_ENTRY_LABEL || CONTROL_PATTERN.test(value)) {
    fail("shape", detail);
  }
  return value;
}

/**
 * Pure data decoder. It copies only the four exact own-data scalar fields and
 * rejects prototypes, getters, unknown/missing/null/wrong-type fields.
 */
function decodeLocatorData(value: unknown): NativeHarnessAccountingOwnerLocator | null {
  if (!isPlainRecord(value)) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== OWNER_LOCATOR_KEYS.length) return null;
  for (const key of OWNER_LOCATOR_KEYS) {
    if (!names.includes(key)) return null;
  }
  const schema = ownData(value, "schema", "The locator schema is unavailable.");
  const ownerId = ownData(value, "ownerId", "The locator owner id is unavailable.");
  const selectorSha256 = ownData(value, "selectorSha256", "The locator selector is unavailable.");
  const ownerRelativePath = ownData(value, "ownerRelativePath", "The locator path is unavailable.");
  if (schema !== NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA) return null;
  if (typeof ownerId !== "string" || !UUID_PATTERN.test(ownerId)) return null;
  if (typeof selectorSha256 !== "string" || !SHA256_PATTERN.test(selectorSha256)) return null;
  if (ownerRelativePath !== `accounting-owners/${selectorSha256}/owner.json`) return null;
  return Object.freeze({
    schema: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA,
    ownerId,
    selectorSha256,
    ownerRelativePath,
  });
}

/**
 * Pure bounded text decoder for one already-read locator body. A leading or
 * embedded BOM, coercion, trimming, unknown fields and oversized UTF-8 refuse.
 */
export function decodeNativeHarnessAccountingOwnerLocator(
  text: unknown,
): NativeHarnessAccountingOwnerLocator | null {
  if (typeof text !== "string") return null;
  if (text.length === 0 || text.includes("\uFEFF")) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_LOCATOR_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return decodeLocatorData(parsed);
}

function locatorFor(
  ownerId: string,
  selectorSha256: string,
): NativeHarnessAccountingOwnerLocator {
  return Object.freeze({
    schema: NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_SCHEMA,
    ownerId,
    selectorSha256,
    ownerRelativePath: `accounting-owners/${selectorSha256}/owner.json`,
  });
}

function locatorData(locator: NativeHarnessAccountingOwnerLocator): Record<string, unknown> {
  return Object.freeze({
    schema: locator.schema,
    ownerId: locator.ownerId,
    selectorSha256: locator.selectorSha256,
    ownerRelativePath: locator.ownerRelativePath,
  });
}

function sameLocator(
  left: NativeHarnessAccountingOwnerLocator,
  right: NativeHarnessAccountingOwnerLocator,
): boolean {
  return left.schema === right.schema
    && left.ownerId === right.ownerId
    && left.selectorSha256 === right.selectorSha256
    && left.ownerRelativePath === right.ownerRelativePath;
}

function stableSession(base: PublicationBase): StableSession {
  return Object.freeze({
    sessionId: base.sessionId,
    cwd: base.cwd,
    recordedCwd: base.recordedCwd,
    sessionDir: base.sessionDir,
    file: base.file,
  });
}

function sameStableSession(left: StableSession, right: StableSession): boolean {
  return left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.recordedCwd === right.recordedCwd
    && left.sessionDir === right.sessionDir
    && left.file === right.file;
}

function selectorSha256For(base: PublicationBase): string {
  return sha256Hex(JSON.stringify({
    sessionFile: base.file,
    sessionId: base.sessionId,
    workspaceRoot: base.cwd,
  }));
}

function managerCapability(manager: object, name: string): unknown {
  const callable = (manager as Record<string, unknown>)[name];
  if (typeof callable !== "function") {
    fail("manager", "The actual session manager lacks a required capability.");
  }
  return callable;
}

function managerCall(manager: object, name: string, missingDetail: string): unknown {
  let callable: unknown;
  try {
    callable = managerCapability(manager, name);
  } catch {
    fail("manager", missingDetail);
  }
  try {
    return Reflect.apply(callable as Function, manager, []);
  } catch {
    fail("manager", missingDetail);
  }
}

function scanMemoryEntries(raw: unknown): MemoryScan {
  if (!Array.isArray(raw)) fail("entries", "The actual session manager entries are not an array.");
  if (raw.length > MAX_MEMORY_ENTRIES) {
    fail("entries", "The actual session manager entries exceed their fixed traversal bound.");
  }
  const ids = new Set<string>();
  const locators: MemoryLocatorEntry[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("entries", "The actual session manager entries are not dense.");
    }
    const value: unknown = descriptor.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("entries", "An actual session manager entry is not an object.");
    }
    const id = ownData(value, "id", "An actual session manager entry id is unavailable.");
    if (typeof id !== "string" || !ENTRY_ID_PATTERN.test(id)) {
      fail("entries", "An actual session manager entry id is malformed.");
    }
    if (ids.has(id)) fail("entries", "The actual session manager entries contain duplicate ids.");
    ids.add(id);
    const type = ownData(value, "type", "An actual session manager entry type is unavailable.");
    if (typeof type !== "string") fail("entries", "An actual session manager entry type is malformed.");
    boundedField(type, "An actual session manager entry type is malformed.");
    if (type !== "custom") continue;
    const customType = ownData(value, "customType", "An actual custom entry type is unavailable.");
    if (typeof customType !== "string") fail("entries", "An actual custom entry type is malformed.");
    boundedField(customType, "An actual custom entry type is malformed.");
    if (customType !== NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE) continue;
    const parentId = ownData(value, "parentId", "An actual locator parent is unavailable.");
    if (
      parentId !== null
      && (typeof parentId !== "string" || !ENTRY_ID_PATTERN.test(parentId))
    ) {
      fail("entries", "An actual locator parent is malformed.");
    }
    const data = ownData(value, "data", "An actual locator body is unavailable.");
    const locator = decodeLocatorData(data);
    if (locator === null) fail("locator", "An actual session locator is malformed.");
    if (locators.length >= MAX_LOCATOR_ENTRIES) {
      fail("locator", "The actual session locator count exceeds its fixed bound.");
    }
    locators.push({ entryId: id, parentId, locator });
  }
  return { ids, locators };
}

function scanJournalLocators(journal: SessionDiskFile): readonly JournalLocatorEntry[] {
  const locators: JournalLocatorEntry[] = [];
  for (const entry of journal.entries) {
    if (entry.type !== "custom") continue;
    const customType = ownData(entry.value, "customType", "A persisted custom entry type is unavailable.");
    if (typeof customType !== "string") fail("locator", "A persisted custom entry type is malformed.");
    if (customType !== NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE) continue;
    const data = ownData(entry.value, "data", "A persisted locator body is unavailable.");
    const locator = decodeLocatorData(data);
    if (locator === null) fail("locator", "A persisted session locator is malformed.");
    if (locators.length >= MAX_LOCATOR_ENTRIES) {
      fail("locator", "The persisted session locator count exceeds its fixed bound.");
    }
    locators.push({ entryId: entry.id, parentId: entry.parentId, locator });
  }
  return locators;
}

function combineObservation(
  journal: SessionDiskFile,
  memory: MemoryScan,
  journalEntries: readonly JournalLocatorEntry[],
): AssociationObservation {
  const journalById = new Map<string, JournalLocatorEntry>();
  for (const entry of journalEntries) journalById.set(entry.entryId, entry);
  const memoryById = new Map<string, MemoryLocatorEntry>();
  for (const entry of memory.locators) memoryById.set(entry.entryId, entry);
  let memoryOnly = false;
  for (const entry of memoryById.values()) {
    const disk = journalById.get(entry.entryId);
    if (disk === undefined) {
      memoryOnly = true;
      continue;
    }
    if (disk.parentId !== entry.parentId || !sameLocator(disk.locator, entry.locator)) {
      fail("locator", "A memory locator does not match its exact persisted entry.");
    }
  }
  const unique: NativeHarnessAccountingOwnerLocator[] = [];
  const ids = new Map<string, true>();
  for (const entry of journalById.values()) {
    ids.set(entry.entryId, true);
    if (!unique.some((locator) => sameLocator(locator, entry.locator))) unique.push(entry.locator);
  }
  for (const entry of memoryById.values()) {
    if (!journalById.has(entry.entryId)) continue;
    ids.set(entry.entryId, true);
    if (!unique.some((locator) => sameLocator(locator, entry.locator))) unique.push(entry.locator);
  }
  if (unique.length > 1) {
    fail("locator", "The session contains conflicting accounting-owner locators.");
  }
  if (ids.size > MAX_LOCATOR_ENTRIES) {
    fail("locator", "The session locator entry count exceeds its fixed bound.");
  }
  return Object.freeze({
    journal,
    locators: Object.freeze(unique),
    locator: unique[0] ?? null,
    entryIds: Object.freeze([...ids.keys()]),
    memoryOnly,
    journalEntries: Object.freeze([...journalEntries]),
  });
}

function hasValidAncestorChain(journal: SessionDiskFile, entry: SessionDiskEntry): boolean {
  const seen = new Set<string>();
  let cursor = entry.parentId;
  let steps = 0;
  while (cursor !== null) {
    steps += 1;
    if (steps > NATIVE_HARNESS_HISTORY_SESSION_LIMITS.branchEntries || seen.has(cursor)) {
      return false;
    }
    seen.add(cursor);
    const ancestor = journal.byId.get(cursor);
    if (ancestor === undefined) return false;
    cursor = ancestor.parentId;
  }
  return true;
}

async function proveOwnerDirectoryAbsent(
  storageRoot: string,
  selectorSha256: string,
  io: NativeFileIo,
): Promise<boolean> {
  const rootPin = await pinDirectory(storageRoot, io);
  if (rootPin === null) fail("storage", "The trusted storage root could not be pinned.");
  const namespacePath = path.join(storageRoot, "accounting-owners");
  const ownerPath = path.join(namespacePath, selectorSha256);
  let namespacePin: DirectoryPin | null = null;
  try {
    const info = await io.lstat(namespacePath, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail("storage", "The accounting namespace is not a plain directory.");
    }
    namespacePin = await pinDirectory(namespacePath, io);
    if (namespacePin === null) fail("storage", "The accounting namespace could not be pinned.");
  } catch (error) {
    if (error instanceof ObservationFailure) throw error;
    if (!isErrno(error, "ENOENT")) fail("storage", "The accounting namespace could not be inspected.");
  }
  if (namespacePin !== null) {
    try {
      const info = await io.lstat(ownerPath, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) {
        fail("storage", "The accounting owner path is not a plain directory.");
      }
      // A directory that observe could not read is existing/partial, never absent.
      return false;
    } catch (error) {
      if (error instanceof ObservationFailure) throw error;
      if (!isErrno(error, "ENOENT")) fail("storage", "The accounting owner path could not be inspected.");
    }
  }
  const rootAgain = await pinDirectory(storageRoot, io);
  if (rootAgain === null || rootAgain.dev !== rootPin.dev || rootAgain.ino !== rootPin.ino) {
    fail("storage", "The trusted storage root changed during owner absence inspection.");
  }
  if (namespacePin !== null) {
    const namespaceAgain = await pinDirectory(namespacePath, io);
    if (
      namespaceAgain === null
      || namespaceAgain.dev !== namespacePin.dev
      || namespaceAgain.ino !== namespacePin.ino
    ) {
      fail("storage", "The accounting namespace changed during owner absence inspection.");
    }
  }
  return true;
}

function timeoutOutcome<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<"settled" | "failed" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: "settled" | "failed" | "timeout"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), Math.max(0, milliseconds));
    promise.then(
      () => finish("settled"),
      () => finish("failed"),
    );
  });
}

export function createNativeHarnessAccountingSession(
  options: NativeHarnessAccountingSessionOptions,
): NativeHarnessAccountingSession {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("Native accounting session options must be an object.");
  }
  // Copy the fixed own-data opt-in exactly once. Later caller mutation of the
  // options object cannot change this instance's owner schema choice.
  const recoveryAccounting = readRecoveryAccountingOption(options);
  if (!isCanonicalAbsolutePath(options.storageRoot)) {
    throw new Error("Native accounting session storageRoot must be a canonical absolute path.");
  }
  if (
    typeof options.limitsText !== "string"
    || options.limitsText.length === 0
    || Buffer.byteLength(options.limitsText, "utf8") > NATIVE_HARNESS_ACCOUNTING_MAX_BYTES
  ) {
    throw new Error("Native accounting session limitsText must be bounded JSON text.");
  }
  if (typeof options.appendEntry !== "function") {
    throw new Error("Native accounting session appendEntry must be a function.");
  }
  if (typeof options.isOwnerCurrent !== "function") {
    throw new Error("Native accounting session isOwnerCurrent must be a function.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new Error("Native accounting session now must be a function when supplied.");
  }

  const storageRoot = options.storageRoot;
  const limitsText = options.limitsText;
  const appendEntry = options.appendEntry;
  const isOwnerCurrent = options.isOwnerCurrent;
  const now = options.now ?? (() => Date.now());
  const io = nodeFileIo;

  let disposed = false;
  let operation: symbol | null = null;
  let pendingEnsure: Promise<unknown> | null = null;
  let pendingAppend: PendingAppend | null = null;
  let selected: SelectedAssociation | null = null;
  /** Exact manager/session base captured for the one active attempt only. */
  let attemptIdentity: PublicationBase | null = null;

  function clock(): number {
    const value = now();
    if (!Number.isFinite(value)) fail("clock", "The trusted clock is unavailable.");
    return value;
  }

  function ownerCurrent(context: unknown): boolean {
    if (disposed) return false;
    let current: boolean;
    try {
      current = isOwnerCurrent(context) === true;
    } catch {
      return false;
    }
    return current && !disposed;
  }

  function isCurrent(
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): boolean {
    if (disposed || operation !== token) return false;
    const abort = readActualAbortSignal(signal);
    if (!abort.ok || abort.aborted) return false;
    let currentTime: number;
    try {
      currentTime = clock();
    } catch {
      return false;
    }
    if (!(currentTime < deadlineAt)) return false;
    if (!ownerCurrent(context)) return false;
    // The owner callback is host code and may have aborted the signal or
    // disposed this leaf while returning true. End on pure checks only.
    if (disposed || operation !== token) return false;
    const finalAbort = readActualAbortSignal(signal);
    return finalAbort.ok && !finalAbort.aborted;
  }

  function attemptBase(
    context: unknown,
    expected: PublicationBase | null,
  ): PublicationBase | null {
    const read = readPublicationBase(context);
    if (!read.ok) return null;
    if (read.value.cwd !== read.value.recordedCwd) return null;
    if (expected !== null && !samePublicationBase(expected, read.value)) return null;
    return read.value;
  }

  async function runEnsure(
    base: PublicationBase,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionFailure | null> {
    let callable: unknown;
    try {
      callable = managerCapability(base.manager, "ensureOnDisk");
    } catch {
      return refusal("unavailable", [
        reason("persistence-unavailable", "The actual session manager has no ensureOnDisk capability."),
      ]);
    }
    // Capability resolution may run a host getter that replaces the actual
    // context manager. Require the exact captured base before any invocation.
    if (attemptBase(context, base) === null) {
      return refusal("invalidated", [
        reason("invalidated", "The actual session identity changed during persistence capability resolution."),
      ]);
    }
    // Recheck pure state before invoking the actual promise-producing method.
    if (disposed || operation !== token) {
      return refusal("invalidated", [reason("invalidated", "The owning leaf changed before persistence invocation.")]);
    }
    const preInvokeAbort = readActualAbortSignal(signal);
    if (!preInvokeAbort.ok || preInvokeAbort.aborted) {
      return refusal("invalidated", [reason("cancelled", "The actual host signal changed before persistence invocation.")]);
    }
    let actual: Promise<unknown>;
    try {
      actual = Promise.resolve(Reflect.apply(callable as Function, base.manager, []));
    } catch {
      return refusal("unavailable", [
        reason("persist-failed", "The actual ensureOnDisk invocation failed."),
      ]);
    }
    pendingEnsure = actual;
    void actual.then(
      () => {
        if (pendingEnsure === actual) pendingEnsure = null;
      },
      () => {
        if (pendingEnsure === actual) pendingEnsure = null;
      },
    );
    let remaining: number;
    try {
      remaining = deadlineAt - clock();
    } catch {
      return refusal("invalidated", [reason("deadline", "The trusted clock is unavailable.")]);
    }
    if (!(remaining > 0)) {
      return refusal("invalidated", [reason("deadline", "The original deadline elapsed before persistence observation.")]);
    }
    const outcome = await timeoutOutcome(
      actual,
      Math.min(NATIVE_HARNESS_HISTORY_SESSION_LIMITS.ensureOnDiskMs, remaining),
    );
    if (outcome === "settled") {
      if (pendingEnsure === actual) pendingEnsure = null;
      if (!isCurrent(token, context, signal, deadlineAt)) {
        return refusal("invalidated", [reason("invalidated", "The session or owner changed during the persistence wait.")]);
      }
      return null;
    }
    if (outcome === "failed") {
      return refusal("unavailable", [
        reason("persist-failed", "The actual ensureOnDisk wait failed; no persistence was confirmed."),
      ]);
    }
    return refusal("pending", [
      reason("persist-pending", "The bounded persistence wait elapsed; the actual host wait is still unsettled."),
    ]);
  }

  async function observeAssociation(
    base: PublicationBase,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<ObservationSuccess | ObservationFailureResult> {
    const guard = (): boolean => isCurrent(token, context, signal, deadlineAt);
    let observedAt: number;
    try {
      observedAt = clock();
    } catch {
      return {
        ok: false,
        failure: refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]),
      };
    }
    const journalRead = await readNativeHarnessSessionJournal(base, io, guard, observedAt);
    if (!journalRead.ok) {
      return {
        ok: false,
        failure: refusal("unavailable", [journalRead.reason]),
      };
    }
    let memory: MemoryScan;
    try {
      memory = scanMemoryEntries(
        managerCall(base.manager, "getEntries", "The actual session manager has no getEntries capability."),
      );
    } catch (error) {
      return {
        ok: false,
        failure: refusal("unavailable", [
          errorReason(error, "entries-unavailable", "The actual session manager entries are unavailable."),
        ]),
      };
    }
    try {
      return { ok: true, value: combineObservation(journalRead.value, memory, scanJournalLocators(journalRead.value)) };
    } catch (error) {
      return {
        ok: false,
        failure: refusal("unavailable", [
          errorReason(error, "locator", "The persisted or in-memory locator association is invalid."),
        ]),
      };
    }
  }

  async function observeOwner(selectorSha256: string): Promise<NativeHarnessAccountingObservation | null> {
    try {
      const observed = await observeNativeHarnessAccountingOwner({
        storageRoot,
        selectorSha256,
      });
      if (observed.identity.selectorSha256 !== selectorSha256) return null;
      if (!UUID_PATTERN.test(observed.identity.ownerId)) return null;
      return observed;
    } catch {
      return null;
    }
  }

  function boundedIds(value: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(value)].slice(0, MAX_LOCATOR_ENTRIES));
  }

  async function reuseAssociation(
    base: PublicationBase,
    selectorSha256: string,
    observation: AssociationObservation,
    created: boolean,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
    expectation?: {
      readonly ownerId: string;
      readonly requireV2: boolean;
    },
  ): Promise<NativeHarnessAccountingSessionResult> {
    const locator = observation.locator;
    if (locator === null || locator.selectorSha256 !== selectorSha256) {
      return refusal("unavailable", [reason("locator", "The observed locator does not match this session selector.")]);
    }
    if (selected !== null && selected.ownerId !== locator.ownerId) {
      return refusal("invalidated", [
        reason("identity-conflict", "This instance already selected a different accounting owner."),
      ]);
    }
    const owner = await observeOwner(selectorSha256);
    if (owner === null || owner.identity.ownerId !== locator.ownerId) {
      return refusal("unavailable", [
        reason("owner-unavailable", "The exact persisted accounting owner is unavailable or mismatched."),
      ]);
    }
    if (expectation !== undefined) {
      if (owner.identity.ownerId !== expectation.ownerId
        || locator.ownerId !== expectation.ownerId) {
        return refusal("unavailable", [
          reason("identity-conflict", "The persisted accounting owner id does not match the expected identity."),
        ]);
      }
      if (expectation.requireV2 && owner.checkpoint.schema !== NATIVE_HARNESS_ACCOUNTING_SCHEMA_V2) {
        return refusal("unavailable", [
          reason("schema", "The persisted accounting owner is V1; existing-only recovery observation requires an explicit V2 owner."),
        ]);
      }
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session, owner, signal or deadline changed.")]);
    }
    const finalBase = attemptBase(context, base);
    if (finalBase === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed after owner observation.")]);
    }
    let finalTime: number;
    try {
      finalTime = clock();
    } catch {
      return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
    }
    if (!(finalTime < deadlineAt)) {
      return refusal("invalidated", [reason("deadline", "The original deadline elapsed before confirmation.")]);
    }
    if (!ownerCurrent(context) || operation !== token || disposed) {
      return refusal("invalidated", [reason("invalidated", "The owning root or leaf is no longer current.")]);
    }
    const abort = readActualAbortSignal(signal);
    if (!abort.ok || abort.aborted) {
      return refusal("invalidated", [reason("cancelled", "The actual host signal changed before confirmation.")]);
    }
    selected = Object.freeze({
      session: stableSession(base),
      selectorSha256,
      ownerId: locator.ownerId,
    });
    return confirmation(
      { ownerId: locator.ownerId, selectorSha256 },
      locator,
      boundedIds(observation.entryIds),
      created,
    );
  }

  function findPendingCandidate(
    observation: AssociationObservation,
    pending: PendingAppend,
  ): { readonly ok: true; readonly entry: JournalLocatorEntry } | { readonly ok: false; readonly failure: NativeHarnessAccountingSessionFailure } {
    const candidates = observation.journalEntries.filter((entry) => {
      if (!sameLocator(entry.locator, pending.locator)) return false;
      if (pending.entryId !== null) return entry.entryId === pending.entryId;
      return entry.parentId === pending.parentId;
    });
    if (candidates.length === 0) {
      return {
        ok: false,
        failure: refusal("pending", [
          reason("append-unknown", "A previously attempted append is not visible with its exact persisted entry."),
        ]),
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        failure: refusal("unavailable", [
          reason("append-ambiguous", "More than one persisted entry matches the pending append."),
        ]),
      };
    }
    const entry = candidates[0]!;
    if (entry.parentId !== pending.parentId) {
      return {
        ok: false,
        failure: refusal("pending", [
          reason("append-unknown", "The persisted locator does not carry the original pre-append parent."),
        ]),
      };
    }
    const disk = observation.journal.byId.get(entry.entryId);
    if (disk === undefined || disk.parentId !== pending.parentId || !hasValidAncestorChain(observation.journal, disk)) {
      return {
        ok: false,
        failure: refusal("pending", [
          reason("append-unknown", "The persisted locator ancestor chain is not yet valid."),
        ]),
      };
    }
    return { ok: true, entry };
  }

  async function confirmPendingAppend(
    base: PublicationBase,
    selectorSha256: string,
    observation: AssociationObservation,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult> {
    const pending = pendingAppend;
    if (pending === null) {
      return refusal("unavailable", [reason("association", "No pending append observation is available.")]);
    }
    if (pending.selectorSha256 !== selectorSha256 || !sameStableSession(pending.session, stableSession(base))) {
      return refusal("invalidated", [
        reason("identity-conflict", "The pending append belongs to a different session selector."),
      ]);
    }
    if (observation.locators.length === 0) {
      return refusal("pending", [
        reason("append-unknown", "The previously attempted append remains absent; this instance will not append again."),
      ]);
    }
    const candidate = findPendingCandidate(observation, pending);
    if (!candidate.ok) return candidate.failure;
    if (observation.memoryOnly) {
      return refusal("pending", [
        reason("locator-unconfirmed", "The pending locator is visible in memory but not yet proven on disk."),
      ]);
    }
    const owner = await observeOwner(selectorSha256);
    if (owner === null || owner.identity.ownerId !== pending.locator.ownerId) {
      return refusal("unavailable", [
        reason("owner-unavailable", "The exact persisted accounting owner is unavailable or mismatched."),
      ]);
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session, owner, signal or deadline changed.")]);
    }
    const finalBase = attemptBase(context, base);
    if (finalBase === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed after owner observation.")]);
    }
    let finalTime: number;
    try {
      finalTime = clock();
    } catch {
      return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
    }
    if (!(finalTime < deadlineAt)) {
      return refusal("invalidated", [reason("deadline", "The original deadline elapsed before confirmation.")]);
    }
    if (!ownerCurrent(context) || operation !== token || disposed) {
      return refusal("invalidated", [reason("invalidated", "The owning root or leaf is no longer current.")]);
    }
    const abort = readActualAbortSignal(signal);
    if (!abort.ok || abort.aborted) {
      return refusal("invalidated", [reason("cancelled", "The actual host signal changed before confirmation.")]);
    }
    selected = Object.freeze({
      session: stableSession(base),
      selectorSha256,
      ownerId: pending.locator.ownerId,
    });
    pendingAppend = null;
    return confirmation(
      { ownerId: pending.locator.ownerId, selectorSha256 },
      pending.locator,
      boundedIds(observation.entryIds),
      false,
    );
  }

  interface Growth {
    readonly entryId: string;
  }

  function observeGrowth(
    previous: PublicationBase,
    previousBranch: readonly { readonly id: string; readonly parentId: string | null }[],
    beforeIds: ReadonlySet<string>,
    parentId: string,
    locator: NativeHarnessAccountingOwnerLocator,
    context: unknown,
  ): Growth | null {
    const afterBase = attemptBase(context, previous);
    if (afterBase === null) return null;
    let afterBranch: readonly { readonly id: string; readonly parentId: string | null }[];
    try {
      const parsed = parseActiveBranch(afterBase.branch, afterBase.leafId);
      afterBranch = parsed.map((entry) => ({ id: entry.id, parentId: entry.parentId }));
    } catch {
      return null;
    }
    const memory = scanMemoryEntries(
      managerCall(afterBase.manager, "getEntries", "The actual session manager has no getEntries capability."),
    );
    const added: string[] = [];
    for (const id of memory.ids) {
      if (!beforeIds.has(id)) added.push(id);
    }
    if (added.length !== 1) return null;
    const entryId = added[0]!;
    if (afterBranch.length !== previousBranch.length + 1) return null;
    for (let index = 0; index < previousBranch.length; index += 1) {
      const before = previousBranch[index]!;
      const after = afterBranch[index]!;
      if (before.id !== after.id || before.parentId !== after.parentId) return null;
    }
    const last = afterBranch[afterBranch.length - 1]!;
    if (last.id !== entryId || last.parentId !== parentId) return null;
    if (afterBase.leafId !== entryId) return null;
    const visible = memory.locators.find((entry) => entry.entryId === entryId);
    if (visible === undefined || visible.parentId !== parentId || !sameLocator(visible.locator, locator)) {
      return null;
    }
    return { entryId };
  }

  async function appendAndConfirm(
    base: PublicationBase,
    selectorSha256: string,
    ownerId: string,
    created: boolean,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult> {
    const locator = locatorFor(ownerId, selectorSha256);
    const guard = (): boolean => isCurrent(token, context, signal, deadlineAt);
    let observedAt: number;
    try {
      observedAt = clock();
    } catch {
      return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
    }
    const refreshed = await observeAssociation(base, token, context, signal, deadlineAt);
    if (!refreshed.ok) return refreshed.failure;
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session or owner changed before append.")]);
    }
    if (refreshed.value.memoryOnly) {
      return refusal("pending", [
        reason("locator-unconfirmed", "A locator is visible in memory but not yet proven on disk."),
      ]);
    }
    if (refreshed.value.locator !== null) {
      if (refreshed.value.locator.ownerId !== ownerId) {
        return refusal("unavailable", [
          reason("identity-conflict", "A different persisted accounting owner already owns this session selector."),
        ]);
      }
      return reuseAssociation(
        base,
        selectorSha256,
        refreshed.value,
        created,
        token,
        context,
        signal,
        deadlineAt,
      );
    }
    if (selected !== null) {
      return refusal("invalidated", [
        reason("locator-missing", "This instance previously confirmed an association whose locator is now absent."),
      ]);
    }

    // Complete every host/context/isOwnerCurrent/now callback before the
    // final actual base read. The read must match the original manager and
    // session; nothing but pure checks and the append follows it.
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session or owner changed before append.")]);
    }
    const finalBase = attemptBase(context, base);
    if (finalBase === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed before append.")]);
    }
    if (finalBase.cwd !== finalBase.recordedCwd) {
      return refusal("invalidated", [reason("workspace", "The session workspace no longer matches its recorded workspace.")]);
    }
    let finalBranch: readonly { readonly id: string; readonly parentId: string | null }[];
    try {
      finalBranch = parseActiveBranch(finalBase.branch, finalBase.leafId)
        .map((entry) => ({ id: entry.id, parentId: entry.parentId }));
    } catch {
      return refusal("unavailable", [reason("branch", "The actual session branch is malformed before append.")]);
    }
    if (finalBase.leafId === null) {
      return refusal("invalidated", [reason("leaf", "The actual session has no current non-null leaf.")]);
    }
    // From here the final getEntries scan, pure checks and the original append
    // run with no intervening await or host callback.
    let finalMemory: MemoryScan;
    try {
      finalMemory = scanMemoryEntries(
        managerCall(finalBase.manager, "getEntries", "The actual session manager has no getEntries capability."),
      );
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "entries-unavailable", "The actual session manager entries are unavailable."),
      ]);
    }
    if (finalMemory.locators.length !== 0) {
      return refusal("pending", [
        reason("locator-appeared", "A locator appeared in memory after the journal observation; no append was attempted."),
      ]);
    }
    if (disposed || operation !== token) {
      return refusal("invalidated", [reason("invalidated", "The owning leaf is no longer current.")]);
    }
    const abort = readActualAbortSignal(signal);
    if (!abort.ok || abort.aborted) {
      return refusal("invalidated", [reason("cancelled", "The actual host signal aborted before append.")]);
    }
    const parentId = finalBase.leafId;
    const beforeIds = finalMemory.ids;
    let appendThrew = false;
    try {
      appendEntry(NATIVE_HARNESS_ACCOUNTING_OWNER_LOCATOR_CUSTOM_TYPE, locatorData(locator));
    } catch {
      appendThrew = true;
    }
    if (appendThrew) {
      let recorded: Growth | null = null;
      try {
        recorded = observeGrowth(finalBase, finalBranch, beforeIds, parentId, locator, context);
      } catch {
        recorded = null;
      }
      pendingAppend = Object.freeze({
        session: stableSession(finalBase),
        selectorSha256,
        locator,
        parentId,
        entryId: recorded?.entryId ?? null,
      });
      return refusal("pending", [
        reason("append-unknown", "The host append threw; its outcome is possibly applied and was not retried."),
      ]);
    }
    let growth: Growth | null;
    try {
      growth = observeGrowth(finalBase, finalBranch, beforeIds, parentId, locator, context);
    } catch {
      growth = null;
    }
    pendingAppend = Object.freeze({
      session: stableSession(finalBase),
      selectorSha256,
      locator,
      parentId,
      entryId: growth?.entryId ?? null,
    });
    if (growth === null) {
      return refusal("pending", [
        reason("append-unknown", "The host append produced no exact synchronous branch growth; no confirmation is possible."),
      ]);
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session or owner changed immediately after append.")]);
    }

    const afterEnsure = await runEnsure(finalBase, token, context, signal, deadlineAt);
    if (afterEnsure !== null) return afterEnsure;
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session or owner changed after persistence.")]);
    }
    const reread = attemptBase(context, finalBase);
    if (reread === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed after persistence.")]);
    }
    const journalRead = await readNativeHarnessSessionJournal(
      reread,
      io,
      guard,
      observedAt,
    );
    if (!journalRead.ok) {
      return refusal("unavailable", [journalRead.reason]);
    }
    let journalLocators: readonly JournalLocatorEntry[];
    try {
      journalLocators = scanJournalLocators(journalRead.value);
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "locator", "The persisted locator association is invalid."),
      ]);
    }
    if (journalLocators.some((entry) => !sameLocator(entry.locator, locator))) {
      return refusal("unavailable", [
        reason("identity-conflict", "A different accounting-owner locator is present after append."),
      ]);
    }
    const persisted = journalLocators.filter((entry) => entry.entryId === growth.entryId);
    const diskEntry = journalRead.value.byId.get(growth.entryId);
    if (
      persisted.length !== 1
      || diskEntry === undefined
      || diskEntry.parentId !== parentId
      || !hasValidAncestorChain(journalRead.value, diskEntry)
    ) {
      return refusal("pending", [
        reason("persist-unconfirmed", "The exact appended locator is not yet proven by the bounded disk readback."),
      ]);
    }
    const owner = await observeOwner(selectorSha256);
    if (owner === null || owner.identity.ownerId !== locator.ownerId) {
      return refusal("unavailable", [
        reason("owner-unavailable", "The accounting owner is missing or mismatched after append readback."),
      ]);
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The session, owner, signal or deadline changed.")]);
    }
    const finalBaseRead2 = attemptBase(context, base);
    if (finalBaseRead2 === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed after disk proof.")]);
    }
    let finalTime: number;
    try {
      finalTime = clock();
    } catch {
      return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
    }
    if (!(finalTime < deadlineAt)) {
      return refusal("invalidated", [reason("deadline", "The original deadline elapsed before confirmation.")]);
    }
    if (!ownerCurrent(context) || operation !== token || disposed) {
      return refusal("invalidated", [reason("invalidated", "The owning root or leaf is no longer current.")]);
    }
    const finalAbort = readActualAbortSignal(signal);
    if (!finalAbort.ok || finalAbort.aborted) {
      return refusal("invalidated", [reason("cancelled", "The actual host signal changed before confirmation.")]);
    }
    selected = Object.freeze({
      session: stableSession(base),
      selectorSha256,
      ownerId: locator.ownerId,
    });
    pendingAppend = null;
    return confirmation(
      { ownerId: locator.ownerId, selectorSha256 },
      locator,
      boundedIds(journalLocators.map((entry) => entry.entryId)),
      created,
    );
  }

  async function associate(
    base: PublicationBase,
    selectorSha256: string,
    observation: AssociationObservation,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult> {
    const existing = await observeOwner(selectorSha256);
    let ownerId: string;
    let created = false;
    if (existing !== null) {
      ownerId = existing.identity.ownerId;
      if (!isCurrent(token, context, signal, deadlineAt)) {
        return refusal("invalidated", [reason("invalidated", "The session or owner changed before append.")]);
      }
    } else {
      let absent: boolean;
      try {
        absent = await proveOwnerDirectoryAbsent(storageRoot, selectorSha256, io);
      } catch (error) {
        return refusal("unavailable", [
          errorReason(error, "storage", "The fixed accounting owner directory absence could not be proven."),
        ]);
      }
      if (!absent) {
        return refusal("unavailable", [
          reason("owner-partial", "An existing accounting owner directory is unreadable or partial; nothing was created or repaired."),
        ]);
      }
      if (!isCurrent(token, context, signal, deadlineAt)) {
        return refusal("invalidated", [reason("invalidated", "The session or owner changed before owner creation.")]);
      }
      let createdAt: number;
      try {
        createdAt = clock();
      } catch {
        return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
      }
      // The injected clock is host code and may have replaced the actual
      // context manager. Re-read the exact captured base after it, before
      // any pure gate or owner creation.
      if (attemptBase(context, base) === null) {
        return refusal("invalidated", [
          reason("invalidated", "The actual session identity changed before owner creation."),
        ]);
      }
      // No clock or owner callback runs between this exact base read, the
      // pure checks below and owner creation.
      if (disposed || operation !== token) {
        return refusal("invalidated", [reason("invalidated", "The owning leaf changed before owner creation.")]);
      }
      if (!(createdAt < deadlineAt)) {
        return refusal("invalidated", [reason("deadline", "The original deadline elapsed before owner creation.")]);
      }
      const preCreateAbort = readActualAbortSignal(signal);
      if (!preCreateAbort.ok || preCreateAbort.aborted) {
        return refusal("invalidated", [reason("cancelled", "The actual host signal changed before owner creation.")]);
      }
      ownerId = randomUUID();
      let handle: NativeHarnessAccountingHandle | NativeHarnessRecoveryAccountingHandle | null = null;
      try {
        const createOptions = {
          storageRoot,
          selectorSha256,
          ownerId,
          createdAt,
          limitsText,
        };
        handle = recoveryAccounting
          ? await createNativeHarnessRecoveryAccountingOwner(createOptions)
          : await createNativeHarnessAccountingOwner(createOptions);
        const snapshot = handle.snapshot();
        if (snapshot.ownerId !== ownerId || snapshot.selectorSha256 !== selectorSha256) {
          return refusal("unavailable", [
            reason("owner-mismatch", "The created accounting owner identity does not match this selector."),
          ]);
        }
        created = true;
      } catch (error) {
        handle?.close();
        handle = null;
        if (error instanceof NativeHarnessAccountingError && error.code === "conflict") {
          const winner = await observeOwner(selectorSha256);
          if (winner === null) {
            return refusal("unavailable", [
              reason("owner-conflict", "A concurrent accounting owner creation won the race but is not observable."),
            ]);
          }
          ownerId = winner.identity.ownerId;
        } else if (error instanceof NativeHarnessAccountingError && error.code === "ambiguous") {
          return refusal("unavailable", [
            reason("owner-ambiguous", "The accounting owner creation outcome is ambiguous; existing bytes were preserved."),
          ]);
        } else {
          return refusal("unavailable", [
            reason("owner-create", "The accounting owner could not be created."),
          ]);
        }
      } finally {
        handle?.close();
      }
      if (!isCurrent(token, context, signal, deadlineAt)) {
        return refusal("invalidated", [
          reason("invalidated", "The session or owner changed during owner creation; the owner was left on disk."),
        ]);
      }
    }
    return appendAndConfirm(
      base,
      selectorSha256,
      ownerId,
      created,
      token,
      context,
      signal,
      deadlineAt,
    );
  }

  async function run(
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult> {
    const initialBase = attemptBase(context, null);
    if (initialBase === null) {
      const read = readPublicationBase(context);
      if (!read.ok) {
        return refusal("invalidated", [read.reason]);
      }
      return refusal("invalidated", [
        reason("session", "The actual main session identity is unavailable or self-inconsistent."),
      ]);
    }
    if (initialBase.cwd !== initialBase.recordedCwd) {
      return refusal("invalidated", [
        reason("workspace", "The live and recorded session workspaces differ; relocation is refused."),
      ]);
    }
    attemptIdentity = initialBase;
    let selectorSha256: string;
    let initialSession: StableSession;
    try {
      selectorSha256 = selectorSha256For(initialBase);
      initialSession = stableSession(initialBase);
      parseActiveBranch(initialBase.branch, initialBase.leafId);
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "session", "The actual main session identity or branch is unavailable."),
      ]);
    }
    if (selected !== null) {
      if (
        selected.selectorSha256 !== selectorSha256
        || !sameStableSession(selected.session, initialSession)
      ) {
        return refusal("invalidated", [
          reason("identity-conflict", "This instance already selected a different session or accounting owner identity."),
        ]);
      }
    }
    if (pendingAppend !== null) {
      if (
        pendingAppend.selectorSha256 !== selectorSha256
        || !sameStableSession(pendingAppend.session, initialSession)
      ) {
        return refusal("invalidated", [
          reason("identity-conflict", "The pending append belongs to a different session identity."),
        ]);
      }
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The actual main session is not current.")]);
    }

    const ensureFailure = await runEnsure(initialBase, token, context, signal, deadlineAt);
    if (ensureFailure !== null) return ensureFailure;
    const afterEnsure = attemptBase(context, initialBase);
    if (afterEnsure === null) {
      return refusal("invalidated", [reason("invalidated", "The actual session identity changed during persistence.")]);
    }
    try {
      parseActiveBranch(afterEnsure.branch, afterEnsure.leafId);
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "branch", "The actual session branch is malformed."),
      ]);
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The actual main session is not current after persistence.")]);
    }

    const observation = await observeAssociation(afterEnsure, token, context, signal, deadlineAt);
    if (!observation.ok) return observation.failure;
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The actual main session changed after journal observation.")]);
    }
    if (pendingAppend !== null) {
      return confirmPendingAppend(
        afterEnsure,
        selectorSha256,
        observation.value,
        token,
        context,
        signal,
        deadlineAt,
      );
    }
    if (observation.value.memoryOnly) {
      return refusal("pending", [
        reason("locator-unconfirmed", "A locator is visible in memory but not proven by its exact persisted entry."),
      ]);
    }
    if (observation.value.locator !== null) {
      if (observation.value.locator.selectorSha256 !== selectorSha256) {
        return refusal("unavailable", [
          reason("identity-conflict", "A persisted locator belongs to a different session selector."),
        ]);
      }
      return reuseAssociation(
        afterEnsure,
        selectorSha256,
        observation.value,
        false,
        token,
        context,
        signal,
        deadlineAt,
      );
    }
    if (selected !== null) {
      return refusal("invalidated", [
        reason("locator-missing", "This instance previously confirmed an association whose locator is now absent."),
      ]);
    }
    return associate(
      afterEnsure,
      selectorSha256,
      observation.value,
      token,
      context,
      signal,
      deadlineAt,
    );
  }

  async function runExisting(
    expected: NativeHarnessAccountingExistingIdentity,
    token: symbol,
    context: unknown,
    signal: unknown,
    deadlineAt: number,
  ): Promise<NativeHarnessAccountingSessionResult> {
    const initialBase = attemptBase(context, null);
    if (initialBase === null) {
      const read = readPublicationBase(context);
      if (!read.ok) {
        return refusal("invalidated", [read.reason]);
      }
      return refusal("invalidated", [
        reason("session", "The actual main session identity is unavailable or self-inconsistent."),
      ]);
    }
    if (initialBase.cwd !== initialBase.recordedCwd) {
      return refusal("invalidated", [
        reason("workspace", "The live and recorded session workspaces differ; relocation is refused."),
      ]);
    }
    attemptIdentity = initialBase;
    let selectorSha256: string;
    let initialSession: StableSession;
    try {
      selectorSha256 = selectorSha256For(initialBase);
      initialSession = stableSession(initialBase);
      parseActiveBranch(initialBase.branch, initialBase.leafId);
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "session", "The actual main session identity or branch is unavailable."),
      ]);
    }
    if (selectorSha256 !== expected.selectorSha256) {
      return refusal("unavailable", [
        reason("selector", "The expected accounting selector does not match the actual main session."),
      ]);
    }
    if (selected !== null) {
      if (
        selected.ownerId !== expected.ownerId
        || selected.selectorSha256 !== selectorSha256
        || !sameStableSession(selected.session, initialSession)
      ) {
        return refusal("invalidated", [
          reason("identity-conflict", "This instance already selected a different session or accounting owner identity."),
        ]);
      }
    }
    if (pendingAppend !== null) {
      return refusal("pending", [
        reason(
          "append-unknown",
          "A previously attempted append is pending; existing-only observation never confirms or repairs it.",
        ),
      ]);
    }
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The actual main session is not current.")]);
    }
    const observeBase = attemptBase(context, initialBase);
    if (observeBase === null) {
      return refusal("invalidated", [
        reason("invalidated", "The actual session identity changed before journal observation."),
      ]);
    }

    const observation = await observeAssociation(observeBase, token, context, signal, deadlineAt);
    if (!observation.ok) return observation.failure;
    if (!isCurrent(token, context, signal, deadlineAt)) {
      return refusal("invalidated", [reason("invalidated", "The actual main session changed after journal observation.")]);
    }
    const afterJournal = attemptBase(context, observeBase);
    if (afterJournal === null) {
      return refusal("invalidated", [
        reason("invalidated", "The actual session identity changed after journal observation."),
      ]);
    }
    try {
      parseActiveBranch(afterJournal.branch, afterJournal.leafId);
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "branch", "The actual session branch conflicts with its persisted facts."),
      ]);
    }
    if (pendingAppend !== null) {
      return refusal("pending", [
        reason(
          "append-unknown",
          "A previously attempted append is pending; existing-only observation never confirms or repairs it.",
        ),
      ]);
    }
    if (observation.value.memoryOnly) {
      return refusal("pending", [
        reason("locator-unconfirmed", "A locator is visible in memory but not proven by its exact persisted entry."),
      ]);
    }
    const locator = observation.value.locator;
    if (locator === null) {
      return refusal("unavailable", [
        reason("locator", "No persisted accounting-owner locator exists for this session; existing-only observation creates none."),
      ]);
    }
    if (locator.selectorSha256 !== selectorSha256 || locator.selectorSha256 !== expected.selectorSha256) {
      return refusal("unavailable", [
        reason("identity-conflict", "The persisted locator belongs to a different session selector."),
      ]);
    }
    if (locator.ownerId !== expected.ownerId) {
      return refusal("unavailable", [
        reason("identity-conflict", "The persisted locator owner id does not match the expected identity."),
      ]);
    }
    if (observation.value.journalEntries.length === 0) {
      return refusal("unavailable", [
        reason("locator", "The observed locator has no exact persisted journal entry."),
      ]);
    }
    for (const entry of observation.value.journalEntries) {
      const disk = observation.value.journal.byId.get(entry.entryId);
      if (
        disk === undefined
        || disk.parentId !== entry.parentId
        || !hasValidAncestorChain(observation.value.journal, disk)
      ) {
        return refusal("unavailable", [
          reason("branch", "The persisted locator conflicts with its journal ancestor chain."),
        ]);
      }
    }

    return reuseAssociation(
      afterJournal,
      selectorSha256,
      observation.value,
      false,
      token,
      context,
      signal,
      deadlineAt,
      { ownerId: expected.ownerId, requireV2: true },
    );
  }

  async function withAttempt(
    context: unknown,
    signal: unknown,
    deadlineAt: number,
    finalBranchRequired: boolean,
    attempt: (
      token: symbol,
      context: unknown,
      signal: unknown,
      deadlineAt: number,
    ) => Promise<NativeHarnessAccountingSessionResult>,
  ): Promise<NativeHarnessAccountingSessionResult> {
    if (disposed) {
      return refusal("invalidated", [reason("disposed", "The accounting association leaf is disposed.")]);
    }
    if (operation !== null) {
      return refusal("pending", [
        reason("association-pending", "Another association operation currently owns this leaf."),
      ]);
    }
    if (pendingEnsure !== null) {
      return refusal("pending", [
        reason("persist-pending", "An earlier actual persistence wait is still unsettled."),
      ]);
    }
    const token = Symbol("native-harness-accounting-session-operation");
    operation = token;
    try {
      if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
        return refusal("invalidated", [reason("deadline", "The caller-supplied original deadline is not finite.")]);
      }
      const abort = readActualAbortSignal(signal);
      if (!abort.ok) {
        return refusal("invalidated", [reason("signal", "The actual host AbortSignal is unavailable.")]);
      }
      if (abort.aborted) {
        return refusal("invalidated", [reason("cancelled", "The actual host signal is already aborted.")]);
      }
      let startTime: number;
      try {
        startTime = clock();
      } catch {
        return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
      }
      if (!(startTime < deadlineAt)) {
        return refusal("invalidated", [reason("deadline", "The caller-supplied original deadline already elapsed.")]);
      }
      if (!ownerCurrent(context)) {
        return refusal("invalidated", [reason("owner-changed", "The owning native root is not current.")]);
      }
      const result = await attempt(token, context, signal, deadlineAt);
      if (result.state !== "confirmed") return result;
      // The inner operation can complete synchronously up to its return while
      // a queued abort/dispose microtask is still pending. Seal the exact
      // captured attempt here without starting new I/O.
      const expected = attemptIdentity;
      if (expected === null) {
        return refusal("invalidated", [reason("invalidated", "The attempt identity is unavailable for the final seal.")]);
      }
      // Complete the clock and owner callbacks before the final exact base
      // read; they may replace the actual context manager.
      let sealedTime: number;
      try {
        sealedTime = clock();
      } catch {
        return refusal("invalidated", [reason("clock", "The trusted clock is unavailable.")]);
      }
      if (!(sealedTime < deadlineAt) || !ownerCurrent(context)) {
        return refusal("invalidated", [reason("invalidated", "The session, owner, manager or deadline changed before delivery.")]);
      }
      const sealedBase = attemptBase(context, expected);
      if (sealedBase === null) {
        return refusal("invalidated", [reason("invalidated", "The session, owner, manager or deadline changed before delivery.")]);
      }
      // Existing-only confirmation also seals the branch chain captured by the
      // last base read. Only own data from that bounded captured array is
      // copied and parsed; entry accessors never run and no host callback,
      // clock read, I/O, ensure, append or repair starts.
      if (finalBranchRequired) {
        try {
          parseActiveBranch(copyFinalBranchEntries(sealedBase.branch), sealedBase.leafId);
        } catch (error) {
          return refusal("unavailable", [
            errorReason(error, "branch", "The actual session final branch is unavailable or malformed."),
          ]);
        }
      }
      // Pure checks only; no new I/O or callbacks after this point.
      if (disposed || operation !== token) {
        return refusal("invalidated", [reason("invalidated", "The owning leaf is no longer current.")]);
      }
      const sealAbort = readActualAbortSignal(signal);
      if (!sealAbort.ok || sealAbort.aborted) {
        return refusal("invalidated", [reason("cancelled", "The actual host signal aborted before delivery.")]);
      }
      return result;
    } catch (error) {
      return refusal("unavailable", [
        errorReason(error, "association", "The accounting-owner association could not be completed."),
      ]);
    } finally {
      if (operation === token) {
        operation = null;
        attemptIdentity = null;
      }
    }
  }

  return Object.freeze({
    async ensure(
      context: unknown,
      signal: unknown,
      deadlineAt: number,
    ): Promise<NativeHarnessAccountingSessionResult> {
      return withAttempt(
        context,
        signal,
        deadlineAt,
        false,
        (token, attemptContext, attemptSignal, attemptDeadline) =>
          run(token, attemptContext, attemptSignal, attemptDeadline),
      );
    },
    async observeExisting(
      context: unknown,
      expectedIdentity: NativeHarnessAccountingExistingIdentity,
      signal: unknown,
      deadlineAt: number,
    ): Promise<NativeHarnessAccountingSessionResult> {
      // Copy the exact expected identity before any await or host callback.
      let expected: NativeHarnessAccountingExistingIdentity;
      try {
        expected = readExistingIdentity(expectedIdentity);
      } catch (error) {
        return refusal("invalidated", [
          errorReason(
            error,
            "identity",
            "The expected accounting identity is not exact plain ownerId/selectorSha256 data.",
          ),
        ]);
      }
      return withAttempt(
        context,
        signal,
        deadlineAt,
        true,
        (token, attemptContext, attemptSignal, attemptDeadline) =>
          runExisting(expected, token, attemptContext, attemptSignal, attemptDeadline),
      );
    },
    dispose(): void {
      disposed = true;
    },
  });
}
