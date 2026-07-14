# Privacy Policy

This policy explains what the ChatGPTLiteUI extension does and does not do
with data. It applies to the software in this repository as published; local
development builds follow the same boundaries.

## Data the extension stores

The extension stores **only** presentation preferences in
`chrome.storage.local` on the user's device:

- whether the extension is enabled;
- selected preset;
- appearance toggles (animations, blur, shadows, compact spacing);
- conversation width and font size;
- sidebar mode;
- theme colors.

These values are non-identifying and contain no conversational content.

## Data the extension never stores or transmits

The extension is designed so that the following are **structurally
impossible** to persist, because the settings schema provides no field for
them:

- chat messages or their text;
- conversation titles;
- copied text;
- URLs, page content, or DOM snapshots;
- account names, email addresses, or profile information;
- cookies, tokens, or authorization headers;
- local filesystem paths or OS usernames.

## Network activity

The extension makes **no outbound network requests** at runtime. There is no
telemetry, no analytics, and no remote configuration. The network-usage audit
in CI verifies that no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
or `sendBeacon` call exists in product code.

## Third parties

There are no third-party services, SDKs, or remote endpoints involved.

## Local testing note

During development, an operator may use their own ChatGPT environment to verify
behavior. Any personal data used locally is never committed, pushed, uploaded,
or printed in CI. Public reports include only aggregate, non-identifying
metrics (for example, counts and timing), never the content of real
conversations.

## Your control

Disabling the extension removes its root class and CSS variables, restoring the
original ChatGPT appearance. Clearing the extension's storage removes all saved
preferences.
