import { Buffer } from "node:buffer";
import type { NativeContext, NativeToolResult } from "./native-entry.ts";
import {
  NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES,
  NATIVE_HARNESS_RESULT_TOOL,
  normalizeNativeHarnessCaptureInput,
  normalizeNativeHarnessCheckInput,
  normalizeNativeHarnessInspectInput,
  normalizeNativeHarnessReadInput,
  type NativeHarnessCaptureInput,
  type NativeHarnessCheckInput,
  type NativeHarnessCheckOutcome,
  type NativeHarnessCheckSuccess,
  type NativeHarnessInspectInput,
  type NativeHarnessReadInput,
} from "./native-harness-checks.ts";
import type {
  NativeHarnessDelegationCoordinator,
  NativeHarnessOutputCatalog,
  NativeHarnessOutputCatalogSuccess,
  NativeHarnessOutputSelection,
  NativeHarnessOutputSelectionSuccess,
  NativeHarnessReadSelection,
  NativeHarnessReadSuccess,
} from "./native-harness-delegation.ts";
import type {
  NativeHarnessResolvedRoot,
  NativeHarnessRootResolution,
} from "./native-harness-entry.ts";
import { fingerprintExpectedCallResult } from "./native-result-expectation.ts";
import { deepFreeze } from "./native-work.ts";

/**
 * Bounded `agent_harness_result` tool adapter.
 *
 * This leaf owns no scheduler, capture registry, checker, observer or root
 * state. It snapshots the caller input once, reuses the existing normalizers
 * and coordinator operations, and projects one public JSON text payload. The
 * trusted root and coordinator still own authority, retention and tracking.
 */

export const NATIVE_HARNESS_RESULT_ENTRY_SCHEMA = "omp-agent.native-harness-result-entry.v1";
export const NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA = "omp-agent.native-harness-result-payload.v1";
export const MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES = 256 * 1024;

const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_REASON_CHARS = 320;
const MAX_CALLER_FIELDS = 6;
const CALLER_FIELDS = Object.freeze([
  "action",
  "sourceToolCallId",
  "captureId",
  "captureDigest",
  "path",
  "conditions",
] as const);

type ResultAction = "inspect" | "capture" | "read" | "check";
type ResultFailureCode =
  | "disposed"
  | "invalid-input"
  | "invalid-context"
  | "signal-unavailable"
  | "cancelled"
  | "root-unavailable"
  | "coordinator-refused"
  | "encoding-overflow"
  | "encoding-failure";

interface PublicSelectors {
  readonly sourceToolCallId: string;
  readonly captureId?: string;
  readonly captureDigest?: string;
  readonly path?: string;
}

interface ResultErrorPayload {
  readonly schema: typeof NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly action: ResultAction | null;
  readonly ok: false;
  readonly authority: "non-authoritative";
  readonly error: {
    readonly code: ResultFailureCode;
    readonly reason: string;
  };
  readonly selectors?: PublicSelectors;
  readonly bytes?: number;
  readonly limit?: number;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

interface CaptureFilePayload {
  readonly path: string;
  readonly kind: "add" | "modify";
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
  readonly fileSnapshotId: string;
}

interface CaptureSuccessPayload {
  readonly schema: typeof NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly action: "capture";
  readonly ok: true;
  readonly authority: "non-authoritative";
  readonly sourceToolCallId: string;
  readonly actionToolCallId: string;
  readonly captureId: string;
  readonly captureDigest: string;
  readonly origin: {
    readonly kind: "harness2-native";
    readonly observation: "captured-now" | "cached-historical";
    readonly filesystemFreshness: "observed-during-capture" | "not-rechecked";
    readonly observedAt: number;
  };
  readonly files: readonly CaptureFilePayload[];
  readonly limitations: readonly string[];
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

interface CheckConditionPayload {
  readonly id: string;
  readonly result: "pass" | "fail";
  readonly detail: string;
}

interface CheckSuccessPayload {
  readonly schema: typeof NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly action: "check";
  readonly ok: true;
  readonly authority: "non-authoritative";
  readonly sourceToolCallId: string;
  readonly actionToolCallId: string;
  readonly originalComputationToolCallId: string;
  readonly selectors: PublicSelectors;
  readonly checker: {
    readonly id: string;
    readonly version: string;
  };
  readonly plan: {
    readonly source: "model-proposed-after-capture";
    readonly digest: string;
  };
  readonly receipt: {
    readonly schemaVersion: number;
    readonly checkerId: string;
    readonly checkerVersion: string;
    readonly planDigest: string;
    readonly fileSnapshotId: string;
    readonly file: {
      readonly relativePath: string;
      readonly bytes: number;
      readonly sha256: string;
      readonly observedAt: number;
    };
    readonly conditions: readonly CheckConditionPayload[];
    readonly outcome: "pass" | "fail";
    readonly taskAccepted: false;
    readonly semanticAcceptance: "not-evaluated";
  };
  readonly observation: "cached-historical";
  readonly filesystemFreshness: "not-rechecked";
  readonly limitations: readonly string[];
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

interface ReadSuccessPayload {
  readonly schema: typeof NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly action: "read";
  readonly ok: true;
  readonly authority: "non-authoritative";
  readonly sourceToolCallId: string;
  readonly actionToolCallId: string;
  readonly selectors: PublicSelectors;
  readonly fileSnapshotId: string;
  readonly file: {
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly observedAt: number;
  };
  readonly text: string;
  readonly observation: "cached-historical";
  readonly filesystemFreshness: "not-rechecked";
  readonly limitations: readonly string[];
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

interface InspectFilePayload {
  readonly path: string;
  readonly kind: "add" | "modify";
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
}

interface InspectRowPayload {
  readonly sourceToolCallId: string;
  readonly outputState: "idle" | "captured";
  readonly capture: {
    readonly captureId: string;
    readonly captureDigest: string;
    readonly files: readonly InspectFilePayload[];
  } | null;
}

interface InspectSuccessPayload {
  readonly schema: typeof NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA;
  readonly tool: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly action: "inspect";
  readonly ok: true;
  readonly authority: "non-authoritative";
  readonly scope: "retained-sources-in-this-root";
  readonly scanComplete: true;
  readonly retainedSources: number;
  readonly returnedSources: number;
  readonly excludedNotReady: number;
  readonly excludedUnavailable: number;
  readonly rows: readonly InspectRowPayload[];
  readonly limitations: readonly string[];
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
}

type SuccessPayload =
  | CaptureSuccessPayload
  | CheckSuccessPayload
  | ReadSuccessPayload
  | InspectSuccessPayload;

interface NormalizedAction {
  readonly action: ResultAction;
  readonly input:
    | NativeHarnessCaptureInput
    | NativeHarnessCheckInput
    | NativeHarnessReadInput
    | NativeHarnessInspectInput;
}

interface ResultLifecycle {
  disposed: boolean;
}

interface EncodedWire {
  readonly wire: NativeToolResult;
  readonly bytes: number;
  readonly overflow: boolean;
  readonly failed: boolean;
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

const CONDITION_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        kind: { const: "text-includes" },
        value: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["id", "kind", "value"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        kind: { const: "json-valid" },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        kind: { const: "json-type" },
        pointer: { type: "string", maxLength: 1024 },
        type: {
          type: "string",
          enum: ["null", "boolean", "number", "string", "array", "object"],
        },
      },
      required: ["id", "kind", "pointer", "type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 128 },
        kind: { const: "json-equals" },
        pointer: { type: "string", maxLength: 1024 },
        value: { type: ["null", "boolean", "number", "string"] },
      },
      required: ["id", "kind", "pointer", "value"],
      additionalProperties: false,
    },
  ],
} as const;

const SOURCE_SELECTOR_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: MAX_TOOL_CALL_ID_CHARS,
  description: "Exact actual agent_harness tool call ID; never a run ID or result action ID.",
} as const;

const CAPTURE_SELECTOR_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 256,
} as const;

