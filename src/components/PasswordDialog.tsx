// components/PasswordDialog.tsx — modal, GLOBAL password / key-passphrase prompt (mounted in App.tsx).
//
// Shown when `session_connect` rejected with password_required / passphrase_required; the store
// sets `credPrompt`. "Remember" -> the store calls `secret_set` (OS keyring) before retrying.
// The typed value lives only in this component's state until submit, and is never logged.
// Polish: tells you WHICH profile / server is asking (several profiles can log in at once), has a show/hide eye,
// and Escape cancels.

import { useEffect, useState } from "react";
import { useSessions } from "../store/sessions";
import { useProfiles } from "../store/profiles";
import { Modal } from "./Modal";
import { IconEye, IconEyeOff } from "./icons";

export default function PasswordDialog() {
  const prompt = useSessions((s) => s.credPrompt);
  const submit = useSessions((s) => s.submitCredential);
  const cancel = useSessions((s) => s.cancelCredential);
  const target = useProfiles((s) => s.profiles.find((p) => p.id === prompt?.profileId) ?? null);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const [show, setShow] = useState(false);

  // Fresh, empty form for every prompt.
  useEffect(() => { setValue(""); setRemember(false); setShow(false); }, [prompt?.profileId, prompt?.kind]);

  if (!prompt) return null;
  const isKey = prompt.kind === "key_passphrase";
  const who = target ? `${target.ssh.username || "?"}@${target.ssh.host || "?"}` : "";

  return (
    <Modal key={`${prompt.profileId}:${prompt.kind}`} title={isKey ? "Private key passphrase" : "SSH password"} onEscape={cancel}>
      <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); if (value) void submit(value, remember); }}>
        <p>
          {isKey ? "The private key is encrypted. Enter its passphrase" : "Enter the password"}
          {who ? <> for <strong>{who}</strong></> : null}
          {target ? <span className="dlg-dim"> (profile “{target.name}”)</span> : null}.
        </p>
        <div className="input-eye">
          <input data-autofocus type={show ? "text" : "password"} autoComplete="off" spellCheck={false}
            aria-label={isKey ? "Key passphrase" : "Password"} value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="eye" aria-label={show ? "Hide" : "Show"} title={show ? "Hide" : "Show"}
            aria-pressed={show} onClick={() => setShow((v) => !v)}>
            {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
          </button>
        </div>
        <label className="dlg-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember (store in the Windows Credential Manager)
        </label>
        <div className="dlg-buttons">
          <button type="button" onClick={cancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!value}>Log in</button>
        </div>
      </form>
    </Modal>
  );
}
