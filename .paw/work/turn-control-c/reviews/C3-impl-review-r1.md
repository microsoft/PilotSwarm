## Review Result: BLOCKED

### Summary
Phase C3 remains BLOCKED at `e613b98f`. The corrections fix the original isolated refusal-restoration cases, fallback dispatch behind a successful earlier send, new Steer from outbox selection, and cross-kind portal notice recovery. Five narrower interaction, parity or approved-contract gaps remain. Functional rework belongs to the implementer.

| Revision | Review scope |
|---|---|
| `0ee90a080cb22c49e0f006d806e99437f2560026` | Approved phase base. |
| `946e9e96402235bc29f2a54654410ca4e66d767c` | Initial C3 candidate. |
| `1a52b0804518a14c6619d65ea1461afbea535388` | Refusal recovery and fallback dispatch correction. |
| `e613b98f258a99278bb69938cbcd39d4ddd73151` | Current candidate; parent is `1a52b080`; outbox guard and per-kind notices. |
| `e944fe688d2da4104fab25a60dc0f340e86cf7b0` | C4 documentation, excluded. |

All current issue locations below refer to `e613b98f`. Only assigned immutable objects were read. No mutable HEAD, index, source file or other reviewer's output was used.

### Tests
- Status: **PASS for coordinator-supplied candidate-bound build, app unit and browser execution.** The review verdict remains BLOCKED on the five source-backed findings below. This reviewer did not execute repository code, builds, tests, dependency managers or hooks.
- Coordinator-supplied receipts use `git archive <sha>` extracted in the dev pod at `/workspace/tasks/tc-c-ver`, with `.sha` printed at the end of each run.

| Candidate | Build | App unit tests | Browser tests |
|---|---|---|---|
| `946e9e96` | Exit 0 | Exit 0: TUI 27/27; web 153 passed, 22 skipped; UI 874/874; MCP all suites passed. | Exit 0, 20 passed. |
| `1a52b080` | Exit 0 | Exit 0: TUI 27/27; web 153 passed, 22 skipped; UI 880/880; MCP all suites passed. | Exit 0, 21 passed. |
| `e613b98f` | Exit 0 | Exit 0: TUI 27/27; web 153 passed, 22 skipped, 0 failed; UI 884/884; MCP registration 24/24, dispatch 46/46, turn-control 20/20, others OK. | Exit 0, 22 passed. |

The browser command is `npm run test:e2e --workspace=pilotswarm -- turn-control.spec.mjs mobile-header-status.spec.mjs`. Initial browser coverage includes every selector/attribute value, mobile Steer at 320 x 400, Zen/MoA across four themes and two-panel MoA routing. On 2026-10-13, the coordinator supplied the completed `e613b98f` archive-bound receipt with `.sha = e613b98f`, resolving current-candidate execution evidence. Privacy reported 0 findings before commit. Passing these suites does not exercise or resolve the remaining cases below.

The correction tests are substantive: switch-then-refusal, newer draft-then-403, empty-prompt restoration, unconfirmed Dismiss with a newer draft, fallback behind a held send followed by rejection/success, pending/queued edit guard, separate notice dismissal and same-ID retry after Stop/turn end. The new portal test exercises retained unconfirmed Steer Retry after Stop and idle.

The two-persona local portal/TUI walk, including a read-only share, is **missing acceptance evidence**, not an additional C3 code finding. The coordinator reports that A4 and B2 worker-side integration must land before this walk can run. This review does not claim those dependencies or UX-01 through UX-25 complete.

### Commits Made
None. No source files were changed, and no source command was executed. No reviewer-only polish patch is proposed; the remaining changes affect behavior or require an explicit contract decision.

### Issues Found

#### C3-R1-01: A second Steer can erase retained refused guidance [High]
**Location:** `packages/app/ui/core/src/controller.js:10805-10820`, `10916-10919`, `10943-10945`.

**Evidence:** The correction now retains refused text on `steerNotice` when the session is inactive or a newer draft exists. The per-kind split also protects it from Stop. But starting another Steer clears `steerNotice` before sending, and accepting that new request clears it again. Once the earlier refused request is gone, the notice is its only text owner. No explicit Restore or discard is required before it is overwritten.

**Reproduction:** Send guidance A; while its answer is held, type draft B. Return `too_many` for A. A is now retained in `steerNotice.text`. Press Steer on B before restoring A. The new request takes B and clears the only copy of A, even if B is subsequently accepted.

**Required change:** Keep refused guidance independently of replaceable notices, with originating session/request ownership, or require recovery/discard before permitting another same-kind request. Do not silently overwrite retained text. Add controller/browser coverage for retained refusal followed by another Steer and its accepted/refused answer.

**Correction disposition:** Original switch/refusal and newer-draft/refusal loss cases are fixed. Stop no longer erases the retained text. This remaining finding is specifically same-kind replacement.

