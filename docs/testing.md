# Testing

The verified local development environment uses macOS, OMP 18.18.0, and Bun 1.4.0.

## Commands

```sh
bun install
bun run check
bun run test:omp
bun run test:entry
bun run test:jobs
bun run scripts/test-execution.ts
bun run test:delivery
bun run test:daily
bun run test:package-entry
```

`check` runs TypeScript checks, unit tests, and `test:human-review` in a separate Bun process. The isolated human-review suite substitutes review transport while exercising actual execution, verification, delivery, and record installation. Component checks separately exercise display logic and context guards. It is an engineering simulation, not evidence of real user approval.

The other commands above start actual OMP processes with temporary profiles and local deterministic test providers or services. They do not call a paid model. `OMP_COMMAND` can override the OMP executable.

For entry/job native failures, set `OMP_AGENT_B1_EVIDENCE_ROOT` to an absolute test-owned directory. The harness then copies this attempt's real frames, stderr, state, audit, fixture and job records into a unique `*-attempt-*` directory (bounded to 8 MiB) before cleanup. The copy limit applies to files under the source root; actual frames and stderr are also saved. Without that setting, or if export fails, skips files, or process cleanup fails, the existing private temporary root is preserved and its path is reported; only test-owned processes are terminated. No machine-specific path is embedded in the tests.

## What the tests establish

- Task ownership, requirement changes, session binding, and capability admission.
- Bounded local execution, watchdog behavior, cancellation, and completion accounting.
- Candidate provenance, immutable verification contracts, and honest coverage reporting.
- Delivery file identity, exact byte checks, bounded previews, and idempotent reads.
- Host acceptance reservation, exact evidence checks, idempotent record installation, uncertain outcomes, and postcommit visibility.
- Model-visible submit/inspect results, current versus historical acceptance, and rejection of late actions after acceptance.
- Default-off human review, complete bounded display data, valid partial-check issuance, one-shot approval binding, and separate human/hybrid record schemas under a simulated transport.
- The local review component: complete painted content, default rejection, resize reset, pasted input, deadline, and current-context checks.
- Actual OMP entry-factory composition: the delivery suite separately loads the task entry and execution composition, then checks the installed record and real files. It also covers delivery without acceptance configuration and incomplete semantic coverage.
- Job submission reconciliation when responses are delayed, interrupted, or lost.

Deterministic integration tests establish interface and control behavior. They do not measure arbitrary task success rates or independently establish production readiness.

## Verification status

The configured-entry source passed type checking, 388 unit tests (28,972 assertions), and 15 isolated human-review tests (155 assertions). Independent component checks covered 26 scenarios and a reentrant context-change regression. Actual OMP delivery (5 tests / 233 assertions) passed on the historical-inspection revision. The continuous-task increment separately passed actual entry (18 / 529) and job (10 / 239) suites; its execution regression (6 / 112) was carried forward from an unchanged dependency set. The historical-inspection change adds a pure retained-task reader and leaves existing owner control methods unchanged; it does not rerun those earlier entry/job samples. Five independent historical-inspection families and a real unknown-installation control/final-context pair passed after repair. These are bounded engineering checks, not independent model-quality samples.

All eight native review scenarios have passed after fixture corrections. The matrix covers default-off and invalid configuration, initial Enter, Escape, small-window resize, complete-content acceptance without an automatic contract, acceptance with valid partial automatic coverage, and the actual five-minute deadline. Positive captures are independently checked against full requirements, file bytes, source/input identities, and completed terminal paints. Offline mutations remove or alter evidence to check that the grader rejects incomplete results.

The native runner is deliberately inert by default:

```sh
bun run test:human-review-native --help
bun run test:human-review-native --required
```

Execution requires an explicit frozen-file manifest and a selected case; the deadline case takes five minutes. The runner uses isolated profiles and a deterministic local provider, preserves failures, verifies process cleanup, and never treats automated keys as genuine human approval. Raw terminal output is not a screenshot. Unicode layout follows the tested OMP helpers; these checks do not independently validate terminal fonts or every Unicode sequence. Human readability and an actual user decision remain pending separately.

Results apply to the reviewed source and stated environment. They are not general reliability percentages. Fixture repairs retain their original failed captures and are distinguished from product defects. Any new behavior must pass its applicable checks before being described as validated.

### Explicit entry configuration and composition

```sh
bun test test/unit/daily-entry.test.ts
```

These focused tests cover strict configuration, canonical workspace matching, input/state separation, fresh instances, duplicate-owner preservation, partially installed handlers remaining inactive, and teardown. Their host doubles do not establish real OMP loading or a human decision.

Native single-entry results are reported separately from these unit checks. The integration criteria are: one real default entry load, native OMP tools retained, actual candidate and insufficient-verification evidence, cancellation followed by a distinct task in the same instance, a fresh instance after restart, and invalid configuration without managed authority or damage to unrelated files. A local TUI composition check additionally requires actual paint and refusal-path cleanup; automated Escape input does not constitute user approval. Existing separate-entry and component results do not by themselves prove the new composition.

The actual OMP daily suite passed 3 cases and 308 assertions: continuous tasks with insufficient verification, a fresh instance after restart, and invalid configuration. The actual main-TUI daily rejection case passed 45 checks; the existing separate-entry Escape case passed 22 checks after the shared fixture changes. Both TUI cases exited normally without signal fallback, retained their raw terminal/evidence captures, and verified child/watchdog cleanup. The original failed fixture attempts remain recorded separately.

`daily-escape` is explicit-only and is excluded from the existing native `all` selection. As with other native review cases, execution requires a root-authorized source/binary manifest:

```sh
bun run test:human-review-native --case daily-escape --manifest /absolute/test-manifest.json --execute
```

For daily RPC failures, set `OMP_AGENT_DAILY_EVIDENCE_ROOT` to an absolute test-owned directory. The harness preserves the first cause and later diagnostics by attempt, checks execution identities for every instance before deleting shared roots, and reports incomplete export or uncertain cleanup as failure. Successful RPC runs remove their runtime roots; their console results and frozen source are distinct from retained raw TUI captures. No result here establishes real-model task quality or human approval.

## Package directory and artifact checks

`test:package-entry` creates a real Bun package archive and checks its exact path/byte/hash inventory before extracting it outside the checkout. A missing-launcher mutation must be rejected. It separately checks the checkout package directory, the extracted artifact running a task through execution/insufficient verification/preview, and the artifact without host configuration. A provider-only baseline identifies the native tool set; it is not an additional product scenario.

The artifact observer imports the selected artifact's task-owner port, and the actual execution record identifies the packaged launcher. The suite preserves source/binary and archive manifests, actual calls/content, run records and file evidence outside runtime cleanup. These are deterministic package wiring checks; they do not install into a personal profile, publish a release, call a paid model, or establish human approval.
