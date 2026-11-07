import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SERVICE_PATH = path.join(REPO_ROOT, "test/fixtures/job-service.mjs");

export interface ServiceStats {
  counters: {
    submitRequests: number;
    queryRequests: number;
    cancelRequests: number;
    actualCreates: number;
    actualCompletes: number;
    actualFailures: number;
    actualCancels: number;
    transportDrops: number;
  };
  jobs: Array<Record<string, unknown>>;
}

/**
 * Test-host control for the independent mock service. The service is spawned
 * detached, so it is outside the OMP process group and survives OMP exit; this
 * harness owns its cleanup.
 */
export class MockJobService {
  readonly endpoint: string;
  readonly pid: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private stopped = false;

  private constructor(child: ChildProcessWithoutNullStreams, endpoint: string, pid: number) {
    this.child = child;
    this.endpoint = endpoint;
    this.pid = pid;
  }

  static async start(): Promise<MockJobService> {
    const child = spawn("bun", [SERVICE_PATH], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      stdio: "pipe",
      detached: true,
      windowsHide: true,
    });
    let buffer = "";
    const ready = new Promise<{ endpoint: string; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock job service did not become ready")), 10_000);
      const onData = (bytes: Buffer) => {
        buffer += bytes.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (value.type === "ready" && typeof value.port === "number" && typeof value.pid === "number") {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              child.stderr.resume();
              resolve({ endpoint: `http://127.0.0.1:${value.port}`, pid: value.pid });
              return;
            }
          } catch {
            // Ignore non-JSON service diagnostics.
          }
        }
      };
      child.stdout.on("data", onData);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`mock job service exited during startup: ${code}`));
      });
    });
    const info = await ready;
    return new MockJobService(child, info.endpoint, info.pid);
  }

  private async control<T>(pathname: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.endpoint}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`mock job control ${pathname} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }

  configure(config: {
    dropSubmitAck?: boolean;
    holdCancel?: boolean;
    holdCancelResponse?: boolean;
    holdSubmitAccept?: boolean;
    holdSubmitAck?: boolean;
    delayedQueryMs?: number;
    delayedCancelMs?: number;
    corruptResponse?: "operationId" | "digest" | "jobId" | "missingDigest" | "overlongJobId" | null;
    submitHttpError?: number | null;
  }): Promise<{ ok: boolean; config: Record<string, unknown> }> {
    return this.control("/_control/config", config);
  }

  stats(): Promise<ServiceStats> {
    return this.control("/_control/stats");
  }

  complete(jobId?: string): Promise<{ ok: boolean; job: Record<string, unknown> }> {
    return this.control("/_control/complete", jobId === undefined ? {} : { jobId });
  }

  fail(jobId?: string): Promise<{ ok: boolean; job: Record<string, unknown> }> {
    return this.control("/_control/fail", jobId === undefined ? {} : { jobId });
  }

  confirmCancel(jobId?: string): Promise<{ ok: boolean; job: Record<string, unknown> }> {
    return this.control("/_control/confirm-cancel", jobId === undefined ? {} : { jobId });
  }

  releaseSubmit(): Promise<{ ok: boolean; released: boolean }> {
    return this.control("/_control/release-submit", {});
  }

  releaseSubmitAck(): Promise<{ ok: boolean; released: boolean }> {
    return this.control("/_control/release-submit-ack", {});
  }

  releaseCancelResponse(): Promise<{ ok: boolean; released: boolean }> {
    return this.control("/_control/release-cancel-response", {});
  }

  async cleanup(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.control("/_control/shutdown", {});
    } catch {
      // The service may already be gone.
    }
    const deadline = Date.now() + 2_000;
    while (!this.exited() && Date.now() < deadline) await Bun.sleep(20);
    if (!this.exited()) {
      try { process.kill(this.pid, "SIGTERM"); } catch { /* gone */ }
      const termDeadline = Date.now() + 500;
      while (!this.exited() && Date.now() < termDeadline) await Bun.sleep(20);
    }
    if (!this.exited()) {
      try { process.kill(this.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }

  private exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }
}
