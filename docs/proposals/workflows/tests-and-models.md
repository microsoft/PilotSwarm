# Tests and formal models

This file answers what evidence exists for the design and what that evidence cannot establish. For example, a scripted-model test can prove that an agent completion reaches the correct node, but it cannot prove that an unscripted model will prefer a Workflow over cron.

All source inventories are at `4fa702dc`. No tests, builds, model calls or TLC runs were executed to write this document. Historical results below are reports already in the repository, with their original scope and dates.

## Test inventory and tiers

The [file-by-file inventory](test-inventory.md) covers **179 SDK Workflow test files**: 82 under `test/unit` and 97 under `test/local`. Each row has source titles, tier, provider selection and relevant environment identifiers. A file can mix tiers; the row states its strongest invoked facility.

| Area | Representative files under `packages/sdk/test/` | What is checked |
|---|---|---|
| Compiler and schemas | `unit/workflow-compiler-input-mismatch.test.mjs`, `workflow-inputs-schema.test.mjs`, `workflow-schema-cost.test.mjs`, `workflow-schema-patterns.test.mjs`; `local/workflow-core.test.js` | Closed graph vocabulary, input bindings, malformed schemas, complexity limits, diagnostic wording and valid graph execution |
| Definitions and publication | `local/workflow-session-definitions.test.js`, `workflow-publication.test.js`, `workflow-start-review.test.js`, `workflow-creation-claim.test.js`, `workflow-start-limits.test.js` | Immutable revisions, stale guards, receipt-first starts, exclusive claims, shared child budget, owner lifecycle and pinned copies |
| Packages and model choices | `local/workflow-agent-resolver.test.js`, `workflow-package-definitions.test.js`, `workflow-agent-models-real-model.test.js`; `unit/workflow-package-interface.test.mjs` | Package visibility/pins/interfaces, locked definitions, explicit model choices and spending-owner checks |
| Runtime and controls | `local/workflow-control.test.js`, `workflow-stop.test.js`, `workflow-command-queue.test.js`, `workflow-run-deadline.test.js`, `workflow-faults.test.js` | Pause/resume, stored controls, lost hints, stop grace, run deadlines, errors and restart/recovery boundaries |
| Parallel and named branches | `local/workflow-parallel.test.js`, `workflow-join.test.js`, `workflow-join-robust.test.js`, `workflow-branches.test.js` | Commit-order winners, first-k/all joins, time limits, cancellation, output shape, branch-local routes and durable recovery |
| Typed messages and requests | `local/workflow-send.test.js`, `workflow-messaging.test.js`, `workflow-request.test.js`, `workflow-request-races.test.js`, `workflow-request-runtime.test.js` | Authority, deduplication, inbox claim, deadline locks, durable observed expiry, response receipts and wake behavior |
| Agent step lifecycle | `local/workflow-agent-node.test.js`, `workflow-agent-node-e2e.test.js`, `workflow-simplified-session-continue.test.js`, `workflow-agent-turn-failure.test.js`, `workflow-agent-child-storage.test.js` | Typed completion, invalid-result budget, continued visits, stop/end races, failed turns and shared child storage resources |
| Security and input policy | `local/workflow-input-policy.test.js`, `workflow-a1-refusal.test.js`, `workflow-definitions-step-guard.test.js`; `unit/workflow-person-control.test.mjs`, `workflow-tool-executor.test.mjs` | Human-input denial, no nested definition tools, tool grants/filters, actor identity and permission failure |
| Script process guard | `local/workflow-script-runner.test.js`, `workflow-native-tools.test.js`; `unit/workflow-script-guard.test.mjs` | Guarded process behavior, results, timeouts, tool bridge and native MCP sampling restrictions |
| Test facilities | `local/workflow-definition-test.test.js`, `workflow-definition-test-gaps.test.js`, `workflow-test-mode.test.js`, `workflow-test-agents.test.js` | Fixtures, missing answers, receive fixtures, virtual time, expected terminal, no live fallback and real-agent test mode |
| Cleanup and migrations | `local/workflow-migration-0088.test.js`, `workflow-migration-0089.test.js`, `workflow-delete.test.js`, `workflow-owner-session-end-lock-order.test.js`, `workflow-sweeper-recover.test.js` | Catalog objects, renames, atomic soft delete, lock order, active-run protection and missing-controller recovery |
| Activation and guidance | `local/workflow-context-on-demand.test.js`, `workflow-context-on-demand-cli.test.js`, `workflow-activation-queued-prompts.test.js`; `unit/workflow-guidance.test.mjs` | On-demand activation, tool refresh, queued prompt preservation and guidance wording |

