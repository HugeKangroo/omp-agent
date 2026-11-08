import { currentTaskOwner, subjectFromContext, type OmpToolContext } from "./task-entry-port.ts";
import type { TaskOwner, AcceptanceReference } from "./task-owner.ts";
import type {
  AcceptanceOperationResult,
  AcceptanceSelector,
  AcceptanceVisibility,
  AcceptedInspectionResult,
  AcceptedInspectionTarget,
  AcceptanceService,
  HumanReviewOperationResult,
} from "./acceptance-service.ts";
import {
  DELIVERY_BUNDLE_VERSION,
  DeliveryService,
  MAX_DELIVERY_ARTIFACTS,
  MAX_DELIVERY_CONTENT_BYTES,
  MAX_DELIVERY_RESPONSE_BYTES,
  deliveryBoundUtf8,
  deliverySafeText,
  type DeliveryPreviewRequest,
  type DeliveryToolResult,
} from "./delivery-service.ts";

/**
 * G2-B2-B2 delivery entry. It registers exactly one tool when the host
 * configured an absolute deliveryRoot. preview only freezes candidate files;
 * submit delegates to the already-constructed B1 acceptance coordinator and
 * inspect reads accepted history. This entry never owns a second transaction
 * state machine, verifier, candidate registry or model loop.
 */

export const DELIVERY_TOOL = "agent_deliver";
export const DELIVERY_ENTRY_VERSION = "0.1.0-g2b2b2.0";
export const DELIVERY_RESULT_FORMAT = "agent-deliver-result-v1";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const FORBIDDEN_DELIVERY_KEYS = new Set([
  "ownerId", "task", "taskId", "digest", "requirementsDigest", "contract",
  "contractId", "profile", "validator", "verifier", "threshold", "thresholds",
  "coverage", "receipt", "receiptId", "archiveRef", "archivePath", "path",
  "filePath", "manifest", "confirmed", "taskAccepted", "parameters", "config",
  "hostConfig", "deliveryRoot", "root", "bytes", "sha256", "verdict", "accepted",
  "owners", "sessionId", "branch", "approve", "approved", "reviewer", "decision",
  "token", "capability", "nonce", "humanReceipt", "humanReview", "content",
  "timeout", "limits",
]);

const ACCEPTANCE_ACTIONS = new Set(["submit", "inspect", "request_review"]);

type DeliveryAction = "describe" | "preview" | "submit" | "inspect" | "request_review";
type AcceptanceAction = "submit" | "inspect" | "request_review";

export class DeliveryEntryError extends Error {
  override name = "DeliveryEntryError";
}

export interface DeliveryTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: "read" | "write" | "exec";
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<DeliveryToolResult>;
}

export interface DeliveryApi {
  registerTool(tool: DeliveryTool): void;
}

export type DeliveryArguments =
  | { action: "describe" }
  | { action: "preview"; request: DeliveryPreviewRequest }
  | { action: "submit"; request: AcceptanceSelector }
  | { action: "inspect"; request: AcceptanceSelector }
  | { action: "request_review"; request: AcceptanceSelector };

export interface DeliveryEntryOptions {
  owner: TaskOwner;
  service: DeliveryService;
  /** The same-process B1 coordinator; absent when the host did not opt in. */
  acceptance?: AcceptanceService;
}

export interface DeliveryEntryControls {
  dispose(): void;
}

const BASE_DELIVERY_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["describe", "preview", "submit", "inspect"],
      description: "Describe delivery/acceptance coverage, preview a candidate selection, submit one existing delivery, or inspect accepted history.",
    },
    expectedTaskId: {
      type: "string",
      description: "Required for preview/submit/inspect/request_review. preview, submit and request_review copy the current taskId from the host task view; inspect copies the exact retained target taskId from host-visible history, which may be historical. It selects and guards only the requested target; never authority.",
    },
    expectedTaskRevision: {
      type: "integer",
      minimum: 1,
      description: "Required with expectedTaskId for preview/submit/inspect/request_review. Copy the target task's exact revision: the current revision for preview/submit/request_review, or the retained target revision for inspect. Never authority.",
    },
    deliveryId: {
      type: "string",
      description: "Required for submit/inspect/request_review. An existing deliveryId from a successful preview of the target; a selector, never authority or evidence.",
    },
    runId: {
      type: "string",
      description: "Required for preview. The real runId returned by agent_execute; selected artifacts must belong to it.",
    },
    artifactIds: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_DELIVERY_ARTIFACTS,
      description: "Required for preview. One to eight unique artifactIds from that run.",
    },
    verificationReceiptId: {
      type: "string",
      description: "Optional preview-only existing receipt selector. It is cross-checked against this exact task/run/candidate set; it is not acceptance evidence.",
    },
  },
  // OMP 18.18 repairs a closed object schema by deleting unknown keys before
  // execute. Passthrough keeps them for the strict parser, which rejects
  // host-authority fields instead of silently normalizing them.
  additionalProperties: true,
  required: ["action"],
} as const;

function deliveryParameters(humanReviewConfigured: boolean): Record<string, unknown> {
  return {
    ...BASE_DELIVERY_PARAMETERS,
    properties: {
      ...BASE_DELIVERY_PARAMETERS.properties,
      action: {
        type: "string",
        enum: humanReviewConfigured
          ? ["describe", "preview", "submit", "inspect", "request_review"]
          : ["describe", "preview", "submit", "inspect"],
        description: humanReviewConfigured
          ? "Describe delivery/acceptance coverage, preview a candidate selection, submit one existing delivery, inspect accepted history, or request an explicit local human review when the host and evidence admit it."
          : "Describe delivery/acceptance coverage, preview a candidate selection, submit one existing delivery, or inspect accepted history.",
      },
    },
  };
}

const DESCRIPTION = "Host-configured candidate delivery and guarded acceptance bridge for the current managed task. describe reports the current visible task identity/revision/status, the configured delivery root, host contract coverage, activity blockers, whether acceptance is implemented and host-configured, and the fixed limits. describe never reads delivery candidates and never promises that any delivery can be accepted; candidate eligibility is always not_checked until submit rechecks live state. preview requires expectedTaskId, expectedTaskRevision, runId and 1-8 unique artifactIds from that run; it writes private read-only copies, verifies actual bytes and returns real paths/names/sizes/sha256 plus a bounded UTF-8 preview. submit requires expectedTaskId, expectedTaskRevision and an existing deliveryId; these are optimistic selectors, never authority. The host calls the same-process acceptance coordinator, which rechecks the live contract, current verification receipt, frozen candidate set, delivered bytes, reservation and final evidence seal. A committed result reports the original operation and committed acceptance identity independently of later task navigation, appends checked file integrity when the accepted history is still visible, and an exact same-selector retry is idempotent: it installs no record and keeps the same acceptance identity. inspect is read-only: it reports the accepted record and integrity plus real checked file paths/names/bytes/sha256 when available, or explicitly reports no acceptance record, changed/missing files, detached visibility or unknown installation. Inspect never performs a new commit. preview, submit and request_review select only the current managed task; inspect selects the exact retained target identity from host-visible history and may keep reporting accepted history after a later current task exists. Top-level currentTaskId, currentTaskStatus and taskAccepted describe the present task, while target and acceptance fields describe the selected target; file integrity is checked independently and changed or missing files do not erase accepted history. Selectors never grant authorization. No receipt, contract, verdict, path, digest, acceptance flag or confirmation is accepted from the model; unknown or host-authority fields are refused. Partial or incomplete semantic coverage, a fail/insufficient receipt and missing contracts are reported and are never converted into acceptance by retrying or fabricating evidence. Completion policy: when an intended final candidate has a current host verification receipt with complete usable semantic coverage and delivery/acceptance are configured, preview that exact run/artifact selection with its real receipt, submit the returned deliveryId, then inspect and report the actual checked files, integrity and acceptance/current result. Missing, partial or failing evidence remains honestly unaccepted; do not reverify unchanged candidates to seek a different result. If delivery or acceptance is not configured, state that boundary and do not imply acceptance. This is one generic lifecycle; acceptance remains optional host configuration.";

