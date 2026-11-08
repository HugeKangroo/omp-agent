# Release notes

## Experimental model submission and inspection

Added `agent_deliver submit` and `inspect` to the opt-in delivery interface. The model selects an existing delivery with exact task and revision guards. Submission reuses the host acceptance service; inspection is read-only. Both return bounded JSON in tool content, separating operation results, current visibility, historical acceptance, and file integrity.

The acceptance service now uses the immutable store port captured from the actual owner, including when OMP loads the task entry separately from the execution composition. Late actions preserve accepted terminal state. Late abort, context loss, or entry disposal withholds unavailable paths without reversing a completed commit.

Added `bun run test:delivery` for actual OMP integration using a local deterministic provider. Human review, continuous-task operation, durable recovery, and a daily-use installation profile remain pending. The default package entry is unchanged.

## Experimental host acceptance

Added an opt-in host acceptance API using the existing task, execution, verification, and delivery services. It requires complete host-defined semantic coverage and matching current evidence, reserves acceptance before asynchronous reads, and installs a private record once before committing the terminal task state.

Repeated submission retains the same acceptance identity. Postcommit notification failures and later file damage do not erase the completed operation. Uncertain outcomes remain explicit and prevent unsafe retries. Queries check current context visibility independently of historical acceptance.

Configuration requires a distinct explicit `acceptanceRoot` together with `deliveryRoot`. At this earlier baseline, model submit/inspect, human review, continuous-task operation, durable recovery, and a daily-use installation profile were pending. The default package entry is unchanged.

## Experimental delivery preview

This earlier baseline provided:

- Conversation-bound tasks with requirement revisions and cancellation.
- Bounded Python and Bun execution with explicit input handles and candidate registration.
- Host-configured verification of registered candidate sets.
- Optional delivery export to an explicit host directory, with real file paths, requirement records, a manifest, and bounded previews.
- Repeated delivery reads that recheck actual file identity and bytes.

The default package entry remains an integration probe. Model submission was added in the later increment above. Continuous-task operation, durable recovery, and a daily-use installation profile remain pending.

See [Architecture](architecture.md) for component boundaries and [Testing](testing.md) for reproducible checks.
