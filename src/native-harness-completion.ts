import path from "node:path";
import { deepFreeze, sha256Hex, validateRelativePath } from "./native-work.ts";

/**
 * Bounded, host-only completion projection types and copying helpers.
 *
 * This module owns no execution authority and no backend association. Only
 * `native-harness-backend.ts` can issue a completion, from the state created
 * alongside one actual frozen backend object. Helpers here copy facts from
 * already-checked values and compare retained projections; they never read the
 * filesystem, start a process, call a model or claim current work.
 */

export const NATIVE_HARNESS_COMPLETION_SCHEMA = "omp-agent.native-harness-backend-completion.v1" as const;
export const NATIVE_HARNESS_COMPLETION_ORIGIN = "harness2-native" as const;
/**
 * Build/source label from vendor/harness2/SOURCE.json. This is not proof that a
 * runtime file-integrity check occurred for this execution.
 */
export const NATIVE_HARNESS_COMPLETION_SOURCE_ID =
  "5415f078b33c22f1360e0e56125a0dc0b0784dd27fe1778ca7d3412a1bb36e50" as const;
export const NATIVE_HARNESS_COMPLETION_SOURCE_INTEGRITY = "build-label-only" as const;

/** Frozen solver candidate set from the vendored Harness2 types contract. */
export const NATIVE_HARNESS_COMPLETION_SOLVER_IDS = Object.freeze([
  "baseline",
  "inv_probe",
  "dom_probe",
  "final",
  "route_1",
  "route_2",
  "route_3",
  "refine",
] as const);

export const NATIVE_HARNESS_COMPLETION_LIMITS = Object.freeze({
  maxWitnesses: 32,
  maxWitnessMetadataBytes: 16 * 1024,
  maxWitnessTotalBytes: 256 * 1024,
  maxCompletionMetadataBytes: 128 * 1024,
  maxResultTextBytes: 1024 * 1024,
  maxBaseInputs: 8,
  maxAncestryStages: 8,
  maxPathChars: 4096,
  maxRunIdChars: 256,
  maxModelChars: 256,
  maxTimestampChars: 64,
  maxReasonChars: 320,
});

export const NATIVE_HARNESS_COMPLETION_LIMITATIONS = Object.freeze([
  "Host-only association and completion observations from this backend's actual Harness2 Controller and Runner dispatch; this is not a model response, a delivered result or current native work.",
  "Referenced source, manifest, artifact and trace bytes have not yet been independently captured or rechecked by this completion.",
  "No cleanup/process-group termination, semantic acceptance, apply or durability guarantee is made.",
]);

export interface NativeHarnessCompletionPreparedInput {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface NativeHarnessCompletionBaseEntry {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly hash: string;
}

export interface NativeHarnessCompletionBase {
  readonly snapshotId: string;
  readonly root: string;
  readonly sourceRoot: string;
  readonly createdAt: string;
  readonly manifestSha256: string;
  readonly entries: readonly NativeHarnessCompletionBaseEntry[];
  readonly inputs: readonly NativeHarnessCheckedContent[];
}

/** Plain content SHA observed while the gate checked the base input bytes. */
export interface NativeHarnessCheckedContent {
  readonly path: string;
  readonly size: number;
  readonly contentSha256: string;
}

/** One base input fact produced by the gate's existing byte checks. */
export interface NativeHarnessCheckedBaseInput {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly contentSha256: string;
  readonly controllerHash: string;
}

export interface NativeHarnessCompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly usageEstimated: boolean;
}

export interface NativeHarnessCompletionResultFacts {
  readonly eventsPath: string;
  readonly status: "completed" | "failed" | "cancelled" | "timed_out";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly textBytes: number;
  readonly textSha256: string;
  readonly usage: NativeHarnessCompletionUsage;
}

export interface NativeHarnessCompletionParent {
  readonly candidate: string;
  readonly artifactHash: string;
}

export interface NativeHarnessCompletionWitnessFacts {
  readonly runId: string;
  readonly stage: string;
  readonly role: "solver" | "editor" | "selector" | "reflector";
  readonly cwd: string;
  readonly artifactDir: string;
  readonly model: string;
  readonly attempt: number;
  /** Paired refinement parent actually recorded at this dispatch, or null. */
  readonly parent: NativeHarnessCompletionParent | null;
  /** Base facts actually checked before this dispatch; null when unavailable. */
  readonly base: NativeHarnessCompletionBase | null;
}

