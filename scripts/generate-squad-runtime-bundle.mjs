import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_EMOJI = [
  [/session logger|scribe/i, "📋"],
  [/work monitor|ralph/i, "🔄"],
  [/lead|architect|tech lead/i, "🏗️"],
  [/azure platform|devops|infra|platform/i, "⚙️"],
  [/security|auth|compliance/i, "🔒"],
  [/integration|backend|api|server/i, "🔧"],
  [/qa|test|validation|quality/i, "🧪"],
  [/rai|responsible ai|safety/i, "🛡️"],
  [/coordinator/i, "🧭"],
];

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const options = {
    repoRoot,
    output: path.join(repoRoot, "src", "squad-runtime", "runtime-bundle.json"),
    gitCommit: "",
    gitShortCommit: "",
    gitDirty: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--repo-root") {
      options.repoRoot = path.resolve(argv[++index]);
    } else if (current === "--output") {
      options.output = path.resolve(argv[++index]);
    } else if (current === "--git-commit") {
      options.gitCommit = String(argv[++index] || "").trim();
    } else if (current === "--git-short-commit") {
      options.gitShortCommit = String(argv[++index] || "").trim();
    } else if (current === "--git-dirty") {
      options.gitDirty = String(argv[++index] || "").trim();
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  return options;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value).replace(/\r\n?/g, "\n"), "utf8");
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function stageHostedRuntimeAsset(repoRoot, sourceRelativePath, outputDir, outputName = path.basename(sourceRelativePath)) {
  const sourcePath = path.join(repoRoot, normalizeSourcePath(sourceRelativePath));
  if (!pathExists(sourcePath)) {
    throw new Error(`Required hosted runtime asset missing: ${sourceRelativePath}`);
  }
  const targetPath = path.join(outputDir, outputName);
  writeText(targetPath, readText(sourcePath));
  return targetPath;
}

function normalizeSourcePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return /^(1|true|yes)$/i.test(String(value).trim());
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function detectGitMetadata(options) {
  const detectedCommit = gitOutput(options.repoRoot, ["rev-parse", "HEAD"]);
  const detectedShortCommit = gitOutput(options.repoRoot, ["rev-parse", "--short", "HEAD"]);
  let detectedDirty = false;
  try {
    execFileSync("git", ["-C", options.repoRoot, "diff", "--quiet", "--ignore-submodules", "HEAD", "--"]);
  } catch {
    detectedDirty = true;
  }

  return {
    commit: options.gitCommit || detectedCommit || "unknown",
    shortCommit: options.gitShortCommit || detectedShortCommit || "unknown",
    dirty: options.gitDirty ? parseBoolean(options.gitDirty) : detectedDirty,
  };
}

function lines(text) {
  return String(text).replace(/\r\n?/g, "\n").split("\n");
}

function stripMarkdown(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^>\s*/, "")
    .trim();
}

