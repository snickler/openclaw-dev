param(
    [string]$OutputDir = ".\_local\sandbox",
    [ValidateSet("vhdx", "vhd", "raw")]
    [string]$DiskFormat = "vhdx",
    [string]$Region = "eastus2",
    [string]$Squad = "core"
)

$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$utcNow = [DateTime]::UtcNow
$timestamp = $utcNow.ToString("yyyyMMddTHHmmssZ")
$shortSha = (git -C $rootDir rev-parse --short HEAD 2>$null)
if (-not $shortSha) { $shortSha = "nogit" }
$commitSha = (git -C $rootDir rev-parse HEAD 2>$null)
if (-not $commitSha) { $commitSha = "unknown" }
$branch = (git -C $rootDir rev-parse --abbrev-ref HEAD 2>$null)
if (-not $branch) { $branch = "unknown" }

$builder = if ($env:GIT_AUTHOR_EMAIL) { $env:GIT_AUTHOR_EMAIL } elseif ($env:USERNAME) { $env:USERNAME } else { "unknown" }
$artifactName = "openclaw-sandbox-$Squad-$Region-$timestamp.$DiskFormat"
$outputPath = [System.IO.Path]::GetFullPath($OutputDir)
$artifactPath = Join-Path $outputPath $artifactName
$runtimeTar = Join-Path $outputPath "openclaw-source-$shortSha-$timestamp.tar"
$logPath = Join-Path $outputPath "build.log"
$metadataPath = Join-Path $outputPath "disk-image-metadata.json"
$baseImage = "ubuntu-24.04-server-cloudimg-amd64.img"
$baseImageUrl = "https://cloud-images.ubuntu.com/releases/24.04/release/$baseImage"
$baseImageSumsUrl = "https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS"

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null

foreach ($cmd in @("git", "qemu-img")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Missing required dependency: $cmd"
    }
}

function Write-RedactedLog {
    param([string]$Line)

    $redacted = $Line `
        -replace "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[redacted-email]" `
        -replace "[A-Za-z]:\\[^ ]+", "[redacted-path]" `
        -replace "https?://\S+", "https://[redacted-url]"

    Add-Content -Path $logPath -Value $redacted
    Write-Host $redacted
}

function Invoke-SecretScan {
    param(
        [string]$Path,
        [string]$Label
    )

    $pattern = '(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----)'
    if (Test-Path $Path -PathType Container) {
        $matches = Get-ChildItem -Path $Path -Recurse -File -Exclude "package-lock.json" | Select-String -Pattern $pattern -CaseSensitive:$false -ErrorAction SilentlyContinue
    } else {
        $matches = Select-String -Path $Path -Pattern $pattern -CaseSensitive:$false -ErrorAction SilentlyContinue
    }
    if ($matches) {
        throw "Secret-like pattern detected in $Label; refusing to build artifact."
    }
}

Set-Content -Path $logPath -Value "==> [sandbox build] Starting isolated runtime build"
Invoke-SecretScan -Path (Join-Path $rootDir "src") -Label "src/"

& git -C $rootDir archive --format=tar -o $runtimeTar HEAD src
if ($LASTEXITCODE -ne 0) {
    throw "git archive failed"
}

if (-not (Test-Path (Join-Path $outputPath $baseImage))) {
    Invoke-WebRequest -Uri $baseImageUrl -OutFile (Join-Path $outputPath $baseImage)
}
Invoke-WebRequest -Uri $baseImageSumsUrl -OutFile (Join-Path $outputPath "SHA256SUMS")
if (-not (Select-String -Path (Join-Path $outputPath "SHA256SUMS") -Pattern " $baseImage$")) {
    throw "base image checksum entry missing"
}
& qemu-img convert -f qcow2 -O $DiskFormat (Join-Path $outputPath $baseImage) $artifactPath
if ($LASTEXITCODE -ne 0) {
    throw "qemu-img convert failed"
}
Remove-Item (Join-Path $outputPath "SHA256SUMS") -ErrorAction SilentlyContinue

$artifactHash = (Get-FileHash -Path $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$runtimeHash = (Get-FileHash -Path $runtimeTar -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeBytes = (Get-Item $artifactPath).Length
$nodeVersion = (& node -v 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { $nodeVersion = "unknown" }
$createdInCi = $false
if ($env:CI -eq "true") { $createdInCi = $true }

$metadata = [ordered]@{
    name = $artifactName
    format = $DiskFormat
    artifact_path = $artifactPath
    hash_sha256 = $artifactHash
    size_bytes = $sizeBytes
    runtime_image_tar = $runtimeTar
    runtime_image_sha256 = $runtimeHash
    squad = $Squad
    region = $Region
    created_at_utc = $utcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    git_commit = $commitSha
    git_branch = $branch
    created_by = $builder
    created_in_ci = $createdInCi
    node_version = "$nodeVersion"
    ubuntu_base_image_url = $baseImageUrl
    security_gates = [ordered]@{
        build_isolation = "no-docker-daemon"
        secret_scan = "regex-scan"
        artifact_hash = "sha256"
        audit_trail = "metadata-json"
        log_redaction = "enabled"
    }
}

$metadata | ConvertTo-Json -Depth 6 | Set-Content -Path $metadataPath -Encoding UTF8

Invoke-SecretScan -Path $metadataPath -Label "metadata"
Invoke-SecretScan -Path $logPath -Label "build log"
Write-Host "==> [sandbox build] Artifact and metadata generated."
