import type { CapabilityRef, CapabilityState, CapabilityVersion } from "./capabilities";
import { buildPlannerMethodGuidance, type PlannerMethodGuidance } from "./planner-methods";
import { encodePromptData } from "./runner";

/** Existing discovery metadata; this presentation helper does not grant admission. */
export interface PlannerCatalogEntry extends CapabilityRef {
  kind: CapabilityVersion["kind"];
  description: string;
  input: string;
  output: string;
  status: CapabilityState["status"];
  limitations: string;
  unavailable?: string;
}
export interface PlannerCatalogGuidance {
  prompt: string;
  refs: CapabilityRef[];
  methods: PlannerMethodGuidance;
  omitted: number;
  bytes: number;
}
export interface PlannerCatalogOptions { maxEntries?: number; maxBytes?: number }
const MAX_ENTRIES = 24;
const MAX_BYTES = 64 * 1024;
const key = (ref: CapabilityRef) => `${ref.id}@${ref.hash}`;
// Measure this section through the existing ingress encoding and JSON string
// encoding. This is a presentation budget, not a limit on the complete prompt.
const presentationBytes = (prompt: string) => Buffer.byteLength(JSON.stringify(encodePromptData(prompt, "editor")), "utf8");

/**
 * Preserve the existing retrieval order and exact refs. Whole entries are
 * omitted when necessary; frozen frontiers, contracts and admission are untouched.
 * The caller supplies the methods it already resolved through normal admission.
 */
export function buildPlannerCatalogGuidance(
  catalog: readonly PlannerCatalogEntry[],
  admittedMethods: readonly CapabilityVersion[],
  options: PlannerCatalogOptions = {},
): PlannerCatalogGuidance {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > MAX_ENTRIES || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_BYTES)
    throw new Error("Invalid planner catalog presentation limits");
  const render = (entries: readonly PlannerCatalogEntry[]): PlannerCatalogGuidance => {
    const refs = entries.map(({ id, hash }) => ({ id, hash }));
    const visible = new Set(refs.map(key));
    const methods = admittedMethods.filter(v => visible.has(key(v)));
    const guidance = buildPlannerMethodGuidance(methods);
    const omitted = catalog.length - entries.length;
    const warning = omitted ? `\nCAPABILITY PRESENTATION LIMIT: ${omitted} of ${catalog.length} catalog entries omitted from this bounded view. The displayed frontier is a presentation subset; the persisted frozen frontier and admission rules are unchanged. Omitted metadata/contracts were not shown; do not infer compatibility or invent references.` : "";
    const prompt = `CAPABILITY FRONTIER: ${JSON.stringify(refs)}\nCAPABILITY CATALOG: ${JSON.stringify(entries)}\n${methods.length ? guidance.prompt : omitted ? "No registered method is shown in this bounded view. Use builtin method IDs or propose tasks." : "No registered method is currently admitted. Use builtin method IDs or propose tasks."}${warning}`;
    return { prompt, refs, methods: guidance, omitted, bytes: presentationBytes(prompt) };
  };
  // Small directories retain the exact previous prompt, including field order.
  if (catalog.length <= maxEntries) {
    const complete = render(catalog);
    if (complete.bytes <= maxBytes) return complete;
  }
  const selected: PlannerCatalogEntry[] = [];
  let result = render(selected);
  for (const entry of catalog) {
    if (selected.length >= maxEntries) break;
    const candidate = render([...selected, entry]);
    if (candidate.bytes > maxBytes) continue;
    selected.push(entry);
    result = candidate;
  }
  if (result.bytes > maxBytes) throw new Error("Planner catalog presentation exceeds its budget");
  return result;
}
