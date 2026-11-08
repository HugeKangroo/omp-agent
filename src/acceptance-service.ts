import { createHash, randomUUID } from "node:crypto";
import type { ExecutionActivitySnapshot } from "./execution-adapter.ts";
import {
  type AcceptanceContractEvidence,
  type AcceptanceEvidence,
  type AcceptanceEvidenceToken,
  type DeliveryService,
  sealAcceptanceEvidenceTokenSync,
} from "./delivery-service.ts";
import {
  HUMAN_REVIEW_INTERACTION_SOURCE,
  HUMAN_REVIEW_POLICY_VERSION,
  HUMAN_REVIEW_RECORD_VERSION,
  REVIEW_DEADLINE_MS,
  type AcceptanceRecordV2,
  HumanReviewError,
  type HumanReviewAdmission,
  type HumanReviewOperationReview,
  type HumanReviewOption,
  type HumanReviewPresentation,
  type HumanReviewReceiptV1,
  type HumanReviewState,
  type HumanReviewTransportResult,
  humanReviewDeadlineAt,
  humanReviewDeadlineReached,
  humanReviewDigest,
  isCanonicalHumanReviewTime,
  isHumanReviewIdentifier,
} from "./human-review-types.ts";
import {
  evaluateHumanReviewEvidence,
  humanReviewBindingOf,
  humanReviewDisplayOf,
  humanReviewRequirementRevisions,
  validateHumanReviewRecordV2,
} from "./human-review-policy.ts";
import { presentLocalHumanReview } from "./human-review-ui.ts";
import type { FrozenTaskRef } from "./execution-candidates.ts";
import {
  ACCEPTANCE_RECORD_POLICY_SOURCE,
  ACCEPTANCE_RECORD_VERSION,
  MAX_ACCEPTANCE_RECORD_BYTES,
  type AcceptanceRecordRead,
  type AcceptanceRecordStorePort,
  type AcceptanceRoot,
} from "./acceptance-record-store.ts";
import { currentTaskOwner, subjectFromContext, type OmpToolContext } from "./task-entry-port.ts";
import { parseBranch } from "./task-branch.ts";
import {
  type AcceptanceHazardFacts,
  type AcceptanceReference,
  type AcceptanceReservationToken,
  type ManagedTask,
  type TaskOwner,
  type TaskSubject,
} from "./task-owner.ts";
import { requirementsDigest } from "./task-requirements.ts";

/**
 * G2-B2-B1 host acceptance coordinator.
 *
 * It consumes an existing frozen delivery whose immutable contract and current
 * verification receipt both pass. It reserves owner acceptance synchronously,
 * re-reads actual evidence, prepares a bounded host record, performs a final
 * synchronous evidence seal and delegates the fixed installation to the owner.
 * It exposes no model tool, no arbitrary path, verdict, digest or confirmation.
 */

export const ACCEPTANCE_SERVICE_VERSION = "0.1.0-g2b2b1.0";
export const MAX_ACCEPTANCE_RESPONSE_BYTES = 64 * 1024;
export const MAX_ACCEPTANCE_WARNINGS = 16;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SELECTOR_KEYS = new Set(["expectedTaskId", "expectedTaskRevision", "deliveryId"]);
const REVIEW_INVALIDATION_EVENTS = new Set([
  "task_revised",
  "task_cancelled",
  "task_binding_detached",
  "task_session_started",
  "task_started",
  "task_accepted",
  "task_owner_suspended",
  "task_owner_overlap_rejected",
]);

export class AcceptanceServiceError extends Error {
  override name = "AcceptanceServiceError";
}

export type AcceptanceOutcome = "not_committed" | "committed" | "unknown";

export interface AcceptanceSelector {
  expectedTaskId: string;
  expectedTaskRevision: number;
  deliveryId: string;
}

export interface AcceptanceVisibility {
  state: "visible" | "detached" | "changed" | "unavailable" | "unknown";
  taskId: string | null;
  status: "active" | "cancelled" | "accepted" | null;
  accepted: boolean | null;
  reason: string | null;
}

export interface AcceptanceOperationResult {
  outcome: AcceptanceOutcome;
  operationCommitted: boolean | null;
  /** True only when this call reused the exact already-committed selector. */
  idempotent: boolean;
  taskAccepted: boolean | null;
  acceptance: AcceptanceReference | null;
  warnings: string[];
  reason: string | null;
  current: AcceptanceVisibility;
  /** Defensive host facts when the installation outcome is unknown. */
  unknown?: AcceptanceHazardFacts | null;
}

/** Internal draft; the public boundary always normalizes an explicit boolean. */
type AcceptanceOperationDraft = Omit<AcceptanceOperationResult, "idempotent"> & {
  idempotent?: boolean;
};

export interface AcceptedInspectionFile {
  artifactId: string;
  relativePath: string;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface AcceptedInspectionResult {
  acceptance: AcceptanceReference | null;
  record: {
    state: AcceptanceRecordRead["state"] | "not_accepted" | "unknown";
    digestMatches: boolean | null;
    bytes: number | null;
    reason: string | null;
  };
  delivery: {
    state: "intact" | "changed" | "unavailable" | "not_accepted" | "unknown";
    fileCount: number | null;
    files: AcceptedInspectionFile[] | null;
    manifest: { path: string; bytes: number; sha256: string } | null;
    requirements: { path: string; bytes: number; sha256: string } | null;
    reason: string | null;
  };
  warnings: string[];
  reason: string | null;
  current: AcceptanceVisibility;
  /** Defensive host facts when the installation outcome is unknown. */
  unknown?: AcceptanceHazardFacts | null;
}

export interface AcceptanceServiceOptions {
  owner: TaskOwner;
  delivery: DeliveryService;
  activity: () => ExecutionActivitySnapshot;
  acceptanceRoot: string;
  executionRoot: string;
  /** Host-only, default-off human/hybrid review capability. */
  humanReview?: HumanReviewOption;
  now?: () => string;
  id?: () => string;
  diagnostic?: (message: string, details?: Record<string, unknown>) => void;
}

interface PendingHumanReview {
  reviewId: string;
  capability: object;
  selector: AcceptanceSelector;
  expected: FrozenTaskRef;
  issuedAt: string;
  expiresAt: string;
  startedMonotonic: number;
  phase: "preparing" | "presenting" | "approved_pending_recheck";
  consumed: boolean;
  controller: AbortController;
  abort: { state: HumanReviewState; reason: string } | null;
}

function pendingAbortOf(pending: PendingHumanReview): PendingHumanReview["abort"] {
  return pending.abort;
}

export interface HumanReviewOperationResult {
  operation: AcceptanceOperationResult;
  review: HumanReviewOperationReview;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AcceptanceServiceError(`${label} must be a valid identifier.`);
  }
  return value;
}

function parseSelector(value: unknown): AcceptanceSelector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcceptanceServiceError("Acceptance selector must be an object.");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !SELECTOR_KEYS.has(key));
  if (unknown.length > 0) {
    throw new AcceptanceServiceError(
      `Acceptance selector has ${unknown.length} unsupported field(s); only expectedTaskId, expectedTaskRevision and deliveryId are accepted.`,
    );
  }
  const expectedTaskId = identifier(record.expectedTaskId, "expectedTaskId");
  const expectedTaskRevision = record.expectedTaskRevision;
  if (typeof expectedTaskRevision !== "number" || !Number.isSafeInteger(expectedTaskRevision) || expectedTaskRevision <= 0) {
    throw new AcceptanceServiceError("expectedTaskRevision must be a positive integer.");
  }
  const deliveryId = identifier(record.deliveryId, "deliveryId");
  return { expectedTaskId, expectedTaskRevision, deliveryId };
}

function parseHumanReviewOption(value: HumanReviewOption | undefined): boolean {
  if (value === undefined || value === false) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcceptanceServiceError("humanReview must be false or an explicit local-main-tui host option.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("policyVersion")) {
    throw new AcceptanceServiceError("humanReview has unsupported fields; only kind and policyVersion are accepted.");
  }
  if (value.kind !== "local-main-tui" || value.policyVersion !== 1) {
    throw new AcceptanceServiceError("humanReview must be {kind:'local-main-tui', policyVersion:1}.");
  }
  return true;
}

function frozenOf(task: ManagedTask): FrozenTaskRef {
  return {
    ownerId: task.ownerId,
    taskId: task.taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: requirementsDigest(task.requirementSources),
  };
}

function sameFrozen(left: FrozenTaskRef, right: FrozenTaskRef): boolean {
  return left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest === right.requirementsDigest;
}

function copyReference(value: AcceptanceReference): AcceptanceReference {
  return { ...value };
}

function sortedByArtifact(rows: ReadonlyArray<{ artifactId: string }>): Array<{ artifactId: string }> {
  return [...rows].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Private bounded snapshot: never aliases caller-visible evidence objects. */
function privateDeepFreeze<T>(value: T): T {
  const copy = structuredClone(value) as T;
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    Object.freeze(item);
    for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
  };
  freeze(copy);
  return copy;
}

function privateEvidence(value: AcceptanceEvidence): AcceptanceEvidence {
  return privateDeepFreeze(value);
}

