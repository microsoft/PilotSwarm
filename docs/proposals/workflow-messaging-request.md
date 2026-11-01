# Workflow messaging: request and reply (design, revision 2)

Status: revised design checkpoint for review. Docs only; no code changes.
It revises `72f1e701` after the parent review
(`wfv2-request-design-72f1e701-parent-review.md`, SHA-256 `a74d237f…`) and
the decisions in `pse/wfv2/decisions/request-reply-shape`. Source base:
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

| Finding | Resolution | Section |
|---|---|---|
| REQUEST-DESIGN-01 (P1): deletion left a request pending after its node was cancelled | Decision B: the request's status is derived from its node, with no second mutable status. A total mapping covers every node result; any other combination fails as store corruption. The request row is immutable identity linked to the node. The response record is written only by the transaction that wins the node's compare-and-swap. The deletion trigger needs no change; rows and receipts survive a soft delete. Terminal-producer table and ordering oracles. | 3, 4.1, 4.2 |
| REQUEST-DESIGN-02 (P1): no durable wake intent | A `workflow_response_wakes` row, keyed by the exchange id, is committed with the response record, the node's result and the events. A post-commit attempt (optimization) and a bounded dispatch loop in each worker (lease, retries, lifecycle checks) deliver it. The controller's backstop stays as additional recovery. | 5 |
| REQUEST-DESIGN-03 (P1): deadline rule ambiguous | One `clock_timestamp()` reading after all deciding locks and guards; exact SQL comparison `reading < deadline_at`; equality is late. A decision made before the deadline may commit after it. A late call while the request is pending returns `REQUEST_EXPIRED` and accepts nothing; only the controller's elapse decides `timed_out`. An accepted identical retry returns its stored receipt. | 4.3 |
| REQUEST-DESIGN-04 (P1): responder identity | An actor binding for each entry point. The first increment exposes only the in-process tool; REST, SDK and MCP only with a session-scoped invocation credential (actor, audience, request scope, expiry, revocation). A human bearer never answers as an agent. Canonical lock order and authority recheck; wrong actors learn and write nothing; receipt replay rule; a response before the delivery record is valid. | 6 |
| REQUEST-DESIGN-05 (P2): idempotency and audit | A precedence order and a complete outcome table. Operation identity and receipts persist. Audit rows are deduplicated per (request, operation) and capped. Bounds for results, schemas and the prompt. Canonical JSON (`null`, `false`, arrays, NUL kept; lone surrogates refused). Field presence selects the result's kind; its identity hashes kind and value. | 7 |
| REQUEST-DESIGN-06 (P1): compatibility | IR 7; controller 1.9.0 with 1.8.0 kept replayable (not fenced); request-aware collection; a deployment capability and opt-in publication; recipient capability checked at entry and at delivery; rollback rule. Design A is a prerequisite for one logical request per recipient beyond the 20-id window. | 8 |
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
  the response capability (section 8). A workflow recipient fails at
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
- `workflow_request_attempts`: mutable audit metadata, separate from the
  request's description. Key (`exchange_id`, `operation_id`); columns
  `result_sha256`, `code`, `first_at`, `last_at`, `count`. At most 50 rows
  per request; past that, only a capped counter row grows.
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
| A response (`respond_session_request`) | Session locks (`lockInputSessions`, requester and responder, ascending id), then run and node; one reading | `responded` or `declined`, winner `response` | inserted | inserted |
| The deadline (controller elapse, request-aware) | Requester's session lock, then node; one reading at or after `deadline_at` | `timed_out`, winner `controller` | none | none (the controller decides itself) |
| Responder observation (controller, 4.4) | Session locks as a response, then node | `unavailable` or `forbidden`, winner `controller` | none | none |
| Delivery failure (`failDelivery`, `beginDelivery`'s refusals, the collection of an ended send orchestration) | As a send's (`store.ts` 2277, 2399) | `unavailable`, `forbidden` or `delivery_failed` | none | none (the send's wake and collection) |
| The run's end (`finishRun`: cancel, recover, a failed or completed run, a later stop) | Requester's session lock, run, nodes (`store.ts` 2440) | `cancelled`, winner `cancel` or `controller` | none | none |
| Deletion of the requesting workflow (trigger, `migrations/workflow-v2-0087.ts` 58) | The soft delete's own transaction | `cancelled`, winner `delete` | none | none |
| Admission refusal (`enterNode`) | At entry | an immediate result; the node is never pending | none | none |

Because the status is derived, no producer writes a second status, and the
deletion trigger stays as it is.

### 4.2 Ordering oracles

- Response, then deletion: the response's transaction holds the
  requester's session row (`FOR SHARE`); the soft delete updates that row
  and waits. The node is `responded`; the trigger skips completed nodes.
- Deletion, then response: the node is `cancelled` (winner `delete`); the
  response finds it decided: `REQUEST_CLOSED` (status `cancelled`). If the
  responder is the deleted session's peer, the call still authenticates
  first (section 6).
- Deletion with the send child ended, with the request delivered but
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
- An authenticated call whose reading is at or after `deadline_at` while
  the node is still pending returns `REQUEST_EXPIRED`. It accepts nothing
  and decides nothing: the controller's elapse, on its durable timer, is
  the only producer of `timed_out`. The call is audited once per
  operation.
- A repeat of an accepted response with the same operation id and the same
  result returns the stored receipt after the deadline too; the decision
  window is not reopened.

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
  one response can win). Columns: `run_id`, `controller_instance_id`,
  `created_at`, `next_attempt_at`, `lease_until`, `attempts`,
  `dispatched_at`, `outcome` (`dispatched`, `moot` or `abandoned`),
  `last_error`.
- The response transaction inserts it with the response record, the
  node's result and the events. No response commits without it.
- Dispatch is at least once; the controller treats a wake as a hint and
  collects idempotently, so a duplicate is harmless.
  - After the commit, the responding worker tries at once: it takes the
    row's lease, enqueues `{type: "workflow-wake", runId, reason:
    "response"}` on the controller's command queue, and marks it
    dispatched. This is an optimization only.
  - Each worker that registers workflow v2 runs a bounded dispatch loop
    (every 2 s, at most 20 rows a pass): it leases due rows with
    `FOR UPDATE SKIP LOCKED`, commits the lease, enqueues and marks them.
    A failure backs off (1 s doubling to 60 s). A run that has ended makes
    a row `moot`. After 100 attempts a row is `abandoned` with one
    `workflow.response_wake_abandoned` event. The loop stops with its
    worker.
  - The controller's backstop still collects the completed node: it is
    additional recovery, not the wake contract.
- Dispatched, moot and abandoned rows are removed after 24 hours.
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
- The transaction locks the requester's and the responder's session rows
  in ascending session id, before run and node locks, and decides on what
  it reads after them: the actor must be the frozen responder, its row
  live, and the authority rule must still allow it. A revoked or deleted
  responder is refused for a new decision.
- Unknown request, wrong actor, or a revoked actor's new response: all
  return the same `REQUEST_NOT_FOUND`, write no audit row or event, and
  reveal no receipt.
- Receipt replay: the actor that won may repeat its operation and get the
  stored receipt, also after the request was later cancelled by its
  requester's run. The replay re-authenticates the actor; it does not
  re-decide authority for the original decision.
- A response may commit before the delivery is recorded: the request row
  exists from entry, and the delivery record later marks only the message
  delivered.

## 7. Idempotency, audit and bounds

Order of checks in a response call:

1. Authenticate the actor (section 6). Failure: `REQUEST_NOT_FOUND`,
   nothing written.
2. Parse the call: exactly one of `response` or `decline` is present
   (presence, not truthiness; `response: null` is a response whose value
   is `null`). The value must be canonical JSON within the bounds below;
   a lone surrogate is refused. A response must match the contract's
   response schema, a decline the decline schema. Failure:
   `RESPONSE_INVALID` with field errors; the request stays pending.
3. Take the locks and recheck authority (section 6).
4. Decide by the request's state, as below.

The result identity is `sha256(canonicalJson({kind, value}))`: a response
and a decline never collide.

| Request state | Same operation, same result | Same operation, other result | New operation, same result | New operation, other result |
|---|---|---|---|---|
| `pending`, reading before the deadline | (first call) decides | (first call) decides | decides | decides |
| `pending`, reading at or after the deadline | `REQUEST_EXPIRED` | `REQUEST_EXPIRED` | `REQUEST_EXPIRED` | `REQUEST_EXPIRED` |
| `responded` or `declined` | the stored receipt | `OPERATION_CONFLICT` | the stored receipt (T057) | `RESPONSE_CONFLICT`; the first stays (T058) |
| `timed_out`, `cancelled`, `failed` | `REQUEST_CLOSED` with the status | `REQUEST_CLOSED` | `REQUEST_CLOSED` | `REQUEST_CLOSED` |

- Every losing call by the authenticated responder is audited once per
  (request, operation): a repeat of the same losing operation updates
  `last_at` and `count` only. Past 50 operations a request keeps only a
  capped counter. Wrong actors are not audited (step 1).
- Bounds: a response at most 16 KiB of canonical JSON (the send payload
  bound); a decline reason a string of 1 to 2,000 characters; the decline
  schema is strict: `{type: object, additionalProperties: false,
  required: [reason], properties: {reason: {type: string, minLength: 1,
  maxLength: 2000}}}`. The request's prompt (payload, response schema and
  instructions) is at most 32 KiB, within the session queue's item cap.
  A response schema larger than 8 KiB is refused at compile time.
- `null`, `false`, empty arrays and NUL characters are kept exactly
  (canonical text in TEXT columns, not jsonb).
- No result carries authority: a response that says it approves is data;
  any approval is verified separately (design 09).

## 8. Compatibility, capability and rollout

- **Workflow controller.** Request states need controller 1.9.0
  (request-aware collection, deadline and observation). 1.8.0 stays
  registered and replays its own histories; it is not fenced. A 1.8.0
  run moves to 1.9.0 only at its continue-as-new (`runtime.ts` 555), and
  1.9.0 accepts 1.8.0's state (no request nodes: IR 6 or older). No new
  fail-fast fence replaces compatibility; the fence of 1.0 to 1.7 stays a
  stated limit (`runtime.ts` 87-105).
- **Send orchestration.** A request's delivery uses `workflow-v2-send`
  1.0.0 unchanged; only its activities are mode-aware. If its yields must
  change, it gets a new version and 1.0.0 stays.
- **Request-aware collection.** The collect activity today treats every
  non-receive messaging node as a send (`runtime.ts` 1522-1539). For a
  request node: an ended send orchestration with the message delivered is
  awaiting its response, not a failure; with the message still pending,
  `failDelivery` decides as for a send; with the message failed, the node
  already failed in that transaction.
- **Recipient capability.** The response tool is a framework tool that
  request-capable workers give every agent session. At entry and again at
  delivery, the recipient must be an agent session, its effective tool
  policy must not exclude the tool, and the deployment capability must be
  on. Otherwise the state fails with `unsupported_contract` and the
  missing capability; no prompt asks for a tool the recipient lacks.
- **Deployment capability and rollout.** A deployment setting turns on
  request states after every worker runs a request-capable build; the
  bootstrap advertises it. Publication of an IR 7 definition is refused
  while it is off. Rollback: workers that serve request runs stay until
  those runs end or are recovered; an older build refuses IR 7 and
  controller 1.9.0 explicitly and never reinterprets them.
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
  changes nothing but its own audit row.
- **Q4 responder:** only the frozen responder, authenticated by its host
  or a scoped credential and still allowed, can decide.
- **Q5 identity:** the request id is stable for the occurrence; the
  response record and receipt are immutable; repeats are idempotent and a
  different result conflicts.
- **Q6 peer untouched:** no decision of the requesting workflow changes
  the peer session's lifecycle; a supported bounded notice may be added
  later.
- **Q7 wake:** every committed response has its wake intent in the same
  transaction, and each intent is dispatched, found moot, or abandoned
  with an event while the backstop still collects the result.

## 10. Failure matrix

| # | Failure | Result |
|---|---|---|
| 1 | The response commits; the tool's reply is lost; the agent repeats | Same operation: the stored receipt. |
| 2 | Response and deadline close together | Each transaction's one reading decides under the session lock; the first compare-and-swap stays. |
| 3 | Response before the delivery record | Accepted; the record marks only the message. |
| 4 | Response after the run's cancel or deletion | `REQUEST_CLOSED` (`cancelled`), audited. |
| 5 | Delivery fails after a response won | The failure's compare-and-swap finds the node decided. |
| 6 | The responder is deleted or revoked while the request waits | Observed (4.4): `unavailable` or `forbidden`; or `timed_out` within the last backstop period. |
| 7 | The requesting workflow is deleted | The trigger cancels the node in the delete's transaction; the status is `cancelled` at once. |
| 8 | A duplicate prompt; the agent answers twice | A repeat or a conflict; the first response stays. |
| 9 | Crash after the response commit, before dispatch | The dispatch loop delivers the wake; the backstop collects in any case. |
| 10 | The wake enqueue fails repeatedly | Backoff, then `abandoned` with an event; the backstop collects. |
| 11 | Store outage during a response call | The tool returns the error; the agent may repeat with the same operation id. |
| 12 | Corrupt or orphaned records | `WORKFLOW_STORE_CORRUPT`, never a default status. |

## 11. Plan and coverage

Commits, each with DEV tests and independent review:

1. Compiler and IR 7: the request state, response contracts, the
   diagnostics for obsolete spellings, the frozen timeout binding (compile
   tests).
2. Records and store: the migration, the request at entry, the response
   transaction with its record and wake intent, the derived status, the
   request-aware elapse, the observation, the audit table (store and
   native tests).
3. Runtime and tool: delivery, controller 1.9.0 (1.8.0 kept), the
   dispatch loop, `respond_session_request`, the capability checks, the
   read view (native tests with an agent test double that calls the tool).
4. Formal model `WorkflowV2Request.tla`: the single compare-and-swap among
   response, deadline, observation, run end, deletion and delivery
   failure; late and duplicate calls; the wake intent; pause. Run under a
   formal grant.

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
| New | Response versus deletion in both orders; deletion with the send child ended; repeated deletion; cancel, recover and stop after a response. |
| New | Wake: crash after commit before dispatch; lost enqueue acknowledgement; duplicate wakes; paused and delayed controller; moot and abandoned rows. |
| New | Orphan and corrupt combinations fail explicitly. |
| New | Mixed workers, controller 1.8.0 replay, populated outbox rows, rollback refusal of IR 7. |

## 12. Open items

- The dispatch loop's interval and the audit caps are proposals; the
  review may change them without changing the contract.
- Workflow receive-and-respond, the cancellation notice and the
  REST/SDK/MCP entry points remain outstanding parts of the full feature.
