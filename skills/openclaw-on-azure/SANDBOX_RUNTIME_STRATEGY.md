# Sandbox Runtime Strategy – Decision D-025

**Decision Date:** 2026-06-11  
**Decision ID:** D-025  
**Approved By:** Ripley (Lead Architect)  
**Status:** Approved – Phase 1 in Backlog  

---

## Executive Summary

**Option B (Automated disk image builder)** has been selected as the primary path for ACA Sandbox disk image provisioning.

### Why Option B?

| Factor | Option A | Option B | Option C |
|--------|----------|----------|----------|
| **User friction** | ❌ High (manual image build, snap, register) | ✅ Automated after Phase 1 | ❌ Runtime latency |
| **Reproducibility** | ⚠️ Manual, version-dependent | ✅ Versioned manifests, audit trail | ⚠️ Post-boot drift |
| **Multi-squad scaling** | ❌ Support burden | ✅ Self-service, CI-driven | ❌ Complex bootstrap |
| **Cold-start latency** | ✅ 5–10s | ✅ 5–10s | ❌ 30–60s (Node.js install) |
| **Signing & supply chain** | ❌ Not available | ✅ Phase 3 CI/CD | ❌ Not available |
| **Timeline** | ✅ Now | ⏳ Phased (1–8 wks) | ⏳ Phased (2–6 wks) |

**Verdict:** Option B balances automation, reproducibility, and multi-squad scalability. Phased rollout manages risk.

---

## 3-Phase Roadmap

### Phase 1: MVP Disk Image Builder (1–2 weeks)

**Deliverables:**
- `build-disk-image.sh` (Linux) + `build-disk-image.ps1` (Windows)
  - Bakes minimal Linux + Node.js 20+ + npm + auth-proxy
  - Configurable base image, package versions
  - Outputs VHD/VHDX ready for Azure Snapshot upload
- `devclaw sandbox init` subcommand (scaffolds Phase 1 steps)
- `devclaw sandbox upload` subcommand (registers snapshot with ACA Sandbox via `aca` CLI)
- Manual approval before Snapshot → Sandbox group registration
- Documentation: Phase 1 is human-mediated; full automation comes Phase 2

**Owner:** TBD (Bishop or Hicks candidate)

**Dependencies:**
- `aca` CLI available in PATH (user's responsibility for Phase 1)
- Azure subscription with ACA Sandbox API access

**Gating criteria:**
- Build scripts produce valid Azure-uploadable disk images
- Manual workflow verified end-to-end (Linux + Windows)
- Phase 2 waits for ACA Sandbox API stability signal (not preview)

---

### Phase 2: Automated Build & Registration (2–4 weeks)

**Deliverables:**
- `devclaw sandbox auto-build` (GitHub Actions or Azure Pipelines trigger)
- Dependency manifest versioning (package.json lock pinning)
- Automated rebuild on manifest changes
- Direct ACA Sandbox API integration (no manual `aca` CLI step)
- Image caching & incremental builds

**Owner:** TBD

**Blocker:** ACA Sandbox API must reach stable GA (not preview)

**Acceptance criteria:**
- New image auto-published to Azure Snapshots on dependency update
- End-to-end time < 30 min (build, snap, register)
- Rollback mechanism in place (pin to prior image on failure)

---

### Phase 3: CI/CD & Multi-Region (4–8 weeks)

**Deliverables:**
- GitHub Actions workflow for scheduled + on-demand image builds
- Image signing (sigstore or equivalent)
- Multi-region snapshot replication
- Audit log (who built, when, which manifest version)
- Metrics: build time, image size, failure rate

**Owner:** TBD

**Acceptance criteria:**
- Full end-to-end CI/CD, no human intervention required
- Images signed and verifiable by downstream squads
- < 5 min regional replication

---

## Security Considerations

**Parker (Security) review items:**
1. **Inline dependencies in build script:** Package sources, URL pinning, hash verification
2. **Base image provenance:** Alpine / Ubuntu source, GPG signature verification
3. **auth-proxy dependency:** Version pinning, artifact verification, no dynamic downloads
4. **Artifact storage:** Snapshots only accessible to authorized ACA Sandbox identities
5. **Build environment:** Isolated container (no ambient credentials in build logs)
6. **Signed artifacts (Phase 3):** Keyless signing (OIDC + Sigstore)

**Output:** Hardening recommendations to be incorporated into Phase 1 build script scaffolding.

---

## Implementation Notes

### Phase 1 Build Script Structure

```
build-disk-image.sh / .ps1
├── config/
│   ├── versions.txt      # Node.js, npm, auth-proxy versions
│   └── packages.txt      # Inline packages + sources (hash-pinned)
├── bootstrap/
│   ├── base-image.sh     # Download + verify Alpine/Ubuntu
│   ├── node-install.sh   # Node.js + npm setup
│   └── auth-proxy.sh     # auth-proxy integration
├── snap/
│   └── create-snapshot.sh # az snapshot create wrapper
└── README.md             # Manual workflow (user-facing)
```

### Phase 1 Workflow (User)

```bash
# 1. Scaffold Phase 1 setup
./devclaw sandbox init --region eastus --env prod

# 2. Build disk (manual, ~20 min)
./build-disk-image.sh

# 3. Upload snapshot (manual)
./devclaw sandbox upload --image node-disk.vhd --name node-24-prod

# 4. Register with ACA Sandbox (manual via aca CLI)
aca sandbox create --group sg-prod --disk node-24-prod ...

# 5. Verify
devclaw status
```

Phase 2 collapses steps 2–4 into `devclaw sandbox auto-build --manifest dependencies.lock`.

---

## Blockers & Risk Mitigation

| Blocker | Risk | Mitigation |
|---------|------|-----------|
| **ACA Sandbox API in preview** | Phase 2 rollout breaks on API changes | Wait for stable GA; Phase 1 remains manual-friendly |
| **Parker security sign-off** | Build script has unvetted deps | Include Parker in Phase 1 scaffolding review |
| **Multi-region replication latency** | Phase 3 images slow to distribute | Pre-stage Phase 3 CI to run in parallel regions |

---

## Success Metrics

- **Phase 1:** Phase 1 time-to-image < 30 min (manual workflow); zero build failures across Linux/Windows
- **Phase 2:** Automated rebuild on dependency change < 10 min turnaround; adoption by 2+ squads
- **Phase 3:** Multi-region replication < 5 min; 100% image signature verification pass rate

---

## Ownership & Schedule

| Phase | Owner | Start | Duration | Dependencies |
|-------|-------|-------|----------|--------------|
| **Phase 1** | Bishop or Hicks | Next sprint | 1–2 wks | Parker security review |
| **Phase 2** | TBD | Phase 1 + 1 wk | 2–4 wks | ACA Sandbox API stable GA |
| **Phase 3** | TBD | Phase 2 + 1 wk | 4–8 wks | Phase 2 adoption signal |

---

## See Also

- [`SKILL.md`](./SKILL.md) – "Disk image provisioning" section links to this document
- [`skills/openclaw-on-azure/`](.) – Build scripts (Phase 1 scaffolding in progress)
- Decision D-025 (Ripley decision inbox) – Full rationale & approval
