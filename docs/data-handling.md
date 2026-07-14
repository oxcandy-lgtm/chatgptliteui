# Data Handling

This document defines what the extension is allowed to persist and how that
boundary is enforced in code.

## Persisted data (allowlist)

Only presentation settings are stored, in a versioned envelope:

```ts
interface StoredSettingsEnvelope {
  schemaVersion: number;
  settings: Settings;
}
```

The `Settings` object (schema version 2) contains exclusively:

- `enabled`, `preset` (`normal` | `minimal` | `work` | `ultra-lite` | `custom`);
- `appearance` toggles, opt-in activation flags, and bounded integer sizes
  (conversation width 480–1600, font size 12–24);
- `sidebar` mode;
- `history` enabled flag, visible-pair count, mode;
- `writingCopy` enabled flag, position, shortcut flag;
- `codeBlocks` auto-collapse flag and threshold;
- `theme` colors (conservative grammar: `#rgb`, `#rrggbb`, `#rrggbbaa`,
  `transparent`; no URLs, `var()`, `calc()`, braces, or semicolons).

## Never persisted

The schema has no fields for:

- chat text, titles, or copied content;
- URLs, page content, or DOM snapshots;
- account names, email addresses, or profile data;
- cookies, tokens, or authorization headers;
- local filesystem paths or OS usernames.

## Enforcement

- `validateSettings` checks every field by type and allowed value set, and
  rejects any unknown key at any nesting level (fail-closed).
- `mergeSettings` performs a validated deep merge; unknown injected keys are
  ignored and the result is re-validated.
- `migrateEnvelope` detects the stored schema version, migrates only known
  older versions, validates the result, and falls back to defaults on
  malformed or unknown data.
- `persist` refuses to write an invalid settings object.

## Unit proof

`tests/settings/settings.test.ts` asserts that injected fields such as
`messageText`, `chatTitle`, `copiedText`, and `innerHTML` are rejected and
never persisted.
