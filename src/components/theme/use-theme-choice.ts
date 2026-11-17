"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { THEME_CHANGE_EVENT, applyThemeChoice, readThemeChoice, type ThemeChoice } from "./theme";

export const THEME_OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * The device's theme choice (saved in localStorage, applied before paint by ThemeScript), kept
 * in step across every theme control on the page, and following the system setting while the
 * choice is System.
 */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    // Sync with the value the pre-paint script already applied, and with other controls.
    const sync = () => setChoice(readThemeChoice());
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeChoice("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    setChoice(next);
    applyThemeChoice(next);
  }, []);

  return [choice, choose];
}
