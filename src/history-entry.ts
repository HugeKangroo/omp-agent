import {
  MAX_TASK_CONTROL_RESPONSE_BYTES,
  encodedUtf8Bytes,
} from "./task-requirements.ts";
import type { OmpToolContext } from "./task-entry-port.ts";
import {
  createHistoryView,
  HISTORY_CURSOR_PATTERN,
  HISTORY_SELECTOR_PATTERN,
  HISTORY_QUERY_PAGE_LIMIT,
  HISTORY_VIEW_SCHEMA_VERSION,
  type HistoryQueryStatus,
  type HistoryViewErrorCode,
  type HistoryViewOptions,
  type HistoryWithheldReason,
} from "./history-view.ts";

/**
 * G3-B2a main-only read-only history query.
 *
 * The tool is a transport over `history-view.ts`; it adds the strict runtime
 * argument parser and the complete ToolResult envelope bound. It has no
 * resume, authority, run or acceptance path.
 */

export const HISTORY_TOOL = "agent_history" as const;

const LIST_KEYS = ["action", "limit", "cursor"] as const;
const INSPECT_KEYS = ["action", "selector"] as const;

export const HISTORY_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "inspect"],
      description: "Read-only action. list returns bounded recorded summaries and opaque selectors; inspect returns one complete recorded item.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: HISTORY_QUERY_PAGE_LIMIT,
      description: `Optional list page size, at most ${HISTORY_QUERY_PAGE_LIMIT}. The page advances by evaluated candidate locators, not by returned rows.`,
    },
    cursor: {
      type: "string",
      description: "Opaque cursor returned by a previous list. Do not construct or reuse it after the locator set changes.",
    },
    selector: {
      type: "string",
      description: "Opaque selector returned by list. It is a lookup key, never authority, and cannot name a path, root, instance, session, task or revision.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export interface HistoryToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}

interface HistoryTool {
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
  [key: string]: unknown;
}

export interface HistoryRegistrationApi {
  registerTool(tool: HistoryTool): void;
}

export interface HistoryEntryControls {
  navigate(event: string): void;
  dispose(): void;
  status(): HistoryQueryStatus;
}

type ParsedArguments =
  | { ok: true; action: "list"; limit: number; cursor?: string }
  | { ok: true; action: "inspect"; selector: string }
  | { ok: false; action: "list" | "inspect" | "invalid" };

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function onlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

/** Strict runtime parser; the JSON schema is not the enforcement boundary. */
export function parseHistoryArguments(params: unknown): ParsedArguments {
  const record = plainObject(params);
  if (record === null) return { ok: false, action: "invalid" };
  const action = record.action;
  if (action === "list") {
    if (!onlyAllowedKeys(record, LIST_KEYS)) return { ok: false, action: "list" };
    const limit = record.limit;
    if (limit !== undefined
      && (typeof limit !== "number" || !Number.isSafeInteger(limit)
        || limit < 1 || limit > HISTORY_QUERY_PAGE_LIMIT)) {
      return { ok: false, action: "list" };
    }
    const cursor = record.cursor;
    if (cursor !== undefined
      && (typeof cursor !== "string" || !HISTORY_CURSOR_PATTERN.test(cursor))) {
      return { ok: false, action: "list" };
    }
    return {
      ok: true,
      action: "list",
      limit: limit === undefined ? HISTORY_QUERY_PAGE_LIMIT : limit,
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
  if (action === "inspect") {
    if (!onlyAllowedKeys(record, INSPECT_KEYS) || !Object.hasOwn(record, "selector")) {
      return { ok: false, action: "inspect" };
    }
    const selector = record.selector;
    if (typeof selector !== "string" || !HISTORY_SELECTOR_PATTERN.test(selector)) {
      return { ok: false, action: "inspect" };
    }
    return { ok: true, action: "inspect", selector };
  }
  return { ok: false, action: "invalid" };
}

function errorPayload(
  action: "list" | "inspect" | "invalid",
  error: HistoryViewErrorCode,
  reason?: HistoryWithheldReason,
): Record<string, unknown> {
  return {
    schemaVersion: HISTORY_VIEW_SCHEMA_VERSION,
    action,
    error,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** One versioned JSON content payload; the complete envelope is size checked. */
export function formatHistoryResult(
  action: "list" | "inspect" | "invalid",
  payload: unknown,
  isError: boolean,
): HistoryToolResult {
  const result: HistoryToolResult = {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
  if (encodedUtf8Bytes(result) <= MAX_TASK_CONTROL_RESPONSE_BYTES) return result;
  // Never truncate an item; refuse the complete payload explicitly.
  return {
    content: [{
      type: "text",
      text: JSON.stringify(errorPayload(action, "too_large")),
    }],
    isError: true,
  };
}

export function createHistoryEntry(
  api: HistoryRegistrationApi,
  options: HistoryViewOptions,
): HistoryEntryControls {
  const view = createHistoryView(options);
  const tool: HistoryTool = {
    name: HISTORY_TOOL,
    label: "Recorded task history",
    description: "Read bounded local historical task records on this exact session branch. Only the actual main agent in the active daily composition may use it. list returns recorded status summaries and opaque host selectors; inspect returns one complete recorded item. Both are read-only local records: they do not restore authority, prove acceptance evidence, associate runs, or change the current task. Selectors and cursors cannot name paths, roots, instances, owners, tasks, revisions, sessions or permissions.",
    parameters: HISTORY_PARAMETERS,
    approval: "read",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      let action: "list" | "inspect" | "invalid" = "invalid";
      try {
        const parsed = parseHistoryArguments(params);
        action = parsed.action;
        if (!parsed.ok) {
          return formatHistoryResult(action, errorPayload(action, "invalid_arguments"), true);
        }
        if (signal?.aborted) {
          return formatHistoryResult(parsed.action, errorPayload(parsed.action, "aborted"), true);
        }
        if (parsed.action === "list") {
          const outcome = view.list(
            context,
            {
              limit: parsed.limit,
              ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            },
            signal,
          );
          if (!outcome.ok) {
            return formatHistoryResult(parsed.action, errorPayload(parsed.action, outcome.code), true);
          }
          return formatHistoryResult(parsed.action, outcome.view, false);
        }
        const outcome = view.inspect(context, parsed.selector, signal);
        if (!outcome.ok) {
          return formatHistoryResult(
            parsed.action,
            errorPayload(parsed.action, outcome.code, outcome.reason),
            true,
          );
        }
        return formatHistoryResult(parsed.action, outcome.view, false);
      } catch {
        return formatHistoryResult(action, errorPayload(action, "unavailable"), true);
      }
    },
  };
  api.registerTool(tool);
  return {
    navigate(event: string): void {
      view.navigate(event);
    },
    dispose(): void {
      view.dispose();
    },
    status(): HistoryQueryStatus {
      return view.status();
    },
  };
}
