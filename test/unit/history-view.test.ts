import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
import {
  HISTORY_LOCATOR_CUSTOM_TYPE,
  HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
} from "../../src/history-session.ts";
import {
  createHistoryView,
  HISTORY_CURSOR_PATTERN,
  HISTORY_RUN_CURSOR_PATTERN,
  HISTORY_RUN_EVIDENCE_PRECHARGE_BYTES,
  HISTORY_RUN_SELECTOR_PATTERN,
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
const RUN_SOURCE = Buffer.from("print('view run evidence')\n", "utf8");
const RUN_INPUT = Buffer.from("view input — α\n", "utf8");
const RUN_ARTIFACT = Buffer.from("view artifact — 42\n", "utf8");
const RUN_ARTIFACT_EXTRA = Buffer.from("unselected record artifact\n", "utf8");

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

interface ContextOptions {
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  agentKind?: "main" | "sub";
  omitSessionFile?: boolean;
  branchRead?: (count: number) => void;
  leafRead?: (count: number) => void;
  manager?: OmpSessionManager;
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
  let stableManager: OmpSessionManager | undefined;
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
      const isDefault = options.sessionId === undefined
        && options.sessionFile === undefined
        && options.cwd === undefined
        && options.agentKind === undefined
        && options.omitSessionFile === undefined
        && options.branchRead === undefined
        && options.leafRead === undefined
        && options.manager === undefined;
      if (isDefault && stableManager !== undefined) {
        return {
          cwd: workspace,
          agent: { kind: "main" },
          sessionManager: stableManager,
        };
      }
      let branchReads = 0;
      let leafReads = 0;
      const manager: OmpSessionManager = options.manager ?? {
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
      if (isDefault) stableManager = manager;
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

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface RunFixtureOptions {
  locatorId?: string;
  runId?: string;
  callId?: string;
  runDirectory?: string;
  selectedArtifactIds?: string[];
  recordedArtifactIds?: string[];
  includeInput?: boolean;
  withProcess?: boolean;
  phase?: string;
  artifactBytes?: Record<string, Buffer>;
}

interface RunFixture {
  runId: string;
  callId: string;
  runDirectory: string;
  runRoot: string;
  recordPath: string;
  selectedArtifactIds: string[];
  recordedArtifactIds: string[];
  artifactPaths: Map<string, string>;
  data: Record<string, unknown>;
  entry: Entry;
}

function artifactBytesFor(artifactId: string): Buffer {
  return artifactId === "artifact-2" ? RUN_ARTIFACT_EXTRA : RUN_ARTIFACT;
}

function runLocatorData(
  h: Harness,
  item: HistoryItem,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    instanceId: INSTANCE_ID,
    ownerId: OWNER_ID,
    historyId: item.historyId,
    digest: item.digest,
    taskId: item.taskId,
    taskRevision: item.taskRevision,
    requirementsDigest: item.requirementsDigest,
    originSessionId: item.anchor.sessionId,
    runId: "run-fixed",
    callId: "call-fixed",
    runDirectory: "run-fixed",
    artifactIds: ["artifact-1"],
    recordWriteReturned: true,
    byteIntegrity: "not_checked",
    authorityRestored: false,
    ...overrides,
  };
}

function writeRunFixture(
  h: Harness,
  item: HistoryItem,
  options: RunFixtureOptions = {},
): RunFixture {
  const runId = options.runId ?? "run-fixed";
  const callId = options.callId ?? "call-fixed";
  const runDirectory = options.runDirectory ?? "run-fixed";
  const selectedArtifactIds = options.selectedArtifactIds ?? ["artifact-1"];
  const recordedArtifactIds = options.recordedArtifactIds ?? selectedArtifactIds;
  const includeInput = options.includeInput ?? true;
  const withProcess = options.withProcess ?? true;
  const phase = options.phase ?? "completed";
  const runRoot = path.join(h.instanceRoot, "execution", runDirectory);
  mkdirSync(path.join(runRoot, "source"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(runRoot, "inputs"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(runRoot, "artifacts"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(runRoot, "source", "script.py"), RUN_SOURCE, { mode: 0o600 });
  const inputBytes = RUN_INPUT;
  if (includeInput) {
    writeFileSync(path.join(runRoot, "inputs", "input-1.bin"), inputBytes, { mode: 0o600 });
  }
  const artifactPaths = new Map<string, string>();
  for (const artifactId of recordedArtifactIds) {
    const bytes = options.artifactBytes?.[artifactId] ?? artifactBytesFor(artifactId);
    const artifactPath = path.join(runRoot, "artifacts", `${artifactId}.bin`);
    writeFileSync(artifactPath, bytes, { mode: 0o600 });
    artifactPaths.set(artifactId, artifactPath);
  }
  const watchdog = {
    protocol: "g2a2-watchdog-v1",
    armed: true,
    ackSent: true,
    controlEnded: true,
    watchdogTerminated: true,
    controlError: null,
    unexpectedControlEof: false,
    watchdogKilledByHost: false,
    handshakeError: null,
    triggerReason: null,
    pidGone: true,
  };
  const artifacts = recordedArtifactIds.map((artifactId) => {
    const bytes = options.artifactBytes?.[artifactId] ?? artifactBytesFor(artifactId);
    return {
      artifactId,
      relativePath: `${artifactId}.txt`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      archiveRef: `${runDirectory}/artifacts/${artifactId}.bin`,
      verified: true,
    };
  });
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    limitsVersion: "g2a2-v1",
    runId,
    callId,
    taskId: item.taskId,
    ownerId: OWNER_ID,
    taskRevision: item.taskRevision,
    requirementsDigest: item.requirementsDigest,
    anchorMessageId: item.anchor.messageId,
    capabilityId: "local-script",
    runtime: "python",
    runtimeVersion: "3.9.6",
    source: { bytes: RUN_SOURCE.length, sha256: sha256(RUN_SOURCE) },
    inputs: includeInput ? [{
      id: "input-1",
      bytes: inputBytes.length,
      sha256: sha256(inputBytes),
      stagedPath: path.join(runRoot, "inputs", "input-1.bin"),
      sourcePath: "/outside/never-read-by-evidence.txt",
    }] : [],
    interpreter: "/usr/bin/python3",
    launcher: "/launcher",
    profilePath: path.join(runRoot, "profile.sb"),
    createdAt: NOW,
    phase,
    updatedAt: NOW,
    ...(withProcess ? {
      process: {
        spawned: true,
        pid: 12345,
        pgid: 12345,
        exitCode: 0,
        signal: null,
        durationMs: 5,
        stopReason: null,
        terminatedByHost: false,
        groupGone: true,
        groupCheckMs: 0,
        spawnError: null,
        launchStage: "unknown",
        hostRecordError: null,
        watchdog,
      },
      watchdog,
    } : {}),
    artifacts,
    artifactRejections: [],
    artifactTotalBytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
    artifactLimitReached: false,
    artifactExportError: null,
    hostRecordError: null,
    taskAccepted: false,
    candidateOnly: true,
  };
  const recordPath = path.join(runRoot, "record.json");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const data = runLocatorData(h, item, {
    runId,
    callId,
    runDirectory,
    artifactIds: selectedArtifactIds,
  });
  const entry = h.appendEntry({
    id: options.locatorId ?? `run-locator-${h.branch.length}`,
    parentId: h.leafId,
    type: "custom",
    customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
    data,
  });
  return {
    runId,
    callId,
    runDirectory,
    runRoot,
    recordPath,
    selectedArtifactIds,
    recordedArtifactIds,
    artifactPaths,
    data,
    entry,
  };
}

function listedTaskSelector(h: Harness, view: HistoryViewControls): string {
  const listed = view.list(h.context(), { limit: 16 });
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error("task list failed");
  expect(listed.view.items).toHaveLength(1);
  return listed.view.items[0]!.selector;
}

function listedRunSelector(
  h: Harness,
  view: HistoryViewControls,
  taskSelector: string,
): { selector: string; runId: string; artifactIds: string[] } {
  const listed = view.listRuns(h.context(), { taskSelector });
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error("run list failed");
  expect(listed.view.items).toHaveLength(1);
  return {
    selector: listed.view.items[0]!.selector,
    runId: listed.view.items[0]!.runId,
    artifactIds: listed.view.items[0]!.artifactIds,
  };
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

  test("list_runs and inspect_run bind exact archived bytes and full identities", () => {
    const h = harness();
    const task = h.startTask("user-1", "Run it.");
    const run = writeRunFixture(h, task.item);
    const ownerBefore = h.owner.snapshot();
    const fresh = new TaskOwner({ workspaceRoot: h.workspace, ownerId: FRESH_OWNER_ID });
    const freshBefore = fresh.snapshot();
    const executionBefore = readdirSync(path.join(h.instanceRoot, "execution")).sort();
    const view = h.view();
    const taskSelector = listedTaskSelector(h, view);

    const listed = view.listRuns(h.context(), { taskSelector });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.view.schemaVersion).toBe(HISTORY_VIEW_SCHEMA_VERSION);
    expect(listed.view.action).toBe("list_runs");
    expect(listed.view.result).toBe("visible_runs");
    expect(listed.view.items).toHaveLength(1);
    expect(listed.view.items[0]).toMatchObject({
      historyId: task.item.historyId,
      digest: task.item.digest,
      taskId: task.item.taskId,
      taskRevision: task.item.taskRevision,
      requirementsDigest: task.item.requirementsDigest,
      runId: run.runId,
      callId: run.callId,
      runDirectory: run.runDirectory,
      artifactIds: ["artifact-1"],
      recordWriteReturned: true,
      byteIntegrity: "not_checked",
      authorityRestored: false,
    });
    expect(listed.view.items[0]!.selector).toMatch(HISTORY_RUN_SELECTOR_PATTERN);
    expect(listed.view.coverage).toMatchObject({
      candidates: 1,
      evaluated: 1,
      inspected: 1,
      returned: 1,
      withheld: 0,
      duplicatesCollapsed: 0,
      more: false,
    });
    expect(listed.view.budget).toMatchObject({
      inspections: 1,
      prechargedBytes: 1024 * 1024,
      bytesLimit: 16 * 1024 * 1024,
    });
    expect(JSON.stringify(listed.view)).not.toContain(h.root);
    expect(JSON.stringify(listed.view)).not.toContain("print('view run evidence')");

    const inspected = view.inspectRun(h.context(), listed.view.items[0]!.selector);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.view.action).toBe("inspect_run");
    expect(inspected.view.result).toBe("archived_run_evidence");
    expect(inspected.view.state).toBe("consistent");
    expect(inspected.view.verification).toEqual({
      instance: "exact",
      history: "exact",
      run: "exact",
      metadata: "matched",
      artifactSet: "exact",
    });
    expect(inspected.view.association).toMatchObject({
      historyId: task.item.historyId,
      digest: task.item.digest,
      taskId: task.item.taskId,
      taskRevision: task.item.taskRevision,
      requirementsDigest: task.item.requirementsDigest,
      runId: run.runId,
      callId: run.callId,
      runDirectory: run.runDirectory,
      artifactIds: ["artifact-1"],
      recordWriteReturned: true,
      byteIntegrity: "not_checked",
      authorityRestored: false,
    });
    const evidence = inspected.view.runEvidence;
    expect(evidence.state).toBe("consistent");
    expect(evidence.history).toMatchObject({
      historyId: task.item.historyId,
      digest: task.item.digest,
      taskId: task.item.taskId,
      taskRevision: task.item.taskRevision,
      requirementsDigest: task.item.requirementsDigest,
    });
    expect(evidence.run).toMatchObject({
      runId: run.runId,
      callId: run.callId,
      locator: `${run.runDirectory}/record.json`,
    });
    expect(evidence.metadata.state).toBe("matched");
    expect(evidence.selection).toEqual({
      requested: ["artifact-1"],
      recorded: ["artifact-1"],
      missing: [],
      allPresent: true,
    });
    expect(evidence.bytes.state).toBe("verified");
    expect(evidence.bytes.source).toMatchObject({
      bytes: RUN_SOURCE.length,
      sha256: sha256(RUN_SOURCE),
      state: "matched",
    });
    expect(evidence.bytes.inputs).toHaveLength(1);
    expect(evidence.bytes.inputs[0]).toMatchObject({
      id: "input-1",
      bytes: RUN_INPUT.length,
      sha256: sha256(RUN_INPUT),
      state: "matched",
    });
    expect(evidence.bytes.artifacts).toHaveLength(1);
    expect(evidence.bytes.artifacts[0]).toMatchObject({
      artifactId: "artifact-1",
      relativePath: "artifact-1.txt",
      bytes: RUN_ARTIFACT.length,
      sha256: sha256(RUN_ARTIFACT),
      state: "matched",
    });
    expect(evidence.processRecorded.state).toBe("completed_recorded");
    expect(evidence.processCurrent).toBe("not_checked");
    expect(evidence.acceptanceEvidence).toBe("not_checked");
    expect(evidence.candidateRegistration).toBe("not_checked");
    expect(evidence.branchVisibility).toBe("not_checked");
    expect(evidence.authorityRestored).toBe(false);
    expect(evidence.evidence).toBe("local-record");
    expect(inspected.view.budget).toEqual({
      taskInspections: 1,
      runEvidenceCalls: 1,
      prechargedBytes: HISTORY_RUN_EVIDENCE_PRECHARGE_BYTES,
      precharge: "conservative_not_measured",
      bytesLimit: 16 * 1024 * 1024,
    });
    expect(inspected.view.evidence).toMatchObject({
      historical: true,
      authorityRestored: false,
      presentExecution: "not_checked",
      acceptanceEvidence: "not_checked",
      candidateRegistration: "not_checked",
      bridge: {
        selectedBranch: "checked",
        requirementLedger: "checked",
        runEvidence: "checked",
      },
    });
    const wire = JSON.stringify(inspected.view);
    expect(wire).not.toContain(h.instanceRoot);
    expect(wire).not.toContain(h.stateRoot);
    expect(wire).not.toContain(run.runRoot);
    expect(wire).not.toContain("print('view run evidence')");
    expect(wire).not.toContain("view artifact — 42");
    expect(wire).not.toContain("\"success\"");
    expect(readFileSync(run.artifactPaths.get("artifact-1")!)).toEqual(RUN_ARTIFACT);
    expect(readdirSync(path.join(h.instanceRoot, "execution")).sort()).toEqual(executionBefore);
    expect(h.owner.snapshot()).toEqual(ownerBefore);
    expect(fresh.snapshot()).toEqual(freshBefore);
    expect(fresh.snapshot().currentTask).toBeNull();
  });

  test("zero artifacts are legitimate and an unknown recorded process is not success", () => {
    const zero = harness();
    const zeroTask = zero.startTask("user-1", "Run without artifacts.");
    writeRunFixture(zero, zeroTask.item, {
      selectedArtifactIds: [],
      recordedArtifactIds: [],
      includeInput: false,
    });
    const zeroView = zero.view();
    const zeroTaskSelector = listedTaskSelector(zero, zeroView);
    const zeroRun = listedRunSelector(zero, zeroView, zeroTaskSelector);
    const zeroInspected = zeroView.inspectRun(zero.context(), zeroRun.selector);
    expect(zeroInspected.ok).toBe(true);
    if (!zeroInspected.ok) return;
    expect(zeroInspected.view.result).toBe("archived_run_evidence");
    expect(zeroInspected.view.state).toBe("consistent");
    expect(zeroInspected.view.verification.artifactSet).toBe("exact");
    expect(zeroInspected.view.runEvidence.selection).toEqual({
      requested: [],
      recorded: [],
      missing: [],
      allPresent: true,
    });
    expect(zeroInspected.view.runEvidence.bytes.state).toBe("verified");
    expect(zeroInspected.view.runEvidence.bytes.inputs).toEqual([]);
    expect(zeroInspected.view.runEvidence.bytes.artifacts).toEqual([]);

    const unknown = harness();
    const unknownTask = unknown.startTask("user-1", "Run with an unknown process.");
    writeRunFixture(unknown, unknownTask.item, { withProcess: false });
    const unknownView = unknown.view();
    const unknownTaskSelector = listedTaskSelector(unknown, unknownView);
    const unknownRun = listedRunSelector(unknown, unknownView, unknownTaskSelector);
    const unknownInspected = unknownView.inspectRun(unknown.context(), unknownRun.selector);
    expect(unknownInspected.ok).toBe(true);
    if (!unknownInspected.ok) return;
    expect(unknownInspected.view.result).toBe("archived_run_evidence");
    expect(unknownInspected.view.state).toBe("unknown");
    expect(unknownInspected.view.runEvidence.state).toBe("unknown");
    expect(unknownInspected.view.runEvidence.processRecorded.state).toBe("unknown_recorded");
    expect(unknownInspected.view.runEvidence.metadata.state).toBe("matched");
    const wire = JSON.stringify(unknownInspected.view);
    expect(wire).not.toContain("\"success\"");
    expect(wire).not.toContain("\"accepted\":" + "true");
    expect(wire).not.toContain("print('view run evidence')");
  });

  test("exact artifact-set equality rejects an extra record artifact and a missing selected artifact", () => {
    const extra = harness();
    const extraTask = extra.startTask("user-1", "Run with an extra record artifact.");
    writeRunFixture(extra, extraTask.item, {
      selectedArtifactIds: ["artifact-1"],
      recordedArtifactIds: ["artifact-1", "artifact-2"],
    });
    const extraView = extra.view();
    const extraSelector = listedTaskSelector(extra, extraView);
    const extraRun = listedRunSelector(extra, extraView, extraSelector);
    const extraInspected = extraView.inspectRun(extra.context(), extraRun.selector);
    expect(extraInspected.ok).toBe(true);
    if (!extraInspected.ok) return;
    expect(extraInspected.view.result).toBe("withheld_archived_run_evidence");
    expect(extraInspected.view.state).toBe("mismatch");
    expect(extraInspected.view.verification.artifactSet).toBe("mismatch");
    expect(extraInspected.view.runEvidence.state).toBe("consistent");
    expect(extraInspected.view.runEvidence.selection).toEqual({
      requested: ["artifact-1"],
      recorded: ["artifact-1", "artifact-2"],
      missing: [],
      allPresent: true,
    });

    const missing = harness();
    const missingTask = missing.startTask("user-1", "Run with a missing selected artifact.");
    writeRunFixture(missing, missingTask.item, {
      selectedArtifactIds: ["artifact-1", "artifact-2"],
      recordedArtifactIds: ["artifact-1"],
    });
    const missingView = missing.view();
    const missingSelector = listedTaskSelector(missing, missingView);
    const missingRun = listedRunSelector(missing, missingView, missingSelector);
    const missingInspected = missingView.inspectRun(missing.context(), missingRun.selector);
    expect(missingInspected.ok).toBe(true);
    if (!missingInspected.ok) return;
    expect(missingInspected.view.result).toBe("withheld_archived_run_evidence");
    expect(missingInspected.view.state).toBe("mismatch");
    expect(missingInspected.view.verification.artifactSet).toBe("mismatch");
    expect(missingInspected.view.runEvidence.state).toBe("mismatch");
    expect(missingInspected.view.runEvidence.selection).toEqual({
      requested: ["artifact-1", "artifact-2"],
      recorded: ["artifact-1"],
      missing: ["artifact-2"],
      allPresent: false,
    });
  });

  test("actual byte modification and an unsafe run path are refused by real A reads", () => {
    const changed = harness();
    const changedTask = changed.startTask("user-1", "Run then change bytes.");
    const changedRun = writeRunFixture(changed, changedTask.item);
    const changedView = changed.view();
    const changedTaskSelector = listedTaskSelector(changed, changedView);
    const changedRunSelector = listedRunSelector(changed, changedView, changedTaskSelector);
    const rewritten = Buffer.from("view artifact — 43\n", "utf8");
    writeFileSync(changedRun.artifactPaths.get("artifact-1")!, rewritten);
    const changedInspect = changedView.inspectRun(changed.context(), changedRunSelector.selector);
    expect(changedInspect.ok).toBe(true);
    if (!changedInspect.ok) return;
    expect(changedInspect.view.result).toBe("archived_run_evidence");
    expect(changedInspect.view.state).toBe("changed");
    expect(changedInspect.view.verification.artifactSet).toBe("exact");
    expect(changedInspect.view.runEvidence.state).toBe("changed");
    expect(changedInspect.view.runEvidence.bytes.state).toBe("changed");
    expect(changedInspect.view.runEvidence.bytes.artifacts[0]).toMatchObject({
      artifactId: "artifact-1",
      bytes: rewritten.length,
      sha256: sha256(rewritten),
      state: "changed",
    });
    expect(changedInspect.view.runEvidence.bytes.artifacts[0]!.sha256)
      .not.toBe(sha256(RUN_ARTIFACT));

    const linked = harness();
    const linkedTask = linked.startTask("user-1", "Run through an unsafe path.");
    const linkedRun = writeRunFixture(linked, linkedTask.item);
    const linkedView = linked.view();
    const linkedTaskSelector = listedTaskSelector(linked, linkedView);
    const linkedRunSelector = listedRunSelector(linked, linkedView, linkedTaskSelector);
    const outside = path.join(linked.root, "outside-run");
    mkdirSync(outside, { mode: 0o700 });
    rmSync(linkedRun.runRoot, { recursive: true, force: true });
    symlinkSync(outside, linkedRun.runRoot, "dir");
    const linkedInspect = linkedView.inspectRun(linked.context(), linkedRunSelector.selector);
    expect(linkedInspect.ok).toBe(true);
    if (!linkedInspect.ok) return;
    expect(linkedInspect.view.result).toBe("withheld_archived_run_evidence");
    expect(linkedInspect.view.state).toBe("changed");
    expect(linkedInspect.view.runEvidence.state).toBe("changed");
    expect(linkedInspect.view.runEvidence.run).toBeNull();
    expect(linkedInspect.view.runEvidence.selection).toBeNull();
    expect(linkedInspect.view.verification.artifactSet).toBe("mismatch");
  });

  test("task locator order, duplication, disappearance and wrong source prefix withhold run association", () => {
    const order = harness();
    const orderTask = order.startTask("user-1", "Run before task locator.");
    const orderRun = writeRunFixture(order, orderTask.item);
    const base = order.branch[0]!;
    const source = order.branch.find((entry) => entry.id === "user-1")!;
    const taskLocator = order.branch.find(
      (entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE,
    )!;
    order.branch = [base, source, orderRun.entry, taskLocator];
    source.parentId = base.id;
    orderRun.entry.parentId = source.id;
    taskLocator.parentId = orderRun.entry.id;
    order.leafId = taskLocator.id;
    const orderView = order.view();
    const orderTaskSelector = listedTaskSelector(order, orderView);
    const orderListed = orderView.listRuns(order.context(), { taskSelector: orderTaskSelector });
    expect(orderListed.ok).toBe(true);
    if (!orderListed.ok) return;
    expect(orderListed.view.items).toEqual([]);
    expect(orderListed.view.coverage.withheldReasons.run_task_order).toBe(1);
    expect(orderListed.view.coverage.inspected).toBe(1);

    const duplicate = harness();
    const duplicateTask = duplicate.startTask("user-1", "Duplicate task locator.");
    writeRunFixture(duplicate, duplicateTask.item);
    const duplicateView = duplicate.view();
    const duplicateTaskSelector = listedTaskSelector(duplicate, duplicateView);
    duplicate.appendLocator(duplicate.locatorData(duplicateTask.item), "task-locator-dup");
    expect(duplicateView.listRuns(duplicate.context(), { taskSelector: duplicateTaskSelector }))
      .toEqual({ ok: false, code: "new_list_required" });

    const changed = harness();
    const changedTask = changed.startTask("user-1", "Changed task locator.");
    writeRunFixture(changed, changedTask.item);
    const changedView = changed.view();
    const changedTaskSelector = listedTaskSelector(changed, changedView);
    const changedLocator = changed.branch.find(
      (entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE,
    )!;
    (changedLocator.data as Record<string, unknown>).digest =
      `history-item-v1:sha256:${"0".repeat(64)}`;
    expect(changedView.listRuns(changed.context(), { taskSelector: changedTaskSelector }))
      .toEqual({ ok: false, code: "new_list_required" });

    const sourceOrder = harness();
    const sourceOrderTask = sourceOrder.startTask("user-1", "Source moved after locator.");
    const sourceOrderRun = writeRunFixture(sourceOrder, sourceOrderTask.item);
    const sourceOrderView = sourceOrder.view();
    const sourceOrderTaskSelector = listedTaskSelector(sourceOrder, sourceOrderView);
    const sourceOrderBase = sourceOrder.branch[0]!;
    const sourceOrderSource = sourceOrder.branch.find((entry) => entry.id === "user-1")!;
    const sourceOrderLocator = sourceOrder.branch.find(
      (entry) => entry.customType === HISTORY_LOCATOR_CUSTOM_TYPE,
    )!;
    sourceOrder.branch = [
      sourceOrderBase,
      sourceOrderLocator,
      sourceOrderSource,
      sourceOrderRun.entry,
    ];
    sourceOrderLocator.parentId = sourceOrderBase.id;
    sourceOrderSource.parentId = sourceOrderLocator.id;
    sourceOrderRun.entry.parentId = sourceOrderSource.id;
    sourceOrder.leafId = sourceOrderRun.entry.id;
    expect(sourceOrderView.listRuns(sourceOrder.context(), {
      taskSelector: sourceOrderTaskSelector,
    })).toEqual({ ok: false, code: "new_list_required" });

    const gone = harness();
    const goneTask = gone.startTask("user-1", "Remove task locator.");
    writeRunFixture(gone, goneTask.item);
    const goneView = gone.view();
    const goneTaskSelector = listedTaskSelector(gone, goneView);
    gone.branch = gone.branch.filter(
      (entry) => entry.customType !== HISTORY_LOCATOR_CUSTOM_TYPE,
    );
    for (let index = 1; index < gone.branch.length; index += 1) {
      gone.branch[index]!.parentId = gone.branch[index - 1]!.id;
    }
    gone.leafId = gone.branch[gone.branch.length - 1]!.id;
    expect(goneView.listRuns(gone.context(), { taskSelector: goneTaskSelector }))
      .toEqual({ ok: false, code: "new_list_required" });

    const rewritten = harness();
    const rewrittenTask = rewritten.startTask("user-1", "Original source text.");
    writeRunFixture(rewritten, rewrittenTask.item);
    const rewrittenView = rewritten.view();
    const rewrittenTaskSelector = listedTaskSelector(rewritten, rewrittenView);
    (rewritten.branch.find((entry) => entry.id === "user-1")!.message as Record<string, unknown>)
      .content = [{ type: "text", text: "Rewritten source text." }];
    const rewrittenListed = rewrittenView.listRuns(rewritten.context(), {
      taskSelector: rewrittenTaskSelector,
    });
    expect(rewrittenListed).toEqual({ ok: false, code: "withheld", reason: "source_mismatch" });
  });

  test("run selectors and cursors bind navigation, session file, appends and run collection changes", () => {
    const h = harness();
    const task = h.startTask("user-1", "Page runs.");
    const first = writeRunFixture(h, task.item);
    const secondData = runLocatorData(h, task.item, {
      runId: "run-second",
      callId: "call-second",
      runDirectory: "run-second",
    });
    h.appendEntry({
      id: "run-locator-second",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: secondData,
    });
    const view = h.view();
    const taskSelector = listedTaskSelector(h, view);
    const pageOne = view.listRuns(h.context(), { taskSelector, limit: 1 });
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) return;
    expect(pageOne.view.items.map((item) => item.runId)).toEqual(["run-fixed"]);
    expect(pageOne.view.coverage.more).toBe(true);
    expect(pageOne.view.nextCursor).toMatch(HISTORY_RUN_CURSOR_PATTERN);
    const cursor = pageOne.view.nextCursor!;

    h.appendAssistant("assistant-after-run-list");
    const pageTwo = view.listRuns(h.context(), { taskSelector, limit: 1, cursor });
    expect(pageTwo.ok).toBe(true);
    if (!pageTwo.ok) return;
    expect(pageTwo.view.items.map((item) => item.runId)).toEqual(["run-second"]);
    expect(pageTwo.view.nextCursor).toBeNull();
    const inspectedAfterAppend = view.inspectRun(h.context(), pageOne.view.items[0]!.selector);
    expect(inspectedAfterAppend.ok).toBe(true);
    if (inspectedAfterAppend.ok) {
      expect(inspectedAfterAppend.view.association.runId).toBe(first.runId);
    }

    const thirdData = runLocatorData(h, task.item, {
      runId: "run-third",
      callId: "call-third",
      runDirectory: "run-third",
    });
    h.appendEntry({
      id: "run-locator-third",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: thirdData,
    });
    expect(view.listRuns(h.context(), { taskSelector, limit: 1, cursor })).toEqual({
      ok: false,
      code: "new_list_required",
    });
    expect(view.inspectRun(h.context(), pageOne.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "unknown_selector",
    });
    const relisted = view.listRuns(h.context(), { taskSelector });
    expect(relisted.ok).toBe(true);
    if (relisted.ok) expect(relisted.view.items).toHaveLength(3);

    const navigated = view.listRuns(h.context(), { taskSelector });
    expect(navigated.ok).toBe(true);
    if (!navigated.ok) return;
    const runSelector = navigated.view.items[0]!.selector;
    view.navigate("session_tree");
    expect(view.inspectRun(h.context(), runSelector)).toEqual({
      ok: false,
      code: "new_list_required",
    });

    const sessionView = h.view();
    const sessionTaskSelector = listedTaskSelector(h, sessionView);
    const sessionListed = sessionView.listRuns(h.context(), { taskSelector: sessionTaskSelector });
    expect(sessionListed.ok).toBe(true);
    if (!sessionListed.ok) return;
    h.sessionFile = path.join(h.root, "switched-run-session.jsonl");
    writeFileSync(h.sessionFile, "");
    expect(sessionView.listRuns(h.context(), { taskSelector: sessionTaskSelector })).toEqual({
      ok: false,
      code: "new_list_required",
    });
    expect(sessionView.inspectRun(h.context(), sessionListed.view.items[0]!.selector)).toEqual({
      ok: false,
      code: "new_list_required",
    });

    expect(sessionView.listRuns(h.context(), {
      taskSelector: sessionListed.view.items[0]!.selector,
    })).toEqual({ ok: false, code: "invalid_arguments" });
    expect(sessionView.inspectRun(h.context(), sessionTaskSelector)).toEqual({
      ok: false,
      code: "unknown_selector",
    });
  });

  test("run paging, duplicates and the complete collection bound stay bounded", () => {
    const h = harness();
    const task = h.startTask("user-1", "Many runs.");
    for (let index = 0; index < 17; index += 1) {
      h.appendEntry({
        id: `run-many-${index}`,
        parentId: h.leafId,
        type: "custom",
        customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
        data: runLocatorData(h, task.item, {
          runId: `run-many-${index}`,
          callId: `call-many-${index}`,
          runDirectory: `run-many-${index}`,
        }),
      });
    }
    const view = h.view();
    const taskSelector = listedTaskSelector(h, view);
    const pageOne = view.listRuns(h.context(), { taskSelector, limit: 16 });
    expect(pageOne.ok).toBe(true);
    if (!pageOne.ok) return;
    expect(pageOne.view.items).toHaveLength(16);
    expect(pageOne.view.coverage).toMatchObject({ candidates: 17, evaluated: 16, more: true });
    expect(pageOne.view.nextCursor).toMatch(HISTORY_RUN_CURSOR_PATTERN);
    const cursor = pageOne.view.nextCursor!;
    const pageTwo = view.listRuns(h.context(), { taskSelector, limit: 16, cursor });
    expect(pageTwo.ok).toBe(true);
    if (!pageTwo.ok) return;
    expect(pageTwo.view.items).toHaveLength(1);
    expect(pageTwo.view.coverage.more).toBe(false);
    expect(view.status().selectors).toBe(18);
    expect(view.status().selectors).toBeLessThanOrEqual(128);

    const duplicate = harness();
    const duplicateTask = duplicate.startTask("user-1", "Duplicate run.");
    const duplicateData = runLocatorData(duplicate, duplicateTask.item);
    duplicate.appendEntry({
      id: "run-dup-1",
      parentId: duplicate.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: duplicateData,
    });
    duplicate.appendEntry({
      id: "run-dup-2",
      parentId: duplicate.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: duplicateData,
    });
    const duplicateView = duplicate.view();
    const duplicateSelector = listedTaskSelector(duplicate, duplicateView);
    const duplicateListed = duplicateView.listRuns(duplicate.context(), {
      taskSelector: duplicateSelector,
    });
    expect(duplicateListed.ok).toBe(true);
    if (!duplicateListed.ok) return;
    expect(duplicateListed.view.items).toHaveLength(1);
    expect(duplicateListed.view.coverage).toMatchObject({
      candidates: 2,
      returned: 1,
      duplicatesCollapsed: 1,
      withheld: 0,
    });

    const over = harness();
    const overTask = over.startTask("user-1", "Too many runs.");
    for (let index = 0; index < 129; index += 1) {
      over.appendEntry({
        id: `run-over-${index}`,
        parentId: over.leafId,
        type: "custom",
        customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
        data: runLocatorData(over, overTask.item, {
          runId: `run-over-${index}`,
          callId: `call-over-${index}`,
          runDirectory: `run-over-${index}`,
        }),
      });
    }
    const overView = over.view();
    const overSelector = listedTaskSelector(over, overView);
    expect(overView.listRuns(over.context(), { taskSelector: overSelector })).toEqual({
      ok: false,
      code: "limit",
    });
  });

  test("the final composition callback rewrites the archive and real A rejects the old bytes", () => {
    const h = harness();
    const task = h.startTask("user-1", "Rewrite at seal.");
    const run = writeRunFixture(h, task.item);
    let armed = false;
    let armedCalls = 0;
    const view = createHistoryView({
      stateRoot: h.stateRoot,
      workspaceRoot: h.workspace,
      isCurrentComposition: () => {
        if (armed) {
          armedCalls += 1;
          if (armedCalls === 2) {
            writeFileSync(run.artifactPaths.get("artifact-1")!, "rewritten at final seal\n");
          }
        }
        return true;
      },
    });
    const taskSelector = listedTaskSelector(h, view);
    const runSelector = listedRunSelector(h, view, taskSelector).selector;
    const before = readFileSync(run.artifactPaths.get("artifact-1")!);
    armed = true;
    const inspected = view.inspectRun(h.context(), runSelector);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(armedCalls).toBe(2);
    const after = readFileSync(run.artifactPaths.get("artifact-1")!);
    expect(after).not.toEqual(before);
    expect(after.toString("utf8")).toBe("rewritten at final seal\n");
    expect(inspected.view.state).toBe("changed");
    expect(inspected.view.runEvidence.state).toBe("changed");
    expect(inspected.view.runEvidence.bytes.state).toBe("changed");
    expect(inspected.view.runEvidence.bytes.artifacts[0]!.sha256)
      .not.toBe(sha256(before));
  });

  test("malformed or unsupported run data claiming the actual history is withheld", () => {
    const h = harness();
    const task = h.startTask("user-1", "Malformed run claim.");
    const valid = runLocatorData(h, task.item);
    h.appendEntry({
      id: "run-invalid-claim",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: { ...valid, extra: "not-allowlisted" },
    });
    h.appendEntry({
      id: "run-unsupported-claim",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: { ...valid, version: 2, runId: "run-unsupported" },
    });
    const view = h.view();
    const taskSelector = listedTaskSelector(h, view);
    const listed = view.listRuns(h.context(), { taskSelector });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.view.items).toEqual([]);
    expect(listed.view.result).toBe("no_visible_runs");
    expect(listed.view.coverage.candidates).toBe(2);
    expect(listed.view.coverage.evaluated).toBe(2);
    expect(listed.view.coverage.withheld).toBe(2);
    expect(listed.view.coverage.withheldReasons).toMatchObject({
      run_locator_invalid: 1,
      run_locator_unsupported: 1,
    });
    expect(listed.view.coverage.inspected).toBe(1);
    expect(view.status().selectors).toBe(1);
  });

  test("a malformed run claim's history assignment changes the run collection signature", () => {
    const h = harness();
    const first = h.startTask("user-1", "First task history.");
    const second = h.reviseTask("user-2", "Second task history.");
    writeRunFixture(h, second.item, {
      runId: "run-stale-one",
      callId: "call-stale-one",
      runDirectory: "run-stale-one",
    });
    writeRunFixture(h, second.item, {
      runId: "run-stale-two",
      callId: "call-stale-two",
      runDirectory: "run-stale-two",
    });
    const malformed = h.appendEntry({
      id: "run-malformed-claim",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: {
        ...runLocatorData(h, second.item, {
          runId: "run-malformed",
          callId: "call-malformed",
          runDirectory: "run-malformed",
        }),
        historyId: first.item.historyId,
        extra: "not-allowlisted",
      },
    });

    const selectTask = (view: HistoryViewControls, historyId: string): string => {
      const listed = view.list(h.context(), { limit: 16 });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error("task list failed");
      const item = listed.view.items.find((candidate) => candidate.historyId === historyId);
      expect(item).toBeDefined();
      return item!.selector;
    };

    const cursorView = h.view();
    const cursorTask = selectTask(cursorView, second.item.historyId);
    const cursorPage = cursorView.listRuns(h.context(), { taskSelector: cursorTask, limit: 1 });
    expect(cursorPage.ok).toBe(true);
    if (!cursorPage.ok) return;
    expect(cursorPage.view.items.map((item) => item.runId)).toEqual(["run-stale-one"]);
    const staleCursor = cursorPage.view.nextCursor!;
    expect(staleCursor).toMatch(HISTORY_RUN_CURSOR_PATTERN);

    const selectorView = h.view();
    const selectorTask = selectTask(selectorView, second.item.historyId);
    const selectorPage = selectorView.listRuns(h.context(), { taskSelector: selectorTask });
    expect(selectorPage.ok).toBe(true);
    if (!selectorPage.ok) return;
    expect(selectorPage.view.items.map((item) => item.runId)).toEqual([
      "run-stale-one",
      "run-stale-two",
    ]);
    const staleSelector = selectorPage.view.items[0]!.selector;

    malformed.data = {
      ...(malformed.data as Record<string, unknown>),
      historyId: second.item.historyId,
    };

    expect(cursorView.listRuns(h.context(), {
      taskSelector: cursorTask,
      limit: 1,
      cursor: staleCursor,
    })).toEqual({ ok: false, code: "new_list_required" });
    expect(selectorView.inspectRun(h.context(), staleSelector)).toEqual({
      ok: false,
      code: "new_list_required",
    });

    const refreshedCursor = cursorView.listRuns(h.context(), { taskSelector: cursorTask, limit: 1 });
    expect(refreshedCursor.ok).toBe(true);
    if (refreshedCursor.ok) {
      expect(refreshedCursor.view.items.map((item) => item.runId)).toEqual(["run-stale-one"]);
      expect(refreshedCursor.view.nextCursor).toMatch(HISTORY_RUN_CURSOR_PATTERN);
    }
    const refreshedSelector = selectorView.listRuns(h.context(), { taskSelector: selectorTask });
    expect(refreshedSelector.ok).toBe(true);
    if (!refreshedSelector.ok) return;
    expect(refreshedSelector.view.items.map((item) => item.runId)).toEqual([
      "run-stale-one",
      "run-stale-two",
    ]);
    expect(selectorView.inspectRun(h.context(), refreshedSelector.view.items[0]!.selector).ok).toBe(true);
  });

  test("run tokens bind the actual manager while task selectors keep prior behavior", () => {
    const h = harness();
    const task = h.startTask("user-1", "Swap manager.");
    writeRunFixture(h, task.item);
    h.appendEntry({
      id: "run-manager-second",
      parentId: h.leafId,
      type: "custom",
      customType: HISTORY_RUN_LOCATOR_CUSTOM_TYPE,
      data: runLocatorData(h, task.item, {
        runId: "run-manager-second",
        callId: "call-manager-second",
        runDirectory: "run-manager-second",
      }),
    });
    const selectorView = h.view();
    const selectorTask = listedTaskSelector(h, selectorView);
    const selectorPage = selectorView.listRuns(h.context(), { taskSelector: selectorTask, limit: 1 });
    expect(selectorPage.ok).toBe(true);
    if (!selectorPage.ok) return;
    const oldRunSelector = selectorPage.view.items[0]!.selector;

    const cursorView = h.view();
    const cursorTask = listedTaskSelector(h, cursorView);
    const cursorPage = cursorView.listRuns(h.context(), { taskSelector: cursorTask, limit: 1 });
    expect(cursorPage.ok).toBe(true);
    if (!cursorPage.ok) return;
    const cursor = cursorPage.view.nextCursor!;

    const replacement = h.context({ branchRead() {} }).sessionManager!;
    const swapped = h.context({ manager: replacement });
    expect(selectorView.inspectRun(swapped, oldRunSelector)).toEqual({
      ok: false,
      code: "new_list_required",
    });
    expect(cursorView.listRuns(swapped, { taskSelector: cursorTask, limit: 1, cursor })).toEqual({
      ok: false,
      code: "new_list_required",
    });

    const relisted = selectorView.listRuns(swapped, { taskSelector: selectorTask });
    expect(relisted.ok).toBe(true);
    if (!relisted.ok) return;
    expect(relisted.view.items).toHaveLength(2);
    const newRunSelector = relisted.view.items[0]!.selector;
    expect(newRunSelector).not.toBe(oldRunSelector);
    const inspected = selectorView.inspectRun(swapped, newRunSelector);
    expect(inspected.ok).toBe(true);
    expect(selectorView.inspect(swapped, selectorTask).ok).toBe(true);
  });

  test("post-A navigation, disposal or native abort refuses the bound evidence", () => {
    for (const mode of ["navigate", "dispose", "abort"] as const) {
      const h = harness();
      const task = h.startTask("user-1", `Reenter ${mode}.`);
      writeRunFixture(h, task.item);
      const view = h.view();
      const taskSelector = listedTaskSelector(h, view);
      const runSelector = listedRunSelector(h, view, taskSelector).selector;
      const controller = new AbortController();
      const original = HistoryProjectionReader.prototype.inspect;
      let reads = 0;
      let fired = false;
      const spy = spyOn(HistoryProjectionReader.prototype, "inspect").mockImplementation(
        function (this: HistoryProjectionReader, selector) {
          const result = original.call(this, selector);
          reads += 1;
          if (reads === 2) {
            fired = true;
            if (mode === "navigate") view.navigate("during_a");
            else if (mode === "dispose") view.dispose();
            else controller.abort();
          }
          return result;
        },
      );
      try {
        const inspected = view.inspectRun(
          h.context(),
          runSelector,
          mode === "abort" ? controller.signal : undefined,
        );
        expect(fired).toBe(true);
        expect(inspected).toEqual({
          ok: false,
          code: mode === "abort" ? "aborted" : mode === "dispose" ? "disposed" : "new_list_required",
        });
      } finally {
        spy.mockRestore();
      }
    }
  });
});
