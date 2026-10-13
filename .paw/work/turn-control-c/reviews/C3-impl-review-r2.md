## Review Result: BLOCKED

**Reviewer model:** `azure-openai:gpt-6-luna` (Round 2; Round 1 used `gpt-6.1-sol`).

### Summary
Phase C3 is **BLOCKED** on one remaining TUI status-hint defect: Ctrl+T is advertised for retry while an outbox message is selected, but the controller rejects that action before reaching retry. The other four Round 1 findings are resolved on candidate `b3250a7fb917a4f0fcede8b17740127adf516449`.

**Review scope:** immutable diff from phase base `0ee90a080cb22c49e0f006d806e99437f2560026` to candidate `b3250a7f`, restricted to `packages/app`, `.github/skills/pilotswarm-tui/SKILL.md`, and `docs/user-guide/keybindings.md`; Round 2 delta from `e613b98f` to `b3250a7f` in `packages/app`. The assigned checkout is `.wt/tc-c`, whose Git common directory is the supplied session repository. No mutable HEAD/index was used.

### Tests
- **Status: PASS based on coordinator-supplied, candidate-bound receipts.** This reviewer did not run repository code, builds, tests, dependency managers, or hooks.
- `npm run build`: exit 0.
- `npm test --workspace=pilotswarm`: exit 0; TUI 28/28, web 153 passed / 22 skipped / 0 failed, UI 892/892, MCP registration 24/24, dispatch 46/46, turn-control 20/20, other suites OK.
- `npm run test:e2e --workspace=pilotswarm -- turn-control.spec.mjs mobile-header-status.spec.mjs`: exit 0, 24 passed.
- Privacy check: 0 findings.
- Receipts identify `.sha = b3250a7f`.

### Commits Made
None. No repository files were changed. No reviewer patch is proposed; the remaining issue changes the visible keybinding hint and needs a source correction plus a targeted assertion.

### Issues Found

#### C3-R1-04 remains partially open: Ctrl+T retry hint is false while editing an outbox message [Medium]

**Location:** `packages/app/ui/core/src/selectors.js:6149-6151`; rejection path: `packages/app/ui/core/src/controller.js:10921-10929`.

**Evidence:** `selectStatusBar` unconditionally prepends `ctrl-t retry steer` when the Steer request is unconfirmed (`selectors.js:6150-6151`). But `steerActiveSessionTurn` checks for a selected outbox editor and returns before its `unconfirmed` retry branch (`controller.js:10923-10929`). Thus, while an outbox message is selected, the advertised Ctrl+T action does not retry the request; it only replaces the status text with the “Steer is unavailable…” message. The selector already exposes `editingOutbox` (`selectors.js:3388-3410`), so the hint can be gated on that state. The `Alt+T` give-up action remains available and is documented.

**Reproduction:** Lose the response to a Steer, select a pending or queued outbox message with the TUI prompt navigation keys, then press Ctrl+T. The status bar advertises retry, but the controller exits at the selected-editor guard without calling `retryTurnControl`.

**Required change:** Do not show `ctrl-t retry steer` while the prompt edits an outbox item. Keep the `Alt+T` give-up hint if applicable. Add a status-bar regression test for an unconfirmed Steer with an outbox item selected; the existing selection guard must continue to protect the selected message.

**Disposition:** The main recovery gap is fixed: `Alt+T` invokes `giveUpTurnControl` (`tui/src/app.js:291-292`), the shared controller preserves its Steer text (`controller.js:10861-10883`), and the docs/help/skill describe the key. This stale retry hint is the remaining part of the original finding.

### Round 1 finding resolution

| Finding | Round 2 result | Evidence |
|---|---|---|
| C3-R1-01: a later Steer could erase retained refused guidance | **Resolved** | Refused/given-up text is now held in a per-session `kept` list independently of replaceable notices; only Restore or Discard clears it (`controller.js:10812-10851`). The new test exercises retention across a Stop and later Steer (`turn-control-controller.test.mjs:434-457`). |
| C3-R1-02: cancelled-before-send fallback was reported as sent | **Resolved** | Success requires the fallback's own envelope to be queued or its matching durable `user.message` to be present; a missing item without that evidence reports failure (`controller.js:11016-11043`). Added cancellation, merged-ID and earlier-attempted-envelope tests (`turn-control-controller.test.mjs:480-528`). |
| C3-R1-03: asynchronous refusal could restore text into an outbox editor | **Resolved** | `_composerFreeFor` requires the session to be active and no prompt edit to be selected; return, Restore and Dismiss use that guard (`controller.js:10802-10851`, `10883`). A deferred-response test confirms the selected pending envelope stays unchanged (`turn-control-controller.test.mjs:459-478`). |
| C3-R1-04: TUI lacked give-up/restore for unconfirmed Steer | **Partially resolved; see blocker above** | Alt+T, the help/status hint, user keybindings and TUI skill now describe give-up/restore (`tui/src/app.js:291-292`; `ui/core/src/selectors.js:6157-6158`, `9492`; `docs/user-guide/keybindings.md:111`; `.github/skills/pilotswarm-tui/SKILL.md:129-132`). However, the Ctrl+T retry hint is still shown while the editor guard blocks it. |
| C3-R1-05: turn status was hidden instead of visibly readable | **Resolved** | The `session-turn-state` chip is visible beside Stop/Steer (`ui/react/src/web-app.js:10054-10064`) and has visible layout/style rules (`web/src/index.css:3641-3660`). Mobile browser coverage asserts visibility and viewport placement at 320 x 400 (`web/test/e2e/mobile-header-status.spec.mjs:131-141`). |

### Notes for Reviewer

- The C3 plan's `data-testid` contract now has a visible `session-turn-state`; the 320 x 400 browser check verifies it is on-screen. The hidden-status finding is closed.
- The TUI additions keep the key surfaces aligned: input handling, status hint, help, keybindings documentation, and `.github/skills/pilotswarm-tui/SKILL.md`. The retry-hint inconsistency above still needs correction.
- The parent-owned local two-persona portal/TUI walk (including a read-only share) remains **deferred** until A4/B2 are integrated, as directed. It is not counted as a C3 blocker here. The parent-owned integrated UX pass remains separate; this review does not claim it complete.
- No further functional issue was identified in the reviewed Round 2 delta. C4 documentation changes were excluded.
