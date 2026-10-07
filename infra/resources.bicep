targetScope = 'resourceGroup'

param location string = resourceGroup().location
@maxLength(12)
@minLength(3)
param prefix string = 'skill-dlq'
param foundryModel string = 'gpt-5.4'
param foundryModelVersion string = '2026-03-05'
param foundryModelCapacity int = 50
param recoveryEnabled bool = true
param connectorLocation string = 'westcentralus'
param developerPrincipalId string = ''
param demoOwnerId string = ''

var suffix = uniqueString(resourceGroup().id)
var roles = {
  blobOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  queueContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  serviceBusReceiver: '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0'
  serviceBusSender: '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stdlq${suffix}'
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for name in [
  'deploy-app'
  'processed-data'
  'schemas'
  'demo-runs'
]: {
  parent: blobs
  name: name
  properties: { publicAccess: 'None' }
}]

resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: '${prefix}-${suffix}'
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
  }
}

resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: bus
  name: 'data-ingestion'
  properties: {
    lockDuration: 'PT1M'
    maxDeliveryCount: 1
    defaultMessageTimeToLive: 'P7D'
    deadLetteringOnMessageExpiration: true
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'P1D'
    enablePartitioning: true
  }
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-insights-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    SamplingPercentage: 100
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app-${suffix}'
  location: location
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roles.blobOwner)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobOwner)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource queueStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, identity.id, roles.queueContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.queueContributor)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource receiveRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queue.id, identity.id, roles.serviceBusReceiver)
  scope: queue
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.serviceBusReceiver)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource demoSenderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(queue.id, identity.id, roles.serviceBusSender)
  scope: queue
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.serviceBusSender)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource developerStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(developerPrincipalId)) {
  name: guid(storage.id, developerPrincipalId, roles.blobContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobContributor)
    principalId: developerPrincipalId
    principalType: 'User'
  }
}

resource developerQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(developerPrincipalId)) {
  name: guid(queue.id, developerPrincipalId, roles.serviceBusSender)
  scope: queue
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.serviceBusSender)
    principalId: developerPrincipalId
    principalType: 'User'
  }
}

module foundry './foundry.bicep' = {
  name: 'foundry'
  params: {
    name: '${prefix}-ai-${suffix}'
    location: location
    modelName: foundryModel
    modelVersion: foundryModelVersion
    modelCapacity: foundryModelCapacity
    functionPrincipalId: identity.properties.principalId
    developerPrincipalId: developerPrincipalId
  }
}

module connectors './connectors.bicep' = {
  name: 'connectors'
  params: {
    name: '${prefix}-connectors-${suffix}'
    location: connectorLocation
    functionPrincipalId: identity.properties.principalId
    developerPrincipalId: developerPrincipalId
    storageAccountName: storage.name
    serviceBusNamespace: bus.name
    queueName: queue.name
  }
  dependsOn: [containers]
}

module functionApp './function-app.bicep' = {
  name: 'function-app'
  params: {
    name: '${prefix}-app-${suffix}'
    location: location
    storageName: storage.name
    deploymentContainer: 'deploy-app'
    identityId: identity.id
    identityClientId: identity.properties.clientId
    insightsConnection: insights.properties.ConnectionString
    busNamespace: '${bus.name}.servicebus.windows.net'
    queueName: queue.name
    maximumInstances: 100
    extraSettings: {
      AZURE_FUNCTIONS_AGENTS_PROVIDER: 'foundry'
      FOUNDRY_PROJECT_ENDPOINT: foundry.outputs.projectEndpoint
      FOUNDRY_MODEL: foundry.outputs.modelDeploymentName
      SCHEMA_MCP_SERVER_URL: connectors.outputs.schemaEndpoint
      QUEUE_MCP_SERVER_URL: connectors.outputs.queueEndpoint
      INGESTION_MCP_CLIENT_ID: identity.properties.clientId
      DEMO_OWNER_ID: demoOwnerId
      'AzureWebJobs.dlq_repair.Disabled': recoveryEnabled ? 'false' : 'true'
    }
  }
  dependsOn: [blobRole, queueStorageRole, receiveRole, demoSenderRole, containers]
}

module web './web.bicep' = {
  name: 'demo-web'
  params: {
    name: '${prefix}-web-${suffix}'
    functionAppId: functionApp.outputs.id
    functionAppName: functionApp.outputs.name
    functionAppLocation: location
  }
}

output staticWebAppName string = web.outputs.name
output demoUrl string = web.outputs.url
output functionAppName string = functionApp.outputs.name
output appPrincipalId string = identity.properties.principalId
output serviceBusNamespace string = bus.name
output queueName string = queue.name
output storageAccount string = storage.name
output insightsName string = insights.name
output schemaMcpEndpoint string = connectors.outputs.schemaEndpoint
output queueMcpEndpoint string = connectors.outputs.queueEndpoint
output foundryProjectEndpoint string = foundry.outputs.projectEndpoint
output foundryModelDeployment string = foundry.outputs.modelDeploymentName
