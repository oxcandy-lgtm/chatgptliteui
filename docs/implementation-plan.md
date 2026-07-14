# Implementation Plan

This is a public, phased plan for the ChatGPTLiteUI extension. It builds a
privacy-safe appearance and display layer on top of the official ChatGPT web
interface, starting from a minimal foundation and adding capabilities in order
of risk.

> **Memory-reduction disclaimer:** Strong memory reduction is an *experiment*,
> not a guarantee. `display:none` is primarily a rendering/UI optimization.
> Detached parking may retain memory and must not be presented as effective
> without measurement. Complete DOM removal requires conservative safety gates
> and reload-based restoration.

## Phase 1 — Foundation and safety (this repository, current)

Establish the public OSS safety baseline:

- Manifest V3 with minimal permissions (`storage` only).
- Static content-script match on `https://chatgpt.com/*`.
- TypeScript + esbuild, source maps disabled.
- Public-safety scanner, manifest/network/distribution audits, CI.
- Settings schema with fail-closed validation and versioned migration.
- Non-destructive Adapter with typed detection results.
- Minimal runtime: load settings, toggle root class, inject CSS variables,
  popup and options pages, storage listener, SPA route lifecycle.
- No external network requests; no destructive DOM operations.

## Phase 2 — Minimal appearance controls (implemented)

Appearance-only controls, applied through extension-owned markers and CSS
variables. No ChatGPT class is ever altered.

- Animation / transition / smooth-scroll disabling (opt-in, broad but guarded
  by the `cgl-no-anim` root class).
- Blur reduction: disables `backdrop-filter` only (ordinary `filter` is left
  intact so icons/disabled states keep their meaning).
- Shadow reduction: disables `box-shadow` and `text-shadow`.
- Compact conversation spacing (scoped to message surfaces, never controls).
- Conversation width applied only to marked conversation/message/composer
  surfaces via `min(100%, var(--cgl-conversation-width))`; sidebar, dialogs,
  and modals are never resized.
- Font size scoped to user/assistant messages, composer, and code — never
  `:root`.
- Background and text color theming via scoped `--cgl-*` variables and
  `data-cgl-*` markers (page, conversation, user, assistant, input, code,
  text). Writing-block background is reserved for Phase 4 and not applied.
- Presets (`normal`, `minimal`, `work`, `ultra-lite`) are appearance-only and
  never touch deferred feature fields; manual edits derive `custom`.
- Settings schema v2 with fail-closed validation, bounded integer fields, and a
  conservative color grammar. Deterministic v1→v2 migration.
- Complete restoration contract: disabling, Normal preset, route teardown, and
  lifecycle teardown all remove every `cgl-*` class, `--cgl-*` variable, and
  `data-cgl-*` marker idempotently.
- No external network requests; no new Chrome permission; no chat content
  persisted.

## Phase 3 — Sidebar control

- Modes: visible, hover, button, hidden.
- Keyboard shortcut to toggle.
- Never breaks ChatGPT conversation navigation; falls back to official UI when
  detection fails.

## Phase 4 — Writing-block copy controls

- Detect writing blocks and track the most viewport-centered one.
- Floating copy button inside a Shadow DOM (no style clash).
- Prefer the page's original copy action when reliably available; otherwise
  attempt `navigator.clipboard.writeText()` only during a direct user gesture;
  on failure show a non-destructive error.
- Never add `clipboardWrite` unless real-browser evidence proves it necessary
  and a separate permission review approves it. Never read the clipboard. Never
  store copied content.

> **Tracking correction:** do not use `IntersectionObserver` with only
> `threshold: 0.5`; large blocks may never reach 50% visibility. Collect
> intersecting candidates with `threshold: 0`, recalculate viewport-center
> distance using a `requestAnimationFrame`-throttled scroll handler or at
> action time, and release all element references during route teardown.

## Phase 5 — Code and long-response folding

- Collapse code blocks beyond a line threshold (individual + expand-all).
- Collapse long responses beyond a height/length threshold.
- Never rewrite message text; keep the original DOM; never break copy.
- Do not auto-fold while ChatGPT is generating.

## Phase 6 — Safe history limiting

- Visible-pair slider (e.g. 5/10/20/50/all).
- Pair a user turn with its following assistant turn as one pair.
- Hide older turns with CSS and an extension attribute; show an omission bar.
- Use a scoped, debounced `MutationObserver` to follow new turns.
- Destructive hiding requires high-confidence detection plus safety invariants.

## Phase 7 — Experimental aggressive memory reduction

- Compare `display:none`, `content-visibility`, detached parking, reference
  dropping, and reload-based removal.
- Default off; explicit opt-in; disabled during generation or with unsent
  input.
- Publish only measured, aggregate results. Do not overstate effectiveness.

## Phase 8 — Measurement and release preparation

- Memory and DOM-node measurement using reproducible conditions and the median
  of multiple runs.
- Publish only synthetic descriptions, counts, and aggregate metrics — never
  real conversation titles or content.
- Chrome Web Store preparation and stability hardening.

## Data-handling boundary

Real local tests may use personal data, but only aggregate, anonymized metrics
may be published. Never commit, push, upload, or print real chat content,
titles, copied text, account data, local paths, or screenshots.
