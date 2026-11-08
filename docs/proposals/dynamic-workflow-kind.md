# Proposal: A dynamic-workflow kind for durable Workflows

**Status:** Proposal — not committed work. Nothing in PR 270 implements it:
definitions and runs have no kind column (the YAML's `kind: Workflow` only
names the document type), and the code has no seam for a second engine.
**Date:** 2026-11-08

## Summary

PilotSwarm has one kind of durable Workflow today: a YAML state machine that
a chat saves and starts, and that people follow as a graph. GitHub Copilot
has dynamic workflows: JavaScript programs (`extension.mjs`) that run in a
Copilot client. This proposal lays down a possible future plan to run such a
program as a second **kind** of Workflow, durably, on PilotSwarm workers.

- One Workflow concept, several kinds. People and chats see one thing:
  definitions with revisions, one run list, one Workflow tab, one tool set,
  one test bench and one end notice.
- Today's visual (YAML state-machine) Workflows stay exactly as they are.
- The dynamic kind is a **re-run host**. A new orchestration re-runs the
  author's `run(ctx)` under the script guard and feeds it a journal keyed the
  way Copilot keys it. Each pending `ctx.agent` call becomes an ordinary agent
  step. Each `ctx.pause` becomes a request to the chat, plus a Resume button.
- Rough size after PR 270: about 6 weeks for a first usable version, in
  three phases, plus optional extras.

The comparison with GitHub's workflow features is in
[Workflows and GitHub Copilot](../developer/building/workflows-and-github-copilot.md).

## Problem

- A Copilot dynamic workflow runs in the user's Copilot client: Copilot CLI,
  the Copilot app or a Copilot SDK host [S12, S14]. Its run belongs to the
  session that owns it [S15]. If that runtime goes away, the run becomes
  `halted`, and it can be resumed later [S15]. People cannot follow it from
  PilotSwarm.
- PilotSwarm Workflows run on the server and survive worker restarts. But a
  team that already wrote a dynamic workflow must rewrite it as YAML to get
  that. Much real JavaScript does not map to a graph (computed prompts,
  memoized agent calls, results that are `null` on failure).
- If we add a second engine carelessly, we get two products under one name:
  two tool sets, two run lists, two test stories.

## Goals

1. **One concept, several kinds.** A Workflow has a kind. Everything a
   person or a chat touches is shared across kinds.
2. **No change to today's Workflows.** The YAML language, its compiler, its
   controller, its view and its tests stay as they are. Existing runs replay
   unchanged.
3. **Copilot's semantics, as documented.** The author's code runs as written.
   A step journals by key. Steps run at least once. Identical agent calls are
   memoized. A failed agent call gives `null`. On resume, the workflow starts
   again from the top and reuses the journal [S15].
4. **Server-side durability.** A dynamic run survives worker restarts,
   waits for days, and resumes from the portal or the chat.
5. **Visible agents.** Each agent call is a child chat that people can read,
   as agent steps are today.
6. **Tests.** A chat can test a dynamic definition with prepared answers.

## Non-Goals

