Status: Approved design (rule approved and open questions decided 2026-11-13, see section 8; implementation in progress; source citations are pinned to PilotSwarm 0.8.11, commit `7ee6eff4`)

# Tool and package composition: design, implementation and test specification

This file answers which tools a spawned child, a Workflow, a script step and an agent step get, how a parent gives tools to a child, and what changes for an existing deployment. Paths are under `packages/sdk/src/` unless given in full. "Today" means 0.8.11.

## 1. Problem

A parent session can hold tools that its children cannot get.

Example. A session loads the tool `pkg_tool_a` from the published package `pkg-a` with `use_package`. It starts a watch Workflow. A script step polls with `pkg_tool_a` every five minutes. When the script finds work, an agent step that runs the named agent `agent-b` must drain the work with the same tool.

Today:

- The script can call `pkg_tool_a`. A script calls tools through the grant that the Start captured (`session-manager.ts:3862-3896`).
- The agent step cannot. Its session is an ordinary child session with no loaded package (`workflow/agent-host.ts:157-172`, `204-209`).
- The step cannot load the package itself. Only a top-level session can (`session-manager.ts:2705`).
- A child made with `spawn_agent` has the same gap (`orchestration/agents.ts:931-945`).

There is also no way to say "this step must use this tool", and the two existing limits have different meanings: an agent step's `tools:` is a ceiling, and `spawn_agent`'s `tool_names` is a replacement list.

## 2. The rule

### 2.1 Tool categories

| Category | Definition | Examples | How a session gets it |
|---|---|---|---|
| Platform | Built into PilotSwarm; acts on the session or the platform | wait, cron, facts, artifacts, canvas, `load_skill`, `use_package`, `spawn_agent` and the sub-agent tools, Workflow tools, `complete_workflow_node` | From its role |
| Built-in CLI | The model runtime's own tools | shell, file view and edit, search | From its role |
| Capability | Acts on the outside world; comes from the deployment or from a package | a deployment tool `dep_tool_x`, a deployment MCP server, a package tool `pkg_tool_a`, a package MCP server `mcp-c` | Declared by a named agent, or granted by the parent |

Two kinds of tool are outside the categories. Identity tools (administration bundles) come from who the session is and are never granted. Workspace tools come with an attached folder.

### 2.2 Definitions

- **Role**: top-level session, spawned child, Workflow session, script step, agent step, or sub-agent of an agent step. The role fixes the platform and built-in CLI tools.
- **Declared tools**: the capability tools that a named agent's definition lists. They may come from any package that the session's owner can use. They may be more than the parent has.
- **Inherited list**: the tool names that a child with no agent name takes from its parent, as at 0.8.11. Package-owned names are dropped from it. It is the child's baseline, and it is not part of the grant. A `tool_names` list takes its place, as at 0.8.11.
- **Grant**: the capability tools that a parent gives a child, in addition to what the child has without a grant. They are taken from the parent's effective capability tools when the child is made, and then pinned for the child's life. A grant only adds.
- **Ceiling**: the `tools` list of a child: the most that the child and every session below it may use, in every category.
- **Required tools**: tools that a step's agent must call before the step can complete: a step's `requiredTools`, and a named agent's startup tool (`initialRequiredTool`).
- **Pin**: the recorded package version. For a deployment tool, the pin is its name and its parameter schema.

### 2.3 Parameters

Two parameters, with the same meaning on `spawn_agent` and on an agent step in Workflow YAML.

| Parameter | Meaning | Forms |
|---|---|---|
| `grant` | What the parent hands down | `all`; `none`; or a list of tool names (`pkg_tool_a`), whole packages (`package:pkg-a`) and whole MCP servers (`mcp:mcp-c`) |
| `tools` | The ceiling: the most this child may use | `none`; or a list of 1 to 64 tool names |

- `grant` only adds, and `tools` only removes. `grant: none` adds nothing. It does not take away a tool that the child has without a grant: its role tools, its declared tools, or the inherited list. To give a child fewer tools, use `tools`.
- There is no exclude field.
- `spawn_agent` keeps `tool_names` with its 0.8.11 meaning. It is deprecated. A call that combines it with `grant` or `tools` is refused. See 5.2.
- An agent step also has `requiredTools`: 1 to 16 tool names.
- A Workflow Start takes all of the starting session's capability tools. A Start has no `grant` parameter in this release (decision Q3).

### 2.4 Formula and rules

`effective(child) = (role tools + declared tools + grant) cut by the ceiling`

A child with no agent name has no declared tools. In their place it has the inherited list (2.2), for every value of `grant`.

1. **A grant is never more than the parent has.** Each entry of a grant list must be in the parent's effective capability tools when the child is made. If not, the spawn or the Start is refused, and the refusal names the entry. **One exception: `tool_names`** (see below).
2. **Declared tools may be more than the parent has.** They may come from any package that the session's owner can use.
3. **The ceiling applies last, to every category,** for the child and for every session below it. It only removes. An agent step's own session always keeps `complete_workflow_node`.
4. **A ceiling that leaves out a required tool is refused.** The Workflow Start is refused (or the definition is refused at save, when the YAML alone shows it), and the refusal names the tool.
5. **The child's tools are pinned when the child is made.** Later changes of the parent do not reach the child: loading or unloading a package, turning Workflows on, a new package version. The tools of an agent step are fixed when its Workflow starts.
6. **A child grants only from what it holds.**
7. **A grant carries capability tools only.** It never carries platform, built-in CLI, identity or workspace tools. An MCP server that the deployment restricts to named agents (`allowedAgents`) is given only to a child that the deployment admits (decision Q2).

**The one exception to rule 1.** A grant never exceeds the parent, for every call except a `spawn_agent` call with `tool_names`. `tool_names` is not a grant: it is the 0.8.11 list, kept as it is. It keeps its 0.8.11 power to give a child a deployment tool that the parent does not hold. The exception ends when `tool_names` is removed (5.2).

### 2.5 Defaults

