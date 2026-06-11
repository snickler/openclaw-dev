@echo off
setlocal enabledelayedexpansion
REM devclaw.cmd - OpenClaw in the Microsoft Cloud (Windows)
REM Wraps the bash script for cmd/PowerShell use
set "AZURE_CONFIG_DIR=%~dp0.azure"
set "COMMAND=%1"
if "%COMMAND%"=="" set "COMMAND=status"

where azd >nul 2>&1
if errorlevel 1 (
    echo   Azure Developer CLI [azd] not found.
    echo   Install: https://aka.ms/azd-install
    exit /b 1
)
where az >nul 2>&1
if errorlevel 1 (
    echo   Azure CLI [az] not found.
    echo   Install: https://aka.ms/install-azure-cli
    exit /b 1
)

if "%COMMAND%"=="login" goto :login
if "%COMMAND%"=="up" goto :up
if "%COMMAND%"=="down" goto :down
if "%COMMAND%"=="start" goto :start
if "%COMMAND%"=="stop" goto :stop
if "%COMMAND%"=="restart" goto :restart
if "%COMMAND%"=="status" goto :status
if "%COMMAND%"=="logs" goto :logs
if "%COMMAND%"=="test" goto :test
if "%COMMAND%"=="deploy" goto :deploy
if "%COMMAND%"=="teams" goto :teams
if "%COMMAND%"=="sandbox" goto :sandbox
if "%COMMAND%"=="squad" goto :squad
goto :help

:login
echo.
echo   Logging into Azure...
call az login
call azd auth login 2>nul
echo   Logged in. Run 'devclaw up' to deploy.
echo.
exit /b 0

:up
echo.
echo   Deploying OpenClaw to Azure...
set "HOST_MODE="
for /f "tokens=*" %%i in ('call azd env get-value ACA_SANDBOX_MODE 2^>nul') do set "HOST_MODE=%%i"
if /i "%HOST_MODE%"=="sandbox" (
    echo   Sandbox mode detected ^(ACA_SANDBOX_MODE=sandbox^): running infrastructure provision only.
    call azd provision
) else (
    call azd up
)
if errorlevel 1 (
    REM Check if the error was a storage policy violation
    echo.
    echo   Deployment failed. Common fixes:
    echo.
    echo   - "RequestDisallowedByPolicy" on a storage account?
    echo     Your subscription blocks shared-key storage. Run:
    echo       azd env set SKIP_STORAGE true
    echo       devclaw up
    echo     Trade-off: chat sessions won't persist across restarts.
    echo.
    echo   - "InvalidTemplateDeployment" on OpenAI model?
    echo     Your region may not have the model SKU. Run:
    echo       azd env set AZURE_OPENAI_LOCATION eastus2
    echo       devclaw up
    echo.
    exit /b 1
)
echo.
if /i "%HOST_MODE%"=="sandbox" (
    echo   Sandbox infrastructure provisioned.
    echo   Next: run 'devclaw sandbox build' and 'devclaw sandbox upload' to create the ACA sandbox runtime.
) else (
    echo   OpenClaw deployed! Run 'devclaw test' to verify.
)
echo.
exit /b 0

:down
echo.
echo   This will permanently delete all OpenClaw Azure resources.
set /p CONFIRM="  Are you sure? [y/N]: "
if /i not "%CONFIRM%"=="y" (
    echo   Cancelled.
    exit /b 0
)
REM Clean up Entra app registrations before destroying Azure resources
REM NOTE: 'az' is az.cmd on Windows - must use CALL or outer batch exits
for /f "tokens=*" %%i in ('call azd env get-value BOT_APP_ID 2^>nul') do (
    echo   Deleting bot app registration: %%i
    call az ad app delete --id %%i 2>nul
)
for /f "tokens=*" %%i in ('call azd env get-value EASYAUTH_APP_ID 2^>nul') do (
    echo   Deleting Easy Auth app registration: %%i
    call az ad app delete --id %%i 2>nul
)
call azd down --force --purge
echo   All resources deleted.
echo.
exit /b 0

