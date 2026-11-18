import { describe, expect, it } from "vitest";

import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  themeScript,
} from "../../src/components/theme/theme-script";
import { THEME_CHANGE_EVENT, THEME_STORAGE_KEY } from "../../src/components/theme/theme";

/** Just enough DOM for the pre-paint script: <html> classes, theme-color metas, observers. */
function fakePage({ stored, systemDark }: { stored: string | null; systemDark: boolean }) {
  const classes = new Set<string>();
  const observers: (() => void)[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const storage = new Map<string, string>(stored ? [[THEME_STORAGE_KEY, stored]] : []);

  function meta(media: string | null, content: string) {
    const attrs = new Map<string, string>([["content", content]]);
    if (media) attrs.set("media", media);
    return {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
    };
  }
  // As the worker app's viewport export renders them.
  let metas = [
    meta("(prefers-color-scheme: light)", THEME_COLOR_LIGHT),
    meta("(prefers-color-scheme: dark)", THEME_COLOR_DARK),
  ];
  const notify = () => observers.forEach((fn) => fn());
  const html = {
    classList: {
      toggle: (name: string, on: boolean) => {
        const had = classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        if (had !== on) notify();
      },
      contains: (name: string) => classes.has(name),
    },
  };
  const env = {
    document: {
      documentElement: html,
      head: {},
      querySelectorAll: () => metas,
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    matchMedia: () => ({ matches: systemDark }),
    MutationObserver: class {
      fn: () => void;
      constructor(fn: () => void) {
        this.fn = fn;
      }
      observe() {
        observers.push(this.fn);
      }
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
  };
  new Function(...Object.keys(env), themeScript)(...Object.values(env));

  return {
    dark: () => classes.has("dark"),
    colours: () => metas.map((m) => m.getAttribute("content")),
    /** What applyThemeChoice does: save, toggle the class, fire the change event. */
    choose(choice: "light" | "dark" | "system", nowSystemDark = systemDark) {
      if (choice === "system") storage.delete(THEME_STORAGE_KEY);
      else storage.set(THEME_STORAGE_KEY, choice);
      html.classList.toggle("dark", choice === "dark" || (choice === "system" && nowSystemDark));
      (listeners.get(THEME_CHANGE_EVENT) ?? []).forEach((fn) => fn({ detail: choice }));
    },
    /** A client navigation that renders the worker app's metas afresh. */
    remountMetas() {
      metas = [
        meta("(prefers-color-scheme: light)", THEME_COLOR_LIGHT),
        meta("(prefers-color-scheme: dark)", THEME_COLOR_DARK),
      ];
      notify();
    },
  };
}

describe("theme script: status bar colour follows the chosen theme", () => {
  it("dark chosen on a light phone: dark class and dark status bar", () => {
    const page = fakePage({ stored: "dark", systemDark: false });
    expect(page.dark()).toBe(true);
    expect(page.colours()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK]);
  });

  it("light chosen on a dark phone: light status bar", () => {
    const page = fakePage({ stored: "light", systemDark: true });
    expect(page.dark()).toBe(false);
    expect(page.colours()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT]);
  });

  it("system keeps each tag on its own media, so the browser follows the phone", () => {
    const page = fakePage({ stored: null, systemDark: true });
    expect(page.dark()).toBe(true);
    expect(page.colours()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK]);
  });

  it("re-syncs when the choice changes, even when the class does not", () => {
    const page = fakePage({ stored: null, systemDark: false });
    page.choose("light");
    expect(page.colours()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_LIGHT]);
    page.choose("dark");
    expect(page.colours()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK]);
    page.choose("system");
    expect(page.colours()).toEqual([THEME_COLOR_LIGHT, THEME_COLOR_DARK]);
  });

  it("re-syncs tags added by a later navigation", () => {
    const page = fakePage({ stored: "dark", systemDark: false });
    page.remountMetas();
    expect(page.colours()).toEqual([THEME_COLOR_DARK, THEME_COLOR_DARK]);
  });

  it("uses the bg tokens", () => {
    expect([THEME_COLOR_LIGHT, THEME_COLOR_DARK]).toEqual(["#FFFFFF", "#0A0A0A"]);
  });
});
