import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const options = {
    stateRoot: process.env.OPENCLAW_STATE_DIR || "/root/.openclaw",
    seedDir: "/opt/openclaw-squad",
    controlUi: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--state-root") {
      options.stateRoot = argv[++index];
    } else if (current === "--config") {
      options.configPath = argv[++index];
    } else if (current === "--seed-dir") {
      options.seedDir = argv[++index];
    } else if (current === "--control-ui") {
      options.controlUi = argv[++index];
    } else if (current === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  options.stateRoot = path.resolve(options.stateRoot);
  options.seedDir = path.resolve(options.seedDir);
  options.configPath = path.resolve(options.configPath || path.join(options.stateRoot, "openclaw.json"));
  if (options.controlUi) {
    options.controlUi = path.resolve(options.controlUi);
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${String(content).trimEnd()}\n`, "utf8");
}

function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function githubBridgeVariable() {
  return ["GH_TOKEN", "GITHUB_TOKEN"].find((name) => String(process.env[name] || "").trim()) || "";
}

function projectionItems(bundle) {
  const projection = bundle.projection || {};
  return [
    ...(Array.isArray(projection.documents) ? projection.documents : []),
    ...(Array.isArray(projection.skills) ? projection.skills : []),
    ...(Array.isArray(projection.mcpConfigs) ? projection.mcpConfigs : []),
  ];
}

function projectionTopLevelEntries(bundle) {
  const results = new Set();
  for (const entry of projectionItems(bundle)) {
    const normalized = String(entry?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const firstSegment = normalized.split("/").filter(Boolean)[0];
    if (firstSegment) {
      results.add(firstSegment);
    }
  }
  return [...results];
}

function resolveProjectionTarget(rootDir, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    return "";
  }

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    return "";
  }

  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return "";
  }
  return target;
}

function removeProjectedPaths(workspacePath, bundle) {
  for (const entry of projectionTopLevelEntries(bundle)) {
    removePath(path.join(workspacePath, entry));
  }
}

function materializeProjection(workspacePath, bundle) {
  removeProjectedPaths(workspacePath, bundle);
  for (const entry of projectionItems(bundle)) {
    const targetPath = resolveProjectionTarget(workspacePath, entry?.path);
    if (!targetPath) {
      continue;
    }
    writeText(targetPath, entry.content || "");
  }
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function normalizeLines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function projectionDocuments(bundle) {
  return Array.isArray(bundle.projection?.documents) ? bundle.projection.documents : [];
}

function projectionSkills(bundle) {
  return Array.isArray(bundle.projection?.skills) ? bundle.projection.skills : [];
}

function projectionMcpConfigs(bundle) {
  return Array.isArray(bundle.projection?.mcpConfigs) ? bundle.projection.mcpConfigs : [];
}

function projectionDocument(bundle, sourcePath) {
  return projectionDocuments(bundle).find((entry) => entry.path === sourcePath) || null;
}

function projectionText(bundle, sourcePath, fallback = "") {
  return projectionDocument(bundle, sourcePath)?.content || fallback;
}

function runtimeContext() {
  const wrapperCommands = [
    "task",
    "runSubagent",
    "read_agent",
    "ask_user",
    "squad",
    "squad_decide",
    "squad_state_read",
    "squad_state_write",
    "squad_state_append",
    "squad_state_delete",
    "squad_state_list",
    "squad_state_health",
    "code",
    "codium",
    "copilot",
    "github-copilot",
  ];
  return {
    ghAvailable: commandAvailable("gh"),
    gitAvailable: commandAvailable("git"),
    jqAvailable: commandAvailable("jq"),
    bridgeVar: githubBridgeVariable(),
    wrapperCommands,
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function mergeAllowedAgentIds(previousAllow, managedAgentIds) {
  const explicitPrevious = uniqueStrings(previousAllow).filter((value) => value !== "*");
  return uniqueStrings([...managedAgentIds, ...explicitPrevious]).sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" })
  );
}

function runtimeConfiguredMcpServers(bundle) {
  return Array.isArray(bundle.hostedRuntime?.runtimeConfig?.configuredMcpServers)
    ? bundle.hostedRuntime.runtimeConfig.configuredMcpServers
    : [];
}

function runtimeConfiguredGitHubMcpServers(bundle) {
  return runtimeConfiguredMcpServers(bundle).filter((server) => {
    const haystack = [server?.name || "", server?.command || "", ...(Array.isArray(server?.args) ? server.args : [])].join(" ");
    return /github/i.test(haystack);
  });
}

function hostedBundledGitHubSkillNames() {
  return ["github", "gh-issues"];
}

function removeLegacyFiles(workspacePath) {
  [
    ".git",
    "TEAM.md",
    "ROUTING.md",
    "DECISIONS.md",
    "SQUAD_COORDINATOR_SOURCE.md",
    "SQUAD_ROSTER.md",
    "SOURCE_INDEX.md",
    "ROLE_CHARTER.md",
    "CHARTERS",
  "PROJECT_CONTEXT.md",
  "ROSTER.md",
  "ROUTING_OWNERSHIP.md",
  "DECISION_SUMMARY.md",
  "RAI_POLICY_SUMMARY.md",
  "MEMBER_PROFILES.md",
  "ROLE_PROFILE.md",
  "HOSTED_RUNTIME.md",
  "RUNTIME_CONTEXT.md",
  "RUNTIME_GOVERNANCE.md",
  "COMMANDS.md",
  "HOSTED_GITHUB.md",
  "HOSTED_MCP.md",
  "HOSTED_SKILLS.md",
  "SURFACE_COMPATIBILITY.md",
  "COORDINATOR_CONTRACT.md",
  "COPILOT_INSTRUCTIONS.md",
  "OPENCLAW_ON_AZURE_AGENT.md",
  "CEREMONIES.md",
  "SPAWN_REFERENCE.md",
  "CLIENT_COMPATIBILITY.md",
  "MCP_CONFIG_REFERENCE.md",
  "WORKTREE_REFERENCE.md",
  "SESSION_INIT.md",
  "AFTER_AGENT.md",
  "COPILOT_AGENT.md",
  "WORKFLOW_WIRING.md",
  "MACHINE_CAPABILITIES.md",
  "CEREMONY_REFERENCE.md",
  "NOTES_PROTOCOL.md",
  "ORCHESTRATION_LOG_REFERENCE.md",
  "RUN_OUTPUT_REFERENCE.md",
  "MULTI_AGENT_FORMAT.md",
  "TEAM_WISDOM.md",
  "PROJECT_NOW.md",
  "RAI_POLICY.md",
  "SQUAD_CONFIG.json",
  "OPENCLAW_RUNTIME_CONFIG.json",
  "REPO_MCP_CONFIG.json",
  "COPILOT_MCP_CONFIG.json",
  "COMMAND_WRAPPERS.md",
  "combined-squad",
  "skills",
  ].forEach((name) => removePath(path.join(workspacePath, name)));
}

function runtimeAgents(bundle) {
  const main = {
    id: "main",
    name: bundle.coordinator.name,
    role: bundle.coordinator.runtimeRole,
    status: "Default coordinator",
    interactive: true,
    emoji: "🧭",
    workspaceSubdir: "workspace",
    theme: "hosted squad coordinator",
    summary: bundle.coordinator.description,
  };

  const specialists = bundle.roster
    .filter((member) => member.interactive)
    .map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
      interactive: true,
      emoji: member.emoji || "👤",
      workspaceSubdir: path.join("workspaces", member.id),
      theme: (member.role || "specialist").toLowerCase(),
      summary: member.publicBio || `${member.name} handles ${member.role}.`,
      profile: member,
    }));

  return [main, ...specialists];
}

function rosterLines(bundle) {
  return bundle.roster.map((member) => {
    const exposure = member.interactive ? "interactive specialist" : "system role (non-interactive)";
    return `- ${member.name} — ${member.role} — ${member.status} (${exposure})`;
  });
}

function interactiveRoster(bundle) {
  return bundle.hostedRuntime?.interactiveRoster || bundle.roster.filter((member) => member.interactive);
}

function supportRoles(bundle) {
  return bundle.hostedRuntime?.supportRoles || bundle.roster.filter((member) => !member.interactive);
}

function renderProjectContext(bundle) {
  const context = bundle.projectContext || {};
  return [
    "# Project context",
    "",
    `- Project: ${context.project || "openclaw-dev"}`,
    ...(context.owner ? [`- Owner: ${context.owner}`] : []),
    ...(context.stack ? [`- Stack: ${context.stack}`] : []),
    ...(context.description ? [`- Description: ${context.description}`] : []),
    ...(context.created ? [`- Created: ${context.created}`] : []),
    "",
    "- This is a generated runtime summary. Read TEAM.md for the projected source file.",
  ].join("\n");
}

function renderHostedRuntime(agent, bundle) {
  const interactive = interactiveRoster(bundle);
  const support = supportRoles(bundle);
  const routingEntries = agent.id === "main"
    ? bundle.routingSummary || []
    : agent.profile?.routingOwnership || [];
  const decisions = agent.id === "main"
    ? (bundle.decisionSummary || []).slice(0, 4)
    : (agent.profile?.decisionSummary || []).slice(0, 3);
  const blocked = (bundle.raiPolicySummary?.blockedCategories || []).slice(0, 4);
  const capabilities = bundle.hostedRuntime?.capabilities || [];
  const limitations = bundle.hostedRuntime?.limitations || [bundle.coordinator.hostedRuntimeNote].filter(Boolean);

  return [
    "# Hosted runtime contract",
    "",
    `- Projection: ${bundle.hostedRuntime?.projection || "read-only-hosted-squad-runtime"}`,
    ...(bundle.projectContext?.project ? [`- Project: ${bundle.projectContext.project}`] : []),
    ...(bundle.projectContext?.stack ? [`- Stack: ${bundle.projectContext.stack}`] : []),
    ...(bundle.projectContext?.description ? [`- Mission: ${bundle.projectContext.description}`] : []),
    `- Default agent: ${bundle.coordinator.name}`,
    `- Interactive specialists: ${interactive.map((member) => member.name).join(", ")}`,
    ...(support.length
      ? [`- System roles visible but non-interactive: ${support.map((member) => member.name).join(", ")}`]
      : []),
    "",
    "## Capabilities in this hosted runtime",
    ...(capabilities.length
      ? capabilities.map((item) => `- ${item}`)
      : [
          "- Explain the actual Squad roster, routing ownership, curated governance summary, and RAI posture.",
          "- Stay within the browser-authenticated hosted OpenClaw runtime boundary.",
        ]),
    "",
    "## Read-only projected files now available here",
    "- COORDINATOR_CONTRACT.md / TEAM.md / ROUTING.md / CEREMONIES.md",
    "- CHARTERS/ plus ROLE_CHARTER.md for the current specialist",
    "- PROJECT_NOW.md / TEAM_WISDOM.md / SQUAD_CONFIG.json",
    "- Spawn / compatibility / MCP / workflow reference docs",
    "- skills/ for projected repo playbooks plus hosted wrapper skills",
    "",
    agent.id === "main" ? "## Routing coverage" : "## Routing coverage for this role",
    ...(routingEntries.length
      ? routingEntries.map((entry) => `- ${entry.workType} → ${entry.routeTo}${entry.examples ? ` (${entry.examples})` : ""}`)
      : ["- No explicit routing ownership is published for this runtime scope."]),
    "",
    agent.id === "main" ? "## Curated governance signals" : "## Curated decisions tied to this role",
    ...(decisions.length
      ? decisions.map((entry) => `- ${entry.id} — ${entry.title}${entry.status ? ` [${entry.status}]` : ""}`)
      : ["- No curated decision summary is attached to this runtime scope."]),
    "",
    "## RAI guardrails",
    ...(blocked.length ? blocked.map((item) => `- Blocked category: ${item}`) : ["- Use the generated RAI summary and defer to Rai when safety concerns appear."]),
    "",
    "## Hosted-runtime limits",
    ...limitations.map((item) => `- ${item}`),
  ].join("\n");
}

function renderRoster(bundle) {
  return [
    "# Squad roster",
    "",
    "Roster derived from the authoritative team source with hosted-runtime exposure limits applied.",
    "",
    ...rosterLines(bundle),
  ].join("\n");
}

function renderRoutingOwnership(bundle, agentName = "") {
  const entries = agentName
    ? bundle.routingSummary.filter((entry) => entry.routeTo === agentName)
    : bundle.routingSummary;

  return [
    agentName ? `# ${agentName} routing ownership` : "# Routing ownership",
    "",
    ...(entries.length
      ? entries.map((entry) => `- ${entry.workType} → ${entry.routeTo}${entry.examples ? ` (${entry.examples})` : ""}`)
      : ["- No specific routing ownership is published for this runtime agent."]),
    "",
    "- Routing is summarized here. Read ROUTING.md for the projected source file.",
  ].join("\n");
}

