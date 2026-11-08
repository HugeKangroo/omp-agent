# Release notes

## Operation-level capability guidance

Daily guidance now asks the model to check whether the operations required by a task are supported before choosing an execution route. An available runtime does not imply that every operation is available. Known restrictions should not trigger trial runs or tool switching to evade them; unknown facts may be investigated through authorized, supported means. If no compliant route exists, an honest response explaining non-execution remains valid.

This is an advisory correction following a retained real-model failure. It changes no executor policy, schema, permissions, model selection or acceptance behavior. Type checking, 38 focused tests and three real OMP cases passed; those checks establish guidance delivery, not guaranteed model compliance.

## Advisory daily workflow guidance

The real daily composition now adds one fixed, model-visible advisory message during ordinary main-agent prompt preparation. It describes the existing workflow: establish a managed task before dependent calls, generate deliverable files through `agent_execute` as registered candidates (including prose written by a task-local Python or Bun script), use only authorized input handles, verify the exact returned selection, preview delivery for a readable path, and report generated, verified and accepted coverage honestly. Native workspace writes and shell self-tests are stated not to be managed candidates or receipts.

This is advisory only. It does not create tasks automatically, grant authority, force managed tools, change verification or acceptance semantics, or alter human-review, policy, budget, native-tool or shutdown defaults. It is absent for subagents and after disposal. The new custom type is trusted as a host-owned control artifact so its own persisted message does not close the current user-turn authority window; the content remains advisory.

Validation passed 50 focused unit tests and 3 actual OMP daily cases with 383 assertions, including provider-visible guidance and task creation after its persisted message. A bounded real-model document task reached managed generation, exact candidate selection, insufficient verification and a readable delivery preview. Four recovered tool errors and unsupported assumptions in the report remain recorded: the execution chain passed, while full content-quality acceptance did not. A separate unsupported-runtime sample honestly reported non-execution, but its original automated attribution failure also remains. Guidance does not guarantee model compliance or overall task correctness.

## Real-model journey validation

Recorded a bounded three-message file-task, cancellation and new-task journey through the configured entry. Independent checks confirmed actual artifact bytes, delivery paths, preserved previous files and truthful insufficient/active/cancelled reporting. Original automated attribution failures and recovered tool errors remain recorded; this is not a strict zero-error pass, semantic host acceptance or full Alpha validation.

Documented the observed macOS Python override limitation: the system `xcrun` forwarding path can fail inside the execution sandbox even after a successful version probe. The configured entry already defaults to the direct interpreter. This increment changes documentation only.

## Default package entry

The package now selects `src/daily-entry.ts` and includes `scripts/isolated-exec.py` alongside all runtime source files. It can be explicitly loaded by directory from a checkout or a locally packed and extracted archive. Missing `OMP_AGENT_CONFIG` leaves managed tools disabled without falling back to the old probe.

Added a package inventory gate and actual OMP checks for checkout loading, artifact execution and missing configuration. The artifact uses its own task-owner module and packaged launcher. The package remains private and retains its prerelease version; this change does not install a profile, publish a release, add recovery, or establish human acceptance.

## Explicit personal entry

Added `src/daily-entry.ts` for explicit source-checkout loading with one strict `OMP_AGENT_CONFIG` JSON file. It composes task management, local execution, verification and delivery around one owner, preserves ordinary OMP tools and model configuration, and refuses to replace an existing managed owner.

Configuration fixes the workspace, authorized input files, private state root and optional runtime paths. Human review remains off by default and uses the existing mechanism only with the exact `local-main-tui-v1` option. No automatic semantic verification contract is installed; candidate generation and insufficient coverage are not task acceptance.

Each startup creates a fresh instance. Successive tasks can share it, while prior instance files are preserved without restoring task authority or history. Failed initialization leaves managed handlers inactive. This change does not switch the package's default entry, publish an installation package, add cross-process recovery, or expand guarantees to unrelated native tool calls. Genuine human-use acceptance remains separate.

## Historical accepted inspection (B3-B1)

`agent_deliver inspect` now reads an exact retained accepted target independently of the current task. After a later genuine message starts a new current task, selecting the earlier accepted task by exact task id, revision and delivery returns that target's accepted reference, record integrity and intact delivered files; the existing top-level current task fields and `visibility` continue to describe the actual current task. Target and current facts are reported separately, so a current change, refusal, record damage or unavailable final branch cannot substitute the current task for the requested history or relabel accepted history as unaccepted.

Mismatched selectors are refused before the record is read. Every context getter or awaited bundle check is followed by pure retained-target/reference/owner checks for the last actual subject; if that final eligibility is lost, the prior record identity, files and paths are withheld together. Unknown-installation facts also require the exact selected task and final reachable session/anchor; loss of visibility withholds old identifiers without clearing the stored unknown outcome. Submit and `request_review` remain current-only. This is in-process retained history only: it does not add restart recovery, disk rebuild/scanning, historical re-execution, a daily entry or a package-default switch.

## Continuous task core and exact task guards (B3-A)

Added in-process task continuity to the experimental task owner. After the current task is accepted or cancelled, a later genuine user message in the same workspace/session may create a new task; an active task is never replaced implicitly. The owner retains up to 128 tasks and 4096 message-anchor/control replay entries without silent eviction, keeps terminal identity and requirement ledgers immutable, and exposes bounded read-only history summaries plus explicit historical inspection. History is not durable cross-process recovery.

`agent_task revise` and `cancel` now require `expectedTaskId` together with `expectedTaskRevision`, and `inspect` may use the same pair to read one visible retained task. `agent_job submit` and `query` require the same exact selector; a query checks it before lookup or transport. Shared owner admission and `admitPublishedTask` accept only immutable task id+revision guards, freeze committed admission facts, and revoke an admission if notification changes the current task without undoing the committed count. Task-specific owner events route by task id.

A host-generated task id that is already retained is rejected before any commit instead of overwriting the old task. Authority resolution returns a candidate anchor without mutating the live grant; the resolved anchor is written only in the atomic commit after every callback and a pure final state/id/capacity check. The entry rechecks that its captured owner is still the published owner after actual context getters, audit and preflight, so a late replacement cannot mutate or disclose the old owner. Shared admission additionally revalidates final branch reachability and any newly created acceptance reservation before the consumer acts. Job submit and query run their exact-target, status, binding, reservation and hazard check after the last host clock/record callback and immediately before transport; a refused dispatch keeps honest `not_dispatched` facts and the committed task admission.

Capacity, guard, replay and preflight failures leave the prior current task, grants, counters and indexes intact; postcommit notification failures preserve committed identity. Unknown acceptance-installation hazards still block starting another task and are never converted into a terminal state. Automatic v1 and human/hybrid v2 record semantics are unchanged. This increment does not add a daily entry, package-default switch, durable recovery, historical delivered-file retrieval (B3-B), or a real OMP/model journey (B3-C); genuine human review remains deferred to the completed personal trial.

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
