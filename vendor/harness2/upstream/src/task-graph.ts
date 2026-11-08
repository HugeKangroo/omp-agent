import { digest, type CapabilityRef } from "./capabilities";
export const LIMITS = Object.freeze({ tasks: 24, replans: 6, developments: 3, repairs: 2, depth: 3 });
export interface MethodTemplate {
  id: string; description: string; steps: string[]; checkpoints: string[]; completion: string;
}
export const METHODS: readonly MethodTemplate[] = Object.freeze([
  { id: "direct", description: "Direct local delivery", steps: ["execute", "validate", "review"], checkpoints: ["validation_failed"], completion: "Review the artifact against the frozen task contract" },
  { id: "investigate-repair", description: "Investigate and repair", steps: ["investigate", "execute", "validate", "review"], checkpoints: ["task_failed", "validation_failed", "new_evidence"], completion: "Repair demonstrated against the task contract" },
  { id: "hypothesis-experiment", description: "Compare hypotheses using independent candidates", steps: ["investigate", "execute", "validate", "review"], checkpoints: ["new_evidence", "validation_failed"], completion: "Compare evidence and retain limitations" },
]);
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
export interface TaskNode {
  id: string; kind: "investigate" | "execute" | "validate" | "develop" | "review";
  goal: string; dependencies: string[]; capabilities: CapabilityRef[]; output: string;
  developKind?: "script" | "extension" | "composite" | "method";
  status: TaskStatus;
}
export interface TaskGraph { method: string; revision: number; nodes: TaskNode[]; history: Array<{ revision: number; reason: string; hash: string }>; replans: number }
export interface PlanPatch {
  reason: string; method?: string; useMethod?: CapabilityRef; add?: Omit<TaskNode, "status">[];
  revise?: Array<{ id: string; goal: string; output: string; capabilities: CapabilityRef[] }>;
  cancel?: string[]; finish?: boolean;
}
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: string[], label: string): void {
  check(Object.keys(value).every(k => allowed.includes(k)), `Unsupported ${label} field(s): ${Object.keys(value).filter(k => !allowed.includes(k)).join(", ")}. Allowed: ${allowed.join(", ")}`);
}
function capability(value: unknown): asserts value is CapabilityRef {
  check(record(value) && typeof value.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.id) && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash), "Invalid capability reference: expected id and immutable hash");
  fields(value, ["id", "hash"], "capability reference");
}
function taskContent(value: Record<string, unknown>): void {
  check(typeof value.goal === "string" && !!value.goal.trim() && value.goal.length <= 8000 && typeof value.output === "string" && !!value.output.trim() && value.output.length <= 2000, "Task requires bounded goal and output contract");
  check(Array.isArray(value.capabilities) && value.capabilities.length <= 24, "Invalid capability references: capabilities is required; use [] when no capabilities are selected");
  value.capabilities.forEach(capability);
}
function taskDefinition(value: unknown, persisted: boolean): void {
  check(record(value), "Invalid task: expected an object");
  if (!persisted) check(!("status" in value), "Planner cannot set task status");
  fields(value, ["id", "kind", "goal", "dependencies", "capabilities", "output", "developKind", ...(persisted ? ["status"] : [])], "task");
  check(typeof value.id === "string" && ID.test(value.id) && typeof value.kind === "string" && ["investigate", "execute", "validate", "develop", "review"].includes(value.kind), "Invalid task identity/kind");
  if (persisted) check(typeof value.status === "string" && ["pending", "running", "completed", "failed", "cancelled", "unknown"].includes(value.status), "Invalid task state");
  taskContent(value);
  check(value.developKind === undefined || value.kind === "develop" && typeof value.developKind === "string" && ["script", "extension", "composite", "method"].includes(value.developKind), "Invalid development kind: developKind is only allowed on develop tasks");
  check(Array.isArray(value.dependencies) && value.dependencies.length <= LIMITS.tasks && value.dependencies.every(d => typeof d === "string" && ID.test(d)) && new Set(value.dependencies).size === value.dependencies.length, "Invalid task dependencies");
}
/** Validate model data before policy code dereferences it. No coercion or automatic graph repair. */
export function validatePlanPatch(value: unknown): asserts value is PlanPatch {
  check(record(value) && typeof value.reason === "string" && !!value.reason.trim() && value.reason.length <= 4000, "Invalid plan patch: bounded reason is required");
  fields(value, ["reason", "method", "useMethod", "add", "revise", "cancel", "finish"], "plan patch");
  check(value.method === undefined || METHODS.some(m => m.id === value.method), "Invalid plan method");
  check(value.finish === undefined || typeof value.finish === "boolean", "Invalid finish decision: expected boolean");
  const touched = new Set<string>();
  const touch = (id: string) => { check(!touched.has(id), `Conflicting task mutations for ${id}`); touched.add(id); };
  if (value.add !== undefined) {
    check(Array.isArray(value.add) && value.add.length <= LIMITS.tasks, "Invalid task additions or task limit exceeded");
    for (const n of value.add) { taskDefinition(n, false); touch(n.id); }
  }
  if (value.revise !== undefined) {
    check(Array.isArray(value.revise) && value.revise.length <= LIMITS.tasks, "Invalid task revisions");
    for (const n of value.revise) {
      check(record(n) && typeof n.id === "string" && ID.test(n.id), "Invalid task revision");
      fields(n, ["id", "goal", "output", "capabilities"], "task revision");
      taskContent(n); touch(n.id);
    }
  }
  if (value.cancel !== undefined) {
    check(Array.isArray(value.cancel) && value.cancel.length <= LIMITS.tasks && value.cancel.every(id => typeof id === "string" && ID.test(id)), "Invalid task cancellation IDs");
    for (const id of value.cancel) touch(id);
  }
  if (value.useMethod !== undefined) {
    capability(value.useMethod);
    check(Object.keys(value).every(k => ["reason", "useMethod"].includes(k)), "Method instantiation cannot include other decisions");
  }
  if (value.finish === true) check(touched.size === 0, "Finish cannot include task mutations; submit a separate patch with reason and cancel/add/revise first, omitting finish, then request finish at the next checkpoint");
}
export function validateGraph(graph: TaskGraph): void {
  check(graph && METHODS.some(m => m.id === graph.method) && Number.isSafeInteger(graph.revision) && graph.revision >= 0 && Number.isSafeInteger(graph.replans) && graph.replans >= 0 && graph.replans <= LIMITS.replans && Array.isArray(graph.history), "Invalid graph metadata");
  check(Array.isArray(graph.nodes) && graph.nodes.length <= LIMITS.tasks, "Task limit exceeded");
  for (const node of graph.nodes) taskDefinition(node, true);
  const ids = new Set(graph.nodes.map(n => n.id)); check(ids.size === graph.nodes.length, "Duplicate task ID");
  check(graph.nodes.filter(n => n.kind === "develop").length <= LIMITS.developments, "Capability development limit exceeded");
  for (const node of graph.nodes) check(node.dependencies.every(d => ids.has(d)), "Missing dependency");
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (id: string) => { check(!visiting.has(id), "Task dependency cycle"); if (visited.has(id)) return; visiting.add(id); graph.nodes.find(n => n.id === id)!.dependencies.forEach(visit); visiting.delete(id); visited.add(id); };
  graph.nodes.forEach(n => visit(n.id));
}
export function patchGraph(graph: TaskGraph, patch: PlanPatch): TaskGraph {
  validateGraph(graph);
  validatePlanPatch(patch);
  check(!patch.finish && patch.useMethod === undefined, "Finish and method instantiation require controller validation");
  check(graph.revision === 0 || graph.replans < LIMITS.replans, "Replanning limit exceeded");
  const next = structuredClone(graph);
  if (patch.method !== undefined) next.method = patch.method;
  for (const n of patch.add ?? []) next.nodes.push({ ...structuredClone(n), status: "pending" });
  for (const n of patch.revise ?? []) {
    const old = next.nodes.find(x => x.id === n.id); check(old?.status === "pending", `Only pending tasks can change: ${n.id} is ${old?.status ?? "missing"}; append new tasks to retry completed or failed work`); Object.assign(old, structuredClone(n));
  }
  for (const id of patch.cancel ?? []) { const node = next.nodes.find(n => n.id === id); check(node?.status === "pending", `Only pending tasks can be cancelled: ${id} is ${node?.status ?? "missing"}`); node.status = "cancelled"; }
  next.revision++; if (graph.revision) next.replans++;
  validateGraph(next);
  next.history.push({ revision: next.revision, reason: patch.reason, hash: digest({ method: next.method, nodes: next.nodes }) });
  return next;
}
export function readyTask(graph: TaskGraph): TaskNode | undefined {
  validateGraph(graph);
  return graph.nodes.find(n => n.status === "pending" && n.dependencies.every(id => graph.nodes.find(d => d.id === id)?.status === "completed"));
}
