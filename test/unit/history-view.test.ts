import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHistoryProjectionWriter,
  HistoryProjectionReader,
  type HistoryItem,
  type HistoryProjectionWriter,
} from "../../src/history-projection.ts";
import { HISTORY_LOCATOR_CUSTOM_TYPE } from "../../src/history-session.ts";
import {
  createHistoryView,
  HISTORY_CURSOR_PATTERN,
  HISTORY_SELECTOR_PATTERN,
  HISTORY_VIEW_SCHEMA_VERSION,
  type HistoryViewControls,
  type HistoryWithheldReason,
} from "../../src/history-view.ts";
import type { OmpSessionManager, OmpToolContext } from "../../src/task-entry-port.ts";
import {
  TaskOwner,
  type ManagedTask,
  type TaskSubject,
} from "../../src/task-owner.ts";

const SESSION = "g3b2-view-session";
const OWNER_ID = "owner-g3b2-view";
const FRESH_OWNER_ID = "owner-g3b2-fresh";
const INSTANCE_ID = "instance-g3b2-view";
const NOW = "2026-11-09T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

interface ContextOptions {
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  agentKind?: "main" | "sub";
  omitSessionFile?: boolean;
  branchRead?: (count: number) => void;
  leafRead?: (count: number) => void;
}

interface Harness {
  root: string;
  workspace: string;
  stateRoot: string;
  instancesRoot: string;
  instanceRoot: string;
  indexPath: string;
  sessionFile: string;
  sessionId: string;
  owner: TaskOwner;
  writer: HistoryProjectionWriter;
  branch: Entry[];
  leafId: string;
  composition: boolean;
  views: HistoryViewControls[];
  subject(): TaskSubject;
  appendEntry(entry: Entry): Entry;
  appendUser(id: string, text: string, extra?: Record<string, unknown>): Entry;
  appendAssistant(id: string): Entry;
  startTask(id: string, text: string): { task: ManagedTask; item: HistoryItem };
  reviseTask(id: string, text: string): { task: ManagedTask; item: HistoryItem };
  cancelTask(id: string, text: string): { task: ManagedTask; item: HistoryItem };
  locatorData(item: HistoryItem, overrides?: Record<string, unknown>): Record<string, unknown>;
  appendLocator(data: Record<string, unknown>, id?: string): Entry;
  captureLocator(task: ManagedTask): { item: HistoryItem; entry: Entry };
  context(options?: ContextOptions): OmpToolContext;
  view(): HistoryViewControls;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function userEntry(id: string, parentId: string, text: string, extra: Record<string, unknown> = {}): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      attribution: "user",
      ...extra,
    },
  };
}

