// OptionsTab.tsx — terminal settings (maps to Profile.terminal). Used by Handoff 2's xterm.js tab.
import { useProfiles } from "../store/profiles";

export function OptionsTab() {
  const d = useProfiles((s) => s.draft);
  const patch = useProfiles((s) => s.patchDraft);
  if (!d) return null;
  const num = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <div className="form">
      <h4>Terminal</h4>
      <label>Font family <input value={d.terminal.fontFamily} onChange={(e) => patch((x) => { x.terminal.fontFamily = e.target.value; })} /></label>
      <label>Font size <input type="number" min={6} max={72} value={d.terminal.fontSize} onChange={(e) => patch((x) => { x.terminal.fontSize = num(e.target.value); })} /></label>
      <label>Scrollback (lines) <input type="number" min={0} value={d.terminal.scrollback} onChange={(e) => patch((x) => { x.terminal.scrollback = num(e.target.value); })} /></label>
      <label>Terminal type <input value={d.terminal.termType} onChange={(e) => patch((x) => { x.terminal.termType = e.target.value; })} /></label>
    </div>
  );
}
