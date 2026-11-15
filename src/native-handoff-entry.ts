import {
  NativeHandoffError,
  NATIVE_HANDOFF_SOURCE,
  openNativeHandoffStore,
  type HandoffAdoption,
  type HandoffBindingFacts,
  type HandoffCallRef,
  type HandoffCapture,
  type HandoffCaptureReservation,
  type HandoffCaptureView,
  type HandoffCaptureCommit,
  type HandoffCheckReceipt,
  type HandoffCheckReceiptView,
  type HandoffLiveFileFacts,
  type HandoffOffer,
  type HandoffOfferView,
  type HandoffProducerRef,
  type HandoffWorkRef,
  type NativeHandoffStore,
} from "./native-handoff.ts";
import {
  NativeFileError,
  captureWorkspaceText,
  clonePlain,
  deepFreeze,
  nodeFileIo,
  observeWorkspaceFile,
  sha256Hex,
  type NativeFileIo,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";
import type { NativeContext, NativeToolResult } from "./native-entry.ts";

/**
 * Bounded `agent_handoff` main-tool adapter and root-owned operation
 * coordinator. This module owns no second handoff store, scheduler, identity
 * registry or task owner. Root state is created once per actual root and its
 * store is the one already returned by `openNativeHandoffStore(root)`.
 *
 * The trusted ports passed by the real native composition are the only source
 * of actual main/instance/work identities. Nothing here authenticates OMP by
 * itself; the fake-port tests exercise protocol behavior, not real host
 * identity.
 */

export const NATIVE_HANDOFF_TOOL = "agent_handoff";
export const NATIVE_HANDOFF_TOOL_RESULT_SCHEMA = "omp-agent.native-handoff-tool-result.v1";
export const MAX_HANDOFF_OPERATIONS = 64;
export const MAX_HANDOFF_OPERATION_RESPONSE_BYTES = 32 * 1024;
export const MAX_HANDOFF_INSPECT_RESPONSE_BYTES = 256 * 1024;
const MAX_REASON_CHARS = 320;
const MAX_ID_CHARS = 256;
const MAX_PATH_CHARS = 1024;
const MAX_PRODUCER_REF_CHARS = 256;
const MAX_COPY_DEPTH = 8;
const MAX_COPY_NODES = 4096;
const MAX_COPY_ARRAY_ITEMS = 64;
const MAX_COPY_OBJECT_KEYS = 16;
const MAX_COPY_KEY_CHARS = 128;
const MAX_COPY_STRING_CHARS = 8192;

export type NativeHandoffAction = "capture" | "offer" | "adopt" | "inspect";

export interface NativeHandoffProducerSelector {
  readonly instanceId: string;
  readonly parentToolCallId: string;
  readonly envelopeSha256: string;
}

export type NativeHandoffParsedRequest =
  | { readonly action: "inspect" }
  | {
      readonly action: "capture";
      readonly mode: "initial";
      readonly producer: NativeHandoffProducerSelector;
      readonly relativePath: string;
      readonly conditions: readonly unknown[];
    }
  | {
      readonly action: "capture";
      readonly mode: "repair";
      readonly producer: NativeHandoffProducerSelector;
      readonly fromOfferId: string;
    }
  | {
      readonly action: "offer";
      readonly captureId: string;
      readonly failAdoptionId: string | null;
    }
  | {
      readonly action: "adopt";
      readonly receiptId: string;
      readonly captureId: string;
      readonly consumerParentToolCallId: string;
    };

export type NativeHandoffRequestDescriptor =
  | {
      readonly action: "inspect";
      /** SHA-256 of the fixed-order, bounded parsed request. */
      readonly digest: string;
      readonly params: Extract<NativeHandoffParsedRequest, { action: "inspect" }>;
    }
  | {
      readonly action: "capture";
      readonly digest: string;
      readonly params: Extract<NativeHandoffParsedRequest, { action: "capture" }>;
    }
  | {
      readonly action: "offer";
      readonly digest: string;
      readonly params: Extract<NativeHandoffParsedRequest, { action: "offer" }>;
    }
  | {
      readonly action: "adopt";
      readonly digest: string;
      readonly params: Extract<NativeHandoffParsedRequest, { action: "adopt" }>;
    };

/** Validated adapter work identity; this is not a native Work pointer. */
export interface NativeHandoffWorkFacts {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

export type NativeHandoffCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type NativeHandoffCallIdentity =
  | {
      readonly ok: true;
      readonly callRef: object;
      readonly work: NativeHandoffWorkFacts;
      /**
       * Captured pure identity check. It must not perform late host reads; the
       * entry calls it after the actual context/signal reads and before any
       * cached settlement is returned.
       */
      readonly revalidate: () => string | null;
    }
  | { readonly ok: false; readonly reason: string };

interface NativeHandoffPrepareBase {
  readonly actualToolCallId: string;
  /** The original native call ref from the first identification. Never swapped. */
  readonly nativeCallRef: object;
  readonly requestDigest: string;
}

export type NativeHandoffPrepareRequest =
  | (NativeHandoffPrepareBase & {
      readonly kind: "capture-initial";
      readonly request: Extract<NativeHandoffParsedRequest, { mode: "initial" }>;
    })
  | (NativeHandoffPrepareBase & {
      readonly kind: "capture-repair";
      readonly request: Extract<NativeHandoffParsedRequest, { mode: "repair" }>;
      readonly fromOffer: HandoffOffer;
      readonly offerView: HandoffOfferView;
      readonly captureView: HandoffCaptureView;
      readonly expectedHeadCaptureId: string;
      readonly expectedChainVersion: number;
    })
  | (NativeHandoffPrepareBase & {
      readonly kind: "offer";
      readonly request: Extract<NativeHandoffParsedRequest, { action: "offer" }>;
      readonly capture: HandoffCapture;
      readonly captureView: HandoffCaptureView;
      readonly failAdoption: HandoffAdoption | null;
    })
  | (NativeHandoffPrepareBase & {
      readonly kind: "adopt";
      readonly request: Extract<NativeHandoffParsedRequest, { action: "adopt" }>;
      readonly receipt: HandoffCheckReceipt;
      readonly receiptView: HandoffCheckReceiptView;
      readonly capture: HandoffCapture;
      readonly captureView: HandoffCaptureView;
    });

export interface NativeHandoffPreparedBase {
  readonly work: NativeHandoffWorkFacts;
  /** Synchronous actual host reads for the original preparation reference. */
  refresh(context: NativeContext): NativeHandoffCheck;
  /** Pure captured-identity check; null succeeds, only a string refuses. */
  revalidate(): string | null;
}

export type NativeHandoffPreparedOperation =
  | (NativeHandoffPreparedBase & {
      readonly kind: "capture-initial";
      readonly producer: object;
      readonly producerFacts: HandoffBindingFacts;
      readonly proposalFacts: HandoffBindingFacts;
    })
  | (NativeHandoffPreparedBase & {
      readonly kind: "capture-repair";
      readonly producer: object;
      readonly producerFacts: HandoffBindingFacts;
    })
  | (NativeHandoffPreparedBase & {
      readonly kind: "offer";
      readonly producer: object;
    })
  | (NativeHandoffPreparedBase & {
      readonly kind: "adopt";
      readonly producer: object;
      readonly consumer: object;
      readonly consumerParentToolCallId: string;
    });

export type NativeHandoffPrepareResult =
  | { readonly ok: true; readonly prepared: NativeHandoffPreparedOperation }
  | { readonly ok: false; readonly reason: string };

/**
 * INTERNAL trusted-composition ports. Both methods are synchronous and may
 * reject changed actual main/root/work identity. They must return plain,
 * bounded facts; throws, promises, malformed shapes and unknown fields are
 * refused by the entry.
 */
export interface NativeHandoffPorts {
  identifyMainCall(
    actualToolCallId: string,
    context: NativeContext,
    priorOriginalNativeCallRef: object | undefined,
    request: NativeHandoffRequestDescriptor,
  ): NativeHandoffCallIdentity;

  prepareMain(
    request: NativeHandoffPrepareRequest,
    context: NativeContext,
  ): NativeHandoffPrepareResult;
}

export interface NativeHandoffResolvedRoot {
  readonly ok: true;
  readonly coordinator: NativeHandoffCoordinator;
  readonly ports: NativeHandoffPorts;
}

export interface NativeHandoffRootUnavailable {
  readonly ok: false;
  readonly reason: string;
}

export type NativeHandoffRootResolution = NativeHandoffResolvedRoot | NativeHandoffRootUnavailable;

export interface NativeHandoffCoordinatorOptions {
  /** INTERNAL trusted clamp-down for tests; fixed at first creation. */
  readonly maxOperations?: number;
}

/**
 * Opaque root coordinator handle. The entry recognizes its own instances by
 * exact private issuance; a clone or arbitrary object with the same shape is
 * not a coordinator.
 */
export interface NativeHandoffCoordinator {
  readonly closed: boolean;
  close(): void;
}

export interface NativeHandoffEntryOptions {
  resolveRoot(context: NativeContext): NativeHandoffRootResolution;
  now?: () => number;
  fileIo?: NativeFileIo;
}

export interface NativeHandoffTool {
  readonly name: typeof NATIVE_HANDOFF_TOOL;
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

export interface NativeHandoffEntry {
  readonly tool: NativeHandoffTool;
  /** Releases only this entry; never closes the root coordinator or store. */
  dispose(): void;
}

type SlotState = "running" | "settled" | "conflict";

interface OperationSlot {
  readonly toolCallId: string;
  readonly originalCallRef: object;
  readonly action: "capture" | "offer" | "adopt";
  readonly digest: string;
  readonly workRef: HandoffWorkRef;
  readonly work: NativeHandoffWorkFacts;
  identityRevalidate: (() => string | null) | null;
  state: SlotState;
  conflictReason: string | null;
  promise: Promise<NativeToolResult> | null;
  response: NativeToolResult | null;
  committed: boolean;
}

interface CoordinatorState {
  readonly rootRef: object;
  readonly store: NativeHandoffStore;
  readonly slots: Map<string, OperationSlot>;
  readonly maxOperations: number;
  closed: boolean;
}

const coordinatorStates = new WeakMap<object, CoordinatorState>();
const coordinatorsByRoot = new WeakMap<object, NativeHandoffCoordinator>();

function clampOperations(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_HANDOFF_OPERATIONS;
  return Math.min(MAX_HANDOFF_OPERATIONS, Math.max(1, Math.floor(value)));
}

function readCoordinatorLimit(options: unknown): number {
  if (options === undefined) return MAX_HANDOFF_OPERATIONS;
  let fields: StrictFields | null;
  try {
    fields = readStrictFields(options, ["maxOperations"], []);
  } catch {
    fields = null;
  }
  if (fields === null) {
    throw new NativeHandoffError("Handoff coordinator options are malformed.", "invalid-input");
  }
  const value = fields.get("maxOperations");
  if (value === undefined) return MAX_HANDOFF_OPERATIONS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new NativeHandoffError("Handoff coordinator maxOperations must be a finite number.", "invalid-input");
  }
  return clampOperations(value);
}

/**
 * Creates the single coordinator for one actual root. The store is the exact
 * instance already owned by `openNativeHandoffStore(root)`. Repeating this call
 * returns the original coordinator (including a closed one), never a fresh
 * root lifetime.
 */
export function createNativeHandoffCoordinator(
  rootRef: object,
  options?: NativeHandoffCoordinatorOptions,
): NativeHandoffCoordinator {
  if (typeof rootRef !== "object" || rootRef === null || Array.isArray(rootRef)) {
    throw new NativeHandoffError("Root reference must be an opaque object.", "invalid-input");
  }
  // Options are read as bounded own data before any existing-root lookup, so a
  // getter/reentry cannot replace a coordinator that already owns this root.
  const maxOperations = readCoordinatorLimit(options);
  const existing = coordinatorsByRoot.get(rootRef);
  if (existing !== undefined) return existing;
  const store = openNativeHandoffStore(rootRef);
  const createdDuringStoreOpen = coordinatorsByRoot.get(rootRef);
  if (createdDuringStoreOpen !== undefined) return createdDuringStoreOpen;
  const state: CoordinatorState = {
    rootRef,
    store,
    slots: new Map(),
    maxOperations,
    closed: false,
  };
  const coordinator: NativeHandoffCoordinator = Object.freeze({
    get closed(): boolean {
      return state.closed;
    },
    close(): void {
      if (state.closed) return;
      state.closed = true;
    },
  });
  coordinatorStates.set(coordinator, state);
  coordinatorsByRoot.set(rootRef, coordinator);
  return coordinator;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpaqueRef(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function boundedSha256(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
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

interface EntryLifecycle {
  disposed: boolean;
}

/** Explicitly reads the actual context as main; throws/unknown/sub are refused. */
function isActualMainContext(context: unknown): boolean {
  try {
    return typeof context === "object"
      && context !== null
      && (context as NativeContext).agent?.kind === "main";
  } catch {
    return false;
  }
}

type ActualAbortRead =
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string };

/** Brand-check one actual host AbortSignal through the captured native getter. */
function readActualAbortSignal(signal: unknown): ActualAbortRead {
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}

interface CopyBudget {
  nodes: number;
}

/** Bounded plain-data copy. This is not a condition schema; A1 remains the validator. */
function copyBoundedPlain(value: unknown, budget: CopyBudget, depth: number): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_COPY_NODES || depth > MAX_COPY_DEPTH) {
    throw new Error("The handoff request contains too much or too deeply nested data.");
  }
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      if (value.length > MAX_COPY_STRING_CHARS) throw new Error("The handoff request contains an oversized string.");
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error("The handoff request contains a non-finite number.");
      return value;
    case "boolean":
      return value;
    case "object": {
      if (Array.isArray(value)) {
        let prototype: object | null;
        try {
          prototype = Object.getPrototypeOf(value);
        } catch {
          throw new Error("The handoff request array could not be inspected.");
        }
        if (prototype !== Array.prototype) {
          throw new Error("The handoff request must contain only plain arrays.");
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        const length = lengthDescriptor?.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length > MAX_COPY_ARRAY_ITEMS) {
          throw new Error("The handoff request contains an oversized array.");
        }
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)))) {
          throw new Error("The handoff request contains unsupported array properties.");
        }
        if (keys.length > length + 1) throw new Error("The handoff request contains unsupported array properties.");
        const copy: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            descriptor === undefined
            || !("value" in descriptor)
            || descriptor.get !== undefined
            || descriptor.set !== undefined
            || descriptor.enumerable !== true
          ) {
            throw new Error("The handoff request array must contain enumerable plain data.");
          }
          copy.push(copyBoundedPlain(descriptor.value, budget, depth + 1));
        }
        return copy;
      }
      let prototype: object | null;
      let keys: (string | symbol)[];
      try {
        prototype = Object.getPrototypeOf(value);
        keys = Reflect.ownKeys(value);
      } catch {
        throw new Error("The handoff request could not be inspected.");
      }
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("The handoff request must contain only plain objects.");
      }
      if (keys.length > MAX_COPY_OBJECT_KEYS || keys.some((key) => typeof key !== "string")) {
        throw new Error("The handoff request contains unsupported object properties.");
      }
      // Null prototype plus own defineProperty preserves names such as
      // __proto__ as literal fields for A1 to accept or reject.
      const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of keys as string[]) {
        if (key.length > MAX_COPY_KEY_CHARS) throw new Error("The handoff request contains an oversized field name.");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.get !== undefined
          || descriptor.set !== undefined
          || descriptor.enumerable !== true
        ) {
          throw new Error("The handoff request must contain only own data properties.");
        }
        Object.defineProperty(copy, key, {
          value: copyBoundedPlain(descriptor.value, budget, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return copy;
    }
    default:
      throw new Error("The handoff request contains unsupported data.");
  }
}

