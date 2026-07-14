# Public Safety

The public-safety scanner (`scripts/public-safety.mjs`) is the first gate in
CI and runs **before** dependency installation so that secrets cannot hide in
lockfiles.

## Design

- Uses Node built-in modules only (no third-party dependencies).
- Scans **tracked files plus untracked non-ignored files** (not `git ls-files`
  alone), and always includes a fixed set of root/config paths.
- Never prints the matched secret, personal information, or the full source
  line. It reports only: file path, line number, rule ID, and a redacted
  category.
- The scanner must not self-trigger on its own rule definitions. This is
  handled by a **narrow exemption**: only the lines between the `RULES-START`
  and `RULES-END` markers in `scripts/public-safety.mjs` are skipped. Every
  other line of that file, and every file under `scripts/` and `tests/`, is
  fully scanned. A prohibited value placed outside the rule-declaration block
  is still detected (proven by regression tests).

## Detected categories

- Private-key blocks (RSA/EC/OpenSSH/PGP, etc.).
- Contextual token/secret assignments (`apiKey = ...`, `authToken = ...`).
- Authorization / Cookie headers.
- Real-looking email addresses (reserved documentation values allowed).
- IPv4/IPv6 addresses outside documented test ranges (RFC 5737 / RFC 3849
  reserved ranges allowed).
- Unix, macOS, and Windows absolute user paths.
- Webhook URLs (Discord/Slack/Telegram bots).
- Browser-profile paths.
- Sensitive artifact names (HAR/cookie/session exports).
- Source-map local-path leaks.

## High-entropy handling

The scanner avoids a naive blanket rule that rejects every 32-character hex
value (which would wrongly reject hashes, colors, and lockfile data). High
entropy is matched **contextually**: only when a credential key is present
alongside a long token-like string.

## Tests

`tests/security/scanner.test.ts` proves:

- prohibited synthetic data is detected;
- reserved documentation values are allowed;
- CSS color values are allowed;
- commit-like hashes are not automatically rejected;
- scanner output does not reproduce the matched value.

Negative tests assemble synthetic prohibited values at runtime in a temporary
directory so they never appear as real secrets in the repository.
