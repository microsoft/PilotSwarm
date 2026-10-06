- 2026-08-23: Default agent prompt advanced to 1.17.0 for reusable canvas-app guidance. Removed future-only canvas KV/catalog claims and retained only shipped artifact manifests, creator-only response contracts, and transient `update_canvas` data/patch behavior. Expected behavior: agents never call nonexistent `kv.*`, `canvas_kv`, `find_canvas_app`, or `publish_canvas_app`; reusable apps are saved/reloaded through artifacts. Validated by canvas contract/UI suites; not model-specific.

# PilotSwarm Agent Tuning Log

This version-controlled log records prompt behavior changes that affect shipped
PilotSwarm agents. Model-specific compatibility measurements remain in
`docs/models/` when a formal evaluation sweep is run.

## 2026-10-06 - Builder guidance for session steering

- **Agents:** SDK builder 1.8.0 to 1.9.0; CLI builder 1.5.0 to 1.6.0;
  portal builder 1.3.0 to 1.4.0.
- **Model tested:** none; these are builder contract updates, not a model experiment.
- **Observed behavior:** existing templates taught ordinary Send but not explicit
  current-turn guidance or its durable receipt contract.
- **Expected behavior:** use public steering clients and controls; preserve the
  observed target and retry identity; distinguish acceptance, delivery, inclusion
  and terminal no-resend evidence. Keep ordinary Send/Stop and authorization intact.
- **Validation:** source/build and API/UI contract coverage. No builder-model
  compliance or live-provider compatibility result is claimed.

## 2026-09-22 — Maintainer PR comment command

- **Agent:** repository `pilotswarm-release`, `2.2.0` to `2.3.0`.
- **Model tested:** none; operational entry-point guidance.
- **Observed behavior:** maintainers had to leave the PR to request full tests.
- **Expected behavior:** accept a new standalone `/test all` comment only from
  an authorized repository writer; acknowledge the pinned SHA/run on the PR,
  retain environment approval and execute the existing complete coverage.
  Ignore quoted/edited/ordinary-issue commands and isolate their handling from
  the CI database concurrency lock.
- **Validation:** comment identity/permission/change tests, fixed-profile and
  acknowledgement fixtures, manual-input regression and workflow contracts.
  No live full test run or model-compliance claim is made.

## 2026-09-22 — Maintainer-approved PR integration tests

- **Agent:** repository `pilotswarm-release`, `2.1.0` to `2.2.0`.
- **Model tested:** none; maintainer workflow guidance, not a model experiment.
- **Observed behavior:** full Tests could only target main, preventing
  maintainers from qualifying reviewed PR code before merging.
- **Expected behavior:** select a pinned PR head from the trusted main workflow,
  approve the specific candidate with an explicit CI-credential trust warning,
  run the unchanged provider coverage, and report on that commit. Keep public
  fork checks unprivileged and require the release's own merged-source gate.
- **Validation:** target/permission/stale-head/status tests, candidate execution
  and source-identity fixtures, and existing provider/qualification regressions.
  No live PR integration run or model-compliance claim is made.

## 2026-09-20 — Public release distribution and copyright preservation

- **Agents:** repository release agent `2.0.0` to `2.1.0`; SDK builder `1.7.0`
  to `1.8.0`; CLI builder `1.4.0` to `1.5.0`.
- **Model tested:** none; operational guidance only.
- **Observed behavior:** registry-based builder examples conflicted with
  release-tarball distribution, and package metadata did not include the full
  copyright and permission notice in artifacts.
- **Expected behavior:** scaffold verified public release file pins, restore
  ignored downloads before install, require complete package-local licenses,
  and repair existing releases additively without changing tested package bytes.
- **Validation:** packaging/notice maintenance regression tests and direct
  artifact inspection; no model-compliance or compatibility-matrix claim.

## 2026-09-20 — Bounded sequential verification meets the release bar

