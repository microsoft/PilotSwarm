# Azure deployment provider

This directory holds the reusable Azure deployment templates for PilotSwarm:

- `envs/template.env` supplies safe defaults and placeholders for a new stamp.
- `services/` contains the Bicep modules and service manifest.
- `gitops/` contains the Kustomize and Flux manifests.

The entry points remain `deploy/scripts/new-env.mjs` and
`deploy/scripts/deploy.mjs`. They currently support `DEPLOY_PROVIDER=azure`.
Each stamp gets a standalone configuration at
`deploy/envs/local/<name>/.env`; the entire `local/` directory is gitignored.
Keep subscription IDs, credentials, access rules, resource names, and endpoints
there. Changes to this provider's templates affect new stamps and
future deployments, but do not rewrite an existing stamp's local configuration.

Scaffold an environment with `npm run deploy:new-env -- <name> --subscription <id> --tenant-id <tenant-id> --location <region>` and inspect
its generated configuration before running `npm run deploy -- all <name>`.
The deploy command provisions Azure resources, pushes worker and portal images
to that stamp's Azure Container Registry, and applies the GitOps manifests.
The **Create release** workflow deploys its tested source after publishing the
GitHub tarballs. An ordinary merge or an independently created tag does not
deploy. See [deployment operations](../../../.github/DEPLOYMENT.md) and
[local CI setup](../../../docs/developer/contributing/local-ci-and-tests.md).

`EDGE_MODE=public` uses AKS managed Azure CNI Overlay networking and the
application-routing NGINX public LoadBalancer. The rollout assigns an Azure
regional DNS label, and cert-manager obtains a Let's Encrypt certificate for
that hostname. The portal must use Entra sign-in, and the provisioned
PostgreSQL server accepts Entra authentication only when the built-in PostgreSQL
option is used. This mode creates no
dedicated VNet, App Gateway, Front Door, or VPN Gateway. Azure still supplies
an AKS-managed VNet for the nodes.

The manual `Deploy Azure stamp` GitHub Action uses the protected
`azure-deploy` GitHub Environment. Put the complete, standalone stamp `.env`
file in the environment secret `AZURE_DEPLOY_ENV`; put its Foundry deployments
array and model-provider catalog in `AZURE_FOUNDRY_DEPLOYMENTS_JSON` and
`AZURE_MODEL_PROVIDERS_JSON`. Set `"type": "openai"` and `"wireApi": "responses"`
on its Foundry provider so Terra can use tools with reasoning enabled.
A model entry can set its own `wireApi`, and the model's value wins. So a
GPT-5.4 deployment next to Terra can stay on Chat Completions with
`{ "name": "gpt-5.4", "wireApi": "completions" }`. The same works the other
way: a provider on Chat Completions can list
`{ "name": "gpt-5.6", "wireApi": "responses" }`.
Nothing about the stamp's subscription, tenant,
resource names, endpoint, app registration, access lists, or contact address
is checked in. The Action writes these files only into the runner's ignored
`deploy/envs/local/ci/` directory, validates the public Entra, allowlist and HorizonDB
posture, deploys from `main`, and removes the files afterwards. It does not
run for pull requests or ordinary pushes.

The same environment needs `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` and
`AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` secrets. The Action runs on the
[Azure runner](ci/runner/README.md), a machine in Azure, and signs in as that
machine's managed identity. `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` is that
identity's object ID. Create the stamp's resource group, then grant the
identity Contributor and Role Based Access Control Administrator on it. Bicep
grants that principal Key Vault Secrets Officer, Storage Blob Data Contributor,
and AcrPush on the new stamp's resources. Give the GitHub Environment a
required reviewer and restrict it to `main` before its first deployment.

HorizonDB uses one database with separate runtime, CMS, enhanced facts and
AGE graph schemas. The Azure provider reserves a stable AKS egress public IP
and adds only that IP to HorizonDB's public firewall; it creates no dedicated
VNet in public mode. The administrator password and connection URL are stored
in the stamp Key Vault. The URL is projected into the worker and portal as
versioned secrets. Foundry's account key is also populated in Key Vault by
Bicep, so no model API key needs to be stored in GitHub.

For a HorizonDB stamp, set `HORIZONDB_ENABLED=true`,
`DEPLOY_POSTGRES=false`, `PILOTSWARM_USE_MANAGED_IDENTITY=0`,
`FOUNDRY_ENABLED=true`, and both database URL `*_SECRET_NAME` settings to
`horizondb-url` in its ignored local env. Add an embedding model deployment
to its Foundry deployments JSON. Run the full `all`
pipeline for first bring-up: base infrastructure seeds the HorizonDB admin
password, the HorizonDB service creates the cluster and firewall and stores
the app URL, then worker and portal mount the versioned URL. Database
password authentication is independent of Blob managed identity, which
remains enabled.

## Cluster sign-in with Microsoft Entra ID

`AKS_ENTRA_ID_AUTH=true` turns on Microsoft Entra ID sign-in for the cluster's
API, the endpoint that kubectl and flux talk to. New stamps have it on. An env
file without the key keeps its cluster as it is.

```text
Without it:
1. `az aks get-credentials` hands out a file with a built-in admin certificate
2. kubectl uses the certificate. The cluster cannot tell who is calling

With it:
1. `az aks get-credentials` hands out a file that says "sign in with Entra ID"
2. The deploy rewrites the file to use the Azure CLI's sign-in (kubelogin)
3. kubectl and flux get a token for that identity: a person, or the managed
   identity of the machine that runs the deploy workflow
4. The cluster checks the identity's Azure role before each call
```

What the switch changes:

- **The cluster.** `aks.bicep` adds the Entra ID block with Azure RBAC for
  Kubernetes. Pods and service accounts inside the cluster are not affected.
- **The deployment principal.** Bicep gives it the role Azure Kubernetes
  Service RBAC Cluster Admin on the cluster. The first rollout after the
  switch waits a few minutes for that role to start working.
- **People.** Anyone who uses kubectl needs a role on the cluster, for example
  Azure Kubernetes Service RBAC Reader, Writer or Cluster Admin. Grant it
  yourself. Then run `az aks get-credentials` and
  `kubelogin convert-kubeconfig --login azurecli`.
- **Tools.** The `rollout` step needs `kubelogin`. The deploy Action installs
  it.

AKS cannot turn Entra ID sign-in off again on a cluster. Some tenants refuse
to create or update a cluster without it (Azure Policy). The deploy then fails
at `base-infra bicep` with "Azure Policy refused a resource".

In GitHub Actions the switch can come from the variable `AKS_ENTRA_ID_AUTH` of
the deploy environment. A set variable wins over the stamp's env file.
