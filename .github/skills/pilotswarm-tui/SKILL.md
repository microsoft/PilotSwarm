---
name: pilotswarm-tui
description: Modify or extend the PilotSwarm terminal UI. Covers the shared-first architecture across ui-core, ui-react, and packages/app/tui, the current layout and visual conventions, prompt/question behavior, and the requirement to keep maintainer docs updated as the TUI evolves.
---

# PilotSwarm TUI

## Streaming chat contract

For live-plane changes, read `docs/architecture/live-plane.md`. Shared core
owns provisional identity, interim/final classification and stream-scoped idle
cleanup. Browser previews are canvas-style disclosures, collapsed by default.
Saved intermediate messages are `Agent update` rows, never `Message preview`
or active streaming status. That rule holds for durable-only turns and old
history. Keep the same disclosure DOM as live output becomes saved output.
Their expanded viewport hugs its content up to min(280px, 35dvh), then scrolls independently,
and follows live growth only while the reader remains at its bottom. Keep the
disclosure, viewport, and content DOM stable across deltas and durable interim
messages; parse hidden markdown only when opened. A successful durable
`session.turn_completed` promotes the last eligible assistant message to normal
timestamp/`Agent:` prose, removing the preview bounds without remounting its
body. Explicitly remove the max-height on final responses. Earlier messages remain compact. Include completion/stop events when
paging history so reloads and page boundaries preserve this classification.
Cache unchanged transcript rendering. Verify disclosure/scroll continuity and
final promotion with browser coverage before a release; metadata-only checks
cannot prove smoothness. Never restore an “Agent responded” completion label.
Preserve nested links when formatting emphasis/headings: artifact hrefs must
reach the existing artifact card/viewer, not become literal Markdown text.
Test that interleaved SDK byte-progress notifications never replace accumulated
answer text or discard its reasoning disclosure.

Use this skill when changing any of:

- `packages/app/ui/core/`
- `packages/app/ui/react/`
- `packages/app/tui/`
- `run.sh`
- TUI-specific docs or UI behavior

## Read First

- [docs/architecture/tui.md](../../../docs/architecture/tui.md)
- [docs/developer/contributing/tui-implementor-guide.md](../../../docs/developer/contributing/tui-implementor-guide.md)
- [docs/user-guide/keybindings.md](../../../docs/user-guide/keybindings.md)
- [packages/app/ui/core/src/controller.js](../../../packages/app/ui/core/src/controller.js)
- [packages/app/ui/core/src/selectors.js](../../../packages/app/ui/core/src/selectors.js)
- [packages/app/ui/react/src/components.js](../../../packages/app/ui/react/src/components.js)
- [packages/app/tui/src/app.js](../../../packages/app/tui/src/app.js)
- [packages/app/tui/src/platform.js](../../../packages/app/tui/src/platform.js)

## Core Architecture

The terminal UI is not a monolith.

- `ui-core` owns state, controller logic, selectors, formatting, and transport-facing behavior.
- `ui-react` owns shared React composition and stays host-neutral.
- `packages/app/tui` is the thin terminal host: keyboard wiring, terminal rendering, process lifecycle, clipboard, downloads, and OS integration.

The public `startTuiApp(config)` host accepts an optional `logFile` path for
console/stderr/warnings and native duroxide tracing. Custom paths are resolved
against cwd, their parents are created, and startup truncates only that file;
invalid paths or tracing setup failures reject rather than falling back.
Omission retains the best-effort `/tmp/duroxide-tui.log` default. Restore host
logging hooks on startup failure as well as quit. Keep this terminal-only
setting out of shared UI state and portal configuration.

Do not move host rendering details into `ui-core`.
Do not move controller or selector semantics into `packages/app/tui`.
Do not bypass shared selectors/components with host-only UI logic unless the behavior is truly terminal-specific.

## Product Rules

- Default repository/help links point to `microsoft/PilotSwarm`. Keep shared
  state, portal configuration and bundled plugin defaults aligned; preserve
  app-specific guide overrides. Public source and package downloads do not
  require repository membership; model and portal credentials are separate.
- Question events received during reconnect must not reopen questions older
  than the current session snapshot. A durable answer from another writer
  retires its matching pending question. Legacy late-answer wrappers containing
  the runtime placeholder `a question` render only the preserved answer.
  Preserve the resolved-question timestamp across stale detail refreshes, but
  allow a later identical question. Send the observed question and its iteration
  through `sendAnswer` options; do not silently answer the next question.
- Portal tool and cross-agent calls use one-line collapsible previews with
  ellipsis. Correlate call/request IDs within the durable session; keep the
  disclosure stable through progress, completion, reload, and history paging.
  Raw arguments/results are text, and empty-response diagnostics stay in
  Activity. The native TUI keeps tool calls in Activity.
