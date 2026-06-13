// OpenClaw on Azure — azd orchestration template
// Provisions a Microsoft Foundry Models / Azure OpenAI model (OpenAI-compatible API)
// plus a container host (currently Azure Container Apps; swappable in the future).
targetScope = 'resourceGroup'

@description('Environment name for tagging')
@minLength(1)
@maxLength(64)
param environmentName string

@description('Primary location for all resources')
@allowed([
  'australiaeast'
  'eastasia'
  'eastus'
  'eastus2'
  'japaneast'
  'koreacentral'
  'southindia'
  'swedencentral'
  'switzerlandnorth'
  'uksouth'
  'westcentralus'
])
@metadata({
  azd: {
    type: 'location'
  }
})
param location string

@description('Unique token for resource naming')
param resourceToken string = toLower(uniqueString(subscription().id, environmentName, location))

@description('Bot App Registration ID (created by preprovision hook)')
param botAppId string = ''

@description('Bot App Registration Secret (created by preprovision hook)')
@secure()
param botAppSecret string = ''

@description('Optional GitHub token bridge for the standard ACA runtime. Set GITHUB_TOKEN in your azd env when you want hosted gh / token-backed GitHub MCP access outside ACA Sandbox.')
@secure()
param githubToken string = ''

@description('Bot Tenant ID')
param botTenantId string = subscription().tenantId

@description('Easy Auth App Registration ID (created by preprovision hook)')
param easyAuthAppId string = ''

@description('Container image to deploy. azd populates from SERVICE_OPENCLAW_IMAGE_NAME after first deploy; empty on first provision (placeholder used).')
param containerImage string = ''

@description('Host mode selector: "sandbox" (default) for ACA Sandbox (requires custom disk image provisioning), or "standard" for legacy Azure Container Apps with optional Express mode cold-start. See SKILL.md for details.')
param acaSandboxMode string = 'sandbox'

@description('ACA Sandbox runtime disk label/name. Optional in phase 1/2 while disk wiring is preprovisioned externally.')
param sandboxDiskName string = ''

@description('ACA Sandbox disk snapshot resource ID. Optional in phase 1/2 while sandbox disk APIs remain preview.')
param sandboxDiskSnapshotId string = ''

@description('Opt into ACA Express mode (preview). Set USE_EXPRESS_ENV=true in your azd env. When ACA_SANDBOX_MODE=standard, Express mode enables fast cold-start on supported regions (e.g. East Asia, West Central US).')
param useExpressEnv string = 'false'

var normalizedSandboxMode = toLower(trim(acaSandboxMode))
var expressEnabled = normalizedSandboxMode == 'standard'
  ? toLower(useExpressEnv) == 'true'
  : false

@description('Set SKIP_STORAGE=true in your azd env to skip the storage account + Azure Files volume mount. Use on subscriptions where Azure Policy blocks `allowSharedKeyAccess: true` on storage accounts (ACA file mounts require shared keys today). Trade-off: gateway token + sessions do not persist across replica restarts.')
param skipStorage string = 'false'

var storageSkipped = toLower(skipStorage) == 'true'

@description('Region for the Azure OpenAI account. Defaults to `location`. Override (via AZURE_OPENAI_LOCATION) when the chosen `location` does not offer the target model SKU (e.g. ACA in `eastasia` with OpenAI in `eastus2`).')
param openaiLocation string = ''

@description('Logical squad name used for tags/state isolation and multi-squad fleet naming (set via SQUAD_NAME).')
param squadName string = 'core'

@description('Numeric squad instance identifier (set via SQUAD_INSTANCE). Use distinct values per squad deployment.')
param squadInstance string = '1'

@description('Minimum ACA replicas for the OpenClaw runtime (set via OPENCLAW_MIN_REPLICAS).')
param openclawMinReplicas string = '1'

@description('Maximum ACA replicas for the OpenClaw runtime (set via OPENCLAW_MAX_REPLICAS).')
param openclawMaxReplicas string = '3'

