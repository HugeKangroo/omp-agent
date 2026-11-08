import { appendFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Read-only observation for package-entry loads.
 *
 * The owner port is imported from the selected product directory supplied by
 * the harness, never from a fixed checkout path. This observes the actual
 * product owner without registering tools, creating an owner or service,
 * binding a contract, seeding receipts, starting tasks or accepting results.
 */

const auditPath = process.env.PACKAGE_ENTRY_OBSERVER_AUDIT;
if (typeof auditPath !== "string" || !path.isAbsolute(auditPath)) {
  throw new Error("PACKAGE_ENTRY_OBSERVER_AUDIT must be an absolute path");
}
const portPath = process.env.PACKAGE_ENTRY_PORT_PATH;
if (typeof portPath !== "string" || !path.isAbsolute(portPath)) {
  throw new Error("PACKAGE_ENTRY_PORT_PATH must be an absolute path");
}
const productDir = process.env.PACKAGE_ENTRY_PRODUCT_DIR;
if (typeof productDir !== "string" || !path.isAbsolute(productDir)) {
  throw new Error("PACKAGE_ENTRY_PRODUCT_DIR must be an absolute path");
}

const portRealpath = realpathSync(portPath);
const productRealpath = realpathSync(productDir);
const withinProduct = path.relative(productRealpath, portRealpath);
if (withinProduct === ""
  || withinProduct.startsWith("..")
  || path.isAbsolute(withinProduct)) {
  throw new Error("PACKAGE_ENTRY_PORT_PATH is outside the selected product directory");
}

const port = await import(pathToFileURL(portRealpath).href);
if (typeof port.currentTaskOwner !== "function") {
  throw new Error("selected product task-entry-port.ts exports no currentTaskOwner");
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
  const owner = port.currentTaskOwner();
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

export default function packageEntryObserver(pi) {
  audit({
    type: "observer_startup",
    pid: process.pid,
    processCwd: process.cwd(),
    processCwdReal: safeRealpath(process.cwd()),
    productDir,
    productRealpath,
    portPath,
    portRealpath,
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
