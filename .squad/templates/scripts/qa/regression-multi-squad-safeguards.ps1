param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
)

$ErrorActionPreference = "Stop"

function Assert-Pattern {
    param(
        [string]$Content,
        [string]$Pattern,
        [string]$Message
    )

    if ($Content -notmatch $Pattern) {
        throw $Message
    }
}

function Assert-Contains {
    param(
        [string]$Content,
        [string]$Literal,
        [string]$Message
    )

    if (-not $Content.Contains($Literal)) {
        throw $Message
    }
}

$devclawPath = Join-Path $RepoRoot "devclaw"
$devclawCmdPath = Join-Path $RepoRoot "devclaw.cmd"
$syncMeshPath = Join-Path $RepoRoot ".squad\templates\skills\distributed-mesh\sync-mesh.sh"

$devclaw = Get-Content $devclawPath -Raw
$devclawCmd = Get-Content $devclawCmdPath -Raw
$syncMesh = Get-Content $syncMeshPath -Raw

$checks = @()

Assert-Contains $devclaw 'previous_env="$(azd env get-value AZURE_ENV_NAME' "devclaw: missing previous_env capture in run_core_command_for_squad"
$checks += "devclaw captures previous azd environment"

Assert-Contains $devclaw 'DEVCLAW_INTERNAL_SQUAD_CONTEXT=1 "$0" "$core_command"' "devclaw: missing internal scoped command execution"
$checks += "devclaw executes scoped command through internal entrypoint"

Assert-Contains $devclaw 'azd env select "$previous_env" >/dev/null 2>&1 || true' "devclaw: missing environment restore logic"
$checks += "devclaw restores previous azd environment"

Assert-Pattern $devclaw 'up\|deploy\|status\|logs\|start\|stop\|restart\|teams\|down\)' "devclaw: explicit squad-scoped command list missing"
$checks += "devclaw routes explicit squad-scoped commands through squad wrapper"

Assert-Contains $devclawCmd "for /f ""tokens=*"" %%i in ('call azd env get-value AZURE_ENV_NAME" "devclaw.cmd: missing previous environment capture"
$checks += "devclaw.cmd captures previous azd environment"

Assert-Contains $devclawCmd 'if not "%PREV_ENV%"=="" if /i not "%PREV_ENV%"=="%SELECTED_ENV%" call azd env select "%PREV_ENV%" >nul 2>&1' "devclaw.cmd: missing environment restore logic"
$checks += "devclaw.cmd restores previous azd environment"

Assert-Pattern $syncMesh '(?ms)is_safe_http_url\(\).*?http://\*\|https://\*' "sync-mesh.sh: missing URL scheme validation helper"
$checks += "sync-mesh.sh enforces http/https source URL validation"

Assert-Pattern $syncMesh '(?ms)is_confined_target_path\(\).*?\.\./' "sync-mesh.sh: missing confined path validation helper"
$checks += "sync-mesh.sh enforces confined relative sync_to paths"

Assert-Contains $syncMesh 'if ! is_safe_http_url "$source"; then' "sync-mesh.sh: missing URL guard before curl"
$checks += "sync-mesh.sh blocks invalid URL sources before fetch"

Assert-Contains $syncMesh 'if ! is_confined_target_path "$target"; then' "sync-mesh.sh: missing sync_to path guard before fetch"
$checks += "sync-mesh.sh blocks unsafe target paths before fetch"

Assert-Contains $syncMesh 'auth_flag=(--header "Authorization: Bearer ${!token_var}")' "sync-mesh.sh: missing safe bearer header argv construction"
$checks += "sync-mesh.sh builds bearer header via argv array"

Assert-Contains $syncMesh 'curl --silent --fail "${auth_flag[@]}" "$source" -o "$target/SUMMARY.md"' "sync-mesh.sh: missing safe curl invocation shape"
$checks += "sync-mesh.sh executes curl without eval-based interpolation"

if ($syncMesh -match '(?m)^\s*eval\s+') {
    throw "sync-mesh.sh: unexpected eval usage"
}
$checks += "sync-mesh.sh contains no eval usage"

Write-Host "PASS: multi-squad regression safeguards"
foreach ($check in $checks) {
    Write-Host " - $check"
}
