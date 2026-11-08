import { createHash } from "node:crypto";

export type ApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";
export interface ExecutionProfile {
  kind: "omp-native";
  /** Explicit OMP tools policy, supplied by the host, never the planner. */
  tools: string[];
  approvalMode: ApprovalMode;
  approval: Record<string, "allow" | "deny" | "prompt">;
  source: string;
  allowGeneratedExtensions?: boolean;
}
export interface RuntimeManifest { profile: ExecutionProfile; policyHash: string; ompVersion: string; protocol: number; actualTools: string[] }
export interface ApprovalRequest {
  runId: string; taskId: string; workerId: string; callId: string; digest: string;
  method: "select" | "confirm"; title: string; message: string; options: string[];
}
export type ApprovalHandler = (request: ApprovalRequest, signal?: AbortSignal) => Promise<string | boolean | undefined>;
const NATIVE = new Set(["read", "grep", "glob", "bash", "write", "edit", "python"]);
export function validateExecutionProfile(value: ExecutionProfile): void {
  if (!value || Object.keys(value).some(k => !["kind", "tools", "approvalMode", "approval", "source", "allowGeneratedExtensions"].includes(k)) || (value.allowGeneratedExtensions !== undefined && typeof value.allowGeneratedExtensions !== "boolean") || value.kind !== "omp-native" || !Array.isArray(value.tools) || !value.tools.length ||
      value.tools.some(tool => !NATIVE.has(tool)) || new Set(value.tools).size !== value.tools.length ||
      !["always-ask", "always-ask-cached", "write", "yolo"].includes(value.approvalMode) ||
      !value.source?.trim() || !value.approval || typeof value.approval !== "object" || Array.isArray(value.approval) ||
      Object.values(value.approval).some(policy => !["allow", "deny", "prompt"].includes(policy))) throw new Error("Invalid explicit OMP execution profile");
}
export function policyHash(value: ExecutionProfile): string {
  validateExecutionProfile(value);
  return createHash("sha256").update(JSON.stringify({ ...value, tools: [...value.tools].sort(), approval: Object.fromEntries(Object.entries(value.approval).sort()) })).digest("hex");
}

/** Only forward interactive OMP decisions. Presentation and unfamiliar dialogs never authorize execution. */
export async function answerApproval(frame: Record<string, unknown>, identity: Pick<ApprovalRequest, "runId" | "taskId" | "workerId">,
  handler?: ApprovalHandler, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (typeof frame.id !== "string") throw new Error("Approval request lacks correlation ID");
  const cancelled = { type: "extension_ui_response", id: frame.id, cancelled: true };
  if (!handler || signal?.aborted || !["select", "confirm"].includes(String(frame.method))) return cancelled;
  const options = Array.isArray(frame.options) && frame.options.every(x => typeof x === "string") ? frame.options as string[] : [];
  const request = { ...identity, callId: frame.id, method: frame.method as "select" | "confirm", title: String(frame.title ?? "OMP approval"), message: String(frame.message ?? ""), options };
  const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const value = await handler({ ...request, digest }, signal);
  if (signal?.aborted) return cancelled;
  if (request.method === "confirm" && typeof value === "boolean") return { type: "extension_ui_response", id: frame.id, confirmed: value };
  if (request.method === "select" && typeof value === "string" && options.includes(value)) return { type: "extension_ui_response", id: frame.id, value };
  return cancelled;
}
