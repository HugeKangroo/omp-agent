import { parseJsonResponse, ValidationError } from "./surface.ts";
import { CANDIDATE_IDS, type CandidateId, type ExplorationEvaluation, type ExplorationPlan } from "./types.ts";

const CANDIDATES = new Set<string>(CANDIDATE_IDS);
const ROUTES = ["route_1", "route_2", "route_3"] as const;
const MAX_CRITERIA = 12;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}
function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  const result = value as Record<string, unknown>;
  check(Object.keys(result).every(key => fields.includes(key)), `Unsupported ${name} field`);
  return result;
}
function text(value: unknown, name: string, limit: number): asserts value is string {
  check(typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0"), `${name} must contain 1–${limit} characters`);
}
function texts(value: unknown, name: string, count = 8): asserts value is string[] {
  check(Array.isArray(value) && value.length <= count, `${name} must contain at most ${count} strings`);
  value.forEach(item => text(item, name, 1_000));
}
function normalized(value: string): string { return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " "); }
function unique(values: string[], name: string): void {
  check(new Set(values.map(normalized)).size === values.length, `${name} must be unique after normalization`);
}
function bounded(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new ValidationError("Exploration data must be JSON serializable"); }
  check(encoded !== undefined && Buffer.byteLength(encoded) <= 100_000, "Exploration data exceeds 100 KB");
}
function candidate(value: unknown): asserts value is CandidateId {
  check(typeof value === "string" && CANDIDATES.has(value), "Unknown exploration candidate");
}

export function validateExplorationPlan(value: unknown): asserts value is ExplorationPlan {
  bounded(value);
  const plan = object(value, ["decision", "reason", "criteria", "routes"], "exploration plan");
  check(plan.decision === "direct" || plan.decision === "explore", "Plan decision must be direct or explore");
  text(plan.reason, "Plan reason", 4_000);
  check(Array.isArray(plan.criteria) && plan.criteria.length >= 1 && plan.criteria.length <= MAX_CRITERIA, `Plan requires 1–${MAX_CRITERIA} criteria`);
  const criterionIds: string[] = [];
  const descriptions: string[] = [];
  for (const raw of plan.criteria) {
    const criterion = object(raw, ["id", "description", "kind"], "criterion");
    text(criterion.id, "Criterion id", 64);
    check(/^[a-z][a-z0-9_-]*$/.test(criterion.id), "Criterion ids must be lowercase ASCII identifiers");
    text(criterion.description, "Criterion description", 2_000);
    check(criterion.kind === "requirement" || criterion.kind === "quality", "Invalid criterion kind");
    criterionIds.push(criterion.id); descriptions.push(criterion.description);
  }
  unique(criterionIds, "Criterion ids"); unique(descriptions, "Criterion descriptions");
  check(Array.isArray(plan.routes), "Plan routes must be an array");
  check(plan.decision === "direct" ? plan.routes.length === 0 : plan.routes.length >= 2 && plan.routes.length <= 3, "Direct plans require no routes; exploration requires two or three routes");
  const names: string[] = [];
  const approaches: string[] = [];
  plan.routes.forEach((raw, index) => {
    const route = object(raw, ["id", "name", "approach", "assumptions", "tradeoffs"], "route");
    check(route.id === ROUTES[index], "Route ids must be consecutive route_1, route_2, route_3");
    text(route.name, "Route name", 160); text(route.approach, "Route approach", 4_000);
    texts(route.assumptions, "Route assumptions"); texts(route.tradeoffs, "Route tradeoffs");
    names.push(route.name); approaches.push(route.approach);
  });
  unique(names, "Route names"); unique(approaches, "Route approaches");
}

export function directPlan(reason: string): ExplorationPlan {
  const plan: ExplorationPlan = { decision: "direct", reason,
    criteria: [{ id: "task", description: "Fulfill the requested task and its explicit constraints.", kind: "requirement" }], routes: [] };
  validateExplorationPlan(plan);
  return plan;
}

export function parseExplorationPlan(response: string, strategy: "auto" | "direct" | "explore"): ExplorationPlan {
  check(strategy === "auto" || strategy === "direct" || strategy === "explore", "Invalid exploration strategy");
  const plan = parseJsonResponse(response);
  validateExplorationPlan(plan);
  check(strategy === "auto" || plan.decision === strategy, `Plan must respect the explicit ${strategy} strategy`);
  return plan;
}

