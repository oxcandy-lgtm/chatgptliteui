import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Static audits for Phase 4 writing-copy safety invariants.
 *
 * Prohibited values are assembled at runtime from safe fragments (never as a
 * contiguous literal in THIS file) and written to a temporary repository, so
 * the repository-level scanner does not flag this test file itself.
 */

const SCANNER = join(process.cwd(), "scripts", "public-safety.mjs");

// Prohibited tokens, assembled from fragments so the source file below never
// contains a contiguous forbidden literal.
function readProbe(): string {
  return "navi" + "gator.clipboard." + "readText";
}
function execProbe(): string {
  return "doc" + "ument.execCommand";
}
function execCopyProbe(): string {
  return "execCommand" + '("copy")';
}
function writePermProbe(): string {
  return '"' + "clip" + "board" + "Write" + '"';
}

function withTempRepo(fn: (dir: string) => void): { exit: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "cgl-wc-"));
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

describe("writing-copy static audits", () => {
  it("detects a clipboard read call in source", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "leak.ts"), `const x = ${readProbe()}();\n`);
    });
    expect(res.exit).not.toBe(0);
  });

  it("detects an execCommand call in source", () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "leak.ts"), `void ${execProbe()}("copy");\n`);
    });
    expect(res.exit).not.toBe(0);
  });

  it('detects the exec copy command call in source', () => {
    const res = withTempRepo((dir) => {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "leak.ts"), `void ${execCopyProbe()};\n`);
    });
    expect(res.exit).not.toBe(0);
  });

  it("the real product source contains no clipboard read / execCommand", () => {
    const out = execFileSync("node", [SCANNER], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toMatch(/Public-safety scan passed/);
  });

  it("the real built manifest permits only storage (no clipboard perms)", () => {
    const manifestPath = join(process.cwd(), "manifest.json");
    const content = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content) as { permissions: string[] };
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.permissions.some((p) => p.toLowerCase().includes("clipboard"))).toBe(false);
  });

  it("no copied-content storage field exists in the schema", () => {
    const schema = join(process.cwd(), "src/settings/schema.ts");
    const content = readFileSync(schema, "utf-8");
    expect(content).not.toMatch(/copiedText|copiedContent|clipboardContent/);
  });

  it("rejects a manifest that adds a clipboard-write permission", () => {
    const res = withTempRepo((dir) => {
      // Place at repo root (the scanner's walkDir skips dist/).
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
          manifest_version: 3,
          permissions: ["storage", writePermProbe()],
          content_scripts: [{ matches: ["https://chatgpt.com/*"], js: ["x.js"] }],
        }),
      );
    });
    // The public-safety scanner flags the clipboard-write permission literal.
    expect(res.exit).not.toBe(0);
  });
});
