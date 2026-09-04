import type { PresetName, Settings, SidebarMode } from "../shared/types.js";
import { getSettings, updateSettings } from "../settings/storage.js";
import {
  applyAppearancePreset,
  detectAppearancePreset,
} from "../features/appearance/presets.js";
import {
  clearConversationBackground,
  getConversationBackground,
  readCurrentConversationFingerprint,
  setConversationBackground,
} from "../features/appearance/conversation-background.js";

/** Default picker value when a chat has no stored override yet. */
const DEFAULT_CHAT_BACKGROUND = "#101827";

function bind(): void {
  const enabled = document.getElementById("enabled") as HTMLInputElement | null;
  const preset = document.getElementById("preset") as HTMLSelectElement | null;
  const sidebar = document.getElementById("sidebar") as HTMLSelectElement | null;
  const status = document.getElementById("status") as HTMLParagraphElement | null;
  const openOptions = document.getElementById("open-options") as HTMLAnchorElement | null;

  if (openOptions && chrome.runtime?.openOptionsPage) {
    openOptions.addEventListener("click", (e) => {
      e.preventDefault();
      void chrome.runtime.openOptionsPage();
    });
  }

  void getSettings().then((settings: Settings) => {
    if (enabled) {
      enabled.checked = settings.enabled;
      enabled.addEventListener("change", () => {
        void updateSettings({ enabled: enabled.checked })
          .then(() => {
            if (status) status.textContent = "Saved.";
          })
          .catch(() => {
            if (status) status.textContent = "Save failed.";
          });
      });
    }
    if (preset) {
      // Reflect current preset, including a derived "custom" state.
      preset.value = detectAppearancePreset(settings);
      preset.addEventListener("change", () => {
        const value = preset.value as PresetName;
        if (value === "custom") {
          preset.value = detectAppearancePreset(settings);
          return;
        }
        // Always read the latest persisted state before applying a preset so
        // a sequence of preset changes uses fresh data and the current
        // `enabled` value and all unrelated settings are preserved.
        void getSettings()
          .then((current) =>
            updateSettings(
              applyAppearancePreset(current, value as Exclude<PresetName, "custom">),
            ),
          )
          .then((saved) => {
            preset.value = saved.preset;
            if (status) status.textContent = `Applied ${saved.preset}.`;
          })
          .catch(() => {
            if (status) status.textContent = "Failed to apply preset.";
          });
      });
    }
    if (sidebar) {
      sidebar.value = settings.sidebar.mode;
      // On change, read fresh settings and patch ONLY sidebar.mode so the
      // enabled state, preset, appearance, theme, and all deferred settings
      // are preserved exactly.
      sidebar.addEventListener("change", () => {
        const mode = sidebar.value as SidebarMode;
        // Read fresh settings before patching so a concurrent change is not
        // clobbered; mergeSettings preserves all unrelated sections.
        void getSettings()
          .then(() => updateSettings({ sidebar: { mode } }))
          .then(() => {
            if (status) status.textContent = `Sidebar: ${mode}.`;
          })
          .catch(() => {
            if (status) status.textContent = "Save failed.";
          });
      });
    }
    const writingCopy = document.getElementById("writingCopyEnabled") as HTMLInputElement | null;
    if (writingCopy) {
      writingCopy.checked = settings.writingCopy.enabled;
      writingCopy.addEventListener("change", () => {
        // Patch ONLY writingCopy.enabled; preserve everything else.
        void getSettings()
          .then(() => updateSettings({ writingCopy: { enabled: writingCopy.checked } }))
          .then(() => {
            if (status) status.textContent = `Writing copy: ${writingCopy.checked ? "on" : "off"}.`;
          })
          .catch(() => {
            if (status) status.textContent = "Save failed.";
          });
      });
    }
    if (status) status.textContent = "Settings loaded.";
    void bindChatBackground(status);
  });
}

/**
 * Per-chat background section. Identity comes ONLY from the fingerprint the
 * content script publishes — the popup never reads tab URLs, titles, or chat
 * text. Saves apply live via storage (the content script re-applies on
 * change); no messaging, no new permissions.
 */
async function bindChatBackground(
  status: HTMLParagraphElement | null,
): Promise<void> {
  const identity = document.getElementById("chat-identity") as HTMLParagraphElement | null;
  const enabled = document.getElementById("chatBackgroundEnabled") as HTMLInputElement | null;
  const picker = document.getElementById("chatBackgroundColor") as HTMLInputElement | null;
  const reset = document.getElementById("chatBackgroundReset") as HTMLButtonElement | null;
  if (!identity || !enabled || !picker || !reset) return;

  const setDisabled = (message: string): void => {
    identity.textContent = message;
    enabled.disabled = true;
    picker.disabled = true;
    reset.disabled = true;
  };

  let fingerprint: string | null;
  try {
    fingerprint = await readCurrentConversationFingerprint();
  } catch {
    setDisabled("Could not read chat identity.");
    return;
  }
  if (!fingerprint) {
    setDisabled("This page has no saved chat identity.");
    return;
  }

  let stored: string | null;
  try {
    stored = await getConversationBackground(fingerprint);
  } catch {
    setDisabled("Could not read chat background.");
    return;
  }
  identity.textContent = stored
    ? "Custom background saved for this chat."
    : "No custom background for this chat.";
  enabled.checked = stored !== null;
  picker.value = stored ?? DEFAULT_CHAT_BACKGROUND;
  picker.disabled = !enabled.checked;

  const save = (): void => {
    if (!enabled.checked) return;
    const color = picker.value;
    void setConversationBackground(fingerprint, color)
      .then((ok) => {
        identity.textContent = ok
          ? "Custom background saved for this chat."
          : "Save failed.";
        if (status && ok) status.textContent = "Chat background saved.";
      })
      .catch(() => {
        identity.textContent = "Save failed.";
      });
  };

  enabled.addEventListener("change", () => {
    picker.disabled = !enabled.checked;
    if (!enabled.checked) {
      // Unchecking removes the override (falls back to global/official).
      // Success UI only after a real successful delete.
      void clearConversationBackground(fingerprint)
        .then((ok) => {
          identity.textContent = ok
            ? "No custom background for this chat."
            : "Reset failed.";
        })
        .catch(() => {
          identity.textContent = "Reset failed.";
        });
    } else {
      save();
    }
  });
  // Live update while picking; the open ChatGPT page follows via storage.
  picker.addEventListener("input", save);
  reset.addEventListener("click", () => {
    void clearConversationBackground(fingerprint)
      .then((ok) => {
        if (!ok) {
          identity.textContent = "Reset failed.";
          return;
        }
        enabled.checked = false;
        picker.disabled = true;
        picker.value = DEFAULT_CHAT_BACKGROUND;
        identity.textContent = "No custom background for this chat.";
        if (status) status.textContent = "Chat background reset.";
      })
      .catch(() => {
        identity.textContent = "Reset failed.";
      });
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
}
