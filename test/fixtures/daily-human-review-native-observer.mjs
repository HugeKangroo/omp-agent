import dailyEntry from "../../src/daily-entry.ts";
import { createObserver } from "./human-review-native-observe.mjs";

/**
 * Native daily-composition case wrapper. This is the only loaded composition
 * extension: it calls the real production daily default exactly once through
 * the transparent observation API. It does not call createDailyEntry,
 * createTaskEntry or createExecutionEntry, does not seed state and does not
 * rewrite the host configuration.
 */
export default function dailyHumanReviewNativeObserver(pi) {
  const observer = createObserver(pi, { role: "daily-composition-wrapper" });
  observer.installEvents();
  observer.installCommands();
  try {
    observer.noteDefaultInvocation();
    dailyEntry(observer.api);
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
    observer.harnessFailure("the real daily entry threw", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
