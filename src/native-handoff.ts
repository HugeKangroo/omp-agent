import { randomUUID } from "node:crypto";
import {
  MAX_OUTPUT_FILE_BYTES,
  deepFreeze,
  isNativeWorkspaceTextSnapshot,
  sha256Hex,
  validateRelativePath,
  type NativeObservedFile,
  type NativeWorkspaceTextSnapshot,
} from "./native-work.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
  createNativeTextCheckPlan,
  matchesNativeTextCheckReceipt,
  runNativeTextChecks,
  type NativeTextCheckPlan,
  type NativeTextCheckReceipt,
} from "./native-snapshot-checker.ts";

/**
 * Process-local, root-scoped handoff store. It owns bounded capture, offer,
 * read, receipt and adoption records and performs only pure identity/version
 * checks. It never reads files, schedules work, executes callbacks, reads task
 * context or authenticates external host references. A trusted entry must run
 * the real host gates and supply actual opaque identities.
 *
 * Core-issued handles are authenticated by per-store WeakMap identity only.
 * String IDs are bounded selectors, never permissions. External root, work,
 * producer, consumer and call references are compared by exact object
 * identity; the core makes no claim that such a reference proves OMP
 * authenticity.
 */

export const NATIVE_HANDOFF_SCHEMA = "omp-agent.native-handoff.v1";
export const NATIVE_HANDOFF_READ_SCHEMA = "omp-agent.native-handoff-read.v1";
export const NATIVE_HANDOFF_INSPECT_SCHEMA = "omp-agent.native-handoff-inspect.v1";
export const NATIVE_HANDOFF_SOURCE = "model-proposed" as const;

export const MAX_HANDOFF_CAPTURES = 8;
export const MAX_HANDOFF_CHAINS = 4;
export const MAX_HANDOFF_OFFERS = 16;
export const MAX_HANDOFF_RECEIPTS = 16;
export const MAX_HANDOFF_ADOPTIONS = 16;
export const MAX_HANDOFF_RETAINED_BYTES = 1024 * 1024;
export const MAX_HANDOFF_METADATA_BYTES = 256 * 1024;
export const MAX_HANDOFF_READ_BYTES = 256 * 1024;
export const MAX_HANDOFF_INSPECT_BYTES = 64 * 1024;
export const MAX_HANDOFF_IDENTITY_CHARS = 256;
export const MAX_HANDOFF_REASON_CHARS = 200;

/**
 * Canonical retained-metadata accounting for this store. It covers encoded
 * store records, not OS heap use and not the sum of every possible public
 * response:
 * - one A1 plan per chain, encoded once; snapshot text is retained as raw
 *   UTF-8 bytes in `retainedBytes`, never counted as metadata;
 * - one full capture, offer, receipt and adoption view wrapper per record,
 *   including bounded facts, file facts and tool-call facts;
 * - one read wrapper per offer with the raw text omitted and the shared plan
 *   replaced by a fixed digest reference, plus a conservative observation
 *   reserve for the prepared digest and sticky status/digest/reason fields;
 * - a per-offer terminal-marker reserve for failure state and reason;
 * - a fixed store-state/reason wrapper.
 * Full read and inspect responses still enforce their own encoded limits; they
 * are response bounds, not retained store metadata.
 */
/** Pending capture metadata includes the capture and initial offer wrappers. */
const PENDING_METADATA_BYTES = 16 * 1024;
/**
 * Terminal offer markers are already counted when the offer is created. The
 * reason is sanitized to at most 200 printable ASCII characters (worst JSON
 * escaping 400 bytes); state/read/checked booleans are far below this reserve.
 */
const FAILURE_METADATA_BYTES = 1024;
/** Fixed bounded store-state/reason wrapper reserve. */
const STORE_STATE_METADATA_BYTES = 256;
/**
 * Prepared digest plus sticky delivered/conflict status, up to two 64-character
 * digests and a bounded reason. Deliberately above the exact field sum.
 */
const READ_OBSERVATION_METADATA_BYTES = 512;

export type NativeHandoffErrorCode =
  | "invalid-input"
  | "identity"
  | "state"
  | "capacity"
  | "metadata"
  | "conflict"
  | "encoding";

export class NativeHandoffError extends Error {
  override name = "NativeHandoffError";
  constructor(message: string, readonly code: NativeHandoffErrorCode) {
    super(message);
  }
}

/**
 * Opaque host object references. The core retains the exact reference and
 * compares with `===`; it does not inspect, copy or authenticate the object.
 */
export type HandoffRootRef = object;
export type HandoffWorkRef = object;
export type HandoffProducerRef = object;
export type HandoffConsumerRef = object;
/** Actual parent task call reference, distinct from each child tool execution. */
export type HandoffCallRef = object;
/** Actual child tool execution reference, distinct from the parent task call. */
export type HandoffToolCallRef = object;

/** Bounded labels copied from the trusted adapter. They are facts, not grants. */
export interface HandoffBindingFacts {
  readonly callId: string;
  readonly workId: string;
  readonly definitionVersion: string;
}

export interface HandoffToolCallFacts {
  readonly callId: string;
}

/**
 * First capture. `proposalCall`/`proposalFacts` describe the main handoff call
 * that proposed the conditions; `producer`/`producerFacts` describe the
 * separately selected child result/definition. Conditions are model-proposed
 * and normalized by A1 before reservation.
 */
export interface HandoffCaptureRequest {
  readonly work: HandoffWorkRef;
  readonly producer: HandoffProducerRef;
  readonly producerFacts: HandoffBindingFacts;
  readonly proposalCall: HandoffCallRef;
  readonly proposalFacts: HandoffBindingFacts;
  readonly relativePath: string;
  readonly conditions: readonly unknown[];
}

/**
 * Repair capture. The new producer must be the exact bound consumer of the
 * repair offer; conditions, path and original plan proposal provenance are
 * inherited and cannot be supplied.
 */
export interface HandoffRepairRequest {
  readonly fromOffer: HandoffOffer;
  readonly work: HandoffWorkRef;
  readonly producer: HandoffProducerRef;
  readonly producerFacts: HandoffBindingFacts;
  readonly expectedHeadCaptureId: string;
  readonly expectedChainVersion: number;
}

/** Core-issued handles. Only these exact objects are accepted by mutations. */
export interface HandoffCaptureReservation {
  readonly reservationId: string;
  readonly mode: "initial" | "repair";
  readonly reservedBytes: number;
}

export interface HandoffCapture {
  readonly captureId: string;
}

export interface HandoffOffer {
  readonly offerId: string;
}

export interface HandoffCheckReceipt {
  readonly receiptId: string;
}

export interface HandoffAdoption {
  readonly adoptionId: string;
}

export interface HandoffPreparedRead {
  readonly readId: string;
  readonly offerId: string;
}

export interface HandoffCaptureCommit {
  readonly capture: HandoffCapture;
  readonly offer: HandoffOffer;
}

export interface HandoffReadPreparation {
  readonly read: HandoffPreparedRead;
  readonly view: HandoffPreparedReadView;
  /** SHA-256 of the exact UTF-8 JSON encoding of `view`. */
  readonly digest: string;
}

