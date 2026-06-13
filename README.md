<!--
---
page_type: sample
languages:
- javascript
products:
- azure-openai
- azure
urlFragment: openclaw-dev
name: openclaw-dev
description: Deploy OpenClaw with Azure OpenAI using one CLI command. Chat in the browser by default; optionally add Microsoft Teams to use it from your phone.
---
-->
# 🦞 openclaw-dev on Azure

A small dev tool that deploys [OpenClaw](https://github.com/openclaw/openclaw) to an ephemeral cloud sandbox you can chat with from the browser — always on, isolated from your laptop, reachable from any device. Uses Azure OpenAI in Foundry Models for the backend (default `gpt-5-mini`). **Default deployment target is ACA Sandbox** (isolated Linux VMs via custom disk image). For compatibility with storage state persistence and Teams integration, a **standard Azure Container Apps** option is also available. Microsoft Teams is an optional add-on.

> **Just want OpenClaw on your Windows machine?** Use [Microsoft Execution Containers (MXC)](https://github.com/microsoft/mxc) — a policy-driven runtime that contains the OpenClaw node + gateway on Windows, [announced at Build 2026](https://blogs.windows.com/windowsdeveloper/2026/06/02/build-2026-furthering-windows-as-the-trusted-platform-for-development/). This repo is for the **cloud** path: when you want an always-on, multi-device, throwaway sandbox instead.

Short link: <https://aka.ms/openclaw-dev>

<a id="alpha"></a>

> **⚠️ Alpha.** This is a developer tool with no production guarantees. Read [Security](#security) before pasting anything sensitive.

![openclaw architecture](docs/architecture.svg)

The idea: an ephemeral cloud sandbox for OpenClaw — gated by your Microsoft sign-in, calling the model with no API keys, always reachable from your phone, and rebuildable in 6 minutes. Local execution on Windows is already covered by [MXC](https://github.com/microsoft/mxc); this template is for when you want the cloud shape.

→ Jump to: [Quick start](#quick-start) · [Optional: Microsoft Teams](#teams-setup) · [Security](#security) · [Architecture](#architecture) · [Alpha caveats](#alpha) · [Ask Copilot](#need-help-ask-copilot)

## Quick start

### Prerequisites

- [Azure CLI](https://aka.ms/install-azure-cli) + [Azure Developer CLI](https://aka.ms/azd-install)
- An Azure subscription ([free](https://azure.microsoft.com/free)) and tenant where you can create one Entra ID app registration for the sandbox browser-login proxy. A second Bot app registration is only created if you opt into the [Teams add-on](#teams-setup).
- Either local [Docker Desktop](https://www.docker.com/products/docker-desktop/) running **or** use the default `remoteBuild: true` in [azure.yaml](azure.yaml) (no local Docker needed; ACR builds the image)
- PowerShell 7+ (`pwsh`) if you're on Windows and plan to use the optional Teams add-on (used to build the Teams sideload zip)

### Deploy

```bash
git clone https://github.com/microsoft/openclaw-dev
cd openclaw-dev

# macOS/Linux/WSL
./devclaw up

# Windows (cmd or PowerShell)
.\devclaw.cmd up
```

`devclaw up` provisions the baseline Azure resources for ACA Sandbox deployment, including the Entra app registration used by the in-sandbox OIDC browser-login proxy. `devclaw sandbox build` then builds the disk image, creates the sandbox runtime, exposes an **anonymous** ACA sandbox public port, and lets the in-app proxy own login/callback/session handling. For **standard Azure Container Apps** (legacy, storage-persistent), use `azd env set ACA_SANDBOX_MODE standard` before `devclaw up`. You may also optionally enable **Express mode** for faster cold-start with `azd env set USE_EXPRESS_ENV true` when using standard mode.

### Disk image provisioning (required for Sandbox)

⚠️ **Current state:** Sandbox disk registration is **CI-first** and image-driven. `devclaw sandbox build` (or the Phase 3 workflow) first generates `src/squad-runtime/runtime-bundle.json` from the authoritative Squad sources, then builds `src/Dockerfile.sandbox` in ACR using **`src/` as the build context**, and finally registers that image as an ACA Sandbox disk using short-lived ACR tokens (no local Docker/qemu fallback).

ACR auth for private-image disk registration is deterministic: `scripts/register-sandbox-disk.py` automatically runs `az acr login --expose-token` and passes the ephemeral token to `aca sandboxgroup disk create`.

**Recommended path (CI-first):**

```bash
devclaw sandbox build
```

That remotely builds the sandbox runtime image in ACR, registers the disk in the sandbox group, creates the sandbox from it, exposes the public port anonymously, applies the in-app browser allowlist, and validates the Entra OIDC login redirect.

**Bring your own CI-built image (optional):**

```bash
azd env set SANDBOX_SOURCE_IMAGE <acr-login-server>/openclaw-azure/openclaw-sandbox-core:<tag>
devclaw sandbox build
```

`devclaw sandbox build` will use `SANDBOX_SOURCE_IMAGE` directly and skip the image build step.

### Sandbox runtime startup contract (to avoid 502 / platform 401)

`src/Dockerfile.sandbox` must include:
- `/opt/entrypoint.sh` as the entrypoint
- `gateway-proxy.mjs` listening on `:18789`
- OpenClaw gateway on internal `:18788` (started by entrypoint)
- an app-owned Entra OIDC layer in `gateway-proxy.mjs` that owns browser login, callback, session cookies, and WebSocket gating
- the generated Squad runtime payload under `src/squad-runtime/runtime-bundle.json` plus `seed-squad-runtime.mjs`, so the durable sandbox image carries the hosted Squad projection without widening Docker build context beyond `src/`

**Current ACA Sandbox limitation:** the platform does **not** reliably auto-run the image entrypoint after `aca sandbox create`, so `devclaw sandbox build` explicitly bootstraps `/opt/entrypoint.sh` with `aca sandbox exec` after sandbox creation. The same flow also passes the browser allowlist (`BROWSER_AUTH_ALLOWED_USERS` and optional `BROWSER_AUTH_ALLOWED_OBJECT_IDS`) into the sandbox and validates:
- `GET /healthz` → `200`
- `GET /` → `302 /oidc/login?...`
- `GET /oidc/login` → `302 https://login.microsoftonline.com/...`

Post-create verification command:

```bash
aca sandbox exec --group <sg-name> -l app=openclaw,env=<env> -c "node -e \"const http=require('http');http.get('http://127.0.0.1:18789',res=>{const c=res.statusCode||0;console.log('gateway-status='+c);process.exit(c>=200&&c<500?0:1)}).on('error',e=>{console.error(e.message);process.exit(2)});\""
```

**Fallback to standard ACA:** If you don't have a custom disk image yet, you can revert to standard Container Apps (storage-persistent, no disk provisioning needed):

```bash
azd env set ACA_SANDBOX_MODE standard
./devclaw up
```

### Multi-squad orchestration

Use `devclaw squad` helpers to manage independent `azd` environments per squad:

```bash
devclaw squad init alpha eastus2 eastus2  # creates/selects squad-alpha + sets locations
devclaw squad use alpha                    # switches active env (accepts alpha or squad-alpha)
devclaw squad select alpha                 # alias of `use`
devclaw squad current                      # prints the active environment
devclaw squad list                         # lists all environments
devclaw squad status alpha                 # run status against alpha without changing context
devclaw squad deploy alpha                 # deploy only alpha (same for up/start/stop/logs/down/teams)
```

Each squad environment maps to its own `rg-<env-name>` deployment, so squads can
deploy, scale, stop, and restart independently. Squad-scoped wrappers temporarily
select the target env, run the command, then restore your prior env selection.

### Verify

```bash
devclaw status   # Container state, FQDN, RG
devclaw logs     # Tail logs until you see `[gateway] starting HTTP server`
```

`devclaw test` only prints a hint that points you at the in-container console. It does not exercise the model end-to-end. The fastest real smoke test is the WebChat UI below.

For Phase 1-2 sandbox QA checks (smoke + fallback/regression assertions), run:

```powershell
.\scripts\qa\phase12-smoke.ps1 -Mode All
```

### Open the WebChat UI

After sandbox deployment, open the URL printed by `devclaw sandbox build` (or `azd env get-value PUBLIC_BASE_URL`) in your browser. The sandbox public port is anonymous at the platform layer, but the in-app OIDC proxy immediately redirects the browser to Microsoft sign-in and then returns to the WebChat UI with an HttpOnly session cookie.

After sign-in, the default agent is **Squad**. The hosted runtime now derives that experience from a **generated runtime bundle** built from the repo's authoritative Squad sources (contract, roster, routing, charter summaries, and RAI policy), so the Control UI callout and Agents view reflect the actual Squad contract without exposing raw mutable Squad state in the hosted runtime.

### Hosted GitHub / MCP caveats

- Hosted GitHub issue/backlog features only work through bridges that are already present in the deployment: GitHub MCP when explicitly configured with a reviewed server package, or `gh` when the runtime has a `GH_TOKEN` / `GITHUB_TOKEN`.
- The built-in OpenClaw `/skills` GitHub card is a separate hosted surface from repo MCP config. It is only unblocked when `gh` is on PATH. This image now installs `gh`, symlinks it into `/usr/local/bin/gh`, and patches the bundled skill so Linux-hosted runtimes prefer apt guidance instead of a misleading brew button.
- If that built-in `/skills` card still reports `bin:gh` while `gh` is already present, treat it as stale requirement-detection / skills-snapshot state. The image now patches OpenClaw's skills refresh module so persisted sessions re-evaluate skill requirements on each runtime boot.
- Exact config split: repo-level `.mcp.json` remains `squad_state`-only, while `.copilot/mcp-config.json` ships the hosted GitHub `github` bridge wrapper (`scripts/github-mcp-bridge.mjs`).
- When `GITHUB_TOKEN` / `GH_TOKEN` / provider token is present, that Copilot-side wrapper launches the configured, reviewed GitHub MCP server package; when no token bridge exists it degrades to a status-only MCP tool instead of silently implying GitHub capability.
- In ACA Sandbox custom images, attaching a `github-copilot` credential alone does **not** currently surface auth inside the runtime. Keep `SANDBOX_GITHUB_COPILOT_PAT` set when you run `devclaw sandbox build` / `upload` if you want non-interactive `gh` auth in hosted sessions.
- Standard Container Apps mode now includes the `gh` binary and can accept an optional secret-backed `GITHUB_TOKEN` bridge via `azd env set GITHUB_TOKEN <token>` before `devclaw up` / `devclaw deploy`. That token is exposed to the runtime as both `GITHUB_TOKEN` and `GH_TOKEN`.
- Hosted runtime boot now forces `GH_PROMPT_DISABLED=1`; interactive `gh auth login` is not a supported auth path there. Use `GH_TOKEN`, `GITHUB_TOKEN`, provider token, or an explicitly mounted `GH_CONFIG_DIR` instead.
- `src/openclaw.json` currently enables only the `msteams` plugin path, so hosted GitHub/MCP behavior is delivered through projected workspace docs/skills plus external bridges, not an OpenClaw plugin.
- Skills that depend on Copilot CLI session history, VS Code subagents, git worktrees, shell-profile mutation, or local MCP config files are projected as guidance only in the hosted runtime; use a repo-connected CLI or VS Code session for those flows.

<a id="teams-setup"></a>
## Optional: Microsoft Teams add-on

Microsoft Teams is **not** set up by default — `devclaw up` only provisions the
browser experience (Sandbox + in-app Entra OIDC login by default; Easy Auth only on the legacy standard Container Apps path). The Teams add-on adds a
second Entra ID app registration (for the bot), an Azure Bot resource, and the
Teams channel. Keep it off if your tenant blocks bot app registrations or you
don't need phone access.

### Enable Teams

```bash
# Opt in once, then run devclaw teams. It will re-provision and build the
# sideload zip in one go.
azd env set ENABLE_TEAMS true
devclaw teams
```

`devclaw teams` will, on first run:
- Re-provision so the preprovision hook creates the bot Entra ID app + Azure Bot
- Redeploy the container app so the `MSTEAMS_*` env vars take effect
- Enable the Microsoft Teams channel on the bot
- Build a sideloadable Teams app package (`teams/openclaw-teams-app.zip`)

On subsequent runs it just refreshes the channel + zip.

### Install in Teams

1. Teams → **Apps** → **Manage your apps** → **Upload a custom app**
2. Select `teams/openclaw-teams-app.zip`
3. **Add** → DM the bot to test

### Tenant policy considerations

Some corporate tenants block `az ad app credential reset` (the secret-creation
step) or require a `serviceManagementReference` on new app registrations. If
the preprovision hook fails when you set `ENABLE_TEAMS=true`, your tenant is
restricted; leave Teams off and use the browser experience instead, or create
the bot app registration manually and set `BOT_APP_ID`, `BOT_APP_SECRET`,
and `BOT_TENANT_ID` via `azd env set` before running `devclaw teams`.

## Restricted subscriptions / tenants

If your subscription or tenant has Azure Policy assignments that block common
defaults (large corporate tenants/subscriptions are a common example), set these
**before** `devclaw up`:

```bash
# Required service-management-reference GUID on every new app registration
# (set by some corporate tenants). Get the right value from your tenant admin.
azd env set SERVICE_MANAGEMENT_REFERENCE <your-smr-guid>

# Azure Policy blocks shared-key storage. ACA file mounts need shared keys
# today, so skip the storage account + Azure Files volume mount.
# Trade-off: gateway token + sessions don't persist across replica restarts.
azd env set SKIP_STORAGE true

# Leave Teams off (default already) — bot secret creation is blocked.
# If you need Teams, supply a pre-created bot app reg:
#   azd env set BOT_APP_ID <id>
#   azd env set BOT_APP_SECRET <secret>
#   azd env set BOT_TENANT_ID <tenant>
#   azd env set ENABLE_TEAMS true
```

You don't need a separate `SKIP_BOT_REGISTRATION` flag — Teams is already
off by default. Other policies handled automatically: ACR admin is disabled
out of the box (the container app pulls images via its system-assigned
managed identity).

## Multi-squad scaled deployments

You can run multiple isolated OpenClaw squads by using separate azd environments
and setting squad/scaling env vars before `devclaw up`:

```bash
azd env set SQUAD_NAME alpha
azd env set SQUAD_INSTANCE 1
azd env set OPENCLAW_MIN_REPLICAS 1
azd env set OPENCLAW_MAX_REPLICAS 3
devclaw up
```

Isolation model:
- Resource names are derived from env + squad inputs (no collisions across squads)
- ACA/ACR/Storage/Log Analytics/Bot resources are tagged with squad identity
- Azure Files share is squad-specific (`openclaw-<squad>-<instance>-state`)
- Runtime receives `OPENCLAW_SQUAD_NAME`, `OPENCLAW_SQUAD_INSTANCE`, and `OPENCLAW_SQUAD_KEY`

`devclaw start` restores configured `OPENCLAW_MIN_REPLICAS`/`OPENCLAW_MAX_REPLICAS`
instead of forcing `1/1`, so scaled squads resume at intended capacity.

<details>
<summary>How the Teams integration works (deep dive)</summary>

The Teams channel is handled by **`@openclaw/msteams`**, an external OpenClaw plugin installed at container-build time. It opens its own Express server on `:3978` for the Bot Framework webhook (`/api/messages`). Because ACA exposes only a single public port, [src/gateway-proxy.mjs](src/gateway-proxy.mjs) listens on `:18789` and routes `/api/messages` to the plugin and everything else to the OpenClaw gateway.

The plugin must be **explicitly activated** in [src/openclaw.json](src/openclaw.json); `channels.msteams.enabled: true` alone is not enough for external (non-bundled) plugins. The repo ships with the required block already in place:

```json
"plugins": {
  "enabled": true,
  "allow": ["msteams"],
  "entries": { "msteams": { "enabled": true } }
}
```

If you ever see startup logs like `[gateway] http server listening (N plugins: …)` **without** `msteams` in the list, that block is missing or has been overwritten by a stale state file on Azure Files. The entrypoint restores [src/openclaw.json](src/openclaw.json) from the canonical copy on every boot to prevent this drift.

</details>

## Why

There are now two safe ways to run OpenClaw: on your Windows machine with **[Microsoft Execution Containers (MXC)](https://github.com/microsoft/mxc)**, or in an ephemeral cloud sandbox like this template. They're complementary, not competing — pick the shape that matches what you're trying to do.

Pick **this template** when you want:

- 🌐 **Always on, reachable from anywhere.** Phone, tablet, a teammate's laptop — anything with a browser and your Microsoft sign-in. Works from Teams too.
- 🧪 **Full isolation from your machine.** Runtime, skills, and state live in a separate Azure subscription with no path back to your laptop, your credentials, or your local network. Useful when you're poking at untrusted skills or want a clean blast radius.
- 🔒 **Only people you let in can chat with it.** Microsoft sign-in via Entra ID, scoped to your tenant.
- 🗝️ **No model API keys.** A managed identity calls the model. Local auth is disabled at the model account, so model keys don't exist.
- ♻️ **Wipe and rebuild in ~6 minutes.** `devclaw down && devclaw up` gives you a clean slate.
- 💤 **Pause to $0.** `devclaw stop` scales to zero replicas; state is kept.

Pick **[MXC](https://github.com/microsoft/mxc)** when you want OpenClaw running locally on Windows under policy-driven OS-enforced containment ([announced at Build 2026](https://blogs.windows.com/windowsdeveloper/2026/06/02/build-2026-furthering-windows-as-the-trusted-platform-for-development/) — node + gateway run contained, with a companion Windows app for setup). It's the right pick for fully on-device work and zero-cloud-cost iteration.

| | Windows + MXC | This template (cloud) |
|---|---|---|
| **Where it runs** | On your Windows machine, contained by MXC | Azure Container Apps, in a separate subscription |
| **Isolation model** | OS-enforced policy sandbox | Whole separate environment |
| **Reach** | Your machine only | Browser + Teams from any device |
| **Always on** | Only when your machine is on | 24/7 (or `devclaw stop` = $0) |
| **Nuke & pave** | Reset the container | `devclaw down && devclaw up` (~6 min) |
| **Cost** | Your hardware | ~$2-5/day running, $0 stopped |
| **Model auth** | However you wire it up | Managed identity, no model API keys |

See [Security](#security) for the full defense-in-depth story.

## Need help? Ask Copilot

This repo ships an **AI agent skill** so any assistant that reads
[`.github/copilot-instructions.md`](.github/copilot-instructions.md) or
[`AGENTS.md`](AGENTS.md) (GitHub Copilot Chat, Claude Code, Cursor, Codex, and
friends) can set up and run everything for you. No need to memorize `azd` env
vars or scroll the troubleshooting tables.

**How to use it:** clone the repo, open it in VS Code with
[GitHub Copilot Chat](https://docs.github.com/copilot) (or your preferred agent),
and just ask. (Already cloned the repo? Your agent picks the skill up
automatically. To add it to a different workspace, run
`npx skills add microsoft/openclaw-dev`.) Try:

- *"Deploy OpenClaw to `eastus2`."*
- *"Connect it to Microsoft Teams so I can use it from my phone."*
- *"Why is `devclaw up` failing?"*
- *"Stop it to save money, then start it again tomorrow."*
- *"Restrict access to just my team."*
- *"Tear it all down cleanly."*

The assistant follows the playbook in
[`skills/openclaw-on-azure/SKILL.md`](skills/openclaw-on-azure/SKILL.md) and the
always-on rules in [`.github/copilot-instructions.md`](.github/copilot-instructions.md).
It uses this repo's own scripts, env-var contract, region list, and error
catalog instead of guessing, and always confirms with you before any destructive
action (`devclaw down`, `az ad app delete`, RBAC removal). The skill follows the
open [Agent Skills](https://agentskills.io/) format, so it works across many
agents.

## CLI reference

```
devclaw up         Deploy OpenClaw to Azure (provision + build + deploy)
devclaw test       Print a hint to run the in-container smoke test
devclaw status     Show container status, FQDN, RG
devclaw logs       Stream live container logs
devclaw start      Scale to configured min/max replicas (resume after stop)
devclaw stop       Scale to 0 replicas ($0, state preserved)
devclaw restart    Restart the active revision
devclaw deploy     Rebuild and deploy after code changes
devclaw teams      Set up Microsoft Teams integration (build sideload zip)
devclaw squad ...  Manage squads + run explicit scoped ops (init/use/select/list/current + up|deploy|status|logs|start|stop|restart|teams|down <squad>)
devclaw down       Delete ALL Azure resources and Entra app regs (nuke & pave)
devclaw login      Switch Azure account
```

## What can I do with this?

Always-on assistant, reachable from Teams on your phone, the WebChat UI, or any OpenClaw channel. Examples:

- Paste a meeting transcript, get action items.
- Paste an email thread, get a draft reply.
- Paste a stack trace, get a diagnosis.
- Paste a GitHub PR link, get review notes.
- Track sessions across the week and get a status summary.

Skills are sandboxed inside the container. Only install ones you trust (see [Security](#security)).

## Security

### Defense in depth

This template applies **five independent layers** of defense, each guarding something different:

| Layer | What it does |
|---|---|
| **1. In-sandbox Entra OIDC proxy** | Browser requests hit an anonymous ACA sandbox port, but `gateway-proxy.mjs` immediately redirects to Microsoft sign-in, validates the tenant/issuer/audience/redirect URI, checks an explicit allowlist, and issues a secure HttpOnly session cookie only for approved principals. |
| **2. OpenClaw trusted-proxy auth** | The browser never receives the OpenClaw gateway token. The proxy injects `x-forwarded-user` and required trusted headers to the internal gateway, which only listens on loopback. |
| **3. Managed Identity (no model API keys)** | The container authenticates to the model endpoint via short-lived Entra ID tokens. `disableLocalAuth: true` means model API keys don't even exist. |
| **4. AOAI content filters (blocking by default)** | The deployed Azure OpenAI RAI policy keeps `Jailbreak` and `Indirect Attack` input detections in blocking mode and keeps standard harm filters enabled for prompt/completion flows. |
| **5. Ephemeral container** | State is on Azure Files; the container itself is disposable. `devclaw down && devclaw up` = clean slate in 6 minutes. |

### What to be aware of

- **Skills run arbitrary code.** A malicious skill can access the managed identity. Only install trusted skills.
- **Prompt injection.** OpenClaw is susceptible. Nuke and repave if behavior changes.
- **Container runs as root.** Add a non-root user for hardened deployments.
- **Conversations flow through the model endpoint.** Don't paste highly sensitive data.

### Browser sign-in

Sandbox mode configures browser sign-in automatically. The preprovision hook creates an Entra app registration for the in-container OIDC proxy, defaults `BROWSER_AUTH_ALLOWED_USERS` to the current deployer account, optionally caches the deployer's object ID in `BROWSER_AUTH_ALLOWED_OBJECT_IDS`, and `devclaw sandbox build` adds the exact `PUBLIC_BASE_URL/oidc/callback` redirect URI once the sandbox URL exists.

To expand access, set a comma-separated allowlist before rebuilding the sandbox runtime:

```bash
azd env set BROWSER_AUTH_ALLOWED_USERS "alice@contoso.com,bob@contoso.com"
devclaw sandbox build
```

To further restrict access to specific users or groups, update the app registration in the Azure Portal:
1. **Azure Portal** → **Entra ID** → **App registrations** → `openclaw-browser-<env>`
2. **Properties** → **Assignment required?** → **Yes**
3. **Enterprise applications** → assign specific users/groups

### Usage guidelines

1. **Don't paste confidential data.** Conversations flow through the configured model endpoint.
2. **Don't install credential-heavy skills.** No email, bank, or internal API skills.
3. **Nuke and pave regularly.** `devclaw down && devclaw up` if anything seems off.
4. **Monitor logs.** `devclaw logs`.

## Architecture

| Resource | Purpose |
|---|---|
| **Azure Container Apps** | Hosts the OpenClaw gateway. Public HTTPS on `:18789`. Ephemeral container (host layer is swappable) |
| **Azure OpenAI in Foundry Models** | LLM backend via the OpenAI-compatible `/openai/v1/` API. Keyless (`disableLocalAuth: true`). Default: `gpt-5-mini`. Azure OpenAI models only today. |
| **Azure Bot Service** | Bot Framework registration that fronts the Teams channel; routes inbound Teams activity to the container's `/api/messages` |
| **Managed Identity** | Container → model auth via short-lived Entra ID tokens |
| **In-sandbox Entra OIDC proxy** | Browser sign-in, callback handling, session cookies, and WebSocket gating. ACA sandbox port is anonymous; `/api/messages` stays on the exact proxy path for Bot Framework when Teams is enabled |
| **Azure Files** | Persists credentials, workspace, sessions across restarts |
| **Container Registry** | Stores the container image |
| **Log Analytics** | Container and gateway logs |

Inside the container there are three Node processes started by [src/entrypoint.sh](src/entrypoint.sh):

| Process | Port | Role |
|---|---|---|
| **gateway-proxy** ([src/gateway-proxy.mjs](src/gateway-proxy.mjs)) | `0.0.0.0:18789` (public) | Terminates ACA ingress; owns Entra OIDC login/callback/session cookies for browser traffic; routes `POST /api/messages` to the msteams plugin on `:3978` and authenticated browser traffic to the OpenClaw gateway on `:18788` |
| **OpenClaw gateway** | `127.0.0.1:18788` | WebChat UI + WebSocket API; runs in `trusted-proxy` mode behind the loopback proxy and loads the msteams plugin which spawns the webhook on `:3978` |
| **auth-proxy** ([src/auth-proxy.mjs](src/auth-proxy.mjs)) | `127.0.0.1:18790` | Injects a fresh Entra ID bearer token from `DefaultAzureCredential` on every forwarded request to AOAI |

```mermaid
graph LR
    User["👤 User<br/>Browser / Mobile"]
    Teams["💬 Microsoft Teams<br/>Bot Framework"]
    BrowserAuth["🔐 Entra OIDC reverse proxy<br/>login + callback + session cookie"]
    subgraph Host["Host (Azure Container Apps today)"]
        Proxy["🔀 gateway-proxy<br/>:18789"]
        GW["🦞 OpenClaw Gateway<br/>:18788 · token auth"]
        MST["📥 @openclaw/msteams<br/>:3978 · /api/messages"]
        Auth["🔑 auth-proxy<br/>:18790 · injects MI bearer"]
    end
    AOAI["Azure OpenAI in Foundry Models<br/>OpenAI-compatible /openai/v1 API<br/>disableLocalAuth: true"]
    MI["Managed Identity<br/>Entra ID token"]
    AF["Azure Files<br/>credentials / workspace / sessions"]

    User -->|"HTTPS"| BrowserAuth
    BrowserAuth -->|"Authenticated session"| Proxy
    Teams -->|"Bot Framework JWT"| Proxy
    Proxy -->|"/api/messages"| MST
    Proxy -->|"trusted-proxy headers"| GW
    MST -->|"channel events"| GW
    GW -->|"OpenAI REST API"| Auth
    Auth -->|"Bearer token"| AOAI
    GW -.->|"Volume mount"| AF
    MI -.->|"RBAC: Cognitive Services User + OpenAI User"| AOAI
```

### SDKs and libraries

All dependencies are pinned at container build time (see [src/Dockerfile](src/Dockerfile)).

| SDK | Version | Role | Notes |
|---|---|---|---|
| **`openclaw`** | `2026.5.26` | The gateway runtime itself. Installed globally via `npm install -g openclaw@2026.5.26` | Pinned in `src/Dockerfile` for deterministic builds |
| **`@openclaw/msteams`** | `2026.5.26` | External OpenClaw plugin that owns the Teams channel: validates Bot Framework JWTs, parses activities, sends replies | Installed via `openclaw plugins install npm:@openclaw/msteams`. Bundles its own copies of the Teams SDKs below |
| **`@microsoft/teams.api`** | `2.0.11` (plugin-bundled) / `2.0.6` (Docker-side compat) | Microsoft's current Teams SDK. REST client for the Bot Connector and Graph surfaces. Successor to the `botbuilder` line | v2.0 line went GA in late 2024; **roughly 12–18 months old** (mid-2024 to May 2026) |
| **`@microsoft/teams.apps`** | `2.0.11` (plugin-bundled) / `2.0.6` (Docker-side compat) | High-level Teams app/agent framework. Message routing, conversation state, adapters. Built on top of `teams.api` | Same generation as `teams.api`; **roughly 12–18 months old** |
| **`@azure/identity`** | `4.13.1` (plugin-bundled + auth-proxy) | Used by the auth-proxy and the msteams plugin for `DefaultAzureCredential` and `getBearerTokenProvider`. Fetches, caches, and refreshes Entra ID tokens for AOAI and Bot Framework | Pinned in `src/Dockerfile` |
| **`http-proxy`** | `1.18.1` (auth-proxy install) | Powers [src/gateway-proxy.mjs](src/gateway-proxy.mjs). Splits ingress by URL path | Pinned in `src/Dockerfile` |

**How AOAI/Foundry is accessed**: OpenClaw speaks the **OpenAI-compatible REST API** under `/openai/v1/...` directly (see [src/openclaw.json](src/openclaw.json) for the configured adapter). It does not depend on the official `openai` npm SDK or the older `@azure/openai` SDK. Requests flow `gateway → auth-proxy → AOAI/Foundry`; the auth-proxy attaches the MI bearer token at the wire level, so AOAI's `disableLocalAuth: true` works without API keys anywhere in the system. The auth-proxy is path-agnostic (it forwards `req.url` as-is), so the same proxy works for any OpenAI-compatible surface (chat, embeddings, audio, images).

**How Teams is accessed**: Inbound activities come in over HTTPS from Bot Framework to `/api/messages`. The `@openclaw/msteams` plugin validates the JWT and uses `@microsoft/teams.api` + `@microsoft/teams.apps` for everything from there: activity dispatch, replies, streaming, adaptive cards.

## Troubleshooting

### Container won't start

| Symptom | Cause | Fix |
|---|---|---|
| `Activating` for >2 min | Token acquisition retrying | Normal. Allows up to 5 min. Check `devclaw logs` |
| `ActivationFailed` | Container crashed | Check Azure Portal → Container App → Log stream |
| `Cannot find module '@buape/carbon'` | Cached broken Docker layer | `docker build --no-cache ./src` then `devclaw deploy` |
| `Config invalid: Unrecognized key` | Old config format | Config must be `{"gateway":{"mode":"local"}}` |
| `azd provision` fails with `Circular dependency detected on resource ... containerApps` | Old `aca.bicep` with `existing` self-reference | Pull latest. The template now uses a `containerImage` parameter sourced from `SERVICE_OPENCLAW_IMAGE_NAME` |

### Auth issues

| Symptom | Cause | Fix |
|---|---|---|
| `401 invalid issuer` | RBAC not propagated | Wait 5 min. Verify: `az role assignment list --assignee <principal-id> --all` |
| Token retries failing | IMDS slow to initialize | Normal. Retries for 60s |
| `disableLocalAuth` blocks `list-keys` | By design | Expected. Managed identity only |

### Gateway issues

| Symptom | Cause | Fix |
|---|---|---|
| HTTP 500 on all routes | Missing plugin deps | Rebuild with `docker build --no-cache ./src` |
| `pairing required` | Missing `dangerouslyDisableDeviceAuth` or `trustedProxies` in config | Ensure `src/openclaw.json` has both settings (see repo) |
| `Proxy headers detected from untrusted address` | Reverse proxy not trusted | Add `gateway.trustedProxies` with your proxy CIDRs |
| WebChat shows login screen | Token not injected | Check `entrypoint.sh` runs successfully. See `devclaw logs` |

### Teams / msteams plugin issues

| Symptom | Cause | Fix |
|---|---|---|
| `POST /api/messages` returns **502** | msteams plugin didn't load → nothing listening on `:3978` | Confirm `plugins.entries.msteams.enabled: true` and `plugins.allow: ["msteams"]` are present in `src/openclaw.json`, then `devclaw deploy`. Look for `[gateway] http server listening (… msteams …)` in `devclaw logs` |
| `POST /api/messages` returns **401** with `{"error":"Unauthorized"}` | Working as designed. Bot Framework JWT auth is rejecting the unsigned curl request | None. Real Teams traffic carries a valid bearer token and is accepted |
| Diagnostic block in logs says `@openclaw/msteams package: MISSING` | `openclaw plugins install npm:@openclaw/msteams` failed during the Docker build | Rebuild with `docker build --no-cache ./src` and check the build output |
| Bot replies in WebChat but not in Teams | Teams channel not enabled on Azure Bot, or sideload uses wrong `botId` | Re-run `devclaw teams` (re-enables the channel and rebuilds the zip with the current bot app id) |
| `[gateway] http server listening (7 plugins: browser, canvas, …)` with no `msteams` | Plugin activation rule not met (see "How the Teams integration works" above) | Verify the `plugins` block in `src/openclaw.json` matches the canonical copy shipped in the repo |

### CLI issues

| Symptom | Cause | Fix |
|---|---|---|
| `az containerapp exec` crashes | Azure CLI Unicode bug (🦞) | Use Azure Portal Console instead |
| `az containerapp logs` hangs | SSL issue | Use Azure Portal Log stream |
| `azd up` warns about permissions | azd heuristic | Safe to proceed. Or add `User Access Administrator` role |

### Testing the model endpoint directly

The deployed model is reachable via the OpenAI-compatible `/openai/v1/` API:

```bash
TOKEN=$(az account get-access-token --resource "https://cognitiveservices.azure.com" --query accessToken -o tsv)
ENDPOINT=$(az cognitiveservices account list -g <rg> --query "[0].properties.endpoint" -o tsv)

curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Hello"}]}' \
  "$ENDPOINT/openai/v1/chat/completions"
```

## Clean up

```bash
devclaw down    # Destroys ALL resources
```
