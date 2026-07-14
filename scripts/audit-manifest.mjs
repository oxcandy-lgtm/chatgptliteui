// @ts-check
// audit-manifest.mjs — validates the built manifest.json against the locked
// architecture decisions. Node builtins only.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "dist", "manifest.json");

const errors = [];
function check(cond, msg) {
  if (!cond) errors.push(msg);
}

if (!existsSync(manifestPath)) {
  console.error("audit-manifest: dist/manifest.json not found. Run build first.");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
} catch (e) {
  console.error(`audit-manifest: cannot parse manifest: ${e.message}`);
  process.exit(1);
}

// 1. Manifest V3
check(manifest.manifest_version === 3, "manifest_version must be 3");

// 2. Exact allowed permissions
const allowedPerms = ["storage"];
const perms = manifest.permissions ?? [];
check(
  perms.length === allowedPerms.length &&
    allowedPerms.every((p) => perms.includes(p)) &&
    perms.every((p) => allowedPerms.includes(p)),
  `permissions must be exactly [${allowedPerms.join(", ")}] (found: [${perms.join(", ")}])`,
);

// 3. incognito not_allowed
check(manifest.incognito === "not_allowed", 'incognito must be "not_allowed"');

// 4. No host_permissions
check(
  !manifest.host_permissions || manifest.host_permissions.length === 0,
  `host_permissions must be absent (found: ${JSON.stringify(manifest.host_permissions)})`,
);

// 5. No optional all-site access
const ohp = manifest.optional_host_permissions ?? [];
check(
  ohp.length === 0,
  `optional_host_permissions must be absent (found: ${JSON.stringify(ohp)})`,
);

// 6. Exact ChatGPT content-script match, no all_frames, no <all_urls>
const cs = manifest.content_scripts ?? [];
check(cs.length === 1, `expected exactly 1 content_scripts entry (found ${cs.length})`);
if (cs.length === 1) {
  const c = cs[0];
  check(
    Array.isArray(c.matches) && c.matches.length === 1 && c.matches[0] === "https://chatgpt.com/*",
    `content_scripts.matches must be exactly ["https://chatgpt.com/*"] (found: ${JSON.stringify(c.matches)})`,
  );
  check(c.all_frames === false, "content_scripts.all_frames must be false");
  check(
    !c.matches?.some((m) => m === "<all_urls>" || m.includes("*://*")),
    "content_scripts must not use <all_urls> or all-site wildcards",
  );
  check(
    Array.isArray(c.js) && c.js.includes("content/content.js"),
    "content_scripts.js must include content/content.js",
  );
  check(
    Array.isArray(c.css) && c.css.includes("content/content.css"),
    "content_scripts.css must include content/content.css",
  );
  check(c.run_at === "document_idle", 'content_scripts.run_at must be "document_idle"');
}

// 7. No background Service Worker
check(
  !manifest.background || (!manifest.background.service_worker && !manifest.background.scripts),
  "background.service_worker must be absent in Phase 0",
);

// 8. No remote code / externally_connectable
check(
  !manifest.background || !manifest.background.service_worker?.endsWith(".php"),
  "no remote code",
);
if (manifest.externally_connectable) {
  errors.push("externally_connectable must be absent (no external surface)");
}

if (errors.length > 0) {
  console.error("audit-manifest FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("audit-manifest passed: manifest matches locked architecture decisions.");
