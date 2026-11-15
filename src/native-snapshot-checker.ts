import { createHash } from "node:crypto";
import {
  isNativeWorkspaceTextSnapshot,
  type NativeObservedFile,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";

/**
 * Fixed, deterministic checks over one already captured text snapshot. This
 * leaf module reads no files, runs no user expressions and evaluates no live
 * task context. A receipt proves only that the listed conditions held for the
 * supplied historical snapshot and plan.
 */

export const NATIVE_TEXT_CHECKER_ID = "omp-agent.native-text-checks";
export const NATIVE_TEXT_CHECKER_VERSION = "1";
export const NATIVE_TEXT_CHECK_SCHEMA_VERSION = 1;
export const MAX_NATIVE_TEXT_CHECK_CONDITIONS = 32;
export const MAX_NATIVE_TEXT_CHECK_ID_CHARS = 128;
export const MAX_NATIVE_TEXT_CHECK_VALUE_CHARS = 4096;
export const MAX_NATIVE_TEXT_CHECK_PLAN_BYTES = 16 * 1024;
export const MAX_NATIVE_TEXT_CHECK_RECEIPT_BYTES = 32 * 1024;
export const MAX_NATIVE_TEXT_POINTER_CHARS = 1024;
export const MAX_NATIVE_TEXT_POINTER_SEGMENTS = 32;

export class NativeTextCheckError extends Error {
  override name = "NativeTextCheckError";
}

export type NativeJsonValueType = "null" | "boolean" | "number" | "string" | "array" | "object";
export type NativeJsonPrimitive = null | boolean | number | string;
export type NativeTextCheckCondition =
  | { readonly id: string; readonly kind: "text-includes"; readonly value: string }
  | { readonly id: string; readonly kind: "json-valid" }
  | { readonly id: string; readonly kind: "json-type"; readonly pointer: string; readonly type: NativeJsonValueType }
  | {
    readonly id: string;
    readonly kind: "json-equals";
    readonly pointer: string;
    readonly value: NativeJsonPrimitive;
  };

export interface NativeTextCheckPlan {
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly schemaVersion: typeof NATIVE_TEXT_CHECK_SCHEMA_VERSION;
  readonly conditions: readonly NativeTextCheckCondition[];
  readonly digest: string;
}

export interface NativeTextCheckConditionResult {
  readonly id: string;
  readonly result: "pass" | "fail";
  readonly detail: string;
}

export interface NativeTextCheckReceipt {
  readonly schemaVersion: typeof NATIVE_TEXT_CHECK_SCHEMA_VERSION;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly planDigest: string;
  readonly snapshot: {
    readonly captureId: string;
    readonly file: Readonly<NativeObservedFile>;
  };
  readonly conditions: readonly NativeTextCheckConditionResult[];
  readonly outcome: "pass" | "fail";
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

const issuedPlans = new WeakSet<NativeTextCheckPlan>();
const issuedReceipts = new WeakSet<NativeTextCheckReceipt>();
const receiptPlans = new WeakMap<NativeTextCheckReceipt, NativeTextCheckPlan>();

function invalidPlan(detail: string): never {
  throw new NativeTextCheckError(`Native text check plan is invalid: ${detail}`);
}

const MAX_CHECK_PLAN_KEYS = 1;
const MAX_CHECK_CONDITION_KEYS = 4;
const MAX_CHECK_ARRAY_KEYS = MAX_NATIVE_TEXT_CHECK_CONDITIONS + 1;

interface OwnShape {
  readonly array: boolean;
  readonly prototype: object | null;
  readonly keys: readonly (string | symbol)[];
}

/**
 * Counts own keys before reading any descriptor. Reflect.ownKeys itself can
 * allocate a large key list and proxy traps are not preemptible, so this is a
 * bounded shape check rather than an OS memory or real-time guarantee.
 */
function inspectOwnKeys(value: object, label: string, maxKeys: number): OwnShape {
  let array: boolean;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalidPlan(`${label} could not be inspected.`);
  }
  if (keys.length > maxKeys) invalidPlan(`${label} has too many own keys.`);
  return { array, prototype, keys };
}

function ownDescriptor(value: object, key: string, label: string): PropertyDescriptor {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return invalidPlan(`${label} could not be inspected.`);
  }
  if (descriptor === undefined) invalidPlan(`${label} own shape changed during validation.`);
  return descriptor;
}

