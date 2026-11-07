import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactPathError, resolveArtifactLocation } from "./artifact-path.ts";
import { writeJsonAtomicSync } from "./host-record.ts";
import { identityOf, IDENTITY_FIELDS, type TaskBinding, type TaskIdentity } from "./identity.ts";
import type { ManagedPolicy, PolicyScope } from "./policy.ts";

export const COMPLETION_SIGNALS = ["model_done", "agent_end", "prompt_result", "session_settled"] as const;
export type CompletionSignal = (typeof COMPLETION_SIGNALS)[number];

/**
 * Completion text and host lifecycle frames are observations, never artifact
 * evidence. This helper exists so callers cannot accidentally map them to
 * acceptance.
 */
export function completionSignalIsAcceptance(_signal: CompletionSignal): false {
  return false;
}

export class AcceptanceError extends Error {
  override name = "AcceptanceError";
}

export interface PolicyEvidence {
  id: string;
  version: number;
  scope: PolicyScope;
  sha256: string;
}

export interface ArtifactEvidence {
  type: "independent-artifact-validation";
  taskIdentity: TaskIdentity;
  taskRevision: number;
  policy: PolicyEvidence;
  path: string;
  sha256: string;
  bytes: number;
  validatedAt: string;
}

export interface AcceptanceRecord {
  schemaVersion: 1;
  status: "accepted";
  acceptedAt: string;
  taskIdentity: TaskIdentity;
  taskRevision: number;
  policy: PolicyEvidence;
  verification: ArtifactEvidence;
  acceptedBy: string;
  alreadyCommitted?: boolean;
}

export interface ValidateArtifactOptions {
  binding: TaskBinding;
  policy: ManagedPolicy;
  policyFingerprint: string;
  /** Optional exact expected UTF-8 body; when omitted, file identity/digest/size are validated. */
  expectedContent?: string;
}

