// @ts-check
// Build identity shared by the extension build and the vitest config:
// `<package-version>+<git-short-sha>` with an explicit `-dirty` suffix when
// TRACKED files were modified/staged at build time. Untracked local files are
// excluded: they are never build inputs, so they cannot make the produced
// bundle differ from HEAD. A missing/unusable git context counts as dirty —
// the HEAD SHA is never silently reported for an unverifiable tree.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} repo absolute repo root */
function gitShortSha(repo) {
  try {
    return execSync("git rev-parse --short=7 HEAD", {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** @param {string} repo absolute repo root */
function trackedTreeDirty(repo) {
  try {
    const status = execSync("git status --porcelain --untracked-files=no", {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return status.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * @param {string} repo absolute repo root
 * @returns {{buildId: string, sourceHead: string, dirtyAtBuild: boolean}}
 */
export function computeBuildIdentity(repo) {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8"));
    if (typeof pkg.version === "string" && pkg.version) version = pkg.version;
  } catch {
    // keep fallback version
  }
  const sourceHead = gitShortSha(repo) ?? "unknown";
  const dirtyAtBuild = sourceHead === "unknown" ? true : trackedTreeDirty(repo);
  return {
    buildId: `${version}+${sourceHead}${dirtyAtBuild ? "-dirty" : ""}`,
    sourceHead,
    dirtyAtBuild,
  };
}
