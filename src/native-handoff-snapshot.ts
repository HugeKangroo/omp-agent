import {
  NativeHandoffError,
  NATIVE_HANDOFF_SOURCE,
  type HandoffCallRef,
  type HandoffCheckReceiptView,
  type HandoffConsumerRef,
  type HandoffOffer,
  type HandoffOfferView,
  type HandoffPreparedRead,
  type HandoffReadPreparation,
  type HandoffToolCallRef,
  type NativeHandoffStore,
} from "./native-handoff.ts";
import {
  getNativeHandoffCoordinatorStore,
  type NativeHandoffCoordinator,
} from "./native-handoff-entry.ts";
import {
  MAX_NATIVE_TEXT_CHECK_CONDITIONS,
  MAX_NATIVE_TEXT_CHECK_ID_CHARS,
  MAX_NATIVE_TEXT_CHECK_PLAN_BYTES,
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  NATIVE_TEXT_CHECK_SCHEMA_VERSION,
} from "./native-snapshot-checker.ts";
import type { NativeContext, NativeToolResult } from "./native-entry.ts";
import { clonePlain, deepFreeze, sha256Hex } from "./native-work.ts";

/**
 * Bounded child snapshot tool and independent read-result observer.
 *
 * This is the fake-port protocol foundation, not OMP registration. Trusted
 * ports are the only source of actual child/root/parent/read-call identity;
 * the core store is the only source of snapshot/read/check history. The leaf
 * never binds an open offer, fabricates a main context, accepts a model
 * success flag or observes its own execute response.
 */

export const NATIVE_SNAPSHOT_TOOL = "agent_snapshot";
export const NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA = "omp-agent.native-snapshot-tool-result.v1";
export const MAX_SNAPSHOT_OPERATIONS = 64;
export const MAX_SNAPSHOT_READ_RECORDS = 16;
export const MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES = 32 * 1024;
export const MAX_SNAPSHOT_READ_RESPONSE_BYTES = 256 * 1024;
const MAX_ID_CHARS = 256;
const MAX_REASON_CHARS = 320;

export type NativeSnapshotAction = "read" | "check";

export interface NativeSnapshotRequest {
  readonly action: NativeSnapshotAction;
  readonly offerId: string;
}

export interface NativeSnapshotRequestDescriptor {
  readonly action: NativeSnapshotAction;
  /** SHA-256 of the fixed-order, bounded parsed request. */
  readonly digest: string;
  readonly params: NativeSnapshotRequest;
}

/** Bounded actual parent/task/child-tool facts. They are not grants. */
export interface NativeChildCallFacts {
  readonly childToolCallId: string;
  readonly childToolName: string;
  readonly parentTaskCallId: string;
}

export type NativeChildCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type NativeChildCallIdentity =
  | {
      readonly ok: true;
      readonly childToolCallRef: HandoffToolCallRef;
      /** Must be the same exact consumer returned by resolveChildRoot. */
      readonly consumerRef: HandoffConsumerRef;
      readonly parentTaskRef: HandoffCallRef;
      readonly facts: NativeChildCallFacts;
      /** Captured pure check. null succeeds; only a string refuses. */
      readonly revalidate: () => string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface NativeChildPrepareRequest {
  readonly actualToolCallId: string;
  readonly childToolCallRef: HandoffToolCallRef;
  readonly consumer: HandoffConsumerRef;
  readonly parentTaskCall: HandoffCallRef;
  readonly callFacts: NativeChildCallFacts;
  readonly requestDigest: string;
  readonly request: NativeSnapshotRequest;
  readonly offer: HandoffOffer;
  readonly offerView: HandoffOfferView;
}

export interface NativeChildPrepared {
  /** Synchronous actual host refresh for the original child call. */
  refresh(context: NativeContext): NativeChildCheck;
  /** Captured pure check. null succeeds; only a string refuses. */
  revalidate(): string | null;
}

export type NativeChildPrepareResult =
  | { readonly ok: true; readonly prepared: NativeChildPrepared }
  | { readonly ok: false; readonly reason: string };

/**
 * The exact tool_result call identity. `effectiveInput` is evidence, not the
 * identity: the port must authenticate the actual factory/child/parent/read
 * tool call from the call id, context and expected binding, and must not use
 * input equality as an authentication precondition. A genuine same call with
 * changed effective input is a terminal observation conflict, not an unrelated
 * event.
 */
export interface NativeChildReadEventIdentity {
  readonly type: "tool_result";
  readonly toolName: string;
  readonly toolCallId: string;
  /** Null when the effective input was absent, unreadable or not normalizable. */
  readonly effectiveInput: NativeSnapshotRequestDescriptor | null;
}

/** Expected original read binding passed to the independent hook port. */
export interface NativeChildReadExpectation {
  readonly read: HandoffPreparedRead;
  readonly readId: string;
  readonly offerId: string;
  readonly consumer: HandoffConsumerRef;
  readonly parentTaskCall: HandoffCallRef;
  readonly readToolCall: HandoffToolCallRef;
  readonly readCallId: string;
  readonly requestDigest: string;
}

export interface NativeChildObservationPrepared {
  refresh(context: NativeContext): NativeChildCheck;
  revalidate(): string | null;
}

export type NativeChildObservationPreparation =
  | { readonly ok: true; readonly prepared: NativeChildObservationPrepared }
  | { readonly ok: false; readonly reason: string };

/**
 * INTERNAL trusted child ports. Every method is synchronous and returns plain,
 * bounded own-data facts. Throws, promises, missing gates and malformed shapes
 * are refused. A success identity must use the resolver's exact consumer ref.
 */
export interface NativeChildPorts {
  identifyChildCall(
    actualToolCallId: string,
    context: NativeContext,
    priorChildToolCallRef: HandoffToolCallRef | undefined,
    descriptor: NativeSnapshotRequestDescriptor,
  ): NativeChildCallIdentity;

  prepareChild(
    request: NativeChildPrepareRequest,
    context: NativeContext,
  ): NativeChildPrepareResult;

  prepareReadObservation(
    actualEventIdentity: NativeChildReadEventIdentity,
    context: NativeContext,
    expectedBinding: NativeChildReadExpectation,
  ): NativeChildObservationPreparation;
}

export interface NativeSnapshotResolvedRoot {
  readonly ok: true;
  readonly coordinator: NativeHandoffCoordinator;
  readonly consumerRef: HandoffConsumerRef;
  readonly ports: NativeChildPorts;
}

export interface NativeSnapshotRootUnavailable {
  readonly ok: false;
  readonly reason: string;
}

export type NativeSnapshotRootResolution =
  | NativeSnapshotResolvedRoot
  | NativeSnapshotRootUnavailable;

export interface NativeSnapshotEntryOptions {
  /** Trusted composition resolves the actual factory/home-root/sub identity. */
  resolveChildRoot(context: NativeContext): NativeSnapshotRootResolution;
}

export interface NativeSnapshotTool {
  readonly name: typeof NATIVE_SNAPSHOT_TOOL;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly approval: "read";
  readonly loadMode: "essential";
  readonly defaultInactive: true;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: NativeContext,
  ): Promise<NativeToolResult>;
}

export type NativeSnapshotObservation =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "observed"; readonly readId: string; readonly success: boolean };

export interface NativeSnapshotEntry {
  readonly tool: NativeSnapshotTool;
  /** Independent tool_result hook entry. It is never called by execute. */
  observeToolResult(event: unknown, context: NativeContext): NativeSnapshotObservation;
  /** Closes only this entry and releases its unfinished observation links. */
  dispose(): void;
}

type SlotState = "running" | "settled" | "conflict";

interface SlotStatus {
  state: SlotState;
  conflictReason: string | null;
}

interface OperationSlot {
  readonly toolCallId: string;
  readonly consumerRef: HandoffConsumerRef;
  readonly parentTaskRef: HandoffCallRef;
  readonly childToolCallRef: HandoffToolCallRef;
  readonly action: NativeSnapshotAction;
  readonly offerId: string;
  readonly requestDigest: string;
  readonly callFacts: NativeChildCallFacts;
  /** Mutable only through this local box, never by exposing the slot. */
  readonly status: SlotStatus;
  identityRevalidate: (() => string | null) | null;
  promise: Promise<NativeToolResult> | null;
  response: CachedResponse | null;
}

type CachedResponse =
  | { readonly kind: "read"; readonly read: ReadRecord }
  | { readonly kind: "result"; readonly result: NativeToolResult };

type ReadRecordState = "pending" | "delivered" | "failed";

interface ReadRecord {
  readonly read: HandoffPreparedRead;
  readonly readId: string;
  readonly offer: HandoffOffer;
  readonly offerId: string;
  readonly consumerRef: HandoffConsumerRef;
  readonly parentTaskRef: HandoffCallRef;
  readonly childToolCallRef: HandoffToolCallRef;
  readonly readCallId: string;
  readonly requestDigest: string;
  readonly viewJson: string;
  readonly digest: string;
  readonly expectation: NativeChildReadExpectation;
  /** Exact original operation slot; identity is not recreated from ids. */
  readonly slot: OperationSlot;
  readonly owner: EntryLifecycle;
  signal: AbortSignal | null;
  /** Set only when this record's entry was disposed before observation. */
  closed: boolean;
  state: ReadRecordState;
}

