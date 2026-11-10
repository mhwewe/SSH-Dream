// LoginTab.tsx — Server (host, port) + Authentication (username, method, password / key file) + a live status banner.
// Edits go to the store's DRAFT (store/profiles.ts). The password field is write-only: after a save
// it is cleared and shows "•••••••• (saved)" when the keyring holds a secret (secret_exists).
// Polish: Enter logs in; the banner shows connected / connecting / the LAST ERROR (it used to be invisible);
// show/hide eye on the password; port is validated while typing; Log in / Log out button at the bottom.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useProfiles } from "../store/profiles";
import { useSessions } from "../store/sessions";
import { logInActive } from "../components/ActionBar";
import { StatusDot } from "../components/StatusDot";
import { IconEye, IconEyeOff } from "../components/icons";

export function LoginTab() {
  const d = useProfiles((s) => s.draft);
  const patch = useProfiles((s) => s.patchDraft);
  const pending = useProfiles((s) => s.pending);
  const exists = useProfiles((s) => s.exists);
  const setPending = useProfiles((s) => s.setPending);
  const session = useSessions((s) => (d ? s.byProfile[d.id] : undefined));
  const disconnect = useSessions((s) => s.disconnect);
  const [reveal, setReveal] = useState(false);
  if (!d) return null;

  const state = session?.state ?? "disconnected";
  const isKey = d.ssh.authMethod === "publickey";
  const kind = isKey ? "key_passphrase" : "ssh"; // which secret the field below edits
  const saved = d.ssh.storePassword && exists[kind] && !pending[kind];
  const badPort = !(d.ssh.port >= 1 && d.ssh.port <= 65535);

  async function pickKey() {
    const path = await open({ multiple: false, directory: false, title: "Select the private key file" });
    if (typeof path === "string") patch((x) => { x.ssh.keyPath = path; }); // stored exactly as returned
  }

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (state !== "connecting" && state !== "connected") void logInActive(); }}>
      {state !== "disconnected" && (
        <div className={`banner banner-${state}`} role={state === "error" ? "alert" : "status"}>
          <StatusDot state={state} />
          <span>
            {state === "connected" && <>Logged in to <strong>{d.ssh.username}@{d.ssh.host}</strong></>}
            {state === "connecting" && <>Connecting to <strong>{d.ssh.host}</strong>…</>}
            {state === "error" && <>Login failed{session?.lastError ? `: ${session.lastError}` : ""}</>}
          </span>
        </div>
      )}

      <h4>Server</h4>
      <label>Host <input value={d.ssh.host} placeholder="example.com or 192.168.1.10" spellCheck={false} autoCapitalize="off"
        onChange={(e) => patch((x) => { x.ssh.host = e.target.value; })} /></label>
      <label>Port <input type="number" min={1} max={65535} value={d.ssh.port || ""} className={badPort ? "invalid" : ""} aria-invalid={badPort}
        onChange={(e) => patch((x) => { x.ssh.port = Number(e.target.value) || 0; })} /></label>
      {badPort && <p className="form-hint form-error">The port must be a number from 1 to 65535.</p>}

      <h4>Authentication</h4>
      <label>Username <input value={d.ssh.username} spellCheck={false} autoCapitalize="off" autoComplete="off"
        onChange={(e) => patch((x) => { x.ssh.username = e.target.value; })} /></label>
      <label>Initial method
        <select value={d.ssh.authMethod} onChange={(e) => patch((x) => { x.ssh.authMethod = e.target.value as "password" | "publickey"; })}>
          <option value="password">Password</option>
          <option value="publickey">Public key</option>
        </select>
      </label>

      {isKey && (
        <label>Key file
          <span className="row">
            <input readOnly value={d.ssh.keyPath ?? ""} placeholder="(none)" title={d.ssh.keyPath ?? ""} />
            <button type="button" onClick={() => void pickKey()}>Browse…</button>
          </span>
        </label>
      )}

      <label>{isKey ? "Key passphrase" : "Password"}
        <span className="input-eye">
          <input type={reveal ? "text" : "password"} autoComplete="off" value={pending[kind]}
            placeholder={saved ? "•••••••• (saved)" : ""}
            onChange={(e) => setPending(kind, e.target.value)} />
          <button type="button" className="eye" aria-label={reveal ? "Hide" : "Show"} title={reveal ? "Hide" : "Show"} aria-pressed={reveal}
            onClick={() => setReveal((v) => !v)}>{reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}</button>
        </span>
      </label>

      <label className="check">
        <input type="checkbox" checked={d.ssh.storePassword}
          onChange={(e) => patch((x) => { x.ssh.storePassword = e.target.checked; })} />
        Store encrypted password in profile
      </label>
      <label className="check" title="The profile you used last always connects on start and opens SFTP and a terminal. Tick this to connect this profile too, even when another one was used last. If the password is not stored you will be asked for it.">
        <input type="checkbox" checked={d.ssh.autoLogin}
          onChange={(e) => patch((x) => { x.ssh.autoLogin = e.target.checked; })} />
        Also connect this profile on start when it is not the last-used one (SSH + SFTP + terminal)
      </label>

      <div className="form-actions">
        {state === "connected" ? (
          <button type="button" onClick={() => void disconnect(d.id)}>Log out</button>
        ) : (
          <button type="submit" className="primary" disabled={state === "connecting" || badPort}>
            {state === "connecting" ? "Connecting…" : "Log in"}
          </button>
        )}
        <span className="form-hint">Enter logs in. Secrets are kept in the Windows Credential Manager, never in the profile file.</span>
      </div>
    </form>
  );
}
