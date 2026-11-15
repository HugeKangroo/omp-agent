# Release notes

## Native child snapshot and text primitives

Added `src/native-child-text.ts`, with pure selected Role-frame and autoloaded Skill verifiers. Full selected body comparison uses an injected native renderer and checks the known unique Role/Coop/Completion shape, exact Skill name/path/content/provenance/count/order, and bounded extras. It performs no IO, prompt mutation, authority or dispatch; callers must act on false results. Nineteen focused tests pass.

Added `loadNativeChildDefinitionSnapshot` in `agent-definition.ts` with 7 tests (31 snapshot tests total). It uses the same bounded loader and frozen version but accepts only native-child `blocking:true`/`structured:false` extras plus explicit `tools`/`model`; the main loader still rejects those fields. This validates the requested declaration, not effective host-profile enforcement. Product instance entry, registry and result binding remain unimplemented.

One bounded fixed-profile fixture run used 3 native parents and 3 children, 7 provider ingress records, 3 task tool calls, 0 child tool calls and about 6 seconds. Positive Role/Skill full text passed with an unchanged prompt. Body drift was refused four times in the same child before lifecycle failure, and Skill drift was refused in context with the lifecycle aborted and parent result cancelled; both had zero child provider ingress. Native still-live result text is not provider-dispatch evidence, and shutdown observed during EOF cleanup is not proof of immediate refusal-time termination. All parents exited normally with exit 0 and gone process groups. Internal attempted-turn counts are not provider requests. This is pure verifier fixture integration, not child snapshot entry integration or real-model quality; older failures remain open.

Scoped settings were read in the same cases through `findScopedSettings()` and `registry.lookup().get(instance)`: same-cwd parent and child received distinct objects, and parent `compaction.midTurnEnabled=false` versus native-child true isolated correctly. The global settings singleton was unused. This proves a read port, not product profile enforcement, and changes no global configuration, default entry or default policy. Scope is initial text only, without lifecycle, recovery, late-result or artifact isolation or a full D2 claim. The current check passes type checking, 615 unit tests and 15 human-review simulations; the prior 589-test result remains historical.

## Native child compatibility note

Documented bounded compatibility evidence on the fixed macOS/OMP 18.20.2/Bun 1.4.0 probe: one RPC parent, two native same-definition children, 6 local deterministic provider requests, 4 all-session tool calls and shutdown of all 3 sessions. The record establishes the native lifecycle parent-call → child-session link, retained prompt segments with one instance marker, per-child input/model/Skill/tool set and matching parent results. Spawn keys differed from child ids, so association relied on native lifecycle records rather than names, order or format guesses.

This is documentation of a compatibility seam only. The package default, product entry, main-only definition binding and OMP scheduling are unchanged, and no instance state isolation is added. Complete instance binding, version changes, cancellation, late delivery, artifact isolation and quality remain unaccepted, no all-real-model pass is claimed, and earlier quality failures remain recorded. The local fixture provider performed no network IO; no process-wide zero-network claim is made. See [Architecture](architecture.md) and [Testing](testing.md).

## Optional main-session Agent definition entry

Added `src/defined-native-entry.ts`, an optional explicitly loaded entry that binds one Agent Markdown file to the current main session. It uses the existing OMP kernel, native parser and active Skill catalog; the package default remains `daily-entry.ts`. One absolute `--agent-definition` path is read at startup and preflighted, then the definition and selected Skill initial text are frozen under a stable snapshot version. Only `name`, `description`, `tools`, `model` and `autoloadSkills` are accepted. Tools may narrow but not widen the host set, one exact host-resolved model selector is allowed, and Skill names must be exact. Names, roles and definition text grant no authority.

Binding installs failure gates before asynchronous native imports. Missing or invalid dependencies, unknown identity, live identity/config drift, navigation, a managed TaskOwner conflict or an invalid definition block ordinary input, prompts and tools. `/agent-definition-status` and `agent_definition` are read-only diagnosis; they do not repair or reload. Changing a definition requires a new OMP process. Freeze scope is initial definition and selected Skill text only; scripts, templates and `skill://` resources are not frozen. Abort may leave native messages queued; only a `hasPendingMessages` boolean may be reported, not exact counts, and no settlement or recovery is guaranteed.

