## Review Result: BLOCKED

### Summary
**PASS pending patch:** Phase C2 implements the approved MCP surface with no functional blocking issues; reviewer-owned documentation corrections require parent application and verification before final PASS.

Reviewed `efb9601e62648b8e7383911ec7d1ea8078923943` to `269bf0e8ba65b5a5abb5361a108be4ab543fca70` in the assigned read-only worktree. All code references below are at `269bf0e8`. The inherited workspace matches the supplied containing repository path, and both commit objects and all seven changed paths are present. Source inspection used immutable Git objects only. C1 internals, other reviewers' findings and later phases were not reviewed.

#### Plan completeness

| Approved commitment | Evidence | Result |
|---|---|---|
| P8: `steer_session_turn` next to Stop, through the management client | `packages/app/mcp/src/tools/turn-control.ts:57-98`; exact text and request-id forwarding at 78-79 | Met |
| Stop accepts a request id and reports `too_late` | `packages/app/mcp/src/tools/turn-control.ts:34-53`; `stopped` is true only for `stopped` and legacy `stop_forced` | Met |
| P14: preserve caller request ids; ordinary-message hint only for definite `no_turn` / `legacy_turn` refusals | `packages/app/mcp/src/tools/turn-control.ts:38-39,70-71,78-96`; no automatic message send or control retry | Met; documentation polish below |
| MCP README and substantive focused unit tests | `packages/app/mcp/README.md:382-390`; `packages/app/mcp/test/unit/turn-control.unit.mjs:65-149` | Met |
| Register tests in the explicit `test:mcp` list and update enumerated expectations | `packages/app/package.json:66`; `packages/app/mcp/test/unit/registration.unit.mjs:123-127`; `packages/app/mcp/test/unit/dispatch.unit.mjs:72-73` | Met |
| Extend no-raw-operation expectations if they enumerate tools | `packages/app/mcp/test/unit/no-raw-op-calls.unit.mjs:21-34` scans every TypeScript source file and does not enumerate tools | No change needed |
| Preserve test integrity | Focused tests contain no retries, sleeps, custom model prompts or parallelism reductions; existing sequential MCP script is extended, not serialized further (`packages/app/package.json:66`) | Met |

### Tests
- **Status: PASS for the original candidate, as reported by the coordinator.** This reviewer did not execute repository code, builds or tests.
- Coordinator reports `npm run build:mcp` passed at `269bf0e8`.
- Coordinator reports `npm run test:mcp --workspace=pilotswarm` exited 0 at that same candidate: sendCommandAndWait 3/3, registration 24/24, dispatch 46/46, session-id OK, no-raw-op-calls OK, auth 3/3, workspaces OK, turn-control 20/20.
- Source coverage includes accepted/repeated/generated-id Steer results, every Steer refusal, empty text, unknown sessions, Stop request forwarding, every Stop outcome including legacy forced Stop, and pending Stop sequence preservation (`packages/app/mcp/test/unit/turn-control.unit.mjs:65-149`). These are MCP adapter tests, not proof of database idempotency or real-model delivery.
- **Pending patch verification:** In the approved parent runner, apply the attached diff to the exact candidate, run `npm run build:mcp` and `npm run test:mcp --workspace=pilotswarm`, and return the resulting committed SHA and actual outputs to this reviewer. Before the parent creates the source commit, stage only the intended three files and run `npm run check:privacy` as required by `.github/copilot-instructions.md:77-82`.

### Commits Made
None. Repository writes and commits belong to the coordinator. The only authored change is the attached documentation-only patch.

### Issues Found
**Functional blocking issues: 0.** The following reviewer-owned improvements are the only outstanding items.

| Item | Location at `269bf0e8` | Evidence and rationale | Proposed correction |
|---|---|---|---|
| Exact Stop result field and legacy outcome | `packages/app/mcp/src/tools/turn-control.ts:31-32`; `packages/app/mcp/README.md:386` | Tool text says `control_seq`, but the handler preserves `controlSeq` from the typed management result (`turn-control.ts:47-52`; `packages/sdk/src/types.ts:1769-1773`). The description and README also omit legacy `stop_forced`, which the handler correctly recognizes at line 51 and the focused test covers at lines 141-143. | Correct the description to `controlSeq`; document `stop_forced` as legacy-only. Preserve the existing response shape and logic. |
| Complete initialization-time fallback guidance | `packages/app/mcp/src/server.ts:66-68` | Initialization text mentions only `no_turn`; the tool correctly treats both `no_turn` and `legacy_turn` as fallback-eligible (`turn-control.ts:94-96`). P14 requires a definite refusal, not a lost response, before fallback. | Mention both outcomes, a new client message id, and no fallback after transport failure. |
| Explain the limit of server-generated request ids | `packages/app/mcp/README.md:386-387` | Request ids are generated only inside the handler when omitted (`turn-control.ts:46,78`) and returned in normal results (`turn-control.ts:52,87,93`). If that response is lost, the caller cannot reuse an id it never received. Optional generation is permitted by the assignment; it cannot supply safe client retries by itself. | Tell clients needing safe retries to choose and retain the id before the first call, keep text/reason unchanged, and retry only after a lost response. Explain accepted-but-pending Stop results and exact preserved field names. |

Patch: [C2-impl-review-r1.patch](artifact://5e3f595d-6a3f-4c6f-8853-7191cc6052fa/C2-impl-review-r1.patch).

The unified diff contains three hunks, one for each rationale above. It changes only `packages/app/mcp/src/tools/turn-control.ts` description text, `packages/app/mcp/src/server.ts` instructions, and `packages/app/mcp/README.md`. It changes no functional logic or tests. Diff syntax was parsed without accessing or writing repository source; actual applicability and execution remain parent-owned.

Parent operation: from the repository root at the pinned input candidate, run `git apply --check <downloaded-patch>` and `git apply <downloaded-patch>` after the required source approval. Intended commit: `docs(mcp): clarify turn-control results and safe retries`. If the parent has advanced the candidate, return the actual revision and the applied diff rather than assuming the original precondition still holds.

### Notes for Reviewer
- Omitting `caller` is correct for this adapter: it does not fabricate a principal. The declared C1 contract resolves direct-mode steering at cluster scope and treats a caller as trusted (`packages/sdk/src/types.ts:1848-1863`); MCP reaches the shared management surface (`packages/app/mcp/src/context.ts:54-61`). Web API caller stamping remains C1's separate responsibility.
- Keeping refusals as non-error results is intentional and correct (`turn-control.ts:90-97`). A missing-session preflight remains the existing explicit tool error (`turn-control.ts:43-44,75-76`), distinct from a management refusal after preflight. No `send_message` hint is added for `too_many`, `request_id_reused`, `steering_disabled` or `not_found`.
- `stopped: false` for `too_late`, `timeout` and `no_active_turn` fixes the old unconditional-success flag without dropping management result details (`turn-control.ts:47-53`). Do not rename `controlSeq` as a documentation fix; consumers already receive the preserved typed result.
- New optional request-id schema boundary cases and a thrown Steer transport error would be useful additional adapter coverage, but the current assertions cover the approved C2 minimum. They are not blocking requirements for this documentation-only patch.
- Final PASS is pending this reviewer's inspection of the parent-applied candidate and the returned build/test evidence. No new plan, external publication or source change was performed here.