const RECORD_KEYS = ["schemaVersion", "status", "acceptedAt", "taskIdentity", "taskRevision", "policy", "verification", "acceptedBy"] as const;
const EVIDENCE_KEYS = ["type", "taskIdentity", "taskRevision", "policy", "path", "sha256", "bytes", "validatedAt"] as const;
const POLICY_KEYS = ["id", "version", "scope", "sha256"] as const;
const SHA256 = /^[a-f0-9]{64}$/;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcceptanceError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AcceptanceError(`${label} has unexpected or missing fields.`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new AcceptanceError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AcceptanceError(`${label} must be a positive integer.`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AcceptanceError(`${label} must be a non-negative integer.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = nonEmpty(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new AcceptanceError(`${label} must be an ISO timestamp.`);
  return text;
}

function parseTaskIdentity(value: unknown, label: string): TaskIdentity {
  const identity = object(value, label);
  exactKeys(identity, IDENTITY_FIELDS, label);
  return {
    taskId: nonEmpty(identity.taskId, `${label}.taskId`),
    taskRevision: positive(identity.taskRevision, `${label}.taskRevision`),
    ownerId: nonEmpty(identity.ownerId, `${label}.ownerId`),
    runId: nonEmpty(identity.runId, `${label}.runId`),
    attemptId: nonEmpty(identity.attemptId, `${label}.attemptId`),
    executionEpoch: positive(identity.executionEpoch, `${label}.executionEpoch`),
  };
}

function parsePolicyEvidence(value: unknown, label: string): PolicyEvidence {
  const evidence = object(value, label);
  exactKeys(evidence, POLICY_KEYS, label);
  if (evidence.scope !== "development-fixture" && evidence.scope !== "product") {
    throw new AcceptanceError(`${label}.scope is not a supported policy scope.`);
  }
  if (typeof evidence.sha256 !== "string" || !SHA256.test(evidence.sha256)) {
    throw new AcceptanceError(`${label}.sha256 must be a SHA-256 digest.`);
  }
  return {
    id: nonEmpty(evidence.id, `${label}.id`),
    version: positive(evidence.version, `${label}.version`),
    scope: evidence.scope,
    sha256: evidence.sha256,
  };
}

function parseEvidence(value: unknown, label: string): ArtifactEvidence {
  const evidence = object(value, label);
  exactKeys(evidence, EVIDENCE_KEYS, label);
  if (evidence.type !== "independent-artifact-validation") {
    throw new AcceptanceError(`${label}.type is not independent artifact validation.`);
  }
  if (typeof evidence.sha256 !== "string" || !SHA256.test(evidence.sha256)) {
    throw new AcceptanceError(`${label}.sha256 must be a SHA-256 digest.`);
  }
  return {
    type: "independent-artifact-validation",
    taskIdentity: parseTaskIdentity(evidence.taskIdentity, `${label}.taskIdentity`),
    taskRevision: positive(evidence.taskRevision, `${label}.taskRevision`),
    policy: parsePolicyEvidence(evidence.policy, `${label}.policy`),
    path: nonEmpty(evidence.path, `${label}.path`),
    sha256: evidence.sha256,
    bytes: nonNegative(evidence.bytes, `${label}.bytes`),
    validatedAt: timestamp(evidence.validatedAt, `${label}.validatedAt`),
  };
}

function parseAcceptanceRecord(value: unknown): AcceptanceRecord {
  const record = object(value, "Acceptance record");
  exactKeys(record, RECORD_KEYS, "Acceptance record");
  if (record.schemaVersion !== 1) throw new AcceptanceError("Unsupported acceptance record schemaVersion.");
  if (record.status !== "accepted") throw new AcceptanceError("Acceptance record status is not accepted.");
  const taskIdentity = parseTaskIdentity(record.taskIdentity, "Acceptance record.taskIdentity");
  const taskRevision = positive(record.taskRevision, "Acceptance record.taskRevision");
  if (taskIdentity.taskRevision !== taskRevision) {
    throw new AcceptanceError("Acceptance record taskRevision disagrees with its identity.");
  }
  const policy = parsePolicyEvidence(record.policy, "Acceptance record.policy");
  const verification = parseEvidence(record.verification, "Acceptance record.verification");
  if (verification.taskRevision !== taskRevision
    || verification.taskIdentity.taskId !== taskIdentity.taskId
    || verification.taskIdentity.taskRevision !== taskIdentity.taskRevision
    || verification.taskIdentity.ownerId !== taskIdentity.ownerId
    || verification.taskIdentity.runId !== taskIdentity.runId
    || verification.taskIdentity.attemptId !== taskIdentity.attemptId
    || verification.taskIdentity.executionEpoch !== taskIdentity.executionEpoch) {
    throw new AcceptanceError("Acceptance record verification does not bind the recorded task identity.");
  }
  if (verification.policy.id !== policy.id
    || verification.policy.version !== policy.version
    || verification.policy.scope !== policy.scope
    || verification.policy.sha256 !== policy.sha256) {
    throw new AcceptanceError("Acceptance record verification does not bind the recorded policy.");
  }
  return {
    schemaVersion: 1,
    status: "accepted",
    acceptedAt: timestamp(record.acceptedAt, "Acceptance record.acceptedAt"),
    taskIdentity,
    taskRevision,
    policy,
    verification,
    acceptedBy: nonEmpty(record.acceptedBy, "Acceptance record.acceptedBy"),
  };
}

function sameIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function samePolicy(left: PolicyEvidence, right: PolicyEvidence): boolean {
  return left.id === right.id
    && left.version === right.version
    && left.scope === right.scope
    && left.sha256 === right.sha256;
}

function expectedPolicy(policy: ManagedPolicy, policyFingerprint: string): PolicyEvidence {
  if (!SHA256.test(policyFingerprint)) throw new AcceptanceError("Policy fingerprint must be a SHA-256 digest.");
  return {
    id: policy.policyId,
    version: policy.policyVersion,
    scope: policy.scope,
    sha256: policyFingerprint,
  };
}

function mapPathError(error: unknown): never {
  if (error instanceof ArtifactPathError) {
    if (error.code === "missing") throw new AcceptanceError("No artifact exists at the policy deliverable path.");
    throw new AcceptanceError(`Deliverable path is unsafe: ${error.message}`);
  }
  throw error;
}

/**
 * Independent check performed by the host authority, outside the model loop.
 *
 * Parent components must be real directories below the canonical workspace and
 * the final component must be a regular file opened with O_NOFOLLOW. File
 * identity, size and mtime are compared across the bounded read.
 *
 * Limits: this is not an OS sandbox. A hostile same-user process can still race
 * a checked parent directory before the open; callers must not claim isolation
 * from hostile local processes.
 */
export async function validateArtifact(options: ValidateArtifactOptions): Promise<ArtifactEvidence> {
  const { binding, policy, policyFingerprint } = options;
  let location;
  try {
    location = await resolveArtifactLocation(binding.workspaceRoot, policy.managedTool.deliverablePath);
  } catch (error) {
    mapPathError(error);
  }

  let linked;
  try {
    linked = await lstat(location.absolute);
  } catch (error) {
    if (isMissing(error)) throw new AcceptanceError("No artifact exists at the policy deliverable path.");
    throw error;
  }
  if (linked.isSymbolicLink() || !linked.isFile()) throw new AcceptanceError("Deliverable must be a regular file.");
  if (linked.size > policy.managedTool.maxContentBytes) throw new AcceptanceError("Deliverable exceeds the policy size limit.");

  let handle;
  try {
    handle = await open(location.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) throw new AcceptanceError("No artifact exists at the policy deliverable path.");
    throw new AcceptanceError("Deliverable could not be opened as a regular non-linked file.");
  }
  let bytes: Buffer;
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AcceptanceError("Deliverable must be a regular file.");
    if (before.size > policy.managedTool.maxContentBytes) throw new AcceptanceError("Deliverable exceeds the policy size limit.");
    if (before.dev !== linked.dev || before.ino !== linked.ino || before.size !== linked.size || before.mtimeMs !== linked.mtimeMs) {
      throw new AcceptanceError("Deliverable changed while being validated.");
    }
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      throw new AcceptanceError("Deliverable changed while being validated.");
    }
    bytes = Buffer.from(buffer.subarray(0, offset));
  } finally {
    await handle.close();
  }

  if (options.expectedContent !== undefined && !bytes.equals(Buffer.from(options.expectedContent, "utf8"))) {
    throw new AcceptanceError("Deliverable content does not match the expected content.");
  }
  return Object.freeze({
    type: "independent-artifact-validation",
    taskIdentity: identityOf(binding),
    taskRevision: binding.taskRevision,
    policy: expectedPolicy(policy, policyFingerprint),
    path: policy.managedTool.deliverablePath,
    sha256: digest(bytes),
    bytes: bytes.length,
    validatedAt: new Date().toISOString(),
  });
}

/**
 * The sole acceptance commit path in G1-A. It validates the artifact again at
 * commit time, then writes a host-owned acceptance record. No model message,
 * agent_end, prompt_result or session_settled frame reaches this function.
 *
 * Replay first parses the complete record, then compares the full task identity,
 * task revision, policy identity/fingerprint, deliverable path and evidence
 * against fresh independent validation. A record for a different owner, run,
 * attempt, epoch or policy can never be reused.
 */
export async function commitArtifactAcceptance(input: {
  binding: TaskBinding;
  policy: ManagedPolicy;
  policyFingerprint: string;
  acceptancePath: string;
  expectedContent?: string;
  acceptedBy?: string;
}): Promise<AcceptanceRecord> {
  if (!path.isAbsolute(input.acceptancePath)) throw new AcceptanceError("Acceptance path must be absolute.");
  const identity = identityOf(input.binding);
  const policyEvidence = expectedPolicy(input.policy, input.policyFingerprint);

  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(input.acceptancePath, "utf8"));
  } catch (error) {
    if (!isMissing(error)) throw new AcceptanceError("Existing acceptance record could not be read or parsed.");
  }
  if (existing !== undefined) {
    const record = parseAcceptanceRecord(existing);
    if (!sameIdentity(record.taskIdentity, identity)
      || record.taskRevision !== input.binding.taskRevision
      || !samePolicy(record.policy, policyEvidence)) {
      throw new AcceptanceError("An acceptance record exists but does not match the current trusted task identity and policy.");
    }
    const fresh = await validateArtifact(input);
    if (record.verification.path !== fresh.path
      || record.verification.sha256 !== fresh.sha256
      || record.verification.bytes !== fresh.bytes
      || record.verification.taskRevision !== fresh.taskRevision
      || !samePolicy(record.verification.policy, fresh.policy)
      || record.verification.taskIdentity.taskId !== fresh.taskIdentity.taskId
      || record.verification.taskIdentity.taskRevision !== fresh.taskIdentity.taskRevision
      || record.verification.taskIdentity.ownerId !== fresh.taskIdentity.ownerId
      || record.verification.taskIdentity.runId !== fresh.taskIdentity.runId
      || record.verification.taskIdentity.attemptId !== fresh.taskIdentity.attemptId
      || record.verification.taskIdentity.executionEpoch !== fresh.taskIdentity.executionEpoch) {
      throw new AcceptanceError("Deliverable or its binding changed after acceptance; the existing record is stale.");
    }
    return Object.freeze({ ...record, alreadyCommitted: true });
  }

  const verification = await validateArtifact(input);
  const record: AcceptanceRecord = {
    schemaVersion: 1,
    status: "accepted",
    acceptedAt: new Date().toISOString(),
    taskIdentity: verification.taskIdentity,
    taskRevision: verification.taskRevision,
    policy: verification.policy,
    verification,
    acceptedBy: input.acceptedBy ?? "host-task-authority",
  };
  writeJsonAtomicSync(input.acceptancePath, record);
  return record;
}
