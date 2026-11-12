# Event-emitter diagnostics usage spec

Status: proposed for [issue #11](https://github.com/microsoft/PilotSwarm/issues/11).
This is a usage contract for follow-up implementation, not a shipped feature.
No UI, tools, query behavior, or permissions change with this document.

## Initial surfaces and operator questions

Ship **Top event emitters** in the shared **Stats > Fleet** inspector for both
the native TUI and portal, together with a tuner inspect tool. Do not add a
portal-only Admin panel or change the existing session/fleet/users stats cycle.
The shared controller, state and selectors own loading and presentation;
hosts supply their existing controls and clipboard integration.

The view answers:

- Which `(worker, event type)` buckets recorded the most CMS event rows recently?
- Do the returned noisy buckets cluster on one worker?
- Does a bucket cover one session or many distinct sessions?

These are event-row counts, not database write-operation counts, bytes, rates,
or worker utilization. Batches can write multiple rows at once. Results exclude
events without worker attribution. A top-N sample cannot prove a worker's
share of all fleet events, and `sessionCount` cannot identify the loudest
session within a bucket. Do not display fleet percentages or infer causality.

## Bounded request and refresh contract

| Setting | Initial behavior |
|---|---|
| Window | Last **15 minutes** by default; choices **15m / 1h / 24h** |
| Rows | **20** by default; choices **20 / 50 / 100**, hard maximum **100** |
| Query | `getTopEventEmitters({ since: new Date(requestedAt - windowMs), limit })` |
| Refresh | On opening the fleet view, changing window/limit, or explicit Refresh; no background polling |
| Cache | Reuse the same window/limit snapshot for at most **60 seconds**; explicit Refresh bypasses it |

Show the requested lower bound and fetched-at timestamp. The API has no `until`:
this is a rolling lower-bound query evaluated during the request, not an exact
closed interval or reproducible historical snapshot. A full page means
"top N returned; more buckets may exist", not a proven total or pagination.
Never loop over limits or time ranges to reconstruct all results.

All new UI and tuner paths must validate before querying: finite dates, no
future lower bound, no lookback beyond 24h, and integer row limits in 1..100.
UI uses the choices above; the tuner accepts the same window choices and an
optional limit (default 20). Reject invalid input explicitly rather than
silently broadening the window. Enforce the lookback guard at the serving
boundary as well as in controls, using one request-time reference.

**Existing behavior is narrower than this proposed contract:** the management
client validates `since` and clamps rows to 1..100; the stored procedure caps
rows and applies the supplied lower bound. Neither currently enforces a maximum
lookback, and portal RPC currently checks date validity, not date age. The
follow-up must add and test the 24h guard for the new diagnostic paths, including
direct and Web API management calls; a row cap alone does not bound scan time.
Do not introduce a missing-`since`, all-time, or raw-SQL escape hatch.

## Rows, actions and failure states

Keep one row per `(workerNodeId, eventType)`, ordered by event count descending,
then last-seen descending, as returned by the API. Do not roll up workers:
distinct session counts cannot safely be added across event types.

Show Worker, Event type, Events, Sessions, First seen, Last seen. Use
client-local time via the shared date formatter, with full timestamps in row
details; null timestamps display as unavailable. Narrow layouts keep worker,
event type and counts visible and put timestamps/full identifiers in details.
Render identifiers as text, not markup.

Offer a worker filter **within the fetched top N**, labeled accordingly.
Filtering neither refetches nor claims to find every bucket for that worker;
an empty filtered view says "No matching worker in these top N results".
Clearing it restores the fetched rows. Defer server-side worker filtering.

Offer **Copy diagnostic JSON** in both hosts using existing host clipboard
mechanisms. Export `{ since, fetchedAt, limit, workerFilter, rows }` for the
displayed snapshot, preserving all six API fields and ISO timestamps.
Explicitly report clipboard failures. Worker identifiers are operational data;
do not auto-upload diagnostics or include event payloads/credentials.

**No session/event jump in v1:** aggregate rows contain no session IDs. Operators
can separately open an already-known, readable session's Activity/events view;
do not guess a session from a count or scan session histories to discover one.
Any future bucket-to-session drilldown needs its own bounded, authorized API.

Show loading, empty, unsupported, denied, and failed states distinctly.
An empty successful query says "No worker-attributed events in this window".
On refresh failure, retain an explicitly stale snapshot with its timestamp and
error/Retry action, never a success-shaped empty result. Ignore late responses
after window/limit changes, view exit or permission revocation; clear cached
diagnostics when access is revoked.

## Tuner access and layering

Add **`read_fleet_top_event_emitters`** to the existing privileged diagnostic
bundle in `packages/sdk/src/inspect-tools.ts`. Inputs are `window` (`15m`, `1h`,
`24h`, default `15m`) and `limit` (integer 1..100, default 20). Return
`{ since, fetchedAt, limit, rows }` with the same fields, bounds and caveats as
the UI. This is needed for reliability/noisy-event investigations under the
repo observability rule; no new durable metric is needed because CMS events
already persist the signal.

Use `PilotSwarmManagementClient.getTopEventEmitters`, not a new catalog or raw
SQL side channel. Preserve the existing `fleet:read` Web API authorization and
the inspect bundle's per-call fleet authorization (`requireAdmin`), including
its restrictions on detailed diagnostics for non-system cluster-scoped admins.
Tool registration alone is not authorization. Ordinary sessions/users must not
gain fleet visibility; UI capability checks do not replace server checks.
The existing MCP `get_fleet_overview(include: ["top_emitters"])` is prior art,
not a substitute for the tuner tool; align its diagnostic bounds in follow-up.

## Follow-up acceptance and tests

Implementation can start once this contract is accepted. Its completion needs:

- Management/provider coverage extending `cms-top-event-emitters.test.js` and
  `cms-read-bounds.integration.test.js`: multiple workers/types/sessions,
  distinct-session counts, ordering, time exclusion, absent worker attribution,
  20/100-row bounds, invalid/future/over-24h dates and direct/Web API parity.
- Serving-boundary tests for portal RPC, Web API and MCP: default/maximum
  windows and rows, bypass attempts, denied access and propagated query errors.
- Tuner handler tests: registration policy, per-call authorization (including
  cluster-scoped denial), defaults, bounds, management delegation and exact
  response shape. No SQL-only evidence or visual-only delivery.
- Shared controller/selector and host tests: identical windows/rows in both
  hosts, cache expiry/manual refresh, no polling, stale-request suppression,
  all failure/empty states, local-only worker filtering, JSON/clipboard parity,
  timestamp/null formatting and narrow-pane rendering.
- Local-instance walkthrough in both hosts with authorized and unauthorized
  personas; update affected canonical docs, TUI skill and visible help if
  controls change. No new keybinding is specified here.

## Existing implementation references

- [Management method](../../packages/sdk/src/management-client.ts) and
  [catalog row type](../../packages/sdk/src/cms.ts)
- [Stored procedure (migration 0013)](../../packages/sdk/src/cms-migrations.ts)
- [Web API operation and access class](../../packages/sdk/api/src/protocol.js),
  [portal runtime](../../packages/app/web/runtime.js) and
  [HTTP transport](../../packages/sdk/api/src/http-api-transport.js)
- [Shared fleet loading](../../packages/app/ui/core/src/controller.js),
  [inspect authorization](../../packages/sdk/src/inspect-tools.ts) and
  [MCP fleet overview](../../packages/app/mcp/src/tools/observability.ts)
- [Original bounded-read design](./db-optimization-design-review.md) and
  [shared UI architecture](../architecture/tui.md)
