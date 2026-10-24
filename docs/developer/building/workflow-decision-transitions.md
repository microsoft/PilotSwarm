# Durable decision-model workflow transitions

## Goal

Let workflow authors choose how each state selects its next target:

1. A deterministic transition handler.
2. A bounded decision model.
3. An LLM or agent, when the author explicitly accepts that tradeoff.

Decision support must be optional and provider-neutral. A workflow that uses
only deterministic transitions must not require a decision-model deployment.

The selected target and the evidence used to select it must be durable. A
Duroxide replay must return the previously recorded transition result rather
than call the model again.

## TL;DR: decision-model contract versus a generative model

A decision model is not a smaller chat model. It has a different API and
runtime contract.

| | Decision model | Generative model |
|---|---|---|
| Primary purpose | Make a bounded judgment | Reason, generate text, plan, or act |
| Input | A `state` value plus named, typed questions | Conversation messages, instructions, tools, and context |
| Question types | `noul` (yes/no), `choice`, and `score` | Open-ended natural-language requests |
| Output | Typed answers and probability distributions | Generated text, reasoning events, or tool calls |
| Free-form response | No | Yes |
| Tool use | No agent/tool loop | Can select and invoke tools |
| Allowed answers | Declared by the caller | Usually unconstrained unless schema-enforced |
| Workflow use | Routing, gates, grading, ranking, and defer decisions | Producing state results or handling ambiguous work |
| Uncertainty | Explicit probabilities used by policy | Usually inferred from output or a separate judge |
| Durability requirement | Persist the selected answer, probabilities, threshold, and route | Persist the generated messages and tool activity |

The request shape is approximately:

```json
{
  "model": "deployment-alias",
  "state": {
    "outcome": "completed",
    "evidence": {}
  },
  "questions": {
    "next_action": {
      "type": "choice",
      "instructions": "Select the safest next workflow action.",
      "criteria": {
        "continue": "The result is complete and consistent.",
        "retry": "The problem appears transient or recoverable.",
        "review": "The evidence is ambiguous or requires judgment."
      }
    }
  }
}
```

The response shape is approximately:

```json
{
  "answers": {
    "next_action": {
      "type": "choice",
      "choice": "continue",
      "probabilities": {
        "continue": 0.94,
        "retry": 0.04,
        "review": 0.02
      }
    }
  },
  "model": "resolved-model",
  "usage": {}
}
```

The workflow runtime, not the model, converts that bounded answer into a state
transition. It verifies the answer is declared, applies the author's
probability threshold, chooses the declared fallback when uncertain, and
rejects any undeclared target.

Use a generative model when a state needs open-ended reasoning, content, code,
tool use, or iterative investigation. Use a decision model when the relevant
context already exists and the remaining task is to make one bounded,
machine-actionable judgment.

## Quick scenario

A workflow runs an automated validation state. The state can complete with a
successful result while still leaving evidence that needs interpretation. The
workflow must choose one of three next steps:

- `continue`: evidence is complete and consistent.
- `retry`: the failure appears transient or evidence is incomplete.
- `review`: the decision is uncertain or needs human judgment.

The decision model receives the accepted state result and a fixed set of
declared choices. It returns one choice plus a probability for every choice.
The workflow automatically advances only when the selected probability meets
the workflow author's threshold. Otherwise it takes the declared `review`
route.

## Proposed authoring model

```yaml
states:
  validate:
    type: agent
    agent: validation-agent
    input:
      request: ${inputs.request}
    result:
      schema: validation/result/v1
    completion:
      mode: one-shot
      outcomes:
        - completed
        - invalid

    transition:
      resolver:
        type: decision
        provider: ${configuration.transitionDecisionProvider}
        question:
          type: choice
          instructions: Select the safest next workflow action.
          choices:
            continue:
              description: The result is complete, consistent, and ready to use.
              target: execute
            retry:
              description: The result indicates a transient or recoverable problem.
              target: validate
            review:
              description: The evidence is ambiguous or requires human judgment.
              target: human_review

        input:
          outcome: ${current.outcome}
          output: ${current.output}
          history: ${execution.history}

        policy:
          minimumProbability: 0.90
          onUncertain: review
          onUnavailable: review

  execute:
    type: agent
    agent: execution-agent
    # ...

  human_review:
    type: question
    prompt: Review the automated routing decision.
    # ...
```

