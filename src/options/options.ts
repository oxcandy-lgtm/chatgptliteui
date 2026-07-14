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

/** Safe opaque fallback used when transparency is toggled off with no draft. */
const FALLBACK_OPAQUE = "#1c2636";

/** Latest loaded settings, used to preserve reserved/deferred fields on save. */
let currentSettings: Settings | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

/**
 * Read the form into a Partial<Settings> patch. The reserved writing-block
 * background is preserved from the latest loaded settings so editing unrelated
 * appearance fields never mutates it. Unknown/deferred fields are likewise
 * carried through from `currentSettings`.
 */
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

  // Assistant background: checkbox is the persisted-state authority. Never
  // assign "transparent" to the color input's value.
  const assistantTransparent = el<HTMLInputElement>("assistantTransparent").checked;
  const assistantColor = el<HTMLInputElement>("assistantBackground").value;
  const assistantBackground = assistantTransparent ? "transparent" : assistantColor;

  const theme = {} as Settings["theme"];
  for (const f of COLOR_FIELDS) {
    theme[f] = el<HTMLInputElement>(f).value;
  }
  theme.assistantBackground = assistantBackground;
  // Preserve the reserved writing-block background from loaded settings.
  theme.writingBlockBackground =
    currentSettings?.theme.writingBlockBackground ?? "#161b25";

  // Preserve deferred feature fields from loaded settings.
  const sidebar = currentSettings?.sidebar;
  const history = currentSettings?.history;
  const writingCopy = currentSettings?.writingCopy;
  const codeBlocks = currentSettings?.codeBlocks;

  return {
    enabled,
    preset,
    appearance,
    theme,
    ...(sidebar ? { sidebar } : {}),
    ...(history ? { history } : {}),
    ...(writingCopy ? { writingCopy } : {}),
    ...(codeBlocks ? { codeBlocks } : {}),
  };
}

function writeForm(settings: Settings): void {
  currentSettings = settings;
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
  // Assistant: derive transparent checkbox from the stored value; keep the
  // color input on a safe opaque value, never "transparent".
  const assistant = settings.theme.assistantBackground;
  const assistantTransparent = assistant.toLowerCase() === "transparent";
  el<HTMLInputElement>("assistantTransparent").checked = assistantTransparent;
  el<HTMLInputElement>("assistantBackground").value = assistantTransparent
    ? currentAssistantDraft(settings.theme.assistantBackground)
    : assistant;
  syncDisabledState();
}

/** Last known safe opaque draft for the assistant background color. */
let lastOpaqueDraft = FALLBACK_OPAQUE;

function currentAssistantDraft(assistantBackground: string): string {
  return assistantBackground.toLowerCase() === "transparent"
    ? lastOpaqueDraft
    : assistantBackground;
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
  const assistantColor = el<HTMLInputElement>("assistantBackground");
  const assistantTransparent = el<HTMLInputElement>("assistantTransparent").checked;
  if (assistantTransparent) {
    // Remember the last opaque draft before disabling.
    if (assistantColor.value.toLowerCase() !== "transparent") {
      lastOpaqueDraft = assistantColor.value;
    }
    assistantColor.disabled = true;
  } else {
    assistantColor.disabled = themeOff;
  }
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
      void updateSettings(next)
        .then(() => {
          writeForm(next);
          status.textContent = `Applied preset: ${value}.`;
        })
        .catch(() => {
          status.textContent = "Failed to apply preset.";
        });
    });
  });

  // Assistant "transparent" toggle: checkbox is authority; keep color input
  // opaque (never "transparent"). Disabling transparency restores the draft.
  el<HTMLInputElement>("assistantTransparent").addEventListener("change", () => {
    const transparent = el<HTMLInputElement>("assistantTransparent").checked;
    const assistant = el<HTMLInputElement>("assistantBackground");
    if (transparent) {
      if (assistant.value.toLowerCase() !== "transparent") {
        lastOpaqueDraft = assistant.value;
      }
      assistant.value = lastOpaqueDraft;
    } else {
      assistant.value = lastOpaqueDraft;
    }
    syncDisabledState();
  });

  save.addEventListener("click", () => {
    const patch = readForm();
    void getSettings().then((current) => {
      const merged = { ...current, ...patch } as Settings;
      const derived = detectAppearancePreset(merged);
      const finalPatch: Partial<Settings> = { ...patch, preset: derived };
      void updateSettings(finalPatch)
        .then((saved) => {
          writeForm(saved);
          status.textContent =
            derived === "custom"
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
      writeForm(defaults);
      status.textContent = "Reset to official ChatGPT UI.";
    });
  });

  normalBtn.addEventListener("click", () => {
    void getSettings().then((current) => {
      const next = applyAppearancePreset(current, "normal");
      void updateSettings(next)
        .then(() => {
          writeForm(next);
          status.textContent = "Restored official ChatGPT UI.";
        })
        .catch(() => {
          status.textContent = "Failed to restore official UI.";
        });
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bind, { once: true });
} else {
  bind();
}