- Preserve the existing PilotSwarm terminal workflow and information density.
- Pane titles live in borders, not as duplicate content inside panes.
- Keep title run data plain. The portal may use a slim painted card header, while the TUI should render pane titles without a highlighted header background. When panes narrow, drop low-priority title metadata like session ids or recent-window labels before squeezing content.
- Named-agent session titles should lead with the user-assigned title or uniquifier, then the agent type, then the agent/persona metadata, e.g. `M61 Conductor · R2D Train Watcher · Mad-Eye Moody`; do not render agent-name prefixes before the useful title in session rows or chat pane headers.
- System sessions render with the machinery marker `⚙` in yellow. Leave one text space after the marker in title-bearing rows/headers; the terminal renderer already gives this symbol enough visual width.
- Chat pane headers stay compact: show the title, collapse count, short session id when space allows, and transient live-progress labels. Do not duplicate model/context/window metadata there; the portal desktop Sessions row selected-detail line carries model/reasoning/context details instead.
- Session stats should use the same `model:effort` display convention, falling back to the active session row's `reasoningEffort` when the metric summary was produced without that field.
- Session/tree/fleet/user stats by-model cards show `turnCount` alongside token totals so model switches can be audited per turn bucket. Keep effort variants distinct in the model label.
- The shared controller supports switching the selected session's model through the same model/reasoning pickers as New+Model. The switch ends the current turn boundary and the orchestration schedules an automatic bootstrap continuation on the selected model; if the target model has a default reasoning effort use it, otherwise clear stale effort. System-session switches use this same durable `set_model` command path; explicit restart actions remain separate.
- Failed LLM `set_session_model` calls are also terminal and schedule an automatic bootstrap correction continuation on the unchanged model. Failed control-plane switches are rejected before command acceptance and should not create chat continuations.
- The portal sequence inspector may render expandable `session.turn_completed` dividers. Keep the collapsed row compact (`Mod`, input/output tokens, duration) with provider/reasoning omitted from the model label; expanded details can show full model, effort, cache, tool, worker, and result data. The native TUI sequence view remains line-oriented unless a terminal-specific design is added deliberately.
- Shared selectors are the source of truth for visible state.
- Context-window picker rows and details show each model's catalog-declared token capacity when `contextWindowSizes` is available; keep generic smaller/larger labels as the fallback for catalogs without size metadata.
- Reasoning pickers and control-tool schemas preserve every effort advertised by the model catalog. The current Copilot CLI vocabulary is `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; individual models expose subsets (for example Opus 4.8 exposes `low` through `max`).
- Session rows should show interval cron as `[cron <duration>]` and wall-clock cron as `[cron <next client-local time>]` from shared selector state; status clearing must remove stale wall-clock cron fields when `cronActive` becomes false. Do not expose the internal `cron_at` tool name in row badges.
- Waiting/timer row visuals should stay stable across same-age stale detail refreshes. Row status icons may change, but the new row visual status must remain stable for at least 5 seconds before the visible icon/color flips; a row that is visibly waiting should not briefly lose its `~` icon or cron badge unless a newer session update, running state, or terminal state actually clears the wait.
- The sequence and activity panes should render wall-clock `cron_at` lifecycle events with the same visible `cron` label and magenta styling as interval cron, including a visible wake-up indicator when `session.cron_at_fired` arrives.
- Non-user / non-assistant transcript items render as cards, except dedicated read-only chat-pane views and the portal call previews described above. Session summary and session group details render as plain structured markdown without a card border. Cross-session `[SESSION_MESSAGE ...]` and `[SESSION_MESSAGE_RESPONSE ...]` protocol prompts remain product-visible: collapsible first-line previews in the portal and request/reply cards in the native TUI.
- Mouse copy must stay pane-local.
- Prompt/question behavior and keybinding help must stay synchronized with actual bindings.
- Files, logs, sequence, nodes, activity, and chat are all product surfaces and should not silently regress.
- Live-updating logs and activity panes should wrap long lines rather than extending horizontally.
- Live-updating logs and activity panes should auto-follow only while the user is at the bottom; scrolling upward pauses follow mode until the user returns to the bottom.
- In the sessions pane, `f` opens the session owner filter; keep terminal help text and docs aligned with that binding.
- In the sessions pane, `Ctrl+G` opens the move-to-group picker for the selected top-level non-system sessions, or for the active top-level non-system session when multi-select is off. The picker includes `[New Group]`, existing groups, and `[No Group]`; keep status hints and keybinding docs aligned with that binding.
- In the sessions pane, `P` pins or unpins the active top-level session. Pinned rows render with a `📌` marker. System sessions, child (sub-agent) sessions, and sessions contained in a group cannot be pinned; moving a pinned session into a group drops the pin automatically. Pin state persists across portal devices through `users.profile_settings.pinnedSessionIds`; the portal does not use browser localStorage/cookies as a preference cache. The native TUI uses the user config file (`pinnedSessionIds`). Pins for sessions that no longer exist or that are no longer top-level are pruned automatically on the next session refresh.
- In the sessions pane, lowercase `v` cycles an owned non-system session tree through `private`, `shared_read`, and `shared_write`; uppercase `S` opens targeted sharing. Uppercase `V` remains multi-select. The portal exposes the same visibility/share actions through the selected-session controls, and both hosts enforce owner/admin capability flags from the transport.
- Session groups are shared TUI/portal pure-container rows. They render as top-level `🗂` rows, can be pinned independently, and do not open a transcript. Session ordering bands are: system sessions first, pinned groups, pinned single sessions, unpinned groups, then unpinned sessions. On fresh page/app load, seed row order within each band and group by last-updated time, newest first; during live refreshes preserve stable row order so timestamp changes do not churn the visible list. Sessions inside a group are not pinnable; child rows follow the stable unpinned order. Leave two text spaces after the marker so terminal renderers do not crowd the title. Selecting a group opens a plain markdown group details view with metric and member tables in the chat pane; inspector and activity panes show a generic prompt to select a session instead of sequence/log/activity details. Groups are private per-user organization: each group belongs to the signed-in user, only that user sees it, and any readable session (owned or shared) can be placed in it — placement never changes access. Group rows show the group owner's owner-initials prefix. Groups do not support cancel/complete bulk actions; deleting a group clears only the owner's placements and never touches sessions. In the portal, the Sessions pane header exposes a `Group` / `Group (n)` button that opens the shared move-to-group picker.
- In the portal desktop Sessions column, row data is structured: title and collapse count stay on the primary line, timestamps/member counts render as muted metadata, cron/context badges render on their own badge line, and the selected row may reveal richer status/model/context metadata. Mobile Main Sessions keeps the flattened clipped single-line row path; mobile Chat Focus Sessions may use the same structured rows as desktop, with horizontal scrolling where needed. Keep the native TUI flattening path available for terminal rows.
- System session actions are restart actions: Done prompts for `Complete & Restart`, Cancel prompts for `Terminate & Restart`, and Delete prompts for `Hard Delete & Restart`. They all route through `restartSystemSession`, not ordinary `completeSession` / `cancelSession` / `deleteSession`. In the portal Sessions pane, the ordinary `Terminate` button becomes `Restart` for system sessions and opens a disposition picker with those three restart choices. If the hard-delete restart fails with `NOT_FOUND` (no agent to restart), the controller offers `Remove Orphaned System Session`, which calls `restartSystemSession(sessionId, { disposition: "hard_delete", startReplacement: false })`.
- In the chat pane, `s` toggles between the transcript and the current session summary view; keep the portal top-toolbar `Summary` / `Chat` toggle and TUI keybinding help in sync. Do not add a second Chat/Summary control inside the chat pane header. Summary and group details are read-only views: the portal hides/disables the prompt composer and suppresses transient live-progress labels there.
- On mobile portal layouts, the normal workspace toolbar stays on exactly two
  rows. It includes New, Model, Switch, Filter, Theme, Chat-or-Summary, Focus,
  Master of Agents, and Admin when the viewer has access. Portal
  connection/status text lives in the app header under the version pill, not
  in the toolbar. Mobile Zen replaces that toolbar with only restore and the
  shared session picker; mobile MoA shows one panel at a time with its map and
  focused-panel controls. Its session title/status lead on the left, with an
  icon-only down-triangle dashboard picker at the far right; never prepend
  the dashboard name or add a second mobile tab row. Both compact focus
  composers retain Stop during a running turn, with a 44px touch target and
  disabled pending-request state beside Send. Phones (600 px or less) have
  no separate Steer button: the composer is one line (`[input][📎][■][blue
  button]`, no "you" label) and does not grow when a turn starts; while the
  turn accepts steering the blue button shows `↪` (`composer-send`,
  `data-action="steer"`): a tap steers, and with typed text a hold (about
  0.45 s) opens "Steer now" (lit) and "Queue" (`steer-hold-menu`).
- Session turn control (Stop and Steer). TUI: `Ctrl+X` (or `Ctrl+Esc`) stops
  the running turn; `Ctrl+T` in the prompt pane sends the prompt text as a
  steer when the turn accepts controls (`acceptsTurnControl` from the
  detailed session view) and the viewer's `sessions.steering` feature is on;
  otherwise the status line says why. The same key resends an unconfirmed
  request with its original request id, and `Alt+T` gives unresolved
  requests up (steer text returns to the prompt after the draft; the
  portal's Dismiss). The status hints show `ctrl-x stop` / `ctrl-t steer`
  (or `retry`, `restore steer text`, `alt-t give up`) only while they apply,
  and `?` help lists all three. Kept steer text (not delivered) has no
  separate TUI Discard key: `Ctrl+T` on an empty prompt restores it, and
  clearing the prompt discards it; the portal shows Restore and Discard.
  This divergence is deliberate (no extra key). Steer is unavailable while a pending or
  cancelling outbox message is selected. With a queued (`✓`) message selected
  (`↑`), `Ctrl+T` steers now with that message (it replaces the queued message
  when delivered; otherwise it stays queued) and `d` cancels it; the status
  hint shows `ctrl-t steer now` only while it applies, and `?` help lists both.
  With an empty prompt and queued messages, `Ctrl+T` steers them all in order
  (hint `ctrl-t steer N queued`; refused when one has an image). The portal's
  `↪` does the same (D11): typed text, the selected message (`↑` or a click
  on its line, desktop only; `✕` deletes it), or with an empty box the whole
  queue (`↪ N`, `data-steer-target`, `data-count`). The queued-prompts strip
  has no buttons (`queued-actions`, `queued-item`, `queued-notice`), so each
  message appears once; a steered line reads "↪ steering" and leaves the
  strip once the model reads it. The strip is bounded above the composer in
  the chat view and ends the transcript in MoA panels and Zen. Stop and Steer notices are kept per
  kind, so one never hides the other's Retry. Portal: no visible turn status (a hidden `session-turn-state` keeps `data-turn-state` and `data-accepts-controls` and names the status) and a Steer button beside Stop, an inline notice for every
  refusal, fallback and failure (with Retry for an unconfirmed request), and
  transcript items: a steer reads as a user message with a `steer` badge and
  its outcome, a Stop as a short line with its outcome. Both surfaces name a
  parent agent's control (`stop_agent_turn`, `message_agent` deliver "now")
  by the parent's title instead of "You"; portal items carry
  `data-actor-kind` (`user` or `agent`). Labels for carried
  steers come only from `session.carried_steers_closed`. Keep the portal
  `data-testid` contract (`composer-input`, `turn-stop-button`,
  `turn-steer-button`, `session-turn-state`, `control-steer`,
  `control-stop`, `control-outcome-badge`, `control-stop-legacy`,
  `control-notice`, `control-retry-button`, `transcript-user-message`)
  stable and scoped by `data-session-id`; the UX test pass asserts it.
- MoA's Close panel action uses a panel outline with an × and neutral styling.
  Keep it distinct from the Session group's trash/lifecycle action; closing a
  panel changes only its layout, leaving the session available.
- Theme picker selection previews immediately in both portal and shared UI state. `Apply Theme` commits the previewed theme; `Cancel`, `Close`, backdrop click, or `Esc` restores the theme that was active when the picker opened.
- In chat-focus mode, the Sessions pane supports horizontal scrolling so long session titles are fully readable; do not force focus-mode session rows to truncate with ellipses.
- Summary markdown tables must render as real HTML tables in the portal. If summary text arrives with escaped newline sequences (`\\n`) in otherwise tabular markdown, normalize and render the table structure instead of showing raw pipe-delimited text.
- In the sessions pane, `V` toggles multi-select mode (seeded with the active session). `Space` toggles selection on the active row, `Ctrl+G` moves every selected top-level non-system session through the move-to-group picker, `c` cancels every selected session in one confirmation (system sessions and groups are skipped), `d` completes selected sessions, `D` hard-deletes selected sessions, and `Esc` exits select mode. The portal mirrors selection with Cmd/Ctrl-click and Shift-click on session rows; the panel header reveals `Clear`, `Group (n)`, and `Terminate (n)`. `Terminate (n)` opens the same three-disposition picker for Complete, Cancel, and Hard Delete.
- In the stats inspector, `f` cycles between the session, fleet, and users views; keep terminal and portal behavior aligned.
- In the sessions pane, `n` fast-starts a generic session with the default model when generic sessions are allowed; if generic sessions are disabled, it falls back to the model-first creation flow when models are available, or the agent picker. `Shift+N` opens the model picker, then reasoning effort when applicable, then the generic/named-agent picker.
- The New/New+Model agent picker is fed by `transport.listCreatableAgents()`, not by worker logs. In remote mode, `packages/app/tui/src/node-sdk-transport.js` builds that metadata from `PLUGIN_DIRS`; if `session-policy.json.creation.bundledAgents` opts into SDK-bundled agents such as `generic-crawler`, the transport must expand those names from `packages/sdk/plugins/default-agents/` into `creatableAgents` so both native remote TUI and portal bootstrap show them.
- The fleet stats view shows a compact `Fact Tombstones` card when facts tombstone
	backlog is nonzero. The card is fed by `getFactsTombstoneStats` through the shared
	transport/controller/reducer path and renders pending, unreconciled, TTL-blocked,
	oldest, and reconciled counts in `packages/app/ui/core/src/selectors.js`.
- In the files inspector, `x` deletes the selected artifact after confirmation; keep terminal and portal behavior aligned.
- In the native TUI, the files inspector should render inside the standard outer inspector shell rather than introducing a second files-specific top-level shell.
- In the portal inspector, reserve a consistent header row height so tabs with header actions and tabs without them start their tab strip at the same vertical position; keep inspector tab/action buttons compact rather than oversized.
- The session canvas is portal-only; the native TUI renders its `canvas_updated` lines as ordinary artifact links. One affordance on both device classes: the toolbar Canvas button. On desktop it flips the right column, and the pane keeps its glyph, `rev N`, zoom control, and a `✕` back to the inspector/activity panes. On mobile it fills the CONTENT REGION — the same box Main, Activity and Inspector get, from under the toolbar to the bottom of the page, edge to edge with no inset. It is not full-screen: the portal header and the toolbar stay visible, so the Canvas button is always reachable. The Sessions strip and the composer live inside that region and are covered while it is up. Its header is one thin (~21px) line: `rev N` on the left and a maximize/restore toggle hard right. No zoom control and no `✕` — the toolbar button is the only way in or out there. Maximized means the WHOLE viewport, portal header and toolbar included; the same strip persists so there is always a way back, and it renders even with no revision drawn so a cleared canvas can never trap the user full-screen. Maximize is mobile-only; the desktop right column keeps its own chrome unchanged. Canvas is a fourth mobile pane value alongside Main/Activity/Inspector; toggling it off restores the pane it was opened from, not a fixed default. The canvas layer is a SIBLING of the region's pane content, never a child of a pane, and stays MOUNTED while hidden (off-screen transform, never `display:none` or `visibility:hidden`). Inset and maximized are the SAME element restyled (absolute-in-region ⇄ fixed-over-viewport), never a move in the DOM. The canvas runs interactive pages — Snake, Tetris — so the frame must survive every pane switch and every maximize toggle; only a session change or a reload may take a running page down.
- In the portal desktop workspace, Sessions render as a left-side column next to Chat. As the sessions/chat divider moves left, rows degrade from wrapped text to no-wrap rows with horizontal scrolling, then the Sessions pane disappears completely while the divider remains visible and can be dragged back open. The sessions/chat column divider and the main inspector divider are resizable; the right-column inspector/activity divider is resizable vertically and must allow either pane to reach zero height so the other fully covers the diagnostics column. Preserve double-click reset plus arrow-key resizing on the drag handles, collapse panes once the divider is pushed far enough toward one edge, and keep the divider visible so a collapsed pane can be dragged back open.
- Persist portal theme, owner filter, pinned sessions, collapsed-session ids, active (selected) session id, chat transcript/summary mode, and pane split adjustments in `users.profile_settings` so browser/mobile sessions share the same preferences. The portal must not read or write browser localStorage/cookies for these preferences; it may only clear old legacy keys/cookies at startup. The native TUI persists the same `pinnedSessionIds`, `collapsedSessionIds`, `activeSessionId`, theme/filter/view mode, and pane adjustments in its user config file. If no stored `activeSessionId`/`collapsedSessionIds` exist yet, the shared default is the main PilotSwarm system session selected with every group/parent session collapsed.
- A portal `?session=<id>` deep link is explicit navigation: it must select and visibly highlight that session in the Sessions list, expand its ancestors, and retain the transient filter exception when current filters would otherwise hide it. A prior empty-space list deselection must not suppress the linked row highlight.
- In the native TUI, keep the session/chat divider shared and capped: it is the chat resize control, and it must not let the top sessions pane grow beyond 50% of the full window height.
- Busy/system-session prompt sends now use a shared pending outbox: queued prompts render in chat as pending user items, `Enter` on an empty draft flushes the queued batch, `Up`/`Down` at the prompt boundary navigate queued items, `Esc` cancels a selected pending (`○`) item and leaves a selected queued (`✓`) item, and `d` cancels a selected queued item (status hint `d cancel`). Keep portal, TUI, status hints, and docs aligned with that behavior.
- Pending-question answers render an optimistic asked/answered transcript item as soon as the user submits. Keep that item visible while `sendAnswer` is in flight and after it is accepted, then let the durable `user.message` transcript replace it once history sync catches up; stale session refreshes must not restore the old question card or hide the submitted exchange. Recognize both legacy and `(answered by …)` wrappers: the question remains a Question card and only the answer is human-authored. Use event sender metadata for identity, not the wrapper text.
- Session warnings, including provider/API errors, remain stable while retrying and across stale idle/waiting refreshes. Use server status versions before timestamps to recognize recovery. Recovery resolves the active status, not the historical warning: keep the notice at its original transcript position and append later chat below it. Durable `session.error` events belong in chat history and backward paging. Capture status-only notices once in shared state; reconcile them with their durable event without duplicating or remounting the card. Keep the card's DOM key independent of retry counts and error text. Do not special-case only lost Copilot connections.
- Canvas trust (canvas app registry, issue 181). `CanvasFrame` takes a revision's trust and page hash from the canvas state for that session and slot, never from its caller, so the main canvas and Master of Agents pinned canvases decide alike. Only `owner` and `agent` frame a page directly; a missing or unknown trust (a draw recorded before the registry) is another user's page, except during the canvas app transition: while bootstrap `canvasLegacyMode` is on, a page drawn before the registry, or flagged as an old app's page, is framed directly only after one `getCanvasRevisionLabel` answer for that exact revision says `legacy` and names the bytes (`ensureCanvasLegacyLabel`, one read per session/slot/revision/page sha, only Retry re-reads); "not legacy" wraps it, a missing answer seals it with Retry, and owner/agent pages never read the label. The Files preview of a slot file uses the same answer; Master of Agents panels take the switch from their own transport. A revision the sessions-list seed names before its draw event is read has no trust yet: `CanvasFrame` does not fetch it (it keeps the frame on screen, else shows "Loading canvas…"), so the first frame is the final one and an app never starts twice. After 3 s without a trust it frames the page sealed and says so (Retry re-reads the draw events); a late `cross-owner` trust whose `pageSha256` matches the bytes on screen keeps that frame, and a late `owner`/`agent` trust reframes it directly once. A seed that raises a revision drops the older revision's trust and re-arms the snapshot read; the read pages back (bounded) to each known slot's own draw event, and a revision named ahead of its event is re-read at most 5 times. Another user's app, and every `canvas.html` … `canvas5.html` opened in the Files preview or full screen, and the share-link viewer, all use ONE frame contract (`ui/react/src/canvas-isolation.js`): a portal-authored wrapper with no app bytes, the page as its inner frame's `srcdoc`, policy plus `frame-src 'none'`, relay only between the portal and that one inner frame, and a second inner load ends the relay. Never frame such a page with a policy tag alone. A frame's bytes must match its revision's `pageSha256`. A link a page asks to open needs a real click in the frame. The workspace approval prompt is portal shell UI outside the frame (`getCanvasWorkspaceApproval` / `setCanvasWorkspaceConsent`), shown only to the session owner; the native TUI renders no canvas, so it has no prompt (an intentional divergence, not missing parity).
- Creating a session explicitly selects and reveals its chat, including from mobile diagnostics/canvas or the desktop Master of Agents workspace. Seed the returned session before catalog refresh, preserve the outgoing draft, and keep selection through paged/stale catalogs and filters. A late load of the previous session must not take over the live subscription. Do not alter saved Master of Agents layouts when returning to normal chat.
- The browser composer must resize on both draft and placeholder changes. Empty textareas measure wrapped placeholder text: the outbox hint changing back after acknowledgement must shrink the box without another keystroke or viewport resize. Keep the mobile height cap and independent textarea scrolling.
- On mobile/coarse-pointer session lists, axis-locked drags track the finger and stop immediately on release or cancellation; never schedule an inertial fling. Preserve taps, deliberate horizontal panning, and desktop reorder behavior. This rule is session-list-only: chat and canvas retain their existing scrolling.
- The chat live-activity `Working` card is governed by the session's running state, not by whether an assistant message has already appeared in the transcript. Assistant output can land before a turn is fully complete; keep the card visible until the session stops running.
- In the portal, the live `Working` card and queued outbox are bottom-sticky flex siblings that reduce the transcript viewport height. `useScrollSync` must observe real viewport size changes and reapply the existing bottom/top anchor even when transcript lines did not change; otherwise the last transcript rows sit under the bottom fade and appear to slide behind `Working`. Preserve paused user scroll and touch momentum when re-anchoring.
- Completing, cancelling, or deleting a parent session cascades the matching shutdown command to every live direct child and waits for those child sessions to become terminal before closing the parent. A child task/result marked `completed` is not the same as a terminal child session: non-system children remain alive for follow-up, so graceful shutdown must use authoritative CMS lifecycle status and still close an `idle` child.
- The Admin Console (`Shift+A` in the native TUI; toolbar `Admin` button in the portal) is a workspace-replacing surface for per-user settings. It must never display the raw GitHub Copilot key text — `selectAdminConsole` and `selectAdminGhcpKeyEditorModal` only carry the `githubCopilotKeySet` boolean and a masked editor value. The TUI and portal share the `state.admin` slice in `ui-core` and route every mutation through the controller (`beginAdminEditGhcpKey`, `setAdminGhcpKeyDraft`, `cancelAdminEditGhcpKey`, `saveAdminGhcpKey`, `clearAdminGhcpKey`, `refreshAdminProfile`); keep both hosts in sync if you add a new admin setting. Do not globally block New/New+Model when the per-user GitHub key is unset: GitHub models should fail only at create time when neither env `GITHUB_TOKEN` nor the per-user key is available, and non-GitHub providers must remain usable.
- Admin Console → Packages and Canvas Apps share one settings tree (issue 181 R24). `selectAdminConsole` returns `settingsTree` (visible rows only; each row has `parentId`, `collapsible`, `collapsed`, `navigable`, `cursor`), `settingsTreeAll` and `treeCursor`; the tree helpers live in `ui-core/src/admin-tree.js`. Both hosts send the same controller intents: `moveAdminTreeCursor` (j/k, ↑/↓; landing on an item selects it), `activateAdminTreeNode` (Enter/Space: toggle a section/group, select an item), `collapseAdminTreeNode` (←: collapse, or move to the parent) and `expandAdminTreeNode` (→). Selecting an item opens its section and group (`revealAdminTreeSelection`). A collapsed section or group shows its count. The portal scrolls each section's rows in its own box and `scrollIntoView`s the cursor; the TUI windows the tree around the cursor with `windowAdminTreeRows`. The collapsed ids are per viewer: `adminCollapsed` in the portal profile and, in the TUI config, an `adminCollapsed` map keyed by `provider:subject` (`tui/src/admin-tree-config.js`); a sign-in as someone else resets and reloads them. TUI `c` opens Canvas Apps, `a` Packages.
- Admin Console → Canvas Apps detail comes from `buildCanvasAppsView` (`ui-core/src/admin-canvas-apps.js`). The TUI renders it read-only (`buildAdminCanvasAppsLines`); Preview, the actions (share/private, enable/disable, pin, download, export, delete) and **Add canvas app** are portal-only, as for Packages — a deliberate divergence. The portal preview always uses the cross-owner isolation wrapper. The canvas toolbar's **Publish as app** (session owner only, `selectCanvasPublishAvailable`) opens a dialog whose manifest check is `publishCanvasApp({checkOnly:true})`, which writes nothing. In the TUI the key hints sit right under the windowed tree and the detail is its own window (`canvasApps.detailOffset`, paged with `Ctrl+D`/`PgDn` and `Ctrl+U`/`PgUp` via `ADMIN_CANVAS_APP_DETAIL_PAGE_DOWN/UP`); `AdminConsolePanel` reports the page and last offset with `setAdminCanvasAppDetailBounds`. The whole section, header included, is fitted into the Panel's real body (height - 2 rows at width - 4 columns), counted with the Panel's own word wrap: tree labels are cut to one row (the detail shows the full name), then the tree shrinks (to 4 rows), the blank line goes, the keys compact, the header drops to the signed-in line, the tree shrinks to the cursor row, and the keys shrink to `^D/^U page`. A paged window is offered only when its measured position line and at least one detail row fit — no row is invented; otherwise a one-line notice says the detail needs more rows (tested through `computeLegacyLayout` at terminal 80x24 and 40x24 — the narrowest the TUI lays out — and 120x40, plus a 30-column panel where the position line wraps, and 40x24 with neighbouring valid 64-character app names; every detail row is drawn on some page). Every version is listed; the portal pane scrolls natively.
- In Admin Console → My Providers, portal `Update Key` and native TUI `Shift+U` replace the selected personal provider credential in place. Keep the password draft masked and clear it before awaiting the update. Never implement this as delete/recreate: provider identity, defaults, routing references, and usage history must remain intact.
- Admin role is not necessarily a user-resource bypass: honor server-provided `adminScope`/package `canEdit` for session/package actions. `cluster` keeps configuration/accounting and admin system-session access, but other content follows ownership/shares. Show the policy read-only, clear revoked content and reject late responses; never infer authority from hidden buttons alone. See `docs/proposals/cluster-scoped-admin.md`.
- Outbox items render with three visible delivery states next to the user-message label: `○` pending (client only), `✓` queued (durably enqueued), `✓✓` sent (persisted as a transcript `user.message`). Synchronous sends coalesce into a single durable enqueue; merge boundaries are not user-visible. Keep the glyph mapping in [packages/app/ui/core/src/selectors.js](../../../packages/app/ui/core/src/selectors.js) consistent across portal and TUI. Every path that delivers a receipt reconciles the outbox (live events, including ones already in history; bulk loads; the reconnect replay through `onResubscribe`; a MoA panel reconciles its loaded history when it links the parent outbox). A queued item without a receipt gets one 10 s exact-id re-read (`recheckOutboxReceipts`), also after `session.message_duplicate_suppressed`; never a text match there.

## Keybinding Rule

When a keybinding changes, update all user-facing surfaces together:

- the actual binding in `packages/app/tui/src/app.js`
- status-bar hints in `packages/app/ui/core/src/selectors.js`
- prompt affordance / placeholder copy
- modal/footer/detail help copy
- startup/help copy if present
- `.github/copilot-instructions.md`

## TUI vs Portal Divergences

The native TUI and browser portal share `ui-core` state and `ui-react` components but diverge in these areas:

| Aspect | Native TUI (`packages/app/tui`) | Portal (`packages/app/web`) |
|--------|----------------------------|---------------------------|
| Border radius | N/A (terminal box-drawing) | **Slight rounding** (`6px` / `8px`) — subtle corners, not pills |
| Scrollbars | Native terminal scrolling | **Custom dark scrollbars** — slim, theme-matched thumbs/tracks instead of browser-default white scrollbars |
| Structured chat blocks | Box-drawing cards/tables rendered as terminal text | **Web-native cards/tables** — the portal converts shared box-drawing system notices and markdown tables into wrapped HTML blocks for layout fidelity |
| Status bar / keybinding hints | Rendered in a status strip below the workspace | **Removed** — the portal has no keybinding hints strip; status/error text is shown in the toolbar next to New/Refresh/Theme buttons |
| Footer | Status strip + prompt | **No page-wide footer** — the prompt composer lives inside the chat pane so it stays scoped to Chat instead of spanning inspector/activity columns |
| Session collapse default | **Starts collapsed** — sessions that become parents are auto-collapsed on initial bulk load, but manual expand stays respected across refreshes | **Starts collapsed** — same shared reducer behavior |
| Session collapse toggle | Keyboard shortcut in `app.js` | **Click** — clicking a session with children toggles collapse/expand in `SessionPane` |
| Nesting depth | **Box-drawing prefix** — the `└ ` run (`role:"depth"`) is rendered as text | **Guide rails** — the depth run is dropped and replaced by one hairline per ancestor level, painted as per-row background images so the list stays a flat row sequence |
| Row status mark | **Glyph** — the status run (`role:"status"`) is rendered as text+colour | **Disc at top level, RING when nested** — the ring is centred on the row's deepest rail, so a run of siblings reads as one thread with a node each rather than a stack of glyphs. Status is still carried by colour; only the fill changes |
| Creating a session | **Two keys** — `n` fast-starts a generic session on the default model, `Shift+N` opens model → reasoning effort → agent | **One `＋` button**, and it opens the chooser (equivalent to `Shift+N`). The plain-`＋` fast path was dropped: two buttons for one intent cost a toolbar slot the phone cannot spare. Deliberate divergence — the TUI keeps both keys |
| Admin console | `Shift+A` toggles it | **Desktop only** — the button is omitted on mobile. Its settings tree, package detail and file preview need width the phone layout cannot give them |
| Canvas Apps detail | **Read-only text** — header, description, interface card with the workspace warning, versions, contributors, loads | **Full** — adds the sandboxed Preview, Pin, share/private, enable/disable, download, export, delete and **Add canvas app**. Deliberate divergence (Packages precedent); the tree's collapse, scroll and keys match fully |

Both the depth and status runs are tagged by the shared selector precisely so a
host can re-render them. The TUI ignores the tags by design — glyphs are correct
in a terminal — so the rails and the nested ring are deliberately portal-only.

The auto-collapse-on-load logic lives in `ui-core/src/reducer.js` (shared). It collapses sessions when they first become parents, including nested parents, but must not re-collapse a row the user already expanded during later `sessions/loaded` refreshes. Initial active selection should be the first visible flat-tree row after collapse, not the first raw session object.

### Session folders: two load-bearing refresh invariants

Both were broken once and cost a visible flicker each. Do not "simplify" either.

1. **`sessions/groupsLoaded` must dispatch BEFORE `sessions/loaded`.** `sessions/loaded`
   seeds default collapse state and the default selection from the rows it can
   see. With no folder rows in state it collapses nothing and auto-selects a
   folder MEMBER, which then holds the folder open forever to keep that
   selection visible.
2. **The "is this folder still claimed?" check must read the INCOMING catalog**, not
   `state.sessions.byId`. Because of (1) the store still holds the previous
   membership, so a folder whose last member just moved out looked claimed by
   its own stale members and survived its deletion. The refresh passes the fresh
   rows on the action (`{ type: "sessions/groupsLoaded", groups, sessions }`).

`refreshSessions()` also stamps each run (`sessionRefreshSeq`) and drops its
writes if a newer run started while it was awaiting. Refreshes genuinely
overlap — a 4s catalog tick against a run that awaits several sequential
round-trips — and `groupsLoaded` is authoritative, so a stale snapshot landing
late deleted folders that a newer run had just found.

## Workflow

1. Decide which layer owns the change.
2. Implement it in the lowest correct shared layer.
3. Verify with a targeted smoke check.
4. Update this skill if the TUI’s design expectations changed.
5. Update `.github/copilot-instructions.md` if contributor maintenance expectations changed.

## Verification

Prefer fast local checks for TUI work:

```bash
node --input-type=module -e "await import('./packages/app/ui/react/src/components.js'); await import('./packages/app/tui/src/platform.js')"
./run.sh local --db
```

Use targeted selector/controller smokes for shared UI logic. Boot the live TUI when changing layout, keybindings, prompt flow, modal behavior, or terminal rendering.
