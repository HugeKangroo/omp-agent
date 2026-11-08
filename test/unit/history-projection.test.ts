import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createHistoryProjectionReader,
  createHistoryProjectionWriter,
  HISTORY_FILE_BYTES_LIMIT,
  HISTORY_INDEX_FILE_NAME,
  HistoryProjectionError,
  type HistoryIndex,
  type HistoryInstanceLocator,
  type HistoryProjectionReader,
  type HistoryProjectionWriter,
} from "../../src/history-projection.ts";
import {
  requirementsDigest,
  type RequirementSource,
} from "../../src/task-requirements.ts";
import {
  TaskOwner,
  type ManagedTask,
  type TaskSubject,
} from "../../src/task-owner.ts";

const WORKSPACE = "/tmp/omp-agent-g3a-history-workspace";
const SESSION = "g3a-history-session";
const NOW = "2026-11-09T00:00:00.000Z";

type Entry = Record<string, unknown> & { id: string; parentId: string | null };

function base(id = "leaf-1"): Entry {
  return { id, parentId: null, type: "custom", customType: "g3a-base", data: {} };
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

function subject(branch: readonly unknown[]): TaskSubject {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}

interface Fixture {
  root: string;
  locator: HistoryInstanceLocator;
  owner: TaskOwner;
  writer: HistoryProjectionWriter;
  branch: Entry[];
  cleanup(): void;
}

function makeFixture(options: {
  rootPrefix?: string;
  instanceId?: string;
  ownerId?: string;
} = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), options.rootPrefix ?? "omp-agent-g3a-history-"));
  const instanceId = options.instanceId ?? "instance-g3a-history";
  const ownerId = options.ownerId ?? "owner-g3a-history";
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId,
    now: () => NOW,
    id: () => `id-${++sequence}`,
  });
  const locator: HistoryInstanceLocator = {
    instanceRoot: root,
    instanceId,
    ownerId,
    workspaceRoot: WORKSPACE,
  };
  return {
    root,
    locator,
    owner,
    writer: createHistoryProjectionWriter(locator),
    branch: [base()],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function assistantStep(fixture: Fixture, id: string): void {
  const parentId = fixture.branch.at(-1)!.id;
  fixture.branch = [...fixture.branch, assistant(id, parentId)];
}

function startTask(fixture: Fixture, userId: string, text: string): { branch: Entry[]; task: ManagedTask } {
  const parentId = fixture.branch.at(-1)!.id;
  const entry = user(userId, parentId, text);
  const branch = [...fixture.branch, entry];
  expect(fixture.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: parentId,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  const result = fixture.owner.start(subject(branch));
  fixture.branch = branch;
  expect(fixture.owner.closeTurn({
    sessionId: SESSION,
    branch,
    messages: [messageOf(entry)],
  })).toBe(true);
  return { branch, task: result.task };
}

function reviseTask(fixture: Fixture, userId: string, text: string): { branch: Entry[]; task: ManagedTask } {
  assistantStep(fixture, `assistant-${userId}`);
  const parentId = fixture.branch.at(-1)!.id;
  const entry = user(userId, parentId, text);
  const branch = [...fixture.branch, entry];
  expect(fixture.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: parentId,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  const current = fixture.owner.snapshot().currentTask!;
  const result = fixture.owner.revise(subject(branch), {
    taskId: current.taskId,
    taskRevision: current.taskRevision,
  });
  fixture.branch = branch;
  expect(fixture.owner.closeTurn({
    sessionId: SESSION,
    branch,
    messages: [messageOf(entry)],
  })).toBe(true);
  return { branch, task: result.task };
}

function cancelTask(fixture: Fixture, userId: string, text: string): { branch: Entry[]; task: ManagedTask } {
  assistantStep(fixture, `assistant-${userId}`);
  const parentId = fixture.branch.at(-1)!.id;
  const entry = user(userId, parentId, text);
  const branch = [...fixture.branch, entry];
  expect(fixture.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: parentId,
  }).accepted).toBe(true);
  fixture.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  const current = fixture.owner.snapshot().currentTask!;
  const task = fixture.owner.cancel(subject(branch), {
    taskId: current.taskId,
    taskRevision: current.taskRevision,
  });
  fixture.branch = branch;
  expect(fixture.owner.closeTurn({
    sessionId: SESSION,
    branch,
    messages: [messageOf(entry)],
  })).toBe(true);
  return { branch, task };
}

function syntheticTask(ownerId: string, index: number, text: string): ManagedTask {
  const anchor = {
    sessionId: "g3a-bulk-session",
    messageId: `bulk-user-${index}`,
    source: "rpc" as const,
    observedText: text,
    anchorText: text,
    observedAt: NOW,
  };
  const source: RequirementSource = {
    revision: 1,
    kind: "original",
    messageId: anchor.messageId,
    sessionId: anchor.sessionId,
    source: "rpc",
    text,
    observedAt: NOW,
    committedAt: NOW,
    previousRevision: null,
  };
  return {
    schemaVersion: 1,
    taskId: `task-bulk-${index}`,
    ownerId,
    taskRevision: 1,
    status: "active",
    rawRequest: text,
    anchor,
    requirementSources: [source],
    understanding: null,
    understandingRevision: null,
    understandingStale: false,
    createdAt: NOW,
    cancelledAt: null,
    acceptance: null,
    admissions: 0,
  };
}

function projectionCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof HistoryProjectionError) return error.code;
    throw error;
  }
  throw new Error("expected a HistoryProjectionError");
}