/** One actual Runner invocation observation retained by the backend. */
export interface NativeHarnessCompletionWitness {
  readonly sequence: number;
  readonly facts: NativeHarnessCompletionWitnessFacts | null;
  readonly result: NativeHarnessCompletionResultFacts | null;
  readonly failure: string | null;
  readonly eligible: boolean;
}

export interface NativeHarnessCompletionSelection {
  readonly candidate: string;
  readonly attempt: number;
  readonly cwd: string;
  readonly artifactHash: string;
  readonly traceHash: string;
  readonly witnessSequence: number;
  readonly artifactDir: string;
  readonly eventsPath: string;
  readonly resultStatus: "completed";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly textBytes: number;
  readonly textSha256: string;
}

export interface NativeHarnessBackendCompletion {
  readonly schema: typeof NATIVE_HARNESS_COMPLETION_SCHEMA;
  readonly origin: typeof NATIVE_HARNESS_COMPLETION_ORIGIN;
  readonly completionId: string;
  readonly sourceId: typeof NATIVE_HARNESS_COMPLETION_SOURCE_ID;
  readonly sourceIntegrity: typeof NATIVE_HARNESS_COMPLETION_SOURCE_INTEGRITY;
  readonly taskAccepted: false;
  readonly semanticAcceptance: "not-evaluated";
  readonly runId: string;
  readonly taskSha256: string;
  readonly model: string;
  readonly profile: {
    readonly strategy: "auto";
    readonly mode: "product";
    readonly domain: "generic";
  };
  readonly prepared: {
    readonly sourceRoot: string;
    readonly preparedRoot: string;
    readonly workspaceRoot: string;
    readonly storeRoot: string;
    readonly manifestSha256: string;
    readonly inputs: readonly NativeHarnessCompletionPreparedInput[];
  };
  readonly base: {
    readonly snapshotId: string;
    readonly root: string;
    readonly sourceRoot: string;
    readonly createdAt: string;
    readonly manifestSha256: string;
    readonly entries: readonly NativeHarnessCompletionBaseEntry[];
  };
  readonly winner: NativeHarnessCompletionSelection;
  readonly ancestry: readonly NativeHarnessCompletionSelection[];
  readonly limitations: readonly string[];
}

export interface OwnDataValue {
  readonly present: boolean;
  readonly readable: boolean;
  readonly value: unknown;
}

/** Reads one own data property without invoking accessors or prototype getters. */
export function readOwnData(value: unknown, key: string): OwnDataValue {
  if (typeof value !== "object" || value === null) {
    return { present: false, readable: false, value: undefined };
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return { present: true, readable: false, value: undefined };
  }
  if (descriptor === undefined) {
    return { present: false, readable: false, value: undefined };
  }
  if (
    !("value" in descriptor)
    || descriptor.get !== undefined
    || descriptor.set !== undefined
  ) {
    return { present: true, readable: false, value: undefined };
  }
  return { present: true, readable: true, value: descriptor.value };
}

/** Reads a plain array's own indexed data values with a hard element bound. */
export function readOwnArrayValues(value: unknown, max: number): readonly unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined
      || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number"
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        return null;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

export function boundedCompletionToken(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > max) return null;
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export function boundedCompletionPath(value: unknown): string | null {
  const text = boundedCompletionToken(value, NATIVE_HARNESS_COMPLETION_LIMITS.maxPathChars);
  return text !== null && path.isAbsolute(text) ? text : null;
}

export function boundedCompletionTimestamp(value: unknown): string | null {
  return boundedCompletionToken(value, NATIVE_HARNESS_COMPLETION_LIMITS.maxTimestampChars);
}

export function boundedCompletionHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function boundedCompletionReason(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error && typeof value.message === "string") {
    text = value.message;
  } else {
    try {
      text = String(value);
    } catch {
      text = "unreadable failure";
    }
  }
  const normalized = text.replace(/[^\x20-\x7e]+/g, "?").replace(/\s+/g, " ").trim();
  const bounded = normalized.length === 0 ? "unreadable failure" : normalized;
  return bounded.length <= NATIVE_HARNESS_COMPLETION_LIMITS.maxReasonChars
    ? bounded
    : `${bounded.slice(0, NATIVE_HARNESS_COMPLETION_LIMITS.maxReasonChars - 3)}...`;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Digest of returned text, or null when the bounded text limit is exceeded. */
