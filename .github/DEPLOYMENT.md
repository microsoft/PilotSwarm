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

One exception: the Azure runner machine itself. The workflows that need Azure
run on it and sign in as its managed identity, so no workflow can create it.
An operator who is signed in to Azure sets it up. See
[CI topology](CI-TOPOLOGY.md) for the whole picture.

| Intent | Workflow on `main` |
| --- | --- |
| Update test environment from current main | **Deploy Azure stamp** (`deploy-azure.yml`) |
| Redeploy an existing published release | Same workflow, `release_tag=v<version>` |
| Reconcile current configuration while retaining existing release images | Same workflow, `release_tag=v<version>` and `reconcile_release_config=true` |
| Provision/reconcile the dedicated test database | **Provision CI HorizonDB** (`provision-ci-database.yml`) |
| Set up, start or deallocate the Azure runner machine | Not a workflow: `deploy/providers/azure/ci/runner/manage.mjs` from an operator shell signed in to Azure ([guide](../deploy/providers/azure/ci/runner/README.md)) |
| Full PostgreSQL baseline plus additive HDB coverage, on main or a reviewed PR head | **Tests** (`tests.yml`), `providers=all`, optional `pr_number`; or maintainer PR comment `/test all` (see [CI.md](CI.md#maintainer-triggered-tests-before-merging-a-pr)) |
| Optional complete suite physically on HDB | **Tests**, `providers=horizondb` |
| Publish a new release and deploy its tested source | **Create release** (`release-tarballs.yml`) |
| Add the copyright/permission notice to an existing release without changing packages or deploying | **Add release license notice** (`release-notices.yml`) |

Use `--repo microsoft/PilotSwarm` for this repository's GitHub commands.
Honor authorization already given in the conversation; do not repeatedly ask
for the same deployment or environment approval. Release publication and
destructive resets require their own explicit authorization. A deployment
request never implies permission to erase data.

Ordinary merges run PR checks but do not deploy. Release publication requires
the complete baseline plus additive HDB gate at eight workers with local Docker
PostgreSQL. The release job runs on the Azure runner, because it also deploys;
the machine must be running. The optional full-HDB suite is not a release
prerequisite. The public test
runner remains usable without HDB; the CI gate separately requires it.
After complete initial coverage, 1-5 failed test cases total may qualify through
one successful sequential verification of exactly those cases on the same source
and provider. Six or more failures fail without sequential verification. Both
results remain visible; incomplete/setup/unhandled failures still block release.
Release assets are three npm-format tarballs, checksums and `LICENSE`. Each new
tarball embeds the same copyright and permission notice. There is no npm
publication or starter-image publication. The Azure workflows build and push
worker/portal images to the configured ACR for deployment, including optional
updates from main before a release.

For pre-merge integration coverage, post a new standalone `/test all` comment
on the PR as a repository writer/maintainer, or dispatch **Tests** on main with `pr_number`,
then review and approve the exact candidate SHA displayed by its selection job.
This intentionally lets approved candidate code use the integration runner's
credentials; it is not an automatic privileged fork-PR trigger. Workflow and
control scripts stay on main, PR candidates use separate checkouts, and
statuses are attached to the selected SHA. A candidate's live HorizonDB run
uses the Azure runner; approving it trusts the code with that machine. See [PR test procedure](CI.md#maintainer-triggered-tests-before-merging-a-pr).
This does not deploy an application or replace the release's own test gate.

Inspect workflow status and pending environment approvals, approve only when
authorized and eligible, and verify rollout health before reporting success.
Record the source SHA, workflow run and result. For portal changes, verify the
public portal serves the intended assets, not just that pods are Ready. Compare
targets using private configuration; do not paste their identifiers into PRs.

No reset, teardown, identity-administration or VPN-maintenance workflow is
currently provided. If one is needed for this managed environment, prepare an
appropriately scoped, reviewed Action and obtain any missing authorization.
Do not fall back to a local mutation. Existing Entra app/redirect configuration,
the Azure runner and its role assignments are one-time administrative prerequisites; the
normal deploy workflow does not create the runner, its identity or the app registration.

For a deployment-template or configuration fix after publication, use
`reconcile_release_config=true` with the existing published `release_tag`.
This explicitly uses current main's deployment templates and protected stamp
configuration, but retains the release commit's existing image tags. It runs
`bicep,seed-secrets,manifests,rollout`, never image build/push or release
publication. The release images must already exist. Record the configuration
workflow SHA separately from the release/image SHA and verify both live images
and effective configuration after reconciliation.

## Configuration and boundaries

The reusable Azure templates live in `deploy/providers/azure/`. Stamp settings
live in ignored `deploy/envs/local/<stamp>/` locally and protected GitHub
environment secrets for Actions. The Action renders them into its temporary
ignored directory and cleans it up.

| Environment secret | Contents |
| --- | --- |
| `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Azure target |
| `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` | Object ID of the Azure runner's managed identity, for resource-level role assignments |
| `AZURE_DEPLOY_ENV` | Complete stamp environment settings |
| `AZURE_MODEL_PROVIDERS_JSON` | Portal model catalog |
| `AZURE_FOUNDRY_DEPLOYMENTS_JSON` | Model deployment definitions |
| `AZURE_CI_DATABASE_JSON` | Dedicated CI database and Key Vault references |
| `CI_TEST_ENV_JSON` | Live test credentials, including a Copilot-enabled token |
| `MODEL_PROVIDERS_JSON` | CI catalog, separate from the portal catalog |

Four plain switches can also be variables of the `azure-deploy` environment:
`WORKSPACES_ENABLED`, `USER_POOL_MIN_COUNT`, `PILOTSWARM_NATIVE_SUBAGENTS` and
`AKS_ENTRA_ID_AUTH`. A set variable wins over the same key in
`AZURE_DEPLOY_ENV`. `AKS_ENTRA_ID_AUTH=true` turns on Microsoft Entra ID
sign-in for the cluster's API; see
[cluster sign-in](../deploy/providers/azure/README.md#cluster-sign-in-with-microsoft-entra-id).
It cannot be turned off again on a cluster.

Key Vault holds generated database passwords/URLs and the Foundry key. Kubernetes
consumes runtime credentials through CSI/Secret projections. The CI cluster is
physically separate from the portal cluster. Tests must never clean portal data.
See [CI configuration](CI.md) for JSON fields, test modes and release sequencing.

Deployment structure, generic names of secrets and configuration keys are public
documentation. Real resource names, endpoints, identities and credentials remain
private. Historical references are outside the current-file privacy check; an
old entry does not prove the resource or identity is retired. See
[repository privacy](REPOSITORY-PRIVACY.md).

## Test portal access using existing authorization settings

To give authenticated test users admin access without per-user allowlists, set
`PORTAL_AUTHZ_DEFAULT_ROLE=admin` and leave both `PORTAL_AUTHZ_ADMIN_GROUPS` and
`PORTAL_AUTHZ_USER_GROUPS` empty/unset in the protected `AZURE_DEPLOY_ENV` secret.
Also clear the legacy `PORTAL_AUTH_ENTRA_ADMIN_GROUPS` and
`PORTAL_AUTH_ENTRA_USER_GROUPS` aliases. Use `__PS_UNSET__` in rendered deployment
configuration; the portal removes that sentinel at startup.

This uses the existing authorization engine. Explicit Entra app-role claims
still take precedence: `user` remains user, `admin` remains admin, and unknown
roles are denied. This setup assumes the test app does not assign admin/user
roles. Do not create role assignments or change role precedence to bypass that
behavior. The Action still requires tenant-specific Entra authentication,
`PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false` and ownership enforcement. Guests
admitted by that tenant are included; this is not an employee-only filter.

To restore individual access, set the default role to `none` and restore the
allowlists. Apply either configuration through the normal deployment Action.

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
