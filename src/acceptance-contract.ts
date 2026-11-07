import { createHash, randomUUID } from "node:crypto";
import { encodedUtf8Bytes, requirementsDigest } from "./task-requirements.ts";
import type { FrozenTaskRef } from "./execution-candidates.ts";
import type { ManagedTask } from "./task-owner.ts";

/**
 * Host-only, immutable acceptance contracts for G2-B1a.
 *
 * Only host code can bind a contract. The requirements identity is recomputed
 * from the owner's current ledger; neither the caller's digest nor model text
 * authorizes a contract. A contract records a sourced host coverage claim; it
 * does not turn file-integrity checks into semantic proof.
 */

export const ACCEPTANCE_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ACCEPTANCE_CONTRACT_VERSION = "acceptance-contract-v1" as const;
export const MAX_CONTRACTS_PER_TASK = 32;
export const MAX_CONDITIONS_PER_CONTRACT = 16;
export const MAX_CONTRACT_BYTES = 32 * 1024;
export const MAX_CONDITION_DESCRIPTION_CHARS = 2000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class AcceptanceContractError extends Error {
  override name = "AcceptanceContractError";
}

export type AcceptanceCoverageKind = "semantic" | "integrity";

export interface AcceptanceCondition {
  conditionId: string;
  description: string;
  /** Host declaration: a semantic requirement check or only integrity data. */
  kind: AcceptanceCoverageKind;
  /** Requirement source revisions this condition claims to cover. */
  coveredRevisions: number[];
}

export interface AcceptanceCoverage {
  /** Integrity-only coverage can never establish complete semantic acceptance. */
  kind: AcceptanceCoverageKind;
  /**
   * Host declaration; true asserts complete host coverage of the original task
   * semantics. Only true requires every frozen source revision to be listed;
   * false is an honest conservative claim even when the listed revisions
   * happen to name every source revision.
   */
  complete: boolean;
  /**
   * Requirement source revisions associated with this claim. Listing every
   * source revision is not, by itself, proof that every semantic requirement
   * in the original text is covered.
   */
  coveredRevisions: number[];
  /** Host-authored scope statement. Never a model score. */
  statement: string;
}

export interface TrustedContractSpec {
  hostConfig: { id: string; version: string };
  verifier: {
    id: string;
    version: string;
    /** Immutable host configuration supplied to the trusted implementation. */
    parameters?: unknown;
  };
  conditions: readonly AcceptanceCondition[];
  coverage: AcceptanceCoverage;
}

export interface AcceptanceContract {
  schemaVersion: typeof ACCEPTANCE_CONTRACT_SCHEMA_VERSION;
  contractId: string;
  task: FrozenTaskRef;
  hostConfig: { id: string; version: string };
  verifier: {
    id: string;
    version: string;
    parametersDigest: string;
    parameters: unknown;
  };
  conditions: AcceptanceCondition[];
  coverage: AcceptanceCoverage;
  /** Stable digest of this contract's normalized content. */
  digest: string;
  boundAt: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new AcceptanceContractError("Contract value is not JSON-encodable.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function cloneJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new AcceptanceContractError("Contract value is not JSON-encodable.");
  return JSON.parse(encoded) as T;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AcceptanceContractError(`${label} is not a valid identifier.`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    throw new AcceptanceContractError(`${label} must be a non-empty string of at most ${maxChars} characters.`);
  }
  return value;
}

function revisionList(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new AcceptanceContractError(`${label} must be a bounded revision array.`);
  }
  const revisions = value.map((item) => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
      throw new AcceptanceContractError(`${label} must contain positive integer revisions.`);
    }
    return item;
  });
  if (new Set(revisions).size !== revisions.length) {
    throw new AcceptanceContractError(`${label} must not contain duplicate revisions.`);
  }
  return [...revisions].sort((left, right) => left - right);
}

