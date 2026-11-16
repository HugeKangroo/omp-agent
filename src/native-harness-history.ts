import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import path from "node:path";
import {
  decodeRunEventsText,
  decodeRunHistoryText,
  type RunEvent,
  type RunRecord,
} from "../vendor/harness2/index.ts";
import { readActualAbortSignal } from "./native-abort.ts";
import {
  NATIVE_HARNESS_HISTORY_PROCESS_LIMITS,
  collectNativeHarnessHistoryProcess,
  decodeNativeHarnessHistoryProcessOwner,
  deriveNativeHarnessHistoryProcessTargets,
  ownerReadWithoutIo,
  uninspectedProcessObservation,
  type NativeHarnessHistoryProcessObservation,
  type NativeHarnessHistoryProcessOsObserver,
  type NativeHarnessHistoryProcessOwnerRead,
  type NativeHarnessHistoryProcessTarget,
} from "./native-harness-history-process.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  deepFreeze,
  nodeFileIo,
  validateRelativePath,
  type NativeFileIo,
  type NativeFileStats,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";

/**
 * R1a readonly native Harness history core.
 *
 * This module owns no scheduler, run/evidence/permission ledger, execution
 * authority, process inspection or second event store. It accepts one decoded
 * version-1 locator, reads the locator-selected run and events through the
 * existing bounded workspace text capture, and optionally compares bounded
 * declared artifact bytes. It never calls the vendor RunStore get/events
 * methods, never reads a backup, never acquires a lock and never writes.
 *
 * Labels in the locator are historical declarations. They are not signed
 * provenance, runtime source verification or proof of the bytes now on disk.
 */

export const NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA =
  "omp-agent.native-harness-history-locator.v1" as const;
export const NATIVE_HARNESS_HISTORY_PROJECTION_SCHEMA =
  "omp-agent.native-harness-history-projection.v1" as const;
export const NATIVE_HARNESS_HISTORY_SOURCE_INTEGRITY = "build-label-only" as const;

