# predeploy.ps1 — Configure Docker Hub credentials on ACR for remote CI-style builds.
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$generator = Join-Path $root "scripts\generate-squad-runtime-bundle.mjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "[predeploy] Node.js is required to generate the hosted Squad runtime bundle."
}

Write-Host "[predeploy] Generating hosted Squad runtime bundle from authoritative sources..."
& node $generator --repo-root $root
if ($LASTEXITCODE -ne 0) {
    throw "[predeploy] Failed to generate hosted Squad runtime bundle."
}

# Resolve resource group
$rg = (azd env get-value AZURE_RESOURCE_GROUP 2>$null)
if (-not $rg) { $rg = "rg-$env:AZURE_ENV_NAME" }

# Resolve ACR name
$acrName = (azd env get-value AZURE_CONTAINER_REGISTRY_NAME 2>$null)
if (-not $acrName) {
    $acrName = az acr list -g $rg --query "[0].name" -o tsv 2>$null
}

$sandboxMode = (azd env get-value ACA_SANDBOX_MODE 2>$null)
if (-not $sandboxMode) { $sandboxMode = "sandbox" }

if ($sandboxMode.ToLowerInvariant() -eq "sandbox") {
    Write-Host "[predeploy] Sandbox mode enabled — ACA disk images are registered via the ACA build API."
    Write-Host "[predeploy] Run 'devclaw sandbox build' or the CI workflow to create the sandbox disk image."
}
if (-not $acrName) {
    Write-Host "[predeploy] No ACR found — skipping Docker Hub credential setup"
    exit 0
}

# Check for Docker Hub credentials in azd env
$dockerUser = (azd env get-value DOCKERHUB_USERNAME 2>$null)
$dockerToken = (azd env get-value DOCKERHUB_TOKEN 2>$null)

if ($dockerUser -and $dockerToken) {
    Write-Host "[predeploy] Docker Hub credentials found — configuring ACR credential set"

    # Create or update the Docker Hub credential set on ACR for authenticated pulls
    # This avoids the anonymous rate limit (100 pulls/6h) during ACR remote builds.
    $existingCred = az acr credential-set show -r $acrName -n dockerhub 2>$null
    if ($existingCred) {
        Write-Host "[predeploy] ACR credential set 'dockerhub' already exists"
    } else {
        # Store credentials as ACR task credentials for remote builds
        Write-Host "[predeploy] Adding Docker Hub credentials to ACR task defaults"
    }

    # Set credentials as environment for the remote build via ACR task
    # ACR Tasks support --set-secret for passing registry credentials
    az acr task credential add -r $acrName -n default --login-server docker.io `
        --username $dockerUser --password $dockerToken 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[predeploy] Docker Hub credentials configured on ACR"
    } else {
        Write-Host "[predeploy] WARNING: Failed to configure Docker Hub credentials on ACR"
        Write-Host "[predeploy]   Set DOCKERHUB_USERNAME/DOCKERHUB_TOKEN and retry."
    }
} else {
    Write-Host "[predeploy] No DOCKERHUB_USERNAME/DOCKERHUB_TOKEN in azd env — using anonymous pulls"
    Write-Host "[predeploy]   To avoid Docker Hub rate limits, set credentials:"
    Write-Host "[predeploy]     azd env set DOCKERHUB_USERNAME <username>"
    Write-Host "[predeploy]     azd env set DOCKERHUB_TOKEN <access-token>"

    Write-Host "[predeploy] CI-first sandbox flow uses remote ACR builds only (no local image-build fallback)."
}
