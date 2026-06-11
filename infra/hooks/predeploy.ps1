# predeploy.ps1 — Configure Docker Hub credentials on ACR to avoid anonymous
# pull rate limits during remote builds. Falls back to local Docker if available.
$ErrorActionPreference = "Stop"

# Resolve resource group
$rg = (azd env get-value AZURE_RESOURCE_GROUP 2>$null)
if (-not $rg) { $rg = "rg-$env:AZURE_ENV_NAME" }

# Resolve ACR name
$acrName = (azd env get-value AZURE_CONTAINER_REGISTRY_NAME 2>$null)
if (-not $acrName) {
    $acrName = az acr list -g $rg --query "[0].name" -o tsv 2>$null
}

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$sandboxDir = Join-Path $rootDir "_local\sandbox"
$sandboxMetadata = Join-Path $sandboxDir "disk-image-metadata.json"
$sandboxMode = (azd env get-value ACA_SANDBOX_MODE 2>$null)
if (-not $sandboxMode) { $sandboxMode = "sandbox" }
$sandboxAutoBuild = (azd env get-value SANDBOX_AUTO_BUILD 2>$null)
if (-not $sandboxAutoBuild) { $sandboxAutoBuild = "true" }
$sandboxRegion = (azd env get-value AZURE_LOCATION 2>$null)
if (-not $sandboxRegion) { $sandboxRegion = "eastus2" }
$sandboxSquad = (azd env get-value SQUAD_NAME 2>$null)
if (-not $sandboxSquad) { $sandboxSquad = "core" }

function Test-SandboxMetadata {
    if (-not (Test-Path $sandboxMetadata)) {
        return $false
    }

    try {
        $metadata = Get-Content $sandboxMetadata -Raw | ConvertFrom-Json
    } catch {
        Write-Host "[predeploy] Sandbox metadata file is not valid JSON."
        return $false
    }

    if (-not $metadata.artifact_path -or -not $metadata.hash_sha256 -or -not (Test-Path $metadata.artifact_path)) {
        Write-Host "[predeploy] Sandbox metadata missing artifact_path/hash_sha256 or artifact file."
        return $false
    }

    $actualHash = (Get-FileHash -Path $metadata.artifact_path -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = "$($metadata.hash_sha256)".ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        Write-Host "[predeploy] ERROR: Sandbox artifact hash mismatch."
        return $false
    }

    if (-not $metadata.git_commit) {
        Write-Host "[predeploy] Sandbox metadata missing git_commit."
        return $false
    }

    azd env set SANDBOX_DISK_IMAGE_PATH $metadata.artifact_path *> $null
    azd env set SANDBOX_DISK_IMAGE_HASH $expectedHash *> $null
    Write-Host "[predeploy] Disk image validated (commit $($metadata.git_commit.Substring(0, [Math]::Min(8, $metadata.git_commit.Length))))"
    return $true
}

if ($sandboxMode.ToLowerInvariant() -eq "sandbox") {
    $verified = Test-SandboxMetadata
    if (-not $verified) {
        if ($sandboxAutoBuild.ToLowerInvariant() -eq "true") {
            Write-Host "[predeploy] SANDBOX_AUTO_BUILD=true and metadata missing/invalid — building now."
            & (Join-Path $rootDir "scripts\build-disk-image.ps1") -OutputDir $sandboxDir -DiskFormat "vhdx" -Region $sandboxRegion -Squad $sandboxSquad
            if (-not (Test-SandboxMetadata)) {
                Write-Host "[predeploy] ERROR: Auto-build completed but sandbox metadata is still invalid."
                exit 1
            }
        } else {
            Write-Host "[predeploy] Sandbox mode enabled but no verified local disk metadata found."
            Write-Host "[predeploy] Auto-build is disabled. To re-enable:"
            Write-Host "[predeploy]   azd env set SANDBOX_AUTO_BUILD true"
        }
    }
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
        Write-Host "[predeploy]   If you hit rate limits, ensure Docker Desktop is running for local fallback"
    }
} else {
    Write-Host "[predeploy] No DOCKERHUB_USERNAME/DOCKERHUB_TOKEN in azd env — using anonymous pulls"
    Write-Host "[predeploy]   To avoid Docker Hub rate limits, set credentials:"
    Write-Host "[predeploy]     azd env set DOCKERHUB_USERNAME <username>"
    Write-Host "[predeploy]     azd env set DOCKERHUB_TOKEN <access-token>"

    # Check if local Docker is available as fallback
    $dockerRunning = $false
    try {
        $null = docker info 2>$null
        if ($LASTEXITCODE -eq 0) { $dockerRunning = $true }
    } catch {}

    if ($dockerRunning) {
        Write-Host "[predeploy] Local Docker detected — will fall back to local build if remote hits rate limit"
    } else {
        Write-Host "[predeploy] WARNING: Local Docker not running. If ACR remote build hits Docker Hub rate limit,"
        Write-Host "[predeploy]   start Docker Desktop and retry, or set DOCKERHUB_USERNAME/DOCKERHUB_TOKEN."
    }
}