#### C3-R1-02: A cancelled-before-send fallback is reported as sent [Medium]
**Location:** `packages/app/ui/core/src/controller.js:10981-11004`, especially `10998`; local removal `1891-1905`, `1919-1966`; outcome publication `10955-10962`.

**Evidence:** `_sendFallbackMessage` correctly follows the fallback client ID, including merged IDs, and waits for a previous flush. However, `!current` is still classified as success. A pending fallback can be removed locally with `cancelOutboxItem` or pending-selection cancellation before it reaches the transport. Missing state is not proof of acknowledgment.

**Reproduction:** Hold ordinary message A in flight. Steer receives `no_turn`, so fallback B is queued locally and waits for A. Cancel B while it is unattempted/pending. Resolve A. The helper finds no B and reports `fallback_sent`, although no `sendMessage` call for B occurred.

**Required change:** Observe an ID-bound enqueue/acknowledgment or cancellation disposition. Do not infer success merely because the item disappeared. Map cancellation before send to a non-success notice consistent with the approved contract. Add cancelled-before-send fallback, merged-ID acknowledgment and older attempted-pending envelope cases.

**Correction disposition:** The initial held earlier-send/rejected-fallback and held earlier-send/successful-fallback cases are fixed. The remaining issue concerns cancellation/removal. The five-dispatch cap also has no demonstrated relation to this item's disposition; prefer observing the actual outcome to making a count-based conclusion about unrelated flushes.

#### C3-R1-03: An asynchronous refusal can restore text into an outbox editor [High]
**Location:** `packages/app/ui/core/src/controller.js:10805-10808`, `10815-10827`, `10830-10849`, `10936-10938`; `setPrompt` side effect `9447-9467`.

**Evidence:** The new `getPromptEditSessionMatch` guard at `10889-10892` prevents a new Steer from stealing/clearing/resending selected pending or queued text. That original path is fixed. But the refusal-return path has no editor guard. `_returnSteerText` treats an empty selected outbox editor as an empty normal composer and calls `setPrompt`, which changes the selected unattempted pending envelope. The Restore and Dismiss helpers similarly append through `setPrompt` without accounting for editor ownership.

**Reproduction:** Start Steer with guidance A and hold its response. In the TUI, select an unattempted pending envelope using outbox recall and edit its text to empty. Return `too_many` or HTTP 403 for A. `_returnSteerText` writes A into that selected envelope rather than the saved normal draft; the later batch can deliver A as an ordinary message even though this refusal is not eligible for automatic message fallback.

**Required change:** Automatic return must treat any selected editor as occupied, regardless of its text. Keep guidance in independent recovery state, or explicitly leave the editor and restore the normal draft before returning text. Guard Restore/Dismiss similarly. Add deferred-response tests that enter pending, attempted-pending, queued and cancelling selection between send and refusal; assert envelope text/IDs and saved draft are unchanged.

**Browser coverage scope:** The supplied explanation is supported by searches of the assigned `ui/react` and `web/src` trees: they have no calls to `enterPendingPromptEdit`, `selectPreviousPendingPrompt` or `selectNextPendingPrompt`. The editor is entered through shared `movePromptCursorVertical` in the TUI. Do not add a fake portal gesture merely to satisfy this case; shared-controller/TUI coverage is appropriate. The original portal selected-editor reproduction is withdrawn as unreachable through its current UI.

#### C3-R1-04: The TUI still has no give-up/restore action for an unconfirmed Steer [Medium; parity]
**Location:** `packages/app/tui/src/app.js:280-287`; `packages/app/ui/core/src/controller.js:10893-10898`, `10830-10849`; `packages/app/ui/core/src/selectors.js:6145-6151`; portal Dismiss `packages/app/ui/react/src/web-app.js:9675-9682`.

**Evidence:** Per-kind notices and portal rendering now keep an unresolved Steer's Retry/Dismiss available after Stop and idle. This fixes the original cross-kind portal issue. In the TUI, Ctrl+T always retries while `steer.phase === "unconfirmed"`, even with an empty prompt. The restore branch is later and only restores refused notice text. Searches of the assigned TUI show no caller of `dismissTurnControlNotice` or another give-up action. The portal lets the person give up the unconfirmed request and restore its text; the terminal does not.

**Reproduction:** Lose the Steer response in the TUI. Stop the turn or let it end. Ctrl+T continues retrying the same request. The person cannot choose the portal's Dismiss behavior to return the original guidance after a newer draft or abandon the unconfirmed request deliberately.

**Required change:** Provide an intentional terminal equivalent of give-up/restore, with session-owned draft handling. Keep binding, contextual hint, help and the TUI skill aligned. Add shared-controller and TUI key/help coverage. Also suppress the current `ctrl-t retry steer` hint during outbox selection: the new controller guard rejects it, but the hint precedes `canSteer` and still advertises it.

