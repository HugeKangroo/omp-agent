/**
 * Host-only entry to the vendored Harness² backend.
 *
 * This is a library wrapper, not an OMP extension or CLI entry. It exposes the
 * controller and the types needed to construct requests and read results.
 */
export { HarnessController } from "./upstream/src/controller.ts";
export type {
  ApplyResult,
  Change,
  RunConfig,
  RunEvent,
  RunRecord,
  Runner,
  WorkerRequest,
  WorkerResult,
} from "./upstream/src/types.ts";
export type { ApprovalHandler, ExecutionProfile } from "./upstream/src/runtime-policy.ts";
export type { AdaptationPolicy } from "./upstream/src/adaptation.ts";
export type { OmpProfileAuth } from "./upstream/src/omp-profile.ts";