export function digestBoundedResultText(value: unknown): { readonly bytes: number; readonly sha256: string } | null {
  if (typeof value !== "string") return null;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > NATIVE_HARNESS_COMPLETION_LIMITS.maxResultTextBytes) return null;
  return { bytes, sha256: sha256Hex(Buffer.from(value, "utf8")) };
}

function copyRelativePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > NATIVE_HARNESS_COMPLETION_LIMITS.maxPathChars) {
    return null;
  }
  try {
    return validateRelativePath(value);
  } catch {
    return null;
  }
}

function boundedContentSize(value: unknown): number | null {
  // The existing prepared-workspace total input bound is 256 KiB.
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 256 * 1024
    ? value
    : null;
}

function boundedMode(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 0o777
    ? value
    : null;
}

export interface WitnessBaseInput {
  readonly snapshotId: unknown;
  readonly root: unknown;
  readonly sourceRoot: unknown;
  readonly createdAt: unknown;
  readonly checked: readonly NativeHarnessCheckedBaseInput[];
  readonly inputs: readonly unknown[];
  readonly manifestSha256: unknown;
}

/** Copies the base facts actually checked by the gate, never a later reread. */
export function copyWitnessBase(input: WitnessBaseInput): NativeHarnessCompletionBase | null {
  try {
    const max = NATIVE_HARNESS_COMPLETION_LIMITS.maxBaseInputs;
    if (!Array.isArray(input.checked) || input.checked.length < 1 || input.checked.length > max) return null;
    const inputs = readOwnArrayValues(input.inputs, max);
    if (inputs === null || inputs.length < 1 || inputs.length !== input.checked.length) return null;

    const snapshotId = boundedCompletionToken(input.snapshotId, NATIVE_HARNESS_COMPLETION_LIMITS.maxRunIdChars);
    const root = boundedCompletionPath(input.root);
    const sourceRoot = boundedCompletionPath(input.sourceRoot);
    const createdAt = boundedCompletionTimestamp(input.createdAt);
    const manifestSha256 = boundedCompletionHash(input.manifestSha256);
    if (snapshotId === null || root === null || sourceRoot === null || createdAt === null || manifestSha256 === null) {
      return null;
    }

    const declared = new Map<string, { readonly bytes: number; readonly sha256: string }>();
    for (const raw of inputs) {
      const relativePath = copyRelativePath(readOwnData(raw, "relativePath").value);
      const bytes = boundedContentSize(readOwnData(raw, "bytes").value);
      const sha256 = boundedCompletionHash(readOwnData(raw, "sha256").value);
      if (relativePath === null || bytes === null || sha256 === null || declared.has(relativePath)) return null;
      declared.set(relativePath, { bytes, sha256 });
    }

    const entries: NativeHarnessCompletionBaseEntry[] = [];
    const contents: NativeHarnessCheckedContent[] = [];
    const seen = new Set<string>();
    for (const raw of input.checked) {
      const checkedPath = copyRelativePath(readOwnData(raw, "path").value);
      const size = boundedContentSize(readOwnData(raw, "size").value);
      const mode = boundedMode(readOwnData(raw, "mode").value);
      const contentSha256 = boundedCompletionHash(readOwnData(raw, "contentSha256").value);
      const controllerHash = boundedCompletionHash(readOwnData(raw, "controllerHash").value);
      if (
        checkedPath === null
        || size === null
        || mode === null
        || contentSha256 === null
        || controllerHash === null
        || seen.has(checkedPath)
      ) {
        return null;
      }
      const host = declared.get(checkedPath);
      if (host === undefined || host.bytes !== size || host.sha256 !== contentSha256) return null;
      seen.add(checkedPath);
      entries.push(Object.freeze({ path: checkedPath, size, mode, hash: controllerHash }));
      contents.push(Object.freeze({ path: checkedPath, size, contentSha256 }));
    }
    if (entries.length !== declared.size) return null;
    entries.sort((left, right) => left.path.localeCompare(right.path));
    contents.sort((left, right) => left.path.localeCompare(right.path));
    return deepFreeze({
      snapshotId,
      root,
      sourceRoot,
      createdAt,
      manifestSha256,
      entries,
      inputs: contents,
    });
  } catch {
    return null;
  }
}

export interface WitnessFactsInput {
  readonly sequence: number;
  readonly runId: unknown;
  readonly stage: unknown;
  readonly role: unknown;
  readonly cwd: unknown;
  readonly artifactDir: unknown;
  readonly model: unknown;
  readonly attempt: unknown;
  readonly parent: NativeHarnessCompletionParent | null;
  readonly base: NativeHarnessCompletionBase | null;
}

