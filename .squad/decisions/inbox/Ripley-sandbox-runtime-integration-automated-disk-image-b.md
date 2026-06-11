### 2026-06-11T10-48-49: Sandbox runtime integration: Automated disk image builder (Option B)
**By:** Ripley
**What:** Sandbox runtime integration: Automated disk image builder (Option B)
**References:** skills/openclaw-on-azure/SKILL.md, SANDBOX_RUNTIME_STRATEGY.md, devclaw (wrapper), Parker (security)
**Why:** ## Decision: Option B – Automated Disk Image Builder

### Chosen Path
**Option B (Automated disk image builder)** selected over:
- **Option A (User-managed images):** rejected due to high user friction, support burden, version fragmentation
- **Option C (Container-based approach):** rejected due to cold-start latency and complexity

### Rationale
- **Reproducibility:** disk images baked with known-good dependencies; audit trail via version manifests
- **Automation:** devclaw sandbox subcommand orchestrates image builds, upload to managed storage, ACA provisioning
- **Multi-squad scaling:** teams can spin up isolated sandbox runtimes without per-user manual intervention
- **Cost efficiency:** disk images cached; only rebuild on dependency updates

### 3-Phase Roadmap
| Phase | Duration | Deliverables | Owner |
|-------|----------|--------------|-------|
| **1 – MVP** | 1–2 weeks | `build-disk-image.sh`/`.ps1`, devclaw sandbox init, manual image upload | TBD (Bishop/Hicks candidate) |
| **2 – Auto-build** | 2–4 weeks | Automated image rebuild on dependency changes, ACA integration | TBD |
| **3 – CI/CD** | 4–8 weeks | GitHub Actions workflow, artifact signing, multi-region distribution | TBD |

### Critical Blocker
- **ACA Sandbox API stability:** Must exit preview / reach stable GA before Phase 2 rollout
- Validation owner: TBD (Engineering Lead)
- Risk mitigation: Phase 1 remains manual; no production usage until API stability confirmed

### Dependencies
- Parker security review of disk image build process (inline deps, package verification, signed artifacts)
- Consensus on disk image base OS and package versions (documented in `SANDBOX_RUNTIME_STRATEGY.md`)

### Next Steps
1. Assign Phase 1 implementation owner (Bishop or Hicks)
2. Parker completes security hardening assessment
3. Begin Phase 1 build script scaffolding next sprint
4. Gate Phase 2 start on ACA Sandbox API stability signal