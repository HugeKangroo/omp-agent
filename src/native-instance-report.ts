import type { NativeContext, NativeWorkCallReference } from "./native-entry.ts";
import type { NativeInstanceResultAssociation } from "./native-instance-result.ts";
import {
  NATIVE_HANDOFF_SOURCE,
  type HandoffAdoptionView,
  type HandoffBindingFacts,
  type HandoffLiveFileFacts,
  type HandoffToolCallFacts,
} from "./native-handoff.ts";
import {
  NATIVE_TEXT_CHECKER_ID,
  NATIVE_TEXT_CHECKER_VERSION,
} from "./native-snapshot-checker.ts";
import { MAX_OUTPUT_FILE_BYTES, validateRelativePath } from "./native-work.ts";

/**
 * Fixed internal contract for associating one C1-observed native instance
 * result with an existing agent_work report.
 *
 * Runtime imports are fixed constants and path validation from core leaves.
 * This module has no access to instance roots, records, work state, files,
 * clocks or host context. The instanced entry later implements the port; the
 * ordinary native entry owns report validation, publication and replay.
 */

export const NATIVE_INSTANCE_REPORT_CATALOG_SCHEMA = "omp-agent.native-instance-report-catalog.v1";
export const MAX_NATIVE_INSTANCE_REPORT_ID_CHARS = 256;
export const MAX_NATIVE_INSTANCE_REPORT_ROOT_CHARS = 4096;
export const MAX_NATIVE_INSTANCE_REPORT_REASON_CHARS = 500;
export const MAX_NATIVE_INSTANCE_REPORT_CATALOG_ITEMS = 64;
export const MAX_NATIVE_INSTANCE_REPORT_CATALOG_BYTES = 64 * 1024;
export const MAX_NATIVE_HANDOFF_REPORT_BYTES = 32 * 1024;
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

export interface NativeInstanceReportEnvelope {
  readonly sha256: string;
  readonly bytes: number;
  readonly scope: "tool-result-middleware";
}

/**
 * Fixed core facts for one PASS adoption. Copied IDs and digests are facts for
 * later comparison, not proof that this module authenticated a core handle.
 */
export interface NativeHandoffReportCoreFacts {
  readonly adoption: HandoffAdoptionView;
  readonly snapshotId: string;
  readonly checkerId: typeof NATIVE_TEXT_CHECKER_ID;
  readonly checkerVersion: typeof NATIVE_TEXT_CHECKER_VERSION;
}

/**
 * Full report handoff facts. The consumer result and work are crosschecked
 * against the producer facts and this report's root/session/work/definition.
 */
export interface NativeHandoffReportFacts extends NativeHandoffReportCoreFacts {
  readonly consumer: {
    readonly result: NativeInstanceResultAssociation;
    readonly work: NativeWorkCallReference;
    readonly envelope: NativeInstanceReportEnvelope;
    readonly completed: true;
  };
}

