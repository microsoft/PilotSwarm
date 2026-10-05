# Resumable local test validation

> **Functional specification and acceptance contract:** this document is the
> normative description of the resumable validation harness. Implementation
> changes should conform to it. The contract can evolve when implementation
> evidence or repository constraints justify a change, but such changes should
> be reviewed explicitly rather than introduced as silent deviations.

## What is a validation campaign?

A **validation campaign** is the durable collection of test evidence for:

- one exact committed repository revision,
- one resolved test selection, and
- one semantic provider/model profile.

A campaign can span multiple runner invocations. It records every selected test
file, every attempt, and the current result for each file. Compatible completed
attempts remain available while later invocations add explicitly requested
retries or reruns.

A **run** is one invocation of the campaign runner. Worker counts, retry limits,
and process deadlines belong to the run and may change without creating a new
campaign.

An **attempt** is one isolated execution of one selected test file within a run.
Its result and native test report are immutable evidence, even when a later
attempt changes the file's current campaign status.

Use a campaign whenever restarting from zero would discard valuable evidence.
Common cases include long-running suites, tests with intermittent failures,
resource-constrained runs, interrupted local sessions, and pre-publication
validation of a risky change.

A campaign does not need to be green to be complete. A stable failure is a
valid result, especially when the same failure occurs for both a baseline and a
candidate commit. **Completion** means every job planned for the campaign run
reached a terminal result; **outcome** describes how many tests passed, failed,
timed out, or produced mixed history.

## Vitest: define and execute tests

Vitest is the test execution engine and the source of truth for the SDK test
catalog. It owns:

- test and suite definitions,
- file discovery and tag filtering,
- assertions, hooks, skips, and test-level retries,
- test and hook timeouts,
- concurrency within a test file, and
- native machine-readable assertion reports.

The campaign layer asks `vitest list` for the resolved files and passes selected
files back to Vitest unchanged. It must not walk the filesystem to create a
parallel catalog, force tests within a file to run sequentially, or translate
Vitest assertions into a competing result format.

## `run-tests.sh`: execute the complete repository gate

`scripts/run-tests.sh` is the canonical stateless entry point for a fresh,
complete repository validation. It owns:

- the ordered set of build, unit, integration, and provider phases,
- provider-mode selection and coverage rules,
- canonical cleanup and environment setup,
- inclusion of non-Vitest phases, and
- the combined one-shot pass or fail result.

The script remains useful without campaign state and is the authoritative answer
to what the complete gate runs. The campaign utility must not copy its shell
commands, provider selection, or skip rules into a second implementation.

The initial campaign profile covers the expensive SDK local Vitest catalog. It
does not imply that credential-free checks, provider-specific gates, or
non-Vitest phases passed. If those phases become resumable later, their adapters
must invoke the existing canonical scripts or consume phase definitions shared
with `run-tests.sh`.

## Validation campaign: preserve evidence across invocations

The campaign is additive orchestration around those existing components. It
supplies the behavior that a one-shot Vitest or `run-tests.sh` invocation does
not retain:

- pin evidence to an exact committed revision and semantic test profile,
- preserve compatible completed evidence when operational controls change,
- apply a process-level deadline and terminate a hung file process,
- finish the initial breadth-first pass before spending workers on retries,
- retain every failure, timeout, retry, and eventual pass for triage, and
- expose whether the selected campaign is complete, making forward progress, or
  no longer reporting liveness.

This layer matters when live tests are expensive, failures need human triage,
and the next invocation may need a longer deadline or fewer workers. Starting
the entire suite over discards trustworthy completed work; blindly reusing old
passes risks attributing them to the wrong source, selection, or provider
profile.

The campaign's process deadline is an outer guard for a hung test-file process;
Vitest still owns individual test and hook timeouts. Its manifest indexes
attempt provenance and native reports; it does not replace those reports.
Before a timed-out, interrupted, or stale POSIX attempt is terminated, the
runner inventories and freezes its attributable descendants, including children
that created a separate process group. It terminates and identity-verifies every
captured process before recording cleanup as complete. If discovery or
verification is incomplete, evidence collection fails closed.

The harness supports a merge or publication protocol; it does not define one.
Create the candidate commit and decide whether to publish or roll it back
outside the harness.

The implemented layering is:

```text
Vitest and canonical repository scripts
                ↓
       campaign scheduling layer
                ↓
   manifest, native reports, dashboard
```

This preserves one source of truth for what tests exist and how the complete
gate runs. Removing the campaign state should leave the underlying Vitest and
`run-tests.sh` workflows fully usable.

Everything below defines the utility's value, behavior, and boundary.

## Before starting

- Commit the exact candidate you intend to validate.
- Use a clean worktree. The harness refuses to attribute results to `HEAD` when
  tracked or untracked source changes could affect the tests.
- Configure the dedicated test database and model/provider environment described
  in [Local tests and CI setup](local-ci-and-tests.md). Never use an application
  or production database.
