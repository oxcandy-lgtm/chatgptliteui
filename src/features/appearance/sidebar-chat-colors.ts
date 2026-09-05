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
 * Hydration runs ONLY on sidebar-relevant triggers (initial apply, route
 * change, appearance storage change, sidebar structural mutation) through
 * the coalescing `requestSidebarChatColorHydration()` gate — generic
 * conversation/message DOM churn never reaches this module. At most one
 * hydration executes at a time; overlapping requests collapse to a single
 * rerun. Fingerprints are session-cached (tokens stay memory-only).
 * Repaints are reconciled: unchanged rows are never rewritten.
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
  projectFolderCandidateCount: number;
  projectFolderDirectMatchCount: number;
  projectFolderFallbackMatchCount: number;
}

/** Hydration scheduling receipt for X-Ray (triggers/timing only). */
export interface SidebarHydrationReceipt {
  sidebarHydrationRunCount: number;
  sidebarHydrationLastTrigger: string;
  sidebarHydrationLastDurationMs: number;
  sidebarHydrationMaxConcurrent: number;
}

const ZERO_DIAGNOSTIC: SidebarChatColorDiagnostic = {
  sidebarChatRouteCandidateCount: 0,
  sidebarChatFingerprintedCount: 0,
  sidebarChatStoredColorMatchCount: 0,
  sidebarChatPaintedRowCount: 0,
};

const ZERO_PROJECT_DIAGNOSTIC: ProjectAppearanceDiagnostic = {
  projectCurrentIdentityAvailable: false,
  projectVisibleProjectCount: 0,
  projectColorMatchCount: 0,
  projectFolderPaintedCount: 0,
  projectInheritedChatRowCount: 0,
  projectExplicitChatOverrideCount: 0,
  projectFolderCandidateCount: 0,
  projectFolderDirectMatchCount: 0,
  projectFolderFallbackMatchCount: 0,
};

let lastDiagnostic: SidebarChatColorDiagnostic = { ...ZERO_DIAGNOSTIC };
let lastProjectDiagnostic: ProjectAppearanceDiagnostic = {
  ...ZERO_PROJECT_DIAGNOSTIC,
};

/** Most recent sidebar color hydration outcome (X-Ray diagnostics only). */
export function getSidebarChatColorDiagnostic(): SidebarChatColorDiagnostic {
  return { ...lastDiagnostic };
}

/** Most recent project inheritance outcome (X-Ray diagnostics only). */
export function getProjectAppearanceDiagnostic(): ProjectAppearanceDiagnostic {
  return { ...lastProjectDiagnostic };
}

// --- coalescing gate (FIX 3) ----------------------------------------------

const hydrationReceipt: SidebarHydrationReceipt = {
  sidebarHydrationRunCount: 0,
  sidebarHydrationLastTrigger: "none",
  sidebarHydrationLastDurationMs: 0,
  sidebarHydrationMaxConcurrent: 0,
};

/** Hydration scheduling receipt (X-Ray diagnostics only). */
export function getSidebarHydrationReceipt(): SidebarHydrationReceipt {
  return { ...hydrationReceipt };
}

let hydrationRunning = false;
let queuedTrigger: string | null = null;
let activeExecutions = 0;

/**
 * Schedule a sidebar color hydration. At most one hydration executes at a
 * time; overlapping requests collapse into a single rerun with the latest
 * trigger. Never rejects.
 */
export async function requestSidebarChatColorHydration(
  trigger: string,
): Promise<SidebarChatColorDiagnostic> {
  if (hydrationRunning) {
    queuedTrigger = trigger;
    return { ...lastDiagnostic };
  }
  hydrationRunning = true;
  let currentTrigger = trigger;
  try {
    for (;;) {
      activeExecutions++;
      hydrationReceipt.sidebarHydrationMaxConcurrent = Math.max(
        hydrationReceipt.sidebarHydrationMaxConcurrent,
        activeExecutions,
      );
      hydrationReceipt.sidebarHydrationRunCount++;
      hydrationReceipt.sidebarHydrationLastTrigger = currentTrigger;
      const start = Date.now();
      try {
        lastDiagnostic = await hydrateSidebarChatColors();
      } catch {
        /* receipt still records the run; next trigger retries */
      } finally {
        activeExecutions--;
      }
      hydrationReceipt.sidebarHydrationLastDurationMs = Date.now() - start;
      if (queuedTrigger === null) break;
      currentTrigger = queuedTrigger;
      queuedTrigger = null;
    }
  } finally {
    hydrationRunning = false;
  }
  return { ...lastDiagnostic };
}

// --- session fingerprint cache (FIX 4) ------------------------------------

const conversationFpCache = new Map<string, string>();
const projectFpCache = new Map<string, string>();

