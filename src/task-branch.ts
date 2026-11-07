/**
 * Pure conversation-branch parsing shared by the task owner and tests.
 * Nothing here decides authority; it only reads host-supplied entries.
 */

export interface BranchEntry {
  id: string;
  parentId: string | null;
  type: string;
  value: Record<string, unknown>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function parseBranch(branch: readonly unknown[]): BranchEntry[] {
  if (!Array.isArray(branch)) throw new Error("Task conversation branch must be an array.");
  const entries: BranchEntry[] = [];
  const seen = new Set<string>();
  for (const value of branch) {
    const entry = object(value, "Conversation branch entry");
    const rawId = entry.id;
    if (typeof rawId !== "string" || !IDENTIFIER.test(rawId)) {
      throw new Error("Conversation branch entry id is not a valid identifier.");
    }
    const id = rawId;
    if (seen.has(id)) throw new Error("Conversation branch contains duplicate entry ids.");
    seen.add(id);
    const parentId = entry.parentId;
    if (parentId !== null && typeof parentId !== "string") {
      throw new Error("Conversation branch entry parentId must be a string or null.");
    }
    entries.push({ id, parentId, type: typeof entry.type === "string" ? entry.type : "", value: entry });
  }
  return entries;
}

export function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function genuineUserText(entry: BranchEntry): string | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.value.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || record.synthetic === true || record.attribution !== "user") return undefined;
  const content = messageText(record);
  return content.trim() ? content : undefined;
}

/** Host message identity for agent_end correlation, when OMP supplies it. */
export function lastGenuineUserMessageIdentity(
  messages: unknown,
): { id: string | null; timestamp: number | null; text: string } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "user" || record.synthetic === true || record.attribution !== "user") continue;
    const content = messageText(record);
    if (!content.trim()) continue;
    const candidate = record.id ?? record.messageId ?? record.messageID;
    return {
      id: typeof candidate === "string" && IDENTIFIER.test(candidate) ? candidate : null,
      timestamp: typeof record.timestamp === "number" && Number.isFinite(record.timestamp) ? record.timestamp : null,
      text: content,
    };
  }
  return undefined;
}

export function branchUserTimestamp(entry: BranchEntry): number | null {
  const message = entry.value.message;
  if (typeof message === "object" && message !== null && !Array.isArray(message)) {
    const value = (message as Record<string, unknown>).timestamp;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const value = entry.value.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