function parseProducerSelector(value: unknown): NativeHandoffProducerSelector | null {
  const fields = readStrictFields(
    value,
    ["instanceId", "parentToolCallId", "envelopeSha256"],
    ["instanceId", "parentToolCallId", "envelopeSha256"],
  );
  if (fields === null) return null;
  const instanceId = boundedString(fields.get("instanceId"), MAX_PRODUCER_REF_CHARS);
  const parentToolCallId = boundedString(fields.get("parentToolCallId"), MAX_PRODUCER_REF_CHARS);
  const envelopeSha256 = boundedSha256(fields.get("envelopeSha256"));
  if (instanceId === null || parentToolCallId === null || envelopeSha256 === null) return null;
  return Object.freeze({ instanceId, parentToolCallId, envelopeSha256 });
}

function makeDescriptor(params: NativeHandoffParsedRequest): NativeHandoffRequestDescriptor {
  const digest = sha256Hex(canonicalJson(params));
  return Object.freeze({
    action: params.action,
    digest,
    params: deepFreeze(params),
  }) as NativeHandoffRequestDescriptor;
}

type ParsedArguments =
  | { readonly ok: true; readonly descriptor: NativeHandoffRequestDescriptor }
  | { readonly ok: false; readonly reason: string };

/** Strict mutually-exclusive parameter parsing with no unknown fields. */
function parseArguments(value: unknown): ParsedArguments {
  if (!isRecord(value)) return { ok: false, reason: "agent_handoff arguments must be a plain object" };
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return { ok: false, reason: "agent_handoff arguments could not be inspected" };
  }
  if (keys.some((key) => typeof key !== "string")) {
    return { ok: false, reason: "agent_handoff arguments must not contain symbol properties" };
  }
  const actionDescriptor = Object.getOwnPropertyDescriptor(value, "action");
  if (actionDescriptor === undefined || !("value" in actionDescriptor)) {
    return { ok: false, reason: "agent_handoff requires an own data action field" };
  }
  const action = actionDescriptor.value;
  if (action === "inspect") {
    const fields = readStrictFields(value, ["action"], ["action"]);
    if (fields === null) return { ok: false, reason: "agent_handoff inspect has unsupported fields" };
    return { ok: true, descriptor: makeDescriptor({ action: "inspect" }) };
  }
  if (action === "capture") {
    const fields = readStrictFields(
      value,
      ["action", "producer", "relativePath", "conditions", "fromOfferId"],
      ["action", "producer"],
    );
    if (fields === null) return { ok: false, reason: "agent_handoff capture has unsupported fields" };
    const producer = parseProducerSelector(fields.get("producer"));
    if (producer === null) return { ok: false, reason: "agent_handoff capture producer selector is invalid" };
    const hasInitial = fields.has("relativePath") || fields.has("conditions");
    const hasRepair = fields.has("fromOfferId");
    if (hasInitial === hasRepair) {
      return { ok: false, reason: "agent_handoff capture must provide either relativePath and conditions, or fromOfferId, but not both" };
    }
    if (hasRepair) {
      const fromOfferId = boundedString(fields.get("fromOfferId"), MAX_ID_CHARS);
      if (fromOfferId === null) return { ok: false, reason: "agent_handoff capture fromOfferId is invalid" };
      return {
        ok: true,
        descriptor: makeDescriptor({ action: "capture", mode: "repair", producer, fromOfferId }),
      };
    }
    const relativePath = boundedString(fields.get("relativePath"), MAX_PATH_CHARS);
    if (relativePath === null) return { ok: false, reason: "agent_handoff capture relativePath is invalid" };
    const conditionsRaw = fields.get("conditions");
    if (!Array.isArray(conditionsRaw)) {
      return { ok: false, reason: "agent_handoff capture conditions must be an array" };
    }
    let copied: unknown;
    try {
      copied = copyBoundedPlain(conditionsRaw, { nodes: 0 }, 0);
    } catch (error) {
      return { ok: false, reason: boundedReason(error, "agent_handoff capture conditions are not plain bounded data") };
    }
    return {
      ok: true,
      descriptor: makeDescriptor({
        action: "capture",
        mode: "initial",
        producer,
        relativePath,
        conditions: copied as readonly unknown[],
      }),
    };
  }
  if (action === "offer") {
    const fields = readStrictFields(value, ["action", "captureId", "failAdoptionId"], ["action", "captureId"]);
    if (fields === null) return { ok: false, reason: "agent_handoff offer has unsupported fields" };
    const captureId = boundedString(fields.get("captureId"), MAX_ID_CHARS);
    if (captureId === null) return { ok: false, reason: "agent_handoff offer captureId is invalid" };
    const failRaw = fields.get("failAdoptionId");
    const failAdoptionId = failRaw === undefined ? null : boundedString(failRaw, MAX_ID_CHARS);
    if (failRaw !== undefined && failAdoptionId === null) {
      return { ok: false, reason: "agent_handoff offer failAdoptionId is invalid" };
    }
    return {
      ok: true,
      descriptor: makeDescriptor({ action: "offer", captureId, failAdoptionId }),
    };
  }
  if (action === "adopt") {
    const fields = readStrictFields(
      value,
      ["action", "receiptId", "captureId", "consumerParentToolCallId"],
      ["action", "receiptId", "captureId", "consumerParentToolCallId"],
    );
    if (fields === null) return { ok: false, reason: "agent_handoff adopt has unsupported fields" };
    const receiptId = boundedString(fields.get("receiptId"), MAX_ID_CHARS);
    const captureId = boundedString(fields.get("captureId"), MAX_ID_CHARS);
    const consumerParentToolCallId = boundedString(fields.get("consumerParentToolCallId"), MAX_ID_CHARS);
    if (receiptId === null || captureId === null || consumerParentToolCallId === null) {
      return { ok: false, reason: "agent_handoff adopt selectors are invalid" };
    }
    return {
      ok: true,
      descriptor: makeDescriptor({ action: "adopt", receiptId, captureId, consumerParentToolCallId }),
    };
  }
  return { ok: false, reason: "agent_handoff action must be capture, offer, adopt or inspect" };
}

