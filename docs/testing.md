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
```

`check` runs TypeScript checks, unit tests, and `test:human-review` in a separate Bun process. The isolated human-review suite substitutes review transport while exercising actual execution, verification, delivery, and record installation. Component checks separately exercise display logic and context guards. It is an engineering simulation, not evidence of real user approval.

The other commands above start actual OMP processes with temporary profiles and local deterministic test providers or services. They do not call a paid model. `OMP_COMMAND` can override the OMP executable.

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

The reviewed product source passed type checking, 317 unit tests (3,061 assertions), and 15 isolated human-review tests (155 assertions). Independent component checks covered 26 scenarios and a reentrant context-change regression. Existing actual OMP execution and delivery suites provide separate evidence for entry composition, real files, and process accounting.

All eight native review scenarios have passed after fixture corrections. The matrix covers default-off and invalid configuration, initial Enter, Escape, small-window resize, complete-content acceptance without an automatic contract, acceptance with valid partial automatic coverage, and the actual five-minute deadline. Positive captures are independently checked against full requirements, file bytes, source/input identities, and completed terminal paints. Offline mutations remove or alter evidence to check that the grader rejects incomplete results.

The native runner is deliberately inert by default:

```sh
bun run test:human-review-native --help
bun run test:human-review-native --required
```

Execution requires an explicit frozen-file manifest and a selected case; the deadline case takes five minutes. The runner uses isolated profiles and a deterministic local provider, preserves failures, verifies process cleanup, and never treats automated keys as genuine human approval. Raw terminal output is not a screenshot. Unicode layout follows the tested OMP helpers; these checks do not independently validate terminal fonts or every Unicode sequence. Human readability and an actual user decision remain pending separately.

Results apply to the reviewed source and stated environment. They are not general reliability percentages. Fixture repairs retain their original failed captures and are distinguished from product defects. Any new behavior must pass its applicable checks before being described as validated.
