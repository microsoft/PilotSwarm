# Known issues and enhancements

This file answers what a reader must not assume is solved by PR 270. For example, a controller can recover a committed result after a lost wake, but it cannot make the CMS admission and Duroxide start one atomic transaction.

**Bug** means incorrect behavior identified in source or reported in tests. **Gap** means an implemented boundary or missing guarantee. **Enhancement** means proposed future work. Reported observations are distinguished from source-backed behavior below.

## Cross-cutting issues

| Class | Issue | Evidence and disposition |
|---|---|---|
| Gap | CMS and Duroxide are separate transaction domains | Live admission commits before dispatch. At the source pin an ordinary session start dispatched before its CMS running update; later in this PR the two are serialized under the session row's lock (`bddbd878`, `50ad6493`), still not atomic. Re-request and explicit recovery mitigate but do not remove the gap. `packages/sdk/src/workflow/service.ts:433-441`, `:978-986`; `packages/sdk/src/client.ts:1006-1030`. |
| Enhancement | Resolve two-store consistency across the product | Tracked as follow-up work for ordinary sessions and Workflows. A durable start-intent record is a follow-up; it is not implemented at this source pin. Reconciling a queued start, including a start that commits after the first message's 30-second wait timed out, is [issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 1. |
| Bug (fixed in this PR) | Ordinary first start can race Sweeper cleanup of a NotFound orchestration | At the source pin the ordinary first start and the CMS update were separate, and ordinary cleanup accepted a stale NotFound instance. This ordering exists on main too. Fixed later in this PR (`bddbd878`, `5dcfc349`, `6f59403d`, `50ad6493`; see below), not at `4fa702dc`. `packages/sdk/src/client.ts:1006-1025`; `packages/sdk/src/sweeper-tools.ts:80`, `:166-184`; `packages/sdk/src/workflow/store.ts:3366-3400`. |
| Bug | A live delete, cancel or completion waits for a child that never started | A session created through the API with no first message has no orchestration. When its parent's live orchestration ends with a cascade, the child never answers; after the 60-second shutdown deadline the parent ends failed instead of deleted or completed, and its subtree is left as it was. This exists on main too. The management client's fast path for a parent that is not live is not affected. Filed, not fixed in PR 270: [issue 290](https://github.com/microsoft/PilotSwarm/issues/290) section 1. The live owner-cascade test sends every child a first message. |
| Bug | Owner completion skips a Workflow whose controller already failed | The completion's cascade does not end such a Workflow, and its agent session stays alive. Filed, not fixed in PR 270: [issue 290](https://github.com/microsoft/PilotSwarm/issues/290) section 2. |
| Bug | A test command on a retained test bench can start after the owner completed | A direct `updateWorkflow` operation `test` on a retained bench can still admit a test run after the owner completed: the store checks the owner only when the bench is passed in. Filed, not fixed in PR 270: [issue 290](https://github.com/microsoft/PilotSwarm/issues/290) section 3. |
| Bug | Sweeper schedule wording contradicts itself | The prompt says every approximately ten iterations is "about every 5 hours", but it wakes every 21,600 s (6 h). Ten scheduled wakes would be about 60 h. The implementation document cannot turn that prose into a reliable five-hour prune schedule. `packages/sdk/plugins/mgmt/agents/sweeper.agent.md:42`, `:63-67`; `packages/sdk/plugins/mgmt/skills/sweeper/SKILL.md:15-19`. |
| Gap | Durable recipient intake is present but not enabled by the default worker | Worker registration omits `workflowIntake`; send delivery requires the callback to return true. Legacy queue deduplication is not durable at-most-one admission after arbitrary message traffic. `packages/sdk/src/worker.ts:1043-1064`; `packages/sdk/src/workflow/runtime.ts:4490-4509`. |
| Gap | No periodic response-wake dispatcher is started | Immediate dispatch is attempted; a lost response wake relies on controller backstop. The durable wake row alone does not imply an active periodic dispatcher. `packages/sdk/src/workflow/request-service.ts:6-12`, `:64-135`. |
| Gap | Parent acceptance is not parent-model reading | Parent may end between status read and enqueue. A notification record can say accepted even when no model later reads it. Bounded delivery ordering waits cannot guarantee universal ordering against an indefinitely delayed send. `packages/sdk/src/workflow/parent-delivery.ts:1-9`, `:26-35`; `packages/sdk/src/workflow/runtime.ts:2927-2947`. |
| Gap | Notification activity can hold a connection/lock beyond voluntary wait budgets | SQL/connect/send calls have no independent attempt deadline in this path. Later attempts progress after the holder settles or its connection/process ends; elapsed voluntary waits do not forcibly release an active sender. `packages/sdk/src/workflow/runtime.ts:2927-2947`. |
| Gap | Continued-visit prompt can wait behind an older turn | Its own deadline continues while the old visit's stop propagates. Visit fencing keeps results correct, but does not eliminate the delay. `packages/sdk/src/workflow/runtime.ts:2704-2743`; `docs/developer/building/workflow-sessions.md:178-185`. |
| Gap | Recovery is not restart of a begun run without history | An admitted NotFound run can be dispatched; a begun active run whose controller is gone is failed and cleaned up. No cursor is reconstructed from arbitrary latest rows. `packages/sdk/src/workflow/service.ts:593-704`. |
| Gap | Request-to-Workflow response path is unsupported | A Workflow can receive typed messages, but a request requires an agent responder in this increment. Cancellation does not cancel a peer session. `packages/sdk/src/workflow/runtime.ts:5318-5340`; `docs/proposals/workflow-messaging-request.md:120-132`. |
| Gap | Durable expiry begins with an observation, not physical time alone | A recorded expired operation prevents later acceptance after clock rollback. If nobody observed a deadline passing before the clock moves backward, that durable marker does not exist. This is the recorded request-model limit, not a monotonic-clock guarantee. `packages/sdk/src/workflow/store.ts:4609-4618`; `docs/formal/workflow/paired/README.md:83-84`. |
| Gap | No exactly-once external effects or network sandbox | Script processes and real-agent built-in tools can make real effects; replay-safe orchestration does not make those effects exactly once. Tests retain direct script effects. `packages/sdk/src/workflow/runtime.ts:1750-1768`; `packages/sdk/src/workflow/runner.ts:333-349`; `packages/sdk/src/workflow/test-mode.ts:15-39`. |
| Gap | Test retention has exclusions | CMS test runs with live outbox/request/agent records cannot be pruned by `pruneTestRun`; deleted Workflows retain their runs. There is no blanket bounded-history guarantee for all CMS rows. `packages/sdk/src/workflow/store.ts:7680-7709`. |
| Gap | Activity tags do not solve mixed-version orchestration dispatch | An old worker can receive an unsupported orchestration version during rollout. The formal `RollingDeploy` notes document the poison/retry limit. `docs/formal/session-orchestration/README.md:70`; `packages/sdk/src/worker.ts:932-944`. |
| Gap | Human credential forwarding can hide an agent origin | A person-mode command can reject a declared originating session inside a Workflow. A caller using a person's credential and omitting that origin is indistinguishable from the person at this boundary. `packages/sdk/src/workflow/human-commands.ts:194-209`. |

## Done in this PR after the source pin

The following changes are in PR 270 after the source pin `4fa702dc`; that pin does not show them.

| Change | Commit | Behavior |
|---|---|---|
| Direct completion | `ac3fef7b` | The `WORKFLOW_ACTIVE` refusal is removed (it was at `packages/sdk/src/management-client.ts:1693-1698` and `packages/sdk/src/workflow/session-definitions.ts:449-462`). Direct completion of an owner session uses the existing cascade and owner-session trigger. |
| Serialized first start | `bddbd878`, `50ad6493` | A session's first message writes its row and starts its orchestration in one CMS transaction on the row's lock; the Sweeper compares the row's exact version under that lock. Serialized, not atomic. The send waits at most 30 seconds for Duroxide's answer to the start: that bounds only this wait, not the row lock or the whole path. A start that answers late can still commit, and a retry is best-effort ([issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 1). |
| DR-01: unresolved start | `5dcfc349` | A session with an accepted, unresolved start is kept when Duroxide reports NotFound, at any age; only a terminal status or an ended state shows its end. |
| DR-02: cleanup subtree | `6f59403d` | The cleanup subtree is read again under its locks; a session is never created under a deleted parent. |
| Package Workflow starts | `e27de05f` | Any session may start any package Workflow its owner can see; see [Interfaces](interfaces.md#package-interfaces-and-admission). |

The parent's `done` cascade already ends ordinary children as completed. An active Workflow run and its Workflow session end cancelled with "Parent session completing"; step agents end; already-ended Workflow children keep their state. This live-run behavior was observed on a test deployment. Hidden test benches are not listed for the cascade: when the owner row becomes completed, the owner-session trigger cancels their active test runs with "The session that owns this Workflow ended, so the Workflow was canceled." The same trigger is the backstop for any Workflow child the cascade did not end first. Two known exceptions are filed, not fixed ([issue 290](https://github.com/microsoft/PilotSwarm/issues/290)): owner completion skips a Workflow whose controller already failed, and its agent session stays alive (section 2); a direct `updateWorkflow` operation `test` on a retained test bench can still start after the owner completed (section 3). See `packages/sdk/src/orchestration/agents.ts:727-758`, `packages/sdk/src/session-proxy.ts:6691-6702`, `:6809-6813`, `packages/sdk/src/client.ts:564-566`, and `packages/sdk/src/migrations/workflow-session-names-0089.ts:91-138`.

The completion change does not rewrite Workflow child sessions to completed. **No migration was needed for it.** A durable start-intent record ([issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 1) and product-wide two-store consistency remain separate follow-ups, not claims made by DR-01 or DR-02.

## Follow-up issues

The items below are tracked as follow-up issues. A proposed change is not an implemented guarantee.

| Class | Follow-up | Summary |
|---|---|---|
| Bug | [Workflow suggestion versus cron](#workflow-suggestion-versus-cron) | Fixed repeated checks can choose session cron despite Workflow guidance; guidance tuning follows PR 270 ([issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 3) |
| Gap | [Package admission](#package-admission) | Package code/MCP definitions lack host-owned admission and deployment-owned endpoint policy |
| Bug | [Agent-step refusal](#agent-step-refusal) | Visible refusal text can accompany a valid successful typed completion |
| Bug | [Error row](#error-row) | Reading a failed ordinary session can replace error with idle and clear its error |
| Bug | [Command-response keys](#command-response-keys) | Unbounded command-response KV keys can exhaust Duroxide's per-instance key limit |
| Bug | [Lasting activation](#lasting-activation) | Failed persistence can leave Workflow context enabled only on the current worker/turn |
| Bug | [Activation and native-task race](#activation-and-native-task-race) | Enable and native task pre-hooks in one model response can race tool-set activation |
| Gap | [Legacy UI](#legacy-ui) | Unused legacy Workflow workspace panels still have tests |
| Enhancement | [Provider test runner](#provider-test-runner) | Run provider-sensitive tests near their database while preserving trust controls |
| Bug | [Test deadlines](#test-deadlines) | Some short test deadlines and fixture SQL timeouts do not scale together |
| Gap | [Provider-specific transient errors](#provider-specific-transient-errors) | Transient errors observed in tests remain under investigation |

### Workflow suggestion versus cron

An observation at candidate `4fa702dc` used a request to check a public site once a minute for five minutes. With Workflow context off, the model used cron without suggesting a Workflow. With it on, it still used cron instead of `workflow_definition`. Decline/accept activation behavior remained correct in those observations.

PR 270 retains this behavior; guidance tuning is a follow-up, [issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 3. Proposed work: strengthen off/on scheduling descriptions, repeat the consent cases across model families, and make currently non-gating preference checks gating only once reliable. Current guidance is `packages/sdk/src/workflow/guidance.ts:6-10`, `:60-90`. The causal reason for the model's choice is **unverified**.

### Package admission

Package worker modules execute in the worker process, and packages can supply MCP configuration. PR 270 adds loading of pinned older package revisions and Workflow YAML containing scripts. Schema validation, package visibility and script permission flags do not by themselves form a deployment-owned code-admission boundary.

The follow-up calls for a deployment-owned MCP catalog, credential-audience policy, content-hash admission before package code loads, and independent options to disable worker modules or package MCP servers. These protections are not present here. Source areas: `packages/sdk/src/worker.ts:2286`, `packages/sdk/src/workflow/session-packages.ts:1`, `packages/sdk/src/workflow/runner.ts:333-476`.

### Agent-step refusal

A real-model agent step reportedly emitted a refusal sentence and then called `complete_workflow_node` with the correct result. The graph advanced, but a person reading the child session saw a refusal. The follow-up proposes clearer invocation framing, a multi-model refusal-text test and a log indication for contradictory text.

The suggestion that a system-looking user-turn prefix caused the refusal is **unverified**. The relevant prompt builders are `packages/sdk/src/workflow/runtime.ts:5428-5519`. Typed completion remains the graph's authority, not the prose.

### Error row

An ordinary session can record a terminal turn failure as CMS state error with `lastError`, then idle awaiting another message. A later status read can treat that row as stale and replace it with the orchestration's idle status, clearing the error. The follow-up asks to retain the error until a newer successful turn proves recovery.

The recovery helper exists on main too. PR 270 excludes Workflow sessions from inappropriate ordinary-session status repair rather than fixing every ordinary-session error case. Source: `packages/sdk/src/session-status.ts:124`, `packages/sdk/src/client.ts:1253-1279`.

### Command-response keys

Each answered ordinary-session command adds a `command.response.<id>` KV entry without a bounded removal policy. Duroxide 0.1.32 allows 150 user KV keys shared with FIFO buckets and other metadata. This is an existing ordinary-session limit, not Workflow run KV.

Proposed work: prune old response keys or retain a bounded set, version the changed orchestration action sequence, and exercise hundreds of commands. Source: `packages/sdk/src/orchestration/lifecycle.ts:115-140`; `duroxide/src/runtime/limits.rs:39-48` at the pin in [Duroxide integration](duroxide.md).

### Lasting activation

When an incoming Workflow message or existing owned Workflow should enable context permanently, the save can fail and be logged while the turn continues with context on. A different worker may then see it off. The follow-up proposes retrying that save before the model turn, with an explicit final-attempt fallback rather than a second marker in the same failing store. Source: `packages/sdk/src/session-manager.ts:5121-5158`.

### Activation and native-task race

One model response can request both `enable_workflows` and a native task. A pre-hook ordering gap can occur before either handler starts. The follow-up proposes fencing both orderings, tracking pending native admissions and clearing that bookkeeping at each turn. This is not an assertion that the existing activation checks cover every interleaving. Source area: `packages/sdk/src/managed-session.ts:966-990`.

### Legacy UI

`workflow-workspace.js` is reported as unused by product code while tests still render legacy panels through it. The follow-up proposes removing that unused surface and moving meaningful tests onto the current Workflow tab, or first reusing genuinely needed panels. Source areas: `packages/app/ui/react/src/workflow-workspace.js:1`, `packages/app/ui/react/src/workflow-panels.js:1`.

### Provider test runner

PR all-provider tests can run far from their database, while a main-branch full-provider path can use a dedicated runner. Extra database latency makes time-sensitive tests slower and less reliable. The follow-up proposes using a region-appropriate runner for that provider phase and emitting connection/query latency at phase start, without loosening review or trust controls. Source to review: `.github/workflows/tests.yml:1`.

### Test deadlines

Some parallel-test waits were scaled in PR 270. Two request-race probes still use short deadlines with SQL lock/statement timeouts that do not scale consistently. Increasing only the probe wait can change the expected error from lock timeout to statement timeout.

The follow-up asks to scale fixture timeouts and probe deadlines together, then audit other short provider-sensitive waits. Source: `packages/sdk/test/local/workflow-request-races.test.js:147`, `packages/sdk/test/helpers/workflow-request-fixture.js:48-49`.

### Provider-specific transient errors

Provider-specific transient errors were observed in tests; they remain under investigation.

## Documentation disagreements

| Existing statement | Candidate code / correction |
|---|---|
| All persistence is through CMS stored procedures | Only part is. `WorkflowStore` and `SessionDefinitionStore` issue direct transactional SQL; session projection/claim functions are reused. `packages/sdk/src/workflow/store.ts:2373-2415`. |
| 0089 renames `workflow_session_deleted` to owner-session-ended | False. It renames `workflow_chat_ended`. `workflow_session_deleted` remains a separate trigger. `packages/sdk/src/migrations/workflow-session-names-0089.ts:144-158`. |
| Milestone/request/intake documents use controller 1.9.0, many IR versions and migrations 0088-0111 | Their as-built headers correctly say these were collapsed. Current Workflow orchestrations are all 1.0.0; IR is 1; CMS additions are 0088 and 0089. Do not apply the historical numbers literally. |
| Dynamic-kind proposal cites migrations 0107 and 0100 as current background | Those numbers are historical. The relevant tables/columns are now in 0088, renamed in 0089. The dynamic engine itself remains unimplemented. `docs/proposals/dynamic-workflow-kind.md:76-86`; migration registry `packages/sdk/src/cms-migrations.ts:421-422`. |
| Milestone says packaged-agent workflow interfaces are not supported | Current code validates, exports and exactly matches them. `docs/proposals/workflow-milestone.md:102-106`; `packages/sdk/src/workflow/package-interface.ts:9-40`. |
| Developer guide says every run ends at a terminal and only completion ends an agent step | Those describe normal business completion, not all endings. Runtime failures, deadlines, controls, deleted owners and exhausted output corrections can end work. `docs/developer/building/workflow-sessions.md:15-26`; `packages/sdk/src/workflow/runtime.ts:924-946`; `packages/sdk/src/workflow/store.ts:6634-6653`. |
| Some older Workflow guidance describes publish-first drafts and only all-required for-each | Current reusable definitions start new pinned sessions; named branches and first-k joins exist. `packages/sdk/src/workflow/session-definitions.ts:324-386`; `packages/sdk/src/workflow/parallel.ts:47-52`. |
| Some old model prose calls intake behind a test-only capability | 1.0.83 and its activities are registered normally now, but default send-side durable intake remains off. Registration and activation are different claims. `packages/sdk/src/worker.ts:923-933`, `:1005-1064`. |
| Formal READMEs cite 175 session cases, 283 orchestration cases or 89 continued cases | Current active `cases.tsv` counts are 184, 294 and 101. Later cases were added; older run totals remain valid only for their recorded batches. |
| Historical correspondence refers to `orchestration_1_0_83/` or old Workflow names | Current session source is `orchestration/`, with 1.0.82 frozen. The correspondence's commit-qualified lines stay historical; this design uses candidate paths/lines. |
| Request design describes an active periodic wake dispatcher | Current worker uses immediate dispatch only; lost wakes rely on the controller backstop. `packages/sdk/src/workflow/request-service.ts:6-12`. |
| Copilot comparison says a script can call any tool its session may use | The Workflow grant excludes controls and other restricted tools; the script cannot call every parent tool. `docs/developer/building/workflows-and-github-copilot.md:137-141`; `packages/sdk/src/workflow/tool-policy.ts:71-128`. |

## Unverified items and open questions

| Item | What remains unverified |
|---|---|
| Native binary dependency resolution | The lock pins JavaScript package 0.2.4; source Cargo ranges do not prove the distributed binary's exact Rust dependency resolution. |
| Follow-up causes | Reported symptoms do not establish their cause or resolution. |
| Cross-product consistency design | The product-wide consistency mechanism and start-intent record remain follow-ups ([issue 291](https://github.com/microsoft/PilotSwarm/issues/291) section 1). |
| Formal proof at this candidate | No full TLC rerun or new source-to-model proof was performed. Recorded results have their original pins and bounded assumptions. |
| Diagram syntax | Automated Mermaid parse acceptance remains unverified. |

The open engineering decisions are the two-store consistency mechanism, the package-admission policy, and whether/when to activate durable recipient intake and periodic response-wake dispatch. The existing implementation must not be described as already making those decisions.
