# Data model, stored functions and migrations

This file answers what persists after a Workflow worker stops. For example, a request's accepted response, operation receipt and wake intent commit together, so a lost wake does not erase the answer.

All source citations refer to `4fa702dc`. In the tables below, **M88** means `packages/sdk/src/migrations/workflow-0088.ts`; **M89** means `packages/sdk/src/migrations/workflow-session-names-0089.ts`. Line numbers identify the actual SQL, not an earlier proposal.

## Persistence boundary

Workflow data lives in the configured CMS schema. `WorkflowStore` and `SessionDefinitionStore` use a node-postgres pool and explicit transactions. Session projections call the existing `cms_record_events`, `cms_update_session` and `cms_soft_delete_session` functions. Most Workflow inserts and updates are direct parameterized SQL, not calls to a separate stored procedure. See `packages/sdk/src/workflow/store.ts:1815-1851`, `:2373-2415`, `:2708-2737`, and `packages/sdk/src/workflow/session-definition-store.ts:249-276`.

Author-supplied JSON is canonical **TEXT**, not JSONB. This preserves escaped JSON strings that PostgreSQL JSONB rejects, including NUL and lone surrogates. The SDK parses and checks it on reads. Session event/config projections still use the CMS's own JSON conventions. See M88 `:20-24` and `packages/sdk/src/workflow/store.ts:1511-1654`.

The common lock order is owner session, owner definition, Workflow session, execution definition, run, then node. A Workflow's own parent is locked before it; unrelated session pairs use ascending IDs. The Workflow session lock serializes run/node writers with deletion triggers. Transactions use READ COMMITTED so a waiter sees decisions committed before it acquires the lock. See `packages/sdk/src/workflow/store.ts:1857-1937`, `:3439-3461`, and `packages/sdk/src/workflow/session-definition-store.ts:260-276`.

## Tables

Names below are the final names after migration 0089.

