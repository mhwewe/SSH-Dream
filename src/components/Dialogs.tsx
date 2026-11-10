// Dialogs.tsx — renders the modal requested through store/dialogs.ts (prompt or choose).
// Mounted once in App.tsx.
import { useEffect, useState } from "react";
import { useDialogs } from "../store/dialogs";

export function Dialogs() {
  const cur = useDialogs((s) => s.current);
  const [text, setText] = useState("");

  // Reset the input every time a new prompt opens.
  useEffect(() => { if (cur?.kind === "prompt") setText(cur.initial); }, [cur]);
  if (!cur) return null;

  if (cur.kind === "prompt") {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h3>{cur.title}</h3>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") cur.resolve(text); if (e.key === "Escape") cur.resolve(null); }} />
          <div className="modal-buttons">
            <button onClick={() => cur.resolve(text)}>OK</button>
            <button onClick={() => cur.resolve(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{cur.title}</h3>
        <p>{cur.text}</p>
        <div className="modal-buttons">
          {cur.buttons.map((b) => <button key={b} onClick={() => cur.resolve(b)}>{b}</button>)}
        </div>
      </div>
    </div>
  );
}
