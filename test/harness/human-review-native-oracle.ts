import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Independent off-line oracle for the native human-review audit.
 *
 * It does not import product code or the tested formatter. Dynamic identities
 * are bound from actual tool content, the published owner snapshot and
 * physical delivery/acceptance bytes. The expected evidence grammar is written
 * here from the frozen public contract; the file/requirement safe text is read
 * from the separately frozen oracle fixture.
 */

export interface NativeCorpusFile {
  name: string;
  rawText: string;
  expectedSafeText: string;
  bytes: number;
  sha256: string;
}

export interface NativeCorpus {
  displayVersion: string;
  escapeVersion: string;
  literalEscapeMarker: string;
  requirements: Array<{ revision: number; rawText: string; expectedSafeText: string; rawBytes: number }>;
  files: NativeCorpusFile[];
  prompts: { task: string; revision: string };
  notes: string[];
}

export interface ExpectedOracle {
  sourceSha256: string;
  displayVersion: string;
  escapeVersion: string;
  fixtureSha256?: string;
  files: Array<{ name: string; bytes: number; sha256: string; expectedSafeText: string }>;
  requirements: Array<{ revision: number; rawBytes: number; expectedSafeText: string }>;
  notes: string[];
  limitations: { noContract: string[]; hybridPartial: string[] };
  grammar: Record<string, any>;
}

export interface ExpectedLayoutLine {
  text: string;
  oracleId: string | null;
}

export interface NativeEvent {
  type: string;
  [key: string]: any;
}

export interface NativeEvidence {
  evidenceRoot: string;
  driver: Record<string, any>;
  audit: NativeEvent[];
  provider: NativeEvent[];
  host: NativeEvent[];
  owner: Record<string, any>;
  delivery: Map<string, Buffer>;
  acceptance: Map<string, Buffer>;
  execution: Map<string, Buffer>;
  inputs: Map<string, Buffer>;
  executionAudit: NativeEvent[];
}

export interface BoundProvenance {
  source: { bytes: number; sha256: string };
  inputs: Array<{ id: string; bytes: number; sha256: string }>;
  artifacts: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }>;
  runId: string;
  callId: string;
}

export interface ExpectedDocument {
  model: Record<string, any>;
  lines: string[];
  layout: ExpectedLayoutLine[];
  digest: string;
  renderedBytes: number;
  rawContentBytes: number;
  fileCount: number;
  requirementRevisions: number[];
  expiresAt: string;
  preview: ParsedPreview;
  provenance: BoundProvenance;
  fixtureSha256: string;
  originalReceipt: Record<string, any> | null;
  originalReceiptDigest: string | null;
}

export interface ParsedPreview {
  task: Record<string, any>;
  runId: string;
  deliveryId: string;
  previewDigest: string;
  source: Record<string, any>;
  inputs: Array<Record<string, any>>;
  files: Array<Record<string, any>>;
  manifest: { path: string; bytes: number; sha256: string };
  requirements: { path: string; bytes: number; sha256: string };
  contract: Record<string, any>;
  verification: Record<string, any>;
}

export interface OracleResult {
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  firstMismatch: Record<string, any> | null;
  missingEvidence: string[];
  expected: ExpectedDocument | null;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const FORMAT_CONTROL = (code: number): boolean => code === 0x00ad
  || code === 0x061c
  || code === 0x180e
  || (code >= 0x200b && code <= 0x200f)
  || (code >= 0x2028 && code <= 0x202e)
  || (code >= 0x2060 && code <= 0x206f)
  || code === 0xfeff
  || (code >= 0xfff9 && code <= 0xfffb)
  || (code >= 0xe0000 && code <= 0xe007f);

/** Independent copy of the documented safe-text v2 transform. */
export function safeText(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (character === "\n") {
      result += character;
    } else if (character === "⟦") {
      result += "⟦U+27E6⟧";
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || FORMAT_CONTROL(code)) {
      result += `⟦U+${code.toString(16).toUpperCase().padStart(code <= 0xffff ? 4 : 6, "0")}⟧`;
    } else {
      result += character;
    }
  }
  return result;
}

export async function readJsonLines(filePath: string): Promise<NativeEvent[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.split("\n").filter(Boolean).map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`JSONL line ${index + 1} is not an object`);
      }
      return value as NativeEvent;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readTree(root: string, label: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) throw new Error(`${label} tree depth exceeded`);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error(`${label} tree refuses symlink`);
      if (info.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!info.isFile() || result.size >= 256 || info.size > 1024 * 1024) {
        throw new Error(`${label} tree bound exceeded`);
      }
      result.set(path.relative(root, full), await readFile(full));
    }
  };
  await walk(root, 0);
  return result;
}

export async function loadNativeEvidence(evidenceRoot: string): Promise<NativeEvidence> {
  const readOptional = async (name: string): Promise<Record<string, any>> => {
    try {
      return JSON.parse(await readFile(path.join(evidenceRoot, name), "utf8")) as Record<string, any>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
      throw error;
    }
  };
  const driver = JSON.parse(await readFile(path.join(evidenceRoot, "driver-result.json"), "utf8")) as Record<string, any>;
  return {
    evidenceRoot,
    driver,
    audit: await readJsonLines(path.join(evidenceRoot, "observer-audit.jsonl")),
    provider: await readJsonLines(path.join(evidenceRoot, "provider-audit.jsonl")),
    host: await readJsonLines(path.join(evidenceRoot, "host-audit.jsonl")),
    owner: await readOptional("owner-state.json"),
    delivery: await readTree(path.join(evidenceRoot, "delivery"), "delivery"),
    acceptance: await readTree(path.join(evidenceRoot, "acceptance"), "acceptance"),
    execution: await readTree(path.join(evidenceRoot, "execution"), "execution"),
    inputs: await readTree(path.join(evidenceRoot, "inputs"), "inputs"),
    executionAudit: await readJsonLines(path.join(evidenceRoot, "execution-audit.jsonl")),
  };
}

function lineValue(text: string, key: string): string | undefined {
  const line = text.split("\n").find((item) => item.startsWith(`${key}: `));
  return line === undefined ? undefined : line.slice(key.length + 2);
}

function jsonLine(text: string, key: string): Record<string, any> | null {
  const value = lineValue(text, key);
  if (value === undefined) return null;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`preview field ${key} is not an object`);
  }
  return parsed as Record<string, any>;
}

function jsonArrayLine(text: string, key: string): Array<Record<string, any>> {
  const value = lineValue(text, key);
  if (value === undefined) throw new Error(`preview field ${key} is missing`);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`preview field ${key} is not an array`);
  return parsed as Array<Record<string, any>>;
}

function findToolEnd(events: NativeEvent[], name: string, action?: string): NativeEvent | undefined {
  let toolCallId: string | undefined;
  if (action !== undefined) {
    const start = events.find((event) => event.type === "tool_call_start"
      && event.toolName === name
      && event.params?.action === action);
    toolCallId = typeof start?.toolCallId === "string" ? start.toolCallId : undefined;
  }
  return events.find((event) => event.type === "tool_call_end"
    && event.toolName === name
    && (toolCallId === undefined || event.toolCallId === toolCallId));
}

