// LoginTab.tsx — Server (host, port) + Authentication (username, method, password / key file).
// Edits go to the store's DRAFT (store/profiles.ts). The password field is write-only: after a save
// it is cleared and shows "•••••••• (saved)" when the keyring holds a secret (secret_exists).
import { open } from "@tauri-apps/plugin-dialog";
import { useProfiles } from "../store/profiles";

export function LoginTab() {
  const d = useProfiles((s) => s.draft);
  const patch = useProfiles((s) => s.patchDraft);
  const pending = useProfiles((s) => s.pending);
  const exists = useProfiles((s) => s.exists);
  const setPending = useProfiles((s) => s.setPending);
  if (!d) return null;

  const isKey = d.ssh.authMethod === "publickey";
  const kind = isKey ? "key_passphrase" : "ssh"; // which secret the field below edits
  const saved = d.ssh.storePassword && exists[kind] && !pending[kind];

  async function pickKey() {
    const path = await open({ multiple: false, directory: false });
    if (typeof path === "string") patch((x) => { x.ssh.keyPath = path; }); // stored exactly as returned
  }

  return (
    <div className="form">
      <h4>Server</h4>
      <label>Host <input value={d.ssh.host} onChange={(e) => patch((x) => { x.ssh.host = e.target.value; })} /></label>
      <label>Port <input type="number" min={1} max={65535} value={d.ssh.port || ""}
        onChange={(e) => patch((x) => { x.ssh.port = Number(e.target.value) || 0; })} /></label>

      <h4>Authentication</h4>
      <label>Username <input value={d.ssh.username} onChange={(e) => patch((x) => { x.ssh.username = e.target.value; })} /></label>
      <label>Initial method
        <select value={d.ssh.authMethod} onChange={(e) => patch((x) => { x.ssh.authMethod = e.target.value as "password" | "publickey"; })}>
          <option value="password">Password</option>
          <option value="publickey">Public key</option>
        </select>
      </label>

      {isKey && (
        <label>Key file
          <span className="row">
            <input readOnly value={d.ssh.keyPath ?? ""} placeholder="(none)" />
            <button onClick={() => void pickKey()}>Browse…</button>
          </span>
        </label>
      )}

      <label>{isKey ? "Key passphrase" : "Password"}
        <input type="password" autoComplete="off" value={pending[kind]}
          placeholder={saved ? "•••••••• (saved)" : ""}
          onChange={(e) => setPending(kind, e.target.value)} />
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
    </div>
  );
}
