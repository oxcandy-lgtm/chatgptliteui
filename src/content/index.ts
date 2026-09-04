import type { Settings } from "../shared/types.js";
import {
  getSettings,
  SettingsUnavailableError,
} from "../settings/storage.js";
import { ThemeApplier } from "./lifecycle.js";
import { RouteListener } from "./route-listener.js";
import { createAdapter } from "../adapters/chatgpt-adapter.js";
import { debounce } from "../shared/debounce.js";
import { hasAppearanceEffects } from "../features/appearance/presets.js";
import { hasSidebarEffects } from "../features/sidebar/sidebar-state.js";
import { SidebarController } from "../features/sidebar/sidebar-controller.js";
import { findSafeSidebarTarget, SIDEBAR_HOST_ID } from "../features/sidebar/sidebar-detection.js";
import { WritingCopyController, WRITING_COPY_HOST_ATTR } from "../features/writing-copy/writing-copy-controller.js";
import { FoldingController } from "../features/folding/folding-controller.js";
import { hasWritingCopyEffects } from "../features/writing-copy/writing-copy-state.js";
import { conversationFingerprintFromLocation } from "../features/writing-copy/block-identity.js";
import { conversationTokenFromLocation } from "../features/writing-copy/block-identity.js";
import {
  projectFingerprintFromToken,
  projectTokenFromLocation,
} from "../features/writing-copy/block-identity.js";
import { syncActiveChatRow } from "../features/appearance/active-chat-row.js";
import { requestSidebarChatColorHydration } from "../features/appearance/sidebar-chat-colors.js";
import {
  CONVERSATION_APPEARANCE_PREFIX,
  CURRENT_CONVERSATION_KEY,
  publishCurrentConversationFingerprint,
} from "../features/appearance/conversation-background.js";
import {
  CURRENT_PROJECT_KEY,
  PROJECT_APPEARANCE_PREFIX,
  publishCurrentProjectFingerprint,
} from "../features/appearance/project-background.js";
import {
  XrayController,
  isXrayShortcut,
} from "../features/maintenance/xray-controller.js";
import { logger } from "../shared/logger.js";
import {
  CODE_EXTENSION_CONTEXT_INVALIDATED,
  onInvalidated,
  probeExtensionContext,
  recordInternalError,
} from "../shared/runtime-health.js";

/**
 * Quiesce hook: ANY invalidation latch (boot probe, storage read/write
 * classification) cleanly stops this stale runtime's active behavior.
 * Registered once at module load; the listener fires exactly once.
 */
onInvalidated(() => quiesceStaleRuntime());
/**
 * Content script entry point (Phase 4 — writing copy + runtime health).
 *
 * Responsibilities:
 *  - load settings (FAIL CLOSED on extension-context invalidation: features
 *    never initialize from defaults while Chrome APIs are dead);
 *  - maintain the runtime-health authority: canonical context probe at boot,
 *    quiesce-on-invalidation, boot identity stamped by extension-owned hosts;
 *  - apply appearance via extension-owned root classes, `--cgl-*` custom
 *    properties, and `data-cgl-*` surface markers;
 *  - apply sidebar visibility modes (visible/hover/button/hidden) through
 *    extension-owned classes, a single `data-cgl-sidebar-target` marker, and a
 *    Shadow DOM control host — never by deleting, detaching, rewriting,
 *    reordering, or cloning ChatGPT navigation;
 *  - react to chrome.storage.onChanged;
 *  - restore the official ChatGPT UI when disabled, on mode change to visible,
 *    on route teardown, or on lifecycle teardown;
 *  - detect SPA route changes and re-apply non-destructively;
 *  - observe structural DOM mutations to re-mark surfaces and rebound the
 *    sidebar, coalesced into one debounced refresh;
 *  - handle the fixed Alt+Shift+L sidebar shortcut, the Alt+Shift+C writing-
 *    copy shortcut, and the X-Ray maintenance shortcut Alt+Shift+X.
 *
 * It performs NO destructive DOM operations and makes NO external network
 * request.
 */

