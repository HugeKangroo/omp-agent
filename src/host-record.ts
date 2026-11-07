import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Small host-controlled records: readiness, task state, acceptance evidence. */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  if (!path.isAbsolute(filePath)) throw new Error("Host record path must be absolute.");
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, filePath);
}
