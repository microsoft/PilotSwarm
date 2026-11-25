# CI and Azure test infrastructure

For installation and runnable local/CI setup steps, see [Local tests and CI setup](../docs/developer/contributing/local-ci-and-tests.md).

Every pull request runs **PR checks / Basic checks** without cloud credentials:
workspace builds, deployment tooling, CI policy checks, SDK API/unit tests and
application unit tests. Forks use the same checks. Full live integration runs
use workflow/control code from trusted `main` and the protected `azure-deploy`
environment. Maintainers may explicitly select a reviewed PR head as test source.

PR checks also run the Duroxide dependency contract in an Azure Linux 3 container
with glibc 2.38 and patched Node 24.22.1. This verifies the exact official npm
native binary, executes an activity, and reads its persisted result after a
runtime restart. Same-version GitHub Release binaries are not interchangeable
with the npm artifacts: their build environments can impose different libc
requirements. The ordinary Windows and Linux checks remain unchanged.

A separate Node 26 job builds the workspace and runs the workflow script tests.
Node 26's permission model limits the network, so this job covers the script
runner's `--allow-net` grant, which the Node 24 checks never reach.

Release packaging validates the root and all package-local `LICENSE` files,
then checks the complete notice inside each actual tarball before publication.
The release has three tarballs, `SHA256SUMS` (covering those tarballs), and a
standalone `LICENSE`. **Add release license notice** is a separate manual,
main-only protected workflow for additive notice maintenance on an existing
release. It preserves existing asset identities/digests and performs no deploy.

## Development snapshots

Use **Create dev release** (`release-dev.yml`) with **Use workflow from** set to
`main`. Set `source_branch` to the repository branch to snapshot; blank uses the
captured main commit. A non-main branch must be the exact head of an open PR
to this repository's `main`; admission is rechecked after approval. The source
SHA, commit/compare links and PR are shown before approval. Approval authorizes
public prerelease publication as well as running code on the VM. No prepared
version is needed; an open PR is not proof that its code has been reviewed.

```bash
gh workflow run release-dev.yml --repo microsoft/PilotSwarm --ref main \
  -f source_branch=feature/my-change
```

After approval, release concurrency serializes allocation of `0.0.0-dev.N`,
starting at 1 and advancing beyond the highest remote tag or visible release
(including tagged drafts), without filling gaps. Untagged drafts invisible to
the read-only token cannot reserve dev numbers. A version-only snapshot commit updates manifests,
internal dependencies, the lockfile and changelog. Tests and the tag use that
commit; the source branch is unchanged and release notes record both SHAs.
Dispatch a new run instead of rerunning dev selection/preparation.

Stable **Create release** (`release-tarballs.yml`) keeps its main-only prepared
version and single-job, single-approval validate/test/publish/deploy flow, exactly
as on main. Only dev uses the split `release-common.yml` workflow. Both use the
complete PostgreSQL baseline plus real HorizonDB coverage on the Azure runner.
Dev skips only post-publication login refresh/deployment and publishes a
non-latest prerelease. A tag or draft consumes its number; a failure before tag
creation does not. There is no npm publication.

Controls always come from captured main. Dev approval trusts source
install/build/test code with CI credentials and access to the Azure runner's
machine and managed identity; separate checkouts are not a sandbox.
Packing runs without the GitHub write token;
only publication receives it and never runs package lifecycle scripts.
Qualification and packaging use a `contents: read` job; packing disables package
hooks after the build. Run/attempt artifacts carry tarballs, checksums, license
and a tested-source Git bundle to a fresh `contents: write` publication job.
That job checks source lineage and consistency, restricts snapshot changes to
the exact generated versions/dependencies/changelog, and checks packed manifests
and runtime entrypoints without executing source code.
Publish-only reruns reuse the successful qualification artifact, not the new
attempt number. Inspect any existing tag/draft before retrying publication.
Stable keeps its existing write-token VM job and automatic deployment after
the first approval; its token isolation is not changed by this PR. Dev never deploys.
Dev numbering uses a separate `release-dev` concurrency group, avoiding the
workflow-level `azure-deploy` queue. The test database remains serialized
through `ci-provider-database`. Its one-pending-job limit can still displace a
pending stable qualification job: do not queue dev/tests while that job waits.
No environment policies are changed. A live dev release from main is still
needed to verify GitHub tag-push authentication before the next stable release.

### Initial dev rollout and recovery

