---
name: tla-formal-validation
description: Required for any change to the core orchestrations (the durable session orchestration, session hydration and dehydration, and the Workflow controller and store). Teaches how to model the change in TLA+, update the existing models, run TLC with the repo runner, read the results, turn a counterexample into a fix and a regression test, and record the binding to the code.
---

# TLA+ formal validation of the orchestrations

PilotSwarm has two core orchestrations, the durable session orchestration and the Workflow
controller, and a session hydration and dehydration path that moves a session between workers.
All three are durable, replayed and concurrent. A change to any of them must be checked with
TLA+ before it ships. The models live in
[`docs/formal/`](../../../docs/formal/README.md); that index maps each area to its models,
its code, the head the models are bound to, and the last full run.

A TLC result is a **bounded** check of a **model**. It is never a proof that the code is
correct. Say what was checked, at which bounds, against which code head, and what was not.

## When this skill is required

Use it for any change that adds, removes, reorders or changes the meaning of a durable step,
a store transaction, a lock, a compare-and-swap, a timer, a retry, a cancellation or a
lifecycle rule in:

| Orchestration | Code | Models |
|---|---|---|
| Durable session orchestration | `packages/sdk/src/orchestration.ts`, `packages/sdk/src/orchestration/`, frozen `orchestration_*.ts` / `orchestration_*/`, `orchestration-registry.ts`, and the durable contracts of their activities | `docs/formal/session-orchestration/` |
| Session hydration and dehydration | the dehydrate, hydrate and checkpoint activities and the snapshot commit in `packages/sdk/src/session-proxy.ts` and `session-manager.ts`; the orchestration's dehydrate and rehydrate paths (the hydration section of `orchestration/lifecycle.ts`); `shouldRehydrate` timers; rehydration messages carried across continue-as-new; the blob and session-store contracts they rely on | `docs/formal/session-orchestration/` (the rehydration notice, timers and the snapshot step); add a module there, or a new folder for a larger change |
| Workflow controller and store | `packages/sdk/src/workflow/controller/`, frozen `workflow/controller_*/`, `controller-registry.ts`, `controller-version.ts`, shared activities and helper orchestrations in `runtime.ts`, `store.ts`, `parallel.ts`, run admission in `service.ts`, the test-run (definition-test) path and the agent-host spawn path | `docs/formal/workflow/**` |

A new orchestration version always needs this skill (see the "New orchestration version"
step in `.github/copilot-instructions.md`). Pure UI, docs, prompts and logging changes that
touch no durable step do not.

A change of the latest version also needs it: model the hand-off from the previous latest
(what its continue-as-new input carries, what the new version reads, the KV it shares,
unread queue messages, and a history in flight that must still replay on its own version),
and how the deploy reaches it (duroxide does not route by version, so a worker without the
new version fails its items after repeated attempts). `VersionHandoff` and `RollingDeploy`
in `docs/formal/session-orchestration/` are the pattern.

