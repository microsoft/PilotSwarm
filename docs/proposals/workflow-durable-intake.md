# Workflow messaging: durable recipient intake (design A, revision 2)

Status: revised design checkpoint for review. Docs only; no code changes.
It revises `c92d7eb1` after the Grok review
(`wfv2-intake-design-c92d7eb1-grok-review.md`, SHA-256 `e77c20b8…`) with the
parent's qualifications (`pse/wfv2/review/intake-design-c92d7eb1-grok`).
Source base: `9fcbf377`; line numbers are at that commit (the session
orchestration, client, worker and retry files are unchanged since
`fa7c232f`).

A messaging `send` state queues its message for an agent session at least
once. Today the recipient drops a repeat only while the exchange's client
message id is among its 20 most recent ids. Design A gives a recipient on
session orchestration 1.0.83 a durable intake record per exchange: the
session admits each durable-mode exchange at most once, admits it from the
sender's immutable outbox row and not from the queued bytes, keeps it in a
bounded retained area when it has no room, and refuses it visibly when that
area is full. Exchanges outside durable mode keep today's semantics.

## 0. Finding resolution

| Finding | Resolution | Section |
|---|---|---|
| F1 (high): mixed plain and enveloped copies bypass the claim; the recipient version does not fence the sender | Durable mode needs a deployment capability (every worker intake-capable) and the recipient's observed version (fail closed). A migration adds an outbox trigger that refuses a counted attempt on a durable-mode row unless the attempt carries a new attempt token, which only intake-capable code sets: an older worker cannot count an attempt, so it never queues a plain copy of a durable exchange. Every copy of a durable exchange is enveloped; a legacy exchange has none. Client ids are not parsed for authority, the 20-id window is not proof of anything, and no admission before the boundary is reconstructed. | 4 |
| F2 (high): the envelope does not bind the admitted message; a public write can queue arbitrary JSON | The claim returns the canonical message rendered from the immutable outbox row by the sender's own renderer, with its hash, in its history-recorded result. The session admits exactly that: the canonical text, client id, system sender, `bootstrap: false`, no required tool, no attachments. Every queued field is ignored for an intake message. `workflowIntake` becomes a reserved key that the generic event ingress refuses (defense in depth; the binding does not depend on it). | 3, 6.6 |
| F3 (high): a same-claim result after release or cancel could resurrect a reservation | State-conditioned claim table, one statement each; a claim id that no longer holds its row gets that row's state, with no write; settle acts only from `holding` under its own claim. | 5.2 |
| F4 (high): the holding invariant is false after presentation; pop, sweep, merge and FIFO parse paths | States `holding` and `presented`, with a critical `presented` settle in the same history prefix as the dispatch. I2 is a holding obligation only. The pop-before-sweep window is covered. 1.0.83 fails an execution on an unparseable FIFO bucket instead of reading it as empty. Provider KV and history atomicity is an assumption, not a proof here. | 5, 7 |
| F5 (medium): freeze literal, hash locks, imports and downward continue-as-new | Freeze rules as for 1.0.81 (literal, live latest target, historic imports, hash locks) before any new yield; a continue-as-new floor in 1.0.83 only; a monotonic-latest guard; the frozen trees are not changed. | 8 |
| F6 (medium): a missing workflow store is not a forged envelope | A claim that cannot reach the store is retried, never refused: the item waits in the retained area as `unclaimed` and the claim is tried again on a backoff, on any worker. | 5.4 |
| F7 (medium): release alone gives no progress after the sender recorded its only copy | No release on a full FIFO: the canonical item waits in a bounded retained area and is moved into the FIFO as room appears. When that area is also full, the exchange is refused explicitly (`refused_full`): recorded with a critical write, shown to the sender, never reported as admitted. | 5.4, 5.5 |
| F8 (medium): the sweep must keep its own semantics | Drain and sweep each keep their own prompt path: the sweep releases no timer, takes no digest and adds no note. Both claim before the cancel check; a duplicate never consumes a tombstone. All four append sites and all six drop sites are covered. | 6 |
| F9 (low): critical persistence | Claim and settle are critical store writes, never `recordSessionEvent`. Their bounded in-activity retry, the retained-area fallback that keeps commands serviced, and the one fail-stop case are stated. | 5.4, 9 |
| Source facts 1 to 9 of the review | Corrected in section 1. | 1 |

