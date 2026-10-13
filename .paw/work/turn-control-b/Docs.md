# Session Turn Control - Orchestration

## Overview

Orchestration 1.0.81 waits directly for the V4 turn activity. Stop and Steer are
settled by the worker and CMS rather than an orchestration Stop race. The frozen
1.0.80 handler retains its original Stop queue, race, abort activity, and visible
legacy Stop message.

## Architecture and design

Every session proxy in the current handler uses `turn-control-v1`. Ordinary and
epoch-start turns route as `runTurnV4` and `runTurnEpochV4` with the turn-control
capability tag; older workers cannot execute them.

Late guidance is an ordered array of sequence numbers and text in orchestration
state. Each turn receives a copy. A successful consuming result or an authorized
stopped disposition clears the old array before new late guidance is appended.
A retryable returned error retains both old guidance and new late guidance,
even if the attempt reports consumption. A thrown error also retains the array.
Budget and workspace waits keep it. Continue-as-new carries the array.

An unanswered question holds the guidance for the user's answer. Otherwise,
pending ordinary work takes priority. If there is no pending prompt, the next
turn uses an internal wake marker. It enters the existing timer-interrupt path,
so an interrupted wait and recurring schedule remain intact. The marker remains
internal in shared sessions and survives prompt normalization and retry notes.
A follow-up held by an agent wait ends that wait, as a new message would, and
carries the guidance. A pending graceful shutdown holds the guidance; the
terminal write closes it. A buffered child digest rides after the marker, never
inside it. Every carried-only attempt, including a retry, runs as a bootstrap
turn.
The worker replaces it with guidance text and must not record a second user
message.

Closing records remain in the existing worker turn-end and CMS state writes.
There is no carried-steer closing activity or yield.

## Give-up and terminal-path audit

| Path | State write and disposition |
|---|---|
| Generic returned or thrown error, retry limit reached | Existing `error` write adds `closeControls: true`; clear carry after the write. |
| Non-retryable returned error | Existing `error` write adds `closeControls: true`; clear carry. |
| Returned or thrown authentication error | Existing `error` write adds `closeControls: true`; clear carry. |
| Storeless connection-loss retry exhaustion | New single `error` state write preserves the existing give-up message and adds `closeControls: true`; clear carry. |
| Legacy-input hydration retry exhaustion | New single `error` state write preserves the existing exhaustion message and adds `closeControls: true`; clear carry. |
| Missing saved state, returned or thrown | Existing `failed` terminal write; no `closeControls` option because SQL closes controls. Clear carry. |
| Graceful completion, cancellation, deletion, or failed shutdown | Existing terminal/delete operations close controls in SQL. Clear orchestration carry. |
| Creation-policy rejection or worker-managed-agent rejection | Existing startup state write before any turn can open controls. |
| Persisted connection-loss recovery | The prompt is retried through continue-as-new, not abandoned. Keep carry. |
| Budget/workspace refusal | The prompt and guidance remain pending in the gate stash and carry; no give-up close. |
| Stale turn start (`cancelled` result) | Only a trace: the turn's prompt is not retried and no state is written. Carried guidance is kept and runs in the next wake turn. |
| Prompt dropped by a cancel tombstone or as a duplicate client message id | A session event records the drop; no state write. The user asked for it or already sent the prompt. |
| Regeneration archive/distill failure | The regeneration request is refused or falls back; queued work is retained, not abandoned. |
| Epoch-boundary commit or invalid cron computation failure | These remain execution failures, not successful give-up returns; do not silently consume carried guidance. |

The two new give-up writes apply only to 1.0.81. Their tests compare the remaining
activity sequence against frozen 1.0.80. Amendment S1 prohibits a separate
carried-steer close activity, not the CMS writes required to clear an abandoned
running turn.

## Compatibility and use

New sessions use 1.0.81. Frozen sessions replay their original version and upgrade
through the existing continue-as-new mechanism. Rollback requires retaining
workers that understand V4 until new-version sessions drain. Disabling Steer
does not roll back orchestration state.

Stop returns the session to idle without cancelling its timers or schedules.
The new-version transcript uses the durable Stop line and does not add the
legacy `Turn stopped by user.` system message.

## Testing and limitations

Scripted generator tests cover carry retention, retry, consumption, question
answers, shared-session wake markers, schedules, give-up writes, terminal
dispositions, and the unchanged uncontrolled-turn activity sequence. Real
PostgreSQL routing tests use two worker capability filters, including an old
worker that registers V4 names as a trap.

Live CMS Stop and carried-closing coverage requires workstream A4. The branch
must not be released with the A1 placeholder V4 handler. This workstream does
not change management, API, TUI, or portal surfaces.
