# Squad Decisions

## Active Decisions

### 2026-06-11 — D-001 Sidecar control-plane baseline for Squad integration
- **Status:** Accepted
- **Deciders:** Ripley, Bishop
- **Decision:** Use a sidecar control-plane pattern for Squad integration in ACA Sandbox, keeping OpenClaw deployment on the `devclaw`/`azd` contract and Managed Identity-only AOAI access.
- **Key guardrails:** Teams remains opt-in, Easy Auth posture is preserved, no API-key fallback, and restricted-tenant controls (`SERVICE_MANAGEMENT_REFERENCE`, `SKIP_STORAGE`) are supported.
- **Sources:**
  - `decisions/inbox/Ripley-select-sidecar-control-plane-architecture-for-squa.md`
  - `decisions/inbox/Bishop-aca-sandbox-architecture-recommendation-for-opencl.md`

### 2026-06-11 — D-002 Pre-implementation security and QA gate policy
- **Status:** Accepted
- **Deciders:** Parker, Vasquez
- **Decision:** Treat keyless identity, dependency immutability, prompt-injection blocking posture, Easy Auth tenant scoping, secret hygiene, and deploy/test checks as mandatory release gates.
- **Sources:**
  - `decisions/inbox/Parker-pre-implementation-security-guardrails-for-squad-o.md`
  - `decisions/inbox/Vasquez-qa-gates-for-squad-aca-sandbox-security-skill-inte.md`

### 2026-06-11 — D-003 HIGH remediations must complete before integration rollout
- **Status:** Accepted
- **Decider:** Ripley
- **Decision:** Execute and gate in sequence: dependency pinning, AOAI policy hardening (`Jailbreak` + `Indirect Attack` blocking), deploy integrity checks, and security recheck prior to post-implementation sign-off.
- **Source:**
  - `decisions/inbox/Ripley-implement-high-security-remediations-before-integr.md`

### 2026-06-11 — D-004 Pin Dockerfile runtime dependencies to fixed versions
- **Status:** Implemented
- **Decider:** Hicks
- **Decision:** Replace mutable npm dependency references in `src/Dockerfile` with explicit pinned versions; align README references accordingly.
- **Source:**
  - `decisions/inbox/Hicks-pinned-dockerfile-npm-dependencies-to-fixed-versio.md`

### 2026-06-11 — D-005 AOAI RAI defaults hardened for prompt attack categories
- **Status:** Implemented
- **Decider:** Bishop
- **Decision:** Keep AOAI Prompt `Jailbreak` and `Indirect Attack` filters at `blocking: true` in default policy; update docs to match secure-by-default behavior.
- **Source:**
  - `decisions/inbox/Bishop-hardened-aoai-rai-policy-defaults-to-block-jailbre.md`

### 2026-06-11 — D-006 Focused validation criteria for the two HIGH remediations
- **Status:** Accepted
- **Decider:** Vasquez
- **Decision:** Enforce static and compile-time validation gates for dependency pinning and AOAI policy hardening, with deploy-time negative tests and security sign-off required before release.
- **Source:**
  - `decisions/inbox/Vasquez-validation-gates-for-dependency-pinning-and-aoai-p.md`

### 2026-06-11 — D-007 Post-implementation security review outcome
- **Status:** PASS
- **Decider:** Parker
- **Decision:** Dependency pinning and AOAI policy hardening findings are resolved for this phase; track base image digest pinning as next hardening follow-up.
- **Source:**
  - `decisions/inbox/Parker-post-implementation-security-review-dependency-pin.md`

### 2026-06-11 — D-008 Post-implementation QA review outcome
- **Status:** PROCEED_WITH_CHANGES
- **Decider:** Vasquez
- **Decision:** Proceed after targeted fixes: workflow token fallback/guard, MCP config alignment, and focused ACA sandbox smoke validation for hardened policy behavior.
- **Source:**
  - `decisions/inbox/Vasquez-post-implementation-qa-rubber-duck-review-proceed-.md`

### 2026-06-11 — D-009 Environment-sharded multi-squad command contract
- **Status:** Accepted
- **Decider:** Ripley
- **Decision:** Scale Squad operations using one `azd` environment per squad lane and route lifecycle operations through `devclaw` squad-scoped commands; preserve Managed Identity + `disableLocalAuth` with no API-key fallback.
- **Sources:**
  - `decisions/inbox/Ripley-adopt-environment-sharded-aca-architecture-for-mul.md`
  - `decisions/inbox/Ripley-multi-squad-command-orchestration-contract-for-openclaw-aca.md`

### 2026-06-11 — D-010 Initial squad orchestration command surface implemented
- **Status:** Implemented
- **Decider:** Hicks
- **Decision:** Added `devclaw squad {init|use|list|current}` (plus Windows parity) to standardize environment naming/selection for multi-squad operations while keeping existing single-env commands backward compatible.
- **Source:**
  - `decisions/inbox/hicks-add-devclaw-squad-orchestration-commands-for-multi.md`

