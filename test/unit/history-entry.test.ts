import { describe, expect, test } from "bun:test";
import {
  createHistoryEntry,
  formatHistoryResult,
  HISTORY_PARAMETERS,
  HISTORY_TOOL,
  parseHistoryArguments,
  type HistoryToolResult,
} from "../../src/history-entry.ts";
import type { OmpToolContext } from "../../src/task-entry-port.ts";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: "read" | "write" | "exec";
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<HistoryToolResult>;
}

function registerFailureContext(): OmpToolContext {
  return {
    cwd: "/definitely/not/the/workspace",
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "entry-test-session",
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1", parentId: null, type: "custom", customType: "base", data: {} }],
    },
  };
}

function registered(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  createHistoryEntry(
    {
      registerTool(candidate) {
        tool = candidate as unknown as RegisteredTool;
      },
    },
    {
      stateRoot: "/definitely/not/a/state/root",
      workspaceRoot: "/definitely/not/the/workspace",
      isCurrentComposition: () => true,
    },
  );
  expect(tool).toBeDefined();
  return tool!;
}

function errorOf(result: HistoryToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  expect(parsed.schemaVersion).toBe("agent-history-view-v1");
  return parsed;
}

describe("B2a history tool transport", () => {
  test("declares the fifth managed tool as read-only essential with a strict schema", () => {
    const tool = registered();
    expect(tool.name).toBe(HISTORY_TOOL);
    expect(tool.name).toBe("agent_history");
    expect(tool.approval).toBe("read");
    expect(tool.loadMode).toBe("essential");
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action"],
    });
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.action).toMatchObject({ type: "string", enum: ["list", "inspect"] });
    expect(properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 16 });
    expect(properties.cursor).toMatchObject({ type: "string" });
    expect(properties.selector).toMatchObject({ type: "string" });
    expect(Object.keys(properties).sort()).toEqual(["action", "cursor", "limit", "selector"]);
  });

  test("accepts omitted optional metadata with defaults and rejects every extra authority field", () => {
    expect(parseHistoryArguments({ action: "list" })).toEqual({ ok: true, action: "list", limit: 16 });
    expect(parseHistoryArguments({ action: "list", limit: 16 })).toEqual({
      ok: true,
      action: "list",
      limit: 16,
    });
    expect(parseHistoryArguments({ action: "list", limit: 1 })).toEqual({
      ok: true,
      action: "list",
      limit: 1,
    });
    const cursor = `hcur_${"a".repeat(32)}`;
    expect(parseHistoryArguments({ action: "list", limit: 2, cursor })).toEqual({
      ok: true,
      action: "list",
      limit: 2,
      cursor,
    });
    const selector = `hsel_${"b".repeat(32)}`;
    expect(parseHistoryArguments({ action: "inspect", selector })).toEqual({
      ok: true,
      action: "inspect",
      selector,
    });

    const rejected: unknown[] = [
      null,
      [],
      "list",
      {},
      { action: "start" },
      { action: "list", path: "/tmp/history-index.json" },
      { action: "list", root: "/" },
      { action: "list", instanceId: "instance" },
      { action: "list", ownerId: "owner" },
      { action: "list", taskId: "task" },
      { action: "list", taskRevision: 1 },
      { action: "list", sessionId: "session" },
      { action: "list", permissions: ["read"] },
      { action: "list", selector },
      { action: "list", limit: 0 },
      { action: "list", limit: 17 },
      { action: "list", limit: 1.5 },
      { action: "list", limit: "2" },
      { action: "list", cursor: "0" },
      { action: "list", cursor: "hcur_" + "a".repeat(31) },
      { action: "inspect" },
      { action: "inspect", selector: "hsel_short" },
      { action: "inspect", selector, limit: 1 },
      { action: "inspect", selector, cursor },
      { action: "inspect", selector, path: "/tmp/x" },
    ];
    for (const value of rejected) expect(parseHistoryArguments(value).ok).toBe(false);
    expect(HISTORY_PARAMETERS.additionalProperties).toBe(false);
  });

  test("registered execution accepts {action:list} defaults and fails later on actual missing session identity", async () => {
    const tool = registered();
    const result = await tool.execute(
      "call-default-list",
      { action: "list" },
      undefined,
      undefined,
      registerFailureContext(),
    );
    const error = errorOf(result);
    expect(error.action).toBe("list");
    expect(error.error).toBe("session_unavailable");

    const explicit = await tool.execute(
      "call-explicit-list",
      { action: "list", limit: 16 },
      undefined,
      undefined,
      registerFailureContext(),
    );
    expect(errorOf(explicit).error).toBe("session_unavailable");

    const wrong = await tool.execute(
      "call-invalid",
      { action: "list", ownerId: "model-supplied" },
      undefined,
      undefined,
      registerFailureContext(),
    );
    expect(errorOf(wrong)).toMatchObject({ action: "list", error: "invalid_arguments" });

    const missingSelector = await tool.execute(
      "call-inspect",
      { action: "inspect" },
      undefined,
      undefined,
      registerFailureContext(),
    );
    expect(errorOf(missingSelector)).toMatchObject({ action: "inspect", error: "invalid_arguments" });
  });

  test("aborted invocation is refused without reading the host context", async () => {
    const tool = registered();
    const result = await tool.execute(
      "call-aborted",
      { action: "list" },
      { aborted: true } as AbortSignal,
      undefined,
      registerFailureContext(),
    );
    expect(errorOf(result)).toMatchObject({ action: "list", error: "aborted" });
  });

  test("formatter-only byte gate refuses an oversized envelope instead of truncating", () => {
    const small = formatHistoryResult("inspect", { schemaVersion: "agent-history-view-v1" }, false);
    expect(small.isError).toBeUndefined();
    expect(JSON.parse(small.content[0]!.text)).toEqual({ schemaVersion: "agent-history-view-v1" });

    // Formatter-only evidence: current valid A rows cannot reach this size
    // because the item and ledger limits are far smaller.
    const oversized = formatHistoryResult(
      "inspect",
      {
        schemaVersion: "agent-history-view-v1",
        action: "inspect",
        item: { text: "x".repeat(300 * 1024) },
      },
      false,
    );
    const error = errorOf(oversized);
    expect(error).toEqual({
      schemaVersion: "agent-history-view-v1",
      action: "inspect",
      error: "too_large",
    });
    expect(oversized.content[0]!.text.length).toBeLessThan(1024);

    const multibyte = formatHistoryResult(
      "list",
      { text: "界".repeat(100 * 1024) },
      false,
    );
    expect(errorOf(multibyte).error).toBe("too_large");
  });

  test("dispose clears the registered view status", () => {
    let tool: RegisteredTool | undefined;
    const controls = createHistoryEntry(
      { registerTool(candidate) { tool = candidate as unknown as RegisteredTool; } },
      {
        stateRoot: "/definitely/not/a/state/root",
        workspaceRoot: "/definitely/not/the/workspace",
        isCurrentComposition: () => true,
      },
    );
    expect(tool).toBeDefined();
    expect(controls.status()).toMatchObject({ disposed: false, view: "none" });
    controls.navigate("session_tree");
    controls.dispose();
    controls.dispose();
    expect(controls.status()).toMatchObject({ disposed: true, view: "none", selectors: 0 });
  });
});