:start
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
echo.
echo   Starting OpenClaw...
call az containerapp update --name %APP% --resource-group %RG% --min-replicas 1 --max-replicas 1 --only-show-errors >nul
echo   OpenClaw started.
echo.
exit /b 0

:stop
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
echo.
echo   Stopping OpenClaw...
call az containerapp update --name %APP% --resource-group %RG% --min-replicas 0 --max-replicas 0 --only-show-errors >nul
echo   OpenClaw stopped. State preserved.
echo.
exit /b 0

:restart
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
for /f "tokens=*" %%a in ('az containerapp revision list --name %APP% --resource-group %RG% --query "[?properties.active].name" -o tsv 2^>nul') do set "REV=%%a"
echo.
echo   Restarting OpenClaw...
call az containerapp revision restart --name %APP% --resource-group %RG% --revision %REV% --only-show-errors >nul
echo   OpenClaw restarted.
echo.
exit /b 0

:status
set "RG="
set "APP="
set "STATUS="
set "FQDN="
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
if "%RG%"=="" (
    echo.
    echo   No deployment found. Run 'devclaw up' first.
    echo.
    exit /b 0
)
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
if "%APP%"=="" (
    echo.
    echo   No deployment found in resource group %RG%.
    echo   Run 'devclaw up' first.
    echo.
    exit /b 0
)
for /f "tokens=*" %%a in ('az containerapp revision list --name %APP% --resource-group %RG% --query "[?properties.active].properties.runningState" -o tsv 2^>nul') do set "STATUS=%%a"
for /f "tokens=*" %%a in ('az containerapp show --name %APP% --resource-group %RG% --query "properties.configuration.ingress.fqdn" -o tsv 2^>nul') do set "FQDN=%%a"
if "%STATUS%"=="" set "STATUS=Unknown"
echo.
echo   devclaw
echo   --------
echo   App:     %APP%
echo   Status:  %STATUS%
if "%FQDN%"=="" (
echo   URL:     (not available)
) else (
echo   URL:     https://%FQDN%
)
echo   RG:      %RG%
echo.
exit /b 0

:logs
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
echo.
echo   Streaming logs (Ctrl+C to stop)...
echo.
call az containerapp logs show --name %APP% --resource-group %RG% --follow --tail 50
exit /b 0

:test
set "RG="
set "APP="
set "STATUS="
for /f "tokens=*" %%a in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%a"
if "%RG%"=="" (
    echo.
    echo   Container: Not deployed - run 'devclaw up' first.
    echo.
    exit /b 0
)
for /f "tokens=*" %%a in ('az containerapp list --resource-group %RG% --query "[0].name" -o tsv 2^>nul') do set "APP=%%a"
if "%APP%"=="" (
    echo.
    echo   Container: Not deployed - run 'devclaw up' first.
    echo.
    exit /b 0
)
for /f "tokens=*" %%a in ('az containerapp revision list --name %APP% --resource-group %RG% --query "[?properties.active].properties.runningState" -o tsv 2^>nul') do set "STATUS=%%a"
echo.
if "%STATUS%"=="Running" (
    echo   Container: Running
) else if "%STATUS%"=="RunningAtMaxScale" (
    echo   Container: Running
) else if "%STATUS%"=="" (
    echo   Container: Unknown - no active revision reported
) else (
    echo   Container: %STATUS% - wait or check 'devclaw logs'
)
echo.
echo   To test, open Azure Portal ^> Container App ^> Console ^> /bin/bash
echo   Then run: openclaw agent --message "Hello from the cloud!"
echo.
exit /b 0

:deploy
echo.
echo   Rebuilding and deploying OpenClaw...
call azd deploy
echo   Deployed! Run 'devclaw test' to verify.
echo.
exit /b 0

:teams
echo.
echo   Microsoft Teams Setup (optional add-on)
echo   ---------------------------------------
echo.

