# Walkthrough: pull request #415 (issue #341)

This walkthrough is for a reviewer who did not follow the work. It explains
what pull request [#415](https://github.com/microsoft/PilotSwarm/pull/415)
changes, the order in which to read the diff, which tests cover it, and where
to look most carefully.

- Base: `main` at `b79be29d` (release 0.8.19).
- Code commit: `915e21b318fe57e87243a0442aa341d789ed39bb`, the merge of
  [#413](https://github.com/microsoft/PilotSwarm/pull/413) for issue #341.
  Every code link below is pinned to this commit. The only later commit adds
  this walkthrough.
- Size of the code commit: 14 files, 625 lines added and 11 removed. About 490
  of the added lines are the four issue documents under
  `docs/botdocs/issue-341/`.

## Terms

Each term is defined once here and used with this meaning below.

| Term | Meaning |
|---|---|
| Migration | A numbered function in `packages/sdk/src/migrations/` that returns SQL. The migrator runs each version once per database and records it by its version number. |
| Cluster Decision Default | The provider and model that a Workflow Decision state uses when its definition names none. Migration 0098 adds its columns and setter. |
| Fixture skeleton | A ready-to-fill test fixture that a Workflow test report suggests for a call that has no prepared answer. |
| `noul` Decision | A yes-or-no Decision question. The live Decision service answers it with only `{ noul: <probability of yes> }`. |
| Request map | The `agentModels` (or Decision models) map that a caller passes with a start. |
| Stored map | The same map as stored with a run (migration 0088) and read back at each spawn. |

## 1. What the pull request changes

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

## 2. Reading order through the diff

The code change is small; reading it takes about 10 minutes.

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
5. Release notes: the Unreleased entry [CHANGELOG.md L3-L15][B-cl-3] and the
   0.8.14 subsection [L429-L463][B-cl-429].

## 3. Which tests cover each change

The runs below were made on the #341 branch head `a78b1254`, whose files are
the same as the code commit's, on a disposable local PostgreSQL 16 with ambient
`PG*` and `AZURE_*` variables unset.

| Test | File | What it proves | Before the fix |
|---|---|---|---|
| T1 | [cms-migrations-shape.test.mjs L43-L53][B-t1] | 0096 to 0103 write `"pilot""swarm".` for the schema `pilot"swarm`. For the schema `shape_check`, the SHA-256 of the 0098 SQL is `8652d2f9…`, the value on `main`. | Fails: 0098 writes `"pilot"swarm"`. |
| T2 | [workflow-definition-test-gaps.test.mjs L612][B-t2] | The skeleton of each Decision type parses; `noul` is exactly `{ type: "noul", noul: 1 }`. | Fails: `probabilities` present. |
| T3 | [workflow-agent-models.test.mjs L164][B-t3] | Request maps refuse 65 entries; stored maps take 100 and refuse 101. A guard: item 3 changes no behavior. | Passes. |
| T4 | [provider-decision-default.test.js L185-L214][B-t4] | 0098 installs and its setter works on PostgreSQL 16 in a schema whose name contains `"`. | Fails: `syntax error at or near "<tag>_q"`. |

Also run: the build and lint, 9 targeted unit files (127 of 127), the migration
inventory (2 of 2), the whole `provider-decision-default.test.js` on PostgreSQL
16 (31 of 31), and the privacy check. `workflow-decision-docs.test.mjs` reads
`CHANGELOG.md`; it runs in the SDK unit suite.

The full PostgreSQL 16 baseline of this pull request's head, and the CI checks
(`pr-checks.yml`, Linux and Windows), are reported in the pull request
description.

## 4. What to look at most carefully

1. **The text of a released migration changes** (0098). Confirm the SHA-256
   pin in T1 and that the migrator skips a recorded version
   ([pg-migrator.ts][B-migrator]). A live HorizonDB run is the only check of
   this SQL outside PostgreSQL 16; for a name without `"` it receives the same
   bytes that 0.8.14 to 0.8.19 sent.
2. **Schema names with `"` elsewhere.** Migrations before 0096 do not escape
   `"` either, so a schema name with `"` still fails at the first migration.
   This pull request makes the Decision migrations consistent; it does not make
   such a schema name work end to end.
3. **Release notes.** The new Unreleased entry ([CHANGELOG.md L3-L15][B-cl-3])
   and the notes added to the already released 0.8.14 section
   ([L429-L463][B-cl-429]). The 0.8.14 notes describe what that release
   shipped, so a reader upgrading past it finds them there.

[B-341-design]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/docs/botdocs/issue-341/design-spec.md
[B-341-impl]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/docs/botdocs/issue-341/impl-spec.md
[B-341-test]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/docs/botdocs/issue-341/test-spec.md
[B-341-report]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/docs/botdocs/issue-341/implementation-report.md
[B-0098-3]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/migrations/cluster-decision-default-0098.ts#L3
[B-fixture]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/test/fixtures/composition-migrations.json#L314-L317
[B-am-173]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/workflow/agent-models.ts#L173-L181
[B-am-226]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/workflow/agent-models.ts#L226-L233
[B-am-346]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/workflow/agent-models.ts#L346-L351
[B-dt-205]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/workflow/definition-test.ts#L205-L207
[B-rt-1]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/workflow/runtime.ts#L1-L5
[B-cl-3]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/CHANGELOG.md#L3-L15
[B-cl-429]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/CHANGELOG.md#L429-L463
[B-t1]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/test/unit/cms-migrations-shape.test.mjs#L43-L53
[B-t2]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/test/unit/workflow-definition-test-gaps.test.mjs#L612
[B-t3]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/test/unit/workflow-agent-models.test.mjs#L164
[B-t4]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/test/local/provider-decision-default.test.js#L185-L214
[B-migrator]: https://github.com/microsoft/PilotSwarm/blob/915e21b318fe57e87243a0442aa341d789ed39bb/packages/sdk/src/pg-migrator.ts