function slugify(value) {
  return stripMarkdown(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function getSection(text, heading) {
  const sourceLines = lines(text);
  const start = sourceLines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    return "";
  }

  const level = (sourceLines[start].match(/^(#+)\s+/) || [null, ""])[1].length;
  const collected = [];
  for (let index = start + 1; index < sourceLines.length; index += 1) {
    const current = sourceLines[index];
    const match = current.match(/^(#+)\s+/);
    if (match && match[1].length <= level) {
      break;
    }
    collected.push(current);
  }

  return collected.join("\n").trimEnd();
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripMarkdown(cell));
}

function parseTable(text, heading) {
  const section = getSection(text, heading);
  const tableLines = lines(section).filter((line) => line.trim().startsWith("|"));
  if (tableLines.length < 2) {
    return [];
  }

  const headers = splitTableRow(tableLines[0]);
  const rows = [];
  for (let index = 1; index < tableLines.length; index += 1) {
    const current = tableLines[index].trim();
    if (/^\|(?:\s*:?-+:?\s*\|)+\s*$/.test(current)) {
      continue;
    }
    const values = splitTableRow(current);
    const row = {};
    headers.forEach((header, valueIndex) => {
      row[header] = values[valueIndex] || "";
    });
    if (Object.values(row).some(Boolean)) {
      rows.push(row);
    }
  }

  return rows;
}

function parseFieldList(text, heading) {
  const section = getSection(text, heading);
  const fields = {};
  for (const current of lines(section)) {
    const match = current.match(/^\s*-\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (match) {
      fields[stripMarkdown(match[1])] = stripMarkdown(match[2]);
    }
  }
  return fields;
}

function parseList(text, heading) {
  return lines(getSection(text, heading))
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((match) => stripMarkdown(match[1]))
    .filter(Boolean);
}

function parseFrontMatter(text) {
  if (!text.startsWith("---\n")) {
    return {};
  }

  const closing = text.indexOf("\n---\n", 4);
  if (closing === -1) {
    return {};
  }

  const data = {};
  for (const current of lines(text.slice(4, closing))) {
    const match = current.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      data[match[1].trim()] = stripMarkdown(match[2].trim().replace(/^"|"$/g, ""));
    }
  }
  return data;
}

function parseCoordinatorContract(text) {
  const identity = parseFieldList(text, "### Coordinator Identity");
  const version = (text.match(/<!--\s*version:\s*([^\s]+)\s*-->/i) || [null, ""])[1];
  const refusalRules = lines(getSection(text, "### Coordinator Identity"))
    .map((line) => line.match(/^\s*-\s+(.*)$/))
    .filter(Boolean)
    .map((match) => stripMarkdown(match[1]))
    .filter((line) =>
      line &&
      line !== "Refusal rules:" &&
      !line.startsWith("Name:") &&
      !line.startsWith("Version:") &&
      !line.startsWith("Role:") &&
      !line.startsWith("Inputs:") &&
      !line.startsWith("Outputs owned:") &&
      !line.startsWith("Mindset:") &&
      !line.startsWith("Greeting tip:")
    );

  return {
    name: "Squad",
    runtimeRole: "Coordinator",
    contractRole: identity.Role || "Coordinator",
    description: parseFrontMatter(text).description || "Your AI team. Describe what you're building, get a team of specialists that live in your repo.",
    version,
    inputs: (identity.Inputs || "").replace(".squad/decisions.md", "curated governance summary"),
    outputs: identity["Outputs owned"] || "",
    mindset: identity.Mindset || "",
    guardrails: refusalRules,
    hostedRuntimeNote: "In this hosted OpenClaw runtime, Squad can use real OpenClaw coordination tools such as `agent_to_agent`, `sessions_spawn`, and preloaded MCP bridges when they are actually exposed, but it must not claim Copilot CLI-only orchestration, repo worktrees, `session_store` access, or mutable Squad-state writes when those hosted equivalents are absent.",
  };
}

function parseProjectContext(text) {
  const section = getSection(text, "## Project Context");
  const fields = {};
  for (const current of lines(section)) {
    const match = current.match(/^\s*-\s+\*\*(.+?):\*\*\s*(.*)$/);
    if (match) {
      fields[stripMarkdown(match[1])] = stripMarkdown(match[2]);
    }
  }
  return {
    owner: fields.Owner || "",
    project: fields.Project || "",
    stack: fields.Stack || "",
    description: fields.Description || "",
    created: fields.Created || "",
  };
}

function parseTeam(text) {
  const coordinatorRow = parseTable(text, "## Coordinator")[0] || { Name: "Squad", Role: "Coordinator", Notes: "" };
  const members = parseTable(text, "## Members").map((row) => ({
    id: slugify(row.Name),
    name: row.Name,
    role: row.Role,
    status: row.Status,
    charterPath: row.Charter,
    interactive: !/silent|monitor/i.test(row.Status || ""),
  }));

  return {
    coordinator: {
      name: coordinatorRow.Name || "Squad",
      role: coordinatorRow.Role || "Coordinator",
      notes: coordinatorRow.Notes || "",
    },
    members,
    projectContext: parseProjectContext(text),
  };
}

function parseRouting(text) {
  return parseTable(text, "## Routing Table").map((row) => ({
    workType: row["Work Type"] || "",
    routeTo: row["Route To"] || "",
    examples: row.Examples || "",
  }));
}

function parseDecisionHeading(value) {
  const cleaned = stripMarkdown(value);
  const match = cleaned.match(/^(?:\d{4}-\d{2}-\d{2}\s+—\s+)?(D-\d+)\s+(.*)$/);
  return match ? { id: match[1], title: match[2].trim() } : { id: "", title: cleaned };
}

function parseDeciders(value) {
  return stripMarkdown(value)
    .split(/,|\band\b/iu)
    .map((item) => item.replace(/\(.*?\)/g, "").trim())
    .filter(Boolean);
}

function parseDecisions(text) {
  const activeSection = getSection(text, "## Active Decisions") || text;
  const sourceLines = lines(activeSection);
  const results = [];

  for (let index = 0; index < sourceLines.length; index += 1) {
    const headingMatch = sourceLines[index].match(/^###\s+(.*)$/);
    if (!headingMatch) {
      continue;
    }

    const heading = headingMatch[1];
    const block = [];
    for (let inner = index + 1; inner < sourceLines.length; inner += 1) {
      if (/^###\s+/.test(sourceLines[inner]) || /^##\s+/.test(sourceLines[inner])) {
        break;
      }
      block.push(sourceLines[inner]);
    }

    const title = parseDecisionHeading(heading);
    const blockText = block.join("\n");
    const status = stripMarkdown((blockText.match(/-\s+\*\*Status:\*\*\s*(.*)/u) || [null, ""])[1]);
    const deciders = parseDeciders((blockText.match(/-\s+\*\*Deciders?:\*\*\s*(.*)/u) || [null, ""])[1]);
    results.push({ id: title.id, title: title.title, status, deciders });
  }

  return results;
}

function parseCharter(text, fallbackName, fallbackRole) {
  const sourceLines = lines(text);
  const title = stripMarkdown((sourceLines.find((line) => line.startsWith("# ")) || "").replace(/^#\s+/, ""));
  const name = parseFieldList(text, "## Identity").Name || title.split(" — ")[0] || fallbackName;
  const role = parseFieldList(text, "## Identity").Role || title.split(" — ")[1] || fallbackRole;
  let bio = "";
  for (let index = 1; index < sourceLines.length; index += 1) {
    const current = sourceLines[index].trim();
    if (!current) continue;
    if (/^##\s+/.test(current)) break;
    bio = stripMarkdown(current);
    break;
  }

  const identity = parseFieldList(text, "## Identity");
  return {
    name,
    role,
    bio,
    expertise: identity.Expertise || "",
    style: identity.Style || "",
    responsibilities: parseList(text, "## What I Own"),
    workStyle: parseList(text, "## How I Work"),
    boundaries: parseList(text, "## Boundaries"),
  };
}

function extractHandoffTags(entry, teamNames) {
  const haystack = [
    ...(entry.workStyle || []),
    ...(entry.boundaries || []),
    ...(entry.responsibilities || []),
  ].join(" ");

  return teamNames.filter((name) => name !== entry.name && new RegExp(`\\b${name}\\b`, "i").test(haystack));
}

function emojiForRole(role, name) {
  const candidate = `${role || ""} ${name || ""}`;
  for (const [pattern, emoji] of ROLE_EMOJI) {
    if (pattern.test(candidate)) {
      return emoji;
    }
  }
  return "👤";
}

function summarizePolicyHeadings(text, heading) {
  const section = getSection(text, heading);
  const results = [];
  for (const current of lines(section)) {
    const match = current.match(/^###\s+(.*)$/);
    if (match) {
      results.push(stripMarkdown(match[1]));
    }
  }
  return results;
}

function parseRaiPolicy(text) {
  return {
    principles: lines(getSection(text, "## Principles"))
      .map((line) => line.match(/^\s*\d+\.\s+(.*)$/))
      .filter(Boolean)
      .map((match) => stripMarkdown(match[1])),
    blockedCategories: summarizePolicyHeadings(text, "## Critical Violations (🔴 — Always Blocked)"),
    advisoryCategories: summarizePolicyHeadings(text, "## Advisory Concerns (🟡 — Flagged, Not Blocked)"),
    terminology: parseTable(text, "## Terminology Standards")
      .slice(0, 6)
      .map((row) => ({ avoid: row.Avoid || "", prefer: row.Prefer || "" })),
  };
}

function systemRoleSummary(record) {
  if (record.id === "scribe") {
    return {
      ...record,
      emoji: "📋",
      runtimeExposure: "system",
      publicBio: "System documentation role that records orchestration outcomes and governance history for the team.",
      responsibilities: [
        "Maintain orchestration logs and decision records for the project.",
        "Provide provenance visibility without acting as a normal hosted chat specialist.",
      ],
      handoffTags: ["Squad", "Ripley"],
    };
  }

  if (record.id === "ralph") {
    return {
      ...record,
      emoji: "🔄",
      runtimeExposure: "system",
      publicBio: "System monitoring role that watches backlog and keep-working flow for the team.",
      responsibilities: [
        "Monitor work continuity and backlog follow-through signals.",
        "Remain visible for provenance without becoming a normal hosted chat specialist.",
      ],
      handoffTags: ["Squad", "Ripley"],
    };
  }

  if (record.id === "rai") {
    return {
      ...record,
      runtimeExposure: "interactive",
      publicBio: "Responsible AI reviewer for hosted runtime safety posture.",
      expertise: "Responsible AI policy, content safety, privacy, and release-risk awareness",
      responsibilities: [
        "Surface the runtime's safety principles and blocked content categories.",
        "Call out policy red flags for hosted user-facing behavior.",
      ],
      handoffTags: ["Parker", "Ripley"],
    };
  }

  return {
    ...record,
    runtimeExposure: record.interactive ? "interactive" : "system",
  };
}

function collectProjectionDocuments(repoRoot, team) {
  const documents = [];
  const seen = new Set();

  const addDocument = (relativePath, label, category, extra = {}) => {
    const sourcePath = normalizeSourcePath(relativePath);
    if (!sourcePath || seen.has(sourcePath)) {
      return;
    }
    const absolutePath = path.join(repoRoot, sourcePath);
    if (!pathExists(absolutePath)) {
      return;
    }
    seen.add(sourcePath);
    documents.push({
      path: sourcePath,
      label,
      category,
      content: readText(absolutePath),
      ...extra,
    });
  };

  [
    [".github/agents/squad.agent.md", "Squad coordinator contract", "contract"],
    [".github/copilot-instructions.md", "GitHub Copilot instructions", "copilot-instructions"],
    [".github/agents/openclaw-on-azure.agent.md", "OpenClaw-on-Azure agent contract", "agent-instruction"],
    [".squad/config.json", "Squad config", "config"],
    [".squad/team.md", "Team roster and project context", "team"],
    [".squad/routing.md", "Routing ownership map", "routing"],
    [".squad/ceremonies.md", "Ceremony configuration", "ceremonies"],
    [".squad/identity/now.md", "Current focus snapshot", "identity"],
    [".squad/identity/wisdom.md", "Team wisdom snapshot", "identity"],
    [".squad/rai/policy.md", "RAI policy", "rai-policy"],
    [".squad/templates/spawn-reference.md", "Spawn reference", "template"],
    [".squad/templates/client-compatibility-reference.md", "Client compatibility reference", "template"],
    [".squad/templates/mcp-config.md", "MCP configuration reference", "template"],
    [".squad/templates/worktree-reference.md", "Worktree reference", "template"],
    [".squad/templates/session-init-reference.md", "Session init reference", "template"],
    [".squad/templates/after-agent-reference.md", "After-agent reference", "template"],
    [".squad/templates/copilot-agent.md", "Copilot coding-agent member reference", "template"],
    [".squad/templates/workflow-wiring-guide.md", "Workflow wiring guide", "template"],
    [".squad/templates/machine-capabilities.md", "Machine capabilities reference", "template"],
    [".squad/templates/ceremony-reference.md", "Ceremony reference", "template"],
    [".squad/templates/notes-protocol.md", "Notes protocol reference", "template"],
    [".squad/templates/orchestration-log.md", "Orchestration log reference", "template"],
    [".squad/templates/run-output.md", "Run-output reference", "template"],
    [".squad/templates/multi-agent-format.md", "Multi-agent artifact reference", "template"],
    ["scripts/github-mcp-bridge.mjs", "GitHub MCP bridge wrapper", "runtime-script"],
    ["src/openclaw.json", "OpenClaw runtime config", "runtime-config"],
  ].forEach(([relativePath, label, category]) => addDocument(relativePath, label, category));

  for (const member of team.members) {
    const charterPath = normalizeSourcePath(member.charterPath);
    if (!charterPath || charterPath === "—") {
      continue;
    }
    addDocument(charterPath, `${member.name} charter`, "charter", {
      memberId: member.id,
      memberName: member.name,
      memberRole: member.role,
    });
  }

  return documents;
}

function collectProjectedSkills(repoRoot) {
  const sources = [
    { base: "skills", sourceKind: "repo-skill", precedence: 0 },
    { base: ".copilot/skills", sourceKind: "copilot-skill", precedence: 1 },
    { base: ".squad/templates/skills", sourceKind: "template-skill", precedence: 2 },
  ];
  const results = [];
  const seen = new Set();

  for (const source of sources) {
    const absoluteBase = path.join(repoRoot, source.base);
    if (!pathExists(absoluteBase)) {
      continue;
    }

    const entries = fs.readdirSync(absoluteBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillName = entry.name.trim();
      if (!skillName) {
        continue;
      }
      const dedupeKey = skillName.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      const relativePath = normalizeSourcePath(path.join(source.base, skillName, "SKILL.md"));
      const absolutePath = path.join(repoRoot, relativePath);
      if (!pathExists(absolutePath)) {
        continue;
      }
      seen.add(dedupeKey);
      results.push({
        name: skillName,
        path: relativePath,
        sourceKind: source.sourceKind,
        precedence: source.precedence,
        content: readText(absolutePath),
      });
    }
  }

  return results.sort((left, right) =>
    left.precedence - right.precedence || left.name.localeCompare(right.name, "en", { sensitivity: "base" })
  );
}

function collectMcpConfigs(repoRoot) {
  const configs = [];
  for (const entry of [
    { path: ".mcp.json", label: "Repository MCP config" },
    { path: ".copilot/mcp-config.json", label: "Copilot MCP config" },
  ]) {
    const sourcePath = normalizeSourcePath(entry.path);
    const absolutePath = path.join(repoRoot, sourcePath);
    if (!pathExists(absolutePath)) {
      continue;
    }
    const content = readText(absolutePath);
    const parsed = (() => {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    })();
    const servers = Object.entries(parsed?.mcpServers || {}).map(([name, config]) => ({
      name,
      command: typeof config?.command === "string" ? config.command : "",
      args: Array.isArray(config?.args) ? config.args.map((value) => String(value)) : [],
      envKeys: Object.keys(config?.env || {}),
      tools: Array.isArray(config?.tools) ? config.tools.map((value) => String(value)) : [],
    }));
    configs.push({
      path: sourcePath,
      label: entry.label,
      content,
      servers,
    });
  }
  return configs;
}

function parseOpenClawRuntimeConfig(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      allowedPlugins: [],
      enabledPluginEntries: [],
      enabledChannels: [],
      configuredMcpServers: [],
      agentToAgentEnabled: false,
      sessionsVisibility: "",
    };
  }

  return {
    allowedPlugins: Array.isArray(parsed?.plugins?.allow) ? parsed.plugins.allow.map((value) => String(value)) : [],
    enabledPluginEntries: Object.entries(parsed?.plugins?.entries || {})
      .filter(([, config]) => config && config.enabled !== false)
      .map(([name]) => name),
    enabledChannels: Object.entries(parsed?.channels || {})
      .filter(([, config]) => config && config.enabled !== false)
      .map(([name]) => name),
    configuredMcpServers: Object.entries(parsed?.mcp?.servers || {})
      .filter(([, config]) => config && config.enabled !== false)
      .map(([name, config]) => ({
        name,
        command: typeof config?.command === "string" ? config.command : "",
        args: Array.isArray(config?.args) ? config.args.map((value) => String(value)) : [],
      })),
    agentToAgentEnabled: parsed?.tools?.agentToAgent?.enabled === true,
    sessionsVisibility: typeof parsed?.tools?.sessions?.visibility === "string" ? parsed.tools.sessions.visibility : "",
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const read = (...segments) => readText(path.join(options.repoRoot, ...segments));
  const git = detectGitMetadata(options);

  const contractText = read(".github", "agents", "squad.agent.md");
  const teamText = read(".squad", "team.md");
  const routingText = read(".squad", "routing.md");
  const decisionsText = read(".squad", "decisions.md");
  const raiPolicyText = read(".squad", "rai", "policy.md");

  const team = parseTeam(teamText);
  const routing = parseRouting(routingText);
  const decisions = parseDecisions(decisionsText);
  const teamNames = team.members.map((member) => member.name);
  const projectionDocuments = collectProjectionDocuments(options.repoRoot, team);
  const projectedSkills = collectProjectedSkills(options.repoRoot);
  const mcpConfigs = collectMcpConfigs(options.repoRoot);
  const runtimeConfig = parseOpenClawRuntimeConfig(read("src", "openclaw.json"));

  const authoritativeSourceMap = new Map();
  for (const entry of [
    { path: ".squad/decisions.md", label: "Curated governance summary" },
    ...projectionDocuments.map(({ path: sourcePath, label }) => ({ path: sourcePath, label })),
    ...projectedSkills.map(({ path: sourcePath, name, sourceKind }) => ({
      path: sourcePath,
      label: `Projected skill: ${name} (${sourceKind})`,
    })),
    ...mcpConfigs.map(({ path: sourcePath, label }) => ({ path: sourcePath, label })),
  ]) {
    authoritativeSourceMap.set(entry.path, entry);
  }
  const authoritativeSources = [...authoritativeSourceMap.values()];

  const sourceDigests = authoritativeSources.map((entry) => ({
    path: entry.path,
    label: entry.label,
    sha256: sha256(readText(path.join(options.repoRoot, entry.path))),
  }));
  const sourceDigestSha256 = sha256(sourceDigests.map((entry) => `${entry.path}:${entry.sha256}`).join("\n"));

  const charterProfiles = Object.fromEntries(
    projectionDocuments
      .filter((entry) => entry.category === "charter" && entry.memberId)
      .map((entry) => [
        entry.memberId,
        parseCharter(entry.content, entry.memberName || entry.memberId, entry.memberRole || entry.memberId),
      ])
  );

  const roster = team.members.map((member) => {
    const profile = charterProfiles[member.id];
    const role = profile?.role || member.role;
    let record = {
      id: member.id,
      name: profile?.name || member.name,
      role,
      status: member.status,
      interactive: member.interactive,
      emoji: emojiForRole(role, member.name),
      routingOwnership: routing.filter((entry) => entry.routeTo === member.name),
      decisionSummary: decisions.filter((entry) => entry.deciders.includes(member.name)).slice(0, 4),
    };

    if (profile) {
      record.publicBio = profile.bio;
      record.expertise = profile.expertise;
      record.responsibilities = profile.responsibilities;
      record.workStyle = profile.workStyle;
      record.handoffTags = extractHandoffTags(profile, teamNames);
    }

    record = systemRoleSummary(record);
    return record;
  });

  const interactiveRoster = roster.filter((member) => member.interactive);
  const supportRoles = roster.filter((member) => !member.interactive);
  const coordinator = parseCoordinatorContract(contractText);

  const bundle = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    provenance: {
      generator: "scripts/generate-squad-runtime-bundle.mjs",
      gitCommitSha: git.commit,
      gitShortCommitSha: git.shortCommit,
      worktreeDirty: git.dirty,
      sourceDigestSha256,
      sourceFiles: authoritativeSources.map((entry) => entry.path),
      sourceDigests,
      sourceLabels: authoritativeSources.map((entry) => entry.label),
      note: "Bundle derived from authoritative repo Squad sources. Static contract, charter, instruction, and skill files are projected read-only into the hosted runtime workspace. Mutable Squad histories, inboxes, and logs remain withheld.",
    },
    projectContext: team.projectContext,
    coordinator,
    roster,
    hostedRuntime: {
      projection: "read-only-hosted-squad-runtime",
      defaultAgentId: "main",
      interactiveRoster: interactiveRoster.map(({ id, name, role, status, emoji, runtimeExposure }) => ({
        id,
        name,
        role,
        status,
        emoji,
        runtimeExposure,
      })),
      supportRoles: supportRoles.map(({ id, name, role, status, emoji, runtimeExposure }) => ({
        id,
        name,
        role,
        status,
        emoji,
        runtimeExposure,
      })),
      capabilities: [
        "Expose read-only copies of the repo's real Squad contract, routing, ceremonies, charters, and selected template references inside each OpenClaw workspace.",
        "Project repo skills plus Squad template skills into OpenClaw workspace skills so hosted agents can use the same playbooks as Copilot/CLI sessions.",
        "Use OpenClaw-native `agent_to_agent` and `sessions_spawn` / `subagents` flows for real hosted specialist delegation and background work when those tools are exposed.",
        "Keep OpenClaw's bundled GitHub skills (`github`, `gh-issues`) available to hosted agents by ensuring `gh` is built into the image and on PATH.",
        "Expose a runtime-configured GitHub MCP wrapper through `bundle-mcp`; with a token bridge it can launch the configured, reviewed GitHub MCP server package, and without one it reports status honestly.",
        "Use hosted-safe wrappers for Copilot CLI / VS Code assumptions and map them onto OpenClaw session tools, the Agents view, gh, and az when appropriate.",
        "Preserve browser-auth, managed-identity model access, and sandbox runtime safety boundaries.",
      ],
      limitations: [
        coordinator.hostedRuntimeNote,
        "Mutable Squad backends (squad_state MCP, git-notes/orphan/two-layer persistence, Scribe automation, and Copilot memory bridges) are not implicitly mounted into the hosted runtime.",
        "Copilot CLI `task` / `read_agent`, per-spawn model selection, SQL, and `session_store` semantics still do not exist unless the hosted surface exposes a native OpenClaw equivalent.",
        "GitHub and MCP actions work only when the runtime already exposes the required tool bridge or a token-backed CLI.",
        "Worktrees, branch pushes, PR-from-branch flows, and other repo-connected lifecycle steps still belong to a repo-mounted CLI or VS Code session.",
        "Scribe and Ralph are visible as authoritative system roles but are not normal interactive chat agents.",
      ],
      surfaceCompatibility: {
        cli: [
          "Full `task` / `read_agent` spawning, per-spawn model control, and repo/worktree flows when the repo is mounted.",
        ],
        vscode: [
          "Use `runSubagent` with session-model-only behavior and no SQL tool.",
        ],
        hostedOpenClaw: [
          "Prefer `agent_to_agent` for specialist consultation/delegation and `sessions_spawn` / `subagents` / `sessions_history` for background work when those tools are exposed.",
          "If native coordination tools are absent, fall back to explicit handoff guidance via the Agents view instead of pretending a background spawn happened.",
          "Treat generated workspace wrapper docs and generated hosted skills as the authoritative contract for the browser runtime.",
        ],
        hardLimits: [
          "No Copilot CLI `task` / `read_agent` surface; use OpenClaw-native coordination tools when available.",
          "No Copilot CLI session_store access or `copilot --resume` flow.",
          "No implicit repo checkout, `git worktree`, branch push, or PR-from-branch surface.",
          "No runtime mutation of `.copilot/mcp-config.json`, `.mcp.json`, `.vscode/mcp.json`, or user-local shell profiles.",
        ],
      },
      github: {
        preferredAccess: [
          "Prefer GitHub MCP when it is already loaded into the runtime session.",
          "The built-in OpenClaw `/skills` GitHub skill depends on `gh` being on PATH; this hosted image is expected to provide it already.",
          "Otherwise use `gh` only when the runtime already has a non-interactive `GH_TOKEN` / `GITHUB_TOKEN` bridge.",
        ],
        worksWhenReady: [
          "Use the built-in OpenClaw `/skills` GitHub skill once `gh` is present and the runtime is not blocking it for `bin:gh`.",
          "Inspect issues, pull requests, labels, comments, and repository metadata.",
          "Answer backlog questions and map GitHub work to the right Squad owner.",
        ],
        limitations: [
          "The repo-shipped GitHub MCP wrapper only becomes a full GitHub MCP server when a token bridge exists; without `GH_TOKEN` / `GITHUB_TOKEN` it degrades to a status-only MCP tool.",
          "If the built-in `/skills` GitHub card still reports `bin:gh` while `gh` is already on PATH, treat that as OpenClaw requirement-detection or cached negative state and refresh/restart the hosted runtime before debugging auth.",
          "Hosted OpenClaw should not rely on interactive `gh auth login`; auth should come from `GH_TOKEN`, `GITHUB_TOKEN`, provider token, or an explicitly mounted `GH_CONFIG_DIR`.",
          "The built-in OpenClaw `gh-issues` skill still needs a mounted repo checkout for branch, commit, push, and PR-creation phases even when `gh` is available.",
          "ACA Sandbox custom images do not auto-surface attached `github-copilot` credentials inside the runtime. Keep `SANDBOX_GITHUB_COPILOT_PAT` set when running `devclaw sandbox build` / `upload` if you want a `GH_TOKEN` bridge.",
          "Standard Container Apps mode only gets hosted GitHub auth when you intentionally set `GITHUB_TOKEN` in the azd environment before deploy; there is no automatic GitHub credential discovery otherwise.",
          "Repo checkout, branches, commits, worktrees, pushes, and PR-from-branch flows require a repo-connected CLI or VS Code session.",
          "Multi-account `gh` profile switching, `gh auth login`, and shell-alias setup remain local-only.",
        ],
      },
      mcp: {
        configLocations: mcpConfigs.map(({ path: sourcePath }) => sourcePath),
        hostedRules: [
          "Use only MCP tools already exposed in the running session.",
          "Runtime-configured `bundle-mcp` bridges count as provisioned MCP servers; projected `.mcp.json` files alone do not.",
          "Treat status-only wrappers as honest capability reports, not proof that the real upstream MCP server is authenticated and ready.",
          "Treat missing MCP tools as an unprovisioned deployment capability, not something the browser session can self-install.",
          "Do not tell the user to edit VS Code or user-local MCP config from inside the hosted runtime.",
        ],
        fallbackOrder: [
          "GitHub MCP -> token-backed `gh` bridge",
          "Azure MCP -> `az` CLI bridge when available",
          "Otherwise explain the missing deployment bridge and stop gracefully",
        ],
      },
      projectedDocuments: projectionDocuments.map(({ path: sourcePath, label, category, memberName }) => ({
        path: sourcePath,
        label,
        category,
        memberName: memberName || "",
      })),
      projectedSkills: projectedSkills.map(({ name, path: sourcePath, sourceKind }) => ({
        name,
        path: sourcePath,
        sourceKind,
      })),
      runtimeConfig,
      mcpConfigCatalog: mcpConfigs.map(({ path: sourcePath, label, servers }) => ({
        path: sourcePath,
        label,
        servers,
      })),
    },
    projection: {
      readOnly: true,
      documents: projectionDocuments,
      skills: projectedSkills,
      mcpConfigs,
    },
    routingSummary: routing,
    decisionSummary: decisions.slice(0, 8).map(({ id, title, status }) => ({ id, title, status })),
    raiPolicySummary: parseRaiPolicy(raiPolicyText),
  };

  writeJson(options.output, bundle);
  const stagedGithubBridge = stageHostedRuntimeAsset(options.repoRoot, "scripts/github-mcp-bridge.mjs", path.dirname(options.output));
  console.log(`Wrote ${path.relative(options.repoRoot, options.output)}`);
  console.log(`Staged ${path.relative(options.repoRoot, stagedGithubBridge)}`);
}

main();
