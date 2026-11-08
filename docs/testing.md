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

`check` runs TypeScript checks and unit tests. The other commands start actual OMP processes with temporary profiles and local deterministic test providers or services. They do not call a paid model. `OMP_COMMAND` can override the OMP executable.

## What the tests establish

- Task ownership, requirement changes, session binding, and capability admission.
- Bounded local execution, watchdog behavior, cancellation, and completion accounting.
- Candidate provenance, immutable verification contracts, and honest coverage reporting.
- Delivery file identity, exact byte checks, bounded previews, and idempotent reads.
- Host acceptance reservation, exact evidence checks, idempotent record installation, uncertain outcomes, and postcommit visibility.
- Model-visible submit/inspect results, current versus historical acceptance, and rejection of late actions after acceptance.
- Actual OMP entry-factory composition: the delivery suite separately loads the task entry and execution composition, then checks the installed record and real files. It also covers delivery without acceptance configuration and incomplete semantic coverage.
- Job submission reconciliation when responses are delayed, interrupted, or lost.

Deterministic integration tests establish interface and control behavior. They do not measure arbitrary task success rates or independently establish production readiness.

## Accepted baseline

The model submission and inspection baseline passed type checking and 274 unit tests (2,788 assertions). Five actual OMP delivery tests (233 assertions) and six execution integration tests (112 assertions) also passed on the reviewed source. The delivery suite checks cleanup after a deliberate assertion failure following a completed execution, and retains evidence when a completed run's watchdog identity is deliberately made unknown. These fixture-failure tests do not simulate a live unarmed watchdog; the execution suite separately covers host termination and watchdog behavior.

The native delivery regression checks a module boundary that unit tests alone missed: records prepared through a separately loaded execution composition must be accepted by the actual task owner's issuing store. These bounded results are not a general reliability percentage.

New changes must pass the applicable checks before their behavior is listed as implemented in the release notes. Failed checks remain available for diagnosis and regression work.
