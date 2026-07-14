# Architecture

This document describes the structure of the ChatGPTLiteUI extension
(Manifest V3) as of Phase 2 (minimal appearance controls).

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
  settings/       schema (v2), defaults, migration, storage
  shared/         debounce, logger, shared types
  popup/          enable/preset popup
  options/        full Phase 2 appearance editor
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

### Content runtime (`src/content/`)

- `index.ts` bootstraps, applies settings, wires `chrome.storage.onChanged`,
  and re-applies on SPA route changes (restore → refresh adapter → apply).
- `lifecycle.ts` wires the `AppearanceController` to the document root.
- `route-listener.ts` detects single-page-app route changes without
  monkeypatching `history.pushState`, using `popstate`/`pageshow`, a
  `location` signature, and observer-triggered checks. No high-frequency timer.

## Observers

The `MutationObserver` is attached to the **narrowest stable container** once
found, not `document.body` indefinitely. Mutation handling is debounced and
inspects only added nodes. Observers are disconnected during teardown.

## Build and distribution

`scripts/build-extension.mjs` (esbuild) produces `dist/` with source maps
disabled. The manifest, network, and distribution audits verify the build
against the locked architecture decisions.

## Deferred extension points

The Adapter and settings schema include fields and interfaces for sidebar
control, copy helpers, folding, and history limiting. Destructive operations
(especially history hiding) will require high-confidence detection plus extra
safety invariants and reload-based restoration. These are not implemented in
Phase 2.
