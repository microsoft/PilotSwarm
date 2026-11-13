# Workflow controller versioning: correspondence at 163007b5

The controller freeze is bound at `163007b5` on base `d0f5571b`. Its commits are `11b449d6` (instructions and docs),
`6ae45da2` (pure freeze of controller 1.0.0 from main `8aa84d2c` into `workflow/controller_1_0_0/`) and `163007b5`
(live controller 1.1.0 in `workflow/controller/`). The same source was reviewed at `67f64ae7` and `6be0c18b`:
`git range-diff` shows the two implementation commits at `6be0c18b` unchanged at `163007b5`.
`packages/sdk/src/` is identical across all three heads; `packages/` is identical between `6be0c18b` and `163007b5`.
The difference from `67f64ae7` to `6be0c18b` includes regression-test changes, not production source. Paths are under
`packages/sdk/`; line numbers are at `163007b5`.

This is a behavior-preserving extraction. The models are unchanged, and their earlier TLC results are kept.

## The five obligations

| Obligation | Evidence at 163007b5 |
|---|---|
| 1. Frozen 1.0.0 is the released source | `src/workflow/controller_1_0_0/index.ts` and `runtime.ts` equal main `8aa84d2c` after the entry rename, export markers and relocation of the retry constant and imports. They import only `./runtime.js` and type-only `duroxide`. `WORKFLOW_CONTROLLER_VERSION = "1.0.0"` is a literal (`controller_1_0_0/runtime.ts` 84). `test/unit/workflow-controller-freeze-1-0-0.test.mjs` pins the file hashes, the import fence and the registry as sole importer |
| 2. Live 1.1.0 is the bound generator | `src/workflow/controller/index.ts` equals the bound 1.1.0 generator at `a684aab3` with the approval gate resolved true, the version fixed and the entry renamed. The only difference from frozen 1.0.0 is the approval branches: `elapseDue` (287-298), `enterApproval` (651) and approval interception (705-710). `test/unit/workflow-controller-live-contract.test.mjs` checks helper and registry-name parity |
| 3. A run keeps its admitted version | Admission stores `WORKFLOW_CONTROLLER_VERSION` = 1.1.0 (`src/workflow/service.ts` 411, 1571). `requireRunsController` (309-314) reads the stored version and refuses one this build does not run. `src/workflow/controller-registry.ts` maps 1.0.0 and 1.1.0 to their handlers; `src/workflow/runtime.ts` 1521-1522 registers them. Each generator continues as new at its own version (`controller_1_0_0/index.ts` 316-318; `controller/index.ts` 328-330). New versions reach only new runs |
| 4. Shared activities read the run's version | Carry: `src/workflow/runtime.ts` 1884 (arrival) and 2034 (entry snapshot). Approval: 1987 (entry), 2288 (deadline) and 3739 (interception); `src/workflow/store.ts` 3873 and 3889. None reads the worker's latest version. The activity names and inputs that 1.0.0 schedules are main's |
| 5. Recorded schedules replay identically | `test/unit/workflow-controller-replay.test.mjs` with `test/fixtures/workflow-controller-history.json`: 30 recorded histories (1,208 scheduled tasks) from main 1.0.0 and the bound 1.1.0, compared task by task. They cover cold starts, retry and cancel, continue-as-new and resume, the carry-related routes, and approval accept, timeout, test, paused and continue-as-new. This is bounded evidence, not every reachable resume point |

## Models kept

| Model | Result kept | What it binds here |
|---|---|---|
| `approval/WorkflowApproval.tla` | ap4: 35 of 35 as expected (TLC 2.19, two workers). Largest: `ap2.design-contract` 14,914,368 distinct states, depth 27; `ap2.design-loop` 1,092,636; `ap.live` 179,034 | `Gate` is the run's controller version: frozen 1.0.0 refuses an approval IR before admission; live 1.1.0 and the shared approval guards accept it only for a 1.1.0 run |
| `carry/WorkflowCarry.tla` | ca2: 17 of 17 as expected. `ca2.gate-off` 17,796 distinct states; `fault.ca2-gate-ignored` violates `Inv_GateHolds` in 3 steps | `Carry == OptIn /\ Gate`: the shared entry and arrival skip carry for a 1.0.0 run by its stored version |

Row-level mappings: `approval/CORRESPONDENCE-163007b5.md` and `carry/CORRESPONDENCE-163007b5.md`, which extend
`CORRESPONDENCE-004eff4e.md` in each folder.

## Scope

- Bound: same-version dispatch, recovery and continue-as-new; the run-version guards in the shared activities.
- Superseded by FB-064 (`handoff/CORRESPONDENCE-93710d97.md`): a running Workflow now moves to the latest controller at
  continue-as-new, as sessions do. It is modeled in `handoff/ControllerHandoff.tla` (ch2, 13 of 13); the gates stay on
  the admission version. The same-version continue-as-new rows above describe `163007b5` only.
- When 1.1.0 is frozen, its frozen copy keeps the literal `"1.1.0"` in `runtime.ts`. Since FB-064, its `index.ts` may
  value-import `controller-version.ts` once, for the continue-as-new target only (the freeze test pins that line).
- A later docs-only commit that adds these notes and updates the formal indexes retains this source pin if
  `git diff 163007b5 <final> -- packages/` is empty. It does not require a self-referential correspondence filename.
- The recorded histories are selected single-state scenarios. They do not cover every parallel, receive, run-expiry,
  graceful-stop, catch-all, delete/done, invalid-terminal or multi-cursor history. Separate local regressions and
  source identity provide additional evidence, not an exhaustive replay proof.
- The existing stop-all/deploy/start rule remains required: shared activities are not dispatched by controller
  version. This extraction does not make a mixed-version rollout safe.
