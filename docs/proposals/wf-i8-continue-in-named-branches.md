# Workflow `session: continue` in Named Parallel Branches (I8)

**Status:** **Proposed (built ahead of owner sign-off)** (2026-11-27)
**Target Repository:** `microsoft/PilotSwarm`

## Summary

Allow `session: continue` on `type: agent` states inside **named parallel branches** (`states.<parallelId>.branches.<branchName>.states.<stateId>`), giving one durable continued agent session per `(runId, stateId)` that preserves conversation memory across both intra-branch loops and outer-loop re-entries of the enclosing `parallel` state.

- **Compiler (`packages/sdk/src/workflow/compiler.ts`):** Accepts explicit `session: continue` inside named `branches:`. Keeps `session: new` as the default when `session:` is omitted in named branches (preserving `irSha256` and child-budget behavior for existing definitions re-compiled on Start) and keeps `forEach` bodies refused with `WORKFLOW_FIELD_INVALID`.
- **Runtime (`packages/sdk/src/workflow/runtime.ts`):** Reuses the single deterministic continued-session ID formula `workflowAgentSessionId(runId, stateId[, visit])` (`agent-ids.ts` unchanged; `stateId` is already Workflow-unique). Adds a `WORKFLOW_STORE_CORRUPT` guard in `enter` rejecting `session: continue` in non-named branch scopes (`scopeId !== ROOT_SCOPE && !branch?.name`).
- **Store (`packages/sdk/src/workflow/store.ts`):** Joins the enclosing parallel execution `p` parsed from `n.scope_id` (`<parallelNx>#<index>`) and ranks continued-session visits by `(COALESCE(p.ordinal, 0), n.ordinal, i.created_at, i.node_execution_id)` across all five continued-session queries (`readWorkflowLineage`, `readAgentInvocationByChild`, `readTurnVisit`, `readAgentVisitsBefore`, `listAgentInvocationsOfState`) so outer-loop `parallel` re-entries (which reset per-scope `n.ordinal` to `1`) preserve cycle numbering, replacement IDs, and graceful-stop (`Q5`) semantics.
- **Portal UI (`packages/app/ui/core/src/workflow-view.js`, `workflow-agent-log.js`, `workflow-node-summary.js`):** Exports `workflowVisitRank(execution, executions)` and `compareWorkflowVisitRank`, stamps `parallelOrdinal` in `projectWorkflow`, wires composite ranking across `nodeView`, Agent Log (`workflowAgentLogVisits`, transcript split, Base instructions carry), and Node Summary (`lastEnded`, `chatOf`), and shows ` · cycle N` in the Agent Log header on re-entered forks.
- **Zero schema, IR, or version bumps:** No SQL migrations; `WORKFLOW_IR_VERSION = 1` and `WORKFLOW_CONTROLLER_VERSION = "1.3.0"` stay unchanged.

## Upgrade & Rollback

- Any definition revision saved invalid before this change (using `session: continue` in `branches:`) remains `valid: false` until saved as a new revision.
- Worker rollouts remain stop-all: pre-I8 workers lack composite visit ordering and refuse `session: continue` in `branches:` when recompiling YAML on Start.

## Verification

- **Formal Verification (Gate 1 — TLA+ / TLC 2.19):** `docs/formal/workflow/continued-session/WfBranchContinuedSession.tla` and `CORRESPONDENCE-i8-0f80ee3c.md` — 15/15 cases as expected (6 safety/liveness PASS up to 4,211,022 distinct states on `i8.fix-two-branch-outer-safety`, 2 `OrderByNodeOrdinalOnly` faults violated, 7 non-vacuity witnesses reached).
- **Database Integration (Gate 2 — PG16 & HorizonDB):** Targeted 4-file suite (`workflow-branch-session-continue-store.test.js`, `workflow-branch-session-continue.test.js`, `workflow-branches.test.js`, `workflow-simplified-session-continue.test.js`) passed **53/53** on PostgreSQL 16 and **53/53** on live HorizonDB (PG 17.11, `uselibpqcompat=true`), covering real-worker I1 memory recall, branch cuts (pending vs post-report), outer-loop re-entry + Q5 mixed graceful stop, cross-fork replacement, and `WORKFLOW_STORE_CORRUPT`.
- **Skills & Live-Model Eval (Gate 4):** `workflow-authoring/SKILL.md` (`-5` bytes, `20,473 <= 20,480`) and `workflow-reference/SKILL.md` (`-9` bytes, `20,471 <= 20,480`) verified with `workflow-guidance` and `workflow-composition-guidance` unit suites plus live-model positive (named `branches:` with `session: continue`) and negative (`forEach` with `session: new` and refusal comment) checks.
- **Unit & Portal UI Suites (Gate 5):** SDK unit suite (`3,141` passed, `0` failed, `1` skipped) + App suite (`test:tui` 99, `test:web` 293, `test:ui` 2,139 including `workflow-branch-visit-order.test.mjs` with React `WorkflowAgentLog` render order check, `test:mcp` 3).
