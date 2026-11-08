# Architecture

`omp-agent` extends OMP with explicit task ownership, bounded execution, verification, and artifact delivery. OMP retains the model and tool invocation loop.

## Components

| Component | Responsibility |
| --- | --- |
| Task owner | Maintains task identity, requirement revisions, conversation binding, and capability admission |
| Task entry | Connects actual OMP input and session events to task control |
| Execution adapter | Runs bounded Python or Bun scripts with authorized inputs and records process completion facts |
| Candidate registry | Registers execution artifacts and checks their origin, identity, size, and digest |
| Verification service | Applies host-configured contracts and trusted checks to registered candidates |
| Delivery service | Creates read-only artifact copies, requirement records, and a manifest; checks files before returning a preview |
| Job adapter | Exercises submission, reconciliation, and cancellation semantics against an explicitly configured service |

The default package entry is a managed integration probe. The task, execution, and job entries are loaded explicitly in isolated test environments.

## Task and execution boundaries

Task identity and requirement sources come from host-observed conversation events. Model arguments can select existing objects and provide optimistic version guards; they cannot create host authority.

A requirement amendment increments the task revision. Capabilities check that their task and revision still match before acting. Session or branch navigation can detach the task binding, preventing new mutations and execution through an outdated context.

Local execution uses host-selected paths, runtimes, input handles, time limits, and output limits. Candidates retain the source, input, and output identities needed for later checks. A process exit code alone does not establish that a task meets its requirements.

## Verification and delivery

A verification contract is bound by the host. The model cannot select a weaker verifier, change thresholds, or supply its own successful receipt. Verification reports pass, fail, or insufficient coverage and retains condition-level evidence.

Delivery selects registered candidates from a particular run. The service checks the original evidence, creates separate read-only files, and checks the copied bytes. A delivery includes the requirement sources and a manifest. Repeated requests check the existing files before returning the same bundle.

Delivery preview and final task acceptance are distinct. The published experimental interface currently exposes verification and preview; a successful preview does not imply final acceptance.

## Current limits

Candidate and delivery registries are process-local. The project does not yet provide cross-process task recovery, a production job backend, or a general installation profile. Filesystem checks describe the observed local state and do not claim transaction isolation against arbitrary external processes.
