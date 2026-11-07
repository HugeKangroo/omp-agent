/**
 * Pure requirement-ledger, projection and receipt helpers for G1-B2a.
 *
 * The ledger is the authoritative, host-observed source of requirements:
 * the original request followed by accepted genuine-user amendments in
 * revision order. Nothing in this module writes owner state, and nothing here
 * validates model JSON, task acceptance or evidence.
 */

import { createHash } from "node:crypto";

export const REQUIREMENTS_SCHEMA_VERSION = 1 as const;
export const MAX_REQUIREMENT_SOURCES = 32;
/** Full JSON-encoded UTF-8 requirement source ledger. */
export const MAX_SOURCE_LEDGER_BYTES = 64 * 1024;
/** Read-only current-requirements projection returned to the caller. */
export const MAX_REQUIREMENTS_PROJECTION_BYTES = 128 * 1024;
/** Actual task-control response envelope (details and JSON text). */
export const MAX_TASK_CONTROL_RESPONSE_BYTES = 256 * 1024;

export type InputSource = "interactive" | "rpc";

export class RequirementBoundsError extends Error {
  override name = "RequirementBoundsError";
  readonly code = "TOO_LARGE" as const;
}

/** One complete, non-truncated authoritative requirement source. */
export interface RequirementSource {
  revision: number;
  kind: "original" | "amendment";
  messageId: string;
  sessionId: string;
  source: InputSource;
  text: string;
  observedAt: string;
  committedAt: string;
  previousRevision: number | null;
}

/**
 * One shared encoding helper for every byte limit. String `.length` is never
 * used for a byte bound; the same JSON encoding is persisted and projected.
 */
export const REQUIREMENTS_DIGEST_VERSION = "requirements-digest-v1" as const;

/**
 * Stable digest of the complete authoritative requirement ledger. It encodes
 * only the named source fields, in ledger order and in a fixed field order, so
 * object insertion order cannot change the identity. Text, newlines and
 * multi-byte characters are hashed exactly as observed; understanding is not
 * part of the ledger and cannot change this digest.
 */