1. Merge, then have an operator refresh runner setup to admit the main-only dev caller.
2. Explicitly dispatch one dev release from `main` and approve its exact source.
3. Check runner admission, artifact round-trip, selected/stamped SHA lineage,
   snapshot-only metadata changes, public prerelease flags, unchanged stable
   `latest`, and absence of deployment. Verify the HTTPS tag push works live.
4. Only then run the next stable release.

Do not treat local fixtures as a live runner/authentication check. Publication
reruns stop when the tag already exists; inspect any tag/draft and do not delete
or overwrite published state. Failure before tagging needs a new dev dispatch
(and full requalification); stable failure before tagging likewise requires a
fresh release run. If stable publishes but deployment fails, retain the release
and dispatch **Deploy Azure stamp** with its existing `release_tag`. Cancel or
finish the old stable run first if it still holds the `azure-deploy` queue.

The existing install helper accepts an exact dev version; its default selects
the latest stable release. The stable deployment workflow does not accept dev
tags.
See [package installation](../docs/quickstart/packages.md#development-snapshots).

## Maintainer-triggered tests before merging a PR

The quickest route is a **new PR conversation comment containing only**:

```text
/test all
```

The commenter must currently have repository write, maintain or admin access.
The trusted main workflow checks that permission through the GitHub API, not
the comment's author-association label. It selects `providers=all`,
`mode=parallel`, and no suite filter, then replies on the PR with the pinned
head SHA and a link to the run. Open that link, review the selected commit, and
approve `azure-deploy` through **Review deployments**. The button may say
**Approve and deploy**, but this workflow only runs tests.

Only newly created, standalone commands are accepted. Editing an old comment,
quoting the command, adding arguments, or posting it on an ordinary issue does
not start tests. Removing or changing the original command before execution
fails its post-approval verification. Post a fresh command for a new request.
There is no separate GitHub App or personal-token setup: the same Tests
workflow handles `issue_comment` from main without executing candidate code
in the comment-handling job.

The trusted selection job needs `pull-requests: write` to post its PR
acknowledgement, even though GitHub exposes conversation comments through the
`issues/.../comments` API. Do not substitute `issues: write` with PR read-only
permission. Candidate execution retains PR read-only access; only trusted
control jobs can write comments/statuses. If acknowledgement fails, source
selection fails and clears its pending status to an error; tests do not start.

Alternatively, dispatch **Tests** from `main`, set `pr_number` to the open PR number, leave
`suite` blank, select `providers=all` and `mode=parallel`:

```bash
gh workflow run tests.yml --repo microsoft/PilotSwarm --ref main \
  -f pr_number=84 -f providers=all -f mode=parallel
```

The UI equivalent is **Actions -> Tests -> Run workflow**, workflow branch
`main`, with those inputs. A blank PR number retains the normal main run.
Both same-repository and fork PRs targeting `main` are supported.

Before requesting environment approval, a selection job with no Azure, model
or database secrets validates
maintainer/write access and resolves the PR's exact head SHA. Its summary shows
the source repository, candidate commit and trusted workflow commit. The gated
test job includes the full candidate SHA in its name. Review that snapshot
before approving `azure-deploy`.

**Approval means trusting that code, including dependency-install scripts,
build scripts and tests, with the existing integration runner's credentials:
model/database credentials and the Azure identity used for CI database access.**
This is not an automatic fork-PR job or a sandbox for unreviewed contributions.
The separate trusted checkout prevents accidentally selecting a PR's workflow,
credential-preparation or qualification scripts; it does not make malicious
candidate code safe on the same machine. Do not approve an unreviewed SHA.

A candidate run with live HorizonDB coverage (`providers=all` or `horizondb`)
runs on the Azure runner. `/test all` is such a run. It takes about an hour,
and the runner takes one job at a time, so requests wait for each other. That machine is not rebuilt between jobs, and its
managed identity can change the test environment. Approving such a run trusts
the candidate code with the machine and that identity, also for later jobs.
See the [runner's limits](../deploy/providers/azure/ci/runner/README.md#limits).

The approved candidate is checked out separately at its pinned SHA. Before
private configuration or Azure login, the workflow rechecks that the PR is
still open, its head is unchanged, and the checkout matches. If it changed while
approval was pending, dispatch a new run and approve the new commit. This tests
the PR **head**, not a synthetic merge result with the latest base.

A candidate's baseline run uses a fresh GitHub-hosted runner. Its live
HorizonDB run uses the Azure runner, as a run of main does. Only an authorized, enabled test job
acquires the shared CI-database concurrency lock; ordinary or rejected comments
cannot displace its pending work. The
default eight-file parallelism, real HDB preflight and bounded qualification
policy remain unchanged. The tested processes and their qualification reports
carry the candidate SHA, separately from the workflow's main SHA.

A separate trusted job posts `Tests / all`, `Tests / baseline`, or
`Tests / horizondb` on that exact PR commit, with a link to the workflow.
Filtered runs have a distinct ` (filtered)` context. A successful status may
mean an initial pass or accepted sequential qualification: consult the run
summary for **PASSED** versus **QUALIFIED**. Cancellation, rejected/skipped
execution and failures do not produce success. The status-writing token never
enters the candidate test job.

Dispatch a new workflow or post a new command to select a new head. Rerunning source selection within
an existing PR run is rejected so it cannot silently select a different SHA.
Rerunning only a failed test job retains its original resolved SHA and rechecks
the head and actor before running. A newer PR commit never inherits the old
commit's status.

These runs neither publish packages nor deploy an application. Successful PR
tests are review evidence; **Create release** still qualifies its own captured,
merged source commit rather than reusing a pre-merge result.

## Dedicated provider database

Run **Provision CI HorizonDB** from `main` to provision or reconcile the CI
cluster using the shared Azure provider Bicep. CI gets its own physical cluster,
parameter group and Key Vault credentials; never point it at the portal cluster.
The provisioning identity needs resource-group Contributor and permission to
read/write the named Key Vault secrets. It uses the same subscription as the
Azure stamp. No concrete names, endpoints or credentials belong in tracked files.

Configure these protected environment secrets:

- `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: the Azure target. Jobs sign in
  as the Azure runner's managed identity, so there is no client ID or secret.
- `AZURE_CI_DATABASE_JSON`: private object with `subscription`, `resourceGroup`,
  `location`, `cluster`, `appCluster`, `parameterGroup`, `vault`, `passwordSecret`,
  `urlSecret`, `embeddingUrl`, `embeddingKeySecret`, `foundryAccount`. CI password and URL secret
  names must start with `ci-`. The embedding endpoint must support the
  `text-embedding-3-small` deployment with 1536 dimensions. Provisioning also
  creates its `-v2` deployment alias for live embedding rotation tests.
- `CI_TEST_ENV_JSON`: environment key/value object including a Copilot-enabled
  `GITHUB_TOKEN` and the credentials required by the test model catalog.
- `MODEL_PROVIDERS_JSON`: the private test model catalog.

The database password is generated in the provisioning Action and retained in
Key Vault. Test Actions read the connection from Key Vault, allow only the
current runner IPv4, and delete that firewall rule in an `always()` step. Rules
are unique per run and retry. If a runner is forcibly lost before cleanup, remove
its stale `ci-<run>-<attempt>` rule via an authorized maintenance Action before
reusing the infrastructure. Never add a broad allow rule.

## Test modes

| Command / Tests Action input | Coverage |
| --- | --- |
| `scripts/run-tests.sh` / `providers=baseline` | Complete stock PostgreSQL suite |
| `scripts/run-tests.sh --all-providers` / `providers=all` | Complete stock PostgreSQL suite once, then all HorizonDB provider tests and reviewed SDK storage integration coverage |
| `scripts/run-tests.sh --with-horizondb` / `providers=horizondb` | Complete suite with CMS, orchestration, facts and graphs on HorizonDB |

`--with horizondb` is an alias. Full HDB mode remaps `DATABASE_URL`,
`PS_TEST_DATABASE_URL` and `TEST_DATABASE_URL` to `HORIZON_DATABASE_URL`, clears
stale runtime routing overrides and uses the same HDB target for graphs.
`PLAIN_DATABASE_URL` is retained only for negative controls that deliberately
require a database without HDB extensions. Mocks and pure tests remain mocks.

The additive HDB pass runs all provider integration tests and 60 currently
reviewed SDK files: CMS SQL/migrations, facts, ACLs, graph composition, storage
lifecycle, API/worker integration and representative durable recovery. It omits
repeated builds, unit tests and provider-independent permutations. The exclusions
are tracked in `scripts/provider-test-coverage.json`; **new SDK files run on HDB
by default** until explicitly reviewed. Deleted or duplicate exclusions fail.
`--horizondb-additive` reruns the selection after a build. Full HDB mode never
uses those exclusions.

Both full live CI modes first require a real HorizonDB initialize/store/read
result; missing or skipped coverage fails. The initial full run rejects user
suite filters and skip flags; only the qualification stage may select its
identified failed cases. The qualified baseline run rejects them too.

### Release qualification

**Create release**, complete live-provider **Tests** runs and a PR candidate's
complete baseline run enable one bounded sequential qualification stage after
the initial full run:

- **0 failures:** pass without sequential execution.
- **1-5 failed test cases total across all provider phases:** run exactly those
  cases once, sequentially, on the same source/model/provider. If every case
  passes, **the run meets the release bar**.
- **6 or more failures:** fail without sequential execution.

Count test-case executions, not files or per-provider subtotals. A test failing
on both PostgreSQL and HDB counts twice. The initial run retains eight-file
parallelism; only the bounded verification uses one worker, no file parallelism
and `maxConcurrency=1`. Already-passing cases are not repeated.

Case-level Vitest results cover SDK tests and Horizon unit/integration tests.
All other prerequisite checks must succeed. Missing/empty/inconsistent reports,
incomplete coverage, build or suite-level setup/hook failures, unhandled errors, process
interruptions, source/provider changes, ambiguous case names and skipped or
still-failing verification cases block qualification.

The original result is never rewritten. Private initial/verification JSON and
run-health evidence remain under the runner's temporary results directory.
`qualification.json` records the decision; the Actions summary publishes only
aggregate counts and **PASSED**, **QUALIFIED** or **FAILED**, not raw error text.
`QUALIFIED` means passed after the single sequential verification and permits
publication. This is an explicit gate stage, not a Vitest retry option or a
repeat-until-green loop. Ordinary local runs remain strict by default.

**The baseline gate.** A complete baseline run with qualification
(`providers=baseline`, no suite filter) applies the same rule to the stock
PostgreSQL suite. Its two case-level reports are the Horizon unit tests and the
SDK tests. It reads no HorizonDB configuration and runs no live HorizonDB
check, so it is not live-provider coverage. One script holds the rule for
both gates: `.github/scripts/run-all-providers.mjs` runs the complete suite
(its `baseline` command for this gate) and hands the recorded results to
`.github/scripts/sequential-qualification.mjs`. Two baseline runs stay strict,
with no sequential verification: a run of main that has no PR number, and
every filtered run.

For diagnosis, dispatch **Tests** with `providers=horizondb` and `suite` set to
space- or comma-separated exact SDK paths, for example
`test/local/cms-seq-nodemap.test.js test/local/contracts.test.js test/local/management.test.js`.
This runs only those files plus the real HDB preflight on the Azure runner,
with the same protected configuration and firewall cleanup. Default file
concurrency remains eight; explicit `mode=sequential` serializes files and
concurrent test cases.
The job is labelled **Targeted HDB diagnostics (not a release gate)**.
It never repeats the PostgreSQL baseline and cannot publish a release.
An independent diagnostic pass lacks the full initial-run evidence. Publication
uses the complete release gate and its bounded qualification decision above.

### Runner placement

Two kinds of runner are used. [CI topology](CI-TOPOLOGY.md) draws the setup.

| Job | Runner | Azure sign-in |
| --- | --- | --- |
| PR checks, deploy script tests, baseline tests | `ubuntu-latest` | None |
| Source selection and status reporting of **Tests** | `ubuntu-latest` | None |
| **Tests** with `providers=all` or `providers=horizondb`, for main or a PR candidate | The Azure runner | The runner's managed identity |
| **Create release**, **Deploy Azure stamp**, **Provision CI HorizonDB** | The Azure runner | The runner's managed identity |
| Dev qualification/packing in `release-common.yml` | The Azure runner | The runner's managed identity |
| Dev source selection and artifact-only publication | `ubuntu-latest` | None |

The Azure runner is one Linux machine in Azure, in the region of the dedicated
CI database. A job on it signs in with `azure/login` and `auth-type: IDENTITY`.
No workflow has the `id-token: write` permission, so no job can trade a GitHub
token for an Azure sign-in. The repository Actions variable
`PROVIDER_TEST_RUNNER` holds the runner's label. Use a repository or
organization variable: environment variables are supplied after runner
selection and cannot choose the runner.

```text
When a job that needs Azure is queued:
1. A reviewer approves the `azure-deploy` environment
2. The runner program on the machine asks GitHub for the job
3. The machine's job hook accepts it only if its workflow file is one of the
   protected ones and comes from `main`
4. The job signs in to Azure as the machine's managed identity
```

The machine runs one job at a time, so a release makes other Azure jobs wait.
A job waits in the queue while the machine is off. Setup, the job hook and the
machine's limits are in [the Azure runner guide](../deploy/providers/azure/ci/runner/README.md).
After this change is merged, an operator must rerun the runner's `setup` command
to install the updated main-only workflow allowlist, which adds `release-dev.yml`.
The reusable workflow runs under its dispatch caller's `GITHUB_WORKFLOW_REF`;
`release-common.yml` itself is not added as a dispatch entrypoint.
An operator who is signed in to Azure sets the machine up. No workflow can:
a GitHub-hosted job has no Azure sign-in.

The release gate runs the complete baseline on its local Docker PostgreSQL
service, then the additive tests against remote HorizonDB. It does not
require a complete second suite on HDB.

The runner sits near the database for a reason. Database-heavy tests perform
many sequential round trips, so a distant runner can cause worker startup and
orchestration deadlines to expire even with spare database CPU and connection
capacity. Do not hide failures by reducing coverage, parallelism or
assertions. Inspect runner placement, database metrics and test timings before
changing deadlines.

Keep the runner's infrastructure under the selected deployment provider. Store
actual labels and infrastructure identifiers in configuration, not these
templates. Setting a label does not provision or grant access to a runner.

### Concurrency

Default file parallelism is **8**, including on smaller runners; callers can
set `PS_TEST_MAX_WORKERS`. The stock PostgreSQL service supports 1500 connections.
HorizonDB parameter groups are immutable. CI provisioning creates a stable
revisioned group with 1500 connections, attaches it through the Action, and
reuses it on later runs. Capacity/settings revisions create another group;
existing groups are never updated in place. The portal group is unchanged. HDB's
capacity preflight requires 40 connections per configured test file by
default (`MIN_HORIZON_MAX_CONNECTIONS` overrides it). No managed server settings
are changed by the test runner. Provider phases remain sequential.

Embeddings use protected Foundry configuration. Live runs serialize against CI
database provisioning. Raw test artifacts are not uploaded because they may
contain private endpoints; GitHub logs mask private configuration.

During live provider gates, `ciHealth` log records sample runner CPU/load,
available memory and fresh local/HDB connection and query timings every 30
seconds. Database samples include aggregate connection counts, not endpoints,
credentials or query text. Failures report a bounded error code and the failing
stage. These are independent read-only probes, not test qualification results.
Use them to distinguish runner pressure from
remote connection stalls before changing capacity or deadlines.

### Model coverage

Storage-provider coverage is separate from model-provider coverage. SDK Vitest
uses `packages/sdk/test/fixtures/model-providers.test.json` unless
`PS_MODEL_PROVIDERS_PATH` overrides it. The default is GitHub Copilot GPT-5.4;
model-switch scenarios also exercise GPT-5.5 and Claude Sonnet 5. The fixture
additionally lists GPT-5.1, GPT-4.1, GPT-4o and Claude Opus 5; being listed does
not prove a live turn occurred. Foundry embeddings use text-embedding-3-small
and a second deployment alias for rotation. Synthetic HTTP compatibility tests
exercise additional model/provider configurations without making live calls.
The portal deployment catalog and separate live-model compatibility command
are not an automatic model matrix in this storage test gate.

The public `scripts/run-tests.sh` remains general-purpose: local users may
configure their own providers without adopting Microsoft's CI infrastructure.
Ordinary merges do not deploy the test environment. Deployment remains an
explicit **Deploy Azure stamp** Action.

## Release and post-release deployment

For a stable release, prepare matching package versions, internal dependencies, lockfile and changelog
in a PR. After merging, dispatch **Create release** (`release-tarballs.yml`)
from `main` with the prepared version. The first planned release is `0.6.0`.
The environment gate occurs once, before testing. The same job then:

1. runs the complete baseline plus additive HorizonDB coverage, including the real
   database gate, and qualifies at most five failed cases through one sequential verification;
2. builds three package tarballs and checksums;
3. creates an annotated tag at the tested SHA, uploads and verifies draft assets,
   and publishes the GitHub Release;
4. signs in to Azure as the runner's managed identity after testing, then
   builds worker and portal images from that exact source SHA and deploys the
   test environment through the shared Azure deployment Action.

More than five failed cases, incomplete coverage or unsuccessful sequential
verification prevents publication. A later deployment failure leaves the valid
release intact. Retry **Deploy Azure stamp** with `release_tag=v<version>`; it
verifies the release is published and the tag is in main's history. Leave that
input blank for an optional update from main. No merge event deploys anything.
Release and deployment runs serialize against other Azure deployments; live
provider runs serialize against CI database provisioning.

The Azure rollout uses the released source commit rather than installing the
`.tgz` assets. Release distribution remains GitHub assets only; the ACR images
exist to run the test environment. No npm registry or starter image is published.
