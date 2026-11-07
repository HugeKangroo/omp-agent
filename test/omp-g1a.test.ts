import { expect, test } from "bun:test";
import path from "node:path";
import { ManagedOmpSession, type ManagedRunOptions, type RunSnapshot } from "./harness/managed-run.ts";

const integration = process.env.RUN_REAL_OMP_TEST === "1" ? test : test.skip;
const TEST_TIMEOUT = 60_000;

function auditEvents(snapshot: RunSnapshot, type: string): Array<Record<string, unknown>> {
  return snapshot.audit.filter((event) => event.type === type);
}

function fixtureEvents(snapshot: RunSnapshot, type: string): Array<Record<string, unknown>> {
  return snapshot.fixtureAudit.filter((event) => event.type === type);
}

function details(event: Record<string, unknown> | undefined): Record<string, unknown> {
  const value = event?.details;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function withSession(options: ManagedRunOptions, run: (session: ManagedOmpSession) => Promise<void>): Promise<void> {
  const session = await ManagedOmpSession.create(options);
  try {
    await run(session);
  } finally {
    await session.cleanup();
  }
}

function expectNoBusinessWrite(snapshot: RunSnapshot): void {
  expect(snapshot.workspaceFiles).toEqual([]);
  expect(snapshot.audit.filter((event) =>
    event.type === "business_written"
    || event.type === "business_recheck_allowed"
    || event.type === "business_duplicate_dispatch")).toEqual([]);
}

integration("admission fails closed before prompt for missing extension, bad policy, extra tools and enabled built-ins", async () => {
  const cases: Array<{ name: string; options: ManagedRunOptions; expectChecks: string[] }> = [
    {
      name: "missing extension",
      options: { scenario: "happy", loadExtension: false },
      expectChecks: ["dump-tools-exact", "readiness-exists"],
    },
    {
      name: "missing policy",
      options: { scenario: "happy", policyMode: "missing" },
      expectChecks: ["readiness-ready", "readiness-policy-identity"],
    },
    {
      name: "bad policy fingerprint",
      options: { scenario: "happy", policyMode: "bad-fingerprint" },
      expectChecks: ["readiness-ready", "readiness-policy-identity"],
    },
    {
      name: "invalid policy schema",
      options: { scenario: "happy", policyMode: "bad-schema" },
      expectChecks: ["readiness-ready", "readiness-policy-identity"],
    },
    {
      name: "extra extension tool",
      options: { scenario: "happy", extraTool: true },
      expectChecks: ["dump-tools-exact"],
    },
    {
      name: "enabled built-in read tool",
      options: { scenario: "happy", builtinTools: ["read"] },
      expectChecks: ["dump-tools-exact"],
    },
  ];

  for (const item of cases) {
    await withSession(item.options, async (session) => {
      const admission = await session.start();
      expect(admission.ok, `${item.name}: ${admission.error}`).toBe(false);
      const failed = new Set(admission.checks.filter((check) => !check.ok).map((check) => check.name));
      for (const check of item.expectChecks) expect(failed, `${item.name}: ${check}`).toContain(check);
      const modelChecks = admission.checks.filter((check) => check.name.startsWith("fixture-"));
      expect(modelChecks.every((check) => check.ok), `${item.name}: fixture provider not active`).toBe(true);
      expect(session.promptSent).toBe(false);
      await expect(session.prompt("This prompt must never be sent.")).rejects.toThrow(/before admission/);
      const snapshot = await session.snapshot();
      expectNoBusinessWrite(snapshot);
      expect(fixtureEvents(snapshot, "model_turn")).toEqual([]);
      expect(snapshot.workspaceEntries).toEqual([]);
    });
  }
}, 120_000);

integration("a natural-language RPC prompt performs one managed write and no background-created task", async () => {
  await withSession({ scenario: "happy", timeoutMs: 30_000 }, async (session) => {
    const admission = await session.start();
    expect(admission.ok, admission.error).toBe(true);
    const tools = (admission.state.dumpTools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(tools).toEqual(["agent_status", "agent_write_deliverable"]);
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("read");

    await session.prompt(
      "Please create the managed G1-A deliverable with the managed tool. This is an ordinary natural-language request; do not use a shell.",
    );
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceEntries).toEqual(["deliverable.txt"]);
    expect(snapshot.workspaceFiles).toHaveLength(1);
    expect(snapshot.workspaceFiles[0]!.content).toBe("G1-A fixture deliverable.\n");

    expect(auditEvents(snapshot, "business_written")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_duplicate_dispatch")).toHaveLength(1);
    // One conflict for the model's changed-content identity injection and one
    // for the background-origin write attempt.
    expect(auditEvents(snapshot, "business_operation_conflict")).toHaveLength(2);
    expect(auditEvents(snapshot, "business_arguments_rejected")).toEqual([]);
    expect(auditEvents(snapshot, "business_failure_reported")).toHaveLength(2);

    const status = snapshot.status as Record<string, any>;
    expect(status.taskStatus).toBe("open");
    expect(status.acceptance).toBe("not-evaluated");
    expect(status.taskRevision).toBe(session.binding.taskRevision);
    expect(status.taskIdentity).toEqual({
      taskId: session.binding.taskId,
      taskRevision: session.binding.taskRevision,
      ownerId: session.binding.ownerId,
      runId: session.binding.runId,
      attemptId: session.binding.attemptId,
      executionEpoch: session.binding.executionEpoch,
    });
    expect(status.operations).toHaveLength(1);
    expect(status.operations[0]).toMatchObject({
      taskId: session.binding.taskId,
      ownerId: session.binding.ownerId,
      runId: session.binding.runId,
      attemptId: session.binding.attemptId,
      executionEpoch: session.binding.executionEpoch,
      path: "deliverable.txt",
    });
    expect(status.modelClaims.some((claim: { completionLike: boolean }) => claim.completionLike)).toBe(true);
    expect(snapshot.acceptance).toBeUndefined();
    // Identity fields supplied by the model, including the background attempt,
    // never reached task state. OMP's schema filters them before execution.
    expect(JSON.stringify(status)).not.toContain("attacker");
    expect(JSON.stringify(status)).not.toContain("background-owner");
    expect(JSON.stringify(snapshot.audit)).not.toContain("attacker");
    expect(JSON.stringify(snapshot.audit)).not.toContain("background-owner");

    expect(fixtureEvents(snapshot, "background_injected")).toHaveLength(1);
    expect(snapshot.frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(true);
    expect(snapshot.frames.some((frame) => frame.type === "session_settled")).toBe(true);
    expect(snapshot.frames.some((frame) => frame.type === "message_end"
      && JSON.stringify(frame.message).includes("BACKGROUND_SEEN"))).toBe(true);

    const accepted = await session.commitAcceptance("G1-A fixture deliverable.\n");
    expect(accepted.status).toBe("accepted");
    expect(accepted.taskIdentity.ownerId).toBe(session.binding.ownerId);
  });
}, TEST_TIMEOUT);

integration("changed parameters in a real duplicate dispatch are a conflict, not a successful no-op", async () => {
  await withSession({ scenario: "duplicate-conflict", timeoutMs: 20_000 }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Write the managed deliverable once.");
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceFiles).toHaveLength(1);
    expect(snapshot.workspaceFiles[0]!.content).toBe("duplicate-conflict deliverable\n");
    expect(auditEvents(snapshot, "business_written")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_operation_conflict")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_duplicate_dispatch")).toHaveLength(0);
    const status = snapshot.status as Record<string, any>;
    expect(status.operations).toHaveLength(1);
  });
}, TEST_TIMEOUT);