The core workflow contract contains no concrete model name. The `provider`
value resolves through deployment configuration, so an environment can use a
decision model, another compatible implementation, or omit the capability.

## Example: bounded code-review publication decision

The following simplified workflow creates a draft pull request, leaves it open
for a six-hour review window, collects the resulting feedback, and asks a
bounded decision model whether the change is ready to publish. The model can
choose only `publish` or `refine`; uncertainty or provider unavailability keeps
the pull request as a draft and hands the feedback back to the authoring agent.

The action and agent names are illustrative provider-neutral contracts. A
deployment supplies their concrete implementations.

```yaml
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: bounded-code-review
  version: 0.1.0

configuration:
  transitionDecisionProvider:
    type: string

input:
  schema:
    type: object
    required:
      - repository
      - branch
    properties:
      repository:
        type: string
      branch:
        type: string

initialState: prepare_draft

states:
  prepare_draft:
    type: agent
    agent: change-author
    input:
      task: Prepare the requested change and open or update a draft pull request.
      repository: ${inputs.repository}
      branch: ${inputs.branch}
    result:
      schema: code-review/draft/v1
    completion:
      mode: one-shot
      outcomes:
        - draft_ready
    transition:
      handler:
        module: ./transitions.mjs
        export: toReviewWindow

  review_window:
    type: action
    action: workflow.wait
    input:
      duration: PT6H
    result:
      schema: workflow/wait/v1
    transition:
      handler:
        module: ./transitions.mjs
        export: toFeedbackCollection

  collect_feedback:
    type: action
    action: pull-request.collect-feedback
    input:
      pullRequest: ${states.prepare_draft.output.pullRequest}
      include:
        - reviews
        - reviewThreads
        - checkResults
    result:
      schema: code-review/feedback/v1
    transition:
      resolver:
        type: decision
        provider: ${configuration.transitionDecisionProvider}
        question:
          type: choice
          instructions: Decide whether the draft is ready to publish or needs another refinement pass.
          choices:
            publish:
              description: Required checks pass and no unresolved feedback blocks publication.
              target: publish
            refine:
              description: Feedback, failed checks, uncertainty, or missing evidence requires more work.
              target: refine
        input:
          draft: ${states.prepare_draft.output}
          feedback: ${current.output}
          history: ${execution.history}
        policy:
          minimumProbability: 0.90
          onUncertain: refine
          onUnavailable: refine

  publish:
    type: action
    action: pull-request.mark-ready
    input:
      pullRequest: ${states.prepare_draft.output.pullRequest}
      decision: ${transition.resolution}
    result:
      schema: code-review/publication/v1

  refine:
    type: agent
    agent: change-author
    input:
      task: Address the review feedback while keeping the pull request in draft.
      pullRequest: ${states.prepare_draft.output.pullRequest}
      feedback: ${states.collect_feedback.output}
      decision: ${transition.resolution}
    result:
      schema: code-review/refinement/v1
    completion:
      mode: one-shot
      outcomes:
        - draft_updated
    transition:
      handler:
        module: ./transitions.mjs
        export: returnToReviewWindow
```

The six-hour delay and feedback retrieval occur through durable activities.
The decision activity records the selected label, probabilities, threshold,
and fallback result. A replay therefore neither waits for another six hours
nor asks the model to decide again. Publication remains a separate,
auditable action; the decision model never calls the pull-request system
directly.

## Runtime sequence

1. The workflow state runs normally.
2. Its result is accepted and durably recorded.
3. The controller schedules a Duroxide transition-resolution activity with:
   - workflow and state identity;
   - execution sequence;
   - accepted state outcome and output;
   - declared choices and targets;
   - threshold and fallback policy;
   - a stable idempotency key.
4. The activity resolves templates and calls the configured decision provider.
5. The activity validates the response and applies the declared policy.
6. The activity returns a rich transition directive.
7. Duroxide persists that activity result.
8. The controller validates that the selected target was declared and advances.
9. On orchestration replay, Duroxide supplies the recorded activity result. The
   model is not called again.

The model call must never run directly inside the orchestration generator.
Only a scheduled activity may perform external inference.

## Durable transition result