var effectiveOpenaiLocation = empty(openaiLocation) ? location : openaiLocation
var normalizedSquadName = toLower(replace(replace(replace(trim(squadName), '_', '-'), ' ', '-'), '.', '-'))
var effectiveSquadName = empty(normalizedSquadName) ? 'core' : normalizedSquadName
var effectiveSquadInstance = max(1, int(squadInstance))
var effectiveMinReplicas = max(0, int(openclawMinReplicas))
var effectiveMaxReplicas = max(effectiveMinReplicas, int(openclawMaxReplicas))

// ---------------------------------------------------------------------------
// 1. AI model — deployed to Azure OpenAI / Microsoft Foundry Models (OpenAI-compatible API)
//    Model name/version are parameterized; today this targets Azure OpenAI models,
//    with scope to add Claude and other Foundry Models in the near future.
// ---------------------------------------------------------------------------
module openai 'resources.bicep' = {
  name: 'openai'
  params: {
    location: effectiveOpenaiLocation
    resourceToken: resourceToken
    environmentName: environmentName
    deployAiModel: true
    aiModelName: 'gpt-5.4-mini'
    aiModelVersion: '2026-03-17'
    aiModelCapacity: 50
  }
}

// ---------------------------------------------------------------------------
// 2. Host — current implementation: Azure Container Apps with Azure Files.
//    Kept behind a generic `host` module reference so the underlying compute
//    can be swapped (AKS, App Service, etc.) without changing callers.
// ---------------------------------------------------------------------------
module host 'aca.bicep' = {
  name: 'host'
  params: {
    location: location
    resourceToken: resourceToken
    environmentName: environmentName
    openaiEndpoint: openai.outputs.AZURE_OPENAI_ENDPOINT
    openaiDeploymentName: openai.outputs.AZURE_AI_MODEL_DEPLOYMENT_NAME
    openaiResourceId: openai.outputs.AZURE_OPENAI_RESOURCE_ID
    botAppId: botAppId
    botAppSecret: botAppSecret
    githubToken: githubToken
    botTenantId: botTenantId
    easyAuthAppId: easyAuthAppId
    containerImage: containerImage
    acaSandboxMode: normalizedSandboxMode
    sandboxDiskName: sandboxDiskName
    sandboxDiskSnapshotId: sandboxDiskSnapshotId
    useExpressEnv: expressEnabled
    skipStorage: storageSkipped
    squadName: effectiveSquadName
    squadInstance: effectiveSquadInstance
    minReplicas: effectiveMinReplicas
    maxReplicas: effectiveMaxReplicas
  }
}

// ---------------------------------------------------------------------------
// Outputs (consumed by azd)
// ---------------------------------------------------------------------------
output AZURE_LOCATION string = location
output AZURE_OPENAI_ENDPOINT string = openai.outputs.AZURE_OPENAI_ENDPOINT
output AZURE_OPENAI_NAME string = openai.outputs.AZURE_OPENAI_NAME
output AZURE_AI_MODEL_DEPLOYMENT_NAME string = openai.outputs.AZURE_AI_MODEL_DEPLOYMENT_NAME
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = host.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT
output AZURE_CONTAINER_REGISTRY_NAME string = host.outputs.AZURE_CONTAINER_REGISTRY_NAME
output HOST_FQDN string = host.outputs.HOST_FQDN
output BOT_APP_ID string = host.outputs.BOT_APP_ID
output ACA_SANDBOX_MODE string = host.outputs.ACA_SANDBOX_MODE
output SANDBOX_DISK_NAME string = host.outputs.SANDBOX_DISK_NAME
output SANDBOX_DISK_SNAPSHOT_ID string = host.outputs.SANDBOX_DISK_SNAPSHOT_ID
output SQUAD_NAME string = effectiveSquadName
output SQUAD_INSTANCE int = effectiveSquadInstance
