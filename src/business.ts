import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { ArtifactPathError, resolveArtifactLocation } from "./artifact-path.ts";
import type { AuditSink } from "./audit.ts";
import { IdentityError, identityOf, parseDeliverableArguments, type TaskBinding, type TaskIdentity } from "./identity.ts";
import { PolicyError, recheckLoadedPolicy, type LoadedPolicy, type ManagedPolicy, type PolicyScope } from "./policy.ts";
import { validateArtifact } from "./task-authority.ts";
import { BUSINESS_TOOL } from "./version.ts";

export class BusinessDenied extends Error {
  override name = "BusinessDenied";
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export type BusinessSideEffect = "possible" | "confirmed";

export interface BusinessFailureDetails {
  operationId?: string;
  phase: "write" | "readback" | "audit" | "unknown";
  sideEffect: BusinessSideEffect;
  replaySafe: false;
  cause?: unknown;
}

export class BusinessFailure extends Error {
  override name = "BusinessFailure";
  constructor(message: string, readonly details: BusinessFailureDetails) {
    super(message);
  }
}

export interface OperationReceipt {
  operationId: string;
  taskId: string;
  taskRevision: number;
  ownerId: string;
  runId: string;
  attemptId: string;
  executionEpoch: number;
  policyId: string;
  policyVersion: number;
  policyScope: PolicyScope;
  policySha256: string;
  path: string;
  requestSha256: string;
  sha256: string;
  bytes: number;
  appliedAt: string;
}

export class ReceiptStore {
  private readonly receipts = new Map<string, OperationReceipt>();

  get(operationId: string): OperationReceipt | undefined {
    return this.receipts.get(operationId);
  }

  record(receipt: OperationReceipt): void {
    if (this.receipts.has(receipt.operationId)) {
      throw new BusinessFailure("Refusing to replace an existing operation receipt.", {
        operationId: receipt.operationId,
        phase: "unknown",
        sideEffect: "confirmed",
        replaySafe: false,
      });
    }
    this.receipts.set(receipt.operationId, Object.freeze({ ...receipt }));
  }

