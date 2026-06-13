#!/bin/bash
# predeploy.sh — Configure Docker Hub credentials on ACR for remote CI-style builds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GENERATOR="$ROOT/scripts/generate-squad-runtime-bundle.mjs"

if ! command -v node >/dev/null 2>&1; then
    echo "[predeploy] Node.js is required to generate the hosted Squad runtime bundle." >&2
    exit 1
fi

echo "[predeploy] Generating hosted Squad runtime bundle from authoritative sources..."
node "$GENERATOR" --repo-root "$ROOT"

# Resolve resource group
RG=$(azd env get-value AZURE_RESOURCE_GROUP 2>/dev/null || echo "")
if [ -z "$RG" ]; then RG="rg-${AZURE_ENV_NAME:-}"; fi

# Resolve ACR name
ACR_NAME=$(azd env get-value AZURE_CONTAINER_REGISTRY_NAME 2>/dev/null || echo "")
if [ -z "$ACR_NAME" ]; then
    ACR_NAME=$(az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || echo "")
fi

SANDBOX_MODE=$(azd env get-value ACA_SANDBOX_MODE 2>/dev/null || echo "sandbox")

if [ "${SANDBOX_MODE,,}" = "sandbox" ]; then
    echo "[predeploy] Sandbox mode enabled — ACA disk images are registered via the ACA build API."
    echo "[predeploy] Run 'devclaw sandbox build' or the CI workflow to create the sandbox disk image."
fi
if [ -z "$ACR_NAME" ]; then
    echo "[predeploy] No ACR found — skipping Docker Hub credential setup"
    exit 0
fi

# Check for Docker Hub credentials in azd env
DOCKER_USER=$(azd env get-value DOCKERHUB_USERNAME 2>/dev/null || echo "")
DOCKER_TOKEN=$(azd env get-value DOCKERHUB_TOKEN 2>/dev/null || echo "")

if [ -n "$DOCKER_USER" ] && [ -n "$DOCKER_TOKEN" ]; then
    echo "[predeploy] Docker Hub credentials found — configuring ACR credential set"

    # Add Docker Hub credentials to ACR task defaults for authenticated pulls
    az acr task credential add -r "$ACR_NAME" -n default --login-server docker.io \
        --username "$DOCKER_USER" --password "$DOCKER_TOKEN" 2>/dev/null && \
        echo "[predeploy] Docker Hub credentials configured on ACR" || {
        echo "[predeploy] WARNING: Failed to configure Docker Hub credentials on ACR"
        echo "[predeploy]   Set DOCKERHUB_USERNAME/DOCKERHUB_TOKEN and retry."
    }
else
    echo "[predeploy] No DOCKERHUB_USERNAME/DOCKERHUB_TOKEN in azd env — using anonymous pulls"
    echo "[predeploy]   To avoid Docker Hub rate limits, set credentials:"
    echo "[predeploy]     azd env set DOCKERHUB_USERNAME <username>"
    echo "[predeploy]     azd env set DOCKERHUB_TOKEN <access-token>"

    echo "[predeploy] CI-first sandbox flow uses remote ACR builds only (no local image-build fallback)."
fi
