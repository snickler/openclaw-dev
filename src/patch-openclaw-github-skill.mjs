#!/usr/bin/env node
// Hosted-runtime patch for OpenClaw's bundled GitHub skills.
//
// Why this exists:
// - Hosted Linux deployments should not show "Install GitHub CLI (brew)" for
//   bundled GitHub skills when the runtime image is expected to ship gh already.
// - OpenClaw's current installer pipeline does not execute `apt` install specs,
//   so Linux install affordances are misleading here.
// - Hosted auth should prefer GH_TOKEN / GITHUB_TOKEN bridges rather than
//   interactive `gh auth login`.
// - Body-file examples should avoid /tmp so they work with repo-local scratch
//   files and align with this repo's runtime guidance.

import fs from "node:fs";

const SKILLS = [
  {
    name: "github",
    path: process.env.OPENCLAW_GITHUB_SKILL_PATH || "/usr/local/lib/node_modules/openclaw/skills/github/SKILL.md",
    marker: "<!-- openclaw-dev hosted github skill patch -->",
    patch(content) {
      let next = ensureMarker(content, /^# GitHub\s*$/m, this.marker);

      next = replaceOneOf(
        next,
        [
          /"install"\s*:\s*\[\s*\{\s*"id"\s*:\s*"brew"[\s\S]*?"label"\s*:\s*"Install GitHub CLI \(brew\)",\s*\},\s*\{\s*"id"\s*:\s*"apt"[\s\S]*?"label"\s*:\s*"Install GitHub CLI \(apt\)",\s*\},\s*\]/m,
          /"install"\s*:\s*\[\s*\{\s*"id"\s*:\s*"apt"[\s\S]*?"label"\s*:\s*"Install GitHub CLI \(apt\)",\s*\},\s*\{\s*"id"\s*:\s*"brew"[\s\S]*?"label"\s*:\s*"Install GitHub CLI \(brew\)",\s*\},\s*\]/m,
        ],
        `"install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "os": ["darwin"],
              "label": "Install GitHub CLI (brew)",
            },
          ]`,
        /"install"\s*:\s*\[\s*\{\s*"id"\s*:\s*"brew"[\s\S]*?"os"\s*:\s*\["darwin"\][\s\S]*?"label"\s*:\s*"Install GitHub CLI \(brew\)",\s*\}\s*\]/m,
        "limit github install guidance to darwin brew only"
      );

      next = replaceIfNeeded(
        next,
        /## Auth\s+```bash\s+gh auth status\s+gh auth login\s+```\s+/m,
        `## Auth

\`\`\`bash
gh auth status
# Hosted OpenClaw prefers GH_TOKEN / GITHUB_TOKEN when the deployment provisions a token bridge.
# Use interactive gh auth login only in a local CLI session.
\`\`\`

`,
        "Hosted OpenClaw prefers GH_TOKEN / GITHUB_TOKEN when the deployment provisions a token bridge.",
        "replace interactive auth guidance with hosted-safe guidance"
      );

      next = replaceIfNeeded(
        next,
        /Gateway HOME can differ from operator HOME\. If `gh` auth exists elsewhere, set `GH_CONFIG_DIR` in the gateway service env and restart\./m,
        "Hosted OpenClaw auth should come from `GH_TOKEN` / `GITHUB_TOKEN` when available. If `gh` auth exists elsewhere, set `GH_CONFIG_DIR` in the gateway service env and restart.",
        "Hosted OpenClaw auth should come from `GH_TOKEN` / `GITHUB_TOKEN` when available.",
        "clarify GH_CONFIG_DIR guidance"
      );

      next = next
        .replaceAll("/tmp/pr.md", "./pr.md")
        .replaceAll("/tmp/issue.md", "./issue.md")
        .replaceAll("/tmp/comment.md", "./comment.md");

      return next;
    },
  },
  {
    name: "gh-issues",
    path: process.env.OPENCLAW_GH_ISSUES_SKILL_PATH || "/usr/local/lib/node_modules/openclaw/skills/gh-issues/SKILL.md",
    marker: "<!-- openclaw-dev hosted gh-issues skill patch -->",
    patch(content) {
      let next = ensureMarker(content, /^# gh-issues\s*$/m, this.marker);

      next = replaceOneOf(
        next,
        [
          /"install"\s*:\s*\[\s*\{\s*"id"\s*:\s*"brew"[\s\S]*?"label"\s*:\s*"Install GitHub CLI \(brew\)",\s*\}\s*\]/m,
        ],
        `"install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "os": ["darwin"],
              "label": "Install GitHub CLI (brew)",
            },
          ]`,
        /"install"\s*:\s*\[\s*\{\s*"id"\s*:\s*"brew"[\s\S]*?"os"\s*:\s*\["darwin"\][\s\S]*?"label"\s*:\s*"Install GitHub CLI \(brew\)",\s*\}\s*\]/m,
        "limit gh-issues install guidance to darwin brew only",
        true
      );

      next = replaceIfNeeded(
        next,
        /Use for issue-to-PR automation\. Prefer `gh` CLI; fall back to `gh api` only when a high-level command lacks the needed field\./m,
        "Use for issue-to-PR automation. Prefer `gh` CLI; fall back to `gh api` only when a high-level command lacks the needed field.\n\nHosted OpenClaw note: this skill assumes the deployment image already has `gh` on PATH. GitHub auth should come from `GH_TOKEN` / `GITHUB_TOKEN`; interactive `gh auth login` is local-only. Repo-mutation phases still require a mounted checkout.",
        "Hosted OpenClaw note: this skill assumes the deployment image already has `gh` on PATH.",
        "add hosted-safe gh-issues note"
      );

      next = replaceIfNeeded(
        next,
        /gh auth status\s+gh repo view OWNER\/REPO --json nameWithOwner,defaultBranchRef/m,
        `gh auth status
# Hosted OpenClaw expects GH_TOKEN / GITHUB_TOKEN when GitHub auth is provisioned.
gh repo view OWNER/REPO --json nameWithOwner,defaultBranchRef`,
        "Hosted OpenClaw expects GH_TOKEN / GITHUB_TOKEN when GitHub auth is provisioned.",
        "annotate gh-issues auth flow for hosted runtime"
      );

      next = replaceIfNeeded(
        next,
        /If `gh auth status` fails and `GH_TOKEN` is missing, stop and ask for GitHub auth\/config\./m,
        "If `gh auth status` fails and `GH_TOKEN` is missing, treat that as a hosted deployment/auth gap. In hosted OpenClaw, do not tell the operator to run interactive `gh auth login` from the browser runtime.",
        "treat that as a hosted deployment/auth gap",
        "replace interactive gh-issues auth fallback guidance"
      );

      return next;
    },
  },
];

function ensureMarker(content, headingRegex, marker) {
  if (content.includes(marker)) {
    return content;
  }
  return content.replace(headingRegex, (match) => `${match}\n\n${marker}`);
}

function replaceIfNeeded(content, regex, replacement, successCheck, description) {
  if (regex.test(content)) {
    return content.replace(regex, replacement);
  }
  if (typeof successCheck === "string" ? content.includes(successCheck) : successCheck.test(content)) {
    return content;
  }
  throw new Error(`Could not apply patch: ${description}`);
}

function replaceOneOf(content, regexes, replacement, successCheck, description, optional = false) {
  for (const regex of regexes) {
    if (regex.test(content)) {
      return content.replace(regex, replacement);
    }
  }
  if (typeof successCheck === "string" ? content.includes(successCheck) : successCheck.test(content)) {
    return content;
  }
  if (optional) {
    return content;
  }
  throw new Error(`Could not apply patch: ${description}`);
}

for (const skill of SKILLS) {
  if (!fs.existsSync(skill.path)) {
    throw new Error(`Bundled GitHub skill not found: ${skill.path}`);
  }
  const original = fs.readFileSync(skill.path, "utf8");
  const updated = skill.patch(original);
  fs.writeFileSync(skill.path, updated, "utf8");
  console.log(`[patch-openclaw-github-skill] patched ${skill.name} at ${skill.path}`);
}