async function fingerprintedConversationToken(
  token: string,
): Promise<string | null> {
  const cached = conversationFpCache.get(token);
  if (cached !== undefined) return cached;
  const fp = await conversationFingerprintFromToken(token);
  if (fp) conversationFpCache.set(token, fp);
  return fp;
}

async function fingerprintedProjectId(
  projectId: string,
): Promise<string | null> {
  const cached = projectFpCache.get(projectId);
  if (cached !== undefined) return cached;
  const fp = await projectFingerprintFromToken(projectId);
  if (fp) projectFpCache.set(projectId, fp);
  return fp;
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

function hasVisibleRect(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function collectVisibleConversationAnchors(): VisibleAnchor[] {
  const out: VisibleAnchor[] = [];
  for (const a of Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]'),
  )) {
    if (!(a instanceof HTMLElement) || !a.isConnected) continue;
    if (!hasVisibleRect(a)) continue;
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
    if (!hasVisibleRect(a)) continue;
    out.push({ el: a, projectId });
  }
  return out;
}

/**
 * Whether an element may serve as a project header/folder surface: bounded,
 * visible, left-zoned, and holding no conversation rows of its own (headers
 * never contain chats) and no foreign project anchors.
 */
function isHeaderSurfaceCandidate(
  el: HTMLElement,
  isForeignToken: (token: string) => boolean,
  isForeignProject: (projectId: string) => boolean,
): boolean {
  if (!el.isConnected || !hasVisibleRect(el)) return false;
  if (el === document.body || el === document.documentElement) return false;
  if (
    el.matches('[data-testid="sidebar"], nav[aria-label*="chat history" i]')
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  if (rect.height < 20 || rect.height > 160) return false;
  if (rect.width > 440) return false;
  if (rect.left >= Math.min(420, vw * 0.4)) return false;
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    let path: string;
    try {
      path = new URL(a.getAttribute("href") ?? "", window.location.origin)
        .pathname;
    } catch {
      continue;
    }
    const tok = extractConversationTokenFromPath(path);
    if (tok && isForeignToken(tok)) return false;
    // A surface containing ANY conversation row is a chat row or a mixed
    // grouping — never the folder header. (Own-group chats are checked by
    // the caller passing them as non-foreign; a header never contains them
    // because headers precede the child list.)
    if (tok) return false;
    if (!path.includes("/c/")) {
      const pid = extractProjectIdFromPath(path);
      if (pid && isForeignProject(pid)) return false;
    }
  }
  return true;
}

/** Whether a container swallows another project's chats (must not paint). */
function containerHasForeign(
  container: Element,
  isForeignToken: (token: string) => boolean,
  isForeignProject: (projectId: string) => boolean,
): boolean {
  for (const a of Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    let path: string;
    try {
      path = new URL(a.getAttribute("href") ?? "", window.location.origin)
        .pathname;
    } catch {
      continue;
    }
    const tok = extractConversationTokenFromPath(path);
    if (tok && isForeignToken(tok)) return true;
    if (!path.includes("/c/")) {
      const pid = extractProjectIdFromPath(path);
      if (pid && isForeignProject(pid)) return true;
    }
  }
  return false;
}

/**
 * Project header fallback: the nearest bounded header surface associated
 * with the project's first child row. Covers BOTH sidebar shapes:
 * header-inside-grouping (a bounded clickable preceding the first child
 * within their smallest common container) AND header-as-preceding-sibling
 * (folder row beside/above the child-list container, never its descendant).
 * Used only when no direct `/g/<id>` folder anchor exists. Fails closed
 * (null) rather than painting an oversized container or another project.
 */
