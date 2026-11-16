import { Buffer } from "node:buffer";
import type { NativeContext, NativeToolResult, ReportOutcome } from "./native-entry.ts";
import {
  createNativeHarnessReportFailure,
  readNativeHarnessReportSelection,
  type NativeHarnessReportBindingFailure,
  type NativeHarnessReportBindingResult,
  type NativeHarnessReportFailureCode,
  type NativeHarnessReportRequest,
  type NativeHarnessReportSelection,
} from "./native-harness-report.ts";
import { fingerprintNativeJson } from "./native-instance-result.ts";
import { deepFreeze } from "./native-work.ts";

/**
 * Finite protocol helpers for routing one explicit Harness report branch.
 *
 * The port is trusted host composition: actual preparation, authentication,
 * refresh/revalidate/reread and publication remain outside this module. The
 * selected-input helper snapshots only the fixed report shape, returns owned
 * data for the existing parser and fingerprintNativeJson, and never retains a
 * caller reference. It is not a generic JSON walker, sandbox, or authority.
 */

/** Complete UTF-8 bound of the final NativeToolResult wire, content+details. */
export const NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES = 256 * 1024;
/** Mirrors the existing report parser's fixed selection budgets. */
export const NATIVE_HARNESS_REPORT_MAX_CHECKS = 24;
export const NATIVE_HARNESS_REPORT_MAX_SUMMARY_CHARS = 2000;
export const NATIVE_HARNESS_REPORT_MAX_LIMITATIONS = 8;
/**
 * Raw allocation ceiling for purpose/limitation strings. Existing parser trim
 * and semantic limits still apply after parsing; this is not a 500-char rule.
 */
export const NATIVE_HARNESS_REPORT_MAX_DECLARED_RAW_CHARS = 64 * 1024;

const MAX_TOOL_CALL_ID_CHARS = 256;
const TOP_LEVEL_KEYS = Object.freeze([
  "action",
  "checks",
  "outputFiles",
  "outcome",
  "summary",
  "limitations",
  "harnessResult",
] as const);
const CHECK_KEYS = Object.freeze(["toolCallId", "purpose"] as const);
const OUTCOMES: readonly ReportOutcome[] = Object.freeze(["completed", "insufficient", "blocked"]);

/**
 * Trusted, synchronous host seam. No registration or invocation occurs here.
 * A configured implementation authenticates and prepares the accepted A3
 * request; its signal/context are the actual ones owned by the caller.
 */
export interface NativeHarnessReportPort {
  prepare(
    request: NativeHarnessReportRequest,
    actualSignal: unknown,
    actualContext: NativeContext,
  ): NativeHarnessReportBindingResult;
}

export interface NativeHarnessReportOwnedCheck {
  readonly toolCallId: string;
  readonly purpose: string;
}

/**
 * Complete owned report arguments, including the exact original selector. This
 * is the graph fingerprinted as the actual execute input. The selector is the
 * normalized frozen copy from the shared reader: same strings and raw id order,
 * never a default, trimmed or caller-retained value. B2b2 still parses only
 * supported report fields from this owned graph and keeps the selector separate.
 */
export interface NativeHarnessReportOwnedInput {
  readonly action: "report";
  readonly outcome: ReportOutcome;
  readonly checks?: readonly NativeHarnessReportOwnedCheck[];
  readonly outputFiles?: readonly string[];
  readonly summary?: string;
  readonly limitations?: readonly string[];
  readonly harnessResult: NativeHarnessReportSelection;
}

export interface NativeHarnessReportInputFingerprint {
  readonly bytes: number;
  readonly sha256: string;
}

export type NativeHarnessReportInputRead =
  | { readonly state: "ordinary" }
  | (NativeHarnessReportBindingFailure & { readonly state: "invalid" })
  | {
      readonly state: "selected";
      readonly input: NativeHarnessReportOwnedInput;
      readonly fingerprint: NativeHarnessReportInputFingerprint;
      readonly selection: NativeHarnessReportSelection;
    };

export type NativeHarnessReportWireBound =
  | { readonly ok: true; readonly wire: NativeToolResult; readonly bytes: number }
  | NativeHarnessReportBindingFailure;

const ORDINARY = Object.freeze({ state: "ordinary" as const });

