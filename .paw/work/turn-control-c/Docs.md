# Session Turn Control — Workstream C (Surfaces)

## Overview

Workstream C exposes Stop and Steer (session turn control) on every client
surface: the management client and Web API (C1), MCP (C2), the portal and the
TUI (C3), and the canonical docs (C4). It consumes the A1 contract
(`types.ts`, `turn-control-contract.ts`, `SessionCatalog.turnControlAdd`, the
`sessions.steering` definition) and edits no file owned by workstream A or B.
Plan of record: `.paw/work/turn-control/ImplementationPlan.md` (r7), phases
C1–C4; spec r8; design `docs/proposals/session-turn-control.md` revision 5.

## Architecture and design

### Management client and Web API (C1)

- `steerSessionTurn(sessionId, { text, requestId, caller? })`: validates text
  and request id, resolves `sessions.steering` for `caller.viewer` (cluster
  scope without one) from the feature catalog snapshot, records the control
  with `turnControlAdd` (actor = normalized `caller.sender`), maps refusals.
- `stopSessionTurn(sessionId, { reason?, timeoutMs?, requestId?, caller? })`:
  validates `timeoutMs` (0–300,000 ms, default 30,000) before recording,
  records a `user.stop`, then polls `session.control_outcome` every 250 ms
  (P6). `no_turn` → `no_active_turn`; other refusals → `no_active_turn` with
  the refusal as `detail`; `legacy_turn` → the earlier event path, kept as the
  private `_legacyStopSessionTurn`. A failed outcome read reaches the caller
  (it is never reported as a timeout).
- A catalog that throws `TurnControlUnavailableError` (no migration 0082) is
  treated as `legacy_turn`; any other error propagates.
- Detailed view (`getSession`, direct and Web): `activeTurnIndex`, `turnHigh`,
  `acceptsTurnControl` (P5). List rows are unchanged.
- Web API: `POST /management/sessions/:sessionId/steer` (`session:write`).
  The portal runtime overwrites `options.caller` (sender as `_buildSender`,
  viewer from the principal) for Stop and Steer (P18). The Node transport
  forwards options unchanged; in TUI direct mode (no caller) it adds only the
  local viewer, so the flag resolves for the person whose features the TUI
  shows. Generated web ops regenerated with `npm run generate:web-ops`.

### MCP (C2)

`steer_session_turn` (`session_id`, `text`, `request_id?`) and `stop_turn`
(`request_id?`, outcome-based `stopped`, `too_late`, pending `controlSeq`).
A request id is generated when omitted and always returned; refusals are
non-error results, with a `send_message` hint only for `no_turn` /
`legacy_turn`. MCP passes no caller (direct mode is a trusted subsystem; the
Web API stamps the caller in Web mode).

### Portal and TUI (C3)

- Shared transcript (`ui/core/src/history.js`): `user.steer` and `user.stop`
  become `turn-control` items; `session.control_outcome` and
  `session.carried_steers_closed` are label inputs matched by control seq
  (first record wins), baked into the items on both the bulk and the live
  path. Carried labels come only from the closing record (S1/P17). The four
  event types join `CHAT_HISTORY_EVENT_TYPES`; `session.steer_confirmed`
  stays out. Paging rebuilds from all loaded events, so labels reconcile
  across pages.
- Legacy Stop (P22): on 1.0.80 and older the "Turn stopped by user."
  `system.message` was shown only in the activity feed. C3 renders a visible
  transcript line from the legacy `session.turn_stopped` event
  (`interrupt` other than `turn-result`), marked `control-stop-legacy` with
  `stopped` or `stop_forced`. 1.0.81's own stopped result
  (`interrupt: "turn-result"`) gets no line: its `user.stop` item is the record.
- Controller (P14): one request id per action, kept with kind and text in
  `state.turnControl.bySessionId[sid]` until a definite answer. Transport
  failures (no HTTP status, 5xx, 408/429) are `unconfirmed`; Retry (and
  pressing Steer / Ctrl+T / Stop / Ctrl+X again) resends the same id and never
  falls back. Only a definite `no_turn`/`legacy_turn` Steer refusal sends the
  text through the outbox as an ordinary message with a new client message id
  (the refusal notice shows while it is sent, then `fallback_sent` or
  `fallback_failed`). Other refusals and definite errors (`forbidden` 403,
  `too_long` 413, `error` 400/401/404/409/422) put the text back only when
  the session is still active and its composer is empty; otherwise the
  notice keeps the text (no auto-clear) with **Restore text** (portal) or an
  empty-prompt `Ctrl+T` (TUI), which append it after any new draft. Dismiss
  of an unconfirmed steer also appends its text. The message fallback is
  reported as sent only when its own outbox envelope is queued or
  acknowledged; an envelope already in flight is awaited first.
- `canSteer` = `acceptsTurnControl && status === "running"` and the viewer's
  `sessions.steering` (read with `getMyFeatureFlags` at session load, at most
  every 30 s, and on every "mine" feature refresh; a `steering_disabled`
  answer turns it off). The controller sets `acceptsTurnControl: false`
  explicitly on `session.turn_completed`, `session.turn_stopped`,
  `session.wait_started` and `session.input_required_started`; the detail
  sync that follows every event brings the authoritative value.
- Portal: Steer (`↪`) between Stop and Send; inline notice with Retry and
  Dismiss (dismissing an unconfirmed steer gives it up and returns its text);
  transcript items; the `data-testid` contract below.
