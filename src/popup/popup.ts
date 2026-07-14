import type { PresetName, Settings } from "../shared/types.js";
import { getSettings, updateSettings } from "../settings/storage.js";

const PRESETS: PresetName[] = ["normal", "minimal", "work", "ultra-lite"];

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
    if (preset && PRESETS.includes(settings.preset)) {
      preset.value = settings.preset;
      preset.addEventListener("change", () => {
        void updateSettings({ preset: preset.value as PresetName }).then(() => {
          if (status) status.textContent = "Saved.";
        });
      });
    }
    if (status) status.textContent = "Settings loaded.";
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bind, { once: true });
} else {
  bind();
}
