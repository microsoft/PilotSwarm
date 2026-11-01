# Workflow messaging: request and reply (design, revision 3)

Status: revised design checkpoint for review. Docs only; no code changes.
Revision 2 (`f9e04db8`) revised `72f1e701` after the parent review
(`wfv2-request-design-72f1e701-parent-review.md`, SHA-256 `a74d237f…`) and
the decisions in `pse/wfv2/decisions/request-reply-shape`. Revision 3 is a
focused delta after the parent review of revision 2
(`wfv2-request-design-f9e04db8-parent-review.md`, SHA-256 `8f1b27c7…`); it
keeps the choices that review accepted (the status derived from the node,
the exact SQL deadline, the declared response schema). Source base:
`9fcbf377` (send to agents and workflows; S2 accepted with limits). Line
numbers are at that commit.

A messaging `request` state sends one typed request to a session and waits
for one typed result. Exactly one result ends it: a response, a declared
refusal, its deadline, an observed unavailable responder, a delivery
failure or the end of its run. This revision makes the node's
compare-and-swap the only decision, derives the request's status from it,
adds a durable wake intent, and fixes the deadline rule, the responder's
identity, idempotency and compatibility.

## 0. Finding resolution

Revision 3:

| Finding | Resolution | Section |
|---|---|---|
| R2-01 (P1): wake updates need a lease identity | Each lease gets a new token in the statement that adds one to `attempts`. Every completion compares that token and `state = 'leased'`, so a stale holder changes nothing; a settled row never changes. Only a dispatch pass abandons a row, under its row lock, with one event. A failed or unknown lifecycle read is a retry, never moot. No 24-hour deletion: rows stay with the request's records. | 5 |
| R2-02 (P1): operation identity not preserved | `workflow_request_operations` binds every admitted operation (the winner, identical aliases, audited refusals) to its result identity and outcome. A known operation is looked up before any state rule; another result under it is `OPERATION_CONFLICT`; no binding is replaced. At most 50 bindings per request: at the limit an unknown operation gets `OPERATION_LIMIT` and nothing is written, and known ones stay replayable. Validation failures bind nothing. The capped counter row is gone. | 3, 7 |
| R2-03 (P2): lone surrogates refused | The refusal is removed. Results use the shared helpers (`json.ts`): any JSON value, with NUL and lone surrogates kept as escaped canonical text; a business schema may constrain strings. | 7 |
| R2-04 (P1): continue-as-new target | 1.8.0 is frozen with the literal target 1.8.0, as its histories recorded. New runs start at 1.9.0. No run moves between versions. | 8.1 |
| R2-05 (P1): shared activities reach old workers | A capability tag, `pilotswarm.workflow-request.v1`, as the turn-control precedent: every activity of a 1.9.0 run and of a request's delivery is scheduled with it under a new name, and older workers never fetch it. The responder's turns run only on tagged workers. The deployment setting is an admission switch, not the fence. | 8.2, 8.3, 8.4 |
| Clarification: lock modes | The canonical modes of `lockInputSessions`: the requester's session row `FOR NO KEY UPDATE`, the responder's `FOR SHARE`, ascending session id (`store.ts` 697-703). | 4.1, 4.2, 6 |
| Clarification: receipt access | One target authorization first, then exactly one branch: the replay of a known operation, or a new decision. Before it, nothing is written or diagnosed; a deleted session or a revoked credential cannot read a receipt by an old operation id. | 6, 7 |

Revision 2:

| Finding | Resolution | Section |
|---|---|---|
| REQUEST-DESIGN-01 (P1): deletion left a request pending after its node was cancelled | Decision B: the request's status is derived from its node, with no second mutable status. A total mapping covers every node result; any other combination fails as store corruption. The request row is immutable identity linked to the node. The response record is written only by the transaction that wins the node's compare-and-swap. The deletion trigger needs no change; rows and receipts survive a soft delete. Terminal-producer table and ordering oracles. | 3, 4.1, 4.2 |
| REQUEST-DESIGN-02 (P1): no durable wake intent | A `workflow_response_wakes` row, keyed by the exchange id, is committed with the response record, the node's result and the events. A post-commit attempt (optimization) and a bounded dispatch loop in each worker (lease, retries, lifecycle checks) deliver it. The controller's backstop stays as additional recovery. Revision 3 adds the lease token and retention (R2-01). | 5 |
| REQUEST-DESIGN-03 (P1): deadline rule ambiguous | One `clock_timestamp()` reading after all deciding locks and guards; exact SQL comparison `reading < deadline_at`; equality is late. A decision made before the deadline may commit after it. A late call while the request is pending returns `REQUEST_EXPIRED` and accepts nothing; only the controller's elapse decides `timed_out`. An accepted identical retry returns its stored receipt. | 4.3 |
| REQUEST-DESIGN-04 (P1): responder identity | An actor binding for each entry point. The first increment exposes only the in-process tool; REST, SDK and MCP only with a session-scoped invocation credential (actor, audience, request scope, expiry, revocation). A human bearer never answers as an agent. Canonical lock order and authority recheck; wrong actors learn and write nothing; receipt replay rule; a response before the delivery record is valid. | 6 |
| REQUEST-DESIGN-05 (P2): idempotency and audit | A precedence order and a complete outcome table. Operation identity and receipts persist. Bounds for results, schemas and the prompt. Field presence selects the result's kind; its identity hashes kind and value. Revision 3 replaces the capped audit rows with operation bindings (R2-02) and keeps lone surrogates (R2-03). | 7 |
| REQUEST-DESIGN-06 (P1): compatibility | IR 7; controller 1.9.0 with 1.8.0 kept replayable (not fenced); request-aware collection; a deployment capability and opt-in publication; recipient capability checked at entry and at delivery; rollback rule. Design A is a prerequisite for one logical request per recipient beyond the 20-id window. Revision 3 freezes the 1.8.0 target and adds capability routing (R2-04, R2-05). | 8 |
| T062 versus row 6 | The responder is observed at delivery, at every response call, and by the controller once per backstop period while the request waits. A deleted, revoked or ended responder is recorded as `unavailable` or `forbidden` through the node's compare-and-swap; an earlier response stays. A slow but live responder times out. | 4.4 |
| Decisions 1 to 5 | `input` and `timed_out`, with diagnostics for `request:` and `timeout`; send and receive may use a contract that declares a response; workflow recipients are explicitly unsupported in the first increment and stay outstanding; no cancellation notice in the first increment, advertised; Q6 forbids peer lifecycle changes only; a strict `{reason}` decline schema; result identity hashes kind and value. | 2, 7, 9 |

