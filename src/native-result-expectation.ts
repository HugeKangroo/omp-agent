import {
  fingerprintNativeJson,
  MAX_ENVELOPE_DEPTH,
  MAX_ENVELOPE_NODES,
  type NativeInstanceResultEncodingReason,
} from "./native-instance-result.ts";

/**
 * Pure normalization for exact tool-result expectations.
 *
 * The projection is always `{input, content, details?, isError}`. Only own data
 * descriptors are read; getters, toJSON and thenables are never invoked. The
 * bounded canonical encoder supplies byte/depth/node/cycle/accessor limits.
 */

export type NativeResultProjectionFailure =
  | "expected-not-object"
  | "expected-input-missing"
  | "expected-result-missing"
  | "expected-result-not-object"
  | "expected-content-missing"
  | "expected-content-not-array"
  | "expected-content-invalid"
  | "expected-content-unsupported"
  | "expected-iserror-invalid"
  | "event-not-object"
  | "event-input-missing"
  | "event-content-missing"
  | "event-content-not-array"
  | "event-iserror-invalid"
  | "accessor"
  | "unreadable"
  | NativeInstanceResultEncodingReason;

export interface NativeResultFingerprint {
  readonly bytes: number;
  readonly sha256: string;
}

/** Bounded legacy result facts copied without touching raw event fields later. */
export interface NativeResultEnvelopeFacts {
  readonly isErrorObserved: boolean;
  readonly textExcerpt: string;
  readonly textTruncated: boolean;
  readonly textBlocks: number;
  readonly imageBlocks: number;
  readonly detailsPresent: boolean;
  readonly exitCodeFromToolDetails: number | null;
}

export type ExpectedCallResultProjection =
  | {
      readonly ok: true;
      readonly inputFingerprint: NativeResultFingerprint;
      readonly fingerprint: NativeResultFingerprint;
    }
  | { readonly ok: false; readonly reason: NativeResultProjectionFailure };

export type ObservedCallResultProjection =
  | {
      readonly ok: true;
      readonly fingerprint: NativeResultFingerprint;
      readonly facts: NativeResultEnvelopeFacts;
    }
  | { readonly ok: false; readonly reason: NativeResultProjectionFailure };

type OwnDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "accessor" }
  | {
      readonly kind: "data";
      readonly value: unknown;
      readonly enumerable: boolean;
    };

function readOwnData(target: object, key: string): OwnDataRead {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { kind: "missing" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "data", value: descriptor.value, enumerable: descriptor.enumerable === true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readArrayLength(content: readonly unknown[]): number | null {
  const length = readOwnData(content, "length");
  if (length.kind !== "data") return null;
  if (typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0) {
    return null;
  }
  return length.value;
}

class SnapshotFailure extends Error {
  constructor(readonly reason: NativeInstanceResultEncodingReason) {
    super(reason);
  }
}

interface SnapshotState {
  nodes: number;
  readonly ancestors: Set<object>;
}

type SnapshotResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: NativeResultProjectionFailure };

/**
 * One bounded own-data pass. Proxies may still run reflection traps, but the
 * returned plain graph is the single source for both fingerprints and legacy
 * facts, so a trap cannot return different task values between later reads.
 * This mirrors the C1 encoder's own-data/JSON omission rules; the encoder
 * itself is unchanged.
 */
function snapshotValue(value: unknown, state: SnapshotState, depth: number): unknown {
  if (depth > MAX_ENVELOPE_DEPTH) throw new SnapshotFailure("encoding-depth-limit");
  state.nodes += 1;
  if (state.nodes > MAX_ENVELOPE_NODES) throw new SnapshotFailure("encoding-node-limit");

  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new SnapshotFailure("encoding-nonfinite");
      return value;
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new SnapshotFailure("encoding-unsupported");
    case "object":
      break;
  }

  const object = value as object;
  if (state.ancestors.has(object)) throw new SnapshotFailure("encoding-cycle");
  state.ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const lengthRead = readOwnData(object, "length");
      if (lengthRead.kind !== "data"
        || typeof lengthRead.value !== "number"
        || !Number.isSafeInteger(lengthRead.value)
        || lengthRead.value < 0) {
        throw new SnapshotFailure("encoding-unsupported");
      }
      const length = lengthRead.value;
      if (length > MAX_ENVELOPE_NODES) throw new SnapshotFailure("encoding-node-limit");
      const copy: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const element = readOwnData(object, String(index));
        if (element.kind === "accessor") throw new SnapshotFailure("encoding-accessor");
        if (element.kind !== "data" || !element.enumerable || element.value === undefined) {
          throw new SnapshotFailure("encoding-undefined-array-item");
        }
        copy.push(snapshotValue(element.value, state, depth + 1));
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SnapshotFailure("encoding-unsupported");
    }
    const names = Object.getOwnPropertyNames(object);
    if (names.length > MAX_ENVELOPE_NODES) throw new SnapshotFailure("encoding-node-limit");
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    // A null prototype preserves an own "__proto__" JSON key instead of
    // invoking Object.prototype's setter. The encoder accepts null prototypes.
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined || !descriptor.enumerable) continue;
      if (!("value" in descriptor)) throw new SnapshotFailure("encoding-accessor");
      if (descriptor.value === undefined) continue;
      copy[key] = snapshotValue(descriptor.value, state, depth + 1);
    }
    return copy;
  } finally {
    state.ancestors.delete(object);
  }
}

