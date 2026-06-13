---
name: openclaw-on-azure
description: >-
  Deploy, operate, and troubleshoot a secure, hosted OpenClaw AI assistant on
  Azure (default ACA Sandbox with custom disk provisioning, fallback to standard Azure Container Apps, plus Azure OpenAI in Foundry Models, passwordless via
  Managed Identity, an app-owned Entra OIDC proxy in Sandbox mode, optional Microsoft Teams channel) using
  the repo's `devclaw` wrapper around the Azure Developer CLI (azd). USE FOR:
  deploy OpenClaw to Azure, "devclaw up" / "azd up" failing, set the model or
  region, connect OpenClaw to Microsoft Teams / use it from a phone, stop to
  save cost, start/restart, stream logs, verify the deployment, configure Entra
  ID sign-in, restrict access to specific users, tear everything down (nuke &
  pave). DO NOT USE FOR: editing OpenClaw's own source on npm, general Azure
  resource creation unrelated to this template, non-Azure hosting.
license: MIT
---

# OpenClaw on Azure — setup & operations playbook

This skill lets an AI assistant set up, run, and fix the **openclaw-dev** template
in plain English. It deploys [OpenClaw](https://github.com/openclaw/openclaw) as a
secure, always-on AI assistant on **ACA Sandbox (default, requires custom disk provisioning) or standard Azure Container Apps (legacy fallback)**, wired to **Azure OpenAI
in Foundry Models** over a **Managed Identity** (no API keys), gated in Sandbox mode by an **app-owned Entra OIDC reverse proxy** inside the runtime, and optionally reachable from **Microsoft Teams** on the user's phone.

Use this repo's own scripts, env-var contract, region list, and error catalog
**instead of guessing**. Always confirm with the user before any destructive
action (`devclaw down`, `azd down`, deleting app registrations, RBAC removal).

> Alpha / dev-test template, single-tenant. Today it targets **Azure OpenAI in
> Foundry Models** (default `gpt-5-mini`), with scope to add Claude and other
> Foundry Models later. Do not promise non-OpenAI models work today.

---

## The one thing to know

Everything is driven by the **`devclaw`** wrapper (a thin shell around `azd`):

```bash
./devclaw up        # macOS/Linux/WSL  — provision + build + deploy (~6 min first run)
.\devclaw.cmd up    # Windows (cmd or PowerShell)
```

On first `up`, `azd` prompts for a **subscription, region, and environment name**;
it creates resource group `rg-<env-name>` automatically. There is no separate
`.env` to edit — configuration is done with `azd env set <KEY> <VALUE>` before `up`.

If `devclaw`/`devclaw.cmd` is not executable, call `azd` directly (`azd up`, `azd down`,
`azd deploy`) — `devclaw` only adds friendly status/logs/start/stop/teams helpers.

---

## Command map (`devclaw <cmd>`)

| Command | What it does | Underlying call |
|---|---|---|
| `up` | Provision + remote build + deploy | `azd up` |
| `deploy` | Rebuild & redeploy after code changes (~3–4 min) | `azd deploy` |
| `status` | Container state, FQDN, URL, resource group | `az containerapp ...` |
| `logs` | Stream live container logs | `az containerapp logs show --follow` |
| `test` | Print container/auth/identity summary + console hint (NOT an e2e model test) | `az containerapp show` |
| `start` | Scale to configured runtime min/max replicas (resume after stop) | `az containerapp update --min/max-replicas <env values>` |
| `stop` | Scale to 0 replicas — **$0**, state preserved on Azure Files | `az containerapp update --min/max-replicas 0` |
| `restart` | Restart the active revision | `az containerapp revision restart` |
| `teams` | **Opt-in.** Enables Teams (re-provisions + redeploys on first run) and builds the sideload zip | `azd provision` + `azd deploy` + `az bot msteams ...` + zip |
| `squad` | Manage multi-squad orchestration (`init`, `use`, `list`, `current`) | `azd env new/select/list` + `azd env set` |
| `login` | Switch Azure account | `az login` + `azd auth login` |
| `down` | **DESTRUCTIVE** — delete all resources + Entra app regs | `azd down --purge` + `az ad app delete` |

The fastest real smoke test is the **WebChat UI** (open the URL from `devclaw status`),
not `devclaw test`.

### Disk image provisioning (required for ACA Sandbox — the default)

**⚠️ Current state:** ACA Sandbox disk images are registered from a **CI-built ACR image** (`src/Dockerfile.sandbox`) using `devclaw sandbox build` (or the Phase 3 workflow). The flow is remote-build-first (ACR build + disk registration) with no local image-build fallback, and the hosted Squad bundle is generated into `src/squad-runtime/runtime-bundle.json` before the ACR build so the durable image can stay on the `src/` build context. After `aca sandbox create`, the wrapper still performs an explicit `aca sandbox exec /opt/entrypoint.sh` bootstrap because the preview Sandbox platform does not reliably auto-run the image entrypoint on create/resume.
Private-image registry auth is deterministic: `register-sandbox-disk.py` acquires short-lived ACR credentials via `az acr login --expose-token` and injects them into `aca sandboxgroup disk create`.

**Decision: Option B (Automated disk image builder) — APPROVED**

The team has chosen **Option B: Automated disk image builder** (Decision D-025, approved by Ripley). See [`SANDBOX_RUNTIME_STRATEGY.md`](./SANDBOX_RUNTIME_STRATEGY.md) for full rationale.

**Option B roadmap:**

| Phase | Duration | Status | Owner | Deliverables |
|-------|----------|--------|-------|--------------|
| **1 – MVP** | 1–2 weeks | Backlog | TBD (Bishop/Hicks candidate) | ACA disk build from Dockerfile, `devclaw sandbox init/build/status/delete` |
| **2 – Auto-build** | 2–4 weeks | Backlog | TBD | Automated rebuild on deps; ACA integration |
| **3 – CI/CD** | 4–8 weeks | In progress | TBD | GitHub Actions, artifact signing, multi-region distribution |

**Risk accepted:** ACA Sandbox API is still preview, so Phase 3 automation proceeds with the current CLI surface and may need refreshes if the API changes.

**For now (Phase 1 in progress):** Users without a pre-built disk can use standard Container Apps:

```bash
azd env set ACA_SANDBOX_MODE standard
./devclaw up
```

This deploys to standard Container Apps (stateful, legacy Easy Auth + Teams support) instead of Sandbox while Phase 1 disk image automation is being built.

---

## Host modes: Express vs. standard vs. ACA Sandbox

| Mode | Default? | Cold start | Cost | Browser auth + Teams | Setup |
|------|----------|-----------|------|------------------|-------|
| **ACA Sandbox** | ✅ YES | ~5–10s | $0 when idle | ✅ In-app Entra OIDC browser auth; Teams webhook path stays exact and proxy-routed | Custom Node.js disk image + `aca sandbox create --entrypoint /opt/entrypoint.sh` |
| **Container Apps (standard)** | ❌ No (legacy) | ~30–60s | $0 when idle | ✅ Legacy Easy Auth + Teams | `azd env set ACA_SANDBOX_MODE standard` before `devclaw up` |
| **Container Apps (Express)** | ❌ No (legacy) | ~10–20s | $0 when idle | ✅ Legacy Easy Auth + Teams | `azd env set ACA_SANDBOX_MODE standard USE_EXPRESS_ENV true` before `devclaw up` |

**Decision:** The template **defaults to ACA Sandbox** (fastest cold-start, most isolated). Sandbox browser access is owned by the in-app Entra OIDC proxy inside `gateway-proxy.mjs`; the ACA sandbox public port is anonymous at the platform layer. However, Sandbox still requires a pre-built custom disk image (Node.js + auth-proxy + OIDC-aware gateway-proxy), which is not automatically generated today. For immediate deployment without custom disk provisioning, set `ACA_SANDBOX_MODE=standard` to use legacy Container Apps (stateful via Azure Files, legacy Easy Auth + Teams support). See "Disk image provisioning" section below for Sandbox setup.

---

## Prerequisites (check before deploying)

- **Azure CLI** (`az`) and **Azure Developer CLI** (`azd`) installed and logged in
  (`az login`, `azd auth login`). `devclaw` checks for both and exits if missing.
- An Azure subscription and a tenant where the user can create **one Entra ID app
  registration** for the sandbox browser-login proxy. The optional Teams add-on creates a
  second app registration (the Bot) plus a client secret — some tenants restrict
  this (see error catalog).
- Either local **Docker Desktop** running **or** the default `remoteBuild: true` in
  `azure.yaml` (ACR builds the image — no local Docker needed).
- **PowerShell 7+** (`pwsh`) on Windows only if running `devclaw teams` (optional Teams add-on).

---

## Configuration contract (`azd env set` before `devclaw up`)

| Env var | Required | Default | Notes |
|---|---|---|---|
| `AZURE_ENV_NAME` | prompted | — | Names the env and `rg-<env-name>` |
| `AZURE_LOCATION` | prompted | — | Must be in the allowed region list (below) |
| `AZURE_SUBSCRIPTION_ID` | no | prompted | Set to skip the interactive picker |
| `AZURE_OPENAI_LOCATION` | no | = `AZURE_LOCATION` | Override when the chosen region lacks the model SKU (e.g. ACA in `eastasia`, OpenAI in `eastus2`) |
| `SQUAD_NAME` | no | `core` | Logical squad name used for tagging, naming, and state isolation |
| `SQUAD_INSTANCE` | no | `1` | Numeric squad instance identifier; use distinct values per squad deployment |
| `OPENCLAW_MIN_REPLICAS` | no | `1` | Minimum ACA replicas for the OpenClaw runtime |
| `OPENCLAW_MAX_REPLICAS` | no | `3` | Maximum ACA replicas for the OpenClaw runtime (must be >= min) |
| `ACA_SANDBOX_MODE` | no | `sandbox` | Host mode selector: `sandbox` (default) for ACA Sandbox (requires custom Node.js disk image provisioning); `standard` (legacy) for Azure Container Apps with optional Express mode cold-start (`azd env set USE_EXPRESS_ENV true`). For Sandbox mode, see "Disk image provisioning" below; disk must be pre-built and registered with ACA Sandbox. |
| `SANDBOX_DISK_NAME` | no | unset | ACA Sandbox disk image resource name under `sandboxGroups/<group>/diskimages`. `devclaw sandbox build` sets it after registration. |
| `SANDBOX_DISK_IMAGE_ID` | no | unset | ACA Sandbox disk image resource ID returned by `devclaw sandbox build`/CI registration. Useful for auditing and troubleshooting. |
| `SANDBOX_SOURCE_IMAGE` | no | unset | Optional pre-built image ref for sandbox disk registration. If unset, `devclaw sandbox build` generates `src/squad-runtime/runtime-bundle.json` and performs a remote `az acr build` of `src/Dockerfile.sandbox` with `src/` as the build context. |

### CI hardening (sandbox target protection)

Phase 3 workflow no longer exposes `workflow_dispatch` inputs for sandbox target RG/group/region. It uses locked repo/org vars (`CI_SANDBOX_RESOURCE_GROUP`, `CI_SANDBOX_GROUP`, `CI_SANDBOX_REGION`) plus allowlist/regex validation before build/register steps.
| `SANDBOX_DISK_SNAPSHOT_ID` | no | unset | Legacy phase 1/2 input for sandbox disk snapshot resource ID (kept for compatibility while ACA Sandbox APIs were still maturing). |
| `SANDBOX_GITHUB_COPILOT_PAT` | no | unset | Optional fine-grained GitHub PAT (`github_pat_...`). When set, `devclaw sandbox upload` auto-creates a sandbox-group credential (`github-copilot`) and attaches it to the created sandbox. In custom Sandbox images today, this PAT is also the bridge for non-interactive `gh`: `devclaw sandbox build/upload` passes it into the sandbox as `GH_TOKEN` because the attached `github-copilot` credential itself is not surfaced inside custom images as a discovered env var/file/mount. |
| `SANDBOX_GITHUB_COPILOT_CREDENTIAL_ID` | auto | unset | Cached credential ID created during `devclaw sandbox upload` when `SANDBOX_GITHUB_COPILOT_PAT` is provided. Reused on subsequent uploads to avoid duplicate credential creation. If only this cached credential ID remains and the PAT is no longer available locally, the credential still attaches, but `gh` inside a custom Sandbox image will not auto-auth. Re-set the PAT before `devclaw sandbox build/upload` when you want in-sandbox `gh` auth. |
| `GITHUB_TOKEN` | no | unset | Optional GitHub token bridge for the **standard ACA runtime**. If set before `devclaw up` / `devclaw deploy`, Bicep injects it as a secret-backed `GITHUB_TOKEN` + `GH_TOKEN` inside the container so hosted `gh` and token-backed GitHub MCP servers can authenticate. Sandbox mode ignores this env var; use `SANDBOX_GITHUB_COPILOT_PAT` there. |
| `USE_EXPRESS_ENV` | no | `false` | When set to `true`, Container Apps environment is created in Express mode (preview) for faster cold-start (~10–20s vs. ~30–60s). Only applicable when `ACA_SANDBOX_MODE=standard`. Supported regions include East Asia and West Central US. Express mode disables storage mounts, so session state does not persist across replica restarts. |
| `SKIP_STORAGE` | no | `false` | Set to `true` if Azure Policy blocks `allowSharedKeyAccess: true` on storage accounts (ACA file mounts require shared keys today). Skips the storage account, file share, and volume mount. Trade-off: gateway token + sessions don't persist across replica restarts. |
| `SERVICE_MANAGEMENT_REFERENCE` | no | unset | Set to a service-management-reference GUID if your tenant requires `serviceManagementReference` on every new app registration (common on large corporate tenants). The preprovision hook passes it to `az ad app create` for the sandbox browser-auth app registration and the Bot app registration. |
| `ENABLE_TEAMS` | no | unset (Teams disabled) | Set to `true` *before* `devclaw up` (or before `devclaw teams`) to opt into the Microsoft Teams add-on. When unset, the preprovision hook skips bot app creation, Bicep skips the Azure Bot + Teams channel + MSTEAMS_* env vars, and the runtime disables the msteams plugin. |
| `BOT_APP_ID` / `BOT_APP_SECRET` / `BOT_TENANT_ID` | auto (when `ENABLE_TEAMS=true`) | — | Created by the preprovision hook when the Teams add-on is enabled; do not set by hand unless your tenant blocks `az ad app credential reset` and you're providing a pre-created bot app reg |
| `BROWSER_AUTH_MODE` | auto | `entra-oidc-proxy` in Sandbox mode | Created by the preprovision/runtime bootstrap flow. Sandbox only. |
| `BROWSER_AUTH_CLIENT_ID` / `BROWSER_AUTH_TENANT_ID` | auto (Sandbox mode) | — | Created by the preprovision hook for the in-container Entra OIDC browser-auth proxy. |
| `BROWSER_AUTH_SESSION_SECRET` | auto (Sandbox mode) | — | Random secret used to sign/track secure HttpOnly browser sessions in the in-container OIDC proxy. |
| `BROWSER_AUTH_ALLOWED_USERS` | auto (Sandbox mode) | current deployer account | Comma-separated browser allowlist enforced inside the OIDC proxy before a session cookie is issued. Defaulted by the preprovision hook to `az account show --query user.name`. Expand explicitly if more users should be allowed. |
| `BROWSER_AUTH_ALLOWED_OBJECT_IDS` | auto when resolvable (Sandbox mode) | signed-in deployer object ID | Optional comma-separated Entra object ID allowlist. Used as an additional strict match inside the OIDC proxy. |
| `PUBLIC_BASE_URL` | auto (after `devclaw sandbox build`) | — | Canonical public URL for Sandbox mode. Used for redirect URI construction, cookie scoping, and origin validation. Do not set this from client-supplied host headers. |
| `EASYAUTH_APP_ID` | auto (legacy standard mode) | — | Created by the preprovision hook only for the legacy standard Container Apps path. |
| `SERVICE_OPENCLAW_IMAGE_NAME` | auto | — | Populated by azd after first deploy |
| `AOAI_DEFAULT_API_VERSION` | no | unset | Escape hatch in `src/auth-proxy.mjs`. Only set when targeting a **non-v1** AOAI surface (e.g. `2024-10-21`). When set, the proxy appends `?api-version=<value>` to `/openai/...` requests that don't already have one. Leave unset for the shipped v1 (`/openai/v1/...`) path. |

### Hosted `/skills` GitHub card

- The built-in OpenClaw GitHub skill at `/usr/local/lib/node_modules/openclaw/skills/github/SKILL.md` is blocked unless `gh` is on PATH.
- This repo's hosted images preinstall `gh`, symlink it into `/usr/local/bin/gh`, and patch the bundled skill so Linux-hosted runtimes prefer **apt** guidance instead of a misleading **brew** button.
- If the card still shows `bin:gh` blocked even though `gh` exists, treat that as stale skills-snapshot / requirement-detection state. This repo patches OpenClaw's skills refresh module so hosted sessions re-evaluate skill requirements on each runtime boot.
- Hosted boot forces `GH_PROMPT_DISABLED=1`; use `SANDBOX_GITHUB_COPILOT_PAT` (Sandbox) or `GITHUB_TOKEN` (standard ACA) for non-interactive auth instead of `gh auth login`.

**Allowed `AZURE_LOCATION` values:** `australiaeast`, `eastasia`, `eastus`, `eastus2`,
`japaneast`, `koreacentral`, `southindia`, `swedencentral`, `switzerlandnorth`,
`uksouth`, `westcentralus`.

**Model:** `gpt-5-mini` (version `2025-08-07`, capacity 10 TPM-thousands) is set in
`infra/main.bicep`. To change the model/version/capacity, edit the `openai` module
params there (`aiModelName`, `aiModelVersion`, `aiModelCapacity`) — they are not env
vars. Keep it to an **Azure OpenAI** model available in `AZURE_OPENAI_LOCATION`.

Example region split when the model isn't in your ACA region:

```bash
azd env set AZURE_LOCATION eastasia
azd env set AZURE_OPENAI_LOCATION eastus2
./devclaw up
```

### Phase 3 CI/CD publish prerequisites (GitHub Actions -> Azure Blob)

For `phase3-ci-cd.yml` to publish regional bundles to Azure Blob, configure all of:

1. GitHub repo secrets:
   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
   - `AZURE_STORAGE_ACCOUNT`
   - `AZURE_STORAGE_CONTAINER`
2. Federated credential (OIDC) on the user-assigned managed identity used by `AZURE_CLIENT_ID`:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Audience: `api://AzureADTokenExchange`
   - Subject (branch-scoped): `repo:<owner>/<repo>:ref:refs/heads/main`
3. Storage RBAC for that identity:
   - `Storage Blob Data Contributor` on the target storage account scope.

The workflow publishes with `--auth-mode login` and verifies that blobs exist under:
`<container>/sandbox/<region>/`.

---

## Common tasks

### Deploy from scratch

**Default path (ACA Sandbox — requires custom disk image):**

1. Confirm `az`/`azd` installed and logged in (`devclaw login` if not).
2. Ensure you have a pre-built Node.js disk image ready (see "Disk image provisioning" section above).
3. Optional: `azd env set AZURE_SUBSCRIPTION_ID <id>` / `AZURE_LOCATION <region>` / `AZURE_OPENAI_LOCATION <region>`.
4. `./devclaw up` (or `.\devclaw.cmd up`). First run ~6 min. Bicep defaults to Sandbox mode and the preprovision hook creates the browser-auth app registration.
5. `devclaw sandbox build` — remotely builds/registers the disk, creates the sandbox with `/opt/entrypoint.sh`, exposes the sandbox port anonymously, updates the Entra redirect URI to `PUBLIC_BASE_URL/oidc/callback`, and verifies `/healthz` plus the browser-login redirects.

**Quick start without a disk image (use standard Container Apps instead):**

1. Confirm `az`/`azd` installed and logged in.
2. `azd env set ACA_SANDBOX_MODE standard` — this opts out of Sandbox and uses standard Container Apps (stateful, legacy Easy Auth + Teams supported).
3. Optional: `azd env set AZURE_SUBSCRIPTION_ID <id>` / `AZURE_LOCATION <region>` / `AZURE_OPENAI_LOCATION <region>`.
4. `./devclaw up` (or `.\devclaw.cmd up`). First run ~6 min.
5. Verify: `devclaw status` (expect `Running`), then open the URL in a browser — Entra ID prompts for Microsoft sign-in, then the WebChat UI loads.

### Orchestrate multiple squads
Use one `azd` environment per squad deployment:
```bash
devclaw squad init alpha eastus2 eastus2  # creates/selects squad-alpha
devclaw squad use alpha                    # switch active deployment context
devclaw squad current                      # show selected squad env
devclaw squad list                         # enumerate squad environments
```
After selecting a squad environment, run the normal `devclaw up/deploy/status/stop/start`
commands to operate that squad independently.

### Save cost when idle
`devclaw stop` scales to 0 replicas ($0, state preserved on Azure Files);
`devclaw start` resumes. Don't use `down` for this — `down` deletes everything.

### Connect to Microsoft Teams (optional add-on — phone access)
Teams is **off by default**. Enable it with:
```bash
azd env set ENABLE_TEAMS true
devclaw teams      # first run: re-provisions + redeploys, then enables channel + builds zip
```
If the user runs `devclaw teams` without setting `ENABLE_TEAMS`, the wrapper
will prompt to enable it and re-provision in one step.

1. `devclaw teams` — (re-)provisions the bot app reg + Azure Bot when needed,
   enables the Teams channel, and builds `teams/openclaw-teams-app.zip`
   (regenerated; gitignored). The zip is baked from `teams/manifest.json`
   (committed source); `teams/package/manifest.json` is the generated copy and
   is gitignored — only edit the source.
2. In Teams: **Apps → Manage your apps → Upload a custom app →** select the zip → **Add** → DM the bot.
- Requires `pwsh` on Windows. The msteams plugin must be active in `src/openclaw.json`
  (`plugins.allow: ["msteams"]` + `plugins.entries.msteams.enabled: true`) — already shipped.
  When Teams is disabled the entrypoint disables the plugin at boot so the
  gateway doesn't try to authenticate with empty Bot Framework credentials.
- **Legal URLs in the manifest** show up in Teams' *About* dialog ("Created by …",
  *Privacy policy*, *Terms of use*). The shipped `teams/manifest.json` points
  `privacyUrl` and `termsOfUseUrl` at Microsoft's generic statements
  (`microsoft.com/en-us/privacy/privacystatement`,
  `microsoft.com/en-us/legal/terms-of-use`) and `websiteUrl` at the README's
  `#alpha` anchor so users see the alpha caveat. Anyone forking under a different
  org **must** repoint these to their own policy URLs before sideloading.

