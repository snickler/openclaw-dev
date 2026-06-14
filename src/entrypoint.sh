#!/bin/bash
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin:${PATH:-}"

echo "[openclaw] Starting..."
echo "[openclaw] OpenClaw version: $(openclaw --version 2>&1)"
echo "[openclaw] Auth mode: ${AZURE_OPENAI_AUTH:-api-key}"
echo "[openclaw] OPENAI_BASE_URL: ${OPENAI_BASE_URL}"
if [ -n "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    export GITHUB_TOKEN="${GH_TOKEN}"
fi
if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
    export GH_TOKEN="${GITHUB_TOKEN}"
fi
export GIT_TERMINAL_PROMPT=0
export GH_PROMPT_DISABLED="${GH_PROMPT_DISABLED:-1}"
export GH_CONFIG_DIR="${GH_CONFIG_DIR:-/root/.config/gh}"
mkdir -p "$GH_CONFIG_DIR"
if [ -n "${GH_TOKEN:-}" ]; then
    GH_HOSTS_FILE="$GH_CONFIG_DIR/hosts.yml"
    if [ ! -s "$GH_HOSTS_FILE" ] || ! grep -q '^github.com:' "$GH_HOSTS_FILE" 2>/dev/null; then
        umask 077
        cat > "$GH_HOSTS_FILE" <<EOF
github.com:
    git_protocol: https
    oauth_token: ${GH_TOKEN}
EOF
        echo "[openclaw] GitHub token bridge written to GH_CONFIG_DIR/hosts.yml for non-interactive gh auth"
    fi
fi
echo "[openclaw] PATH: ${PATH}"
for bin in gh git jq; do
    if command -v "$bin" >/dev/null 2>&1; then
        echo "[openclaw] $bin available at: $(command -v "$bin")"
    else
        echo "[openclaw] WARNING: required hosted GitHub helper missing from PATH: $bin"
    fi
done
OPENCLAW_CONFIG_EVAL="$(find /usr/local/lib/node_modules/openclaw/dist -maxdepth 1 -name 'config-eval-*.js' | head -n 1 || true)"
if [ -n "${OPENCLAW_CONFIG_EVAL:-}" ]; then
    node --input-type=module -e "import { pathToFileURL } from 'node:url'; const mod = await import(pathToFileURL(process.argv[1]).href); const hasBinary = mod.n ?? mod.hasBinary; if (typeof hasBinary !== 'function') { console.log('[openclaw] WARNING: OpenClaw hasBinary export not found'); process.exit(0); } console.log('[openclaw] OpenClaw hasBinary(gh): ' + String(hasBinary('gh'))); console.log('[openclaw] OpenClaw hasBinary(git): ' + String(hasBinary('git'))); console.log('[openclaw] OpenClaw hasBinary(jq): ' + String(hasBinary('jq')));" "${OPENCLAW_CONFIG_EVAL}" || echo "[openclaw] WARNING: OpenClaw hasBinary self-check failed"
fi
if command -v gh >/dev/null 2>&1; then
    echo "[openclaw] gh version: $(gh --version 2>/dev/null | head -n 1)"
    if [ -n "${GH_TOKEN:-}" ]; then
        echo "[openclaw] GitHub token bridge detected — configuring gh/git credential helper"
        gh auth setup-git >/proc/1/fd/1 2>/proc/1/fd/2 || echo "[openclaw] WARNING: gh auth setup-git failed"
    else
        echo "[openclaw] GitHub token bridge not configured"
    fi
fi

# When SKIP_STORAGE=true (Azure Policy blocks shared-key access on storage),
# /mnt/state is not mounted. Fall back to an in-container ephemeral path so
# the rest of the script (state restore + token persist) doesn't fail. State
# will not survive a replica restart in that mode — documented trade-off.
if [ ! -d /mnt/state ]; then
    echo "[openclaw] /mnt/state not mounted — using ephemeral /var/openclaw-state (no persistence across restarts)"
    mkdir -p /var/openclaw-state
    ln -sfn /var/openclaw-state /mnt/state
fi

# Restore state
for dir in credentials workspace sessions; do
    if [ -d "/mnt/state/$dir" ] && [ "$(ls -A /mnt/state/$dir 2>/dev/null)" ]; then
        mkdir -p "/root/.openclaw/$dir"
        cp -r "/mnt/state/$dir/"* "/root/.openclaw/$dir/" 2>/dev/null || true
    fi
done

# Canonical config (prevents stale config from Azure Files)
cp -f /opt/openclaw.json.canonical /root/.openclaw/openclaw.json

# Substitute env vars in config
sed -i "s|\${OPENAI_BASE_URL}|${OPENAI_BASE_URL}|g" /root/.openclaw/openclaw.json
sed -i "s|\${MSTEAMS_APP_ID}|${MSTEAMS_APP_ID}|g" /root/.openclaw/openclaw.json
sed -i "s|\${MSTEAMS_APP_PASSWORD}|${MSTEAMS_APP_PASSWORD}|g" /root/.openclaw/openclaw.json
sed -i "s|\${MSTEAMS_TENANT_ID}|${MSTEAMS_TENANT_ID}|g" /root/.openclaw/openclaw.json

# Teams is opt-in. When MSTEAMS_APP_ID is empty the deployment was provisioned
# without a Bot app registration (no `ENABLE_TEAMS=true`), so disable the
# msteams plugin in the canonical config to avoid noisy Bot Framework auth
# attempts against empty credentials.
if [ -z "${MSTEAMS_APP_ID:-}" ]; then
    echo "[openclaw] MSTEAMS_APP_ID not set — disabling msteams plugin (Teams opt-in)"
    node -e "const fs=require('fs');const p='/root/.openclaw/openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));if(c.channels&&c.channels.msteams){c.channels.msteams.enabled=false;}if(c.plugins){c.plugins.allow=(c.plugins.allow||[]).filter(x=>x!=='msteams');if(c.plugins.entries&&c.plugins.entries.msteams){c.plugins.entries.msteams.enabled=false;}}fs.writeFileSync(p,JSON.stringify(c,null,2));"
fi

CONTROL_UI="/usr/local/lib/node_modules/openclaw/dist/control-ui/index.html"
if [ -f "$CONTROL_UI" ]; then
    node -e "const fs=require('fs');const p=process.argv[1];let s=fs.readFileSync(p,'utf8');s=s.replace(/<script>if\\(!location\\.hash\\.includes\\('token='\\)\\)\\{location\\.hash='token=[^']*';\\}<\\/script>/g,'');fs.writeFileSync(p,s);" "$CONTROL_UI"
fi

if [ -f /opt/openclaw-auth/seed-squad-runtime.mjs ] && [ -d /opt/openclaw-squad ]; then
    echo "[openclaw] Seeding Squad runtime workspaces and agent roster"
    node /opt/openclaw-auth/seed-squad-runtime.mjs \
        --state-root /root/.openclaw \
        --config /root/.openclaw/openclaw.json \
        --seed-dir /opt/openclaw-squad \
        --control-ui "$CONTROL_UI"
fi

if command -v gh >/dev/null 2>&1; then
    echo "[openclaw] Built-in /skills github prerequisite satisfied: $(command -v gh)"
    if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
        echo "[openclaw] GitHub bridge: gh installed with token env available for hosted GitHub flows"
    else
        echo "[openclaw] GitHub bridge: gh installed but no GH_TOKEN/GITHUB_TOKEN detected (built-in github skill can read public data only unless a token bridge is provisioned)"
    fi
else
    echo "[openclaw] GitHub bridge: gh not installed in this image (built-in /skills github skill will be blocked)"
fi

BROWSER_AUTH_ENABLED=false
if [ "${BROWSER_AUTH_MODE:-}" = "entra-oidc-proxy" ] || [ -n "${BROWSER_AUTH_CLIENT_ID:-}" ] || [ -n "${BROWSER_AUTH_TENANT_ID:-}" ] || [ -n "${BROWSER_AUTH_SESSION_SECRET:-}" ]; then
    BROWSER_AUTH_ENABLED=true
fi

if [ "$BROWSER_AUTH_ENABLED" = "true" ]; then
    export BROWSER_AUTH_MODE="entra-oidc-proxy"
    PUBLIC_PORT="${OPENCLAW_PUBLIC_PORT:-18789}"
    if [ -z "${PUBLIC_BASE_URL:-}" ] && [ -n "${ADC_SANDBOX_ID:-}" ] && [ -n "${SANDBOX_REGION:-}" ]; then
        export PUBLIC_BASE_URL="https://${ADC_SANDBOX_ID}--${PUBLIC_PORT}.${SANDBOX_REGION}.adcproxy.io"
        echo "[openclaw] Derived PUBLIC_BASE_URL from sandbox metadata: ${PUBLIC_BASE_URL}"
    fi
    if [ -z "${PUBLIC_BASE_URL:-}" ] || [ -z "${BROWSER_AUTH_CLIENT_ID:-}" ] || [ -z "${BROWSER_AUTH_TENANT_ID:-}" ] || [ -z "${BROWSER_AUTH_SESSION_SECRET:-}" ]; then
        echo "[openclaw] ERROR: Browser OIDC auth is enabled but required settings are missing."
        echo "[openclaw] Required: PUBLIC_BASE_URL, BROWSER_AUTH_CLIENT_ID, BROWSER_AUTH_TENANT_ID, BROWSER_AUTH_SESSION_SECRET"
        exit 1
    fi
    if [ -z "${BROWSER_AUTH_ALLOWED_USERS:-}" ] && [ -z "${BROWSER_AUTH_ALLOWED_OBJECT_IDS:-}" ] && [ -z "${BROWSER_AUTH_ALLOWED_PRINCIPALS:-}" ]; then
        echo "[openclaw] ERROR: Browser OIDC auth requires an allowlist."
        echo "[openclaw] Required: BROWSER_AUTH_ALLOWED_USERS and/or BROWSER_AUTH_ALLOWED_OBJECT_IDS"
        exit 1
    fi
    if ! PUBLIC_BASE_ORIGIN="$(node -e "const u=new URL(process.argv[1]);if(u.protocol!=='https:'){process.exit(2)}console.log(u.origin)" "$PUBLIC_BASE_URL" 2>/dev/null)"; then
        echo "[openclaw] ERROR: PUBLIC_BASE_URL must be a valid https URL"
        exit 1
    fi
    export PUBLIC_BASE_ORIGIN
    export BROWSER_AUTH_ISSUER="https://login.microsoftonline.com/${BROWSER_AUTH_TENANT_ID}/v2.0"
    export BROWSER_AUTH_AUTHORIZATION_ENDPOINT="https://login.microsoftonline.com/${BROWSER_AUTH_TENANT_ID}/oauth2/v2.0/authorize"
    export BROWSER_AUTH_JWKS_URI="https://login.microsoftonline.com/${BROWSER_AUTH_TENANT_ID}/discovery/v2.0/keys"
    BROWSER_AUTH_JWKS_CACHE_PATH="/root/.openclaw/browser-oidc-jwks.json"
    BROWSER_AUTH_JWKS_PREFETCH_OK=false
    for attempt in 1 2 3; do
        if node -e "const fs=require('fs');const out=process.argv[1];(async()=>{const response=await fetch(process.env.BROWSER_AUTH_JWKS_URI,{headers:{Accept:'application/json'}});if(!response.ok){throw new Error('jwks fetch failed ('+response.status+')');}const jwks=await response.json();fs.writeFileSync(out,JSON.stringify(jwks));})().catch(err=>{console.error(err?.message||err);process.exit(1)});" "$BROWSER_AUTH_JWKS_CACHE_PATH"; then
            export BROWSER_AUTH_JWKS_PATH="$BROWSER_AUTH_JWKS_CACHE_PATH"
            BROWSER_AUTH_JWKS_PREFETCH_OK=true
            echo "[openclaw] Prefetched Microsoft Entra signing keys"
            break
        fi
        echo "[openclaw] WARNING: Microsoft Entra signing key prefetch attempt ${attempt}/3 failed"
        if [ "$attempt" -lt 3 ]; then
            sleep "$attempt"
        fi
    done
    if [ "$BROWSER_AUTH_JWKS_PREFETCH_OK" != "true" ]; then
        rm -f "$BROWSER_AUTH_JWKS_CACHE_PATH" 2>/dev/null || true
        unset BROWSER_AUTH_JWKS_PATH
        echo "[openclaw] WARNING: Failed to prefetch Microsoft Entra signing keys; continuing with live JWKS fetch"
    fi
    echo "[openclaw] Browser auth boundary: in-sandbox Entra OIDC reverse proxy"
    echo "[openclaw] Browser origin allowlist: ${PUBLIC_BASE_ORIGIN}"
    echo "[openclaw] Browser principal allowlist configured"
    node -e "const fs=require('fs');const p='/root/.openclaw/openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.gateway=c.gateway||{};c.gateway.trustedProxies=['127.0.0.1','::1'];c.gateway.auth={mode:'trusted-proxy',trustedProxy:{userHeader:'x-forwarded-user',requiredHeaders:[],allowLoopback:true}};c.gateway.controlUi={...(c.gateway.controlUi||{}),allowedOrigins:[process.env.PUBLIC_BASE_ORIGIN],dangerouslyAllowHostHeaderOriginFallback:false,dangerouslyDisableDeviceAuth:true};fs.writeFileSync(p,JSON.stringify(c,null,2));"
else
    # Gateway token for auth (used by both --token flag and SPA auto-connect).
    # Persist across container restarts via /mnt/state so the Control UI in the
    # browser doesn't drift out of sync after every deploy. Precedence:
    #   1. OPENCLAW_GATEWAY_TOKEN env var (if set)
    #   2. Existing token on persistent volume
    #   3. Generate fresh and persist
    TOKEN_FILE="/mnt/state/gateway-token"
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN}"
        echo "[openclaw] Using gateway token from env"
    elif [ -s "$TOKEN_FILE" ]; then
        GATEWAY_TOKEN="$(cat "$TOKEN_FILE")"
        echo "[openclaw] Loaded persisted gateway token"
    else
        GATEWAY_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
        mkdir -p "$(dirname "$TOKEN_FILE")"
        printf '%s' "$GATEWAY_TOKEN" > "$TOKEN_FILE"
        echo "[openclaw] Generated and persisted new gateway token"
    fi

    # Inject token into URL hash BEFORE any SPA scripts load.
    # The SPA reads #token=<value>, saves it to settings, and auto-connects.
    if [ -f "$CONTROL_UI" ]; then
        sed -i "0,/<script>/s//<script>if(!location.hash.includes('token=')){location.hash='token=${GATEWAY_TOKEN}';}<\/script><script>/" "$CONTROL_UI"
        echo "[openclaw] Injected auto-connect token into control UI HTML"
    fi
