import type { OperationReceipt } from "./business.ts";
import { writeJsonAtomicSync } from "./host-record.ts";
import { identityOf, type TaskBinding, type TaskIdentity } from "./identity.ts";
import type { LoadedPolicy, PolicyScope } from "./policy.ts";
import { TASK_STATE_SCHEMA_VERSION } from "./version.ts";

export type SessionSignal = "agent_end" | "session_start" | "session_shutdown";

export interface ModelClaim {
  text: string;
  completionLike: boolean;
  recordedAt: string;
}

export interface TaskStateSnapshot {
  schemaVersion: typeof TASK_STATE_SCHEMA_VERSION;
  taskStatus: "open";
  taskIdentity: TaskIdentity;
  taskRevision: number;
  stateSaves: number;
  policy: { id: string; version: number; scope: PolicyScope; sha256: string };
  operations: OperationReceipt[];
  modelClaims: ModelClaim[];
  sessionEvents: SessionSignal[];
  acceptance: "not-evaluated";
}

/**
 * G1-A task state inside OMP is intentionally non-authoritative: it can record
 * observations and operation receipts but has no transition to an accepted
 * status. Only the host authority can commit acceptance after independent
 * artifact validation.
 */
export class TaskState {
  readonly taskRevision: number;
  private stateSaves = 0;
  private readonly claims: ModelClaim[] = [];
  private readonly sessions: SessionSignal[] = [];
  private readonly operations: OperationReceipt[] = [];

  constructor(
    readonly binding: TaskBinding,
    readonly policy: LoadedPolicy,
  ) {
    this.taskRevision = binding.taskRevision;
  }

  recordModelClaim(text: string): void {
    const clipped = text.trim().slice(0, 4000);
    if (!clipped) return;
    this.claims.push({
      text: clipped,
      completionLike: /\b(done|complete|completed|finished|success)\b/i.test(clipped),
      recordedAt: new Date().toISOString(),
    });
    if (this.claims.length > 20) this.claims.shift();
  }

  recordSessionSignal(signal: SessionSignal): void {
    if (!this.sessions.includes(signal)) this.sessions.push(signal);
  }

  recordOperation(receipt: OperationReceipt): void {
    if (!this.operations.some((item) => item.operationId === receipt.operationId)) {
      this.operations.push({ ...receipt });
    }
  }

  snapshot(): TaskStateSnapshot {
    return {
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      taskStatus: "open",
      taskIdentity: identityOf(this.binding),
      taskRevision: this.taskRevision,
      stateSaves: this.stateSaves,
      policy: {
        id: this.policy.policy.policyId,
        version: this.policy.policy.policyVersion,
        scope: this.policy.policy.scope,
        sha256: this.policy.fingerprint,
      },
      operations: this.operations.map((operation) => ({ ...operation })),
      modelClaims: this.claims.map((claim) => ({ ...claim })),
      sessionEvents: [...this.sessions],
      acceptance: "not-evaluated",
    };
  }

  /** Persistence saves cannot change taskRevision, status, or acceptance. */
  persist(filePath: string): TaskStateSnapshot {
    this.stateSaves += 1;
    const snapshot = this.snapshot();
    writeJsonAtomicSync(filePath, snapshot);
    return snapshot;
  }
}
