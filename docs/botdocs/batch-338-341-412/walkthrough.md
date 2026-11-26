# Walkthrough: pull request #415 (issues #338, #341 and #412)

This walkthrough is for a reviewer who did not follow the work. It explains
what pull request [#415](https://github.com/microsoft/PilotSwarm/pull/415)
changes, the order in which to read the diff, how the parts interact, which
tests cover them, and where to look most carefully.

- Base: `main` at `b79be29d` (release 0.8.19).
- Reviewed head: `1759802172ea0f96df5fb098c84e8d39d4bc0c4b`. Every code link
  below is pinned to this commit.
- The batch merges two pull requests, in this order:
  [#413](https://github.com/microsoft/PilotSwarm/pull/413) for issue #341
  (merge commit `915e21b3`), then
  [#414](https://github.com/microsoft/PilotSwarm/pull/414) for issue #412
  (merge commit `17598021`). Both pull requests stay open.
- Issue #338 was declined. It has no code in this pull request.
- Size: 41 files, 4,960 lines added and 105 removed. About 2,000 of the added
  lines are the formal models under `docs/formal/workflow/retention/`, and
  about 1,500 are the eight issue documents under `docs/botdocs/`.

## Terms

Each term is defined once here and used with this meaning below.

| Term | Meaning |
|---|---|
| Session state | The `state` column of a session row: for example `pending` (no first message yet), `running`, `idle`, `completed`, `cancelled`, `failed`. |
| Ended session | A session whose state is `completed`, `cancelled` or `failed`. |
| Active session | A session row that exists, is not deleted and has not ended. An `idle` or `pending` session is active. |
| Workflow session | The child session that one Start of a Workflow creates. It holds the run: the graph, every step visit with its input and output, the Log, the variables and the messages. |
| Owning session | The session that started a Workflow. It is the Workflow session's parent. |
| Ancestors | The owning session, its parent, and so on up to the root session. |
| Test bench | A hidden Workflow session that runs a definition test (`service_kind = 'workflow-test'`). It has its own retention rule: the newest 5 ended tests per definition. |
| Finished Workflow session | A Workflow session that is not deleted, is not a test bench, has at least one live run, and has no run that is `admitted`, `running` or `paused`. |
| Kept session | A finished Workflow session that has an active ancestor, and every session under that Workflow (its agent node sessions, the sessions they started, its child Workflows). |
| Sweeper | The system agent that cleans up sessions. Its tools: `scan_completed_sessions` (lists candidates), `cleanup_session` (deletes a session and all its descendants) and `prune_orchestrations` (deletes old orchestration history, then deletes session rows whose orchestration is gone). |
| Final check | The one database transaction in which the Sweeper reads its target again under row locks and then soft-deletes it: `WorkflowStore.sweeperSoftDelete`. |
| Prune | The session pass of `prune_orchestrations`. It deletes a session row whose orchestration reads `NotFound` **without** cascade: it deletes the session and its Workflow children, and leaves its other descendants in place. |
| Event purge | The Resource Manager tool `purge_old_events`. It deletes session events older than a cutoff (24 hours by default). The Workflow Log reads these events. |
| Terminated row | The row in the session list that groups the ended children of a session. |
| `NOWAIT` lock | A row lock that fails at once (SQLSTATE `55P03`) when another transaction holds the row. The Sweeper turns that failure into the refusal `Busy` and tries again on a later scan. |
| Migration | A numbered function in `packages/sdk/src/migrations/` that returns SQL. The migrator runs each version once per database and records it by its version number. |
| Fixture skeleton | A ready-to-fill test fixture that a Workflow test report suggests for a call that has no prepared answer. |
| `noul` Decision | A yes-or-no Decision question. The live Decision service answers it with only `{ noul: <probability of yes> }`. |

## 1. What the batch changes

### Issue #338: Node panel visit facts (declined, no change)

**The claim.** A Decision state in a loop has three visits. In a live Workflow,
the person chooses visit 1 in the Log. The issue says the Node panel then shows
"Outcome billing, Confidence 60%" from visit 3 above a section headed "Visit 1
of 3" whose output says "engineering".

**What really happens.** No control in the shipped portal can make that
choice. A click on a visit in the Run Log starts time travel (a replay of the
run at that moment), not a live visit choice:

1. The visit line calls `replay.onVisit(id)`
   ([workflow-tab.js L1520][B-tab-1520]), which calls `goTo(index)`
   ([L978][B-tab-978], [L915-L921][B-tab-916]).
2. In time travel the Node panel gets `selection: null`
   ([L1339][B-tab-1339]). The Decision facts and the Visit section then both
   describe the replayed visit.
3. Only two things set a live visit choice: the TUI's `[` and `]` keys
   ([tui/src/app.js L92][B-tui-92]) and the History tab of
   `WorkflowNodePane` ([workflow-workspace.js L342][B-ws-342]). The portal
   mounts `WorkflowTab` ([web-app.js L7947][B-web-7947]), not
   `WorkflowNodePane`. The TUI already shows the chosen visit's Decision facts
   ([workflow-tui.js L1811-L1813][B-tui-1811]).

**Result.** No pull request. The regression test that was first written for
this issue passed a live visit choice straight into the Node panel, which no
portal control can do, so it did not show a real defect. The issue is still
open.

**Risk.** None in this pull request. One latent point:
`WorkflowNodeSummary` still computes the Decision facts from the current visit
([workflow-panels.js L567][B-panels-567]). It becomes visible only if the
portal mounts `WorkflowNodePane` later.

### Issue #341: Decision node cleanups and release notes

**The problem.** The final review of PR #328 (the Decision node) left seven
small items and one release-note finding (F14). The one with a real effect:
migration 0098 wrote the schema name without escaping a double quote.

Example. For the schema name `a"b`, PostgreSQL needs the identifier `"a""b"`.
Migration 0098 wrote `"a"b".provider_cluster_settings`, which is a syntax
error. The other migrations of the Decision work (0096, 0097, 0099 to 0103)
already wrote `"a""b"`.

A second example. When a Workflow test meets a yes-or-no Decision call with no
prepared answer, the test report suggested the fixture
`{ type: "noul", noul: 1, probabilities: { true: 1, false: 0 } }`. The live
service never sends `probabilities` for `noul`, so the suggestion did not show
the real shape.

**The change.**

| Item | Result | Change |
|---|---|---|
| 1. 0098 escaping | Fixed | `"` in the schema name becomes `""`. For a name without `"`, the SQL is byte for byte the same as before. |
| 2. Guidance names `workflows.decision.available` | Already fixed on `main` (PR #355) | None |
| 3. `max` ignored when `stored` is true in `agent-models.ts` | Fixed, same limits | The module-private parser takes one `limit`. Each caller passes its number: 64 for a request map, 100 (`WORKFLOW_MAX_NODES`) for a stored map. |
| 4. A frozen effect comment says "released 1.1.0" | No change | The sentence became true when 0.8.14 shipped, and the file is byte-pinned. |
| 5. Two frozen effect modules copy about 110 lines | Comment added | Two lines at the import site in `workflow/runtime.ts` say the copies are on purpose. The frozen files are untouched. |
| 6. `foundry-wif` in the portal rule | Release note | 0.8.14 "Other changes in this release". |
| 7. `noul` fixture skeleton | Fixed | Suggests `{ type: "noul", noul: 1 }`. A fixture with `probabilities` still parses. |
| F14. Paths #328 changed without a Decision | Release notes | Four bullets in the same 0.8.14 subsection. |

**Risk: low.** The only change with runtime effect is the text of a released
migration. For every schema name without `"`, the SQL is unchanged (a test pins
its SHA-256), and the migrator does not run a recorded version again. No API,
tool, wire shape, orchestration, controller, effect or migration version
changes.

Documents: [design-spec.md][B-341-design], [impl-spec.md][B-341-impl],
[test-spec.md][B-341-test], [implementation-report.md][B-341-report].

### Issue #412: keep finished Workflow sessions while an ancestor is active

**The problem.** On `main`, the Sweeper deleted a finished Workflow session
like a completed sub-agent: at its next scan (every 6 hours), once the session
was older than 5 minutes. Only the terminal result was copied to the owning
session.

Example. The owning session `O` is idle. Its Workflow `W` ends at 23:32 with
outcome `blocked` at the state `unverified`. The agent session `A` that ran the
state `verify` ends with it. At the next scan the Sweeper deletes `W` and `A`.
The next morning the owner opens `W`: the graph, the timeline, the Log and the
input and output of `verify` are gone. `read_workflow` returns only the output
text. To see why the step decided `unverified`, the owner must run the whole
Workflow again.

A second path loses the Log even when the sessions stay: the event purge
deleted every event older than 24 hours, and the Log reads those events.

**The change.** The Sweeper never deletes a kept session. When the Workflow
and every session above it have ended, the existing cascade cleans them
together. An explicit delete is unchanged.

| Path | Change |
|---|---|
| `scan_completed_sessions` | Does not list a session whose cleanup would delete a kept session. |
| `cleanup_session` | Refuses with the new status `WorkflowKept`. The words name the Workflow, the active ancestor and its state. |
| Prune | Skips a row whose delete would remove a kept session, or would leave a Workflow session under a deleted parent. |
| Final check | Asks again under its locks. Refuses with `WorkflowKept`, or, for a prune, with the new status `WorkflowBelow` when a Workflow session lies under the target and the delete would leave it in place. When a Workflow is in or above the delete set, it also holds every session above the target `FOR SHARE NOWAIT`. |
| Event purge | Keeps the old events of a finished Workflow session and of every session under it. One transaction, so a failure deletes nothing. |

Worked cases (from design-spec.md §3.3). `P` is the owner's parent, `O` the
owner, `W` a finished Workflow of `O`, `A` an agent session of `W`.

| States | Sweeper target | Result |
|---|---|---|
| `O` idle | `W` or `A` | Refused `WorkflowKept`. Not listed by the scan. |
| `P` idle, `O` completed | `O` | Refused: its cleanup would delete `W`, and `P` is active. `O` and `W` stay. |
| `P`, `O`, `W`, `A` all ended | `P` | Cleaned with `O`, `W` and `A`. |
| `O` pending (never got a first message) | `O` (reads `NotFound`) | Refused: `O` is active. |
| A person deletes `O` or `W` | — | Deleted at once, as before. |

Why the locks: the kept decision also depends on sessions **above** the target,
which the delete does not lock. Review round 1 showed a sequence with no serial
order: the Sweeper reads the root as ended; the root accepts a new first
message and becomes `running`; the owner reads the whole Workflow; then the
delete commits and the Workflow disappears. A `FOR SHARE` lock on each session
above the target makes such a change either commit first (the check then sees
it) or wait until the delete commits.

**Risk: medium to high.** The change adds locks to the Sweeper's final
transaction and a new two-phase delete to the event purge. Storage grows with a
long-lived owner's finished Workflows; the issue asks for no cap. One review
finding is still open (see section 5), and two gates did not run in the
implementation step: the PostgreSQL plus live HorizonDB matrix, and live-model
checks of the Sweeper's edited instructions. No migration and no orchestration
or controller version.

Documents: [design-spec.md][B-412-design], [impl-spec.md][B-412-impl],
[test-spec.md][B-412-test], [implementation-report.md][B-412-report].

## 2. Reading order through the diff

Read #341 first (small, about 10 minutes), then #412.

### Issue #341

1. Migration 0098, the escape:
   [cluster-decision-default-0098.ts L3][B-0098-3]. Then the inventory fixture
   that stores the file's git blob hash:
   [composition-migrations.json L314-L317][B-fixture].
2. One limit parameter:
   [agent-models.ts L173-L181][B-am-173] (the parser),
   [L226-L233][B-am-226] (two callers),
   [L346-L351][B-am-346] (the stored reader).
3. The `noul` skeleton: [definition-test.ts L205-L207][B-dt-205].
4. The deliberate copies note: [runtime.ts L1-L5][B-rt-1].
5. Release notes: the Unreleased entry [CHANGELOG.md L8-L16][B-cl-8] and the
   0.8.14 subsection [L451-L486][B-cl-451].

### Issue #412

6. What users are told: [CHANGELOG.md L18-L37][B-cl-18] and the user guide
   [workflows.md L265-L278][B-ug-265].
7. The types and the refusal words: [store.ts L78-L108][B-st-78]
   (`SweeperKeptSession`, `sweeperKeptDetail`,
   `sweeperWorkflowBelowDetail`, `sweeperLiveWorkflowRow`).
8. The rule as one SQL statement: `sweeperKeptAmong`
   [store.ts L4000-L4034][B-st-4000]. It walks from each session up to the
   root (`chain`), and looks for a finished Workflow `w` with an active session
   `a` above it (`a.depth > w.depth`). Then `sweeperKeptSession`
   [L4036-L4043][B-st-4036], the entry point for the tools.
9. The tools: `readKept` [sweeper-tools.ts L159-L178][B-sw-160], then its
   three callers: the cleanup eligibility [L265-L280][B-sw-264], the scan
   [L368-L375][B-sw-367] and the prune [L639-L648][B-sw-639]. The refusal
   words: [L22-L24][B-sw-22] and [L180-L196][B-sw-180].
10. The final check, `sweeperSoftDelete` [store.ts L3800-L3941][B-st-3800].
    Read it in this order:
    - the new refusals in the doc comment [L3816-L3831][B-st-3813];
    - the delete set and the sessions a prune leaves in place, locked together
      `NOWAIT` [L3862-L3886][B-st-3862];
    - the re-read that refuses `Changed` [L3887-L3896][B-st-3887];
    - `WorkflowBelow` [L3897-L3902][B-st-3897];
    - the `FOR SHARE NOWAIT` lock on the sessions above the target, then the
      kept check [L3903-L3921][B-st-3903];
    - the helpers it calls: `sweeperDeleteSet`, `sweeperLeftBelow`,
      `sweeperWorkflowLeftBelow` and `sweeperAncestors`
      [L3943-L3998][B-st-3943].
11. The event purge: `purgeSessionEventsBefore`
    [store.ts L4045-L4105][B-st-4045], and its caller
    [resourcemgr-tools.ts L529-L562][B-rm-529].
12. The Sweeper's instructions: [sweeper.agent.md L64][B-agent-64] and
    [SKILL.md L15][B-skill-15].
13. Developer documents: [workflow-sessions.md L1250-L1282][B-wfs-1250] and
    the "Sweeper cleanup" row in [data-model.md L115][B-dm-115].
14. Formal models: [retention/README.md][B-formal-readme], then the
    invariants of [WorkflowRetention.tla L213-L225][B-tla-ret] and
    [WorkflowPrune.tla L166-L176][B-tla-prune].
15. Tests: see section 4.

## 3. How the changes interact

**Shared files.** Only `CHANGELOG.md` is changed by both pull requests. Both
added an `## Unreleased` section with its own upgrade line.

**The one merge conflict and its resolution.** Git stopped on the
`## Unreleased` header when #414 was merged on top of #413:

| Side | Upgrade line |
|---|---|
| #341 | `**Upgrade: deploy the workers.** No migration and no orchestration version.` |
| #412 | `No CMS migration and no session orchestration or Workflow controller version change.` |
| Resolution ([CHANGELOG.md L3-L6][B-cl-3]) | `**Upgrade: deploy the workers.** No CMS migration and no session orchestration or Workflow controller version change.` |

Both sections were kept: #341's "Decision cleanups" first, then #412's "A
finished Workflow stays while its session is in use". The combined line is true
for both changes. No code file needed a hand resolution. After the merge, the
repository privacy check reported 3,431 files and 0 findings.

**Other points where the two changes meet.**

| Point | Effect |
|---|---|
| Migrations | #412 adds no migration. #341 changes only the text of 0098, and the inventory fixture changes only the 0098 blob hash. The migration versions on the merged head are those of `main`. |
| Test benches | #341 changes the fixture skeleton that a Workflow test report suggests. #412 excludes test benches from the keep rule. They touch different code and do not overlap. |
| Schema-name quoting | #341 escapes `"` in 0098. The new queries of #412 use the store's existing form `"${schema}"` without escaping, as every `WorkflowStore` query does ([store.ts L1934][B-st-1934]). This is not a new exposure: migrations before 0096 do not escape either, so a schema name with `"` already fails at the first migration (#341 follow-up). |
| `CHANGELOG.md` checks | `workflow-decision-docs.test.mjs` reads `CHANGELOG.md`. It passed on #341's head. On the merged head it runs in the full SDK unit suite. |
| Base | Both branches already contained `main` `b79be29d`, and `main` has not moved, so neither merge brought new `main` changes. |

## 4. Which tests cover each change

All the runs below were made before the merge, on each pull request's own head,
on a disposable local PostgreSQL 16 with ambient `PG*` and `AZURE_*` variables
unset.

### Issue #341

| Test | File | What it proves | Before the fix |
|---|---|---|---|
| T1 | [cms-migrations-shape.test.mjs L43-L53][B-t1] | 0096 to 0103 write `"pilot""swarm".` for the schema `pilot"swarm`. For the schema `shape_check`, the SHA-256 of the 0098 SQL is `8652d2f9…`, the value on `main`. | Fails: 0098 writes `"pilot"swarm"`. |
| T2 | [workflow-definition-test-gaps.test.mjs L612][B-t2] | The skeleton of each Decision type parses; `noul` is exactly `{ type: "noul", noul: 1 }`. | Fails: `probabilities` present. |
| T3 | [workflow-agent-models.test.mjs L164][B-t3] | Request maps refuse 65 entries; stored maps take 100 and refuse 101. A guard: item 3 changes no behavior. | Passes. |
| T4 | [provider-decision-default.test.js L185-L214][B-t4] | 0098 installs and its setter works on PostgreSQL 16 in a schema whose name contains `"`. | Fails: `syntax error at or near "<tag>_q"`. |

Also run: the build and lint, 9 targeted unit files (127 of 127), the migration
inventory (2 of 2), the whole `provider-decision-default.test.js` on PostgreSQL
16 (31 of 31), and the privacy check.

### Issue #412

New tests:

| File | Tests | What they prove |
|---|---|---|
| [sweeper-cleanup-guard.test.js L927-L946][B-t-guard] (bodies [L733-L925][B-t-guard-body]) | 4 | The issue's own list: an idle owner keeps `W` and `A` on every path; an ended owner is kept while its parent is active, then cleaned with it; everything is cleaned once every ancestor has ended; an explicit delete still deletes at once. |
| [workflow-sweeper-recover.test.js L303][B-t-recover] | 1 | On the real runtime, a real two-step Workflow stays through every Sweeper pass and the event purge. `read_workflow` returns its graph, visits, outputs and variable; the Log keeps the step's `workflow.state_completed` event. |
| [workflow-kept-terminated.test.js L63-L64][B-t-kept] | 1 | Through the production `listSessions` and the session list's `buildSessionTree`, the Workflow sits in its owner's Terminated row, and the agent's Log keeps its message after the purge. |
| [sweeper-final-check.test.js][B-t-final], from [L499][B-t-final-499] | 16 | Concurrency, proved with the lock graph, not sleeps: a root restart and the Sweeper serialize both ways, for a cleanup and for a prune ([L499][B-t-final-499], [L530][B-t-final-530]); a run end above the target ([L569][B-t-final-569]); a cleanup with no Workflow takes no new lock ([L605][B-t-final-605]); the prune keeps a pending root above a Workflow ([L630][B-t-final-630]) and refuses `WorkflowBelow` for a completed, running or draft Workflow ([L658][B-t-final-658]), `Busy` ([L675][B-t-final-675]) and `Changed` ([L709][B-t-final-709]); the purge keeps the right events ([L739][B-t-final-739]), never waits ([L771][B-t-final-771]), serializes with a run end ([L798][B-t-final-798]) and deletes nothing on failure ([L830][B-t-final-830]). |

Each new test failed on the code before its fix, except the guard at
[L605][B-t-final-605], which passes on both by design.

Existing tests changed (4). Each now asserts the behavior the issue asks for:

| Test | Change |
|---|---|
| [sweeper-cleanup-guard.test.js L970][B-t-chg-970] | The running owner's finished Workflows are asserted kept (`WorkflowKept`), not cleaned. Title changed. |
| [sweeper-cleanup-guard.test.js L998][B-t-chg-998] | The same for the "all runs ended" case; the kept Workflow's controller is not deleted by a cleanup. Title changed. |
| [sweeper-cleanup-guard.test.js L986][B-t-chg-986] (body [L408][B-t-chg-408]) | The fixture sets the owner's state to `completed`. On `main` the owner ended only in its orchestration status and stayed `pending`, which the issue counts as active. Assertions unchanged. |
| [workflow-sweeper-recover.test.js L176][B-t-chg-176] | The completed Workflow of a running owner is asserted kept; the owner's state is set to `completed` when its stand-in orchestration ends. Title changed. |

Formal models: `WorkflowRetention` (final check and event purge against a root
restart and a run end) and `WorkflowPrune` (the prune against a Workflow
created under the owner and a run end). TLC ran 31 of 31 cases as expected:
12 pass, 7 deliberate faults (the round-1 and round-2 designs among them)
violate their named invariant, and 12 witnesses are reached.

Also run on #414's head: 7 targeted local files (68 of 68), the SDK unit suite
(3,127 tests: 3,126 passed, 1 skipped), and the privacy check.

### Not run yet, and on the merged head

| Gate | State |
|---|---|
| `pr-checks.yml` (full SDK unit suite, Linux and Windows) | Runs on every push to this pull request. It tests GitHub's merge of the head with `main`; the head already contains `main`, so it tests the same files. |
| PostgreSQL baseline plus live HorizonDB (`--all-providers`) | Not run for either issue during implementation. Another step of this batch runs it on the merged head `17598021`; its results will be added to this pull request. |
| Live-model checks of the Sweeper's edited instructions (#412) | Not run. |

## 5. What to look at most carefully

1. **The open review finding of #412 (a blocker in review round 3).** Root `R`
   is pending, its ordinary child `O` is idle, and `O` has a saved Workflow
   definition but no Workflow session yet. The prune deletes `R` (nothing is
   under it to keep). Then `O` starts the definition; Start checks only that
   `O` is live. The run ends and `W` is kept because `O` is active. The session
   list reaches a session only through its parent
   ([session-tree.js L274-L304][B-tree-274]), so `O` and `W` are not shown.
   The report proposes a follow-up: Start refuses when an ancestor of the owner
   is deleted. Decide whether this pull request can merge with that follow-up,
   or must wait for it. The formal model leaves this case out on purpose
   (`Wit_CreatedAfter`, [WorkflowPrune.tla L167-L169][B-tla-prune-167]).
2. **Lock order in the final check** ([store.ts L3862-L3921][B-st-3862-3921]).
   The target is locked first, then the delete set and the sessions a prune
   leaves in place (`NOWAIT`, in session-id order), then the sessions above the
   target (`FOR SHARE NOWAIT`). Check that:
   - every write that can make a session above active, or end a run above,
     takes that row's lock first. The design relies on the client's restart
     write ([client.ts L1072-L1078][B-client-1072]) and the run writers'
     `lockLiveSession` ([store.ts L1956][B-st-1956]);
   - the Sweeper never waits while it holds a lock (every new lock is
     `NOWAIT`);
   - the `Busy` words ([store.ts L3935-L3938][B-st-3937]) still say "one of
     the sessions it would delete", but a held session above the target, or
     one a prune leaves in place, now also gives `Busy`. Minor, but the
     message can mislead.
3. **The kept query** ([store.ts L4006-L4033][B-st-4006]). The recursive
   `chain` uses `UNION ALL` with no cycle guard, so it relies on parent links
   having no cycle. The active session must be strictly above the Workflow
   (`a.depth > w.depth`). A Workflow with only test-mode runs is not finished
   (`run.mode = 'live'`).
4. **The event purge** ([store.ts L4065-L4104][B-st-4065]). Phase 1 deletes
   without locks, because "whether a session is in a Workflow tree never
   changes while it exists". Check that no code moves a session to another
   parent or changes its `session_kind` or `service_kind`. Cost: each purge
   runs two recursive queries over all Workflow sessions, and phase 2 holds
   every unfinished Workflow `FOR SHARE` during its delete, so a run end in
   that Workflow waits that long.
5. **Operator-visible behavior of #412.** `WorkflowKept` refusals appear in the
   Sweeper's reports; the scan makes one more query per stale candidate;
   storage grows with long-lived owners, with no cap. The Sweeper's prompt
   changed without a live-model check.
6. **The four changed existing tests of #412** (section 4). Confirm that each
   change only replaces behavior that the issue asks to replace, and that no
   assertion was relaxed for another reason.
7. **#341 edits the text of a released migration** (0098). Confirm the SHA-256
   pin in T1 and that the migrator skips a recorded version
   ([pg-migrator.ts][B-migrator]). The live HorizonDB run is the only check of
   this SQL outside PostgreSQL 16; for a name without `"` it receives the same
   bytes that 0.8.14 to 0.8.19 sent.
8. **Release notes.** The conflict resolution ([CHANGELOG.md L3-L37][B-cl-3-37])
   and the new notes added to the already released 0.8.14 section
   ([L451-L486][B-cl-451]). The 0.8.14 notes describe what that release
   shipped, so a reader upgrading past it finds them there.

[B-tab-1520]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-tab.js#L1520
[B-tab-978]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-tab.js#L978
[B-tab-916]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-tab.js#L915-L921
[B-tab-1339]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-tab.js#L1339
[B-tui-92]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/tui/src/app.js#L92
[B-ws-342]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-workspace.js#L342
[B-web-7947]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/web-app.js#L7947
[B-tui-1811]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/core/src/workflow-tui.js#L1811-L1813
[B-panels-567]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/react/src/workflow-panels.js#L567
[B-341-design]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-341/design-spec.md
[B-341-impl]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-341/impl-spec.md
[B-341-test]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-341/test-spec.md
[B-341-report]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-341/implementation-report.md
[B-412-design]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-412/design-spec.md
[B-412-impl]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-412/impl-spec.md
[B-412-test]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-412/test-spec.md
[B-412-report]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/botdocs/issue-412/implementation-report.md
[B-0098-3]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/migrations/cluster-decision-default-0098.ts#L3
[B-fixture]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/fixtures/composition-migrations.json#L314-L317
[B-am-173]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/agent-models.ts#L173-L181
[B-am-226]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/agent-models.ts#L226-L233
[B-am-346]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/agent-models.ts#L346-L351
[B-dt-205]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/definition-test.ts#L205-L207
[B-rt-1]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/runtime.ts#L1-L5
[B-cl-3]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/CHANGELOG.md#L3-L6
[B-cl-3-37]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/CHANGELOG.md#L3-L37
[B-cl-8]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/CHANGELOG.md#L8-L16
[B-cl-18]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/CHANGELOG.md#L18-L37
[B-cl-451]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/CHANGELOG.md#L451-L486
[B-ug-265]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/user-guide/workflows.md#L265-L278
[B-st-78]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L78-L108
[B-st-1934]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L1934
[B-st-1956]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L1956
[B-st-3800]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3800-L3941
[B-st-3813]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3816-L3831
[B-st-3862]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3862-L3886
[B-st-3862-3921]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3862-L3921
[B-st-3887]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3887-L3896
[B-st-3897]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3897-L3902
[B-st-3903]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3903-L3921
[B-st-3937]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3935-L3938
[B-st-3943]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L3943-L3998
[B-st-4000]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L4000-L4034
[B-st-4006]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L4006-L4033
[B-st-4036]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L4036-L4043
[B-st-4045]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L4045-L4105
[B-st-4065]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/workflow/store.ts#L4065-L4104
[B-sw-22]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L22-L24
[B-sw-160]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L159-L178
[B-sw-180]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L180-L196
[B-sw-264]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L265-L280
[B-sw-367]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L368-L375
[B-sw-639]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/sweeper-tools.ts#L639-L648
[B-rm-529]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/resourcemgr-tools.ts#L529-L562
[B-agent-64]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/plugins/mgmt/agents/sweeper.agent.md#L64
[B-skill-15]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/plugins/mgmt/skills/sweeper/SKILL.md#L15
[B-wfs-1250]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/developer/building/workflow-sessions.md#L1250-L1282
[B-dm-115]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/proposals/workflows/data-model.md#L115
[B-formal-readme]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/formal/workflow/retention/README.md
[B-tla-ret]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/formal/workflow/retention/WorkflowRetention.tla#L213-L225
[B-tla-prune]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/formal/workflow/retention/WorkflowPrune.tla#L166-L176
[B-tla-prune-167]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/docs/formal/workflow/retention/WorkflowPrune.tla#L167-L169
[B-tree-274]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/app/ui/core/src/session-tree.js#L274-L304
[B-client-1072]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/client.ts#L1072-L1078
[B-migrator]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/src/pg-migrator.ts
[B-t1]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/unit/cms-migrations-shape.test.mjs#L43-L53
[B-t2]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/unit/workflow-definition-test-gaps.test.mjs#L612
[B-t3]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/unit/workflow-agent-models.test.mjs#L164
[B-t4]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/provider-decision-default.test.js#L185-L214
[B-t-guard]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L927-L946
[B-t-guard-body]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L733-L925
[B-t-recover]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/workflow-sweeper-recover.test.js#L303
[B-t-kept]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/workflow-kept-terminated.test.js#L63-L64
[B-t-final]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js
[B-t-final-499]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L499
[B-t-final-530]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L530
[B-t-final-569]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L569
[B-t-final-605]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L605
[B-t-final-630]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L630
[B-t-final-658]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L658
[B-t-final-675]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L675
[B-t-final-709]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L709
[B-t-final-739]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L739
[B-t-final-771]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L771
[B-t-final-798]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L798
[B-t-final-830]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-final-check.test.js#L830
[B-t-chg-408]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L408
[B-t-chg-970]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L970
[B-t-chg-986]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L986
[B-t-chg-998]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/sweeper-cleanup-guard.test.js#L998
[B-t-chg-176]: https://github.com/microsoft/PilotSwarm/blob/1759802172ea0f96df5fb098c84e8d39d4bc0c4b/packages/sdk/test/local/workflow-sweeper-recover.test.js#L176
