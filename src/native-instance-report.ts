import type { NativeContext, NativeWorkCallReference } from "./native-entry.ts";
import type { NativeInstanceResultAssociation } from "./native-instance-result.ts";

/**
 * Fixed internal contract for associating one C1-observed native instance
 * result with an existing agent_work report.
 *
 * This module owns only bounded plain types and pure metadata validation. It
 * has no runtime imports and no access to instance roots, records, work state,
 * files, clocks or host context. The instanced entry later implements the port;
 * the ordinary native entry owns report validation, publication and replay.
 */

export const NATIVE_INSTANCE_REPORT_CATALOG_SCHEMA = "omp-agent.native-instance-report-catalog.v1";
export const MAX_NATIVE_INSTANCE_REPORT_ID_CHARS = 256;
export const MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS = 4096;
export const MAX_NATIVE_INSTANCE_REPORT_REASON_CHARS = 500;
export const MAX_NATIVE_INSTANCE_REPORT_CATALOG_ITEMS = 64;
export const MAX_NATIVE_INSTANCE_REPORT_CATALOG_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;

/** Strict report-only selector. IDs and digest are never normalized. */
export interface NativeInstanceReportSelection {
  readonly instanceId: string;
  readonly parentToolCallId: string;
  readonly envelopeSha256: string;
}

/** Actual report work binding, copied from the retained native work object. */
export interface NativeReportWorkIdentity {
  readonly observationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceRoot: string;
}

export interface NativeInstanceReportFacts {
  readonly result: NativeInstanceResultAssociation;
  readonly work: NativeWorkCallReference;
  readonly envelope: {
    readonly sha256: string;
    readonly bytes: number;
    readonly scope: "tool-result-middleware";
  };
  readonly artifactBasis: "observed-during-report";
  readonly semanticAcceptance: "not-evaluated";
}

export type NativeInstanceReportCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface NativeInstanceReportPreparation {
  readonly facts: NativeInstanceReportFacts;
  /**
   * Synchronous actual host reads for the original preparation reference.
   * Returns a bounded check; never a promise. It may reject changed roots,
   * records, lifecycle, result or native work.
   */
  refresh(context: NativeContext): NativeInstanceReportCheck;
  /**
   * Pure captured-identity check: root/record/reference/C1 object/lifecycle
   * only. Returns null for success or a bounded primitive refusal string.
   * Any other return, including an object or promise, is refused without
   * reading its properties or `.then`.
   */
  revalidate(): string | null;
}

export type NativeInstanceReportPrepareResult =
  | { readonly ok: true; readonly prepared: NativeInstanceReportPreparation }
  | { readonly ok: false; readonly reason: string };

export type NativeInstanceReportSelectionRead =
  | { readonly ok: true; readonly selection: NativeInstanceReportSelection }
  | { readonly ok: false; readonly reason: string };

export type NativeInstanceReportFactsResult =
  | { readonly ok: true; readonly facts: NativeInstanceReportFacts }
  | { readonly ok: false; readonly reason: string };

export interface NativeInstanceReportCatalogItem {
  readonly instanceId: string;
  readonly parentToolCallId: string;
  /**
   * Null only when `available` is false and a bounded `reason` explains the
   * missing C1 envelope. An available row requires a lowercase 64-char sha256.
   */
  readonly envelopeSha256: string | null;
  /** Selector found now; this is not permission for a later report. */
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * Bounded inspection-time candidates. For an available catalog, `total`
 * counts candidates known to the port and `omitted` is the number not present
 * in `items` after the core's own item/byte bounds. `complete` is false
 * whenever anything was omitted. An unavailable catalog has unknown counts
 * (`null`), never fabricated zeroes.
 */
export type NativeInstanceReportCatalog =
  | {
      readonly state: "available";
      readonly reason: string | null;
      readonly items: readonly NativeInstanceReportCatalogItem[];
      readonly total: number;
      readonly omitted: number;
      readonly complete: boolean;
    }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly items: readonly [];
      readonly total: null;
      readonly omitted: null;
      readonly complete: false;
    };

/**
 * INTERNAL trusted-composition port. Implementations are synchronous and must
 * return frozen or copyable plain facts. The native entry safely rejects
 * throws, malformed returns, thenables and mismatched facts.
 */
