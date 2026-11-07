import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { BUSINESS_TOOL, STATUS_TOOL } from "./version.ts";

export const POLICY_SCHEMA_VERSION = 1 as const;
export const MAX_POLICY_BYTES = 64 * 1024;
export const MAX_DELIVERABLE_BYTES = 1024 * 1024;

export type PolicyScope = "development-fixture" | "product";

/** Host-owned policy. Model parameters can never supply or amend these fields. */
export interface ManagedPolicy {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  policyId: string;
  policyVersion: number;
  scope: PolicyScope;
  description: string;
  managedTool: {
    name: typeof BUSINESS_TOOL;
    deliverablePath: string;
    maxContentBytes: number;
  };
  preToolCheck: {
    required: true;
    businessToolRecheck: true;
  };
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

export interface LoadedPolicy {
  policy: ManagedPolicy;
  readonly fingerprint: string;
  readonly filePath: string;
}

const POLICY_KEYS = ["schemaVersion", "policyId", "policyVersion", "scope", "description", "managedTool", "preToolCheck"] as const;
const TOOL_KEYS = ["name", "deliverablePath", "maxContentBytes"] as const;
const CHECK_KEYS = ["required", "businessToolRecheck"] as const;
const POLICY_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
const FORBIDDEN_SEGMENTS = new Set([".", "..", ".git", ".omp", ".pi", ".ssh", ".aws", ".gnupg", "node_modules"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new PolicyError(`${label} has unknown field(s): ${unknown.join(", ")}.`);
  if (missing.length) throw new PolicyError(`${label} is missing field(s): ${missing.join(", ")}.`);
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PolicyError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function deliverablePath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\x00-\x1f\x7f\\]/.test(value)) {
    throw new PolicyError("managedTool.deliverablePath must be a relative POSIX path without control characters.");
  }
  if (path.isAbsolute(value)) throw new PolicyError("managedTool.deliverablePath must be relative.");
  const segments = value.split("/");
  if (segments.some((segment) => !SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new PolicyError("managedTool.deliverablePath contains an unsafe or control-directory segment.");
  }
  return segments.join("/");
}

export function parsePolicy(value: unknown): ManagedPolicy {
  const policy = record(value, "Policy");
  exactKeys(policy, POLICY_KEYS, "Policy");
  if (policy.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new PolicyError(`Unsupported policy schemaVersion; expected ${POLICY_SCHEMA_VERSION}.`);
  }
  if (typeof policy.policyId !== "string" || !POLICY_ID.test(policy.policyId)) {
    throw new PolicyError("policyId must be a stable lowercase identifier of 3–128 characters.");
  }
  const policyVersion = positiveInteger(policy.policyVersion, "policyVersion", 1_000_000);
  if (policy.scope !== "development-fixture" && policy.scope !== "product") {
    throw new PolicyError('scope must be "development-fixture" or "product".');
  }
  if (typeof policy.description !== "string" || policy.description.length < 1 || policy.description.length > 1000) {
    throw new PolicyError("description must contain 1–1000 characters.");
  }
  const tool = record(policy.managedTool, "managedTool");
  exactKeys(tool, TOOL_KEYS, "managedTool");
  if (tool.name !== BUSINESS_TOOL) {
    throw new PolicyError(`managedTool.name must be ${BUSINESS_TOOL}.`);
  }
  const maxContentBytes = positiveInteger(tool.maxContentBytes, "managedTool.maxContentBytes", MAX_DELIVERABLE_BYTES);
  const check = record(policy.preToolCheck, "preToolCheck");
  exactKeys(check, CHECK_KEYS, "preToolCheck");
  if (check.required !== true || check.businessToolRecheck !== true) {
    throw new PolicyError("preToolCheck.required and preToolCheck.businessToolRecheck must both be true.");
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    policyId: policy.policyId,
    policyVersion,
    scope: policy.scope,
    description: policy.description,
    managedTool: Object.freeze({
      name: BUSINESS_TOOL,
      deliverablePath: deliverablePath(tool.deliverablePath),
      maxContentBytes,
    }),
    preToolCheck: Object.freeze({ required: true, businessToolRecheck: true }),
  });
}

export function policyFingerprint(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalFingerprint(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/**
 * Loads exactly one host-selected policy file and binds it to the expected
 * content fingerprint. A changed file, schema drift, or missing expectation is
 * a startup failure; there is no permissive fallback.
 */
export async function loadPolicy(filePath: string, expectedFingerprint: string): Promise<LoadedPolicy> {
  if (!path.isAbsolute(filePath)) throw new PolicyError("Policy path must be absolute and host-selected.");
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new PolicyError("Expected policy fingerprint must be a 64-character lowercase SHA-256 digest.");
  }
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    throw new PolicyError("Policy file does not exist.");
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new PolicyError("Policy path must be a regular file, not a link.");
  if (info.size > MAX_POLICY_BYTES) throw new PolicyError(`Policy file exceeds ${MAX_POLICY_BYTES} bytes.`);
  const bytes = await readFile(filePath);
  const fingerprint = policyFingerprint(bytes);
  if (!equalFingerprint(fingerprint, expectedFingerprint)) {
    throw new PolicyError("Policy fingerprint does not match the host expectation.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PolicyError("Policy file is not valid UTF-8 JSON.");
  }
  return Object.freeze({ policy: parsePolicy(parsed), fingerprint, filePath });
}

/** Rechecks the on-disk policy at the business execution boundary. */
export async function recheckLoadedPolicy(loaded: LoadedPolicy): Promise<ManagedPolicy> {
  const current = await loadPolicy(loaded.filePath, loaded.fingerprint);
  if (current.policy.policyId !== loaded.policy.policyId
    || current.policy.policyVersion !== loaded.policy.policyVersion
    || current.policy.scope !== loaded.policy.scope
    || current.policy.managedTool.deliverablePath !== loaded.policy.managedTool.deliverablePath
    || current.policy.managedTool.maxContentBytes !== loaded.policy.managedTool.maxContentBytes) {
    throw new PolicyError("Policy semantics changed after startup; refusing the business operation.");
  }
  return current.policy;
}

export function policyIdentity(loaded: LoadedPolicy): { id: string; version: number; scope: PolicyScope; sha256: string } {
  return { id: loaded.policy.policyId, version: loaded.policy.policyVersion, scope: loaded.policy.scope, sha256: loaded.fingerprint };
}

export const POLICY_TOOL_NAMES = Object.freeze([STATUS_TOOL, BUSINESS_TOOL]);