On the final product bytes, `bun run check` passed type checking, 589 unit tests (44 new: 24 snapshot/preflight, 20 binding) and 15 human-review simulations. The package dry run contained 84 files with private fixtures excluded. Actual product RPC integration used four parents, 14 local-provider requests and 10 tool calls, with two definitions differing in model/tool sets. Old text remained frozen in-process, a new process observed the new version, and a missing Skill blocked ordinary RPC and extension-origin messages. The first run failed on a non-literal dynamic-import specifier; after the literal-import repair, the counted run completed with normal cleanup. That counted RPC run predates the later narrow read-only failure-status command exception, so it did not exercise the final product bytes; the focused unit tests and the final TUI check cover that exception. Its original result retained a grader expectation error on the exact `PromptDroppedError`; an independent offline regrade passed with no extra run. The final-bytes TUI check observed two parents, one local provider request and zero tool calls with normal and failed-binding status and normal exits. Its original valid-case parser failure remains recorded; the offline correction uses whitespace-normalized status extraction from the original raw bytes, not byte-exact JSON, and independent review classified the engineering path as passing. No human-UI claim follows.

The latest real-model smoke remains mixed, not a full pass. Definition B's output artifact and converter behavior passed a bounded check, including expected output, readback and unchanged input; its final reply still failed the strict textual content check because a record-count statement was ambiguous about header inclusion, and B's fixture finalizer crash and reconstructed-output caveat remain recorded. Definition A's original run was aborted by the test supervisor after it misclassified a legal `agent_work inspect`; that original evidence remains. A single supplemental A session, with the same definition, prompt and input bytes and the frozen product, completed and settled; its bounded read-only summary was factually correct, with one malformed `agent_work inspect` call rejected before recovery. The same kernel therefore demonstrated bounded definition behavior across a read-only summary and an actual converted file, but this is not an all-real-model-quality PASS, does not clear the earlier source-grounded content FAIL, and is not human acceptance or a general quality claim.

Scope remains fixed macOS/OMP 18.20.2/Bun 1.4.0, main-session only, one explicit binding, mutually exclusive with a managed TaskOwner; multi-instance, delegation and Flow support remain unavailable. This entry applies no policy automatically and changes neither the default entry nor default policy.

## Native Agent definition compatibility documentation

Documented fixed-version compatibility evidence for native OMP Agent Markdown, task subagents and project Skills on OMP 18.20.2. A native project definition can be selected through `task`, with observed definition body, model and tool delivery; an explicitly autoloaded project Skill body reached the selected child. The main `--append-system-prompt` path remains host prompt input, not an Agent selector; at that point the observed native CLI had no main-session definition selector.

The record also captures version-specific negative behavior: a missing Agent is rejected before child creation, an unknown model fails after the child starts without a successful fallback, unknown tools and autoload Skills are silently skipped, and a project definition shadows a user duplicate. The later optional explicit-path entry above implements preflight and initial-text snapshot binding; native discovery, collision and failed-child behavior remain unchanged.

This entry documents bounded host compatibility only. It added no product entry at that point, and it does not supersede the retained content-quality failure. The package default, explicit native observation entry and their scopes were unchanged. See the newer definition entry above, [Architecture](architecture.md) and [Testing](testing.md).

## Experimental native work observation entry

Added `src/native-entry.ts` for explicit loading alongside OMP's native model and tool loop. It provides proportional checking guidance, bounded `agent_work inspect/report` observations, and at most one advisory finalization reminder per work. Ordinary work completion is distinct from strict managed acceptance.

Reports separate model claims, observed tool results and file digests. Conflicted or reused call identities and stale contexts cannot provide current evidence. The entry adds no native execution permissions, managed owner, sandbox, semantic verifier or restart recovery. The package default remains `daily-entry.ts`; use the native entry independently. Validation details and limitations are recorded in [Testing](testing.md).

## Frozen-candidate method transfer validation

Recorded one independently selected method task after freezing the generic candidate, tools, guidance, model and budgets. Actual generated content, numerical checks, provenance, final paths and cleanup passed bounded independent review. Five recovered errors remain, so strict zero-error acceptance failed; host verification remained `insufficient` and did not accept the task. This documentation-only increment does not change defaults or establish full Alpha readiness. See the testing record for scope, usage and wording limitations.

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