const applier = new ThemeApplier();
const adapter = createAdapter();
const sidebarController = new SidebarController(document.documentElement, adapter);
const writingCopyController = new WritingCopyController(document.documentElement, adapter);
const foldingController = new FoldingController(document.documentElement, adapter);
const xrayController = new XrayController({
  root: document.documentElement,
  adapter,
  getSettings: () => lastSettings,
  getWritingCopyControllerReceipt: () =>
    writingCopyController.buildReceipt(),
  getCopyTransaction: () => writingCopyController.lastTransaction,
  getFoldingReceipt: () => foldingController.foldingReceipt(),
});
const routeListener = new RouteListener();

let observer: MutationObserver | null = null;
let observedTarget: Node | null = null;

/** Runtime enabled flag (Fix 2): keyboard shortcut is gated on this. */
let runtimeEnabled = false;
/** Whether the sidebar keydown listener is currently attached (Fix 2, no dup). */
let keyboardListenerAttached = false;
/** Whether the writing-copy keydown listener is currently attached (no dup). */
let writingCopyListenerAttached = false;
/** Whether the X-Ray Alt+Shift+X keydown listener is currently attached. */
let xrayListenerAttached = false;
/**
 * Observer epoch (Fix 4): every disconnect bumps it. A pending async reconnect
 * from a mutation callback carries the epoch it was issued under; if the epoch
 * changed (teardown / mode change / disabled), the stale reconnect is ignored.
 */
let observerEpoch = 0;

/**
 * Set when a route change was detected; consumed once by the next
 * syncRuntime so the resolved-background hold applies to exactly one
 * post-route apply (later applies reconcile normally).
 */
let pendingRouteBackgroundHold = false;

/** Consume a pending route background hold (single post-route apply). */
function consumeRouteBackgroundHold(): boolean {
  const pending = pendingRouteBackgroundHold;
  pendingRouteBackgroundHold = false;
  return pending;
}

/** Previously applied settings, used to reconcile the observer after a transient toggle. */
let lastSettings: Settings | null = null;

/**
 * Set when a route change was detected; consumed once by the next
 * syncRuntime so sidebar color hydration is labeled with its true trigger.
 */
let sidebarRoutePending = false;

/** Consume a pending route trigger for sidebar hydration labeling. */
function consumeSidebarRouteTrigger(): boolean {
  const pending = sidebarRoutePending;
  sidebarRoutePending = false;
  return pending;
}

/** Sidebar conversation/project links that justify a color hydration. */
const SIDEBAR_COLOR_LINK_SELECTOR = 'a[href*="/c/"], a[href*="/g/"]';

/** Dedicated sidebar color observer (independent of the main observer). */
let sidebarColorObserver: MutationObserver | null = null;

/**
 * Whether a mutation batch touched sidebar conversation/project structure.
 * Pure added-node scan: conversation message churn never matches, so large
 * WritingBlocks generate zero sidebar hydration work.
 */
