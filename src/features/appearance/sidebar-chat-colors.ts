import {
  conversationFingerprintFromToken,
  projectTokenFromLocation,
} from "../writing-copy/block-identity.js";
import {
  extractProjectIdFromPath,
  projectFingerprintFromToken,
} from "../writing-copy/block-identity.js";
import {
  conversationAppearanceKey,
  isValidConversationAppearance,
} from "./conversation-background.js";
import {
  isValidProjectAppearance,
  projectAppearanceKey,
} from "./project-background.js";
import {
  deriveRowSurface,
  extractConversationTokenFromPath,
} from "./active-chat-row.js";

/**
 * Persistent per-chat sidebar row colors with Project inheritance (Phase 4).
 *
 * Every conversation with a saved background keeps its color on its sidebar
 * row — including while ANOTHER conversation is open. Resolution per row:
 * explicit chat color, else its Project's color, else official styling.
 * Project folder rows take the Project color. No second preference exists;
 * no new persisted field exists.
 *
 * Hydration (apply / route refresh / sidebar rerender): collect visible
 * connected conversation anchors, extract in-memory tokens AND project IDs
 * with the accepted structural parsers, fingerprint with storage-identical
 * semantics, batch-read required chat + project keys ONCE, and paint via
 * the proven bounded-surface mechanism with element-local variables (never
 * the route-dependent root variable). Raw tokens/IDs stay in memory only.
 * No polling.
 */

/** Marker for a persistently colored sidebar chat row surface. */
export const CHAT_COLOR_SURFACE_ATTR = "data-cgl-chat-color-surface";

/** Element-local color variable owned by each colored row. */
export const CHAT_COLOR_VAR = "--cgl-sidebar-chat-bg";

/** Marker for a project folder row surface carrying the project color. */
export const PROJECT_COLOR_SURFACE_ATTR = "data-cgl-project-color-surface";

/** Element-local color variable owned by each colored project folder. */
export const PROJECT_COLOR_VAR = "--cgl-project-bg";

/** Tiny structural receipt for X-Ray (counts only — never token/URL). */
export interface SidebarChatColorDiagnostic {
  sidebarChatRouteCandidateCount: number;
  sidebarChatFingerprintedCount: number;
  sidebarChatStoredColorMatchCount: number;
  sidebarChatPaintedRowCount: number;
}

/** Project-inheritance receipt for X-Ray (counts only — never IDs/URLs). */
export interface ProjectAppearanceDiagnostic {
  projectCurrentIdentityAvailable: boolean;
  projectVisibleProjectCount: number;
  projectColorMatchCount: number;
  projectFolderPaintedCount: number;
  projectInheritedChatRowCount: number;
  projectExplicitChatOverrideCount: number;
}

let lastDiagnostic: SidebarChatColorDiagnostic = {
  sidebarChatRouteCandidateCount: 0,
  sidebarChatFingerprintedCount: 0,
  sidebarChatStoredColorMatchCount: 0,
  sidebarChatPaintedRowCount: 0,
};

let lastProjectDiagnostic: ProjectAppearanceDiagnostic = {
  projectCurrentIdentityAvailable: false,
  projectVisibleProjectCount: 0,
  projectColorMatchCount: 0,
  projectFolderPaintedCount: 0,
  projectInheritedChatRowCount: 0,
  projectExplicitChatOverrideCount: 0,
};

/** Most recent sidebar color hydration outcome (X-Ray diagnostics only). */
export function getSidebarChatColorDiagnostic(): SidebarChatColorDiagnostic {
  return { ...lastDiagnostic };
}

/** Most recent project inheritance outcome (X-Ray diagnostics only). */
export function getProjectAppearanceDiagnostic(): ProjectAppearanceDiagnostic {
  return { ...lastProjectDiagnostic };
}

function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

interface VisibleAnchor {
  el: HTMLAnchorElement;
  token: string;
  projectId: string | null;
}