fi

echo "[openclaw] Config loaded (details redacted from logs)"

# -----------------------------------------------------------------------------
# Diagnostics: prove the msteams plugin was installed at build time and is
# discoverable at runtime. These are one-shot, fail-fast checks; their output
# is essential for debugging silent plugin-load failures in Teams setup.
# -----------------------------------------------------------------------------
echo "[openclaw] === Plugin install diagnostics ==="
if [ -d /root/.openclaw/npm/node_modules/@openclaw/msteams ]; then
    echo "[openclaw] @openclaw/msteams package: PRESENT at /root/.openclaw/npm/node_modules/@openclaw/msteams"
    if [ -f /root/.openclaw/npm/node_modules/@openclaw/msteams/package.json ]; then
        echo "[openclaw] msteams version: $(node -e "console.log(require('/root/.openclaw/npm/node_modules/@openclaw/msteams/package.json').version)" 2>/dev/null || echo unknown)"
    fi
else
    echo "[openclaw] @openclaw/msteams package: MISSING"
fi
if [ -f /root/.openclaw/plugins/installs.json ]; then
    echo "[openclaw] installs.json: PRESENT ($(wc -c < /root/.openclaw/plugins/installs.json) bytes)"
    echo "[openclaw] installs.json content:"
    cat /root/.openclaw/plugins/installs.json 2>&1 | sed 's/^/[openclaw installs]   /'
