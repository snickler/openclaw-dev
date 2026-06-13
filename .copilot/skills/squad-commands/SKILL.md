---
name: "squad-commands"
description: "Hosted-safe command catalog for Squad requests, handoffs, and escalation paths"
domain: "orchestration"
confidence: "high"
source: "derived from .github/agents/squad.agent.md routing table and hosted runtime rules"
---

## Context

When the user asks "squad commands", "what can Squad do?", "show me squad options", or "what commands are available", present a categorized menu. Distinguish what works directly in the hosted OpenClaw runtime from flows that still require a repo-connected Copilot CLI or VS Code session.

## Command catalog

### Ask a specialist
- `Ripley, ...` / `Bishop, ...` / `Parker, ...` / `Hicks, ...` / `Vasquez, ...` / `Rai, ...` — route the conversation to the best specialist.
- `Team, ...` — request a multi-domain recommendation or coordination summary.

### Runtime and governance
- `who's on the team?` / `show the roster` — summarize the actual Squad roster.
- `what did we decide about X?` — summarize the curated decision set.
- `squad commands` / `what can squad do?` — show this menu.

### GitHub and backlog
- `pull issues from owner/repo` / `connect to owner/repo` — inspect GitHub issues when a GitHub bridge (GitHub MCP or authenticated `gh`) is available.
- `show the backlog` / `what issues are open?` — list open issues from the connected repo when GitHub access is available.
- `work on issue #N` — recommend the right owner and next step. Full branch/worktree/PR execution still requires a repo-connected CLI or VS Code session.

### Deployment and operations
- `Bishop, deploy/fix Azure` — route Azure provisioning or runtime issues to Bishop.
- `openclaw on azure` / `devclaw up` / `devclaw teams` — follow the repo deployment playbook.

### Reviews and safety
- `Parker, review this` — security posture review.
- `Vasquez, validate this` — QA / regression validation guidance.
- `Rai, review this` / `RAI check` — responsible AI review.

### Requires a full repo session
- `resume the last CLI session` — requires Copilot CLI session history (`session_store`) and `copilot --resume`.
- `create a worktree` / `open a PR` / `push a branch` — requires a repo checkout, git remote auth, and a CLI or VS Code coding session.
- `set up gh multi-account aliases` — requires local shell/profile access, not the hosted browser runtime.

## Hosted runtime rules

- Prefer `agent_to_agent` for specialist delegation and `sessions_spawn` / `subagents` for background work when those tools are visible.
- If native coordination tools are absent, use the Agents view for manual handoffs instead of pretending to spawn CLI subagents.
- Use only MCP tools that are already loaded into the runtime.
- If GitHub or MCP bridges are missing, say so explicitly and explain the provisioning step that is still required.