function renderDecisionSummary(bundle, agentName = "") {
  const entries = agentName
    ? bundle.roster.find((member) => member.name === agentName)?.decisionSummary || []
    : bundle.decisionSummary || [];

  return [
    agentName ? `# ${agentName} decision summary` : "# Decision summary",
    "",
    ...(entries.length
      ? entries.map((entry) => `- ${entry.id} — ${entry.title}${entry.status ? ` [${entry.status}]` : ""}`)
      : ["- No curated decision summary is attached to this runtime scope."]),
    "",
    "- This is a curated summary only; mutable decision ledgers and inbox files remain intentionally withheld from the hosted runtime.",
  ].join("\n");
}

function renderRaiPolicySummary(bundle) {
  const policy = bundle.raiPolicySummary || {};
  return [
    "# RAI policy summary",
    "",
    "Derived from the repo's RAI policy. Read RAI_POLICY.md for the projected source file.",
    "",
    "## Principles",
    ...(policy.principles || []).map((item) => `- ${item}`),
    "",
    "## Always-blocked categories",
    ...((policy.blockedCategories || []).map((item) => `- ${item}`)),
    "",
    "## Advisory categories",
    ...((policy.advisoryCategories || []).map((item) => `- ${item}`)),
    "",
    "## Terminology cues",
    ...((policy.terminology || []).map((item) => `- Prefer ${item.prefer} instead of ${item.avoid}`)),
  ].join("\n");
}

function renderProvenance(bundle) {
  const provenance = bundle.provenance || {};
  const sourceDigests = Array.isArray(provenance.sourceDigests) ? provenance.sourceDigests : [];
  return [
    "# Provenance",
    "",
    `- Generated at: ${bundle.generatedAt}`,
    `- Generator: ${provenance.generator || "unknown"}`,
    ...(provenance.gitCommitSha ? [`- Git commit: ${provenance.gitCommitSha}`] : []),
    ...(provenance.gitShortCommitSha ? [`- Git short commit: ${provenance.gitShortCommitSha}`] : []),
    ...(provenance.worktreeDirty !== undefined ? [`- Worktree dirty at generation: ${provenance.worktreeDirty}`] : []),
    ...(provenance.sourceDigestSha256 ? [`- Source digest (sha256): ${provenance.sourceDigestSha256}`] : []),
    ...(sourceDigests.length
      ? ["", "## Authoritative source list", ...sourceDigests.map((entry) => `- ${entry.path} (${entry.sha256})${entry.label ? ` — ${entry.label}` : ""}`)]
      : (provenance.sourceFiles || []).map((entry) => `- Source file: ${entry}`)),
    ...(provenance.note ? ["", provenance.note] : []),
  ].join("\n");
}

function renderMemberProfiles(bundle) {
  const lines = [
    "# Member profiles",
    "",
    "Sanitized roster, charter, and routing summaries for the hosted runtime.",
  ];

  for (const member of bundle.roster) {
    lines.push(
      "",
      `## ${member.name} — ${member.role}`,
      `- Status: ${member.status}`,
      `- Hosted runtime exposure: ${member.interactive ? "interactive specialist" : "background-only provenance role"}`,
      ...(member.publicBio ? [`- Public bio: ${member.publicBio}`] : []),
      ...(member.expertise ? [`- Expertise: ${member.expertise}`] : []),
      ...(member.responsibilities?.length ? ["- Responsibilities:", ...member.responsibilities.map((item) => `  - ${item}`)] : []),
      ...(member.handoffTags?.length ? [`- Handoff tags: ${member.handoffTags.join(", ")}`] : [])
    );
  }

  return lines.join("\n");
}

function renderRoleProfile(member, bundle) {
  const routingOwnership = member.routingOwnership || [];
  const decisions = (member.decisionSummary || []).slice(0, 3);
  return [
    `# ${member.name} role profile`,
    "",
    `- Role: ${member.role}`,
    `- Status: ${member.status}`,
    `- Hosted runtime exposure: ${member.interactive ? "interactive specialist" : "system role (non-interactive)"}`,
    ...(member.publicBio ? [`- Public bio: ${member.publicBio}`] : []),
    ...(member.expertise ? [`- Expertise: ${member.expertise}`] : []),
    ...(routingOwnership.length ? ["", "## Routing ownership", ...routingOwnership.map((entry) => `- ${entry.workType}${entry.examples ? ` (${entry.examples})` : ""}`)] : []),
    ...(member.responsibilities?.length ? ["", "## Responsibility tags", ...member.responsibilities.map((item) => `- ${item}`)] : []),
    ...(decisions.length ? ["", "## Curated decisions", ...decisions.map((entry) => `- ${entry.id} — ${entry.title}${entry.status ? ` [${entry.status}]` : ""}`)] : []),
    ...(member.handoffTags?.length ? ["", "## Handoff tags", ...member.handoffTags.map((item) => `- ${item}`)] : []),
    "",
    `- Hosted runtime note: ${bundle.coordinator.hostedRuntimeNote}`,
  ].join("\n");
}