export function copyWitnessFacts(input: WitnessFactsInput): NativeHarnessCompletionWitnessFacts | null {
  if (!isPositiveSafeInteger(input.sequence)) return null;
  const runId = boundedCompletionToken(input.runId, NATIVE_HARNESS_COMPLETION_LIMITS.maxRunIdChars);
  const stage = boundedCompletionToken(input.stage, 64);
  const role = input.role;
  const cwd = boundedCompletionPath(input.cwd);
  const artifactDir = boundedCompletionPath(input.artifactDir);
  const model = boundedCompletionToken(input.model, NATIVE_HARNESS_COMPLETION_LIMITS.maxModelChars);
  if (
    runId === null
    || stage === null
    || (role !== "solver" && role !== "editor" && role !== "selector" && role !== "reflector")
    || cwd === null
    || artifactDir === null
    || model === null
    || !isPositiveSafeInteger(input.attempt)
  ) {
    return null;
  }
  let parent: NativeHarnessCompletionParent | null = null;
  if (input.parent !== null) {
    const candidate = boundedCompletionToken(readOwnData(input.parent, "candidate").value, 64);
    const artifactHash = boundedCompletionHash(readOwnData(input.parent, "artifactHash").value);
    if (
      candidate === null
      || artifactHash === null
      || !(NATIVE_HARNESS_COMPLETION_SOLVER_IDS as readonly string[]).includes(candidate)
    ) {
      return null;
    }
    parent = Object.freeze({ candidate, artifactHash });
  }
  return deepFreeze({
    runId,
    stage,
    role,
    cwd,
    artifactDir,
    model,
    attempt: input.attempt,
    parent,
    base: input.base,
  });
}

export interface CopiedWitnessResult {
  readonly result: NativeHarnessCompletionResultFacts | null;
  readonly failure: string | null;
}

/** Copies only bounded result facts from an actual Runner return value. */
export function copyWitnessResult(value: unknown): CopiedWitnessResult {
  try {
    const eventsPath = boundedCompletionPath(readOwnData(value, "eventsPath").value);
    const status = readOwnData(value, "status").value;
    const startedAt = boundedCompletionTimestamp(readOwnData(value, "startedAt").value);
    const endedAt = boundedCompletionTimestamp(readOwnData(value, "endedAt").value);
    const digest = digestBoundedResultText(readOwnData(value, "text").value);
    if (digest === null) {
      return {
        result: null,
        failure: boundedCompletionReason(
          `returned result text is unavailable or exceeds ${NATIVE_HARNESS_COMPLETION_LIMITS.maxResultTextBytes} bytes`,
        ),
      };
    }
    if (
      eventsPath === null
      || (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "timed_out")
      || startedAt === null
      || endedAt === null
    ) {
      return { result: null, failure: "returned result boundary fields are unavailable" };
    }
    const usageValue = readOwnData(value, "usage").value;
    const inputTokens = readOwnData(usageValue, "inputTokens").value;
    const outputTokens = readOwnData(usageValue, "outputTokens").value;
    const costUsd = readOwnData(usageValue, "costUsd").value;
    const estimated = readOwnData(value, "usageEstimated");
    let usageEstimated: boolean;
    if (!estimated.present) {
      usageEstimated = false;
    } else if (estimated.readable && typeof estimated.value === "boolean") {
      usageEstimated = estimated.value;
    } else {
      return { result: null, failure: "returned result usage facts are unavailable" };
    }
    if (
      typeof inputTokens !== "number"
      || !Number.isSafeInteger(inputTokens)
      || inputTokens < 0
      || typeof outputTokens !== "number"
      || !Number.isSafeInteger(outputTokens)
      || outputTokens < 0
      || typeof costUsd !== "number"
      || !Number.isFinite(costUsd)
      || costUsd < 0
    ) {
      return { result: null, failure: "returned result usage facts are unavailable" };
    }
    return {
      result: deepFreeze({
        eventsPath,
        status,
        startedAt,
        endedAt,
        textBytes: digest.bytes,
        textSha256: digest.sha256,
        usage: { inputTokens, outputTokens, costUsd, usageEstimated },
      }),
      failure: null,
    };
  } catch {
    return { result: null, failure: "returned result facts are unreadable" };
  }
}

