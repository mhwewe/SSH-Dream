// Dialogs.tsx — renders the modal requested through store/dialogs.ts (prompt or choose). Mounted once in App.tsx.
// Keyboard: Enter confirms, Escape cancels (prompt -> null; choose -> the "Cancel" button, or the last button).
// Safety: when a choose-dialog offers "Delete" the focus starts on "Cancel", so a stray Enter never deletes anything.
import { useEffect, useState } from "react";
import { useDialogs } from "../store/dialogs";
import { Modal } from "./Modal";

const DANGER = /^(delete|remove|overwrite|discard)/i;

export function Dialogs() {
  const cur = useDialogs((s) => s.current);
  const [text, setText] = useState("");

  // Reset the input every time a new prompt opens.
  useEffect(() => { if (cur?.kind === "prompt") setText(cur.initial); }, [cur]);
  if (!cur) return null;

  if (cur.kind === "prompt") {
    return (
      <Modal key={cur.title + cur.initial} title={cur.title} onEscape={() => cur.resolve(null)}>
        <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); cur.resolve(text); }}>
          <input data-autofocus aria-label={cur.title} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          <div className="dlg-buttons">
            <button type="button" onClick={() => cur.resolve(null)}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      </Modal>
    );
  }

  const cancel = cur.buttons.find((b) => /^cancel$/i.test(b)) ?? cur.buttons[cur.buttons.length - 1];
  const dangerous = cur.buttons.some((b) => DANGER.test(b));
  // Focus: the safe button when something dangerous is offered, else the first button.
  const focusLabel = dangerous ? cancel : cur.buttons[0];
  return (
    <Modal key={cur.title + cur.text} title={cur.title} danger={dangerous} onEscape={() => cur.resolve(cancel)}>
      <p>{cur.text}</p>
      <div className="dlg-buttons">
        {cur.buttons.map((b) => (
          <button key={b} data-autofocus={b === focusLabel ? "" : undefined}
            className={DANGER.test(b) ? "danger" : b === cur.buttons[0] && !dangerous ? "primary" : ""}
            onClick={() => cur.resolve(b)}>{b}</button>
        ))}
      </div>
    </Modal>
  );
}
