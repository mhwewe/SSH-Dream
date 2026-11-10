// store/theme.ts — colour theme: Auto (follow Windows) / Light / Dark / Catppuccin Latte. The choice is remembered in localStorage.
// The resolved theme is written to <html data-theme="light|dark|latte"> (CSS variables in styles.css switch on it) and
// is also read by the terminal (lib/terminalTheme.ts) so the console matches the rest of the window.
// "Auto" only ever resolves to light or dark (it follows the Windows setting); Latte is always an explicit choice.
// To add another palette: add its id to ThemePref/Resolved + THEMES, a `:root[data-theme="..."]` block in styles.css and an
// xterm palette in lib/terminalTheme.ts.
import { create } from "zustand";

export type ThemePref = "auto" | "light" | "dark" | "latte";
export type Resolved = "light" | "dark" | "latte";
const KEY = "ui.theme";

/** Every choice in display order (used by the theme button cycle and by the Options page picker). */
export const THEMES: { id: ThemePref; label: string }[] = [
  { id: "auto", label: "Follow Windows" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "latte", label: "Catppuccin Latte" },
];
export const themeLabel = (p: ThemePref) => THEMES.find((t) => t.id === p)?.label ?? p;

const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");
function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === v) ? (v as ThemePref) : "auto";
  } catch { return "auto"; }
}
const resolve = (p: ThemePref): Resolved => (p === "auto" ? (media()?.matches ? "dark" : "light") : p);

function apply(r: Resolved) {
  document.documentElement.dataset.theme = r;
  // Native scrollbars + form controls: Latte is a LIGHT palette, so it uses the light native look.
  document.documentElement.style.colorScheme = r === "dark" ? "dark" : "light";
}

interface ThemeStore { pref: ThemePref; resolved: Resolved; setPref: (p: ThemePref) => void; cycle: () => void }

export const useTheme = create<ThemeStore>((set, get) => ({
  pref: readPref(),
  resolved: resolve(readPref()),
  setPref: (pref) => {
    try { localStorage.setItem(KEY, pref); } catch { /* not remembered: fine */ }
    const resolved = resolve(pref);
    apply(resolved);
    set({ pref, resolved });
  },
  cycle: () => {
    const i = THEMES.findIndex((t) => t.id === get().pref);
    get().setPref(THEMES[(i + 1) % THEMES.length].id);
  },
}));

/** Call once, before the first render (main.tsx), so there is no flash of the wrong theme. */
export function initTheme() {
  apply(useTheme.getState().resolved);
  media()?.addEventListener?.("change", () => {
    if (useTheme.getState().pref !== "auto") return;
    const resolved = resolve("auto");
    apply(resolved);
    useTheme.setState({ resolved });
  });
}
