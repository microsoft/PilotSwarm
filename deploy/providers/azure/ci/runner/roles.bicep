// ==============================================================================
// What the runner machine's managed identity may do in Azure.
//
// A new managed identity can sign in, but it may do nothing. This file gives
// the runner's identity the rights that nothing else gives it. Apply it with
// `manage.mjs grant` (see README.md).
//
//   Granted here:
//     - Contributor on the stamp's resource group: the deploy creates and
//       changes the stamp's resources there (Bicep).
//     - Role Based Access Control Administrator on the same resource group:
//       the stamp's Bicep gives roles to the cluster's own identities.
//     - Reader on the HorizonDB location of the subscription (when the stamp
//       uses HorizonDB): the database Bicep refers to a built-in parameter
//       group that lives there, outside the resource group.
//
//   Granted by the stamp's own Bicep, to the object ID in
//   AZURE_DEPLOY_PRINCIPAL_OBJECT_ID (not here):
//     - AcrPush on the registry, Key Vault Secrets Officer on the vault,
//       Storage Blob Data Contributor on the storage account (base-infra)
//     - Azure Kubernetes Service RBAC Cluster Admin on the cluster, when
//       AKS_ENTRA_ID_AUTH=true (base-infra, aks.bicep)
//
// The names are fixed by scope, identity and role, so applying this again
// changes nothing. A grant of the same role that someone made by hand under
// another name must be removed first: Azure refuses a second one.
// ==============================================================================
targetScope = 'resourceGroup'

@description('Object ID of the runner machine\'s managed identity.')
param principalId string

@description('Region of the stamp\'s HorizonDB clusters. Empty when the stamp does not use HorizonDB: the location grant is then left out.')
param horizonDbLocation string = ''

// Built-in role: Contributor.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

// Built-in role: Role Based Access Control Administrator.
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'

resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, contributorRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

resource rbacAdministrator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalId, rbacAdministratorRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
  }
}

// The HorizonDB location is not in a resource group, so its grant is a
// deployment at subscription scope.
module horizonDbReader './roles-horizondb.bicep' = if (!empty(horizonDbLocation)) {
  name: 'ci-runner-horizondb-reader-${uniqueString(principalId, horizonDbLocation)}'
  scope: subscription()
  params: {
    principalId: principalId
    location: horizonDbLocation
  }
}

output grantedOnResourceGroup array = [
  'Contributor'
  'Role Based Access Control Administrator'
]
output grantedOnHorizonDbLocation bool = !empty(horizonDbLocation)