function assistantEntry(id: string, parentId: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "working" }] },
  };
}

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function harness(): Harness {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "omp-agent-g3b2-view-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace, { mode: 0o700 });
  const stateRoot = path.join(root, "state");
  const instancesRoot = path.join(stateRoot, "instances");
  const instanceRoot = path.join(instancesRoot, INSTANCE_ID);
  mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(root, "session.jsonl");
  writeFileSync(sessionFile, "", { mode: 0o600 });
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: OWNER_ID,
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const writer = createHistoryProjectionWriter({
    instanceRoot,
    instanceId: INSTANCE_ID,
    ownerId: OWNER_ID,
    workspaceRoot: workspace,
  });

  const h: Harness = {
    root,
    workspace,
    stateRoot,
    instancesRoot,
    instanceRoot,
    indexPath: path.join(instanceRoot, "history-index.json"),
    sessionFile,
    sessionId: SESSION,
    owner,
    writer,
    branch: [{ id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} }],
    leafId: "leaf-1",
    composition: true,
    views: [],
    subject(): TaskSubject {
      return {
        sessionId: SESSION,
        workspaceRoot: workspace,
        agentKind: "main",
        branch: h.branch.slice(),
      };
    },
    appendEntry(entry) {
      const withParent = entry.parentId === undefined
        ? { ...entry, parentId: h.leafId }
        : entry;
      h.branch.push(withParent);
      h.leafId = entry.id;
      return withParent;
    },
    appendUser(id, text, extra = {}) {
      return h.appendEntry(userEntry(id, h.leafId, text, extra));
    },
    appendAssistant(id) {
      return h.appendEntry(assistantEntry(id, h.leafId));
    },
    startTask(id, text) {
      const entry = h.appendUser(id, text);
      expect(h.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: workspace,
        source: "rpc",
        text,
        observedAt: NOW,
        baseLeafId: entry.parentId!,
      }).accepted).toBe(true);
      h.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
      const result = h.owner.start(h.subject());
      expect(h.owner.closeTurn({
        sessionId: SESSION,
        branch: h.branch.slice(),
        messages: [messageOf(entry)],
      })).toBe(true);
      return { task: result.task, item: h.captureLocator(result.task).item };
    },
    reviseTask(id, text) {
      h.appendAssistant(`assistant-${id}`);
      const entry = h.appendUser(id, text);
      expect(h.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: workspace,
        source: "rpc",
        text,
        observedAt: NOW,
        baseLeafId: entry.parentId!,
      }).accepted).toBe(true);
      h.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
      const current = h.owner.snapshot().currentTask!;
      const result = h.owner.revise(h.subject(), {
        taskId: current.taskId,
        taskRevision: current.taskRevision,
      });
      expect(h.owner.closeTurn({
        sessionId: SESSION,
        branch: h.branch.slice(),
        messages: [messageOf(entry)],
      })).toBe(true);
      return { task: result.task, item: h.captureLocator(result.task).item };
    },
    cancelTask(id, text) {
      h.appendAssistant(`assistant-${id}`);
      const entry = h.appendUser(id, text);
      expect(h.owner.observeInput({
        sessionId: SESSION,
        workspaceRoot: workspace,
        source: "rpc",
        text,
        observedAt: NOW,
        baseLeafId: entry.parentId!,
      }).accepted).toBe(true);
      h.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
      const current = h.owner.snapshot().currentTask!;
      const task = h.owner.cancel(h.subject(), {
        taskId: current.taskId,
        taskRevision: current.taskRevision,
      });
      expect(h.owner.closeTurn({
        sessionId: SESSION,
        branch: h.branch.slice(),
        messages: [messageOf(entry)],
      })).toBe(true);
      return { task, item: h.captureLocator(task).item };
    },
    locatorData(item, overrides = {}) {
      return {
        version: 1,
        instanceId: INSTANCE_ID,
        ownerId: OWNER_ID,
        historyId: item.historyId,
        digest: item.digest,
        taskId: item.taskId,
        taskRevision: item.taskRevision,
        originSessionId: item.anchor.sessionId,
        ...overrides,
      };
    },
    appendLocator(data, id) {
      const locatorId = id ?? `locator-${h.branch.length}`;
      return h.appendEntry({
        id: locatorId,
        parentId: h.leafId,
        type: "custom",
        customType: HISTORY_LOCATOR_CUSTOM_TYPE,
        data,
      });
    },
    captureLocator(task) {
      const result = h.writer.capture(task);
      const entry = h.appendLocator(h.locatorData(result.item));
      return { item: result.item, entry };
    },
    context(options = {}) {
      let branchReads = 0;
      let leafReads = 0;
      const manager: OmpSessionManager = {
        getSessionId: () => options.sessionId ?? h.sessionId,
        getLeafId: () => {
          leafReads += 1;
          options.leafRead?.(leafReads);
          return h.leafId;
        },
        getBranch: () => {
          branchReads += 1;
          options.branchRead?.(branchReads);
          return h.branch.slice();
        },
        ...(options.omitSessionFile === true ? {} : {
          getSessionFile: () => options.sessionFile ?? h.sessionFile,
        }),
      };
      return {
        cwd: options.cwd ?? workspace,
        agent: { kind: options.agentKind ?? "main" },
        sessionManager: manager,
      };
    },
    view() {
      const view = createHistoryView({
        stateRoot,
        workspaceRoot: workspace,
        isCurrentComposition: () => h.composition,
      });
      h.views.push(view);
      return view;
    },
  };
  return h;
}

function buildFourRows(h: Harness): {
  first: { task: ManagedTask; item: HistoryItem };
  revised: { task: ManagedTask; item: HistoryItem };
  cancelled: { task: ManagedTask; item: HistoryItem };
  second: { task: ManagedTask; item: HistoryItem };
} {
  const first = h.startTask("user-1", "Original request — 一\nsecond line");
  const revised = h.reviseTask("user-2", "Amendment — 二");
  const cancelled = h.cancelTask("user-3", "Cancel it.");
  const second = h.startTask("user-4", "A different task.");
  return { first, revised, cancelled, second };
}

