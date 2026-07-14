import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Security tests for the public-safety scanner and the settings persistence
 * boundary.
 *
 * Negative scanner tests use SYNTHETIC prohibited values assembled at runtime
 * from safe fragments (never as a contiguous literal in this source file) and
 * written to a temporary directory, so the repository-level scanner does not
 * flag this test file. Each temporary directory is removed in a finally block.
 */

const SCANNER = join(process.cwd(), "scripts", "public-safety.mjs");

function withTempRepo(fn: (dir: string) => void): { exit: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  try {
    fn(dir);
    return runScannerIn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runScannerIn(dir: string): { exit: number; output: string } {
  try {
    const out = execFileSync("node", [SCANNER], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exit: 0, output: out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { exit: err.status ?? 1, output: `${err.stdout}\n${err.stderr}` };
  }
}

// --- runtime fragment assemblers (safe in source, forbidden when assembled) --
function pemMarker(): string {
  // runtime PEM header; source keeps the keyword split from the dashes
  return "-----BEGIN " + "PRIVATE KEY" + "-----";
}
function ipv4(): string {
  return [45, 33, 32, 156].join(".");
}
function emailAddr(): string {
  return "secret" + ".person@" + "private-mail.example";
}
function githubPat(): string {
  return "gh" + "p_" + "a".repeat(36);
}

describe("public-safety scanner", () => {
  // 1. prohibited value in scripts/example.mjs is detected
  it("detects a prohibited value in scripts/example.mjs", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "example.mjs"), `const t = "${githubPat()}";\n`);
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
    expect(res.output).toMatch(/scripts\/example\.mjs/);
  });

  // 2. prohibited value in tests/example.test.ts is detected
  it("detects a prohibited value in tests/example.test.ts", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(
        join(dir, "tests", "example.test.ts"),
        `it("x", () => { const e = "${emailAddr()}"; });\n`,
      );
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/EMAIL/);
    expect(res.output).toMatch(/tests\/example\.test\.ts/);
  });

  // 3. the scanner's exact rule-declaration block does not self-trigger
  it("does not self-trigger on its own rule-declaration block", () => {
    // Runs the scanner against the REAL repository root (scripts/ and tests/
    // included). The RULES-START..RULES-END block must be exempt; the scan
    // must pass.
    const out = execFileSync("node", [SCANNER], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/Public-safety scan passed/);
  });

  // 4. prohibited value on an ORDINARY line of scripts/public-safety.mjs
  //    (outside the rule block) is detected
  it("detects a prohibited value on an ordinary scanner source line", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      const leaked = githubPat();
      writeFileSync(
        join(dir, "scripts", "public-safety.mjs"),
        '// RULES-START\nconst RULES = [];\n// RULES-END\nconst leaked = "' + leaked + '";\n',
      );
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
  });

  // 5. tracked files are scanned (a synthetic leak committed to a temp repo)
  it("scans tracked files", () => {
    const res = withTempRepo((dir) => {
      const fake = githubPat();
      writeFileSync(join(dir, "tracked.txt"), `token = "${fake}"\n`);
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "ci@example.com"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "ci"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
    expect(res.output).toMatch(/tracked\.txt/);
  });

  // 6. untracked non-ignored files are scanned
  it("scans untracked non-ignored files", () => {
    const res = withTempRepo((dir) => {
      writeFileSync(join(dir, "untracked.txt"), `token = "${githubPat()}"\n`);
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
    expect(res.output).toMatch(/untracked\.txt/);
  });

  // 7. ignored build paths (dist/, node_modules/) are not scanned
  it("does not scan ignored dist/ and node_modules/ paths", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      const fake = githubPat();
      writeFileSync(join(dir, "dist", "out.js"), `const k = "${fake}";\n`);
      writeFileSync(join(dir, "node_modules", "pkg", "x.js"), `const k = "${fake}";\n`);
    });
    // The leak only exists under ignored dirs, so the scan must pass.
    expect(res.exit).toBe(0);
  });

  // 8. matched values and complete source lines are not reproduced
  it("redacts matched content from scanner output", () => {
    const secret = githubPat();
    const keyName = "aut" + "h_token";
    const res = withTempRepo((dir) => {
      writeFileSync(join(dir, "leak.txt"), keyName + ' = "' + secret + '"\n');
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
    expect(res.output).toMatch(/leak\.txt:\d+/);
    expect(res.output).not.toContain(secret);
    expect(res.output).not.toContain("auth_token =");
  });

  // 9. reserved documentation examples, CSS colors, commit-like hashes allowed
  it("allows reserved examples, CSS colors, and commit-like hashes", () => {
    const res = withTempRepo((dir) => {
      writeFileSync(
        join(dir, "docs.md"),
        "Contact user@example.com. See https://example.com. Color #101318 and #e7eaf0.\n",
      );
      writeFileSync(
        join(dir, "log.txt"),
        "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n",
      );
    });
    expect(res.exit).toBe(0);
  });

  // additional: private key block detection
  it("detects a synthetic private key block", () => {
    const res = withTempRepo((dir) => {
      writeFileSync(
        join(dir, "key.pem"),
        pemMarker() + "\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA\n" + "-----END " + "PRIVATE KEY" + "-----\n",
      );
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/PRIVATE_KEY/);
  });

  // additional: IPv4 outside reserved ranges
  it("detects a real-looking IPv4 outside reserved ranges", () => {
    const res = withTempRepo((dir) => {
      writeFileSync(join(dir, "net.txt"), "server_address = " + ipv4() + " internal\n");
    });
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/IPV4/);
  });
});