integration("tool_call deny, throw, timeout and delay are enforced with zero denied writes", async () => {
  const denied = [
    { scenario: "hook-deny", checkMode: "deny" as const, auditType: "pre_tool_check_denied" },
    { scenario: "hook-throw", checkMode: "throw" as const, auditType: "pre_tool_check_threw" },
  ];
  for (const item of denied) {
    await withSession({ scenario: item.scenario, checkMode: item.checkMode, timeoutMs: 20_000 }, async (session) => {
      expect((await session.start()).ok).toBe(true);
      await session.prompt("Attempt the managed write.");
      const snapshot = await session.snapshot();
      expect(fixtureEvents(snapshot, "tool_call_emitted")).toHaveLength(1);
      expect(auditEvents(snapshot, item.auditType)).toHaveLength(1);
      expectNoBusinessWrite(snapshot);
      expect(snapshot.workspaceEntries).toEqual([]);
    });
  }

  await withSession({
    scenario: "hook-timeout",
    checkMode: "timeout",
    checkDelayMs: 5_000,
    toolCallTimeoutMs: 300,
    timeoutMs: 20_000,
  }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Attempt the managed write through a timed-out check.");
    const snapshot = await session.snapshot();
    expect(fixtureEvents(snapshot, "tool_call_emitted")).toHaveLength(1);
    expect(auditEvents(snapshot, "pre_tool_check_delayed")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_recheck_started")).toEqual([]);
    expectNoBusinessWrite(snapshot);
    expect(snapshot.workspaceEntries).toEqual([]);
    const ends = snapshot.frames.filter((frame) => frame.type === "tool_execution_end" && frame.toolName === "agent_write_deliverable");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(ends.some((frame) => frame.isError === true)).toBe(true);
  });

  await withSession({
    scenario: "hook-delay",
    checkMode: "delay",
    checkDelayMs: 250,
    timeoutMs: 20_000,
  }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Attempt the managed write after a delayed check.");
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceFiles).toHaveLength(1);
    expect(snapshot.workspaceFiles[0]!.content).toBe("hook-delay deliverable\n");
    const allowed = auditEvents(snapshot, "pre_tool_check_allowed");
    expect(allowed).toHaveLength(1);
    expect(Number(allowed[0]!.elapsedMs)).toBeGreaterThanOrEqual(200);
    expect(auditEvents(snapshot, "business_written")).toHaveLength(1);
  });
}, 120_000);

