# W2 code model and refinement: 5df032f1

Source pin: `5df032f14aa094ce57e1a6c0ae797edcc39dbe48` (tree `bc64334c`,
base `22a66ef7`). The model is derived from immutable source only. Results are in `README.md`.

New files (formal subtree only):

| File | Role |
|---|---|
| `RecipientTurnCode.tla` | Code model derived from the 5df032f1 source, with a refinement mapping to R2 |
| `RecipientTurnSpecR2.tla` | `RecipientTurnSpec` (file unchanged) extended with four environment timing steps E1 to E4. The carry rule, ghosts and properties are unchanged |
| 7 configs: `rts2-hd-safety`, `rtc-*` | The first code-model cases |

## 1. Gate deviation: classification

The code changed `carryIntakeInvocation` (intake-machine.ts 840-843): an
unsent invocation parked for a gate now rides **any** attempt. The design
(5.5 resume table) and the intent spec (`Carries`, gate row) say: the gate's
own retry only. The intent model is **not** changed to match the code.
`rtc-refines-gate` is expected to FAIL on exactly this rule.

### Bypass or revalidated: source facts

| Fact | Source (5df032f1) |
|---|---|
| The budget gate runs in the activity, before any model call, and returns a `wait` result | session-proxy.ts 1865-1933 |
| The workspace gate runs after the budget gate, before any Copilot session, and returns the same `wait` with `gate: "workspace"` | session-proxy.ts 1961-2030 |
| `intakeSent` becomes true only in `runTurnWithPrompt`, just before the model request | session-proxy.ts 4553-4560 |
| Every result, including a gate refusal, is wrapped with the witness `{invocationId, sent: intakeSent}` | session-proxy.ts 4992 |
| A refused carrying attempt is row 3: unsent, parked for the gate again | intake-machine.ts 927-938, turn.ts 1306 |

Classification: the code rule is **revalidated, not a bypass**. Each attempt
that carries a gate-parked invocation is checked by both gates before the
model request. A refusal reports `sent: false` and parks the invocation
again. A gate-parked invocation still starts no turn of its own
(`intakeOwnTurnStimulus`, intake-machine.ts 859-866). So the deviation does
not touch I8, I11, the latched-cancel rule or I9. `rtc-hd-code-safety`
predicts that all of them hold with gates on.

### Why the design rule strands: source facts

| Event | What happens to the gate's wait | Source |
|---|---|---|
| A person's message during a workspace wait | Wait cleared; the message's own turn is the next attempt | queue.ts 1115-1120 |
| A person's message during a budget wait | Wait interrupted; after a turn, a gate's interrupted wait is dropped, never re-armed | queue.ts 1032-1049, turn.ts 806-808 |
| `retry_workspace` / `set_workspace` command | Wait cleared; the wake prompt goes into the pending prompt, whose stimulus is `other` | lifecycle.ts 963-971, 1149-1152 |
| Next attempt refused again | A new gate wait is armed | turn.ts 1206, 1437 |

So, under the design rule, the invocation can stay parked: once a
non-`gate_retry` attempt passes the gates, the gate wait is gone and no own
turn starts. The invocation moves again only if a later attempt is refused
and that gate's own retry fires.

Predicted bounded counterexample (`rtc-design-strand`, the hypothetical
design rule in the code environment), 7 states:

1. Bind (gate closed at the start).
2. A message turn carries the invocation.
3. The gate refuses it: the invocation is parked for the gate and the gate wait is armed.
4. The gate opens.
5. A second message ends the wait and does not carry the invocation.
6. That turn gets a model result.
7. The invocation is still parked for the gate, and an attempt has passed the gates since it was parked: `Inv_C_GateParkClearedOnPass` is violated.

The same predicate is predicted to hold under the code rule
(`rtc-hd-code-safety`).

### Design alternatives (decision D-W2-2)

| | Rule | Effect | Cost |
|---|---|---|---|
| A1 | As 5df032f1: a gate-parked invocation rides every attempt; each attempt is gate-checked | No stranding; I8/I11/I9 unaffected (predicted) | Resume table changes; it also rides agent follow-ups and other turns' retries. A refusal costs no model call, so it adds no repeated model failure |
| A2 | Gate retry, or an attempt that passes the gate | The gate is decided inside the attempt, so before dispatch this is A1 | None beyond A1 |
| A3 | Keep "gate retry only", and make every event that ends the gate wait count as the gate's retry (message, command), or re-arm the gate wait while a gate-parked invocation exists | Keeps the table's intent | Re-arming reverses the 1.0.69 fix (a budget pause is never re-armed). Counting a message as the gate retry is A1 restricted to those starts |
| A4 | An own turn for a gate-parked invocation when the gate opens | Liveness without riding other turns | Changes I11; the orchestration cannot see the gate state without an attempt |

The accepted choice is A1, written into design 5.5 as the gate row of the
resume table, with I11 kept ("starts no turn of its own") (see
`W2-GATE-AMENDMENT.md`).

## 2. D-W2-1 marker, interposition, replacement and abandon