export interface NativeInstanceReportFacts {
  readonly result: NativeInstanceResultAssociation;
  readonly work: NativeWorkCallReference;
  readonly envelope: NativeInstanceReportEnvelope;
  readonly artifactBasis: "observed-during-report";
  readonly semanticAcceptance: "not-evaluated";
  readonly handoff?: NativeHandoffReportFacts;
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
  /**
   * Old three-argument implementations remain valid because the handoff
   * selector is optional. The entry passes it only when the report requested
   * handoff adoption.
   */
  prepare(
    selection: NativeInstanceReportSelection,
    work: NativeReportWorkIdentity,
    context: NativeContext,
    handoffAdoptionId?: string,
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

const ADOPTION_FIELDS = [
  "adoptionId",
  "receiptId",
  "offerId",
  "captureId",
  "chainId",
  "version",
  "source",
  "planDigest",
  "relativePath",
  "file",
  "outcome",
  "parentBinding",
  "producer",
  "proposal",
  "adoptionCall",
  "taskAccepted",
  "semanticAcceptance",
  "authority",
] as const;
const BINDING_FIELDS = ["callId", "workId", "definitionVersion"] as const;
const RESULT_FIELDS = [
  "instanceId",
  "parentToolCallId",
  "index",
  "childId",
  "childSessionId",
  "agentName",
  "parentSessionId",
  "workspaceRoot",
  "rootEpoch",
  "definitionVersion",
] as const;
const WORK_REFERENCE_FIELDS = [
  "observationId",
  "generation",
  "sessionId",
  "workspaceRoot",
  "toolCallId",
  "toolName",
] as const;
const ENVELOPE_FIELDS = ["sha256", "bytes", "scope"] as const;
const CONSUMER_FIELDS = ["result", "work", "envelope", "completed"] as const;
const HANDOFF_FIELDS = ["adoption", "snapshotId", "checkerId", "checkerVersion", "consumer"] as const;

/**
 * Strict own-data record with an exact field set. Accessors, symbols, extra
 * fields and thenable-shaped objects are refused without invoking a getter.
 */
function strictOwnDataRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value) || "then" in value) return null;
  const keys = ownKeys(value);
  if (keys === null || keys.length !== fields.length) return null;
  for (const field of fields) {
    if (!keys.includes(field)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  return value;
}

function relativePathSnapshot(value: unknown): string | null {
  try {
    return validateRelativePath(value);
  } catch {
    return null;
  }
}

function bindingFactsSnapshot(value: unknown): HandoffBindingFacts | null {
  const record = strictOwnDataRecord(value, BINDING_FIELDS);
  if (record === null) return null;
  const callId = boundedText(ownDataValue(record, "callId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const workId = boundedText(ownDataValue(record, "workId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const definitionVersion = boundedText(
    ownDataValue(record, "definitionVersion"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  if (callId === null || workId === null || definitionVersion === null) return null;
  return { callId, workId, definitionVersion };
}

function toolCallFactsSnapshot(value: unknown): HandoffToolCallFacts | null {
  const record = strictOwnDataRecord(value, ["callId"]);
  if (record === null) return null;
  const callId = boundedText(ownDataValue(record, "callId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  return callId === null ? null : { callId };
}

function adoptionSnapshot(value: unknown): HandoffAdoptionView | null {
  const record = strictOwnDataRecord(value, ADOPTION_FIELDS);
  if (record === null) return null;
  const adoptionId = boundedText(ownDataValue(record, "adoptionId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const receiptId = boundedText(ownDataValue(record, "receiptId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const offerId = boundedText(ownDataValue(record, "offerId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const captureId = boundedText(ownDataValue(record, "captureId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const chainId = boundedText(ownDataValue(record, "chainId"), MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
  const version = safeInteger(ownDataValue(record, "version"), 1);
  const planDigest = ownDataValue(record, "planDigest");
  const relativePath = relativePathSnapshot(ownDataValue(record, "relativePath"));
  const fileRecord = strictOwnDataRecord(ownDataValue(record, "file"), ["relativePath", "bytes", "sha256"]);
  const filePath = fileRecord === null
    ? null
    : relativePathSnapshot(ownDataValue(fileRecord, "relativePath"));
  const bytes = fileRecord === null ? null : safeInteger(ownDataValue(fileRecord, "bytes"), 0);
  const fileSha256 = fileRecord === null ? null : ownDataValue(fileRecord, "sha256");
  const parentBinding = bindingFactsSnapshot(ownDataValue(record, "parentBinding"));
  const producer = bindingFactsSnapshot(ownDataValue(record, "producer"));
  const proposal = bindingFactsSnapshot(ownDataValue(record, "proposal"));
  const adoptionCall = toolCallFactsSnapshot(ownDataValue(record, "adoptionCall"));
  if (adoptionId === null
    || receiptId === null
    || offerId === null
    || captureId === null
    || chainId === null
    || version === null
    || !lowercaseSha256(planDigest)
    || relativePath === null
    || filePath === null
    || relativePath !== filePath
    || bytes === null
    || bytes > MAX_OUTPUT_FILE_BYTES
    || !lowercaseSha256(fileSha256)
    || ownDataValue(record, "source") !== NATIVE_HANDOFF_SOURCE
    || ownDataValue(record, "outcome") !== "pass"
    || parentBinding === null
    || producer === null
    || proposal === null
    || adoptionCall === null
    || ownDataValue(record, "taskAccepted") !== false
    || ownDataValue(record, "semanticAcceptance") !== "not-evaluated"
    || ownDataValue(record, "authority") !== "non-authoritative") {
    return null;
  }
  return {
    adoptionId,
    receiptId,
    offerId,
    captureId,
    chainId,
    version,
    source: NATIVE_HANDOFF_SOURCE,
    planDigest,
    relativePath,
    file: { relativePath: filePath, bytes, sha256: fileSha256 },
    outcome: "pass",
    parentBinding,
    producer,
    proposal,
    adoptionCall,
    taskAccepted: false,
    semanticAcceptance: "not-evaluated",
    authority: "non-authoritative",
  };
}

function strictAssociationSnapshot(value: unknown): NativeInstanceResultAssociation | null {
  return strictOwnDataRecord(value, RESULT_FIELDS) === null ? null : associationSnapshot(value);
}

function strictWorkReferenceSnapshot(value: unknown): NativeWorkCallReference | null {
  return strictOwnDataRecord(value, WORK_REFERENCE_FIELDS) === null
    ? null
    : workReferenceSnapshot(value);
}

function strictEnvelopeSnapshot(value: unknown): NativeInstanceReportEnvelope | null {
  const record = strictOwnDataRecord(value, ENVELOPE_FIELDS);
  if (record === null) return null;
  const sha256 = ownDataValue(record, "sha256");
  const bytes = safeInteger(ownDataValue(record, "bytes"), 1);
  if (!lowercaseSha256(sha256)
    || bytes === null
    || bytes > MAX_ENVELOPE_BYTES
    || ownDataValue(record, "scope") !== "tool-result-middleware") {
    return null;
  }
  return { sha256, bytes, scope: "tool-result-middleware" };
}

type HandoffFactsResult =
  | { readonly ok: true; readonly facts: NativeHandoffReportFacts }
  | { readonly ok: false; readonly reason: string };

/**
 * Copy the additional handoff facts as bounded own data. This verifies copied
 * facts only; it cannot authenticate a core handle or OMP identity.
 */
function snapshotHandoffFacts(
  value: unknown,
  handoffAdoptionId: string,
  result: NativeInstanceResultAssociation,
  work: NativeWorkCallReference,
  workIdentity: NativeReportWorkIdentity,
): HandoffFactsResult {
  const record = strictOwnDataRecord(value, HANDOFF_FIELDS);
  if (record === null) {
    return {
      ok: false,
      reason: "The prepared handoff facts must be a strict own-data object with exactly the fixed adoption, snapshot, checker and consumer fields.",
    };
  }
  const adoption = adoptionSnapshot(ownDataValue(record, "adoption"));
  if (adoption === null) {
    return {
      ok: false,
      reason: "The prepared handoff adoption must be one strict bounded non-authoritative PASS fact with a valid expected file.",
    };
  }
  if (adoption.adoptionId !== handoffAdoptionId) {
    return { ok: false, reason: "The prepared handoff adoptionId does not match the requested handoffAdoptionId." };
  }
  const snapshotId = boundedText(
    ownDataValue(record, "snapshotId"),
    MAX_NATIVE_INSTANCE_REPORT_ID_CHARS,
  );
  const checkerId = ownDataValue(record, "checkerId");
  const checkerVersion = ownDataValue(record, "checkerVersion");
  if (snapshotId === null) {
    return { ok: false, reason: "The prepared handoff snapshotId must be a bounded own string." };
  }
  if (checkerId !== NATIVE_TEXT_CHECKER_ID || checkerVersion !== NATIVE_TEXT_CHECKER_VERSION) {
    return { ok: false, reason: "The prepared handoff checker id or version is not the existing native text checker constant." };
  }
  const consumerRecord = strictOwnDataRecord(ownDataValue(record, "consumer"), CONSUMER_FIELDS);
  if (consumerRecord === null) {
    return {
      ok: false,
      reason: "The prepared handoff consumer must be a strict own-data result/work/envelope/completed object.",
    };
  }
  const consumerResult = strictAssociationSnapshot(ownDataValue(consumerRecord, "result"));
  const consumerWork = strictWorkReferenceSnapshot(ownDataValue(consumerRecord, "work"));
  const consumerEnvelope = strictEnvelopeSnapshot(ownDataValue(consumerRecord, "envelope"));
  if (consumerResult === null) {
    return { ok: false, reason: "The prepared handoff consumer result is not a complete bounded instance association." };
  }
  if (consumerWork === null) {
    return { ok: false, reason: "The prepared handoff consumer work is not a complete bounded task work reference." };
  }
  if (consumerEnvelope === null) {
    return { ok: false, reason: "The prepared handoff consumer envelope is not a bounded observed tool-result-middleware envelope." };
  }
  if (ownDataValue(consumerRecord, "completed") !== true) {
    return { ok: false, reason: "The prepared handoff consumer must be completed: true." };
  }
  if (consumerResult.parentSessionId !== result.parentSessionId
    || consumerResult.workspaceRoot !== result.workspaceRoot
    || consumerResult.rootEpoch !== result.rootEpoch) {
    return { ok: false, reason: "The prepared handoff consumer result does not share this report's actual root, session and workspace." };
  }
  if (consumerWork.observationId !== workIdentity.observationId
    || consumerWork.generation !== workIdentity.generation
    || consumerWork.sessionId !== workIdentity.sessionId
    || consumerWork.workspaceRoot !== workIdentity.workspaceRoot
    || consumerWork.toolCallId !== consumerResult.parentToolCallId
    || consumerWork.toolName !== "task") {
    return { ok: false, reason: "The prepared handoff consumer work does not match this report's work or its parent task call." };
  }
  if (adoption.producer.callId !== result.parentToolCallId
    || adoption.producer.definitionVersion !== result.definitionVersion
    || adoption.producer.workId !== workIdentity.observationId) {
    return { ok: false, reason: "The prepared handoff producer facts do not match the selected C2 producer work and frozen definition." };
  }
  if (adoption.parentBinding.callId !== consumerResult.parentToolCallId
    || adoption.parentBinding.definitionVersion !== consumerResult.definitionVersion
    || adoption.parentBinding.workId !== workIdentity.observationId) {
    return { ok: false, reason: "The prepared handoff parent binding does not match the consumer parent task and frozen definition." };
  }
  const facts: NativeHandoffReportFacts = {
    adoption,
    snapshotId,
    checkerId: NATIVE_TEXT_CHECKER_ID,
    checkerVersion: NATIVE_TEXT_CHECKER_VERSION,
    consumer: {
      result: consumerResult,
      work: consumerWork,
      envelope: consumerEnvelope,
      completed: true,
    },
  };
  deepFreeze(facts);
  if (Buffer.byteLength(JSON.stringify(facts), "utf8") > MAX_NATIVE_HANDOFF_REPORT_BYTES) {
    return {
      ok: false,
      reason: `The complete prepared handoff facts exceed ${MAX_NATIVE_HANDOFF_REPORT_BYTES} bytes.`,
    };
  }
  return { ok: true, facts };
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
  handoffAdoptionId?: string,
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
    let requestedHandoffId: string | null = null;
    if (handoffAdoptionId !== undefined) {
      requestedHandoffId = boundedText(handoffAdoptionId, MAX_NATIVE_INSTANCE_REPORT_ID_CHARS);
      if (requestedHandoffId === null) {
        return {
          ok: false,
          reason: `The report handoffAdoptionId must be a non-empty own string of 1-${MAX_NATIVE_INSTANCE_REPORT_ID_CHARS} characters.`,
        };
      }
    }
    const handoffDescriptor = Object.getOwnPropertyDescriptor(value, "handoff");
    const hasHandoff = handoffDescriptor !== undefined;
    if (hasHandoff !== (requestedHandoffId !== null)) {
      return {
        ok: false,
        reason: hasHandoff
          ? "The prepared facts contain handoff data that the report did not request."
          : "The report requested a handoff adoption but the prepared facts contain no handoff data.",
      };
    }
    let handoff: NativeHandoffReportFacts | undefined;
    if (hasHandoff) {
      if (!("value" in handoffDescriptor)) {
        return { ok: false, reason: "The prepared handoff field must be an own data field, not an accessor." };
      }
      if (requestedHandoffId === null) {
        return { ok: false, reason: "The prepared handoff data has no matching requested handoffAdoptionId." };
      }
      const handoffResult = snapshotHandoffFacts(
        handoffDescriptor.value,
        requestedHandoffId,
        result,
        workRef,
        work,
      );
      if (!handoffResult.ok) return handoffResult;
      handoff = handoffResult.facts;
    }
    const facts: NativeInstanceReportFacts = {
      result: { ...result },
      work: { ...workRef },
      envelope: { sha256, bytes, scope: "tool-result-middleware" },
      artifactBasis: "observed-during-report",
      semanticAcceptance: "not-evaluated",
      ...(handoff === undefined ? {} : { handoff }),
    };
    return { ok: true, facts: deepFreeze(facts) };
  } catch {
    return { ok: false, reason: "The prepared instance result facts could not be read." };
  }
}
