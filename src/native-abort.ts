/**
 * One captured native `aborted` getter and brand-check reader for the actual
 * host AbortSignal. Capture is a trusted-runtime initialization contract: a
 * caller-supplied own getter, duck type, proxy or `instanceof` check is never
 * consulted.
 */
const ACTUAL_ABORTED_GETTER = (() => {
  try {
    return Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get ?? null;
  } catch {
    return null;
  }
})();

export type ActualAbortRead =
  | { readonly ok: true; readonly aborted: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Brand-check and read one actual host AbortSignal through the captured native
 * prototype getter. This never invokes an own `aborted` getter, so a duck or
 * proxy cannot masquerade as the host's abort state.
 */
export function readActualAbortSignal(signal: unknown): ActualAbortRead {
  if (signal === undefined || signal === null) {
    return { ok: false, reason: "the actual host AbortSignal is missing" };
  }
  if (ACTUAL_ABORTED_GETTER === null) {
    return { ok: false, reason: "the host AbortSignal aborted getter is unavailable" };
  }
  try {
    const aborted: unknown = Reflect.apply(ACTUAL_ABORTED_GETTER, signal, []);
    if (typeof aborted !== "boolean") {
      return { ok: false, reason: "the host AbortSignal aborted state is unreadable" };
    }
    return { ok: true, aborted };
  } catch {
    return { ok: false, reason: "the supplied signal is not a readable actual host AbortSignal" };
  }
}
