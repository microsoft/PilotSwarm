# Workflow messaging: durable recipient intake (design A, revision 3, amendment 2)

> **As built (2026-11-10, owner decision: Workflow was deployed nowhere, so its versions and migrations were
> collapsed).** Each Workflow orchestration has one version: `workflow-controller` 1.0.0 is the controller this
> document calls 1.9.0 (the request controller); `workflow-effect`, `-notify` and `-send` 1.0.0 are its tagged
> 1.1.0 orchestrations; `workflow-request`, `-agent` and `-agent-session-end` stay 1.0.0. Controller 1.8.0, the pre-release
> controllers 1.0.0 to 1.7.0, the untagged orchestrations and activities, and the `workflowRequests` and
> `WorkflowHost.requests` switches are gone: every activity is `workflow.<name>` with the workflow-request tag.
> The CMS migrations this document numbers 0088 to 0111 are one migration, 0088 (`migrations/workflow-0088.ts`), which
> creates their final schema. Stored IR has one version, 1, which holds every state type; the IR versions 1 to 11
> named below, the compiler's per-feature switches and the reader's version limit are gone. Version and migration
> numbers below are the design's history.

Status: revised design checkpoint for review. Docs only; no code changes.
Revision 2 (`e287ddb3`) revised `c92d7eb1` after the Grok review
(`wfv2-intake-design-c92d7eb1-grok-review.md`, SHA-256 `e77c20b8…`) with the
parent's qualifications (`pse/wfv2/review/intake-design-c92d7eb1-grok`).
Revision 3 is a focused delta for the review of revision 2
(`wfv2-intake-design-e287ddb3-grok-review.md`, SHA-256 `8919a83f…`, findings
N1 to N6, with the parent's qualifications); F5 and F8 stay closed as
specified. The amendment corrects the three semantics that the GPT review
of revision 3 left open (`wfv2-intake-design-0110b1f7-gpt-review.md`,
SHA-256 `116a5311…`); its N1 and N2 closures stand. Amendment 2 makes the
three corrections of the parent review of the amendment
(`wfv2-intake-design-d0ce569b-parent-review.md`, SHA-256 `1af65433…`);
N1, N2, N5, F5 and F8 stay closed. Source base:
`9fcbf377`; line numbers are at that commit (the session orchestration,
client, worker and retry files are unchanged since `fa7c232f`). Dependency
facts are pinned in section 1.

A messaging `send` state queues its message for an agent session at least
once. Today the recipient drops a repeat only while the exchange's client
message id is among its 20 most recent ids. Design A gives a recipient on
session orchestration 1.0.83 a durable intake record per exchange: the
session admits each durable-mode exchange at most once, admits it from the
sender's immutable outbox row and not from the queued bytes, keeps it in a
bounded intake queue in its carried state (never in KV), binds it to one
logical turn invocation before that invocation first carries it, and
refuses it visibly when it cannot keep it. Exchanges outside durable mode
keep today's semantics.

## 0. Finding resolution

Amendment 2 (parent review of `d0ce569b`):

| Finding | Resolution | Section |
|---|---|---|
| D0-P1: `sent` must be cumulative and the outcome rules ordered | `sent` means sent or possibly sent by any attempt and never returns to false. The transition rows are ordered and exclusive: a stop or cancel precedes a completed result; a retry that stops before its send, meets a gate or cannot hydrate after an earlier send ends `interrupted`, is never reset to unsent and never moves to another turn. | 5.5, 7, 9, 12 |
| D0-P2: an unsent invocation must not loop | An unsent invocation is `ready` or `parked` with its cause. A parked one starts no turn; it rides only the next attempt that a named stimulus starts (the gate's own retry, a new message, a timer that runs a turn, a newly claimed item). The store-write wake never starts a turn or unparks. | 5.4, 5.5, 7, 9, 12 |
| D0-P3: intake keys couple with later command keys | Intake writes no KV key or value. Its queue (references and `unclaimed` retries) and its invocation are orchestration state that continue-as-new carries, within byte and count caps, with room for one full invocation always free. KV holds only what the FIFO, the meta keys and command handling write under today's rules, so intake adds no key or value to the 150-key count; nothing is dropped, cleaned up or raised. No intake item is in the FIFO, so F4's FIFO parse change is withdrawn. | 5.1, 5.4, 5.7, 6, 7 |

Amendment 2 moves every intake placement out of KV. Where a row below
says KV, a key, a bucket, the FIFO or the retained area for an intake
item, read the carried intake queue or invocation of 5.4 and 5.5.

Amendment (GPT review of `0110b1f7`):

| Finding | Resolution | Section |
|---|---|---|
| N1, N2 | Closed as design by the review; unchanged. | 4, 5.4 |
| P1 (N3, N4): bind one logical invocation, not one final row mark | Logical admission is the binding of a claim to one invocation, persisted in KV and in the store before the invocation's first dispatch; the processing outcome is a separate, later record. An invocation's batch is fixed from its first send, rides only its own turn's retries after that, and is never attached to an unrelated turn. The worker composes the batch after any stash or bootstrap replacement and returns which invocation it sent; an adopted saved result carries the witness of the attempt that ran. A known stop before the send is `not_dispatched`; an unknown interruption or an error after a possible send is indeterminate, never success and never replayed. A failed settlement is retried as a settlement only. A cancel never proves that an earlier attempt did not process an item. Moves write both keys before any yield. (Amendment 2: carried state, cumulative `sent` and parking; D0-P1 to D0-P3.) | 2, 5.1, 5.2, 5.5, 6.1, 7 |
| P2 (N5): use the existing authorized outbox view | `read_workflow` already returns the run's outbox (`tools.ts` 304-317, 354-360): the later intake outcome and its time are added to those entries; delivery state and receipt are unchanged; no new API. The recipient's projection is event-only under its SHARE lock. | 5.6 |
| P2 (N6): account for the shared 150-key limit | Intake counts the instance's keys (`ctx.getKvAllKeys()`) before creating any of its keys, never leaves fewer than 16 free, refuses the item visibly instead, and deletes each of its keys when empty. No command key is ever removed. (Amendment 2: replaced by D0-P3; intake writes no KV.) | 5.7 |

Revision 3:

| Finding | Resolution | Section |
|---|---|---|
| N1 (P1): durable mode is not a locked transition; claim does not check it | The first counted attempt decides the mode, counts and sets the token in one `UPDATE` under `beginDelivery`'s locks. A row counted while its mode was unset stays legacy for ever: the trigger refuses any later promotion, and refuses a count on a durable row that keeps its token. Claim admits only an outbox row in durable mode. A copy that carries the envelope is never handled as an ordinary prompt. New columns are nullable, so the old insert and the old count still run. No schema rollback drops the fence while a durable exchange or a 1.0.83 history can replay. | 4, 5.3 |
| N2 (P1): a retained retry has no wake | The earliest due retained retry is a third deadline in drain's existing race of `messages` against a timer; a command still wins the race and is handled first. The due time and the claim id are in KV and survive continue-as-new. No sleep, no busy loop, no need for another message. The fingerprint delta of 1.0.83 is declared, timers and `utcNow` included. | 5.4, 6.2, 8 |
| N3 (P1): `presented` before the turn can drop the only copy | `presented` is replaced by `admitted`, settled only after a turn that carried the item ran (its result is neither a gate refusal nor an error). Until then the item is in a claim-bearing handoff that every non-admitted return keeps (budget, workspace, credentials, hydration, retries) and continue-as-new carries; the `[SYSTEM:` stash exclusion does not apply to it. Retries and cancels are accounted. Frozen versions are unchanged. (Amended: the handoff and its admission rule are replaced by the logical invocation of P1.) | 5.5, 6.1 |
| N4 (P1): one claim can place two items; refuse can undo a winner | One placement per exchange and claim, across the pass, the FIFO, the retained area and the handoff: `accepted` places an item only when none exists. A `refuse` table: only a missing row becomes `refused_full`; a row under the same claim answers its state with no write; another claim is a duplicate; a holding row with a placement is never refused. A settle that changes no row dispatches nothing. (Amended: the handoff is now the invocation; P1.) | 5.2, 5.3, 7 |
| N5 (P1): the source annotation has no lock order or deleted-source rule | The refusal transaction locks both session rows in ascending id with `beginDelivery`'s modes before the outbox and intake rows. A deleted source is not touched: no annotation, no event, no `project`; the recipient's row still records the outcome. A live sender sees the refusal as an event on its session and as `intake_outcome` on its outbox row. (Amended: that row is shown by the existing `read_workflow` view; see 5.6.) `sent` stays queue acceptance; the receipt is frozen at delivery. | 5.4, 5.6 |
| N6 (P2): eight keys are not a byte cap | UTF-8 byte caps, measured on the exact stored strings: envelope, canonical item, bucket, retained area and handoff, below duroxide 0.1.32's `MAX_KV_VALUE_BYTES` with the JSON wrappers and escaping counted; shared KV use is stated. Oversize is refused before any KV write and recorded; the execution continues. A retry updates its entry in place. (Amended: the handoff key is now the invocation key, and key accounting is added; 5.7.) | 5.4, 5.7 |

Revision 2:

| Finding | Resolution | Section |
|---|---|---|
| F1 (high): mixed plain and enveloped copies bypass the claim; the recipient version does not fence the sender | Durable mode needs a deployment capability (every worker intake-capable) and the recipient's observed version (fail closed). A migration adds an outbox trigger that refuses a counted attempt on a durable-mode row unless the attempt carries a new attempt token, which only intake-capable code sets: an older worker cannot count an attempt, so it never queues a plain copy of a durable exchange. Every copy of a durable exchange is enveloped; a legacy exchange has none. Client ids are not parsed for authority, the 20-id window is not proof of anything, and no admission before the boundary is reconstructed. Revision 3 makes the mode decision one locked update and forbids promotion (N1). | 4 |
| F2 (high): the envelope does not bind the admitted message; a public write can queue arbitrary JSON | The claim returns the canonical message rendered from the immutable outbox row by the sender's own renderer, with its hash, in its history-recorded result. The session admits exactly that: the canonical text, client id, system sender, `bootstrap: false`, no required tool, no attachments. Every queued field is ignored for an intake message. `workflowIntake` becomes a reserved key that the generic event ingress refuses (defense in depth; the binding does not depend on it). Revision 3: the claim also requires durable mode (N1). | 3 |
| F3 (high): a same-claim result after release or cancel could resurrect a reservation | State-conditioned claim table, one statement each; a claim id that no longer holds its row gets that row's state, with no write; settle acts only from `holding` under its own claim. Revision 3 adds the refuse rows and one placement per claim (N4). | 5.2 |
| F4 (high): the holding invariant is false after presentation; pop, sweep, merge and FIFO parse paths | Revision 3 replaces the `presented` settle before the turn with `admitted` after a turn that ran, and a handoff that holds the item until then (N3). I2 is a holding obligation only. The pop-before-sweep window is covered. 1.0.83 fails an execution on an unparseable FIFO bucket instead of reading it as empty. Provider KV and history atomicity is an assumption, not a proof here. (Amended: the handoff is replaced by the logical invocation; P1.) | 5, 7 |
| F5 (medium): freeze literal, hash locks, imports and downward continue-as-new | Freeze rules as for 1.0.81 (literal, live latest target, historic imports, hash locks) before any new yield; a continue-as-new floor in 1.0.83 only; a monotonic-latest guard; the frozen trees are not changed. | 8 |
| F6 (medium): a missing workflow store is not a forged envelope | A claim that cannot reach the store is retried, never refused: the item waits in the retained area as `unclaimed` and the claim is tried again on a backoff, on any worker. Revision 3 adds the wake (N2). | 5.4 |
| F7 (medium): release alone gives no progress after the sender recorded its only copy | No release on a full FIFO: the canonical item waits in a bounded retained area and is moved into the FIFO as room appears. When that area is also full, the exchange is refused explicitly (`refused_full`): recorded with a critical write, shown to the sender, never reported as admitted. Revision 3 adds N4, N5 and N6. | 5.4, 5.5 |
| F8 (medium): the sweep must keep its own semantics | Drain and sweep each keep their own prompt path: the sweep releases no timer, takes no digest and adds no note. Both claim before the cancel check; a duplicate never consumes a tombstone. All four append sites and all six drop sites are covered. | 6 |
| F9 (low): critical persistence | Claim and settle are critical store writes, never `recordSessionEvent`. Their bounded in-activity retry, the retained-area fallback that keeps commands serviced, and the one fail-stop case are stated. Revision 3 adds the wake for the retry (N2). | 5.4, 9 |
| Source facts 1 to 9 of the review | Corrected in section 1. | 1 |

## 1. Source facts (corrected)

| Fact | Source |
|---|---|
| The exchange id is the node execution id (`nx-` + 40 hex); the outbox stores it once in both columns. There is no second id. | `store.ts` 641-642, 1912 (outbox insert); migration 0095 |
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
| duroxide 0.1.32's other limits are 100 carried-forward events, 256 KiB of custom status, 5 worker tags and 256-byte tag names; none bounds an orchestration's input. The session already carries its pending prompt, budget stash, steers and tool actions in its continue-as-new input, and continues as new after 10 loop iterations or at 800 KiB of history. | `src/runtime/limits.rs` 9-37; `lifecycle.ts` 592-662; `state.ts` 435-437; `orchestration/runtime.ts` 247-266 |

Dependency evidence (read as public source over HTTPS, nothing executed;
the files and a manifest with their SHA-256 are retained as artifact
`wfv2-dependency-evidence-r1.tgz`, SHA-256 `49f25ecb…`):

| Claim | Source and pin |
|---|---|
| The npm package | `package-lock.json` 7761-7773 pins `duroxide` 0.2.4; duroxide-node tag `v0.2.4` is commit `7722f193184af0f2b01095b72464607b97d92aa1`; its `Cargo.toml` (SHA-256 `ec0a6b91…`) requires `duroxide` 0.1.32 and `duroxide-pg` 0.1.38 (caret ranges; that repository has no `Cargo.lock`, so the binary's resolved versions are not proved by source; crates.io listed 0.1.32 and 0.1.38 as the latest on 2026-11-01). |
| Limits | duroxide tag `v0.1.32`, commit `585c89c86f03956f799913cf0b98186452221e75`, `src/runtime/limits.rs` (SHA-256 `318468e8…`): `MAX_CARRY_FORWARD_EVENTS` 100 (14), `MAX_CUSTOM_STATUS_BYTES` 256 KiB (25), `MAX_WORKER_TAGS` 5 (30), `MAX_TAG_NAME_BYTES` 256 (37), `MAX_KV_KEYS` 150 (43), `MAX_KV_VALUE_BYTES` 64 KiB (48); the file has no other limit. |
| KV across continue-as-new and pruning | KV survives continue-as-new: the session FIFO already relies on it, and duroxide's design text says so (`docs/proposals/orchestration-kv-store.md` at `585c89c8`, SHA-256 `0b84a787…`, 12, 391-400; design text, not a test). duroxide-pg tag `v0.1.38`, commit `54255d1664ca630fe9d3501502dfdba5dec455f9`: `migrations/0018_add_kv_store.sql` part 5 deleted KV on prune; `migrations/0019_add_kv_last_updated.sql` (SHA-256 `7075f5a3…`) part 4 removed that delete. |

## 2. Guarantee

For a durable-mode exchange (section 4) whose recipient runs 1.0.83:

- **At most one admission.** At most one copy is admitted to the session's
  work, whatever the number, order and timing of the copies, after any
  number of other messages and across continue-as-new and restarts.
  Admission is logical: the copy's claim is bound to one turn invocation
  before that invocation first carries it (5.5). One invocation may run the
  model more than once (its own retries); no other invocation carries it.
- **No silent loss.** Each copy that the session dequeues ends as exactly
  one of: admitted (bound to one invocation), with a separate, truthful
  processing outcome once that invocation ends (`completed`,
  `not_dispatched`, `interrupted` or `failed_indeterminate`, 5.5);
  cancelled by a tombstone before admission (recorded); a duplicate of a
  copy that holds or was admitted (recorded); refused as unverified,
  malformed or conflicting (recorded, never handled as an ordinary
  prompt); refused for capacity (`refused_full`) or size (`refused_size`),
  recorded and visible to a live sender (5.6); or abandoned because the
  recipient's session ended, as for any queued work.
- **Conditional progress.** While the store answers, the session runs and
  its turns are not held back (a budget or workspace gate retries on its
  own timer; a parked invocation waits for its next stimulus, 5.5), a
  claimed copy waits in the intake queue and is admitted unless it is
  cancelled, refused for capacity or the session ends.

Not given: exactly-once delivery, reading, model behavior or external
effects (an invocation's retries may run the model again); proof that a
model read an item (`completed` means a turn that sent it ended without an
error, nothing more); any guarantee for a `legacy_window` exchange (at least
once with the 20-id window, as its receipt says); any statement about
exchanges admitted before the boundary. `sent` stays queue acceptance, not
a read.

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
  `workflowSendClientMessageId(wf, run, nx)`. The claim that inserts the
  row stores that text in it (5.1), and the bind returns the stored text
  (5.5). Both results are recorded in the orchestration's history, so a
  replay admits the same bytes, and a later renderer change cannot alter
  an admitted text.
- **The admitted item** is built only from those results: the canonical text,
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
  not claim to close them. (Implementation.) The generic event ingress is
  `PilotSwarmSession.sendEvent`, which the web API's `sendSessionEvent`, the
  MCP tool and the node transport all reach; it refuses an event whose
  payload carries `workflowIntake` at its top level (`INVALID_REQUEST`, 400),
  where the session's drain would read it.

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
- (Implementation, inactive.) The deployment capability is the runtime's
  `workflowIntake` dependency, which no worker sets, so every exchange
  stays `legacy_window`. The observed version is the recipient session
  orchestration's current execution version (`getInstanceInfo`), read
  before the counting transaction; a queue that cannot tell it is never
  durable. The deliver activity always counts with the deciding statement
  (`beginDelivery` with `intake`), so a message that became durable keeps
  its new token on every later count, also after the capability is turned
  off; the store's count without `intake` is the older build's. The receipt
  field is written only on a durable delivery, which the store records only
  for a message whose count made it durable; every other receipt keeps its
  shape and reads as `legacy_window`.

## 5. Recipient (orchestration 1.0.83)

### 5.1 Records

`workflow_intake`, one row per exchange (key: the exchange id; foreign key
to the outbox): `recipient_session_id`, `workflow_session_id`, `run_id`,
`envelope_sha256`, `text`, `text_sha256`, `claim_id`, `state`,
`invocation_id`, `processing`, `cancel_requested`, counters (`duplicates`,
`conflicts`), `created_at`, `updated_at`, `admitted_at`, `settled_at`,
`reason`. `text` is the canonical text (section 3), written once by the
claim that inserts the row and never changed. States:
`holding`, `admitted`, `cancelled`, `refused_full`, `refused_size`. Every
state but `holding` is final. An `admitted` row names its invocation and
has a separate `processing` value: `bound` until its invocation ends, then
one final value of `completed`, `not_dispatched`, `interrupted` or
`failed_indeterminate` (5.5).

`workflow_intake_invocations`, one row per invocation (key: the invocation
id), written once by its first bind and never changed or deleted: its
recipient and its complete membership (each exchange with its claim, in the
bind's order). An admitted row's `invocation_id` refers to it. Every bind,
end and cancel of an invocation first takes a transaction-scoped lock on
its identity, in a transaction that states READ COMMITTED, so they
serialize, the first bind included, each reads after the lock what the
previous holder committed, and each is checked against the whole
membership (5.2).

A **placement** is where the orchestration keeps a claimed item: a `held`
entry of its intake queue (5.4) while the row is `holding`, and the
invocation (5.5) once it is `admitted`. Both are orchestration state that
continue-as-new carries, never KV, a stash, the FIFO or a merged prompt.
An exchange has at most one placement, and only under its own claim (I2,
I7).

### 5.2 Claim and settle (state-conditioned; one statement each)

Claim (`claimWorkflowIntake`, mode `accept` or `refuse`):

| Row | Caller's claim | Result | Write |
|---|---|---|---|
| none; outbox durable and matching; mode `accept`; item within the cap (5.7) | `c` | `accepted` | insert `holding(c)` with the canonical text |
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

Settle (`settleWorkflowIntake`), each one statement that returns the
rows' state after it:

| Settle | Write | Condition |
|---|---|---|
| bind (invocation `v`, claims `C`) | the first bind of `v`: its membership `C` once; then `state = 'admitted'`, `invocation_id = v`, `processing = 'bound'`, `admitted_at`; returns each row's stored `text` and `text_sha256` | first bind: each row `holding` under its claim in `C`; a later bind is the same result (a replay) only when `C` is exactly the stored membership, in its order, and every member is still `admitted` to `v` |
| cancel (claim `c`) | `state = 'cancelled'` | `holding(c)` |
| cancel (claim `c`, invocation `v` not yet sent) | `processing = 'not_dispatched'`, `reason = 'cancelled'` | `c` a member of `v`; `admitted(c)`, invocation `v`, `processing = 'bound'` |
| cancel requested (claim `c`, invocation `v` possibly sent) | `cancel_requested = true` | `c` a member of `v`; `admitted(c)`, invocation `v`; the processing value is not changed |
| end (invocation `v`, outcome `o`, its batch) | `processing = o`, `settled_at`; `cancel_requested` for each item the batch marks | the batch is every member of `v` except those cancelled while unsent, which it must not name (an empty batch when all were: nothing is written); every batch row still `bound`; a batch already at `o` is the same result when every cancel it marks was recorded |
| `refused_full`, `refused_size` (claim `c`) | in the refusal transaction (5.6) | `holding(c)` |

A settle by the holder removes or moves the placement in the same
synchronous step (no yield between). A settle that finds a row in another
state, under another claim or bound to another invocation is a broken
invariant: the execution fails with the exchange id, and nothing is
dispatched for it.

### 5.3 Arrival

For a prompt message with `workflowIntake`, in drain and in the sweep:

1. Shape and size check of the envelope (5.7). A bad shape or an envelope
   over its cap is refused and recorded; nothing is placed, and
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
   id still enters the window when the item is placed.
6. The item follows its own path's handling (section 6) and, in the same
   synchronous step, becomes a `held` entry of the intake queue (5.4):
   never a prompt item, never in a stash, the FIFO or a merged prompt.

The placement check reads the intake queue and the invocation, with no
yield, before any placement.

### 5.4 The intake queue, the wake and critical persistence

- **Intake queue:** orchestration state that continue-as-new carries,
  never KV (5.7). An entry is either `unclaimed {claimId, envelope,
  nextAttemptAt, attempts}` or `held {exchangeId, claimId, textSha256,
  clientMessageId}` (a reference; the text stays in the row, 5.1), kept in
  arrival order. An `unclaimed` entry stores the envelope only, never the
  queued prompt.
- **Claim failure (F6, F9):** the claim activity retries transient store
  errors in-activity (1 s, 5 s, 15 s). A missing workflow store or
  exhausted retries make it throw; the orchestration catches that one
  failure, keeps the message as `unclaimed` in the intake queue with its
  `claimId` and a due time (`ctx.utcNow()` plus 30 s, doubling to 15 min),
  and continues its loop (commands keep being serviced). A retry updates
  its entry in place (`attempts`, `nextAttemptAt`); it never adds one. A
  missing store is never treated as a forged envelope.
- **The wake (N2).** In 1.0.83 drain's existing timer race has a third
  deadline: the earliest due time among the `unclaimed` entries and an
  invocation waiting for its bind or its end settlement (5.5), next to the
  armed timer and the child-digest window (`queue.ts` 433-470, 744-781).
  While such a due time exists, drain does not block on the dequeue alone
  (`needsBlockingDequeue` is false), so it reads `ctx.utcNow()` and races
  `dequeueEvent("messages")` against `scheduleTimer` for the earliest
  deadline. A message that wins the race is handled as today, a command
  first. When the intake deadline wins, the armed timer stays armed (as
  when the digest window wins), and drain retries every due entry with its
  own claim id, oldest first, and a due bind or settlement as a store
  write only. The due times and claim ids are carried state, so they
  survive continue-as-new and a restart (replay rebuilds them within an
  execution). No sleep, no busy loop, and no other message is needed. The
  wake never starts a turn and never makes a parked invocation eligible
  (5.5). A session with no intake due time runs exactly today's drain.
  (Implementation clarification, review INTAKE-MACHINE-02: the due times
  also include every latched write of 5.5 "Latched cancels": a `settling`
  entry's holder settle, the latched `held` cancels (one write, one retry)
  and the invocation's cancel write, which comes before its end. A cancel
  is made with no other stimulus, as a store write only.)
  (Implementation clarification, review of b92ff04b: drain races the queue
  before every wake, for a moment at least when a write is already due,
  and one wake makes at most one intake activity call, so a queued message,
  a command first, waits for one store write at most; a holder settle that
  a claim decides is latched and made by a later wake. A thrown activity
  failure keeps only its message in history: the activity marks a failure
  no retry can fix (a programming error, or a PostgreSQL error of class 22,
  23 or 42) `WORKFLOW_INTAKE_NON_RETRYABLE` in it, and the execution fails
  visibly on that mark; any other thrown failure, an outage or a lost
  answer, is made again when due.)
- **No FIFO (F7).** An accepted item is never appended, so none of the
  four append sites (`queue.ts` 844, 1144, 1195, 1293) can lose it, and
  a full FIFO does not matter to it. It waits as a `held` entry until the
  binding (5.5) takes it, and needs no timer: `decide` forms the next
  invocation from `held` entries whenever none exists, and a ready
  invocation starts a turn when nothing else does (5.5).
- **Queue full:** an accepted item (the holder, with no placement) that
  finds every `held` entry taken (5.7) is settled `refused_full` from
  `holding` (5.6). An `unclaimed` entry whose retry finds no free `held`
  entry, and a message whose claim fails when every `unclaimed` entry is
  taken, are claimed with mode `refuse` (5.2): a new row becomes
  `refused_full`; a row the earlier call already took (`holding(c)`)
  returns `accepted`, and the holder then settles it `refused_full`
  because it has no room. If that write also cannot be made, the execution
  fails (the one fail-stop case: a persistent store outage with the queue
  full).
- Claim and settle use the critical policy, never `recordSessionEvent`.
  Diagnostic events (duplicate, conflict, malformed) may stay best-effort;
  the row's counters are written by the claim itself.

### 5.5 Admission: one logical invocation (N3, P1)

An **invocation** is the logical turn that carries a batch of admitted
intake items: one or more model attempts of one turn (its own retries,
across continue-as-new and restarts), never another turn. The session has
at most one at a time, in its orchestration state carried by
continue-as-new (5.7): `{invocationId, items, sent, parked, settle}`, where
`items` holds each item's reference, its canonical text and its cancel
flag.

- **Binding (logical admission).** Whenever no invocation exists and the
  intake queue has `held` entries, `decide` forms one from them in arrival
  order, within the caps of 5.7, before it starts its next turn attempt:
  `invocationId := yield ctx.newGuid()`; then, in one synchronous step, it
  removes the entries from the queue and records the invocation with
  `sent = false`; then one critical yield binds the claims in the store
  (5.2, `admitted`, processing `bound`) and returns their texts as the
  claims stored them (5.1), each with its hash; a hash that differs from
  the entry's `textSha256` is a broken invariant (the execution fails).
  That binding is the admission, before the invocation's first dispatch.
  The carried state always keeps room for one full invocation, its
  metadata included (5.7), so forming one never fails or waits for room,
  and a later cancel, park or settlement writes only fields inside that
  room. A crash replays the same yields. A bind that cannot be made (a
  store outage) keeps the invocation unsent with a due time on the N2
  wake (5.4); it is not dispatched until bound. New intake items never
  join an existing invocation; they form the next one after it ends.
- **Dispatch.** A turn attempt carries an invocation in a field of its own
  (`intake: {invocationId, items}`), never inside the prompt: not the
  merged prompt, the budget stash, a retry's carried prompt or a pending
  prompt. So the `[SYSTEM:` exclusion of `stashBudgetRefusedPrompt`
  (`turn.ts` 1020) never meets it, and a retry keeps its ordinary prompt
  as today (`turn.ts` 638-647). The worker composes the item texts with the
  model prompt after the stash and bootstrap replacement
  (`session-proxy.ts` 2107-2120), so that replacement cannot drop them, and
  returns `intakeDispatch: {invocationId, sent}`, `sent` true once the model
  request that includes them was issued. The witness is part of the turn
  result the worker commits, so a saved result that a retry adopts
  (`session-proxy.ts` 1766-1787) returns the witness of the attempt that
  ran.
- **`sent` is cumulative.** It becomes true when an attempt that carried
  the invocation returns a witness `sent: true`, returns no witness, or
  throws, and it never becomes false again. It is false only while every
  attempt that carried the invocation returned `sent: false`. A returned
  result whose witness names another invocation is a broken invariant: the
  execution fails, and nothing is settled.
  (Implementation clarification, review W2-WIT4.) Two executions of one
  turn can race to save it (a work item run again after a lost lock). The
  one that loses the commit returns the winner's result and the winner's
  witness, never its own. When it had sent the items itself and the
  winner's witness names the same invocation with `sent: false`, it adds
  `exposed: true` to that witness: the items were possibly seen, though not
  by the run whose result this is. `exposed` makes `sent` true as a possible
  send does, and it never counts as this result's send, so row 8 never
  applies to it. Any other adopted witness (none, `sent: true`, another
  invocation's, malformed) is returned as it was saved.
- **Who carries it.** A sent invocation rides only its own turn's retries
  (the retry's continue-as-new carry names it), with the same batch. An
  unsent one is `ready` (formed and bound, no attempt has carried it yet)
  or `parked` with its cause. A ready one rides the session's next turn
  attempt, whatever started it; when nothing else is queued, `decide`
  starts one turn for it alone, with the session's internal system-turn
  prompt. A parked one never starts a turn: it rides only the next attempt
  that one of its resume stimuli starts (below). The N2 wake retries binds
  and settlements as store writes only; it never starts a turn and never
  unparks.
- **Batch.** The items are fixed when the invocation is formed. Before it
  is sent, a tombstone may remove an item (below); nothing is ever added.
  From the first send the batch is immutable.
- **Transitions.** When an attempt that carried the invocation returns, or
  its turn ends without one, `sent` is first updated from that attempt;
  then the first matching row applies:

  | # | Event | `sent` | Next | Outcome |
  |---|---|---|---|---|
  | 1 | `stopped` or `cancelled` result (`session-proxy.ts` 4307-4318, 1674-1708, 4716; `managed-session.ts` 1502-1535, 3945-3951) | false | ends | `not_dispatched` |
  | 2 | the same | true | ends | `interrupted` |
  | 3 | gate refusal, budget or workspace (`turn.ts` 729-735, 1184, 1413) | false | parked: gate | — |
  | 4 | the same | true | ends | `interrupted` |
  | 5 | thrown or `error` result, and the turn retries (`turn.ts` 304-347) | either | stays with that turn's retry | — |
  | 6 | retries exhausted, credential failure, non-retryable error (`turn.ts` 310-332, 628-633, 1609-1618) | false | parked: that cause | — |
  | 7 | the same | true | ends | `failed_indeterminate` |
  | 8 | any other result, this attempt's witness `sent: true` | true | ends | `completed` |
  | 9 | any other result otherwise | true | ends | `interrupted` |
  | 10 | the same | false | parked: not sent | — |
  | 11 | hydration give-up before an attempt that would carry it (`turn.ts` 470-490) | false | parked: hydration | — |
  | 12 | the same | true | ends | `interrupted` |
  | 13 | the session ends (cancel, delete, done) | either | ends with the session | rows stay `admitted`, processing `bound` (section 2) |

  So an invocation that one attempt sent and whose retry then stops before
  its send, is refused by a gate or cannot hydrate ends `interrupted`
  (rows 2, 4, 12); it is never reset to unsent and never moves to another
  turn. `completed` means only that a turn which sent the items ended
  without an error; it is not proof that a model read them. On an end, one
  critical yield settles every row of the batch with the outcome (5.2,
  end), then the invocation is cleared in the same synchronous step; other
  intake items are not touched.
- **Resume stimuli of a parked invocation:**

  | Cause | Resumes on |
  |---|---|
  | gate (budget or workspace) | any otherwise eligible turn attempt, whatever started it: the gate's own retry (budget: `turn.ts` 1663-1665; workspace: `lifecycle.ts` 951, 1132), or a turn whose message, command, digest or queued work ended the gate's wait. That attempt checks every applicable gate again before any model send; a refusal leaves the invocation unsent and parks it again. It never starts a turn of its own (I11). (Decision A1, `gate-resume-clarification`, accepted 2026-11-02.) |
  | credential, non-retryable, exhausted, not sent, hydration | the next turn that a new stimulus starts: a message admitted from a person or a session (a prompt, an answer, a child update), a timer that runs a turn (cron, cron_at, wait), or a newly claimed intake item (one attempt per arrival) |

  The attempt it rides applies the table again. A lasting failure therefore
  repeats only once per new stimulus, never on its own. A sent invocation
  still rides only its own turn's retries, and an unsent invocation with a
  latched cancel rides no attempt, whatever its park.
- **Resume stimuli and the retry marker (decision A1 and implementation
  clarifications, inactive wiring).** The gate row above replaces the first
  rule, under which a gate park resumed only on the gate's own retry timer.
  A gate refusal does not keep its wait: a budget pause is never re-armed
  after a turn that passes the gate, and a workspace wait ends at a person's
  message (`queue.ts`, its own turn is the next attempt), a
  `retry_workspace` or `set_workspace` command, or its timer. So under the
  first rule another attempt that ended the gate's wait stranded the parked
  invocation, with no retry left to resume it; the formal runs of both rules
  are kept as provenance (`gate-a1-first-r1`). Every attempt is checked by
  the gates again, as the gates' held prompts ride every attempt, so the
  gate checks stay the enforcement and are never bypassed. The stimuli are
  set where each turn starts: an answer, a queued prompt and a child digest
  are `message`; a wait, cron or cron_at timer is `timer`; the budget and
  workspace wakes are `gate_retry`; decide's own turn is `intake_turn` or
  `intake_arrival`; the pending prompt (an agent's follow-up, a machine
  continuation or a retry) is `other`, so a failure that a parked invocation
  causes is not repeated on the agent's own follow-ups. A sent invocation's
  retry is a marker recorded with the pending prompt, carried by every
  continue-as-new with that prompt and taken only by decide's dispatch of it
  (review D-W2-1); a turn that runs while that prompt is held (for example
  while an agent wait holds it) starts new and never carries the sent
  invocation (I8). Only another turn's retry replaces a held pending prompt
  (its continue-as-new carries its own prompt instead); that retry then never
  runs, and the invocation ends `interrupted`, recorded. While the retry is
  held, another turn also neither reuses nor clears the held retry's turn key
  (1.0.81's thrown-turn key), so it never adopts the held retry's saved
  result. (Review W2-WIT3.) An attempt that sends the key of the thrown
  attempt it retries may adopt that attempt's saved result, whose witness
  tells only of what that attempt carried. Such an attempt therefore
  carries only that: the invocation its marker names, or nothing when there
  is no marker. No invocation is formed for it, and decide starts no turn
  for the intake alone while such a retry is pending; the next attempt
  clears the thrown key, and the intake then forms and is carried as usual.
  (Review O-W2-3.) The held retry keeps its own retry count and thrown-turn
  key: its continue-as-new carries them with the marker
  (`intakeRetryAttempt`), every later continue-as-new keeps them, and the
  dispatch that takes the marker restores them. So a turn that runs while
  the retry is held, and whose success resets the session's retry count, or
  an ordinary continue-as-new, which carries none, never makes the retry run
  fresh: it sends its thrown attempt's key again and adopts that attempt's
  saved result instead of running the model a second time. (Review O-W2-5.)
  A newly claimed item that no attempt carrying the invocation has answered
  yet is a flag that every continue-as-new carries
  (`intakeArrivalPending`), so a continue-as-new between the arrival and its
  turn does not drop the one turn it starts for a parked invocation.
- **Ordinary retry ownership (1.0.83; review Q-W2-7, decision
  `ordinary-retry-ownership-83`).** This replaces the held-prompt wiring of
  the bullet above. A failed turn's retry is owed apart from the pending
  prompt (`ownedRetry`): the turn's exact prompt contract (its prompt,
  bootstrap flag, required tool, cron origin, client message ids, sender and
  attachments), its retry count, its thrown attempt's key, and `fresh` for
  a lossy handoff's retry, which has count 0 and no key and so never adopts
  a saved turn. Every continue-as-new carries it, a forced one included
  (the iteration cap, the history-size cap, a `set_model`); the pending
  prompt and its fields stay the follow-ups'. `decide` dispatches it before
  any other turn: an agent wait does not hold it (drain keeps the wait and
  queues its poll after it), a graceful shutdown does, and while it is owed
  drain sweeps the queue once without waiting for an armed timer. Only that
  dispatch takes its count, its key and the retry marker
  (`intakeRetryAttempt` is gone); a second owed retry is a broken invariant
  that fails the execution, so a retry is never replaced. The dispatch that
  sends its thrown attempt's key may adopt that attempt's saved turn, so it
  carries only what that attempt carried: its prompt, which holds that
  attempt's own notes, and its marker's invocation. A note queued after that
  attempt (a pending system note such as the shared-session preamble, or a
  `set_model`'s runtime model notice) stays for the next turn that runs and
  is never lost to an adopted result. The workspace notes are outside this
  rule: every attempt sends them, and the first result past the workspace
  check clears them, adopted or not, as since 1.0.81.
- **Settlement.** The end is a settlement, never a new attempt. If the end
  settle fails after its retries, the invocation keeps `settle: {outcome}`
  and a due time on the N2 wake (5.4), and the settlement is retried as a
  settlement until it succeeds; no turn carries an invocation that is
  waiting to be settled, and no model runs for it.
- **Cancels.** A tombstone for an item's canonical client id: while the
  invocation is unsent, the item is removed from the batch and settled
  `not_dispatched` (reason `cancelled`), in one synchronous step with the
  invocation's rewrite; once it was sent, the tombstone is recorded
  (`cancel_requested`) and changes nothing else, because a later cancel
  does not prove that an earlier attempt did not process the item. A
  tombstone for a `held` item settles it `cancelled` and removes its
  entry, at the latest when `decide` would bind it (6.1).
- **Latched cancels (implementation clarification, review
  INTAKE-MACHINE-01 to 03).** The first time a tombstone names a copy, the
  decision is written into the carried state before any store write:
  an `unclaimed` entry's cancel flag (its canonical id is known from the
  envelope), a `held` entry's cancel, an invocation item's
  `cancel_requested` with the invocation's cancel write, or, for a claimed
  copy that is not placed (cancelled, `refused_full`, `refused_size`), a
  `settling` entry. The decision is never taken again from tombstones: it
  stands when the tombstone is consumed or evicted, across continue-as-new,
  a failed write and a lost answer, and holds for every copy of the same
  message in the state: its exchange and its canonical client id together.
  A waiting copy's envelope is not verified until its claim is answered,
  so an exchange alone never carries a latch from one copy to another.
  A latched `held` entry is never bound; an unsent
  invocation with a latched item is never carried and starts no turn until
  its cancel write removes the item; before the bind the cancel waits for
  it. A sent item's cancel is recorded (`cancel_requested`) before any end
  names it, also while the end is pending; the end's outcome and
  membership do not change. An unsent invocation that is ending was never
  dispatched, and a tombstone changes nothing on it. Every latched write is
  a store write on the wake (5.4), retried with backoff until it is made.
  A latched `held` entry keeps only its cancel flag; the latched `held`
  cancels are one write with one retry, kept beside the queue.
- **Frozen versions** are unchanged; 1.0.82 and earlier keep their dispatch
  and stash behavior. 1.0.83's turns run under new activity names and a
  capability tag (section 8), because an older worker would ignore the
  `intake` field.
- **Possible exposure** (exposure protocol revision 2; decision
  intake-exposure-r2-implementation; migration 0099). The installed native
  runtime gives an activity no delivery count, so a crash after a request
  included the items and before its result was accepted would otherwise
  leave no durable trace. Before any request may include an invocation's
  items, the store admits it (`exposeWorkflowIntake`), in one READ
  COMMITTED transaction under the invocation's lock and its member rows,
  with no outbox or session lock:
  - The turn field carries the batch with each item's claim, one attempt
    id recorded by the orchestration for that carrying activity (the same
    on every delivery of it and in every recovery re-run; another for any
    other activity), and `sentBefore`, true only when the attempt takes the
    invocation's own retry marker. The worker hashes the exact text it
    would send; the store compares it with the stored canonical hash.
  - Members cancelled unsent are set aside first; a payload naming one, or
    an ended invocation, is refused `settled` and never shrunk. The named
    items must be exactly the remaining members, in member order, under
    their claims; anything else is a broken invariant.
  - The first admission inserts the invocation's one exposure record
    (`workflow_intake_exposures`, insert-only). The same attempt again and
    the invocation's own retry are allowed (duplicate requests are
    possible: at least once, never exactly once); any other attempt is
    refused `exposed`.
  - ManagedSession awaits the admission against the run's guards and its
    Stop, abort or forced settle, and checks again immediately before the
    send; a run that ends first sends nothing, even when the admission
    commits later. Admitted, it includes the items and only then says
    `sent`; refused, it sends its prompt without them, and the witness says
    `refused`. A transient failure is asked again in place with the same
    request; with no positive answer, nothing is sent.
  - The orchestration ends an invocation refused `exposed` (interrupted, or
    failed_indeterminate after a failure), never parked or retried; a
    `settled` refusal of the attempt that carries a bound invocation not
    ended is a broken invariant. Under the same lock, an end asked as
    `not_dispatched` beside an exposure record is applied `interrupted`
    (answered with that `outcome`, the only change accepted, after the call
    is checked), and an unsent cancel beside one records `cancel_requested`
    and answers `exposed` (an item cancelled before the exposure stays
    settled): the invocation is then possibly sent and ends interrupted.
    The record is a possible exposure only: it never makes a run's own
    `sent`, nor `completed`.

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
  one event on the sending workflow session (its row is held FOR NO KEY
  UPDATE, so that projection may also touch it). With the source deleted
  or missing, it writes neither and calls no `project` on it: no session
  touch, no event and nothing brought back. The recipient's intake row and
  its recipient-side event are written in both cases.
- The recipient's projection is events only (`cms_record_events` inserts
  event rows, `cms-migrations.ts` 3296-3309), never an `update` or a touch
  of its session row, which this transaction holds only FOR SHARE. If an
  implementation ever needs to write the recipient's row there, it takes
  that row FOR NO KEY UPDATE from the start instead of upgrading a SHARE
  lock that another refusal may also hold.
- What the sender can see: the event on the sending workflow session,
  through the existing session-event reads; and the outcome in the
  existing parent-authorized `read_workflow` view, whose run carries its
  bounded outbox (`tools.ts` 304-317, 354-360): each entry gains
  `intakeOutcome` and `intakeOutcomeAt` when they are set. No new API.
  The entry's `state`, `attempts`, `deliveredAt` and the receipt stay as
  the delivery recorded them; `delivered` still means queue acceptance
  (`tools.ts` 68-76), and a later intake outcome never rewrites it. A
  deleted source gets nothing, and its readers see the refusal nowhere.

### 5.7 Byte caps; intake writes no KV (N6, D0-P3)

Intake writes no KV key and no KV value. Its queue (5.4) and its
invocation (5.5) are orchestration state: replay rebuilds them within an
execution, and continue-as-new carries them in its input, as the session
already carries its pending prompt, budget stash and steers (section 1).
No duroxide limit applies to that input; the caps below keep it small next
to the session's own 800 KiB history check. Every cap is in UTF-8 bytes of
the exact canonical JSON kept, escaping included.

| What | Cap | Where checked | Over the cap |
|---|---|---|---|
| The queued envelope (the `workflowIntake` object, fixed fields) | 1 KiB | arrival step 1, before anything is kept | malformed, refused and recorded |
| One canonical item text, as the claim stores it (5.1) | 60 KiB, today's FIFO item bound (`MAX_FIFO_ITEM_BYTES`, `state.ts` 432) | the claim, in the store, on the exact rendered text | `refused_size` (5.6) |
| An `unclaimed` entry | 2 KiB; at most 8 entries | arrival, before the entry is kept | an envelope over its cap is malformed; with no free entry, a claim in mode `refuse` (5.4) |
| A `settling` entry (implementation clarification) | 2 KiB; shares the 8 entries with `unclaimed` | the holder, before its write | with no free entry the decision is not latched and a failed write stops the execution (the fail-stop case of 5.4) |
| A `held` entry (a reference) | 512 B as placed, its cancel flag unset (set, it is a byte shorter); at most 64 entries | the holder, before placing, and restore, by the same measure | no free entry: `refused_full` (5.4, 5.6); over its bytes: `refused_size` |
| The invocation's items (each a reference, its text and its cancel flag) | 61 KiB together, so one item of the largest size always fits | forming it | the next `held` entry waits for the next invocation |
| The invocation's other fields (id, `sent`, the parked cause, a pending settlement, a pending cancel write) | 1 KiB | forming it | not reachable: the fields have fixed shapes |

So the carried intake state is at most 16 KiB of `unclaimed` entries,
32 KiB of `held` entries and 62 KiB of invocation, 110 KiB in all, besides
under 256 B of fixed fields around them (the format version, the list
punctuation and the latched `held` cancels' one retry). Room for
one full invocation is part of that bound: forming one never fails or waits
for room, and a later cancel, park or settlement changes only fields
inside it. The rendered text can be several times its 16 KiB payload
(`promptSafeJson` escapes brackets); that is why the cap is on the stored
text.

**The shared key limit.** duroxide 0.1.32 fails an orchestration turn
after which its instance has more than 150 user keys; it counts every key
of the snapshot with the turn's sets and clears
(`src/runtime/dispatchers/orchestration.rs` 170-188 at `585c89c8`). KV
holds only what today's code writes: the FIFO's buckets for ordinary
items, `meta.responseVersion`, `meta.commandVersion`, `response.latest`
and one `command.response.<id>` per handled command, never cleared
(`lifecycle.ts` 132-140). No intake entry, invocation or item is ever
among them, so intake adds no key and no value to the count: in the
review's case (133 keys, an intake item held, then 17 new commands) the
session has 150 keys and stays valid, as it does without the item.
Command handling is unchanged; no key, claim or command response is
dropped, compacted or cleaned up, and the runtime cap is not raised. A
session whose command keys keep growing reaches that limit as it does
today; that growth is outside this design (section 13).

## 6. Paths

### 6.1 Sites

| Site | Today | Intake addition |
|---|---|---|
| `drain-incoming`, `predispatch-incoming` (`queue.ts` 936, 1261) | cancel check consumes the tombstone | claim first (5.3); cancel only an accepted claim, then settle `cancelled` |
| `drain-stash`, `predispatch-stash` (831, 1183) | tombstone drops a stashed prompt | none: an intake item is never stashed |
| `decide-fifo`, `decide-merge` (1443, 1365) | tombstone drops a queued prompt | none: an intake item is never in the FIFO |
| Append at a command, at the end of drain, at a command in the sweep, at the end of the sweep (844, 1144, 1195, 1293) | lost items reported | none: an intake item is never appended (5.4) |
| Dispatch (1431-1501) and `decide` with nothing queued | pop, sweep, cancel check, merge, turn | after any merge and before the turn: one critical yield settles `cancelled` every `held` entry whose canonical id is cancelled; then the binding (5.5) moves `held` entries into a new invocation in one synchronous step of orchestration state, before its yields; the merge's yields (`queue.ts` 1354-1378) and the command paths' (813-852, 1172-1201) never fall inside that step; with nothing else queued, a ready invocation starts a turn of its own; every attempt carries the invocation it may carry; its end is settled after the turn (5.5) |
| The intake queue and the invocation (new) | — | a tombstone settles a `held` item `cancelled`, removes an unsent invocation's item (`not_dispatched`) or only records `cancel_requested` on a sent one (5.5) |

### 6.2 Drain and sweep keep their semantics (F8)

- **Drain:** an intake item takes the drain path for queued work: timer
  release, the timer note, the child digest, give-back of carried work
  when the item is cancelled or refused, and `settleQueuedWorkAfterDecide`
  when no turn starts. Drain adds no text to an intake item: a timer note
  that it would append to a prompt's text (`queue.ts` 1007-1051) and the
  buffered child digest go to the system context of the turn that carries
  the item. A queued prompt's turn takes them as drain gives them to any
  prompt; decide's turn for the intake alone takes the released timer's
  note and the digest in its own system context (implementation
  clarification below). The canonical text, its hash and its stored size
  never change.
- **Sweep:** an intake item takes the sweep path: no timer release, no
  note, no digest take, no new `utcNow` yields.
- **The wake** (5.4) is in drain only. The sweep adds no timer and no
  `utcNow`.
- Both claim before the cancel check; a `duplicate`, `conflict` or
  `unverified` result never calls `dropCancelledPrompt`.
- (Implementation clarification, inactive wiring.) A successful claim
  and the sweep read no clock; a store write that fails reads it once, to
  set its retry, wherever it was made (drain, the sweep or the wake). An
  intake tombstone is latched (5.5) and not consumed: once latched it
  decides nothing more, and it leaves the bounded cancel set by eviction.
  A cancel message is latched first, from its own ids, before they join
  the bounded cancel set or a stashed prompt with the same id consumes
  them (review of b92ff04b).
  Every recorded claim answer and every cancel the intake makes is one
  best-effort diagnostic event (`session.workflow_intake_recorded`); the
  refusals' own events are the store's (5.6).
- (Implementation, inactive wiring.) A turn that decide starts for an
  invocation alone releases an armed timer as queued work does
  (`shouldRunQueuedWorkNow`); decide starts it only once no timer is armed,
  so it never runs beside a live one. Its prompt is the session's internal
  system-turn prompt with the released timer's note and the buffered child
  digest in the turn's system context, as drain gives them to a newly
  arrived prompt; the released wait or cron resumes after the turn. The
  worker records each carried item in the transcript at turn start, before
  the turn's own prompt, with its canonical text, its canonical client id
  and the system sender `workflow message`, as its plain copy would be
  recorded; turn start records an item once, on the first attempt that
  reaches it.

### 6.3 Parsing

Intake state is never read from KV. In 1.0.83 a carried intake state (the
intake fields of the continue-as-new input) that does not validate fails
the execution with the field's name; it is never read as empty. FIFO
bucket parsing is unchanged, because no intake item is in the FIFO, and
the frozen 1.0.82 code is not changed.

## 7. Linearization and invariants

These are separate commits, not one transaction:

| Point | Commit |
|---|---|
| L1 | the sender's counting transaction, which fixes the mode (section 4) |
| L2 | the sender's enqueue on `messages` |
| L3 | the claim's store transaction (`holding(c)`) |
| L4 | the orchestration's history commit of the turn that handled the claim's result: the item is a `held` entry (carried state) |
| L5 | the history commit of the turn that formed the invocation (carried state), then the bind's store transaction (`admitted`, processing `bound`): the logical admission |
| L6 | each attempt's result in history, with its dispatch witness |
| L7 | the end settlement's store transaction (the processing outcome), then the history commit that clears the invocation |

Recovery between them is by replay: the dequeue, the claim id, the
invocation id and each activity's result are in history; a lost reply
re-runs the claim, the bind or the settlement with the same ids (5.2). A
move between the intake queue and the invocation is one synchronous step
of orchestration state, with no yield between, so it is in one history
commit; replay rebuilds it and continue-as-new carries its result. Intake
writes no KV, so it does not depend on the provider committing KV and
history together.

- **I1:** at most one claim per exchange is ever `admitted`, it is bound to
  one invocation, and a row's final state and final processing value never
  change.
- **I2 (holding):** for `holding(c)`, claim `c` is in exactly one of: the
  current pass's claim call, an `unclaimed` entry, or a `held` entry, all
  rebuilt by replay and carried by continue-as-new; or the recipient's
  orchestration has ended. For `admitted(c)` with processing `bound`, the
  item is in the invocation its row names, or the orchestration has ended.
- **I3:** only the holder of `c` settles, and only from `holding`; only the
  invocation `v` ends rows bound to `v`, and only from `bound`.
- **I4:** a row exists only for an exchange whose outbox row is in durable
  mode and names this recipient, workflow, run, contract and payload hash;
  the admitted text is the canonical render whose hash the row records.
- **I5:** a `durable` receipt belongs to an exchange whose mode was fixed
  at its first count and whose every copy carried the envelope (section
  4).
- **I6:** every dequeued copy of a durable exchange ends in exactly one of
  the outcomes of section 2.
- **I7 (one placement):** an exchange has at most one placement, and only
  under its own claim.
- **I8 (one invocation):** the attempts that carry an invocation's items
  are its unsent attempts (whose witnesses say they did not send it) and
  then the attempts of the one turn whose attempt first sent it, possibly
  sent it or threw; no other attempt carries them, and its batch never
  grows and does not change after its first send.
- **I9 (truthful outcome):** `sent` never returns to false; `completed`
  only after a non-error result whose witness says the invocation was
  sent; `not_dispatched` only when every attempt that carried it returned
  `sent: false`; any other end of a sent or possibly sent invocation is
  `interrupted` or `failed_indeterminate`.
- **I10 (bounds):** intake writes no KV key or value; its carried state
  stays within the caps of 5.7 (8 `unclaimed` and 64 `held` entries and one
  invocation, 110 KiB in all), with room for one full invocation always
  free.
- **I11 (no self-loop):** a parked invocation starts no turn; only an
  attempt that one of its resume stimuli (5.5) starts carries it, and the
  wake writes only to the store.

## 8. Versions (F5)

1. **Freeze first.** Copy `orchestration/` to `orchestration_1_0_82/` with:
   `CURRENT_ORCHESTRATION_VERSION = "1.0.82"` as a literal; the index still
   passing the live `DURABLE_SESSION_LATEST_VERSION` as `latestVersion`;
   imports only of `types`, `session-proxy` and `orchestration-version`,
   never of the live `orchestration/` files; registry entry; a freeze test
   copied from 1.0.81's with file hashes. No intake yield exists before
   this commit.
2. **1.0.83 only:** the intake code, its carried state in the
   continue-as-new input and a continue-as-new floor:
   `versionedContinueAsNew` in 1.0.83
   never targets a version older than its own; if the live latest is
   older, it fails the execution with that reason instead of moving down.
   A unit test keeps `DURABLE_SESSION_LATEST_VERSION` at or above every
   registered version.
3. **Frozen trees are not changed.** 1.0.82 and earlier keep their
   schedules and their upward continue-as-new.
4. **Fingerprints, declared for 1.0.83 only:** the activity surface gains
   `claimWorkflowIntake` and `settleWorkflowIntake`. Drain also enters its
   existing `utcNow` and timer-race branch while an intake due time exists
   (one `utcNow`, one `scheduleTimer` raced with the dequeue, `queue.ts`
   744-781), and retries due claims, binds and settlements there. Forming
   an invocation adds one `newGuid` and one bind; cancelling `held` entries
   before it adds one settlement; its end adds one settlement. Arrival adds
   one `newGuid` and one claim per enveloped copy.
   1.0.83 schedules its turn activities under new names (`runTurnV5`,
   `runTurnEpochV5`) whose input may carry `intake` and whose result
   carries `intakeDispatch`, with the request design's capability tag
   (`pilotswarm.workflow-request.v1`, `workflow-messaging-request.md` 8.2):
   an older worker would ignore the field and drop the items. A session
   with no intake item and no intake entry yields exactly as 1.0.82 does,
   except for those turn activity names, so the command drive golden and
   the ordinary-message golden change only by those names.
5. **Rollout:** deploy every worker, then turn on `workflowIntakeV1`.
   Workers that run 1.0.83 stay until 1.0.83 sessions drain, as for every
   earlier version; a rollback needs a separately authorized, coordinated
   plan. An older build cannot replay a 1.0.83 history and does not read
   the intake tables, so it reinterprets neither. The outbox trigger stays
   in place, with no down migration, and keeps an older worker from
   counting or sending a plain copy of a durable exchange (section 4).
   Activation also needs the orchestration-consumer gate of the request
   design (8.4): activity tags do not route orchestration items, so new
   starts and upward continue-as-new to 1.0.83 are not exposed to a shared
   queue with workers that cannot run 1.0.83. Old sessions keep replaying
   on new workers with their frozen handlers.

## 9. Failure matrix

| # | Failure | Result |
|---|---|---|
| 1 | Crash before the claim | Replay claims the same copy with the same id. |
| 2 | Claim committed, reply lost | The same id gets `accepted` again; one item. |
| 3 | Crash after the claim's reply, before its turn's history commit | Replay rebuilds the item from history. |
| 4 | A later copy after more than 20 other messages, after continue-as-new, after a restart | `duplicate`; not admitted. |
| 5 | Two copies in one pass | The second is a `duplicate`. |
| 6 | An older worker attempts a durable exchange | The outbox trigger refuses its counted attempt; no plain copy is queued. |
| 7 | A `sendSessionEvent` object with a forged or copied envelope | The ingress refuses `workflowIntake`; behind it, the claim verifies the outbox and admits only the canonical render. A copy of a real envelope can at most claim the exchange with the real message. |
| 8 | Store missing on the claiming worker, or a store outage | `unclaimed` in the intake queue; retried with the same id; commands keep running. |
| 9 | FIFO full | No effect on an intake item: it is never in the FIFO; it waits as a `held` entry. |
| 10 | Intake queue full (64 `held` entries) | `refused_full`, recorded and shown to a live sender. |
| 11 | Store outage while every `unclaimed` entry is taken | The execution fails (the one fail-stop case). |
| 12 | Tombstone before the copy, in a pass, for a `held` item, in the sweep | Claim, then drop and settle `cancelled`; later copies are duplicates; no duplicate consumes a tombstone. |
| 13 | The sweep ends the session after a pop | The session ended; a `held` item stays `holding`, one in an invocation stays `admitted` with processing `bound`; the sender's next attempt, if any, finds the session ended. |
| 14 | Carried intake state that does not validate | The execution fails with the field's name; FIFO parsing is unchanged. |
| 15 | A stale claim or settle after `admitted`, `cancelled`, `refused_full` or `refused_size`, or an end settle for another invocation | No write (5.2); a wrong-state settle fails visibly and dispatches nothing. |
| 16 | `legacy_window` exchange | Today's semantics; the receipt says so. |
| 17 | An older build's count commits while the mode is unset | The row is legacy for ever; a later promotion to `durable` is refused by the trigger; its copies are plain. |
| 18 | A copied envelope for a legacy exchange | `unverified`, recorded; never handled as an ordinary prompt; plain copies keep the 20-id window. |
| 19 | The claim, a bind or a settlement fails while the session is idle | The retry deadline is in drain's race; it is retried at its due time with the same ids, as a store write only; a command during the wait is handled first. |
| 20 | A budget or workspace gate refuses the attempt that carries an unsent invocation | Parked (gate): the gate's own retry attempt carries it under the same binding. After an earlier send: `interrupted`. |
| 21 | A hydration give-up, a credential failure, a non-retryable error or exhausted retries before any attempt sent the invocation | Parked with that cause: it starts no turn and rides only the next attempt that a new stimulus starts (5.5), once per stimulus. After an earlier send: `interrupted` (hydration) or `failed_indeterminate`. |
| 22 | A repeated `accepted` for the same claim (a lost reply, a retry of an `unclaimed` entry) | No second placement (I7). |
| 23 | A refuse call finds `holding(c)` from an earlier call whose reply was lost | `accepted`; the holder has no room and settles `refused_full`. |
| 24 | A refusal after the sending workflow was deleted | The recipient's row records it; the source is not touched and gets no event. |
| 25 | A refusal and `beginDelivery` run at once | Same lock order (5.6); one waits for the other; no cycle. |
| 26 | A canonical item over 60 KiB as stored | `refused_size`, shown to a live sender; nothing is placed; the execution continues. |
| 27 | A malformed or oversize envelope | Refused and recorded; nothing is placed. |
| 28 | A turn that sent the invocation returns an error, or throws, with retries left | Only that turn's retry carries it, with the same batch; no other turn does. |
| 29 | The same turn exhausts its retries, or fails for credentials or a non-retryable error | The invocation ends `failed_indeterminate`; it is never carried again. |
| 30 | A Stop before the send (witness `sent: false`), with no earlier attempt that sent it | `not_dispatched`; not carried again. |
| 31 | A Stop or a cancel after the send, or with no witness | `interrupted`; not carried again. |
| 32 | A retry adopts the saved result of the attempt that threw | The saved witness names the same invocation and decides as above; items formed later are never in it. |
| 33 | The end settlement fails | Retried as a settlement on the wake; no new model attempt. |
| 34 | A tombstone for an item of an unsent invocation, or of a sent one | Unsent: removed from the batch, `not_dispatched`. Sent: `cancel_requested` only; the invocation's outcome stands. |
| 35 | A session at 133 keys (for example 20 FIFO, 3 counters and 110 command responses) holds an intake item while 17 new commands arrive | 150 keys, valid, as without the item: intake adds no key. An 18th command reaches 151 and fails the session, as it does today without intake. |
| 36 | An attempt sends the invocation and throws or returns an error; its retry stops before its send (witness `sent: false`) | `interrupted` (`sent` stays true); never `not_dispatched` and never carried by another turn. |
| 37 | Only a parked invocation is pending and no stimulus arrives | No turn starts; the wake retries only due store writes. |

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
3. Recipient intake in 1.0.83: both arrival paths, the intake queue and
   its carried state, the wake, the invocation (binding, cumulative
   witness, parking and resume stimuli, end and settlement), the
   `runTurnV5` activities with the composed batch and the witness, all
   sites, the byte caps, the continue-as-new floor, carried-state
   validation, the reserved key at the generic ingress, the
   `read_workflow` outbox fields, fingerprints.
4. Sender: the capability, the envelope on durable rows, the receipt, the
   README.
5. Formal model `WorkflowIntake.tla` for an agent recipient: copies,
   claims with lost replies, the refuse rows, one placement per claim, the
   intake queue, the wake as an action, logical invocations (binding,
   unsent and sent attempts with cumulative `sent`, error after a possible
   send, a retry that stops before its send, adoption of a saved result, a
   Stop before the model, an unknown interruption, parking and its
   stimuli, settlement failure), tombstones, continue-as-new and session
   end; mutations for each fix. It counts invocation bindings, not only
   final row updates. `WorkflowSend.tla` is not this model.

| Obligation | Test |
|---|---|
| Freeze | Literal, live latest target, imports, hashes, registry; downward continue-as-new refused in 1.0.83. |
| Claim table | Every row of 5.2, including the same claim after `admitted`, `cancelled`, `refused_full` and `refused_size` (no write), both refuse rows, and the bind, cancel and end settles. |
| Lost reply | Replay with the same guid: one item; a later `accepted` for that claim appends nothing; no second item reaches a turn. |
| N1, mixed build | An older build's count SQL on a durable row rolls back and queues nothing; a count that commits while the mode is unset stays legacy, and a later promotion to `durable` fails; one admission. |
| N1, legacy envelope | A copied `workflowIntake` for a legacy outbox row inserts no intake row and is not handled as an ordinary prompt; plain copies keep the 20-id window. |
| F2 | Queued text differs from the outbox: the admitted text is the render, also on replay; a generic event with `workflowIntake` is refused. |
| More than 20 ids | A durable copy, 21 other prompts, the same copy: suppressed. Positive control: a legacy exchange admitted twice. |
| N2, wake | Session idle, no other message, the store comes back: the same claim, bind or settlement is retried at its due time with no sleep in the orchestration; a command dequeued during the race is handled first; the due time survives continue-as-new; a session with no entry keeps today's yields. |
| P1, retry and prompt | An attempt sends then throws, and separately returns an error; its retry stops before its send with witness `sent: false`: `interrupted`, never `not_dispatched`. A gate refusal and a hydration give-up on a retry after a send: `interrupted`; neither resets `sent` nor moves the batch to another turn. A throw, an error and exhaustion after the send, and the next unrelated prompt, never make another turn carry it; an exhausted one ends `failed_indeterminate`; the bootstrap and budget-stash replacement cannot drop the batch; one invocation may run the model more than once. |
| P1, parking | Before any send: a gate refusal parks it, and the gate's own retry, or a message or command that ends the gate's wait, sends it and completes it; a refused re-attempt parks it again, unsent, with no turn of its own (decision A1); a credential failure parks it with nothing else queued, and no turn starts while a due bind or settlement is retried by the wake (no-spontaneous-turn control); a person's message then starts one attempt that carries it and completes it (positive control); each newly claimed item starts one attempt while the failure lasts, never more, also across a continue-as-new (review O-W2-5). |
| P1, adoption and settlement | A lost result and an adopted saved result keep the original batch and witness; a settlement failure repeats only the settlement; a witness for another invocation fails visibly; clearing removes only the batch's claims. |
| P1, stop and cancel | A Stop before the model with no earlier send: `not_dispatched`; a Stop while the attempt runs and a cancel after a possible send: `interrupted`, with no fresh replay; a tombstone on a `held` item settles `cancelled`, on an unsent item removes it, on a sent one records `cancel_requested` only; no duplicate consumes a tombstone. |
| N4, placement | Two `accepted` results for one claim give one item; a refuse call never changes a `holding` row with a placement; a settle that finds another state fails visibly and dispatches nothing; a move between the queue and the invocation is one synchronous step, also around the merge's and the commands' yields. |
| N5, view and lock | `read_workflow` shows the later intake outcome in the run's outbox entry, separately from its delivery; `beginDelivery` and a refusal on the same exchange in both orders: one waits, no deadlock; two refusals to one recipient at once stay event-only on it; a deleted source gets no `project`, no event and no outbox annotation; the recipient's row records the refusal. |
| N6, size and keys | An envelope over 1 KiB: malformed, nothing placed; a rendered item over 60 KiB as stored: `refused_size`, the execution continues; a retry rewrites its `unclaimed` entry in place; the 9th `unclaimed` and the 65th `held` entry are refused visibly; an invocation keeps its texts within 61 KiB and its other fields within 1 KiB. Keys: intake writes no KV key or value (the instance's keys and values are compared with and without intake items). Baseline positive control: 133 keys and 17 new commands, no intake item: 150 keys, valid. New case: the same with an intake item held, and again with an invocation bound and parked: 150 keys, valid; the item is still held or bound and every command response is present. Existing-limit control: an 18th command fails the session at 151 with and without intake, as today. |
| F7 | A full FIFO does not affect an intake item; a full intake queue: `refused_full`, visible to a live sender. |
| F8 | Sweep arrival: no timer release, no digest, no `utcNow`; claim before cancel on both paths. |
| Cancels | Before arrival, in a pass, for a `held` item, in the sweep, in an unsent and in a sent invocation. |
| Parse | Carried intake state that does not validate fails the execution with the field; FIFO parsing is unchanged. |
| CAN | The intake queue, the invocation (its batch, `sent`, the parked cause and a pending settlement) and rows survive continue-as-new, including one forced by the iteration cap; 1.0.82 inputs run on 1.0.83. |
| Native (inactive) | On the native duroxide runtime and PostgreSQL, with 1.0.83 registered by the test alone and the real worker and intake activities (`workflow-intake-orchestration.test.js`): an arrival claimed, bound, carried by its own turn as `runTurnV5` under the workflow-request tag, completed, recorded once in the transcript, then a continue-as-new on 1.0.83; a sent attempt's error retried across a continue-as-new that carries the marker and the retry's count, the same invocation completed, recorded once; a run that ends before its send settled `not_dispatched`; a closed workspace gate refusing before any model run, and a person's message delivering the same invocation (decision A1). Not an activation, mixed-version, crash-redelivery or model qualification. |
| Native, owed retry and adoption (inactive) | The same, with the real session lifecycle over a versioned `FilesystemSessionStore` (`workflow-intake-adoption.test.js`, review Q-W2-7): an attempt that saved its turn under key T and then failed at the worker's fault point after the commit; while its retry waits, a child's summary, a follow-up and a `set_model` whose continue-as-new comes before the retry's dispatch; the retry sends T with its count and its own prompt alone and adopts the saved turn (one model run of the turn, no new version), and the model notice, the summary and the follow-up ride later turns under keys of their own. An attempt that failed before its commit (fault point before the compare-and-swap): the retry sends T, rehydrates the last saved version and runs the turn again, saved under T; the failed run is not in the store. Review W2-WIT3: the retry of an attempt that carried no workflow item adopts its saved turn, which has no witness, and carries nothing; a copy that arrived while it waited is bound after it, and the next attempt carries, sends and completes it. Lossy-fresh control: completions lost to a closed connection (a transport double) retry with T and adopt; the lossy handoff's retry (count 0, no key) never adopts and runs the turn again under a key of its own. The forced continue-as-new is `set_model`'s (the iteration and history-size caps are unit-tested); the child is a tracked entry only; the store is the filesystem one. |
| Native, decide's own turn (inactive) | The same (`workflow-intake-own-turn.test.js`, 6.2 and section 3): a copy that arrives while the agent's wait is armed and a child's summary is buffered; drain releases the wait as for queued work, and decide's turn for the item alone has the internal prompt with the released wait's note and the digest in its system context, the item in its own field; the model gets the canonical text first, unchanged; turn start records the turn's system note and then the item once, with its canonical id and the system sender; the invocation completes, and the wait resumes with the time it had left and ends in a turn of its own that carries nothing. The cron and cron_at notes take the same release path and are unit-tested. |
| Fingerprints | The declared 1.0.83 delta (section 8); the drive and ordinary-message goldens change only by the turn activity names. |
| Baseline | Full suite and baseline are a separate grant. |

## 13. Remaining questions

1. The intake queue's caps (8 `unclaimed`, 64 `held`), the invocation
   caps, the 1 KiB envelope cap and the claim backoff are proposals.
2. A rendered message over the item cap is refused at the recipient
   (`refused_size`). The send state could refuse it at entry instead; that
   would change send admission and is not proposed here.
3. The session's `command.response.<id>` keys grow without a bound today
   and share the 150-key limit (5.7). That existing behavior is outside
   this design.
