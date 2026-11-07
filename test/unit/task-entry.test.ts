import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskEntry } from "../../src/task-entry.ts";
import type { OmpToolContext } from "../../src/task-entry-port.ts";
import type { TaskOwnerSnapshot } from "../../src/task-owner.ts";
import { MAX_TASK_CONTROL_RESPONSE_BYTES } from "../../src/task-requirements.ts";

type Api = Parameters<typeof createTaskEntry>[0];
type Tool = {
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    context: OmpToolContext,
  ): Promise<{ isError?: boolean; details?: unknown; content?: Array<{ type: string; text: string }> }>;
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function baseEntry() {
  return { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} };
}

function userEntry(id: string, parentId: string, text: string) {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], attribution: "user" },
  };
}

async function setup(): Promise<{
  tool: Tool;
  context: OmpToolContext;
  input(text: string): void;
  beforeStart(text: string): void;
  closeTurn(text?: string): void;
  taskCount(): number;
  status(): string | null;
  snapshot(): TaskOwnerSnapshot;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-agent-b1-entry-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const handlers = new Map<string, (event: unknown, context: OmpToolContext) => unknown>();
  let tool: Tool | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, context: OmpToolContext) => unknown) { handlers.set(event, handler); },
    registerTool(value: Tool) { tool = value; },
  } as unknown as Api;
  const { owner } = createTaskEntry(pi, {
    workspaceRoot: workspace,
    statePath: path.join(root, "state.json"),
    auditPath: path.join(root, "audit.jsonl"),
    capabilities: ["test-progress"],
  });
  let currentText = "";
  let leafId = "leaf-1";
  let currentUserId = "";
  let userSequence = 0;
  let assistantSequence = 0;
  const entries: Array<Record<string, unknown>> = [baseEntry()];
  const context: OmpToolContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "session-b1-entry",
      getLeafId: () => leafId,
      getBranch: () => entries,
    },
  };
  return {
    tool: tool!,
    context,
    input(text: string) {
      currentText = text;
      currentUserId = `user-${++userSequence}`;
      entries.push(userEntry(currentUserId, leafId, text));
      handlers.get("input")!({ text, source: "rpc" }, context);
    },
    beforeStart(text: string) {
      handlers.get("before_agent_start")!({ prompt: text, reason: "prompt" }, context);
    },
    closeTurn(text: string = currentText) {
      const assistantId = `assistant-${++assistantSequence}`;
      entries.push({
        id: assistantId,
        parentId: currentUserId,
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "working" }], attribution: "agent" },
      });
      leafId = assistantId;
      handlers.get("agent_end")!({
        messages: [{ role: "user", content: [{ type: "text", text }], attribution: "user", id: currentUserId }],
      }, context);
    },
    taskCount: () => owner.snapshot().tasksCreated,
    status: () => owner.snapshot().currentTask?.status ?? null,
    snapshot: () => owner.snapshot(),
  };
}