REM Get bot name and FQDN from the deployment
for /f "tokens=*" %%i in ('azd env get-value HOST_FQDN 2^>nul') do set "FQDN=%%i"
for /f "tokens=*" %%i in ('azd env get-value BOT_APP_ID 2^>nul') do set "BOT_ID=%%i"
for /f "tokens=*" %%i in ('azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "RG=%%i"
for /f "tokens=*" %%i in ('azd env get-value ENABLE_TEAMS 2^>nul') do set "ENABLE_TEAMS_FLAG=%%i"

REM Fallback: derive RG from env name if AZURE_RESOURCE_GROUP not set
if "%RG%"=="" (
    for /f "tokens=*" %%i in ('azd env get-value AZURE_ENV_NAME 2^>nul') do set "ENV_NAME=%%i"
    if not "!ENV_NAME!"=="" set "RG=rg-!ENV_NAME!"
)

REM Teams is opt-in. If no bot exists yet, offer to enable + re-provision.
if "%BOT_ID%"=="" (
    echo   Teams is an optional add-on and isn't enabled for this deployment yet.
    echo   Enabling it will create an Entra ID app registration + Azure Bot
    echo   resource, then re-provision so the container app picks up the creds.
    echo.
    set /p TEAMS_CONFIRM="  Enable Teams now? [y/N]: "
    if /i not "!TEAMS_CONFIRM!"=="y" (
        echo   Cancelled.
        echo.
        exit /b 0
    )
    if /i not "%ENABLE_TEAMS_FLAG%"=="true" (
        call azd env set ENABLE_TEAMS true
        echo   ENABLE_TEAMS=true saved to azd env.
    )
    echo   Re-provisioning (creates bot app reg + Azure Bot + Teams channel)...
    echo.
    call azd provision
    for /f "tokens=*" %%i in ('azd env get-value BOT_APP_ID 2^>nul') do set "BOT_ID=%%i"
    if "!BOT_ID!"=="" (
        echo   Provisioning didn't create a bot app registration.
        echo   Check the preprovision hook output above for tenant policy errors.
        exit /b 1
    )
    echo.
    echo   Redeploying app so MSTEAMS_* env vars take effect...
    call azd deploy
    echo.
)

REM Find the bot resource name in the resource group
for /f "tokens=*" %%i in ('az resource list --resource-group %RG% --resource-type "Microsoft.BotService/botServices" --query "[0].name" -o tsv 2^>nul') do set "BOT_NAME=%%i"

if "%BOT_NAME%"=="" (
    echo   No Azure Bot found in %RG% even after provisioning.
    echo   Check 'azd provision' output for errors.
    exit /b 1
)

echo   Bot:      %BOT_NAME%
echo   Endpoint: https://%FQDN%/api/messages
echo.

REM Enable Teams channel via REST API (az bot msteams hangs in batch scripts)
echo   Enabling Teams channel...
for /f "tokens=*" %%i in ('az account show --query id -o tsv 2^>nul') do set "SUB_ID=%%i"
echo. | az rest --method PUT --url "https://management.azure.com/subscriptions/%SUB_ID%/resourceGroups/%RG%/providers/Microsoft.BotService/botServices/%BOT_NAME%/channels/MsTeamsChannel?api-version=2022-09-15" --body "{\"location\":\"global\",\"properties\":{\"channelName\":\"MsTeamsChannel\",\"properties\":{\"isEnabled\":true}}}" -o none 2>nul
echo   Teams channel ready.

REM Build Teams app package
echo   Building Teams app package...
if not exist "teams\package" mkdir "teams\package"
powershell -Command "(Get-Content teams\manifest.json) -replace 'APP_ID_PLACEHOLDER','%BOT_ID%' | Set-Content teams\package\manifest.json"

if not exist "teams\package\color.png" (
    echo   WARNING: teams\package\color.png missing - add a 192x192 PNG icon
)
if not exist "teams\package\outline.png" (
    echo   WARNING: teams\package\outline.png missing - add a 32x32 PNG icon
)

REM Create ZIP (use pwsh for reliable Compress-Archive support)
pushd "%~dp0"
pwsh -NoProfile -Command "Compress-Archive -LiteralPath 'teams/package/manifest.json','teams/package/color.png','teams/package/outline.png' -DestinationPath 'teams/openclaw-teams-app.zip' -Force" 2>nul
popd
echo   Package: teams\openclaw-teams-app.zip
echo.
echo   Install in Teams:
echo     Teams ^> Apps ^> Manage your apps ^> Upload a custom app
echo     Select: teams\openclaw-teams-app.zip
echo     Add ^> DM the bot to test
echo.
exit /b 0

:sandbox
set "SUBCOMMAND=%2"
if "%SUBCOMMAND%"=="" set "SUBCOMMAND=status"
set "SANDBOX_DIR=%~dp0_local\sandbox"
if /i "%SUBCOMMAND%"=="build" (
    if "%3" NEQ "" set "SANDBOX_DIR=%3"
) else if /i "%SUBCOMMAND%"=="status" (
    if "%3" NEQ "" set "SANDBOX_DIR=%3"
)
set "SANDBOX_METADATA=%SANDBOX_DIR%\disk-image-metadata.json"

if /i "%SUBCOMMAND%"=="init" goto :sandbox_init
if /i "%SUBCOMMAND%"=="build" goto :sandbox_build
if /i "%SUBCOMMAND%"=="upload" goto :sandbox_upload
if /i "%SUBCOMMAND%"=="delete" goto :sandbox_delete
if /i "%SUBCOMMAND%"=="status" goto :sandbox_status
goto :sandbox_help

:sandbox_init
set "SQUAD_NAME=%3"
if "%SQUAD_NAME%"=="" for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD_NAME=%%i"
if "%SQUAD_NAME%"=="" set "SQUAD_NAME=core"
set "SANDBOX_REGION=%4"
if "%SANDBOX_REGION%"=="" for /f "tokens=*" %%i in ('call azd env get-value AZURE_LOCATION 2^>nul') do set "SANDBOX_REGION=%%i"
if "%SANDBOX_REGION%"=="" set "SANDBOX_REGION=eastus2"
set "SANDBOX_OPENAI_REGION=%5"
if "%SANDBOX_OPENAI_REGION%"=="" set "SANDBOX_OPENAI_REGION=%SANDBOX_REGION%"

echo.
echo   Initializing Sandbox workspace...
if not exist "%SANDBOX_DIR%" mkdir "%SANDBOX_DIR%"
call azd env set SQUAD_NAME "%SQUAD_NAME%" >nul 2>&1
call azd env set ACA_SANDBOX_MODE sandbox >nul 2>&1
call azd env set AZURE_LOCATION "%SANDBOX_REGION%" >nul 2>&1
call azd env set AZURE_OPENAI_LOCATION "%SANDBOX_OPENAI_REGION%" >nul 2>&1
call azd env set SANDBOX_DIR "%SANDBOX_DIR%" >nul 2>&1
echo   Sandbox workspace ready at %SANDBOX_DIR%.
echo   Run 'devclaw sandbox build %SANDBOX_DIR%' to generate the disk artifact.
echo.
exit /b 0

:sandbox_build
set "SANDBOX_FORMAT=%4"
if "%SANDBOX_FORMAT%"=="" set "SANDBOX_FORMAT=vhdx"
for /f "tokens=*" %%i in ('call azd env get-value AZURE_LOCATION 2^>nul') do set "AZ_LOC=%%i"
if "%AZ_LOC%"=="" set "AZ_LOC=eastus2"
set "SANDBOX_REGION=%5"
if "%SANDBOX_REGION%"=="" set "SANDBOX_REGION=%AZ_LOC%"
for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD_NAME_FROM_ENV=%%i"
if "%SQUAD_NAME_FROM_ENV%"=="" set "SQUAD_NAME_FROM_ENV=core"
set "SANDBOX_SQUAD=%6"
if "%SANDBOX_SQUAD%"=="" set "SANDBOX_SQUAD=%SQUAD_NAME_FROM_ENV%"

echo.
echo   Building Sandbox disk artifact...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-disk-image.ps1" -OutputDir "%SANDBOX_DIR%" -DiskFormat "%SANDBOX_FORMAT%" -Region "%SANDBOX_REGION%" -Squad "%SANDBOX_SQUAD%"
if errorlevel 1 exit /b 1

if exist "%SANDBOX_METADATA%" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%SANDBOX_METADATA%' | ConvertFrom-Json).artifact_path"`) do set "DISK_PATH=%%i"
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%SANDBOX_METADATA%' | ConvertFrom-Json).hash_sha256"`) do set "DISK_HASH=%%i"
    if not "%DISK_PATH%"=="" call azd env set SANDBOX_DISK_IMAGE_PATH "%DISK_PATH%" >nul 2>&1
    if not "%DISK_HASH%"=="" call azd env set SANDBOX_DISK_IMAGE_HASH "%DISK_HASH%" >nul 2>&1
    echo   Sandbox metadata captured in azd env (SANDBOX_DISK_IMAGE_PATH/HASH).
)
echo.
exit /b 0

