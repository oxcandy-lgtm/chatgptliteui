// @ts-check
// Public-safety scanner. Node builtins only. No external dependencies.
//
// Scans tracked files AND untracked non-ignored files (git ls-files + status),
// plus always includes a fixed set of root/config paths. Detects sensitive
// information leaks and prohibited synthetic data. NEVER prints the matched
// secret or personal information — only file, line, rule ID, and a redacted
// category.
//
// Run BEFORE npm install in CI so secrets cannot hide in lockfiles.
import { execSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The scanner scans the current working directory (process.cwd()), which is
// the checked-out repository in CI and the temporary directory in tests. This
// avoids scanning the scanner's own source location.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = process.cwd() || dirname(scriptDir);

// --- allow-lists ------------------------------------------------------------
// Documentation-safe values that must never be flagged.
const ALLOWED_LITERALS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "user@example.com", // reserved documentation contact
  "REDACTED",
  "redacted",
  "#101318",
  "#151922",
  "#1c2636",
  "#e7eaf0",
  "#1c222d",
  "#11151c",
  "#161b25",
  "#ffffff",
  "#000000",
  "transparent",
  "chatgpt.com",
  "oxcandy-lgtm",
  "chatgptliteui",
  "ChatGPTLiteUI",
]);

// Reserved documentation ranges (RFC 5737 / RFC 3849 style).
const ALLOWED_IPV4 = /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
const ALLOWED_IPV6 = /^(2001:db8:|::1$|fe80:)/i;

// Hex color patterns (#rgb / #rrggbb) — must not be treated as secrets.
const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// Commit-like 40-char hex (git SHA) — allowed, not a secret by itself.
// High-entropy detection is CONTEXTUAL (see rules below).

// --- rule definitions -------------------------------------------------------
// RULES-START: the exact rule-declaration block below is the ONLY surface the
// scanner self-exempts (narrow exemption). Prohibited values placed on any
// other line of this file are still detected.
/**
 * Each rule: { id, category, test(line) => boolean }
 * test must return true when a VIOLATION is present.
 */
