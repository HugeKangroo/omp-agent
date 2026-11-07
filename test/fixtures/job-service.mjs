import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Independent G1-B3a mock job service. Test-only control is available only on
 * loopback and is never exposed as a model tool. It deliberately has no
 * relationship to OMP's process group; the harness owns startup/shutdown.
 */

const jobs = new Map();
const config = {
  dropSubmitAck: false,
  holdCancel: false,
  holdCancelResponse: false,
  holdSubmitAccept: false,
  holdSubmitAck: false,
  delayedQueryMs: 0,
  delayedCancelMs: 0,
  corruptResponse: null,
  submitHttpError: null,
};
const CORRUPTIONS = new Set(["operationId", "digest", "jobId", "missingDigest", "overlongJobId"]);
/** operationId -> { operationId, digest, payload, requests: [{req,res}] } */
const pendingSubmits = new Map();
/** Held cancellation HTTP responses; the service state mutation already happened. */
const pendingCancelResponses = [];
/** Held submit acknowledgements created only after the actual job exists. */
const pendingSubmitAcks = [];
const counters = {
  submitRequests: 0,
  queryRequests: 0,
  cancelRequests: 0,
  actualCreates: 0,
  actualCompletes: 0,
  actualFailures: 0,
  actualCancels: 0,
  transportDrops: 0,
};
let nextJobId = 0;