| Table | Key columns | Important indexes, constraints and lifecycle |
|---|---|---|
| `sessions` (existing) | `session_id`, `parent_session_id`, `session_kind`, `workflow_ref`, `state`, `deleted_at`, `creation_config`, `service_kind` | M88 adds kind (`agent`/`workflow`) and `workflow_ref`; existing rows default to agent. Parent index is built concurrently. A test bench uses existing service columns. M88 `:42-57`, `:856`; `packages/sdk/src/workflow/service.ts:800-826`. |
| `session_workflow_definitions` | `definition_id`; owner, name, current revision, source/creator, deletion fields, package lock | Unique live `(owner_session_id, name)`; owner/time index. Deleted definitions remain tombstones. M88 `:655-672`; renamed by M89 `:24-34`. |
| `session_workflow_revisions` | `(definition_id, revision)`; YAML/hash, valid/diagnostics, IR/hash, based-on revision, actor, imported/package/card metadata | Foreign key to definition; positive revision; valid iff IR and hash exist. Saved revision immutability is an application rule, not a table UPDATE-blocking trigger. M88 `:674-696`. |
| `session_workflow_operations` | `(owner_session_id, operation_id)`; kind, request hash, receipt, time | Owner-scoped operation identity. Repeated calls must match the first request. M88 `:699-707`. |
| `session_workflow_seen` | `(owner_session_id, definition_id)`; revision, updated time | Records the newest revision the owner session has seen. M88 `:710-716`. |
| `session_workflow_notes` | `note_id` sequence; owner, definition, revision, text, created/consumed times | Partial index on unconsumed notes by owner and note ID. Successful turns consume their read notes; a save does not itself wake the owner. M88 `:720-729`; `packages/sdk/src/session-proxy.ts:5720-5725`. |
| `workflow_definitions` | `workflow_session_id`; parent, API/semantic version, state, current/published revision, hashes, notification flag, agent pins, source definition/revision | One execution copy per Workflow session. Published state requires revision and both hashes. Indexes by parent and source definition/revision. M88 `:105-132`; M89 `:63-77`. |
| `workflow_revisions` | `(workflow_session_id, revision)`; YAML/hash, diagnostics, name/version, IR/hash, actor | Foreign key to execution definition; positive revision; valid iff IR and hash exist. M88 `:134-149`. |
| `workflow_operations` | `(workflow_session_id, operation_id)`; kind, request hash, receipt | No cascading foreign key to erase operation identity. Commands and recovery use it. M88 `:151-159`. |
| `workflow_runs` | `run_id`; Workflow/revision, hashes, inputs, unique controller ID/version, mode/status, output/error, start operation, current KV/revision, stop/deadline/test/model fields | Foreign key to exact execution revision. Partial unique `workflow_runs_one_live` applies to **all** live runs, not just active ones. Terminal status iff `finished_at` exists. Paused status iff `paused_from` exists. Test fields obey mode constraints. M88 `:163-221`. |
| `workflow_kv_revisions` | `(run_id, revision)`; KV text, operation, created time | Foreign key to run; positive revision. Each visit reads its pinned map, not the current map. M88 `:225-232`. |
| `workflow_node_executions` | `node_execution_id`; run, scope, node, ordinal/type, predecessor/route, input/hash, state, outcome/kind/output/error/winner, effect attempts, times, KV pin, receive contract | Unique `(run_id, scope_id, node_id, ordinal)`; predecessor foreign key; run/time index. Completed requires outcome, kind, winner and completion time. Business result has output/no error; runtime error has error/no output. M88 `:234-270`. |
| `workflow_inbox` | `message_id`, unique sequence; Workflow/run/sender/operation, request hash, contract/correlation/payload, acceptance/expiry, consumption/receipt | Unique `(workflow_session_id, sender_session_id, operation_id)`; pending index by run/contract/sequence; unique non-null `consumed_by` enforces one message per receive. Expiry must follow acceptance. M88 `:272-298`. |
| `workflow_outbox` | `exchange_id`, unique node execution; run, recipient, send/request mode, payload/hash, state/attempts, receipt/error, recipient/intake mode/token/outcome | One per send/request occurrence. Pending iff no decision time; delivered iff receipt exists. First counted attempt fixes intake mode. M88 `:300-359`. |
| `workflow_requests` | `exchange_id`; requester/run, frozen responder, contract/hash, response schema, deadline/time | Foreign keys to outbox, node and run. Immutable identity; status is derived from the node, not stored in a separate status column. M88 `:361-373`; `packages/sdk/src/workflow/store.ts:1554-1579`. |
| `workflow_request_responses` | `exchange_id`; response/decline kind, value/hash, operation/actor, decision time, receipt | At most one accepted response per request; immutable. M88 `:375-385`. |
| `workflow_request_operations` | `(exchange_id, operation_id)`; actor/result hash, outcome/status, first/last time, count | Outcomes: decided, same, expired, closed, conflict. Only repeat counters can change. M88 `:387-402`, `:430-438`. |
| `workflow_response_wakes` | `exchange_id`; run/controller, state, lease token/expiry, attempts, next attempt, settled time/error | One per accepted response. States: pending, leased, dispatched, moot, abandoned. Lease and terminal-time constraints; due index; a settled wake is immutable. M88 `:404-421`, `:439-446`. |
| `workflow_intake_invocations` | `invocation_id`; recipient, canonical members/count, created time | Immutable complete membership, 1-64 items; advisory-lock identity before bind/end/cancel. M88 `:465-486`. |
| `workflow_intake` | `exchange_id`; recipient/source/run, envelope/text hashes, canonical text, claim, state, invocation, processing, cancel flag/counters/times/reason | One row per outbox exchange. Holding can move forward once. Admitted iff invocation/processing/admitted time exist. Identity/text cannot change; cancel and counters never go back. Indexes by recipient and invocation. M88 `:488-564`. |
| `workflow_intake_exposures` | `invocation_id`; recipient, attempt, exposed time | One immutable exposure record per invocation. M88 `:566-582`. |
| `workflow_agent_invocations` | `node_execution_id`; run/Workflow/child/controller session, task/outcomes/schema, deadline, spawn attempts/time, end intent/sent/status | One per visit. `child_session_id` is deliberately **not unique** because a continued child serves multiple visits. Indexes by run and child/time. M88 `:584-609`. |
| `workflow_agent_completions` | `(node_execution_id, operation_id)`; result hash, outcome, problems, receipt, created time | Outcomes: decided, same, invalid, expired, closed, conflict. Receipt exists iff decided. M88 `:611-621`. |
| `workflow_test_interceptions` | `interception_id`, generated sequence; run/node, operation/tool, arguments/hash, response schema/state/kind/value/hash, disposition/actor, virtual and real times | Operations: tool.call, agent, send, request. Tool field iff tool.call. Responded state requires complete response metadata; parent disposition requires actor. Index by run/sequence. M88 `:623-650`. |

There are 23 new Workflow tables: 18 execution-side tables and five owner-definition tables. Relationships to `sessions` are often enforced by SDK locks and triggers, not SQL foreign keys. There is no `ON DELETE CASCADE` that removes the Workflow history when a session is soft-deleted.

## State vocabularies

