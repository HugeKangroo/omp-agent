import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  normalizeTerminalOutput,
  stripTerminalSequences,
  visibleWidth,
  wrapLiteralLine,
} from "@oh-my-pi/pi-tui";

/**
 * Narrow transparent observation for the native human-review harness.
 *
 * It intercepts only `registerTool` on the supplied extension API and only the
 * `execute` method of the `agent_deliver` definition. Every other property,
 * descriptor and receiver is preserved. At the real custom factory boundary it
 * attaches public paint/frame listeners and wraps the returned component's
 * public methods in place. It never calls `done`, changes options, injects a
 * decision, opens another custom surface, or reads private service state.
 */

const MAX_EVENTS = 8000;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_CHARS = 64_000;
const MAX_ROWS = 100;
const MAX_ROW_CHARS = 2000;
const MAX_ARG_CHARS = 16_000;
const uiFacades = new WeakMap();

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const layoutFixturePath = fileURLToPath(new URL("./human-review-native-expected.json", import.meta.url));
let layoutFixture = null;
try {
  const raw = readFileSync(layoutFixturePath);
  layoutFixture = { sha256: sha256(raw), data: JSON.parse(raw.toString("utf8")) };
} catch {
  layoutFixture = null;
}

function splitStatic(id, text) {
  return String(text).split("\n").map((line, index) => ({ logicalLineId: `${id}:${index}`, text: line }));
}

function staticLayoutLines() {
  if (layoutFixture === null) return [];
  const data = layoutFixture.data;
  const grammar = data.grammar ?? {};
  const lines = [{ logicalLineId: "grammar:preamble:0", text: String(grammar.preamble) }];
  for (const file of data.files ?? []) lines.push(...splitStatic(`file:${file.name}`, file.expectedSafeText));
  for (const requirement of data.requirements ?? []) {
    lines.push(...splitStatic(`requirement:${requirement.revision}`, requirement.expectedSafeText));
  }
  for (const [index, note] of (data.notes ?? []).entries()) {
    lines.push({ logicalLineId: `note:${index}:0`, text: `${grammar.noteLinePrefix ?? "note: "}${note}` });
  }
  for (const [kind, values] of Object.entries(data.limitations ?? {})) {
    for (const [index, limitation] of values.entries()) {
      lines.push({
        logicalLineId: `limitation:${kind}:${index}:0`,
        text: `${grammar.limitationLinePrefix ?? "automatic limitation: "}${limitation}`,
      });
    }
  }
  return lines;
}

function clipText(value, max) {
  if (typeof value !== "string") return { value, truncated: false };
  if (value.length <= max) return { value, truncated: false };
  return { value: `${value.slice(0, max)}…[truncated]`, truncated: true, omitted: value.length - max };
}

function boundedValue(value, depth = 0) {
  if (depth > 4) return { value: "[depth]", truncated: true };
  if (typeof value === "string") return clipText(value, MAX_ARG_CHARS);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let truncated = value.length > 32;
    const rows = value.slice(0, 32).map((item) => {
      const result = boundedValue(item, depth + 1);
      truncated ||= result.truncated;
      return result.value;
    });
    return { value: rows, truncated };
  }
  if (typeof value === "object") {
    let truncated = Object.keys(value).length > 40;
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      const keyResult = clipText(String(key), 200);
      truncated ||= keyResult.truncated;
      const itemResult = boundedValue(item, depth + 1);
      truncated ||= itemResult.truncated;
      result[keyResult.value] = itemResult.value;
    }
    return { value: result, truncated };
  }
  return { value: String(value), truncated: false };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function rowsText(rows) {
  if (!Array.isArray(rows)) return { rows: [], truncated: false, omittedRows: 0, omittedChars: 0 };
  let truncated = rows.length > MAX_ROWS;
  let omittedChars = 0;
  const clipped = rows.slice(0, MAX_ROWS).map((row) => {
    const result = clipText(String(row), MAX_ROW_CHARS);
    truncated ||= result.truncated;
    omittedChars += result.omitted ?? 0;
    return result.value;
  });
  return {
    rows: clipped,
    truncated,
    omittedRows: Math.max(0, rows.length - MAX_ROWS),
    omittedChars,
  };
}