These are coverage descriptions, not pass claims. The exact source-test titles and line links are in [test-inventory.md](test-inventory.md).

### Real-model tests

Ten local files have explicit real-model scenarios:

| File under `packages/sdk/test/local/` | Scenario |
|---|---|
| `workflow-agent-real-model.test.js` | Inline and packaged reviewer with typed results, local or deployed target |
| `workflow-agent-models-real-model.test.js` | Per-agent model choices at start |
| `workflow-agent-tool-limit-real-model.test.js` | Real model sees and obeys the agent tool surface |
| `workflow-default-worker-agent-real-model.test.js` | Default worker behavior, including Workflow activation/consent observations |
| `workflow-definition-test-real-model.test.js` | A real model uses the definition-test facility |
| `workflow-named-branches-real-model.test.js` | Named branches with real agent work |
| `workflow-notice-empty-answer-real-model.test.js` | Model behavior on Workflow notices that need no answer |
| `workflow-package-definitions-real-model.test.js` | Real model uses packaged definitions |
| `workflow-session-definitions-real-model.test.js` | Real model saves/starts reusable definitions |
| `workflow-release-features-real-model.test.js` | Granted/ungranted required tools, early completion correction, authored carry/error routes and owner approval |

Live-model tests run in every full pass; there is no opt-in switch. The shared plan supports model, effort, sample count, receipt path and local/deployed target. The model is `PS_WORKFLOW_REAL_MODEL_REF`, else `PS_TEST_FORCE_MODEL`, else the catalog default. Missing models or credentials fail with `BLOCKED: no usable model: <why>`; they never skip or substitute a scripted model. The primary helper caps samples at five. Release-feature cases use one sample each and assert actual request metadata and durable state, not model text. Do not infer that all files have identical scenario budgets. See `packages/sdk/test/helpers/workflow-real-model.mjs` and each inventory row.

Release-feature receipts name their oracle: `http-request` for HTTP inference or `cli-metadata` for native per-request metadata at inference usage events. A granted tool must execute successfully. The no-grant witness proves metadata absence and no invocation, then checks that adding `requiredTools` refuses Start through the person path before further inference. This file runs once on the baseline, not again in the additive HorizonDB phase.

### Provider-plan membership

`scripts/test-provider-plan.mjs:43-53` enumerates every SDK local test and subtracts the literal `baselineOnly` list in `scripts/provider-test-coverage.json`. Newly added local tests are selected for HorizonDB unless explicitly excluded. This is storage-provider selection, separate from always-on live-model execution.

Of the 97 Workflow local files, **89 are baseline-only** and **eight are selected on both baseline PostgreSQL and HorizonDB** at this commit:

| File | Purpose of the cross-provider check |
|---|---|
| `workflow-command-queue.test.js` | Stored command acceptance and queue behavior |
| `workflow-core.test.js` | Compiler/store/controller integration |
| `workflow-definition-test-gaps.test.js` | Definition-test edge cases |
| `workflow-migration-0088.test.js` | Final Workflow schema and concurrent index behavior |
| `workflow-migration-0089.test.js` | Session-name renames and value conversions |
| `workflow-parallel.test.js` | Parallel runtime/storage behavior |
| `workflow-request-races.test.js` | Request deadline and locking races |
| `workflow-sweeper-recover.test.js` | Cleanup/recovery safety |