else
    echo "[openclaw] installs.json: MISSING"
fi
echo "[openclaw] env presence: MSTEAMS_APP_ID=$([ -n "$MSTEAMS_APP_ID" ] && echo "set(${#MSTEAMS_APP_ID}ch)" || echo MISSING); MSTEAMS_APP_PASSWORD=$([ -n "$MSTEAMS_APP_PASSWORD" ] && echo "set(${#MSTEAMS_APP_PASSWORD}ch)" || echo MISSING); MSTEAMS_TENANT_ID=$([ -n "$MSTEAMS_TENANT_ID" ] && echo "set(${#MSTEAMS_TENANT_ID}ch)" || echo MISSING)"
echo "[openclaw] openclaw.json channels.msteams section (secrets redacted):"
node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));const m=c.channels?.msteams ?? null;if(!m){console.log('  channels.msteams: MISSING');}else{const redacted={...m};if(redacted.appPassword)redacted.appPassword='[REDACTED '+redacted.appPassword.length+'ch]';console.log(JSON.stringify(redacted,null,2).replace(/^/gm,'  '));}" 2>&1 | sed 's/^/[openclaw config]   /'
echo "[openclaw] openclaw plugins list:"
openclaw plugins list 2>&1 | sed 's/^/[openclaw plugins]   /' || echo "[openclaw plugins]   (command failed)"
echo "[openclaw] === End diagnostics ==="

