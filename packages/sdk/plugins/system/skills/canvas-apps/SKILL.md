---
name: canvas-apps
description: Interactive and SHARED canvas apps — page actions, the canvas_kv store, requests the page queues, the session's files and declared commands (canvas-ws), saving apps. Load before any canvas that takes input, uses files, or is shared.
---

# Canvas Apps

A canvas visual is disposable presentation. A canvas app holds state, lets
several people use it at once, and asks the session to do things. For page
layout, chart form, color and the sandbox rules, load `html-visuals` first.

## The three lanes

| Lane | Who writes | Reaches | Wakes you | Durable | Costs you |
|---|---|---|---|---|---|
| **KV** (`canvas_kv`) | any permitted viewer, and you | every viewer, ~50 ms | no | yes | tens of tokens per key |
| **Action** (`canvas-action`) | a viewer with session write | you | yes — one turn | as a message | a whole turn |
| **Tick** (`update_canvas`) | you only | every viewer, ~50 ms | no | no | patch: tens · data: thousands |

**The KV is for state, the action is for attention.** Never put a payload
in an action when you can put an id there and the payload in the KV.
Outbound costs output tokens, inbound costs a turn — the turn is the unit.

Cheapest first: `canvas_kv(put)` one key · `update_canvas(patch)` a subtree ·
`draw_canvas(fromArtifact)` a filename · `update_canvas(data)` whole state ·
`draw_canvas(html)` the whole document.

## The KV store

One row per key, per session, per slot. The page supplies only the key; the
server stamps the writer (`by`) and the time (`at`). Keys: letters, digits,
`. _ / -`, ≤200 chars. Values ≤16 KB; 1000 keys and 2 MB per canvas.

Reserved prefixes:

```
app/…            the app's shared state — notes, votes, the board
req/<reqId>      a request from the page to you (below)
evt/<n>          a note from you to the page (you write, viewers read)
ui/<writerId>    one viewer's ephemeral state (presence, drafts) — only theirs
cfg/…            you and the owner write, everyone reads
```

**Never keep a list in one key.** One key per item (`app/note/<uuid>`), one
key per person (`app/vote/<me.id>`), a claim is `put` with `ifMatch: 0`,
ordering is a field inside the item. Counters: per-person keys, count them.
Free text several people edit: split into per-section keys and show `by`.
Frame-rate state (a game board, live spectating) does not belong here.

Your tool: `canvas_kv({op: get|put|list|delete, key, value, prefix, limit,
after, ifMatch, slot, session_id})`. `ifMatch: 0` = create only; `ifMatch: N`
= the current rev must be N. `list` pages by `after` (the last key of the
previous page). `slot` picks the canvas (1-5, default 1); `session_id`
targets an ANCESTOR session's canvas, as the other canvas tools do.

### Who may write

Two switches, both needed. The **owner's policy** on the canvas
(`owner` default | `readers` = anyone the session is read-shared with |
`link`), set in the share dialog. And **your app's declaration** in the
manifest: `"kv": { "write": "viewers" }`. Without both, only the owner, the
session's writers, and you write. Rows are author-bound: a collaborator
edits only rows they wrote unless you share the prefix
(`"kv": { "write": "viewers", "shared": ["app/task/*"] }`).

Everyone reads. Every write is attributed: `by.kind` is `user` (signed in),
`link` (bearer — label unverified) or `agent`.

## The page side — paste this helper

Nothing is injected into the document. Paste `CanvasKV()` into your page:

