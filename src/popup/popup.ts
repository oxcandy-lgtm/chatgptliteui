import type { PresetName, Settings, SidebarMode } from "../shared/types.js";
import { getSettings, updateSettings } from "../settings/storage.js";
import {
  applyAppearancePreset,
  detectAppearancePreset,
} from "../features/appearance/presets.js";

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
    if (status) status.textContent = "Settings loaded.";
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
}