export function sameWitnessResult(
  left: NativeHarnessCompletionResultFacts,
  right: NativeHarnessCompletionResultFacts,
): boolean {
  return left.eventsPath === right.eventsPath
    && left.status === right.status
    && left.startedAt === right.startedAt
    && left.endedAt === right.endedAt
    && left.textBytes === right.textBytes
    && left.textSha256 === right.textSha256
    && left.usage.inputTokens === right.usage.inputTokens
    && left.usage.outputTokens === right.usage.outputTokens
    && left.usage.costUsd === right.usage.costUsd
    && left.usage.usageEstimated === right.usage.usageEstimated;
}

export function sameWitnessBase(
  left: NativeHarnessCompletionBase,
  right: NativeHarnessCompletionBase,
): boolean {
  if (
    left.snapshotId !== right.snapshotId
    || left.root !== right.root
    || left.sourceRoot !== right.sourceRoot
    || left.createdAt !== right.createdAt
    || left.manifestSha256 !== right.manifestSha256
    || left.entries.length !== right.entries.length
    || left.inputs.length !== right.inputs.length
  ) {
    return false;
  }
  for (let index = 0; index < left.entries.length; index += 1) {
    const leftEntry = left.entries[index]!;
    const rightEntry = right.entries[index]!;
    if (
      leftEntry.path !== rightEntry.path
      || leftEntry.size !== rightEntry.size
      || leftEntry.mode !== rightEntry.mode
      || leftEntry.hash !== rightEntry.hash
    ) {
      return false;
    }
  }
  for (let index = 0; index < left.inputs.length; index += 1) {
    const leftInput = left.inputs[index]!;
    const rightInput = right.inputs[index]!;
    if (
      leftInput.path !== rightInput.path
      || leftInput.size !== rightInput.size
      || leftInput.contentSha256 !== rightInput.contentSha256
    ) {
      return false;
    }
  }
  return true;
}

/** Compares a later, unverified snapshot record with the checked witness base. */
export function snapshotMatchesWitnessBase(snapshot: unknown, base: NativeHarnessCompletionBase): boolean {
  try {
    if (readOwnData(snapshot, "id").value !== base.snapshotId) return false;
    if (readOwnData(snapshot, "root").value !== base.root) return false;
    if (readOwnData(snapshot, "sourceRoot").value !== base.sourceRoot) return false;
    if (readOwnData(snapshot, "createdAt").value !== base.createdAt) return false;
    const files = readOwnArrayValues(
      readOwnData(snapshot, "files").value,
      NATIVE_HARNESS_COMPLETION_LIMITS.maxBaseInputs,
    );
    if (files === null || files.length !== base.entries.length) return false;
    const entries: NativeHarnessCompletionBaseEntry[] = [];
    for (const raw of files) {
      const entryPath = copyRelativePath(readOwnData(raw, "path").value);
      const size = boundedContentSize(readOwnData(raw, "size").value);
      const mode = boundedMode(readOwnData(raw, "mode").value);
      const hash = boundedCompletionHash(readOwnData(raw, "hash").value);
      if (entryPath === null || size === null || mode === null || hash === null) return false;
      entries.push({ path: entryPath, size, mode, hash });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    for (let index = 0; index < entries.length; index += 1) {
      const left = entries[index]!;
      const right = base.entries[index]!;
      if (
        left.path !== right.path
        || left.size !== right.size
        || left.mode !== right.mode
        || left.hash !== right.hash
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Validates the prepared descriptor's manifest entries for the completion. */
export function copyPreparedInputs(value: unknown): readonly NativeHarnessCompletionPreparedInput[] | null {
  const values = readOwnArrayValues(value, NATIVE_HARNESS_COMPLETION_LIMITS.maxBaseInputs);
  if (values === null || values.length < 1) return null;
  const inputs: NativeHarnessCompletionPreparedInput[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const relativePath = copyRelativePath(readOwnData(raw, "relativePath").value);
    const bytes = boundedContentSize(readOwnData(raw, "bytes").value);
    const sha256 = boundedCompletionHash(readOwnData(raw, "sha256").value);
    if (relativePath === null || bytes === null || sha256 === null || seen.has(relativePath)) return null;
    seen.add(relativePath);
    inputs.push({ relativePath, bytes, sha256 });
  }
  inputs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return deepFreeze(inputs);
}

/** JSON UTF-8 byte count of an already-bounded projection. */
export function completionMetadataBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : Buffer.byteLength(encoded, "utf8");
  } catch {
    return null;
  }
}

/**
 * Equality of two backend-owned, already-bounded projections. Never pass an
 * arbitrary caller object: JSON serialization would invoke its hooks.
 */
export function sameBoundedProjection(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