## 1. Source facts (corrected)

| Fact | Source |
|---|---|
| The exchange id is the node execution id (`nx-` + 40 hex); the outbox stores it once in both columns. There is no second id. | `store.ts` 641-642, 1912 (outbox insert); migration 0091 |
| A send attempt reads the recipient's status, counts the attempt (`beginDelivery`), then queues `{prompt, sender, clientMessageIds: [workflow:<wf>:<run>:send:<nx>]}`. A failure after the queue accepted it and before `recordDelivery` queues it again. | `runtime.ts` 850-859, 1917-1985 |
| The deliver activity is one activity name; old and new workers that have the workflow store both run it. A session orchestration version does not select its code. | `runtime.ts` 1917; `worker.ts` 1039-1053 |
| Public ingress: the field-by-field builders (`client.ts` 1059-1078, `management-client.ts` 4108-4120, `session-messages.ts` 172-176) and the generic `sendSessionEvent` (`POST /sessions/:sessionId/events`, `session:write`), which queues any JSON object on `messages` (`client.ts` 1630-1638; `api/src/protocol.js` 73). | as listed |
| `recordSessionEvent` is best-effort and never throws; `updateCmsState` is critical (1, 5, 15, 90 s, then it throws, uncaught). | `session-proxy.ts` 6201-6216, 6120-6139; `cms-retry.ts` 6-23, 121-146 |
| The workflow store exists only on workers whose catalog provides it; a claim may run on a different worker from the delivery. | `worker.ts` 1039-1053 |
| The live module's `CURRENT_ORCHESTRATION_VERSION` is the live latest constant; a freeze rewrites it to a literal and keeps the live latest as the continue-as-new target. | `orchestration/runtime.ts` 21; `orchestration-freeze-1-0-81.test.mjs` 20-26 |
| Continue-as-new always targets the live latest version, with no floor. | `lifecycle.ts` 706-736 |
| `getInstanceInfo().orchestrationVersion` is an observation of the version an instance runs; nothing enforces it. The workspace gate fails open on an unparseable version. | `test/helpers/pinned-start.mjs` 70-73; `workspace.ts` 54-66 |
| `readFifoBucket` returns `[]` when a bucket does not parse. | `queue.ts` 57-61 |
| `popNextDispatchFifoItem` removes the item before the pre-dispatch sweep, the cancel check and `processPrompt`; the sweep can end the session in between. | `queue.ts` 1431-1444 |
| The send receipt parser reads a receipt without `recipientKind` as an agent receipt; a new `intake` field must keep old receipts parsing. | `store.ts` 561 |

## 2. Guarantee

For a durable-mode exchange (section 4) whose recipient runs 1.0.83:

- **At most one admission.** At most one copy is admitted to the session's
  work, whatever the number, order and timing of the copies, after any
  number of other messages and across continue-as-new and restarts.
- **No silent loss.** Each copy that the session dequeues ends as exactly
  one of: admitted and then presented to a turn; cancelled by a tombstone
  (recorded); a duplicate of a copy that holds or was presented (recorded);
  refused as unverified, malformed or conflicting (recorded); refused for
  capacity (`refused_full`, recorded and visible to the sender); or
  abandoned because the recipient's session ended, as for any queued work.
- **Conditional progress.** While the store answers and the session runs, a
  claimed copy reaches a turn unless it is cancelled or the session ends;
  one that does not fit waits in the retained area and is moved into the
  FIFO as room appears.

Not given: exactly-once delivery, reading, model behavior or external
effects; any guarantee for a `legacy_window` exchange (at least once with
the 20-id window, as its receipt says); any statement about exchanges
admitted before the boundary. `sent` stays queue acceptance, not a read.

## 3. Identity and the canonical message

- **Identity.** The intake key is the exchange id. The claim reads the
  outbox row for it and accepts only if the row's workflow session, run,
  recipient (the claiming session itself), recipient kind (`agent`),
  contract and payload hash equal the envelope's, and the envelope's hash
  over those immutable fields is correct.
