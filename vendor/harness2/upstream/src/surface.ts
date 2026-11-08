import { createHash } from "node:crypto";
import type { HarnessBundle, HarnessSkill, Lesson } from "./types.ts";

export class ValidationError extends Error { override name = "ValidationError"; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || value.includes("\0") || (required && !value.trim())) {
    throw new ValidationError(`Invalid ${field}: expected ${required ? "non-empty " : ""}text up to ${limit} characters`);
  }
  return value;
}

/** Parse one JSON response, optionally surrounded by a single Markdown JSON fence. */
export function parseJsonResponse(response: string): unknown {
  if (Buffer.byteLength(response) > 100_000) throw new ValidationError("Structured response exceeds 100 KB");
  let body = response.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  if (fenced) body = fenced[1]!;
  try { return JSON.parse(body); } catch { throw new ValidationError("Expected a single JSON response without commentary"); }
}

export function makeHarness(value: unknown, parentId?: string): HarnessBundle {
  const v = object(value);
  const allowed = new Set(["schemaVersion", "id", "parentId", "promptAppend", "toolGuidance", "skills", "rationale"]);
  for (const key of Object.keys(v)) if (!allowed.has(key)) throw new ValidationError(`Unsupported harness field: ${key}`);
  const promptAppend = text(v.promptAppend, "promptAppend", 8_000);
  const toolGuidance = text(v.toolGuidance, "toolGuidance", 8_000);
  const rationale = text(v.rationale, "rationale", 4_000);
  if (!Array.isArray(v.skills) || v.skills.length > 8) throw new ValidationError("skills must contain at most 8 declarative skills");
  const names = new Set<string>();
  const skills: HarnessSkill[] = v.skills.map(raw => {
    const s = object(raw);
    if (Object.keys(s).some(k => !["name", "description", "content"].includes(k))) throw new ValidationError("Unsupported skill field");
    const name = text(s.name, "skill.name", 64, true);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || names.has(name)) throw new ValidationError("Skill names must be unique lowercase slugs");
    names.add(name);
    return { name, description: text(s.description, "skill.description", 512, true), content: text(s.content, "skill.content", 12_000, true) };
  });
  if (skills.reduce((n, s) => n + s.content.length + s.description.length, 0) > 32_000) throw new ValidationError("Total skill text exceeds 32,000 characters");
  const content = { promptAppend, toolGuidance, skills, rationale };
  const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { schemaVersion: 1, id, ...(parentId ? { parentId } : {}), ...content };
}

export function baseHarness(): HarnessBundle {
  return makeHarness({ promptAppend: "", toolGuidance: "", skills: [], rationale: "Fixed constrained OMP baseline; no learned task policy." });
}

export function parseHarness(response: string, parentId: string): HarnessBundle {
  return makeHarness(parseJsonResponse(response), parentId);
}

export function parseSelection(response: string): { winner: "baseline" | "final"; reason: string } {
  const v = object(parseJsonResponse(response));
  if (v.winner !== "baseline" && v.winner !== "final") throw new ValidationError("Selection must choose baseline or final");
  return { winner: v.winner, reason: text(v.reason, "selection reason", 4_000, true) };
}

export function parseLesson(response: string, stages: readonly string[], candidateStages?: readonly string[]): Lesson | undefined {
  const v = object(parseJsonResponse(response));
  if (v.noEntry === true && Object.keys(v).length === 1) return undefined;
  if (typeof v.confidence !== "string" || !["low", "medium", "high"].includes(v.confidence)) throw new ValidationError("Invalid lesson confidence");
  if (!Array.isArray(v.evidence) || v.evidence.length < 1 || v.evidence.length > 12 || v.evidence.some(e => typeof e !== "string" || !stages.includes(e))) {
    throw new ValidationError("Lesson evidence must reference completed stages");
  }
  const cited = new Set(v.evidence as string[]);
  if (candidateStages !== undefined) {
    if ([...cited].filter(id => candidateStages.includes(id)).length < 2) throw new ValidationError("A durable lesson requires two distinct candidate execution references");
  } else if (!cited.has("baseline") || !["inv_probe", "dom_probe", "final"].some(id => cited.has(id))) {
    throw new ValidationError("A durable lesson requires baseline and candidate execution evidence");
  }
  return {
    cue: text(v.cue, "cue", 1_000, true), lesson: text(v.lesson, "lesson", 2_000, true),
    evidence: v.evidence as string[], confidence: v.confidence as Lesson["confidence"],
    limitations: text(v.limitations, "limitations", 2_000, true),
  };
}
