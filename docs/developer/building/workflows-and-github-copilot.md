# Workflows and GitHub Copilot

## Are we re-inventing what GitHub Copilot already supports?

Mostly no. PilotSwarm is a durable runtime for GitHub Copilot SDK agents.
Its Workflows build on those agents; they do not replace them. GitHub uses the
word "workflow" for three features: GitHub Actions workflows, GitHub Agentic
Workflows and Copilot dynamic workflows. Each one overlaps with part of a
PilotSwarm Workflow. But none of them, as GitHub documents them today, does
all of this in one run: run on a server, mix code steps with agent steps,
survive a restart midway, and wait inside the run for a message, an answer
or a timer.

Ids in brackets, such as [S12], point to the public GitHub pages listed
under [Sources](#sources), all fetched on 2026-11-08.

**What overlaps.**

- **Code steps around agent steps.** Agentic Workflows put fixed steps around
  one agent job [S4, S6]. Dynamic workflows mix code with `ctx.agent` calls
  [S12, S15]. A Workflow mixes `script` states with `agent` states.
- **Branching, fan-out and join.** Actions has `needs`, `if:` and matrices
  [S19]. Dynamic workflows have code conditions, `ctx.parallel` and
  `ctx.pipeline` [S15]. A Workflow routes by named outcome and has
  `parallel` states.
- **Human approval.** All three GitHub features document a form of it:
  Actions environments [S20], the Agentic Workflows `manual-approval` gate
  [S7] and the dynamic workflow pause checkpoint [S12, S15]. A Workflow
  uses a `request` state.
- **Pause and resume.** A dynamic workflow journals its steps and resumes a
  paused or halted run [S15]. A Workflow can be paused and resumed too.
- **Typed agent results.** A dynamic workflow's agent call can return JSON
  that matches a schema [S15]. A Workflow's agent step must return output
  that matches its schema.

**What PilotSwarm adds.**

- **Durability on the server.** A Workflow runs on PilotSwarm workers, not
  in a person's client. Its state is in PostgreSQL and in a durable
  orchestration. After a worker restart it goes on where it was. A run can
  last for days; its optional deadline can be up to 30 days. A dynamic
  workflow runs in the user's Copilot client (Copilot CLI, the Copilot app or
  a Copilot SDK host), and its run belongs to the session that owns it
  [S12, S14, S15].
- **A state machine with loops and named outcomes.** Each state reports an
  outcome, and a route names the next state. Loops are allowed and bounded.
  The GitHub documentation read describes none of the three features this
  way.
- **Waiting inside a run.** A Workflow can wait for a typed message
  (`receive`), for a typed answer from a chat before a deadline (`request`),
  or for a time span or a clock time (`wait`). The GitHub documentation read
  does not describe a wait for an incoming message inside a run for any of
  the three.
- **Agent steps as child chats.** Each agent step runs as an ordinary
  PilotSwarm chat that people can open and read. It ends only with a result
  that matches its schema. In dynamic workflows, workflow-owned subagents are
  hidden from `read_agent` and `write_agent` [S15].
- **Requests to people through their chat.** A `request` state asks a chat,
  usually the one that started the Workflow, for a typed answer or a decline
  before a deadline. The chat answers once, with `respond_session_request`;
  when a person must decide, the chat asks them first.
- **Packages.** An agent package can ship Workflow Definitions with an
  interface card. People pick them in the new-session picker, and chats
  start them by name.
- **Tests with fixtures.** When a person asks, a chat tests a revision.
  Prepared answers stand in for tool calls, agent steps, sends and requests,
  and waits pass at once on a virtual clock. Scripts run for real.
- **Revisions.** Each save is a new revision that never changes. A running
  Workflow keeps the revision it started with.

**What GitHub has and Workflows do not.**

- **Event triggers.** A Workflow starts only when a chat or a person starts
  it. There are no repository-event, webhook or cron triggers. A repeated
  check is one Workflow that loops through a `wait` state.
- **Build infrastructure.** Actions has runners, containers, the Actions
  marketplace, secrets and artifacts [S18, S19].
- **Agent guardrails.** Agentic Workflows are read-only by default, write
  only through safe outputs, scan proposed outputs for threats and run the
  agent behind a network firewall [S1, S4]. A Workflow script's guard is not
  a network sandbox.
