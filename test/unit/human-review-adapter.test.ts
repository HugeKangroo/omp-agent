import { describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import type {
  OmpCustomComponent,
  OmpCustomOptions,
  OmpCustomPaint,
  OmpCustomTui,
  OmpCustomUi,
  OmpToolContext,
} from "../../src/task-entry-port.ts";
import { REVIEW_DEADLINE_MS } from "../../src/human-review-types.ts";
import type {
  HumanReviewTransportInput,
  HumanReviewTransportResult,
} from "../../src/human-review-types.ts";

/**
 * SIMULATED official-shaped UI. The context mirrors the verified v18.18
 * `ctx.ui.custom(factory, options)` shape and mount/abort behavior, but it is a
 * test double. A successful result here is engineering evidence for the fixed
 * adapter, not proof of a native TUI mount or human consent.
 */

mock.module(path.resolve(import.meta.dir, "../../src/human-review-runtime.mjs"), () => ({
  get visibleWidth() {
    return simVisibleWidth;
  },
  get wrapLiteralLine() {
    return simWrapLiteralLine;
  },
  get matchesKey() {
    return simMatchesKey;
  },
  get isKeyRelease() {
    return simIsKeyRelease;
  },
  get isKeyRepeat() {
    return simIsKeyRepeat;
  },
  get stripTerminalSequences() {
    return simStripTerminalSequences;
  },
  get normalizeTerminalOutput() {
    return simNormalizeTerminalOutput;
  },
  get BRACKETED_PASTE_START() {
    return "\x1b[200~";
  },
  get BRACKETED_PASTE_END() {
    return "\x1b[201~";
  },
}));

const {
  simMatchesKey,
  simNormalizeTerminalOutput,
  simStripTerminalSequences,
  simVisibleWidth,
  simWrapLiteralLine,
  fixedPresentation,
  simulatedPaint,
} = await import("../harness/human-review-ui-sim.ts");
const { presentLocalHumanReview, humanReviewRuntimeFromModule } = await import("../../src/human-review-ui.ts");
const { createHumanFixture } = await import("../harness/human-review-fixture.ts");
const { publishTaskOwner, currentTaskOwner, subjectFromContext } = await import("../../src/task-entry-port.ts");
const { TaskOwner } = await import("../../src/task-owner.ts");

function simIsKeyRelease(): boolean {
  return false;
}

function simIsKeyRepeat(): boolean {
  return false;
}

interface FakeOfficialUi {
  context: OmpToolContext;
  customCalls: number;
  lastOptions: OmpCustomOptions | undefined;
  disposed: number;
  ready: Promise<void>;
  render(): readonly string[];
  paint(alt?: boolean): void;
  input(data: string): void;
  resolve(value: unknown): void;
}

function createContext(
  kind: "main" | "sub",
  mode: "tui" | "rpc",
  hasUI: boolean,
  withCustom: boolean,
  ignoreAbort = false,
  geometry: { columns: number; rows: number } = { columns: 80, rows: 140 },
): FakeOfficialUi {
  const listeners = new Set<(paint: OmpCustomPaint) => void>();
  let mounted: OmpCustomComponent | undefined;
  let customCalls = 0;
  let lastOptions: OmpCustomOptions | undefined;
  let disposed = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let settle: ((value: unknown) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;

  const tui: OmpCustomTui = {
    terminal: geometry,
    addPaintListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestRender() {},
  };

  const ui = {
    async custom<T>(
      factory: (
        tuiValue: OmpCustomTui,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => OmpCustomComponent | Promise<OmpCustomComponent>,
      options?: OmpCustomOptions,
    ): Promise<T> {
      // `this` must be the live UI object; the adapter binds ui.custom.
      if (this !== ui) throw new Error("custom called with the wrong receiver");
      customCalls += 1;
      lastOptions = options;
      const promise = new Promise<T>((resolve, rejectPromise) => {
        settle = resolve as (value: unknown) => void;
        reject = rejectPromise;
      });
      const component = await factory(tui, {}, {}, (value) => settle?.(value));
      mounted = component;
      const originalDispose = component.dispose?.bind(component);
      component.dispose = () => {
        disposed += 1;
        originalDispose?.();
      };
      if (options?.signal !== undefined) {
        options.signal.addEventListener("abort", () => {
          if (ignoreAbort) return;
          component.dispose?.();
          reject?.(new Error("Dialog aborted"));
        }, { once: true });
      }
      resolveReady();
      return promise;
    },
  };

  const context: OmpToolContext = {
    cwd: "/tmp/c2-fixture",
    agent: { kind },
    mode,
    hasUI,
    sessionManager: {
      getSessionId: () => "session-c2-fixture",
      getLeafId: () => null,
      getBranch: () => [],
    },
    ...(withCustom ? { ui } : {}),
  };

  return {
    context,
    get customCalls() {
      return customCalls;
    },
    get lastOptions() {
      return lastOptions;
    },
    get disposed() {
      return disposed;
    },
    ready,
    render() {
      if (mounted === undefined) throw new Error("no mounted component");
      return mounted.render(geometry.columns);
    },
    paint(alt = true) {
      if (mounted === undefined) throw new Error("no mounted component");
      const rows = mounted.render(geometry.columns);
      const frame = simulatedPaint(rows, geometry.columns, geometry.rows, alt);
      for (const listener of listeners) listener(frame);
    },
    input(data) {
      if (mounted === undefined) throw new Error("no mounted component");
      mounted.handleInput?.(data);
    },
    resolve(value) {
      settle?.(value);
    },
  } as FakeOfficialUi;
}

function inputFor(
  context: OmpToolContext,
  overrides: Partial<HumanReviewTransportInput> = {},
): { input: HumanReviewTransportInput; controller: AbortController } {
  const controller = new AbortController();
  return {
    controller,
    input: {
      presentation: fixedPresentation(),
      capability: Object.freeze({ private: "exact-capability" }),
      issuedAt: "2026-11-08T00:00:00.000Z",
      expiresAt: "2099-11-08T00:05:00.000Z",
      signal: controller.signal,
      context,
      displayGuard: () => true,
      ...overrides,
    },
  };
}

describe("C2-A fixed local UI adapter (SIMULATED official-shaped UI)", () => {
  test("the bridge validator rejects missing or malformed public exports", () => {
    const complete = {
      visibleWidth: simVisibleWidth,
      wrapLiteralLine: simWrapLiteralLine,
      matchesKey: simMatchesKey,
      isKeyRelease: simIsKeyRelease,
      isKeyRepeat: simIsKeyRepeat,
      stripTerminalSequences: simStripTerminalSequences,
      normalizeTerminalOutput: simNormalizeTerminalOutput,
      BRACKETED_PASTE_START: "\x1b[200~",
      BRACKETED_PASTE_END: "\x1b[201~",
    };
    expect(humanReviewRuntimeFromModule(complete)).not.toBeNull();
    for (const name of [
      "visibleWidth",
      "wrapLiteralLine",
      "matchesKey",
      "isKeyRelease",
      "isKeyRepeat",
      "stripTerminalSequences",
      "normalizeTerminalOutput",
      "BRACKETED_PASTE_START",
      "BRACKETED_PASTE_END",
    ]) {
      expect(humanReviewRuntimeFromModule({ ...complete, [name]: undefined })).toBeNull();
    }
    expect(humanReviewRuntimeFromModule({ ...complete, BRACKETED_PASTE_START: "" })).toBeNull();
  });

  test("completes only after paint, explicit Accept navigation and Enter", async () => {
    const fake = createContext("main", "tui", true, true);
    const { input } = inputFor(fake.context);
    const pending = presentLocalHumanReview(input);
    await fake.ready;
    expect(fake.customCalls).toBe(1);
    expect(fake.lastOptions).toEqual({
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
    });
    const closed = fake.lastOptions?.signal;
    expect(closed).toBe(input.signal);

    fake.render();
    fake.input("\x1b[B");
    fake.render();
    expect(fake.render().join("\n")).toContain("Decision: ● Reject");
    fake.paint();
    fake.input("\x1b[B");
    expect(fake.render().join("\n")).toContain("● Accept reviewed files");
    fake.input("\r");
    const result = await pending;
    expect(result.kind).toBe("approve");
    if (result.kind === "approve") expect(result.capability).toBe(input.capability);
    expect(fake.disposed).toBeGreaterThanOrEqual(1);
  });

  test("initial Enter settles as rejection, not approval", async () => {
    const fake = createContext("main", "tui", true, true);
    const { input } = inputFor(fake.context);
    const pending = presentLocalHumanReview(input);
    await fake.ready;
    fake.render();
    fake.input("\r");
    const result = await pending;
    expect(result).toEqual({ kind: "reject", reason: "the reviewer explicitly rejected the frozen evidence" });
  });

  test("abort settles cancelled and a late approve cannot win", async () => {
    const fake = createContext("main", "tui", true, true, true);
    const { input, controller } = inputFor(fake.context);
    const pending = presentLocalHumanReview(input);
    await fake.ready;
    controller.abort();
    await Bun.sleep(0);
    fake.resolve("approve");
    const result = await pending;
    expect(result).toEqual({
      kind: "cancelled",
      reason: "the local review was aborted before its decision was returned",
    });
  });

  test("a context change during lazy loading prevents opening the custom UI", async () => {
    const fake = createContext("main", "tui", true, true);
    const { input } = inputFor(fake.context);
    const pending = presentLocalHumanReview(input);
    // The lazy import is an await; this change lands before the continuation.
    input.context.mode = "rpc";
    const result = await pending;
    expect(result.kind).toBe("unavailable");
    expect(fake.customCalls).toBe(0);
  });

  test("non-local or missing-custom contexts return unavailable without opening", async () => {
    for (const [kind, mode, hasUI, custom] of [
      ["sub", "tui", true, true],
      ["main", "rpc", true, true],
      ["main", "tui", false, true],
      ["main", "tui", true, false],
    ] as const) {
      const fake = createContext(kind, mode, hasUI, custom);
      const { input } = inputFor(fake.context);
      const result = await presentLocalHumanReview(input);
      expect(result.kind).toBe("unavailable");
      expect(fake.customCalls).toBe(0);
    }
  });

  test("an already-expired deadline never opens the surface", async () => {
    const fake = createContext("main", "tui", true, true);
    const { input } = inputFor(fake.context, { expiresAt: "2000-01-01T00:00:00.000Z" });
    const result = await presentLocalHumanReview(input);
    expect(result.kind).toBe("cancelled");
    expect(fake.customCalls).toBe(0);
  });

  test("guard invalidation suppresses immediate renders and input before close", async () => {
    let valid = true;
    const fake = createContext("main", "tui", true, true);
    const { input } = inputFor(fake.context, { displayGuard: () => valid });
    const pending = presentLocalHumanReview(input);
    await fake.ready;
    const live = fake.render();
    expect(live.length).toBeGreaterThan(0);
    fake.paint();
    valid = false;
    expect(fake.render()).toEqual([]);
    expect(fake.render()).toEqual([]);
    fake.input("\r");
    fake.input("\x1b[B");
    const result = await pending;
    expect(result).toEqual({
      kind: "cancelled",
      reason: "the live task or review reservation changed during local presentation",
    });
  });

  test("an owner replacement during lazy loading prevents the old presentation from mounting", async () => {
    const f = await createHumanFixture({ humanReview: { kind: "local-main-tui", policyVersion: 1 } });
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      let customCalls = 0;
      const ui = {
        async custom<T>(
          _factory: (
            tui: OmpCustomTui,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => never,
        ): Promise<T> {
          customCalls += 1;
          return new Promise<T>(() => {});
        },
      };
      let uiReads = 0;
      let replacement: InstanceType<typeof TaskOwner> | undefined;
      Object.defineProperty(f.ctx, "ui", {
        configurable: true,
        get() {
          uiReads += 1;
          if (uiReads === 2 && replacement === undefined) {
            replacement = new TaskOwner({
              workspaceRoot: f.workspace,
              ownerId: "owner-replacement-c2",
              authorizedCapabilities: ["local-script"],
              now: () => "2026-11-08T00:00:00.000Z",
              id: () => "replacement-id-1",
            });
            publishTaskOwner(replacement);
          }
          return ui;
        },
      });

      const result = await f.request(preview.deliveryId);
      expect(uiReads).toBeGreaterThanOrEqual(2);
      expect(replacement).toBeDefined();
      expect(customCalls).toBe(0);
      expect(result.review.state).toBe("unavailable");
      expect(result.operation.outcome).toBe("not_committed");
      expect(result.operation.operationCommitted).toBe(false);
      expect(readdirSync(f.acceptanceRoot).filter((name) => name.startsWith("record-"))).toHaveLength(0);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");
    } finally {
      await f.cleanup();
    }
  });

  test("a real owner replacement on the final hasUI read vetoes the old rendered body", async () => {
    const REQUIREMENT_MARKER = "C2-REPAIR1-PRIVATE-REQUIREMENT-5e2f";
    const FILE_MARKER = "C2-REPAIR1-PRIVATE-FILE-5e2f";
    const f = await createHumanFixture({
      humanReview: { kind: "local-main-tui", policyVersion: 1 },
      requirementText: `${REQUIREMENT_MARKER}: produce a local text file for this owner only.`,
      source: `from pathlib import Path\nPath("answer.txt").write_text("${FILE_MARKER} 42\\n", encoding="utf-8")\nprint("artifact written")\n`,
    });
    const hasUIDescriptor = Object.getOwnPropertyDescriptor(f.ctx, "hasUI")!;
    const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
    const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")!;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
    const scheduledTimers: Array<{ delay: number; cleared: boolean }> = [];
    const timerHandles = new Map<unknown, { delay: number; cleared: boolean }>();
    const paintListeners = new Set<unknown>();
    const doneValues: unknown[] = [];
    const requestAbort = new AbortController();
    let customCalls = 0;
    let factoryCalls = 0;
    let renderCalls = 0;
    let listenerAdds = 0;
    let listenerRemoves = 0;
    let totalHasUiReads = 0;
    let armedHasUiReads = 0;
    let armed = false;
    let replacement: InstanceType<typeof TaskOwner> | undefined;
    let renderedRows: readonly string[] = [];
    try {
      const run = await f.run();
      const preview = await f.preview(run.runId, run.artifactIds);
      const read = await f.readReview(preview.deliveryId);
      Object.defineProperty(f.ctx, "hasUI", {
        configurable: true,
        get() {
          totalHasUiReads += 1;
          if (armed) {
            armedHasUiReads += 1;
            // The guard's second/final context read during this one render.
            if (armedHasUiReads === 2) {
              replacement = new TaskOwner({
                workspaceRoot: f.workspace,
                ownerId: "owner-c2-repair1-final-read",
                authorizedCapabilities: ["local-script"],
                now: () => "2026-11-08T00:00:00.000Z",
                id: () => "replacement-c2-repair1-id",
              });
              publishTaskOwner(replacement);
            }
          }
          return true;
        },
      });
      const ui: OmpCustomUi = {
        custom<T>(
          factory: (
            tui: OmpCustomTui,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void,
          ) => OmpCustomComponent | Promise<OmpCustomComponent>,
          options?: OmpCustomOptions,
        ): Promise<T> {
          customCalls += 1;
          return new Promise<T>((resolve, reject) => {
            let closed = false;
            const settle = (value: T): void => {
              if (closed) return;
              closed = true;
              options?.signal?.removeEventListener("abort", onAbort);
              doneValues.push(value);
              resolve(value);
            };
            const fail = (error: unknown): void => {
              if (closed) return;
              closed = true;
              options?.signal?.removeEventListener("abort", onAbort);
              reject(error);
            };
            const onAbort = (): void => fail(new Error("C2 repair regression request aborted"));
            if (options?.signal?.aborted) {
              onAbort();
              return;
            }
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            const tui: OmpCustomTui = {
              terminal: { columns: 120, rows: 140 },
              addPaintListener(listener) {
                listenerAdds += 1;
                paintListeners.add(listener);
                return () => {
                  listenerRemoves += 1;
                  paintListeners.delete(listener);
                };
              },
              requestRender() {},
            };
            Promise.resolve()
              .then(() => {
                factoryCalls += 1;
                return factory(tui, {}, {}, settle);
              })
              .then((component) => {
                if (closed) {
                  component.dispose?.();
                  return;
                }
                armed = true;
                try {
                  renderCalls += 1;
                  renderedRows = [...component.render(120)];
                } finally {
                  armed = false;
                  // No key, paint or approval is supplied; end the isolated probe.
                  requestAbort.abort();
                }
              })
              .catch(fail);
          });
        },
      };
      f.ctx.ui = ui;
      Object.defineProperty(globalThis, "setTimeout", {
        ...setTimeoutDescriptor,
        configurable: true,
        value: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          const observation = { delay: Number(delay ?? 0), cleared: false };
          scheduledTimers.push(observation);
          const handle = realSetTimeout(callback, delay, ...args);
          timerHandles.set(handle, observation);
          return handle;
        },
      });
      Object.defineProperty(globalThis, "clearTimeout", {
        ...clearTimeoutDescriptor,
        configurable: true,
        value: (handle: unknown) => {
          const observation = timerHandles.get(handle);
          if (observation !== undefined) observation.cleared = true;
          return realClearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      });
      const result = await f.request(preview.deliveryId, requestAbort.signal);
      await Bun.sleep(0);

      expect(customCalls).toBe(1);
      expect(factoryCalls).toBe(1);
      expect(renderCalls).toBe(1);
      expect(totalHasUiReads).toBeGreaterThanOrEqual(2);
      expect(armedHasUiReads).toBe(2);
      expect(replacement).toBeDefined();
      expect(currentTaskOwner()).toBe(replacement);
      expect(replacement!.snapshot().currentTask).toBeNull();
      expect(renderedRows.join("\n")).not.toContain(REQUIREMENT_MARKER);
      expect(renderedRows.join("\n")).not.toContain(FILE_MARKER);
      expect(doneValues).not.toContain("approve");
      expect(result.review.state).toBe("cancelled");
      expect(result.operation.operationCommitted).toBe(false);
      expect(readdirSync(f.acceptanceRoot)).toEqual([]);
      expect(f.owner.snapshot().currentTask!.status).toBe("active");

      const token = f.owner.reserveAcceptance(subjectFromContext(f.ctx, f.workspace), read.evidence.task);
      f.owner.releaseAcceptance(token);
      expect(listenerAdds).toBe(1);
      expect(listenerRemoves).toBe(1);
      expect(paintListeners.size).toBe(0);
      const deadlineTimers = scheduledTimers.filter(
        (row) => row.delay > REVIEW_DEADLINE_MS - 10_000 && row.delay <= REVIEW_DEADLINE_MS,
      );
      expect(deadlineTimers).toHaveLength(1);
      expect(deadlineTimers[0]!.cleared).toBe(true);

      // The closed review no longer blocks a new request on the same service.
      Object.defineProperty(f.ctx, "hasUI", hasUIDescriptor);
      f.ctx.hasUI = false;
      const closed = await f.request(preview.deliveryId);
      expect(closed.review.reason).toContain("requires the actual main agent");
      f.ctx.hasUI = true;
    } finally {
      requestAbort.abort();
      for (const handle of timerHandles.keys()) realClearTimeout(handle as ReturnType<typeof setTimeout>);
      Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
      Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
      Object.defineProperty(f.ctx, "hasUI", hasUIDescriptor);
      await f.cleanup();
    }
  });
});
