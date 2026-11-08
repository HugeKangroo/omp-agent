import {
  createHumanReviewComponent,
  type HumanReviewComponent,
  type HumanReviewDecision,
  type HumanReviewRuntime,
} from "./human-review-component.ts";
import type {
  HumanReviewTransportInput,
  HumanReviewTransportResult,
} from "./human-review-types.ts";
import type { OmpCustomPaint, OmpCustomTui, OmpToolContext } from "./task-entry-port.ts";

/**
 * Fixed local main-TUI transport.
 *
 * This is the only production function allowed to turn the component's
 * explicit `approve` callback into the private capability returned to the
 * acceptance service. It receives the live OMP context from the same service
 * call, opens exactly one fullscreen custom component, and never calls
 * confirm/select or installs its own timer. The TUI helpers are loaded lazily
 * through the literal bridge module only after every gate below passes.
 */
export async function presentLocalHumanReview(
  input: HumanReviewTransportInput,
): Promise<HumanReviewTransportResult> {
  if (input.signal.aborted) {
    return { kind: "cancelled", reason: "the human-review call was already aborted" };
  }
  const contextProblem = contextGate(input.context);
  if (contextProblem !== null) {
    return { kind: "unavailable", reason: contextProblem };
  }
  const deadline = Date.parse(input.expiresAt);
  if (!Number.isSafeInteger(deadline)) {
    return { kind: "unavailable", reason: "the host did not provide a canonical review deadline" };
  }
  const runtime = await loadRuntime();
  if (runtime === null) {
    return {
      kind: "unavailable",
      reason: "the public OMP TUI helper exports required by the local review component are unavailable",
    };
  }
  // Lazy loading is an await. Recheck the live context, signal and deadline
  // before opening any surface; the service's own final checks still govern.
  const lateContextProblem = contextGate(input.context);
  if (lateContextProblem !== null) {
    return { kind: "unavailable", reason: lateContextProblem };
  }
  if (input.signal.aborted) {
    return { kind: "cancelled", reason: "the human-review call was aborted before the local surface opened" };
  }
  if (Date.now() >= deadline) {
    return { kind: "cancelled", reason: "the fixed review deadline elapsed before the local surface opened" };
  }
  const stale = displayStillCurrent(input);
  if (stale !== null) {
    return { kind: "unavailable", reason: stale };
  }
  const ui = input.context.ui;
  const custom = ui?.custom;

  let component: HumanReviewComponent | undefined;
  const expected = input.capability;
  type LocalReviewDecision = HumanReviewDecision | "cancelled";
  try {
    if (ui === undefined || typeof custom !== "function") {
      return { kind: "unavailable", reason: "the live OMP context does not expose a callable custom UI" };
    }
    const invokeCustom = custom.bind(ui) as NonNullable<typeof ui.custom>;
    let finishRequested = false;
    let done: ((value: LocalReviewDecision) => void) | undefined;
    const finish = (value: LocalReviewDecision): void => {
      if (finishRequested || done === undefined) return;
      finishRequested = true;
      done(value);
    };
    const decision = await invokeCustom<LocalReviewDecision>(
      (tui, _theme, _keybindings, factoryDone) => {
        done = factoryDone;
        const verifiedTui = validateTui(tui);
        const late = displayStillCurrent(input);
        if (late !== null) throw new Error(late);
        let inner: HumanReviewComponent;
        const cancelStale = (): void => {
          if (finishRequested) return;
          finishRequested = true;
          // Never resolve from inside render/input; the controller owns
          // cleanup and will dispose this mounted component.
          queueMicrotask(() => factoryDone("cancelled"));
        };
        inner = createHumanReviewComponent({
          presentation: input.presentation,
          runtime,
          geometry: () => {
            const terminal = verifiedTui.terminal;
            return {
              columns: typeof terminal.columns === "number" ? terminal.columns : 0,
              rows: typeof terminal.rows === "number" ? terminal.rows : 0,
            };
          },
          paintSource: {
            addPaintListener(listener) {
              return verifiedTui.addPaintListener(listener);
            },
          },
          requestRender: () => verifiedTui.requestRender(),
          signal: input.signal,
          expiresAt: input.expiresAt,
          onDecision: (value) => {
            finish(value);
          },
        });
        component = {
          render(width: number) {
            if (finishRequested) return [];
            if (displayStillCurrent(input) !== null) {
              cancelStale();
              return [];
            }
            return inner.render(width);
          },
          handleInput(data: string) {
            if (finishRequested) return;
            if (displayStillCurrent(input) !== null) {
              cancelStale();
              return;
            }
            inner.handleInput(data);
          },
          capturesInput(data: string) {
            return inner.capturesInput(data);
          },
          dispose() {
            inner.dispose();
          },
        };
        return component;
      },
      {
        signal: input.signal,
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
          fullscreen: true,
          mouseTracking: false,
        },
      },
    );
    if (input.signal.aborted) {
      return { kind: "cancelled", reason: "the local review was aborted before its decision was returned" };
    }
    if (Date.now() >= deadline) {
      return { kind: "cancelled", reason: "the fixed review deadline elapsed before the decision was returned" };
    }
    if (decision === "cancelled") {
      return { kind: "cancelled", reason: "the live task or review reservation changed during local presentation" };
    }
    if (decision === "approve") {
      // The component only calls `done("approve")` after complete painted-page
      // coverage and a distinct explicit confirmation. Return the exact
      // private object; a clone or another review's capability cannot match.
      return { kind: "approve", capability: expected };
    }
    if (decision === "reject") {
      return { kind: "reject", reason: "the reviewer explicitly rejected the frozen evidence" };
    }
    return { kind: "unavailable", reason: "the custom review returned an unexpected decision" };
  } catch (error) {
    if (input.signal.aborted) {
      return { kind: "cancelled", reason: "the local review was aborted" };
    }
    return {
      kind: "unavailable",
      reason: `the local review component could not complete: ${errorMessage(error)}`,
    };
  } finally {
    component?.dispose();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 300);
  try {
    return String(error).slice(0, 300);
  } catch {
    return "unknown error";
  }
}