- **The Copilot clients.** Dynamic workflows run inside Copilot CLI, the
  Copilot app and Copilot SDK hosts [S12].

So PilotSwarm reuses Copilot for the agents. Workflows add what the GitHub
features, as documented, do not have together: durable runs on the server
that mix code, waits, people and agents for hours or days.

## Feature comparison

The GitHub facts come from public GitHub documentation, fetched on
2026-11-08 (see [Sources](#sources)). The PilotSwarm facts come from this
repository: [Durable workflows](./workflow-sessions.md), the Workflow skills
in `packages/sdk/plugins/workflow/skills/` and the source in
`packages/sdk/src/workflow/`. "Not stated" means the documentation read
does not say. It does not mean the feature is missing.

| | PilotSwarm Workflow | GitHub Actions workflow | GitHub Agentic Workflow | Copilot dynamic workflow |
|---|---|---|---|---|
| Definition | YAML state machine (`kind: Workflow`), saved by a chat as revisions | YAML jobs and steps in `.github/workflows` [S18] | Markdown with YAML frontmatter, compiled to a `.lock.yml` Actions workflow [S1, S3] | JavaScript in a Copilot extension (`defineWorkflow`) [S14, S15] |
| Who writes it | The chat's agent, from a person's description; a person can edit the YAML in the Workflow tab; a package can ship it | A person [S18] | A person, or an agent at authoring time [S3] | Copilot from a description, you, or someone who shared it [S12] |
| Where it runs | PilotSwarm workers (server side) | GitHub-hosted or self-hosted runners [S18] | Actions runners; the agent in a sandbox [S4] | The user's Copilot client: CLI, app or SDK host [S12, S14] |
| How it starts | A chat's `workflow_definition start`, or a person's Start in the portal; no event triggers | Events, schedules, manual dispatch [S18, S22] | Actions triggers, plus slash commands [S7] | A prompt, `copilot workflow run`, an extension command or the SDK [S12, S13] |
| Shape | States with named outcomes and routes; loops allowed and bounded | Jobs linked by `needs` [S19] | Compiled jobs; the model decides inside the agent job [S4, S5] | Code: sequence, `ctx.parallel`, `ctx.pipeline` [S15] |
| Model use | Agent states only; scripts, waits and messages run without a model | No model step in the docs read | One agent job, with fixed steps around it [S4, S6] | `ctx.agent` calls; the rest is code [S12] |
| Waiting inside a run | `wait` (seconds or a clock time); `receive` (a typed message, with an optional time limit); `request` (a typed answer before a deadline) | Environment approvals and wait timers [S20] | A `manual-approval` gate before the run [S7]; mid-run waits not stated | `ctx.pause` checkpoints; input when the client supports it [S12, S15] |
| Fan-out and join | `parallel`: up to 64 items or named branches, up to 16 at once; join all or the first k | Matrix up to 256 jobs; `needs` as the join [S19, S23] | Actions jobs; dispatch or call other workflows [S9] | `ctx.parallel` and `ctx.pipeline`, up to 4,096 items [S15] |
| Durability | Durable orchestration plus PostgreSQL; survives worker restarts; scripts run at least once | Re-run a run, its failed jobs or one job [S24] | Actions rules; mid-run resume not stated [S9] | Journal (`ctx.step`), pause, resume by run ID, halted runs resumable; steps at least once [S15] |
| Run length | No time limit by default; an optional deadline of up to 30 days; a wait of `seconds` is at most a day, so longer waits use a loop | 35 days per run; 6 hours per hosted job [S23] | Defaults: 20 minutes for the agent step, 60 for the agent job [S8] | No default limit; `timeoutSeconds` counts active time [S12, S15] |
| Agent visibility | Each agent step is a read-only chat that people can open | No agent step in the docs read | Not stated | Workflow-owned subagents hidden from `read_agent` and `write_agent` [S15] |
| Testing | `workflow_definition test` with fixtures and a virtual clock | Not stated | Not stated | Not stated |
| Sharing | Agent packages, with interface cards | Repository files [S18] | Repository files [S3] | Copy the extension folder, or publish a plugin [S12, S13] |
| Permissions | Scripts use the starting chat's permitted tools; agent steps are ordinary agents, optionally limited to listed tools | Environment gates; secrets after approval [S20] | Read-only by default; writes through safe outputs [S1] | Subagents inherit the session's grants; extension code runs outside the prompts [S12] |
| Status | Available in PilotSwarm, which is itself experimental; `apiVersion: pilotswarm.dev/v1` | Generally available | Generally available since 2026-10-28 [S11] | Public preview; the SDK API is experimental [S12, S15] |

## When to use which

- **GitHub Actions** for CI/CD on repository events: build, test, deploy,
  label. It brings runners, containers, secrets and the marketplace.
- **GitHub Agentic Workflows** for repository automation where an agent
  reads the repository and proposes changes under read-only defaults and
  safe outputs, started by GitHub events or schedules.
- **Copilot dynamic workflows** when you work in a Copilot client and want a
  scripted, repeatable multi-agent task that you watch and resume from that
  client.
- **A PilotSwarm Workflow** when a chat hands off a finite procedure that
  runs on the server for minutes to days. It fits work that mixes scripts,
  agent judgment, waits, typed messages and requests to people, that must
  survive restarts, and that people should be able to follow as a graph
  while it runs.

They also combine. A Workflow's script can call any tool its chat may use,
including one that starts a GitHub Actions run. A `receive` state can then
wait until the chat passes the result in with `send_workflow_input`.

## Copilot dynamic workflows: a possible future integration

Copilot dynamic workflows run on the client side: in Copilot CLI, the Copilot
app or a Copilot SDK host [S12, S14]. A journal lets a paused or halted run
resume, and the run belongs to the session that owns it [S15].

PilotSwarm already has infrastructure that could make such runs durable on
the server:

- orchestrations that run on workers and survive restarts;
- agent steps that run as child chats with typed results;
- requests that ask a chat, and through it a person, for an answer and
  wait for it;
- packages that ship Workflow Definitions with an interface card;
- tests that answer agent steps and requests from prepared answers.

This is a possibility, not a commitment. PilotSwarm does not run dynamic
workflows today, and no design has been accepted. A
[proposal](../../proposals/dynamic-workflow-kind.md) sketches one possible
future plan.

## Sources

GitHub documentation, all fetched on 2026-11-08:

| Id | Page |
|---|---|
| S1 | [About GitHub Agentic Workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows) |
| S3 | [Creating GitHub Agentic Workflows](https://docs.github.com/en/copilot/how-tos/github-agentic-workflows/creating-github-agentic-workflows) |
| S4 | [gh-aw: Architecture](https://github.github.com/gh-aw/introduction/architecture/) |
| S5 | [gh-aw: Overview](https://github.github.com/gh-aw/introduction/overview/) |
| S6 | [gh-aw: Frontmatter reference](https://github.github.com/gh-aw/reference/frontmatter/) |
| S7 | [gh-aw: Triggers](https://github.github.com/gh-aw/reference/triggers/) |
| S8 | [gh-aw: Cost management](https://github.github.com/gh-aw/reference/cost-management/) |
| S9 | [gh-aw: Safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/) |
| S11 | [GitHub Agentic Workflows are generally available](https://github.blog/changelog/2026-10-28-github-agentic-workflows-generally-available/) |
| S12 | [About dynamic workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/dynamic-workflows) |
| S13 | [Using dynamic workflows](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-dynamic-workflows) |
| S14 | [Copilot SDK: extensions (Node.js)](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/docs/extensions.md) |
| S15 | [Copilot SDK: workflows (Node.js)](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/docs/workflows.md) |
| S18 | [Actions: Workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows) |
| S19 | [Actions: Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) |
| S20 | [Actions: Reviewing deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments) |
| S22 | [Actions: Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| S23 | [Actions: Limits](https://docs.github.com/en/actions/reference/limits) |
| S24 | [Actions: Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) |

PilotSwarm, in this repository:

- [Durable workflows](./workflow-sessions.md): the guide.
- `packages/sdk/plugins/workflow/skills/`: what models read (fields,
  run semantics, tools, patterns).
- `packages/sdk/src/workflow/compiler.ts`: state types and limits (100
  states, 64 parallel items, 16 at once, a 30-day run deadline).
- `packages/sdk/src/workflow/runtime.ts` and `store.ts`: the controller,
  durability and delivery.