  list(): OperationReceipt[] {
    return [...this.receipts.values()];
  }
}

export interface BusinessRuntime {
  loadedPolicy: LoadedPolicy;
  binding: TaskBinding;
  canonicalWorkspaceRoot: string;
  receipts: ReceiptStore;
  audit: AuditSink;
  /** Host-owned fixture revocation marker; existence denies the business action. */
  revokePath?: string;
}

export interface BusinessOutcome {
  result: {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    isError?: boolean;
  };
  receipt?: OperationReceipt;
}

function fingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationIdFor(loadedPolicy: LoadedPolicy, binding: TaskBinding): string {
  const identity = identityOf(binding);
  return `op-${createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 1,
      policyId: loadedPolicy.policy.policyId,
      policyVersion: loadedPolicy.policy.policyVersion,
      policyScope: loadedPolicy.policy.scope,
      policySha256: loadedPolicy.fingerprint,
      path: loadedPolicy.policy.managedTool.deliverablePath,
      ...identity,
    }))
    .digest("hex")
    .slice(0, 32)}`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
  return left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.ownerId === right.ownerId
    && left.runId === right.runId
    && left.attemptId === right.attemptId
    && left.executionEpoch === right.executionEpoch;
}

async function recheckRevocation(runtime: BusinessRuntime): Promise<void> {
  if (!runtime.revokePath) return;
  try {
    await lstat(runtime.revokePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw new BusinessDenied("Host revocation state could not be inspected; refusing the business action.", "revocation-unreadable");
  }
  throw new BusinessDenied("Host revoked this managed action before execution.", "revoked");
}

async function checkWorkspace(runtime: BusinessRuntime): Promise<void> {
  const resolved = await realpath(runtime.binding.workspaceRoot);
  if (resolved !== runtime.canonicalWorkspaceRoot) {
    throw new BusinessDenied("Bound workspace root changed since startup; refusing the business action.", "workspace-changed");
  }
}

function deniedPath(error: ArtifactPathError): BusinessDenied {
  if (error.code === "missing" || error.code === "changed") {
    return new BusinessDenied("Bound workspace or deliverable parent changed since startup; refusing the business action.", "workspace-changed");
  }
  return new BusinessDenied("Deliverable path is unsafe; refusing the write.", "unsafe-path");
}

/**
 * Maps an executable or business-layer failure to an honest tool result.
 * Only a known refusal before a write claims `applied: false`. Possible or
 * confirmed side effects are never presented as safely replayable.
 */
export function businessErrorOutcome(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: true;
} {
  if (error instanceof BusinessFailure) {
    const confirmed = error.details.sideEffect === "confirmed";
    return {
      content: [{
        type: "text",
        text: confirmed
          ? `Business action failed after a write may have been applied: ${error.message}`
          : `Business action failed with an uncertain side effect: ${error.message}`,
      }],
      details: {
        applied: confirmed ? true : null,
        sideEffect: error.details.sideEffect,
        outcome: "unknown",
        replaySafe: false,
        ...(error.details.operationId === undefined ? {} : { operationId: error.details.operationId }),
        phase: error.details.phase,
      },
      isError: true,
    };
  }
  if (error instanceof BusinessDenied || error instanceof IdentityError || error instanceof PolicyError) {
    return {
      content: [{ type: "text", text: `Business action denied: ${error.message}` }],
      details: {
        applied: false,
        sideEffect: "none",
        outcome: "refused",
        replaySafe: false,
        code: error instanceof BusinessDenied ? error.code : error.name,
      },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `Business action failed with an unknown outcome: ${error instanceof Error ? error.message : String(error)}` }],
    details: { applied: null, sideEffect: "unknown", outcome: "unknown", replaySafe: false },
    isError: true,
  };
}

/**
 * Actual business entry. It rechecks the policy file, host revocation, workspace
 * identity, argument shape, target existence and operation receipt before a
 * single-byte write.
 *
 * A repeated identical dispatch returns its recorded operation only while the
 * artifact still matches that receipt. A changed request under the same logical
 * operation is an explicit conflict. Any failure after the write might have
 * happened is reported as possible or confirmed side effect, never as a clean
 * refusal.
 */
export async function executeDeliverable(
  runtime: BusinessRuntime,
  rawArguments: unknown,
): Promise<BusinessOutcome> {
  const identity = identityOf(runtime.binding);
  runtime.audit({ type: "business_recheck_started", ...identity, tool: BUSINESS_TOOL });
  const policy = await recheckLoadedPolicy(runtime.loadedPolicy);
  await recheckRevocation(runtime);
  await checkWorkspace(runtime);
  runtime.audit({
    type: "business_recheck_allowed",
    ...identity,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
  });

  let args;
  try {
    args = parseDeliverableArguments(rawArguments, policy.managedTool.maxContentBytes);
  } catch (error) {
    runtime.audit({ type: "business_arguments_rejected", ...identity, reason: (error as Error).message });
    throw error;
  }

  const operationId = operationIdFor(runtime.loadedPolicy, runtime.binding);
  const bytes = Buffer.from(args.content, "utf8");
  const requestSha256 = fingerprint(bytes);
  const previous = runtime.receipts.get(operationId);
  if (previous) {
    if (!sameIdentity(previous, identity)
      || previous.policyId !== policy.policyId
      || previous.policyVersion !== policy.policyVersion
      || previous.policyScope !== policy.scope
      || previous.policySha256 !== runtime.loadedPolicy.fingerprint
      || previous.path !== policy.managedTool.deliverablePath) {
      runtime.audit({ type: "business_operation_conflict", ...identity, operationId, reason: "receipt binding mismatch" });
      throw new BusinessDenied("The recorded operation binding no longer matches; refusing the business action.", "operation-conflict");
    }
    if (previous.requestSha256 !== requestSha256) {
      runtime.audit({ type: "business_operation_conflict", ...identity, operationId, reason: "request digest mismatch" });
      throw new BusinessDenied(
        "The same logical operation was already applied with different parameters; refusing a conflicting request.",
        "operation-conflict",
      );
    }

    let currentArtifactValid = false;
    try {
      const evidence = await validateArtifact({
        binding: runtime.binding,
        policy,
        policyFingerprint: runtime.loadedPolicy.fingerprint,
        expectedContent: args.content,
      });
      currentArtifactValid = evidence.sha256 === previous.sha256 && evidence.bytes === previous.bytes;
    } catch {
      currentArtifactValid = false;
    }
    runtime.audit({
      type: "business_duplicate_dispatch",
      ...identity,
      operationId,
      path: previous.path,
      sha256: previous.sha256,
      currentArtifactValid,
    });
    if (!currentArtifactValid) {
      return {
        result: {
          content: [{
            type: "text",
            text: `Duplicate dispatch for ${operationId} was not repeated, but the current artifact no longer matches the recorded operation. Only the historic receipt is available.`,
          }],
          details: {
            applied: false,
            duplicate: true,
            currentArtifactValid: false,
            outcome: "historic-operation-status",
            operationId,
            path: previous.path,
            sha256: previous.sha256,
            replaySafe: false,
          },
          isError: true,
        },
      };
    }
    return {
      result: {
        content: [{ type: "text", text: `Duplicate dispatch for ${operationId}; the deliverable was not written again.` }],
        details: {
          applied: false,
          duplicate: true,
          currentArtifactValid: true,
          outcome: "already-applied",
          operationId,
          path: previous.path,
          sha256: previous.sha256,
          replaySafe: true,
        },
      },
    };
  }

  let location;
  try {
    location = await resolveArtifactLocation(runtime.canonicalWorkspaceRoot, policy.managedTool.deliverablePath, { createParents: true });
  } catch (error) {
    if (error instanceof ArtifactPathError) {
      runtime.audit({ type: "business_denied_unsafe_path", ...identity, operationId, reason: error.message });
      throw deniedPath(error);
    }
    throw error;
  }
  const relativePath = location.relative;
  const target = location.absolute;

  try {
    await lstat(target);
    runtime.audit({ type: "business_denied_existing_target", ...identity, operationId, path: relativePath });
    throw new BusinessDenied(
      "The deliverable already exists and has no receipt in this process; refusing to overwrite an unverified file.",
      "target-exists",
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let handle;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      runtime.audit({ type: "business_denied_existing_target", ...identity, operationId, path: relativePath });
      throw new BusinessDenied("Another operation created the deliverable concurrently; refusing to overwrite it.", "target-exists");
    }
    runtime.audit({ type: "business_denied_open_failed", ...identity, operationId, path: relativePath, reason: (error as Error).message });
    throw new BusinessDenied("Deliverable could not be created; no write occurred.", "open-failed");
  }

  let wrote = false;
  let writeFailure: unknown;
  try {
    await handle.writeFile(bytes);
    wrote = true;
    await handle.sync();
  } catch (error) {
    writeFailure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (writeFailure === undefined) writeFailure = error;
  }
  if (writeFailure !== undefined) {
    throw new BusinessFailure("Deliverable write may have partially occurred.", {
      operationId,
      phase: "write",
      sideEffect: wrote ? "confirmed" : "possible",
      replaySafe: false,
      cause: writeFailure,
    });
  }

  let verified;
  try {
    verified = await validateArtifact({
      binding: runtime.binding,
      policy,
      policyFingerprint: runtime.loadedPolicy.fingerprint,
      expectedContent: args.content,
    });
  } catch (error) {
    throw new BusinessFailure("Deliverable could not be validated after the write.", {
      operationId,
      phase: "readback",
      sideEffect: "confirmed",
      replaySafe: false,
      cause: error,
    });
  }
  if (verified.sha256 !== requestSha256 || verified.bytes !== bytes.length) {
    throw new BusinessFailure("Deliverable readback did not match the written bytes.", {
      operationId,
      phase: "readback",
      sideEffect: "confirmed",
      replaySafe: false,
    });
  }
  const sha256 = verified.sha256;

  const receipt: OperationReceipt = {
    operationId,
    ...identity,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    policyScope: policy.scope,
    policySha256: runtime.loadedPolicy.fingerprint,
    path: relativePath,
    requestSha256,
    sha256,
    bytes: bytes.length,
    appliedAt: new Date().toISOString(),
  };
  runtime.receipts.record(receipt);
  try {
    runtime.audit({
      type: "business_written",
      ...identity,
      operationId,
      path: relativePath,
      sha256,
      bytes: bytes.length,
    });
  } catch (error) {
    throw new BusinessFailure("Deliverable was written but the audit record failed.", {
      operationId,
      phase: "audit",
      sideEffect: "confirmed",
      replaySafe: false,
      cause: error,
    });
  }
  return {
    result: {
      content: [{
        type: "text",
        text: `Wrote ${relativePath} under managed operation ${operationId}. This write is not task acceptance; independent artifact validation is required.`,
      }],
      details: {
        applied: true,
        duplicate: false,
        currentArtifactValid: true,
        outcome: "applied",
        operationId,
        path: relativePath,
        sha256,
        bytes: bytes.length,
      },
    },
    receipt,
  };
}
