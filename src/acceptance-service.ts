import { createHash, randomUUID } from "node:crypto";
import type { ExecutionActivitySnapshot } from "./execution-adapter.ts";
import {
  type AcceptanceContractEvidence,
  type AcceptanceEvidence,
  type DeliveryService,
  sealAcceptanceEvidenceTokenSync,
} from "./delivery-service.ts";
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
  now?: () => string;
  id?: () => string;
  diagnostic?: (message: string, details?: Record<string, unknown>) => void;
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
function privateEvidence(value: AcceptanceEvidence): AcceptanceEvidence {
  const copy = structuredClone(value) as AcceptanceEvidence;
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    Object.freeze(item);
    for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
  };
  freeze(copy);
  return copy;
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
    this.diagnostic = options.diagnostic ?? ((message, details) => {
      try {
        process.stderr.write(`${JSON.stringify({ type: "omp_agent_acceptance", message, ...(details === undefined ? {} : { details }) })}\n`);
      } catch {
        // A diagnostic channel is not guaranteed.
      }
    });
  }

  dispose(): void {
    this.disposed = true;
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