function collectVisibleConversationAnchors(): VisibleAnchor[] {
  const out: VisibleAnchor[] = [];
  for (const a of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'),
  )) {
    if (!(a instanceof HTMLElement) || !a.isConnected) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let path: string;
    try {
      path = new URL(a.getAttribute("href") ?? "", window.location.origin)
        .pathname;
    } catch {
      continue;
    }
    const token = extractConversationTokenFromPath(path);
    if (!token) continue;
    out.push({
      el: a,
      token,
      projectId: extractProjectIdFromPath(path),
    });
  }
  return out;
}

interface VisibleProjectFolder {
  el: HTMLAnchorElement;
  projectId: string;
}

/** Folder anchors expose the project route directly (`/g/<id>`, no `/c/`). */
function collectVisibleProjectFolders(): VisibleProjectFolder[] {
  const out: VisibleProjectFolder[] = [];
  for (const a of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/g/"]'),
  )) {
    if (!(a instanceof HTMLElement) || !a.isConnected) continue;
    let path: string;
    try {
      path = new URL(a.getAttribute("href") ?? "", window.location.origin)
        .pathname;
    } catch {
      continue;
    }
    if (path.includes("/c/")) continue;
    const projectId = extractProjectIdFromPath(path);
    if (!projectId) continue;
    const rect = a.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    out.push({ el: a, projectId });
  }
  return out;
}

function clearColorMarkers(): void {
  document
    .querySelectorAll(`[${CHAT_COLOR_SURFACE_ATTR}]`)
    .forEach((el) => {
      el.removeAttribute(CHAT_COLOR_SURFACE_ATTR);
      if (el instanceof HTMLElement) el.style.removeProperty(CHAT_COLOR_VAR);
    });
  document
    .querySelectorAll(`[${PROJECT_COLOR_SURFACE_ATTR}]`)
    .forEach((el) => {
      el.removeAttribute(PROJECT_COLOR_SURFACE_ATTR);
      if (el instanceof HTMLElement) el.style.removeProperty(PROJECT_COLOR_VAR);
    });
}

/**
 * Deepest common ancestor of a project group that stays bounded: contains
 * no other project's anchors, stays sidebar-sized, and never escapes to
 * body/html. Used only when no direct folder anchor exists.
 */
function deriveProjectGroupSurface(
  group: HTMLAnchorElement[],
  foreignTokens: Set<string>,
  foreignProjects: Set<string>,
): HTMLElement | null {
  if (group.length === 0) return null;
  let node: HTMLElement | null = group[0]!.parentElement;
  const containsAll = (el: Element): boolean =>
    group.every((a) => el.contains(a));
  while (node && node !== document.body && node !== document.documentElement) {
    if (!node.isConnected || !containsAll(node)) {
      node = node.parentElement;
      continue;
    }
    // Reject groupings that also swallow another project's chats.
    let foreign = false;
    for (const a of Array.from(
      node.querySelectorAll<HTMLAnchorElement>("a[href]"),
    )) {
      let path: string;
      try {
        path = new URL(a.getAttribute("href") ?? "", window.location.origin)
          .pathname;
      } catch {
        continue;
      }
      const tok = extractConversationTokenFromPath(path);
      if (tok && foreignTokens.has(tok)) {
        foreign = true;
        break;
      }
      if (!path.includes("/c/")) {
        const pid = extractProjectIdFromPath(path);
        if (pid && foreignProjects.has(pid)) {
          foreign = true;
          break;
        }
      }
    }
    if (foreign) return null;
    if (!(node instanceof HTMLElement)) return null;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.height <= 160 &&
      rect.width <= 440 &&
      rect.left < Math.min(420, vw * 0.4)
    ) {
      return node;
    }
    // Bounded but too large (e.g. a whole section): keep the children
    // colored, but do not paint the grouping itself.
    return null;
  }
  return null;
}

/**
 * Rehydrate saved-color sidebar rows + project folders. Clears stale color
 * markers first so a reset chat/project loses its color immediately while
 * other saved rows persist. Idempotent; safe on every structural refresh.
 */
