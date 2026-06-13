#!/usr/bin/env node
// Hosted-runtime patch for OpenClaw binary requirement detection.
//
// Why this exists:
// - Hosted Linux runtimes can prove `gh` exists (`command -v gh`, `gh --version`)
//   while OpenClaw's UI still reports `bin:gh` missing.
// - Upstream `hasBinary()` only scans the current PATH entries with fs.accessSync
//   and permanently caches negative results for the lifetime of the process.
// - In hosted containers we want three guardrails:
//   1. always probe common Unix system paths even if PATH drifted,
//   2. fall back to shell resolution (`command -v` / `where.exe`) when direct
//      path scanning says "missing",
//   3. avoid sticky negative cache entries so a later refresh can recover.

import fs from "node:fs";
import path from "node:path";

const DIST_DIR = process.env.OPENCLAW_DIST_DIR || "/usr/local/lib/node_modules/openclaw/dist";
const PATCH_MARKER = "/* openclaw-dev hasBinary hosted fallback patch */";
const IMPORT_MARKER = 'import { spawnSync } from "node:child_process";';

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  if (content.includes(PATCH_MARKER)) {
    console.log(`[patch-openclaw-binary-detection] SKIP already patched ${path.basename(filePath)}`);
    return "already";
  }

  const fsImport = 'import fs from "node:fs";';
  if (!content.includes(fsImport)) {
    throw new Error(`Could not find fs import in ${filePath}`);
  }

  if (!content.includes(IMPORT_MARKER)) {
    content = content.replace(fsImport, `${IMPORT_MARKER}\n${fsImport}`);
  }

  const target = /let cachedHasBinaryPath;\r?\nlet cachedHasBinaryPathExt;\r?\nconst hasBinaryCache = \/\* @__PURE__ \*\/ new Map\(\);\r?\nfunction hasBinary\(bin\) \{\r?\n[\s\S]*?\r?\n\}\r?\n\/\/#endregion/;
  if (!target.test(content)) {
    throw new Error(`Could not locate hasBinary block in ${filePath}`);
  }

  const replacement = `let cachedHasBinaryPath;
let cachedHasBinaryPathExt;
const hasBinaryCache = /* @__PURE__ */ new Map();
${PATCH_MARKER}
function normalizedBinarySearchPaths(pathEnv) {
\tconst candidates = pathEnv.split(path.delimiter);
\tif (process.platform !== "win32") candidates.push("/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin");
\tconst seen = /* @__PURE__ */ new Set();
\tconst parts = [];
\tfor (const candidate of candidates) {
\t\tconst trimmed = candidate.trim();
\t\tif (!trimmed || seen.has(trimmed)) continue;
\t\tseen.add(trimmed);
\t\tparts.push(trimmed);
\t}
\treturn parts;
}
function shellResolvesBinary(bin) {
\tif (typeof bin !== "string" || bin.trim().length === 0) return false;
\ttry {
\t\tif (process.platform === "win32") return spawnSync("where.exe", [bin], { stdio: "ignore" }).status === 0;
\t\treturn spawnSync("/bin/sh", ["-lc", 'command -v -- "$1" >/dev/null 2>&1', "openclaw-has-binary", bin], { stdio: "ignore" }).status === 0;
\t} catch {
\t\treturn false;
\t}
}
function hasBinary(bin) {
\tconst pathEnv = process.env.PATH ?? "";
\tconst pathExt = process.platform === "win32" ? process.env.PATHEXT ?? "" : "";
\tif (cachedHasBinaryPath !== pathEnv || cachedHasBinaryPathExt !== pathExt) {
\t\tcachedHasBinaryPath = pathEnv;
\t\tcachedHasBinaryPathExt = pathExt;
\t\thasBinaryCache.clear();
\t}
\tif (hasBinaryCache.get(bin) === true) return true;
\tconst parts = normalizedBinarySearchPaths(pathEnv);
\tconst extensions = process.platform === "win32" ? windowsPathExtensions() : [""];
\tfor (const part of parts) for (const ext of extensions) {
\t\tconst candidate = path.join(part, bin + ext);
\t\ttry {
\t\t\tfs.accessSync(candidate, fs.constants.X_OK);
\t\t\thasBinaryCache.set(bin, true);
\t\t\treturn true;
\t\t} catch {}
\t}
\tif (shellResolvesBinary(bin)) {
\t\thasBinaryCache.set(bin, true);
\t\treturn true;
\t}
\thasBinaryCache.delete(bin);
\treturn false;
}
//#endregion`;

  content = content.replace(target, replacement);
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`[patch-openclaw-binary-detection] OK ${path.basename(filePath)}`);
  return "patched";
}

if (!fs.existsSync(DIST_DIR)) {
  throw new Error(`OpenClaw dist directory not found: ${DIST_DIR}`);
}

const candidates = fs.readdirSync(DIST_DIR)
  .filter((name) => /^config-eval-.*\.js$/.test(name))
  .map((name) => path.join(DIST_DIR, name));

if (!candidates.length) {
  throw new Error(`No config-eval modules found under ${DIST_DIR}`);
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
  throw new Error(`No config-eval modules were patched under ${DIST_DIR}`);
}
