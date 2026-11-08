import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Deterministic provider for the native delivery regression. Decisions read
 * only the actual model-visible tool content. It is a fixture, not a second
 * model loop, and never reads host records, details or snapshots to choose a
 * selector.
 */

const mode = process.env.DELIVERY_FIXTURE_MODE || "full";
const auditPath = process.env.DELIVERY_FIXTURE_AUDIT;

const textOf = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

const audit = (value) => {
  if (auditPath) appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), mode, ...value })}\n`);
};

const lineValue = (text, key) => {
  const line = text.split("\n").find((item) => item.startsWith(`${key}: `));
  if (!line) throw new Error(`delivery fixture: missing content field ${key}`);
  return line.slice(key.length + 2);
};

const taskFrom = (text) => {
  const value = JSON.parse(text);
  const task = value?.task;
  if (typeof task?.taskId !== "string" || !Number.isSafeInteger(task?.taskRevision)) {
    throw new Error("delivery fixture: agent_task content exposed no actual task identity");
  }
  return { taskId: task.taskId, taskRevision: task.taskRevision };
};

const runFrom = (text) => {
  const run = /^run runId="([^"]+)"[^\n]*taskRevision=(\d+)/m.exec(text);
  if (!run) throw new Error("delivery fixture: agent_execute content exposed no actual run identity");
  const artifacts = [...text.matchAll(/^- artifactId="([^"]+)"[^\n]*sha256="(sha256:[0-9a-f]{64})"/gm)]
    .map((match) => ({ artifactId: match[1], sha256: match[2] }));
  if (artifacts.length === 0) throw new Error("delivery fixture: agent_execute content exposed no artifact");
  return { runId: run[1], taskRevision: Number(run[2]), artifactIds: artifacts.map((item) => item.artifactId), artifacts };
};

const receiptFrom = (text) => {
  const receiptId = /^receiptId: (\S+)$/m.exec(text)?.[1];
  if (!receiptId) throw new Error("delivery fixture: agent_verify content exposed no receipt");
  return receiptId;
};

const deliveryFrom = (text) => lineValue(text, "deliveryId");

const SOURCE = [
  "import json, os",
  "m = json.load(open(os.environ['OMP_INPUTS_MANIFEST'], encoding='utf-8'))",
  "data = open(m['handles']['alpha']['path'], 'rb').read()",
  "open('answer.txt', 'wb').write(b'DELIVERY_OK\\n' + data)",
  "print('wrote answer.txt from', len(data), 'authorized input bytes')",
  "",
].join("\n");

const LATE_SOURCE = [
  "open('LATE_SIDE_EFFECT.txt', 'w', encoding='utf-8').write('must not execute')",
  "print('late run must be rejected before spawn')",
  "",
].join("\n");

export default function deliveryFixtureProvider(pi) {
  let step = 0;
  const state = {};

  pi.registerProvider("delivery-fixture", {
    baseUrl: "https://never-contacted.invalid",
    apiKey: "fixture-unused-key",
    api: "delivery-fixture-api",
    models: [{
      id: "scripted",
      name: "Native delivery deterministic fixture",
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

        let call;
        let text;
        if (turn === 0) {
          call = {
            type: "toolCall",
            id: "delivery-task-start",
            name: "agent_task",
            arguments: { action: "start", understanding: "Run one local candidate and use the host-configured delivery path." },
          };
        } else if (turn === 1) {
          state.task = taskFrom(lastToolResult);
          call = {
            type: "toolCall",
            id: "delivery-run",
            name: "agent_execute",
            arguments: {
              action: "run",
              runtime: "python",
              inputIds: ["alpha"],
              source: SOURCE,
              expectedTaskId: state.task.taskId,
              expectedTaskRevision: state.task.taskRevision,
            },
          };
        } else if (mode === "delivery-only") {
          if (turn === 2) {
            state.run = runFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-preview",
              name: "agent_deliver",
              arguments: {
                action: "preview",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
              },
            };
          } else if (turn === 3) {
            state.deliveryId = deliveryFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-submit-unconfigured",
              name: "agent_deliver",
              arguments: {
                action: "submit",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 4) {
            call = {
              type: "toolCall",
              id: "delivery-inspect-unconfigured",
              name: "agent_deliver",
              arguments: {
                action: "inspect",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else {
            text = "DONE: delivery-only host reported preview success and an unconfigured acceptance path.";
          }
        } else if (mode === "partial") {
          if (turn === 2) {
            state.run = runFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-verify",
              name: "agent_verify",
              arguments: {
                action: "verify",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
              },
            };
          } else if (turn === 3) {
            state.receiptId = receiptFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-preview",
              name: "agent_deliver",
              arguments: {
                action: "preview",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
                verificationReceiptId: state.receiptId,
              },
            };
          } else if (turn === 4) {
            state.deliveryId = deliveryFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-submit-partial",
              name: "agent_deliver",
              arguments: {
                action: "submit",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 5) {
            call = {
              type: "toolCall",
              id: "delivery-inspect-partial",
              name: "agent_deliver",
              arguments: {
                action: "inspect",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 6) {
            call = { type: "toolCall", id: "delivery-task-inspect-partial", name: "agent_task", arguments: { action: "inspect" } };
          } else {
            text = "DONE: the local verifier passed but explicit partial coverage left the task active and unaccepted.";
          }
        } else {
          if (turn === 2) {
            state.run = runFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-verify",
              name: "agent_verify",
              arguments: {
                action: "verify",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
              },
            };
          } else if (turn === 3) {
            state.receiptId = receiptFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-preview",
              name: "agent_deliver",
              arguments: {
                action: "preview",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
                verificationReceiptId: state.receiptId,
              },
            };
          } else if (turn === 4) {
            state.deliveryId = deliveryFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "delivery-submit",
              name: "agent_deliver",
              arguments: {
                action: "submit",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 5) {
            call = {
              type: "toolCall",
              id: "delivery-inspect",
              name: "agent_deliver",
              arguments: {
                action: "inspect",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 6) {
            call = {
              type: "toolCall",
              id: "delivery-submit-repeat",
              name: "agent_deliver",
              arguments: {
                action: "submit",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 7) {
            call = {
              type: "toolCall",
              id: "delivery-late-run",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "python",
                inputIds: [],
                source: LATE_SOURCE,
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
              },
            };
          } else if (turn === 8) {
            call = { type: "toolCall", id: "delivery-late-cancel", name: "agent_task", arguments: { action: "cancel", expectedTaskId: state.task.taskId, expectedTaskRevision: state.task.taskRevision } };
          } else if (turn === 9) {
            call = { type: "toolCall", id: "delivery-late-revise", name: "agent_task", arguments: { action: "revise", expectedTaskId: state.task.taskId, expectedTaskRevision: state.task.taskRevision } };
          } else if (turn === 10) {
            call = {
              type: "toolCall",
              id: "delivery-inspect-after-guards",
              name: "agent_deliver",
              arguments: {
                action: "inspect",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === 11) {
            call = { type: "toolCall", id: "delivery-task-inspect", name: "agent_task", arguments: { action: "inspect" } };
          } else {
            text = "DONE: one actual delivery was accepted once; late run, cancel and revise were rejected.";
          }
        }

        const toolCalls = call ? [call] : [];
        audit({
          type: "model_turn",
          step: turn,
          tools: context.tools.map((tool) => tool.name).sort(),
          call: call ?? null,
          lastToolResult: lastToolResult.slice(0, 64000),
        });
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