function snapshotProjection(value: unknown): SnapshotResult {
  try {
    return { ok: true, value: snapshotValue(value, { nodes: 0, ancestors: new Set() }, 0) };
  } catch (error) {
    if (error instanceof SnapshotFailure) return { ok: false, reason: error.reason };
    return { ok: false, reason: "unreadable" };
  }
}

/** Mirrors the existing NativeToolResult text-block surface, including extra JSON fields. */
function validateExpectedContent(content: unknown): NativeResultProjectionFailure | null {
  if (!Array.isArray(content)) return "expected-content-not-array";
  const length = readArrayLength(content);
  if (length === null) return "expected-content-invalid";
  // Every valid block needs at least three encoded nodes.
  if (length > MAX_ENVELOPE_NODES) return "encoding-node-limit";
  for (let index = 0; index < length; index += 1) {
    const element = readOwnData(content, String(index));
    if (element.kind === "accessor") return "accessor";
    if (element.kind !== "data" || !element.enumerable || !isRecord(element.value)) {
      return "expected-content-invalid";
    }
    const block = element.value;
    const prototype = Object.getPrototypeOf(block);
    if (prototype !== Object.prototype && prototype !== null) return "expected-content-invalid";
    const type = readOwnData(block, "type");
    if (type.kind === "accessor") return "accessor";
    if (type.kind !== "data" || !type.enumerable || typeof type.value !== "string") {
      return "expected-content-invalid";
    }
    if (type.value !== "text") return "expected-content-unsupported";
    const text = readOwnData(block, "text");
    if (text.kind === "accessor") return "accessor";
    if (text.kind !== "data" || !text.enumerable || typeof text.value !== "string") {
      return "expected-content-invalid";
    }
  }
  return null;
}

