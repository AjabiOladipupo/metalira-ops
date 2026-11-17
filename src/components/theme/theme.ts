export const THEME_STORAGE_KEY = "metalira-theme";

/**
 * Fired on window when the choice changes, so every theme control on the page shows it. The
 * choice travels in `detail`: storage may be blocked, so listeners must not re-read it.
 */
export const THEME_CHANGE_EVENT = "metalira-theme-change";

export type ThemeChoice = "light" | "dark" | "system";

export function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function applyThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage blocked (private mode): the choice still applies for this page view.
  }
  const dark =
    choice === "dark" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  window.dispatchEvent(new CustomEvent<ThemeChoice>(THEME_CHANGE_EVENT, { detail: choice }));
}
