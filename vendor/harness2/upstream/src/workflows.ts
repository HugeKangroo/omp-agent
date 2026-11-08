import { digest, type CapabilityRef } from "./capabilities";
import {
  METHODS,
  validateGraph,
  type MethodTemplate,
  type TaskGraph,
  type TaskNode,
} from "./task-graph";
export interface WorkflowDefinition {
  schemaVersion: 1;
  method: MethodTemplate;
  nodes: Omit<TaskNode, "status">[];
}
export function parseWorkflow(content: string): WorkflowDefinition {
  const value = JSON.parse(content) as WorkflowDefinition;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some(
      (k) => !["schemaVersion", "method", "nodes"].includes(k),
    ) ||
    !value.method ||
    typeof value.method.id !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.method.id) ||
    METHODS.some((m) => m.id === value.method.id)
  )
    throw new Error("Invalid generated workflow identity");
  const m = value.method;
  if (
    Object.keys(m).some(
      (k) =>
        !["id", "description", "steps", "checkpoints", "completion"].includes(
          k,
        ),
    ) ||
    typeof m.description !== "string" ||
    !m.description.trim() ||
    typeof m.completion !== "string" ||
    !m.completion.trim() ||
    ![m.steps, m.checkpoints].every(
      (a) =>
        Array.isArray(a) &&
        a.length <= 24 &&
        a.every((s) => typeof s === "string" && s.length <= 2000),
    )
  )
    throw new Error("Invalid generated method contract");
  if (
    !Array.isArray(value.nodes) ||
    !value.nodes.length ||
    value.nodes.some((n) => !n || "status" in n || n.kind === "develop")
  )
    throw new Error(
      "Reusable workflows cannot supply task states or recursively develop capabilities",
    );
  validateGraph({
    method: "direct",
    revision: 0,
    replans: 0,
    history: [],
    nodes: value.nodes.map((n) => ({ ...n, status: "pending" })),
  });
  if (
    !value.nodes.some((n) => n.kind === "validate") ||
    !value.nodes.some((n) => n.kind === "review")
  )
    throw new Error("Workflow requires validation and review");
  // Every branch must converge on a review; no unreviewed side branch may be appended later.
  const depended = new Set(value.nodes.flatMap((n) => n.dependencies));
  if (
    value.nodes
      .filter((n) => !depended.has(n.id))
      .some((n) => n.kind !== "review")
  )
    throw new Error("Workflow leaves must be reviews");
  return value;
}
export function workflowNodes(
  workflow: WorkflowDefinition,
  prefix: string,
  task: string,
  dependencies: string[] = [],
): TaskNode[] {
  const ids = new Map(workflow.nodes.map((n, i) => [n.id, `${prefix}_${i}`]));
  return workflow.nodes.map((n) => ({
    ...structuredClone(n),
    id: ids.get(n.id)!,
    goal: n.goal.replaceAll("{{task}}", task),
    output: n.output.replaceAll("{{task}}", task),
    dependencies: n.dependencies.length
      ? n.dependencies.map((d) => ids.get(d)!)
      : [...dependencies],
    status: "pending",
  }));
}
/** Host-owned expansion preserves completed nodes and does not consume a model replan. */
export function expandComposite(
  graph: TaskGraph,
  nodeId: string,
  ref: CapabilityRef,
  content: string,
  task: string,
): { graph: TaskGraph; childIds: string[] } {
  const next = structuredClone(graph);
  const node = next.nodes.find((n) => n.id === nodeId);
  if (node?.status !== "pending" || node.kind !== "execute")
    throw new Error("Composite expansion requires a pending execution task");
  const workflow = parseWorkflow(content);
  const children = workflowNodes(
    workflow,
    `c${digest({ nodeId, ref }).slice(0, 12)}`,
    task,
    node.dependencies,
  );
  const used = new Set(children.flatMap((n) => n.dependencies));
  node.dependencies = children.filter((n) => !used.has(n.id)).map((n) => n.id);
  node.capabilities = node.capabilities.filter(
    (c) => c.id !== ref.id || c.hash !== ref.hash,
  );
  node.goal = `Integrate completed composite results into the requested output. ${node.goal}`;
  next.nodes.push(...children);
  next.revision++;
  validateGraph(next);
  next.history.push({
    revision: next.revision,
    reason: `Expanded composite ${ref.id}@${ref.hash}`,
    hash: digest({ method: next.method, nodes: next.nodes }),
  });
  return { graph: next, childIds: children.map((n) => n.id) };
}
