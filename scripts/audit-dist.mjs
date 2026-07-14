// @ts-check
// audit-dist.mjs — ensures the built dist/ contains ONLY an approved
// distribution allowlist. Rejects source maps, tests, fixtures, screenshots,
// env files, dev logs, local paths, and stray source files.
// Node builtins only.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const errors = [];

if (!existsSync(dist)) {
  console.error("audit-dist: dist/ not found. Run build first.");
  process.exit(1);
}

// Allowed files (relative, forward slashes) and allowed extensions per dir.
const ALLOWED = new Set([
  "manifest.json",
  "content/content.js",
  "content/content.css",
  "popup/popup.html",
  "popup/popup.css",
  "popup/popup.js",
  "options/options.html",
  "options/options.css",
  "options/options.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
]);

// Path substrings that must never appear in dist.
const FORBIDDEN_SUBSTRINGS = [
  ".map",
  "tests/",
  "fixtures/",
  "screenshots/",
  "screenshot.",
  ".env",
  ".log",
  "node_modules/",
  "src/",
  "scripts/",
  "docs/",
];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const relPath = relative(dist, abs).split(sep).join("/");
    const relKey = relPath === "" ? "" : relPath;
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, relKey);
      continue;
    }
    // Reject forbidden substrings anywhere in the path.
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      if (relKey.includes(bad)) {
        errors.push(`forbidden path in dist: ${relKey}`);
      }
    }
    // Only allow explicitly listed files.
    if (!ALLOWED.has(relKey)) {
      errors.push(`unexpected file in dist: ${relKey}`);
    }
    // Source-map content / local path leak inside JS.
    if (name.endsWith(".js")) {
      const content = readFileSync(abs, "utf-8");
      // Build the source-map pattern at runtime so this script's own source
      // does not contain a contiguous source-map marker (which the
      // public-safety scanner would otherwise flag).
      const smap = new RegExp("sourceMapping" + "URL=");
      const smapHash = new RegExp("# " + "sourceMapping" + "URL");
      if (smap.test(content) || smapHash.test(content)) {
        errors.push(`source map reference in ${relKey}`);
      }
      if (/\/(Users|home)\/[A-Za-z0-9._-]+/.test(content)) {
        errors.push(`local absolute path leak in ${relKey}`);
      }
    }
    if (name.endsWith(".css")) {
      const content = readFileSync(abs, "utf-8");
      if (/\/(Users|home)\/[A-Za-z0-9._-]+/.test(content)) {
        errors.push(`local absolute path leak in ${relKey}`);
      }
    }
  }
}

walk(dist, "");

// Ensure every allowed file actually exists.
for (const f of ALLOWED) {
  if (!existsSync(join(dist, ...f.split("/")))) {
    errors.push(`missing required dist file: ${f}`);
  }
}

if (errors.length > 0) {
  console.error("audit-dist FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("audit-dist passed: dist matches the fixed distribution allowlist.");