function sidebarColorMutationRelevant(mutations: MutationRecord[]): boolean {
  for (const m of mutations) {
    for (const node of Array.from(m.addedNodes)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (typeof el.closest === "function" && el.closest("[data-cgl-xray-host]")) {
        continue;
      }
      if (
        typeof el.matches === "function" &&
        el.matches(SIDEBAR_COLOR_LINK_SELECTOR)
      ) {
        return true;
      }
      if (
        typeof el.querySelector === "function" &&
        el.querySelector(SIDEBAR_COLOR_LINK_SELECTOR)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Attach the dedicated sidebar color observer (idempotent). */
function connectSidebarColorObserver(): void {
  if (sidebarColorObserver || quiesced) return;
  const obs = new MutationObserver((mutations) => {
    if (!sidebarColorMutationRelevant(mutations)) return;
    void requestSidebarChatColorHydration("sidebar-structure");
  });
  // Role tag: content tests fake MutationObserver with singleton `last`
  // semantics; the tag lets fakes select the structural observer.
  try {
    (obs as unknown as Record<string, unknown>).cglSidebarColorObserver = true;
  } catch {
    /* tagging is best-effort only */
  }
  obs.observe(document.body, { childList: true, subtree: true });
  sidebarColorObserver = obs;
}

/** Detach the dedicated sidebar color observer (idempotent). */
function disconnectSidebarColorObserver(): void {
  if (sidebarColorObserver) {
    sidebarColorObserver.disconnect();
    sidebarColorObserver = null;
  }
}

/**
 * Last conversation/project fingerprints published to storage (change guards
 * — pointer writes happen at most once per route, never per refresh).
 */
let lastPublishedConversationFp: string | null | undefined = undefined;
let lastPublishedProjectFp: string | null | undefined = undefined;

/**
 * Publish the current conversation + project identities for the popup
 * (fingerprints only — never URL/token/title/text) and reconcile the
 * resolved chat-or-project background override. Best-effort async; never
 * blocks the sync apply.
 */
function syncConversationAppearance(settings: Settings): void {
  void (async () => {
    if (quiesced) return;
    const fp = await conversationFingerprintFromLocation();
    if (fp !== lastPublishedConversationFp) {
      lastPublishedConversationFp = fp;
      await publishCurrentConversationFingerprint(fp);
    }
    const projFp = await projectFingerprintFromToken(projectTokenFromLocation());
    if (projFp !== lastPublishedProjectFp) {
      lastPublishedProjectFp = projFp;
      await publishCurrentProjectFingerprint(projFp);
    }
    if (settings.enabled) {
      await applier.reconcileConversationBackgroundOverride(fp, projFp, settings);
    }
  })();
}

/** Whether this runtime has been quiesced (extension context invalidated). */
let quiesced = false;

/** The registered chrome.storage.onChanged listener (removed on quiesce). */
let storageChangeListener:
  | ((changes: Record<string, unknown>, area: string) => void)
  | null = null;

/**
 * Effective runtime observation requirement (Fix 3): appearance effects, a
 * non-visible persisted sidebar mode, an active transient sidebar effect, OR
 * an active writing-copy effect all require the structural observer.
 */
function hasRuntimeEffects(settings: Settings): boolean {
  return (
    hasAppearanceEffects(settings) ||
    hasSidebarEffects(settings) ||
    sidebarController.hasTransientSidebarEffect() ||
    hasWritingCopyEffects(settings)
  );
}

/**
 * Single coalesced refresh operation. The MutationObserver callback schedules
 * this (never a full storage read + rescan per mutation batch), so a burst of
 * synchronous DOM mutations produces exactly one refresh after the debounce
 * window. It updates BOTH appearance markers and sidebar detection/binding.
 */
const scheduleMarkerRefresh = debounce((): void => {
  void getSettings()
    .then((settings) => {
      applier.refreshMarkers(settings);
      sidebarController.refresh(settings);
      writingCopyController.refresh(settings);
      foldingController.refresh(settings);
      // Rebind the active sidebar row (rerenders replace rows); tint still
      // gated on the per-chat override class. NOTE: sidebar COLOR hydration
      // is deliberately NOT here — conversation/message DOM churn must never
      // trigger a full sidebar SHA/storage/layout pass (perf). Sidebar
      // structural changes arrive through the dedicated sidebar observer.
      try {
        syncActiveChatRow(conversationTokenFromLocation());
      } catch {
        /* DOM lookup must never break the coalesced refresh */
      }
    })
    .catch((err) => handleSettingsFailure(err, "scheduleMarkerRefresh"));
}, 120);

/** Apply settings and connect/disconnect the observer per the active profile. */
function syncRuntime(settings: Settings): void {
  // Route-transition hold: exactly one post-route apply preserves the
  // committed resolved background until the destination reconcile commits.
  // Ordinary settings changes always reconcile immediately.
  const holdRouteBackground = consumeRouteBackgroundHold();
  applier.apply(settings, {
    preserveResolvedBackground: holdRouteBackground,
  });
  sidebarController.apply(settings);
  writingCopyController.apply(settings);
  foldingController.apply(settings);

  // Fix 2: reflect enabled state and attach/detach the sidebar shortcut listener.
  runtimeEnabled = settings.enabled;
  if (settings.enabled && !keyboardListenerAttached) {
    document.addEventListener("keydown", handleKeydown);
    keyboardListenerAttached = true;
  } else if (!settings.enabled && keyboardListenerAttached) {
    document.removeEventListener("keydown", handleKeydown);
    keyboardListenerAttached = false;
  }

  // Phase 4: attach/detach the writing-copy shortcut listener independently so
  // it can be active only when the feature (and its shortcut) is enabled, and
  // never duplicates across repeated apply calls.
  if (
    writingCopyController.isShortcutActive(settings) &&
    !writingCopyListenerAttached
  ) {
    document.addEventListener("keydown", writingCopyController.keyboardHandler);
    writingCopyListenerAttached = true;
  } else if (
    !writingCopyController.isShortcutActive(settings) &&
    writingCopyListenerAttached
  ) {
    document.removeEventListener(
      "keydown",
      writingCopyController.keyboardHandler,
    );
    writingCopyListenerAttached = false;
  }

  // X-Ray maintenance port: the Alt+Shift+X listener is ALWAYS attached (it
  // must work even when the extension is disabled). Idempotent attach. It
  // intentionally SURVIVES quiesce so a stale runtime can still open the
  // local diagnostic panel, which visibly reports the stale context.
  if (!xrayListenerAttached) {
    document.addEventListener("keydown", handleXrayKeydown);
    xrayListenerAttached = true;
  }

  // Fix 3+4: synchronous connect/disconnect from validated settings.
  if (settings.enabled && hasRuntimeEffects(settings)) {
    connectObserver(settings);
  } else {
    disconnectObserver();
  }

  // Dedicated sidebar color observer: lives exactly while the extension is
  // enabled (independent of appearance-effect narrowing).
  if (settings.enabled) {
    connectSidebarColorObserver();
  } else {
    disconnectSidebarColorObserver();
  }

  // Per-chat background: publish identity for the popup + apply any stored
  // override for this conversation (falls back cleanly when none exists).
  syncConversationAppearance(settings);

  // Active sidebar row follows the in-memory route token (rebound on every
  // apply; the tint itself only paints under the per-chat override class).
  try {
    syncActiveChatRow(conversationTokenFromLocation());
  } catch {
    /* DOM lookup must never break the sync apply */
  }

      if (settings.enabled) {
        void requestSidebarChatColorHydration(
          consumeSidebarRouteTrigger() ? "route" : "initial",
        );
      }

  lastSettings = settings;
}

/**
 * Apply current settings; used on bootstrap, storage change, and route change.
 * NO-OP once quiesced: a dead runtime must never re-initialize features from
 * any settings source.
 */
function applyCurrent(): void {
  if (quiesced) return;
  void getSettings()
    .then(syncRuntime)
    .catch((err) => handleSettingsFailure(err, "applyCurrent"));
}

/**
 * Shared fail-closed handler for settings-load failures in fire-and-forget
 * flows: invalidated context latches invalidation (the quiesce listener does
 * the rest); every other error is recorded ONCE through the bounded internal
 * error bus. Defaults are never treated as authoritative here.
 */
export function handleSettingsFailure(err: unknown, operation: string): void {
  if (
    err instanceof SettingsUnavailableError &&
    err.code === CODE_EXTENSION_CONTEXT_INVALIDATED
  ) {
    if (!quiesced) quiesceStaleRuntime();
    return;
  }
  recordInternalError({
    code: "SETTINGS_LOAD_FAILED",
    scope: "content",
    err,
    operation,
  });
  logger.error("content", "settings load failed", err);
}

/**
 * Quiesce THIS stale content-script runtime cleanly once the extension
 * context is invalid. Stops extension-owned active behavior:
 *  - Writing Copy controller activity (host, tracker observers, rAF loops,
 *    visual state owned by this runtime);
 *  - the structural MutationObserver;
 *  - product keyboard listeners (sidebar / writing copy);
 *  - the route listener;
 *  - the chrome.storage.onChanged listener;
 *  - settings update activity (all future apply paths become no-ops).
 *
 * ChatGPT content is NEVER removed or modified. The X-Ray Alt+Shift+X port
 * stays usable as a LOCAL diagnostic; its panel visibly reports the stale
 * extension context instead of a normal green status.
 */
export function quiesceStaleRuntime(): void {
  if (quiesced) return;
  quiesced = true;
  scheduleMarkerRefresh.cancel();

  if (storageChangeListener && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    try {
      chrome.storage.onChanged.removeListener(storageChangeListener);
    } catch {
      // Context already gone: nothing left to remove.
    }
  }
  storageChangeListener = null;

  if (keyboardListenerAttached) {
    document.removeEventListener("keydown", handleKeydown);
    keyboardListenerAttached = false;
  }
  if (writingCopyListenerAttached) {
    document.removeEventListener(
      "keydown",
      writingCopyController.keyboardHandler,
    );
    writingCopyListenerAttached = false;
  }
  runtimeEnabled = false;
  disconnectObserver();
  disconnectSidebarColorObserver();
  sidebarController.teardown();
  writingCopyController.teardown();
  foldingController.teardown();
  applier.restore();
  routeListener.stop();
  logger.warn(
    "content",
    "runtime quiesced: extension context invalidated; reload the page",
  );
}

/**
 * Reconcile the structural observer against the last applied settings plus the
 * controller's current transient state. Used after a transient keyboard toggle
 * so a freshly hidden/closed sidebar becomes observed immediately, and a
 * restored one is disconnected when no other effect remains.
 */
function reconcileObserver(): void {
  if (!lastSettings || quiesced) return;
  if (runtimeEnabled && hasRuntimeEffects(lastSettings)) {
    connectObserver(lastSettings);
  } else {
    disconnectObserver();
  }
}

/** Whether a node is an extension-owned host the observer must ignore. */
function isExtensionHost(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    (node.id === SIDEBAR_HOST_ID ||
      node.getAttribute("data-cgl-sidebar-host") === "true" ||
      node.getAttribute(WRITING_COPY_HOST_ATTR) === "true" ||
      node.getAttribute("data-cgl-xray-host") === "true" ||
      node.getAttribute("data-cgl-folding-host") === "true" ||
      node.tagName.toLowerCase() === "style")
  );
}

/**
 * Route-settle guard (Phase 4 revisit fix): set synchronously on every route
 * change. While set, the structural observer rooting prefers document.body —
 * the async re-apply must never pin the observer to the OUTGOING conversation
 * container (still connected at that instant), which React then removes. An
 * observer on a detached root never sees the incoming conversation render, so
 * no refresh — and therefore no copied-state hydration — would ever be
 * re-driven. The guard is enforced BOTH synchronously in
 * `reapplyAfterRouteChange()` (immediate broaden to `document.body`) AND in
 * `connectObserver()` for the later async re-apply. It is cleared the moment
 * narrowing adopts a non-body root for the new route. Staying on body is
 * always the safe fallback (identical to the long-standing no-container
 * behavior).
 */
let preferBroadRoot = false;

/**
 * Pick the narrowest stable observer root.
 *  - When only appearance is active (no sidebar), observe the narrow
 *    conversation container (existing behavior).
 *  - When a sidebar mode is active, observe the lowest common ancestor of the
 *    safe sidebar target and the conversation container, falling back to a safe
 *    app-shell ancestor, and only to document.body when no narrower stable root
 *    exists. Never remain on document.body once a narrower root is available.
 */
function pickObserverTarget(settings: Settings): Node {
  if (preferBroadRoot) return document.body;
  return pickNarrowTarget(settings);
}

/**
 * Narrow-root computation ignoring the route-settle guard (used by the
 * narrowing step so a newly rendered container can still be adopted while the
 * guard is set).
 */
function pickNarrowTarget(settings: Settings): Node {
  const conv = adapter.detectConversationContainer().element;
  if (!hasSidebarEffects(settings) && !sidebarController.hasTransientSidebarEffect()) {
    return conv ?? document.body;
  }
  // Fix 3: use ONLY a target that passed the Phase 3 safety gate and
  // normalization — never the raw adapter candidate. The controller's detected
  // target (already gated) is preferred; otherwise fall back to a fresh safe
  // detection. An unsafe raw candidate is never used to narrow the observer.
  const safeSidebar =
    sidebarController.target ?? findSafeSidebarTarget(adapter);
  if (conv && safeSidebar) {
    const lca = lowestCommonAncestor(conv, safeSidebar);
    if (lca && lca !== document.documentElement) return lca;
  }
  if (safeSidebar) {
    const parent = safeSidebar.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) {
      return parent;
    }
  }
  // No safe sidebar yet: observe document.body (or another demonstrably safe
  // app-shell root) broadly enough to detect a later valid sidebar, then
  // reconnect to the narrower safe root once it appears.
  return document.body;
}

/** Lowest common ancestor of two elements, or null. */
function lowestCommonAncestor(a: Node, b: Node): Node | null {
  if (!a || !b) return null;
  const ancestors: Node[] = [];
  let n: Node | null = a;
  while (n) {
    ancestors.push(n);
    n = n.parentNode;
  }
  let m: Node | null = b;
  while (m) {
    if (ancestors.includes(m)) return m;
    m = m.parentNode;
  }
  return null;
}

/**
 * Synchronously attach (or reuse) the scoped observer to the narrowest stable
 * root for the given validated settings (Fix 4: no async fetch in the initial
 * path). Reconnect idempotently when the target changes.
 */
function connectObserver(settings: Settings): void {
  if (quiesced) return;
  const target = pickObserverTarget(settings);
  if (observedTarget === target && observer) return; // already observing
  if (observer) observer.disconnect();
  const epoch = observerEpoch;
  observer = new MutationObserver((mutations) => {
    let added = false;
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType === Node.ELEMENT_NODE && !isExtensionHost(node)) {
          added = true;
          break;
        }
      }
      if (added) break;
    }
    if (!added) return;
    // Cheap path: re-check route signature on structural changes.
    routeListener.check();
    // Reconnect to a narrower root if one just became available (Fix 4: guard
    // against a stale async result reconnecting after teardown/mode change).
    // Use the already-validated current settings (lastSettings) for the
    // narrowing decision rather than re-reading storage, which may resolve to
    // a stale snapshot and skip the reconnect.
    const s = lastSettings;
    if (s) {
      if (observerEpoch !== epoch) return; // superseded / torn down
      if (!s.enabled || !hasRuntimeEffects(s)) return; // effect gone
      // Re-detect with current DOM before narrowing (a safe sidebar may have
      // just appeared or moved), so the observer adopts the narrower safe root.
      sidebarController.refresh(s);
      const narrower = pickNarrowTarget(s);
      if (narrower && narrower !== observedTarget) {
        // The new route rendered a usable root: the settle window is over.
        if (narrower !== document.body) preferBroadRoot = false;
        connectObserver(s);
      }
    }
    // Coalesce refresh into one debounced operation.
    scheduleMarkerRefresh();
  });
  observedTarget = target;
  observer.observe(target, { childList: true, subtree: true });
}

