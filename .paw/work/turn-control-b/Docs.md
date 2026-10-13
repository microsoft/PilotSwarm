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
The wake never merges with another queued prompt. A resume note from legacy
hydration rides as system context, so the marker stays the whole prompt.
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
| Stale turn start | The worker throws before the model runs. The generic retry path keeps the carry for each retry; when the retries are exhausted, its give-up write closes it with `closeControls: true`. |
| Activity cancellation (`cancelled` result) | Only a trace: no state is written and the prompt is not retried. Carried guidance is kept and runs in the next wake turn. |
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

A4 was merged for live CMS Stop and carried-closing verification. Nine
workstream B live and real-PostgreSQL scenarios pass at `e38a41b4`: Stop through
the catalog on a real model keeps cron and returns idle without a duplicate
system message; late guidance closes as ran; consuming Stops at start and
mid-turn close as stopped; an unrelated later Stop adds no closing record;
admission errors, a budget wait and a thrown attempt retain guidance until a
later consuming index; returned errors fold guidance again; real-CLI retries
never see the wake marker; give-up closes once in SQL; and frozen 1.0.80 still
uses its event Stop path. After the reviewer's exact hardening patch (a unique
turn-stopped event, exact cron status, exact stopped consumption, a
deterministic no-rerun follow-up turn and no wake-marker user message), the
same nine scenarios pass again.

The model-selection and bound-agent-backfill live cases cannot be verified here
with a usable `gpt-5.4` provider. Their exact environment-only baseline failures
are retained, not skipped or counted as passes. This workstream does not change
management, API, TUI, or portal surfaces.

## Verification evidence

B1 passed implementation review at `8cacf9d0`: SDK and app builds, 1,461 SDK
unit cases passed with one existing root-permission skip, and 96 targeted
regression cases passed.

B2's scripted scope passed Opus implementation review at `ff2188b1`: SDK build,
1,461 unit passes with the same existing skip, and 195 scripted/routing cases
across 17 files. The three product regression cases fail against `4c62cf99`
and pass after the fixes. No assertions or concurrency settings were weakened.

Nine model-selection cases and the multi-worker stale-seed case match the
unchanged `f5b3aa7d` baseline by exact name and error. The six bound-agent-backfill
cases also retain their exact baseline names and
`ModelUnresolvedError: No usable provider serves model "gpt-5.4".` No new
backfill failure was introduced. These are environment-only, not passes. The
parent's integration run retains that coverage; no fixture or source skip was
added. All seven changed fake-context model-switch cases passed.

Canonical documentation is
[`docs/architecture/orchestration/design.md`](../../../docs/architecture/orchestration/design.md).
B3 updates only that design reference, this workstream document, and the
workflow status. Full B2 passed the same Opus review at `e38a41b4` after the A4
merge and live-control verification delta.