## 1. Requirements in scope

| Source | Requirement |
|---|---|
| R07; design 03 "Messaging modes" | `request`: as send, plus a response schema and a deadline. Success is an accepted typed response; chat prose is not a response. |
| Design 03 | Request ids are stable across delivery retries, distinct across loop and rework occurrences, and keep the schema digest, payload hash, destination and deadline. A same response is idempotent; a different second reply conflicts. Status moves `pending -> responded \| declined \| timed_out \| cancelled` atomically. Reply acceptance and its wake intent share one transaction. Losing or late responses are audited, cannot revive the call and do not overwrite its selected transition. Caller cancellation does not cancel or delete the peer; a bounded notice is sent if supported. |
| R13; R27; hard invariants 3, 5, 8, 9 | No caller-supplied authority. Every winner is idempotently identified. A pending operation keeps its resolved recipient, arguments and deadline. One terminal compare-and-swap resolves reply against timeout or cancellation; late events never revive a closed occurrence. Delivery is at least once; stable ids and durable acceptance suppress duplicates. |
| D03 | Pause freezes progression, not deadlines. |
| Design 04 | `respond_session_request(request id, JSON response or declared refusal, operation id)`: host-bound responder, request schema and deadline validation, idempotent terminal result. REST `/session-requests/{request}/responses` with trusted context or a scoped invocation credential. |
| Test plan | T028, T042, T052, T055 to T059, T061 to T063, T065 to T068, T088, and the oracles below. |

## 2. The state

```yaml
approve_publication:
  type: messaging
  mode: request
  recipient: {parent: true}          # or a session id, as a send state
  contract: PublicationApproval@1
  input: "${input}"                  # the request payload (optional, as a send state)
  correlate: {candidate: "${input.head}"}   # optional, as a send state
  timeoutSeconds: 3600               # required: 1 to 86,400, or one whole-string binding
  transition:
    next: {responded: verify_approval, declined: blocked, timed_out: blocked, failure: failed}

contracts:
  PublicationApproval@1:
    schema: {$ref: "#/schemas/PublicationRequest"}
    response: {schema: {$ref: "#/schemas/PublicationDecision"}}
```

- Names: the payload field is `input` and the timeout route is `timed_out`,
  as send states and runtime errors already spell them (`compiler.ts`
  44-59, 458-492). `request:` and a `timeout` route get explicit
  diagnostics that name the right spelling; neither is read as an alias.
  Design 09's examples and every interface change together.
- `timeoutSeconds`: an integer from 1 to 86,400 (the wait bound,
  `compiler.ts` 39) or one whole-string binding. A binding is evaluated
  at admission, checked to that range (`invalid_input` otherwise) and
  frozen with the deadline; a later KV change does not move it.
- Contracts: a request state requires a contract with `response`. A send
  or receive state may use the same contract: it checks the payload
  against `schema` only, and creates no request.
- IR version 7 is written for a workflow with a request state or a
  contract that declares `response`. Builds before it refuse it explicitly
  (`compiler.ts` 868-869); versions 1 to 6 keep their meaning.
- Outcomes. Business: `responded` (output: the response) and `declined`
  (output: `{reason}`). Runtime errors: `timed_out`, `cancelled`,
  `unavailable`, `forbidden`, `delivery_failed`, `unsupported_contract`,
  `invalid_input`, routed by code or by `failure`.
