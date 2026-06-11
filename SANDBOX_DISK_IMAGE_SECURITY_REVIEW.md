# Security Review: Sandbox Disk Image Build Strategy (Option B)

**Reviewer:** Parker, Security Officer  
**Date:** 2026-06-11  
**Target:** Phase 1 implementation of automated disk image builder (`build-disk-image.sh` / `.ps1`)  
**Status:** DESIGN PHASE → READY FOR PHASE 1 with MANDATORY mitigations

---

## Executive Summary

**Disk image security verdict: YELLOW** (Ready with mandatory caveats & hardening gates)

Option B (automated disk image builder) is operationally superior to Option A but introduces **supply-chain and artifact integrity risks** that MUST be mitigated before Phase 1 ships. The Dockerfile is already partially hardened (digest-pinned base image), but the build-disk-image orchestration script **does not yet exist** and must be designed with security as a first-class requirement.

### Immediate Blockers (Must fix before Phase 1 PR):
1. **Base image digest must be pinned** in build-disk-image script ✅ (Dockerfile already does this)
2. **npm package pinning** via `package-lock.json` generated from `npm ci` (not present today)
3. **Build isolation verification** — build MUST run in isolated container, not on host
4. **Artifact signing strategy** — QCOW2/VHD images must be signed or attested
5. **Build log redaction** — Output must be scanned for secrets before artifact storage

### Recommended (Phase 1+ gates):
6. **Secrets in disk** — Verify zero hardcoded secrets in final image (automated scan)
7. **Build audit trail** — Log who built what image, when, from which commit (with approval gate for Phase 2)

---

## Detailed Security Analysis

### 1. Supply Chain for Build Inputs

#### npm Packages

**Current State:**
- Dockerfile uses `npm install -g openclaw@${OPENCLAW_VERSION}` (exact version pinned by ARG)
- Additional npm packages installed: `@microsoft/teams.api@2.0.6`, `@slack/bolt@4.6.0`, etc. (versions pinned)
- **Missing:** No `package-lock.json` in repo; no `npm ci` (clean install from lockfile)
- **Risk:** npm registry cache poisoning; if a minor dep's version resolves differently on rebuild, image diverges

**Evidence:**
```dockerfile
# src/Dockerfile, lines 18 & 23-26
npm install -g openclaw@${OPENCLAW_VERSION}  # Version pinned via ARG (good)
npm install --omit=dev --no-save --package-lock=false \
  @microsoft/teams.api@2.0.6 @microsoft/teams.apps@2.0.6 \
  ...  # Individual versions pinned (good), but --package-lock=false is risky
```

**Severity:** MEDIUM-HIGH  
**Mitigation Required:**
- Generate `package-lock.json` from clean npm install in Dockerfile build
- Use `npm ci --prefer-offline` in build-disk-image script (reproducible installs)
- Verify npm registry integrity: require `npm audit` to pass (zero high/critical)
- Consider npm registry mirror (e.g., Artifactory) for air-gapped builds in future phases

**Recommendation for Phase 1:**
- Keep version pinning (already in place)
- Generate and commit `package-lock.json` to repo
- Update Dockerfile: `npm ci --prefer-offline` (if lockfile present)
- Document npm registry as single point of failure (Phase 2: offline mirror)

---

#### System Packages

**Current State:**
- Dockerfile: `apt-get update && apt-get install -y --no-install-recommends git ca-certificates`
- **Missing:** No GPG verification of package signatures (apt-get does this by default, but no explicit attestation)
- **Risk:** APT repo compromise; malicious package injection

**Evidence:**
```dockerfile
# src/Dockerfile, lines 13-14
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates && \
```

**Severity:** LOW-MEDIUM (APT defaults to GPG verification, but no explicit check in script)  
**Mitigation Required:**
- Explicit `apt-key verify` step (or rely on Ubuntu GPG setup — already in place)
- Document: "Base image (Ubuntu 24.04 LTS) includes GPG keyring; apt-get validates package signatures"
- Future: Consider offline APT snapshot (Phase 3)

**Recommendation for Phase 1:**
- Keep existing apt-get setup (safe by default in Ubuntu 24.04 LTS)
- Document APT trust model in build script comments
- Add APT caching directory cleanup (shrink final disk image)

---

#### Dockerfile Base Image

**Current State:**
- `FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf`
- **Digest-pinned:** Excellent! Prevents accidental base layer mutation

**Evidence:**
```dockerfile
# src/Dockerfile, line 1
FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf
```

**Severity:** NONE (already hardened)  
**Mitigation:** None required.

**Recommendation for Phase 1:**
- Maintain digest pinning in Dockerfile
- Audit process: Before each quarterly security patch, verify digest against `docker inspect` output
- Document: When to update Node version (e.g., LTS security releases)

---

### 2. Build Isolation

#### Host vs. Container Build

