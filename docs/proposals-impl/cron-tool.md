# Cron Tool — Declarative Recurring Schedules

## Status

Implemented, unreleased. Published-package prechecks depend on the executable
package authorization controls consolidated in the same runtime PR; this proposal is not release or deployment
authorization. The current API and examples are in
[SDK apps](../developer/building/sdk-apps.md) and
[building agent packages](../building-agent-packages.md).
The review and precheck-selection workflow is in
[package review setup for executable prechecks](#package-review-setup-for-executable-prechecks).

**Upstream reconciliation:** cron prechecks now run on orchestration **1.0.83**.
Upstream used 1.0.82 for queued-prompt/FIFO fixes while this PR was open. Its
exact implementation is frozen under `orchestration_1_0_82/`, with hashes
checked in tests, and those queue fixes remain in the new active handler.
Existing executions are not reset or replayed through a different 1.0.82 body.

Package prechecks use manifest-declared generic supervised callbacks, not the
unreleased legacy `createCronPrechecks`/`cronPrechecks` exports. Arming captures
package/version/full-artifact SHA and binding revision; timers and
continue-as-new retain that exact pin. Current-owner/binding/tool admission
occurs in activities, never deterministic replay. Pending content imports
nothing; denial, timeout, caught failed calls and unfinished calls cannot skip a
model turn. Approved empty-queue callbacks skip without model hydration.
Trusted `worker.registerCronPrechecks()` registration needs no new opt-in.

The review fixes also use the selected agent copy's authored name and namespace
for non-LLM MCP admission, reset the consecutive idle-skip count after ordinary
work turns, and reject malformed/mismatched PRECHECK acknowledgements rather
than displaying a successful change with an invalid revision.
Linux recovery handles a process disappearing during a procfs read (`ESRCH`)
as gone, while permission/I/O failures still deny recovery. Host-identity
probe failures are propagated and evicted from the cache so a later call can
recover; neither fix fabricates an identity or bypasses process fencing.

### Executable-only pin integration

Prompt-only agents, including historical NULL-policy sessions, may use trusted
static prechecks without a durable package binding or administrative rebind.
Declarative republishing follows the active copy as before; stale declarative
binding rows do not enforce a pin. No precheck opt-in still means no extra activity.

Package-owned executable callbacks require explicit matching package provenance,
a resolvable current owner, an approved exact version/digest and the schedule's
durable binding revision. Callback/tool/MCP registries are content-qualified.
Admission and every MCP call use the same current binding/copy resolver as normal
session hydration. An already-armed V1 schedule can continue on an approved,
authorized retained V1 after executable V2 activation, even if V2 removed its
agent name; it never silently calls V2. Retired registrations cannot arm new
package-owned schedules. Revocation or explicit rebind denies the old schedule
before callback entry. Declarative-to-executable and executable-to-declarative
transitions require explicit administrative rebind and deliberate schedule re-arm.
Static callbacks do not bypass executable-root admission.

Authenticated Web/TUI creation resolves package provenance server-side; lower-level
SDK callers creating package-named roots supply `boundAgentPackageId`. Both paths
continue forwarding `cronPrecheck`. Per-call authorization stays in activities,
not orchestration replay; resolved `state.config` drives resumed dispatch and the
persisted immutable identity survives continue-as-new.

### Executable-only integration acceptance

The local merged candidate passed the root `npm run build`, full SDK units
under Git Bash (`usr/bin` first, concurrency two): **1,632 passed, nine skipped,
zero failed**, and **61 approval/status surface tests**, zero skips/failures.
The nine Windows skips remain explicit POSIX/Linux/process-platform limitations,
not Linux evidence. The final private/shared admission and authenticated creation
fixtures also passed their focused **20-case** rerun.

The isolated localhost PostgreSQL 18.4 preflight verified SCRAM on every host
authentication rule and passed all **seven cron activity cases**, including
historical declarative/no-binding static checks, both code transitions,
retained V1 after V2 activation, stale rebind, revocation and zero new callback
entry after denial. These overlap the complete runtime suite, not additive counts.
The complete `package-runtime.test.mjs` suite then passed **91 cases, zero
failures/skips**, with TAP reporting and a 120-second per-test timeout on that
task-owned SCRAM server.
The seven native cron suites plus the normal agent-binding refresh regression
suite passed **78 tests across eight files, zero failures/skips**. This includes
the real-worker historical declarative/static fixture: no binding row or rebind,
two idle cycles with zero additional model requests, then a normal work cycle.
The first native run exposed a missing package-ID field in the new owned-MCP
fixture (73/74); correcting the fixture to exercise owned rather than static
admission passed its focused 25-case suite and the complete 78-case rerun.
The final SDK-unit rerun confirmed the same 1,632/9/0 result. Indexed repository
privacy validation reported zero findings. Task-owned scratch and `.test-*`
directories were removed; PostgreSQL port 55547 was verified closed and no
remaining test/runtime process named this worktree in its command line.
No operator database, deployment, commit or push is part of this validation.

### Earlier integrated acceptance snapshot

The counts and Linux runs below describe earlier candidates, not validation of
the subsequent executable-only pin integration.

The integrated candidate passed the root full build and:

* The five targeted cron Vitest files (`cron-precheck`, `cron-tool`,
  `cron-precheck-orchestration`, `cron-precheck-mcp`, `cron-precheck-routing`):
  **68 passed**, zero skips.
* `node --test packages\app\web\test\agent-package-review-authz.test.mjs packages\app\mcp\test\unit\agent-package-reviews.unit.mjs packages\app\ui\core\test\package-review-tabs.test.mjs`:
  **21 passed**, zero skips, covering authenticated fleet-admin authority,
  discarded client actor/admin flags, review operations and tab ordering.
* `node --test --test-reporter=tap --test-concurrency=1 packages\sdk\test\postgres\package-runtime.test.mjs`:
  **41 passed**, zero skips, against a separate standalone PostgreSQL 17 cluster
  using **SCRAM**, not PGlite or an operator database. This includes real process
  counters, browser review/activation/revoke, multiple workers, failed startup,
  authority outage, exact cron pins, actual current root-owner/config mutation,
  timeout fencing and callback denial.
* Real native worker/SDK/CLI tests in `cron-precheck-live.test.js` and
  `cron-precheck-package-live.test.js`: **four passed**, zero skips, against
  standalone SCRAM PostgreSQL. Both package variants proved pending
  import/factory/callback counts zero; approval plus activation produced exactly
  one import/tools factory/callback factory in the same non-parent PID. Two idle
  callback cycles produced zero additional model requests. The packaged-MCP
  variant had one supervised server start and at least two tool calls. Warm
  revocation/refresh added zero new execution counter entries. Trusted static
  registration, session defaults and shadow behavior remained operational.
* From `packages\sdk`, Git Bash with Git's `usr/bin` first on `PATH`:
  `node --test --test-concurrency=2 test/unit/*.test.mjs`:
  **1,609 passed, nine skipped, zero failed**. Scratch lived inside the checkout;
  the Git fixture now prevents ancestor-repository discovery itself, rather than
  inheriting a ceiling its isolation function strips. The nine skips concern
  Unix permissions/UIDs/sockets, Linux process/mount metadata and process groups,
  including one local-Git-version-dependent UID test. They are **not** claimed
  as Linux acceptance.

The integrated code at `9184f58` also passed the
[actual Linux workflow](https://github.com/seanzqliang/PilotSwarm/actions/runs/39097488723):
root build, pidfd/Python preflight, policy/shell checks and **41 runtime cases,
zero failures/skips**, including the cron activity paths. The prerequisite at
`b358ba1` independently passed its
[37-case Linux runtime matrix](https://github.com/seanzqliang/PilotSwarm/actions/runs/39097369867).
These overlap local tests; their counts are not additive.

The earlier Linux run failed the passwordless broker-role fixture under SCRAM;
passing other cases did not make that run pass. Both branches now generate and
forward matching synthetic credentials and verify cleanup after failed broker
initialization. Hosted Ubuntu is not certification of the actual worker image.
Image prerequisites, trusted external legacy/remote-worker fencing proof,
acceptance reconciliation and exact Claude Opus 4.8 review remain gates.
No deployment or completed-candidate security approval is claimed.

## Package review setup for executable prechecks

Status: **phases 1–4 implemented, unreleased** (review diff, review panel,
session `PRECHECK` selector, notifications), in this PR. **Phase 5, the
`package-reviewer` agent, is implemented in a separate agent-layer PR stacked
on it** (see [phase 5 notes](#implementation-notes-phase-5-package-reviewer)).
Phase 6 is the acceptance run. See
[implementation notes](#implementation-notes-phases-14) for where the code
differs from the design text below. This section adds review usability
around the existing package-approval controls. It does not change any
security rule above.

### Why this is needed

A package-owned precheck is executable code, so it goes through the shared
executable-package review: admin approval of the exact full-artifact digest,
then per-invocation session authorization. That control is required because
many users publish arbitrary agents to a shared cluster. Its cost is review
latency: every new executable version waits for an administrator. Without a
fast, precise review path, prechecks become impractical, and authors will
fall back to idle LLM polling.

Goal: an administrator can review a typical precheck update in minutes, and
a session owner can choose exactly which approved precheck a cron schedule
uses.

### What stays unchanged

- Approval is bound to package ID, version ID and the full canonical tar
  SHA-256. Activation, rebind, session pins and per-invocation admission stay
  separate controls.
- Every changed executable version needs approval, including a prompt-only
  change inside a mixed package. Approval is never reused across digests
  (see decisions).
- Only deterministic inspection and an authenticated administrator decide.
  No diff, summary or assistant output is an approval or a security proof.
- Remote MCP and backend implementations remain outside package approval.

### Main components

| # | Component | Surface | Authority |
|---|---|---|---|
| 1 | Review diff API | Management/Web/MCP: `getAgentPackageReviewDiff` | Fleet admin; digest-bound |
| 2 | Change classification | Produced by the trusted inspector | Deterministic; not LLM |
| 3 | Review panel | Settings → Packages → Pending Approval | Admin decides |
| 4 | `package-reviewer` assistant | Admin-launched system agent session | Advisory only |
| 5 | Session `PRECHECK` selector | Session details, next to `CRON` | Session owner or fleet admin; server-validated |
| 6 | Review and broken-precheck notifications | Existing review status, plus notifications | Informational |

#### 1. Review diff API

`getAgentPackageReviewDiff({candidate, baseline?})`:

- `candidate` is `{packageId, versionId, sha256}` from the pending review row.
- `baseline` defaults to the newest **approved** executable version of the same
  package. If none exists, it falls back to the active version, and otherwise
  to "new package" (full file listing).
- Both artifacts are fetched from the artifact store and verified against
  their recorded digests (`fetchAgentPackageTarGz`). Catalog metadata comes
  from CMS. A digest mismatch fails the request; it never shows a stale diff.
- The API reuses the canonical-entry comparison behind `diff_agent_versions`
  (`diffPackageTrees`). Unlike that owner-scoped, semver-based tool, it
  addresses versions by exact digest and lets an administrator read another
  user's pending private version.
- Each response echoes both digests and the review revision. Any decision
  submitted from that view must carry the same values, so a republish or
  concurrent decision is rejected as stale.

#### 2. Change classification

The inspector already parses the archive without importing code. It
classifies every changed path into one of these groups:

- **Executable code:** `.js`/`.mjs` modules, callback/tool factories,
  packaged MCP entries.
- **Dependencies and runtime config:** `package.json`, imports, MCP
  command/args/environment.
- **Capabilities:** declared tools, MCP servers, callbacks and grants.
- **Cron precheck policy:** declared prechecks, reason bindings, intervals,
  shadow mode and max-skip settings.
- **Declarative:** agents, prompts, skills and Markdown.
- **Flagged:** binary, oversized, unsupported or unparseable content. These are
  shown as content hashes, not diffed.

The panel shows executable, dependency, capability and precheck-policy
changes first. A version with no executable changes still requires a
decision; the panel just makes that review short.

#### 3. Review panel (Pending Approval tab)

The existing tab already supports approve/reject/revoke, activation, rebind,
the file viewer and audit. Additions:

- A header with publisher, candidate and baseline digests, review revision and
  inspection reasons.
- Change summary counts per classification group.
- Side-by-side file diff, grouped and ordered by risk.
- An optional advisory review guide (component 4), clearly labeled as not an
  approval.
- Decisions remain: **Approve exact digest**, **Reject** (reason required) and
  **Revoke**, plus the existing separate activation step. Each is a CAS on
  candidate digest and review revision, audited with actor, reason and the
  baseline digest that was shown.

#### 4. Review assistant: new `package-reviewer` agent

Recommendation: add a new system agent, `package-reviewer`, rather than
extending `agent-manager`.

| Option | Pros | Cons |
|---|---|---|
| New `package-reviewer` (recommended) | Separation of duties: the author/publisher agent never reviews its own output. Least-privilege, read-only tool set. A dedicated adversarial-review prompt. Admin-only launch. | One more agent definition to maintain. |
| Extend `agent-manager` | Reuses existing package read/diff tools. No new agent. | It can stage, publish and enable packages, so it would hold both write and review authority. Self-review is possible. Larger prompt and tool surface for every authoring session. |

The new agent can reuse the existing read-tool implementations. Its tool set:

- Read-only: `get_agent_package_review_diff`, `read_agent_package_file`
  (exact digest), inspection results, review history and audit.
- No tools that stage, publish, enable, activate, approve, rebind, run a
  package or call package MCP.

Contract:

- Launched by a fleet administrator from the review panel for one candidate
  and baseline digest pair. The report is stored keyed by both digests and is
  shown only while they still match the pending candidate.
- Treats all package content as untrusted data, including instructions
  embedded in code, comments or prompts that try to influence the review.
- Never executes or imports package code.
- Report structure: verified facts (taken from inspector and diff output),
  then analysis and a step-by-step review guide (what changed, why it matters,
  what to check), then open risks. It does not output an approve/reject
  verdict.

The assistant comes after components 1–3. Reviews must work without it.
The implemented tool set differs slightly; see the
[phase 5 notes](#implementation-notes-phase-5-package-reviewer).

#### 5. Session `PRECHECK` selector

A `PRECHECK` field sits next to `CRON` in the session details panel.

Rules:

- **Enabled** only when the session has an active **interval** cron schedule.
  Hidden or disabled when cron is off, and for wall-clock `cron_at` schedules,
  which do not run prechecks.
- **Options:** `None`, plus prechecks declared by the session's exact bound
  agent identity:
  - Trusted deployment prechecks registered for that agent.
  - Package-owned prechecks from the session's pinned package version and
    digest, listed only when that exact content is approved and the session is
    currently authorized to use it.
  - Prechecks from other agents or unapproved versions are never listed.
- **Scope:** the choice applies to the current schedule only. It becomes the
  highest-precedence selection: operator choice (including explicit `None`),
  then the model's `cron(precheck=...)` name, then the agent reason binding,
  then the session default. It survives model re-arms and continue-as-new.
  Cancelling the schedule clears it.
- **Who can change it:** the session owner, or an authenticated fleet
  administrator acting on any session. An administrator's change is audited
  with actor, session, before/after precheck and reason. Options are always
  computed from the session's own bound agent and authorization, never the
  administrator's.
- **Enforcement:** the request carries the schedule revision. The server
  re-validates the caller, agent identity, approval and binding, then delivers the
  change to the orchestration as a command. The schedule captures the exact
  package, version, digest and binding pin as today. A stale schedule revision
  or a no-longer-eligible precheck is rejected; it is never silently replaced.
- User messages and other pending work still bypass the precheck, as today.

#### 6. Review and broken-precheck notifications

**Review notifications.** Review status is already visible to owners and
editors. Add a notification on approve/reject/revoke that includes the reason,
and an "approved, not active" reminder, so publishers do not have to poll.

**Broken-precheck notifications.** A broken precheck does not stop work: the
existing fail-open path runs a normal model turn, so the impact is token cost
on cycles with no work, not missed work. Therefore:

- **No automatic rollback, revoke or disable.** The schedule keeps running and
  the approved version stays in place.
- **Explicit notification so the fix lands quickly.** Outcomes `error`,
  `timeout`, `invalid` and `unregistered` count as broken. `max_skips` is a
  deliberate forced turn and is not broken. Revocation or binding denial keeps
  its existing explicit-denial behavior and is not part of this alert.
- **Recipients:** only the package owner (to publish a fix) and the session
  owner (who pays the token cost). Package editors and fleet administrators
  are not notified.
- **Content:** package, version, digest, precheck name, session, outcome,
  first/last seen, consecutive count and a sanitized error summary. It never
  includes package secrets or raw tool output.
- **Deduplication:** one notification per schedule, digest and outcome when
  the failure starts, plus a periodic reminder while it continues (proposed
  daily). A recovery notice is sent after the next successful `run` or `skip`.
- The session details panel also shows the broken state next to `PRECHECK`.

The fix is a new package version through the normal review; the
grouped diff keeps that review short.

### Execution plan

| Phase | Deliverables | Exit tests |
|---|---|---|
| 1. Diff and classification | `getAgentPackageReviewDiff` across management, Web, MCP and CLI. Classification in the inspector. Digest/revision echo. | Admin-only authorization. Private-package access for admins only. Digest-mismatch denial. Baseline selection (approved / active / new). Classification fixtures for every group. Stale-decision CAS. |
| 2. Review panel | Pending Approval header, summary, grouped diff and decisions bound to the shown digests. | UI tests: ordering, flagged content, stale-view rejection. Audit records the baseline digest. |
| 3. Session selector | `PRECHECK` field, options API and orchestration command. Precedence and lifecycle. | Disabled without interval cron. Filtering by exact agent identity and approved pin. Stale revision rejected. Survives re-arm and continue-as-new. Cleared on cancel. Owner and fleet admin can change it; other users are denied. Admin changes are audited, and options come from the session's binding, not the admin's. Native idle-skip and work-cycle tests. |
| 4. Notifications | Approve/reject/revoke and approved-not-active notifications. Broken-precheck alert, reminder and recovery notice. | Review notices go only to owner and editors. Broken alerts reach only the package owner and session owner. No private-package leakage or secrets. Dedup per schedule/digest/outcome. No rollback or disable on failure; the fail-open model turn still runs. `max_skips` and denial do not alert. |
| 5. `package-reviewer` agent | Agent definition, read-only tool set, digest-keyed report storage, panel launch. | Tool allowlist test (no write or execute tools). Prompt-injection fixtures. Report hidden after republish. Reviews still work with the agent disabled. |
| 6. Acceptance | Extend the existing review and cron suites. Linux workflow. | No reduction in existing approval, admission or fencing coverage. |

Phases 1–4 are the minimum useful set; broken-precheck alerts are required
because failures are not rolled back. Phase 5 can ship later.

### Negative impacts and costs

- **Review latency remains.** Even a fast review is an admin round trip for
  every executable version. Prechecks cannot be hot-fixed without an
  administrator.
- **Mixed packages pay for prompt edits.** Under full-artifact approval, a
  prompt-only change in a package that also ships code needs a new decision.
- **Broken prechecks cost tokens until fixed.** With no automatic rollback,
  idle cycles fall back to model turns until a fixed version is approved and
  the schedule picks it up.
- **Only fleet administrators review,** so they can become a bottleneck.
- **Re-arm after updates.** A new approved version does not move existing
  schedules; owners must rebind and re-arm, or select the precheck again.
- **Assistant cost and trust.** The assistant consumes model tokens per
  review, and its analysis can be wrong or manipulated. It is advisory only.
- **No coverage of remote services.** Approving a package does not review the
  remote MCP server or backend it calls.
- **More surface to maintain.** New API, UI panels, an orchestration command,
  an agent and tests.

### Decisions

1. **No approval reuse.** The absolute rule ships first: every full-artifact
   digest needs its own decision, even when executable bytes are unchanged.
   Reuse may be considered later as an optimization.
2. **Reviewers are fleet administrators only** for now. Delegated reviewers
   are not in scope.
3. **Broken prechecks are not rolled back.** The cost is extra tokens on idle
   cycles, not lost work. An explicit notification drives a fast fix
   (component 6).
4. **Administrators can change the `PRECHECK` selection** on any session, in
   addition to the session owner, with audit.
5. **Broken-precheck notifications go only to the package owner and the
   session owner.** Package editors and fleet administrators are not notified
   of broken prechecks. Review-decision notices still go to the package owner
   and editors.
6. **Three PRs, one per layer.** PilotSwarm runtime (phases 1–4, this PR),
   Waldemort integration/adoption, and the `package-reviewer` agent.

### Implementation notes (phases 1–4)

What shipped, and where it differs from the design text above:

- **Review diff.** `getAgentPackageReviewDiff` is exposed over management,
  Web (`GET`, admin-only), MCP and CLI. Classification groups are
  `executable`, `dependency`, `capability`, `precheck-policy` and
  `declarative`. "Flagged" is a marker on a file within its group, not a
  separate group; an unrecognized file type is flagged and ranked as
  `executable`. A decision made from the diff carries the baseline it showed,
  and the audit reason records that baseline digest.
- **Review panel.** `PackageReviewDiffPanel` in the Pending Approval tab shows
  both digests, the review revision, per-group counts and the grouped diff.
  Decisions it does not allow are disabled.
- **Selector validation.** The orchestration accepts an operator choice only
  from the options it resolved when the schedule was armed. Approval, binding
  and current-owner authorization are re-checked on every fire by the
  precheck activity, as for any precheck, rather than separately at selection
  time.
- **Worker prechecks.** Trusted `worker.registerCronPrechecks()` prechecks are
  listed for every session on the worker, matching how `chooseCronPrecheck`
  already resolves them. They are not scoped per agent.
- **Schedule revision.** The revision increments on every agent re-arm, so a
  selector view can go stale while the model re-arms; the UI must refresh and
  retry. Stale revisions are rejected (`CONFLICT`), never applied.
- **Health streak.** Only a real `run`/`skip` answer clears a broken streak.
  `max_skips` does not call the precheck, so it neither clears nor extends
  the streak, and it neither alerts nor recovers.
- **Operator change.** Changing the selection drops the schedule's broken
  streak. Already-open broken notifications stay open until the next recovery
  on that session.
- **Notifications (migration 0090).** Table `user_notifications` plus
  `cms_*` procedures; the portal reads them through `listMyNotifications` and
  `markNotificationsRead` (any authenticated user, own rows only, chosen by
  the server principal). Available in the package catalog's Notifications tab
  (next to Private / Pending Approval / Shared) and
  `pilotswarm agents notifications [read [ids]] [--unread]`.
  - Review notices are written by a trigger on the review audit, in the same
    transaction as the decision. A notification failure logs a warning and
    never blocks the decision. "Approved, not active" is a live flag computed
    when listing, so it clears as soon as that exact version is activated; no
    periodic job.
  - A broken alert has one open row per recipient, session, precheck, digest
    and outcome. Repeats increase its count; after a day a repeat re-notifies
    (unread again). The next real `run`/`skip` closes all open alerts for the
    session and sends a recovery notice.
  - Alerts carry a fixed summary per outcome, never the precheck's detail
    text. The package owner's copy omits the session ID.
  - Trusted worker prechecks have no package owner, so only the session owner
    is notified.
  - There is no retention job yet; notification rows accumulate.

### Implementation notes (phase 5, package-reviewer)

Separate agent-layer PR, stacked on phases 1–4. Advisory only: nothing in it
approves, rejects, revokes or activates, and the review panel works without
it.

- **Agent.** `agent-packages/package-reviewer` (declarative, no code) is
  published like any agent package. A fleet administrator starts it from the
  review panel with **Ask package-reviewer**; the opening prompt names the
  exact candidate and baseline digests on screen.
- **Hard tool allowlist.** A session whose bound agent identity is
  `package-reviewer` is created with the Copilot SDK `availableTools` set to
  exactly five tools, and with no app or system tools, MCP servers, skill
  directories, custom agents or workspace tools. Sub-agent spawn and
  inter-session messaging are refused. Naming an agent `package-reviewer` only
  ever narrows its tools. File hooks, discovered skills and filesystem custom
  instructions are explicitly disabled as well; omitting directories alone
  does not disable the Copilot runtime's automatic discovery.
- **Tools.** `list_agent_package_reviews` (pending only),
  `get_agent_package_review_diff` (large patches are left out and named, to
  read by file, with a 96 KiB UTF-8 limit including response metadata),
  `read_agent_package_review_file` (candidate or baseline,
  sliced; binary returns only a digest), `read_agent_package_review_audit`
  and `submit_package_review_report`. Every call re-checks that the session
  owner is an unrestricted fleet administrator, never the system principal;
  anonymous no-auth operators are refused too. Otherwise it fails closed.
  Reviewer calls bypass the inspect-viewer cache,
  so ownership changes, demotions and lookup failures apply to the next call.
  All package content is labelled untrusted.
- **Report storage (migration 0091).** Insert-only table
  `agent_package_review_reports`, written and read only through admin-only
  `cms_*` procedures. A report binds the exact candidate digest, the baseline
  the diff policy selects (or none), the reviewer session and author. Content
  is a closed shape (facts, analysis, guide, risks); a verdict-like key is
  refused by both the store and a table constraint.
- **Visibility.** The panel shows the newest report only while the candidate
  is still pending with that digest and the baseline still matches; after a
  decision or a baseline change it is hidden. A report load failure never
  blocks the diff or the decision buttons. Matching includes package and version
  IDs, not just digests. Switching/closing a diff invalidates outstanding
  requests, and only the newest report refresh can update the panel.
- **Not done.** Report access from MCP and the CLI. No report retention job.

## Problem

The current `wait()` tool is imperative — the LLM must call it at the end of every turn to keep a recurring loop alive. If the LLM forgets (common with gpt-5.4), the loop dies silently. We've added prompt hardening (rules 5-6), a forgotten-timer safety net (orchestration nudge), and child-update batching to work around this, but the root cause remains: the orchestration depends on the LLM remembering to call `wait()` every single turn.

## Solution

Add a `cron` tool that lets the LLM declare a recurring schedule once. The orchestration owns the timer loop — not the LLM.

## Tool API

### `cron(seconds, reason)` — Set or update a recurring schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `seconds` | number | yes | Interval between wake-ups (minimum 15s) |
| `reason` | string | yes | What the LLM should do on each wake-up (e.g. "check sub-agents and summarize news") |

Returns: `{ status: "scheduled", interval: 45, reason: "..." }`

### `cron("cancel")` — Cancel the active schedule

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `"cancel"` | yes | Cancels the active cron |

Returns: `{ status: "cancelled" }`

### Design decisions

- **Simple interval, not cron syntax.** LLMs will butcher `*/5 * * * *`. Every real use case is "every N seconds."
- **One cron per session.** Calling `cron()` again replaces the current schedule. No multi-cron complexity.
- **Minimum 15s interval.** Prevents runaway wake-ups.
- **`reason` is mandatory.** It becomes the wake-up prompt, so the LLM knows what to do on resume.

## Orchestration Behavior

### When `cron()` is called (new `case "cron"` in result dispatch)

1. Store cron state: `{ intervalSeconds, reason }` in `OrchestrationInput.cronSchedule`.
2. Respond to the LLM: `"Recurring schedule set: every {N}s — {reason}"`
3. Continue the current turn (LLM may do more work before completing).

### When a turn completes (`case "completed"`) with an active cron

Instead of going idle or requiring the LLM to call `wait()`:

1. Publish status `"waiting"` (same as current wait behavior).
2. Schedule a durable timer for `cronSchedule.intervalSeconds * 1000` ms.
3. Race timer against inbound messages (same as current wait race pattern).
4. **Timer fires →** `continueAsNew` with prompt:
   ```
   [SYSTEM: Scheduled cron wake-up for: "{reason}". Resume your recurring task.]
   ```
5. **User message interrupts →** deliver user message to LLM (same as wait interrupt). Cron stays active — next completed turn will schedule again.
6. **Child update interrupts (<=60s remaining) →** absorb silently (same as current batching).

### When `cron("cancel")` is called

1. Clear `cronSchedule` from orchestration state.
2. Respond: `"Recurring schedule cancelled."`
3. Subsequent `case "completed"` goes to normal idle behavior.

### Cron + `wait()` interaction

They're independent. Within a cron cycle, the LLM can still call `wait()` for one-shot delays:

```
[cron fires] → LLM spawns sub-agents → calls wait(10) to poll → poll completes →
LLM summarizes → turn completes → orchestration auto-schedules next cron fire
```

If the LLM calls `wait()` while a cron is active, `wait()` takes precedence for that specific pause. After the wait completes, the turn continues. When the turn eventually completes, the cron timer fires.

### Cron + dehydration

Cron timer is handled identically to wait timer for dehydration:
- If `intervalSeconds * 1000 > dehydrateThreshold` → dehydrate, fire timer, rehydrate.
- `cronSchedule` state survives in `OrchestrationInput` across `continueAsNew`.

## State Changes

### `OrchestrationInput` (types.ts)

```typescript
/** Active recurring schedule set by the cron tool. */
cronSchedule?: {
    intervalSeconds: number;
    reason: string;
};
```

Carried across `continueAsNew` in `continueInput()`.

### `customStatus` (published to CMS)

Add `cronActive: boolean` and `cronInterval: number` to the custom status so the TUI can show cron state.

## Files to Modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `cronSchedule` to `OrchestrationInput` |
| `src/managed-session.ts` | Add `cron` tool definition + result type |
| `src/orchestration.ts` | Add `case "cron"` handler + cron-aware idle logic in `case "completed"` |
| `plugins/system/agents/default.agent.md` | Add `cron` to tools list + update rules |
| `packages/ui-core/src/selectors.js` | Show cron state indicator in the session list and related status surfaces |

## Agent Prompt Changes

Rules 5-6 change from:

> 5. NEVER end a turn without calling `wait()` if you have pending recurring work...
> 6. Every turn that is part of a recurring loop MUST end with a `wait()` call...

To:

> 5. For recurring/periodic tasks (monitoring, polling loops, scheduled digests), use `cron(seconds, reason)` once. The orchestration handles the schedule — you do NOT need to call `wait()` at the end of each turn.
> 6. Use `wait(seconds)` only for one-shot delays within a turn (e.g. poll sub-agents, brief pause before retry). `wait()` is not needed for recurring loops if `cron` is active.
> 7. Use `cron("cancel")` to stop a recurring schedule.

The forgotten-timer safety net remains as a fallback but should rarely fire once `cron` is adopted.

## Example Flow

User: "Monitor news headlines every 45 seconds"

```
Turn 1: LLM calls spawn_agent(3 news agents), calls cron(45, "check sub-agents and summarize news"), outputs "Started monitoring."
         → orchestration stores cronSchedule, schedules 45s timer
         → [45s passes]
Turn 2: Orchestration wakes LLM with "[SYSTEM: Scheduled cron wake-up for: check sub-agents and summarize news]"
         → LLM calls check_agents, reads facts, outputs summary table
         → turn completes → orchestration auto-schedules next 45s timer
         → [45s passes]
Turn 3: Same pattern, indefinitely
         ...
User: "Stop monitoring"
Turn N: LLM calls cron("cancel"), outputs "Monitoring stopped."
         → turn completes → goes to normal idle (no more cron fires)
```