| Child | Default grant |
|---|---|
| `spawn_agent`, no agent name | `all` |
| `spawn_agent`, named agent | `none`: its declared tools only |
| Workflow session (Start) | all of the starting session |
| Script step | everything the Workflow session has |
| Agent step, inline prompt | `all` of the Workflow session |
| Agent step, named agent | `none`: its declared tools only |
| Sub-agent of an agent step, no agent name | `all` of the step |
| Sub-agent of an agent step, named agent | `none` |

A `spawn_agent` call that passes `tool_names` gets no grant: the child gets its role tools and the listed names, as at 0.8.11.

**A parent with no owner.** A grant passes on the owner's right to use a package or an MCP server. A session with no owner, for example a system session, has no such right to pass on. So:

- its `spawn_agent` calls still succeed, and the child gets exactly its 0.8.11 set;
- the grant adds nothing: no package tools and no MCP servers. `grant: all` and no `grant` mean the same here;
- a `grant` list is refused, and the refusal states the reason;
- `grant: none`, `tools` and `tool_names` work as for any other parent (decision O).

For a child with no agent name, `grant: none` gives today's list and nothing more: the inherited list stays. Only `tools` makes the list shorter (decision G).

Guidance to a model that calls `spawn_agent`: keep grants small; prefer `none` or a short list.

**Name collisions and MCP restrictions.** Workflow delegation filters each export before binding: a tool the step already has or a restricted MCP server that does not admit the step is omitted, while other exports of that source remain. Ordinary package activation instead rejects the whole conflicting source selection. These are separate paths; delegation does not change activation's contract.

### 2.6 What stops a tool

| Event | Effect on a child that holds the tool |
|---|---|
| The package gets a new version, or is rolled back | None: the child is pinned |
| The parent unloads the package | None |
| The pinned version is deleted or disabled, or made private, or the owner loses access | Only that package's tools stop. The error names the package, the version and the reason |
| A worker release changes a deployment tool's description | None |
| A worker release changes a deployment tool's parameters | Only calls of that tool fail. The error names the tool |
| The package registry does not answer for a moment | Retried inside the call; then a temporary error that the caller can retry |

### 2.7 Other users' packages

- A named agent from another user's package gets only its declared tools by default.
- A grant to it is allowed. One audit record for each spawn or Start lists the granted tools, their sources and ownership, and the agent's package and owner.
- Whether a session may run another user's agent at all is controlled today only by the model's instructions. An enforced check is planned separately.

### 2.8 The example, solved

```yaml
drain:
  type: agent
  invoke: { agent: { name: agent-b, package: pkg-b } }
  grant: [pkg_tool_a]          # omit when agent-b declares pkg_tool_a itself
  requiredTools: [pkg_tool_a]  # the step cannot complete with an outcome before it calls the tool
  tools: [pkg_tool_a, dep_tool_x]   # optional ceiling
```

## 3. Who gets what

"Role tools" are the platform and built-in CLI tools of the role, plus the deployment's default tools and default MCP servers.

| # | Session | Role tools | Declared tools | Default grant | Today (0.8.11) | Change |
|---|---|---|---|---|---|---|
| 1 | Top-level session | Full set; Workflow tools when on | Its named agent's, if any | n/a | The same | None for a session that opens today |
| 2 | `spawn_agent` child, no name | Child set; sub-agent tools to the depth limit | None | `all` | The parent's tool names; package tools dropped; no loaded package; no agent MCP server | Gains the parent's package tools, loaded packages and MCP servers |
| 3 | `spawn_agent` child, named | Child set | Yes; other packages allowed | `none` | Declared tools of its own package and of the deployment | A declared tool of another package now works; `grant` is new |
| 4 | Workflow session | None: it runs no model | None | all of the starter | The captured grant, checked as one block at each call | The same set, now pinned |
| 5 | Script step | Script set: no wait, cron, spawn, Workflow control, `ask_user` or canvas | None | the Workflow session's tools | The same; 100 calls for each step | Calls keep working after a new package version |
| 6 | Agent step, inline prompt | Agent-step set: `complete_workflow_node`; no `ask_user`, `use_package` or definition tools | None | `all` of the Workflow session | Role tools only | Gains the Workflow session's capability tools |
| 7 | Agent step, named agent | Agent-step set | Yes, at the pinned agent package revision; other packages allowed | `none` | Declared tools of its own package and of the deployment | A declared tool of another package now works; `grant` and `requiredTools` are new; the agent's startup tool is enforced (N4) |
| 8 | Sub-agent of an agent step, no name | Child set; no `complete_workflow_node`; no further spawn | None | `all` of the step | As row 2, under the step's ceiling | As row 2, under the step's ceiling |
| 9 | Sub-agent of an agent step, named | Child set | Yes | `none` | As row 3, under the step's ceiling | As row 3, under the step's ceiling |

The ceiling (`tools`) applies to rows 2, 3 and 6 to 9. On rows 6 to 9 it exists today (`session-proxy.ts:2541-2547`; `session-manager.ts:411-427`). On rows 2 and 3 it is new. `tool_names` on row 2 is unchanged (5.2). For a parent with no owner, rows 2 and 3 stay as at 0.8.11 (2.5).

## 4. Compatibility: the change only adds

### 4.1 What is shown

For every role and every input that 0.8.11 accepts:

- **P1.** The new release accepts the input.
- **P2.** The session is offered every tool that 0.8.11 offers it: `new set ⊇ old set`.
- **P3.** Every tool call that 0.8.11 allows is allowed.

A cell where one of these does not hold is named in 4.4, with its reach and what is done about it. The comparison is with the shipped 0.8.11, not with any later test build.

### 4.2 Method

The new set is built as "the 0.8.11 set, by the 0.8.11 code, plus additions". Three facts carry the proof:

