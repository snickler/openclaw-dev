# Project Context

- **Owner:** Copilot
- **Project:** openclaw-dev
- **Stack:** Azure Container Apps Sandbox, azd, Bicep, OpenClaw runtime
- **Created:** 2026-06-11T00:08:01.572-04:00

## Learnings

- This project deploys through `devclaw` first and keeps Teams integration opt-in.
- ACA Sandbox is the default deployment target for new Squad-integrated flows.

## Recent Updates

- 2026-06-11: Delivered ACA Sandbox operating recommendation aligned with `devclaw`/`azd` contract and security constraints.
- 2026-06-11: Implemented AOAI RAI hardening defaults (`Jailbreak` + `Indirect Attack` set to `blocking=true`) and handed off for validation/review.

- 2026-06-11: Logged completion of squad-aware scaling + explicit squad-scoped wrapper rollout in orchestration and decisions records.

- 2026-06-11: Closed remaining hardening follow-up by pinning Docker base image to immutable digest and recording validation evidence.

- 2026-06-11: Session closeout for hardening batch; AOAI RAI hardening (D-005), Docker digest pinning (D-017), and squad-aware ACA deployment (D-011) all verified and release-ready.