# Changelog — agent-manager

## 1.7.0

### Changed

- Any session may start any package Workflow its owner can see. An agent's
  `workflows:` list now suggests definitions to its session; it no longer
  limits what the session may start. A Workflow-only package can be verified
  by starting it directly from Agent Smith's own session.

## 1.6.0

### Changed

- `propose_agent_patch` checks the staged package exactly as publish checks
  it. When publish would refuse it, nothing is proposed: the answer lists each
  error's code, path and message, and Agent Smith fixes them and proposes
  again, so no person is asked to approve a package that publish would refuse.

## 1.5.0

### Changed

- A Workflow Definition's card is written from an exact template that matches
  the publish check: front matter only; `effects` is one text string, never a
  list; `outcomes` is keyed by each terminal state ID (such as `done`), never
  by an outcome value (such as `succeeded`); `asks` and `sends` are keyed by
  each request and send state ID, exactly those, and left out when there are
  none; `inputs.example` is required when there is an input schema; no
  unknown fields. Before proposing a package, Agent Smith lists the YAML's
  terminal, request and send state IDs and checks the card's keys against
  them, so a card the publish check would refuse never reaches a person.
- A package with only Workflow Definitions is valid as it is: Agent Smith
  never adds an agent just to verify it. It verifies one by reading the
  published definition and card, by a test run of a saved copy in its own
  session, and by asking the person to start it once from the portal's
  new-session picker.
- The repair loop names each terminal state ID as an expected end, not each
  outcome.

## 1.4.11

### Changed

- Before publishing a Workflow Definition, test every expected end as its own
  run with `expect`, and read each report's path, unanswered calls and the
  tools it needs at run time. Per-visit and receive fixtures cover loops,
  polling and receive states; the repair loop has the full procedure.
- Every instruction to load a Workflow skill says to call load_skill with its
  name.
- The `test` operation is described as offered where Workflows are on (Agent
  Smith's own session has them; another session turns them on with
  `enable_workflows`), no longer as offered in every session.

## 1.4.10

### Changed

- Every deployment runs the full Workflow engine (owner 2026-11-08T15:30Z):
  `workflow_definition` and its `test` operation are offered in every current
  session. The untested-publish fallback is for a session of an earlier release
  that has not continued yet.

## 1.4.9

### Changed

- Workflows are always on (owner 2026-11-08T08:03Z): `workflow_definition` is
  always offered. The fallback for an untested publish now names only its
  `test` operation, which is offered only where the deployment runs Workflow
  tests.

## 1.4.8

### Changed

- Carries 1.3.1 from main (0.8.10): flags listed with `alwaysOn: true` (native
  tasks, Base Agent V2 and steering) are always on and cannot be changed. The
  version stays above main's.

## 1.4.7

### Changed

- Named branches (owner 2026-11-08T00:35Z, option A): different branches running
  different nodes at once are one parallel state with named `branches`, each its
  own small graph whose agent node has its own state id, joined as
  `{ <name>: output }`, with `timeoutSeconds` when a branch runs an agent. The
  router pattern is the older form, for branches that come from a list. The
  `workflow-patterns` skill has both, with examples.

## 1.4.6

### Changed

- The router pattern: different branches running different nodes at once (a
  different prompt or model for each) are one Workflow, never several: a
  parallel state over a literal list of lanes, concurrency equal to their
  number, join all, a router script first in the body, one agent node per lane
  (its own state id), and one item end whose output names the lane. The
  `workflow-patterns` skill has the pattern and a complete example.

## 1.4.5

### Changed

- Card model hints are structured (OF-S2-7 review OF7-R5): `strength`,
  `reasoning`, `context` and a short `note` (at most 120 characters) per agent
  node. Publication refuses a note that names a model.

## 1.4.4

### Changed

- Models of agent nodes (OF-S2-7): a definition never names a model, and every
  agent node uses the model of the session that starts it. A card may give
  `modelHints` for a node that really needs another kind of model: words for
  the kind of model, reasoning or context, keyed by the node's id, never a
  provider or model name, so the package works on every deployment.

## 1.4.3

### Changed

- Test fixtures by step kind: a tool call's success value is what it returns,
  an agent node's `{ outcome, output }`, an ask (request) node's
  `{ response }` or `{ decline: { reason } }`, a send's any value; an error is
  `{ code, message }`, a cancel has none. With an example for an ask node.
- A failed test is never followed by a publish plan: quote the report's
  failure in its own words, fix and test again. The same failure twice: stop
  and show the person the report and the fixtures.

## 1.4.2

### Changed

- Workflow Definitions stay simple: the simplest Workflow that does the job
  (few nodes, a straight path, readable in one look). Write the common path
  and route corner cases to an agent node. Judgement, parsing, many branches,
  nested conditions or string logic go to an agent node with a short, clear
  prompt, not to conditions, expressions or scripts. Scripts do work, not
  decisions; no code in YAML. When unsure, choose the simpler definition and
  tell the person what the agent node now handles. The test before publish
  stays.

## 1.4.1

### Changed

- A Workflow Definition is tested before its package is published: save that
  exact YAML in your own session, run `workflow_definition` `test` on that
  revision, read the report, and publish only on a pass (on a fail: fix, save,
  test again). The request to publish counts as the request for the test. The
  result goes with the publish plan; without the test operation, say so and
  publish only on the person's explicit yes.

## 1.4.0

### Added

- Write Workflow Definitions as package entries: `workflows/<name>/workflow.yaml`
  with its interface card `card.md`, named inputs and outputs, and a wait loop
  for recurring work. An agent names the definitions its session may start.
- Verify a Workflow Definition by starting it once from the new-session picker
  in a disposable session before the shared publish.

### Changed

- "Agent workflow" means a named agent; definitions are Workflow Definitions.