interface ChildState {
  readonly store: NativeHandoffStore;
  readonly slots: OperationSlot[];
  readonly reads: ReadRecord[];
}

interface EntryLifecycle {
  disposed: boolean;
  /** Only this entry's unobserved records; each is removed on terminal. */
  readonly pending: Set<ReadRecord>;
}

const childStates = new WeakMap<object, ChildState>();

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isOpaqueRef(value: unknown): value is object {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function boundedString(value: unknown, max: number, minimum = 1): string | null {
  if (typeof value !== "string" || value.length < minimum || value.length > max) return null;
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

function boundedReason(value: unknown, fallback: string): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = value instanceof Error && typeof value.message === "string" ? value.message : String(value);
    } catch {
      text = fallback;
    }
  }
  const normalized = text.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= MAX_REASON_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_REASON_CHARS - 3)}...`;
}

type StrictFields = ReadonlyMap<string, unknown>;

/** Strict own data fields; accessors, symbols, extra keys and exotic prototypes are refused. */
function readStrictFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): StrictFields | null {
  if (!isRecord(value)) return null;
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string")) return null;
  const fields = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) return null;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      return null;
    }
    fields.set(key, descriptor.value);
  }
  for (const key of required) {
    if (!fields.has(key)) return null;
  }
  return fields;
}

function readOwnData(value: unknown, key: string): { readonly present: boolean; readonly value: unknown } | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return null;
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return null;
  return { present: true, value: descriptor.value };
}

function readCallable(value: unknown, key: string): Function | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let current: object | null = value as object;
  for (let depth = 0; current !== null && depth < 4; depth++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return null;
    }
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
      return descriptor.value;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return null;
    }
    if (current === Object.prototype || current === Function.prototype) return null;
  }
  return null;
}

const NATIVE_PROMISE_THEN = Promise.prototype.then;

/** Brand-consume a native Promise without reading an arbitrary `then`. */
function consumeNativePromise(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    Reflect.apply(NATIVE_PROMISE_THEN, value, [() => undefined, () => undefined]);
    return true;
  } catch {
    return false;
  }
}

const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

const ACTUAL_ADD_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.addEventListener;
  } catch {
    return null;
  }
})();

const ACTUAL_REMOVE_EVENT_LISTENER = (() => {
  try {
    return EventTarget.prototype.removeEventListener;
  } catch {
    return null;
  }
})();

type ActualAbortRead =
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string };

function readActualAbortSignal(signal: unknown): ActualAbortRead {
  if (signal === undefined || signal === null) {
    return { ok: false, reason: "the actual child AbortSignal is missing" };
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

function isActualSubContext(context: unknown): boolean {
  try {
    return typeof context === "object"
      && context !== null
      && (context as NativeContext).agent?.kind === "sub";
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

function encodedBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return null;
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return null;
  }
}

type ParsedArguments =
  | { readonly ok: true; readonly descriptor: NativeSnapshotRequestDescriptor }
  | { readonly ok: false; readonly reason: string };

function parseArguments(value: unknown): ParsedArguments {
  const fields = readStrictFields(value, ["action", "offerId"], ["action", "offerId"]);
  if (fields === null) {
    return { ok: false, reason: "agent_snapshot arguments must be plain own data with only action and offerId" };
  }
  const action = fields.get("action");
  if (action !== "read" && action !== "check") {
    return { ok: false, reason: "agent_snapshot action must be read or check" };
  }
  const offerId = boundedString(fields.get("offerId"), MAX_ID_CHARS);
  if (offerId === null) return { ok: false, reason: "agent_snapshot offerId is invalid" };
  const params: NativeSnapshotRequest = Object.freeze({ action, offerId });
  return {
    ok: true,
    descriptor: Object.freeze({
      action,
      digest: sha256Hex(canonicalJson(params)),
      params,
    }),
  };
}

export type NativeSnapshotRequestDescriptorRead =
  | { readonly ok: true; readonly descriptor: NativeSnapshotRequestDescriptor }
  | { readonly ok: false; readonly reason: string };

/**
 * INTERNAL: the same bounded strict parser used by the child tool, exported
 * for the actual instanced preflight so it cannot drift from execute. A
 * reflection failure is a bounded refusal, never a second schema.
 */
export function readNativeSnapshotRequestDescriptor(
  value: unknown,
): NativeSnapshotRequestDescriptorRead {
  try {
    const parsed = parseArguments(value);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return { ok: true, descriptor: parsed.descriptor };
  } catch {
    return { ok: false, reason: "agent_snapshot arguments could not be inspected" };
  }
}

type PortSnapshot =
  | {
      readonly ok: true;
      readonly ports: NativeChildPorts;
      readonly identify: Function;
      readonly prepare: Function;
      readonly observe: Function;
    }
  | { readonly ok: false; readonly reason: string };

function snapshotPorts(value: unknown): PortSnapshot {
  if (!isOpaqueRef(value)) return { ok: false, reason: "trusted child ports are unavailable" };
  const identify = readCallable(value, "identifyChildCall");
  const prepare = readCallable(value, "prepareChild");
  const observe = readCallable(value, "prepareReadObservation");
  if (identify === null || prepare === null || observe === null) {
    return { ok: false, reason: "trusted child ports are incomplete" };
  }
  return { ok: true, ports: value as NativeChildPorts, identify, prepare, observe };
}

type RootResolved =
  | {
      readonly ok: true;
      readonly coordinator: NativeHandoffCoordinator;
      readonly consumerRef: HandoffConsumerRef;
      readonly store: NativeHandoffStore;
      readonly ports: PortSnapshot & { readonly ok: true };
    }
  | { readonly ok: false; readonly reason: string };

function resolveSnapshotRoot(resolve: Function, context: NativeContext): RootResolved {
  let raw: unknown;
  try {
    raw = Reflect.apply(resolve, undefined, [context]);
  } catch (error) {
    return { ok: false, reason: `child root resolution threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "child root resolution returned a promise; synchronous resolution is required" };
  }
  const fields = readStrictFields(
    raw,
    ["ok", "coordinator", "consumerRef", "ports", "reason"],
    ["ok"],
  );
  if (fields === null) return { ok: false, reason: "child root resolution returned an unreadable result" };
  if (fields.get("ok") === false) {
    return {
      ok: false,
      reason: boundedReason(fields.get("reason"), "the actual child root is unavailable"),
    };
  }
  if (fields.get("ok") !== true) return { ok: false, reason: "child root resolution returned an unknown result" };
  const coordinator = fields.get("coordinator");
  if (!isOpaqueRef(coordinator)) return { ok: false, reason: "child root resolution supplied no coordinator" };
  const store = getNativeHandoffCoordinatorStore(coordinator as NativeHandoffCoordinator);
  if (store === null) return { ok: false, reason: "the original child root coordinator is unavailable or closed" };
  const consumerRef = fields.get("consumerRef");
  if (!isOpaqueRef(consumerRef)) return { ok: false, reason: "child root resolution supplied no actual consumer" };
  const ports = snapshotPorts(fields.get("ports"));
  if (!ports.ok) return ports;
  return {
    ok: true,
    coordinator: coordinator as NativeHandoffCoordinator,
    consumerRef: consumerRef as HandoffConsumerRef,
    store,
    ports,
  };
}

function parseChildCallFacts(value: unknown): NativeChildCallFacts | null {
  const fields = readStrictFields(
    value,
    ["childToolCallId", "childToolName", "parentTaskCallId"],
    ["childToolCallId", "childToolName", "parentTaskCallId"],
  );
  if (fields === null) return null;
  const childToolCallId = boundedString(fields.get("childToolCallId"), MAX_ID_CHARS);
  const childToolName = boundedString(fields.get("childToolName"), MAX_ID_CHARS);
  const parentTaskCallId = boundedString(fields.get("parentTaskCallId"), MAX_ID_CHARS);
  if (childToolCallId === null || childToolName === null || parentTaskCallId === null) return null;
  return Object.freeze({ childToolCallId, childToolName, parentTaskCallId });
}

type IdentifyInvocation =
  | {
      readonly ok: true;
      readonly childToolCallRef: HandoffToolCallRef;
      readonly consumerRef: HandoffConsumerRef;
      readonly parentTaskRef: HandoffCallRef;
      readonly facts: NativeChildCallFacts;
      readonly revalidate: () => string | null;
    }
  | { readonly ok: false; readonly reason: string };

