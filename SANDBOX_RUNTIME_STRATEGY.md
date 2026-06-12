# Sandbox Runtime Integration Strategy — Design Analysis & Recommendation

**Date:** 2026-06-11  
**Architect:** Ripley, Lead Architect  
**Status:** DESIGN PHASE (Ready for Implementation)

---

## Executive Summary

Based on feasibility analysis and operational impact assessment, **Option B (Automated Disk Image Builder)** is **RECOMMENDED** for immediate implementation with a phased rollout:

- **Phase 1 (MVP, 1–2 weeks):** Implement `build-disk-image.sh` + basic Bicep integration
- **Phase 2 (near future):** Integrate into `devclaw` CLI and CI/CD
- **Phase 3 (multi-squad ready):** Cache & registry automation for squad scaling

This strategy balances **automation benefits** (one-command deployment, reproducibility) against **implementation complexity** (disk build overhead) and provides a clear upgrade path from current Option A.

---

## Option Evaluation

### Option A: Pre-baked Disk Image (User-provided)

**Current state:** OpenClaw defaults to `ACA_SANDBOX_MODE=sandbox` but expects users to manually provision disk images. SKILL.md documents the required `aca sandboxgroup` commands.

**Pros:**
- ✅ **Minimal impl. overhead** (~4–6 hours for docs + scripts)
- ✅ **Isolation-first:** Sandbox enforces process/network isolation by design
- ✅ **Simple mental model:** "Provide your disk; we boot it"
- ✅ **Fast user onboarding for those with disk tooling** (e.g., infrastructure teams)

**Cons:**
- ❌ **High user friction:** Requires external disk image build (qcow2, vhdx, or raw)
- ❌ **No reproducibility:** Each user builds independently → different runtime images
- ❌ **Scaling pain:** Multi-squad deployments require N separate disks
- ❌ **Version drift:** Updates to auth-proxy, Node.js, or OpenClaw require manual disk rebuilds
- ❌ **Support burden:** Every deployment failure may trace back to disk provisioning issues outside `devclaw` control
- ❌ **Barrier to adoption:** Most users lack disk image tooling (vmdk, qcow2, vhdx builders)

**Feasibility: LOW–MEDIUM** (4–6 hours docs + manual user effort = friction)

**Recommendation: Fallback only.** Use as a documented escape hatch for advanced users, not as the default deployment path.

---

### Option B: ACA-Managed Disk Image Builder

**Concept:** Use the ACA Sandbox build API to upload a `src/` content package and build the disk image from `src/Dockerfile` inside ACA:

1. Package `src/` as a tar.gz content package
2. Upload the content package to the ACA content-package API
3. POST the Dockerfile content + content-package ID to the sandbox-group disk build API
4. Poll until the disk image reports `Ready`
5. Persist the ACA disk image ID/name for sandbox creation and audit

**Pros:**
- ✅ **Reproducibility:** Same script, same region, same image
- ✅ **Automation-first:** Single command (`devclaw sandbox build`) or CI workflow
- ✅ **Version control:** Dockerfile + content package inputs live in repo; versions map to git tags/commits
- ✅ **Scaling:** CI can pre-build images for each squad/region definition
- ✅ **Squad-friendly:** No local disk tooling required
- ✅ **Low operational burden:** No manual snapshot creation; script → ACA build API
- ✅ **Clear upgrade path:** Update auth-proxy in Dockerfile → rebuild in ACA → re-deploy

**Cons:**
- ❌ **Implementation complexity:** Medium (content package upload, ACA build polling, CI hookup)
- ❌ **Build overhead:** First build may take several minutes in ACA
- ❌ **Disk storage:** ACA disk images consume storage; need cleanup strategy (e.g., old images → delete after 30 days)
- ⚠️ **Tool dependencies:** Requires Azure CLI login + ACA build API access

**Feasibility: MEDIUM** (10–20 hours: build script ~6–8h, Bicep integration ~4–6h, testing ~2–4h, CI/CD hookup ~2–4h)

**Timeline:**
- **Phase 1 (MVP):** `devclaw sandbox build` calls ACA build API
- **Phase 2:** Integration into `devclaw up` (register disk image before sandbox create)
- **Phase 3:** CI/CD automation + caching

