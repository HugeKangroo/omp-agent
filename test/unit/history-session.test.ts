import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHistoryProjectionReader,
  HistoryProjectionError,
  HistoryProjectionWriter,
  type HistoryProjectionReader,
} from "../../src/history-projection.ts";
import {
  createHistorySession,
  HISTORY_LOCATOR_CUSTOM_TYPE,
  HISTORY_SESSION_QUEUE_LIMIT,
  type HistorySessionControls,
  type HistorySessionReport,
} from "../../src/history-session.ts";
import type { OmpSessionManager, OmpToolContext } from "../../src/task-entry-port.ts";
import {
  TaskOwner,
  type ManagedTask,
  type TaskSubject,
} from "../../src/task-owner.ts";

const SESSION = "g3b1-history-session";
const OWNER_ID = "owner-g3b1-history";
const INSTANCE_ID = "instance-2026-11-09";
const NOW = "2026-11-09T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

interface HostState {
  branch: Entry[];
  leafId: string | null;
  sessionId: string;
  sessionFile: string | undefined;
  ensureCalls: number;
  appendCalls: Array<{ customType: string; data: unknown }>;
  ensureOnDisk: () => Promise<void>;
  appendEntry: ((customType: string, data?: unknown) => void) | undefined;
  afterAppend: (() => void) | undefined;
  entrySequence: number;
}

interface Fixture {
  root: string;
  workspace: string;
  owner: TaskOwner;
  history: HistorySessionControls;
  state: HostState;
  context(overrides?: {
    sessionId?: string;
    cwd?: string;
    agentKind?: "main" | "sub";
    omitSessionFile?: boolean;
    omitEnsureOnDisk?: boolean;
    omitAppendEntry?: boolean;
  }): OmpToolContext;
  reader(): HistoryProjectionReader;
  dispose(): void;
}

interface SetupOptions {
  append?: "native" | "noop" | "throw" | "none" | "duplicate-id" | "rewrite-prefix" | "session-switch";
  beforeHistory?: (owner: TaskOwner, state: HostState) => void;
  ensureOnDisk?: () => Promise<void>;
  sessionFile?: string | undefined;
  ensureOnDiskTimeoutMs?: number;
  preexistingIndex?: boolean;
  report?: HistorySessionReport;
}

const fixtures: Fixture[] = [];

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "g3b1-base", data: {} };
}