- **Agent:** repository `pilotswarm-release`, version `1.4.0` to `2.0.0`.
- **Model tested:** none; this changes release qualification policy, not a model prompt experiment.
- **Policy:** after complete initial coverage, one sequential verification of
  exactly 1-5 failed test-case executions total across provider phases may qualify
  the run. Every selected case must pass on the same source/model/provider.
  Six or more failures must fail without sequential execution.
- **Expected behavior:** accept and clearly report **qualified after sequential
  verification**, retaining the original failures. Do not require a new clean
  parallel pass after successful bounded verification, and do not run repeated
  attempts. Missing coverage, setup/unhandled errors and incomplete verification
  remain blockers.
- **Validation:** real Vitest fixtures cover one and five failures, exact
  selection, concurrency one even for concurrent cases, six-case rejection and
  unhandled errors. Unit and wiring tests cover global cross-provider counting,
  identity matching, stale/missing results, skipped cases and failure propagation.
  No live model compliance or compatibility-matrix change is claimed.
- **Supersedes:** the diagnostic-only release decision in the entry below.

## 2026-09-20 — Release failure diagnosis before another full gate

- **Agent:** repository `pilotswarm-release`, version `1.3.1` to `1.4.0`.
- **Model tested:** none; this is release-workflow guidance, not a model evaluation.
- **Observed behavior:** a small HDB failure set prompted another complete gate
  before the affected files were isolated. The targeted run later passed all 24
  tests without changes to those tests, which did not establish the failure's cause.
- **Expected behavior:** extract failed phases/files/cases, run explicit targeted
  diagnostics (sequentially when requested), and preserve both original and
  diagnostic outcomes. Publication still requires a complete successful gate.
- **Validation:** targeted HDB routing and failure-propagation tests cover the CLI
  workflow used by the guidance. No claim about agent-model compliance or a
  changed model compatibility matrix is made.

## 2026-09-08 — Durable versus native filesystem boundary

- **Agent:** framework base prompt and native delegation overlay.
- **Version:** `1.20.0` → `1.21.0`.
- **Observed behavior:** with native tasks enabled, Terra passed a durable
  parent's or sibling's local source path to its own native task, despite an
  available artifact reference. Both live fixture cases failed. The producer
  file had been removed, so colocation could not hide the mistake.
- **Change:** native sharing is explicitly limited to the immediate parent
  session. Durable children materialize other sessions' artifacts into their
  own workspace before asking native tasks to process them; native tasks cannot
  fetch artifacts themselves.
- **Validation:** both cases passed after the change, then passed again on a
  second run (4/4). Real Terra/medium, real SDK/CLI and production artifact
  handlers; actual `read_artifact(toFile)` followed by native `shasum`, byte/hash
  verification, and task cleanup. The fixture supplies durable-child context
  and simulates unavailable producer storage; it does not use the scheduler.
  Four credential-free cases independently test the harness, including false
  shared-path assumptions and fabricated correct checksum claims.
- **Local orchestration:** `25bc9f77-e785-43b5-b26b-270b015880a8` actually spawned
  durable child `7f9404d6-ec2b-43dc-a2b6-90c0ada75b6f`. The child downloaded its
  parent's artifact, ran native checksum work, returned the correct hash, and
  was completed by the parent. A first attempt exposed mismatched portal/worker
  local artifact directories; the isolated launcher now sets `ARTIFACT_DIR`
  explicitly. No production artifact code changed. After the successful result,
  subsequent root wakes emitted empty-response retries before recovering to
  `idle`; similar behavior was recorded before this prompt change. That separate
  coordination issue remains unresolved.
- **Scope:** these are small regression samples, not a general model reliability
  benchmark. The separate interrupted routing sweep remains partial; this entry
  does not claim it was completed. See `docs/models/native-delegation-testing.md`.

## 2026-09-07 — Search shared skills when needed

