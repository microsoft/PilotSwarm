# Requirements and limits

This file answers what Workflows must do and what they do not guarantee. For example, a paused build-check Workflow must keep a finished check's result, but it must not start its next check until resumed.

All source citations refer to `4fa702dc`. **Implemented** means a code path or constraint enforces the rule. **Guidance** means the model receives an instruction; there is no independent proof of the person's intent.

## Functional requirements

| Requirement | Implemented behavior | Evidence |
|---|---|---|
| Reuse a procedure | Save named definitions under an owner session. Start the newest valid revision by default, an explicit revision, or the revision of an earlier Workflow. Each start creates a new Workflow session. | `packages/sdk/src/workflow/session-definitions.ts:174-233`, `:324-386` |
| Preserve edits and running work | Saves append revisions with a definition-and-revision guard. Invalid YAML can be saved with diagnostics. A new start recompiles saved YAML; an admitted run reads only its pinned IR. | `packages/sdk/src/workflow/session-definition-store.ts:551-637`, `packages/sdk/src/workflow/session-definitions.ts:350-365`, `packages/sdk/src/workflow/runtime.ts:2976` |
| Publish an exact execution copy | Publication binds revision and YAML/IR hashes, plus named-agent package pins when the host resolves them. Published copies cannot be silently replaced. | `packages/sdk/src/workflow/service.ts:191-266`, `packages/sdk/src/workflow/store.ts:2708-2737` |
| Execute a graph | Support script, wait, messaging, agent, parallel and terminal nodes, named routes, loops and a catch-all state. A standalone `join` node is not supported. | `packages/sdk/src/workflow/compiler.ts:71-82`, `packages/sdk/src/workflow/runtime.ts:1340-1731` |
| Separate conversation from execution | A Workflow session refuses conversational prompts. Its parent remains the place for a person to discuss changes. | `packages/sdk/src/client.ts:63-69`, `packages/sdk/src/workflow/input-policy.ts:1-29` |
| Allow human control | Owner/admin management can pause, resume, stop, cancel and edit variables. Read sharing is not control authority. | `packages/app/web/runtime.js:411-462`, `packages/sdk/src/workflow/human-commands.ts:1` |
| Respect the latest human decision | Guidance tells the agent not to reverse a person's latest control. The read model identifies the last actor and action. This is guidance, not a database priority lock that forbids all later agent controls. | `packages/sdk/src/workflow/guidance.ts:15-21`, `packages/sdk/src/workflow/store.ts:3402-3440` |
| Pause without losing work | Stop admission and result routing. Keep completed results. Deadlines still run. Resume processes pending results, rather than redoing completed nodes. | `packages/sdk/src/workflow/runtime.ts:1015-1031`, `:1340-1351` |
| Stop or cancel | Stop accepts a grace deadline, starts no new nodes and lets started work settle. Cancel records the run end and cancels pending nodes, then wakes the controller for cleanup. Neither undoes an external effect. | `packages/sdk/src/workflow/service.ts:1045-1094`, `packages/sdk/src/workflow/runtime.ts:1008-1014` |
| Receive typed data | Inputs and results must meet declared schemas. A receive can buffer early input. A request accepts only its frozen responder's typed answer; ordinary reply text is not an answer. | `packages/sdk/src/workflow/service.ts:340-357`, `packages/sdk/src/workflow/authority.ts:81-104`, `packages/sdk/src/workflow/request-service.ts:18-39` |
| Require explicit agent completion | Only `complete_workflow_node` can supply an agent node's business result. Deadline, cancellation, invalid-output exhaustion, spawn failure and terminal turn failure can end it as errors. | `packages/sdk/src/workflow/agent-node-service.ts:23-67`, `packages/sdk/src/workflow/store.ts:6475`, `packages/sdk/src/orchestration/workflow-turn-failure.ts:1` |
| Preserve continued agent context | Outer-graph agent states default to `session: continue`; parallel bodies use `new`. Each completion and turn stop is tied to its visit. | `packages/sdk/src/workflow/compiler.ts:1556`, `:1313-1319`, `packages/sdk/src/workflow/agent-ids.ts:1`, `packages/sdk/src/workflow/runtime.ts:2704` |
| Keep parent ownership | Direct completion of an owner is refused while its Workflows remain active. The parent's shutdown cascade ends its children without that refusal: ordinary children end completed; an active Workflow run and its Workflow session end cancelled with "Parent session completing"; already-ended Workflow children keep their state. The owner-session trigger ends hidden test benches and is the backstop for any Workflow child not ended by the cascade. | `packages/sdk/src/workflow/session-definitions.ts:449-462`, `packages/sdk/src/orchestration/agents.ts:727-758`, `packages/sdk/src/session-proxy.ts:6691-6702`, `packages/sdk/src/client.ts:564-566`, `packages/sdk/src/migrations/workflow-session-names-0089.ts:91-138` |
| Test without live fallback | Intercept framework tool calls, mocked agents, sends and requests. Use prepared or explicit answers. Missing mocks never become live calls. Scripts still execute real code. | `packages/sdk/src/workflow/test-mode.ts:15-39`, `packages/sdk/src/workflow/definition-test.ts:1-26` |
| Report an end | Notify the parent unless disabled, suppressed because the parent requested the end, or unavailable. Record notification or skip evidence. Acceptance by the parent queue does not prove the parent model read it. | `packages/sdk/src/workflow/runtime.ts:897-905`, `packages/sdk/src/workflow/parent-delivery.ts:1-36` |