export interface HandoffLiveFileFacts {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface HandoffCaptureView {
  readonly captureId: string;
  readonly snapshotId: string;
  readonly chainId: string;
  readonly version: number;
  readonly source: typeof NATIVE_HANDOFF_SOURCE;
  readonly relativePath: string;
  readonly file: Readonly<NativeObservedFile>;
  readonly planDigest: string;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly proposal: HandoffBindingFacts;
  readonly producer: HandoffBindingFacts;
  readonly initial: boolean;
  readonly baseCaptureId: string | null;
  readonly repairOfferId: string | null;
  readonly authority: "non-authoritative";
}

export type HandoffOfferState = "open" | "bound" | "failed";
export type HandoffReadState = "none" | "prepared" | "delivered" | "failed";

export interface HandoffOfferView {
  readonly offerId: string;
  readonly captureId: string;
  readonly chainId: string;
  readonly version: number;
  readonly source: typeof NATIVE_HANDOFF_SOURCE;
  readonly planDigest: string;
  readonly failAdoptionId: string | null;
  readonly state: HandoffOfferState;
  readonly failureReason: string | null;
  readonly binding: { readonly facts: HandoffBindingFacts } | null;
  readonly readState: HandoffReadState;
  /** Historical exact success; remains true after a later conflict. */
  readonly readDelivered: boolean;
  /** Delivered, uncontested and still bound; required for repair. */
  readonly readUsable: boolean;
  readonly checked: boolean;
  readonly authority: "non-authoritative";
}

export interface HandoffCheckReceiptView {
  readonly receiptId: string;
  readonly offerId: string;
  readonly captureId: string;
  readonly chainId: string;
  readonly version: number;
  readonly source: typeof NATIVE_HANDOFF_SOURCE;
  readonly planDigest: string;
  readonly parentBinding: HandoffBindingFacts;
  readonly checkerCall: HandoffToolCallFacts;
  readonly a1: NativeTextCheckReceipt;
  readonly outcome: "pass" | "fail";
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly authority: "non-authoritative";
}

export interface HandoffAdoptionView {
  readonly adoptionId: string;
  readonly receiptId: string;
  readonly offerId: string;
  readonly captureId: string;
  readonly chainId: string;
  readonly version: number;
  readonly source: typeof NATIVE_HANDOFF_SOURCE;
  readonly planDigest: string;
  readonly relativePath: string;
  readonly file: HandoffLiveFileFacts;
  readonly outcome: "pass" | "fail";
  readonly parentBinding: HandoffBindingFacts;
  readonly producer: HandoffBindingFacts;
  readonly proposal: HandoffBindingFacts;
  readonly adoptionCall: HandoffToolCallFacts;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly authority: "non-authoritative";
}

export interface HandoffReadFeedback {
  readonly adoptionId: string;
  readonly receiptId: string;
  readonly offerId: string;
  readonly captureId: string;
  readonly chainId: string;
  readonly version: number;
  readonly relativePath: string;
  readonly file: HandoffLiveFileFacts;
  readonly planDigest: string;
  readonly a1: NativeTextCheckReceipt;
  readonly parentBinding: HandoffBindingFacts;
  readonly producer: HandoffBindingFacts;
  readonly proposal: HandoffBindingFacts;
  readonly outcome: "fail";
}

/** Full prepared read view. This is the only public view containing file text. */
export interface HandoffPreparedReadView {
  readonly schema: typeof NATIVE_HANDOFF_READ_SCHEMA;
  readonly readId: string;
  readonly offerId: string;
  readonly captureId: string;
  readonly chainId: string;
  readonly version: number;
  readonly source: typeof NATIVE_HANDOFF_SOURCE;
  readonly relativePath: string;
  readonly file: Readonly<NativeObservedFile>;
  readonly plan: NativeTextCheckPlan;
  readonly proposal: HandoffBindingFacts;
  readonly readCall: HandoffToolCallFacts;
  readonly text: string;
  readonly feedback: HandoffReadFeedback | null;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly authority: "non-authoritative";
}

export interface HandoffAdoptRequest {
  readonly receipt: HandoffCheckReceipt;
  readonly capture: HandoffCapture;
  readonly work: HandoffWorkRef;
  readonly consumer: HandoffConsumerRef;
  readonly producer: HandoffProducerRef;
  readonly file: HandoffLiveFileFacts;
  readonly adoptionCall: HandoffToolCallRef;
  readonly adoptionCallId: string;
}

export interface NativeHandoffLimits {
  readonly maxChains: number;
  readonly maxCaptures: number;
  readonly maxOffers: number;
  readonly maxReceipts: number;
  readonly maxAdoptions: number;
  readonly maxRetainedBytes: number;
  readonly maxMetadataBytes: number;
  readonly maxReadBytes: number;
  readonly maxInspectBytes: number;
}

export const DEFAULT_NATIVE_HANDOFF_LIMITS: NativeHandoffLimits = Object.freeze({
  maxChains: MAX_HANDOFF_CHAINS,
  maxCaptures: MAX_HANDOFF_CAPTURES,
  maxOffers: MAX_HANDOFF_OFFERS,
  maxReceipts: MAX_HANDOFF_RECEIPTS,
  maxAdoptions: MAX_HANDOFF_ADOPTIONS,
  maxRetainedBytes: MAX_HANDOFF_RETAINED_BYTES,
  maxMetadataBytes: MAX_HANDOFF_METADATA_BYTES,
  maxReadBytes: MAX_HANDOFF_READ_BYTES,
  maxInspectBytes: MAX_HANDOFF_INSPECT_BYTES,
});

export interface HandoffChainSummary {
  readonly chainId: string;
  readonly version: number;
  readonly headCaptureId: string;
  readonly planDigest: string;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
  readonly captures: number;
}

export interface HandoffReceiptSummary {
  readonly receiptId: string;
  readonly offerId: string;
  readonly captureId: string;
  readonly outcome: "pass" | "fail";
  readonly planDigest: string;
}

export interface HandoffInspectCategory<T> {
  readonly total: number;
  readonly omitted: number;
  readonly items: readonly T[];
}

export interface HandoffUsage {
  readonly chains: number;
  readonly captures: number;
  readonly offers: number;
  readonly receipts: number;
  readonly adoptions: number;
  readonly pendingReservations: number;
  readonly retainedBytes: number;
  readonly pendingBytes: number;
  readonly metadataBytes: number;
}

export type HandoffStoreState = "active" | "invalidated" | "disposed";

/** Bounded inspection. Text is never included; omitted counts are explicit. */
export interface HandoffInspectView {
  readonly schema: typeof NATIVE_HANDOFF_INSPECT_SCHEMA;
  readonly authority: "non-authoritative";
  readonly state: HandoffStoreState;
  readonly reason: string | null;
  readonly complete: boolean;
  readonly limits: NativeHandoffLimits;
  readonly usage: HandoffUsage;
  readonly chains: HandoffInspectCategory<HandoffChainSummary>;
  readonly captures: HandoffInspectCategory<HandoffCaptureView>;
  readonly offers: HandoffInspectCategory<HandoffOfferView>;
  readonly receipts: HandoffInspectCategory<HandoffReceiptSummary>;
  readonly adoptions: HandoffInspectCategory<HandoffAdoptionView>;
  readonly pending: {
    readonly reservations: number;
    readonly bytes: number;
    readonly metadataBytes: number;
  };
}

export interface NativeHandoffStore {
  reserveCapture(request: HandoffCaptureRequest): HandoffCaptureReservation;
  reserveRepairCapture(request: HandoffRepairRequest): HandoffCaptureReservation;
  commitCapture(reservation: HandoffCaptureReservation, snapshot: NativeWorkspaceTextSnapshot): HandoffCaptureCommit;
  abandonCapture(reservation: HandoffCaptureReservation): void;
  offer(capture: HandoffCapture, failAdoption?: HandoffAdoption): HandoffOffer;
  bindOfferConsumer(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    facts: HandoffBindingFacts,
  ): HandoffOfferView;
  markBindingFailed(offer: HandoffOffer, reason?: string): void;
  /**
   * `parentTaskCall` is the offer's bound parent task call; `readToolCall` and
   * `readCallId` identify the distinct actual child read execution. Only that
   * exact read call can replay the prepared read.
   */
  prepareRead(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    readToolCall: HandoffToolCallRef,
    readCallId: string,
  ): HandoffReadPreparation;
  /**
   * Returns true only for the exact issued read, parent/tool call identity,
   * prepared digest and successful observation. A failed or conflicting
   * observation from that same exact call is sticky and cannot later become
   * usable. It records a tool-result observation basis, not model attention or
   * final post-middleware delivery.
   */
  observeReadResult(
    read: HandoffPreparedRead,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    readToolCall: HandoffToolCallRef,
    readCallId: string,
    fullResultDigest: string,
    success: boolean,
  ): boolean;
  /** `checkerToolCall`/`checkCallId` identify the actual child check execution. */
  check(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    checkerToolCall: HandoffToolCallRef,
    checkCallId: string,
  ): HandoffCheckReceipt;
  adopt(request: HandoffAdoptRequest): HandoffAdoption;
  inspect(): HandoffInspectView;
  resolveCapture(captureId: string): HandoffCapture | null;
  resolveOffer(offerId: string): HandoffOffer | null;
  resolveCheckReceipt(receiptId: string): HandoffCheckReceipt | null;
  resolveAdoption(adoptionId: string): HandoffAdoption | null;
  lookupCapture(captureId: string): HandoffCaptureView | null;
  lookupOffer(offerId: string): HandoffOfferView | null;
  lookupReceipt(receiptId: string): HandoffCheckReceiptView | null;
  lookupAdoption(adoptionId: string): HandoffAdoptionView | null;
  /** Pure historical path/bytes/sha256 match; no live file read or currentness claim. */
  matchAdoption(adoption: HandoffAdoption, file: HandoffLiveFileFacts): boolean;
  /**
   * Pure historical binding check for an issued capture handle. The capture
   * must belong to this store and retain the exact stored work/producer object
   * references. This says nothing about the current chain head, offer state,
   * active work or host authenticity.
   */
  matchesCaptureBinding(
    capture: HandoffCapture,
    work: HandoffWorkRef,
    producer: HandoffProducerRef,
  ): boolean;
  invalidate(reason?: string): void;
  dispose(): void;
}

function fail(code: NativeHandoffErrorCode, message: string): never {
  throw new NativeHandoffError(message, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads exactly the expected own data properties without invoking getters or
 * accepting prototypes, symbols, arrays or accessors.
 */
function readOwnRecord(
  value: unknown,
  label: string,
  expected: readonly string[],
): Map<string, unknown> {
  if (!isRecord(value)) fail("invalid-input", `${label} must be a plain object.`);
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("invalid-input", `${label} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-input", `${label} must be a plain object.`);
  }
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) {
    fail("invalid-input", `${label} has unexpected properties.`);
  }
  const result = new Map<string, unknown>();
  for (const key of expected) {
    if (!keys.includes(key)) fail("invalid-input", `${label} is missing required properties.`);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("invalid-input", `${label} could not be inspected.`);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      fail("invalid-input", `${label} must contain only enumerable own data.`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

/** Reads a strict subset of allowed own data properties; accessors are refused. */
function readOwnSubset(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Map<string, unknown> {
  if (!isRecord(value)) fail("invalid-input", `${label} must be a plain object.`);
  let prototype: object | null;
  let keys: (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail("invalid-input", `${label} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid-input", `${label} must be a plain object.`);
  }
  if (keys.length > allowed.length || keys.some((key) => typeof key !== "string")) {
    fail("invalid-input", `${label} has unexpected properties.`);
  }
  const result = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      fail("invalid-input", `${label} has unexpected properties.`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail("invalid-input", `${label} could not be inspected.`);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true
    ) {
      fail("invalid-input", `${label} must contain only enumerable own data.`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function requireObjectRef(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid-input", `${label} must be an opaque object reference.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    fail("invalid-input", `${label} must be a nonempty bounded string.`);
  }
  if (/[\x00-\x1f\x7f]/.test(value)) fail("invalid-input", `${label} must not contain control characters.`);
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    fail("invalid-input", `${label} must be an integer within bounds.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  return boundedString(value, label, 128);
}

function requireReason(value: unknown, fallback: string, maximum = MAX_HANDOFF_REASON_CHARS): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail("invalid-input", "Reason must be a string.");
  const normalized = value
    .replace(/[^\x20-\x7e]+/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return fallback;
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 3)}...`;
}

function parseFacts(value: unknown): HandoffBindingFacts {
  const record = readOwnRecord(value, "binding facts", ["callId", "workId", "definitionVersion"]);
  const callId = boundedString(record.get("callId"), "call id", MAX_HANDOFF_IDENTITY_CHARS);
  const workId = boundedString(record.get("workId"), "work id", MAX_HANDOFF_IDENTITY_CHARS);
  const definitionVersion = boundedString(
    record.get("definitionVersion"),
    "definition version",
    MAX_HANDOFF_IDENTITY_CHARS,
  );
  return Object.freeze({ callId, workId, definitionVersion });
}

function parseToolCallFacts(callId: unknown): HandoffToolCallFacts {
  return Object.freeze({
    callId: boundedString(callId, "tool call id", MAX_HANDOFF_IDENTITY_CHARS),
  });
}

function sameFacts(left: HandoffBindingFacts, right: HandoffBindingFacts): boolean {
  return left.callId === right.callId
    && left.workId === right.workId
    && left.definitionVersion === right.definitionVersion;
}

function requireRelativePath(value: unknown): string {
  try {
    return validateRelativePath(value);
  } catch {
    return fail("invalid-input", "Relative path is not a safe workspace-relative POSIX path.");
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("invalid-input", `${label} must be a lowercase SHA-256 hex digest.`);
  }
  return value;
}

function parseLiveFile(value: unknown): HandoffLiveFileFacts {
  const record = readOwnRecord(value, "live file facts", ["relativePath", "bytes", "sha256"]);
  const relativePath = requireRelativePath(record.get("relativePath"));
  const bytes = boundedInteger(record.get("bytes"), "live file bytes", 0, MAX_OUTPUT_FILE_BYTES);
  const sha256 = requireSha256(record.get("sha256"), "live file sha256");
  return Object.freeze({ relativePath, bytes, sha256 });
}

function sameLiveFile(left: HandoffLiveFileFacts, right: HandoffLiveFileFacts): boolean {
  return left.relativePath === right.relativePath
    && left.bytes === right.bytes
    && left.sha256 === right.sha256;
}

function encodeJson(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail("encoding", "Handoff view could not be encoded.");
  }
  if (typeof encoded !== "string") fail("encoding", "Handoff view could not be encoded.");
  return encoded;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(encodeJson(value)).byteLength;
}

function copyFile(file: Readonly<NativeObservedFile>): Readonly<NativeObservedFile> {
  return Object.freeze({
    relativePath: file.relativePath,
    bytes: file.bytes,
    sha256: file.sha256,
    observedAt: file.observedAt,
  });
}

function normalizeLimits(input: unknown): NativeHandoffLimits {
  if (input === undefined) return DEFAULT_NATIVE_HANDOFF_LIMITS;
  const keys = [
    "maxChains",
    "maxCaptures",
    "maxOffers",
    "maxReceipts",
    "maxAdoptions",
    "maxRetainedBytes",
    "maxMetadataBytes",
    "maxReadBytes",
    "maxInspectBytes",
  ] as const;
  const record = readOwnSubset(input, "handoff limits", keys);
  const read = (key: (typeof keys)[number], minimum: number): number => {
    const value = record.get(key);
    if (value === undefined) return DEFAULT_NATIVE_HANDOFF_LIMITS[key];
    return boundedInteger(value, key, minimum, DEFAULT_NATIVE_HANDOFF_LIMITS[key]);
  };
  return Object.freeze({
    maxChains: read("maxChains", 1),
    maxCaptures: read("maxCaptures", 1),
    maxOffers: read("maxOffers", 1),
    maxReceipts: read("maxReceipts", 1),
    maxAdoptions: read("maxAdoptions", 1),
    maxRetainedBytes: read("maxRetainedBytes", 1),
    maxMetadataBytes: read("maxMetadataBytes", 1024),
    maxReadBytes: read("maxReadBytes", 1024),
    maxInspectBytes: read("maxInspectBytes", 2048),
  });
}

interface ChainRecord {
  chainId: string;
  plan: NativeTextCheckPlan;
  planProposalCallRef: HandoffCallRef;
  planProposalFacts: HandoffBindingFacts;
  version: number;
  headCaptureId: string;
  captures: number;
  metadataBytes: number;
}

interface CaptureRecord {
  handle: HandoffCapture;
  captureId: string;
  snapshot: NativeWorkspaceTextSnapshot;
  file: Readonly<NativeObservedFile>;
  chain: ChainRecord;
  version: number;
  plan: NativeTextCheckPlan;
  proposalFacts: HandoffBindingFacts;
  proposalCallRef: HandoffCallRef;
  producerFacts: HandoffBindingFacts;
  workRef: HandoffWorkRef;
  producerRef: HandoffProducerRef;
  initial: boolean;
  baseCaptureId: string | null;
  repairOfferId: string | null;
}

interface OfferRecord {
  handle: HandoffOffer;
  offerId: string;
  capture: CaptureRecord;
  failAdoption: AdoptionRecord | null;
  state: HandoffOfferState;
  failureReason: string | null;
  consumerRef: HandoffConsumerRef | null;
  callRef: HandoffCallRef | null;
  bindingFacts: HandoffBindingFacts | null;
  read: ReadRecord | null;
  receipt: ReceiptRecord | null;
  /** Conservative counted metadata including the terminal-marker reserve. */
  metadataBytes: number;
}

interface ReadRecord {
  handle: HandoffPreparedRead;
  readId: string;
  offer: OfferRecord;
  consumerRef: HandoffConsumerRef;
  callRef: HandoffCallRef;
  toolCallRef: HandoffToolCallRef;
  toolCallFacts: HandoffToolCallFacts;
  view: HandoffPreparedReadView;
  digest: string;
  delivered: boolean;
  deliveredDigest: string | null;
  conflicted: boolean;
  conflictDigest: string | null;
  conflictReason: "failed-observation" | "result-mismatch" | null;
}

interface ReceiptRecord {
  handle: HandoffCheckReceipt;
  receiptId: string;
  offer: OfferRecord;
  capture: CaptureRecord;
  consumerRef: HandoffConsumerRef;
  callRef: HandoffCallRef;
  parentBindingFacts: HandoffBindingFacts;
  checkerCallRef: HandoffToolCallRef;
  checkerCallFacts: HandoffToolCallFacts;
  a1: NativeTextCheckReceipt;
}

interface AdoptionRecord {
  handle: HandoffAdoption;
  adoptionId: string;
  receipt: ReceiptRecord;
  capture: CaptureRecord;
  workRef: HandoffWorkRef;
  consumerRef: HandoffConsumerRef;
  producerRef: HandoffProducerRef;
  adoptionCallRef: HandoffToolCallRef;
  adoptionCallFacts: HandoffToolCallFacts;
  file: HandoffLiveFileFacts;
}

interface ReservationRecord {
  handle: HandoffCaptureReservation;
  reservationId: string;
  mode: "initial" | "repair";
  plan: NativeTextCheckPlan;
  planProposalCallRef: HandoffCallRef;
  planProposalFacts: HandoffBindingFacts;
  producerFacts: HandoffBindingFacts;
  relativePath: string;
  workRef: HandoffWorkRef;
  producerRef: HandoffProducerRef;
  reservedBytes: number;
  metadataReserved: number;
  chainId: string;
  baseCapture: CaptureRecord | null;
  repairOffer: OfferRecord | null;
  repairConsumerRef: HandoffConsumerRef | null;
  repairParentCallRef: HandoffCallRef | null;
  repairRead: ReadRecord | null;
  repairAdoption: AdoptionRecord | null;
  expectedChainVersion: number;
  state: "pending" | "released" | "committed";
}

function captureView(record: CaptureRecord): HandoffCaptureView {
  return deepFreeze({
    captureId: record.captureId,
    snapshotId: record.snapshot.captureId,
    chainId: record.chain.chainId,
    version: record.version,
    source: NATIVE_HANDOFF_SOURCE,
    relativePath: record.file.relativePath,
    file: copyFile(record.file),
    planDigest: record.plan.digest,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    proposal: { ...record.proposalFacts },
    producer: { ...record.producerFacts },
    initial: record.initial,
    baseCaptureId: record.baseCaptureId,
    repairOfferId: record.repairOfferId,
    authority: "non-authoritative",
  });
}

function readState(record: OfferRecord): HandoffReadState {
  if (record.read === null) return "none";
  if (record.read.conflicted) return "failed";
  return record.read.delivered ? "delivered" : "prepared";
}

function readUsable(record: OfferRecord): boolean {
  return record.state === "bound"
    && record.read !== null
    && record.read.delivered
    && !record.read.conflicted;
}

/**
 * Minimal direct-dependency check for repair feedback. The FAIL adoption stays
 * immutable and historical, but may drive a new repair only while its original
 * checker offer is still bound, still retains that exact receipt, and that
 * receipt's bound consumer/parent call are unchanged. No recursive graph walk
 * and no retrospective rewrite of already committed captures.
 */
function failAdoptionUsable(adoption: AdoptionRecord, capture: CaptureRecord): boolean {
  const offer = adoption.receipt.offer;
  return adoption.capture === capture
    && adoption.receipt.capture === capture
    && adoption.receipt.a1.outcome === "fail"
    && offer.state === "bound"
    && offer.receipt === adoption.receipt
    && offer.consumerRef !== null
    && offer.callRef !== null
    && offer.consumerRef === adoption.receipt.consumerRef
    && offer.callRef === adoption.receipt.callRef;
}

function offerView(record: OfferRecord): HandoffOfferView {
  return deepFreeze({
    offerId: record.offerId,
    captureId: record.capture.captureId,
    chainId: record.capture.chain.chainId,
    version: record.capture.version,
    source: NATIVE_HANDOFF_SOURCE,
    planDigest: record.capture.plan.digest,
    failAdoptionId: record.failAdoption?.adoptionId ?? null,
    state: record.state,
    failureReason: record.failureReason,
    binding: record.bindingFacts === null
      ? null
      : { facts: { ...record.bindingFacts } },
    readState: readState(record),
    readDelivered: record.read?.delivered === true,
    readUsable: readUsable(record),
    checked: record.receipt !== null,
    authority: "non-authoritative",
  });
}

function receiptView(record: ReceiptRecord): HandoffCheckReceiptView {
  return deepFreeze({
    receiptId: record.receiptId,
    offerId: record.offer.offerId,
    captureId: record.capture.captureId,
    chainId: record.capture.chain.chainId,
    version: record.capture.version,
    source: NATIVE_HANDOFF_SOURCE,
    planDigest: record.capture.plan.digest,
    parentBinding: { ...record.parentBindingFacts },
    checkerCall: { ...record.checkerCallFacts },
    a1: record.a1,
    outcome: record.a1.outcome,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    authority: "non-authoritative",
  });
}

function adoptionView(record: AdoptionRecord): HandoffAdoptionView {
  return deepFreeze({
    adoptionId: record.adoptionId,
    receiptId: record.receipt.receiptId,
    offerId: record.receipt.offer.offerId,
    captureId: record.capture.captureId,
    chainId: record.capture.chain.chainId,
    version: record.capture.version,
    source: NATIVE_HANDOFF_SOURCE,
    planDigest: record.capture.plan.digest,
    relativePath: record.file.relativePath,
    file: { ...record.file },
    outcome: record.receipt.a1.outcome,
    parentBinding: { ...record.receipt.parentBindingFacts },
    producer: { ...record.capture.producerFacts },
    proposal: { ...record.capture.proposalFacts },
    adoptionCall: { ...record.adoptionCallFacts },
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    authority: "non-authoritative",
  });
}

function readFeedback(record: AdoptionRecord): HandoffReadFeedback {
  return {
    adoptionId: record.adoptionId,
    receiptId: record.receipt.receiptId,
    offerId: record.receipt.offer.offerId,
    captureId: record.capture.captureId,
    chainId: record.capture.chain.chainId,
    version: record.capture.version,
    relativePath: record.file.relativePath,
    file: { ...record.file },
    planDigest: record.capture.plan.digest,
    a1: record.receipt.a1,
    parentBinding: { ...record.receipt.parentBindingFacts },
    producer: { ...record.capture.producerFacts },
    proposal: { ...record.capture.proposalFacts },
    outcome: "fail",
  };
}

function readView(record: {
  readId: string;
  offer: OfferRecord;
  toolCallFacts: HandoffToolCallFacts;
}): HandoffPreparedReadView {
  const capture = record.offer.capture;
  return deepFreeze({
    schema: NATIVE_HANDOFF_READ_SCHEMA,
    readId: record.readId,
    offerId: record.offer.offerId,
    captureId: capture.captureId,
    chainId: capture.chain.chainId,
    version: capture.version,
    source: NATIVE_HANDOFF_SOURCE,
    relativePath: capture.file.relativePath,
    file: copyFile(capture.file),
    plan: capture.plan,
    proposal: { ...capture.proposalFacts },
    readCall: { ...record.toolCallFacts },
    text: capture.snapshot.text,
    feedback: record.offer.failAdoption === null ? null : readFeedback(record.offer.failAdoption),
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    authority: "non-authoritative",
  });
}

function chainSummary(record: ChainRecord): HandoffChainSummary {
  return deepFreeze({
    chainId: record.chainId,
    version: record.version,
    headCaptureId: record.headCaptureId,
    planDigest: record.plan.digest,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    captures: record.captures,
  });
}

/** Chain wrapper only; the shared A1 plan is counted once per chain separately. */
function chainMetadataBytes(record: ChainRecord): number {
  return encodedBytes(chainSummary(record));
}

function offerMetadataBytes(record: OfferRecord): number {
  return encodedBytes(offerView(record)) + FAILURE_METADATA_BYTES;
}

function freezeCategory<T>(total: number, items: readonly T[]): HandoffInspectCategory<T> {
  return Object.freeze({
    total,
    omitted: total - items.length,
    items: Object.freeze([...items]),
  });
}

class NativeHandoffStoreImpl implements NativeHandoffStore {
  readonly #limits: NativeHandoffLimits;
  #state: HandoffStoreState = "active";
  #reason: string | null = null;
  readonly #chains = new Map<string, ChainRecord>();
  readonly #captures = new Map<string, CaptureRecord>();
  readonly #offers = new Map<string, OfferRecord>();
  readonly #receipts = new Map<string, ReceiptRecord>();
  readonly #adoptions = new Map<string, AdoptionRecord>();
  readonly #adoptionsByReceipt = new Map<ReceiptRecord, AdoptionRecord>();
  readonly #reservations = new Map<string, ReservationRecord>();
  readonly #captureHandles = new WeakMap<HandoffCapture, CaptureRecord>();
  readonly #offerHandles = new WeakMap<HandoffOffer, OfferRecord>();
  readonly #receiptHandles = new WeakMap<HandoffCheckReceipt, ReceiptRecord>();
  readonly #adoptionHandles = new WeakMap<HandoffAdoption, AdoptionRecord>();
  readonly #readHandles = new WeakMap<HandoffPreparedRead, ReadRecord>();
  readonly #reservationHandles = new WeakMap<HandoffCaptureReservation, ReservationRecord>();
  #retainedBytes = 0;
  #pendingBytes = 0;
  #metadataBytes = STORE_STATE_METADATA_BYTES;

  constructor(limits: NativeHandoffLimits) {
    this.#limits = limits;
  }

  #requireActive(): void {
    if (this.#state !== "active") fail("state", "Handoff store is no longer active.");
  }

  #pendingInitialCount(): number {
    let count = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.mode === "initial") count++;
    }
    return count;
  }

  #requireReservation(handle: unknown): ReservationRecord {
    if (typeof handle !== "object" || handle === null) {
      fail("identity", "Capture reservation was not issued by this store.");
    }
    const record = this.#reservationHandles.get(handle as HandoffCaptureReservation);
    if (record === undefined) fail("identity", "Capture reservation was not issued by this store.");
    return record;
  }

  #requireCapture(handle: unknown): CaptureRecord {
    if (typeof handle !== "object" || handle === null) {
      fail("identity", "Capture was not issued by this store.");
    }
    const record = this.#captureHandles.get(handle as HandoffCapture);
    if (record === undefined) fail("identity", "Capture was not issued by this store.");
    return record;
  }