### 2026-06-11 — D-011 Squad-aware deployment and explicit scoped ops implemented
- **Status:** Implemented
- **Deciders:** Bishop, Hicks
- **Decision:** Added squad identity/scaling deployment inputs and explicit `devclaw squad <up|deploy|status|logs|start|stop|restart|teams|down> <name|env-name>` wrappers with temporary env selection + restore to reduce wrong-environment execution risk.
- **Sources:**
  - `decisions/inbox/Bishop-enable-squad-aware-scalable-aca-deployment-for-ope.md`
  - `decisions/inbox/Bishop-added-explicit-squad-scoped-wrappers-for-core-devc.md`

### 2026-06-11 — D-012 Rollout block issued for mesh injection + command-model safety gaps
- **Status:** BLOCKED (resolved)
- **Deciders:** Parker, Vasquez
- **Decision:** Blocked rollout until `sync-mesh.sh` removed `eval`-based curl execution and squad operation routing reduced implicit-context risk in multi-squad usage.
- **Sources:**
  - `decisions/inbox/Parker-fail-command-injection-risk-in-distributed-mesh-sy.md`
  - `decisions/inbox/Vasquez-post-implementation-rubber-duck-block-rollout-unti.md`

### 2026-06-11 — D-013 Distributed mesh injection hardening implemented
- **Status:** Implemented
- **Decider:** Hicks
- **Decision:** Replaced `eval` with argv-safe curl invocation in remote-opaque sync flow, plus URL-scheme and confined target-path guards.
- **Source:**
  - `decisions/inbox/Hicks-hardened-distributed-mesh-remote-opaque-sync-again.md`

### 2026-06-11 — D-014 Final security gate for orchestration remediations
- **Status:** PASS
- **Decider:** Parker
- **Decision:** Final security review found no HIGH/MEDIUM-confidence vulnerabilities in remediated sync-mesh injection paths or explicit squad-scoped wrapper execution paths.
- **Source:**
  - `decisions/inbox/Parker-final-security-review-for-sync-mesh-injection-hard.md`

### 2026-06-11 — D-015 Final QA gate for orchestration remediations
- **Status:** PROCEED_WITH_CHANGES
- **Decider:** Vasquez
- **Decision:** Proceed after validating both blockers are remediated, with follow-ups for optional remote host allowlisting and lightweight regression coverage for squad context restore + mesh sanitization.
- **Source:**
  - `decisions/inbox/Vasquez-final-qa-gate-after-two-blocking-remediations-proc.md`

### 2026-06-11 — D-016 Hardening batch acceptance gate and rollout checklist
- **Status:** Accepted
- **Decider:** Ripley
- **Decision:** Adopt an explicit acceptance checklist for hardening-batch release readiness covering base image hardening, workflow auth fallback behavior, MCP config consistency, regression safeguard availability, and ACA sandbox smoke expectations.
- **Source:**
  - `decisions/inbox/Ripley-acceptance-gate-and-rollout-checklist-for-hardenin.md`

### 2026-06-11 — D-017 Docker base image pinned by immutable digest
- **Status:** Implemented
- **Decider:** Bishop
- **Decision:** Pin `src/Dockerfile` base image from mutable `node:24-slim` tag to immutable digest (`node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf`) to prevent silent upstream drift while preserving multi-arch compatibility.
- **Source:**
  - `decisions/inbox/Bishop-pin-docker-base-image-by-digest.md`

### 2026-06-11 — D-018 Workflow token fallback + MCP config normalization implemented
- **Status:** Implemented
- **Decider:** Hicks
- **Decision:** Guarded `@copilot` assignment workflow token usage with non-failing fallback/comment path and aligned `squad_state` MCP server configuration across `.mcp.json` and `.copilot/mcp-config.json` (with template guidance updates).
- **Source:**
  - `decisions/inbox/Hicks-harden-squad-issue-assignment-token-fallback-and-u.md`

### 2026-06-11 — D-019 Regression safeguard script adopted for squad/mesh hardening
- **Status:** Implemented
- **Decider:** Vasquez
- **Decision:** Added and validated `.squad/templates/scripts/qa/regression-multi-squad-safeguards.ps1` as a focused regression gate for squad context restore invariants and distributed-mesh sync sanitization invariants.
- **Source:**
  - `decisions/inbox/Vasquez-added-regression-safeguards-for-squad-context-rest.md`

### 2026-06-11 — D-020 Hardening batch final security review
- **Status:** PASS
- **Decider:** Parker
- **Decision:** Security review of digest pinning, workflow token fallback behavior, MCP config normalization, and regression safeguards found no high-confidence exploitable vulnerabilities in reviewed scope.
- **Source:**
  - `decisions/inbox/Parker-security-review-pass-for-hardening-batch.md`

### 2026-06-11 — D-021 Hardening batch final QA/rubber-duck verdict
- **Status:** PROCEED_WITH_CHANGES
- **Decider:** Vasquez
- **Decision:** Hardening batch is release-ready with targeted non-blocking follow-ups (runtime model docs drift, CI wiring for safeguard script, and optional stricter mesh endpoint policy).
- **Source:**
  - `decisions/inbox/Vasquez-final-rubber-duck-hardening-batch-is-release-ready.md`

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
