# Durable workflows

A **Workflow** is a durable program that a session hands work to. It runs a state
machine on PilotSwarm workers, without model turns, and it survives worker
restarts. Use one for a finite procedure with clear steps: scripts, waits,
typed messages, requests for an answer, agent steps and fan-out.

- **Definitions.** A session writes a **Workflow Definition** as YAML
  (`apiVersion: pilotswarm.dev/v1`, `kind: Workflow`) and saves it with
  its `workflow_definition` tool. Each save is a new revision that never
  changes. A person can also edit and save the YAML in the Workflow tab.
- **Workflows.** **Start** makes a Workflow from one revision. The Workflow
  runs that revision, whatever is saved later. A session can start many
  Workflows of one definition. When one ends, the session gets a message, unless
  the start turned that off.
- **States.** A definition names its **states**, the **initial** state, and
  the route that each **outcome** takes to the next state. Every run ends at
  a **terminal** state.

| Type | What it does |
|---|---|
| `script` | Runs a Node ES module on the worker. It calls the session's permitted tools and reports an outcome. It can run more than once, so make it safe to repeat. |
| `agent` | Runs an agent session for one task. Only the agent session's `complete_workflow_node` call, with a result that matches the state's schema, ends the step. |
| `wait` | A durable timer: a number of seconds, or the next clock time (`at`). |
| `messaging` | `send` a typed message, `receive` one (optionally with a time limit), or `request` a typed answer from a session before a deadline. |
| `parallel` | Runs a body for each item of a list, or named branches, and joins the results. |
| `terminal` | Ends the run: `succeeded`, `blocked`, `failed` or `cancelled`, with an optional output. |

