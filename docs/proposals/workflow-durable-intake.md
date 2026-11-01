# Workflow messaging: durable recipient intake (design A, revision 3)

Status: revised design checkpoint for review. Docs only; no code changes.
Revision 2 (`e287ddb3`) revised `c92d7eb1` after the Grok review
(`wfv2-intake-design-c92d7eb1-grok-review.md`, SHA-256 `e77c20b8…`) with the
parent's qualifications (`pse/wfv2/review/intake-design-c92d7eb1-grok`).
Revision 3 is a focused delta for the review of revision 2
(`wfv2-intake-design-e287ddb3-grok-review.md`, SHA-256 `8919a83f…`, findings
N1 to N6, with the parent's qualifications); F5 and F8 stay closed as
specified. Source base: `9fcbf377`; line numbers are at that commit (the
session orchestration, client, worker and retry files are unchanged since
`fa7c232f`). Dependency facts are pinned in section 1.

A messaging `send` state queues its message for an agent session at least
once. Today the recipient drops a repeat only while the exchange's client
message id is among its 20 most recent ids. Design A gives a recipient on
session orchestration 1.0.83 a durable intake record per exchange: the
session admits each durable-mode exchange at most once, admits it from the
sender's immutable outbox row and not from the queued bytes, keeps it in a
bounded retained area when it has no room, holds it until a turn that ran
carried it, and refuses it visibly when it cannot keep it. Exchanges outside
durable mode keep today's semantics.

## 0. Finding resolution

Revision 3:

| Finding | Resolution | Section |
|---|---|---|
| N1 (P1): durable mode is not a locked transition; claim does not check it | The first counted attempt decides the mode, counts and sets the token in one `UPDATE` under `beginDelivery`'s locks. A row counted while its mode was unset stays legacy for ever: the trigger refuses any later promotion, and refuses a count on a durable row that keeps its token. Claim admits only an outbox row in durable mode. A copy that carries the envelope is never handled as an ordinary prompt. New columns are nullable, so the old insert and the old count still run. No schema rollback drops the fence while a durable exchange or a 1.0.83 history can replay. | 4, 5.3 |
| N2 (P1): a retained retry has no wake | The earliest due retained retry is a third deadline in drain's existing race of `messages` against a timer; a command still wins the race and is handled first. The due time and the claim id are in KV and survive continue-as-new. No sleep, no busy loop, no need for another message. The fingerprint delta of 1.0.83 is declared, timers and `utcNow` included. | 5.4, 6.2, 8 |
| N3 (P1): `presented` before the turn can drop the only copy | `presented` is replaced by `admitted`, settled only after a turn that carried the item ran (its result is neither a gate refusal nor an error). Until then the item is in a claim-bearing handoff that every non-admitted return keeps (budget, workspace, credentials, hydration, retries) and continue-as-new carries; the `[SYSTEM:` stash exclusion does not apply to it. Retries and cancels are accounted. Frozen versions are unchanged. | 5.5, 6.1 |
| N4 (P1): one claim can place two items; refuse can undo a winner | One placement per exchange and claim, across the pass, the FIFO, the retained area and the handoff: `accepted` places an item only when none exists. A `refuse` table: only a missing row becomes `refused_full`; a row under the same claim answers its state with no write; another claim is a duplicate; a holding row with a placement is never refused. A settle that changes no row dispatches nothing. | 5.2, 5.3, 7 |
| N5 (P1): the source annotation has no lock order or deleted-source rule | The refusal transaction locks both session rows in ascending id with `beginDelivery`'s modes before the outbox and intake rows. A deleted source is not touched: no annotation, no event, no `project`; the recipient's row still records the outcome. A live sender sees the refusal as an event on its session and as `intake_outcome` on its outbox row (`readOutboxMessage`); no user-facing outbox view exists at this base and none is added. `sent` stays queue acceptance; the receipt is frozen at delivery. | 5.4, 5.6 |
| N6 (P2): eight keys are not a byte cap | UTF-8 byte caps, measured on the exact stored strings: envelope, canonical item, bucket, retained area and handoff, below duroxide 0.1.32's `MAX_KV_VALUE_BYTES` with the JSON wrappers and escaping counted; shared KV use is stated. Oversize is refused before any KV write and recorded; the execution continues. A retry updates its entry in place. | 5.4, 5.7 |

Revision 2:

| Finding | Resolution | Section |
|---|---|---|
| F1 (high): mixed plain and enveloped copies bypass the claim; the recipient version does not fence the sender | Durable mode needs a deployment capability (every worker intake-capable) and the recipient's observed version (fail closed). A migration adds an outbox trigger that refuses a counted attempt on a durable-mode row unless the attempt carries a new attempt token, which only intake-capable code sets: an older worker cannot count an attempt, so it never queues a plain copy of a durable exchange. Every copy of a durable exchange is enveloped; a legacy exchange has none. Client ids are not parsed for authority, the 20-id window is not proof of anything, and no admission before the boundary is reconstructed. Revision 3 makes the mode decision one locked update and forbids promotion (N1). | 4 |
| F2 (high): the envelope does not bind the admitted message; a public write can queue arbitrary JSON | The claim returns the canonical message rendered from the immutable outbox row by the sender's own renderer, with its hash, in its history-recorded result. The session admits exactly that: the canonical text, client id, system sender, `bootstrap: false`, no required tool, no attachments. Every queued field is ignored for an intake message. `workflowIntake` becomes a reserved key that the generic event ingress refuses (defense in depth; the binding does not depend on it). Revision 3: the claim also requires durable mode (N1). | 3 |
| F3 (high): a same-claim result after release or cancel could resurrect a reservation | State-conditioned claim table, one statement each; a claim id that no longer holds its row gets that row's state, with no write; settle acts only from `holding` under its own claim. Revision 3 adds the refuse rows and one placement per claim (N4). | 5.2 |
| F4 (high): the holding invariant is false after presentation; pop, sweep, merge and FIFO parse paths | Revision 3 replaces the `presented` settle before the turn with `admitted` after a turn that ran, and a handoff that holds the item until then (N3). I2 is a holding obligation only. The pop-before-sweep window is covered. 1.0.83 fails an execution on an unparseable FIFO bucket instead of reading it as empty. Provider KV and history atomicity is an assumption, not a proof here. | 5, 7 |
| F5 (medium): freeze literal, hash locks, imports and downward continue-as-new | Freeze rules as for 1.0.81 (literal, live latest target, historic imports, hash locks) before any new yield; a continue-as-new floor in 1.0.83 only; a monotonic-latest guard; the frozen trees are not changed. | 8 |
| F6 (medium): a missing workflow store is not a forged envelope | A claim that cannot reach the store is retried, never refused: the item waits in the retained area as `unclaimed` and the claim is tried again on a backoff, on any worker. Revision 3 adds the wake (N2). | 5.4 |
| F7 (medium): release alone gives no progress after the sender recorded its only copy | No release on a full FIFO: the canonical item waits in a bounded retained area and is moved into the FIFO as room appears. When that area is also full, the exchange is refused explicitly (`refused_full`): recorded with a critical write, shown to the sender, never reported as admitted. Revision 3 adds N4, N5 and N6. | 5.4, 5.5 |
| F8 (medium): the sweep must keep its own semantics | Drain and sweep each keep their own prompt path: the sweep releases no timer, takes no digest and adds no note. Both claim before the cancel check; a duplicate never consumes a tombstone. All four append sites and all six drop sites are covered. | 6 |
| F9 (low): critical persistence | Claim and settle are critical store writes, never `recordSessionEvent`. Their bounded in-activity retry, the retained-area fallback that keeps commands serviced, and the one fail-stop case are stated. Revision 3 adds the wake for the retry (N2). | 5.4, 9 |
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
| `beginDelivery` locks both session rows (`lockInputSessions`), then the node and the outbox row `FOR UPDATE`, and counts with `UPDATE … SET attempts = attempts + 1` as its last statement; the deliver activity queues the message only after that transaction returned `deliver`. The outbox insert names its columns explicitly. | `store.ts` 2277-2336, 1911-1917; `runtime.ts` 1955-1962 |
| Drain races `dequeueEvent("messages")` against a timer for the earliest of the active timer and the child-digest window, and blocks on the dequeue alone when nothing is due (`needsBlockingDequeue`); a command that wins a race is handled before anything else. | `queue.ts` 433-470, 480-488, 744-781, 785-807 |
| `stashBudgetRefusedPrompt` returns without stashing a prompt that starts with `[SYSTEM:`; budget and workspace refusals call it. A turn result is a gate refusal when it is a `wait` with a gate; such a turn never ran. Credential failure, hydration give-up and exhausted retries end the attempt with no stash. | `turn.ts` 1020, 1184, 1413, 729-735, 628-633, 470-490, 310-328 |
| `workflowSendPrompt` text starts with `[SYSTEM: A workflow sent you a typed message. …]` and a JSON line. | `runtime.ts` 1097-1109 |
| The session orchestration's KV keys: `fifo.0` to `fifo.19`, `meta.responseVersion`, `meta.commandVersion`, `response.latest`, and one `command.response.<id>` per handled command, which the orchestration never clears. | `queue.ts` 52-68; `types.ts` 1821-1827; `lifecycle.ts` 115-140 |
| duroxide 0.1.32 (pinned below): at most 150 user KV keys per instance and 64 KiB per value, checked after each turn; a turn over either limit fails the orchestration. KV is per instance and survives continue-as-new; duroxide-pg from migration 0019 no longer deletes KV when it prunes executions. | `src/runtime/limits.rs` 39-48; duroxide-pg `migrations/0019_add_kv_last_updated.sql` (part 4) |

Dependency evidence (read as public source over HTTPS, nothing executed;
the files and a manifest with their SHA-256 are retained as artifact
`wfv2-dependency-evidence-r1.tgz`, SHA-256 `49f25ecb…`):

| Claim | Source and pin |
|---|---|
| The npm package | `package-lock.json` 7761-7773 pins `duroxide` 0.2.4; duroxide-node tag `v0.2.4` is commit `7722f193184af0f2b01095b72464607b97d92aa1`; its `Cargo.toml` (SHA-256 `ec0a6b91…`) requires `duroxide` 0.1.32 and `duroxide-pg` 0.1.38 (caret ranges; that repository has no `Cargo.lock`, so the binary's resolved versions are not proved by source; crates.io listed 0.1.32 and 0.1.38 as the latest on 2026-11-01). |
| Limits | duroxide tag `v0.1.32`, commit `585c89c86f03956f799913cf0b98186452221e75`, `src/runtime/limits.rs` (SHA-256 `318468e8…`): `MAX_WORKER_TAGS` 5 (30), `MAX_KV_KEYS` 150 (43), `MAX_KV_VALUE_BYTES` 64 KiB (48). |
| KV across continue-as-new and pruning | KV survives continue-as-new: the session FIFO already relies on it, and duroxide's design text says so (`docs/proposals/orchestration-kv-store.md` at `585c89c8`, SHA-256 `0b84a787…`, 12, 391-400; design text, not a test). duroxide-pg tag `v0.1.38`, commit `54255d1664ca630fe9d3501502dfdba5dec455f9`: `migrations/0018_add_kv_store.sql` part 5 deleted KV on prune; `migrations/0019_add_kv_last_updated.sql` (SHA-256 `7075f5a3…`) part 4 removed that delete. |

## 2. Guarantee

For a durable-mode exchange (section 4) whose recipient runs 1.0.83:

- **At most one admission.** At most one copy is admitted to the session's
  work, whatever the number, order and timing of the copies, after any
  number of other messages and across continue-as-new and restarts.
- **No silent loss.** Each copy that the session dequeues ends as exactly
  one of: admitted, which means a turn that carried it ran (5.5);
  cancelled by a tombstone (recorded); a duplicate of a copy that holds
  or was admitted (recorded); refused as unverified, malformed or
  conflicting (recorded, never handled as an ordinary prompt); refused
  for capacity (`refused_full`) or size (`refused_size`), recorded and
  visible to a live sender (5.6); or abandoned because the recipient's
  session ended, as for any queued work.
- **Conditional progress.** While the store answers, the session runs and
  its turns are not held back (a budget or workspace gate retries on its
  own timer; after a credential failure, a hydration give-up or exhausted
  retries, the item waits for the session's next turn), a claimed copy is
  admitted unless it is cancelled or the session ends; one that does not
  fit waits in the retained area and is moved into the FIFO as room
  appears.

Not given: exactly-once delivery, reading, model behavior or external
effects; any guarantee for a `legacy_window` exchange (at least once with
the 20-id window, as its receipt says); any statement about exchanges
admitted before the boundary. `sent` stays queue acceptance, not a read.

## 3. Identity and the canonical message

- **Identity.** The intake key is the exchange id. The claim reads the
  outbox row for it and accepts only if the row is in durable mode
  (`intake_mode = 'durable'`, section 4), and the row's workflow session,
  run, recipient (the claiming session itself), recipient kind (`agent`),
  contract and payload hash equal the envelope's, and the envelope's hash
  over those immutable fields is correct. A row in `legacy_window` mode or
  with no mode is `unverified`, even when every other field matches.
- **An envelope is never an ordinary prompt.** A dequeued message that
  carries `workflowIntake` takes the intake path only: a bad shape is
  refused as malformed; `unverified` and `conflict` are refused; each is
  recorded and none falls through to the ordinary prompt path. Only a
  copy without the envelope (a legacy exchange's plain copy) takes today's
  path.
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
  read for an intake message. The drain path may produce the session's own
  timer note, as for any prompt (6.2); for an intake item the note goes to
  the turn's system context, not into the item, so the canonical text and
  its stored size never change.
- **Reserved key.** `workflowIntake` is reserved: the shared validation of
  the generic event ingress refuses a payload that carries it, for every
  transport that reaches that ingress. This is defense in depth; sections
  3 and 4 do not depend on it. The other reserved queue fields (sender,
  bootstrap, required tool, commands) are the security contract's queue-
  shape item and the human-input slice, tracked there; this design does
  not claim to close them.

## 4. Sender: the capability boundary

- **Columns.** The migration adds `intake_mode` (`durable` or
  `legacy_window`, nullable, no default), `attempt_token` (nullable),
  `intake_outcome` (`refused_full` or `refused_size`, nullable) and
  `intake_outcome_at` (nullable) to `workflow_outbox`. The old explicit
  insert (`store.ts` 1911-1917) and the old count statement still run
  unchanged; a row inserted or counted by an older build has no mode.
- **The decision is one locked update.** Intake-capable `beginDelivery`
  keeps its locks (both session rows, then the node and the outbox row
  `FOR UPDATE`) and replaces the count with one statement that counts,
  decides the mode on the first count, and sets the token:

  | Row under the outbox lock | Caller | The statement writes |
  |---|---|---|
  | `attempts = 0`, no mode; the deployment capability `workflowIntakeV1` is on and the recipient's observed version is at least 1.0.83 | intake-capable | `attempts + 1`, `intake_mode = durable`, a new `attempt_token` |
  | `attempts = 0`, no mode; otherwise | intake-capable | `attempts + 1`, `intake_mode = legacy_window`; token unchanged |
  | `attempts = 0`, no mode | older build | `attempts + 1`; the mode stays unset, which reads as `legacy_window` for ever |
  | `attempts > 0`, mode unset or `legacy_window` | any | `attempts + 1` only; it never becomes `durable` |
  | mode `durable` | intake-capable | `attempts + 1` and a new token |
  | mode `durable` | older build (`attempts + 1`, token unchanged) | the trigger raises; the transaction rolls back; nothing is queued |

  The observed version is read before the transaction (an observation,
  not a fence); a missing, empty or unparseable version is
  `legacy_window` (fail closed, unlike the workspace gate). The fence is
  the trigger and the claim's mode check.
- **The trigger** (`BEFORE UPDATE` on `workflow_outbox`) raises when:
  the mode changes other than from unset on the update that takes
  `attempts` from 0 to 1; the mode becomes `durable` without a new
  non-null token in the same update; or `attempts` grows on a `durable`
  row while the token stays the same. So a row that an older build counted
  first can only stay legacy, a later promotion fails, and an older
  build's count on a durable row fails. The deliver activity queues only
  after its counting transaction commits (`runtime.ts` 1955-1962), so a
  refused count queues nothing.
- **Envelopes.** Intake-capable code puts the envelope on a copy only when
  the row its count returned is `durable`; a legacy row's copies are
  plain. Every copy of a durable exchange carries the envelope.
- **Rollback.** Worker rollback keeps the trigger: older workers then fail
  closed on durable rows and keep serving legacy rows. The migration has
  no down step for the trigger or the columns. Removing the fence needs a
  separately authorized change that first shows no `durable` row is still
  pending and no 1.0.83 history can still replay.
- **Not adopted.** Parsing `workflow:` client ids at the recipient as
  authority, or treating a hit in the 20-id window as proof that an
  exchange was admitted. Ids are untrusted text, any user can send them,
  and doing so would change legitimate legacy semantics.
- **Legacy and history.** Exchanges sent before the boundary, or in
  `legacy_window` mode, keep the 20-id window; admissions older than that
  window are not reconstructed; no retroactive at-most-once claim is made.
- **Receipt.** `intake: "durable" | "legacy_window"`, frozen in the receipt
  that the delivery record writes once; the parser reads a receipt without
  the field as `legacy_window`. A later intake outcome is a separate field
  of the outbox row (5.6) and never rewrites the receipt.

## 5. Recipient (orchestration 1.0.83)

### 5.1 Records

`workflow_intake`, one row per exchange (key: the exchange id; foreign key
to the outbox): `recipient_session_id`, `workflow_session_id`, `run_id`,
`envelope_sha256`, `text_sha256`, `claim_id`, `state`, counters
(`duplicates`, `conflicts`), `created_at`, `updated_at`, `settled_at`,
`reason`. States: `holding`, `admitted`, `cancelled`, `refused_full`,
`refused_size`. Every state but `holding` is final.

A **placement** is where the orchestration keeps a claimed item: the
current pass's stash, a FIFO bucket, the retained area (`held`) or the
handoff (5.5). Each placed item carries `intake: {exchangeId, claimId,
textSha256}`. An exchange has at most one placement, and only under the
claim whose row is `holding` (I2, I7).

### 5.2 Claim and settle (state-conditioned; one statement each)

Claim (`claimWorkflowIntake`, mode `accept` or `refuse`):

| Row | Caller's claim | Result | Write |
|---|---|---|---|
| none; outbox durable and matching; mode `accept`; item within the cap (5.7) | `c` | `accepted` | insert `holding(c)` |
| none; outbox durable and matching; mode `accept`; item over the cap | `c` | `refused_size` | insert `refused_size(c)` in the refusal transaction (5.6) |
| none; outbox durable and matching; mode `refuse` | `c` | `refused_full` | insert `refused_full(c)` in the refusal transaction (5.6) |
| `holding(c)` | `c`, either mode | `accepted` (the earlier call committed; its reply was lost) | none |
| `admitted(c)`, `cancelled(c)`, `refused_full(c)` or `refused_size(c)` | `c`, either mode | that state | none |
| any state under `d` ≠ `c` | `c`, either mode | `duplicate` (with the state) | counter only |
| any, envelope hash differs from the row's | any | `conflict` | counter only |
| outbox missing, not durable, or mismatched | any | `unverified` | none |

A claim id that does not hold its row never takes it back, and no claim
changes a row that exists. An `accepted` result returns the canonical item
(section 3); the orchestration places it only if the exchange has no
placement (5.3), so a repeated `accepted` for the same claim restores a
missing placement and never adds a second one.

Settle (`settleWorkflowIntake`) is `UPDATE … SET state = $to … WHERE
exchange_id = $1 AND claim_id = $c AND state = 'holding'`, `$to` one of
`admitted`, `cancelled`, `refused_full`, `refused_size`, and returns the
row's state after it. A settle by the holder removes the placement in the
same synchronous step (no yield between). A settle whose row is already in
`$to` under `c` (a replay) is the same result. A settle that finds the row
in another state or under another claim is a broken invariant: the
execution fails with the exchange id, and nothing is dispatched for it.
`refused_full` and `refused_size` settles run in the refusal transaction
(5.6).

### 5.3 Arrival

For a prompt message with `workflowIntake`, in drain and in the sweep:

1. Shape and size check of the envelope (5.7). A bad shape or an envelope
   over its cap is refused and recorded; nothing is written to KV, and
   the message does not fall through to the ordinary path.
2. `claimId := yield ctx.newGuid()`.
3. `yield claimWorkflowIntake(...)` (critical, 5.4).
   - `duplicate`, `conflict`, `unverified`, `refused_size`: recorded; no
     timer released, no digest taken, no tombstone consumed, no id
     becomes pending, nothing placed.
   - `accepted`: if the exchange already has a placement, nothing more
     happens; otherwise the canonical item (section 3) goes on.
4. Cancel check on the canonical client id. Cancelled: drop as today and
   settle `cancelled`.
5. The 20-id window is not consulted for an intake message; its canonical
   id still enters the window when the item is stored.
6. The item follows its own path's prompt handling (section 6) and is
   placed with its `intake` marker.

The placement check reads the pass's stash, the FIFO, the retained area and
the handoff, with no yield, before any placement.

### 5.4 The retained area, the wake and critical persistence

- **Retained area:** KV keys `intake.0` to `intake.7`, packed by bytes
  (5.7). An entry is either `unclaimed {claimId, envelope, nextAttemptAt,
  attempts}` or `held {canonical item}`, kept in arrival order. An
  `unclaimed` entry stores the envelope only, never the queued prompt.
- **Claim failure (F6, F9):** the claim activity retries transient store
  errors in-activity (1 s, 5 s, 15 s). A missing workflow store or
  exhausted retries make it throw; the orchestration catches that one
  failure, keeps the message as `unclaimed` in the retained area with its
  `claimId` and a due time (`ctx.utcNow()` plus 30 s, doubling to 15 min),
  and continues its loop (commands keep being serviced). A retry updates
  its entry in place (`attempts`, `nextAttemptAt`); it never adds one. A
  missing store is never treated as a forged envelope.
- **The wake (N2).** In 1.0.83 drain's existing timer race has a third
  deadline: the earliest `nextAttemptAt` of the `unclaimed` entries, next
  to the armed timer and the child-digest window (`queue.ts` 433-470,
  744-781). While an `unclaimed` entry exists, drain does not block on the
  dequeue alone (`needsBlockingDequeue` is false), so it reads
  `ctx.utcNow()` and races `dequeueEvent("messages")` against
  `scheduleTimer` for the earliest deadline. A message that wins the race
  is handled as today, a command first. When the intake deadline wins, the
  armed timer stays armed (as when the digest window wins), and drain
  retries every due entry with its own claim id, oldest first. The due
  times and claim ids are KV values, so they survive continue-as-new and a
  restart. No sleep, no busy loop, and no other message is needed. A
  session with no `unclaimed` entry runs exactly today's drain.
- **FIFO without room (F7):** an accepted canonical item that the FIFO
  refuses at any of the four append sites (`queue.ts` 844, 1144, 1195,
  1293) becomes `held` in the retained area, in the same synchronous step.
  Each drain pass first moves `held` entries, oldest first, into the FIFO
  while it has room; the FIFO gets room when `decide` takes work, so held
  entries need no timer.
- **Area full:** an accepted item (the holder, with no placement) that
  finds the FIFO and the area full is settled `refused_full` from
  `holding` (5.6). An `unclaimed` message whose retry finds the area full
  is claimed with mode `refuse` (5.2): a new row becomes `refused_full`; a
  row the earlier call already took (`holding(c)`) returns `accepted`, and
  the holder then settles it `refused_full` because it has no room. If
  that write also cannot be made, the execution fails (the one fail-stop
  case: a persistent store outage with the area full).
- Claim and settle use the critical policy, never `recordSessionEvent`.
  Diagnostic events (duplicate, conflict, malformed) may stay best-effort;
  the row's counters are written by the claim itself.

### 5.5 Admission: the handoff holds the item until a turn ran (N3)

- **The handoff** is one KV key, `intake.handoff`, holding the canonical
  items (in the same stored shape as in the FIFO, 5.7) that a turn must
  still carry, in dispatch order, within its caps.
- **Into the handoff.** When `decide` takes an intake item from the FIFO,
  as the dispatched item or as a merged one, it removes it from its bucket
  and adds it to the handoff in the same synchronous step. While the
  handoff is full, `decide` leaves intake items in the FIFO and steps over
  them; the merge stops at one it cannot take.
- **Every attempt carries the handoff.** `processPrompt` puts every
  handoff text, in order, in front of the turn's own prompt, for every
  attempt of every turn, whatever started it (a dispatch, a retry, a gate
  timer, a cron or wait timer, a new message). Intake texts are never part
  of the ordinary prompt chain: not of the merged prompt, the budget stash,
  a retry's carried prompt or a pending prompt. So nothing carries them
  twice, and the `[SYSTEM:` exclusion of `stashBudgetRefusedPrompt`
  (`turn.ts` 1020) never meets them. A turn whose only work is the handoff
  has no ordinary prompt; a retry of it carries the 1.0.83 continue-as-new
  flag `handoffRetry` in place of a prompt, and `decide` starts a turn for
  the handoff when that flag is set.
- **Admission point.** A turn ended its attempt when `runTurn` returned a
  result that is neither `error` nor a gate refusal (a `wait` with a gate,
  `turn.ts` 729-735). Right after that result, one critical yield settles
  `admitted` (with the result type as `reason`) for every entry that
  attempt carried (the claim ids fixed when the attempt started), and the
  handoff is cleared in the same synchronous step. A crash before the
  settle replays to the same yield; the settle is idempotent.
- **Returns that do not admit.** The handoff stays, unchanged, through
  each of them, and through continue-as-new and restarts:

  | Return | What carries the handoff next |
  |---|---|
  | Budget or workspace gate refusal (`turn.ts` 1184, 1413) | The gate's own retry timer starts the next attempt. |
  | Thrown or error result with retries left (`turn.ts` 304-347) | The retry timer, then the retried turn; the retry carries the turn's count and key as today, but no intake text. |
  | Retries exhausted, credential failure, hydration give-up (`turn.ts` 310-328, 628-633, 470-490) | The session's next turn (the session's own prompt is dropped there today; an intake item is kept); no turn is started for the handoff alone, so a lasting failure does not loop. |
  | The session ends (cancel, delete, done) while entries wait | The entries end with the session (section 2); their rows stay `holding`. |

  A turn that returns `stopped` or `cancelled` also admits its entries, and
  the row records that result type as its `reason`. A Stop or a session
  cancel ended that turn's work, which included the item; it can stop
  before the model runs (`session-proxy.ts` 4304-4318) or after
  (`session-proxy.ts` 1693, 4716), and the result does not say which. The
  item is not carried again, so a second turn cannot repeat what the
  stopped one did.

- **Cancels.** A tombstone for the canonical client id of a handoff entry
  removes it and settles `cancelled`, unless a turn that carried it already
  ran. The next attempt carries the rest.
- Frozen versions are unchanged; 1.0.82 and earlier keep their dispatch
  and stash behavior.

### 5.6 The refusal transaction and the sender's view (N5)

- `refused_full` and `refused_size`, as an insert by a claim or as a
  settle, are written in one transaction that first locks both session
  rows with `lockInputSessions(source, recipient)`, the call
  `beginDelivery` makes (`store.ts` 2288): ascending session id, the
  source workflow's row `FOR NO KEY UPDATE`, the recipient's `FOR SHARE`;
  then the outbox row `FOR UPDATE`, then the intake row. The order matches
  `beginDelivery`'s, so the two cannot form a lock cycle.
- With the source live, the transaction also sets the outbox row's
  `intake_outcome` and `intake_outcome_at` (only from null) and projects
  one event on the sending workflow session. With the source deleted or
  missing, it writes neither and calls no `project` on it: no session
  touch, no event and nothing brought back. The recipient's intake row and
  its recipient-side event are written in both cases.
- What the sender can see: the event on the sending workflow session,
  through the existing session-event reads; and the outbox row's field,
  through `readOutboxMessage` (`WorkflowOutboxMessage`). At this source
  base no user-facing read view returns outbox rows, and this design adds
  no API. The send state stays `sent` (queue acceptance) with the receipt
  that its delivery record froze; a later intake outcome never rewrites
  it. A deleted source gets nothing, and its readers see the refusal
  nowhere.

### 5.7 Byte caps (N6)

Every cap is in UTF-8 bytes of the exact string written, wrappers and JSON
escaping included. duroxide 0.1.32 fails an orchestration turn whose KV
value is over 64 KiB, or whose instance has more than 150 user keys
(section 1).

| What | Cap | Where checked | Over the cap |
|---|---|---|---|
| The queued envelope (the `workflowIntake` object, fixed fields) | 1 KiB of its canonical JSON | arrival step 1, before any KV write | malformed, refused and recorded |
| One canonical item, in each form it can be stored in: a FIFO bucket, a retained `held` entry, or the handoff holding it alone | 60 KiB for the largest form (the bound of `MAX_FIFO_ITEM_BYTES`, `isFifoItemTooLarge`) | the claim, in the store, on the exact item and the fixed shapes the orchestration stores | `refused_size` (5.6) |
| An `unclaimed` entry, as stored | 2 KiB | arrival, before writing it | the envelope is over its cap: malformed |
| One retained-area key or the handoff key: the whole stored string | 60 KiB | before each write; an entry goes in only if the key's new string stays within the cap | the entry stays where it was (FIFO full: next key, or `refused_full`; handoff full: left in the FIFO) |
| The retained area | 8 keys, so at most 480 KiB | — | `refused_full` |
| User KV keys | 20 FIFO, 8 retained, 1 handoff, 3 response and command counters (`meta.responseVersion`, `meta.commandVersion`, `response.latest`) | — | — |

The 60 KiB caps leave 4 KiB below the 64 KiB limit, measured on the final
string, not on an item's share of it. The rendered text can be several
times its 16 KiB payload: `promptSafeJson` escapes brackets, and storage
escapes the JSON again. That is why the cap is on the stored string.
Shared key use: the session orchestration also keeps one
`command.response.<id>` key per handled command and never clears them
(`lifecycle.ts` 132-140). That existing growth counts against the same
150-key limit. This design adds 9 fixed keys and does not change it.

## 6. Paths

### 6.1 Sites

| Site | Today | Intake addition |
|---|---|---|
| `drain-incoming`, `predispatch-incoming` (`queue.ts` 936, 1261) | cancel check consumes the tombstone | claim first (5.3); cancel only an accepted claim, then settle `cancelled` |
| `drain-stash`, `predispatch-stash` (831, 1183) | tombstone drops a stashed prompt | settle `cancelled` |
| `decide-fifo`, `decide-merge` (1443, 1365) | tombstone drops a queued prompt | settle `cancelled` |
| Append at a command, at the end of drain, at a command in the sweep, at the end of the sweep (844, 1144, 1195, 1293) | lost items reported | lost intake items become `held` (5.4) |
| Dispatch (1431-1501) | pop, sweep, cancel check, merge, turn | an intake item moves into the handoff in the pop or merge step; every attempt carries the handoff; `admitted` after the turn (5.5) |
| The handoff (new) | — | a tombstone removes an entry and settles `cancelled`, unless a turn that carried it already ran |

### 6.2 Drain and sweep keep their semantics (F8)

- **Drain:** an intake item takes the drain prompt path: timer release, the
  timer note, the child digest, give-back of carried work on loss, and
  `settleQueuedWorkAfterDecide` when no turn starts. A timer note that
  drain would append to an intake item's text (`queue.ts` 1007-1051) goes
  to the turn's system context (`pendingSystemPrompt`) instead; the
  canonical text, its hash and its stored size never change.
- **Sweep:** an intake item takes the sweep prompt path: no timer release,
  no note, no digest take, no new `utcNow` yields.
- **The wake** (5.4) is in drain only. The sweep adds no timer and no
  `utcNow`.
- Both claim before the cancel check; a `duplicate`, `conflict` or
  `unverified` result never calls `dropCancelledPrompt`.

### 6.3 FIFO parsing

In 1.0.83 a bucket (FIFO, retained area or handoff) that does not parse
fails the execution with the key's name. It is never read as empty. The
frozen 1.0.82 code is not changed.

## 7. Linearization and invariants

These are separate commits, not one transaction:

| Point | Commit |
|---|---|
| L1 | the sender's counting transaction, which fixes the mode (section 4) |
| L2 | the sender's enqueue on `messages` |
| L3 | the claim's store transaction (`holding(c)`) |
| L4 | the orchestration's history commit that places the item: the FIFO, the retained area or the handoff (KV) |
| L5 | the turn attempt's result in history |
| L6 | the `admitted` settle, the next yield after a result that admits (5.5) |

Recovery between them is by replay: the dequeue, the claim id and the
claim's result are in history; a lost reply re-runs the claim with the same
id (5.2). Each move between the FIFO, the retained area and the handoff
writes both keys in one synchronous step, with no yield between, so one
history commit has both. This design assumes, as the FIFO already does,
that the provider commits an orchestration turn's history and KV writes
together; it does not prove that here.

- **I1:** at most one claim per exchange is ever `admitted`, and a row's
  final state never changes.
- **I2 (holding):** for `holding(c)`, claim `c` is in exactly one of: the
  current pass's claim call, an `unclaimed` entry, or a placement (the
  pass's stash, the FIFO, `held`, the handoff), all rebuilt by replay; or
  the recipient's orchestration has ended.
- **I3:** only the holder of `c` settles, and only from `holding`.
- **I4:** a row exists only for an exchange whose outbox row is in durable
  mode and names this recipient, workflow, run, contract and payload hash;
  the admitted text is the canonical render whose hash the row records.
- **I5:** a `durable` receipt belongs to an exchange whose mode was fixed
  at its first count and whose every copy carried the envelope (section
  4).
- **I6:** every dequeued copy of a durable exchange ends in exactly one of
  the outcomes of section 2.
- **I7 (one placement):** an exchange has at most one placement, and only
  under the claim whose row is `holding`.
- **I8 (admission):** an `admitted` row's text was carried by a turn
  attempt whose result was neither an error nor a gate refusal.
- **I9 (bounds):** every KV value that intake code writes is at most
  60 KiB as stored, and the retained area has at most 8 keys.

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
4. **Fingerprints, declared for 1.0.83 only:** the activity surface gains
   `claimWorkflowIntake` and `settleWorkflowIntake`. Drain also enters its
   existing `utcNow` and timer-race branch while an `unclaimed` entry
   exists (one `utcNow`, one `scheduleTimer` raced with the dequeue,
   `queue.ts` 744-781), and retries due claims there. A turn that carried
   the handoff is followed by one `settleWorkflowIntake`. Arrival adds one
   `newGuid` and one claim per enveloped copy. A session with no intake
   item and no intake entry yields exactly as 1.0.82 does, so the command
   drive golden and the ordinary-message golden stay unchanged.
5. **Rollout:** deploy every worker, then turn on `workflowIntakeV1`.
   Workers that run 1.0.83 stay until 1.0.83 sessions drain, as for every
   earlier version; a rollback needs a separately authorized, coordinated
   plan. An older build cannot replay a 1.0.83 history and does not read
   the intake tables, so it reinterprets neither. The outbox trigger stays
   in place, with no down migration, and keeps an older worker from
   counting or sending a plain copy of a durable exchange (section 4).

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
| 13 | The sweep ends the session after a pop | The item was already in the handoff (moved in the pop's step); the session ended; the row stays `holding`; the sender's next attempt, if any, finds the session ended. |
| 14 | A FIFO, retained or handoff bucket that does not parse | The execution fails with the key's name. |
| 15 | A stale claim or settle after `admitted`, `cancelled`, `refused_full` or `refused_size` | No write (5.2). |
| 16 | `legacy_window` exchange | Today's semantics; the receipt says so. |
| 17 | An older build's count commits while the mode is unset | The row is legacy for ever; a later promotion to `durable` is refused by the trigger; its copies are plain. |
| 18 | A copied envelope for a legacy exchange | `unverified`, recorded; never handled as an ordinary prompt; plain copies keep the 20-id window. |
| 19 | The claim fails while the session is idle | The retry deadline is in drain's race; the claim is retried at its due time with the same id; a command during the wait is handled first. |
| 20 | A budget or workspace gate refuses a turn that carries the handoff | The entries stay; the gate's retry carries them; not admitted until a turn runs. |
| 21 | A credential failure, a hydration give-up or exhausted retries | The entries stay held until the session's next turn; nothing loops. |
| 22 | A repeated `accepted` for the same claim (a lost reply, a retry of an `unclaimed` entry) | No second placement (I7). |
| 23 | A refuse call finds `holding(c)` from an earlier call whose reply was lost | `accepted`; the holder has no room and settles `refused_full`. |
| 24 | A refusal after the sending workflow was deleted | The recipient's row records it; the source is not touched and gets no event. |
| 25 | A refusal and `beginDelivery` run at once | Same lock order (5.6); one waits for the other; no cycle. |
| 26 | A canonical item over 60 KiB as stored | `refused_size`, shown to a live sender; nothing goes to KV; the execution continues. |
| 27 | A malformed or oversize envelope | Refused and recorded; nothing goes to KV. |
| 28 | A turn that carried the handoff is stopped or cancelled | `admitted` with that reason; not carried again. |

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
   `attempt_token`, `intake_outcome`, `intake_outcome_at`, the trigger),
   the locked mode decision in `beginDelivery`, store claim (both modes),
   settle, the refusal transaction and canonical render; store tests.
3. Recipient intake in 1.0.83: both arrival paths, placement, the retained
   area, the wake, the handoff and the admission settle, all sites, the
   byte caps, the continue-as-new floor, parse failures, the reserved key
   at the generic ingress, fingerprints.
4. Sender: the capability, the envelope on durable rows, the receipt, the
   README.
5. Formal model `WorkflowV2Intake.tla` for an agent recipient: copies,
   claims with lost replies, the refuse rows, one placement per claim, the
   retained area, the wake as an action, the handoff and admission,
   tombstones, continue-as-new and session end; mutations for each fix.
   History and KV committing together is an assumption of the model, not
   a result. `WorkflowV2Send.tla` is not this model.

| Obligation | Test |
|---|---|
| Freeze | Literal, live latest target, imports, hashes, registry; downward continue-as-new refused in 1.0.83. |
| Claim table | Every row of 5.2, including the same claim after `admitted`, `cancelled`, `refused_full` and `refused_size` (no write), and both refuse rows. |
| Lost reply | Replay with the same guid: one item; a later `accepted` for that claim appends nothing; no second item reaches `processPrompt`. |
| N1, mixed build | An older build's count SQL on a durable row rolls back and queues nothing; a count that commits while the mode is unset stays legacy, and a later promotion to `durable` fails; one admission. |
| N1, legacy envelope | A copied `workflowIntake` for a legacy outbox row inserts no intake row and is not handled as an ordinary prompt; plain copies keep the 20-id window. |
| F2 | Queued text differs from the outbox: the admitted text is the render, also on replay; a generic event with `workflowIntake` is refused. |
| More than 20 ids | A durable copy, 21 other prompts, the same copy: suppressed. Positive control: a legacy exchange admitted twice. |
| N2, wake | Session idle, no other message, the store comes back: the same claim is retried at its due time with no sleep in the orchestration; a command dequeued during the race is handled first; the due time survives continue-as-new; a session with no entry keeps today's yields. |
| N3, gate | A budget refusal and a workspace refusal of a turn that carries a `workflowSendPrompt` text: the text reaches exactly one later turn; the `[SYSTEM:` stash exclusion does not drop it; credential failure, hydration give-up and exhausted retries keep it held; a stopped turn admits it once. |
| N4, placement | Two `accepted` results for one claim give one item; a refuse call never changes a `holding` row with a placement; a settle that finds another state fails visibly and dispatches nothing. |
| N5, lock | `beginDelivery` and a refusal on the same exchange in both orders: one waits, no deadlock; a deleted source gets no `project`, no event and no outbox annotation; the recipient's row records the refusal. |
| N6, size | An envelope over 1 KiB: malformed, nothing in KV; a rendered item over 60 KiB as stored: `refused_size`, the execution continues; packing keeps every intake key at or under 60 KiB; a retry rewrites its entry in place. |
| F7 | FIFO full: the item is held and admitted later; area full: `refused_full`, visible to a live sender. |
| F8 | Sweep arrival: no timer release, no digest, no `utcNow`; claim before cancel on both paths. |
| Cancels | Before arrival, in a pass, in the FIFO, in a merge, in the sweep, in the handoff. |
| Parse | Unparseable FIFO, retained and handoff buckets fail the execution with the key. |
| CAN | Items, retained entries, the handoff and rows survive continue-as-new; 1.0.82 inputs run on 1.0.83. |
| Fingerprints | The declared 1.0.83 delta (section 8); the drive and ordinary-message goldens are unchanged. |
| Baseline | Full suite and baseline are a separate grant. |

## 13. Remaining questions

1. The retained area's size (8 keys), the handoff cap, the 1 KiB envelope
   cap and the claim backoff are proposals.
2. A rendered message over the item cap is refused at the recipient
   (`refused_size`). The send state could refuse it at entry instead; that
   would change send admission and is not proposed here.
3. `stopped` and `cancelled` turn results admit the items they carried
   (5.5); the alternative, carrying them again, could repeat actions.
4. The session's `command.response.<id>` keys grow without a bound today
   and share the 150-key limit (5.7). That existing behavior is outside
   this design.