**Recommendation: PRIMARY STRATEGY.**

---

### Option C: Post-boot Bootstrap via `aca sandbox exec`

**Concept:** Boot a minimal OS sandbox (Ubuntu 24.04 LTS, 500 MB), then use `aca sandbox exec` to:

1. `apt-get update && apt-get install nodejs npm git ca-certificates`
2. Install auth-proxy dependencies
3. Copy auth-proxy.mjs + gateway-proxy.mjs into running sandbox
4. Start OpenClaw

**Pros:**
- ✅ **No disk image management:** Boot minimal OS, install at runtime
- ✅ **Existing Dockerfile reuse:** Could adapt multi-stage Dockerfile to extract install steps
- ✅ **Low operational burden:** Users don't manage snapshots; ACA Sandbox handles it

**Cons:**
- ❌ **High latency:** Boot (10–30s) + install (3–5 min) + start (30s) = **5–6 min total, every boot**
- ❌ **Network brittle:** Depends on reliable `apt-get` mirrors; install failures → unhealthy sandbox
- ❌ **State inconsistency:** Different install runs may pull different package versions (breaking reproducibility)
- ❌ **Poor cold-start experience:** Users expect <30s startup; 5–6 min is unacceptable for mobile/web
- ❌ **No pre-caching:** Every sandbox boot re-downloads npm packages (GB of traffic per boot)
- ❌ **Hard to debug:** Failures happen mid-boot in running sandbox; logs hidden from user
- ❌ **Compliance risk:** Post-boot install may fail mid-way, leaving sandbox in inconsistent state
- ❌ **Not production-ready:** Violates "immutable-image-at-boot" principle for infrastructure

**Feasibility: MEDIUM-HIGH impl., but OPERATIONALLY UNSUITABLE** (6–8h code, but 5–6 min boot time disqualifies it)

**Recommendation: REJECTED.** Cold-start penalty is unacceptable; production systems require immutable disk state at boot time.

---

## Detailed Comparison

| Aspect | Option A | Option B | Option C |
|--------|----------|----------|----------|
| **User friction** | High (manual disk build) | Low (one command) | Low (auto) |
| **Reproducibility** | ❌ None (manual) | ✅ High (script-driven) | ⚠️ Medium (net deps vary) |
| **Cold start** | ✅ ~5–10s | ✅ ~5–10s | ❌ ~5–6 min |
| **Impl. effort** | 4–6h | 10–20h | 6–8h (not recommended) |
| **Ops burden** | High (support drift) | Low (automated) | Medium (fragile) |
| **Multi-squad ready** | ❌ No (N disks) | ✅ Yes (N builds → N snaps) | ✅ Yes (but slow) |
| **Version control** | ❌ External | ✅ In-repo | ⚠️ In-repo (but fragile) |
| **Production-grade** | ✅ Yes (if manual) | ✅ Yes | ❌ No (bootstrap antipattern) |

---

## Recommendation: Option B (Automated Disk Image Builder)

### Rationale

1. **Operational simplicity:** One command (`devclaw sandbox build` or automatic on `devclaw up`) replaces manual snapshot provisioning and `aca sandboxgroup` CLI work.

2. **Reproducibility:** Script-driven builds ensure identical images across users, squads, and CI/CD runs. Updates to auth-proxy or Node.js are captured in the script and versioned in git.

3. **Squad scaling:** Future multi-squad deployments can pre-build images in CI/CD, cache them in a snapshot registry, and reference them by ID in Bicep. No manual intervention per squad.

4. **Acceptable tradeoff:** 3–5 min build overhead on first deploy or image updates is worthwhile for the reproducibility and automation gains. Subsequent deploys reuse cached images.

5. **Clear upgrade path:** Option A (fallback documentation) stays in SKILL.md for users who already have disk tooling; Option B becomes the default path.

6. **Technology alignment:** Aligns with `devclaw` philosophy: "wrapper around `azd`" that abstracts infrastructure complexity.

---

## Design Sketch: Option B Implementation

### Files to Create/Modify

