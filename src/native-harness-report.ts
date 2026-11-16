import type { NativeWorkCallReference, ReportOutcome } from "./native-entry.ts";
import type { NativeReportWorkIdentity } from "./native-instance-report.ts";
import { NATIVE_HARNESS_CHECK_PLAN_SOURCE } from "./native-harness-checks.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  type NativeTextCheckReceipt,
} from "./native-snapshot-checker.ts";
import { deepFreeze } from "./native-work.ts";

/**
 * Host-only, read-only binding between one already captured Harness2 output
 * and the model's proposed `agent_work` report.
 *
 * This module owns the bounded reread result union, but no reread execution,
 * no report publication and no fresh-filesystem claim. Facts reference the
 * authentic issued receipt once and are bounded before the coordinator returns
 * them. Callers must not treat these facts as task acceptance or semantic
 * verification.
 */

export const NATIVE_HARNESS_REPORT_BINDING_SCHEMA = "omp-agent.native-harness-report-binding.v1";
export const NATIVE_HARNESS_REPORT_REREAD_SCHEMA = "omp-agent.native-harness-report-reread.v1";
export const NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS = 4;
export const NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES = 64 * 1024;
export const NATIVE_HARNESS_REPORT_MAX_SELECTED_CHECKS = 8;
export const NATIVE_HARNESS_REPORT_MAX_ID_CHARS = 256;
export const NATIVE_HARNESS_REPORT_MAX_ROOT_CHARS = 4096;
export const NATIVE_HARNESS_REPORT_MAX_REASON_CHARS = 320;

export type NativeHarnessReportFailureCode =
  | "invalid-caller"
  | "authority-lost"
  | "source-conflict"
  | "not-ready"
  | "coverage"
  | "too-large";

export interface NativeHarnessReportBindingFailure {
  readonly ok: false;
  readonly code: NativeHarnessReportFailureCode;
  readonly reason: string;
}

export interface NativeHarnessReportSelection {
  readonly sourceToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly checkToolCallIds: readonly string[];
}

export interface NativeHarnessReportRequest {
  readonly reportRef: NativeWorkCallReference;
  /** Fingerprint of the complete actual report execute input. */
  readonly reportInputSha256: string;
  readonly work: NativeReportWorkIdentity;
  readonly selection: NativeHarnessReportSelection;
  readonly outcome: ReportOutcome;
}

export interface NativeHarnessReportFileCheckFacts {
  readonly checkToolCallId: string;
  readonly computedByToolCallId: string;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly planSource: typeof NATIVE_HARNESS_CHECK_PLAN_SOURCE;
  readonly planDigest: string;
  readonly receipt: NativeTextCheckReceipt;
}

export interface NativeHarnessReportFileFacts {
  readonly path: string;
  readonly kind: "add" | "modify";
  readonly mode: number;
  readonly controllerHash: string;
  readonly fileSnapshotId: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
  readonly check: NativeHarnessReportFileCheckFacts | null;
}

export interface NativeHarnessReportSourceFacts {
  readonly toolCallId: string;
  readonly observationId: string;
  readonly generation: number;
  readonly taskSha256: string;
  readonly promptSha256: string;
  readonly inputSha256: string;
  readonly observedEnvelopeSha256: string;
  readonly observedEnvelopeBytes: number;
}

export interface NativeHarnessReportCaptureFacts {
  readonly captureId: string;
  readonly captureDigest: string;
  readonly originKind: string;
  readonly completionId: string;
  readonly runId: string;
  readonly baseSnapshotId: string;
  readonly manifestSha256: string;
  readonly winner: {
    readonly candidate: string;
    readonly attempt: number;
    readonly artifactHash: string;
    readonly traceHash: string;
  };
  readonly observedAt: number;
}

export interface NativeHarnessReportCoverageFacts {
  readonly capturedPathCount: number;
  readonly selectedPathCount: number;
  readonly passPathCount: number;
  readonly failPathCount: number;
  readonly missingPathCount: number;
  readonly conditionPassCount: number;
  readonly conditionFailCount: number;
  readonly completedCoverage: boolean;
  readonly missing: readonly { readonly path: string }[];
  readonly failed: readonly { readonly path: string; readonly checkToolCallId: string }[];
}

