// ==============================================================================
// PilotSwarm BaseInfra — AKS cluster.
//
// Cluster features:
//   - `microsoft.flux` extension (installed as a separate module, since
//     cluster extensions are child resources of the cluster).
//   - `azureKeyvaultSecretsProvider` addon (FR-005) so SecretProviderClass
//     manifests can pull secrets out of the Phase-3 Key Vault.
//   - Application Gateway Ingress Controller (AGIC) addon bound to the
//     WAF_v2 AppGW provisioned in `application-gateway.bicep`.
//   - Workload identity + OIDC issuer enabled so the CSI SPC UAMI's
//     federated credentials work for the worker and portal service
//     accounts.
//   - Kubelet identity is a user-assigned MI (input) so ACR pulls work
//     without an imagePullSecret (FR-004).
//
// Cluster control-plane identity: SystemAssigned for simplicity. The
// cluster's system-assigned MI needs `Managed Identity Operator` on the
// kubelet UAMI; that role assignment is emitted by this module below.
// ==============================================================================

@description('Azure region.')
param location string

@description('AKS cluster name.')
param clusterName string

@description('Kubernetes version.')
param kubernetesVersion string = '1.34'

@description('AKS node subnet ID. Empty in public mode, where AKS manages its own network.')
param aksSubnetId string = ''

@description('Edge topology mode. afd uses AGIC/AppGw. private uses managed NGINX on an internal LoadBalancer. public uses managed NGINX on a public LoadBalancer with AKS-managed Azure CNI Overlay networking. port-forward has no ingress controller.')
@allowed([
  'afd'
  'private'
  'public'
  'port-forward'
])
param edgeMode string = 'afd'

@description('Resource ID of the Application Gateway used by the AGIC addon. Required when edgeMode=afd; ignored when edgeMode=private.')
param applicationGatewayId string = ''

@description('Resource ID of the Log Analytics workspace for the omsAgent (Container Insights) addon. The addon ships pod/node/event telemetry to this workspace using the modern AAD-auth path; the per-cluster Data Collection Rule (see aks-container-insights-dcr.bicep) selects ContainerLogV2.')
param logAnalyticsWorkspaceResourceId string

@description('Resource ID of the pre-created kubelet UAMI.')
param kubeletIdentityResourceId string

@description('Client ID of the kubelet UAMI.')
param kubeletIdentityClientId string

@description('Principal (object) ID of the kubelet UAMI.')
param kubeletIdentityPrincipalId string

@description('Resource ID of the AKS control-plane UAMI.')
param aksControlPlaneIdentityResourceId string

@description('Principal (object) ID of the AKS control-plane UAMI. Used for the Managed Identity Operator role assignment on the kubelet UAMI.')
param aksControlPlaneIdentityPrincipalId string

@description('Optional stamp-owned static public IP used for AKS egress to HorizonDB.')
param outboundPublicIpId string = ''

@description('System node pool VM size.')
param systemPoolVmSize string = 'Standard_D2ds_v5'

@description('User node pool VM size.')
param userPoolVmSize string = 'Standard_D4ds_v5'

@description('User node pool initial node count.')
param userPoolCount int = 2

@description('User node pool autoscaler minimum.')
@minValue(1)
@maxValue(10)
param userPoolMinCount int = 1

@description('Add the `repocache` node pool for the session-workspaces repo pod: one always-on node, tainted so nothing else lands there. The repo-cache Deployment (deploy/providers/azure/gitops/repo-cache) selects it by label and tolerates the taint.')
param repoCachePoolEnabled bool = false

@description('VM size of the repocache pool. The NFS server caches files in the node\'s memory (docs/proposals/session-workspaces.md, section 5.5).')
param repoCachePoolVmSize string = 'Standard_D4ds_v5'

@description('Availability zones. Empty array disables zone placement (useful for dev in zone-limited regions).')
param availabilityZones array = []