function privatePresentation(value: HumanReviewPresentation): HumanReviewPresentation {
  return privateDeepFreeze(value);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 3) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}...`;
}

function safeDiagnostic(value: unknown, maxBytes: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : String(value);
  } catch {
    text = "diagnostic text unavailable";
  }
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  const redacted = clean.replace(
    /\/(?:Users|home|private|tmp|var|opt|usr|Library|Applications)\/[^\s:;"',)]*/g,
    "<host-path>",
  );
  return truncateUtf8(redacted, maxBytes);
}

function responseBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function boundedVisibility(value: AcceptanceVisibility): AcceptanceVisibility {
  return {
    ...value,
    taskId: value.taskId === null ? null : safeDiagnostic(value.taskId, 128),
    reason: value.reason === null ? null : safeDiagnostic(value.reason, 512),
  };
}

function boundedHazard(value: AcceptanceHazardFacts | null | undefined): AcceptanceHazardFacts | null {
  if (value === null || value === undefined) return null;
  return {
    task: {
      ownerId: safeDiagnostic(value.task.ownerId, 128),
      taskId: safeDiagnostic(value.task.taskId, 128),
      taskRevision: Number.isSafeInteger(value.task.taskRevision) ? value.task.taskRevision : 0,
      requirementsDigest: safeDiagnostic(value.task.requirementsDigest, 200),
    },
    acceptanceId: safeDiagnostic(value.acceptanceId, 128),
    deliveryId: safeDiagnostic(value.deliveryId, 128),
    recordDigest: safeDiagnostic(value.recordDigest, 80),
    reason: safeDiagnostic(value.reason, 512),
  };
}

function boundOperationResult(result: AcceptanceOperationDraft): AcceptanceOperationResult {
  const normalized: AcceptanceOperationResult = {
    ...result,
    idempotent: result.idempotent === true,
  };
  normalized.warnings = normalized.warnings.slice(0, MAX_ACCEPTANCE_WARNINGS).map((warning) => safeDiagnostic(warning, 256));
  normalized.reason = normalized.reason === null ? null : safeDiagnostic(normalized.reason, 1024);
  normalized.current = boundedVisibility(normalized.current);
  if ("unknown" in normalized) normalized.unknown = boundedHazard(normalized.unknown);
  if (responseBytes(normalized) <= MAX_ACCEPTANCE_RESPONSE_BYTES) return normalized;
  normalized.warnings = [];
  normalized.reason = null;
  normalized.current = boundedVisibility({ ...normalized.current, reason: "current visibility diagnostic omitted for the response budget" });
  if ("unknown" in normalized && normalized.unknown !== null && normalized.unknown !== undefined) {
    normalized.unknown = { ...normalized.unknown, reason: "unknown-installation diagnostic omitted for the response budget" };
  }
  if (responseBytes(normalized) > MAX_ACCEPTANCE_RESPONSE_BYTES) {
    normalized.current = { state: "unavailable", taskId: null, status: null, accepted: null, reason: null };
  }
  if (responseBytes(normalized) > MAX_ACCEPTANCE_RESPONSE_BYTES) {
    throw new AcceptanceServiceError("The acceptance operation result exceeded its hard 64 KiB response budget after optional diagnostics were removed.");
  }
  return normalized;
}

function boundInspectionResult(result: AcceptedInspectionResult): AcceptedInspectionResult {
  result.warnings = result.warnings.slice(0, MAX_ACCEPTANCE_WARNINGS).map((warning) => safeDiagnostic(warning, 256));
  result.reason = result.reason === null ? null : safeDiagnostic(result.reason, 1024);
  result.record.reason = result.record.reason === null ? null : safeDiagnostic(result.record.reason, 512);
  result.delivery.reason = result.delivery.reason === null ? null : safeDiagnostic(result.delivery.reason, 512);
  result.current = boundedVisibility(result.current);
  if ("unknown" in result) result.unknown = boundedHazard(result.unknown);
  if (responseBytes(result) <= MAX_ACCEPTANCE_RESPONSE_BYTES) return result;
  result.warnings = [];
  result.reason = null;
  result.record.reason = null;
  result.delivery.reason = null;
  result.current = boundedVisibility({ ...result.current, reason: "current visibility diagnostic omitted for the response budget" });
  if ("unknown" in result && result.unknown !== null && result.unknown !== undefined) {
    result.unknown = { ...result.unknown, reason: "unknown-installation diagnostic omitted for the response budget" };
  }
  if (responseBytes(result) > MAX_ACCEPTANCE_RESPONSE_BYTES) {
    result.current = { state: "unavailable", taskId: null, status: null, accepted: null, reason: null };
  }
  if (responseBytes(result) > MAX_ACCEPTANCE_RESPONSE_BYTES) {
    result.delivery = {
      ...result.delivery,
      files: null,
      manifest: null,
      requirements: null,
      reason: "checked file facts were omitted for the response budget; no path is claimed",
    };
  }
  if (responseBytes(result) > MAX_ACCEPTANCE_RESPONSE_BYTES) {
    throw new AcceptanceServiceError("The acceptance inspection result exceeded its hard 64 KiB response budget after optional diagnostics were removed.");
  }
  return result;
}

export class AcceptanceService {
  private readonly owner: TaskOwner;
  private readonly delivery: DeliveryService;
  private readonly activity: () => ExecutionActivitySnapshot;
  /** The actual owner's port, captured once before any await or file action. */
  private readonly store: AcceptanceRecordStorePort;
  private readonly root: AcceptanceRoot;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly diagnostic: (message: string, details?: Record<string, unknown>) => void;
  private readonly humanReviewEnabled: boolean;
  private pendingReview: PendingHumanReview | null = null;
  private disposed = false;

  constructor(options: AcceptanceServiceOptions) {
    if (currentTaskOwner() !== options.owner) {
      throw new AcceptanceServiceError("The acceptance service must use the published task owner.");
    }
    this.owner = options.owner;
    this.delivery = options.delivery;
    this.activity = options.activity;
    // Capture the owner's immutable port once. No caller-supplied port is
    // accepted, and no owner getter is consulted later around the commit.
    this.store = options.owner.acceptanceRecordStore();
    this.root = this.store.resolveRoot(
      options.acceptanceRoot,
      options.executionRoot,
      options.delivery.deliveryRootPath(),
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.id ?? (() => randomUUID());
    this.humanReviewEnabled = parseHumanReviewOption(options.humanReview);
    this.diagnostic = options.diagnostic ?? ((message, details) => {
      try {
        process.stderr.write(`${JSON.stringify({ type: "omp_agent_acceptance", message, ...(details === undefined ? {} : { details }) })}\n`);
      } catch {
        // A diagnostic channel is not guaranteed.
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortPendingReview("cancelled", "the acceptance service is disposed");
  }

  /** Host-only capability projection; never model-visible authority. */
  humanReviewConfigured(): boolean {
    return this.humanReviewEnabled;
  }

  private abortPendingReview(state: HumanReviewState, reason: string): void {
    const pending = this.pendingReview;
    if (pending === null || pending.abort !== null) return;
    pending.abort = { state, reason };
    pending.controller.abort();
  }

  private humanReviewContext(context: OmpToolContext): boolean {
    return context.agent?.kind === "main" && context.mode === "tui" && context.hasUI === true;
  }

  private reviewElapsed(pending: PendingHumanReview): boolean {
    return humanReviewDeadlineReached(pending.startedMonotonic, performance.now());
  }

  private reviewNotCommitted(
    context: OmpToolContext,
    state: HumanReviewState,
    reviewId: string | null,
    reason: string,
    warnings: readonly string[] = [],
  ): HumanReviewOperationResult {
    // External context getters run first. The accepted flag, identity and
    // review id are projected only through the post-getter recheck; an owner
    // replacement, disposal or task change must not leak an earlier fact.
    const projection = this.humanReviewProjection(context, reviewId);
    const operation: AcceptanceOperationDraft = {
      outcome: "not_committed",
      operationCommitted: false,
      taskAccepted: projection.current.accepted,
      acceptance: null,
      warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
      reason,
      current: projection.current,
    };
    return {
      operation: boundOperationResult(operation),
      review: {
        state,
        reviewId: projection.reviewVisible ? reviewId : null,
        reason: safeDiagnostic(reason, 1024),
      },
    };
  }

  /**
   * Human-review response projection. It runs the external context getters
   * once (inside visibility) and then unconditionally rechecks the actual
   * in-process state with pure guards, including after visibility early
   * returns. A getter that replaces the published owner, disposes this service
   * or replaces the current task must never leave the pre-getter identity,
   * status or accepted flag in a human projection. No external getter is read
   * again here.
   */
  private humanReviewProjection(
    context: OmpToolContext,
    reviewId: string | null,
  ): { current: AcceptanceVisibility; reviewVisible: boolean } {
    const current = this.visibility(context);
    const stale = this.staleAfterGetters();
    if (stale !== null) return { current: stale, reviewVisible: false };
    const finalSnapshot = this.owner.snapshot();
    const task = finalSnapshot.currentTask;
    if (task === null) {
      return { current: this.hazardUnavailable("no current managed task exists"), reviewVisible: false };
    }
    if (finalSnapshot.acceptanceHazard !== null && current.state !== "unknown") {
      return {
        current: this.hazardUnavailable("the acceptance installation state changed while it was checked"),
        reviewVisible: false,
      };
    }
    if (current.taskId !== null && (current.taskId !== task.taskId || current.status !== task.status)) {
      return {
        current: this.hazardUnavailable("the current managed task changed while it was checked"),
        reviewVisible: false,
      };
    }
    const pending = this.pendingReview;
    const reviewVisible = reviewId !== null
      && pending !== null
      && pending.reviewId === reviewId
      && (current.state === "visible" || current.state === "unknown")
      && pending.selector.expectedTaskId === task.taskId
      && pending.selector.expectedTaskRevision === task.taskRevision
      && sameFrozen(frozenOf(task), pending.expected);
    return { current, reviewVisible };
  }

  private report(message: string, details?: Record<string, unknown>): void {
    try {
      this.diagnostic(message, details);
    } catch {
      // Diagnostics can never replace or throw away a real operation result.
    }
  }

  private currentAcceptedFlag(): boolean | null {
    if (currentTaskOwner() !== this.owner) return null;
    const snapshot = this.owner.snapshot();
    if (snapshot.acceptanceHazard !== null) return null;
    const task = snapshot.currentTask;
    return task === null ? null : task.status === "accepted";
  }

  private liveSubject(context: OmpToolContext): TaskSubject | null {
    if (currentTaskOwner() !== this.owner) return null;
    try {
      const subject = subjectFromContext(context, this.owner.workspaceRoot);
      return subject.agentKind === "main" ? subject : null;
    } catch {
      return null;
    }
  }

  private hazardUnavailable(reason: string): AcceptanceVisibility {
    return { state: "unavailable", taskId: null, status: null, accepted: null, reason };
  }

  /**
   * Pure in-process recheck after external context getters. A getter may have
   * disposed this service or published a replacement owner; the old owner's
   * task must then never be projected as current.
   */
  private staleAfterGetters(): AcceptanceVisibility | null {
    if (this.disposed) return this.hazardUnavailable("the acceptance service is disposed");
    if (currentTaskOwner() !== this.owner) return this.hazardUnavailable("the published task owner changed");
    return null;
  }

  private hazardReachability(subject: TaskSubject, task: ManagedTask): string | null {
    if (subject.sessionId !== task.anchor.sessionId) {
      return "the task belongs to a different OMP session";
    }
    try {
      if (!parseBranch(subject.branch).some((entry) => entry.id === task.anchor.messageId)) {
        return "the task anchor is not in the current conversation branch";
      }
    } catch (error) {
      return `the conversation branch is unavailable: ${errorMessage(error)}`;
    }
    return null;
  }

  /**
   * A stored hazard is an original-operation fact, not a capability. A later
   * call may see it only from the published owner's live main context, the
   * current frozen task, a reachable original anchor and the exact selector.
   * The final snapshot recheck runs after all external context getters.
   */
  private authorizedHazard(
    context: OmpToolContext,
    selector: AcceptanceSelector,
  ): { hazard: AcceptanceHazardFacts | null; current: AcceptanceVisibility; reason: string | null } {
    const withheld = (reason: string) => ({ hazard: null, current: this.hazardUnavailable(reason), reason });
    if (this.disposed) return withheld("the acceptance service is disposed");
    if (currentTaskOwner() !== this.owner) return withheld("the published task owner changed");
    const subject = this.liveSubject(context);
    if (subject === null) return withheld("the live main-session context or workspace is unavailable");
    const snapshot = this.owner.snapshot();
    const hazard = snapshot.acceptanceHazard;
    if (hazard === null) return withheld("no acceptance installation hazard is stored");
    const task = snapshot.currentTask;
    if (task === null) return withheld("no current managed task exists");
    if (!sameFrozen(frozenOf(task), hazard.task)) {
      return withheld("the current managed task does not match the stored acceptance operation");
    }
    if (selector.expectedTaskId !== hazard.task.taskId
      || selector.expectedTaskRevision !== hazard.task.taskRevision
      || selector.deliveryId !== hazard.deliveryId) {
      return withheld("the requested selector does not match the unknown acceptance operation");
    }
    const reachability = this.hazardReachability(subject, task);
    if (reachability !== null) return withheld(reachability);
    if (this.disposed) return withheld("the acceptance service is disposed");
    if (currentTaskOwner() !== this.owner) return withheld("the published task owner changed");
    const finalSnapshot = this.owner.snapshot();
    const finalHazard = finalSnapshot.acceptanceHazard;
    const finalTask = finalSnapshot.currentTask;
    if (finalHazard === null || finalTask === null) {
      return withheld("the acceptance installation state changed while it was checked");
    }
    if (!sameFrozen(frozenOf(finalTask), hazard.task)
      || !sameFrozen(finalHazard.task, hazard.task)
      || finalHazard.acceptanceId !== hazard.acceptanceId
      || finalHazard.deliveryId !== hazard.deliveryId
      || finalHazard.recordDigest !== hazard.recordDigest) {
      return withheld("the acceptance installation state changed while it was checked");
    }
    return {
      hazard: {
        task: { ...finalHazard.task },
        acceptanceId: finalHazard.acceptanceId,
        deliveryId: finalHazard.deliveryId,
        recordDigest: finalHazard.recordDigest,
        reason: finalHazard.reason,
      },
      current: {
        state: "unknown",
        taskId: finalHazard.task.taskId,
        status: finalTask.status,
        accepted: null,
        reason: safeDiagnostic(finalHazard.reason, 512),
      },
      reason: null,
    };
  }

  private visibility(context: OmpToolContext): AcceptanceVisibility {
    if (currentTaskOwner() !== this.owner) {
      return { state: "unavailable", taskId: null, status: null, accepted: null, reason: "the published task owner changed" };
    }
    if (this.disposed) {
      return { state: "unavailable", taskId: null, status: null, accepted: null, reason: "the acceptance service is disposed" };
    }
    const snapshot = this.owner.snapshot();
    const task = snapshot.currentTask;
    if (task === null) {
      return { state: "unavailable", taskId: null, status: null, accepted: null, reason: "no current managed task exists" };
    }
    if (snapshot.acceptanceHazard !== null) {
      const hazard = snapshot.acceptanceHazard;
      const subject = this.liveSubject(context);
      if (subject === null) return this.hazardUnavailable("the live main-session context or workspace is unavailable");
      const reachability = this.hazardReachability(subject, task);
      if (reachability !== null) return this.hazardUnavailable(reachability);
      // liveSubject ran external context getters. Recheck the actual published
      // owner, disposal and the exact frozen task/hazard identity with pure
      // in-process guards before projecting the earlier unknown snapshot.
      const stale = this.staleAfterGetters();
      if (stale !== null) return stale;
      const finalSnapshot = this.owner.snapshot();
      const finalTask = finalSnapshot.currentTask;
      const finalHazard = finalSnapshot.acceptanceHazard;
      if (finalTask === null
        || finalHazard === null
        || !sameFrozen(frozenOf(finalTask), frozenOf(task))
        || !sameFrozen(finalHazard.task, hazard.task)
        || finalHazard.acceptanceId !== hazard.acceptanceId
        || finalHazard.deliveryId !== hazard.deliveryId
        || finalHazard.recordDigest !== hazard.recordDigest) {
        return this.hazardUnavailable("the acceptance installation state changed while it was checked");
      }
      return {
        state: "unknown",
        taskId: finalTask.taskId,
        status: finalTask.status,
        accepted: null,
        reason: safeDiagnostic(finalHazard.reason, 512),
      };
    }
    const base = {
      taskId: task.taskId,
      status: task.status,
      accepted: task.status === "accepted",
    } as const;
    if (snapshot.binding.state !== "attached") {
      return { ...base, state: "detached", reason: snapshot.binding.reason ?? "the conversation binding is detached" };
    }
    const subject = this.liveSubject(context);
    if (subject === null) {
      return { ...base, state: "unavailable", reason: "the live main-session context or workspace is unavailable" };
    }
    let reachable: ManagedTask;
    try {
      reachable = this.owner.reachableTask(subject);
    } catch (error) {
      return { ...base, state: "changed", reason: errorMessage(error) };
    }
    if (!sameFrozen(frozenOf(reachable), frozenOf(task))) {
      return { ...base, state: "changed", reason: "the live task identity changed" };
    }
    // All external context getters have run. Recheck the actual published
    // owner and state with pure in-process guards; a getter that published a
    // replacement owner must not leave the old owner's task visible.
    const stale = this.staleAfterGetters();
    if (stale !== null) return stale;
    const finalSnapshot = this.owner.snapshot();
    const finalTask = finalSnapshot.currentTask;
    if (finalTask === null) {
      return { state: "unavailable", taskId: null, status: null, accepted: null, reason: "no current managed task exists" };
    }
    const finalBase = {
      taskId: finalTask.taskId,
      status: finalTask.status,
      accepted: finalTask.status === "accepted",
    } as const;
    if (finalSnapshot.acceptanceHazard !== null) {
      const reachability = this.hazardReachability(subject, finalTask);
      if (reachability !== null) return this.hazardUnavailable(reachability);
      return {
        state: "unknown",
        taskId: finalTask.taskId,
        status: finalTask.status,
        accepted: null,
        reason: safeDiagnostic(finalSnapshot.acceptanceHazard.reason, 512),
      };
    }
    if (finalSnapshot.binding.state !== "attached") {
      return { ...finalBase, state: "detached", reason: finalSnapshot.binding.reason ?? "the conversation binding is detached" };
    }
    if (finalTask.status !== task.status || !sameFrozen(frozenOf(finalTask), frozenOf(task))) {
      return { ...finalBase, state: "changed", reason: "the live task identity changed" };
    }
    try {
      const finalReachable = this.owner.reachableTask(subject);
      if (!sameFrozen(frozenOf(finalReachable), frozenOf(finalTask))) {
        return { ...finalBase, state: "changed", reason: "the live task identity changed" };
      }
    } catch (error) {
      return { ...finalBase, state: "changed", reason: errorMessage(error) };
    }
    return { ...finalBase, state: "visible", reason: null };
  }

  /**
   * Outermost synchronous current-state read for response assembly. It runs
   * the same context getters as inspection, performs no file I/O, and rechecks
   * the published owner/task after those getters. When a selector is supplied,
   * a visible task that no longer matches it is projected as changed with no
   * identity, never as the stale target.
   */
  finalVisibility(
    context: OmpToolContext,
    expectedTaskId?: string,
    expectedTaskRevision?: number,
  ): AcceptanceVisibility {
    const current = this.visibility(context);
    if (expectedTaskId === undefined || expectedTaskRevision === undefined) return current;
    if (this.disposed || currentTaskOwner() !== this.owner) {
      return this.hazardUnavailable("the published task owner or acceptance service changed");
    }
    const task = this.owner.snapshot().currentTask;
    if (task === null) return current;
    if (task.taskId !== expectedTaskId || task.taskRevision !== expectedTaskRevision) {
      return {
        state: "changed",
        taskId: null,
        status: null,
        accepted: null,
        reason: "the current task does not match the requested selector",
      };
    }
    return current;
  }

  private activityProblems(): string[] {
    let snapshot: ExecutionActivitySnapshot;
    try {
      snapshot = this.activity();
    } catch (error) {
      return [`the activity observer is unavailable: ${errorMessage(error)}`];
    }
    const owner = this.owner.snapshot();
    const problems: string[] = [];
    if (snapshot.ownerId !== this.owner.ownerId) problems.push("the activity observer belongs to a different owner");
    if (snapshot.disposed) problems.push("the execution capability is disposed");
    if (snapshot.busy) problems.push("the execution capability is busy");
    if (snapshot.unresolvedCompletions.length > 0 || snapshot.unresolvedOmitted > 0) {
      problems.push("a completion outcome is unresolved");
    }
    const unsupported = owner.authorizedCapabilities.filter((capability) => capability !== snapshot.capabilityId);
    if (unsupported.length > 0) {
      problems.push(`authorized side-effect capabilities are not observed: ${unsupported.join(", ")}`);
    }
    return problems;
  }

  private finalEligibility(
    context: OmpToolContext,
    expected: FrozenTaskRef,
    token: AcceptanceReservationToken,
  ): string | null {
    if (this.disposed) return "the acceptance service is disposed";
    if (currentTaskOwner() !== this.owner) return "the published task owner changed";
    if (!this.owner.reservationCurrent(token)) return "the acceptance reservation is stale or released";
    const subject = this.liveSubject(context);
    if (subject === null) return "the live main-session context is unavailable";
    if (this.owner.bindingStatus().state !== "attached") return "the conversation binding is detached";
    let task: ManagedTask;
    try {
      task = this.owner.reachableTask(subject);
    } catch (error) {
      return errorMessage(error);
    }
    if (task.status !== "active") return `the task status is ${task.status}`;
    if (task.acceptance !== null) return "the task already has an acceptance reference";
    if (!sameFrozen(frozenOf(task), expected)) return "the current task identity, revision or requirements changed";
    return null;
  }

  private evidenceProblems(evidence: AcceptanceEvidence, expected: FrozenTaskRef, task: ManagedTask): string[] {
    const problems: string[] = [];
    if (!sameFrozen(evidence.task, expected)) problems.push("the delivery evidence belongs to a different task identity");
    const contract = evidence.contract;
    const receipt = evidence.receipt;
    if (contract === null) {
      problems.push("no immutable host acceptance contract is bound");
      return problems;
    }
    if (!sameFrozen(contract.task, expected)) problems.push("the contract belongs to a different task identity");
    if (contract.coverage.kind !== "semantic") problems.push("the contract covers integrity only, not task semantics");
    if (contract.coverage.complete !== true) problems.push("the contract does not declare complete semantic coverage");
    if (contract.conditions.length === 0) problems.push("the contract has no conditions");
    const actualRevisions = [...new Set(task.requirementSources.map((source) => source.revision))].sort((left, right) => left - right);
    const coverage = new Set(contract.coverage.coveredRevisions);
    const uncovered = actualRevisions.filter((revision) => !coverage.has(revision));
    if (actualRevisions.length === 0) problems.push("the frozen task has no requirement revisions");
    if (uncovered.length > 0) problems.push(`contract coverage omits requirement revision(s): ${uncovered.join(", ")}`);
    const semantic = new Set<number>();
    for (const condition of contract.conditions) {
      if (condition.kind === "semantic") for (const revision of condition.coveredRevisions) semantic.add(revision);
    }
    const semanticUncovered = actualRevisions.filter((revision) => !semantic.has(revision));
    if (semanticUncovered.length > 0) {
      problems.push(`semantic conditions omit requirement revision(s): ${semanticUncovered.join(", ")}`);
    }
    if (receipt === null) {
      problems.push("the delivery does not reference an actual verification receipt");
      return problems;
    }
    if (receipt.task.ownerId !== expected.ownerId
      || receipt.task.taskId !== expected.taskId
      || receipt.task.taskRevision !== expected.taskRevision
      || receipt.task.requirementsDigest !== expected.requirementsDigest) {
      problems.push("the verification receipt belongs to a different owner, task, revision or requirements digest");
    }
    if (receipt.contract === null) {
      problems.push("the verification receipt is not bound to a contract");
    } else {
      if (receipt.contract.contractId !== contract.contractId || receipt.contract.digest !== contract.digest) {
        problems.push("the verification receipt contract identity differs from the current host contract");
      }
      if (receipt.contract.hostConfigId !== contract.hostConfig.id
        || receipt.contract.hostConfigVersion !== contract.hostConfig.version) {
        problems.push("the verification receipt host configuration differs from the current contract");
      }
      if (receipt.contract.verifierId !== contract.verifier.id
        || receipt.contract.verifierVersion !== contract.verifier.version
        || receipt.contract.parametersDigest !== contract.verifier.parametersDigest) {
        problems.push("the verification receipt verifier identity or parameters digest differs from the current contract");
      }
    }
    if (evidence.receiptCompatibility !== "current") {
      problems.push(`the verification receipt is not current (${evidence.receiptCompatibility ?? "unavailable"})`);
    }
    if (evidence.receiptUsable !== true) problems.push("the verification receipt is not usable");
    if (receipt.outcome !== "pass") problems.push(`the verification outcome is ${receipt.outcome}, not pass`);
    if (receipt.uncoveredRevisions.length > 0) {
      problems.push(`the verification receipt has uncovered requirement revision(s): ${receipt.uncoveredRevisions.join(", ")}`);
    }
    if (receipt.limits.timedOut) problems.push("the trusted verifier timed out");
    if (receipt.limits.limitExceeded) problems.push("the verifier result exceeded its limit");
    if (receipt.conditions.length !== contract.conditions.length) {
      problems.push("the verification receipt condition set does not match the contract");
    }
    for (const expectedCondition of contract.conditions) {
      const found = receipt.conditions.find((condition) => condition.conditionId === expectedCondition.conditionId);
      if (!found) {
        problems.push(`condition ${expectedCondition.conditionId} is missing from the receipt`);
        continue;
      }
      if (found.result !== "pass") problems.push(`condition ${expectedCondition.conditionId} did not pass`);
      if (found.kind !== expectedCondition.kind) problems.push(`condition ${expectedCondition.conditionId} kind changed`);
      if (JSON.stringify(found.coveredRevisions) !== JSON.stringify(expectedCondition.coveredRevisions)) {
        problems.push(`condition ${expectedCondition.conditionId} coverage changed`);
      }
    }
    if (receipt.candidates.runId !== evidence.runId || evidence.candidate.runId !== evidence.runId) {
      problems.push("the receipt, delivery and candidate run identities differ");
    }
    if (receipt.candidates.source === null
      || receipt.candidates.source.bytes !== evidence.candidate.source.bytes
      || receipt.candidates.source.sha256 !== evidence.candidate.source.sha256) {
      problems.push("the receipt source bytes differ from the candidate source");
    }
    const receiptInputs = [...receipt.candidates.inputs].sort((left, right) => left.id.localeCompare(right.id));
    const candidateInputs = [...evidence.candidate.inputs].sort((left, right) => left.id.localeCompare(right.id));
    if (JSON.stringify(receiptInputs) !== JSON.stringify(candidateInputs)) {
      problems.push("the receipt input set or digests differ from the candidate inputs");
    }
    const receiptArtifacts = sortedByArtifact(receipt.candidates.artifacts);
    const candidateArtifacts = sortedByArtifact(evidence.candidate.artifacts);
    const deliveryRows = sortedByArtifact(evidence.files);
    if (receiptArtifacts.length !== candidateArtifacts.length || receiptArtifacts.length !== deliveryRows.length) {
      problems.push("the receipt, candidate and delivery selected artifact sets differ");
    } else {
      for (let index = 0; index < receiptArtifacts.length; index += 1) {
        const receiptRow = receiptArtifacts[index]! as {
          artifactId: string;
          relativePath?: string;
          bytes: number;
          sha256: string;
        };
        const candidateRow = candidateArtifacts[index]! as {
          artifactId: string;
          relativePath?: string;
          bytes: number;
          sha256: string;
        };
        const deliveryRow = deliveryRows[index]! as { artifactId: string; bytes: number; sha256: string };
        if (receiptRow.artifactId !== candidateRow.artifactId
          || receiptRow.artifactId !== deliveryRow.artifactId
          || receiptRow.bytes !== candidateRow.bytes
          || receiptRow.bytes !== deliveryRow.bytes
          || receiptRow.sha256 !== candidateRow.sha256
          || receiptRow.sha256 !== deliveryRow.sha256
          || receiptRow.relativePath !== candidateRow.relativePath) {
          problems.push("the receipt, candidate and delivery artifact set or digests differ");
          break;
        }
      }
    }
    const deliveryArtifactIds = [...evidence.artifactIds].sort();
    if (JSON.stringify(deliveryArtifactIds) !== JSON.stringify(candidateArtifacts.map((row) => row.artifactId).sort())) {
      problems.push("the delivery selection does not match the candidate selection");
    }
    if (receipt.candidates.provenance === null
      || JSON.stringify(receipt.candidates.provenance) !== JSON.stringify(evidence.candidate.provenance)) {
      problems.push("the receipt candidate provenance differs from the live candidate provenance");
    }
    return [...new Set(problems)];
  }

  private withheldInspection(
    context: OmpToolContext,
    reason: string,
  ): AcceptedInspectionResult {
    return {
      acceptance: null,
      record: { state: "unavailable", digestMatches: null, bytes: null, reason },
      delivery: { state: "unavailable", fileCount: null, files: null, manifest: null, requirements: null, reason },
      warnings: [],
      reason,
      current: this.visibility(context),
    };
  }

  private unknownInspection(
    hazard: AcceptanceHazardFacts,
    current: AcceptanceVisibility,
  ): AcceptedInspectionResult {
    return {
      acceptance: null,
      record: { state: "unknown", digestMatches: null, bytes: null, reason: hazard.reason },
      delivery: { state: "unknown", fileCount: null, files: null, manifest: null, requirements: null, reason: hazard.reason },
      warnings: ["the acceptance installation outcome is unknown; no recovery or blind replay was attempted"],
      reason: "the acceptance record installation outcome is unknown",
      current,
      unknown: { ...hazard, task: { ...hazard.task } },
    };
  }

  private withheldHazardInspection(reason: string, current: AcceptanceVisibility): AcceptedInspectionResult {
    return {
      acceptance: null,
      record: { state: "unavailable", digestMatches: null, bytes: null, reason },
      delivery: { state: "unavailable", fileCount: null, files: null, manifest: null, requirements: null, reason },
      warnings: [],
      reason,
      current,
    };
  }

  private inspectSync(
    context: OmpToolContext,
    selector: AcceptanceSelector,
    task: ManagedTask,
    current: AcceptanceVisibility,
  ): AcceptedInspectionResult {
    const reference = task.acceptance;
    if (task.status !== "accepted" || reference === null) {
      return {
        acceptance: null,
        record: { state: "not_accepted", digestMatches: null, bytes: null, reason: "the task is not accepted" },
        delivery: { state: "not_accepted", fileCount: null, files: null, manifest: null, requirements: null, reason: "the task is not accepted" },
        warnings: [],
        reason: "the current managed task is not accepted",
        current,
      };
    }
    if (task.taskId !== selector.expectedTaskId
      || task.taskRevision !== selector.expectedTaskRevision
      || reference.deliveryId !== selector.deliveryId) {
      return {
        acceptance: null,
        record: { state: "not_accepted", digestMatches: null, bytes: null, reason: "the selector does not match the accepted record" },
        delivery: { state: "not_accepted", fileCount: null, files: null, manifest: null, requirements: null, reason: "the selector does not match the accepted record" },
        warnings: [],
        reason: "the requested task/revision/delivery does not match the accepted record",
        current,
      };
    }
    const record = this.store.read(this.root, reference.acceptanceId, frozenOf(task));
    const digestMatches = record.digest === null ? null : record.digest === reference.recordDigest;
    return {
      acceptance: copyReference(reference),
      record: {
        state: record.state,
        digestMatches,
        bytes: record.bytes,
        reason: record.reason,
      },
      delivery: { state: "unavailable", fileCount: null, files: null, manifest: null, requirements: null, reason: "the delivery bundle has not been checked yet" },
      warnings: [],
      reason: null,
      current,
    };
  }

  private async acceptedReplay(
    context: OmpToolContext,
    selector: AcceptanceSelector,
  ): Promise<AcceptanceOperationDraft | null> {
    if (currentTaskOwner() !== this.owner) return null;
    const task = this.owner.snapshot().currentTask;
    if (task === null || task.status !== "accepted" || task.acceptance === null) return null;
    const current = this.visibility(context);
    if (task.taskId !== selector.expectedTaskId || task.taskRevision !== selector.expectedTaskRevision) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: null,
        acceptance: null,
        warnings: [],
        reason: "the current task is already accepted under a different task identity; it cannot be replaced",
        current,
      };
    }
    if (current.state !== "visible") {
      // A new caller that cannot see the accepted target must not receive any
      // historical acceptance identity, even when it knows the selector.
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: null,
        acceptance: null,
        warnings: [],
        reason: current.reason ?? "the accepted target is not visible from this live caller; the historical acceptance is withheld",
        current,
      };
    }
    if (task.acceptance.deliveryId !== selector.deliveryId) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: true,
        acceptance: null,
        warnings: [],
        reason: "the task is already accepted for a different delivery; the immutable acceptance record was not replaced",
        current,
      };
    }
    // Initial live visibility and the exact task/revision/delivery selector are
    // proven. Privately capture the matching committed reference; a later
    // inspection may lose visibility, but it cannot undo this committed fact.
    const committedReference = copyReference(task.acceptance);
    const inspected = await this.inspect(context, selector);
    if (inspected.acceptance === null) {
      return {
        outcome: "committed",
        operationCommitted: true,
        idempotent: true,
        taskAccepted: inspected.current.state === "visible" ? true : null,
        acceptance: committedReference,
        warnings: [
          "the original acceptance remains committed; this replay could not reconfirm the accepted record or files after an await",
          ...inspected.warnings,
        ].slice(0, MAX_ACCEPTANCE_WARNINGS),
        reason: null,
        current: inspected.current,
      };
    }
    return {
      outcome: "committed",
      operationCommitted: true,
      idempotent: true,
      taskAccepted: true,
      acceptance: committedReference,
      warnings: [
        "existing acceptance was reused; no record was installed and no new side effect occurred",
        ...inspected.warnings,
      ].slice(0, MAX_ACCEPTANCE_WARNINGS),
      reason: null,
      current: inspected.current,
    };
  }

  async inspect(
    context: OmpToolContext,
    selectorValue: unknown,
  ): Promise<AcceptedInspectionResult> {
    return boundInspectionResult(await this.inspectUnbounded(context, selectorValue));
  }

  private async inspectUnbounded(
    context: OmpToolContext,
    selectorValue: unknown,
  ): Promise<AcceptedInspectionResult> {
    if (this.disposed) return this.withheldInspection(context, "the acceptance service is disposed");
    let selector: AcceptanceSelector;
    try {
      selector = parseSelector(selectorValue);
    } catch (error) {
      return this.withheldInspection(context, errorMessage(error));
    }
    if (currentTaskOwner() !== this.owner) {
      return this.withheldInspection(context, "the published task owner changed");
    }
    const hazard = this.owner.snapshot().acceptanceHazard;
    if (hazard !== null) {
      const access = this.authorizedHazard(context, selector);
      return access.hazard === null
        ? this.withheldHazardInspection(access.reason ?? "the current context cannot access the unknown acceptance operation", access.current)
        : this.unknownInspection(access.hazard, access.current);
    }
    const current = this.visibility(context);
    if (current.state !== "visible") {
      return this.withheldInspection(context, current.reason ?? "the current task is not visible from the live main-session context");
    }
    const task = this.owner.snapshot().currentTask;
    if (task === null) return this.withheldInspection(context, "no current managed task exists");
    const inspected = this.inspectSync(context, selector, task, current);
    if (inspected.acceptance === null) return inspected;
    const expected = frozenOf(task);
    const delivery = await this.delivery.inspectAcceptedDelivery(expected, inspected.acceptance.deliveryId);
    if (this.disposed) {
      return this.withheldInspection(context, "the acceptance service was disposed while the delivery was checked");
    }
    if (currentTaskOwner() !== this.owner) {
      return this.withheldInspection(context, "the published task owner changed while the delivery was checked");
    }
    const after = this.visibility(context);
    if (after.state !== "visible"
      || currentTaskOwner() !== this.owner
      || !sameFrozen(frozenOf(this.owner.snapshot().currentTask ?? task), expected)) {
      return this.withheldInspection(context, after.reason ?? "the current task became invisible while the delivery was checked");
    }
    const warnings = [...inspected.warnings];
    if (inspected.record.state !== "intact" || inspected.record.digestMatches !== true) {
      warnings.push("the historical acceptance record is not intact; the accepted fact is retained separately");
    }
    if (delivery.state !== "intact") {
      warnings.push("the frozen delivery files are changed or unavailable; the accepted fact is retained separately");
    }
    return {
      ...inspected,
      delivery: {
        state: delivery.state,
        fileCount: delivery.files === null ? null : delivery.files.length,
        files: delivery.state === "intact" ? delivery.files : null,
        manifest: delivery.state === "intact" ? delivery.manifest : null,
        requirements: delivery.state === "intact" ? delivery.requirements : null,
        reason: delivery.reason,
      },
      current: after,
      warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
    };
  }

  /**
   * Host-only optional human/hybrid review. It reserves the same owner
   * acceptance transaction before its first await, presents only frozen
   * actual evidence through the fixed transport, then re-reads and commits
   * through the same owner/store/install path. No model-facing action reaches
   * this method in C1 and the production transport is always unavailable.
   */
  async requestHumanReview(
    context: OmpToolContext,
    selectorValue: unknown,
    signal?: AbortSignal,
  ): Promise<HumanReviewOperationResult> {
    if (!this.humanReviewEnabled) {
      return this.reviewNotCommitted(context, "unavailable", null, "human review is not enabled for this host");
    }
    if (this.disposed) {
      return this.reviewNotCommitted(context, "unavailable", null, "the acceptance service is disposed");
    }
    let selector: AcceptanceSelector;
    try {
      selector = parseSelector(selectorValue);
    } catch (error) {
      return this.reviewNotCommitted(context, "rejected", null, errorMessage(error));
    }
    if (this.pendingReview !== null) {
      return this.reviewNotCommitted(context, "unavailable", null, "another human review is already pending on this acceptance service");
    }
    if (!this.humanReviewContext(context)) {
      return this.reviewNotCommitted(
        context,
        "unavailable",
        null,
        "human review requires the actual main agent in the local TUI with a UI installed",
      );
    }
    if (currentTaskOwner() !== this.owner) {
      return this.reviewNotCommitted(context, "unavailable", null, "the published task owner changed");
    }
    const hazard = this.owner.snapshot().acceptanceHazard;
    if (hazard !== null) {
      const access = this.authorizedHazard(context, selector);
      const operation: AcceptanceOperationDraft = access.hazard === null
        ? {
          outcome: "unknown",
          operationCommitted: null,
          taskAccepted: null,
          acceptance: null,
          warnings: ["an unknown acceptance installation belongs to a task this call cannot access; no recovery or blind replay was attempted"],
          reason: access.reason ?? "the current context cannot access the unknown acceptance operation",
          current: access.current,
        }
        : {
          outcome: "unknown",
          operationCommitted: null,
          taskAccepted: null,
          acceptance: null,
          warnings: ["the acceptance installation outcome is unknown; no recovery, blind replay or human approval was attempted"],
          reason: access.hazard.reason,
          current: access.current,
          unknown: { ...access.hazard, task: { ...access.hazard.task } },
        };
      return {
        operation: boundOperationResult(operation),
        review: { state: "unknown", reviewId: null, reason: safeDiagnostic(operation.reason ?? "unknown acceptance state", 1024) },
      };
    }
    const initialTask = this.owner.snapshot().currentTask;
    if (initialTask !== null && initialTask.status === "accepted" && initialTask.acceptance !== null) {
      const replay = await this.acceptedReplay(context, selector);
      if (replay !== null) {
        return {
          operation: boundOperationResult(replay),
          review: {
            state: replay.outcome === "committed" ? "committed" : "rejected",
            reviewId: null,
            reason: replay.reason === null ? null : safeDiagnostic(replay.reason, 1024),
          },
        };
      }
      return this.reviewNotCommitted(context, "unavailable", null, "the accepted target is not visible; no new review was opened");
    }
    if (currentTaskOwner() !== this.owner) {
      return this.reviewNotCommitted(context, "unavailable", null, "the published task owner changed");
    }
    const subject = this.liveSubject(context);
    if (subject === null) {
      return this.reviewNotCommitted(context, "unavailable", null, "the live main-session context or workspace is unavailable");
    }
    const currentTask = this.owner.snapshot().currentTask;
    if (currentTask === null) {
      return this.reviewNotCommitted(context, "rejected", null, "no current managed task exists");
    }
    if (currentTask.taskId !== selector.expectedTaskId || currentTask.taskRevision !== selector.expectedTaskRevision) {
      return this.reviewNotCommitted(context, "rejected", null, "expectedTaskId/expectedTaskRevision do not match the current active task");
    }
    if (currentTask.status !== "active") {
      return this.reviewNotCommitted(context, "rejected", null, `the task status is ${currentTask.status}; only an active task can be reviewed`);
    }
    if (currentTask.acceptance !== null) {
      return this.reviewNotCommitted(context, "rejected", null, "the task already has an acceptance reference");
    }
    const expected = frozenOf(currentTask);
    let token: AcceptanceReservationToken;
    try {
      token = this.owner.reserveAcceptance(subject, expected);
    } catch (error) {
      return this.reviewNotCommitted(context, "unavailable", null, errorMessage(error));
    }
    const startedMonotonic = performance.now();
    let reviewId = "";
    let issuedRaw = "";
    let expiresAt = "";
    let pending!: PendingHumanReview;
    try {
      issuedRaw = this.now();
      if (!isCanonicalHumanReviewTime(issuedRaw)) {
        throw new AcceptanceServiceError("the host wall clock is not a canonical UTC timestamp");
      }
      const computedExpiry = humanReviewDeadlineAt(issuedRaw);
      if (computedExpiry === null) {
        throw new AcceptanceServiceError("the host wall clock cannot produce a fixed review deadline");
      }
      expiresAt = computedExpiry;
      reviewId = `review-${this.newId()}`;
      if (!isHumanReviewIdentifier(reviewId)) {
        throw new AcceptanceServiceError("the host generated an invalid review id");
      }
      if (currentTaskOwner() !== this.owner || !this.owner.reservationCurrent(token)) {
        throw new AcceptanceServiceError("the owner or acceptance reservation changed before presentation");
      }
      pending = {
        reviewId,
        capability: Object.freeze({}),
        selector,
        expected,
        issuedAt: issuedRaw,
        expiresAt,
        startedMonotonic,
        phase: "preparing",
        consumed: false,
        controller: new AbortController(),
        abort: null,
      };
    } catch (error) {
      try {
        this.owner.releaseAcceptance(token);
      } catch {
        // The original callback failure is the reported fact.
      }
      return this.reviewNotCommitted(context, "unavailable", null, errorMessage(error));
    }
    this.pendingReview = pending;
    const controller = pending.controller;
    let preparedCandidate: object | null = null;
    let preparedDigest = "";
    let committedResult: AcceptanceOperationResult | null = null;
    let approvedCapability: object | null = null;
    let reviewTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeReview: (() => void) | undefined;
    let onCallerAbort: (() => void) | undefined;
    let waitersCleaned = false;
    const cleanupWaiters = (): void => {
      if (waitersCleaned) return;
      waitersCleaned = true;
      try {
        if (reviewTimer !== undefined) clearTimeout(reviewTimer);
      } catch (error) {
        this.report("human_review_timer_cleanup_failed", { error: errorMessage(error).slice(0, 300) });
      }
      try {
        if (onCallerAbort !== undefined) signal?.removeEventListener("abort", onCallerAbort);
      } catch (error) {
        this.report("human_review_signal_cleanup_failed", { error: errorMessage(error).slice(0, 300) });
      }
      try {
        unsubscribeReview?.();
      } catch (error) {
        this.report("human_review_listener_cleanup_failed", { error: errorMessage(error).slice(0, 300) });
      }
    };
    try {
      // The fixed deadline starts when the acceptance reservation was taken,
      // before the host now/id callbacks ran. Schedule only the remaining
      // window; the origin is never reset. An already elapsed window arms no
      // timer and the synchronous elapsed guards below end the review.
      const remaining = REVIEW_DEADLINE_MS - (performance.now() - pending.startedMonotonic);
      if (remaining > 0) {
        reviewTimer = setTimeout(() => {
          this.abortPendingReview("expired", "the fixed human-review deadline elapsed");
        }, remaining);
        reviewTimer.unref?.();
      }
      onCallerAbort = (): void => {
        this.abortPendingReview("cancelled", "the human-review call was aborted");
      };
      if (signal !== undefined) {
        if (signal.aborted) onCallerAbort();
        else signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      unsubscribeReview = this.owner.subscribe((event) => {
        if (typeof event.type === "string" && REVIEW_INVALIDATION_EVENTS.has(event.type)) {
          this.abortPendingReview("invalidated", `the owner changed during human review (${event.type})`);
        }
      });
      const stopBeforePresentation = (): HumanReviewOperationResult | null => {
        if (pending.abort !== null) {
          return this.reviewNotCommitted(context, pending.abort.state, reviewId, pending.abort.reason);
        }
        if (this.reviewElapsed(pending)) {
          this.abortPendingReview("expired", "the fixed human-review deadline elapsed");
          return this.reviewNotCommitted(context, "expired", reviewId, "the fixed human-review deadline elapsed");
        }
        if (this.disposed || currentTaskOwner() !== this.owner) {
          return this.reviewNotCommitted(context, "cancelled", reviewId, "the acceptance service or published owner changed");
        }
        if (!this.owner.reservationCurrent(token)) {
          return this.reviewNotCommitted(context, "invalidated", reviewId, "the acceptance reservation was invalidated");
        }
        return null;
      };
      let stopped = stopBeforePresentation();
      if (stopped !== null) return stopped;
      const initialActivity = this.activityProblems();
      if (initialActivity.length > 0) {
        return this.reviewNotCommitted(
          context,
          "unavailable",
          reviewId,
          `human review is blocked: ${initialActivity.join("; ")}`,
          initialActivity,
        );
      }
      if (!this.humanReviewContext(context)) {
        this.abortPendingReview("unavailable", "the local TUI context or installed UI disappeared before presentation");
        return this.reviewNotCommitted(context, "unavailable", reviewId, "the local TUI context or installed UI disappeared before presentation");
      }
      stopped = stopBeforePresentation();
      if (stopped !== null) return stopped;
      let read;
      try {
        read = await this.delivery.readAcceptanceReviewEvidence(context, selector, controller.signal);
      } catch (error) {
        if (pending.abort !== null) {
          return this.reviewNotCommitted(context, pending.abort.state, reviewId, pending.abort.reason);
        }
        const state: HumanReviewState = error instanceof HumanReviewError ? "rejected" : "rejected";
        return this.reviewNotCommitted(context, state, reviewId, errorMessage(error));
      }
      stopped = stopBeforePresentation();
      if (stopped !== null) return stopped;
      let evidence = privateEvidence(read.evidence);
      let presentation = privatePresentation(read.presentation);
      let evidenceToken: AcceptanceEvidenceToken = read.token;
      const latest = this.owner.snapshot().currentTask;
      if (latest === null || latest.status !== "active" || !sameFrozen(frozenOf(latest), expected)) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the current task changed while the review display was prepared");
      }
      const revisions = humanReviewRequirementRevisions(latest.requirementSources);
      if (JSON.stringify(revisions) !== JSON.stringify(presentation.requirementRevisions)) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the review display does not cover the actual current requirement revisions");
      }
      let admission = evaluateHumanReviewEvidence({ evidence, requirementRevisions: revisions });
      if (!admission.eligible || admission.assessment === null) {
        return this.reviewNotCommitted(
          context,
          "rejected",
          reviewId,
          `human review is not admitted: ${admission.reasons.slice(0, 4).join("; ")}`,
          admission.reasons,
        );
      }
      if (!this.humanReviewContext(context)) {
        this.abortPendingReview("unavailable", "the local TUI context or installed UI disappeared before presentation");
        return this.reviewNotCommitted(context, "unavailable", reviewId, "the local TUI context or installed UI disappeared before presentation");
      }
      pending.phase = "presenting";
      stopped = stopBeforePresentation();
      if (stopped !== null) return stopped;
      /**
       * Read-only display veto created inside this exact pending review. It
       * re-proves the live subject/reachable task after adapter lazy loads and
       * before the custom factory mounts, then repeats only pure in-process
       * checks. It never mints, approves, commits or reads a new external
       * context getter after the final pure guards.
       */
      const displayGuard = (): boolean => {
        if (this.disposed
          || currentTaskOwner() !== this.owner
          || this.pendingReview !== pending
          || pending.phase !== "presenting"
          || pending.abort !== null
          || !this.owner.reservationCurrent(token)
          || this.reviewElapsed(pending)) {
          return false;
        }
        if (!this.humanReviewContext(context)) return false;
        const subject = this.liveSubject(context);
        if (subject === null) return false;
        let reachable: ManagedTask;
        try {
          reachable = this.owner.reachableTask(subject);
        } catch {
          return false;
        }
        const contextAvailable = this.humanReviewContext(context);
        if (this.disposed
          || currentTaskOwner() !== this.owner
          || this.pendingReview !== pending
          || pending.phase !== "presenting"
          || pending.abort !== null
          || !this.owner.reservationCurrent(token)
          || this.reviewElapsed(pending)
          || controller.signal.aborted
          || !contextAvailable) {
          return false;
        }
        const latest = this.owner.snapshot().currentTask;
        return latest !== null
          && latest.status === "active"
          && latest.taskId === reachable.taskId
          && latest.taskRevision === reachable.taskRevision
          && latest.status === reachable.status
          && sameFrozen(frozenOf(latest), expected)
          && sameFrozen(frozenOf(reachable), expected);
      };
      let abortResolve: (() => void) | undefined;
      const abortPromise = new Promise<null>((resolve) => {
        abortResolve = () => resolve(null);
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener("abort", abortResolve, { once: true });
      });
      const transportPromise = Promise.resolve()
        .then(() => presentLocalHumanReview({
          presentation,
          capability: pending.capability,
          issuedAt: pending.issuedAt,
          expiresAt: pending.expiresAt,
          signal: controller.signal,
          context,
          displayGuard,
        }))
        .catch((error): HumanReviewTransportResult => ({
          kind: "unavailable",
          reason: `the fixed human-review transport failed: ${errorMessage(error)}`,
        }));
      const transport = await Promise.race([transportPromise, abortPromise]);
      if (abortResolve !== undefined) controller.signal.removeEventListener("abort", abortResolve);
      if (transport === null) {
        const state = pending.abort?.state ?? "cancelled";
        const reason = pending.abort?.reason ?? "the human-review wait ended without a decision";
        return this.reviewNotCommitted(context, state, reviewId, reason);
      }
      if (transport.kind === "unavailable") {
        return this.reviewNotCommitted(context, "unavailable", reviewId, transport.reason);
      }
      if (transport.kind === "reject") {
        return this.reviewNotCommitted(context, "rejected", reviewId, transport.reason);
      }
      if (transport.kind === "cancelled") {
        return this.reviewNotCommitted(context, "cancelled", reviewId, transport.reason);
      }
      if (transport.kind !== "approve" || transport.capability !== pending.capability) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          "the transport did not return the exact capability issued for this pending review",
        );
      }
      approvedCapability = transport.capability;
      const decidedRaw = this.now();
      if (!isCanonicalHumanReviewTime(decidedRaw)) {
        this.abortPendingReview("invalidated", "the host wall clock is not canonical at the human decision");
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the host wall clock is not canonical at the human decision");
      }
      const decidedAt = decidedRaw;
      if (decidedAt > pending.expiresAt || this.reviewElapsed(pending)) {
        this.abortPendingReview("expired", "the human decision arrived after the fixed deadline");
        return this.reviewNotCommitted(context, "expired", reviewId, "the human decision arrived after the fixed deadline");
      }
      stopped = stopBeforePresentation();
      if (stopped !== null) return stopped;
      pending.phase = "approved_pending_recheck";
      let reread;
      try {
        reread = await this.delivery.readAcceptanceReviewEvidence(context, selector, controller.signal);
      } catch (error) {
        if (pending.abort !== null) {
          return this.reviewNotCommitted(context, pending.abort.state, reviewId, pending.abort.reason);
        }
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          `the approved evidence could not be re-read: ${errorMessage(error)}`,
        );
      }
      if (pending.abort !== null) {
        return this.reviewNotCommitted(context, pending.abort.state, reviewId, pending.abort.reason);
      }
      if (this.reviewElapsed(pending)) {
        this.abortPendingReview("expired", "the fixed human-review deadline elapsed during the recheck");
        return this.reviewNotCommitted(context, "expired", reviewId, "the fixed human-review deadline elapsed during the recheck");
      }
      const rereadEvidence = privateEvidence(reread.evidence);
      const rereadPresentation = privatePresentation(reread.presentation);
      evidenceToken = reread.token;
      if (JSON.stringify(humanReviewBindingOf(evidence)) !== JSON.stringify(humanReviewBindingOf(rereadEvidence))
        || presentation.digest !== rereadPresentation.digest
        || JSON.stringify(evidence.reviewFacts) !== JSON.stringify(rereadEvidence.reviewFacts)
        || JSON.stringify(presentation.requirementRevisions) !== JSON.stringify(rereadPresentation.requirementRevisions)) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          "the actual files, automatic evidence or display changed after approval; a new preview and human decision are required",
        );
      }
      const latestForRecord = this.owner.snapshot().currentTask;
      if (latestForRecord === null
        || latestForRecord.status !== "active"
        || !sameFrozen(frozenOf(latestForRecord), expected)) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the current task changed after the human decision");
      }
      const finalRevisions = humanReviewRequirementRevisions(latestForRecord.requirementSources);
      const rereadAdmission = evaluateHumanReviewEvidence({ evidence: rereadEvidence, requirementRevisions: finalRevisions });
      if (!rereadAdmission.eligible || rereadAdmission.assessment === null) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          `the re-read automatic evidence is no longer admitted: ${rereadAdmission.reasons.slice(0, 4).join("; ")}`,
          rereadAdmission.reasons,
        );
      }
      evidence = rereadEvidence;
      presentation = rereadPresentation;
      admission = rereadAdmission;
      const acceptedRaw = this.now();
      if (!isCanonicalHumanReviewTime(acceptedRaw)) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the host wall clock is not canonical at commit preparation");
      }
      if (acceptedRaw < decidedAt) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          "the host wall clock moved backwards after the human decision; commit time cannot be fabricated",
        );
      }
      let receiptId: string;
      try {
        receiptId = `human-review-${this.newId()}`;
      } catch (error) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, errorMessage(error));
      }
      if (!isHumanReviewIdentifier(receiptId)) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the host generated an invalid human review receipt id");
      }
      const record = this.humanReviewRecord({
        evidence,
        presentation,
        admission,
        task: latestForRecord,
        expected,
        reviewId,
        receiptId,
        issuedAt: pending.issuedAt,
        expiresAt: pending.expiresAt,
        decidedAt,
        acceptedAt: acceptedRaw,
      });
      const recordProblems = validateHumanReviewRecordV2(record);
      if (recordProblems.length > 0) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          `the human-review record failed its fixed validation: ${recordProblems.slice(0, 4).join("; ")}`,
          recordProblems,
        );
      }
      try {
        preparedCandidate = this.store.prepare({
          root: this.root,
          acceptanceId: record.acceptanceId,
          deliveryId: record.deliveryId,
          acceptedAt: record.acceptedAt,
          task: expected,
          record,
        });
        preparedDigest = this.store.binding(preparedCandidate).recordDigest;
      } catch (error) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, errorMessage(error));
      }
      // Every external getter/callback below has already returned before the
      // pure final checks and synchronous seal. No UI or business callback may
      // run after this point.
      const finalReason = this.finalEligibility(context, expected, token);
      if (finalReason !== null) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, finalReason);
      }
      const finalActivity = this.activityProblems();
      if (finalActivity.length > 0) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          `human review is blocked: ${finalActivity.join("; ")}`,
          finalActivity,
        );
      }
      cleanupWaiters();
      const finalAbort = pendingAbortOf(pending);
      if (finalAbort !== null) {
        return this.reviewNotCommitted(context, finalAbort.state, reviewId, finalAbort.reason);
      }
      if (this.reviewElapsed(pending)) {
        return this.reviewNotCommitted(context, "expired", reviewId, "the fixed human-review deadline elapsed before commit");
      }
      if (this.disposed
        || currentTaskOwner() !== this.owner
        || !this.owner.reservationCurrent(token)
        || signal?.aborted
        || controller.signal.aborted) {
        return this.reviewNotCommitted(
          context,
          "invalidated",
          reviewId,
          "the live owner, service, signal or acceptance reservation changed after the final external read",
        );
      }
      if (pending.consumed
        || pending.phase !== "approved_pending_recheck"
        || approvedCapability === null
        || approvedCapability !== pending.capability) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the one-shot human capability is no longer current");
      }
      const finalReceiptDigest = evidence.receipt === null ? null : sha256Text(JSON.stringify(evidence.receipt));
      if (finalReceiptDigest !== evidence.receiptDigest) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, "the privately owned receipt facts changed before commit");
      }
      // Consume immediately before the final checks; consumption is not an
      // installation and a later failure can never restore the capability.
      pending.consumed = true;
      const sealReason = sealAcceptanceEvidenceTokenSync(evidenceToken);
      if (sealReason !== null) {
        return this.reviewNotCommitted(context, "invalidated", reviewId, `the final evidence seal failed: ${sealReason}`);
      }
      const commit = this.owner.commitAccepted(token, preparedCandidate);
      const warnings = [...commit.warnings];
      if (commit.operationCommitted) {
        const committedDraft: AcceptanceOperationDraft = {
          outcome: "committed",
          operationCommitted: true,
          taskAccepted: true,
          acceptance: commit.acceptance === null ? null : copyReference(commit.acceptance),
          warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: null,
          current: {
            state: "unavailable",
            taskId: expected.taskId,
            status: "accepted",
            accepted: true,
            reason: "current visibility has not been read",
          },
        };
        try {
          committedDraft.current = this.visibility(context);
        } catch (error) {
          committedDraft.current = {
            state: "unavailable",
            taskId: null,
            status: null,
            accepted: null,
            reason: "postcommit current visibility is unavailable",
          };
          committedDraft.warnings = [
            ...committedDraft.warnings,
            `postcommit_visibility_failed: ${errorMessage(error)}`,
          ].slice(0, MAX_ACCEPTANCE_WARNINGS);
        }
        committedResult = boundOperationResult(committedDraft);
        return {
          operation: committedResult,
          review: { state: "committed", reviewId, reason: null },
        };
      }
      if (commit.status === "unknown") {
        // Capture the original unknown-installation hazard before any external
        // diagnostic callback. The diagnostic may publish a new owner or
        // dispose this service; current visibility is therefore read only
        // afterwards and cannot rewrite the original hazard facts.
        const committedHazard = this.owner.snapshot().acceptanceHazard;
        this.report("human_review_commit_unknown", {
          reason: commit.reason,
          reviewId,
          deliveryId: selector.deliveryId,
        });
        const current = this.visibility(context);
        const operation: AcceptanceOperationDraft = {
          outcome: "unknown",
          operationCommitted: null,
          taskAccepted: null,
          acceptance: null,
          warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: commit.reason ?? "the acceptance record installation outcome is unknown",
          current,
          unknown: committedHazard === null
            ? {
              task: { ...expected },
              acceptanceId: record.acceptanceId,
              deliveryId: selector.deliveryId,
              recordDigest: preparedDigest,
              reason: commit.reason ?? "the acceptance record installation outcome is unknown",
            }
            : { ...committedHazard, task: { ...committedHazard.task } },
        };
        return {
          operation: boundOperationResult(operation),
          review: { state: "unknown", reviewId, reason: safeDiagnostic(operation.reason ?? "unknown commit result", 1024) },
        };
      }
      return this.reviewNotCommitted(
        context,
        "invalidated",
        reviewId,
        commit.reason ?? "the human-review record was not installed",
        warnings,
      );
    } catch (error) {
      if (committedResult !== null) {
        committedResult.warnings = [
          ...committedResult.warnings,
          `postcommit_result_projection_failed: ${errorMessage(error)}`,
        ].slice(0, MAX_ACCEPTANCE_WARNINGS);
        return {
          operation: committedResult,
          review: { state: "committed", reviewId, reason: null },
        };
      }
      this.report("human_review_failed", { error: errorMessage(error).slice(0, 500) });
      return this.reviewNotCommitted(context, "invalidated", reviewId, errorMessage(error));
    } finally {
      try {
        if (preparedCandidate !== null) {
          const cleanup = this.store.discard(preparedCandidate);
          if (cleanup.length > 0) this.report("human_review_prepared_cleanup", { warnings: cleanup.slice(0, 8) });
        }
      } catch (error) {
        this.report("human_review_prepared_cleanup_failed", { error: errorMessage(error) });
      }
      try {
        this.owner.releaseAcceptance(token);
      } catch (error) {
        this.report("human_review_release_failed", { error: errorMessage(error) });
      }
      try {
        cleanupWaiters();
      } catch (error) {
        this.report("human_review_waiters_cleanup_failed", { error: errorMessage(error).slice(0, 300) });
      } finally {
        if (this.pendingReview === pending) this.pendingReview = null;
      }
    }
  }

  private humanReviewRecord(input: {
    evidence: AcceptanceEvidence;
    presentation: HumanReviewPresentation;
    admission: HumanReviewAdmission;
    task: ManagedTask;
    expected: FrozenTaskRef;
    reviewId: string;
    receiptId: string;
    issuedAt: string;
    expiresAt: string;
    decidedAt: string;
    acceptedAt: string;
  }): AcceptanceRecordV2 {
    const assessment = input.admission.assessment;
    if (assessment === null) throw new AcceptanceServiceError("human review admission has no assessment.");
    const revisions = humanReviewRequirementRevisions(input.task.requirementSources);
    if (JSON.stringify(assessment.reviewedRequirementRevisions) !== JSON.stringify(revisions)) {
      throw new AcceptanceServiceError("human review assessment does not cover every current requirement revision.");
    }
    const humanReview: HumanReviewReceiptV1 = {
      schemaVersion: 1,
      receiptId: input.receiptId,
      reviewId: input.reviewId,
      policyVersion: HUMAN_REVIEW_POLICY_VERSION,
      decision: "approve",
      interactionSource: HUMAN_REVIEW_INTERACTION_SOURCE,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      decidedAt: input.decidedAt,
      task: { ...input.expected },
      session: {
        sessionId: input.task.anchor.sessionId,
        branchAnchorId: input.task.anchor.messageId,
      },
      binding: humanReviewBindingOf(input.evidence),
      display: humanReviewDisplayOf(input.presentation),
      assessment: {
        reviewedRequirementRevisions: [...assessment.reviewedRequirementRevisions],
        automaticCheckIds: [...assessment.automaticCheckIds],
        humanSupplementRequiredRevisions: [...assessment.humanSupplementRequiredRevisions],
        automaticEvidenceState: assessment.automaticEvidenceState,
      },
    };
    const receipt = input.evidence.receipt;
    const receiptDigestValue = input.evidence.receiptDigest;
    return {
      schemaVersion: 2,
      version: HUMAN_REVIEW_RECORD_VERSION,
      policy: {
        source: input.evidence.contract === null ? "human-review" : "hybrid-human-review",
        version: HUMAN_REVIEW_POLICY_VERSION,
      },
      acceptanceId: `acceptance-${this.newId()}`,
      deliveryId: input.evidence.deliveryId,
      acceptedAt: input.acceptedAt,
      task: { ...input.expected },
      requirements: {
        digest: input.expected.requirementsDigest,
        sources: input.task.requirementSources.map((source) => ({
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
      },
      delivery: {
        deliveryId: input.evidence.deliveryId,
        runId: input.evidence.runId,
        artifactIds: [...input.evidence.artifactIds],
        snapshotId: input.evidence.deliverySnapshotId,
        previewDigest: input.evidence.previewDigest,
        files: input.evidence.files.map((file) => ({
          artifactId: file.artifactId,
          relativePath: file.relativePath,
          name: file.name,
          bytes: file.bytes,
          sha256: file.sha256,
        })),
        manifest: { ...input.evidence.manifest },
        requirements: { ...input.evidence.requirements },
      },
      candidate: {
        ...input.evidence.candidate,
        inputs: input.evidence.candidate.inputs.map((item) => ({ ...item })),
        artifacts: input.evidence.candidate.artifacts.map((item) => ({ ...item })),
        provenance: { ...input.evidence.candidate.provenance },
      },
      contract: input.evidence.contract,
      receipt: {
        receipt,
        digest: receiptDigestValue,
        snapshotId: input.evidence.receiptSnapshotId,
      },
      evidence: {
        deliverySnapshotId: input.evidence.deliverySnapshotId,
        receiptSnapshotId: input.evidence.receiptSnapshotId,
        note: "verification and delivery preview may resolve different snapshot ids; bytes and digests are compared",
        humanReviewReceiptDigest: humanReviewDigest(humanReview),
      },
      humanReview,
    };
  }

  async submit(
    context: OmpToolContext,
    selectorValue: unknown,
    signal?: AbortSignal,
  ): Promise<AcceptanceOperationResult> {
    return boundOperationResult(await this.submitUnbounded(context, selectorValue, signal));
  }

  private async submitUnbounded(
    context: OmpToolContext,
    selectorValue: unknown,
    signal?: AbortSignal,
  ): Promise<AcceptanceOperationDraft> {
    if (this.disposed) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: this.currentAcceptedFlag(),
        acceptance: null,
        warnings: [],
        reason: "the acceptance service is disposed",
        current: this.visibility(context),
      };
    }
    let selector: AcceptanceSelector;
    try {
      selector = parseSelector(selectorValue);
    } catch (error) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: this.currentAcceptedFlag(),
        acceptance: null,
        warnings: [],
        reason: errorMessage(error),
        current: this.visibility(context),
      };
    }
    if (signal?.aborted) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: this.currentAcceptedFlag(),
        acceptance: null,
        warnings: [],
        reason: "the call was aborted before acceptance admission",
        current: this.visibility(context),
      };
    }
    const hazard = this.owner.snapshot().acceptanceHazard;
    if (hazard !== null) {
      const access = this.authorizedHazard(context, selector);
      if (access.hazard === null) {
        return {
          outcome: "unknown",
          operationCommitted: null,
          taskAccepted: null,
          acceptance: null,
          warnings: ["an unknown acceptance installation belongs to a task this call cannot access; no recovery or blind replay was attempted"],
          reason: access.reason ?? "the current context cannot access the unknown acceptance operation",
          current: access.current,
        };
      }
      return {
        outcome: "unknown",
        operationCommitted: null,
        taskAccepted: null,
        acceptance: null,
        warnings: ["the acceptance installation outcome is unknown; no recovery or blind replay was attempted"],
        reason: access.hazard.reason,
        current: access.current,
        unknown: { ...access.hazard, task: { ...access.hazard.task } },
      };
    }
    // Only an existing terminal acceptance may await replay. An active task
    // reserves synchronously, before any await, so a same-stack admit/run
    // immediately after submit() observes the reservation.
    const initialTask = this.owner.snapshot().currentTask;
    if (initialTask !== null && initialTask.status === "accepted" && initialTask.acceptance !== null) {
      const replay = await this.acceptedReplay(context, selector);
      if (replay !== null) return replay;
    }
    if (currentTaskOwner() !== this.owner) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: null,
        acceptance: null,
        warnings: [],
        reason: "the published task owner changed",
        current: { state: "unavailable", taskId: null, status: null, accepted: null, reason: "the published task owner changed" },
      };
    }
    const subject = this.liveSubject(context);
    if (subject === null) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: null,
        acceptance: null,
        warnings: [],
        reason: "the live main-session context or workspace is unavailable",
        current: this.visibility(context),
      };
    }
    const currentTask = this.owner.snapshot().currentTask;
    if (currentTask === null) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: false,
        acceptance: null,
        warnings: [],
        reason: "no current managed task exists",
        current: this.visibility(context),
      };
    }
    if (currentTask.taskId !== selector.expectedTaskId || currentTask.taskRevision !== selector.expectedTaskRevision) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: currentTask.status === "accepted" ? true : false,
        acceptance: null,
        warnings: [],
        reason: "expectedTaskId/expectedTaskRevision do not match the current active task",
        current: this.visibility(context),
      };
    }
    const expected = frozenOf(currentTask);
    let token: AcceptanceReservationToken;
    try {
      token = this.owner.reserveAcceptance(subject, expected);
    } catch (error) {
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: this.owner.snapshot().currentTask?.status === "accepted" ? true : false,
        acceptance: null,
        warnings: [],
        reason: errorMessage(error),
        current: this.visibility(context),
      };
    }
    const warnings: string[] = [];
    let preparedCandidate: object | null = null;
    let preparedDigest = "";
    let committedResult: AcceptanceOperationDraft | null = null;
    try {
      const activityProblems = this.activityProblems();
      if (activityProblems.length > 0) {
        return {
          outcome: "not_committed",
          operationCommitted: false,
          taskAccepted: false,
          acceptance: null,
          warnings: activityProblems.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: `acceptance is blocked: ${activityProblems.join("; ")}`,
          current: this.visibility(context),
        };
      }
      let evidence: AcceptanceEvidence;
      let evidenceToken: Parameters<typeof sealAcceptanceEvidenceTokenSync>[0];
      try {
        const read = await this.delivery.readAcceptanceEvidence(context, selector, signal);
        // Privately own every evidence fact before any host id/now callback can
        // run. Caller-visible receipts, contracts, arrays and provenance are
        // never retained or used as record authority.
        evidence = privateEvidence(read.evidence);
        evidenceToken = read.token;
      } catch (error) {
        this.report("acceptance_evidence_rejected", { error: errorMessage(error).slice(0, 500) });
        return {
          outcome: "not_committed",
          operationCommitted: false,
          taskAccepted: false,
          acceptance: null,
          warnings: [],
          reason: errorMessage(error),
          current: this.visibility(context),
        };
      }
      if (signal?.aborted) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: "the call was aborted after evidence was read",
          current: this.visibility(context),
        };
      }
      if (!this.owner.reservationCurrent(token)) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: "the acceptance reservation was invalidated while evidence was read",
          current: this.visibility(context),
        };
      }
      const receiptDigest = evidence.receipt === null ? null : sha256Text(JSON.stringify(evidence.receipt));
      const contractDigest = evidence.contract === null ? null : evidence.contract.digest;
      if ((evidence.receipt === null && evidence.receiptDigest !== null)
        || (evidence.receipt !== null && evidence.receiptDigest !== receiptDigest)) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [],
          reason: "the delivery receipt digest does not match the privately owned receipt facts",
          current: this.visibility(context),
        };
      }
      const problems = this.evidenceProblems(evidence, expected, currentTask);
      if (problems.length > 0) {
        return {
          outcome: "not_committed",
          operationCommitted: false,
          taskAccepted: false,
          acceptance: null,
          warnings: problems.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: `acceptance evidence is insufficient: ${problems.slice(0, 4).join("; ")}`,
          current: this.visibility(context),
        };
      }
      const latest = this.owner.snapshot().currentTask;
      if (latest === null || latest.status !== "active" || !sameFrozen(frozenOf(latest), expected)) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: "the current task changed before record preparation",
          current: this.visibility(context),
        };
      }
      const acceptanceId = `acceptance-${this.newId()}`;
      identifier(acceptanceId, "acceptanceId");
      const acceptedAt = this.now();
      const record = {
        schemaVersion: 1,
        version: ACCEPTANCE_RECORD_VERSION,
        policy: { source: ACCEPTANCE_RECORD_POLICY_SOURCE, version: ACCEPTANCE_SERVICE_VERSION },
        acceptanceId,
        deliveryId: selector.deliveryId,
        acceptedAt,
        task: expected,
        requirements: {
          digest: expected.requirementsDigest,
          sources: latest.requirementSources.map((source) => ({
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
        },
        delivery: {
          deliveryId: evidence.deliveryId,
          runId: evidence.runId,
          artifactIds: [...evidence.artifactIds],
          snapshotId: evidence.deliverySnapshotId,
          previewDigest: evidence.previewDigest,
          files: evidence.files.map((file) => ({
            artifactId: file.artifactId,
            relativePath: file.relativePath,
            name: file.name,
            bytes: file.bytes,
            sha256: file.sha256,
          })),
          manifest: { ...evidence.manifest },
          requirements: { ...evidence.requirements },
        },
        candidate: {
          ...evidence.candidate,
          inputs: evidence.candidate.inputs.map((input) => ({ ...input })),
          artifacts: evidence.candidate.artifacts.map((artifact) => ({ ...artifact })),
          provenance: { ...evidence.candidate.provenance },
        },
        contract: evidence.contract as AcceptanceContractEvidence,
        receipt: {
          receipt: evidence.receipt,
          digest: receiptDigest,
          snapshotId: evidence.receiptSnapshotId,
        },
        evidence: {
          deliverySnapshotId: evidence.deliverySnapshotId,
          receiptSnapshotId: evidence.receiptSnapshotId,
          note: "verification and delivery preview may resolve different snapshot ids; bytes and digests are compared",
        },
      };
      let preparedRecord: object;
      try {
        preparedRecord = this.store.prepare({
          root: this.root,
          acceptanceId,
          deliveryId: selector.deliveryId,
          acceptedAt,
          task: expected,
          record,
        });
        preparedCandidate = preparedRecord;
        preparedDigest = this.store.binding(preparedRecord).recordDigest;
      } catch (error) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: errorMessage(error),
          current: this.visibility(context),
        };
      }
      if (signal?.aborted) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: "the call was aborted before the final synchronous commit",
          current: this.visibility(context),
        };
      }
      const finalReason = this.finalEligibility(context, expected, token);
      if (finalReason !== null) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: finalReason,
          current: this.visibility(context),
        };
      }
      const finalActivity = this.activityProblems();
      if (finalActivity.length > 0) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: finalActivity.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: `acceptance is blocked: ${finalActivity.join("; ")}`,
          current: this.visibility(context),
        };
      }
      // No callback may run after this point until the fixed installation is
      // attempted. These are pure in-memory checks of final external facts.
      const finalReceiptDigest = evidence.receipt === null ? null : sha256Text(JSON.stringify(evidence.receipt));
      const finalContractDigest = evidence.contract === null ? null : evidence.contract.digest;
      if (finalReceiptDigest !== receiptDigest || finalContractDigest !== contractDigest) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [],
          reason: "the privately owned receipt or contract facts changed before commit",
          current: this.visibility(context),
        };
      }
      if (this.disposed
        || signal?.aborted
        || currentTaskOwner() !== this.owner
        || !this.owner.reservationCurrent(token)) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [],
          reason: "the live owner, service, signal or acceptance reservation changed after the final external read",
          current: this.visibility(context),
        };
      }
      // Synchronously seal actual originals and
      // delivered bytes, then commit with no await or business callback between.
      const sealReason = sealAcceptanceEvidenceTokenSync(evidenceToken);
      if (sealReason !== null) {
        return {
          outcome: "not_committed", operationCommitted: false, taskAccepted: false,
          acceptance: null, warnings: [], reason: `the final evidence seal failed: ${sealReason}`,
          current: this.visibility(context),
        };
      }
      const commit = this.owner.commitAccepted(token, preparedRecord);
      warnings.push(...commit.warnings);
      if (commit.operationCommitted) {
        committedResult = {
          outcome: "committed",
          operationCommitted: true,
          taskAccepted: true,
          acceptance: commit.acceptance === null ? null : copyReference(commit.acceptance),
          warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: null,
          current: {
            state: "unavailable",
            taskId: expected.taskId,
            status: "accepted",
            accepted: true,
            reason: "current visibility has not been read",
          },
        };
        try {
          committedResult.current = this.visibility(context);
        } catch (error) {
          committedResult.current = {
            state: "unavailable",
            taskId: null,
            status: null,
            accepted: null,
            reason: "postcommit current visibility is unavailable",
          };
          committedResult.warnings = [
            ...committedResult.warnings,
            `postcommit_visibility_failed: ${errorMessage(error)}`,
          ].slice(0, MAX_ACCEPTANCE_WARNINGS);
        }
        return committedResult;
      }
      const current = this.visibility(context);
      if (commit.status === "unknown") {
        this.report("acceptance_commit_unknown", {
          reason: commit.reason,
          acceptanceId,
          deliveryId: selector.deliveryId,
        });
        const committedHazard = this.owner.snapshot().acceptanceHazard;
        return {
          outcome: "unknown",
          operationCommitted: null,
          taskAccepted: null,
          acceptance: null,
          warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
          reason: commit.reason ?? "the acceptance record installation outcome is unknown",
          current,
          unknown: committedHazard === null
            ? {
                task: { ...expected },
                acceptanceId,
                deliveryId: selector.deliveryId,
                recordDigest: preparedDigest,
                reason: commit.reason ?? "the acceptance record installation outcome is unknown",
              }
            : { ...committedHazard, task: { ...committedHazard.task } },
        };
      }
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: false,
        acceptance: null,
        warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
        reason: commit.reason ?? "the acceptance record was not installed",
        current,
      };
    } catch (error) {
      if (committedResult !== null) {
        committedResult.warnings = [
          ...committedResult.warnings,
          `postcommit_result_projection_failed: ${errorMessage(error)}`,
        ].slice(0, MAX_ACCEPTANCE_WARNINGS);
        return committedResult;
      }
      this.report("acceptance_submit_failed", { error: errorMessage(error).slice(0, 500) });
      return {
        outcome: "not_committed",
        operationCommitted: false,
        taskAccepted: false,
        acceptance: null,
        warnings: warnings.slice(0, MAX_ACCEPTANCE_WARNINGS),
        reason: errorMessage(error),
        current: this.visibility(context),
      };
    } finally {
      try {
        if (preparedCandidate !== null) {
          const cleanup = this.store.discard(preparedCandidate);
          if (cleanup.length > 0) this.report("acceptance_prepared_cleanup", { warnings: cleanup.slice(0, 8) });
        }
      } catch (error) {
        this.report("acceptance_prepared_cleanup_failed", { error: errorMessage(error) });
      }
      try {
        this.owner.releaseAcceptance(token);
      } catch (error) {
        this.report("acceptance_release_failed", { error: errorMessage(error) });
      }
    }
  }
}

export { MAX_ACCEPTANCE_RECORD_BYTES };
