// RdpTab.tsx — Remote Desktop settings + Connect. Blank host/username = reuse the SSH values.
// Connect first SAVES the profile (the backend reads the saved profile + keyring), then calls rdp_launch.
import { useProfiles } from "../store/profiles";
import { rdpLaunch } from "../api/rdp";
import { toAppError } from "../api/invoke";
import { toast } from "../store/toasts";
import { parseResolution, RESOLUTION_PRESETS } from "../lib/resolution";

export function RdpTab() {
  const d = useProfiles((s) => s.draft);
  const patch = useProfiles((s) => s.patchDraft);
  const pending = useProfiles((s) => s.pending);
  const exists = useProfiles((s) => s.exists);
  const setPending = useProfiles((s) => s.setPending);
  const saveDraft = useProfiles((s) => s.saveDraft);
  if (!d) return null;

  const saved = d.rdp.storePassword && exists.rdp && !pending.rdp;
  const badRes = parseResolution(d.rdp.resolution ?? "") === false;

  async function connect() {
    const p = await saveDraft();
    if (!p) return;
    try { await rdpLaunch(p.id); } catch (e) { toast(toAppError(e).message, "error"); }
  }

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (!badRes) void connect(); }}>
      <h4>Remote Desktop</h4>
      <label>Host <input value={d.rdp.host ?? ""} placeholder="(same as SSH host)"
        onChange={(e) => patch((x) => { x.rdp.host = e.target.value || null; })} /></label>
      <label>Port <input type="number" min={1} max={65535} value={d.rdp.port || ""}
        onChange={(e) => patch((x) => { x.rdp.port = Number(e.target.value) || 0; })} /></label>
      <label>Username <input value={d.rdp.username ?? ""} placeholder="(same as SSH username)"
        onChange={(e) => patch((x) => { x.rdp.username = e.target.value || null; })} /></label>
      <label>Password
        <input type="password" autoComplete="off" disabled={!d.rdp.storePassword} value={pending.rdp}
          placeholder={saved ? "•••••••• (saved)" : d.rdp.storePassword ? "" : "(tick the box to store one)"}
          onChange={(e) => setPending("rdp", e.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={d.rdp.storePassword}
        onChange={(e) => patch((x) => { x.rdp.storePassword = e.target.checked; })} /> Store encrypted password in profile</label>
      <label className="check"><input type="checkbox" checked={d.rdp.fullscreen}
        onChange={(e) => patch((x) => { x.rdp.fullscreen = e.target.checked; })} /> Full screen</label>
      <label>Resolution
        <input list="rdp-res-presets" value={d.rdp.resolution ?? ""} placeholder="(default) e.g. 1920x1080"
          spellCheck={false} className={badRes ? "invalid" : ""} aria-invalid={badRes}
          onChange={(e) => patch((x) => { x.rdp.resolution = e.target.value || null; })} />
        <datalist id="rdp-res-presets">{RESOLUTION_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
      </label>
      {badRes && <p className="form-hint form-error">Use the form WIDTHxHEIGHT, each between 200 and 8192 (for example 1920x1080).</p>}
      <label className="check"><input type="checkbox" checked={d.rdp.smartResize}
        onChange={(e) => patch((x) => { x.rdp.smartResize = e.target.checked; })} /> Smart resize</label>
      <p className="form-hint">
        On: drag the Remote Desktop window's edge (or maximize it) and the remote desktop changes size to fit, with no
        scaling or scrollbars. Needs Windows 8.1 / Server 2012 R2 or newer on the remote side.
        Resolution is the size the session starts with; leave it empty to use Windows' default.
      </p>
      <div className="form-actions"><button type="submit" className="primary" disabled={badRes}>Connect</button></div>
    </form>
  );
}