function expectWithheldPage(
  h: Harness,
  reason: HistoryWithheldReason,
  count = 1,
  inspected = 0,
): void {
  const view = h.view();
  const listed = view.list(h.context(), { limit: 16 });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.view.items).toEqual([]);
  expect(listed.view.result).toBe("no_visible_history");
  expect(listed.view.coverage.returned).toBe(0);
  expect(listed.view.coverage.withheld).toBe(count);
  expect(listed.view.coverage.withheldReasons[reason]).toBeGreaterThanOrEqual(count);
  expect(listed.view.coverage.evaluated).toBe(count);
  expect(listed.view.coverage.inspected).toBe(inspected);
}

describe("B2a selected-branch history view", () => {
  test("lists and inspects real committed revisions and a second task without touching owner or files", () => {
    const h = harness();
    const { first, revised, cancelled, second } = buildFourRows(h);
    const fresh = new TaskOwner({ workspaceRoot: h.workspace, ownerId: FRESH_OWNER_ID });
    const freshBefore = fresh.snapshot();
    const ownerBefore = h.owner.snapshot();
    const indexBefore = readFileSync(h.indexPath);
    const branchBefore = h.branch.length;
    const filesBefore = readdirSync(h.instanceRoot).sort();
    const view = h.view();

    const listed = view.list(h.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.view.schemaVersion).toBe(HISTORY_VIEW_SCHEMA_VERSION);
    expect(listed.view.action).toBe("list");
    expect(listed.view.scope).toBe("selected_branch");
    expect(listed.view.result).toBe("visible_history");
    expect(listed.view.items.map((item) => [
      item.taskId,
      item.taskRevision,
      item.recordedStatus,
      item.sourceCount,
      item.amendmentCount,
    ])).toEqual([
      [first.task.taskId, 1, "active", 1, 0],
      [revised.task.taskId, 2, "active", 2, 1],
      [cancelled.task.taskId, 2, "cancelled", 2, 1],
      [second.task.taskId, 1, "active", 1, 0],
    ]);
    expect(listed.view.coverage).toMatchObject({
      candidates: 4,
      evaluated: 4,
      inspected: 4,
      returned: 4,
      withheld: 0,
      duplicatesCollapsed: 0,
      more: false,
    });
    expect(listed.view.nextCursor).toBeNull();
    expect(listed.view.budget).toMatchObject({
      inspections: 4,
      inspectionLimit: 16,
      prechargedBytes: 4 * 1024 * 1024,
      bytesLimit: 16 * 1024 * 1024,
    });
    expect(listed.view.evidence).toMatchObject({
      historical: true,
      authorityRestored: false,
      evidence: "local-record",
      presentExecution: "not_checked",
      acceptanceEvidence: "not_checked",
      candidateRegistration: "not_checked",
      projection: { branchVisibility: "not_checked" },
      bridge: { selectedBranch: "checked", requirementLedger: "checked", runEvidence: "not_checked" },
    });
    for (const item of listed.view.items) expect(item.selector).toMatch(HISTORY_SELECTOR_PATTERN);
    const listWire = JSON.stringify(listed.view);
    expect(listWire).not.toContain(h.root);
    expect(listWire).not.toContain("history-index.json");
    expect(listWire).not.toContain("task-state.json");

    const expected = [first.item, revised.item, cancelled.item, second.item];
    for (let index = 0; index < listed.view.items.length; index += 1) {
      const inspected = view.inspect(h.context(), listed.view.items[index]!.selector);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok) continue;
      expect(inspected.view.item).toEqual(expected[index]!);
      expect(inspected.view.evidence.bridge.requirementLedger).toBe("checked");
      expect(inspected.view.budget.inspections).toBe(1);
      const inspectWire = JSON.stringify(inspected.view);
      expect(inspectWire).not.toContain(h.root);
      expect(inspectWire).not.toContain("history-index.json");
    }

    expect(h.owner.snapshot()).toEqual(ownerBefore);
    expect(fresh.snapshot()).toEqual(freshBefore);
    expect(fresh.snapshot().currentTask).toBeNull();
    expect(readFileSync(h.indexPath)).toEqual(indexBefore);
    expect(h.branch).toHaveLength(branchBefore);
    expect(readdirSync(h.instanceRoot).sort()).toEqual(filesBefore);
  });

  test("pages by candidate position, survives ordinary assistant/toolResult appends, and repeats cursors idempotently", () => {
    const h = harness();
    const rows = buildFourRows(h);
    const view = h.view();

    const pageOne = view.list(h.context(), { limit: 2 });
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) return;
    expect(pageOne.view.items.map((item) => item.taskId)).toEqual([
      rows.first.task.taskId,
      rows.revised.task.taskId,
    ]);
    expect(pageOne.view.coverage).toMatchObject({ evaluated: 2, returned: 2, more: true });
    expect(pageOne.view.nextCursor).toMatch(HISTORY_CURSOR_PATTERN);

    const cursor = pageOne.view.nextCursor!;
    const pageTwo = view.list(h.context(), { limit: 2, cursor });
    expect(pageTwo.ok).toBe(true);
    if (!pageTwo.ok) return;
    expect(pageTwo.view.items.map((item) => item.taskId)).toEqual([
      rows.cancelled.task.taskId,
      rows.second.task.taskId,
    ]);
    expect(pageTwo.view.nextCursor).toBeNull();
    expect(pageTwo.view.coverage.more).toBe(false);

    const repeatedTwo = view.list(h.context(), { limit: 2, cursor });
    expect(repeatedTwo.ok).toBe(true);
    if (!repeatedTwo.ok) return;
    expect(repeatedTwo.view.items).toEqual(pageTwo.view.items);
    expect(view.list(h.context(), { limit: 2, cursor: `hcur_${"f".repeat(32)}` })).toEqual({
      ok: false,
      code: "cursor_invalid",
    });
    expect(view.list(h.context(), { limit: 17 })).toEqual({
      ok: false,
      code: "invalid_arguments",
    });

    h.appendAssistant("assistant-after-list");
    h.appendEntry({
      id: "tool-result-1",
      parentId: h.leafId,
      type: "toolResult",
      toolName: "read",
      data: { ordinary: true },
    });

    const inspected = view.inspect(h.context(), pageOne.view.items[0]!.selector);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) expect(inspected.view.item).toEqual(rows.first.item);

    const repeatedAfterAppend = view.list(h.context(), { limit: 2, cursor });
    expect(repeatedAfterAppend.ok).toBe(true);
    if (repeatedAfterAppend.ok) {
      expect(repeatedAfterAppend.view.items.map((item) => item.taskId)).toEqual([
        rows.cancelled.task.taskId,
        rows.second.task.taskId,
      ]);
    }
    const changedLimit = view.list(h.context(), { limit: 3, cursor });
    expect(changedLimit.ok).toBe(true);
    if (changedLimit.ok) {
      expect(changedLimit.view.items.map((item) => item.taskId)).toEqual([
        rows.cancelled.task.taskId,
        rows.second.task.taskId,
      ]);
      expect(changedLimit.view.coverage.evaluated).toBe(2);
    }
  });

  test("a changed locator set invalidates selectors and cursors instead of shifting offsets", () => {
    const h = harness();
    const { first } = buildFourRows(h);
    const view = h.view();
    const listed = view.list(h.context(), { limit: 2 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    const cursor = listed.view.nextCursor!;

    h.appendLocator(h.locatorData(first.item), "locator-late-duplicate");
    expect(view.inspect(h.context(), selector)).toEqual({ ok: false, code: "new_list_required" });
    expect(view.list(h.context(), { limit: 2, cursor })).toEqual({ ok: false, code: "new_list_required" });

    const relisted = view.list(h.context(), { limit: 16 });
    expect(relisted.ok).toBe(true);
    if (!relisted.ok) return;
    expect(relisted.view.items).toHaveLength(4);
    expect(relisted.view.coverage).toMatchObject({
      candidates: 5,
      returned: 4,
      duplicatesCollapsed: 1,
      withheld: 0,
    });
  });

  test("navigation, disposal, composition replacement, subagent and missing identity close the view", () => {
    const h = harness();
    const { first } = buildFourRows(h);
    const view = h.view();
    const listed = view.list(h.context(), { limit: 4 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    const cursor = listed.view.nextCursor ?? "hcur_" + "0".repeat(32);

    expect(view.list(h.context({ agentKind: "sub" }), { limit: 4 })).toEqual({
      ok: false,
      code: "main_only",
    });
    expect(view.list(h.context({ cwd: h.root }), { limit: 4 })).toEqual({
      ok: false,
      code: "workspace_mismatch",
    });
    expect(view.list(h.context({ omitSessionFile: true }), { limit: 4 })).toEqual({
      ok: false,
      code: "session_unavailable",
    });
    const aborted = { aborted: true } as AbortSignal;
    expect(view.list(h.context(), { limit: 4 }, aborted)).toEqual({ ok: false, code: "aborted" });

    view.navigate("session_tree");
    expect(view.inspect(h.context(), selector)).toEqual({ ok: false, code: "new_list_required" });
    expect(view.list(h.context(), { limit: 4, cursor })).toEqual({ ok: false, code: "new_list_required" });

    const rebuilt = view.list(h.context(), { limit: 4 });
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    h.composition = false;
    expect(view.inspect(h.context(), rebuilt.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "composition_changed",
    });
    expect(view.list(h.context(), { limit: 4 })).toEqual({ ok: false, code: "composition_changed" });

    h.composition = true;
    const ready = view.list(h.context(), { limit: 4 });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    view.dispose();
    expect(view.inspect(h.context(), ready.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "disposed",
    });
    expect(view.list(h.context(), { limit: 4 })).toEqual({ ok: false, code: "disposed" });
    expect(view.status()).toMatchObject({ disposed: true, view: "none", selectors: 0 });
    expect(first.item.taskId).toBe(ready.view.items[0]!.taskId);
  });

  test("an amendment absent from the branch is withheld even when the original is visible", () => {
    const h = harness();
    h.startTask("user-1", "Original requirement.");
    const revised = h.reviseTask("user-2-after", "Second requirement.");
    h.branch = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
      userEntry("user-2-after", "leaf-1", "Second requirement."),
      {
        id: "locator-only",
        parentId: "user-2-after",
        type: "custom",
        customType: HISTORY_LOCATOR_CUSTOM_TYPE,
        data: h.locatorData(revised.item),
      },
    ];
    h.leafId = "locator-only";
    expectWithheldPage(h, "source_mismatch", 1, 1);
  });

  test("a locator before its required source cannot become trusted from later duplicate text", () => {
    const h = harness();
    const first = h.startTask("user-1", "Original text.");
    h.branch = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
      {
        id: "locator-before",
        parentId: "leaf-1",
        type: "custom",
        customType: HISTORY_LOCATOR_CUSTOM_TYPE,
        data: h.locatorData(first.item),
      },
      userEntry("user-1", "locator-before", "Original text."),
      {
        id: "locator-after",
        parentId: "user-1",
        type: "custom",
        customType: HISTORY_LOCATOR_CUSTOM_TYPE,
        data: h.locatorData(first.item),
      },
    ];
    h.leafId = "locator-after";
    const view = h.view();
    const listed = view.list(h.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.view.items).toHaveLength(1);
    expect(listed.view.coverage).toMatchObject({
      candidates: 2,
      evaluated: 2,
      inspected: 1,
      returned: 1,
      withheld: 1,
      duplicatesCollapsed: 0,
    });
    expect(listed.view.coverage.withheldReasons.source_mismatch).toBe(1);
  });

  test("synthetic, re-identified and wrong-session sources are withheld without selectors", () => {
    for (const mode of ["synthetic", "different-id", "session"] as const) {
      const h = harness();
      const first = h.startTask("user-1", "Same visible text.");
      const data = h.locatorData(first.item, mode === "session"
        ? { originSessionId: "another-session" }
        : {});
      if (mode === "synthetic") {
        (h.branch.find((entry) => entry.id === "user-1")!.message as Record<string, unknown>).synthetic = true;
      } else if (mode === "different-id") {
        h.branch = [
          { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
          userEntry("user-other", "leaf-1", "Same visible text."),
          {
            id: "locator-1",
            parentId: "user-other",
            type: "custom",
            customType: HISTORY_LOCATOR_CUSTOM_TYPE,
            data,
          },
        ];
        h.leafId = "locator-1";
      } else {
        h.branch = h.branch.map((entry) =>
          entry.type === "custom" && entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE
            ? { ...entry, data }
            : entry);
      }
      const expected = mode === "session" ? "session_mismatch" : "source_mismatch";
      expectWithheldPage(h, expected, 1, mode === "session" ? 0 : 1);
    }
  });

  test("malformed, unsupported-version and conflicting duplicate locators stay opaque", () => {
    const h = harness();
    const first = h.startTask("user-1", "Original text.");
    const valid = h.locatorData(first.item);
    h.appendLocator({ ...valid, extra: "not-allowlisted" }, "locator-malformed");
    h.appendLocator({ ...valid, version: 2 }, "locator-unsupported");
    h.appendLocator({ ...valid, digest: "history-item-v1:sha256:" + "0".repeat(64) }, "locator-conflict");
    h.appendLocator(valid, "locator-same-conflict");
    const view = h.view();
    const listed = view.list(h.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.view.items).toEqual([]);
    expect(listed.view.coverage.inspected).toBe(0);
    expect(listed.view.coverage.withheldReasons).toMatchObject({
      locator_invalid: 1,
      locator_unsupported: 1,
      locator_conflict: 3,
    });
  });

  test("unsafe or missing instance roots and symlinked index files are withheld", () => {
    const missing = harness();
    const missingTask = missing.startTask("user-1", "Original text.");
    missing.branch = missing.branch.map((entry) =>
      entry.type === "custom" && entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE
        ? { ...entry, data: missing.locatorData(missingTask.item, { instanceId: "absent-instance" }) }
        : entry);
    expectWithheldPage(missing, "instance_unavailable");

    const symlinked = harness();
    const symTask = symlinked.startTask("user-1", "Original text.");
    symlinkSync(symlinked.instanceRoot, path.join(symlinked.instancesRoot, "evil-instance"), "dir");
    symlinked.branch = symlinked.branch.map((entry) =>
      entry.type === "custom" && entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE
        ? { ...entry, data: symlinked.locatorData(symTask.item, { instanceId: "evil-instance" }) }
        : entry);
    expectWithheldPage(symlinked, "instance_unsafe");

    const fileLink = harness();
    fileLink.startTask("user-1", "Original text.");
    const realIndex = path.join(fileLink.root, "real-index.json");
    const bytes = readFileSync(fileLink.indexPath);
    writeFileSync(realIndex, bytes, { mode: 0o600 });
    rmSync(fileLink.indexPath);
    symlinkSync(realIndex, fileLink.indexPath, "file");
    expectWithheldPage(fileLink, "instance_unsafe");

    const missingFile = harness();
    missingFile.startTask("user-1", "Original text.");
    rmSync(missingFile.indexPath);
    expectWithheldPage(missingFile, "history_missing");

    const changedBytes = harness();
    changedBytes.startTask("user-1", "Original text.");
    writeFileSync(changedBytes.indexPath, "not-json");
    expectWithheldPage(changedBytes, "history_unsupported", 1, 1);
  });

  test("a symlinked state root, branch overflow and candidate overflow are refused as whole queries", () => {
    const linked = harness();
    linked.startTask("user-1", "Original text.");
    const linkedState = path.join(linked.root, "state-link");
    symlinkSync(linked.stateRoot, linkedState, "dir");
    const linkedView = createHistoryView({
      stateRoot: linkedState,
      workspaceRoot: linked.workspace,
      isCurrentComposition: () => true,
    });
    expect(linkedView.list(linked.context(), { limit: 16 })).toEqual({ ok: false, code: "unavailable" });

    const longBranch = harness();
    longBranch.startTask("user-1", "Original text.");
    for (let index = 0; index < 4096; index += 1) {
      longBranch.appendEntry({
        id: `filler-${index}`,
        parentId: longBranch.leafId,
        type: "custom",
        customType: "fixture-filler",
        data: {},
      });
    }
    expect(longBranch.branch.length).toBeGreaterThan(4096);
    const longView = longBranch.view();
    expect(longView.list(longBranch.context(), { limit: 16 })).toEqual({ ok: false, code: "limit" });

    const many = harness();
    const task = many.startTask("user-1", "Original text.");
    const data = many.locatorData(task.item);
    for (let index = 0; index < 128; index += 1) {
      many.appendLocator(data, `locator-many-${index}`);
    }
    expect(many.branch.filter((entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE)).toHaveLength(129);
    const manyView = many.view();
    expect(manyView.list(many.context(), { limit: 16 })).toEqual({ ok: false, code: "limit" });
  });

  test("changed index metadata during final branch getters discards the page", () => {
    const h = harness();
    const { first } = buildFourRows(h);
    const view = h.view();
    const listed = view.list(h.context(), { limit: 1 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    const hooked = h.context({
      branchRead(count) {
        if (count === 2) appendFileSync(h.indexPath, " ");
      },
    });
    expect(view.inspect(hooked, selector)).toEqual({ ok: false, code: "scope_changed" });
    expect(first.item.taskId).toBe(listed.view.items[0]!.taskId);
  });

  test("changed source text or parent during final branch getters discards the page", () => {
    const source = harness();
    const task = source.startTask("user-1", "Original text.");
    const sourceView = source.view();
    const listed = sourceView.list(source.context(), { limit: 1 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const sourceHook = source.context({
      branchRead(count) {
        if (count === 2) {
          (source.branch.find((entry) => entry.id === "user-1")!.message as Record<string, unknown>)
            .content = [{ type: "text", text: "Rewritten later." }];
        }
      },
    });
    expect(sourceView.inspect(sourceHook, listed.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "scope_changed",
    });

    const parent = harness();
    parent.startTask("user-1", "Original text.");
    const parentView = parent.view();
    const parentList = parentView.list(parent.context(), { limit: 1 });
    expect(parentList.ok).toBe(true);
    if (!parentList.ok) return;
    const parentHook = parent.context({
      branchRead(count) {
        if (count === 2) parent.branch.find((entry) => entry.id === "user-1")!.parentId = "wrong-parent";
      },
    });
    expect(parentView.inspect(parentHook, parentList.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "scope_changed",
    });
    expect(task.item.taskId).toBe(parentList.view.items[0]!.taskId);
  });

  test("a synthetic abort getter is refused without executing it or exposing data", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    let calls = 0;
    const signal = {
      get aborted() {
        calls += 1;
        appendFileSync(h.indexPath, " ");
        return false;
      },
    } as unknown as AbortSignal;
    const view = h.view();
    // The native brand check rejects the object itself. This proves synthetic
    // signals cannot supply an abort fact through an arbitrary getter; it does
    // not prove a final-getter mutation guard (covered by actual signals).
    expect(view.list(h.context(), { limit: 16 }, signal)).toEqual({ ok: false, code: "aborted" });
    expect(calls).toBe(0);
  });

  test("an actual abort during the final branch getter refuses the page", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    const controller = new AbortController();
    const hooked = h.context({
      branchRead(count) {
        if (count === 2) controller.abort();
      },
    });
    expect(h.view().list(hooked, { limit: 16 }, controller.signal)).toEqual({
      ok: false,
      code: "aborted",
    });
    expect(controller.signal.aborted).toBe(true);
  });

  test("an earlier index mutated after a later distinct index read invalidates the selected page", () => {
    const h = harness();
    h.startTask("user-1", "First task.");
    h.cancelTask("user-2", "Cancel the first task.");
    const second = h.startTask("user-3", "Second task.");
    const secondInstanceId = "instance-g3b2-second";
    const secondRoot = path.join(h.instancesRoot, secondInstanceId);
    mkdirSync(secondRoot, { mode: 0o700 });
    const secondWriter = createHistoryProjectionWriter({
      instanceRoot: secondRoot,
      instanceId: secondInstanceId,
      ownerId: OWNER_ID,
      workspaceRoot: h.workspace,
    });
    const secondItem = secondWriter.capture(second.task).item;
    h.appendLocator(
      h.locatorData(secondItem, { instanceId: secondInstanceId }),
      "locator-second-instance",
    );
    expect(h.branch.filter((entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE))
      .toHaveLength(4);

    const originalInspect = HistoryProjectionReader.prototype.inspect;
    let reads = 0;
    let fired = false;
    const spy = spyOn(HistoryProjectionReader.prototype, "inspect").mockImplementation(
      function (this: HistoryProjectionReader, selector) {
        const result = originalInspect.call(this, selector);
        reads += 1;
        if (reads === 4) {
          fired = true;
          appendFileSync(h.indexPath, " ");
        }
        return result;
      },
    );
    try {
      const listed = h.view().list(h.context(), { limit: 16 });
      expect(listed).toEqual({ ok: false, code: "scope_changed" });
      expect(reads).toBe(4);
      expect(fired).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("a changed session file invalidates selectors and cursors without a navigation hook", () => {
    const h = harness();
    buildFourRows(h);
    const view = h.view();
    const listed = view.list(h.context(), { limit: 2 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    const cursor = listed.view.nextCursor!;

    h.sessionFile = path.join(h.root, "replacement-session.jsonl");
    writeFileSync(h.sessionFile, "");

    expect(view.inspect(h.context(), selector)).toEqual({ ok: false, code: "new_list_required" });
    expect(view.list(h.context(), { limit: 2, cursor })).toEqual({ ok: false, code: "new_list_required" });
    const relisted = view.list(h.context(), { limit: 16 });
    expect(relisted.ok).toBe(true);
    if (relisted.ok) expect(relisted.view.items).toHaveLength(4);
  });

  test("a getBranch getter that switches session identity or manager is rejected", () => {
    const identity = harness();
    identity.startTask("user-1", "Original text.");
    const identityView = identity.view();
    const switchedContext = identity.context({
      branchRead(count) {
        if (count === 1) {
          identity.sessionId = "switched-session";
          identity.sessionFile = path.join(identity.root, "switched-session.jsonl");
        }
      },
    });
    expect(identityView.list(switchedContext, { limit: 16 })).toEqual({
      ok: false,
      code: "scope_changed",
    });

    const managerSwap = harness();
    managerSwap.startTask("user-1", "Original text.");
    const swapView = managerSwap.view();
    const replacement = managerSwap.context().sessionManager!;
    let swapContext: OmpToolContext;
    swapContext = managerSwap.context({
      branchRead(count) {
        if (count === 1) swapContext.sessionManager = replacement;
      },
    });
    expect(swapView.list(swapContext, { limit: 16 })).toEqual({
      ok: false,
      code: "scope_changed",
    });

    const navigating = harness();
    navigating.startTask("user-1", "Original text.");
    const navigatingView = navigating.view();
    const navigationContext = navigating.context({
      branchRead(count) {
        if (count === 1) navigatingView.navigate("session_switch");
      },
    });
    expect(navigatingView.list(navigationContext, { limit: 16 })).toEqual({
      ok: false,
      code: "new_list_required",
    });
  });

  test("a composition callback that mutates an index on its final call is caught by the file gate", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    let calls = 0;
    const view = createHistoryView({
      stateRoot: h.stateRoot,
      workspaceRoot: h.workspace,
      isCurrentComposition: () => {
        calls += 1;
        if (calls === 2) appendFileSync(h.indexPath, " ");
        return true;
      },
    });
    expect(view.list(h.context(), { limit: 16 })).toEqual({ ok: false, code: "scope_changed" });
    expect(calls).toBe(2);
  });

  test("a final composition callback that rewrites source text withholds the listed body", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    let armed = false;
    let armedCalls = 0;
    const view = createHistoryView({
      stateRoot: h.stateRoot,
      workspaceRoot: h.workspace,
      isCurrentComposition: () => {
        if (armed) {
          armedCalls += 1;
          if (armedCalls === 2) {
            (h.branch.find((entry) => entry.id === "user-1")!.message as Record<string, unknown>)
              .content = [{ type: "text", text: "Rewritten later." }];
          }
        }
        return true;
      },
    });
    const listed = view.list(h.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    armed = true;
    expect(view.inspect(h.context(), selector)).toEqual({ ok: false, code: "scope_changed" });
    expect(armedCalls).toBe(2);
  });

  test("a final composition callback that switches the session file withholds the listed body", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    let armed = false;
    let armedCalls = 0;
    const view = createHistoryView({
      stateRoot: h.stateRoot,
      workspaceRoot: h.workspace,
      isCurrentComposition: () => {
        if (armed) {
          armedCalls += 1;
          if (armedCalls === 2) {
            h.sessionFile = path.join(h.root, "switched-session.jsonl");
            writeFileSync(h.sessionFile, "");
          }
        }
        return true;
      },
    });
    const listed = view.list(h.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const selector = listed.view.items[0]!.selector;
    armed = true;
    expect(view.inspect(h.context(), selector)).toEqual({ ok: false, code: "scope_changed" });
    expect(armedCalls).toBe(2);
  });

  test("branch structure failures and unknown selectors never expose rows", () => {
    const h = harness();
    h.startTask("user-1", "Original text.");
    h.branch = [
      { id: "leaf-1", parentId: null, type: "custom", customType: "fixture-base", data: {} },
      { id: "user-1", parentId: "not-leaf-1", type: "message", message: { role: "user", content: "x", attribution: "user" } },
    ];
    h.leafId = "user-1";
    expect(h.view().list(h.context(), { limit: 16 })).toEqual({ ok: false, code: "branch_invalid" });

    const fresh = harness();
    const task = fresh.startTask("user-1", "Original text.");
    const view = fresh.view();
    const listed = view.list(fresh.context(), { limit: 16 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(view.inspect(fresh.context(), "hsel_" + "a".repeat(32))).toEqual({
      ok: false,
      code: "unknown_selector",
    });
    expect(task.item.taskId).toBe(listed.view.items[0]!.taskId);
  });
});
