import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Security tests for the public-safety scanner and the settings persistence
 * boundary.
 *
 * Negative scanner tests use SYNTHETIC prohibited values assembled at runtime
 * (and written to a temp dir) so they never appear as real secrets in the
 * repository and never trigger the repo-level scanner on this test file.
 */

const SCANNER = join(process.cwd(), "scripts", "public-safety.mjs");

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

describe("public-safety scanner", () => {
  it("detects prohibited synthetic secrets written to a temp repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    // Synthetic (non-real) secret, assembled at runtime.
    const fakeToken = "ghp_" + "a".repeat(36);
    writeFileSync(join(dir, "leak.txt"), `token = "${fakeToken}"\n`);
    const res = runScannerIn(dir);
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/GITHUB_PAT/);
    // Scanner must NOT echo the secret itself.
    expect(res.output).not.toContain(fakeToken);
  });

  it("detects a synthetic private key block", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    // Synthetic (non-real) PEM marker, assembled at runtime in a temp dir.
    writeFileSync(
      join(dir, "key.pem"),
      "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA\n-----END PRIVATE KEY-----\n",
    );
    const res = runScannerIn(dir);
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/PRIVATE_KEY/);
  });

  it("detects a real-looking IPv4 outside reserved ranges", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "net.txt"), "server_address = 45.33.32.156 internal\n");
    const res = runScannerIn(dir);
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/IPV4/);
  });

  it("allows reserved documentation values and CSS colors", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, "docs.md"),
      "Contact user@example.com. See https://example.com. Color #101318 and #e7eaf0.\n",
    );
    const res = runScannerIn(dir);
    expect(res.exit).toBe(0);
  });

  it("does not reject commit-like hex hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, "log.txt"),
      "commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n",
    );
    const res = runScannerIn(dir);
    expect(res.exit).toBe(0);
  });

  it("scanner output never reproduces the matched value (email case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgl-safety-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    const realEmail = "secret.person@private-mail.example";
    writeFileSync(join(dir, "x.txt"), `mailto:${realEmail}\n`);
    const res = runScannerIn(dir);
    expect(res.exit).toBe(1);
    expect(res.output).toMatch(/EMAIL/);
    expect(res.output).not.toContain(realEmail);
  });
});
