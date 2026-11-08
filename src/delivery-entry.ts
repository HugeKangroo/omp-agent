import { currentTaskOwner, type OmpToolContext } from "./task-entry-port.ts";
import type { TaskOwner } from "./task-owner.ts";
import {
  DELIVERY_BUNDLE_VERSION,
  DeliveryService,
  MAX_DELIVERY_ARTIFACTS,
  MAX_DELIVERY_CONTENT_BYTES,
  MAX_DELIVERY_RESPONSE_BYTES,
  deliveryBoundUtf8,
  deliverySafeText,
  type DeliveryPreviewRequest,
  type DeliveryToolResult,
} from "./delivery-service.ts";

/**
 * G2-B2-A delivery entry. Registers exactly one additional tool when, and only
 * when, the host explicitly configured an absolute deliveryRoot. It creates no
 * second model loop, no scheduler, no acceptance state and no submission path.
 */

export const DELIVERY_TOOL = "agent_deliver";
export const DELIVERY_ENTRY_VERSION = "0.1.0-g2b2a.0";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const FORBIDDEN_DELIVERY_KEYS = new Set([
  "ownerId", "task", "taskId", "digest", "requirementsDigest", "contract",
  "contractId", "profile", "validator", "verifier", "threshold", "thresholds",
  "coverage", "receipt", "receiptId", "archiveRef", "archivePath", "path",
  "filePath", "manifest", "confirmed", "taskAccepted", "parameters", "config",
  "hostConfig", "deliveryRoot", "root", "bytes", "sha256", "verdict", "accepted",
  "deliveryId", "owners", "sessionId", "branch",
]);

export class DeliveryEntryError extends Error {
  override name = "DeliveryEntryError";
}

export interface DeliveryTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: "read" | "write" | "exec";
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpToolContext,
  ): Promise<DeliveryToolResult>;
}

export interface DeliveryApi {
  registerTool(tool: DeliveryTool): void;
}

export type DeliveryArguments =
  | { action: "describe" }
  | { action: "preview"; request: DeliveryPreviewRequest };

export interface DeliveryEntryOptions {
  owner: TaskOwner;
  service: DeliveryService;
}

export interface DeliveryEntryControls {
  dispose(): void;
}

const DELIVERY_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["describe", "preview"],
      description: "Describe delivery/activity coverage, or preview one registered candidate selection as real read-only files.",
    },
    expectedTaskId: {
      type: "string",
      description: "Required for preview. Optimistic identity guard copied from the current host task view; not authority.",
    },
    expectedTaskRevision: {
      type: "integer",
      minimum: 1,
      description: "Required for preview. Optimistic revision guard; the host rechecks the live task and candidate bytes.",
    },
    runId: {
      type: "string",
      description: "Required for preview. The real runId returned by agent_execute; selected artifacts must belong to it.",
    },
    artifactIds: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_DELIVERY_ARTIFACTS,
      description: "Required for preview. One to eight unique artifactIds from that run.",
    },
    verificationReceiptId: {
      type: "string",
      description: "Optional existing receipt selector. It is cross-checked against this exact task/run/candidate set; it is not acceptance evidence.",
    },
  },
  // OMP 18.18 repairs a closed object schema by deleting unknown keys before
  // execute. Passthrough keeps them for the strict parser, which rejects
  // host-authority fields instead of silently normalizing them.
  additionalProperties: true,
  required: ["action"],
} as const;