integration("a host revocation after admission is denied by the business recheck with zero writes", async () => {
  await withSession({ scenario: "business-recheck", revoke: true, timeoutMs: 20_000 }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Attempt the managed write against a revoked host grant.");
    const snapshot = await session.snapshot();
    expect(auditEvents(snapshot, "pre_tool_check_allowed")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_recheck_started")).toHaveLength(1);
    expect(auditEvents(snapshot, "business_recheck_allowed")).toEqual([]);
    const reported = auditEvents(snapshot, "business_failure_reported");
    expect(reported).toHaveLength(1);
    expect(details(reported[0])).toMatchObject({
      applied: false,
      sideEffect: "none",
      outcome: "refused",
      replaySafe: false,
      code: "revoked",
    });
    expectNoBusinessWrite(snapshot);
    expect(snapshot.workspaceEntries).toEqual([]);
  });
}, TEST_TIMEOUT);

integration("a fabricated model success without an artifact never becomes acceptance", async () => {
  await withSession({ scenario: "claim-only", timeoutMs: 20_000 }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Complete the managed task now.");
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceEntries).toEqual([]);
    expect(auditEvents(snapshot, "model_claim_recorded").some((event) => event.completionLike === true)).toBe(true);
    expect(auditEvents(snapshot, "business_written")).toEqual([]);
    const status = snapshot.status as Record<string, any>;
    expect(status.taskStatus).toBe("open");
    expect(status.acceptance).toBe("not-evaluated");
    expect(status.operations).toEqual([]);
    expect(snapshot.acceptance).toBeUndefined();
    expect(snapshot.frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(true);
    await expect(session.commitAcceptance()).rejects.toThrow(/No artifact/);
    const after = await session.snapshot();
    expect(after.acceptance).toBeUndefined();
    expect((after.status as Record<string, any>).taskStatus).toBe("open");
  });
}, TEST_TIMEOUT);