## Consent and activation

Workflows are installed on every normal worker, but an ordinary session can start with Workflow context off. It receives `enable_workflows` and a short explanation. It should enable only when the person asks for a Workflow or accepts a suggestion. After activation, the model may use Workflows where they fit. The enable tool has no consent token or approval record in its arguments. Consent here is model-mediated guidance, not an independently enforced transaction. See `packages/sdk/src/workflow/guidance.ts:54-90`.

An incoming Workflow message or an existing owned definition can be a lasting activation trigger. A service session or read-only tuner can receive no Workflow context. This distinction is separate from the deployment script switch and the test-mode switch. See `packages/sdk/src/session-manager.ts:2546-2616` and `packages/sdk/src/workflow/test-mode-switch.ts:1-36`. The known failure to prefer a Workflow over cron is recorded in [Known issues](known-issues.md).

## Non-functional requirements

| Requirement | Actual boundary | Evidence |
|---|---|---|
| Durable progression | Record scheduling decisions in Duroxide history. Record business results and run state in CMS transactions. Replay reads accepted activity results; effects stay outside generator execution. | `packages/sdk/src/workflow/runtime.ts:98-112`, `:1750-1768` |
| Repeat-safe commands | Bind operation identifiers to request hashes and receipts. Reuse with different arguments conflicts. A retry can complete a dispatch that failed after the CMS commit. | `packages/sdk/src/workflow/store.ts:2708-2737`, `packages/sdk/src/workflow/service.ts:426-441` |
| One accepted result | Serialize writers and update a node only while pending. Late completion, timeout and cancel compete for one stored winner. This is not exactly-once execution of external effects. | `packages/sdk/src/migrations/workflow-0088.ts:20-24`, `packages/sdk/src/workflow/store.ts:6475-6690` |
| Bounded history and memory | Continue the controller as new after admission or idle-wait thresholds; carry exact cursors, not a query for latest work. Bound graph, payload, queue and correction sizes. | `packages/sdk/src/workflow/runtime.ts:164-174`, `:1076-1080`, `packages/sdk/src/workflow/compiler.ts:65-70` |
| Fail closed on authority | Derive actors from trusted host context and current stored lineage. A session ID in YAML grants no rights. Recheck authority under deciding locks. | `packages/sdk/src/workflow/authority.ts:4-29`, `packages/sdk/src/workflow/store.ts:1865-1937` |
| Do not widen tool grants | Capture a host-owned parent grant. Match tools and their schema hashes at use. Deny Workflow/lifecycle/administration controls from scripts. | `packages/sdk/src/workflow/tool-policy.ts:18-30`, `:71-178` |
| Keep scripts bounded | Run a guarded Node child process with restricted file access and a scrubbed environment. Use a per-execution authenticated loopback bridge for tools and results. This does not provide a network sandbox. | `packages/sdk/src/workflow/runner.ts:333-349`, `:435-476` |
| Make uncertainty visible | A missing controller on an active CMS run means recovery is needed, not success. Failed reads do not make a session a Sweeper candidate. | `packages/sdk/src/workflow/service.ts:444-471`, `packages/sdk/src/sweeper-tools.ts:53-97` |
| Preserve compatible sessions | Keep earlier ordinary session handlers registered; move to 1.0.83 only at continue-as-new. The compatibility floor remains 1.0.47. | `packages/sdk/src/orchestration-registry.ts:35-83`, `packages/sdk/src/orchestration-version.ts:1-16` |

## Limits

