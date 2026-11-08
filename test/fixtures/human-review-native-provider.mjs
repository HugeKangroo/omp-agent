import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Deterministic local provider for the native human-review harness.
 *
 * Every selector is read from the actual model-visible tool content. The
 * provider never reads host records, delivery files, observer logs, hidden
 * details or private state, never calls requestHumanReview and never commits.
 */

const mode = process.env.REVIEW_NATIVE_PROVIDER_MODE || "single";
const auditPath = process.env.REVIEW_NATIVE_PROVIDER_AUDIT;
const hybrid = process.env.REVIEW_NATIVE_HYBRID === "1";
const maxRequests = Number(process.env.REVIEW_NATIVE_MAX_REQUESTS || "12");
if (!["single", "revise", "forbidden"].includes(mode)) throw new Error("unsupported REVIEW_NATIVE_PROVIDER_MODE");
if (typeof auditPath !== "string" || !auditPath.startsWith("/")) throw new Error("REVIEW_NATIVE_PROVIDER_AUDIT must be absolute");
if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 12) throw new Error("REVIEW_NATIVE_MAX_REQUESTS must be 1..12");

const textOf = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");

const audit = (value) => {
  appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), mode, hybrid, ...value })}\n`);
};

const lineValue = (text, key) => {
  const line = text.split("\n").find((item) => item.startsWith(`${key}: `));
  if (!line) throw new Error(`native review fixture: missing content field ${key}`);
  return line.slice(key.length + 2);
};

const taskFrom = (text) => {
  const value = JSON.parse(text);
  const task = value?.task;
  if (typeof task?.taskId !== "string" || !Number.isSafeInteger(task?.taskRevision)) {
    throw new Error("native review fixture: agent_task content exposed no actual task identity");
  }
  return { taskId: task.taskId, taskRevision: task.taskRevision };
};

const runFrom = (text) => {
  const run = /^run runId="([^"]+)" callId="([^"]+)" taskId="([^"]+)" taskRevision=(\d+)/m.exec(text);
  if (!run) throw new Error("native review fixture: agent_execute content exposed no actual run identity");
  const artifacts = [...text.matchAll(/^- artifactId="([^"]+)" relativePath="([^"]+)" archiveRef="[^"]*" bytes=(\d+) sha256="(sha256:[0-9a-f]{64})"/gm)]
    .map((match) => ({ artifactId: match[1], relativePath: match[2], bytes: Number(match[3]), sha256: match[4] }));
  if (artifacts.length === 0) throw new Error("native review fixture: agent_execute content exposed no artifact");
  return {
    runId: run[1],
    callId: run[2],
    taskId: run[3],
    taskRevision: Number(run[4]),
    artifactIds: artifacts.map((item) => item.artifactId),
    artifacts,
  };
};

const receiptFrom = (text) => {
  const receiptId = /^receiptId: (\S+)$/m.exec(text)?.[1];
  if (!receiptId) throw new Error("native review fixture: agent_verify content exposed no receipt");
  return receiptId;
};

const deliveryFrom = (text) => lineValue(text, "deliveryId");

const SOURCE = [
  "import json, os",
  "m = json.load(open(os.environ['OMP_INPUTS_MANIFEST'], encoding='utf-8'))",
  "for name in ('alpha', 'beta'):",
  "    data = open(m['handles'][name]['path'], 'rb').read()",
  "    open(name + '.txt', 'wb').write(data)",
  "print('copied exact authorized bytes for', len(m['handles']), 'inputs')",
  "",
].join("\n");

export default function humanReviewNativeProvider(pi) {
  let step = 0;
  const state = {};
  pi.registerProvider("native-review-fixture", {
    baseUrl: "https://never-contacted.invalid",
    apiKey: "fixture-unused-key",
    api: "native-review-fixture-api",
    models: [{
      id: "scripted",
      name: "Native human-review deterministic fixture",
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
        if (mode === "forbidden") {
          audit({ type: "forbidden_model_request", step: turn });
          throw new Error("admission-only case forbids every model request");
        }
        if (turn >= maxRequests) {
          audit({ type: "request_limit_exceeded", step: turn, maxRequests });
          throw new Error(`native review fixture request limit ${maxRequests} exceeded`);
        }

        let call;
        let text;
        if (turn === 0) {
          call = {
            type: "toolCall",
            id: "review-task-start",
            name: "agent_task",
            arguments: {
              action: "start",
              understanding: "Use the host-configured execution, delivery and review path for this synthetic task.",
            },
          };
        } else if (mode === "revise" && turn === 1) {
          text = "REVISION_READY: the task is started; send the observed amendment text.";
        } else if (mode === "revise" && turn === 2) {
          state.task = taskFrom(lastToolResult);
          call = {
            type: "toolCall",
            id: "review-task-revise",
            name: "agent_task",
            arguments: { action: "revise", expectedTaskId: state.task.taskId, expectedTaskRevision: state.task.taskRevision, understanding: "Apply only the host-observed amendment." },
          };
        } else {
          const runTurn = mode === "revise" ? 3 : 1;
          const verifyTurn = hybrid ? runTurn + 1 : null;
          const previewTurn = hybrid ? runTurn + 2 : runTurn + 1;
          const reviewTurn = previewTurn + 1;
          const inspectTurn = reviewTurn + 1;
          const taskInspectTurn = inspectTurn + 1;
          if (turn === runTurn) {
            state.task = taskFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "review-execute-run",
              name: "agent_execute",
              arguments: {
                action: "run",
                runtime: "python",
                inputIds: ["alpha", "beta"],
                source: SOURCE,
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
              },
            };
          } else if (verifyTurn !== null && turn === verifyTurn) {
            state.run = runFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "review-verify",
              name: "agent_verify",
              arguments: {
                action: "verify",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
              },
            };
          } else if (turn === previewTurn) {
            if (verifyTurn !== null) state.receiptId = receiptFrom(lastToolResult);
            if (!state.run) state.run = runFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "review-preview",
              name: "agent_deliver",
              arguments: {
                action: "preview",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                runId: state.run.runId,
                artifactIds: state.run.artifactIds,
                ...(verifyTurn === null ? {} : { verificationReceiptId: state.receiptId }),
              },
            };
          } else if (turn === reviewTurn) {
            state.deliveryId = deliveryFrom(lastToolResult);
            call = {
              type: "toolCall",
              id: "review-request",
              name: "agent_deliver",
              arguments: {
                action: "request_review",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === inspectTurn) {
            call = {
              type: "toolCall",
              id: "review-inspect",
              name: "agent_deliver",
              arguments: {
                action: "inspect",
                expectedTaskId: state.task.taskId,
                expectedTaskRevision: state.task.taskRevision,
                deliveryId: state.deliveryId,
              },
            };
          } else if (turn === taskInspectTurn) {
            call = { type: "toolCall", id: "review-task-inspect", name: "agent_task", arguments: { action: "inspect" } };
          } else {
            text = "DONE: the automated engineering review chain completed; no human approval is claimed.";
          }
        }

        const toolCalls = call ? [call] : [];
        audit({
          type: "provider_turn",
          step: turn,
          tools: context.tools.map((tool) => tool.name).sort(),
          call: call ?? null,
          text: text ?? null,
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
