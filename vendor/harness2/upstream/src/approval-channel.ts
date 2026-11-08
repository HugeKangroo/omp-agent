import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { atomicWrite, readRegular, withWriteLock } from "./store";
import type { ApprovalHandler, ApprovalRequest } from "./runtime-policy";
export interface PendingApproval { token: string; request: ApprovalRequest; expiresAt: number; status: "pending" | "closed"; answer?: string | boolean }
const TOKEN = /^[a-f0-9-]{36}$/;
/** Transport of OMP decisions, not an independent policy engine. No remembered grants are minted here. */
export class ApprovalChannel {
  constructor(readonly root: string) {}
  handler(deadline: number): ApprovalHandler {
    return async (request, signal) => {
      const token = randomUUID(); const file = join(this.root, `${token}.json`);
      await withWriteLock(this.root, () => atomicWrite(file, JSON.stringify({ token, request, expiresAt: deadline, status: "pending" } satisfies PendingApproval)));
      try {
        while (!signal?.aborted && Date.now() < deadline) {
          const raw = await readRegular(file); if (!raw) throw new Error("Approval transport record disappeared");
          const record = JSON.parse(raw) as PendingApproval;
          if (record.request.digest !== request.digest || record.token !== token) throw new Error("Approval identity changed");
          if (record.status === "closed") return record.answer;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return undefined;
      } finally {
        await withWriteLock(this.root, async () => {
          const raw = await readRegular(file); if (raw) await atomicWrite(file, JSON.stringify({ ...JSON.parse(raw), status: "closed" }));
        });
      }
    };
  }
  async pending(runId: string): Promise<PendingApproval[]> {
    const names = await readdir(this.root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result: PendingApproval[] = [];
    for (const name of names.filter(n => TOKEN.test(n.slice(0, -5)) && n.endsWith(".json"))) {
      const raw = await readRegular(join(this.root, name)); if (!raw) continue;
      const entry = JSON.parse(raw) as PendingApproval;
      if (entry.request?.runId === runId && entry.status === "pending" && entry.expiresAt > Date.now()) result.push(entry);
    }
    return result;
  }
  async answer(token: string, digest: string, value: string | boolean | undefined): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("Invalid approval token");
    await withWriteLock(this.root, async () => {
      const file = join(this.root, `${token}.json`); const raw = await readRegular(file);
      if (!raw) throw new Error("Approval request no longer exists");
      const entry = JSON.parse(raw) as PendingApproval;
      if (entry.status !== "pending" || entry.expiresAt <= Date.now() || entry.request.digest !== digest) throw new Error("Stale approval decision");
      if (value !== undefined && !(entry.request.method === "confirm" && typeof value === "boolean") && !(entry.request.method === "select" && typeof value === "string" && entry.request.options.includes(value))) throw new Error("Unrecognized OMP approval answer");
      await atomicWrite(file, JSON.stringify({ ...entry, status: "closed", ...(value === undefined ? {} : { answer: value }) }));
    });
  }
}
