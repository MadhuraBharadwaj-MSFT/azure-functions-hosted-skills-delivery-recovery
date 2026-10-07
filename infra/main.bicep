targetScope = 'subscription'

param environmentName string
param location string = 'eastus2'
param foundryModel string = 'gpt-5.4'
param foundryModelVersion string = '2026-03-05'
@minValue(1)
param foundryModelCapacity int = 500
param connectorLocation string = 'westcentralus'
param developerPrincipalId string = ''
@description('Owner userId from this Static Web App /.auth/me. Empty denies all demo API access.')
param demoOwnerId string = ''

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: { 'azd-env-name': environmentName }
}

module resources './resources.bicep' = {
  name: 'dlq-resources'
  scope: group
  params: {
    location: location
    foundryModel: foundryModel
    foundryModelVersion: foundryModelVersion
    foundryModelCapacity: foundryModelCapacity
    connectorLocation: connectorLocation
    developerPrincipalId: empty(developerPrincipalId) ? deployer().objectId : developerPrincipalId
    demoOwnerId: demoOwnerId
  }
}

output AZURE_RESOURCE_GROUP string = group.name
output SERVICE_API_NAME string = resources.outputs.functionAppName
output AZURE_APP_PRINCIPAL_ID string = resources.outputs.appPrincipalId
output AZURE_SERVICE_BUS_NAMESPACE string = resources.outputs.serviceBusNamespace
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccount
output SCHEMA_MCP_SERVER_URL string = resources.outputs.schemaMcpEndpoint
output QUEUE_MCP_SERVER_URL string = resources.outputs.queueMcpEndpoint
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.foundryProjectEndpoint
output FOUNDRY_MODEL string = resources.outputs.foundryModelDeployment
output SERVICE_WEB_NAME string = resources.outputs.staticWebAppName
output DEMO_URL string = resources.outputs.demoUrl