```js
function CanvasKV() {
  const waiting = new Map(); let n = 0; const listeners = [];
  const ask = (msg, retryMs) => new Promise((res, rej) => {
    const id = ++n; waiting.set(id, { res, rej });
    const send = () => parent.postMessage({ type: "canvas-kv", id, ...msg }, "*");
    send();
    // The host may not be listening yet on a cold open: re-post until answered.
    if (retryMs) { const t = setInterval(() => waiting.has(id) ? send() : clearInterval(t), retryMs); }
  });
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "canvas-kv-change") { listeners.forEach((f) => f(m)); return; }
    if (m.type !== "canvas-kv-result" && m.type !== "canvas-kv-ready") return;
    const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id);
    m.ok ? w.res(m) : w.rej(Object.assign(new Error(m.error || "failed"), { code: m.code, rev: m.rev }));
  });
  const listAll = async (prefix) => {          // every key under a prefix, across pages
    let after = null, out = [];
    do { const r = await ask({ op: "list", prefix, after }); out = out.concat(r.entries); after = r.nextAfter; } while (after);
    return out;
  };
  return {
    ready: ask({ op: "ready" }, 500),                          // → { me, canWrite, policy, entries (first 200) }
    listAll,                                                   // → [{ key, v, by, at, rev }]
    get: (key) => ask({ op: "get", key }).then((r) => r.entry),
    put: (key, value, ifMatch) => ask({ op: "put", key, value, ifMatch }),   // → { rev } | rejects { code, rev }
    del: (key, ifMatch) => ask({ op: "delete", key, ifMatch }),
    onChange: (f) => listeners.push(f),                        // { key, rev, op, v?, by, at }
  };
}
```

```js
const kv = CanvasKV();
const { canWrite, me } = await kv.ready;
renderAll(await kv.listAll("app/"));                 // list the app prefix — ready carries only the first 200 keys
kv.onChange(async (c) => applyOne(c.v === undefined && c.op !== "delete" ? { ...c, v: (await kv.get(c.key))?.v } : c));
if (!canWrite) lockTheUI("You can view this board but not edit it.");
setInterval(() => document.visibilityState === "visible" && kv.listAll("app/").then(renderAll), 15000); // resync if the live feed drops
```

`me` is `{ id, kind, label, relation, canWrite }`; `relation` is `owner |
admin | collaborator | viewer | link`. **`me.id` is `provider/subject`** —
it contains a slash, so a per-person key `app/vote/<me.id>` spans two
segments (fine; list by prefix `app/vote/`). `label` is the person's
display name (their email or subject when no name is known).

Entries are `{ key, v, by, at, rev }` — `v` is what a page stored; `by` and
`at` let you attribute and order. A `canvas-kv-change` may arrive **without
`v`** (the value was too big to ride the ping): fetch the key, as above.
`op: "delete"` drops the key. Rejections carry `code` — `FORBIDDEN`,
`CONFLICT` (with the current `rev`, so a claim can show who won),
`INVALID_KEY`, `TOO_LARGE`, `QUOTA`, `NOT_READY` (retry). Render from the KV,
not from state baked into the document; preserve in-flight drafts across
re-renders.

New keys are open to every admitted writer; only overwrites are
author-bound. "Only the owner may add" is a UI rule, not a server rule.

## Requests: the KV carries the payload, the action rings the doorbell

```
page   put req/<id> { op, args, status: "queued" }        every viewer sees it
page   canvas-action { action: "request", data: { id } }  turn starts (if the viewer may ring)
you    canvas_kv get req/<id> → put { status: "working" } → put { status: "done", result }
page   renders the answer. No redraw.
```

Contract: `"responseContract": { "actions": { "request": { "id": "string" } } }`.
Rows carry `{ op, args, status, result?, error? }` with `status` in
`suggested | queued | working | done | failed`.

**Only the owner and you decide what you act on. Everyone else suggests.**
A collaborator's `req/*` row is capped to `status: "suggested"` by the
server; the owner promotes it by writing `status: "queued"`. Your drain, on
EVERY wake (a cron tick, a child completion, any turn):

```
canvas_kv list req/  →  take every row with status "queued"  (never "suggested")
do the work, land each row in "done" or "failed"  — never leave one "working"
```

The doorbell only shortens the wait; the status is the boundary. An app
whose requests progress only while the owner has a tab open is broken for
autonomous use: render `queued` honestly ("picked up on the next run"), and
`suggested` as "waiting for the owner", never a spinner.