- **On demand per session.** A session that has never used a Workflow carries one
  small tool, `enable_workflows`, instead of the Workflow tools. The model
  calls it when the person asks for a Workflow; when a Workflow would suit
  the task (a repeated check that a script could do), it suggests one and
  calls it only if the person agrees. Once they are on, it uses Workflows
  wherever they fit, without asking. See [Workflows on demand per session](#workflows-on-demand-per-session).
- **Scripts** run as guarded child processes on the worker. An operator can
  turn them off. See [Scripts](#scripts).
- **Tests.** When the person asks, a session tests a revision with
  `workflow_definition test`. Prepared answers (fixtures) stand in for tool
  calls, agent steps, sends and requests, and waits pass at once. Scripts run
  for real. See [A definition belongs to the session](#a-definition-belongs-to-the-session-stage-21).
- **Packages** can ship Workflow Definitions with an interface card. See
  [A package's Workflow Definitions](#a-packages-workflow-definitions-stage-23).

Models learn the details from the Workflow skills in
`packages/sdk/plugins/workflow/skills/`: `workflow-authoring`,
`workflow-reference` (every field, and what the engine guarantees on retries,
restarts, timers, joins and stops), `workflow-tools` and `workflow-patterns`.

How Workflows compare with GitHub Actions, GitHub Agentic Workflows and
Copilot dynamic workflows: [Workflows and GitHub Copilot](./workflows-and-github-copilot.md).

## Sessions own their Workflows (stage 1)

A session (a session) owns its **Workflow Definitions** and its **Workflows**.
A Workflow is one execution of one revision of a definition; underneath, it is
still the workflow child session described here, and the engine is unchanged.
The screens use one word per idea: **Session**, **Workflow Definition**,
**Revision**, **Workflow**, **Node**, **Agent node**, **Item**, **Time limit**
and **Start**. A Workflow that was canceled reads **Canceled**; the stored
value stays `cancelled`. Every Workflow screen takes its words from one module
(`ui/core/src/workflow-words.js`): a state is one word (a Workflow is Running,
Waiting, Pausing, Paused, Canceling, Completed, Failed, Canceled or Stopped; a
node's run is Running, Waiting, Sending, Paused, Done, Failed, Canceled or Not
reached), with its detail in the tooltip; a node's execution is a **run**;
counts are numbers; durations read `820 ms`, `4 s`, `2 min 45 s`, `1 h 3 min`;
times are local, the clock alone on the same day, the zone only in a tooltip.
A stop that lets started nodes finish reads **Stopped**; **Cancel now** reads
**Canceled**.

- **Session list.** A Workflow is a row under its session, like a sub-agent
  (same listing, collapse and order), titled by its definition and number
  (`check-items #3`) with its state. A definition that never started has no
  row. An agent node's agent session is a row under its Workflow (`summarize · agent`)
  and is read-only: its note gives the server's reason, then `To change this,
  message <the session>.` (with no reason: `Read-only. To change this, message
  <the session>.`). The portal and the terminal show the same words.
- **Selecting a Workflow row keeps the session.** The session's chat stays in
  the middle, and the right block switches to its **Workflow** tab on that
  Workflow. Selecting an agent node's agent session shows that session and its Workflow
  with the node selected. A link to a Workflow opens the same way.
- **The Workflow tab** sits beside the Canvas in the right block (the
  **Workflow** button in the toolbar, between Canvas and Diagnostics; one of
  the two shows at a time). The Workflow panel opens by itself once per
  session, as a canvas's first draw does (desktop column and phone pane;
  full screen and zen stay): when the session has a definition or a Workflow
  and its panel was never on screen (its receipt, `lastViewedWorkflowAt`,
  merged across devices), at once in the session (its first definition) or
  when the person arrives at it (a switch or a page load). It decides only
  after the profile and a successful read of the session's definitions, and
  compares no times. Once the panel was on screen, it never opens by
  itself again for that session. While the panel is not on
  screen, the button's yellow dot says a
  lifecycle change happened since it last showed: a definition created, a
  revision saved, a definition deleted, a test started or finished, a
  Workflow started, paused, resumed, canceling, canceled, completed, failed
  or waiting for input (never a node visit or a variable change); opening
  the panel clears it. The portal reads the active session's definitions in the
  background for this while the panel is closed and the page is visible:
  on arrival, when the session's or its Workflows' statuses change, and at
  least every 30 s. The terminal has no Workflow panel or
  button, so it has neither. It toggles between **Definition** (the
  graph or the YAML of the newest revision, **Compare** for older ones,
  **Start…**) and **Workflows** (each Workflow's number, state, revision,
  start time and duration; select one to see its graph with **Node**,
  **Log** and **Variables** in a bottom panel). A failed Workflow shows its
  failure first. **Stop…** opens one dialog: **Let running nodes finish**
  (it ends as Stopped) or **Cancel now** (it ends as Canceled); its close
  button says **Keep running**.
  The tab has the canvas's **Zen** and **Full screen** buttons at the right
  end of its header, with the same behaviour: zen makes the session a rail beside
  the tab; full screen covers chat and sessions and moves the tab switch, Zen
  and Restore into the toolbar; Escape steps down one level. The canvas and
  the Workflow tab share the mode, so switching between them keeps it, and so
  does choosing another definition, Workflow or view in the tab; only the
  person's own exit control or Escape leaves it. On a
  phone the tab has the canvas's maximize toggle. A Workflow shown in the
  middle (its session is not loaded) has neither.
  In zen and full screen on a desktop, the panel (**Node**, **Log**,
  **Variables**; **Node**, **Revisions**) is a column to the right of the
  graph instead of under it, from below the header bars to the bottom, with
  the same tabs and open state; the timeline and the zoom controls stay
  with the graph, which keeps at least 360 px. Its left edge resizes it (drag,
  arrow keys, double-click for the default 400 px; at least 280 px); the width
  is kept in the profile (`workflowPanelWidths`). Closed, it is a slim strip of
  its tabs at the right edge. Normal mode and a phone (its maximize too) keep
  the bottom panel; the terminal has no zen or full screen.
- **Start another… (Run again).** A definition that has started offers
  **Start another…** in its Definition view and its Workflows list. Its form
  is filled with the inputs of the Workflow it repeats (the definition's
  newest), never with sample values; when the read cannot give them, it says
  so and sends none, so the session uses the same ones (**Give other inputs**
  opens the fields, empty). A schema the form cannot draw as fields gets a
  JSON box. The form sends the session's chat one message: start another
  Workflow from this definition with the same YAML, unchanged (no key or a new
  one; never renamed). The session spawns it, and it is listed under the same
  definition as the next number. The base guidance and the authoring skill
  tell an agent the same when a person asks in words.
- **Nodes** show their type by icon, the start node, end rings, unreached
  nodes dimmed, For each counts with nouns (`2 ok · 1 failed`), failures in
  red, a state mark with one key fact (`✓ generated`, `● 30 s · until
  08:31:05`), and `↻ 3` where a node repeated (its tooltip: `3 runs`). An
  agent node's card shows its state mark alone (its outcome is on its edge
  and in its tooltip), except for a failure's short reason.
- **The Node panel** says what the node does in one sentence; **Now**
  (`Running · since 17:43:01 · limit 17:44:34`, `Done · produced · 17:42:05`);
  **Runs** (`3 · last 4 s at 17:42:01`); its **Result** as readable text; for
  an agent node its **Agent session** (`Same each visit`, `New each visit`),
  its **Prompt** (folded) and **Open agent session**; and **Next**, one line per outcome
  naming the next node, error routes with the edges' mark (`✕ time limit →
  retry`), then what happens when it fails (`✕ error → Workflow stops`). It
  has no tabs of its own; the Log has the runs. The read model gives each graph
  state its `about` (description, inline prompt) and each visit its
  `enteredAt` and `endedAt` for this.
- **Agent sessions: `session: continue | new`** (owner 2026-11-09). `continue`
  (the default) keeps one agent session per run and state (its id derived
  from the run and the state): each later visit's prompt arrives in that
  session as cycle N, with the input, the variables now, which changed and the
  previous result. `new` gives each visit of an agent node a new agent
  session; inside a For each or a parallel branch it is the default and the
  only choice (`session: continue` is refused there). The compiler writes the
  default into the IR (an agent state outside a parallel state's body that does
  not set `session` compiles to `session: "continue"`; absent is `new`). A Start, Run again or test compiles
  the revision's YAML again, so a revision saved without the key before the
  default changed starts with `continue`, and the Definition view's graph is
  compiled the same way, so its **Agent session** line says what a Start
  does. Session lifecycle: every completion of a continued agent
  session must name its visit (`node_execution_id`); a missing or foreign id
  is refused. A decided visit stops the session's running turn, not the
  session; the session ends when the run ends, and a graceful stop ends an
  idle one at once. If the session ended on its own, the next open visit
  starts a new agent session and says so. `workflow_agent_invocations` has one
  row per visit (`child_session_id` is not unique).
  Each turn of a continued agent session works for one visit, its turn visit:
  the open visit its prompt names, or, for a turn a timer or a sub-agent's
  update starts, the visit of the session's newest visit prompt. A turn whose
  visit is already decided does not run (no model call). A decided visit's
  Stop (request id `workflow-cycle-stop:<visit>`) is applied only to a turn of
  that visit; a person's Stop applies as always. The step reminder and the
  completion name only the turn's own visit. When the run ends before the
  agent session exists, but a spawn attempt began, the session's end stays
  owed; the next check that finds the session (the spawn's own, the run's
  cleanup, recovery) ends it.
  **Known limits:** after a visit times out, the next visit's prompt can wait
  behind the old turn until its abort lands, and the next visit's time limit
  runs during that wait. Results stay correct: each binds to its own visit.
  An update from a sub-agent or a timer that arrives between visits is
  recorded in the agent session but is not given to the model; the next
  visit's prompt carries the current state.
- **Long-lived agents and multi-day waits (FB-018, steps 1 and 1b).**
  Keep `session: continue`, complete each short visit with a declared sleep
  outcome, and route through a wait back to the agent. The reference example
  is `packages/sdk/plugins/workflow/skills/workflow-long-agent/SKILL.md`.
  Only wait-state `seconds` expands to 2,592,000 (30 days), for literals and
  bindings. Agent, request, receive and parallel deadlines remain capped at
  86,400 seconds. The IR shape, controller version and database schema do not
  change. A literal wait longer than `limits.timeoutSeconds` warns
  `WORKFLOW_WAIT_EXCEEDS_RUN_TIMEOUT`; an agent's `timed_out` self-loop warns
  `WORKFLOW_AGENT_TIMEOUT_LOOP`. Both remain valid definitions.
  The production session host supplies the optional
  `TurnOptions.controlToolBridge.workflowScheduleDeadline()` only for direct
  agent children. It reads the invocation captured for that turn, not the
  session's latest invocation. Managed-session tools compare the next wake
  with that deadline before queuing `wait`, `wait_on_worker`, `cron` or
  `cron_at`; a wake at or after it is refused with sleep-outcome guidance.
  Cancellation never needs that lookup. An allowed first fire does not
  extend the visit; its usual timeout remains authoritative. Ordinary
  sessions and descendants keep their current scheduling behavior.
  Pausing does not freeze an admitted wait or run deadline. Continued
  sessions clear inherited cron schedules at visit boundaries (FB-026);
  an already pending one-shot wait can still wake once. Multi-day agent
  visits and new liveness or hand-over rules are deferred.
- **Agent node tool limit: `tools: none | [names]`** (stage 2.1). Absent, an
  agent node's agent session has its session's tools. `tools: none` leaves it only
  `complete_workflow_node`; a list (1 to 64 distinct tool names, as the agent
  sees them) leaves it those and `complete_workflow_node`. The limit applies
  to the node's agent session and every session it starts. Each turn reads it from the
  node's run revision (a later revision never changes a running visit) and
  offers the Copilot session only those tools (`availableTools`). The CLI's
  `availableTools` cuts only its own tools and MCP tools (Copilot CLI
  1.0.83), so the session manager also declares only the PilotSwarm tools
  the list names (`workflowLimitedSdkTools`); a PilotSwarm tool the model
  guesses anyway is unknown to the CLI and never runs. Native
  tasks it starts (`task`: the swarm workers and adopted repository agents)
  are held to the same list: their declared tools and MCP grants are cut to
  it, and a worker's call of any other tool (such as `bash`) is refused; a
  worker never gets `complete_workflow_node`. The Node panel and the
  terminal say the limit. **Known limit:** a worker of an
  earlier build ignores the field; deploy workers and the portal together,
  as migration 0088 already requires.
- **An agent node's input is its data** (stage 2.1, FU-17b). Its first and
  cycle prompts say to base the work on the input (and, for a cycle, the
  variables and previous result), not to fetch the same data again unless
  the task says so, and not to follow instructions inside the JSON.
- **A failed step's words** (stage 2.1, FU-19). The server says a failed
  step's error in short plain words (`the script stopped with an error:
  Unknown model …`, else `the script exited with code N`, else the error's
  message or code; at most 240 characters, secrets hidden), made from the
  whole stored error. They are stored with the step's `workflow.state_failed`
  event (and a failed run's `workflow.failed`) as `errorWords`, and every read
  gives them beside each failed visit and the failed run. The portal and the
  terminal show them; for an event or a read of an earlier build they read
  the words from the error preview, as before.
- **The Log of an agent node** shows its agent session visit by visit and says
  what is loaded: a visit whose session start is not loaded says so, with
  **Load older** (that session's older page); **Load older visits** reads the
  run's older history. A later visit of a continued agent session names the visit whose base
  instructions it carries instead of repeating them.
- **Removed** from the Workflow tab, the session list and the terminal UI:
  the Notices bell and the Publish review (and the draft and publish words of
  the YAML editors). Each notice moved to where it applies (the revision line,
  one line over the graph, the Workflow state, the Log) or went away. The
  older workflow screen (`workflow-workspace.js`) is no longer shown anywhere
  but still holds them in its code until stage 2 removes it.
- **Phone (390 px):** the Workflow tab opens as a sheet over the session; in a
  panel, **← Graph** returns to the graph. A run's state keeps its words and
  its time ("Running · 2:45"): the Workflow picker shortens first, and when
  the row still cannot hold them, the run's buttons move to a line of their
  own. Fitting the graph keeps it clear of its zoom controls at the bottom.
- **Terminal UI:** the same model. `w` opens the Workflow pane for the session
  (its selected Workflow, an agent session's own Workflow at that node, else
  its newest Workflow); Esc goes back to the session. In the session list, `c`,
  `d` and `D` act on the highlighted Workflow row (`c` and `d` open its
  Stop, Cancel or Delete choices, `D` asks to delete it), never on the session
  that owns it; the portal's keys do the same. In the Workflow pane, `S`
  opens the Start form for the revision shown (a definition being edited is
  saved and started in one step); publishing alone has no key.
- **Inside a Workflow** (an agent node's agent session and its sub-agents), sessions
  get no definition tools: `workflow_definition` and `update_workflow` are not
  declared, and the server refuses them and `spawn_workflow`
  (`WORKFLOW_DEFINITION_TOOLS_REFUSED`).
  No other registry gives them either: such a session is offered no MCP
  server's `spawn_workflow` or `update_workflow` (for example the PilotSwarm
  MCP server's person-mode `update_workflow`), and a call of one is refused.
  A person's workflow command (management client, Web API
  `originatingSessionId`, MCP `originating_session_id` or an MCP server
  started with `PILOTSWARM_ORIGINATING_SESSION_ID`) that names the session it
  comes from is refused a definition operation (`replace_definition`,
  `publish`, `publish_and_start`, `start`) when that session is inside a
  Workflow (403 `WORKFLOW_DEFINITION_TOOLS_REFUSED`). Known limit: a caller
  that holds a person's credential and names no session acts as that person;
  the server cannot tell. A parent asked by its child to change a definition
  must decide on its own.
  Any other session may hand prescriptive work to a Workflow; the base
  guidance says so. Sessions inside a Workflow stop at level 3 below the
  top-level session, and each refusal says so in words.
- **Test mode is hidden** (see [Test mode (hidden)](#test-mode-hidden)).

## A definition belongs to the session (stage 2.1)

A session owns named **Workflow Definitions**; each save is a new, immutable
**revision** (1, 2, 3) that records who saved it (`by the session`, `by <person>`)
and the revision it was based on. A Workflow runs the revision it
started with; a later save never changes it. The session changes and starts its
definitions with its `workflow_definition` tool. `spawn_workflow` is no
longer declared to a model; its handler stays one release for a stale call,
mapped to save then start (a repeat with the same `key` and YAML is answered
as before, and a corrected YAML under the same `key` saves the next revision
and starts it).
A Workflow that is a copy of a session revision (each Workflow a Start makes) takes none of the stage 1 definition operations
(`replace_definition`, `publish`, `publish_and_start`, `start`), from the session
or a person: they answer `PINNED_TO_SESSION_REVISION` (409) and change nothing. Change
the definition with `workflow_definition save` (or YAML and Save in the
Workflow tab), then Start that revision. An exact repeat of `spawn_workflow`
(the same key and YAML) is answered from its save's receipt; after a crash
between its save and its start, the repeat starts the revision that save made.

Start keeps `spawn_agent`'s limits (stage 2.4): a Workflow is one level deeper
than its session, so a session at the deepest level (2) starts none
(`WORKFLOW_NESTING_LIMIT`). The session's level is read from its stored lineage
for every Start, a person's included. A session's sub-agents (pending or
running) and its active Workflows (a live run admitted, running or paused, or
a Start claimed and not admitted yet) share one budget of 50 (`CHILD_LIMIT`,
429). `spawn_agent` and Start count it with the same rule, under an exclusive
lock on the session, in the transaction that makes the child, so two at the same
moment cannot both take the 50th place. Workflows are always on, so this
budget always applies. System children are not counted, and a system child is
created without the atomic budget; a calling system agent is not exempt: its
`spawn_agent` is still refused once its counted children reach 50.

**Models of agent nodes (OF-S2-7).** A definition never names a model,
reasoning effort or context tier (a `model` key stays `WORKFLOW_FIELD_UNKNOWN`),
so a definition is portable across deployments. Each agent node of a Workflow
uses the model, reasoning effort and context tier of the session that owns it,
read at each spawn. Every start may instead map agent nodes to a model:
`agent_models` on `workflow_definition start` (and a stale `spawn_workflow`), on
`update_workflow` `start` and `publish_and_start` (an agent's tool and a
person's command), `agentModels` on `startSessionWorkflowDefinition` and the
management start API, and on a real-agent test:
`{ <node id>: { model: "provider:model", reasoningEffort?, contextTier? } }`.
The key is the node's state id (its key under `states:`, unique across the
Workflow; a node in a For each body is one key for all its items). The map is
checked at start against exactly the revision started and the owning session's
catalog: the catalog of the owner of the session that owns the Workflow, the
identity its agent nodes spend as, whoever starts it (a person, or an
administrator starting another owner's Workflow). A key that is not a node of
that revision, a node that is not an agent node, a setting that is not one
text value (`AGENT_MODELS_INVALID`, 400), or a model that catalog does not
serve, or an effort or tier the model does not list (a model that lists none
takes none) (`AGENT_MODEL_UNAVAILABLE`, 422) refuses the start in words. A
host that cannot check models refuses any map. It is stored with the run
(`workflow_runs.agent_models`) and shown by `read_workflow`
as `run.agentModels`; **Run again** reuses it, unless the start gives its
own (an empty map clears it). When a chosen model cannot be used any more at
spawn, that node fails in words; it never falls back to another model. A
stored map that cannot be read fails the node in words too, never taking the
session's model. Each visit's spawn records what its agent session runs on
(`workflow.agent_spawned` `model`: model, effort, tier, chosen at start or
from the session). The Node panel and the node's tooltip show it
(`Model: … · chosen at start` or `· from the session`); before a visit has run,
an inherited model reads `from the session · now …`, the session's current one.
The agent's Log shows the model each visit's agent session used (`Model now: …` when
only the session's current one is known), the TUI's node details have a
`Model:` line, the start receipt names the chosen models, and a person's
Start dialog lists what each agent node will use (a person does not choose
models there; Run again reuses its Workflow's). A session leaves the map out unless the person asks for a model or the
package card's `modelHints` ask for a kind of model for that node.

A Start is receipt-first: the same operation again answers the Workflow it
made, with the revision it pinned then, even after a later save; naming
another revision under the same operation is refused (`OPERATION_CONFLICT`).

A Workflow session has no turn, so it offers no Stop: its run has its own Stop
and Cancel.

**Clock waits** (stage 2.4). A wait state may
give `at` instead of `seconds`, with the `cron_at` fields:

```yaml
morning:
  type: wait
  at: { minute: 0, hour: 9, tz: America/Los_Angeles }   # add day_of_week (0-6, Sunday 0) or day_of_month (1-31)
  transition: { next: { elapsed: check } }
```

It waits until the next such time in its zone, daylight saving included
(`minute` alone: every hour). The deadline is decided once, when the state is
entered, from the store's clock (a test run's virtual clock); the graph says
`Wait · until 09:00` and the Node panel `Waits until the next 09:00
(America/Los_Angeles).`

**Tool call windows** (FU-25, stage 2.4). Each tool call a script makes on
the Workflow's shared tool session is on the Workflow's Log:
`workflow.tool_call_started` when its turn on the session begins (after any
wait for another step's call), and `workflow.tool_call_ended` when it settles,
with its `startedAt`, `endedAt`, `durationMs`, `ok` and, for a failure, its
error in short words. A test run's calls are answered by fixtures and are not
recorded this way.

**The Workflow tab on a session's definitions** (the portal, when the server
lists them; a connection without them keeps the stage 1 grouping above):

- The header's picker has one option per definition, by name. A deleted
  definition that still has Workflows is listed as `name · deleted`.
- The **Definition** view picks a revision (`Revision 6 · newest · by the
  session · 09:41 · not valid · version 1.2.0`). A valid revision draws its
  graph; one with errors says why on one line and lists them.
- **Start…** starts the revision shown, as Workflow `#n`. A revision with
  errors cannot start, and the button says so (and which revision can).
- **YAML** edits the newest revision for the session's owner or an admin, when
  the deployment takes a person's workflow commands. **Save** makes the next
  revision and names the revision it edited. If another revision was saved
  first, the save is refused: `Revision 6 was saved by the session at 09:41.
  Reload to edit it. Nothing was saved.` (the time in your own clock).
  **Reload** shows the newest (the unsaved edit is replaced). A revision saved
  from another page is noticed when this page is shown again or takes focus:
  the editor then says a newer revision was saved, before you save. The saved
  revision's errors are marked in the
  editor; a revision with errors is saved with them. The session reads a note
  about a person's save on its next turn; the save does not wake it. An
  unsaved edit stays when you show another revision or view.
- **Compare** shows any two revisions side by side.
- **Delete…** asks first. It is refused while one of the definition's
  Workflows runs, in the server's words. Its revisions stay, so a finished
  Workflow keeps its copy.
- The **Workflows** view lists each Workflow with the revision it runs. A
  Workflow's own view says its revision and offers **Run again…**: a new
  Workflow from the same revision, filled with that Workflow's inputs when
  they can be read.
- A person who can read the session but not change it sees the graph, but no
  YAML, and the input schema and errors without what their author wrote; Start,
  Delete and Run again are off and say why.
- **Timeline** (the replay of stage 2.4, FU-26, as a viewing mode). Every
  Workflow, running or ended, has a timeline under its graph: **Step back**,
  **Play**/**Pause**, **Step on**, a slider over its visits (arrow keys, Page
  Up and Page Down by ten, Home, End) and **Live**, which reads **Latest**
  once the run has ended. With no visit yet its controls are off and it says
  "No steps yet". The slider's scale is time: each visit sits at the moment
  it began, between the run's start (its session's creation) and the newest
  visit (UXP-TL-04). A visit therefore keeps its place while older visits
  load and new ones arrive; only the scale's growth at the right end moves it
  a little to the left. The words beside the slider have a width of their
  own, so the slider's length does not change with them.
  - **Live** is the default. The slider's right end is the newest visit; the
    graph shows the Workflow as it is now and follows new visits. Live never
    changes the step a person selected.
  - **History.** **Step back** from Live shows the visit before the newest;
    **Step back** and **Step on** move one visit, and the slider any. **Step
    on** from the visit before the newest, the slider at its right end, End, or
    **Live** returns to Live. At a visit the graph shows each step as it stood
    when that visit began (a visit that ended later is shown running, one that
    began later is not reached, and a send's delivery and the recipient's check
    show only from when they happened), and the Node panel follows that visit:
    for a visit in a branch it shows that branch and its agent session. The run
    keeps running meanwhile: the timeline is kept by visit, so new visits
    lengthen the slider while the visit shown stays, and history never returns
    to Live by itself.
  - **Play** shows each next visit in turn (about 0.8 s each) and returns to
    Live (or Latest) at the right end. In Live it is off: "Play — step back
    first; live view already moves".
  - **Lit transitions.** The last four transitions up to the visit shown (in
    Live, the newest four) are lit on the graph in the theme's lit colour,
    counted across branches in the order the visits began: an edge or a
    step's ring is thicker when it was taken twice or more among the four,
    and fainter the longer ago it was last taken (100%, 75%, 50%, 35%). The
    current step (the visit shown, or Live's newest) is filled with the lit
    colour, has a thicker ring and glows; the selection keeps its own ring. A
    visit entered by a catch-all route, and the run's first visit, light their
    step only; a parallel step drawn as a box leaves from its join bar, and
    the lines into a join bar are never lit. The Node panel and the Log say
    the same in words. While the run is active (running, paused or
    stopping), in Live and in history, a soft light travels each lit edge
    from its source to its target, one pass every 1.6 s whatever the edge's
    length, as bright as its edge's age; the passes ripple from the oldest lit
    edge to the newest. An ended run's edges are still, and so is every edge
    when the system asks for reduced motion. Nothing else moves.
  - The Log marks the visit shown's `Node … started` line; a click on such a
    line shows that visit. The Log lists 200 lines: the newest, or, for a
    visit older than those, the lines around it ("Around the visit shown").
    When that visit's line is older than the Workflow's loaded events, the Log
    reads older events, page by page, until it is there (the portal keeps at
    most about 3,000 events of a session); otherwise it says "This visit's
    line is not among the Log lines loaded".
  - The timeline reads the stored visits only; **Load older visits** reads a
    long run's older ones (a running run's too). It keeps every visit of the
    run it has seen, so a visit shown never leaves it while the loaded pages
    and events move on with a long run; **Step back** from the oldest visit
    seen loads the older ones first, then shows the one before.
  - On a phone the timeline is one row of 44 px targets ("Older" for **Load
    older visits**). The terminal UI draws no graph, so it has no timeline and
    no lit transitions; its run views are unchanged.

**An agent's test of a revision, on request (stage 2.2).** Testing is
optional: the session tests a revision only when the person asks (for example
"test it before you start it"); it never tests on its own, and Start never
needs a test. People do not run tests themselves.

- `workflow_definition` `test` (name or `definition_id`, `revision`, default
  the newest valid one, `inputs`, `vars`, `fixtures`) runs that revision to
  its end on a hidden test bench and returns a report: the path taken, each
  step's outcome and output, the first error in words, a call it had no
  answer for, the calls answered, the virtual time its waits took and the
  time used. Passed means the run completed with outcome `succeeded`.
- `fixtures` are prepared answers for a script's tool calls, agent steps,
  sends and requests (`{ operation?, tool? | state?, arguments?, response }`);
  a fixture without `arguments` answers any call of its tool or step, after
  every exact one. A `response`'s success `value` has the shape of its kind:
  a tool call's result; an agent step's `{ outcome, output }`; a request
  step's `{ response }` or `{ decline: { reason } }`; a send step's any value.
  An error is `{ kind: error, value: { code, message } }`. A call with no
  prepared answer fails the test (`TEST_UNANSWERED`), which names it and the
  shape its answer needs; a prepared answer of the wrong shape fails it at
  once (`TEST_ANSWER_REFUSED`), with the refusal and the shape. Either way the
  test's run is canceled, and the report's first error is that step's.
- Scripts run for real (files, network); the report says so. Waits pass at
  once: whenever every open step only waits for its timer, the test's
  virtual clock moves to the next deadline.
- The test bench is a workflow child of the session marked as a service session
  (`service_kind` `workflow-test`). It is never a Workflow of the definition,
  never a session list row (the management client, the client, the agents'
  `list_sessions` and the portal leave it out), and it never tells the session
  anything: the report is the answer. A call waits up to 4 minutes (a turn
  with no event for 5 minutes is treated as lost), then answers with the
  test's id; `test` with `test_id` reads it again. A definition keeps at most
  its newest 5 ended tests: older ended ones are deleted when a test starts
  and again when one ends; a running test is never deleted. An ended test is
  kept until that test-retention limit or explicit/ancestor deletion. The
  Sweeper does not independently remove test benches
  (see [Stopping a workflow](#stopping-a-workflow)).
- A test lives only as long as its session and its definition. A test is made
  only while its session is live and its definition is not deleted (checked
  under their locks). When the owner session ends (completed, canceled, failed) or is
  deleted, or the definition is deleted, its running tests end canceled and
  their scripts stop (within the controller's 30-second check, as a live
  run's do); their reports stay.
- The Definition view says `Last test · passed 17:42` (or `failed`, or
  `Test running`) beside the revision picker, only for a revision that was
  tested (`revisions[].lastTest` of `listSessionWorkflowDefinitions`).
- Every deployment runs tests. Every turn declares `test` (with `fixtures`
  and `test_id`) and its guidance teaches testing, a turn of a
  previous-release session still on 1.0.82 included: every turn's host runs
  Workflow tests.
  A revision with errors, one this version no longer compiles, or one with a
  script node where scripts are off, is refused (`Nothing was tested.`).

**Model SDK echo (stage 2.2, FU-21).** The 1.0.83 SDK records the system
prompt it composed as a `system.message` with the model's role `system` and
an interaction id, 55,151 characters each turn in one live dump, whatever its
first words. The runtime recognizes it by that shape (or by its known first
words) and stores only its summary in every transcript: fixed words and its
length, none of its text, because anyone who can read the session reads its
transcript. A workflow agent node's agent session still keeps the whole text, with its
secrets hidden, as an artifact of its Workflow that only the Workflow's owner
reads.

The Web API reads are `listSessionWorkflowDefinitions` and
`readSessionWorkflowDefinition` (a revision's YAML, diagnostics and graph, and
whether the caller may change it); a person's changes are
`saveSessionWorkflowDefinition`, `startSessionWorkflowDefinition` and
`deleteSessionWorkflowDefinition` (see the [API reference](../../api/reference.md)).

**Known limits:** the terminal UI still groups a session's Workflows by name, as
in stage 1, and has no revision picker, save or Compare; the MCP server has no
definition tools. A person starts a Workflow of a session's definition with no
tool binding of the session's, so its scripts' `callTool` finds no permitted
tool.

The rest of this page describes the workflow child underneath, its graph and
the workflow screen a Master of Agents panel still shows.

A workflow session is a sibling of an agent session: it has a row in the
session list (a connected-steps icon in the portal, `◇` in the terminal), an owner,
sharing, and a transcript. In the portal, the session details under the list
show a workflow's own rows instead of a session's model, context, cron and agent:
**Workflow** (name and version), **Revision** (number, draft or published),
**Run** (the live run's status and outcome, or "No run yet"), **Started by**
(the parent agent's session, a link, or "You") and **Steps**; a value the
workflow screen has not read yet shows "—". Folded, the details line shows
the run. An agent session that runs a workflow step shows **Step of** (the
workflow, a link) instead of its cron.

- The **live view** occupies the main pane instead of a session conversation.
  The graph uses the immutable workflow definition and live execution state.
  It reads top to bottom: each step sits below the step that leads to it,
  sibling branches sit side by side, and the edge that closes a loop curves
  back up beside the loop's steps. Edges are curves that never pass through
  an unrelated step. The graph is fitted to its area once, the first time it
  is shown. After that, when the area changes size (a pane opens, closes or is
  resized), the zoom stays and the graph's top-left stays in place; only **Fit
  to screen** fits it again. Its zoom and position are kept for this workflow,
  so switching tabs, panels or sessions and back shows it exactly as you left
  it. Use **Zoom in**, **Zoom out** and **Fit to screen** at its bottom left. With **Move the
  graph** (the hand, on by default) drag the background to move the graph,
  and pinch or scroll to zoom. Turn the hand off to keep the graph still while
  you scroll the page. A run's progress never moves the view; a new definition
  or revision is fitted once.
- Drag a step's box to move it, with the hand on or off; a click still
  selects the step, and a drag does not. The edges that touch a moved box
  follow it as smooth curves. Where you put the boxes is kept for you, per
  workflow, in your portal profile, and saved when you drop a box; it is kept
  through new revisions (a new step takes its automatic place). **Reset
  layout**, beside the graph's controls once a box has moved, puts every box
  back. **Fit to screen** fits the boxes where they are.
  Select a node to inspect its outcome, tools, output and recent history in
  the right-hand side pane (**Step details**). Drag the divider between the
  workflow and that pane to resize it, use the divider's arrow keys, or
  double-click it to reset its width; the width is kept for this session. On a
  phone, the side pane opens as a separate layer; return to Main to see the
  graph again. A workflow shown in the middle has no zen and no full screen:
  its side pane offers neither, and a workflow opened there while either is on
  shows in the normal layout (the Workflow tab has both, as above). On a desktop, returning to a session brings them back as you left them;
  on a phone, opening a workflow leaves mobile zen. The worker's original canvas
  artifact remains available without changing running workflows.
- The main pane stays still: a compact header (the name, the status,
  **Graph | YAML**, the run picker and the icon tools) and, under it, the
  graph or the YAML, nothing else. The tab you choose is kept for this
  workflow. **YAML** edits a draft you may change at the tab's full height,
  with Save, Discard and its error marks; an unsaved edit is kept when you
  switch tabs or sessions. Any other revision (a published one, or a draft you
  may not change) shows read-only; its YAML is shown only to people who can
  change the workflow. So is an agent state's inline prompt: a person who can
  only read the session sees each state's `description` on the graph, never
  its prompt. A `description` is shown to everyone who can see the graph, so
  write it as you would a label.
- Every panel opens in the side pane, one at a time, with its title and a
  way back to Step details: the publish or start review, the test review, a
  test run's **calls** and clock, **variables**, the draft's tools (compare
  versions, change an agent step's inputs; from the YAML tab), the run's
  **activity**, its **notices** (and a status that could not be read), and
  the **step log**. Its icon button in the header looks pressed while the
  side pane shows it; press it again for Step details. Notices and Test calls
  show how many there are. The Inputs box of a start or test review starts
  with sample data built from the workflow's input schema (examples,
  defaults, enum values, or a value by type and field name) while it is empty
  and untouched; **Sample** beside it fills it again. Selecting a step shows
  Step details again. When a
  command you sent is refused or may not have arrived, the side pane says so
  above what it shows. Until the workflow writes to the step log, it says "No
  step output yet." Before the first run, the header's status says "No run
  yet" and the run picker appears once a run exists.
- The **transcript** starts with a compact, expandable definition. Repeated
  healthy self-loop checks update one progress row with an increasing count,
  the last outcome and check time. Expand it for the most recent 40 checks
  and latest output. Changes, errors and terminal results remain separate.
  Raw execution events are unchanged; partial history labels its count as
  loaded checks rather than claiming the whole run. The workflow screen has
  no message box: nobody types into a workflow.

## A package's Workflow Definitions (stage 2.3)

A package can ship Workflow Definitions as top-level entries
(`workflows/<name>/workflow.yaml` with its interface card `card.md`; see
`docs/building-agent-packages.md`):

- **The new-session picker** lists them under **Workflows**, after the agents,
  each with its package and version; the details show its card (what it does,
  when to use it, its inputs, how it ends, what it asks, what the definition
  shows of its effects, checked from it (its script and agent steps), and the
  card's effects, labeled as its author's words).
  Choosing one makes a session for it, on the model chosen in the model step (else
  your default; the card's suggestion is shown, never applied
  unasked). Its agent nodes use that session's model unless a start chooses one;
  the details show the card's model hints, if any. That session has the definition attached, its title is
  `<name> · <package>`, its instructions are the card and how to coordinate
  it, and its first message asks it to greet you and ask for the inputs it
  needs. The session list shows it with the Workflow badge. The definition
  attached is exactly the package version its instructions were written
  from: when another version became active meanwhile, or the package is gone,
  no session is made (`PACKAGE_VERSION_CHANGED`, `PACKAGE_WORKFLOW_NOT_FOUND`);
  choose it again.
- **In a session** a package's definition is named `<package>/<name>`. It is
  attached at the package's version and **locked**: the Definition view says
  `From <package> <version> · locked`, its YAML is read-only, and **Make a
  copy** saves its YAML as the session's own, editable definition at revision 1
  (the session reads a note about it); the copy says what it was copied from
  (`Copied from <package>/<name> revision N (<package> <version>)`). When the package publishes a newer
  version, the view offers it: **Use it for the next Workflow** attaches it as
  the next revision; Workflows already started keep theirs. Newer means the
  same package with a greater version: an older active version (a rollback)
  or another package of the same name (your own copy that shadows a shared
  one) is not offered, and taking it is refused (`PACKAGE_NOT_NEWER`).
- **The session's tool** (`workflow_definition`): a session may start any
  package definition its owner can see, as the new-session picker shows them
  (owner decision, 2026-11-11): a shared package's to everyone, a user's own
  package's only to that user; one its owner cannot see is refused
  (`PACKAGE_WORKFLOW_NOT_FOUND`). `list` shows them all under `canStart`, those
  its agent's `workflows:` names (and a coordinating session's own) first,
  marked `suggested`; a suggested one no visible package has is shown as not
  available. `card` reads one's card,
  and `start` with its `<package>/<name>` attaches it the first time (`update:
  true`: the newer version) and starts exactly that revision. A save of one is
  refused (`DEFINITION_LOCKED`).
- An agent step may not use an agent that names definitions
  (`AGENT_HAS_WORKFLOWS`, at save and at Start).

## Example

Where Workflows are on in a session, its instructions explain when to prefer a
finite workflow over repeated parent model turns, when an ordinary agent is
needed, and how to follow a run; the Workflow skills carry the details. The
guidance never expands tool permissions or approval scope.

Scripts read the previous state's result as `context.input` and initial
parameters as `context.inputs`. A bare `input` variable is not defined. Each
script is a Node ES module: use `await setResult(...)`, not a top-level
`return`. Preserve data needed by later steps in the output you pass forward.

```yaml
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: nightly-report, version: "1.0.0" }
description: Reads the facts that match a key pattern and stores a short report.
inputs:                        # checked when the Workflow starts
  schema:
    type: object
    additionalProperties: false
    required: [keyPattern]
    properties:
      keyPattern: { type: string, minLength: 1 }
initial: collect
states:
  collect:
    type: script
    timeoutSeconds: 120        # 1 to 3,600; default 300
    outcomes: [found, empty]
    source: |
      const facts = await callTool("read_facts", { key_pattern: context.inputs.keyPattern });
      await setResult(facts.count ? "found" : "empty", { count: facts.count });
    transition:
      next: { found: report, empty: nothing, failure: failed }
  report:
    type: script
    outcomes: [done]
    source: |
      await callTool("store_fact", { key: "reports/latest", value: context.input });
      await setResult("done", context.input);
    transition:
      next: { done: published, failure: failed }
  published:
    type: terminal
    outcome: succeeded
    summary: Report published.
    output: "${input}"
  nothing: { type: terminal, outcome: blocked, summary: No facts matched. }
  failed: { type: terminal, outcome: failed, output: "${runtime.error}" }
```

| Rule | Detail |
|---|---|
| Document | `apiVersion: pilotswarm.dev/v1`, `kind: Workflow`, `metadata.name` and `metadata.version` (a semantic version; quote it, as in `"1.0.0"`) are required. |
| States | 1 to 100 states. An id is a letter, then up to 63 letters, digits, `_` or `-`. `initial` is not a terminal, and every state the run can reach must be able to reach a terminal. |
| Routes | `transition.next` maps each outcome a state can report, and each runtime error you handle (by its code, or `failure` for all), to a state. A runtime error with no route goes to `catchAll` when there is one, else it fails the run. |
| Data | Each state's output is the next state's input. A binding is one whole string, such as `"${input.count}"` or `"${inputs.keyPattern}"`. |
| Inputs | `inputs.schema` is a JSON Schema 2020-12 document. A start whose inputs do not match is refused. |
| Size limits | YAML at most 256 KB. A state's output at most 256 KB of JSON: store larger data as a fact or artifact and pass its key. |
| Run limits | `limits.maxNodeExecutions` (default 1,000, at most 10,000) bounds the visits of a run, so a loop cannot run forever. `limits.timeoutSeconds` is an optional deadline of up to 30 days. |

The `workflow-reference` skill has every field of every state type. A type
the compiler does not know is refused with the types it takes and, when one
is near, the one most likely meant (`'code' is not a workflow state type. The
types are script, wait, messaging, agent, parallel, terminal. Did you mean
script?`; owner 2026-11-09, I2).

## What a script sees

A script is a Node ES module with top-level `await`. It gets its context as a
parsed object named `context`:

| Field | Value |
|---|---|
| `inputs` | The Workflow's inputs, as given at Start. |
| `input` | The value that arrived: the previous state's output, the error envelope `{ code, message, details? }` on an error route, or `initialInput` (default null) for the first state. |
| `kv` | The Workflow's variables, as they were when this state started. |
| `branch` | In a parallel branch: its `item` and `index`, or its `name` in a named branch. |
| `attempt` | 1 at first; above 1 when a worker failure ran the script again. |
| `node` (the state id), `step`, `nodeExecutionId`, `workflow`, `version`, `runId`, `sessionId` | Where the script runs. |

It calls a tool with `await callTool(name, args)` and reports its result with
`await setResult(outcome, output)`. The last `setResult` counts. Without one,
a final stdout line that is a JSON object with a string `outcome` counts;
otherwise exit code 0 is outcome `success` (output: stdout). In every case
the outcome must be one the state declares, and the output must be plain
JSON that matches its `outputSchema`; if not, the state fails
`invalid_output`. A non-zero exit without a result fails `execution_failed`,
and a script past its `timeoutSeconds` fails `timed_out`. Route those codes
in `next`, or `failure` for all, to handle them.

Workflows run Node only.

## Tools a script can call

Scripts call tools **as the workflow session**: facts are stored on that
session and are visible across its spawn tree, and inspect tools act as its
owner, exactly as for an agent session. The
set is captured from the actual parent's effective tool catalog, excluding
durable scheduling, delegation, lifecycle and capability-changing operations.
The worker creates a separate CLI execution handle; it does not borrow the
live parent handle or send a model prompt.

| Tools | Notes |
|---|---|
| Native Copilot tools | Actual shell, file, search and edit implementations through `session.rpc.tools.execute`, subject to normal permissions and workspace scope |
| Registered application and package tools | Only the captured parent-authorized binding; package access is not replaced with generic defaults |
| Fact tools, and graph tools when a graph store is configured | `store_fact`, `read_facts`, `facts_search`, ... |
| Session tools | `list_sessions` and `read_agent_events` (and the usage reads). These return JSON, not the text an agent sees. |
| MCP servers | Captured parent-authorized servers/tools through the CLI; `<server>/<tool>` aliases must resolve uniquely |

Not available: turn-control tools (`wait`, `cron`, `ask_user`, `spawn_agent`,
`spawn_workflow`, native `task`), lifecycle and capability-changing tools,
`context_health`, the Workflow tools (`workflow_definition`,
`respond_session_request`, `complete_workflow_node`), and session messaging
(`send_session_message`, `reply_session_message`, `message_agent`): a Workflow
messages sessions through its own send and request states, never as its
parent. The same controls under the names the PilotSwarm MCP server and the
management tools give them are left out too: a session's lifecycle,
conversation and turn (`abort_session`, `complete_session`, `send_answer`,
`stop_turn`, `regenerate_session`, ...), who may see or change a session or a
package, model providers and defaults, agent package publication, feature
flags, and system maintenance (`workflow/tool-policy.ts` lists them). Such a
tool is never captured in the grant, and a call of one is refused. Existing approved application tools retain their authority;
a generated confirmation flag is not human approval. Parent capability
removal or a changed source binding can stop later calls, but newly added
parent tools do not enlarge an admitted run.

MCP sampling is refused: an MCP tool cannot request an extra model turn.
Native shell `detach: true` is also refused. A Workflow draws no canvas of
its own (the Workflow tab shows it), so its scripts may use any canvas slot.
The captured workspace stays
fixed if the parent navigates to another folder. A terminal or deleted parent,
revoked capability, changed tool schema or changed package binding stops later
tool calls. A named parent's agent identity supplies the same authorization
context; the child session remains the source of execution events and facts.

Parent policies and tools that exist only as in-memory callbacks cannot be
delegated durably and are refused at admission. Use registered tool/policy
implementations. Native background shell handles belong to one script state;
they are stopped before that state's executor closes, not carried to another
state or worker.

A stdio MCP server is started with a small default environment (`PATH`,
`HOME`, ...) plus the `env` of its configuration, not the worker's full
environment; pass what a server needs through its configuration.

A failed tool call is raised in the script as a JavaScript `Error`, so the
script can catch it.

## Starting a workflow

- **From an agent:** `workflow_definition` `save` (the YAML) and `start`
  (`inputs`, `notify_on_completion?`) make the Workflow a **child** of the
  agent session; `start` returns at once. The agent receives the result as a
  message when the Workflow ends. A user can describe the steps in words; the
  agent writes the YAML. In a session where Workflows are off, the agent
  calls `enable_workflows` first, when the person asks for a Workflow or
  agrees to its suggestion of one (see [Workflows on demand](#workflows-on-demand-per-session)).
- **On a schedule:** ask an agent to repeat it ("every night at 2, run ...").
  With Workflows on, the agent makes one Workflow that loops through a wait
  state (a wait's `at` where clock waits run), and starts it once; it does not
  set `cron` or `cron_at` to start a Workflow on each wake-up (each start would
  be another Workflow). With them off, it suggests a Workflow first and turns
  them on only if the person agrees.
- **There is no top-level creation:** ask an agent to start the child. The
  Web API has no create route (stage 2.5 removed `POST /sessions/workflow`,
  which refused every call), and no generic tool set is substituted for a
  missing parent.
- **`spawn_workflow`:** kept one release and no longer declared to models; a
  stale call saves the YAML as the next revision of the session's definition
  and, with `state: published` and `start: true`, starts it, as
  `workflow_definition` does. Its YAML must say
  `apiVersion: pilotswarm.dev/v1`; any other document is refused with
  `WORKFLOW_API_VERSION`, and there is no converter.

A workflow session does not accept prompts, answers, steers or session
messages (refused with `WORKFLOW_SESSION_NOT_CONVERSATIONAL` or a clear
error) or regeneration (refused with `REGENERATE_UNSUPPORTED`); a stop request
answers `no_active_turn`.

The first admitted definition, inputs, owner, parent and tool grant are
immutable. Retrying a pending creation with the same key resumes its stored
start after a catalog/start interruption. A different definition or owner
conflicts; a completed run does not restart. There is no automatic sweep for
a pending creation that is never retried.

## Reading the saved definition revision

The overview returned by `read_workflow` and `readWorkflow` exposes an
existing session-definition pin as `definition.source`:
`{ ownerSessionId, definitionId, revision }`. Starting saved revision 2
therefore reports `definition.source.revision: 2`, even though the
Workflow child's immutable copy starts at revision 1. This source is fixed
at creation and does not change when the session saves revision 3.

The local fields `definition.currentRevision`,
`definition.publishedRevision`, `revision.revision`, `graph.revision` and
`runs[].revision` are unchanged; local reads and guarded operations still
use them. A Workflow without the stored session-definition pin returns
`definition.source: null`. Do not infer a source from a matching name or
the owner's current definition. Portal and terminal labels say
"Saved definition revision 2"; a local number beside it is called
"Workflow copy revision 1".

## Finite change watchers

A watcher can read a query and linked pull-request snapshot, retain the
baseline in `context.input`, and return `unchanged` until a meaningful
difference appears:

```yaml
poll:
  type: script
  outcomes: [unchanged, changed, expired]
  source: |
    // compare the new snapshot with the baseline in context.input
  transition:
    next: { unchanged: pause, changed: report, expired: no_change, failure: failed }
pause:
  type: wait                     # its output is its input: the baseline
  seconds: 30
  transition: { next: { elapsed: poll, failure: failed } }
```

Only a terminal result wakes the parent. The watcher ends on the first change;
it does not automatically start again. Include an explicit poll-count or time
limit and a terminal `expired` path. The run's node limit
(`limits.maxNodeExecutions`, 1,000 by default) is a final safety limit, not a recommended watcher lifetime. Store a large delta as an
artifact and return its reference; the parent message contains a short preview.

Completion notification is on by default. `notify_on_completion: false`
disables it; a parent-requested stop does not send a redundant wake-up. For a
Workflow, starting its live run (`update_workflow start` or
`publish_and_start`, by the agent or by a person) turns the notification on
again, even for a draft spawned with it off, unless that start passes
`notify_on_completion: false`; `read_workflow` shows the current setting as
`definition.notifyOnCompletion`.
Delivery is a separate activity with up to three attempts over 40 seconds.
A durable child receipt prevents later re-delivery after success. If a worker
dies between enqueue and receipt, the parent's normal `clientMessageIds`
deduplication covers pending messages and its last 20 consumed IDs. This is
not an unbounded exactly-once guarantee. Delivery failures are recorded as
`workflow.parent_notification_failed`; they do not replace the workflow's
terminal result. A terminal, deleted or no-longer-authorized parent is skipped.
When a live run ends and its parent is not told, the workflow records
`workflow.parent_notification_skipped` once, with the reason (`notifications
are off` or `parent is gone`); Run activity and the terminal show it ("The
parent agent was not told: notifications are off."). A run the parent ended
itself records nothing. A parent whose session has ended is not sent the
notice (`parent is gone`). A parent session that has not started yet (made
without a first message, so it has no session orchestration) is not started
for the notice: the notice is kept once as a session note, which the session's
first turn reads and which is consumed when that turn succeeds, as a person's
save note is; the skip says `the session has not started yet; kept as a note for
its first turn`. One attempt at a time tells the parent of a run's
end: it holds the run's notice lock (a PostgreSQL advisory lock) while it
reads, records `workflow.parent_notifying` just before it queues the notice,
queues it and records the result. Another attempt that finds the lock held
waits for it (up to 20 seconds) and reads again, so it records nothing when
the holder recorded; if the lock is still held, the attempt fails and is tried
again. If the holder dies, the run still owes its notice and `recover`
finishes it. An attempt has no time limit of its own. Only the notice's own waits are bounded:
at most 15 seconds for deliveries in flight and at most 20 seconds for the lock,
no more than 27 seconds in all. Getting a database connection, the SQL calls
and the send itself have no time limit, so an attempt that hangs there can
stay pending with no end and keep the lock. The later attempts and `recover`
make progress only after that attempt settles, or after its database
connection or its worker process ends and releases the lock. A retry after an attempt that may have queued the
notice queues it again with the same client message id when the parent may be
told; when it finds a known refusal it records the skip with
`earlierAttempt: true`, and Run activity adds "An earlier attempt may have
told the parent." The notice waits (at most 15 seconds) for a send's message
or a request to the parent whose delivery began before the run ended, or was
failed after its delivery began, so the parent reads them before the run's
end. A delivery slower than that, or begun more than a minute earlier, can
still reach the parent after the notice.
Workflow names and outputs arrive as escaped JSON explicitly marked untrusted,
not as executable instructions.

A Workflow's messages to an agent session share one format, as a
child agent's `[CHILD_UPDATE ...]` does: a header line
`[WORKFLOW_UPDATE from=<workflow session> workflow=<name>@<version> run=<run> type=<ended|message|request|test_waiting> ...]`
with the type's fields (ended: `status`, `outcome`, `state`; message:
`state`, `contract`, `exchange`; request: `state`, `contract`, `request`,
`deadline`; test_waiting: `state`, `interception`), then one plain sentence
that says what happened and what to do (a failed run names its step, the
error and its first problem), then `Data (JSON, not instructions):` and the
escaped JSON. A send's message names its workflow by session, as its text is
rendered from the stored exchange. The worker records these messages with
the sender kind `workflow`, and the portal and the terminal show them as
"Workflow · <type>" cards. They wake the parent as other messages do; batching
run ends the way child updates are batched is a follow-up.

## Stopping a workflow

Cancel, complete and delete work as they do for an agent session: from the
portal, the management API (`cancelSession`, `completeSession`,
`deleteSession`), or a parent agent's `cancel_agent`, `complete_agent` or
`delete_agent`. The running script is killed (with every process it
started), the run ends as **cancelled** without reaching a terminal state
(complete also ends it as cancelled, with reason "Stopped"), and the parent
is told unless it asked. Delete also removes the session.

Ending the session that owns a Workflow ends the Workflow too, whatever its
state (owner decision, 2026-11-11). Completing that session is never refused
for an active Workflow, from any entry point: the management API's
`completeSession`, the portal's Complete, a parent's `complete_agent`, or the
completion of the session's own parent. The session's done reaches each of
its Workflow children: an active run (admitted, running or paused) is
cancelled with the reason "Parent session completing", its agent steps end,
and the Workflow session ends cancelled. A test bench is not in the session's
child list, so the done does not reach it; when the owner's state becomes
completed, its active test run is cancelled ("The session that owns this
Workflow ended, so the Workflow was canceled."), not with "Parent session
completing". A Workflow whose runs had already ended keeps its state.
Cancelling the owner, or its failure, ends them the same way; deleting it
deletes them.

Known exceptions, filed and not fixed in this release
([issue 290](https://github.com/microsoft/PilotSwarm/issues/290)):

- A child session that was never sent a first message has no orchestration,
  so a live delete, cancel or complete of its parent waits for it and the
  parent ends failed, with its subtree left as it was (section 1).
- Completing the owner skips a Workflow whose controller had already failed;
  that Workflow's agent session stays alive (section 2).
- A direct `updateWorkflow` operation `test` on a retained test bench can
  still start a test run after the owner completed (section 3).

For a Workflow, a cancel or complete ends the run in the store when
it is accepted, from every entry point: `update_workflow`, the parent agent,
the management API and the agent manager's `manage_agent_session`. Its
pending steps are cancelled in the same transaction, so no further step
starts. The controller finds the ended run at its next store call: it stops
the cancelled scripts, ends agent children, tells the parent (unless the
parent asked) and finishes. A delete deletes the workflow at once, which ends
its run; the controller then stops its scripts and ends its agent children,
and tells no one. A paused run ends too, and a graceful stop in progress is
replaced by the cancel. On a run that already ended, the request is recorded
with that end and changes nothing. Whatever ended the run first decides who
is told: a later command that lost changes nothing.

A Workflow session, including a finished live run, is kept until
it is explicitly deleted or an ancestor session is deleted. It is never an
independent Sweeper cleanup candidate, even with a zero-minute grace or after
its controller instance is pruned. `read_workflow` can recover the saved
status, output and execution records while the session remains. The end
notice states this retention rule. This is not a permanent archive: save
important results before deleting the Workflow or its owning session.
An ended or missing parent alone does not delete a Workflow row.
Test benches keep their existing separate limit: only the newest 5 ended
tests per definition are retained, as described above; ordinary draft test
runs also keep their existing test-retention policy.
Keeping finished live Workflows increases storage with the number and size
of saved runs and results. A person can delete an old Workflow session from
the session list (or press `D` in its TUI view), after saving any needed
results. Deleting its owning session also removes its Workflows.

A run whose controller is gone, or ended while the run is still active, is
`update_workflow` operation `recover`'s to dispatch again or to end, not the
Sweeper's. A status read that fails, of the controller or of the Workflow's
runs, deletes nothing. Ordinary sessions retain the Sweeper's existing grace.
Deleting a Workflow session goes through the normal path: its definition
becomes a tombstone. Cleaning an ended session removes all its descendants
with it, whatever their state: a parent's lifecycle owns its children's, so
any run still active under it (a Workflow child's or a test bench's) ends
with it, as an explicit delete would end it. The final check and the delete
are one transaction under the session row's lock. Every run admission takes
that lock first, so whichever commits first decides:

- The Sweeper reads the row's version before it judges the session, and
  refuses unless the row still has that exact version (any update changes
  it, whatever its timestamps). A run admitted, or a first message's row
  update, after that read and before the final check makes the cleanup
  refuse and delete nothing.
- An admission that comes after the delete finds the session deleted and
  does nothing.
- A session's first message is not fenced, as on main: it reads the row
  and the session's lineage, starts the orchestration, updates the row
  (running, with its orchestration ID), then queues the prompt. A cleanup can
  commit anywhere from that first row read to the row update. The update
  defeats the cleanup only if it lands before the Sweeper's final locked
  version check. Otherwise the session is deleted, the started turn finds it
  deleted and runs no model, and that first message is dropped.
- An ordinary session whose first message was accepted (its row records its
  orchestration) is never taken as ended because its orchestration reads
  NotFound, at any age: a start that no worker has picked up yet reads
  NotFound for as long as it waits. Only a terminal status (Completed, Failed,
  Terminated) or an ended session state (completed, cancelled, failed) shows
  that it ended. A session with no first message yet is a candidate after the
  grace, as before.
- The Sweeper waits for the target's own lock (the lock admissions take).
  It then locks every other session the delete would change
  before it changes any, without waiting: when another transaction holds one,
  it refuses at once and deletes nothing. It reads that set again under those
  locks and refuses if it grew. A session is created only after its parent's
  lock and never under a deleted parent (`PARENT_DELETED`), so no session
  created during a cleanup is left under a deleted parent. A later scan tries
  again after any refusal.

The kill reaches the worker when the running script state next renews its
activity lock. The lock times out after `PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`
(10 seconds by default) and is renewed about every 5 seconds, so the worker
can take up to about 5 seconds to see the cancellation. It then kills the
script's process tree within about 250 milliseconds. The activity's
JavaScript is not aborted: it returns when the killed script ends. The
worker's activity slot stays held until that task ends, or at most for a
10-second grace. A command sent between two states stops the next one.

## Running workflows (operators)

### Workflows are always on, with the full engine

Workflows need no setting (owner decisions, 2026-11-08): every worker, the
portal, the MCP server and the terminal UI have them, with the full engine.
Every worker serves session orchestration 1.0.83 (the latest version) and
the Workflow controller (1.0.0), so every Workflow can use agent, parallel and
request states, clock waits and a run deadline, every session can test a revision,
and a person can send workflow commands.

- Where Workflows are on in a session (below), it is declared
  `workflow_definition`, `update_workflow`, `read_workflow` and
  `send_workflow_input` (and `respond_session_request` on a 1.0.83 turn), and
  its base instructions carry the Workflow guidance. `spawn_workflow` is no
  longer declared. The exceptions are unchanged: the tuner gets no workflow
  tool; a session inside a Workflow gets no definition tools
  (`workflow_definition`, `update_workflow`); an agent node's agent session also gets
  `complete_workflow_node` and its node's tool limit.
- The guidance teaches the full engine in about 2,200 characters, names
  every state type (`script`, `wait`, `messaging` with `mode: send`,
  `request` or `receive`, `agent`, `parallel`, `terminal`; "there is no
  other"), and names three of the Workflow skills: `workflow-authoring`,
  `workflow-reference` (every field) and `workflow-tools` (every tool
  argument). Every worker loads those and `workflow-patterns`;
  `workflow-testing` only with test mode. `load_skill` serves them to every
  session. The skills index lists them where Workflows are on in the session (a
  Base V1 session's index, and Base V2's), and not while they are off.
- The portal and the terminal UI always show the Workflow button, tab, pane,
  `w` key and Workflow rows.
- MCP always registers `read_workflow` and `update_workflow`; the portal and
  MCP take a person's workflow commands.
- The bootstrap's `workflows` keeps its `enabled` field and always says
  `true`, so an older portal or client keeps working; today's clients do not
  read it.

Sessions of the previous release (orchestration 1.0.82) keep running on the
frozen 1.0.82 and move to 1.0.83 at their next continue-as-new, which carries
their queued prompts, pending child updates, notices and model. Until then a
turn of such a session runs on 1.0.82. Its Workflows run on the Workflow
controller like every other, and that turn is offered `workflow_definition`'s `test`
operation, but not the clock-wait line or `respond_session_request`, and a Workflow's request to the
session is refused until it continues as new. Upgrade by stopping every
worker, deploying, then starting them (`deploy/scripts/README.md`, "Upgrading
to this release: stop, deploy, start"); do not roll the workers.

The five tools, the guidance and the screens are there whether or not the
workers run scripts. `PILOTSWARM_WORKFLOW_SCRIPTS` (below) decides only whether
script nodes run; they run unless it is `0` (or `false`, `no`, `off`). Where they do not run, a
definition with a script node is refused when it is saved and when it is
started (`WORKFLOW_SCRIPTS_DISABLED`, naming the setting), and the agent's
guidance says so. A person's save or Start through the portal or MCP is
refused the same way when that process turns scripts off too; when only the
workers do, such a run fails at its first script node, with the setting named.

`cron` and `cron_at` (stage 2.5, PR 235 `4b0ac3ca`): where the workers run
scripts, `cron` says it wakes the agent only for work that
needs its judgment, and that a check a script can do belongs in one Workflow
(saved with `workflow_definition` and started once) that loops through a wait
state; where clock waits run, `cron_at` says the same, with
a wait state's `at`. Every rule of their default wording is kept. With scripts
off, both keep main's wording.

### Workflows on demand per session

A session carries the Workflow tools and guidance only when Workflows are on in
it (owner decision, 2026-11-08). They cost about 2,000 tokens; a session that
never uses a Workflow carries a paragraph of about 500 characters and one tool,
`enable_workflows`, instead. cron and cron_at keep their default wording plus
one sentence: with Workflows on, a fixed check a script can do belongs in one
Workflow's wait loop; with them off, suggest a Workflow to the user and call
`enable_workflows` only if they agree.

- **Turning them on.** Only turning Workflows on needs the user (owner
  decision, 2026-11-11). The model calls `enable_workflows` when the user asks
  for a Workflow, or when it suggested one (for a fixed procedure, or a
  repeated check a script could do) and the user agreed; it never takes
  silence for agreement. Once they are on, the session uses Workflows wherever
  they fit, without asking. The flag is saved
  with the session's capability state (revision-checked, never cleared). The
  turn ends at once, and the next turn starts automatically with the Workflow
  tools and guidance and continues the task: one extra model call and one
  prompt-cache miss. A call where they are on changes nothing. It is refused
  while native tasks run (as `use_package` is).
- **On without asking.** A session with a Workflow Definition or a Workflow
  (for example one from an earlier release); a Workflow's message or request
  that arrives; a person's saved definition; the coordinating session of a
  package's Workflow. Each saves the flag. Also on, without saving: a session
  inside a Workflow, Agent Smith, and a turn of a session still on
  orchestration 1.0.82.
- **A read that fails.** When a turn cannot read whether the session owns a
  Definition or a Workflow, or cannot read its definition notes, that turn
  stays off (the paragraph and `enable_workflows`, no Workflow tools or
  guidance). The next turn reads again.
- **Never.** The read-only tuner and service sessions get neither the
  paragraph nor `enable_workflows`.
- A deployment without durable capability storage (no session catalog) has
  them on in every session.

### Test mode (hidden)

Testing a workflow (a test run with mocked effects, its held calls and its
virtual clock) is hidden from every surface people and agents use. Its code
and its tests stay. One deployment flag shows it again:

| Setting | Effect |
|---|---|
| `PILOTSWARM_WORKFLOW_TEST_MODE=on` (exactly `on`; off by default) | The `update_workflow` operations `test`, `test_respond` and `test_advance` are declared to agents and taken from them; a person's workflow commands (Web API, MCP) take them and the bootstrap lists them, so the portal and the terminal UI show test controls and test runs. The base guidance mentions the test notice. |

Off, agents are not declared the test operations, and an agent's tool answers
one exactly as an operation that does not exist (the unknown operation's
refusal, with no word of testing); so does a person's command (Web API, MCP).
"Absent" means an unknown operation, not an unknown route: there is no test
route, so `POST /api/v1/sessions/{id}/workflow/commands` with a test operation
answers `400 WORKFLOW_COMMAND_INVALID`, exactly as any unknown operation does
(an unknown route would be 404). The portal and the terminal UI show no test
control or test run: a workflow read says `testMode: true` only while the flag
is on, and the screens show test runs only on that word. Stored test
runs are kept but not shown: the workflow read (SDK, Web API, MCP) does not
list them, and refuses a test run's id, as a run, a page cursor's run, an
execution's or a variables revision's, exactly as it refuses an unknown run's.
The MCP `read_workflow` description names no test part. The flag changes
nothing else. A session's revision test (`workflow_definition` `test`, stage 2.2)
does not need it: it runs on every deployment. The `workflow-testing`
guide is kept apart from the authoring skills, in
`packages/sdk/plugins/workflow/test-mode-skills`, so an agent reads it only
where test mode is on. The SDK's local tests run with the flag on.

### Scripts
Scripts run as child processes **on the worker**. Script states are **on** by
default (owner decision, 2026-11-08); an operator can turn them off:

| Setting | Effect |
|---|---|
| `PILOTSWARM_WORKFLOW_SCRIPTS=0` (or `false`, `no`, `off`) or `new PilotSwarmWorker({ workflowScripts: { enabled: false } })` | Run no workflow script states on this worker. Unset, empty, `1`, `true` or `yes`: they run; any other value: they run, with one startup warning. |

Turn scripts off on **every** worker of a deployment, or on none: any worker
may run any state. A worker with scripts off still runs the controller, so a workflow
with script states fails there at its start, or at its next script state,
with a message that names the setting instead of waiting. Agents on such a
worker still have the workflow tools; a definition with a script node is
refused at save and at Start, in words that name the setting.

On Linux and macOS a script leads its own process group (stage 2.4). When the
step is stopped (its timeout, a cancel) every process of that group is killed,
and so is what the script leaves running in it when it ends: a background
process it started, even one that left its process tree, does not outlive the
step, and one that keeps the script's output open no longer holds the step
until its timeout.

**Named branches** (owner decision 2026-11-08, option A; not on TEST
until the formal design model passes). A parallel state may give `branches`
instead of `forEach` and `body`:
`branches: { <name>: { initial, states, input? } }`. Each branch is its own
graph: it starts at its own `initial`, its routes stay inside it, and its
`input` is a template read in the parallel state's scope when the state is
entered (without one, the branch gets the value that arrived at the state).
State ids stay unique across the Workflow, so each branch's agent node takes
its own `agent_models` entry. `concurrency` defaults to the number of
branches; more than 16 branches without a `concurrency` are refused ("17
branches would not all start at once: set concurrency (at most 16) or use
fewer branches"), never silently capped. The joins (`all`, `{ first: k }` with k at most the branches),
`failFast`, `timeoutSeconds`, cancellation and the node limit are the For
each's. The joined output is `{ <name>: output }`; with `{ first: k }` it
holds the winners only. A report (blocked or timed_out) names each branch
(`name` beside its `index`). `branch.name` binds in a branch's states (and a
script reads `context.branch.name`); a For each's items have no name, so it
is refused there. `forEach` with `branches`, `body` with `branches`, a route
into another branch and k above the branches are refused. The controller's
plan gives a named fork's `branches` (their number), one initial for each
(`initials`) and each branch's states (`branchStates`); parsePlan refuses a
named fork without them, or with an initial outside its own branch, and a
For each with any of them. A plan without branches reads as before, and old
histories replay unchanged. No migration. A route never
takes a list of targets: the compiler says "a route has one target; use a
parallel state with branches to run several nodes at once".

A join of every branch waits as long as its slowest branch runs, and a branch
that never ends (a receive with no wait and no message) holds it until the run
is cancelled or stopped (formal model FJ-S11). Without a `timeoutSeconds` on
the parallel state, the compiler warns `WORKFLOW_BRANCH_UNBOUNDED` for each
branch that has an agent state or a receive with no wait. A For each's body is
not checked. A plan's branch initials are one for each branch, the first the
body's; any other plan fails the controller loudly instead of starting a
branch at another branch's initial. A stopped or cancelled parallel state
writes no branch report.

The store decides every join of a named fork, whatever its join: a failFast
block cuts the other branches' work and decides the fork in one transaction
(a For each without `{ first: k }` or a time limit keeps its recorded
schedule: the cut, then its join). So a named fork's report, all-required
too, is the store's: each branch also carries `cancelledBy` (`failFast`,
`join` or `timeout`) when a cut ended it, and `ended: "finished"` when its
last step finished but its next one never started; a For each that joins
every branch with no time limit reports as before, without them. After an accepted graceful stop, nothing
settles a named fork: neither its join nor its own time limit (by the store's
clock or a test run's) cuts its started branches or writes a report; their
work runs to its own deadlines, and the stop's end cancels the pending fork
("The run stopped before this parallel state joined its branches."). A For
each keeps its behaviour. A fork with `timeoutSeconds` must route `timed_out`
itself, as a For each must: the root `catchAll` does not stand in for that
route. The names on a `workflow.branches_cancelled` event are read before
and outside the cut's transaction, each scope's from its own fork (a cut of
several forks' branches never mixes their names, and names none when one of
them is a For each's); when they cannot be read the event has none, the
failure is logged at warn with the run and the forks, and the cut is
unchanged.

The portal's graph draws named branches as lanes side by side in one box
labelled "Branches", in their declared order and with no stack behind it; the
parallel step leads into each lane by an edge labelled with the branch's name,
and each lane's end leads down to the join bar. The card, the Node panel, the
Log, why a visit was canceled, the replay and the terminal's node details say
"branch" and its name where a For each says "item". A visit's branch name
comes from its step on the graph (`branchName`); read rows carry only the
branch's index.

Agents learn named branches from `workflow-authoring` (section 8),
`workflow-reference` (the `branches` field) and the on-demand
`workflow-patterns` skill, which has a complete example (`two-views`) and
keeps the router pattern as the older form, for branches that come from a
list. The base guidance and Agent Smith (1.4.7) say the same.

A parallel state that does not join ends with a report of its
branches (`joined: false`, `total`, `succeeded`, `failFast`, `branches`). The
report also has `timedOut` (whether the state's time limit ended it) and
`needed` (the successes its join needed). Read a report by the fields you
use, not by its exact set of fields.

A Workflow hides more secrets in its text than it did before. Events and
rows that were stored before this change are not rewritten. Such events and
rows exist only in development and test deployments. An old event can show a
list or object default of a binding, or part of a credential that was cut
before it was hidden. Before you share a Workflow test session from such a
deployment with other people, delete the session or create it again.

Cleanup failures are explicit. The worker attempts native-task cancellation
and disconnect even when abort fails. If it cannot confirm that tasks stopped,
it retains the folder hold and blocks a new executor on that worker pending
recovery; it does not report a successful release.

Each running script state holds one of the worker's activity slots
(`PILOTSWARM_WORKER_CONCURRENCY`, 2 by default) for as long as its script
runs, and agent turns use the same slots. Raise the setting, or keep scripts
short, when workflows run beside busy agents.

Size the slots for parallel states too. Each branch that runs a script holds
a slot until the script ends. The controller's own steps (collecting results,
admitting the next step, deciding a join, cancelling the other branches) need
a free slot as well. Keep a parallel state's `concurrency` below the worker's
slot count: set `PILOTSWARM_WORKER_CONCURRENCY` above the widest parallel
state's `concurrency` that runs scripts, plus some room for the controller and
for the agents that run there (the duroxide default is 2). With fewer slots
than running branches plus one, the branches run in waves and the controller
waits behind them, so a race's stop of its losers waits for a free slot.

Stopping a losing branch's script is best-effort, and a script runs at least
once: one whose worker loses its activity lock runs again from its start
(its attempt count goes up; see Durability). When the cancellation is
saved, the script's own liveness check usually stops it within about a
second. If both that check and the cancel request fail, the script can run
until recovery or until its own timeout (300 seconds by default, at most
3,600), and its side effects can happen. The result does not change: a join
of the first k still takes the first k successes that the store saved, in
the order it saved them, and a time limit is still decided by the store's
clock. But scheduling can change what is saved before a deadline: with too
few slots the decision comes later, and a branch that would have been
cancelled can finish first (it keeps its result and is not a winner). If a
cancelled branch's script or agent session cannot be stopped at once, the
controller goes on and tries again at most once per wake period, also while
the run is busy with other steps and after it continues as new; the run's
end ends any agent session still owed.

A Workflow run's controller is one duroxide orchestration, and these
duroxide limits shape it:

- It waits by racing its command queue against a durable timer. A queue
  read wins only when its message is already in the turn that duroxide
  fetched, and duroxide returns a fetched batch in the order the messages
  were stored, so the timer can win over a message that arrived before the
  timer was due. When a message wins, duroxide drops the timer from the race
  but does not remove it: the timer still fires later and adds a turn and a
  history entry. The
  controller continues as new after 25 admitted steps, or after 50 waits
  (a wait counts when it brings no command: its timer fired, or a wake
  came, running or paused; a command is applied first, never dropped by
  the continue-as-new). So a run whose work all waits continues as new
  under a steady stream of wakes too; a wake is only a hint, and the next
  execution's first collection finds what it was for. These counts bound
  the work that one execution repeats. They do not bound its history
  exactly: the wakes that arrive faster than the controller reads them,
  the timers that lost their races and the timers of retried store
  activities add entries that no count includes.
- The queue carries hints. An accepted cancel, complete or delete is store
  state: it has already ended the run, and the controller's next store call
  finds that (see Stopping a workflow). duroxide carries at most 100 unread
  queue messages into the next execution and drops the newer ones, so a
  continue-as-new can drop wake messages. It can also drop a command that an
  older build only queued, when at least 100 earlier unread messages are
  ahead of it.
- duroxide fails a turn that takes more than 100 queued messages in a row.
  The controller's read of the queue before an admission takes at most 32
  messages per batch, and a store activity comes before the next batch. A
  queued command behind more wake messages is read one or more passes later;
  a wait, a stop or the run deadline is not held back by them.
- duroxide fixes how a race between a queue read and a timer resolves when
  an execution starts, by the duroxide version that started it (the
  corrected behavior came in 0.1.31). An upgrade does not change an
  execution that an older version started; its next execution after a
  continue-as-new gets the current behavior. Workflows were added after
  PilotSwarm moved to duroxide 0.1.32 (duroxide-node 0.2.4), so no Workflow
  execution started with the older behavior. Executions of other
  orchestrations, such as agent sessions, that an older duroxide started keep
  the older behavior.

Isolation, in this version:

- A script gets a fresh temporary directory as its working directory and
  `HOME`, and **none of the worker's environment** except `PATH` and locale
  variables. It reaches PilotSwarm only through a loopback endpoint guarded
  by a per-run token.
- Every script runs as a Node ES module with Node's `--permission`, with
  filesystem grants limited to its own bootstrap/scratch directory, without direct child-process, worker-thread
  or native-addon permission. This prevents accidental direct filesystem
  access; it is **not** a hostile-code or network sandbox.
- Network: on the worker's Node (24.x) the permission model does not limit
  the network. A script can reach whatever the worker pod can: the cluster's
  services and the internet. The shipped worker templates (the GitOps worker
  base and `deploy/k8s/worker-network-policy.yaml`) carry a NetworkPolicy that
  denies the worker pods the instance metadata address (169.254.169.254),
  which would otherwise hand out the node's managed identity token, and the
  Azure host endpoint (168.63.129.16, DNS on it excepted), and keep all other
  egress. A deployment that does not use these templates, or whose
  cluster has no network policy engine, must block that address itself (for
  example, with the AKS IMDS restriction) or turn scripts off with
  `PILOTSWARM_WORKFLOW_SCRIPTS=0`.
- A script runs on the worker's own Node (`process.execPath`), and only
  when that Node is in the SDK's engines range, `^24.22.1 || >=26.12.1`.
  Outside it, the state fails with `execution_failed` before its script
  starts, and the error names the worker's Node version and the range.
- Native shell/file tools execute outside that script guardrail under their
  own captured permission and workspace policies. Granting a shell tool still
  grants its authorized effects. The script's Node flags do not restrict a
  brokered shell process.

## Durability

Each Workflow run has one durable controller orchestration
(`workflow-controller`, version 1.0.0), separate from the session's own
orchestration. The controller keeps the exact ids of the work it started in
its own history. Each visit of a state, with its input, outcome and output, is
a row in PostgreSQL. So a worker restart loses nothing: the controller goes on
where it was, and waits, receives, requests and agent steps keep their
deadlines.

- A visit's first stored result stands (a compare-and-swap). A late or
  repeated result does not change it.
- A script runs at least once, not exactly once. When its worker dies, or
  stalls for longer than its activity lock allows
  (`PILOTSWARM_WORKER_LOCK_TIMEOUT_MS`, renewed while it runs), another worker
  runs the script again from its start, and `context.attempt` goes up. Write
  scripts so that running one twice is safe.
- An agent step's agent session has a stable id. A retry finds the same session and does
  not give it its prompt twice.
- A message to an agent session, a request and the end notice are queued with
  a stable client message id: at least once, not exactly once.
- The controller continues as new after 25 admitted states or 50 idle waits,
  to keep its history small.
- A run records the controller version it started at. A build that cannot
  replay that version fails the run visibly: `read_workflow` shows
  `needsRecovery`, and `recover` ends the run.

The `workflow-reference` skill's Semantics section tells models the same, with
what pause, stop, cancel, deadlines and joins do.