function readRecord(value: unknown, label: string, maxKeys: number): Map<string, unknown> {
  if (typeof value !== "object" || value === null) invalidPlan(`${label} must be a plain object.`);
  const inspected = inspectOwnKeys(value, label, maxKeys);
  if (inspected.array) invalidPlan(`${label} must be a plain object.`);
  if (inspected.prototype !== Object.prototype && inspected.prototype !== null) {
    invalidPlan(`${label} must be a plain object.`);
  }
  if (inspected.keys.some((key) => typeof key === "symbol")) {
    invalidPlan(`${label} must not contain symbol keys.`);
  }
  const result = new Map<string, unknown>();
  for (const key of inspected.keys) {
    if (typeof key !== "string") invalidPlan(`${label} must not contain symbol keys.`);
    const descriptor = ownDescriptor(value, key, label);
    if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      invalidPlan(`${label} must contain only own data properties, not accessors.`);
    }
    if (descriptor.enumerable !== true) invalidPlan(`${label} must contain only enumerable own data.`);
    result.set(key, descriptor.value);
  }
  return result;
}

function requireExactKeys(record: Map<string, unknown>, expected: readonly string[], label: string): void {
  if (record.size !== expected.length) {
    invalidPlan(`${label} must contain exactly ${expected.join(", ")}.`);
  }
  for (const key of expected) {
    if (!record.has(key)) invalidPlan(`${label} must contain exactly ${expected.join(", ")}.`);
  }
}

function conditionValues(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) invalidPlan("conditions must be an array.");
  const inspected = inspectOwnKeys(value, "conditions", MAX_CHECK_ARRAY_KEYS);
  if (!inspected.array) invalidPlan("conditions must be an array.");
  if (inspected.prototype !== Array.prototype) invalidPlan("conditions must be a plain array.");
  if (inspected.keys.some((key) => typeof key === "symbol")) {
    invalidPlan("conditions must not contain symbol keys.");
  }
  const lengthDescriptor = ownDescriptor(value, "length", "conditions");
  if (!("value" in lengthDescriptor)) invalidPlan("conditions length could not be inspected.");
  const length = lengthDescriptor.value;
  if (
    typeof length !== "number"
    || !Number.isInteger(length)
    || length < 1
    || length > MAX_NATIVE_TEXT_CHECK_CONDITIONS
  ) {
    invalidPlan(`conditions must contain 1..${MAX_NATIVE_TEXT_CHECK_CONDITIONS} entries.`);
  }
  const keyCount = inspected.keys.filter((key) => key !== "length").length;
  if (keyCount !== length) invalidPlan("conditions must be a dense plain array.");
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = ownDescriptor(value, String(index), "conditions");
    if (
      !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      invalidPlan(`condition ${index + 1} must be enumerable own data.`);
    }
    values.push(descriptor.value);
  }
  return values;
}

function conditionId(value: unknown, index: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_NATIVE_TEXT_CHECK_ID_CHARS) {
    invalidPlan(`condition ${index + 1} id must be a nonempty string of at most ${MAX_NATIVE_TEXT_CHECK_ID_CHARS} chars.`);
  }
  return value;
}

function pointer(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_NATIVE_TEXT_POINTER_CHARS) {
    invalidPlan(`${label} pointer must be a string of at most ${MAX_NATIVE_TEXT_POINTER_CHARS} chars.`);
  }
  if (value === "") return value;
  if (!value.startsWith("/")) invalidPlan(`${label} pointer must be empty or start with "/".`);
  const segments = value.slice(1).split("/");
  if (segments.length > MAX_NATIVE_TEXT_POINTER_SEGMENTS) {
    invalidPlan(`${label} pointer must have at most ${MAX_NATIVE_TEXT_POINTER_SEGMENTS} segments.`);
  }
  for (const segment of segments) {
    for (let index = 0; index < segment.length; index++) {
      if (segment[index] === "~" && segment[index + 1] !== "0" && segment[index + 1] !== "1") {
        invalidPlan(`${label} pointer contains an invalid escape.`);
      }
    }
  }
  return value;
}

function jsonType(value: unknown, label: string): NativeJsonValueType {
  switch (value) {
    case "null":
    case "boolean":
    case "number":
    case "string":
    case "array":
    case "object":
      return value;
    default:
      return invalidPlan(`${label} type is not supported.`);
  }
}