Recovery after a memory gap: `canvas_kv list req/` (unfinished work),
`canvas_kv list app/` (current state), `read_canvas(manifestOnly)` (the
armed contract). This is why app state lives in the KV, not in chat.

**Promotion is a decision, never a reflex.** Only the owner's ask or your own
task moves KV content into an artifact, a shared fact, or an external write
(ADO, a PR comment, email). Carry `by` across. Never promote link-written
content into a shared fact without the owner saying so.

## Actions (the doorbell)

```js
parent.postMessage({ type: "canvas-action", action: "request", data: { id } }, "*");
```

The browser validates against your contract (no contract → nothing is
accepted) and delivers conforming posts as `[canvas-action] {...}` user
messages hidden from the chat pane. Answer on the canvas (a KV put or a
patch), not with a redraw that wipes drafts. Actions are accepted only from
a viewer with session write; everyone else's request lands `suggested`.
Never BLOCK on a canvas control — the chat box is the fallback, and real
approval gates stay on `ask_user`. Batch a whole form into ONE action with a
`json` field.

## The manifest: the app's interface, for the agent who did not write it

A canvas worth drawing twice is an app, and an app is driven by agents who
never read its HTML — you after a context regeneration, and every other
session that finds it in the catalog. The manifest comment right after
`<!doctype html>` is the whole interface. Write it as if for a stranger:

```html
<!-- CANVAS-APP-MANIFEST
{ "manifestVersion": 1, "name": "release-signoff", "version": "1.2.0",
  "description": "Use when several approvers sign off a release train together.",
  "tags": ["release", "approval", "collaborative"],
  "kv": { "write": "viewers", "shared": ["app/item/*"] },
  "responseContract": { "actions": { "request": { "id": "string" } } },
  "interface": {
    "keys": [
      { "key": "app/item/<id>", "writer": "both",
        "shape": { "title": "Fix login redirect", "owner": "sam", "decision": "approve|reject|null", "note": "" },
        "note": "One row per checklist item. The AGENT seeds them; approvers set decision and note." },
      { "key": "cfg/deadline", "writer": "agent", "shape": "2026-09-01T17:00:00Z" },
      { "key": "ui/<writerId>", "writer": "page", "shape": { "at": "iso" }, "note": "Presence heartbeat." }
    ],
    "requests": [
      { "op": "seed", "args": { "items": [{ "id": "5502432", "title": "…", "owner": "…" }] },
        "result": { "seeded": 12 }, "note": "Owner asks the agent to (re)load the checklist from the train." },
      { "op": "store", "args": {}, "result": { "artifact": "signoff-<train>.md" },
        "note": "Owner presses Store: the agent writes the decisions as a report artifact." }
    ],
    "events": [ { "key": "evt/banner", "shape": { "text": "Freeze at 17:00 UTC" }, "note": "Rendered at the top." } ],
    "notes": "Render everything from app/item/*. A row with decision null is pending. Count approvals by listing." } }
-->
```

`interface.keys` says which KV keys exist, who writes them and what a value
looks like. `interface.requests` says which `req/*` ops the page queues, with
their args and what `result` the page renders when you land them.
`interface.events` says which `evt/*` notes the page shows. Caps: 32 entries
per list, 512 bytes per shape, 6 KB for the block. `description` is the text
the catalog ranks on: say WHEN to use the app, not how it works.

Re-learn any app with `read_canvas({manifestOnly: true})` — never by
re-reading the bytes. `draw_canvas({fromArtifact})` hands you the same card.

## Publish and find

```
publish_canvas_app({ name: "release-signoff", description: "Use when …", tags: [...] })
   → the canvas bytes → pinned artifact app-<name>.html on this session
   → the card (manifest + armed contract + source) → SHARED fact apps/<name>
   → every session can find it

find_canvas_app({ query: "sign off a release" })
   → ranked cards { key, name, description, tags, kv, source }
read_facts({ key_pattern: "apps/<name>", scope: "shared" })   → the full card, incl. interface
draw_canvas({ fromArtifact: card.source })                     → on screen, card returned again
```

