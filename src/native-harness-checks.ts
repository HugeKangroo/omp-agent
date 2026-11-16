import type { NativeWorkCallReference } from "./native-entry.ts";
import type {
  NativeHarnessOutputSelection,
  NativeHarnessOutputSelectionFailure,
  NativeHarnessOutputSelectionSuccess,
} from "./native-harness-delegation.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  createNativeTextCheckPlan,
  matchesNativeTextCheckReceipt,
  type NativeTextCheckCondition,
  type NativeTextCheckPlan,
  type NativeTextCheckReceipt,
} from "./native-snapshot-checker.ts";
import {
  isNativeWorkspaceTextSnapshot,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";

/**
 * Host-only normalization and bounded records for checks over one already
 * captured Harness output Slot. This leaf owns no source/capture registry, no
 * lifetime and no I/O: records are plain objects attached by the delegation
 * coordinator to the Slot that already retained the original capture.
 */

export const NATIVE_HARNESS_RESULT_TOOL = "agent_harness_result";
export const NATIVE_HARNESS_CHECK_SCHEMA = "omp-agent.native-harness-output-check.v1";
export const NATIVE_HARNESS_CHECK_PLAN_SOURCE = "model-proposed-after-capture";

export const NATIVE_HARNESS_MAX_CHECK_PATHS = 8;
export const NATIVE_HARNESS_MAX_CHECK_ACTIONS = 16;
export const NATIVE_HARNESS_MAX_CHECK_CONDITIONS = 32;
export const NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES = 64 * 1024;
export const NATIVE_HARNESS_MAX_CHECK_ID_CHARS = 256;
export const NATIVE_HARNESS_MAX_CHECK_PATH_CHARS = 1024;
export const NATIVE_HARNESS_MAX_CHECK_REASON_CHARS = 320;

const MAX_CHECK_INPUT_KEYS = 6;
const CHECK_INPUT_KEYS = Object.freeze([
  "action",
  "sourceToolCallId",
  "captureId",
  "captureDigest",
  "path",
  "conditions",
] as const);

export type NativeHarnessCheckFailureCode =
  | "check-unavailable"
  | "not-ready"
  | "source-conflict"
  | "authority-lost"
  | "capacity"
  | "cancelled"
  | "deadline"
  | "invalid-caller"
  | "protocol";

export interface NativeHarnessCheckFailure {
  readonly ok: false;
  readonly code: NativeHarnessCheckFailureCode;
  readonly reason: string;
}

/** Exact frozen action input. `conditions` is the authentic plan's frozen array. */
export interface NativeHarnessCheckInput {
  readonly action: "check";
  readonly sourceToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly path: string;
  readonly conditions: readonly NativeTextCheckCondition[];
}

export interface NativeHarnessCheckPathRecord {
  readonly captureId: string;
  readonly captureDigest: string;
  readonly path: string;
  readonly snapshot: NativeWorkspaceTextSnapshot;
  readonly plan: NativeTextCheckPlan;
  readonly receipt: NativeTextCheckReceipt;
  readonly planBytes: number;
  readonly receiptBytes: number;
  readonly origin: typeof NATIVE_HARNESS_CHECK_PLAN_SOURCE;
  readonly computedByToolCallId: string;
}

export interface NativeHarnessCheckSuccess {
  readonly ok: true;
  readonly schema: typeof NATIVE_HARNESS_CHECK_SCHEMA;
  readonly action: "check";
  readonly authority: "non-authoritative";
  readonly sourceToolCallId: string;
  readonly checkToolCallId: string;
  readonly computedByToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly path: string;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly planDigest: string;
  readonly planSource: typeof NATIVE_HARNESS_CHECK_PLAN_SOURCE;
  readonly receipt: NativeTextCheckReceipt;
  readonly observation: "cached-historical";
  readonly filesystemFreshness: "not-rechecked";
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

export type NativeHarnessCheckOutcome = NativeHarnessCheckSuccess | NativeHarnessCheckFailure;

export type NativeHarnessCheckActionState = "admitted" | "conflicted" | "cancelled" | "failed";

interface NativeHarnessCheckActionBase {
  readonly actionRef: NativeWorkCallReference;
  readonly actionToolCallId: string;
  readonly sourceToolCallId: string;
  readonly inputSha256: string;
  readonly signal: AbortSignal;
  state: NativeHarnessCheckActionState;
  conflictReason: string | null;
}

/** A successfully admitted action retains the accounted original path. */
export interface NativeHarnessCheckRetainedActionRecord extends NativeHarnessCheckActionBase {
  readonly kind: "retained";
  readonly input: NativeHarnessCheckInput;
  readonly path: NativeHarnessCheckPathRecord;
  readonly response: NativeHarnessCheckSuccess;
  state: "admitted" | "conflicted" | "cancelled";
  registrationSha256: string | null;
  registrationBytes: number | null;
  registrationConflict: string | null;
}

/**
 * A post-capture failure keeps only the original action identity and bounded
 * failure facts. It retains no path, plan conditions, receipt or response.
 */
export interface NativeHarnessCheckTerminalActionRecord extends NativeHarnessCheckActionBase {
  readonly kind: "terminal";
  readonly failureCode: NativeHarnessCheckFailureCode;
  readonly reason: string;
  state: "cancelled" | "failed";
  readonly registrationSha256: null;
  readonly registrationBytes: null;
  readonly registrationConflict: null;
}

export type NativeHarnessCheckActionRecord =
  | NativeHarnessCheckRetainedActionRecord
  | NativeHarnessCheckTerminalActionRecord;

/** Exact frozen two-field input for one original-Slot capture action. */
export interface NativeHarnessCaptureInput {
  readonly action: "capture";
  readonly sourceToolCallId: string;
}

export type NativeHarnessCaptureActionState =
  | "pending"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "conflicted";

/**
 * One capture action bound to the same original Slot and the same bounded
 * action table as checks. The response references the authentic retained
 * capture; no raw text is copied here.
 */
export interface NativeHarnessCaptureActionRecord {
  readonly kind: "capture";
  readonly actionRef: NativeWorkCallReference;
  readonly actionToolCallId: string;
  readonly sourceToolCallId: string;
  readonly input: NativeHarnessCaptureInput;
  readonly inputSha256: string;
  readonly signal: AbortSignal;
  state: NativeHarnessCaptureActionState;
  conflictReason: string | null;
  promise: Promise<NativeHarnessOutputSelection> | null;
  selection: NativeHarnessOutputSelectionSuccess | null;
  failure: NativeHarnessOutputSelectionFailure | null;
  registrationSha256: string | null;
  registrationBytes: number | null;
  registrationConflict: string | null;
}

export type NativeHarnessActionRecord =
  | NativeHarnessCheckActionRecord
  | NativeHarnessCaptureActionRecord;

export interface NativeHarnessCheckState {
  readonly paths: NativeHarnessCheckPathRecord[];
  readonly actions: Map<string, NativeHarnessActionRecord>;
  retainedMetadataBytes: number;
  busy: boolean;
}

export interface NativeHarnessCheckView {
  readonly paths: number;
  readonly actions: number;
  readonly retainedBytes: number;
}

type OwnField =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | { readonly kind: "data"; readonly value: unknown };

function readOwnField(target: unknown, key: string): OwnField {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    return { kind: "missing" };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return { kind: "accessor" };
  }
  if (descriptor === undefined) return { kind: "missing" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "data", value: descriptor.value };
}

function boundedReason(value: string): string {
  const normalized = value.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  const text = normalized.length === 0 ? "native harness check refused" : normalized;
  return text.length <= NATIVE_HARNESS_MAX_CHECK_REASON_CHARS
    ? text
    : `${text.slice(0, NATIVE_HARNESS_MAX_CHECK_REASON_CHARS - 3)}...`;
}

function protocolFailure(reason: string): NativeHarnessCheckFailure {
  return Object.freeze({ ok: false as const, code: "protocol" as const, reason: boundedReason(reason) });
}

function thrownReason(error: unknown): string {
  if (typeof error === "string") return error;
  const message = readOwnField(error, "message");
  if (message.kind === "data" && typeof message.value === "string") return message.value;
  return "the check input could not be normalized";
}

function boundedId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > NATIVE_HARNESS_MAX_CHECK_ID_CHARS
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function boundedPath(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > NATIVE_HARNESS_MAX_CHECK_PATH_CHARS
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function hex64(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Reads the six top-level fields once through own data descriptors. Accessor
 * getters and value coercion are never executed; Proxy reflection traps may
 * run, and any failed reflection is refused before a plan is created.
 */
function readCheckInputFields(value: unknown): Map<string, unknown> | NativeHarnessCheckFailure {
  if (typeof value !== "object" || value === null) {
    return protocolFailure("the check input must be a plain object with exactly six own data fields");
  }
  let array: boolean;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return protocolFailure("the check input could not be inspected");
  }
  if (array) {
    return protocolFailure("the check input must be a plain object with exactly six own data fields");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return protocolFailure("the check input must be a plain object");
  }
  if (keys.length !== MAX_CHECK_INPUT_KEYS) {
    return protocolFailure("the check input must contain exactly action, sourceToolCallId, captureId, captureDigest, path and conditions");
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !(CHECK_INPUT_KEYS as readonly string[]).includes(key)) {
      return protocolFailure("the check input must contain only its six string data fields");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return protocolFailure("the check input fields could not be inspected");
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return protocolFailure("the check input must contain only enumerable own data properties");
    }
    fields.set(key, descriptor.value);
  }
  for (const key of CHECK_INPUT_KEYS) {
    if (!fields.has(key)) {
      return protocolFailure("the check input must contain exactly action, sourceToolCallId, captureId, captureDigest, path and conditions");
    }
  }
  return fields;
}

export type NativeHarnessCheckNormalization =
  | {
    readonly ok: true;
    readonly input: NativeHarnessCheckInput;
    readonly digest: string;
    readonly plan: NativeTextCheckPlan;
  }
  | NativeHarnessCheckFailure;

const CAPTURE_INPUT_KEYS = Object.freeze(["action", "sourceToolCallId"] as const);

export type NativeHarnessCaptureNormalization =
  | {
    readonly ok: true;
    readonly input: NativeHarnessCaptureInput;
    readonly digest: string;
  }
  | NativeHarnessCheckFailure;

/**
 * One exact-shape read and one canonical fingerprint for a capture action.
 * Getters, coercion and unknown keys are refused before any action record can
 * exist; the frozen stable input is the only value used afterwards.
 */
export function normalizeNativeHarnessCaptureInput(value: unknown): NativeHarnessCaptureNormalization {
  if (typeof value !== "object" || value === null) {
    return protocolFailure("the capture input must be a plain object with exactly two own data fields");
  }
  let array: boolean;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return protocolFailure("the capture input could not be inspected");
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) {
    return protocolFailure("the capture input must be a plain object");
  }
  if (keys.length !== CAPTURE_INPUT_KEYS.length) {
    return protocolFailure("the capture input must contain exactly action and sourceToolCallId");
  }
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !(CAPTURE_INPUT_KEYS as readonly string[]).includes(key)) {
      return protocolFailure("the capture input must contain only its two string data fields");
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return protocolFailure("the capture input fields could not be inspected");
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return protocolFailure("the capture input must contain only enumerable own data properties");
    }
    fields.set(key, descriptor.value);
  }
  if (!fields.has("action") || !fields.has("sourceToolCallId")) {
    return protocolFailure("the capture input must contain exactly action and sourceToolCallId");
  }
  if (fields.get("action") !== "capture") {
    return protocolFailure('the capture input action must be "capture"');
  }
  const sourceToolCallId = boundedId(fields.get("sourceToolCallId"));
  if (sourceToolCallId === null) {
    return protocolFailure("the capture input sourceToolCallId is not a bounded id");
  }
  const input: NativeHarnessCaptureInput = Object.freeze({
    action: "capture" as const,
    sourceToolCallId,
  });
  const fingerprint = fingerprintNativeJson(input);
  if (!fingerprint.ok) {
    return protocolFailure(`the frozen capture input could not be fingerprinted: ${fingerprint.reason}`);
  }
  return Object.freeze({ ok: true as const, input, digest: fingerprint.sha256 });
}