export interface NativeHarnessReportBindingFacts {
  readonly schema: typeof NATIVE_HARNESS_REPORT_BINDING_SCHEMA;
  readonly authority: "non-authoritative";
  /** Copied requested outcome; never an independent success verdict. */
  readonly modelDeclaredOutcome: ReportOutcome;
  readonly source: NativeHarnessReportSourceFacts;
  readonly capture: NativeHarnessReportCaptureFacts;
  readonly files: readonly NativeHarnessReportFileFacts[];
  readonly coverage: NativeHarnessReportCoverageFacts;
  readonly filesystemFreshness: "not-rechecked";
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

export type NativeHarnessReportRereadFailureCode =
  | "cancelled"
  | "deadline"
  | "capacity"
  | "not-ready"
  | "authority-lost"
  | "invalid-caller"
  | "reread-unavailable"
  | "version-mismatch";

/**
 * One authenticated, admitted output reread over the original capture's
 * backend and completion. It records only bounded interval facts: no native
 * reference, private path, file text, receipt, plan or temporary capture.
 */
export interface NativeHarnessReportRereadSuccess {
  readonly ok: true;
  readonly schema: typeof NATIVE_HARNESS_REPORT_REREAD_SCHEMA;
  readonly sourceToolCallId: string;
  readonly reportToolCallId: string;
  readonly reportInputSha256: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly sameVersion: true;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

export interface NativeHarnessReportRereadFailure {
  readonly ok: false;
  readonly code: NativeHarnessReportRereadFailureCode;
  readonly reason: string;
  /** Present only when this failure settled an admitted I/O attempt. */
  readonly attempt?: number;
}

export type NativeHarnessReportRereadResult =
  | NativeHarnessReportRereadSuccess
  | NativeHarnessReportRereadFailure;

export interface NativeHarnessReportBindingPreparation {
  readonly facts: NativeHarnessReportBindingFacts;
  /**
   * Fresh synchronous actual host reads for this exact preparation. It updates
   * only the bounded validation snapshot; facts and refs are never rebuilt.
   */
  refresh(): string | null;
  /**
   * Pure captured-identity check. Returns null or a bounded primitive refusal
   * string. It performs no host callback, I/O, clock or encoding.
   */
  revalidate(): string | null;
  /**
   * One cooperative reread of the original capture's backend/completion. It is
   * bounded by admitted attempts, capacity and a shared deadline, and returns
   * the exact admitted Promise for an equal duplicate. A stable negative result
   * never becomes publication authority.
   */
  reread(): Promise<NativeHarnessReportRereadResult>;
}

export type NativeHarnessReportBindingResult =
  | { readonly ok: true; readonly prepared: NativeHarnessReportBindingPreparation }
  | NativeHarnessReportBindingFailure;

export interface NativeHarnessReportNormalizedRequest {
  readonly reportRef: object;
  readonly reportInputSha256: string;
  readonly work: NativeReportWorkIdentity;
  readonly selection: NativeHarnessReportSelection;
  readonly outcome: ReportOutcome;
}

export type NativeHarnessReportRequestNormalization =
  | { readonly ok: true; readonly request: NativeHarnessReportNormalizedRequest }
  | NativeHarnessReportBindingFailure;

export interface NativeHarnessReportFactsInput {
  readonly modelDeclaredOutcome: ReportOutcome;
  readonly source: NativeHarnessReportSourceFacts;
  readonly capture: NativeHarnessReportCaptureFacts;
  readonly files: readonly NativeHarnessReportFileFacts[];
}

export type NativeHarnessReportFactsResult =
  | { readonly ok: true; readonly facts: NativeHarnessReportBindingFacts }
  | NativeHarnessReportBindingFailure;

const REQUEST_KEYS = Object.freeze([
  "reportRef",
  "reportInputSha256",
  "work",
  "selection",
  "outcome",
] as const);
const WORK_KEYS = Object.freeze([
  "observationId",
  "generation",
  "sessionId",
  "workspaceRoot",
] as const);
const SELECTION_KEYS = Object.freeze([
  "sourceToolCallId",
  "captureId",
  "captureDigest",
  "checkToolCallIds",
] as const);
const OUTCOMES: readonly ReportOutcome[] = Object.freeze(["completed", "insufficient", "blocked"]);

function boundedReason(value: string, fallback: string): string {
  const normalized = value.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  const text = normalized.length === 0 ? fallback : normalized;
  return text.length <= NATIVE_HARNESS_REPORT_MAX_REASON_CHARS
    ? text
    : `${text.slice(0, NATIVE_HARNESS_REPORT_MAX_REASON_CHARS - 3)}...`;
}

export function createNativeHarnessReportFailure(
  code: NativeHarnessReportFailureCode,
  reason: string,
): NativeHarnessReportBindingFailure {
  return Object.freeze({
    ok: false as const,
    code,
    reason: boundedReason(reason, "native harness report binding refused"),
  });
}

export function createNativeHarnessReportRereadFailure(
  code: NativeHarnessReportRereadFailureCode,
  reason: string,
  attempt?: number,
): NativeHarnessReportRereadFailure {
  const boundedAttempt = typeof attempt === "number"
    && Number.isSafeInteger(attempt)
    && attempt >= 1
    && attempt <= NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS
    ? attempt
    : undefined;
  return Object.freeze({
    ok: false as const,
    code,
    reason: boundedReason(reason, "native harness report reread refused"),
    ...(boundedAttempt === undefined ? {} : { attempt: boundedAttempt }),
  });
}

/**
 * Builds the frozen success record from already-authenticated original values.
 * Malformed metadata refuses instead of publishing a partial success.
 */
export function createNativeHarnessReportRereadSuccess(value: {
  readonly sourceToolCallId: string;
  readonly reportToolCallId: string;
  readonly reportInputSha256: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly attempt: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}): NativeHarnessReportRereadSuccess | null {
  const sourceToolCallId = boundedString(value.sourceToolCallId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
  const reportToolCallId = boundedString(value.reportToolCallId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
  const captureId = boundedString(value.captureId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
  if (sourceToolCallId === null || reportToolCallId === null || captureId === null) return null;
  if (!isHex64(value.reportInputSha256) || !isHex64(value.captureDigest)) return null;
  if (!Number.isSafeInteger(value.attempt)
    || value.attempt < 1
    || value.attempt > NATIVE_HARNESS_REPORT_MAX_REREAD_ATTEMPTS) {
    return null;
  }
  if (!Number.isSafeInteger(value.startedAt)
    || value.startedAt < 0
    || !Number.isSafeInteger(value.finishedAt)
    || value.finishedAt < value.startedAt) {
    return null;
  }
  return Object.freeze({
    ok: true as const,
    schema: NATIVE_HARNESS_REPORT_REREAD_SCHEMA,
    sourceToolCallId,
    reportToolCallId,
    reportInputSha256: value.reportInputSha256,
    captureId,
    captureDigest: value.captureDigest,
    attempt: value.attempt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    sameVersion: true as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function normalizationFailure(reason: string): NativeHarnessReportBindingFailure {
  return createNativeHarnessReportFailure("invalid-caller", reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, minimum = 1): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > max) return null;
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Exact own-data read. Unknown keys, symbols, accessors, exotic prototypes and
 * failed reflection are refused before any value is used.
 */
function readExactDataFields(
  value: unknown,
  keys: readonly string[],
  shape: string,
): Map<string, unknown> | NativeHarnessReportBindingFailure {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return normalizationFailure(`${shape} could not be inspected`);
  }
  if (isArray || typeof value !== "object" || value === null) {
    return normalizationFailure(`${shape} must be a plain object`);
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return normalizationFailure(`${shape} could not be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return normalizationFailure(`${shape} must be a plain own-data object`);
  }
  if (ownKeys.length !== keys.length) {
    return normalizationFailure(`${shape} must contain exactly ${keys.join(", ")}`);
  }
  const fields = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.includes(key)) {
      return normalizationFailure(`${shape} must contain only its fixed string fields`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return normalizationFailure(`${shape} fields could not be inspected`);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return normalizationFailure(`${shape} fields must be own data properties`);
    }
    fields.set(key, descriptor.value);
  }
  for (const key of keys) {
    if (!fields.has(key)) return normalizationFailure(`${shape} is missing ${key}`);
  }
  return fields;
}

/**
 * Dense exact-shape check-id array. Holes, extra keys, accessors, symbols and
 * non-array prototypes are refused before any id is copied.
 */
function readCheckToolCallIds(value: unknown):
  | { readonly ok: true; readonly ids: readonly string[] }
  | NativeHarnessReportBindingFailure {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return normalizationFailure("selection.checkToolCallIds could not be inspected");
  }
  if (!isArray) {
    return normalizationFailure("selection.checkToolCallIds must be an array");
  }
  let prototype: object | null;
  let ownKeys: (string | symbol)[];
  let length: unknown;
  const array = value as object;
  try {
    prototype = Object.getPrototypeOf(array);
    ownKeys = Reflect.ownKeys(array);
    const descriptor = Object.getOwnPropertyDescriptor(array, "length");
    length = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return normalizationFailure("selection.checkToolCallIds could not be inspected");
  }
  if (prototype !== Array.prototype) {
    return normalizationFailure("selection.checkToolCallIds must be an ordinary dense array");
  }
  if (typeof length !== "number"
    || !Number.isSafeInteger(length)
    || length < 0
    || length > NATIVE_HARNESS_REPORT_MAX_SELECTED_CHECKS) {
    return normalizationFailure(
      `selection.checkToolCallIds must contain at most ${NATIVE_HARNESS_REPORT_MAX_SELECTED_CHECKS} ids`,
    );
  }
  if (ownKeys.length !== length + 1) {
    return normalizationFailure("selection.checkToolCallIds must be a dense array without extra keys");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    } catch {
      return normalizationFailure("selection.checkToolCallIds elements could not be inspected");
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return normalizationFailure("selection.checkToolCallIds must be dense own data elements");
    }
    const id = boundedString(descriptor.value, NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
    if (id === null) {
      return normalizationFailure(
        `selection.checkToolCallIds[${index}] must be a bounded non-control string`,
      );
    }
    if (seen.has(id)) {
      return normalizationFailure("selection.checkToolCallIds must not contain duplicates");
    }
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids: Object.freeze(ids) };
}

export type NativeHarnessReportSelectionRead =
  | { readonly ok: true; readonly selection: NativeHarnessReportSelection }
  | NativeHarnessReportBindingFailure;

/**
 * One exact-shape read of the explicit Harness selector. The returned selection
 * is a fresh frozen copy; no caller object or array is retained and raw id
 * order is preserved. Shared by request normalization and selected-input
 * snapshots so there is only one selector rule set.
 */
export function readNativeHarnessReportSelection(value: unknown): NativeHarnessReportSelectionRead {
  try {
    return readNativeHarnessReportSelectionUnchecked(value);
  } catch {
    return normalizationFailure("the report selection could not be inspected");
  }
}

function readNativeHarnessReportSelectionUnchecked(
  value: unknown,
): NativeHarnessReportSelectionRead {
  const selectionFields = readExactDataFields(value, SELECTION_KEYS, "selection");
  if (!(selectionFields instanceof Map)) return selectionFields;
  const sourceToolCallId = boundedString(
    selectionFields.get("sourceToolCallId"),
    NATIVE_HARNESS_REPORT_MAX_ID_CHARS,
  );
  const captureId = boundedString(selectionFields.get("captureId"), NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
  const captureDigest = selectionFields.get("captureDigest");
  if (sourceToolCallId === null || captureId === null || !isHex64(captureDigest)) {
    return normalizationFailure(
      "selection must contain a source id, capture id and lowercase 64-character capture digest",
    );
  }
  const ids = readCheckToolCallIds(selectionFields.get("checkToolCallIds"));
  if (!ids.ok) return ids;
  return {
    ok: true as const,
    selection: Object.freeze({
      sourceToolCallId,
      captureId,
      captureDigest,
      checkToolCallIds: ids.ids,
    }),
  };
}

/**
 * One exact-shape read of the trusted host request. The opaque reportRef is
 * preserved by identity and is never inspected here; native preparation must
 * authenticate it before any of its fields are read.
 */
export function normalizeNativeHarnessReportRequest(
  value: unknown,
): NativeHarnessReportRequestNormalization {
  // A revoked Proxy may throw from isArray/prototype/ownKeys/descriptor reads
  // before any inner guard runs. The whole normalization path is bounded.
  try {
    return readNativeHarnessReportRequest(value);
  } catch {
    return normalizationFailure("the report request could not be inspected");
  }
}

function readNativeHarnessReportRequest(
  value: unknown,
): NativeHarnessReportRequestNormalization {
  const fields = readExactDataFields(value, REQUEST_KEYS, "the report request");
  if (!(fields instanceof Map)) return fields;

  // The ref stays opaque until native.prepareCallCheck proves membership and
  // authenticity. Do not enumerate, Array.isArray, copy, freeze or read it.
  const reportRef = fields.get("reportRef");
  if (typeof reportRef !== "object" || reportRef === null) {
    return normalizationFailure("reportRef must be the exact opaque issued reference object");
  }
  const reportInputSha256 = fields.get("reportInputSha256");
  if (!isHex64(reportInputSha256)) {
    return normalizationFailure("reportInputSha256 must be a lowercase 64-character hex digest");
  }

  const workFields = readExactDataFields(fields.get("work"), WORK_KEYS, "work");
  if (!(workFields instanceof Map)) return workFields;
  const observationId = boundedString(workFields.get("observationId"), NATIVE_HARNESS_REPORT_MAX_ID_CHARS);
  const generation = workFields.get("generation");
  const sessionId = boundedString(workFields.get("sessionId"), NATIVE_HARNESS_REPORT_MAX_ROOT_CHARS);
  const workspaceRoot = boundedString(workFields.get("workspaceRoot"), NATIVE_HARNESS_REPORT_MAX_ROOT_CHARS);
  if (observationId === null
    || typeof generation !== "number"
    || !Number.isSafeInteger(generation)
    || generation < 1
    || sessionId === null
    || workspaceRoot === null) {
    return normalizationFailure("work must be the exact observationId/generation/sessionId/workspaceRoot shape");
  }

  const selection = readNativeHarnessReportSelection(fields.get("selection"));
  if (!selection.ok) return selection;

  const outcome = fields.get("outcome");
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return normalizationFailure("outcome must be completed, insufficient or blocked");
  }

  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      reportRef,
      reportInputSha256,
      work: Object.freeze({ observationId, generation, sessionId, workspaceRoot }),
      selection: selection.selection,
      outcome: outcome as ReportOutcome,
    }),
  });
}

function factFailure(reason: string): NativeHarnessReportBindingFailure {
  return createNativeHarnessReportFailure("source-conflict", reason);
}

function factString(value: unknown, max: number, name: string): string | null {
  const text = boundedString(value, max);
  return text === null ? null : text;
}

function factCount(value: unknown, name: string, minimum = 0): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return null;
  return value;
}

function factDigest(value: unknown, name: string): string | null {
  return isHex64(value) ? value : null;
}

/**
 * Builds the one frozen allowlisted facts object from trusted issued values.
 * The authentic receipt object is referenced once; no plan body, snapshot text
 * or caller string is copied. The complete UTF-8 bound is enforced before
 * success, so no truncated facts leave this module.
 */
export function createNativeHarnessReportFacts(
  value: NativeHarnessReportFactsInput,
): NativeHarnessReportFactsResult {
  try {
    return createNativeHarnessReportFactsUnchecked(value);
  } catch {
    return factFailure("the report facts could not be read");
  }
}

function createNativeHarnessReportFactsUnchecked(
  value: NativeHarnessReportFactsInput,
): NativeHarnessReportFactsResult {
  const outcome = value.modelDeclaredOutcome;
  if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return factFailure("the report outcome is not a supported declaration");
  }

  const source = value.source;
  const sourceToolCallId = factString(source.toolCallId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "source id");
  const observationId = factString(source.observationId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "observation id");
  const generation = factCount(source.generation, "generation", 1);
  const taskSha256 = factDigest(source.taskSha256, "task digest");
  const promptSha256 = factDigest(source.promptSha256, "prompt digest");
  const inputSha256 = factDigest(source.inputSha256, "input digest");
  const observedEnvelopeSha256 = factDigest(source.observedEnvelopeSha256, "envelope digest");
  const observedEnvelopeBytes = factCount(source.observedEnvelopeBytes, "envelope bytes");
  if (sourceToolCallId === null
    || observationId === null
    || generation === null
    || taskSha256 === null
    || promptSha256 === null
    || inputSha256 === null
    || observedEnvelopeSha256 === null
    || observedEnvelopeBytes === null) {
    return factFailure("the issued source facts are incomplete or malformed");
  }

  const capture = value.capture;
  const captureId = factString(capture.captureId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "capture id");
  const captureDigest = factDigest(capture.captureDigest, "capture digest");
  const originKind = factString(capture.originKind, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "origin");
  const completionId = factString(capture.completionId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "completion id");
  const runId = factString(capture.runId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "run id");
  const baseSnapshotId = factString(capture.baseSnapshotId, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "base id");
  const manifestSha256 = factDigest(capture.manifestSha256, "manifest digest");
  const winnerCandidate = factString(capture.winner.candidate, NATIVE_HARNESS_REPORT_MAX_ID_CHARS, "winner");
  const winnerAttempt = factCount(capture.winner.attempt, "attempt", 1);
  const winnerArtifactHash = factDigest(capture.winner.artifactHash, "artifact digest");
  const winnerTraceHash = factDigest(capture.winner.traceHash, "trace digest");
  const captureObservedAt = factCount(capture.observedAt, "capture observedAt");
  if (captureId === null
    || captureDigest === null
    || originKind === null
    || completionId === null
    || runId === null
    || baseSnapshotId === null
    || manifestSha256 === null
    || winnerCandidate === null
    || winnerAttempt === null
    || winnerArtifactHash === null
    || winnerTraceHash === null
    || captureObservedAt === null) {
    return factFailure("the issued capture facts are incomplete or malformed");
  }

  const files: NativeHarnessReportFileFacts[] = [];
  const missing: { path: string }[] = [];
  const failed: { path: string; checkToolCallId: string }[] = [];
  const seenPaths = new Set<string>();
  let selectedPathCount = 0;
  let passPathCount = 0;
  let failPathCount = 0;
  let conditionPassCount = 0;
  let conditionFailCount = 0;

  for (const file of value.files) {
    const filePath = factString(file.path, NATIVE_HARNESS_REPORT_MAX_ROOT_CHARS, "file path");
    const kind = file.kind;
    const mode = factCount(file.mode, "file mode");
    const controllerHash = factDigest(file.controllerHash, "controller hash");
    const fileSnapshotId = factString(
      file.fileSnapshotId,
      NATIVE_HARNESS_REPORT_MAX_ID_CHARS,
      "file snapshot id",
    );
    const bytes = factCount(file.bytes, "file bytes");
    const sha256 = factDigest(file.sha256, "file digest");
    const observedAt = factCount(file.observedAt, "file observedAt");
    if (filePath === null
      || (kind !== "add" && kind !== "modify")
      || mode === null
      || mode > 0o7777
      || controllerHash === null
      || fileSnapshotId === null
      || bytes === null
      || sha256 === null
      || observedAt === null) {
      return factFailure("an issued output file row is incomplete or malformed");
    }
    if (seenPaths.has(filePath)) return factFailure("the report file list contains a duplicate path");
    seenPaths.add(filePath);

    let check: NativeHarnessReportFileCheckFacts | null = null;
    if (file.check !== null) {
      selectedPathCount += 1;
      const checkToolCallId = factString(
        file.check.checkToolCallId,
        NATIVE_HARNESS_REPORT_MAX_ID_CHARS,
        "check id",
      );
      const computedByToolCallId = factString(
        file.check.computedByToolCallId,
        NATIVE_HARNESS_REPORT_MAX_ID_CHARS,
        "computation id",
      );
      const planDigest = factDigest(file.check.planDigest, "plan digest");
      const receipt = file.check.receipt;
      if (checkToolCallId === null
        || computedByToolCallId === null
        || file.check.checkerId !== NATIVE_TEXT_CHECKER_ID
        || file.check.checkerVersion !== NATIVE_TEXT_CHECKER_VERSION
        || file.check.planSource !== NATIVE_HARNESS_CHECK_PLAN_SOURCE
        || planDigest === null
        || typeof receipt !== "object"
        || receipt === null
        || (receipt.outcome !== "pass" && receipt.outcome !== "fail")
        || receipt.planDigest !== planDigest
        || receipt.checkerId !== NATIVE_TEXT_CHECKER_ID
        || receipt.checkerVersion !== NATIVE_TEXT_CHECKER_VERSION
        || !Array.isArray(receipt.conditions)) {
        return factFailure("a selected check row is incomplete or inconsistent");
      }
      let receiptFailCount = 0;
      for (const condition of receipt.conditions) {
        if (condition === null
          || typeof condition !== "object"
          || (condition.result !== "pass" && condition.result !== "fail")) {
          return factFailure("a selected check receipt condition is malformed");
        }
        if (condition.result === "pass") conditionPassCount += 1;
        else {
          conditionFailCount += 1;
          receiptFailCount += 1;
        }
      }
      if (receipt.outcome === "pass") {
        passPathCount += 1;
        if (receiptFailCount > 0) {
          // A pass receipt with a failing listed condition is not authentic.
          return factFailure("a PASS receipt contains a failing condition");
        }
      } else {
        failPathCount += 1;
        failed.push({ path: filePath, checkToolCallId });
      }
      check = Object.freeze({
        checkToolCallId,
        computedByToolCallId,
        checkerId: NATIVE_TEXT_CHECKER_ID,
        checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
        planSource: NATIVE_HARNESS_CHECK_PLAN_SOURCE,
        planDigest,
        receipt,
      });
    } else {
      missing.push({ path: filePath });
    }

    files.push(Object.freeze({
      path: filePath,
      kind,
      mode,
      controllerHash,
      fileSnapshotId,
      bytes,
      sha256,
      observedAt,
      check,
    }));
  }

  const capturedPathCount = files.length;
  const completedCoverage = capturedPathCount > 0
    && missing.length === 0
    && failed.length === 0
    && selectedPathCount === capturedPathCount;
  const coverage: NativeHarnessReportCoverageFacts = Object.freeze({
    capturedPathCount,
    selectedPathCount,
    passPathCount,
    failPathCount,
    missingPathCount: missing.length,
    conditionPassCount,
    conditionFailCount,
    completedCoverage,
    missing: Object.freeze(missing.map((row) => Object.freeze(row))),
    failed: Object.freeze(failed.map((row) => Object.freeze(row))),
  });

  const facts: NativeHarnessReportBindingFacts = deepFreeze({
    schema: NATIVE_HARNESS_REPORT_BINDING_SCHEMA,
    authority: "non-authoritative" as const,
    modelDeclaredOutcome: outcome,
    source: Object.freeze({
      toolCallId: sourceToolCallId,
      observationId,
      generation,
      taskSha256,
      promptSha256,
      inputSha256,
      observedEnvelopeSha256,
      observedEnvelopeBytes,
    }),
    capture: Object.freeze({
      captureId,
      captureDigest,
      originKind,
      completionId,
      runId,
      baseSnapshotId,
      manifestSha256,
      winner: Object.freeze({
        candidate: winnerCandidate,
        attempt: winnerAttempt,
        artifactHash: winnerArtifactHash,
        traceHash: winnerTraceHash,
      }),
      observedAt: captureObservedAt,
    }),
    files: Object.freeze(files),
    coverage,
    filesystemFreshness: "not-rechecked" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });

  let encoded: string;
  try {
    encoded = JSON.stringify(facts);
  } catch {
    return createNativeHarnessReportFailure("source-conflict", "the report facts could not be encoded");
  }
  if (new TextEncoder().encode(encoded).byteLength > NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES) {
    return createNativeHarnessReportFailure(
      "too-large",
      `the complete report facts exceed ${NATIVE_HARNESS_REPORT_MAX_FACTS_BYTES} UTF-8 bytes`,
    );
  }
  return Object.freeze({ ok: true as const, facts });
}