function invokeIdentify(
  ports: PortSnapshot & { readonly ok: true },
  actualToolCallId: string,
  context: NativeContext,
  prior: HandoffToolCallRef | undefined,
  descriptor: NativeSnapshotRequestDescriptor,
  expectedConsumer: HandoffConsumerRef,
): IdentifyInvocation {
  let raw: unknown;
  try {
    raw = Reflect.apply(ports.identify, ports.ports, [actualToolCallId, context, prior, descriptor]);
  } catch (error) {
    return { ok: false, reason: `child call identification threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "child call identification returned a promise; synchronous identification is required" };
  }
  const fields = readStrictFields(
    raw,
    ["ok", "childToolCallRef", "consumerRef", "parentTaskRef", "facts", "reason", "revalidate"],
    ["ok"],
  );
  if (fields === null) return { ok: false, reason: "child call identification returned an unreadable result" };
  if (fields.get("ok") === false) {
    return { ok: false, reason: boundedReason(fields.get("reason"), "the actual child tool call is unavailable") };
  }
  if (fields.get("ok") !== true) return { ok: false, reason: "child call identification returned an unknown result" };
  const childToolCallRef = fields.get("childToolCallRef");
  if (!isOpaqueRef(childToolCallRef)) {
    return { ok: false, reason: "child call identification returned no actual child tool call reference" };
  }
  const consumerRef = fields.get("consumerRef");
  if (!isOpaqueRef(consumerRef) || consumerRef !== expectedConsumer) {
    return { ok: false, reason: "child call identification did not retain the resolved actual consumer" };
  }
  const parentTaskRef = fields.get("parentTaskRef");
  if (!isOpaqueRef(parentTaskRef)) {
    return { ok: false, reason: "child call identification returned no actual parent task reference" };
  }
  if (childToolCallRef === parentTaskRef) {
    return { ok: false, reason: "the actual child tool call reference must not be the parent task reference" };
  }
  const facts = parseChildCallFacts(fields.get("facts"));
  if (facts === null) return { ok: false, reason: "child call identification returned malformed call facts" };
  if (facts.childToolCallId !== actualToolCallId) {
    return { ok: false, reason: "child call identification facts do not match the actual child tool call id" };
  }
  if (facts.childToolName !== NATIVE_SNAPSHOT_TOOL) {
    return { ok: false, reason: "child call identification facts do not match agent_snapshot" };
  }
  const revalidateValue = fields.get("revalidate");
  if (typeof revalidateValue !== "function") {
    return { ok: false, reason: "child call identification did not provide its captured pure check" };
  }
  const pure = revalidateValue as (this: unknown) => unknown;
  const identityValue = raw;
  const revalidate = (): string | null => {
    let result: unknown;
    try {
      result = Reflect.apply(pure, identityValue, []);
    } catch (error) {
      return `child identity revalidate threw: ${boundedReason(error, "unreadable failure")}`;
    }
    if (result === null) return null;
    if (typeof result === "string") return boundedReason(result, "child identity revalidate refused");
    if (consumeNativePromise(result)) {
      return "child identity revalidate returned a promise; a primitive final check is required";
    }
    return "child identity revalidate returned a non-primitive final check";
  };
  return {
    ok: true,
    childToolCallRef: childToolCallRef as HandoffToolCallRef,
    consumerRef: consumerRef as HandoffConsumerRef,
    parentTaskRef: parentTaskRef as HandoffCallRef,
    facts,
    revalidate,
  };
}

function invokeFinalRevalidate(check: () => string | null): NativeChildCheck {
  let raw: unknown;
  try {
    raw = check();
  } catch (error) {
    return { ok: false, reason: `child revalidate threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (raw === null) return { ok: true };
  if (typeof raw === "string") {
    return { ok: false, reason: boundedReason(raw, "child revalidate refused") };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "child revalidate returned a promise; a primitive final check is required" };
  }
  return { ok: false, reason: "child revalidate returned a non-primitive final check" };
}

function parseChildCheck(raw: unknown): NativeChildCheck {
  const fields = readStrictFields(raw, ["ok", "reason"], ["ok"]);
  if (fields === null) return { ok: false, reason: "child gate returned an unreadable result" };
  if (fields.get("ok") === false) {
    return { ok: false, reason: boundedReason(fields.get("reason"), "the child gate refused") };
  }
  if (fields.get("ok") !== true) return { ok: false, reason: "child gate returned an unknown result" };
  return { ok: true };
}

function invokeChildCheck(
  check: (context: NativeContext) => NativeChildCheck,
  context: NativeContext,
): NativeChildCheck {
  let raw: unknown;
  try {
    raw = Reflect.apply(check, undefined, [context]);
  } catch (error) {
    return { ok: false, reason: `child refresh threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "child refresh returned a promise; synchronous refresh is required" };
  }
  return parseChildCheck(raw);
}

type PreparedInvocation =
  | { readonly ok: true; readonly prepared: NativeChildPrepared }
  | { readonly ok: false; readonly reason: string };

function invokePrepare(
  ports: PortSnapshot & { readonly ok: true },
  request: NativeChildPrepareRequest,
  context: NativeContext,
): PreparedInvocation {
  let raw: unknown;
  try {
    raw = Reflect.apply(ports.prepare, ports.ports, [request, context]);
  } catch (error) {
    return { ok: false, reason: `child preparation threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "child preparation returned a promise; synchronous preparation is required" };
  }
  const response = readStrictFields(raw, ["ok", "prepared", "reason"], ["ok"]);
  if (response === null) return { ok: false, reason: "child preparation returned an unreadable result" };
  if (response.get("ok") === false) {
    return { ok: false, reason: boundedReason(response.get("reason"), "the child operation is unavailable") };
  }
  if (response.get("ok") !== true) return { ok: false, reason: "child preparation returned an unknown result" };
  const preparedValue = response.get("prepared");
  const preparedFields = readStrictFields(preparedValue, ["refresh", "revalidate"], ["refresh", "revalidate"]);
  if (preparedFields === null) return { ok: false, reason: "child preparation returned malformed prepared gates" };
  const refreshValue = preparedFields.get("refresh");
  const revalidateValue = preparedFields.get("revalidate");
  if (typeof refreshValue !== "function") {
    return { ok: false, reason: "child preparation did not provide its captured refresh" };
  }
  if (typeof revalidateValue !== "function") {
    return { ok: false, reason: "child preparation did not provide its captured pure check" };
  }
  const refresh = refreshValue as (this: unknown, context: NativeContext) => unknown;
  const pure = revalidateValue as (this: unknown) => unknown;
  return {
    ok: true,
    prepared: Object.freeze({
      refresh(context: NativeContext): NativeChildCheck {
        let result: unknown;
        try {
          result = Reflect.apply(refresh, preparedValue, [context]);
        } catch (error) {
          return { ok: false, reason: `child refresh threw: ${boundedReason(error, "unreadable failure")}` };
        }
        if (consumeNativePromise(result)) {
          return { ok: false, reason: "child refresh returned a promise; synchronous refresh is required" };
        }
        return parseChildCheck(result);
      },
      revalidate(): string | null {
        let result: unknown;
        try {
          result = Reflect.apply(pure, preparedValue, []);
        } catch (error) {
          return `child prepared revalidate threw: ${boundedReason(error, "unreadable failure")}`;
        }
        if (result === null) return null;
        if (typeof result === "string") return boundedReason(result, "child prepared revalidate refused");
        if (consumeNativePromise(result)) {
          return "child prepared revalidate returned a promise; a primitive final check is required";
        }
        return "child prepared revalidate returned a non-primitive final check";
      },
    }),
  };
}

type ObservationPreparedInvocation =
  | { readonly ok: true; readonly prepared: NativeChildObservationPrepared }
  | { readonly ok: false; readonly reason: string };

function invokeObservationPrepare(
  ports: PortSnapshot & { readonly ok: true },
  eventIdentity: NativeChildReadEventIdentity,
  context: NativeContext,
  expectation: NativeChildReadExpectation,
): ObservationPreparedInvocation {
  let raw: unknown;
  try {
    raw = Reflect.apply(ports.observe, ports.ports, [eventIdentity, context, expectation]);
  } catch (error) {
    return { ok: false, reason: `read observation preparation threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "read observation preparation returned a promise; synchronous preparation is required" };
  }
  const response = readStrictFields(raw, ["ok", "prepared", "reason"], ["ok"]);
  if (response === null) return { ok: false, reason: "read observation preparation returned an unreadable result" };
  if (response.get("ok") === false) {
    return { ok: false, reason: boundedReason(response.get("reason"), "the actual read observation is unauthenticated") };
  }
  if (response.get("ok") !== true) {
    return { ok: false, reason: "read observation preparation returned an unknown result" };
  }
  const preparedValue = response.get("prepared");
  const preparedFields = readStrictFields(preparedValue, ["refresh", "revalidate"], ["refresh", "revalidate"]);
  if (preparedFields === null) {
    return { ok: false, reason: "read observation preparation returned malformed prepared gates" };
  }
  const refreshValue = preparedFields.get("refresh");
  const revalidateValue = preparedFields.get("revalidate");
  if (typeof refreshValue !== "function") {
    return { ok: false, reason: "read observation preparation did not provide its captured refresh" };
  }
  if (typeof revalidateValue !== "function") {
    return { ok: false, reason: "read observation preparation did not provide its captured pure check" };
  }
  const refresh = refreshValue as (this: unknown, context: NativeContext) => unknown;
  const pure = revalidateValue as (this: unknown) => unknown;
  return {
    ok: true,
    prepared: Object.freeze({
      refresh(context: NativeContext): NativeChildCheck {
        let result: unknown;
        try {
          result = Reflect.apply(refresh, preparedValue, [context]);
        } catch (error) {
          return { ok: false, reason: `read observation refresh threw: ${boundedReason(error, "unreadable failure")}` };
        }
        if (consumeNativePromise(result)) {
          return { ok: false, reason: "read observation refresh returned a promise; synchronous refresh is required" };
        }
        return parseChildCheck(result);
      },
      revalidate(): string | null {
        let result: unknown;
        try {
          result = Reflect.apply(pure, preparedValue, []);
        } catch (error) {
          return `read observation revalidate threw: ${boundedReason(error, "unreadable failure")}`;
        }
        if (result === null) return null;
        if (typeof result === "string") return boundedReason(result, "read observation revalidate refused");
        if (consumeNativePromise(result)) {
          return "read observation revalidate returned a promise; a primitive final check is required";
        }
        return "read observation revalidate returned a non-primitive final check";
      },
    }),
  };
}

function tinyError(text: string): NativeToolResult {
  const reason = boundedReason(text, "agent_snapshot failed");
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
    details: {
      schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
      tool: NATIVE_SNAPSHOT_TOOL,
      authority: "non-authoritative",
      taskAccepted: false,
      semanticAcceptance: "not-evaluated",
      reason,
    },
  };
}

function makeResult(
  details: Record<string, unknown>,
  isError: boolean,
  limit: number,
): NativeToolResult | null {
  let text: string;
  try {
    text = JSON.stringify(details);
  } catch {
    return null;
  }
  const result: NativeToolResult = {
    content: [{ type: "text", text }],
    isError,
    details,
  };
  const bytes = encodedBytes(result);
  return bytes !== null && bytes <= limit ? result : null;
}

function makeTextResult(
  details: Record<string, unknown>,
  isError: boolean,
  limit: number,
): NativeToolResult | null {
  let text: string;
  try {
    text = JSON.stringify(details);
  } catch {
    return null;
  }
  const result: NativeToolResult = {
    content: [{ type: "text", text }],
    isError,
  };
  const bytes = encodedBytes(result);
  return bytes !== null && bytes <= limit ? result : null;
}

function cloneResult(result: NativeToolResult): NativeToolResult {
  try {
    return clonePlain(result);
  } catch {
    return tinyError("The cached agent_snapshot result could not be copied.");
  }
}

function notAdmitted(reason: string, action: NativeSnapshotAction | null = null): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "not-admitted",
    historical: false,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the child snapshot operation was not admitted"),
  };
  return makeResult(details, true, MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The child snapshot operation was not admitted and its bounded refusal could not be encoded.");
}

function historicalFailure(
  action: NativeSnapshotAction,
  reason: string,
  extras?: Readonly<Record<string, unknown>>,
): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "historical-operation-result",
    operationOutcome: "failed",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the child snapshot operation failed"),
    ...extras,
  };
  return makeResult(details, true, MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The child snapshot operation failed and its bounded response could not be encoded.");
}

function conflictFailure(action: NativeSnapshotAction, reason: string): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "conflict",
    historical: false,
    stickyConflict: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the actual child snapshot call was reused with different facts"),
  };
  return makeResult(details, true, MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The child snapshot call conflicts with its original operation.");
}

function committedUnavailable(
  action: NativeSnapshotAction,
  ids: Readonly<Record<string, string>>,
  reason: string,
): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "historical-operation-result",
    operationOutcome: "committed-response-unavailable",
    committed: true,
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the child snapshot operation committed but its normal response was unavailable"),
    ...ids,
  };
  return makeResult(details, true, MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The child snapshot operation committed but its bounded response could not be encoded.");
}

function readEncodingFailure(preparation: HandoffReadPreparation): NativeToolResult {
  return historicalFailure(
    "read",
    "the prepared read response exceeded the 256 KiB wrapper encoding limit",
    {
      readPrepared: true,
      readState: "prepared",
      readId: preparation.read.readId,
      offerId: preparation.read.offerId,
    },
  );
}

function makeReadResult(viewJson: string): NativeToolResult | null {
  const result: NativeToolResult = {
    content: [{ type: "text", text: viewJson }],
    isError: false,
  };
  const bytes = encodedBytes(result);
  return bytes !== null && bytes <= MAX_SNAPSHOT_READ_RESPONSE_BYTES ? result : null;
}

const CHECK_CONDITION_WORST_DETAIL = "required text was not found in the captured text";

const checkProjectionBase = (() => {
  const conditions = Array.from({ length: MAX_NATIVE_TEXT_CHECK_CONDITIONS }, () => ({
    id: "",
    result: "fail" as const,
    detail: CHECK_CONDITION_WORST_DETAIL,
  }));
  return {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action: "check",
    resultKind: "historical-operation-result",
    operationOutcome: "succeeded",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    source: NATIVE_HANDOFF_SOURCE,
    receiptId: "0".repeat(36),
    offerId: "0".repeat(36),
    captureId: "0".repeat(36),
    chainId: "0".repeat(36),
    version: Number.MAX_SAFE_INTEGER,
    planDigest: "0".repeat(64),
    checker: {
      id: NATIVE_TEXT_CHECKER_ID,
      version: NATIVE_TEXT_CHECKER_VERSION,
      schemaVersion: NATIVE_TEXT_CHECK_SCHEMA_VERSION,
    },
    checkerCall: { callId: "\uD800".repeat(MAX_ID_CHARS) },
    outcome: "fail",
    conditions,
  } satisfies Record<string, unknown>;
})();

// Strict derivation: the A1 plan JSON is capped at MAX_PLAN_BYTES, so the
// total JSON-encoded condition-id bytes are <= that budget. Re-encoding those
// exact strings in the response can add at most two bytes per UTF-16 code unit
// (\\, \", \uXXXX escaping), and the total id chars are capped at
// 32 * 128. The base projection already includes 32 empty ids, the longest
// fixed condition detail, the maximum call id, and the full response wrapper.
const CHECK_ID_OUTER_EXTRA_BOUND = MAX_NATIVE_TEXT_CHECK_PLAN_BYTES
  + 2 * MAX_NATIVE_TEXT_CHECK_CONDITIONS * MAX_NATIVE_TEXT_CHECK_ID_CHARS;

let checkProjectionFits: boolean | null = null;

function projectionFitsCheck(): boolean {
  if (checkProjectionFits === null) {
    const base = makeTextResult(
      checkProjectionBase,
      false,
      MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES,
    );
    const baseBytes = base === null ? null : encodedBytes(base);
    checkProjectionFits = baseBytes !== null
      && baseBytes + CHECK_ID_OUTER_EXTRA_BOUND <= MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES;
  }
  return checkProjectionFits;
}

function checkPayload(view: HandoffCheckReceiptView): Record<string, unknown> {
  const conditions = view.a1.conditions.map((condition) => ({
    id: condition.id,
    result: condition.result,
    detail: condition.detail,
  }));
  return {
    schema: NATIVE_SNAPSHOT_TOOL_RESULT_SCHEMA,
    tool: NATIVE_SNAPSHOT_TOOL,
    authority: "non-authoritative",
    action: "check",
    resultKind: "historical-operation-result",
    operationOutcome: "succeeded",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    source: view.source,
    receiptId: view.receiptId,
    offerId: view.offerId,
    captureId: view.captureId,
    chainId: view.chainId,
    version: view.version,
    planDigest: view.planDigest,
    checker: {
      id: view.a1.checkerId,
      version: view.a1.checkerVersion,
      schemaVersion: view.a1.schemaVersion,
    },
    checkerCall: { callId: view.checkerCall.callId },
    outcome: view.outcome,
    conditions,
  };
}

function createChildState(coordinator: NativeHandoffCoordinator, store: NativeHandoffStore): ChildState {
  let state = childStates.get(coordinator);
  if (state === undefined) {
    state = { store, slots: [], reads: [] };
    childStates.set(coordinator, state);
  }
  return state;
}

function findSlot(
  state: ChildState,
  consumer: HandoffConsumerRef,
  toolCallId: string,
): OperationSlot | undefined {
  for (const slot of state.slots) {
    if (slot.consumerRef === consumer && slot.toolCallId === toolCallId) return slot;
  }
  return undefined;
}

function findRead(
  state: ChildState,
  consumer: HandoffConsumerRef,
  readCallId: string,
): ReadRecord | undefined {
  for (const read of state.reads) {
    if (read.consumerRef === consumer && read.readCallId === readCallId) return read;
  }
  return undefined;
}

function findReadForSlot(state: ChildState, slot: OperationSlot): ReadRecord | undefined {
  for (const read of state.reads) {
    if (read.slot === slot) return read;
  }
  return undefined;
}

/**
 * A genuine same-call execute conflict is itself a read conflict. Revoke core
 * usability immediately with the original issued refs and view digest; do not
 * wait for a tool_result event that may never arrive. Historical delivered
 * state remains as the core records it.
 */
function revokeReadForSlot(state: ChildState, slot: OperationSlot): void {
  if (slot.action !== "read") return;
  const read = findReadForSlot(state, slot);
  if (read === undefined || read.state === "failed") return;
  try {
    state.store.observeReadResult(
      read.read,
      read.consumerRef,
      read.parentTaskRef,
      read.childToolCallRef,
      read.readCallId,
      read.digest,
      false,
    );
  } catch {
    // The core reports usability through its own store; no second authority.
  }
  read.state = "failed";
  releaseReadSignal(read);
}

function slotConflict(state: ChildState, slot: OperationSlot, reason: string): void {
  if (slot.status.state === "conflict") return;
  slot.status.state = "conflict";
  slot.status.conflictReason = boundedReason(reason, "the actual child snapshot call was reused with different facts");
  revokeReadForSlot(state, slot);
}

function releaseReadSignal(read: ReadRecord): void {
  read.signal = null;
  read.owner.pending.delete(read);
}

function settleSlot(
  slot: OperationSlot,
  result: NativeToolResult,
  read: ReadRecord | null,
): void {
  if (read !== null) {
    slot.response = { kind: "read", read };
  } else {
    try {
      slot.response = { kind: "result", result: deepFreeze(cloneResult(result)) };
    } catch {
      slot.response = { kind: "result", result: tinyError("The child snapshot result could not be cached.") };
    }
  }
  slot.promise = null;
  slot.identityRevalidate = null;
  if (slot.status.state !== "conflict") slot.status.state = "settled";
}

function replayResponse(slot: OperationSlot): NativeToolResult | null {
  if (slot.response === null) return null;
  if (slot.response.kind === "result") return cloneResult(slot.response.result);
  const read = slot.response.read;
  const result = makeReadResult(read.viewJson);
  return result ?? tinyError("The retained prepared read response exceeded its encoding limit.");
}

function finalSlotProblem(
  state: ChildState,
  slot: OperationSlot,
  descriptor: NativeSnapshotRequestDescriptor,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  lifecycle: EntryLifecycle,
): string | null {
  if (lifecycle.disposed) return "the child snapshot entry was disposed";
  if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
    return "the original child root coordinator is no longer current";
  }
  if (state.slots.length > 0) {
    const current = findSlot(state, slot.consumerRef, slot.toolCallId);
    if (current !== slot) return "the original child snapshot operation slot is no longer current";
  } else {
    return "the original child snapshot operation slot is no longer current";
  }
  if (slot.status.state === "conflict") {
    return slot.status.conflictReason ?? "the child snapshot operation conflicted with another request";
  }
  if (slot.status.state !== "running" && slot.status.state !== "settled") {
    return "the child snapshot operation slot is no longer current";
  }
  if (slot.action !== descriptor.action || slot.offerId !== descriptor.params.offerId) {
    return "the child snapshot operation request changed";
  }
  if (slot.requestDigest !== descriptor.digest) return "the child snapshot operation request digest changed";
  if (slot.consumerRef !== resolved.consumerRef || slot.consumerRef !== identity.consumerRef) {
    return "the actual child consumer changed";
  }
  if (slot.childToolCallRef !== identity.childToolCallRef) return "the original child tool call reference changed";
  if (slot.parentTaskRef !== identity.parentTaskRef) return "the actual parent task call changed";
  return null;
}

function effectGate(
  state: ChildState,
  slot: OperationSlot,
  prepared: NativeChildPrepared,
  descriptor: NativeSnapshotRequestDescriptor,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): string | null {
  if (lifecycle.disposed) return "the child snapshot entry was disposed";
  if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
    return "the original child root coordinator is no longer current";
  }
  if (!isActualSubContext(context)) return "the actual context is no longer a sub context";
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) return signalRead.reason;
  if (signalRead.aborted) return "the child snapshot operation was cancelled";
  if (slot.identityRevalidate !== null) {
    const identityPure = invokeFinalRevalidate(slot.identityRevalidate);
    if (!identityPure.ok) return identityPure.reason;
  }
  const preparedPure = invokeFinalRevalidate(prepared.revalidate);
  if (!preparedPure.ok) return preparedPure.reason;
  return finalSlotProblem(state, slot, descriptor, resolved, identity, lifecycle);
}

function replayGate(
  state: ChildState,
  slot: OperationSlot,
  descriptor: NativeSnapshotRequestDescriptor,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): string | null {
  if (lifecycle.disposed) return "the child snapshot entry was disposed";
  if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
    return "the original child root coordinator is no longer current";
  }
  if (!isActualSubContext(context)) return "the actual context is no longer a sub context";
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) return signalRead.reason;
  if (signalRead.aborted) return "this child snapshot invocation was cancelled before replay";
  const identityPure = invokeFinalRevalidate(identity.revalidate);
  if (!identityPure.ok) return identityPure.reason;
  return finalSlotProblem(state, slot, descriptor, resolved, identity, lifecycle);
}

type WaitedOperation =
  | { readonly kind: "settled"; readonly result: NativeToolResult }
  | { readonly kind: "cancelled" };

async function waitForOperation(
  promise: Promise<NativeToolResult>,
  signal: unknown,
): Promise<WaitedOperation> {
  if (ACTUAL_ADD_EVENT_LISTENER === null || ACTUAL_REMOVE_EVENT_LISTENER === null) {
    return { kind: "settled", result: await promise };
  }
  let listener: (() => void) | null = null;
  let cancelled = false;
  const cancellation = new Promise<null>((resolve) => {
    listener = () => {
      cancelled = true;
      resolve(null);
    };
    try {
      Reflect.apply(ACTUAL_ADD_EVENT_LISTENER, signal, ["abort", listener, { once: true }]);
    } catch {
      listener = null;
    }
  });
  try {
    const recheck = readActualAbortSignal(signal);
    if (!recheck.ok || recheck.aborted) {
      const cancel = listener as (() => void) | null;
      if (cancel !== null) cancel();
      return { kind: "cancelled" };
    }
    if (listener === null) return { kind: "settled", result: await promise };
    const raced = await Promise.race([
      promise.then((result) => ({ kind: "settled" as const, result })),
      cancellation,
    ]);
    if (raced === null || cancelled) return { kind: "cancelled" };
    return raced;
  } finally {
    if (listener !== null) {
      try {
        Reflect.apply(ACTUAL_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
      } catch {
        // Best effort; no waiter list is retained.
      }
    }
  }
}

interface OperationOutcome {
  readonly result: NativeToolResult;
  readonly read: ReadRecord | null;
}

function executeNewOperation(
  state: ChildState,
  slot: OperationSlot,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  descriptor: NativeSnapshotRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): OperationOutcome {
  if (lifecycle.disposed) {
    return { result: historicalFailure(slot.action, "the child snapshot entry was disposed"), read: null };
  }
  if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
    return {
      result: historicalFailure(slot.action, "the original child root coordinator is no longer current"),
      read: null,
    };
  }
  if (finalSlotProblem(state, slot, descriptor, resolved, identity, lifecycle) !== null) {
    return {
      result: historicalFailure(
        slot.action,
        finalSlotProblem(state, slot, descriptor, resolved, identity, lifecycle)
          ?? "the original child snapshot operation is no longer current",
      ),
      read: null,
    };
  }

  let offer: HandoffOffer | null;
  let offerView: HandoffOfferView | null;
  try {
    offer = state.store.resolveOffer(slot.offerId);
    offerView = state.store.lookupOffer(slot.offerId);
  } catch (error) {
    return { result: historicalFailure(slot.action, coreFailure(error)), read: null };
  }
  if (offer === null || offerView === null) {
    return { result: historicalFailure(slot.action, "the selected issued offer is unavailable"), read: null };
  }

  if (slot.action === "check" && !projectionFitsCheck()) {
    return {
      result: historicalFailure(slot.action, "the bounded check response projection does not fit"),
      read: null,
    };
  }

  const request: NativeChildPrepareRequest = Object.freeze({
    actualToolCallId: slot.toolCallId,
    childToolCallRef: slot.childToolCallRef,
    consumer: slot.consumerRef,
    parentTaskCall: slot.parentTaskRef,
    callFacts: slot.callFacts,
    requestDigest: slot.requestDigest,
    request: descriptor.params,
    offer,
    offerView,
  });
  const preparation = invokePrepare(resolved.ports, request, context);
  if (!preparation.ok) {
    return { result: historicalFailure(slot.action, preparation.reason), read: null };
  }

  // All response-shape work that does not depend on the core result happens
  // before the final host refresh. The core result is encoded after the
  // synchronous core call, with no host read or await between them.
  const refresh = invokeChildCheck(preparation.prepared.refresh, context);
  if (!refresh.ok) return { result: historicalFailure(slot.action, refresh.reason), read: null };

  const gate = effectGate(
    state,
    slot,
    preparation.prepared,
    descriptor,
    resolved,
    identity,
    context,
    signal,
    lifecycle,
  );
  if (gate !== null) return { result: historicalFailure(slot.action, gate), read: null };

  if (slot.action === "read") {
    if (state.reads.length >= MAX_SNAPSHOT_READ_RECORDS) {
      return {
        result: historicalFailure(slot.action, "the bounded child read-record capacity is exhausted"),
        read: null,
      };
    }
    let readPreparation: HandoffReadPreparation;
    try {
      readPreparation = state.store.prepareRead(
        offer,
        slot.consumerRef,
        slot.parentTaskRef,
        slot.childToolCallRef,
        slot.toolCallId,
      );
    } catch (error) {
      return { result: historicalFailure(slot.action, coreFailure(error)), read: null };
    }
    let viewJson: string;
    try {
      const encoded = JSON.stringify(readPreparation.view);
      if (typeof encoded !== "string") throw new Error("the prepared view could not be encoded");
      viewJson = encoded;
    } catch {
      return { result: readEncodingFailure(readPreparation), read: null };
    }
    if (sha256Hex(viewJson) !== readPreparation.digest) {
      return { result: readEncodingFailure(readPreparation), read: null };
    }
    const result = makeReadResult(viewJson);
    if (result === null) return { result: readEncodingFailure(readPreparation), read: null };
    const readId = readPreparation.read.readId;
    const expectation: NativeChildReadExpectation = Object.freeze({
      read: readPreparation.read,
      readId,
      offerId: readPreparation.read.offerId,
      consumer: slot.consumerRef,
      parentTaskCall: slot.parentTaskRef,
      readToolCall: slot.childToolCallRef,
      readCallId: slot.toolCallId,
      requestDigest: slot.requestDigest,
    });
    const record: ReadRecord = {
      read: readPreparation.read,
      readId,
      offer,
      offerId: readPreparation.read.offerId,
      consumerRef: slot.consumerRef,
      parentTaskRef: slot.parentTaskRef,
      childToolCallRef: slot.childToolCallRef,
      readCallId: slot.toolCallId,
      requestDigest: slot.requestDigest,
      viewJson,
      digest: readPreparation.digest,
      expectation,
      slot,
      owner: lifecycle,
      signal: signal as AbortSignal,
      closed: false,
      state: "pending",
    };
    state.reads.push(record);
    lifecycle.pending.add(record);
    return { result, read: record };
  }

  let receipt;
  try {
    receipt = state.store.check(
      offer,
      slot.consumerRef,
      slot.parentTaskRef,
      slot.childToolCallRef,
      slot.toolCallId,
    );
  } catch (error) {
    return { result: historicalFailure(slot.action, coreFailure(error)), read: null };
  }
  let view: HandoffCheckReceiptView | null;
  try {
    view = state.store.lookupReceipt(receipt.receiptId);
  } catch (error) {
    return {
      result: committedUnavailable(
        "check",
        { receiptId: receipt.receiptId, offerId: slot.offerId, checkerCallId: slot.toolCallId },
        coreFailure(error),
      ),
      read: null,
    };
  }
  if (view === null) {
    return {
      result: committedUnavailable(
        "check",
        { receiptId: receipt.receiptId, offerId: slot.offerId, checkerCallId: slot.toolCallId },
        "the issued check receipt could not be read back",
      ),
      read: null,
    };
  }
  const details = checkPayload(view);
  const result = makeTextResult(details, false, MAX_SNAPSHOT_OPERATION_RESPONSE_BYTES);
  if (result === null) {
    return {
      result: committedUnavailable(
        "check",
        { receiptId: receipt.receiptId, offerId: slot.offerId, checkerCallId: slot.toolCallId },
        "the bounded check response exceeded its encoding limit",
      ),
      read: null,
    };
  }
  return { result, read: null };
}

function runNewOperation(
  state: ChildState,
  slot: OperationSlot,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  descriptor: NativeSnapshotRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  let resolveDeferred: ((result: NativeToolResult) => void) | null = null;
  const promise = new Promise<NativeToolResult>((resolve) => {
    resolveDeferred = resolve;
  });
  // The deferred promise exists before prepare/refresh can reenter execute.
  slot.promise = promise;
  void (async (): Promise<NativeToolResult> => {
    let outcome: OperationOutcome;
    try {
      outcome = executeNewOperation(state, slot, resolved, identity, descriptor, context, signal, lifecycle);
    } catch (error) {
      outcome = {
        result: historicalFailure(
          descriptor.action,
          `the child snapshot operation failed unexpectedly: ${boundedReason(error, "unreadable failure")}`,
        ),
        read: null,
      };
    }
    try {
      settleSlot(slot, outcome.result, outcome.read);
    } catch {
      // Settling uses local data only; the deferred result still resolves.
    }
    return outcome.result;
  })().then(
    (result) => resolveDeferred?.(result),
    (error) => {
      const result = historicalFailure(
        descriptor.action,
        `the child snapshot operation failed unexpectedly: ${boundedReason(error, "unreadable failure")}`,
      );
      try {
        settleSlot(slot, result, null);
      } catch {
        // Local cache failure only; the operation still resolves.
      }
      resolveDeferred?.(result);
    },
  );
  return promise;
}

async function replayRunning(
  state: ChildState,
  slot: OperationSlot,
  descriptor: NativeSnapshotRequestDescriptor,
  resolveRoot: Function,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  const promise = slot.promise;
  if (promise === null) {
    return historicalFailure(descriptor.action, "the running child snapshot operation had no promise");
  }
  const waited = await waitForOperation(promise, signal);
  if (waited.kind === "cancelled") {
    return notAdmitted(
      "this invocation cancelled while waiting; the original child snapshot operation continues",
      descriptor.action,
    );
  }
  const resolved = resolveSnapshotRoot(resolveRoot, context);
  if (!resolved.ok) return notAdmitted(resolved.reason, descriptor.action);
  const stateNow = childStates.get(resolved.coordinator);
  if (stateNow !== state) {
    return notAdmitted("the original child root coordinator is no longer current", descriptor.action);
  }
  const identity = invokeIdentify(
    resolved.ports,
    slot.toolCallId,
    context,
    slot.childToolCallRef,
    descriptor,
    resolved.consumerRef,
  );
  if (!identity.ok) return notAdmitted(identity.reason, descriptor.action);
  const gate = replayGate(state, slot, descriptor, resolved, identity, context, signal, lifecycle);
  if (gate !== null) return notAdmitted(gate, descriptor.action);
  if (slot.status.state === "conflict") {
    return conflictFailure(descriptor.action, slot.status.conflictReason ?? "the child snapshot operation conflicted");
  }
  const response = replayResponse(slot);
  return response ?? historicalFailure(descriptor.action, "the child snapshot operation settled without a response");
}

function handleExistingSlot(
  state: ChildState,
  slot: OperationSlot,
  descriptor: NativeSnapshotRequestDescriptor,
  resolved: RootResolved & { readonly ok: true },
  identity: IdentifyInvocation & { readonly ok: true },
  context: NativeContext,
  signal: unknown,
  resolveRoot: Function,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  if (identity.childToolCallRef !== slot.childToolCallRef) {
    return Promise.resolve(notAdmitted("the original child tool call reference changed", descriptor.action));
  }
  if (identity.consumerRef !== slot.consumerRef) {
    return Promise.resolve(notAdmitted("the actual child consumer changed", descriptor.action));
  }
  if (identity.parentTaskRef !== slot.parentTaskRef) {
    const pure = invokeFinalRevalidate(identity.revalidate);
    if (!pure.ok) return Promise.resolve(notAdmitted(pure.reason, descriptor.action));
    slotConflict(state, slot, "the actual parent task call changed for the same child tool call");
    return Promise.resolve(conflictFailure(descriptor.action, slot.status.conflictReason!));
  }
  if (
    slot.action !== descriptor.action
    || slot.offerId !== descriptor.params.offerId
    || slot.requestDigest !== descriptor.digest
  ) {
    const pure = invokeFinalRevalidate(identity.revalidate);
    if (!pure.ok) return Promise.resolve(notAdmitted(pure.reason, descriptor.action));
    slotConflict(state, slot, "the same child tool call was reused with a different request");
    return Promise.resolve(conflictFailure(descriptor.action, slot.status.conflictReason!));
  }
  if (slot.status.state === "conflict") {
    return Promise.resolve(conflictFailure(descriptor.action, slot.status.conflictReason ?? "the child operation conflicted"));
  }
  if (slot.status.state === "running") {
    return replayRunning(state, slot, descriptor, resolveRoot, context, signal, lifecycle);
  }
  const gate = replayGate(state, slot, descriptor, resolved, identity, context, signal, lifecycle);
  if (gate !== null) return Promise.resolve(notAdmitted(gate, descriptor.action));
  const response = replayResponse(slot);
  return Promise.resolve(
    response ?? historicalFailure(descriptor.action, "the child snapshot operation settled without a response"),
  );
}

function coreFailure(error: unknown): string {
  if (error instanceof NativeHandoffError) {
    return `child handoff core refused the operation (${error.code}): ${boundedReason(error.message, "core refusal")}`;
  }
  return `child handoff core refused the operation: ${boundedReason(error, "unreadable failure")}`;
}

interface EventField {
  readonly readable: boolean;
  readonly present: boolean;
  readonly value: unknown;
}

const UNREADABLE_EVENT_FIELD: EventField = Object.freeze({
  readable: false,
  present: false,
  value: undefined,
});

function eventField(value: unknown, key: string): EventField {
  const field = readOwnData(value, key);
  if (field === null) return UNREADABLE_EVENT_FIELD;
  return { readable: true, present: field.present, value: field.value };
}

interface ExtractedEvent {
  readonly type: "tool_result";
  readonly toolName: string;
  readonly toolCallId: string;
  /** Actual input evidence, never replaced by the original expected params. */
  readonly effectiveInput: NativeSnapshotRequestDescriptor | null;
  readonly content: EventField;
  readonly details: EventField;
  readonly isError: EventField;
}

type EventExtraction =
  | { readonly ok: true; readonly event: ExtractedEvent }
  | { readonly ok: false; readonly reason: string };

function extractToolResultEvent(value: unknown): EventExtraction {
  if (!isRecord(value)) return { ok: false, reason: "the tool_result event is not a plain object" };
  const typeField = readOwnData(value, "type");
  const toolNameField = readOwnData(value, "toolName");
  const toolCallIdField = readOwnData(value, "toolCallId");
  if (
    typeField === null
    || toolNameField === null
    || toolCallIdField === null
    || !typeField.present
    || !toolNameField.present
    || !toolCallIdField.present
  ) {
    return { ok: false, reason: "the tool_result identity fields are not readable own data" };
  }
  if (typeField.value !== "tool_result") return { ok: false, reason: "the event is not a tool_result" };
  if (toolNameField.value !== NATIVE_SNAPSHOT_TOOL) {
    return { ok: false, reason: "the event is not an agent_snapshot call" };
  }
  const toolCallId = boundedString(toolCallIdField.value, MAX_ID_CHARS);
  if (toolCallId === null) return { ok: false, reason: "the event tool call id is invalid" };

  // The input field is evidence only. A malformed or changed input is kept as
  // null or the actual descriptor and becomes a payload failure after the
  // observation port authenticates the actual call, never an identity lookup.
  const inputField = eventField(value, "input");
  let effectiveInput: NativeSnapshotRequestDescriptor | null = null;
  if (inputField.readable && inputField.present) {
    const parsed = parseArguments(inputField.value);
    if (parsed.ok) effectiveInput = parsed.descriptor;
  }
  return {
    ok: true,
    event: {
      type: "tool_result",
      toolName: NATIVE_SNAPSHOT_TOOL,
      toolCallId,
      effectiveInput,
      content: eventField(value, "content"),
      details: eventField(value, "details"),
      isError: eventField(value, "isError"),
    },
  };
}

/**
 * Inspects a plain dense singleton array through own descriptors. It never
 * invokes `length`, an index getter or array methods.
 */
function singletonContent(value: unknown): unknown | null {
  let prototype: object | null;
  let keys: (string | symbol)[];
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value as object);
  } catch {
    return null;
  }
  if (!isArray || prototype !== Array.prototype) return null;
  if (keys.length !== 2) return null;
  for (const key of keys) {
    if (typeof key !== "string" || (key !== "length" && key !== "0")) return null;
  }
  const lengthField = readOwnData(value, "length");
  if (lengthField === null || !lengthField.present || lengthField.value !== 1) return null;
  const item = readOwnData(value, "0");
  if (item === null || !item.present) return null;
  return item.value;
}

interface BoundedText {
  readonly text: string;
  readonly digest: string;
}

/** Cheap char bound first, then bounded UTF-8 bytes, then the hash. */
function boundedText(value: string): BoundedText | null {
  if (value.length > MAX_SNAPSHOT_READ_RESPONSE_BYTES) return null;
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(value).byteLength;
  } catch {
    return null;
  }
  if (bytes > MAX_SNAPSHOT_READ_RESPONSE_BYTES) return null;
  return { text: value, digest: sha256Hex(value) };
}

interface ExactReadPayload {
  readonly exact: true;
  readonly text: string;
  readonly digest: string;
  readonly wrapperBytes: number;
}

function exactReadPayload(content: EventField): ExactReadPayload | null {
  if (!content.readable || !content.present) return null;
  const blockValue = singletonContent(content.value);
  if (blockValue === null) return null;
  const block = readStrictFields(blockValue, ["type", "text"], ["type", "text"]);
  if (block === null) return null;
  if (block.get("type") !== "text") return null;
  const text = block.get("text");
  if (typeof text !== "string") return null;
  const bounded = boundedText(text);
  if (bounded === null) return null;
  const wrapperBytes = encodedBytes({
    content: [{ type: "text", text: bounded.text }],
    isError: false,
  });
  return {
    exact: true,
    text: bounded.text,
    digest: bounded.digest,
    wrapperBytes: wrapperBytes ?? Number.POSITIVE_INFINITY,
  };
}

function bestEffortTextDigest(content: EventField): string | null {
  if (!content.readable || !content.present) return null;
  const blockValue = singletonContent(content.value);
  if (blockValue === null) return null;
  const textField = readOwnData(blockValue, "text");
  if (textField === null || !textField.present || typeof textField.value !== "string") return null;
  return boundedText(textField.value)?.digest ?? null;
}

function detailsAccepted(details: EventField): boolean {
  return details.readable && (!details.present || details.value === undefined);
}

export function createNativeSnapshotEntry(options: NativeSnapshotEntryOptions): NativeSnapshotEntry {
  if (!isRecord(options)) {
    throw new NativeHandoffError("Child snapshot entry options must be an object.", "invalid-input");
  }
  const resolveField = Object.getOwnPropertyDescriptor(options, "resolveChildRoot");
  if (
    resolveField === undefined
    || !("value" in resolveField)
    || typeof resolveField.value !== "function"
  ) {
    throw new NativeHandoffError("Child snapshot entry requires a trusted resolveChildRoot function.", "invalid-input");
  }
  const resolveChildRoot = resolveField.value as Function;
  const lifecycle: EntryLifecycle = { disposed: false, pending: new Set() };

  function stateFor(resolved: RootResolved & { readonly ok: true }): ChildState | null {
    const state = createChildState(resolved.coordinator, resolved.store);
    if (state.store !== resolved.store) return null;
    if (lifecycle.disposed) return null;
    return state;
  }

  const tool: NativeSnapshotTool = {
    name: NATIVE_SNAPSHOT_TOOL,
    label: "Snapshot",
    description: [
      "Read one issued native handoff offer from a real child context, or run its original immutable A1 snapshot checks.",
      "Read prepares an exact view and does not mark it observed; the host tool_result hook must independently observe that same read call.",
      "Check does not require a prior read. Parameters are only action read|check and offerId; no paths, content, identity or success flags.",
    ].join(" "),
    parameters: AGENT_SNAPSHOT_PARAMETERS,
    approval: "read",
    loadMode: "essential",
    defaultInactive: true,
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      context: NativeContext,
    ): Promise<NativeToolResult> {
      if (lifecycle.disposed) return Promise.resolve(notAdmitted("the child snapshot entry is disposed"));
      const actualToolCallId = boundedString(toolCallId, MAX_ID_CHARS);
      if (actualToolCallId === null) {
        return Promise.resolve(notAdmitted("the actual child tool call id is unavailable"));
      }
      const parsed = parseArguments(params);
      if (!parsed.ok) return Promise.resolve(notAdmitted(parsed.reason));
      const descriptor = parsed.descriptor;

      const initialSignal = readActualAbortSignal(signal);
      if (!initialSignal.ok) return Promise.resolve(notAdmitted(initialSignal.reason, descriptor.action));
      if (initialSignal.aborted) {
        return Promise.resolve(notAdmitted("the child snapshot invocation was cancelled before admission", descriptor.action));
      }
      if (!isActualSubContext(context)) {
        return Promise.resolve(notAdmitted("agent_snapshot is available only in an actual sub context", descriptor.action));
      }

      const resolved = resolveSnapshotRoot(resolveChildRoot, context);
      if (!resolved.ok) return Promise.resolve(notAdmitted(resolved.reason, descriptor.action));
      const state = stateFor(resolved);
      if (state === null) {
        return Promise.resolve(notAdmitted("the original child root coordinator is unavailable or closed", descriptor.action));
      }

      const priorSlot = findSlot(state, resolved.consumerRef, actualToolCallId);
      const identity = invokeIdentify(
        resolved.ports,
        actualToolCallId,
        context,
        priorSlot?.childToolCallRef,
        descriptor,
        resolved.consumerRef,
      );
      if (!identity.ok) return Promise.resolve(notAdmitted(identity.reason, descriptor.action));

      // Identification is a host callback and may reenter this actual call.
      // Re-read after consuming its return; never overwrite an existing slot.
      const existingAfterIdentify = findSlot(state, resolved.consumerRef, actualToolCallId);
      if (existingAfterIdentify !== undefined) {
        return handleExistingSlot(
          state,
          existingAfterIdentify,
          descriptor,
          resolved,
          identity,
          context,
          signal,
          resolveChildRoot,
          lifecycle,
        );
      }

      if (state.slots.length >= MAX_SNAPSHOT_OPERATIONS) {
        return Promise.resolve(notAdmitted("the bounded child snapshot operation capacity is exhausted", descriptor.action));
      }
      if (descriptor.action === "check" && !projectionFitsCheck()) {
        return Promise.resolve(notAdmitted("the bounded child check response projection does not fit", descriptor.action));
      }
      const slot: OperationSlot = {
        toolCallId: actualToolCallId,
        consumerRef: resolved.consumerRef,
        parentTaskRef: identity.parentTaskRef,
        childToolCallRef: identity.childToolCallRef,
        action: descriptor.action,
        offerId: descriptor.params.offerId,
        requestDigest: descriptor.digest,
        callFacts: identity.facts,
        status: { state: "running", conflictReason: null },
        identityRevalidate: identity.revalidate,
        promise: null,
        response: null,
      };
      state.slots.push(slot);
      return runNewOperation(state, slot, resolved, identity, descriptor, context, signal, lifecycle);
    },
  };

  function observeToolResult(event: unknown, context: NativeContext): NativeSnapshotObservation {
    if (lifecycle.disposed) return { kind: "ignored", reason: "the child snapshot entry is disposed" };
    const extracted = extractToolResultEvent(event);
    if (!extracted.ok) return { kind: "ignored", reason: extracted.reason };
    const actual = extracted.event;

    const resolved = resolveSnapshotRoot(resolveChildRoot, context);
    if (!resolved.ok) return { kind: "unavailable", reason: resolved.reason };
    const state = stateFor(resolved);
    if (state === null) {
      return { kind: "unavailable", reason: "the original child root coordinator is unavailable or closed" };
    }
    const read = findRead(state, resolved.consumerRef, actual.toolCallId);
    if (read === undefined) return { kind: "ignored", reason: "the event does not match a retained child read call" };
    if (read.owner !== lifecycle) return { kind: "ignored", reason: "the retained child read belongs to another entry" };
    if (read.closed) return { kind: "ignored", reason: "the read observation link was closed by entry dispose" };

    let duplicate = 0;
    for (const candidate of state.reads) {
      if (candidate.consumerRef === resolved.consumerRef && candidate.readCallId === actual.toolCallId) duplicate++;
    }
    if (duplicate !== 1) return { kind: "unavailable", reason: "the retained child read call is ambiguous" };

    // The port authenticates the actual child/parent/read tool call. The
    // actual normalized input is evidence for payload success, never a lookup
    // key and never replaced by the original expected params.
    const eventIdentity: NativeChildReadEventIdentity = Object.freeze({
      type: "tool_result",
      toolName: actual.toolName,
      toolCallId: actual.toolCallId,
      effectiveInput: actual.effectiveInput,
    });
    const observation = invokeObservationPrepare(
      resolved.ports,
      eventIdentity,
      context,
      read.expectation,
    );
    if (!observation.ok) return { kind: "ignored", reason: observation.reason };

    const exact = exactReadPayload(actual.content);
    const wrapperAccepted = exact !== null && exact.wrapperBytes <= MAX_SNAPSHOT_READ_RESPONSE_BYTES;
    const inputAccepted = actual.effectiveInput !== null
      && actual.effectiveInput.action === "read"
      && actual.effectiveInput.params.offerId === read.offerId
      && actual.effectiveInput.digest === read.requestDigest;
    const contentAccepted = exact !== null
      && exact.text === read.viewJson
      && exact.digest === read.digest
      && wrapperAccepted;
    let success = inputAccepted
      && actual.isError.readable
      && actual.isError.value === false
      && detailsAccepted(actual.details)
      && contentAccepted;
    const fullResultDigest = exact?.digest ?? bestEffortTextDigest(actual.content);

    const refresh = invokeChildCheck(observation.prepared.refresh, context);
    if (!refresh.ok) return { kind: "unavailable", reason: refresh.reason };
    if (!isActualSubContext(context)) {
      return { kind: "unavailable", reason: "the actual context is no longer a sub context" };
    }
    if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
      return { kind: "unavailable", reason: "the original child root coordinator is no longer current" };
    }

    let signalFailure: string | null = null;
    if (read.state === "pending" && read.signal === null) {
      return { kind: "unavailable", reason: "the pending child read lost its original execute signal" };
    }
    if (read.signal !== null) {
      const signalRead = readActualAbortSignal(read.signal);
      if (!signalRead.ok) {
        signalFailure = signalRead.reason;
      } else if (signalRead.aborted) {
        signalFailure = "the original child read execution signal was aborted before observation";
      }
    }

    const observationPure = invokeFinalRevalidate(observation.prepared.revalidate);
    if (!observationPure.ok) return { kind: "ignored", reason: observationPure.reason };
    if (lifecycle.disposed) return { kind: "unavailable", reason: "the child snapshot entry is disposed" };
    if (read.owner !== lifecycle || read.closed) {
      return { kind: "ignored", reason: "the read observation link is no longer current for this entry" };
    }
    const readNow = findRead(state, resolved.consumerRef, actual.toolCallId);
    if (readNow !== read) {
      return { kind: "unavailable", reason: "the original child read record is no longer current" };
    }
    if (read.consumerRef !== resolved.consumerRef
      || read.parentTaskRef !== read.expectation.parentTaskCall
      || read.childToolCallRef !== read.expectation.readToolCall
      || read.readCallId !== read.expectation.readCallId) {
      return { kind: "unavailable", reason: "the original child read binding changed" };
    }
    if (getNativeHandoffCoordinatorStore(resolved.coordinator) !== state.store) {
      return { kind: "unavailable", reason: "the original child root coordinator is no longer current" };
    }

    // A genuine same-call slot conflict must revoke a previously delivered
    // usable read through the core sticky failure path. Unauthenticated events
    // never reach this point, so they cannot poison another read.
    const slotNow = findSlot(state, read.consumerRef, read.readCallId);
    const slotProblem = slotNow !== read.slot
      ? "the original child operation slot is no longer current"
      : read.slot.action !== "read"
        || read.slot.toolCallId !== read.readCallId
        || read.slot.offerId !== read.offerId
        || read.slot.requestDigest !== read.requestDigest
        || read.slot.childToolCallRef !== read.childToolCallRef
        || read.slot.parentTaskRef !== read.parentTaskRef
        ? "the original child operation binding changed"
        : read.slot.status.state === "conflict"
          ? read.slot.status.conflictReason ?? "the original child operation conflicted"
          : null;
    if (slotProblem !== null) success = false;

    let observed: boolean;
    try {
      observed = state.store.observeReadResult(
        read.read,
        read.consumerRef,
        read.parentTaskRef,
        read.childToolCallRef,
        read.readCallId,
        fullResultDigest ?? "",
        success && signalFailure === null,
      );
    } catch (error) {
      return { kind: "unavailable", reason: coreFailure(error) };
    }
    if (observed) {
      read.state = "delivered";
    } else {
      read.state = "failed";
    }
    releaseReadSignal(read);
    return { kind: "observed", readId: read.readId, success: observed };
  }

  return Object.freeze({
    tool,
    observeToolResult,
    dispose(): void {
      if (lifecycle.disposed) return;
      lifecycle.disposed = true;
      for (const read of lifecycle.pending) {
        if (read.state !== "pending") continue;
        read.signal = null;
        read.closed = true;
      }
      lifecycle.pending.clear();
    },
  });
}

const AGENT_SNAPSHOT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action", "offerId"],
  properties: {
    action: {
      type: "string",
      enum: ["read", "check"],
      description: "read prepares the exact immutable view; check runs the original A1 snapshot checks without requiring a read.",
    },
    offerId: {
      type: "string",
      minLength: 1,
      maxLength: MAX_ID_CHARS,
      description: "Issued handoff offer already bound by the real A2.2 child seam to this consumer and parent task.",
    },
  },
};
