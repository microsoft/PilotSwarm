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
      outcomes:
        - succeeded
        - failed
    transition:
      use: after-state-a
      allowedTargets:
        - state-b
        - state-c
```

The agent definition describes instructions and capabilities, while the prompt
describes the state-specific task.

## Transition callback declaration

Complex transition logic is packaged as deterministic code rather than
embedded as an unrestricted script string in YAML. The workflow package
manifest registers a stable callback name to a module export:

```yaml
transitions:
  after-state-a:
    module: ./transitions.mjs
    export: afterStateA
```

The workflow YAML references the registered name through `transition.use`.
The named module export implements this author-facing interface:

```typescript
type StateId = string;

interface TransitionContext<TInput, TOutput> {
    workflowInput: DeepReadonly<TInput>;
    configuration: DeepReadonly<unknown>;
    currentStateId: StateId;
    stateOutput: DeepReadonly<TOutput>;
    recordedStateOutputs: DeepReadonly<Record<StateId, unknown>>;
}

type TransitionFunction<TInput, TOutput> = (
    ctx: TransitionContext<TInput, TOutput>,
) => StateId;

export const afterStateA: TransitionFunction<WorkflowInput, StateAOutput> =
    ctx => {
        if (ctx.stateOutput.result.matchesCondition) {
            return "state-b";
        }

        return "state-c";
    };
```

Transition code must be synchronous and deterministic over the immutable
context. It must not use tools, network, filesystem, clocks, randomness, model
calls, mutable module globals, or other side effects, and it may return only
one of the state's declared `allowedTargets`.

## Runtime boundary

At definition registration, PilotSwarm validates references, schemas, declared
outcomes, transition exports, and allowed targets. It compiles the package into
an immutable graph and pins the compiled definition by ID.

At execution, PilotSwarm supplies recorded inputs and outputs to the packaged
deterministic functions and dispatches external work only through registered
handler identities. Workflow code does not directly control durable history,
invocation admission, retries, completion-policy enforcement, or lifecycle
storage.
