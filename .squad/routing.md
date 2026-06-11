# Work Routing

How this team routes Azure-first integration and security-focused delivery work.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Scope, architecture, and trade-offs | Ripley | Integrating Squad with openclaw-dev, rollout sequencing, reviewer gating |
| Azure platform and deployment runtime | Bishop | ACA Sandbox topology, `devclaw`/`azd` provisioning, region/SKU handling |
| Security and identity hardening | Parker | Managed identity enforcement, Entra auth posture, RBAC and secret controls |
| Product integration and implementation | Hicks | Squad workflow wiring, command integration, deployment automation glue |
| Validation and release confidence | Vasquez | Deployment verification, regression checks, failure-mode tests |
| Session logging and decision merge | Scribe | Automatic decision/log management |
| Continuous execution monitor | Ralph | Backlog scanning, keep-working loop, idle watch |
| RAI and content safety review | Rai | Safety checks, credential detection, policy red flags |

## Azure & Security Skills/Tools Routing

1. **OpenClaw Azure deployment playbook:** `skills/openclaw-on-azure/SKILL.md` is mandatory context for Azure deploy/operate/troubleshoot tasks.
2. **Security handling:** apply `.copilot/skills/secret-handling/SKILL.md` for secrets, auth, and sensitive-config operations.
3. **Azure model lifecycle tasks:** route to the `microsoft-foundry` skill when deployments/evals/fine-tuning in Foundry scope are requested.
4. **Tool preference:** use Azure-native and GitHub-native tooling (`devclaw`, `azd`, `az`, `gh`) and managed identity patterns; avoid key-based auth fallbacks.

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Ripley |
| `squad:ripley` | Lead triage and architecture decisions | Ripley |
| `squad:bishop` | Azure platform and deployment work | Bishop |
| `squad:parker` | Security, identity, and policy hardening | Parker |
| `squad:hicks` | Integration and implementation work | Hicks |
| `squad:vasquez` | QA, testing, and validation | Vasquez |

## Rules

1. **Deploy through wrapper:** use `.\devclaw.cmd <cmd>` first, direct `azd` only as fallback.
2. **Azure OpenAI keyless only:** managed identity path is required; no API keys.
3. **Teams optional:** never force Teams setup unless explicitly enabled.
4. **Security-by-default:** run Parker + Rai reviews before shipping infra or auth changes.
5. **Parallel by default:** fan out independent work in background and keep the pipeline moving.