:sandbox_upload
set "SQUAD_NAME=%3"
if "%SQUAD_NAME%"=="" for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD_NAME=%%i"
if "%SQUAD_NAME%"=="" set "SQUAD_NAME=core"
set "SANDBOX_REGION=%4"
if "%SANDBOX_REGION%"=="" for /f "tokens=*" %%i in ('call azd env get-value AZURE_LOCATION 2^>nul') do set "SANDBOX_REGION=%%i"
if "%SANDBOX_REGION%"=="" set "SANDBOX_REGION=eastus2"
set "SANDBOX_DISK_PATH=%5"
set "SANDBOX_RG=%6"
if "%SANDBOX_RG%"=="" for /f "tokens=*" %%i in ('call azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "SANDBOX_RG=%%i"
if "%SANDBOX_RG%"=="" (
    for /f "tokens=*" %%i in ('call azd env get-value AZURE_ENV_NAME 2^>nul') do set "AZD_ENV_NAME=%%i"
    if "%AZD_ENV_NAME%"=="" set "AZD_ENV_NAME=%SQUAD_NAME%"
    set "SANDBOX_RG=rg-%AZD_ENV_NAME%"
)
set "SANDBOX_EMAIL=%7"
if "%SANDBOX_EMAIL%"=="" for /f "tokens=*" %%i in ('az account show --query user.name -o tsv 2^>nul') do set "SANDBOX_EMAIL=%%i"
set "SANDBOX_GROUP=sg-%SQUAD_NAME%"

if "%SANDBOX_DISK_PATH%"=="" if exist "%SANDBOX_METADATA%" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%SANDBOX_METADATA%' | ConvertFrom-Json).artifact_path"`) do set "SANDBOX_DISK_PATH=%%i"
)
if "%SANDBOX_DISK_PATH%"=="" (
    echo.
    echo   No sandbox disk artifact found.
    echo   Run 'devclaw sandbox build %SANDBOX_DIR%' first or pass a disk path.
    echo.
    exit /b 1
)
for %%i in ("%SANDBOX_DISK_PATH%") do set "SANDBOX_DISK_NAME=%%~nxi"