### Restrict access to specific users/groups
Sandbox browser auth is configured automatically by `devclaw up` + `devclaw sandbox build`. To lock it down:
- Fastest repo-native path: set `BROWSER_AUTH_ALLOWED_USERS` (and optionally `BROWSER_AUTH_ALLOWED_OBJECT_IDS`) in the azd env, then re-run `devclaw sandbox build`.
- Additional tenant-side hardening: Azure Portal → Entra ID → App registrations → `openclaw-browser-<env>` → Enterprise
applications → set **Assignment required? = Yes** and assign users/groups.

### Tear everything down (DESTRUCTIVE — confirm first)
`devclaw down` deletes the resource group, ACA, OpenAI, storage, **and** the
Entra app registrations that were created (sandbox browser auth in Sandbox mode, Easy Auth only on the legacy standard path, Bot only when the
Teams add-on is enabled). Always confirm with the user before running it.

---

## Error catalog (match symptom → fix)

| Symptom | Cause | Fix |
|---|---|---|
| `Please run 'az login' to setup account.` inside the `[preprovision]` hook even though `az account show` works in your normal shell | azd points `AZURE_CONFIG_DIR` at the repo-local `.azure/` folder; that folder has no signed-in account. | Already shipped: the preprovision hook detects this and unsets `AZURE_CONFIG_DIR` so `az` falls back to the user's default (`~/.azure` / `%USERPROFILE%\.azure`). If you still see it, run `az login` in the same shell you'll run `devclaw up` from. |
| `[preprovision] ERROR: Failed to create ... app registration` and `ServiceManagementReference field is required for Create` | Restricted tenant requires `serviceManagementReference` (a service-management-reference GUID) on every new app registration. | `azd env set SERVICE_MANAGEMENT_REFERENCE <guid>` and re-run `devclaw up`. The hook forwards it to both `az ad app create` calls (sandbox browser auth + Bot). Get the GUID from your tenant admin. |
| `Resource 'acr...' was disallowed by policy ... Container registries should have local admin account disabled.` | Subscription policy requires `adminUserEnabled: false` on ACR. | Already shipped: ACR is created with admin disabled and the container app pulls images via its system-assigned managed identity (AcrPull role assigned by Bicep). No env var needed. |
| `Local authentication methods are not allowed` on the storage account, or `allowSharedKeyAccess: true` is disallowed by policy | Subscription policy blocks shared-key access on storage; ACA file mounts require shared keys today. | `azd env set SKIP_STORAGE true` then re-run `devclaw up`. The storage account, file share, and volume mount are skipped; the entrypoint falls back to an in-container ephemeral state dir. Gateway token + sessions won't survive a replica restart. |
| `Failed to provision revision for container app — Operation expired` (~20 min timeout) on first provision | The placeholder image (`mcr.microsoft.com/k8se/quickstart:latest`) listens on `:80`, but probes/ingress were targeting `:18789`. | Already shipped: on first provision (`containerImage` empty) Bicep targets ingress at `:80` and skips probes; the `postdeploy` hook flips ingress back to `:18789` after the first real `azd deploy` lands. |
| `eastus` provisioning hangs/times out for ACA even with the probe fix | Transient/regional ACA platform issue in `eastus`. | Try a different region from the allowed list — `westus2`, `eastus2`, and `westcentralus` have been the most reliable lately. Switch with `azd env set AZURE_LOCATION <region>` and re-run `devclaw up`. |
| `[preprovision] ERROR: Failed to create bot client secret` with `Credential type not allowed as per assigned policy` from `az ad app credential reset` | Restricted tenant policy blocks programmatic client-secret creation. Common on large corporate tenants. | Leave Teams off (don't set `ENABLE_TEAMS=true`) — the browser experience deploys fine. To use Teams anyway, ask the tenant admin to create the bot app registration + secret, then `azd env set BOT_APP_ID <id>`, `azd env set BOT_APP_SECRET <secret>`, `azd env set BOT_TENANT_ID <tenant>`, `azd env set ENABLE_TEAMS true`, then `devclaw teams`. |
| `[preprovision] ERROR: Failed to create bot app registration` with `serviceManagementReference` required | Restricted tenant requires `serviceManagementReference` on new app registrations. | Set `SERVICE_MANAGEMENT_REFERENCE` (see row above) so the hook can create the bot app reg too — or, if your tenant also blocks the secret reset, keep Teams off / supply a pre-created bot via `BOT_APP_ID`/`BOT_APP_SECRET`/`BOT_TENANT_ID`. |
| `devclaw teams` says "Teams is an optional add-on and isn't enabled" | Default since Teams was made opt-in. | Either accept the prompt to enable now (the wrapper sets `ENABLE_TEAMS=true` and re-provisions), or set it ahead of time: `azd env set ENABLE_TEAMS true && devclaw teams`. |
| Container `Activating` >2 min | Token acquisition retrying | Normal up to ~5 min; `devclaw logs` |
| `ActivationFailed` | Container crashed | Portal → Container App → Log stream |
| `Cannot find module '@buape/carbon'` / HTTP 500 on all routes | Cached/broken Docker layer or missing plugin deps | `docker build --no-cache ./src` then `devclaw deploy` |
| `Config invalid: Unrecognized key` | Old config format | Config must be `{"gateway":{"mode":"local"}}` shape |
| `Circular dependency detected on resource ... containerApps` during `azd provision` | Old `aca.bicep` self-reference | Pull latest (uses a `containerImage` parameter) |
| `401 invalid issuer` | RBAC not propagated | Wait ~5 min; `az role assignment list --assignee <principal-id> --all` |
| `disableLocalAuth` blocks `list-keys` | By design | Expected — Managed Identity only, no keys |
| `pairing required` | Missing `dangerouslyDisableDeviceAuth` / exact browser-origin config in the trusted proxy flow | Ensure `entrypoint.sh` rewrites `gateway.controlUi.allowedOrigins` to `PUBLIC_BASE_URL` and keeps `dangerouslyDisableDeviceAuth: true` for hosted browser use |
| `Proxy headers detected from untrusted address` | Reverse proxy not trusted | Keep the internal gateway on loopback and `gateway.trustedProxies` limited to `127.0.0.1` / `::1` |
| WebChat shows `302 /oidc/login` but never reaches Microsoft sign-in | Browser auth app registration redirect URI missing or stale | Re-run `devclaw sandbox build` so the bootstrap step updates `PUBLIC_BASE_URL/oidc/callback` on the app registration |
| Browser sign-in succeeds but callback returns `403 principal-not-allowed` | The user authenticated in the tenant, but is not in `BROWSER_AUTH_ALLOWED_USERS` or `BROWSER_AUTH_ALLOWED_OBJECT_IDS` | Add the exact user/UPN (or object ID) to the azd env allowlist and re-run `devclaw sandbox build`. Default is the current deployer only. |
| `POST /api/messages` → **502** | msteams plugin didn't load (nothing on `:3978`) | Confirm the `plugins` block in `src/openclaw.json`, `devclaw deploy`, look for `… msteams …` in `[gateway] http server listening` log |
| `POST /api/messages` → **401** to a curl test | Bot Framework JWT auth rejecting unsigned request | None — real Teams traffic carries a valid token |
| Teams DM is acknowledged (200) but bot never replies | `channels.msteams.dmPolicy` defaults to `"pairing"` — unknown senders are silently ignored until approved via CLI | Already shipped: `src/openclaw.json` sets `dmPolicy: "open"` + `allowFrom: ["*"]`. Single-tenant Entra sign-in still scopes the browser experience to the deployer's tenant. |
| Direct Line / Web Chat / Teams test channel: user message acked (200) but bot reply never arrives. Container logs show `Blocked Microsoft Teams serviceUrl host: directline.botframework.com` | The bundled `@openclaw/msteams` plugin's SSRF guard only allows `smba.trafficmanager.net` + `smba.infra.{gcc,gov,dod}.*` (real Teams channel hosts). Direct Line uses `directline.botframework.com`, so every reply is silently dropped inside the streaming pipeline. | Already shipped: `src/patch-msteams-allowlist.mjs` runs at image build (see `src/Dockerfile`) and extends the plugin's allowlist to include `directline.botframework.com` + `europe.directline.botframework.com`. Idempotent. Remove once upstream plugin exposes a public hook. |
| Bot reply attempt fails with `AADSTS7000229: The client application <bot-app-id> is missing service principal in the tenant <tenant-id>` | The Bot App Registration was created without an enterprise application (service principal) in the consuming tenant — the Bot Framework token endpoint can't issue tokens to an appId with no SP. Happens when an app reg is provisioned via Graph without `az ad sp create`, or when the bot is consumed cross-tenant. | One-time fix: `az ad sp create --id $(azd env get-value BOT_APP_ID)`. If `az` is rate-limited, call Graph directly: `curl -s -X POST https://graph.microsoft.com/v1.0/servicePrincipals -H "Authorization: Bearer $(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)" -H "Content-Type: application/json" -d "{\"appId\":\"$(azd env get-value BOT_APP_ID)\"}"`. No redeploy needed — propagates in <30s. |
| Bot replies in WebChat but not Teams | Teams channel off or wrong `botId` in sideload | Re-run `devclaw teams` |
| `az containerapp exec`/`logs` crashes or hangs (🦞 Unicode / SSL) | Azure CLI bug | Use Azure Portal Console / Log stream |
| `azd up` warns about permissions | azd heuristic | Safe to proceed, or grant `User Access Administrator` |

### Test the model endpoint directly (keyless)
```bash
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv)
ENDPOINT=$(az cognitiveservices account list -g <rg> --query "[0].properties.endpoint" -o tsv)
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Hello"}]}' \
  "$ENDPOINT/openai/v1/chat/completions"
```

---

## Architecture (for accurate answers)

- **Azure Container Apps** hosts the OpenClaw gateway; public HTTPS on `:18789`.
  Inside the container, `src/entrypoint.sh` starts three Node processes:
  `gateway-proxy` (`:18789`, splits ingress by path), the **OpenClaw gateway**
  (`:18788`), and the **auth-proxy** (`:18790`, injects a fresh MI bearer token).
- **Azure OpenAI in Foundry Models** is called via the OpenAI-compatible
  REST API under `/openai/v1/...` — `src/openclaw.json` sets the adapter to
  `"api": "openai-completions"` and `src/auth-proxy.mjs` injects the MI bearer.
  No `openai` npm SDK. `disableLocalAuth: true` (no keys). To target a non-v1
  AOAI surface, set `AOAI_DEFAULT_API_VERSION` (see env-var table).
- **Managed Identity** needs both the **Cognitive Services User** and
  **Cognitive Services OpenAI User** roles on the model account.
- **gateway-proxy.mjs** is the public auth boundary in Sandbox mode. It owns
  Microsoft sign-in, callback handling, secure HttpOnly session cookies, exact-path
  exemptions (`/oidc/login`, `/oidc/callback`, `/healthz`, and `/api/messages`
  when Teams is enabled), and forwards authenticated traffic to the internal
  OpenClaw gateway using trusted-proxy headers.
- **Azure Bot Service** fronts the Teams channel; **Azure Files** persists state;
  **Container Registry** stores the image; **Log Analytics** holds logs.

## Security model (defense in depth — 4 layers)
1. **In-app Entra OIDC proxy** (Microsoft login, tenant-scoped, strict redirect/issuer/audience validation) before the OpenClaw gateway.
2. **Trusted-proxy gateway mode** — browser never receives the OpenClaw gateway token; the gateway only trusts loopback proxy headers.
3. **Managed Identity** — short-lived Entra tokens, `disableLocalAuth: true`, no keys.
4. **Ephemeral container** — disposable; `devclaw down && devclaw up` = clean slate.

Warn the user that: OpenClaw runs **arbitrary code** and is susceptible to **prompt
injection** (don't run it on a work laptop — that's the whole point of this template);
only install **trusted skills**; **don't paste highly sensitive data** (it flows
through the model endpoint); the container runs as **root** (harden for production).

---

## Destructive-action policy (always follow)

Before running any of these, **state what will be deleted and ask the user to confirm**:
- `devclaw down` / `azd down --purge` (deletes the whole resource group)
- `az ad app delete` (removes the Bot / browser-auth / legacy Easy Auth app registrations)
- removing role assignments, or `rm -rf .azure*` / state files

Never use `--no-prompt`/`--force` to skip a confirmation the user hasn't given.
