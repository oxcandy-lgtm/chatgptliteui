# ChatGPTLiteUI Implementation Roadmap

This document is the authoritative repository roadmap for ChatGPTLiteUI.
Work only on the current unfinished phase. A phase that has genuinely passed
its real acceptance path is CLOSED and must not be reopened without a concrete
later change that invalidates that path.

> **Current milestone:** Phase 4 — Persistent Writing CopyMarker
>
> **Closed:** Phases 1–3
>
> **Next after Phase 4:** Phase 5 — Code and long-response folding

ChatGPTLiteUI is a privacy-safe Manifest V3 extension layered on top of the
official ChatGPT web interface. The project favors the smallest real browser
path, minimal permissions, minimal retained data, and minimal runtime overhead.

> **Memory-reduction disclaimer:** strong memory reduction is an experiment,
> not a guarantee. `display:none` is primarily a rendering/UI optimization.
> Detached parking may retain memory and must not be presented as effective
> without measurement. Complete DOM removal requires conservative safety gates
> and reload-based restoration.

## Status summary

| Phase | State | Result |
| --- | --- | --- |
| 1 — Foundation and safety | CLOSED | Manifest V3 safety baseline and runtime foundation |
| 2 — Minimal appearance controls | CLOSED | Appearance, layout and theme controls |
| 3 — Sidebar control | CLOSED | Non-destructive visible / hover / button / hidden modes |
| 4 — Persistent Writing CopyMarker | ACTIVE | Copy, persistent copied-state marker, uncopied pulse, smart placement |
| 5 — Code and long-response folding | PLANNED | Folding without rewriting message content |
| 6 — Safe history limiting | PLANNED | Visible-pair limiting with safe detection |
| 7 — Experimental aggressive memory reduction | PLANNED | Measured memory experiments only |
| 8 — Measurement and release preparation | PLANNED | Release hardening and aggregate measurement |

---

## Phase 1 — Foundation and safety — CLOSED

Completed foundation:

- Manifest V3 with minimal permissions (`storage` only).
- Static content-script match on `https://chatgpt.com/*`.
- TypeScript + esbuild, source maps disabled.
- Public-safety scanner, manifest/network/distribution audits, CI.
- Settings schema with fail-closed validation and versioned migration.
- Non-destructive Adapter with typed detection results.
- Minimal runtime: settings load, extension-owned root state, CSS variables,
  popup/options, storage listener and SPA route lifecycle.
- No external network requests and no destructive DOM operations.

This phase is CLOSED. Do not spend later workstreams re-proving it unless a
specific later change invalidates its passed path.

## Phase 2 — Minimal appearance controls — CLOSED

Completed appearance controls:

- Opt-in animation / transition / smooth-scroll reduction.
- `backdrop-filter` blur reduction without disabling ordinary filters.
- Shadow reduction.
- Compact conversation spacing scoped to message surfaces.
- Custom conversation width and font size.
- Scoped page/conversation/user/assistant/input/code/text theming.
- Presets: `normal`, `minimal`, `work`, `ultra-lite`, plus derived `custom`.
- Complete restoration of extension-owned classes, variables and markers.
- No new Chrome permission and no persisted chat content.

The merged settings model already reserves `theme.writingBlockBackground` for
Phase 4.

This phase is CLOSED.

## Phase 3 — Sidebar control — CLOSED

Completed non-destructive sidebar modes:

- `visible`, `hover`, `button`, `hidden`.
- Shadow DOM edge/button controls where required.
- `Alt+Shift+L` transient keyboard toggle from the content script.
- Safe sidebar detection and wrapper normalization.
- Only extension-owned marker/root state is mutated; ChatGPT navigation is not
  deleted, detached, rewritten, reordered or cloned.
- Detection failure preserves the official UI.
- No new Chrome permission, Service Worker or network behavior.

This phase is CLOSED.

---

# Phase 4 — Persistent Writing CopyMarker — ACTIVE

## Goal

Turn WritingBlock copy into a persistent visual state:

- an uncopied WritingBlock is visually obvious through a slow background pulse;
- a successful copy converts it to a stable colored text marker;
- that copied marker survives reloads and later revisits for a long time;
- changing the WritingBlock content invalidates the old copied state;
- one floating copy control remains easy to see at any practical window size,
  zoom level or scroll position;
- background, marker and uncopied-indicator appearance are user-adjustable;
- the feature remains extremely light in DOM, CPU, memory and storage usage.

## Already available and must be reused

The merged repository already contains Phase 4 foundations:

- `writingCopy.enabled`, `writingCopy.position` and
  `writingCopy.shortcutEnabled` settings fields;
- `theme.writingBlockBackground`;
- `detectWritingBlocks(container)`;
- `detectOriginalCopyButton(container)`;
- the existing settings/storage/SPA lifecycle infrastructure;
- the existing Shadow DOM control pattern from Phase 3.

Do not redesign these foundations without a concrete blocker.

### Local WIP handoff to recover before reimplementation

A prior unpublished Phase 4 worktree was reported on branch
`codex/writing-block-copy-controls`, based on the Phase 3 main head. The handoff
reported work started around:

