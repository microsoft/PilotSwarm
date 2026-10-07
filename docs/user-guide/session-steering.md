# Guide a running turn

Session steering adds guidance to work already in progress without stopping the
turn. It is available only when the deployment enables `sessions.steering`,
enforces ownership authorization, and reports a supported open input window.

| Action | Effect |
|---|---|
| Send | Queue ordinary input for the next PilotSwarm turn. |
| Steer | Send text to the observed current turn at its next supported input boundary. |
| Stop | Interrupt the current turn. Ordinary queued prompts and schedules are not cancelled. |
| Withdraw | Prevent handoff only if the worker has not claimed that guidance. |

In the portal, type guidance and select **Steer** beside Send and Stop. You can
also press Ctrl+S while the message box has focus. Outside the message box,
browser Save keeps its normal behavior. Mobile, focus mode, and Master of Agents
use the same control and bind it to the message box's session.

In the native TUI, Tab first accepts a reference suggestion when one is present.
Otherwise it focuses the action row. Use Left/Right to select **Steer**, then
Enter. Tab continues normal pane traversal; Escape or Shift+Tab returns to the
editor. Native Ctrl+S is not enabled until the supported-terminal compatibility
gate passes. Enter and the existing newline and Stop keys do not change.

Steering accepts text only. Remove staged attachments explicitly before steering,
or use ordinary Send. Answer a pending question through the normal answer path.
A parked wait, terminal session, or group is not an active turn to steer.

## Read the receipt, not the next answer

| Label | Meaning |
|---|---|
| Sending guidance... | The client is waiting for durable acceptance. |
| Accepted | The server recorded the request; delivery is still pending. |
| Waiting for a safe point | The current model call or tool batch may need to finish first. |
| Delivered to current turn | A correlated SDK event confirms steering delivery. |
| Delivered after the earlier response | Earlier output was not interrupted; an owned follow-up received the text. |
| Not delivered — turn ended | The target ended before this guidance could be sent. |
| Not delivered — turn stopped | Stop prevented this request from being invoked. |
| Delivery uncertain | Submission may have happened but no positive delivery evidence is available. |
| Delivery unconfirmed — turn stopped | Stop prevents future delivery; the historical outcome remains unresolved. |
| Delivered before Stop | Delivery is known; Stop did not recall it. |
| Withdrawn | The pre-claim withdrawal won. |

Delivery does not prove that the agent understood, obeyed, or completed the
guidance. Running actions can still finish. Snapshot inclusion is separate:
**Included**, **Not included**, and **Inclusion unconfirmed** describe the saved
conversation, not external side effects.

Recovery may show **Delivered earlier — pending redelivery**, **Delivered again
after recovery**, or **Delivered earlier — recovery unconfirmed**. The original
author and request remain one row. Stop prevents automatic redelivery but does
not erase earlier evidence.

## Reuse retained guidance deliberately

A missed steer never automatically starts another turn. **Send as new message**
adds its text to the ordinary queue with a new identity; earlier queued messages
stay ahead. The old receipt remains unchanged. Undelivered, withdrawn, or
delivery-uncertain receipts offer **Reuse in draft**: it fills an empty draft
or appends on a new line without replacing existing text. Delivered receipts
have no draft action; their text remains selectable.

The TUI's **Guidance** action opens retained receipts. Up/Down selects a receipt;
PageUp/PageDown scrolls its text.
The receipt list is paged. **Load more guidance** (TUI `m`) loads the next
bounded page; a partial-list notice remains until all pages are read.
Receipts whose acceptance event is outside the loaded transcript appear under
**Guidance outside this history page**, not at the end of newer conversation.
Loading their original history page places them at the durable acceptance row.
Enter refreshes it or reconciles an unknown acceptance. Use `w` to withdraw,
`r` to send as a new message and `c` to reuse eligible guidance in the draft.
Escape closes it.

If the acceptance response is lost, use **Reconcile acceptance**. It reuses the
original caller identity and original target. A timeout is not proof of failure.
The client never silently retargets guidance to a later turn or converts it to
ordinary Send.

If **Send as new message** loses its acknowledgement, the row reports
**New-message enqueue unconfirmed** and retains that ordinary message's new ID.
A retry reuses it, including after a session switch. Ordinary queue submission
does not promise exactly-once execution; the UI warns that retrying may repeat
input. No enqueue is replayed automatically from the provenance record.

## Scripts and tools

Use `pilotswarm sessions steering-state` to read the observed target, then
`pilotswarm sessions steer` with a caller-generated `--client-request-id` and
that `--expected-target`. Supply exactly one of `--text`, `--text-file`, or
`--stdin`. File/stdin input keeps text out of process arguments. Add `--json`
for machine-readable results.

The command returns after acceptance, not after delivery. Read `steering-status`
or `steering-list` for receipts. `withdraw-steering` has the same pre-claim rule
as the UI. See the [API reference](../api/reference.md#session-steering) for the
SDK and HTTP contracts.

CLI and MCP results retain the canonical receipt fields and add a human
`display` label, such as **Waiting for a safe point** for acknowledged but
undelivered guidance. Oversized input uses typed `too_large` across surfaces.
MCP steering requires authenticated Web API mode; direct-store MCP has no
validated human actor and reports `unsupported`, not a missing session.
