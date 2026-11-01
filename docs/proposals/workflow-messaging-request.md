# Workflow messaging: request and reply (design)

Status: design checkpoint for review. No code is changed by this document.
Base: `waldemort/workflow-v2-single-writer` at `008080cd`; the source is as at
`9fcbf377`.

A messaging `request` state sends one typed request to a session and waits
for one typed response. It ends with exactly one result: the response, a
declared refusal, its deadline, the run's end or a delivery failure. This
document fixes the state's shape, the records, the single decision that ends
it, the responder's tool and the order of the work. It builds on the send
states (`S1`, `S2`) and leaves the recipient's durable intake to design A.

## 1. Requirements in scope

| Source | Requirement |
|---|---|
| R07; design 03 "Messaging modes" | `request`: as send, plus a response schema and a deadline. Success is an accepted typed response; chat prose is not a response. |
| Design 03 | Request ids are stable across delivery retries, distinct across loop and rework occurrences, and keep the schema digest, payload hash, destination and deadline. A same response hash is idempotent; a different second reply conflicts. Status moves `pending -> responded \| declined \| timed_out \| cancelled` atomically. Reply acceptance and its wake intent share one transaction. Losing or late responses are audited, cannot revive the call and do not overwrite its selected transition. Caller cancellation does not cancel or delete the peer. |
| R27; hard invariants 5, 8, 9 | Every winner is idempotently identified. A pending operation keeps its resolved recipient, arguments and deadline. One terminal compare-and-swap resolves reply against timeout or cancellation; late events never revive a closed occurrence. Delivery is at least once; stable ids and durable acceptance suppress duplicates. |
| D03 | Pause freezes progression, not deadlines. |
| Design 04 | `respond_session_request(request id, JSON response or declared refusal, operation id)`: host-bound responder, request schema and deadline validation, idempotent terminal result. REST `/session-requests/{request}/responses`. |
| Test plan | T028, T042, T052, T055 to T059, T061 to T063, T065 to T068, T088. |

## 2. The state

```yaml
approve_publication:
  type: messaging
  mode: request
  recipient: {parent: true}          # or a session id, as a send state
  contract: PublicationApproval@1
  input: "${input}"                  # the request payload (optional, as a send state)
  correlate: {candidate: "${input.head}"}   # optional, as a send state
  timeoutSeconds: 3600               # required, 1 to 86,400
  transition:
    next: {responded: verify_approval, declined: blocked, timed_out: blocked, failure: failed}

contracts:
  PublicationApproval@1:
    schema: {$ref: "#/schemas/PublicationRequest"}
    response: {schema: {$ref: "#/schemas/PublicationDecision"}}
```

- A request state's contract must declare `response`. A send or receive
  state may not use a contract that declares one (a request is not a
  one-way message).
- Outcomes. Business: `responded` (output: the response) and `declined`
  (output: `{reason}`). Runtime errors: `timed_out`, `cancelled`,
  `unavailable`, `forbidden`, `delivery_failed`, `unsupported_contract`,
  `invalid_input`, routed by code or by `failure`.
- `timeoutSeconds` is required: every request ends, and a request cycle
  (A asks B, B asks A) ends at the first deadline (T066).
- IR version 7, written only for a workflow with a request state; versions
  1 to 6 keep their meaning.