/**
 * One exact-shape read, one checker-plan normalization, one frozen stable
 * input and one canonical fingerprint. The caller object is never reread.
 */
export function normalizeNativeHarnessCheckInput(value: unknown): NativeHarnessCheckNormalization {
  const fields = readCheckInputFields(value);
  if (!(fields instanceof Map)) return fields;
  const record = fields;
  if (record.get("action") !== "check") {
    return protocolFailure('the check input action must be "check"');
  }
  const sourceToolCallId = boundedId(record.get("sourceToolCallId"));
  if (sourceToolCallId === null) {
    return protocolFailure("the check input sourceToolCallId is not a bounded id");
  }
  const captureId = boundedId(record.get("captureId"));
  if (captureId === null) {
    return protocolFailure("the check input captureId is not a bounded id");
  }
  const captureDigest = record.get("captureDigest");
  if (!hex64(captureDigest)) {
    return protocolFailure("the check input captureDigest is not a 64-character lowercase hex digest");
  }
  const path = boundedPath(record.get("path"));
  if (path === null) {
    return protocolFailure("the check input path is not a bounded relative path");
  }
  let plan: NativeTextCheckPlan;
  try {
    plan = createNativeTextCheckPlan({ conditions: record.get("conditions") });
  } catch (error) {
    return protocolFailure(thrownReason(error));
  }
  const input: NativeHarnessCheckInput = Object.freeze({
    action: "check" as const,
    sourceToolCallId,
    captureId,
    captureDigest,
    path,
    conditions: plan.conditions,
  });
  const fingerprint = fingerprintNativeJson(input);
  if (!fingerprint.ok) {
    return protocolFailure(`the frozen check input could not be fingerprinted: ${fingerprint.reason}`);
  }
  return Object.freeze({ ok: true as const, input, digest: fingerprint.sha256, plan });
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function nativeHarnessCheckPlanBytes(plan: NativeTextCheckPlan): number {
  return encodedBytes(plan);
}

export function nativeHarnessCheckReceiptBytes(receipt: NativeTextCheckReceipt): number {
  return encodedBytes(receipt);
}

export function sameNativeHarnessCheckPlan(left: NativeTextCheckPlan, right: NativeTextCheckPlan): boolean {
  if (left.digest !== right.digest || left.conditions.length !== right.conditions.length) return false;
  return JSON.stringify(left.conditions) === JSON.stringify(right.conditions);
}

/** Creates the per-Slot mutable record container; it has no independent lifetime. */
export function createNativeHarnessCheckState(): NativeHarnessCheckState {
  return { paths: [], actions: new Map(), retainedMetadataBytes: 0, busy: false };
}

export interface NewNativeHarnessCheckPath {
  readonly captureId: string;
  readonly captureDigest: string;
  readonly path: string;
  readonly snapshot: NativeWorkspaceTextSnapshot;
  readonly plan: NativeTextCheckPlan;
  readonly receipt: NativeTextCheckReceipt;
  readonly computedByToolCallId: string;
}

/**
 * Accepts only an authentic receipt issued for the exact snapshot and plan
 * objects, then accounts the existing individual plan/receipt limits.
 */
export function createNativeHarnessCheckPathRecord(
  value: NewNativeHarnessCheckPath,
): NativeHarnessCheckPathRecord | null {
  if (!isNativeWorkspaceTextSnapshot(value.snapshot)) return null;
  if (!matchesNativeTextCheckReceipt(value.receipt, value.snapshot, value.plan)) return null;
  const planBytes = nativeHarnessCheckPlanBytes(value.plan);
  const receiptBytes = nativeHarnessCheckReceiptBytes(value.receipt);
  return Object.freeze({
    captureId: value.captureId,
    captureDigest: value.captureDigest,
    path: value.path,
    snapshot: value.snapshot,
    plan: value.plan,
    receipt: value.receipt,
    planBytes,
    receiptBytes,
    origin: NATIVE_HARNESS_CHECK_PLAN_SOURCE,
    computedByToolCallId: value.computedByToolCallId,
  });
}

export function createNativeHarnessCheckResponse(
  actionToolCallId: string,
  input: NativeHarnessCheckInput,
  path: NativeHarnessCheckPathRecord,
): NativeHarnessCheckSuccess {
  return Object.freeze({
    ok: true as const,
    schema: NATIVE_HARNESS_CHECK_SCHEMA,
    action: "check" as const,
    authority: "non-authoritative" as const,
    sourceToolCallId: input.sourceToolCallId,
    checkToolCallId: actionToolCallId,
    computedByToolCallId: path.computedByToolCallId,
    captureId: input.captureId,
    captureDigest: input.captureDigest,
    path: input.path,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    planDigest: path.plan.digest,
    planSource: path.origin,
    receipt: path.receipt,
    observation: "cached-historical" as const,
    filesystemFreshness: "not-rechecked" as const,
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

export interface NewNativeHarnessCheckAction {
  readonly actionRef: NativeWorkCallReference;
  readonly input: NativeHarnessCheckInput;
  readonly inputSha256: string;
  readonly signal: AbortSignal;
  readonly path: NativeHarnessCheckPathRecord;
  readonly response: NativeHarnessCheckSuccess;
}

export function createNativeHarnessCheckActionRecord(
  value: NewNativeHarnessCheckAction,
): NativeHarnessCheckRetainedActionRecord {
  return {
    kind: "retained",
    actionRef: value.actionRef,
    actionToolCallId: value.response.checkToolCallId,
    sourceToolCallId: value.input.sourceToolCallId,
    input: value.input,
    inputSha256: value.inputSha256,
    signal: value.signal,
    path: value.path,
    response: value.response,
    state: "admitted",
    conflictReason: null,
    registrationSha256: null,
    registrationBytes: null,
    registrationConflict: null,
  };
}

export interface NewNativeHarnessCheckTerminalAction {
  readonly actionRef: NativeWorkCallReference;
  readonly actionToolCallId: string;
  readonly sourceToolCallId: string;
  readonly inputSha256: string;
  readonly signal: AbortSignal;
  readonly failureCode: NativeHarnessCheckFailureCode;
  readonly reason: string;
}

/** Compact post-capture failure record; no prospective path/plan/receipt body. */
export function createNativeHarnessCheckTerminalActionRecord(
  value: NewNativeHarnessCheckTerminalAction,
): NativeHarnessCheckTerminalActionRecord {
  return Object.freeze({
    kind: "terminal" as const,
    actionRef: value.actionRef,
    actionToolCallId: value.actionToolCallId,
    sourceToolCallId: value.sourceToolCallId,
    inputSha256: value.inputSha256,
    signal: value.signal,
    failureCode: value.failureCode,
    reason: boundedReason(value.reason),
    state: value.failureCode === "cancelled" ? "cancelled" as const : "failed" as const,
    conflictReason: boundedReason(value.reason),
    registrationSha256: null,
    registrationBytes: null,
    registrationConflict: null,
  });
}

export function createNativeHarnessCheckFailure(
  code: NativeHarnessCheckFailureCode,
  reason: string,
): NativeHarnessCheckFailure {
  return Object.freeze({ ok: false as const, code, reason: boundedReason(reason) });
}

/** Bounded counts/bytes only; never a second evidence store. */
export function nativeHarnessCheckView(state: NativeHarnessCheckState | null): NativeHarnessCheckView {
  return Object.freeze({
    paths: state === null ? 0 : state.paths.length,
    actions: state === null ? 0 : state.actions.size,
    retainedBytes: state === null ? 0 : state.retainedMetadataBytes,
  });
}