describe("B1 entry control boundaries", () => {
  test("an already-aborted start signal creates no task", async () => {
    const harness = await setup();
    harness.input("Please own the release checklist.");
    harness.beforeStart("Please own the release checklist.");
    const signal = AbortSignal.abort();
    const result = await harness.tool.execute("call-1", { action: "start" }, signal, undefined, harness.context);
    expect(result.isError).toBe(true);
    expect(harness.taskCount()).toBe(0);
  });

  test("an aborted revise signal leaves the revision and requirements unchanged", async () => {
    const harness = await setup();
    harness.input("Please own the release checklist.");
    harness.beforeStart("Please own the release checklist.");
    const created = await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
    expect(created.isError).toBeUndefined();
    const revised = await harness.tool.execute("call-2", { action: "revise" }, AbortSignal.abort(), undefined, harness.context);
    expect(revised.isError).toBe(true);
    expect(harness.snapshot().currentTask!.taskRevision).toBe(1);
    expect(harness.snapshot().currentTask!.requirementSources).toHaveLength(1);
  });

  test("an oversized full response envelope is rejected before any task commit", async () => {
    const harness = await setup();
    const text = "a".repeat(30 * 1024);
    harness.input(text);
    harness.beforeStart(text);
    const result = await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("TOO_LARGE");
    // The ledger alone fits; only the complete content+details envelope fails.
    expect(JSON.stringify(result)).toContain("response envelope");
    expect(harness.taskCount()).toBe(0);
    expect(harness.snapshot().currentTask).toBeNull();
  });

  test("a near-limit successful response stays within the actual envelope budget", async () => {
    const harness = await setup();
    const text = "b".repeat(12 * 1024);
    harness.input(text);
    harness.beforeStart(text);
    const result = await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
    expect(result.isError).toBeUndefined();
    expect(harness.taskCount()).toBe(1);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(harness.snapshot().currentTask!.rawRequest).toBe(text);
  });

  test("an aborted cancel signal leaves the task active", async () => {
    const harness = await setup();
    harness.input("Please own the release checklist.");
    harness.beforeStart("Please own the release checklist.");
    const created = await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
    expect(created.isError).toBeUndefined();
    expect(harness.status()).toBe("active");
    const cancelled = await harness.tool.execute("call-2", { action: "cancel" }, AbortSignal.abort(), undefined, harness.context);
    expect(cancelled.isError).toBe(true);
    expect(harness.status()).toBe("active");
  });
});

  test("entry start response is a detached snapshot whose JSON text matches details", async () => {
    const harness = await setup();
    const request = "Please own the release checklist.";
    harness.input(request);
    harness.beforeStart(request);
    const result = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(result.isError).toBeUndefined();
    const details = result.details as { task: Record<string, unknown>; requirements: Record<string, unknown> };
    expect(JSON.parse(result.content![0]!.text)).toEqual(details);
    const created = harness.snapshot().currentTask!;

    details.task.rawRequest = "FORGED";
    details.task.taskRevision = 99;
    (details.task.anchor as Record<string, unknown>).messageId = "forged-anchor";
    ((details.task.requirementSources as Array<Record<string, unknown>>)[0]!).text = "FORGED LEDGER";

    // The owner never aliases the returned details, and the serialized text
    // still represents the original snapshot.
    expect(harness.snapshot().currentTask).toEqual(created);
    const textTask = (JSON.parse(result.content![0]!.text) as typeof details).task;
    expect(textTask.rawRequest).toBe(request);
    expect(textTask.taskRevision).toBe(1);
    expect((textTask.requirementSources as Array<Record<string, unknown>>)[0]!.text).toBe(request);
  });

  test("entry revise response is a detached snapshot and earlier start output never changes", async () => {
    const harness = await setup();
    const request = "Original request.";
    const amendment = "Amendment: prefer low latency over maximum precision.";
    harness.input(request);
    harness.beforeStart(request);
    const started = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(started.isError).toBeUndefined();
    const startDetails = started.details as { task: Record<string, unknown>; requirements: Record<string, unknown> };
    const startJson = JSON.stringify(started);
    const created = harness.snapshot().currentTask!;

    harness.closeTurn(request);
    harness.input(amendment);
    harness.beforeStart(amendment);
    const revised = await harness.tool.execute("call-revise", { action: "revise" }, undefined, undefined, harness.context);
    expect(revised.isError).toBeUndefined();
    const reviseDetails = revised.details as { task: Record<string, unknown>; requirements: Record<string, unknown> };
    expect(reviseDetails.task.taskRevision).toBe(2);

    // A later state transition must not rewrite an earlier response.
    expect(startDetails.task.taskRevision).toBe(1);
    expect(startDetails.task.status).toBe("active");
    expect(startDetails.task.requirementSources).toHaveLength(1);
    expect(JSON.stringify(started)).toBe(startJson);
    expect(JSON.parse(started.content![0]!.text)).toEqual(startDetails);

    reviseDetails.task.taskRevision = 99;
    reviseDetails.task.rawRequest = "FORGED";
    (reviseDetails.task.anchor as Record<string, unknown>).messageId = "forged-anchor";
    ((reviseDetails.task.requirementSources as Array<Record<string, unknown>>)[0]!).text = "FORGED ORIGINAL";
    ((reviseDetails.task.requirementSources as Array<Record<string, unknown>>)[1]!).text = "FORGED AMENDMENT";

    const after = harness.snapshot().currentTask!;
    expect(after.taskRevision).toBe(2);
    expect(after.rawRequest).toBe(request);
    expect(after.anchor.messageId).toBe(created.anchor.messageId);
    expect(after.requirementSources).toHaveLength(2);
    expect(after.requirementSources[0]!.text).toBe(request);
    expect(after.requirementSources[1]!.text).toBe(amendment);
    expect(JSON.stringify(started)).toBe(startJson);
    expect((JSON.parse(revised.content![0]!.text) as typeof reviseDetails).task.taskRevision).toBe(2);
  });

  test("a maximum-size accepted task can cancel with a bounded factual response and keep the start response unchanged", async () => {
    const attemptStart = async (length: number): Promise<number | undefined> => {
      const probe = await setup();
      const text = "x".repeat(length);
      probe.input(text);
      probe.beforeStart(text);
      const result = await probe.tool.execute("call-boundary", { action: "start" }, undefined, undefined, probe.context);
      return result.isError ? undefined : new TextEncoder().encode(JSON.stringify(result)).byteLength;
    };
    let low = 0;
    let high = 40_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await attemptStart(mid)) === undefined) high = mid - 1;
      else low = mid;
    }
    const maximumAccepted = low;
    expect(maximumAccepted).toBeGreaterThan(20_000);

    const harness = await setup();
    const request = "x".repeat(maximumAccepted);
    harness.input(request);
    harness.beforeStart(request);
    const started = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(started.isError).toBeUndefined();
    const startJson = JSON.stringify(started);
    const startBytes = new TextEncoder().encode(startJson).byteLength;
    expect(startBytes).toBeLessThanOrEqual(MAX_TASK_CONTROL_RESPONSE_BYTES);
    expect(startBytes).toBeGreaterThan(MAX_TASK_CONTROL_RESPONSE_BYTES - 512);
    const created = harness.snapshot().currentTask!;

    harness.closeTurn(request);
    const cancellation = "Please cancel the managed task without creating a new one.";
    harness.input(cancellation);
    harness.beforeStart(cancellation);
    const cancelled = await harness.tool.execute("call-cancel", { action: "cancel" }, undefined, undefined, harness.context);
    expect(cancelled.isError).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(cancelled)).byteLength).toBeLessThanOrEqual(MAX_TASK_CONTROL_RESPONSE_BYTES);
    const details = cancelled.details as { task: Record<string, unknown>; requirements: Record<string, unknown> };
    expect(details.task).toMatchObject({
      taskId: created.taskId,
      ownerId: created.ownerId,
      taskRevision: 1,
      status: "cancelled",
    });
    expect(details.task.cancelledAt).toBeString();
    expect(details.task.rawRequest).toBeUndefined();
    expect(details.requirements).toMatchObject({ sourceCount: 1, amendmentCount: 0 });
    expect(JSON.parse(cancelled.content![0]!.text)).toEqual(details);
    expect(harness.status()).toBe("cancelled");
    expect(harness.snapshot().currentTask!.cancelledAt).toBeString();

    // The earlier start response is an independent snapshot and the original
    // JSON text is byte-for-byte unchanged after cancellation committed.
    expect(JSON.stringify(started)).toBe(startJson);
    expect((started.details as { task: Record<string, unknown> }).task.status).toBe("active");
    expect((JSON.parse(started.content![0]!.text) as { task: Record<string, unknown> }).task.status).toBe("active");
  });