| Object | Stored vocabulary | Meaning |
|---|---|---|
| Execution definition | `draft`, `published`, `deleted` | Editable low-level copy, frozen copy, permanent tombstone; M88 `:110`. |
| Reusable definition | `deleted_at` plus revision validity; no draft/published enum | Saving and starting are independent; M88 `:655-696`. |
| Run | `admitted`, `running`, `paused`, `completed`, `failed`, `cancelled`, `stopped` | Admitted means CMS accepted the run. Begin changes it to running. Paused remembers admitted/running in `paused_from`. Last four are terminal; M88 `:173-207`. |
| Node execution | `pending`, `completed` | Every terminal node result, including an error or cancellation, is represented by completed plus outcome/kind/winner; M88 `:245-266`. |
| Terminal business outcome | `succeeded`, `blocked`, `failed`, `cancelled` | Not the same as run status: blocked is a completed run with blocked outcome; `packages/sdk/src/workflow/runtime.ts:2374-2376`. |
| CMS session projection | Free-text state, not a new Workflow enum | Live admission uses pending; active uses running; pause uses waiting; stopped projects to cancelled. Ordinary sessions can also show idle, input_required or error. Read the run for exact Workflow state; `packages/sdk/src/cms.ts:127`, `packages/sdk/src/workflow/store.ts:2412`, `:2858`, `packages/sdk/src/workflow/runtime.ts:5220-5222`. |
| Public session status type | `running`, `waiting`, `completed`, `failed`, `cancelled`, `idle`, `input_required` | SDK public status vocabulary; not identical to the CMS's free-text state; `packages/sdk/src/types.ts:1455`. |

## Migrations changed by this candidate

The diff of `CMS_MIGRATIONS` against the main pin adds exactly these two entries. Earlier migrations are not rewritten by this feature. See `packages/sdk/src/cms-migrations.ts:421-422`.

| Number and name | Objects added or changed | Why and application behavior |
|---|---|---|
| **0088 `workflow`** | Session kind/reference; exclusive Workflow session creation function; all 23 Workflow tables; their keys/indexes; request/intake guards; Workflow-deletion and owner-end triggers; parent-session index | Creates the final consolidated schema. Step 1 is transactional DDL. Step 2 drops only a leftover invalid parent index under a 5 s lock timeout. Step 3 builds the parent index concurrently. Steps are repeat-safe after partial application. M88 `:1-35`, `:38-859`. |
| **0089 `workflow_session_names`** | Five `workflow_chat_*` tables become `session_workflow_*`; related constraints/indexes/notes sequence renamed; source-copy columns and source index renamed; owner-end function and trigger renamed/replaced; old stored actor/source/end-status words translated | Removes "chat" as the storage name for an owning or agent session without recreating tables/indexes. Uses catalog checks and old-value predicates; runs with a 5 s lock timeout in the migrator's transaction. M89 `:1-17`, `:24-175`. |

The names numbered 0088-0111 in older design documents are historical pre-collapse migration numbers. They are not extra migrations to apply at this commit.

## Every added or changed stored function

These objects are PostgreSQL **functions**, including trigger functions. Neither migration adds a `CREATE PROCEDURE` object.

| Function | Migration | Purpose |
|---|---|---|
| `cms_create_workflow_session(text,text,jsonb)` | 0088, M88 `:66-101` | Exclusively claim a new Workflow session row. Any existing ID returns false without changing it. Inherit root/group metadata and create the metric-summary row. |
| `workflow_outbox_intake_fence()` | 0088, M88 `:338-355` | Allow intake-mode selection only on the first counted attempt; require a fresh attempt token for each durable attempt. |
| `workflow_request_rows_guard()` | 0088, M88 `:425-451` | Keep requests/responses immutable and undeletable; preserve operation binding identity while allowing repeat counters; preserve wake identity and freeze settled wakes. |
| `workflow_intake_invocation_guard()` | 0088, M88 `:478-482` | Reject updates and deletes of invocation membership. |
| `workflow_intake_guard()` | 0088, M88 `:525-560` | Preserve intake identity/text, forward-only admission/processing, monotone cancel/counters, and write-once timestamps/reason; reject deletion. |
| `workflow_intake_exposure_guard()` | 0088, M88 `:574-578` | Reject exposure updates and deletes. |
| `workflow_on_session_deleted()` | 0088, M88 `:733-757` | On first soft deletion of a Workflow session, tombstone its execution definition, cancel active runs and decide their pending nodes as deletion winners. |
| `workflow_on_chat_ended()` | 0088, M88 `:761-811` | Original owner-session end/delete cascade. 0089 renames it rather than leaving a second active implementation. |
| `workflow_on_owner_session_ended()` | 0089, M89 `:79-141` | Renamed/replaced owner-end function. Uses final table names and final actor/message wording; preserves the lock order and cascade. Drops an obsolete old-name function if present. |