1. **The new parameters are new.** At 0.8.11 a Workflow definition with `grant` or `requiredTools` on a state is a save error, `WORKFLOW_FIELD_UNKNOWN` (`workflow/compiler.ts:980-982`), so no stored revision has them. `spawn_agent` does not declare `grant` or `tools` (`managed-session.ts:2875`), so a model is not offered them. A refusal that only a new parameter can cause cannot reach an existing input. This includes the refusal of `tool_names` together with `grant` or `tools`.
2. **Absent means today.** With no `grant`, the default of each row applies, and each default contains the 0.8.11 set (4.3). With no `tools`, there is no ceiling. With every value of `grant`, also `none`, a child with no agent name keeps the 0.8.11 list (decision G).
3. **A ceiling is applied after the additions, with the same list as today.** Cutting two sets with one list keeps the order: if `A ⊆ B` then `A ∩ C ⊆ B ∩ C`. So a stored revision with `tools:` gets at least what it gets today.

### 4.3 Row by row

| # | Existing input | Old set (0.8.11) | New set | Why P1 to P3 hold |
|---|---|---|---|---|
| 1 | Create a session; `use_package` | Role tools, the named agent's tools, loaded packages | The same code | No change |
| 2 | `spawn_agent`, no name, no `tool_names` | Role tools, plus the parent's tool-name list with package-owned names dropped (`orchestration/agents.ts:931-945`, policy `drop`; `session-manager.ts:4372-4395`) | The same list, by the same code, plus the grant `all` | The old list is kept as it is; the grant only adds |
| 2 | The same, with `tool_names` | Role tools, plus the listed names | The same set, by the same code. Such a call gets no grant | No change: `tool_names` keeps its 0.8.11 meaning (N1 to N3) |
| 3 | `spawn_agent`, named | Role tools, plus the declared tools bound from the agent's own package or the deployment (`orchestration/agents.ts:838-848`). A declared tool of another package stops the session from opening (`session-manager.ts:4387-4391`) | The same binding; a declared tool of another package now binds; grant `none` | A session that opens today gets the same set. One that fails today now opens |
| 2, 3 | `spawn_agent` from a parent with no owner | As rows 2 and 3 | The same set, by the same code. The grant adds nothing | No change (N8) |
| 4 | Workflow Start | The starter's catalog without control tools, its loaded packages and their revisions (`session-manager.ts:3862-3896`) | The same capture | No change to the set. The set is fixed at Start in both releases |
| 5 | A script's tool call | Allowed when the tool is in the grant and no captured package, agent or loaded package changed since Start (`session-manager.ts:3906-3934`) | Allowed when the tool is in the grant, its pinned package version can be reached, and its own parameters did not change | Every call that passes the 0.8.11 check passes the new one: when nothing changed, every pin is the active version |
| 6 | Agent step, inline prompt, with or without `tools:` | Role tools, cut by `tools:` | Role tools plus the Workflow session's capability tools, cut by the same `tools:` | Fact 3. Only for Workflows started on the new release; a running Workflow keeps the old set |
| 7 | Agent step, named agent, with or without `tools:` | Role tools plus declared tools (`workflow/agent-host.ts:204-209`), cut by `tools:` | The same, plus declared tools of other packages, cut by the same `tools:`; grant `none` | Fact 3; as row 3. For the startup tool see **N4, N5** |
| 8, 9 | `spawn_agent` inside an agent step | As rows 2 and 3, cut by the step's `tools:` | As rows 2 and 3, cut by the same list | Fact 3 |

A stored revision keeps its stored form. A revision that 0.8.11 compiled has no new field, so it is read as before, with the defaults above.

### 4.4 Cells that are not pure expansion

Eight cells were examined. After the decisions of section 8:

- N1 to N3 hold by construction: `tool_names` is unchanged.
- N6 cannot be reached by an existing input.
- N7 is closed by the deploy order.
- N8 holds by construction: a parent with no owner gets no expansion, and its children lose nothing.
- **N4 and N5 are a real narrowing**, accepted by decision Q5. They are one rule in two places. A step that ran at 0.8.11 without its named agent's startup tool is now refused: at the step's first turn (N4), which also reaches a Workflow that is already running, or at Start (N5), for a new Start. In the two deployments that were checked, no stored step is in this case (4.7).

| # | Cell | Who can reach it | Result |
|---|---|---|---|
| N1 | A `spawn_agent` call with `tool_names`, on the new session orchestration version. | Any model: the parameter stays in the tool's schema. | **Holds by construction.** `tool_names` keeps its 0.8.11 meaning on the new version (decision Q4). The call is accepted and the child gets the same set. |
| N2 | With `tool_names`, a child can get a deployment tool that its parent does not hold: any registered tool name binds (`session-manager.ts:4372-4395`). | As N1, when the list names such a tool. | **Holds by construction**: kept as it is. This is the one path outside rule 1. It goes when `tool_names` is removed. |
| N3 | With `tool_names`, a parent can give a child fewer tools. | As N1. | **Holds by construction**: kept as it is. The new way to give a child fewer tools is `tools`. `grant: none` does not do it: it keeps the inherited list. |
| N4 | A named agent's startup tool is enforced in an agent step: the first turn of the step's session must call it. 0.8.11 enforces it for `spawn_agent` only, so at 0.8.11 the step ran without the tool. The rule applies to every Workflow after the upgrade, also to one that started before it (decision Q5). So a named step whose agent has a startup tool **can now fail at its first turn, also in a Workflow that is already running**: (a) when the step is not offered the tool, because its `tools:` list leaves it out or because an agent step cannot have it, the turn is refused before a model request, and the error names the tool; (b) when the model does not call the tool after the corrections, the turn fails. In both cases the visit fails like any failed agent visit. | Only an agent whose definition sets `initialRequiredTool`, used in an agent step whose session has not run a turn yet. | **A real narrowing**, accepted by decision. The agent's author declared that the tool must run first, and a step now honours that. In the two deployments that were checked, no stored agent step uses such an agent (4.7). A step session that has already run a turn is not asked. |
| N5 | Rule 4 at Start: a Start is refused when a named step is not offered its agent's startup tool, because the step's `tools:` list leaves it out or because an agent step cannot have it. 0.8.11 starts it and ignores the startup tool. | As N4 (a), for a Start on the new release. | **A real narrowing**, decided with Q5. The refusal names the tool and the state. It is the earlier form of N4 (a): without it, the step would fail at its first turn. |
| N6 | Refusals that need a new parameter: rule 4 for `requiredTools`; rule 1 for a `grant` list entry that the parent does not hold; `tool_names` together with `grant` or `tools`. | No existing input (fact 1). | None needed. |
| N7 | Mixed fleet: a 0.8.11 worker does not know `grant` or `requiredTools`, and would ignore them. | A deployment that runs both releases at once, or that rolls back. | Deploy with stop, deploy, start: no worker of 0.8.11 runs beside the new release (5.4). A rollback to 0.8.11 ignores `grant` and `requiredTools` on revisions saved with them; their agent steps then run with the 0.8.11 tool set. |
| N8 | A parent with no owner, for example a system session, gets no expansion: the grant adds nothing to its children. A `grant` list from it is refused. | `spawn_agent` calls of such a session. | **Holds by construction** (decision O). The spawn succeeds, and the child gets exactly its 0.8.11 set. The refusal of a `grant` list needs a new parameter (fact 1). |

