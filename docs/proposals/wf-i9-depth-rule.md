# Session & Workflow Depth Rule (`effectiveLevel`)

**Date:** 2026-11-27
**Status:** **IMPLEMENTED** (2026-11-27)

## Summary

PilotSwarm now enforces one unified session and Workflow nesting rule (`effectiveLevel`) across all four depth checks, refusal messages, user documentation, and Workflow skills:

> **In one sentence:** Nothing goes past level 2. Each sub-agent or Workflow is one level below whoever started it, but the first Workflow in a chain is free, and an agent step sits at its Workflow's level.

## Motivation

Previously, every Workflow session incremented nesting depth by `+1`, and four separate code paths computed depth inconsistently:
1. Inline `spawn_agent` (`spawnNesting` in `packages/sdk/src/workflow/input-policy.ts`) used `computeSessionLevel`, counting `+1` for every Workflow and `+0` for agent steps.
2. Workflow Start / `spawn` steps (`requireWorkflowStartLimits` in `packages/sdk/src/workflow/session-definitions.ts`) called `SessionDefinitionStore.nestingLevel`, which counted raw parent hops in SQL.
3. Workflow agent-step creation (`sessionLevel` in `packages/sdk/src/workflow/agent-host.ts`) walked `catalog.getSession` (which filters `deleted_at IS NULL`, hiding soft-deleted ancestors) and counted `+1` for every parent hop.
4. The fallback orchestration `spawn_agent` path (`handleSubAgentAction` in `packages/sdk/src/orchestration/agents.ts`) checked `runtime.options.nestingLevel + 1 > MAX_NESTING_LEVEL` without reading stored lineage.

As a result, an agent step inside a child Workflow (`person -> batch Workflow -> child Workflow -> agent step`) sat at level `2` and could not spawn a sub-agent (such as an independent reviewer).

## Design

### Pure `effectiveLevel` Contract (`packages/sdk/src/workflow/input-policy.ts`)

- `SessionLevelNode` requires `sessionId`, `parentSessionId`, `isWorkflow: boolean`, `isSystem: boolean`, and optional `isAgentStep?: boolean`.
- `effectiveLevelDetail(chain)` walks a leaf-to-root chain up to its **segment root** (`isSystem === true || parentSessionId === null`), returning `null` on empty, cyclic, or rootless chains. Walking root-to-leaf:
  - Segment root starts at `level = 0`, `hasWorkflow = Boolean(root.isWorkflow && !root.isSystem)`.
  - An agent step (`isAgentStep === true`) adds `+0`.
  - The first Workflow in the segment (`isWorkflow === true && !hasWorkflow`) adds `+0` and sets `hasWorkflow = true`.
  - Every subsequent Workflow and every sub-agent adds `+1`.
- `effectiveChildLevel(parent, childKind)` evaluates a proposed `"sub_agent"`, `"workflow"`, or `"agent_step"` child with the exact same rule.
- `SESSION_MAX_NESTING_LEVEL` stays `2`. Chains without a Workflow do not change behavior or refusal text.

### All Four Checks Unified (No Orchestration Version Bump)

1. **Inline `spawn_agent` (`packages/sdk/src/session-proxy.ts`, `spawnNesting`):** uses `lineage.level` for every readable lineage, fails closed on `lineage.level === null`, and passes `lineage.level` and `Boolean(lineage?.agentRoot || lineage?.hasWorkflow)` to `spawnNestingRefusal`.
2. **Workflow Start & `spawn` steps (`packages/sdk/src/workflow/session-definitions.ts`):** `requireWorkflowStartLimits` reads `host.store.readWorkflowLineage(ownerSessionId)`, fails closed with `WORKFLOW_NESTING_LIMIT` on `null` or broken lineage, computes `callerLevel = Math.max(lineage.level, Number.isSafeInteger(given) ? given : 0)` and `workflowLevel = effectiveChildLevel({ level: callerLevel, hasWorkflow }, "workflow")`, and refuses `workflowLevel > 2`. `SessionDefinitionStore.nestingLevel` delegates to `effectiveLevel` in TypeScript.
3. **Agent-step creation (`packages/sdk/src/workflow/agent-host.ts`, `milestone-worker.ts`):** `workflowMilestoneAgentNodes` wires `readLineage` to `WorkflowStore.readWorkflowLineage` (preserving soft-deleted ancestors), and `sessionLevel` uses `effectiveLevel` with `isWorkflow` and `isSystem`.
4. **Fallback `spawn_agent` (`captureSpawnToolsV1` in `packages/sdk/src/session-proxy.ts`):** enforces stored-chain `effectiveLevel` at the top of the `captureSpawnToolsV1` activity before `sessionManager.captureSpawnTools` (covering warm and cold parents alike) and throws `CapabilityGrantError(spawnNestingRefusalReason(...))`, which `orchestration/agents.ts` turns into `[SYSTEM: spawn_agent failed: ...]`. `packages/sdk/src/orchestration/` remains byte-identical with no orchestration freeze or version bump.

### Verification Matrix (14 Chains)

| # | Chain (`raw / effective`) | Verdict |
|---|---|---|
| 1 | `person 0 -> sub 1 -> sub 2` | Allowed (`2`) |
| 2 | `person 0 -> sub 1 -> sub 2 -> sub 3` | Refused (`3 > 2`, ordinary text) |
| 3 | `person 0 -> Workflow 1/0 -> step 1/0 -> sub 2/1` | Allowed (`1`) |
| 4 | `person 0 -> Workflow 1/0 -> step 1/0 -> sub 2/1 -> sub 3/2` | Allowed (`2`) |
| 5 | `person 0 -> Workflow -> step -> sub -> sub -> sub 4/3` | Refused (`3 > 2`, Workflow text) |
| 6 | `person 0 -> Workflow 1/0 -> Workflow 2/1 -> step 2/1` | Allowed (`1`) |
| 7 | `person 0 -> Workflow 1/0 -> Workflow 2/1 -> step 2/1 -> sub 3/2` | Allowed (`2`) |
| 8 | `person 0 -> Workflow -> Workflow -> step -> sub -> sub 4/3` | Refused (`3 > 2`, Workflow text) |
| 9 | `person 0 -> sub 1 -> Workflow 2/1 -> step 2/1 -> sub 3/2` | Allowed (`2`) |
| 10 | `person 0 -> sub 1 -> Workflow -> step -> sub -> sub 4/3` | Refused (`3 > 2`, Workflow text) |
| 11 | `person 0 -> Workflow 1/0 -> Workflow 2/1 -> Workflow 3/2` | Allowed (`2`; step cannot delegate; 4th Workflow refused) |
| 12 | `person 0 -> sub 1 -> Workflow 2/1 -> Workflow 3/2` | Allowed (`2`; step cannot delegate) |
| 13 | `person 0 -> sub 1 -> sub 2 -> Workflow 3/2` | Allowed (`2`; step cannot delegate) |
| 14 | `person 0 -> sub 1 -> sub 2 -> Workflow 3/2 -> Workflow 4/3` | Refused (`WORKFLOW_NESTING_LIMIT`) |

### Verification Gates

- Unit & bounded exhaustive property tests across all legal delegation chains up to length 6 (plus root Workflows, system resets, cycles, and depth > 32).
- Targeted PostgreSQL 16 and HorizonDB integration runs covering all 14 chains, soft-deleted ancestors, system resets, and Check 4 fallback.
- Skill frontmatter/byte-budget validation and live-model positive/negative checks.
