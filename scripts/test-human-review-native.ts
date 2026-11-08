import {
  CASE_SPECS,
  describeRequired,
  planText,
  runSelectedCases,
} from "../test/harness/human-review-native-runner.ts";

/**
 * Explicit native human-review entry. Without --execute this only prints the
 * inert plan; no product import, PTY, OMP, provider or model is started.
 */

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(planText());
  process.exit(0);
}
if (args.includes("--required")) {
  console.log(await describeRequired());
  process.exit(0);
}
if (!args.includes("--execute")) {
  console.log(planText());
  process.exit(0);
}
const manifestPath = option(args, "--manifest");
const caseName = option(args, "--case");
if (!manifestPath) {
  console.error("test:human-review-native requires --manifest ROOT_AUTHORIZED_MANIFEST");
  process.exit(2);
}
if (!caseName) {
  console.error(`test:human-review-native requires --case NAME (${Object.keys(CASE_SPECS).join(", ")})`);
  process.exit(2);
}
if (caseName !== "all" && CASE_SPECS[caseName] === undefined) {
  console.error(`unknown case ${caseName}`);
  process.exit(2);
}
const includeDeadline = args.includes("--include-deadline");
const result = await runSelectedCases(caseName, manifestPath, includeDeadline);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "pass" ? 0 : 1);
