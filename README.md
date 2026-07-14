# ChatGPTLiteUI

A privacy-safe Chrome extension (Manifest V3) that adds lightweight appearance
and display controls **on top of the official ChatGPT web interface**. It does
not replace ChatGPT, does not proxy its traffic, and does not read, store, or
transmit any conversation content.

This repository currently contains the **Phase 0 public-safety and extension
foundation**. Product features (sidebar control, copy helpers, code/long-response
folding, history limiting, and memory-reduction experiments) are planned but
not yet implemented. See [`docs/implementation-plan.md`](docs/implementation-plan.md).

## What it does today (Phase 0)

- Loads presentation settings from `chrome.storage.local`.
- Adds an extension-owned root class (`cgl-active`) and harmless CSS variables.
- Exposes a minimal popup (enable/disable, preset) and an options page
  (appearance subset: animations, blur, shadows, spacing, width, font size,
  theme colors).
- Reacts to storage changes and restores the original page appearance when
  disabled.
- Makes **no external network requests** and performs **no destructive DOM
  operations**.

## Privacy posture

- Permissions are limited to `storage`.
- No `host_permissions`, no `clipboardRead`/`clipboardWrite`, no `tabs`, no
  `history`, no `cookies`, no `webRequest`, no Service Worker.
- The content script runs only on `https://chatgpt.com/*`.
- The extension never persists chat text, titles, copied content, URLs, account
  data, or DOM snapshots. The settings schema has no fields for that data.

See [`SECURITY.md`](SECURITY.md), [`PRIVACY.md`](PRIVACY.md), and
[`docs/`](docs/) for full details.

## Development

```bash
npm ci
npm run safety          # public-safety scanner (run before install in CI)
npm run lint
npm run typecheck
npm test
npm run build           # produces dist/
npm run audit:manifest
npm run audit:network
npm run audit:dist
```

Load the unpacked `dist/` directory in `chrome://extensions` (Developer mode →
Load unpacked).

## License

MIT — see [`LICENSE`](LICENSE).
