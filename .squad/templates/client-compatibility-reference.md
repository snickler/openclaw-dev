# Client Compatibility Reference

### Client Compatibility

Squad runs on multiple Copilot surfaces. The coordinator MUST detect its platform and adapt spawning behavior accordingly. See `docs/scenarios/client-compatibility.md` for the full compatibility matrix.

#### Platform Detection

Before spawning agents, determine the platform by checking available tools:

1. **CLI mode** — `task` tool is available → full spawning control. Use `task` with `agent_type`, `mode`, `model`, `description`, `prompt` parameters. Collect results via `read_agent`.

2. **VS Code mode** — `runSubagent` or `agent` tool is available → conditional behavior. Use `runSubagent` with the task prompt. Drop `agent_type`, `mode`, and `model` parameters. Multiple subagents in one turn run concurrently (equivalent to background mode). Results return automatically — no `read_agent` needed.

3. **Hosted OpenClaw mode** — neither `task` nor `runSubagent` is available, but the runtime exposes generated hosted-workspace files (for example `HOSTED_RUNTIME.md`, `PROVENANCE.md`, `HOSTED_GITHUB.md`) and may expose OpenClaw-native coordination tools (`agent_to_agent`, `sessions_spawn`, `subagents`, `sessions_history`). Use those real hosted tools when present; otherwise use agent switching plus hosted wrapper guidance. Do **not** imply repo checkout, worktrees, `sql`, `session_store`, or local editor integration.

4. **Fallback mode** — neither spawn tools nor hosted-runtime markers are available → work inline. Do not apologize or explain the limitation. Execute the task directly.

If both `task` and `runSubagent` are available, prefer `task` (richer parameter surface).

#### VS Code Spawn Adaptations

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

#### Hosted OpenClaw Adaptations

When in hosted OpenClaw mode, the coordinator changes behavior in these ways:

- **Native coordination first:** Use `agent_to_agent` for specialist delegation/consultation. Use `sessions_spawn` + `subagents` + `sessions_yield` for background or parallel work when those tools are exposed.
- **Manual handoff is fallback only:** If native coordination tools are absent, use the Agents view as the handoff surface. Recommend the correct specialist instead of claiming `task`/`runSubagent` execution happened.
- **Transcript recall is native:** Use `sessions_history`, `sessions_list`, or `subagents` instead of pretending `read_agent` exists.
- **Generated docs are the contract:** Treat generated files such as `HOSTED_RUNTIME.md`, `COMMANDS.md`, `HOSTED_GITHUB.md`, `HOSTED_MCP.md`, and `HOSTED_SKILLS.md` as the authoritative browser-runtime wrapper layer.
- **GitHub is bridge-only:** Use GitHub MCP when it is already loaded. Otherwise only rely on `gh` when the runtime has a non-interactive token bridge (`GH_TOKEN` / `GITHUB_TOKEN`). Do not suggest `gh auth login`, `gh auth switch`, or per-user profile setup from the hosted runtime.
- **MCP is pre-provisioned only:** The hosted runtime cannot edit or hot-load `.copilot/mcp-config.json`, `.mcp.json`, `.vscode/mcp.json`, or user-level MCP config. Those config surfaces may intentionally differ, so audit the exact file for the active client/runtime. If a tool is absent, explain that the deployment/session lacks that bridge.
- **No repo/session assumptions:** Assume there is no checked-out git repo, no `git worktree`, no `session_store`, and no `copilot --resume` capability unless the deployment explicitly exposes them.

#### Feature Degradation Table

| Feature | CLI | VS Code | Hosted OpenClaw | Degradation |
|---------|-----|---------|-----------------|-------------|
| Parallel fan-out | `mode: "background"` + `read_agent` | Multiple subagents in one turn | `sessions_spawn` / `subagents` when exposed; otherwise Agents view handoffs | Hosted loses CLI per-spawn knobs and may fall back to manual routing |
| Model selection | Per-spawn `model` param (4-layer hierarchy) | Session model only (Phase 1) | Hosted runtime default only | Accept surface default |
| Scribe fire-and-forget | Background, never read | Sync, must wait | Not available as a browser-side workflow | Hosted uses generated summaries, not mutable state writes |
| Launch table UX | Show table → results later | Skip table → results with response | Not applicable — use native session status or the Agents view | UX only |
| SQL / session_store | Available | Not available | Not available | Avoid SQL-dependent flows outside CLI |
| Repo / worktree ops | Available when repo is mounted | Available when repo is opened | Not guaranteed; assume absent | Hosted must not promise branch/worktree flows |
| Response order bug | Critical workaround | Possibly necessary (unverified) | Usually not needed — OpenClaw owns session delivery | Keep the block only where native hosted tools are absent |

#### SQL Tool Caveat

The `sql` tool is **CLI-only**. It does not exist on VS Code, JetBrains, GitHub.com, or the hosted OpenClaw browser runtime. Any coordinator logic or agent workflow that depends on SQL (todo tracking, batch processing, session state) will silently fail on non-CLI surfaces. Cross-platform code paths must not depend on SQL. Use filesystem-based state (`.squad/` files) for anything that must work everywhere, and hosted-runtime wrapper docs when the browser deployment is the only exposed surface.