@description('Additional agent pools appended to the authoritative agentPoolProfiles array — e.g. externally composed repository-fleet pools. Each entry is a full agentPoolProfile object; this module injects the infra-owned invariants (vnetSubnetID, type) so callers only supply the varying fields (name, count, vmSize, osType, osSKU, osDiskSizeGB, osDiskType, mode, nodeLabels, nodeTaints). Defaults to [] so stamps without fleets are unaffected. At CLUSTER CREATE this PUT creates every pool in one shot; on an EXISTING cluster it only reconciles MUTABLE fields (count/labels/taints) of pools that already exist — Azure forbids ADDING/removing a pool or changing an IMMUTABLE field (vmSize, osType/osSKU, osDisk*) through a managedCluster PUT. The deploy orchestrator (deploy-bicep.mjs reconcileAgentPools) handles those cases out-of-band via the per-pool API BEFORE this PUT, so by the time it runs the live pools already match.')
param additionalAgentPools array = []

// Infra-owned invariants injected into every additional pool. Placed second in
// the union so they win over any caller-supplied value for these keys.
// Deliberately does NOT set orchestratorVersion: like systempool/userpool below,
// the pools inherit the control-plane version implicitly. Pinning it here would
// make every `deploy -- all` request "latest patch of <minor>" and could nudge a
// node reimage on the fleet pools — reconcile must stay churn-free.
var additionalAgentPoolDefaults = union({
  type: 'VirtualMachineScaleSets'
}, edgeMode == 'public' ? {} : {
  vnetSubnetID: aksSubnetId
})
var mergedAdditionalAgentPools = [
  for pool in additionalAgentPools: union(pool, additionalAgentPoolDefaults)
]

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' = {
  name: clusterName
  location: location
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${aksControlPlaneIdentityResourceId}': {}
    }
  }
  properties: {
    enableRBAC: true
    dnsPrefix: clusterName
    nodeResourceGroup: '${clusterName}-nodes'
    kubernetesVersion: kubernetesVersion
    identityProfile: {
      kubeletidentity: {
        resourceId: kubeletIdentityResourceId
        clientId: kubeletIdentityClientId
        objectId: kubeletIdentityPrincipalId
      }
    }
    agentPoolProfiles: concat([
      union({
        name: 'systempool'
        mode: 'System'
        count: 1
        minCount: 1
        maxCount: 5
        enableAutoScaling: true
        vmSize: systemPoolVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        osDiskSizeGB: 60
        osDiskType: 'Ephemeral'
        type: 'VirtualMachineScaleSets'
        availabilityZones: availabilityZones
        nodeTaints: [
          'CriticalAddonsOnly=true:NoSchedule'
        ]
      }, edgeMode == 'public' ? {} : {
        vnetSubnetID: aksSubnetId
      })
      union({
        name: 'userpool'
        mode: 'User'
        count: max(userPoolCount, userPoolMinCount)
        minCount: userPoolMinCount
        maxCount: 10
        enableAutoScaling: true
        vmSize: userPoolVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        osDiskSizeGB: 128
        osDiskType: 'Ephemeral'
        type: 'VirtualMachineScaleSets'
        availabilityZones: availabilityZones
      }, edgeMode == 'public' ? {} : {
        vnetSubnetID: aksSubnetId
      })
    ], mergedAdditionalAgentPools)
    addonProfiles: edgeMode == 'afd' ? {
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '30m'
        }
      }
      ingressApplicationGateway: {
        enabled: true
        config: {
          applicationGatewayId: applicationGatewayId
        }
      }
      omsAgent: {
        enabled: true
        config: {
          useAADAuth: 'true'
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceResourceId
        }
      }
    } : {
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '30m'
        }
      }
      omsAgent: {
        enabled: true
        config: {
          useAADAuth: 'true'
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceResourceId
        }
      }
    }
    // AKS application routing belongs to ingressProfile, not addonProfiles.
    // In private mode deploy.mjs patches the managed NGINX controller's
    // LoadBalancer annotations after the cluster is ready.
    ingressProfile: {
      webAppRouting: {
        enabled: edgeMode == 'private' || edgeMode == 'public'
      }
    }
    networkProfile: union({
      networkPlugin: 'azure'
      networkPolicy: 'calico'
      dnsServiceIP: '10.0.0.10'
      serviceCidrs: [
        '10.0.0.0/16'
      ]
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
    }, edgeMode == 'public' ? union({
      // Without a custom subnet, use Azure CNI Overlay on the AKS-managed VNet.
      networkPluginMode: 'overlay'
    }, empty(outboundPublicIpId) ? {} : {
      loadBalancerProfile: {
        outboundIPs: {
          publicIPs: [
            { id: outboundPublicIpId }
          ]
        }
      }
    }) : {})
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    oidcIssuerProfile: {
      enabled: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: false
    }
  }
}