function contextGate(context: OmpToolContext | undefined): string | null {
  try {
    if (context === undefined || context === null) return "the live OMP context is unavailable";
    if (context.agent?.kind !== "main") return "human review requires the actual main agent";
    if (context.mode !== "tui") return "human review requires the local TUI mode";
    if (context.hasUI !== true) return "human review requires an installed local UI";
    if (typeof context.ui?.custom !== "function") {
      return "the live OMP context does not expose a callable custom UI";
    }
    return null;
  } catch {
    return "the live OMP context could not be read";
  }
}

/**
 * The service's lexical read-only presentation veto. It can only prevent a
 * stale surface from opening; it has no approval capability.
 */
function displayStillCurrent(input: HumanReviewTransportInput): string | null {
  try {
    return input.displayGuard() === true ? null : "the live task or review reservation is no longer current";
  } catch {
    return "the live task or review reservation could not be proven current";
  }
}

interface VerifiedTui {
  terminal: { columns?: unknown; rows?: unknown };
  addPaintListener(listener: (paint: OmpCustomPaint) => void): () => void;
  requestRender(): void;
}

/**
 * The factory receives the host's actual TUI. Validate only the public
 * methods this component uses; reject the mount before any component is
 * returned when they are absent, so no partial surface can accept.
 */
function validateTui(tui: OmpCustomTui): VerifiedTui {
  if (typeof tui !== "object" || tui === null) throw new Error("the host did not pass a TUI object");
  const candidate = tui as OmpCustomTui & {
    terminal?: { columns?: unknown; rows?: unknown };
    addPaintListener?: (listener: (paint: OmpCustomPaint) => void) => () => void;
    requestRender?: () => void;
  };
  const terminal = candidate.terminal;
  if (terminal === undefined
    || typeof terminal.columns !== "number"
    || typeof terminal.rows !== "number"
    || !Number.isSafeInteger(terminal.columns)
    || !Number.isSafeInteger(terminal.rows)
    || terminal.columns <= 0
    || terminal.rows <= 0) {
    throw new Error("the host TUI does not expose actual terminal columns and rows");
  }
  if (typeof candidate.addPaintListener !== "function") {
    throw new Error("the host TUI does not expose addPaintListener");
  }
  if (typeof candidate.requestRender !== "function") {
    throw new Error("the host TUI does not expose requestRender");
  }
  const addPaintListener = candidate.addPaintListener;
  const requestRender = candidate.requestRender;
  return {
    terminal,
    addPaintListener(listener) {
      return addPaintListener.call(candidate, listener);
    },
    requestRender() {
      requestRender.call(candidate);
    },
  };
}

function functionExport(module: Record<string, unknown>, name: string): unknown | null {
  const value = module[name];
  return typeof value === "function" ? value : null;
}

async function loadRuntime(): Promise<HumanReviewRuntime | null> {
  let loaded: unknown;
  try {
    loaded = await import("./human-review-runtime.mjs");
  } catch {
    return null;
  }
  try {
    return humanReviewRuntimeFromModule(loaded);
  } catch {
    return null;
  }
}

/**
 * Validate the real bridge module's named exports. Missing or malformed
 * exports make the local review unavailable; the adapter never substitutes a
 * hand-written width/key implementation.
 */
export function humanReviewRuntimeFromModule(loaded: unknown): HumanReviewRuntime | null {
  if (typeof loaded !== "object" || loaded === null) return null;
  const module = loaded as Record<string, unknown>;
  const visibleWidth = functionExport(module, "visibleWidth");
  const wrapLiteralLine = functionExport(module, "wrapLiteralLine");
  const matchesKey = functionExport(module, "matchesKey");
  const isKeyRelease = functionExport(module, "isKeyRelease");
  const isKeyRepeat = functionExport(module, "isKeyRepeat");
  const stripTerminalSequences = functionExport(module, "stripTerminalSequences");
  const normalizeTerminalOutput = functionExport(module, "normalizeTerminalOutput");
  const pasteStart = module.BRACKETED_PASTE_START;
  const pasteEnd = module.BRACKETED_PASTE_END;
  if (visibleWidth === null
    || wrapLiteralLine === null
    || matchesKey === null
    || isKeyRelease === null
    || isKeyRepeat === null
    || stripTerminalSequences === null
    || normalizeTerminalOutput === null
    || typeof pasteStart !== "string"
    || pasteStart.length === 0
    || typeof pasteEnd !== "string"
    || pasteEnd.length === 0) {
    return null;
  }
  return {
    visibleWidth: visibleWidth as (text: string) => number,
    wrapLiteralLine: wrapLiteralLine as (line: string, width: number) => string[],
    matchesKey: matchesKey as (data: string, keyId: string) => boolean,
    isKeyRelease: isKeyRelease as (data: string) => boolean,
    isKeyRepeat: isKeyRepeat as (data: string) => boolean,
    stripTerminalSequences: stripTerminalSequences as (text: string) => string,
    normalizeTerminalOutput: normalizeTerminalOutput as (text: string) => string,
    bracketedPasteStart: pasteStart,
    bracketedPasteEnd: pasteEnd,
  };
}