function renderIdentity(agent) {
  return [
    `# ${agent.name}`,
    "",
    `- Name: ${agent.name}`,
    `- Role: ${agent.role}`,
    `- Emoji: ${agent.emoji}`,
    `- Theme: ${agent.theme}`,
    ...(agent.status ? [`- Status: ${agent.status}`] : []),
  ].join("\n");
}

function renderSoul(agent, bundle) {
  if (agent.id === "main") {
    return [
      "# Squad — voice",
      "",
      `- Persona: ${bundle.coordinator.contractRole}`,
      "- Style: orchestration-aware, grounded, and explicit about hosted-runtime limits",
      `- Focus: ${bundle.coordinator.mindset || "Coordinate the team with safe hosted-runtime boundaries."}`,
    ].join("\n");
  }

  return [
    `# ${agent.name} — voice`,
    "",
    `- Persona: ${agent.role}`,
    `- Style: ${agent.profile?.workStyle?.[0] || "clear and implementation-focused"}`,
    `- Focus: ${agent.summary}`,
  ].join("\n");
}

function renderUser() {
  return [
    "# User",
    "",
    "- You are assisting the signed-in operator of this hosted openclaw-dev deployment.",
    "- Prefer the projected contract files, projected skills, and generated runtime wrappers over guesses.",
    "- Do not imply access to mutable Squad state, repo worktrees, session_store, or local editor-only tooling unless the current tool surface explicitly exposes them.",
  ].join("\n");
}

function renderTools(bundle) {
  const support = supportRoles(bundle);
  const runtime = runtimeContext();
  const skillNames = runtimeSkillNames(bundle);
  return [
    "# Tools",
    "",
    "- Browser sign-in and managed-identity model access are preserved.",
    "- Static Squad contract, charter, instruction, and skill files are projected read-only into this workspace.",
    "- Mutable Squad histories, inboxes, and logs are intentionally withheld unless a real runtime-state bridge exists.",
    ...(support.length ? [`- ${support.map((member) => member.name).join(" and ")} remain visible as system roles, not normal interactive chat agents.`] : []),
    ...(skillNames.length ? [`- OpenClaw agent skill baseline is explicitly set to: ${skillNames.join(", ")}.`] : []),
    `- Capability note: ${bundle.coordinator.hostedRuntimeNote}`,
    "- Prefer OpenClaw-native coordination tools (`agent_to_agent`, `sessions_spawn`, `subagents`, `sessions_history`, `sessions_yield`) when they are actually exposed in the current tool list.",
    `- PATH compatibility wrappers are installed for: ${runtime.wrapperCommands.join(", ")}.`,
    "- See COMMANDS.md and COMMAND_WRAPPERS.md for the hosted-safe coordination mapping.",
    "- See HOSTED_GITHUB.md for GitHub bridge status and repo-scope limits.",
    "- See HOSTED_MCP.md for preloaded-MCP rules and fallback order.",
    "- See HOSTED_SKILLS.md for projected repo playbooks and generated hosted wrapper skills.",
    "- See SURFACE_COMPATIBILITY.md for CLI vs VS Code vs hosted OpenClaw behavior differences.",
    "- If deeper repo-level coordination is required, state that this hosted runtime reflects Squad governance but does not act as the full CLI Squad orchestrator.",
  ].join("\n");
}

function renderCommands(bundle) {
  return [
    "# Hosted coordination mapping",
    "",
    "How to translate the real Squad contract's Copilot/VS Code assumptions onto hosted OpenClaw.",
    "",
    "## Tool-equivalent mapping",
    "- `task` / `runSubagent` → Prefer `agent_to_agent` for specialist delegation and `sessions_spawn` + `subagents` + `sessions_yield` for background work when the current tool surface exposes them.",
    "- `read_agent` → Prefer `sessions_history` for completed work, plus `subagents` / `sessions_list` when you need native status instead of polling a fake CLI primitive.",
    "- `ask_user` → Ask the operator directly in the current chat.",
    "- `squad_state_*` / `squad_decide` → Not mounted by default here. Report the limitation instead of pretending durable Squad state was updated.",
    "- `code` / VS Code-only flows → Not available in the hosted runtime.",
    "",
    "## Hosted-only reminders",
    "- If OpenClaw-native coordination tools are absent, use the Agents view for specialist handoffs instead of pretending a hidden CLI spawn happened.",
    "- GitHub backlog inspection depends on GitHub MCP or a token-backed gh bridge already being present.",
    "- Repo checkout, worktrees, commits, pushes, and PR execution still need a repo-connected CLI or VS Code session.",
  ].join("\n");
}

function repoMcpCatalog(bundle) {
  return Array.isArray(bundle.hostedRuntime?.mcpConfigCatalog) ? bundle.hostedRuntime.mcpConfigCatalog : [];
}

function repoMcpConfig(bundle, configPath) {
  return repoMcpCatalog(bundle).find((entry) => entry.path === configPath) || null;
}

function githubServersForConfig(config) {
  return (config?.servers || []).filter((server) => {
    const isGitHub = /github/i.test(server?.name || "")
      || /github/i.test(server?.command || "")
      || (Array.isArray(server?.args) && server.args.some((value) => /github/i.test(String(value))));
    return isGitHub && !/^EXAMPLE-/i.test(server?.name || "");
  });
}

function activeGitHubMcpServers(bundle) {
  return repoMcpCatalog(bundle)
    .flatMap((config) => (config.servers || []).map((server) => ({ config, server })))
    .filter(({ server }) => {
      const isGitHub = /github/i.test(server?.name || "")
        || /github/i.test(server?.command || "")
        || (Array.isArray(server?.args) && server.args.some((value) => /github/i.test(String(value))));
      return isGitHub && !/^EXAMPLE-/i.test(server?.name || "");
    });
}

function isGitHubBridgeWrapper(server) {
  return /^node(?:\.exe)?$/i.test(String(server?.command || "").trim())
    && Array.isArray(server?.args)
    && server.args.some((value) => /github-mcp-bridge\.mjs/i.test(String(value)));
}

function exampleGitHubMcpServers(bundle) {
  return repoMcpCatalog(bundle)
    .flatMap((config) => (config.servers || []).map((server) => ({ config, server })))
    .filter(({ server }) => /^EXAMPLE-/i.test(server?.name || ""));
}

