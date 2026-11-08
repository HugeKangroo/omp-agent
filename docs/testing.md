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
```

`check` runs TypeScript checks and unit tests. The other commands start actual OMP processes with temporary profiles and local deterministic test providers or services. They do not call a paid model. `OMP_COMMAND` can override the OMP executable.

## What the tests establish

- Task ownership, requirement changes, session binding, and capability admission.
- Bounded local execution, watchdog behavior, cancellation, and completion accounting.
- Candidate provenance, immutable verification contracts, and honest coverage reporting.
- Delivery file identity, exact byte checks, bounded previews, and idempotent reads.
- Job submission reconciliation when responses are delayed, interrupted, or lost.

Deterministic integration tests establish interface and control behavior. They do not measure arbitrary task success rates or independently establish production readiness.

## Accepted baseline

The current published delivery-preview baseline passed type checking and 230 unit tests. Separate review covered 46 direct scenarios, 99 delivery integration assertions through actual OMP, and 6 execution integration tests. These figures refer to that specific baseline; they are not a general reliability percentage.

New changes must pass the applicable checks before their behavior is listed as implemented in the release notes. Failed checks remain available for diagnosis and regression work.
