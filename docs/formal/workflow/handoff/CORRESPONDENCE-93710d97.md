# ControllerHandoff correspondence to 93710d97 (FB-064, candidate)

Code at `93710d9768b4c281ae2afbcad6e8941395175c15` (`waldemort/valkyrie-fb064-can-latest`, base `f44a8640`): `ad2237f7`
(tests, red first) and `93710d97` (the change and documents). Paths are under `packages/sdk/`; line numbers are at
`93710d97`.

Study: Fable, `fb064-controller-upgrade-study.md` (sha256 `ee007c3f`), read at `f44a8640` and Duroxide `36b789d8`.

## Obligations

| Obligation | Evidence at 93710d97 |
|---|---|
| O1. The continue-as-new target is not replayed | Duroxide core 0.1.32: `OrchestrationContinuedAsNew` stores only the input (`lib.rs` 1248); the action never becomes a history event (`replay_engine.rs` 1767-1770); a closed execution is never run again; the next execution's version is resolved from the work item and recorded in its own `OrchestrationStarted` (`dispatchers/orchestration.rs` 1081-1141, `state_helpers.rs` 517-528). So changing the target a frozen handler passes cannot cause nondeterminism. `test/helpers/workflow-controller-history.mjs` compares the continue-as-new input and asserts the target is the latest version; the recorded fixture is unchanged |
| O2. Same input | `src/workflow/controller_1_0_0/runtime.ts` and `src/workflow/controller/runtime.ts` are unchanged from `f44a8640`; `ControllerInput`, `ControllerState`, `parseControllerInput` and `parseControllerState` are text-identical in the two trees. `test/unit/workflow-controller-handoff.test.mjs` 88-101: the latest parser equals the 1.0.0 parser on every recorded input and four synthetic shapes |
| O3. Same behaviour for plans 1.0.0 can admit | The generators differ only on approval states (bound at `163007b5`); the frozen `index.ts` differs from `f44a8640` only in the latest import (2), one comment and the target (320). `workflow-controller-handoff.test.mjs`: 107 replays each recorded 1.0.0 continue-as-new input on the latest handler and requires the recorded 1.0.0 `*-resumed` schedule; 311-318 run frozen 1.0.0 and the latest handler in lockstep from the start to the continue-as-new (the same schedule), then the latest handler from 1.0.0's continue-as-new input to the end, at a pending request, a pending agent, a parallel with running branches, owed cuts, an accepted stop and the admission limit. The 1.0.0 side is the frozen copy, bound to main `8aa84d2c` by the freeze correspondence (`CONTROLLER-VERSIONING-163007b5.md`), not a fresh recording of main |
| O4. Gates on the admission version | No activity, store or approval code changes (`git diff f44a8640 93710d97 -- src/workflow/runtime.ts src/workflow/store.ts src/workflow/approval.ts src/workflow/carry.ts` is empty): the carry gates (`runtime.ts` 1884, 2034) and approval gates (1987, 2288, 3739; `store.ts` 3873, 3889; `approval.ts` 143) read `run.controllerVersion`. Model: `Inv_GateHolds`, `Inv_NoCarryNull`, `Inv_ApprovalGated` |
| O5. Dispatch | `requireRunsController` (`src/workflow/service.ts` 310) is unchanged: start and recovery create only the first execution, at the stored version; every later execution runs on the latest. The stored version is documented as the admission version only (`service.ts` 304-308, `controller-features.ts`, `controller-version.ts`) |
| O6. Freeze rule | Both trees value-import `WORKFLOW_CONTROLLER_VERSION as WORKFLOW_CONTROLLER_LATEST_VERSION` from `../controller-version.js` (line 2) and use it only at the target (frozen 320, live 332). `test/unit/workflow-controller-freeze-1-0-0.test.mjs` 26-88 pins that one import line, its single use and the new `index.ts` hash `b0f5516d`; `runtime.ts` keeps the `"1.0.0"` literal (84) |
| O7. Never move down | `src/workflow/controller-registry.ts` 33-41: at load, no registered version may be newer than the target; tested with a downgrade (`workflow-controller-handoff.test.mjs` 43). Model: `Inv_NeverDown` |
| O8. Limits | Documented (`working-on-pilotswarm.md`, `.github/copilot-instructions.md`, `CHANGELOG.md`): a moved run cannot run on 0.8.11, so deploys stay stop-all; a run that ends before its first continue-as-new finishes on 1.0.0; the 1.0.0 feature entry outlives its handler; a 0.8.11 worker admitting carry IR beside the new build stays safe only because the gate reads the admission version |

## Model

`ControllerHandoff.tla`, batch ch2 (2026-11-13 22:57Z): 13 of 13 as expected. A 1.0.0 run moves to 1.1.0 at
continue-as-new; with gates on the admission version a 1.0.0 run keeps raw routing (`Inv_GateHolds`) and gets no carry
envelope without a snapshot (`Inv_NoCarryNull`); a 1.0.0 approval plan fails at its first parse, before any
continue-as-new (reached, `wit.ch-approval-fails-at-parse`); gating on the execution version breaks both carry
properties and, under a hypothetical lenient parser, activates an approval (`mut.ch-approval-gate-exec`); a downgrade
breaks `Inv_NeverDown`. The carry (`ca2`) and approval (`ap4`) results stand: their gates are unchanged.

## DEV results (Valkyrie, 2026-11-13)

At `ad2237f7` (the tests on the base code) every failure is the continue-as-new target: replay 29 of 31 (the 1.0.0 idle
and paused continue-as-new targeted 1.0.0), idle-wake-can 6 of 7, freeze 5 of 7, and the real-Duroxide case started
execution 2 at `"1.0.0"`. At `93710d97`: hand-off 10 of 10, replay 31 of 31, freeze 7 of 7, idle-wake-can 7 of 7,
live-contract 2 of 2, approval-controller 7 of 7, pause-wake 3 of 3; the real-Duroxide case ran execution 1 at 1.0.0 and
execution 2 at 1.1.0, ended completed, and kept `controller_version` 1.0.0.

## Verdict

Bound at `93710d97`. Any production change after this pin needs a re-read; test or document changes need only a
re-pin with `packages/sdk/src` unchanged.

Re-pinned to `13857fd2ba67fa3afc140d6c7837aba32aa5e4ba`: this formal patch and one index paragraph on `93710d97`;
`packages/sdk/src` (tree `13c9907a`) and `packages/sdk/test` (tree `65e6f354`) are identical to `93710d97`. Bound.
