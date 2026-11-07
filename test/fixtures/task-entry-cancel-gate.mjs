import { appendFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import originalTaskEntry from "../../src/task-entry.ts";

/**
 * Native test fixture: load the real task entry unchanged, but transparently
 * time only the real `agent_task` cancel action. The gate waits for the
 * sandbox script itself to publish its PID in the host-owned run directory,
 * then forwards the original execute arguments (including the actual
 * AbortSignal and OMP context) without inspecting or replacing them.
 *
 * It registers no tool, grants no authority and never calls owner.cancel
 * directly. All scenarios load this wrapper in place of the bare task entry so
 * the native suite always exercises the real path and the exact tool set
 * `agent_task` + `agent_execute`.
 */

const executionRoot = process.env.EXECUTION_FIXTURE_ROOT;
const auditPath = process.env.EXECUTION_FIXTURE_AUDIT;

function audit(event) {
  if (!auditPath) return;
  appendFileSync(auditPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "task_entry_cancel_gate",
    ...event,
  })}\n`);
}

async function sandboxReady() {
  if (!executionRoot) return undefined;
  let names;
  try {
    names = (await readdir(executionRoot)).filter((name) => name.startsWith("run-")).sort();
  } catch {
    return undefined;
  }
  for (const name of names.reverse()) {
    try {
      const runRoot = path.join(executionRoot, name);
      const record = JSON.parse(await readFile(path.join(runRoot, "record.json"), "utf8"));
      if (record?.phase !== "running") continue;
      const pid = record?.process?.pid;
      if (typeof pid !== "number") continue;
      const markerPath = path.join(runRoot, "work", "ready.marker");
      const marker = await readFile(markerPath, "utf8");
      if (Number(marker) !== pid) continue;
      process.kill(pid, 0);
      return { record, marker, markerPath, pid };
    } catch {
      // A run may still be staging; keep looking within the bounded deadline.
    }
  }
  return undefined;
}

export default function taskEntryCancelGate(pi) {
  const wrapped = new Proxy(pi, {
    get(target, key) {
      if (key === "registerTool") {
        return (tool) => {
          if (tool.name !== "agent_task") return pi.registerTool(tool);
          return pi.registerTool({
            ...tool,
            async execute(...args) {
              const [id, params, signal] = args;
              if (params?.action === "cancel") {
                audit({ event: "waiting", id, tool: tool.name, action: params.action });
                const deadline = Date.now() + 15_000;
                let ready;
                while (Date.now() < deadline) {
                  ready = await sandboxReady();
                  if (ready) break;
                  await Bun.sleep(10);
                }
                if (!ready) throw new Error("task-entry cancel gate did not observe the sandbox ready marker");
                const context = args[4];
                audit({
                  event: "forwarded",
                  id,
                  tool: tool.name,
                  action: params.action,
                  signalPresent: signal !== undefined,
                  aborted: signal?.aborted ?? null,
                  sessionId: context?.sessionManager?.getSessionId?.() ?? null,
                  pid: ready.pid,
                  marker: ready.marker,
                  markerPath: ready.markerPath,
                  runId: ready.record.runId,
                  taskRevision: ready.record.taskRevision,
                });
              }
              // Exact original arguments, signal and context; no substitution.
              return await tool.execute.apply(tool, args);
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  originalTaskEntry(wrapped);
}
