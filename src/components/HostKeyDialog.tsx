// components/HostKeyDialog.tsx — modal, GLOBAL host-key prompt (mount once in App.tsx).
//
// Listens to `hostkey://prompt` (README §5.3). It is global because the prompt can arrive while
// another profile is active. Prompts are queued and shown one at a time.
// status "changed" = DANGER: red banner, and the default (focused) button is Cancel.
// Polish: Escape = Cancel (same as the safe default), the fingerprint can be copied, and the dialog says how many more
// prompts are waiting.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { HostKeyPrompt } from "../api/types";
import { hostKeyDecide } from "../api/session";
import { toast } from "../store/toasts";
import { Modal } from "./Modal";
import { IconAlert, IconCopy } from "./icons";

export default function HostKeyDialog() {
  const [queue, setQueue] = useState<HostKeyPrompt[]>([]);

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
  if (!current) return null;

  const answer = (accept: boolean, remember: boolean) => {
    // If the backend no longer waits (timeout / logout) the call fails; just drop the prompt.
    void hostKeyDecide(current.promptId, accept, remember).catch(() => {});
    setQueue((q) => q.slice(1));
  };
  const copyFingerprint = () =>
    navigator.clipboard.writeText(current.fingerprintSha256).then(() => toast("Fingerprint copied", "success"), () => toast("Could not copy", "error"));

  const changed = current.status === "changed";

  return (
    <Modal key={current.promptId} title={changed ? "Host key CHANGED" : "New host key"} danger={changed} onEscape={() => answer(false, false)}>
      {changed && (
        <div className="dlg-danger" role="alert"><IconAlert size={16} /> The host key has CHANGED. This could mean someone is intercepting your connection.</div>
      )}

      <p>
        {changed
          ? "The server presented a different key than the one saved before."
          : "You have not connected to this server before. Check the fingerprint if you can."}
      </p>

      <dl className="dlg-kv">
        <dt>Server</dt>
        <dd>{current.host}:{current.port}</dd>
        <dt>Algorithm</dt>
        <dd>{current.algorithm}</dd>
        <dt>Fingerprint</dt>
        <dd className="mono fingerprint">
          {current.fingerprintSha256}
          <button className="icon-btn" aria-label="Copy fingerprint" title="Copy fingerprint" onClick={copyFingerprint}><IconCopy size={14} /></button>
        </dd>
      </dl>
      {queue.length > 1 && <p className="dlg-dim">{queue.length - 1} more host-key question{queue.length > 2 ? "s are" : " is"} waiting.</p>}

      <div className="dlg-buttons">
        <button data-autofocus onClick={() => answer(false, false)}>Cancel</button>
        <button onClick={() => answer(true, false)}>Accept once</button>
        <button className={changed ? "danger" : "primary"} onClick={() => answer(true, true)}>
          {changed ? "Replace saved key and accept" : "Accept and save"}
        </button>
      </div>
    </Modal>
  );
}
