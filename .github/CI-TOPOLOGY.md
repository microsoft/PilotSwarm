# CI topology

Where this repository's test and deployment jobs run, what they sign in as, and
what each identity may do. Names in angle brackets are placeholders. The real
names and IDs live in the protected `azure-deploy` environment's secrets and in
ignored local files, never in tracked files (see
[Repository privacy](REPOSITORY-PRIVACY.md)).

Related: [CI and tests](CI.md), [deployment operations](DEPLOYMENT.md), the
[Azure runner](../deploy/providers/azure/ci/runner/README.md).

## The picture

```text
GITHUB   <owner>/<repo>
│
├─ Environment `azure-deploy`
│    reviewers ....... must approve every job that uses the environment
│    branches ........ `main` only
│    secrets ......... Azure tenant and subscription, deploy settings,
│                      CI database settings, test settings
│
├─ Jobs that need no Azure                      -> GitHub-hosted runners
│    PR checks · deploy script tests · baseline tests
│    source selection and status reporting of the Tests workflow
│
├─ Jobs that need Azure                         -> the Azure runner
│    Tests with live HorizonDB · Create release
│    Deploy Azure stamp · Provision CI HorizonDB
│
└─ Runner registration: one runner, label from variable `PROVIDER_TEST_RUNNER`
        ▲
        │  outbound HTTPS only: the machine asks GitHub for jobs
        │  and sends the logs back
        │
AZURE    <tenant>
│
└─ Subscription  <subscription>
   │
   └─ Resource group  <resource-group>   (one region)
       │
       ├─ RUNNER
       │    Machine     <runner-name>      Linux, 8 cores
       │    Network     its own, no peering, all inbound denied
       │    Outbound    one fixed public address
       │    Identity    system-assigned managed identity
       │                -> every Azure job signs in as this
       │
       ├─ TEST ENVIRONMENT
       │    AKS cluster          worker and portal pods. API sign-in with
       │                         Microsoft Entra ID (`AKS_ENTRA_ID_AUTH=true`)
       │    Container registry   worker and portal images
       │    Key Vault            deploy secrets and CI database secrets
       │    Storage account      manifests that Flux applies to the cluster
       │    HorizonDB cluster    the environment's database
       │    Foundry account      models and embeddings
       │
       ├─ CI DATABASE
       │    HorizonDB cluster    used by live tests only, separate from the
       │                         environment's database
       │
       └─ CLUSTER IDENTITIES (user-assigned)
            control plane · kubelet · pod workload · application gateway
            · private endpoint approver
```

## What a job on the runner does in Azure

```text
Job, signed in as the runner's identity
  -> Azure Resource Manager   create and update the resource group's resources (Bicep)
  -> Container registry       push the worker and portal images
  -> Key Vault                read and write secrets
  -> Storage account          upload manifests
  -> AKS API                  kubectl and flux. With Entra ID sign-in on the
                              cluster they sign in as the runner's identity
                              through kubelogin
  -> CI HorizonDB             add a firewall rule for the runner's outbound
                              address, run the tests, remove the rule
```

The cluster then works without the runner: Flux reads the manifests from the
storage account, and the nodes pull the images from the registry.

## Identities and permissions

| Identity | Used by | Roles | Granted by |
| --- | --- | --- | --- |
| Runner's managed identity | Every job on the Azure runner | Contributor and Role Based Access Control Administrator on the resource group | `manage.mjs grant`, from `deploy/providers/azure/ci/runner/roles.bicep` |
| | | Reader on the HorizonDB location of the subscription | `manage.mjs grant`, from the same file |
| | | AcrPush on the registry; Key Vault Secrets Officer on the vault; Storage Blob Data Contributor on the storage account | The stamp's Bicep, for the object ID in `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` |
| | | Azure Kubernetes Service RBAC Cluster Admin on the cluster, when `AKS_ENTRA_ID_AUTH=true` | The stamp's Bicep, for the same object ID |
| A person who uses kubectl | That person | A role on the cluster, for example Azure Kubernetes Service RBAC Reader, when `AKS_ENTRA_ID_AUTH=true` | An operator |
| Kubelet identity | Cluster nodes | AcrPull on the registry; Storage Blob Data Reader on the storage account | The stamp's Bicep |
| Pod workload identity | Worker and portal pods, through their Kubernetes service accounts | Key Vault Secrets User on the vault; Storage Blob Data Contributor on the storage account | The stamp's Bicep |
| Control plane identity | The AKS control plane | Network Contributor on the resource group; Managed Identity Operator on the kubelet identity | The stamp's Bicep |
| Application gateway identity | The application gateway | Key Vault Secrets User on the vault | The stamp's Bicep |
| Private endpoint approver | Deployment scripts in the stamp's Bicep | Reader on the resource group; Key Vault Certificates Officer on the vault | The stamp's Bicep |

The runner's identity has wide rights on one resource group and almost nothing
outside it. Tests alone need far less than a deployment does. One machine runs
both, so its identity carries the rights of both.

## Sign-ins

| From | To | How |
| --- | --- | --- |
| Runner machine | GitHub | A key pair made at registration. GitHub holds the public key. No personal token |
| A job's steps | GitHub | The job's own `GITHUB_TOKEN`, limited by the workflow's `permissions` |
| A job's steps | Azure | `azure/login` with `auth-type: IDENTITY`: the machine's managed identity |
| A job's kubectl and flux | The cluster's API | With Entra ID sign-in on the cluster: a token for the machine's managed identity, fetched by kubelogin from the Azure CLI's sign-in. Without it: the cluster's built-in admin certificate |
| Pods | Azure | Workload identity of their Kubernetes service account |

No workflow has the `id-token: write` permission, so no job can ask GitHub for
a token to exchange for an Azure sign-in.

## Who can make a job run on the runner

```text
1. A person with write access dispatches a protected workflow from `main`,
   or posts `/test all` on a pull request
2. A reviewer of `azure-deploy` approves the job
3. The job hook on the machine accepts the job: its workflow file is on the
   accepted list and comes from `main`
```

The hook is needed because step 2 protects the environment's secrets, not the
machine. See [what protects the identity](../deploy/providers/azure/ci/runner/README.md#what-protects-the-identity).

## Where the real values are

| Value | Place |
| --- | --- |
| Tenant and subscription | Environment secrets `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |
| Object ID of the runner's identity | Environment secret `AZURE_DEPLOY_PRINCIPAL_OBJECT_ID` |
| Stamp resource names and settings | Environment secret `AZURE_DEPLOY_ENV` |
| CI database, vault and Foundry names | Environment secret `AZURE_CI_DATABASE_JSON` |
| Runner label | Repository variable `PROVIDER_TEST_RUNNER` |
| Runner machine name, size and region | The operator's `AZURE_CI_RUNNER_JSON` (not stored in GitHub) |