export async function hydrateSidebarChatColors(): Promise<SidebarChatColorDiagnostic> {
  clearColorMarkers();

  const done = (
    partial: Partial<SidebarChatColorDiagnostic>,
  ): SidebarChatColorDiagnostic => {
    lastDiagnostic = {
      sidebarChatRouteCandidateCount: 0,
      sidebarChatFingerprintedCount: 0,
      sidebarChatStoredColorMatchCount: 0,
      sidebarChatPaintedRowCount: 0,
      ...partial,
    };
    return { ...lastDiagnostic };
  };

  const anchors = collectVisibleConversationAnchors();
  const folders = collectVisibleProjectFolders();
  if (anchors.length === 0 && folders.length === 0) {
    resetProjectDiagnostic(false, 0, 0, 0, 0, 0);
    return done({});
  }

  // Fingerprint conversation tokens and project IDs (memory only).
  const fpByToken = new Map<string, string>();
  const projFpById = new Map<string, string>();
  for (const a of anchors) {
    if (!fpByToken.has(a.token)) {
      const fp = await conversationFingerprintFromToken(a.token);
      if (fp) fpByToken.set(a.token, fp);
    }
    if (a.projectId && !projFpById.has(a.projectId)) {
      const fp = await projectFingerprintFromToken(a.projectId);
      if (fp) projFpById.set(a.projectId, fp);
    }
  }
  for (const f of folders) {
    if (!projFpById.has(f.projectId)) {
      const fp = await projectFingerprintFromToken(f.projectId);
      if (fp) projFpById.set(f.projectId, fp);
    }
  }
  if (fpByToken.size === 0 && projFpById.size === 0) {
    resetProjectDiagnostic(false, 0, 0, 0, 0, 0);
    return done({ sidebarChatRouteCandidateCount: anchors.length });
  }

  // ONE batched read for every distinct chat + project key.
  const store = storageArea();
  if (!store) {
    resetProjectDiagnostic(projectTokenFromLocation() != null, projFpById.size, 0, 0, 0, 0);
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByToken.size,
    });
  }
  const keys = [
    ...[...fpByToken.values()].map((fp) => conversationAppearanceKey(fp)),
    ...[...projFpById.values()].map((fp) =>
      projectAppearanceKey(fp),
    ),
  ];
  let saved: Record<string, unknown> = {};
  try {
    saved = await store.get(keys);
  } catch {
    resetProjectDiagnostic(projectTokenFromLocation() != null, projFpById.size, 0, 0, 0, 0);
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByToken.size,
    });
  }

  // Resolve per anchor: explicit chat color, else project color, else none.
  let matchCount = 0;
  let paintedCount = 0;
  let inheritedCount = 0;
  let explicitCount = 0;
  const painted = new Set<HTMLElement>();
  for (const a of anchors) {
    const fp = fpByToken.get(a.token);
    const projFp = a.projectId ? (projFpById.get(a.projectId) ?? null) : null;
    let color: string | null = null;
    let explicit = false;
    if (fp) {
      const value = saved[conversationAppearanceKey(fp)];
      if (isValidConversationAppearance(value)) {
        color = value.background;
        explicit = true;
      }
    }
    if (!color && projFp) {
      const value = saved[projectAppearanceKey(projFp)];
      if (isValidProjectAppearance(value)) {
        color = value.background;
      }
    }
    if (!color) continue;
    if (!a.el.isConnected) continue;
    matchCount++;
    if (explicit) explicitCount++;
    else inheritedCount++;
    const surface = deriveRowSurface(a.el);
    if (!surface.isConnected || painted.has(surface)) continue;
    painted.add(surface);
    surface.setAttribute(CHAT_COLOR_SURFACE_ATTR, "true");
    surface.style.setProperty(CHAT_COLOR_VAR, color);
    paintedCount++;
  }

  // Project folders: direct folder anchor preferred, else group fallback.
  const byProject = new Map<string, HTMLAnchorElement[]>();
  for (const a of anchors) {
    const pid = a.projectId;
    if (!pid || !projFpById.has(pid)) continue;
    const list = byProject.get(pid) ?? [];
    list.push(a.el);
    byProject.set(pid, list);
  }
  const folderByProject = new Map<string, HTMLAnchorElement>();
  for (const f of folders) {
    if (!folderByProject.has(f.projectId)) folderByProject.set(f.projectId, f.el);
  }
  let projectColorMatches = 0;
  let folderPainted = 0;
  const paintedFolders = new Set<HTMLElement>();
  for (const [pid, projFp] of projFpById) {
    const value = saved[projectAppearanceKey(projFp)];
    if (!isValidProjectAppearance(value)) continue;
    projectColorMatches++;
    const color = value.background;
    let surface: HTMLElement | null = null;
    const folderAnchor = folderByProject.get(pid);
    if (folderAnchor?.isConnected) {
      surface = deriveRowSurface(folderAnchor);
    }
    if (!surface) {
      const group = (byProject.get(pid) ?? []).filter((a) => a.isConnected);
      if (group.length > 0) {
        const foreignTokens = new Set<string>();
        const foreignProjects = new Set<string>();
        for (const a of anchors) {
          if (a.projectId !== pid) {
            foreignTokens.add(a.token);
            if (a.projectId) foreignProjects.add(a.projectId);
          }
        }
        for (const f of folders) {
          if (f.projectId !== pid) foreignProjects.add(f.projectId);
        }
        surface = deriveProjectGroupSurface(group, foreignTokens, foreignProjects);
      }
    }
    if (!surface || !surface.isConnected || paintedFolders.has(surface)) {
      continue;
    }
    paintedFolders.add(surface);
    surface.setAttribute(PROJECT_COLOR_SURFACE_ATTR, "true");
    surface.style.setProperty(PROJECT_COLOR_VAR, color);
    folderPainted++;
  }

  resetProjectDiagnostic(
    projectTokenFromLocation() != null,
    projFpById.size,
    projectColorMatches,
    folderPainted,
    inheritedCount,
    explicitCount,
  );
  return done({
    sidebarChatRouteCandidateCount: anchors.length,
    sidebarChatFingerprintedCount: fpByToken.size,
    sidebarChatStoredColorMatchCount: matchCount,
    sidebarChatPaintedRowCount: paintedCount,
  });
}

