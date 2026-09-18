# CI and Azure test infrastructure

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
  `urlSecret`, `embeddingUrl`, `embeddingKeySecret`. CI password and URL secret
  names must start with `ci-`. The embedding endpoint must support the
  `text-embedding-3-small` deployment with 1536 dimensions.
- `CI_TEST_ENV_JSON`: environment key/value object including a Copilot-enabled
  `GITHUB_TOKEN` and the credentials required by the test model catalog.
- `MODEL_PROVIDERS_JSON`: the private test model catalog.

The database password is generated in the provisioning Action and retained in
Key Vault. Test Actions read the connection from Key Vault, allow only the
current runner IPv4, and delete that firewall rule in an `always()` step. Rules
are unique per run and retry. If a runner is forcibly lost before cleanup, remove
its stale `ci-<run>-<attempt>` rule via an authorized maintenance Action before
reusing the infrastructure. Never add a broad allow rule.

Run **Tests** with `providers=all` and no suite filter. CI first verifies a real
HorizonDB initialize/store/read operation, rejecting skipped or absent coverage,
then runs all provider phases. PostgreSQL runtime storage is supplied by an
isolated runner service; HorizonDB supplies enhanced facts and graphs. Embeddings
use the protected Foundry configuration. Full test runs share a concurrency
lock with database provisioning. Raw test artifacts are not uploaded because
they can contain private endpoints. GitHub logs mask private configuration.

The public `scripts/run-tests.sh` remains general-purpose: local users may
configure their own providers without adopting Microsoft's CI infrastructure.
Ordinary merges do not deploy the test environment. Deployment remains an
explicit **Deploy Azure stamp** Action.
