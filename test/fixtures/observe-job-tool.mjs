import { appendFileSync } from "node:fs";
import entry from "../../src/job-entry.ts";

/**
 * Test-only transparent observer around the actual job entry. It forwards the
 * real execute arguments, including OMP's genuine third-argument AbortSignal,
 * and never synthesizes an abort. The tool list is unchanged, so harness
 * preflight still sees exactly the entry's registered tools.
 */

const tracePath = process.env.B3_TOOL_TRACE;

const record = (value) => {
  if (!tracePath) return;
  try {
    appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
  } catch {
    // Test observation must never change the tool result.
  }
};

export default function observedJobEntry(pi) {
  const proxy = new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "registerTool") {
        return (tool) => {
          const original = Reflect.get(target, key, target);
          if (typeof original !== "function") throw new Error("OMP registerTool is unavailable.");
          if (tool?.name !== "agent_job") return original.call(target, tool);
          const wrapped = {
            ...tool,
            async execute(...args) {
              const [id, params, signal] = args;
              const startedAt = Date.now();
              const base = { id, tool: tool.name, action: params?.action };
              record({ ...base, type: "tool_enter", startedAt, signalPresent: Boolean(signal), aborted: signal?.aborted ?? null });
              const onAbort = () => record({
                ...base,
                type: "actual_signal_abort",
                startedAt,
                signalPresent: true,
                aborted: true,
                reason: String(signal?.reason),
              });
              signal?.addEventListener("abort", onAbort, { once: true });
              try {
                const result = await tool.execute(...args);
                record({
                  ...base,
                  type: "tool_return",
                  startedAt,
                  finishedAt: Date.now(),
                  durationMs: Date.now() - startedAt,
                  signalPresent: Boolean(signal),
                  aborted: signal?.aborted ?? null,
                  isError: result?.isError === true,
                });
                return result;
              } catch (error) {
                record({
                  ...base,
                  type: "tool_throw",
                  startedAt,
                  finishedAt: Date.now(),
                  durationMs: Date.now() - startedAt,
                  aborted: signal?.aborted ?? null,
                  error: String(error),
                });
                throw error;
              } finally {
                signal?.removeEventListener("abort", onAbort);
              }
            },
          };
          return original.call(target, wrapped);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  entry(proxy);
}
