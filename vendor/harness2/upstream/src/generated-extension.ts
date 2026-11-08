import { digest } from "./capabilities";
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface GeneratedExtension {
  schemaVersion: 1;
  source: string;
  tools: ExtensionTool[];
}
export function parseGeneratedExtension(content: string): GeneratedExtension {
  const v = JSON.parse(content) as GeneratedExtension;
  if (
    !v ||
    v.schemaVersion !== 1 ||
    Object.keys(v).some(
      (k) => !["schemaVersion", "source", "tools"].includes(k),
    ) ||
    typeof v.source !== "string" ||
    !v.source.trim() ||
    v.source.length > 80000 ||
    !Array.isArray(v.tools) ||
    !v.tools.length ||
    v.tools.length > 8 ||
    new Set(v.tools.map((t) => t.name)).size !== v.tools.length
  )
    throw new Error("Invalid generated extension envelope");
  for (const t of v.tools)
    if (
      !t ||
      Object.keys(t).some(
        (k) => !["name", "description", "parameters"].includes(k),
      ) ||
      typeof t.name !== "string" ||
      !/^h2ext_[a-z][a-z0-9_]{0,39}$/.test(t.name) ||
      typeof t.description !== "string" ||
      !t.description.trim() ||
      !t.parameters ||
      t.parameters.type !== "object" ||
      !t.parameters.properties ||
      typeof t.parameters.properties !== "object" ||
      Array.isArray(t.parameters.properties)
    )
      throw new Error(
        "Generated extension tools require prefixed names and object schemas",
      );
  return v;
}
/** Used only after OMP exec approval. The source factory receives no event/UI/global registration APIs. */
export function extensionLoaderSource(): string {
  return `
export async function load(factory, declared) {
  const found = new Map();
  await factory(Object.freeze({ registerTool(tool) {
    const expected = declared.find(d => d.name === tool.name);
    if (!expected || found.has(tool.name) || JSON.stringify(tool.parameters) !== JSON.stringify(expected.parameters) || typeof tool.execute !== "function") throw new Error("Extension registration contract mismatch");
    found.set(tool.name, tool);
  } }));
  if (found.size !== declared.length) throw new Error("Extension did not register its declared tools");
  return found;
}`;
}
export function extensionWrapperSource(
  envelope: GeneratedExtension,
  sourceName: string,
  loaderName: string,
): string {
  // This module contains declarations only. Importing it never imports generated source.
  return `import { load } from ${JSON.stringify(`./${loaderName}`)};
const declared = ${JSON.stringify(envelope.tools)};
export default function(pi) {
 for (const definition of declared) pi.registerTool({ ...definition, label: definition.name, approval: "exec", loadMode: "essential",
  async execute(id, args, signal, update, ctx) {
   const { default: factory } = await import(${JSON.stringify(`./${sourceName}`)});
   const tools = await load(factory, declared);
   if (signal?.aborted) throw new Error("Extension execution cancelled");
   return tools.get(definition.name).execute(id, args, signal, update, ctx);
  }
 });
}`;
}
export function extensionTestSource(
  envelope: GeneratedExtension,
  cases: Array<{ tool: string; input: unknown; expected: unknown }>,
): string {
  if (cases.some((c) => !envelope.tools.some((t) => t.name === c.tool)))
    throw new Error("Verifier referenced an undeclared extension tool");
  for (const tool of envelope.tools)
    if (
      new Set(
        cases
          .filter((c) => c.tool === tool.name)
          .map((c) => JSON.stringify(c.input)),
      ).size < 2
    )
      throw new Error(
        "Each extension tool needs two distinct independent inputs",
      );
  return `import assert from "node:assert/strict"; import factory from "./implementation.mjs"; import { load } from "./loader.mjs";
const tools = await load(factory, ${JSON.stringify(envelope.tools)});
for (const c of ${JSON.stringify(cases)}) {
 const result = await tools.get(c.tool).execute("contract", c.input, new AbortController().signal, undefined, {});
 assert.equal(result?.isError === true, false);
 assert.deepEqual(result.content, c.expected);
}
console.log("H2_CONTRACT_PASSED");`;
}
export function extensionDigest(extension: GeneratedExtension): string {
  return digest(extension);
}
