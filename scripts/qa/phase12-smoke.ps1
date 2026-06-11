param(
    [ValidateSet('Static', 'Live', 'All')]
    [string]$Mode = 'All',
    [string]$ReportPath = '',
    [switch]$NoFileReport,
    [switch]$RunDeploy
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$devclawCmd = if ($IsWindows) { Join-Path $repoRoot 'devclaw.cmd' } else { Join-Path $repoRoot 'devclaw' }
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param(
        [string]$Scenario,
        [string]$Status,
        [string]$Check,
        [string]$Evidence,
        [string]$Diagnostics,
        [string]$Command = ''
    )
    $results.Add([pscustomobject]@{
            scenario    = $Scenario
            status      = $Status
            check       = $Check
            evidence    = $Evidence
            diagnostics = $Diagnostics
            command     = $Command
        })
}

function Assert-FileContains {
    param(
        [string]$Scenario,
        [string]$Check,
        [string]$Path,
        [string]$Pattern,
        [string]$Command = ''
    )
    $content = Get-Content -Path $Path -Raw
    if ($content -match $Pattern) {
        Add-Result -Scenario $Scenario -Status 'PASS' -Check $Check -Evidence "Matched pattern '$Pattern' in $Path" -Diagnostics '' -Command $Command
    } else {
        Add-Result -Scenario $Scenario -Status 'FAIL' -Check $Check -Evidence "Pattern '$Pattern' not found in $Path" -Diagnostics 'Expected fallback/regression marker is missing.' -Command $Command
    }
}

function Run-CliCommand {
    param(
        [string]$CommandLine
    )
    if ($IsWindows) {
        $raw = & $env:ComSpec /c $CommandLine 2>&1
    } else {
        $raw = & /bin/bash -lc $CommandLine 2>&1
    }
    return [pscustomobject]@{
        exitCode = $LASTEXITCODE
        output   = ($raw | Out-String).TrimEnd()
    }
}

function Get-NullRedirect {
    if ($IsWindows) { return '>nul' }
    return '>/dev/null'
}

if ($Mode -in @('Static', 'All')) {
    Assert-FileContains -Scenario 'S1' -Check 'Default host mode is sandbox' -Path (Join-Path $repoRoot 'infra\main.parameters.json') -Pattern '"acaSandboxMode"\s*:\s*\{\s*"value"\s*:\s*"\$\{ACA_SANDBOX_MODE=sandbox\}"' -Command 'Get-Content infra/main.parameters.json'
    Assert-FileContains -Scenario 'S2' -Check 'Standard fallback path documented' -Path (Join-Path $repoRoot 'README.md') -Pattern 'azd env set ACA_SANDBOX_MODE standard' -Command 'Select-String README.md ACA_SANDBOX_MODE'
    Assert-FileContains -Scenario 'S3' -Check 'Storage policy fallback documented' -Path (Join-Path $repoRoot 'README.md') -Pattern 'azd env set SKIP_STORAGE true' -Command 'Select-String README.md SKIP_STORAGE'
    Assert-FileContains -Scenario 'S4' -Check 'OpenAI region fallback hint present' -Path (Join-Path $repoRoot 'devclaw.cmd') -Pattern 'AZURE_OPENAI_LOCATION eastus2' -Command 'Select-String devclaw.cmd AZURE_OPENAI_LOCATION'
    Assert-FileContains -Scenario 'S5' -Check 'Teams remains opt-in' -Path (Join-Path $repoRoot 'infra\hooks\preprovision.ps1') -Pattern 'Teams integration not enabled — skipping bot app registration' -Command 'Select-String infra/hooks/preprovision.ps1 Teams integration'
    Assert-FileContains -Scenario 'S6' -Check 'Hook can recover from repo-local az auth' -Path (Join-Path $repoRoot 'infra\hooks\preprovision.ps1') -Pattern 'falling back to default config dir' -Command 'Select-String infra/hooks/preprovision.ps1 AZURE_CONFIG_DIR'
    Assert-FileContains -Scenario 'S7' -Check 'Post-deploy ingress/scale repair present' -Path (Join-Path $repoRoot 'infra\hooks\postdeploy.ps1') -Pattern 'Scaling container app from 0 to 1 replica|targetPort: \$currentPort -> 18789' -Command 'Select-String infra/hooks/postdeploy.ps1 "Scaling container app|targetPort"'

    $mainBuild = Run-CliCommand "az bicep build --file `"$((Join-Path $repoRoot 'infra\main.bicep'))`" --stdout $(Get-NullRedirect)"
    if ($mainBuild.exitCode -eq 0) {
        Add-Result -Scenario 'S8' -Status 'PASS' -Check 'main.bicep compiles' -Evidence 'az bicep build returned exit code 0' -Diagnostics '' -Command 'az bicep build --file infra/main.bicep --stdout'
    } else {
        Add-Result -Scenario 'S8' -Status 'FAIL' -Check 'main.bicep compiles' -Evidence $mainBuild.output -Diagnostics 'Bicep compile failed.' -Command 'az bicep build --file infra/main.bicep --stdout'
    }

    $acaBuild = Run-CliCommand "az bicep build --file `"$((Join-Path $repoRoot 'infra\aca.bicep'))`" --stdout $(Get-NullRedirect)"
    if ($acaBuild.exitCode -eq 0) {
        $warn = ($acaBuild.output -split "`r?`n" | Where-Object { $_ -match 'Warning BCP' })
        if ($warn.Count -gt 0) {
            Add-Result -Scenario 'S9' -Status 'WARN' -Check 'aca.bicep compiles cleanly' -Evidence ($warn -join '; ') -Diagnostics 'Compiles, but warnings should be triaged for stricter QA gates.' -Command 'az bicep build --file infra/aca.bicep --stdout'
        } else {
            Add-Result -Scenario 'S9' -Status 'PASS' -Check 'aca.bicep compiles cleanly' -Evidence 'No Bicep warnings emitted.' -Diagnostics '' -Command 'az bicep build --file infra/aca.bicep --stdout'
        }
    } else {
        Add-Result -Scenario 'S9' -Status 'FAIL' -Check 'aca.bicep compiles cleanly' -Evidence $acaBuild.output -Diagnostics 'Bicep compile failed.' -Command 'az bicep build --file infra/aca.bicep --stdout'
    }
}

