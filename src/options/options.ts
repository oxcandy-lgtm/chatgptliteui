import type { PresetName, Settings } from "../shared/types.js";
import { getSettings, updateSettings, resetSettings } from "../settings/storage.js";

const COLOR_FIELDS = [
  "pageBackground",
  "conversationBackground",
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
  const disableAnimations = el<HTMLInputElement>("disableAnimations").checked;
  const disableBlur = el<HTMLInputElement>("disableBlur").checked;
  const disableShadows = el<HTMLInputElement>("disableShadows").checked;
  const compactSpacing = el<HTMLInputElement>("compactSpacing").checked;
  const conversationWidth = Number(el<HTMLInputElement>("conversationWidth").value);
  const fontSize = Number(el<HTMLInputElement>("fontSize").value);
  const theme: Record<string, string> = {};
  for (const f of COLOR_FIELDS) {
    theme[f] = el<HTMLInputElement>(f).value;
  }
  return {
    enabled,
    preset,
    appearance: {
      disableAnimations,
      disableBlur,
      disableShadows,
      compactSpacing,
      conversationWidth,
      fontSize,
    },
    theme: theme as Settings["theme"],
  };
}

function writeForm(settings: Settings): void {
  el<HTMLInputElement>("enabled").checked = settings.enabled;
  el<HTMLSelectElement>("preset").value = settings.preset;
  el<HTMLInputElement>("disableAnimations").checked =
    settings.appearance.disableAnimations;
  el<HTMLInputElement>("disableBlur").checked = settings.appearance.disableBlur;
  el<HTMLInputElement>("disableShadows").checked = settings.appearance.disableShadows;
  el<HTMLInputElement>("compactSpacing").checked = settings.appearance.compactSpacing;
  el<HTMLInputElement>("conversationWidth").value = String(
    settings.appearance.conversationWidth,
  );
  el<HTMLInputElement>("fontSize").value = String(settings.appearance.fontSize);
  for (const f of COLOR_FIELDS) {
    el<HTMLInputElement>(f).value = settings.theme[f as ColorField];
  }
}

function bind(): void {
  const status = el<HTMLSpanElement>("status");
  const save = el<HTMLButtonElement>("save");
  const reset = el<HTMLButtonElement>("reset");

  void getSettings().then(writeForm);

  save.addEventListener("click", () => {
    void updateSettings(readForm())
      .then(() => {
        status.textContent = "Saved.";
      })
      .catch((err) => {
        status.textContent = "Save failed: invalid input.";
        console.error(err);
      });
  });

  reset.addEventListener("click", () => {
    void resetSettings().then((defaults) => {
      writeForm(defaults);
      status.textContent = "Reset to defaults.";
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bind, { once: true });
} else {
  bind();
}
