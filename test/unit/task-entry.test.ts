import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskEntry } from "../../src/task-entry.ts";
import type { OmpToolContext } from "../../src/task-entry-port.ts";

type Api = Parameters<typeof createTaskEntry>[0];
type Tool = { execute(id: string, params: unknown, signal: AbortSignal | undefined, update: unknown, context: OmpToolContext): Promise<{ isError?: boolean; details?: unknown }> };

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function branch(text: string) {
  return [
    { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
    { id: "user-1", parentId: "leaf-1", type: "message", message: { role: "user", content: [{ type: "text", text }], attribution: "user" } },
  ];
}

async function setup(): Promise<{
  tool: Tool;
  context: OmpToolContext;
  input(text: string): void;
  beforeStart(text: string): void;
  taskCount(): number;
  status(): string | null;
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
  const context: OmpToolContext = {
    cwd: workspace,
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "session-b1-entry",
      getLeafId: () => "leaf-1",
      getBranch: () => branch(currentText),
    },
  };
  return {
    tool: tool!,
    context,
    input(text: string) {
      currentText = text;
      handlers.get("input")!({ text, source: "rpc" }, context);
    },
    beforeStart(text: string) {
      handlers.get("before_agent_start")!({ prompt: text, reason: "prompt" }, context);
    },
    taskCount: () => owner.snapshot().tasksCreated,
    status: () => owner.snapshot().currentTask?.status ?? null,
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
