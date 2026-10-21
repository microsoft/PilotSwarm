# Session Canvas

The canvas is a session's standing visual workspace: up to five named live HTML
documents that the agent draws, updates in place, presents, and reuses —
rendered in the portal beside the chat, surviving reloads, context
regeneration, and worker moves. Root and sub-agent sessions have the same
canvas tools. The workspace replaced the retired session-summary mechanism as
the at-a-glance answer to "what is this session showing me?"

This is the as-built reference. Design history lives in
[proposals/session-canvas.md](../proposals/session-canvas.md) (v1) and
[proposals/canvas-apps.md](../proposals/canvas-apps.md) (reusable apps;
phases 2–3 there are designed but unshipped).

## The spine: one artifact per slot, one event stream

A drawn canvas slot is exactly two durable facts:

1. **Bytes** — one reserved, always-pinned artifact on the session. Slot 1
   keeps the original `canvas.html` filename; slots 2–5 use `canvas2.html`
   through `canvas5.html`. Every draw replaces that slot wholesale (there is
   no document patching; in-place *data* updates ride ticks, below).
2. **A `session.canvas_updated` event** carrying `{rev, sizeBytes, note?,
   slot, name?, responseContract?, source?}`. `rev` is monotonic within the
   slot, derived from its latest events at draw time. The event is the single
   authority: bytes without an event read as "not drawn".

Ordering is bytes-then-event, awaited, inside a per-session serialized draw
chain in the session proxy — a rev is only ever advertised after both halves
exist. The bridge records the event itself; the generic event persister lists
canvas event types as already-persisted so no path can double-insert. Rev
derivation reads fail loud: a transient catalog error fails the draw rather
than reading as "no canvas" (which would mint rev 1 over a live canvas).

Clients — portal, TUI — learn revisions from the same event they'd learn
anything else from: live push and cold snapshot alike, no side channel. The
portal keeps per-session, per-slot canvas prefs (selection, last viewed
rev/dataRev, and dismissal opt-outs) merged max-wins across devices. A catalog
cache records slot names and latest revisions for efficient cold loads; the
durable event stream remains authoritative.

## Tools

All four tools accept `slot` 1–5 and default to slot 1.

### `draw_canvas`

Exactly one source per call:

- `html` — the complete document inline. Empty string clears the canvas
  (a clear drops any contract; a blank page accepts nothing).
- `fromArtifact: {filename, sessionId?, expectedSha256?}` — render a stored
  HTML artifact **server-side**: bytes move store→canvas and never enter the
  model's context. `sessionId` defaults to the calling session. The sha
  precondition refuses without drawing on mismatch. Provenance
  (`source: {kind, sessionId, filename, sha256}`) rides the event and the
  activity feed line (`[canvas] rev N from <file>`).

Optional on either source: `note` (revision caption) and `responseContract`
(interactivity, below). `name` assigns a friendly slot label up to 60
characters; omitting it preserves the current name.

**The tool result is the interface card** — rev, size, source, the embedded
manifest summary, and the *effective* contract (post-precedence,
post-normalization: exactly what the browser will enforce). Never the HTML.
This is how an agent that drew a stored app without reading it can interpret
incoming actions and author ticks.

### `update_canvas`

A JSON data tick: `{data, note?, slot?}` → a durable `session.canvas_data` event
(payload inline, ≤32 KB serialized, monotonic `dataRev`). The page receives
`{type: "canvas-data", data, dataRev}` via postMessage and applies it with an
idempotent `applyData(data)`; the platform replays the latest tick into any
freshly loaded page. Ticks never steal the screen and write no chat line, but
they do mark the canvas unseen (the toggle badges). Ticks against a
never-drawn canvas are refused. Layout change = redraw; content change = tick.

### `show_canvas`

Presents an already-drawn slot without changing its bytes or revision. It
records `session.canvas_presented {slot, rev}` and asks the portal to open that
canvas or switch slots. It creates no unseen state and obeys the same active
session, freshness, and per-slot dismissal guards as draw-driven presentation.
Use it when conversation returns to an existing visual; use `draw_canvas` or
`update_canvas` when the content itself changes.

### `read_canvas`

Paged text (`slot` plus `offset`/`maxBytes`) — or `manifestOnly: true` for the
interface card without the bytes: the embedded manifest summary plus the
**armed** contract from that slot's latest draw event (re-validated on the way
out). This is the re-learning path after context regeneration or for an agent
that inherited a canvas it did not draw.

