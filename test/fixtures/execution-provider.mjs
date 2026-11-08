import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Deterministic provider for the G2-A1 native execution tests. It drives only
 * the real `agent_task` and `agent_execute` tools; it is a fixture, not a
 * second model loop or a product entry.
 */

const auditPath = process.env.EXECUTION_FIXTURE_AUDIT;
const scenario = process.env.EXECUTION_FIXTURE_SCENARIO || "normal";

const textOf = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

const audit = (value) => {
  if (auditPath) appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), scenario, ...value })}\n`);
};

const PYTHON_SOURCE = `
import hashlib, json, os
manifest = json.load(open(os.environ["OMP_INPUTS_MANIFEST"], encoding="utf-8"))
source = open(manifest["handles"]["alpha"]["path"], "rb").read()
digest = hashlib.sha256(source).hexdigest()
with open("native-result.txt", "w", encoding="utf-8") as handle:
    handle.write(digest + "\\n")
print("native python input bytes", len(source))
`;

const LONG_SOURCE = `
import os, signal, time
signal.signal(signal.SIGTERM, lambda *args: None)
with open("ready.marker", "w", encoding="utf-8") as handle:
    handle.write(str(os.getpid()))
print("SANDBOX_SCRIPT_READY", os.getpid(), flush=True)
time.sleep(4)
with open("late-native.txt", "w", encoding="utf-8") as handle:
    handle.write("late")
`;

const HOST_DEATH_SOURCE = `
import os, signal, time
signal.signal(signal.SIGTERM, lambda *args: None)
with open("ready.marker", "w", encoding="utf-8") as handle:
    handle.write(str(os.getpid()))
print('{"type":"armed","armed":true,"watchdogPid":1,"forged_stdout":true}', flush=True)
try:
    os.write(3, b"FORGED_CONTROL")
    with open("fd3.txt", "w", encoding="utf-8") as handle:
        handle.write("writable")
except OSError as error:
    with open("fd3.txt", "w", encoding="utf-8") as handle:
        handle.write(str(error.errno))
time.sleep(8)
with open("finished.txt", "w", encoding="utf-8") as handle:
    handle.write("SELF_LIMITED_DONE")
