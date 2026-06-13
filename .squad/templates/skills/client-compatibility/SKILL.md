---
name: "client-compatibility"
description: "Platform detection and adaptive spawning for CLI vs VS Code vs other surfaces"
domain: "orchestration"
confidence: "high"
source: "extracted"
---

## Context

Squad runs on multiple Copilot surfaces (CLI, VS Code, JetBrains, GitHub.com). The coordinator must detect its platform and adapt spawning behavior accordingly. Different tools are available on different platforms, requiring conditional logic for agent spawning, SQL usage, and response timing.

## Patterns

### Platform Detection

Before spawning agents, determine the platform by checking available tools:

1. **CLI mode** — `task` tool is available → full spawning control. Use `task` with `agent_type`, `mode`, `model`, `description`, `prompt` parameters. Collect results via `read_agent`.

2. **VS Code mode** — `runSubagent` or `agent` tool is available → conditional behavior. Use `runSubagent` with the task prompt. Drop `agent_type`, `mode`, and `model` parameters. Multiple subagents in one turn run concurrently (equivalent to background mode). Results return automatically — no `read_agent` needed.

3. **Hosted OpenClaw mode** — neither `task` nor `runSubagent` is available, but generated hosted-runtime files are present and the runtime may expose OpenClaw-native coordination tools (`agent_to_agent`, `sessions_spawn`, `subagents`, `sessions_history`). Use those real hosted tools when present; otherwise use handoffs plus hosted wrapper docs. Do not imply repo checkout, worktrees, `sql`, or local editor integration.

4. **Fallback mode** — neither spawn tools nor hosted-runtime markers available → work inline. Do not apologize or explain the limitation. Execute the task directly.

If both `task` and `runSubagent` are available, prefer `task` (richer parameter surface).

### VS Code Spawn Adaptations

When in VS Code mode, the coordinator changes behavior in these ways:

- **Spawning tool:** Use `runSubagent` instead of `task`. The prompt is the only required parameter — pass the full agent prompt (charter, identity, task, hygiene, response order) exactly as you would on CLI.
- **Parallelism:** Spawn ALL concurrent agents in a SINGLE turn. They run in parallel automatically. This replaces `mode: "background"` + `read_agent` polling.
- **Model selection:** Accept the session model. Do NOT attempt per-spawn model selection or fallback chains — they only work on CLI. In Phase 1, all subagents use whatever model the user selected in VS Code's model picker.
- **Scribe:** Cannot fire-and-forget. Batch Scribe as the LAST subagent in any parallel group. Scribe is light work (file ops only), so the blocking is tolerable.
- **Launch table:** Skip it. Results arrive with the response, not separately. By the time the coordinator speaks, the work is already done.
- **`read_agent`:** Skip entirely. Results return automatically when subagents complete.
- **`agent_type`:** Drop it. All VS Code subagents have full tool access by default. Subagents inherit the parent's tools.
- **`description`:** Drop it. The agent name is already in the prompt.
- **Prompt content:** Keep ALL prompt structure — charter, identity, task, hygiene, response order blocks are surface-independent.

### Hosted OpenClaw Adaptations

When in hosted OpenClaw mode:

- **Native coordination first.** Use `agent_to_agent` for specialist delegation/consultation. Use `sessions_spawn` + `subagents` + `sessions_yield` for background or parallel work when those tools are exposed.
- **Manual handoff is fallback only.** If native coordination tools are absent, use the Agents view as the specialist-routing mechanism instead of pretending a subagent launch happened.
- **Transcript recall is native.** Use `sessions_history`, `sessions_list`, or `subagents` instead of pretending `read_agent` exists.
- **Generated wrapper docs are authoritative.** Prefer `HOSTED_RUNTIME.md`, `COMMANDS.md`, `HOSTED_GITHUB.md`, `HOSTED_MCP.md`, and `HOSTED_SKILLS.md`.
- **GitHub is bridge-only.** Use GitHub MCP when loaded, or `gh` only when a token bridge already exists. Never suggest `gh auth login`, `gh auth switch`, profile edits, or local shell alias setup from the browser runtime.
- **MCP is preloaded only.** If a server is missing, explain that the hosted deployment lacks that bridge; do not tell the user to live-edit `.copilot/mcp-config.json` or `.vscode/mcp.json` from the browser session.
- **Repo/session workflows stay local.** `git worktree`, `copilot --resume`, `session_store`, and shell-profile mutation remain local CLI / VS Code workflows.

### Feature Degradation Table

| Feature | CLI | VS Code | Hosted OpenClaw | Degradation |
|---------|-----|---------|-----------------|-------------|
| Parallel fan-out | `mode: "background"` + `read_agent` | Multiple subagents in one turn | `sessions_spawn` / `subagents` when exposed; otherwise Agents view handoffs | Hosted loses CLI per-spawn knobs and may fall back to manual routing |
| Model selection | Per-spawn `model` param (4-layer hierarchy) | Session model only (Phase 1) | Hosted runtime default only | Accept surface default |
| Scribe fire-and-forget | Background, never read | Sync, must wait | Not available as a browser workflow | Hosted uses generated summaries instead |
| Launch table UX | Show table → results later | Skip table → results with response | Not applicable — use native session status or the Agents view | UX only |
| SQL / session_store | Available | Not available | Not available | Avoid SQL-dependent flows outside CLI |
| Repo / worktree ops | Available when repo is mounted | Available when repo is opened | Not guaranteed; assume absent | Hosted must not promise branch/worktree flows |
| Response order bug | Critical workaround | Possibly necessary (unverified) | Usually not needed — OpenClaw owns session delivery | Keep the block only where native hosted tools are absent |

### SQL Tool Caveat

The `sql` tool is **CLI-only**. It does not exist on VS Code, JetBrains, GitHub.com, or hosted OpenClaw. Any coordinator logic or agent workflow that depends on SQL (todo tracking, batch processing, session state) will silently fail on non-CLI surfaces. Cross-platform code paths must not depend on SQL. Use filesystem-based state (`.squad/` files) for anything that must work everywhere, and hosted-runtime wrapper docs when the browser deployment is the only exposed surface.

## Examples

**Example 1: CLI parallel spawn**
```typescript
// Coordinator detects task tool available → CLI mode
task({ agent_type: "general-purpose", mode: "background", model: "claude-sonnet-4.5", ... })
task({ agent_type: "general-purpose", mode: "background", model: "claude-haiku-4.5", ... })
// Later: read_agent for both
```

**Example 2: VS Code parallel spawn**
```typescript
// Coordinator detects runSubagent available → VS Code mode
runSubagent({ prompt: "...Fenster charter + task..." })
runSubagent({ prompt: "...Hockney charter + task..." })
runSubagent({ prompt: "...Scribe charter + task..." }) // Last in group
// Results return automatically, no read_agent
```

**Example 3: Fallback mode**
```typescript
// Neither task nor runSubagent available → work inline
// Coordinator executes the task directly without spawning
```

## Anti-Patterns

- ❌ Using SQL tool in cross-platform workflows (breaks on VS Code/JetBrains/GitHub.com)
- ❌ Attempting per-spawn model selection on VS Code (Phase 1 — only session model works)
- ❌ Fire-and-forget Scribe on VS Code (must batch as last subagent)
- ❌ Showing launch table on VS Code (results already inline)
- ❌ Apologizing or explaining platform limitations to the user
- ❌ Using `task` when only `runSubagent` is available
- ❌ Dropping prompt structure (charter/identity/task) on non-CLI platforms
