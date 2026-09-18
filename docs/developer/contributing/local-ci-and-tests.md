# Local tests and CI setup

This is the setup guide for contributors running the repository's checks on
their own machine, and maintainers installing the GitHub workflows in their
own repository. Use a checkout of the repository, not an installed release
tarball: the test harness and deployment templates are development sources.

## 1. Prerequisites

- Node.js **24 or later**, npm, Git and Bash. Run Windows commands in WSL.
- Docker for a disposable stock PostgreSQL database, or your own test-only
  PostgreSQL server. The GitHub runner uses PostgreSQL 16.
- For live SDK integration tests, a GitHub token with Copilot access and access
  to the models used by `packages/sdk/test/fixtures/model-providers.test.json`.
  GitHub Actions' automatic `GITHUB_TOKEN` is not a Copilot credential.
- HorizonDB and an embedding endpoint are optional for local baseline tests.
  You cannot emulate the HDB integration gate with stock PostgreSQL in Docker.

Use databases dedicated to tests. The harness creates and removes schemas and
cleans stale test state. Never point it at a portal or production database.

## 2. Run the credential-free PR checks locally

```bash
npm ci
[ -e .model_providers.json ] || cp .model_providers.example.json .model_providers.json
npm run build
npm run test:deploy-scripts
node --test .github/scripts/test/*.test.mjs
npm run test:api --workspace=pilotswarm-sdk
npm run test:unit --workspace=pilotswarm-sdk
npm test --workspace=pilotswarm
```

The Actions check installs the public example catalog in its disposable checkout.
For a fresh local checkout, copy `.model_providers.example.json` to
`.model_providers.json` if that file does not already exist. Preserve any
existing private catalog. These checks do not need Azure credentials.

After staging changes, run `npm run check:privacy`. It scans the **Git index**,
so its input matches what will be committed; ignored local files and historical
commits are excluded. See [repository privacy](../../../.github/REPOSITORY-PRIVACY.md).

## 3. Run the complete stock PostgreSQL suite

Start a fresh, disposable database (choose another host port if 5432 is busy):

```bash
docker run --rm -d --name pilotswarm-test-postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=durable_copilot -p 127.0.0.1:5432:5432 \
  postgres:16 -c max_connections=1500
docker exec pilotswarm-test-postgres pg_isready -U postgres
```