The selector and exclusions, not this list, decide future coverage. Time scaling is a separate test-harness concern; the request-race fixture still has timing follow-up work ([Known issues](known-issues.md#test-deadlines)).

### Adjacent tests

Workflow support also changes tests outside the Workflow filename prefix:

| Source | Coverage |
|---|---|
| `packages/sdk/test/unit/orchestration-intake-1-0-83.test.mjs` | Carried intake shape, bounds and continue-as-new floor |
| `packages/sdk/test/unit/orchestration-intake-machine-1-0-83.test.mjs` | Pure intake state transitions |
| `packages/sdk/test/unit/orchestration-intake-wiring-1-0-83.test.mjs` | Intake calls wired into session orchestration |
| `packages/sdk/test/unit/orchestration-freeze-1-0-82.test.mjs`, `orchestration-registry-modules.test.mjs` | Frozen handler and exact module registration |
| `packages/sdk/test/unit/worker-shutdown-deadline.test.mjs` | Shutdown budget and release behavior |
| `packages/app/web/test/workflow-command-runtime.test.mjs`, `workflow-read-runtime.test.mjs`, `workflow-input-runtime.test.mjs`, `workflow-session-definitions-runtime.test.mjs` | RPC authorization, reader redaction, input denial and definition commands |
| `packages/app/web/test/workflow-base-instructions-owner.test.mjs`, `workflow-capabilities-bootstrap.test.mjs`, `workflows-always-on-routes.test.mjs` | Owner-only instructions and advertised/supported capabilities |
| `packages/app/mcp/test/unit/workflows.unit.mjs` | Person-mode MCP read/command mapping and refusals |
| `packages/app/ui/core/test/workflow-*.test.mjs`, `theme-workflow-colors.test.mjs` | Graph/panels, run selection, paging, input policy, controls, revisions, replay, wording, theme and responsive state |

Some UI tests still render unused legacy panels. Their presence is not evidence that the current Workflow tab exercises those components. See [legacy UI follow-up](known-issues.md#legacy-ui).

## Test runs are not a sandbox

A low-level test run executes its scripts normally. It intercepts framework tool calls, mocked agents, sends and requests. Real-agent test mode spends tokens and permits the model's own shell/file tools; MCP tools are refused. The run's deadlines use a virtual clock advanced explicitly. None of these rules undo a script's direct network or file effects. See `packages/sdk/src/workflow/test-mode.ts:15-43`.

The definition-test helper makes a hidden test bench and supplies prepared answers. It automatically advances virtual time only when every open step is waiting for a timer. An unmatched call fails with a fixture suggestion; a receive without a fixture or deadline is stuck. The default expected end is succeeded; an explicit `expect` can name a terminal or outcome. One call waits up to 240,000 ms, then returns a test ID for later reads. See `packages/sdk/src/workflow/definition-test.ts:1-26`, `:45-68`, `:104-165`.

The low-level interactive test surface is hidden unless `PILOTSWARM_WORKFLOW_TEST_MODE=on`. This flag is different from the agent-only definition-test operation, which remains in `workflow_definition`. See `packages/sdk/src/workflow/test-mode-switch.ts:1-36` and `packages/sdk/src/workflow/definition-tool.ts:38-57`.

## Formal models

The exhaustive [module inventory](formal-modules.md) lists all **73 modules**, their purpose, defined safety/progress predicates, active entry counts and recorded evidence. The [configuration summary](formal-configurations.md) groups the **1,109 active configurations** by entry module and links the source tables for their exact settings and retired cases. No `.cfg` files are committed; each is generated from a case record and module template.

| Folder under `docs/formal/` | Modules / active configurations at this commit | Scope and key obligations |
|---|---|---|
| `session-orchestration` | 19 / 184 | FIFO/turn commit, timers, child delivery, message identity, hydration notice, warm drop, owned retry, intake drain, give-back, version handoff, rolling deploy, author merge, forced refresh and shutdown |
| `workflow` | 7 / 129 | Run/effect winner, admission/KV pin, wait clock, lifecycle, parent commands, receive and send |
| `workflow/orchestration` | 9 / 294 | Graph, agent child, parent notice, recover, cleanup paging, pause, historical executor/lease and current tool share |
| `workflow/parallel` | 1 / 94 | First-k/all join, on-time commit order, cut branches, stop debt and pause |
| `workflow/fork-join` | 3 / 91 | Abstract named-fork contract, implementation refinement and alternative token design |
| `workflow/idle-wake` | 1 / 7 | Count wake/timer idle passes, bound history, preserve dequeued commands |
| `workflow/reminder` | 1 / 18 | Reminder cap and gate; no inappropriate send after stop or pending work |
| `workflow/continued-session` | 1 / 101 | Own-visit results/stops, replacement/end/deletion races, all owed ends and failed-turn reporting |
| `workflow/paired` | 8 / 42 | Independent request intent and code models; response identity, deadline, authority and wake refinement |
| `workflow/paired/recipient` | 19 / 113 | Claim/bind/cancel/turn/exposure protocol, old-code comparisons and code-to-intent mapping |
| `workflow/paired/request` | 4 / 36 | Durable-expiry design variants and strict witnesses |

Counts come from each folder's actual modules and `cases.tsv`, not the older counts embedded in README prose. A generated configuration contains its constants, specification, invariant/property lists, deadlock policy and optional view. Each module's summary links the relevant `cases.json` source so bounds remain inspectable.

### Meaning of the invariants

| Obligation | Representative predicates | Why it matters |
|---|---|---|
| A decided result stays decided | `Prop_ResultImmutable`, `Inv_DecidedOnce`, `Inv_FailOnlyWhenPending` | Late completion or failure cannot overwrite a winner |
| Admit only allowed work | `Inv_AdmitOnlyAdmitting`, `Inv_PinCurrent`, `Inv_OrdinalCountsAdmissions` | Pause/end/KV races do not create phantom visits |
| Keep commands across handoff | `Inv_CommandsKept`, `Prop_CommandsApplied` | A dequeued control cannot disappear at continue-as-new |
| Bound history | `Inv_HistoryBounded`, `Prop_ContinuesAsNew` | Repeated wakes must still reach an execution boundary |
| Keep child results on their visit | `Inv_ResultOwnVisit`, `Inv_NoTurnForDecided`, `Inv_ReplaceOnlyEnded` | Continued agent memory must not mix business results |
| Finish owed child work | `Prop_AllEnded`, `Prop_OwedSent`, `Prop_OrphanEnded` | A late spawn or failed end remains a cleanup obligation |
| Atomic fork decision | `Inv_CutOnlyWithDecision`, `Inv_NoSettleAfterStop` | A join cannot cut branches before its own decision or after an accepted stop |
| Keep a cancellation latch | `Inv_LatchOwnId`, `Inv_DoneLatchedRecorded`, `Prop_LatchStable` | Tombstone eviction or retry cannot erase a decided cancellation |
| Distinguish exposed from unsent | `Inv_TruthfulNotDispatched`, `Prop_EndAfterCancelRequested` | A cancel does not prove earlier processing never occurred |
| Preserve observed expiry | `Inv_NoDecisionAfterExpiry`, `Inv_NoObserveAfterExpiry`, `Inv_DeadlineB` | A backward clock step must not reopen an observed-expired request |

Each predicate's definition and line is linked in [formal-modules.md](formal-modules.md). Names that occur only in a wrapper's imported module remain visible through its configurations. Fairness assumptions are essential for progress properties; safety alone does not guarantee eventual delivery.

### Recorded TLC results

| Area | Last relevant results recorded in repository notes | Limit |
|---|---|---|
| Original session models | 2026-10-27: 38 cases, 21 pass and 17 expected failures; all predictions matched | Bound to older 1.0.82 code; failures include bugs, design limits and deliberate faults |
| Session changes | 2026-11-08: so2 16, so3 36, so5b 48, ws2 11, and latest-1.0.83 batch 50, each as expected | Different overlapping batches, not totals to add or a single current-head run |
| Workflow core | No complete run recorded in the folder's notes | Do not convert configured expectations into results |
| Workflow orchestration | r2-final: 158 of 160 as expected, two explained mismatches; later r3/r4 follow-ups; r4 fixes 79 of 79 as expected | Later cases and long liveness checks have their own notes |
| Parallel/reminder | 2026-11-04 p1-p5: 110 of 112 with reminder as predicted; model errors corrected/rechecked. Reminder r1: all 18 as predicted | No single complete current parallel run is recorded |
| Named fork-join | 2026-11-08 fj3: 91 as expected, 48 pass and 43 expected violations | Bounded graphs, not arbitrary graph proof |
| Idle-wake | 2026-11-08 so5b: 11 as expected | Four cases now retired with the old controller; seven active remain |
| Continued session | Earlier 89 cases all checked across batches, including two liveness cases finally passing with 3,600 s limit | Current inventory also contains later failed-turn cases |
| Terminal agent-turn failure | 2026-11-10 tf1: 63 then 72 as expected across `WfAgent`, `OwnedRetry` and `WfContinuedSession` | Group totals, bound through correspondence to `069eca30`, not per-module totals |
| Paired request | 2026-11-01/02: 14 of 42 run; three pass, seven expected violations, four partial | 28 not run; full-bound holds timed out |
| Recipient intake | 2026-11-01/02: 70 of 113 run; 23 pass, 46 expected violations, one model error | 43 not run; exposure code-to-intent refinement has no valid result |
| Request variant B | 2026-11-02: 21 of 36 run; four pass and 17 expected violations | Fifteen variant-A cases were not run; results do not transfer across variants |

Result sources: [formal overview](../../formal/README.md), [session notes](../../formal/session-orchestration/README.md), [orchestration notes](../../formal/workflow/orchestration/README.md), [continued sessions](../../formal/workflow/continued-session/README.md), [fork-join](../../formal/workflow/fork-join/README.md), [parallel](../../formal/workflow/parallel/README.md), [reminder](../../formal/workflow/reminder/README.md), [paired request](../../formal/workflow/paired/README.md), [recipient](../../formal/workflow/paired/recipient/README.md), and [variant B](../../formal/workflow/paired/request/README.md).

### Correspondence files

A **correspondence** maps model actions and invariants to source functions at a named commit. It records assumptions, abstractions, known differences and which changes invalidate the mapping. It is not executable equivalence checking of TypeScript or PostgreSQL.

| Correspondence file | Binding |
|---|---|
| `docs/formal/session-orchestration/CORRESPONDENCE-e76a6133.md` | Hydration notice and snapshot warm-drop boundary |
| `docs/formal/session-orchestration/CORRESPONDENCE-e76a6133-so3.md` | Owned retry, intake drain and shutdown |
| `docs/formal/session-orchestration/CORRESPONDENCE-bb162ed8-so5b.md` | Carried digest/notice give-back |
| `docs/formal/session-orchestration/CORRESPONDENCE-bb162ed8-ws2.md` | Shutdown deadline and overlap |
| `docs/formal/session-orchestration/CORRESPONDENCE-latest-1083.md` | Frozen 1.0.82 to current 1.0.83 paths, handoff, refresh and merge |
| `docs/formal/workflow/fork-join/CORRESPONDENCE-cf2a3141.md` | Named-branch implementation and atomic join/stop fixes |
| `docs/formal/workflow/continued-session/CORRESPONDENCE-069eca30.md` | Continued-agent lifecycle and visit fences |
| `docs/formal/workflow/orchestration/CORRESPONDENCE-tf1-069eca30.md` | Terminal agent-turn failure across three models |

The paired model folders additionally use `CODE-MODEL`, `CODE-AUTH-AUDIT`, `CLOCKFIX`, `W2-*`, `EXPOSURE-*`, `CANCEL-ORDER` and `SPEC-CANDIDATE-*` notes for their mappings. Their filenames and roles are indexed in their READMEs. Earlier pins can refer to old paths/names; those references must not be read as line numbers at `4fa702dc`.

### How TLC is run

TLC runs locally or on demand through each folder's `run-tlc.sh`. **It does not run in CI.** The runner requires Java 17 or later, Python 3 and a SHA-256-pinned `tla2tools.jar` v1.7.4 (TLC 2.19). It generates `.cfg` files using `docs/formal/tlc_cases.py`, checks inputs, runs SANY on entry modules, then runs each case with two TLC workers, a 2 GiB heap and a default 300 s case limit. See `docs/formal/workflow/run-tlc.sh:1-31`, `:49-70` and `docs/formal/README.md:67-104`.

```sh
cd docs/formal/workflow/fork-join
TLA_TOOLS=<directory-containing-tla2tools.jar> ./check-packet.sh
TLA_TOOLS=<directory-containing-tla2tools.jar> ./run-tlc.sh <output-directory>
```

The shell script's success is not the verdict. Read `executions.tsv`, each `tlc.log`, and the expected property in `cases.json`. Exit 0 is a bounded completed search without violation; 12 is safety violation; 13 is liveness violation; 124 is timeout and therefore partial. Other setup/model errors are void. An expected counterexample must reach the intended property and cause. See `docs/formal/workflow/run-tlc.sh:9-11`, `:34-70`.