**Current State:**
- `build-disk-image.sh` / `.ps1` **does not yet exist** (Phase 1 deliverable)
- Pseudocode in SANDBOX_RUNTIME_STRATEGY.md suggests QEMU-based build (running disk in QEMU VM)
- **Risk:** If build runs on host without isolation, malicious Dockerfile could modify host filesystem

**Design Recommendation from Strategy:**
```bash
# From SANDBOX_RUNTIME_STRATEGY.md (pseudocode)
qemu-system-x86_64 \
  -m 4G -drive file="$WORK_DIR/base.img" \
  ...  # Boot disk in isolated QEMU VM
```

**Severity:** CRITICAL if not isolated; LOW if containerized  
**Mitigation Required:**
- **MANDATORY:** Build orchestration must run inside a **container** (Docker/Podman), NOT on host
- Container build Dockerfile: Alpine base + qemu-img + build tools, nothing else
- Mount disk output to host via volume (read-only filesystem for safety)
- OR: Run QEMU-based disk build inside a container (nested virtualization or qemu-img format conversion)

**Recommendation for Phase 1:**
- Implement `build-disk-image.sh` to run **inside a container**
- Container must have NO access to host Docker socket or sensitive volumes
- Document: "Builds are sandboxed; host environment cannot be modified by build script"

---

### 3. Artifact Integrity

#### Disk Image Signing & Verification

**Current State:**
- No disk image signing strategy yet (Phase 1 deliverable)
- **Risk:** User cannot verify they're booting the expected image; attacker could substitute tampered disk

**Severity:** CRITICAL  
**Mitigation Required:**
- **Sign disk image** using one of:
  - **Option A (Simple, Phase 1):** SHA256 hash in metadata JSON (user verifies before boot)
  - **Option B (Robust, Phase 2):** Cosign signatures (SLSA framework compatible)
  - **Option C (Future, Phase 3):** AWS Nitro attestation / TPM attestation
  
- **Verify before use:** Predeploy hook must validate hash before registering snapshot

**Recommendation for Phase 1:**
- **Minimum:** Generate SHA256 hash of disk image, store in `disk-image-metadata.json`
- Predeploy hook verifies: `sha256sum -c disk-image-metadata.json.sha256`
- Document: "Disk integrity is validated before deployment"
- Phase 2: Add Cosign signing + verification for supply-chain authenticity

---

### 4. Secrets in Disk

#### Hardcoded Secrets Risk

**Current State:**
- **No hardcoded API keys, passwords, or certificates in Dockerfile**
- All secrets (Azure OpenAI keys, Teams credentials) are injected at **runtime via environment variables**
- Auth uses **Managed Identity** (no API keys needed — tokens injected by @azure/identity proxy)

**Evidence:**
```dockerfile
# src/Dockerfile, lines 54-55
COPY openclaw.json /root/.openclaw/openclaw.json
# This is a TEMPLATE with variable placeholders, not hardcoded secrets
```

**Severity:** NONE (already hardened correctly)

**Recommendation for Phase 1:**
- Document: "Disk image is secret-free; all credentials injected at runtime"
- Automated scan: Before finalizing disk image, grep for hardcoded secrets (regex: API keys, tokens, certs)
- Phase 2: Add automated secret-scanner tool (e.g., truffleHog, gitGuardian) to predeploy hook

---

### 5. Build Logs & Debugging

#### Log Redaction

**Current State:**
- Build scripts (if implemented) will output package URLs, versions, build commands
- **Risk:** Build logs stored in CI/CD artifacts may leak intelligence about build environment

**Severity:** MEDIUM  
**Mitigation Required:**
- Build script must NOT output full npm/apt package URLs
- CI/CD pipeline must redact logs before artifact storage
- Sensitive patterns: registry URLs, commit hashes (if private repo), dependency file lists

**Recommendation for Phase 1:**
- Build script output must be cleaned (suppress registry URLs, dependency details)
- Predeploy hook logs must redact disk metadata before CI output
- Document log redaction requirements

---

### 6. Rollback & Versioning

#### Image Versioning & Audit

**Current State:**
- No versioning strategy yet (Phase 1 deliverable)
- **Risk:** Accidental rollout of compromised image; no audit trail of who built what

**Severity:** MEDIUM-HIGH  
**Mitigation Required:**
- **Tag disk images by git commit hash** (immutable reference)
- **Metadata must include:** git commit, timestamp, builder email, build environment
- **Phase 2:** Require approval before snapshot promotion to production

**Recommendation for Phase 1:**
- Disk metadata includes immutable reference (git commit, builder, timestamp)
- Disk name includes timestamp (sortable) + commit hash (traceable)
- Predeploy hook logs commit hash + builder + timestamp
- Phase 2: Add approval gate for snapshot promotion

---

### 7. Blockers for Phase 1

#### Mandatory Security Gates