```
openclaw-dev/
├── scripts/
│   ├── build-disk-image.sh          # Main build script (Linux/macOS)
│   ├── build-disk-image.ps1         # PowerShell equivalent (Windows)
│   └── disk-image-metadata.json     # Output manifest (image hash, size, deps)
├── src/
│   └── Dockerfile                   # (existing; may add comment re: disk build)
├── infra/
│   ├── main.bicep                   # (modify: add sandbox disk params)
│   ├── aca.bicep                    # (modify: add disk snapshot reference + sandbox mode)
│   ├── resources.bicep              # (no changes)
│   └── hooks/
│       ├── predeploy.ps1            # (modify: trigger disk build if missing)
│       └── predeploy.sh             # (modify: trigger disk build if missing)
├── devclaw.cmd                      # (modify: add `sandbox` subcommand)
├── devclaw                          # (modify: add `sandbox` subcommand)
├── azure.yaml                       # (no changes)
└── skills/openclaw-on-azure/
    └── SKILL.md                     # (update: document Option B as default, Option A as fallback)
```

### Build Script Flow (`build-disk-image.sh` / `.ps1`)

**Pseudocode (Linux/macOS):**

```bash
#!/bin/bash
set -e

# Inputs
OUTPUT_DIR="${1:-./_local/sandbox}"
DISK_FORMAT="${2:-qcow2}"  # qcow2 (compressed), raw (larger but portable)
REGION="${3:-eastus2}"
SQUAD="${4:-core}"

# 1. Download/clone minimal Linux image (or use packer if available)
UBUNTU_IMG="ubuntu-24.04-minimal.img"
if [ ! -f "$OUTPUT_DIR/$UBUNTU_IMG" ]; then
    echo "Downloading minimal Ubuntu 24.04 image..."
    # Option: use ubuntu cloud images or official minimal ISO + preseed
    wget -O "$OUTPUT_DIR/$UBUNTU_IMG" https://cloud-images.ubuntu.com/.../ubuntu-24.04-minimal-amd64.img
fi

# 2. Mount and customize (or use qemu to boot + inject via qemu-guest-agent)
WORK_DIR=$(mktemp -d)
echo "Customizing disk image in $WORK_DIR..."
qemu-img convert -f raw "$OUTPUT_DIR/$UBUNTU_IMG" -O "$DISK_FORMAT" "$WORK_DIR/base.img"

# Boot image in QEMU, run cloud-init or similar to:
# - Update system (apt-get update)
# - Install Node.js 24, npm, git, ca-certificates, qemu-guest-agent
# - Copy auth-proxy.mjs, gateway-proxy.mjs into /opt/openclaw-auth/
# - Pre-cache npm deps (optional; can defer to first boot)
# - Clean apt cache (shrink image)
qemu-system-x86_64 \
  -m 4G -drive file="$WORK_DIR/base.img" \
  -device virtio-serial -chardev stdio,id=chars0 -device virtconsole,chardev=chars0 \
  ... (cloud-init setup)

# 3. Create final disk
DISK_NAME="openclaw-sandbox-${SQUAD}-${REGION}-$(date +%s).${DISK_FORMAT}"
mv "$WORK_DIR/base.img" "$OUTPUT_DIR/$DISK_NAME"

# 4. Generate metadata
cat > "$OUTPUT_DIR/disk-image-metadata.json" <<EOF
{
  "name": "$DISK_NAME",
  "format": "$DISK_FORMAT",
  "size_gb": $(du -h "$OUTPUT_DIR/$DISK_NAME" | cut -f1),
  "hash_sha256": "$(sha256sum "$OUTPUT_DIR/$DISK_NAME" | cut -d' ' -f1)",
  "squad": "$SQUAD",
  "region": "$REGION",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "build_script_version": "1.0",
  "node_version": "24.0.0",
  "auth_proxy_version": "1.0"
}
EOF

echo "✅ Disk image ready: $OUTPUT_DIR/$DISK_NAME"
echo "   Register with: aca sandbox create --disk ... --group sg-${SQUAD} ..."
```

### Bicep Integration

**In `main.bicep`:**

