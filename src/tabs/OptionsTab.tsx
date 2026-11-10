// OptionsTab.tsx — Options page, opened with the cogwheel in the top right corner (App.tsx).
//   * Appearance: colour theme picker (Follow Windows / Light / Dark / Catppuccin Latte). App-wide, NOT part of the profile;
//     stored by store/theme.ts in localStorage and applied immediately.
//   * Terminal: terminal settings (maps to Profile.terminal). Used by Handoff 2's xterm.js tab.
// Polish: numbers are clamped to sane limits when you leave the field, a live preview shows the chosen font, and a hint
// says that changes apply to NEW terminals (a terminal copies its settings when it is opened).
import { useProfiles } from "../store/profiles";
import { THEMES, useTheme } from "../store/theme";

// Swatch colours per theme: [window surface, accent, text] (the picker previews them without applying the theme).
// "auto" shows a light + dark pair because it follows Windows.
const SWATCH: Record<string, string[]> = {
  auto: ["#ffffff", "#2563b0", "#1e2229"],
  light: ["#ffffff", "#2563b0", "#1b1f24"],
  dark: ["#1e2229", "#4a90e2", "#e6e9ee"],
  latte: ["#eff1f5", "#8839ef", "#4c4f69"],
};

const FONTS = ["Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", "Courier New"];
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n) || lo));

export function OptionsTab() {
  const d = useProfiles((s) => s.draft);
  const patch = useProfiles((s) => s.patchDraft);
  const themePref = useTheme((s) => s.pref);   // (hooks first: they must not come after the early return below)
  const setTheme = useTheme((s) => s.setPref);
  if (!d) return null;
  const num = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <div className="form">
      <h4>Appearance</h4>
      {/* Radio group made of buttons: one card per theme, the chosen one has aria-checked="true". */}
      <div className="theme-picker" role="radiogroup" aria-label="Colour theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={themePref === t.id} className="theme-opt" onClick={() => setTheme(t.id)}>
            <span className="theme-swatch" aria-hidden="true">{SWATCH[t.id].map((c) => <i key={c} style={{ background: c }} />)}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <p className="form-hint">The theme applies to the whole app straight away. The button at the bottom of the left bar cycles through the same choices.</p>

      <h4>Terminal</h4>
      <label>Font family
        <input list="term-fonts" value={d.terminal.fontFamily} spellCheck={false} onChange={(e) => patch((x) => { x.terminal.fontFamily = e.target.value; })} />
        <datalist id="term-fonts">{FONTS.map((f) => <option key={f} value={f} />)}</datalist>
      </label>
      <label>Font size
        <input type="number" min={6} max={72} value={d.terminal.fontSize} onChange={(e) => patch((x) => { x.terminal.fontSize = num(e.target.value); })}
          onBlur={() => patch((x) => { x.terminal.fontSize = clamp(x.terminal.fontSize, 6, 72); })} />
      </label>
      <label>Scrollback (lines)
        <input type="number" min={0} max={200000} step={1000} value={d.terminal.scrollback} onChange={(e) => patch((x) => { x.terminal.scrollback = num(e.target.value); })}
          onBlur={() => patch((x) => { x.terminal.scrollback = clamp(x.terminal.scrollback, 0, 200000); })} />
      </label>
      <label>Terminal type
        <input list="term-types" value={d.terminal.termType} spellCheck={false} onChange={(e) => patch((x) => { x.terminal.termType = e.target.value; })} />
        <datalist id="term-types">{["xterm-256color", "xterm", "vt100", "linux"].map((t) => <option key={t} value={t} />)}</datalist>
      </label>

      <div className="term-preview" aria-label="Font preview"
        style={{ fontFamily: `"${d.terminal.fontFamily}", Consolas, monospace`, fontSize: clamp(d.terminal.fontSize, 6, 72) }}>
        user@server:~$ ls -la<br />The quick brown fox 0123456789 {"{ } [ ] ( ) => !="}
      </div>
      <p className="form-hint">Changes apply to terminals you open after saving. Inside a terminal, Ctrl + mouse wheel (or Ctrl + / −, Ctrl 0) zooms just that terminal.</p>
    </div>
  );
}
