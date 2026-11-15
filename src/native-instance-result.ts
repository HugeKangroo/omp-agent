import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/**
 * Pure, bounded observation of one native `task` tool_result envelope.
 *
 * This module owns no scheduler, subscription, filesystem, work state, or
 * result ledger. It snapshots only the normalized tool-result envelope and
 * marks whether the event's native child identity matches the association
 * already proven by the instance entry. It never accepts work, reads an
 * outputPath, or derives a child session from result text.
 */

export const NATIVE_INSTANCE_RESULT_SCHEMA = "omp-agent.native-instance-result.v1";
export const NATIVE_INSTANCE_RESULT_VERSION = 1;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
export const MAX_ENVELOPE_DEPTH = 32;
export const MAX_ENVELOPE_NODES = 4096;
export const MAX_OUTPUT_EXCERPT_BYTES = 1024;
export const MAX_BOUNDED_TEXT_BYTES = 1024;
export const MAX_OUTPUT_PATH_BYTES = 4096;
export const MAX_ASSOCIATION_ID_CHARS = 256;
export const MAX_ASSOCIATION_AGENT_CHARS = 256;
export const MAX_ASSOCIATION_ROOT_CHARS = 4096;

export type NativeInstanceResultState = "observed" | "unavailable" | "conflicted";
export type NativeInstanceResultLink = "instance" | "call-only" | "unavailable";
export type NativeInstanceResultOutcome =
  | "completed-envelope"
  | "failed-envelope"
  | "aborted-envelope"
  | "unknown";

export type NativeInstanceResultEncodingReason =
  | "encoding-byte-limit"
  | "encoding-depth-limit"
  | "encoding-node-limit"
  | "encoding-cycle"
  | "encoding-accessor"
  | "encoding-nonfinite"
  | "encoding-unsupported"
  | "encoding-undefined-array-item";

export type NativeInstanceResultReason =
  | "observed-envelope"
  | "observed-call-only"
  | "expected-association-invalid"
  | "expected-association-oversized"
  | "expected-association-unreadable"
  | "event-not-object"
  | "event-unreadable"
  | "event-accessor"
  | "event-not-task"
  | "event-call-mismatch"
  | "event-content-missing"
  | "event-content-invalid"
  | "event-content-unsupported"
  | "details-missing"
  | "details-invalid"
  | "results-missing"
  | "results-invalid"
  | "results-count"
  | "result-shape"
  | "result-index"
  | "result-id"
  | "result-agent"
  | "child-unbound"
  | "observation-conflict"
  | NativeInstanceResultEncodingReason;

export type NativeInstanceResultConflictReason =
  | "association-mismatch"
  | "envelope-digest-mismatch"
  | "association-and-envelope-mismatch"
  | "unavailable-observation";

/** Association facts proven by the instance entry, never derived from a result. */
export interface NativeInstanceResultAssociation {
  readonly instanceId: string;
  readonly parentToolCallId: string;
  readonly index: 0;
  readonly childId: string | null;
  readonly childSessionId: string | null;
  readonly agentName: string;
  readonly parentSessionId: string;
  readonly workspaceRoot: string;
  readonly rootEpoch: number;
  readonly definitionVersion: string;
}

