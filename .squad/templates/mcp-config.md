# MCP Integration — Configuration and Samples

MCP (Model Context Protocol) servers extend Squad with tools for external services — Trello, Aspire dashboards, Azure, Notion, and more. The user configures MCP servers in their environment; Squad discovers and uses them.

## Config File Locations

Users configure MCP servers at these locations (checked in priority order):
1. **Repository-level (Copilot clients):** `.copilot/mcp-config.json` (team-shared, committed to repo)
2. **Repository-level (Claude Code / generic MCP clients):** `.mcp.json` (team-shared, committed to repo)
3. **Workspace-level:** `.vscode/mcp.json` (VS Code workspaces)
4. **User-level:** `~/.copilot/mcp-config.json` (personal)
5. **CLI override:** `--additional-mcp-config` flag (session-specific)

These config surfaces may intentionally differ. Do **not** assume `.mcp.json` and `.copilot/mcp-config.json` declare the same servers; audit the exact file that applies to the current client/runtime.

## Hosted OpenClaw Runtime Wrapper

The browser-hosted OpenClaw runtime cannot live-edit or hot-load `.copilot/mcp-config.json`, `.mcp.json`, `.vscode/mcp.json`, or user-level MCP config. It only sees MCP servers that were already provisioned into the runtime/session.

- If an MCP tool is present, use it.
- If it is missing, explain that the hosted deployment lacks that bridge.
- Fall back to CLI bridges (`gh`, `az`, etc.) only when those bridges are already provisioned and authenticated inside the runtime.
- Do **not** tell the user to edit VS Code or local config files from inside the hosted browser session.

## Sample Config — Trello

```json
{
  "mcpServers": {
    "trello": {
      "command": "npx",
      "args": ["-y", "@trello/mcp-server"],
      "env": {
        "TRELLO_API_KEY": "${TRELLO_API_KEY}",
        "TRELLO_TOKEN": "${TRELLO_TOKEN}"
      }
    }
  }
}
```

## Sample Config — GitHub

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "GH_TOKEN": "${GH_TOKEN}",
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

## Sample Config — Azure

```json
{
  "mcpServers": {
    "azure": {
      "command": "npx",
      "args": ["-y", "@azure/mcp-server"],
      "env": {
        "AZURE_SUBSCRIPTION_ID": "${AZURE_SUBSCRIPTION_ID}",
        "AZURE_CLIENT_ID": "${AZURE_CLIENT_ID}",
        "AZURE_CLIENT_SECRET": "${AZURE_CLIENT_SECRET}",
        "AZURE_TENANT_ID": "${AZURE_TENANT_ID}"
      }
    }
  }
}
```

## Sample Config — Aspire

```json
{
  "mcpServers": {
    "aspire": {
      "command": "npx",
      "args": ["-y", "@aspire/mcp-server"],
      "env": {
        "ASPIRE_DASHBOARD_URL": "${ASPIRE_DASHBOARD_URL}"
      }
    }
  }
}
```

## Authentication Notes

- **GitHub MCP in hosted OpenClaw must be explicitly configured with a reviewed server package and uses the safe token bridge already provided by the environment** (`GH_TOKEN`, `GITHUB_TOKEN`, or provider-specific token). Do not embed tokens in config files; create or scope tokens outside the repo when needed.
- **ACA Sandbox custom-image caveat:** attaching a `github-copilot` sandbox credential does not currently surface auth inside the runtime by itself. Keep `SANDBOX_GITHUB_COPILOT_PAT` set when running `devclaw sandbox build` / `upload` if you want `GH_TOKEN`-backed `gh` access in hosted sessions.
- **Trello requires API key + token** from https://trello.com/power-ups/admin
- **Azure requires service principal credentials** — see Azure docs for setup
- **Aspire uses the dashboard URL** — typically `http://localhost:18888` during local dev

Auth is a real blocker for some MCP servers. Users need separate tokens for GitHub MCP, Azure MCP, Trello MCP, etc. This is a documentation problem, not a code problem.