const CAPTURE_DIGEST_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
} as const;

const RESULT_PATH_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description: "Workspace-relative POSIX path from the selected capture.",
} as const;

const AGENT_HARNESS_RESULT_PARAMETERS = {
  type: "object",
  description: "Non-authoritative retained-output operations over actual agent_harness calls.",
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "inspect" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "capture" },
        sourceToolCallId: SOURCE_SELECTOR_SCHEMA,
      },
      required: ["action", "sourceToolCallId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "read" },
        sourceToolCallId: SOURCE_SELECTOR_SCHEMA,
        captureId: CAPTURE_SELECTOR_SCHEMA,
        captureDigest: CAPTURE_DIGEST_SCHEMA,
        path: RESULT_PATH_SCHEMA,
      },
      required: ["action", "sourceToolCallId", "captureId", "captureDigest", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "check" },
        sourceToolCallId: SOURCE_SELECTOR_SCHEMA,
        captureId: CAPTURE_SELECTOR_SCHEMA,
        captureDigest: CAPTURE_DIGEST_SCHEMA,
        path: RESULT_PATH_SCHEMA,
        conditions: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: CONDITION_SCHEMA,
          description: "Model-proposed fixed checker conditions; the existing checker is the sole validator and plan freezer.",
        },
      },
      required: ["action", "sourceToolCallId", "captureId", "captureDigest", "path", "conditions"],
      additionalProperties: false,
    },
  ],
} as const;

const RESULT_DESCRIPTION = [
  "Read retained private output from one actual agent_harness call and optionally run the fixed historical checker.",
  "sourceToolCallId is the original actual agent_harness tool call ID, not its run ID and not a result action ID.",
  "inspect lists eligible source and capture selectors; capture returns exact file and version selectors; read returns one historical captured file and is optional before fixed checking; check runs only the listed fixed conditions over the retained capture.",
  "A listed-condition PASS is not task acceptance, semantic acceptance or comprehensive coverage.",
  "This tool starts no Harness workers; actual worker execution remains agent_harness with its existing exec approval. It exposes no report endpoint, commands or manual procedure.",
].join(" ");

const FIXED_FALLBACK_TEXT = JSON.stringify({
  schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
  tool: NATIVE_HARNESS_RESULT_TOOL,
  action: null,
  ok: false,
  authority: "non-authoritative",
  error: {
    code: "encoding-failure",
    reason: "the bounded result response could not be encoded",
  },
  taskAccepted: false,
  semanticAcceptance: "not-evaluated",
} satisfies ResultErrorPayload);

const FIXED_FALLBACK_WIRE: NativeToolResult = deepFreeze({
  content: [{ type: "text" as const, text: FIXED_FALLBACK_TEXT }],
  isError: true,
});

const FIXED_FALLBACK_BYTES = Buffer.byteLength(JSON.stringify(FIXED_FALLBACK_WIRE), "utf8");

export interface NativeHarnessResultTool {
  readonly name: typeof NATIVE_HARNESS_RESULT_TOOL;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly approval: "read";
  readonly loadMode: "discoverable";
  readonly defaultInactive: true;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: NativeContext,
  ): Promise<NativeToolResult>;
}

export interface NativeHarnessResultEntryOptions {
  resolveRoot(context: NativeContext): NativeHarnessRootResolution;
}