function parsePreview(text: string): ParsedPreview {
  const task = jsonLine(text, "task");
  const source = jsonLine(text, "source");
  const contract = jsonLine(text, "contract");
  const verification = jsonLine(text, "verification");
  const manifest = jsonLine(text, "manifest");
  const requirements = jsonLine(text, "requirements");
  const runId = lineValue(text, "runId");
  const deliveryId = lineValue(text, "deliveryId");
  const previewDigest = lineValue(text, "previewDigest");
  if (task === null || source === null || contract === null || verification === null
    || manifest === null || requirements === null
    || runId === undefined || deliveryId === undefined || previewDigest === undefined) {
    throw new Error("the actual preview content is missing required identity lines");
  }
  return {
    task,
    runId,
    deliveryId,
    previewDigest,
    source,
    inputs: jsonArrayLine(text, "inputs"),
    files: jsonArrayLine(text, "files"),
    manifest: {
      path: String(manifest.path),
      bytes: Number(manifest.bytes),
      sha256: String(manifest.sha256),
    },
    requirements: {
      path: String(requirements.path),
      bytes: Number(requirements.bytes),
      sha256: String(requirements.sha256),
    },
    contract,
    verification,
  };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function nullable(value: unknown): string {
  return value === null || value === undefined ? "none" : String(value);
}

function automaticLimitations(contract: Record<string, any> | null, receipt: Record<string, any> | null, usable: boolean, compatibility: string | null, facts: Record<string, any> | null): string[] {
  const limitations: string[] = [];
  if (contract === null) {
    limitations.push("no automatic acceptance contract is bound");
    limitations.push("no automatic check establishes the task semantics; every requirement needs human confirmation");
  } else if (contract.coverage.kind === "integrity") {
    limitations.push("the bound contract covers integrity only, not task semantics");
  } else if (contract.coverage.complete !== true) {
    limitations.push("the bound contract declares partial semantic coverage");
  }
  if (receipt === null) {
    limitations.push("no actual verification receipt is adopted for this delivery");
  } else {
    if (receipt.outcome !== "pass") limitations.push(`the automatic verification outcome is ${receipt.outcome}, not pass`);
    if (!usable) limitations.push("the receipt is not usable as a complete automatic acceptance record");
    if (compatibility !== "current") limitations.push("the receipt is not current");
    if (Array.isArray(receipt.uncoveredRevisions) && receipt.uncoveredRevisions.length > 0) {
      limitations.push(`uncovered requirement revisions in the automatic receipt: ${receipt.uncoveredRevisions.join(", ")}`);
    }
    if (facts === null) {
      limitations.push("private issuance facts are absent; this receipt cannot be used for human/hybrid admission");
    } else if (!facts.resultSettled || !facts.resultShapeValid || !facts.exactConditionSet
      || !facts.postVerifierCandidateRechecked || !facts.issuedCurrent) {
      limitations.push("one or more private issuance facts are false; human approval cannot bypass this");
    }
  }
  return limitations;
}

function contentLayout(
  model: Record<string, any>,
  digest: string,
  rawContentBytes: number,
  renderedBytes: number,
  fileCount: number,
  requirementRevisions: number[],
  expected: ExpectedOracle,
): ExpectedLayoutLine[] {
  const grammar = expected.grammar;
  const lines: ExpectedLayoutLine[] = [];
  const ascii = (text: string): void => {
    if (!/^[\x20-\x7e]*$/.test(text)) {
      throw new Error(`ungradeable non-ASCII dynamic line: ${JSON.stringify(text)}`);
    }
    lines.push({ text, oracleId: null });
  };
  const staticText = (text: string, idPrefix: string): void => {
    const split = String(text).split("\n");
    for (let index = 0; index < split.length; index += 1) {
      lines.push({ text: split[index]!, oracleId: `${idPrefix}:${index}` });
    }
  };
  lines.push({ text: String(grammar.preamble), oracleId: "grammar:preamble:0" });
  ascii(String(grammar.requirementsHeading)
    .replace("{count}", String(model.requirements.sources.length))
    .replace("{bytes}", String(model.requirements.totalBytes)));
  for (let index = 0; index < model.requirements.sources.length; index += 1) {
    const source = model.requirements.sources[index];
    ascii(`--- REQUIREMENT ${index + 1}/${model.requirements.sources.length} ---`);
    ascii(`revision: ${source.revision}`);
    ascii(`kind: ${source.kind}`);
    ascii(`messageId: ${source.messageId}`);
    ascii(`sessionId: ${source.sessionId}`);
    ascii(`source: ${source.source}`);
    ascii(`observedAt: ${source.observedAt}`);
    ascii(`committedAt: ${source.committedAt}`);
    ascii(`previousRevision: ${nullable(source.previousRevision)}`);
    ascii(`rawBytes: ${source.rawBytes}`);
    ascii("requirement text follows:");
    staticText(source.text, `requirement:${source.revision}`);
    ascii(`--- END REQUIREMENT ${index + 1}/${model.requirements.sources.length} ---`);
  }
  ascii("");
  ascii(String(grammar.selectedFilesHeading).replace("{count}", String(model.delivery.files.length)));
  for (let index = 0; index < model.delivery.files.length; index += 1) {
    const file = model.delivery.files[index];
    ascii(`--- FILE ${index + 1}/${model.delivery.files.length} ---`);
    ascii(`artifactId: ${file.artifactId}`);
    ascii(`relativePath: ${file.relativePath}`);
    ascii(`name: ${file.name}`);
    ascii(`path: ${file.path}`);
    ascii(`bytes: ${file.bytes}`);
    ascii(`sha256: ${file.sha256}`);
    ascii("file text follows:");
    staticText(file.text, `file:${file.relativePath}`);
    ascii(`--- END FILE ${index + 1}/${model.delivery.files.length} ---`);
  }
  ascii("");
  ascii(String(grammar.automaticHeading));
  if (model.contract === null) {
    ascii("contract: none");
  } else {
    ascii(`contractId: ${model.contract.contractId}`);
    ascii(`contract digest: ${model.contract.digest}`);
    ascii(`host config: id=${model.contract.hostConfig.id} version=${model.contract.hostConfig.version}`);
    ascii(`verifier: id=${model.contract.verifier.id} version=${model.contract.verifier.version} parametersDigest=${model.contract.verifier.parametersDigest}`);
    ascii(`coverage: kind=${model.contract.coverage.kind} complete=${model.contract.coverage.complete} coveredRevisions=${displayValue(model.contract.coverage.coveredRevisions)}`);
    ascii(`coverage statement: ${model.contract.coverage.statement}`);
    for (const condition of model.contract.conditions) {
      ascii(`contract condition: id=${condition.conditionId} kind=${condition.kind} coveredRevisions=${displayValue(condition.coveredRevisions)}`);
      ascii(`contract condition description: ${condition.description}`);
    }
  }
  const automatic = model.automatic;
  ascii(`automatic state: ${automatic.state}`);
  ascii(`automatic receiptId: ${nullable(automatic.receiptId)}`);
  ascii(`automatic receiptDigest: ${nullable(automatic.receiptDigest)}`);
  ascii(`automatic outcome: ${nullable(automatic.outcome)}`);
  ascii(`automatic reason: ${nullable(automatic.reason)}`);
  ascii(`automatic compatibility: ${nullable(automatic.compatibility)}`);
  ascii(`automatic usable: ${automatic.usable}`);
  ascii(`automatic uncoveredRevisions: ${displayValue(automatic.uncoveredRevisions)}`);
  ascii(`automatic limits: ${displayValue(automatic.limits)}`);
  ascii(`automatic issuance facts: ${displayValue(automatic.issuanceFacts)}`);
  for (const condition of automatic.conditions) {
    ascii(`automatic condition: id=${condition.conditionId} kind=${condition.kind} result=${condition.result} coveredRevisions=${displayValue(condition.coveredRevisions)}`);
    ascii(`automatic condition detail: ${nullable(condition.detail)}`);
  }
  const limitationKind = model.contract === null ? "noContract" : "hybridPartial";
  for (let index = 0; index < automatic.limitations.length; index += 1) {
    lines.push({
      text: `${String(grammar.limitationLinePrefix)}${automatic.limitations[index]}`,
      oracleId: `limitation:${limitationKind}:${index}:0`,
    });
  }
  ascii("");
  ascii(String(grammar.boundTaskHeading));
  ascii(`ownerId: ${model.task.ownerId}`);
  ascii(`taskId: ${model.task.taskId}`);
  ascii(`taskRevision: ${model.task.taskRevision}`);
  ascii(`requirementsDigest: ${model.task.requirementsDigest}`);
  ascii("");
  ascii(String(grammar.boundDeliveryHeading));
  ascii(`deliveryId: ${model.delivery.deliveryId}`);
  ascii(`previewDigest: ${model.delivery.previewDigest}`);
  ascii(`runId: ${model.delivery.runId}`);
  ascii(`callId: ${model.delivery.callId}`);
  ascii(`source: bytes=${model.delivery.source.bytes} sha256=${model.delivery.source.sha256}`);
  ascii(`manifest: name=${model.delivery.manifest.name} bytes=${model.delivery.manifest.bytes} sha256=${model.delivery.manifest.sha256}`);
  ascii(`requirements file: name=${model.delivery.requirements.name} bytes=${model.delivery.requirements.bytes} sha256=${model.delivery.requirements.sha256}`);
  ascii(model.delivery.inputs.length === 0 ? "inputs: none" : `inputs: ${displayValue(model.delivery.inputs)}`);
  ascii("");
  ascii(String(grammar.displayHeading));
  ascii(`display version: ${model.version}`);
  ascii(`display transform: ${model.transform}`);
  ascii(`display digest: ${digest}`);
  ascii(`raw content bytes: ${rawContentBytes}`);
  ascii(`rendered bytes: ${renderedBytes}`);
  ascii(`file count: ${fileCount}`);
  ascii(`requirement revisions: ${displayValue(requirementRevisions)}`);
  ascii("");
  ascii(String(grammar.notesHeading));
  for (let index = 0; index < model.notes.length; index += 1) {
    lines.push({ text: `${String(grammar.noteLinePrefix)}${model.notes[index]}`, oracleId: `note:${index}:0` });
  }
  return lines;
}

export interface ExpectedCaseSet {
  expectedRelativePaths: string[];
  expectedRevisions: number[];
}

function parseRunIdentity(content: string): { runId: string; callId: string; taskId: string; taskRevision: number } | null {
  const matches = [...content.matchAll(/^run runId="([^"]+)" callId="([^"]+)" taskId="([^"]+)" taskRevision=(\d+)/gm)];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return {
    runId: match[1]!,
    callId: match[2]!,
    taskId: match[3]!,
    taskRevision: Number(match[4]),
  };
}

function executeCallEvents(evidence: NativeEvidence): { starts: NativeEvent[]; ends: NativeEvent[] } {
  return {
    starts: evidence.audit.filter((event) => event.type === "execute_call_start" && event.toolName === "agent_execute"),
    ends: evidence.audit.filter((event) => event.type === "execute_result_observed" && event.toolName === "agent_execute"),
  };
}

function uniqueExecutePair(evidence: NativeEvidence): { start: NativeEvent; end: NativeEvent } {
  const { starts, ends } = executeCallEvents(evidence);
  if (starts.length !== 1) throw new Error(`expected exactly one actual agent_execute start, saw ${starts.length}`);
  if (ends.length !== 1) throw new Error(`expected exactly one actual agent_execute terminal event, saw ${ends.length}`);
  const start = starts[0]!;
  const end = ends[0]!;
  if (typeof start.toolCallId !== "string" || start.toolCallId === ""
    || start.toolCallId !== end.toolCallId) {
    throw new Error("the actual agent_execute start/terminal toolCallId pair is missing or mismatched");
  }
  if (start.inputTruncated === true || end.inputTruncated === true || end.contentTruncated === true) {
    throw new Error("the actual agent_execute start/terminal content was truncated");
  }
  return { start, end };
}

function providerExecuteIntent(evidence: NativeEvidence): Record<string, any> {
  const intents = evidence.provider.filter((event) => event.type === "provider_turn"
    && event.call?.type === "toolCall"
    && event.call?.name === "agent_execute");
  if (intents.length !== 1) throw new Error(`expected exactly one provider agent_execute intent, saw ${intents.length}`);
  const args = intents[0]!.call?.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("the provider agent_execute intent has no arguments object");
  }
  if (typeof args.source !== "string") throw new Error("the provider agent_execute intent has no source text");
  if (!Array.isArray(args.inputIds) || args.inputIds.some((id: unknown) => typeof id !== "string" || id === "")) {
    throw new Error("the provider agent_execute intent has malformed inputIds");
  }
  return args as Record<string, any>;
}

