# Resumable local test validation

> **Functional specification and acceptance contract:** this document is the
> normative description of the resumable validation harness, not a description
> of every behavior in the exploratory prototype. Implementation work should
> conform to it, and prototype gaps are expected to be brought into alignment.
> The contract can evolve when implementation evidence or repository constraints
> justify a change, but such changes should be reviewed explicitly rather than
> introduced as silent deviations. The feature-branch implementation is not yet
> complete enough to use as merge evidence.

## What is a validation campaign?

A **validation campaign** is the durable collection of test evidence for:

- one exact committed repository revision,
- one resolved test selection, and
- one semantic provider/model profile.

A campaign can span multiple runner invocations. It records every selected test
file, every attempt, and the current result for each file. Compatible passes
remain complete while later invocations retry only work that is pending, failed,
or interrupted.

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
- preserve compatible passes when operational controls change,
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

The harness supports a merge or publication protocol; it does not define one.
Create the candidate commit and decide whether to publish or roll it back
outside the harness.

The intended long-term shape is:

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

Everything below describes that intended value and boundary. The prototype is
input to the implementation work, not the specification.

## Before starting

- Commit the exact candidate you intend to validate.
- Use a clean worktree. The harness refuses to attribute results to `HEAD` when
  tracked or untracked source changes could affect the tests.
- Configure the dedicated test database and model/provider environment described
  in [Local tests and CI setup](local-ci-and-tests.md). Never use an application
  or production database.
- Do not run two campaigns against the same test database at the same time.

## Start a campaign

The normal initial run uses eight file workers, a five-minute process deadline
per file, and no retries:

```bash
npm run test:validation -- --workers 8 --timeout 5m
```

The runner:

1. verifies the clean committed revision,
2. asks Vitest for the resolved file inventory,
3. creates or continues the matching campaign,
4. builds once and performs stale-test cleanup once,
5. gives every selected file one initial attempt, and
6. checkpoints the manifest after every attempt.

Unknown and historically short files run before historically long files. A
file that exceeds its process deadline is terminated, recorded as interrupted,
and left eligible for a later run. One long file cannot prevent another worker
from taking the next queued file.

The default campaign manifest is:

```text
test-results/local-test-validation/campaign.json
```

All generated reports stay under `test-results/`, which is already ignored by
Git. Do not attach the raw campaign directory to an issue or PR without first
reviewing it for private paths, hosts, test data, and failure output.

## Continue after triage

After investigating the failures, rerun the same campaign with different
operational controls. For example, allow a longer deadline while limiting the
retry fleet to two workers:

```bash
npm run test:validation -- \
  --workers 4 \
  --retry-workers 2 \
  --retries 1 \
  --timeout 15m
```

Changing worker counts, retry count, or timeout does **not** invalidate existing
passes. By default, continuation selects only pending, failed, and interrupted
files.

Retries are separate rounds:

1. every selected file receives its initial attempt,
2. failures enter the first retry round,
3. each retry round uses `--retry-workers`, and
4. a file leaves later rounds as soon as it passes.

This prevents a few slow failures from occupying every initial worker with
immediate retries. Vitest still controls concurrency inside each file; the
campaign manager does not force tests within a file to run sequentially.

Useful controls:

```bash
# Run or continue only named files.
npm run test:validation -- \
  --file smoke-basic.test.js \
  --file reliability-recovery.test.js

# Explicitly rerun current passes as well as non-passes.
npm run test:validation -- --all

# Start over intentionally rather than continuing compatible evidence.
npm run test:validation -- --fresh
```

`--file` changes the resolved selection and therefore identifies a different
campaign. `--all` changes what executes in the current campaign, not the
campaign identity.

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
- the number of campaign files that still lack a current pass,
- each active file's worker slot, start time, elapsed time, and deadline,
- completed pass, failure, interruption, and mixed-history counts, and
- whether the run finished normally, was interrupted, or appears stale.

Silence from a test process is not by itself proof that it is stuck; a valid
test may spend a long time waiting on an external system. The heartbeat shows
that the campaign runner is still supervising it, while the file's configured
deadline guarantees that the attempt cannot run indefinitely.

The dashboard presents the same status for a person: completion progress,
active files and elapsed time, round totals, the decreasing unfinished-job
count, current retry round, recent transitions, and the ages of both the last
progress event and runner heartbeat. A stale heartbeat is displayed as a warning
rather than as a test failure because the runner may have been terminated
externally.

Agents and scripts consume the campaign JSON or a stable JSON status endpoint;
they must not scrape console output or HTML. Reading status is side-effect-free
and does not require the dashboard process to be running.

## Campaign identity

Passes are reusable only when all semantic inputs still match:

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
must not inherit passes. If an existing manifest belongs to a different
identity, the runner refuses to continue it and explains whether to use
`--fresh` or a different output path. It does not silently reinterpret old
results.

Secret values are never written to the manifest. The profile fingerprint is a
one-way digest of the semantic model/provider configuration; rotating an
equivalent credential should not create a different profile.

There is no cross-campaign pass inference. Even when two commits touch unrelated
files, each campaign must establish its own evidence.

## Inspect status

Start the loopback-only dashboard in another terminal:

```bash
npm run test:validation:dashboard
```

Then open `http://127.0.0.1:4310`. The dashboard reads the campaign manifest and
shows live progress and liveness alongside current status, duration, attempt
history, mixed outcomes, and failure summaries. It does not execute tests or
modify campaign state.

The server is intentionally local-only and unauthenticated. It must not bind to
a non-loopback interface. The health endpoint reports availability without
revealing the absolute results path.

## Interpret the result

The runner exits successfully only when every file in the resolved campaign
selection currently passes. Pending, failed, or interrupted files keep the
exit code nonzero.

A failed attempt followed by a pass remains visible as mixed or flaky history.
The current campaign may be green, but the history still requires triage before
you rely on the evidence. This is especially important before a risky merge.
Raising a timeout can show that a test passes with more time; it does not erase
the original timeout.

Each attempt retains:

- the exact tested repository and commit,
- the campaign and run identifiers,
- process timing and termination status,
- the native machine-readable Vitest report, and
- a bounded, redacted summary for the dashboard.

The campaign manifest is an index and summary, not a replacement for Vitest's
standard result format. Native reports remain separate so other tools can
consume them without understanding a PilotSwarm-specific assertion schema.

## What counts as complete evidence

For the SDK local campaign:

- the worktree remained clean,
- the campaign identity matches the intended commit and profile,
- every resolved file has a current pass,
- no file is pending or interrupted,
- mixed/flaky history has been reviewed, and
- required checks outside the current profile were run separately.

The harness records evidence. The person following the merge or publication
protocol decides whether that evidence is sufficient.