function renderHostedGitHub(bundle) {
  const github = bundle.hostedRuntime?.github || {};
  const runtimeConfig = bundle.hostedRuntime?.runtimeConfig || {};
  const runtime = runtimeContext();
  const bridgeVar = runtime.bridgeVar;
  const ghAvailable = runtime.ghAvailable;
  const gitCredentialBridge = ghAvailable && bridgeVar ? "configured at container startup via gh auth setup-git" : "not configured";
  const activeGithubMcp = activeGitHubMcpServers(bundle);
  const runtimeGithubMcp = runtimeConfiguredGitHubMcpServers(bundle);
  const wrappedGithubMcp = activeGithubMcp.filter(({ server }) => isGitHubBridgeWrapper(server));
  const exampleGithubMcp = exampleGitHubMcpServers(bundle);
  const genericRepoMcp = repoMcpConfig(bundle, ".mcp.json");
  const copilotRepoMcp = repoMcpConfig(bundle, ".copilot/mcp-config.json");
  const genericRepoHasGitHub = githubServersForConfig(genericRepoMcp).length > 0;
  const copilotRepoHasGitHub = githubServersForConfig(copilotRepoMcp).length > 0;
  const pluginAllow = Array.isArray(runtimeConfig.allowedPlugins) ? runtimeConfig.allowedPlugins : [];
  const pluginEntries = Array.isArray(runtimeConfig.enabledPluginEntries) ? runtimeConfig.enabledPluginEntries : [];
  const pluginSummary = [...new Set([...pluginAllow, ...pluginEntries])];

  return [
    "# Hosted GitHub integration",
    "",
    `- gh CLI available in runtime: ${ghAvailable ? "yes" : "no"}`,
    `- git CLI available in runtime: ${runtime.gitAvailable ? "yes" : "no"}`,
    `- jq available for hosted gh-issues helpers: ${runtime.jqAvailable ? "yes" : "no"}`,
    `- Built-in OpenClaw /skills github prerequisite (bin:gh): ${ghAvailable ? "satisfied" : "missing"}`,
    `- Built-in OpenClaw /skills gh-issues prerequisites: ${ghAvailable && runtime.gitAvailable ? "gh + git satisfied" : "one or more required binaries missing"}`,
    `- Bundled OpenClaw GitHub skills allowlisted for hosted agents: ${hostedBundledGitHubSkillNames().join(", ")}`,
    `- Token bridge detected at startup: ${bridgeVar ? `yes (${bridgeVar})` : "no"}`,
    `- Git credential bridge: ${gitCredentialBridge}`,
    `- Hosted auth mode for gh: ${bridgeVar ? "non-interactive token bridge" : "GH_PROMPT_DISABLED without a token bridge; interactive login should be treated as unavailable"}`,
    `- Repo-shipped active GitHub MCP entries: ${activeGithubMcp.length ? activeGithubMcp.map(({ server, config }) => `${server.name} (${config.path})`).join(", ") : "none"}`,
    `- OpenClaw runtime-configured, reviewed GitHub MCP server packages: ${runtimeGithubMcp.length ? runtimeGithubMcp.map((server) => `${server.name} (${server.command || "command?"}${Array.isArray(server.args) && server.args.length ? ` ${server.args.join(" ")}` : ""})`).join(", ") : "none"}`,
    ...(ghAvailable
      ? ["- Hosted image expectation: `gh` should already be present on PATH (including `/usr/local/bin/gh`) so the built-in `/skills` GitHub skill does not fall back to misleading install prompts."]
      : ["- If the built-in `/skills` GitHub skill is blocked for `bin:gh`, treat that as hosted image drift and fix the image rather than telling the operator to use Homebrew inside this Linux runtime."]),
    ...(ghAvailable
      ? [
        "- If `/skills` still shows `bin:gh` blocked even though `gh` is present, treat that as OpenClaw requirement-detection or cached negative state rather than a real missing dependency or auth failure.",
        "- Live-safe correction path: hard-refresh the Control UI `/skills` page (or reopen the browser session) and re-check. If the startup `OpenClaw hasBinary(gh)` diagnostic reports true, trust the runtime image and keep debugging requirement detection rather than install/auth.",
      ]
      : []),
    ...(!genericRepoHasGitHub && copilotRepoHasGitHub
      ? ["- Exact config split: repo-level `.mcp.json` currently declares only `squad_state`; the hosted GitHub MCP wrapper lives in `.copilot/mcp-config.json`."]
      : []),
    ...(wrappedGithubMcp.length
      ? [`- Repo GitHub MCP wrapper mode: ${bridgeVar ? "token bridge detected, so the wrapper can launch the configured, reviewed GitHub MCP server package." : "no token bridge detected, so the wrapper can only expose status-only `github_bridge_status` guidance."}`]
      : []),
    ...(exampleGithubMcp.length
      ? [`- Repo MCP config still ships example-only GitHub entries (${exampleGithubMcp.map(({ server, config }) => `${server.name} in ${config.path}`).join(", ")}), so the repo does not provide an active hosted GitHub MCP path by default.`]
      : []),
    ...(pluginSummary.length ? [`- OpenClaw runtime plugin allow-list: ${pluginSummary.join(", ")}`] : []),
    ...(!pluginSummary.some((entry) => /github|bundle-mcp/i.test(entry))
      ? ["- `src/openclaw.json` does not enable a first-class MCP/plugin bridge for GitHub, so hosted GitHub behavior stays bridge/wrapper-based rather than OpenClaw-native."]
      : []),
    ...(bridgeVar
      ? ["- Non-interactive GitHub CLI operations can use the injected token bridge when command access exists in this deployment."]
      : ["- Without GitHub MCP or a token bridge, only non-authenticated/public GitHub guidance is safe to promise from this runtime."]),
    "",
    "## Preferred access order",
    ...((github.preferredAccess || []).map((item) => `- ${item}`)),
    "",
    "## What can work here",
    ...((github.worksWhenReady || []).map((item) => `- ${item}`)),
    "",
    "## Explicit limitations",
    ...((github.limitations || []).map((item) => `- ${item}`)),
  ].join("\n");
}

function renderHostedMcp(bundle) {
  const mcp = bundle.hostedRuntime?.mcp || {};
  const configs = repoMcpCatalog(bundle);
  const configuredServers = runtimeConfiguredMcpServers(bundle);
  const genericRepoMcp = repoMcpConfig(bundle, ".mcp.json");
  const copilotRepoMcp = repoMcpConfig(bundle, ".copilot/mcp-config.json");
  const activeServers = configs
    .flatMap((config) => (config.servers || []).map((server) => ({ config, server })))
    .filter(({ server }) => !/^EXAMPLE-/i.test(server?.name || ""));
  const githubWrappers = activeServers.filter(({ server }) => isGitHubBridgeWrapper(server));
  return [
    "# Hosted MCP integration",
    "",
    "Only MCP servers that were already provisioned into this runtime/session are available here.",
    `- Repo-shipped active MCP entries: ${activeServers.length ? activeServers.map(({ server, config }) => `${server.name} (${config.path})`).join(", ") : "none"}`,
    `- OpenClaw runtime-configured MCP servers: ${configuredServers.length ? configuredServers.map((server) => server.name).join(", ") : "none"}`,
    ...(genericRepoMcp && copilotRepoMcp
      ? [`- Exact config split: \`.mcp.json\` declares ${(genericRepoMcp.servers || []).map((server) => server.name).join(", ") || "no parsed servers"}; \`.copilot/mcp-config.json\` declares ${(copilotRepoMcp.servers || []).map((server) => server.name).join(", ") || "no parsed servers"}.`]
      : []),
    ...(githubWrappers.length
      ? [`- The repo-declared GitHub MCP entry is a hosted-safe wrapper. ${githubBridgeVariable() ? "With a token bridge it can launch the configured, reviewed GitHub MCP server package." : "Without GH_TOKEN/GITHUB_TOKEN/provider-token it only reports the missing bridge via a status tool."}`]
      : []),
    ...(!activeGitHubMcpServers(bundle).length && exampleGitHubMcpServers(bundle).length
      ? ["- GitHub MCP is example-only in the committed repo config today, so hosted GitHub MCP is not enabled by default."]
      : []),
    ...(configs.length
      ? ["", "## Project-declared MCP configs", ...configs.map((entry) => `- ${entry.path}: ${(entry.servers || []).map((server) => server.name).join(", ") || "no parsed servers"}`)]
      : []),
    "",
    "## Runtime rules",
    ...((mcp.hostedRules || []).map((item) => `- ${item}`)),
    "",
    "## Known config surfaces outside this browser runtime",
    ...((mcp.configLocations || []).map((item) => `- ${item}`)),
    "",
    "## Fallback order",
    ...((mcp.fallbackOrder || []).map((item) => `- ${item}`)),
  ].join("\n");
}

function renderHostedSkills(bundle) {
  const projected = projectionSkills(bundle);
  const generated = [
    "squad-hosted-runtime",
    "hosted-openclaw-compat",
    "hosted-github-bridge",
    "hosted-mcp-bridge",
  ];
  const bundledGitHub = hostedBundledGitHubSkillNames();
  const lines = [
    "# Hosted skills",
    "",
    "Projected repo playbooks are copied into `skills/` for OpenClaw, with extra hosted wrapper skills layered on top.",
    "",
    "## Generated hosted wrapper skills",
    ...generated.map((name) => `- ${name}`),
    "",
    "## Bundled OpenClaw GitHub skills allowlisted for hosted agents",
    ...bundledGitHub.map((name) => `- ${name}`),
  ];

  if (projected.length) {
    lines.push("", "## Projected repo skills");
    for (const skill of projected.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }))) {
      lines.push(`- ${skill.name} — ${skill.path} (${skill.sourceKind})`);
    }
  }

  lines.push(
    "",
    "## Hosted-safety reminders",
    "- Bundled OpenClaw GitHub skills (`github`, `gh-issues`) only become usable here when `gh` is already on PATH in the hosted image.",
    "- Skills that assume Copilot CLI, VS Code, or mutable Squad state must be translated through HOSTED_RUNTIME.md, COMMANDS.md, and HOSTED_GITHUB.md.",
    "- The projected skills are read-only snapshots from the repo, not writable team state."
  );

  return lines.join("\n");
}