  #requireOffer(handle: unknown): OfferRecord {
    if (typeof handle !== "object" || handle === null) {
      fail("identity", "Offer was not issued by this store.");
    }
    const record = this.#offerHandles.get(handle as HandoffOffer);
    if (record === undefined) fail("identity", "Offer was not issued by this store.");
    return record;
  }

  #requireReceipt(handle: unknown): ReceiptRecord {
    if (typeof handle !== "object" || handle === null) {
      fail("identity", "Check receipt was not issued by this store.");
    }
    const record = this.#receiptHandles.get(handle as HandoffCheckReceipt);
    if (record === undefined) fail("identity", "Check receipt was not issued by this store.");
    return record;
  }

  #requireAdoption(handle: unknown): AdoptionRecord {
    if (typeof handle !== "object" || handle === null) {
      fail("identity", "Adoption was not issued by this store.");
    }
    const record = this.#adoptionHandles.get(handle as HandoffAdoption);
    if (record === undefined) fail("identity", "Adoption was not issued by this store.");
    return record;
  }

  #release(reservation: ReservationRecord): void {
    if (reservation.state !== "pending") return;
    reservation.state = "released";
    this.#reservations.delete(reservation.reservationId);
    this.#pendingBytes -= reservation.reservedBytes;
    this.#metadataBytes -= reservation.metadataReserved;
  }

  #checkReserveCapacity(initial: boolean): void {
    if (this.#captures.size + this.#reservations.size >= this.#limits.maxCaptures) {
      fail("capacity", "Handoff capture capacity is exhausted.");
    }
    if (this.#offers.size + this.#reservations.size >= this.#limits.maxOffers) {
      fail("capacity", "Handoff offer capacity is exhausted.");
    }
    if (initial && this.#chains.size + this.#pendingInitialCount() >= this.#limits.maxChains) {
      fail("capacity", "Handoff chain capacity is exhausted.");
    }
    if (this.#retainedBytes + this.#pendingBytes + MAX_OUTPUT_FILE_BYTES > this.#limits.maxRetainedBytes) {
      fail("capacity", "Handoff retained and pending byte capacity is exhausted.");
    }
  }

  #reserve(input: {
    mode: "initial" | "repair";
    plan: NativeTextCheckPlan;
    planProposalCallRef: HandoffCallRef;
    planProposalFacts: HandoffBindingFacts;
    producerFacts: HandoffBindingFacts;
    relativePath: string;
    workRef: HandoffWorkRef;
    producerRef: HandoffProducerRef;
    chainId: string;
    baseCapture: CaptureRecord | null;
    repairOffer: OfferRecord | null;
    repairConsumerRef: HandoffConsumerRef | null;
    repairParentCallRef: HandoffCallRef | null;
    repairRead: ReadRecord | null;
    repairAdoption: AdoptionRecord | null;
    expectedChainVersion: number;
  }): HandoffCaptureReservation {
    this.#requireActive();
    this.#checkReserveCapacity(input.mode === "initial");
    const metadataReserved = PENDING_METADATA_BYTES
      + (input.mode === "initial" ? encodedBytes(input.plan) : 0);
    if (this.#metadataBytes + metadataReserved > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    const reservationId = randomUUID();
    const handle: HandoffCaptureReservation = Object.freeze({
      reservationId,
      mode: input.mode,
      reservedBytes: MAX_OUTPUT_FILE_BYTES,
    });
    const record: ReservationRecord = {
      handle,
      reservationId,
      mode: input.mode,
      plan: input.plan,
      planProposalCallRef: input.planProposalCallRef,
      planProposalFacts: input.planProposalFacts,
      producerFacts: input.producerFacts,
      relativePath: input.relativePath,
      workRef: input.workRef,
      producerRef: input.producerRef,
      reservedBytes: MAX_OUTPUT_FILE_BYTES,
      metadataReserved,
      chainId: input.chainId,
      baseCapture: input.baseCapture,
      repairOffer: input.repairOffer,
      repairConsumerRef: input.repairConsumerRef,
      repairParentCallRef: input.repairParentCallRef,
      repairRead: input.repairRead,
      repairAdoption: input.repairAdoption,
      expectedChainVersion: input.expectedChainVersion,
      state: "pending",
    };
    this.#reservations.set(reservationId, record);
    this.#reservationHandles.set(handle, record);
    this.#pendingBytes += record.reservedBytes;
    this.#metadataBytes += metadataReserved;
    return handle;
  }

  reserveCapture(request: HandoffCaptureRequest): HandoffCaptureReservation {
    const record = readOwnRecord(request, "capture request", [
      "work",
      "producer",
      "producerFacts",
      "proposalCall",
      "proposalFacts",
      "relativePath",
      "conditions",
    ]);
    const workRef = requireObjectRef(record.get("work"), "work reference");
    const producerRef = requireObjectRef(record.get("producer"), "producer reference");
    const producerFacts = parseFacts(record.get("producerFacts"));
    const proposalCallRef = requireObjectRef(record.get("proposalCall"), "proposal call reference");
    const proposalFacts = parseFacts(record.get("proposalFacts"));
    const relativePath = requireRelativePath(record.get("relativePath"));
    // A1 normalization happens before slot/byte acceptance or any host read.
    const plan = createNativeTextCheckPlan({ conditions: record.get("conditions") });
    this.#requireActive();
    return this.#reserve({
      mode: "initial",
      plan,
      planProposalCallRef: proposalCallRef,
      planProposalFacts: proposalFacts,
      producerFacts,
      relativePath,
      workRef,
      producerRef,
      chainId: randomUUID(),
      baseCapture: null,
      repairOffer: null,
      repairConsumerRef: null,
      repairParentCallRef: null,
      repairRead: null,
      repairAdoption: null,
      expectedChainVersion: 0,
    });
  }

  reserveRepairCapture(request: HandoffRepairRequest): HandoffCaptureReservation {
    const record = readOwnRecord(request, "repair request", [
      "fromOffer",
      "work",
      "producer",
      "producerFacts",
      "expectedHeadCaptureId",
      "expectedChainVersion",
    ]);
    const offer = this.#requireOffer(record.get("fromOffer"));
    const workRef = requireObjectRef(record.get("work"), "work reference");
    const producerRef = requireObjectRef(record.get("producer"), "producer reference");
    const producerFacts = parseFacts(record.get("producerFacts"));
    const expectedHeadCaptureId = requireId(record.get("expectedHeadCaptureId"), "expected head capture id");
    const expectedChainVersion = boundedInteger(
      record.get("expectedChainVersion"),
      "expected chain version",
      1,
      Number.MAX_SAFE_INTEGER - 1,
    );
    // Proxy descriptors above may synchronously invalidate the store.
    this.#requireActive();
    if (offer.capture.chain.headCaptureId !== offer.capture.captureId) {
      fail("state", "Repair source capture is not the current chain head.");
    }
    if (offer.state !== "bound" || offer.consumerRef === null || offer.callRef === null) {
      fail("state", "Repair offer has no bound consumer call.");
    }
    if (
      offer.read === null
      || !offer.read.delivered
      || offer.read.deliveredDigest !== offer.read.digest
      || offer.read.conflicted
      || offer.read.consumerRef !== offer.consumerRef
      || offer.read.callRef !== offer.callRef
    ) {
      fail("state", "Repair offer has no usable exact read observation.");
    }
    if (offer.failAdoption === null || !failAdoptionUsable(offer.failAdoption, offer.capture)) {
      fail("state", "Repair offer has no usable FAIL adoption feedback for its capture.");
    }
    if (workRef !== offer.capture.workRef) {
      fail("identity", "Repair work reference does not match the captured work.");
    }
    if (producerRef !== offer.consumerRef) {
      fail("identity", "Repair producer must be the repair offer's bound consumer.");
    }
    const chain = offer.capture.chain;
    if (chain.headCaptureId !== expectedHeadCaptureId || chain.version !== expectedChainVersion) {
      fail("state", "Repair chain head or version is stale.");
    }
    return this.#reserve({
      mode: "repair",
      plan: chain.plan,
      planProposalCallRef: chain.planProposalCallRef,
      planProposalFacts: chain.planProposalFacts,
      producerFacts,
      relativePath: offer.capture.file.relativePath,
      workRef,
      producerRef,
      chainId: chain.chainId,
      baseCapture: offer.capture,
      repairOffer: offer,
      repairConsumerRef: offer.consumerRef,
      repairParentCallRef: offer.callRef,
      repairRead: offer.read,
      repairAdoption: offer.failAdoption,
      expectedChainVersion,
    });
  }

  commitCapture(
    reservation: HandoffCaptureReservation,
    snapshot: NativeWorkspaceTextSnapshot,
  ): HandoffCaptureCommit {
    const record = this.#requireReservation(reservation);
    if (record.state !== "pending") {
      fail("state", "Capture reservation is no longer pending.");
    }
    if (this.#state !== "active") {
      this.#release(record);
      fail("state", "Handoff store is no longer active.");
    }
    try {
      if (!isNativeWorkspaceTextSnapshot(snapshot)) {
        fail("identity", "Capture snapshot was not issued by the A1 observation API.");
      }
      if (snapshot.file.relativePath !== record.relativePath) {
        fail("identity", "Capture snapshot path does not match the reservation.");
      }
      if (
        !Number.isSafeInteger(snapshot.file.bytes)
        || snapshot.file.bytes < 0
        || snapshot.file.bytes > record.reservedBytes
      ) {
        fail("capacity", "Capture snapshot exceeds the reserved byte allowance.");
      }
      return record.mode === "initial"
        ? this.#commitInitial(record, snapshot)
        : this.#commitRepair(record, snapshot);
    } catch (error) {
      if (record.state === "pending") this.#release(record);
      throw error;
    }
  }

  #commitInitial(
    reservation: ReservationRecord,
    snapshot: NativeWorkspaceTextSnapshot,
  ): HandoffCaptureCommit {
    if (this.#chains.size + this.#pendingInitialCount() > this.#limits.maxChains) {
      fail("capacity", "Handoff chain capacity is exhausted.");
    }
    if (this.#captures.size + this.#reservations.size > this.#limits.maxCaptures) {
      fail("capacity", "Handoff capture capacity is exhausted.");
    }
    if (this.#offers.size + this.#reservations.size > this.#limits.maxOffers) {
      fail("capacity", "Handoff offer capacity is exhausted.");
    }
    const chain: ChainRecord = {
      chainId: reservation.chainId,
      plan: reservation.plan,
      planProposalCallRef: reservation.planProposalCallRef,
      planProposalFacts: reservation.planProposalFacts,
      version: 1,
      headCaptureId: "",
      captures: 0,
      metadataBytes: 0,
    };
    const captureId = randomUUID();
    const offerId = randomUUID();
    chain.headCaptureId = captureId;
    chain.captures = 1;
    const file = copyFile(snapshot.file);
    const captureHandle: HandoffCapture = Object.freeze({ captureId });
    const capture: CaptureRecord = {
      handle: captureHandle,
      captureId,
      snapshot,
      file,
      chain,
      version: 1,
      plan: reservation.plan,
      proposalFacts: reservation.planProposalFacts,
      proposalCallRef: reservation.planProposalCallRef,
      producerFacts: reservation.producerFacts,
      workRef: reservation.workRef,
      producerRef: reservation.producerRef,
      initial: true,
      baseCaptureId: null,
      repairOfferId: null,
    };
    const offerHandle: HandoffOffer = Object.freeze({ offerId });
    const offer: OfferRecord = {
      handle: offerHandle,
      offerId,
      capture,
      failAdoption: null,
      state: "open",
      failureReason: null,
      consumerRef: null,
      callRef: null,
      bindingFacts: null,
      read: null,
      receipt: null,
      metadataBytes: 0,
    };
    chain.metadataBytes = chainMetadataBytes(chain);
    offer.metadataBytes = offerMetadataBytes(offer);
    const actualMetadata = encodedBytes(reservation.plan)
      + chain.metadataBytes
      + encodedBytes(captureView(capture))
      + offer.metadataBytes;
    this.#finishCommit(reservation, snapshot, actualMetadata, () => {
      this.#chains.set(chain.chainId, chain);
      this.#captures.set(captureId, capture);
      this.#offers.set(offerId, offer);
      this.#captureHandles.set(captureHandle, capture);
      this.#offerHandles.set(offerHandle, offer);
    });
    return Object.freeze({ capture: captureHandle, offer: offerHandle });
  }

  #commitRepair(
    reservation: ReservationRecord,
    snapshot: NativeWorkspaceTextSnapshot,
  ): HandoffCaptureCommit {
    const base = reservation.baseCapture;
    const repairOffer = reservation.repairOffer;
    const repairRead = reservation.repairRead;
    const repairAdoption = reservation.repairAdoption;
    if (
      base === null
      || repairOffer === null
      || repairRead === null
      || repairAdoption === null
      || reservation.repairConsumerRef === null
      || reservation.repairParentCallRef === null
    ) {
      fail("state", "Repair reservation lost its source offer facts.");
    }
    if (repairOffer.capture !== base) {
      fail("identity", "Repair offer no longer belongs to the base capture.");
    }
    if (
      repairOffer.state !== "bound"
      || repairOffer.consumerRef !== reservation.repairConsumerRef
      || repairOffer.callRef !== reservation.repairParentCallRef
    ) {
      fail("state", "Repair offer is no longer bound to the original consumer call.");
    }
    if (
      repairOffer.read !== repairRead
      || !repairRead.delivered
      || repairRead.deliveredDigest !== repairRead.digest
      || repairRead.conflicted
      || repairRead.consumerRef !== reservation.repairConsumerRef
      || repairRead.callRef !== reservation.repairParentCallRef
    ) {
      fail("state", "Repair read observation is no longer usable.");
    }
    if (repairOffer.failAdoption !== repairAdoption) {
      fail("state", "Repair FAIL adoption feedback changed before commit.");
    }
    if (!failAdoptionUsable(repairAdoption, base)) {
      fail("state", "Repair FAIL adoption feedback is no longer usable.");
    }
    const chain = base.chain;
    if (
      chain.headCaptureId !== base.captureId
      || chain.version !== reservation.expectedChainVersion
    ) {
      fail("state", "Repair chain head or version changed before commit.");
    }
    if (chain.version >= Number.MAX_SAFE_INTEGER - 1) {
      fail("capacity", "Handoff chain version limit is exhausted.");
    }
    if (this.#captures.size + this.#reservations.size > this.#limits.maxCaptures) {
      fail("capacity", "Handoff capture capacity is exhausted.");
    }
    if (this.#offers.size + this.#reservations.size > this.#limits.maxOffers) {
      fail("capacity", "Handoff offer capacity is exhausted.");
    }
    const version = chain.version + 1;
    const captureId = randomUUID();
    const offerId = randomUUID();
    const file = copyFile(snapshot.file);
    const captureHandle: HandoffCapture = Object.freeze({ captureId });
    const capture: CaptureRecord = {
      handle: captureHandle,
      captureId,
      snapshot,
      file,
      chain,
      version,
      plan: chain.plan,
      proposalFacts: chain.planProposalFacts,
      proposalCallRef: chain.planProposalCallRef,
      producerFacts: reservation.producerFacts,
      workRef: reservation.workRef,
      producerRef: reservation.producerRef,
      initial: false,
      baseCaptureId: base.captureId,
      repairOfferId: repairOffer.offerId,
    };
    const offerHandle: HandoffOffer = Object.freeze({ offerId });
    const offer: OfferRecord = {
      handle: offerHandle,
      offerId,
      capture,
      failAdoption: null,
      state: "open",
      failureReason: null,
      consumerRef: null,
      callRef: null,
      bindingFacts: null,
      read: null,
      receipt: null,
      metadataBytes: 0,
    };
    const nextChainBytes = chainMetadataBytes({
      ...chain,
      version,
      headCaptureId: captureId,
      captures: chain.captures + 1,
    });
    offer.metadataBytes = offerMetadataBytes(offer);
    const actualMetadata = (nextChainBytes - chain.metadataBytes)
      + encodedBytes(captureView(capture))
      + offer.metadataBytes;
    this.#finishCommit(reservation, snapshot, actualMetadata, () => {
      chain.version = version;
      chain.headCaptureId = captureId;
      chain.captures += 1;
      chain.metadataBytes = nextChainBytes;
      this.#captures.set(captureId, capture);
      this.#offers.set(offerId, offer);
      this.#captureHandles.set(captureHandle, capture);
      this.#offerHandles.set(offerHandle, offer);
    });
    return Object.freeze({ capture: captureHandle, offer: offerHandle });
  }

  #finishCommit(
    reservation: ReservationRecord,
    snapshot: NativeWorkspaceTextSnapshot,
    actualMetadata: number,
    publish: () => void,
  ): void {
    const nextMetadata = this.#metadataBytes - reservation.metadataReserved + actualMetadata;
    if (nextMetadata > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted at commit.");
    }
    const nextRetained = this.#retainedBytes + snapshot.file.bytes;
    const otherPending = this.#pendingBytes - reservation.reservedBytes;
    if (nextRetained + otherPending > this.#limits.maxRetainedBytes) {
      fail("capacity", "Handoff byte capacity is exhausted at commit.");
    }
    // No failure points after this comment: publication is atomic.
    reservation.state = "committed";
    this.#reservations.delete(reservation.reservationId);
    this.#pendingBytes -= reservation.reservedBytes;
    this.#metadataBytes = nextMetadata;
    this.#retainedBytes = nextRetained;
    publish();
  }

  abandonCapture(reservation: HandoffCaptureReservation): void {
    const record = this.#requireReservation(reservation);
    this.#release(record);
  }

  offer(capture: HandoffCapture, failAdoption?: HandoffAdoption): HandoffOffer {
    this.#requireActive();
    const captureRecord = this.#requireCapture(capture);
    if (captureRecord.chain.headCaptureId !== captureRecord.captureId) {
      fail("state", "Only the current chain head can be offered.");
    }
    const adoption = failAdoption === undefined ? null : this.#requireAdoption(failAdoption);
    if (adoption !== null) {
      if (adoption.capture !== captureRecord) {
        fail("identity", "Offer feedback adoption belongs to another capture.");
      }
      // Historical FAIL records remain visible, but a failed checker offer
      // cannot seed a new repair.
      if (!failAdoptionUsable(adoption, captureRecord)) {
        fail("state", "Fail adoption feedback is no longer usable for repair.");
      }
    }
    if (this.#offers.size + this.#reservations.size >= this.#limits.maxOffers) {
      fail("capacity", "Handoff offer capacity is exhausted.");
    }
    const offerId = randomUUID();
    const handle: HandoffOffer = Object.freeze({ offerId });
    const record: OfferRecord = {
      handle,
      offerId,
      capture: captureRecord,
      failAdoption: adoption,
      state: "open",
      failureReason: null,
      consumerRef: null,
      callRef: null,
      bindingFacts: null,
      read: null,
      receipt: null,
      metadataBytes: 0,
    };
    record.metadataBytes = offerMetadataBytes(record);
    if (this.#metadataBytes + record.metadataBytes > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    this.#offers.set(offerId, record);
    this.#offerHandles.set(handle, record);
    this.#metadataBytes += record.metadataBytes;
    return handle;
  }

  bindOfferConsumer(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    facts: HandoffBindingFacts,
  ): HandoffOfferView {
    this.#requireActive();
    const record = this.#requireOffer(offer);
    const consumerRef = requireObjectRef(consumer, "consumer reference");
    const callRef = requireObjectRef(parentTaskCall, "parent task call reference");
    const bindingFacts = parseFacts(facts);
    // Proxy descriptors above may synchronously invalidate the store.
    this.#requireActive();
    if (record.state === "bound") {
      if (
        record.consumerRef === consumerRef
        && record.callRef === callRef
        && record.bindingFacts !== null
        && sameFacts(record.bindingFacts, bindingFacts)
      ) {
        return offerView(record);
      }
      record.state = "failed";
      record.failureReason = "binding-conflict";
      fail("conflict", "Offer binding is already consumed by a different call.");
    }
    if (record.state !== "open") fail("state", "Offer cannot bind a consumer in its current state.");
    const candidate: OfferRecord = {
      ...record,
      state: "bound",
      consumerRef,
      callRef,
      bindingFacts,
    };
    const candidateBytes = offerMetadataBytes(candidate);
    const nextMetadata = this.#metadataBytes - record.metadataBytes + candidateBytes;
    if (nextMetadata > this.#limits.maxMetadataBytes) {
      record.state = "failed";
      record.failureReason = "binding-metadata";
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    record.state = "bound";
    record.consumerRef = consumerRef;
    record.callRef = callRef;
    record.bindingFacts = bindingFacts;
    record.metadataBytes = candidateBytes;
    this.#metadataBytes = nextMetadata;
    return offerView(record);
  }

  markBindingFailed(offer: HandoffOffer, reason?: string): void {
    this.#requireActive();
    const record = this.#requireOffer(offer);
    // Normalize before mutation so malformed input cannot half-fail the offer.
    const normalized = requireReason(reason, "binding-failed");
    // A bounded terminal marker is already reserved per offer; this remains
    // monotonic after a historical receipt and even when the cap is full.
    if (record.state === "failed") return;
    record.state = "failed";
    record.failureReason = normalized;
  }

  prepareRead(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    readToolCall: HandoffToolCallRef,
    readCallId: string,
  ): HandoffReadPreparation {
    this.#requireActive();
    const record = this.#requireOffer(offer);
    if (record.state !== "bound" || record.consumerRef === null || record.callRef === null) {
      fail("state", "Offer has no bound consumer call.");
    }
    const consumerRef = requireObjectRef(consumer, "consumer reference");
    const callRef = requireObjectRef(parentTaskCall, "parent task call reference");
    const toolCallRef = requireObjectRef(readToolCall, "read tool call reference");
    const toolCallFacts = parseToolCallFacts(readCallId);
    if (record.consumerRef !== consumerRef || record.callRef !== callRef) {
      fail("identity", "Read request does not match the offer's bound consumer call.");
    }
    if (record.read !== null) {
      if (
        record.read.consumerRef !== consumerRef
        || record.read.callRef !== callRef
        || record.read.toolCallRef !== toolCallRef
        || record.read.toolCallFacts.callId !== toolCallFacts.callId
      ) {
        fail("conflict", "Offer read was already issued for another actual tool call.");
      }
      return Object.freeze({
        read: record.read.handle,
        view: record.read.view,
        digest: record.read.digest,
      });
    }
    const readId = randomUUID();
    const view = readView({ readId, offer: record, toolCallFacts });
    const json = encodeJson(view);
    if (new TextEncoder().encode(json).byteLength > this.#limits.maxReadBytes) {
      fail("encoding", "Prepared read exceeds the full JSON encoding limit.");
    }
    const digest = sha256Hex(json);
    // Exact canonical store metadata: omit raw text and replace the shared
    // full plan with its fixed digest reference. Path, file, feedback and all
    // wrappers remain included with their actual UTF-8 encoding.
    const metadata = encodedBytes({
      ...view,
      text: "",
      plan: {
        checkerId: view.plan.checkerId,
        checkerVersion: view.plan.checkerVersion,
        schemaVersion: view.plan.schemaVersion,
        digest: view.plan.digest,
      },
    }) + READ_OBSERVATION_METADATA_BYTES;
    if (this.#metadataBytes + metadata > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    const handle: HandoffPreparedRead = Object.freeze({ readId, offerId: record.offerId });
    const read: ReadRecord = {
      handle,
      readId,
      offer: record,
      consumerRef,
      callRef,
      toolCallRef,
      toolCallFacts,
      view,
      digest,
      delivered: false,
      deliveredDigest: null,
      conflicted: false,
      conflictDigest: null,
      conflictReason: null,
    };
    record.read = read;
    this.#readHandles.set(handle, read);
    this.#metadataBytes += metadata;
    return Object.freeze({ read: handle, view, digest });
  }

  observeReadResult(
    read: HandoffPreparedRead,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    readToolCall: HandoffToolCallRef,
    readCallId: string,
    fullResultDigest: string,
    success: boolean,
  ): boolean {
    if (this.#state !== "active") return false;
    if (typeof read !== "object" || read === null) return false;
    const record = this.#readHandles.get(read);
    if (record === undefined) return false;
    if (typeof consumer !== "object" || consumer === null) return false;
    if (typeof parentTaskCall !== "object" || parentTaskCall === null) return false;
    if (typeof readToolCall !== "object" || readToolCall === null) return false;
    if (record.consumerRef !== consumer || record.callRef !== parentTaskCall) return false;
    if (record.toolCallRef !== readToolCall || record.toolCallFacts.callId !== readCallId) return false;
    if (record.offer.state !== "bound") return false;
    const digestValid = typeof fullResultDigest === "string" && /^[0-9a-f]{64}$/.test(fullResultDigest);
    if (success !== true) {
      // Same exact actual call: a failed observation is terminal for usability.
      if (!record.conflicted) {
        record.conflicted = true;
        record.conflictReason = "failed-observation";
        record.conflictDigest = digestValid ? fullResultDigest : null;
      }
      return false;
    }
    if (record.conflicted) return false;
    if (!digestValid) {
      record.conflicted = true;
      record.conflictReason = "result-mismatch";
      record.conflictDigest = null;
      return false;
    }
    if (record.delivered) {
      if (record.deliveredDigest === fullResultDigest) return true;
      record.conflicted = true;
      record.conflictReason = "result-mismatch";
      record.conflictDigest = fullResultDigest;
      return false;
    }
    if (fullResultDigest !== record.digest) {
      record.conflicted = true;
      record.conflictReason = "result-mismatch";
      record.conflictDigest = fullResultDigest;
      return false;
    }
    record.delivered = true;
    record.deliveredDigest = fullResultDigest;
    return true;
  }

  check(
    offer: HandoffOffer,
    consumer: HandoffConsumerRef,
    parentTaskCall: HandoffCallRef,
    checkerToolCall: HandoffToolCallRef,
    checkCallId: string,
  ): HandoffCheckReceipt {
    this.#requireActive();
    const record = this.#requireOffer(offer);
    if (record.state !== "bound" || record.consumerRef === null || record.callRef === null) {
      fail("state", "Offer has no bound consumer call.");
    }
    const consumerRef = requireObjectRef(consumer, "consumer reference");
    const callRef = requireObjectRef(parentTaskCall, "parent task call reference");
    const checkerCallRef = requireObjectRef(checkerToolCall, "checker tool call reference");
    const checkerCallFacts = parseToolCallFacts(checkCallId);
    if (record.consumerRef !== consumerRef || record.callRef !== callRef) {
      fail("identity", "Check request does not match the offer's bound consumer call.");
    }
    if (record.receipt !== null) {
      if (
        record.receipt.consumerRef === consumerRef
        && record.receipt.callRef === callRef
        && record.receipt.checkerCallRef === checkerCallRef
        && record.receipt.checkerCallFacts.callId === checkerCallFacts.callId
      ) {
        return record.receipt.handle;
      }
      fail("conflict", "Offer already has a check receipt for another actual tool call.");
    }
    if (this.#receipts.size >= this.#limits.maxReceipts) {
      fail("capacity", "Handoff receipt capacity is exhausted.");
    }
    let a1: NativeTextCheckReceipt;
    try {
      a1 = runNativeTextChecks(record.capture.snapshot, record.capture.plan);
    } catch {
      fail("state", "Native text checks could not be completed.");
    }
    if (!matchesNativeTextCheckReceipt(a1, record.capture.snapshot, record.capture.plan)) {
      fail("identity", "Native text check receipt did not match the captured snapshot and plan.");
    }
    const receiptId = randomUUID();
    const handle: HandoffCheckReceipt = Object.freeze({ receiptId });
    const receipt: ReceiptRecord = {
      handle,
      receiptId,
      offer: record,
      capture: record.capture,
      consumerRef,
      callRef,
      parentBindingFacts: record.bindingFacts!,
      checkerCallRef,
      checkerCallFacts,
      a1,
    };
    const metadata = encodedBytes(receiptView(receipt));
    if (this.#metadataBytes + metadata > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    record.receipt = receipt;
    this.#receipts.set(receiptId, receipt);
    this.#receiptHandles.set(handle, receipt);
    this.#metadataBytes += metadata;
    return handle;
  }

  adopt(request: HandoffAdoptRequest): HandoffAdoption {
    this.#requireActive();
    const record = readOwnRecord(request, "adoption request", [
      "receipt",
      "capture",
      "work",
      "consumer",
      "producer",
      "file",
      "adoptionCall",
      "adoptionCallId",
    ]);
    const receipt = this.#requireReceipt(record.get("receipt"));
    const capture = this.#requireCapture(record.get("capture"));
    const workRef = requireObjectRef(record.get("work"), "work reference");
    const consumerRef = requireObjectRef(record.get("consumer"), "consumer reference");
    const producerRef = requireObjectRef(record.get("producer"), "producer reference");
    const file = parseLiveFile(record.get("file"));
    const adoptionCallRef = requireObjectRef(record.get("adoptionCall"), "adoption tool call reference");
    const adoptionCallFacts = parseToolCallFacts(record.get("adoptionCallId"));
    // Proxy descriptors above may synchronously invalidate the store.
    this.#requireActive();
    if (receipt.capture !== capture || receipt.offer.capture !== capture) {
      fail("identity", "Adoption receipt and capture do not belong together.");
    }
    if (receipt.offer.state !== "bound") {
      fail("state", "Checked offer is no longer bound for a new adoption.");
    }
    if (capture.chain.headCaptureId !== capture.captureId) {
      fail("state", "Capture is no longer the current chain head.");
    }
    if (workRef !== capture.workRef) {
      fail("identity", "Adoption work reference does not match the captured work.");
    }
    if (consumerRef !== receipt.consumerRef) {
      fail("identity", "Adoption consumer reference does not match the checked consumer.");
    }
    if (producerRef !== capture.producerRef) {
      fail("identity", "Adoption producer reference does not match the captured producer.");
    }
    if (
      file.relativePath !== capture.file.relativePath
      || file.bytes !== capture.file.bytes
      || file.sha256 !== capture.file.sha256
    ) {
      fail("conflict", "Live file facts do not match the captured file facts.");
    }
    if (!matchesNativeTextCheckReceipt(receipt.a1, capture.snapshot, capture.plan)) {
      fail("identity", "Check receipt does not match the capture snapshot and plan.");
    }
    const matchesExisting = (existing: AdoptionRecord): boolean =>
      existing.receipt === receipt
      && existing.capture === capture
      && existing.workRef === workRef
      && existing.consumerRef === consumerRef
      && existing.producerRef === producerRef
      && existing.adoptionCallRef === adoptionCallRef
      && existing.adoptionCallFacts.callId === adoptionCallFacts.callId
      && sameLiveFile(existing.file, file);

    const existingByReceipt = this.#adoptionsByReceipt.get(receipt);
    if (existingByReceipt !== undefined) {
      if (matchesExisting(existingByReceipt)) return existingByReceipt.handle;
      fail("conflict", "Check receipt already has a different adoption.");
    }
    // The same actual main adoption call may only replay its exact original
    // adoption. A different receipt, capture, work/consumer/producer, live file
    // or callId is a conflict, not a second adoption. The scan is bounded by
    // maxAdoptions (<= 16) and runs before capacity so exact replay still works
    // at the cap.
    for (const existing of this.#adoptions.values()) {
      if (existing.adoptionCallRef !== adoptionCallRef) continue;
      if (matchesExisting(existing)) return existing.handle;
      fail("conflict", "Adoption call already published a different adoption.");
    }
    if (this.#adoptions.size >= this.#limits.maxAdoptions) {
      fail("capacity", "Handoff adoption capacity is exhausted.");
    }
    const adoptionId = randomUUID();
    const handle: HandoffAdoption = Object.freeze({ adoptionId });
    const adoption: AdoptionRecord = {
      handle,
      adoptionId,
      receipt,
      capture,
      workRef,
      consumerRef,
      producerRef,
      adoptionCallRef,
      adoptionCallFacts,
      file,
    };
    const metadata = encodedBytes(adoptionView(adoption));
    if (this.#metadataBytes + metadata > this.#limits.maxMetadataBytes) {
      fail("metadata", "Handoff metadata capacity is exhausted.");
    }
    this.#adoptions.set(adoptionId, adoption);
    this.#adoptionsByReceipt.set(receipt, adoption);
    this.#adoptionHandles.set(handle, adoption);
    this.#metadataBytes += metadata;
    return handle;
  }

  inspect(): HandoffInspectView {
    const chainItems: HandoffChainSummary[] = [];
    const captureItems: HandoffCaptureView[] = [];
    const offerItems: HandoffOfferView[] = [];
    const receiptItems: HandoffReceiptSummary[] = [];
    const adoptionItems: HandoffAdoptionView[] = [];
    const allChains = [...this.#chains.values()].map(chainSummary);
    const allCaptures = [...this.#captures.values()].map(captureView);
    const allOffers = [...this.#offers.values()].map(offerView);
    const allReceipts = [...this.#receipts.values()].map((receipt): HandoffReceiptSummary => Object.freeze({
      receiptId: receipt.receiptId,
      offerId: receipt.offer.offerId,
      captureId: receipt.capture.captureId,
      outcome: receipt.a1.outcome,
      planDigest: receipt.capture.plan.digest,
    }));
    const allAdoptions = [...this.#adoptions.values()].map(adoptionView);

    const build = (): HandoffInspectView => deepFreeze({
      schema: NATIVE_HANDOFF_INSPECT_SCHEMA,
      authority: "non-authoritative",
      state: this.#state,
      reason: this.#reason,
      complete: chainItems.length === allChains.length
        && captureItems.length === allCaptures.length
        && offerItems.length === allOffers.length
        && receiptItems.length === allReceipts.length
        && adoptionItems.length === allAdoptions.length,
      limits: this.#limits,
      usage: {
        chains: this.#chains.size,
        captures: this.#captures.size,
        offers: this.#offers.size,
        receipts: this.#receipts.size,
        adoptions: this.#adoptions.size,
        pendingReservations: this.#reservations.size,
        retainedBytes: this.#retainedBytes,
        pendingBytes: this.#pendingBytes,
        metadataBytes: this.#metadataBytes,
      },
      chains: freezeCategory(allChains.length, chainItems),
      captures: freezeCategory(allCaptures.length, captureItems),
      offers: freezeCategory(allOffers.length, offerItems),
      receipts: freezeCategory(allReceipts.length, receiptItems),
      adoptions: freezeCategory(allAdoptions.length, adoptionItems),
      pending: Object.freeze({
        reservations: this.#reservations.size,
        bytes: this.#pendingBytes,
        metadataBytes: this.#reservations.size === 0
          ? 0
          : [...this.#reservations.values()].reduce(
            (sum, reservation) => sum + reservation.metadataReserved,
            0,
          ),
      }),
    });

    const categories: Array<{ all: readonly unknown[]; items: unknown[] }> = [
      { all: allChains, items: chainItems },
      { all: allCaptures, items: captureItems },
      { all: allOffers, items: offerItems },
      { all: allReceipts, items: receiptItems },
      { all: allAdoptions, items: adoptionItems },
    ];
    for (const category of categories) {
      for (const item of category.all) {
        category.items.push(item);
        if (encodedBytes(build()) > this.#limits.maxInspectBytes) {
          category.items.pop();
          break;
        }
      }
    }
    return build();
  }

  resolveCapture(captureId: string): HandoffCapture | null {
    if (typeof captureId !== "string") return null;
    return this.#captures.get(captureId)?.handle ?? null;
  }

  resolveOffer(offerId: string): HandoffOffer | null {
    if (typeof offerId !== "string") return null;
    return this.#offers.get(offerId)?.handle ?? null;
  }

  resolveCheckReceipt(receiptId: string): HandoffCheckReceipt | null {
    if (typeof receiptId !== "string") return null;
    return this.#receipts.get(receiptId)?.handle ?? null;
  }

  resolveAdoption(adoptionId: string): HandoffAdoption | null {
    if (typeof adoptionId !== "string") return null;
    return this.#adoptions.get(adoptionId)?.handle ?? null;
  }

  lookupCapture(captureId: string): HandoffCaptureView | null {
    if (typeof captureId !== "string") return null;
    const record = this.#captures.get(captureId);
    return record === undefined ? null : captureView(record);
  }

  lookupOffer(offerId: string): HandoffOfferView | null {
    if (typeof offerId !== "string") return null;
    const record = this.#offers.get(offerId);
    return record === undefined ? null : offerView(record);
  }

  lookupReceipt(receiptId: string): HandoffCheckReceiptView | null {
    if (typeof receiptId !== "string") return null;
    const record = this.#receipts.get(receiptId);
    return record === undefined ? null : receiptView(record);
  }

  lookupAdoption(adoptionId: string): HandoffAdoptionView | null {
    if (typeof adoptionId !== "string") return null;
    const record = this.#adoptions.get(adoptionId);
    return record === undefined ? null : adoptionView(record);
  }

  matchAdoption(adoption: HandoffAdoption, file: HandoffLiveFileFacts): boolean {
    if (typeof adoption !== "object" || adoption === null) return false;
    const record = this.#adoptionHandles.get(adoption);
    if (record === undefined) return false;
    let parsed: HandoffLiveFileFacts;
    try {
      parsed = parseLiveFile(file);
    } catch {
      return false;
    }
    if (!sameLiveFile(record.file, parsed)) return false;
    return matchesNativeTextCheckReceipt(record.receipt.a1, record.capture.snapshot, record.capture.plan);
  }

  matchesCaptureBinding(
    capture: HandoffCapture,
    work: HandoffWorkRef,
    producer: HandoffProducerRef,
  ): boolean {
    if (typeof capture !== "object" || capture === null) return false;
    const record = this.#captureHandles.get(capture);
    if (record === undefined) return false;
    // Exact opaque object identity only. No caller property is read, no host
    // callback runs and no state/head/currentness is consulted.
    return record.workRef === work && record.producerRef === producer;
  }

  invalidate(reason?: string): void {
    if (this.#state === "disposed") return;
    if (this.#state === "invalidated") return;
    // Normalize before mutation; a malicious descriptor cannot half-invalidate.
    const normalized = requireReason(reason, "invalidated", 64);
    this.#state = "invalidated";
    this.#reason = normalized;
    for (const reservation of [...this.#reservations.values()]) this.#release(reservation);
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#reason = "disposed";
    for (const reservation of [...this.#reservations.values()]) this.#release(reservation);
  }
}

const storesByRoot = new WeakMap<object, NativeHandoffStore>();

/**
 * Returns the single store for one opaque root identity. A later call with the
 * same root object cannot replace its limits; a disposed store is returned as
 * disposed instead of recreated. Different objects are different scopes even
 * if they describe the same filesystem path; the trusted entry owns that fact.
 */
export function openNativeHandoffStore(
  root: HandoffRootRef,
  limits?: Partial<NativeHandoffLimits>,
): NativeHandoffStore {
  const rootRef = requireObjectRef(root, "root reference");
  const existing = storesByRoot.get(rootRef);
  if (existing !== undefined) {
    if (limits !== undefined) {
      fail("state", "Handoff store limits are fixed after creation.");
    }
    return existing;
  }
  const normalized = normalizeLimits(limits);
  // Normalization may run user proxy traps that reenter with the same root.
  const createdDuringNormalization = storesByRoot.get(rootRef);
  if (createdDuringNormalization !== undefined) {
    if (limits !== undefined) {
      fail("state", "Handoff store limits were fixed during normalization.");
    }
    return createdDuringNormalization;
  }
  const store = new NativeHandoffStoreImpl(normalized);
  storesByRoot.set(rootRef, store);
  return store;
}
