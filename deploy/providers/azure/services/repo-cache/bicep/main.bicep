// ==============================================================================
// PilotSwarm repo-cache — manifest container + Flux configuration.
// ==============================================================================
// Scope: resource group (BaseInfra RG — same RG that owns the storage account
// and AKS cluster).
//
// The repo pod for session workspaces (docs/proposals/session-workspaces.md,
// section 12.1): it mirrors a public repo, keeps session clones and a sandbox
// remote, and exports them over NFS to the worker nodes. Like the worker, its
// Kubernetes objects are reconciled by Flux from a manifest blob container
// that this module owns (deploy/providers/azure/gitops/repo-cache/).
//
// Conditional: the orchestrator (deploy/scripts/deploy.mjs) skips the whole
// `repo-cache` service unless WORKSPACES_ENABLED=true, so this module needs no
// gate of its own.
//
// What this module does:
//   1. Creates the `repo-cache-manifests` blob container in the BaseInfra
//      storage account.
//   2. Configures Flux on the BaseInfra AKS cluster to reconcile from that
//      container (kustomizationPath = `overlays/default`).
//
// Pre-requisites (delivered by BaseInfra):
//   - Storage account exists.
//   - AKS cluster exists with the `microsoft.flux` extension installed and
//     `useKubeletIdentity: 'true'`.
//   - The AKS kubelet UAMI has `Storage Blob Data Reader` on the storage
//     account (account-scope grant in storage.bicep).
// ==============================================================================

targetScope = 'resourceGroup'

@description('Timestamp for unique deployment names.')
param dTime string = utcNow()

@description('BaseInfra storage account name (Flux source for the repo-cache-manifests container).')
param storageAccountName string

@description('BaseInfra AKS cluster name (parent of the Flux extension).')
param aksClusterName string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storageAccount
  name: 'default'
}

resource repoCacheManifestsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'repo-cache-manifests'
  properties: {
    publicAccess: 'None'
  }
}

module RepoCacheFluxConfig '../../common/bicep/flux-config.bicep' = {
  name: 'repo-cache-flux-${dTime}'
  params: {
    aksClusterName: aksClusterName
    configName: 'repo-cache'
    blobContainerEndpoint: storageAccount.properties.primaryEndpoints.blob
    containerName: repoCacheManifestsContainer.name
    kustomizationPath: 'overlays/default'
  }
}

@description('repo-cache manifest container name (consumed by the OSS deploy script as DEPLOYMENT_STORAGE_CONTAINER_NAME via FR-022 alias).')
output manifestsContainerName string = repoCacheManifestsContainer.name
