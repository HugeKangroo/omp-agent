import path from "node:path";
import { BUSINESS_TOOL } from "./version.ts";

export const BINDING_SCHEMA_VERSION = 1 as const;
export const IDENTITY_FIELDS = [
  "taskId",
  "taskRevision",
  "ownerId",
  "runId",
  "attemptId",
  "executionEpoch",
] as const;

export interface TaskIdentity {
  taskId: string;
  taskRevision: number;
  ownerId: string;
  runId: string;
  attemptId: string;
  executionEpoch: number;
}

/** Host-authored binding. The README and admission tests treat every field as trusted input. */
export interface TaskBinding extends TaskIdentity {
  schemaVersion: typeof BINDING_SCHEMA_VERSION;
  workspaceRoot: string;
}

export class IdentityError extends Error {
  override name = "IdentityError";
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BINDING_KEYS = ["schemaVersion", ...IDENTITY_FIELDS, "workspaceRoot"] as const;
const IDENTITY_FORBIDDEN_IN_MODEL_ARGS = new Set<string>([
  ...IDENTITY_FIELDS,
  "schemaVersion",
  "workspaceRoot",
  "callId",
  "operationId",
  "externalOperationRef",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IdentityError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new IdentityError(`${label} must be a stable identifier of 1–128 safe characters.`);
  }
  return value;
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new IdentityError(`${label} must be a positive integer.`);
  }
  return value;
}

export function parseTaskBinding(value: unknown): TaskBinding {
  const binding = record(value, "Task binding");
  const unknown = Object.keys(binding).filter((key) => !BINDING_KEYS.includes(key as (typeof BINDING_KEYS)[number]));
  const missing = BINDING_KEYS.filter((key) => !Object.hasOwn(binding, key));
  if (unknown.length) throw new IdentityError(`Task binding has unknown field(s): ${unknown.join(", ")}.`);
  if (missing.length) throw new IdentityError(`Task binding is missing field(s): ${missing.join(", ")}.`);
  if (binding.schemaVersion !== BINDING_SCHEMA_VERSION) {
    throw new IdentityError(`Unsupported task binding schemaVersion; expected ${BINDING_SCHEMA_VERSION}.`);
  }
  const workspaceRoot = binding.workspaceRoot;
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot) || /[\x00-\x1f\x7f]/.test(workspaceRoot)) {
    throw new IdentityError("workspaceRoot must be an absolute path without control characters.");
  }
  return Object.freeze({
    schemaVersion: BINDING_SCHEMA_VERSION,
    taskId: identifier(binding.taskId, "taskId"),
    taskRevision: positive(binding.taskRevision, "taskRevision"),
    ownerId: identifier(binding.ownerId, "ownerId"),
    runId: identifier(binding.runId, "runId"),
    attemptId: identifier(binding.attemptId, "attemptId"),
    executionEpoch: positive(binding.executionEpoch, "executionEpoch"),
    workspaceRoot: path.resolve(workspaceRoot),
  });
}

export function identityOf(binding: TaskBinding): TaskIdentity {
  return Object.freeze({
    taskId: binding.taskId,
    taskRevision: binding.taskRevision,
    ownerId: binding.ownerId,
    runId: binding.runId,
    attemptId: binding.attemptId,
    executionEpoch: binding.executionEpoch,
  });
}

export function sameIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

export function sameBinding(left: TaskBinding, right: TaskBinding): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.workspaceRoot === right.workspaceRoot
    && sameIdentity(left, right);
}

/** A stale epoch or revision can never be refreshed by model-provided data. */
export function assertIdentityCurrent(candidate: TaskIdentity, current: TaskIdentity, label = "Task identity"): void {
  if (!sameIdentity(candidate, current)) {
    throw new IdentityError(`${label} does not match the current trusted binding.`);
  }
}

export interface DeliverableArguments {
  content: string;
}

/**
 * The business tool accepts content only. Every identity, call, operation and
 * workspace field is rejected here, before any filesystem access.
 */
export function parseDeliverableArguments(value: unknown, maxContentBytes: number): DeliverableArguments {
  const args = record(value, "Deliverable arguments");
  const keys = Object.keys(args);
  const identityKeys = keys.filter((key) => IDENTITY_FORBIDDEN_IN_MODEL_ARGS.has(key));
  if (identityKeys.length) {
    throw new IdentityError(
      `${BUSINESS_TOOL} never accepts identity or operation authority from model parameters: ${identityKeys.join(", ")}.`,
    );
  }
  if (keys.some((key) => key !== "content")) {
    throw new IdentityError(`${BUSINESS_TOOL} accepts only the content field.`);
  }
  if (!Object.hasOwn(args, "content") || typeof args.content !== "string") {
    throw new IdentityError(`${BUSINESS_TOOL} requires a string content field.`);
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > maxContentBytes) {
    throw new IdentityError(`Deliverable content exceeds the policy limit of ${maxContentBytes} bytes.`);
  }
  return { content: args.content };
}

export function assertNoArguments(value: unknown, label: string): void {
  const args = record(value, label);
  if (Object.keys(args).length) throw new IdentityError(`${label} accepts no arguments.`);
}