```bicep
@description('Disk snapshot ID for ACA Sandbox mode. Leave empty to auto-build.')
param sandboxDiskSnapshotId string = ''

// Pass to host module:
module host 'aca.bicep' = {
  name: 'host'
  params: {
    ...
    acaSandboxMode: acaSandboxMode
    sandboxDiskSnapshotId: sandboxDiskSnapshotId
    ...
  }
}
```

**In `aca.bicep`:**

```bicep
@description('Disk snapshot ID for ACA Sandbox mode.')
param sandboxDiskSnapshotId string = ''

// When in Sandbox mode and snapshot is provided, reference it in container app
// (Future: container app properties will include `sandboxDiskProperties` once ACA API stabilizes)
```

### `devclaw` CLI Integration

**New subcommand:**

```bash
devclaw sandbox build       # Build disk image locally
devclaw sandbox register    # Register snapshot with ACA Sandbox
devclaw sandbox status      # Show current disk metadata
```

**Integrated into `devclaw up`:**

```bash
devclaw up
→ Checks if SKIP_SANDBOX_BUILD=true (skip build)
  if not set:
    → Calls `./scripts/build-disk-image.sh` (auto-builds if missing)
    → Updates disk-image-metadata.json
    → Passes snapshot ID to Bicep via `azd env set`
    → Runs `azd provision` + `azd deploy`
```

### Predeploy Hook (`infra/hooks/predeploy.ps1` / `.sh`)

```powershell
# PowerShell predeploy hook
$diskMetadataPath = ".\_local\sandbox\disk-image-metadata.json"

# Check if disk exists; if not, build it
if (!(Test-Path $diskMetadataPath)) {
    Write-Host "⚠️  No sandbox disk image found. Building..."
    & ".\scripts\build-disk-image.ps1" -OutputDir ".\_local\sandbox"
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Disk build failed. Falling back to standard ACA mode."
        azd env set ACA_SANDBOX_MODE standard
        exit 0
    }
}

# Read metadata and export to azd env
$metadata = Get-Content $diskMetadataPath | ConvertFrom-Json
azd env set SANDBOX_DISK_SNAPSHOT_ID $metadata.snapshot_id
azd env set SANDBOX_DISK_NAME $metadata.name
```

### End-to-End User Flow

**Scenario: User deploys OpenClaw to ACA Sandbox for the first time**

```bash
$ az login && azd auth login
$ azd env new prod-us
$ azd env select prod-us
$ azd env set AZURE_LOCATION eastus2

# Option 1: Let devclaw auto-build (recommended)
$ ./devclaw up
  → predeploy hook detects no disk
  → runs build-disk-image.sh (~5 min, one-time)
  → azd provision creates ACR, environment, role assignments
  → disk snapshot is registered via Bicep
  → azd deploy builds and pushes OpenClaw image to ACR
  → container app starts in Sandbox mode
  → WebChat URL printed

# Option 2: Pre-build disk separately
$ ./devclaw sandbox build
  → outputs disk-image-metadata.json
$ azd env set SKIP_SANDBOX_BUILD true
$ ./devclaw up
  → skips build, references existing disk
  → faster second deployment
```

---

## Multi-Squad Scaling (Future)

Once Option B is operational:

1. **CI/CD automation:** On every commit to `main`, rebuild disk image
   - Store snapshot in snapshot registry (tagged by commit hash)
   - Push metadata to blob storage for lookup by Bicep

2. **Per-squad disk variants:** Different squads may have different:
   - Node.js versions (LTS vs. current)
   - Auth proxy configs
   - Pre-cached npm deps
   - → Build script parameterized by `SQUAD_VARIANT` env var

3. **Disk caching:** Cache images in:
   - Azure Compute Gallery (formerly Shared Image Gallery) for cross-subscription reuse
   - Or region-local snapshot registry (faster pull)

---

## Blockers & Dependencies

### Hard Blockers

| Blocker | Status | Workaround |
|---------|--------|-----------|
| ACA Sandbox disk snapshot API finalization | ⚠️ Preview (API changes possible) | Check Azure CLI + Bicep docs monthly; test in safe subscription |
| `aca` CLI tool availability | ✅ GA | Ensure users install `azure-cli-extensions` or `aca-cli` |
| QEMU or disk build tool availability | ✅ Available | Windows: Hyper-V or QEMU; Linux/macOS: qemu-img (pkg) |

