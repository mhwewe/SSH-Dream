// components/HostKeyDialog.tsx — modal, GLOBAL host-key prompt (mount once in App.tsx).
//
// Listens to `hostkey://prompt` (README §5.3). It is global because the prompt can arrive while
// another profile is active. Prompts are queued and shown one at a time.
// status "changed" = DANGER: red banner, and the default (focused) button is Cancel.

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { HostKeyPrompt } from "../api/types";
import { hostKeyDecide } from "../api/session";

export default function HostKeyDialog() {
  const [queue, setQueue] = useState<HostKeyPrompt[]>([]);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    void listen<HostKeyPrompt>("hostkey://prompt", (e) => setQueue((q) => [...q, e.payload])).then((f) => {
      if (gone) f();
      else un = f;
    });
    return () => {
      gone = true;
      un?.();
    };
  }, []);

  const current = queue[0];

  // Safe default: focus Cancel whenever a new prompt appears.
  useEffect(() => {
    if (current) cancelRef.current?.focus();
  }, [current?.promptId]);

  if (!current) return null;

  const answer = (accept: boolean, remember: boolean) => {
    // If the backend no longer waits (timeout / logout) the call fails; just drop the prompt.
    void hostKeyDecide(current.promptId, accept, remember).catch(() => {});
    setQueue((q) => q.slice(1));
  };

  const changed = current.status === "changed";

  return (
    <div className="dlg-backdrop">
      <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="hk-title">
        <h2 id="hk-title">{changed ? "Host key CHANGED" : "New host key"}</h2>

        {changed && (
          <div className="dlg-danger">
            The host key has CHANGED. This could mean someone is intercepting your connection.
          </div>
        )}

        <p>
          {changed
            ? "The server presented a different key than the one saved before."
            : "You have not connected to this server before. Check the fingerprint if you can."}
        </p>

        <dl className="dlg-kv">
          <dt>Server</dt>
          <dd>
            {current.host}:{current.port}
          </dd>
          <dt>Algorithm</dt>
          <dd>{current.algorithm}</dd>
          <dt>Fingerprint</dt>
          <dd className="mono">{current.fingerprintSha256}</dd>
        </dl>

        <div className="dlg-buttons">
          <button ref={cancelRef} onClick={() => answer(false, false)}>
            Cancel
          </button>
          <button onClick={() => answer(true, false)}>Accept once</button>
          <button className={changed ? "danger" : "primary"} onClick={() => answer(true, true)}>
            {changed ? "Replace saved key and accept" : "Accept and save"}
          </button>
        </div>
      </div>
    </div>
  );
}