**Look before building.** When the user asks for an app — a board, a poll, a
sign-off sheet, a review workbench — search first and offer what exists.
When the user is doing something an app fits (reading a diff, running a
meeting, watching a deploy), search and suggest rather than waiting to be
asked. Publish when the user says to share it.

**Driving an app you found:** draw it, `canvas_kv(list, "app/")` to see its
state, seed the keys its `interface.keys` name (the shapes are examples to
copy), drain `req/*` on every wake and land each with the `result` shape the
card gives. You never need the HTML.

**Publish the shell, never the data.** Publishing makes the document readable
by every session. A reusable app reads its rows from the KV; a page with a
customer list baked into a JS literal is not reusable and must not be
published. Republishing the same name replaces the card and the artifact.

## The session's folders (canvas-ws)

A canvas app can read and change the session's files, and run commands you
declare, with no turn of yours: a git history viewer, a notes editor, a
test-log browser. It is for the session's **owner** only; for anyone else
every call fails.

Declare the access in the manifest. The server checks every call against
this block, read from the document you drew; the page cannot widen it.

```
"workspace": {
  "read":  ["work/**"],                       list and read
  "write": ["home/notes/*.md"],               also write, move, delete
  "watch": true,                              the page hears when files change
  "commands": {
    "history": { "in": "work",
      "run": ["git", "log", "--format=%H%x09%an%x09%ar%x09%s", "-n", "{limit}", "--", "{path}"],
      "params": { "path": { "type": "path" }, "limit": { "type": "int", "min": 1, "max": 200, "default": 50 } } },
    "show": { "in": "work", "run": ["git", "show", "--stat", "--patch", "{sha}"],
      "params": { "sha": { "type": "sha" } } }
  }
}
```

Paths are `<folder>/<path>`: `work` is the working folder, an extra folder
keeps its name (`home`, `shared`). In a session with no repo, the person's
own folder IS the working folder, so it is `work`, not `home`. Call `info()`
to see the names. `**` crosses folders, `*` does not.
Declare the least you need. `.git` is read-only whatever you declare.
A command's `in` is a session folder or a folder inside one (`work/tfenv`
for a repo cloned into the working folder); its `path` values must be
inside it and are passed relative to it.

Commands: `run[0]` is a program name (no path). A `{param}` must be a whole
argument, never part of one. Types: `path` (inside the command's folder, a
file the app may read, or a folder it may read all of), `int` (`min`
defaults to 0), `enum` (`values`), `ref` (a branch or tag), `sha` (hex),
`text` (one line, not starting with `-`). There is no shell.
`timeoutSeconds` ≤ 60, output ≤ 1 MB. For git: `run[1]` is the subcommand
(log, show, diff, status, blame, ls-files, add, commit, restore, reset,
stash, switch, checkout, mv, rm, …), with no options before it; choose the
repository with `in` (`work/tfenv`), never `-C`. Options that start
programs or reach outside (`--output`, `--no-index`, `--exec`, …) and
absolute or `..` paths are refused when you draw. Git runs with no network,
no hooks, and not in a repository whose own settings start programs.
The deployment decides whether commands run at all and which programs may
run (git by default). A page cannot know which: handle
`CANVAS_WS_COMMANDS_DISABLED` and `CANVAS_WS_PROGRAM_NOT_ALLOWED`. Your next
turn is told a command ran (once a minute per command), not what it did.

Paste this helper:

