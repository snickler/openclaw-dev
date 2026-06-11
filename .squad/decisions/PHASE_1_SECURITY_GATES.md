# Phase 1 Security Gate Implementation Checklist

## MANDATORY Gates for Phase 1 PR

### Gate 1: npm Package Pinning (Blocking)
- [ ] Current: npm packages have versions pinned in ARG/install commands
- [ ] **Missing:** No `package-lock.json` in repo
- [ ] **Action Required:**
  ```bash
  cd src
  npm init -y
  npm install --save openclaw@2026.5.26
  npm ci --prefer-offline  # Verify clean install
  # Commit package-lock.json
  ```
- [ ] **Dockerfile Update:**
  - Replace: `npm install --no-save --package-lock=false`
  - With: `npm ci --prefer-offline`
- [ ] **Verification:** `npm audit` must pass (zero high/critical vulns)
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 2: Build Isolation (Blocking)
- [ ] **Requirement:** build-disk-image.sh must run inside Docker container
- [ ] **Implementation:**
  1. Create `scripts/Dockerfile.build-env`:
     ```dockerfile
     FROM alpine:latest
     RUN apk add --no-cache qemu-img curl bash
     COPY scripts/build-disk-image.sh /build/
     WORKDIR /build
     ```
  2. Create `scripts/build-disk-image.sh`:
     - Runs INSIDE container (no host access)
     - Downloads Ubuntu minimal image (with digest verification)
     - Mounts output via volume: `docker run -v $PWD/_local:/output ...`
  3. Host script wrapper: `scripts/build.sh` (orchestrates Docker invocation)
- [ ] **Security Properties:**
  - Build process cannot modify host filesystem
  - No access to host Docker socket
  - Output disk is read-only mountable
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 3: Artifact Signing & Verification (Blocking)
- [ ] **Phase 1 (Minimum):** SHA256 hash verification
  - [ ] Build script generates: `sha256sum <disk-image> > disk-image-metadata.json`
  - [ ] Metadata includes: `"hash_sha256": "abc123..."`
  - [ ] Predeploy hook verifies before deployment:
    ```powershell
    $actualHash = (Get-FileHash $diskPath -Algorithm SHA256).Hash.ToLower()
    $expectedHash = $metadata.hash_sha256.ToLower()
    if ($actualHash -ne $expectedHash) { exit 1 }
    ```
- [ ] **Phase 2+ (Future):** Cosign signatures + SLSA provenance
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 4: Secret Scanning (Blocking)
- [ ] **Implementation:** Add to build-disk-image.sh:
  ```bash
  # Scan final disk for hardcoded secrets
  if grep -rE "(api[_-]?key|password|secret|token|private[-]?key)" "$DISK_IMAGE" 2>/dev/null; then
      echo "❌ Hardcoded secrets detected in disk image! Aborting."
      exit 1
  fi
  ```
- [ ] **Patterns to detect:**
  - API keys: `api_key`, `apikey`, `api-key`
  - Passwords: `password`, `passwd`
  - Tokens: `token`, `auth_token`
  - Certificates: `BEGIN PRIVATE KEY`, `BEGIN RSA KEY`
- [ ] **Verification:** Run scan on built disk, ensure zero matches
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 5: Build Audit Trail (Blocking)
- [ ] **Metadata.json must include:**
  ```json
  {
    "name": "openclaw-sandbox-core-eastus2-1718043635.qcow2",
    "format": "qcow2",
    "size_gb": "4.2",
    "hash_sha256": "abc123...",
    "git_commit": "def456...",
    "git_branch": "main",
    "created_by": "$(git config user.email)",
    "created_at": "2026-06-11T02:47:15Z",
    "created_in_ci": false,
    "node_version": "24.0.0",
    "ubuntu_base_digest": "sha256:xyz789..."
  }
  ```
- [ ] **Verification:** Predeploy hook logs immutable reference:
  ```powershell
  Write-Host "Disk: $($metadata.git_commit) @ $(metadata.created_at)"
  # Do NOT log disk path, hash, or other metadata
  ```
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 6: Log Redaction (Blocking)
- [ ] **Build script output redaction:**
  - [ ] Suppress registry URLs
  - [ ] Suppress full file paths
  - [ ] Suppress dependency details
  - Example: ❌ `Installing @slack/bolt@4.6.0 from npm registry`
  - Example: ✅ `Installing npm dependencies...`
- [ ] **Predeploy hook output redaction:**
  - [ ] Suppress disk path, hash, metadata details
  - [ ] Log only: `Disk image validated (commit abc123)`
