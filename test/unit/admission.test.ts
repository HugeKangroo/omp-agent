import { describe, expect, test } from "bun:test";
import {
  assertAdmission,
  evaluateAdmission,
  FIXTURE_API,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  parseOmpVersion,
  type AdmissionInput,
} from "../harness/admission.ts";
import type { TaskIdentity } from "../../src/identity.ts";
import { EXTENSION_VERSION, READINESS_SCHEMA_VERSION } from "../../src/version.ts";

const identity: TaskIdentity = {
  taskId: "task-1",
  taskRevision: 1,
  ownerId: "owner-1",
  runId: "run-1",
  attemptId: "attempt-1",
  executionEpoch: 1,
};
const policy = { id: "omp-agent.g1a-development-fixture", version: 1, scope: "development-fixture", sha256: "a".repeat(64) };
const tools = ["agent_status", "agent_write_deliverable"];

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    ompVersion: "18.18.0",
    expectedOmpVersion: "18.18.0",
    model: { provider: FIXTURE_PROVIDER, id: FIXTURE_MODEL, api: FIXTURE_API },
    dumpTools: tools.map((name) => ({ name })),
    expectedTools: tools,
    readiness: {
      schemaVersion: READINESS_SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      ready: true,
      tools,
      policy,
      binding: { ...identity, workspaceRoot: "/tmp/workspace" },
      expectedPolicySha256: policy.sha256,
    },
    readinessExists: true,
    expectedReadinessSchemaVersion: READINESS_SCHEMA_VERSION,
    expectedExtensionVersion: EXTENSION_VERSION,
    expectedPolicy: policy,
    expectedIdentity: identity,
    expectedWorkspaceRoot: "/tmp/workspace",
    ...overrides,
  };
}

function failed(value: AdmissionInput): string[] {
  return evaluateAdmission(value).filter((check) => !check.ok).map((check) => check.name);
}

describe("pre-prompt admission", () => {
  test("passes only when version, fixture model, exact tools, readiness, policy and identity all match", () => {
    expect(failed(input())).toEqual([]);
    expect(() => assertAdmission(input())).not.toThrow();
  });

  test("rejects version and network model mismatches", () => {
    expect(failed(input({ ompVersion: "18.17.0" }))).toContain("omp-version");
    expect(failed(input({ model: { provider: "deepseek", id: "chat", api: "openai-completions" } })))
      .toEqual(expect.arrayContaining(["fixture-model", "fixture-non-network-api"]));
  });

  test("rejects extra and missing actual tools before any prompt", () => {
    expect(failed(input({ dumpTools: [...tools, "read"].map((name) => ({ name })) }))).toContain("dump-tools-exact");
    expect(failed(input({ dumpTools: [{ name: "agent_status" }] }))).toContain("dump-tools-exact");
    expect(failed(input({ dumpTools: [] }))).toContain("dump-tools-exact");
  });

  test("rejects missing readiness, an unready extension and policy/identity drift", () => {
    expect(failed(input({ readinessExists: false, readiness: undefined }))).toEqual(expect.arrayContaining(["readiness-exists", "readiness-parse"]));
    expect(failed(input({ readiness: { ...(input().readiness as object), ready: false } }))).toContain("readiness-ready");
    expect(failed(input({ readiness: { ...(input().readiness as object), schemaVersion: 2 } }))).toContain("readiness-schema");
    expect(failed(input({ readiness: { ...(input().readiness as object), extensionVersion: "0.0.0" } }))).toContain("readiness-extension-version");
    expect(failed(input({ readiness: { ...(input().readiness as object), expectedPolicySha256: "c".repeat(64) } }))).toContain("readiness-expected-policy-sha");
    expect(failed(input({ readiness: { ...(input().readiness as object), policy: { ...policy, sha256: "b".repeat(64) } } }))).toContain("readiness-policy-identity");
    expect(failed(input({ readiness: { ...(input().readiness as object), binding: { ...identity, taskRevision: 2, workspaceRoot: "/tmp/workspace" } } }))).toContain("readiness-task-identity");
    expect(failed(input({ expectedWorkspaceRoot: "/tmp/other" }))).toContain("readiness-workspace");
    expect(failed(input({ readiness: { ...(input().readiness as object), tools: ["agent_status"] } }))).toContain("readiness-tools-exact");
  });

  test("assertAdmission refuses admission with the failed check names", () => {
    expect(() => assertAdmission(input({ ompVersion: "18.17.0" }))).toThrow(/omp-version/);
  });

  test("parses only the installed OMP version envelope", () => {
    expect(parseOmpVersion("omp/18.18.0\n")).toBe("18.18.0");
    expect(() => parseOmpVersion("18.18.0")).toThrow(/version output/);
    expect(() => parseOmpVersion("omp/18.18.0-beta.1")).toThrow(/version output/);
  });
});

