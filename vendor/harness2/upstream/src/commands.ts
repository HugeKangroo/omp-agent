import type { CandidateId, ExecutionStrategy, ExplorationEvaluation, Mode, RunRecord } from "./types.ts";

export const HELP = `Harness² — inspect, explore, and review local task results

  /harness run <task> [--model provider/id] [--budget USD]
      [--improver-model provider/id] [--mode product|research] [--domain NAME]
      [--strategy auto|direct|explore|legacy|adaptive]
      [--max-minutes N] [--stage-minutes N] [--runtime-policy JSON_PATH] [--omp-agent-dir DIR]
  /harness status [run-id]
  /harness list
  /harness show <run-id>
  /harness cancel <run-id>
  /harness resume <run-id>
  /harness diff <run-id>
  /harness apply <run-id>
  /harness doctor

Product runs automatically choose a direct approach or compare distinct routes.
Strategy is optional; research uses legacy. Reviews report evidence and unknowns.
Runs use isolated file workspaces. Apply is a separate, explicit action.
Use -- before task text that contains literal flags. No shell expansion is performed.`;

export interface RunOptions {
  model?: string;
  improverModel?: string;
  budget?: number;
  mode?: Mode;
  strategy?: ExecutionStrategy;
  domain?: string;
  maxMinutes?: number;
  stageMinutes?: number;
  runtimePolicy?: string;
  ompAgentDir?: string;
}

export type HarnessCommand =
  | { kind: "help" | "list" | "doctor" }
  | { kind: "run"; task: string; options: RunOptions }
  | { kind: "status"; id?: string }
  | { kind: "show" | "cancel" | "resume" | "diff" | "apply"; id: string };

/** Shell-like quoting only. Deliberately never expands variables or executes text. */
export function tokenizeCommand(input: string): string[] {
  if (input.includes("\0")) throw new Error("Commands cannot contain NUL characters.");
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let active = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        token += input[++i];
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/u.test(char)) {
      if (active) tokens.push(token);
      token = "";
      active = false;
    } else if (char === "\\") {
      if (i + 1 >= input.length) throw new Error("Trailing escape in command.");
      token += input[++i];
      active = true;
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command.");
  if (active) tokens.push(token);
  return tokens;
}

function positiveNumber(value: string, flag: string, max: number): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) throw new Error(`${flag} requires a positive number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) {
    throw new Error(`${flag} must be greater than 0 and at most ${max}.`);
  }
  return number;
}

function identifier(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new Error("A valid run id is required.");
  }
  return value;
}

function model(value: string, flag: string): string {
  if (!value.trim() || value.length > 300 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${flag} requires a model identifier, such as provider/model.`);
  }
  return value;
}