/** Disconnect the active observer and bump the epoch (Fix 4). Idempotent. */
function disconnectObserver(): void {
  observerEpoch++;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  observedTarget = null;
}

/** Tear down observers and extension-owned UI without destroying page DOM. */
function teardown(): void {
  // Cancel any pending debounced refresh so it cannot re-mark the DOM after
  // teardown.
  scheduleMarkerRefresh.cancel();
  // Fix 2: remove the shortcut listeners.
  if (keyboardListenerAttached) {
    document.removeEventListener("keydown", handleKeydown);
    keyboardListenerAttached = false;
  }
  if (writingCopyListenerAttached) {
    document.removeEventListener("keydown", writingCopyController.keyboardHandler);
    writingCopyListenerAttached = false;
  }
  runtimeEnabled = false;
  disconnectObserver();
  disconnectSidebarColorObserver();
  preferBroadRoot = false;
  sidebarController.teardown();
  writingCopyController.teardown();
  foldingController.teardown();
  xrayController.stop();
  applier.restore();
}

/** Re-apply after a route change: restore markers, refresh, re-sync. */
function reapplyAfterRouteChange(): void {
  if (quiesced) return;
  // Settle guard FIRST, and broaden the observer SYNCHRONOUSLY (before the
  // async settings re-apply below resolves): the old narrowed observer must
  // not remain attached during the React replacement window. `lastSettings`
  // is the already-validated active snapshot — no new storage read is needed
  // merely to broaden. `connectObserver()` replaces the target through its
  // existing idempotent path WITHOUT bumping `observerEpoch` (that would
  // discard the detecting batch); combined with the guard, the later async
  // `syncRuntime()` also roots at `document.body` instead of the outgoing
  // container. Narrowing adopts the new route's container on the next
  // structural batch and clears the guard.
  preferBroadRoot = true;
  // The next syncRuntime holds the committed resolved background (exactly
  // one post-route apply) and labels its sidebar color hydration as a
  // route trigger (true even if the async apply lands after more mutations).
  pendingRouteBackgroundHold = true;
  sidebarRoutePending = true;
  if (
    lastSettings &&
    lastSettings.enabled &&
    hasRuntimeEffects(lastSettings)
  ) {
    connectObserver(lastSettings);
  }
  // NOTE: no applier.restore() here. A full appearance restore would clear
  // persistent sidebar color state and main-background variables, flashing
  // official styling until the async re-apply resolves. The last valid
  // visual state is kept until syncRuntime's apply() reconciles volatile
  // presentation and the async background/sidebar hydration commits the
  // destination state directly (same-color routes show zero flash).
  sidebarController.restore();
  writingCopyController.restore();
  foldingController.restore();
  xrayController.stop(); // X-Ray is page-local; a route change closes it.
  adapter.refresh();
  applyCurrent();
}