function invalid(
  refusal: NativeHarnessReportBindingFailure,
): NativeHarnessReportBindingFailure & { readonly state: "invalid" } {
  return Object.freeze({ state: "invalid" as const, ...refusal });
}

function refuse(
  reason: string,
  code: NativeHarnessReportFailureCode = "invalid-caller",
): NativeHarnessReportBindingFailure & { readonly state: "invalid" } {
  return invalid(createNativeHarnessReportFailure(code, reason));
}

type FieldsRead =
  | { readonly ok: true; readonly fields: Map<string, unknown> }
  | NativeHarnessReportBindingFailure;

/**
 * Exact own enumerable data fields on an ordinary or null-prototype object.
 * Symbols, accessors, unknown keys and failed reflection are refused.
 */
function readExactOwnedFields(
  value: unknown,
  keys: readonly string[],
  shape: string,
): FieldsRead {
  try {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      return refuse(`${shape} could not be inspected`);
    }
    if (isArray || typeof value !== "object" || value === null) {
      return refuse(`${shape} must be a plain object`);
    }
    let prototype: object | null;
    let ownKeys: (string | symbol)[];
    try {
      prototype = Object.getPrototypeOf(value);
      ownKeys = Reflect.ownKeys(value);
    } catch {
      return refuse(`${shape} could not be inspected`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return refuse(`${shape} must be a plain own-data object`);
    }
    if (ownKeys.length !== keys.length) {
      return refuse(`${shape} must contain exactly ${keys.join(", ")}`);
    }
    const fields = new Map<string, unknown>();
    for (const key of ownKeys) {
      if (typeof key !== "string" || !keys.includes(key)) {
        return refuse(`${shape} must contain only its fixed string fields`);
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return refuse(`${shape} fields could not be inspected`);
      }
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true
      ) {
        return refuse(`${shape} fields must be own enumerable data properties`);
      }
      fields.set(key, descriptor.value);
    }
    for (const key of keys) {
      if (!fields.has(key)) return refuse(`${shape} is missing ${key}`);
    }
    return { ok: true, fields };
  } catch {
    return refuse(`${shape} could not be inspected`);
  }
}

type DataArrayRead =
  | { readonly ok: true; readonly items: readonly unknown[] }
  | NativeHarnessReportBindingFailure;

/**
 * Ordinary dense array with exact index keys plus length. Holes, extra string
 * or symbol keys, accessors, exotic prototypes and failed reflection refuse.
 */
function readDenseOwnedArray(value: unknown, maximum: number, shape: string): DataArrayRead {
  try {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      return refuse(`${shape} could not be inspected`);
    }
    if (!isArray) return refuse(`${shape} must be an array`);
    const array = value as object;
    let prototype: object | null;
    let length: unknown;
    try {
      prototype = Object.getPrototypeOf(array);
      const descriptor = Object.getOwnPropertyDescriptor(array, "length");
      length = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      return refuse(`${shape} could not be inspected`);
    }
    if (prototype !== Array.prototype) {
      return refuse(`${shape} must be an ordinary dense array`);
    }
    if (
      typeof length !== "number"
      || !Number.isSafeInteger(length)
      || length < 0
      || length > maximum
    ) {
      return refuse(`${shape} must contain at most ${maximum} elements`);
    }
    let ownKeys: (string | symbol)[];
    try {
      ownKeys = Reflect.ownKeys(array);
    } catch {
      return refuse(`${shape} could not be inspected`);
    }
    if (ownKeys.length !== length + 1) {
      return refuse(`${shape} must be a dense array without extra keys`);
    }
    const ownKeySet = new Set(ownKeys);
    if (!ownKeySet.has("length")) {
      return refuse(`${shape} must be a dense array without extra keys`);
    }
    for (let index = 0; index < length; index++) {
      if (!ownKeySet.has(String(index))) {
        return refuse(`${shape} must be a dense array with exact index keys`);
      }
    }
    const items: unknown[] = [];
    for (let index = 0; index < length; index++) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        return refuse(`${shape} elements could not be inspected`);
      }
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.get !== undefined
        || descriptor.set !== undefined
        || descriptor.enumerable !== true
      ) {
        return refuse(`${shape} must be dense own data elements`);
      }
      items.push(descriptor.value);
    }
    return { ok: true, items };
  } catch {
    return refuse(`${shape} could not be inspected`);
  }
}

