/**
 * Host-only entry to the vendored Harness² backend.
 *
 * This is a library wrapper, not an OMP extension or CLI entry. It exposes the
 * controller, the actual API-key RPC runner, the capability probe, the pure
 * bounded run/events history decoders, the pure bounded creation-origin text
 * decoder and the types needed to construct requests and read results.
 * Importing this module starts no process and reads no credential. No writable
 * RunStore is exported.
 */
export { HarnessController } from "./upstream/src/controller.ts";
export type {
  HarnessRecoveryInspectionView,
  HarnessRecoveryInspector,
} from "./upstream/src/controller.ts";
export { decodeRunEventsText, decodeRunHistoryText, decodeRunRecoveryOriginText } from "./upstream/src/store.ts";
export { OmpRpcRunner, probeRpcCapabilities } from "./upstream/src/runner.ts";
export type { OmpRpcRunnerOptions } from "./upstream/src/runner.ts";
export type {
  ApplyResult,
  Change,
  RunConfig,
  RunEvent,
  RunRecord,
  RunRecoveryOrigin,
  RunRecoverySeed,
  Runner,
  WorkerRequest,
  WorkerResult,
} from "./upstream/src/types.ts";
export type { ApprovalHandler, ExecutionProfile } from "./upstream/src/runtime-policy.ts";
export type { AdaptationPolicy } from "./upstream/src/adaptation.ts";
export type { OmpProfileAuth } from "./upstream/src/omp-profile.ts";
