import { appendFileSync, realpathSync } from "node:fs";
import { currentTaskOwner } from "../../src/task-entry-port.ts";

/**
 * Read-only observation for the B3-B2 daily native fixture.
 *
 * It records actual process/session cwd facts, the published owner snapshot
 * and completed tool results. It never registers tools, creates an owner or
 * service, binds a contract, seeds receipts, starts tasks, accepts, changes a
 * result, or reads disk state to choose a model selector.
 */

const auditPath = process.env.DAILY_OBSERVER_AUDIT;
if (typeof auditPath !== "string" || !auditPath.startsWith("/")) {
  throw new Error("DAILY_OBSERVER_AUDIT must be an absolute path");
}

const MAX_BYTES = 8 * 1024 * 1024;
let bytes = 0;
let sequence = 0;

const contentText = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");

function safeRealpath(value) {
  try {
    return typeof value === "string" ? realpathSync(value) : null;
  } catch {
    return null;
  }
}

function ownerFacts() {
  const owner = currentTaskOwner();
  if (!owner) return null;
  const snapshot = owner.snapshot();
  return {
    ownerId: snapshot.ownerId,
    tasksCreated: snapshot.tasksCreated,
    binding: snapshot.binding,
    currentTask: snapshot.currentTask === null ? null : {
      taskId: snapshot.currentTask.taskId,
      taskRevision: snapshot.currentTask.taskRevision,
      status: snapshot.currentTask.status,
      acceptance: snapshot.currentTask.acceptance,
    },
    acceptanceHazard: snapshot.acceptanceHazard === null ? null : {
      taskId: snapshot.acceptanceHazard.task.taskId,
      acceptanceId: snapshot.acceptanceHazard.acceptanceId,
    },
  };
}

function cwdFacts(context) {
  const cwd = context?.cwd;
  return {
    cwd: typeof cwd === "string" ? cwd : null,
    cwdReal: safeRealpath(cwd),
  };
}

function audit(value) {
  if (bytes >= MAX_BYTES) return;
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), sequence: sequence++, ...value })}\n`;
  bytes += Buffer.byteLength(line, "utf8");
  appendFileSync(auditPath, line);
}

export default function dailyObserver(pi) {
  audit({
    type: "observer_startup",
    pid: process.pid,
    processCwd: process.cwd(),
    processCwdReal: safeRealpath(process.cwd()),
    owner: ownerFacts(),
  });

  pi.on("session_start", (_event, context) => {
    audit({ type: "session_start", ...cwdFacts(context), owner: ownerFacts() });
    return undefined;
  });

  pi.on("agent_start", (_event, context) => {
    audit({ type: "agent_start", ...cwdFacts(context), owner: ownerFacts() });
    return undefined;
  });

  pi.on("tool_result", (event, context) => {
    audit({
      type: "tool_result",
      toolCallId: event.toolCallId ?? null,
      toolName: event.toolName ?? null,
      input: event.input ?? null,
      isError: event.isError ?? null,
      content: contentText(event.content).slice(0, 64000),
      ...cwdFacts(context),
      owner: ownerFacts(),
    });
    return undefined;
  });

  pi.on("agent_end", (_event, context) => {
    audit({ type: "agent_end", ...cwdFacts(context), owner: ownerFacts() });
    return undefined;
  });

  pi.on("session_shutdown", (_event, context) => {
    audit({ type: "session_shutdown", ...cwdFacts(context), owner: ownerFacts() });
    return undefined;
  });
}