function primitive(value: unknown, label: string): NativeJsonPrimitive {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidPlan(`${label} value must be a finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_NATIVE_TEXT_CHECK_VALUE_CHARS) {
      invalidPlan(`${label} value must be at most ${MAX_NATIVE_TEXT_CHECK_VALUE_CHARS} chars.`);
    }
    return value;
  }
  return invalidPlan(`${label} value must be null, boolean, finite number or bounded string.`);
}

function normalizeCondition(value: unknown, index: number): NativeTextCheckCondition {
  const label = `condition ${index + 1}`;
  const record = readRecord(value, label, MAX_CHECK_CONDITION_KEYS);
  const id = conditionId(record.get("id"), index);
  switch (record.get("kind")) {
    case "text-includes": {
      requireExactKeys(record, ["id", "kind", "value"], label);
      const included = record.get("value");
      if (
        typeof included !== "string"
        || included.length < 1
        || included.length > MAX_NATIVE_TEXT_CHECK_VALUE_CHARS
      ) {
        invalidPlan(`${label} value must be a nonempty string of at most ${MAX_NATIVE_TEXT_CHECK_VALUE_CHARS} chars.`);
      }
      return Object.freeze({ id, kind: "text-includes", value: included });
    }
    case "json-valid":
      requireExactKeys(record, ["id", "kind"], label);
      return Object.freeze({ id, kind: "json-valid" });
    case "json-type":
      requireExactKeys(record, ["id", "kind", "pointer", "type"], label);
      return Object.freeze({
        id,
        kind: "json-type",
        pointer: pointer(record.get("pointer"), label),
        type: jsonType(record.get("type"), label),
      });
    case "json-equals":
      requireExactKeys(record, ["id", "kind", "pointer", "value"], label);
      return Object.freeze({
        id,
        kind: "json-equals",
        pointer: pointer(record.get("pointer"), label),
        value: primitive(record.get("value"), label),
      });
    default:
      return invalidPlan(`${label} kind is not supported.`);
  }
}

/**
 * Validates and freezes a fixed checker plan. The digest covers the fixed
 * checker identity plus conditions in their retained order; input property
 * order does not affect it.
 */
export function createNativeTextCheckPlan(input: unknown): NativeTextCheckPlan {
  const record = readRecord(input, "plan", MAX_CHECK_PLAN_KEYS);
  requireExactKeys(record, ["conditions"], "plan");
  const values = conditionValues(record.get("conditions"));
  const conditions: NativeTextCheckCondition[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const condition = normalizeCondition(values[index], index);
    if (ids.has(condition.id)) invalidPlan(`condition id "${condition.id}" is duplicated.`);
    ids.add(condition.id);
    conditions.push(condition);
  }
  const frozenConditions = Object.freeze(conditions);
  let encoded: string;
  try {
    encoded = JSON.stringify({
      checkerId: NATIVE_TEXT_CHECKER_ID,
      checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
      schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
      conditions: frozenConditions,
    });
  } catch {
    return invalidPlan("conditions could not be encoded.");
  }
  const digest = createHash("sha256").update(encoded).digest("hex");
  const plan: NativeTextCheckPlan = Object.freeze({
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
    conditions: frozenConditions,
    digest,
  });
  // The limit covers the exact returned plan, including the fixed identity,
  // conditions, and digest, not just the digest payload.
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > MAX_NATIVE_TEXT_CHECK_PLAN_BYTES) {
    invalidPlan(`plan exceeds the ${MAX_NATIVE_TEXT_CHECK_PLAN_BYTES}-byte normalized limit.`);
  }
  issuedPlans.add(plan);
  return plan;
}

function isIssuedPlan(value: unknown): value is NativeTextCheckPlan {
  return typeof value === "object" && value !== null && issuedPlans.has(value as NativeTextCheckPlan);
}

function isIssuedReceipt(value: unknown): value is NativeTextCheckReceipt {
  return typeof value === "object" && value !== null && issuedReceipts.has(value as NativeTextCheckReceipt);
}

function result(id: string, pass: boolean, detail: string): NativeTextCheckConditionResult {
  return Object.freeze({ id, result: pass ? "pass" : "fail", detail });
}

function resolvePointer(root: unknown, pointerValue: string): { found: boolean; value: unknown } {
  if (pointerValue === "") return { found: true, value: root };
  let current = root;
  for (const raw of pointerValue.slice(1).split("/")) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== "object" || current === null) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function hasType(value: unknown, type: NativeJsonValueType): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** Runs the fixed checks synchronously. Text is parsed as JSON at most once. */
export function runNativeTextChecks(
  snapshot: NativeWorkspaceTextSnapshot,
  plan: NativeTextCheckPlan,
): NativeTextCheckReceipt {
  if (!isNativeWorkspaceTextSnapshot(snapshot)) {
    throw new NativeTextCheckError("Native text check snapshot was not issued by this process.");
  }
  if (!isIssuedPlan(plan)) {
    throw new NativeTextCheckError("Native text check plan was not issued by this process.");
  }
  let parsed: { readonly ok: boolean; readonly value?: unknown } | undefined;
  const parsedJson = (): { readonly ok: boolean; readonly value?: unknown } => {
    if (parsed === undefined) {
      try {
        parsed = { ok: true, value: JSON.parse(snapshot.text) };
      } catch {
        parsed = { ok: false };
      }
    }
    return parsed;
  };
  const results: NativeTextCheckConditionResult[] = [];
  for (const condition of plan.conditions) {
    switch (condition.kind) {
      case "text-includes":
        results.push(
          snapshot.text.includes(condition.value)
            ? result(condition.id, true, "condition satisfied")
            : result(condition.id, false, "required text was not found in the captured text"),
        );
        break;
      case "json-valid": {
        const document = parsedJson();
        results.push(
          document.ok
            ? result(condition.id, true, "condition satisfied")
            : result(condition.id, false, "captured text is not valid JSON"),
        );
        break;
      }
      case "json-type": {
        const document = parsedJson();
        if (!document.ok) {
          results.push(result(condition.id, false, "captured text is not valid JSON"));
          break;
        }
        const found = resolvePointer(document.value, condition.pointer);
        results.push(
          found.found && hasType(found.value, condition.type)
            ? result(condition.id, true, "condition satisfied")
            : result(condition.id, false, "JSON value did not resolve to the required type"),
        );
        break;
      }
      case "json-equals": {
        const document = parsedJson();
        if (!document.ok) {
          results.push(result(condition.id, false, "captured text is not valid JSON"));
          break;
        }
        const found = resolvePointer(document.value, condition.pointer);
        results.push(
          found.found && found.value === condition.value
            ? result(condition.id, true, "condition satisfied")
            : result(condition.id, false, "JSON value did not equal the required primitive"),
        );
        break;
      }
    }
  }
  const conditions = Object.freeze(results);
  const outcome = conditions.every((item) => item.result === "pass") ? "pass" : "fail";
  const receipt: NativeTextCheckReceipt = Object.freeze({
    schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    planDigest: plan.digest,
    snapshot: Object.freeze({ captureId: snapshot.captureId, file: snapshot.file }),
    conditions,
    outcome,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
  });
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > MAX_NATIVE_TEXT_CHECK_RECEIPT_BYTES) {
    throw new NativeTextCheckError(`Native text check receipt exceeds ${MAX_NATIVE_TEXT_CHECK_RECEIPT_BYTES} bytes.`);
  }
  receiptPlans.set(receipt, plan);
  issuedReceipts.add(receipt);
  return receipt;
}

function sameFileFacts(left: Readonly<NativeObservedFile>, right: Readonly<NativeObservedFile>): boolean {
  return left.relativePath === right.relativePath
    && left.bytes === right.bytes
    && left.sha256 === right.sha256
    && left.observedAt === right.observedAt;
}

/**
 * Proves only that this authentic receipt was issued for this authentic
 * historical snapshot and the exact original plan object. A separately
 * created plan with identical conditions and digest does not match. It never
 * checks the live filesystem, so the same snapshot continues to match its old
 * receipt after the file changes, while a later capture of identical bytes has
 * another captureId and cannot replace the old capture behind that receipt.
 */
export function matchesNativeTextCheckReceipt(
  receipt: unknown,
  snapshot: unknown,
  plan: unknown,
): boolean {
  if (
    !isIssuedReceipt(receipt)
    || !isNativeWorkspaceTextSnapshot(snapshot)
    || !isIssuedPlan(plan)
  ) {
    return false;
  }
  if (receiptPlans.get(receipt) !== plan) return false;
  return receipt.schemaVersion === NATIVE_TEXT_CHECK_SCHEMA_VERSION
    && receipt.checkerId === NATIVE_TEXT_CHECKER_ID
    && receipt.checkerVersion === NATIVE_TEXT_CHECKER_VERSION
    && plan.checkerId === NATIVE_TEXT_CHECKER_ID
    && plan.checkerVersion === NATIVE_TEXT_CHECKER_VERSION
    && receipt.planDigest === plan.digest
    && receipt.snapshot.captureId === snapshot.captureId
    && sameFileFacts(receipt.snapshot.file, snapshot.file);
}
