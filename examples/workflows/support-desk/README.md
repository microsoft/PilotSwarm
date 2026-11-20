# Example Workflow: support desk triage

A support desk triages a small batch of tickets and writes a shift summary. One
Workflow combines all three kinds of work:

- **Decision** states for the closed questions: which queue (`choice`, with a
  confidence threshold and an `uncertain` route), how severe (`score`), and a
  guardrail, "does this draft promise a refund?" (`noul`).
- **Script** states for the mechanical parts: tidy the batch, turn the severity
  score into a priority and response target, record each ticket's result, and
  count the shift report.
- **Agent** states for the writing: a reply draft per ticket and the shift
  summary. Both are inline prompts with `tools: none`, a strict `outputSchema`
  and a time limit, so they only complete their node.

All tickets and customers are synthetic.

## The graph

```text
prepare_batch (script) --ready--> triage_tickets (For each ticket, one at a time)
  per ticket:
    classify (Decision: choice) --billing|technical|account--> assess_severity (Decision: score)
      --scored--> set_priority (script) --prioritized--> draft_reply (agent)
      --drafted--> check_refund_promise (Decision: noul) --no--> close_ticket (script) --> ticket_answered
    classify --uncertain|failure--> queue_for_review (script) --> ticket_for_review
    assess_severity, draft_reply --failure--> queue_for_review
    check_refund_promise --yes|uncertain|failure--> queue_for_review
    a script failure --> ticket_failed (the join is then blocked)
--joined--> write_summary (agent) --written--> publish_summary (script) --published--> done
triage_tickets --blocked--> triage_blocked; other runtime errors --> failed (output: the error)
```

A Decision's output is only its semantic result, so each Decision and agent
state declares `carry` to keep the ticket next to it. For example,
`check_refund_promise` carries `{ stage, case, draft }`, and the next state reads
`input.carry.case.ticket` and `input.result.outcome`. Decision and agent errors
send a ticket to a person rather than blocking the batch, and `stage` in the
carry tells `queue_for_review` where the ticket came from.

## Files

| File | What it is |
|---|---|
| `support-desk.workflow.yaml` | The Workflow definition (`metadata.name: support-desk`). |
| `sample-input.json` | The Start inputs: a shift name and four tickets: a clear billing ticket, a clear technical ticket, an account question, and an ambiguous ticket (a payment page that spins: billing or technical?). |
| `fixtures.json` | Prepared answers for a fully mocked test: a raw provider body for each of the 10 Decision calls and a completion for each of the 4 agent calls, matched to each ticket by the state's exact input (`arguments`). |
| `seed.json` | The exact `workflow_definition` arguments: `save`, `test` and `start`. Regenerate it with `node examples/workflows/support-desk/make-seed.mjs` after changing the files above. |

The SDK test `packages/sdk/test/local/workflow-example-support-desk.test.js`
compiles this YAML, checks `seed.json` matches it, and runs the mocked test.

## Try it in a session

The Decision states need a **Cluster Decision Default** (an admin sets it in
Admin Settings). Without one, Save marks the revision invalid and Start and
Test refuse with `WORKFLOW_DECISION_MODEL_UNAVAILABLE`.

1. **Save.** In a session, give the agent the YAML and ask it to save it as a
   workflow definition named `support-desk`, or have it call
   `workflow_definition` with `seed.json`'s `save` object. The receipt should
   be valid with no errors or warnings.
2. **Test it, mocked.** Ask the agent to test it with the `test` object from
   `seed.json` (the sample inputs, `fixtures.json` and `expect: done`). Nothing
   calls a provider or a model. The report passes and ends at `done`; its
   `path` lists each step with `branch: "item N"` for the tickets.
3. **Start it live.** Call `workflow_definition` with the `start` object (the
   same four tickets), or select **Start…** in the Definition view and give it
   the contents of `sample-input.json` as its inputs. Agent states use the session's chat model
   unless you choose one in the Start form (`agent_models`); every Decision
   state uses the Cluster Decision Default unless you choose another Decision
   model (`decision_models`).

## What to look at in the graph

- **Repeated visits.** The For each runs the body once per ticket, so
  `classify` has four visits, and `assess_severity`, `set_priority`,
  `draft_reply` and `check_refund_promise` three each. Pick a ticket (item) on a
  body node to see that visit's input and output: each `classify` visit gets a
  different subject and body and returns a different queue and probabilities.
- **The `uncertain` route.** T-1004 is ambiguous. In the mocked test the
  Decision returns billing 0.52 and technical 0.44; 0.52 is below the 0.8
  threshold, so `classify` takes `uncertain` and `queue_for_review` writes
  "Queue unclear: billing 52%, technical 44%, account 4% (needs 80%)."
- **The score and the priority.** `assess_severity` returns a score from 0
  (Low) to 3 (Critical) with a probability per level; `set_priority` rounds it
  (2.12 is High: P2, an 8-hour target).
- **The guardrail.** T-1001 asks for $49.00 back. In the mocked test the draft
  says "We have refunded the extra $49.00", `check_refund_promise` answers
  `yes` (0.93), and the ticket waits for a billing lead. The technical and
  account drafts pass (`no`) and are answered.
- **Carry.** Open `set_priority` or `close_ticket`: the input is
  `{ carry, result }`, with the ticket in `carry` and the Decision's result in
  `result`.
- **Replay.** The timeline under the graph steps through the run in order:
  one ticket at a time, then the summary.

Mocked routes for the sample input (29 node visits in all):

| Ticket | Route | Ends |
|---|---|---|
| T-1001 Contoso Bakery | classify `billing` → assess_severity `scored` (1.3: Normal, P3) → set_priority → draft_reply → check_refund_promise `yes` → queue_for_review | needs review (guardrail) |
| T-1002 Fabrikam Logistics | classify `technical` → assess_severity `scored` (2.12: High, P2) → set_priority → draft_reply → check_refund_promise `no` → close_ticket | answered |
| T-1003 Northwind Traders | classify `account` → assess_severity `scored` (0.31: Low, P4) → set_priority → draft_reply → check_refund_promise `no` → close_ticket | answered |
| T-1004 Tailspin Toys | classify `uncertain` → queue_for_review | needs review (queue unclear) |

Then `write_summary` and `publish_summary` run once each and the run ends at
`done`, with totals of 2 answered and 2 needing review.

## Running it live

- **Results vary.** Live answers come from the Decision model and the chat
  model, so a ticket may take another route than in the mocked test: T-1004 may
  get a confident queue, and the T-1001 draft is held only if it really
  promises money back.
- **Rate.** Tickets run one at a time (`concurrency: 1`). Each ticket makes at
  most 3 Decision calls (at most 12 for the sample, 10 on the mocked routes),
  and an agent turn separates each ticket's guardrail from its first two
  calls, which keeps a run typically well under a deployment limit of 10
  requests a minute. A throttled call (`unavailable`) sends that ticket to a
  person; the run still ends at `done`.
- **Agent cost.** At most one `draft_reply` visit per ticket plus one
  `write_summary`: 4 to 5 agent visits for the sample, each a fresh session
  with no tools.
- **Duration.** Usually a few minutes, mostly agent turns. Limits: 30 seconds
  per Decision, 300 seconds per agent visit, 1,800 seconds for the For each,
  3,600 seconds for the run.