# -----------------------------------------------------------------------------
# Gateway proxy: terminates the public ACA ingress on :18789 and routes
#   POST /api/messages -> 127.0.0.1:3978  (msteams plugin's webhook)
#   *                  -> 127.0.0.1:18788 (openclaw gateway)
# The msteams plugin opens its own Express server on 3978; ACA only exposes one
# public port, so without this proxy Bot Framework can't reach /api/messages.
# Started before the gateway — returns 502 until upstreams come up, which
# Bot Framework retries. Always-on regardless of AOAI auth mode.
# -----------------------------------------------------------------------------
echo "[openclaw] Starting gateway-proxy on 0.0.0.0:18789 (routes /api/messages -> :3978, * -> :18788)"
GATEWAY_PROXY_PORT=18789 \
    GATEWAY_UPSTREAM=http://127.0.0.1:18788 \
    MSTEAMS_UPSTREAM=http://127.0.0.1:3978 \
    node /opt/openclaw-auth/gateway-proxy.mjs >/proc/1/fd/1 2>/proc/1/fd/2 &
GATEWAY_PROXY_PID=$!
echo "[openclaw] gateway-proxy pid=$GATEWAY_PROXY_PID"

if [ "${AZURE_OPENAI_AUTH}" = "managed-identity" ]; then
    echo "[openclaw] Using managed identity — starting auth-proxy on 127.0.0.1:18790"

    # Derive upstream AOAI host from OPENAI_BASE_URL (strip /openai/v1/ suffix)
    UPSTREAM="$(echo "${OPENAI_BASE_URL}" | sed -E 's|/openai/v1/?$||')"
    echo "[openclaw] auth-proxy upstream: $UPSTREAM"

    # Start the auth-proxy in background. It refreshes tokens transparently
    # via @azure/identity's getBearerTokenProvider (per-request, cached).
    AOAI_UPSTREAM_URL="$UPSTREAM" AUTH_PROXY_PORT=18790 \
        node /opt/openclaw-auth/auth-proxy.mjs >/proc/1/fd/1 2>/proc/1/fd/2 &
    PROXY_PID=$!
    echo "[openclaw] auth-proxy pid=$PROXY_PID"

    # Wait for proxy to be listening (max 10s)
    for i in $(seq 1 20); do
        if (echo > /dev/tcp/127.0.0.1/18790) 2>/dev/null; then
            echo "[openclaw] auth-proxy ready"
            break
        fi
        sleep 0.5
    done

    # Re-point OpenClaw at the proxy (preserves /openai/v1/ path semantics).
    # The proxy will inject a fresh bearer token on every request.
    export OPENAI_BASE_URL="http://127.0.0.1:18790/openai/v1/"
    sed -i "s|https://[^\"]*\.openai\.azure\.com/openai/v1/|http://127.0.0.1:18790/openai/v1/|g" /root/.openclaw/openclaw.json

    # OPENAI_API_KEY is required by the SDK but ignored by the proxy.
    export OPENAI_API_KEY="injected-by-auth-proxy"

    AGENT_IDS="$(node -e "const fs=require('fs');const cfg=JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json','utf8'));const ids=new Set(['main']);for(const entry of Array.isArray(cfg.agents?.list)?cfg.agents.list:[]){if(entry&&typeof entry.id==='string'&&entry.id.trim()){ids.add(entry.id.trim());}}console.log([...ids].join(' '));")"
    for AGENT_ID in $AGENT_IDS; do
        if [ ! -f "/root/.openclaw/agents/$AGENT_ID/agent/auth-profiles.json" ] || \
           ! grep -q '"openai:manual"' "/root/.openclaw/agents/$AGENT_ID/agent/auth-profiles.json" 2>/dev/null; then
            echo "[openclaw] Seeding $AGENT_ID OpenAI auth profile for managed-identity runtime"
            mkdir -p "/root/.openclaw/agents/$AGENT_ID/agent"
            printf '%s\n' "$OPENAI_API_KEY" | openclaw models auth --agent "$AGENT_ID" paste-api-key --provider openai >/proc/1/fd/1 2>/proc/1/fd/2
        fi
    done

    # Gateway runs only on loopback :18788 (the gateway-proxy fronts it on :18789).
    if [ "$BROWSER_AUTH_ENABLED" = "true" ]; then
        exec openclaw gateway --bind loopback --port 18788 --auth trusted-proxy
    else
        exec openclaw gateway --bind loopback --port 18788 --token "$GATEWAY_TOKEN"
    fi
else
    echo "[openclaw] Using api-key"
    # Gateway runs only on loopback :18788 (the gateway-proxy fronts it on :18789).
    if [ "$BROWSER_AUTH_ENABLED" = "true" ]; then
        exec openclaw gateway --bind loopback --port 18788 --auth trusted-proxy
    else
        exec openclaw gateway --bind loopback --port 18788 --token "$GATEWAY_TOKEN"
    fi
fi