export function deriveProjectGroupHeader(
  group: HTMLAnchorElement[],
  isForeignToken: (token: string) => boolean,
  isForeignProject: (projectId: string) => boolean,
): HTMLElement | null {
  if (group.length === 0) return null;
  const first = group[0]!;
  // Smallest ancestor containing every group anchor.
  let container: HTMLElement | null = first.parentElement;
  while (
    container &&
    container !== document.body &&
    container !== document.documentElement
  ) {
    if (!container.isConnected) return null;
    if (group.every((a) => container!.contains(a))) break;
    container = container.parentElement;
  }
  if (!container || !container.isConnected) return null;
  // Reject groupings that also swallow another project's chats.
  if (containerHasForeign(container, isForeignToken, isForeignProject)) {
    return null;
  }
  // Shape 1: bounded clickable preceding the first child WITHIN the group.
  const vw = window.innerWidth || 0;
  let header: HTMLElement | null = null;
  for (const el of Array.from(
    container.querySelectorAll<HTMLElement>('a[href], button, [role="button"]'),
  )) {
    if (!(el instanceof HTMLElement) || !el.isConnected) continue;
    // Chat rows contain their own conversation anchor: never a header.
    if (el.querySelector('a[href*="/c/"]')) continue;
    if (!hasVisibleRect(el)) continue;
    // Header must PRECEDE the first child: the child FOLLOWS the header.
    if (
      !(
        el.compareDocumentPosition(first) &
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    ) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.height < 20 || rect.height > 160) continue;
    if (rect.width > 440) continue;
    if (rect.left >= Math.min(420, vw * 0.4)) continue;
    if (!isHeaderSurfaceCandidate(el, isForeignToken, isForeignProject)) {
      continue;
    }
    header = el; // keep the nearest preceding candidate
  }
  if (header) return header;
  // Shape 2: the folder/header row is a PRECEDING SIBLING of the child-list
  // container (never its descendant). Walk a small bounded neighborhood up
  // from the container; never scan the whole sidebar.
  let node: HTMLElement | null = container;
  for (let depth = 0; depth < 3; depth++) {
    if (!node || node === document.body || node === document.documentElement) {
      break;
    }
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (
        sibling instanceof HTMLElement &&
        isHeaderSurfaceCandidate(sibling, isForeignToken, isForeignProject)
      ) {
        return sibling; // nearest preceding sibling first
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return null;
}

interface DesiredPaint {
  attr: string;
  varName: string;
  color: string;
}

/**
 * Rehydrate saved-color sidebar rows + project folders. Reconciles instead
 * of repainting: unchanged rows are never rewritten; stale markers are
 * removed; new/changed rows are painted. Idempotent.
 */
export async function hydrateSidebarChatColors(): Promise<SidebarChatColorDiagnostic> {
  const done = (
    partial: Partial<SidebarChatColorDiagnostic>,
  ): SidebarChatColorDiagnostic => {
    lastDiagnostic = { ...ZERO_DIAGNOSTIC, ...partial };
    return { ...lastDiagnostic };
  };
  const doneProject = (
    partial: Partial<ProjectAppearanceDiagnostic>,
  ): void => {
    lastProjectDiagnostic = { ...ZERO_PROJECT_DIAGNOSTIC, ...partial };
  };

  const anchors = collectVisibleConversationAnchors();
  const folders = collectVisibleProjectFolders();
  if (anchors.length === 0 && folders.length === 0) {
    doneProject({});
    return done({});
  }

  // Fingerprint conversation tokens and project IDs (session-cached).
  const fpByToken = new Map<string, string>();
  const projFpById = new Map<string, string>();
  for (const a of anchors) {
    if (!fpByToken.has(a.token)) {
      const fp = await fingerprintedConversationToken(a.token);
      if (fp) fpByToken.set(a.token, fp);
    }
    if (a.projectId && !projFpById.has(a.projectId)) {
      const fp = await fingerprintedProjectId(a.projectId);
      if (fp) projFpById.set(a.projectId, fp);
    }
  }
  for (const f of folders) {
    if (!projFpById.has(f.projectId)) {
      const fp = await fingerprintedProjectId(f.projectId);
      if (fp) projFpById.set(f.projectId, fp);
    }
  }
  if (fpByToken.size === 0 && projFpById.size === 0) {
    doneProject({});
    return done({ sidebarChatRouteCandidateCount: anchors.length });
  }

  // ONE batched read for every distinct chat + project key.
  const store = storageArea();
  if (!store) {
    doneProject({ projectVisibleProjectCount: projFpById.size });
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByToken.size,
    });
  }
  const keys = [
    ...[...fpByToken.values()].map((fp) => conversationAppearanceKey(fp)),
    ...[...projFpById.values()].map((fp) => projectAppearanceKey(fp)),
  ];
  let saved: Record<string, unknown> = {};
  try {
    saved = await store.get(keys);
  } catch {
    doneProject({ projectVisibleProjectCount: projFpById.size });
    return done({
      sidebarChatRouteCandidateCount: anchors.length,
      sidebarChatFingerprintedCount: fpByToken.size,
    });
  }

  // Desired paint: chat rows (explicit chat, else project) + folders.
  const desired = new Map<HTMLElement, DesiredPaint>();
  let matchCount = 0;
  let inheritedCount = 0;
  let explicitCount = 0;
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
    if (!surface.isConnected) continue;
    desired.set(surface, {
      attr: CHAT_COLOR_SURFACE_ATTR,
      varName: CHAT_COLOR_VAR,
      color,
    });
  }

  // Project folders: direct folder anchor preferred, else grouping header.
  const byProject = new Map<string, HTMLAnchorElement[]>();
  for (const a of anchors) {
    if (!a.projectId || !projFpById.has(a.projectId)) continue;
    const list = byProject.get(a.projectId) ?? [];
    list.push(a.el);
    byProject.set(a.projectId, list);
  }
  const folderByProject = new Map<string, HTMLAnchorElement>();
  for (const f of folders) {
    if (!folderByProject.has(f.projectId)) folderByProject.set(f.projectId, f.el);
  }
  let projectColorMatches = 0;
  let folderCandidates = 0;
  let folderDirectMatches = 0;
  let folderFallbackMatches = 0;
  for (const [pid, projFp] of projFpById) {
    const value = saved[projectAppearanceKey(projFp)];
    if (!isValidProjectAppearance(value)) continue;
    projectColorMatches++;
    const color = value.background;
    let surface: HTMLElement | null = null;
    const folderAnchor = folderByProject.get(pid);
    if (folderAnchor?.isConnected) {
      folderCandidates++;
      surface = deriveRowSurface(folderAnchor);
      if (surface) folderDirectMatches++;
    }
    if (!surface) {
      const group = (byProject.get(pid) ?? []).filter((a) => a.isConnected);
      if (group.length > 0) {
        folderCandidates++;
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
        const fallback = deriveProjectGroupHeader(
          group,
          (tok) => foreignTokens.has(tok),
          (id) => foreignProjects.has(id),
        );
        if (fallback) {
          surface = fallback;
          folderFallbackMatches++;
        }
      }
    }
    if (!surface || !surface.isConnected) continue;
    if (desired.has(surface)) continue;
    desired.set(surface, {
      attr: PROJECT_COLOR_SURFACE_ATTR,
      varName: PROJECT_COLOR_VAR,
      color,
    });
  }

  // Reconcile against current paint: remove stale, update changed, add new.
  // An element already correct under EITHER marker shape keeps no stale twin:
  // desired wins per element, so a chat surface promoted to identical paint
  // drops any leftover project twin and vice versa.
  const ATTRS = [CHAT_COLOR_SURFACE_ATTR, PROJECT_COLOR_SURFACE_ATTR] as const;
  const VAR_BY_ATTR: Record<string, string> = {
    [CHAT_COLOR_SURFACE_ATTR]: CHAT_COLOR_VAR,
    [PROJECT_COLOR_SURFACE_ATTR]: PROJECT_COLOR_VAR,
  };
  const current = new Map<HTMLElement, { attr: string; color: string }>();
  for (const attr of ATTRS) {
    for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) {
      if (!(el instanceof HTMLElement)) continue;
      current.set(el, {
        attr,
        color: el.style.getPropertyValue(VAR_BY_ATTR[attr] ?? "").trim(),
      });
    }
  }
  for (const [el, state] of current) {
    const want = desired.get(el);
    if (
      !want ||
      want.attr !== state.attr ||
      want.color.toLowerCase() !== state.color.toLowerCase()
    ) {
      el.removeAttribute(CHAT_COLOR_SURFACE_ATTR);
      el.style.removeProperty(CHAT_COLOR_VAR);
      el.removeAttribute(PROJECT_COLOR_SURFACE_ATTR);
      el.style.removeProperty(PROJECT_COLOR_VAR);
      if (!want) current.delete(el);
    }
  }
  let paintedChats = 0;
  let paintedFolders = 0;
  for (const [el, want] of desired) {
    if (!el.isConnected) continue;
    const state = current.get(el);
    if (
      state &&
      state.attr === want.attr &&
      state.color.toLowerCase() === want.color.toLowerCase()
    ) {
      if (want.attr === CHAT_COLOR_SURFACE_ATTR) paintedChats++;
      else paintedFolders++;
      continue;
    }
    el.setAttribute(want.attr, "true");
    el.style.setProperty(want.varName, want.color);
    if (want.attr === CHAT_COLOR_SURFACE_ATTR) paintedChats++;
    else paintedFolders++;
  }

  doneProject({
    projectCurrentIdentityAvailable: projectTokenFromLocation() != null,
    projectVisibleProjectCount: projFpById.size,
    projectColorMatchCount: projectColorMatches,
    projectFolderPaintedCount: paintedFolders,
    projectInheritedChatRowCount: inheritedCount,
    projectExplicitChatOverrideCount: explicitCount,
    projectFolderCandidateCount: folderCandidates,
    projectFolderDirectMatchCount: folderDirectMatches,
    projectFolderFallbackMatchCount: folderFallbackMatches,
  });
  return done({
    sidebarChatRouteCandidateCount: anchors.length,
    sidebarChatFingerprintedCount: fpByToken.size,
    sidebarChatStoredColorMatchCount: matchCount,
    sidebarChatPaintedRowCount: paintedChats,
  });
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
  conversationFpCache.clear();
  projectFpCache.clear();
  lastDiagnostic = { ...ZERO_DIAGNOSTIC };
  lastProjectDiagnostic = { ...ZERO_PROJECT_DIAGNOSTIC };
}