if ($Mode -in @('Live', 'All')) {
    if ($RunDeploy) {
        $deployProbe = if ($IsWindows) { Run-CliCommand "`"$devclawCmd`" up" } else { Run-CliCommand "bash `"$devclawCmd`" up" }
        if ($deployProbe.exitCode -eq 0) {
            Add-Result -Scenario 'L0' -Status 'PASS' -Check 'Deploy command completed' -Evidence ($deployProbe.output -split "`r?`n" | Select-Object -First 12) -Diagnostics '' -Command 'devclaw.cmd up'
        } else {
            Add-Result -Scenario 'L0' -Status 'FAIL' -Check 'Deploy command completed' -Evidence ($deployProbe.output -split "`r?`n" | Select-Object -First 16) -Diagnostics 'Deploy failed. Check devclaw output and azd logs for root cause.' -Command 'devclaw.cmd up'
        }
    } else {
        Add-Result -Scenario 'L0' -Status 'BLOCKED' -Check 'Deploy command completed' -Evidence 'Skipped by default to avoid unintentional Azure provisioning/cost.' -Diagnostics 'Re-run with -RunDeploy after az login + azd auth login in target subscription.' -Command 'devclaw.cmd up'
    }

    $statusProbe = if ($IsWindows) { Run-CliCommand "`"$devclawCmd`" status" } else { Run-CliCommand "bash `"$devclawCmd`" status" }
    $statusApp = [regex]::Match($statusProbe.output, '(?m)^\s*App:\s*(.+?)\s*$').Groups[1].Value.Trim()
    $statusState = [regex]::Match($statusProbe.output, '(?m)^\s*Status:\s*(.+?)\s*$').Groups[1].Value.Trim()
    $statusUrl = [regex]::Match($statusProbe.output, '(?m)^\s*URL:\s*(.+?)\s*$').Groups[1].Value.Trim()
    if ($statusProbe.output -match 'No deployment found' -or (($statusApp) -and ($statusState) -and ($statusUrl -match '^https://.+'))) {
        Add-Result -Scenario 'L1' -Status 'PASS' -Check 'Status command returns actionable state' -Evidence ($statusProbe.output -split "`r?`n" | Select-Object -First 6) -Diagnostics '' -Command 'devclaw.cmd status'
    } else {
        Add-Result -Scenario 'L1' -Status 'FAIL' -Check 'Status command returns actionable state' -Evidence ($statusProbe.output -split "`r?`n" | Select-Object -First 8) -Diagnostics 'Status output is missing app/status/url values when no deployment exists.' -Command 'devclaw.cmd status'
    }

    $testProbe = if ($IsWindows) { Run-CliCommand "`"$devclawCmd`" test" } else { Run-CliCommand "bash `"$devclawCmd`" test" }
    $containerStatus = [regex]::Match($testProbe.output, '(?m)^\s*Container:\s*(.+?)\s*$').Groups[1].Value.Trim()
    if (($containerStatus) -and ($containerStatus -notmatch '^-')) {
        Add-Result -Scenario 'L2' -Status 'PASS' -Check 'Test command reports container state' -Evidence "Container line: $containerStatus" -Diagnostics '' -Command 'devclaw.cmd test'
    } else {
        Add-Result -Scenario 'L2' -Status 'FAIL' -Check 'Test command reports container state' -Evidence ($testProbe.output -split "`r?`n" | Select-Object -First 6) -Diagnostics 'Container state is blank/ambiguous; fallback diagnostics are not specific.' -Command 'devclaw.cmd test'
    }
}

$ordered = $results | Sort-Object scenario
$summary = $ordered | Group-Object status | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Count }
Write-Host ''
Write-Host "Phase 1-2 QA smoke summary ($Mode): $($summary -join ', ')"
Write-Host ''
$ordered | Format-Table -AutoSize scenario, status, check
Write-Host ''

if (-not $NoFileReport) {
    if (-not $ReportPath) {
        $ReportPath = Join-Path $PSScriptRoot 'phase12-smoke.last.json'
    }
    $ordered | ConvertTo-Json -Depth 6 | Set-Content -Path $ReportPath -Encoding UTF8
    Write-Host "Report written: $ReportPath"
}

$hasFail = $ordered.status -contains 'FAIL'
if ($hasFail) {
    exit 1
}

exit 0
