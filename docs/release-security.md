# Release Security

This document covers the security expectations for building and releasing the
extension.

## Build integrity

- The build uses esbuild with **source maps disabled** in production.
- `scripts/build-extension.mjs` starts by removing `dist/` so stale files
  cannot be included.
- Every file referenced by `manifest.json` is verified to exist in `dist/`.

## Distribution audit (`scripts/audit-dist.mjs`)

The distributed `dist/` must contain **only** an approved allowlist:

- `manifest.json`
- `content/content.js`, `content/content.css`
- `popup/*`, `options/*`
- `icons/icon-{16,32,48,128}.png`

The audit rejects:

- source maps (`.map`) and `sourceMappingURL` references;
- `tests/`, `fixtures/`, `screenshots/`, `.env`, `.log`;
- `node_modules/`, `src/`, `scripts/`, `docs/`;
- any local absolute path leak inside built JS/CSS;
- any file outside the fixed allowlist.

## Network audit (`scripts/audit-network-usage.mjs`)

Scans executable product code (source and built JS) for `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, and `sendBeacon`, plus external
asset URLs. Documentation prose is excluded. The extension must contain no
runtime network usage.

## Manifest audit (`scripts/audit-manifest.mjs`)

Enforces Manifest V3, exact permissions, the exact ChatGPT content-script
match, no `host_permissions`, no all-site access, `incognito: not_allowed`, no
background Service Worker, no remote code, and no externally connectable
surface.

## Publication checklist

- All CI jobs pass (safety → install → lint → typecheck → unit → security →
  build → manifest audit → network audit → dist audit).
- No real chat content, titles, copied text, account data, local paths, or
  personal screenshots are present in any published artifact.
- Screenshots used in store listings are synthetic or redacted.
- Version and changelog are accurate; memory-reduction claims (if any) are
  presented as measured results, not guarantees.
