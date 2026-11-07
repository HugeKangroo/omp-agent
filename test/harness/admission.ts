import type { TaskIdentity } from "../../src/identity.ts";

export const EXPECTED_OMP_VERSION = "18.18.0";
export const FIXTURE_PROVIDER = "g1a-fixture";
export const FIXTURE_MODEL = "scripted";
export const FIXTURE_API = "g1a-fixture-api";

export interface AdmissionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PolicyIdentity {
  id: string;
  version: number;
  scope: string;
  sha256: string;
}

export interface AdmissionInput {
  ompVersion: string;
  expectedOmpVersion: string;
  model: { provider?: unknown; id?: unknown; api?: unknown };
  dumpTools: Array<{ name?: unknown }>;
  expectedTools: string[];
  readiness: unknown;
  readinessExists: boolean;
  expectedReadinessSchemaVersion: number;
  expectedExtensionVersion: string;
  expectedPolicy: PolicyIdentity;
  expectedIdentity: TaskIdentity;
  expectedWorkspaceRoot: string;
}

export class AdmissionError extends Error {
  override name = "AdmissionError";
  constructor(message: string, readonly checks: AdmissionCheck[]) {
    super(message);
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Pure admission gate. No prompt may be sent unless every check passes. */
export function evaluateAdmission(input: AdmissionInput): AdmissionCheck[] {
  const checks: AdmissionCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  add(
    "omp-version",
    input.ompVersion === input.expectedOmpVersion,
    `actual=${input.ompVersion} expected=${input.expectedOmpVersion}`,
  );
  add(
    "fixture-model",
    input.model.provider === FIXTURE_PROVIDER && input.model.id === FIXTURE_MODEL,
    `actual=${String(input.model.provider)}/${String(input.model.id)}`,
  );
  add(
    "fixture-non-network-api",
    input.model.api === FIXTURE_API,
    `actual=${String(input.model.api)} expected=${FIXTURE_API}`,
  );

  const actualTools = input.dumpTools.map((tool) => typeof tool.name === "string" ? tool.name : "");
  add(
    "dump-tools-exact",
    actualTools.every(Boolean) && sameStrings(actualTools, input.expectedTools),
    `actual=${actualTools.sort().join(",") || "(none)"} expected=${sortedUnique(input.expectedTools).join(",")}`,
  );

  add("readiness-exists", input.readinessExists && input.readiness !== undefined, input.readinessExists ? "present" : "missing");
  const readiness = object(input.readiness);
  add("readiness-parse", readiness !== undefined, readiness ? "parsed" : "not a JSON object");
  add(
    "readiness-schema",
    readiness?.schemaVersion === input.expectedReadinessSchemaVersion,
    `actual=${String(readiness?.schemaVersion)} expected=${input.expectedReadinessSchemaVersion}`,
  );
  add(
    "readiness-extension-version",
    readiness?.extensionVersion === input.expectedExtensionVersion,
    `actual=${String(readiness?.extensionVersion)} expected=${input.expectedExtensionVersion}`,
  );
  add("readiness-ready", readiness?.ready === true, `actual=${String(readiness?.ready)}`);
  add(
    "readiness-expected-policy-sha",
    readiness?.expectedPolicySha256 === input.expectedPolicy.sha256,
    `actual=${String(readiness?.expectedPolicySha256)} expected=${input.expectedPolicy.sha256}`,
  );

  const policy = object(readiness?.policy);
  add(
    "readiness-policy-identity",
    policy?.id === input.expectedPolicy.id
      && policy?.version === input.expectedPolicy.version
      && policy?.scope === input.expectedPolicy.scope
      && policy?.sha256 === input.expectedPolicy.sha256,
    `actual=${JSON.stringify(policy)} expected=${JSON.stringify(input.expectedPolicy)}`,
  );

  const binding = object(readiness?.binding);
  const identityFields = ["taskId", "taskRevision", "ownerId", "runId", "attemptId", "executionEpoch"] as const;
  add(
    "readiness-task-identity",
    identityFields.every((field) => binding?.[field] === input.expectedIdentity[field]),
    `actual=${JSON.stringify(binding)} expected=${JSON.stringify(input.expectedIdentity)}`,
  );
  add(
    "readiness-workspace",
    binding?.workspaceRoot === input.expectedWorkspaceRoot,
    `actual=${String(binding?.workspaceRoot)} expected=${input.expectedWorkspaceRoot}`,
  );

  const readinessTools = Array.isArray(readiness?.tools) && readiness.tools.every((tool) => typeof tool === "string")
    ? readiness.tools as string[]
    : [];
  add(
    "readiness-tools-exact",
    sameStrings(readinessTools, input.expectedTools),
    `actual=${readinessTools.sort().join(",") || "(none)"} expected=${sortedUnique(input.expectedTools).join(",")}`,
  );
  return checks;
}

export function assertAdmission(input: AdmissionInput): void {
  const checks = evaluateAdmission(input);
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) {
    throw new AdmissionError(
      `Admission failed before prompt: ${failures.map((check) => `${check.name} (${check.detail})`).join("; ")}`,
      checks,
    );
  }
}

export function parseOmpVersion(output: string): string {
  const trimmed = output.trim();
  const match = /^omp\/(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (!match) throw new AdmissionError(`Unexpected omp --version output: ${JSON.stringify(trimmed)}`, []);
  return match[1]!;
}