**Deprecation of `tool_names`.** Sessions move to the new session orchestration version at their next continue-as-new (`orchestration/lifecycle.ts:783`). So versioning alone would not keep `tool_names` for a long-lived session, and models do use it (4.7). That is why it is kept on the new version, with a description that says "deprecated: use `grant` and `tools`". Its removal is a later change, tracked by an issue that is filed with the pull request of this change. While it exists, `tool_names` is the one exception to rule 1: it can give a child a deployment tool that the parent does not hold (N2). Its removal takes that power away on purpose and needs its own compatibility check.

### 4.5 Effects that are not permissions

- A child with no agent name sees more tool declarations than today. This costs context tokens. With `grant: none` the child keeps today's list and gets nothing more. A `grant` list adds only the named tools. `tools` shortens the list.
- A granted tool never replaces a tool that the child already has under the same name: the child's own tool wins. A granted MCP server with a name that the child already has is left out.
- Each spawn and each Start with a grant writes one audit record.

### 4.6 Start checks from other changes in the same release

These are not part of this change. They are listed because they also refuse a Start that 0.8.11 accepts.

| Check | 0.8.11 | Reach |
|---|---|---|
| A script names a tool that is not in the grant | The Start succeeds; the call fails at run time | A run that fails today is refused earlier. A script that catches the error and goes on is the one case that ran today |
| A script names a canvas tool | The Start succeeds; every such call fails ("the canvas bridge is unavailable") | As above |
| The grant cannot be captured, and the definition has a script state | The Start succeeds; every tool call fails | As above |

### 4.7 Checks on two live deployments

Two deployments that run 0.8.11 were checked with read-only queries on 2026-11-13: one in daily use, and one test deployment. The numbers are aggregates.

| Check | Deployment in daily use | Test deployment | What it shows |
|---|---|---|---|
| `spawn_agent` calls that pass `tool_names` | 191 of 3,630, in 7 days | 0 of 4, in 30 days | Models use the parameter. It is kept, so these calls do not change (N1 to N3) |
| Stored agent steps | 13 | 2 | With each stored `tools:` list, a step keeps its set or gains tools. None loses a tool |
| Stored agent steps whose agent has a startup tool | 0 | 0 | N4 and N5 reach no stored step |
| Published packages with an agent that has a startup tool | 1 | 0 | Such an agent exists. A step that uses it later must call the tool first |

## 5. Versioning

### 5.1 Which part needs which version

No part needs a new Workflow controller version: the controller never reads these fields. Only the `spawn_agent` part needs the new session orchestration version.

| Part | Rows | Where it is decided | New session orchestration version? |
|---|---|---|---|
| `grant` on an agent step; the defaults `all` (inline) and `none` (named) | 6, 7 | The step session's turn (`session-manager.ts` `getOrCreate`), the compiler | **No** |
| `tools` on an agent step | 6 to 9 | Exists today | **No** |
| `requiredTools` and its completion check | 6, 7 | The Workflow store, at `complete_workflow_node` | **No** |
| Rule 4 at save and at Start; rule 1 for a step's `grant` list at Start | 6, 7 | The compiler, the Start checks | **No** |
| A named agent's startup tool in an agent step, for every Workflow | 7 | The step's first turn | **No** |
| Pins of the Workflow grant; a lost package stops only its own tools | 4, 5 | Each tool call | **No** |
| Rule 2: a declared tool of another package binds | 3, 7 | `session-manager.ts` `_resolveTools`, when the session opens | **No**: a session that fails to open today now opens |
| `spawn_agent` `grant` and `tools`; a ceiling for a spawned child's subtree | 2, 3 | The spawning turn and the session orchestration's spawn action (`orchestration/agents.ts:792-990`) | **Yes** |
| The default `all` for a child with no agent name | 2 | The same | **Yes** |
| A sub-agent of an agent step gets the step's granted tools | 8, 9 | The same | **Yes** |
| `tool_names` deprecated; refused together with `grant` or `tools` | 2 | The same | **Yes** |

The example of section 1 uses only parts that are marked "No". Both parts ship in one release, with session orchestration version 1.0.84 (section 8).

### 5.2 `tool_names`

- `spawn_agent` keeps `tool_names` on every session orchestration version, with its 0.8.11 meaning. For a child with no agent name, the child gets its role tools and the listed names. With an agent name, the call is refused, as today.
- A call with `tool_names` gets no grant. So the child's set is exactly the 0.8.11 set. A ceiling of a session above the child still applies, as today for an agent step.
- On the new version, `tool_names` is deprecated. Its description says so and names `grant` and `tools`.
- On the new version, a call that combines `tool_names` with `grant` or `tools` is refused: "tool_names cannot be combined with grant or tools. Use grant to give the child tools and tools to limit it." No child is made.
- Turns of the new version run under a new activity routing contract, as each earlier turn protocol did (`activity-routing.ts:10-18`, `71-100`). The contract tells a turn which `spawn_agent` schema to offer. Older versions offer the 0.8.11 schema, without `grant` and `tools`.
- While it exists, `tool_names` is the one exception to rule 1. A grant never exceeds the parent; a `tool_names` list can still name a deployment tool that the parent does not hold, and the child gets it, as at 0.8.11.
- Removal is a later change, with its own issue (4.4). It ends the exception.

