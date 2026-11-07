import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AuditEvent } from "../../src/audit.ts";
import { parseTaskBinding } from "../../src/identity.ts";
import { loadPolicy, policyFingerprint } from "../../src/policy.ts";
import { parseCheckDelay, parseCheckMode, runPreToolCheck } from "../../src/policy-check.ts";
import { BUSINESS_TOOL, STATUS_TOOL } from "../../src/version.ts";

const FIXTURE = fileURLToPath(new URL("../../policy/development-fixture.v1.json", import.meta.url));
const bytes = await readFile(FIXTURE);
const loadedPolicy = await loadPolicy(FIXTURE, policyFingerprint(bytes));
const binding = parseTaskBinding({
  schemaVersion: 1,
  taskId: "task-1",
  taskRevision: 1,
  ownerId: "owner-1",
  runId: "run-1",
  attemptId: "attempt-1",
  executionEpoch: 1,
  workspaceRoot: "/tmp/g1a-policy-check",
});

function event(toolName: string) {
  return { toolName, toolCallId: `call-${toolName}`, input: { content: "x" } };
}

describe("pre-tool policy seam", () => {
  test("allows the read-only status tool and denies every tool outside the managed set", async () => {
    const audit: AuditEvent[] = [];
    expect(await runPreToolCheck({
      event: event(STATUS_TOOL), loadedPolicy, binding, mode: "deny", delayMs: 0,
      audit: (entry) => audit.push(entry),
    })).toBeUndefined();
    expect(await runPreToolCheck({
      event: event("bash"), loadedPolicy, binding, mode: "allow", delayMs: 0,
      audit: (entry) => audit.push(entry),
    })).toEqual({ block: true, reason: expect.stringMatching(/outside the managed policy/) });
    expect(audit.map((entry) => entry.type)).toEqual([
      "pre_tool_check_started",
      "pre_tool_check_allowed",
      "pre_tool_check_started",
      "pre_tool_check_denied",
    ]);
  });

  test("deny blocks the business action and records the decision", async () => {
    const audit: AuditEvent[] = [];
    const result = await runPreToolCheck({
      event: event(BUSINESS_TOOL), loadedPolicy, binding, mode: "deny", delayMs: 0,
      audit: (entry) => audit.push(entry),
    });
    expect(result?.block).toBe(true);
    expect(audit.at(-1)?.type).toBe("pre_tool_check_denied");
  });

  test("throw fails closed for OMP", async () => {
    const audit: AuditEvent[] = [];
    await expect(runPreToolCheck({
      event: event(BUSINESS_TOOL), loadedPolicy, binding, mode: "throw", delayMs: 0,
      audit: (entry) => audit.push(entry),
    })).rejects.toThrow(/blocked/);
    expect(audit.map((entry) => entry.type)).toContain("pre_tool_check_threw");
  });

  test("delay does not allow the business action before the check completes", async () => {
    const audit: AuditEvent[] = [];
    const started = Date.now();
    const result = await runPreToolCheck({
      event: event(BUSINESS_TOOL), loadedPolicy, binding, mode: "delay", delayMs: 40,
      audit: (entry) => audit.push(entry),
    });
    expect(result).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(audit.map((entry) => entry.type)).toEqual([
      "pre_tool_check_started",
      "pre_tool_check_delayed",
      "pre_tool_check_allowed",
    ]);
  });

  test("timeout mode is a delayed check; OMP owns the fail-closed timeout", async () => {
    const audit: AuditEvent[] = [];
    const result = await runPreToolCheck({
      event: event(BUSINESS_TOOL), loadedPolicy, binding, mode: "timeout", delayMs: 25,
      audit: (entry) => audit.push(entry),
    });
    expect(result).toBeUndefined();
    expect(audit.map((entry) => entry.type)).toContain("pre_tool_check_delayed");
  });

  test("unknown fixture modes and delays are configuration errors", () => {
    expect(parseCheckMode(undefined)).toBe("allow");
    expect(parseCheckMode("deny")).toBe("deny");
    expect(() => parseCheckMode("sometimes")).toThrow(/Unknown/);
    expect(parseCheckDelay(undefined)).toBe(5000);
    expect(parseCheckDelay("0")).toBe(0);
    expect(() => parseCheckDelay("-1")).toThrow(/delay/);
    expect(() => parseCheckDelay("1.5")).toThrow(/delay/);
  });
});
