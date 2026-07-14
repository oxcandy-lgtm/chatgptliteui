# ChatGPTLiteUI

A privacy-safe Manifest V3 Chrome extension that adds lightweight **appearance
and display controls** on top of the official ChatGPT web interface. It does not
replace, proxy, or read ChatGPT; no chat content is read, stored, or
transmitted.

## What it does

- **Appearance controls (Phase 2):** animation/transition reduction, blur
  reduction (backdrop-filter only), shadow reduction, compact spacing, custom
  conversation width and font size, and a conservative color theme. Four
  appearance-only presets (`normal`, `minimal`, `work`, `ultra-lite`) plus a
  derived `custom` state.
- **Safe sidebar visibility controls (Phase 3):** four modes —
  `visible`, `hover`, `button`, `hidden` — controlled through extension-owned
  CSS and a Shadow DOM control host. A fixed keyboard shortcut
  (`Alt`+`Shift`+`L`) temporarily toggles the sidebar.

## Safety model

- Manifest V3, `storage` permission only, no `host_permissions`, no Service
  Worker, no external network, no telemetry.
- The content script only toggles extension-owned root classes
  (`cgl-active`, `cgl-sidebar-*`), sets scoped `--cgl-*` CSS variables, and
  marks detected surfaces with `data-cgl-*` attributes. It never deletes,
  detaches, rewrites, reorders, or clones ChatGPT content.
- Detection failure preserves the official UI (fail-open for the page).
- Sidebar hiding is a single extension-owned marker (`data-cgl-sidebar-target`)
  plus the `cgl-sidebar-closed` root class; removal restores the page exactly.

## Sidebar modes

| Mode | Behavior |
| --- | --- |
| `visible` | Official sidebar unchanged. Shortcut can temporarily hide. |
| `hover` | Closed by default; an edge rail opens it on pointer or focus. |
| `button` | Closed by default; a toggle button (and `Alt`+`Shift`+`L`) opens it; `Esc` closes it. |
| `hidden` | Closed with no on-page control; `Alt`+`Shift`+`L`, the popup, or options can restore it. |

Controls are non-destructive and do not remove conversation history.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:manifest && npm run audit:network && npm run audit:dist
```

See [`docs/`](docs/) for architecture, the phased implementation plan,
data-handling boundaries, and permissions rationale.

## Deferred (not in this release)

Sidebar copy helpers, code/long-response folding, history limiting, image
unloading, DOM removal, and memory reduction remain deferred. Memory reduction
is **not** claimed.
