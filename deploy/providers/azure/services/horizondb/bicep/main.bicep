// One HorizonDB cluster backs the runtime, CMS, enhanced facts and AGE graph.
// The app owns separate SQL schemas; this module owns the cluster and its firewall.
targetScope = 'resourceGroup'

param location string
param clusterName string
param administratorLogin string
@secure()
param administratorLoginPassword string
@minValue(2)
param vCores int = 4
@minValue(1)
param replicaCount int = 1
param parameterGroupName string
param parameterGroupCreate bool = true
param clusterCreate bool = true
@description('Optional stamp AKS egress IPv4. CI clusters omit this and use temporary runner firewall rules.')
param aksOutboundIp string = ''

resource parameterGroupNew 'Microsoft.HorizonDb/parameterGroups@2026-01-20-preview' = if (parameterGroupCreate) {
  name: parameterGroupName
  location: location
  properties: {
    pgVersion: 17
    description: 'PilotSwarm facts, embeddings and AGE graph extensions'
    parameters: [
      { name: 'azure.extensions', value: 'age,azure_ai,pg_diskann,pg_durable,pg_textsearch,vector' }
      { name: 'shared_preload_libraries', value: 'age,pg_durable,pg_textsearch' }
    ]
  }
}

resource parameterGroupExisting 'Microsoft.HorizonDb/parameterGroups@2026-01-20-preview' existing = {
  name: parameterGroupName
}

var parameterGroupId = parameterGroupCreate ? parameterGroupNew!.id : parameterGroupExisting.id

resource clusterNew 'Microsoft.HorizonDB/clusters@2026-01-20-preview' = if (clusterCreate) {
  name: clusterName
  location: location
  properties: {
    createMode: 'Create'
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    version: '17'
    vCores: vCores
    replicaCount: replicaCount
    parameterGroup: {
      id: parameterGroupId
      applyImmediately: true
    }
  }
}

resource clusterExisting 'Microsoft.HorizonDB/clusters@2026-01-20-preview' existing = {
  name: clusterName
}

resource aksFirewall 'Microsoft.HorizonDb/clusters/pools/firewallRules@2026-01-20-preview' = if (!empty(aksOutboundIp)) {
  name: '${clusterName}/DefaultPool/AllowAksEgress'
  properties: {
    description: 'PilotSwarm AKS stamp egress only'
    startIpAddress: aksOutboundIp
    endIpAddress: aksOutboundIp
  }
  dependsOn: [clusterNew]
}

output horizonDbClusterName string = clusterName
output horizonDbFqdn string = clusterCreate ? clusterNew!.properties.fullyQualifiedDomainName : clusterExisting.properties.fullyQualifiedDomainName
output horizonDbParameterGroupName string = parameterGroupName
