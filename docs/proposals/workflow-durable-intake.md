# Workflow messaging: durable recipient intake (design A)

Status: design checkpoint for review. No code is changed by this document.
Base: `waldemort/workflow-v2-single-writer` at `fa7c232f`. Line numbers below
are at that commit.

A messaging `send` state queues its message for an agent session at least
once. Today the recipient drops a repeat only while the exchange's client
message id is among its 20 most recent ids. Design A gives the recipient a
durable intake record per exchange, so that the session takes each exchange
in at most once, however many copies arrive and whenever they arrive.

## 1. Source facts this design rests on

| Fact | Source |
|---|---|
| A send attempt reads the recipient's orchestration status, then queues `{prompt, sender, clientMessageIds: [workflow:<wf>:<run>:send:<nx>]}`. A failure after the queue accepted the message and before `recordDelivery` queues it again. | `workflow/v2/runtime.ts` 849-859, 1898-1976 |
| The exchange id is `nx-` + 40 hex of `sha256(canonicalJson([runId, scopeId, nodeId, ordinal]))`: unique per run and stable for every attempt. | `workflow/v2/store.ts` 620 |
| The outbox row is written at entry, under the session locks, before any delivery. Its recipient, contract, payload and `payload_sha256` never change, and the row is never deleted. | `migrations/workflow-v2-0091.ts` |
| The session orchestration reads one durable queue, `messages`, in two places: `drain` and the pre-dispatch sweep. Both check cancel tombstones, then the client-id window, then the item size, then stash the prompt. | `orchestration/queue.ts` 934-1129 (drain), 1259-1286 (sweep) |
| The duplicate check is the 20 most recent ids plus the ids pending in the current pass. | `queue.ts` 398-406; `state.ts` 440, 485-492 |
| The stash is appended to the KV FIFO at the end of a pass and before every command. An item that does not fit is reported (`session.fifo_overflow`) and its ids are not marked as seen. | `queue.ts` 342-365, 839-851, 1143-1146, 1191-1199, 1293 |
| A cancelled prompt is dropped at six sites: `drain-incoming`, `drain-stash`, `predispatch-incoming`, `predispatch-stash`, `decide-fifo`, `decide-merge`. The drop consumes the tombstone and puts the ids in the 20-id window. | `queue.ts` 831, 936, 1183, 1261, 1365, 1443; `lifecycle.ts` 413-421 |
| The FIFO lives in instance KV (`fifo.0`…`fifo.19`), which survives continue-as-new. The run loop continues as new at the iteration cap and the history cap with the FIFO non-empty. The CAN input carries the 20-id window and the cancel set, not the FIFO. | `runtime.ts` 241-263; `lifecycle.ts` 577-688 |
| The latest session orchestration is 1.0.82. A frozen version replays its own histories; every CAN targets the latest. | `orchestration-version.ts` 15; `orchestration-registry.ts`; `lifecycle.ts` 706-736 |
| Critical CMS writes in the session orchestration retry in the activity (1, 5, 15, 90 s) and are not caught by the orchestration: exhaustion fails the session. | `cms-retry.ts` 6-11, 121-133; `turn.ts` 202, 266, 1571 |
| Public message ingress builds the queued JSON field by field (prompt, bootstrap, requiredTool, clientMessageIds, sender, attachments). No public path passes an arbitrary field through. | `client.ts` 1059-1078; `management-client.ts` 4108-4120; `session-messages.ts` 172-176 |
| A feature already gates on the observed orchestration version: `orchestrationSupportsWorkspaces` against `WORKSPACE_ORCHESTRATION_MIN_VERSION`. Tests read the version from Duroxide's instance record. | `workspace.ts` 54-66; `test/helpers/pinned-start.mjs` 70-73 |

## 2. What design A guarantees, and what it does not

For an exchange whose delivery runs in durable mode (section 4):

- **At most one admission.** Of all copies of the exchange that reach the
  recipient session, at most one is admitted to the session's work (the KV
  FIFO, then a turn). Every other copy is suppressed and recorded.
- **No claimed-but-unpresented loss.** A copy that the recipient claimed and
  then did not admit (the FIFO had no room) releases its claim, so a later
  copy can be admitted. A copy that the recipient admitted and then dropped
  for a cancellation records the cancellation, and later copies stay
  suppressed.