### 5.3 How an old session replays

- Each session orchestration version has its own frozen handler in the registry (`orchestration-registry.ts`). A recorded history replays on the handler of its own version, and a replay does not run activities again. So no recorded decision changes.
- A session moves to the newest version at its next continue-as-new (`orchestration/lifecycle.ts:783`). From then on its new spawns follow the new rule.
- A child that exists keeps its stored configuration. It has no stored grant, so it keeps the 0.8.11 set for its whole life (rule 5).
- A Workflow that is running keeps its stored grant. Its agent steps keep the 0.8.11 set: the new defaults apply to Workflows started on the new release. Package pins apply to it at once, which only removes failures. One more rule applies to it at once: a named agent's startup tool, at the first turn of a step's session (N4).

### 5.4 Deploy order

- Turns of the new session orchestration version run under a new activity routing contract with its own capability tag, as each earlier version did (5.2). This is the standard mechanism of a new version. It is not rollback handling.
- Deploy with stop, deploy, start. No worker of 0.8.11 runs beside the new release.
- A rollback to 0.8.11 ignores `grant` and `requiredTools` on revisions saved with them; their agent steps then run with the 0.8.11 tool set.
- There is no IR version change and no save-time check.

### 5.5 Stored data

No database migration. New stored values, all optional JSON fields:

- a child session's creation configuration: `toolGrant` (tool names, package pins, MCP servers) and `toolCeiling`;
- the Workflow grant: `agentStepBindings`, written by a Start on the new release. For each agent state it holds the tools captured for that state (granted tools and declared tools of other packages, after the ceiling), with their selections, source revisions and package labels;
- the compiled graph: `grant` and `requiredTools` on an agent state. The IR version stays 1, and a graph without these fields is the same byte for byte;
- events: `session.tools_granted`, `workflow.tools_delegated`, `workflow.agent_tool_called`.

**Where a default is fixed.** A definition stores what its author wrote: an absent `grant` stays absent. The default is not written into the revision.

- For an agent step, the grant is resolved at Start, default included, and stored for each agent state in the Workflow grant (`agentStepBindings`). A worker binds the stored set. It never applies a default of its own release to a running Workflow. A grant without `agentStepBindings` gets the 0.8.11 set.
- For a spawned child, the grant is resolved in the spawn: tool names, package pins and MCP servers. The result is stored in the child's creation configuration and is not computed again.

## 6. Implementation plan

Build order: phase A fixes the example and needs no orchestration change; phase B is the `spawn_agent` part. Both phases ship in one release (section 8).

### Phase A: agent steps

| File | Function | Change |
|---|---|---|
| `workflow/compiler.ts` | `compileAgent` (980-1090), `WorkflowIRAgent`, `parseWorkflowIr` (2038) | Accept `grant` (`all`, `none`, list with `package:` and `mcp:` entries) and `requiredTools`. Rule 4 at compile time: each required tool is inside `tools`. The stored-graph reader copies both fields. The IR version stays 1. |
| `workflow/tool-policy.ts` | `WorkflowToolBinding`, `readWorkflowToolBinding` | Optional `agentStepBindings`: one stored binding for each agent state. A reader must accept a grant without it. |
| `workflow/session-definitions.ts`, `workflow/service.ts` | save, publish, Start | At Start, capture `agentStepBindings`: for each agent state, select the grant from the tools that the Workflow session holds (rule 1), add the declared tools of other packages with their pins (rule 2), and cut by `tools`. Rule 4 through the Start checks, for `requiredTools` and for a named agent's startup tool. Refusal `WORKFLOW_TOOLS_UNAVAILABLE`. |
| `workflow/tool-requirements.ts` | the Start diagnostics | Check each `grant` entry against the grant, and each required tool against what the step will be offered. Where the offered set cannot be known, warn and let the first turn decide. |
| `workflow/store.ts` | `readAgentToolLimit` (6054) | Return the step's `tools`, `grant` and `requiredTools` from the run's own revision in one read. |
| `session-proxy.ts` | the turn's Workflow setup (2536-2547) | Read the step policy; pass the state's stored binding to `getOrCreate`. Only when the Workflow's grant has `agentStepBindings`. |
| `session-manager.ts` | `getOrCreate`: the capability binding (2442-2449, 2616-2649) | Bind the state's stored binding: for an inline step by default every capability tool of the Workflow session; for a named step by default only its declared tools, plus its `grant` entries. Leave out a name that the step already has, and an MCP server that does not admit the step's agent. Each call checks the stored grant again (`authorizeWorkflowTools`, 3906-3934). |
| `session-manager.ts` | `workflowAgentToolAllowlist`, `workflowLimitedSdkTools` (411-427) | Unchanged: the ceiling. |
| `workflow/agent-host.ts` | the first prompt (284) | Send the named agent's startup tool with the first prompt of the step's session, for every Workflow (N4). The turn checks the tools that the session is offered after the ceiling. When the startup tool is not among them, the turn is refused before a model request. |
| `workflow/store.ts`, `workflow/agent-node-service.ts` | `completeAgentNode` | The completion gate: refuse an outcome with `REQUIRED_TOOLS_NOT_CALLED` until each required tool has a recorded call in this visit. A call that returned an error counts. Error completions are not gated. A refusal counts against the limit of three invalid completions. |
| Package pins | the pinned-version snapshot, the lost-package error, the retry of a registry read | Reuse for the Workflow grant as built. |
| Workflow skills | authoring, reference, tools | `grant`, `tools`, `requiredTools`; the defaults; the refusals. |

Where earlier, unmerged work differs from this rule, the rule wins: a named agent step defaults to `none`, not to the starter's loaded packages; an inline step gets every capability tool of the Workflow session, not only loaded packages.

