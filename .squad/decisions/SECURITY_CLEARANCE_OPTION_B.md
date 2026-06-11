# DECISION: Sandbox Disk Image Build Strategy (Option B) Security Clearance

**Date:** 2026-06-11  
**Reviewer:** Parker, Security Officer  
**Decision Authority:** Ripley, Lead Architect  
**Status:** ✅ APPROVED (Conditional)

---

## Decision

**APPROVED WITH CONDITIONS:** Option B (automated disk image builder) is approved for Phase 1 implementation, contingent on completion of 7 mandatory security gates before Phase 1 PR merge.

---

## Summary

### The Question
Before Phase 1 implementation of the automated disk image builder (`build-disk-image.sh` / `.ps1`) for Sandbox runtime, are there supply-chain or artifact integrity risks that would block Phase 1?

### The Answer
**No blockers exist that make Option B unsuitable.** All identified risks can be mitigated with straightforward design choices already outlined in the strategy document. However, 7 mandatory security gates must be implemented before Phase 1 ships:

1. ✅ npm package pinning (missing `package-lock.json`)
2. ✅ Build isolation (must run in isolated container)
3. ✅ Artifact signing (SHA256 hash verification)
4. ✅ Secret scanning (prevent credential leakage)
5. ✅ Build audit trail (git commit + builder in metadata)
6. ✅ Log redaction (suppress registry URLs, paths)
7. ✅ Base image & APT documentation (already mostly hardened)

---

## Security Verdict

**YELLOW** — Ready for Phase 1 with mandatory mitigations

### What This Means

- Option B is **operationally superior** to Option A (reproducibility, automation, no user friction)
- Current Dockerfile is **already well-hardened** (digest-pinned base, zero hardcoded secrets)
- Proposed build strategy introduces **manageable risks** (supply chain, build isolation, artifact integrity)
- All risks have **clear mitigation paths** with no new dependencies or complex tooling
- **Phase 1 can proceed** once 7 gates are implemented
- **No architectural changes needed** — design is sound, just needs hardening details

---

## Risk Assessment

### Critical Risks (Phase 1 Blockers)
1. **Build Isolation:** If build runs on host (not container), malicious script could modify host filesystem
   - **Mitigation:** Run build inside Docker container (no host access)
   - **Effort:** Low (standard practice)

2. **Artifact Integrity:** No mechanism to verify disk hasn't been tampered with
   - **Mitigation:** Generate SHA256 hash, verify before deployment
   - **Effort:** Low (standard checksum)

### High Risks (Phase 1 Blockers)
3. **npm Supply Chain:** No `package-lock.json` → rebuilds may diverge (cache poisoning risk)
   - **Mitigation:** Generate + commit `package-lock.json`, use `npm ci`
   - **Effort:** Low (npm standard)

4. **Secret Leakage:** Build script may accidentally embed credentials in disk image
   - **Mitigation:** Add grep-based secret scanner, abort if found
   - **Effort:** Low (regex pattern matching)

5. **Audit Trail:** No record of who built what image, when, from which commit
   - **Mitigation:** Include git commit, builder email, timestamp in metadata.json
   - **Effort:** Low (metadata capture)

### Medium Risks (Phase 1 Blockers)
6. **Build Log Leakage:** CI/CD logs may expose registry URLs, dependency details
   - **Mitigation:** Redact sensitive output before artifact storage
   - **Effort:** Low (log filtering)

### Low Risks (Phase 2+ Enhancement)
7. **Base Image Trust:** Node 24 digest could accidentally change
   - **Status:** Already mitigated (Dockerfile uses digest)
   - **Phase 2+:** Cosign signatures, offline APT/npm mirrors

---

## Already Hardened (No Action Needed)

### Dockerfile
- ✅ Base image (Node 24) uses digest pinning
- ✅ Version constraints on all npm packages (ARG-based)
- ✅ Zero hardcoded secrets (all injected at runtime)
- ✅ apt-get uses default GPG verification (Ubuntu 24.04 LTS)