- **Canonical message.** In the same transaction the claim renders the
  message from the outbox row and its node (the state id) with the
  sender's own function
  (`workflowSendPrompt`, `runtime.ts` 1097, one shared renderer) and returns
  `{text, textSha256, clientMessageId}`, where `clientMessageId` is
  `workflowSendClientMessageId(wf, run, nx)`. The claim's result is
  recorded in the orchestration's history, so a replay admits the same
  bytes.
- **The admitted item** is built only from that result: the canonical text,
  the canonical client id, the system sender
  `{kind: "system", display: "workflow message"}`, `bootstrap: false`, no
  required tool and no attachments. The queued `prompt`, `sender`,
  `clientMessageIds`, `bootstrap`, `requiredTool` and `attachments` are not
  read for an intake message. The drain path may append the session's own
  timer note to the text, as for any prompt (6.2); that note is generated
  by the session, not queued data.
- **Reserved key.** `workflowIntake` is reserved: the shared validation of
  the generic event ingress refuses a payload that carries it, for every
  transport that reaches that ingress. This is defense in depth; sections
  3 and 4 do not depend on it. The other reserved queue fields (sender,
  bootstrap, required tool, commands) are the security contract's queue-
  shape item and the human-input slice, tracked there; this design does
  not claim to close them.

## 4. Sender: the capability boundary

- **Durable mode** is chosen at the first counted attempt only when both
  hold: the deployment capability `workflowIntakeV1` is on (an operator
  setting turned on after every worker runs an intake-capable build,
  advertised in the bootstrap), and the recipient instance's observed
  version is at least 1.0.83. A missing, empty or unparseable version is
  `legacy_window` (fail closed, unlike the workspace gate). The mode is
  recorded on the outbox row (`intake_mode`) and never changes.
- **Enforced against older workers.** The migration adds an
  `attempt_token` column and a `BEFORE UPDATE` trigger on `workflow_outbox`:
  an update that increases `attempts` on a row whose `intake_mode` is
  `durable` must change `attempt_token`, or the trigger raises. Intake-
  capable code sets a new token in its counting update. An older worker's
  `beginDelivery` (`store.ts` 2333) does not, so it cannot count an
  attempt on a durable exchange; since every build counts before it
  queues, it never queues a plain copy. Its attempt fails and is retried,
  possibly on an intake-capable worker. Legacy rows and rows that older
  code counted first (no mode, attempts above zero) are `legacy_window`.
- **Result.** Every copy of a durable exchange carries the envelope; no copy
  of a legacy exchange does. A recipient never sees the two kinds mixed for
  one exchange.
- **Not adopted.** Parsing `workflow:` client ids at the recipient as
  authority, or treating a hit in the 20-id window as proof that an
  exchange was admitted. Ids are untrusted text, any user can send them,
  and doing so would change legitimate legacy semantics.
- **Legacy and history.** Exchanges sent before the boundary, or in
  `legacy_window` mode, keep the 20-id window; admissions older than that
  window are not reconstructed; no retroactive at-most-once claim is made.
- **Receipt.** `intake: "durable" | "legacy_window"`; the parser reads a
  receipt without the field as `legacy_window`.

## 5. Recipient (orchestration 1.0.83)

### 5.1 Records

`workflow_intake`, one row per exchange (key: the exchange id; foreign key
to the outbox): `recipient_session_id`, `workflow_session_id`, `run_id`,
`envelope_sha256`, `text_sha256`, `claim_id`, `state`, counters
(`duplicates`, `conflicts`), `created_at`, `updated_at`, `settled_at`,
`reason`. States: `holding`, `presented`, `cancelled`, `refused_full`.

### 5.2 Claim and settle (state-conditioned; one statement each)

| Row | Caller's claim | Result | Write |
|---|---|---|---|
| none | `c` | `accepted` | insert `holding(c)` |
| `holding(c)` | `c` | `accepted` (the activity ran before and its reply was lost) | none |
| `presented(c)`, `cancelled(c)` or `refused_full(c)` | `c` | that state | none |
| any state under `d` ≠ `c` | `c` | `duplicate` (with the state) | counter only |
| any, envelope hash differs from the row's | any | `conflict` | counter only |
| outbox missing or mismatched | any | `unverified` | none |