- TUI: `Ctrl+T` in the prompt pane steers; `Ctrl+X`/`Ctrl+Esc` stops;
  `Alt+T` gives unresolved requests up (the portal's Dismiss). Status hints
  show `ctrl-x stop` / `ctrl-t steer` (or `retry`, `restore steer text`,
  `alt-t give up`) only while they apply; `?` help lists them.
- Notices are per kind (`steerNotice`, `stopNotice`): a Stop never hides an
  unconfirmed steer's Retry/Dismiss, which stay usable after the turn ends.
- Steer is unavailable while a pending or queued outbox message is selected
  (its text belongs to that message).

### Portal `data-testid` contract

All composer selectors live under `.ps-prompt-shell[data-session-id]`, all
transcript selectors under `.ps-scroll-panel[data-session-id]`.

| Selector | Attributes |
| --- | --- |
| `composer-input` | |
| `turn-stop-button` | `data-state` ready, stopping |
| `turn-steer-button` | `data-state` ready, sending, disabled (empty composer); present only when `canSteer` (or while sending) |
| `session-turn-state` | `data-turn-state` (product status, unnormalized), `data-accepts-controls` true, false; a readable status chip (dot + state text) beside Stop/Steer, `role=status` |
| `control-steer`, `control-stop` | `data-control-seq`, `data-outcome` |
| `control-outcome-badge` | `data-outcome` pending, delivered, carried, carried_ran, carried_then_stopped, carried_not_run, not_delivered, stopped, too_late |
| `control-stop-legacy` | `data-outcome` stopped, stop_forced |
| `control-notice` | `data-kind` steer, stop; `data-reason` every value of the plan table |
| `control-retry-button` | `data-request-id` |
| `transcript-user-message` | `data-client-message-id` (space-separated when several) |

## User-facing documentation (C4)

- `docs/api/reference.md`: Steer route, Stop options and outcomes, a "Stop and
  Steer" section (caller, request ids, outcomes, limits), `sessions.steering`.
- `docs/user-guide/portal.md`: Stop outcomes, Steer and its labels, fallback
  and Retry. `docs/user-guide/keybindings.md` and `tui.md`: Ctrl+X, Ctrl+T.
- `docs/user-guide/mcp-local-setup.md`, `packages/app/mcp/README.md`,
  `docs/proposals/mcp-web-api-parity.md` (it lists operations): the MCP tool.
- `.github/skills/pilotswarm-tui/SKILL.md`: keys, composer and contract.
- `CHANGELOG.md`: one Unreleased entry.
- `templates/builder-agents/**` and `examples/devops-command-center/`: no
  change needed — neither shows a Stop surface or lists management operations
  that include Stop (checked with a search for `stopSessionTurn`/`stop_turn`).
- `scripts/local-pilotswarm.sh`: no new setting (design 4.12).

## Interpretations and evidence

- "Text size limit as `sendMessage`" (plan C1): `sendMessage` has no
  management-level limit; the only limit is the Web API's 2 MB JSON body cap,
  which the steer route shares (tested in `api-router.test.mjs`; the portal
  shows `too_long` for a 413). Direct mode has no transport cap.
- `stopSessionTurn` timeout detail states only that no outcome was observed;
  `controlSeq` identifies the accepted Stop.

## Testing

| Phase | Tests |
| --- | --- |
| C1 | `packages/sdk/test/local/turn-control-management.test.js` (fake catalog: refusals, accepted, outcome wait/timeout/read failure, timeout validation, legacy fallback, flag for owner vs collaborator, detailed view; Web API parity and forged-caller overwrite through the real runtime and router; real PostgreSQL after A2: steer recorded once, lost response then same-id retry, Stop outcome, read-only 403 with nothing recorded, no-turn fallback delivered once), `stop-turn-management.test.js` (legacy harness), `api/test/protocol.test.mjs`, `api/test/http-api-transport.test.mjs`, `web/test/api-router.test.mjs` (2 MB cap on steer) |
| C2 | `packages/app/mcp/test/unit/turn-control.unit.mjs` (in the explicit `test:mcp` list), registration and dispatch expectations |
| C3 | `ui/core/test/turn-control-history.test.mjs`, `ui/core/test/turn-control-controller.test.mjs`, `tui/test/turn-control-keys.test.mjs`, `web/test/e2e/turn-control.spec.mjs`, `web/test/e2e/mobile-header-status.spec.mjs` |

Pending on other workstreams: the real-PostgreSQL block of
`turn-control-management.test.js` (A2) and the `stop-turn-live.test.js` update
(A4 and B2).

The C3 manual check "walk Stop and Steer in `scripts/local-pilotswarm.sh` with
two dev personas (one read-only share)" is deferred to the parent's I1/U1b on
the integrated candidate: it needs workstreams A and B merged, and the dev pod
has no Docker for the local instance. Deferred, not skipped.

Proposed `scripts/provider-test-coverage.json` entries (the parent applies
them): `packages/sdk/test/local/turn-control-management.test.js` (HorizonDB
coverage once A2's procedures are verified there; the fake-catalog part needs
no database).

## Parity

TUI and portal share the controller, history and labels. Divergences, by host
capability: the portal shows notices inline with Retry/Dismiss buttons and a
`data-testid` contract; the TUI reports the same answers in the status line,
retries by pressing the same key, and gives a request up with `Alt+T`
(`Option+T`), the equivalent of the portal's per-notice Dismiss (the portal
dismisses one kind at a time; Alt+T gives up both kinds at once, since the
TUI has no notice row to target). `Alt+T` collides with no TUI binding: the
other Alt/Option bindings are Enter, ←/→ (b/f), Backspace/Delete, and `T`
(themes) requires no modifier. The TUI has no startup keybinding hint; the
status hints and `?` help are its keybinding surfaces. The portal keeps the read-only
collaborator out of the composer (no Steer); the TUI has no per-session access
model in direct mode.