// ---------------------------------------------------------------------------
// Managed Identity Operator: the cluster control-plane UAMI must be able
// to operate the kubelet UAMI (read/use it as the kubelet identity).
// With UserAssigned cluster identity, aks.identity.principalId is null, so
// we assign the role to the control-plane UAMI's principal directly.
// ---------------------------------------------------------------------------
var managedIdentityOperatorRoleId = 'f1a07417-d97a-45cb-824c-7a7467783830'

// Session workspaces: the repo pod's own node. A separate agent pool
// resource, not an entry in agentPoolProfiles: AKS refuses to add a pool to
// an existing cluster through the managed cluster API ("Adding agent pools to
// an existing cluster is not allowed through managed cluster operations"). A
// later cluster update that does not list this pool leaves it alone. No
// autoscaling, so the node is always there; the taint keeps workers and
// everything else off it. Turning the switch off does not delete the pool.
resource repoCachePool 'Microsoft.ContainerService/managedClusters/agentPools@2024-05-01' = if (repoCachePoolEnabled) {
  parent: aks
  name: 'repocache'
  properties: union({
    mode: 'User'
    count: 1
    enableAutoScaling: false
    vmSize: repoCachePoolVmSize
    osType: 'Linux'
    osSKU: 'AzureLinux'
    osDiskSizeGB: 128
    osDiskType: 'Ephemeral'
    type: 'VirtualMachineScaleSets'
    availabilityZones: availabilityZones
    nodeLabels: {
      'pilotswarm.dev/pool': 'repo-cache'
    }
    nodeTaints: [
      'pilotswarm.dev/repo-cache=true:NoSchedule'
    ]
  }, edgeMode == 'public' ? {} : {
    vnetSubnetID: aksSubnetId
  })
}

resource kubeletIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: last(split(kubeletIdentityResourceId, '/'))
}

resource miOperatorDef 'Microsoft.Authorization/roleDefinitions@2022-04-01' existing = {
  scope: kubeletIdentity
  name: managedIdentityOperatorRoleId
}

resource assignMiOperatorToCluster 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kubeletIdentity.id, aksControlPlaneIdentityResourceId, managedIdentityOperatorRoleId)
  scope: kubeletIdentity
  properties: {
    principalId: aksControlPlaneIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: miOperatorDef.id
  }
}

// ---------------------------------------------------------------------------
// Flux extension. Uses the kubelet identity for Azure Blob authentication,
// matching the approach in the reference deployment (the Flux Azure Blob
// source controller does not yet support workload identity).
// ---------------------------------------------------------------------------
// After the repocache pool: writing the extension makes AKS update its
// add-ons, and an agent pool write that overlaps it fails ("Another operation
// is in progress"). Both used to start together once the cluster was written.
resource fluxExtension 'Microsoft.KubernetesConfiguration/extensions@2023-05-01' = {
  scope: aks
  name: 'flux'
  dependsOn: [
    repoCachePool
  ]
  properties: {
    extensionType: 'microsoft.flux'
    autoUpgradeMinorVersion: true
    configurationSettings: {
      useKubeletIdentity: 'true'
    }
    scope: {
      cluster: {
        releaseNamespace: 'flux-system'
      }
    }
  }
}

output aksClusterId string = aks.id
output aksClusterName string = aks.name
output aksControlPlanePrincipalId string = aksControlPlaneIdentityPrincipalId
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
output nodeResourceGroup string = aks.properties.nodeResourceGroup

// AGIC addon's auto-created managed identity. The AKS RP names it deterministically
// `ingressapplicationgateway-<clusterName>` in the cluster's node resource group.
// Consumed by `agic-rbac.bicep` to grant Contributor/MI-Operator/Network-Contributor.
// In private mode (webAppRouting addon) this identity does not exist and the
// emitted name is unused — agic-rbac is itself skipped at the main.bicep layer.
output agicAddonIdentityName string = 'ingressapplicationgateway-${aks.name}'
