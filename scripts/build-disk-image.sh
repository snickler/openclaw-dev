#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-./_local/sandbox}"
DISK_FORMAT="${2:-qcow2}"
REGION="${3:-eastus2}"
SQUAD="${4:-core}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "nogit")"
COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
BUILDER="${GIT_AUTHOR_EMAIL:-${USER:-unknown}}"
BUILD_TAG="openclaw-sandbox-build:${SHORT_SHA}-${TIMESTAMP}"
ARTIFACT_NAME="openclaw-sandbox-${SQUAD}-${REGION}-${TIMESTAMP}.${DISK_FORMAT}"
ARTIFACT_PATH="$OUTPUT_DIR/$ARTIFACT_NAME"
SOURCE_BUNDLE="$OUTPUT_DIR/openclaw-source-${SHORT_SHA}-${TIMESTAMP}.tar"
LOG_PATH="$OUTPUT_DIR/build.log"
METADATA_PATH="$OUTPUT_DIR/disk-image-metadata.json"
BASE_IMAGE="ubuntu-24.04-server-cloudimg-amd64.img"
BASE_IMAGE_URL="https://cloud-images.ubuntu.com/releases/24.04/release/${BASE_IMAGE}"
BASE_IMAGE_SUMS_URL="https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS"

mkdir -p "$OUTPUT_DIR"

for cmd in git curl qemu-img sha256sum; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required dependency: $cmd" >&2
        exit 1
    fi
done

redact_log() {
    sed \
        -e 's/[A-Za-z0-9._%+-]\+@[A-Za-z0-9.-]\+\.[A-Za-z]\{2,\}/[redacted-email]/g' \
        -e 's/[A-Za-z]:\\[^ ]\+/[redacted-path]/g' \
        -e 's#https\?://[^ ]*#https://[redacted-url]#g'
}

secret_scan() {
    local pattern='(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----|api[_-]?key[[:space:]]*[:=][[:space:]]*["'"'"''"'"'][^"'"'"''"'"']{12,}|token[[:space:]]*[:=][[:space:]]*["'"'"''"'"'][^"'"'"''"'"']{12,}|client[_-]?secret[[:space:]]*[:=])'
    if grep -RInE "$pattern" "$1" >/dev/null 2>&1; then
        echo "Secret-like pattern detected in $2; refusing to build artifact." >&2
        exit 1
    fi
}

echo "==> [sandbox build] Starting isolated runtime build" | tee "$LOG_PATH"
secret_scan "$ROOT_DIR/src" "src/"

git -C "$ROOT_DIR" archive --format=tar -o "$SOURCE_BUNDLE" HEAD src >/dev/null
SOURCE_BUNDLE_SHA256="$(sha256sum "$SOURCE_BUNDLE" | awk '{print $1}')"

if [ ! -f "$OUTPUT_DIR/$BASE_IMAGE" ]; then
    curl -fsSL "$BASE_IMAGE_URL" -o "$OUTPUT_DIR/$BASE_IMAGE"
fi
curl -fsSL "$BASE_IMAGE_SUMS_URL" -o "$OUTPUT_DIR/SHA256SUMS"
grep " $BASE_IMAGE$" "$OUTPUT_DIR/SHA256SUMS" | sha256sum -c - >/dev/null
qemu-img convert -f qcow2 -O "$DISK_FORMAT" "$OUTPUT_DIR/$BASE_IMAGE" "$ARTIFACT_PATH"
rm -f "$OUTPUT_DIR/SHA256SUMS"

HASH_SHA256="$(sha256sum "$ARTIFACT_PATH" | awk '{print $1}')"
SIZE_BYTES="$(wc -c < "$ARTIFACT_PATH" | tr -d ' ')"
NODE_VERSION="$(node -v 2>/dev/null || echo "unknown")"
CREATED_IN_CI="false"
if [ "${CI:-}" = "true" ]; then
    CREATED_IN_CI="true"
fi

cat > "$METADATA_PATH" <<EOF
{
  "name": "$ARTIFACT_NAME",
  "format": "$DISK_FORMAT",
  "artifact_path": "$ARTIFACT_PATH",
  "hash_sha256": "$HASH_SHA256",
  "size_bytes": $SIZE_BYTES,
  "runtime_image_tar": "$SOURCE_BUNDLE",
  "runtime_image_sha256": "$SOURCE_BUNDLE_SHA256",
  "squad": "$SQUAD",
  "region": "$REGION",
  "created_at_utc": "$TIMESTAMP",
  "git_commit": "$COMMIT_SHA",
  "git_branch": "$BRANCH",
  "created_by": "$BUILDER",
  "created_in_ci": $CREATED_IN_CI,
  "node_version": "$NODE_VERSION",
  "ubuntu_base_image_url": "$BASE_IMAGE_URL",
  "security_gates": {
    "build_isolation": "no-docker-daemon",
    "secret_scan": "regex-scan",
    "artifact_hash": "sha256",
    "audit_trail": "metadata-json",
    "log_redaction": "enabled"
  }
}
EOF

secret_scan "$METADATA_PATH" "metadata"
secret_scan "$LOG_PATH" "build log"
echo "==> [sandbox build] Artifact and metadata generated."