function renderSurfaceCompatibility(bundle) {
  const compatibility = bundle.hostedRuntime?.surfaceCompatibility || {};
  return [
    "# Surface compatibility",
    "",
    "How Squad behavior changes across runtime surfaces.",
    "",
    "## CLI",
    ...((compatibility.cli || []).map((item) => `- ${item}`)),
    "",
    "## VS Code",
    ...((compatibility.vscode || []).map((item) => `- ${item}`)),
    "",
    "## Hosted OpenClaw",
    ...((compatibility.hostedOpenClaw || []).map((item) => `- ${item}`)),
    "",
    "## Hard limits in hosted OpenClaw",
    ...((compatibility.hardLimits || []).map((item) => `- ${item}`)),
  ].join("\n");
}

function renderCommandWrappers() {
  const runtime = runtimeContext();
  return [
    "# Hosted command wrappers",
    "",
    "These wrapper commands are installed on PATH so Copilot/VS Code-specific shell invocations fail clearly instead of mysteriously.",
    "",
    "## Wrapper inventory",
    ...runtime.wrapperCommands.map((name) => `- ${name}`),
    "",
    "## Mapping",
    "- `task` / `runSubagent` → use `agent_to_agent` for specialist delegation and `sessions_spawn` + `subagents` + `sessions_yield` for background work when available; otherwise route via the Agents view.",
    "- `read_agent` → use `sessions_history`, `sessions_list`, or `subagents` when available.",
    "- `ask_user` → ask the operator directly in the current chat.",
    "- `squad_state_*` / `squad_decide` / `squad` → report that the durable Squad state bridge is not mounted in hosted OpenClaw.",
    "- `code` / `codium` / `copilot` → editor-local tooling, not present here.",
  ].join("\n");
}

function renderSourceIndex(bundle) {
  const docs = projectionDocuments(bundle);
  const skills = projectionSkills(bundle);
  const mcpConfigs = projectionMcpConfigs(bundle);
  const lines = [
    "# Source index",
    "",
    "Projected static contract files and skills copied from the repo into this hosted workspace.",
  ];

  if (docs.length) {
    lines.push("", "## Projected documents");
    for (const doc of docs) {
      lines.push(`- ${doc.path}${doc.label ? ` — ${doc.label}` : ""}`);
    }
  }

  if (skills.length) {
    lines.push("", "## Projected skills");
    for (const skill of skills) {
      lines.push(`- ${skill.path} → skills/${skill.name}/SKILL.md`);
    }
  }

  if (mcpConfigs.length) {
    lines.push("", "## Projected MCP config files");
    for (const config of mcpConfigs) {
      lines.push(`- ${config.path}`);
    }
  }

  return lines.join("\n");
}

function renderSkillsIndex(bundle) {
  const skills = projectionSkills(bundle);
  const bundledGitHub = hostedBundledGitHubSkillNames();
  return [
    "# Skills index",
    "",
    "Generated hosted wrapper skills are layered on top of the projected repo skills in `skills/`.",
    "",
    "## Generated hosted wrapper skills",
    "- squad-hosted-runtime",
    "- hosted-openclaw-compat",
    "- hosted-github-bridge",
    "- hosted-mcp-bridge",
    "",
    "## Bundled OpenClaw GitHub skills allowlisted for hosted agents",
    ...bundledGitHub.map((name) => `- ${name}`),
    "",
    "## Projected repo skills",
    ...(skills.length
      ? skills.map((skill) => `- ${skill.name} — ${skill.path} (${skill.sourceKind})`)
      : ["- No repo skills were bundled into this hosted runtime."]),
  ].join("\n");
}

function renderGeneratedHostedSkill(bundle) {
  const projectedNames = projectionSkills(bundle).map((skill) => skill.name).join(", ");
  return [
    "---",
    'name: "squad-hosted-runtime"',
    'description: "Use the projected Squad contract and hosted wrapper docs inside OpenClaw"',
    'domain: "hosted-runtime"',
    'confidence: "high"',
    'source: "generated"',
    "---",
    "",
    "## Context",
    "This OpenClaw deployment projects the repo's real Squad contract, charters, template references, and skills into each agent workspace as read-only files.",
    "",
    "## Patterns",
    "- Start with COORDINATOR_CONTRACT.md, TEAM.md, ROUTING.md, CEREMONIES.md, HOSTED_RUNTIME.md, and SOURCE_INDEX.md.",
    "- Read TEAM.md / ROUTING.md / CHARTERS/ when you need the literal project contract instead of a summary.",
    `- The following repo skills are projected into skills/: ${projectedNames || "none"}.`,
    "- Use the generated hosted wrapper skills before following any Copilot CLI or VS Code-specific instruction literally.",
    "",
    "## Anti-Patterns",
    "- Do not claim the projected docs are writable repo state.",
    "- Do not skip the hosted wrapper docs and then guess how Copilot or VS Code behavior translates here.",
  ].join("\n");
}

function renderHostedCompatSkill() {
  return [
    "---",
    'name: "hosted-openclaw-compat"',
    'description: "Translate Copilot CLI and VS Code assumptions onto hosted OpenClaw"',
    'domain: "runtime-compatibility"',
    'confidence: "high"',
    'source: "generated"',
    "---",
    "",
    "## Context",
    "The real Squad contract talks about GitHub Copilot CLI tools (`task`, `read_agent`, `ask_user`), VS Code (`runSubagent`), and runtime state bridges that are not natively present in hosted OpenClaw.",
    "",
    "## Patterns",
    "- Prefer `agent_to_agent` for specialist consultation/delegation when the current tool list exposes it.",
    "- Prefer `sessions_spawn` + `subagents` + `sessions_yield` for background or parallel work, and `sessions_history` for transcript recall.",
    "- If OpenClaw-native coordination tools are absent, route work by telling the operator which specialist to open in the Agents view. Be explicit that the handoff is manual.",
    "- Ask the operator directly instead of searching for an `ask_user` primitive.",
    "- Treat `squad_state_*`, `squad_decide`, `memory.*`, `session_store`, and local editor integrations as unavailable unless the current tool list explicitly proves otherwise.",
    "",
    "## Anti-Patterns",
    "- Do not pretend a background spawn, `read_agent` poll, or durable state write happened when no such tool exists.",
    "- Do not tell the operator to use VS Code-only or Copilot CLI-only features from inside the hosted browser session.",
  ].join("\n");
}