| Limit | Value and scope | Evidence |
|---|---|---|
| Live runs | At most one per Workflow session, across all terminal states; no restart | `packages/sdk/src/migrations/workflow-0088.ts:216-218` |
| Owner child budget | 50 active ordinary children and Workflows combined; the claim transaction counts again | `packages/sdk/src/child-budget.ts:14-20`, `packages/sdk/src/workflow/session-definitions.ts:39-69` |
| Workflow start nesting | Maximum level 2, with root at 0; a start adds one level | `packages/sdk/src/workflow/session-definitions.ts:44-58` |
| Workflow agent subtree depth | Maximum absolute level 3; not an extra allowance for each Workflow ancestor | `packages/sdk/src/workflow/input-policy.ts:24-45` |
| Seconds wait (`WAIT_MAX`) | 1-86,400 s per wait; request/agent time limits use this bound. A clock wait uses its next scheduled calendar time instead. | `packages/sdk/src/workflow/compiler.ts:25-26`, `packages/sdk/src/workflow/runtime.ts:2161-2176` |
| Run deadline | Optional; maximum 30 days, measured from begin, not save or admission | `packages/sdk/src/workflow/compiler.ts:50-54`, `packages/sdk/src/workflow/store.ts:3466-3482` |
| Graph size | 100 nodes; default 1,000 node executions, maximum 10,000 | `packages/sdk/src/workflow/compiler.ts:65-68` |
| Parallel work | Maximum 64 items or named branches; concurrency 1-16; no nested parallel graph | `packages/sdk/src/workflow/compiler.ts:39-48`, `:1120-1365` |
| YAML | 256 KiB maximum | `packages/sdk/src/workflow/service.ts:327-336` |
| Run variables | 1,000 keys; 128 characters per key; 256 KiB per value; 1 MiB total | `packages/sdk/src/workflow/store.ts:114` |
| Common JSON payload | 256 KiB | `packages/sdk/src/workflow/json.ts:19` |
| Send payload | 16 KiB canonical JSON | `packages/sdk/src/workflow/runtime.ts:155-159` |
| Request response schema closure | 8 KiB | `packages/sdk/src/workflow/compiler.ts:59-60` |
| Response data | 16 KiB | `packages/sdk/src/workflow/store.ts:939` |
| Request operation identities | Maximum 50 bound operation IDs per request; known IDs remain replayable | `packages/sdk/src/workflow/store.ts:941`, `:4585-4591` |
| Buffered typed input | Maximum 100 unconsumed messages per run, 20 per sender; 60 inputs per sender per 600 s window | `packages/sdk/src/workflow/service.ts:1256` |
| Typed-input lifetime | Default and maximum 86,400 s | `packages/sdk/src/workflow/store.ts:362-363` |
| Agent inline prompt / named tools | 32 KiB / maximum 64 tool names; completion tool retained | `packages/sdk/src/workflow/compiler.ts:41-46`, `:55-56` |
| Agent correction / reminder budget | Three invalid completions; up to three step reminders | `packages/sdk/src/workflow/store.ts:778-782` |
| Script time / tool calls | Default 300 s, maximum 3,600 s; maximum 500 bridge calls per script | `packages/sdk/src/workflow/compiler.ts:69-70`, `packages/sdk/src/workflow/runner.ts:32` |
| Stop grace | Default 60 s; 0-3,600 s | `packages/sdk/src/workflow/service.ts:997-998`, `packages/sdk/src/workflow/store.ts:273` |
| Controller history boundary | 25 admissions or 50 idle waits per execution; 30,000 ms default backstop | `packages/sdk/src/workflow/runtime.ts:164-174` |
| Reusable definition revisions | Maximum 1,000 | `packages/sdk/src/workflow/session-definition-store.ts:180` |
| Test fixtures | Maximum 200; 256 KiB total | `packages/sdk/src/workflow/test-mode.ts:40-43` |
| Test clock advance | 1 s to 30 days per advance | `packages/sdk/src/workflow/store.ts:959`, `:7564-7565` |
| Retention defaults | Keep 20 ended low-level test runs, at least 300 s old, subject to safe-pruning exclusions; keep five visible ended definition-test benches and soft-delete older ones without erasing their rows/runs | `packages/sdk/src/workflow/service.ts:137-140`, `packages/sdk/src/workflow/session-definition-store.ts:30`, `:448-467` |

These limits protect different resources. The 50-child owner budget does not replace the 64-branch graph limit. A test does not waive authorization, node limits or script restrictions.