## Interactivity: the response contract

A canvas becomes interactive when the draw carries a `responseContract`:

```jsonc
{ "actions": { "<name>": { "<field>": "string|number|boolean|json" } },  // "?" suffix = optional
  "data": { "example": { } } }   // optional, documents the tick shape (≤1 KB)
```

Caps: 16 actions × 16 fields, 4 KB serialized. The `data` key survives
normalization deliberately — it is what makes "re-read the contract before
ticking so your payload never drifts" a real loop.

The page posts `parent.postMessage({type: "canvas-action", action, data}, "*")`.
The browser then enforces, in order:

1. **Provenance** — the message's source window must be the *live* canvas
   iframe's contentWindow. Staging frames, artifact previews, popups, and
   every other window fail the identity test.
2. **Contract validation, default-closed** — no contract means nothing is
   accepted; unknown actions/fields, wrong types, oversized payloads (8 KB
   serialized, 2048-char strings) are refused. Validation never throws, even
   on structured-clone-legal garbage (cycles, BigInt).
3. **Rate limit** — burst 3 per 3 s per session.
4. **Creator-only, fail-closed** — the server accepts a canvas action only
   from the session creator (`viewerIsOwner`); shared writers and admins are
   refused, and a missing/unloaded snapshot refuses. The client mirrors the
   check for UX; the server is authoritative. Rationale: shared viewers see a
   UI whose state may have mutated — only the creator's view is known to
   correspond to what the agent drew.

Conforming actions arrive as user messages
`[canvas-action] {"action": ..., "data": ...}` — self-labeling, hidden from
the portal chat pane (the redraw is the visible half of the loop), visible to
the agent, and excluded from auto-titling. Agents answer on the canvas, not
in chat.

## Shared state: the KV store

An interactive app holds state that several people change at once. That
state lives in the canvas KV store (migration 0064, `canvas_kv`): one row
per `(session, slot, key)`, the value is an envelope `{ v, by, at }` stamped
server-side, `rev` is the compare-and-swap token, deletes are tombstones.
Every write fires one NOTIFY on the canvas plane (`kind: "kv"`), so every
viewer sees the change in ~50 ms with no redraw and no agent turn.

```
Door 1  signed-in browser   readCanvasKv / writeCanvasKv   (canvas:read / canvas:write → session read)
Door 2  link bearer         GET /api/canvas-share/kv?t=     (read only until phase 4)
Door 3  the agent           canvas_kv { op: get|put|list|delete }

all three → packages/sdk/src/canvas-kv.ts, the one place the rules live
```

Who may write is two switches, both owner-controlled: the canvas policy
(`setCanvasKvAccess`: `owner` | `readers` | `link`, in the share dialog) and
the app's manifest (`"kv": { "write": "viewers", "shared": ["app/task/*"] }`).
Session writers always write (they could launder a write through the
agent). Reserved prefixes: `cfg/` (owner + agent), `evt/` (agent → page),
`ui/<writer>` (each viewer's own), `req/` (a collaborator's request is
capped to `status: "suggested"`; only the owner or the agent queues). Other
rows are author-bound unless the manifest shares the prefix. Limits: 200-char
keys, 16 KB values, 1000 keys and 2 MB per canvas, 10 writes/s per viewer.

The page talks to the host with `canvas-kv` (ops `ready | get | list | put |
delete`) and receives `canvas-kv-ready`, `canvas-kv-result` and
`canvas-kv-change`; the `canvas-apps` skill ships the `CanvasKV()` helper a
page pastes. Nothing is injected into the document.

## The app registry

Canvas apps live in their own registry in the CMS (migration 0084), not in
facts. An app belongs to a user (its owner), is **private** (owner and
unrestricted admins) or **shared** (everyone), and has SemVer versions, one
of them active. A version's bytes are stored once, content-addressed, in the
app's own artifact space; the app outlives the session it was published
from. Contributors of a shared app may publish versions of it.

```
publish_canvas_app({ name, description, tags?, scope?, version?, slot? })
   → a version of the user's app; private unless scope: "shared"
   → the same bytes again: no change; new bytes: the manifest's version, else the next patch
find_canvas_app({ query })   → ranked apps the user may see
find_canvas_app({ name })    → that app's full card (interface, contract, workspace)
draw_canvas({ fromApp: { name, version?, scope? } })   → on screen, card returned
manage_canvas_app({ action, name, ... })   → enable/disable, describe, pin, share/unshare,
                                             contributors, delete
```