function renderHostedGitHubSkill(bundle) {
  const runtime = runtimeContext();
  const runtimeConfig = bundle.hostedRuntime?.runtimeConfig || {};
  const activeGithubMcp = activeGitHubMcpServers(bundle);
  const runtimeGithubMcp = runtimeConfiguredGitHubMcpServers(bundle);
  const wrappedGithubMcp = activeGithubMcp.filter(({ server }) => isGitHubBridgeWrapper(server));
  const exampleGithubMcp = exampleGitHubMcpServers(bundle);
  const genericRepoHasGitHub = githubServersForConfig(repoMcpConfig(bundle, ".mcp.json")).length > 0;
  const copilotRepoHasGitHub = githubServersForConfig(repoMcpConfig(bundle, ".copilot/mcp-config.json")).length > 0;
  const pluginSummary = [...new Set([
    ...(Array.isArray(runtimeConfig.allowedPlugins) ? runtimeConfig.allowedPlugins : []),
    ...(Array.isArray(runtimeConfig.enabledPluginEntries) ? runtimeConfig.enabledPluginEntries : []),
  ].filter(Boolean))];
  return [
    "---",
    'name: "hosted-github-bridge"',
    'description: "Use hosted-safe GitHub access patterns in OpenClaw"',
    'domain: "github-integration"',
    'confidence: "high"',
    'source: "generated"',
    "---",
    "",
    "## Context",
    `The hosted runtime has gh installed: ${runtime.ghAvailable ? "yes" : "no"}.`,
    `The hosted runtime has git installed: ${runtime.gitAvailable ? "yes" : "no"}.`,
    `The hosted runtime has jq installed: ${runtime.jqAvailable ? "yes" : "no"}.`,
    `The built-in OpenClaw \`/skills\` GitHub skill sees \`bin:gh\` as ${runtime.ghAvailable ? "satisfied" : "missing"}.`,
    `The built-in OpenClaw \`/skills\` gh-issues skill sees its binary prerequisites as ${runtime.ghAvailable && runtime.gitAvailable ? "satisfied" : "missing one or more required binaries"}.`,
    `The hosted runtime has a GitHub token bridge at startup: ${runtime.bridgeVar ? runtime.bridgeVar : "no"}.`,
    `The hosted runtime allowlists these bundled OpenClaw GitHub skills: ${hostedBundledGitHubSkillNames().join(", ")}.`,
    `The repo ships active GitHub MCP entries: ${activeGithubMcp.length ? activeGithubMcp.map(({ server }) => server.name).join(", ") : "none"}.`,
    `The OpenClaw runtime config enables GitHub MCP servers: ${runtimeGithubMcp.length ? runtimeGithubMcp.map((server) => server.name).join(", ") : "none"}.`,
    ...(runtime.ghAvailable ? ["If the UI still says `bin:gh` is missing, the likely problem is OpenClaw requirement detection or cached negative state rather than missing auth or a missing binary."] : []),
    ...(!genericRepoHasGitHub && copilotRepoHasGitHub ? ["In this repo, the generic `.mcp.json` stays `squad_state`-only; the hosted GitHub bridge is declared in `.copilot/mcp-config.json`."] : []),
    ...(wrappedGithubMcp.length ? [`The repo's GitHub MCP entry is a wrapper; ${runtime.bridgeVar ? "with the token bridge it can start the configured, reviewed GitHub MCP server package." : "without the token bridge it only exposes status guidance."}`] : []),
    ...(exampleGithubMcp.length ? [`The committed repo MCP config still carries example-only GitHub entries: ${exampleGithubMcp.map(({ server }) => server.name).join(", ")}.`] : []),
    ...(pluginSummary.length ? [`The OpenClaw runtime plugin allow-list is: ${pluginSummary.join(", ")}.`] : []),
    "",
    "## Patterns",
    "- Prefer the bundled OpenClaw `/skills` GitHub surfaces (`github`, `gh-issues`) once their binary prerequisites are satisfied.",
    "- Prefer GitHub MCP tools when they are already exposed in the current session.",
    "- Treat the built-in OpenClaw `/skills` GitHub card as usable only when `gh` is already on PATH; in this hosted image that should be preinstalled, not user-installed with brew.",
    "- If `gh` is present but the `/skills` card still shows `bin:gh` missing, refresh/restart the hosted runtime and inspect the startup `OpenClaw hasBinary(gh)` diagnostic before debugging auth.",
    "- Otherwise use `gh` for issues, PRs, labels, comments, and metadata only when a token bridge exists.",
    "- Treat clone/branch/push/PR-from-branch workflows as repo-connected tasks that still need a mounted checkout and authenticated git surface.",
    "",
    "## Anti-Patterns",
    "- Do not promise GitHub write actions when no GH_TOKEN/GITHUB_TOKEN/provider-token bridge exists.",
    "- Do not tell the operator to click a Homebrew install action from the hosted Linux runtime when the built-in skill is blocked for `bin:gh`.",
    "- Do not misdiagnose a `bin:gh` blocker as an auth failure when `gh` is already present and authenticated in the hosted runtime.",
    "- Do not claim multi-account gh switching, shell-profile setup, or interactive `gh auth login` flows are available here.",
  ].join("\n");
}

function renderHostedMcpSkill(bundle) {
  const configs = repoMcpCatalog(bundle);
  const configuredServers = runtimeConfiguredMcpServers(bundle);
  const configSummary = configs.length
    ? configs.map((entry) => `${entry.path}: ${(entry.servers || []).map((server) => server.name).join(", ") || "no parsed servers"}`).join("; ")
    : "none";
  const githubWrapperPresent = configs.some((entry) => (entry.servers || []).some((server) => isGitHubBridgeWrapper(server)));
  const genericRepoMcp = repoMcpConfig(bundle, ".mcp.json");
  const copilotRepoMcp = repoMcpConfig(bundle, ".copilot/mcp-config.json");
  return [
    "---",
    'name: "hosted-mcp-bridge"',
    'description: "Handle MCP expectations safely in hosted OpenClaw"',
    'domain: "mcp-integration"',
    'confidence: "high"',
    'source: "generated"',
    "---",
    "",
    "## Context",
    `The repo declares these MCP configs: ${configSummary}.`,
    `The OpenClaw runtime config enables these MCP servers: ${configuredServers.length ? configuredServers.map((server) => server.name).join(", ") : "none"}.`,
    ...(genericRepoMcp && copilotRepoMcp
      ? [`Use the exact split: \`.mcp.json\` is ${(genericRepoMcp.servers || []).map((server) => server.name).join(", ") || "empty"}, while \`.copilot/mcp-config.json\` is ${(copilotRepoMcp.servers || []).map((server) => server.name).join(", ") || "empty"}.`]
      : []),
    ...(githubWrapperPresent
      ? [`The repo-declared GitHub MCP path is a hosted-safe wrapper; ${githubBridgeVariable() ? "the current runtime has a token bridge, so it may be able to launch the configured, reviewed GitHub MCP server package." : "without GH_TOKEN/GITHUB_TOKEN/provider-token it should be treated as status-only guidance."}`]
      : []),
    ...(!activeGitHubMcpServers(bundle).length && exampleGitHubMcpServers(bundle).length
      ? ["GitHub MCP is example-only in the committed repo config, so it should be treated as unavailable unless the current session explicitly exposes a real GitHub MCP tool."]
      : []),
    "",
    "## Patterns",
    "- Treat projected MCP configs as documentation, not proof that the current session has those tools.",
    "- If a desired MCP tool is visible in the current tool list, use it.",
    "- If the tool is absent, fall back to gh, az, filesystem, or an explicit limitation statement.",
    "- The `squad_state` MCP bridge is not mounted by default in hosted OpenClaw; do not claim durable Squad-state writes unless the real tool exists.",
    "",
    "## Anti-Patterns",
    "- Do not tell the operator to edit `.copilot/mcp-config.json`, `.mcp.json`, or VS Code config from inside the browser session and pretend the session auto-reloaded them.",
    "- Do not silently assume GitHub, Azure, Trello, or Aspire MCP servers are present because the repo documents them.",
  ].join("\n");
}

function projectedWorkspaceDocuments(bundle, agent) {
  const documents = [
    [".github/agents/squad.agent.md", "COORDINATOR_CONTRACT.md"],
    [".github/copilot-instructions.md", "COPILOT_INSTRUCTIONS.md"],
    [".github/agents/openclaw-on-azure.agent.md", "OPENCLAW_ON_AZURE_AGENT.md"],
    [".squad/team.md", "TEAM.md"],
    [".squad/routing.md", "ROUTING.md"],
    [".squad/ceremonies.md", "CEREMONIES.md"],
    [".squad/config.json", "SQUAD_CONFIG.json"],
    [".squad/identity/now.md", "PROJECT_NOW.md"],
    [".squad/identity/wisdom.md", "TEAM_WISDOM.md"],
    [".squad/rai/policy.md", "RAI_POLICY.md"],
    [".squad/templates/spawn-reference.md", "SPAWN_REFERENCE.md"],
    [".squad/templates/client-compatibility-reference.md", "CLIENT_COMPATIBILITY.md"],
    [".squad/templates/mcp-config.md", "MCP_CONFIG_REFERENCE.md"],
    [".squad/templates/worktree-reference.md", "WORKTREE_REFERENCE.md"],
    [".squad/templates/session-init-reference.md", "SESSION_INIT.md"],
    [".squad/templates/after-agent-reference.md", "AFTER_AGENT.md"],
    [".squad/templates/copilot-agent.md", "COPILOT_AGENT.md"],
    [".squad/templates/workflow-wiring-guide.md", "WORKFLOW_WIRING.md"],
    [".squad/templates/machine-capabilities.md", "MACHINE_CAPABILITIES.md"],
    [".squad/templates/ceremony-reference.md", "CEREMONY_REFERENCE.md"],
    [".squad/templates/notes-protocol.md", "NOTES_PROTOCOL.md"],
    [".squad/templates/orchestration-log.md", "ORCHESTRATION_LOG_REFERENCE.md"],
    [".squad/templates/run-output.md", "RUN_OUTPUT_REFERENCE.md"],
    [".squad/templates/multi-agent-format.md", "MULTI_AGENT_FORMAT.md"],
    ["src/openclaw.json", "OPENCLAW_RUNTIME_CONFIG.json"],
  ]
    .map(([sourcePath, relativePath]) => ({ relativePath, content: projectionText(bundle, sourcePath) }))
    .filter((entry) => entry.content);

  for (const config of projectionMcpConfigs(bundle)) {
    const relativePath = config.path === ".mcp.json" ? "REPO_MCP_CONFIG.json" : "COPILOT_MCP_CONFIG.json";
    documents.push({ relativePath, content: config.content });
  }

  for (const doc of projectionDocuments(bundle).filter((entry) => entry.category === "charter" && entry.memberName)) {
    documents.push({ relativePath: path.join("CHARTERS", `${doc.memberName}.md`), content: doc.content });
    if (agent.id !== "main" && doc.memberId === agent.id) {
      documents.push({ relativePath: "ROLE_CHARTER.md", content: doc.content });
    }
  }

  return documents;
}

