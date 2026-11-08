import g2a1ExecutionEntry from "../../src/execution-entry.ts";
import { createObserver } from "./human-review-native-observe.mjs";

/**
 * Native no-contract case wrapper. The real `src/task-entry.ts` is loaded as a
 * separate extension first; this wrapper then calls the frozen production
 * default execution entry exactly once with the transparent observation API.
 * It does not call createExecutionEntry, parse/rewrite environment values,
 * publish an owner, bind a contract or construct a service.
 */
export default function humanReviewNativeObserver(pi) {
  const observer = createObserver(pi, { role: "default-env-wrapper" });
  observer.installEvents();
  observer.installCommands();
  try {
    observer.noteDefaultInvocation();
    g2a1ExecutionEntry(observer.api);
    observer.audit("default_factory_returned", {
      count: observer.state().defaultInvocations,
      registrations: observer.state().registrations,
      registeredNames: observer.state().registeredNames,
    });
  } catch (error) {
    observer.audit("default_factory_error", {
      count: observer.state().defaultInvocations,
      message: error instanceof Error ? error.message : String(error),
    });
    observer.harnessFailure("the real default execution entry threw", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