where aca >nul 2>&1
if errorlevel 1 (
    echo.
    echo   aca CLI not found.
    echo   Install it first, then run:
    echo     az group create --name "%SANDBOX_RG%" --location "%SANDBOX_REGION%"
    echo     aca sandboxgroup create -g "%SANDBOX_RG%" --name "%SANDBOX_GROUP%" --location "%SANDBOX_REGION%" --set-config
    echo     aca sandboxgroup identity assign --group "%SANDBOX_GROUP%" --system-assigned
    echo     aca sandbox create --group "%SANDBOX_GROUP%" --disk "%SANDBOX_DISK_NAME%" --label app=openclaw --label env=%SQUAD_NAME%
    if not "%SANDBOX_EMAIL%"=="" echo     aca sandbox port add --group "%SANDBOX_GROUP%" -l app=openclaw,env=%SQUAD_NAME% --port 18789 --email "%SANDBOX_EMAIL%"
    echo.
    exit /b 1
)

echo.
echo   Registering Sandbox artifact with ACA Sandbox...
call az group create --name "%SANDBOX_RG%" --location "%SANDBOX_REGION%" >nul
call aca sandboxgroup create -g "%SANDBOX_RG%" --name "%SANDBOX_GROUP%" --location "%SANDBOX_REGION%" --set-config
call aca sandboxgroup identity assign --group "%SANDBOX_GROUP%" --system-assigned
call aca sandbox create --group "%SANDBOX_GROUP%" --disk "%SANDBOX_DISK_NAME%" --label app=openclaw --label env=%SQUAD_NAME%
if not "%SANDBOX_EMAIL%"=="" call aca sandbox port add --group "%SANDBOX_GROUP%" -l app=openclaw,env=%SQUAD_NAME% --port 18789 --email "%SANDBOX_EMAIL%"
call aca sandbox get --group "%SANDBOX_GROUP%" -l app=openclaw,env=%SQUAD_NAME%
call azd env set SANDBOX_DISK_IMAGE_PATH "%SANDBOX_DISK_PATH%" >nul 2>&1
echo   Sandbox upload complete for %SQUAD_NAME%.
echo.
exit /b 0

