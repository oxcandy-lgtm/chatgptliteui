# Security Policy

ChatGPTLiteUI is a public, open-source browser extension. This document
describes its threat model and the safeguards enforced in the repository.

## Scope

The extension operates entirely as a display/appearance layer over the
official ChatGPT website. It does not:

- replace or proxy ChatGPT's network communication;
- intercept, modify, or read request/response bodies;
- authenticate on the user's behalf;
- access cookies, tokens, or authorization headers;
- send any data to external servers.

## Permissions

The extension requests exactly one Chrome permission:

- `storage` — to persist presentation preferences locally.

It declares no `host_permissions`, no optional all-site access, and no
background Service Worker. The site-access declaration is the static
content-script match `https://chatgpt.com/*`.

## Data handled

Only presentation settings are persisted:

- colors, sizes, toggles, visible-pair counts, preset names, sidebar mode.

The settings schema has **no fields** for chat text, titles, copied content,
URLs, account data, or DOM snapshots. Unknown keys are rejected at validation
time (fail-closed).

## Supply-chain and CI safeguards

- The public-safety scanner runs **before** dependency installation in CI.
- Manifest, network-usage, and distribution audits run on every build.
- No source maps, tests, fixtures, screenshots, or local paths are allowed in
  the distributed `dist/`.
- The build uses a minimal dependency set and esbuild with source maps
  disabled.

## Reporting a vulnerability

Report suspected vulnerabilities through the repository's private security
reporting channel. Do not include real chat content, credentials, or personal
data in a report. Use synthetic descriptions only.

## Out of scope (deferred)

Sidebar control, copy helpers, folding, history limiting, and aggressive
memory-reduction are planned but not yet implemented. Each will undergo the
same permission, network, and data-handling review before being merged.