function writeProjectedSkills(workspacePath, bundle) {
  const generatedSkills = [
    { name: "squad-hosted-runtime", content: renderGeneratedHostedSkill(bundle) },
    { name: "hosted-openclaw-compat", content: renderHostedCompatSkill() },
    { name: "hosted-github-bridge", content: renderHostedGitHubSkill(bundle) },
    { name: "hosted-mcp-bridge", content: renderHostedMcpSkill(bundle) },
    ...projectionSkills(bundle).map((skill) => ({ name: skill.name, content: skill.content })),
  ];

  for (const skill of generatedSkills) {
    writeText(path.join(workspacePath, "skills", skill.name, "SKILL.md"), skill.content);
  }
}

function runtimeSkillNames(bundle) {
  const names = [
    "squad-hosted-runtime",
    "hosted-openclaw-compat",
    "hosted-github-bridge",
    "hosted-mcp-bridge",
    ...hostedBundledGitHubSkillNames(),
    ...projectionSkills(bundle).map((skill) => skill.name),
  ].filter(Boolean);
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
}

function renderHeartbeat(agent, bundle) {
  return [
    `# ${agent.name} heartbeat`,
    "",
    "- Confirm hosted-runtime summaries still match the current generated Squad runtime bundle.",
    "- Confirm projected static contract files and skills are present as read-only workspace content.",
    "- Confirm mutable Squad state backends are still treated as unavailable unless real runtime tools expose them.",
    ...(agent.id === "main"
      ? [`- Confirm the roster still lists ${interactiveRoster(bundle).map((member) => member.name).join(", ")} as interactive specialists and ${supportRoles(bundle).map((member) => member.name).join(", ")} as non-interactive system roles.`]
      : [`- Confirm ${agent.name} still reflects the projected contract plus hosted wrapper docs for this browser runtime.`]),
  ].join("\n");
}

function renderCoordinatorAgents(agent, bundle) {
  return [
    "# Squad — hosted runtime coordinator",
    "",
    `> ${bundle.coordinator.description}`,
    "",
    "## Runtime provenance",
    ...((bundle.provenance?.sourceLabels || []).map((label) => `- ${label}`)),
    `- Bundle generated at: ${bundle.generatedAt}`,
    ...(bundle.provenance?.gitShortCommitSha ? [`- Commit: ${bundle.provenance.gitShortCommitSha}`] : []),
    "",
    "## Coordinator identity",
    `- Name: ${bundle.coordinator.name}`,
    `- Runtime role: ${agent.role}`,
    `- Contract role: ${bundle.coordinator.contractRole}`,
    ...(bundle.coordinator.inputs ? [`- Inputs: ${bundle.coordinator.inputs}`] : []),
    ...(bundle.coordinator.outputs ? [`- Outputs owned: ${bundle.coordinator.outputs}`] : []),
    ...(bundle.coordinator.mindset ? [`- Mindset: ${bundle.coordinator.mindset}`] : []),
    "",
    "## Hosted runtime capabilities",
    "- Explain the real Squad roster, routing ownership, project context, RAI posture, and curated governance summary.",
    "- Read the projected contract files and projected repo skills directly from this workspace.",
    "- Prefer `agent_to_agent` for specialist coordination and `sessions_spawn` / `subagents` for background work when those tools are exposed.",
    "- Direct the user to active specialists in the Agents view only when the browser runtime cannot perform the requested handoff itself.",
    "- Use generated wrappers to explain which GitHub, MCP, and skill-driven flows are safe here versus which still require a repo-connected CLI or VS Code session.",
    ...(supportRoles(bundle).length ? [`- Keep ${supportRoles(bundle).map((member) => member.name).join(" and ")} visible as system roles without presenting them as normal chat agents.`] : []),
    `- Limitation: ${bundle.coordinator.hostedRuntimeNote}`,
    "",
    "## Guardrails",
    ...((bundle.coordinator.guardrails || []).map((item) => `- ${item}`)),
    "",
    "## Inspectable generated files",
    "- HOSTED_RUNTIME.md",
    "- COORDINATOR_CONTRACT.md",
    "- TEAM.md / ROUTING.md / CEREMONIES.md",
    "- CHARTERS/",
    "- COMMANDS.md",
    "- COMMAND_WRAPPERS.md",
    "- HOSTED_GITHUB.md",
    "- HOSTED_MCP.md",
    "- HOSTED_SKILLS.md",
    "- SURFACE_COMPATIBILITY.md",
    "- OPENCLAW_RUNTIME_CONFIG.json / COPILOT_MCP_CONFIG.json",
    "- skills/",
    "- PROVENANCE.md",
  ].join("\n");
}

function renderSpecialistAgents(agent, bundle) {
  return [
    `# ${agent.name} — hosted runtime specialist`,
    "",
    `> ${agent.summary}`,
    "",
    "## Hosted runtime contract",
    `- Role: ${agent.role}`,
    `- Status: ${agent.status}`,
    "- This profile is backed by read-only projected contract files, charters, and repo skills.",
    "- Use the generated wrapper docs to explain GitHub, MCP, and skill-compatibility limits instead of guessing.",
    `- Limitation: ${bundle.coordinator.hostedRuntimeNote}`,
    "",
    "## Inspectable generated files",
    "- HOSTED_RUNTIME.md",
    "- ROLE_CHARTER.md",
    "- CHARTERS/",
    "- COMMANDS.md",
    "- COMMAND_WRAPPERS.md",
    "- HOSTED_GITHUB.md",
    "- HOSTED_MCP.md",
    "- HOSTED_SKILLS.md",
    "- SURFACE_COMPATIBILITY.md",
    "- OPENCLAW_RUNTIME_CONFIG.json / COPILOT_MCP_CONFIG.json",
    "- skills/",
    "- ROLE_PROFILE.md",
    "- PROVENANCE.md",
  ].join("\n");
}

function syncAgentAuthArtifacts(stateRoot, agentIds) {
  const mainAgentDir = path.join(stateRoot, "agents", "main", "agent");
  const trackedFiles = ["auth-profiles.json", "auth-state.json", "models.json"];
  const availableFiles = trackedFiles.filter((fileName) => fs.existsSync(path.join(mainAgentDir, fileName)));
  if (!availableFiles.length) {
    return [];
  }

  const syncedAgents = [];
  for (const agentId of agentIds) {
    if (!agentId || agentId === "main") {
      continue;
    }

    const targetDir = path.join(stateRoot, "agents", agentId, "agent");
    ensureDir(targetDir);
    let copiedAny = false;
    for (const fileName of availableFiles) {
      const sourcePath = path.join(mainAgentDir, fileName);
      const targetPath = path.join(targetDir, fileName);
      if (fs.existsSync(targetPath)) {
        continue;
      }
      fs.copyFileSync(sourcePath, targetPath);
      copiedAny = true;
    }

    if (copiedAny) {
      syncedAgents.push(agentId);
    }
  }

  return syncedAgents;
}

function writeWorkspaceFiles(workspacePath, agent, bundle) {
  removeLegacyFiles(workspacePath);
  materializeProjection(workspacePath, bundle);

  writeText(path.join(workspacePath, "AGENTS.md"), agent.id === "main" ? renderCoordinatorAgents(agent, bundle) : renderSpecialistAgents(agent, bundle));
  writeText(path.join(workspacePath, "IDENTITY.md"), renderIdentity(agent));
  writeText(path.join(workspacePath, "SOUL.md"), renderSoul(agent, bundle));
  writeText(path.join(workspacePath, "USER.md"), renderUser());
  writeText(path.join(workspacePath, "TOOLS.md"), renderTools(bundle));
  writeText(path.join(workspacePath, "COMMANDS.md"), renderCommands(bundle));
  writeText(path.join(workspacePath, "COMMAND_WRAPPERS.md"), renderCommandWrappers());
  writeText(path.join(workspacePath, "HOSTED_GITHUB.md"), renderHostedGitHub(bundle));
  writeText(path.join(workspacePath, "HOSTED_MCP.md"), renderHostedMcp(bundle));
  writeText(path.join(workspacePath, "HOSTED_SKILLS.md"), renderHostedSkills(bundle));
  writeText(path.join(workspacePath, "SURFACE_COMPATIBILITY.md"), renderSurfaceCompatibility(bundle));
  writeText(path.join(workspacePath, "HEARTBEAT.md"), renderHeartbeat(agent, bundle));
  writeText(path.join(workspacePath, "HOSTED_RUNTIME.md"), renderHostedRuntime(agent, bundle));
  writeText(path.join(workspacePath, "PROJECT_CONTEXT.md"), renderProjectContext(bundle));
  writeText(path.join(workspacePath, "ROSTER.md"), renderRoster(bundle));
  writeText(path.join(workspacePath, "ROUTING_OWNERSHIP.md"), renderRoutingOwnership(bundle, agent.id === "main" ? "" : agent.name));
  writeText(path.join(workspacePath, "DECISION_SUMMARY.md"), renderDecisionSummary(bundle, agent.id === "main" ? "" : agent.name));
  writeText(path.join(workspacePath, "RAI_POLICY_SUMMARY.md"), renderRaiPolicySummary(bundle));
  writeText(path.join(workspacePath, "MEMBER_PROFILES.md"), renderMemberProfiles(bundle));
  writeText(path.join(workspacePath, "SOURCE_INDEX.md"), renderSourceIndex(bundle));
  writeText(path.join(workspacePath, "SKILLS_INDEX.md"), renderSkillsIndex(bundle));
  writeText(path.join(workspacePath, "PROVENANCE.md"), renderProvenance(bundle));

  for (const document of projectedWorkspaceDocuments(bundle, agent)) {
    writeText(path.join(workspacePath, document.relativePath), document.content);
  }
  writeProjectedSkills(workspacePath, bundle);

  if (agent.id !== "main") {
    writeText(path.join(workspacePath, "ROLE_PROFILE.md"), renderRoleProfile(agent.profile, bundle));
  }
}