export interface NativeInstanceResultEnvelope {
  readonly encoding: "canonical-json";
  readonly complete: boolean;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

export interface NativeInstanceResultOutput {
  /** Exact UTF-8 byte count of the observed output text. */
  readonly bytes: number;
  /** Digest of the exact observed output text, not of formatted content. */
  readonly sha256: string;
  /** Prefix of the output text, at most MAX_OUTPUT_EXCERPT_BYTES UTF-8 bytes. */
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
}

export interface NativeInstanceResultText {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface NativeInstanceResultNative {
  readonly isError: boolean | null;
  readonly exitCode: number | null;
  readonly aborted: boolean | null;
  readonly truncated: boolean | null;
  readonly errorPresent: boolean;
  readonly error: NativeInstanceResultText | null;
  readonly abortReason: NativeInstanceResultText | null;
  /** Native transcript path claim only; never read or treated as a business artifact. */
  readonly outputPath: string | null;
}

export interface NativeInstanceResultConflict {
  readonly reason: NativeInstanceResultConflictReason;
  readonly firstEnvelopeSha256: string | null;
  readonly lastEnvelopeSha256: string | null;
  readonly firstAssociationSha256: string | null;
  readonly lastAssociationSha256: string | null;
  readonly lastObservationReason: NativeInstanceResultReason;
}

export interface NativeInstanceResultObservation {
  readonly schema: typeof NATIVE_INSTANCE_RESULT_SCHEMA;
  readonly version: typeof NATIVE_INSTANCE_RESULT_VERSION;
  readonly authority: "non-authoritative";
  readonly scope: "tool-result-middleware";
  readonly state: NativeInstanceResultState;
  readonly reason: NativeInstanceResultReason;
  readonly association: NativeInstanceResultAssociation | null;
  readonly link: NativeInstanceResultLink;
  readonly outcome: NativeInstanceResultOutcome;
  /** C1 cannot distinguish parent cancellation from a child-only abort. */
  readonly parentCancellation: "unknown";
  readonly semanticAcceptance: "not-evaluated";
  /** Sticky only for a matched child abort on a complete instance link. */
  readonly confirmedChildAbort: boolean;
  readonly envelope: NativeInstanceResultEnvelope;
  readonly output: NativeInstanceResultOutput | null;
  readonly native: NativeInstanceResultNative | null;
  readonly conflict: NativeInstanceResultConflict | null;
}

type OwnDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | { readonly kind: "data"; readonly value: unknown };

function readOwnData(target: object, key: string): OwnDataRead {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { kind: "missing" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "data", value: descriptor.value };
}

/** Array indexing must not invoke an own element accessor before the encoder sees it. */
function readOwnArrayElement(target: readonly unknown[], index: number): OwnDataRead {
  return readOwnData(target, String(index));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Prefix no longer than maxBytes when encoded as UTF-8; never splits a surrogate pair. */
function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let end = 0;
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += character.length;
  }
  return value.slice(0, end);
}

function boundedText(value: string, maxBytes: number): NativeInstanceResultText {
  const bytes = utf8Bytes(value);
  if (bytes <= maxBytes) {
    return Object.freeze({ text: value, bytes, truncated: false });
  }
  return Object.freeze({ text: utf8Prefix(value, maxBytes), bytes, truncated: true });
}

class EncodeFailure extends Error {
  constructor(readonly reason: NativeInstanceResultEncodingReason) {
    super(reason);
  }
}

class CanonicalSink {
  private readonly hash = createHash("sha256");
  private bytes = 0;

  append(text: string, byteLength: number = text.length): void {
    if (this.bytes + byteLength > MAX_ENVELOPE_BYTES) {
      throw new EncodeFailure("encoding-byte-limit");
    }
    this.hash.update(text, "utf8");
    this.bytes += byteLength;
  }

  /** Bounded ASCII slice: check capacity before allocating the slice. */
  appendAsciiSlice(value: string, start: number, end: number): void {
    const length = end - start;
    if (this.bytes + length > MAX_ENVELOPE_BYTES) {
      throw new EncodeFailure("encoding-byte-limit");
    }
    this.append(value.slice(start, end), length);
  }

  finish(): { readonly bytes: number; readonly sha256: string } {
    return { bytes: this.bytes, sha256: this.hash.digest("hex") };
  }
}

interface EncodeState {
  nodes: number;
  readonly ancestors: Set<object>;
}

function hex4(code: number): string {
  return code.toString(16).padStart(4, "0");
}

/**
 * JSON-compatible string escaping that is bounded while it runs. Unlike a
 * JSON.stringify call on a huge string, an oversized value stops as soon as the
 * sink would exceed MAX_ENVELOPE_BYTES.
 */
function encodeString(value: string, sink: CanonicalSink): void {
  sink.append("\"");
  let runStart = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code >= 0x20 && code !== 0x22 && code !== 0x5c && code < 0x80) {
      index += 1;
      if (index - runStart >= 4096) {
        sink.appendAsciiSlice(value, runStart, index);
        runStart = index;
      }
      continue;
    }
    if (index > runStart) sink.appendAsciiSlice(value, runStart, index);
    if (code < 0x20) {
      switch (code) {
        case 0x08: sink.append("\\b"); break;
        case 0x09: sink.append("\\t"); break;
        case 0x0a: sink.append("\\n"); break;
        case 0x0c: sink.append("\\f"); break;
        case 0x0d: sink.append("\\r"); break;
        default: sink.append(`\\u${hex4(code)}`); break;
      }
      index += 1;
    } else if (code === 0x22) {
      sink.append("\\\"");
      index += 1;
    } else if (code === 0x5c) {
      sink.append("\\\\");
      index += 1;
    } else if (code < 0x80) {
      sink.append(value[index]!);
      index += 1;
    } else if (code < 0x800) {
      sink.append(value[index]!, 2);
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        sink.append(value.slice(index, index + 2), 4);
        index += 2;
      } else {
        sink.append(`\\u${hex4(code)}`);
        index += 1;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      sink.append(`\\u${hex4(code)}`);
      index += 1;
    } else {
      sink.append(value[index]!, 3);
      index += 1;
    }
    runStart = index;
  }
  if (runStart < value.length) sink.appendAsciiSlice(value, runStart, value.length);
  sink.append("\"");
}