### Runtime Architecture
- ✅ Managed Identity auth (no API keys stored)
- ✅ Auth proxy handles token refresh safely (@azure/identity)
- ✅ Configuration uses variable substitution at boot
- ✅ State isolation via Azure Files + ephemeral fallback

---

## Implementation Roadmap

### Phase 1 (MVP, 1–2 weeks) — All 7 mandatory gates required
- [ ] Generate `package-lock.json` + update Dockerfile
- [ ] Implement containerized `build-disk-image.sh` (Docker)
- [ ] Add SHA256 hash verification to predeploy hook
- [ ] Add secret-scanning grep check to build script
- [ ] Add audit trail (git commit, builder, timestamp) to metadata
- [ ] Add log redaction to build output
- [ ] Document APT/base image trust model in comments

**Deliverables:**
- `scripts/build-disk-image.sh` (Linux/macOS)
- `scripts/build-disk-image.ps1` (Windows)
- `scripts/Dockerfile.build-env` (build container)
- Updated `src/Dockerfile` (use `npm ci`)
- Updated predeploy hooks (hash verification)
- Generated `src/package-lock.json` (committed)
- Updated `SKILL.md` (security model, versioning strategy)

### Phase 2 (Integration, 2–4 weeks) — Non-blocking enhancements
- [ ] Integrate disk build into predeploy hook (auto-build on `devclaw up`)
- [ ] Add `devclaw sandbox build/status/approve` CLI commands
- [ ] Implement Cosign signing + SLSA provenance
- [ ] Add approval gate for snapshot promotion to prod
- [ ] CI/CD automation: rebuild disk on every commit to main

### Phase 3 (Multi-squad, 4–8 weeks) — Future scaling
- [ ] Offline APT + npm mirrors (air-gapped builds)
- [ ] Snapshot registry (Azure Compute Gallery)
- [ ] Disk cleanup automation (30-day retention)
- [ ] Cost tracking + quota warnings
- [ ] Advanced attestation (AWS Nitro, TPM)

---

## Conditions for Approval

1. **All 7 mandatory gates must be implemented** before Phase 1 PR merge
2. **Integration test must pass:** local build → verify hash → boot in QEMU
3. **Documentation must be updated:** SKILL.md, security model, versioning strategy
4. **Security review sign-off:** Parker (this document) + code review

---

## Questions for Implementation Team

**Q1: Windows support timing?**
- **A:** Defer Hyper-V PowerShell to Phase 2; Linux/macOS only in Phase 1 (acceptable for MVP)

**Q2: Build container registry?**
- **A:** Store `qemu-build:latest` in ACR alongside OpenClaw image (recommended)

**Q3: Offline builds?**
- **A:** Assume internet access in Phase 1; plan offline mirrors (APT, npm) for Phase 3

**Q4: Approval workflow?**
- **A:** Auto-promote in Phase 1 (safety net is hash verification); add approval gate in Phase 2

---

## Success Metrics

- ✅ Phase 1 PR includes all 7 mandatory gates
- ✅ Integration test: build → verify → boot succeeds
- ✅ Zero hardcoded secrets in final disk image
- ✅ Build logs redacted (no registry URLs or metadata)
- ✅ Metadata includes git commit, builder, timestamp
- ✅ SHA256 hash verified before deployment
- ✅ Documentation updated (SKILL.md)

---

## References

- [SANDBOX_DISK_IMAGE_SECURITY_REVIEW.md](../SANDBOX_DISK_IMAGE_SECURITY_REVIEW.md) — Detailed analysis (7 security questions)
- [PHASE_1_SECURITY_GATES.md](./.squad/decisions/PHASE_1_SECURITY_GATES.md) — Implementation checklist
- [SANDBOX_RUNTIME_STRATEGY.md](../SANDBOX_RUNTIME_STRATEGY.md) — Option B design (Ripley)
- [src/Dockerfile](../src/Dockerfile) — Already digest-pinned, no hardcoded secrets

---

**Decision Made By:** Parker, Security Officer  
**Date:** 2026-06-11 02:50 UTC  
**Approval:** ✅ CONDITIONAL (All 7 gates required)

**Next Step:** Ripley to assign Phase 1 implementation task to development team with this security clearance.