The existing `cms_record_events`, `cms_update_session` and `cms_soft_delete_session` are reused, not added or replaced here (`packages/sdk/src/workflow/store.ts:1848-1850`). Owner assignment and service marking remain in the existing catalog transaction.

## Every added or renamed trigger

| Trigger | Table / event | Function and effect |
|---|---|---|
| `workflow_outbox_intake_fence` | outbox, BEFORE UPDATE | Intake attempt/mode guard above; M88 `:357-359`. |
| `workflow_requests_guard` | requests, BEFORE UPDATE OR DELETE | `workflow_request_rows_guard`; M88 `:453-455`. |
| `workflow_request_responses_guard` | responses, BEFORE UPDATE OR DELETE | Same guard; M88 `:456-458`. |
| `workflow_request_operations_guard` | request operations, BEFORE UPDATE OR DELETE | Same guard, counters-only update exception; M88 `:459-461`. |
| `workflow_response_wakes_guard` | wakes, BEFORE UPDATE OR DELETE | Same guard, unsettled lease transitions allowed; M88 `:462-464`. |
| `workflow_intake_invocations_guard` | intake invocations, BEFORE UPDATE OR DELETE | Invocation immutability; M88 `:484-486`. |
| `workflow_intake_guard` | intake, BEFORE UPDATE OR DELETE | Forward-only intake guard; M88 `:562-564`. |
| `workflow_intake_exposures_guard` | exposures, BEFORE UPDATE OR DELETE | Exposure immutability; M88 `:580-582`. |
| `workflow_session_deleted` | sessions, AFTER UPDATE OF deleted_at | `workflow_on_session_deleted`; **keeps this name in 0089**. M88 `:815-820`. |
| `workflow_chat_ended` -> `workflow_owner_session_ended` | sessions, AFTER UPDATE OF state, deleted_at; only non-Workflow owners whose fields changed | Owner-end function above. Renamed in M89 `:144-158`; M88 `:821-829` creates the old name. |

Migration 0089 does **not** rename `workflow_session_deleted` to `workflow_owner_session_ended`. They are distinct triggers. Both remain after 0089.

## Soft-delete and cleanup paths

| Path | CMS transaction | Work after that transaction |
|---|---|---|
| Delete a Workflow session | Set `sessions.deleted_at`. The deletion trigger tombstones its copy and cancels active live/test runs and pending nodes. Already-ended runs keep their result. | Controller observes deletion and ends owned work. Delete adapters can also remove session-scoped facts. |
| Delete an owner session | Mark its reusable definitions deleted; lock its Workflow sessions in ID order; mark them deleted. Each Workflow deletion fires its own trigger. | Existing orchestration/session cleanup can end children and remove external state. |
| Owner completes, cancels or fails | Lock Workflow sessions, then active runs in run-ID order; cancel pending nodes/runs and update affected Workflow session projections. | Controller's next activity observes the end. Normal completion adapters refuse active Workflows before this trigger is needed. |
| Hidden test bench's owner completes | Child listing excludes the bench, so the command cascade does not reach it. The owner-session trigger cancels its active test run and bench session when the owner row becomes completed. The run error is "The session that owns this Workflow ended, so the Workflow was canceled." | The same trigger ends any active Workflow child not already ended by the command cascade. |
| Delete one reusable definition | Refuse while one of its numbered Workflows is active. Tombstone it and end its tests. Keep existing Workflow copies and revision history. | No mutation of a finished Workflow's pinned YAML. |
| Sweeper cleanup | Under the target session lock, recheck system/deleted/changed status and any active Workflow run; then soft-delete descendants and target in one transaction. | Remove scoped facts; delete eligible Duroxide instances. These later stores are not part of the CMS transaction. |
| Prune ended low-level tests | Recheck test mode, terminal state, age and live-record references. Delete interceptions, inbox, nodes, KV revisions and run only when safe. | Duroxide controller history is not deleted by this CMS pruning function. |
| Retire definition-test benches | Keep the newest five ended benches visible; soft-delete older benches. A running test is never displaced by retention. | Rows and run history remain. Retention runs again at test end. |

Evidence: M88 `:733-829`; M89 `:91-138`; `packages/sdk/src/client.ts:564-566`; `packages/sdk/src/session-proxy.ts:6809-6813`; `packages/sdk/src/workflow/session-definition-store.ts:448-467`, `:861-883`; `packages/sdk/src/workflow/store.ts:3366-3400`, `:7680-7709`; `packages/sdk/src/sweeper-tools.ts:328-365`.

Test retention is therefore a policy with exclusions, not a guarantee of a fixed database size. Test runs with outbox, request or agent invocation records are retained as `live_records`. Soft-deleted Workflows also retain their run history. Operation and guarded intake/request records are not erased by ordinary cleanup.
