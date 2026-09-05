/**
 * Per-project background overrides (Phase 4).
 *
 * A ChatGPT Project owns one background color inherited by every child chat
 * without an explicit color. Identity reuses structural route semantics
 * (`/g/<project>`); storage mirrors the conversation pattern with a
 * project-scoped prefix:
 *
 *   cgl:projectAppearance:<projectFingerprint> = { background: "#rrggbb" }
 *   cgl:currentProject                          = { fingerprint: string | null }
 *
 * Raw project IDs, titles, and URLs are never persisted — only fingerprints.
 * Resolution precedence (chat > project > global/official) lives in
 * `resolveChatBackground()` so main paint, sidebar hydration, and popup
 * reset semantics all share one rule. No new permission, no network.
 */

import { getConversationBackground } from "./conversation-background.js";

export const PROJECT_APPEARANCE_PREFIX = "cgl:projectAppearance:";
export const CURRENT_PROJECT_KEY = "cgl:currentProject";

/** Native color-picker value format. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Compact project fingerprint format (128-bit hex). */
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;

export interface ProjectAppearance {
  background: string;
}

export function isValidProjectAppearance(
  value: unknown,
): value is ProjectAppearance {
  if (typeof value !== "object" || value === null) return false;
  const background = (value as Record<string, unknown>).background;
  return typeof background === "string" && HEX_COLOR_PATTERN.test(background);
}

export function isValidProjectFingerprint(value: unknown): value is string {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

export function projectAppearanceKey(fingerprint: string): string {
  return `${PROJECT_APPEARANCE_PREFIX}${fingerprint}`;
}

function storageArea(): chrome.storage.StorageArea | null {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
  return chrome.storage.local;
}

/** Stored override color for a project, or null when absent/invalid. */
export async function getProjectBackground(
  fingerprint: string,
): Promise<string | null> {
  const store = storageArea();
  if (!store || !isValidProjectFingerprint(fingerprint)) return null;
  try {
    const raw = await store.get(projectAppearanceKey(fingerprint));
    const value = raw[projectAppearanceKey(fingerprint)];
    return isValidProjectAppearance(value) ? value.background : null;
  } catch {
    return null;
  }
}

/** Persist a project override. Returns true only on a real write. */
export async function setProjectBackground(
  fingerprint: string,
  background: string,
): Promise<boolean> {
  const store = storageArea();
  if (
    !store ||
    !isValidProjectFingerprint(fingerprint) ||
    !HEX_COLOR_PATTERN.test(background)
  ) {
    return false;
  }
  try {
    await store.set({
      [projectAppearanceKey(fingerprint)]: { background },
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete a project override. Missing keys count as success. */
export async function clearProjectBackground(
  fingerprint: string,
): Promise<boolean> {
  const store = storageArea();
  if (!store || !isValidProjectFingerprint(fingerprint)) return false;
  try {
    await store.remove(projectAppearanceKey(fingerprint));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolved chat background with authoritative precedence: explicit chat
 * color, else project color, else null (global/official fallback). Shared
 * by main paint, sidebar hydration, and popup reset semantics.
 */
export async function resolveChatBackground(
  conversationFp: string | null,
  projectFp: string | null,
): Promise<string | null> {
  if (conversationFp) {
    const chat = await getConversationBackground(conversationFp);
    if (chat) return chat;
  }
  if (projectFp) {
    const project = await getProjectBackground(projectFp);
    if (project) return project;
  }
  return null;
}

/** Project fingerprint currently published by the content script (if any). */
export async function readCurrentProjectFingerprint(): Promise<string | null> {
  const store = storageArea();
  if (!store) return null;
  try {
    const raw = await store.get(CURRENT_PROJECT_KEY);
    const entry = raw[CURRENT_PROJECT_KEY] as
      | { fingerprint?: unknown }
      | undefined;
    const fp = entry?.fingerprint ?? null;
    return isValidProjectFingerprint(fp) ? fp : null;
  } catch {
    return null;
  }
}

/**
 * Publish the content script's current project identity (content side only
 * — callers must change-guard to avoid storage churn). `null` marks a page
 * with no project identity so the popup disables project controls.
 */
export async function publishCurrentProjectFingerprint(
  fingerprint: string | null,
): Promise<void> {
  const store = storageArea();
  if (!store) return;
  if (fingerprint !== null && !isValidProjectFingerprint(fingerprint)) {
    return;
  }
  try {
    await store.set({ [CURRENT_PROJECT_KEY]: { fingerprint } });
  } catch {
    /* best-effort pointer; the override path does not depend on it */
  }
}
