# Workflow `session: continue` in Named Parallel Branches (I8)

**Status:** **IMPLEMENTED** (2026-11-27)
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

- **Formal Verification (TLA+ / TLC 2.19):** `docs/formal/workflow/continued-session/WfBranchContinuedSession.tla` and `CORRESPONDENCE-i8-0f80ee3c.md` — 14/14 cases as expected (5 safety/liveness PASS up to 2,700,838 distinct states, 2 `OrderByNodeOrdinalOnly` faults violated, 7 non-vacuity witnesses reached).
- **Unit & UI Suites:** SDK unit suite (`3,141` passed, `0` failed, `1` skipped) + App suite (`test:tui` 99, `test:web` 293, `test:ui` 2,139 incl. `workflow-branch-visit-order.test.mjs`, `test:mcp` 3).
- **Database Integration:** Targeted PG16 (`53/53` across 4 local test files including real worker + scripted model I1 memory recall, branch cuts, outer-loop re-entry + Q5 stop, cross-fork replacement, and `WORKFLOW_STORE_CORRUPT`) + targeted HorizonDB verification.
