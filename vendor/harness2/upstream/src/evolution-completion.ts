import { digest } from "./capabilities";
import { parseJsonResponse } from "./surface";
import { validateGraph } from "./task-graph";
import type { EvolutionState } from "./evolution";

export interface CompletionEvidence {
  schemaVersion: 1;
  source: "host";
  contractHash: string;
  graphRevision: number;
  graphHash: string;
  artifactHash: string;
  reviewAttemptId: string;
  reviewTraceHash: string;
  reviewResponseHash: string;
  validationAttemptId: string;
  validationTraceHash: string;
  validationResponseHash: string;
}
const HASH = /^[a-f0-9]{64}$/;
function verdict(text: string | undefined): "passed" | "failed" | "unknown" | undefined {
  if (typeof text !== "string") return;
  try {
    const v = parseJsonResponse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["verdict", "evidence", "limitations"].includes(k)) || typeof v.evidence !== "string" || !v.evidence.trim() || typeof v.limitations !== "string") return;
    if (v.verdict === "passed" || v.verdict === "failed" || v.verdict === "unknown") return v.verdict;
  } catch { /* Only complete strict JSON is eligible for the automatic path. */ }
}

/** Pure eligibility check. The caller must still check budgets, cancellation, policy and actual artifact/trace files. */
export function automaticCompletion(state: EvolutionState): CompletionEvidence | undefined {
  if (!state || state.contractHash !== digest(state.contract)) return;
  try { validateGraph(state.graph); } catch { return; }
  const graph = state.graph;
  if (!graph.nodes.length || graph.nodes.some(n => ["pending", "running", "unknown"].includes(n.status) || ["planner", "method-generator"].includes(n.id))) return;
  if (!state.attempts.length || state.attempts.some(a => ["running", "unknown"].includes(a.status) || !a.result || a.result.usageEstimated === true || !Number.isFinite(a.result.usage.costUsd) || a.result.usage.costUsd < 0 || !Number.isFinite(a.cost) || a.cost < 0 || Math.abs(a.cost - a.result.usage.costUsd) > 1e-8)) return;
  const review = state.attempts.at(-1)!;
  const reviewNode = graph.nodes.find(n => n.id === review.nodeId);
  if (reviewNode?.kind !== "review" || reviewNode.status !== "completed" || review.status !== "completed" || review.result!.status !== "completed" || !HASH.test(review.artifactHash ?? "") || !HASH.test(review.traceHash ?? "") || verdict(review.result!.text) !== "passed") return;
  const checks = state.attempts.filter(a => a.artifactHash === review.artifactHash && graph.nodes.some(n => n.id === a.nodeId && ["validate", "review"].includes(n.kind)));
  const validation = [...checks].reverse().find(a => graph.nodes.some(n => n.id === a.nodeId && n.kind === "validate"));
  if (!validation || validation.status !== "completed" || validation.result?.status !== "completed" || !HASH.test(validation.traceHash ?? "") || !graph.nodes.some(n => n.id === validation.nodeId && n.status === "completed")) return;
  const validationVerdict = verdict(validation.result.text);
  if (validationVerdict !== "passed" && validationVerdict !== "unknown") return;
  const validationNode = graph.nodes.find(n => n.id === validation.nodeId)!;
  if (!state.validations.some(v => v.id === validation.nodeId && v.targetHash === review.artifactHash && v.inputHash === review.artifactHash && v.validatorHash === digest({ goal: validationNode.goal, output: validationNode.output }) && v.evidence === validation.traceHash && v.independent === true && ["passed", "unknown"].includes(v.status))) return;
  return {
    schemaVersion: 1, source: "host", contractHash: state.contractHash,
    graphRevision: graph.revision, graphHash: digest(graph), artifactHash: review.artifactHash!,
    reviewAttemptId: review.id, reviewTraceHash: review.traceHash!, reviewResponseHash: digest(review.result!.text),
    validationAttemptId: validation.id, validationTraceHash: validation.traceHash!, validationResponseHash: digest(validation.result.text),
  };
}

/** Bind saved completion to its original task evidence; optional learning after delivery cannot revoke it. */
export function validateCompletionEvidence(state: EvolutionState, value: unknown): asserts value is CompletionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid adaptive completion evidence");
  const saved = value as CompletionEvidence;
  const index = state.attempts.findIndex(a => a.id === saved.reviewAttemptId);
  if (index < 0 || state.attempts.slice(index + 1).some(a => a.nodeId !== "method-generator")) throw new Error("Adaptive completion has later task/planning activity");
  const expected = automaticCompletion({ ...state, attempts: state.attempts.slice(0, index + 1) });
  if (!expected || Object.keys(saved).length !== Object.keys(expected).length || Object.entries(expected).some(([key, actual]) => saved[key as keyof CompletionEvidence] !== actual)) throw new Error("Adaptive completion evidence changed");
}
