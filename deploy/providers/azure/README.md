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
Publishing a GitHub Release does not run this deployment.

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
Nothing about the stamp's subscription, tenant,
resource names, endpoint, app registration, access lists, or contact address
is checked in. The Action writes these files only into the runner's ignored
`deploy/envs/local/ci/` directory, validates the public Entra, allowlist and HorizonDB
posture, deploys from `main`, and removes the files afterwards. It does not
run for pull requests or ordinary pushes.

The same environment needs `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, and `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` secrets for its
OIDC service principal. Configure an Azure federated identity credential with
issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and subject
`repo:<owner>/<repo>:environment:azure-deploy`. Grant the principal resource
group creation and role-assignment rights on the target subscription. Bicep
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