function patchConfig(config, bundle, stateRoot, workspacePaths) {
  const existingAgents = config.agents && typeof config.agents === "object" ? config.agents : {};
  const existingDefaults = existingAgents.defaults && typeof existingAgents.defaults === "object" ? existingAgents.defaults : {};
  const previousList = Array.isArray(existingAgents.list) ? existingAgents.list.filter(Boolean) : [];
  const previousById = new Map(previousList.map((entry) => [entry.id, entry]));
  const managed = runtimeAgents(bundle);
  const managedAgentIds = managed.map((agent) => agent.id);
  const managedIds = new Set(managedAgentIds);
  const preserved = previousList.filter((entry) => !managedIds.has(entry.id)).map((entry) => ({ ...entry, default: false }));
  const projectedSkillNames = runtimeSkillNames(bundle);
  const existingTools = config.tools && typeof config.tools === "object" ? config.tools : {};
  const existingAgentToAgent = existingTools.agentToAgent && typeof existingTools.agentToAgent === "object" ? existingTools.agentToAgent : {};
  const existingSession = config.session && typeof config.session === "object" ? config.session : {};
  const existingSessionAgentToAgent = existingSession.agentToAgent && typeof existingSession.agentToAgent === "object"
    ? existingSession.agentToAgent
    : {};
  const existingPlugins = config.plugins && typeof config.plugins === "object" ? config.plugins : {};
  const existingPluginEntries = existingPlugins.entries && typeof existingPlugins.entries === "object" ? existingPlugins.entries : {};
  const existingSkills = config.skills && typeof config.skills === "object" ? config.skills : {};
  const existingSkillEntries = existingSkills.entries && typeof existingSkills.entries === "object" ? existingSkills.entries : {};
  const existingMcp = config.mcp && typeof config.mcp === "object" ? config.mcp : {};
  const existingMcpServers = existingMcp.servers && typeof existingMcp.servers === "object" ? existingMcp.servers : {};

  config.tools = {
    ...existingTools,
    agentToAgent: {
      ...existingAgentToAgent,
      enabled: true,
      allow: mergeAllowedAgentIds(existingAgentToAgent.allow, managedAgentIds),
    },
  };

  config.session = {
    ...existingSession,
    agentToAgent: {
      ...existingSessionAgentToAgent,
      maxPingPongTurns: Math.max(Number(existingSessionAgentToAgent.maxPingPongTurns || 0) || 0, 8),
    },
  };

  config.plugins = {
    ...existingPlugins,
    enabled: existingPlugins.enabled !== false,
    allow: Array.isArray(existingPlugins.allow) ? existingPlugins.allow : [],
    entries: {
      ...existingPluginEntries,
    },
  };

  config.skills = {
    ...existingSkills,
    entries: {
      ...existingSkillEntries,
      github: {
        ...(existingSkillEntries.github && typeof existingSkillEntries.github === "object" ? existingSkillEntries.github : {}),
        enabled: true,
      },
      "gh-issues": {
        ...(existingSkillEntries["gh-issues"] && typeof existingSkillEntries["gh-issues"] === "object" ? existingSkillEntries["gh-issues"] : {}),
        enabled: true,
      },
    },
  };

  config.mcp = {
    ...existingMcp,
    servers: {
      ...existingMcpServers,
      github: {
        ...(existingMcpServers.github && typeof existingMcpServers.github === "object" ? existingMcpServers.github : {}),
        command: "node",
        args: ["/opt/openclaw-squad/github-mcp-bridge.mjs"],
      },
    },
  };

  config.agents = {
    ...existingAgents,
    defaults: {
      ...existingDefaults,
      skills: projectedSkillNames,
    },
    list: [
      ...managed.map((agent) => {
        const previous = previousById.get(agent.id) || {};
        const previousIdentity = previous.identity && typeof previous.identity === "object" ? previous.identity : {};
        return {
          ...previous,
          id: agent.id,
          name: agent.name,
          default: agent.id === "main",
          workspace: workspacePaths.get(agent.id),
          agentDir: path.join(stateRoot, "agents", agent.id, "agent"),
          identity: {
            ...previousIdentity,
            name: agent.name,
            emoji: agent.emoji,
            theme: agent.theme,
          },
          skills: projectedSkillNames,
          subagents: {
            ...(previous.subagents && typeof previous.subagents === "object" ? previous.subagents : {}),
            allowAgents: mergeAllowedAgentIds(previous.subagents?.allowAgents, managedAgentIds),
          },
        };
      }),
      ...preserved,
    ],
  };

  return config;
}

function cleanControlUi(controlUiPath) {
  if (!controlUiPath || !fs.existsSync(controlUiPath)) {
    return false;
  }

  const controlDir = path.dirname(controlUiPath);
  removePath(path.join(controlDir, "openclaw-squad-runtime-banner.json"));
  removePath(path.join(controlDir, "openclaw-squad-runtime-banner.js"));

  const html = fs.readFileSync(controlUiPath, "utf8");
  const cleaned = html
    .replace(/\s*<!-- openclaw-squad-runtime:start -->[\s\S]*?<!-- openclaw-squad-runtime:end -->\s*/g, "\n")
    .replace(/\s*<script\b(?=[^>]*(?:data-openclaw-squad-runtime|openclaw-squad-runtime-banner\.js))[^>]*><\/script>\s*/gi, "\n")
    .replace(/\s*<link\b(?=[^>]*(?:data-openclaw-squad-runtime|openclaw-squad-runtime-banner\.css))[^>]*>\s*/gi, "\n")
    .replace(/\s*<style\b[^>]*data-openclaw-squad-runtime[^>]*>[\s\S]*?<\/style>\s*/gi, "\n");
  const changed = cleaned !== html;
  if (changed) {
    fs.writeFileSync(controlUiPath, cleaned, "utf8");
  }
  return changed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = readJson(path.join(options.seedDir, "runtime-bundle.json"));
  const config = readJson(options.configPath);
  const workspacePaths = new Map();

  for (const agent of runtimeAgents(bundle)) {
    const workspacePath = path.resolve(options.stateRoot, agent.workspaceSubdir);
    ensureDir(workspacePath);
    writeWorkspaceFiles(workspacePath, agent, bundle);
    workspacePaths.set(agent.id, workspacePath);
  }

  patchConfig(config, bundle, options.stateRoot, workspacePaths);
  writeJson(options.configPath, config);
  const authSynced = syncAgentAuthArtifacts(options.stateRoot, runtimeAgents(bundle).map((agent) => agent.id));

  const controlUiCleaned = cleanControlUi(options.controlUi);

  if (!options.quiet) {
    console.log(`[squad-runtime] seeded agents: ${runtimeAgents(bundle).map((agent) => agent.name).join(", ")}`);
    const background = bundle.roster.filter((member) => !member.interactive).map((member) => member.name);
    if (background.length) {
      console.log(`[squad-runtime] loaded background roles: ${background.join(", ")}`);
    }
    if (authSynced.length) {
      console.log(`[squad-runtime] synchronized main-agent auth artifacts to: ${authSynced.join(", ")}`);
    }
    if (controlUiCleaned) {
      console.log("[squad-runtime] removed legacy Control UI Squad banner");
    }
  }
}

main();