| Gate | Status | Mitigation | Blocker? |
|------|--------|-----------|----------|
| **Base image digest pinned** | DONE | None — already hardened | NO |
| **npm package lockfile** | MISSING | Generate + commit package-lock.json | YES |
| **Build isolation** | NOT SPECIFIED | Implement containerized build | YES |
| **Artifact signing** | MISSING | Add SHA256 hash to metadata.json | YES |
| **Build log redaction** | NOT SPECIFIED | Add log filtering to build script | YES |
| **Secrets scan** | NOT SPECIFIED | Add grep check for hardcoded secrets | YES |
| **Audit trail in metadata** | MISSING | Include git commit + builder email | YES |

#### Must-Have for Phase 1 PR:

1. **Generate `package-lock.json`**
2. **Implement containerized build-disk-image.sh**
3. **Add SHA256 hashing & verification**
4. **Add secret scanning**
5. **Add audit trail to metadata**
6. **Add log redaction**

---

## Security Checklist for Phase 1

- [ ] Supply Chain — npm: lockfile + npm ci
- [ ] Supply Chain — System Packages: APT documentation + cache cleanup
- [ ] Supply Chain — Base Image: verify digest maintained
- [ ] Build Isolation: containerized build-disk-image.sh
- [ ] Artifact Integrity: SHA256 hash verification
- [ ] Secrets in Disk: zero hardcoded secrets + grep scanner
- [ ] Build Logs: suppress registry URLs, redact metadata
- [ ] Rollback & Versioning: git commit + builder email in metadata

---

## Recommendations by Phase

### Phase 1 (MVP — 1–2 weeks)

**Must do:**
1. Generate `package-lock.json`; update Dockerfile to use `npm ci`
2. Implement containerized `build-disk-image.sh` (Docker-based)
3. Add SHA256 hashing + verification
4. Add secret-scanning grep check
5. Add audit trail to metadata.json (git commit, builder, timestamp)
6. Add log redaction to build script

**Defer to Phase 2:**
- Automated CI/CD pipeline for disk builds
- `devclaw sandbox` subcommand integration
- Approval workflow (`devclaw sandbox approve`)
- Cosign signing + verification

**Defer to Phase 3:**
- Offline APT mirror
- npm registry mirror
- Snapshot registry caching
- Advanced attestation (AWS Nitro, TPM)

---

### Phase 2 (Integration — 2–4 weeks)

**Add:**
1. Integrate disk build into predeploy hook (auto-build on `devclaw up`)
2. Add `devclaw sandbox build/status` CLI commands
3. Implement Cosign signing + verification
4. Add approval gate for snapshot promotion
5. CI/CD automation: rebuild disk on every commit to main branch

---

### Phase 3 (Multi-squad Ready — 4–8 weeks)

**Add:**
1. Offline APT + npm mirrors (air-gapped builds)
2. Snapshot registry (Azure Compute Gallery)
3. Disk cleanup job (delete snapshots >30 days old)
4. Cost tracking + quota warnings
5. Advanced monitoring (build success rate, size trends)

---

## Risk Summary Table

| Risk Category | Severity | Current State | Mitigation | Phase |
|--------------|----------|---------------|-----------|-------|
| npm supply chain | MEDIUM-HIGH | No lockfile | Generate + commit package-lock.json | 1 |
| APT supply chain | LOW-MEDIUM | Default GPG | Document trust model | 1 |
| Base image | LOW | Digest-pinned | Maintain digest | 1 |
| Build isolation | CRITICAL | Not specified | Containerize build | 1 |
| Artifact signing | CRITICAL | Not specified | SHA256 hash + metadata | 1 |
| Secrets in disk | NONE | Secret-free | Add scan check | 1 |
| Build logs | MEDIUM | Not specified | Redact URLs/paths | 1 |
| Versioning | MEDIUM-HIGH | Not specified | Git commit + builder in metadata | 1 |
| Approval workflow | LOW | N/A | Implement approval gate | 2 |
| Supply chain auth | LOW | N/A | Cosign signing | 2 |
| Air-gapped builds | LOW | N/A | Offline mirrors | 3 |

---

## Conclusion

**Disk image security verdict: YELLOW** — Ready for Phase 1 with mandatory mitigations

The Option B (automated disk image builder) strategy is sound and more secure than Option A if Phase 1 implementation includes these mandatory gates:

1. npm lockfile (prevents supply-chain divergence)
2. Containerized build (prevents host compromise)
3. Artifact signing (SHA256 hash verification)
4. Secret scanning (prevents credential leakage)
5. Build audit trail (enables rollback & accountability)
6. Log redaction (prevents intelligence leakage)

**No BLOCKERS exist that make Option B unsuitable.** All risks can be mitigated with reasonable design choices.

**Phase 1 is approved to proceed** contingent on the mandatory 7-gate checklist.

---

**Security review completed by Parker, Security Officer**  
**Date: 2026-06-11**  
**Approval: CONDITIONAL — See mandatory gates above**
