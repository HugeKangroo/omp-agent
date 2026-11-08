import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createExecutionEntry } from "../../src/execution-entry.ts";
import { currentTaskOwner } from "../../src/task-entry-port.ts";
import { createObserver } from "./human-review-native-observe.mjs";

/**
 * Native hybrid case host. The real `src/task-entry.ts` is loaded first as its
 * own extension; this fixture then constructs exactly one real
 * createExecutionEntry around the published owner with a fixed partial
 * semantic contract and the explicit local-main-tui human-review option. It
 * does not load the default execution entry, publish an owner, accept, approve
 * or call requestHumanReview directly.
 */

const root = process.env.REVIEW_NATIVE_ROOT;
const inputRoot = process.env.REVIEW_NATIVE_INPUT_ROOT;
const auditPath = process.env.REVIEW_NATIVE_HOST_AUDIT;
const secret = "NATIVE_REVIEW_FIXTURE_PARAMETER_MUST_NOT_REACH_THE_MODEL";
if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("REVIEW_NATIVE_ROOT must be absolute");
if (typeof inputRoot !== "string" || !path.isAbsolute(inputRoot)) throw new Error("REVIEW_NATIVE_INPUT_ROOT must be absolute");
if (typeof auditPath !== "string" || !path.isAbsolute(auditPath)) throw new Error("REVIEW_NATIVE_HOST_AUDIT must be absolute");

const expectedFiles = new Map([
  ["alpha.txt", readFileSync(path.join(inputRoot, "alpha.txt"))],
  ["beta.txt", readFileSync(path.join(inputRoot, "beta.txt"))],
]);
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const audit = (type, fields = {}) => {
  appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), source: "hybrid-host", type, ...fields })}\n`);
};
const contentText = (content) => typeof content === "string"
  ? content
  : (content || []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");

export default function humanReviewNativeHybridHost(pi) {
  const owner = currentTaskOwner();
  if (!owner) throw new Error("the hybrid host requires the actual published task owner");
  const observer = createObserver(pi, { role: "hybrid-host" });
  observer.installEvents();
  observer.installCommands();

  const inputs = JSON.parse(process.env.OMP_AGENT_EXECUTION_INPUTS || "[]");
  let context;
  let verifierCalls = 0;
  const verifier = {
    id: "native-review-fixture-exact-bytes",
    version: "1",
    async check(input) {
      verifierCalls += 1;
      const rows = [];
      let pass = true;
      for (const [name, expected] of expectedFiles) {
        const artifact = input.candidate.artifacts.find((item) => item.relativePath === name);
        const actual = artifact?.data ?? Buffer.alloc(0);
        const match = artifact !== undefined && Buffer.compare(actual, expected) === 0;
        if (!match) pass = false;
        rows.push({
          name,
          artifactId: artifact?.artifactId ?? null,
          bytes: artifact?.bytes ?? null,
          sha256: artifact?.sha256 ?? null,
          actualBytes: actual.length,
          actualSha256: sha256(actual),
          expectedBytes: expected.length,
          expectedSha256: sha256(expected),
          match,
        });
      }
      audit("validator", {
        call: verifierCalls,
        task: input.task,
        runId: input.candidate.runId,
        pass,
        files: rows,
      });
      return {
        conditions: [{
          conditionId: "exact-file-bytes",
          result: pass ? "pass" : "fail",
          detail: "both delivered files must equal the authorized input bytes",
        }],
      };
    },
  };

  const controls = createExecutionEntry(observer.api, {
    root: process.env.OMP_AGENT_EXECUTION_ROOT,
    inputs,
    capabilityId: "local-script",
    auditPath: process.env.OMP_AGENT_EXECUTION_AUDIT_PATH,
    dispatchWallMs: 5000,
    terminationGraceMs: 100,
    trustedVerifiers: [verifier],
    deliveryRoot: process.env.OMP_AGENT_DELIVERY_ROOT,
    acceptanceRoot: process.env.OMP_AGENT_ACCEPTANCE_ROOT,
    humanReview: { kind: "local-main-tui", policyVersion: 1 },
  });
  observer.audit("host_entry_created", { count: 1, verifierId: verifier.id });

  const unsubscribe = owner.subscribe((event) => {
    if (event.type !== "task_started") return;
    try {
      if (!context) throw new Error("no actual agent context was captured before task_started");
      const task = owner.snapshot().currentTask;
      if (!task || task.status !== "active") throw new Error("no active task at task_started");
      const contract = controls.bindContract(context, {
        hostConfig: { id: "native-review-fixture-host", version: "1" },
        verifier: {
          id: verifier.id,
          version: verifier.version,
          parameters: { fixtureSecret: secret },
        },
        conditions: [{
          conditionId: "exact-file-bytes",
          description: "both delivered files equal the authorized input bytes",
          kind: "semantic",
          coveredRevisions: [task.taskRevision],
        }],
        coverage: {
          kind: "semantic",
          complete: false,
          coveredRevisions: [task.taskRevision],
          statement: "Partial synthetic coverage: exact file bytes only; presentation and arbitrary requirement semantics are not automatically established.",
        },
      });
      audit("contract_bound", {
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        contractId: contract.contractId,
        digest: contract.digest,
        complete: contract.coverage.complete,
        coverageKind: contract.coverage.kind,
        coveredRevisions: contract.coverage.coveredRevisions,
        statement: contract.coverage.statement,
        conditionCount: contract.conditions.length,
      });
    } catch (error) {
      audit("contract_bind_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  pi.on("before_agent_start", (_event, nextContext) => {
    context = nextContext;
    return undefined;
  });

  pi.on("tool_result", async (event, toolContext) => {
    if (event.toolName !== "agent_verify" || event.input?.action !== "verify") return undefined;
    const receiptId = /^receiptId: (\S+)$/m.exec(contentText(event.content))?.[1];
    if (!receiptId) return undefined;
    try {
      const lookup = await controls.lookup(toolContext, receiptId);
      audit("host_receipt", { receiptId, lookup });
    } catch (error) {
      audit("host_receipt_failed", {
        receiptId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  });

  pi.on("agent_end", () => {
    context = undefined;
    audit("agent_end_fixture", { verifierCalls, owner: owner.snapshot() });
    return undefined;
  });

  pi.on("session_shutdown", () => {
    context = undefined;
    unsubscribe();
    audit("session_shutdown_fixture", { verifierCalls, owner: owner.snapshot() });
    return undefined;
  });

  audit("fixture_ready", {
    deliveryRoot: process.env.OMP_AGENT_DELIVERY_ROOT,
    acceptanceRoot: process.env.OMP_AGENT_ACCEPTANCE_ROOT,
    verifierId: verifier.id,
    humanReview: "local-main-tui-v1",
  });
}
