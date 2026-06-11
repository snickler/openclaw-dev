#!/bin/bash
# predeploy.sh — Configure Docker Hub credentials on ACR to avoid anonymous
# pull rate limits during remote builds. Falls back to local Docker if available.
set -euo pipefail

# Resolve resource group
RG=$(azd env get-value AZURE_RESOURCE_GROUP 2>/dev/null || echo "")
if [ -z "$RG" ]; then RG="rg-${AZURE_ENV_NAME:-}"; fi

# Resolve ACR name
ACR_NAME=$(azd env get-value AZURE_CONTAINER_REGISTRY_NAME 2>/dev/null || echo "")
if [ -z "$ACR_NAME" ]; then
    ACR_NAME=$(az acr list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || echo "")
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX_DIR="$ROOT_DIR/_local/sandbox"
SANDBOX_METADATA="$SANDBOX_DIR/disk-image-metadata.json"
SANDBOX_MODE=$(azd env get-value ACA_SANDBOX_MODE 2>/dev/null || echo "sandbox")
SANDBOX_AUTO_BUILD=$(azd env get-value SANDBOX_AUTO_BUILD 2>/dev/null || echo "true")
if [ -z "$SANDBOX_AUTO_BUILD" ]; then SANDBOX_AUTO_BUILD="true"; fi
SANDBOX_REGION=$(azd env get-value AZURE_LOCATION 2>/dev/null || echo "eastus2")
SANDBOX_SQUAD=$(azd env get-value SQUAD_NAME 2>/dev/null || echo "core")

verify_sandbox_metadata() {
    if [ ! -f "$SANDBOX_METADATA" ]; then
        return 1
    fi

    local disk_path
    local expected_hash
    disk_path=$(awk -F'"' '/"artifact_path"/ {print $4}' "$SANDBOX_METADATA")
    expected_hash=$(awk -F'"' '/"hash_sha256"/ {print $4}' "$SANDBOX_METADATA")

    if [ -z "$disk_path" ] || [ -z "$expected_hash" ] || [ ! -f "$disk_path" ]; then
        echo "[predeploy] Sandbox metadata missing artifact path/hash or artifact file."
        return 1
    fi

    local actual_hash
    actual_hash=$(sha256sum "$disk_path" | awk '{print $1}')
    if [ "$actual_hash" != "$expected_hash" ]; then
        echo "[predeploy] ERROR: Sandbox artifact hash mismatch."
        return 2
    fi

    local git_commit
    git_commit=$(awk -F'"' '/"git_commit"/ {print $4}' "$SANDBOX_METADATA")
    if [ -z "$git_commit" ]; then
        echo "[predeploy] Sandbox metadata missing git_commit."
        return 1
    fi

    azd env set SANDBOX_DISK_IMAGE_PATH "$disk_path" >/dev/null 2>&1 || true
    azd env set SANDBOX_DISK_IMAGE_HASH "$expected_hash" >/dev/null 2>&1 || true
    echo "[predeploy] Disk image validated (commit ${git_commit:0:8})"
    return 0
}

if [ "${SANDBOX_MODE,,}" = "sandbox" ]; then
    if ! verify_sandbox_metadata; then
        if [ "${SANDBOX_AUTO_BUILD,,}" = "true" ]; then
            echo "[predeploy] SANDBOX_AUTO_BUILD=true and metadata missing/invalid — building now."
            bash "$ROOT_DIR/scripts/build-disk-image.sh" "$SANDBOX_DIR" qcow2 "$SANDBOX_REGION" "$SANDBOX_SQUAD"
            verify_sandbox_metadata || {
                echo "[predeploy] ERROR: Auto-build completed but sandbox metadata is still invalid."
                exit 1
            }
        else
            echo "[predeploy] Sandbox mode enabled but no verified local disk metadata found."
            echo "[predeploy] Auto-build is disabled. To re-enable:"
            echo "[predeploy]   azd env set SANDBOX_AUTO_BUILD true"
        fi
    fi
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
        echo "[predeploy]   If you hit rate limits, ensure Docker Desktop is running for local fallback"
    }
else
    echo "[predeploy] No DOCKERHUB_USERNAME/DOCKERHUB_TOKEN in azd env — using anonymous pulls"
    echo "[predeploy]   To avoid Docker Hub rate limits, set credentials:"
    echo "[predeploy]     azd env set DOCKERHUB_USERNAME <username>"
    echo "[predeploy]     azd env set DOCKERHUB_TOKEN <access-token>"

    # Check if local Docker is available as fallback
    if docker info >/dev/null 2>&1; then
        echo "[predeploy] Local Docker detected — will fall back to local build if remote hits rate limit"
    else
        echo "[predeploy] WARNING: Local Docker not running. If ACR remote build hits Docker Hub rate limit,"
        echo "[predeploy]   start Docker Desktop and retry, or set DOCKERHUB_USERNAME/DOCKERHUB_TOKEN."
    fi
fi
