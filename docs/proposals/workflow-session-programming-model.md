# Workflow sessions: programming model

**Status:** Proposal

**Parent design:** [Workflow sessions: scenarios and design](./workflow-session-scenarios.md)

**Parent issue:** [PilotSwarm issue #28](https://github.com/microsoft/PilotSwarm/issues/28)

**In one sentence:** workflow authors package state execution contracts and
deterministic transitions, while environment owners register external handlers
and PilotSwarm owns durable execution.

## User surface area

The programming model has two user-owned surfaces:

| User | Owns |
|---|---|
| Workflow author | Workflow YAML, agent definitions, state prompts, schemas, deterministic transition functions, and deterministic result functions. |
| Environment owner | Registered action and observed-condition handlers, credentials, connection configuration, and authorization integration. |

PilotSwarm owns definition compilation and pinning, the durable controller,
state-invocation lifecycle records, handler dispatch, transition registration,
completion policies, and workflow observability. Those runtime mechanisms are
not authored in workflow YAML.

The workflow author owns both:

- the execution contract for each state, including its pinned agent, provider,
  action, or other handler and its allowed outputs; and
- the transition function that maps a recorded, schema-valid output to the next
  directive.

The author publishes those contracts as one immutable package containing the
workflow definition and its referenced artifacts:

```text
workflow.yaml
agents/
  example-agent.agent.md
prompts/
  state-a.md
schemas/
  state-output.schema.json
transitions.mjs
results.mjs
```

## State types

The proposed authoring model currently names five state types:

| Type | Author supplies | Abstract example |
|---|---|---|
| `agent` | Agent-definition Markdown, a state prompt, input mappings, allowed outcomes, and a result schema. | State A asks an agent to produce a structured value. |
| `observed-condition` | An opaque registered handler reference, operation data, and declared outcomes. The environment owner separately registers an `evaluate` implementation. | State B waits until an external condition reaches a terminal status. |
| `action` | An opaque registered handler and operation reference, structured input, idempotency key, allowed outcomes, and result schema. The environment owner separately registers an `execute` implementation. | State C applies one external operation and records its result. |
| `result` | A declarative value template or deterministic packaged result function plus its result schema. | State D combines earlier outputs into a final value. |
| `terminal` | A declared workflow outcome and terminal result mapping. No executable handler is supplied. | State E ends the workflow as succeeded, blocked, or failed. |

These names are proposed contract vocabulary rather than already implemented
SDK types. A future direct-subworkflow state may extend the model, but its
authoring shape and type name are not yet defined.

## Externally registered handler interfaces

The workflow definition refers to observed-condition and action handlers by
registered name. The end user or environment owner supplies and registers the
implementations independently from the workflow package. The registration
contract is conceptual:

```typescript
interface HandlerWorkflowIdentity {
    sessionId: string;
    definitionId: string;
    stateId: StateId;
    invocationId: string;
}

interface ObservedConditionHandler<TOperation, TCheckpoint, TOutput> {
    evaluate(
        request: Readonly<{
            workflow: HandlerWorkflowIdentity;
            operation: TOperation;
            checkpoint?: TCheckpoint;
            trigger: HandlerTrigger;
        }>,
    ): Promise<
        | { status: "waiting"; checkpoint: TCheckpoint; correlationKeys: string[] }
        | { status: "completed"; outcome: string; output: TOutput }
    >;
}

interface ActionHandler<TInput, TOutput> {
    execute(
        request: Readonly<{
            workflow: HandlerWorkflowIdentity;
            operation: string;
            input: TInput;
            idempotencyKey: string;
            authorization: HandlerAuthorization;
        }>,
    ): Promise<{ outcome: string; output: TOutput }>;
}

type ResultFunction<TContext, TOutput> = (
    context: DeepReadonly<TContext>,
) => TOutput;
```

For example, an end user could register REST-backed implementations:

```typescript
export const createRemoteResource: ActionHandler<CreateInput, CreateOutput> = {
    async execute(request) {
        const response = await restClient.post("/resources", request.input, {
            headers: { "Idempotency-Key": request.idempotencyKey },
        });

        return {
            outcome: "succeeded",
            output: { resourceId: response.body.id },
        };
    },
};

export const awaitRemoteResource:
    ObservedConditionHandler<ObserveOperation, ObserveCheckpoint, ObserveOutput> = {
        async evaluate(request) {
            const response = await restClient.get(
                `/resources/${request.operation.resourceId}`,
            );

            if (response.body.status === "running") {
                return {
                    status: "waiting",
                    checkpoint: { lastStatus: "running" },
                    correlationKeys: [request.operation.resourceId],
                };
            }

            return {
                status: "completed",
                outcome: response.body.status,
                output: response.body,
            };
        },
    };

handlerRegistry.registerAction(
    "example.create-resource",
    createRemoteResource,
);

handlerRegistry.registerObservedCondition(
    "example.await-resource",
    awaitRemoteResource,
);
```

The action starts or mutates remote work. The observed condition reads
authoritative remote state and either remains waiting or returns a declared
terminal outcome. A polling timer or authenticated callback may wake the
observation, but every wake invokes `evaluate` again; the callback itself does
not authoritatively complete the state.

Observed-condition and action handlers may perform external I/O because they
run behind the generic handler boundary. PilotSwarm knows only the registered
handler identity, request envelope, waiting/completed lifecycle, and declared
outcomes. It does not know that an implementation uses REST, which endpoints
it calls, or how it interprets domain status. Credentials and connection
configuration remain with the externally registered handler rather than the
workflow YAML or package source. Result functions are synchronous and
deterministic over recorded facts, like transition functions. Terminal states
are declarative and have no handler.

## Agent state declaration

The agent-state example remains intentionally small:

```yaml
states:
  state-a:
    type: agent
    agent:
      path: ./agents/example-agent.agent.md
    prompt:
      path: ./prompts/state-a.md
    input:
      value: ${inputs.value}
    result:
      schema: example/state-output/v1
    completion:
      mode: one-shot
      outcomes:
        - succeeded
        - failed
    transition:
      handler:
        module: ./transitions.mjs
        export: afterStateA
```

The agent definition describes instructions and capabilities, while the prompt
describes the state-specific task.

## Transition callback declaration

Transition logic is packaged as deterministic code rather than embedded as an
expression language or outcome map in YAML. The workflow references a
package-relative module and named export:

```typescript
export const afterStateA = {
    allowedTargets: ["state-b", "state-c"],
    handler: (ctx: TransitionContext<WorkflowInput, StateAOutput>) => {
        if (ctx.stateOutput.result.matchesCondition) {
            return { kind: "advance", target: "state-b" };
        }

        return { kind: "advance", target: "state-c" };
    },
};
```

The package loader hashes the complete package and materializes a
content-addressed snapshot before importing transition code. It then resolves
the path within that immutable snapshot, hashes the entry module, validates the
export, and registers it internally for the compiler. Absolute paths, symbolic
links, and paths that escape the package are rejected.
The handler implements this author-facing interface:

```typescript
type StateId = string;

interface WorkflowExecutionRecord {
    stateId: StateId;
    executionSequence: number;
    outcome: string;
    output: unknown;
}

interface TransitionContext<TInput, TOutput> {
    workflowInput: DeepReadonly<TInput>;
    configuration: DeepReadonly<unknown>;
    currentStateId: StateId;
    stateOutcome: string;
    stateOutput: DeepReadonly<TOutput>;
    completion: DeepReadonly<{
        feedback?: unknown;
    }>;
    latestStateOutputs: DeepReadonly<Record<StateId, unknown>>;
    executionHistory: DeepReadonly<WorkflowExecutionRecord[]>;
}

type TransitionFunction<TInput, TOutput> = (
    ctx: TransitionContext<TInput, TOutput>,
) =>
    | { kind: "advance"; target: StateId }
    | { kind: "resume-producer"; feedback: unknown };

```

Transition code must be synchronous and deterministic over the immutable
context. It must not use tools, network, filesystem, clocks, randomness, model
calls, mutable module globals, or other side effects. An `advance` directive
may target only one of the state's declared `allowedTargets`. A reviewed state
may instead return `resume-producer` with the recorded review feedback; the
runtime resumes the same producer revision chain rather than entering the
state as a new execution.

## Runtime boundary

At definition registration, PilotSwarm validates references, schemas, declared
outcomes, transition exports, and allowed targets. It compiles the package into
an immutable graph and pins the compiled definition by ID.

Workflow owners may declare logical execution identity from required scalar
inputs:

```yaml
inputs:
  repository:
    type: string
    required: true
  changeId:
    type: integer
    required: true
identity:
  primaryKey:
    - inputs.repository
    - inputs.changeId
```

The compiler rejects keys outside top-level required scalar inputs. Start
admission validates inputs, resolves and canonically hashes the composite key,
and atomically enforces one logical execution per immutable definition. An
ordinary duplicate returns the existing owner-visible execution. A different
caller receives a generic conflict rather than its session identity. An
explicit rerun requires a reason and may be requested only by the original
execution owner or a fleet administrator. Request idempotency remains separate:
each start carries a caller-scoped idempotency key, and reusing that key with a
different execution request is rejected. Session-group placement is private to
the caller and happens after admission, so it is not part of the workflow
request identity.

At execution, PilotSwarm supplies recorded inputs and outputs to the packaged
deterministic functions and dispatches external work only through registered
handler identities. Workflow code does not directly control durable history,
invocation admission, retries, completion-policy enforcement, or lifecycle
storage.

### Initial compiler and execution plans

The initial `v1alpha1` compiler parses YAML agent and terminal states. The
package loader resolves mandatory package-relative transition module exports
into an internal `WorkflowTransitionRegistry`, and the compiler lowers the
result into the same `InMemoryWorkflowGraph` used by the controller. It
supports one-shot named-agent states, terminal outputs, and exact-value
references rooted at `inputs`, `configuration`, or prior
`states.<stateId>.result`. Other state types remain future work.

Compilation produces two related outputs:

- an executable process-local graph retained for unit tests and embedded use;
  and
- a normalized, data-only manifest suitable for durable registration.

`PilotSwarmManagementClient.registerWorkflowDefinition(yaml, { packageRoot })`
snapshots the complete package, resolves transition exports through the same
compiler, and persists an immutable definition. The Web API exposes the same
operation for Git-backed packages:

```typescript
const registered = await management.registerWorkflowDefinition({
    source: {
        kind: "git",
        repositoryUrl: "https://github.com/example/workflows",
        gitRef: "refs/heads/main",
        workflowPath: "change-delivery/workflow.yaml",
    },
});
```

PilotSwarm checks the repository against the configured import allowlist,
resolves the requested ref to an immutable commit, checks out that commit
without submodules or Git LFS smudging, and treats the workflow file's directory
as the package root. Git credentials come from the server environment; the
request cannot carry credentials, query parameters, or fragments. Registration
is currently a `fleet:admin` operation.

CMS migration `0084` retains the authored YAML, source hash, requested Git ref,
resolved commit, and package artifact identity for audit and recompilation. It
stores the package hash as a first-class definition invariant and stores the
normalized data-only manifest as JSONB with the compiler version, graph
identity, templates, declared outcomes, allowed targets, and module/export
identities with their module hashes. The canonical package tarball is uploaded
to the existing artifact store under a content-addressed filename and pinned
before the CMS row is written. JavaScript handler functions, Git credentials,
and machine-local package paths are not serialized. Workers must load the
pinned package artifact that owns those identities.

Unlike `pg_durable`, the initial registry does not split each node into its own
row. PilotSwarm already has a complete authored YAML artifact, and Duroxide
history remains authoritative for the execution cursor and replay. A per-node
schema can be introduced later if node-level querying, indexing, mutation, or
independent versioning becomes a concrete requirement.

SDK code may also register an `InMemoryWorkflowGraph` directly and create a
workflow with the returned `{ kind: "in-memory", graphId }` definition source.
Executable states currently support either an activity handler or a named
one-shot agent. Both declare outcomes, allowed targets, and a synchronous
transition callback. An agent state supplies a prompt string or deterministic
prompt function. PilotSwarm starts a replay-stable child session and waits for
that child to call `submit_workflow_result`; it never scrapes the child's final
prose for JSON. Terminal states provide the workflow outcome, summary, and
optional deterministic result function.

```typescript
const { definition } = await compileAndRegisterWorkflowPackageYaml(workflowYaml, {
    packageRoot,
});

const registered = await management.registerWorkflowDefinition(
    workflowYaml,
    { packageRoot },
);
```

```typescript
const definition = registerInMemoryWorkflowGraph({
    id: "approval-example/v1",
    initialState: "inspect",
    states: {
        inspect: {
            type: "agent",
            agent: "candidate-inspector",
            prompt: context =>
                `Inspect candidate ${context.workflowInputs.candidateId}.`,
            allowedOutcomes: ["approved", "rejected"],
            allowedTargets: ["publish", "blocked"],
            transition: context =>
                context.stateOutcome === "approved" ? "publish" : "blocked",
        },
        publish: {
            type: "activity",
            allowedOutcomes: ["published"],
            allowedTargets: ["done"],
            execute: async context => publishCandidate(context.workflowInputs),
            transition: () => "done",
        },
        blocked: {
            type: "terminal",
            outcome: "blocked",
            summary: "Candidate was rejected.",
        },
        done: {
            type: "terminal",
            outcome: "succeeded",
            summary: "Candidate was published.",
            result: context => context.latestStateOutputs.publish.output,
        },
    },
});

await client.createWorkflowSession({
    definition,
    inputs: { candidateId: "candidate-42" },
});
```

The executable graph registry remains process-local and is retained for
controller unit tests and embedded use. The same workflow orchestration adds a
durable production path for registered definitions: a definition-provider activity loads the registered
compiled manifest, the generic controller interprets that serializable plan,
and transition activities execute hash-verified module exports from the pinned
package artifact. Duroxide records both activity results, so replay does not
depend on process-local graph registration. Registered definitions start
through the SDK or `POST /api/v1/workflows`; admission is persisted before the
idempotent Duroxide start so a retry can repair a crash between those steps.
In this initial runtime slice, agent names resolve through the worker's installed agent catalog;
loading agent definitions, skills, and MCP configuration from the workflow
package is a later portability extension.

Each nonterminal state admission receives a workflow-scoped,
monotonically-increasing `executionSequence`. For an agent state, the durable
child creation config binds that sequence, state, graph, declared outcomes, and
workflow session to the child. The result tool derives this binding from the
authenticated child session rather than accepting identity fields from the
model. Controller acceptance is then recorded through a durable activity
before the transition callback runs.

The controller exposes both `latestStateOutputs`, keyed by state ID for
convenient transition lookups, and ordered `executionHistory`, keyed by each
record's `executionSequence`. A loop therefore replaces the latest value for a
state without losing earlier executions.

The `1.0.0` orchestration, agent-dispatch plan, activity names, queue names, and
tool-binding contracts live under a version-specific module. Once that version
is deployed, replay-affecting changes require a new orchestration version
rather than mutation of the existing contract.