:sandbox_delete
set "SQUAD_NAME=%3"
if "%SQUAD_NAME%"=="" for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD_NAME=%%i"
if "%SQUAD_NAME%"=="" set "SQUAD_NAME=core"
set "SANDBOX_RG=%4"
if "%SANDBOX_RG%"=="" for /f "tokens=*" %%i in ('call azd env get-value AZURE_RESOURCE_GROUP 2^>nul') do set "SANDBOX_RG=%%i"
if "%SANDBOX_RG%"=="" (
    for /f "tokens=*" %%i in ('call azd env get-value AZURE_ENV_NAME 2^>nul') do set "AZD_ENV_NAME=%%i"
    if "%AZD_ENV_NAME%"=="" set "AZD_ENV_NAME=%SQUAD_NAME%"
    set "SANDBOX_RG=rg-%AZD_ENV_NAME%"
)
set "SANDBOX_GROUP=sg-%SQUAD_NAME%"

where aca >nul 2>&1
if errorlevel 1 (
    echo.
    echo   aca CLI not found.
    echo   To delete the sandbox manually:
    echo     aca sandbox delete -l app=openclaw,env=%SQUAD_NAME% --yes
    echo     aca sandboxgroup delete -g "%SANDBOX_RG%" --name "%SANDBOX_GROUP%" --yes
    echo.
    exit /b 1
)

echo.
echo   Deleting Sandbox resources...
call aca sandbox delete -l app=openclaw,env=%SQUAD_NAME% --yes
call aca sandboxgroup delete -g "%SANDBOX_RG%" --name "%SANDBOX_GROUP%" --yes
echo   Sandbox deleted for %SQUAD_NAME%.
echo.
exit /b 0

:sandbox_status
echo.
where aca >nul 2>&1
if not errorlevel 1 (
    set "SQUAD_NAME=%3"
    if "%SQUAD_NAME%"=="" for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD_NAME=%%i"
    if "%SQUAD_NAME%"=="" set "SQUAD_NAME=core"
    set "SANDBOX_GROUP=sg-%SQUAD_NAME%"
    call aca sandbox get --group "%SANDBOX_GROUP%" -l app=openclaw,env=%SQUAD_NAME% 2>nul
    echo.
)
if not exist "%SANDBOX_METADATA%" (
    echo   No sandbox metadata found at:
    echo     %SANDBOX_METADATA%
    echo   Run: devclaw sandbox build
    echo.
    exit /b 0
)
type "%SANDBOX_METADATA%"
echo.
exit /b 0

