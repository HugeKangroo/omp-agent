import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JobAdapter,
  JobAdapterError,
  MAX_TOOL_RESULT_BYTES,
  parseJobToolArguments,
} from "../../src/job-adapter.ts";
import { TaskOwner, type TaskSubject } from "../../src/task-owner.ts";
import type { OmpToolContext } from "../../src/task-entry-port.ts";
import { MockJobService } from "../harness/job-service.ts";

const WORKSPACE = "/tmp/omp-agent-b3a-unit-workspace";
const SESSION = "session-b3a-job-unit";
const NOW = "2026-11-08T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

function assistant(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  };
}

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

function contextFor(branch: readonly unknown[], sessionId = SESSION): OmpToolContext {
  return {
    cwd: WORKSPACE,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => (branch.at(-1) as Entry | undefined)?.id ?? null,
      getBranch: () => branch,
    },
  };
}

function ownerWith(callbacks: {
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
  onStateChange?: (snapshot: ReturnType<TaskOwner["snapshot"]>) => void;
} = {}): TaskOwner {
  let sequence = 0;
  return new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: "owner-b3a-job-unit",
    authorizedCapabilities: ["job-submit"],
    now: () => NOW,
    id: () => `id-${++sequence}`,
    ...(callbacks.onEvent === undefined ? {} : { onEvent: callbacks.onEvent }),
    ...(callbacks.onStateChange === undefined ? {} : { onStateChange: callbacks.onStateChange }),
  });
}

function newOwner(): TaskOwner {
  return ownerWith();
}

function startTask(owner: TaskOwner): { taskId: string; branch: Entry[] } {
  const branch = [base(), user("user-1", "leaf-1", "Please run the one job.")];
  owner.observeInput({
    sessionId: SESSION, workspaceRoot: WORKSPACE, source: "rpc",
    text: "Please run the one job.", observedAt: NOW, baseLeafId: "leaf-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Please run the one job.", reason: "prompt" });
  const created = owner.start(subject(branch));
  return { taskId: created.task.taskId, branch };
}

function cancelTask(owner: TaskOwner, firstBranch: readonly Entry[]): Entry[] {
  owner.closeTurn({
    sessionId: SESSION,
    branch: firstBranch,
    messages: [{ ...(user("user-1", "leaf-1", "Please run the one job.").message as Record<string, unknown>), id: "user-1" }],
  });
  const branch = [
    ...firstBranch,
    assistant("assistant-1", "user-1"),
    user("user-2", "assistant-1", "Please cancel the managed task."),
  ];
  owner.observeInput({
    sessionId: SESSION, workspaceRoot: WORKSPACE, source: "rpc",
    text: "Please cancel the managed task.", observedAt: NOW, baseLeafId: "assistant-1",
  });
  owner.observeAgentStart({ sessionId: SESSION, prompt: "Please cancel the managed task.", reason: "prompt" });
  owner.cancel(subject(branch));
  return branch;
}