- **Conditional progress.** While the CMS answers and the recipient session
  runs, the admitted copy reaches a turn unless it is cancelled or the
  session ends first, as for any queued prompt.

It does not give:

- exactly-once delivery or reading: the sender's status read and enqueue are
  still separate, and a session that ends after the enqueue does not read
  the message;
- exactly-once model behavior or external effects of the turn;
- any guarantee for an exchange in legacy mode (section 4): that exchange is
  at least once with the 20-id window, and its receipt says so.

`sent` keeps its meaning: the recipient's durable queue accepted the message.
It is not a read.

## 3. Identity and envelope

The intake key is the exchange id. The identity is checked, not trusted from
the message:

| Part | Where it comes from |
|---|---|
| Recipient | The claiming orchestration's own `input.sessionId`. The outbox row's `recipient_session_id` must equal it. |
| Source workflow and exchange | The outbox row for `exchangeId`: `workflow_session_id`, `run_id`. The envelope's values must equal them. |
| Envelope hash | `sha256(canonicalJson({v: 1, recipientSessionId, workflowSessionId, runId, exchangeId, contract, payloadSha256}))`, from immutable outbox fields only. The prompt text is not hashed: its rendering may change between deliveries. |

The sender adds one field to the queued message, set only by the workflow
runtime:

```json
{ "prompt": "…", "sender": { "kind": "system", "display": "workflow message" },
  "clientMessageIds": ["workflow:<wf>:<run>:send:<nx>"],
  "workflowIntake": { "v": 1, "workflowSessionId": "…", "runId": "…", "exchangeId": "nx-…",
                      "contract": "…", "payloadSha256": "…", "envelopeSha256": "…" } }
```

User text (`prompt`) and client ids are never read for the identity. A message
whose envelope does not match its outbox row is refused, so a forged envelope
needs a forged outbox row, which only admission under the session locks
writes.

## 4. Sender: capability gate and intake mode

A recipient older than 1.0.83 ignores `workflowIntake` and treats the message
as an ordinary prompt. The sender therefore decides a mode per exchange and
keeps it:

1. The deliver activity reads the status as today. If the session has not
   ended, it reads the instance's orchestration version
   (`getInstanceInfo(session-<id>).orchestrationVersion`).
2. `beginDelivery` records `intake_mode` on the outbox row on the first
   counted attempt: `durable` when the version is at least
   `WORKFLOW_INTAKE_ORCHESTRATION_MIN_VERSION` (`1.0.83`), else
   `legacy_window`. An unparseable version is `legacy_window` (fail closed,
   unlike the workspace gate). A row that older code already attempted
   (`attempts > 0`, no mode) is `legacy_window`.
3. Every later attempt uses the recorded mode, whatever version it reads.
4. Durable mode queues the envelope; legacy mode queues the message as S1
   does.
5. The receipt and the outbox view show `intake: durable | legacy_window`.
   Receipts written before this change read as `legacy_window`.

Why the mode is sticky: an exchange whose first copy went to a 1.0.82
execution as a plain prompt could otherwise get a second copy with an
envelope after the session moves to 1.0.83. That copy would find no claim and
be admitted again.

Why the gate is safe in the durable direction: an instance runs one execution
at a time, and every CAN targets the latest version, so once a 1.0.83
execution has run, no later execution is older. This assumes no rollback to a
build whose latest version is older, which is outside the deployment rules.

An old session parked on 1.0.82 moves to 1.0.83 only at its next
continue-as-new, after its next unit of work. Its first exchange after the
deployment is therefore `legacy_window`. That is stated in the receipt, not
hidden.

## 5. Recipient: the intake state machine (orchestration 1.0.83)

### 5.1 The intake row

`workflow_intake`, one row per exchange (migration 0093):

| Column | Meaning |
|---|---|
| `exchange_id` | primary key; references `workflow_outbox` |
| `recipient_session_id`, `workflow_session_id`, `run_id` | copied from the verified outbox row |
| `envelope_sha256` | the hash of section 3 |
| `claim_id` | the claim that holds the row |
| `state` | `accepted`, `cancelled` or `released` |
| `claims`, `duplicates`, `conflicts` | counters |
| `created_at`, `updated_at`, `settled_at`, `settle_reason` | `settled_at` is null exactly while `accepted` |