function encodeValue(value: unknown, sink: CanonicalSink, state: EncodeState, depth: number): void {
  if (depth > MAX_ENVELOPE_DEPTH) throw new EncodeFailure("encoding-depth-limit");
  state.nodes += 1;
  if (state.nodes > MAX_ENVELOPE_NODES) throw new EncodeFailure("encoding-node-limit");

  if (value === null) {
    sink.append("null");
    return;
  }
  switch (typeof value) {
    case "string":
      encodeString(value, sink);
      return;
    case "boolean":
      sink.append(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new EncodeFailure("encoding-nonfinite");
      sink.append(Object.is(value, -0) ? "0" : String(value));
      return;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new EncodeFailure("encoding-unsupported");
    case "object":
      break;
  }

  const object = value as object;
  if (state.ancestors.has(object)) throw new EncodeFailure("encoding-cycle");
  state.ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      sink.append("[");
      for (let index = 0; index < object.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        if (descriptor === undefined || !descriptor.enumerable) {
          throw new EncodeFailure("encoding-undefined-array-item");
        }
        if (!("value" in descriptor)) throw new EncodeFailure("encoding-accessor");
        if (descriptor.value === undefined) throw new EncodeFailure("encoding-undefined-array-item");
        if (index > 0) sink.append(",");
        encodeValue(descriptor.value, sink, state, depth + 1);
      }
      sink.append("]");
      return;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EncodeFailure("encoding-unsupported");
    }

    const names = Object.getOwnPropertyNames(object);
    if (names.length > MAX_ENVELOPE_NODES) throw new EncodeFailure("encoding-node-limit");
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    sink.append("{");
    let emitted = false;
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new EncodeFailure("encoding-accessor");
      if (descriptor.value === undefined) continue;
      if (emitted) sink.append(",");
      emitted = true;
      encodeString(key, sink);
      sink.append(":");
      encodeValue(descriptor.value, sink, state, depth + 1);
    }
    sink.append("}");
  } finally {
    state.ancestors.delete(object);
  }
}

type EncodeResult =
  | { readonly ok: true; readonly bytes: number; readonly sha256: string }
  | { readonly ok: false; readonly reason: NativeInstanceResultEncodingReason };

function encodeCanonical(value: unknown): EncodeResult {
  const sink = new CanonicalSink();
  try {
    encodeValue(value, sink, { nodes: 0, ancestors: new Set() }, 0);
    return { ok: true, ...sink.finish() };
  } catch (error) {
    if (error instanceof EncodeFailure) return { ok: false, reason: error.reason };
    return { ok: false, reason: "encoding-unsupported" };
  }
}

function associationDigest(association: NativeInstanceResultAssociation | null): string | null {
  if (association === null) return null;
  const encoded = encodeCanonical(association);
  return encoded.ok ? encoded.sha256 : null;
}

type ExpectedValidation =
  | { readonly ok: true; readonly association: NativeInstanceResultAssociation }
  | { readonly ok: false; readonly reason: "expected-association-invalid" | "expected-association-oversized" };

type StringField =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reason: "invalid" | "oversized" };

function expectedString(
  record: Record<string, unknown>,
  key: string,
  maxChars: number,
  nullable: boolean,
): StringField {
  const read = readOwnData(record, key);
  if (read.kind !== "data") return { ok: false, reason: "invalid" };
  if (read.value === null) return nullable ? { ok: true, value: null } : { ok: false, reason: "invalid" };
  if (typeof read.value !== "string" || read.value.length === 0) {
    return { ok: false, reason: "invalid" };
  }
  if (read.value.length > maxChars) return { ok: false, reason: "oversized" };
  return { ok: true, value: read.value };
}

