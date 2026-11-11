# W2 turn-binding witnesses: amendment

This amends the witnesses of `RecipientTurnSpec.tla` first written at
`382f06e0`.

**What was wrong.** Three witnesses in `RecipientTurnSpec.tla` did not prove
that the situation they name took place (found in review):

| Old witness | Why it could be violated without the situation |
|---|---|
| `Wit_GateResumed`: completed, `firstSent # 0`, `nTurns >= 2`, no interpose | An unrelated first turn followed by a first send in a later turn satisfies it. No gate needs to park or resume. |
| `Wit_AbandonedInterrupted`: interrupted, no active turn, `firstSent # 0` | An attempt that sent and then stopped (or hit a gate) ends `interrupted` with no `Abandon`. |
| `Wit_CompletedAfterInterpose`: interposed and completed | It did not name which turn completed the invocation. |

**The fix.** `MCRecipientTurnWitness.tla` `EXTENDS RecipientTurnSpec`, which
is byte-unchanged. It adds history variables only. Each one is set from the
step just taken, and no action of the spec reads any of them. So
`HSpec == HInit /\ [][HNext]_hvars` has exactly the spec's behaviors on the
spec's variables. No invariant, property or fault of the spec changes
meaning.

| History variable | Set by |
|---|---|
| `gateParkedTurn` | the step in which `parked` becomes `"gate"`, an `Attempt` of the current turn |
| `gateResumeTurn` | an `Attempt` of a `gate_retry` turn that changes a gate-parked invocation (it carried it), after a gate park |
| `completedBy` | the step in which `out` becomes `"completed"`, an `Attempt` of the current turn |
| `abandonEnd` | `out` becoming `"interrupted"` while the current turn waits for its retry, or while only a held turn exists. Only `Abandon` can do that, because `Attempt` needs a current turn that is not waiting. |

**New witnesses (each expected to be violated, which means reachable):**

| Configuration | Witness | Predicted trace |
|---|---|---|
| `rts-wit2-gate-resumed-completed` | a gate parked it; another turn, the gate's own `gate_retry` turn, carried it, first sent it and completed it | 6 states: Bind, StartTurn(message), Attempt(unsent, gate), StartTurn(gate_retry), Attempt(sent, result) |
| `rts-wit2-abandoned-interrupted` | `Abandon` of the first-sending turn's waiting retry ended it `interrupted` | 5 states: Bind, StartTurn, Attempt(sent, retrying), Abandon |
| `rts-wit2-completed-after-interpose` | another turn ran while the first-sending turn waited; the first-sending turn, resumed, completed it (`completedBy = firstSent`) | 9 states: Bind, StartTurn t1, Attempt(sent, retrying), Interpose t2, Attempt by t2 (no carry), ResumeHeld, RetryReady, Attempt(sent, result) by t1 |

The three old witness configurations are superseded but kept unchanged as a
record. They should not be run as evidence:

- `rts-wit-gate-resumed`
- `rts-wit-abandoned-interrupted`
- `rts-wit-completed-after-interpose`

The turn-spec cases now run as follows:

- `rts-hd-safety`;
- the three faults: `rts-df-marker-any`, `rts-df-own-parked`,
  `rts-df-carry-latched`;
- the three `rts-wit2-*` witnesses.