```
            claim (new key)               cancel drop
   (none) ─────────────────► accepted(c) ────────────► cancelled(c)   terminal
                               │   ▲
                FIFO no room   │   │ claim by a later copy d (same hash)
                               ▼   │
                             released(c) ──► accepted(d)
```

`accepted` means admitted, or about to be (section 6). It is never changed to
another claim while accepted.

### 5.2 Claim (one transaction, activity `claimWorkflowIntake`)

Input: `recipientSessionId` (the orchestration's own id), `claimId`, the
envelope.

1. Recompute the envelope hash from the envelope fields. Mismatch:
   `refused: malformed`.
2. Read the outbox row for `exchangeId` `FOR SHARE`. Missing, or any of
   recipient, workflow session, run, contract, payload hash differs:
   `refused: unverified`.
3. `INSERT … ON CONFLICT (exchange_id) DO NOTHING`. Inserted: `accepted`.
4. Otherwise lock the row:
   - a different `envelope_sha256`: `conflict` (counted);
   - the same `claim_id`: `accepted` (the activity ran before and its reply
     was lost);
   - `released`: take it, `claim_id := claimId`, `accepted`;
   - `accepted` or `cancelled` under another claim: `duplicate` with that
     state (counted).

No workflow store on the worker: `refused: unsupported` (no legitimate
envelope can exist there).

### 5.3 Settle (one statement, activity `settleWorkflowIntake`)

`UPDATE … SET state = $outcome, settled_at, settle_reason WHERE exchange_id = $1
AND claim_id = $2 AND state = 'accepted'`, outcome `cancelled` or
`released`. Running it again changes nothing.

### 5.4 Arrival, in `drain` and in the pre-dispatch sweep

A prompt message with a `workflowIntake` field takes this path; every other
message takes today's path unchanged.

1. Shape check of the envelope (strings present, `v === 1`). A bad shape is
   refused and recorded; nothing else happens.
2. Build the item as today and check its size. Too large: refused as today,
   before any claim.
3. `claimId := yield ctx.newGuid()` (recorded in history).
4. `yield claimWorkflowIntake(...)`.
   - `duplicate`, `conflict`, `refused`: record
     `session.workflow_intake_duplicate` or `session.workflow_intake_refused`
     and continue. No timer is released, no digest is taken, no tombstone is
     consumed, no id becomes pending.
   - `accepted`: go on.
5. Cancel check (the claim comes first so that a duplicate copy never
   consumes the tombstone meant for the admitted copy; this order applies to
   intake messages only). Cancelled: drop as today, then
   `yield settleWorkflowIntake(cancelled, reason)`.
6. The 20-id window is not consulted for an intake message: the claim
   decides. Its ids still enter the window when it is stored, as today.
7. From here the item follows today's prompt path (timer release, timer note,
   child digest, stash). The stashed item carries
   `intake: {exchangeId, workflowSessionId, runId, envelopeSha256, claimId}`.

### 5.5 Settlement points after arrival

| Event | Site | Settle |
|---|---|---|
| A tombstone drops the stashed intake item in the same pass | `drain-stash`, `predispatch-stash` | `cancelled` |
| The FIFO has no room when the stash is appended | the lost items of `appendPromptStashToFifo`, after each of its four calls | `released` |
| A tombstone drops it in the FIFO | `decide-fifo`, `decide-merge` | `cancelled` |

Every drop of an intake item goes through one helper, so a new drop site
cannot forget the settle. `session.fifo_overflow` already names the lost
client ids.

## 6. Linearization and invariants

Linearization points:

