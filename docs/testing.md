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

Focused G3-A/B1 local history checks:

```sh
bun test test/unit/history-session.test.ts test/unit/daily-entry.test.ts test/unit/history-projection.test.ts test/unit/history-evidence.test.ts
```

`check` runs TypeScript checks, unit tests, and `test:human-review` in a separate Bun process. The isolated human-review suite substitutes review transport while exercising actual execution, verification, delivery, and record installation. Component checks separately exercise display logic and context guards. It is an engineering simulation, not evidence of real user approval.

The other commands above start actual OMP processes with temporary profiles and local deterministic test providers or services. They do not call a paid model. `OMP_COMMAND` can override the OMP executable.

For entry/job native failures, set `OMP_AGENT_B1_EVIDENCE_ROOT` to an absolute test-owned directory. The harness then copies this attempt's real frames, stderr, state, audit, fixture and job records into a unique `*-attempt-*` directory (bounded to 8 MiB) before cleanup. The copy limit applies to files under the source root; actual frames and stderr are also saved. Without that setting, or if export fails, skips files, or process cleanup fails, the existing private temporary root is preserved and its path is reported; only test-owned processes are terminated. No machine-specific path is embedded in the tests.

## What the tests establish

- Task ownership, requirement changes, session binding, and capability admission.
- B1 host capture and native-locator lifecycle: committed-event-only capture, bounded pending queues, exact main-context publication, complete requirement-source validation, native custom-entry and branch/leaf checks, unknown append outcomes, and navigation/disposal invalidation.
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

These focused tests cover strict configuration, canonical workspace matching, input/state separation, fresh instances, duplicate-owner preservation, main-only exposure of the fixed advisory workflow guidance beside task guidance, partially installed handlers remaining inactive without guidance, and teardown. Their host doubles do not establish the actual OMP message payload, model compliance, or a human decision.

Native single-entry results are reported separately from these unit checks. The integration criteria are: one real default entry load, native OMP tools retained, actual candidate and insufficient-verification evidence, cancellation followed by a distinct task in the same instance, a fresh instance after restart, and invalid configuration without managed authority or damage to unrelated files. The first real main prompt must also expose exactly the fixed daily workflow guidance beside the existing task guidance in provider-visible context. OMP converts those session custom messages to `developer` messages without `customType`, so the fixture selects them by their own stable content anchors, records the actual role and source location, content, byte count and digest, excludes historical guidance from the current-prompt check, and does not reconstruct the text from product constants. A local TUI composition check additionally requires actual paint and refusal-path cleanup; automated Escape input does not constitute user approval. Existing separate-entry and component results do not by themselves prove the new composition.

The current actual OMP daily suite passed 3 cases and 383 assertions: continuous tasks with insufficient verification, a fresh instance after restart, and invalid configuration, now including the provider-visible guidance checks. The final focused daily/task-entry unit checks passed 50 tests and 295 assertions, and typechecking passed. The earlier complete unit-suite result predates the trusted-control-type connection and is not presented as a new full-suite run.

The earlier actual main-TUI daily rejection case passed 45 checks; the separate-entry Escape case passed 22 checks after the shared fixture changes. Those TUI cases exited normally without signal fallback, retained their raw terminal/evidence captures, and verified child/watchdog cleanup. They were not rerun for this advisory-message change. The original failed fixture attempts remain recorded separately.

A bounded real-model document sample subsequently completed the managed generation, verification-selection and preview chain within its original budget. Its actual provider request contained both guidance messages; the provider converted their wire role to `user`, whereas the local fixture observes `developer` before that conversion. The sample retained four recovered errors, including two incorrect self-test assertions, and independent report review found unsupported premises. Mechanical execution evidence is therefore reported separately from content acceptance. Citation counts and headings do not establish semantic correctness, and a no-contract `insufficient` receipt does not establish byte or semantic verification. The separate unsupported-runtime sample's honest final reply and absence of prohibited execution are limited observations; its unresolved raw-to-parsed argument attribution keeps its original automated failure intact.

`daily-escape` is explicit-only and is excluded from the existing native `all` selection. As with other native review cases, execution requires a root-authorized source/binary manifest:

```sh
bun run test:human-review-native --case daily-escape --manifest /absolute/test-manifest.json --execute
```

For daily RPC failures, set `OMP_AGENT_DAILY_EVIDENCE_ROOT` to an absolute test-owned directory. The harness preserves the first cause and later diagnostics by attempt, checks execution identities for every instance before deleting shared roots, and reports incomplete export or uncertain cleanup as failure. Successful RPC runs remove their runtime roots; their console results and frozen source are distinct from retained raw TUI captures. No result here establishes real-model task quality or human approval.

## Local history and archived-run evidence

The focused checks use real `TaskOwner` creation, revision, cancellation and snapshots. They cover complete requirement ledgers, stable selectors, defensive copies, conflicting revisions, schema and identity mismatches, bounded retention without eviction, and refusal to adopt an unknown pre-existing index. Archived-run checks use independent fixed source, input and artifact bytes and the existing run layout. They cover exact identity binding, selected artifact subsets, missing or changed files, unsafe paths, unknown versions and incomplete process-control records. An accepted reference remains recorded data only.

