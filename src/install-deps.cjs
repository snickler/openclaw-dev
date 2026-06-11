const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const root = "/usr/local/lib/node_modules/openclaw";
const exts = path.join(root, "dist", "extensions");
const deps = new Map();

function parseSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (spec.startsWith("@")) {
    return [spec.slice(0, at), spec.slice(at + 1)];
  }
  return [spec.slice(0, at), spec.slice(at + 1)];
}

for (const d of fs.readdirSync(exts)) {
  const p = path.join(exts, d, "package.json");
  if (!fs.existsSync(p)) continue;
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  const all = { ...pkg.dependencies, ...(pkg.optionalDependencies || {}) };
  for (const [name, version] of Object.entries(all)) {
    const sentinel = path.join(root, "node_modules", ...name.split("/"), "package.json");
    if (!fs.existsSync(sentinel)) deps.set(name, `${name}@${version}`);
  }
}

if (deps.size === 0) {
  console.log("[install-deps] All bundled plugin deps present");
  process.exit(0);
}

const specs = [...deps.values()];
console.log(`[install-deps] Installing ${specs.length} missing deps...`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-deps-"));
const tmpPkg = path.join(tmp, "package.json");
const tmpModules = path.join(tmp, "node_modules");

fs.writeFileSync(
  tmpPkg,
  JSON.stringify(
    {
      name: "openclaw-bundle-deps",
      private: true,
      version: "1.0.0",
      dependencies: Object.fromEntries(specs.map(parseSpec)),
    },
    null,
    2
  )
);

try {
  execSync("npm install --package-lock-only --ignore-scripts --omit=dev --no-audit --no-fund", {
    stdio: "inherit",
    cwd: tmp,
  });
  execSync("npm ci --omit=dev --no-audit --no-fund", {
    stdio: "inherit",
    cwd: tmp,
  });

  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  for (const entry of fs.readdirSync(tmpModules)) {
    const source = path.join(tmpModules, entry);
    const target = path.join(root, "node_modules", entry);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  }
  console.log("[install-deps] Done");
} catch (e) {
  console.error("[install-deps] Some deps failed, continuing anyway");
}