### Soft Dependencies

| Dependency | Mitigation |
|------------|-----------|
| Build script maintenance | Set maintenance window; test on every devclaw release |
| Disk storage costs | Clean snapshots >30 days old; quota warnings at 50 snapshots |
| Build environment (Docker, QEMU) | Document in SKILL.md; provide Docker-based build as fallback |

### Testing Checklist

- [ ] Build disk image on Linux (Ubuntu 24.04), macOS (Sonoma+), Windows (PowerShell 7+)
- [ ] Verify disk boots in QEMU
- [ ] Register snapshot with ACA Sandbox CLI
- [ ] Deploy container app with disk snapshot reference
- [ ] Test cold start (~5–10s)
- [ ] Verify auth-proxy and gateway-proxy are responsive
- [ ] Connect to Azure OpenAI via managed identity
- [ ] Test multi-replica scaling (2–3 replicas)
- [ ] Test state persistence (Azure Files + disk snapshot interaction)
- [ ] Test squad isolation (squad-1 disk vs. squad-2 disk)

---

## Implementation Roadmap

### Phase 1 (MVP, 1–2 weeks)
- [ ] Create `build-disk-image.sh` (Linux/macOS) + `.ps1` (Windows)
- [ ] Write disk build tests (local qemu boot verification)
- [ ] Update SKILL.md with Option B as default, Option A as fallback
- [ ] Update `devclaw` to add `sandbox build` subcommand
- [ ] Integration test: single squad, single region

**Deliverable:** Users can run `devclaw sandbox build` + `devclaw up` on Linux/macOS; Windows support TBD pending Hyper-V scripting.

### Phase 2 (near future, 2–4 weeks)
- [ ] Integrate disk build into `predeploy` hook (auto-build on `devclaw up`)
- [ ] Add fallback logic: if disk build fails → warn + revert to standard ACA
- [ ] Test on Windows with Hyper-V PowerShell
- [ ] Squad-scoped disk builds (`SQUAD_NAME` parameterized)
- [ ] Integration test: multi-squad, cross-region

**Deliverable:** `devclaw up` works end-to-end without manual `devclaw sandbox build` step.

### Phase 3 (multi-squad ready, 4–8 weeks)
- [ ] CI/CD automation: rebuild disk on every commit, tag snapshot by hash
- [ ] Snapshot registry (Azure Compute Gallery or blob storage)
- [ ] Bicep parameterized by snapshot ID (lookup via `SQUAD_NAME` + `REGION`)
- [ ] Disk cleanup job (delete snapshots >30 days old)
- [ ] Monitoring: disk build success rate, size trends, cost tracking

**Deliverable:** Multi-squad deployments can reference pre-built, cached disk images; no manual disk provisioning required.

---

## Success Criteria

1. ✅ **Single command:** `./devclaw up` boots OpenClaw in Sandbox mode without manual disk provisioning
2. ✅ **Reproducible:** Same build script + inputs = identical disk images across users
3. ✅ **Fast cold start:** ~5–10s from Sandbox boot to WebChat UI responsive
4. ✅ **Multi-squad ready:** CI/CD can pre-build N disk images; Bicep parameterizes per-squad reference
5. ✅ **Low ops burden:** Disk build is transparent to users; failures gracefully fall back to standard ACA
6. ✅ **Version control:** Disk build script lives in repo; updates to auth-proxy/Node.js are tracked via git

---

## Conclusion

**Option B (Automated Disk Image Builder) is RECOMMENDED for immediate implementation.**

### Summary

| Metric | Option A | Option B | Option C |
|--------|----------|----------|----------|
| **Recommendation** | Fallback | ⭐ **PRIMARY** | Rejected |
| **User friction** | High | Low | Low |
| **Prod-ready** | ✅ | ✅ | ❌ |
| **Impl. effort** | 4–6h | 10–20h | 6–8h |
| **Multi-squad ready** | ❌ | ✅ (Phase 3) | ✅ (but slow) |

**Sandbox runtime strategy: Option B RECOMMENDED**
