// One HorizonDB cluster backs the runtime, CMS, enhanced facts and AGE graph.
// The app owns separate SQL schemas; this module owns the cluster, its pool,
// its settings group, its login and its firewall rule.
//
// HorizonDB API 2026-10-01-preview rules that this module follows:
// - Compute and the settings group belong to the pool, not to the cluster.
// - A new pool accepts only the built-in settings group. The deploy script
//   attaches the custom group afterwards (ensureHorizonDbParameterGroup).
// - Password setup fails until the cluster has a pool.
// - The administrator login can be set only once.
// - A PUT to a settings group that a pool uses keeps the cluster busy for
//   about a minute, so the cluster PUT waits for the group PUT.
targetScope = 'resourceGroup'

param location string
param clusterName string
param administratorLogin string
@secure()
param administratorLoginPassword string
@description('Compute processor of the pool. Check the region capabilities before changing it.')
param computeProcessor string = 'Intel'
@description('Compute generation of the pool. Check the region capabilities before changing it.')
param computeGeneration int = 1
@minValue(2)
param vCores int = 4
@description('Nodes in the pool. One node has no high availability.')
@minValue(1)
@maxValue(16)
param nodeCount int = 1
param parameterGroupName string
@description('True when the pool does not exist yet. A new pool starts on the built-in settings group, and only a new pool sends the administrator login.')
param poolCreate bool = true
@description('Optional connection capacity override. Zero leaves the service default; CI supplies its tested parallel-run capacity.')
@minValue(0)
@maxValue(5000)
param maxConnections int = 0
@description('Optional stamp AKS egress IPv4. CI clusters omit this and use temporary runner firewall rules.')
param aksOutboundIp string = ''

var poolName = 'DefaultPool'
var builtInParameterGroupId = subscriptionResourceId('Microsoft.HorizonDb/locations/parameterGroups', location, 'default_pg17')

resource parameterGroup 'Microsoft.HorizonDb/parameterGroups@2026-10-01-preview' = {
  name: parameterGroupName
  location: location
  properties: {
    postgreSqlVersion: '17'
    description: 'PilotSwarm facts, embeddings and AGE graph extensions'
    parameters: concat([
      { name: 'azure.extensions', value: 'age,azure_ai,pg_diskann,pg_durable,pg_textsearch,vector' }
      { name: 'shared_preload_libraries', value: 'age,pg_durable,pg_textsearch' }
    ], maxConnections > 0 ? [{ name: 'max_connections', value: string(maxConnections) }] : [])
  }
}

resource cluster 'Microsoft.HorizonDb/clusters@2026-10-01-preview' = {
  name: clusterName
  location: location
  properties: {
    postgreSqlVersion: '17'
    network: { publicAccess: 'Enabled' }
    backup: { geoRedundancy: 'Disabled' }
  }
  dependsOn: [parameterGroup]
}

resource pool 'Microsoft.HorizonDb/clusters/pools@2026-10-01-preview' = {
  parent: cluster
  name: poolName
  properties: {
    computeModel: {
      type: 'Provisioned'
      computeProcessor: computeProcessor
      computeGeneration: computeGeneration
      vCores: vCores
    }
    nodeCount: nodeCount
    highAvailability: { mode: nodeCount > 1 ? 'AnyZone' : 'Disabled' }
    parameterGroup: {
      parameterGroupResourceId: poolCreate ? builtInParameterGroupId : parameterGroup.id
      applyMethod: 'Immediate'
    }
  }
}

// Later deploys send the password alone; the service treats that as a reset
// to the same Key Vault value.
resource passwordAuthentication 'Microsoft.HorizonDb/clusters/authentications@2026-10-01-preview' = {
  parent: cluster
  name: 'passwordMethod'
  properties: union({
    state: 'Enabled'
    administratorLoginPassword: administratorLoginPassword
  }, poolCreate ? { administratorLogin: administratorLogin } : {})
  dependsOn: [pool]
}

resource aksFirewall 'Microsoft.HorizonDb/clusters/pools/firewallRules@2026-10-01-preview' = if (!empty(aksOutboundIp)) {
  parent: pool
  name: 'AllowAksEgress'
  properties: {
    description: 'PilotSwarm AKS stamp egress only'
    startIpAddress: aksOutboundIp
    endIpAddress: aksOutboundIp
  }
}

// New clusters answer only on the endpoint's host name (<cluster>.rw.<id>...).
resource readWriteEndpoint 'Microsoft.HorizonDb/clusters/endpoints@2026-10-01-preview' existing = {
  parent: cluster
  name: clusterName
}

output horizonDbClusterName string = clusterName
output horizonDbFqdn string = readWriteEndpoint.properties.fullyQualifiedDomainName
output horizonDbParameterGroupName string = parameterGroupName
