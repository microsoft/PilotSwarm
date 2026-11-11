# W2 turn binding: intent model, obligations and plan review

This is design work against the W2 wiring plan on base 22a66ef7, written
before the W2 code existed. The code model is in
`W2-CODE-REFINEMENT-5DF032F1.md`. W2, invocation refinement, native runs and
runtime activation remain unqualified.

## Intent model `RecipientTurnSpec.tla` (spec first, from the design only)

The model has one bound invocation and at most `MaxTurns` turns, each with up
to `MaxRetries` retries.

How turns work in the model:

- A stimulus starts a turn: a message, a timer, a newly claimed item, a gate's
  own retry, or anything else. When the invocation is ready, decide may start
  an own turn for it.
- An attempt that ends `retrying` waits for that turn's retry.
- While a turn waits, another turn may run (`Interpose`). The waiting turn
  resumes afterwards.
- `Abandon` drops a waiting turn whose retry never comes.

`Carries(t)` follows design 5.5:

- After a first send, only the turn that first sent carries the invocation.
- A ready, unsent invocation is carried by any attempt.
- A gate-parked invocation is carried only by the first attempt of a
  `gate_retry` turn.
- An invocation parked for another cause is carried only by the first attempt
  of a turn started by a message, a timer or a newly claimed item.
- An unsent invocation with a latched cancel is never carried.

`Attempt(w, r)` applies the first matching row of the transition table, with
`sent` updated first. Its result decides `sent`, the outcome, `parked`, and
whether the turn retries or ends.

| Property | Design |
|---|---|
| `Inv_SentRidesOwnTurn` | I8: only attempts of the turn that first sent it carry it after that |
| `Inv_NoOwnTurnUnlessReady` | I11 and 5.5: an own turn only for a ready invocation |
| `Inv_NoCarryLatchedUnsent` | latched cancels: an unsent invocation with a latched item is never carried |
| `Inv_Truthful` | I9: `not_dispatched` only if never sent; `completed` only after a send |
| `Prop_SentSticky`, `Prop_OutFinal` | I9: `sent` is cumulative; an outcome is final |

### Configurations (7)

| Configuration | Expected |
|---|---|
| `rts-hd-safety` (3 turns, 1 retry) | PASS: all of the properties above |
| `rts-df-marker-any` | `Inv_SentRidesOwnTurn` violated, 6 states: Bind, StartTurn, Attempt(sent, retrying), Interpose, Attempt (the interposed turn carries it) |
| `rts-df-own-parked` | `Inv_NoOwnTurnUnlessReady` violated, 5 states: Bind, StartTurn, Attempt(unsent, gate), OwnTurn |
| `rts-df-carry-latched` | `Inv_NoCarryLatchedUnsent` violated, 5 states: Bind, Latch, StartTurn, Attempt |
| `rts-wit-completed-after-interpose` | witness reached: completed in its own turn after another turn ran in between |
| `rts-wit-gate-resumed` | witness reached: completed in a later turn |
| `rts-wit-abandoned-interrupted` | witness reached: an abandoned retry ends `interrupted` |

## The W2 plan, mapped to these obligations

| Obligation | Plan hook | Assessment |
|---|---|---|
| LatchFirst before form and carry | `intakeBeforeAttempt` and `intakeOwnTurn` call `latchIntakeTombstones` before `formAndBind` and `carryIntakeInvocation` | Meets the recipient models' `LatchFirst` assumption. The code model will make it an action guard. |
| Bind before any carry | `formAndBind` happens in `intakeBeforeAttempt`, and `carryIntakeInvocation` refuses an unbound invocation | Matches the design: if the bind fails, nothing is carried. |
| I9 witness truthfulness | `intakeSent = true` just before `targetSession.runTurn` in `runTurnWithPrompt`, which the first run and both recovery re-runs share. The witness is put on `bodyResult` before `toSave` commits, and on the catch paths. A throw is "possibly sent". | Matches the design's cumulative `sent`. An adopted saved result keeps its witness. |
| I11 own turn | decide priority 5: `intakeOwnTurn`, which returns `intakeOwnTurnStimulus`. The plan adds `needsBlockingDequeue && !intakeWantsTurn` and `shouldRunQueuedWorkNow` | Matches: a parked or latched invocation starts no turn, except a newly claimed item for a non-gate park. `intakeWantsTurn` becomes false once an invocation exists, so it cannot spin. |
| Resume stimuli | `processTimer` sets `gate_retry` for budget or workspace retries and `timer` for wait, cron and cron_at. A message, an answer, a FIFO prompt and the 4 child-digest turns set `message`. A newly claimed item sets `arrival` (`intakeArrivals`). | Matches the design's table, with a child update counted as a message. |
| Abandoned retry ends `interrupted` | the marker is carried only by a retry continue-as-new; a non-retry continue-as-new drops it, and `intakeBeforeAttempt` then ends a sent invocation `interrupted` (`ran: false`, `stopped`) | Matches `Abandon`. |
| I8: a sent invocation rides only its own turn's retries | `isRetry = retryCount > 0 \|\| marker !== null`, and the carry names the invocation when `marker === id` | **D-W2-1, open below.** |
| 6.2: timer note and digest for intake turns | not done; a documented deviation | Outside the models' scope; recorded. |

### D-W2-1: what binds the retry marker to its own turn (design observation; reachability unconfirmed)

The plan consumes `state.intakeRetryInvocationId` in the next
`processPrompt` that runs, and treats any `processPrompt` as the retry while
the marker is set. The retry itself works like this:

- `handleGenericRetry` (`turn.ts` 304-352 at 22a66ef7) does
  `scheduleTimer`, then a continue-as-new.
- That continue-as-new carries the prompt as `pendingPrompt` with
  `retryCount > 0`.

After that continue-as-new, `decide` takes the pending prompt only at
priority 2, and only while `!state.waitingForAgentIds` (`queue.ts` 1461). Two
earlier paths could start another turn first:

- priority 1, pending tool actions;
- the paths that run while the pending prompt is held for an agent wait,
  such as a timer turn or a child-digest turn.

If any of them does, that unrelated turn takes the marker and carries the
sent batch. That violates I8; `rts-df-marker-any` is this case. The
retried prompt then runs without the batch.

It is not shown that such a turn is reachable in source. It depends on
whether `waitingForAgentIds` or pending tool actions survive a retry
continue-as-new together with a pending prompt.

Recommendation, to be checked before W2 lands:

- consume the marker only on the path that dispatches the retry's own
  pending prompt (decide's priority 2 with `retryCount > 0`), or carry the
  marker with that pending prompt;
- treat any other `processPrompt` as `new` with its stimulus. The sent
  invocation is then not carried there.

Suggested unit test: a retry continue-as-new with `waitingForAgentIds` set
and a timer due. Expect the timer turn not to carry the batch, and the later
retry turn to carry it.