A user's private app hides a shared app of the same name for that user;
`scope` picks the other. Agents act with their session owner's rights; a
system or ownerless session cannot publish. The same operations are on
`PilotSwarmManagementClient` (direct and Web API), the MCP server, the
`pilotswarm apps` CLI and the portal. Export writes a deterministic
`.tar.gz` of every version and the card, with no owner or ids; import
checks the whole archive first. The legacy `apps/<name>` facts migrate once
with `migrateLegacyCanvasApps` (an admin action): each migrated fact is
removed only at the revision that was migrated (an atomic compare-and-delete
on its etag; a fact replaced meanwhile stays), and a skipped one stays. An
existing shared app is extended only by the same bytes.

### The transition (`PILOTSWARM_CANVAS_LEGACY_MODE`)

One switch, `on` by default, keeps the old catalog working next to the
registry (`canvas-legacy.ts`, exported as `canvasLegacyModeFromEnv()`). Each
process reads it: workers (`PilotSwarmWorkerOptions.canvasLegacyMode`) and
the portal (`PilotSwarmManagementClient` config `canvasLegacyMode`). An
unrecognized value is `off`.

| | `on` | `off` |
|---|---|---|
| `find_canvas_app({query})` | registry apps, then old `apps/*` cards from main's own search, in their old shape (`legacy: true`, `key`, `source`); a registry app of the same name wins unless it is not found for the user (a disabled one still wins); a failed old-catalog search is reported as `legacyError` | registry only |
| `find_canvas_app({name})` | the registry app, else the old card at exactly `apps/<name>` | the registry app |
| Agent and management writes to `apps/*` | allowed, as before | refused |
| A legacy page (below): workspace calls | no approval | the owner approves the exact program |
| A legacy page: agent byte reads (`read_artifact`, copy, `read_canvas`, publish from a slot, private-bytes `fromArtifact`) | allowed | refused when they are another owner's app |
| `page` label on KV values and actions | none for owner, agent or a legacy page; `cross-owner` (with the app) for another user's app; `unknown` when the page's origin cannot be confirmed | the same, without the legacy case |
| A legacy page: share link | the page itself (text/html, CSP sandbox), as on main | by trust |
| `getCanvasRevisionLabel` | `{rev, trust, app?, legacy, pageSha256?}` from one read of the latest draw, judged now | the same with `legacy: false` |
| Bootstrap `canvasLegacyMode` | `true` | `false` |

**A legacy page** (`canvasRevisionIsLegacy`), judged by the process that
uses it, when it uses it, with its own switch:

- (a) an old app's page: the draw event says `legacy: true` (the worker
  adds it next to the true `trust` when the page's sha256 is in the set),
  its recorded `pageSha256` is the page being used, and that sha256 is in
  the set now; or
- (b) a revision drawn before the registry: the event records no `trust`,
  the minted revision equals the event's (no redraw in flight), and the
  bytes used are the recorded ones when the event recorded any.

The draw-time flag alone never exempts anything server-side: the worker's
byte guard and KV label, and the portal's approval, action label and share
link, each re-check the set when the page is used. The event's `trust` is
never rewritten, so with the switch off every page follows the registry's
rules again; a worker or portal whose own switch is off ignores the flag,
so a mismatch applies the stricter rules. While on, an old app's exact
bytes are exempt even when the same bytes are also another user's registry
app (the exemption is per sha256). A sha that cannot be established is
not in the set: a failed refresh (or an unknown install time)
exempts nothing, so old pages ask for approval and are labelled until a
good read (a facts-store outage brings the prompts back). A partial
enumeration (the read budget below reached) exempts only the qualifying
cards it read, never one it did not reach: a card read is a real row at its
exact key, judged by its own `updated_at`, so writing many `apps/*` facts
cannot strip an old app's exemption.

Labels decide from one draw event at a time: the worker's KV label reads
the latest event, hashes the stored page and reads the minted revision
(`canvasPageLabel`); the portal's action label uses one
`getCanvasRevisionLabel` answer (`canvasPageLabelFor`). Only `owner`,
`agent` or a verified legacy decision go unlabelled; a failed read, no
event, no trust (when case (b) does not hold) or an unknown trust string
is labelled `unknown`. Case (b) needs the minted revision from
`session_canvases` itself (`mintedCanvasRevStrict`): a failed read is
"cannot tell", never the event's revision. Case (b) is a format rule, not a
clock: every PR 195 draw records `trust`, but during a rolling deploy a
worker still on the previous release draws without it. Such a worker is
compatibility-trusted during the rollout: its draws count as case (b)
while the switch is on.