The B1 checks use real `TaskOwner` start, revision and cancellation commits with actual-shaped branches and narrow host session fixtures. Positive checks confirm immediate capture of start, revise, cancel and a second task; exact allowlisted native locators published once from a main `agent_end`; old rows retained after the current task moves; unchanged owner grants and no new tool-catalog entry. Negative checks cover reentrant or mismatched events, false or missing genuine sources, wrong session/workspace/agent kind, missing host APIs, ordinary projection failures versus a projection error coded `unknown` classified as possibly applied with future capture disabled, failed or ambiguous appends, repeated events, pre-append branch rewrites, duplicate ids, navigation or disposal during `ensureOnDisk`, timeouts with late resolution, bounded queue overflow without eviction, and disposal invalidation. Ordinary `agent_end` with no pending item performs no persistence call or append.

The combined focused invocation passes 61 tests and 970 assertions; type checking passes. The B1 unknown-capture regression stubs the public `HistoryProjectionWriter.capture` method to inject its real error class; it is failure-injection mapping evidence only, not disk-publication evidence, and the scoped spy is restored in `finally`. Two A fault tests spawn isolated Bun children so filesystem interception does not affect the parent test process. They confirm that a first publication followed by a read failure reports `unknown`, leaves the expected bytes installed and refuses adoption on retry. Partial writes complete through the write loop; a partial write followed by EIO or a zero-byte return before replacement preserves the previous index. Each injected fault must actually fire, and the parent checks real file bytes, link count, cleanup and retry outcomes. Separate independent probes also reject observable same-inode mutations and changes to a source or history item while a later input is being read; these supplementary probes are not permanent unit-test coverage.

The unit checks use temporary test-owned files and do not invoke OMP, a model or a PTY. The existing daily suite also passes three actual OMP RPC scenarios with 383 assertions; its `--no-session` mode does not establish persistent-session behavior.

A separate, locally retained integration probe passes 21 checks on OMP 18.18.0 using one actual main TUI process, the default daily composition, one task prompt and a local deterministic provider. It binds the genuine user entry to the committed task and complete original requirement source, independently recomputes history digests, and requires one confirmed capture and one confirmed visible native locator without an unknown or incomplete outcome. After a normal shutdown command and exit, the physical session file retains the same locator and the history index bytes are unchanged. It uses an isolated four-tool profile and performs no managed script, verification, delivery or acceptance; it is not a language-model quality sample or a full native-tool catalog test. Two earlier fixture failures are retained: missing explicit Bun configuration and an incorrect assumption about the native reminder prefix in model-visible text. Only the private fixtures changed between these attempts.

The `task_accepted` event is field-checked against the current snapshot and recorded reference (`acceptanceId`, `deliveryId`, `recordDigest`, `acceptedAt`), but no real accepted-task installation is exercised in this focused set; an accepted reference remains recorded data only. B1 has no query, resume, replay, authority-restoration or model-visible history feature. Normal-exit file retention does not establish crash durability or branch visibility across processes. Checks before and after bounded reads detect observable changes; they do not provide a filesystem transaction, protection against arbitrary hostile concurrent replacement, or a guarantee against later mutation. No result here establishes session recovery, current process liveness, restored authority or task acceptance.

## Package directory and artifact checks

`test:package-entry` creates a real Bun package archive and checks its exact path/byte/hash inventory before extracting it outside the checkout. A missing-launcher mutation must be rejected. It separately checks the checkout package directory, the extracted artifact running a task through execution/insufficient verification/preview, and the artifact without host configuration. A provider-only baseline identifies the native tool set; it is not an additional product scenario.

The artifact observer imports the selected artifact's task-owner port, and the actual execution record identifies the packaged launcher. The suite preserves source/binary and archive manifests, actual calls/content, run records and file evidence outside runtime cleanup. These are deterministic package wiring checks; they do not install into a personal profile, publish a release, call a paid model, or establish human approval.

## Bounded real-model journey

A separate DeepSeek Flash sample used three genuine messages in one OMP session: produce a file, cancel that task while preserving its files, then produce a different file under a new task identity. Independent reads confirmed both selected artifacts, their actual delivery paths, preserved prior bytes, and the reported active/cancelled states. Both verification calls returned no-contract `insufficient`; those receipts contain no candidate-byte or semantic validation. File correctness came from independent physical checks. No task was accepted.

The original frozen grader passed 23 of 25 checks. Its two failures involved call attribution, including optional-null removal and malformed-argument projection. Original results and failed calls are retained separately from subsequent protocol diagnosis. The sample was not error-free: it had five tool errors, plus a nested `cat` failure that the outer shell command did not propagate. The model recovered to correct artifacts, but this is not a strict zero-error pass or a general reliability estimate.

Observed usage was 22 provider requests, 24 tool calls, approximately 159 seconds and US$0.0242 according to OMP session statistics. The source remained frozen; OMP exited normally without fallback signals, and the recorded script/watchdog processes were gone. The native tool subset was explicitly selected for this sample, so it does not establish complete default-catalog coverage, an account-wide cost limit, arbitrary descendant cleanup, recovery, or genuine human approval.