export interface NativeHarnessResultEntry {
  readonly tool: NativeHarnessResultTool;
  /** Releases only this adapter; never disposes the trusted root coordinator. */
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueRef(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, max: number): string {
  const raw = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const normalized = raw.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function publicReason(value: unknown): string {
  const text = typeof value === "string" ? value : "the result operation was refused";
  return boundedText(text, MAX_REASON_CHARS)
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`<>]+/g, "[path]")
    .replace(/\b(?:api[_-]?key|token|secret|authorization)\b[^\s,;]*/gi, "[redacted]");
}

function boundedId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_TOOL_CALL_ID_CHARS
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function readActualAbortSignal(signal: unknown):
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string } {
  if (signal === undefined || signal === null) {
    return { ok: false, reason: "the actual host AbortSignal is missing" };
  }
  if (ACTUAL_ABORTED_GETTER === null) {
    return { ok: false, reason: "the host AbortSignal aborted getter is unavailable" };
  }
  try {
    const aborted: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    if (typeof aborted !== "boolean") {
      return { ok: false, reason: "the host AbortSignal aborted state is unreadable" };
    }
    return { ok: true, aborted };
  } catch {
    return { ok: false, reason: "the supplied signal is not a readable actual host AbortSignal" };
  }
}

function isActualMainContext(context: unknown): boolean {
  try {
    return typeof context === "object"
      && context !== null
      && (context as NativeContext).agent?.kind === "main";
  } catch {
    return false;
  }
}

function snapshotCallerInput(value: unknown):
  | { readonly ok: true; readonly action: ResultAction; readonly owned: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "agent_harness_result input must be a plain own-data object" };
  }
  let array: boolean;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return { ok: false, reason: "the result input could not be inspected" };
  }
  if (array) {
    return { ok: false, reason: "the result input must be a plain object" };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "the result input must be a plain object" };
  }
  if (keys.length > MAX_CALLER_FIELDS) {
    return { ok: false, reason: `the result input must have at most ${MAX_CALLER_FIELDS} own data fields` };
  }
  const owned: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !(CALLER_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: "the result input contains a symbol or unknown field" };
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return { ok: false, reason: "the result input fields could not be inspected" };
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return { ok: false, reason: "the result input must contain only enumerable own data properties" };
    }
    owned[key] = descriptor.value;
  }
  const action = owned.action;
  if (action !== "inspect" && action !== "capture" && action !== "read" && action !== "check") {
    return { ok: false, reason: "the result input action must be inspect, capture, read or check" };
  }
  return { ok: true, action, owned: Object.freeze(owned) };
}

function normalizedAction(
  action: ResultAction,
  owned: Readonly<Record<string, unknown>>,
):
  | { readonly ok: true; readonly value: NormalizedAction }
  | { readonly ok: false; readonly reason: string } {
  let value:
    | ReturnType<typeof normalizeNativeHarnessCaptureInput>
    | ReturnType<typeof normalizeNativeHarnessCheckInput>
    | ReturnType<typeof normalizeNativeHarnessReadInput>
    | ReturnType<typeof normalizeNativeHarnessInspectInput>;
  try {
    switch (action) {
      case "capture":
        value = normalizeNativeHarnessCaptureInput(owned);
        break;
      case "read":
        value = normalizeNativeHarnessReadInput(owned);
        break;
      case "check":
        value = normalizeNativeHarnessCheckInput(owned);
        break;
      case "inspect":
        value = normalizeNativeHarnessInspectInput(owned);
        break;
    }
  } catch {
    return { ok: false, reason: "the result input could not be normalized" };
  }
  if (!value.ok) return { ok: false, reason: publicReason(value.reason) };
  return { ok: true, value: Object.freeze({ action, input: value.input }) };
}

function selectorsOf(input: NormalizedAction["input"]): PublicSelectors | undefined {
  if (input.action === "inspect") return undefined;
  if (input.action === "capture") {
    return Object.freeze({ sourceToolCallId: input.sourceToolCallId });
  }
  return Object.freeze({
    sourceToolCallId: input.sourceToolCallId,
    captureId: input.captureId,
    captureDigest: input.captureDigest,
    path: input.path,
  });
}

function makeWire(payload: unknown, isError: boolean): NativeToolResult {
  const text = JSON.stringify(payload);
  return deepFreeze({
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  });
}

function encodeWire(payload: unknown, isError: boolean): EncodedWire {
  try {
    const wire = makeWire(payload, isError);
    const bytes = Buffer.byteLength(JSON.stringify(wire), "utf8");
    if (bytes > MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES) {
      return {
        wire: FIXED_FALLBACK_WIRE,
        bytes,
        overflow: true,
        failed: false,
      };
    }
    return { wire, bytes, overflow: false, failed: false };
  } catch {
    return {
      wire: FIXED_FALLBACK_WIRE,
      bytes: FIXED_FALLBACK_BYTES,
      overflow: false,
      failed: true,
    };
  }
}

function errorPayload(
  action: ResultAction | null,
  code: ResultFailureCode,
  reason: string,
  selectors?: PublicSelectors,
  bytes?: number,
  limit?: number,
): ResultErrorPayload {
  return Object.freeze({
    schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
    tool: NATIVE_HARNESS_RESULT_TOOL,
    action,
    ok: false as const,
    authority: "non-authoritative" as const,
    error: Object.freeze({ code, reason: publicReason(reason) }),
    ...(selectors === undefined ? {} : { selectors }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(limit === undefined ? {} : { limit }),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function failureWire(
  action: ResultAction | null,
  code: ResultFailureCode,
  reason: string,
  selectors?: PublicSelectors,
  bytes?: number,
  limit?: number,
): NativeToolResult {
  const encoded = encodeWire(errorPayload(action, code, reason, selectors, bytes, limit), true);
  return encoded.wire;
}

function rejectedTrackingPromise(reason: string): Promise<never> {
  const rejected = Promise.reject(new Error(reason));
  // The trusted root normally tracks this exact promise. If a malformed or
  // throwing scope does not, the bounded tool result still must not leak an
  // unhandled rejection.
  void rejected.catch(() => undefined);
  return rejected;
}

function overflowWire(
  action: ResultAction,
  input: NormalizedAction["input"],
  attemptedBytes: number,
): NativeToolResult {
  return failureWire(
    action,
    "encoding-overflow",
    `the complete bounded result response exceeds ${MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES} UTF-8 bytes`,
    selectorsOf(input),
    attemptedBytes,
    MAX_NATIVE_HARNESS_RESULT_WIRE_BYTES,
  );
}

function expectationAllows(
  input: NormalizedAction["input"],
  wire: NativeToolResult,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  try {
    const expected = fingerprintExpectedCallResult({ input, result: wire });
    if (!expected.ok) {
      return { ok: false, reason: `the successful result projection could not be fingerprinted: ${expected.reason}` };
    }
    if (expected.fingerprint.bytes > NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES) {
      return {
        ok: false,
        reason: `the successful result projection envelope exceeds ${NATIVE_HARNESS_MAX_CHECK_METADATA_BYTES} bytes`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "the successful result projection could not be fingerprinted" };
  }
}

function readRootResolution(
  resolveRoot: (context: NativeContext) => NativeHarnessRootResolution,
  context: NativeContext,
  action: ResultAction,
): { readonly ok: true; readonly root: NativeHarnessResolvedRoot } | { readonly ok: false; readonly reason: string } {
  let raw: unknown;
  try {
    raw = resolveRoot(context);
  } catch {
    return { ok: false, reason: "the trusted result root resolver failed" };
  }
  try {
    if (!isRecord(raw) || typeof raw.ok !== "boolean") {
      return { ok: false, reason: "the trusted result root resolver returned no readable decision" };
    }
    if (raw.ok === false) {
      return { ok: false, reason: publicReason(raw.reason) };
    }
    const root = raw.root;
    if (!isRecord(root)
      || !isOpaqueRef(root.coordinator)
      || typeof root.runWithContext !== "function") {
      return { ok: false, reason: "the trusted result root handle is malformed" };
    }
    const methodName = action === "capture"
      ? "captureOutputForCall"
      : action === "read"
        ? "readOutputForCall"
        : action === "inspect"
          ? "inspectOutputsForCall"
          : "checkOutput";
    const method = (root.coordinator as unknown as Record<string, unknown>)[methodName];
    if (typeof method !== "function") {
      return { ok: false, reason: `the trusted result coordinator has no ${methodName} method` };
    }
    if (action === "capture"
      && typeof (root.coordinator as unknown as Record<string, unknown>).registerOutputCaptureProjection !== "function") {
      return { ok: false, reason: "the trusted result coordinator has no capture registration method" };
    }
    if (action === "check"
      && typeof (root.coordinator as unknown as Record<string, unknown>).registerOutputCheckProjection !== "function") {
      return { ok: false, reason: "the trusted result coordinator has no check registration method" };
    }
    return { ok: true, root: root as unknown as NativeHarnessResolvedRoot };
  } catch {
    return { ok: false, reason: "the trusted result root resolution could not be read" };
  }
}

function publishRefusal(
  lifecycle: ResultLifecycle,
  signal: unknown,
  action: ResultAction,
  input: NormalizedAction["input"],
): NativeToolResult | null {
  if (lifecycle.disposed) {
    return failureWire(action, "disposed", "the result entry is disposed", selectorsOf(input));
  }
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) {
    return failureWire(action, "signal-unavailable", signalRead.reason, selectorsOf(input));
  }
  if (signalRead.aborted) {
    return failureWire(action, "cancelled", "the actual result action signal was aborted", selectorsOf(input));
  }
  return null;
}

function captureLimitations(
  observation: NativeHarnessOutputSelectionSuccess["observation"],
): readonly string[] {
  return Object.freeze([
    observation === "captured-now"
      ? "the capture was created from the retained source output, not from a new worker execution"
      : "the capture is an existing historical retained response",
    "filesystem state was not rechecked after the capture",
    "capture facts are historical evidence; task acceptance and semantic acceptance are not evaluated",
    "a successful registration is pending evidence until the native tool_result observer matches or conflicts it",
  ]);
}

function checkLimitations(): readonly string[] {
  return Object.freeze([
    "the fixed checker ran over retained captured text; filesystem state was not rechecked",
    "listed-condition PASS is not task acceptance or comprehensive coverage",
    "task acceptance and semantic acceptance are not evaluated",
    "a successful registration is pending evidence until the native tool_result observer matches or conflicts it",
  ]);
}

function readLimitations(): readonly string[] {
  return Object.freeze([
    "the returned text is the historical captured snapshot, not current filesystem state",
    "reading is optional before fixed checking and is not a claim that a model read or understood the file",
    "task acceptance and semantic acceptance are not evaluated",
  ]);
}

function inspectLimitations(): readonly string[] {
  return Object.freeze([
    "the catalog covers retained sources in this root only",
    "excluded sources are counted but their selectors are not listed",
    "the catalog is not a complete history or report endpoint",
  ]);
}

function nonnegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fileFacts(value: unknown): {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly observedAt: number;
} | null {
  if (!isRecord(value)
    || typeof value.relativePath !== "string"
    || typeof value.bytes !== "number"
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0
    || typeof value.sha256 !== "string"
    || typeof value.observedAt !== "number"
    || !Number.isFinite(value.observedAt)) {
    return null;
  }
  return Object.freeze({
    relativePath: value.relativePath,
    bytes: value.bytes,
    sha256: value.sha256,
    observedAt: value.observedAt,
  });
}

function projectCapture(
  actualToolCallId: string,
  input: NativeHarnessCaptureInput,
  outcome: NativeHarnessOutputSelection,
): CaptureSuccessPayload | null {
  if (!isRecord(outcome) || outcome.ok !== true) return null;
  const capture = outcome.capture;
  if (!isRecord(capture)
    || capture.originKind !== "harness2-native"
    || typeof capture.captureId !== "string"
    || typeof capture.digest !== "string"
    || typeof capture.observedAt !== "number"
    || !Number.isFinite(capture.observedAt)
    || !Array.isArray(capture.changes)
    || !isRecord(outcome.association)
    || outcome.association.toolCallId !== input.sourceToolCallId) {
    return null;
  }
  if (outcome.observation !== "captured-now" && outcome.observation !== "cached-historical") {
    return null;
  }
  if (outcome.filesystemFreshness !== "observed-during-capture"
    && outcome.filesystemFreshness !== "not-rechecked") {
    return null;
  }
  const files: CaptureFilePayload[] = [];
  for (const change of capture.changes) {
    if (!isRecord(change)
      || (change.kind !== "add" && change.kind !== "modify")
      || typeof change.path !== "string"
      || !isRecord(change.snapshot)
      || typeof change.snapshot.captureId !== "string") {
      return null;
    }
    const file = fileFacts(change.snapshot.file);
    if (file === null || file.relativePath !== change.path) return null;
    files.push(Object.freeze({
      path: change.path,
      kind: change.kind,
      bytes: file.bytes,
      sha256: file.sha256,
      observedAt: file.observedAt,
      fileSnapshotId: change.snapshot.captureId,
    }));
  }
  return Object.freeze({
    schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
    tool: NATIVE_HARNESS_RESULT_TOOL,
    action: "capture" as const,
    ok: true as const,
    authority: "non-authoritative" as const,
    sourceToolCallId: input.sourceToolCallId,
    actionToolCallId: actualToolCallId,
    captureId: capture.captureId,
    captureDigest: capture.digest,
    origin: Object.freeze({
      kind: "harness2-native" as const,
      observation: outcome.observation,
      filesystemFreshness: outcome.filesystemFreshness,
      observedAt: capture.observedAt,
    }),
    files: Object.freeze(files),
    limitations: captureLimitations(outcome.observation),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function projectCheck(
  actualToolCallId: string,
  input: NativeHarnessCheckInput,
  outcome: NativeHarnessCheckOutcome,
): CheckSuccessPayload | null {
  if (!isRecord(outcome) || outcome.ok !== true) return null;
  const response = outcome as unknown as NativeHarnessCheckSuccess;
  if (response.action !== "check"
    || response.checkToolCallId !== actualToolCallId
    || response.sourceToolCallId !== input.sourceToolCallId
    || response.captureId !== input.captureId
    || response.captureDigest !== input.captureDigest
    || response.path !== input.path
    || typeof response.computedByToolCallId !== "string"
    || typeof response.checkerId !== "string"
    || typeof response.checkerVersion !== "string"
    || typeof response.planDigest !== "string"
    || response.planSource !== "model-proposed-after-capture"
    || response.observation !== "cached-historical"
    || response.filesystemFreshness !== "not-rechecked") {
    return null;
  }
  const receipt = response.receipt;
  if (!isRecord(receipt)
    || typeof receipt.schemaVersion !== "number"
    || receipt.checkerId !== response.checkerId
    || receipt.checkerVersion !== response.checkerVersion
    || receipt.planDigest !== response.planDigest
    || (receipt.outcome !== "pass" && receipt.outcome !== "fail")
    || !isRecord(receipt.snapshot)
    || typeof receipt.snapshot.captureId !== "string"
    || !Array.isArray(receipt.conditions)) {
    return null;
  }
  const file = fileFacts(receipt.snapshot.file);
  if (file === null || file.relativePath !== input.path) return null;
  const conditions: CheckConditionPayload[] = [];
  for (const condition of receipt.conditions) {
    if (!isRecord(condition)
      || typeof condition.id !== "string"
      || (condition.result !== "pass" && condition.result !== "fail")
      || typeof condition.detail !== "string") {
      return null;
    }
    conditions.push(Object.freeze({
      id: condition.id,
      result: condition.result,
      detail: condition.detail,
    }));
  }
  return Object.freeze({
    schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
    tool: NATIVE_HARNESS_RESULT_TOOL,
    action: "check" as const,
    ok: true as const,
    authority: "non-authoritative" as const,
    sourceToolCallId: response.sourceToolCallId,
    actionToolCallId: actualToolCallId,
    originalComputationToolCallId: response.computedByToolCallId,
    selectors: Object.freeze({
      sourceToolCallId: response.sourceToolCallId,
      captureId: response.captureId,
      captureDigest: response.captureDigest,
      path: response.path,
    }),
    checker: Object.freeze({
      id: response.checkerId,
      version: response.checkerVersion,
    }),
    plan: Object.freeze({
      source: "model-proposed-after-capture" as const,
      digest: response.planDigest,
    }),
    receipt: Object.freeze({
      schemaVersion: receipt.schemaVersion,
      checkerId: receipt.checkerId,
      checkerVersion: receipt.checkerVersion,
      planDigest: receipt.planDigest,
      fileSnapshotId: receipt.snapshot.captureId,
      file,
      conditions: Object.freeze(conditions),
      outcome: receipt.outcome,
      taskAccepted: false as const,
      semanticAcceptance: "not-evaluated" as const,
    }),
    observation: "cached-historical" as const,
    filesystemFreshness: "not-rechecked" as const,
    limitations: checkLimitations(),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function projectRead(
  actualToolCallId: string,
  input: NativeHarnessReadInput,
  outcome: NativeHarnessReadSelection,
): ReadSuccessPayload | null {
  if (!isRecord(outcome) || outcome.ok !== true) return null;
  const response = outcome as unknown as NativeHarnessReadSuccess;
  if (response.action !== "read"
    || response.readToolCallId !== actualToolCallId
    || response.sourceToolCallId !== input.sourceToolCallId
    || response.captureId !== input.captureId
    || response.captureDigest !== input.captureDigest
    || response.path !== input.path
    || response.observation !== "cached-historical"
    || response.filesystemFreshness !== "not-rechecked"
    || !isRecord(response.snapshot)
    || typeof response.snapshot.captureId !== "string"
    || typeof response.snapshot.text !== "string") {
    return null;
  }
  const file = fileFacts(response.snapshot.file);
  if (file === null || file.relativePath !== input.path) return null;
  return Object.freeze({
    schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
    tool: NATIVE_HARNESS_RESULT_TOOL,
    action: "read" as const,
    ok: true as const,
    authority: "non-authoritative" as const,
    sourceToolCallId: response.sourceToolCallId,
    actionToolCallId: actualToolCallId,
    selectors: Object.freeze({
      sourceToolCallId: response.sourceToolCallId,
      captureId: response.captureId,
      captureDigest: response.captureDigest,
      path: response.path,
    }),
    fileSnapshotId: response.snapshot.captureId,
    file,
    text: response.snapshot.text,
    observation: "cached-historical" as const,
    filesystemFreshness: "not-rechecked" as const,
    limitations: readLimitations(),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function projectInspect(outcome: NativeHarnessOutputCatalog): InspectSuccessPayload | null {
  if (!isRecord(outcome) || outcome.ok !== true) return null;
  const catalog = outcome as unknown as NativeHarnessOutputCatalogSuccess;
  if (catalog.action !== "inspect"
    || catalog.scope !== "retained-sources-in-this-root"
    || catalog.scanComplete !== true
    || !Array.isArray(catalog.rows)
    || !nonnegativeCount(catalog.retainedSources)
    || !nonnegativeCount(catalog.returnedSources)
    || !nonnegativeCount(catalog.excludedNotReady)
    || !nonnegativeCount(catalog.excludedUnavailable)) {
    return null;
  }
  const rows: InspectRowPayload[] = [];
  for (const row of catalog.rows) {
    if (!isRecord(row)
      || typeof row.sourceToolCallId !== "string"
      || (row.outputState !== "idle" && row.outputState !== "captured")) {
      return null;
    }
    if (row.capture === null) {
      rows.push(Object.freeze({
        sourceToolCallId: row.sourceToolCallId,
        outputState: row.outputState,
        capture: null,
      }));
      continue;
    }
    if (!isRecord(row.capture)
      || typeof row.capture.captureId !== "string"
      || typeof row.capture.captureDigest !== "string"
      || !Array.isArray(row.capture.files)) {
      return null;
    }
    const files: InspectFilePayload[] = [];
    for (const entry of row.capture.files) {
      if (!isRecord(entry)
        || typeof entry.path !== "string"
        || (entry.kind !== "add" && entry.kind !== "modify")
        || typeof entry.bytes !== "number"
        || !Number.isSafeInteger(entry.bytes)
        || entry.bytes < 0
        || typeof entry.sha256 !== "string"
        || typeof entry.observedAt !== "number"
        || !Number.isFinite(entry.observedAt)) {
        return null;
      }
      files.push(Object.freeze({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        sha256: entry.sha256,
        observedAt: entry.observedAt,
      }));
    }
    rows.push(Object.freeze({
      sourceToolCallId: row.sourceToolCallId,
      outputState: row.outputState,
      capture: Object.freeze({
        captureId: row.capture.captureId,
        captureDigest: row.capture.captureDigest,
        files: Object.freeze(files),
      }),
    }));
  }
  return Object.freeze({
    schema: NATIVE_HARNESS_RESULT_PAYLOAD_SCHEMA,
    tool: NATIVE_HARNESS_RESULT_TOOL,
    action: "inspect" as const,
    ok: true as const,
    authority: "non-authoritative" as const,
    scope: catalog.scope,
    scanComplete: true as const,
    retainedSources: catalog.retainedSources,
    returnedSources: catalog.returnedSources,
    excludedNotReady: catalog.excludedNotReady,
    excludedUnavailable: catalog.excludedUnavailable,
    rows: Object.freeze(rows),
    limitations: inspectLimitations(),
    taskAccepted: false as const,
    semanticAcceptance: "not-evaluated" as const,
  });
}

function encodeSuccess(
  payload: SuccessPayload,
  action: ResultAction,
  input: NormalizedAction["input"],
): { readonly wire: NativeToolResult } | { readonly failure: NativeToolResult } {
  const encoded = encodeWire(payload, false);
  if (encoded.failed) {
    return {
      failure: failureWire(action, "encoding-failure", "the successful result response could not be encoded", selectorsOf(input)),
    };
  }
  if (encoded.overflow) {
    return { failure: overflowWire(action, input, encoded.bytes) };
  }
  return { wire: encoded.wire };
}

function registerCapture(
  coordinator: NativeHarnessDelegationCoordinator,
  sourceToolCallId: string,
  actualToolCallId: string,
  selection: NativeHarnessOutputSelectionSuccess,
  wire: NativeToolResult,
  signal: AbortSignal,
): NativeToolResult {
  let registered: { readonly ok: boolean; readonly reason: string | null };
  try {
    registered = coordinator.registerOutputCaptureProjection(
      sourceToolCallId,
      actualToolCallId,
      selection,
      wire,
      signal,
    );
  } catch {
    return failureWire("capture", "coordinator-refused", "the capture projection registration failed");
  }
  if (!isRecord(registered) || registered.ok !== true) {
    return failureWire(
      "capture",
      "coordinator-refused",
      isRecord(registered) && typeof registered.reason === "string"
        ? `the capture projection registration was refused: ${registered.reason}`
        : "the capture projection registration was refused",
      Object.freeze({ sourceToolCallId }),
    );
  }
  return wire;
}

function registerCheck(
  coordinator: NativeHarnessDelegationCoordinator,
  sourceToolCallId: string,
  actualToolCallId: string,
  response: NativeHarnessCheckSuccess,
  wire: NativeToolResult,
  signal: AbortSignal,
  input: NativeHarnessCheckInput,
): NativeToolResult {
  let registered: { readonly ok: boolean; readonly reason: string | null };
  try {
    registered = coordinator.registerOutputCheckProjection(
      sourceToolCallId,
      actualToolCallId,
      response,
      wire,
      signal,
    );
  } catch {
    return failureWire("check", "coordinator-refused", "the check projection registration failed", selectorsOf(input));
  }
  if (!isRecord(registered) || registered.ok !== true) {
    return failureWire(
      "check",
      "coordinator-refused",
      isRecord(registered) && typeof registered.reason === "string"
        ? `the check projection registration was refused: ${registered.reason}`
        : "the check projection registration was refused",
      selectorsOf(input),
    );
  }
  return wire;
}

async function executeCapture(
  resolveRoot: (context: NativeContext) => NativeHarnessRootResolution,
  lifecycle: ResultLifecycle,
  actualToolCallId: string,
  input: NativeHarnessCaptureInput,
  signal: AbortSignal,
  context: NativeContext,
): Promise<NativeToolResult> {
  const resolution = readRootResolution(resolveRoot, context, "capture");
  if (!resolution.ok) {
    return failureWire("capture", "root-unavailable", resolution.reason, selectorsOf(input));
  }
  const coordinator = resolution.root.coordinator;
  let continuation: Promise<NativeToolResult> | null = null;
  let trackedPromise: Promise<NativeHarnessOutputSelection> | null = null;
  try {
    const scoped = resolution.root.runWithContext(context, actualToolCallId, () => {
      // Reuse the accepted root launch-gap mechanism by returning the exact
      // coordinator promise. The projection/registration continuation is
      // attached in this same ALS frame but is never the tracked promise.
      const original = coordinator.captureOutputForCall(actualToolCallId, input, signal);
      trackedPromise = original;
      try {
        continuation = Promise.resolve(original).then(
          (outcome) => {
            try {
              const refusal = publishRefusal(lifecycle, signal, "capture", input);
              if (refusal !== null) return refusal;
              if (!isRecord(outcome) || outcome.ok !== true) {
                return failureWire(
                  "capture",
                  "coordinator-refused",
                  isRecord(outcome) && typeof outcome.reason === "string"
                    ? outcome.reason
                    : "the capture operation was refused",
                  selectorsOf(input),
                );
              }
              const selection = outcome as unknown as NativeHarnessOutputSelectionSuccess;
              const payload = projectCapture(actualToolCallId, input, selection);
              if (payload === null) {
                return failureWire(
                  "capture",
                  "coordinator-refused",
                  "the capture operation returned no readable retained projection",
                  selectorsOf(input),
                );
              }
              const encoded = encodeSuccess(payload, "capture", input);
              if ("failure" in encoded) return encoded.failure;
              const expectation = expectationAllows(input, encoded.wire);
              if (!expectation.ok) {
                return failureWire("capture", "encoding-failure", expectation.reason, selectorsOf(input));
              }
              const registered = registerCapture(
                coordinator,
                input.sourceToolCallId,
                actualToolCallId,
                selection,
                encoded.wire,
                signal,
              );
              if (registered !== encoded.wire) return registered;
              return publishRefusal(lifecycle, signal, "capture", input) ?? encoded.wire;
            } catch {
              return failureWire(
                "capture",
                "coordinator-refused",
                "the capture projection could not be completed",
                selectorsOf(input),
              );
            }
          },
          () => failureWire(
            "capture",
            "coordinator-refused",
            "the capture operation did not complete",
            selectorsOf(input),
          ),
        );
      } catch {
        continuation = Promise.resolve(failureWire(
          "capture",
          "coordinator-refused",
          "the capture operation returned no trackable promise",
          selectorsOf(input),
        ));
      }
      return original;
    });
    await scoped;
  } catch {
    return failureWire(
      "capture",
      "coordinator-refused",
      "the capture operation could not be scoped to the trusted result root",
      selectorsOf(input),
    );
  }
  if (trackedPromise === null) {
    return failureWire(
      "capture",
      "coordinator-refused",
      "the capture operation produced no tracked outcome",
      selectorsOf(input),
    );
  }
  if (continuation === null) {
    return failureWire(
      "capture",
      "coordinator-refused",
      "the capture projection continuation is unavailable",
      selectorsOf(input),
    );
  }
  try {
    return await continuation;
  } catch {
    return failureWire(
      "capture",
      "coordinator-refused",
      "the capture projection did not complete",
      selectorsOf(input),
    );
  }
}

async function executeCheck(
  resolution: { readonly ok: true; readonly root: NativeHarnessResolvedRoot },
  lifecycle: ResultLifecycle,
  actualToolCallId: string,
  input: NativeHarnessCheckInput,
  signal: AbortSignal,
  context: NativeContext,
): Promise<NativeToolResult> {
  const coordinator = resolution.root.coordinator;
  let wire: NativeToolResult | null = null;
  try {
    const scoped = resolution.root.runWithContext(context, actualToolCallId, () => {
      let outcome: NativeHarnessCheckOutcome;
      try {
        outcome = coordinator.checkOutput(actualToolCallId, input, signal);
      } catch {
        wire = failureWire(
          "check",
          "coordinator-refused",
          "the check operation could not be executed",
          selectorsOf(input),
        );
        return rejectedTrackingPromise("the check operation could not be executed");
      }
      try {
        const refusal = publishRefusal(lifecycle, signal, "check", input);
        if (refusal !== null) {
          wire = refusal;
        } else if (!isRecord(outcome) || outcome.ok !== true) {
          wire = failureWire(
            "check",
            "coordinator-refused",
            isRecord(outcome) && typeof outcome.reason === "string"
              ? outcome.reason
              : "the check operation was refused",
            selectorsOf(input),
          );
        } else {
          const response = outcome as unknown as NativeHarnessCheckSuccess;
          const payload = projectCheck(actualToolCallId, input, response);
          if (payload === null) {
            wire = failureWire(
              "check",
              "coordinator-refused",
              "the check operation returned no readable retained projection",
              selectorsOf(input),
            );
          } else {
            const encoded = encodeSuccess(payload, "check", input);
            if ("failure" in encoded) {
              wire = encoded.failure;
            } else {
              const expectation = expectationAllows(input, encoded.wire);
              if (!expectation.ok) {
                wire = failureWire("check", "encoding-failure", expectation.reason, selectorsOf(input));
              } else {
                const registered = registerCheck(
                  coordinator,
                  input.sourceToolCallId,
                  actualToolCallId,
                  response,
                  encoded.wire,
                  signal,
                  input,
                );
                wire = registered === encoded.wire
                  ? publishRefusal(lifecycle, signal, "check", input) ?? encoded.wire
                  : registered;
              }
            }
          }
        }
      } catch {
        wire = failureWire(
          "check",
          "coordinator-refused",
          "the check projection could not be completed",
          selectorsOf(input),
        );
      }
      return Promise.resolve(outcome);
    });
    await scoped;
  } catch {
    const boundedFailure = wire as NativeToolResult | null;
    if (boundedFailure !== null && boundedFailure.isError === true) return boundedFailure;
    return failureWire(
      "check",
      "coordinator-refused",
      "the check operation could not be scoped to the trusted result root",
      selectorsOf(input),
    );
  }
  if (wire === null) {
    return failureWire(
      "check",
      "coordinator-refused",
      "the check operation produced no projection",
      selectorsOf(input),
    );
  }
  return publishRefusal(lifecycle, signal, "check", input) ?? wire;
}

async function executeQuery(
  resolution: { readonly ok: true; readonly root: NativeHarnessResolvedRoot },
  lifecycle: ResultLifecycle,
  actualToolCallId: string,
  action: "read" | "inspect",
  input: NativeHarnessReadInput | NativeHarnessInspectInput,
  signal: AbortSignal,
  context: NativeContext,
): Promise<NativeToolResult> {
  const coordinator = resolution.root.coordinator;
  let wire: NativeToolResult | null = null;
  try {
    const scoped = resolution.root.runWithContext<unknown>(context, actualToolCallId, () => {
      try {
        const refusal = publishRefusal(lifecycle, signal, action, input);
        if (refusal !== null) {
          wire = refusal;
          return Promise.resolve(null);
        }
        if (action === "read") {
          const outcome = coordinator.readOutputForCall(actualToolCallId, input, signal);
          const late = publishRefusal(lifecycle, signal, "read", input);
          if (late !== null) {
            wire = late;
            return Promise.resolve(outcome);
          }
          const payload = projectRead(actualToolCallId, input as NativeHarnessReadInput, outcome);
          if (payload === null) {
            wire = failureWire(
              "read",
              "coordinator-refused",
              isRecord(outcome) && outcome.ok === false && typeof outcome.reason === "string"
                ? outcome.reason
                : "the read operation returned no readable retained snapshot",
              selectorsOf(input),
            );
          } else {
            const encoded = encodeSuccess(payload, "read", input);
            wire = "failure" in encoded ? encoded.failure : encoded.wire;
          }
          return Promise.resolve(outcome);
        }
        const outcome = coordinator.inspectOutputsForCall(actualToolCallId, input, signal);
        const late = publishRefusal(lifecycle, signal, "inspect", input);
        if (late !== null) {
          wire = late;
          return Promise.resolve(outcome);
        }
        const payload = projectInspect(outcome);
        if (payload === null) {
          wire = failureWire(
            "inspect",
            "coordinator-refused",
            isRecord(outcome) && outcome.ok === false && typeof outcome.reason === "string"
              ? outcome.reason
              : "the inspect operation returned no readable catalog",
          );
        } else {
          const encoded = encodeSuccess(payload, "inspect", input);
          wire = "failure" in encoded ? encoded.failure : encoded.wire;
        }
        return Promise.resolve(outcome);
      } catch {
        wire = failureWire(
          action,
          "coordinator-refused",
          `the ${action} operation could not be executed`,
          selectorsOf(input),
        );
        return rejectedTrackingPromise(`the ${action} operation could not be executed`);
      }
    });
    await scoped;
  } catch {
    const boundedFailure = wire as NativeToolResult | null;
    if (boundedFailure !== null && boundedFailure.isError === true) return boundedFailure;
    return failureWire(
      action,
      "coordinator-refused",
      `the ${action} operation could not be scoped to the trusted result root`,
      selectorsOf(input),
    );
  }
  if (wire === null) {
    return failureWire(
      action,
      "coordinator-refused",
      `the ${action} operation produced no projection`,
      selectorsOf(input),
    );
  }
  return publishRefusal(lifecycle, signal, action, input) ?? wire;
}

async function executeResult(
  resolveRoot: (context: NativeContext) => NativeHarnessRootResolution,
  lifecycle: ResultLifecycle,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  context: NativeContext,
): Promise<NativeToolResult> {
  try {
    if (lifecycle.disposed) {
      return failureWire(null, "disposed", "the result entry is disposed");
    }
    const actualToolCallId = boundedId(toolCallId);
    if (actualToolCallId === null) {
      return failureWire(null, "invalid-input", "the actual result tool call id is unavailable");
    }
    const snapshot = snapshotCallerInput(params);
    if (!snapshot.ok) {
      return failureWire(null, "invalid-input", snapshot.reason);
    }
    const normalized = normalizedAction(snapshot.action, snapshot.owned);
    if (!normalized.ok) {
      return failureWire(snapshot.action, "invalid-input", normalized.reason);
    }
    const action = normalized.value.action;
    const input = normalized.value.input;
    const signalRead = readActualAbortSignal(signal);
    if (!signalRead.ok) {
      return failureWire(action, "signal-unavailable", signalRead.reason, selectorsOf(input));
    }
    if (signalRead.aborted) {
      return failureWire(action, "cancelled", "the result action was cancelled before admission", selectorsOf(input));
    }
    if (!isActualMainContext(context)) {
      return failureWire(
        action,
        "invalid-context",
        "agent_harness_result is available only to the owning actual main root",
        selectorsOf(input),
      );
    }
    let actionWire: NativeToolResult;
    if (action === "capture") {
      actionWire = await executeCapture(
        resolveRoot,
        lifecycle,
        actualToolCallId,
        input as NativeHarnessCaptureInput,
        signal as AbortSignal,
        context,
      );
    } else {
      const resolution = readRootResolution(resolveRoot, context, action);
      if (!resolution.ok) {
        return failureWire(action, "root-unavailable", resolution.reason, selectorsOf(input));
      }
      if (action === "check") {
        actionWire = await executeCheck(
          resolution,
          lifecycle,
          actualToolCallId,
          input as NativeHarnessCheckInput,
          signal as AbortSignal,
          context,
        );
      } else {
        actionWire = await executeQuery(
          resolution,
          lifecycle,
          actualToolCallId,
          action,
          input as NativeHarnessReadInput | NativeHarnessInspectInput,
          signal as AbortSignal,
          context,
        );
      }
    }
    // Common resolution boundary: a later Promise reaction or queued microtask
    // may dispose this adapter or abort the actual signal after the inner
    // projection/registration completed. Never return a prepared success then.
    return publishRefusal(lifecycle, signal, action, input) ?? actionWire;
  } catch {
    return failureWire(null, "coordinator-refused", "the result operation failed");
  }
}

export function createNativeHarnessResultEntry(
  options: NativeHarnessResultEntryOptions,
): NativeHarnessResultEntry {
  if (!isRecord(options)) {
    throw new Error("Harness result entry options must be an object.");
  }
  const resolveField = Object.getOwnPropertyDescriptor(options, "resolveRoot");
  if (resolveField === undefined || !("value" in resolveField) || typeof resolveField.value !== "function") {
    throw new Error("Harness result entry requires a trusted resolveRoot function.");
  }
  const resolveRoot = resolveField.value as (context: NativeContext) => NativeHarnessRootResolution;
  const lifecycle: ResultLifecycle = { disposed: false };

  const tool: NativeHarnessResultTool = {
    name: NATIVE_HARNESS_RESULT_TOOL,
    label: "Harness Result",
    description: RESULT_DESCRIPTION,
    parameters: AGENT_HARNESS_RESULT_PARAMETERS,
    approval: "read",
    loadMode: "discoverable",
    defaultInactive: true,
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: NativeContext,
    ): Promise<NativeToolResult> {
      return executeResult(resolveRoot, lifecycle, toolCallId, params, signal, context);
    },
  };

  return Object.freeze({
    tool,
    dispose(): void {
      lifecycle.disposed = true;
    },
  });
}
