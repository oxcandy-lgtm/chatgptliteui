import type { ChatGptAdapter } from "../../adapters/chatgpt-adapter.js";
import { WRITING_HEADER_ANCHOR_SELECTOR } from "../../adapters/chatgpt-adapter.js";
import { isVisible } from "../../adapters/selectors.js";
import { MARKER_WRITING_SURFACE } from "./writing-copy-markers.js";

export { MARKER_WRITING_SURFACE };

/**
 * Whole-WritingBlock visual surface.
 *
 * The semantic WritingBlock identity (detection, copied state, storage)
 * stays on the canonical editor element. This module derives a SEPARATE,
 * purely visual container — the deepest safe region pairing the editor with
 * its already-proven exact WritingBlock header anchor — so the uncopied
 * pulse can paint the whole visible card (header + editor background)
 * instead of only the editor area.
 *
 * Derivation mirrors the Adapter's structural anchor→editor pairing walk
 * (deepest ancestor holding the anchor and exactly one eligible editor,
 * bounded by the owning Assistant turn) and fails closed: no anchor, an
 * ambiguous pairing, a whole-turn region, or any degenerate shape yields no
 * surface. Generic assistant cards and anchor-less contenteditables can
 * never produce one. Pure observation plus ONE extension-owned attribute;
 * never mutates ChatGPT structure, classes, or styles.
 */

const ASSISTANT_TURN_SELECTOR =
  '[data-message-author-role="assistant"], [data-testid="assistant-message"]';

const WRITING_EDITOR_SELECTOR = '[contenteditable="true"]';

/** Forbidden ancestor surfaces (parity with the Adapter pairing walk). */
const WRITING_FORBIDDEN_ANCESTOR_SELECTOR =
  '[role="dialog"], dialog, [aria-modal="true"], [data-testid="sidebar"], nav[aria-label*="chat history" i], [data-cgl-sidebar-host="true"], [data-cgl-writing-copy-host="true"], #cgl-sidebar-control-host';

/** Eligible editors in a turn (same eligibility as the Adapter walk). */
function eligibleEditorsInTurn(turn: HTMLElement): HTMLElement[] {
  return Array.from(
    turn.querySelectorAll<HTMLElement>(WRITING_EDITOR_SELECTOR),
  ).filter(
    (el) =>
      el.isConnected &&
      el instanceof HTMLElement &&
      el.getAttribute("contenteditable") === "true" &&
      isVisible(el) &&
      !el.closest(WRITING_FORBIDDEN_ANCESTOR_SELECTOR) &&
      el.closest(ASSISTANT_TURN_SELECTOR) === turn,
  );
}

/**
 * Resolve the whole-card visual surface for an already-safe editor: the
 * deepest region pairing it with its exact header anchor. Returns null when
 * the surface cannot be derived unambiguously (fail closed).
 */
export function resolveWritingSurface(editor: HTMLElement): HTMLElement | null {
  if (!editor.isConnected || !(editor instanceof HTMLElement)) return null;
  const turn = editor.closest(ASSISTANT_TURN_SELECTOR);
  if (!(turn instanceof HTMLElement) || !turn.isConnected) return null;

  const anchors = Array.from(
    turn.querySelectorAll<HTMLElement>(WRITING_HEADER_ANCHOR_SELECTOR),
  ).filter((el) => el.isConnected);
  if (anchors.length === 0) return null;

  const turnEditors = eligibleEditorsInTurn(turn);
  let pairedRegion: HTMLElement | null = null;
  let pairCount = 0;
  for (const anchor of anchors) {
    let region: HTMLElement | null = anchor.parentElement;
    while (region && region !== turn.parentElement) {
      const here = turnEditors.filter((e) => region!.contains(e));
      if (here.length > 1) break; // ambiguous for this anchor: skip it
      if (here.length === 1) {
        if (here[0] === editor) {
          pairedRegion = region;
          pairCount++;
        }
        break;
      }
      region = region.parentElement;
    }
  }
  if (pairCount !== 1 || !pairedRegion) return null;
  // Degenerate shapes never become a pulse surface: the editor itself, the
  // whole Assistant turn, or a document root.
  if (pairedRegion === editor) return null;
  if (pairedRegion === turn) return null;
  if (
    pairedRegion === document.body ||
    pairedRegion === document.documentElement
  ) {
    return null;
  }
  return pairedRegion;
}

/**
 * Rebind whole-card surface markers for the current safe editors: clear all
 * stale surface markers, then mark each unambiguously resolved surface.
 * Idempotent; safe to run on every structural refresh.
 */
export function syncWritingBlockSurfaces(
  adapter: ChatGptAdapter,
  editors: HTMLElement[],
): void {
  const container = adapter.detectConversationContainer().element ?? document;
  container
    .querySelectorAll(`[${MARKER_WRITING_SURFACE}]`)
    .forEach((el) => el.removeAttribute(MARKER_WRITING_SURFACE));
  for (const editor of editors) {
    if (!editor.isConnected) continue;
    const surface = resolveWritingSurface(editor);
    if (surface && surface.isConnected) {
      surface.setAttribute(MARKER_WRITING_SURFACE, "true");
    }
  }
}
