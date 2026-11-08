# Release notes

## Experimental local review component

Added a default-off main-agent TUI review component and `agent_deliver request_review`. The exact `OMP_AGENT_HUMAN_REVIEW=local-main-tui-v1` setting enables the experimental path when delivery and acceptance are configured. Requests select an existing delivery and task revision; the model cannot approve.

The component displays complete frozen requirements and selected text files, defaults to rejection, and requires matching completed paints before a separate selection and confirmation. Resizing resets coverage; pasted input cannot approve. Context changes, cancellation and the fixed five-minute deadline invalidate pending reviews. Display escaping includes TAB; original bytes and hashes stay separately bound.

Host, component, and eight native integration scenarios have passed, including real deadline expiry and late-input rejection. Original fixture failures were retained and the affected cases rerun after targeted repairs. Genuine human review remains pending. Automatic acceptance keeps its v1 evidence rules, and partial automatic coverage keeps its original insufficient outcome. The default package entry and daily-use installation status are unchanged.

## Human review host mechanism

Added a default-off host mechanism that binds a review to exact requirements, selected delivery bytes, and a fixed deadline. Human/hybrid v2 records preserve the original automatic receipt; automatic acceptance continues to use v1. Invalid or failed configured checks cannot be bypassed by a review decision.

This earlier host-only increment used an isolated simulated review transport over the real execution and acceptance chain. The local UI and model request action were added in the newer increment above. Simulated approvals do not establish a human decision.

## Experimental model submission and inspection

Added `agent_deliver submit` and `inspect` to the opt-in delivery interface. The model selects an existing delivery with exact task and revision guards. Submission reuses the host acceptance service; inspection is read-only. Both return bounded JSON in tool content, separating operation results, current visibility, historical acceptance, and file integrity.

The acceptance service now uses the immutable store port captured from the actual owner, including when OMP loads the task entry separately from the execution composition. Late actions preserve accepted terminal state. Late abort, context loss, or entry disposal withholds unavailable paths without reversing a completed commit.

Added `bun run test:delivery` for actual OMP integration using a local deterministic provider. At this increment, human review, continuous-task operation, durable recovery, and a daily-use installation profile were pending. See newer entries above for subsequent review work. The default package entry was unchanged.

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
