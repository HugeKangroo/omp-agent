#!/usr/bin/env bun
// Bounded local RPC fixture for Runner lifecycle tests. It has no provider,
// network, tool execution, shell or arbitrary process-launch behavior.
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const executable = process.argv[1] ?? "";
const modeMatch = /harness-lifecycle-worker-([a-z0-9-]+)\.mjs$/.exec(basename(executable));
const mode = modeMatch ? modeMatch[1] : "normal";
writeFileSync(`${executable}.started`, String(process.pid), { mode: 0o600 });

const args = process.argv.slice(2);
const modelArgument = args[args.indexOf("--model") + 1] ?? "openai/lifecycle-fixture";
const separator = modelArgument.indexOf("/");
const provider = separator > 0 ? modelArgument.slice(0, separator) : "openai";
const modelId = separator > 0 ? modelArgument.slice(separator + 1) : modelArgument;

const send = (frame) => { process.stdout.write(JSON.stringify(frame) + "\n"); };
const respond = (frame, data = {}) => send({ type: "response", id: frame.id, success: true, command: frame.type, data });

let tools = [];
let promptSeen = false;
const handle = (line, rawLine) => {
  const frame = JSON.parse(line);
  if (frame.type === "negotiate_protocol" || frame.type === "set_auto_retry"
    || frame.type === "set_auto_compaction" || frame.type === "set_cache_warming"
    || frame.type === "set_event_filter" || frame.type === "set_host_tools") {
    if (frame.type === "set_host_tools") tools = Array.isArray(frame.tools) ? frame.tools.map((tool) => String(tool.name)) : [];
    return respond(frame);
  }
  if (frame.type === "get_state") {
    return send({
      type: "response", id: frame.id, success: true, command: "get_state",
      data: { model: { provider, id: modelId, cost: { input: 1, output: 1 } }, dumpTools: tools.map((name) => ({ name })) },
    });
  }
  if (frame.type === "get_session_stats") {
    return send({
      type: "response", id: frame.id, success: true, command: "get_session_stats",
      data: { cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    });
  }
  if (frame.type === "get_last_assistant_text") {
    return send({ type: "response", id: frame.id, success: true, command: "get_last_assistant_text", data: { text: "lifecycle fixture result" } });
  }
  if (frame.type === "prompt") {
    if (promptSeen) return undefined;
    promptSeen = true;
    writeFileSync(`${executable}.prompt`, rawLine, { mode: 0o600 });
    if (mode === "approval-delay") send({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: "fixture approval", message: "fixture", options: [] });
    if (mode === "no-complete") return undefined;
    if (mode === "prompt-fail") return send({ type: "prompt_result", id: "h2-prompt", status: "error", error: { message: "synthetic prompt failure" } });
    return send({ type: "prompt_result", id: "h2-prompt", status: "completed", agentInvoked: true, sessionSettled: true });
  }
  if (frame.type === "abort") return undefined;
  if (typeof frame.id === "string") return respond(frame);
  return undefined;
};

send({ type: "ready", supportedProtocolVersions: [2] });

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try { handle(line, `${line}\n`); }
    catch { process.exit(1); }
  }
});
process.stdin.on("end", () => { process.exitCode = 0; });
process.stdin.on("close", () => { process.exitCode = 0; });
