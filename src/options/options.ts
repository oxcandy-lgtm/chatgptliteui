import type { PresetName, Settings } from "../shared/types.js";
import { getSettings, updateSettings, resetSettings } from "../settings/storage.js";
import {
  applyAppearancePreset,
  detectAppearancePreset,
} from "../features/appearance/presets.js";

/** Theme color fields exposed in the UI (writingBlockBackground is reserved). */
const COLOR_FIELDS = [
  "pageBackground",
  "conversationBackground",
  "userBackground",
  "assistantBackground",
  "inputBackground",
  "codeBackground",
  "textColor",
] as const;

type ColorField = (typeof COLOR_FIELDS)[number];

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

function readForm(): Partial<Settings> {
  const enabled = el<HTMLInputElement>("enabled").checked;
  const preset = el<HTMLSelectElement>("preset").value as PresetName;

  const appearance: Settings["appearance"] = {
    disableAnimations: el<HTMLInputElement>("disableAnimations").checked,
    disableBlur: el<HTMLInputElement>("disableBlur").checked,
    disableShadows: el<HTMLInputElement>("disableShadows").checked,
    compactSpacing: el<HTMLInputElement>("compactSpacing").checked,
    useConversationWidth: el<HTMLInputElement>("useConversationWidth").checked,
    conversationWidth: Number(el<HTMLInputElement>("conversationWidth").value),
    useFontSize: el<HTMLInputElement>("useFontSize").checked,
    fontSize: Number(el<HTMLInputElement>("fontSize").value),
    useTheme: el<HTMLInputElement>("useTheme").checked,
  };

  const theme = {} as Settings["theme"];
  for (const f of COLOR_FIELDS) {
    theme[f] = el<HTMLInputElement>(f).value;
  }
  // Preserve the reserved field from storage; not edited in the UI.
  theme.writingBlockBackground = "#161b25";

  return { enabled, preset, appearance, theme };
}

function writeForm(settings: Settings): void {
  el<HTMLInputElement>("enabled").checked = settings.enabled;
  el<HTMLSelectElement>("preset").value = settings.preset;
  const a = settings.appearance;
  el<HTMLInputElement>("disableAnimations").checked = a.disableAnimations;
  el<HTMLInputElement>("disableBlur").checked = a.disableBlur;
  el<HTMLInputElement>("disableShadows").checked = a.disableShadows;
  el<HTMLInputElement>("compactSpacing").checked = a.compactSpacing;
  el<HTMLInputElement>("useConversationWidth").checked = a.useConversationWidth;
  el<HTMLInputElement>("conversationWidth").value = String(a.conversationWidth);
  el<HTMLInputElement>("useFontSize").checked = a.useFontSize;
  el<HTMLInputElement>("fontSize").value = String(a.fontSize);
  el<HTMLInputElement>("useTheme").checked = a.useTheme;
  for (const f of COLOR_FIELDS) {
    el<HTMLInputElement>(f).value = settings.theme[f as ColorField];
  }
  syncDisabledState();
}

/** Disable numeric inputs whose enable toggle is off. */
function syncDisabledState(): void {
  el<HTMLInputElement>("conversationWidth").disabled =
    !el<HTMLInputElement>("useConversationWidth").checked;
  el<HTMLInputElement>("fontSize").disabled =
    !el<HTMLInputElement>("useFontSize").checked;
  const themeOff = !el<HTMLInputElement>("useTheme").checked;
  for (const f of COLOR_FIELDS) {
    el<HTMLInputElement>(f).disabled = themeOff;
  }
  // Assistant-transparent helper reflects current value.
  const assistant = el<HTMLInputElement>("assistantBackground");
  el<HTMLInputElement>("assistantTransparent").checked =
    assistant.value.toLowerCase() === "transparent";
}

function bind(): void {
  const status = el<HTMLSpanElement>("status");
  const save = el<HTMLButtonElement>("save");
  const reset = el<HTMLButtonElement>("reset");
  const normalBtn = el<HTMLButtonElement>("normal-action");

  void getSettings().then(writeForm);

  // Live-disable dependent inputs.
  for (const id of ["useConversationWidth", "useFontSize", "useTheme"]) {
    el<HTMLInputElement>(id).addEventListener("change", syncDisabledState);
  }

  // Applying a preset updates the full appearance profile and persists.
  el<HTMLSelectElement>("preset").addEventListener("change", () => {
    const value = el<HTMLSelectElement>("preset").value as PresetName;
    if (value === "custom") return; // not user-selectable
    void getSettings().then((current) => {
      const next = applyAppearancePreset(current, value as Exclude<PresetName, "custom">);
      void updateSettings(next).then(() => {
        writeForm(next);
        status.textContent = `Applied preset: ${value}.`;
      }).catch(() => {
        status.textContent = "Failed to apply preset.";
      });
    });
  });

  // Assistant "transparent" toggle.
  el<HTMLInputElement>("assistantTransparent").addEventListener("change", () => {
    const cb = el<HTMLInputElement>("assistantTransparent");
    el<HTMLInputElement>("assistantBackground").value = cb.checked
      ? "transparent"
      : "#1c2636";
  });

  save.addEventListener("click", () => {
    const patch = readForm();
    // Manual save derives the correct preset: if the resulting appearance
    // exactly matches a predefined profile, restore that name, else custom.
    void getSettings().then((current) => {
      const merged = { ...current, ...patch } as Settings;
      const derived = detectAppearancePreset(merged);
      const finalPatch: Partial<Settings> = { ...patch, preset: derived };
      void updateSettings(finalPatch)
        .then((saved) => {
          writeForm(saved);
          status.textContent = derived === "custom"
            ? "Saved as custom appearance."
            : `Saved (matches preset: ${derived}).`;
        })
        .catch(() => {
          status.textContent = "Save failed: invalid input.";
        });
    });
  });

  reset.addEventListener("click", () => {
    void resetSettings().then((defaults) => {
      // Reset returns enabled:true, preset:normal, appearance_effect:none.
      writeForm(defaults);
      status.textContent = "Reset to official ChatGPT UI.";
    });
  });

  normalBtn.addEventListener("click", () => {
    void getSettings().then((current) => {
      const next = applyAppearancePreset(current, "normal");
      void updateSettings(next).then(() => {
        writeForm(next);
        status.textContent = "Restored official ChatGPT UI.";
      });
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bind, { once: true });
} else {
  bind();
}