Wait for `accepting connections`. Copy `.env.example` to `.env` only if you
have no existing local config, then edit it privately:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/durable_copilot
GITHUB_TOKEN=<copilot-enabled-token>
```

The local PostgreSQL password above is a disposable development default.
Leave HorizonDB settings out of this file. Then run:

```bash
./scripts/run-tests.sh smoke       # quick live smoke check
./scripts/run-tests.sh             # complete PostgreSQL suite, eight files at once
```

The full wrapper builds and runs its unit and integration stages. `npm test`
alone does not reproduce this complete gate. Files run concurrently, so do not
run two full harnesses against the same database simultaneously. Stop the
disposable database with `docker stop pilotswarm-test-postgres` when finished.

The SDK uses the tracked test model catalog by default; your private root catalog
is not automatically a live model matrix. `PS_MODEL_PROVIDERS_PATH` can override
the SDK catalog, but individual tests may require specific models/providers.
Changing the catalog alone does not port every test to another LLM backend.

## 4. Add your own HorizonDB test database

Provision a dedicated HorizonDB cluster with the extensions configured by
`deploy/providers/azure/services/horizondb/bicep/main.bicep`, including the
vector, text-search, durable embedding and AGE graph surfaces. The existing
cluster-provisioning workflow can do this; see the next section. Stock
PostgreSQL with a few extensions is not a substitute for this live gate.

Copy `.env.horizondb.example` to `.env.horizondb` and fill in your own values.
This file is standalone: include your Copilot token and any model credentials;
the HDB mode does not borrow them from `.env`.

- `DATABASE_URL`: your disposable plain PostgreSQL database, used for
  missing-extension negative controls.
- `HORIZON_DATABASE_URL`: the dedicated HDB test database, with TLS enabled.
  Full-HDB tests also route CMS, orchestration and graphs here.
- `HORIZON_EMBED_URL`, `HORIZON_EMBED_API_KEY`, `HORIZON_EMBED_MODEL`,
  `HORIZON_EMBED_DIM`, `HORIZON_EMBED_API_KEY_HEADER`: a reachable embedding
  deployment. Complete embedding coverage needs `text-embedding-3-small`,
  1536 dimensions and a second `text-embedding-3-small-v2` deployment alias.

Your machine needs database firewall access; the database's in-DB embedder also
needs to reach the embedding endpoint. Coordinate access through your own
environment's deployment process. Microsoft's hosted test environment is
managed through Actions; local contributors should use their own infrastructure.

At eight workers the HDB preflight requires at least 320 connections; our CI
provisioner configures 1500. Parameter groups are immutable: apply a new group
for changed settings. The test harness does not reconfigure managed servers.

```bash
./scripts/run-tests.sh --all-providers
./scripts/run-tests.sh --with horizondb
```

The first runs the full PostgreSQL baseline once plus additive HDB coverage.
The second runs the entire suite on HDB. Both default to eight concurrent files.
For your own smaller machine, explicitly set `PS_TEST_MAX_WORKERS` as needed.
Keep repository defaults unchanged when diagnosing failures.

Local `--all-providers` permits an unconfigured HDB provider and reports the
omission. That is not evidence of HDB coverage. The release/CI wrapper separately
requires successful real HDB initialize/store/read coverage and rejects skips
and filters. Other providers can use the external-suite options in
`scripts/run-tests.sh --help`; local users need not adopt HDB to use the runner.

## 5. Install the GitHub CI system in your own repository

PR checks work without secrets. For live tests and Azure deployment:

1. Enable Actions and make **PR checks / Basic checks** required on `main`.
2. Select your own subscription and region. Bootstrap a resource group and
   deployment identity with Contributor and role-assignment permissions at the
   intended scope. This is a one-time administrative step.
3. Create the protected GitHub environment `azure-deploy`, restrict deployment
   branches to `main`, and configure an authorized reviewer. Configure Azure
   OIDC federation for this repository/environment. Use the actual subject
   emitted by your organization's GitHub OIDC policy; organizations may use
   immutable repository/owner IDs rather than the default name-only subject.
4. Follow the [Azure provider setup](../../../deploy/providers/azure/README.md)
   and [deployment operations](../../../.github/DEPLOYMENT.md) to supply its
   environment secrets and deploy your base infrastructure, Key Vault and Foundry
   account through **Deploy Azure stamp**. Reuse or create your own Entra app;
   configure the redirect URI and intended admission policy separately.
5. Add `CI_TEST_ENV_JSON`, `MODEL_PROVIDERS_JSON` and
   `AZURE_CI_DATABASE_JSON` using the schema in [CI configuration](../../../.github/CI.md).
   Use different cluster names for CI and the portal. Both may use your stamp's
   Key Vault and Foundry account. Give the workflow identity access to those
   resources; never copy another environment's credentials.
6. Run **Provision CI HorizonDB** from `main`, approve its environment gate,
   then run **Tests** with `providers=all` or `providers=horizondb`. The workflow
   temporarily allows its runner IP and removes that rule during cleanup.
7. For release publication, use **Create release** with a version prepared and
   merged on `main`. It runs `all` coverage, publishes package tarballs and then
   deploys the tested source. Ordinary merges do not deploy. Publishing a release
   is an explicit operator action.

Azure, Foundry and Copilot access are prerequisites supplied by the operator.
Running GitHub Actions locally with an emulator does not reproduce environment
approval or GitHub OIDC; run the test commands above locally instead.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connection-capacity preflight fails | PostgreSQL `max_connections`; on HDB use a new parameter group and wait for it to apply |
| Copilot authentication/model failures | Token has Copilot entitlement and access to the fixture's models |
| HDB tests omitted locally | Standalone `.env.horizondb` exists and contains real HDB configuration |
| Embedding tests fail | Endpoint reachable from HDB, API key/header, 1536 dimensions and both deployment aliases |
| Actions waits | Protected environment approval or another run holding the shared CI database |

Never solve CI failures by using the portal database, disabling the live-HDB
gate, or silently skipping tests. Keep raw configuration and credentials out of
issues, commits and logs.

## Consumer and plugin test directories

Plugin and consumer repositories can add an explicit Vitest directory to
the complete PilotSwarm gate without changing its built-in suite:

```bash
./scripts/run-tests.sh --external-test-dir=../plugin-repo/tests/pilotswarm
```

During plugin-only iteration, skip PilotSwarm's built-in phases and provider
setup explicitly:

```bash
./scripts/run-tests.sh --external-only \
  --external-test-dir=../plugin-repo/tests/pilotswarm \
  --external-test-filter=audience-map
```

External directories are optional and are never discovered automatically.
Their tests should use public PilotSwarm package surfaces while keeping
repository-specific fixtures, endpoints, and credentials in the repository
that owns them.

Each supplied directory is an independent Vitest root and must follow this
contract:

- Name test files `*.test.js`, `*.test.mjs`, `*.test.ts`, or `*.test.mts`.
- Write tests for the Node environment. Vitest globals such as `describe`,
  `it`, and `expect` are enabled; tests do not need to import `vitest`.
- Resolve fixtures relative to the test module, for example with
  `import.meta.url`. The supplied directory is Vitest's discovery root, but
  `process.cwd()` remains the PilotSwarm checkout that invokes the runner.
- Install consumer dependencies and prepare generated artifacts before
  invoking the runner. `--external-only` does not build either repository.
  The consumer must install the public `pilotswarm-sdk` version it intends
  to validate; the runner does not substitute the platform checkout's
  private source tree for that package.
- Provide required environment variables and credentials explicitly.
  PilotSwarm's `.env` and provider setup are not loaded by `--external-only`.
- Import supported public package exports rather than private source files.
- Keep shared setup inside the test directory or import it from the consumer
  package. The runner uses `scripts/external-vitest.config.mjs` and does not
  discover a consumer `vitest.config.*` automatically.
- Treat `--external-test-filter` values as test-file path substrings, not
  individual test-name filters.

A minimal external test can be created as
`tests/pilotswarm/platform-contract.test.mjs`:

```js
import { normalizeVisibility } from "pilotswarm-sdk/api";

describe("platform integration", () => {
  it("uses a public platform contract", () => {
    expect(normalizeVisibility("SHARED_READ")).toBe("shared_read");
  });
});
```

Run it from the PilotSwarm checkout:

```bash
./scripts/run-tests.sh --external-only \
  --external-test-dir=../plugin-repo/tests/pilotswarm \
  --external-test-filter=platform-contract
```