:sandbox_help
echo.
echo   devclaw sandbox
echo.
echo   Subcommands:
echo     devclaw sandbox init ^<squad^> [region] [openai-region]   Create local Sandbox workspace
echo     devclaw sandbox build [dir] [format] [region] [squad]
echo     devclaw sandbox upload ^<squad^> [region] [disk-path] [rg] [email]
echo     devclaw sandbox delete ^<squad^> [region] [rg]
echo     devclaw sandbox status [dir]
echo.
exit /b 0

:squad
set "SUBCOMMAND=%2"
set "SQUAD_NAME=%3"
set "OPENAI_LOC=%4"

if "%SUBCOMMAND%"=="" goto :squad_help

if "%SUBCOMMAND%"=="init" goto :squad_init
if "%SUBCOMMAND%"=="use" goto :squad_use
if "%SUBCOMMAND%"=="select" goto :squad_use
if "%SUBCOMMAND%"=="list" goto :squad_list
if "%SUBCOMMAND%"=="current" goto :squad_current
if "%SUBCOMMAND%"=="status" goto :squad_status
if "%SUBCOMMAND%"=="up" goto :squad_op
if "%SUBCOMMAND%"=="deploy" goto :squad_op
if "%SUBCOMMAND%"=="start" goto :squad_op
if "%SUBCOMMAND%"=="stop" goto :squad_op
if "%SUBCOMMAND%"=="restart" goto :squad_op
if "%SUBCOMMAND%"=="logs" goto :squad_op
if "%SUBCOMMAND%"=="teams" goto :squad_op
if "%SUBCOMMAND%"=="down" goto :squad_op
goto :squad_help

:squad_init
if "%SQUAD_NAME%"=="" (
    echo.
    echo   Usage: devclaw squad init ^<name^> [location] [openai-location]
    echo   Example: devclaw squad init alpha eastus2 eastus2
    echo.
    exit /b 1
)
set "ENV_NAME=squad-%SQUAD_NAME%"
set "LOCATION=%3"
if "%LOCATION%"=="" set "LOCATION=eastus2"
if "%OPENAI_LOC%"=="" set "OPENAI_LOC=%LOCATION%"

echo.
echo   Creating squad environment: %ENV_NAME%
call azd env new "%ENV_NAME%"
call azd env select "%ENV_NAME%"
call azd env set SQUAD_NAME "%SQUAD_NAME%"
call azd env set SQUAD_INSTANCE 1
call azd env set AZURE_LOCATION "%LOCATION%"
call azd env set AZURE_OPENAI_LOCATION "%OPENAI_LOC%"
echo   Squad '%SQUAD_NAME%' created and selected.
echo   Run 'devclaw up' to deploy this squad.
echo.
exit /b 0

:squad_use
if "%SQUAD_NAME%"=="" (
    echo.
    echo   Usage: devclaw squad use ^<name^>
    echo   Example: devclaw squad use alpha
    echo.
    exit /b 1
)
set "ENV_NAME=%SQUAD_NAME%"
if not "%ENV_NAME:squad-=-%" == "%ENV_NAME%" goto :squad_use_env
set "ENV_NAME=squad-%SQUAD_NAME%"

:squad_use_env
echo.
echo   Switching to squad: %SQUAD_NAME%
call azd env select "%ENV_NAME%"
echo   Active environment: %ENV_NAME%
echo.
exit /b 0

:squad_list
echo.
echo   Available environments:
call azd env list
echo.
exit /b 0

:squad_current
echo.
for /f "tokens=*" %%i in ('call azd env get-value AZURE_ENV_NAME 2^>nul') do set "CURRENT_ENV=%%i"
if "%CURRENT_ENV%"=="" (
    echo   No active environment.
    echo.
    exit /b 0
)
echo   Active environment: %CURRENT_ENV%
for /f "tokens=*" %%i in ('call azd env get-value SQUAD_NAME 2^>nul') do set "SQUAD=%%i"
if not "%SQUAD%"=="" echo   Squad name: %SQUAD%
echo.
exit /b 0