### Phase B: `spawn_agent`, in the new session orchestration version

| File | Function | Change |
|---|---|---|
| `orchestration-version.ts`, `orchestration-registry.ts` | version constants, registry | New latest version. Freeze the current files as the previous version. If another change in the same release needs a new session orchestration version, they share it. |
| `activity-routing.ts`, `session-proxy.ts` | `ActivityRoutingContract`, `createSessionProxy` (860-890), the turn registrations (5794-5807) | New contract and capability tag for the new version's turns, as for each earlier version. |
| new `tool-grant.ts` | pure functions, shared with the compiler and the agent step | Check the form of a grant (`all`, `none`, list). Select from the tools that the parent holds: rule 1, the `package:` and `mcp:` forms. The caller chooses the default. |
| `managed-session.ts` | the `spawn_agent` definitions (1393, 2875) and handler (2890-2945) | On the new version: declare `grant` and `tools`; keep `tool_names` and describe it as deprecated; refuse a call that combines it with `grant` or `tools`. On older versions: unchanged. |
| `session-proxy.ts` | `spawnAgent` (3388-3680) | Keep the 0.8.11 tool-name inheritance for a child with no name, for every value of `grant`. A call with `tool_names` takes the 0.8.11 path and gets no grant. For every other call, add the resolved grant and the ceiling to the child's creation configuration. Rule 4 for a named child's startup tool. For a parent with no owner, the grant resolves to nothing, and a `grant` list is refused with the reason (N8). Write `session.tools_granted`. |
| `orchestration/agents.ts` | `handleSubAgentAction` (792-990) | The same, for the path without an inline spawn. |
| `types.ts`, `client.ts` | `SerializableSessionConfig`, `createSession` (255-290) | Carry `toolGrant` and `toolCeiling`. A child's ceiling is its own list cut by its parent's ceiling. |
| `session-manager.ts` | `getOrCreate`, `_resolveTools` (4372-4410) | Bind a stored grant at its pins. Apply a stored ceiling with the functions of the agent-step ceiling. Rule 2: bind a declared tool of another package that the owner can use, and pin that package version when the session is made. |
| Package pins | the snapshot | Take "a pinned grant" as input, so a spawned child's grant and a Workflow's grant use one path. |
| Prompts | `plugins/system/agents/default.agent.md:62`, `base-agent-policy.ts:37`, `native-subagents.ts:47` | Say that `tool_names` is deprecated and that `grant` and `tools` replace it; add the guidance "keep grants small". |

## 7. Test specification

Every test uses stand-in packages and tools (`pkg-a` with `pkg_tool_a`, `pkg-b` with `agent-b`, deployment tool `dep_tool_x`, MCP server `mcp-c`).

### 7.1 One test for each row

| Row | Test |
|---|---|
| 1 | A top-level session's tool list is the same before and after the change. |
| 2 | An unnamed child holds the parent's loaded `pkg_tool_a` and its MCP server, and still holds every tool name it held at 0.8.11. `grant: none` adds nothing: the child's set is equal to the 0.8.11 set. `grant: [pkg_tool_a]` adds one tool to that set. A list entry that the parent lacks refuses the spawn and names the entry. `tools` cuts the child and its own child, and it cuts the inherited list too. |
| 3 | A named child holds its declared tools and nothing from the parent. `grant: [pkg_tool_a]` adds one. A declared tool of another package binds, at the version that was active when the child was made. |
| 4 | The grant of a Start is the same before and after. A package that the starter loads after the Start is not in it. |
| 5 | A script calls `pkg_tool_a` before and after a new version of `pkg-a`, and after the starter unloads it. |
| 6 | An inline step of a new Workflow calls `pkg_tool_a` and `dep_tool_x` of the starter. With `tools: [pkg_tool_a]` it has only that tool and `complete_workflow_node`. An inline step of a Workflow started before the change gains nothing. |
| 7 | A named step has its declared tools only. `grant: [pkg_tool_a]` adds one. With `requiredTools`, an early completion is refused with the list of tools not yet called; it is accepted after the call; a call that returned an error counts; each visit needs its own call; error completions pass; the third refusal fails the step. |
| 8, 9 | A sub-agent of a step holds the step's tools by default (no name) or its declared tools (named), inside the step's ceiling. It cannot spawn. |

### 7.2 One test for each cell of 4.4

| Cell | Test |
|---|---|
| N1 | On the new version, a call with `tool_names` and no agent name is accepted. The child's tool set is equal to the set that the 0.8.11 code gives for the same call. The schema offered to the model has `tool_names`, described as deprecated. |
| N2 | On the new version, `tool_names: [dep_tool_y]` for a tool that the parent lacks still binds. `grant: [dep_tool_y]` is refused. |
| N3 | On the new version, `tool_names: [dep_tool_x]` gives the child that tool and no grant. |
| N4 | A named agent with a startup tool, in an agent step. In a new Workflow, and in a Workflow that started before the upgrade: the first turn of the step's session must call the tool. In a Workflow that started before the upgrade, with a `tools:` list that leaves the tool out: the step fails at its first turn, before a model request, and the error names the tool. A step session that has already run a turn is not asked. |
| N5 | A Start is refused when a named step's `tools` leaves out the agent's startup tool, and when the startup tool is one that an agent step cannot have; the refusal names the tool and the state; nothing is created. |
| N6 | `requiredTools` outside `tools` is a save error. A `grant` entry outside the Workflow's grant refuses the Start. `tool_names` with `grant`, and `tool_names` with `tools`, refuse the spawn; no child is made. |
| N7 | No automated test: the deploy order is checked in the live checks (7.5, check 5). |
| N8 | A parent with no owner spawns a child with no agent name, and a named child. Each child's tool set is equal to the set that the 0.8.11 code gives. `grant: all` adds nothing. A `grant` list is refused with the reason, and no child is made. `grant: none`, `tools` and `tool_names` work. |

### 7.3 Replay and stored data

