# WorkerShutdown (ws2) correspondence to bb162ed8

`packages/sdk/src/worker.ts` at `bb162ed8` (byte-identical at `8aaf5435`), `gracefulShutdown` 1307-1404.

| Model | Code |
|---|---|
| `DeadlinePasses`, `late` | `deadline` = now + drain budget (`PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS`, 60 s) + `PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS` (15 s), 1310-1314 |
| a step is started on `Advance` (added to `pending`) even when `late` | `bounded` 1317-1338: `Promise.resolve().then(work)` always runs; the race timer gets `max(0, deadline - now)` |
| `Advance` with the step still in `pending` (`abandoned`) | the race's timer wins: `late`, the error is logged, `bounded` returns; the step's work goes on |
| `Finish` | the step's promise settles (a failure is logged and counts as finished) |
| steps | runtime drain 1351-1356, workspace release 1374-1385, release sweep 1394-1401 (`sweepIdleSessions(1)`), close 1403 (`stop()`); the draining report (1342-1344) is not modelled |
| `SweepCommitted`, `SweepLegacyStart/Finish` | `sweepIdleSessions`: committed (marked) sessions deleted locally; unmarked legacy sessions dehydrated (upload, then delete) |
| `closed`, `closeCut` | after `stop()` an upload in flight fails; the local copy stays and the sweep goes on |
| `Exit` | the caller exits when `gracefulShutdown` returns; running work ends |

Not modelled: sessions whose aborted or still-running turns hold their run-turn lock; the sweep skips them
(comment 1386-1393), so a drain still running while the sweep runs does not lose a turn's session. The inventory row is H05.

Test evidence: `packages/sdk/test/unit/worker-shutdown-deadline.test.mjs` (the final review's test, added after `8aaf5435`; no change to
`worker.ts`) holds the runtime drain past the deadline and records: the release, the sweep and the close each start at
or after the deadline with a 0 ms limit; a step whose work settles at once still finishes (`Finish` before `Advance`);
a pending release has only its wait abandoned and finishes after `gracefulShutdown` returns. In the model `Exit` ends
it; the workspace release does not touch the session state the invariants are about.