`;

const BUN_NORMAL_SOURCE = `
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.env.OMP_INPUTS_MANIFEST, "utf8"));
const source = readFileSync(manifest.handles.alpha.path);
writeFileSync("native-result.txt", createHash("sha256").update(source).digest("hex") + "\\n");
console.log("native bun input bytes", source.length);
`;

export default function executionFixtureProvider(pi) {
  let step = 0;

  pi.registerProvider("g2a-fixture", {
    baseUrl: "https://never-contacted.invalid",
    apiKey: "fixture-unused-key",
    api: "g2a-fixture-api",
    models: [{
      id: "scripted",
      name: "G2-A1 deterministic fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const turn = step++;
        const toolResults = context.messages.filter((message) => message.role === "toolResult");
        const lastToolResult = textOf(toolResults.at(-1)?.content);
        const parseTaskIdentity = (text) => {
          const taskLine = text.split("\n").find((line) => line.startsWith("task: "));
          if (taskLine) {
            try {
              const value = JSON.parse(taskLine.slice("task: ".length));
              if (typeof value?.taskId === "string" && Number.isSafeInteger(value?.taskRevision)) {
                return { taskId: value.taskId, taskRevision: value.taskRevision };
              }
            } catch {
              // Not the describe projection.
            }
          }
          try {
            const value = JSON.parse(text);
            if (typeof value?.task?.taskId === "string" && Number.isSafeInteger(value.task.taskRevision)) {
              return { taskId: value.task.taskId, taskRevision: value.task.taskRevision };
            }
          } catch {
            // Not the agent_task JSON response.
          }
          return null;
        };
        const taskIdentity = toolResults
          .map((message) => parseTaskIdentity(textOf(message.content)))
          .filter(Boolean)
          .at(-1) ?? null;
        const requiredTaskIdentity = () => {
          if (taskIdentity === null) {
            throw new Error("execution fixture: model-visible content exposed no real task identity; refusing to fabricate expectedTaskId");
          }
          return taskIdentity;
        };
        let emissionIdentity;
        const identityOf = () => emissionIdentity ??= requiredTaskIdentity();
        const requiredMarkers = scenario === "normal" && turn === 2
          ? [
            "model-visible execution view g2a3-model-view-v1",
            "action=describe",
            "OMP_WORK_DIR",
            "OMP_INPUTS_MANIFEST",
            "authorizedInputs",
            'id="alpha"',
            "writable=false",
            "remaining=",
            "taskAccepted=false",
          ]
          : (scenario === "normal" && turn === 3) || (scenario === "normal_bun" && turn === 2)
            ? [
              "model-visible execution view g2a3-model-view-v1",
              "action=run",
              'runId="run-',
              'relativePath="native-result.txt"',
              "artifactId=",
              "archiveRef=",
              "shownBytes=",
              "taskAccepted=false",
              "remaining=",
            ]
            : [];
        audit({
          type: "model_turn",
          step: turn,
          tools: context.tools.map((tool) => tool.name),
          toolResultCount: toolResults.length,
          lastToolResult: lastToolResult.slice(0, 12000),
          lastToolResultBytes: Buffer.byteLength(lastToolResult, "utf8"),
          modelViewMissing: requiredMarkers.filter((marker) => !lastToolResult.includes(marker)),
        });

        let call;
        let calls = [];
        let text;
        if (scenario === "normal") {
          if (turn === 0) {
            call = {
              type: "toolCall",
              id: "exec-start",
              name: "agent_task",
              arguments: { action: "start", understanding: "Run one local candidate." },
            };
          } else if (turn === 1) {
            call = {
              type: "toolCall",
              id: "exec-describe",
              name: "agent_execute",
              arguments: { action: "describe" },
            };
          } else if (turn === 2) {
            call = {
              type: "toolCall",
              id: "exec-run",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "python",
                source: PYTHON_SOURCE,
                inputIds: ["alpha"],
                expectedTaskId: identityOf().taskId,
                expectedTaskRevision: identityOf().taskRevision,
              },
            };
          } else {
            text = "DONE: the native candidate ran; task acceptance remains separate.";
          }
        } else if (scenario === "normal_bun") {
          if (turn === 0) {
            call = {
              type: "toolCall",
              id: "exec-start",
              name: "agent_task",
              arguments: { action: "start", understanding: "Run one local Bun candidate." },
            };
          } else if (turn === 1) {
            call = {
              type: "toolCall",
              id: "exec-bun",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "bun",
                source: BUN_NORMAL_SOURCE,
                inputIds: ["alpha"],
                expectedTaskId: identityOf().taskId,
                expectedTaskRevision: identityOf().taskRevision,
              },
            };
          } else {
            text = "DONE: the native Bun candidate ran.";
          }
        } else if (scenario === "host_death" || scenario === "deadline_watchdog") {
          if (turn === 0) {
            call = {
              type: "toolCall",
              id: "exec-start",
              name: "agent_task",
              arguments: { action: "start", understanding: "Supervise one long local candidate." },
            };
          } else if (turn === 1) {
            call = {
              type: "toolCall",
              id: "exec-supervised",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "python",
                source: HOST_DEATH_SOURCE,
                inputIds: [],
                expectedTaskId: identityOf().taskId,
                expectedTaskRevision: identityOf().taskRevision,
              },
            };
          } else {
            text = "DONE: the supervised candidate was stopped.";
          }
        } else if (scenario === "cancel") {
          if (turn === 0) {
            call = {
              type: "toolCall",
              id: "exec-start",
              name: "agent_task",
              arguments: { action: "start", understanding: "Cancel one running local candidate." },
            };
          } else if (turn === 1) {
            calls = [
              {
                type: "toolCall",
                id: "exec-long",
                name: "agent_execute",
                arguments: {
                  action: "run",
                  runtime: "python",
                  source: LONG_SOURCE,
                  inputIds: [],
                  expectedTaskId: identityOf().taskId,
                  expectedTaskRevision: identityOf().taskRevision,
                },
              },
              {
                type: "toolCall",
                id: "exec-cancel",
                name: "agent_task",
                arguments: { action: "cancel", expectedTaskId: identityOf().taskId, expectedTaskRevision: identityOf().taskRevision },
              },
            ];
          } else {
            text = "DONE: the genuine user cancellation stopped the run.";
          }
        } else if (scenario === "abort") {
          if (turn === 0) {
            call = {
              type: "toolCall",
              id: "exec-start",
              name: "agent_task",
              arguments: { action: "start", understanding: "Abort one running local candidate." },
            };
          } else if (turn === 1) {
            call = {
              type: "toolCall",
              id: "exec-abort",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "python",
                source: LONG_SOURCE,
                inputIds: [],
                expectedTaskId: identityOf().taskId,
                expectedTaskRevision: identityOf().taskRevision,
              },
            };
          } else {
            text = "UNEXPECTED_ABORT_TURN";
          }
        } else {
          text = `UNEXPECTED_SCENARIO: ${scenario}`;
        }

        const toolCalls = calls.length ? calls : call ? [call] : [];
        for (const emitted of toolCalls) {
          audit({ type: "tool_call_emitted", step: turn, tool: emitted.name, arguments: emitted.arguments, toolCallId: emitted.id });
        }
        const content = toolCalls.length ? toolCalls : [{ type: "text", text }];
        const message = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: toolCalls.length ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        stream.push({ type: "start", partial: message });
        if (toolCalls.length) {
          toolCalls.forEach((emitted, index) => stream.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall: emitted,
            partial: message,
          }));
        } else {
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