function normalizeTask(task: FrozenTaskRef): FrozenTaskRef {
  if (typeof task !== "object" || task === null) throw new AcceptanceContractError("Frozen task reference must be an object.");
  const ownerId = identifier(task.ownerId, "ownerId");
  const taskId = identifier(task.taskId, "taskId");
  if (!Number.isSafeInteger(task.taskRevision) || task.taskRevision <= 0) {
    throw new AcceptanceContractError("taskRevision must be a positive integer.");
  }
  if (typeof task.requirementsDigest !== "string" || !/^requirements-digest-v1:sha256:[0-9a-f]{64}$/.test(task.requirementsDigest)) {
    throw new AcceptanceContractError("requirementsDigest is not a frozen requirements-digest-v1 value.");
  }
  return {
    ownerId,
    taskId,
    taskRevision: task.taskRevision,
    requirementsDigest: task.requirementsDigest,
  };
}

function sameTask(left: FrozenTaskRef, right: FrozenTaskRef): boolean {
  return left.ownerId === right.ownerId
    && left.taskId === right.taskId
    && left.taskRevision === right.taskRevision
    && left.requirementsDigest === right.requirementsDigest;
}

function copyTask(task: FrozenTaskRef): FrozenTaskRef {
  return { ...task };
}

function copyContract(contract: AcceptanceContract): AcceptanceContract {
  return {
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    task: copyTask(contract.task),
    hostConfig: { ...contract.hostConfig },
    verifier: {
      id: contract.verifier.id,
      version: contract.verifier.version,
      parametersDigest: contract.verifier.parametersDigest,
      parameters: cloneJson(contract.verifier.parameters),
    },
    conditions: contract.conditions.map((condition) => ({
      conditionId: condition.conditionId,
      description: condition.description,
      kind: condition.kind,
      coveredRevisions: [...condition.coveredRevisions],
    })),
    coverage: {
      kind: contract.coverage.kind,
      complete: contract.coverage.complete,
      coveredRevisions: [...contract.coverage.coveredRevisions],
      statement: contract.coverage.statement,
    },
    digest: contract.digest,
    boundAt: contract.boundAt,
  };
}

function normalizeSpec(spec: TrustedContractSpec): Omit<AcceptanceContract, "schemaVersion" | "contractId" | "task" | "digest" | "boundAt"> {
  if (typeof spec !== "object" || spec === null) throw new AcceptanceContractError("Contract spec must be an object.");
  if (typeof spec.hostConfig !== "object" || spec.hostConfig === null) {
    throw new AcceptanceContractError("Contract hostConfig must be an object.");
  }
  if (typeof spec.verifier !== "object" || spec.verifier === null) {
    throw new AcceptanceContractError("Contract verifier must be an object.");
  }
  if (typeof spec.coverage !== "object" || spec.coverage === null) {
    throw new AcceptanceContractError("Contract coverage must be an object.");
  }
  if (!Array.isArray(spec.conditions) || spec.conditions.length > MAX_CONDITIONS_PER_CONTRACT) {
    throw new AcceptanceContractError(`A contract has at most ${MAX_CONDITIONS_PER_CONTRACT} conditions.`);
  }
  const hostConfig = {
    id: identifier(spec.hostConfig.id, "hostConfig.id"),
    version: identifier(spec.hostConfig.version, "hostConfig.version"),
  };
  const verifierId = identifier(spec.verifier.id, "verifier.id");
  const verifierVersion = identifier(spec.verifier.version, "verifier.version");
  const parameters = spec.verifier.parameters === undefined ? null : cloneJson(spec.verifier.parameters);
  const parametersDigest = `verifier-parameters-v1:sha256:${createHash("sha256").update(canonicalJson(parameters), "utf8").digest("hex")}`;
  const seen = new Set<string>();
  const conditions = spec.conditions.map((condition) => {
    if (typeof condition !== "object" || condition === null) {
      throw new AcceptanceContractError("Each contract condition must be an object.");
    }
    const conditionId = identifier(condition.conditionId, "condition.conditionId");
    if (seen.has(conditionId)) throw new AcceptanceContractError(`Condition id is duplicated: ${conditionId}.`);
    seen.add(conditionId);
    if (condition.kind !== "semantic" && condition.kind !== "integrity") {
      throw new AcceptanceContractError(`Condition ${conditionId} kind must be semantic or integrity.`);
    }
    return {
      conditionId,
      description: boundedText(condition.description, `condition ${conditionId} description`, MAX_CONDITION_DESCRIPTION_CHARS),
      kind: condition.kind,
      coveredRevisions: revisionList(condition.coveredRevisions, `condition ${conditionId} coveredRevisions`),
    };
  });
  if (spec.coverage.kind !== "semantic" && spec.coverage.kind !== "integrity") {
    throw new AcceptanceContractError("Coverage kind must be semantic or integrity.");
  }
  const coverage = {
    kind: spec.coverage.kind,
    complete: spec.coverage.complete === true,
    coveredRevisions: revisionList(spec.coverage.coveredRevisions, "coverage.coveredRevisions"),
    statement: boundedText(spec.coverage.statement, "coverage.statement", MAX_CONDITION_DESCRIPTION_CHARS),
  };
  return {
    hostConfig,
    verifier: { id: verifierId, version: verifierVersion, parametersDigest, parameters },
    conditions,
    coverage,
  };
}