function expectedProjection(expected: unknown): ExpectedCallResultProjection {
  try {
    if (!isRecord(expected)) return { ok: false, reason: "expected-not-object" };

    const input = readOwnData(expected, "input");
    if (input.kind === "accessor") return { ok: false, reason: "accessor" };
    if (input.kind !== "data" || input.value === undefined) {
      return { ok: false, reason: "expected-input-missing" };
    }

    const result = readOwnData(expected, "result");
    if (result.kind === "accessor") return { ok: false, reason: "accessor" };
    if (result.kind !== "data" || result.value === undefined) {
      return { ok: false, reason: "expected-result-missing" };
    }
    if (!isRecord(result.value)) return { ok: false, reason: "expected-result-not-object" };

    const content = readOwnData(result.value, "content");
    if (content.kind === "accessor") return { ok: false, reason: "accessor" };
    if (content.kind !== "data" || content.value === undefined) {
      return { ok: false, reason: "expected-content-missing" };
    }

    const details = readOwnData(result.value, "details");
    if (details.kind === "accessor") return { ok: false, reason: "accessor" };

    const isError = readOwnData(result.value, "isError");
    if (isError.kind === "accessor") return { ok: false, reason: "accessor" };
    let expectedIsError = false;
    if (isError.kind === "data") {
      // Only a missing own descriptor means omitted. An explicitly present
      // undefined is not a boolean and must refuse.
      if (isError.value === undefined) return { ok: false, reason: "expected-iserror-invalid" };
      if (typeof isError.value !== "boolean") return { ok: false, reason: "expected-iserror-invalid" };
      expectedIsError = isError.value;
    }

    const projection: Record<string, unknown> = {
      input: input.value,
      content: content.value,
      isError: expectedIsError,
    };
    if (details.kind === "data" && details.value !== undefined) projection.details = details.value;

    const snapshot = snapshotProjection(projection);
    if (!snapshot.ok) return snapshot;
    if (!isRecord(snapshot.value)) return { ok: false, reason: "unreadable" };
    const normalized = snapshot.value;
    const contentFailure = validateExpectedContent(normalized.content);
    if (contentFailure !== null) return { ok: false, reason: contentFailure };

    const inputFingerprint = fingerprintNativeJson(normalized.input);
    if (!inputFingerprint.ok) return inputFingerprint;
    const fingerprint = fingerprintNativeJson(normalized);
    if (!fingerprint.ok) return fingerprint;
    return {
      ok: true,
      inputFingerprint: {
        bytes: inputFingerprint.bytes,
        sha256: inputFingerprint.sha256,
      },
      fingerprint: {
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
      },
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

function buildFacts(
  content: readonly unknown[],
  isError: boolean,
  details: OwnDataRead,
  maxExcerptChars: number,
): NativeResultEnvelopeFacts {
  const limit = Number.isSafeInteger(maxExcerptChars) && maxExcerptChars >= 0
    ? maxExcerptChars
    : 0;
  let excerptText = "";
  let excerptTruncated = false;
  let textBlocks = 0;
  let imageBlocks = 0;
  let detailsPresent = false;
  let exitCode: number | null = null;

  if (details.kind === "data" && details.value !== undefined) {
    if (details.value !== null) detailsPresent = true;
    if (isRecord(details.value)) {
      const detailExit = readOwnData(details.value, "exitCode");
      if (detailExit.kind === "data"
        && typeof detailExit.value === "number"
        && Number.isFinite(detailExit.value)) {
        exitCode = detailExit.value;
      }
    }
  }

  const length = readArrayLength(content);
  if (length !== null) {
    for (let index = 0; index < length; index += 1) {
      const element = readOwnData(content, String(index));
      if (element.kind !== "data" || !isRecord(element.value)) continue;
      const block = element.value;
      const type = readOwnData(block, "type");
      if (type.kind !== "data") continue;
      if (type.value === "image") {
        imageBlocks += 1;
        continue;
      }
      if (type.value !== "text") continue;
      const text = readOwnData(block, "text");
      if (text.kind !== "data" || typeof text.value !== "string") continue;
      textBlocks += 1;
      if (excerptText.length >= limit) {
        excerptTruncated = true;
        continue;
      }
      const separator = excerptText.length > 0 ? "\n" : "";
      const room = limit - excerptText.length - separator.length;
      if (room <= 0) {
        excerptTruncated = true;
        continue;
      }
      const piece = text.value.slice(0, room);
      excerptText += separator + piece;
      if (piece.length < text.value.length) excerptTruncated = true;
    }
  }

  return Object.freeze({
    isErrorObserved: isError,
    textExcerpt: excerptText,
    textTruncated: excerptTruncated,
    textBlocks,
    imageBlocks,
    detailsPresent,
    exitCodeFromToolDetails: exitCode,
  });
}

function observedProjection(event: unknown, maxExcerptChars: number): ObservedCallResultProjection {
  try {
    if (!isRecord(event)) return { ok: false, reason: "event-not-object" };

    const input = readOwnData(event, "input");
    if (input.kind === "accessor") return { ok: false, reason: "accessor" };
    if (input.kind !== "data" || input.value === undefined) {
      return { ok: false, reason: "event-input-missing" };
    }

    const content = readOwnData(event, "content");
    if (content.kind === "accessor") return { ok: false, reason: "accessor" };
    if (content.kind !== "data" || content.value === undefined) {
      return { ok: false, reason: "event-content-missing" };
    }
    if (!Array.isArray(content.value)) return { ok: false, reason: "event-content-not-array" };

    const details = readOwnData(event, "details");
    if (details.kind === "accessor") return { ok: false, reason: "accessor" };

    const isError = readOwnData(event, "isError");
    if (isError.kind === "accessor") return { ok: false, reason: "accessor" };
    if (isError.kind !== "data" || typeof isError.value !== "boolean") {
      return { ok: false, reason: "event-iserror-invalid" };
    }

    const projection: Record<string, unknown> = {
      input: input.value,
      content: content.value,
      isError: isError.value,
    };
    if (details.kind === "data" && details.value !== undefined) projection.details = details.value;

    const snapshot = snapshotProjection(projection);
    if (!snapshot.ok) return snapshot;
    if (!isRecord(snapshot.value)) return { ok: false, reason: "unreadable" };
    const normalized = snapshot.value;

    const fingerprint = fingerprintNativeJson(normalized);
    if (!fingerprint.ok) return fingerprint;
    const stableDetails = readOwnData(normalized, "details");
    return {
      ok: true,
      fingerprint: {
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
      },
      facts: buildFacts(
        normalized.content as readonly unknown[],
        normalized.isError as boolean,
        stableDetails,
        maxExcerptChars,
      ),
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export function fingerprintExpectedCallResult(expected: unknown): ExpectedCallResultProjection {
  return expectedProjection(expected);
}

export function fingerprintObservedCallResult(
  event: unknown,
  maxExcerptChars: number,
): ObservedCallResultProjection {
  return observedProjection(event, maxExcerptChars);
}