- First increment: the recipient is an agent session (the parent, or a
  named session of the same user, decided as a send's recipient) that has
  the response capability (section 8.3). A workflow recipient fails at
  admission with `unsupported_contract` and details
  `{capability: "workflow_respond"}`. Workflow receive-and-respond stays
  an outstanding part of R07; messaging is not complete without it.
- Cancellation notice: the first increment sends none and says so
  (`cancelNotice: "unsupported"` in the request's prompt and receipt). A
  later bounded notice is allowed; the peer's lifecycle is never changed.

## 3. Records

One migration (the next free number when it lands; design A's storage may
take an earlier one):

- `workflow_outbox.mode` admits `request`; existing `send` rows stay valid.
- `workflow_requests`: written once at entry, never updated. Key
  `exchange_id` = the node execution id (foreign keys to the node and to
  the outbox). Columns: `workflow_session_id`, `run_id`,
  `responder_session_id` (frozen at entry), `contract`, `request_sha256`
  (the canonical payload), `response_schema_sha256`, `deadline_at`,
  `created_at`.
- `workflow_request_responses`: at most one row per request, written only
  by the transaction that wins the node's compare-and-swap with a
  response. Columns: `exchange_id`, `kind` (`response` or `decline`),
  `value` (canonical text), `result_sha256`, `operation_id`,
  `actor_session_id`, `decided_at` (the deciding reading), `receipt`
  (canonical text).
- `workflow_request_operations`: the binding of every admitted operation
  (section 7). Key (`exchange_id`, `operation_id`). Columns:
  `actor_session_id`, `result_sha256` (the result identity), `outcome`
  (`decided`, `same`, `expired`, `closed` or `conflict`), `status` (the
  derived status at its reading), `first_at` (its deciding reading),
  `last_at`, `count`. Only `last_at` and `count` ever change. At most 50
  rows per request; the winner's row is written with its response record.
- `workflow_response_wakes` (section 5).

Soft deletion of either workflow keeps every row and receipt.

The request's status is derived, never stored:

| Node | Response record | Status |
|---|---|---|
| `pending` | none | `pending` |
| completed `responded` (business, winner `response`) | kind `response` | `responded` |
| completed `declined` (business, winner `response`) | kind `decline` | `declined` |
| completed `timed_out` (runtime error, winner `controller`) | none | `timed_out` |
| completed `cancelled` (runtime error; winner `cancel`, `delete` or `controller`) | none | `cancelled` (reason: cancel, delete, recover or stop) |
| completed `unavailable`, `forbidden`, `delivery_failed`, `unsupported_contract` or `invalid_input` (runtime error) | none | `failed` (with the code) |

Any other combination (an unknown outcome, a responded or declined node
without its record, a record on any other node, a request row without its
node) is `WORKFLOW_STORE_CORRUPT` in the read view and in the tool. There
is no default status.

## 4. One decision ends the request

### 4.1 Terminal producers

Every producer completes the node with a compare-and-swap from `pending`;
the first winner stays.

| Producer | Transaction | Node result | Response record | Wake intent |
|---|---|---|---|---|
| A response (`respond_session_request`) | Session locks (`lockInputSessions`: the requester's row `FOR NO KEY UPDATE`, the responder's `FOR SHARE`, ascending session id), then run and node; one reading | `responded` or `declined`, winner `response` | inserted | inserted |
| The deadline (controller elapse, request-aware) | Requester's session lock, then node; one reading at or after `deadline_at` | `timed_out`, winner `controller` | none | none (the controller decides itself) |
| Responder observation (controller, 4.4) | Session locks as a response, then node | `unavailable` or `forbidden`, winner `controller` | none | none |
| Delivery failure (`failDelivery`, `beginDelivery`'s refusals, the collection of an ended delivery orchestration) | As a send's (`store.ts` 2277, 2399) | `unavailable`, `forbidden` or `delivery_failed` | none | none (the delivery orchestration's wake and collection) |
| The run's end (`finishRun`: cancel, recover, a failed or completed run, a later stop) | Requester's session lock, run, nodes (`store.ts` 2440) | `cancelled`, winner `cancel` or `controller` | none | none |
| Deletion of the requesting workflow (trigger, `migrations/workflow-v2-0087.ts` 58) | The soft delete's own transaction | `cancelled`, winner `delete` | none | none |
| Admission refusal (`enterNode`) | At entry | an immediate result; the node is never pending | none | none |

Because the status is derived, no producer writes a second status, and the
deletion trigger stays as it is.

### 4.2 Ordering oracles

- Response, then deletion: the response's transaction holds the
  requester's session row `FOR NO KEY UPDATE`; the soft delete's update of
  that row waits for it. The node is `responded`; the trigger skips
  completed nodes. A soft delete of the responder waits in the same way on
  its `FOR SHARE` lock.
- Deletion, then response: the node is `cancelled` (winner `delete`); the
  response finds it decided: `REQUEST_CLOSED` (status `cancelled`). If the
  responder is the deleted session's peer, the call is still authenticated
  and authorized first (section 6).
- Deletion with the delivery child ended, with the request delivered but
  unanswered, and repeated deletion: the trigger acts on the first soft
  delete only (`OLD.deleted_at IS NULL`, `migrations/workflow-v2-0087.ts`
  47); the status is `cancelled` at once, with no later attempt needed.
- Cancel, recover or stop after a response: the node is already decided;
  `finishRun` ends only pending nodes; the response and its receipt stay.
- After every committed operation, the derived status agrees with the
  node, because it is the node.

### 4.3 The deadline

- `deadline_at` is set at entry from the accepted-entry reading (as a
  wait's, W1) plus the frozen `timeoutSeconds`.
- The response transaction takes its locks, checks the request, then reads
  `clock_timestamp()` once. That one reading decides: the response is
  eligible only if `reading < deadline_at`, compared in SQL as timestamps
  (microseconds). Equality is late. The same reading is the node's
  `completed_at`, the record's `decided_at` and the receipt's time. No
  JavaScript `Date`, no transaction-start `now()`, no second reading.
- A decision made before the deadline may commit after it. The elapse
  takes the requester's session lock and waits for that commit; it then
  finds the node decided and changes nothing.
- An authenticated, authorized call with a new operation whose reading is
  at or after `deadline_at` while the node is still pending returns
  `REQUEST_EXPIRED`. It accepts nothing and decides nothing: the
  controller's elapse, on its durable timer, is the only producer of
  `timed_out`. The operation is bound `expired` (section 7).
- A repeat of an accepted response with the same operation id and the same
  result returns the stored receipt after the deadline too (a known
  operation, section 7); the decision window is not reopened.

### 4.4 Observed unavailability (T062)

| Point | What is observed | Result |
|---|---|---|
| Delivery (as a send) | The responder missing, deleted, not allowed, or its session orchestration ended or absent | The node fails `unavailable` or `forbidden` before or instead of the delivery |
| A response call | The caller's session deleted or no longer allowed | The call is refused (section 6); the node is not changed |
| The controller, once per backstop period while the request waits | Under the session locks: the responder's row deleted, or not allowed by the authority rule; outside them, its session orchestration in a terminal status (permanent) | The node fails `unavailable` or `forbidden` (winner `controller`); a response that won first stays |

A live, allowed responder that does not answer is slow, not unavailable:
its request times out. The observation decides only at a reading before
`deadline_at`; at or after it, only the elapse decides (`timed_out`). A
responder deleted within the last backstop period before the deadline may
be recorded as `timed_out`; that is the stated timing uncertainty, bounded
by the backstop period. A request is never retargeted.

### 4.5 Pause

A paused run keeps its request's deadline. A response accepted while it is
paused decides the node; its wake is dispatched; the controller collects
the result after the resume (T028).

## 5. The durable wake intent

- `workflow_response_wakes`: key `exchange_id`, so one per request (only
  the winning response inserts one). Columns: `run_id`,
  `controller_instance_id`, `state` (`pending`, `leased`, `dispatched`,
  `moot` or `abandoned`), `lease_token`, `lease_until`, `attempts`,
  `next_attempt_at`, `created_at`, `settled_at`, `last_error` (at most
  1,000 characters).
- The response transaction inserts it (`pending`, due at once) with the
  response record, the operation's binding, the node's result and the
  events. No response commits without it, and a replay never inserts or
  changes one.
- **Lease.** One statement leases a due row that has fewer than 100
  attempts: it locks the row (`FOR UPDATE SKIP LOCKED`) and sets
  `state = 'leased'`, a new random `lease_token`,
  `attempts = attempts + 1` and `lease_until` (its reading plus 30 s). A
  row is due when it is `pending` with `next_attempt_at` at or before the
  reading, or `leased` with `lease_until` at or before it (an expired
  holder). An attempt is one lease: the immediate try, each lease of a
  pass and each reclaim count.
- **Completion.** Every update by a holder has the condition
  `exchange_id = $1 AND lease_token = $2 AND state = 'leased'`:
  - the enqueue of `{type: "workflow-wake", runId, reason: "response"}`
    on the controller's command queue returned: `dispatched`,
    `settled_at`;
  - the enqueue failed, or the lifecycle read failed or was unknown (a
    missing instance included): `pending`, `next_attempt_at` = reading
    plus 1 s doubling to 60 s, `last_error`, token cleared;
  - a successful read showed the run ended, or the controller instance in
    a terminal duroxide status (`Completed`, `Failed`, `Terminated`):
    `moot`, `settled_at`.

  An update that matches no row changes nothing: a newer holder has the
  row, or it was settled. A duplicate enqueue (a lost acknowledgement, a
  reclaim after an enqueue) is harmless: the controller treats a wake as a
  hint and collects idempotently.
- **Abandonment.** A pass that finds a due row with 100 attempts sets
  `abandoned` and `settled_at` and writes one
  `workflow.response_wake_abandoned` event, in one transaction under the
  row lock. No other path abandons, so there is one event. Abandonment is
  visible in the read view and separate from the response, which stays
  accepted; the controller's backstop still collects the node.
- **Settled rows never change.** `dispatched`, `moot` and `abandoned` are
  final; no update condition matches them.
- **Who dispatches.** After its commit the responding worker leases that
  one row and tries at once (an optimization). Each worker of a
  request-capable build runs one pass loop within the worker's lifecycle,
  as its eviction timer does (`worker.ts` 1134-1145, 1161-1166): it starts
  after `registerWorkflowV2`, runs every 2 s with one pass at a time and
  leases at most 20 due rows a pass; `stop()` clears it and waits for the
  pass in flight before the runtime shuts down. The controller's backstop
  still collects the completed node: it is additional recovery, not the
  wake contract.
- **Retention.** This design deletes no row. Pending and leased rows are
  never removed. A settled row stays with the request's records for as
  long as the request can be replayed or inspected; a later shared
  retention policy (separately reviewed) may remove a request's records
  only together, and may compact a settled wake only to its `state` and
  `settled_at`. A repeated response after any cleanup returns its receipt
  and never creates or contradicts a wake.
- This is not a general notification system. Typed input to receive
  states keeps its post-commit hint and backstop; that stays a separate,
  stated limit of the receive state.

## 6. The responder's identity

| Entry point | Actor | Increment |
|---|---|---|
| The `respond_session_request` agent tool | The tool's host session, from the worker's trusted tool context; never an argument | First |
| REST `/session-requests/{request}/responses`, SDK, MCP | A session-scoped invocation credential issued by the runtime to that session's own runtime: actor session, audience `session-requests`, request or session scope, expiry, revoked when the session is deleted or the credential rotates | Protocol-parity slice; not exposed before it |

- A human bearer token, with or without a session id in the request, never
  answers as an agent session (R13, T088). A generic custom event or a
  queued message cannot carry a response.
- **Authentication** comes before any request is read. The tool takes its
  host session from the worker's trusted tool context; a credential must
  verify (signature, audience `session-requests`, expiry). A failure is
  the entry point's authentication error: nothing about any request is
  read or returned, and nothing is written.
- **Target authorization** is the first step of the response transaction.
  It reads the request's immutable row, then calls
  `lockInputSessions(requester, actor)`: the requester's session row
  `FOR NO KEY UPDATE` and the actor's `FOR SHARE`, in ascending session
  id, before any run, node or request-record lock (`store.ts` 697-703).
  On what it reads after the locks: the request exists, the actor is its
  frozen responder, the actor's row is live, a credential is not revoked
  (its revocation row is read `FOR SHARE` after the session locks), and
  the authority rule allows the actor now. Any failure returns
  `REQUEST_NOT_FOUND`; the transaction rolls back with no row, no event,
  no receipt and no structural, field or schema diagnostic.
- Then exactly one branch runs (section 7):
  - **Replay** of an operation already bound for this request returns its
    stored outcome or `OPERATION_CONFLICT`. Its outcome does not depend on
    the deadline or the request's state, and it never decides again. It
    is reached only through the target authorization above, so a deleted
    session, a revoked credential or an actor that lost its authority
    cannot read a receipt by knowing an old operation id, its own
    included. The stored decision itself stands.
  - **New decision** for an operation not yet bound: validation, the
    deadline reading and the state rule.
- A response may commit before the delivery is recorded: the request row
  exists from entry, and the delivery record later marks only the message
  delivered.

## 7. Idempotency, audit and bounds

Order of checks in a response call:

1. Authenticate (section 6). Failure: the entry point's authentication
   error; nothing read or written.
2. Target authorization under the session locks (section 6). Failure:
   `REQUEST_NOT_FOUND`; nothing written, nothing diagnosed.
3. Structure: exactly one of `response` or `decline` is present
   (presence, not truthiness: `response: null` is a response whose value
   is `null`). The value must be a JSON value (`assertJsonValue`) whose
   canonical text (`canonicalJson`) is within the bounds below. Failure:
   `RESPONSE_INVALID` with structural errors. A call whose result
   identity cannot be computed binds nothing.
4. Known operation: if (`exchange_id`, `operation_id`) is bound, the
   replay branch decides alone (table 7.1). The binding never changes;
   `last_at` and `count` record the repeat.
5. Schema: a response against the contract's response schema, a decline
   against the decline schema. Failure: `RESPONSE_INVALID` with field
   errors. This is validation only: nothing is bound, and the operation
   id stays unused.
6. Limit: an unknown operation when the request already has 50 bindings
   gets `OPERATION_LIMIT` (backpressure) and nothing is written.
7. One `clock_timestamp()` reading; the state rule (table 7.2) decides and
   binds the operation in the same transaction.

The result identity is `sha256` of the canonical text of `{kind, value}`:
a response and a decline never collide.

7.1 Known operation, in any request state:

| The call's result | Outcome |
|---|---|
| Same identity as the binding | The stored outcome: `decided` and `same` return the winner's receipt; `expired`, `closed` and `conflict` return the code they returned (`REQUEST_EXPIRED`, `REQUEST_CLOSED` with the status recorded, `RESPONSE_CONFLICT`). The current status is added for information. |
| Another identity | `OPERATION_CONFLICT`; the binding stays. |

7.2 New operation, bound with the outcome shown:

| Request state at the reading | Outcome | Binding |
|---|---|---|
| `pending`, reading before `deadline_at` | Decides: node, response record, wake intent and events; returns the receipt | `decided` |
| `pending`, reading at or after `deadline_at` | `REQUEST_EXPIRED`; nothing decided | `expired` |
| `responded` or `declined`, same identity as the winner | The winner's receipt (T057) | `same` |
| `responded` or `declined`, another identity | `RESPONSE_CONFLICT`; the first stays (T058) | `conflict` |
| `timed_out`, `cancelled` or `failed` | `REQUEST_CLOSED` with the status | `closed` |

- Example: operation A decides X; operation B with X is bound `same` and
  gets A's receipt; B with Y then finds B bound to X and gets
  `OPERATION_CONFLICT`, not `RESPONSE_CONFLICT`.
- The limit never blocks the winner: before the deadline the first
  admitted operation of a pending request decides, so the winner is
  always the first binding; later bindings are aliases and refusals.
- Authentication failures and wrong actors bind nothing and are not
  audited (steps 1 and 2). Validation failures bind nothing (steps 3 and
  5).
- Bindings are never evicted while the request's records exist. Known
  operations, the winner's included, stay replayable at the limit. No
  aggregate counter stands for an operation.
- Bounds: a response at most 16 KiB of canonical JSON (the send payload
  bound, `WORKFLOW_V2_MAX_SEND_PAYLOAD_BYTES`); a decline reason a string
  of 1 to 2,000 characters; the decline schema is strict: `{type: object,
  additionalProperties: false, required: [reason], properties: {reason:
  {type: string, minLength: 1, maxLength: 2000}}}`. The request's prompt
  (payload, response schema and instructions) is at most 32 KiB, within
  the session queue's item cap. A response schema larger than 8 KiB is
  refused at compile time.
- JSON values use the shared helpers in `json.ts` (4-11, 35-38, 61-82).
  Any JSON value is accepted: `null`, `false`, root and nested arrays,
  NUL, lone or paired surrogates and any object key. Values are stored as
  escaped canonical TEXT, never jsonb, and hashed as that text, so a
  replay compares and returns exactly the stored value. A business schema
  may constrain its strings; the framework does not narrow the JSON
  domain. Display-safe renderings are previews only, never compared or
  hashed.
- No result carries authority: a response that says it approves is data;
  any approval is verified separately (design 09).

## 8. Compatibility, capability and rollout

### 8.1 Controller versions

- Request states need controller 1.9.0 (request-aware collection,
  deadline and observation). New runs start at 1.9.0 (`service.ts` 133,
  216 start the module's version), and 1.9.0 continues as new at 1.9.0.
- 1.8.0 is frozen. Its generator stays as it is, except that its
  continue-as-new target is written as the literal `1.8.0`: today it
  yields the module constant (`runtime.ts` 554-556), which becomes 1.9.0
  in this build and would change a recorded argument on replay. It keeps
  its legacy activity names and starts the 1.0.0 effect, notify and send
  orchestrations, as its histories recorded. Its activities keep their
  input and output meaning for every input a 1.8.0 history can hold (IR 1
  to 6, no request rows).
- No run moves between versions: a 1.8.0 run stays on 1.8.0 until it
  ends. 1.8.0 definitions have no request nodes, so no upgrade is needed
  to implement requests. A later cross-version continuation needs its own
  replay evidence.
- duroxide takes an orchestration's versions in ascending order
  (`runtime.ts` 1154-1161): the fenced 1.0.0 to 1.7.0, then 1.8.0, then
  1.9.0. No new fail-fast fence replaces compatibility. The fence of 1.0.0
  to 1.7.0 is unchanged and stays a stated debt (`runtime.ts` 88-105); this
  design does not repair it.

### 8.2 Activity routing

- A capability tag, `pilotswarm.workflow-request.v1`, follows the agent
  handoff, workspace and turn-control precedent (`activity-routing.ts`;
  the routing test `turn-control-orchestration-routing.test.js`). Every
  worker of a request-capable build declares it with the three existing
  tags (`worker.ts` 899, `workerTagFilter: {defaultAnd: [...]}`): four of
  the five tags a duroxide filter may hold (`MAX_WORKER_TAGS`, duroxide
  0.1.32 through duroxide-node 0.2.4).
- Every activity that 1.9.0 schedules, and every activity of an
  orchestration it starts, is scheduled with that tag under a name
  distinct from the legacy one: the controller's own activities; the
  effect, notify and send orchestrations at new versions (1.1.0, same
  algorithms); and the new request delivery orchestration
  `workflow-v2-request` 1.0.0 with its deliver and delivery-failed
  activities. A request-capable build registers the legacy and the new
  names; older builds have only the legacy ones.
- An older worker's filter excludes the tag, so its provider never
  fetches that work: it is not executed, abandoned or poisoned there, and
  no attempt of the request's delivery budget is spent on it. With no
  capable worker the work waits in the queue (duroxide's behavior for a
  tag no worker serves).
- `workflow-v2-send` 1.0.0 and its untagged activities are unchanged and
  keep serving the sends of 1.8.0 runs (IR 1 to 6), with the same input,
  output and receipt meaning.
- An older build's outbox decoder refuses mode `request` (`store.ts`
  536-540). With this routing, an older build meets a request row only in
  a read or a service call (a read view, `update_workflow` on a 1.9.0
  run). There it fails with `WORKFLOW_STORE_CORRUPT`, and its transaction
  writes nothing: the explicit failure of an incapable worker, never a
  decision.
- duroxide 0.1.32 cannot route orchestration items by tag. An older
  worker that fetches a 1.9.0, 1.1.0 or `workflow-v2-request` item does
  not have it registered: duroxide abandons it with backoff (1 s doubling
  to 60 s) for a capable worker, and poisons it after its maximum
  attempts. Every orchestration version has had this exposure (session
  1.0.81, `docs/architecture/orchestration/design.md` 545-551). The
  rollout rule (8.4) keeps capable workers present; a poisoned controller
  is visible (`needsRecovery`), and `recover` ends its run.

### 8.3 The responder's tool

- `respond_session_request` is registered only by request-capable builds,
  so a responder's turns must run only on capable workers. The first
  session orchestration version that this build ships (Vr here) schedules
  its turn activities with the request tag, as 1.0.81 does with the
  turn-control tag.
- At entry and again at delivery, the recipient must be an agent session,
  its effective tool policy must include the tool, and its observed
  session orchestration version (`getInstanceInfo`) must be Vr or later.
  Otherwise, or when the version cannot be read, the state fails with
  `unsupported_contract` and `{capability: "respond_tool"}`; no prompt
  asks for a tool the recipient lacks. A session reaches Vr only through
  its existing continue-as-new (design.md 547-549). If design A's
  recipient version ships first, Vr is that version or a later one; this
  design needs only its turn tag.

### 8.4 Deployment setting and rollout

- A deployment setting turns request states on. It is an admission
  switch, not the fence (8.2 and 8.3 are the fence). While it is off or
  cannot be read, publication of an IR 7 definition is refused and a
  request state's entry fails with `unsupported_contract`
  (`{capability: "workflow_request"}`). Requests already pending are not
  affected: delivery, responses, wakes, observation and deadlines
  continue.
- Older builds refuse IR 7 wherever they read it (`compiler.ts` 866-869)
  and do not know controller 1.9.0; they never reinterpret either.
- Rollback: retain request-capable workers until 1.9.0 runs, request
  deliveries, unsettled wakes and Vr sessions drain, unless a separately
  authorized coordinated rollback restores both code and durable state
  (the 1.0.81 rule). Without a capable worker, tagged work waits and
  resumes when one returns; no older worker decides anything.

### 8.5 Collection and intake

- **Request-aware collection.** The collect activity today treats every
  non-receive messaging node as a send (`runtime.ts` 1522-1539). 1.9.0's
  collect handles a request node: an ended delivery orchestration with
  the message delivered means the request awaits its response, not a
  failure; with the message still pending, `failDelivery` decides as for
  a send; with the message failed, the node already failed in that
  transaction.
- **Durable intake.** A request prompt reaches an agent at least once.
  One logical request per recipient beyond the 20-id window needs design
  A; until then a duplicate prompt can only lead to a repeated or
  conflicting response, which section 7 settles.

## 9. Invariants

- **Q1 one winner:** a request is decided once, by the node's
  compare-and-swap; its status is the node's (section 3).
- **Q2 deadline:** a response is accepted only when its one deciding
  reading is before `deadline_at`; `timed_out` is decided only by the
  elapse at a reading at or after it.
- **Q3 late calls:** a call that finds the request decided or expired
  changes nothing but its own new binding, or the `last_at` and `count`
  of its known one.
- **Q4 responder:** only the frozen responder, authenticated by its host
  or a scoped credential and still allowed, can decide; a replay needs the
  same current authorization.
- **Q5 identity:** the request id is stable for the occurrence; the
  response record and receipt are immutable; every admitted operation
  keeps one binding to its result identity and outcome; a repeat returns
  that outcome and another result under it conflicts.
- **Q6 peer untouched:** no decision of the requesting workflow changes
  the peer session's lifecycle; a supported bounded notice may be added
  later.
- **Q7 wake:** every committed response has its wake intent in the same
  transaction; only the current lease holder settles it; a settled intent
  never changes; each intent is dispatched, found moot by a successful
  read, or abandoned once with an event, while the backstop still
  collects the result.
- **Q8 routing:** no request work, 1.9.0 activity or responder turn runs
  on a worker without the request capability; such work waits instead.

## 10. Failure matrix

| # | Failure | Result |
|---|---|---|
| 1 | The response commits; the tool's reply is lost; the agent repeats | Same operation: the stored receipt. |
| 2 | Response and deadline close together | Each transaction's one reading decides under the session lock; the first compare-and-swap stays. |
| 3 | Response before the delivery record | Accepted; the record marks only the message. |
| 4 | Response after the run's cancel or deletion | `REQUEST_CLOSED` (`cancelled`); the operation is bound `closed`. |
| 5 | Delivery fails after a response won | The failure's compare-and-swap finds the node decided. |
| 6 | The responder is deleted or revoked while the request waits | Observed (4.4): `unavailable` or `forbidden`; or `timed_out` within the last backstop period. |
| 7 | The requesting workflow is deleted | The trigger cancels the node in the delete's transaction; the status is `cancelled` at once. |
| 8 | A duplicate prompt; the agent answers twice | A repeat or a conflict; the first response stays. |
| 9 | Crash after the response commit, before dispatch | The dispatch loop delivers the wake; the backstop collects in any case. |
| 10 | The wake enqueue fails repeatedly | Backoff, then `abandoned` with an event; the backstop collects. |
| 11 | Store outage during a response call | The tool returns the error; the agent may repeat with the same operation id. |
| 12 | Corrupt or orphaned records | `WORKFLOW_STORE_CORRUPT`, never a default status. |
| 13 | A wake holder stalls; another reclaims and dispatches; the first then fails | Its update matches no row; `dispatched` stays. |
| 14 | The lifecycle read fails or finds no instance | A retry with backoff, never `moot`. |
| 15 | A new operation when 50 are bound | `OPERATION_LIMIT`; nothing written; known operations still replay. |
| 16 | An older worker runs beside capable ones | It never fetches tagged work; its read of a request row fails explicitly and writes nothing. |
| 17 | Every capable worker is removed | Tagged work waits; 1.9.0 items are abandoned with backoff and can be poisoned (visible; `recover`); no older worker decides. |

## 11. Plan and coverage

Commits, each with DEV tests and independent review:

1. Compiler and IR 7: the request state, response contracts, the
   diagnostics for obsolete spellings, the frozen timeout binding (compile
   tests).
2. Records and store: the migration, the request at entry, the response
   transaction with its record, operation binding and wake intent, the
   derived status, the request-aware elapse, the observation (store and
   native tests).
3. Versions and routing: 1.8.0 frozen with its literal target, 1.9.0,
   the effect, notify and send orchestrations at 1.1.0,
   `workflow-v2-request` 1.0.0, the worker tag, session version Vr with
   tagged turns (replay and routing tests).
4. Tool and dispatch: `respond_session_request`, the wake lease and pass
   loop, the capability checks, the read view (native tests with an agent
   test double that calls the tool).
5. Formal model `WorkflowV2Request.tla`: the single compare-and-swap among
   response, deadline, observation, run end, deletion and delivery
   failure; late and duplicate calls; operation bindings; the wake lease
   with a stale holder; pause. Run under a formal grant.

| Test | Case |
|---|---|
| T052, T067 | Request to the parent and to a peer; another user's session refused. |
| T055 | Wrong responder, unknown request: `REQUEST_NOT_FOUND`, nothing written, deadline unchanged. |
| T056, T057, T058 | Duplicate delivery; identical repeat; conflicting second result, first immutable. |
| T059 | Invalid response, bound and kind errors: the request stays pending. |
| T061 | A decision before the deadline, committed after it: the response wins. |
| T062 | Responder deleted, revoked or ended before delivery, while waiting, and during a call. |
| T063 | The delivery retried at each crash boundary. |
| T028, T042, T065, T066, T068 | Pause, frozen recipient, parent waiting for a child, request cycle, caller cancel. |
| T088 | A human bearer with a session id, a custom event, a queued message: no response. |
| New | Just before, at and after the deadline (microseconds); lock waits across expiry; late call while pending; accepted repeat after timeout and after cancel. |
| New | Response versus deletion in both orders; deletion with the delivery child ended; repeated deletion; cancel, recover and stop after a response. |
| New | Wake: crash after commit before dispatch; lost enqueue acknowledgement; duplicate wakes; paused and delayed controller; moot and abandoned rows. |
| New | Wake lease: a reclaim between enqueue and completion by two workers; the old holder's failure after the new holder's success; a duplicate abandonment attempt (one event); an unknown or failed lifecycle read (not moot); the requester deleted after the response; a replay after the wake settled (no new or changed wake). |
| New | Operation identity: A/X, B/X, B/Y; repeated expired and closed operations with changed content; response versus decline identity; the 50th binding; a new operation at the limit; a known replay at the limit; the winner unchanged in every case. |
| New | Authorization: wrong actor, revoked credential, deleted responder and lost authority, each with a new and with the winner's old operation id: no receipt, no diagnostic, no binding, no event. |
| New | JSON: `null`, `false`, root and nested arrays, NUL, lone high and low surrogates, paired surrogates and special keys (`__proto__`, `constructor`, empty) through validation, storage, hashing and replay. |
| New | Orphan and corrupt combinations fail explicitly. |
| New | Versions: retained 1.8.0 histories before and after a continue-as-new boundary replay with unchanged schedules, arguments and target 1.8.0; new runs start at 1.9.0; legacy activity names keep their input and output meaning. |
| New | Routing: an older worker (three tags, the same names registered) beside a capable one; request delivery, delivery failure and 1.9.0 activities run only on the capable one; with only the older worker they wait, nothing is consumed, and they complete when a capable worker starts; old IR 1 to 6 sends complete unchanged; a responder below Vr or with an unreadable version fails `unsupported_contract`; the setting turned off stops new entries and leaves pending requests working. |

## 12. Open items

- The dispatch loop's interval, batch, lease length and attempt cap, and
  the 50-binding limit, are proposals; the review may change them without
  changing the contract.
- Tag budget: the request tag is the fourth of five. Design A must reuse
  it or take the last one; Vr is coordinated with design A's recipient
  version.
- Retention of request records (requests, responses, bindings, wakes) is
  part of the shared retention item; this design deletes nothing.
- Workflow receive-and-respond, the cancellation notice and the
  REST/SDK/MCP entry points remain outstanding parts of the full feature.