function user(id: string, parentId: string, text: string): Entry {
  return {
    id,
    parentId,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      attribution: "user",
    },
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

function messageOf(entry: Entry): Record<string, unknown> {
  return { ...(entry.message as Record<string, unknown>), id: entry.id };
}

function setup(options: SetupOptions = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "omp-agent-g3b1-history-"));
  const workspacePath = path.join(root, "workspace");
  mkdirSync(workspacePath, { mode: 0o700 });
  const workspace = realpathSync(workspacePath);
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: workspace,
    ownerId: OWNER_ID,
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const state: HostState = {
    branch: [base()],
    leafId: "leaf-1",
    sessionId: SESSION,
    sessionFile: options.sessionFile === undefined
      ? path.join(root, "session.jsonl")
      : options.sessionFile,
    ensureCalls: 0,
    appendCalls: [],
    ensureOnDisk: options.ensureOnDisk ?? (async () => { state.ensureCalls += 1; }),
    appendEntry: undefined,
    afterAppend: undefined,
    entrySequence: 0,
  };
  const appendNative = (customType: string, data?: unknown): void => {
    state.entrySequence += 1;
    const id = `locator-${state.entrySequence}`;
    state.branch.push({
      id,
      parentId: state.leafId,
      type: "custom",
      customType,
      data,
    });
    state.leafId = id;
  };
  if (options.append === "native" || options.append === "session-switch") {
    state.appendEntry = (customType, data) => {
      state.appendCalls.push({ customType, data });
      appendNative(customType, data);
      if (options.append === "session-switch") state.sessionId = "switched-session";
      state.afterAppend?.();
    };
  } else if (options.append === "duplicate-id") {
    state.appendEntry = (customType, data) => {
      state.appendCalls.push({ customType, data });
      state.branch.push({
        id: "user-1",
        parentId: state.leafId,
        type: "custom",
        customType,
        data,
      });
      state.leafId = "user-1";
      state.afterAppend?.();
    };
  } else if (options.append === "rewrite-prefix") {
    state.appendEntry = (customType, data) => {
      state.appendCalls.push({ customType, data });
      const firstUser = state.branch.find((entry) => entry.id === "user-1");
      if (firstUser !== undefined) {
        (firstUser.message as Record<string, unknown>).content = [{ type: "text", text: "Rewritten prefix." }];
      }
      appendNative(customType, data);
      state.afterAppend?.();
    };
  } else if (options.append === "noop") {
    state.appendEntry = (customType, data) => {
      state.appendCalls.push({ customType, data });
    };
  } else if (options.append === "throw") {
    state.appendEntry = (customType, data) => {
      state.appendCalls.push({ customType, data });
      throw new Error("fixture append failure");
    };
  }
  if (options.preexistingIndex === true) {
    writeFileSync(path.join(root, "history-index.json"), "{\"foreign\":true}\n", { mode: 0o600 });
  }
  options.beforeHistory?.(owner, state);
  const history = createHistorySession({
    owner,
    instanceRoot: root,
    instanceId: INSTANCE_ID,
    workspaceRoot: workspace,
    ...(state.appendEntry === undefined ? {} : { appendEntry: state.appendEntry }),
    ...(options.ensureOnDiskTimeoutMs === undefined
      ? {}
      : { ensureOnDiskTimeoutMs: options.ensureOnDiskTimeoutMs }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
  const fixture: Fixture = {
    root,
    workspace,
    owner,
    history,
    state,
    context(overrides = {}) {
      const manager: OmpSessionManager = {
        getSessionId: () => overrides.sessionId ?? state.sessionId,
        getLeafId: () => state.leafId,
        getBranch: () => state.branch.slice(),
        ...(overrides.omitSessionFile === true ? {} : {
          getSessionFile: () => state.sessionFile,
        }),
        ...(overrides.omitEnsureOnDisk === true ? {} : {
          ensureOnDisk: () => state.ensureOnDisk(),
        }),
      };
      return {
        cwd: overrides.cwd ?? workspace,
        agent: { kind: overrides.agentKind ?? "main" },
        sessionManager: manager,
      };
    },
    reader() {
      return createHistoryProjectionReader({
        instanceRoot: root,
        instanceId: INSTANCE_ID,
        ownerId: owner.ownerId,
        workspaceRoot: workspace,
      });
    },
    dispose() {
      history.dispose();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      fixture.dispose();
    } catch {
      // Disposal idempotence is asserted where relevant.
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function subject(fixture: Fixture): TaskSubject {
  return {
    sessionId: fixture.state.sessionId,
    workspaceRoot: fixture.workspace,
    agentKind: "main",
    branch: fixture.state.branch.slice(),
  };
}

function appendUser(fixture: Fixture, id: string, text: string): Entry {
  const parentId = fixture.state.leafId!;
  const entry = user(id, parentId, text);
  fixture.state.branch.push(entry);
  fixture.state.leafId = id;
  return entry;
}

function appendAssistant(fixture: Fixture, id: string): Entry {
  const parentId = fixture.state.leafId!;
  const entry = assistant(id, parentId);
  fixture.state.branch.push(entry);
  fixture.state.leafId = id;
  return entry;
}

function startTask(fixture: Fixture, id: string, text: string): ManagedTask {
  const entry = appendUser(fixture, id, text);
  expect(fixture.owner.observeInput({
    sessionId: fixture.state.sessionId,
    workspaceRoot: fixture.workspace,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: entry.parentId!,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({
    sessionId: fixture.state.sessionId,
    prompt: text,
    reason: "prompt",
  });
  const result = fixture.owner.start(subject(fixture));
  expect(fixture.owner.closeTurn({
    sessionId: fixture.state.sessionId,
    branch: fixture.state.branch.slice(),
    messages: [messageOf(entry)],
  })).toBe(true);
  return result.task;
}

function reviseTask(fixture: Fixture, id: string, text: string): ManagedTask {
  appendAssistant(fixture, `assistant-${id}`);
  const entry = appendUser(fixture, id, text);
  expect(fixture.owner.observeInput({
    sessionId: fixture.state.sessionId,
    workspaceRoot: fixture.workspace,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: entry.parentId!,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({
    sessionId: fixture.state.sessionId,
    prompt: text,
    reason: "prompt",
  });
  const current = fixture.owner.snapshot().currentTask!;
  const result = fixture.owner.revise(subject(fixture), {
    taskId: current.taskId,
    taskRevision: current.taskRevision,
  });
  expect(fixture.owner.closeTurn({
    sessionId: fixture.state.sessionId,
    branch: fixture.state.branch.slice(),
    messages: [messageOf(entry)],
  })).toBe(true);
  return result.task;
}

function cancelTask(fixture: Fixture, id: string, text: string): ManagedTask {
  appendAssistant(fixture, `assistant-${id}`);
  const entry = appendUser(fixture, id, text);
  expect(fixture.owner.observeInput({
    sessionId: fixture.state.sessionId,
    workspaceRoot: fixture.workspace,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: entry.parentId!,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({
    sessionId: fixture.state.sessionId,
    prompt: text,
    reason: "prompt",
  });
  const current = fixture.owner.snapshot().currentTask!;
  const task = fixture.owner.cancel(subject(fixture), {
    taskId: current.taskId,
    taskRevision: current.taskRevision,
  });
  expect(fixture.owner.closeTurn({
    sessionId: fixture.state.sessionId,
    branch: fixture.state.branch.slice(),
    messages: [messageOf(entry)],
  })).toBe(true);
  return task;
}

function locatorEntry(fixture: Fixture): Entry {
  const entry = fixture.state.branch.at(-1)!;
  expect(entry.type).toBe("custom");
  expect(entry.customType).toBe(HISTORY_LOCATOR_CUSTOM_TYPE);
  return entry;
}

describe("B1 history capture and native locators", () => {
  test("captures start, revise, cancel and a second task immediately, then publishes exact locators once", async () => {
    const fixture = setup({ append: "native" });
    const first = startTask(fixture, "user-1", "Original request — 一\nsecond line");
    expect(fixture.history.status()).toMatchObject({
      capture: "ready",
      locator: "ready",
      captured: 1,
      pending: 1,
      visible: 0,
      incomplete: 0,
      unknown: 0,
    });
    expect(fixture.reader().list({ limit: 16 }).total).toBe(1);

    const beforePublish = fixture.owner.snapshot();
    const beforeLeaf = fixture.state.leafId!;
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.owner.snapshot()).toEqual(beforePublish);
    expect(fixture.history.status()).toMatchObject({
      captured: 1,
      pending: 0,
      visible: 1,
      incomplete: 0,
      unknown: 0,
    });
    let locator = locatorEntry(fixture);
    expect(locator.parentId).toBe(beforeLeaf);
    expect(fixture.state.leafId).toBe(locator.id);
    let page = fixture.reader().list({ limit: 16 });
    let item = page.items[0]!;
    expect(locator.data).toEqual({
      version: 1,
      instanceId: INSTANCE_ID,
      ownerId: OWNER_ID,
      historyId: item.historyId,
      digest: item.digest,
      taskId: first.taskId,
      taskRevision: 1,
      originSessionId: SESSION,
    });
    expect(Object.keys(locator.data as Record<string, unknown>).sort()).toEqual([
      "digest",
      "historyId",
      "instanceId",
      "originSessionId",
      "ownerId",
      "taskId",
      "taskRevision",
      "version",
    ]);

    const revised = reviseTask(fixture, "user-2", "Amendment — 二");
    expect(fixture.history.status()).toMatchObject({ captured: 2, pending: 1, visible: 1 });
    expect(fixture.reader().list({ limit: 16 }).total).toBe(2);
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 2 });
    locator = locatorEntry(fixture);
    page = fixture.reader().list({ limit: 16 });
    item = page.items[1]!;
    expect(locator.data).toMatchObject({
      historyId: item.historyId,
      taskId: revised.taskId,
      taskRevision: 2,
      originSessionId: SESSION,
    });

    const cancelled = cancelTask(fixture, "user-3", "Cancel it.");
    expect(fixture.history.status()).toMatchObject({ captured: 3, pending: 1, visible: 2 });
    expect(fixture.reader().list({ limit: 16 }).total).toBe(3);
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 3 });
    page = fixture.reader().list({ limit: 16 });
    expect(page.items[2]).toMatchObject({
      taskId: cancelled.taskId,
      taskRevision: 2,
      recordedStatus: "cancelled",
    });

    const second = startTask(fixture, "user-4", "A different task.");
    expect(fixture.history.status()).toMatchObject({ captured: 4, pending: 1, visible: 3 });
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 4, incomplete: 0, unknown: 0 });
    page = fixture.reader().list({ limit: 16 });
    expect(page.total).toBe(4);
    expect(page.items.map((row) => [row.taskId, row.taskRevision, row.recordedStatus])).toEqual([
      [first.taskId, 1, "active"],
      [revised.taskId, 2, "active"],
      [cancelled.taskId, 2, "cancelled"],
      [second.taskId, 1, "active"],
    ]);
    expect(fixture.owner.snapshot().currentTask!.taskId).toBe(second.taskId);
    expect(fixture.state.branch.filter((entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE))
      .toHaveLength(4);
    expect(fixture.state.appendCalls).toHaveLength(4);
  });

  test("no committed task means no capture and an ordinary agent_end touches no persistence or append", async () => {
    const fixture = setup({ append: "native" });
    const entry = appendUser(fixture, "user-1", "Observed but not committed.");
    expect(fixture.owner.observeInput({
      sessionId: fixture.state.sessionId,
      workspaceRoot: fixture.workspace,
      source: "rpc",
      text: "Observed but not committed.",
      observedAt: NOW,
      baseLeafId: entry.parentId!,
    }).accepted).toBe(true);
    fixture.owner.observeAgentStart({
      sessionId: fixture.state.sessionId,
      prompt: "Observed but not committed.",
      reason: "prompt",
    });
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({
      captured: 0,
      pending: 0,
      visible: 0,
      incomplete: 0,
      unknown: 0,
    });
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.appendCalls).toHaveLength(0);
  });

  test("a reentrant cancel makes the stale revision event incomplete instead of capturing the wrong snapshot", async () => {
    let fixture: Fixture;
    fixture = setup({
      append: "native",
      beforeHistory(owner, state) {
        owner.subscribe((event) => {
          if (event.type !== "task_revised") return;
          const current = owner.snapshot().currentTask;
          if (current === null) return;
          owner.cancel({
            sessionId: state.sessionId,
            workspaceRoot: fixture.workspace,
            agentKind: "main",
            branch: state.branch.slice(),
          }, {
            taskId: current.taskId,
            taskRevision: current.taskRevision,
          });
        });
      },
    });
    startTask(fixture, "user-1", "Original request.");
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status().visible).toBe(1);

    reviseTask(fixture, "user-2", "Amendment that is reentrantly cancelled.");
    expect(fixture.history.status()).toMatchObject({
      captured: 2,
      pending: 1,
      visible: 1,
      incomplete: 1,
    });
    expect(fixture.history.status().lastReason?.code).toBe("event_snapshot_mismatch");
    const page = fixture.reader().list({ limit: 16 });
    expect(page.total).toBe(2);
    expect(page.items[1]).toMatchObject({ recordedStatus: "cancelled", taskRevision: 2 });
  });

  test("false or missing genuine sources never append a locator", async () => {
    const falseText = setup({ append: "native" });
    startTask(falseText, "user-1", "Original text.");
    const firstUser = falseText.state.branch.find((entry) => entry.id === "user-1")!;
    (firstUser.message as Record<string, unknown>).content = [{ type: "text", text: "Changed text." }];
    await falseText.history.handleAgentEnd({}, falseText.context());
    expect(falseText.history.status()).toMatchObject({
      captured: 1,
      pending: 0,
      visible: 0,
      incomplete: 1,
      unknown: 0,
    });
    expect(falseText.history.status().lastReason?.code).toBe("source_mismatch");
    expect(falseText.state.appendCalls).toHaveLength(0);

    const missingAmendment = setup({ append: "native" });
    startTask(missingAmendment, "user-1", "Original request.");
    reviseTask(missingAmendment, "user-2", "Amendment disappears.");
    missingAmendment.state.branch = missingAmendment.state.branch.filter((entry) => entry.id !== "user-2");
    missingAmendment.state.leafId = "assistant-user-2";
    await missingAmendment.history.handleAgentEnd({}, missingAmendment.context());
    expect(missingAmendment.history.status()).toMatchObject({
      captured: 2,
      pending: 0,
      visible: 1,
      incomplete: 1,
    });
    expect(missingAmendment.state.appendCalls).toHaveLength(1);
    expect(missingAmendment.reader().list({ limit: 16 }).total).toBe(2);
  });

  test("wrong session, workspace or agent kind does not attach a locator; subagent and cwd leave it pending", async () => {
    const fixture = setup({ append: "native" });
    startTask(fixture, "user-1", "Original request.");

    await fixture.history.handleAgentEnd({}, fixture.context({ agentKind: "sub" }));
    await fixture.history.handleAgentEnd({}, fixture.context({ cwd: path.join(fixture.root, "elsewhere") }));
    expect(fixture.history.status()).toMatchObject({ pending: 1, visible: 0, incomplete: 0 });
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.appendCalls).toHaveLength(0);

    await fixture.history.handleAgentEnd({}, fixture.context({ sessionId: "other-session" }));
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 0, incomplete: 1 });
    expect(fixture.history.status().lastReason?.code).toBe("identity_changed");
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.appendCalls).toHaveLength(0);
  });

  test("missing host session APIs are unavailable but preserve ready capture and pending state", async () => {
    const fixture = setup({ append: "native" });
    startTask(fixture, "user-1", "Original request.");
    await fixture.history.handleAgentEnd({}, fixture.context({ omitSessionFile: true }));
    expect(fixture.history.status()).toMatchObject({
      capture: "ready",
      locator: "unavailable",
      captured: 1,
      pending: 1,
      visible: 0,
    });
    expect(fixture.history.status().lastReason?.code).toBe("unavailable");
    expect(fixture.state.ensureCalls).toBe(0);
    expect(fixture.state.appendCalls).toHaveLength(0);

    await fixture.history.handleAgentEnd({}, fixture.context({ omitEnsureOnDisk: true }));
    expect(fixture.history.status()).toMatchObject({ pending: 1, visible: 0, locator: "unavailable" });

    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 1, locator: "ready" });

    const withoutAppend = setup({ append: "none" });
    startTask(withoutAppend, "user-1", "Original request without append.");
    expect(withoutAppend.history.status()).toMatchObject({
      locator: "unavailable",
      captured: 1,
      pending: 1,
    });
    await withoutAppend.history.handleAgentEnd({}, withoutAppend.context());
    expect(withoutAppend.history.status()).toMatchObject({ pending: 1, visible: 0 });
    expect(withoutAppend.state.ensureCalls).toBe(0);
    expect(withoutAppend.state.appendCalls).toHaveLength(0);
  });

  test("navigation and identity changes while ensureOnDisk is pending invalidate the attempt", async () => {
    let resolveEnsure: (() => void) | undefined;
    const navigation = setup({
      append: "native",
      ensureOnDisk: () => new Promise<void>((resolve) => {
        resolveEnsure = resolve;
      }),
    });
    startTask(navigation, "user-1", "Original request.");
    const navigated = navigation.history.handleAgentEnd({}, navigation.context());
    expect(navigation.state.ensureCalls).toBe(0);
    navigation.history.navigate("session_switch");
    resolveEnsure!();
    await navigated;
    expect(navigation.history.status()).toMatchObject({ pending: 0, visible: 0, incomplete: 1 });
    expect(navigation.state.appendCalls).toHaveLength(0);

    let resolveIdentity: (() => void) | undefined;
    const identity = setup({
      append: "native",
      ensureOnDisk: () => new Promise<void>((resolve) => {
        resolveIdentity = resolve;
      }),
    });
    startTask(identity, "user-1", "Original request.");
    const changed = identity.history.handleAgentEnd({}, identity.context());
    identity.state.sessionFile = path.join(identity.root, "other-session.jsonl");
    resolveIdentity!();
    await changed;
    expect(identity.history.status()).toMatchObject({ pending: 0, visible: 0, incomplete: 1 });
    expect(identity.history.status().lastReason?.code).toBe("identity_changed");
    expect(identity.state.appendCalls).toHaveLength(0);
  });

  test("dispose invalidates pending publication and a late resolution cannot append", async () => {
    let resolveEnsure: (() => void) | undefined;
    const fixture = setup({
      append: "native",
      ensureOnDisk: () => new Promise<void>((resolve) => {
        resolveEnsure = resolve;
      }),
    });
    startTask(fixture, "user-1", "Original request.");
    const attempt = fixture.history.handleAgentEnd({}, fixture.context());
    fixture.history.dispose();
    fixture.history.dispose();
    resolveEnsure!();
    await attempt;
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 0, incomplete: 1 });
    expect(fixture.state.appendCalls).toHaveLength(0);
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.state.appendCalls).toHaveLength(0);
  });

  test("a timeout invalidates only its frozen batch and a late resolution never appends", async () => {
    let resolveLate: (() => void) | undefined;
    const fixture = setup({
      append: "native",
      ensureOnDiskTimeoutMs: 20,
      ensureOnDisk: () => new Promise<void>((resolve) => {
        resolveLate = resolve;
      }),
    });
    startTask(fixture, "user-1", "Original request.");
    const started = Date.now();
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fixture.history.status()).toMatchObject({
      pending: 0,
      visible: 0,
      incomplete: 1,
      unknown: 0,
    });
    expect(fixture.history.status().lastReason?.code).toBe("timeout");
    expect(fixture.state.appendCalls).toHaveLength(0);

    resolveLate!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.state.appendCalls).toHaveLength(0);
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 0 });
    fixture.state.ensureOnDisk = async () => { fixture.state.ensureCalls += 1; };
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.state.appendCalls).toHaveLength(0);
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 0 });
  });

  test("a timed-out frozen batch does not remove a concurrent new capture", async () => {
    let resolveEnsure: (() => void) | undefined;
    const fixture = setup({
      append: "native",
      ensureOnDiskTimeoutMs: 20,
      ensureOnDisk: () => new Promise<void>((resolve) => {
        resolveEnsure = resolve;
      }),
    });
    startTask(fixture, "user-1", "Original request.");
    const attempt = fixture.history.handleAgentEnd({}, fixture.context());
    const revised = reviseTask(fixture, "user-2", "Concurrent amendment.");
    expect(fixture.history.status()).toMatchObject({ captured: 2, pending: 2 });

    await attempt;
    resolveEnsure!();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.history.status()).toMatchObject({
      captured: 2,
      pending: 1,
      visible: 0,
      incomplete: 1,
    });
    expect(fixture.history.status().lastReason?.code).toBe("timeout");

    fixture.state.ensureOnDisk = async () => { fixture.state.ensureCalls += 1; };
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ pending: 0, visible: 1 });
    expect(fixture.state.appendCalls).toHaveLength(1);
    expect(fixture.state.appendCalls[0]!.data).toMatchObject({
      taskId: revised.taskId,
      taskRevision: 2,
    });
  });

  test("a pre-append branch rewrite prevents publication", async () => {
    let fixture: Fixture;
    fixture = setup({
      append: "native",
      ensureOnDisk: async () => {
        fixture.state.ensureCalls += 1;
        const entry = fixture.state.branch.find((candidate) => candidate.id === "user-1")!;
        (entry.message as Record<string, unknown>).content = [{ type: "text", text: "Rewritten after the wait." }];
      },
    });
    startTask(fixture, "user-1", "Original request.");
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({
      captured: 1,
      pending: 0,
      visible: 0,
      incomplete: 1,
    });
    expect(fixture.history.status().lastReason?.code).toBe("source_mismatch");
    expect(fixture.state.appendCalls).toHaveLength(0);
  });

  test("duplicate appended ids, rewritten prefixes and session switches stay unknown", async () => {
    const duplicate = setup({ append: "duplicate-id" });
    startTask(duplicate, "user-1", "Original request.");
    await duplicate.history.handleAgentEnd({}, duplicate.context());
    expect(duplicate.history.status()).toMatchObject({ visible: 0, unknown: 1 });
    expect(duplicate.history.status().lastReason?.code).toBe("append_ambiguous");
    expect(duplicate.state.appendCalls).toHaveLength(1);

    const rewritten = setup({ append: "rewrite-prefix" });
    startTask(rewritten, "user-1", "Original request.");
    await rewritten.history.handleAgentEnd({}, rewritten.context());
    expect(rewritten.history.status()).toMatchObject({ visible: 0, unknown: 1 });
    expect(rewritten.history.status().lastReason?.detail).toContain("complete ledger");
    expect(rewritten.state.appendCalls).toHaveLength(1);

    const switched = setup({ append: "session-switch" });
    startTask(switched, "user-1", "Original request.");
    await switched.history.handleAgentEnd({}, switched.context());
    expect(switched.history.status()).toMatchObject({ visible: 0, unknown: 1 });
    expect(switched.history.status().lastReason?.detail).toContain("session");
    expect(switched.state.appendCalls).toHaveLength(1);
  });

  test("a synchronous navigation or disposal during append stays unknown rather than visible", async () => {
    const fixture = setup({ append: "native" });
    fixture.state.afterAppend = () => fixture.history.navigate("session_branch");
    startTask(fixture, "user-1", "Original request.");
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({
      visible: 0,
      unknown: 1,
      pending: 0,
    });
    expect(fixture.history.status().lastReason?.code).toBe("append_ambiguous");
    expect(fixture.state.appendCalls).toHaveLength(1);

    const disposed = setup({ append: "native" });
    disposed.state.afterAppend = () => disposed.history.dispose();
    startTask(disposed, "user-1", "Original request.");
    await disposed.history.handleAgentEnd({}, disposed.context());
    expect(disposed.history.status()).toMatchObject({
      visible: 0,
      unknown: 1,
      pending: 0,
    });
    expect(disposed.history.status().lastReason?.code).toBe("append_ambiguous");
    expect(disposed.state.appendCalls).toHaveLength(1);
  });

  test("a thrown or non-visible append is unknown and is never retried", async () => {
    const thrown = setup({ append: "throw" });
    startTask(thrown, "user-1", "Original request.");
    await thrown.history.handleAgentEnd({}, thrown.context());
    expect(thrown.history.status()).toMatchObject({
      captured: 1,
      pending: 0,
      visible: 0,
      unknown: 1,
    });
    expect(thrown.history.status().lastReason?.code).toBe("append_ambiguous");
    expect(thrown.state.appendCalls).toHaveLength(1);
    await thrown.history.handleAgentEnd({}, thrown.context());
    expect(thrown.state.appendCalls).toHaveLength(1);

    const invisible = setup({ append: "noop" });
    startTask(invisible, "user-1", "Original request.");
    await invisible.history.handleAgentEnd({}, invisible.context());
    expect(invisible.history.status()).toMatchObject({
      captured: 1,
      pending: 0,
      visible: 0,
      unknown: 1,
    });
    expect(invisible.state.appendCalls).toHaveLength(1);
    await invisible.history.handleAgentEnd({}, invisible.context());
    expect(invisible.state.appendCalls).toHaveLength(1);
  });

  test("repeated agent_end is idempotent and a failed projection is not reported as uncommitted", async () => {
    const fixture = setup({ append: "native" });
    const task = startTask(fixture, "user-1", "Original request.");
    await fixture.history.handleAgentEnd({}, fixture.context());
    await fixture.history.handleAgentEnd({}, fixture.context());
    expect(fixture.history.status()).toMatchObject({ visible: 1, pending: 0 });
    expect(fixture.state.appendCalls).toHaveLength(1);
    expect(fixture.owner.snapshot().currentTask).toMatchObject({
      taskId: task.taskId,
      taskRevision: 1,
      status: "active",
    });

    const failed = setup({ append: "native", preexistingIndex: true });
    const committed = startTask(failed, "user-1", "Original request.");
    expect(failed.history.status()).toMatchObject({
      captured: 0,
      pending: 0,
      visible: 0,
      incomplete: 1,
    });
    expect(failed.history.status().lastReason?.code).toBe("capture_failed");
    expect(failed.owner.snapshot().currentTask).toMatchObject({
      taskId: committed.taskId,
      taskRevision: 1,
      status: "active",
    });
    await failed.history.handleAgentEnd({}, failed.context());
    expect(failed.state.ensureCalls).toBe(0);
    expect(failed.state.appendCalls).toHaveLength(0);
  });

  test("failure-injection mapping: an unknown projection is possibly applied while write-failed stays incomplete", async () => {
    // Mapping/failure-injection only: this stubs the public writer method to
    // classify its error codes. It is not disk-publication evidence.
    const spy = spyOn(HistoryProjectionWriter.prototype, "capture");
    try {
      spy.mockImplementation(() => {
        throw new HistoryProjectionError("fixture prepublication write failure", "write-failed");
      });
      const failed = setup({ append: "native" });
      const failedTask = startTask(failed, "user-1", "Original request.");
      expect(failed.history.status()).toMatchObject({
        capture: "ready",
        captured: 0,
        pending: 0,
        visible: 0,
        incomplete: 1,
        unknown: 0,
      });
      expect(failed.history.status().lastReason?.code).toBe("capture_failed");
      expect(failed.history.status().reasonCounts.capture_failed).toBe(1);
      expect(failed.owner.snapshot().currentTask).toMatchObject({
        taskId: failedTask.taskId,
        taskRevision: 1,
        status: "active",
      });
      expect(existsSync(path.join(failed.root, "history-index.json"))).toBe(false);

      const reports: Array<{ type: string; details: Record<string, unknown> }> = [];
      spy.mockImplementation(() => {
        throw new HistoryProjectionError("fixture postpublication read-back failure", "unknown");
      });
      const uncertain = setup({
        append: "native",
        report: (type, details) => {
          reports.push({ type, details: { ...details } });
        },
      });
      const committed = startTask(uncertain, "user-1", "Original request.");
      expect(uncertain.history.status()).toMatchObject({
        capture: "unavailable",
        captured: 0,
        pending: 0,
        visible: 0,
        incomplete: 0,
        unknown: 1,
      });
      expect(uncertain.history.status().lastReason?.code).toBe("capture_unknown");
      expect(uncertain.history.status().lastReason?.detail).toContain("may have been applied");
      expect(uncertain.history.status().reasonCounts.capture_unknown).toBe(1);
      expect(uncertain.owner.snapshot().currentTask).toMatchObject({
        taskId: committed.taskId,
        taskRevision: 1,
        status: "active",
      });
      expect(existsSync(path.join(uncertain.root, "history-index.json"))).toBe(false);
      expect(uncertain.state.appendCalls).toHaveLength(0);

      const unknownReports = reports.filter((report) => report.type === "unknown");
      expect(unknownReports).toHaveLength(1);
      expect(unknownReports[0]!.details).toMatchObject({
        code: "capture_unknown",
        unknown: 1,
        possiblyApplied: true,
        capture: "unavailable",
      });
      expect(unknownReports[0]!.details).not.toHaveProperty("historyId");
      expect(reports.some((report) => report.type === "captured")).toBe(false);

      await uncertain.history.handleAgentEnd({}, uncertain.context());
      expect(uncertain.state.appendCalls).toHaveLength(0);
      // A later real owner event is not captured: the uncertain writer stays
      // disabled instead of silently continuing.
      cancelTask(uncertain, "user-2", "Cancel request.");
      expect(uncertain.history.status()).toMatchObject({
        capture: "unavailable",
        captured: 0,
        incomplete: 0,
        unknown: 1,
      });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("the pending queue is bounded without eviction and disposal reports every pending item", async () => {
    const fixture = setup({ append: "native" });
    for (let index = 1; index <= 64; index += 1) {
      startTask(fixture, `user-start-${index}`, `Task ${index}.`);
      cancelTask(fixture, `user-cancel-${index}`, `Cancel ${index}.`);
    }
    expect(fixture.history.status()).toMatchObject({
      captured: HISTORY_SESSION_QUEUE_LIMIT,
      pending: HISTORY_SESSION_QUEUE_LIMIT,
      visible: 0,
      incomplete: 0,
    });
    expect(fixture.history.status().pendingBytes).toBeGreaterThan(0);
    expect(fixture.reader().list({ limit: 16 }).total).toBe(HISTORY_SESSION_QUEUE_LIMIT);

    startTask(fixture, "user-overflow", "One task beyond the projection bound.");
    expect(fixture.history.status()).toMatchObject({
      captured: HISTORY_SESSION_QUEUE_LIMIT,
      pending: HISTORY_SESSION_QUEUE_LIMIT,
      incomplete: 1,
    });
    expect(fixture.history.status().lastReason?.code).toBe("capture_failed");
    expect(fixture.owner.snapshot().currentTask).not.toBeNull();

    fixture.history.dispose();
    expect(fixture.history.status()).toMatchObject({
      pending: 0,
      incomplete: HISTORY_SESSION_QUEUE_LIMIT + 1,
    });
  });
});
