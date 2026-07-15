# Architecture

This document describes the structure of the ChatGPTLiteUI extension
(Manifest V3) as of Phase 3 (appearance controls + safe sidebar visibility).

## High-level design

The extension is a **display/appearance layer** placed on top of the official
ChatGPT web interface. It does not replace or proxy ChatGPT; it only:

- reads presentation settings from `chrome.storage.local`;
- toggles extension-owned root classes (`cgl-active` plus opt-in toggles) on
  `document.documentElement`;
- sets scoped `--cgl-*` CSS variables and marks detected surfaces with
  `data-cgl-*` attributes;
- injects cosmetic rules guarded by those markers;
- reacts to storage changes;
- restores the original appearance when disabled, on the Normal preset, on
  route teardown, or on lifecycle teardown.

## Directory layout

```text
manifest.json
src/
  content/        content script: bootstrap, lifecycle, route listener
  adapters/       ChatGPT DOM detection (non-destructive)
  features/appearance/  presets, markers, appearance controller
  features/sidebar/     sidebar state, markers, detection, control host, controller
  settings/       schema (v2), defaults, migration, storage
  shared/         debounce, logger, shared types
  popup/          enable/preset/sidebar popup
  options/        full Phase 2/3 appearance + sidebar editor
  styles/         CSS variable + injected style layers
scripts/          build + safety/audit tooling
tests/            unit, adapter, settings, security, feature tests
docs/             architecture, plan, safety, data-handling, permissions
```

## Key components

### Settings schema v2 (`src/settings/`)

A versioned envelope `{ schemaVersion, settings }` is persisted. Validation is
fail-closed: unknown keys and out-of-schema fields (including any chat-content
field) are rejected. The `appearance` section adds explicit activation flags
(`useConversationWidth`, `useFontSize`, `useTheme`) so the `normal` preset means
*no visual overrides* rather than fake default colors. Numeric fields are
bounded integers (width 480–1600, font 12–24). Colors use a conservative
grammar (`#rgb`, `#rrggbb`, `#rrggbbaa`, `transparent`). `migrateEnvelope`
provides deterministic v1→v2 migration.

### Appearance feature (`src/features/appearance/`)

- `presets.ts`: the four predefined profiles and the pure functions
  `applyAppearancePreset` / `detectAppearancePreset`. Manual edits derive
  `custom`.
- `markers.ts`: extension-owned `data-cgl-*` marker helpers and a single
  idempotent `clearAllMarkers`.
- `appearance-controller.ts`: applies/removes classes, CSS variables, and
  markers; the complete restore path.

### Adapter (`src/adapters/`)

The Adapter detects ChatGPT UI structures using **multiple ordered selector
strategies** that prefer semantic attributes and avoid guessed broad selectors.
Every detection returns a typed `DetectionResult`. Ambiguous matches are
refused rather than guessed. In Phase 2 the Adapter additionally exposes
`detectConversationColumn` (semantic, cardinality-checked, ambiguity-refusing)
used only for cosmetic width marking. The Adapter remains **strictly
non-destructive**: it observes only.

### Sidebar feature (`src/features/sidebar/`)

Phase 3 adds four visibility modes (`visible`, `hover`, `button`, `hidden`)
without touching ChatGPT's own classes, inline styles, aria attributes, IDs,
or roles.

- `sidebar-state.ts`: pure helpers. `hasSidebarEffects` reports a non-visible
  mode; `hasRuntimeEffects` = `hasAppearanceEffects || hasSidebarEffects`,
  which decides whether the structural MutationObserver is attached (a
  non-visible sidebar mode activates observation even on a Normal appearance
  profile). `effectiveSidebarOpen` computes visibility from the configured mode
  plus transient state.
- `sidebar-markers.ts`: the single extension-owned `data-cgl-sidebar-target`
  marker and an idempotent `clearAllSidebarMarkers`.
- `sidebar-detection.ts`: `isSafeSidebarDetection` hardens the Adapter result
  (single high/medium-confidence connected element, not html/body/main/composer,
  not inside a dialog, a navigation landmark or containing a unique nav with
  sidebar structure). `normalizeSidebarTarget` may lift an inner `nav` up to a
  unique `aside`/`[data-testid="sidebar"]` wrapper; otherwise it marks only the
  nav. `findSafeSidebarTarget` returns the normalized target or null.
- `sidebar-control-host.ts`: exactly one Shadow DOM host for `hover` (edge
  rail) or `button` (toggle). Styles are fully contained; the host is appended
  to `document.body` (never inside the sidebar) and carries an extension-owned
  id so the observer ignores it. No duplicate hosts; teardown removes it.
- `sidebar-controller.ts`: the state machine. The configured mode is the
  persistent truth; pointer/focus/button/Escape/keyboard affect only transient
  state. Hiding adds the `cgl-sidebar-closed` root class; showing removes it so
  the official stylesheet controls layout again. `restore()`/`teardown()`
  remove every `cgl-sidebar-*` class, marker, host, listener, timer, and
  reference idempotently.

### Content runtime (`src/content/`)

- `index.ts` bootstraps, applies appearance and sidebar settings, wires
  `chrome.storage.onChanged`, handles the fixed `Alt+Shift+L` sidebar shortcut
  (validated: enabled-only, ignore repeat/composition, ignore editable fields,
  `preventDefault` only on exact match), and re-applies on SPA route changes
  (restore → refresh adapter → apply). A mode change clears transient state.
- `lifecycle.ts` wires the `AppearanceController` to the document root.
- `route-listener.ts` detects single-page-app route changes without
  monkeypatching `history.pushState`, using `popstate`/`pageshow`, a
  `location` signature, and observer-triggered checks. No high-frequency timer.
- The `SidebarController` instance is owned by the content runtime and shares
  the same debounced refresh path and observer lifecycle as appearance.

## Observers

The `MutationObserver` is attached to the **narrowest stable container** once
found, not `document.body` indefinitely. When a sidebar mode is active, the
observer target is the lowest common ancestor of the safe sidebar target and
the conversation container (falling back to a safe app-shell ancestor, and only
to `document.body` when no narrower stable root exists); it never remains on
`document.body` once a narrower root is available. Added nodes that belong to
the extension-owned Shadow DOM control host are ignored. Mutation handling is
debounced and inspects only added nodes. Observers are disconnected during
teardown.

## Build and distribution

`scripts/build-extension.mjs` (esbuild) produces `dist/` with source maps
disabled. The manifest, network, and distribution audits verify the build
against the locked architecture decisions.

## Deferred extension points

The Adapter and settings schema include fields and interfaces for copy helpers,
folding, and history limiting. Destructive operations (especially history
hiding) will require high-confidence detection plus extra safety invariants and
reload-based restoration. These are not implemented in Phase 3. Sidebar control
is implemented as a non-destructive, CSS-based visibility feature.