- **Replay.** Record a history on the current session orchestration version that spawns a child with `tool_names`. Replay it on a worker of the new release: the replay completes with no nondeterminism error, and the child's stored configuration is the recorded one.
- **Move to the new version.** A session that spawned with the old rule continues as new. Its next spawn follows the new rule. Its earlier child is unchanged. A spawn with `tool_names` gives the same child before and after the move.
- **IR compatibility.** A definition without the new fields compiles to the same bytes and the same hash as before this change. A stored 0.8.11 revision with `tools:` reads back the same. A definition with `grant` or `requiredTools` is stored and read back with both fields.
- **Migrations.** The migration list is unchanged: this change adds none.
- **Grant.** A stored grant without `agentStepBindings` reads back unchanged and gives agent steps the 0.8.11 set. A keyed retry of a Start keeps its first grant.

### 7.4 What stops a tool

One test for each row of 2.6, for a script, an agent step and a spawned child.

### 7.5 Live checks on a test deployment

1. The example of section 1, end to end: a script polls, an agent step with `grant` and `requiredTools` drains with the stand-in tool, and the step cannot complete before the call.
2. An unnamed `spawn_agent` child calls a tool of a package that its parent loaded.
3. A Workflow that was running before the upgrade: its script calls work after the upgrade, and its agent steps have the same tools as before.
4. A package gets a new version during a run: the script and the agent step keep the pinned version.
5. After the stop-all deploy and before the first save with `grant`: the worker list shows only the new release.
6. The audit record of a Start and of a spawn lists the tools, their sources and ownership.
7. After the upgrade, a `spawn_agent` call with `tool_names` gives the child the listed tools, as before (N1 to N3).
8. A named step whose agent has a startup tool: the first turn calls the tool. With a `tools:` list that leaves the tool out, the Start is refused (N4, N5).

### 7.6 Executable coverage map

Paths below are relative to `packages/sdk/test/`. Names identify the test or
parameterized test family, not a claim that the whole file proves every row.
Real-source tests require the separate old and current source roots specified
by their environment variables. A skipped real-source case is not replay
evidence. Live checks in 7.5 remain separate from unit and local-worker tests.

| Entry | Test file: name |
|---|---|
| Row 1 | `local/tool-composition-child-sets.test.js`: `leaves a top-level session's tool catalog unchanged after capturing a child grant` |
| Row 2, package/MCP/default/list grants | `local/tool-composition-worker-spawn.test.js`: `adds only selected package tools and MCP methods to the unchanged unnamed baseline` |
| Row 2, baseline/refusals/descendants | `local/tool-composition-child-sets.test.js`: `grant none retains the frozen 1.0.83 unnamed child's exact offered set`; `refuses invalid composition`; `an inherited ceiling cuts a child's legacy tool_names grandchild end to end` |
| Row 3 | `local/tool-composition-child-sets.test.js`: `a named child's explicit grant adds exactly one parent package tool to its declared baseline`; `a named child pins a foreign-package tool and handles registry failure`; `unit/orchestration-composition-1-0-84.test.mjs`: `spawn captures unnamed all and named none, and refuses unheld selectors before a child exists` |
| Row 4 | `local/tool-composition-workflow-sets.test.js`: `pins the Start selections and applies grant ... with a real child ceiling`; `local/workflow-agent-tool-admission.test.js`: `persists separate state snapshots without widening scripts and replays the original Start after parent changes` |
| Row 5 | `local/workflow-tool-package-pins.test.js`: parameterized `republish A`, `rollback A` and `unload A` mutation cases |
| Row 6 | `local/tool-composition-workflow-sets.test.js`: `pins the Start selections and applies grant ... with a real child ceiling`; `unit/workflow-tool-composition.test.mjs`: `the grant includes a parent's held deployment capability without granting role tools`; `pre-composition selection bindings use named-none and inline-all role defaults`; `local/workflow-real-source-upgrade.test.js`: `keeps a named step's declared tools separate from the inline step` |
| Row 7, declared/granted set | `unit/workflow-tool-composition.test.mjs`: `inline agents default to all; named agents default to no parent grant and keep their declared and role tools`; `a named step pins declared foreign-package tools independently of its default-none parent grant`; `local/workflow-agent-tool-admission.test.js`: state-snapshot persistence case |
| Row 7, completion evidence | `local/workflow-agent-required-tools-worker.test.js`: `counts an errored package call and exact delegated MCP call anew on both continued visits`; `local/workflow-agent-required-tools.test.js`: `refuses early outcomes, persists the refusal, and accepts after both exact calls in each visit`; `shares the three invalid-completion budget and preserves error-completion escape routes` |
| Rows 8 and 9 | `local/tool-composition-child-sets.test.js`: `a real depth-two step sub-agent cannot spawn again`; `unit/orchestration-composition-1-0-84.test.mjs`: `a Workflow step hands down only its scoped pinned capabilities and its own ceiling` |
| N1 | `local/session-real-source-upgrade.test.js`: `offers an identical ordinary child tool set on actual 0.8.11 and Release A`; `unit/orchestration-composition-1-0-84.test.mjs`: `only composition turns expose grant and tools; every turn keeps the deprecated tool_names compatibility path` |
| N2 | `local/tool-composition-child-sets.test.js`: `legacy tool_names binds an unheld deployment tool with frozen parity`; `refuses invalid composition 'deployment_tool' before creating a child` |
| N3 | `local/tool-composition-child-sets.test.js`: legacy parity cases; `local/session-real-source-upgrade.test.js`: version-move case asserts no grant on the legacy child |
| N4 | `local/workflow-agent-initial-tool.test.js`: `enforces the host's opening contract in a real child SDK/CLI turn`; `refuses a pre-upgrade Workflow's first named turn before a model request when its stored ceiling excludes startup` |
| N5 | `local/workflow-agent-tool-admission.test.js`: `accepts default requirements but refuses unavailable startup tool ... before creating a child`, for both an excluded declared tool and `spawn_agent`; each refusal names the state and the tool |
| N6 | `local/workflow-agent-required-tools.test.js`: `validates distinct names and the ceiling, and retains them in IR version 1`; `local/workflow-agent-tool-admission.test.js`: `warns about an unheld explicit grant at Save and refuses Start before any effects`; `local/tool-composition-child-sets.test.js`: both `cannot be combined` cases assert no child |
| N7 | No automated verdict. Check 7.5.5 is the stop-all deployment observation |
| N8 | `local/tool-composition-child-sets.test.js`: ownerless frozen baseline, named baseline, legacy parity and explicit ceiling cases; `refuses invalid composition 'ownerless' before creating a child` |
| 7.3 replay and move | `local/session-real-source-upgrade.test.js`: `continues an actual 1.0.83 session as new into 1.0.84 and dispatches composition turns`; compares the recorded native history prefix, earlier child configuration and same-parent legacy offers |
| 7.3 IR | `local/tool-composition-historical.test.js`: `preserves the exact pre-composition IR bytes and hash when all new fields are omitted`; `unit/workflow-tool-composition.test.mjs`: `composition grants compile and survive a serialized IR round trip without changing omitted fields` |
| 7.3 migrations | `local/tool-composition-historical.test.js`: `leaves the complete pre-composition migration inventory and file contents unchanged` |
| 7.3 stored grant | `unit/workflow-tool-composition.test.mjs`: `state snapshots survive persistence, refuse malformed or missing scopes, and never widen scripts`; `pre-composition selection bindings use named-none and inline-all role defaults`; `local/workflow-agent-tool-admission.test.js`: original keyed Start replay case |
| 7.4 parent unload | `local/workflow-tool-package-pins.test.js`: `unload A`; `local/tool-composition-workflow-sets.test.js`: real child call after parent unload; `unit/orchestration-composition-1-0-84.test.mjs`: `spawn pins survive projection and later parent selection changes without changing legacy projections` |
| 7.4 package publication/version | `local/workflow-tool-package-pins.test.js`: `republish A` and `rollback A`; `unit/orchestration-composition-1-0-84.test.mjs`: `an opened ordinary child executes its pinned foreign handler after republish, and rejects its revocation`; `local/workflow-package-agent-dependencies.test.js`: retained agent package handlers |
| 7.4 package unavailable/access lost | `local/workflow-tool-package-pins.test.js`: removal/access mutation cases; `local/workflow-package-agent-dependencies.test.js`: `leaves sibling package tools on an agent turn and reports the missing required tool's exact cause`; ordinary-child opened-handler revocation case |
| 7.4 deployment tool description/schema/removal | `local/workflow-tool-pins-authority.test.js`: `legacy/new script/agent-step/spawned-child bindings keep built-ins and compare only the called contract`; a changed or missing called tool is named in the error |
| 7.4 temporary registry failure | `local/workflow-tool-package-pins.test.js`: registry mutation cases; `local/tool-composition-workflow-sets.test.js`: real agent-call registry failure; `local/tool-composition-child-sets.test.js`: real spawned-call registry failure, three checks and no handler rerun |
| Collision path distinction | `local/workflow-agent-tool-contract-assumptions.test.js`: ordinary collision rejection and Workflow prefilter-to-binder bridge; `local/workflow-agent-required-tools.test.js`: `drops only colliding or forbidden exports, respects the ceiling and uses the step agent's MCP allowlist identity` |
| Formal leakage model | `docs/formal/tools/leakage/`: `LeakCore`, `LeakRules`, `LeakStore` and `LeakChain`, 58 tabled cases; see that packet's correspondence and bounded-proof limits |

