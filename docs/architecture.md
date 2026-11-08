# Architecture

`omp-agent` is an OMP plugin for individual workflows. It adds explicit task ownership, bounded execution, verification, and artifact delivery while OMP retains the model and tool invocation loop.

## Components

| Component | Responsibility |
| --- | --- |
| Daily entry and host configuration | Validates one explicit workspace/input configuration and composes one task owner with execution, verification, delivery and acceptance services |
| Task owner | Maintains task identity, requirement revisions, conversation binding, and capability admission |
| Task entry | Connects actual OMP input and session events to task control |
| Execution adapter | Runs bounded Python or Bun scripts with authorized inputs and records process completion facts |
| Candidate registry | Registers execution artifacts and checks their origin, identity, size, and digest |
| Verification service | Applies host-configured contracts and trusted checks to registered candidates |
| Delivery service | Creates read-only artifact copies, requirement records, and a manifest; checks files before returning a preview |
| Acceptance service and record store | Rechecks complete host evidence, reserves task acceptance, installs a record once, and separates commit facts from current visibility and file integrity |
| Local review adapter and component | Displays frozen requirements and selected text files in the main-agent TUI, with default rejection and complete paint coverage before an explicit decision |
| Job adapter | Exercises submission, reconciliation, and cancellation semantics against an explicitly configured service |

### Explicit configured entry

The default package entry is `src/daily-entry.ts`. OMP reads `package.json#omp.extensions` when a source checkout or an extracted package directory is explicitly loaded. `src/extension.ts` remains an explicitly selected integration probe. The daily entry uses the absolute JSON path in `OMP_AGENT_CONFIG`. The JSON is the source of this entry's workspace, input whitelist, state root, optional runtime paths and human-review setting. It does not accept credentials, endpoints, model-selected paths or per-task policy overrides. Separately loaded experimental entry environment variables do not configure this composition.

The canonical workspace must match the actual OMP launch workspace. Inputs are explicit regular files outside managed internal state. Initialization validates configuration, composes one owner and one execution factory, and checks the actual persisted state and readiness audit before enabling managed calls. An existing owner is preserved rather than replaced. Partially registered handlers and tools remain inactive if initialization fails; OMP event registration is not described as reversible unregistration.

Each start creates a fresh private instance beneath the configured state root, with distinct execution, delivery and acceptance directories. Successive tasks share that instance. Prior files remain intact, but the entry does not scan them to restore task authority, candidates or history after restart.

The distribution includes the isolated execution launcher and the lazy human-review runtime files. Host configuration and runtime state remain outside the package. Missing configuration leaves managed handlers disabled while ordinary OMP tools remain available.

Human review is off unless the JSON explicitly contains `"humanReview": "local-main-tui-v1"`. No automatic semantic contract is installed by this entry. Insufficient verification coverage stays insufficient; final acceptance still requires the existing acceptance mechanism and its evidence. The entry preserves ordinary OMP capabilities and model selection. Its guarantees apply to managed calls, not to every native or third-party tool side effect.

## Task and execution boundaries

Task identity and requirement sources come from host-observed conversation events. Model arguments can select existing objects and provide optimistic version guards; they cannot create host authority.

A requirement amendment increments the task revision. Capabilities check that their task and revision still match before acting. Session or branch navigation can detach the task binding, preventing new mutations and execution through an outdated context.

Local execution uses host-selected paths, runtimes, input handles, time limits, and output limits. Candidates retain the source, input, and output identities needed for later checks. A process exit code alone does not establish that a task meets its requirements.

## Verification and delivery

A verification contract is bound by the host. The model cannot select a weaker verifier, change thresholds, or supply its own successful receipt. Verification reports pass, fail, or insufficient coverage and retains condition-level evidence.

Delivery selects registered candidates from a particular run. The service checks the original evidence, creates separate read-only files, and checks the copied bytes. A delivery includes the requirement sources and a manifest. Repeated requests check the existing files before returning the same bundle.

Delivery preview and final task acceptance are distinct. The experimental model interface supports verification, preview, submission, and accepted-file inspection. Submission selects an existing delivery and task revision; it cannot supply a receipt, verdict, confirmation flag, or arbitrary path. An explicitly configured acceptance service rechecks complete semantic coverage, a matching current pass receipt, task revision, and actual file identities. It installs a record without replacing an existing target before transitioning the owner to accepted. Late notification or maintenance failures cannot reverse a completed commit; an uncertain outcome remains unknown and blocks further mutation.

The record-store port comes from the actual task owner and is captured once by the acceptance service. This preserves the issuing store across OMP entry factories and imported modules. Record installation remains a fixed owner operation.

Submission and inspection return bounded JSON in model-visible tool content. Operation commitment, current task visibility, historical acceptance, and file integrity have separate fields. Read-only inspection creates no new acceptance. Later damage does not erase historical acceptance, and a successful preview alone does not imply acceptance.

Late cancellation, revision, or execution cannot reopen an accepted task. A context change, abort, or disposal during a call can withhold current information and file paths while preserving the original operation result. Historical execution and verification records retain the facts recorded when they were created.

## Optional human review mechanism

The host mechanism for human review is default-off and uses the same task owner, acceptance reservation, record-store port, and fixed commit path. A review prepares a complete bounded display of the current requirements and selected UTF-8 delivery files. The original bytes and display digest are bound separately. The deadline includes preparation and waiting; cancellation, revision, context loss, or file changes invalidate the pending review.

Human and hybrid records use an explicit v2 schema. Automatic acceptance continues to write v1 records. A valid partial automatic check retains its original insufficient outcome; a human decision may supplement uncovered semantics, but cannot override a failed or invalid configured check. Private verification issuance facts distinguish valid partial evidence from malformed verifier results without changing the historical receipt or model-visible verification result.

The fixed local adapter uses OMP public custom UI and terminal helpers. The experimental entry enables it only with the exact `OMP_AGENT_HUMAN_REVIEW=local-main-tui-v1` setting and configured delivery and acceptance directories. The model can request review of an existing delivery with exact task guards; it cannot approve. Only the current main-agent TUI context can display a review.

The component defaults to Reject and counts matching completed paints rather than render calls alone. Resizing resets page coverage and selection; pasted input cannot approve. Task or context changes, cancellation, the fixed five-minute deadline, and disposal invalidate a pending review. TAB and control characters are escaped for display while original file bytes remain independently bound.

The documented native integration scenarios passed using automated terminal input, including the actual fixed deadline. Genuine human review is pending. Simulated transport and automated terminal input are engineering evidence, not a human decision.

## Current limits

Candidate and delivery registries are process-local. The project does not yet provide cross-process task recovery, a production job backend, or a formally released version. Filesystem checks describe the observed local state and do not claim transaction isolation against arbitrary external processes.