A claim id that does not hold its row never takes it back. Settle is
`UPDATE … SET state = $to … WHERE exchange_id = $1 AND claim_id = $c AND
state = 'holding'`, `$to` one of `presented`, `cancelled`, `refused_full`;
a repeat or a stale settle changes nothing.

### 5.3 Arrival

For a prompt message with `workflowIntake`, in drain and in the sweep:

1. Shape check of the envelope. A bad shape is refused and recorded; the
   message does not fall through to the ordinary path.
2. `claimId := yield ctx.newGuid()`.
3. `yield claimWorkflowIntake(...)` (critical, 5.4).
   - `duplicate`, `conflict`, `unverified`: recorded; no timer released,
     no digest taken, no tombstone consumed, no id becomes pending.
   - `accepted`: the canonical item (section 3) goes on.
4. Cancel check on the canonical client id. Cancelled: drop as today and
   settle `cancelled`.
5. The 20-id window is not consulted for an intake message; its canonical
   id still enters the window when the item is stored.
6. The item follows its own path's prompt handling (section 6) and is
   stashed with `intake: {exchangeId, claimId, textSha256}`.

### 5.4 The retained area and critical persistence

- **Retained area:** KV keys `intake.0` to `intake.7`, packed like the
  FIFO's buckets, at most 8 keys (the instance has 150; the FIFO uses 20).
  An entry is either `unclaimed {claimId, envelope, nextAttemptAt,
  attempts}` or `held {canonical item}`, kept in arrival order.
- **Claim failure (F6, F9):** the claim activity retries transient store
  errors in-activity (1 s, 5 s, 15 s). A missing workflow store or
  exhausted retries make it throw; the orchestration catches that one
  failure, keeps the message as `unclaimed` in the retained area with its
  `claimId`, and continues its loop (commands keep being serviced). Each
  later pass retries due `unclaimed` entries with the same `claimId`
  (backoff 30 s doubling to 15 min). A missing store is never treated as a
  forged envelope.
- **FIFO without room (F7):** an accepted canonical item that the FIFO
  refuses at any of the four append sites (`queue.ts` 844, 1144, 1195,
  1293) becomes `held` in the retained area. Each pass first moves `held`
  entries, oldest first, into the FIFO while it has room.
- **Area full:** a `held` item that finds the area full is settled
  `refused_full` (critical): the intake row, an event on the recipient, and
  an annotation on the sending outbox row (`intake_outcome:
  refused_full`) with an event on the sending workflow. It is not admitted
  and not reported as admitted. An `unclaimed` message that finds the area
  full is claimed at once with mode `refuse`, which verifies it and
  records `refused_full` the same way; if that write also cannot be made,
  the execution fails (the one fail-stop case: a persistent store outage
  with the area full).
- Claim and settle use the critical policy, never `recordSessionEvent`.
  Diagnostic events (duplicate, conflict) may stay best-effort; the row's
  counters are written by the claim itself.

### 5.5 Presentation

When `decide` dispatches a turn, it settles `presented` for every intake
item in that turn (the first item and the merged ones) in one critical
yield, after the sweep, the cancel check and the merge, and before
`processPrompt`. That yield is in the same history prefix as the dispatch;
a crash before it replays the pop, the sweep and the merge from history.
After `presented` the item is the turn's, with the turn's retry, budget
and workspace semantics.

## 6. Paths

### 6.1 Sites

| Site | Today | Intake addition |
|---|---|---|
| `drain-incoming`, `predispatch-incoming` (`queue.ts` 936, 1261) | cancel check consumes the tombstone | claim first (5.3); cancel only an accepted claim, then settle `cancelled` |
| `drain-stash`, `predispatch-stash` (831, 1183) | tombstone drops a stashed prompt | settle `cancelled` |
| `decide-fifo`, `decide-merge` (1443, 1365) | tombstone drops a queued prompt | settle `cancelled` |
| Append at a command, at the end of drain, at a command in the sweep, at the end of the sweep (844, 1144, 1195, 1293) | lost items reported | lost intake items become `held` (5.4) |
| Dispatch (1431-1501) | pop, sweep, cancel check, merge, turn | settle `presented` before the turn (5.5) |

### 6.2 Drain and sweep keep their semantics (F8)

