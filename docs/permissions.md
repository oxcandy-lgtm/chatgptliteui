# Permissions

This document records the extension's Chrome permissions and the rationale.

## Granted permissions (exact)

```json
{
  "permissions": ["storage"],
  "incognito": "not_allowed"
}
```

- `storage` — persist presentation preferences locally.
- `incognito: "not_allowed"` — the extension does not operate in incognito
  mode. This is intentional and documented in PRIVACY.md.

## Site access

Site access is declared through the static content-script match only:

```json
{
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*"],
      "js": ["content/content.js"],
      "css": ["content/content.css"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ]
}
```

No `host_permissions` are used. The static match is the sole site-access
declaration and guarantees the extension activates only on chatgpt.com.

## Explicitly not requested

The following permissions are intentionally absent and must not be added
without a documented review:

- `host_permissions`, optional all-site access, `<all_urls>`
- `clipboardRead`, `clipboardWrite`
- `tabs`, `history`, `cookies`, `webRequest`, `identity`
- `scripting`, `downloads`, `nativeMessaging`, `debugger`, `unlimitedStorage`

## Background

No background Service Worker is included in Phase 0 through Phase 3. The content
script, popup, and options page access `chrome.storage.local` directly. A
Service Worker may be added later only if a concrete API requirement cannot be
implemented safely without one, and only after review.

## Audit

`scripts/audit-manifest.mjs` verifies these constraints on every build in CI.
