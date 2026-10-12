# Workflow Sessions (Experimental)

Workflow sessions are durable, non-conversational sessions controlled by a
versioned state machine. They can be started directly through the SDK or API,
or as children of conversational sessions through `spawn_workflow`.

The design originates in
[PilotSwarm issue #28](https://github.com/microsoft/PilotSwarm/issues/28).

## Design Decisions

These boundaries are intentionally difficult to change after definitions and
executions exist in production.

### Duroxide history controls execution

The workflow controller derives its cursor, execution sequence, durable waits,
timers, and transitions from Duroxide orchestration history. It never reads the
CMS projection to decide what executes next.

CMS stores authoritative admitted executions, accepted results, terminal
completion, and a rebuildable projection for APIs and UI. Rebuilding or losing
the projection must not change control flow.

### Definitions are immutable packages

Registration compiles authored YAML and snapshots the complete package into a
content-addressed artifact. The persisted definition pins:

- source and compiled-manifest hashes
- package artifact hash
- transition module and package hashes
- immutable source provenance, including a Git commit when applicable

Workers verify those identities before execution. Persisted definitions contain
data, not JavaScript functions or machine-local paths.

The default Git resolver accepts only allowlisted public repositories. A
deployment may inject a `WorkflowPackageResolver` for private source systems,
but PilotSwarm still owns compilation, package verification, persistence, and
cleanup.

### Workflow agents are registered once and pinned per run

A workflow package can declare its agents, skills, tools, and MCP configuration
in `plugin.json`. Registering a workflow definition publishes that agent package
through PilotSwarm's normal package registry and binds each compiled agent state
to the resulting package identity. Deployments do not need to copy workflow
agents into portal or worker images, and callers do not make a second agent
registration request.

The binding deliberately combines live updates for future runs with stable
behavior for an admitted run:

- registration publishes the package contents and rejects workflow agent names
  that the package does not declare
- starting a workflow resolves each bound package's current active version
- the resolved package version is persisted in the run's durable plan and in
  each child session
- retries, worker replacement, and later states in that run continue using the
  same version, even if a newer package version becomes active
- a later workflow run may resolve the newer active version

This differs from a normal conversational session, whose later turns resolve
against the live active package version. Workflow execution needs a stronger
replay boundary because changing an agent, ambient skill catalog, tool, or MCP
configuration mid-run can change state outcomes and therefore control flow.
The complete declared package remains the versioned capability boundary;
explicit `skills:` entries are not treated as a complete dependency closure.
An agent's declared skills are composed from the same pinned package version,
and `load_skill` for a pinned workflow child resolves against that version's
package skill catalog rather than the worker's live package catalog.

The durable binding records package and version identities, not deployment
credentials or source-system URLs. Workers obtain the exact artifact from
PilotSwarm storage, so execution remains independent of GitHub, Azure DevOps,
or any deployment-provided source resolver.

### Transition code is explicit and replay-safe

Every executable state references a synchronous, package-relative transition
export with declared target states. Inline transition syntax and asynchronous
transition handlers are rejected.

Transition functions receive immutable workflow inputs, the accepted state
result, prior state outputs, and execution history. They return only an
`advance` directive. This keeps orchestration decisions deterministic and makes
transition code independently identifiable.

### Domain behavior belongs behind providers

PilotSwarm defines generic `action` and `observed-condition` states. Deployments
register concrete providers on workers; workflow packages reference providers
by name.

Every provider request includes the stable tuple:

```text
workflowSessionId / stateId / executionSequence
```

Action providers must use that identity as their idempotency key. An activity
may be re-dispatched after a worker dies after applying its side effect but
before returning its result.

Observed conditions return either `pending` with an optional retry delay or a
declared completed outcome. Polling uses durable timers, so replacing a worker
does not restart the accepted action or lose the wait.

### Execution facts precede transitions

For every non-terminal state, the controller:

1. records the execution and external wait details
2. obtains an agent result, question answer, action result, or observation
3. validates and durably accepts the declared outcome
4. executes the pinned transition

Transitions consume the accepted result, not an uncommitted provider response.
Question queues are execution-specific, so duplicate answers cannot be consumed
by a later question.

### Logical identity is separate from request idempotency

Definitions may declare a primary key from required scalar inputs. Workflow
start admission enforces two independent identities:

- caller-scoped `idempotencyKey` for request retries
- `(definitionId, primaryKeyHash)` for logical duplicate detection

Explicit reruns create a new attempt while preserving the logical workflow
identity and owner.

### Orchestration versions preserve compatibility

Registered definitions execute through `workflow-session-v1@1.0.0`. The
pre-existing in-memory graph path remains available in that version so durable
history created before registered definitions continues to replay.

## Supported State Types

| Type | Durable behavior |
|---|---|
| `agent` | Starts a replay-stable child session and waits for a bound structured result. |
| `question` | Persists prompt, context, authorization, and outcomes before waiting for an execution-specific answer. |
| `action` | Invokes a registered provider with a stable execution identity. |
| `observed-condition` | Polls a registered provider through durable timers. |
| `terminal` | Persists the final outcome and optional projected result. |

The controller rejects undeclared outcomes and targets and stops graphs that
exceed 100 transitions.

## Registration and Execution

Administrators register Git-backed definitions through:

```text
POST /api/v1/management/workflow-definitions
```

Callers start a registered definition through:

```text
POST /api/v1/workflows
```

Question answers and read models are exposed under:

```text
POST /api/v1/management/workflows/:sessionId/questions/:executionSequence/answer
GET  /api/v1/management/workflows/:sessionId
GET  /api/v1/management/workflows/:sessionId/executions
```

Conversational parents can use `spawn_workflow`, `check_workflows`, and
`wait_for_workflows`. The CMS `parentSessionId` remains the authoritative
relationship between the conversational parent and workflow child.

## Validation Strategy

Domain-neutral local tests register and execute a real package against
PostgreSQL without an LLM. Separate campaign files cover:

- question, action, observation, terminal, and cancellation paths
- equivalent concurrent question answers
- worker replacement while waiting on a question
- worker replacement during observation polling
- hard process death after an action side effect and idempotent re-dispatch

The files live under `packages/sdk/test/local`, use isolated schemas, and are
independently tracked and retried by the resumable validation campaign.