export function requirementsDigest(sources: readonly RequirementSource[]): string {
  assertSourceLedgerBounds(sources);
  const encoded = JSON.stringify({
    version: REQUIREMENTS_DIGEST_VERSION,
    sources: sources.map((source) => ({
      revision: source.revision,
      kind: source.kind,
      messageId: source.messageId,
      sessionId: source.sessionId,
      source: source.source,
      text: source.text,
      observedAt: source.observedAt,
      committedAt: source.committedAt,
      previousRevision: source.previousRevision,
    })),
  });
  return `${REQUIREMENTS_DIGEST_VERSION}:sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export function encodedUtf8Bytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new RequirementBoundsError("TOO_LARGE: value is not JSON-encodable; the byte bound cannot be proven.");
  return new TextEncoder().encode(json).byteLength;
}

function overLimit(label: string, actual: number, limit: number): RequirementBoundsError {
  return new RequirementBoundsError(`TOO_LARGE: ${label} is ${actual} UTF-8 bytes; the prototype limit is ${limit} bytes.`);
}

export interface UnderstandingProjection {
  text: string;
  revision: number;
  stale: boolean;
}

export interface RequirementsProjection {
  schemaVersion: typeof REQUIREMENTS_SCHEMA_VERSION;
  authoritative: "host-observed-sources";
  taskId: string;
  ownerId: string;
  taskRevision: number;
  original: { revision: number; messageId: string; text: string; observedAt: string };
  amendments: Array<{
    revision: number;
    previousRevision: number;
    messageId: string;
    sessionId: string;
    source: InputSource;
    text: string;
    observedAt: string;
    committedAt: string;
  }>;
  understanding: UnderstandingProjection | null;
}

export interface RequirementProjectionInput {
  taskId: string;
  ownerId: string;
  taskRevision: number;
  sources: readonly RequirementSource[];
  understanding: { text: string; revision: number | null; stale: boolean } | null;
}

/**
 * Read-only authoritative requirements view. It restates complete source
 * texts and never substitutes a model summary for a constraint.
 */
export function requirementProjection(input: RequirementProjectionInput): RequirementsProjection {
  const original = input.sources.find((source) => source.kind === "original");
  if (!original) throw new RequirementBoundsError("TOO_LARGE: the requirement source ledger has no original request; refusing to project an incomplete view.");
  const amendments = input.sources
    .filter((source) => source.kind === "amendment")
    .sort((left, right) => left.revision - right.revision)
    .map((source) => ({
      revision: source.revision,
      previousRevision: source.previousRevision ?? original.revision,
      messageId: source.messageId,
      sessionId: source.sessionId,
      source: source.source,
      text: source.text,
      observedAt: source.observedAt,
      committedAt: source.committedAt,
    }));
  return {
    schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
    authoritative: "host-observed-sources",
    taskId: input.taskId,
    ownerId: input.ownerId,
    taskRevision: input.taskRevision,
    original: {
      revision: original.revision,
      messageId: original.messageId,
      text: original.text,
      observedAt: original.observedAt,
    },
    amendments,
    understanding: input.understanding === null
      ? null
      : {
        text: input.understanding.text,
        revision: input.understanding.revision ?? input.taskRevision,
        stale: input.understanding.stale,
      },
  };
}

export function hasRequirementSource(sources: readonly RequirementSource[], messageId: string): boolean {
  return sources.some((source) => source.messageId === messageId);
}

/** Record and ledger bounds only; used for the compact baseline check. */
export function assertSourceLedgerBounds(sources: readonly RequirementSource[]): void {
  if (sources.length > MAX_REQUIREMENT_SOURCES) {
    throw new RequirementBoundsError(
      `TOO_LARGE: the requirement source ledger has ${sources.length} records; the prototype limit is ${MAX_REQUIREMENT_SOURCES} including the original request.`,
    );
  }
  const bytes = encodedUtf8Bytes(sources);
  if (bytes > MAX_SOURCE_LEDGER_BYTES) throw overLimit("the requirement source ledger", bytes, MAX_SOURCE_LEDGER_BYTES);
}

/**
 * Atomic pre-commit check: ledger, projection and (when given) the complete
 * response envelope. Callers must run this before mutating owner state.
 */
export function assertRequirementCommitBounds(input: {
  sources: readonly RequirementSource[];
  projection: RequirementsProjection;
  response?: unknown;
}): void {
  assertSourceLedgerBounds(input.sources);
  const projectionBytes = encodedUtf8Bytes(input.projection);
  if (projectionBytes > MAX_REQUIREMENTS_PROJECTION_BYTES) {
    throw overLimit("the current requirements projection", projectionBytes, MAX_REQUIREMENTS_PROJECTION_BYTES);
  }
  if (input.response !== undefined) assertTaskControlResponseBound(input.response);
}

export function assertTaskControlResponseBound(response: unknown): void {
  const bytes = encodedUtf8Bytes(response);
  if (bytes > MAX_TASK_CONTROL_RESPONSE_BYTES) {
    throw overLimit("the task-control response envelope", bytes, MAX_TASK_CONTROL_RESPONSE_BYTES);
  }
}

/** Optimistic revision baseline captured when the real input was observed. */
export function revisionBaselineMatches(baseline: number | null, current: number): boolean {
  return baseline !== null && baseline === current;
}

/**
 * Original host-issued admission receipt. It is not authenticated here and
 * says nothing about task acceptance or evidence validity.
 */
export interface TrustedAdmissionReceipt {
  taskId: string;
  ownerId: string;
  taskRevision: number;
  actionIndex: number;
}

export interface ReceiptContext {
  taskId: string;
  ownerId: string;
  taskRevision: number;
  detached: boolean;
}

export type ReceiptCompatibility = "current" | "stale-revision" | "detached" | "other-task" | "other-owner";

/**
 * Classify a receipt already trusted from the host. The caller must not feed
 * arbitrary model JSON here; this helper neither authenticates nor validates
 * evidence, task acceptance or authorization.
 */
export function classifyAdmissionReceipt(
  receipt: TrustedAdmissionReceipt,
  context: ReceiptContext,
): ReceiptCompatibility {
  if (receipt.ownerId !== context.ownerId) return "other-owner";
  if (receipt.taskId !== context.taskId) return "other-task";
  if (context.detached) return "detached";
  if (receipt.taskRevision !== context.taskRevision) return "stale-revision";
  return "current";
}
