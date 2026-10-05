# The Workspace tab and the agent: what the person sees, where the agent points

Status: proposal, 2026-10-02. Short by design.

## The idea

The canvas already talks to the agent both ways. The Workspace tab should
too:

```
person → agent   The agent knows what the person is looking at in the tab:
                 the folder, the open file, the lines on screen, the selected
                 text, the diff or commit shown.
agent → person   The agent can point the tab at a place: a folder, a file and
                 line, a diff, a commit, History.
```

So "fix this" with three lines selected needs no copy and paste. And "look at
the commit that broke it" opens that commit for the person.

## 1. Person → agent: the view

**What the tab reports** (one small record, the latest only):

| Field | Example |
|---|---|
| `folder`, `repo` | `home`, `pilotswarm` |
| `tab` | `files` / `changes` / `history` |
| `file` | `packages/sdk/src/cms.ts` |
| `lines` | the lines on screen: `1904–1941` |
| `selection` | `{ from: "1921:5", to: "1922:60", text: "…" }` (text up to 4 KB) |
| `diff` | `{ path, left: "Index", right: "Working Tree" }`, or `abc1234^ ↔ abc1234` |
| `commit` | `{ sha, subject }`, the commit open in History |
| `changesView` | `since last commit` / `in commit abc1234` / `between a and b` |

The file's text is not sent. The agent reads the file itself when it needs
more than the selection.

**How it travels:**

```
1. The tab sends the record when it changes, at most once every 2 s:
   a new call, sessionWorkspaceFiles { op: "view", view: {...} }, owner only
2. The portal keeps the latest record per session (one row, written over,
   like the canvas key-value store): no event per change
3. At the start of a turn, the worker adds one line to the prompt if the
   view changed since the last turn, as it does today for files the person
   edited ("The person is viewing cms.ts, lines 1904–1941; selected: …")
4. A new agent tool, workspace_view, returns the whole record on demand
```

## 2. Agent → person: "show this"

**A new agent tool:**

```
workspace_show({
  folder,                      // "work", "home", "shared", ...
  path?, line?, endLine?,      // a file, and the lines to bring into view
  view?: "files" | "changes" | "history" | "diff" | "commit",
  sha?, since?,                // a commit; a "Changes since" base
  note?                        // one line shown to the person: why this
})
```

**How it travels:**

```
1. The worker checks the target: a session folder, a path inside it
2. It writes a durable event, session.workspace_show (the person sees it later
   too, if the tab is closed now)
3. The portal's live event stream delivers it; the tab goes there and shows
   the note in a banner
```

**Rules that keep the person in charge:**
- Never jump while the person is typing or has unsaved edits. Show a banner
  instead: "The agent wants to show cms.ts:1921. [Go] [Dismiss]".
- The side pane does not open by itself unless the person allows it (a
  setting). Otherwise the Workspace tab button gets a dot.
- The person can turn both directions off with one switch in the tab:
  "Share my view with the agent".

## 3. What is reused

| Need | Already there |
|---|---|
| Owner-only access | access class `session:files` |
| A note at the next turn | `workspaceFileChangesNote` (files the person edited) |
| Latest-wins storage | the canvas key-value store pattern |
| Events to the portal | the live event stream the canvas uses |
| Git data for commits and diffs | the Workspace tab's git calls (`workspace-git.ts`) |

New: one file-call op (`view`), one event type (`session.workspace_show`), two
agent tools (`workspace_view`, `workspace_show`), and the tab code that sends
the record and follows the event. No new Web API operation: `view` rides in
`sessionWorkspaceFiles`, as `git` does. The two agent tools need the usual two
places: a declaration and a handler.

## 4. Build order

| Step | What | Size |
|---|---|---|
| 1 | The tab sends the view; the portal stores it; `workspace_view` reads it | S–M |
| 2 | The turn note when the view changed | S |
| 3 | `workspace_show`: event, tab navigation, banner, no-jump rules | M |
| 4 | The "share my view" switch and the auto-open setting | S |
| 5 | Tests: a browser test per direction; a worker test for the note | M |

Steps 1–2 alone already make "fix the selected lines" work.

## 5. Decisions for you

1. **Sharing by default:** on (the tab is the person's own workspace) or off
   until the person turns it on? Recommendation: on, with the switch visible
   in the tab.
2. **Selected text in the turn note**, or only the place (file and lines),
   with the text available through `workspace_view`? Recommendation: the
   place only; it keeps every prompt small.
3. **May `workspace_show` open the side pane by itself?** Recommendation: no;
   a dot on the Workspace tab button, and a setting to allow it.