function boundedId(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TOOL_CALL_ID_CHARS) {
    return null;
  }
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

function defineOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

interface SelectedOuter {
  readonly fields: Map<string, unknown>;
}

/**
 * One outer observation decides the branch. An absent own `harnessResult`
 * returns ordinary immediately; all other shape work happens only for an
 * explicit own selector, after its descriptor was captured exactly once.
 */
function readSelectedOuter(
  value: unknown,
): { readonly state: "ordinary" } | SelectedOuter | (NativeHarnessReportBindingFailure & { readonly state: "invalid" }) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return ORDINARY;
  }
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return refuse("the report arguments could not be inspected");
  }
  let selected = false;
  for (const key of ownKeys) {
    if (key === "harnessResult") {
      selected = true;
      break;
    }
  }
  if (!selected) return ORDINARY;
  if (ownKeys.length > TOP_LEVEL_KEYS.length) {
    return refuse("the selected report has an unsupported field");
  }

  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return refuse("the report arguments could not be inspected");
  }
  if (isArray || typeof value !== "object" || (prototype !== Object.prototype && prototype !== null)) {
    return refuse("the report arguments must be a plain object with an explicit harnessResult");
  }

  const fields = new Map<string, unknown>();
  for (const key of ownKeys) {
    if (typeof key !== "string" || !(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      return refuse("the selected report has an unsupported field");
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!ownKeys.includes(key)) continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return refuse("the selected report fields could not be inspected");
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return refuse("the selected report fields must be own enumerable data properties");
    }
    fields.set(key, descriptor.value);
  }
  return { fields };
}

function readOwnedChecks(value: unknown): {
  readonly ok: true;
  readonly checks: readonly NativeHarnessReportOwnedCheck[];
} | NativeHarnessReportBindingFailure {
  const read = readDenseOwnedArray(value, NATIVE_HARNESS_REPORT_MAX_CHECKS, "checks");
  if (!read.ok) return read;
  const checks: NativeHarnessReportOwnedCheck[] = [];
  for (let index = 0; index < read.items.length; index++) {
    const item = readExactOwnedFields(read.items[index], CHECK_KEYS, `checks[${index}]`);
    if (!item.ok) return item;
    const toolCallId = boundedId(item.fields.get("toolCallId"));
    if (toolCallId === null) {
      return refuse(`checks[${index}].toolCallId must be a bounded non-control string`);
    }
    const purpose = item.fields.get("purpose");
    if (typeof purpose !== "string" || purpose.length > NATIVE_HARNESS_REPORT_MAX_DECLARED_RAW_CHARS) {
      return refuse(`checks[${index}].purpose must be bounded raw text`);
    }
    checks.push(Object.freeze({ toolCallId, purpose }));
  }
  return { ok: true, checks: Object.freeze(checks) };
}

function readOwnedLimitations(value: unknown): {
  readonly ok: true;
  readonly limitations: readonly string[];
} | NativeHarnessReportBindingFailure {
  const read = readDenseOwnedArray(
    value,
    NATIVE_HARNESS_REPORT_MAX_LIMITATIONS,
    "limitations",
  );
  if (!read.ok) return read;
  const limitations: string[] = [];
  for (let index = 0; index < read.items.length; index++) {
    const item = read.items[index];
    if (typeof item !== "string" || item.length > NATIVE_HARNESS_REPORT_MAX_DECLARED_RAW_CHARS) {
      return refuse(`limitations[${index}] must be bounded raw text`);
    }
    limitations.push(item);
  }
  return { ok: true, limitations: Object.freeze(limitations) };
}

/**
 * Detects and snapshots one explicit `harnessResult` report branch. No own
 * selector returns `ordinary`; the legacy parser is not reproduced here.
 * Explicit undefined/null/accessor/non-enumerable/malformed selectors refuse.
 *
 * Optional fields are accepted only when absent or of their exact type. The
 * new selected profile refuses explicit undefined/null rather than treating
 * them as omission; legacy ordinary compatibility is untouched. `outputFiles`
 * must be absent or exactly `[]`. Raw strings, presence and the exact original
 * selector are preserved, no defaults are injected, and the final fingerprint
 * is computed from this complete owned graph with the existing bounded
 * canonical encoder.
 */
