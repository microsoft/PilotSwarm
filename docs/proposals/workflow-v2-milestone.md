# Workflow v2 milestone: implementation notes (inactive)

Status: **inactive**. Everything in this note runs only on controller 1.9.0
and the orchestrations it starts, which only tests register (the worker
option `workflowRequests`) and only a test host starts runs at
(`WorkflowV2Host.requests`). Production workers keep controller 1.8.0, its
activities and its tool surface unchanged. Nothing here is an activation, a
deployment or a qualification result.

The approved design is the execution package of 31 October 2026 (documents
01 to 11, requirements R01 to R28). Request states have their own design
note, [workflow-messaging-request.md](workflow-messaging-request.md). This
note records how the other milestone features are implemented and where the
implementation is narrower than the design.

## Graceful stop (design 02 run lifecycle, D03)

`update_workflow` operation `stop` (run id optional, `reason` optional,
`grace_seconds` 0 to 3600, default 60):

1. The store accepts the stop once per operation id
   (`WorkflowStore.requestRunStop`, migration 0096). One reading of the
   store's clock is the stop's time; the deadline is that reading plus the
   grace. A repeat returns the receipt; another stop of a stopping run is
   `RUN_ALREADY_STOPPING`.
2. Only a run admitted for a controller that stops is accepted. Each run
   now records the controller version its admission chose
   (`workflow_runs.controller_version`). Runs admitted for 1.8.0, and runs
   admitted before migration 0096, are refused with `RUN_STOP_UNSUPPORTED`;
   cancel still applies to them.
3. A stopping run admits no new node execution, paused or not
   (`enterNode` refuses `stopping`). Pause and resume refuse it
   (`RUN_STOPPING`). A cancel, a deletion and KV updates still apply, and
   the first run end stands.
4. Controller 1.9.0 learns of the stop from a refused admission or from its
   collection (which reports the stop's deadline after the results), and
   from then on routes no result: work it admitted settles and keeps its
   result, and no successor, catch-all state or unhandled-route failure
   follows from it.
5. When no work is pending, or at the deadline by the store's clock, the
   stop activity ends the run `stopped` (`finishStoppedRun`). Work still
   pending at the deadline is cancelled with winner `stop`; the effect of
   each such script is asked to stop (`workflow.cancel_requested`, `stop:
   true`), and a running script's liveness check stops it too. The run's
   terminal error records the stop: code `stopped`, its reason, actor and
   grace, whether the grace expired, and the node executions it cancelled.
6. The parent is told as for any other end. The session row shows
   `cancelled` (session statuses have no `stopped`); the run status is
   `stopped`, and `read_workflow` shows the stop with `settled` while the
   run is active.

Wait, receive and request states are work like any other here: a wait that
elapses within the grace settles, and one that does not is cancelled at the
deadline.

The tool takes `stop` only on a host that starts runs at 1.9.0; elsewhere it
is refused as an unknown operation, exactly as before. The tool's published
description and parameter enum are unchanged.

Not yet covered: the UI read model's `stopped` label, REST/MCP parity and
the formal lifecycle model's stop transitions.
