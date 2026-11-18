import { describe, expect, it } from "vitest";

import { viewport as workerViewport } from "../../src/app/m/layout";
import {
  THEME_CHANGE_EVENT,
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_STORAGE_KEY,
} from "../../src/components/theme/theme";
import { OWNED_THEME_COLOR_ATTR, ownedColour, themeScript } from "../../src/components/theme/theme-script";

interface FakeNode {
  attrs: Map<string, string>;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  parentNode: unknown;
}

function element(attrs: [string, string][]): FakeNode {
  const node: FakeNode = {
    attrs: new Map(attrs),
    getAttribute: (name) => node.attrs.get(name) ?? null,
    setAttribute: (name, value) => void node.attrs.set(name, value),
    parentNode: null,
  };
  return node;
}

const isOwned = (node: FakeNode) => node.attrs.has(OWNED_THEME_COLOR_ATTR);

/** Just enough DOM for the pre-paint script: <html> classes, a <head> list, storage, events. */
function fakePage({ stored, systemDark }: { stored: string | null; systemDark: boolean }) {
  const classes = new Set<string>();
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const observers: (() => void)[] = [];
  const storage = new Map<string, string>(stored ? [[THEME_STORAGE_KEY, stored]] : []);

  // React's tags, as the worker app's viewport export renders them.
  const children: FakeNode[] = [
    element([["charset", "utf-8"]]),
    element([
      ["name", "theme-color"],
      ["media", "(prefers-color-scheme: light)"],
      ["content", THEME_COLOR_LIGHT],
    ]),
    element([
      ["name", "theme-color"],
      ["media", "(prefers-color-scheme: dark)"],
      ["content", THEME_COLOR_DARK],
    ]),
  ];
  const head = {
    get firstChild() {
      return children[0] ?? null;
    },
    querySelector: () => children.find(isOwned) ?? null,
    insertBefore(node: FakeNode, before: FakeNode | null) {
      const at = children.indexOf(node);
      if (at >= 0) children.splice(at, 1);
      const index = before ? children.indexOf(before) : -1;
      children.splice(index < 0 ? children.length : index, 0, node);
      node.parentNode = head;
    },
    removeChild(node: FakeNode) {
      children.splice(children.indexOf(node), 1);
    },
  };
  for (const c of children) c.parentNode = head;

  const env = {
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, on: boolean) =>
            void (on ? classes.add(name) : classes.delete(name)),
        },
      },
      head,
      createElement: () => element([]),
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
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

  const metas = () => children.filter((c) => c.attrs.get("name") === "theme-color");
  return {
    dark: () => classes.has("dark"),
    metas,
    first: () => children[0],
    /** The colour the browser uses: the first theme-color tag whose media matches. */
    statusBar: () =>
      metas()
        .find((c) => {
          const media = c.attrs.get("media");
          if (!media) return true;
          return media.includes("dark") ? systemDark : !systemDark;
        })
        ?.attrs.get("content")
        ?.toLowerCase(),
    /** A navigation where React puts its theme-color tags at the front of <head>. */
    reactInsertsFirst() {
      const fresh = [
        element([
          ["name", "theme-color"],
          ["media", "(prefers-color-scheme: light)"],
          ["content", THEME_COLOR_LIGHT],
        ]),
        element([
          ["name", "theme-color"],
          ["media", "(prefers-color-scheme: dark)"],
          ["content", THEME_COLOR_DARK],
        ]),
      ];
      for (const c of [...children]) if (c.attrs.has("media")) head.removeChild(c);
      children.unshift(...fresh);
      observers.forEach((fn) => fn());
    },
    /** What applyThemeChoice fires after saving and toggling the class. */
    choose(choice: "light" | "dark" | "system") {
      (listeners.get(THEME_CHANGE_EVENT) ?? []).forEach((fn) => fn({ detail: choice }));
    },
  };
}

describe("theme script: status bar colour follows the chosen theme", () => {
  it("dark chosen on a light phone: dark class, one owned tag first, dark status bar", () => {
    const page = fakePage({ stored: "dark", systemDark: false });
    expect(page.dark()).toBe(true);
    expect(page.first() && isOwned(page.first()!)).toBe(true);
    expect(page.metas().filter(isOwned)).toHaveLength(1);
    expect(page.statusBar()).toBe(THEME_COLOR_DARK.toLowerCase());
  });

  it("light chosen on a dark phone: light status bar", () => {
    const page = fakePage({ stored: "light", systemDark: true });
    expect(page.dark()).toBe(false);
    expect(page.statusBar()).toBe(THEME_COLOR_LIGHT.toLowerCase());
  });

  it("system adds no tag, so the worker app's own tags follow the phone", () => {
    const page = fakePage({ stored: null, systemDark: true });
    expect(page.dark()).toBe(true);
    expect(page.metas().some(isOwned)).toBe(false);
    expect(page.statusBar()).toBe(THEME_COLOR_DARK.toLowerCase());
  });

  it("never edits React's tags and keeps one owned tag across changes", () => {
    const page = fakePage({ stored: null, systemDark: false });
    page.choose("dark");
    expect(page.statusBar()).toBe(THEME_COLOR_DARK.toLowerCase());
    page.choose("light");
    page.choose("dark");
    expect(page.metas().filter(isOwned)).toHaveLength(1);
    expect(page.statusBar()).toBe(THEME_COLOR_DARK.toLowerCase());
    page.choose("system");
    expect(page.metas().some(isOwned)).toBe(false);
    expect(page.statusBar()).toBe(THEME_COLOR_LIGHT.toLowerCase());
    // React's two tags keep their own colours throughout.
    expect(page.metas().map((m) => m.attrs.get("content"))).toEqual([
      THEME_COLOR_LIGHT,
      THEME_COLOR_DARK,
    ]);
  });

  it("moves the owned tag back to the front when React inserts its tags ahead of it", () => {
    const page = fakePage({ stored: "dark", systemDark: false });
    page.reactInsertsFirst();
    expect(page.first() && isOwned(page.first()!)).toBe(true);
    expect(page.metas()).toHaveLength(3);
    expect(page.statusBar()).toBe(THEME_COLOR_DARK.toLowerCase());
  });

  it("writes the owned colour so React never mistakes the tag for its own", () => {
    for (const colour of [THEME_COLOR_LIGHT, THEME_COLOR_DARK]) {
      expect(ownedColour(colour)).not.toBe(colour);
      expect(ownedColour(colour).toLowerCase()).toBe(colour.toLowerCase());
    }
    const page = fakePage({ stored: "dark", systemDark: false });
    expect(page.first()?.attrs.get("content")).toBe(ownedColour(THEME_COLOR_DARK));
  });

  it("the worker app's viewport uses the same colours as the script", () => {
    expect(workerViewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
      { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
    ]);
    expect([THEME_COLOR_LIGHT, THEME_COLOR_DARK]).toEqual(["#FFFFFF", "#0A0A0A"]);
  });
});