- **Priority:** ⚠️ CRITICAL — Blocks Phase 1 PR

---

### Gate 7: Base Image & APT Documentation (Blocking)
- [ ] **Document APT trust model** in build-disk-image.sh comments:
  ```bash
  # Ubuntu 24.04 LTS base image includes GPG keyring.
  # apt-get automatically verifies package signatures via GPG.
  # No explicit GPG verification needed (inherited from base).
  ```
- [ ] **Verify Node digest** is maintained:
  ```bash
  FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf
  ```
- [ ] **Document when to update digest:**
  - Quarterly security patches
  - Process: `docker pull node:24-slim`, get digest, update Dockerfile
- **Priority:** ✅ DONE (mostly; just document)

---

## Testing Checklist for Phase 1

- [ ] **Local build test (Linux/macOS):**
  ```bash
  ./scripts/build-disk-image.sh ./_local/sandbox qcow2
  # Verify: disk-image-metadata.json generated
  # Verify: SHA256 hash matches disk
  # Verify: git commit + builder email in metadata
  ```

- [ ] **Host isolation test:**
  ```bash
  # Confirm build ran inside Docker (not on host)
  docker ps --filter ancestor=qemu-build:latest
  # Should see container exited successfully
  ```

- [ ] **Secret scan test:**
  ```bash
  # Add fake secret to disk, re-run build, verify rejection
  echo "api_key=fake123" >> /disk/fake-secret
  ./scripts/build-disk-image.sh  # Should fail
  ```

- [ ] **Hash verification test:**
  ```bash
  # Modify disk image (add a byte), re-verify
  echo "x" >> ./_local/sandbox/disk.qcow2
  # Predeploy hook should reject (hash mismatch)
  ```

- [ ] **Metadata completeness test:**
  ```bash
  # Verify all required fields present
  jq '.git_commit, .created_by, .hash_sha256' disk-image-metadata.json
  # Should output: three non-empty strings
  ```

- [ ] **Boot test (QEMU):**
  ```bash
  qemu-system-x86_64 -drive file=disk.qcow2 -m 2G
  # Verify Ubuntu boots, Node.js is installed, auth-proxy is present
  ```

---

## Files to Create/Modify

### Create:
- [ ] `scripts/build-disk-image.sh` — Main build script (Linux/macOS)
- [ ] `scripts/build-disk-image.ps1` — PowerShell equivalent (Windows)
- [ ] `scripts/Dockerfile.build-env` — Build container definition
- [ ] `scripts/build.sh` — Host wrapper (orchestrates Docker)

### Modify:
- [ ] `src/Dockerfile` — Replace `npm install --no-save --package-lock=false` with `npm ci --prefer-offline`
- [ ] `infra/hooks/predeploy.ps1` — Add hash verification before deployment
- [ ] `infra/hooks/predeploy.sh` — Add hash verification before deployment
- [ ] `SKILL.md` — Update documentation with Option B as default, versioning strategy

### Generate:
- [ ] `src/package-lock.json` — Commit to repo (reproducible npm installs)

---

## Phase 1 Acceptance Criteria

- [ ] All 7 mandatory gates implemented and tested
- [ ] `build-disk-image.sh` runs isolated in Docker container
- [ ] Disk image is signed (SHA256) and verified before deployment
- [ ] No hardcoded secrets detected in disk image
- [ ] Build audit trail (git commit, builder, timestamp) in metadata
- [ ] Build logs redacted (no registry URLs, paths, or metadata)
- [ ] Integration test: local build → verify → deploy succeeds
- [ ] Documentation updated (SKILL.md, security model, versioning)
- [ ] Security review (this document) marked YELLOW with 7-gate checklist completed

---

## Decision Gate: Phase 1 → Phase 2 Promotion

**Criteria for Phase 2 approval:**
- Phase 1 in production (2+ weeks, zero security incidents)
- Disk builds succeed 100% (no failures or rollbacks)
- All 7 gates enforced + monitored
- Feedback from users + operations team

**Phase 2 scope (don't block Phase 1):**
- Cosign signing + SLSA provenance
- Automated CI/CD disk builds (every commit to main)
- `devclaw sandbox` CLI integration
- Approval workflow (`devclaw sandbox approve`)
- Snapshot registry (Azure Compute Gallery)

---

**Checklist Owner:** Parker (Security Officer)  
**Last Updated:** 2026-06-11  
**Status:** READY FOR PHASE 1 IMPLEMENTATION
