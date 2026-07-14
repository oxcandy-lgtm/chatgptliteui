# Architecture

This document describes the structure of the ChatGPTLiteUI extension
(Manifest V3) as of the Phase 0 foundation.

## High-level design

The extension is a **display/appearance layer** placed on top of the official
ChatGPT web interface. It does not replace or proxy ChatGPT; it only:

- reads presentation settings from `chrome.storage.local`;
- toggles an extension-owned root class on `document.documentElement`;
- injects harmless CSS variables and cosmetic rules;
- reacts to storage changes;
- restores the original appearance when disabled.

## Directory layout

```text
manifest.json
src/
  content/        content script: bootstrap, lifecycle, route listener
  adapters/       ChatGPT DOM detection (non-destructive)
  settings/       schema, defaults, migration, storage
  shared/         debounce, logger, shared types
  popup/          minimal enable/preset popup
  options/        appearance-subset options page
  styles/         CSS variable + injected style layers
scripts/          build + safety/audit tooling
tests/            unit, adapter, settings, security tests
docs/             architecture, plan, safety, data-handling, permissions
```

## Key components

### Settings (`src/settings/`)

A versioned envelope `{ schemaVersion, settings }` is persisted. Validation is
fail-closed: unknown keys and out-of-schema fields (including any chat-content
field) are rejected. Migrations run only for known older versions.

### Adapter (`src/adapters/`)

The Adapter detects ChatGPT UI structures using **multiple ordered selector
strategies** that prefer semantic attributes and avoid guessed broad selectors.
Every detection returns a typed `DetectionResult` with `found`, `element(s)`,
`confidence`, `strategy`, `reason`, and `timestamp`. Ambiguous matches (a
single-cardinality selector hitting multiple incompatible elements) are
refused rather than guessed.

In Phase 0 the Adapter is **strictly non-destructive**: it observes only.

### Content runtime (`src/content/`)

- `index.ts` bootstraps, applies settings, wires `chrome.storage.onChanged`,
  and sets up a scoped `MutationObserver`.
- `lifecycle.ts` applies/removes the extension-owned classes and CSS variables.
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

## Future extension points

The Adapter and settings schema include fields and interfaces for sidebar
control, copy helpers, folding, and history limiting. Destructive operations
(especially history hiding) will require high-confidence detection plus extra
safety invariants and reload-based restoration. These are not implemented in
Phase 0.