Apply that same discipline to Workflow controller versioning. The current Workflow
contract pins each run at admission: start, recovery and continue-as-new retain
`workflow_runs.controller_version`. Unlike session orchestration, changing the latest
controller does not migrate existing runs. This stored version is the stamp; there
is no source-version migration. A mid-life routing change would alter the admitted
definition's meaning: honoring carry on a 1.0.0 run breaks its gate invariant. New
versions reach only new runs, and a frozen version stays registered while an admitted
run can still be live, recover or replay. Each registered version must replay every
history it admitted. Frozen `workflow/controller_<version>/`
code must contain its own version literal and may not import the live
`controller-version.ts` or live generator helpers. See the
[controller procedure](../../../docs/developer/contributing/working-on-pilotswarm.md#changing-the-workflow-controller-orchestration)
and [Duroxide's versioning best practices](https://github.com/microsoft/duroxide/blob/main/docs/versioning-best-practices.md).

A behavior-preserving controller extraction can retain existing model results only
when correspondence at the exact new head establishes all five obligations:

1. Every frozen declaration matches the released source, allowing only relocation,
   handler renaming and the historical version literal. Imports stay inside the
   frozen closure or an explicit immutable/type-only allow-list.
2. The live generator has the previously bound behavior with its version gates
   resolved, not additional scheduling changes.
3. Admission, registry dispatch, recovery and continue-as-new preserve the admitted
   version; new runs alone use the latest-version constant.
4. Shared activity behavior depends on the run's version, with the same names,
   inputs and ordering required by each historical contract.
5. Recorded schedules from the released and previously bound implementations
   replay identically on their respective frozen and live handlers. State exactly
   which scenarios this evidence covers.

Record the correspondence in `docs/formal/workflow/` and retain the prior model
results and bounds. If any schedule, dispatch or shared-activity behavior changes,
update the affected models, run TLC and add regressions; do not describe the change
as an extraction. A future cross-version Workflow handoff is a separate decision
requiring source-version normalization and every-old-state-point compatibility
evidence before it can replace the admitted-version pin. It is not part of this freeze.

## The method

Work in this order. Each step names what it produces.

1. **Read the code at a pinned commit.** Record the full SHA. Read the actual functions,
   transactions and yields; do not model from memory or from comments. Produces: a list of
   actors, durable state, steps and the transactions that order them.
2. **Reuse before you add.** Find the model that already covers the area (the index lists
   them). Extend or update it. Write a new module only for a boundary no model has. Keep
   models small: one module checks one group of boundaries.
3. **Design first, then the code.** For a new feature, first model the *intended* design (the
   agreed rules) and check it; findings may change the design. Then bind the model to the
   implementation: add the code's real behavior as switches (for example the code's path
   versus the rule's path) and check both.
4. **Abstract specification and refinement (for larger features).** Write a small module of
   the intended behavior and check the detailed model against it as a TLC `PROPERTY`
   (`Abs!Spec` with a refinement mapping). The fork + join models do this.
5. **Table the cases** (next sections) with bounds small enough to finish.
6. **Run TLC with the repo runner** and classify every result.
7. **Turn every unexpected result into a finding**, then a fix and a regression test.
8. **Write the correspondence notes**: for each model action, the code file:line at the bound
   head, and whether it is code behavior, a rule to evaluate, or a model simplification.
9. **Re-run after fixes** and update the folder README and the index.

## Case tables and generated settings

A case is a row in its folder's tables, never a hand-written file:

- `cases.tsv`: `case_id<TAB>case_id.cfg<TAB>Module`, the cases to run, in order (a batch may list a
  subset of `cases.json`, in the same order).
- `cases.json`: one record per case: its expected result, its note and, under `tlc`, its TLC
  settings (`comment`, `spec`, `constants`, `invariants`, `properties`, optional `view`, `deadlock`,
  and `layout` only where the case departs from its module's template).
- `tlc-templates.json`: per module, the order of its constants, the indentation and the layout.
- `cases-retired.json`: cases whose code no longer exists, each with its reason; kept for the
  record, never run.

The TLC settings files (`<case>.cfg`) are **generated, never committed**
(`docs/formal/.gitignore`). `docs/formal/tlc_cases.py` renders them; `run-tlc.sh` and
`check-packet.sh` call it before they read them.

```bash
python3 docs/formal/tlc_cases.py gen docs/formal/<folder>      # write the settings to look at them
python3 docs/formal/tlc_cases.py gen --with-retired --all      # every folder, retired cases too
python3 docs/formal/tlc_cases.py import docs/formal/<folder>   # table .cfg files written by hand
python3 docs/formal/tlc_cases.py retire docs/formal/<folder> <case_id> "<reason>"
```

- A folder with `gen-cases.py` (the case table is a Python list there): edit the list and run the
  script; it writes `cases.tsv`, `cases.json` and `tlc-templates.json` through `tlc_cases.attach()`.
  Retire a case by listing it in the script's `RETIRED`. Never edit its `cases.json` by hand.
- Any other folder: edit `cases.json` and `cases.tsv` (or write the settings by hand, then `import`).
- A new model: write its settings as before, then `import`; the template comes from them.

## Case taxonomy

Every case is one record in `cases.json` and one line in `cases.tsv`. Name the expected result
in the record's `expected` and in its first comment line (`tlc.comment`).

| Kind | Expected | Purpose |
|---|---|---|
| holds (safety) | PASS | Invariants hold in every reachable state of the bounded model. |
| liveness | PASS | Something good eventually happens **under stated fairness** (`WF_vars(...)` on named actions). Name every fairness assumption. Free choices (cancel, stop, pause) are never forced, so check only properties conditioned on them (`stopReq ~> ...`). |
| deliberate fault | violation of a named rule | One protection removed on purpose (a `Fault` constant). Proves the rule is not vacuous. Never a product defect. |
| comparison | PASS or violation | A rejected or alternative design, or the code before a fix, run beside the rule to show the difference. |
| witness | violation of a `W_...` predicate | Forbids a behavior you expect to be reachable; the violation proves it is reachable. |
| refinement | PASS | The detailed model implements the abstract specification. |
| implementation-shaped | violation (code) and PASS (fix) | When review or TLC finds a code divergence: one case reproduces the current code and must fail, one models the fix and must pass. |

## Writing models and cases

- Group `VARIABLES` by owner: store, work (effects, children), controller, history (ghost
  flags read by no action). Every action states every variable it does not change
  (`UNCHANGED`); check each new branch.
- Split each durable activity into its transaction and its recorded result. A worker crash
  between them re-runs the activity; bound it with `MaxCrash`. A replay is no step.
- Name a fault or a code path with a constant; never edit the rule to make a case pass.
- Guard every function application whose argument may be outside the domain with `IF`; do
  not rely on short-circuit evaluation. Parenthesize mixed `/\` and `\/`, and `[][P]_v` when
  `P` starts with a quantifier. Assign a primed variable before you read it.
- Every case states `CHECK_DEADLOCK TRUE` or `CHECK_DEADLOCK FALSE` (`tlc.deadlock`). Use `TRUE` for safety
  cases of a model with an explicit idle/done stutter, so a stuck state is reported. Use
  `FALSE` for fault and hazard cases.
- Module names use letters and digits; case ids use `[a-z0-9.-]`. The runner rejects others.
- Size each case to finish within the per-case limit (default 300 s at `-workers 2 -Xmx2g`).
  Liveness cases cost more than safety cases: use the smallest bounds that still reach the
  behavior, and say in the case note which bound you cut and why it still covers it.
- A witness or a comparison is useless if its configuration cannot reach the behavior. Give
  the values diversity (for example two branches that may succeed in either order).

## Running TLC

Each model folder has `run-tlc.sh` (tla2tools v1.7.4, TLC 2.19, pinned by sha256),
`check-packet.sh` and `SHA256SUMS` (the committed inputs only: no `.cfg`). Both scripts are
byte-identical in every folder; change them everywhere at once. They need Java 17+ and Python 3.

```bash
cd docs/formal/<folder>
./check-packet.sh                                   # generate, guard, CHECK_DEADLOCK, hashes
TLA_TOOLS=/path/to/tools ./run-tlc.sh /tmp/tlc-out  # generate, SANY first, then every case
# TLC_CASE_SECONDS=1200 only for a case documented as long
```

Both find `tlc_cases.py` in the folder or above it. To run a folder on another machine (a
packet), copy the folder, put `tlc_cases.py` in it, cut `cases.tsv` (and `cases.json`) to the
cases to run, regenerate `SHA256SUMS`, and run `check-packet.sh`. The runner records the
generator's and every settings file's sha256 in `<out>/generated.sha256`.

Run TLC locally or on demand, on an isolated machine, with the repo runner. TLC does not run in
CI yet. The script's exit code is not the verdict. Read
`<out>/executions.tsv` and each case's `tlc.log`:

| rc | Meaning |
|---|---|
| 0 | No violation in the bounded search: PASS. |
| 12 | Safety violation: the log names the invariant and prints the trace. |
| 13 | Liveness violation: the log prints a lasso (states, then a back edge or stuttering). |
| 124 | Timed out: PARTIAL. Never a PASS, even with no violation so far. Shrink the case or give it a longer documented limit. |
| other | Setup error (parse, ASSUME, Java): VOID. Fix the packet, not the verdict. |

Compare each result with its expectation. Report the counts separately: PASS, expected
violations, unexpected results, PARTIAL and VOID.

## From a counterexample to a fix

1. Read the trace step by step: the actions, and the variables that changed at the last step.
   For liveness, name the loop entry, the back edge and the fairness that should have forced
   progress.
2. Decide which it is: a **model error** (the model, a case or a bound is wrong: fix it and
   record it), a **design finding** (the intended rule is wrong or missing: take it to the
   design owner), or a **code finding** (the code departs from the rule).
3. For a code finding: map each trace step to code (file:line at the head), state the rule it
   breaks, propose the fix, and add an implementation-shaped case pair (code fails, fix passes).
4. Add a regression test to the repo's suites that **fails without the fix** and passes with
   it (see `.github/skills/add-test/SKILL.md`). A TLC counterexample alone is not a
   reproduced defect.
5. Re-run the affected cases and every case of each changed module.

A model that misses a defect that review found is a finding too: the rule was too narrow.
Strengthen the invariant, add the case, and record it.

## Binding and correspondence

Each folder README states: what the models cover; the code they are bound to (file:line at a
named full commit); the case taxonomy and expected results; and a results summary (date, head,
counts, PARTIALs). Keep a `CORRESPONDENCE-<head8>.md` table per bound head: model action or
definition, code file:line, and a label: **Code behavior**, **Rule to evaluate** or **Model
simplification**. When the code moves, re-read it, update the table and the head, and re-run.
Never claim that a model covers a code version it was not checked against.

## Before you finish

- `./check-packet.sh` passes in every changed folder; `SHA256SUMS` is regenerated last, over the
  committed inputs only. No `.cfg` is committed; `python3 docs/formal/tlc_cases.py check --all`
  (after `gen --with-retired --all`) shows that every case's settings generate.
- The folder README and `docs/formal/README.md` show the new head, date and counts.
- Every unexpected result is classified, and every code finding has a fix and a regression
  test that fails without it.
- The PR description lists the cases run, their results, the PARTIALs and what is not covered.
- `npm run check:privacy` passes; models and notes hold no deployment identifiers.