- Any change to PR 270.
- Compiling JavaScript into the YAML graph (see
  [Rejected alternatives](#rejected-alternatives)).
- Running in, or changing, the Copilot clients.
- The rest of a Copilot extension: its tools, hooks, slash commands and
  canvases. Only `defineWorkflow` and the workflow `ctx` are in scope.
- Nested workflows. Copilot's `ctx.workflow(...)` always rejects [S15], and
  so would ours.
- An AI-credit meter in the first version.

## Background

### Durable Workflows today

- A chat saves a definition with `workflow_definition save`. Each save is a
  new revision (tables `workflow_chat_definitions` and
  `workflow_chat_revisions`, migration 0107). Start makes a Workflow from one
  revision.
- The controller is one durable orchestration per run
  (`workflow-v2-controller` 1.9.0 in `packages/sdk/src/workflow/v2/runtime.ts`).
  Each visit of a state is a row in PostgreSQL. The run records the
  controller version it started at (`workflow_runs.controller_version`,
  migration 0100).
- An agent state runs an ordinary child chat (`WorkflowAgentNodeHost`). The
  chat finishes the state only with `complete_workflow_node` and a result
  that matches the state's schema. Three invalid completions fail the state.
- A request state asks a chat for a typed answer before a deadline. The chat
  answers with `respond_session_request`.
- `workflow_definition test` runs a revision with prepared answers
  (fixtures) on a hidden test bench.
- A package can ship definitions as `workflows/<name>/workflow.yaml` with an
  interface card, `card.md` (`WorkflowCard` in
  `packages/sdk/src/workflow/v2/package-card.ts`).

### Copilot dynamic workflows

All from public documentation, fetched 2026-11-08 [S12, S13, S14, S15]:

- An extension's `extension.mjs` calls `defineWorkflow({ meta, run })`.
  `meta` has `name`, `description`, `phases`, an optional `argsSchema` and
  optional `limits`.
- `run(ctx)` uses `ctx.step(key, producer)`, `ctx.agent(prompt, options)`,
  `ctx.parallel`, `ctx.pipeline`, `ctx.pause(key)`, `ctx.phase`, `ctx.log`,
  `ctx.args` and `ctx.signal`.
- `ctx.step` journals a JSON result under its key. The key is the only
  identity. Producers are "best-effort at-least-once".
- `ctx.agent` calls are journaled by their canonical prompt and options.
  Identical calls share one subagent. An ordinary failure resolves to `null`.
- On resume, "the workflow starts again" and reuses journaled work. A run
  whose runtime disappears becomes `halted` and can be resumed.
- Limits: `maxConcurrentSubagents`, `maxTotalSubagents`, `timeoutSeconds`
  (active time) and `maxAiCredits`. A run stopped at a limit can be resumed
  with a raised limit.
- The SDK API is experimental, and the feature is in public preview.

## Design

### 1. What is shared and what is per kind

**Shared by every kind.** These already exist and do not depend on YAML.

| Concern | Where it lives today | Why every kind can use it |
|---|---|---|
| Definitions owned by a chat, with revisions | `workflow_chat_definitions`, `workflow_chat_revisions` (migration 0107) | Only the `yaml` and `ir` columns are language-specific. Identity, revision chain, validity and diagnostics are not. |
| Runs | `workflow_runs` (migrations 0089, 0100, 0110) | A run of any kind is one durable orchestration at one version, with inputs, a status and an end. |
| Run status | admitted, running, paused, completed, failed, cancelled, stopped (`store.ts`) | Copilot's statuses map onto it: `error` to failed, `halted` to a run that shows `needsRecovery`, the rest by name. |
| End notice to the chat | `notify_on_completion` | Copilot's `notifyOnComplete` is the same idea [S15]. |
| Agent steps as child chats | `WorkflowAgentNodeHost`, `complete_workflow_node` | `ctx.agent` needs exactly this: a child, a typed result, correction turns and a model choice. |
| Requests | `request-service.ts`, `respond_session_request` | `ctx.pause` is a request to the chat plus a Resume control. |
| Tools | `workflow_definition`, `update_workflow`, `read_workflow`, `send_workflow_input` | Only the `yaml` argument of `save` names a language. |
| Workflow tab shell | `WorkflowRunView` in `packages/app/ui/react/src/workflow-tab.js` | The header, run picker, Stop dialog, Log, Revisions and Test panels are not shape-specific. Only the graph pane and Node panel are. |
| Events | `workflow.started`, `workflow.state_*`, `workflow.agent_spawned`, `workflow.paused`, `workflow.completed` and others | The Log is built from them, and a dynamic run can emit the same names. |
| Test bench | the `workflow-test` service session, fixtures, the virtual clock | "Answer the brokered calls; run the author's own code for real" fits every kind. |
| Platform limits | a 30-day run deadline, 256 KB payloads, the nesting rule | These are platform caps, not graph caps. |
| Packages and cards | `workflows/<name>/` plus `card.md` | A card describes an interface, not a language. |

**Different for each kind.**

| Concern | State-machine kind (today) | Dynamic kind (proposed) |
|---|---|---|
| Source | YAML (`apiVersion: pilotswarm.dev/v2-draft`, `kind: Workflow`), at most 256 KB and 100 states | One JavaScript module that calls `defineWorkflow` |
| Validation | Compiled to an IR graph | Parsed; `meta` checked; the interface extracted; no graph |
| Orchestration | The controller plus effect, send, request and agent orchestrations | One new host orchestration |
| Plan | The IR: states, routes, limits | The source hash, `meta` and the journal |
| Read model | `graph` | `phases`, `progress`, `agents`, `journal`, `pause` |
| View | Graph pane, Node panel, Variables | A Phases pane (section 5) |
| Run state | Variables (`set_vars`) | None. `ctx.args` is read-only, and journal values are not variables. |
| Fan-out | 64 items, 16 at once | Copilot allows 4,096 items [S15]. The host caps running children by `maxConcurrentSubagents` and a platform ceiling. |

### 2. The `WorkflowKind` boundary

A kind is a module that gives the shared service a small, fixed set of
functions. The sketch below shows the shape. All names are proposals.

```ts
// Sketch only. Kind ids are proposals.
export type WorkflowKindId = "state-machine" | "dynamic";

export interface WorkflowKind<Plan = unknown> {
    readonly id: WorkflowKindId;
    /** The source language, for editors, package file names and diagnostics. */
    readonly source: { language: "yaml" | "javascript"; fileName: string; maxBytes: number };
    /** The orchestration new runs start at, and the worker tags its activities carry. */
    readonly orchestration: { name: string; version: string; activityTags: readonly string[] };
    /** Versions this build still replays, and versions it fences with a visible failure. */
    readonly replayable: readonly string[];
    readonly unsupported: readonly string[];
    /** The main pane the portal draws. */
    readonly view: "graph" | "phases";
    /** The run controls this kind honours; the service refuses the others in words. */
    readonly controls: ReadonlySet<"pause" | "resume" | "cancel" | "stop" | "recover" | "set_vars">;

    /** Validate and plan. Pure: no I/O, and never runs author code. */
    compile(sourceText: string, options: KindCompileOptions): KindCompileResult<Plan>;
    /** The machine half of an interface card: inputs, output, ways to end, asks, sends. */
    interfaceOf(plan: Plan): WorkflowCardInterface;
    /** The orchestration input for a new run of this plan. */
    startInput(run: WorkflowRunRow, plan: Plan): unknown;
    /** Register the kind's orchestrations and activities with the worker. */
    register(runtime: WorkflowActivityRuntime, deps: WorkflowRuntimeDeps): void;
    /** The kind's half of read_workflow for one run; the service adds the shared half. */
    readRun(store: WorkflowStore, run: WorkflowRunRow, plan: Plan, options: WorkflowReadOptions): Promise<JsonObject>;
    /** Which brokered calls a test can answer, and how a fixture matches one. */
    readonly test: { operations: readonly string[]; match(fixture: WorkflowTestFixture, call: InterceptedCall): boolean };
}

export interface KindCompileResult<Plan> {
    valid: boolean;
    diagnostics: WorkflowDiagnostic[];
    sourceSha256: string;      // today: yaml_sha256
    planSha256: string | null; // today: ir_sha256
    name: string | null;
    version: string | null;
    plan: Plan | null;
}

/** The kind of a stored row; a row written before the column existed is a state machine. */
export function kindOf(row: { kind?: string | null }): WorkflowKind;
```

**Much of today's code already fits this shape.**

| Today | Becomes |
|---|---|
| `compileWorkflowV2` (pure) | the state-machine kind's `compile` |
| `registerWorkflowV2` | its `register` |
| `controllerVersionFor`, `requireRunsController` | `orchestration` and `replayable` |
| the `graph` part of `readOverview` (`tools.ts`) | its `readRun` |
| `workflowCardInterface` | its `interfaceOf` |
| fixtures and interceptions | `test.match` |

**What has to move.** The callers of `compileWorkflowV2ForHost`, the places
that read `graph`, the package loader's `workflow.yaml` file name, and the
view projection, which today refuses any shape but the graph
(`projectWorkflowV2` in `packages/app/ui/core/src/workflow-v2-view.js`). The
`yaml` argument of `workflow_definition save` gains a `source` alias. It is
not renamed: the Workflow skills and many prompts use it.

**Registration and versions.** The worker registers each kind's
orchestrations. Each kind keeps today's version policy: a run records the
orchestration version it started at, a build refuses to touch a run it
cannot replay, and old versions are registered as fences that fail visibly
and leave `needsRecovery`.

### 3. Choosing a kind

- `workflow_definition save` takes an optional `kind`. Without it, the
  service infers it. A source that starts with the YAML header
  `apiVersion: pilotswarm.dev/...` is a state machine. A source that imports
  the Copilot extension module or calls `defineWorkflow` is dynamic.
  Anything else is refused in words.
- The kind is stored on the revision (a new column with a default), copied
  to the Workflow's pinned copy and to each run. A run of kind K starts K's
  orchestration.
- `read_workflow` returns `kind` at the top, so the portal and the skills
  can choose the view.

### 4. The dynamic kind: a re-run host

#### The loop

Durable orchestrations must be generators that replay deterministically
(see the `duroxide` package README). Copilot workflow code is ordinary
`async` JavaScript and is not written to be deterministic. So the host never
replays the author's code. It replays only its own loop:

1. Run one **attempt**: an activity that starts a guarded child process,
   loads `extension.mjs` with a stub of the Copilot extension module, and
   calls `run(ctx)` with the journal preloaded.
2. Inside the attempt:
   - `ctx.step(key, producer)`: return the journaled value, or run the
     producer, store the value (first writer wins) and return it.
   - `ctx.agent(...)`: return the finished result, or record the call as
     pending and never resolve.
   - `ctx.pause(key)`: return if the pause was passed, or record it as
     pending and never resolve.
   - `ctx.parallel` and `ctx.pipeline`: Copilot's rules, including `null` on
     failure and the 4,096-item cap.
3. The attempt ends when `run()` returns (the run is done), or when only
   pending agent calls and pauses are left (the attempt reports them).
4. If the run is done, the host ends it through the shared end path and
   tells the chat.
5. Otherwise the host starts a child chat for each new pending agent call,
   then waits durably for any child result, a Resume, the deadline, a cancel
   or a stop.
6. It writes the results into the journal and runs the next attempt.
7. After a set number of rounds or idle waits it continues as new, carrying
   only the run id, as the controller does today.

This matches Copilot's documented behaviour: on resume "the workflow starts
again" and reuses journaled work [S15].

#### The journal

The journal does not fit in the orchestration's own key-value store, which
holds at most 150 keys of at most 64 KB each (`MAX_KV_KEYS`,
`MAX_KV_VALUE_BYTES` in the `duroxide` package). It goes in new, additive
tables. Names are sketches:

```text
workflow_dyn_journal  (run_id, entry_key, entry_kind step|agent|pause, value, value_sha256, bytes, round, created_at)
                      PRIMARY KEY (run_id, entry_key)   -- first writer wins
workflow_dyn_progress (run_id, seq, kind phase|log|limit, text, phase_id, created_at)
workflow_dyn_agents   (run_id, agent_key, node_execution_id, label, prompt_sha256, options, state, created_at)
```

- Keys follow Copilot's rules. A step's key is `step:` plus the author's
  key. An agent call's key is `agent:` plus a hash of its canonical prompt
  and options, label included, so identical calls share one result [S15].
  A pause's key is `pause:` plus the author's key.
- Caps: one value at most 256 KB (today's payload cap), one run's journal at
  most 16 MB, progress at most 10,000 lines. Past a cap the run fails and
  names the key.

#### Agent calls become ordinary agent steps

For each pending `ctx.agent` call, the host writes the same rows the
controller writes for an agent state: a node execution and an agent
invocation. Then today's code does the rest, unchanged:

- The child chat starts through the existing agent orchestration, with a
  stable id, so a retry after a crash finds the same chat.
- The child finishes with `complete_workflow_node`. Its output is checked
  against the call's schema. After three invalid completions the author gets
  `null`. Copilot sends up to two correction turns [S15]; the docs must say
  that PilotSwarm takes one more.
- The call's `model`, `reasoningEffort` and `contextTier` are checked
  against the owning chat's model catalog. A refused model fails the attempt
  in words. It never silently becomes `null`.
- A named custom agent (`agent`) resolves and is pinned as package agents
  are today.
- The Log, the read-only agent chat, the end of children when the run ends,
  and the nesting rule all work because the rows exist.

Copilot accepts a JSON Schema subset and treats `oneOf` as `anyOf` [S15].
PilotSwarm checks full JSON Schema 2020-12. The shim would rewrite `oneOf`
to `anyOf` and keep the rest strict.

#### A pause becomes a request plus a Resume button

- `ctx.pause(key)` becomes a request to the owning chat with a fixed
  contract (for example `DynamicPause@1`). Its payload is the key, the
  phases and the latest progress lines. It has no request deadline of its
  own; the run deadline still applies.
- The portal shows "Paused at `<key>`" with **Resume**.
- Resume comes either from the chat's `respond_session_request` or from
  `update_workflow resume`. Both write `pause:<key>` to the journal and wake
  the host.
- An outside pause (Copilot's `session.workflow.pause`) is today's `pause`
  command: the host starts no new child and lets the current attempt finish.

#### Limits

| Copilot limit [S15] | In the host |
|---|---|
| `maxConcurrentSubagents`: a queue | At most N pending agent calls run at once; the rest wait. A platform ceiling applies (16 today for a parallel state). |
| `maxTotalSubagents`: a total cap | The count of agent rows. Past it the run fails with the limit named. |
| `timeoutSeconds`: active time only | The host sums attempt time and agent wait time while not paused. The run deadline (wall clock, at most 30 days) stays the hard outer bound. |
| `maxAiCredits` | Phase 3, with a credit meter. Until then `compile` refuses it with a diagnostic. |
| Resume with a raised limit | Today a finished run cannot be resumed. A limit stop would leave the run paused with a reason, and Resume would take the raised limits. This is an open question. |

#### What runs twice

- Only the host loop is replayed. Each round: one attempt, zero or more
  child starts, one durable wait and journal writes.
- A `ctx.step` producer can run twice after a crash. The first stored value
  wins. That is Copilot's "best-effort at-least-once" [S15].
- Code outside `ctx.step` runs again in every attempt, as it does in
  Copilot.
- **Knowing when an attempt is idle.** The stub counts the open `ctx`
  promises. When `run()` has not returned, every open promise is a pending
  agent call or pause, and the event loop has drained, the attempt reports
  its pending set and exits. If the author awaits a timer or the network
  while an agent call is pending, the attempt waits for that, up to the
  script limit (3,600 seconds), and the next round runs again. This is the
  one place where the host is weaker than Copilot's in-process runtime. The
  docs must say: while agents run, await only `ctx` calls.

### 5. The run view

**Shared with every kind:** the header (name, version, revision, validity,
hash), the status, the run picker, Pause, Stop and Cancel with the one Stop
dialog, the Log, the Revisions compare (sources side by side), the Test
panel, the session-list row and the read-only agent chat.

**The Phases pane (dynamic kind only).**

| Part | What it shows |
|---|---|
| Phase strip | `meta.phases` in order, the current one marked. A phase that `ctx.phase` sets but `meta` does not declare is added, with a quiet warning. |
| Progress | `ctx.log` lines, newest first, each with its phase; repeats collapse. |
| Agents | One card per agent call: label, state (pending, running, done, `null`), model, deadline and "Open the agent's chat". A count such as "3 running, 5 waiting". |
| Journal | Step keys with size, the round that wrote each and a "replayed on resume" mark. A value opens where the Node panel is today. |
| Paused card | "Paused at `review-ready` since 14:02" with **Resume**, and the chat's answer when one came. |

There is no Variables panel; `ctx.args` shows read-only with the run's
inputs. `read_workflow` returns `kind: "dynamic"`, `graph: null` and a
`dynamic` block (phases, current phase, paged progress, agents, journal keys,
pause, declared and used limits), plus the same `runs` and `run` blocks as
today.

### 6. Tests

Today a test runs one revision on a hidden test bench, answers each brokered
call from a fixture, and runs scripts for real. The dynamic kind keeps that
shape: a **fake `ctx`** with prepared answers.

```yaml
fixtures:
  - { operation: agent, state: "Review src/a.ts", response: { kind: success, value: "Looks fine." } }
  - { operation: agent, state: "finder:*", response: { kind: success, value: { issues: [] } } }
  - { operation: pause, state: review-ready, response: { kind: success } }
  - { operation: tool.call, tool: read_facts, response: { kind: success, value: [] } }
```

- `state` names the agent call's `label` (a `*` matches a prefix) or the
  pause key.
- The attempt runs with the same stub. The endpoint answers pending agent
  calls and pauses from fixtures instead of starting chats. `ctx.step`
  producers run for real, as scripts do. So a test exercises the author's
  real control flow and the real journal rule.
- A call with no prepared answer fails the test and names the call, as
  today.
- The report lists the agent calls answered, the pauses passed, the journal
  keys written and the phases visited. Passed means the run completed.
- Only pauses are durable waits in this kind, so the virtual clock matters
  little. A `setTimeout` in the author's code is real time.

### 7. Security and trust

| Risk | Control today | Addition for the dynamic kind |
|---|---|---|
| Third-party JavaScript on a worker | The script guard in `packages/sdk/src/workflow/runner.ts`: Node `--permission` with file access only in its own folder, no child processes, worker threads or native addons; only `PATH` and locale variables from the worker's environment; its own process group, killed on stop | Run attempts only on workers with a dedicated tag (a worker carries at most five tags in `duroxide`). Never load `node_modules` beyond the stub. |
| Network | The guard does not limit the network. The shipped worker templates deny the instance metadata address. | Keep it. Document that credentials never reach the code. |
| Tool access | Scripts call the chat's permitted tools, minus control tools (`packages/sdk/src/workflow/tool-policy.ts`) | The same policy per attempt; call counts carry across a run's rounds. |
| The extension's own session | — | `ctx.session` refuses everything except a few read-only calls. `ctx.workflow` rejects. `ctx.signal` fires on cancel or stop. |
| Prompts | A child's first prompt is sent as the workflow, never as a person; inline prompts are at most 32 KB | The same for `ctx.agent` prompts. |
| Package trust | Cards are checked against the definition at publication; package agents are pinned | A package may carry `workflow.mjs` only when the deployment allows the dynamic kind. Publication records the source hash. The card says the kind, so a chat knows it starts code. |
| Resource abuse | A 30-day run deadline, the child budget per chat | A platform cap on total agent calls, the journal and progress caps, the 3,600-second attempt cap. |
| Secrets in stored text | Redaction before storage (`redact.ts`) | The same for journal values and progress lines. |

The Copilot API is experimental [S15]. The shim should check in a small
fixture of the surface it supports (method, option, limit and status names).
A unit test fails when the shim exposes a name that is not in the fixture.
`read_workflow` reports which documented surface a run was written against.

### 8. Formal verification (TLA+)

**Reuse.** `docs/formal/workflow-v2/` already models run lifecycle and
early cancel, session commands, agent children and the chat's queue, and the
request exchange. They apply unchanged, because the host uses the same rows
and commands.

**New: one module for the host loop.** It would model:

- an attempt that starts and crashes midway, so a producer runs twice and
  the first stored value wins;
- the idle check that reports a pending set;
- a child start with a stable id, raced against the deadline;
- the pause request and its two resume paths;
- cancel and stop during an attempt;
- continue-as-new that carries only the run id.

Invariants: a journal key has one value for the life of the run; an agent
call starts at most one child; a finished run has no pending child. Liveness:
every pending item is started, or the run ends. Cases: a crash before and
after the write, a duplicate wake, a lost wake with the backstop timer, a
limit reached mid-round. Out of scope: admission and variables, receive,
send and fork-join, which this kind does not use.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **Compile `.mjs` into the YAML graph.** One engine. | It covers only a subset of JavaScript. Memoization, `null` on failure, per-call models, computed prompts, more than 64 items and parallel inside a pipeline are lost. It drifts silently from Copilot, and people debug a graph they did not write. It may come back later as an optional assistant ("turn this run into a graph"), not as an engine. |
| **Client-side only.** Import and export files. | It gives up what PilotSwarm adds: durability on the server for days, resume from the portal, agents as chats. Useful only as a bridge if this plan is not funded. |
| **Run `run()` as the orchestration itself.** | Orchestrations must be deterministic generators. Copilot code is `async` and not deterministic. Copilot keys its journal by name, not by position. |
| **Keep the journal in the orchestration's key-value store.** | At most 150 keys of 64 KB each. A real run's journal is larger. |
| **Add a kind field or seam to PR 270.** | PR 270 should stay focused. Every change here can be added later: new columns with defaults, a new orchestration name, a new optional argument. Renaming `yaml` would break the skills and prompts that use it. |

## Phases

| Phase | Content | Rough size | Depends on |
|---|---|---|---|
| 0 | PR 270 ships unchanged. Nothing for this plan. | — | — |
| 1. Kind boundary | The `WorkflowKind` interface and registry. The state-machine kind wraps today's code with no change in behaviour. `kind` columns (default: state machine) and `read_workflow.kind`. `save` takes `kind` and `source`. The view dispatches on `kind`. A "Kinds" section in the guide. Zero-diff tests on the read model and tool receipts. | about 1 week | PR 270 merged |
| 2. Dynamic host, first version | The host orchestration with tagged activities. The stub and the shim under the guard. The three tables. Agent calls through agent steps. Pause as a request with Resume. Limits except credits. The Phases pane. Fixtures and the fake `ctx`. The TLA+ module and its cases. The API surface fixture. | about 3 weeks | Phase 1; a worker tag for attempts |
| 3. Packages and authoring | `workflow.mjs` in packages, with the kind on the card. Authoring guidance for models. Upload and a JavaScript mode in the portal editor. The credit meter and `maxAiCredits`. Resumable limit stops. | about 2 weeks | Phase 2 |
| 4. Optional bridges | An assistant that turns a dynamic run into a graph draft, checked on the test bench. Export of a state-machine definition as `.mjs`. | about 1 week each | Phase 2 |

**Main risks.** The idle check depends on author code that awaits timers;
the attempt cap bounds it, and the docs must say so. The Copilot API is in
preview and may change; the surface fixture makes that visible. Three
invalid completions against Copilot's two correction turns, and strict
schemas against Copilot's subset, are documented differences. Untrusted code
runs under the same guard scripts use today, on tagged workers. A resumable
limit stop changes today's rule that a finished run cannot be resumed; it is
scoped to this kind.

## Open questions

1. Should `ctx.agent` children show in the session list as read-only chats,
   as agent steps do today, or stay hidden, as Copilot hides them? The
   proposal says visible.
2. Should agent results be checked against strict JSON Schema 2020-12 (with
   `oneOf` rewritten to `anyOf`), or against Copilot's exact subset?
3. Does the first version need `maxAiCredits`, or may it refuse it in words
   until the meter exists?
4. Should `ctx.pause` be a request to the chat plus a portal Resume, or a
   portal Resume only? The proposal says both, because the chat owns the
   run.
5. May packages carry `workflow.mjs` from the start, or only chat-written
   code first? The proposal says chat-written first, packages in phase 3
   behind a deployment switch.
6. Should a run stopped at a limit be resumable with raised limits, as in
   Copilot? That means a paused end with a reason, not `failed`.
7. Copilot forbids nested workflows. PilotSwarm lets an agent child delegate
   one more level. Should `ctx.agent` children keep PilotSwarm's depth rule?
8. Should the dynamic kind reach users before the graph assistant exists,
   given that its runs have no graph?

## Sources

Public documentation, fetched 2026-11-08:

| Id | Page |
|---|---|
| S12 | [About dynamic workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/dynamic-workflows) |
| S13 | [Using dynamic workflows](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows) |
| S14 | [Copilot SDK: extensions (Node.js)](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/docs/extensions.md) |
| S15 | [Copilot SDK: workflows (Node.js)](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/docs/workflows.md) |

Repository:

- `packages/sdk/src/workflow/v2/`: `compiler.ts`, `runtime.ts`, `store.ts`,
  `service.ts`, `tools.ts`, `agent-host.ts`, `agent-node-service.ts`,
  `request-service.ts`, `package-card.ts`, `test-bench.ts`, `test-mode.ts`,
  `redact.ts`.
- `packages/sdk/src/workflow/runner.ts` and `tool-policy.ts`: the script
  guard and tool policy.
- `packages/sdk/src/migrations/workflow-v2-0089.ts` to `workflow-v2-0110.ts`:
  the tables.
- `packages/app/ui/react/src/workflow-tab.js` and
  `packages/app/ui/core/src/workflow-v2-view.js`: the Workflow tab and its
  projection.
- `docs/formal/workflow-v2/`: the TLA+ models.
- The `duroxide` npm package (README, `lib/duroxide.js`): generator
  orchestrations, the key-value limits and worker tags.