function contractDigest(task: FrozenTaskRef, normalized: Omit<AcceptanceContract, "schemaVersion" | "contractId" | "task" | "digest" | "boundAt">): string {
  const encoded = JSON.stringify({
    version: ACCEPTANCE_CONTRACT_VERSION,
    task,
    hostConfig: normalized.hostConfig,
    verifier: {
      id: normalized.verifier.id,
      version: normalized.verifier.version,
      parametersDigest: normalized.verifier.parametersDigest,
    },
    conditions: normalized.conditions.map((condition) => ({
      conditionId: condition.conditionId,
      description: condition.description,
      kind: condition.kind,
      coveredRevisions: condition.coveredRevisions,
    })),
    coverage: normalized.coverage,
  });
  return `${ACCEPTANCE_CONTRACT_VERSION}:sha256:${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

export class AcceptanceContractStore {
  private readonly contracts = new Map<string, { contract: AcceptanceContract; fingerprint: string }>();
  private readonly currentTask: () => ManagedTask | null;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options: { currentTask: () => ManagedTask | null; now?: () => string; id?: () => string }) {
    this.currentTask = options.currentTask;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.id ?? (() => randomUUID());
  }

  /**
   * Host callbacks (`id`, `now`) can synchronously revise or cancel the owner.
   * Re-read the live ledger after the last callback and immediately before a
   * successful return or commit. A changed eligibility must not return or
   * store a contract under the old task/revision key.
   */
  private assertEligible(task: FrozenTaskRef, stage: string): void {
    const live = this.currentTask();
    if (!live) {
      throw new AcceptanceContractError(`No current owner task exists ${stage}.`);
    }
    if (live.status !== "active") {
      throw new AcceptanceContractError(`The owner task is no longer active ${stage}.`);
    }
    const liveTask: FrozenTaskRef = {
      ownerId: live.ownerId,
      taskId: live.taskId,
      taskRevision: live.taskRevision,
      requirementsDigest: requirementsDigest(live.requirementSources),
    };
    if (!sameTask(liveTask, task)) {
      throw new AcceptanceContractError(`The owner's current task/revision/requirements identity changed ${stage}.`);
    }
  }

  /**
   * Host-only binding. The frozen task and digest are checked against the
   * owner's ledger at this moment; a stale caller value cannot bind.
   */
  bindContract(
    expectedTask: FrozenTaskRef,
    expectedRequirementsDigest: string,
    trustedSpec: TrustedContractSpec,
  ): AcceptanceContract {
    const task = normalizeTask(expectedTask);
    if (typeof expectedRequirementsDigest !== "string" || expectedRequirementsDigest !== task.requirementsDigest) {
      throw new AcceptanceContractError("The supplied requirements digest does not match the frozen task reference.");
    }
    if (encodedUtf8Bytes(trustedSpec) > MAX_CONTRACT_BYTES) {
      throw new AcceptanceContractError(`The trusted contract spec exceeds ${MAX_CONTRACT_BYTES} UTF-8 bytes.`);
    }
    const live = this.currentTask();
    if (!live) throw new AcceptanceContractError("No current owner task exists to bind a contract.");
    if (live.status !== "active") throw new AcceptanceContractError("A cancelled task cannot bind an acceptance contract.");
    const liveTask: FrozenTaskRef = {
      ownerId: live.ownerId,
      taskId: live.taskId,
      taskRevision: live.taskRevision,
      requirementsDigest: requirementsDigest(live.requirementSources),
    };
    if (!sameTask(liveTask, task)) {
      throw new AcceptanceContractError("The owner's current task/revision/requirements identity does not match the frozen reference.");
    }
    const normalized = normalizeSpec(trustedSpec);
    const actualRevisions = live.requirementSources
      .map((source) => source.revision)
      .sort((left, right) => left - right);
    const actualSet = new Set(actualRevisions);
    for (const revision of normalized.coverage.coveredRevisions) {
      if (!actualSet.has(revision)) {
        throw new AcceptanceContractError(`Coverage names requirement revision ${revision}, which is not in the frozen ledger.`);
      }
    }
    // Source revision ids are associations, not semantic proof. A conservative
    // complete:false claim stays admissible even when it names every source
    // revision; verification still treats it as insufficient. Only a
    // complete:true host claim must name every frozen source revision.
    if (normalized.coverage.complete) {
      const coveredSet = new Set(normalized.coverage.coveredRevisions);
      const completeClaimHolds = actualRevisions.length > 0
        && actualRevisions.every((revision) => coveredSet.has(revision));
      if (!completeClaimHolds) {
        throw new AcceptanceContractError("The host coverage claim declares completeness without naming every frozen requirement revision.");
      }
    }
    for (const condition of normalized.conditions) {
      for (const revision of condition.coveredRevisions) {
        if (!actualSet.has(revision)) {
          throw new AcceptanceContractError(`Condition ${condition.conditionId} names an unknown requirement revision ${revision}.`);
        }
      }
    }
    const fingerprint = contractDigest(task, normalized);
    const key = `${task.taskId}\0${task.taskRevision}`;
    const existing = this.contracts.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        this.assertEligible(task, "before returning the existing binding");
        return copyContract(existing.contract);
      }
      throw new AcceptanceContractError("A different immutable contract is already bound for this task revision.");
    }
    let taskContracts = 0;
    for (const item of this.contracts.values()) {
      if (item.contract.task.taskId === task.taskId) taskContracts += 1;
    }
    if (taskContracts >= MAX_CONTRACTS_PER_TASK) {
      throw new AcceptanceContractError(`Task ${task.taskId} already has ${MAX_CONTRACTS_PER_TASK} contract records.`);
    }
    const contract: AcceptanceContract = {
      schemaVersion: ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
      contractId: `contract-${this.newId()}`,
      task: copyTask(task),
      hostConfig: { ...normalized.hostConfig },
      verifier: {
        id: normalized.verifier.id,
        version: normalized.verifier.version,
        parametersDigest: normalized.verifier.parametersDigest,
        parameters: normalized.verifier.parameters,
      },
      conditions: normalized.conditions.map((condition) => ({
        conditionId: condition.conditionId,
        description: condition.description,
        kind: condition.kind,
        coveredRevisions: [...condition.coveredRevisions],
      })),
      coverage: {
        kind: normalized.coverage.kind,
        complete: normalized.coverage.complete,
        coveredRevisions: [...normalized.coverage.coveredRevisions],
        statement: normalized.coverage.statement,
      },
      digest: fingerprint,
      boundAt: this.now(),
    };
    if (encodedUtf8Bytes(contract) > MAX_CONTRACT_BYTES) {
      throw new AcceptanceContractError(`The bound contract exceeds ${MAX_CONTRACT_BYTES} UTF-8 bytes.`);
    }
    // `newId`/`now` above are host callbacks. Re-read after the last of them
    // and immediately before commit; do not store a stale binding.
    this.assertEligible(task, "before committing the binding");
    this.contracts.set(key, { contract, fingerprint });
    return copyContract(contract);
  }

  /** Read-only lookup by exact frozen identity; returns a defensive copy. */
  contractFor(task: FrozenTaskRef): AcceptanceContract | null {
    const normalized = normalizeTask(task);
    const item = this.contracts.get(`${normalized.taskId}\0${normalized.taskRevision}`);
    if (!item) return null;
    if (item.contract.task.ownerId !== normalized.ownerId
      || item.contract.task.taskRevision !== normalized.taskRevision
      || item.contract.task.requirementsDigest !== normalized.requirementsDigest) {
      return null;
    }
    return copyContract(item.contract);
  }
}