function indexBytes(fixture: Fixture): Buffer {
  return readFileSync(path.join(fixture.root, HISTORY_INDEX_FILE_NAME));
}

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

/**
 * Isolated subprocess probe. mock.module("node:fs") replaces module bindings
 * process-wide, so the interception runs only here and is restored before the
 * child reports. The parent assertions use real disk state after the child
 * exits; only the injected syscall faults are simulated.
 */
const PROJECTION_FAULT_PROBE = String.raw`
import * as importedFs from "node:fs";
const fs = { ...importedFs };
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "bun:test";

const root = process.env.G3A_PROBE_ROOT;
const repo = process.env.G3A_PROBE_REPO;
const scenario = process.env.G3A_PROBE_SCENARIO;
if (!root || !repo || (scenario !== "post-link" && scenario !== "short-writes")) {
  throw new Error("probe environment incomplete");
}

const WORKSPACE = path.join(root, "workspace");
const SESSION = "g3a-history-fault-session";
const NOW = "2026-11-09T00:00:00.000Z";
fs.mkdirSync(WORKSPACE);

let mode = "none";
let linked = false;
let linkedTarget = "";
const fdPaths = new Map();
const writeCounts = new Map();
let injectedFaults = 0;
let zeroReturns = 0;
let shortWrites = 0;
const injected = () => Object.assign(new Error("injected targeted EIO"), { code: "EIO" });

mock.module("node:fs", () => ({
  ...fs,
  openSync: (...args) => {
    const fd = fs.openSync(...args);
    fdPaths.set(fd, String(args[0]));
    return fd;
  },
  closeSync: (fd) => {
    fdPaths.delete(fd);
    return fs.closeSync(fd);
  },
  writeSync: (...args) => {
    const openedPath = fdPaths.get(args[0]) ?? "";
    if (mode.indexOf("short-") === 0 && openedPath.includes(".history-index.")) {
      const count = (writeCounts.get(openedPath) ?? 0) + 1;
      writeCounts.set(openedPath, count);
      shortWrites += 1;
      if (count > 1 && mode === "short-zero") {
        zeroReturns += 1;
        return 0;
      }
      if (count > 1 && mode === "short-throw") {
        injectedFaults += 1;
        throw injected();
      }
      return fs.writeSync(args[0], args[1], args[2], Math.min(args[3], 7), args[4]);
    }
    return fs.writeSync(...args);
  },
  linkSync: (from, to) => {
    fs.linkSync(from, to);
    if (mode === "post-link" && to === linkedTarget) linked = true;
  },
  lstatSync: (...args) => {
    if (mode === "post-link" && linked && String(args[0]) === linkedTarget) {
      injectedFaults += 1;
      throw injected();
    }
    return fs.lstatSync(...args);
  },
}));

const { TaskOwner } = await import(pathToFileURL(path.join(repo, "src/task-owner.ts")).href);
const { createHistoryProjectionWriter } = await import(pathToFileURL(path.join(repo, "src/history-projection.ts")).href);

function base() {
  return { id: "leaf-1", parentId: null, type: "custom", customType: "g3a-base", data: {} };
}
function user(id, parentId, text) {
  return { id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }], attribution: "user" } };
}
function assistant(id, parentId) {
  return { id, parentId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "working" }] } };
}
function messageOf(entry) {
  return { ...entry.message, id: entry.id };
}
function subject(branch) {
  return { sessionId: SESSION, workspaceRoot: WORKSPACE, agentKind: "main", branch };
}
function setup(name) {
  const instanceRoot = path.join(root, name);
  fs.mkdirSync(instanceRoot);
  const locator = { instanceRoot, instanceId: "instance-g3a-fault", ownerId: "owner-g3a-fault", workspaceRoot: WORKSPACE };
  let sequence = 0;
  const owner = new TaskOwner({
    workspaceRoot: WORKSPACE,
    ownerId: locator.ownerId,
    now: () => NOW,
    id: () => "id-" + (++sequence),
  });
  const writer = createHistoryProjectionWriter(locator);
  return { instanceRoot, locator, owner, writer, branch: [base()] };
}
function accepted(value, label) {
  if (!value) throw new Error(label);
}
function startTask(fixture, userId, text) {
  const parentId = fixture.branch[fixture.branch.length - 1].id;
  const entry = user(userId, parentId, text);
  const branch = [...fixture.branch, entry];
  accepted(fixture.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: parentId,
  }).accepted, "input not accepted");
  fixture.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  const result = fixture.owner.start(subject(branch));
  fixture.branch = branch;
  accepted(fixture.owner.closeTurn({ sessionId: SESSION, branch, messages: [messageOf(entry)] }), "turn not closed");
  return result.task;
}
function reviseTask(fixture, userId, text) {
  const assistantParent = fixture.branch[fixture.branch.length - 1].id;
  fixture.branch = [...fixture.branch, assistant("assistant-" + userId, assistantParent)];
  const parentId = fixture.branch[fixture.branch.length - 1].id;
  const entry = user(userId, parentId, text);
  const branch = [...fixture.branch, entry];
  accepted(fixture.owner.observeInput({
    sessionId: SESSION,
    workspaceRoot: WORKSPACE,
    source: "rpc",
    text,
    observedAt: NOW,
    baseLeafId: parentId,
  }).accepted, "input not accepted");
  fixture.owner.observeAgentStart({ sessionId: SESSION, prompt: text, reason: "prompt" });
  const current = fixture.owner.snapshot().currentTask;
  const result = fixture.owner.revise(subject(branch), { taskId: current.taskId, taskRevision: current.taskRevision });
  fixture.branch = branch;
  accepted(fixture.owner.closeTurn({ sessionId: SESSION, branch, messages: [messageOf(entry)] }), "turn not closed");
  return result.task;
}
function outcome(run) {
  try {
    return { returned: run() };
  } catch (error) {
    return {
      threw: true,
      code: error && error.code ? error.code : null,
      message: error && error.message ? error.message : String(error),
    };
  }
}
function statusOf(run) {
  const result = outcome(run);
  return result.threw ? result : { status: result.returned.status };
}
function itemCount(indexPath) {
  return JSON.parse(fs.readFileSync(indexPath, "utf8")).items.length;
}
function remainingTemporaries(instanceRoot) {
  return fs.readdirSync(instanceRoot).filter((name) => name.indexOf(".history-index.") === 0);
}

const report = {};
if (scenario === "post-link") {
  const control = setup("control");
  const controlTask = startTask(control, "user-1", "Fault fixture request.");
  report.control = statusOf(() => control.writer.capture(controlTask));
  fs.writeFileSync(path.join(root, "expected.json"), fs.readFileSync(path.join(control.instanceRoot, "history-index.json")));

  const fixture = setup("post-link");
  const task = startTask(fixture, "user-1", "Fault fixture request.");
  const target = path.join(fixture.instanceRoot, "history-index.json");
  linkedTarget = target;
  linked = false;
  mode = "post-link";
  injectedFaults = 0;
  report.capture = statusOf(() => fixture.writer.capture(task));
  report.postLinkInjectedFaults = injectedFaults;
  mode = "none";
  linked = false;
  let beforeRetry = null;
  try { beforeRetry = fs.readFileSync(target); } catch { beforeRetry = null; }
  report.presentAfterFailure = beforeRetry !== null;
  if (beforeRetry !== null) fs.writeFileSync(path.join(root, "before-retry.json"), beforeRetry);
  report.retry = statusOf(() => fixture.writer.capture(task));
  let afterRetry = null;
  try { afterRetry = fs.readFileSync(target); } catch { afterRetry = null; }
  report.presentAfterRetry = afterRetry !== null;
  report.unchangedAfterRetry = beforeRetry !== null && afterRetry !== null && beforeRetry.equals(afterRetry);
  report.itemCountAfterRetry = afterRetry !== null ? JSON.parse(afterRetry.toString("utf8")).items.length : null;
} else {
  const control = setup("control");
  const controlTask = startTask(control, "user-1", "Fault fixture request.");
  report.control = statusOf(() => control.writer.capture(controlTask));
  fs.writeFileSync(path.join(root, "expected.json"), fs.readFileSync(path.join(control.instanceRoot, "history-index.json")));

  const shortSuccess = setup("short-success");
  const shortSuccessTask = startTask(shortSuccess, "user-1", "Fault fixture request.");
  mode = "short-success";
  shortWrites = 0;
  report.shortSuccess = statusOf(() => shortSuccess.writer.capture(shortSuccessTask));
  report.shortSuccessWrites = shortWrites;
  mode = "none";
  report.shortSuccessItemCount = itemCount(path.join(shortSuccess.instanceRoot, "history-index.json"));

  for (const variant of ["short-throw", "short-zero"]) {
    const fixture = setup(variant);
    const firstTask = startTask(fixture, "user-1", "Fault fixture request.");
    report[variant + "First"] = statusOf(() => fixture.writer.capture(firstTask));
    const indexPath = path.join(fixture.instanceRoot, "history-index.json");
    const prior = fs.readFileSync(indexPath);
    const secondTask = reviseTask(fixture, "user-2", "Second request.");
    mode = variant;
    injectedFaults = 0;
    zeroReturns = 0;
    shortWrites = 0;
    report[variant] = statusOf(() => fixture.writer.capture(secondTask));
    report[variant + "InjectedFaults"] = injectedFaults;
    report[variant + "ZeroReturns"] = zeroReturns;
    report[variant + "Writes"] = shortWrites;
    mode = "none";
    fs.writeFileSync(path.join(root, variant + ".prior.json"), prior);
    report[variant + "Preserved"] = fs.readFileSync(indexPath).equals(prior);
    report[variant + "Temporaries"] = remainingTemporaries(fixture.instanceRoot);
    report[variant + "Retry"] = statusOf(() => fixture.writer.capture(secondTask));
    report[variant + "ItemCountAfterRetry"] = itemCount(indexPath);
  }
}

mock.restore();
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2));
`;