const DESCRIPTION = "Host-configured candidate delivery preview for the current managed task. describe has no guard parameters: it reports the configured absolute delivery root, the current reachable task identity/revision when available, the current host contract identity/coverage or an explicit none, the adapter's real busy/busyTask/activeRunId/unresolved-completion facts, which authorized capabilities have an activity observer, fixed limits, submissionBlockers, taskAccepted:false, acceptanceImplemented:false and submissionAvailable:false. describe creates no file, runs no verifier and spends no preview capacity. preview requires expectedTaskId, expectedTaskRevision, runId and 1-8 unique artifactIds from that same run; these are optimistic guards, never authority. The host re-reads the live task/revision/binding, resolves the registered candidate snapshot, writes private read-only copies under the host-configured delivery root, verifies the actual bytes and registers them only for this process. It returns the real absolute file paths, names, sizes and sha256 values plus a bounded inline text preview for valid UTF-8 only; binary or invalid UTF-8 is not previewed inline and control characters are escaped. An optional verificationReceiptId must match the exact owner, task, revision, requirements digest, run and full candidate set; it is only an existing receipt selector, never evidence, and a fail or insufficient receipt is reported honestly. No receipt means no receipt was referenced; no contract means no host contract. Preview never submits, accepts, reviews, reserves ownership, verifies, cancels, opens files, or contacts a remote job service. It never creates artifact:// or file:// links. Paths, delivery roots, archives, manifests, digests, contracts, receipts, verdicts and acceptance flags are not accepted from the model; unknown or host-authority fields are refused.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bounded(text: string): string {
  return deliveryBoundUtf8(text, MAX_DELIVERY_CONTENT_BYTES);
}

function responseBytes(result: DeliveryToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function assertEntryResponseBound(result: DeliveryToolResult): void {
  if (responseBytes(result) > MAX_DELIVERY_RESPONSE_BYTES) {
    throw new DeliveryEntryError("The delivery tool response exceeded its fixed byte budget.");
  }
}

function compactFieldList(names: readonly string[]): string {
  if (names.length === 0) return "none";
  const shown = names.slice(0, 3).map((name) => deliveryBoundUtf8(deliverySafeText(name), 64));
  return `${names.length} unsupported field(s): ${shown.join(", ")}${names.length > 3 ? ` (+${names.length - 3} more)` : ""}`;
}

function withheld(reason: string, action: "describe" | "preview"): DeliveryToolResult {
  const result: DeliveryToolResult = {
    content: [{
      type: "text",
      text: bounded([
        `agent_deliver ${action} was withheld`,
        "taskAccepted: false",
        "acceptanceImplemented: false",
        "submissionAvailable: false",
        "withheld: true",
        `reason: ${deliveryBoundUtf8(deliverySafeText(reason), 4096)}`,
      ].join("\n")),
    }],
    details: {
      action,
      taskAccepted: false,
      acceptanceImplemented: false,
      submissionAvailable: false,
      withheld: true,
    },
    isError: true,
  };
  assertEntryResponseBound(result);
  return result;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new DeliveryEntryError(`${label} must be a valid identifier.`);
  }
  return value;
}