- **Agent:** framework knowledge-retrieval prompt and `search_skills` tool description.
- **Models:** model-independent guidance; the reported screenshots did not identify the model.
- **Problem:** the prompt required a search at the start of every turn, causing
  greetings, arithmetic, and status checks to call `search_skills` unnecessarily.
- **Change:** search for explicit skill requests or non-obvious context gaps;
  answer routine exchanges directly and reuse relevant skills already loaded.
  Retrieved instructions still load before use.
- **Validation:** prompt-contract tests cover both semantic and lexical modes.
  No live model behavior or compatibility sweep is claimed.

## 2026-07-20 — Finite delegation wake policy

- **Agent:** framework base agent (`packages/sdk/plugins/system/agents/default.agent.md`)
- **Version:** `1.7.0` → `1.8.0`
- **Models:** model-independent prompt contract; no model sweep run
- **Problem:** a finite Waldemort delegation used `wakeOn: "completion"` for
  an ordinary child task result. PilotSwarm children remain alive and idle
  after a final reply, so the update classified as `material` and the parent
  suppressed it while waiting for an actual terminal lifecycle outcome. The
  SDK also dropped `childContract` while creating the child orchestration,
  causing child-side and parent-side policy evaluation to disagree.
- **Change:** finite delegated work whose result the parent needs now uses
  `material_change`; after validating outputs, the parent explicitly closes
  the child with `complete_agent`. `completion` is reserved for explicit
  terminal lifecycle outcomes. The SDK now preserves `childContract` through
  child creation and durable orchestration input.
- **Validation:** the exact CHK `CHILD_UPDATE type=completed` payload wakes the
  parent under `material_change` with no suppression event. Contract
  propagation, prompt contracts, classification, parent batching, and SDK
  build checks passed. No live model compatibility claim is made.

## 2026-07-18 — Reactive parent coordination

- **Agent:** framework base agent (`packages/sdk/plugins/system/agents/default.agent.md`)
- **Version:** `1.6.1` → `1.7.0`
- **Models:** model-independent prompt contract; no model sweep run
- **Problem:** the base prompt preferred `wait` + `check_agents` polling, and
  orchestration `1.0.61` falsely warned that a parent with running children
  would never wake automatically without a timer. In practice, qualifying
  child updates already wake the parent according to `contract.wakeOn`, so
  parents created redundant one-minute cron loops that often did no work.
- **Change:** parent coordination is now explicitly reactive. Parents finish
  normally after spawning, inspect status after child wake-ups or explicit
  requests, and reserve `wait_for_agents` for synchronization barriers. Timers
  remain valid only for independent deadlines, retries, and external checks.
  Orchestration `1.0.62` removes the forced forgotten-timer continuation.
- **Validation:** focused static prompt/tool/orchestration contract passes. No
  live model compatibility claim is made until an end-to-end delegation trial.

## 2026-07-15 — Cross-owner session-message trust boundary

- **Agent:** framework base agent (`packages/sdk/plugins/system/agents/default.agent.md`)
- **Version:** `1.5.0` → `1.6.0`
- **Models:** model-independent prompt contract; no model sweep run for this release
- **Change:** cross-session messages tagged `relation=cross-owner` are advisory.
  The receiving session preserves its owner's task, helps only when consistent
  with that task, and replies with `verdict="declined"` when a peer-owned
  session attempts to distract, conflict with, or redirect the mission.
- **Expected behavior:** same-owner tree and system-session coordination remains
  unchanged; cross-owner messages cannot override owner instructions. Runtime
  authorization still decides whether delivery is allowed before the prompt is
  seen.
- **Validation:** tests were intentionally skipped during the release workflow
  at maintainer request. No model-compatibility claim is made here.

## Historical Notes

The repository-scoped operational log at `/memories/repo/agent-tuning-log.md`
contains earlier prompt-hardening investigations and the current model
compatibility matrix. Future prompt changes should update both that operational
log and this version-controlled record.