function resetProjectDiagnostic(
  available: boolean,
  visibleProjects: number,
  colorMatches: number,
  foldersPainted: number,
  inherited: number,
  explicit: number,
): void {
  lastProjectDiagnostic = {
    projectCurrentIdentityAvailable: available,
    projectVisibleProjectCount: visibleProjects,
    projectColorMatchCount: colorMatches,
    projectFolderPaintedCount: foldersPainted,
    projectInheritedChatRowCount: inherited,
    projectExplicitChatOverrideCount: explicit,
  };
}

/** Remove every persistent color marker/var (disable/restore/teardown). */
export function clearSidebarChatColorMarkers(
  root: ParentNode = document,
): void {
  root.querySelectorAll(`[${CHAT_COLOR_SURFACE_ATTR}]`).forEach((el) => {
    el.removeAttribute(CHAT_COLOR_SURFACE_ATTR);
    if (el instanceof HTMLElement) el.style.removeProperty(CHAT_COLOR_VAR);
  });
  root.querySelectorAll(`[${PROJECT_COLOR_SURFACE_ATTR}]`).forEach((el) => {
    el.removeAttribute(PROJECT_COLOR_SURFACE_ATTR);
    if (el instanceof HTMLElement) el.style.removeProperty(PROJECT_COLOR_VAR);
  });
  lastDiagnostic = {
    sidebarChatRouteCandidateCount: 0,
    sidebarChatFingerprintedCount: 0,
    sidebarChatStoredColorMatchCount: 0,
    sidebarChatPaintedRowCount: 0,
  };
  resetProjectDiagnostic(false, 0, 0, 0, 0, 0);
}