const REVIEW_DESCRIPTION = " Local human review is configured only for the actual main agent in the local TUI with a UI installed. request_review requires expectedTaskId, expectedTaskRevision and an existing deliveryId, and only asks the local user to inspect the exact frozen requirements and delivered file bytes. It is an explicit user-review request, not a fallback from a failed automatic submit, and it never accepts model-provided approval, verdict, confirmation, receipt, token, capability, path, digest or content. The model cannot approve or decide; a rejection or cancellation leaves the task otherwise unchanged, and the same rejected request must not be repeated merely to seek a different answer. A committed request_review result is the same owner acceptance and reports the actual review state, current visibility and checked file integrity.";

const REVIEW_UNCONFIGURED_DESCRIPTION = " Local human review is not configured for this host: request_review is not available and no model action can enable it.";

function deliveryDescription(humanReviewConfigured: boolean): string {
  return `${DESCRIPTION}${humanReviewConfigured ? REVIEW_DESCRIPTION : REVIEW_UNCONFIGURED_DESCRIPTION}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(text: string): string {
  return deliveryBoundUtf8(text, MAX_DELIVERY_CONTENT_BYTES);
}

function responseBytes(result: DeliveryToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function assertEntryResponseBound(result: DeliveryToolResult): void {
  if (responseBytes(result) > MAX_DELIVERY_RESPONSE_BYTES) {
    throw new DeliveryEntryError("The delivery tool response exceeded its fixed byte budget.");
  }
}

function compactFieldList(names: readonly string[]): string {
  if (names.length === 0) return "none";
  const shown = names.slice(0, 3).map((name) => deliveryBoundUtf8(deliverySafeText(name), 64));
  return `${names.length} unsupported field(s): ${shown.join(", ")}${names.length > 3 ? ` (+${names.length - 3} more)` : ""}`;
}

function safeText(value: string, limit = 4096): string {
  return deliveryBoundUtf8(deliverySafeText(value), limit);
}

function safeNullable(value: string | null | undefined, limit = 1024): string | null {
  return value === null || value === undefined ? null : safeText(value, limit);
}

/**
 * JSON.stringify leaves bidi/format controls and DEL/C1 controls raw while
 * escaping only C0. Replace those code points with valid JSON \\u escapes in
 * the serialized text; JSON.parse then recovers the exact original string.
 * Identity/path values are never escaped by the value-level helpers, so this
 * is the single safe serialization boundary and never changes a checked path.
 */
function escapeJsonFormatControls(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    let formatControl = false;
    if (code === 0x00ad || code === 0x061c || code === 0x180e || code === 0xfeff
      || (code >= 0x200b && code <= 0x200f)
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x206f)
      || (code >= 0xfff9 && code <= 0xfffb)) {
      formatControl = true;
    }
    if (!formatControl && code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const codePoint = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        if (codePoint >= 0xe0000 && codePoint <= 0xe007f) {
          const high = 0xd800 + ((codePoint - 0x10000) >> 10);
          const lowSurrogate = 0xdc00 + ((codePoint - 0x10000) & 0x3ff);
          output += `\\u${high.toString(16).padStart(4, "0")}\\u${lowSurrogate.toString(16).padStart(4, "0")}`;
          index += 1;
          continue;
        }
      }
    }
    if (formatControl || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      output += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      output += text[index]!;
    }
  }
  return output;
}

function serializedModelJson(value: unknown): string {
  return escapeJsonFormatControls(JSON.stringify(value));
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DeliveryEntryError(`${label} must be a valid identifier.`);
  }
  return value;
}

function parseAcceptanceSelector(args: Record<string, unknown>): AcceptanceSelector {
  const expectedTaskId = identifier(args.expectedTaskId, "expectedTaskId");
  if (typeof args.expectedTaskRevision !== "number"
    || !Number.isSafeInteger(args.expectedTaskRevision)
    || args.expectedTaskRevision <= 0) {
    throw new DeliveryEntryError("expectedTaskRevision must be a positive integer required by this action.");
  }
  const deliveryId = identifier(args.deliveryId, "deliveryId");
  return { expectedTaskId, expectedTaskRevision: args.expectedTaskRevision, deliveryId };
}

/** Strict model-facing parser; every authority-shaped field is rejected. */
export function parseDeliveryArguments(value: unknown): DeliveryArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeliveryEntryError("agent_deliver arguments must be an object.");
  }
  const args = value as Record<string, unknown>;
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => FORBIDDEN_DELIVERY_KEYS.has(key));
  if (forbidden.length) {
    throw new DeliveryEntryError(`agent_deliver never accepts host authority fields: ${compactFieldList(forbidden)}.`);
  }
  if (args.action === "describe") {
    const unknown = keys.filter((key) => key !== "action");
    if (unknown.length) throw new DeliveryEntryError(`agent_deliver describe has ${compactFieldList(unknown)}.`);
    return { action: "describe" };
  }
  if (ACCEPTANCE_ACTIONS.has(String(args.action))) {
    const action = args.action as AcceptanceAction;
    const allowed = new Set(["action", "expectedTaskId", "expectedTaskRevision", "deliveryId"]);
    const unknown = keys.filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new DeliveryEntryError(`agent_deliver ${action} has ${compactFieldList(unknown)}; it accepts only the delivery selector.`);
    }
    return { action, request: parseAcceptanceSelector(args) };
  }
  if (args.action !== "preview") {
    throw new DeliveryEntryError("agent_deliver action must be describe, preview, submit, inspect or request_review.");
  }
  const allowed = new Set([
    "action", "expectedTaskId", "expectedTaskRevision", "runId", "artifactIds", "verificationReceiptId",
  ]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length) throw new DeliveryEntryError(`agent_deliver preview has ${compactFieldList(unknown)}.`);
  const expectedTaskId = identifier(args.expectedTaskId, "expectedTaskId");
  if (typeof args.expectedTaskRevision !== "number"
    || !Number.isSafeInteger(args.expectedTaskRevision)
    || args.expectedTaskRevision <= 0) {
    throw new DeliveryEntryError("expectedTaskRevision must be a positive integer required by preview.");
  }
  const runId = identifier(args.runId, "runId");
  if (!Array.isArray(args.artifactIds)
    || args.artifactIds.length < 1
    || args.artifactIds.length > MAX_DELIVERY_ARTIFACTS) {
    throw new DeliveryEntryError(`artifactIds must select 1-${MAX_DELIVERY_ARTIFACTS} artifacts from one run.`);
  }
  const artifactIds = args.artifactIds.map((item) => identifier(item, "artifactId"));
  if (new Set(artifactIds).size !== artifactIds.length) throw new DeliveryEntryError("artifactIds must be unique.");
  const verificationReceiptId = args.verificationReceiptId === undefined
    ? undefined
    : identifier(args.verificationReceiptId, "verificationReceiptId");
  return {
    action: "preview",
    request: {
      expectedTaskId,
      expectedTaskRevision: args.expectedTaskRevision,
      runId,
      artifactIds,
      ...(verificationReceiptId === undefined ? {} : { verificationReceiptId }),
    },
  };
}

interface VisibleTaskFacts {
  taskId: string;
  status: string;
  accepted: boolean;
}

/**
 * Read-only visible task facts for an entry rejection. The owner snapshot is
 * never used alone; the live main-session branch, attachment and reachability
 * must all agree. Any unavailable case returns null rather than a guessed
 * false or another task's status.
 */
function visibleTaskFacts(owner: TaskOwner, context: OmpToolContext): VisibleTaskFacts | null {
  if (currentTaskOwner() !== owner) return null;
  try {
    const before = owner.snapshot();
    if (before.acceptanceHazard !== null) return null;
    if (before.binding.state !== "attached") return null;
    const subject = subjectFromContext(context, owner.workspaceRoot);
    if (subject.agentKind !== "main") return null;
    const task = owner.reachableTask(subject);
    // Context getters are external. Recheck the published owner, disposal and
    // snapshot with pure in-process guards before exposing these facts.
    if (currentTaskOwner() !== owner) return null;
    const after = owner.snapshot();
    if (after.acceptanceHazard !== null || after.binding.state !== "attached") return null;
    const finalTask = after.currentTask;
    if (finalTask === null
      || finalTask.taskId !== task.taskId
      || finalTask.taskRevision !== task.taskRevision
      || finalTask.status !== task.status) {
      return null;
    }
    return { taskId: task.taskId, status: task.status, accepted: task.status === "accepted" };
  } catch {
    return null;
  }
}

function visibilityFacts(current: AcceptanceVisibility | null): {
  state: string;
  reason: string | null;
} {
  if (current === null) return { state: "unknown", reason: null };
  return {
    state: current.state,
    reason: safeNullable(current.reason, 1024),
  };
}

function targetFacts(target: AcceptedInspectionTarget): Record<string, unknown> {
  return {
    state: target.state,
    taskId: target.taskId === null ? null : safeText(target.taskId, 128),
    taskRevision: target.taskRevision,
    status: target.status,
    accepted: target.accepted,
    historical: target.historical,
    reason: safeNullable(target.reason, 1024),
  };
}

const UNAVAILABLE_INSPECTION_TARGET: AcceptedInspectionTarget = {
  state: "unavailable",
  taskId: null,
  taskRevision: null,
  status: null,
  accepted: null,
  historical: null,
  reason: null,
};

/**
 * Add only the host-configured human-review capability facts to describe.
 * Submit/inspect result envelopes are deliberately unchanged.
 */
function withHumanReviewDescribe(
  result: DeliveryToolResult,
  configured: boolean,
): DeliveryToolResult {
  if (typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) {
    return result;
  }
  const details = result.details as Record<string, unknown>;
  if (details.action !== "describe") return result;
  const text = result.content.map((part) => part.text).join("\n");
  const suffix = `\nhumanReviewImplemented: true\nhumanReviewConfigured: ${configured}\nhumanReviewMode: ${configured ? "local-main-tui" : "unconfigured"}`;
  const nextText = `${text}${suffix}`;
  const boundedText = Buffer.byteLength(nextText, "utf8") <= MAX_DELIVERY_CONTENT_BYTES ? nextText : text;
  return {
    ...result,
    content: [{ type: "text", text: boundedText }],
    details: {
      ...details,
      humanReviewImplemented: true,
      humanReviewConfigured: configured,
      humanReviewMode: configured ? "local-main-tui" : "unconfigured",
    },
  };
}

function topTaskAccepted(current: AcceptanceVisibility | null): boolean | null {
  return current !== null && current.state === "visible" ? current.accepted : null;
}

function topCurrentTaskId(current: AcceptanceVisibility | null): string | null {
  return current !== null && current.state === "visible" ? current.taskId : null;
}

function topCurrentTaskStatus(current: AcceptanceVisibility | null): string | null {
  return current !== null && current.state === "visible" ? current.status : null;
}

function acceptanceFacts(
  selector: AcceptanceSelector,
  reference: AcceptanceReference | null,
  historyCommitted: boolean | null,
): Record<string, unknown> {
  return {
    historyCommitted,
    acceptanceId: reference === null ? null : safeText(reference.acceptanceId, 128),
    deliveryId: safeText(reference?.deliveryId ?? selector.deliveryId, 128),
    recordDigest: reference === null ? null : safeText(reference.recordDigest, 128),
    acceptedAt: reference === null ? null : safeText(reference.acceptedAt, 64),
  };
}

function hazardFacts(value: {
  task: { ownerId: string; taskId: string; taskRevision: number; requirementsDigest: string };
  acceptanceId: string;
  deliveryId: string;
  recordDigest: string;
  reason: string;
} | null | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return {
    task: {
      ownerId: safeText(value.task.ownerId, 128),
      taskId: safeText(value.task.taskId, 128),
      taskRevision: value.task.taskRevision,
      requirementsDigest: safeText(value.task.requirementsDigest, 256),
    },
    acceptanceId: safeText(value.acceptanceId, 128),
    deliveryId: safeText(value.deliveryId, 128),
    recordDigest: safeText(value.recordDigest, 128),
    reason: safeText(value.reason, 1024),
  };
}

function fileRows(files: AcceptedInspectionResult["delivery"]["files"]): Array<Record<string, unknown>> | null {
  if (files === null) return null;
  return files.map((file) => ({
    artifactId: file.artifactId,
    relativePath: file.relativePath,
    name: file.name,
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
  }));
}

function integrityFacts(inspection: AcceptedInspectionResult | null): Record<string, unknown> | null {
  if (inspection === null) return null;
  return {
    record: {
      state: inspection.record.state,
      digestMatches: inspection.record.digestMatches,
      bytes: inspection.record.bytes,
      reason: safeNullable(inspection.record.reason, 512),
    },
    delivery: {
      state: inspection.delivery.state,
      fileCount: inspection.delivery.fileCount,
      reason: safeNullable(inspection.delivery.reason, 512),
    },
    archive: {
      state: "not_checked",
      reason: "accepted inspection checks delivery copies under the frozen task identity; it does not reopen active-only execution archives",
    },
  };
}

function pathsFacts(
  inspection: AcceptedInspectionResult | null,
  available: boolean,
  withheldReason: string | null,
): { available: boolean; withheldReason: string | null } {
  if (available && inspection !== null && inspection.delivery.files !== null) {
    return { available: true, withheldReason: null };
  }
  return {
    available: false,
    withheldReason: safeNullable(
      withheldReason ?? inspection?.delivery.reason ?? inspection?.reason ?? "no checked accepted file path is available",
      1024,
    ),
  };
}

const MODEL_LIMITS = {
  maxContentBytes: MAX_DELIVERY_CONTENT_BYTES,
  maxEnvelopeBytes: MAX_DELIVERY_RESPONSE_BYTES,
  maxFiles: MAX_DELIVERY_ARTIFACTS,
  maxArtifactBytes: 256 * 1024,
};

function buildModelResult(facts: Record<string, unknown>, isError: boolean): DeliveryToolResult {
  const text = serializedModelJson(facts);
  if (Buffer.byteLength(text, "utf8") > MAX_DELIVERY_CONTENT_BYTES) {
    throw new DeliveryEntryError("The model-visible delivery facts exceeded the fixed 32 KiB content budget.");
  }
  let result: DeliveryToolResult = {
    content: [{ type: "text", text }],
    details: facts,
    ...(isError ? { isError: true } : {}),
  };
  if (responseBytes(result) > MAX_DELIVERY_RESPONSE_BYTES) {
    const compact = {
      format: DELIVERY_RESULT_FORMAT,
      action: facts.action,
      selectors: facts.selectors ?? null,
      operation: facts.operation ?? null,
      taskAccepted: facts.taskAccepted ?? null,
      currentTaskId: facts.currentTaskId ?? null,
      currentTaskStatus: facts.currentTaskStatus ?? null,
      visibility: facts.visibility ?? null,
      ...(facts.target === undefined ? {} : { target: facts.target }),
      acceptance: facts.acceptance ?? null,
      unknown: facts.unknown ?? null,
      paths: facts.paths ?? null,
      reason: facts.reason ?? null,
    };
    result = {
      content: [{ type: "text", text }],
      details: compact,
      ...(isError ? { isError: true } : {}),
    };
  }
  assertEntryResponseBound(result);
  return result;
}

function minimalFacts(
  action: "submit" | "inspect",
  selector: AcceptanceSelector | null,
  outcome: string,
  operation: Record<string, unknown>,
  current: AcceptanceVisibility | null,
  acceptance: Record<string, unknown>,
  reason: string | null,
  pathsWithheld: string,
  unknown: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    format: DELIVERY_RESULT_FORMAT,
    action,
    acceptanceImplemented: true,
    acceptanceConfigured: true,
    selectors: selector === null ? null : { ...selector },
    operation,
    outcome,
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    acceptance,
    integrity: null,
    unknown,
    files: null,
    manifest: null,
    requirements: null,
    paths: { available: false, withheldReason: safeText(pathsWithheld, 1024) },
    reason: safeNullable(reason, 2048),
    warnings: [],
    retryable: false,
    limits: MODEL_LIMITS,
  };
}

function fallbackSubmitFacts(
  selector: AcceptanceSelector,
  host: AcceptanceOperationResult,
  current: AcceptanceVisibility | null,
  reason: string,
  minimumReason: string,
): Record<string, unknown> {
  const reference = host.acceptance;
  return minimalFacts(
    "submit",
    selector,
    host.outcome,
    {
      performed: true,
      outcome: host.outcome,
      operationCommitted: host.operationCommitted,
      idempotent: host.idempotent === true,
      newCommit: host.operationCommitted === true && host.idempotent !== true,
    },
    current,
    acceptanceFacts(selector, reference, host.operationCommitted),
    reason,
    minimumReason,
    hazardFacts(host.unknown),
  );
}

function withheldAcceptanceResult(
  owner: TaskOwner,
  context: OmpToolContext,
  action: DeliveryAction,
  selector: AcceptanceSelector | null,
  acceptanceConfigured: boolean,
  reason: string,
  currentOverride?: AcceptanceVisibility | null,
  humanReviewConfigured = false,
): DeliveryToolResult {
  const visible = currentOverride === undefined ? visibleTaskFacts(owner, context) : null;
  const current: AcceptanceVisibility | null = currentOverride !== undefined
    ? currentOverride
    : visible === null
      ? null
      : {
          state: "visible",
          taskId: visible.taskId,
          status: visible.status as "active" | "cancelled" | "accepted",
          accepted: visible.accepted,
          reason: null,
        };
  const operation = action === "submit"
    ? {
        performed: false,
        outcome: "not_committed",
        operationCommitted: false,
        idempotent: false,
        newCommit: false,
      }
    : action === "request_review"
      ? {
          performed: false,
          outcome: "not_committed",
          operationCommitted: false,
          idempotent: false,
          newCommit: false,
        }
      : action === "inspect"
        ? { performed: false, readOnly: true, newCommit: false }
        : action === "preview"
          ? { performed: false, readOnly: false, newCommit: false }
          : { performed: false, readOnly: true, newCommit: false };
  const facts = {
    format: DELIVERY_RESULT_FORMAT,
    action,
    acceptanceImplemented: true,
    acceptanceConfigured,
    ...(action === "request_review"
      ? { humanReviewConfigured }
      : {}),
    selectors: selector === null ? null : { ...selector },
    operation,
    outcome: action === "submit" || action === "request_review"
      ? "not_committed"
      : action === "inspect"
        ? "not_inspected"
        : action === "preview"
          ? "not_previewed"
          : "not_described",
    ...(action === "request_review"
      ? { review: { state: "unavailable", reviewId: null, reason: safeText(reason, 1024) } }
      : {}),
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    ...(action === "inspect"
      ? { target: targetFacts({ ...UNAVAILABLE_INSPECTION_TARGET, reason: safeText(reason, 1024) }) }
      : {}),
    acceptance: selector === null
      ? null
      : acceptanceFacts(selector, null, null),
    integrity: null,
    unknown: null,
    files: null,
    manifest: null,
    requirements: null,
    paths: {
      available: false,
      withheldReason: safeText(
        acceptanceConfigured
          ? "the call was withheld before accepted history could be read"
          : "acceptance is not configured for this host; no submit or accepted-history read is available",
        1024,
      ),
    },
    reason: safeText(reason, 2048),
    warnings: [],
    retryable: false,
    limits: MODEL_LIMITS,
  };
  try {
    return buildModelResult(facts, true);
  } catch {
    return {
      content: [{
        type: "text",
        text: bounded(`agent_deliver ${action} withheld: ${safeText(reason, 2048)}`),
      }],
      details: {
        format: DELIVERY_RESULT_FORMAT,
        action,
        taskAccepted: topTaskAccepted(current),
        currentTaskStatus: topCurrentTaskStatus(current),
        ...(action === "inspect" ? { target: targetFacts(UNAVAILABLE_INSPECTION_TARGET) } : {}),
        acceptanceConfigured,
        withheld: true,
      },
      isError: true,
    };
  }
}

function requestedAction(params: unknown): DeliveryAction {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return "inspect";
  const action = (params as Record<string, unknown>).action;
  return action === "describe"
    || action === "preview"
    || action === "submit"
    || action === "inspect"
    || action === "request_review"
    ? action
    : "inspect";
}

function classifySubmitException(
  owner: TaskOwner,
  selector: AcceptanceSelector,
): { outcome: "committed" | "not_committed" | "unknown"; operationCommitted: boolean | null; acceptance: AcceptanceReference | null; reason: string } {
  try {
    const snapshot = owner.snapshot();
    if (snapshot.acceptanceHazard !== null) {
      return {
        outcome: "unknown",
        operationCommitted: null,
        acceptance: null,
        reason: "the host stores an unknown acceptance installation hazard",
      };
    }
    const task = snapshot.currentTask;
    if (task !== null
      && task.status === "accepted"
      && task.acceptance !== null
      && task.taskId === selector.expectedTaskId
      && task.taskRevision === selector.expectedTaskRevision
      && task.acceptance.deliveryId === selector.deliveryId) {
      return {
        outcome: "committed",
        operationCommitted: true,
        acceptance: { ...task.acceptance },
        reason: "the host owner proves this exact accepted selector; the call threw after the transaction fact was installed",
      };
    }
    return {
      outcome: "not_committed",
      operationCommitted: false,
      acceptance: null,
      reason: "the host owner stores no accepted fact or unknown installation for this selector",
    };
  } catch (error) {
    return {
      outcome: "unknown",
      operationCommitted: null,
      acceptance: null,
      reason: `the post-exception owner state could not be read: ${errorMessage(error)}`,
    };
  }
}

function submitFacts(
  host: AcceptanceOperationResult,
  selector: AcceptanceSelector,
  inspection: AcceptedInspectionResult | null,
  current: AcceptanceVisibility | null,
  pathsWithheldReason: string | null,
  extraWarnings: readonly string[],
): Record<string, unknown> {
  const filesAvailable = pathsWithheldReason === null
    && inspection !== null
    && inspection.acceptance !== null
    && current !== null
    && current.state === "visible"
    && inspection.delivery.state === "intact"
    && inspection.delivery.files !== null
    && inspection.delivery.files.length > 0;
  const files = filesAvailable ? fileRows(inspection.delivery.files) : null;
  const paths = pathsFacts(inspection, filesAvailable, pathsWithheldReason);
  return {
    format: DELIVERY_RESULT_FORMAT,
    action: "submit",
    acceptanceImplemented: true,
    acceptanceConfigured: true,
    selectors: { ...selector },
    operation: {
      performed: true,
      outcome: host.outcome,
      operationCommitted: host.operationCommitted,
      idempotent: host.idempotent === true,
      newCommit: host.operationCommitted === true && host.idempotent !== true,
    },
    outcome: host.outcome,
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    acceptance: acceptanceFacts(selector, host.acceptance, host.operationCommitted),
    integrity: integrityFacts(inspection),
    unknown: hazardFacts(host.unknown),
    files,
    manifest: filesAvailable ? inspection.delivery.manifest : null,
    requirements: filesAvailable ? inspection.delivery.requirements : null,
    paths,
    reason: safeNullable(host.reason, 2048),
    warnings: [...host.warnings, ...extraWarnings].slice(0, 20).map((warning) => safeText(warning, 512)),
    retryable: host.outcome === "not_committed"
      && current !== null
      && current.state === "visible"
      && current.status === "active",
    limits: MODEL_LIMITS,
  };
}

function inspectFacts(
  inspection: AcceptedInspectionResult,
  selector: AcceptanceSelector,
  current: AcceptanceVisibility,
  target: AcceptedInspectionTarget,
  pathsWithheldReason: string | null,
  extraWarnings: readonly string[],
): Record<string, unknown> {
  const historyCommitted = inspection.acceptance !== null
    ? true
    : inspection.record.state === "not_accepted" || inspection.delivery.state === "not_accepted"
      ? false
      : null;
  const filesAvailable = pathsWithheldReason === null
    && inspection.acceptance !== null
    && target.state === "visible"
    && inspection.delivery.state === "intact"
    && inspection.delivery.files !== null
    && inspection.delivery.files.length > 0;
  const files = filesAvailable ? fileRows(inspection.delivery.files) : null;
  return {
    format: DELIVERY_RESULT_FORMAT,
    action: "inspect",
    acceptanceImplemented: true,
    acceptanceConfigured: true,
    selectors: { ...selector },
    operation: {
      performed: false,
      readOnly: true,
      newCommit: false,
    },
    outcome: historyCommitted === true ? "accepted_history" : historyCommitted === false ? "not_accepted" : "unknown",
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    target: targetFacts(target),
    acceptance: acceptanceFacts(selector, inspection.acceptance, historyCommitted),
    integrity: integrityFacts(inspection),
    unknown: hazardFacts(inspection.unknown),
    files,
    manifest: filesAvailable ? inspection.delivery.manifest : null,
    requirements: filesAvailable ? inspection.delivery.requirements : null,
    paths: pathsFacts(inspection, filesAvailable, pathsWithheldReason),
    reason: safeNullable(inspection.reason, 2048),
    warnings: [...inspection.warnings, ...extraWarnings].slice(0, 20).map((warning) => safeText(warning, 512)),
    retryable: false,
    limits: MODEL_LIMITS,
  };
}

function requestReviewFacts(
  host: HumanReviewOperationResult,
  selector: AcceptanceSelector,
  inspection: AcceptedInspectionResult | null,
  current: AcceptanceVisibility | null,
  pathsWithheldReason: string | null,
  extraWarnings: readonly string[],
  humanReviewConfigured: boolean,
): Record<string, unknown> {
  const filesAvailable = pathsWithheldReason === null
    && inspection !== null
    && inspection.acceptance !== null
    && current !== null
    && current.state === "visible"
    && inspection.delivery.state === "intact"
    && inspection.delivery.files !== null
    && inspection.delivery.files.length > 0;
  const files = filesAvailable ? fileRows(inspection.delivery.files) : null;
  const reviewVisible = current !== null
    && current.state === "visible"
    && current.taskId === selector.expectedTaskId;
  return {
    format: DELIVERY_RESULT_FORMAT,
    action: "request_review",
    acceptanceImplemented: true,
    acceptanceConfigured: true,
    humanReviewConfigured,
    selectors: { ...selector },
    operation: {
      performed: true,
      outcome: host.operation.outcome,
      operationCommitted: host.operation.operationCommitted,
      idempotent: host.operation.idempotent === true,
      newCommit: host.operation.operationCommitted === true && host.operation.idempotent !== true,
    },
    outcome: host.operation.outcome,
    review: {
      state: host.review.state,
      reviewId: reviewVisible ? safeNullable(host.review.reviewId, 160) : null,
      reason: safeNullable(host.review.reason, 1024),
    },
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    acceptance: acceptanceFacts(selector, host.operation.acceptance, host.operation.operationCommitted),
    integrity: integrityFacts(inspection),
    unknown: hazardFacts(host.operation.unknown),
    files,
    manifest: filesAvailable ? inspection.delivery.manifest : null,
    requirements: filesAvailable ? inspection.delivery.requirements : null,
    paths: pathsFacts(inspection, filesAvailable, pathsWithheldReason),
    reason: safeNullable(host.operation.reason ?? host.review.reason, 2048),
    warnings: [...host.operation.warnings, ...extraWarnings].slice(0, 20).map((warning) => safeText(warning, 512)),
    // A human-review request is an explicit user interaction. Do not invite a
    // retry loop after rejection or cancellation.
    retryable: false,
    limits: MODEL_LIMITS,
  };
}

function reviewExceptionFacts(
  selector: AcceptanceSelector,
  classification: ReturnType<typeof classifySubmitException>,
  current: AcceptanceVisibility | null,
  reason: string,
  humanReviewConfigured: boolean,
): Record<string, unknown> {
  const state = classification.outcome === "committed"
    ? "committed"
    : classification.outcome === "unknown"
      ? "unknown"
      : "unavailable";
  return {
    format: DELIVERY_RESULT_FORMAT,
    action: "request_review",
    acceptanceImplemented: true,
    acceptanceConfigured: true,
    humanReviewConfigured,
    selectors: { ...selector },
    operation: {
      performed: true,
      outcome: classification.outcome,
      operationCommitted: classification.operationCommitted,
      idempotent: false,
      newCommit: false,
    },
    outcome: classification.outcome,
    review: { state, reviewId: null, reason: safeText(reason, 1024) },
    taskAccepted: topTaskAccepted(current),
    currentTaskId: topCurrentTaskId(current),
    currentTaskStatus: topCurrentTaskStatus(current),
    visibility: visibilityFacts(current),
    acceptance: acceptanceFacts(selector, classification.acceptance, classification.operationCommitted),
    integrity: null,
    unknown: classification.outcome === "unknown"
      ? {
        task: null,
        acceptanceId: null,
        deliveryId: safeText(selector.deliveryId, 128),
        recordDigest: null,
        reason: safeText(classification.reason, 1024),
      }
      : null,
    files: null,
    manifest: null,
    requirements: null,
    paths: {
      available: false,
      withheldReason: "the request_review call threw; no accepted file path was checked or claimed in this response",
    },
    reason: safeText(`${classification.reason}; review error: ${reason}`, 2048),
    warnings: ["the request_review call failed unexpectedly; no approval or not-committed claim is invented beyond the host owner facts"],
    retryable: false,
    limits: MODEL_LIMITS,
  };
}

async function collectInspection(
  acceptance: AcceptanceService,
  context: OmpToolContext,
  selector: AcceptanceSelector,
  signal: AbortSignal | undefined,
): Promise<{ inspection: AcceptedInspectionResult | null; warning: string | null }> {
  if (signal?.aborted) {
    return { inspection: null, warning: "the call was aborted before accepted file facts were read; paths are withheld" };
  }
  try {
    const inspection = await acceptance.inspect(context, selector);
    return { inspection, warning: null };
  } catch (error) {
    return {
      inspection: null,
      warning: `accepted file inspection failed after the operation; committed facts are retained: ${errorMessage(error)}`,
    };
  }
}

export function createDeliveryEntry(pi: DeliveryApi, options: DeliveryEntryOptions): DeliveryEntryControls {
  const owner = options.owner;
  const service = options.service;
  const acceptance = options.acceptance;
  const humanReviewConfigured = acceptance?.humanReviewConfigured() === true;
  if (currentTaskOwner() !== owner) {
    throw new DeliveryEntryError("The published task owner is not the owner this delivery entry was created for.");
  }
  let disposed = false;

  /**
   * Outermost current read after every awaited inspection. It performs no file
   * I/O and rechecks the actual entry, published owner, service and selector.
   * A null result never restores an older visible snapshot.
   */
  const finalCurrentVisibility = (
    context: OmpToolContext,
    selector: AcceptanceSelector,
  ): AcceptanceVisibility | null => {
    if (acceptance === undefined) return null;
    // This entry's own lifecycle is not owned by the acceptance service; a
    // standalone entry can be disposed while the shared acceptance service
    // remains live. Check the actual closure before any external context read
    // and again purely after it returns.
    if (disposed) return null;
    try {
      // The service itself proves entry/owner/disposal/snapshot state. Calling
      // it after a replacement yields unavailable rather than a guessed null;
      // only an unreadable result is null here.
      const current = acceptance.finalVisibility(context, selector.expectedTaskId, selector.expectedTaskRevision);
      return disposed ? null : current;
    } catch {
      return null;
    }
  };

  const finalInspectionVisibility = (
    context: OmpToolContext,
    selector: AcceptanceSelector,
  ): { target: AcceptedInspectionTarget; current: AcceptanceVisibility } | null => {
    if (acceptance === undefined) return null;
    if (disposed) return null;
    try {
      const final = acceptance.finalInspectionVisibility(context, selector);
      return disposed ? null : final;
    } catch {
      return null;
    }
  };

  const executeReview = async (
    selector: AcceptanceSelector,
    signal: AbortSignal | undefined,
    context: OmpToolContext,
  ): Promise<DeliveryToolResult> => {
    if (acceptance === undefined) {
      return withheldAcceptanceResult(
        owner,
        context,
        "request_review",
        selector,
        false,
        "the host did not configure an acceptance root; local human review is unavailable",
      );
    }
    let host: HumanReviewOperationResult;
    try {
      host = await acceptance.requestHumanReview(context, selector, signal);
    } catch (error) {
      const classified = classifySubmitException(owner, selector);
      return buildModelResult(reviewExceptionFacts(selector, classified, null, errorMessage(error), humanReviewConfigured), true);
    }

    let inspection: AcceptedInspectionResult | null = null;
    let inspectionWarning: string | null = null;
    let pathsWithheldReason: string | null = null;
    if (host.operation.outcome === "committed") {
      if (signal?.aborted) {
        pathsWithheldReason = "the call was aborted after the commit; committed facts are retained and no path was read";
      } else if (host.operation.current.state !== "visible") {
        pathsWithheldReason = `the current target is not visible (${host.operation.current.state}); committed facts are retained and no path was read`;
      } else if (currentTaskOwner() !== owner) {
        pathsWithheldReason = "the published owner changed after the commit; committed facts are retained and no path is shown";
      } else {
        const collected = await collectInspection(acceptance, context, selector, signal);
        inspection = collected.inspection;
        inspectionWarning = collected.warning;
        if (inspection !== null && currentTaskOwner() !== owner) {
          inspectionWarning = "the published owner changed after accepted file inspection; no path is shown";
        } else if (inspection !== null && signal?.aborted) {
          inspectionWarning = "the call was aborted after accepted file inspection; no path is shown";
        }
      }
    } else {
      pathsWithheldReason = host.operation.outcome === "unknown"
        ? "the acceptance installation outcome is unknown; no blind retry or file path is claimed"
        : host.operation.reason ?? host.review.reason ?? "the review did not commit; no accepted file path exists for this response";
    }

    const current = finalCurrentVisibility(context, selector);
    if (host.operation.outcome === "committed") {
      if (current === null) {
        pathsWithheldReason = "the delivery entry, published owner or acceptance service changed after the commit; committed facts are retained and no path is shown";
      } else if (current.state !== "visible") {
        pathsWithheldReason = `the current target is not visible (${current.state})${current.reason === null ? "" : `: ${current.reason}`}; committed facts are retained and no path is shown`;
      } else if (signal?.aborted) {
        pathsWithheldReason = "the call was aborted after accepted files were checked; committed facts are retained and no path is shown";
      } else if (inspection === null) {
        pathsWithheldReason = inspectionWarning ?? "no accepted file path was checked for this response";
      } else if (inspection.acceptance === null
        || inspection.delivery.state !== "intact"
        || inspection.delivery.files === null) {
        pathsWithheldReason = inspection.delivery.reason
          ?? "the accepted delivery files could not be proven intact; no path is shown as available";
      }
    }

    const extraWarnings = [
      ...(inspectionWarning === null ? [] : [inspectionWarning]),
      ...(inspection !== null && inspection.record.state !== "intact"
        ? ["the historical acceptance record is not intact; the committed acceptance fact is retained separately"]
        : []),
    ];
    try {
      return buildModelResult(
        requestReviewFacts(host, selector, inspection, current, pathsWithheldReason, extraWarnings, humanReviewConfigured),
        host.operation.outcome !== "committed",
      );
    } catch (error) {
      const fallbackReason = `the review response could not be formatted: ${errorMessage(error)}`;
      return buildModelResult(
        {
          ...requestReviewFacts(host, selector, null, current, fallbackReason, extraWarnings, humanReviewConfigured),
          files: null,
          manifest: null,
          requirements: null,
          paths: {
            available: false,
            withheldReason: "the response was degraded; no accepted path was checked or claimed",
          },
        },
        host.operation.outcome !== "committed",
      );
    }
  };

  const executeAcceptance = async (
    action: AcceptanceAction,
    selector: AcceptanceSelector,
    signal: AbortSignal | undefined,
    context: OmpToolContext,
  ): Promise<DeliveryToolResult> => {
    if (acceptance === undefined) {
      return withheldAcceptanceResult(
        owner,
        context,
        action,
        selector,
        false,
        action === "request_review"
          ? "the host did not configure an acceptance root; local human review is unavailable"
          : "the host did not configure an acceptance root; submit and accepted-history inspect are not enabled",
        undefined,
        humanReviewConfigured,
      );
    }
    if (action === "request_review") {
      return executeReview(selector, signal, context);
    }
    if (action === "inspect") {
      const collected = await collectInspection(acceptance, context, selector, signal);
      if (collected.inspection === null) {
        return withheldAcceptanceResult(
          owner,
          context,
          "inspect",
          selector,
          true,
          collected.warning ?? "accepted history could not be read",
        );
      }
      const final = finalInspectionVisibility(context, selector);
      if (final === null) {
        return withheldAcceptanceResult(
          owner,
          context,
          "inspect",
          selector,
          true,
          "accepted history was collected but the delivery entry, published owner or acceptance service can no longer be proven; no path is claimed",
          null,
        );
      }
      const current = final.current;
      if (current.state === "unknown" && collected.inspection.unknown !== undefined) {
        // An authorized unknown installation is an original operation fact.
        // Keep it explicit, but never expose a path or current acceptance.
        return buildModelResult(
          inspectFacts(
            collected.inspection,
            selector,
            current,
            final.target,
            final.target.reason ?? current.reason ?? "the acceptance installation outcome is unknown; no path is claimed",
            [],
          ),
          true,
        );
      }
      if (final.target.state !== "visible" || collected.inspection.target.state !== "visible") {
        // The selector-selected retained target lost its own final eligibility
        // or the service refused the exact match. Withhold the prior record,
        // acceptance identity and paths; never substitute current for history.
        return withheldAcceptanceResult(
          owner,
          context,
          "inspect",
          selector,
          true,
          collected.inspection.reason
            ?? final.target.reason
            ?? current.reason
            ?? `the retained target is not visible (${final.target.state}); accepted history is withheld`,
          current,
        );
      }
      const pathsWithheldReason = signal?.aborted
        ? "the call was aborted after accepted files were checked; history is retained and no path is shown"
        : null;
      return buildModelResult(
        inspectFacts(collected.inspection, selector, current, final.target, pathsWithheldReason, []),
        collected.inspection.unknown !== undefined
          || collected.inspection.record.state === "unknown"
          || collected.inspection.delivery.state === "unknown",
      );
    }

    let host: AcceptanceOperationResult;
    try {
      host = await acceptance.submit(context, selector, signal);
    } catch (error) {
      const classified = classifySubmitException(owner, selector);
      const facts = {
        format: DELIVERY_RESULT_FORMAT,
        action: "submit",
        acceptanceImplemented: true,
        acceptanceConfigured: true,
        selectors: { ...selector },
        operation: {
          performed: true,
          outcome: classified.outcome,
          operationCommitted: classified.operationCommitted,
          idempotent: false,
          newCommit: false,
        },
        outcome: classified.outcome,
        taskAccepted: null,
        currentTaskId: null,
        currentTaskStatus: null,
        visibility: { state: "unknown", reason: safeText(classified.reason, 1024) },
        acceptance: acceptanceFacts(selector, classified.acceptance, classified.operationCommitted),
        integrity: null,
        files: null,
        manifest: null,
        requirements: null,
        paths: {
          available: false,
          withheldReason: "the submit call threw; no accepted file path was checked or claimed in this response",
        },
        reason: safeText(`${classified.reason}; submit error: ${errorMessage(error)}`, 2048),
        warnings: ["the submit call failed unexpectedly; no not-committed claim is invented beyond the host owner facts"],
        retryable: false,
        limits: MODEL_LIMITS,
      };
      try {
        return buildModelResult(facts, true);
      } catch {
        return buildModelResult(
          minimalFacts(
            "submit",
            selector,
            classified.outcome,
            facts.operation as Record<string, unknown>,
            null,
            acceptanceFacts(selector, classified.acceptance, classified.operationCommitted),
            facts.reason as string,
            "the response was degraded to a minimum truthful envelope; no path was checked",
          ),
          true,
        );
      }
    }

    let inspection: AcceptedInspectionResult | null = null;
    let inspectionWarning: string | null = null;
    let pathsWithheldReason: string | null = null;
    if (host.outcome === "committed") {
      if (signal?.aborted) {
        pathsWithheldReason = "the call was aborted after the commit; committed facts are retained and no path was read";
      } else if (host.current.state !== "visible") {
        pathsWithheldReason = `the current target is not visible (${host.current.state}); committed facts are retained and no path was read`;
      } else if (currentTaskOwner() !== owner) {
        pathsWithheldReason = "the published owner changed after the commit; committed facts are retained and no path is shown";
      } else {
        const collected = await collectInspection(acceptance, context, selector, signal);
        inspection = collected.inspection;
        inspectionWarning = collected.warning;
        if (inspection !== null && currentTaskOwner() !== owner) {
          inspectionWarning = "the published owner changed after accepted file inspection; no path is shown";
        } else if (inspection !== null && signal?.aborted) {
          inspectionWarning = "the call was aborted after accepted file inspection; no path is shown";
        }
      }
    } else {
      pathsWithheldReason = host.outcome === "unknown"
        ? "the acceptance installation outcome is unknown; no blind retry or file path is claimed"
        : host.reason ?? "the submit was not committed; no accepted file path exists for this response";
    }

    // The last awaited boundary has passed. Project current visibility and any
    // paths only from this fresh guard; a stale host/inspection snapshot must
    // never be restored for a replacement owner, detached context, disposal or
    // unknown acceptance state.
    const current = finalCurrentVisibility(context, selector);
    if (host.outcome === "committed") {
      if (current === null) {
        pathsWithheldReason = "the delivery entry, published owner or acceptance service changed after the commit; committed facts are retained and no path is shown";
      } else if (current.state !== "visible") {
        pathsWithheldReason = `the current target is not visible (${current.state})${current.reason === null ? "" : `: ${current.reason}`}; committed facts are retained and no path is shown`;
      } else if (signal?.aborted) {
        pathsWithheldReason = "the call was aborted after accepted files were checked; committed facts are retained and no path is shown";
      } else if (inspection === null) {
        pathsWithheldReason = inspectionWarning
          ?? "no accepted file path was checked for this response";
      } else if (inspection.acceptance === null
        || inspection.delivery.state !== "intact"
        || inspection.delivery.files === null) {
        pathsWithheldReason = inspection.delivery.reason
          ?? "the accepted delivery files could not be proven intact; no path is shown as available";
      }
    }

    const extraWarnings = [
      ...(inspectionWarning === null ? [] : [inspectionWarning]),
      ...(inspection !== null && inspection.record.state !== "intact"
        ? ["the historical acceptance record is not intact; the committed acceptance fact is retained separately"]
        : []),
    ];
    try {
      return buildModelResult(
        submitFacts(host, selector, inspection, current, pathsWithheldReason, extraWarnings),
        host.outcome !== "committed",
      );
    } catch (error) {
      const fallbackReason = `the committed response could not be formatted: ${errorMessage(error)}`;
      try {
        return buildModelResult(
          fallbackSubmitFacts(selector, host, current, fallbackReason, "the response was degraded; no path was checked or claimed in this envelope"),
          host.outcome !== "committed",
        );
      } catch {
        return buildModelResult(
          minimalFacts(
            "submit",
            selector,
            host.outcome,
            {
              performed: true,
              outcome: host.outcome,
              operationCommitted: host.operationCommitted,
              idempotent: host.idempotent === true,
              newCommit: host.operationCommitted === true && host.idempotent !== true,
            },
            current,
            acceptanceFacts(selector, host.acceptance, host.operationCommitted),
            "the response was degraded to a minimum truthful envelope",
            "no path was checked or claimed in this minimum envelope",
          ),
          host.outcome !== "committed",
        );
      }
    }
  };

  const tool: DeliveryTool = {
    name: DELIVERY_TOOL,
    label: "Candidate delivery, submit and accepted history",
    description: deliveryDescription(humanReviewConfigured),
    parameters: deliveryParameters(humanReviewConfigured),
    approval: "write",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (disposed) {
        return withheldAcceptanceResult(
          owner,
          context,
          "inspect",
          null,
          acceptance !== undefined,
          "the delivery entry is disposed; no file was created or read",
          null,
        );
      }
      if (currentTaskOwner() !== owner) {
        return withheldAcceptanceResult(
          owner,
          context,
          "inspect",
          null,
          acceptance !== undefined,
          "the managed task owner changed; this delivery entry can no longer act",
        );
      }
      let parsed: DeliveryArguments;
      try {
        parsed = parseDeliveryArguments(params);
      } catch (error) {
        return withheldAcceptanceResult(
          owner,
          context,
          requestedAction(params),
          null,
          acceptance !== undefined,
          errorMessage(error),
          undefined,
          humanReviewConfigured,
        );
      }
      try {
        if (parsed.action === "describe") {
          const described = withHumanReviewDescribe(service.describe(context), humanReviewConfigured);
          assertEntryResponseBound(described);
          return described;
        }
        if (parsed.action === "submit" || parsed.action === "inspect" || parsed.action === "request_review") {
          return await executeAcceptance(parsed.action, parsed.request, signal, context);
        }
        if (signal?.aborted) {
          return withheldAcceptanceResult(
            owner,
            context,
            "preview",
            null,
            acceptance !== undefined,
            "the call was aborted before the delivery service acted; no file was created",
          );
        }
        const outcome = await service.preview(context, parsed.request, signal);
        if (signal?.aborted) {
          return withheldAcceptanceResult(
            owner,
            context,
            "preview",
            null,
            acceptance !== undefined,
            "the call was aborted before the delivery response became visible; no path or preview text is shown",
          );
        }
        if (outcome.task !== undefined) {
          // Last synchronous authority read before assembling the visible
          // response. A changed task hides the old paths and preview text in
          // both content and details.
          const guard = service.finalGuard(context, outcome.task);
          if (guard !== null) {
            return withheldAcceptanceResult(
              owner,
              context,
              "preview",
              null,
              acceptance !== undefined,
              `preview was withheld: ${guard}`,
            );
          }
        }
        if (signal?.aborted) {
          return withheldAcceptanceResult(
            owner,
            context,
            "preview",
            null,
            acceptance !== undefined,
            "the call was aborted before the delivery response became visible; no path or preview text is shown",
          );
        }
        assertEntryResponseBound(outcome.result);
        return outcome.result;
      } catch (error) {
        try {
          process.stderr.write(`${JSON.stringify({
            type: "omp_agent_delivery",
            message: "tool_failed",
            error: errorMessage(error).slice(0, 1000),
          })}\n`);
        } catch {
          // A diagnostic channel is not guaranteed.
        }
        return withheldAcceptanceResult(
          owner,
          context,
          parsed.action,
          parsed.action === "submit" || parsed.action === "inspect" || parsed.action === "request_review"
            ? parsed.request
            : null,
          acceptance !== undefined,
          "delivery was withheld because the current context or files could not be proven",
          undefined,
          humanReviewConfigured,
        );
      }
    },
  };

  try {
    pi.registerTool(tool);
  } catch (error) {
    disposed = true;
    service.dispose();
    throw error;
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      service.dispose();
    },
  };
}

export { DELIVERY_BUNDLE_VERSION };
