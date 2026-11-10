// components/PasswordDialog.tsx — modal, GLOBAL password / key-passphrase prompt (mount in App.tsx).
//
// Shown when `session_connect` rejected with password_required / passphrase_required; the store
// sets `credPrompt`. "Remember" -> the store calls `secret_set` (OS keyring) before retrying.
// The typed value lives only in this component's state until submit, and is never logged.

import { useEffect, useRef, useState } from "react";
import { useSessions } from "../store/sessions";

export default function PasswordDialog() {
  const prompt = useSessions((s) => s.credPrompt);
  const submit = useSessions((s) => s.submitCredential);
  const cancel = useSessions((s) => s.cancelCredential);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fresh, empty form for every prompt.
  useEffect(() => {
    if (prompt) {
      setValue("");
      setRemember(false);
      inputRef.current?.focus();
    }
  }, [prompt?.profileId, prompt?.kind]);

  if (!prompt) return null;
  const isKey = prompt.kind === "key_passphrase";

  return (
    <div className="dlg-backdrop">
      <form
        className="dlg"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) void submit(value, remember);
        }}
      >
        <h2>{isKey ? "Private key passphrase" : "SSH password"}</h2>
        <p>{isKey ? "The private key is encrypted. Enter its passphrase." : "Enter the password for this server."}</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <label className="dlg-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember (store encrypted)
        </label>
        <div className="dlg-buttons">
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!value}>
            Log in
          </button>
        </div>
      </form>
    </div>
  );
}