- WritingBlock detection;
- viewport-centered tracking;
- floating Shadow DOM copy host;
- copy action handling;
- WritingCopy controller;
- focused detection/tracker/host/copy/controller tests;
- public-safety scanner rules preventing clipboard reads and unsafe clipboard
  write/exec patterns.

This WIP is not on the current remote repository. Recover/reuse it if present
locally; do not recreate it merely because it is absent from GitHub. If the
local WIP is unavailable, continue from the merged Phase 3 foundations.

## Phase 4 state model

Only two durable semantic states are needed:

- `UNCOPIED`: no valid persistent copied-state record exists for the current
  WritingBlock content.
- `COPIED`: a successful copy produced a valid persistent record matching the
  current WritingBlock content.

State transition:

```text
UNCOPIED --successful copy--> COPIED
COPIED   --content changed--> UNCOPIED
```

A click alone is not success. Copy failure must remain `UNCOPIED`.

## 4A — Safe real WritingBlock detection

The first implementation blocker is real ChatGPT WritingBlock identity.
The current broad/low-confidence heuristic must not cause ordinary assistant
paragraphs to be treated as WritingBlocks.

Required path:

1. Inspect one real current WritingBlock in ChatGPT.
2. Prefer a WritingBlock-specific semantic root/invariant.
3. Fail closed on ambiguity.
4. Keep ordinary assistant prose untouched.

Do not build a large selector matrix before the first real detector works.

## 4B — One smart floating copy control

Use one extension-owned Shadow DOM copy control, not one control per block.
Track the currently relevant WritingBlock and move the single control.

Default placement mode: `smart`.

Smart placement behavior:

- prefer a clear position beside the active WritingBlock;
- fall back inside the block edge when outside space is unavailable;
- clamp the control inside the visible viewport;
- recompute after scroll, resize, zoom/visual-viewport changes and active-block
  geometry changes;
- coalesce geometry work with `requestAnimationFrame`;
- preserve explicit legacy positions (`top-right`, `middle-right`,
  `bottom-right`) if retained as user choices.

The active block should be chosen from visible/intersecting candidates using
viewport-center distance. Do not require `IntersectionObserver` threshold 0.5;
large blocks may never reach 50% visibility. Use `threshold: 0` for candidate
visibility and calculate center distance separately.

## 4C — Copy execution and success

Preferred order:

1. Use the page's original copy action only when it can be identified and its
   success path is reliable.
2. Otherwise call `navigator.clipboard.writeText()` only during the direct user
   gesture.
3. Mark `COPIED` only after a successful copy path.
4. On failure, show a non-destructive error and keep `UNCOPIED`.

Never read the clipboard. Do not add `clipboardRead`. Do not add
`clipboardWrite` unless a real-browser blocker proves it necessary and the
permission change is explicitly accepted.

## 4D — Persistent copied-state history

Copy history should persist for a long time by default, including reloads and
later revisits, while remaining tiny.

Use the existing `chrome.storage.local` permission and infrastructure. Do not
introduce IndexedDB, a Service Worker, `unlimitedStorage`, a new dependency or a
new backend unless the real path hits a concrete storage blocker.

### Persist only compact metadata

Do not persist:

- WritingBlock text;
- copied clipboard text;
- HTML;
- DOM snapshots;
- conversation titles;
- account data.

Persist only enough compact metadata to recognize a previously copied current
block, for example:

- compact conversation key/fingerprint;
- assistant-turn/block structural position;
- normalized-content fingerprint;
- copied timestamp/version metadata if needed.

Prefer compact record shapes and avoid repeated verbose object keys when large
record counts make that materially useful.

`UNCOPIED` requires no stored record.

Repeated copies of the same current block update/reuse one state record rather
than appending duplicate history.

If current content no longer matches the recorded content fingerprint, the old
record must not produce a marker. Remove or supersede invalid same-position
records when safe so stale history naturally contracts.

Default retention target: persistent until the user explicitly clears copy
history or storage pressure becomes a demonstrated blocker. Provide a clear
history action in Options.

## 4E — Durable matching after revisit

Restore copied state conservatively.

Preferred identity:

1. conversation identity/fingerprint;
2. assistant-turn/block structural position;
3. current normalized-content fingerprint.

If structural position changes but the content fingerprint is unique within the
same conversation, a conservative fallback match may restore the marker.
If multiple candidates are ambiguous, remain `UNCOPIED`; never guess a copied
state onto the wrong block.

A fingerprint is an identity aid, not an encryption/privacy guarantee. The
privacy property is that raw copied/WritingBlock text is not persisted.

## 4F — Copied marker

A copied WritingBlock should retain a stable colored marker over its text.
Prefer the CSS Custom Highlight API so highlighting does not require wrapping
or rewriting ChatGPT text nodes.

Keep runtime overhead small:

- reuse as few Highlight objects as practical;
- create ranges only for live/rendered WritingBlocks that need highlighting;
- release ranges/element references on route teardown or DOM replacement;
- do not create permanent extra wrapper nodes per block.

User controls:

- marker enabled;
- marker color;
- marker opacity/intensity if useful.