- The baseline profile applies the canonical test-storage routing, so the
  configured `DATABASE_URL` is also supplied as `PS_TEST_DATABASE_URL` and
  `TEST_DATABASE_URL`; individual tests must not fall back to another port.
- Do not run two campaigns against the same test database at the same time.

## Start a campaign

The normal initial run uses eight file workers, a five-minute process deadline
per file, and no retries:

```bash
npm run test:campaign -- --workers 8 --timeout 5m
```

The runner:

1. verifies the clean committed revision,
2. asks Vitest for the resolved file inventory,
3. creates or continues the matching campaign,
4. builds once and performs stale-test cleanup once,
5. gives every selected file one initial attempt, and
6. checkpoints the manifest after every attempt.

The build step cannot be skipped and begins by deleting generated SDK and MCP
output. Those directories are ignored by Git, so reusing an existing build
could attribute artifacts from another commit or branch to the campaign's
tested revision.

Unknown and historically short files run before historically long files. A
file that exceeds its process deadline is terminated and recorded as timed out.
That timeout is a valid terminal observation and remains eligible for configured
retry rounds. One long file cannot prevent another worker from taking the next
queued file.

The default campaign manifest is:

```text
test-results/local-test-validation/campaign.json
```

Use `--output` to keep independent campaign manifests when validating different
commits:

```bash
npm run test:campaign -- \
  --output test-results/candidate/campaign.json
```

All generated reports stay under `test-results/`, which is already ignored by
Git. Do not attach the raw campaign directory to an issue or PR without first
reviewing it for private paths, hosts, test data, and failure output.

## Continue after triage

After investigating the failures, rerun the same campaign with different
operational controls. For example, allow a longer deadline while using four
workers for every round:

```bash
npm run test:campaign -- \
  --workers 4 \
  --retries 1 \
  --timeout 15m
```

Changing worker counts, retry count, or timeout does **not** invalidate existing
attempt evidence. A continuation can add retries or explicitly rerun selected
files without discarding earlier terminal results.

Retries are separate rounds:

1. every selected file receives its initial attempt,
2. interrupted or unfinished attempts are recovered in a distinct recovery
   round before new observations are scheduled,
3. configured non-passing terminal results enter the first retry round,
4. each retry round uses the same `--workers` concurrency as the initial round, and
5. a file leaves later rounds as soon as it passes.

Retries remain breadth-first, so a file does not retry until the prior round
finishes. Vitest still controls concurrency inside each file; the campaign
manager does not force tests within a file to run sequentially.
When the configured rounds finish, the run is complete even if some tests
remain failed or timed out.

Useful controls:

```bash
# Run or continue only named files.
npm run test:campaign -- \
  --file smoke-basic.test.js \
  --file reliability-crash.test.js

# Explicitly rerun current passes as well as non-passes.
npm run test:campaign -- --all

# Start over intentionally rather than continuing compatible evidence.
npm run test:campaign -- --fresh
```

`--file` changes the resolved selection and therefore identifies a different
campaign. `--all` changes what executes in the current campaign, not the
campaign identity.

Each round uses deterministic shortest-work-first scheduling based only on
evidence already recorded in that campaign. Files without a complete terminal
attempt are unknown and run first, ordered by path. Known files follow in
ascending order of their median complete-attempt duration, with path as the
tie-breaker. A fresh campaign therefore begins with all files unknown; its
initial observations provide scheduling history for retries, resumed runs, and
later `--all` rounds. Scheduling history affects queue order only and never
reuses another campaign's pass or failure evidence.

## Track progress and detect stalls

Campaigns are expected to run for a long time. A run may contain many files,
long process deadlines, external service dependencies, and multiple retry
rounds. Both people and agents need to distinguish slow forward progress from a
runner that is no longer healthy.

The campaign state therefore includes live execution state, not only completed
results. The runner checkpoints state atomically when work is queued, started,
completed, interrupted, or moved into a retry round. While a run is active it
also updates a heartbeat independently of test output.

Liveness and forward progress are separate signals:

- **Runner liveness:** a recent heartbeat shows that the coordinator is still
  supervising its workers.
- **Campaign progress:** completed work increases and unfinished work decreases
  as file attempts reach terminal states.

Within a fixed initial or retry round, the total number of jobs is immutable.
Its completed count increases monotonically and its remaining count decreases
monotonically to zero. Starting a later retry round creates a new fixed job set
rather than rewriting the previous round's counts. The state records
`lastProgressAt` separately from the heartbeat so automation can see whether a
live coordinator is actually completing work.

The machine-readable status exposes at least:

- campaign identity and overall status,
- current run, phase, and retry round,
- runner heartbeat, last progress time, and last state transition,
- total, queued, active, completed, and remaining job counts for each round,
- current pass, failure, interruption, timeout, and mixed-history counts,
- each active file's worker slot, start time, elapsed time, and deadline,
- whether the run finished normally, was interrupted, or appears stale.

Silence from a test process is not by itself proof that it is stuck; a valid
test may spend a long time waiting on an external system. The heartbeat shows
that the campaign runner is still supervising it, while the file's configured
deadline guarantees that the attempt cannot run indefinitely.