const send = (res, status, value) => {
  if (res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

/** Adversarial only: corrupt echoed identity without changing actual state. */
const withCorruptedIdentity = (value) => {
  if (!config.corruptResponse) return value;
  const copy = { ...value };
  if (config.corruptResponse === "operationId") copy.operationId = "job-op-corrupt";
  else if (config.corruptResponse === "digest") copy.digest = "sha256:corrupt";
  else if (config.corruptResponse === "jobId") copy.jobId = "job-corrupt";
  else if (config.corruptResponse === "overlongJobId") copy.jobId = "j".repeat(201);
  else if (config.corruptResponse === "missingDigest") delete copy.digest;
  return copy;
};

const readJson = async (req) => {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32 * 1024) throw new Error("request too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const stats = () => ({
  counters: { ...counters },
  jobs: [...jobs.values()].map((job) => ({ ...job })),
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "POST" && url.pathname === "/_control/config") {
      const body = await readJson(req);
      for (const key of ["dropSubmitAck", "holdCancel", "holdCancelResponse", "holdSubmitAccept", "holdSubmitAck"]) {
        if (typeof body[key] === "boolean") config[key] = body[key];
      }
      for (const key of ["delayedQueryMs", "delayedCancelMs"]) {
        if (typeof body[key] === "number" && Number.isSafeInteger(body[key])
          && body[key] >= 0 && body[key] <= 10_000) {
          config[key] = body[key];
        }
      }
      if (body.corruptResponse === null || (typeof body.corruptResponse === "string" && CORRUPTIONS.has(body.corruptResponse))) {
        config.corruptResponse = body.corruptResponse;
      }
      if (body.submitHttpError === null
        || (typeof body.submitHttpError === "number" && Number.isSafeInteger(body.submitHttpError)
          && body.submitHttpError >= 400 && body.submitHttpError <= 599)) {
        config.submitHttpError = body.submitHttpError;
      }
      send(res, 200, { ok: true, config: { ...config } });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_control/stats") {
      send(res, 200, stats());
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/complete") {
      const body = await readJson(req);
      const found = body.jobId ? [...jobs.values()].find((job) => job.jobId === body.jobId) : [...jobs.values()][0];
      if (!found) return send(res, 404, { error: "no_job" });
      if (found.state === "running") {
        found.state = "succeeded";
        counters.actualCompletes += 1;
      }
      send(res, 200, { ok: true, job: { ...found } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/fail") {
      const body = await readJson(req);
      const found = body.jobId ? [...jobs.values()].find((job) => job.jobId === body.jobId) : [...jobs.values()][0];
      if (!found) return send(res, 404, { error: "no_job" });
      if (found.state === "running") {
        found.state = "failed";
        counters.actualFailures += 1;
      }
      send(res, 200, { ok: true, job: { ...found } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/confirm-cancel") {
      const body = await readJson(req);
      const found = body.jobId ? [...jobs.values()].find((job) => job.jobId === body.jobId) : [...jobs.values()][0];
      if (!found) return send(res, 404, { error: "no_job" });
      if (found.cancelRequested && found.state === "running") {
        found.state = "cancelled";
        counters.actualCancels += 1;
      }
      send(res, 200, { ok: true, job: { ...found } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/release-submit") {
      const entry = pendingSubmits.values().next().value;
      if (entry) pendingSubmits.delete(entry.operationId);
      if (entry) {
        const job = {
          operationId: entry.operationId,
          digest: entry.digest,
          payload: entry.payload,
          jobId: `job-${++nextJobId}`,
          state: "running",
          cancelRequested: false,
          cancelIntentId: null,
          createdAt: new Date().toISOString(),
        };
        jobs.set(job.operationId, job);
        counters.actualCreates += 1;
        entry.requests.forEach((pending, index) => {
          if (config.submitHttpError) {
            send(pending.res, config.submitHttpError, { error: "synthetic_http_error_after_create" });
          } else if (config.dropSubmitAck) {
            counters.transportDrops += 1;
            pending.req.socket.destroy();
          } else {
            send(pending.res, index === 0 ? 201 : 200, withCorruptedIdentity({
              accepted: true,
              jobId: job.jobId,
              operationId: job.operationId,
              state: job.state,
              digest: job.digest,
              replayed: index !== 0,
            }));
          }
        });
      }
      send(res, 200, { ok: true, released: Boolean(entry) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/release-submit-ack") {
      const pending = pendingSubmitAcks.shift();
      if (pending) {
        send(pending.res, 201, withCorruptedIdentity({
          accepted: true,
          jobId: pending.job.jobId,
          operationId: pending.job.operationId,
          state: pending.job.state,
          digest: pending.job.digest,
          replayed: false,
        }));
      }
      send(res, 200, { ok: true, released: Boolean(pending) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/release-cancel-response") {
      const pending = pendingCancelResponses.shift();
      if (pending) {
        send(pending.res, 200, withCorruptedIdentity({
          jobId: pending.job.jobId,
          operationId: pending.job.operationId,
          state: pending.job.state,
          digest: pending.job.digest,
          cancelRequested: true,
          cancelConfirmed: pending.job.state === "cancelled",
          cancelIntentId: pending.job.cancelIntentId,
        }));
      }
      send(res, 200, { ok: true, released: Boolean(pending) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/_control/shutdown") {
      send(res, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 10).unref();
      return;
    }

    if (parts[0] !== "jobs") return send(res, 404, { error: "not_found" });

    if (req.method === "POST" && parts.length === 1) {
      counters.submitRequests += 1;
      const body = await readJson(req);
      if (typeof body.operationId !== "string" || typeof body.digest !== "string" || typeof body.payload !== "string") {
        return send(res, 400, { error: "invalid_submit" });
      }
      const existing = jobs.get(body.operationId);
      if (existing) {
        if (existing.digest !== body.digest) return send(res, 409, { error: "operation_conflict" });
        return send(res, 200, withCorruptedIdentity({
          accepted: true,
          jobId: existing.jobId,
          operationId: existing.operationId,
          state: existing.state,
          digest: existing.digest,
          replayed: true,
        }));
      }
      const pending = pendingSubmits.get(body.operationId);
      if (pending) {
        // Reserve identity at receipt: equal content coalesces to one effect,
        // changed content conflicts even while creation is held.
        if (pending.digest !== body.digest) return send(res, 409, { error: "operation_conflict" });
        pending.requests.push({ req, res });
        return;
      }
      if (config.holdSubmitAccept) {
        // Deliberately before creation/visibility: a concurrent cancel/query
        // must observe not_found.
        pendingSubmits.set(body.operationId, {
          operationId: body.operationId,
          digest: body.digest,
          payload: body.payload,
          requests: [{ req, res }],
        });
        return;
      }
      const job = {
        operationId: body.operationId,
        digest: body.digest,
        payload: body.payload,
        jobId: `job-${++nextJobId}`,
        state: "running",
        cancelRequested: false,
        cancelIntentId: null,
        createdAt: new Date().toISOString(),
      };
      jobs.set(job.operationId, job);
      counters.actualCreates += 1;
      if (config.submitHttpError) {
        // The job exists, but the transport sees only an error status.
        return send(res, config.submitHttpError, { error: "synthetic_http_error_after_create" });
      }
      if (config.dropSubmitAck) {
        counters.transportDrops += 1;
        req.socket.destroy();
        return;
      }
      if (config.holdSubmitAck) {
        // The actual job exists; only the acknowledgement is withheld.
        pendingSubmitAcks.push({ req, res, job });
        return;
      }
      return send(res, 201, withCorruptedIdentity({
        accepted: true,
        jobId: job.jobId,
        operationId: job.operationId,
        state: job.state,
        digest: job.digest,
        replayed: false,
      }));
    }

    if (req.method === "GET" && parts.length === 2) {
      counters.queryRequests += 1;
      const job = jobs.get(parts[1]);
      const respond = () => {
        if (!job) return send(res, 404, { error: "not_found" });
        send(res, 200, withCorruptedIdentity({
          jobId: job.jobId,
          operationId: job.operationId,
          state: job.state,
          digest: job.digest,
          cancelRequested: job.cancelRequested,
        }));
      };
      if (config.delayedQueryMs > 0) setTimeout(respond, config.delayedQueryMs);
      else respond();
      return;
    }

    if (req.method === "POST" && parts.length === 3 && parts[2] === "cancel") {
      counters.cancelRequests += 1;
      const body = await readJson(req);
      if (typeof body.cancelIntentId !== "string") return send(res, 400, { error: "invalid_cancel" });
      const job = jobs.get(parts[1]);
      if (!job) return send(res, 404, { error: "not_found" });
      job.cancelRequested = true;
      job.cancelIntentId = body.cancelIntentId;
      // Completion wins: succeeded/failed are never converted to cancelled.
      if (job.state === "running" && !config.holdCancel) {
        job.state = "cancelled";
        counters.actualCancels += 1;
      }
      // Cancellation intent mutation is real; only the echoed identity can be
      // corrupted by the adversarial test control. A held/delayed response
      // never changes whether the service committed the intent.
      const reply = () => send(res, 200, withCorruptedIdentity({
        jobId: job.jobId,
        operationId: job.operationId,
        state: job.state,
        digest: job.digest,
        cancelRequested: true,
        cancelConfirmed: job.state === "cancelled",
        cancelIntentId: job.cancelIntentId,
      }));
      if (config.holdCancelResponse) {
        pendingCancelResponses.push({ req, res, job });
        return;
      }
      if (config.delayedCancelMs > 0) setTimeout(reply, config.delayedCancelMs);
      else reply();
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ type: "ready", host: "127.0.0.1", port, pid: process.pid, nonce: randomUUID() })}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