const RULES = [
  {
    id: "PRIVATE_KEY",
    category: "private-key",
    test: (l) =>
      /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA|EC PRIVATE KEY|PRIVATE KEY)-----/.test(l),
  },
  {
    id: "TOKEN_ASSIGN",
    category: "credential",
    test: (l) =>
      /(api[_-]?key|auth[_-]?token|access[_-]?token|secret|client[_-]?secret|private[_-]?key|bearer)\s*[:=]\s*['"][^'"]{8,}/i.test(
        l,
      ),
  },
  {
    id: "AUTH_HEADER",
    category: "auth-header",
    test: (l) => /Authorization\s*:\s*(Bearer|Basic|Token|Basic )/i.test(l),
  },
  {
    id: "COOKIE_HEADER",
    category: "cookie-header",
    test: (l) => /\bCookie\s*:\s*[^\s]/.test(l) || /Set-Cookie\s*:/i.test(l),
  },
  {
    id: "AWS_KEY",
    category: "cloud-credential",
    test: (l) => /\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(l),
  },
  {
    id: "GITHUB_PAT",
    category: "cloud-credential",
    test: (l) => /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/.test(l),
  },
  {
    id: "WEBHOOK_URL",
    category: "webhook",
    test: (l) =>
      /https?:\/\/(discord\.com\/api\/webhooks|slack\.com\/services|hooks\.slack\.com|api\.telegram\.org\/bot)/i.test(
        l,
      ),
  },
  {
    id: "BROWSER_PROFILE",
    category: "browser-profile-path",
    test: (l) =>
      /(\/Users\/[^/\s]+\/(Library\/Application Support\/Google\/Chrome|\.config\/google-chrome|\.mozilla\/firefox)|C:\\\\Users\\[^\\]+\\(AppData|Application Data))/i.test(
        l,
      ),
  },
  {
    id: "SENSITIVE_ARTIFACT",
    category: "sensitive-artifact",
    test: (l) => /(chatgpt\.com[^"'\s]*\.(har|cookie|session)|cookies\.json|\.har\b|session_dump)/i.test(l),
  },
  // Email — but allow reserved docs values and example domains.
  {
    id: "EMAIL",
    category: "email",
    test: (l) => {
      const m = l.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
      if (!m) return false;
      return m.some((e) => {
        const domain = e.split("@")[1] ?? "";
        return !ALLOWED_LITERALS.has(e) && !/^example\./i.test(domain);
      });
    },
  },
  // IPv4 — allow reserved docs ranges.
  {
    id: "IPV4",
    category: "ip-address",
    test: (l) => {
      const m = l.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g);
      if (!m) return false;
      return m.some((ip) => {
        const parts = ip.split(".").map(Number);
        if (parts.some((p) => p > 255)) return false;
        return !ALLOWED_IPV4.test(ip) && !/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
      });
    },
  },
  // IPv6 — allow reserved docs ranges.
  {
    id: "IPV6",
    category: "ip-address",
    test: (l) => {
      const m = l.match(/\b([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/g);
      if (!m) return false;
      return m.some((ip) => !ALLOWED_IPV6.test(ip));
    },
  },
  // Absolute user paths (Unix/macOS/Windows) — but allow repo-relative refs.
  {
    id: "ABS_PATH",
    category: "absolute-path",
    test: (l) => /(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|C:\\\\?[A-Za-z0-9._-]+)/.test(l),
  },
  // High-entropy string in a CONTEXTUAL credential assignment only.
  {
    id: "HIGH_ENTROPY_SECRET",
    category: "high-entropy-secret",
    test: (l) => {
      // Only flag when a credential key is present AND a long token follows.
      if (!/(api[_-]?key|token|secret|password|passwd|auth|credential)/i.test(l)) return false;
      // Exclude inline comments / allow-listed tokens.
      return /["'`][A-Za-z0-9+/=_-]{32,}["'`]/.test(l);
    },
  },
  // Source-map local path leak.
  {
    id: "SOURCEMAP_LOCAL_PATH",
    category: "sourcemap-leak",
    test: (l) => /sourceMappingURL=|sourcesContent:|^\/\/# sourceMappingURL=.*\.map/.test(l),
  },
];
// RULES-END: end of the narrow self-exempt rule-declaration block.

// --- file collection --------------------------------------------------------
function git(args) {
  return execSync(`git ${args}`, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

function collectFiles() {
  const files = new Set();
  let gitWorked = false;
  try {
    // tracked
    for (const f of git("ls-files").split("\n")) if (f.trim()) files.add(f.trim());
    // untracked, non-ignored
    const status = git("status --porcelain").split("\n");
    for (const line of status) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).trim();
      // include untracked (??) and modified/added; ignore ignored (!!)
      if (code !== "!!" && path) files.add(path);
    }
    gitWorked = files.size > 0;
  } catch {
    // git unavailable or not a real repo; fall through to fs walk.
  }
  // Fallback: if git produced nothing (no commits, bare .git, or not a repo),
  // walk the working directory recursively so untracked files are still
  // scanned. Essential for the isolated test harness.
  if (!gitWorked) {
    walkDir(root, files);
  }
  // NOTE: scripts/ and tests/ are intentionally scanned. The scanner must not
  // exempt whole directories. Narrow self-exemption (below) handles only the
  // exact rule-definition lines of the scanner's own source.
  // Always include critical root/config paths even if git is absent.
  for (const p of [
    "manifest.json",
    "package.json",
    "tsconfig.json",
    "eslint.config.js",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "PRIVACY.md",
  ]) {
    if (existsSync(join(root, p))) files.add(p);
  }
  return [...files];
}

// --- narrow self-exemption -------------------------------------------------
// The scanner must scan every public source surface, including its own file.
// To avoid self-triggering on the exact lines that DECLARE its rules (which
// necessarily contain regexes that match secret-like patterns), we skip ONLY
// the lines between the RULES-START and RULES-END markers in this file. The
// markers are explicit and tested. Any prohibited value placed on a DIFFERENT
// line within this file (or anywhere else) is still detected.
const SELF_EXEMPT = new Set();
{
  const selfPath = join(root, "scripts", "public-safety.mjs");
  if (existsSync(selfPath)) {
    const selfLines = readFileSync(selfPath, "utf-8").split(/\r?\n/);
    let inBlock = false;
    for (let i = 0; i < selfLines.length; i++) {
      const text = selfLines[i];
      if (!inBlock && text.includes("RULES-START")) inBlock = true;
      if (inBlock) {
        SELF_EXEMPT.add(`scripts/public-safety.mjs:${i + 1}`);
        if (text.includes("RULES-END")) break;
      }
    }
  }
}

function walkDir(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const abs = join(dir, entry.name);
    const rel = abs.slice(root.length + 1);
    if (entry.isDirectory()) {
      walkDir(abs, out);
    } else if (rel) {
      out.add(rel);
    }
  }
}

function isScannable(path) {
  return /\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|txt|pem|key|env|toml)$/.test(path);
}

// --- scan -------------------------------------------------------------------
let violations = 0;
const scanned = [];

for (const rel of collectFiles()) {
  const abs = join(root, rel);
  if (!existsSync(abs) || !isScannable(rel)) continue;
  let content;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    continue;
  }
  scanned.push(rel);
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    // skip obviously allowed literals entirely
    if (ALLOWED_LITERALS.has(line.trim())) return;
    if (HEX_COLOR.test(line.trim())) return;
    // Narrow self-exemption: skip ONLY the scanner's own rule-declaration
    // lines (computed above). Any other line in this file is still scanned.
    if (SELF_EXEMPT.has(`${rel}:${idx + 1}`)) return;
    for (const rule of RULES) {
      if (rule.test(line)) {
        violations++;
        // Print ONLY safe metadata. Never the matched text.
        console.error(
          `[${rule.id}] ${rel}:${idx + 1} category=${rule.category}`,
        );
      }
    }
  });
}

if (violations > 0) {
  console.error(`\nPublic-safety scan FAILED: ${violations} finding(s) in ${scanned.length} file(s).`);
  process.exit(1);
}
console.log(`Public-safety scan passed: ${scanned.length} file(s) scanned, no findings.`);