The dashboard presents the same status for a person: completion progress,
active files and elapsed time, round totals, the decreasing unfinished-job
count, current retry round, the most recent state transition, and the ages of
the last progress event and runner heartbeat. A stale heartbeat is displayed as
a warning rather than as a test failure because the runner may have been
terminated externally.

Agents and scripts consume the campaign JSON or a stable JSON status endpoint;
they must not scrape console output or HTML. Reading status is side-effect-free
and does not require the dashboard process to be running.

## Campaign identity

Completed attempt evidence is reusable only when all semantic inputs still
match:

| Input | Same campaign? |
| --- | --- |
| Exact repository and committed SHA | Required |
| Resolved Vitest file selection | Required |
| Named validation profile and tag filter | Required |
| Provider/model profile fingerprint | Required |
| Worker count | May change |
| Retry worker count or retry count | May change |
| Per-file process timeout | May change |

A source change, selection/catalog change, or provider/model profile change
must not inherit evidence. If an existing manifest belongs to a different
identity, the runner refuses to continue it and explains whether to use
`--fresh` or a different output path. It does not silently reinterpret old
results.

Secret values are never written to the manifest. The profile fingerprint is a
one-way digest of the semantic model/provider configuration; rotating an
equivalent credential should not create a different profile.

There is no cross-campaign pass inference. Even when two commits touch unrelated
files, each campaign must establish its own evidence.

## Compare two committed revisions

To infer whether a candidate likely introduced a regression, produce two
independent campaigns:

1. a **baseline campaign** for the known comparison commit, and
2. a **candidate campaign** for the commit being evaluated.

Each campaign remains attributable to exactly one committed revision. A separate
comparison record links their campaign identities and compares only compatible
evidence: the same resolved test selection and semantic provider/model profile.
The comparison must not merge attempts from the two revisions into one campaign
or reuse a baseline pass as candidate evidence.

The comparison classifies file-level changes such as:

| Baseline | Candidate | Interpretation |
| --- | --- | --- |
| Pass | Fail or timeout | Likely regression |
| Fail or timeout | Pass | Likely fix |
| Fail | Fail | Pre-existing or shared failure |
| Pass | Pass | No observed functional regression |
| Mixed/flaky | Any changed result | Inconclusive without attempt-level review |

Duration and reliability deltas may also indicate a regression even when both
commits pass. The comparison record includes the run controls used by each
campaign. Different timeout or retry policies do not invalidate the underlying
campaigns, but they reduce direct comparability and must be surfaced rather than
hidden.

The comparison is evidence, not proof of causality. External services, load,
and flaky tests can produce different observations for identical source.

Write a machine-readable comparison record after both campaigns complete:

```bash
npm run test:campaign:compare -- \
  --baseline test-results/baseline/campaign.json \
  --candidate test-results/candidate/campaign.json \
  --output test-results/comparisons/baseline-to-candidate.json
```

## Inspect status

Start the loopback-only dashboard in another terminal:

```bash
npm run test:campaign:dashboard
```

Then open `http://127.0.0.1:4310`. The dashboard reads the campaign manifest and
shows live progress and liveness alongside current status, duration, attempt
history, mixed outcomes, and failure summaries. It does not execute tests or
modify campaign state.

The server is intentionally local-only and unauthenticated. It must not bind to
a non-loopback interface. The health endpoint reports availability without
revealing the absolute results path.

## Interpret the result

The runner exits successfully when every job planned for that invocation reaches
a terminal result and the evidence is persisted. Test failures and timeouts are
successful observations, not runner failures.

The runner exits nonzero when evidence collection itself is incomplete or
untrustworthy, for example because the coordinator failed, the source changed,
the run was interrupted, a process could not be terminated, or a native report
could not be retained safely.

A failed attempt followed by a pass remains visible as mixed or flaky history.
Neither result erases the other. Raising a timeout can show that a test passes
with more time; it does not erase the original timeout. A user or comparison
consumer decides whether the resulting evidence indicates a likely regression.

Each attempt retains:

- the exact tested repository and commit,
- the campaign and run identifiers,
- process timing and termination status,
- the native machine-readable Vitest report, and
- a bounded, redacted summary for the dashboard.

The campaign manifest is an index and summary, not a replacement for Vitest's
standard result format. Native reports are recursively redacted before they are
retained, and their integrity digest covers that redacted artifact. They remain
separate so other tools can consume them without understanding a
PilotSwarm-specific assertion schema.

## What counts as complete evidence

For a complete SDK local campaign:

- the worktree remained clean,
- the campaign identity matches the intended commit and profile,
- every planned job reached a terminal result,
- no job remains queued, active, or unrecorded,
- every completed Vitest process has a safely retained native report, while a
  process-level timeout or forced termination has a complete supervisor record,
  and
- required checks outside the current profile were run separately.

Failures, timeouts, and mixed history remain part of a complete campaign. The
harness records evidence; the person or agent following the merge, publication,
or regression-analysis protocol decides what that evidence implies.
