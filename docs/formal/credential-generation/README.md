# Renewable GitHub credential client ownership

Three models check a worker's externally acquired, short-lived inference
credentials. Their boundary is process-pool and warm-session ownership, not the
orchestration's durable yield sequence. They add no cloud-specific assumptions.

## Binding status

Design and implementation-shaped checks bind source commit
`40e26986fcd141b3feb6bf740e11aaf6da07d645`, over upstream
`b71f78d2e6c80603d4e3a2a43c756e4a03fe98fa`. The normalized Git blob IDs in
[`CODE-BLOBS.tsv`](CODE-BLOBS.tsv) identify the source and regression suite.
The [correspondence](CORRESPONDENCE-40e26986.md) maps actions to actual source
lines, including the review fixes and the shared-helper extraction.

## Models, actions and rules

Acquisition can produce valid, short, foreign-scope or failed results. Only the
configured authority's valid result admits work; there is no ambient fallback.
Admission reserves a process lease before asynchronous SDK setup. Begin
rechecks remaining lifetime after setup. Older generations can coexist with
newer ones while a turn, discovery request, warm session or workflow holds them.
Warm handles detach under exclusive session ownership; an obsolete process
stops only after all owners release it.

The model abstracts callback transport, credentials themselves, pool keys and
SDK calls. Generations are immutable, ordered identifiers; the implementation
must separately reject inconsistent or reused descriptors. Neither tokens nor
deployment identifiers occur in the model.

`RetirementPass.tla` makes the event-driven cleanup loop explicit. One obsolete
client still has an owner; another client's cleanup can await an RPC while that
first owner releases. A release must request another scan rather than merely
await the current scan. The comparison reproduces the lost-repeat-request
design found and fixed by the implementation's regression test.
It also models one permanently stalled disconnect: the existing deadline must
end the retirement attempt without losing that client's binding. The pre-fix
comparison leaves unrelated operation finalizers and shutdown waiting forever.

`StartupOwnership.tla` covers two implementation defects found by independent
review that the initial design model missed. An internal epoch/turn-zero reset
must preserve the admitted client key throughout its awaits. Otherwise the
pre-send guard loses its token, and retirement cannot discover the session's
held lock through its missing binding. Separately, a newly opening workflow
holder on a cold session must not block selecting a fresh generation merely
because the previous key remains. An existing workflow-owned warm handle must
still refuse rebinding.

## Bounds and taxonomy

Ten-minute ticks represent one-hour credentials, thirty-minute admission and
twenty-minute model turns. Safety checks use one session/two generations/eight
ticks, or two sessions/three generations/three ticks, with one attempted turn
per session. The concurrent case's shorter clock keeps interleavings bounded;
the separate single-session case covers expiry and delayed setup.
A third safety case uses one session, three generations, eight ticks and two
attempts to check subsequent admission on an existing warm binding.

The liveness case uses one session, two generations, three ticks and one
attempt. It assumes weak fairness on discovery release; admission or rejection;
begin or late rejection; finish; lease release; workflow close; warm detach;
and process stop. It never forces publication or new work. Eventual draining
does not hold if a real owner never releases its reference.

`RetirementPass` has two obsolete clients, one releasable owner and one scan.
Weak fairness covers scan, successful cleanup completion, deadline expiration
and pass completion; owner release is optional. The stalled case checks attempt
settlement and client retention, not eventual cleanup of an unresponsive RPC.
Other cleanup failures and force-stop restoration are not modelled.
`StartupOwnership` has one session and two generations. Weak fairness covers
acquisition, reset and successful setup completion, not rotation. Its cases
isolate epoch reset, cold workflow setup and protected warm workflow ownership;
they do not model a retry after the first setup rejects.

Four deliberate faults bypass scope, lifetime, busy-client or busy-handle
guards. Three witnesses show overlapping generations, workflow-held obsolete
generations and subsequent admission on an existing warm binding are reachable.
The retirement module adds a lost-request comparison and an overlap witness.
The startup module adds three pre-fix comparisons: lost reservation, stopped
active client and rejected cold setup. The disconnect timeout adds a holding
case and a pre-fix comparison. Nine holding cases and thirteen expected
violations form the complete packet. A deliberate fault/witness is not a
product finding; the startup comparisons describe independently reproduced
pre-fix implementation defects.

## Results, 2026-11-17 UTC

TLC 2.19 (`tla2tools` 1.7.4), Microsoft OpenJDK 21, repository runner,
two workers and a 2 GiB heap: **9 PASS, 13 expected violations, 0 unexpected,
0 PARTIAL, 0 VOID** in the completed run. SANY and packet/hash checks passed.
Safety explored 8,971, 347,848 and 570,781 distinct states; liveness explored 1,861.
Retirement's drain and stalled-disconnect cases explored 26 and 18 states;
startup's holding cases explored 14, 5 and 2. The lost-request,
unbounded-disconnect and cold-holder comparisons violate their named temporal
properties (rc 13); the other expected violations are safety/witness
counterexamples (rc 12).
This is a bounded check of the models and their stated code correspondence,
not a proof of runtime behavior.
It assumes the host enforces finite turn duration. It does not check SDK
authentication, installation-token minting, actual renewal, native tools,
durable replay, process crashes, background work or callback/network failures
beyond the abstract rejected acquisition. Existing session and Workflow models
retain their own scope; they were not rerun or rebound by this design check.

Run `bash check-packet.sh`, then `bash run-tlc.sh <output>` with Java 17+,
Python 3 and the checksum-pinned TLC jar. Settings are generated from
`cases.json` and `tlc-templates.json`; do not commit generated `.cfg` files.
