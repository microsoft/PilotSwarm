# B2 implementation review: A4 integration and live delta

## Review Result: PASS (full B2) at `e38a41b4bd827c4d997d66db21ffbbeb608c8978`

### Summary
After A4, the B2 orchestration works end to end with the real runtime. The live suite covers every live item in the plan for B2, with real CMS, PostgreSQL and CLI paths. The merge introduced no changes outside the parents. One optional patch tightens assertions; it does not block this verdict.

### Integration identity (from immutable Git objects)
- `1838de0d` merges B3 (`61753c3d`, Opus PASS) with A4 integration (`9bb257e7`). No file differs from both parents, so the merge introduced no extra content.
- Relative to `9bb257e7`, the merge changes only B docs: Docs.md, WorkflowContext and the orchestration design doc.
- From `ff2188b1` (the scripted PASS) to `e38a41b4`, nothing changed in:
  - `orchestration/**`, frozen `orchestration_1_0_80`, the registry and version files;
  - `turn-control-orchestration.test.js`.
- From `1838de0d` to `e38a41b4`, one file changed: the new B test `turn-control-orchestration-live.test.js` (391 lines, blob `61c10d24`). No A-owned or C-owned file changed after the merge. The test uses existing harnesses and hooks, with no source changes.

### Evidence
- **Live suite:** 9/9 pass ([b2-live-final.json](artifact://1061a81e-ea27-4831-95c5-54005785721e/b2-live-final.json)). The JSON report carries no SHA. The 9 test names match the e38a41b4 file exactly, including both stop-variant cases and the separately registered real-CLI retry case.
- **Logs stamped `candidate=e38a41b4`:**
  - build passes ([b2-live-final-build.log](artifact://1061a81e-ea27-4831-95c5-54005785721e/b2-live-final-build.log));
  - SDK unit: 1,464 tests, 1,463 pass, 0 fail, 1 existing skip ([b2-live-final-unit.log](artifact://1061a81e-ea27-4831-95c5-54005785721e/b2-live-final-unit.log));
  - turn control, upgrade, legacy race and routing: 52/52 ([b2-live-final-scripted.log](artifact://1061a81e-ea27-4831-95c5-54005785721e/b2-live-final-scripted.log)).
- **Before-fix evidence** ([b2-before-fixes.log](artifact://1061a81e-ea27-4831-95c5-54005785721e/b2-before-fixes.log)): source `4c62cf99` with the `ff2188b1` tests fails exactly the three B2-1, B2-2 and B2-3 regression tests. The tests therefore detect the defects.
- **Live log line:** one `duroxide_pg ack_worker worker_item_not_found` line. This matches the expected cancel of the losing race branch in the frozen 1.0.80 Stop case. It is informational, not a failure.
- **Baseline environment failures:** accepted as before, without further qualification.

### Live coverage checked against the plan and design
| Plan or design item | Live case | Result |
|---|---|---|
| Stop through `catalog.turnControlAdd` on 1.0.81 ends stopped and idle, `activeTurnIndex` null, cron kept, no legacy `system.message` (P22) | Test 1 (real model) | PASS |
| Late steer runs once in the next turn; marker never sent to the CLI; one `user.steer`; closing `ran`; a later unrelated Stop writes no second closing record (P17a) | Test 2 (real CLI) | PASS |
| Consuming turn stopped at start and mid-turn: one closing record `stopped`; guidance not resent; worker returns `carriedSteersConsumed` (D6, L4) | Tests 3 and 4 | PASS |
| Frozen 1.0.80 still stops through the orchestration event, with the legacy line | Test 5 | PASS |
| Carry survives a pre-model admission error, a budget wait and a thrown attempt, then closes `ran` at a later index (7) (P12, P17a) | Test 6 (real CMS) | PASS |
| A returned retryable error is folded again, and the closing record is written only after the consuming retry | Test 7 | PASS |
| A carried-only returned-error retry on the real CLI keeps the marker out of every request and records no user message; `ran` at index 2 | Test 8 | PASS |
| Give-up through `closeControls` closes `gave_up` once in real SQL; a repeated close writes nothing (P17b) | Test 9 | PASS |
| Routing, upgrade from 1.0.80 to V4, terminal and give-up writes, wake scheduling | Scripted PASS at ff2188b1; unchanged | PASS |

### Notes (non-blocking)
1. **Stopped-turn checks in tests 3 and 4 are loose:**
   - The `carriedSteersConsumed` check matches any completed activity that contains the string.
   - The no-rerun check reads model requests just after the session goes idle. A wrong second turn would start a moment later, so the check is not deterministic.
   - The proof chain still holds: the worker flag (live) plus orchestration clearing on a stopped consumed turn (scripted).
   - The patch below makes both checks exact. It sends an ordinary follow-up turn and asserts that the guidance never reaches the model again and that no second closing record is written.
2. **Test 1 cron check:** it searches the status for the reason text. The patch also asserts `cronActive`, `cronInterval` and `cronReason`, and that `session.turn_stopped` is unique with `turnIndex === stop.turn`.
3. **Test 8 marker check:** the patch also asserts that no `user.message` contains the wake marker.
4. **B3 documentation follow-up:** the B3 testing and limitations text should now say that live CMS Stop and carried closing (ran, stopped, gave_up) are covered by `turn-control-orchestration-live.test.js`. It should list bound-agent-backfill as environment-limited (no usable gpt-5.4 provider).

### Optional patch (does not affect this PASS)
[b2-live-review-hardening.patch](artifact://e84e4301-c904-46df-9e94-79a6737e387a/b2-live-review-hardening.patch), sha256 `84ba479971a41c5fd77dc815799108d776554b4fc25b02b9c77c3a0cd6c160a4`.
- Precondition: `turn-control-orchestration-live.test.js` blob `61c10d24` at e38a41b4.
- Result blob: `b50b145c`.
- It changes only that test file. It passes a syntax check and `git apply`, and the status-field regex was checked against plain and escaped JSON.
- If you apply it, rerun only that file.

Correction rounds: 0 unresolved.
