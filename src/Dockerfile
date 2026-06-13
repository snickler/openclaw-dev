FROM node:24-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf

ARG OPENCLAW_VERSION=2026.5.26
ARG OPENCLAW_MSTEAMS_VERSION=2026.5.26
ARG AZURE_IDENTITY_VERSION=4.13.1
ARG HTTP_PROXY_VERSION=1.18.1

# OpenClaw's postinstall installs bundled channel runtime deps via npm.
# Some transitive deps reference git+ssh URLs (e.g. whiskeysockets/libsignal-node).
# Without git the postinstall fails silently and the gateway crashes at boot.
# We rewrite SSH→HTTPS so git clones work without SSH keys, and install
# ca-certificates so git can verify GitHub's TLS certificate. Install `gh`
# as well so hosted GitHub wrappers can function in standard ACA mode when
# the deployment provides a token bridge.
# apt validates package signatures against Debian's trusted keyring.
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates gh jq && \
    rm -rf /var/lib/apt/lists/* && \
    GH_BIN="$(command -v gh)" && ln -sf "$GH_BIN" /usr/local/bin/gh && \
    GIT_BIN="$(command -v git)" && ln -sf "$GIT_BIN" /usr/local/bin/git && \
    JQ_BIN="$(command -v jq)" && ln -sf "$JQ_BIN" /usr/local/bin/jq && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    npm install -g openclaw@${OPENCLAW_VERSION}

# Create directories for config and state
RUN mkdir -p /root/.openclaw /mnt/state /opt/openclaw-auth

COPY patch-openclaw-github-skill.mjs /opt/openclaw-auth/patch-openclaw-github-skill.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/patch-openclaw-github-skill.mjs && \
    node /opt/openclaw-auth/patch-openclaw-github-skill.mjs

COPY patch-openclaw-skills-refresh.mjs /opt/openclaw-auth/patch-openclaw-skills-refresh.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/patch-openclaw-skills-refresh.mjs && \
    node /opt/openclaw-auth/patch-openclaw-skills-refresh.mjs

COPY patch-openclaw-binary-detection.mjs /opt/openclaw-auth/patch-openclaw-binary-detection.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/patch-openclaw-binary-detection.mjs && \
    node /opt/openclaw-auth/patch-openclaw-binary-detection.mjs

# Install the Microsoft Teams channel as an OpenClaw plugin.
# As of 2026.4.10, msteams shipped as an external npm plugin (@openclaw/msteams)
# rather than a bundled extension. Without this the channel never starts even
# when channels.msteams.enabled=true in openclaw.json.
# The openclaw CLI registers the plugin in /root/.openclaw/npm/node_modules
# and writes an install record so the gateway loads it at boot.
RUN openclaw plugins install npm:@openclaw/msteams@${OPENCLAW_MSTEAMS_VERSION} || \
    ( mkdir -p /root/.openclaw/npm && cd /root/.openclaw/npm && \
      npm init -y >/dev/null && \
      npm pkg set private=true >/dev/null && \
      npm pkg set "dependencies.@openclaw/msteams=${OPENCLAW_MSTEAMS_VERSION}" >/dev/null && \
      npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null && \
      npm ci --omit=dev --no-audit --no-fund )

# Install bundled plugin runtime deps using a lockfile-driven helper.
COPY install-deps.cjs /opt/openclaw-auth/install-deps.cjs
RUN node /opt/openclaw-auth/install-deps.cjs

# Install @azure/identity (for auth-proxy.mjs) and http-proxy (for gateway-proxy.mjs).
# gateway-proxy.mjs is a tiny reverse proxy that routes /api/messages (Bot
# Framework webhook) to the msteams plugin on :3978 and everything else to the
# openclaw gateway on :18788. This is required because the msteams plugin
# binds its own Express server on a separate port — without the proxy, ACA's
# single public ingress on :18789 only reaches the gateway and the bot 404s.
WORKDIR /opt/openclaw-auth
COPY package.json package-lock.json /opt/openclaw-auth/
RUN npm ci --omit=dev
WORKDIR /

# Copy pre-configured openclaw.json (points agent to Azure OpenAI via env vars)
# Keep a canonical copy that the entrypoint restores after Azure Files state restore
COPY openclaw.json /root/.openclaw/openclaw.json
COPY openclaw.json /opt/openclaw.json.canonical

# Copy auth-proxy INTO the @azure/identity install dir so ESM import
# resolution finds node_modules as a sibling. The proxy injects a fresh
# Entra ID bearer token on every forwarded request, so OpenClaw never sees
# token expiry. Replaces the broken token-refresh.mjs (env-var refresh
# couldn't propagate to the spawned gateway child).
COPY auth-proxy.mjs /opt/openclaw-auth/auth-proxy.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/auth-proxy.mjs

# Gateway proxy: routes /api/messages -> msteams plugin on :3978,
# everything else -> openclaw gateway on :18788. Listens on :18789 (the
# ACA ingress targetPort).
COPY gateway-proxy.mjs /opt/openclaw-auth/gateway-proxy.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/gateway-proxy.mjs

COPY squad-runtime /opt/openclaw-squad
COPY seed-squad-runtime.mjs /opt/openclaw-auth/seed-squad-runtime.mjs
RUN sed -i 's/\r$//' /opt/openclaw-auth/seed-squad-runtime.mjs && \
    node -e "const fs=require('fs');const bundle='/opt/openclaw-squad/runtime-bundle.json';const bridge='/opt/openclaw-squad/github-mcp-bridge.mjs';if(!fs.existsSync(bundle)){throw new Error('missing generated runtime bundle: run scripts/generate-squad-runtime-bundle.mjs before build');}if(!fs.existsSync(bridge)){throw new Error('missing staged GitHub MCP bridge asset: run scripts/generate-squad-runtime-bundle.mjs before build');}const b=JSON.parse(fs.readFileSync(bundle,'utf8'));if(!b?.provenance?.gitCommitSha||!b?.provenance?.sourceDigestSha256||!Array.isArray(b?.provenance?.sourceFiles)||!b.provenance.sourceFiles.length){throw new Error('runtime bundle missing authoritative provenance');}"

COPY runtime-command-wrapper.sh /opt/openclaw-auth/runtime-command-wrapper.sh
RUN sed -i 's/\r$//' /opt/openclaw-auth/runtime-command-wrapper.sh && chmod +x /opt/openclaw-auth/runtime-command-wrapper.sh && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/task && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/runSubagent && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/read_agent && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/ask_user && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_decide && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_read && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_write && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_append && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_delete && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_list && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/squad_state_health && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/code && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/codium && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/copilot && \
    ln -sf /opt/openclaw-auth/runtime-command-wrapper.sh /usr/local/bin/github-copilot

# PERMANENT FIX: extend the @openclaw/msteams plugin's Bot Framework serviceUrl
# allowlist to include directline.botframework.com so Direct Line / Web Chat
# replies are not blocked by the plugin's SSRF guard. See
# patch-msteams-allowlist.mjs for the full explanation.
COPY patch-msteams-allowlist.mjs /opt/patch-msteams-allowlist.mjs
RUN sed -i 's/\r$//' /opt/patch-msteams-allowlist.mjs && \
    node /opt/patch-msteams-allowlist.mjs || echo "[Dockerfile] patch-msteams-allowlist failed but continuing"

# Copy entrypoint (handles state restore/save with Azure Files)
# Fix line endings to LF (git on Windows may convert to CRLF)
COPY entrypoint.sh /opt/entrypoint.sh
RUN sed -i 's/\r$//' /opt/entrypoint.sh && chmod +x /opt/entrypoint.sh

# Test script for agent conversations (strips emoji to avoid ACA exec Unicode crashes)
RUN printf '#!/bin/sh\nopenclaw agent -m "$1" 2>&1 | LC_ALL=C tr -cd "\\11\\12\\15\\40-\\176"\n' > /opt/test-agent.sh && chmod +x /opt/test-agent.sh

# OpenClaw gateway port
EXPOSE 18789

ENTRYPOINT ["/opt/entrypoint.sh"]