integration("a persistently unavailable audit store cannot swallow a confirmed post-write outcome", async () => {
  await withSession({
    scenario: "audit-fault-persistent",
    auditFailOn: "business_written_persistent",
    timeoutMs: 20_000,
  }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Write the managed deliverable; the host audit store remains unavailable after the write.");
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceFiles).toHaveLength(1);
    expect(snapshot.workspaceFiles[0]!.content).toBe("audit-fault-persistent deliverable\n");
    expect(auditEvents(snapshot, "business_written")).toEqual([]);
    expect(auditEvents(snapshot, "business_failure_reported")).toEqual([]);

    const ends = snapshot.frames.filter((frame) =>
      frame.type === "tool_execution_end"
      && frame.toolName === "agent_write_deliverable"
      && frame.toolCallId === "audit-fault-persistent-write");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
    const result = ends[0]!.result as Record<string, unknown> | undefined;
    const outcome = details(result);
    expect(outcome).toMatchObject({
      applied: true,
      sideEffect: "confirmed",
      outcome: "unknown",
      replaySafe: false,
      phase: "audit",
    });
    expect(String(outcome.operationId)).toMatch(/^op-/);
    expect(snapshot.stderr).toContain("audit_write_failed");
    expect(snapshot.stderr).toContain("persists");
    expect(snapshot.frames.filter((frame) => frame.type === "extension_error")).toEqual([]);

    const status = snapshot.status as Record<string, any>;
    expect(status.taskStatus).toBe("open");
    expect(status.acceptance).toBe("not-evaluated");
    expect(snapshot.acceptance).toBeUndefined();
  });
}, TEST_TIMEOUT);

integration("a provider failure is not a zero-write refusal success, even with prior prompt frames", async () => {
  await withSession({
    scenario: "provider-error-second",
    checkMode: "deny",
    timeoutMs: 20_000,
  }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Attempt the managed write against the denying host check.");
    const first = await session.snapshot();
    expect(auditEvents(first, "pre_tool_check_denied")).toHaveLength(1);
    expectNoBusinessWrite(first);
    const firstResults = first.frames.filter((frame) => frame.type === "prompt_result");
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]).toMatchObject({ status: "completed", agentInvoked: true });

    await expect(session.prompt("The fixture provider must fail this second run."))
      .rejects.toThrow(/provider failure|Fixture provider failed/);
    const snapshot = await session.snapshot();
    expect(fixtureEvents(snapshot, "tool_call_emitted")).toHaveLength(1);
    expect(fixtureEvents(snapshot, "provider_error_emitted")).toHaveLength(1);
    expectNoBusinessWrite(snapshot);
    expect(auditEvents(snapshot, "pre_tool_check_denied")).toHaveLength(1);

    const results = snapshot.frames.filter((frame) => frame.type === "prompt_result");
    expect(results).toHaveLength(2);
    expect(results[1]!.id).not.toBe(results[0]!.id);
    expect(results[1]).toMatchObject({ status: "error", agentInvoked: true });
    expect(JSON.stringify(results[1]!.error)).toContain("Fixture provider failed");
  });
}, TEST_TIMEOUT);

integration("an injected audit failure after a real write reports a confirmed side effect through the extension", async () => {
  await withSession({
    scenario: "audit-fault",
    auditFailOn: "business_written",
    timeoutMs: 20_000,
  }, async (session) => {
    expect((await session.start()).ok).toBe(true);
    await session.prompt("Write the managed deliverable; the host will fail its own audit sink afterward.");
    const snapshot = await session.snapshot();
    expect(snapshot.workspaceFiles).toHaveLength(1);
    expect(snapshot.workspaceFiles[0]!.content).toBe("audit-fault deliverable\n");
    expect(auditEvents(snapshot, "business_written")).toEqual([]);
    const reported = auditEvents(snapshot, "business_failure_reported");
    expect(reported).toHaveLength(1);
    const outcome = details(reported[0]);
    expect(outcome).toMatchObject({
      applied: true,
      sideEffect: "confirmed",
      outcome: "unknown",
      replaySafe: false,
      phase: "audit",
    });
    expect(String(outcome.operationId)).toMatch(/^op-/);
    const status = snapshot.status as Record<string, any>;
    expect(status.taskStatus).toBe("open");
    expect(status.acceptance).toBe("not-evaluated");
    expect(snapshot.acceptance).toBeUndefined();
    expect(snapshot.frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(true);
    expect(path.basename(snapshot.workspaceFiles[0]!.path)).toBe("deliverable.txt");
  });
}, TEST_TIMEOUT);