export function validateExplorationEvaluation(value: unknown, plan: ExplorationPlan, candidates?: CandidateId[]): asserts value is ExplorationEvaluation {
  validateExplorationPlan(plan);
  bounded(value);
  const evaluation = object(value, ["method", "assessments", "winner", "reason", "limitations", "refinement"], "exploration evaluation");
  check(evaluation.method === "model_review" || evaluation.method === "fallback", "Invalid evaluation method");
  text(evaluation.reason, "Evaluation reason", 4_000); texts(evaluation.limitations, "Evaluation limitations", 12);
  check(Array.isArray(evaluation.assessments) && evaluation.assessments.length >= 1 && evaluation.assessments.length <= CANDIDATE_IDS.length, "Evaluation requires one assessment per candidate");
  const seen = new Set<CandidateId>();
  const eligible = new Set<CandidateId>();
  const criterionIds = new Set(plan.criteria.map(item => item.id));
  const requirements = new Set(plan.criteria.filter(item => item.kind === "requirement").map(item => item.id));
  for (const raw of evaluation.assessments) {
    const assessment = object(raw, ["candidate", "criteria", "strengths", "weaknesses"], "assessment");
    candidate(assessment.candidate);
    check(!seen.has(assessment.candidate), "Duplicate candidate assessment"); seen.add(assessment.candidate);
    texts(assessment.strengths, "Candidate strengths", 12); texts(assessment.weaknesses, "Candidate weaknesses", 12);
    check(Array.isArray(assessment.criteria) && assessment.criteria.length === plan.criteria.length, "Every plan criterion must be assessed exactly once");
    const assessed = new Set<string>();
    let disqualified = false;
    for (const rawCriterion of assessment.criteria) {
      const criterion = object(rawCriterion, ["criterionId", "verdict", "evidence"], "criterion assessment");
      check(typeof criterion.criterionId === "string" && criterionIds.has(criterion.criterionId) && !assessed.has(criterion.criterionId), "Unknown or duplicate assessed criterion");
      assessed.add(criterion.criterionId);
      check(criterion.verdict === "met" || criterion.verdict === "not_met" || criterion.verdict === "unknown", "Invalid criterion verdict");
      text(criterion.evidence, "Criterion evidence", 2_000);
      if (requirements.has(criterion.criterionId) && criterion.verdict === "not_met") disqualified = true;
      if (evaluation.method === "fallback") check(criterion.verdict === "unknown", "Fallback assessments must report unknown verdicts");
    }
    if (!disqualified) eligible.add(assessment.candidate);
  }
  if (candidates !== undefined) {
    check(Array.isArray(candidates) && candidates.length >= 1 && candidates.length <= CANDIDATE_IDS.length, "Invalid evaluated candidate set");
    candidates.forEach(candidate);
    check(new Set(candidates).size === candidates.length && candidates.length === seen.size && candidates.every(id => seen.has(id)), "Every candidate must be assessed exactly once");
  }
  if (evaluation.winner === null) check(eligible.size === 0, "A null winner is permitted only when all candidates violate requirements");
  else {
    candidate(evaluation.winner);
    check(eligible.has(evaluation.winner), "Winner must be assessed and must not violate a requirement");
  }
  if (evaluation.refinement !== undefined) {
    check(evaluation.method === "model_review", "Fallback evaluations cannot request refinement");
    const refinement = object(evaluation.refinement, ["candidate", "instructions"], "refinement");
    candidate(refinement.candidate);
    check(refinement.candidate === evaluation.winner && eligible.has(refinement.candidate), "Refinement must target the eligible winner");
    text(refinement.instructions, "Refinement instructions", 8_000);
  }
}

export function parseExplorationEvaluation(response: string, plan: ExplorationPlan, labels: Record<string, CandidateId>, allowRefinement: boolean): ExplorationEvaluation {
  check(labels !== null && typeof labels === "object" && !Array.isArray(labels), "Candidate labels must be an object");
  const candidates = Object.values(labels);
  check(candidates.length >= 1 && candidates.length <= CANDIDATE_IDS.length && new Set(candidates).size === candidates.length, "Candidate labels must map uniquely to candidates");
  candidates.forEach(candidate);
  Object.keys(labels).forEach(label => text(label, "Candidate label", 64));
  const resolveLabel = (value: unknown): CandidateId => {
    check(typeof value === "string" && Object.hasOwn(labels, value), "Evaluation referenced an unknown candidate label");
    return labels[value]!;
  };
  const raw = object(parseJsonResponse(response), ["assessments", "winner", "reason", "limitations", "refinement"], "model evaluation");
  check(Array.isArray(raw.assessments), "Evaluation assessments must be an array");
  check(allowRefinement || raw.refinement === undefined, "Refinement is unavailable in this evaluation");
  const evaluation = { ...raw, method: "model_review", winner: raw.winner === null ? null : resolveLabel(raw.winner),
    assessments: raw.assessments.map(value => {
      const assessment = object(value, ["candidate", "criteria", "strengths", "weaknesses"], "assessment");
      return { ...assessment, candidate: resolveLabel(assessment.candidate) };
    }),
    ...(raw.refinement === undefined ? {} : (() => {
      const refinement = object(raw.refinement, ["candidate", "instructions"], "refinement");
      return { refinement: { ...refinement, candidate: resolveLabel(refinement.candidate) } };
    })()),
  };
  validateExplorationEvaluation(evaluation, plan, candidates);
  return evaluation;
}

export function fallbackEvaluation(plan: ExplorationPlan, candidates: CandidateId[], preferred: CandidateId, reason: string): ExplorationEvaluation {
  check(candidates.includes(preferred), "Fallback winner must be an evaluated candidate");
  const evaluation: ExplorationEvaluation = { method: "fallback", assessments: candidates.map(id => ({ candidate: id,
    criteria: plan.criteria.map(criterion => ({ criterionId: criterion.id, verdict: "unknown", evidence: "No trustworthy comparative assessment is available." })),
    strengths: [], weaknesses: [],
  })), winner: preferred, reason, limitations: ["Fallback selection does not establish correctness or comparative quality."] };
  validateExplorationEvaluation(evaluation, plan, candidates);
  return evaluation;
}