function validateExpected(value: unknown): ExpectedValidation {
  if (!isRecord(value)) return { ok: false, reason: "expected-association-invalid" };

  const instanceId = expectedString(value, "instanceId", MAX_ASSOCIATION_ID_CHARS, false);
  if (!instanceId.ok) {
    return {
      ok: false,
      reason: instanceId.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const parentToolCallId = expectedString(value, "parentToolCallId", MAX_ASSOCIATION_ID_CHARS, false);
  if (!parentToolCallId.ok) {
    return {
      ok: false,
      reason: parentToolCallId.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const childId = expectedString(value, "childId", MAX_ASSOCIATION_ID_CHARS, true);
  if (!childId.ok) {
    return {
      ok: false,
      reason: childId.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const childSessionId = expectedString(value, "childSessionId", MAX_ASSOCIATION_ID_CHARS, true);
  if (!childSessionId.ok) {
    return {
      ok: false,
      reason: childSessionId.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const agentName = expectedString(value, "agentName", MAX_ASSOCIATION_AGENT_CHARS, false);
  if (!agentName.ok) {
    return {
      ok: false,
      reason: agentName.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const parentSessionId = expectedString(value, "parentSessionId", MAX_ASSOCIATION_ID_CHARS, false);
  if (!parentSessionId.ok) {
    return {
      ok: false,
      reason: parentSessionId.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const workspaceRoot = expectedString(value, "workspaceRoot", MAX_ASSOCIATION_ROOT_CHARS, false);
  if (!workspaceRoot.ok) {
    return {
      ok: false,
      reason: workspaceRoot.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const definitionVersion = expectedString(value, "definitionVersion", MAX_ASSOCIATION_ID_CHARS, false);
  if (!definitionVersion.ok) {
    return {
      ok: false,
      reason: definitionVersion.reason === "oversized"
        ? "expected-association-oversized"
        : "expected-association-invalid",
    };
  }
  const index = readOwnData(value, "index");
  if (index.kind !== "data" || index.value !== 0) {
    return { ok: false, reason: "expected-association-invalid" };
  }
  const rootEpoch = readOwnData(value, "rootEpoch");
  if (rootEpoch.kind !== "data"
    || typeof rootEpoch.value !== "number"
    || !Number.isSafeInteger(rootEpoch.value)
    || rootEpoch.value < 0) {
    return { ok: false, reason: "expected-association-invalid" };
  }

  const association: NativeInstanceResultAssociation = Object.freeze({
    instanceId: instanceId.value!,
    parentToolCallId: parentToolCallId.value!,
    index: 0,
    childId: childId.value,
    childSessionId: childSessionId.value,
    agentName: agentName.value!,
    parentSessionId: parentSessionId.value!,
    workspaceRoot: workspaceRoot.value!,
    rootEpoch: rootEpoch.value,
    definitionVersion: definitionVersion.value!,
  });
  return { ok: true, association };
}

function sameAssociation(
  left: NativeInstanceResultAssociation | null,
  right: NativeInstanceResultAssociation | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.instanceId === right.instanceId
    && left.parentToolCallId === right.parentToolCallId
    && left.index === right.index
    && left.childId === right.childId
    && left.childSessionId === right.childSessionId
    && left.agentName === right.agentName
    && left.parentSessionId === right.parentSessionId
    && left.workspaceRoot === right.workspaceRoot
    && left.rootEpoch === right.rootEpoch
    && left.definitionVersion === right.definitionVersion;
}

const INCOMPLETE_ENVELOPE: NativeInstanceResultEnvelope = Object.freeze({
  encoding: "canonical-json",
  complete: false,
  bytes: null,
  sha256: null,
});

function emptyNative(isError: boolean | null): NativeInstanceResultNative {
  return Object.freeze({
    isError,
    exitCode: null,
    aborted: null,
    truncated: null,
    errorPresent: false,
    error: null,
    abortReason: null,
    outputPath: null,
  });
}

function observationFields(): Omit<NativeInstanceResultObservation, "state" | "reason" | "association"
  | "link" | "outcome" | "confirmedChildAbort" | "envelope" | "output" | "native" | "conflict"> {
  return {
    schema: NATIVE_INSTANCE_RESULT_SCHEMA,
    version: NATIVE_INSTANCE_RESULT_VERSION,
    authority: "non-authoritative",
    scope: "tool-result-middleware",
    parentCancellation: "unknown",
    semanticAcceptance: "not-evaluated",
  };
}

function freezeObservation(fields: {
  readonly state: NativeInstanceResultState;
  readonly reason: NativeInstanceResultReason;
  readonly association: NativeInstanceResultAssociation | null;
  readonly link: NativeInstanceResultLink;
  readonly outcome: NativeInstanceResultOutcome;
  readonly confirmedChildAbort: boolean;
  readonly envelope: NativeInstanceResultEnvelope;
  readonly output: NativeInstanceResultOutput | null;
  readonly native: NativeInstanceResultNative | null;
  readonly conflict: NativeInstanceResultConflict | null;
}): NativeInstanceResultObservation {
  return Object.freeze({ ...observationFields(), ...fields });
}

function unavailableObservation(
  reason: NativeInstanceResultReason,
  association: NativeInstanceResultAssociation | null,
  native: NativeInstanceResultNative | null,
  envelope: NativeInstanceResultEnvelope,
  output: NativeInstanceResultOutput | null,
): NativeInstanceResultObservation {
  return freezeObservation({
    state: "unavailable",
    reason,
    association,
    link: "unavailable",
    outcome: "unknown",
    confirmedChildAbort: false,
    envelope,
    output,
    native,
    conflict: null,
  });
}

type ContentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "event-accessor"
        | "event-content-invalid"
        | "event-content-unsupported"
        | "encoding-node-limit";
    };

/**
 * Fixed host task content is an array of text blocks. Empty display-only
 * content is allowed; any other block type is explicitly unsupported rather
 * than guessed. Extra JSON fields stay inside the full envelope digest.
 */
function validateTaskContent(content: unknown): ContentValidation {
  if (!Array.isArray(content)) return { ok: false, reason: "event-content-invalid" };
  if (Object.getPrototypeOf(content) !== Array.prototype) {
    return { ok: false, reason: "event-content-invalid" };
  }
  // Every valid block needs at least three encoded nodes, so this length can
  // never fit the node budget. Refuse before walking an arbitrarily long array.
  if (content.length > MAX_ENVELOPE_NODES) return { ok: false, reason: "encoding-node-limit" };
  for (let index = 0; index < content.length; index += 1) {
    const element = readOwnArrayElement(content, index);
    if (element.kind === "accessor") return { ok: false, reason: "event-accessor" };
    if (element.kind !== "data" || !isRecord(element.value)) {
      return { ok: false, reason: "event-content-invalid" };
    }
    const block = element.value;
    const prototype = Object.getPrototypeOf(block);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: "event-content-invalid" };
    }
    const type = readOwnData(block, "type");
    if (type.kind === "accessor") return { ok: false, reason: "event-accessor" };
    if (type.kind !== "data" || typeof type.value !== "string") {
      return { ok: false, reason: "event-content-invalid" };
    }
    if (type.value !== "text") return { ok: false, reason: "event-content-unsupported" };
    const text = readOwnData(block, "text");
    if (text.kind === "accessor") return { ok: false, reason: "event-accessor" };
    if (text.kind !== "data" || typeof text.value !== "string") {
      return { ok: false, reason: "event-content-invalid" };
    }
  }
  return { ok: true };
}

interface ParsedResultFacts {
  readonly exitCode: number | null;
  readonly exitCodeValid: boolean;
  readonly aborted: boolean | null;
  readonly abortedValid: boolean;
  readonly truncated: boolean | null;
  readonly truncatedValid: boolean;
  readonly output: string | null;
  readonly outputValid: boolean;
  readonly errorPresent: boolean;
  readonly errorInvalid: boolean;
  readonly errorText: string | null;
  readonly abortReasonText: string | null;
  readonly outputPath: string | null;
}

type ParsedResult =
  | { readonly ok: true; readonly facts: ParsedResultFacts }
  | { readonly ok: false; readonly reason: "event-accessor" | "result-shape" | "result-index" | "result-id" | "result-agent" };

function parseTrustedResult(
  result: Record<string, unknown>,
  association: NativeInstanceResultAssociation,
  expectedChildId: string,
): ParsedResult {
  const index = readOwnData(result, "index");
  if (index.kind === "accessor") return { ok: false, reason: "event-accessor" };
  if (index.kind !== "data" || index.value !== 0) return { ok: false, reason: "result-index" };

  const id = readOwnData(result, "id");
  if (id.kind === "accessor") return { ok: false, reason: "event-accessor" };
  if (id.kind !== "data" || typeof id.value !== "string" || id.value !== expectedChildId) {
    return { ok: false, reason: "result-id" };
  }

  const agent = readOwnData(result, "agent");
  if (agent.kind === "accessor") return { ok: false, reason: "event-accessor" };
  if (agent.kind !== "data" || typeof agent.value !== "string" || agent.value !== association.agentName) {
    return { ok: false, reason: "result-agent" };
  }

  const exit = readOwnData(result, "exitCode");
  if (exit.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const exitCodeValid = exit.kind === "data"
    && typeof exit.value === "number"
    && Number.isInteger(exit.value);
  const exitCode = exitCodeValid ? (exit.kind === "data" ? exit.value as number : null) : null;

  const aborted = readOwnData(result, "aborted");
  if (aborted.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const abortedValid = aborted.kind === "data" && typeof aborted.value === "boolean";
  const abortedValue = abortedValid && aborted.kind === "data" ? aborted.value as boolean : null;

  const truncated = readOwnData(result, "truncated");
  if (truncated.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const truncatedValid = truncated.kind === "data" && typeof truncated.value === "boolean";
  const truncatedValue = truncatedValid && truncated.kind === "data" ? truncated.value as boolean : null;

  const output = readOwnData(result, "output");
  if (output.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const outputValid = output.kind === "data" && typeof output.value === "string";
  const outputValue = outputValid && output.kind === "data" ? output.value as string : null;

  const error = readOwnData(result, "error");
  if (error.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const errorPresent = error.kind === "data" && error.value !== undefined && error.value !== null;
  const errorInvalid = error.kind === "data"
    && error.value !== undefined
    && (error.value === null || typeof error.value !== "string");
  const errorText = error.kind === "data" && typeof error.value === "string" ? error.value : null;

  const abortReason = readOwnData(result, "abortReason");
  if (abortReason.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const abortReasonText = abortReason.kind === "data" && typeof abortReason.value === "string"
    ? abortReason.value
    : null;

  const outputPath = readOwnData(result, "outputPath");
  if (outputPath.kind === "accessor") return { ok: false, reason: "event-accessor" };
  const outputPathValue = outputPath.kind === "data" && typeof outputPath.value === "string"
    ? outputPath.value
    : null;

  return {
    ok: true,
    facts: {
      exitCode,
      exitCodeValid,
      aborted: abortedValue,
      abortedValid,
      truncated: truncatedValue,
      truncatedValid,
      output: outputValue,
      outputValid,
      errorPresent,
      errorInvalid,
      errorText,
      abortReasonText,
      outputPath: outputPathValue !== null && outputPathValue.length > 0 ? outputPathValue : null,
    },
  };
}

function outputObservation(value: string): NativeInstanceResultOutput {
  const bytes = utf8Bytes(value);
  return Object.freeze({
    bytes,
    sha256: sha256Text(value),
    excerpt: utf8Prefix(value, MAX_OUTPUT_EXCERPT_BYTES),
    excerptTruncated: bytes > MAX_OUTPUT_EXCERPT_BYTES,
  });
}

/**
 * Primitive native facts are cheap; bounded text/path copies are requested only
 * after the canonical envelope has been fully encoded within its fixed bound.
 */
function nativeFacts(
  isError: boolean | null,
  facts: ParsedResultFacts | null,
  includeBoundedText: boolean,
): NativeInstanceResultNative {
  if (facts === null) return emptyNative(isError);
  return Object.freeze({
    isError,
    exitCode: facts.exitCodeValid ? facts.exitCode : null,
    aborted: facts.abortedValid ? facts.aborted : null,
    truncated: facts.truncatedValid ? facts.truncated : null,
    errorPresent: facts.errorPresent,
    error: includeBoundedText && facts.errorText !== null
      ? boundedText(facts.errorText, MAX_BOUNDED_TEXT_BYTES)
      : null,
    abortReason: includeBoundedText && facts.abortReasonText !== null
      ? boundedText(facts.abortReasonText, MAX_BOUNDED_TEXT_BYTES)
      : null,
    outputPath: includeBoundedText
      && facts.outputPath !== null
      && utf8Bytes(facts.outputPath) <= MAX_OUTPUT_PATH_BYTES
      ? facts.outputPath
      : null,
  });
}

function conflictObservation(
  previous: NativeInstanceResultObservation,
  next: NativeInstanceResultObservation,
): NativeInstanceResultObservation {
  const associationSame = sameAssociation(previous.association, next.association);
  const envelopeSame = previous.envelope.sha256 !== null
    && next.envelope.sha256 === previous.envelope.sha256;
  let reason: NativeInstanceResultConflictReason;
  if (next.state === "unavailable") {
    reason = "unavailable-observation";
  } else if (associationSame && !envelopeSame) {
    reason = "envelope-digest-mismatch";
  } else if (!associationSame && envelopeSame) {
    reason = "association-mismatch";
  } else {
    reason = "association-and-envelope-mismatch";
  }
  const newConfirmedAbort = next.state === "observed"
    && associationSame
    && next.link === "instance"
    && next.outcome === "aborted-envelope";
  const conflict: NativeInstanceResultConflict = Object.freeze({
    reason,
    firstEnvelopeSha256: previous.envelope.sha256,
    lastEnvelopeSha256: next.envelope.sha256,
    firstAssociationSha256: associationDigest(previous.association),
    lastAssociationSha256: associationDigest(next.association),
    lastObservationReason: next.reason,
  });
  return freezeObservation({
    state: "conflicted",
    reason: "observation-conflict",
    association: previous.association,
    link: previous.link,
    outcome: previous.outcome,
    confirmedChildAbort: previous.confirmedChildAbort || newConfirmedAbort,
    envelope: previous.envelope,
    output: previous.output,
    native: previous.native,
    conflict,
  });
}

function combine(
  previous: NativeInstanceResultObservation | null,
  next: NativeInstanceResultObservation,
): NativeInstanceResultObservation {
  if (previous === null) return next;
  if (previous.state !== "observed") return previous;
  if (next.state === "observed"
    && sameAssociation(previous.association, next.association)
    && previous.envelope.sha256 !== null
    && next.envelope.sha256 === previous.envelope.sha256) {
    return previous;
  }
  return conflictObservation(previous, next);
}

/**
 * Snapshot one native task tool_result.
 *
 * Runs synchronously and either returns frozen owned primitives or an explicit
 * unavailable/conflicted observation. It never reads outputPath, never derives
 * child identity from formatted content, and never accepts semantic output.
 */
export function observeNativeInstanceResult(
  expected: NativeInstanceResultAssociation,
  event: unknown,
  previous: NativeInstanceResultObservation | null = null,
): NativeInstanceResultObservation {
  if (previous !== null && previous.state !== "observed") return previous;

  let expectedResult: ExpectedValidation;
  try {
    expectedResult = validateExpected(expected);
  } catch {
    return combine(previous, unavailableObservation(
      "expected-association-unreadable",
      null,
      null,
      INCOMPLETE_ENVELOPE,
      null,
    ));
  }
  if (!expectedResult.ok) {
    return combine(previous, unavailableObservation(
      expectedResult.reason,
      null,
      null,
      INCOMPLETE_ENVELOPE,
      null,
    ));
  }
  const association = expectedResult.association;

  try {
    return observeEvent(association, event, previous);
  } catch {
    return combine(previous, unavailableObservation(
      "event-unreadable",
      association,
      null,
      INCOMPLETE_ENVELOPE,
      null,
    ));
  }
}

function observeEvent(
  association: NativeInstanceResultAssociation,
  event: unknown,
  previous: NativeInstanceResultObservation | null,
): NativeInstanceResultObservation {
  if (!isRecord(event)) {
    return combine(previous, unavailableObservation(
      "event-not-object", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }

  const toolName = readOwnData(event, "toolName");
  if (toolName.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (toolName.kind !== "data" || toolName.value !== "task") {
    return combine(previous, unavailableObservation(
      "event-not-task", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }

  const toolCallId = readOwnData(event, "toolCallId");
  if (toolCallId.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (toolCallId.kind !== "data" || toolCallId.value !== association.parentToolCallId) {
    return combine(previous, unavailableObservation(
      "event-call-mismatch", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }

  const isErrorRead = readOwnData(event, "isError");
  if (isErrorRead.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, null, INCOMPLETE_ENVELOPE, null,
    ));
  }
  const outerIsError = isErrorRead.kind === "data" && typeof isErrorRead.value === "boolean"
    ? isErrorRead.value
    : null;
  const nativeShell = emptyNative(outerIsError);

  const contentRead = readOwnData(event, "content");
  if (contentRead.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (contentRead.kind !== "data" || contentRead.value === undefined) {
    return combine(previous, unavailableObservation(
      "event-content-missing", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  const contentValidation = validateTaskContent(contentRead.value);
  if (!contentValidation.ok) {
    return combine(previous, unavailableObservation(
      contentValidation.reason, association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }

  const detailsRead = readOwnData(event, "details");
  if (detailsRead.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (detailsRead.kind !== "data" || detailsRead.value === undefined) {
    return combine(previous, unavailableObservation(
      "details-missing", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (!isRecord(detailsRead.value)) {
    return combine(previous, unavailableObservation(
      "details-invalid", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  const details = detailsRead.value;

  const resultsRead = readOwnData(details, "results");
  if (resultsRead.kind === "accessor") {
    return combine(previous, unavailableObservation(
      "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (resultsRead.kind !== "data" || resultsRead.value === undefined) {
    return combine(previous, unavailableObservation(
      "results-missing", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  if (!Array.isArray(resultsRead.value)) {
    return combine(previous, unavailableObservation(
      "results-invalid", association, nativeShell, INCOMPLETE_ENVELOPE, null,
    ));
  }
  const results = resultsRead.value;

  let callOnly = association.childId === null || association.childSessionId === null;
  let facts: ParsedResultFacts | null = null;

  if (association.childId === null) {
    if (results.length > 1) {
      return combine(previous, unavailableObservation(
        "results-count", association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    if (results.length === 1) {
      const onlyRead = readOwnArrayElement(results, 0);
      if (onlyRead.kind === "accessor") {
        return combine(previous, unavailableObservation(
          "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
        ));
      }
      if (onlyRead.kind !== "data" || !isRecord(onlyRead.value)) {
        return combine(previous, unavailableObservation(
          "result-shape", association, nativeShell, INCOMPLETE_ENVELOPE, null,
        ));
      }
      const only = onlyRead.value;
      const index = readOwnData(only, "index");
      if (index.kind === "accessor") {
        return combine(previous, unavailableObservation(
          "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
        ));
      }
      if (index.kind !== "data" || index.value !== 0) {
        return combine(previous, unavailableObservation(
          "result-index", association, nativeShell, INCOMPLETE_ENVELOPE, null,
        ));
      }
    }
    if (outerIsError !== true) {
      return combine(previous, unavailableObservation(
        "child-unbound", association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    callOnly = true;
  } else {
    if (results.length !== 1) {
      return combine(previous, unavailableObservation(
        "results-count", association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    const onlyRead = readOwnArrayElement(results, 0);
    if (onlyRead.kind === "accessor") {
      return combine(previous, unavailableObservation(
        "event-accessor", association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    if (onlyRead.kind !== "data" || !isRecord(onlyRead.value)) {
      return combine(previous, unavailableObservation(
        "result-shape", association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    const only = onlyRead.value;
    const parsed = parseTrustedResult(only, association, association.childId);
    if (!parsed.ok) {
      return combine(previous, unavailableObservation(
        parsed.reason, association, nativeShell, INCOMPLETE_ENVELOPE, null,
      ));
    }
    facts = parsed.facts;
  }

  const aborted = facts !== null && facts.abortedValid && facts.aborted === true;
  const errorFailure = facts !== null && facts.errorText !== null && facts.errorText.length > 0;
  const failureEvidence = outerIsError === true
    || (facts !== null && facts.exitCodeValid && facts.exitCode !== null && facts.exitCode !== 0)
    || errorFailure;

  let outcome: NativeInstanceResultOutcome;
  if (aborted) {
    outcome = "aborted-envelope";
  } else if (facts !== null
    && !callOnly
    && outerIsError === false
    && facts.exitCodeValid
    && facts.exitCode === 0
    && facts.abortedValid
    && facts.aborted === false
    && facts.truncatedValid
    && facts.outputValid
    && !facts.errorPresent
    && !facts.errorInvalid) {
    outcome = "completed-envelope";
  } else if (failureEvidence) {
    outcome = "failed-envelope";
  } else {
    outcome = "unknown";
  }

  const link: NativeInstanceResultLink = callOnly ? "call-only" : "instance";
  const confirmedChildAbort = outcome === "aborted-envelope" && link === "instance";

  const envelopeInput: Record<string, unknown> = {
    content: contentRead.value,
    details: detailsRead.value,
  };
  if (isErrorRead.kind === "data" && isErrorRead.value !== undefined) {
    envelopeInput.isError = isErrorRead.value;
  }
  const encoded = encodeCanonical(envelopeInput);
  if (!encoded.ok) {
    return combine(previous, unavailableObservation(
      encoded.reason, association, nativeFacts(outerIsError, facts, false), INCOMPLETE_ENVELOPE, null,
    ));
  }

  // Output and bounded text work starts only after the full envelope has been
  // proven representable within the fixed encoded bound.
  const output = facts !== null && facts.outputValid && facts.output !== null
    ? outputObservation(facts.output)
    : null;
  const native = nativeFacts(outerIsError, facts, true);

  const envelope: NativeInstanceResultEnvelope = Object.freeze({
    encoding: "canonical-json",
    complete: true,
    bytes: encoded.bytes,
    sha256: encoded.sha256,
  });

  const observation = freezeObservation({
    state: "observed",
    reason: callOnly ? "observed-call-only" : "observed-envelope",
    association,
    link,
    outcome,
    confirmedChildAbort,
    envelope,
    output,
    native,
    conflict: null,
  });
  return combine(previous, observation);
}
