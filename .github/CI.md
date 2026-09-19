# CI and Azure test infrastructure

For installation and runnable local/CI setup steps, see [Local tests and CI setup](../docs/developer/contributing/local-ci-and-tests.md).

Every pull request runs **PR checks / Basic checks** without cloud credentials:
workspace builds, deployment tooling, CI policy checks, SDK API/unit tests and
application unit tests. Forks use the same checks. Full live integration runs
are restricted to trusted `main` and the protected `azure-deploy` environment.

## Dedicated provider database

Run **Provision CI HorizonDB** from `main` to provision or reconcile the CI
cluster using the shared Azure provider Bicep. CI gets its own physical cluster,
parameter group and Key Vault credentials; never point it at the portal cluster.
The provisioning identity needs resource-group Contributor and permission to
read/write the named Key Vault secrets. It uses the same subscription as the
Azure stamp. No concrete names, endpoints or credentials belong in tracked files.

Configure these protected environment secrets:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: OIDC login.
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

Both live CI modes first require a real HorizonDB initialize/store/read result;
missing or skipped coverage fails. CI rejects suite filters and skip flags.

### Runner placement

Releases, `providers=all`, baseline tests and PR checks use `ubuntu-latest`.
The release gate runs the complete baseline on its local Docker PostgreSQL
service, then the additive tests against remote HorizonDB. It does not require
an Azure runner or a complete second suite on HDB.

Full-suite `providers=horizondb` is optional and explicitly dispatched. Only this
mode uses the repository or organization Actions variable `PROVIDER_TEST_RUNNER`
to select a Linux/Docker runner near the dedicated database. Leave it unset to
use a standard GitHub-hosted runner.
Use a repository/organization variable: environment variables are supplied
after runner selection and cannot reliably choose the runner.

Standard hosted runners can be allocated in different regions. Database-heavy
tests perform many sequential round trips, so a distant runner can cause worker
startup and orchestration deadlines to expire even with spare database CPU and
connection capacity. Do not select a region by repeatedly rerunning failed jobs
or hide failures by reducing coverage, parallelism or assertions. Inspect runner
placement, database metrics and test timings before changing deadlines.

Runner provisioning and repository access are separate prerequisites. Repository
administrators can use [the Azure CI runner Action](../deploy/providers/azure/ci/runner/README.md)
to provision a dedicated VM and register it for one job. Supply a fresh short-lived
registration token and run this Action **before** queueing an optional full-HDB
run; they share a concurrency group. Register again between jobs and
deallocate after use. No administrator personal token is stored on the runner.
For organization-managed runners, an organization administrator grants repository
access. For GitHub-hosted runners, [Azure private networking](https://docs.github.com/en/organizations/managing-organization-settings/about-azure-private-networking-for-github-hosted-runners-in-your-organization)
places supported larger runners in the subnet's region. A dedicated ephemeral
self-hosted runner is another option. Keep its infrastructure under the selected
deployment provider; never run untrusted PR jobs on a privileged deployment
runner. These protected provider/release workflows run only from `main`.
Store actual labels and infrastructure identifiers in configuration, not these
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

Prepare matching package versions, internal dependencies, lockfile and changelog
in a PR. After merging, dispatch **Create release** (`release-tarballs.yml`)
from `main` with the prepared version. The first planned release is `0.6.0`.
The environment gate occurs once, before testing. The same job then:

1. runs the complete baseline plus additive HorizonDB coverage, including the real database gate;
2. builds three package tarballs and checksums;
3. creates an annotated tag at the tested SHA, uploads and verifies draft assets,
   and publishes the GitHub Release;
4. builds worker and portal images from that exact source SHA and deploys the
   test environment through the shared Azure deployment Action.

A failed test prevents publication. A later deployment failure leaves the valid
release intact. Retry **Deploy Azure stamp** with `release_tag=v<version>`; it
verifies the release is published and the tag is in main's history. Leave that
input blank for an optional update from main. No merge event deploys anything.
Release and deployment runs serialize against other Azure deployments; live
provider runs serialize against CI database provisioning.

The Azure rollout uses the released source commit rather than installing the
`.tgz` assets. Release distribution remains GitHub assets only; the ACR images
exist to run the test environment. No npm registry or starter image is published.
