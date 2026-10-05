# Workflow sessions: scenarios and design

**Status:** Proposal

**Parent design:** [PilotSwarm issue #28](https://github.com/microsoft/PilotSwarm/issues/28)

**Implementation foundation:** `feature/workflow-sessions`

**Concrete acceptance workload:**
[ChangeDelivery PoC](https://msdata.visualstudio.com/Database%20Systems/_git/sqlmort?path=/docs/workflow-sessions/change-delivery-poc/README.md&version=GBmain&_a=preview)

**In one sentence:** add a deterministic controller for repeatable process
invariants while continuing to use ordinary PilotSwarm agents for reasoning and
tool execution.

## Table of contents

- [Motivation](#motivation)
- [1. Scenarios](#1-scenarios)
  - [1.1 Top-level workflow](#11-top-level-workflow)
  - [1.2 Conversational parent](#12-conversational-parent)
  - [1.3 Mixed nesting](#13-mixed-nesting)
  - [1.4 Concurrent workflows](#14-concurrent-workflows)
  - [1.5 User and developer experience](#15-user-and-developer-experience)
- [2. High-level design](#2-high-level-design)
  - [2.1 Session model](#21-session-model)
  - [2.2 Responsibility boundary](#22-responsibility-boundary)
    - [Runtime layers](#runtime-layers)
  - [2.3 Durable creation and identity](#23-durable-creation-and-identity)
  - [2.4 Result and lifecycle records](#24-result-and-lifecycle-records)
    - [Lifecycle records for reviewed completion](#lifecycle-records-for-reviewed-completion)
  - [2.5 Workflow-authored transition function](#25-workflow-authored-transition-function)
  - [2.6 External waits, providers, and actions](#26-external-waits-providers-and-actions)
  - [2.7 Nested workflows and limits](#27-nested-workflows-and-limits)
  - [2.8 Authorization and cancellation](#28-authorization-and-cancellation)
  - [2.9 Observability](#29-observability)
  - [2.10 Open workflow-controller design TODOs](#210-open-workflow-controller-design-todos)
- [3. How the design solves the scenarios](#3-how-the-design-solves-the-scenarios)
- [4. Implementation notes](#4-implementation-notes)
  - [4.1 Current foundation](#41-current-foundation)
  - [4.2 Definition subsystem](#42-definition-subsystem)
  - [4.3 Controller state and invocation](#43-controller-state-and-invocation)
  - [4.4 Agent execution and result submission](#44-agent-execution-and-result-submission)
  - [4.5 Node handlers and delivery](#45-node-handlers-and-delivery)
  - [4.6 Versioning and phases](#46-versioning-and-phases)
- [5. Test plan](#5-test-plan)
  - [5.1 Unit and compiler tests](#51-unit-and-compiler-tests)
  - [5.2 Deterministic orchestration tests](#52-deterministic-orchestration-tests)
  - [5.3 Scenario tests](#53-scenario-tests)
  - [5.4 ChangeDelivery acceptance](#54-changedelivery-acceptance)
- [6. Decisions](#6-decisions)

## Motivation

PilotSwarm already provides durable conversational sessions, child agents,
timers, recovery, and parent-child result delivery. Those mechanisms do not
define repeatable process state.

A prompt can ask an agent to plan, review, remediate, and implement, but the
runtime cannot enforce:

- which step is active;
- which output was accepted;
- whether a review applies to the current revision;
- which transitions are permitted;
- retry and revision bounds;
- durable external waits;
- terminal success, blocked, and failure semantics.

A workflow session adds those process invariants without replacing agents. The
controller owns state and transitions; agents retain freedom over reasoning,
tool choice, investigation, and how they produce a valid result.

The model is a versioned state machine:

| Concept | Workflow-session representation |
|---|---|
| State | Agent invocation, timer, question, review, provider wait, action, subworkflow, or terminal node |
| Outcome | Schema-valid output or authenticated input from an authorized producer |
| Transition | Workflow-authored function from current state and accepted outcome |
| Durable state | Current node, invocation, attempt, revisions, waits, and accepted results |
| Action | Admit an agent, wait, ask, invoke a provider, resume a producer, or deliver a result |

The guiding boundary is:

> Deterministically enforce process invariants; leave multiple valid ways of
> satisfying a state contract to the agent.

For reviewed work, an agent may produce several candidate revisions. Rejection
resumes the same producer with feedback. Acceptance binds to one exact
candidate and enables only the workflow-authorized next action.

## 1. Scenarios

### 1.1 Top-level workflow

A caller starts a published workflow directly, without a conversational parent.

```text
Caller
  -> create workflow session W1
  -> W1 admits agent A1
  -> A1 submits a structured outcome
  -> W1 evaluates its transition function
  -> W1 waits, reviews, or admits subsequent work
  -> W1 writes one terminal result
```

Required behavior:

- `W1` has no `parentSessionId`.
- The workflow definition and inputs are immutable for the run.
- Agent work uses ordinary child sessions.
- Worker restart resumes existing invocations and waits.
- The terminal result remains inspectable on the root workflow session.

### 1.2 Conversational parent

An ordinary agent may start an allowed workflow using `spawn_workflow`.

```text
Conversation C0
  -> durable spawn_workflow action
  -> workflow child W1
  -> W1 terminal result
  -> direct-parent result delivery
  -> C0 explains or acts on the result
```

The parent may continue conversing, inspect progress with `check_workflows`, or
release execution resources with `wait_for_workflows`.

### 1.3 Mixed nesting

Conversation and workflow sessions may alternate:

```text
conversation C0
  -> workflow W1
      -> agent A1
          -> workflow W2
              -> agents A2 and A3
```

`parentSessionId` remains the authoritative relationship edge. Each controller
tracks only the direct work it must resume. Results cross one parent edge at a
time.

The definition may also declare direct subworkflow nodes when delegation must
be deterministic rather than chosen by an agent.

### 1.4 Concurrent workflows

One conversation may start multiple workflows and consume them independently.

Required behavior:

- each workflow receives a replay-stable session ID;
- completion order does not define identity;
- partial status is inspectable;
- callers may wait for a subset;
- every terminal result is delivered once.

### 1.5 User and developer experience

| Stage | User or author supplies | PilotSwarm supplies |
|---|---|---|
| Author | Definition, schemas, agents, graph, bounds, deadlines, failure behavior, and mappings | Validation and compilation |
| Publish | Resolvable package and immutable version | Definition identity and source pinning |
| Start | Registered definition reference or inline definition plus schema-valid business inputs | Compilation, immutable definition identity, session, and invocation identity |
| Run | Review decisions or cancellation when permitted | Durable execution, waits, status, and correlation |
| Complete | Nothing additional | Terminal result and direct-parent delivery |

Package-backed workflows are the normal user experience. Inline definitions
remain useful for development and tests but pass through the same compiler.

PilotSwarm generates session, lineage, invocation, attempt, revision, wait, and
correlation identity. Those values are not workflow inputs.

## 2. High-level design

### 2.1 Session model

PilotSwarm has two session kinds:

| Kind | Controller | Primary interaction |
|---|---|---|
| Conversational | LLM agent loop | Messages and tools |
| Workflow | Deterministic workflow controller | Definition, outcomes, and transitions |

Both use the existing session tree:

- `sessionId` identifies the session;
- `parentSessionId` identifies the direct parent;
- a missing parent identifies a root;
- `rootSessionId` identifies the mixed-tree root.

Workflow execution ledgers do not create a second relationship tree.

### 2.2 Responsibility boundary

#### Runtime layers

| Layer | Responsibility |
|---|---|
| Portal and REST API | Register, start, inspect, review, cancel, and retrieve workflow sessions |
| SDK | Author definitions, resolve typed references, validate requests, and expose management and result APIs |
| Orchestration | Provide durable histories, activities, timers, child sessions, replay, wake-up, and continue-as-new |
| Workflow controller | Interpret one compiled definition, admit nodes, validate outcomes, apply transitions, and produce the terminal result |

Agents and providers execute work behind controller-owned invocation contracts.
They are pluggable execution participants, not additional authorities over
workflow state.

**Workflow controller owns:**

- frozen definition and inputs;
- active state, invocation, attempt, and revision;
- accepted outcomes and transitions;
- waits, review gates, deadlines, bounds, cancellation, and terminal result.

**Agent invocation owns:**

- reasoning and tool use for one bounded task;
- producing a schema-valid declared outcome;
- candidate revision work after review feedback.

**Agent invocation does not own:**

- authoritative state transitions;
- accepting its own reviewed candidate;
- undeclared external side effects;
- workflow identity or correlation.

**Providers own:**

- domain interpretation for external observations or actions;
- returning declared outcomes and structured evidence.

Providers never return target workflow states.

### 2.3 Durable creation and identity

Workflow creation is a durable orchestration action, not an inline side effect
of a retryable model turn.

For conversational creation:

```text
model emits spawn_workflow
  -> parent orchestration allocates replay-stable child ID
  -> idempotent activity creates or reuses that workflow child
  -> parent records it in subWorkflows
```

Node admission follows the same pattern:

1. Allocate replay-stable invocation and child-session IDs.
2. Persist the invocation.
3. Create or reuse the exact child.
4. Resume the same child after recovery.

### 2.4 Result and lifecycle records

A workflow terminal result has a common shape:

```json
{
  "sessionId": "workflow-session-id",
  "parentSessionId": "optional-direct-parent-id",
  "outcome": "succeeded",
  "summary": "Human-readable summary.",
  "result": {},
  "completedAt": "2026-10-02T14:00:00.000Z"
}
```

The runtime binds node submissions to the active workflow, state, invocation,
attempt, producer, and revision. A producer supplies only its declared outcome
and domain result; it cannot select another workflow or next state.

#### Lifecycle records for reviewed completion

PilotSwarm preserves these as distinct immutable facts:

```text
submission -> candidate revision -> review decision
    -> accepted state outcome -> selected transition
```

A one-shot submission may immediately become an accepted state outcome. A
reviewed submission creates a candidate until an authorized decision accepts
that exact revision. Rejection records feedback and resumes the same producer.

The storage representation remains open. The logical separation is required
for:

- auditability;
- first-pass acceptance and revision counts;
- rejection-reason analysis;
- stale or invalid submission rates;
- time to acceptance and human-correction rates.

Telemetry should reference immutable records and minimal metadata instead of
copying sensitive result content.

### 2.5 Workflow-authored transition function

The workflow author owns both:

- the execution contract for each state, including its pinned agent, provider,
  action, or other handler and its allowed outputs; and
- the transition function that maps an accepted output to the next directive.

```text
output = executeState(currentState)
nextDirective = transition(definitionVersion, currentState, output)
```

State execution may be nondeterministic. PilotSwarm validates and durably
records `output` before evaluating `transition`. The producer never names or
applies `nextDirective`.

`executeState` is a logical lifecycle, not necessarily one synchronous call. It
may span durable waits and resumptions while `currentState` remains unchanged.
The transition function runs only after that lifecycle produces an accepted
output.

The default transition function is a deterministic finite mapping:

```text
(currentState, accepted) -> advance(acceptedState)
(currentState, stale)    -> advance(staleState)
(currentState, rejected) -> resume(producer)
```

A directive either advances to a declared state or resumes a reviewed producer.
Replay evaluates the same frozen definition and recorded outcome.

For genuinely semantic routing, the author may declare an explicit agentic
transition function:

```text
output = executeState(currentState)
selectedRoute = executeTransitionAgent(currentState, output, allowedRoutes)
nextDirective = mapRoute(definitionVersion, currentState, selectedRoute)
```

The transition agent is a visible, bounded invocation. It chooses one declared
route, not an arbitrary state. PilotSwarm persists `selectedRoute`; replay
never reruns the agent merely to reconstruct control flow.

Deterministic mappings are the default. Agentic routing is an explicit escape
hatch, not hidden model execution inside the controller.

### 2.6 External waits, providers, and actions

An **external wait** suspends an invocation until progress or a condition outside
PilotSwarm produces a terminal output. An observed condition only waits; a
long-running operation starts or attaches to work and then waits. A durable
wait is the controller mechanism implementing either form.

An external wait is persisted control-plane state:

1. Persist operation and correlation.
2. Subscribe to an event or create a durable timer.
3. Release the worker.
4. Rehydrate on event, cancellation, or timer.

Long-running work uses a durable operation lifecycle:

```text
begin(input, idempotencyKey)
  -> completed(outcome, output)
  -> waiting(operationReference, checkpoint, wakePolicy)

observe(operationReference, checkpoint, observation)
  -> completed(outcome, output)
  -> waiting(updatedCheckpoint, wakePolicy)
```

The invocation remains in the same workflow state while waiting. Intermediate
observations update durable operation state but do not invoke the transition
function. A terminal provider response becomes the state output and permits
transition evaluation.

`begin` must be idempotent so replay cannot start a second external operation.
The wake policy may use callbacks, events, or durable polling timers without
changing controller semantics. Cancellation fences further observations and
requests provider cancellation when supported; it does not assume the external
operation was reversed.

For push-based wake-up, PilotSwarm issues an opaque wait handle and generic
authenticated signal endpoint. An external system or provider integration
submits a signal ID and the wait handle; PilotSwarm validates, deduplicates,
persists, and wakes the owning invocation. The signal is a wake-up hint, not an
authoritative completion result. On resumption, the provider validates or
re-reads authoritative state before returning an outcome.

PilotSwarm owns the generic signal ingress and durable timer fallback. Providers
own source-specific subscription or callback registration. A source that can
call the generic endpoint needs no domain-specific PilotSwarm notification API;
a source without callbacks may rely on durable polling.

An author may represent launch and observation as one long-running operation
state or as separate action and observed-condition states when that distinction
is meaningful in the workflow.

Predefined questions follow the same model. An authenticated answer must target
the exact active question and invocation, satisfy respondent authorization, and
be persisted before transition evaluation.

Provider-backed states use a common logical contract:

- PilotSwarm supplies workflow and invocation correlation.
- The definition supplies an opaque operation and allowed outcomes.
- The provider either remains waiting with opaque resumption state or completes
  with one declared outcome and structured output.
- Malformed, stale, superseded, incorrectly correlated, or undeclared provider
  responses fail explicitly.
- PilotSwarm validates and persists terminal output before evaluating the
  workflow-authored transition function.

External writes are separate action nodes with explicit authorization and
idempotency. Accepting a reviewed candidate may authorize a later action; it
does not make the producing agent authoritative for that write.

The exact YAML, provider registration, and request/response types remain open.
The
[ChangeDelivery PoC](https://msdata.visualstudio.com/Database%20Systems/_git/sqlmort?path=/docs/workflow-sessions/change-delivery-poc/README.md)
is one candidate encoding, not the normative schema.

### 2.7 Nested workflows and limits

A workflow may start:

1. a direct subworkflow declared by the definition; or
2. an agent-initiated workflow permitted by policy.

The runtime enforces:

- total session-tree and workflow nesting depth;
- active descendants and workflow concurrency;
- deadlines, loop iterations, attempts, and candidate revisions;
- static package-reference cycles;
- runtime recursion for generated definitions.

Timeout, cancellation, retry exhaustion, and loop-bound exhaustion are explicit
controller outcomes. Definitions decide whether each advances, blocks, fails,
or cancels the workflow.

### 2.8 Authorization and cancellation

Every creation edge:

- inherits or validates owner identity;
- authorizes child creation against the direct parent;
- protects child conversations, artifacts, and results;
- verifies direct lineage for reads and writes.

Review and action authorization:

- targets one exact invocation and candidate revision;
- grants only the definition-declared capability;
- rechecks authority and preconditions before external writes;
- keeps publication, code approval, and merge authority distinct.

Cancellation fences new admissions and propagates to active direct children
according to policy. External effects are reported, not assumed reversible.
Pausing also fences new admissions without erasing active state. Management
retention preserves terminal results and immutable lifecycle references
according to policy.

### 2.9 Observability

Management surfaces expose:

- session, parent, and root identity;
- definition identity and version;
- state, invocation, attempt, and candidate revision;
- producer and backing child session;
- wait reason and provider correlation;
- accepted result and transition references;
- question respondent, action authorization, idempotency, and partial effects;
- terminal outcome and reason.

Large transcripts and result payloads remain in their owning stores rather than
being copied into orchestration state.

### 2.10 Open workflow-controller design TODOs

- [x] Separate submissions, candidate revisions, review decisions, accepted
  state outcomes, and selected transitions.
- [ ] Define runtime-bound identity fields.
- [ ] Define producer authority for declared outcomes.
- [ ] Define normalized advance and producer-resume directives.
- [ ] Define atomic outcome/transition persistence and race handling.
- [ ] Define reviewed revision, rejection, acceptance, abort, and invalidation.
- [ ] Define agentic transition admission, allowed routes, bounds, and replay.
- [ ] Define provider registration, wake-up, correlation, and idempotency.
- [ ] Define long-running provider begin, observe, checkpoint, and cancellation
  contracts.
- [ ] Define generic wait handles, signal authentication, payload limits,
  deduplication, expiry, and timer fallback.
- [ ] Define registration handshakes, lost-wakeup recovery, signal ordering and
  coalescing, and callback-before-registration behavior.
- [ ] Define races among completion, timeout, cancellation, supersession, and
  late signals.
- [ ] Define provider error classification, retry/backoff, rate limits, and
  reconciliation after outages.
- [ ] Define controller outcomes for timeout, cancellation, and exhausted bounds.
- [ ] Define compiler checks for incomplete, ambiguous, or invalid definitions.
- [ ] Define minimal transition and completion telemetry.
- [ ] Define versioning for persisted outcomes, transitions, and providers.

## 3. How the design solves the scenarios

| Scenario need | Design mechanism |
|---|---|
| Root workflow | Workflow sessions may omit `parentSessionId`; result remains attached |
| Conversational start | Durable `spawn_workflow` action with replay-stable child ID |
| Agent creativity | Agents own reasoning and tools inside bounded state contracts |
| Repeatable process | Frozen definition and workflow-authored transition function |
| Reviewed correction | Candidate revisions plus exact review decisions |
| Mixed nesting | Shared session tree and one-edge result propagation |
| Concurrent workflows | Per-child identity and subset waits |
| External gates | Provider-backed durable observed conditions |
| Authorized writes | Separate idempotent action nodes |
| Recovery | Persisted invocations, waits, outcomes, and transitions |
| Bounded execution | Definition and runtime limits |
| Audit and metrics | Immutable lifecycle records |

## 4. Implementation notes

### 4.1 Current foundation

The feature branch already provides:

| Piece | State |
|---|---|
| Workflow session kind and CMS lineage | Implemented |
| Non-conversational workflow handle | Implemented |
| Top-level SDK creation | Implemented |
| Conversational `spawn_workflow` | Implemented as durable action |
| Parent `subWorkflows`, check, wait, and result consumption | Implemented |
| Dedicated workflow orchestration version boundary | Scaffolded; fails explicitly |
| Definition compiler and controller | Not implemented |

### 4.2 Definition subsystem

Add a definition subsystem responsible for:

- resolving packaged and inline sources;
- pinning mutable package and Git references;
- validating schema, references, expressions, and bounds;
- compiling the graph and transition functions;
- rejecting unsupported nodes, missing outcomes, invalid targets, and cycles;
- persisting definition identity, source hash, and compiled version.

Packaged and inline sources use the same compiler.
Runtime-generated definitions, if admitted, also use this compiler and receive
an immutable compiled identity before execution.

### 4.3 Controller state and invocation

The controller persists only deterministic state and immutable references:

```ts
interface WorkflowControllerState {
  definitionId: string;
  status: "running" | "waiting" | "succeeded" | "blocked" | "failed" | "cancelled";
  currentStates: string[];
  invocations: WorkflowInvocation[];
  acceptedResults: Record<string, string>;
  activeWaits: WorkflowWait[];
  output?: WorkflowSessionResult;
}

interface WorkflowInvocation {
  invocationId: string;
  stateId: string;
  iteration: number;
  attempt: number;
  candidateRevision: number;
  childSessionId?: string;
  status: string;
}
```

The final types depend on the open identity and lifecycle TODOs.

### 4.4 Agent execution and result submission

A versioned workflow-agent base supplies:

- invocation context;
- task and allowed outcomes;
- result schema;
- completion policy and bounds;
- runtime-bound `submit_workflow_result`;
- prohibition on direct transition commands.

The submission activity:

- stamps authoritative workflow and producer identity;
- validates the declared outcome and schema;
- records a submission or candidate revision;
- creates an accepted outcome immediately only when policy permits;
- remains idempotent for duplicate calls.

Final prose, idle state, or session completion does not implicitly complete a
workflow invocation.

### 4.5 Node handlers and delivery

Implement handlers incrementally:

1. one-shot agent;
2. deterministic transition map;
3. durable timer and predefined question;
4. provider-backed observed condition;
5. authorized idempotent action;
6. reviewed agent correction;
7. bounded loop;
8. direct subworkflow;
9. agentic transition;
10. schedules and cron occurrences.

The existing direct-parent result path remains:

- workflow controller writes one terminal result;
- child-outcome storage is the direct-parent source;
- `check_workflows` reads available results;
- `wait_for_workflows` releases resources and resumes with results.

Root results require an equivalent management retrieval path.

### 4.6 Versioning and phases

Persisted orchestration shape changes require a new frozen version. New runs use
the latest version; old runs retain prior behavior.

Suggested phases:

| Phase | Deliverable |
|---|---|
| 1 | Compiler, one-shot agent, deterministic transitions |
| 2 | Runtime-bound submissions and immutable lifecycle records |
| 3 | Complete root and conversational end-to-end paths |
| 4 | Providers, observed conditions, and actions |
| 5 | Reviewed correction and bounded loops |
| 6 | Direct subworkflows and agentic transitions |
| 7 | Cancellation, retention, management API, and UI |

## 5. Test plan

### 5.1 Unit and compiler tests

Definition:

- packaged and inline sources compile identically;
- references pin to immutable identity;
- unsupported nodes, expressions, cycles, and targets fail;
- outcomes and transition mappings are complete and unambiguous;
- compiled identity and source hash are stable.

Lifecycle:

- submissions are invocation-bound and schema-checked;
- candidates, decisions, accepted outcomes, and transitions remain distinct;
- duplicate and stale revisions cannot advance twice;
- one-shot and reviewed policies differ explicitly;
- answers are authenticated, authorized, and bound to the active question;
- timeout, cancellation, retry exhaustion, and loop-bound exhaustion remain
  distinct;
- agentic routes are restricted to declared values.

### 5.2 Deterministic orchestration tests

- replay schedules the same activities and child IDs;
- crash after child creation reuses the child;
- crash after outcome write does not duplicate transition;
- racing submissions accept one authoritative result;
- continue-as-new preserves invocations, waits, and accepted results;
- pause and resume preserve active state without admitting duplicate work;
- malformed, stale, superseded, and incorrectly correlated provider events
  fail explicitly;
- provider events and action retries remain idempotent;
- long-running operations start once, release the worker, tolerate intermediate
  observations, and transition only after terminal output;
- callback and polling wake policies produce the same accepted output;
- duplicate, expired, unauthorized, and incorrectly correlated signals cannot
  advance an invocation;
- a signal arriving during registration is not lost;
- concurrent completion, timeout, cancellation, and late signals produce one
  authoritative lifecycle result;
- transient provider failures retry without restarting the external operation;
- continue-as-new and worker recovery preserve active wait handles,
  checkpoints, and unconsumed signals;
- replay consumes recorded agentic routes rather than rerunning the agent;
- old orchestration versions retain frozen behavior.

### 5.3 Scenario tests

Cover:

- root workflow creation and terminal retrieval;
- conversational start, check, wait, and result delivery;
- unauthorized workflow selection and invalid input mapping fail before
  session creation;
- alternating conversation/workflow nesting;
- direct and agent-initiated subworkflows;
- concurrent workflows completing out of order;
- cancellation of one branch without cancelling siblings;
- timer, question, schedule, and cron wake-up;
- worker restart at every wait and result boundary.

Each scenario verifies lineage, correlation, current status, and exactly-once
result delivery.

### 5.4 ChangeDelivery acceptance

The checked-in sqlmort PoC is the concrete acceptance fixture. It must exercise
the production compiler and controller, not a test-only interpreter.

Acceptance requires:

- immutable package registration and invocation;
- five one-shot agent states and one reviewed state;
- aggregate external gate waiting without a held worker;
- exact-commit evidence and stale-result rejection;
- reviewed revision, rejection, resumption, and acceptance;
- authorized idempotent publication;
- bounded remediation;
- succeeded, blocked, and failed terminal outcomes;
- replay without duplicate admissions, events, actions, or delivery;
- management visibility into state, invocation, wait, revision, and reason.

Deterministic fake providers are permitted when they implement the same provider
boundary used by production integrations.

## 6. Decisions

1. Workflow sessions and conversations share the CMS session tree.
2. `parentSessionId` is the authoritative relationship edge.
3. Workflow execution state is separate from conversational `subAgents`.
4. Agents produce outcomes; workflow authors define transition functions.
5. Deterministic outcome maps are the default.
6. Agentic transitions are explicit durable invocations with bounded routes.
7. Reviewed candidates, decisions, accepted outcomes, and transitions are
   distinct immutable facts.
8. Results propagate one direct-parent edge at a time.
9. External waits do not reserve workers or consume model turns.
10. External writes are separate authorized, idempotent actions.
11. Packaged and inline definitions use one compiler.
12. The sqlmort ChangeDelivery PoC is the concrete acceptance workload, not the
    normative PilotSwarm schema.
13. Starts may use registered references or inline definitions; every admitted
    run freezes an immutable compiled definition identity.
14. Long-running operations remain in the current state across durable waits;
    only accepted terminal output enables transition evaluation.
15. PilotSwarm provides generic durable signal ingress; provider integrations
    arrange source-specific callbacks or use polling.