- **L1 (send):** the queue accepts a copy (sender's enqueue).
- **L2 (claim):** the claim transaction commits `accepted(c)`.
- **L3 (admission):** the orchestration commit that writes the item with
  claim `c` to the FIFO. Between L2 and L3 the claim is reserved: after a
  crash, replay rebuilds the stash from history (the dequeue, `c`, and the
  claim reply), and if the reply was never recorded, the activity runs again
  with `c` and gets `accepted` back.
- **L4 (presentation):** `decide` dispatches the item to a turn (today's
  semantics from here on).

Invariants (to hold at every orchestration commit):

- **I1 at-most-once admission:** at most one claim per exchange ever reaches
  L3.
- **I2 no claimed-but-unpresented loss:** for a row `accepted(c)`, claim `c`
  is in the in-flight pass, in the FIFO, in a turn's input or carried state,
  or the recipient orchestration has ended.
- **I3 settle ownership:** only the holder of `c` settles the row, and only
  from `accepted`.
- **I4 identity:** a row exists only for an exchange whose outbox row names
  this recipient, workflow, run, contract and payload hash.
- **I5 honest receipt:** a receipt that says `durable` belongs to an exchange
  whose every copy carried the envelope (I1 then applies); one that says
  `legacy_window` makes no durable claim.

## 7. Versions

1. **Freeze first, no behavior change.** Copy `orchestration/` to
   `orchestration_1_0_82/` (version literal `1.0.82`), register it, set
   `DURABLE_SESSION_LATEST_VERSION = "1.0.83"`, add the freeze guard with the
   frozen files' hashes, and update the version literals of the earlier guards
   and tests, as the 1.0.82 freeze did.
2. **Then the intake change in 1.0.83 only.** In-flight 1.0.82 executions
   replay on the frozen copy. No session is fenced, killed or rewritten.
3. **CAN compatibility.** 1.0.83 adds no CAN input field. 1.0.82 inputs and
   FIFO contents are valid 1.0.83 state: a 1.0.82 FIFO has no intake items.
   An intake item crosses CAN in KV with its claim id.
4. **Old handlers stay correct.** 1.0.82 never sees an envelope from a
   correct sender (section 4). If one arrives anyway, 1.0.82 treats it as an
   ordinary prompt; that is tested as the positive control.
5. **Schedule fingerprints.** The surface gains
   `runtime.manager.claimWorkflowIntake` and
   `runtime.manager.settleWorkflowIntake`. An ordinary message adds no yield,
   so the canonical drive is unchanged.

## 8. Failure matrix

| # | Failure | Intake row | FIFO / outcome |
|---|---|---|---|
| 1 | Crash before the claim runs | none | replay dequeues the same copy and claims it |
| 2 | Claim committed, reply lost (crash or lease loss) | `accepted(c)` | the activity runs again with `c` and returns `accepted`; one item |
| 3 | Reply recorded, crash before the FIFO write commits | `accepted(c)` | replay rebuilds the pass from history; one item |
| 4 | A later copy, any time: after more than 20 other ids, after CAN, after a restart | `accepted`/`cancelled` (other claim) | `duplicate`, recorded, not admitted |
| 5 | Two copies in one pass | first `accepted` | the second gets `duplicate` |
| 6 | FIFO has no room at append | `released(c)` | overflow recorded as today; a later copy may be admitted |
| 7 | Crash between that refusal and its settle | `accepted(c)` until replay | replay reaches the same refusal (same KV) and settles |
| 8 | Item too large | none | refused before the claim, as today (a send payload is bounded at 16 KiB, so a send prompt is far below the 60 KiB item cap) |
| 9 | Tombstone before the copy arrives | `cancelled(c)` | dropped after the claim; later copies are duplicates |
| 10 | Tombstone in the same pass, or while queued | `cancelled(c)` | dropped and settled at its site |
| 11 | CAN while the item is queued | `accepted(c)` | the item stays in KV with `c` |
| 12 | Command arrives mid-pass | unchanged | the stash is appended before the command, as today |
| 13 | The session ends (done, delete, cancel, shutdown) with the item stashed or queued | `accepted(c)` | abandoned with the session, like any queued prompt; a sender attempt finds the session ended |
| 14 | Forged or corrupted envelope | none | `refused: malformed/unverified`, recorded |
| 15 | Same exchange with a different hash | counted conflict | `conflict`, recorded (unreachable while outbox rows are immutable) |
| 16 | CMS outage beyond the claim's or settle's retries | unknown | the activity fails and the session orchestration fails, as for its other critical CMS writes (explicit exclusion) |
| 17 | Recipient older than 1.0.83 at the first attempt | none | legacy mode for the whole exchange, stated in the receipt |
| 18 | Rolling deployment: an older sender worker makes a later attempt of a durable-mode exchange | `accepted(c)` | that copy has no envelope and is checked by the 20-id window only (stated limit for the deployment window) |

## 9. Retention

- The orchestration keeps no intake list: no new CAN field, no new KV key
  beyond the FIFO items themselves.
- `workflow_intake` holds one row per exchange delivered to a session; a
  repeat changes counters only.
- This slice deletes no intake row. A purge is safe only after the
  recipient's orchestration has ended, because a copy can wait in a live
  queue for as long as the session does not drain it. The purge belongs to
  the retention item for the outbox, inbox and history, and must also respect
  the outbox foreign key.

## 10. Ordinary messages are unchanged

Messages without `workflowIntake` take exactly today's code path and yields:
the 20-id window, its size, its carry across CAN, the cancel set, the order
of the checks, the duplicate event. Workflow recipients (S2) keep their inbox
operation-id deduplication. The parent notification keeps its own policy.

## 11. Plan and coverage

Commits, each with DEV tests and independent review:

1. Freeze 1.0.82, open 1.0.83 (no behavior change); freeze guards.
2. Storage foundation: migration 0093 (`workflow_intake`, `workflow_outbox.intake_mode`), store claim and settle, store tests. This is the B foundation; it is not acceptance.
3. Recipient intake in 1.0.83: both arrival paths, the settle helper and sites, the two activities and proxy methods, fingerprints.
4. Sender: version read, sticky mode, envelope, receipt, view, tool text, README and the orchestration design notes.

| Required coverage | Test |
|---|---|
| More than 20 intervening ids | durable copy, 21 other prompts, the same copy again: suppressed. Positive control: the same sequence in legacy mode is admitted twice |
| Crash after claim before the completion is recorded | store: claim `c` twice gives `accepted` both times, claim `d` gives `duplicate`; orchestration: a replayed pass with the same guid and a re-run claim admits one item |
| Duplicate same hash, changed hash conflict | store: duplicate counted; a row with another hash gives `conflict`; malformed and unverified envelopes refused |
| FIFO refusal and cancellation | full FIFO gives `released` and a later copy is admitted; tombstone before arrival, in the same pass, in the FIFO, in a merge, and in the pre-dispatch stash each give `cancelled`, and later copies are suppressed without consuming another tombstone |
| Restart and CAN | the intake item survives CAN in KV with its claim; a copy after CAN is suppressed |
| Frozen old history and the version gate | frozen 1.0.82 admits an envelope message as an ordinary prompt (positive control); the sender records `legacy_window` for 1.0.82, `durable` for 1.0.83, keeps the first mode on later attempts, and reads `legacy_window` for a row attempted by older code; a DEV session pinned at 1.0.82 and moved to 1.0.83 by CAN shows the instance version changing (this verifies the assumption in section 4) |
| Both arrival paths | an intake copy that arrives in the pre-dispatch sweep is claimed and merged into the turn once; a duplicate there is suppressed |
| Ordinary paths unchanged | the existing FIFO, cancel and duplicate tests pass unchanged apart from version literals |
| Schedule fingerprints | surface golden updated by exactly the two activities; drive golden unchanged |
| Full suite and baseline before deployment | a separate grant |

## 12. Formal model

`WorkflowV2Send.tla` is still owed. After commit 4 it models: the sender's
attempts (enqueue, crash before record, sticky mode), the recipient queue as
a bag of copies, the recipient's pass (dequeue, guid, claim with lost
replies, FIFO append with capacity, tombstones, CAN, session end), and the
intake rows. Checked properties: I1-I5 as safety, and conditional progress
as liveness under a fair, available store. Mutations remove the claim, the
release on refusal, the sticky mode, and the claim-before-cancel order; each
must fail.

## 13. Questions for review

1. Fail-stop on a CMS outage during claim or settle (row 16) follows the
   other critical writes. The alternative, a durable-timer retry inside the
   pass, keeps the session alive but blocks its commands during the outage.
2. The claim-before-cancel order for intake messages only (5.4 step 5).
3. The version read as the capability signal, with fail-closed parsing,
   rather than a capability key the orchestration writes.
4. No intake purge in this slice (section 9).