**Correction disposition:** Cross-kind portal visibility and separate dismissal are fixed. No additional code issue is assigned for the pending two-persona integration walk.

#### C3-R1-05: The turn-status selector remains hidden rather than visibly readable [Medium; plan contract]
**Location:** `packages/app/web/src/index.css:3640-3648`; `packages/app/ui/react/src/web-app.js:9927-9933`. Requirement: `.paw/work/turn-control/ImplementationPlan.md:511`, `519`.

**Evidence:** The approved contract says each selector row and attribute value is a visible state. `session-turn-state` still belongs to a clipped 1px span. A useful screen-reader status is not the promised visible turn-state presentation. The visible status strip/header does not carry the selector and attributes.

**Required change:** Place the selector and attributes on an existing visibly readable status element, or render an appropriate visible indicator. Preserve mobile, Zen, MoA and session scoping. Add on-screen/readable assertions at 320 x 400 rather than attribute-presence assertions alone. Any decision to permit hidden-only status must explicitly amend the approved contract; the current implementation does not do that.

### Notes for Reviewer

#### Plan deliverable checklist
| Deliverable | Assessment |
|---|---|
| Shared `STEER_TURN`; preserved Stop/Steer request IDs; management transport | Present. Same-ID isolated retries and retry after Stop/idle are covered. |
| Normal-message fallback only after definite `no_turn`/`legacy_turn` | Present. ID-bound dispatch improved; cancellation interpretation remains issue 2. |
| Detailed boolean eligibility plus viewer feature; explicit false at end/wait/question | Present. New outbox edit guard prevents initiating Steer from a selected message. |
| Refusal/retry text ownership and recovery | Improved. Same-kind overwrite, asynchronous editor restoration and TUI give-up remain issues 1, 3 and 4. |
| History allowlist and label reconciliation across pages | Present. `session.steer_confirmed` stays excluded; control outcome/close events are label inputs, not duplicate chat items. |
| Carried labels derive only from `session.carried_steers_closed`, matched by seq | Present. Bulk/live and three-page reconstruction coverage is substantive; no later-Stop or turn-index inference. |
| Legacy Stop distinction and new-path nonduplication | Present under supplied interrupt contract. |
| Portal controls/outcomes/session scoping | Present. Both kind notices now render independently after eligibility ends. Hidden status violates the literal visible-state contract. |
| Ctrl+T, existing Stop keys, status hints, help, TUI skill | Initial feature surfaces present. Recovery parity and retry hint need issue 4 addressed. |
| Promised tests | Substantive tests exist and supplied current-candidate execution passes. Additional interaction cases are identified above. |
| Local two-persona portal/TUI acceptance | Missing evidence pending A4/B2 integration, not a sixth code finding. |

#### Correction conclusions
| Initial concern | Current disposition |
|---|---|
| Refusal after navigation/new draft loses guidance | Fixed in the isolated cases by retaining text on the refusal notice and appending after newer draft. Same-kind replacement still loses it. |
| Dismiss with newer draft loses original text | Fixed in the isolated portal case. TUI has no equivalent action. |
| Earlier flush completion falsely marks held fallback sent | Fixed in supplied success/failure cases; local cancellation still gives false success. |
| New Steer blanks selected pending item or repeats queued text | Fixed by controller/selector guard. Deferred refusal/editor race remains. |
| Stop hides unconfirmed Steer Retry after idle | Fixed in portal by per-kind notices, explicit rendering and added browser/controller tests. |
| Hidden-only turn state | Unchanged. |

No new hidden test retries, committed test-parallelism reduction, arbitrary test sleeps or compensating custom system prompts were found in reviewed changes. No reviewer patch is needed merely to fix stale comments while the state/recovery behavior is still being revised.

#### Source and execution provenance
The coordinator supplied the approved dedicated-worktree departure: `.wt/tc-c` is a worktree of the inherited session clone, sharing `/ws/git/sessions/fd0866b9-efc2-4bb1-9eda-48bd13df7ee4/pilotswarm/.git`, on `waldemort/turn-control-surfaces`. This is not a separate v2 catalog clone. Actual workspace records match the inherited clone receipt; immutable commit/path checks confirmed each assigned correction. Parent/commit identity was read from immutable Git objects. No discovery, fetch, checkout, source write, build or test occurred here.

The coordinator's reported publication at `e944fe68` is provenance context, not the selected candidate. C4 documentation was not reviewed. The assigned PAW bindings, sealed read-only source skill and `paw-impl-review` instructions were loaded. Functional changes remain implementer-owned; source mutation and execution remain parent-owned.

**Parent next action:** address the five remaining findings and return the exact new candidate with regression results. Complete local two-persona acceptance after A4/B2 integration. Passing current-candidate suites does not close the source-backed findings.