/**
 * Global keydown handler for the fixed `Alt+Shift+L` sidebar shortcut.
 *
 * Order of checks (Fix 2): healthy-runtime -> enabled -> not repeat -> not
 * composing -> non-editable origin -> exact modifiers + KeyL ->
 * preventDefault -> toggle. No storage read is performed merely to determine
 * whether the extension is enabled; the synchronous `runtimeEnabled` flag is
 * used instead.
 */
function handleKeydown(e: KeyboardEvent): void {
  // 0. quiesced runtimes perform no product actions
  if (quiesced) return;
  // 1. enabled
  if (!runtimeEnabled) return;
  // 2. ignore repeats
  if (e.repeat) return;
  // 3. ignore composition
  if (e.isComposing || e.key === "Process") return;
  // 4. ignore editable origins
  const t = e.target as Element | null;
  if (t) {
    const tag = t.tagName?.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      t.getAttribute("contenteditable") === "true" ||
      t.getAttribute("role") === "textbox"
    ) {
      return;
    }
  }
  // 5. exact modifier match: Alt+Shift+KeyL, no Ctrl/Meta.
  const match =
    e.altKey &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    e.code === "KeyL";
  if (!match) return;
  // 6. prevent default only after an exact valid match.
  e.preventDefault();
  // 7. toggle sidebar transient state.
  sidebarController.onKeyboardToggle();
  // Fix 3: after the transient toggle (Alt+Shift+L), re-evaluate whether the
  // structural observer is required and connect/disconnect accordingly. This
  // runs synchronously so a freshly hidden/closed sidebar is observed at once.
  reconcileObserver();
}