- **Drain:** an intake item takes the drain prompt path: timer release, the
  timer note, the child digest, give-back of carried work on loss, and
  `settleQueuedWorkAfterDecide` when no turn starts.
- **Sweep:** an intake item takes the sweep prompt path: no timer release,
  no note, no digest take, no new `utcNow` yields.
- Both claim before the cancel check; a `duplicate`, `conflict` or
  `unverified` result never calls `dropCancelledPrompt`.

### 6.3 FIFO parsing

In 1.0.83 a bucket (FIFO or retained area) that does not parse fails the
execution with the key's name. It is never read as empty. The frozen 1.0.82
code is not changed.

## 7. Linearization and invariants

These are separate commits, not one transaction:

| Point | Commit |
|---|---|
| L1 | the sender's enqueue on `messages` |
| L2 | the claim's store transaction (`holding(c)`) |
| L3 | the orchestration's history commit that includes the item in the FIFO or the retained area (KV) |
| L4 | the `presented` settle, in the history prefix of the dispatch |
| L5 | the turn |

Recovery between them is by replay: the dequeue, the claim id and the
claim's result are in history; a lost reply re-runs the claim with the same
id (5.2). This design assumes, as the FIFO already does, that the
provider commits an orchestration turn's history and KV writes together; it
does not prove that here.

- **I1:** at most one claim per exchange is ever `presented`.
- **I2 (holding):** for `holding(c)`, the item with claim `c` is in the
  current pass, the FIFO, the retained area or the current dispatch (all
  rebuilt by replay), or the recipient's orchestration has ended.
- **I3:** only the holder of `c` settles, and only from `holding`.
- **I4:** a row exists only for an exchange whose outbox row names this
  recipient, workflow, run, contract and payload hash; the admitted text
  is the canonical render whose hash the row records.
- **I5:** a `durable` receipt belongs to an exchange whose every copy
  carried the envelope (enforced by section 4).
- **I6:** every dequeued copy of a durable exchange ends in exactly one of
  the outcomes of section 2.

## 8. Versions (F5)

1. **Freeze first.** Copy `orchestration/` to `orchestration_1_0_82/` with:
   `CURRENT_ORCHESTRATION_VERSION = "1.0.82"` as a literal; the index still
   passing the live `DURABLE_SESSION_LATEST_VERSION` as `latestVersion`;
   imports only of `types`, `session-proxy` and `orchestration-version`,
   never of the live `orchestration/` files; registry entry; a freeze test
   copied from 1.0.81's with file hashes. No intake yield exists before
   this commit.
2. **1.0.83 only:** the intake code, the retained area, the FIFO parsing
   change and a continue-as-new floor: `versionedContinueAsNew` in 1.0.83
   never targets a version older than its own; if the live latest is
   older, it fails the execution with that reason instead of moving down.
   A unit test keeps `DURABLE_SESSION_LATEST_VERSION` at or above every
   registered version.
3. **Frozen trees are not changed.** 1.0.82 and earlier keep their
   schedules and their upward continue-as-new.
4. **Fingerprints:** the surface gains exactly `claimWorkflowIntake` and
   `settleWorkflowIntake`, only in the 1.0.83 tree; the command drive
   golden is unchanged, because an ordinary message adds no yield.
5. **Rollout:** deploy every worker, then turn on `workflowIntakeV1`.
   Workers that run 1.0.83 stay until 1.0.83 sessions drain, as for every
   earlier version; a rollback needs a separately authorized, coordinated
   plan. An older build cannot replay a 1.0.83 history and does not read
   the intake tables, so it reinterprets neither. The outbox trigger stays
   in place and keeps an older worker from sending a plain copy of a
   durable exchange.

## 9. Failure matrix