| Item | Source (5df032f1) | Model |
|---|---|---|
| The marker is set only when a carrying attempt of a sent invocation decides its turn's retry | intake-wiring.ts 600 | `Apply`: `marker' = retrying /\ sent` |
| Only decide's pending-prompt dispatch takes it | queue.ts 1467-1483; intake-wiring.ts 501-502 | `Begin`: `taken == marker /\ isPend` |
| Every continue-as-new carries it; restore requires it exactly while a sent invocation awaits | lifecycle.ts 728-729; intake-state.ts `restoreIntakeRetryInvocationId` | `Inv_C_MarkerIffAwaiting` (at every idle point) |
| Every retry continue-as-new overrides the pending prompt with the retry's own prompt | turn.ts 158, 192-196, 360; `retryContinueOverrides` 236-252 | `End(retrying)` sets `pend := retry(this turn)` |
| Other continue-as-new calls merge the held prompt with their text (model switch, forced continue, regenerate), so the marker stays with the merged retry prompt | turn.ts 1348, lifecycle.ts 839, 1403 | Not separate steps: same pending dispatch |
| An interposed turn starts new and carries no sent invocation | intake-wiring.ts 501-512, intake-machine.ts 840-842 | `Begin` (no `taken`) |
| Another turn's retry while the marker is held: the held prompt is replaced, the invocation ends `interrupted`, recorded `retry_replaced` | intake-wiring.ts 578-592 | `End` replacement step, then `CanAfterReplace`, mapped to R2's `AbandonHeldBusy` and `Attempt` |
| The marker rides the first-sending turn's retry | (consequence) | `Inv_C_MarkerOnFirstSenderRetry` |
| Negative control: any attempt takes the marker (the plan before D-W2-1) | — | `rtc-df-marker-any`, expected `Inv_C_SentRidesOwnTurn` FAIL, 6 states |

Observations (not modelled):

- **O-W2-3 (P3, pre-existing).** A successful interposed turn resets the shared `retryCount` (turn.ts 706-710). Reusing the thrown attempt's key needs `retryCount > 0` (turn.ts 535). So the held retry's protected `thrownTurnKey` is not reused, and a thrown-after-commit attempt is run again instead of adopted. The result is possible duplicate model exposure inside the invocation's own turn. This does not violate I8.
  - The reverse case (the held retry adopting an interposed turn's thrown key) is closed. Every throw path of an interposed turn either replaces the held prompt (a retry) or clears the key (exhausted, auth, lossy without blob, fatal): turn.ts 334-338, 157-158, 206-210, 645-655.
  - Suggested unit test: an interposed turn completes while a sent invocation's thrown retry is held.
- **O-W2-4.** decide's own turn may start while an agent wait holds a turn's retry prompt (priority 5 after priority 2 is skipped). r1's `OwnTurn` forbade this; R2 E3 allows it only for a ready invocation.
- **O-W2-5.** `intakeArrivals` is execution-local, so a retry continue-as-new forgets an unanswered arrival. A parked (non-gate) invocation then resumes only on the next message, timer or arrival. This is a liveness limit that core has recorded; the model resets arrivals on each retry continue-as-new.

## 3. R2: why the spec gained four environment steps

Mapping the code showed four places where r1's guards were narrower than the
design text. These are environment timing, not intake obligations. No
`Carries` row, ghost formula or property changed. `rts2-hd-safety`
re-checks every r1 property on R2.

| Step | Design text | r1 restriction removed |
|---|---|---|
| E1 `AbandonHeldBusy` | 5.5 clarification: another turn's retry replaces a held pending prompt; the invocation ends interrupted | Abandoning a held turn was only possible with no current turn |
| E2 `CancelUnsentWaiting` | 5.5 Cancels; latched writes run on the wake between attempts | Cancel write only with no current turn |
| E3 `OwnInterpose` | 5.5: decide starts a turn for a ready invocation when nothing else is dispatchable | Own turn only with no turn waiting; I11 still requires `Ready` |
| E4 `BindWaiting` | 5.5 Binding: formed "before it starts its next turn attempt" | Bind only with no current turn |

## 4. Mapping and abstractions

Step correspondence:

| Code step | Spec (R2) step |
|---|---|
| `Bind` | `Bind` / E4 |
| `Latch` | `Latch` |
| `CancelWrite` | `CancelUnsent` / E2 |
| `Begin(pending retry)` | `RetryReady` |
| `Begin(own)` | `OwnTurn` / E3 |
| Other `Begin` | `StartTurn` / `Interpose` |
| `End`, `CanAfterReplace` | `Attempt` |
| `End` replacement | E1 |
| `GResume` (ghost-only stutter) | `ResumeHeld` |
| Environment steps | Stutter |

A code result with **no** witness is matched by the spec step with the same
state effect. For example, result with no witness gives sent and
`interrupted`, the same state change as `Attempt(TRUE, "stopped")`. The spec
checks state pairs, not event names.

Abstractions (stated, not checked):

- **A-ATOMIC:** the orchestration runs one attempt at a time, and no drain, decide, latch or cancel write runs inside `processPrompt`.
- **A-SCHED:** decide's priorities are a nondeterministic choice (a superset).
- **A-RETRY:** the shared `retryCount` and `thrownTurnKey` become a per-turn retry cap with nondeterministic exhaustion (a superset).
- **A-GATE:** one gate stands for budget and workspace; the environment toggles its state.
- **A-ONE:** one invocation of one item.

Not modelled: settlement writes, bind failure, the stash, session end (row
13), and transcript recording.

## 5. Limits

The models are a finite safety and refinement check, under
the abstractions in section 4. It does not prove liveness: stranding is shown
as a reachable state, not as a liveness counterexample. It is not a
TypeScript, native or W3 (real orchestration) result, and it does not qualify
activation. The 1.0.83 pin remains inactive (no registry or worker route).