```js
function CanvasWorkspace() {
  const waiting = new Map(); let n = 0; const listeners = [];
  const ask = (msg, tries = 20) => new Promise((res, rej) => {
    const id = ++n; waiting.set(id, { res, rej, msg, tries });
    parent.postMessage({ type: "canvas-ws", id, ...msg }, "*");
  });
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "canvas-ws-change") { listeners.forEach((f) => f(m)); return; }
    if (m.type !== "canvas-ws-result") return;
    const w = waiting.get(m.id); if (!w) return; waiting.delete(m.id);
    if (!m.ok && m.code === "NOT_READY" && w.tries > 0) { setTimeout(() => ask(w.msg, w.tries - 1).then(w.res, w.rej), 250); return; }
    m.ok ? w.res(m.result) : w.rej(Object.assign(new Error(m.error || "failed"), { code: m.code }));
  });
  const b64 = { enc: (s) => { const u = new TextEncoder().encode(s); let b = ""; for (let i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(b); },
                dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))) };
  return {
    info: () => ask({ op: "info" }),                            // → { folders, read, write, commands, commandsEnabled, maxBytes }
    list: (path) => ask({ op: "list", path }),                  // → { entries: [{ name, path, kind, size, mtimeMs, readOnly? }] }
    readText: (path) => ask({ op: "read", path }).then((r) => ({ ...r, text: b64.dec(r.contentBase64) })),   // + etag
    writeText: (path, text, ifMatch) => ask({ op: "write", path, contentBase64: b64.enc(text), ifMatch }),   // ifMatch: etag, or null = create only
    mkdir: (path) => ask({ op: "mkdir", path }),
    move: (path, toPath) => ask({ op: "move", path, toPath }),
    remove: (path, recursive) => ask({ op: "delete", path, recursive }),
    run: (command, params) => ask({ op: "run", command, params }),   // → { exitCode, stdout, stderr, truncated }
    download: (path) => ask({ op: "download", path }),          // from a click handler only: saves the file (a folder as .zip)
    watch: (f) => { listeners.push(f); return ask({ op: "watch" }); },   // f({ reason: "agent" | "owner" | "canvas" })
  };
}
```

A write with a stale `ifMatch` fails `WORKSPACE_FILES_CONFLICT`: read again,
show both, let the person choose. A create-only write (`ifMatch: null`) on
a file that exists fails `WORKSPACE_FILES_EXISTS`. Other codes:

| Code | Means |
|---|---|
| `CANVAS_WS_DENIED` | outside your block; or `watch` not declared; or the repo's git settings start programs |
| `CANVAS_WS_UNDECLARED` | no block, or a broken one (the message says what is wrong) |
| `CANVAS_WS_TIMEOUT`, `CANVAS_WS_BUSY`, `CANVAS_WS_RUN_FAILED` | a command ran too long, too many ran at once (try again), or it did not start |
| `WORKSPACE_FILES_NOT_FOUND`, `_READ_ONLY`, `_TOO_LARGE`, `_OUTSIDE` | no such path; `.git` and read-only files; over the size limit; a link or a path out of the folder (canvas apps never follow links) |
| `WORKSPACE_FILES_BUSY` | too many file calls at once in the portal: try again in a moment |
| `NOT_READY`, `NOT_ALLOWED`, `BUSY`, `UNAVAILABLE` | from the portal: the page is still loading (the helper retries), a download without a click, a download already running, no workspace support |

The change notice carries no paths: read again what you show. Your next
turn is told which files the page changed.

A link in a canvas opens in a new tab, never in the canvas frame. A page
that sends itself elsewhere (`location.href = ...`) loses the session: the
page it loads gets no answers, and the portal offers to show the canvas
again.

## Where html-visuals differs

`html-visuals` was written for single-writer canvases. For a KV app, two of
its rules invert: state lives in the KV, not batched into one submit action
(the "Forms: batch the input" pattern is for canvases WITHOUT a store), and
any viewer with session write may post actions, not only the creator.

## Fit the pane

Design the shell to the viewport (`html, body { height: 100% }`, grid rows
`auto 1fr auto`, only the middle scrolls with `min-height: 0`), never
`overflow: hidden` on `body`, `100dvh` not `100vh`, inputs at 16 px, sticky
headers on long lists. A resize reflows and never reloads. Test at ~380,
~700 and full width.
