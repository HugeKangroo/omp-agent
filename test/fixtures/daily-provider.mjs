import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

/**
 * Deterministic provider for the B3-B2 single daily-entry native fixture.
 *
 * Decisions read only actual model-visible content: the current user prompt,
 * available tool names, and prior tool results. Selectors for managed calls
 * are copied from those results, never from host state, details, disk records
 * or a guessed field. The one adversarial replay is labeled and uses the exact
 * selectors previously observed from task A. No network fallback and no second
 * model loop.
 */

const auditPath = process.env.DAILY_PROVIDER_AUDIT;

const textOf = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");

const audit = (value) => {
  if (auditPath) appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`);
};

const MAX_SCHEMA_BYTES = 32 * 1024;

/**
 * Actual model-visible definition for one tool, copied from the request
 * context OMP produced. The bytes are recorded with their digest so the test
 * asserts the requested schema instead of a guessed test-local schema.
 */
const toolSchemaOf = (context, name) => {
  const tools = Array.isArray(context?.tools) ? context.tools : [];
  const tool = tools.find((item) => item?.name === name);
  if (tool === undefined) return null;
  const candidate = [tool.parameters, tool.inputSchema, tool.schema]
    .find((value) => value !== undefined && value !== null);
  let parametersJson = null;
  let parametersBytes = 0;
  let parametersTruncated = false;
  let schemaSha256 = null;
  if (candidate !== undefined) {
    const text = JSON.stringify(candidate);
    parametersBytes = Buffer.byteLength(text, "utf8");
    parametersTruncated = parametersBytes > MAX_SCHEMA_BYTES;
    parametersJson = parametersTruncated ? text.slice(0, MAX_SCHEMA_BYTES) : text;
    schemaSha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  }
  return {
    source: "context.tools",
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description.slice(0, 8192) : null,
    parametersJson,
    parametersBytes,
    parametersTruncated,
    schemaSha256,
  };
};

const lineValue = (text, key) => {
  const line = text.split("\n").find((item) => item.startsWith(`${key}: `));
  if (!line) throw new Error(`daily fixture: missing actual content field ${key}`);
  return line.slice(key.length + 2);
};

const taskFrom = (text) => {
  const value = JSON.parse(text);
  const task = value?.task;
  if (typeof task?.taskId !== "string" || !Number.isSafeInteger(task?.taskRevision)) {
    throw new Error("daily fixture: agent_task content exposed no actual task identity");
  }
  return { taskId: task.taskId, taskRevision: task.taskRevision };
};

const runFrom = (text) => {
  const run = /^run runId="([^"]+)"[^\n]*taskRevision=(\d+)/m.exec(text);
  if (!run) throw new Error("daily fixture: agent_execute content exposed no actual run identity");
  const artifacts = [...text.matchAll(/^- artifactId="([^"]+)"[^\n]*sha256="(sha256:[0-9a-f]{64})"/gm)]
    .map((match) => ({ artifactId: match[1], sha256: match[2] }));
  if (artifacts.length === 0) throw new Error("daily fixture: agent_execute content exposed no artifact");
  return {
    runId: run[1],
    taskRevision: Number(run[2]),
    artifactIds: artifacts.map((item) => item.artifactId),
    artifacts,
  };
};

const previewFrom = (text) => {
  const deliveryId = lineValue(text, "deliveryId");
  const files = JSON.parse(lineValue(text, "files"));
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("daily fixture: agent_deliver preview exposed no actual file");
  }
  for (const file of files) {
    if (typeof file?.path !== "string" || typeof file?.sha256 !== "string") {
      throw new Error("daily fixture: agent_deliver preview file lacks actual path/sha256");
    }
  }
  return { deliveryId, files, previewDigest: lineValue(text, "previewDigest") };
};

const receiptFrom = (text) => {
  const receiptId = /^receiptId: (\S+)$/m.exec(text)?.[1];
  if (!receiptId) throw new Error("daily fixture: agent_verify content exposed no receipt");
  return receiptId;
};

const SOURCE_A = [
  "import json, os",
  "manifest = json.load(open(os.environ['OMP_INPUTS_MANIFEST'], encoding='utf-8'))",
  "data = open(manifest['handles']['alpha']['path'], 'rb').read()",
  "out = b'DAILY_A\\n' + data.upper()",
  "open('result.txt', 'wb').write(out)",
  "print('daily A wrote', len(out), 'bytes')",
  "",
].join("\n");

const SOURCE_B = [
  "import json, os",
  "manifest = json.load(open(os.environ['OMP_INPUTS_MANIFEST'], encoding='utf-8'))",
  "data = open(manifest['handles']['alpha']['path'], 'rb').read()",
  "out = b'DAILY_B\\n' + data.replace(b'alpha', b'beta')",
  "open('result.txt', 'wb').write(out)",
  "print('daily B wrote', len(out), 'bytes')",
  "",
].join("\n");

const ADVERSARIAL_SOURCE = [
  "open('ADVERSARIAL_SIDE_EFFECT.txt', 'w', encoding='utf-8').write('must not execute')",
  "print('old-selector replay must be rejected before spawn')",
  "",
].join("\n");

const MARKERS = [
  "DAILY_NATIVE_READ",
  "DAILY_TASK_A",
  "DAILY_CANCEL_A",
  "DAILY_TASK_B",
  "DAILY_ADVERSARIAL_OLD_SELECTOR",
];

function latestUserText(context) {
  const users = (context.messages || []).filter((message) => message.role === "user");
  return textOf(users.at(-1)?.content);
}

function markerOf(userText) {
  const marker = MARKERS.find((value) => userText.includes(value));
  if (!marker) throw new Error("daily fixture: the actual user prompt carries no daily marker");
  return marker;
}

function nativePathOf(userText) {
  const line = userText.split("\n").find((item) => item.startsWith("file: "));
  if (!line) throw new Error("daily fixture: the actual user prompt carries no file path");
  const value = line.slice("file: ".length).trim();
  if (!value.startsWith("/")) throw new Error("daily fixture: the actual user prompt file path is not absolute");
  return value;
}

export default function dailyFixtureProvider(pi) {
  const state = {
    prompt: "",
    step: 0,
    taskA: null,
    runA: null,
    receiptA: null,
    previewA: null,
    taskB: null,
    runB: null,
    receiptB: null,
    previewB: null,
  };

  pi.registerProvider("daily-fixture", {
    baseUrl: "https://never-contacted.invalid",
    apiKey: "fixture-unused-key",
    api: "daily-fixture-api",
    models: [{
      id: "scripted",
      name: "Native daily deterministic fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 32000,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const prompt = latestUserText(context);
          if (prompt !== state.prompt) {
            state.prompt = prompt;
            state.step = 0;
          }
          const marker = markerOf(prompt);
          const turn = state.step;
          state.step += 1;
          const toolResults = (context.messages || []).filter((message) => message.role === "toolResult");
          const lastToolMessage = toolResults.at(-1);
          const lastToolResult = textOf(lastToolMessage?.content);

          let call;
          let text;
          if (marker === "DAILY_NATIVE_READ") {
            if (turn === 0) {
              call = {
                type: "toolCall",
                id: "daily-native-read",
                name: "read",
                arguments: { path: nativePathOf(prompt) },
              };
            } else {
              text = "DAILY_NATIVE_READ complete: the actual native read result is above.";
            }
          } else if (marker === "DAILY_TASK_A") {
            if (turn === 0) {
              call = {
                type: "toolCall",
                id: "daily-a-start",
                name: "agent_task",
                arguments: {
                  action: "start",
                  understanding: "Produce and preview the fixed daily A candidate without claiming acceptance.",
                },
              };
            } else if (turn === 1) {
              state.taskA = taskFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-a-run",
                name: "agent_execute",
                arguments: {
                  action: "run",
                  runtime: "python",
                  inputIds: ["alpha"],
                  source: SOURCE_A,
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                },
              };
            } else if (turn === 2) {
              state.runA = runFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-a-verify",
                name: "agent_verify",
                arguments: {
                  action: "verify",
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                  runId: state.runA.runId,
                  artifactIds: state.runA.artifactIds,
                },
              };
            } else if (turn === 3) {
              state.receiptA = receiptFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-a-preview",
                name: "agent_deliver",
                arguments: {
                  action: "preview",
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                  runId: state.runA.runId,
                  artifactIds: state.runA.artifactIds,
                },
              };
            } else if (turn === 4) {
              state.previewA = previewFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-a-describe",
                name: "agent_deliver",
                arguments: { action: "describe" },
              };
            } else if (turn === 5) {
              call = {
                type: "toolCall",
                id: "daily-a-request-review",
                name: "agent_deliver",
                arguments: {
                  action: "request_review",
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                  deliveryId: state.previewA.deliveryId,
                },
              };
            } else {
              text = "DAILY_TASK_A complete: candidate and insufficient receipt retained; taskAccepted:false.";
            }
          } else if (marker === "DAILY_CANCEL_A") {
            if (turn === 0) {
              call = {
                type: "toolCall",
                id: "daily-a-cancel",
                name: "agent_task",
                arguments: {
                  action: "cancel",
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                },
              };
            } else {
              text = "DAILY_CANCEL_A complete: the explicit user message cancelled task A.";
            }
          } else if (marker === "DAILY_TASK_B") {
            if (turn === 0) {
              call = {
                type: "toolCall",
                id: "daily-b-start",
                name: "agent_task",
                arguments: {
                  action: "start",
                  understanding: "Produce and preview the distinct fixed daily B candidate without acceptance.",
                },
              };
            } else if (turn === 1) {
              state.taskB = taskFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-b-run",
                name: "agent_execute",
                arguments: {
                  action: "run",
                  runtime: "python",
                  inputIds: ["alpha"],
                  source: SOURCE_B,
                  expectedTaskId: state.taskB.taskId,
                  expectedTaskRevision: state.taskB.taskRevision,
                },
              };
            } else if (turn === 2) {
              state.runB = runFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-b-verify",
                name: "agent_verify",
                arguments: {
                  action: "verify",
                  expectedTaskId: state.taskB.taskId,
                  expectedTaskRevision: state.taskB.taskRevision,
                  runId: state.runB.runId,
                  artifactIds: state.runB.artifactIds,
                },
              };
            } else if (turn === 3) {
              state.receiptB = receiptFrom(lastToolResult);
              call = {
                type: "toolCall",
                id: "daily-b-preview",
                name: "agent_deliver",
                arguments: {
                  action: "preview",
                  expectedTaskId: state.taskB.taskId,
                  expectedTaskRevision: state.taskB.taskRevision,
                  runId: state.runB.runId,
                  artifactIds: state.runB.artifactIds,
                },
              };
            } else {
              state.previewB = turn === 4 ? previewFrom(lastToolResult) : state.previewB;
              text = "DAILY_TASK_B complete: distinct candidate and insufficient receipt retained; taskAccepted:false.";
            }
          } else {
            // Explicit adversarial step. A's selectors were previously observed
            // in actual model-visible tool content and are replayed verbatim.
            if (turn === 0) {
              call = {
                type: "toolCall",
                id: "daily-adversarial-old-selector",
                name: "agent_execute",
                arguments: {
                  action: "run",
                  runtime: "python",
                  inputIds: [],
                  source: ADVERSARIAL_SOURCE,
                  expectedTaskId: state.taskA.taskId,
                  expectedTaskRevision: state.taskA.taskRevision,
                },
              };
            } else {
              text = "DAILY_ADVERSARIAL_OLD_SELECTOR complete: task A's old selector was rejected.";
            }
          }

          audit({
            type: "model_turn",
            marker,
            step: turn,
            model: { provider: model.provider, api: model.api, id: model.id },
            tools: context.tools.map((tool) => tool.name).sort(),
            agentDeliverSchema: toolSchemaOf(context, "agent_deliver"),
            call: call ?? null,
            lastToolCallId: lastToolMessage?.toolCallId ?? null,
            lastToolName: lastToolMessage?.toolName ?? null,
            lastToolResult: lastToolResult.slice(0, 64000),
            observed: {
              taskA: state.taskA,
              taskB: state.taskB,
              runA: state.runA === null ? null : { runId: state.runA.runId, artifactIds: state.runA.artifactIds },
              runB: state.runB === null ? null : { runId: state.runB.runId, artifactIds: state.runB.artifactIds },
              receiptA: state.receiptA,
              receiptB: state.receiptB,
              previewA: state.previewA === null ? null : { deliveryId: state.previewA.deliveryId },
              previewB: state.previewB === null ? null : { deliveryId: state.previewB.deliveryId },
            },
          });
          if (text !== undefined) audit({ type: "final", marker, text });

          const toolCalls = call ? [call] : [];
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
        } catch (error) {
          audit({ type: "provider_error", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      });
      return stream;
    },
  });
}
