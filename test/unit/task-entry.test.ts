import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskEntry, admitPublishedTask } from "../../src/task-entry.ts";
import {
  clearPublishedTaskOwner,
  currentTaskOwner,
  publishTaskOwner,
  subjectFromContext,
  type OmpToolContext,
} from "../../src/task-entry-port.ts";
import { TaskOwner, type TaskOwnerSnapshot, type TaskSubject } from "../../src/task-owner.ts";
import { MAX_TASK_CONTROL_RESPONSE_BYTES, requirementsDigest } from "../../src/task-requirements.ts";

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
const controls: Array<{ owner: TaskOwner; dispose(): void }> = [];

afterEach(async () => {
  const failures: string[] = [];
  // Clear only the owners this fixture actually published, newest first, before
  // deleting their roots. A later test must never inherit a published owner.
  for (const control of controls.splice(0).reverse()) {
    try {
      control.dispose();
    } catch (error) {
      failures.push(`dispose ${control.owner.ownerId}: ${(error as Error).message}`);
    }
  }
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`remove ${root}: ${(error as Error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`task-entry fixture cleanup failed: ${failures.join("; ")}`);
  }
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

async function setup(options: { id?: () => string } = {}): Promise<{
  tool: Tool;
  context: OmpToolContext;
  input(text: string): void;
  beforeStart(text: string): void;
  closeTurn(text?: string): void;
  projectContext(messages: unknown[]): unknown;
  navigate(): void;
  taskCount(): number;
  status(): string | null;
  guard(): { expectedTaskId: string; expectedTaskRevision: number };
  snapshot(): TaskOwnerSnapshot;
  adopt(owner: TaskOwner): TaskOwner;
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
  const entry = createTaskEntry(pi, {
    workspaceRoot: workspace,
    statePath: path.join(root, "state.json"),
    auditPath: path.join(root, "audit.jsonl"),
    capabilities: ["test-progress"],
    ...(options.id === undefined ? {} : { id: options.id }),
  });
  const { owner } = entry;
  controls.push({ owner, dispose: entry.dispose });
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
    projectContext(messages: unknown[]) {
      return handlers.get("context")!({ messages }, context);
    },
    navigate() {
      handlers.get("session_tree")!({}, context);
    },
    taskCount: () => owner.snapshot().tasksCreated,
    status: () => owner.snapshot().currentTask?.status ?? null,
    guard() {
      const task = owner.snapshot().currentTask;
      if (!task) throw new Error("test setup: no current task");
      return { expectedTaskId: task.taskId, expectedTaskRevision: task.taskRevision };
    },
    snapshot: () => owner.snapshot(),
    adopt(value: TaskOwner) {
      controls.push({ owner: value, dispose: () => clearPublishedTaskOwner(value) });
      return value;
    },
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
    const revised = await harness.tool.execute("call-2", { action: "revise", ...harness.guard() }, AbortSignal.abort(), undefined, harness.context);
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
    const cancelled = await harness.tool.execute("call-2", { action: "cancel", ...harness.guard() }, AbortSignal.abort(), undefined, harness.context);
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
    const revised = await harness.tool.execute("call-revise", { action: "revise", ...harness.guard() }, undefined, undefined, harness.context);
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

  test("the published admission port rechecks the owner and current task after notification", async () => {
    {
      const harness = await setup();
      harness.input("Please own the release checklist.");
      harness.beforeStart("Please own the release checklist.");
      const created = await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
      expect(created.isError).toBeUndefined();
      const task = harness.snapshot().currentTask!;
      const owner = currentTaskOwner()!;
      expect(admitPublishedTask(harness.context, "test-progress", task.taskId, task.taskRevision))
        .toMatchObject({ allowed: true, taskId: task.taskId, expectedTaskId: task.taskId, actionIndex: 1 });
      expect(harness.snapshot().currentTask!.admissions).toBe(1);

      owner.subscribe((event) => {
        if (event.type === "capability_admission_allowed") {
          owner.cancel(subjectFromContext(harness.context, owner.workspaceRoot), {
            taskId: task.taskId,
            taskRevision: task.taskRevision,
          });
        }
      });
      const revoked = admitPublishedTask(harness.context, "test-progress", task.taskId, task.taskRevision);
      expect(revoked).toMatchObject({
        allowed: false,
        taskId: task.taskId,
        expectedTaskId: task.taskId,
        actionIndex: 2,
        status: "cancelled",
        reason: expect.stringContaining("revoked"),
      });
      expect(harness.snapshot().currentTask!.admissions).toBe(2);
    }
    {
      const harness = await setup();
      harness.input("Please own the release checklist.");
      harness.beforeStart("Please own the release checklist.");
      await harness.tool.execute("call-1", { action: "start" }, undefined, undefined, harness.context);
      const task = harness.snapshot().currentTask!;
      const owner = currentTaskOwner()!;
      const context: OmpToolContext = {
        ...harness.context,
        sessionManager: {
          getSessionId: () => "session-b1-entry",
          getLeafId: () => null,
          getBranch: () => {
            clearPublishedTaskOwner(owner);
            return [];
          },
        },
      };
      const denied = admitPublishedTask(context, "test-progress", task.taskId, task.taskRevision);
      expect(denied).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("published task owner changed"),
        actionIndex: null,
      });
      expect(harness.snapshot().currentTask!.admissions).toBe(0);
    }
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
    const cancelled = await harness.tool.execute("call-cancel", { action: "cancel", ...harness.guard() }, undefined, undefined, harness.context);
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

    // A maximum accepted task must stay inspectable after cancellation. The
    // redundant full task+projection envelope no longer fits, so inspect
    // returns compact task facts plus the complete requirement projection
    // instead of truncating constraints or rejecting a valid historical read.
    const ownerBeforeInspect = JSON.stringify(harness.snapshot());
    const inspected = await harness.tool.execute("call-inspect", { action: "inspect" }, undefined, undefined, harness.context);
    expect(inspected.isError).toBeUndefined();
    const inspectBytes = new TextEncoder().encode(JSON.stringify(inspected)).byteLength;
    expect(inspectBytes).toBeLessThanOrEqual(MAX_TASK_CONTROL_RESPONSE_BYTES);
    const inspectedDetails = inspected.details as { compact?: boolean; task: Record<string, unknown>; requirements: Record<string, unknown> };
    expect(inspectedDetails.compact).toBe(true);
    expect(inspectedDetails.task).toMatchObject({
      taskId: created.taskId,
      ownerId: created.ownerId,
      taskRevision: 1,
      status: "cancelled",
      sourceCount: 1,
      amendmentCount: 0,
    });
    const inspectedRequirements = inspectedDetails.requirements as {
      original: { revision: number; text: string };
      amendments: Array<Record<string, unknown>>;
      taskRevision: number;
    };
    expect(inspectedRequirements.taskRevision).toBe(1);
    expect(inspectedRequirements.original).toMatchObject({ revision: 1, text: request });
    expect(inspectedRequirements.amendments).toHaveLength(0);
    expect(JSON.parse(inspected.content![0]!.text)).toEqual(inspectedDetails);
    expect(JSON.stringify(harness.snapshot())).toBe(ownerBeforeInspect);

    // Returned details are a detached snapshot: mutating them cannot change
    // the owner, and a fresh inspection still restates the complete source.
    inspectedRequirements.original.text = "FORGED";
    inspectedDetails.task.taskRevision = 99;
    inspectedDetails.task.status = "active";
    expect(harness.snapshot().currentTask!.requirementSources[0]!.text).toBe(request);
    expect(harness.snapshot().currentTask!.taskRevision).toBe(1);
    expect(harness.status()).toBe("cancelled");
    const reinspected = await harness.tool.execute("call-inspect-2", { action: "inspect" }, undefined, undefined, harness.context);
    expect(reinspected.isError).toBeUndefined();
    expect((reinspected.details as typeof inspectedDetails).requirements).toMatchObject({
      original: { revision: 1, text: request },
      taskRevision: 1,
    });
    expect((reinspected.details as typeof inspectedDetails).task).toMatchObject({ taskRevision: 1, status: "cancelled" });
  });

  test("a maximum accepted revision stays inspectable after cancellation with both source texts", async () => {
    const original = "o".repeat(1024);
    const attemptRevise = async (length: number): Promise<number | undefined> => {
      const probe = await setup();
      probe.input(original);
      probe.beforeStart(original);
      const started = await probe.tool.execute("call-start", { action: "start" }, undefined, undefined, probe.context);
      if (started.isError) throw new Error("test setup: near-limit original request did not start");
      probe.closeTurn(original);
      const amendment = "a".repeat(length);
      probe.input(amendment);
      probe.beforeStart(amendment);
      const revised = await probe.tool.execute("call-revise", { action: "revise", ...probe.guard() }, undefined, undefined, probe.context);
      return revised.isError ? undefined : new TextEncoder().encode(JSON.stringify(revised)).byteLength;
    };
    let low = 0;
    let high = 70_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await attemptRevise(mid)) === undefined) high = mid - 1;
      else low = mid;
    }
    const maximumAmendment = low;
    expect(maximumAmendment).toBeGreaterThan(20_000);

    const harness = await setup();
    harness.input(original);
    harness.beforeStart(original);
    const started = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(started.isError).toBeUndefined();
    const created = harness.snapshot().currentTask!;
    harness.closeTurn(original);

    const amendment = "a".repeat(maximumAmendment);
    harness.input(amendment);
    harness.beforeStart(amendment);
    const revised = await harness.tool.execute("call-revise", { action: "revise", ...harness.guard() }, undefined, undefined, harness.context);
    expect(revised.isError).toBeUndefined();
    const reviseBytes = new TextEncoder().encode(JSON.stringify(revised)).byteLength;
    expect(reviseBytes).toBeLessThanOrEqual(MAX_TASK_CONTROL_RESPONSE_BYTES);
    expect(reviseBytes).toBeGreaterThan(MAX_TASK_CONTROL_RESPONSE_BYTES - 512);
    expect(harness.snapshot().currentTask!.taskRevision).toBe(2);
    harness.closeTurn(amendment);

    const cancellation = "Please cancel the revised managed task.";
    harness.input(cancellation);
    harness.beforeStart(cancellation);
    const cancelled = await harness.tool.execute("call-cancel", { action: "cancel", ...harness.guard() }, undefined, undefined, harness.context);
    expect(cancelled.isError).toBeUndefined();
    expect(harness.status()).toBe("cancelled");
    expect(harness.snapshot().currentTask!.taskRevision).toBe(2);

    const ownerBeforeInspect = JSON.stringify(harness.snapshot());
    const inspected = await harness.tool.execute("call-inspect", { action: "inspect" }, undefined, undefined, harness.context);
    expect(inspected.isError).toBeUndefined();
    const inspectBytes = new TextEncoder().encode(JSON.stringify(inspected)).byteLength;
    expect(inspectBytes).toBeLessThanOrEqual(MAX_TASK_CONTROL_RESPONSE_BYTES);
    const details = inspected.details as {
      compact?: boolean;
      task: Record<string, unknown>;
      requirements: {
        taskRevision: number;
        original: { revision: number; text: string };
        amendments: Array<{ revision: number; previousRevision: number; source: string; text: string }>;
      };
    };
    expect(details.compact).toBe(true);
    expect(details.task).toMatchObject({
      taskId: created.taskId,
      taskRevision: 2,
      status: "cancelled",
      sourceCount: 2,
      amendmentCount: 1,
    });
    expect(details.requirements.taskRevision).toBe(2);
    expect(details.requirements.original).toMatchObject({ revision: 1, text: original });
    expect(details.requirements.amendments).toHaveLength(1);
    expect(details.requirements.amendments[0]).toMatchObject({
      revision: 2,
      previousRevision: 1,
      source: "rpc",
      text: amendment,
    });
    expect(JSON.parse(inspected.content![0]!.text)).toEqual(details);
    expect(JSON.stringify(harness.snapshot())).toBe(ownerBeforeInspect);

    details.requirements.original.text = "FORGED ORIGINAL";
    details.requirements.amendments[0]!.text = "FORGED AMENDMENT";
    details.task.taskRevision = 99;
    expect(harness.snapshot().currentTask!.requirementSources.map((source) => source.text)).toEqual([original, amendment]);
    expect(harness.snapshot().currentTask!.taskRevision).toBe(2);
    expect(harness.status()).toBe("cancelled");
    const reinspected = await harness.tool.execute("call-inspect-2", { action: "inspect" }, undefined, undefined, harness.context);
    expect(reinspected.isError).toBeUndefined();
    expect((reinspected.details as typeof details).requirements.original.text).toBe(original);
    expect((reinspected.details as typeof details).requirements.amendments[0]!.text).toBe(amendment);
    expect((reinspected.details as typeof details).task).toMatchObject({ taskRevision: 2, status: "cancelled" });
  });

  test("context hook projects fresh owner state without mutating the event messages", async () => {
    const harness = await setup();
    const prior: unknown[] = [{ role: "user", content: [{ type: "text", text: "Hello." }] }];
    expect(harness.projectContext(prior)).toBeUndefined();
    expect(prior).toHaveLength(1);

    const request = "Please own the release checklist.";
    harness.input(request);
    harness.beforeStart(request);
    const started = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(started.isError).toBeUndefined();

    const projected = harness.projectContext(prior) as { messages: unknown[] };
    expect(prior).toHaveLength(1);
    expect(projected.messages).toHaveLength(2);
    expect(projected.messages[0]).toBe(prior[0]);
    const injected = projected.messages[1] as {
      role: string;
      customType: string;
      content: string;
      display: boolean;
      attribution: string;
      timestamp: number;
    };
    expect(injected).toMatchObject({
      role: "custom",
      customType: "omp-agent.task-context",
      display: false,
      attribution: "agent",
    });
    expect(typeof injected.timestamp).toBe("number");
    const view = JSON.parse(injected.content) as {
      availability: string;
      task: { taskId: string; taskRevision: number; status: string };
      binding: { state: string };
      requirements: { original: { revision: number; text: string }; amendments: unknown[] };
      authorizedCapabilities: string[];
      provenance: Record<string, string>;
    };
    expect(view).toMatchObject({
      availability: "current",
      task: { taskRevision: 1, status: "active" },
      binding: { state: "attached" },
      requirements: { original: { revision: 1, text: request }, amendments: [] },
      authorizedCapabilities: ["test-progress"],
      provenance: {
        requirements: "host-observed-sources",
        understanding: "non-authoritative-model-note",
      },
    });
    expect(new TextEncoder().encode(JSON.stringify(injected)).byteLength).toBeLessThanOrEqual(128 * 1024);

    const amendment = "Please prefer low latency.";
    harness.closeTurn(request);
    harness.input(amendment);
    harness.beforeStart(amendment);
    const revised = await harness.tool.execute("call-revise", { action: "revise", ...harness.guard() }, undefined, undefined, harness.context);
    expect(revised.isError).toBeUndefined();
    const nextView = JSON.parse((harness.projectContext(prior) as { messages: Array<{ content: string }> }).messages[1]!.content) as typeof view & {
      requirements: { amendments: Array<{ revision: number; source: string; text: string }> };
    };
    expect(nextView.task.taskRevision).toBe(2);
    expect(nextView.requirements.amendments).toHaveLength(1);
    expect(nextView.requirements.amendments[0]).toMatchObject({ revision: 2, source: "rpc", text: amendment });

    harness.navigate();
    const detachedView = JSON.parse((harness.projectContext(prior) as { messages: Array<{ content: string }> }).messages[1]!.content) as typeof view & {
      binding: { state: string; reason: string; event: string };
    };
    expect(detachedView.availability).toBe("read-only-unavailable");
    expect(detachedView.binding).toMatchObject({ state: "detached", event: "session_tree" });
    expect(detachedView.binding.reason).toContain("navigation");
    expect(detachedView.requirements.original.text).toBe(request);
  });

  test("reentrant context input is replaced with one fresh projection at the latest revision", async () => {
    const harness = await setup();
    const prior: unknown[] = [{ role: "user", content: [{ type: "text", text: "Hello." }] }];
    const request = "Please own the original checklist.";
    harness.input(request);
    harness.beforeStart(request);
    const started = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(started.isError).toBeUndefined();
    const first = harness.projectContext(prior) as { messages: Array<Record<string, unknown>> };
    expect(first.messages).toHaveLength(2);
    expect(first.messages.filter((message) => message.customType === "omp-agent.task-context")).toHaveLength(1);

    const amendment = "Please amend with low latency.";
    harness.closeTurn(request);
    harness.input(amendment);
    harness.beforeStart(amendment);
    const revised = await harness.tool.execute("call-revise", { action: "revise", ...harness.guard() }, undefined, undefined, harness.context);
    expect(revised.isError).toBeUndefined();

    const second = harness.projectContext(first.messages) as { messages: Array<Record<string, unknown>> };
    expect(second.messages).toHaveLength(2);
    expect(second.messages[0] === prior[0]).toBe(true);
    const owned = second.messages.filter((message) => message.customType === "omp-agent.task-context");
    expect(owned).toHaveLength(1);
    const view = JSON.parse(String(owned[0]!.content)) as {
      task: { taskRevision: number };
      requirements: { amendments: Array<{ revision: number; text: string }> };
    };
    expect(view.task.taskRevision).toBe(2);
    expect(view.requirements.amendments).toEqual([expect.objectContaining({ revision: 2, text: amendment })]);
    // The earlier projection object was not mutated in place.
    expect(JSON.parse(String(first.messages[1]!.content))).toMatchObject({ task: { taskRevision: 1 } });
  });

  test("no-task context removes stale reserved projections and preserves unrelated messages", async () => {
    const harness = await setup();
    const stale = {
      role: "custom",
      customType: "omp-agent.task-context",
      content: JSON.stringify({ kind: "omp-agent.task-context", state: "unavailable" }),
      display: false,
      attribution: "agent",
      timestamp: 1,
    };
    const user = { role: "user", content: [{ type: "text", text: "Ordinary chat." }] };
    const result = harness.projectContext([user, stale]) as { messages: unknown[] };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toBe(user);
    expect(JSON.stringify(result.messages)).not.toContain("omp-agent.task-context");

    const onlyStale = harness.projectContext([stale]) as { messages: unknown[] };
    expect(onlyStale.messages).toHaveLength(0);
    // With no reserved projection present, normal no-task behavior is unchanged.
    expect(harness.projectContext([user])).toBeUndefined();
    expect(harness.taskCount()).toBe(0);
  });

describe("B3-A repair: entry owner binding and final admission usability", () => {
  test("a real tool getter that publishes a replacement owner neither mutates nor discloses the captured owner", async () => {
    const harness = await setup();
    const request = "Please own the retained release checklist.";
    harness.input(request);
    harness.beforeStart(request);
    const created = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    expect(created.isError).toBeUndefined();
    const task = harness.snapshot().currentTask!;
    const original = currentTaskOwner()!;
    expect(original.snapshot().tasksCreated).toBe(1);
    const branch = harness.context.sessionManager!.getBranch();
    const replacement = harness.adopt(new TaskOwner({
      workspaceRoot: original.workspaceRoot,
      ownerId: "owner-b3a-replacement",
    }));
    const context: OmpToolContext = {
      ...harness.context,
      sessionManager: {
        getSessionId: () => harness.context.sessionManager!.getSessionId(),
        getLeafId: () => harness.context.sessionManager!.getLeafId(),
        getBranch: () => {
          publishTaskOwner(replacement);
          return branch;
        },
      },
    };
    try {
      for (const params of [{ action: "history" }, { action: "inspect" }] as const) {
        const result = await harness.tool.execute("call-replaced", params, undefined, undefined, context);
        expect(result.isError).toBe(true);
        const serialized = JSON.stringify(result);
        expect(serialized).toContain("published task owner changed");
        expect(serialized).not.toContain(task.taskId);
        expect(serialized).not.toContain(request);
      }
      expect(original.snapshot().tasksCreated).toBe(1);
      expect(original.snapshot().currentTask?.taskId).toBe(task.taskId);
      expect(original.snapshot().currentTask?.rawRequest).toBe(request);
      expect(replacement.snapshot().tasksCreated).toBe(0);
    } finally {
      clearPublishedTaskOwner(replacement);
      publishTaskOwner(original);
    }
  });

  test("a replacement published during start preflight commits no task in the stale owner", async () => {
    let replacement: TaskOwner | undefined;
    const harness = await setup({
      id: () => {
        if (replacement !== undefined) publishTaskOwner(replacement);
        return "stale-preflight-id";
      },
    });
    const original = currentTaskOwner()!;
    replacement = harness.adopt(new TaskOwner({
      workspaceRoot: original.workspaceRoot,
      ownerId: "owner-b3a-preflight-replacement",
    }));
    const request = "Please own the stale preflight checklist.";
    harness.input(request);
    harness.beforeStart(request);
    try {
      const result = await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("published task owner changed");
      expect(harness.taskCount()).toBe(0);
      expect(harness.snapshot().currentTask).toBeNull();
      expect(replacement.snapshot().tasksCreated).toBe(0);
    } finally {
      clearPublishedTaskOwner(replacement);
      publishTaskOwner(original);
    }
  });

  test("the final admission check denies an unreachable final branch after retaining the committed admission", async () => {
    const harness = await setup();
    const request = "Please own the release checklist.";
    harness.input(request);
    harness.beforeStart(request);
    await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    const task = harness.snapshot().currentTask!;
    const owner = currentTaskOwner()!;
    const branch = harness.context.sessionManager!.getBranch();
    let hits = 0;
    const context: OmpToolContext = {
      ...harness.context,
      sessionManager: {
        getSessionId: () => "session-b1-entry",
        getLeafId: () => null,
        getBranch: () => {
          hits += 1;
          return hits === 1 ? branch : [baseEntry()];
        },
      },
    };
    const decision = admitPublishedTask(context, "test-progress", task.taskId, task.taskRevision);
    expect(hits).toBe(2);
    expect(decision).toMatchObject({
      allowed: false,
      taskId: task.taskId,
      taskRevision: 1,
      expectedTaskId: task.taskId,
      expectedTaskRevision: 1,
      actionIndex: 1,
    });
    expect(String(decision.reason)).toContain("anchor is not in the current conversation branch");
    expect(harness.snapshot().currentTask!.admissions).toBe(1);
    expect(owner.snapshot().currentTask!.admissions).toBe(1);
  });

  test("the final admission check denies an acceptance reservation created by the last getter", async () => {
    const harness = await setup();
    const request = "Please own the release checklist.";
    harness.input(request);
    harness.beforeStart(request);
    await harness.tool.execute("call-start", { action: "start" }, undefined, undefined, harness.context);
    const task = harness.snapshot().currentTask!;
    const owner = currentTaskOwner()!;
    const branch = harness.context.sessionManager!.getBranch();
    const frozen = {
      ownerId: task.ownerId,
      taskId: task.taskId,
      taskRevision: task.taskRevision,
      requirementsDigest: requirementsDigest(task.requirementSources),
    };
    const subject: TaskSubject = {
      sessionId: "session-b1-entry",
      workspaceRoot: owner.workspaceRoot,
      agentKind: "main",
      branch,
    };
    let token: object | undefined;
    let hits = 0;
    const context: OmpToolContext = {
      ...harness.context,
      sessionManager: {
        getSessionId: () => "session-b1-entry",
        getLeafId: () => null,
        getBranch: () => {
          hits += 1;
          if (hits === 2) token = owner.reserveAcceptance(subject, frozen);
          return branch;
        },
      },
    };
    try {
      const decision = admitPublishedTask(context, "test-progress", task.taskId, task.taskRevision);
      expect(hits).toBe(2);
      expect(token).toBeDefined();
      expect(owner.reservationCurrent(token!)).toBe(true);
      expect(decision).toMatchObject({
        allowed: false,
        taskId: task.taskId,
        taskRevision: 1,
        expectedTaskId: task.taskId,
        expectedTaskRevision: 1,
        actionIndex: 1,
      });
      expect(String(decision.reason)).toContain("acceptance reservation");
      expect(harness.snapshot().currentTask!.admissions).toBe(1);
    } finally {
      if (token !== undefined) owner.releaseAcceptance(token);
    }
  });
});