## 1.3.1

### Changed

- Feature policy guidance: flags listed with `alwaysOn: true` (native tasks,
  Base Agent V2 and steering) are always on and cannot be changed.

## 1.3.0

### Changed

- Author packages around reusable skills, executable tools/MCP integrations,
  and authored agent workflows. Zero-agent packages need no wrapper agent.
- Verify the capabilities a package actually contains; test a named entry
  point only when the package supplies an agent workflow.
- Explain when a session applies another agent's instructions as reference,
  without inheriting its identity, startup actions, or permissions.

## 1.2.0

### Added

- Feature flag tools for administrators to inspect and change cluster and user settings, with current authorization checked for each call.

## 1.1.1

### Changed

- Rename the displayed package and agent to **Agent Smith**, including the desktop/mobile splash and self-introduction. Keep the `agent-manager` package and agent IDs, tools, authority, and configuration unchanged.

## 1.1.0

### Added

- Authoring guidance for MCP servers: the `.mcp.json` catalog, the
  `plugin.json` `mcpConfig` pointer, and the `schemaVersion: 2` +
  `mcpServers:` frontmatter an agent needs — plus the validator rules and
  the `allowedAgents` identity (`<package>:<agent>`) a deployment uses to
  admit a package agent to a restricted server. Until now the manager never
  wrote `.mcp.json`, so agents it authored could not use MCP at all.

## 1.0.9

### Changed

- Session verification now resolves model names through
  `list_available_models`. When multiple providers expose the requested bare
  model, Agent Manager asks which provider to use instead of choosing one.

## 1.0.8

### Added

- A `title` — "Agent Manager" — so the package presents a readable name in the
  picker and package listings instead of its bare slug.

## 1.0.7

### Fixed

- `manage_agent_session` was described in the prompt but never declared in the
  agent's `tools:` list, so the model could not actually call it. Caught by a
  new in-repo test that cross-checks the declared tools against the ones the
  bundle provides.

## 1.0.6

### Added

- **`manage_agent_session` — complete, cancel or delete a session.** The
  sub-agent lifecycle tools only ever reached the caller's own children, so a
  manager could create a top-level test session and then had no way to clean
  it up. Owner-or-admin, and **system sessions are refused for every
  principal**, admins included.

### Changed

- **The splash now warns what this agent can reach** — every session the
  account can see, on both desktop and mobile. Someone who binds a session to
  it should learn the blast radius from the first screen, not from a tool
  call.
- **A destructive-action gate.** "Nothing ships unreviewed" only ever covered
  publishing, while the tool surface grew delete, cancel, disable, pin and
  message-as-user — all things a person cannot undo with a click. Each now
  requires an explicit yes, named to the specific target, asked before the
  call and not in the same turn. Unattended runs report what they would have
  done instead of doing it, because "nobody said no" is not consent.

## 1.0.5

### Added

- **`message_agent_session` — drive a session as its user.** A verification
  run you cannot talk to only proves the agent boots, so the test loop now has
  both halves. Allowed on a session you own, or on any session if you hold the
  admin role; anything else refuses and sends nothing. Distinct from
  `send_session_message` (auditable cross-session request) and `message_agent`
  (own children only).

## 1.0.4

### Added

- **`create_agent_session` — the manager can finally create TOP-LEVEL
  sessions.** §7 of the design specified a test loop where "test sessions the
  manager creates are top-level", but the tool was never built: `spawn_agent`
  only ever produces a child, so verifying a published agent meant testing it
  with a sub-agent preamble and a parent transcript that a real user session
  does not have. The verification step now says to use this instead, tag the
  run with `test_of` so the sweeper reaps it, and watch the result through
  `read_session_info` — the new session is not a child and does not report
  back.

## 1.0.3

### Fixed

- The 1.0.1 and 1.0.2 artifacts shipped **without** this changelog. The
  package is in manifest mode, which stages only declared paths, so
  `CHANGELOG.md` was dropped silently — while the publish tool was enforcing
  that a changelog entry exist. Fixed in the packer (PilotSwarm 0.5.32): the
  changelog is staged whenever it is present, declared or not.

## 1.0.2

### Changed

- **The authority section now describes both cases instead of one.** It led
  with "the boundary you cannot cross" and mentioned administrator reach only
  as a trailing caveat, so a live run flagged correct fleet-wide behaviour — an
  admin resolving another user's package by bare name — as suspected
  "cross-owner leakage". An agent that misreads its own authority either files
  false security reports or hesitates to do the job it was given. The prompt now
  states the ordinary-user and administrator cases separately, says fleet-wide
  reach is intended rather than a bug, and asks for the blast radius to be
  stated up front when the owner is an admin.
- Publishing an edit seeded from someone else's package lands on **their**
  package rather than forking into the editor's namespace (requires the
  supporting SDK change in PilotSwarm 0.5.32).

## 1.0.1

### Fixed

- The agent's description rendered as a literal `|` in every picker, listing
  and `list_registered_agents` response. The frontmatter used a YAML block
  scalar (`description: |`), which the agent loader only honoured for
  `splash`, `splashMobile` and `initialPrompt` — so `description` took the
  `|` as its value and the indented text was dropped. The loader now accepts
  block scalars for `description` too (PilotSwarm 0.5.31); this package states
  its description on one line regardless, so it reads correctly on any
  runtime.

## 1.0.0

### Added

- First release. An agent that reads, edits and ships agent packages:
  diagnoses a misbehaving session, stages an edit seeded from the bytes
  actually running, renders the change as reviewable `.patch` artifacts, and
  publishes a new version once a human approves. Can also author a package
  from scratch. URL imports reach only origins the deployment has allowlisted
  in `.agent_packages.json`.
- The `agent-repair-loop` skill.