A card counts as an old app (`CanvasLegacyCatalog.isExemptSha256`) only if
all of these hold:

- its key is `apps/<valid app name>` and its `source` has a sha256;
- its fact was last written at least 5 minutes
  (`CANVAS_LEGACY_CUTOFF_MARGIN_MS`) before the registry's install: the
  `applied_at` of CMS migration 0084 in the migrations table
  (`CanvasAppStore.installedAt()`).

The database sets a fact's `updated_at` on every write, so a card written
or changed after the deploy is still found and drawn, but it is not an old
app. The margin covers clock skew between a separate facts database and the
CMS (skew above 5 minutes is not covered), transaction-start timestamps and
sub-millisecond precision; it only narrows the set.

The set is enumerated at most once a minute per process, completely: a key
prefix whose read returns a full page (1,000 facts) is split on the next
name character, so newer facts cannot push an old card out. One
enumeration makes at most 200 reads; past that it is incomplete and
exempts only the qualifying cards it read. An unknown install time, or a
failed refresh after the minute, exempts nothing. Searches run main's search on every
call; find by name reads the one exact key.

The card is derived from the document's `CANVAS-APP-MANIFEST`, never from
the model's memory of it, and **publish refuses a manifest without an
`interface` block**: `keys` (which KV keys, who writes them, an example
value), `requests` (which `req/*` ops the page queues, their args and the
`result` it renders), `events` (which `evt/*` notes it shows). That block is
what an agent that never read the HTML drives the app from. Code:
`canvas-app-registry.ts` (service), `canvas-app-store.ts` (procedures);
manifest grammar and caps in `canvas-app-manifest.ts`.

Every `fromApp` draw, and every `fromArtifact` draw whose bytes equal a
version, records a load (time, session, user, app, version), kept 400 days;
owners and unrestricted admins read them (`getCanvasAppLoads`, the tuner's
`read_canvas_app_loads`).

### Who a page belongs to

Every draw is classified for the canvas's owner and the result rides the
draw event: `owner` (the owner's app, by `fromApp` or exact bytes),
`cross-owner` (another user's app, by `fromApp`, exact bytes, or the same
workspace block), or `agent` (anything else). A draw that cannot be
classified is recorded as `cross-owner`. A share link whose draw event
carries no recognised trust serves the page as `cross-owner`. The session
canvas does the same: a draw event without a recognised `trust` (one
recorded before the registry existed) is `cross-owner` until the canvas is
drawn again. The sessions list can name a canvas revision before the portal
reads its draw event, so the session canvas waits for the revision's trust
before it frames the page: the first frame is the final one, and an app is
not started twice. If the trust has not come after 3 seconds, the page is
framed as `cross-owner` and says it could not confirm whose page it is; a
`cross-owner` trust that arrives later with the `pageSha256` of the bytes
on screen keeps that frame, and an `owner` or `agent` trust frames the page
again, directly. A list revision newer than the one the store knows drops
the older revision's trust and has the draw events read again; that read
pages back (at most 10 pages of 30 draw events) to find each known slot's
own draw event, and re-reads a revision named ahead of its draw event at
most 5 times before it leaves it sealed (Retry reads again). A `cross-owner` page is framed by
the portal through one isolation contract (`ui/react/src/canvas-isolation.js`):
a portal-authored wrapper document holds no app bytes, sets the page as its
inner frame's `srcdoc`, carries the app policy plus `frame-src 'none'`, relays
only between the portal and that one inner frame, and stops for good if the
inner frame loads twice. Once its page has loaded, the wrapper tells the
portal, which replays the current tick state to it. The session canvas, the share viewer and the Files
preview of canvas files all use it, and a frame's bytes must match the
`pageSha256` its draw event recorded. Its owner is named; actions
and `canvas_kv` values from it reach the agent with a `page` label. The
artifact and canvas read tools do not hand an agent another owner's app
bytes the registry identifies (defense in depth only: a near-copy is not
recognized), and `publish_canvas_app` does not publish them as the session
owner's app (contributors and admins still publish into an app they may
edit). Bytes the viewer can already obtain as a version it may see (its own
app, a shared app, or any app for an admin) are never withheld because
someone else holds an identical private copy; a foreign shared app's
workspace block is still refused.

### Workspace approval

