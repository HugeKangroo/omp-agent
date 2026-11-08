import { appendFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createExecutionEntry } from "../../src/execution-entry.ts";
import { currentTaskOwner } from "../../src/task-entry-port.ts";

/**
 * Native delivery host fixture. The real `src/task-entry.ts` is loaded first as
 * its own OMP extension; this file is loaded second and composes the actual
 * execution/delivery chain around the published owner. It supplies only
 * synthetic host policy (contract, verifier, roots), never accepted state,
 * receipts, candidate registries or a second model loop.
 */

const root = process.env.DELIVERY_FIXTURE_ROOT;
const mode = process.env.DELIVERY_FIXTURE_MODE;
const inputPath = process.env.DELIVERY_FIXTURE_INPUT_PATH;
const auditPath = process.env.DELIVERY_FIXTURE_AUDIT;
if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("DELIVERY_FIXTURE_ROOT must be absolute");
if (mode !== "full" && mode !== "partial" && mode !== "delivery-only") throw new Error("DELIVERY_FIXTURE_MODE is unsupported");
if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) throw new Error("DELIVERY_FIXTURE_INPUT_PATH must be absolute");
if (typeof auditPath !== "string" || !path.isAbsolute(auditPath)) throw new Error("DELIVERY_FIXTURE_AUDIT must be absolute");

const deliveryRoot = path.join(root, "delivery");
const acceptanceRoot = mode === "delivery-only" ? null : path.join(root, "acceptance");
const answerPrefix = Buffer.from("DELIVERY_OK\n", "utf8");
const expectedAnswer = Buffer.concat([answerPrefix, readFileSync(inputPath)]);
const secret = "DELIVERY_FIXTURE_SECRET_MUST_NOT_EXPORT";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const audit = (value) => {
  appendFileSync(auditPath, `${JSON.stringify({ timestamp: new Date().toISOString(), mode, ...value })}\n`);
};

const contentText = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");

/**
 * Test-owned bounded snapshot of actual files. It never follows a symlink and
 * never copies more than the tiny fixture roots produced by this suite.
 */
function snapshot(rootDir) {
  const rows = [];
  const walk = (dir, depth) => {
    if (depth > 5) throw new Error("delivery fixture snapshot depth bound exceeded");
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("delivery fixture snapshot refuses symlink");
      if (info.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!info.isFile() || rows.length >= 64 || info.size > 1024 * 1024) {
        throw new Error("delivery fixture snapshot file bound exceeded");
      }
      const bytes = readFileSync(full);
      rows.push({
        path: full,
        relativePath: path.relative(rootDir, full),
        bytes: bytes.length,
        sha256: sha256(bytes),
        ino: info.ino,
        dev: info.dev,
        mtimeMs: info.mtimeMs,
        nlink: info.nlink,
        mode: info.mode & 0o777,
        text: bytes.toString("utf8"),
      });
    }
  };
  walk(rootDir, 0);
  return rows;
}

const files = () => ({
  delivery: snapshot(deliveryRoot),
  acceptance: acceptanceRoot === null ? [] : snapshot(acceptanceRoot),
});