async function waitFor<T>(label: string, predicate: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`${label}: timed out`);
    await Bun.sleep(20);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setupWithOwnerCallbacks(callbacks: {
  onEvent?: (event: Record<string, unknown> & { type: string }) => void;
  onStateChange?: (snapshot: ReturnType<TaskOwner["snapshot"]>) => void;
}): Promise<{
  service: MockJobService;
  owner: TaskOwner;
  adapter: JobAdapter;
  branch: Entry[];
  recordPath: string;
}> {
  const service = await MockJobService.start();
  const root = await mkdtemp(path.join(tmpdir(), "omp-agent-b3a-job-"));
  const recordPath = path.join(root, "record.json");
  const owner = ownerWith(callbacks);
  const { branch } = startTask(owner);
  const adapter = new JobAdapter(owner, {
    endpoint: service.endpoint,
    recordPath,
    capabilityId: "job-submit",
    timeoutMs: 1_000,
    now: () => NOW,
    id: (() => { let n = 0; return () => `fixed-${++n}`; })(),
  });
  cleanups.push(async () => {
    adapter.dispose();
    await service.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { service, owner, adapter, branch, recordPath };
}

async function setup(): Promise<{
  service: MockJobService;
  owner: TaskOwner;
  adapter: JobAdapter;
  taskId: string;
  branch: Entry[];
  recordPath: string;
}> {
  const service = await MockJobService.start();
  const root = await mkdtemp(path.join(tmpdir(), "omp-agent-b3a-job-"));
  const recordPath = path.join(root, "record.json");
  const owner = newOwner();
  const { taskId, branch } = startTask(owner);
  const adapter = new JobAdapter(owner, {
    endpoint: service.endpoint,
    recordPath,
    capabilityId: "job-submit",
    timeoutMs: 1_000,
    now: () => NOW,
    id: (() => { let n = 0; return () => `fixed-${++n}`; })(),
  });
  cleanups.push(async () => {
    adapter.dispose();
    await service.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { service, owner, adapter, taskId, branch, recordPath };
}

describe("agent_job argument surface", () => {
  test("accepts only the narrow submit/query surface and rejects host authority", () => {
    expect(parseJobToolArguments({ action: "submit", expectedTaskRevision: 1, payload: "alpha" }))
      .toEqual({ action: "submit", expectedTaskRevision: 1, payload: "alpha" });
    expect(parseJobToolArguments({ action: "query" })).toEqual({ action: "query" });
    for (const key of ["operationId", "jobId", "taskId", "ownerId", "endpoint", "cancelIntentId", "fault", "budget"]) {
      expect(() => parseJobToolArguments({ action: "query", [key]: "x" })).toThrow(/never accepts host\/job authority/);
    }
    expect(() => parseJobToolArguments({ action: "cancel" })).toThrow(/submit or query/);
    expect(() => parseJobToolArguments({ action: "submit", expectedTaskRevision: 1, payload: "x", extra: true }))
      .toThrow(/unsupported field/);
    expect(() => parseJobToolArguments({ action: "submit", expectedTaskRevision: 0, payload: "x" }))
      .toThrow(/positive integer/);
    expect(() => parseJobToolArguments({ action: "submit", expectedTaskRevision: 1, payload: "x".repeat(4097) }))
      .toThrow(/exceeds 4096 UTF-8 bytes/);
    expect(() => parseJobToolArguments({ action: "submit", expectedTaskRevision: 1, payload: "x".repeat(4096) }))
      .not.toThrow();
  });
});

describe("independent mock service protocol", () => {
  test("same operation id and digest is idempotent; changed digest conflicts", async () => {
    const service = await MockJobService.start();
    cleanups.push(() => service.cleanup());
    const submit = (digest: string, payload: string) => fetch(`${service.endpoint}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op-http-1", digest, payload }),
    });
    const first = await submit("sha256:a", "alpha");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as Record<string, unknown>;
    const second = await submit("sha256:a", "alpha");
    expect(second.status).toBe(200);
    const secondBody = await second.json() as Record<string, unknown>;
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    const changed = await submit("sha256:b", "beta");
    expect(changed.status).toBe(409);
    const stats = await service.stats();
    expect(stats.counters.actualCreates).toBe(1);
    expect(stats.counters.submitRequests).toBe(3);
    expect((await fetch(`${service.endpoint}/jobs/missing`)).status).toBe(404);
  });

  test("held submit reserves operation identity: equal content coalesces, changed digest conflicts", async () => {
    const service = await MockJobService.start();
    cleanups.push(() => service.cleanup());
    await service.configure({ holdSubmitAccept: true });
    const submit = (digest: string, payload: string) => fetch(`${service.endpoint}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId: "op-held-1", digest, payload }),
    });

    const first = submit("sha256:a", "alpha");
    await waitFor("first held submit", async () => {
      const stats = await service.stats();
      return stats.counters.submitRequests === 1 && stats.counters.actualCreates === 0 ? stats : undefined;
    });
    const second = submit("sha256:a", "alpha");
    await waitFor("coalesced held submit", async () => {
      const stats = await service.stats();
      return stats.counters.submitRequests === 2 && stats.counters.actualCreates === 0 ? stats : undefined;
    });
    const conflict = await submit("sha256:b", "beta");
    expect(conflict.status).toBe(409);
    const beforeRelease = await service.stats();
    expect(beforeRelease.counters.submitRequests).toBe(3);
    expect(beforeRelease.counters.actualCreates).toBe(0);

    await service.releaseSubmit();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as Record<string, unknown>;
    const secondBody = await secondResponse.json() as Record<string, unknown>;
    expect(firstBody.jobId).toBe(secondBody.jobId);
    expect(firstBody.replayed).toBe(false);
    expect(secondBody.replayed).toBe(true);
    const afterRelease = await service.stats();
    expect(afterRelease.counters.submitRequests).toBe(3);
    expect(afterRelease.counters.actualCreates).toBe(1);
    expect(afterRelease.jobs).toHaveLength(1);
    expect(afterRelease.jobs[0]?.state).toBe("running");

    const replay = await submit("sha256:a", "alpha");
    expect(replay.status).toBe(200);
    const changed = await submit("sha256:b", "beta");
    expect(changed.status).toBe(409);
    const final = await service.stats();
    expect(final.counters.submitRequests).toBe(5);
    expect(final.counters.actualCreates).toBe(1);
  });
});

describe("JobAdapter prototype flow", () => {
  test("normal submit observes running then succeeded without accepting the task", async () => {
    const { service, owner, adapter, taskId, branch, recordPath } = await setup();
    const context = contextFor(branch);
    const submitted = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operation = submitted.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("running");
    expect(operation.accepted).toBe(true);
    expect(operation.taskRevision).toBe(1);
    expect(typeof operation.operationId).toBe("string");
    expect(typeof operation.callId).toBe("string");
    expect(operation.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(owner.snapshot().currentTask).toMatchObject({ taskId, status: "active", taskRevision: 1 });

    const running = await adapter.query(context);
    expect((running.details?.operation as Record<string, unknown>).externalState).toBe("running");
    const completed = await service.complete();
    expect(completed.job.state).toBe("succeeded");
    const succeeded = await adapter.query(context);
    const resultOperation = succeeded.details?.operation as Record<string, unknown>;
    expect(resultOperation.externalState).toBe("succeeded");
    expect(resultOperation.externalJobId).toBe(completed.job.jobId);
    expect(succeeded.details?.task).toMatchObject({ taskId, taskRevision: 1, status: "active" });

    const stats = await service.stats();
    expect(stats.counters.actualCreates).toBe(1);
    expect(stats.counters.submitRequests).toBe(1);
    expect(stats.counters.queryRequests).toBe(2);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    expect((record.operations as Array<Record<string, unknown>>).length).toBe(1);
  });

  test("remote failure is reported as failed while the task stays active", async () => {
    const { service, adapter, owner, branch } = await setup();
    const context = contextFor(branch);
    await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    expect((await service.fail()).job.state).toBe("failed");
    const queried = await adapter.query(context);
    expect((queried.details?.operation as Record<string, unknown>).externalState).toBe("failed");
    expect((queried.details?.task as Record<string, unknown>).status).toBe("active");
    expect(owner.snapshot().currentTask?.status).toBe("active");
    expect((await service.stats()).counters.actualCreates).toBe(1);
  });

  test("lost acknowledgement stays unknown, reconciles by the original id, and changed payload conflicts", async () => {
    const { service, owner, adapter, branch, recordPath } = await setup();
    await service.configure({ dropSubmitAck: true });
    const context = contextFor(branch);
    const first = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const lost = first.details?.operation as Record<string, unknown>;
    expect(lost.externalState).toBe("unknown");
    expect(lost.accepted).toBe(false);
    expect(lost.externalJobId).toBeNull();
    expect(typeof lost.operationId).toBe("string");
    const operationId = lost.operationId as string;
    const digest = lost.payloadDigest as string;
    const createdAt = lost.createdAt as string;

    const statsAfterDrop = await service.stats();
    expect(statsAfterDrop.counters.actualCreates).toBe(1);
    expect(statsAfterDrop.counters.submitRequests).toBe(1);

    await service.configure({ dropSubmitAck: false });
    const repeated = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const reconciled = repeated.details?.operation as Record<string, unknown>;
    expect(reconciled.operationId).toBe(operationId);
    expect(reconciled.payloadDigest).toBe(digest);
    expect(reconciled.createdAt).toBe(createdAt);
    expect(reconciled.externalState).toBe("running");
    expect(typeof reconciled.externalJobId).toBe("string");
    expect(reconciled.callId).toBe(lost.callId);
    const calls = reconciled.calls as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.traceId).not.toBe(calls[1]!.traceId);
    expect(calls.every((call) => call.action === "submit")).toBe(true);
    const stats = await service.stats();
    expect(stats.counters.actualCreates).toBe(1);
    expect(stats.counters.submitRequests).toBe(1);

    await expect(adapter.submit(context, { expectedTaskRevision: 2, payload: "alpha-prototype-payload" }))
      .rejects.toThrow(/Stale expected taskRevision 2/);
    await expect(adapter.submit(context, { expectedTaskRevision: 1, payload: "changed-payload" }))
      .rejects.toThrow(/different payload/);
    const afterConflict = await service.stats();
    expect(afterConflict.counters.actualCreates).toBe(1);
    expect(afterConflict.counters.submitRequests).toBe(1);
    expect(owner.snapshot().currentTask?.status).toBe("active");

    const record = JSON.parse(await readFile(recordPath, "utf8")) as { operations: Array<Record<string, unknown>> };
    expect(record.operations[0]).toMatchObject({
      operationId,
      payloadDigest: digest,
      createdAt,
      taskRevision: 1,
      payload: "alpha-prototype-payload",
    });
  });

  test("dispatched HTTP errors after possible creation remain unknown and are never replayed", async () => {
    for (const status of [408, 409]) {
      const { service, adapter, branch } = await setup();
      await service.configure({ submitHttpError: status });
      const first = await adapter.submit(contextFor(branch), {
        expectedTaskRevision: 1,
        payload: "alpha-prototype-payload",
      });
      const unknown = first.details?.operation as Record<string, unknown>;
      expect(unknown.dispatch).toBe("sent");
      expect(unknown.externalState).toBe("unknown");
      expect(unknown.accepted).toBe(false);
      expect(unknown.externalJobId).toBeNull();
      expect(unknown.lastError).toContain(`HTTP ${status}`);
      expect(first.isError).toBe(true);
      const created = await service.stats();
      expect(created.counters.actualCreates).toBe(1);
      expect(created.counters.submitRequests).toBe(1);

      await service.configure({ submitHttpError: null });
      const reconciled = await adapter.submit(contextFor(branch), {
        expectedTaskRevision: 1,
        payload: "alpha-prototype-payload",
      });
      const operation = reconciled.details?.operation as Record<string, unknown>;
      expect(operation.dispatch).toBe("sent");
      expect(operation.externalState).toBe("running");
      expect(operation.externalJobId).toBe(created.jobs[0]?.jobId);
      expect(reconciled.isError).toBeFalsy();
      const stats = await service.stats();
      expect(stats.counters.actualCreates).toBe(1);
      expect(stats.counters.submitRequests).toBe(1);
    }
  });

  test("adversarial remote identity is rejected before accepted/jobId/state changes", async () => {
    const { service, adapter, branch } = await setup();
    const context = contextFor(branch);
    await service.configure({ corruptResponse: "operationId" });
    const first = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const lost = first.details?.operation as Record<string, unknown>;
    expect(lost.externalState).toBe("unknown");
    expect(lost.accepted).toBe(false);
    expect(lost.externalJobId).toBeNull();
    expect(lost.lastError).toContain("mismatched operationId");
    expect(String(lost.operationId)).not.toContain("corrupt");

    await service.configure({ corruptResponse: "digest" });
    const second = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const stillUnknown = second.details?.operation as Record<string, unknown>;
    expect(stillUnknown.externalState).toBe("unknown");
    expect(stillUnknown.externalJobId).toBeNull();
    expect(stillUnknown.lastError).toContain("digest");
    expect(second.isError).toBe(true);
    expect((await service.stats()).counters.submitRequests).toBe(1);

    await service.configure({ corruptResponse: null });
    const third = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const running = third.details?.operation as Record<string, unknown>;
    expect(running.externalState).toBe("running");
    expect(typeof running.externalJobId).toBe("string");
    const verifiedJobId = running.externalJobId as string;

    await service.configure({ corruptResponse: "jobId" });
    const badJob = await adapter.query(context);
    const badJobOperation = badJob.details?.operation as Record<string, unknown>;
    expect(badJobOperation.externalState).toBe("running");
    expect(badJobOperation.externalJobId).toBe(verifiedJobId);
    expect(badJobOperation.lastError).toContain("changed the jobId");
    expect(badJob.isError).toBe(true);
    expect((badJob.details?.query as Record<string, unknown>).fresh).toBe(false);

    await service.configure({ corruptResponse: "missingDigest" });
    const missing = await adapter.query(context);
    const missingOperation = missing.details?.operation as Record<string, unknown>;
    expect(missingOperation.externalState).toBe("running");
    expect(missingOperation.externalJobId).toBe(verifiedJobId);
    expect(missingOperation.lastError).toContain("digest");
    expect(missing.isError).toBe(true);

    await service.configure({ corruptResponse: "overlongJobId" });
    const overlong = await adapter.query(context);
    const overlongOperation = overlong.details?.operation as Record<string, unknown>;
    expect(overlongOperation.externalState).toBe("running");
    expect(overlongOperation.externalJobId).toBe(verifiedJobId);
    expect(overlongOperation.lastError).toContain("overlong jobId");
    expect(overlong.isError).toBe(true);
  });

  test("not-found before a held accept later retries the same cancel intent", async () => {
    const { service, owner, adapter, branch } = await setup();
    await service.configure({ holdSubmitAccept: true, delayedQueryMs: 300 });
    const context = contextFor(branch);
    const pendingSubmit = adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = adapter.operationIds[0]!;
    await waitFor("held submit request", async () => {
      const stats = await service.stats();
      return stats.counters.submitRequests === 1 && stats.counters.actualCreates === 0 ? stats : undefined;
    });

    cancelTask(owner, branch);
    const initial = await waitFor("early not-found cancellation", async () => {
      const operation = adapter.snapshot(operationId);
      if (!operation) return undefined;
      return operation.cancelIntent?.attempts === 1 && operation.externalState === "unknown"
        ? operation
        : undefined;
    });
    const intentId = initial.cancelIntent!.cancelIntentId;
    expect((await service.stats()).counters.actualCreates).toBe(0);
    expect((await service.stats()).counters.cancelRequests).toBe(1);

    await service.releaseSubmit();
    const submitted = await pendingSubmit;
    expect((submitted.details?.operation as Record<string, unknown>).externalState).toBe("running");
    const confirmed = await waitFor("late-accept cancellation retry", async () => {
      const operation = adapter.snapshot(operationId);
      if (!operation) return undefined;
      return operation.cancelIntent?.state === "confirmed" && operation.externalState === "cancelled"
        ? operation
        : undefined;
    });
    expect(confirmed.cancelIntent!.cancelIntentId).toBe(intentId);
    await Bun.sleep(150);
    const stats = await service.stats();
    expect(stats.counters.actualCreates).toBe(1);
    expect(stats.counters.submitRequests).toBe(1);
    expect(stats.counters.cancelRequests).toBe(2);
    expect(stats.jobs[0]?.state).toBe("cancelled");
  });

  test("history remains append-only while the complete response and display stay bounded", async () => {
    const { service, adapter, branch, recordPath } = await setup();
    const context = contextFor(branch);
    const escapedPayload = '"'.repeat(4096);
    const first = await adapter.submit(context, { expectedTaskRevision: 1, payload: escapedPayload });
    const operationId = (first.details?.operation as Record<string, unknown>).operationId as string;
    for (let index = 0; index < 60; index += 1) await adapter.query(context);
    const result = await adapter.query(context);
    const details = result.details as Record<string, unknown>;
    const history = details.history as Record<string, unknown>;
    const retained = history.retained as Record<string, number>;
    const omitted = history.omitted as Record<string, number>;
    const operation = details.operation as Record<string, unknown>;
    const display = operation.display as Record<string, number>;
    expect(retained.observations).toBeGreaterThan(60);
    expect(omitted.observations).toBeGreaterThan(0);
    expect(omitted.calls).toBeGreaterThan(0);
    expect((operation.observations as unknown[]).length).toBeLessThan(retained.observations!);
    expect((operation.calls as unknown[]).length).toBeLessThan(retained.calls!);
    expect(display.observationsShown! + display.observationsOmitted!).toBe(retained.observations!);
    const fullBytes = Buffer.byteLength(JSON.stringify({
      content: result.content,
      details: result.details,
      ...(result.isError === true ? { isError: true } : {}),
    }), "utf8");
    expect(fullBytes).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
    expect((operation.display as Record<string, unknown>).payloadIncluded).toBe(false);

    const hostSnapshot = adapter.snapshot(operationId)!;
    expect(hostSnapshot.observations.length).toBe(retained.observations!);
    expect(hostSnapshot.calls.length).toBe(retained.calls!);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { operations: Array<Record<string, unknown>> };
    expect((record.operations[0]!.observations as unknown[]).length).toBe(retained.observations!);
    expect((record.operations[0]!.calls as unknown[]).length).toBe(retained.calls!);
    expect((await service.stats()).counters.queryRequests).toBe(61);
  });

  test("host cancellation intent is deduped, unconfirmed while remote runs, then confirmed by query", async () => {
    const { service, owner, adapter, branch } = await setup();
    await service.configure({ holdCancel: true });
    const context = contextFor(branch);
    const submitted = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    expect((await service.stats()).counters.cancelRequests).toBe(0);

    // Optional subscribers are isolated: this throw must not block the
    // committed cancellation from reaching the adapter cleanup subscriber.
    owner.subscribe(() => {
      throw new Error("optional subscriber boom");
    });
    const cancelledBranch = cancelTask(owner, branch);
    const unconfirmed = await waitFor("cancel request", async () => {
      const operation = adapter.snapshot(operationId);
      if (!operation || operation.cancelIntent?.attempts !== 1) return undefined;
      return operation;
    });
    expect(unconfirmed.cancelIntent).toMatchObject({ state: "requested_unconfirmed", attempts: 1 });
    expect(unconfirmed.externalState).toBe("running");
    const intentId = unconfirmed.cancelIntent!.cancelIntentId;
    const statsWhileHeld = await waitFor("service cancel request", async () => {
      const stats = await service.stats();
      return stats.counters.cancelRequests === 1 ? stats : undefined;
    });
    expect(statsWhileHeld.counters.cancelRequests).toBe(1);

    await service.confirmCancel();
    const confirmed = await adapter.query(contextFor(cancelledBranch));
    const operation = confirmed.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("cancelled");
    expect(operation.cancelIntent).toMatchObject({ cancelIntentId: intentId, state: "confirmed" });
    expect((confirmed.details?.task as Record<string, unknown>).status).toBe("cancelled");
    const stats = await service.stats();
    expect(stats.counters.cancelRequests).toBe(1);
    expect(stats.counters.actualCreates).toBe(1);

    await expect(adapter.submit(contextFor(cancelledBranch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" }))
      .rejects.toThrow(/task is cancelled/);
    expect((await service.stats()).counters.submitRequests).toBe(1);
  });

  test("corrupt cancel response stays unconfirmed until a valid query confirms the same intent", async () => {
    const { service, owner, adapter, branch } = await setup();
    const context = contextFor(branch);
    const submitted = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    const verifiedJobId = (submitted.details?.operation as Record<string, unknown>).externalJobId as string;
    await service.configure({ corruptResponse: "jobId" });

    const cancelledBranch = cancelTask(owner, branch);
    const held = await waitFor("corrupt cancel response", async () => {
      const operation = adapter.snapshot(operationId);
      if (!operation) return undefined;
      return operation.cancelIntent?.attempts === 1 && operation.lastError?.includes("changed the jobId")
        ? operation
        : undefined;
    });
    expect(held.cancelIntent).toMatchObject({ state: "requested_unconfirmed", attempts: 1 });
    expect(held.externalState).toBe("running");
    expect(held.externalJobId).toBe(verifiedJobId);
    expect(held.lastError).toContain("changed the jobId");
    const intentId = held.cancelIntent!.cancelIntentId;
    expect((await service.stats()).jobs[0]?.state).toBe("cancelled");

    await service.configure({ corruptResponse: null });
    const queried = await adapter.query(contextFor(cancelledBranch));
    const operation = queried.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("cancelled");
    expect(operation.externalJobId).toBe(verifiedJobId);
    expect(operation.cancelIntent).toMatchObject({ cancelIntentId: intentId, state: "confirmed" });
    expect((await service.stats()).counters.cancelRequests).toBe(1);
  });

  test("completion wins cancellation and keeps the original revision binding", async () => {
    const { service, owner, adapter, branch } = await setup();
    const context = contextFor(branch);
    const submitted = await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    const completed = await service.complete();
    expect(completed.job.state).toBe("succeeded");

    const cancelledBranch = cancelTask(owner, branch);
    const settled = await waitFor("completion-winning cancel", async () => {
      const operation = adapter.snapshot(operationId);
      return operation?.cancelIntent && operation.cancelIntent.attempts === 1
        && operation.externalState === "succeeded" ? operation : undefined;
    });
    expect(settled.externalState).toBe("succeeded");
    expect(settled.cancelIntent).not.toBeNull();

    const queried = await adapter.query(contextFor(cancelledBranch));
    const operation = queried.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("succeeded");
    expect(operation.taskRevision).toBe(1);
    expect(operation.cancelIntent).not.toBeNull();
    expect((queried.details?.task as Record<string, unknown>).status).toBe("cancelled");
    expect((queried.details?.task as Record<string, unknown>).taskRevision).toBe(1);

    await expect(adapter.submit(contextFor(cancelledBranch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" }))
      .rejects.toThrow(/task is cancelled/);
    expect((await service.stats()).counters.actualCreates).toBe(1);
  });

  test("authoritative admission audit failure aborts before host record or transport", async () => {
    const { service, adapter, branch, recordPath } = await setupWithOwnerCallbacks({
      onEvent: (event) => {
        if (event.type === "capability_admission_allowed") throw new Error("authoritative audit failed");
      },
    });
    await expect(adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha" }))
      .rejects.toThrow("authoritative audit failed");
    expect(adapter.operationIds).toHaveLength(0);
    const stats = await service.stats();
    expect(stats.counters.submitRequests).toBe(0);
    expect(stats.counters.actualCreates).toBe(0);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { operations: unknown[] };
    expect(record.operations).toHaveLength(0);
  });

  test("authoritative admission persistence failure aborts before host record or transport", async () => {
    const { service, adapter, branch, recordPath } = await setupWithOwnerCallbacks({
      onStateChange: (snapshot) => {
        if ((snapshot.currentTask?.admissions ?? 0) > 0) throw new Error("authoritative persist failed");
      },
    });
    await expect(adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha" }))
      .rejects.toThrow("authoritative persist failed");
    expect(adapter.operationIds).toHaveLength(0);
    const stats = await service.stats();
    expect(stats.counters.submitRequests).toBe(0);
    expect(stats.counters.actualCreates).toBe(0);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { operations: unknown[] };
    expect(record.operations).toHaveLength(0);
  });

  test("post-commit host cancellation error still reaches adapter cleanup before propagation", async () => {
    const { service, owner, adapter, branch } = await setupWithOwnerCallbacks({
      onEvent: (event) => {
        if (event.type === "task_cancelled") throw new Error("authoritative cancel audit failed");
      },
    });
    const submitted = await adapter.submit(contextFor(branch), {
      expectedTaskRevision: 1,
      payload: "alpha-prototype-payload",
    });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    expect(() => cancelTask(owner, branch)).toThrow("authoritative cancel audit failed");
    expect(owner.snapshot().currentTask?.status).toBe("cancelled");
    const cancelled = await waitFor("post-commit cleanup", async () => {
      const operation = adapter.snapshot(operationId);
      return operation?.cancelIntent && operation.cancelIntent.attempts >= 1 ? operation : undefined;
    });
    expect(cancelled.cancelIntent).not.toBeNull();
    expect((await service.stats()).counters.cancelRequests).toBe(1);
  });

  test("query refuses a different conversation binding instead of exposing old results", async () => {
    const { adapter, branch } = await setup();
    const context = contextFor(branch);
    await adapter.submit(context, { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    await expect(adapter.query(contextFor(branch, "different-session")))
      .rejects.toThrow(/different OMP session/);
    await expect(adapter.query(contextFor([base()])))
      .rejects.toThrow(/anchor is not in the current conversation branch/);
    await expect(adapter.submit(contextFor([base()]), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" }))
      .rejects.toThrow(/anchor is not in the current conversation branch/);
  });
});

describe("JobAdapter failure visibility", () => {
  test("admission denial and invalid host endpoint are explicit errors", async () => {
    const owner = newOwner();
    const { branch } = startTask(owner);
    const root = await mkdtemp(path.join(tmpdir(), "omp-agent-b3a-adapter-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    expect(() => new JobAdapter(owner, {
      endpoint: "http://example.com:1234",
      recordPath: path.join(root, "record.json"),
      capabilityId: "job-submit",
    })).toThrow(/127\.0\.0\.1/);
    const adapter = new JobAdapter(owner, {
      endpoint: "http://127.0.0.1:9",
      recordPath: path.join(root, "record.json"),
      capabilityId: "job-submit",
      timeoutMs: 200,
    });
    cleanups.push(async () => adapter.dispose());
    await expect(adapter.submit(contextFor(branch), { expectedTaskRevision: 2, payload: "alpha" }))
      .rejects.toThrow(/Job admission denied: stale expected taskRevision 2/);
    const failed = await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha" });
    const operation = failed.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("unknown");
    expect(failed.isError).toBeFalsy();
    expect(typeof operation.lastError).toBe("string");
    expect(() => new JobAdapterError("visible")).toThrow("visible");
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("test server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function adapterForEndpoint(endpoint: string, timeoutMs = 1_000): Promise<{
  adapter: JobAdapter;
  owner: TaskOwner;
  branch: Entry[];
  root: string;
  recordPath: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "omp-agent-b3b-transport-"));
  const recordPath = path.join(root, "record.json");
  const owner = newOwner();
  const { branch } = startTask(owner);
  const adapter = new JobAdapter(owner, {
    endpoint,
    recordPath,
    capabilityId: "job-submit",
    timeoutMs,
    now: () => NOW,
    id: (() => { let n = 0; return () => `transport-${++n}`; })(),
  });
  cleanups.push(async () => {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, owner, branch, root, recordPath };
}

describe("B3b model-call abort and local wait lifecycle", () => {
  test("an already-aborted signal rejects before admission, record or POST", async () => {
    const { service, owner, adapter, branch } = await setup();
    const controller = new AbortController();
    controller.abort("user interrupt");
    await expect(adapter.submit(contextFor(branch), {
      expectedTaskRevision: 1,
      payload: "alpha-prototype-payload",
    }, controller.signal)).rejects.toThrow(/aborted before admission/);
    expect(adapter.operationIds).toHaveLength(0);
    expect(owner.snapshot().currentTask?.admissions).toBe(0);
    const stats = await service.stats();
    expect(stats.counters.submitRequests).toBe(0);
    expect(stats.counters.actualCreates).toBe(0);
  });

  test("in-flight query abort ends the local wait and keeps the prior running fact", async () => {
    const { service, adapter, branch } = await setup();
    const submitted = await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    await service.configure({ delayedQueryMs: 800 });

    const controller = new AbortController();
    const pending = adapter.query(contextFor(branch), controller.signal);
    await waitFor("query reached service", async () => (await service.stats()).counters.queryRequests === 1 ? true : undefined);
    const abortedAt = Date.now();
    controller.abort("Interrupted by user");
    const result = await pending;
    expect(Date.now() - abortedAt).toBeLessThan(500);
    expect(result.isError).toBe(true);
    expect(result.details?.aborted).toBe(true);
    expect((result.details?.query as Record<string, unknown>).outcome).toBe("aborted");
    const operation = result.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("running");
    expect((result.details?.task as Record<string, unknown>).status).toBe("active");
    const observations = operation.observations as Array<Record<string, unknown>>;
    expect(observations.some((observation) => observation.source === "query_aborted")).toBe(true);
    expect(observations.filter((observation) => observation.source === "query")).toHaveLength(0);
    const calls = operation.calls as Array<Record<string, unknown>>;
    expect(calls.at(-1)?.outcome).toBe("aborted");
    const stats = await service.stats();
    expect(stats.counters.cancelRequests).toBe(0);
    expect(stats.counters.actualCreates).toBe(1);

    await service.configure({ delayedQueryMs: 0 });
    const queried = await adapter.query(contextFor(branch));
    expect(queried.isError).toBeFalsy();
    expect((queried.details?.operation as Record<string, unknown>).operationId).toBe(operationId);
    expect((queried.details?.operation as Record<string, unknown>).externalState).toBe("running");
  });

  test("submit abort after dispatch retains unknown under the original operation and reconciles later", async () => {
    const { service, adapter, branch } = await setup();
    await service.configure({ holdSubmitAccept: true });
    const controller = new AbortController();
    const pending = adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" }, controller.signal);
    await waitFor("held submit reached service", async () => (await service.stats()).counters.submitRequests === 1 ? true : undefined);
    controller.abort("Interrupted by user");
    const aborted = await pending;
    expect(aborted.isError).toBe(true);
    const abortedOperation = aborted.details?.operation as Record<string, unknown>;
    expect(abortedOperation.externalState).toBe("unknown");
    expect(abortedOperation.externalJobId).toBeNull();
    expect(abortedOperation.dispatch).toBe("sent");
    expect(abortedOperation.taskRevision).toBe(1);
    const operationId = abortedOperation.operationId as string;
    const digest = abortedOperation.payloadDigest as string;
    const observations = abortedOperation.observations as Array<Record<string, unknown>>;
    expect(observations.some((observation) => observation.source === "submit_aborted")).toBe(true);
    expect((aborted.details?.query as Record<string, unknown> | undefined)?.outcome).toBeUndefined();
    expect((await service.stats()).counters.actualCreates).toBe(0);

    await service.releaseSubmit();
    const afterRelease = await service.stats();
    expect(afterRelease.counters.actualCreates).toBe(1);
    expect(afterRelease.counters.submitRequests).toBe(1);

    const reconciled = await adapter.query(contextFor(branch));
    expect(reconciled.isError).toBeFalsy();
    const operation = reconciled.details?.operation as Record<string, unknown>;
    expect(operation.operationId).toBe(operationId);
    expect(operation.payloadDigest).toBe(digest);
    expect(operation.externalState).toBe("running");
    expect((reconciled.details?.task as Record<string, unknown>).status).toBe("active");
    expect((await service.stats()).counters.actualCreates).toBe(1);
  });

  test("host cleanup does not inherit an aborted model query signal", async () => {
    const { service, owner, adapter, branch } = await setup();
    await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    await service.configure({ delayedCancelMs: 500, delayedQueryMs: 700 });
    const cancelledBranch = cancelTask(owner, branch);
    const queryController = new AbortController();
    const querying = adapter.query(contextFor(cancelledBranch), queryController.signal);
    await waitFor("model query reached service", async () => (await service.stats()).counters.queryRequests === 1 ? true : undefined);
    queryController.abort("user interrupt during query");
    const aborted = await querying;
    expect(aborted.isError).toBe(true);
    expect((aborted.details?.query as Record<string, unknown>).outcome).toBe("aborted");

    const settled = await waitFor("same-intent cleanup", async () => {
      const operation = adapter.operationIds[0] ? adapter.snapshot(adapter.operationIds[0]) : undefined;
      return operation?.cancelIntent?.state === "confirmed" ? operation : undefined;
    });
    expect(settled.externalState).toBe("cancelled");
    const stats = await service.stats();
    expect(stats.counters.cancelRequests).toBe(1);
    expect(stats.counters.actualCreates).toBe(1);
    expect(owner.snapshot().currentTask?.status).toBe("cancelled");
  });

  test("dispose aborts model waits but lets an already-issued cleanup settle within its deadline", async () => {
    const { service, owner, adapter, branch } = await setup();
    await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    await service.configure({ holdCancelResponse: true });
    cancelTask(owner, branch);
    await waitFor("held cleanup request", async () => (await service.stats()).counters.cancelRequests === 1 ? true : undefined);
    adapter.dispose();
    await service.releaseCancelResponse();
    const settled = await waitFor("cleanup settles after dispose", async () => {
      const operation = adapter.snapshot(adapter.operationIds[0]!);
      return operation?.cancelIntent?.state === "confirmed" ? operation : undefined;
    });
    expect(settled.externalState).toBe("cancelled");
    expect(settled.cancelIntent).not.toBeNull();
    expect((await service.stats()).counters.cancelRequests).toBe(1);
    expect((await service.stats()).counters.actualCancels).toBe(1);
  });

  test("dispose aborts the local wait without claiming the remote job stopped", async () => {
    const { service, adapter, branch } = await setup();
    const submitted = await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    const operationId = (submitted.details?.operation as Record<string, unknown>).operationId as string;
    await service.configure({ delayedQueryMs: 1_000 });
    const pending = adapter.query(contextFor(branch));
    await waitFor("query reached service", async () => (await service.stats()).counters.queryRequests === 1 ? true : undefined);
    adapter.dispose();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect((result.details?.query as Record<string, unknown>).outcome).toBe("aborted");
    const operation = adapter.snapshot(operationId)!;
    expect(operation.externalState).toBe("running");
    expect(operation.lastError).toContain("disposed");
    expect(operation.externalJobId).not.toBeNull();
    await expect(adapter.query(contextFor(branch))).rejects.toThrow(/disposed/);
    const stats = await service.stats();
    expect(stats.counters.cancelRequests).toBe(0);
    expect(stats.counters.actualCreates).toBe(1);
  });

  test("a result is withheld after the conversation binding detaches during the await", async () => {
    const { service, owner, adapter, branch } = await setup();
    await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    await service.configure({ delayedQueryMs: 400 });
    const pending = adapter.query(contextFor(branch));
    await waitFor("query reached service", async () => (await service.stats()).counters.queryRequests === 1 ? true : undefined);
    owner.navigate("session_switch", "replacement-session");
    await expect(pending).rejects.toThrow(/result withheld/);
    expect(adapter.snapshot(adapter.operationIds[0]!)?.observations.length).toBeGreaterThan(0);
    expect((await service.stats()).counters.queryRequests).toBe(1);
  });

  test("withheld disclosure after a valid 201 is not mislabelled as a transport failure", async () => {
    const { service, owner, adapter, branch, recordPath } = await setup();
    await service.configure({ holdSubmitAccept: true });
    const pending = adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha-prototype-payload" });
    await waitFor("held submit reached service", async () => (await service.stats()).counters.submitRequests === 1 ? true : undefined);
    owner.navigate("session_switch", "replacement-session");
    await service.releaseSubmit();
    await expect(pending).rejects.toThrow(/result withheld/);
    expect((await service.stats()).counters.actualCreates).toBe(1);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      operations: Array<Record<string, unknown>>;
    };
    const operation = record.operations[0]!;
    expect(operation.externalState).toBe("running");
    expect(operation.accepted).toBe(true);
    expect(operation.externalJobId).toBe("job-1");
    const calls = operation.calls as Array<Record<string, unknown>>;
    expect(calls.at(-1)?.outcome).toBe("ok");
    const observations = operation.observations as Array<Record<string, unknown>>;
    expect(observations.some((observation) => observation.source === "submit_response")).toBe(true);
    expect(observations.filter((observation) => observation.source === "submit_transport_error")).toHaveLength(0);
    expect(observations.filter((observation) => observation.source === "submit_protocol_error")).toHaveLength(0);
  });

  test("redirect responses are refused without a second request", async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(302, { location: "/jobs/elsewhere" });
      res.end();
    });
    const endpoint = await listen(server);
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
    const { adapter, branch } = await adapterForEndpoint(endpoint);
    const result = await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha" });
    expect(result.isError).toBe(true);
    const operation = result.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("unknown");
    expect(operation.externalJobId).toBeNull();
    expect(String(operation.lastError)).toContain("redirect");
    expect(requests).toBe(1);
  });

  test("chunked oversize responses are cut at the 16 KiB bound and cancelled", async () => {
    let requests = 0;
    let responseClosed = false;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.on("close", () => { responseClosed = true; });
      const chunk = "x".repeat(4 * 1024);
      for (let index = 0; index < 6 && !res.destroyed; index += 1) res.write(chunk);
      res.end();
    });
    const endpoint = await listen(server);
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
    const { adapter, branch } = await adapterForEndpoint(endpoint);
    const result = await adapter.submit(contextFor(branch), { expectedTaskRevision: 1, payload: "alpha" });
    expect(result.isError).toBe(true);
    const operation = result.details?.operation as Record<string, unknown>;
    expect(operation.externalState).toBe("unknown");
    expect(String(operation.lastError)).toMatch(/exceeds 16384 bytes/);
    await waitFor("oversize stream cancellation", async () => responseClosed ? true : undefined);
    expect(requests).toBe(1);
  });
});