function runProjectionFaultProbe(scenario: "post-link" | "short-writes"): {
  root: string;
  report: Record<string, any>;
  cleanup(): void;
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), `omp-agent-g3a-history-fault-${scenario}-`)));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const script = path.join(root, "projection-fault-probe.ts");
    writeFileSync(script, PROJECTION_FAULT_PROBE);
    const spawned = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        G3A_PROBE_ROOT: root,
        G3A_PROBE_REPO: REPO_ROOT,
        G3A_PROBE_SCENARIO: scenario,
      },
    });
    if (spawned.status !== 0) {
      throw new Error(`projection fault probe failed (${String(spawned.status)}): ${spawned.stderr || spawned.stdout}`);
    }
    const report = JSON.parse(readFileSync(path.join(root, "result.json"), "utf8")) as Record<string, any>;
    return { root, report, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

describe("bounded local history projection", () => {
  test("captures real owner snapshots, revisions, terminal states and two tasks idempotently", () => {
    const fixture = makeFixture();
    const original = "First line\nSecond line — café ☃";
    const first = startTask(fixture, "user-1", original);
    const created = fixture.writer.capture(first.task);
    expect(created.status).toBe("created");
    expect(created.item).toMatchObject({
      taskId: first.task.taskId,
      taskRevision: 1,
      recordedStatus: "active",
      createdAt: NOW,
      cancelledAt: null,
      requirementsDigest: requirementsDigest(first.task.requirementSources),
    });
    // Real owner anchors have six fields; only these four are persisted.
    expect(created.item.anchor).toEqual({
      sessionId: SESSION,
      messageId: "user-1",
      source: "rpc",
      observedAt: NOW,
    });
    expect(created.item.requirementSources[0]!.text).toBe(original);
    expect(created.item.requirementSources[0]!.text).toContain("\n");
    expect(created.item.requirementSources[0]!.text).toContain("☃");
    expect(created.item.acceptance).toBeNull();
    expect(created.authorityRestored).toBe(false);
    expect(created.branchVisibility).toBe("not_checked");

    const firstBytes = indexBytes(fixture);
    const unchanged = fixture.writer.capture(first.task);
    expect(unchanged.status).toBe("unchanged");
    expect(unchanged.item.historyId).toBe(created.item.historyId);
    expect(unchanged.item.digest).toBe(created.item.digest);
    expect(indexBytes(fixture).equals(firstBytes)).toBe(true);

    const revised = reviseTask(fixture, "user-2", "Amendment — 二\nø");
    const appendedRevision = fixture.writer.capture(revised.task);
    expect(appendedRevision.status).toBe("appended");
    expect(appendedRevision.item.taskRevision).toBe(2);
    expect(appendedRevision.item.requirementSources.map((source) => source.text)).toEqual([
      original,
      "Amendment — 二\nø",
    ]);
    expect(appendedRevision.item.historyId).not.toBe(created.item.historyId);

    const cancelled = cancelTask(fixture, "user-3", "Cancel this task.");
    const appendedTerminal = fixture.writer.capture(cancelled.task);
    expect(appendedTerminal.status).toBe("appended");
    expect(appendedTerminal.item).toMatchObject({
      taskRevision: 2,
      recordedStatus: "cancelled",
      createdAt: NOW,
      cancelledAt: NOW,
    });
    expect(appendedTerminal.item.historyId).not.toBe(appendedRevision.item.historyId);

    assistantStep(fixture, "assistant-second");
    const second = startTask(fixture, "user-4", "Second managed task.");
    const appendedSecondTask = fixture.writer.capture(second.task);
    expect(appendedSecondTask.status).toBe("appended");
    expect(appendedSecondTask.item.taskId).not.toBe(first.task.taskId);

    const parsed = JSON.parse(readFileSync(path.join(fixture.root, HISTORY_INDEX_FILE_NAME), "utf8")) as HistoryIndex;
    expect(Object.keys(parsed).sort()).toEqual(["format", "instance", "items", "owner", "schemaVersion", "workspace"]);
    expect(parsed.instance).toBe(fixture.locator.instanceId);
    expect(parsed.owner).toBe(fixture.locator.ownerId);
    expect(parsed.workspace).toBe(WORKSPACE);
    expect(parsed.items).toHaveLength(4);
    expect(Object.keys(parsed.items[0]!).sort()).toEqual([
      "acceptance",
      "anchor",
      "cancelledAt",
      "createdAt",
      "digest",
      "historyId",
      "recordedStatus",
      "requirementSources",
      "requirementsDigest",
      "taskId",
      "taskRevision",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("activeGrant");
    expect(JSON.stringify(parsed)).not.toContain("understanding");

    const reader: HistoryProjectionReader = createHistoryProjectionReader(fixture.locator);
    const beforeStat = statSync(path.join(fixture.root, HISTORY_INDEX_FILE_NAME));
    const page = reader.list({ limit: 16 });
    expect(page.total).toBe(4);
    expect(page.items.map((row) => row.historyId)).toEqual([
      created.item.historyId,
      appendedRevision.item.historyId,
      appendedTerminal.item.historyId,
      appendedSecondTask.item.historyId,
    ]);
    expect(page.items.map((row) => row.digest)).toEqual([
      created.item.digest,
      appendedRevision.item.digest,
      appendedTerminal.item.digest,
      appendedSecondTask.item.digest,
    ]);
    expect(page.fileDigest).toBe(appendedSecondTask.fileDigest);
    expect(page.authorityRestored).toBe(false);
    expect(page.branchVisibility).toBe("not_checked");

    const inspection = reader.inspect({
      historyId: appendedTerminal.item.historyId,
      digest: appendedTerminal.item.digest,
      expectedOwnerId: fixture.locator.ownerId,
      expectedTaskId: appendedTerminal.item.taskId,
      expectedTaskRevision: appendedTerminal.item.taskRevision,
    });
    expect(inspection.item).toEqual(appendedTerminal.item);
    expect(inspection.itemDigestMatchesContent).toBe(true);
    expect(inspection.acceptanceEvidence).toBe("not_checked");
    expect(inspection.candidateRegistration).toBe("not_checked");
    inspection.item.requirementSources[0]!.text = "caller mutation";
    inspection.item.anchor.messageId = "caller-mutation";
    appendedTerminal.item.requirementSources[0]!.text = "capture mutation";
    expect(reader.inspect({
      historyId: appendedTerminal.item.historyId,
      digest: appendedTerminal.item.digest,
      expectedOwnerId: fixture.locator.ownerId,
      expectedTaskId: appendedTerminal.item.taskId,
      expectedTaskRevision: appendedTerminal.item.taskRevision,
    }).item.requirementSources[0]!.text).toBe(original);

    const afterStat = statSync(path.join(fixture.root, HISTORY_INDEX_FILE_NAME));
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    fixture.cleanup();
  });

  test("rejects wrong identity, selector, schema, fields, source chain and missing files", () => {
    const fixture = makeFixture();
    const task = startTask(fixture, "user-1", "Identity fixture request.").task;
    const captured = fixture.writer.capture(task);
    const indexPath = path.join(fixture.root, HISTORY_INDEX_FILE_NAME);
    const original = readFileSync(indexPath);

    expect(projectionCode(() => createHistoryProjectionReader({ ...fixture.locator, ownerId: "owner-other" }).list())).toBe("mismatch");
    expect(projectionCode(() => createHistoryProjectionReader({ ...fixture.locator, instanceId: "instance-other" }).list())).toBe("mismatch");
    expect(projectionCode(() => createHistoryProjectionReader({ ...fixture.locator, workspaceRoot: "/tmp/other-workspace" }).list())).toBe("mismatch");
    const reader = createHistoryProjectionReader(fixture.locator);
    expect(projectionCode(() => reader.inspect({
      historyId: captured.item.historyId,
      digest: `sha256:${"0".repeat(64)}`,
      expectedOwnerId: fixture.locator.ownerId,
      expectedTaskId: captured.item.taskId,
      expectedTaskRevision: captured.item.taskRevision,
    }))).toBe("mismatch");
    expect(projectionCode(() => reader.inspect({
      historyId: "history-missing",
      digest: captured.item.digest,
      expectedOwnerId: fixture.locator.ownerId,
      expectedTaskId: captured.item.taskId,
      expectedTaskRevision: captured.item.taskRevision,
    }))).toBe("not-found");
    expect(projectionCode(() => reader.inspect({
      historyId: captured.item.historyId,
      digest: captured.item.digest,
      expectedOwnerId: fixture.locator.ownerId,
      expectedTaskId: captured.item.taskId,
      expectedTaskRevision: captured.item.taskRevision + 1,
    }))).toBe("mismatch");

    const request = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
    request.schemaVersion = 99;
    writeFileSync(indexPath, `${JSON.stringify(request, null, 2)}\n`);
    expect(projectionCode(() => reader.list())).toBe("unsupported");
    const unknownHeader = JSON.parse(original.toString("utf8")) as Record<string, unknown>;
    unknownHeader.extra = true;
    writeFileSync(indexPath, `${JSON.stringify(unknownHeader, null, 2)}\n`);
    expect(projectionCode(() => reader.list())).toBe("invalid");
    const unknownItem = JSON.parse(original.toString("utf8")) as HistoryIndex;
    (unknownItem.items[0] as unknown as Record<string, unknown>).extra = true;
    writeFileSync(indexPath, `${JSON.stringify(unknownItem, null, 2)}\n`);
    expect(projectionCode(() => reader.list())).toBe("invalid");
    const missingChain = JSON.parse(original.toString("utf8")) as HistoryIndex;
    missingChain.items[0]!.requirementSources = [];
    writeFileSync(indexPath, `${JSON.stringify(missingChain, null, 2)}\n`);
    expect(projectionCode(() => reader.list())).toBe("invalid");
    writeFileSync(indexPath, Buffer.from([0xff, 0xfe]));
    expect(projectionCode(() => reader.list())).toBe("unsupported");
    writeFileSync(indexPath, original);
    expect(reader.list().total).toBe(1);
    expect(readFileSync(indexPath).equals(original)).toBe(true);

    const brokenTask = JSON.parse(JSON.stringify(task)) as ManagedTask;
    brokenTask.requirementSources[0]!.previousRevision = 4;
    expect(projectionCode(() => fixture.writer.capture(brokenTask))).toBe("invalid");
    expect(readFileSync(indexPath).equals(original)).toBe(true);

    const missingRoot = mkdtempSync(path.join(tmpdir(), "omp-agent-g3a-history-missing-"));
    try {
      expect(projectionCode(() => createHistoryProjectionReader({
        instanceRoot: missingRoot,
        instanceId: fixture.locator.instanceId,
        ownerId: fixture.locator.ownerId,
        workspaceRoot: WORKSPACE,
      }).list())).toBe("unavailable");
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }

    const conflictRoot = mkdtempSync(path.join(tmpdir(), "omp-agent-g3a-history-conflict-"));
    try {
      const conflictPath = path.join(conflictRoot, HISTORY_INDEX_FILE_NAME);
      const prior = Buffer.from("{\"unknown\":true}\n");
      writeFileSync(conflictPath, prior);
      const conflictWriter = createHistoryProjectionWriter({
        instanceRoot: conflictRoot,
        instanceId: "instance-conflict",
        ownerId: fixture.locator.ownerId,
        workspaceRoot: WORKSPACE,
      });
      expect(projectionCode(() => conflictWriter.capture(task))).toBe("conflict");
      expect(readFileSync(conflictPath).equals(prior)).toBe(true);
      const ownerMismatchRoot = mkdtempSync(path.join(tmpdir(), "omp-agent-g3a-history-owner-"));
      try {
        const wrongOwnerWriter = createHistoryProjectionWriter({
          instanceRoot: ownerMismatchRoot,
          instanceId: "instance-owner-mismatch",
          ownerId: "owner-other",
          workspaceRoot: WORKSPACE,
        });
        expect(projectionCode(() => wrongOwnerWriter.capture(task))).toBe("mismatch");
      } finally {
        rmSync(ownerMismatchRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(conflictRoot, { recursive: true, force: true });
    }
    fixture.cleanup();
  });

  test("rejects a divergent complete shared requirement prefix from real owner snapshots", () => {
    const instanceId = "instance-g3a-splice";
    const ownerId = "owner-g3a-splice";
    const left = makeFixture({ rootPrefix: "omp-agent-g3a-splice-left-", instanceId, ownerId });
    const right = makeFixture({ rootPrefix: "omp-agent-g3a-splice-right-", instanceId, ownerId });
    const original = "Shared original request.";
    const leftFirst = startTask(left, "user-1", original);
    left.writer.capture(leftFirst.task);
    const leftSecond = reviseTask(left, "user-2", "Left amendment X.");
    left.writer.capture(leftSecond.task);

    const rightFirst = startTask(right, "user-1", original);
    right.writer.capture(rightFirst.task);
    const rightSecond = reviseTask(right, "user-2", "Right amendment Y.");
    right.writer.capture(rightSecond.task);
    const rightThird = reviseTask(right, "user-3", "Right amendment Z.");
    right.writer.capture(rightThird.task);
    expect(rightThird.task.taskId).toBe(leftSecond.task.taskId);

    const leftIndexPath = path.join(left.root, HISTORY_INDEX_FILE_NAME);
    const beforeConflict = readFileSync(leftIndexPath);
    expect(projectionCode(() => left.writer.capture(rightThird.task))).toBe("conflict");
    expect(readFileSync(leftIndexPath).equals(beforeConflict)).toBe(true);

    const leftIndex = JSON.parse(beforeConflict.toString("utf8")) as HistoryIndex;
    const rightIndex = JSON.parse(readFileSync(path.join(right.root, HISTORY_INDEX_FILE_NAME), "utf8")) as HistoryIndex;
    const rightThirdItem = rightIndex.items[rightIndex.items.length - 1]!;
    leftIndex.items.push(rightThirdItem);
    writeFileSync(leftIndexPath, `${JSON.stringify(leftIndex, null, 2)}\n`);
    const corrupted = readFileSync(leftIndexPath);
    const reader = createHistoryProjectionReader(left.locator);
    expect(projectionCode(() => reader.list())).toBe("invalid");
    expect(readFileSync(leftIndexPath).equals(corrupted)).toBe(true);

    left.cleanup();
    right.cleanup();
  });

  test("enforces item count and file byte limits without eviction, and preserves bytes on write failure", () => {
    const countFixture = makeFixture({ rootPrefix: "omp-agent-g3a-count-" });
    for (let index = 0; index < 128; index += 1) {
      const result = countFixture.writer.capture(syntheticTask(countFixture.locator.ownerId, index, `Task ${index}.`));
      expect(result.status).toBe(index === 0 ? "created" : "appended");
    }
    const countBytes = indexBytes(countFixture);
    expect(projectionCode(() => countFixture.writer.capture(
      syntheticTask(countFixture.locator.ownerId, 128, "Too many."),
    ))).toBe("limit");
    expect(indexBytes(countFixture).equals(countBytes)).toBe(true);
    countFixture.cleanup();

    const sizeFixture = makeFixture({ rootPrefix: "omp-agent-g3a-size-" });
    const largeText = "x".repeat(60_000);
    let appended = 0;
    let sawSizeLimit = false;
    for (let index = 0; index < 40; index += 1) {
      const before = appended === 0 ? null : indexBytes(sizeFixture);
      try {
        sizeFixture.writer.capture(syntheticTask(sizeFixture.locator.ownerId, index, largeText));
        appended += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(HistoryProjectionError);
        expect((error as HistoryProjectionError).code).toBe("too-large");
        expect(indexBytes(sizeFixture).equals(before!)).toBe(true);
        sawSizeLimit = true;
        break;
      }
    }
    expect(sawSizeLimit).toBe(true);
    expect(appended).toBeGreaterThan(4);
    expect(indexBytes(sizeFixture).length).toBeLessThanOrEqual(HISTORY_FILE_BYTES_LIMIT);
    sizeFixture.cleanup();

    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const writeFixture = makeFixture({ rootPrefix: "omp-agent-g3a-write-failure-" });
    const realTask = startTask(writeFixture, "user-1", "Write failure fixture.").task;
    writeFixture.writer.capture(realTask);
    const prior = indexBytes(writeFixture);
    chmodSync(writeFixture.root, 0o500);
    try {
      expect(projectionCode(() => writeFixture.writer.capture(
        syntheticTask(writeFixture.locator.ownerId, 1, "Never published."),
      ))).toBe("write-failed");
      expect(indexBytes(writeFixture).equals(prior)).toBe(true);
    } finally {
      chmodSync(writeFixture.root, 0o700);
      writeFixture.cleanup();
    }
  });

  test("reports an unknown publication when the post-link read fails and refuses adoption on retry", () => {
    const probe = runProjectionFaultProbe("post-link");
    try {
      const expected = readFileSync(path.join(probe.root, "expected.json"));
      const publishedPath = path.join(probe.root, "post-link", HISTORY_INDEX_FILE_NAME);
      const published = readFileSync(publishedPath);
      const beforeRetry = readFileSync(path.join(probe.root, "before-retry.json"));

      expect(probe.report.control).toEqual({ status: "created" });
      // The child injected EIO only on the final-path lstat after a real link.
      expect(probe.report.postLinkInjectedFaults).toBeGreaterThan(0);
      expect(probe.report.capture).toMatchObject({ threw: true, code: "unknown" });
      expect(probe.report.capture.message).toMatch(/may have been published/i);
      expect(probe.report.presentAfterFailure).toBe(true);
      expect(published.equals(expected)).toBe(true);
      expect(beforeRetry.equals(expected)).toBe(true);
      expect(lstatSync(publishedPath).nlink).toBe(1);
      expect(probe.report.retry).toMatchObject({ threw: true, code: "conflict" });
      expect(probe.report.unchangedAfterRetry).toBe(true);
      expect(probe.report.presentAfterRetry).toBe(true);
      expect(probe.report.itemCountAfterRetry).toBe(1);
      expect(readFileSync(publishedPath).equals(expected)).toBe(true);
    } finally {
      probe.cleanup();
    }
  });

  test("loops injected short writes and keeps prior bytes when a replacement write fails", () => {
    const probe = runProjectionFaultProbe("short-writes");
    try {
      const expected = readFileSync(path.join(probe.root, "expected.json"));
      expect(expected.length).toBeGreaterThan(7);
      expect(probe.report.control).toEqual({ status: "created" });
      expect(probe.report.shortSuccess).toEqual({ status: "created" });
      expect(probe.report.shortSuccessWrites).toBeGreaterThan(1);
      expect(probe.report.shortSuccessItemCount).toBe(1);
      expect(readFileSync(path.join(probe.root, "short-success", HISTORY_INDEX_FILE_NAME)).equals(expected)).toBe(true);

      for (const variant of ["short-throw", "short-zero"]) {
        expect(probe.report[variant + "First"]).toEqual({ status: "created" });
        expect(probe.report[variant].threw).toBe(true);
        expect(probe.report[variant].code).toBe("write-failed");
        expect(probe.report[variant + "Writes"]).toBeGreaterThan(1);
        if (variant === "short-throw") {
          expect(probe.report[variant + "InjectedFaults"]).toBeGreaterThan(0);
        } else {
          expect(probe.report[variant + "ZeroReturns"]).toBeGreaterThan(0);
        }
        const prior = readFileSync(path.join(probe.root, `${variant}.prior.json`));
        expect(prior.equals(expected)).toBe(true);
        expect(probe.report[variant + "Preserved"]).toBe(true);
        expect(probe.report[variant + "Temporaries"]).toEqual([]);
        expect(probe.report[variant + "Retry"]).toEqual({ status: "appended" });
        expect(probe.report[variant + "ItemCountAfterRetry"]).toBe(2);
        expect(readFileSync(path.join(probe.root, variant, HISTORY_INDEX_FILE_NAME)).equals(prior)).toBe(false);
      }
    } finally {
      probe.cleanup();
    }
  });
});