export const NATIVE_HARNESS_HISTORY_LIMITS = Object.freeze({
  locatorBytes: 4096,
  runBytes: 256 * 1024,
  eventsBytes: 256 * 1024,
  eventRows: 4096,
  maxDeclaredArtifacts: 8,
  artifactBytes: 256 * 1024,
  artifactTotalBytes: 1024 * 1024,
  /** Independent worst-case reservation allowance for artifact reads. */
  artifactReadBytes: 1024 * 1024,
  queryBytes: 2 * 1024 * 1024,
  resultBytes: 64 * 1024,
  reasonChars: 320,
  maxReasons: 16,
  pathChars: 4096,
  labelChars: 256,
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HARNESS_DIRECTORY_PATTERN = /^omp-harness-[A-Za-z0-9]{6}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

export interface NativeHarnessHistoryLocatorSource {
  /** Historical source tool-call label; null means unavailable, not verified. */
  readonly toolCallId: string | null;
  /** Historical work observation label; null means unavailable, not verified. */
  readonly observationId: string | null;
  /** Historical observation generation; null means unavailable, not inferred. */
  readonly generation: number | null;
}

export interface NativeHarnessHistoryEvidenceReference {
  readonly entryId: string;
  readonly sha256: string;
}

/**
 * Optional pointers to already-existing transcript entries. They are labels
 * and fingerprints only; this module never reads a session transport.
 */
export interface NativeHarnessHistoryEvidence {
  readonly source: NativeHarnessHistoryEvidenceReference | null;
  readonly report: NativeHarnessHistoryEvidenceReference | null;
}

/**
 * Factual version-1 locator. The decoder rejects unknown fields, absolute or
 * traversing store paths and any run ID/path mismatch before this type exists.
 */
export interface NativeHarnessHistoryLocator {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA;
  readonly version: 1;
  readonly originSessionId: string;
  /** Original main workspace label; it is not used as a read root. */
  readonly workspacePath: string;
  readonly source: NativeHarnessHistoryLocatorSource;
  readonly runId: string;
  /** Exact `<omp-harness-6>/store/runs/<runId>` relative path. */
  readonly storeRelativePath: string;
  readonly inputManifestSha256: string | null;
  readonly definitionVersion: string | null;
  readonly backendSourceId: string | null;
  readonly configurationSha256: string | null;
  readonly evidence: NativeHarnessHistoryEvidence | null;
}

export type NativeHarnessHistoryLocatorDecodeReason =
  | "locator-not-text"
  | "locator-oversized"
  | "locator-malformed"
  | "locator-shape"
  | "locator-field"
  | "locator-encoding";

export type NativeHarnessHistoryLocatorDecode =
  | {
      readonly ok: true;
      readonly locator: NativeHarnessHistoryLocator;
      /** Canonical UTF-8 byte count and digest of the normalized locator. */
      readonly bytes: number;
      readonly sha256: string;
    }
  | {
      readonly ok: false;
      readonly reason: NativeHarnessHistoryLocatorDecodeReason;
      readonly detail: string;
    };

/**
 * One artifact fact declared by an earlier source/report observation. The path
 * is relative to the actual winner stage/attempt workspace, never an absolute
 * selector. Declared facts are historical statements, not observed bytes.
 */
export interface NativeHarnessHistoryDeclaredArtifact {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly declaredAt?: string | null;
  readonly declaredByEntryId?: string | null;
}

export interface NativeHarnessHistoryInspectRequest {
  /** Trusted host root; it must be absolute, normalized and canonical. */
  readonly storageRoot: string;
  readonly locator: NativeHarnessHistoryLocator;
  readonly declaredArtifacts?: readonly NativeHarnessHistoryDeclaredArtifact[] | null;
  /** Actual host AbortSignal; missing or duck-typed values are not accepted. */
  readonly signal: AbortSignal;
  /** Narrow test seam. Production uses the existing native-work file IO. */
  readonly fileIo?: NativeFileIo;
  readonly now?: () => number;
  /**
   * Optional trusted bounded OS observer. Omission preserves the exact old
   * `inspected:false` projection and starts zero extra I/O.
   */
  readonly processObserver?: NativeHarnessHistoryProcessOsObserver;
}

export interface NativeHarnessHistoryReason {
  readonly code: string;
  readonly detail: string;
}

export interface NativeHarnessHistoryFileObservation {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

export interface NativeHarnessHistoryStageProjection {
  readonly id: string;
  readonly status: "running" | "completed" | "failed";
  readonly attempt: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly resultKnown: boolean;
  readonly validationFailures: number | null;
}

export interface NativeHarnessHistoryEventsProjection {
  readonly state: "observed" | "empty" | "unavailable";
  readonly rows: number | null;
  readonly file: NativeHarnessHistoryFileObservation | null;
  readonly problem: NativeHarnessHistoryReason | null;
}

export interface NativeHarnessHistoryRecorded {
  readonly state: "observed" | "unavailable";
  readonly runId: string | null;
  readonly format: "harness2-run-json-v1-or-v2";
  readonly status: RunRecord["status"] | null;
  readonly revision: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** The status is what run.json recorded; it is not a current process state. */
  readonly statusBasis: "recorded-run-json-only";
  readonly stages: readonly NativeHarnessHistoryStageProjection[];
  readonly runFile: NativeHarnessHistoryFileObservation | null;
  readonly events: NativeHarnessHistoryEventsProjection;
  readonly observationsAtomicity: "sequential-not-atomic";
  readonly limitations: readonly string[];
}

export type NativeHarnessHistoryComparisonResult = "match" | "mismatch" | "unavailable";

export interface NativeHarnessHistoryLabelComparison {
  readonly declared: string | null;
  readonly recorded: string | null;
  readonly result: NativeHarnessHistoryComparisonResult;
  readonly basis: "label-only";
}

export interface NativeHarnessHistoryOriginCompatibility {
  readonly basis: "declared-labels-versus-recorded-labels-only";
  readonly runId: NativeHarnessHistoryLabelComparison;
  readonly workspace: NativeHarnessHistoryLabelComparison;
  readonly workspaceLayout: NativeHarnessHistoryComparisonResult;
  readonly definitionVersion: NativeHarnessHistoryLabelComparison;
  readonly backendSourceId: NativeHarnessHistoryLabelComparison;
  readonly configurationSha256: NativeHarnessHistoryLabelComparison;
  readonly inputManifestSha256: NativeHarnessHistoryLabelComparison;
  readonly currentAdoption: false;
  readonly limitations: readonly string[];
}

export interface NativeHarnessHistoryCostFact {
  readonly usd: number | null;
  readonly source: "recorded-stage" | "unknown";
}

export interface NativeHarnessHistoryStageAccounting {
  readonly stage: string;
  readonly observed: NativeHarnessHistoryCostFact;
  readonly reserved: NativeHarnessHistoryCostFact;
  readonly accounted: NativeHarnessHistoryCostFact;
  readonly resultKnown: boolean;
  readonly usageEstimated: boolean | null;
}

export interface NativeHarnessHistoryAccounting {
  readonly basis: "recorded-stage-fields-only";
  /** No total is invented from missing stage fields. */
  readonly costTotal: NativeHarnessHistoryCostFact;
  readonly outerLifetime: "unknown";
  readonly originalDeadline: "unknown";
  readonly stages: readonly NativeHarnessHistoryStageAccounting[];
  readonly limitations: readonly string[];
}

export type NativeHarnessHistoryArtifactStatus =
  | "match"
  | "bytes-mismatch"
  | "hash-mismatch"
  | "content-mismatch"
  | "declaration-invalid"
  | "missing"
  | "non-text"
  | "oversize"
  | "unsafe-path"
  | "invalid-path"
  | "changed"
  | "artifact-budget-exhausted"
  | "query-budget-exhausted"
  | "unavailable";

export interface NativeHarnessHistoryArtifactResult {
  readonly relativePath: string;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  readonly declaredAt: string | null;
  readonly declaredByEntryId: string | null;
  readonly observedBytes: number | null;
  readonly observedSha256: string | null;
  readonly observedAt: number | null;
  readonly bytesMatch: boolean | null;
  readonly hashMatch: boolean | null;
  readonly status: NativeHarnessHistoryArtifactStatus;
  readonly problem: NativeHarnessHistoryReason | null;
}

export interface NativeHarnessHistoryArtifactIntegrity {
  readonly state: "declared-files-matched" | "partial" | "unavailable";
  readonly coverage: "declared-files-only" | "unavailable";
  readonly manifest: "absent" | "empty" | "present" | "invalid";
  /** True only after every declared artifact was attempted to a final status. */
  readonly complete: boolean;
  /** No mode, tree, trace or provenance claim is made here. */
  readonly mode: "not-checked";
  readonly tree: "not-checked";
  readonly traces: "not-checked";
  readonly provenance: "not-restored";
  readonly declaredCount: number;
  readonly observedCount: number;
  readonly matchedCount: number;
  readonly totalDeclaredBytes: number;
  readonly totalObservedBytes: number;
  readonly winner: string | null;
  readonly results: readonly NativeHarnessHistoryArtifactResult[];
  readonly problem: NativeHarnessHistoryReason | null;
  readonly limitations: readonly string[];
}

export type {
  NativeHarnessHistoryProcessEntry,
  NativeHarnessHistoryProcessObservation,
} from "./native-harness-history-process.ts";
export type {
  NativeHarnessHistoryProcessLimitedObservation,
  NativeHarnessHistoryProcessRow,
} from "./native-harness-history-process.ts";

export interface NativeHarnessHistoryEligibility {
  readonly readOnly: true;
  readonly authorityRestored: false;
  readonly resumeAvailable: false;
  readonly liveAttach: "unsupported";
  readonly recoverableFormat: false;
  readonly missingForResume: readonly string[];
  readonly limitations: readonly string[];
}

export interface NativeHarnessHistoryReadBudget {
  readonly limitBytes: number;
  /** Worst-case reservation still charged, including failed/unknown reads. */
  readonly chargedBytes: number;
  /** Sum of file sizes returned in successful observations only. */
  readonly observedBytes: number;
  readonly failedReads: number;
  readonly outcome: "within-budget" | "exhausted" | "unknown-usage";
}

export interface NativeHarnessHistoryQuery {
  readonly runId: string | null;
  readonly storeRelativePath: string | null;
  readonly storageRoot: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
  /** Sum of returned successful file observations, not unknown partial reads. */
  readonly observedBytes: number;
  readonly readBudget: NativeHarnessHistoryReadBudget;
  readonly artifactReadBudget: NativeHarnessHistoryReadBudget;
  readonly rootState: "pinned" | "invalid" | "changed";
  readonly declaration: "recorded-history-only";
}

export type NativeHarnessHistoryState =
  | "observed"
  | "partial"
  | "uncertain"
  | "unavailable"
  | "aborted";

export interface NativeHarnessHistoryInspection {
  readonly schema: typeof NATIVE_HARNESS_HISTORY_PROJECTION_SCHEMA;
  readonly version: 1;
  readonly state: NativeHarnessHistoryState;
  readonly query: NativeHarnessHistoryQuery;
  readonly recorded: NativeHarnessHistoryRecorded;
  readonly originCompatibility: NativeHarnessHistoryOriginCompatibility;
  readonly processObservation: NativeHarnessHistoryProcessObservation;
  readonly artifactIntegrity: NativeHarnessHistoryArtifactIntegrity;
  readonly accounting: NativeHarnessHistoryAccounting;
  readonly eligibility: NativeHarnessHistoryEligibility;
  readonly reasons: readonly NativeHarnessHistoryReason[];
}

const issuedLocators = new WeakSet<NativeHarnessHistoryLocator>();

/** Source-identity check for this module only; it is not a permission grant. */
export function isNativeHarnessHistoryLocator(value: unknown): value is NativeHarnessHistoryLocator {
  return typeof value === "object" && value !== null && issuedLocators.has(value as NativeHarnessHistoryLocator);
}

class LocatorDecodeFailure extends Error {
  constructor(
    readonly reason: NativeHarnessHistoryLocatorDecodeReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  if (!required.every((key) => keys.includes(key))) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedLabel(value: unknown, maxChars: number = NATIVE_HARNESS_HISTORY_LIMITS.labelChars): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxChars
    && !CONTROL_PATTERN.test(value);
}

function nullableLabel(value: unknown): string | null {
  if (value === null) return null;
  if (!boundedLabel(value)) throw new LocatorDecodeFailure("locator-field", "A nullable locator label is not bounded text.");
  return value;
}

function nullableSha256(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new LocatorDecodeFailure("locator-field", "A nullable locator digest is not a lowercase SHA-256 value.");
  }
  return value;
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= NATIVE_HARNESS_HISTORY_LIMITS.pathChars
    && !value.includes("\0")
    && !CONTROL_PATTERN.test(value)
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && value !== path.parse(value).root;
}

function readStoreRelativePath(value: unknown, runId: string): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 1024
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")) {
    throw new LocatorDecodeFailure("locator-field", "The store-relative path is not an unambiguous POSIX path.");
  }
  const segments = value.split("/");
  if (segments.length !== 4
    || !HARNESS_DIRECTORY_PATTERN.test(segments[0] ?? "")
    || segments[1] !== "store"
    || segments[2] !== "runs"
    || segments[3] !== runId) {
    throw new LocatorDecodeFailure(
      "locator-field",
      "The store-relative path is not exactly <omp-harness-6>/store/runs/<runId>.",
    );
  }
  return value;
}

function readEvidenceReference(value: unknown): NativeHarnessHistoryEvidenceReference | null {
  if (value === null) return null;
  if (!plainObject(value) || !exactKeys(value, ["entryId", "sha256"])) {
    throw new LocatorDecodeFailure("locator-shape", "A locator evidence reference has an unexpected shape.");
  }
  if (!boundedLabel(value.entryId)) {
    throw new LocatorDecodeFailure("locator-field", "A locator evidence entry ID is not bounded text.");
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new LocatorDecodeFailure("locator-field", "A locator evidence fingerprint is not a lowercase SHA-256 value.");
  }
  return Object.freeze({ entryId: value.entryId, sha256: value.sha256 });
}

function readEvidence(value: unknown): NativeHarnessHistoryEvidence | null {
  if (value === null) return null;
  if (!plainObject(value) || !exactKeys(value, ["source", "report"])) {
    throw new LocatorDecodeFailure("locator-shape", "The locator evidence field has an unexpected shape.");
  }
  return Object.freeze({
    source: readEvidenceReference(value.source),
    report: readEvidenceReference(value.report),
  });
}

function decodeLocatorText(text: string): NativeHarnessHistoryLocator {
  if (Buffer.byteLength(text, "utf8") > NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes) {
    throw new LocatorDecodeFailure(
      "locator-oversized",
      `The locator text exceeds ${NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes} UTF-8 bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LocatorDecodeFailure("locator-malformed", "The locator text is not valid JSON.");
  }
  if (!plainObject(parsed)) {
    throw new LocatorDecodeFailure("locator-shape", "The locator must be a JSON object.");
  }
  if (!exactKeys(parsed, [
    "schema",
    "version",
    "originSessionId",
    "workspacePath",
    "source",
    "runId",
    "storeRelativePath",
    "inputManifestSha256",
    "definitionVersion",
    "backendSourceId",
    "configurationSha256",
  ], ["evidence"])) {
    throw new LocatorDecodeFailure("locator-shape", "The locator contains missing or unknown fields.");
  }
  if (parsed.schema !== NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA || parsed.version !== 1) {
    throw new LocatorDecodeFailure("locator-shape", "The locator schema or version is not supported.");
  }
  if (!boundedLabel(parsed.originSessionId)) {
    throw new LocatorDecodeFailure("locator-field", "The origin session ID is not bounded text.");
  }
  if (!isCanonicalAbsolutePath(parsed.workspacePath)) {
    throw new LocatorDecodeFailure("locator-field", "The workspace label is not an absolute normalized path.");
  }
  if (typeof parsed.runId !== "string" || !ID_PATTERN.test(parsed.runId)) {
    throw new LocatorDecodeFailure("locator-field", "The run ID is not a supported identifier.");
  }
  const storeRelativePath = readStoreRelativePath(parsed.storeRelativePath, parsed.runId);
  if (!plainObject(parsed.source) || !exactKeys(parsed.source, ["toolCallId", "observationId", "generation"])) {
    throw new LocatorDecodeFailure("locator-shape", "The locator source field has an unexpected shape.");
  }
  const toolCallId = nullableLabel(parsed.source.toolCallId);
  const observationId = nullableLabel(parsed.source.observationId);
  const generation = parsed.source.generation;
  if (generation !== null && (!Number.isSafeInteger(generation) || (generation as number) < 0)) {
    throw new LocatorDecodeFailure("locator-field", "The observation generation is not a non-negative safe integer.");
  }
  const inputManifestSha256 = nullableSha256(parsed.inputManifestSha256);
  const definitionVersion = nullableLabel(parsed.definitionVersion);
  const backendSourceId = nullableSha256(parsed.backendSourceId);
  const configurationSha256 = nullableSha256(parsed.configurationSha256);
  const evidence = readEvidence(parsed.evidence ?? null);
  const normalized: NativeHarnessHistoryLocator = {
    schema: NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
    version: 1,
    originSessionId: parsed.originSessionId,
    workspacePath: parsed.workspacePath,
    source: Object.freeze({
      toolCallId,
      observationId,
      generation: generation === null ? null : (generation as number),
    }),
    runId: parsed.runId,
    storeRelativePath,
    inputManifestSha256,
    definitionVersion,
    backendSourceId,
    configurationSha256,
    evidence,
  };
  const fingerprint = fingerprintNativeJson(normalized);
  if (!fingerprint.ok) {
    throw new LocatorDecodeFailure("locator-encoding", "The normalized locator is not representable as canonical JSON.");
  }
  if (fingerprint.bytes > NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes) {
    throw new LocatorDecodeFailure(
      "locator-oversized",
      `The canonical locator exceeds ${NATIVE_HARNESS_HISTORY_LIMITS.locatorBytes} bytes.`,
    );
  }
  return normalized;
}

/**
 * Strict bounded decoder for one locator text. It performs no I/O, accepts only
 * the known version-1 fields and returns a frozen normalized copy. Unknown
 * fields, oversized text, malformed JSON and non-canonical/mismatched paths are
 * rejected rather than repaired.
 */
export function decodeNativeHarnessHistoryLocator(text: string): NativeHarnessHistoryLocatorDecode {
  if (typeof text !== "string") {
    return {
      ok: false,
      reason: "locator-not-text",
      detail: "The locator value is not text.",
    };
  }
  try {
    const locator = deepFreeze(decodeLocatorText(text));
    issuedLocators.add(locator);
    const fingerprint = fingerprintNativeJson(locator);
    if (!fingerprint.ok) {
      return {
        ok: false,
        reason: "locator-encoding",
        detail: "The normalized locator is not representable as canonical JSON.",
      };
    }
    return { ok: true, locator, bytes: fingerprint.bytes, sha256: fingerprint.sha256 };
  } catch (error) {
    if (error instanceof LocatorDecodeFailure) {
      return { ok: false, reason: error.reason, detail: error.detail };
    }
    return {
      ok: false,
      reason: "locator-malformed",
      detail: "The locator could not be decoded from its text.",
    };
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function reason(code: string, detail: string): NativeHarnessHistoryReason {
  return { code, detail: compactReason(detail) };
}

function compactReason(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= NATIVE_HARNESS_HISTORY_LIMITS.reasonChars) return normalized;
  return normalized.slice(0, NATIVE_HARNESS_HISTORY_LIMITS.reasonChars);
}

function addReason(list: NativeHarnessHistoryReason[], value: NativeHarnessHistoryReason): void {
  if (list.some((entry) => entry.code === value.code)) return;
  if (list.length >= NATIVE_HARNESS_HISTORY_LIMITS.maxReasons - 1) {
    if (!list.some((entry) => entry.code === "additional-reasons-omitted")) {
      list.push(reason("additional-reasons-omitted", "Additional bounded reasons were omitted."));
    }
    return;
  }
  list.push(value);
}

function clock(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
  } catch {
    return Date.now();
  }
}

function readClock(now: (() => number) | undefined): number {
  return clock(now ?? Date.now);
}

function withNonBlocking(io: NativeFileIo): NativeFileIo {
  const nonBlocking = constants.O_NONBLOCK ?? 0;
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: (target) => io.realpath(target),
    lstat: (target, options) => io.lstat(target, options),
    // A lstat-regular file can be replaced by a FIFO before open. O_NONBLOCK
    // keeps that open from blocking; the opened regular-file check still fails.
    open: (target, flags) => io.open(target, flags | nonBlocking),
  };
}

interface RootPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function sameDirectoryIdentity(left: RootPin, right: NativeFileStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

type RootPinResult =
  | { readonly ok: true; readonly pin: RootPin }
  | { readonly ok: false; readonly problem: NativeHarnessHistoryReason };

async function pinStorageRoot(root: unknown, io: NativeFileIo): Promise<RootPinResult> {
  if (!isCanonicalAbsolutePath(root)) {
    return {
      ok: false,
      problem: reason(
        "storage-root-invalid",
        "The host storage root must be an absolute, normalized, canonical non-root path.",
      ),
    };
  }
  let resolved: string;
  try {
    resolved = await io.realpath(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ok: false, problem: reason("storage-root-missing", "The pinned host storage root is missing.") };
    }
    return {
      ok: false,
      problem: reason("storage-root-unavailable", "The host storage root could not be resolved."),
    };
  }
  if (resolved !== root) {
    return {
      ok: false,
      problem: reason(
        "storage-root-alias",
        "The host storage root is an alias or symlink; its configured canonical identity is required.",
      ),
    };
  }
  let info: NativeFileStats;
  try {
    info = await io.lstat(root, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { ok: false, problem: reason("storage-root-missing", "The pinned host storage root is missing.") };
    }
    return {
      ok: false,
      problem: reason("storage-root-unavailable", "The host storage root could not be inspected."),
    };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    return {
      ok: false,
      problem: reason("storage-root-unsafe", "The host storage root is not a regular directory."),
    };
  }
  return {
    ok: true,
    pin: {
      path: root,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      ctimeNs: info.ctimeNs,
    },
  };
}

async function rootIdentityStillCurrent(io: NativeFileIo, pin: RootPin): Promise<boolean> {
  try {
    const resolved = await io.realpath(pin.path);
    if (resolved !== pin.path) return false;
    const info = await io.lstat(pin.path, { bigint: true });
    return !info.isSymbolicLink() && info.isDirectory() && sameDirectoryIdentity(pin, info);
  } catch {
    return false;
  }
}

/**
 * The pinned root is resolved again inside captureWorkspaceText. Bind that
 * second resolution to the pinned path and identity so a root replaced by a
 * symlink or a different directory cannot redirect a read outside the
 * configured storage root before a post-read check notices.
 */
function bindPinnedRoot(io: NativeFileIo, pin: RootPin): NativeFileIo {
  const rootReplaced = (): NativeFileError =>
    new NativeFileError("The pinned storage root changed before this read.", "changed");
  return {
    O_RDONLY: io.O_RDONLY,
    O_NOFOLLOW: io.O_NOFOLLOW,
    realpath: async (target) => {
      const resolved = await io.realpath(target);
      if (path.normalize(target) === pin.path && resolved !== pin.path) throw rootReplaced();
      return resolved;
    },
    lstat: async (target, options) => {
      const info = await io.lstat(target, options);
      if (path.normalize(target) === pin.path) {
        if (info.isSymbolicLink() || !info.isDirectory() || !sameDirectoryIdentity(pin, info)) {
          throw rootReplaced();
        }
      }
      return info;
    },
    open: (target, flags) => io.open(target, flags),
  };
}

class QueryBudget {
  private charged = 0;
  private observed = 0;
  private failed = 0;
  private exhausted = false;

  constructor(private readonly limit: number) {}

  /** Reserve the file-profile worst case before the read can grow. */
  reserve(bytes: number): boolean {
    if (this.charged + bytes > this.limit) {
      this.exhausted = true;
      return false;
    }
    this.charged += bytes;
    return true;
  }

  /**
   * Refund only the unused part of a successful reservation. A failed or
   * unknown read keeps the whole reservation charged and is counted as failed,
   * so a later partial/change cannot be presented as zero bytes read.
   */
  settle(reserved: number, actual: number | null): void {
    if (actual === null || actual < 0 || actual > reserved) {
      this.failed += 1;
      return;
    }
    this.charged -= reserved - actual;
    this.observed += actual;
  }

  /** Release a reservation made for a read that was never started. */
  release(reserved: number): void {
    this.charged -= reserved;
    if (this.charged < 0) this.charged = 0;
  }

  snapshot(): NativeHarnessHistoryReadBudget {
    return {
      limitBytes: this.limit,
      chargedBytes: this.charged,
      observedBytes: this.observed,
      failedReads: this.failed,
      outcome: this.exhausted ? "exhausted" : this.failed > 0 ? "unknown-usage" : "within-budget",
    };
  }
}

function fileErrorCode(error: unknown): NativeFileError["code"] | "unknown" {
  return error instanceof NativeFileError ? error.code : "unknown";
}

const RUN_ERROR_DETAILS: Record<NativeFileError["code"], string> = {
  "invalid-path": "The locator-derived run path is not a valid relative path.",
  missing: "The primary run record is missing; no backup was read.",
  "unsafe-path": "The run path traverses a link or non-directory, or escapes the pinned storage root.",
  changed: "The run record changed while it was being observed; this is uncertainty, not tampering evidence.",
  "non-text": "The run record is not valid UTF-8 text.",
  "too-large": `The run record exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.runBytes}-byte readonly history profile; this is profile-unavailable, not established corruption.`,
};

const EVENTS_ERROR_DETAILS: Record<NativeFileError["code"], string> = {
  "invalid-path": "The locator-derived events path is not a valid relative path.",
  missing: "The events log is missing; it is unavailable, not an empty complete history.",
  "unsafe-path": "The events path traverses a link or non-directory, or escapes the pinned storage root.",
  changed: "The events log changed while it was being observed; this is uncertainty, not tampering evidence.",
  "non-text": "The events log is not valid UTF-8 text.",
  "too-large": `The events log exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes}-byte readonly history profile; this is profile-unavailable, not established corruption.`,
};

function runProblem(error: unknown): NativeHarnessHistoryReason {
  const code = fileErrorCode(error);
  if (code === "unknown") return reason("run-unavailable", "The run record could not be observed.");
  if (code === "too-large") {
    return reason("run-profile-unavailable", RUN_ERROR_DETAILS[code]);
  }
  return reason(`run-${code}`, RUN_ERROR_DETAILS[code]);
}

function eventsProblem(error: unknown): NativeHarnessHistoryReason {
  const code = fileErrorCode(error);
  if (code === "unknown") return reason("events-unavailable", "The events log could not be observed.");
  if (code === "too-large") {
    return reason("events-profile-unavailable", EVENTS_ERROR_DETAILS[code]);
  }
  return reason(`events-${code}`, EVENTS_ERROR_DETAILS[code]);
}

function ownerReadFailure(
  target: NativeHarnessHistoryProcessTarget,
  error: unknown,
): NativeHarnessHistoryProcessOwnerRead {
  const code = fileErrorCode(error);
  switch (code) {
    case "missing":
      return {
        targetId: target.targetId,
        state: "missing",
        bytes: null,
        sha256: null,
        observedAt: null,
        problem: reason(
          "owner-missing",
          "The owner/lock file is missing; this is one possible cleanup, pre-write or crash outcome, not a stopped proof.",
        ),
        declaration: null,
      };
    case "non-text":
    case "too-large":
      return {
        targetId: target.targetId,
        state: "invalid",
        bytes: null,
        sha256: null,
        observedAt: null,
        problem: code === "too-large"
          ? reason("owner-oversize", "The owner file exceeds the readonly owner-read profile; it was not trusted.")
          : reason("owner-non-text", "The owner file is not valid UTF-8 text; it was not trusted."),
        declaration: null,
      };
    case "unsafe-path":
    case "changed":
      return {
        targetId: target.targetId,
        state: "unavailable",
        bytes: null,
        sha256: null,
        observedAt: null,
        problem: code === "unsafe-path"
          ? reason("owner-unsafe-path", "The owner path traverses a link or escapes the pinned root; it was not read.")
          : reason("owner-changed", "The owner file changed while it was being observed; its bytes are uncertain."),
        declaration: null,
      };
    case "invalid-path":
      return {
        targetId: target.targetId,
        state: "invalid",
        bytes: null,
        sha256: null,
        observedAt: null,
        problem: reason("owner-invalid-path", "The derived owner path is not a valid workspace-relative path."),
        declaration: null,
      };
    default:
      return {
        targetId: target.targetId,
        state: "unavailable",
        bytes: null,
        sha256: null,
        observedAt: null,
        problem: reason("owner-unavailable", "The owner file could not be observed."),
        declaration: null,
      };
  }
}

function artifactStatus(error: unknown): NativeHarnessHistoryArtifactStatus {
  switch (fileErrorCode(error)) {
    case "missing": return "missing";
    case "non-text": return "non-text";
    case "too-large": return "oversize";
    case "unsafe-path": return "unsafe-path";
    case "changed": return "changed";
    case "invalid-path": return "invalid-path";
    default: return "unavailable";
  }
}

function artifactProblem(status: NativeHarnessHistoryArtifactStatus): NativeHarnessHistoryReason {
  switch (status) {
    case "missing":
      return reason("artifact-missing", "A declared artifact file is missing.");
    case "non-text":
      return reason("artifact-non-text", "A declared artifact file is not valid UTF-8 text.");
    case "oversize":
      return reason(
        "artifact-oversize",
        `A declared artifact file exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes}-byte history profile.`,
      );
    case "unsafe-path":
      return reason(
        "artifact-unsafe-path",
        "A declared artifact path traverses a link or non-directory, or escapes the winner workspace.",
      );
    case "changed":
      return reason(
        "artifact-changed",
        "A declared artifact file changed while it was being observed; this is uncertainty.",
      );
    case "invalid-path":
      return reason("artifact-invalid-path", "A declared artifact path is not valid for the winner workspace.");
    case "artifact-budget-exhausted":
      return reason(
        "artifact-budget-exhausted",
        `The ${NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes}-byte artifact-read reservation allowance was reached before this read.`,
      );
    case "query-budget-exhausted":
      return reason(
        "query-budget-exhausted",
        `The ${NATIVE_HARNESS_HISTORY_LIMITS.queryBytes}-byte whole-query budget was reached before this read.`,
      );
    case "unavailable":
      return reason("artifact-unavailable", "A declared artifact file could not be observed.");
    default:
      return reason("artifact-mismatch", "A declared artifact's observed bytes or digest differ from its declaration.");
  }
}

interface ValidatedArtifact {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly declaredAt: string | null;
  readonly declaredByEntryId: string | null;
}

type ArtifactDeclaration =
  | { readonly state: "absent"; readonly items: readonly []; readonly totalBytes: 0; readonly problem: NativeHarnessHistoryReason }
  | { readonly state: "empty"; readonly items: readonly []; readonly totalBytes: 0; readonly problem: NativeHarnessHistoryReason }
  | { readonly state: "invalid"; readonly items: readonly []; readonly totalBytes: number; readonly problem: NativeHarnessHistoryReason }
  | { readonly state: "present"; readonly items: readonly ValidatedArtifact[]; readonly totalBytes: number; readonly problem: null };

function invalidArtifactDeclaration(code: string, detail: string, totalBytes = 0): ArtifactDeclaration {
  return { state: "invalid", items: [], totalBytes, problem: reason(code, detail) };
}

function validateDeclaredArtifacts(
  value: readonly NativeHarnessHistoryDeclaredArtifact[] | null | undefined,
): ArtifactDeclaration {
  if (value === undefined || value === null) {
    return {
      state: "absent",
      items: [],
      totalBytes: 0,
      problem: reason(
        "artifact-manifest-absent",
        "No declared artifact manifest was supplied; artifact coverage is unavailable, not complete.",
      ),
    };
  }
  if (!Array.isArray(value)) {
    return invalidArtifactDeclaration("artifact-manifest-invalid", "The declared artifact manifest is not an array.");
  }
  if (value.length === 0) {
    return {
      state: "empty",
      items: [],
      totalBytes: 0,
      problem: reason(
        "artifact-manifest-empty",
        "The declared artifact manifest is empty; artifact coverage is unavailable, not complete.",
      ),
    };
  }
  if (value.length > NATIVE_HARNESS_HISTORY_LIMITS.maxDeclaredArtifacts) {
    return invalidArtifactDeclaration(
      "artifact-declaration-limit",
      `More than ${NATIVE_HARNESS_HISTORY_LIMITS.maxDeclaredArtifacts} artifact paths were declared.`,
    );
  }
  const items: ValidatedArtifact[] = [];
  let totalBytes = 0;
  for (const raw of value) {
    if (!plainObject(raw) || !exactKeys(
      raw,
      ["relativePath", "bytes", "sha256"],
      ["declaredAt", "declaredByEntryId"],
    )) {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid",
        "A declared artifact fact has missing or unknown fields.",
        totalBytes,
      );
    }
    let relativePath: string;
    try {
      relativePath = validateRelativePath(raw.relativePath);
    } catch {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid-path",
        "A declared artifact path is not an unambiguous relative POSIX path.",
        totalBytes,
      );
    }
    if (!Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0) {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid",
        "A declared artifact byte count is not a non-negative safe integer.",
        totalBytes,
      );
    }
    if ((raw.bytes as number) > NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes) {
      return invalidArtifactDeclaration(
        "artifact-declaration-oversize",
        `A declared artifact exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes}-byte profile.`,
        totalBytes,
      );
    }
    if (typeof raw.sha256 !== "string" || !SHA256_PATTERN.test(raw.sha256)) {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid",
        "A declared artifact fingerprint is not a lowercase SHA-256 value.",
        totalBytes,
      );
    }
    const declaredAt = raw.declaredAt ?? null;
    if (declaredAt !== null && (typeof declaredAt !== "string"
      || declaredAt.length > MAX_COPIED_TIMESTAMP_CHARS
      || !Number.isFinite(Date.parse(declaredAt)))) {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid",
        "A declared artifact timestamp is not an ISO time.",
        totalBytes,
      );
    }
    const declaredByEntryId = raw.declaredByEntryId ?? null;
    if (declaredByEntryId !== null && !boundedLabel(declaredByEntryId)) {
      return invalidArtifactDeclaration(
        "artifact-declaration-invalid",
        "A declared artifact entry ID is not bounded text.",
        totalBytes,
      );
    }
    totalBytes += raw.bytes as number;
    if (totalBytes > NATIVE_HARNESS_HISTORY_LIMITS.artifactTotalBytes) {
      return invalidArtifactDeclaration(
        "artifact-declaration-total",
        `Declared artifacts exceed the ${NATIVE_HARNESS_HISTORY_LIMITS.artifactTotalBytes}-byte total profile.`,
        totalBytes,
      );
    }
    items.push({
      relativePath,
      bytes: raw.bytes as number,
      sha256: raw.sha256,
      declaredAt,
      declaredByEntryId,
    });
  }
  return { state: "present", items, totalBytes, problem: null };
}

function comparison(
  declared: string | null,
  recorded: string | null,
): NativeHarnessHistoryLabelComparison {
  const result: NativeHarnessHistoryComparisonResult = declared === null || recorded === null
    ? "unavailable"
    : declared === recorded
      ? "match"
      : "mismatch";
  return { declared, recorded, result, basis: "label-only" };
}

function buildOriginCompatibility(
  locator: NativeHarnessHistoryLocator,
  record: RunRecord | null,
  storageRoot: string | null,
): NativeHarnessHistoryOriginCompatibility {
  const runId = comparison(locator.runId, record?.id ?? null);
  // locator.workspacePath is the original main workspace label. The run record
  // stores the private copied harness workspace instead, so the two are not
  // comparable labels. Original-main compatibility stays unavailable until R1b
  // supplies independent actual-session evidence.
  const workspace: NativeHarnessHistoryLabelComparison = {
    declared: locator.workspacePath,
    recorded: null,
    result: "unavailable",
    basis: "label-only",
  };
  let workspaceLayout: NativeHarnessHistoryComparisonResult = "unavailable";
  if (record !== null && storageRoot !== null) {
    const harnessDirectory = locator.storeRelativePath.split("/")[0];
    const expectedWorkspace = harnessDirectory === undefined
      ? null
      : path.join(storageRoot, harnessDirectory, "workspace");
    workspaceLayout = expectedWorkspace !== null && record.workspace === expectedWorkspace
      ? "match"
      : "mismatch";
  }
  return {
    basis: "declared-labels-versus-recorded-labels-only",
    runId,
    workspace,
    workspaceLayout,
    definitionVersion: comparison(locator.definitionVersion, null),
    backendSourceId: comparison(locator.backendSourceId, null),
    configurationSha256: comparison(locator.configurationSha256, null),
    inputManifestSha256: comparison(locator.inputManifestSha256, null),
    currentAdoption: false,
    limitations: [
      "The locator workspacePath is the original main workspace label, not the run's private copied harness workspace.",
      "Original-main compatibility is unavailable without independent actual-session evidence from R1b.",
      "The actual run workspace layout is checked separately against the selected prepared path.",
      "These are historical label comparisons, not runtime source, definition or configuration verification.",
      "A label match does not restore execution authority or prove current adoption.",
    ],
  };
}

const MAX_COPIED_TIMESTAMP_CHARS = 64;

/**
 * The vendor validator only guarantees createdAt/updatedAt/stage.startedAt are
 * parseable strings, and it does not validate stage.endedAt at all. Copy only a
 * bounded valid timestamp; any other value (including an object) is withheld.
 */
function copiedTimestamp(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_COPIED_TIMESTAMP_CHARS
    && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function recordMetadataProblems(record: RunRecord): NativeHarnessHistoryReason[] {
  const problems: NativeHarnessHistoryReason[] = [];
  if (copiedTimestamp(record.createdAt) === null || copiedTimestamp(record.updatedAt) === null) {
    problems.push(reason(
      "record-timestamp-withheld",
      "A record timestamp is not a bounded valid timestamp string; it was withheld.",
    ));
  }
  for (const stage of Object.values(record.stages)) {
    if (stage === undefined) continue;
    if (copiedTimestamp(stage.startedAt) === null) {
      problems.push(reason(
        "stage-started-at-withheld",
        "A recorded stage startedAt is not a bounded valid timestamp string; it was withheld.",
      ));
    }
    if (stage.endedAt !== undefined && copiedTimestamp(stage.endedAt) === null) {
      problems.push(reason(
        "stage-ended-at-withheld",
        "A recorded stage endedAt is not a bounded valid timestamp string; it was withheld.",
      ));
    }
  }
  return problems;
}

function buildStageProjection(record: RunRecord | null): readonly NativeHarnessHistoryStageProjection[] {
  if (record === null) return [];
  const stages: NativeHarnessHistoryStageProjection[] = [];
  for (const [id, stage] of Object.entries(record.stages)) {
    if (stage === undefined) continue;
    stages.push({
      id,
      status: stage.status,
      attempt: stage.attempt,
      startedAt: copiedTimestamp(stage.startedAt),
      endedAt: copiedTimestamp(stage.endedAt),
      resultKnown: stage.result !== undefined,
      validationFailures: stage.validationFailures ?? null,
    });
  }
  return stages.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function costFact(value: number | undefined): NativeHarnessHistoryCostFact {
  return value === undefined
    ? { usd: null, source: "unknown" }
    : { usd: value, source: "recorded-stage" };
}

function buildAccounting(record: RunRecord | null): NativeHarnessHistoryAccounting {
  const stages: NativeHarnessHistoryStageAccounting[] = [];
  if (record !== null) {
    for (const [id, stage] of Object.entries(record.stages)) {
      if (stage === undefined) continue;
      stages.push({
        stage: id,
        observed: costFact(stage.observedCostUsd),
        reserved: costFact(stage.reservedCostUsd),
        accounted: costFact(stage.accountedCostUsd),
        resultKnown: stage.result !== undefined,
        usageEstimated: stage.result?.usageEstimated ?? null,
      });
    }
    stages.sort((left, right) => (left.stage < right.stage ? -1 : left.stage > right.stage ? 1 : 0));
  }
  return {
    basis: "recorded-stage-fields-only",
    costTotal: { usd: null, source: "unknown" },
    outerLifetime: "unknown",
    originalDeadline: "unknown",
    stages,
    limitations: [
      "Missing stage cost fields stay null/unknown; no vendor fallback or zero is applied.",
      "No cost total is computed because the historical accounting basis is incomplete.",
      "The original outer lifetime and deadline are unavailable and are not rebuilt from run config.",
    ],
  };
}

function processObservation(): NativeHarnessHistoryProcessObservation {
  return uninspectedProcessObservation();
}

function eligibility(): NativeHarnessHistoryEligibility {
  return {
    readOnly: true,
    authorityRestored: false,
    resumeAvailable: false,
    liveAttach: "unsupported",
    recoverableFormat: false,
    missingForResume: [
      "R2 pre-effect provenance and durable budget/deadline association",
      "verified coverage that every original controller and worker stopped",
      "a current explicit user resume intent",
      "a durable accounting owner for unknown allocations",
    ],
    limitations: [
      "This inspection cannot resume, cancel, apply, accept or attach to a run.",
      "The R1a locator is factual history, not signed provenance or an execution capability.",
      "Mandatory R2 and R3 remain open.",
    ],
  };
}

function unavailableEvents(problem: NativeHarnessHistoryReason): NativeHarnessHistoryEventsProjection {
  return { state: "unavailable", rows: null, file: null, problem };
}

function unavailableRecorded(
  runId: string | null,
  problem: NativeHarnessHistoryReason,
): NativeHarnessHistoryRecorded {
  return {
    state: "unavailable",
    runId,
    format: "harness2-run-json-v1-or-v2",
    status: null,
    revision: null,
    createdAt: null,
    updatedAt: null,
    statusBasis: "recorded-run-json-only",
    stages: [],
    runFile: null,
    events: unavailableEvents(problem),
    observationsAtomicity: "sequential-not-atomic",
    limitations: [
      "No run record was observed, so no recorded status, timestamps or stages are asserted.",
      "Task text, config/auth, worker text and raw event messages are intentionally not returned.",
    ],
  };
}

function buildRecorded(
  record: RunRecord | null,
  runFile: NativeHarnessHistoryFileObservation | null,
  events: NativeHarnessHistoryEventsProjection,
): NativeHarnessHistoryRecorded {
  if (record === null) {
    return unavailableRecorded(
      null,
      reason("primary-unavailable", "The primary run record is unavailable."),
    );
  }
  return {
    state: "observed",
    runId: record.id,
    format: "harness2-run-json-v1-or-v2",
    status: record.status,
    revision: record.revision,
    createdAt: copiedTimestamp(record.createdAt),
    updatedAt: copiedTimestamp(record.updatedAt),
    statusBasis: "recorded-run-json-only",
    stages: buildStageProjection(record),
    runFile,
    events,
    observationsAtomicity: "sequential-not-atomic",
    limitations: [
      "The status is the recorded run.json value; no current process state is inferred from it.",
      "Run.json and events.jsonl are separate sequential observations, not an atomic snapshot.",
      "Record and stage timestamps are copied only when they are bounded valid timestamp strings; other values are withheld.",
      "Task text, config/auth, worker text and raw event messages are intentionally not returned.",
    ],
  };
}

function unavailableArtifacts(
  manifest: NativeHarnessHistoryArtifactIntegrity["manifest"],
  declaredCount: number,
  problem: NativeHarnessHistoryReason,
  winner: string | null = null,
): NativeHarnessHistoryArtifactIntegrity {
  return {
    state: "unavailable",
    coverage: "unavailable",
    manifest,
    complete: false,
    mode: "not-checked",
    tree: "not-checked",
    traces: "not-checked",
    provenance: "not-restored",
    declaredCount,
    observedCount: 0,
    matchedCount: 0,
    totalDeclaredBytes: 0,
    totalObservedBytes: 0,
    winner,
    results: [],
    problem,
    limitations: [
      "Only explicitly declared files can be checked; full-tree coverage is unavailable.",
      "File mode, traces and execution provenance are not checked or restored.",
      "A declared-file byte/hash match does not create an A3 capture, check or receipt.",
    ],
  };
}

function artifactResult(
  item: ValidatedArtifact,
  snapshot: NativeWorkspaceTextSnapshot | null,
  status: NativeHarnessHistoryArtifactStatus,
  problem: NativeHarnessHistoryReason | null,
): NativeHarnessHistoryArtifactResult {
  const observedBytes = snapshot === null ? null : snapshot.file.bytes;
  const observedSha256 = snapshot === null ? null : snapshot.file.sha256;
  const bytesMatch = observedBytes === null ? null : observedBytes === item.bytes;
  const hashMatch = observedSha256 === null ? null : observedSha256 === item.sha256;
  return {
    relativePath: item.relativePath,
    declaredBytes: item.bytes,
    declaredSha256: item.sha256,
    declaredAt: item.declaredAt,
    declaredByEntryId: item.declaredByEntryId,
    observedBytes,
    observedSha256,
    observedAt: snapshot === null ? null : snapshot.file.observedAt,
    bytesMatch,
    hashMatch,
    status,
    problem,
  };
}

function buildArtifactIntegrity(
  declaration: ArtifactDeclaration,
  winner: string | null,
  results: readonly NativeHarnessHistoryArtifactResult[],
  problem: NativeHarnessHistoryReason | null,
  completed: boolean,
): NativeHarnessHistoryArtifactIntegrity {
  const observed = results.filter((entry) => entry.observedBytes !== null);
  const matched = results.filter((entry) => entry.status === "match");
  const totalObservedBytes = observed.reduce((sum, entry) => sum + (entry.observedBytes ?? 0), 0);
  const complete = completed
    && declaration.state === "present"
    && results.length === declaration.items.length
    && results.length > 0;
  const state: NativeHarnessHistoryArtifactIntegrity["state"] = complete && matched.length === results.length
    ? "declared-files-matched"
    : observed.length > 0
      ? "partial"
      : "unavailable";
  return {
    state,
    coverage: results.length > 0 ? "declared-files-only" : "unavailable",
    manifest: declaration.state === "present"
      ? "present"
      : declaration.state,
    complete,
    mode: "not-checked",
    tree: "not-checked",
    traces: "not-checked",
    provenance: "not-restored",
    declaredCount: declaration.state === "present" ? declaration.items.length : 0,
    observedCount: observed.length,
    matchedCount: matched.length,
    totalDeclaredBytes: declaration.totalBytes,
    totalObservedBytes,
    winner,
    results,
    problem,
    limitations: [
      "Only explicitly declared files can be checked; full-tree coverage is unavailable.",
      "File mode, traces and execution provenance are not checked or restored.",
      "A declared-file byte/hash match does not create an A3 capture, check or receipt.",
    ],
  };
}

type WinnerWorkspace =
  | { readonly ok: true; readonly winner: string; readonly relativePrefix: string }
  | { readonly ok: false; readonly problem: NativeHarnessHistoryReason };

function winnerWorkspace(
  record: RunRecord,
  locator: NativeHarnessHistoryLocator,
  storageRoot: string,
): WinnerWorkspace {
  const winner = record.winner;
  if (winner === undefined) {
    return {
      ok: false,
      problem: reason("winner-unavailable", "The run record has no winner, so artifact reads are unavailable."),
    };
  }
  const stage = record.stages[winner];
  if (stage === undefined) {
    return {
      ok: false,
      problem: reason("winner-unavailable", "The recorded winner stage is missing, so artifact reads are unavailable."),
    };
  }
  if (stage.id !== winner || stage.status !== "completed" || !Number.isSafeInteger(stage.attempt) || stage.attempt < 1) {
    return {
      ok: false,
      problem: reason(
        "winner-inconsistent",
        "The recorded winner stage ID, completion or attempt is inconsistent, so artifact reads are unavailable.",
      ),
    };
  }
  if (!isCanonicalAbsolutePath(stage.cwd)) {
    return {
      ok: false,
      problem: reason(
        "winner-workspace-invalid",
        "The recorded winner workspace is not an absolute normalized path, so artifact reads are unavailable.",
      ),
    };
  }
  const relativeCwd = path.relative(storageRoot, stage.cwd);
  if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd) || relativeCwd === "") {
    return {
      ok: false,
      problem: reason(
        "winner-workspace-invalid",
        "The recorded winner workspace is outside the pinned storage root, so artifact reads are unavailable.",
      ),
    };
  }
  const segments = relativeCwd.split(path.sep);
  const expectedAttemptPrefix = `attempt-${stage.attempt}-`;
  const attemptDirectory = segments[6];
  const storeSegments = locator.storeRelativePath.split("/");
  const shapeMatches = segments.length === 8
    && segments[0] === storeSegments[0]
    && segments[1] === "store"
    && segments[2] === "runs"
    && segments[3] === locator.runId
    && segments[4] === "stages"
    && segments[5] === winner
    && attemptDirectory !== undefined
    && attemptDirectory.startsWith(expectedAttemptPrefix)
    && UUID_PATTERN.test(attemptDirectory.slice(expectedAttemptPrefix.length))
    && segments[7] === "workspace";
  if (!shapeMatches) {
    return {
      ok: false,
      problem: reason(
        "winner-workspace-invalid",
        "The recorded winner workspace does not have the exact run/stage/attempt shape, so artifact reads are unavailable.",
      ),
    };
  }
  return {
    ok: true,
    winner,
    relativePrefix: segments.join("/"),
  };
}

interface InspectionParts {
  readonly state: NativeHarnessHistoryState;
  readonly query: Omit<NativeHarnessHistoryQuery, "completedAt">;
  readonly recorded: NativeHarnessHistoryRecorded;
  readonly originCompatibility: NativeHarnessHistoryOriginCompatibility;
  readonly artifactIntegrity: NativeHarnessHistoryArtifactIntegrity;
  readonly accounting: NativeHarnessHistoryAccounting;
  readonly reasons: readonly NativeHarnessHistoryReason[];
  /** Absent preserves the exact uninspected projection. */
  readonly processObservation?: NativeHarnessHistoryProcessObservation;
}

function minimalReasons(value: NativeHarnessHistoryReason): readonly NativeHarnessHistoryReason[] {
  return [reason(value.code, value.detail)];
}

function minimalOriginCompatibility(): NativeHarnessHistoryOriginCompatibility {
  const unavailable = (): NativeHarnessHistoryLabelComparison => ({
    declared: null,
    recorded: null,
    result: "unavailable",
    basis: "label-only",
  });
  return {
    basis: "declared-labels-versus-recorded-labels-only",
    runId: unavailable(),
    workspace: unavailable(),
    workspaceLayout: "unavailable",
    definitionVersion: unavailable(),
    backendSourceId: unavailable(),
    configurationSha256: unavailable(),
    inputManifestSha256: unavailable(),
    currentAdoption: false,
    limitations: ["The projection was replaced by a minimal unavailable summary."],
  };
}

function emptyAccounting(): NativeHarnessHistoryAccounting {
  return {
    basis: "recorded-stage-fields-only",
    costTotal: { usd: null, source: "unknown" },
    outerLifetime: "unknown",
    originalDeadline: "unknown",
    stages: [],
    limitations: ["No recorded accounting is represented in this minimal summary."],
  };
}

function fallbackInspection(candidate: NativeHarnessHistoryInspection): NativeHarnessHistoryInspection {
  const problem = reason(
    "projection-oversized",
    `The result exceeded the ${NATIVE_HARNESS_HISTORY_LIMITS.resultBytes}-byte canonical projection profile.`,
  );
  return {
    schema: NATIVE_HARNESS_HISTORY_PROJECTION_SCHEMA,
    version: 1,
    state: "unavailable",
    query: candidate.query,
    recorded: unavailableRecorded(candidate.query.runId, problem),
    // Do not retain candidate origin labels: a previous projection may have
    // copied a vendor-validated but unbounded recorded label.
    originCompatibility: minimalOriginCompatibility(),
    processObservation: processObservation(),
    artifactIntegrity: unavailableArtifacts(
      "invalid",
      candidate.artifactIntegrity.declaredCount,
      problem,
      candidate.artifactIntegrity.winner,
    ),
    accounting: emptyAccounting(),
    eligibility: eligibility(),
    reasons: minimalReasons(problem),
  };
}

function tinyInspection(query: NativeHarnessHistoryQuery): NativeHarnessHistoryInspection {
  const problem = reason(
    "projection-oversized",
    `The final projection cannot be represented within the ${NATIVE_HARNESS_HISTORY_LIMITS.resultBytes}-byte profile.`,
  );
  return {
    schema: NATIVE_HARNESS_HISTORY_PROJECTION_SCHEMA,
    version: 1,
    state: "unavailable",
    query: {
      ...query,
      storeRelativePath: null,
      storageRoot: null,
      observedBytes: 0,
      readBudget: {
        limitBytes: NATIVE_HARNESS_HISTORY_LIMITS.queryBytes,
        chargedBytes: 0,
        observedBytes: 0,
        failedReads: 0,
        outcome: "within-budget",
      },
      artifactReadBudget: {
        limitBytes: NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes,
        chargedBytes: 0,
        observedBytes: 0,
        failedReads: 0,
        outcome: "within-budget",
      },
    },
    recorded: unavailableRecorded(query.runId, problem),
    originCompatibility: minimalOriginCompatibility(),
    processObservation: processObservation(),
    artifactIntegrity: unavailableArtifacts("invalid", 0, problem),
    accounting: emptyAccounting(),
    eligibility: eligibility(),
    reasons: minimalReasons(problem),
  };
}

function finalizeInspection(
  parts: InspectionParts,
  completedAt: number,
): NativeHarnessHistoryInspection {
  const candidate: NativeHarnessHistoryInspection = {
    schema: NATIVE_HARNESS_HISTORY_PROJECTION_SCHEMA,
    version: 1,
    state: parts.state,
    query: { ...parts.query, completedAt },
    recorded: parts.recorded,
    originCompatibility: parts.originCompatibility,
    processObservation: parts.processObservation ?? processObservation(),
    artifactIntegrity: parts.artifactIntegrity,
    accounting: parts.accounting,
    eligibility: eligibility(),
    reasons: parts.reasons,
  };
  const fingerprint = fingerprintNativeJson(candidate);
  if (fingerprint.ok && fingerprint.bytes <= NATIVE_HARNESS_HISTORY_LIMITS.resultBytes) {
    return deepFreeze(candidate);
  }
  const fallback = fallbackInspection(candidate);
  const fallbackFingerprint = fingerprintNativeJson(fallback);
  if (fallbackFingerprint.ok && fallbackFingerprint.bytes <= NATIVE_HARNESS_HISTORY_LIMITS.resultBytes) {
    return deepFreeze(fallback);
  }
  return deepFreeze(tinyInspection(candidate.query));
}

function signalProblem(signal: unknown): NativeHarnessHistoryReason | null {
  const read = readActualAbortSignal(signal);
  if (!read.ok) {
    return reason("abort-signal-unavailable", "The actual host AbortSignal is missing or unreadable.");
  }
  if (read.aborted) {
    return reason("query-aborted", "The host AbortSignal was aborted; no further history I/O was started.");
  }
  return null;
}

/**
 * Stateless, host-only readonly query of one decoded locator.
 *
 * The storage root is pinned independently of `captureWorkspaceText`'s
 * symlink-accepting root resolution, then rechecked after every sequential
 * observation. All content reads use `captureWorkspaceText(storageRoot,
 * locatorDerivedRelativePath, io)`, so no mutable recorded cwd, stage cwd,
 * snapshot path or locator runDir is ever used as a new root.
 */
export async function inspectNativeHarnessHistory(
  request: NativeHarnessHistoryInspectRequest,
): Promise<NativeHarnessHistoryInspection> {
  const startedAt = readClock(request.now);
  const reasons: NativeHarnessHistoryReason[] = [];
  const query: {
    runId: string | null;
    storeRelativePath: string | null;
    storageRoot: string | null;
    startedAt: number;
    observedBytes: number;
    rootState: NativeHarnessHistoryQuery["rootState"];
    declaration: NativeHarnessHistoryQuery["declaration"];
  } = {
    runId: null,
    storeRelativePath: null,
    storageRoot: null,
    startedAt,
    observedBytes: 0,
    rootState: "invalid",
    declaration: "recorded-history-only",
  };
  const readBudget = new QueryBudget(NATIVE_HARNESS_HISTORY_LIMITS.queryBytes);
  const artifactReadBudget = new QueryBudget(NATIVE_HARNESS_HISTORY_LIMITS.artifactReadBytes);
  const finish = (parts: Omit<InspectionParts, "query">): NativeHarnessHistoryInspection =>
    finalizeInspection({
      ...parts,
      query: {
        ...query,
        readBudget: readBudget.snapshot(),
        artifactReadBudget: artifactReadBudget.snapshot(),
      },
    }, readClock(request.now));

  if (!isNativeHarnessHistoryLocator(request.locator)) {
    const problem = reason(
      "locator-not-decoded",
      "The locator was not issued by the bounded version-1 decoder.",
    );
    addReason(reasons, problem);
    return finish({
      state: "unavailable",
      recorded: unavailableRecorded(null, problem),
      originCompatibility: buildOriginCompatibility(
        {
          schema: NATIVE_HARNESS_HISTORY_LOCATOR_SCHEMA,
          version: 1,
          originSessionId: "unverified",
          workspacePath: "/unverified",
          source: { toolCallId: null, observationId: null, generation: null },
          runId: "unverified",
          storeRelativePath: "omp-harness-000000/store/runs/unverified",
          inputManifestSha256: null,
          definitionVersion: null,
          backendSourceId: null,
          configurationSha256: null,
          evidence: null,
        },
        null,
        null,
      ),
      artifactIntegrity: unavailableArtifacts("absent", 0, problem),
      accounting: buildAccounting(null),
      reasons,
    });
  }

  const locator = request.locator;
  query.runId = locator.runId;
  query.storeRelativePath = locator.storeRelativePath;

  const io = withNonBlocking(request.fileIo ?? nodeFileIo);
  const signalProblemBefore = signalProblem(request.signal);
  if (signalProblemBefore !== null) {
    addReason(reasons, signalProblemBefore);
    const state = signalProblemBefore.code === "query-aborted" ? "aborted" : "unavailable";
    return finish({
      state,
      recorded: unavailableRecorded(locator.runId, signalProblemBefore),
      originCompatibility: buildOriginCompatibility(locator, null, null),
      artifactIntegrity: unavailableArtifacts("absent", 0, signalProblemBefore),
      accounting: buildAccounting(null),
      reasons,
    });
  }

  const rootResult = await pinStorageRoot(request.storageRoot, io);
  if (!rootResult.ok) {
    addReason(reasons, rootResult.problem);
    return finish({
      state: "unavailable",
      recorded: unavailableRecorded(locator.runId, rootResult.problem),
      originCompatibility: buildOriginCompatibility(locator, null, null),
      artifactIntegrity: unavailableArtifacts("absent", 0, rootResult.problem),
      accounting: buildAccounting(null),
      reasons,
    });
  }
  const pin = rootResult.pin;
  const scopedIo = bindPinnedRoot(io, pin);
  query.rootState = "pinned";
  query.storageRoot = pin.path;

  const signalProblemAfterPin = signalProblem(request.signal);
  if (signalProblemAfterPin !== null) {
    addReason(reasons, signalProblemAfterPin);
    return finish({
      state: signalProblemAfterPin.code === "query-aborted" ? "aborted" : "unavailable",
      recorded: unavailableRecorded(locator.runId, signalProblemAfterPin),
      originCompatibility: buildOriginCompatibility(locator, null, pin.path),
      artifactIntegrity: unavailableArtifacts("absent", 0, signalProblemAfterPin),
      accounting: buildAccounting(null),
      reasons,
    });
  }

  let observedBytes = 0;
  const observationNow = (): number => readClock(request.now);
  let rootChanged = false;

  const runRelativePath = `${locator.storeRelativePath}/run.json`;
  const eventsRelativePath = `${locator.storeRelativePath}/events.jsonl`;
  let runSnapshot: NativeWorkspaceTextSnapshot | null = null;
  let runFile: NativeHarnessHistoryFileObservation | null = null;
  let runFailure: NativeHarnessHistoryReason | null = null;

  if (!readBudget.reserve(NATIVE_HARNESS_HISTORY_LIMITS.runBytes)) {
    runFailure = reason(
      "query-budget-exhausted",
      `The ${NATIVE_HARNESS_HISTORY_LIMITS.queryBytes}-byte whole-query budget was reached before the run read.`,
    );
  } else {
    try {
      runSnapshot = await captureWorkspaceText(pin.path, runRelativePath, scopedIo, observationNow());
      readBudget.settle(NATIVE_HARNESS_HISTORY_LIMITS.runBytes, runSnapshot.file.bytes);
      observedBytes += runSnapshot.file.bytes;
      runFile = {
        relativePath: runRelativePath,
        bytes: runSnapshot.file.bytes,
        sha256: runSnapshot.file.sha256,
        observedAt: runSnapshot.file.observedAt,
      };
    } catch (error) {
      readBudget.settle(NATIVE_HARNESS_HISTORY_LIMITS.runBytes, null);
      runFailure = runProblem(error);
    }
  }
  query.observedBytes = observedBytes;

  if (runSnapshot !== null) {
    const aborted = signalProblem(request.signal);
    if (aborted !== null) {
      addReason(reasons, aborted);
      return finish({
        state: "aborted",
        recorded: unavailableRecorded(locator.runId, aborted),
        originCompatibility: buildOriginCompatibility(locator, null, pin.path),
        artifactIntegrity: unavailableArtifacts("absent", 0, aborted),
        accounting: buildAccounting(null),
        reasons,
      });
    }
    const runRootCurrent = await rootIdentityStillCurrent(scopedIo, pin);
    const afterRunRoot = signalProblem(request.signal);
    if (afterRunRoot !== null) {
      addReason(reasons, afterRunRoot);
      return finish({
        state: afterRunRoot.code === "query-aborted" ? "aborted" : "unavailable",
        recorded: unavailableRecorded(locator.runId, afterRunRoot),
        originCompatibility: buildOriginCompatibility(locator, null, pin.path),
        artifactIntegrity: unavailableArtifacts("absent", 0, afterRunRoot),
        accounting: buildAccounting(null),
        reasons,
      });
    }
    if (!runRootCurrent) {
      rootChanged = true;
      addReason(reasons, reason(
        "storage-root-changed",
        "The pinned storage root identity changed after the run observation.",
      ));
    }
  }

  let record: RunRecord | null = null;
  let runDecodeFailure: NativeHarnessHistoryReason | null = null;
  if (runSnapshot !== null) {
    try {
      record = decodeRunHistoryText(runSnapshot.text, locator.runId);
    } catch (error) {
      runDecodeFailure = error instanceof RangeError
        ? reason(
            "run-profile-unavailable",
            `The run text exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.runBytes}-byte readonly history profile; this is profile-unavailable, not established corruption.`,
          )
        : reason(
            "run-decode-failed",
            "The run text failed the original vendor validator or does not match the locator run ID; no fallback was applied.",
          );
    }
  }
  if (record !== null) {
    for (const metadataProblem of recordMetadataProblems(record)) addReason(reasons, metadataProblem);
  }
  const primaryFailure = runFailure ?? runDecodeFailure;
  if (primaryFailure !== null) {
    addReason(reasons, primaryFailure);
    return finish({
      state: "unavailable",
      recorded: unavailableRecorded(locator.runId, primaryFailure),
      originCompatibility: buildOriginCompatibility(locator, null, pin.path),
      artifactIntegrity: unavailableArtifacts("absent", 0, primaryFailure),
      accounting: buildAccounting(null),
      reasons,
    });
  }

  let events: NativeHarnessHistoryEventsProjection = unavailableEvents(reason(
    "events-unavailable",
    "The events log was not read.",
  ));
  if (record !== null && !rootChanged) {
    if (!readBudget.reserve(NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes)) {
      events = unavailableEvents(reason(
        "query-budget-exhausted",
        `The ${NATIVE_HARNESS_HISTORY_LIMITS.queryBytes}-byte whole-query budget was reached before the events read.`,
      ));
    } else {
      let eventsSnapshot: NativeWorkspaceTextSnapshot | null = null;
      try {
        eventsSnapshot = await captureWorkspaceText(pin.path, eventsRelativePath, scopedIo, observationNow());
        readBudget.settle(NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes, eventsSnapshot.file.bytes);
        observedBytes += eventsSnapshot.file.bytes;
        query.observedBytes = observedBytes;
        const file: NativeHarnessHistoryFileObservation = {
          relativePath: eventsRelativePath,
          bytes: eventsSnapshot.file.bytes,
          sha256: eventsSnapshot.file.sha256,
          observedAt: eventsSnapshot.file.observedAt,
        };
        let decoded: RunEvent[];
        try {
          decoded = decodeRunEventsText(eventsSnapshot.text, locator.runId);
          events = {
            state: decoded.length === 0 && eventsSnapshot.file.bytes === 0 ? "empty" : "observed",
            rows: decoded.length,
            file,
            problem: null,
          };
        } catch (error) {
          const problem = error instanceof RangeError
            ? reason(
                "events-profile-unavailable",
                `The events text exceeds the ${NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes}-byte/${NATIVE_HARNESS_HISTORY_LIMITS.eventRows}-row readonly profile; this is profile-unavailable, not established corruption.`,
              )
            : reason(
                "events-decode-failed",
                "The events text is torn, corrupt or does not match the locator run ID; no fallback was applied.",
              );
          events = { state: "unavailable", rows: null, file, problem };
        }
      } catch (error) {
        readBudget.settle(NATIVE_HARNESS_HISTORY_LIMITS.eventsBytes, null);
        events = unavailableEvents(eventsProblem(error));
      }
    }
    if (events.file !== null || events.state === "unavailable") {
      const aborted = signalProblem(request.signal);
      if (aborted !== null) {
        addReason(reasons, aborted);
        return finish({
          state: "aborted",
          recorded: buildRecorded(record, runFile, unavailableEvents(aborted)),
          originCompatibility: buildOriginCompatibility(locator, record, pin.path),
          artifactIntegrity: unavailableArtifacts("absent", 0, aborted),
          accounting: buildAccounting(record),
          reasons,
        });
      }
      const eventsRootCurrent = await rootIdentityStillCurrent(scopedIo, pin);
      const afterEventsRoot = signalProblem(request.signal);
      if (afterEventsRoot !== null) {
        addReason(reasons, afterEventsRoot);
        return finish({
          state: afterEventsRoot.code === "query-aborted" ? "aborted" : "unavailable",
          recorded: buildRecorded(record, runFile, unavailableEvents(afterEventsRoot)),
          originCompatibility: buildOriginCompatibility(locator, record, pin.path),
          artifactIntegrity: unavailableArtifacts("absent", 0, afterEventsRoot),
          accounting: buildAccounting(record),
          reasons,
        });
      }
      if (!eventsRootCurrent) {
        rootChanged = true;
        addReason(reasons, reason(
          "storage-root-changed",
          "The pinned storage root identity changed after the events observation.",
        ));
      }
    }
  }
  if (events.problem !== null) addReason(reasons, events.problem);

  const declaration = validateDeclaredArtifacts(request.declaredArtifacts);
  let artifactIntegrity: NativeHarnessHistoryArtifactIntegrity;
  if (declaration.state !== "present") {
    artifactIntegrity = unavailableArtifacts(
      declaration.state,
      0,
      declaration.problem,
    );
    addReason(reasons, declaration.problem);
  } else if (rootChanged) {
    const problem = reason(
      "storage-root-changed",
      "Artifact reads were not started because the pinned storage root identity changed.",
    );
    artifactIntegrity = unavailableArtifacts("present", declaration.items.length, problem);
    addReason(reasons, problem);
  } else {
    const workspace = winnerWorkspace(record as RunRecord, locator, pin.path);
    if (!workspace.ok) {
      artifactIntegrity = unavailableArtifacts("present", declaration.items.length, workspace.problem);
      addReason(reasons, workspace.problem);
    } else {
      const results: NativeHarnessHistoryArtifactResult[] = [];
      let artifactFailure: NativeHarnessHistoryReason | null = null;
      for (const item of declaration.items) {
        const aborted = signalProblem(request.signal);
        if (aborted !== null) {
          addReason(reasons, aborted);
          return finish({
            state: "aborted",
            recorded: buildRecorded(record, runFile, events),
            originCompatibility: buildOriginCompatibility(locator, record, pin.path),
            artifactIntegrity: buildArtifactIntegrity(declaration, workspace.winner, results, aborted, false),
            accounting: buildAccounting(record),
            reasons,
          });
        }
        if (rootChanged) break;
        const artifactRelativePath = `${workspace.relativePrefix}/${item.relativePath}`;
        const artifactReservation = NATIVE_HARNESS_HISTORY_LIMITS.artifactBytes;
        if (!artifactReadBudget.reserve(artifactReservation)) {
          const problem = artifactProblem("artifact-budget-exhausted");
          results.push(artifactResult(item, null, "artifact-budget-exhausted", problem));
          continue;
        }
        if (!readBudget.reserve(artifactReservation)) {
          artifactReadBudget.release(artifactReservation);
          const problem = artifactProblem("query-budget-exhausted");
          results.push(artifactResult(item, null, "query-budget-exhausted", problem));
          continue;
        }
        let snapshot: NativeWorkspaceTextSnapshot | null = null;
        try {
          snapshot = await captureWorkspaceText(pin.path, artifactRelativePath, scopedIo, observationNow());
          artifactReadBudget.settle(artifactReservation, snapshot.file.bytes);
          readBudget.settle(artifactReservation, snapshot.file.bytes);
          observedBytes += snapshot.file.bytes;
          query.observedBytes = observedBytes;
          const bytesMatch = snapshot.file.bytes === item.bytes;
          const hashMatch = snapshot.file.sha256 === item.sha256;
          const status: NativeHarnessHistoryArtifactStatus = bytesMatch && hashMatch
            ? "match"
            : bytesMatch
              ? "hash-mismatch"
              : hashMatch
                ? "bytes-mismatch"
                : "content-mismatch";
          results.push(artifactResult(
            item,
            snapshot,
            status,
            status === "match" ? null : artifactProblem(status),
          ));
        } catch (error) {
          artifactReadBudget.settle(artifactReservation, null);
          readBudget.settle(artifactReservation, null);
          const status = artifactStatus(error);
          results.push(artifactResult(item, null, status, artifactProblem(status)));
        } finally {
          const after = signalProblem(request.signal);
          if (after !== null) {
            addReason(reasons, after);
            return finish({
              state: after.code === "query-aborted" ? "aborted" : "unavailable",
              recorded: buildRecorded(record, runFile, events),
              originCompatibility: buildOriginCompatibility(locator, record, pin.path),
              artifactIntegrity: buildArtifactIntegrity(declaration, workspace.winner, results, after, false),
              accounting: buildAccounting(record),
              reasons,
            });
          }
          const artifactRootCurrent = rootChanged
            ? false
            : await rootIdentityStillCurrent(scopedIo, pin);
          const afterArtifactRoot = signalProblem(request.signal);
          if (afterArtifactRoot !== null) {
            addReason(reasons, afterArtifactRoot);
            return finish({
              state: afterArtifactRoot.code === "query-aborted" ? "aborted" : "unavailable",
              recorded: buildRecorded(record, runFile, events),
              originCompatibility: buildOriginCompatibility(locator, record, pin.path),
              artifactIntegrity: buildArtifactIntegrity(declaration, workspace.winner, results, afterArtifactRoot, false),
              accounting: buildAccounting(record),
              reasons,
            });
          }
          if (!artifactRootCurrent && !rootChanged) {
            rootChanged = true;
            addReason(reasons, reason(
              "storage-root-changed",
              "The pinned storage root identity changed after an artifact observation.",
            ));
          }
        }
      }
      if (rootChanged) {
        artifactFailure = reason(
          "storage-root-changed",
          "Artifact coverage stopped when the pinned storage root identity changed.",
        );
        addReason(reasons, artifactFailure);
      }
      artifactIntegrity = buildArtifactIntegrity(
        declaration,
        workspace.winner,
        results,
        artifactFailure,
        !rootChanged && results.length === declaration.items.length,
      );
      const mismatches = results.filter((entry) => entry.status !== "match");
      if (mismatches.length > 0) {
        addReason(reasons, reason(
          "artifact-integrity-mismatch",
          `${mismatches.length} declared artifact file observation(s) did not match the declaration or were unavailable.`,
        ));
      }
      if (results.some((entry) => entry.status === "artifact-budget-exhausted")) {
        addReason(reasons, artifactProblem("artifact-budget-exhausted"));
      }
      if (results.some((entry) => entry.status === "query-budget-exhausted")) {
        addReason(reasons, artifactProblem("query-budget-exhausted"));
      }
    }
  }

  const origin = buildOriginCompatibility(locator, record, pin.path);
  if (origin.workspaceLayout === "mismatch") {
    addReason(reasons, reason(
      "origin-workspace-layout-mismatch",
      "The recorded private harness workspace is not the expected prepared path for this locator.",
    ));
  }

  // Process diagnosis runs only after the existing run/events/artifact reads.
  // It targets the current recorded attempts plus one controller lock owner;
  // every owner read still uses the original pin, scoped IO and query budget.
  let processObservation: NativeHarnessHistoryProcessObservation | undefined;
  if (request.processObserver !== undefined && record !== null && !rootChanged) {
    const targets = deriveNativeHarnessHistoryProcessTargets(
      pin.path,
      locator.storeRelativePath,
      record.id,
      Object.entries(record.stages).flatMap(([id, stage]) => stage === undefined ? [] : [{
        id,
        status: stage.status,
        attempt: stage.attempt,
        cwd: stage.cwd,
      }]),
    );
    let ownerReadOpen = true;
    const readOwner = async (
      target: NativeHarnessHistoryProcessTarget,
    ): Promise<NativeHarnessHistoryProcessOwnerRead> => {
      if (!ownerReadOpen) {
        return ownerReadWithoutIo(
          target,
          "not-attempted",
          "The owner-read closure was closed after the bounded process observation returned.",
        );
      }
      const reservation = NATIVE_HARNESS_HISTORY_PROCESS_LIMITS.ownerReadReservationBytes;
      if (!readBudget.reserve(reservation)) {
        return ownerReadWithoutIo(
          target,
          "budget-exhausted",
          `The ${NATIVE_HARNESS_HISTORY_LIMITS.queryBytes}-byte whole-query budget was reached before this owner read.`,
        );
      }
      try {
        const snapshot = await captureWorkspaceText(
          pin.path,
          target.ownerRelativePath,
          scopedIo,
          observationNow(),
        );
        readBudget.settle(reservation, snapshot.file.bytes);
        observedBytes += snapshot.file.bytes;
        query.observedBytes = observedBytes;
        return decodeNativeHarnessHistoryProcessOwner(target, record.id, {
          text: snapshot.text,
          bytes: snapshot.file.bytes,
          sha256: snapshot.file.sha256,
          observedAt: snapshot.file.observedAt,
        });
      } catch (error) {
        readBudget.settle(reservation, null);
        return ownerReadFailure(target, error);
      }
    };
    let collected: Awaited<ReturnType<typeof collectNativeHarnessHistoryProcess>>;
    try {
      collected = await collectNativeHarnessHistoryProcess({
        targets,
        readOwner,
        osObserver: request.processObserver,
        signal: request.signal,
        isRootCurrent: async () => !rootChanged && await rootIdentityStillCurrent(scopedIo, pin),
        isAborted: () => signalProblem(request.signal) !== null,
      });
    } finally {
      ownerReadOpen = false;
    }
    processObservation = collected.observation;
    if (!collected.rootCurrentAfterQuery && !rootChanged) {
      rootChanged = true;
      addReason(reasons, reason(
        "storage-root-changed",
        "The pinned storage root identity changed after the process observation.",
      ));
    }
  }

  const finalSignal = signalProblem(request.signal);
  if (finalSignal !== null) {
    addReason(reasons, finalSignal);
    return finish({
      state: finalSignal.code === "query-aborted" ? "aborted" : "unavailable",
      recorded: buildRecorded(record, runFile, events),
      originCompatibility: origin,
      artifactIntegrity,
      accounting: buildAccounting(record),
      reasons,
      ...(processObservation === undefined ? {} : { processObservation }),
    });
  }

  let state: NativeHarnessHistoryState = "observed";
  if (rootChanged) state = "uncertain";
  else if (events.state === "unavailable") state = "partial";
  else if (declaration.state === "present" && artifactIntegrity.state !== "declared-files-matched") state = "partial";

  return finish({
    state,
    recorded: buildRecorded(record, runFile, events),
    originCompatibility: origin,
    artifactIntegrity,
    accounting: buildAccounting(record),
    reasons,
    ...(processObservation === undefined ? {} : { processObservation }),
  });
}
