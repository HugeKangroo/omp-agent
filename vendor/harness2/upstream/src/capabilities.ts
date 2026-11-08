import { parseWorkflow } from "./workflows";
import { parseGeneratedExtension } from "./generated-extension";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { atomicWrite, readRegular, withWriteLock } from "./store";

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CapabilityRef { id: string; hash: string }
export interface ValidationResult {
  id: string; targetHash: string; validatorHash: string; inputHash: string;
  status: "passed" | "failed" | "unknown"; evidence: string; independent: boolean;
}
export interface CapabilityManifest {
  schemaVersion: 1; id: string; kind: "skill" | "script" | "composite" | "extension" | "method";
  description: string; tags: string[]; input: string; output: string;
  dependencies: CapabilityRef[]; tools: string[]; platforms: string[];
  content: string; sourceRun: string; limitations: string;
}
export interface CapabilityVersion extends CapabilityManifest { hash: string }
export interface CapabilityState {
  status: "draft" | "validated" | "reusable" | "deprecated"; disabled: boolean;
  validations: ValidationResult[]; outcomes: Array<{ runId: string; success: boolean; evidence: string }>;
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function validateCapability(m: CapabilityManifest): void {
  check(m && m.schemaVersion === 1 && typeof m.id === "string" && ID.test(m.id) && ["skill", "script", "composite", "extension", "method"].includes(m.kind), "Invalid capability identity");
  for (const key of ["description", "input", "output", "content", "sourceRun", "limitations"] as const) check(typeof m[key] === "string" && m[key].length <= 100_000 && !m[key].includes("\0"), `Invalid capability ${key}`);
  check(m.description.trim() && m.content.trim() && typeof m.sourceRun === "string" && ID.test(m.sourceRun), "Capability requires content and source");
  for (const list of [m.tags, m.tools, m.platforms]) check(Array.isArray(list) && list.length <= 32 && list.every(x => typeof x === "string" && x.length <= 128), "Invalid capability metadata");
  check(Array.isArray(m.dependencies) && m.dependencies.length <= 24 && m.dependencies.every(d => d && typeof d.id === "string" && typeof d.hash === "string" && ID.test(d.id) && HASH.test(d.hash)), "Invalid capability dependencies");
  if (m.kind === "method" || m.kind === "composite") {
    const workflow = parseWorkflow(m.content);
    check(workflow.nodes.flatMap(n => n.capabilities).every(c => m.dependencies.some(d => d.id === c.id && d.hash === c.hash)), "Workflow uses an undeclared capability dependency");
  }
  if (m.kind === "extension") parseGeneratedExtension(m.content);
  check(Object.keys(m).every(k => ["schemaVersion", "id", "kind", "description", "tags", "input", "output", "dependencies", "tools", "platforms", "content", "sourceRun", "limitations"].includes(k)), "Unsupported capability field");
}
function key(ref: CapabilityRef): string { check(typeof ref.id === "string" && typeof ref.hash === "string" && ID.test(ref.id) && HASH.test(ref.hash), "Invalid capability reference"); return `${ref.id}-${ref.hash}`; }
function validateEvidence(result: ValidationResult, hash: string): void {
  check(result && typeof result.id === "string" && ID.test(result.id) && result.targetHash === hash && typeof result.validatorHash === "string" && HASH.test(result.validatorHash) && typeof result.inputHash === "string" && HASH.test(result.inputHash) && ["passed", "failed", "unknown"].includes(result.status) && typeof result.independent === "boolean" && typeof result.evidence === "string" && !!result.evidence.trim(), "Invalid validation evidence");
}
const initial = (): CapabilityState => ({ status: "draft", disabled: false, validations: [], outcomes: [] });
/** Immutable content and mutable lifecycle are kept separately, under one cross-process store lock. */
export class CapabilityRegistry {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async add(manifest: CapabilityManifest): Promise<CapabilityVersion> {
    validateCapability(manifest);
    const hash = digest(manifest); const version = { ...manifest, hash };
    await withWriteLock(this.root, async () => {
      const file = join(this.root, `${key(version)}.json`);
      const old = await readRegular(file);
      if (old !== undefined && old !== JSON.stringify(version)) throw new Error("Capability content conflict");
      if (old === undefined) await atomicWrite(file, JSON.stringify(version));
    });
    return structuredClone(version);
  }
  async inspect(ref: CapabilityRef): Promise<{ version: CapabilityVersion; state: CapabilityState }> {
    const raw = await readRegular(join(this.root, `${key(ref)}.json`));
    check(raw, "Capability not found"); const { hash, ...manifest } = JSON.parse(raw) as CapabilityVersion;
    validateCapability(manifest); check(hash === ref.hash && manifest.id === ref.id && digest(manifest) === hash, "Capability content changed");
    const stateRaw = await readRegular(join(this.root, `${key(ref)}.state.json`));
    const state: CapabilityState = stateRaw ? JSON.parse(stateRaw) : initial();
    check(["draft", "validated", "reusable", "deprecated"].includes(state.status) && typeof state.disabled === "boolean" && Array.isArray(state.validations) && Array.isArray(state.outcomes), "Invalid capability lifecycle");
    state.validations.forEach(v => validateEvidence(v, hash));
    check(state.outcomes.every(o => o && typeof o.runId === "string" && ID.test(o.runId) && typeof o.success === "boolean" && typeof o.evidence === "string" && !!o.evidence.trim()), "Invalid capability outcomes");
    return { version: { ...manifest, hash }, state };
  }
  private async update(ref: CapabilityRef, action: (state: CapabilityState) => void): Promise<void> {
    await withWriteLock(this.root, async () => {
      const { state } = await this.inspect(ref); action(state);
      await atomicWrite(join(this.root, `${key(ref)}.state.json`), JSON.stringify(state));
    });
  }
  async recordValidation(ref: CapabilityRef, result: ValidationResult): Promise<void> {
    validateEvidence(result, ref.hash);
    await this.update(ref, state => {
      const prior = state.validations.find(v => v.id === result.id);
      check(!prior || digest(prior) === digest(result), "Validation ID conflict");
      if (!prior) state.validations.push(structuredClone(result));
      if (state.status === "draft" && result.status === "passed") state.status = "validated";
    });
  }
  async promote(ref: CapabilityRef): Promise<void> {
    await this.update(ref, state => {
      const passed = state.validations.filter(v => v.status === "passed" && v.targetHash === ref.hash);
      check(!state.disabled && state.status === "validated" && passed.some(v => v.independent && passed.some(other => other.inputHash !== v.inputHash)), "Promotion requires a separate independent passing input");
      state.status = "reusable";
    });
  }
  async setStatus(ref: CapabilityRef, status: "deprecated" | "disabled" | "enabled"): Promise<void> {
    await this.update(ref, state => { if (status === "deprecated") state.status = status; else state.disabled = status === "disabled"; });
  }
  async recordOutcome(ref: CapabilityRef, outcome: CapabilityState["outcomes"][number]): Promise<void> {
    check(ID.test(outcome.runId) && typeof outcome.success === "boolean" && typeof outcome.evidence === "string" && !!outcome.evidence.trim(), "Invalid outcome");
    await this.update(ref, state => { state.outcomes.push(structuredClone(outcome)); });
  }
  async search(query: string, tools: string[], platform = process.platform): Promise<CapabilityRef[]> {
    const files = await readdir(this.root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ ref: CapabilityRef; score: number }> = [];
    for (const file of files.sort()) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})-([a-f0-9]{64})\.json$/.exec(file); if (!match) continue;
      const ref = { id: match[1]!, hash: match[2]! }; const { version: v, state } = await this.inspect(ref);
      if (state.disabled || state.status !== "reusable" || v.tools.some(t => !tools.includes(t)) || (v.platforms.length && !v.platforms.includes(platform))) continue;
      const text = `${v.description} ${v.tags.join(" ")} ${v.input} ${v.output}`.toLowerCase();
      const score = terms.filter(term => text.includes(term)).length;
      if (!terms.length || score) matches.push({ ref, score });
    }
    return matches.sort((a, b) => b.score - a.score || key(a.ref).localeCompare(key(b.ref))).map(x => x.ref);
  }
  async resolve(refs: CapabilityRef[], tools: string[], runId: string, frontier: CapabilityRef[], platform = process.platform): Promise<CapabilityVersion[]> {
    const result = new Map<string, CapabilityVersion>(); const active = new Set<string>();
    const visit = async (ref: CapabilityRef, depth: number): Promise<void> => {
      check(depth <= 3 && !active.has(key(ref)), "Capability dependency cycle or nesting limit");
      if (result.has(key(ref))) return;
      const { version: v, state } = await this.inspect(ref);
      check(!state.disabled && state.status !== "deprecated" && (state.status === "reusable" && frontier.some(x => key(x) === key(ref)) || v.sourceRun === runId && ["validated", "reusable"].includes(state.status)), "Capability not admitted in frozen frontier");
      check(v.tools.every(t => tools.includes(t)) && (!v.platforms.length || v.platforms.includes(platform)), "Capability environment mismatch");
      active.add(key(ref)); for (const dependency of v.dependencies) await visit(dependency, depth + 1); active.delete(key(ref)); result.set(key(ref), v);
    };
    for (const ref of refs) await visit(ref, 1);
    return [...result.values()];
  }
}