export function readNativeHarnessReportSelectedInput(value: unknown): NativeHarnessReportInputRead {
  try {
    const outer = readSelectedOuter(value);
    if ("state" in outer) return outer;
    const fields = outer.fields;

    if (fields.get("action") !== "report") {
      return refuse("a selected report action must be report");
    }
    const outcome = fields.get("outcome");
    if (typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) {
      return refuse("a selected report outcome must be completed, insufficient or blocked");
    }

    let checks: readonly NativeHarnessReportOwnedCheck[] | undefined;
    if (fields.has("checks")) {
      const read = readOwnedChecks(fields.get("checks"));
      if (!read.ok) return invalid(read);
      checks = read.checks;
    }

    let outputFiles: readonly string[] | undefined;
    if (fields.has("outputFiles")) {
      const read = readDenseOwnedArray(fields.get("outputFiles"), 0, "outputFiles");
      if (!read.ok || read.items.length !== 0) {
        return refuse("outputFiles must be absent or an explicitly empty array");
      }
      outputFiles = Object.freeze([]);
    }

    let summary: string | undefined;
    if (fields.has("summary")) {
      const raw = fields.get("summary");
      if (
        typeof raw !== "string"
        || raw.length > NATIVE_HARNESS_REPORT_MAX_SUMMARY_CHARS
      ) {
        return refuse(
          `summary must be raw text of at most ${NATIVE_HARNESS_REPORT_MAX_SUMMARY_CHARS} characters`,
        );
      }
      summary = raw;
    }

    let limitations: readonly string[] | undefined;
    if (fields.has("limitations")) {
      const read = readOwnedLimitations(fields.get("limitations"));
      if (!read.ok) return invalid(read);
      limitations = read.limitations;
    }

    const selection = readNativeHarnessReportSelection(fields.get("harnessResult"));
    if (!selection.ok) return invalid(selection);

    const owned: Record<string, unknown> = Object.create(null);
    defineOwn(owned, "action", "report");
    defineOwn(owned, "outcome", outcome);
    if (checks !== undefined) defineOwn(owned, "checks", checks);
    if (outputFiles !== undefined) defineOwn(owned, "outputFiles", outputFiles);
    if (summary !== undefined) defineOwn(owned, "summary", summary);
    if (limitations !== undefined) defineOwn(owned, "limitations", limitations);
    defineOwn(owned, "harnessResult", selection.selection);
    const input = deepFreeze(owned) as unknown as NativeHarnessReportOwnedInput;

    const fingerprint = fingerprintNativeJson(input);
    if (!fingerprint.ok) {
      return refuse(
        `the selected report input exceeds the bounded canonical encoding (${fingerprint.reason})`,
        "too-large",
      );
    }

    return Object.freeze({
      state: "selected" as const,
      input,
      fingerprint: Object.freeze({ bytes: fingerprint.bytes, sha256: fingerprint.sha256 }),
      selection: selection.selection,
    });
  } catch {
    return refuse("the selected report input could not be inspected");
  }
}

/**
 * Measures the complete actual JSON/UTF-8 encoding of an already constructed
 * report wire, counting both content and duplicated details. Success returns
 * the same supplied wire and exact byte count; overflow is one bounded refusal
 * with no truncation, cap change or mutation. This helper publishes nothing.
 */
export function boundNativeHarnessReportWire(wire: NativeToolResult): NativeHarnessReportWireBound {
  let encoded: string;
  try {
    const serialized = JSON.stringify(wire);
    if (typeof serialized !== "string") {
      return createNativeHarnessReportFailure(
        "invalid-caller",
        "the report tool wire is not JSON-encodable",
      );
    }
    encoded = serialized;
  } catch {
    return createNativeHarnessReportFailure(
      "invalid-caller",
      "the report tool wire could not be encoded",
    );
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(encoded, "utf8");
  } catch {
    return createNativeHarnessReportFailure(
      "invalid-caller",
      "the report tool wire byte size could not be measured",
    );
  }
  if (bytes > NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES) {
    return createNativeHarnessReportFailure(
      "too-large",
      `the complete report tool wire exceeds ${NATIVE_HARNESS_REPORT_MAX_WIRE_BYTES} UTF-8 bytes`,
    );
  }
  return Object.freeze({ ok: true as const, wire, bytes });
}