```json
{
  "kind": "advance",
  "target": "execute",
  "resolution": {
    "type": "decision",
    "selection": "continue",
    "probabilities": {
      "continue": 0.94,
      "retry": 0.04,
      "review": 0.02
    },
    "selectedProbability": 0.94,
    "threshold": 0.9,
    "policyResult": "accepted",
    "provider": "configured-provider",
    "model": "resolved-deployment",
    "latencyMs": 110,
    "requestId": "stable-provider-request-id"
  }
}
```

The transition target remains validated against the compiled manifest.
Unexpected choices, missing probabilities, non-finite values, or undeclared
targets fail closed.

Low probability is not an execution error. It produces a normal, declared
fallback decision such as `review`. Provider timeout or unavailability follows
the separately declared `onUnavailable` route.

## Duroxide changes

The current registered workflow controller already schedules transition
execution as an activity. We should evolve that seam rather than place model
logic in the controller.

### Activity contract

Add a new versioned transition activity, for example:

```text
resolveWorkflowTransitionV3
```

Its input should contain the compiled transition resolver and immutable
transition context. Its output should be the rich directive above.

The activity version must change because the output contract expands beyond
the current target-only `advance` directive.

### Replay and retries

- Duroxide history is the source of truth for the selected transition.
- Replays consume the persisted activity output.
- Activity retries use a stable request ID derived from workflow session ID,
  state ID, and execution sequence.
- The provider adapter should forward that ID when its API supports
  idempotency.
- A response received and recorded by Duroxide must never be recomputed.
- If the provider completed but the worker failed before recording completion,
  a retry can occur; provider-side idempotency reduces duplicate inference.

### Query and portal projection

Duroxide durability is sufficient for correct replay, but the transition
decision should also be projected into a query-friendly record for operators.
Store or project:

- resolver type;
- selected label and target;
- probability distribution;
- configured threshold;
- accepted, deferred, or unavailable policy result;
- provider/model identity;
- latency and completion time.

The portal can then render a generic "Decision transition" section without
parsing raw orchestration history.

## Compiler and manifest changes

Change `transition` from a handler-only shape into a tagged union:

```yaml
transition:
  handler:
    module: ./transitions.mjs
    export: afterValidate
```

or:

```yaml
transition:
  resolver:
    type: decision
    # ...
```

The compiler must:

- preserve the existing handler form unchanged;
- validate every choice and target;
- require at least two choices;
- require `minimumProbability` to be between 0 and 1;
- require declared uncertainty and unavailability behavior;
- validate all templates at registration time;
- include the resolver configuration in the compiled-manifest hash;
- reject provider- or model-generated undeclared targets.

## Provider abstraction

Add a provider-neutral decision registry, parallel to workflow action and
observed-condition providers:

```ts
registerDecision(providerId, handler)
```

The generic request supports:

- `noul` for binary gates;
- `choice` for routing;
- `score` for grading or prioritization.

The generic response contains typed answers and probability distributions.
Provider-specific request and response shapes remain inside the adapter.

The first adapter can target any compatible decision endpoint, but no vendor,
model, account, deployment, or environment name should be added to the
workflow compiler or core YAML schema.

## Decision transition versus decision state

Use a decision transition when the result exists only to select the next
target.

Use a first-class decision state when its scores are business output that later
states need to consume, compare, or present independently of routing. Both can
share the same provider registry and response validation.

## Implementation slices

1. **Stage provider adapter**
   - Implement a generic decision client and validate `noul`, `choice`, and
     `score` responses.
   - Exercise it through a provider-adapter integration test.

2. **Durable transition activity**
   - Add the versioned Duroxide activity and rich transition directive.
   - Prove replay does not invoke the provider twice.

3. **Compiler support**
   - Add the resolver transition union and registration validation.
   - Keep deterministic handlers fully backward compatible.

4. **Persistence and portal**
   - Project decision evidence for query and visualization.
   - Show selected route, probabilities, threshold, and fallback behavior.

5. **Workflow acceptance**
   - High-confidence route.
   - Low-confidence defer route.
   - Provider-unavailable fallback.
   - Invalid or undeclared choice rejection.
   - Worker restart and Duroxide replay without another model call.

## Non-goals for the first slice

- Replacing deterministic transitions.
- Allowing a model to invent state IDs or targets.
- Changing an agent's tools or model in the middle of a child session.
- Treating a probability threshold as a universal safety guarantee.
- Hiding uncertainty by selecting the top option unconditionally.
