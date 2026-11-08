import { realpathSync } from "node:fs";
import path from "node:path";
import type { TaskOwner, TaskSubject } from "./task-owner.ts";

/**
 * Narrow OMP surface shared by the experimental entry and independently
 * registered test capabilities. Real OMP injects this structure; no runtime is
 * imported here.
 */
export interface OmpSessionManager {
  getSessionId(): string;
  getLeafId(): string | null;
  getBranch(): readonly unknown[];
}

export interface OmpToolContext {
  cwd: string;
  agent?: { kind?: "main" | "sub" };
  sessionManager?: OmpSessionManager;
  /** Optional host mode projection; human review additionally requires tui. */
  mode?: "tui" | "rpc" | "json" | "print";
  /** Optional host UI availability projection; require true for local review. */
  hasUI?: boolean;
}

/** OMP may report a symlinked temp cwd; compare both sides canonically. */
export function canonicalWorkspaceRoot(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

const PORT_KEY = Symbol.for("omp-agent.b1.task-owner.v1");

type PortHost = typeof globalThis & { [PORT_KEY]?: TaskOwner };

export function publishTaskOwner(owner: TaskOwner): void {
  (globalThis as PortHost)[PORT_KEY] = owner;
}

export function currentTaskOwner(): TaskOwner | undefined {
  return (globalThis as PortHost)[PORT_KEY];
}

export function clearPublishedTaskOwner(owner?: TaskOwner): void {
  const host = globalThis as PortHost;
  if (owner === undefined || host[PORT_KEY] === owner) delete host[PORT_KEY];
}

/** Build the owner subject from actual OMP session/branch state. */
export function subjectFromContext(context: OmpToolContext, workspaceRoot: string): TaskSubject {
  const manager = context.sessionManager;
  if (!manager) throw new Error("OMP session metadata is unavailable; task ownership cannot be proven.");
  const cwd = canonicalWorkspaceRoot(context.cwd);
  if (cwd !== workspaceRoot) throw new Error("Session workspace differs from the task owner workspace.");
  return {
    sessionId: manager.getSessionId(),
    workspaceRoot: cwd,
    agentKind: context.agent?.kind === "main" ? "main" : "sub",
    branch: manager.getBranch(),
  };
}