- First slice: recipients are agent sessions (the parent, or a named
  session of the same user, decided as a send's recipient). A request to a
  workflow fails at its admission with `unsupported_contract`: a workflow
  has no way to answer yet.

## 3. Records

One migration (the next free number: 0093 if this lands before design A's
storage commit, otherwise 0094):

- `workflow_outbox.mode` admits `request`. A request's message is delivered
  by the send's machinery (attempts, receipt, intake mode under design A).
- `workflow_requests`, one row per request, keyed by the exchange id
  (foreign key to the outbox): `status` (`pending`, `responded`,
  `declined`, `timed_out`, `cancelled`, `failed`), `deadline_at`,
  `contract`, `request_sha256` (the payload hash), `response_schema_sha256`,
  `responder_session_id` (the recipient frozen at entry), `response`
  (canonical text), `response_sha256`, `operation_id`, `receipt`,
  `decided_at`, `late_responses`.

The request id is the exchange id, the node execution id: stable across
delivery attempts, and distinct for each occurrence of the state.

## 4. One decision ends the request

The node's compare-and-swap from `pending` is the only decision. The request
row's status changes in the same transaction, to the matching value.

| Event | Transaction | Result |
|---|---|---|
| Entry | `S` `enterNode`, under the session locks: recipient decided as a send's; payload checked; `deadline_at` from the accepted-entry clock reading (W1); request row `pending`; outbox intent. | A recipient that may not receive fails the state at entry, as a send. |
| Delivery recorded | `S` `recordDelivery`: the outbox message delivered with its receipt. The state stays pending. | `sent` does not end a request. |
| Delivery failed | `S` `failDelivery`, `beginDelivery`'s refusals, the collection of an ended send orchestration: the state fails (`unavailable`, `forbidden`, `delivery_failed`) if still pending; request `failed`. | A response already accepted wins: the CAS finds the state decided. |
| Response | `respond_session_request`, under `lockInputSessions` (the requesting workflow and the responder): the caller is the frozen responder; the request is pending; the store's clock reading is before `deadline_at`; the response matches the contract's response schema (checked before the transaction against the pinned IR). Node `pending -> responded` (or `declined`) with the response as output, winner `response`; request row decided with the receipt; projection events; then a wake hint after the commit (the controller's backstop collects the result in any case). | A response committed before the deadline wins even when the controller collects it late (T061). |
| Deadline | The controller's elapse for the request node, as a receive's wait: CAS `pending -> timed_out` (runtime error, winner `controller`) at or after `deadline_at`, by the store's clock; request `timed_out`. | A response at or after the deadline is late, even if the elapse has not run. |
| Run end, deletion | `S` `finishRun` and the deletion trigger end the pending state (`cancelled`); `finishRun` decides the run's pending request rows (`cancelled`) in its transaction. | The peer session is not cancelled or deleted (T068). |
| Late or losing response | `respond_session_request` finds the request decided: `REQUEST_CLOSED` with the decided status; one audit event on the requesting workflow (`workflow.request_late_response`) and the row's `late_responses` count. | Never changes the state. |

Idempotency of a response:

- the same operation id with the same response returns the stored receipt;
- the same operation id with another response is `OPERATION_CONFLICT`;
- a different response after one was accepted is `RESPONSE_CONFLICT`, and
  the first response stays;
- the same response under a new operation id after acceptance returns the
  stored receipt (T057).

Pause: a paused run keeps its request's deadline, and a response accepted
while it is paused decides the state; the run takes the result when it is
resumed (T028).

## 5. Invariants

- **Q1 one winner:** a request state is decided once, by exactly one of the
  events above, and the request row's status matches it.
- **Q2 deadline:** a response is accepted only at a store clock reading
  before `deadline_at`; a state decided `timed_out` was elapsed at or after
  it.
- **Q3 late responses:** a response that finds the state decided changes
  nothing but the audit event and the count.
- **Q4 responder:** only the recipient frozen at entry can respond (host
  context, not a request field).
- **Q5 identity:** the request id is stable for the occurrence; the stored
  response is immutable; same-hash repeats are idempotent and a different
  response conflicts.
- **Q6 peer untouched:** no decision of the requesting workflow cancels,
  deletes or messages the peer session, other than the request's own
  delivery.

## 6. The responder's surface

- A new tool for agent sessions, `respond_session_request`, with
  `request_id`, exactly one of `response` (JSON) or `decline` (`{reason}`),
  and `operation_id`. The caller is the tool's host session. Its result is
  the receipt or a typed error: `REQUEST_NOT_FOUND`, `NOT_RESPONDER`,
  `REQUEST_CLOSED`, `RESPONSE_INVALID` (field errors; the request stays
  pending, T059), `RESPONSE_CONFLICT`, `OPERATION_CONFLICT`.
- The request prompt (as a send's, one JSON line that parses to the exact
  message) adds the request id, the deadline, the response schema and the
  instruction that only `respond_session_request` answers; prose does not.
- It is separate from `send_session_message` and `reply_session_message`,
  which stay conversational text (design 04).
- REST and MCP use the same service function, with the same caller binding,
  in the protocol-parity slice. A human bearer token answers only through an
  authorized session, never by naming one (T088).

## 7. Durable intake

The request's prompt reaches an agent session as a send's message does, at
least once. Until design A is implemented, a duplicate prompt may reach the
recipient after more than 20 other messages, and the agent may answer twice:
the idempotency rules keep the first response, and the second is either the
same (a repeat) or a conflict. Design A applies to request prompts unchanged
(the same envelope and the same claim).

## 8. Failure matrix

| # | Failure | Result |
|---|---|---|
| 1 | The response commits, the reply to the tool is lost, the agent repeats | Same operation id: the stored receipt. |
| 2 | Response and deadline at nearly the same time | The store's clock reading inside each transaction decides; the CAS keeps the first. |
| 3 | Response before the delivery is recorded | Accepted (the request row exists from entry); the delivery record does not change the decided state. |
| 4 | Response after the run's cancel | `REQUEST_CLOSED` (cancelled), audited. |
| 5 | Delivery fails after the response was accepted | The failure's CAS finds the state decided; the request stays `responded`. |
| 6 | The responder session is deleted | Its tool calls end; the deadline decides the request. |
| 7 | The requesting workflow is deleted | The trigger ends the state; the request row is decided at the next attempt of its send or stays pending (as a send's message; stated limit). |
| 8 | Duplicate prompt, agent answers twice | Repeat or conflict; the first response stays. |
| 9 | Worker crash between the response's commit and the wake | The controller's backstop collects the completed state. |
| 10 | Store outage during the response | The tool returns the error; the agent may retry with the same operation id. |

## 9. Plan and coverage

Commits, each with DEV tests and independent review:

1. Compiler and IR 7: the request state, contract responses, routes and
   refusals (compile tests).
2. Records and store: the migration, the request row at entry, the response
   transaction, the deadline elapse, the run end's decision, late responses
   (store and native tests).
3. Runtime and tool: delivery of the request prompt, the controller's
   deadline and collection, `respond_session_request`, the read view (native
   tests with an agent test double that calls the tool).
4. Formal model `WorkflowV2Request.tla`: the single CAS among response,
   deadline, run end and delivery failure; late and duplicate responses;
   pause. Run under a formal grant.

| Test | Case |
|---|---|
| T052 | Request to the parent and to a peer: the same authorization as a send. |
| T055 | Wrong responder, unknown request: refused, deadline unchanged. |
| T056 | Duplicate request delivery: one request, repeated receipts. |
| T057 | Identical duplicate reply: one continuation. |
| T058 | Conflicting second reply: conflict, the first response immutable. |
| T059 | Invalid response: field errors, the request stays pending. |
| Q2 (new) | A response just before and just after the deadline, compared at the store's clock. |
| T061 | Response committed before expiry, controller late: the response wins. |
| T062 | Peer revoked or deleted, or a workflow recipient: a declared typed failure, no retargeting. |
| T063 | The request's delivery retried at each crash boundary: one request id, bounded attempts, no hidden drop. |
| T067 | Another user's session as the recipient: denied at the admission. |
| T028 | Response while paused: retained; no progression until resume. |
| T042 | The peer id changes in the KV while a request is outstanding: the frozen recipient stays. |
| T065 | Parent waits for a child while the child requests the parent: the request wakes the parent. |
| T066 | A request cycle ends at the first deadline. |
| T068 | Caller cancels after delivery: caller terminal, peer not deleted, a late reply stale. |
| T088 | No custom event or field can inject a reply. |

## 10. Questions for review

1. Route and field names: design 09's examples use `timeout` as a route and
   `request:` as the payload field; this proposes `timed_out` (the runtime
   error code that routes already use) and `input` (as send and receive).
2. Whether a send or receive state may use a contract that declares a
   response (proposed: no).
3. Requests to workflows: unsupported in the first slice (proposed), or a
   receive-and-respond pair now.
4. A bounded cancellation notice to the peer when the caller cancels:
   proposed for a later slice.
5. The decline envelope: a fixed `{reason}` (proposed) or a declared
   decline schema per contract.
