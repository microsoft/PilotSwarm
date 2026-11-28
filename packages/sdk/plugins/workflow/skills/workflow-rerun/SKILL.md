---
name: workflow-rerun
description: Re-run an ended Workflow from a step - run_again, continue, or supply a step's checked result - with rerun_plan, revision fit, every refusal and the v1 limits.
---

# Re-run a Workflow from a step

A re-run starts a new Workflow from an ended one. The steps before the chosen
step are reused: they do not run again. The new Workflow goes on from there.
The ended Workflow (the source) never changes.

Use a re-run when the first steps did real work that must not happen twice.
To start again from the first step, use a plain `start` with `inputs` (Run
again). If the person says "from scratch", do not re-run from a step.

## The three modes

| Mode | The chosen step | Use it when |
|---|---|---|
| `run_again` | Runs again (on the revision you start). | The step failed or threw, and a retry or a fix can make it pass. |
| `continue` | Keeps its result; the step after it runs. | The step finished with a valid result, but the run stopped after it (a route that changed, `limit_exceeded`, a stop). |
| `supply` | Does not run. You give its result. | External work finished, but the step timed out or failed before it reported (for example, a server was created). |

## How to re-run

1. Read the plan. It changes nothing:
   `read_workflow({ workflow_id, rerun_plan: { execution_id?, mode?, revision?, outcome? } })`.
   It is a read of its own: give no other read argument. It takes an
   `outcome` only, never an `output`.
2. Read `plan.from` (the step and visit), `plan.mode`, `plan.modesAvailable`,
   `plan.revision.fits`, `plan.warnings`, `plan.carried` (messages the
   re-run takes), `plan.allowed` and `plan.blockedReason`.
3. Start it:
   `workflow_definition({ operation: "start", rerun_from: { workflow_id, execution_id?, mode?, result?, note? }, revision?, update?, vars?, key?, agent_models?, decision_models? })`.
   - `name` and `definition_id` may be omitted: the definition is the one
     the source was started from.
   - Omit `inputs` and `workspace`. A re-run takes the source's inputs and
     keeps its workspace, also on a session with no turn yet.
   - `run_again_of` and a child field are refused.
   - `result` and `note` are for `supply` only.
4. Tell the person it is a new Workflow (`rerun.ofWorkflowId`, `rerun.mode`,
   `rerun.reused`) and which step runs first.

Over MCP the same calls are `read_workflow { session_id, rerun_plan }` and
`workflow_definition { operation: "start", owner_session_id, rerun_from }`.

## Auto-pick

Omit `execution_id` and the step is picked from how the source ended. Auto-pick
never picks `supply`.

| Source ended | Step picked | Mode |
|---|---|---|
| A step failed and no route took the error | That step (or its `parallel` step) | `run_again` |
| A step gave an outcome that no route took | That step | `continue` |
| At a terminal with outcome `failed` | The first failed step before it, else the step before the terminal | `run_again` |
| `limit_exceeded` | The last step | `continue` |
| Stopped, cancelled, run timeout | The last step | `continue` if it has a real result, else `run_again` |
| At a terminal that `succeeded`, `blocked` or `cancelled` | Nothing: `400 RERUN_VISIT_REQUIRED` | Name `execution_id` |

Spawn cut-back: when auto-pick (`run_again`) would reuse a `spawn` step whose
child was cancelled when the source ended, or that has no end notice, the cut
moves back to that `spawn` step (or to the `parallel` step that holds it). A
fresh child starts. That step and every step after it run again: if the spawn
was step 2 and the source failed at step 12, steps 2 to 12 all run again.

`execution_id` without `mode` means `run_again`. `supply` always needs
`execution_id`.

## Revision

- The default is the source Workflow's revision, not the newest one.
- After you save a fix, pass `revision` (the plan shows
  `plan.revision.newestValid` and `newestValidFits`). For an attached package
  definition, `update: true` attaches the newer package version first.
- The revision must fit the reused steps. A plan shows `fits: false` and
  `problems`; Start refuses `422 RERUN_INCOMPATIBLE` with `details.problems`.

What fit means (C1 to C10):

1. C1: every reused step, and a supplied step, still exists with the same type
   (and the same messaging mode).
2. C2: no reused step moved in or out of a `parallel` step; the chosen step
   is top-level; `initial` is still the first reused step.
3. C3: each reused step still routes to the next reused step by the same route.
4. C4: the step after the cut is still reachable: the step before a `run_again`
   step routes to it; a continued step's result, or a supplied outcome, has a
   route.
5. C5: `catchAll` is the same state when the reused steps used it, and it is
   not used twice.
6. C6: the step just before the cut still declares `carry` exactly when it did.
7. C7: a reused `parallel` step has the same named branches.
8. C8: `limits.maxNodeExecutions` is larger than the reused visits (plus a
   supplied one), and a supplied visit is within the step's `maxVisits`.
9. C9: the source ran on a controller that supports re-runs.
10. C10: the normal Start checks pass on the revision: it is valid, the
    source inputs match `inputs.schema`, scripts may run, tools and models
    are available.

## Supply a step's result

- Only a top-level `script` or `agent` step. Never an approval, wait,
  decision, spawn, messaging or `parallel` step, and never a step inside a
  lane.
- A step with `supply: never` (on the source or the target revision) is
  refused. Authors set it on steps whose result must come from real work.
- `result: { outcome, output? }`: `outcome` must be a declared business
  outcome of the step with a route; `output` must match the step's
  `outputSchema` and be at most 256 KiB (and at most 64 levels deep).
- `note` is required: 1 to 2,000 characters.
- **Supply only values you checked in the external system; never invent ids; put the evidence in `note`.**
  If the check finds nothing (no server was created), do not supply: use
  `run_again`, or tell the person.
