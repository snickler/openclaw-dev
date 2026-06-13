#!/usr/bin/env node
// Hosted-runtime patch for OpenClaw skill snapshot invalidation.
//
// Why this exists:
// - OpenClaw persists skills snapshots in session state.
// - The upstream refresh-state module starts with globalVersion=0 on every boot.
// - If a persisted session snapshot was also written at version 0, the runtime
//   can keep reusing stale "missing requirements" results even after the hosted
//   image already has the required binary on PATH.
// - Initializing the global skills snapshot version at boot time forces one
//   safe re-evaluation per process start without touching user messages/state.

import fs from "node:fs";
import path from "node:path";

const DIST_DIR = process.env.OPENCLAW_DIST_DIR || "/usr/local/lib/node_modules/openclaw/dist";
const PATCH_MARKER = "/* openclaw-dev skills snapshot boot refresh */";

function patchFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch-openclaw-skills-refresh] SKIP already patched ${path.basename(filePath)}`);
    return "already";
  }

  const target = "let globalVersion = 0;";
  if (!content.includes(target)) {
    if (/from "\.\/refresh-state-[^"]+\.js"/.test(content)) {
      console.log(`[patch-openclaw-skills-refresh] SKIP re-export ${path.basename(filePath)}`);
      return "reexport";
    }
    throw new Error(`Could not find '${target}' in ${filePath}`);
  }

  const updated = content.replace(target, `let globalVersion = Date.now(); ${PATCH_MARKER}`);
  fs.writeFileSync(filePath, updated, "utf8");
  console.log(`[patch-openclaw-skills-refresh] OK ${path.basename(filePath)}`);
  return "patched";
}

if (!fs.existsSync(DIST_DIR)) {
  throw new Error(`OpenClaw dist directory not found: ${DIST_DIR}`);
}

const candidates = fs.readdirSync(DIST_DIR)
  .filter((name) => /^refresh-state-.*\.js$/.test(name))
  .map((name) => path.join(DIST_DIR, name));

if (!candidates.length) {
  throw new Error(`No refresh-state modules found under ${DIST_DIR}`);
}

let patchedCount = 0;
let alreadyPatchedCount = 0;
for (const filePath of candidates) {
  const result = patchFile(filePath);
  if (result === "patched") {
    patchedCount += 1;
  } else if (result === "already") {
    alreadyPatchedCount += 1;
  }
}

if (patchedCount === 0 && alreadyPatchedCount === 0) {
  throw new Error(`No refresh-state modules were patched under ${DIST_DIR}`);
}