:squad_status
if "%SQUAD_NAME%"=="" (
    echo   Usage: devclaw squad status ^<name^>
    echo.
    exit /b 1
)
set "ENV_NAME=%SQUAD_NAME%"
if not "%ENV_NAME:squad-=-%" == "%ENV_NAME%" goto :squad_status_env
set "ENV_NAME=squad-%SQUAD_NAME%"

:squad_status_env
echo.
echo   Status for squad: %SQUAD_NAME%
call azd status --environment "%ENV_NAME%" 2>nul
if errorlevel 1 echo   No deployment found for this squad.
echo.
exit /b 0

:squad_op
if "%SQUAD_NAME%"=="" (
    echo   Usage: devclaw squad %SUBCOMMAND% ^<name^>
    echo.
    exit /b 1
)
set "ENV_NAME=%SQUAD_NAME%"
if not "%ENV_NAME:squad-=-%" == "%ENV_NAME%" goto :squad_op_env
set "ENV_NAME=squad-%SQUAD_NAME%"

:squad_op_env
echo   Switching to squad: %SQUAD_NAME%
call azd env select "%ENV_NAME%"

if "%SUBCOMMAND%"=="up" (
    call :up
) else if "%SUBCOMMAND%"=="deploy" (
    call :deploy
) else if "%SUBCOMMAND%"=="start" (
    call :start
) else if "%SUBCOMMAND%"=="stop" (
    call :stop
) else if "%SUBCOMMAND%"=="restart" (
    call :restart
) else if "%SUBCOMMAND%"=="logs" (
    call :logs
) else if "%SUBCOMMAND%"=="teams" (
    call :teams
) else if "%SUBCOMMAND%"=="down" (
    call :down
)
exit /b 0

:squad_help
echo.
echo   devclaw squad - Multi-squad orchestration
echo.
echo   Subcommands:
echo     devclaw squad init ^<name^> [loc] [openai-loc]  Create and select squad
echo     devclaw squad use ^<name^>                      Switch to squad
echo     devclaw squad select ^<name^>                   Alias for use
echo     devclaw squad list                            List all squads
echo     devclaw squad current                         Show active squad
echo     devclaw squad status ^<name^>                  Show squad status
echo.
echo   Squad-scoped operations:
echo     devclaw squad up ^<name^>        Deploy squad
echo     devclaw squad deploy ^<name^>    Rebuild and deploy
echo     devclaw squad start ^<name^>     Start squad agent
echo     devclaw squad stop ^<name^>      Stop squad agent (state preserved)
echo     devclaw squad restart ^<name^>   Restart squad agent
echo     devclaw squad logs ^<name^>      Stream squad logs
echo     devclaw squad teams ^<name^>     Add Teams to squad
echo     devclaw squad down ^<name^>      Delete squad resources
echo.
exit /b 0

:help
echo.
echo   devclaw - OpenClaw in the Microsoft Cloud
echo.
echo   Getting started:
echo     devclaw up         Deploy OpenClaw to Azure
echo     devclaw test       Verify it's working
echo.
echo   Channels:
echo     devclaw teams      Add Microsoft Teams integration (optional add-on)
echo.
echo   Sandbox:
echo     devclaw sandbox    Build/show Sandbox disk artifact metadata
echo.
echo   Multi-squad:
echo     devclaw squad      Manage independent squads (run 'devclaw squad' for help)
echo.
echo   Control:
echo     devclaw start      Start the agent
echo     devclaw stop       Stop the agent (state preserved)
echo     devclaw restart    Restart the agent
echo     devclaw status     Check agent status
echo     devclaw logs       Stream live logs
echo     devclaw deploy     Rebuild and deploy after code changes
echo.
echo   Cleanup:
echo     devclaw down       Delete all Azure resources
echo.
echo   Account:
echo     devclaw login      Switch Azure account
echo.
exit /b 0