function relativeInside(root: string, absolute: string, label: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(absolute)) throw new Error(`${label} must use absolute paths`);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its approved root`);
  }
  return relative;
}

function treeBytes(tree: Map<string, Buffer>, relative: string, label: string): Buffer {
  const bytes = tree.get(relative);
  if (!bytes) throw new Error(`${label} is missing from the physical evidence tree`);
  return bytes;
}

function inputProjection(rows: unknown): Array<{ id: string; bytes: number; sha256: string }> | null {
  if (!Array.isArray(rows)) return null;
  const result: Array<{ id: string; bytes: number; sha256: string }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const value = row as Record<string, any>;
    if (typeof value.id !== "string" || !Number.isSafeInteger(value.bytes) || typeof value.sha256 !== "string") return null;
    result.push({ id: value.id, bytes: value.bytes, sha256: value.sha256 });
  }
  return result;
}

function artifactProjection(rows: unknown): Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }> | null {
  if (!Array.isArray(rows)) return null;
  const result: Array<{ artifactId: string; relativePath: string; bytes: number; sha256: string }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const value = row as Record<string, any>;
    if (typeof value.artifactId !== "string" || typeof value.relativePath !== "string"
      || !Number.isSafeInteger(value.bytes) || typeof value.sha256 !== "string") return null;
    result.push({
      artifactId: value.artifactId,
      relativePath: value.relativePath,
      bytes: value.bytes,
      sha256: value.sha256,
    });
  }
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindExecutionProvenance(
  evidence: NativeEvidence,
  corpus: NativeCorpus,
  preview: ParsedPreview,
  runRecord: Record<string, any>,
  runRecordName: string,
  start: NativeEvent,
  end: NativeEvent,
): BoundProvenance {
  const providerArgs = providerExecuteIntent(evidence);
  const sourceText = String(providerArgs.source);
  const startInput = start.input as Record<string, any>;
  const endInput = end.input as Record<string, any>;
  if (startInput.source !== sourceText || endInput.source !== sourceText) {
    throw new Error("the provider source text does not match the actual readonly execute start/terminal input");
  }
  if (!sameJson(providerArgs.inputIds, startInput.inputIds) || !sameJson(providerArgs.inputIds, endInput.inputIds)) {
    throw new Error("the provider inputIds do not match the actual readonly execute start/terminal input");
  }
  for (const key of ["action", "runtime", "expectedTaskId", "expectedTaskRevision"]) {
    if (providerArgs[key] !== startInput[key] || providerArgs[key] !== endInput[key]) {
      throw new Error(`the provider agent_execute ${key} does not match the actual readonly execute input`);
    }
  }
  const source = { bytes: Buffer.byteLength(sourceText, "utf8"), sha256: sha256Text(sourceText) };
  if (!sameJson(runRecord.source, source)) {
    throw new Error("the physical run record source identity does not match the actual invoked source text");
  }
  if (!sameJson(preview.source, source)) {
    throw new Error("the preview source identity does not match the actual invoked source text");
  }

  const executionRoot = String(evidence.driver.roots?.executionRoot ?? "");
  const inputRoot = String(evidence.driver.roots?.inputRoot ?? "");
  if (!path.isAbsolute(executionRoot)) throw new Error("the driver result has no absolute execution root");
  if (!path.isAbsolute(inputRoot)) throw new Error("the driver result has no absolute input root");
  if (runRecord.phase !== "completed" || runRecord.process?.spawned !== true || runRecord.process?.exitCode !== 0) {
    throw new Error("the physical run record is not a completed successful execution");
  }
  if (runRecord.ownerId !== preview.task.ownerId
    || runRecord.taskId !== preview.task.taskId
    || runRecord.taskRevision !== preview.task.taskRevision
    || runRecord.requirementsDigest !== preview.task.requirementsDigest) {
    throw new Error("the physical run record task identity differs from the preview task");
  }
  if (runRecord.runtime !== providerArgs.runtime) {
    throw new Error("the physical run record runtime differs from the actual invoked runtime");
  }

  const runDir = path.posix.dirname(runRecordName.split(path.sep).join("/"));
  if (runDir === "." || runDir.startsWith("..")) throw new Error("the physical run record path is malformed");
  const recordInputs = Array.isArray(runRecord.inputs) ? runRecord.inputs as Array<Record<string, any>> : null;
  if (recordInputs === null) throw new Error("the physical run record has no inputs array");
  const providerIds = providerArgs.inputIds as string[];
  if (new Set(providerIds).size !== providerIds.length) throw new Error("the provider inputIds contain duplicates");
  if (!sameJson(recordInputs.map((item) => item.id), providerIds)) {
    throw new Error("the physical run record input IDs differ from the provider inputIds");
  }
  const previewInputs = inputProjection(preview.inputs);
  if (previewInputs === null) throw new Error("the preview inputs are malformed");
  const boundInputs: Array<{ id: string; bytes: number; sha256: string }> = [];
  if (recordInputs.length === 0) throw new Error("the actual execution record has no staged input snapshots");
  const firstStaged = String(recordInputs[0]!.stagedPath ?? "");
  const inputDir = path.dirname(firstStaged);
  if (!path.isAbsolute(firstStaged)) throw new Error("the physical run record staged input path is not absolute");
  for (const [index, input] of recordInputs.entries()) {
    const id = input.id;
    if (typeof id !== "string" || id === "") throw new Error("the physical run record input has no ID");
    if (!Number.isSafeInteger(input.bytes) || typeof input.sha256 !== "string") {
      throw new Error(`the physical run record input ${id} has malformed identity`);
    }
    const stagedPath = String(input.stagedPath ?? "");
    const sourcePath = String(input.sourcePath ?? "");
    if (path.dirname(stagedPath) !== inputDir) throw new Error("the staged input snapshots do not share one input directory");
    const stagedRelative = relativeInside(executionRoot, stagedPath, `staged input ${id}`);
    const stagedBytes = treeBytes(evidence.execution, stagedRelative, `staged input ${id}`);
    if (stagedBytes.length !== input.bytes || sha256Bytes(stagedBytes) !== input.sha256) {
      throw new Error(`the staged input snapshot ${id} differs from the physical run record`);
    }
    const sourceRelative = relativeInside(inputRoot, sourcePath, `authorized input ${id}`);
    const authorizedBytes = treeBytes(evidence.inputs, sourceRelative, `authorized input ${id}`);
    const corpusFile = corpus.files.find((file) => file.name === sourceRelative.split(path.sep).join("/"));
    if (!corpusFile) throw new Error(`the authorized input ${id} does not match a frozen corpus file`);
    if (authorizedBytes.length !== corpusFile.bytes
      || sha256Bytes(authorizedBytes) !== corpusFile.sha256
      || authorizedBytes.toString("utf8") !== corpusFile.rawText) {
      throw new Error(`the authorized input ${id} differs from the frozen corpus`);
    }
    if (!authorizedBytes.equals(stagedBytes)) {
      throw new Error(`the authorized input ${id} differs from its staged read-only snapshot`);
    }
    if (previewInputs[index]?.id !== id
      || previewInputs[index]?.bytes !== input.bytes
      || previewInputs[index]?.sha256 !== input.sha256) {
      throw new Error(`the preview input ${id} differs from the physical run record`);
    }
    boundInputs.push({ id, bytes: input.bytes, sha256: input.sha256 });
  }
  if (previewInputs.length !== boundInputs.length) throw new Error("the preview input count differs from the physical run record");

  const manifestAbsolute = path.join(inputDir, "manifest.json");
  const manifestRelative = relativeInside(executionRoot, manifestAbsolute, "execution input manifest");
  const manifestBytes = treeBytes(evidence.execution, manifestRelative, "execution input manifest");
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, any>;
  } catch {
    throw new Error("the execution input manifest is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("the execution input manifest is not an object");
  }
  if (manifest.runtime !== runRecord.runtime) throw new Error("the execution input manifest runtime differs from the run record");
  const handles = manifest.handles;
  if (typeof handles !== "object" || handles === null || Array.isArray(handles)) {
    throw new Error("the execution input manifest has no handles object");
  }
  if (!sameJson(Object.keys(handles), providerIds)) {
    throw new Error("the execution input manifest handle IDs differ from the actual input IDs");
  }
  for (const [index, input] of recordInputs.entries()) {
    const id = input.id as string;
    const handle = (handles as Record<string, any>)[id];
    if (typeof handle !== "object" || handle === null || Array.isArray(handle)) {
      throw new Error(`the execution input manifest handle ${id} is malformed`);
    }
    if (handle.path !== input.stagedPath
      || handle.bytes !== input.bytes
      || handle.sha256 !== input.sha256
      || handle.writable !== false) {
      throw new Error(`the execution input manifest handle ${id} differs from the physical run record`);
    }
    if (previewInputs[index]?.id !== id) throw new Error("the preview input order differs from the actual input IDs");
  }
  const workDir = String(manifest.workDir ?? "");
  const runDirAbsolute = path.join(executionRoot, runDir);
  relativeInside(runDirAbsolute, workDir, "execution work directory");
  const manifestSource = String(manifest.sourcePath ?? "");
  const sourceRelative = relativeInside(executionRoot, manifestSource, "physical execution source");
  const physicalSource = treeBytes(evidence.execution, sourceRelative, "physical execution source");
  if (physicalSource.length !== source.bytes || sha256Bytes(physicalSource) !== source.sha256
    || physicalSource.toString("utf8") !== sourceText) {
    throw new Error("the physical execution source script differs from the actual invoked source text");
  }

  const recordArtifacts = artifactProjection(runRecord.artifacts);
  if (recordArtifacts === null) throw new Error("the physical run record has no artifacts array");
  const previewArtifacts = artifactProjection(preview.files);
  if (previewArtifacts === null) throw new Error("the preview files are malformed");
  if (previewArtifacts.length !== recordArtifacts.length) {
    throw new Error("the preview artifact count differs from the physical run record");
  }
  const recordById = new Map<string, { artifactId: string; relativePath: string; bytes: number; sha256: string }>();
  for (const artifact of recordArtifacts) {
    if (recordById.has(artifact.artifactId)) throw new Error(`duplicate physical artifactId ${artifact.artifactId}`);
    recordById.set(artifact.artifactId, artifact);
  }
  for (const artifact of previewArtifacts) {
    const actual = recordById.get(artifact.artifactId);
    if (!actual || !sameJson(actual, artifact)) {
      throw new Error(`the preview artifact ${artifact.artifactId} differs from the physical run record`);
    }
  }
  return { source, inputs: boundInputs, artifacts: previewArtifacts, runId: preview.runId, callId: String(parseRunIdentity(String(end.content ?? ""))?.callId ?? "") };
}

function bindDeliveryManifest(
  manifestBytes: Buffer,
  preview: ParsedPreview,
  provenance: BoundProvenance,
): void {
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, any>;
  } catch {
    throw new Error("the physical delivery manifest is not valid JSON");
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("the physical delivery manifest is not an object");
  }
  if (manifest.deliveryId !== preview.deliveryId) throw new Error("the physical delivery manifest deliveryId differs from the preview");
  if (manifest.previewDigest !== preview.previewDigest) throw new Error("the physical delivery manifest previewDigest differs from the preview");
  if (!sameJson(manifest.task, preview.task)) throw new Error("the physical delivery manifest task identity differs from the preview");
  if (manifest.run?.runId !== provenance.runId || manifest.run?.callId !== provenance.callId) {
    throw new Error("the physical delivery manifest run identity differs from the actual execute terminal");
  }
  if (!sameJson(manifest.source, provenance.source)) throw new Error("the physical delivery manifest source identity differs from the actual invoked source");
  if (!sameJson(inputProjection(manifest.inputs), provenance.inputs)) {
    throw new Error("the physical delivery manifest inputs differ from the actual staged inputs");
  }
  if (!sameJson(artifactProjection(manifest.artifacts), provenance.artifacts)) {
    throw new Error("the physical delivery manifest artifacts differ from the actual run artifacts");
  }
  const payload = manifest.previewPayload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("the physical delivery manifest has no preview payload");
  }
  if (sha256Text(JSON.stringify(payload)) !== preview.previewDigest) {
    throw new Error("the physical delivery manifest preview payload does not hash to the preview digest");
  }
  if (payload.deliveryId !== preview.deliveryId
    || payload.run?.runId !== provenance.runId
    || payload.run?.callId !== provenance.callId
    || !sameJson(payload.task, preview.task)
    || !sameJson(payload.source, provenance.source)
    || !sameJson(inputProjection(payload.inputs), provenance.inputs)
    || !sameJson(artifactProjection(payload.files), provenance.artifacts)) {
    throw new Error("the physical delivery manifest preview payload differs from the actual preview/run identity");
  }
}

export function buildExpectedDocument(evidence: NativeEvidence, corpus: NativeCorpus, expected: ExpectedOracle, caseSet: ExpectedCaseSet): ExpectedDocument {
  const previewEvent = findToolEnd(evidence.audit, "agent_deliver", "preview");
  if (!previewEvent) throw new Error("no actual agent_deliver preview result was observed");
  const preview = parsePreview(String(previewEvent.content ?? ""));
  const previewPaths = preview.files.map((file) => String(file.relativePath)).sort();
  const expectedPaths = [...caseSet.expectedRelativePaths].sort();
  if (JSON.stringify(previewPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`preview selected relativePath set differs from the frozen case set: actual=${JSON.stringify(previewPaths)} expected=${JSON.stringify(expectedPaths)}`);
  }
  const ownerTask = evidence.owner.currentTask as Record<string, any> | null;
  if (!ownerTask || ownerTask.status !== "active" && ownerTask.status !== "accepted") {
    throw new Error("the published owner snapshot has no current task");
  }
  if (preview.task.taskId !== ownerTask.taskId
    || preview.task.taskRevision !== ownerTask.taskRevision
    || preview.task.ownerId !== ownerTask.ownerId) {
    throw new Error("preview task identity differs from the published owner snapshot");
  }
  const { start: executeStart, end: executeEnd } = uniqueExecutePair(evidence);
  const terminal = parseRunIdentity(String(executeEnd.content ?? ""));
  if (executeEnd.isError === true || terminal === null) {
    throw new Error("the actual agent_execute terminal event has no unique successful run identity");
  }
  if (terminal.runId !== preview.runId
    || terminal.taskId !== preview.task.taskId
    || terminal.taskRevision !== preview.task.taskRevision) {
    throw new Error("the actual agent_execute terminal identity differs from the preview task/run identity");
  }
  const callId = terminal.callId;

  let runRecord: Record<string, any> | null = null;
  let runRecordName: string | null = null;
  for (const [name, bytes] of evidence.execution.entries()) {
    const normalizedName = name.split(path.sep).join("/");
    if (!normalizedName.endsWith("/record.json")) continue;
    const candidate = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
    if (candidate.runId !== preview.runId) continue;
    if (runRecord !== null) throw new Error(`duplicate physical execution records for ${preview.runId}`);
    runRecord = candidate;
    runRecordName = name;
  }
  if (runRecord === null || runRecordName === null) throw new Error("no physical execution record matches the observed runId");
  if (runRecord.callId !== callId
    || runRecord.taskId !== terminal.taskId
    || runRecord.taskRevision !== terminal.taskRevision) {
    throw new Error("the physical run record does not match the actual execute terminal identity");
  }
  const provenance = bindExecutionProvenance(evidence, corpus, preview, runRecord, runRecordName, executeStart, executeEnd);

  const ownerSources = ownerTask.requirementSources as Array<Record<string, any>>;
  const actualRevisions = ownerSources.map((source) => Number(source.revision)).sort((left, right) => left - right);
  const expectedRevisions = [...caseSet.expectedRevisions].sort((left, right) => left - right);
  if (JSON.stringify(actualRevisions) !== JSON.stringify(expectedRevisions)) {
    throw new Error(`owner requirement revision set differs from the frozen case set: actual=${JSON.stringify(actualRevisions)} expected=${JSON.stringify(expectedRevisions)}`);
  }
  const corpusRequirement = new Map<number, { rawText: string; expectedSafeText: string }>();
  for (const requirement of corpus.requirements) corpusRequirement.set(requirement.revision, requirement);
  const oracleRequirement = new Map<number, string>();
  for (const requirement of expected.requirements) oracleRequirement.set(requirement.revision, requirement.expectedSafeText);
  const requirements = ownerSources.map((source) => {
    const text = String(source.text);
    const frozen = corpusRequirement.get(Number(source.revision));
    if (!frozen || frozen.rawText !== text) {
      throw new Error(`owner requirement revision ${source.revision} does not match the frozen native corpus text`);
    }
    const safe = oracleRequirement.get(Number(source.revision)) ?? frozen.expectedSafeText;
    return {
      revision: source.revision,
      kind: source.kind,
      messageId: source.messageId,
      sessionId: source.sessionId,
      source: source.source,
      observedAt: source.observedAt,
      committedAt: source.committedAt,
      previousRevision: source.previousRevision ?? null,
      text: safe,
      rawBytes: Buffer.byteLength(text, "utf8"),
    };
  });
  const requirementRevisions = [...new Set(requirements.map((source) => Number(source.revision)))].sort((left, right) => left - right);
  const totalRequirementBytes = requirements.reduce((sum, source) => sum + source.rawBytes, 0);

  const deliveryRoot = String(evidence.driver.roots?.deliveryRoot ?? evidence.driver["deliveryRoot"] ?? "");
  if (!path.isAbsolute(deliveryRoot)) throw new Error("the driver result has no absolute delivery root");
  const files = preview.files.map((file) => {
    const relativePath = String(file.relativePath);
    const expectedFile = expected.files.find((candidate) => candidate.name === relativePath)
      ?? corpus.files.find((candidate) => candidate.name === relativePath);
    if (!expectedFile) throw new Error(`preview relativePath ${relativePath} is not in the frozen corpus`);
    const absolute = String(file.path);
    const relative = path.relative(deliveryRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("preview file path escapes the delivery root");
    const bytes = evidence.delivery.get(relative);
    if (!bytes) throw new Error(`physical delivery bytes are missing for ${relative}`);
    const corpusFile = corpus.files.find((candidate) => candidate.name === relativePath);
    if (!corpusFile) throw new Error("frozen corpus file is missing");
    if (bytes.length !== corpusFile.bytes
      || sha256Bytes(bytes) !== corpusFile.sha256
      || bytes.toString("utf8") !== corpusFile.rawText) {
      throw new Error(`physical delivery bytes differ from the frozen corpus for ${corpusFile.name}`);
    }
    if (Number(file.bytes) !== bytes.length || String(file.sha256) !== sha256Bytes(bytes)) {
      throw new Error(`preview identity differs from physical bytes for ${corpusFile.name}`);
    }
    return {
      artifactId: String(file.artifactId),
      relativePath: safeText(String(file.relativePath)),
      name: safeText(String(file.name)),
      path: safeText(absolute),
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      text: (expectedFile as { expectedSafeText: string }).expectedSafeText,
    };
  });
  const totalFileBytes = files.reduce((sum, file) => sum + file.bytes, 0);

  const manifestRelative = path.relative(deliveryRoot, preview.manifest.path);
  const requirementsRelative = path.relative(deliveryRoot, preview.requirements.path);
  const manifestBytes = evidence.delivery.get(manifestRelative);
  const requirementsBytes = evidence.delivery.get(requirementsRelative);
  if (!manifestBytes || !requirementsBytes) throw new Error("physical manifest/requirements bundle files are missing");
  if (manifestBytes.length !== preview.manifest.bytes || sha256Bytes(manifestBytes) !== preview.manifest.sha256) {
    throw new Error("preview manifest identity differs from physical bytes");
  }
  if (requirementsBytes.length !== preview.requirements.bytes || sha256Bytes(requirementsBytes) !== preview.requirements.sha256) {
    throw new Error("preview requirements identity differs from physical bytes");
  }
  bindDeliveryManifest(manifestBytes, preview, provenance);

  let contract: Record<string, any> | null = null;
  let originalReceipt: Record<string, any> | null = null;
  let originalReceiptDigest: string | null = null;
  if (preview.contract.state === "bound") {
    const summary = preview.contract.summary as Record<string, any>;
    if (summary.coverage.statementTruncated === true
      || summary.conditions.some((condition: Record<string, any>) => condition.descriptionTruncated === true)) {
      throw new Error("the preview contract summary was truncated; the display cannot be reconstructed");
    }
    const bound = evidence.host.find((event) => event.type === "contract_bound");
    if (!bound || bound.contractId !== summary.contractId || bound.digest !== summary.digest) {
      throw new Error("the host contract event does not match the preview contract summary");
    }
    contract = {
      contractId: summary.contractId,
      digest: summary.digest,
      hostConfig: { id: summary.hostConfig.id, version: summary.hostConfig.version },
      verifier: {
        id: summary.verifier.id,
        version: summary.verifier.version,
        parametersDigest: summary.verifier.parametersDigest,
      },
      coverage: {
        kind: summary.coverage.kind,
        complete: summary.coverage.complete,
        coveredRevisions: [...summary.coverage.coveredRevisions],
        statement: safeText(String(summary.coverage.statement)),
      },
      conditions: summary.conditions.map((condition: Record<string, any>) => ({
        conditionId: condition.conditionId,
        description: safeText(String(condition.description)),
        kind: condition.kind,
        coveredRevisions: [...condition.coveredRevisions],
      })),
    };
  } else if (preview.contract.state !== "none") {
    throw new Error("the preview contract state is not none or bound");
  }

  let automatic: Record<string, any>;
  if (contract === null) {
    automatic = {
      state: "none",
      receiptId: null,
      receiptDigest: null,
      outcome: null,
      reason: null,
      compatibility: null,
      usable: false,
      conditions: [],
      uncoveredRevisions: [],
      limits: null,
      issuanceFacts: null,
      limitations: expected.limitations.noContract,
    };
    if (preview.verification.state !== "not_referenced") {
      throw new Error("the no-contract preview unexpectedly referenced a receipt");
    }
  } else {
    const receipts = evidence.host.filter((event) => event.type === "host_receipt");
    if (receipts.length !== 1) throw new Error("the hybrid case did not retain exactly one host receipt lookup");
    const lookup = receipts[0]!.lookup as Record<string, any>;
    const receipt = lookup.receipt as Record<string, any>;
    if (!receipt || typeof receipt !== "object") throw new Error("the host receipt lookup has no receipt");
    originalReceipt = receipt;
    originalReceiptDigest = sha256Text(JSON.stringify(receipt));
    const facts = (lookup.reviewFacts ?? null) as Record<string, any> | null;
    const usable = lookup.usable !== false;
    const compatibility = typeof lookup.compatibility === "string" ? lookup.compatibility : null;
    const state = contract.coverage.kind === "integrity"
      ? "integrity-only"
      : receipt.outcome === "pass" && contract.coverage.complete === true
        ? "complete"
        : "partial";
    const limitations = automaticLimitations(contract, receipt, usable, compatibility, facts);
    automatic = {
      state,
      receiptId: receipt.receiptId ?? null,
      receiptDigest: sha256Text(JSON.stringify(receipt)),
      outcome: receipt.outcome ?? null,
      reason: receipt.reason === null || receipt.reason === undefined ? null : safeText(String(receipt.reason)),
      compatibility,
      usable,
      conditions: (receipt.conditions as Array<Record<string, any>>).map((condition) => ({
        conditionId: condition.conditionId,
        kind: condition.kind,
        result: condition.result,
        coveredRevisions: [...condition.coveredRevisions],
        detail: condition.detail === null || condition.detail === undefined ? null : safeText(String(condition.detail)),
      })),
      uncoveredRevisions: [...receipt.uncoveredRevisions],
      limits: receipt.limits,
      issuanceFacts: facts,
      limitations,
    };
    if (JSON.stringify(limitations) !== JSON.stringify(expected.limitations.hybridPartial)) {
      throw new Error(`hybrid limitation grammar mismatch: ${JSON.stringify(limitations)}`);
    }
  }

  const model: Record<string, any> = {
    version: expected.displayVersion,
    transform: expected.escapeVersion,
    task: {
      ownerId: preview.task.ownerId,
      taskId: preview.task.taskId,
      taskRevision: preview.task.taskRevision,
      requirementsDigest: preview.task.requirementsDigest,
    },
    delivery: {
      deliveryId: preview.deliveryId,
      previewDigest: preview.previewDigest,
      runId: preview.runId,
      callId,
      source: { bytes: preview.source.bytes, sha256: preview.source.sha256 },
      inputs: preview.inputs.map((input) => ({ id: input.id, bytes: input.bytes, sha256: input.sha256 })),
      files,
      manifest: { name: "manifest.json", bytes: preview.manifest.bytes, sha256: preview.manifest.sha256 },
      requirements: { name: "requirements.json", bytes: preview.requirements.bytes, sha256: preview.requirements.sha256 },
    },
    requirements: { totalBytes: totalRequirementBytes, sources: requirements },
    contract,
    automatic,
    notes: expected.notes,
  };
  const rendered = JSON.stringify(model);
  const digest = sha256Text(rendered);
  const renderedBytes = Buffer.byteLength(rendered, "utf8");
  const rawContentBytes = totalFileBytes + totalRequirementBytes;
  const layout = contentLayout(model, digest, rawContentBytes, renderedBytes, files.length, requirementRevisions, expected);
  const lines = layout.map((line) => line.text);
  const expiresAt = extractDeadline(evidence.audit);
  const requestStart = evidence.audit.find((event) => event.type === "tool_call_start"
    && event.toolName === "agent_deliver"
    && event.params?.action === "request_review");
  const startMs = typeof requestStart?.at === "string" ? Date.parse(requestStart.at) : Number.NaN;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(expiresMs)
    || expiresMs < startMs + 295_000 || expiresMs > startMs + 320_000) {
    throw new Error("the painted deadline is not consistent with a real 300000ms review reservation");
  }
  return {
    model,
    lines,
    layout,
    digest,
    renderedBytes,
    rawContentBytes,
    fileCount: files.length,
    requirementRevisions,
    expiresAt,
    preview,
    provenance,
    fixtureSha256: expected.fixtureSha256 ?? "",
    originalReceipt,
    originalReceiptDigest,
  };
}

function extractDeadline(events: NativeEvent[]): string {
  for (const event of events) {
    if (event.type !== "render" && event.type !== "paint") continue;
    const rows = event.type === "render" ? event.output : event.plainViewport;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const text = String(row);
      const match = /Deadline: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(text);
      if (match) return match[1]!;
    }
  }
  throw new Error("no canonical review deadline was painted");
}

/**
 * Fixed ASCII layout for dynamic metadata and fixed ASCII grammar only.
 * v18.18 source and the host helper contract establish one cell per printable
 * ASCII character and continuous hard column slices with no trimming.
 */
function wrapAsciiLiteral(line: string, width: number): string[] {
  if (!/^[\x20-\x7e]*$/.test(line)) {
    throw new Error(`ungradeable non-ASCII logical line outside the frozen static oracle: ${JSON.stringify(line)}`);
  }
  if (line.length === 0) return [""];
  if (!Number.isSafeInteger(width) || width <= 0) throw new Error("a positive layout width is required");
  const rows: string[] = [];
  for (let index = 0; index < line.length; index += width) rows.push(line.slice(index, index + width));
  return rows;
}

interface OracleLayout {
  events: Map<string, Record<string, any>>;
}

function oracleLayoutFor(events: NativeEvent[]): OracleLayout {
  const map = new Map<string, Record<string, any>>();
  for (const event of events) {
    if (event.type !== "oracle_layout") continue;
    const key = `${String(event.columns)}\u0000${String(event.logicalLineId)}`;
    if (map.has(key)) throw new Error(`duplicate independent oracle layout for ${String(event.logicalLineId)} at ${String(event.columns)} columns`);
    map.set(key, event);
  }
  return { events: map };
}

export function layoutRows(document: ExpectedDocument, width: number, oracle: { events: Map<string, Record<string, any>> }): string[] {
  const rows: string[] = [];
  for (const line of document.layout) {
    if (line.oracleId === null) {
      rows.push(...wrapAsciiLiteral(line.text, width));
      continue;
    }
    const event = oracle.events.get(`${width}\u0000${line.oracleId}`);
    if (!event) {
      throw new Error(`no independent host-helper layout for ${line.oracleId} at ${width} columns`);
    }
    if (document.fixtureSha256 === "" || event.inputSha256 !== document.fixtureSha256) {
      throw new Error(`the independent layout event does not bind the frozen expected fixture: ${line.oracleId}`);
    }
    if (event.lineSha256 !== sha256Text(line.text)) {
      throw new Error(`the independent layout event input differs from the frozen static line: ${line.oracleId}`);
    }
    if (!Array.isArray(event.wrappedRows) || !Array.isArray(event.outputWidths)
      || event.wrappedRows.length === 0 || event.wrappedRows.length !== event.outputWidths.length) {
      throw new Error(`the independent layout event is malformed: ${line.oracleId}`);
    }
    const staticRows = event.wrappedRows.map(String);
    const widths = event.outputWidths.map(Number);
    if (staticRows.join("") !== line.text) {
      throw new Error(`the independent host-helper layout does not join back exactly: ${line.oracleId}`);
    }
    if (line.text.startsWith("A-LONG ") && staticRows.length < 2) {
      throw new Error(`the frozen A-LONG line must produce multiple native rows at ${width} columns`);
    }
    if (line.text.length === 0) {
      if (staticRows.length !== 1 || staticRows[0] !== "" || widths[0] !== 0) {
        throw new Error(`an empty static line must lay out as exactly one empty row: ${line.oracleId}`);
      }
    } else {
      for (let index = 0; index < staticRows.length; index += 1) {
        if (staticRows[index]!.length === 0
          || !Number.isSafeInteger(widths[index])
          || widths[index]! <= 0
          || widths[index]! > width) {
          throw new Error(`an independent static row has an unsafe cell width: ${line.oracleId}`);
        }
      }
    }
    rows.push(...staticRows);
  }
  return rows;
}

function noticeRows(problem: string, width: number, rows: number, expiresAt: string): string[] {
  const logical = [
    "Esc rejects",
    "Acceptance disabled",
    problem,
    "Resize to at least 48x10 or press Escape to reject.",
    "No file content is counted as reviewed in this layout.",
    "HUMAN REVIEW",
    `Deadline: ${expiresAt}`,
  ];
  const flattened: string[] = [];
  for (const line of logical) flattened.push(...wrapAsciiLiteral(line, Math.max(1, width)));
  const selected = flattened.slice(0, rows);
  while (selected.length < rows) selected.push("");
  return selected;
}

function headerRows(supported: boolean, pageIndex: number, pageCount: number, shown: number, ready: boolean): string[] {
  if (!supported) return ["HUMAN REVIEW — display unavailable", "accept locked · display unsupported"];
  const status = ready
    ? `pages shown: ${shown}/${pageCount} · Accept ready`
    : `pages shown: ${shown}/${pageCount} · Accept locked`;
  return [`HUMAN REVIEW · page ${pageIndex + 1}/${pageCount}`, status];
}

function footerRows(supported: boolean, focus: "reject" | "accept", expiresAt: string): string[] {
  if (!supported) {
    return [
      "Acceptance disabled",
      "Press Escape to reject",
      "Resize for a readable review",
      `Deadline: ${expiresAt}`,
    ];
  }
  return [
    focus === "accept"
      ? "Decision: ○ Reject   ● Accept reviewed files"
      : "Decision: ● Reject   ○ Accept reviewed files",
    "↑/↓ browse pages · Enter confirms",
    "All pages shown → ↓ selects Accept, then Enter",
    `Esc rejects · Deadline: ${expiresAt}`,
  ];
}

interface Frame {
  plain: string[];
  widths: number[];
  columns: number;
  rows: number;
  supported: boolean;
  pageIndex: number;
  pageCount: number;
  verifiedCount: number;
}

function executionCallChecks(evidence: NativeEvidence, document: ExpectedDocument): Array<{ id: string; ok: boolean; detail: string }> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const { starts, ends } = executeCallEvents(evidence);
  const unique = (rows: NativeEvent[]): Map<string, NativeEvent> => {
    const map = new Map<string, NativeEvent>();
    for (const row of rows) {
      const toolCallId = typeof row.toolCallId === "string" ? row.toolCallId : "";
      if (toolCallId === "" || map.has(toolCallId)) return new Map();
      map.set(toolCallId, row);
    }
    return map;
  };
  const startMap = unique(starts);
  const endMap = unique(ends);
  checks.push({
    id: "execute_start_identity",
    ok: starts.length > 0 && startMap.size === starts.length,
    detail: `${starts.length} actual readonly tool_call start(s)`,
  });
  checks.push({
    id: "execute_terminal_identity",
    ok: ends.length > 0 && endMap.size === ends.length,
    detail: `${ends.length} actual tool_result terminal event(s)`,
  });
  const paired = starts.length === 1 && ends.length === 1
    && startMap.size === 1 && endMap.size === 1
    && [...startMap.keys()][0] === [...endMap.keys()][0];
  checks.push({ id: "execute_start_terminal_pair", ok: paired, detail: "one actual start must have exactly one real terminal event" });
  if (paired) {
    const start = [...startMap.values()][0]!;
    const end = [...endMap.values()][0]!;
    const terminal = parseRunIdentity(String(end.content ?? ""));
    checks.push({
      id: "execute_single_successful_run",
      ok: end.isError !== true
        && terminal !== null
        && terminal.runId === document.preview.runId
        && terminal.callId === document.provenance.callId
        && terminal.taskId === document.preview.task.taskId
        && terminal.taskRevision === document.preview.task.taskRevision,
      detail: `isError=${String(end.isError)} expectedRun=${document.preview.runId} terminal=${JSON.stringify(terminal)}`,
    });
    const startSource = typeof start.input?.source === "string" ? start.input.source : null;
    const endSource = typeof end.input?.source === "string" ? end.input.source : null;
    const sourceIdentity = startSource === null
      ? null
      : { bytes: Buffer.byteLength(startSource, "utf8"), sha256: sha256Text(startSource) };
    checks.push({
      id: "execute_source_input_identity",
      ok: startSource !== null
        && startSource === endSource
        && sameJson(sourceIdentity, document.provenance.source)
        && sameJson(start.input?.inputIds, document.provenance.inputs.map((input) => input.id))
        && sameJson(end.input?.inputIds, document.provenance.inputs.map((input) => input.id)),
      detail: `source=${JSON.stringify(sourceIdentity)} inputs=${JSON.stringify(start.input?.inputIds ?? null)}`,
    });
    checks.push({
      id: "execute_toolcall_not_adapter_callid",
      ok: true,
      detail: "OMP toolCallId is a transport identity and is never compared with the adapter callId",
    });
  } else {
    checks.push({ id: "execute_single_successful_run", ok: false, detail: "no uniquely paired actual run" });
    checks.push({ id: "execute_source_input_identity", ok: false, detail: "actual start/terminal source identity is not uniquely paired" });
    checks.push({ id: "execute_toolcall_not_adapter_callid", ok: false, detail: "actual start/terminal identities are not uniquely paired" });
  }
  for (const start of starts) {
    const toolCallId = String(start.toolCallId);
    if (!endMap.has(toolCallId)) {
      checks.push({ id: `execute_missing_terminal_${toolCallId}`, ok: false, detail: "an actual call has no terminal identity" });
    }
  }
  for (const end of ends) {
    const toolCallId = String(end.toolCallId);
    if (!startMap.has(toolCallId)) {
      checks.push({ id: `execute_missing_start_${toolCallId}`, ok: false, detail: "a terminal event has no actual readonly call start" });
    }
  }
  return checks;
}

export function gradeAcceptance(evidence: NativeEvidence, document: ExpectedDocument, caseName: string): Array<{ id: string; ok: boolean; detail: string }> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  checks.push(...executionCallChecks(evidence, document));
  const positive = caseName === "positive-no-contract" || caseName === "positive-partial-hybrid";
  const ownerTask = evidence.owner.currentTask as Record<string, any> | null;
  if (!positive) {
    checks.push({
      id: "negative_no_installed_record",
      ok: evidence.acceptance.size === 0,
      detail: `${evidence.acceptance.size} acceptance tree file(s)`,
    });
    checks.push({
      id: "negative_task_not_accepted",
      ok: ownerTask !== null && ownerTask.status === "active" && ownerTask.acceptance === null,
      detail: `owner status ${String(ownerTask?.status)} acceptance ${JSON.stringify(ownerTask?.acceptance ?? null)}`,
    });
    return checks;
  }
  const records = [...evidence.acceptance.entries()].flatMap(([name, bytes]) => {
    if (!name.endsWith(".json")) return [];
    try {
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
      return value.schemaVersion === 2 && typeof value.acceptanceId === "string" ? [{ name, bytes, value }] : [];
    } catch {
      return [];
    }
  });
  checks.push({ id: "single_installed_record", ok: records.length === 1, detail: `${records.length} v2 record(s)` });
  const record = records.length === 1 ? records[0]!.value : null;
  if (record === null) return checks;
  checks.push({
    id: "record_digest_physical_bytes",
    ok: ownerTask?.acceptance?.recordDigest === sha256Bytes(records[0]!.bytes),
    detail: `owner=${String(ownerTask?.acceptance?.recordDigest)} physical=${sha256Bytes(records[0]!.bytes)}`,
  });
  const display = record.humanReview?.display ?? {};
  checks.push({ id: "record_display_digest", ok: display.digest === document.digest, detail: `record=${String(display.digest)} expected=${document.digest}` });
  checks.push({ id: "record_display_bytes", ok: display.renderedBytes === document.renderedBytes && display.rawContentBytes === document.rawContentBytes, detail: `rendered=${String(display.renderedBytes)} raw=${String(display.rawContentBytes)}` });
  checks.push({ id: "record_display_counts", ok: display.fileCount === document.fileCount && JSON.stringify(display.requirementRevisions) === JSON.stringify(document.requirementRevisions), detail: `files=${String(display.fileCount)} revisions=${JSON.stringify(display.requirementRevisions)}` });
  checks.push({ id: "record_deadline", ok: record.humanReview?.expiresAt === document.expiresAt, detail: `record=${String(record.humanReview?.expiresAt)} painted=${document.expiresAt}` });
  checks.push({ id: "record_decision", ok: record.humanReview?.decision === "approve" && record.humanReview?.interactionSource === "local-main-tui-component", detail: `decision=${String(record.humanReview?.decision)} source=${String(record.humanReview?.interactionSource)}` });
  const expectedPolicy = caseName === "positive-partial-hybrid" ? "hybrid-human-review" : "human-review";
  checks.push({ id: "record_policy_source", ok: record.policy?.source === expectedPolicy, detail: `source=${String(record.policy?.source)} expected=${expectedPolicy}` });
  checks.push({
    id: "record_task_identity",
    ok: JSON.stringify({ ownerId: record.task?.ownerId, taskId: record.task?.taskId, taskRevision: record.task?.taskRevision, requirementsDigest: record.task?.requirementsDigest })
      === JSON.stringify(document.preview.task),
    detail: `record=${JSON.stringify(record.task)} expected=${JSON.stringify(document.preview.task)}`,
  });
  checks.push({ id: "record_requirements_digest", ok: record.requirements?.digest === document.preview.task.requirementsDigest, detail: `record=${String(record.requirements?.digest)}` });
  const recordFiles = Array.isArray(record.delivery?.files) ? record.delivery.files : [];
  const expectedFiles = document.model.delivery.files as Array<Record<string, any>>;
  const fileProjection = (rows: Array<Record<string, any>>) => rows.map((file) => ({
    artifactId: file.artifactId,
    relativePath: file.relativePath,
    name: safeText(String(file.name)),
    bytes: file.bytes,
    sha256: file.sha256,
  }));
  checks.push({ id: "record_file_set", ok: JSON.stringify(fileProjection(recordFiles)) === JSON.stringify(fileProjection(expectedFiles)), detail: `${recordFiles.length} record file(s)` });
  checks.push({
    id: "record_candidate_source",
    ok: sameJson(record.candidate?.source, document.provenance.source),
    detail: `record=${JSON.stringify(record.candidate?.source ?? null)} expected=${JSON.stringify(document.provenance.source)}`,
  });
  checks.push({
    id: "record_candidate_inputs",
    ok: sameJson(inputProjection(record.candidate?.inputs), document.provenance.inputs),
    detail: `record=${JSON.stringify(record.candidate?.inputs ?? null)}`,
  });
  checks.push({
    id: "record_candidate_artifacts",
    ok: sameJson(artifactProjection(record.candidate?.artifacts), document.provenance.artifacts),
    detail: `record=${JSON.stringify(record.candidate?.artifacts ?? null)}`,
  });
  const binding = (record.humanReview?.binding ?? {}) as Record<string, any>;
  checks.push({
    id: "record_binding_identity",
    ok: binding.deliveryId === document.preview.deliveryId
      && binding.previewDigest === document.preview.previewDigest
      && binding.runId === document.preview.runId
      && binding.callId === document.provenance.callId,
    detail: `binding=${JSON.stringify({ deliveryId: binding.deliveryId, previewDigest: binding.previewDigest, runId: binding.runId, callId: binding.callId })}`,
  });
  checks.push({
    id: "record_binding_source_inputs",
    ok: sameJson({ source: binding.source, inputs: inputProjection(binding.inputs) }, {
      source: document.provenance.source,
      inputs: document.provenance.inputs,
    }),
    detail: `binding=${JSON.stringify({ source: binding.source, inputs: binding.inputs })}`,
  });
  checks.push({
    id: "record_binding_artifacts",
    ok: sameJson(artifactProjection(binding.artifacts), document.provenance.artifacts),
    detail: `binding=${JSON.stringify(binding.artifacts ?? null)}`,
  });
  checks.push({
    id: "record_delivery_identity",
    ok: record.delivery?.deliveryId === document.preview.deliveryId
      && record.delivery?.previewDigest === document.preview.previewDigest
      && record.delivery?.runId === document.preview.runId
      && record.candidate?.callId === document.model.delivery.callId,
    detail: `delivery=${String(record.delivery?.deliveryId)} run=${String(record.delivery?.runId)} call=${String(record.candidate?.callId)}`,
  });
  if (caseName === "positive-partial-hybrid") {
    checks.push({ id: "hybrid_contract_present", ok: record.contract !== null && typeof record.contract?.digest === "string", detail: `contract=${String(record.contract?.contractId)}` });
    checks.push({ id: "hybrid_receipt_insufficient", ok: record.receipt?.receipt?.outcome === "insufficient" && record.receipt?.receipt?.taskAccepted === false, detail: `outcome=${String(record.receipt?.receipt?.outcome)} accepted=${String(record.receipt?.receipt?.taskAccepted)}` });
    checks.push({
      id: "hybrid_receipt_object_original",
      ok: document.originalReceipt !== null
        && JSON.stringify(record.receipt?.receipt) === JSON.stringify(document.originalReceipt),
      detail: "the installed receipt object must equal the pre-review host receipt",
    });
    const recomputedReceiptDigest = record.receipt?.receipt === null || record.receipt?.receipt === undefined
      ? null
      : sha256Text(JSON.stringify(record.receipt.receipt));
    checks.push({
      id: "hybrid_receipt_recomputed_digest",
      ok: document.originalReceiptDigest !== null
        && recomputedReceiptDigest === document.originalReceiptDigest
        && record.receipt?.digest === document.originalReceiptDigest
        && record.receipt?.digest === document.model.automatic.receiptDigest,
      detail: `recomputed=${String(recomputedReceiptDigest)} original=${String(document.originalReceiptDigest)} record=${String(record.receipt?.digest)}`,
    });
    checks.push({ id: "hybrid_binding_contract", ok: record.humanReview?.binding?.contractDigest === record.contract?.digest, detail: `binding=${String(record.humanReview?.binding?.contractDigest)}` });
  } else {
    checks.push({ id: "human_contract_absent", ok: record.contract === null, detail: `contract=${JSON.stringify(record.contract)}` });
    checks.push({ id: "human_receipt_absent", ok: record.receipt?.receipt === null, detail: `receipt=${JSON.stringify(record.receipt?.receipt ?? null)}` });
  }
  checks.push({
    id: "owner_accepted_once",
    ok: ownerTask !== null && ownerTask.status === "accepted" && ownerTask.acceptance?.acceptanceId === record.acceptanceId,
    detail: `owner status ${String(ownerTask?.status)} acceptance ${String(ownerTask?.acceptance?.acceptanceId)}`,
  });
  return checks;
}

export function gradeDailyComposition(
  evidence: NativeEvidence,
  document: ExpectedDocument,
): Array<{ id: string; ok: boolean; detail: string }> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const check = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const sequence = (event: Record<string, any> | undefined): number | null => {
    const value = event?.sequence;
    return Number.isSafeInteger(value) ? Number(value) : null;
  };
  const turns = evidence.provider
    .filter((event) => event.type === "provider_turn")
    .sort((left, right) => Number(left.step) - Number(right.step));
  const callNames = turns.map((turn) => {
    const call = turn.call;
    if (call === null || typeof call !== "object") return "text";
    if (call.name === "agent_deliver") return `agent_deliver:${String(call.arguments?.action)}`;
    return String(call.name);
  });
  const expectedNames = [
    "agent_task",
    "agent_execute",
    "agent_verify",
    "agent_deliver:preview",
    "agent_deliver:request_review",
    "agent_deliver:inspect",
    "agent_task",
    "text",
  ];
  check("daily_provider_sequence", JSON.stringify(callNames) === JSON.stringify(expectedNames), `calls=${JSON.stringify(callNames)}`);

  const verifyTurn = turns.find((turn) => turn.call?.name === "agent_verify");
  const verifyArgs = verifyTurn?.call?.arguments as Record<string, any> | undefined;
  const verifyResultTurn = verifyTurn === undefined
    ? undefined
    : turns.find((turn) => Number(turn.step) === Number(verifyTurn.step) + 1);
  const verifyText = typeof verifyResultTurn?.lastToolResult === "string" ? verifyResultTurn.lastToolResult : "";
  const verifyTask = (() => {
    const line = verifyText.split("\n").find((row) => row.startsWith("task: "));
    if (line === undefined) return null;
    try {
      return JSON.parse(line.slice("task: ".length)) as Record<string, any>;
    } catch {
      return null;
    }
  })();
  const verifyCandidates = (() => {
    const line = verifyText.split("\n").find((row) => row.startsWith("candidates: "));
    if (line === undefined) return null;
    try {
      return JSON.parse(line.slice("candidates: ".length)) as Record<string, any>;
    } catch {
      return null;
    }
  })();
  const expectedArtifactIds = document.provenance.artifacts.map((artifact) => artifact.artifactId);
  check(
    "daily_verify_selectors",
    verifyArgs !== undefined
      && verifyArgs.action === "verify"
      && verifyArgs.expectedTaskId === document.preview.task.taskId
      && verifyArgs.expectedTaskRevision === document.preview.task.taskRevision
      && verifyArgs.runId === document.preview.runId
      && JSON.stringify(verifyArgs.artifactIds) === JSON.stringify(expectedArtifactIds),
    JSON.stringify(verifyArgs ?? null),
  );
  check(
    "daily_verify_insufficient",
    verifyText.includes("taskAccepted: false")
      && verifyText.includes("outcome: insufficient")
      && verifyText.includes("contract: none")
      && /^receiptId: \S+$/m.test(verifyText)
      && verifyText.includes("currentlyUsable: false")
      && verifyText.includes("compatibility: current"),
    verifyText.slice(0, 1200),
  );
  check(
    "daily_verify_task_identity",
    verifyTask !== null
      && verifyTask.ownerId === document.preview.task.ownerId
      && verifyTask.taskId === document.preview.task.taskId
      && verifyTask.taskRevision === document.preview.task.taskRevision
      && verifyTask.requirementsDigest === document.preview.task.requirementsDigest,
    JSON.stringify(verifyTask ?? null),
  );
  check(
    "daily_verify_run_identity",
    verifyCandidates !== null && verifyCandidates.runId === document.preview.runId,
    JSON.stringify(verifyCandidates ?? null),
  );

  const previewTurn = turns.find((turn) => turn.call?.name === "agent_deliver"
    && turn.call?.arguments?.action === "preview");
  check(
    "daily_preview_no_unbound_receipt",
    previewTurn?.call?.arguments?.verificationReceiptId === undefined,
    JSON.stringify(previewTurn?.call?.arguments ?? null),
  );

  const reviewStarts = evidence.audit.filter((event) => event.type === "tool_call_start"
    && event.toolName === "agent_deliver"
    && event.params?.action === "request_review");
  const reviewStart = reviewStarts.length === 1 ? reviewStarts[0]! : undefined;
  const reviewEnd = reviewStart === undefined
    ? undefined
    : evidence.audit.find((event) => event.type === "tool_call_end"
      && event.toolCallId === reviewStart.toolCallId);
  let reviewJson: Record<string, any> | null = null;
  try {
    reviewJson = reviewEnd === undefined ? null : JSON.parse(String(reviewEnd.content)) as Record<string, any>;
  } catch {
    reviewJson = null;
  }
  check(
    "daily_review_call_unique",
    reviewStarts.length === 1 && reviewEnd !== undefined,
    `starts=${reviewStarts.length} end=${reviewEnd === undefined ? "missing" : String(reviewEnd.toolCallId)}`,
  );
  check(
    "daily_review_execute_context",
    reviewStart?.context?.mode === "tui"
      && reviewStart?.context?.agentKind === "main"
      && reviewStart?.context?.hasUI === true
      && reviewStart?.context?.customType === "function",
    JSON.stringify(reviewStart?.context ?? null),
  );
  check(
    "daily_review_selectors",
    reviewStart?.params?.expectedTaskId === document.preview.task.taskId
      && reviewStart?.params?.expectedTaskRevision === document.preview.task.taskRevision
      && reviewStart?.params?.deliveryId === document.preview.deliveryId,
    JSON.stringify(reviewStart?.params ?? null),
  );
  check(
    "daily_review_rejected",
    reviewJson !== null
      && reviewJson.format === "agent-deliver-result-v1"
      && reviewJson.action === "request_review"
      && reviewJson.humanReviewConfigured === true
      && reviewJson.review?.state === "rejected"
      && reviewJson.operation?.outcome === "not_committed"
      && reviewJson.operation?.operationCommitted === false
      && reviewJson.taskAccepted === false,
    JSON.stringify(reviewJson ?? null).slice(0, 2000),
  );
  check(
    "daily_review_rejection_is_terminal",
    reviewEnd?.isError === true,
    `isError=${String(reviewEnd?.isError)}`,
  );

  const mounts = evidence.audit.filter((event) => event.type === "custom_call");
  const factories = evidence.audit.filter((event) => event.type === "factory");
  const mountsId = mounts.length === 1 ? String(mounts[0]!.mountId) : "";
  const factory = factories.length === 1 && String(factories[0]!.mountId) === mountsId ? factories[0] : undefined;
  check(
    "daily_single_mount",
    mounts.length === 1 && factory !== undefined && mounts[0]!.mountCount === 1 && factory.factoryCount === 1,
    `mounts=${mounts.length} factories=${factories.length}`,
  );
  const paints = evidence.audit.filter((event) => event.type === "paint" && String(event.mountId) === mountsId);
  const completed = paints.find((event) => event.alt === true
    && event.columns === 100
    && event.rows === 30
    && event.viewportTruncated === false
    && Array.isArray(event.plainViewport)
    && event.plainViewport.length === 30
    && Array.isArray(event.plainWidths)
    && event.plainWidths.length === 30
    && event.plainWidths.every((width: unknown) => Number.isSafeInteger(width) && Number(width) >= 0 && Number(width) <= 100));
  check(
    "daily_completed_paint",
    completed !== undefined && factory !== undefined,
    completed === undefined ? `paints=${paints.length}` : `paintSequence=${String(completed.paintSequence)}`,
  );
  const settles = evidence.audit.filter((event) => event.type === "custom_settled" && String(event.mountId) === mountsId);
  const settle = settles.length === 1 ? settles[0]! : undefined;
  check(
    "daily_reject_settlement",
    settle !== undefined
      && settle.result === "reject"
      && settle.settledCount === 1
      && Number(settle.disposedInvocations) >= 1
      && settle.subscriptions === 0
      && settle.subscriptionState?.paint === "removed"
      && settle.subscriptionState?.frame === "removed"
      && settle.harnessFailures === 0
      && Array.isArray(settle.evidenceTruncations)
      && settle.evidenceTruncations.length === 0,
    JSON.stringify(settle ?? null),
  );
  const disposes = evidence.audit.filter((event) => event.type === "dispose" && String(event.mountId) === mountsId);
  check(
    "daily_component_disposed",
    disposes.some((event) => event.subscriptions === 0
      && event.subscriptionState?.paint === "removed"
      && event.subscriptionState?.frame === "removed"
      && event.harnessFailures === 0),
    JSON.stringify(disposes.at(-1) ?? null),
  );
  check(
    "daily_no_post_dispose_activity",
    !evidence.audit.some((event) => event.type === "post_dispose_call" && String(event.mountId) === mountsId),
    "post_dispose_call events",
  );
  const escapeInputs = evidence.audit.filter((event) => event.type === "handle_input" && event.text === "\x1b");
  check(
    "daily_escape_after_paint",
    escapeInputs.length === 1
      && completed !== undefined
      && sequence(escapeInputs[0]) !== null
      && sequence(completed) !== null
      && sequence(escapeInputs[0])! > sequence(completed)!
      && settle !== undefined
      && sequence(settle) !== null
      && sequence(escapeInputs[0])! < sequence(settle)!,
    `escape=${String(sequence(escapeInputs[0]))} paint=${String(sequence(completed))} settle=${String(sequence(settle))}`,
  );

  const agentEnd = evidence.audit.find((event) => event.type === "agent_end");
  const editor = evidence.audit.find((event) => event.type === "editor_recovered");
  const shutdown = evidence.audit.find((event) => event.type === "session_shutdown");
  check(
    "daily_chronology",
    sequence(reviewStart) !== null
      && sequence(factory) !== null
      && sequence(completed) !== null
      && sequence(settle) !== null
      && sequence(reviewEnd) !== null
      && sequence(agentEnd) !== null
      && sequence(editor) !== null
      && sequence(shutdown) !== null
      && sequence(reviewStart)! < sequence(factory)!
      && sequence(factory)! < sequence(completed)!
      && sequence(completed)! < sequence(settle)!
      && sequence(settle)! < sequence(reviewEnd)!
      && sequence(reviewEnd)! < sequence(agentEnd)!
      && sequence(agentEnd)! < sequence(editor)!
      && sequence(editor)! < sequence(shutdown)!,
    JSON.stringify({
      start: sequence(reviewStart),
      factory: sequence(factory),
      paint: sequence(completed),
      settle: sequence(settle),
      result: sequence(reviewEnd),
      agentEnd: sequence(agentEnd),
      editor: sequence(editor),
      shutdown: sequence(shutdown),
    }),
  );

  const ownerTask = evidence.owner.currentTask as Record<string, any> | null;
  check(
    "daily_owner_not_accepted",
    ownerTask !== null && ownerTask.status === "active" && ownerTask.acceptance === null
      && evidence.acceptance.size === 0,
    `owner=${JSON.stringify(ownerTask === null ? null : { status: ownerTask.status, acceptance: ownerTask.acceptance })} acceptanceFiles=${evidence.acceptance.size}`,
  );
  const deliveryRoot = String(evidence.driver.roots?.deliveryRoot ?? "");
  const deliveryOk = path.isAbsolute(deliveryRoot) && document.preview.files.every((file: Record<string, any>) => {
    const relative = path.relative(deliveryRoot, String(file.path));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
    const bytes = evidence.delivery.get(relative);
    return bytes !== undefined
      && bytes.length === Number(file.bytes)
      && sha256Bytes(bytes) === String(file.sha256);
  });
  check("daily_delivery_bytes_intact", deliveryOk, `${document.model.delivery.files.length} selected file(s)`);
  const finalTurn = turns.at(-1);
  check(
    "daily_final_statement",
    finalTurn?.call === null
      && typeof finalTurn?.text === "string"
      && finalTurn.text.includes("DONE:")
      && finalTurn.lastToolResult !== undefined,
    JSON.stringify(finalTurn ?? null).slice(0, 400),
  );
  const driverInputs = Array.isArray(evidence.driver.inputs) ? evidence.driver.inputs as Array<Record<string, any>> : [];
  check(
    "daily_driver_escape_input",
    driverInputs.some((input) => input.label === "daily-escape" && input.hex === "1b"),
    JSON.stringify(driverInputs.filter((input) => String(input.label).includes("escape"))),
  );
  return checks;
}

export function gradeFrames(events: NativeEvent[], document: ExpectedDocument, caseName: string): { checks: Array<{ id: string; ok: boolean; detail: string }>; firstMismatch: Record<string, any> | null } {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const failures: Array<Record<string, any>> = [];
  const wrappedCache = new Map<number, string[]>();
  const oracle = oracleLayoutFor(events);
  const rowsForWidth = (width: number): string[] => {
    const cached = wrappedCache.get(width);
    if (cached !== undefined) return cached;
    const rows = layoutRows(document, width, oracle);
    wrappedCache.set(width, rows);
    return rows;
  };
  let layoutKey = "";
  let pageIndex = 0;
  let pageCount = 0;
  let focus: "reject" | "accept" = "reject";
  let verified = new Set<number>();
  let pending: Frame | null = null;
  let settled: "approve" | "reject" | null = null;
  let selectionSeen = false;
  let enterAfterSelection = false;
  let supportedFrames = 0;
  let unsupportedFrames = 0;
  let maxVerified = 0;

  const reset = (): void => {
    pageIndex = 0;
    focus = "reject";
    verified = new Set<number>();
    pending = null;
    maxVerified = 0;
  };

  const acceptEligible = (): boolean => settled === null
    && pending !== null
    && pending.supported
    && pending.pageCount > 0
    && verified.size === pending.pageCount;

  for (const event of events) {
    if (event.type === "render") {
      const width = Number(event.width);
      const rows = Number(event.rows);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(rows) || width <= 0 || rows <= 0) {
        failures.push({ event: "render", detail: "render geometry is missing" });
        continue;
      }
      const key = `${width}x${rows}`;
      if (key !== layoutKey) {
        layoutKey = key;
        reset();
      }
      if (event.outputTruncated === true) {
        failures.push({ event: "render", detail: "render output was truncated" });
        continue;
      }
      const output = Array.isArray(event.output) ? event.output.map(String) : [];
      const widths = Array.isArray(event.outputWidths) ? event.outputWidths.map(Number) : [];
      if (output.length !== rows || widths.length !== rows || widths.some((value) => !Number.isSafeInteger(value) || value < 0 || value > width)) {
        failures.push({ event: "render", detail: `render row/width shape invalid: rows=${output.length} widths=${widths.length} terminalRows=${rows}` });
        continue;
      }
      const supported = width >= 48 && rows >= 10 && rows - 6 >= 1;
      let plain: string[];
      if (supported) {
        const bodyHeight = rows - 6;
        const contentRows = rowsForWidth(width);
        pageCount = contentRows.length === 0 ? 1 : Math.ceil(contentRows.length / bodyHeight);
        if (pageIndex >= pageCount) pageIndex = pageCount - 1;
        const body = contentRows.slice(pageIndex * bodyHeight, (pageIndex + 1) * bodyHeight);
        while (body.length < bodyHeight) body.push("");
        plain = [
          ...headerRows(true, pageIndex, pageCount, verified.size, verified.size === pageCount),
          ...body,
          ...footerRows(true, focus, document.expiresAt),
        ];
        supportedFrames += 1;
      } else {
        pageCount = 0;
        const problem = width < 48 || rows < 10
          ? `terminal is ${width}x${rows}; minimum is 48x10`
          : "no readable review rows fit in this terminal";
        plain = noticeRows(problem, width, rows, document.expiresAt);
        unsupportedFrames += 1;
      }
      while (plain.length < rows) plain.push("");
      plain = plain.slice(0, rows);
      for (let index = 0; index < rows; index += 1) {
        if (output[index] !== plain[index]) {
          failures.push({
            event: "render",
            row: index,
            expected: plain[index],
            actual: output[index],
            detail: `render row ${index} differs`,
          });
          break;
        }
      }
      if (focus === "accept" && supported) selectionSeen = true;
      pending = {
        plain,
        widths,
        columns: width,
        rows,
        supported,
        pageIndex,
        pageCount,
        verifiedCount: verified.size,
      };
      continue;
    }
    if (event.type === "paint") {
      if (pending === null) {
        failures.push({ event: "paint", detail: "a completed paint has no preceding render frame" });
        continue;
      }
      const columns = Number(event.columns);
      const rows = Number(event.rows);
      if (event.alt !== true || columns !== pending.columns || rows !== pending.rows) {
        failures.push({ event: "paint", detail: `paint geometry/alt mismatch: alt=${event.alt} ${columns}x${rows} vs ${pending.columns}x${pending.rows}` });
        continue;
      }
      const viewport = Array.isArray(event.normalizedViewport) && event.normalizedViewport.length === rows
        ? event.normalizedViewport
        : event.plainViewport;
      if (event.viewportTruncated === true || !Array.isArray(viewport) || viewport.length !== rows) {
        failures.push({ event: "paint", detail: "completed paint viewport is truncated or incomplete" });
        continue;
      }
      const actual = viewport.map(String);
      for (let index = 0; index < rows; index += 1) {
        const width = pending.widths[index]!;
        const padded = pending.plain[index]! + " ".repeat(Math.max(0, columns - width));
        if (actual[index] !== padded) {
          failures.push({
            event: "paint",
            row: index,
            expected: padded,
            actual: actual[index],
            detail: `paint row ${index} differs`,
          });
          break;
        }
      }
      if (pending.supported && pending.pageCount > 0) {
        verified.add(pending.pageIndex);
        maxVerified = Math.max(maxVerified, verified.size);
      }
      continue;
    }
    if (event.type === "handle_input") {
      if (settled !== null) continue;
      const data = typeof event.text === "string" ? event.text : null;
      if (data === null) continue;
      if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
        focus = "reject";
        continue;
      }
      if (data === "\x1b") {
        settled = "reject";
        continue;
      }
      if (data === "\r" || data === "\n") {
        if (focus === "accept") {
          if (acceptEligible()) {
            settled = "approve";
            enterAfterSelection = true;
          } else {
            settled = "reject";
          }
        } else {
          settled = "reject";
        }
        continue;
      }
      if (data === "\x1b[B" || data === "\x1b[C" || data === "\x1b[6~") {
        if (focus === "accept") continue;
        if (pending !== null && pending.supported && pageIndex < pageCount - 1) pageIndex += 1;
        else if (acceptEligible()) focus = "accept";
        continue;
      }
      if (data === "\x1b[A" || data === "\x1b[D" || data === "\x1b[5~") {
        if (focus === "accept") focus = "reject";
        else if (pageIndex > 0) pageIndex -= 1;
        continue;
      }
    }
  }

  checks.push({ id: "render_paint_sequence", ok: failures.length === 0, detail: failures.length === 0 ? "every observed render and completed paint matched the independent expected frame" : "frame mismatch" });
  const finalPageOk = pending !== null && pending.supported && maxVerified === pageCount && pageCount > 0;
  const positive = caseName === "positive-no-contract" || caseName === "positive-partial-hybrid";
  if (positive) {
    checks.push({ id: "complete_page_coverage", ok: finalPageOk, detail: `verified ${maxVerified}/${pageCount} pages` });
    checks.push({ id: "explicit_accept_selection", ok: selectionSeen, detail: selectionSeen ? "an Accept-selected frame was painted" : "no Accept-selected frame" });
    checks.push({ id: "separate_enter_after_selection", ok: enterAfterSelection, detail: enterAfterSelection ? "Enter was observed after the explicit Accept selection" : "no separate Enter after selection" });
    checks.push({ id: "review_approved", ok: settled === "approve", detail: settled === "approve" ? "the observed component settled approve" : `observed settlement ${String(settled)}` });
  } else if (caseName === "resize-reject") {
    checks.push({ id: "small_unsupported_geometry", ok: unsupportedFrames > 0, detail: `observed ${unsupportedFrames} unsupported frames` });
    checks.push({ id: "resized_complete_traversal", ok: finalPageOk, detail: `verified ${maxVerified}/${pageCount} pages after resize` });
    checks.push({ id: "resize_rejected", ok: settled === "reject", detail: `observed settlement ${String(settled)}` });
  } else if (caseName === "deadline-expiry") {
    checks.push({ id: "deadline_no_approval", ok: settled !== "approve", detail: `observed settlement ${String(settled)}` });
  } else if (caseName === "initial-enter" || caseName === "escape" || caseName === "daily-escape") {
    checks.push({ id: "negative_no_approval", ok: settled === "reject", detail: `observed settlement ${String(settled)}` });
  }
  return { checks, firstMismatch: failures[0] ?? null };
}

interface RowEdit {
  index: number;
  text?: string;
}

interface MutationTarget {
  label: string;
  edits: (rows: string[]) => RowEdit[];
}

function applyRowEdits(rows: string[], widths: number[], edits: RowEdit[]): { rows: string[]; widths: number[] } | null {
  const nextRows = [...rows];
  const nextWidths = [...widths];
  const seen = new Set<number>();
  for (const edit of [...edits].sort((left, right) => right.index - left.index)) {
    if (!Number.isSafeInteger(edit.index) || edit.index < 0 || edit.index >= rows.length || seen.has(edit.index)) return null;
    seen.add(edit.index);
    if (edit.text === undefined) {
      nextRows.splice(edit.index, 1);
      nextWidths.splice(edit.index, 1);
      continue;
    }
    const old = nextRows[edit.index]!;
    if (!/^[\x20-\x7e]*$/.test(old) || !/^[\x20-\x7e]*$/.test(edit.text)) return null;
    const oldWidth = nextWidths[edit.index] ?? old.length;
    const width = oldWidth + (edit.text.length - old.length);
    if (!Number.isSafeInteger(width) || width < 0) return null;
    nextRows[edit.index] = edit.text;
    nextWidths[edit.index] = width;
  }
  while (nextRows.length < rows.length) {
    nextRows.push("");
    nextWidths.push(0);
  }
  return { rows: nextRows, widths: nextWidths };
}

function mutateFrame(events: NativeEvent[], target: MutationTarget): NativeEvent[] | null {
  const copy = structuredClone(events) as NativeEvent[];
  for (let renderIndex = 0; renderIndex < copy.length; renderIndex += 1) {
    const render = copy[renderIndex]!;
    if (render.type !== "render" || !Array.isArray(render.output) || !Array.isArray(render.outputWidths)) continue;
    const edits = target.edits(render.output.map(String));
    if (edits.length === 0) continue;
    let paintIndex = -1;
    for (let index = renderIndex + 1; index < copy.length; index += 1) {
      if (copy[index]!.type === "render") break;
      if (copy[index]!.type === "paint") {
        paintIndex = index;
        break;
      }
    }
    if (paintIndex < 0) continue;
    const paint = copy[paintIndex]!;
    if (!Array.isArray(paint.plainViewport) || paint.plainViewport.length !== render.output.length) continue;
    const columns = Number(paint.columns ?? render.columns ?? render.width);
    if (!Number.isSafeInteger(columns) || columns <= 0) continue;
    const renderNext = applyRowEdits(render.output.map(String), render.outputWidths.map(Number), edits);
    if (renderNext === null) continue;
    const paintRows = renderNext.rows.map((row, index) => {
      const visible = renderNext.widths[index]!;
      if (!Number.isSafeInteger(visible) || visible < 0 || visible > columns) return null;
      return row + " ".repeat(columns - visible);
    });
    if (paintRows.some((row) => row === null)) continue;
    const rebuilt = paintRows as string[];
    render.output = renderNext.rows;
    render.outputWidths = renderNext.widths;
    paint.plainViewport = rebuilt;
    paint.plainWidths = rebuilt.map((row) => row.length);
    if (Array.isArray(paint.normalizedViewport)) paint.normalizedViewport = [...rebuilt];
    paint.viewportHash = sha256Text(JSON.stringify(rebuilt));
    return copy;
  }
  return null;
}

function alternateIdentity(line: string): string | null {
  const match = /^((?:runId|deliveryId|callId|taskId): )(\S+)$/.exec(line);
  if (!match) return null;
  const prefix = match[1]!;
  const value = match[2]!;
  const characters = [...value];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    if (/[0-9]/.test(character)) characters[index] = character === "0" ? "1" : "0";
    else if (/[a-f]/.test(character)) characters[index] = character === "a" ? "b" : "a";
    else if (/[A-F]/.test(character)) characters[index] = character === "A" ? "B" : "A";
    else if (/[g-z]/.test(character)) characters[index] = character === "g" ? "h" : "g";
    else continue;
    const alternate = `${prefix}${characters.join("")}`;
    return alternate === line ? null : alternate;
  }
  return null;
}

function removeAllPaintsForPage(events: NativeEvent[]): { events: NativeEvent[]; page: number; removed: number } | null {
  const copy = structuredClone(events) as NativeEvent[];
  let currentPage: number | null = null;
  const painted = new Set<number>();
  for (const event of copy) {
    if (event.type === "render") {
      const header = Array.isArray(event.output) ? String(event.output[0] ?? "") : "";
      const match = /^HUMAN REVIEW · page (\d+)\/(\d+)/.exec(header);
      currentPage = match === null ? null : Number(match[1]) - 1;
    } else if (event.type === "paint" && currentPage !== null) {
      painted.add(currentPage);
    }
  }
  if (painted.size === 0) return null;
  const page = Math.min(...painted);
  currentPage = null;
  let removed = 0;
  for (let index = 0; index < copy.length; index += 1) {
    const event = copy[index]!;
    if (event.type === "render") {
      const header = Array.isArray(event.output) ? String(event.output[0] ?? "") : "";
      const match = /^HUMAN REVIEW · page (\d+)\/(\d+)/.exec(header);
      currentPage = match === null ? null : Number(match[1]) - 1;
      continue;
    }
    if (event.type !== "paint" || currentPage !== page) continue;
    copy.splice(index, 1);
    index -= 1;
    removed += 1;
  }
  if (removed === 0) return null;
  return { events: copy, page, removed };
}

/**
 * Six in-memory grader selfchecks for the first captured successful positive
 * evidence. The original evidence is never modified; hashes are refreshed on
 * copies so each check reaches the relevant semantic comparison.
 */
export function semanticMutationChecks(
  evidence: NativeEvidence,
  document: ExpectedDocument,
  caseName: string,
): Array<{ id: string; ok: boolean; detail: string }> {
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const baselineFrames = gradeFrames(evidence.audit, document, caseName);
  const baselineAcceptance = gradeAcceptance(evidence, document, caseName);
  const baselineOk = baselineFrames.firstMismatch === null
    && baselineFrames.checks.every((check) => check.ok)
    && baselineAcceptance.every((check) => check.ok);
  checks.push({
    id: "mutation_baseline",
    ok: baselineOk,
    detail: baselineOk ? "unmodified independent grade passes first" : "the unmodified grade does not pass",
  });
  if (!baselineOk) return checks;

  const deleteEdits = (indices: number[]): RowEdit[] => indices.map((index) => ({ index }));
  const fileLine = document.layout.find((line) => line.oracleId?.startsWith("file:") && line.text.includes("A-01"))?.text;
  let identityLine: ExpectedLayoutLine | undefined;
  for (const prefix of ["runId: ", "deliveryId: ", "callId: ", "taskId: "]) {
    identityLine = document.layout.find((line) => line.text.startsWith(prefix));
    if (identityLine !== undefined && alternateIdentity(identityLine.text) !== null) break;
    identityLine = undefined;
  }
  const trailingLine = document.layout.find((line) => line.oracleId?.startsWith("file:")
    && /A-05C trailing spaces only: +$/.test(line.text))
    ?? document.layout.find((line) => line.oracleId?.startsWith("file:") && /A-05B .* +$/.test(line.text));
  const targets: Array<{ id: string; target: MutationTarget }> = [
    {
      id: "mutation_file_interior_line",
      target: {
        label: "interior file line",
        edits: (rows) => {
          const index = fileLine === undefined ? -1 : rows.indexOf(fileLine);
          return index > 0 ? deleteEdits([index]) : [];
        },
      },
    },
    {
      id: "mutation_requirement_block",
      target: {
        label: "whole requirement block",
        edits: (rows) => {
          const start = rows.findIndex((row) => row.startsWith("--- REQUIREMENT 1/"));
          const end = start < 0 ? -1 : rows.findIndex((row, index) => index > start && row.startsWith("--- END REQUIREMENT 1/"));
          return start >= 0 && end > start ? deleteEdits(Array.from({ length: end - start + 1 }, (_, offset) => start + offset)) : [];
        },
      },
    },
    {
      id: "mutation_automatic_limitation",
      target: {
        label: "automatic limitation",
        edits: (rows) => {
          const index = rows.findIndex((row) => row.startsWith("automatic limitation:"));
          return index >= 0 ? deleteEdits([index]) : [];
        },
      },
    },
    {
      id: "mutation_identity_line",
      target: {
        label: "same-shape replacement of a real identity line",
        edits: (rows) => {
          if (identityLine === undefined) return [];
          const index = rows.indexOf(identityLine.text);
          if (index < 0) return [];
          const text = alternateIdentity(identityLine.text);
          return text === null ? [] : [{ index, text }];
        },
      },
    },
    {
      id: "mutation_blank_or_trailing_space",
      target: {
        label: "frozen file-body trailing-space row",
        edits: (rows) => {
          if (trailingLine === undefined) return [];
          const index = rows.indexOf(trailingLine.text);
          if (index < 0) return [];
          const text = trailingLine.text.replace(/ +$/, "");
          return text === trailingLine.text ? [] : [{ index, text }];
        },
      },
    },
  ];
  for (const { id, target } of targets) {
    const mutated = mutateFrame(evidence.audit, target);
    if (mutated === null) {
      checks.push({ id, ok: false, detail: `no captured frame exposes the ${target.label}` });
      continue;
    }
    const result = gradeFrames(mutated, document, caseName);
    const sequence = result.checks.find((check) => check.id === "render_paint_sequence");
    checks.push({
      id,
      ok: sequence?.ok === false && result.firstMismatch !== null,
      detail: sequence?.ok === false ? `semantic mismatch detected for the ${target.label}` : `the ${target.label} mutation was not detected`,
    });
  }
  const paintMutation = removeAllPaintsForPage(evidence.audit);
  if (paintMutation === null) {
    checks.push({ id: "mutation_remove_real_paint", ok: false, detail: "no completed paint for a required page was captured" });
  } else {
    const paintResult = gradeFrames(paintMutation.events, document, caseName);
    const coverage = paintResult.checks.find((check) => check.id === "complete_page_coverage");
    const approval = paintResult.checks.find((check) => check.id === "review_approved");
    checks.push({
      id: "mutation_remove_real_paint",
      ok: coverage?.ok === false && approval?.ok === false,
      detail: `removed ${paintMutation.removed} completed paint(s) for required page ${paintMutation.page + 1}; coverage=${String(coverage?.ok)} approval=${String(approval?.ok)}`,
    });
  }
  return checks;
}
