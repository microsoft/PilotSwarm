# Renewable GitHub credential client ownership

Three models check process-pool and warm-session ownership, not durable yields.
They bind source commit
`ddad43c54fd6b8012547d51c501378efd3fc4fe2`, over upstream
`b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`.
[`CODE-BLOBS.tsv`](CODE-BLOBS.tsv) pins normalized source/test blobs;
the [correspondence](CORRESPONDENCE-ddad43c5.md) maps every action to that code.

## Models, actions and rules

| Model | Rules |
|---|---|
| `CredentialGeneration` | Admit only valid, expected-scope credentials, never ambient fallback; reserve before asynchronous setup and recheck lifetime before execution. Retain every active session/discovery/workflow owner before detaching a handle or stopping its process. |
| `RetirementPass` | Repeat cleanup when an owner releases during another client's awaited teardown. A stalled disconnect must settle by deadline without losing its binding or blocking unrelated finalizers/shutdown. |
| `StartupOwnership` | Internal resets retain the admission key throughout their awaits. Cold workflow reopening may rotate a retained old key; an existing workflow-owned warm handle may not. |

The latter two models reproduce review-found implementation defects, with
pre-fix comparisons and failing-then-passing regressions. Callback outcomes
are abstract; immutable generations are ordered identifiers, not token bytes.

## Bounds and taxonomy

Ten-minute ticks represent 1-hour credentials, 30-minute admission and 20-minute
turns. Lifecycle safety bounds `(sessions, generations, ticks, attempts/session)`
are `(1,2,8,1)`, `(2,3,3,1)` and `(1,3,8,2)`; the last checks warm re-admission.
The shorter concurrent clock bounds interleavings; the first covers delayed
setup/expiry. Liveness uses `(1,2,3,1)` with weak fairness on `ReleaseDiscovery`,
`Admit/Reject`, `Begin/RejectReady`, `Finish`, `Release`, `CloseWorkflow`,
`Detach` and `Stop`. Publication/new work are not forced; owners must release
for eventual draining.

Retirement has two obsolete clients, one releasable owner and one scan. Fairness
covers scan, successful cleanup, deadline and pass completion; owner release is
optional. Stalled disconnect checks settlement/retention, not eventual cleanup.
Startup has one session/two generations; acquisition, reset and successful
setup completion are weakly fair, not rotation. No retry after rejected setup
is modelled.

The 22 cases comprise 9 holding cases, 4 deliberate faults (scope, expiry,
busy process/handle), 5 pre-fix comparisons and 4 reachability witnesses.
Faults/witnesses are not product defects; see `cases.json` for each expectation.

## Results, 2026-11-18 UTC

TLC 2.19 (`tla2tools` 1.7.4), OpenJDK 21, two workers/2 GiB:
**9 PASS, 13 expected violations, 0 unexpected, 0 PARTIAL, 0 VOID**.
SANY and packet/hash checks passed. Lost-request, unbounded-disconnect and
cold-holder comparisons return rc 13; other expected violations return rc 12.

This is a bounded model check, not a proof of runtime behavior. It assumes
finite host turn deadlines and does not check SDK authentication, actual token
minting/renewal, tools, durable replay, crashes, background work, force-stop
restoration or callback/network failures beyond abstract rejection. Existing
session/Workflow models retain their separate bindings; they were not rerun.

Run `bash check-packet.sh`, then `bash run-tlc.sh <output>` with Java 17+,
Python 3 and the pinned TLC jar. The runner generates `.cfg` files; never commit them.