- **Retry rule:** to retry a `supply` Start with the same `key` or
  `operation_id`, pass the exact same `outcome`, `output` and `note`. A
  change refuses `409 OPERATION_CONFLICT`; a new attempt needs a new key.
- Read the plan with `mode: "supply"`, `execution_id` and `outcome`:
  `plan.supplyContract` shows the outcomes, the output schema and
  `maxOutputBytes`; `plan.supply` shows whether the outcome is valid and
  which step comes next.
- The supplied visit is recorded as supplied (who, why, when). It never shows
  as run.

## Approvals and tool grants

- An approval answered before the cut is reused only when its owner starts
  the re-run directly in the portal (or the Web API or SDK, not through an
  agent). An agent session and every MCP call never reuse an answered
  approval: `403 RERUN_APPROVAL_REUSED`, and the plan shows `allowed: false`.
  Choose the approval step or an earlier step, or ask the person to re-run
  it in the portal.
- `supply` on an approval step is always refused.
- Scripts that call tools need a tool grant. A session's own re-run hands its
  grant. A person who owns the session, starting directly (no
  `originating_session_id`), reuses the grant the session's agent gave the
  source (`rerun.grant: "inherited"`; plan `grantSource`). Any other caller
  gets `409 WORKFLOW_TOOLS_UNAVAILABLE`: ask the session to re-run it.

## Counts and clocks

| Kept from the source | Starts again |
|---|---|
| A step's `maxVisits` count (reused and supplied visits count) | `limits.timeoutSeconds` of the run |
| `limits.maxNodeExecutions` (reused and supplied visits count) | Step `timeoutSeconds` and `wait` |
| Variables as they were at the cut | A receive step's `wait.totalSeconds` |
| | Each carried message's lifetime (TTL) |

## Messages

A re-run carries only unread messages: messages no step received, sent
before the cut and not expired. A message that a step already received is
never carried. To keep a message a step already received, re-run from the
step after it. If you re-run from that receive step or an earlier step, it
needs a new message. `plan.carried` shows `{ count, contracts }`.

## Refusals

| Code | Meaning and what to do |
|---|---|
| `400 RERUN_ARGUMENT_REFUSED` | `inputs`, `workspace`, `run_again_of` or another field with `rerun_from`; `result` or `note` without `supply`; a bad `result` or `note`. Remove or fix it. |
| `400 RERUN_VISIT_REQUIRED` | Auto-pick found no step (the source succeeded), or `supply` has no `execution_id`. Name `execution_id`. |
| `403 RERUN_APPROVAL_REUSED` | The re-run would reuse an answered approval and this caller may not. Choose an earlier step or ask the person. |
| `404 RERUN_VISIT_NOT_FOUND` | `execution_id` is not a visit of the source run. Read the source again. |
| `404 WORKFLOW_NOT_FOUND` | The Workflow is not this session's, or not visible. |
| `404 WORKFLOW_DELETED` | A retry of a Start whose claimed Workflow was cleaned up before it started. Use a new `key` or `operation_id`. |
| `409 RERUN_SOURCE_ACTIVE` | The source is still running or paused. Stop it first (ask the person), then re-run. |
| `409 RERUN_SOURCE_GONE` | The source was cleaned up; only its result is kept. Use Run again (a plain `start`). |
| `409 WORKFLOW_TOOLS_UNAVAILABLE` | This Start cannot hand over the tools the scripts call. Ask the session (its agent) to re-run it. |
| `409 OPERATION_CONFLICT` | The `key` or `operation_id` was used with other arguments. Repeat them exactly, or use a new one. |
| `422 RERUN_NOT_A_WORKFLOW` | The source was not started from a saved definition, or is a test. Use a plain `start`. |
| `422 RERUN_VISIT_NOT_ALLOWED` | `reason`: `first_visit` (use Run again or `continue`), `inside_lane` (choose the `parallel` step), `terminal`, or `no_result`. |
| `422 RERUN_SUPPLY_NOT_ALLOWED` | `reason`: `step_type`, `supply_never` or `inside_lane`. Use `run_again`. |
| `422 RERUN_SUPPLIED_RESULT_INVALID` | `reason`: `undeclared_outcome`, `schema` (`details.problems`) or `too_large`. Fix the result. |
| `422 RERUN_INCOMPATIBLE` | The revision does not fit (`details.problems`). Choose another revision or an earlier step. |
| `422 RERUN_TOO_LARGE` | The reused steps hold more than 256 MiB. Choose an earlier step or use Run again. |

## Current limits (v1)

- One lane of a `parallel` step cannot re-run alone: re-run the whole
  `parallel` step.
- A parent and one of its spawned children cannot re-run together: re-run
  the parent from its `spawn` step (or re-run the child alone first).
- A continued agent step (`session: continue`) gets a fresh session with a
  summary of its reused and supplied cycles, not the old chat.
- The source must not be cleaned up. The Sweeper cleans up an ended
  Workflow after its grace window (5 minutes to 6 hours); after that, use
  Run again.
- The reused steps can hold at most 256 MiB.

## Old children and clean-up

A re-run cancels nothing. When the source ended, it already asked its
active child Workflows to end and ended its agent sessions. An old child can
still be winding down while the re-run starts a new one; they never share
work. A re-run of a spawned child, started alone, runs under the session that
owns the definition, not under the old parent.

## What the reads show

- `visit.reused`: the visit was copied (its origin `workflowId`, `runId`,
  `executionId`; `originGone` when the origin was cleaned up).
- `visit.supplied`: the result was supplied (`from`, `by`, `note`, `at`).
- `run.rerunOf`: the source, the chosen visit and the mode.
- `reruns` on the source: its re-runs.
