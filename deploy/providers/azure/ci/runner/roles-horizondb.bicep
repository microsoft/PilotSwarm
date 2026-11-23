// ==============================================================================
// Reader on the HorizonDB location of the subscription, for the runner
// machine's managed identity. Part of roles.bicep; see there.
//
// The stamp's database Bicep refers to a built-in parameter group under
// `Microsoft.HorizonDb/locations/<region>`. That is a subscription-level
// address, so a role on the stamp's resource group does not cover it.
// ==============================================================================
targetScope = 'subscription'

@description('Object ID of the runner machine\'s managed identity.')
param principalId string

@description('Region of the stamp\'s HorizonDB clusters.')
param location string

// Built-in role: Reader.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

#disable-next-line BCP081
resource horizonDbLocation 'Microsoft.HorizonDb/locations@2026-01-20-preview' existing = {
  name: location
}

resource reader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: horizonDbLocation
  name: guid(horizonDbLocation.id, principalId, readerRoleId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
  }
}