function hex(value) {
  try {
    return Buffer.from(value, "utf8").toString("hex");
  } catch {
    return "";
  }
}

function safeMessage(error) {
  try {
    return clipText(error instanceof Error ? error.message : String(error), 2000).value;
  } catch {
    return "unknown error";
  }
}

export function createObserver(pi, options) {
  const role = options.role;
  const auditPath = process.env.REVIEW_NATIVE_AUDIT;
  if (typeof auditPath !== "string" || !auditPath.startsWith("/")) {
    throw new Error("REVIEW_NATIVE_AUDIT must be an absolute path");
  }
  let sequence = 0;
  let bytes = 0;
  let overflow = false;
  let harnessFailures = 0;
  let mounted = 0;
  let settled = 0;
  let defaultInvocations = 0;
  let registrationCount = 0;
  const registeredNames = [];
  const mountedStates = new Map();
  const truncations = [];
  const truncationKinds = new Set();

  const noteTruncation = (kind, retained, omitted, detail) => {
    const record = { kind, retained, omitted, detail: detail ?? null };
    truncations.push(record);
    if (truncationKinds.has(kind)) return;
    truncationKinds.add(kind);
    audit("evidence_truncation", {
      fatal: true,
      truncationKind: kind,
      retained,
      omitted,
      detail: detail ?? null,
      note: "the evidence budget was reached; the affected frame/text cannot be graded as complete",
    });
  };

  const audit = (type, fields = {}) => {
    if (overflow) return;
    let line;
    try {
      sequence += 1;
      if (sequence > MAX_EVENTS) {
        overflow = true;
        const stop = { sequence, at: new Date().toISOString(), role, type: "audit_overflow", maxEvents: MAX_EVENTS };
        appendFileSync(auditPath, `${JSON.stringify(stop)}\n`);
        return;
      }
      line = `${JSON.stringify({ sequence, at: new Date().toISOString(), monotonicMs: performance.now(), role, type, ...fields })}\n`;
    } catch (error) {
      overflow = true;
      try {
        appendFileSync(auditPath, `${JSON.stringify({ sequence, at: new Date().toISOString(), role, type: "audit_failure", message: safeMessage(error) })}\n`);
      } catch {
        // A bounded diagnostic cannot itself become authority.
      }
      return;
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > MAX_AUDIT_BYTES) {
      overflow = true;
      try {
        appendFileSync(auditPath, `${JSON.stringify({ sequence, at: new Date().toISOString(), role, type: "audit_byte_limit", maxBytes: MAX_AUDIT_BYTES })}\n`);
      } catch {
        // no-op
      }
      return;
    }
    bytes += lineBytes;
    try {
      appendFileSync(auditPath, line);
    } catch {
      overflow = true;
    }
  };

  const harnessFailure = (message, fields = {}) => {
    harnessFailures += 1;
    audit("harness_error", { message: safeMessage(message), failureCount: harnessFailures, ...fields });
  };

  const layoutGeometries = new Set();
  function emitLayoutOracle(columns, rows, mountId) {
    if (layoutFixture === null) {
      harnessFailure("the frozen static layout fixture could not be read", { mountId, columns });
      return;
    }
    if (!Number.isSafeInteger(columns) || columns <= 0) {
      harnessFailure("the first render geometry has no positive column count", { mountId, columns });
      return;
    }
    for (const line of staticLayoutLines()) {
      let wrappedRows;
      let outputWidths;
      try {
        wrappedRows = wrapLiteralLine(line.text, columns);
        if (!Array.isArray(wrappedRows) || wrappedRows.length === 0 || wrappedRows.join("") !== line.text) {
          harnessFailure("the public wrapper did not preserve a frozen static line", {
            mountId,
            logicalLineId: line.logicalLineId,
            columns,
          });
          continue;
        }
        outputWidths = wrappedRows.map((row) => visibleWidth(String(row)));
      } catch (error) {
        harnessFailure("the public wrapper failed on a frozen static line", {
          mountId,
          logicalLineId: line.logicalLineId,
          columns,
          message: safeMessage(error),
        });
        continue;
      }
      const empty = line.text.length === 0;
      const validWidths = outputWidths.every((width) => Number.isSafeInteger(width)
        && width >= 0
        && width <= columns
        && (empty ? width === 0 : width > 0));
      if (!validWidths || (empty && (wrappedRows.length !== 1 || wrappedRows[0] !== ""))) {
        harnessFailure("a frozen static line produced an unsafe cell layout", {
          mountId,
          logicalLineId: line.logicalLineId,
          columns,
          outputWidths,
        });
        continue;
      }
      audit("oracle_layout", {
        mountId,
        columns,
        rows,
        inputSha256: layoutFixture.sha256,
        logicalLineId: line.logicalLineId,
        lineSha256: sha256(line.text),
        inputText: clipText(line.text, MAX_ROW_CHARS).value,
        inputTextTruncated: line.text.length > MAX_ROW_CHARS,
        wrappedRows: wrappedRows.map((row) => clipText(String(row), MAX_ROW_CHARS).value),
        outputWidths,
      });
    }
  }

  function removeObservers(mountId) {
    const state = mountedStates.get(mountId);
    if (!state) return;
    for (const kind of ["paint", "frame"]) {
      const status = state.subscriptionState[kind];
      if (status !== "active") continue;
      const unsubscribe = kind === "paint" ? state.unsubscribePaint : state.unsubscribeFrame;
      if (typeof unsubscribe !== "function") {
        state.subscriptionState[kind] = "unknown";
        harnessFailure("an active observer subscription has no unsubscribe function", { mountId, kind });
        continue;
      }
      try {
        unsubscribe();
        state.subscriptionState[kind] = "removed";
        state.subscriptions = Math.max(0, state.subscriptions - 1);
        if (kind === "paint") state.unsubscribePaint = undefined;
        else state.unsubscribeFrame = undefined;
      } catch (error) {
        state.subscriptionState[kind] = "failed";
        harnessFailure("observer unsubscribe failed; subscription state remains unknown", {
          mountId,
          kind,
          message: safeMessage(error),
          activeSubscriptions: state.subscriptions,
        });
      }
    }
  }

  function wrapComponent(component, state) {
    if (typeof component !== "object" || component === null) {
      harnessFailure("the real custom factory did not return a component object", { mountId: state.mountId });
      return component;
    }
    for (const name of ["render", "handleInput", "capturesInput", "dispose"]) {
      const descriptor = Object.getOwnPropertyDescriptor(component, name);
      if (!descriptor || typeof descriptor.value !== "function" || descriptor.configurable === false) {
        harnessFailure(`the component method ${name} cannot be wrapped transparently`, { mountId: state.mountId });
        continue;
      }
      const original = descriptor.value;
      const wrapped = function observedComponentMethod(...args) {
        if (state.disposedInvocation > 0 && name !== "dispose") {
          audit("post_dispose_call", { mountId: state.mountId, method: name, disposeInvocations: state.disposedInvocation });
        }
        if (name === "render") {
          const renderSequence = ++state.renderCount;
          const geometryKey = `${String(args[0])}x${String(state.terminal?.rows)}`;
          if (!layoutGeometries.has(geometryKey)) {
            layoutGeometries.add(geometryKey);
            emitLayoutOracle(Number(args[0]), Number(state.terminal?.rows), state.mountId);
          }
          let result;
          try {
            result = original.apply(this, args);
          } catch (error) {
            audit("render_error", { mountId: state.mountId, renderSequence, message: safeMessage(error) });
            throw error;
          }
          const observedRows = rowsText(result);
          if (observedRows.truncated) {
            noteTruncation("render_rows", observedRows.rows.length, observedRows.omittedRows, `mount ${state.mountId} render ${renderSequence}`);
          }
          audit("render", {
            mountId: state.mountId,
            renderSequence,
            width: args[0],
            rows: state.terminal?.rows,
            columns: state.terminal?.columns,
            output: observedRows.rows,
            outputWidths: Array.isArray(result) ? result.slice(0, MAX_ROWS).map((row) => visibleWidth(String(row))) : [],
            outputTruncated: observedRows.truncated,
            outputOmittedRows: observedRows.omittedRows,
            outputOmittedChars: observedRows.omittedChars,
          });
          return result;
        }
        if (name === "handleInput") {
          const inputSequence = ++state.inputCount;
          const data = args[0];
          const inputText = typeof data === "string" ? clipText(data, 4000) : { value: null, truncated: false };
          if (inputText.truncated) noteTruncation("input_text", 4000, inputText.omitted, `mount ${state.mountId} input ${inputSequence}`);
          audit("handle_input", {
            mountId: state.mountId,
            inputSequence,
            hex: hex(data),
            text: inputText.value,
            textTruncated: inputText.truncated,
          });
          try {
            const result = original.apply(this, args);
            return result;
          } catch (error) {
            audit("handle_input_error", { mountId: state.mountId, inputSequence, message: safeMessage(error) });
            throw error;
          }
        }
        if (name === "capturesInput") {
          const data = args[0];
          const result = original.apply(this, args);
          audit("captures_input", {
            mountId: state.mountId,
            hex: hex(data),
            result: result === true,
          });
          return result;
        }
        state.disposedInvocation += 1;
        const invocation = state.disposedInvocation;
        try {
          return original.apply(this, args);
        } finally {
          removeObservers(state.mountId);
          audit("dispose", {
            mountId: state.mountId,
            invocation,
            subscriptions: state.subscriptions,
            subscriptionState: { ...state.subscriptionState },
            disposed: state.disposedInvocation,
            harnessFailures,
          });
        }
      };
      try {
        Object.defineProperty(component, name, { ...descriptor, value: wrapped });
      } catch (error) {
        harnessFailure(`defining the ${name} observer failed`, { mountId: state.mountId, message: safeMessage(error) });
      }
    }
    return component;
  }

  function observeFactory(mountId, tui) {
    const state = {
      mountId,
      terminal: tui?.terminal,
      subscriptions: 0,
      subscriptionState: { paint: "missing", frame: "missing" },
      unsubscribePaint: undefined,
      unsubscribeFrame: undefined,
      renderCount: 0,
      paintCount: 0,
      frameCount: 0,
      inputCount: 0,
      disposedInvocation: 0,
    };
    mountedStates.set(mountId, state);
    try {
      if (typeof tui?.addPaintListener === "function") {
        state.unsubscribePaint = tui.addPaintListener((paint) => {
          state.paintCount += 1;
          if (state.paintCount > 64) {
            noteTruncation("paint_frames", 64, state.paintCount - 64, `mount ${mountId} omitted later completed frames`);
            return;
          }
          const raw = Array.isArray(paint?.viewport) ? paint.viewport : [];
          const plain = raw.slice(0, MAX_ROWS).map((row) => stripTerminalSequences(String(row)));
          const normalized = plain.map((row) => normalizeTerminalOutput(row));
          const truncated = raw.length > MAX_ROWS || raw.some((row) => String(row).length > MAX_ROW_CHARS);
          if (truncated) noteTruncation("paint_rows", plain.length, Math.max(0, raw.length - MAX_ROWS), `mount ${mountId} paint ${state.paintCount}`);
          audit("paint", {
            mountId,
            paintSequence: state.paintCount,
            columns: paint?.columns,
            rows: paint?.rows,
            alt: paint?.alt === true,
            viewportHash: sha256(JSON.stringify(raw)),
            plainViewport: plain.map((row) => clipText(row, MAX_ROW_CHARS).value),
            plainWidths: plain.map((row) => visibleWidth(row)),
            normalizedViewport: normalized.map((row) => clipText(row, MAX_ROW_CHARS).value),
            viewportTruncated: truncated,
          });
        });
        state.subscriptions += 1;
        state.subscriptionState.paint = "active";
      } else {
        harnessFailure("the host TUI did not expose addPaintListener", { mountId });
      }
      if (typeof tui?.addFrameWriteListener === "function") {
        state.unsubscribeFrame = tui.addFrameWriteListener((data) => {
          state.frameCount += 1;
          if (state.frameCount > 64) {
            noteTruncation("frame_writes", 64, state.frameCount - 64, `mount ${mountId} omitted later frame writes`);
            return;
          }
          const text = String(data);
          audit("frame_write", {
            mountId,
            frameSequence: state.frameCount,
            bytes: Buffer.byteLength(text, "utf8"),
            hash: sha256(text),
            containsReviewTitle: text.includes("HUMAN REVIEW"),
          });
        });
        state.subscriptions += 1;
        state.subscriptionState.frame = "active";
      } else {
        harnessFailure("the host TUI did not expose addFrameWriteListener", { mountId });
      }
    } catch (error) {
      harnessFailure("attaching public paint/frame observers failed", { mountId, message: safeMessage(error) });
    }
    return state;
  }

  const originalRegisterTool = Reflect.get(pi, "registerTool", pi);
  if (typeof originalRegisterTool !== "function") {
    throw new Error("the extension API does not expose registerTool");
  }

  function observingRegisterTool(definition) {
    registrationCount += 1;
    const name = typeof definition?.name === "string" ? definition.name : "<unnamed>";
    registeredNames.push(name);
    const descriptorKeys = definition && typeof definition === "object"
      ? Reflect.ownKeys(definition).map(String).sort()
      : [];
    const parameters = definition?.parameters ?? null;
    const boundedParameters = parameters === null ? { value: null, truncated: false } : boundedValue(parameters);
    if (boundedParameters.truncated) noteTruncation("tool_schema", 1, 1, `tool ${name}`);
    audit("tool_registered", {
      name,
      registration: registrationCount,
      sourceInfo: definition?.sourceInfo ?? null,
      descriptorKeys,
      schemaSha256: parameters === null ? null : sha256(JSON.stringify(parameters)),
      parameters: boundedParameters.value,
      parametersTruncated: boundedParameters.truncated,
      descriptionSha256: typeof definition?.description === "string" ? sha256(definition.description) : null,
      descriptionIncludesRequestReview: typeof definition?.description === "string"
        ? definition.description.includes("request_review")
        : false,
      descriptionIncludesHumanReview: typeof definition?.description === "string"
        ? definition.description.toLowerCase().includes("human review")
        : false,
      executeType: typeof definition?.execute,
    });
    if (name !== "agent_deliver") {
      return originalRegisterTool.call(pi, definition);
    }
    const executeDescriptor = Object.getOwnPropertyDescriptor(definition, "execute");
    const originalExecute = typeof definition.execute === "function"
      ? definition.execute
      : (executeDescriptor && typeof executeDescriptor.value === "function" ? executeDescriptor.value : undefined);
    if (typeof originalExecute !== "function" || (executeDescriptor && executeDescriptor.configurable === false)) {
      harnessFailure("agent_deliver execute cannot be wrapped", { name });
      return originalRegisterTool.call(pi, definition);
    }
    let observed;
    try {
      observed = Object.create(Object.getPrototypeOf(definition));
      for (const key of Reflect.ownKeys(definition)) {
        if (key === "execute") continue;
        Object.defineProperty(observed, key, Object.getOwnPropertyDescriptor(definition, key));
      }
      Object.defineProperty(observed, "execute", {
        ...(executeDescriptor ?? { writable: true, enumerable: false, configurable: true }),
        value: async function observedAgentDeliverExecute(toolCallId, params, signal, onUpdate, context) {
          const started = performance.now();
          const boundedParams = boundedValue(params);
          if (boundedParams.truncated) noteTruncation("tool_args", 1, 1, `tool ${name} call ${toolCallId}`);
          audit("tool_call_start", {
            toolName: name,
            toolCallId,
            params: boundedParams.value,
            paramsTruncated: boundedParams.truncated,
            context: {
              mode: context?.mode ?? null,
              agentKind: context?.agent?.kind ?? null,
              hasUI: context?.hasUI === true,
              customType: typeof context?.ui?.custom,
              model: context?.model === undefined ? null : {
                provider: context.model?.provider ?? null,
                id: context.model?.id ?? null,
                api: context.model?.api ?? null,
              },
            },
          });
          const facade = context && typeof context === "object"
            ? makeContextFacade(context)
            : context;
          let result;
          try {
            result = await originalExecute.call(definition, toolCallId, params, signal, onUpdate, facade);
          } catch (error) {
            audit("tool_call_error", {
              toolName: name,
              toolCallId,
              durationMs: Math.round((performance.now() - started) * 1000) / 1000,
              message: safeMessage(error),
            });
            throw error;
          }
          const text = contentText(result?.content);
          const boundedContent = clipText(text, MAX_CONTENT_CHARS);
          if (boundedContent.truncated) noteTruncation("tool_result", MAX_CONTENT_CHARS, boundedContent.omitted, `tool ${name} call ${toolCallId}`);
          audit("tool_call_end", {
            toolName: name,
            toolCallId,
            durationMs: Math.round((performance.now() - started) * 1000) / 1000,
            isError: result?.isError === true,
            content: boundedContent.value,
            contentTruncated: boundedContent.truncated,
            contentSha256: sha256(text),
            detailsKeys: result?.details && typeof result.details === "object"
              ? Object.keys(result.details).sort()
              : [],
          });
          return result;
        },
      });
    } catch (error) {
      harnessFailure("cloning agent_deliver with preserved descriptors failed", { name, message: safeMessage(error) });
      return originalRegisterTool.call(pi, definition);
    }
    audit("tool_wrapped", { name, toolCallIdField: "execute" });
    return originalRegisterTool.call(pi, observed);
  }

  function makeContextFacade(context) {
    return new Proxy(context, {
      get(target, property) {
        if (property === "ui") {
          const liveUi = Reflect.get(target, property, target);
          return liveUi && typeof liveUi === "object" ? getUiFacade(liveUi) : liveUi;
        }
        return Reflect.get(target, property, target);
      },
      has(target, property) {
        return Reflect.has(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target);
      },
    });
  }

  function getUiFacade(ui) {
    const cached = uiFacades.get(ui);
    if (cached !== undefined) return cached;
    const custom = function observedCustom(factory, customOptions) {
      const mountId = `mount-${++mounted}`;
      const actualCustom = Reflect.get(ui, "custom", ui);
      if (typeof actualCustom !== "function") {
        harnessFailure("the live UI custom method became non-callable before invocation", { mountId });
        audit("custom_unavailable", { mountId, actualType: typeof actualCustom });
        throw new Error("the live UI custom method is unavailable at invocation");
      }
      const boundedOptions = boundedValue(customOptions);
      if (boundedOptions.truncated) noteTruncation("custom_options", 1, 1, mountId);
      audit("custom_call", {
        mountId,
        mountCount: mounted,
        options: boundedOptions.value,
        optionsTruncated: boundedOptions.truncated,
        signalPresent: customOptions?.signal !== undefined,
        customCallableAtInvocation: true,
      });
      let state;
      const observedFactory = function observedReviewFactory(tui, theme, keybindings, done) {
        audit("factory", {
          mountId,
          factoryCount: 1,
          columns: tui?.terminal?.columns ?? null,
          rows: tui?.terminal?.rows ?? null,
          hasDone: typeof done === "function",
          hasTheme: theme !== undefined,
          keybindingsMatches: typeof keybindings?.matches === "function",
        });
        state = observeFactory(mountId, tui);
        let component;
        try {
          component = factory(tui, theme, keybindings, done);
        } catch (error) {
          audit("factory_error", { mountId, message: safeMessage(error) });
          removeObservers(mountId);
          throw error;
        }
        return wrapComponent(component, state);
      };
      let promise;
      try {
        promise = Promise.resolve(actualCustom.call(ui, observedFactory, customOptions));
      } catch (error) {
        audit("custom_call_error", { mountId, message: safeMessage(error) });
        removeObservers(mountId);
        throw error;
      }
      promise.then(
        (result) => {
          settled += 1;
          const current = mountedStates.get(mountId);
          audit("custom_settled", {
            mountId,
            result: typeof result === "string" ? result : null,
            resultType: typeof result,
            disposedInvocations: current?.disposedInvocation ?? 0,
            subscriptions: current?.subscriptions ?? 0,
            subscriptionState: current === undefined ? null : { ...current.subscriptionState },
            renderCount: current?.renderCount ?? 0,
            paintCount: current?.paintCount ?? 0,
            frameCount: current?.frameCount ?? 0,
            inputCount: current?.inputCount ?? 0,
            settledCount: settled,
            evidenceTruncations: [...truncations],
            harnessFailures,
          });
        },
        (error) => {
          settled += 1;
          const current = mountedStates.get(mountId);
          audit("custom_error", {
            mountId,
            message: safeMessage(error),
            disposedInvocations: current?.disposedInvocation ?? 0,
            subscriptions: current?.subscriptions ?? 0,
            subscriptionState: current === undefined ? null : { ...current.subscriptionState },
            settledCount: settled,
            evidenceTruncations: [...truncations],
            harnessFailures,
          });
        },
      ).finally(() => {
        removeObservers(mountId);
      });
      return promise;
    };
    let proxy;
    try {
      proxy = new Proxy(ui, {
        get(target, property) {
          if (property === "custom") {
            const live = Reflect.get(target, property, target);
            return typeof live === "function" ? custom : live;
          }
          return Reflect.get(target, property, target);
        },
        has(target, property) {
          return Reflect.has(target, property);
        },
        getOwnPropertyDescriptor(target, property) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
          return Reflect.ownKeys(target);
        },
      });
    } catch (error) {
      harnessFailure("UI facade construction failed", { message: safeMessage(error) });
      return ui;
    }
    uiFacades.set(ui, proxy);
    return proxy;
  }

  const api = new Proxy(pi, {
    get(target, property) {
      if (property === "registerTool") return observingRegisterTool;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) {
      return Reflect.has(target, property);
    },
    getOwnPropertyDescriptor(target, property) {
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
  });

  function installEvents() {
    if (typeof pi.on !== "function") {
      harnessFailure("the extension API does not expose on()");
      return;
    }
    try {
      pi.on("session_start", (_event, context) => {
        audit("session_start", {
          mode: context?.mode ?? null,
          kind: context?.agent?.kind ?? null,
          hasUI: context?.hasUI === true,
          stdinIsTTY: process.stdin.isTTY === true,
          stdoutIsTTY: process.stdout.isTTY === true,
          model: {
            provider: context?.model?.provider ?? null,
            id: context?.model?.id ?? null,
            api: context?.model?.api ?? null,
          },
          tools: typeof pi.getActiveTools === "function" ? pi.getActiveTools().slice().sort() : [],
          registrations: registrationCount,
          registeredNames: [...registeredNames],
          defaultInvocations,
        });
        return undefined;
      });
      pi.on("tool_call", (event) => {
        if (event?.toolName !== "agent_execute") return undefined;
        const input = boundedValue(event.input ?? null);
        if (input.truncated) noteTruncation("execute_start_input", 1, 1, String(event.toolCallId));
        audit("execute_call_start", {
          toolCallId: event.toolCallId ?? null,
          toolName: event.toolName,
          input: input.value,
          inputTruncated: input.truncated,
        });
        return undefined;
      });
      pi.on("tool_result", (event) => {
        if (event?.toolName !== "agent_execute") return undefined;
        const content = contentText(event.content);
        const boundedContent = clipText(content, MAX_CONTENT_CHARS);
        if (boundedContent.truncated) noteTruncation("execute_result", MAX_CONTENT_CHARS, boundedContent.omitted, String(event.toolCallId));
        const boundedInput = boundedValue(event.input ?? null);
        if (boundedInput.truncated) noteTruncation("execute_input", 1, 1, String(event.toolCallId));
        audit("execute_result_observed", {
          toolCallId: event.toolCallId ?? null,
          toolName: event.toolName,
          isError: event.isError === true,
          input: boundedInput.value,
          inputTruncated: boundedInput.truncated,
          content: boundedContent.value,
          contentTruncated: boundedContent.truncated,
          contentSha256: sha256(content),
        });
        return undefined;
      });
      pi.on("agent_end", () => {
        audit("agent_end", {
          defaultInvocations,
          registrations: registrationCount,
          registeredNames: [...registeredNames],
          mounts: mounted,
          settled,
        });
        return undefined;
      });
      pi.on("session_shutdown", () => {
        for (const mountId of mountedStates.keys()) removeObservers(mountId);
        audit("session_shutdown", {
          defaultInvocations,
          registrations: registrationCount,
          registeredNames: [...registeredNames],
          mounts: mounted,
          settled,
          harnessFailures,
          evidenceTruncations: [...truncations],
          subscriptionStates: [...mountedStates.values()].map((state) => ({
            mountId: state.mountId,
            subscriptions: state.subscriptions,
            subscriptionState: { ...state.subscriptionState },
          })),
        });
        return undefined;
      });
    } catch (error) {
      harnessFailure("event observation registration failed", { message: safeMessage(error) });
    }
  }

  function installCommands() {
    if (typeof pi.registerCommand !== "function") {
      harnessFailure("the extension API does not expose registerCommand()");
      return;
    }
    try {
      pi.registerCommand("review-native-echo", {
        description: "Harness-only editor recovery proof; never approves or submits.",
        handler: (_args, context) => {
          audit("editor_recovered", {
            mode: context?.mode ?? null,
            kind: context?.agent?.kind ?? null,
            hasUI: context?.hasUI === true,
            stdinIsTTY: process.stdin.isTTY === true,
            stdoutIsTTY: process.stdout.isTTY === true,
            mounts: mounted,
            settled,
            defaultInvocations,
            registrations: registrationCount,
          });
        },
      });
      pi.registerCommand("review-native-finish", {
        description: "Harness-only normal TUI shutdown; never approves or submits.",
        handler: (_args, context) => {
          audit("finish_command", {
            mounts: mounted,
            settled,
            defaultInvocations,
            registrations: registrationCount,
            harnessFailures,
          });
          context.shutdown();
        },
      });
    } catch (error) {
      harnessFailure("diagnostic command registration failed", { message: safeMessage(error) });
    }
  }

  function noteDefaultInvocation() {
    defaultInvocations += 1;
    audit("default_invocation", { count: defaultInvocations, role });
  }

  return {
    api,
    audit,
    harnessFailure,
    installEvents,
    installCommands,
    noteDefaultInvocation,
    state: () => ({
      defaultInvocations,
      registrations: registrationCount,
      registeredNames: [...registeredNames],
      mounts: mounted,
      settled,
      harnessFailures,
      overflow,
      sequence,
    }),
  };
}
