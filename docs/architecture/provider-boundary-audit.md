# Cloud and deployment provider boundaries

## Decision

Core PilotSwarm must be independent of cloud services and deployment topology.
Azure, GCP, AWS, Kubernetes, VMs and local processes are configured integrations.
Core consumes neutral contracts; providers implement those contracts and own
their SDK dependencies, credentials and resource conventions. An application or
deployment composition layer selects and constructs providers.

PostgreSQL is the deliberate core dependency exception. It does not extend to
managed PostgreSQL offerings, vendor authentication or HorizonDB extensions.
The normative contributor rule is in
[Copilot instructions](../../.github/copilot-instructions.md#cloud-and-deployment-provider-boundary).

## Audit scope and result

Reviewed the current tracked tree at `1e7984d24bbb83e31d12a5580346e9e9d50e1e44`
(1,932 tracked paths). Scanned cloud SDK imports, manifests, cloud/service names,
endpoint handling and topology commands across the repository, then traced
matching runtime, app, provider, deployment and instruction call sites.
Tests, examples, templates and historical design documents were distinguished
from runtime requirements. This is a static source/dependency audit, not a
transitive dependency certification or a new runtime test result. Ignored local
configuration, Git history and live environment state were not part of it.

**Result: the repository does not yet comply.** Several useful provider
interfaces already exist, but concrete cloud dependencies and deployment
assumptions cross those boundaries. This documentation change records the rule
and findings; it does not perform the runtime/package refactors below.

## Confirmed findings

### 1. Azure Blob is embedded in the core SDK — high priority

- `packages/sdk/package.json` has mandatory `@azure/identity` and
  `@azure/storage-blob` dependencies.
- `packages/sdk/src/blob-store.ts` imports both libraries;
  `src/index.ts` re-exports its implementation, and `src/worker.ts` imports and
  constructs it directly in the worker constructor.
- `src/types.ts` exposes Azure connection strings, account URLs and managed
  identity settings on core worker options. Supplying a custom session store
  does not remove the Azure imports or construction path.

**Required boundary:** an optional Azure storage package implements
`SessionStateStore`, `VersionedSnapshotStore` and `ArtifactStore`. Composition
constructs and injects the stores. Core and its public entrypoint must load
without Azure packages installed. Preserve existing callers through an explicit
compatibility adapter while migrating them.

### 2. PostgreSQL authentication assumes Entra — high priority

- `packages/sdk/src/pg-pool-factory.ts` imports `DefaultAzureCredential` and
  hard-codes the Azure PostgreSQL token scope.
- `src/duroxide-provider-factory.ts` selects the native Entra connection method.
  `src/storage-config.ts`, `src/storage-providers.ts` and public options carry
  Azure managed identity settings into generic storage construction.

Password-authenticated PostgreSQL works without an Azure login, but its SDK
dependency graph still contains Azure identity. The PostgreSQL exception does
not justify this coupling.

**Required boundary:** neutral credential/connection factories for PostgreSQL
and orchestration storage, with Entra token acquisition and native Entra
connection setup supplied by the Azure provider.

### 3. Resource Manager assumes Kubernetes and Azure Blob — high priority

- `packages/sdk/src/resourcemgr-tools.ts` directly executes `kubectl get` and
  `kubectl scale`, with fixed Kubernetes namespace/deployment defaults.
- Storage inspection and orphan cleanup access the concrete Azure
  `containerClient` instead of a storage-management interface.
- `src/worker.ts` automatically registers these tools when a catalog exists.
  The bundled Resource Manager agent and skill under `plugins/mgmt/` advertise
  the tools regardless of the selected infrastructure provider.

**Required boundary:** capability-based infrastructure and storage-management
providers. Kubernetes supplies its own implementation, usable on AKS or another
distribution; Azure Blob supplies its own management operations. Register only
supported tools and describe capabilities without assuming a cloud or topology.
The current graceful error when `kubectl` is absent is not an abstraction.

### 4. Worker metadata and diagnostics infer topology — medium priority

- `packages/sdk/src/worker.ts` inspects `KUBERNETES_SERVICE_HOST` to choose
  `aks-default` as the worker pool and label the runtime substrate. Kubernetes
  presence does not establish that the cluster is AKS.
- `src/sweeper-tools.ts` infers Azure/HorizonDB provider identity from database
  host suffixes.

**Required boundary:** deployment providers supply optional metadata; core uses
neutral defaults and configured provider descriptors. Pool targeting must not
depend on an inferred cloud.

### 5. App transport and client authentication are only partly abstracted — medium priority

- `packages/app/tui/src/node-sdk-transport.js` implements Kubernetes API pod/log
  access, service-account handling and `kubectl` log streaming inside the general
  transport. It also constructs the Azure blob implementation.
- Portal server and browser authentication already have provider modules under
  `packages/app/web/auth/providers/` and `web/src/auth/providers/`.
- TUI auth dispatch in `tui/src/auth/cli.js` has provider-specific branches, and
  `mcp/src/auth.ts` implements Entra/MSAL cache access directly.
  `packages/app/package.json` requires both Azure MSAL packages.

**Required boundary:** configurable log-source and client-auth providers; keep
Entra behavior and MSAL dependencies in optional auth adapters. Retain the
portal's provider contracts and reuse that separation across TUI and MCP.

### 6. Model and enhanced-storage adapters still leak into runtime — medium priority

- `packages/sdk/src/session-manager.ts` constructs Azure deployment URLs in its
  legacy model-provider fallback, outside the model provider resolver.
- `src/wif-credentials.ts` owns concrete Entra federation behavior. This is
  provider behavior that needs an explicit adapter boundary, not a core
  credential assumption.
- `src/worker.ts` branches on `storage.runtime.provider === "horizondb"` when
  configuring the harvester. `src/facts-store.ts` dynamically loads concrete HDB
  factories, and `src/storage-config.ts` understands HDB-specific environment
  variables and defaults.

**Required boundary:** model adapters resolve complete request/credential
configuration; core passes it through. Storage adapters own HDB construction
and configuration; consumers use interfaces/capabilities. Keep legacy mapping
at the composition/compatibility boundary.

### 7. Azure templates are separated; deployment orchestration is not — medium priority

- Bicep, GitOps resources and reusable environment templates are correctly
  located under `deploy/providers/azure/`.
- `deploy/scripts/deploy.mjs` directly imports Bicep, secret seeding, manifest
  publishing and Kubernetes rollout operations. Shared `lib/common.mjs`
  accepts only `DEPLOY_PROVIDER=azure`; the scaffolder and service/stage loaders
  also hard-code Azure paths and conventions.
- Legacy `scripts/deploy-aks.sh`, `deploy-portal.sh`, `deploy-mcp.sh`,
  `reset-db-aks.sh`, `deploy/k8s/` and Azure builder templates remain explicitly
  deployment-specific material outside that provider tree.

**Required boundary:** shared commands dispatch to a deployment-provider
contract; move Azure orchestration and topology-specific operations behind it.
Keep Kubernetes implementation distinct from Azure services so a VM provider
can be added without altering core. Compatibility commands may delegate to an
explicit provider. No GCP implementation is required to establish this boundary.

### 8. Root workspace has an AWS dependency without a located consumer — lower priority

The private root `package.json` requires `@aws-sdk/client-s3`. No matching import
or require was found in tracked source. It is not a published SDK dependency,
but should be removed if unused or owned by the optional integration that needs
it. No GCP SDK dependency or concrete GCP runtime adapter was found in this scan.

## Existing boundaries to preserve

- `SessionStateStore`, `VersionedSnapshotStore` and `ArtifactStore` already have
  neutral contracts, with local filesystem implementations.
- `FactStore`, `EnhancedFactStore`, `GraphStore`, `RuntimeStorageProvider` and
  `DuroxideStorageProvider` provide useful storage seams. The HDB implementation
  is in `packages/horizon-store`, listed as an optional SDK peer and loaded
  dynamically. Its advanced capabilities need not become baseline requirements.
- The model registry separates configured model providers; portal authentication
  has explicit provider modules. Their concrete adapters should remain outside
  general runtime behavior.
- Managed Azure workflows and HDB integration tests may intentionally select
  Azure/HDB. Provider-specific tests, examples and deployment instructions are
  valid; their existence does not make those services mandatory for core.

## Implementation order and completion evidence

1. Extract SDK Azure storage and database-auth dependencies into optional
   adapters; migrate composition call sites and compatibility configuration.
2. Introduce infrastructure, storage-management and log-source contracts; move
   Kubernetes/Azure operations and provider-specific agent capabilities there.
3. Remove runtime identity/topology guesses and provider-name branches. Finish
   model/client-auth separation and deployment-command dispatch.
4. Add dependency/import gates once the boundaries exist. Verify a packed core
   install without cloud SDKs, credentials or CLIs, and run the full stock
   PostgreSQL/local suite. Provider contract tests must prove selection and
   capability behavior, with live integration tests for changed adapters.
5. Keep the existing real-HDB CI requirement and eight-worker test parallelism.
   Route any managed-environment deployment through GitHub Actions.

A passing PostgreSQL or HDB test run alone cannot establish architectural
independence: dependency manifests, entrypoint imports and composition boundaries
must also satisfy the rule. Extraction must preserve public compatibility and
durable orchestration replay behavior; it is separate implementation work.