function parseWorkFacts(value: unknown): NativeHandoffWorkFacts | null {
  const fields = readStrictFields(
    value,
    ["observationId", "generation", "sessionId", "workspaceRoot"],
    ["observationId", "generation", "sessionId", "workspaceRoot"],
  );
  if (fields === null) return null;
  const observationId = boundedString(fields.get("observationId"), MAX_ID_CHARS);
  const generation = fields.get("generation");
  const sessionId = boundedString(fields.get("sessionId"), MAX_ID_CHARS);
  const workspaceRoot = boundedString(fields.get("workspaceRoot"), 4096);
  if (
    observationId === null
    || typeof generation !== "number"
    || !Number.isSafeInteger(generation)
    || generation < 1
    || sessionId === null
    || workspaceRoot === null
  ) {
    return null;
  }
  return Object.freeze({ observationId, generation, sessionId, workspaceRoot });
}

function sameWork(left: NativeHandoffWorkFacts, right: NativeHandoffWorkFacts): boolean {
  return left.observationId === right.observationId
    && left.generation === right.generation
    && left.sessionId === right.sessionId
    && left.workspaceRoot === right.workspaceRoot;
}

function parseBindingFacts(value: unknown): HandoffBindingFacts | null {
  const fields = readStrictFields(
    value,
    ["callId", "workId", "definitionVersion"],
    ["callId", "workId", "definitionVersion"],
  );
  if (fields === null) return null;
  const callId = boundedString(fields.get("callId"), MAX_ID_CHARS);
  const workId = boundedString(fields.get("workId"), MAX_ID_CHARS);
  const definitionVersion = boundedString(fields.get("definitionVersion"), MAX_ID_CHARS);
  if (callId === null || workId === null || definitionVersion === null) return null;
  return Object.freeze({ callId, workId, definitionVersion });
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

type PortSnapshot =
  | {
      readonly ok: true;
      readonly ports: NativeHandoffPorts;
      readonly identify: Function;
      readonly prepare: Function;
    }
  | { readonly ok: false; readonly reason: string };

function snapshotPorts(value: unknown): PortSnapshot {
  if (!isOpaqueRef(value)) return { ok: false, reason: "trusted handoff ports are unavailable" };
  const identify = readCallable(value, "identifyMainCall");
  const prepare = readCallable(value, "prepareMain");
  if (identify === null || prepare === null) {
    return { ok: false, reason: "trusted handoff ports are incomplete" };
  }
  return { ok: true, ports: value as NativeHandoffPorts, identify, prepare };
}

type RootResolved =
  | {
      readonly ok: true;
      readonly coordinator: NativeHandoffCoordinator;
      readonly state: CoordinatorState;
      readonly ports: PortSnapshot & { readonly ok: true };
    }
  | { readonly ok: false; readonly reason: string };

function resolveEntryRoot(resolveRoot: Function, context: NativeContext): RootResolved {
  let raw: unknown;
  try {
    raw = Reflect.apply(resolveRoot, undefined, [context]);
  } catch (error) {
    return { ok: false, reason: `root resolution threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "root resolution returned a promise; synchronous resolution is required" };
  }
  const fields = readStrictFields(raw, ["ok", "coordinator", "ports", "reason"], ["ok"]);
  if (fields === null) return { ok: false, reason: "root resolution returned an unreadable result" };
  if (fields.get("ok") === false) {
    const reason = fields.get("reason");
    return {
      ok: false,
      reason: boundedReason(reason, "the handoff root is unavailable"),
    };
  }
  if (fields.get("ok") !== true) return { ok: false, reason: "root resolution returned an unknown result" };
  const coordinator = fields.get("coordinator");
  if (!isOpaqueRef(coordinator)) return { ok: false, reason: "root resolution supplied no coordinator" };
  const state = coordinatorStates.get(coordinator);
  if (state === undefined) return { ok: false, reason: "root resolution supplied a foreign coordinator" };
  if (state.closed) return { ok: false, reason: "the root handoff coordinator is closed" };
  const ports = snapshotPorts(fields.get("ports"));
  if (!ports.ok) return ports;
  return { ok: true, coordinator: coordinator as NativeHandoffCoordinator, state, ports };
}

type IdentifyInvocation =
  | {
      readonly ok: true;
      readonly callRef: object;
      readonly work: NativeHandoffWorkFacts;
      readonly revalidate: () => string | null;
    }
  | { readonly ok: false; readonly reason: string };

function invokeIdentify(
  ports: PortSnapshot & { readonly ok: true },
  actualToolCallId: string,
  context: NativeContext,
  prior: object | undefined,
  descriptor: NativeHandoffRequestDescriptor,
): IdentifyInvocation {
  let raw: unknown;
  try {
    raw = Reflect.apply(ports.identify, ports.ports, [actualToolCallId, context, prior, descriptor]);
  } catch (error) {
    return { ok: false, reason: `handoff call identification threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "handoff call identification returned a promise; synchronous identification is required" };
  }
  const fields = readStrictFields(raw, ["ok", "callRef", "work", "reason", "revalidate"], ["ok"]);
  if (fields === null) return { ok: false, reason: "handoff call identification returned an unreadable result" };
  if (fields.get("ok") === false) {
    return { ok: false, reason: boundedReason(fields.get("reason"), "the actual handoff main call is unavailable") };
  }
  if (fields.get("ok") !== true) return { ok: false, reason: "handoff call identification returned an unknown result" };
  const callRef = fields.get("callRef");
  if (!isOpaqueRef(callRef)) return { ok: false, reason: "handoff call identification returned no actual call reference" };
  const work = parseWorkFacts(fields.get("work"));
  if (work === null) return { ok: false, reason: "handoff call identification returned malformed work facts" };
  const revalidateValue = fields.get("revalidate");
  if (typeof revalidateValue !== "function") {
    return { ok: false, reason: "handoff call identification did not provide its captured pure check" };
  }
  const pure = revalidateValue as (this: unknown) => unknown;
  const identityValue = raw;
  const revalidate = (): string | null => {
    let result: unknown;
    try {
      result = Reflect.apply(pure, identityValue, []);
    } catch (error) {
      return `handoff identity revalidate threw: ${boundedReason(error, "unreadable failure")}`;
    }
    if (result === null) return null;
    if (typeof result === "string") return boundedReason(result, "handoff identity revalidate refused");
    if (consumeNativePromise(result)) {
      return "handoff identity revalidate returned a promise; a primitive final check is required";
    }
    return "handoff identity revalidate returned a non-primitive final check";
  };
  return { ok: true, callRef, work, revalidate };
}

type PreparedInvocation =
  | {
      readonly ok: true;
      readonly prepared: NativeHandoffPreparedOperation;
    }
  | { readonly ok: false; readonly reason: string };

const PREPARED_KEYS = [
  "kind",
  "work",
  "producer",
  "producerFacts",
  "proposalFacts",
  "consumer",
  "consumerParentToolCallId",
  "refresh",
  "revalidate",
] as const;

/** Copies all prepared facts and callbacks once, before any file I/O. */
function invokePrepare(
  ports: PortSnapshot & { readonly ok: true },
  request: NativeHandoffPrepareRequest,
  context: NativeContext,
): PreparedInvocation {
  let raw: unknown;
  try {
    raw = Reflect.apply(ports.prepare, ports.ports, [request, context]);
  } catch (error) {
    return { ok: false, reason: `handoff preparation threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "handoff preparation returned a promise; synchronous preparation is required" };
  }
  const response = readStrictFields(raw, ["ok", "prepared", "reason"], ["ok"]);
  if (response === null) return { ok: false, reason: "handoff preparation returned an unreadable result" };
  if (response.get("ok") === false) {
    return { ok: false, reason: boundedReason(response.get("reason"), "the handoff operation is unavailable") };
  }
  if (response.get("ok") !== true) return { ok: false, reason: "handoff preparation returned an unknown result" };
  const preparedValue = response.get("prepared");
  if (!isOpaqueRef(preparedValue)) return { ok: false, reason: "handoff preparation returned no prepared operation" };
  const fields = readStrictFields(preparedValue, PREPARED_KEYS, ["kind", "work", "refresh", "revalidate"]);
  if (fields === null) return { ok: false, reason: "handoff preparation returned malformed facts" };
  const kindValue = fields.get("kind");
  if (kindValue !== request.kind) return { ok: false, reason: "handoff preparation returned the wrong operation kind" };
  const kind = kindValue as NativeHandoffPreparedOperation["kind"];
  const allowedForKind = kind === "capture-initial"
    ? ["kind", "work", "refresh", "revalidate", "producer", "producerFacts", "proposalFacts"]
    : kind === "capture-repair"
      ? ["kind", "work", "refresh", "revalidate", "producer", "producerFacts"]
      : kind === "offer"
        ? ["kind", "work", "refresh", "revalidate", "producer"]
        : ["kind", "work", "refresh", "revalidate", "producer", "consumer", "consumerParentToolCallId"];
  for (const key of fields.keys()) {
    if (!allowedForKind.includes(key)) {
      return { ok: false, reason: "handoff preparation returned fields that do not belong to this operation kind" };
    }
  }
  const work = parseWorkFacts(fields.get("work"));
  if (work === null) return { ok: false, reason: "handoff preparation returned malformed work facts" };
  const refreshValue = fields.get("refresh");
  const revalidateValue = fields.get("revalidate");
  if (typeof refreshValue !== "function" || typeof revalidateValue !== "function") {
    return { ok: false, reason: "handoff preparation did not provide synchronous refresh and revalidate methods" };
  }
  const refreshFn = refreshValue as (this: unknown, context: NativeContext) => unknown;
  const revalidateFn = revalidateValue as (this: unknown) => unknown;
  const refresh = (nextContext: NativeContext): NativeHandoffCheck => {
    let result: unknown;
    try {
      result = Reflect.apply(refreshFn, preparedValue, [nextContext]);
    } catch (error) {
      return { ok: false, reason: `handoff refresh threw: ${boundedReason(error, "unreadable failure")}` };
    }
    if (consumeNativePromise(result)) {
      return { ok: false, reason: "handoff refresh returned a promise; a synchronous check is required" };
    }
    const check = readStrictFields(result, ["ok", "reason"], ["ok"]);
    if (check === null) return { ok: false, reason: "handoff refresh returned an unreadable check" };
    if (check.get("ok") === true) return { ok: true };
    if (check.get("ok") === false) {
      return { ok: false, reason: boundedReason(check.get("reason"), "the handoff operation is no longer current") };
    }
    return { ok: false, reason: "handoff refresh returned an unknown check" };
  };
  const revalidate = (): string | null => {
    let result: unknown;
    try {
      result = Reflect.apply(revalidateFn, preparedValue, []);
    } catch (error) {
      return `handoff revalidate threw: ${boundedReason(error, "unreadable failure")}`;
    }
    if (result === null) return null;
    if (typeof result === "string") return boundedReason(result, "handoff revalidate refused");
    if (consumeNativePromise(result)) {
      return "handoff revalidate returned a promise; a primitive final check is required";
    }
    return "handoff revalidate returned a non-primitive final check";
  };

  const base = { kind, work, refresh, revalidate } as const;
  if (kind === "capture-initial") {
    const producer = fields.get("producer");
    const producerFacts = parseBindingFacts(fields.get("producerFacts"));
    const proposalFacts = parseBindingFacts(fields.get("proposalFacts"));
    if (!isOpaqueRef(producer) || producerFacts === null || proposalFacts === null) {
      return { ok: false, reason: "handoff capture preparation returned malformed producer facts" };
    }
    return { ok: true, prepared: { ...base, kind, producer, producerFacts, proposalFacts } };
  }
  if (kind === "capture-repair") {
    const producer = fields.get("producer");
    const producerFacts = parseBindingFacts(fields.get("producerFacts"));
    if (!isOpaqueRef(producer) || producerFacts === null) {
      return { ok: false, reason: "handoff repair preparation returned malformed producer facts" };
    }
    return { ok: true, prepared: { ...base, kind, producer, producerFacts } };
  }
  if (kind === "offer") {
    const producer = fields.get("producer");
    if (!isOpaqueRef(producer)) {
      return { ok: false, reason: "handoff offer preparation returned no source producer" };
    }
    return { ok: true, prepared: { ...base, kind, producer } };
  }
  const producer = fields.get("producer");
  const consumer = fields.get("consumer");
  const consumerParentToolCallId = boundedString(fields.get("consumerParentToolCallId"), MAX_ID_CHARS);
  if (!isOpaqueRef(producer) || !isOpaqueRef(consumer) || consumerParentToolCallId === null) {
    return { ok: false, reason: "handoff adoption preparation returned malformed consumer facts" };
  }
  return {
    ok: true,
    prepared: { ...base, kind, producer, consumer, consumerParentToolCallId },
  };
}

function historicalFailure(
  action: NativeHandoffAction,
  reason: string,
  extras?: Readonly<Record<string, unknown>>,
): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "historical-operation-result",
    operationOutcome: "failed",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the handoff operation failed"),
    ...extras,
  };
  return makeResult(details, true, MAX_HANDOFF_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The handoff operation failed and its bounded response could not be encoded.");
}

function notAdmitted(reason: string, action: NativeHandoffAction | null = null): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "not-admitted",
    historical: false,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the handoff operation was not admitted"),
  };
  return makeResult(details, true, MAX_HANDOFF_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The handoff operation was not admitted; the bounded refusal could not be encoded.");
}

function conflictFailure(action: NativeHandoffAction, reason: string): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "conflict",
    historical: false,
    stickyConflict: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the actual handoff call was reused with different facts"),
  };
  return makeResult(details, true, MAX_HANDOFF_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The handoff call conflicts with its original operation.");
}

function tinyError(text: string): NativeToolResult {
  const reason = boundedReason(text, "handoff operation failed");
  return {
    content: [{ type: "text", text: reason }],
    isError: true,
    details: {
      schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
      tool: NATIVE_HANDOFF_TOOL,
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
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    return encoded <= limit ? result : null;
  } catch {
    return null;
  }
}

function cloneResult(result: NativeToolResult): NativeToolResult {
  try {
    return clonePlain(result);
  } catch {
    return tinyError("The cached handoff operation result could not be copied.");
  }
}

function commonSuccess(action: NativeHandoffAction): Record<string, unknown> {
  return {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "historical-operation-result",
    operationOutcome: "succeeded",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    source: NATIVE_HANDOFF_SOURCE,
  };
}

const projectionCache = new Map<string, boolean>();

/** Conservative fixed-shape proof that a mutation response fits 32KiB. */
function projectionFits(action: "capture" | "offer" | "adopt"): boolean {
  const cached = projectionCache.get(action);
  if (cached !== undefined) return cached;
  // A lone surrogate is expanded by JSON.stringify and its backslash is then
  // escaped again inside the single text block. Only fields this action can
  // actually emit are included at their known legal bounds.
  const worst = "\uD800";
  const id = worst.repeat(36);
  const digest = "0".repeat(64);
  const path = worst.repeat(MAX_PATH_CHARS);
  const file = { relativePath: path, bytes: 262144, sha256: digest };
  const base: Record<string, unknown> = {
    ...commonSuccess(action),
    captureId: id,
    offerId: id,
    chainId: id,
    version: Number.MAX_SAFE_INTEGER,
    planDigest: digest,
    file,
  };
  let details: Record<string, unknown>;
  if (action === "capture") {
    details = {
      ...base,
      proposalCallId: worst.repeat(MAX_ID_CHARS),
      producerCallId: worst.repeat(MAX_ID_CHARS),
      initial: true,
      baseCaptureId: id,
      repairOfferId: id,
      offerState: "open",
    };
  } else if (action === "offer") {
    details = {
      ...base,
      failAdoptionId: id,
      offerState: "open",
    };
  } else {
    details = {
      ...base,
      adoptionId: id,
      receiptId: id,
      outcome: "pass",
      adoptionCall: { callId: worst.repeat(MAX_ID_CHARS) },
    };
  }
  const fits = makeResult(details, false, MAX_HANDOFF_OPERATION_RESPONSE_BYTES) !== null;
  projectionCache.set(action, fits);
  return fits;
}

function captureFile(view: HandoffCaptureView): Record<string, unknown> {
  return {
    relativePath: view.file.relativePath,
    bytes: view.file.bytes,
    sha256: view.file.sha256,
  };
}

function buildCaptureResponse(
  store: NativeHandoffStore,
  commit: HandoffCaptureCommit,
): NativeToolResult | null {
  const view = store.lookupCapture(commit.capture.captureId);
  const offerView = store.lookupOffer(commit.offer.offerId);
  if (view === null || offerView === null) return null;
  const details: Record<string, unknown> = {
    ...commonSuccess("capture"),
    captureId: view.captureId,
    offerId: offerView.offerId,
    chainId: view.chainId,
    version: view.version,
    planDigest: view.planDigest,
    file: captureFile(view),
    initial: view.initial,
    baseCaptureId: view.baseCaptureId,
    repairOfferId: view.repairOfferId,
    proposalCallId: view.proposal.callId,
    producerCallId: view.producer.callId,
    offerState: offerView.state,
  };
  return makeResult(details, false, MAX_HANDOFF_OPERATION_RESPONSE_BYTES);
}

function buildOfferResponse(
  store: NativeHandoffStore,
  offer: HandoffOffer,
): NativeToolResult | null {
  const offerView = store.lookupOffer(offer.offerId);
  if (offerView === null) return null;
  const captureView = store.lookupCapture(offerView.captureId);
  if (captureView === null) return null;
  const details: Record<string, unknown> = {
    ...commonSuccess("offer"),
    offerId: offerView.offerId,
    captureId: offerView.captureId,
    chainId: offerView.chainId,
    version: offerView.version,
    planDigest: offerView.planDigest,
    file: captureFile(captureView),
    offerState: offerView.state,
    failAdoptionId: offerView.failAdoptionId,
  };
  return makeResult(details, false, MAX_HANDOFF_OPERATION_RESPONSE_BYTES);
}

function buildAdoptionResponse(
  store: NativeHandoffStore,
  adoption: HandoffAdoption,
): NativeToolResult | null {
  const view = store.lookupAdoption(adoption.adoptionId);
  if (view === null) return null;
  const details: Record<string, unknown> = {
    ...commonSuccess("adopt"),
    adoptionId: view.adoptionId,
    receiptId: view.receiptId,
    offerId: view.offerId,
    captureId: view.captureId,
    chainId: view.chainId,
    version: view.version,
    planDigest: view.planDigest,
    file: view.file,
    outcome: view.outcome,
    adoptionCall: view.adoptionCall,
  };
  return makeResult(details, false, MAX_HANDOFF_OPERATION_RESPONSE_BYTES);
}

function committedUnavailable(
  action: "capture" | "offer" | "adopt",
  ids: Readonly<Record<string, string>>,
  reason: string,
): NativeToolResult {
  const details: Record<string, unknown> = {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action,
    resultKind: "historical-operation-result",
    operationOutcome: "committed-response-unavailable",
    committed: true,
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    reason: boundedReason(reason, "the handoff operation committed but its normal response was unavailable"),
    ...ids,
  };
  return makeResult(details, true, MAX_HANDOFF_OPERATION_RESPONSE_BYTES)
    ?? tinyError("The handoff operation committed but its bounded response could not be encoded.");
}

function readClock(now: () => number): number | null {
  try {
    const value = now();
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function fileFailure(error: unknown): string {
  if (error instanceof NativeFileError) {
    return `workspace file observation failed (${error.code}): ${boundedReason(error.message, "file error")}`;
  }
  return `workspace file observation failed: ${boundedReason(error, "unreadable failure")}`;
}

function coreFailure(error: unknown): string {
  if (error instanceof NativeHandoffError) {
    return `handoff core refused the operation (${error.code}): ${boundedReason(error.message, "core refusal")}`;
  }
  return `handoff core refused the operation: ${boundedReason(error, "unreadable failure")}`;
}

function slotConflict(slot: OperationSlot, reason: string): void {
  if (slot.state === "conflict") return;
  slot.state = "conflict";
  slot.conflictReason = boundedReason(reason, "the actual handoff call was reused with different facts");
}

function invokeFinalRevalidate(check: () => string | null): NativeHandoffCheck {
  let raw: unknown;
  try {
    raw = check();
  } catch (error) {
    return { ok: false, reason: `handoff revalidate threw: ${boundedReason(error, "unreadable failure")}` };
  }
  if (raw === null) return { ok: true };
  if (typeof raw === "string") {
    return { ok: false, reason: boundedReason(raw, "handoff revalidate refused") };
  }
  if (consumeNativePromise(raw)) {
    return { ok: false, reason: "handoff revalidate returned a promise; a primitive final check is required" };
  }
  return { ok: false, reason: "handoff revalidate returned a non-primitive final check" };
}

function finalOperationFailure(
  state: CoordinatorState,
  slot: OperationSlot,
  prepared: NativeHandoffPreparedOperation,
  descriptor: NativeHandoffRequestDescriptor,
  lifecycle: EntryLifecycle,
): string | null {
  if (lifecycle.disposed) return "the handoff entry was disposed";
  if (state.closed) return "the root handoff coordinator was closed";
  if (state.slots.get(slot.toolCallId) !== slot) return "the original handoff operation slot is no longer current";
  if (slot.state === "conflict") {
    return slot.conflictReason ?? "the handoff operation conflicted with another request";
  }
  if (slot.state !== "running") return "the handoff operation slot is no longer running";
  if (slot.action !== descriptor.action || slot.digest !== descriptor.digest) {
    return "the handoff operation request digest changed";
  }
  if (!sameWork(slot.work, prepared.work)) return "the handoff operation work identity changed";
  return null;
}

/**
 * Final replay gate. All host reads (identity, actual main context, native
 * signal) finish before the captured identity pure check and structural slot
 * checks. No host identify or resolver call follows this function.
 */
/**
 * Pre-effect/final pure gate. Actual context kind, native signal, captured
 * identity revalidate, prepared revalidate and the original coordinator/slot
 * checks all finish before any file-system effect or core mutation.
 */
function effectGate(
  state: CoordinatorState,
  slot: OperationSlot,
  prepared: NativeHandoffPreparedOperation,
  descriptor: NativeHandoffRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): string | null {
  if (!isActualMainContext(context)) return "the actual context is no longer a main context";
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) return signalRead.reason;
  if (signalRead.aborted) return "the handoff operation was cancelled";
  if (slot.identityRevalidate !== null) {
    const identityPure = invokeFinalRevalidate(slot.identityRevalidate);
    if (!identityPure.ok) return identityPure.reason;
  }
  const preparedPure = invokeFinalRevalidate(prepared.revalidate);
  if (!preparedPure.ok) return preparedPure.reason;
  const slotProblem = finalOperationFailure(state, slot, prepared, descriptor, lifecycle);
  if (slotProblem !== null) return slotProblem;
  return null;
}

function replayGate(
  state: CoordinatorState,
  slot: OperationSlot,
  identity: IdentifyInvocation & { readonly ok: true },
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): string | null {
  if (!isActualMainContext(context)) return "the actual context is no longer a main context";
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) return signalRead.reason;
  if (signalRead.aborted) return "this invocation was cancelled before replay";
  const identityPure = invokeFinalRevalidate(identity.revalidate);
  if (!identityPure.ok) return identityPure.reason;
  if (lifecycle.disposed) return "the handoff entry was disposed";
  if (state.closed) return "the root handoff coordinator was closed";
  if (state.slots.get(slot.toolCallId) !== slot) return "the original handoff operation slot is no longer current";
  if (slot.originalCallRef !== identity.callRef) return "the original native handoff call reference changed";
  if (!sameWork(slot.work, identity.work)) return "the actual handoff work changed";
  return null;
}

function createSlot(
  state: CoordinatorState,
  toolCallId: string,
  action: "capture" | "offer" | "adopt",
  digest: string,
  work: NativeHandoffWorkFacts,
  originalCallRef: object,
  identityRevalidate: (() => string | null) | null,
): OperationSlot | null {
  if (state.closed || state.slots.has(toolCallId) || state.slots.size >= state.maxOperations) return null;
  let workRef: HandoffWorkRef | null = null;
  for (const candidate of state.slots.values()) {
    if (sameWork(candidate.work, work)) {
      workRef = candidate.workRef;
      break;
    }
  }
  // The first retained token is created only after admission, not as a
  // separate unbounded registry entry.
  if (workRef === null) workRef = Object.freeze({});
  const slot: OperationSlot = {
    toolCallId,
    originalCallRef,
    action,
    digest,
    workRef,
    work,
    identityRevalidate,
    state: "running",
    conflictReason: null,
    promise: null,
    response: null,
    committed: false,
  };
  state.slots.set(toolCallId, slot);
  return slot;
}

function settleSlot(slot: OperationSlot, result: NativeToolResult, committed: boolean): void {
  slot.committed = slot.committed || committed;
  try {
    slot.response = deepFreeze(cloneResult(result));
  } catch {
    slot.response = tinyError("The handoff operation result could not be cached.");
  }
  slot.promise = null;
  slot.identityRevalidate = null;
  if (slot.state !== "conflict") slot.state = "settled";
}

type OperationOutcome = {
  readonly result: NativeToolResult;
  readonly committed: boolean;
};

function prepareFailure(action: NativeHandoffAction, reason: string): OperationOutcome {
  return { result: historicalFailure(action, reason), committed: false };
}

function commitCaptureResult(
  store: NativeHandoffStore,
  commit: HandoffCaptureCommit,
): NativeToolResult {
  try {
    const encoded = buildCaptureResponse(store, commit);
    if (encoded !== null) return encoded;
  } catch {
    // Fall through to the honest committed/unavailable result.
  }
  return committedUnavailable(
    "capture",
    { captureId: commit.capture.captureId, offerId: commit.offer.offerId },
    "the capture committed but its full response could not be encoded",
  );
}

async function executeCapture(
  state: CoordinatorState,
  slot: OperationSlot,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: Extract<NativeHandoffRequestDescriptor, { action: "capture" }>,
  context: NativeContext,
  signal: unknown,
  now: () => number,
  fileIo: NativeFileIo,
  lifecycle: EntryLifecycle,
): Promise<OperationOutcome> {
  const store = state.store;
  const request = descriptor.params;
  let offerHandle: HandoffOffer | null = null;
  let offerView: HandoffOfferView | null = null;
  let captureView: HandoffCaptureView | null = null;
  let ensureExactRefs = true;
  if (request.mode === "repair") {
    const resolved = store.resolveOffer(request.fromOfferId);
    if (resolved === null) return prepareFailure("capture", "the repair source offer is unavailable");
    offerHandle = resolved;
    offerView = store.lookupOffer(request.fromOfferId);
    if (offerView === null) return prepareFailure("capture", "the repair source offer is unavailable");
    captureView = store.lookupCapture(offerView.captureId);
    if (captureView === null) return prepareFailure("capture", "the repair source capture is unavailable");
  }

  const prepareRequest: NativeHandoffPrepareRequest = request.mode === "initial"
    ? {
        kind: "capture-initial",
        actualToolCallId: toolCallId,
        nativeCallRef: slot.originalCallRef,
        requestDigest: descriptor.digest,
        request,
      }
    : {
        kind: "capture-repair",
        actualToolCallId: toolCallId,
        nativeCallRef: slot.originalCallRef,
        requestDigest: descriptor.digest,
        request,
        fromOffer: offerHandle!,
        offerView: offerView!,
        captureView: captureView!,
        expectedHeadCaptureId: captureView!.captureId,
        expectedChainVersion: captureView!.version,
      };
  const preparedResult = invokePrepare(ports, prepareRequest, context);
  if (!preparedResult.ok) return prepareFailure("capture", preparedResult.reason);
  const prepared = preparedResult.prepared;
  if (!sameWork(prepared.work, slot.work)) {
    return prepareFailure("capture", "the prepared work does not match the actual call work");
  }
  if (prepared.kind === "capture-initial") {
    if (prepared.proposalFacts.callId !== toolCallId
      || prepared.proposalFacts.callId === prepared.producerFacts.callId
      || prepared.producerFacts.callId !== request.producer.parentToolCallId) {
      return prepareFailure("capture", "the prepared proposal and producer facts do not match the actual calls");
    }
  } else if (prepared.kind === "capture-repair") {
    if (prepared.producerFacts.callId !== request.producer.parentToolCallId) {
      return prepareFailure("capture", "the prepared repair producer facts do not match the selected producer");
    }
  } else {
    return prepareFailure("capture", "the prepared capture kind is invalid");
  }

  const preRefresh = prepared.refresh(context);
  if (!preRefresh.ok) return prepareFailure("capture", preRefresh.reason);
  if (!projectionFits("capture")) {
    return prepareFailure("capture", "the bounded capture response projection does not fit");
  }
  const observedAt = readClock(now);
  if (observedAt === null) return prepareFailure("capture", "the handoff clock is unavailable");
  const relativePath = request.mode === "initial" ? request.relativePath : captureView!.relativePath;
  const preEffect = effectGate(state, slot, prepared, descriptor, context, signal, lifecycle);
  if (preEffect !== null) return prepareFailure("capture", preEffect);

  let reservation: HandoffCaptureReservation | null = null;
  try {
    try {
      if (prepared.kind === "capture-initial" && request.mode === "initial") {
        reservation = store.reserveCapture({
          work: slot.workRef,
          producer: prepared.producer,
          producerFacts: prepared.producerFacts,
          proposalCall: slot.originalCallRef,
          proposalFacts: prepared.proposalFacts,
          relativePath: request.relativePath,
          conditions: request.conditions,
        });
      } else if (prepared.kind === "capture-repair" && request.mode === "repair") {
        reservation = store.reserveRepairCapture({
          fromOffer: offerHandle!,
          work: slot.workRef,
          producer: prepared.producer,
          producerFacts: prepared.producerFacts,
          expectedHeadCaptureId: captureView!.captureId,
          expectedChainVersion: captureView!.version,
        });
      } else {
        return prepareFailure("capture", "the prepared capture kind does not match the request");
      }
    } catch (error) {
      return prepareFailure("capture", coreFailure(error));
    }

    let snapshot: NativeWorkspaceTextSnapshot;
    try {
      snapshot = await captureWorkspaceText(
        prepared.work.workspaceRoot,
        relativePath,
        fileIo,
        observedAt,
      );
    } catch (error) {
      return prepareFailure("capture", fileFailure(error));
    }

    const finalRefresh = prepared.refresh(context);
    if (!finalRefresh.ok) return prepareFailure("capture", finalRefresh.reason);
    const finalEffect = effectGate(state, slot, prepared, descriptor, context, signal, lifecycle);
    if (finalEffect !== null) return prepareFailure("capture", finalEffect);

    let commit: HandoffCaptureCommit;
    try {
      commit = store.commitCapture(reservation, snapshot);
      reservation = null;
    } catch (error) {
      return prepareFailure("capture", coreFailure(error));
    }
    return { result: commitCaptureResult(store, commit), committed: true };
  } finally {
    if (reservation !== null) {
      try {
        store.abandonCapture(reservation);
      } catch {
        // The core may already have released it on an atomic refusal.
      }
    }
  }
}

async function executeOffer(
  state: CoordinatorState,
  slot: OperationSlot,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: Extract<NativeHandoffRequestDescriptor, { action: "offer" }>,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): Promise<OperationOutcome> {
  const store = state.store;
  const request = descriptor.params;
  const capture = store.resolveCapture(request.captureId);
  if (capture === null) return prepareFailure("offer", "the capture selector is unavailable");
  const captureView = store.lookupCapture(request.captureId);
  if (captureView === null) return prepareFailure("offer", "the capture selector is unavailable");
  let failAdoption: HandoffAdoption | null = null;
  if (request.failAdoptionId !== null) {
    failAdoption = store.resolveAdoption(request.failAdoptionId);
    if (failAdoption === null) return prepareFailure("offer", "the FAIL adoption selector is unavailable");
  }

  const preparedResult = invokePrepare(ports, {
    kind: "offer",
    actualToolCallId: toolCallId,
    nativeCallRef: slot.originalCallRef,
    requestDigest: descriptor.digest,
    request,
    capture,
    captureView,
    failAdoption,
  }, context);
  if (!preparedResult.ok) return prepareFailure("offer", preparedResult.reason);
  const prepared = preparedResult.prepared;
  if (prepared.kind !== "offer") return prepareFailure("offer", "the prepared offer kind is invalid");
  if (!sameWork(prepared.work, slot.work)) {
    return prepareFailure("offer", "the prepared work does not match the actual call work");
  }
  if (!projectionFits("offer")) {
    return prepareFailure("offer", "the bounded offer response projection does not fit");
  }

  const finalRefresh = prepared.refresh(context);
  if (!finalRefresh.ok) return prepareFailure("offer", finalRefresh.reason);
  const finalEffect = effectGate(state, slot, prepared, descriptor, context, signal, lifecycle);
  if (finalEffect !== null) return prepareFailure("offer", finalEffect);

  if (!store.matchesCaptureBinding(capture, slot.workRef, prepared.producer)) {
    return prepareFailure("offer", "the source capture is not bound to the actual work and producer");
  }

  let offer: HandoffOffer;
  try {
    offer = store.offer(capture, failAdoption ?? undefined);
  } catch (error) {
    return prepareFailure("offer", coreFailure(error));
  }
  try {
    const encoded = buildOfferResponse(store, offer);
    if (encoded !== null) return { result: encoded, committed: true };
  } catch {
    // Fall through to the honest committed/unavailable result.
  }
  return {
    result: committedUnavailable(
      "offer",
      { offerId: offer.offerId },
      "the offer committed but its full response could not be encoded",
    ),
    committed: true,
  };
}

async function executeAdopt(
  state: CoordinatorState,
  slot: OperationSlot,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: Extract<NativeHandoffRequestDescriptor, { action: "adopt" }>,
  context: NativeContext,
  signal: unknown,
  now: () => number,
  fileIo: NativeFileIo,
  lifecycle: EntryLifecycle,
): Promise<OperationOutcome> {
  const store = state.store;
  const request = descriptor.params;
  const receipt = store.resolveCheckReceipt(request.receiptId);
  if (receipt === null) return prepareFailure("adopt", "the receipt selector is unavailable");
  const capture = store.resolveCapture(request.captureId);
  if (capture === null) return prepareFailure("adopt", "the capture selector is unavailable");
  const receiptView = store.lookupReceipt(request.receiptId);
  const captureView = store.lookupCapture(request.captureId);
  if (receiptView === null || captureView === null || receiptView.captureId !== captureView.captureId) {
    return prepareFailure("adopt", "the receipt and capture selectors do not belong together");
  }

  const preparedResult = invokePrepare(ports, {
    kind: "adopt",
    actualToolCallId: toolCallId,
    nativeCallRef: slot.originalCallRef,
    requestDigest: descriptor.digest,
    request,
    receipt,
    receiptView,
    capture,
    captureView,
  }, context);
  if (!preparedResult.ok) return prepareFailure("adopt", preparedResult.reason);
  const prepared = preparedResult.prepared;
  if (prepared.kind !== "adopt") return prepareFailure("adopt", "the prepared adoption kind is invalid");
  if (!sameWork(prepared.work, slot.work)) {
    return prepareFailure("adopt", "the prepared work does not match the actual call work");
  }
  if (prepared.consumerParentToolCallId !== request.consumerParentToolCallId) {
    return prepareFailure("adopt", "the selected consumer parent call does not match the actual consumer");
  }

  const preRefresh = prepared.refresh(context);
  if (!preRefresh.ok) return prepareFailure("adopt", preRefresh.reason);
  if (!projectionFits("adopt")) {
    return prepareFailure("adopt", "the bounded adoption response projection does not fit");
  }

  const observedAt = readClock(now);
  if (observedAt === null) return prepareFailure("adopt", "the handoff clock is unavailable");
  const preEffect = effectGate(state, slot, prepared, descriptor, context, signal, lifecycle);
  if (preEffect !== null) return prepareFailure("adopt", preEffect);

  let observed;
  try {
    observed = await observeWorkspaceFile(
      prepared.work.workspaceRoot,
      captureView.relativePath,
      fileIo,
      observedAt,
    );
  } catch (error) {
    return prepareFailure("adopt", fileFailure(error));
  }
  const file: HandoffLiveFileFacts = {
    relativePath: observed.relativePath,
    bytes: observed.bytes,
    sha256: observed.sha256,
  };

  const finalRefresh = prepared.refresh(context);
  if (!finalRefresh.ok) return prepareFailure("adopt", finalRefresh.reason);
  const finalEffect = effectGate(state, slot, prepared, descriptor, context, signal, lifecycle);
  if (finalEffect !== null) return prepareFailure("adopt", finalEffect);

  let adoption: HandoffAdoption;
  try {
    adoption = store.adopt({
      receipt,
      capture,
      work: slot.workRef,
      consumer: prepared.consumer,
      producer: prepared.producer,
      file,
      adoptionCall: slot.originalCallRef as HandoffCallRef,
      adoptionCallId: toolCallId,
    });
  } catch (error) {
    return prepareFailure("adopt", coreFailure(error));
  }
  try {
    const encoded = buildAdoptionResponse(store, adoption);
    if (encoded !== null) return { result: encoded, committed: true };
  } catch {
    // Fall through to the honest committed/unavailable result.
  }
  return {
    result: committedUnavailable(
      "adopt",
      { adoptionId: adoption.adoptionId },
      "the adoption committed but its full response could not be encoded",
    ),
    committed: true,
  };
}

async function executeNewOperation(
  state: CoordinatorState,
  slot: OperationSlot,
  coordinator: NativeHandoffCoordinator,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: NativeHandoffRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  now: () => number,
  fileIo: NativeFileIo,
  lifecycle: EntryLifecycle,
): Promise<OperationOutcome> {
  if (descriptor.action === "inspect") {
    return prepareFailure("inspect", "inspect must not create an operation slot");
  }
  if (state.closed || state.slots.get(toolCallId) !== slot) {
    return prepareFailure(descriptor.action, "the original handoff operation is no longer current");
  }
  return descriptor.action === "capture"
    ? executeCapture(state, slot, ports, toolCallId, descriptor, context, signal, now, fileIo, lifecycle)
    : descriptor.action === "offer"
      ? executeOffer(state, slot, ports, toolCallId, descriptor, context, signal, lifecycle)
      : executeAdopt(state, slot, ports, toolCallId, descriptor, context, signal, now, fileIo, lifecycle);
}

function runNewOperation(
  state: CoordinatorState,
  slot: OperationSlot,
  coordinator: NativeHandoffCoordinator,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: NativeHandoffRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  now: () => number,
  fileIo: NativeFileIo,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  let resolveDeferred: ((result: NativeToolResult) => void) | null = null;
  const promise = new Promise<NativeToolResult>((resolve) => {
    resolveDeferred = resolve;
  });
  // The slot promise exists before any prepare/refresh/read callback can
  // reenter execute, so synchronous reentry joins instead of starting again.
  slot.promise = promise;
  void (async (): Promise<NativeToolResult> => {
    let outcome: OperationOutcome;
    try {
      outcome = await executeNewOperation(
        state,
        slot,
        coordinator,
        ports,
        toolCallId,
        descriptor,
        context,
        signal,
        now,
        fileIo,
        lifecycle,
      );
    } catch (error) {
      outcome = prepareFailure(
        descriptor.action === "inspect" ? "inspect" : descriptor.action,
        `the handoff operation failed unexpectedly: ${boundedReason(error, "unreadable failure")}`,
      );
    }
    try {
      settleSlot(slot, outcome.result, outcome.committed);
    } catch {
      // Settling uses only local plain data; a failure must still release the
      // deferred promise with an honest bounded terminal result.
    }
    return outcome.result;
  })().then(
    (result) => resolveDeferred?.(result),
    (error) => {
      const result = prepareFailure(
        descriptor.action === "inspect" ? "inspect" : descriptor.action,
        `the handoff operation failed unexpectedly: ${boundedReason(error, "unreadable failure")}`,
      ).result;
      try {
        settleSlot(slot, result, false);
      } catch {
        // Local cache failure only; the operation still resolves below.
      }
      resolveDeferred?.(result);
    },
  );
  return promise;
}

type WaitedOperation =
  | { readonly kind: "settled"; readonly result: NativeToolResult }
  | { readonly kind: "cancelled" };

/**
 * Waits for the original operation while allowing this joining invocation to
 * abandon only its own wait. It never aborts or replaces the owner's signal.
 */
async function waitForOperation(
  promise: Promise<NativeToolResult>,
  signal: unknown,
): Promise<WaitedOperation> {
  if (
    ACTUAL_ADD_EVENT_LISTENER === null
    || ACTUAL_REMOVE_EVENT_LISTENER === null
  ) {
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
        // Listener removal is best effort; no waiter list is retained here.
      }
    }
  }
}

async function replayRunning(
  initialCoordinator: NativeHandoffCoordinator,
  initialState: CoordinatorState,
  slot: OperationSlot,
  descriptor: NativeHandoffRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  resolveRoot: Function,
  toolCallId: string,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  const promise = slot.promise;
  if (promise === null) {
    return historicalFailure(descriptor.action, "the running handoff operation had no promise");
  }
  const waited = await waitForOperation(promise, signal);
  if (waited.kind === "cancelled") {
    return notAdmitted("this invocation cancelled while waiting; the original handoff operation continues", descriptor.action);
  }

  // The joining invocation must verify its own current context, not reuse the
  // original execution context or a second root.
  const resolved = resolveEntryRoot(resolveRoot, context);
  if (!resolved.ok) return notAdmitted(resolved.reason, descriptor.action);
  if (resolved.coordinator !== initialCoordinator || resolved.state !== initialState) {
    return notAdmitted("the original handoff root coordinator is no longer current", descriptor.action);
  }
  if (resolved.state.closed) return notAdmitted("the root handoff coordinator is closed", descriptor.action);
  const identity = invokeIdentify(resolved.ports, toolCallId, context, slot.originalCallRef, descriptor);
  if (!identity.ok) return notAdmitted(identity.reason, descriptor.action);
  const replayProblem = replayGate(initialState, slot, identity, context, signal, lifecycle);
  if (replayProblem !== null) return notAdmitted(replayProblem, descriptor.action);
  if (slot.state === "conflict") {
    return conflictFailure(descriptor.action, slot.conflictReason ?? "the handoff operation conflicted");
  }
  if (slot.response === null) {
    return historicalFailure(descriptor.action, "the handoff operation settled without a cached response");
  }
  return cloneResult(slot.response);
}

function handleExistingSlot(
  coordinator: NativeHandoffCoordinator,
  state: CoordinatorState,
  slot: OperationSlot,
  identity: IdentifyInvocation & { readonly ok: true },
  descriptor: NativeHandoffRequestDescriptor,
  context: NativeContext,
  signal: unknown,
  resolveRoot: Function,
  toolCallId: string,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  if (identity.callRef !== slot.originalCallRef) {
    return Promise.resolve(notAdmitted("the original native handoff call reference changed", descriptor.action));
  }
  if (!sameWork(identity.work, slot.work)) {
    slotConflict(slot, "the actual work changed for the same handoff tool call");
    return Promise.resolve(conflictFailure(descriptor.action, slot.conflictReason!));
  }
  if (slot.action !== descriptor.action || slot.digest !== descriptor.digest) {
    slotConflict(slot, "the same handoff tool call was reused with a different request");
    return Promise.resolve(conflictFailure(descriptor.action, slot.conflictReason!));
  }
  if (slot.state === "conflict") {
    return Promise.resolve(conflictFailure(descriptor.action, slot.conflictReason ?? "the handoff operation conflicted"));
  }
  if (slot.state === "running") {
    return replayRunning(coordinator, state, slot, descriptor, context, signal, resolveRoot, toolCallId, lifecycle);
  }
  if (slot.response === null) {
    return Promise.resolve(historicalFailure(descriptor.action, "the handoff operation settled without a cached response"));
  }
  const replayProblem = replayGate(state, slot, identity, context, signal, lifecycle);
  if (replayProblem !== null) return Promise.resolve(notAdmitted(replayProblem, descriptor.action));
  return Promise.resolve(cloneResult(slot.response));
}

function executeInspect(
  state: CoordinatorState,
  ports: PortSnapshot & { readonly ok: true },
  toolCallId: string,
  descriptor: Extract<NativeHandoffRequestDescriptor, { action: "inspect" }>,
  context: NativeContext,
  signal: unknown,
  lifecycle: EntryLifecycle,
): Promise<NativeToolResult> {
  const identity = invokeIdentify(ports, toolCallId, context, undefined, descriptor);
  if (!identity.ok) return Promise.resolve(notAdmitted(identity.reason, "inspect"));
  if (!isActualMainContext(context)) {
    return Promise.resolve(notAdmitted("the actual context is no longer a main context", "inspect"));
  }
  const signalRead = readActualAbortSignal(signal);
  if (!signalRead.ok) return Promise.resolve(notAdmitted(signalRead.reason, "inspect"));
  if (signalRead.aborted) return Promise.resolve(notAdmitted("the inspection was cancelled", "inspect"));
  if (identity.revalidate !== null) {
    const pure = invokeFinalRevalidate(identity.revalidate);
    if (!pure.ok) return Promise.resolve(notAdmitted(pure.reason, "inspect"));
  }
  if (lifecycle.disposed) return Promise.resolve(notAdmitted("the handoff entry was disposed", "inspect"));
  if (state.closed) return Promise.resolve(notAdmitted("the root handoff coordinator is closed", "inspect"));
  let view;
  try {
    view = state.store.inspect();
  } catch (error) {
    return Promise.resolve(historicalFailure("inspect", coreFailure(error)));
  }
  const details: Record<string, unknown> = {
    schema: NATIVE_HANDOFF_TOOL_RESULT_SCHEMA,
    tool: NATIVE_HANDOFF_TOOL,
    authority: "non-authoritative",
    action: "inspect",
    resultKind: "inspection",
    historical: true,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    inspect: view,
  };
  const result = makeResult(details, false, MAX_HANDOFF_INSPECT_RESPONSE_BYTES);
  return Promise.resolve(
    result
      ?? historicalFailure("inspect", "the bounded inspection response exceeded its encoding limit"),
  );
}

const HANDOFF_PRODUCER_SCHEMA = {
  type: "object",
  properties: {
    instanceId: { type: "string", description: "Exact instanceId from agent_work inspect." },
    parentToolCallId: { type: "string", description: "Exact parent task toolCallId from agent_work inspect." },
    envelopeSha256: { type: "string", description: "Exact envelopeSha256 from agent_work inspect." },
  },
  required: ["instanceId", "parentToolCallId", "envelopeSha256"],
  additionalProperties: false,
} as const;

const AGENT_HANDOFF_PARAMETERS = {
  type: "object",
  description: "Non-authoritative main-session handoff operations over observed native child work.",
  oneOf: [
    {
      type: "object",
      properties: {
        action: { const: "capture" },
        producer: HANDOFF_PRODUCER_SCHEMA,
        relativePath: {
          type: "string",
          description: "Workspace-relative POSIX text file to read once, under the existing 256KiB bound.",
        },
        conditions: {
          type: "array",
          description: "Model-proposed A1 check conditions; the core is the sole validator and plan freezer.",
          items: { type: "object" },
        },
      },
      required: ["action", "producer", "relativePath", "conditions"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "capture" },
        producer: HANDOFF_PRODUCER_SCHEMA,
        fromOfferId: {
          type: "string",
          description: "Existing repair offer whose original capture path and frozen plan are inherited.",
        },
      },
      required: ["action", "producer", "fromOfferId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "offer" },
        captureId: { type: "string" },
        failAdoptionId: {
          type: "string",
          description: "Optional same-capture FAIL adoption usable as repair feedback.",
        },
      },
      required: ["action", "captureId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { const: "adopt" },
        receiptId: { type: "string" },
        captureId: { type: "string" },
        consumerParentToolCallId: {
          type: "string",
          description: "Actual parent task call selector of the already completed consumer.",
        },
      },
      required: ["action", "receiptId", "captureId", "consumerParentToolCallId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { const: "inspect" } },
      required: ["action"],
      additionalProperties: false,
    },
  ],
} as const;

const HANDOFF_DESCRIPTION = [
  "Main-session, non-authoritative handoff bookkeeping over real observed native child results.",
  "capture records one model-proposed workspace file observation and A1 check plan; offer publishes an existing capture for a child, optionally with same-capture FAIL feedback; adopt records actual checked consumer facts after a fresh safe file observation; inspect returns bounded historical metadata.",
  "This tool does not accept root/work/call references, conditions for repairs, paths for adopt, source or host overrides, or self-reported success. It does not grant child tools, accept tasks or evaluate semantics.",
  "All results are historical operation facts, not current file/head validity; taskAccepted is always false and semantic acceptance is not evaluated.",
].join(" ");

export function createNativeHandoffEntry(options: NativeHandoffEntryOptions): NativeHandoffEntry {
  if (!isRecord(options)) throw new NativeHandoffError("Handoff entry options must be an object.", "invalid-input");
  const resolveRootField = Object.getOwnPropertyDescriptor(options, "resolveRoot");
  if (
    resolveRootField === undefined
    || !("value" in resolveRootField)
    || typeof resolveRootField.value !== "function"
  ) {
    throw new NativeHandoffError("Handoff entry requires a trusted resolveRoot function.", "invalid-input");
  }
  const resolveRoot = resolveRootField.value as Function;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const fileIo = options.fileIo ?? nodeFileIo;
  const lifecycle: EntryLifecycle = { disposed: false };

  const tool: NativeHandoffTool = {
    name: NATIVE_HANDOFF_TOOL,
    label: "Handoff",
    description: HANDOFF_DESCRIPTION,
    parameters: AGENT_HANDOFF_PARAMETERS,
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
      if (lifecycle.disposed) return Promise.resolve(notAdmitted("the handoff entry is disposed"));
      const actualToolCallId = boundedString(toolCallId, MAX_ID_CHARS);
      if (actualToolCallId === null) {
        return Promise.resolve(notAdmitted("the actual handoff tool call id is unavailable"));
      }
      let parsed: ParsedArguments;
      try {
        parsed = parseArguments(params);
      } catch {
        return Promise.resolve(notAdmitted("agent_handoff arguments could not be inspected"));
      }
      if (!parsed.ok) return Promise.resolve(notAdmitted(parsed.reason));
      const descriptor = parsed.descriptor;

      const initialSignal = readActualAbortSignal(signal);
      if (!initialSignal.ok) return Promise.resolve(notAdmitted(initialSignal.reason, descriptor.action));
      if (initialSignal.aborted) {
        return Promise.resolve(notAdmitted("the handoff invocation was cancelled before admission", descriptor.action));
      }
      if (!isActualMainContext(context)) {
        return Promise.resolve(notAdmitted("agent_handoff is available only in an actual main context", descriptor.action));
      }

      const resolved = resolveEntryRoot(resolveRoot, context);
      if (!resolved.ok) return Promise.resolve(notAdmitted(resolved.reason, descriptor.action));
      const { coordinator, state, ports } = resolved;
      if (descriptor.action === "inspect") {
        return executeInspect(state, ports, actualToolCallId, descriptor, context, signal, lifecycle);
      }

      const priorSlot = state.slots.get(actualToolCallId);
      const identity = invokeIdentify(
        ports,
        actualToolCallId,
        context,
        priorSlot?.originalCallRef,
        descriptor,
      );
      if (!identity.ok) return Promise.resolve(notAdmitted(identity.reason, descriptor.action));

      // Identification is a host callback and may reenter this same actual
      // call. Re-read the index after consuming its return; never overwrite a
      // slot that appeared during that callback.
      const existingAfterIdentify = state.slots.get(actualToolCallId);
      if (existingAfterIdentify !== undefined) {
        return handleExistingSlot(
          coordinator,
          state,
          existingAfterIdentify,
          identity,
          descriptor,
          context,
          signal,
          resolveRoot,
          actualToolCallId,
          lifecycle,
        );
      }

      if (state.closed) {
        return Promise.resolve(notAdmitted("the root handoff coordinator is closed", descriptor.action));
      }
      if (state.slots.size >= state.maxOperations) {
        return Promise.resolve(notAdmitted("the bounded handoff operation capacity is exhausted", descriptor.action));
      }
      if (!projectionFits(descriptor.action)) {
        return Promise.resolve(notAdmitted("the bounded handoff response projection does not fit", descriptor.action));
      }
      const slot = createSlot(
        state,
        actualToolCallId,
        descriptor.action,
        descriptor.digest,
        identity.work,
        identity.callRef,
        identity.revalidate,
      );
      if (slot === null) {
        const racedSlot = state.slots.get(actualToolCallId);
        if (racedSlot !== undefined) {
          return handleExistingSlot(
            coordinator,
            state,
            racedSlot,
            identity,
            descriptor,
            context,
            signal,
            resolveRoot,
            actualToolCallId,
            lifecycle,
          );
        }
        return Promise.resolve(notAdmitted("the bounded handoff operation capacity is exhausted", descriptor.action));
      }
      return runNewOperation(
        state,
        slot,
        coordinator,
        ports,
        actualToolCallId,
        descriptor,
        context,
        signal,
        now,
        fileIo,
        lifecycle,
      );
    },
  };

  return Object.freeze({
    tool,
    dispose(): void {
      lifecycle.disposed = true;
    },
  });
}
