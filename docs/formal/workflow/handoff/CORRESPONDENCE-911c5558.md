# ControllerHandoff correspondence to 911c5558 (controller 1.2.0, batch ch3)

Code at `911c55582f08b4165ed58d4a0884a6610137e46b` (PR 328 head `2e940637` and one proposal commit; `packages/` is
identical at both). 1.1.0 is frozen and 1.2.0, which adds the Decision state, is the latest (`e67cd92c`, "freeze
controller 1.1.0 and move Decision to 1.2.0", and `62b8e6b2`). Paths are under `packages/sdk/`; line numbers are at
`911c5558`. The FB-064 rows of [`CORRESPONDENCE-93710d97.md`](CORRESPONDENCE-93710d97.md) still hold for 1.0.0; this
note adds the third version.

## Obligations

| Obligation | Evidence at 911c5558 | Model |
|---|---|---|
| O1. The continue-as-new target is not replayed | Unchanged from 93710d97 (Duroxide core). Every tree passes the shared latest constant: `src/workflow/controller_1_0_0/index.ts` 2 and 319-320, `controller_1_1_0/index.ts` 2 and 331-332, `controller/index.ts` 2 and 332-333 | `CAN` with `Latest = 2` |
| O2. Same input | `ControllerInput` and its parsers are unchanged; `test/unit/workflow-controller-handoff.test.mjs` 93-109 compares the latest parser with the 1.0.0 and 1.1.0 parsers on every recorded input, the 1.2.0 Decision recordings included | not modeled (source and tests) |
| O3. 1.1.0 is frozen as released; 1.2.0 differs only by the Decision | `src/workflow/controller_1_1_0/index.ts` is byte-identical to the released live `controller/index.ts` at `87b89d9f` (PR 305; the same at the PR base `b71f78d2`); its `runtime.ts` differs only by the literal `"1.1.0"` (84) in place of the latest re-export. Live 1.2.0 differs from frozen 1.1.0 only by the entry name, the Decision dispatch (`controller/index.ts` 782-791), the Decision effect version (`controller/runtime.ts` 93), the `runDecision` activity name and the `decision` plan node type (483). `test/unit/workflow-controller-freeze-1-0-0.test.mjs` 23-33 pins both frozen trees; the hand-off test runs frozen 1.0.0 and 1.1.0 in lockstep with 1.2.0 to and from every continue-as-new point (254-455, 13 scenarios) | `Enter` (no Decision dispatch below 1.2.0) |
| O4. Gates read the admission version | `src/workflow/controller-features.ts` 21-23: 1.2.0's entry is 1.1.0's (carry and approval). The carry gates (`src/workflow/runtime.ts` 1938, 2088) and approval gates (2041, 2351, 3967) read `run.controllerVersion`. No activity gates the Decision on any version | `Feature`, `Feature120`, `Inv_GateHolds`, `Inv_CarryKept`, `Inv_ApprovalGated` |
| O5. Dispatch | `requireRunsController` (`src/workflow/service.ts` 320-325) starts and recovers a run's first execution at its stored version; admission stores the latest (434, 1830) | `Init`, `Begin` |
| O6. The frozen parsers refuse a Decision plan | `src/workflow/controller_1_0_0/runtime.ts` 474 and `controller_1_1_0/runtime.ts` 477 (`plan node … type is invalid`); live 483 accepts `decision`. Each execution parses the plan first (`index.ts` 286-287 in each tree). Tested: `test/unit/workflow-controller-replay.test.mjs` "the frozen 1.1.0 parser accepts a script plan, not a Decision plan" | `Parses`, `Inv_DecisionAdmitted`, `wit.ch3-110-decision-fails-at-parse` |
| O7. Never move down | `src/workflow/controller-registry.ts` 31-43 | `Inv_NeverDown`, `mut.ch3-down` |

## Model rows

| Model action or definition | Code | Label |
|---|---|---|
| `Latest = 2`, versions 0, 1, 2 | `src/workflow/controller-version.ts` 5-7 | Code behavior |
| `Feature(v)`, `Feature120 = TRUE` | `src/workflow/controller-features.ts` 18-24 | Code behavior; `Feature120 = FALSE` is a mutant |
| `Parses(v)` | the three `parsePlan` node-type checks above | Code behavior; `LenientParse` is hypothetical |
| `Enter` of a Decision state on an execution below 1.2.0 fails | unreachable: the frozen parsers refuse the plan first | Model simplification (reached only under `LenientParse`) |
| `Enter` of a Decision state on 1.2.0 | `src/workflow/controller/index.ts` 781-791 (its effect and test interception are in [`../decision/`](../decision/README.md)) | Code behavior |
| `Inv_DecisionAdmitted` | no admitted run below 1.2.0 holds a Decision plan: no released compiler admitted one, and the frozen parsers refuse it | Rule to evaluate |

## Model

`ControllerHandoff.tla`, batch ch3 (2026-11-20): 17 cases as expected; the 13 FB-064 rows (with `Latest = 1`) re-run
with their recorded state counts. A 1.0.0 or 1.1.0 run moves to 1.2.0 at continue-as-new; a 1.1.0 run keeps carry and
approval after the move; a 1.0.0 or 1.1.0 run whose plan has a Decision state fails at its first plan parse; a 1.2.0
run dispatches its Decision on a 1.2.0 execution. The Decision has one guard, the frozen parsers: under a hypothetical
lenient parser a 1.1.0 run crosses to 1.2.0 and its Decision is dispatched (`cmp.ch3-110-decision-lenient`). This is
safe because no released build admitted a Decision plan below 1.2.0; a future version that lets an older admission
hold a Decision plan would need an admission gate as approval has.

## Verdict

Bound at `911c5558`. Any production change after this pin needs a re-read; test or document changes need only a
re-pin with `packages/sdk/src` unchanged.
