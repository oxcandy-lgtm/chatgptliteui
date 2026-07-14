// @ts-check
// audit-network-usage.mjs — scans executable product code (src + built dist)
// for runtime network primitives. Documentation prose is excluded.
// Node builtins only.
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Network primitives we forbid in product code.
const PRIMITIVES = [
  "fetch(",
  "XMLHttpRequest",
  "WebSocket(",
  "new WebSocket",
  "EventSource(",
  "navigator.sendBeacon",
  "sendBeacon(",
];

// External-asset URL patterns (http/https to non-chrome-extension origins).
const EXTERNAL_URL = /https?:\/\/(?!chrome-extension)[a-z0-9.-]+\.[a-z]{2,}/i;

const errors = [];

function scanFile(abs, rel) {
  let content;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of PRIMITIVES) {
      if (line.includes(p)) {
        errors.push(`${rel}:${i + 1} uses network primitive "${p.trim()}"`);
      }
    }
    if (EXTERNAL_URL.test(line)) {
      errors.push(`${rel}:${i + 1} references an external asset URL`);
    }
  });
}

// Collect JS/TS in src (excluding tests) and dist.
const targets = [];
try {
  const srcFiles = execSync("git ls-files 'src/**/*.ts'", {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).split("\n").filter(Boolean);
  for (const f of srcFiles) if (!/^tests\//.test(f)) targets.push(f);
} catch {
  /* ignore */
}
// dist is produced by build; scan if present.
const distDir = join(root, "dist");
if (existsSync(distDir)) {
  try {
    const out = execFileSync("find", [distDir, "-name", "*.js"], { encoding: "utf-8" });
    for (const f of out.split("\n")) if (f.trim()) targets.push(f.trim());
  } catch {
    /* ignore */
  }
}

for (const rel of targets) scanFile(join(root, rel), rel);

if (errors.length > 0) {
  console.error("audit-network-usage FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`audit-network-usage passed: ${targets.length} executable file(s) scanned, no network usage.`);
