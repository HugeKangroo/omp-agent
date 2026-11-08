import { parseJsonResponse } from "./surface";
import { parseWorkflow, type WorkflowDefinition } from "./workflows";
import type { TaskGraph } from "./task-graph";

/** Project host state into source material for an author; never normalize model output. */
export function methodAuthoringGraph(graph: TaskGraph) {
  return {
    method: graph.method,
    nodes: graph.nodes.map(({ id, kind, goal, dependencies, capabilities, output }) => ({
      id, kind, goal, dependencies: [...dependencies],
      capabilities: capabilities.map(({ id, hash }) => ({ id, hash })), output,
    })),
  };
}

/** Validate every model-provided field before publishing an automatically authored method. */
export function parseWorkflowProposal(text: string): { id: string; description: string; workflow: WorkflowDefinition } {
  const value = parseJsonResponse(text) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 || Object.keys(value).some(k => !["id", "description", "workflow"].includes(k)) ||
      typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) ||
      typeof value.description !== "string" || !value.description.trim() || value.description.includes("\0")) {
    throw new Error("Invalid workflow proposal: expected exactly id, description, workflow");
  }
  // parseWorkflow rejects runtime status and all other unsupported workflow/node fields.
  const workflow = parseWorkflow(JSON.stringify(value.workflow));
  return { id: value.id, description: value.description, workflow };
}
