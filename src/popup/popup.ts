import type { PresetName, Settings } from "../shared/types.js";
import { getSettings, updateSettings } from "../settings/storage.js";
import {
  applyAppearancePreset,
  detectAppearancePreset,
} from "../features/appearance/presets.js";

function bind(): void {
  const enabled = document.getElementById("enabled") as HTMLInputElement | null;
  const preset = document.getElementById("preset") as HTMLSelectElement | null;
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
        void updateSettings({ enabled: enabled.checked }).then(() => {
          if (status) status.textContent = "Saved.";
        });
      });
    }
    if (preset) {
      // Reflect current preset, including a derived "custom" state.
      const current = detectAppearancePreset(settings);
      preset.value = current;
      preset.addEventListener("change", () => {
        const value = preset.value as PresetName;
        if (value === "custom") {
          preset.value = current;
          return;
        }
        void updateSettings(
          applyAppearancePreset(settings, value as Exclude<PresetName, "custom">),
        ).then(() => {
          if (status) status.textContent = `Applied ${value}.`;
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
