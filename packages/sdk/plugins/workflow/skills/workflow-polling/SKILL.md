---
name: workflow-polling
description: "Bounded polling, multi-day observation and uncertain effects: state-visit budgets, loop data, authorized re-arming and unknown results."
---

# Bounded observation

Read `workflow-authoring`. No unbounded or exactly-once execution.

## Visit budget

`limits.maxNodeExecutions`: default 1,000, maximum 10,000, counting waits,
branches and terminals. The cap fails with `limit_exceeded`; reserve exit visits.

Let `B` be the run's visit budget, `R` the visits reserved for setup,
notifications, errors and the terminal, and `C` the most visits in one
polling round. A conservative maximum is `P = floor((B - R) / C)` polls.
Include branches and retries in `C` or `R`, not an agent's internal tool
calls. Reject `B <= R` or `C < 1`.

| B | R | C | P |
|---|---|---|---|
| 1,000 | 20 | 2 | 490 |
| 10,000 | 20 | 2 | 4,990 |
| 10,000 | 20 | 4 | 2,495 |

For one immediate check then one check every `S` seconds, covering `D`
seconds needs approximately `ceil(D / S) + 1` checks. Provision at least
`C * (ceil(D / S) + 1) + R` visits. Execution adds time: this is not a
wall-clock guarantee.

| Observation | Wait between checks | Checks | Visits with C=2, R=20 |
|---|---|---|---|
| 7 days | 15 minutes | 673 | 1,366 |
| 14 days | 1 hour | 337 | 694 |
| 28 days | 6 hours | 113 | 246 |

- A wait state's `seconds` is 1 to 2,592,000 (30 days) **per visit**, not per
  run. A literal longer than the run timeout warns. Request, receive, agent
  and parallel deadlines stay at 24 hours. Calendar `at` names a clock time.
- `limits.timeoutSeconds` is optional, with a maximum of 2,592,000 seconds
  (30 days). Omitting it adds no deadline, but the visit limit still applies.
  Pause does not stop the deadline; expiry fails with `timed_out`.
- Exit before the cap. More states per round need fewer rounds.

## Poll without false success

Parent/person variables: `maxChecks` (default 30, clipped at 490) and
`pollSeconds` (default 60, 1 to 2,592,000). The hard cap protects 1,000 visits
even after KV changes. The wait removes `ciState` for the closed schema.
Replace `get_ci_state` with your read-only tool (`pending`, `success` or
`failure`). CI finishing is observation success, not CI success. Pending
at the count limit is blocked.

```yaml
# example: ci-poll
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ci-poll, version: "1.0.0" }
description: Observes CI. Variables maxChecks (1-490) and pollSeconds (1-2592000) are optional.
initial: check_ci
initialInput: { checks: 0 }
limits: { maxNodeExecutions: 1000 }
states:
  check_ci:
    type: script
    inputSchema: { type: object, additionalProperties: false, required: [checks], properties: { checks: { type: integer, minimum: 0 } } }
    outcomes: [pending, done, gave_up]
    source: |
      const requested = context.kv.maxChecks ?? 30;
      if (!Number.isInteger(requested) || requested < 1) throw new Error("maxChecks must be a positive integer");
      const most = Math.min(requested, 490);
      const checks = context.input.checks + 1;
      const { state } = await callTool("get_ci_state", {});
      if (!["pending", "success", "failure"].includes(state)) throw new Error("Unrecognized CI state");
      const outcome = state !== "pending" ? "done" : checks >= most ? "gave_up" : "pending";
      await setResult(outcome, { checks, ciState: state });
    transition: { next: { pending: wait_ci, done: done, gave_up: exhausted, failure: failed } }
  wait_ci:
    type: wait
    seconds: "${kv.pollSeconds ?? 60}"
    input: { checks: "${input.checks}" }
    transition: { next: { elapsed: check_ci, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "${input}" }
  exhausted:
    type: terminal
    outcome: blocked
    summary: CI is still pending; the observation count is exhausted.
    output: { outcome: unknown, reason: poll_limit, observation: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

## Data across routes

Static target ids and immutable payloads belong in required run `inputs`.
Counters travel in each output. Agents must return the loop fields.
Waits pass their input on.
After a script runtime error the next input is only its error envelope;
after `sent` only the receipt; after a request only its response/refusal.
Neither script mutation of `context.kv` nor a `carry` field persists state:
no state writes run variables, and `carry` is not a supported field.

Do not reset a missing counter to zero on an error route: it loses the
bound. End blocked/failed and ask the parent to reconcile the checkpoint.
A permitted external store can hold explicit checkpoints, but its writes
are separate effects, not atomic with Workflow routing. Scope them to the
observation and design for replay and concurrent writers.

## Re-arm a bounded segment

Re-arm only when the user authorized continued observation. Otherwise
report the final result and stop. The parent, not a script, starts the next
run: scripts cannot call Workflow tools.

1. End the segment before its cap with an explicit checkpoint in terminal
   `output`: target, cursor, total checks, deduplication identity and reason.
2. Confirm the old run ended and reconcile uncertain effects. A failed run
   may lack a final checkpoint; do not invent one or repeat a write.
3. Start one successor from the intended definition revision, supplying
   checkpoint fields as declared inputs and required KV values explicitly.
   Reconcile an ambiguous start response before another start attempt.

A successor is a new run, not a resume of a completed run. Latest saved
definitions may differ: verify the intended revision before starting.
Keep deduplication keys across segments and prevent overlap. Observation
gaps are possible; renewal is not automatic.

## An external effect can remain unknown

No terminal `unknown` exists. Use `blocked` plus `output.outcome: unknown`, a reason,
the operation identity and the original error. The UI still says Blocked;
the output carries the uncertainty. Give the terminal its own
`outputSchema` when validation matters: root `outputSchema` checks only
`succeeded`. Null output or a summary alone loses machine-readable detail.

For a send, `sent` proves queue acceptance, not processing or success.
`delivery_failed` can mean the recipient queued it before the reply
failed. Do not blindly resend. Reconcile using an authorized read or an
external idempotency key; if unavailable, keep the outcome unknown.

The graph sends once; the transport can retry. The receiver must
deduplicate `operationId`. This is not exactly-once delivery.

```yaml
# example: uncertain-send
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: uncertain-send, version: "1.0.0" }
inputs: { schema: { $ref: "#/schemas/Operation" } }
schemas:
  Operation: { type: object, additionalProperties: false, required: [operationId], properties: { operationId: { type: string, minLength: 1 } } }
contracts:
  Observe@1: { schema: { $ref: "#/schemas/Operation" } }
initial: send
states:
  send:
    type: messaging
    mode: send
    contract: Observe@1
    recipient: { parent: true }
    input: { operationId: "${inputs.operationId}" }
    transition: { next: { sent: accepted, delivery_failed: uncertain, failure: failed } }
  accepted:
    type: terminal
    outcome: succeeded
    summary: The queue accepted the message; processing is not confirmed.
    output: { outcome: accepted, operationId: "${inputs.operationId}", receipt: "${input}" }
  uncertain:
    type: terminal
    outcome: blocked
    summary: Delivery could not be confirmed. Reconcile before retrying.
    output: { outcome: unknown, operationId: "${inputs.operationId}", error: "${runtime.error}" }
    outputSchema:
      type: object
      additionalProperties: false
      required: [outcome, operationId, error]
      properties:
        outcome: { const: unknown }
        operationId: { type: string, minLength: 1 }
        error: { type: object, required: [code, message], properties: { code: { type: string }, message: { type: string } } }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```