export interface NativeInstanceReportPort {
  prepare(
    selection: NativeInstanceReportSelection,
    work: NativeReportWorkIdentity,
    context: NativeContext,
  ): NativeInstanceReportPrepareResult;
  inspect(
    context: NativeContext,
    work: NativeReportWorkIdentity | null,
  ): NativeInstanceReportCatalog;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function ownArrayValue(value: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function ownKeys(value: Record<string, unknown>): readonly string[] | null {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  return keys as string[];
}

function boundedText(value: unknown, maxChars: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= maxChars ? value : null;
}

function boundedReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= MAX_NATIVE_INSTANCE_REPORT_REASON_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_NATIVE_INSTANCE_REPORT_REASON_CHARS - 3)}...`;
}

function lowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function safeInteger(value: unknown, minimum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

/** Strict own bounded fields; missing, extra, accessor, symbol or coercion is refused. */
export function readNativeInstanceReportSelection(value: unknown): NativeInstanceReportSelectionRead {
  try {
    if (!isRecord(value)) {
      return { ok: false, reason: "instanceResult must be a plain object with exactly instanceId, parentToolCallId and envelopeSha256." };
    }
    const keys = ownKeys(value);
    if (keys === null
      || keys.length !== 3
      || !keys.includes("instanceId")
      || !keys.includes("parentToolCallId")
      || !keys.includes("envelopeSha256")) {
      return { ok: false, reason: "instanceResult must contain exactly instanceId, parentToolCallId and envelopeSha256." };
    }
    const instanceId = boundedText(ownDataValue(value, "instanceId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
    const parentToolCallId = boundedText(
      ownDataValue(value, "parentToolCallId"),
      MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
    );
    const envelopeSha256 = ownDataValue(value, "envelopeSha256");
    if (instanceId === null) {
      return { ok: false, reason: `instanceResult.instanceId must be an own string of 1-${MAX_NATIVE_INSTANCE_REPORT_ID_CHARS} characters.` };
    }
    if (parentToolCallId === null) {
      return { ok: false, reason: `instanceResult.parentToolCallId must be an own string of 1-${MAX_NATIVE_INSTANCE_REPORT_ID_CHARS} characters.` };
    }
    if (!lowercaseSha256(envelopeSha256)) {
      return { ok: false, reason: "instanceResult.envelopeSha256 must be an own lowercase 64-character hex sha256." };
    }
    return {
      ok: true,
      selection: Object.freeze({ instanceId, parentToolCallId, envelopeSha256 }),
    };
  } catch {
    return { ok: false, reason: "instanceResult could not be read as own bounded fields." };
  }
}

export function unavailableNativeInstanceReportCatalog(reason: string): NativeInstanceReportCatalog {
  return Object.freeze({
    state: "unavailable" as const,
    reason: boundedReason(reason) ?? "instance result inspection is unavailable",
    items: Object.freeze([]) as readonly [],
    total: null,
    omitted: null,
    complete: false,
  });
}

function normalizeCatalogItem(value: unknown): NativeInstanceReportCatalogItem | null {
  try {
    if (!isRecord(value)) return null;
    const instanceId = boundedText(ownDataValue(value, "instanceId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
    const parentToolCallId = boundedText(
      ownDataValue(value, "parentToolCallId"),
      MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
    );
    const envelopeSha256 = ownDataValue(value, "envelopeSha256");
    const available = ownDataValue(value, "available");
    const rawReason = ownDataValue(value, "reason");
    const reason = boundedReason(rawReason);
    if (instanceId === null
      || parentToolCallId === null
      || typeof available !== "boolean"
      || (rawReason !== null && rawReason !== undefined && reason === null)) {
      return null;
    }
    if (available) {
      if (!lowercaseSha256(envelopeSha256) || reason !== null) return null;
    } else if (reason === null || (envelopeSha256 !== null && !lowercaseSha256(envelopeSha256))) {
      // An unavailable row may omit the envelope only with a bounded reason,
      // and any supplied digest must still be a real lowercase sha256.
      return null;
    }
    return Object.freeze({
      instanceId,
      parentToolCallId,
      envelopeSha256: lowercaseSha256(envelopeSha256) ? envelopeSha256 : null,
      available,
      reason,
    });
  } catch {
    return null;
  }
}

/**
 * Copy a port catalog into the core's own bounded plain shape. Malformed
 * catalogs fail closed; a large catalog is explicitly truncated, never filled
 * with invented records or reported as complete.
 */
export function boundNativeInstanceReportCatalog(value: unknown): NativeInstanceReportCatalog {
  try {
    if (!isRecord(value)) {
      return unavailableNativeInstanceReportCatalog("The instance result port returned an unreadable catalog.");
    }
    const state = ownDataValue(value, "state");
    const rawReason = ownDataValue(value, "reason");
    if (state === "unavailable") {
      return unavailableNativeInstanceReportCatalog(
        boundedReason(rawReason) ?? "The instance result port reported unavailable inspection.",
      );
    }
    if (state !== "available") {
      return unavailableNativeInstanceReportCatalog("The instance result port returned an unknown catalog state.");
    }
    const rawItems = ownDataValue(value, "items");
    if (!Array.isArray(rawItems)) {
      return unavailableNativeInstanceReportCatalog("The instance result port returned no catalog items array.");
    }
    const rawLength = rawItems.length;
    const total = safeInteger(ownDataValue(value, "total"), 0);
    const portOmitted = safeInteger(ownDataValue(value, "omitted"), 0);
    const complete = ownDataValue(value, "complete");
    if (total === null
      || portOmitted === null
      || total !== rawLength + portOmitted
      || typeof complete !== "boolean"
      || complete !== (portOmitted === 0)) {
      return unavailableNativeInstanceReportCatalog(
        "The instance result port catalog has missing or inconsistent total, omitted and complete counts.",
      );
    }
    const reason = boundedReason(rawReason);
    const items: NativeInstanceReportCatalogItem[] = [];
    const build = (): NativeInstanceReportCatalog => {
      const omitted = total - items.length;
      return Object.freeze({
        state: "available" as const,
        reason,
        items: Object.freeze([...items]) as readonly NativeInstanceReportCatalogItem[],
        total,
        omitted,
        complete: omitted === 0,
      });
    };
    const fits = (catalog: NativeInstanceReportCatalog): boolean =>
      Buffer.byteLength(JSON.stringify(catalog), "utf8") <= MAX_NATIVE_INSTANCE_REPORT_CATALOG_BYTES;
    if (!fits(build())) {
      return unavailableNativeInstanceReportCatalog(
        "The instance result port catalog metadata alone exceeds the bounded encoded size.",
      );
    }
    const limit = Math.min(rawLength, MAX_NATIVE_INSTANCE_REPORT_CATALOG_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      const item = normalizeCatalogItem(ownArrayValue(rawItems, index));
      if (item === null) {
        return unavailableNativeInstanceReportCatalog(
          "The instance result port returned a malformed selector summary; no candidates were used.",
        );
      }
      items.push(item);
      if (!fits(build())) {
        items.pop();
        break;
      }
    }
    return build();
  } catch {
    return unavailableNativeInstanceReportCatalog("The instance result port catalog could not be read.");
  }
}

function associationSnapshot(value: unknown): NativeInstanceResultAssociation | null {
  if (!isRecord(value)) return null;
  const instanceId = boundedText(ownDataValue(value, "instanceId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const parentToolCallId = boundedText(
    ownDataValue(value, "parentToolCallId"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  const index = ownDataValue(value, "index");
  const childId = boundedText(ownDataValue(value, "childId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const childSessionId = boundedText(
    ownDataValue(value, "childSessionId"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  const agentName = boundedText(ownDataValue(value, "agentName"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const parentSessionId = boundedText(
    ownDataValue(value, "parentSessionId"),
    MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS,
  );
  const workspaceRoot = boundedText(
    ownDataValue(value, "workspaceRoot"),
    MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS,
  );
  const rootEpoch = safeInteger(ownDataValue(value, "rootEpoch"), 0);
  const definitionVersion = boundedText(
    ownDataValue(value, "definitionVersion"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  if (instanceId === null
    || parentToolCallId === null
    || index !== 0
    || childId === null
    || childSessionId === null
    || agentName === null
    || parentSessionId === null
    || workspaceRoot === null
    || rootEpoch === null
    || definitionVersion === null) {
    return null;
  }
  return {
    instanceId,
    parentToolCallId,
    index: 0,
    childId,
    childSessionId,
    agentName,
    parentSessionId,
    workspaceRoot,
    rootEpoch,
    definitionVersion,
  };
}

function workReferenceSnapshot(value: unknown): NativeWorkCallReference | null {
  if (!isRecord(value)) return null;
  const observationId = boundedText(
    ownDataValue(value, "observationId"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  const generation = safeInteger(ownDataValue(value, "generation"), 1);
  const sessionId = boundedText(ownDataValue(value, "sessionId"), MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS);
  const workspaceRoot = boundedText(
    ownDataValue(value, "workspaceRoot"),
    MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS,
  );
  const toolCallId = boundedText(
    ownDataValue(value, "toolCallId"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  const toolName = ownDataValue(value, "toolName");
  if (observationId === null
    || generation === null
    || sessionId === null
    || workspaceRoot === null
    || toolCallId === null
    || toolName !== "task") {
    return null;
  }
  return { observationId, generation, sessionId, workspaceRoot, toolCallId, toolName: "task" };
}

/**
 * Copy and validate prepared facts before any file I/O. The returned object is
 * a deep-frozen primitive snapshot; later callback aliasing cannot change what
 * is published.
 */
export function snapshotNativeInstanceReportFacts(
  value: unknown,
  selection: NativeInstanceReportSelection,
  work: NativeReportWorkIdentity,
): NativeInstanceReportFactsResult {
  try {
    if (!isRecord(value)) {
      return { ok: false, reason: "The instance result preparation returned no facts object." };
    }
    const result = associationSnapshot(ownDataValue(value, "result"));
    if (result === null) {
      return {
        ok: false,
        reason: "The prepared result association lacks a complete instance link, index 0, child id/session or definition version.",
      };
    }
    const workRef = workReferenceSnapshot(ownDataValue(value, "work"));
    if (workRef === null) {
      return { ok: false, reason: "The prepared work reference is not a complete bound task call for this work." };
    }
    const envelopeValue = ownDataValue(value, "envelope");
    if (!isRecord(envelopeValue)) {
      return { ok: false, reason: "The prepared envelope metadata is unreadable." };
    }
    const sha256 = ownDataValue(envelopeValue, "sha256");
    const bytes = safeInteger(ownDataValue(envelopeValue, "bytes"), 1);
    const scope = ownDataValue(envelopeValue, "scope");
    if (!lowercaseSha256(sha256)
      || bytes === null
      || bytes > MAX_ENVELOPE_BYTES
      || scope !== "tool-result-middleware") {
      return { ok: false, reason: "The prepared envelope metadata must be a bounded observed tool-result-middleware envelope." };
    }
    if (ownDataValue(value, "artifactBasis") !== "observed-during-report"
      || ownDataValue(value, "semanticAcceptance") !== "not-evaluated") {
      return { ok: false, reason: "The prepared result facts have unsupported artifact basis or semantic acceptance." };
    }
    if (result.instanceId !== selection.instanceId
      || result.parentToolCallId !== selection.parentToolCallId
      || sha256 !== selection.envelopeSha256) {
      return { ok: false, reason: "The prepared result metadata does not match the explicit instanceResult selector." };
    }
    if (result.parentSessionId !== work.sessionId
      || result.workspaceRoot !== work.workspaceRoot) {
      return { ok: false, reason: "The prepared result session or workspace does not match this report work." };
    }
    if (workRef.observationId !== work.observationId
      || workRef.generation !== work.generation
      || workRef.sessionId !== work.sessionId
      || workRef.workspaceRoot !== work.workspaceRoot
      || workRef.toolCallId !== selection.parentToolCallId) {
      return { ok: false, reason: "The prepared work reference does not match this report work and selected parent task call." };
    }
    const facts: NativeInstanceReportFacts = {
      result: { ...result },
      work: { ...workRef },
      envelope: { sha256, bytes, scope: "tool-result-middleware" },
      artifactBasis: "observed-during-report",
      semanticAcceptance: "not-evaluated",
    };
    return { ok: true, facts: deepFreeze(facts) };
  } catch {
    return { ok: false, reason: "The prepared instance result facts could not be read." };
  }
}
