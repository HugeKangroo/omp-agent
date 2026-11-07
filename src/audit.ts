import { appendFileSync } from "node:fs";

export type AuditEvent = Record<string, unknown> & { type: string };

export interface AuditSink {
  (event: AuditEvent): void;
}

/**
 * Host-selected JSONL evidence. The audit is outside the workspace and never
 * contains deliverable content or credentials; it records decisions and digests.
 */
export function createFileAudit(filePath: string | undefined): AuditSink {
  if (!filePath) return () => undefined;
  return (event: AuditEvent) => {
    appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