## 8. Decisions

All decisions are of 2026-11-13 (UTC). They are by the project owner, except rows O and G: the release coordinator decided them under the owner's rule that the change only expands. No question is open.

| # | Question | Decision | Decided |
|---|---|---|---|
| V | Does the `spawn_agent` part ship in a new session orchestration version? | Yes | 02:01 |
| R | The rule of section 2: categories, grant forms, defaults, `tools` as the ceiling, `grant` added, no exclude field | Approved | 02:19 |
| D | Is there special handling for a worker rollback? | No. Deploy with stop, deploy, start (5.4) | 02:36 |
| Q1 | For a child with no agent name, does the default `all` keep the tool names that 0.8.11 passes down? In one edge case, read from source and not run, that list has a deployment tool that the parent's agent definition has dropped since the parent started (`orchestration/runtime.ts:128-139`; `session-manager.ts:2161-2182`). | Keep the 0.8.11 behaviour (the recommended default; no objection). It makes row 2 an expansion by construction | 04:01 |
| Q2 | Does a grant pass an MCP server that the deployment restricts to named agents (`allowedAgents`) to a child that the deployment does not admit? | No. The restriction is judged for the child itself, as today | 04:01 |
| Q3 | Does a Workflow Start take a `grant` parameter? | Not in this release. A Start always takes all of the starter | 04:01 |
| Q4 | `tool_names` on the new session orchestration version: refuse, or keep? | Keep, with its 0.8.11 meaning. It is deprecated, and it is refused only together with `grant` or `tools`. An issue to remove it is filed with the pull request. This replaces the decision of 02:19 to retire it in the new version | 04:01 |
| Q5 | Is a named agent's startup tool enforced inside an agent step, and for which Workflows? | Yes, for every Workflow after the upgrade, also for one that started before it. Those are checked at the step's first turn, because their Start is past (N4) | 04:01 |
| S | One release or two? | One. The agent-step part and the `spawn_agent` part ship together | 04:01 |
| O | What does a parent with no owner, for example a system session, give its children? | Its spawns still succeed. The child gets exactly its 0.8.11 set. The grant adds nothing: no package tools and no MCP servers. A `grant` list is refused with the reason. `grant: none`, `tools` and `tool_names` work (N8) | 04:08 |
| G | For a child with no agent name, does `grant: none` take away the tool names that the child takes from its parent at 0.8.11? | No. That list is the child's baseline, and it is not part of the grant. `grant` only adds to it. Only the `tools` ceiling shortens it | 04:19 |
