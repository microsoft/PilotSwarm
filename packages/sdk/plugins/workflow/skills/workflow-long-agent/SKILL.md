---
name: workflow-long-agent
description: Keep one agent session across short Workflow visits and sleep on Workflow wait states between them. Deadline guards, multi-day waits, typed outcomes and a bounded example.
---

# An agent that lives long and sleeps

Call `load_skill` with name `workflow-authoring` first.
`session: continue` keeps an agent session until the Workflow ends; it does
not extend a visit's deadline. Each visit lasts at most 86,400 seconds.
Do one look, complete with the task's `sleep` outcome, then let a Workflow
wait hold the delay. The next visit keeps the agent's memory and names a new
`node_execution_id`. Complete that visit, not the earlier one.

```yaml
# example: long-agent
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: long-agent, version: "1.0.0" }
description: Looks at an authorized task up to three times, sleeping between visits.
inputs:
  schema:
    type: object
    required: [target]
    properties: { target: { type: string } }
initial: look
initialInput: { checks: 0, target: "${inputs.target}" }
limits: { maxNodeExecutions: 10 }
states:
  look:
    type: agent
    session: continue
    timeoutSeconds: 1800
    invoke:
      prompt: >-
        Inspect input.target once using your permitted read-only tools.
        Increment input.checks. Return done if the task is finished, otherwise
        gave_up at three checks, otherwise sleep. In each output include target,
        checks and seconds (172800 for the next look). Do not schedule yourself.
    inputSchema:
      type: object
      required: [target, checks]
      properties:
        target: { type: string }
        checks: { type: integer, minimum: 0, maximum: 3 }
    outputSchema:
      type: object
      required: [target, checks, seconds]
      properties:
        target: { type: string }
        checks: { type: integer, minimum: 1, maximum: 3 }
        seconds: { type: integer, minimum: 1, maximum: 2592000 }
    outcomes: [done, sleep, gave_up]
    transition: { next: { done: finished, sleep: nap, gave_up: unknown, failure: failed } }
  nap:
    type: wait
    seconds: "${input.seconds}"
    transition: { next: { elapsed: look, failure: failed } }
  finished: { type: terminal, outcome: succeeded, output: "${input}" }
  unknown: { type: terminal, outcome: blocked, output: "${input}" }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

Replace the task and target with the authorized work. Agent results are
judgment, not proof of external state: require evidence when it matters.
Three looks, two waits and one terminal use six state visits; the budget of
ten leaves room but stops a model that repeats the wrong count. A visit
timeout goes to failure, never straight back to the same agent.

A wait state's `seconds`, literal or bound, may reach 2,592,000 (30 days).
Request, receive, agent and parallel deadlines remain at most 86,400.
`limits.timeoutSeconds` still bounds the whole run; a literal wait longer
than that limit warns. Pause does not freeze deadlines. Call `load_skill`
with name `workflow-polling` for larger loop budgets and authorized re-arming.

Inside a direct agent child, `wait` and `wait_on_worker` must end before this
visit's deadline; `cron` and `cron_at` must have a first fire before it.
A refusal names the deadline: shorten the delay, or use the task's sleep
outcome. A schedule allowed at tool time is still subject to the visit
deadline; do not use it to keep the visit alive. Cancelling a schedule is
always allowed. Ordinary sessions and the agent's descendants are not
changed by this guard.

Continued sessions clear inherited cron schedules at the visit boundary.
An old one-shot wait can still cause one stray turn; do not leave such a
wait pending when handing a longer sleep to the Workflow.
