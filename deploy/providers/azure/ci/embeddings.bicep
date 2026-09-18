// CI rotates between real deployment identities on the stamp's Foundry account.
// Both preserve the vector dimension while exercising re-embedding and retries.
targetScope = 'resourceGroup'
param accountName string
param modelName string = 'text-embedding-3-small'
param modelVersion string = '1'
resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}
@batchSize(1)
resource embeddings 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [for name in [modelName, '${modelName}-v2']: {
  parent: account
  name: name
  sku: { name: 'GlobalStandard', capacity: 50 }
  properties: {
    model: { format: 'OpenAI', name: modelName, version: modelVersion }
  }
}]