/** Strict model-facing parser; every authority-shaped field is rejected. */
export function parseDeliveryArguments(value: unknown): DeliveryArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DeliveryEntryError("agent_deliver arguments must be an object.");
  }
  const args = value as Record<string, unknown>;
  const keys = Object.keys(args);
  const forbidden = keys.filter((key) => FORBIDDEN_DELIVERY_KEYS.has(key));
  if (forbidden.length) {
    throw new DeliveryEntryError(`agent_deliver never accepts host authority fields: ${compactFieldList(forbidden)}.`);
  }
  if (args.action === "describe") {
    const unknown = keys.filter((key) => key !== "action");
    if (unknown.length) throw new DeliveryEntryError(`agent_deliver describe has ${compactFieldList(unknown)}.`);
    return { action: "describe" };
  }
  if (args.action !== "preview") throw new DeliveryEntryError("agent_deliver action must be describe or preview.");
  const allowed = new Set([
    "action", "expectedTaskId", "expectedTaskRevision", "runId", "artifactIds", "verificationReceiptId",
  ]);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length) throw new DeliveryEntryError(`agent_deliver preview has ${compactFieldList(unknown)}.`);
  const expectedTaskId = identifier(args.expectedTaskId, "expectedTaskId");
  if (typeof args.expectedTaskRevision !== "number"
    || !Number.isSafeInteger(args.expectedTaskRevision)
    || args.expectedTaskRevision <= 0) {
    throw new DeliveryEntryError("expectedTaskRevision must be a positive integer required by preview.");
  }
  const runId = identifier(args.runId, "runId");
  if (!Array.isArray(args.artifactIds)
    || args.artifactIds.length < 1
    || args.artifactIds.length > MAX_DELIVERY_ARTIFACTS) {
    throw new DeliveryEntryError(`artifactIds must select 1-${MAX_DELIVERY_ARTIFACTS} artifacts from one run.`);
  }
  const artifactIds = args.artifactIds.map((item) => identifier(item, "artifactId"));
  if (new Set(artifactIds).size !== artifactIds.length) throw new DeliveryEntryError("artifactIds must be unique.");
  const verificationReceiptId = args.verificationReceiptId === undefined
    ? undefined
    : identifier(args.verificationReceiptId, "verificationReceiptId");
  return {
    action: "preview",
    request: {
      expectedTaskId,
      expectedTaskRevision: args.expectedTaskRevision,
      runId,
      artifactIds,
      ...(verificationReceiptId === undefined ? {} : { verificationReceiptId }),
    },
  };
}

export function createDeliveryEntry(pi: DeliveryApi, options: DeliveryEntryOptions): DeliveryEntryControls {
  const owner = options.owner;
  const service = options.service;
  if (currentTaskOwner() !== owner) {
    throw new DeliveryEntryError("The published task owner is not the owner this delivery entry was created for.");
  }
  let disposed = false;

  const tool: DeliveryTool = {
    name: DELIVERY_TOOL,
    label: "Candidate delivery preview",
    description: DESCRIPTION,
    parameters: DELIVERY_PARAMETERS,
    approval: "write",
    loadMode: "essential",
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (disposed) return withheld("the delivery entry is disposed; no file was created or read.", "preview");
      if (currentTaskOwner() !== owner) {
        return withheld("the managed task owner changed; this delivery entry can no longer act.", "preview");
      }
      let parsed: DeliveryArguments;
      try {
        parsed = parseDeliveryArguments(params);
      } catch (error) {
        return withheld(errorMessage(error), "preview");
      }
      try {
        if (parsed.action === "describe") {
          const described = service.describe(context);
          assertEntryResponseBound(described);
          return described;
        }
        if (signal?.aborted) {
          return withheld("the call was aborted before the delivery service acted; no file was created.", "preview");
        }
        const outcome = await service.preview(context, parsed.request, signal);
        if (signal?.aborted) {
          return withheld("the call was aborted before the delivery response became visible; no path or preview text is shown.", "preview");
        }
        if (outcome.task !== undefined) {
          // Last synchronous authority read before assembling the visible
          // response. A changed task hides the old paths and preview text in
          // both content and details.
          const guard = service.finalGuard(context, outcome.task);
          if (guard !== null) return withheld(`preview was withheld: ${guard}.`, "preview");
        }
        if (signal?.aborted) {
          return withheld("the call was aborted before the delivery response became visible; no path or preview text is shown.", "preview");
        }
        assertEntryResponseBound(outcome.result);
        return outcome.result;
      } catch (error) {
        try {
          process.stderr.write(`${JSON.stringify({
            type: "omp_agent_delivery",
            message: "tool_failed",
            error: errorMessage(error).slice(0, 1000),
          })}\n`);
        } catch {
          // A diagnostic channel is not guaranteed.
        }
        return withheld(
          "delivery was withheld because the current context or files could not be proven.",
          parsed.action,
        );
      }
    },
  };

  try {
    pi.registerTool(tool);
  } catch (error) {
    disposed = true;
    service.dispose();
    throw error;
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      service.dispose();
    },
  };
}

export { DELIVERY_BUNDLE_VERSION };