export function parseCommand(args: string[]): HarnessCommand {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("Commands cannot contain NUL characters.");
  const [kind, ...rest] = args;
  if (kind === undefined || kind === "help" || kind === "--help" || kind === "-h") {
    if (rest.length) throw new Error("help takes no arguments.");
    return { kind: "help" };
  }
  if (kind === "list" || kind === "doctor") {
    if (rest.length) throw new Error(`${kind} takes no arguments.`);
    return { kind };
  }
  if (kind === "status") {
    if (rest.length > 1) throw new Error("status accepts at most one run id.");
    return { kind, ...(rest[0] === undefined ? {} : { id: identifier(rest[0]) }) };
  }
  if (["show", "cancel", "resume", "diff", "apply"].includes(kind)) {
    if (rest.length !== 1) throw new Error(`${kind} requires exactly one run id.`);
    return { kind: kind as "show" | "cancel" | "resume" | "diff" | "apply", id: identifier(rest[0]) };
  }
  if (kind !== "run") throw new Error(`Unknown command ${JSON.stringify(kind)}. Use /harness help.`);

  const options: RunOptions = {};
  const task: string[] = [];
  const seen = new Set<string>();
  let literal = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (literal) {
      task.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      task.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (!["--model", "--improver-model", "--budget", "--mode", "--strategy", "--domain", "--max-minutes", "--stage-minutes", "--runtime-policy", "--omp-agent-dir"].includes(flag)) {
      throw new Error(`Unknown option ${flag}. Use -- before literal task text.`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}.`);
    seen.add(flag);
    const value = equal === -1 ? rest[++index] : arg.slice(equal + 1);
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    switch (flag) {
      case "--omp-agent-dir": options.ompAgentDir = value; break;
      case "--runtime-policy": options.runtimePolicy = value; break;
      case "--model": options.model = model(value, flag); break;
      case "--improver-model": options.improverModel = model(value, flag); break;
      case "--budget": options.budget = positiveNumber(value, flag, 1000); break;
      case "--max-minutes": options.maxMinutes = positiveNumber(value, flag, 1440); break;
      case "--stage-minutes": options.stageMinutes = positiveNumber(value, flag, 1440); break;
      case "--mode":
        if (value !== "product" && value !== "research") throw new Error("--mode must be product or research.");
        options.mode = value;
        break;
      case "--strategy":
        if (value !== "auto" && value !== "direct" && value !== "explore" && value !== "legacy" && value !== "adaptive") throw new Error("--strategy must be auto, direct, explore, legacy or adaptive.");
        options.strategy = value;
        break;
      case "--domain":
        if (!value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("--domain requires a short printable name.");
        options.domain = value.trim();
        break;
    }
  }
  const text = task.join(" ").trim();
  if (!text) throw new Error("run requires a task.");
  if (text.length > 100_000) throw new Error("Task exceeds the 100,000 character limit.");
  if (options.mode === "research" && options.strategy !== undefined && options.strategy !== "legacy") throw new Error("Research mode requires --strategy legacy; omit --strategy to use it automatically.");
  return { kind: "run", task: text, options };
}

export function parseCommandText(input: string): HarnessCommand {
  return parseCommand(tokenizeCommand(input));
}

/** Strip terminal control characters from model/user-controlled display values. */
export function safeDisplay(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

function candidateLabel(record: RunRecord, id: CandidateId): string {
  const route = record.exploration?.plan.routes.find(route => route.id === id);
  if (route) return safeDisplay(route.name);
  if (id === "refine") {
    const parent = record.stages.refine?.parentStage;
    return parent && parent !== "refine" ? `refinement of ${candidateLabel(record, parent)}` : "refined result";
  }
  return id;
}

function evaluationMethod(evaluation: ExplorationEvaluation): string {
  return evaluation.method === "model_review" ? "model review of artifacts (no executed tests or performance measurements)" : "fallback (no validated model comparison)";
}

export function formatStatus(record: RunRecord): string {
  const stages = Object.values(record.stages);
  const active = stages.find((stage) => stage?.status === "running");
  const adaptiveObserved = record.evolution?.attempts.reduce((sum, a) => sum + (a.result?.usageEstimated ? 0 : a.result?.usage.costUsd ?? 0), 0) ?? 0;
  const adaptiveCharged = record.evolution?.attempts.reduce((sum, a) => sum + a.cost, 0) ?? 0;
  const cost = adaptiveObserved + stages.reduce((sum, stage) => sum + (stage?.observedCostUsd ?? (stage?.result?.usageEstimated ? 0 : stage?.result?.usage.costUsd ?? 0)), 0);
  const accountedCost = adaptiveCharged + stages.reduce((sum, stage) => sum + (stage?.accountedCostUsd ?? stage?.result?.usage.costUsd ?? 0), 0);
  const reservedCost = stages.reduce((sum, stage) => sum + (stage?.reservedCostUsd ?? 0), 0);
  const lines = [
    `Harness² ${record.id}: ${record.status}`,
    `${stages.filter((stage) => stage?.status === "completed").length} stages complete${active ? `; ${active.id} running` : ""}`,
    `Observed cost: $${cost.toFixed(4)} / $${record.config.maxCostUsd.toFixed(2)}`,
  ];
  if (accountedCost > cost || reservedCost > 0) lines.push(`Budget charged: $${accountedCost.toFixed(4)}; reserved: $${reservedCost.toFixed(4)}`);
  lines.push(`Strategy: ${record.config.strategy ?? "legacy"}`);
  if (record.evolution) {
    const e = record.evolution;
    lines.push(`Plan revision: ${e.graph.revision}; method: ${e.graph.method}; replans: ${e.graph.replans}/6`);
    if (e.activeMethod) lines.push(`Generated method: ${safeDisplay(e.activeMethod.id)}@${e.activeMethod.hash}`);
    if (e.expansions?.length) lines.push(`Composite expansions: ${e.expansions.length}`);
    lines.push(`Tasks: ${e.graph.nodes.filter(n => n.status === "completed").length}/${e.graph.nodes.length}; capabilities: ${e.frontier.length}`);
    lines.push(`Adaptive budget charged: $${e.attempts.reduce((sum, a) => sum + a.cost, 0).toFixed(4)}`);
    for (const n of e.graph.nodes) lines.push(`  ${safeDisplay(n.id)}: ${n.status} — ${safeDisplay(n.goal)}`);
  }
  if (record.exploration) {
    const { plan, review, selection } = record.exploration;
    lines.push(`Approach: ${plan.decision === "direct" ? "direct" : "explore distinct routes"} — ${safeDisplay(plan.reason)}`);
    if (plan.routes.length) lines.push(`Routes: ${plan.routes.map(route => safeDisplay(route.name)).join("; ")}`);
    const evaluation = selection ?? review;
    if (evaluation) {
      lines.push(`Evaluation: ${evaluationMethod(evaluation)}`);
      const unknowns = evaluation.assessments.reduce((count, assessment) => count + assessment.criteria.filter(criterion => criterion.verdict === "unknown").length, 0);
      if (unknowns) lines.push(`Unknown: ${unknowns} criterion assessments remain unverified.`);
      if (!record.selectionReason) lines.push(`${selection ? "Selection" : "Review"}: ${safeDisplay(evaluation.reason)}`);
      for (const limitation of evaluation.limitations) lines.push(`Limitation: ${safeDisplay(limitation)}`);
    }
  }
  if (record.winner) lines.push(`Selected result: ${candidateLabel(record, record.winner)}`);
  if (record.selectionReason) lines.push(`Selection: ${safeDisplay(record.selectionReason)}`);
  if (record.error) lines.push(`Error: ${safeDisplay(record.error)}`);
  for (const warning of record.warnings ?? []) lines.push(`Warning: ${safeDisplay(warning)}`);
  if (record.status === "completed") lines.push(`Preview /harness diff ${record.id}; apply /harness apply ${record.id}`);
  return lines.join("\n");
}

/** Shared human-readable inspection for the CLI and OMP command. */
export function formatShow(record: RunRecord): string {
  const lines = [formatStatus(record), `Model: ${record.config.model}`, `Mode: ${record.config.mode}`, `Task: ${safeDisplay(record.task)}`];
  if (record.winner) {
    const response = record.stages[record.winner]?.result?.text;
    if (response) lines.push("", "Selected response:", safeDisplay(response));
  }
  if (record.exploration) {
    const { plan, review, selection } = record.exploration;
    lines.push("", "Frozen criteria:", ...plan.criteria.map(criterion => `${safeDisplay(criterion.id)} [${criterion.kind}]: ${safeDisplay(criterion.description)}`));
    for (const route of plan.routes) {
      lines.push("", `Route: ${safeDisplay(route.name)}`, `Approach: ${safeDisplay(route.approach)}`);
      if (route.assumptions.length) lines.push(`Assumptions: ${route.assumptions.map(safeDisplay).join("; ")}`);
      if (route.tradeoffs.length) lines.push(`Tradeoffs: ${route.tradeoffs.map(safeDisplay).join("; ")}`);
    }
    for (const [name, evaluation] of [["Review", review], ["Final evaluation", selection]] as const) {
      if (!evaluation) continue;
      lines.push("", `${name}: ${evaluationMethod(evaluation)}`, `Reason: ${safeDisplay(evaluation.reason)}`);
      for (const assessment of evaluation.assessments) {
        lines.push(`Candidate: ${candidateLabel(record, assessment.candidate)}`);
        for (const criterion of assessment.criteria) lines.push(`  ${safeDisplay(criterion.criterionId)}: ${criterion.verdict} — ${safeDisplay(criterion.evidence)}`);
        if (assessment.strengths.length) lines.push(`  Strengths: ${assessment.strengths.map(safeDisplay).join("; ")}`);
        if (assessment.weaknesses.length) lines.push(`  Weaknesses: ${assessment.weaknesses.map(safeDisplay).join("; ")}`);
      }
      for (const limitation of evaluation.limitations) lines.push(`Limitation: ${safeDisplay(limitation)}`);
      if (evaluation.refinement) lines.push(`Suggested refinement of ${candidateLabel(record, evaluation.refinement.candidate)}: ${safeDisplay(evaluation.refinement.instructions)}`);
    }
  }
  return lines.join("\n");
}