export default function deliveryHostFixture(pi) {
  const owner = currentTaskOwner();
  if (!owner) throw new Error("delivery host requires the actual published task owner");
  const inputs = JSON.parse(process.env.OMP_AGENT_EXECUTION_INPUTS || "[]");
  let context;
  let verifierCalls = 0;
  const verifier = {
    id: "delivery-fixture-exact",
    version: "1",
    async check(input) {
      verifierCalls += 1;
      const artifact = input.candidate.artifacts.find((item) => item.relativePath === "answer.txt");
      const actual = artifact?.data ?? Buffer.alloc(0);
      const pass = artifact !== undefined && Buffer.compare(actual, expectedAnswer) === 0;
      audit({
        type: "validator",
        call: verifierCalls,
        task: input.task,
        runId: input.candidate.runId,
        artifactId: artifact?.artifactId ?? null,
        artifactBytes: artifact?.bytes ?? null,
        artifactSha256: artifact?.sha256 ?? null,
        actualBytes: actual.length,
        actualSha256: sha256(actual),
        pass,
      });
      return {
        conditions: [{
          conditionId: "answer-bytes",
          result: pass ? "pass" : "fail",
          detail: "exact answer.txt bytes are the fixed prefix plus the authorized alpha input bytes",
        }],
      };
    },
  };

  const controls = createExecutionEntry(pi, {
    root: process.env.OMP_AGENT_EXECUTION_ROOT,
    inputs,
    capabilityId: "local-script",
    auditPath: process.env.OMP_AGENT_EXECUTION_AUDIT_PATH,
    dispatchWallMs: 5000,
    terminationGraceMs: 100,
    trustedVerifiers: [verifier],
    deliveryRoot,
    ...(acceptanceRoot === null ? {} : { acceptanceRoot }),
  });

  const unsubscribe = owner.subscribe((event) => {
    audit({ type: "owner_event", event, owner: owner.snapshot(), ...files() });
    if (event.type !== "task_started" || mode === "delivery-only") return;
    try {
      if (!context) throw new Error("no actual agent context was captured before task start");
      const task = owner.snapshot().currentTask;
      if (!task || task.status !== "active") throw new Error("no active task at task_started");
      const contract = controls.bindContract(context, {
        hostConfig: { id: "delivery-fixture-host", version: "1" },
        verifier: { id: verifier.id, version: verifier.version, parameters: { fixtureSecret: secret } },
        conditions: [{
          conditionId: "answer-bytes",
          description: "answer.txt equals the fixed prefix plus the actual authorized input bytes",
          kind: "semantic",
          coveredRevisions: [task.taskRevision],
        }],
        coverage: {
          kind: "semantic",
          complete: mode === "full",
          coveredRevisions: [task.taskRevision],
          statement: mode === "full"
            ? "Complete only for this synthetic one-file fixture requirement."
            : "Partial fixture coverage: byte equality does not cover presentation or arbitrary requirements.",
        },
      });
      audit({
        type: "contract_bound",
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        contractId: contract.contractId,
        digest: contract.digest,
        complete: contract.coverage.complete,
      });
    } catch (error) {
      audit({ type: "contract_bind_failed", error: String(error) });
    }
  });

  pi.on("before_agent_start", (_event, nextContext) => {
    context = nextContext;
    return undefined;
  });

  pi.on("tool_result", async (event, toolContext) => {
    const content = contentText(event.content);
    audit({
      type: "tool_observation",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: content.slice(0, 64000),
      owner: owner.snapshot(),
      ...files(),
    });
    if (event.toolName === "agent_verify" && event.input?.action === "verify") {
      const receiptId = /^receiptId: (\S+)$/m.exec(content)?.[1];
      if (receiptId) {
        try {
          audit({ type: "host_receipt", receiptId, lookup: await controls.lookup(toolContext, receiptId) });
        } catch (error) {
          audit({ type: "host_receipt_failed", receiptId, error: String(error) });
        }
      }
    }
    return undefined;
  });

  pi.on("agent_end", () => {
    context = undefined;
    audit({
      type: "agent_end_fixture",
      owner: owner.snapshot(),
      verifierCalls,
      activity: controls.adapter.activitySnapshot(),
      ...files(),
    });
    return undefined;
  });

  pi.on("session_shutdown", () => {
    context = undefined;
    unsubscribe();
    audit({
      type: "session_shutdown_fixture",
      owner: owner.snapshot(),
      verifierCalls,
      ...files(),
    });
    return undefined;
  });

  audit({
    type: "fixture_ready",
    deliveryRoot,
    acceptanceRoot,
    verifierId: verifier.id,
    verifierCalls,
  });
}
