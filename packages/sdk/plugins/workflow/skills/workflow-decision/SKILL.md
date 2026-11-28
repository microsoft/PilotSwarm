---
name: workflow-decision
description: "Load before you write a Workflow decision state: when to use one instead of an agent or a script, the choice, noul and score routes, confidence and uncertain, what Save and Start need, and two examples."
---

# Decision states

Call `load_skill` with name `workflow-authoring` first. Exact fields and
output shapes are in `workflow-reference` (section `decision`).

A `decision` state asks a Decision model one typed question about the
state's input and routes on the answer: one provider call, no tools, a
calibrated probability and one static route per answer. The answer is
advice. It grants nothing.

## When to use one

| You need | Use |
|---|---|
| The input in one of a few fixed classes | `decision`, `choice` |
| A yes or no about the input | `decision`, `noul` |
| A rating on an ordered scale | `decision`, `score` |
| Investigation, tools, writing, or open-ended judgment | `agent` |
| A fixed rule or computation | `script` |
| A person's consent | `approval`, after the decision |

In a chat turn, outside a Workflow, call the `decide` tool instead. It
takes the same `question` and returns the same answer, in `decision`.

## Fields and routes

| Field | Rule |
|---|---|
| `input` | Optional template; default: the value that arrived. The model judges this value. |
| `inputSchema` | Optional. |
| `question` | Required: `type`, `instructions` (static text: what to judge, and how) and `criteria` (optional for `noul`). |
| `confidence` | Optional `{ minimumProbability: <0 to 1> }`; not for `score`. |
| `supply` | Optional `never` to refuse a supplied outcome when re-running from this step. |
| `timeoutSeconds` | Optional literal integer 1 to 86,400; default 30. |

| `question.type` | `criteria` | Routes you must give |
|---|---|---|
| `choice` | `{ <label>: <description> }`, at least 2 labels | every label; `uncertain` with `confidence` |
| `noul` | omit, or exactly `{ true: <description>, false: <description> }` | `yes`, `no`; `uncertain` with `confidence` |
| `score` | ordered list of at least 2 distinct level names, lowest first | `scored` only |

You may add runtime-code routes (such as `timed_out`, `unavailable` or
`budget_exceeded`) and `failure`, which takes every runtime error without
its own route. A missing or extra answer route is a save error.

`confidence`: `choice` uses the chosen label's probability, `noul` the
larger of yes and no. Below `minimumProbability` takes `uncertain`; equal
does not. Send `uncertain` to an agent or a person, not to the action of a
confident answer.

The output reaches the next state: `${input.outcome}`,
`${input.confidence}` and `${input.selection}`; for `score`,
`${input.score}` and `${input.levels}`. Keep other data in `inputs` or carry.

## What Save and Start need

- Save flags and Start refuses Decision states without an eligible Cluster Decision Default.
  An administrator sets it in Admin Settings, or
  with `set_model_default` with scope `cluster` and purpose `decision`.
  Tell the user what is missing; do not swap in an agent without asking.
- YAML never names a model. Start can choose one with `decision_models`
  (`workflow-tools`).
- Each call is admitted against the provider's budget and recorded in the
  usage ledger.

## Pitfalls

- Labels and texts are static: no `${...}` and no options built from data.
  Put the data in `input`.
- A `choice` label is a route label: a letter, then letters, digits, `_`
  or `-`; `uncertain`, `scored`, `failure` and the runtime codes are
  reserved. `score` levels are distinct static names, not routes.
- Describe every `choice` label. Ask one question per state. Keep lists short:
  a provider may refuse a long one (`invalid_input`; TypeSafe takes at most
  255 labels and 10 levels).
- A decision never acts or approves. Route its answer to the state that
  acts, and through `approval` when a person must consent.

## Classify and route

```yaml
# example: ticket-triage
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ticket-triage, version: "1.0.0" }
description: Routes one support ticket by a Decision model; an agent decides when the model is unsure.
inputs: { schema: { type: object, required: [ticket], properties: { ticket: { type: string, minLength: 1 } } } }
initial: classify
initialInput: { ticket: "${inputs.ticket}" }
states:
  classify:
    type: decision
    question:
      type: choice
      instructions: Pick the team that must handle this support ticket.
      criteria:
        billing: Charges, invoices, refunds or payment methods.
        engineering: A defect, an outage or an error message.
        account: Sign-in, access or profile changes.
    confidence: { minimumProbability: 0.8 }
    transition:
      next: { billing: routed, engineering: routed, account: routed, uncertain: review, failure: failed }
  review:
    type: agent
    invoke: { prompt: "Read the ticket and the Decision answer, pick the team that must handle it, and complete with that outcome and output { team }." }
    input: { ticket: "${inputs.ticket}", decision: "${input}" }
    outputSchema: { type: object, required: [team], properties: { team: { enum: [billing, engineering, account] } } }
    timeoutSeconds: 1800
    transition:
      next: { billing: reviewed, engineering: reviewed, account: reviewed, failure: failed }
  routed: { type: terminal, outcome: succeeded, output: { team: "${input.outcome}", confidence: "${input.confidence}" } }
  reviewed: { type: terminal, outcome: succeeded, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

## A guard before consent

```yaml
# example: refund-guard
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: refund-guard, version: "1.0.0" }
description: A Decision model checks a refund request against policy; the run succeeds only if the owner then approves it.
inputs: { schema: { type: object, required: [request], properties: { request: { type: string, minLength: 1 } } } }
initial: check
initialInput: { request: "${inputs.request}" }
states:
  check:
    type: decision
    question:
      type: noul
      instructions: Does this refund request meet the policy (within 30 days of purchase, and no earlier refund for the order)?
    confidence: { minimumProbability: 0.9 }
    transition: { next: { yes: consent, no: refused, uncertain: consent, failure: failed } }
  consent:
    type: approval
    question: Approve this refund?
    input: { request: "${inputs.request}", check: "${input}" }
    timeoutSeconds: 172800
    transition: { next: { approved: approved, rejected: refused, timed_out: refused, failure: failed } }
  approved: { type: terminal, outcome: succeeded, output: { request: "${inputs.request}" } }
  refused: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```