Marker appearance is global presentation state and must not be duplicated into
every persistent history record. Changing marker color should restyle existing
markers without rewriting copy-history records.

## 4G — Uncopied pulse indicator

An uncopied WritingBlock should have a slow, non-aggressive background pulse.
Copied blocks do not pulse.

User controls:

- pulse enabled;
- pulse color;
- pulse speed;
- pulse intensity.

Performance rules:

- animate only uncopied WritingBlocks that are currently visible/relevant;
- do not create timers per WritingBlock;
- prefer CSS animation driven by extension-owned markers/variables;
- honor reduced-motion behavior or disable animation when the extension's
  animation-reduction setting requires it.

## 4H — WritingBlock background

Activate the existing reserved `theme.writingBlockBackground` path.
Allow the user to enable/change WritingBlock background color independently of
copied-state history.

Changing background/marker/pulse appearance must not rewrite persistent copy
history.

## 4I — Options surface

Expose only controls that materially serve the feature:

### Writing Copy

- enable Writing Copy;
- copy button position (`smart` default; explicit positions optional);
- shortcut setting if retained.

### Copied marker

- marker enabled;
- marker color;
- marker opacity/intensity if retained.

### Uncopied indicator

- pulse enabled;
- pulse color;
- pulse speed;
- pulse intensity.

### WritingBlock appearance

- background enabled;
- background color.

### History

- persistent copied state enabled if a toggle is useful;
- clear copy history.

Do not turn Phase 4 into a generic animation/theme editor.

## Phase 4 real acceptance RUN

Phase 4 closes after one genuine real-browser ChatGPT E2E path demonstrates the
current frozen goal. Use the smallest real conversation containing suitable
WritingBlocks.

Required acceptance path:

1. Detect a real WritingBlock without classifying ordinary assistant prose as a
   WritingBlock in the exercised page.
2. Show the uncopied slow background pulse.
3. Show the smart floating copy control for the active WritingBlock.
4. Resize/narrow the browser and confirm the control remains visibly usable
   inside the viewport.
5. Scroll between WritingBlocks and confirm the one control follows the active
   block.
6. Perform one successful copy.
7. Confirm the copied block stops pulsing and receives the configured text
   marker.
8. Reload the page and confirm the copied marker restores from persistent
   metadata.
9. Leave the conversation, return later in the same browser profile, and
   confirm the marker restores again.
10. Change the copied WritingBlock content and confirm the old state is
    invalidated: marker disappears and uncopied indication returns.
11. Change marker color and WritingBlock background and confirm presentation
    updates without rewriting raw content/history payloads.
12. Confirm no clipboard read, no copied text persistence, no new network path
    and no new Chrome permission were introduced.
13. Route/feature teardown releases extension-owned live DOM/range references.

One genuine PASS closes Phase 4. After that, do not expand Phase 4 with extra
proof, benchmarks, audits or persistence features unless the user changes the
goal or a concrete later change invalidates the passed path.

---

## Phase 5 — Code and long-response folding — PLANNED

- Collapse code blocks beyond a line threshold (individual + expand-all).
- Collapse long responses beyond a height/length threshold.
- Never rewrite message text; keep the original DOM; never break copy.
- Do not auto-fold while ChatGPT is generating.

## Phase 6 — Safe history limiting — PLANNED

- Visible-pair slider (for example 5/10/20/50/all).
- Pair a user turn with its following assistant turn as one pair.
- Hide older turns with CSS and an extension attribute; show an omission bar.
- Use a scoped, debounced MutationObserver to follow new turns.
- Destructive hiding requires high-confidence detection plus safety invariants.

## Phase 7 — Experimental aggressive memory reduction — PLANNED

- Compare `display:none`, `content-visibility`, detached parking, reference
  dropping and reload-based removal.
- Default off; explicit opt-in; disabled during generation or with unsent
  input.
- Judge approaches by measured real browser memory/DOM behavior, not theory.
- Publish only measured aggregate results and do not overstate effectiveness.

## Phase 8 — Measurement and release preparation — PLANNED

- Memory and DOM-node measurement under reproducible conditions.
- Publish only synthetic descriptions, counts and aggregate metrics — never
  real conversation titles or content.
- Chrome Web Store preparation and stability hardening.

---

## Global implementation boundaries

- Prefer the smallest real E2E path and fix only its first blocker.
- Preserve CLOSED phases and reuse known-good infrastructure.
- No external network or telemetry unless the project goal explicitly changes.
- Do not persist raw chat/WritingBlock/copied content.
- Fail closed on ambiguous recognition of a user's copied state.
- Prefer extension-owned markers, CSS variables and Shadow DOM over rewriting
  ChatGPT DOM/classes.
- Avoid Service Workers/new dependencies/new permissions unless required by a
  demonstrated real blocker.
- Keep runtime observers, event handlers, ranges and DOM references scoped and
  releasable across SPA route changes.

## Data-handling boundary

Real local tests may use personal data, but only aggregate/anonymized metrics
may be published. Never commit, push, upload or print real chat content, titles,
copied text, account data, local paths or personal screenshots.