No page uses the session's folders or commands (canvas-ws) until the
session owner approves that exact program: the page bytes, its checked
`workspace` block and the folders its names resolve to, in that slot of
that session. Classification never authorizes; it only changes the prompt's
wording. The identical program redrawn keeps its decision; any change asks
again. The portal asks in its own shell (`getCanvasWorkspaceApproval`,
`setCanvasWorkspaceConsent`, both the session owner's only); no agent tool,
MCP tool or CLI command reaches them. See
[security and sharing](../user-guide/security-and-sharing.md).

## Canvas apps: save and reuse

A canvas worth drawing twice is an app. Convention: one comment immediately
after `<!doctype html>` —

```html
<!-- CANVAS-APP-MANIFEST
{ "manifestVersion": 1, "name": "...", "version": "...", "description": "...",
  "responseContract": { "actions": { ... } },
  "data": "tick shape notes", "notes": "usage notes" }
-->
```

- Only a comment that **opens** with the marker is a manifest — prose or
  script text mentioning the convention is ignored, and a broken manifest is
  distinguishable from an absent one.
- The embedded contract passes the **same normalizer** as the tool argument.
  Precedence at draw time: explicit `responseContract` argument → manifest
  contract → none. An invalid embedded contract fails a `fromArtifact` draw
  closed; an inline draw tolerates a broken manifest but warns in the result.
- Prose fields clamp at 400 chars (surrogate-safe) so cards stay cheap.

The lifecycle, with no byte ever entering model context:

```
draw_canvas(html: ...)                                  # build live, manifest embedded
write_artifact({fromArtifact: {filename: "canvas.html"},
                filename: "app-<name>.html"})          # server-side save-as
read_artifact({sessionId, filename, manifestOnly: true})  # browse candidates
draw_canvas({fromArtifact: {filename: "app-<name>.html"}})  # reuse; result = interface card
```

The canvas documents themselves (`canvas.html` … `canvas5.html`) are
written only by a draw: `write_artifact` and the Web API upload and copy
operations refuse them as targets, and a workspace call runs only when the
stored file still hashes to the page its draw event recorded.

Cross-session sources ride the platform's worker-trusted artifact layer, the
same trust `read_artifact`/`write_artifact` already extend — the drawing
agent vouches for what it draws. To reuse an app across sessions and users,
publish it to the registry and draw it `fromApp`. Package-shipped apps
(`fromPackage`) are designed but unshipped (canvas-apps.md phase 2).

## Presentation

The portal renders the selected canvas in a sandboxed iframe
(`allow-scripts allow-popups allow-popups-to-escape-sandbox`, no
`allow-same-origin`, `allow="autoplay *"` — an opaque origin can never match
the default `'src'` allowlist). New revisions load through a visible
under-stack double buffer and promote by z-order only, so a redraw never
white-flashes and iOS registers the frame for touch scrolling. Frames are
kept alive off-screen (transform-parked, `inert`) to preserve page state
across toggles.

**Resizes reflow; they never reload.** A page that loaded at a real size owns
its layout — the inner window receives genuine resize events. The only
automatic reload rescues documents that loaded against a degenerate box (the
iframe's intrinsic default before layout). In-memory state — game progress,
form drafts — survives window drags and rotations. (The artifact *reader*
pane is different: it reloads on width settles; stateful pages belong on the
canvas.)

Viewed-marking comes only from the frame's own promote receipt while visible
— never from mode transitions — so the unseen badge (draws and ticks both
set it) means what it says.

## Availability and limits

- **Every session may own canvases.** Root sessions and sub-agents receive the
  same canvas declarations and handlers. Each session owns its own slots;
  drawing in a child does not mutate the parent's canvases.
- **Slots**: 1–5, default 1. Revisions, names, latest ticks, stored artifacts,
  and dismissal/view state are independent per slot.
- **Caps**: document ≤900 KB (store text cap is 1 MiB); ticks ≤32 KB;
  contract 16×16 fields / 4 KB (+1 KB `data`); action payloads ≤8 KB with
  2048-char strings; card prose 400 chars/field.
- **Authoring rules** (enforced by the sandbox, taught by the `html-visuals`
  skill): fully self-contained, no network, no storage; `parent` property
  reads throw — `parent.postMessage` is the one allowed call; colors on
  `html, body`; 16 px+ inputs; audio unlocks on `touchend`/`click` (never
  `touchstart` alone) plus `navigator.audioSession = "playback"` where
  available.
