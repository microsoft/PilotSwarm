# Deployment operations

Use this document to choose the deployment path before following an agent,
skill or legacy shell recipe. For a fresh machine or a fork's CI setup, start
with [local CI and tests](../docs/developer/contributing/local-ci-and-tests.md).

## Provider boundary

Azure is this repository's current managed deployment provider. It is not a
core PilotSwarm requirement. Cloud services and topology choices (including AKS
versus VMs) belong behind provider interfaces; PostgreSQL is the explicit core
dependency exception. Keep provider templates under `deploy/providers/<provider>/`
and instance settings separate. The shared deployment entrypoints still contain
Azure-specific implementation that needs extraction; see the
[provider-boundary audit](../docs/architecture/provider-boundary-audit.md).
Follow the [Copilot architectural rule](./copilot-instructions.md#cloud-and-deployment-provider-boundary)
when adding or changing deployment code.

## This repository's managed Azure environment

All infrastructure changes and application deployments run through GitHub
Actions. Local scaffolding, builds, tests and read-only inspection are allowed.
Do not run local Azure/Kubernetes mutations or legacy deploy/reset scripts
against the managed environment.

| Intent | Workflow on `main` |
| --- | --- |
| Update test environment from current main | **Deploy Azure stamp** (`deploy-azure.yml`) |
| Redeploy an existing published release | Same workflow, `release_tag=v<version>` |
| Provision/reconcile the dedicated test database | **Provision CI HorizonDB** (`provision-ci-database.yml`) |
| Full PostgreSQL baseline plus additive HDB coverage | **Tests** (`tests.yml`), `providers=all` |
| Complete suite physically on HDB | **Tests**, `providers=horizondb` |
| Publish a new release and deploy its tested source | **Create release** (`release-tarballs.yml`) |

Use `--repo microsoft/PilotSwarm` for this repository's GitHub commands.
Honor authorization already given in the conversation; do not repeatedly ask
for the same deployment or environment approval. Release publication and
destructive resets require their own explicit authorization. A deployment
request never implies permission to erase data.

Ordinary merges run PR checks but do not deploy. Release publication requires
the complete baseline plus additive HDB gate at eight workers. The public test
runner remains usable without HDB; the hosted CI gate separately requires it.
Release assets are three npm-format tarballs and checksums. There is no npm
publication or starter-image publication. The Azure workflows build and push
worker/portal images to the configured ACR for deployment, including optional
updates from main before a release.

Inspect workflow status and pending environment approvals, approve only when
authorized and eligible, and verify rollout health before reporting success.
Record the source SHA, workflow run and result. For portal changes, verify the
public portal serves the intended assets, not just that pods are Ready. Compare
targets using private configuration; do not paste their identifiers into PRs.

No reset, teardown, identity-administration or VPN-maintenance workflow is
currently provided. If one is needed for this managed environment, prepare an
appropriately scoped, reviewed Action and obtain any missing authorization.
Do not fall back to a local mutation. Existing Entra app/redirect configuration
and deployment OIDC/RBAC setup are one-time administrative prerequisites; the
normal deploy workflow does not create the GitHub identity or app registration.

## Configuration and boundaries

The reusable Azure templates live in `deploy/providers/azure/`. Stamp settings
live in ignored `deploy/envs/local/<stamp>/` locally and protected GitHub
environment secrets for Actions. The Action renders them into its temporary
ignored directory and cleans it up.

| Environment secret | Contents |
| --- | --- |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | OIDC identity and Azure target |
| `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` | Principal for resource-level role assignments |
| `AZURE_DEPLOY_ENV` | Complete stamp environment settings |
| `AZURE_MODEL_PROVIDERS_JSON` | Portal model catalog |
| `AZURE_FOUNDRY_DEPLOYMENTS_JSON` | Model deployment definitions |
| `AZURE_CI_DATABASE_JSON` | Dedicated CI database and Key Vault references |
| `CI_TEST_ENV_JSON` | Live test credentials, including a Copilot-enabled token |
| `MODEL_PROVIDERS_JSON` | CI catalog, separate from the portal catalog |

Key Vault holds generated database passwords/URLs and the Foundry key. Kubernetes
consumes runtime credentials through CSI/Secret projections. The CI cluster is
physically separate from the portal cluster. Tests must never clean portal data.
See [CI configuration](CI.md) for JSON fields, test modes and release sequencing.

Deployment structure, generic names of secrets and configuration keys are public
documentation. Real resource names, endpoints, identities and credentials remain
private. Historical references are outside the current-file privacy check; an
old entry does not prove the resource or identity is retired. See
[repository privacy](REPOSITORY-PRIVACY.md).

## Users managing their own environments

The public Bicep/GitOps orchestrator can also be run by operators against their
own infrastructure, following [the orchestrator reference](../deploy/scripts/README.md).
The detailed new-environment and legacy AKS skill references describe those
operator-managed paths. They do not override this repository's managed-environment
policy. Prove the selected target rather than assuming every request for “the
cluster” means the legacy bash deployment. Do not mix deployment controllers for
one environment or propagate changes to downstream apps without a request.

App-registration and role-assignment helpers are optional: select the operator's
actual auth posture first. Microsoft-specific Service Tree requirements apply
when that tenant policy is in force, not to every user's Azure tenant. VPN steps
apply only to stamps configured with a VPN gateway. A public deployment still
has an AKS-managed node VNet; it does not need a separate application VNet.