| # | Failure | Result |
|---|---|---|
| 1 | Crash before the claim | Replay claims the same copy with the same id. |
| 2 | Claim committed, reply lost | The same id gets `accepted` again; one item. |
| 3 | Crash after the claim's reply, before the KV write | Replay rebuilds the item from history. |
| 4 | A later copy after more than 20 other messages, after continue-as-new, after a restart | `duplicate`; not admitted. |
| 5 | Two copies in one pass | The second is a `duplicate`. |
| 6 | An older worker attempts a durable exchange | The outbox trigger refuses its counted attempt; no plain copy is queued. |
| 7 | A `sendSessionEvent` object with a forged or copied envelope | The ingress refuses `workflowIntake`; behind it, the claim verifies the outbox and admits only the canonical render. A copy of a real envelope can at most claim the exchange with the real message. |
| 8 | Store missing on the claiming worker, or a store outage | `unclaimed` in the retained area; retried with the same id; commands keep running. |
| 9 | FIFO full | `held` in the retained area, moved in as room appears. |
| 10 | Retained area full | `refused_full`, recorded and shown to the sender. |
| 11 | Store outage with the retained area full | The execution fails (the one fail-stop case). |
| 12 | Tombstone before the copy, in a pass, in the FIFO, in a merge, in the sweep | Claim, then drop and settle `cancelled`; later copies are duplicates; no duplicate consumes a tombstone. |
| 13 | The sweep ends the session after a pop | The session ended; the row stays `holding`; the sender's next attempt, if any, finds the session ended. |
| 14 | A FIFO or retained bucket that does not parse | The execution fails with the key's name. |
| 15 | A stale claim or settle after `presented`, `cancelled` or `refused_full` | No write (5.2). |
| 16 | `legacy_window` exchange | Today's semantics; the receipt says so. |

## 10. Retention

No intake row is deleted while its recipient's orchestration is not
terminal, and none while its outbox row exists. Counters may grow for the
life of the row. A purge belongs to the retention item.

## 11. Ordinary messages

Messages without `workflowIntake`, including legacy-mode workflow
messages, take exactly today's path and yields: the 20-id window, its CAN
carry, the cancel set, the order of the checks, the duplicate event.

## 12. Plan and coverage

Commits, each with DEV tests and independent review:

1. Freeze 1.0.82 and open 1.0.83 (no behavior change); freeze guard,
   monotonic-latest test.
2. Storage: the migration (`workflow_intake`, `intake_mode`,
   `attempt_token` and its trigger, `intake_outcome`), store claim, settle
   and canonical render; store tests.
3. Recipient intake in 1.0.83: both arrival paths, the retained area, the
   presentation settle, all sites, the continue-as-new floor, FIFO parse
   failures, the reserved key at the generic ingress, fingerprints.
4. Sender: the capability, the sticky mode, the attempt token, the
   envelope, the receipt, the read view, the README.
5. Formal model `WorkflowV2Intake.tla` for an agent recipient: copies,
   claims with lost replies, the retained area, presentation, tombstones,
   continue-as-new and session end; mutations for each fix.

| Obligation | Test |
|---|---|
| Freeze | Literal, live latest target, imports, hashes, registry; downward continue-as-new refused in 1.0.83. |
| F3 table | Every row, including the same claim after `cancelled`, `presented` and `refused_full` (no write). |
| Lost reply | Replay with the same guid: one item. |
| F1 | An older worker's counted attempt on a durable row fails; a legacy row is unaffected; one admission. |
| F2 | Queued text differs from the outbox: the admitted text is the render, also on replay; a generic event with `workflowIntake` is refused. |
| More than 20 ids | A durable copy, 21 other prompts, the same copy: suppressed. Positive control: a legacy exchange admitted twice. |
| F7 | FIFO full: the item is held and admitted later; area full: `refused_full`, visible to the sender. |
| F6, F9 | Missing store and store outage: `unclaimed`, retried, commands serviced, one admission. |
| F8 | Sweep arrival: no timer release, no digest; claim before cancel on both paths. |
| Cancels | Before arrival, in a pass, in the FIFO, in a merge, in the sweep. |
| F4 | `presented` written before the turn; unparseable buckets fail the execution. |
| CAN | Items, retained entries and rows survive continue-as-new; 1.0.82 inputs run on 1.0.83. |
| Fingerprints | The surface gains only the two activities; the drive golden is unchanged. |
| Baseline | Full suite and baseline are a separate grant. |

## 13. Remaining questions

1. The retained area's size (8 keys) and the claim backoff are proposals.
2. Whether the annotation on the sending outbox row and the event on the
   sending workflow are enough visibility for `refused_full`, as proposed.
   The send state itself stays `sent`, which means queue acceptance.