/**
 * Global keydown handler for the X-Ray maintenance shortcut `Alt+Shift+X`.
 *
 * Unlike product shortcuts, X-Ray works EVEN when the extension is disabled —
 * it is a maintenance port, so only repeat/composition/editable-origin safety
 * checks apply. After quiesce it remains available as a LOCAL diagnostic; the
 * panel visibly reports STALE EXTENSION CONTEXT. The controller itself owns
 * the ON/OFF toggle state and the exact modifier match (Alt+Shift+KeyX, no
 * Ctrl/Meta).
 */
function handleXrayKeydown(e: KeyboardEvent): void {
  if (e.repeat) return;
  if (e.isComposing || e.key === "Process") return;
  const t = e.target as Element | null;
  if (t) {
    const tag = t.tagName?.toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      t.getAttribute("contenteditable") === "true" ||
      t.getAttribute("role") === "textbox"
    ) {
      return;
    }
  }
  if (!isXrayShortcut(e)) return;
  e.preventDefault();
  xrayController.handleKeydown();
}

async function bootstrap(): Promise<void> {
  // Canonical extension-context health FIRST: probe before any feature reads
  // settings, so a stale runtime fails closed instead of continuing on
  // defaults. The probe performs ONE harmless bounded storage read.
  await probeExtensionContext();
  if (quiesced) return;

  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (err) {
    handleSettingsFailure(err, "bootstrap");
    return;
  }
  if (quiesced) return;
  syncRuntime(settings);
  routeListener.onChange(() => {
    reapplyAfterRouteChange();
  });
  routeListener.start();

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    storageChangeListener = (changes, area) => {
      if (area !== "local") return;
      if (!("settings" in changes)) {
        // Live appearance update (popup save/reset for chat OR project):
        // no settings reload needed — reconcile the resolved background
        // and rehydrate sidebar row colors for this conversation.
        if (
          Object.keys(changes).some(
            (k) =>
              k === CURRENT_CONVERSATION_KEY ||
              k === CURRENT_PROJECT_KEY ||
              k.startsWith(CONVERSATION_APPEARANCE_PREFIX) ||
              k.startsWith(PROJECT_APPEARANCE_PREFIX),
          )
        ) {
          void (async () => {
            const s = lastSettings;
            if (quiesced || !s?.enabled) return;
            const fp = await conversationFingerprintFromLocation();
            const projFp = await projectFingerprintFromToken(
              projectTokenFromLocation(),
            );
            await applier.reconcileConversationBackgroundOverride(fp, projFp, s);
            // A reset chat/project loses its sidebar color immediately;
            // other saved rows persist (hydrate reconciles, never repaints
            // unchanged rows).
            await requestSidebarChatColorHydration("storage");
          })();
        }
        return;
      }
      void getSettings()
        .then((s) => {
          // Fix 5: clear transient state only for relevant changes.
          const prev = lastSettings;
          const modeChanged = !!prev && s.sidebar.mode !== prev.sidebar.mode;
          const disabled = !!prev && prev.enabled && !s.enabled;
          const writingCopyRelevant =
            !!prev &&
            (s.writingCopy.enabled !== prev.writingCopy.enabled ||
              s.writingCopy.position !== prev.writingCopy.position ||
              s.writingCopy.shortcutEnabled !== prev.writingCopy.shortcutEnabled ||
              s.writingCopy.markerEnabled !== prev.writingCopy.markerEnabled ||
              s.writingCopy.markerColor !== prev.writingCopy.markerColor ||
              s.writingCopy.markerOpacity !== prev.writingCopy.markerOpacity ||
              s.writingCopy.pulseEnabled !== prev.writingCopy.pulseEnabled ||
              s.writingCopy.pulseColor !== prev.writingCopy.pulseColor ||
              s.writingCopy.pulseIntensity !== prev.writingCopy.pulseIntensity ||
              s.writingCopy.pulsePeriodMs !== prev.writingCopy.pulsePeriodMs ||
              s.writingCopy.backgroundEnabled !== prev.writingCopy.backgroundEnabled ||
              s.theme.writingBlockBackground !== prev.theme.writingBlockBackground);
          if (modeChanged || disabled) {
            sidebarController.clearTransient();
          }
          if (writingCopyRelevant) {
            writingCopyController.restore();
          }
          syncRuntime(s);
        })
        .catch((err) => handleSettingsFailure(err, "storageChange"));
    };
    chrome.storage.onChanged.addListener(storageChangeListener);
  }

  logger.info("content", "Lite UI content script active", {});
}

// Exposed for tests only (does not run any side effects on import).
export {
  applier,
  adapter,
  sidebarController,
  writingCopyController,
  foldingController,
  xrayController,
  routeListener,
  connectObserver,
  disconnectObserver,
  teardown,
  reapplyAfterRouteChange,
  syncRuntime,
  scheduleMarkerRefresh,
  pickObserverTarget,
  handleKeydown,
  handleXrayKeydown,
  hasRuntimeEffects,
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
  } else {
    void bootstrap();
  }
}
