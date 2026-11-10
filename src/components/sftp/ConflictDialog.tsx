// components/sftp/ConflictDialog.tsx — answers `transfer://conflict` (README §5.3, HANDOFF-3 §5).
// GLOBAL: mounted once in App.tsx (a conflict can arrive while another tab/profile is in front).
// Conflicts are queued in store/sftp.ts and shown one at a time. "Apply to all" answers the current
// AND every queued conflict, and the backend remembers it until its transfer queue is idle.
// Polish: Escape = Skip (the non-destructive answer), focus starts on "Skip", and the dialog shows how many conflicts wait.
import { useEffect, useState } from "react";
import { useSftp } from "../../store/sftp";
import { Modal } from "../Modal";

export function ConflictDialog() {
  const conflicts = useSftp((s) => s.conflicts);
  const head = conflicts[0];
  const answer = useSftp((s) => s.answerConflict);
  const [all, setAll] = useState(false);

  // Fresh checkbox for every conflict.
  useEffect(() => { setAll(false); }, [head?.transferId, head?.path]);
  if (!head) return null;

  return (
    <Modal key={`${head.transferId}:${head.path}`} title="File already exists" danger onEscape={() => void answer("skip", false)}>
      <p>The destination already contains:</p>
      <p className="mono wrap">{head.path}</p>
      {conflicts.length > 1 && <p className="dlg-dim">{conflicts.length - 1} more conflict{conflicts.length > 2 ? "s are" : " is"} waiting.</p>}
      <label className="dlg-check">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Apply to all remaining conflicts
      </label>
      <div className="dlg-buttons">
        <button data-autofocus onClick={() => void answer("skip", all)}>Skip</button>
        <button onClick={() => void answer("rename", all)}>Keep both (rename)</button>
        <button className="danger" onClick={() => void answer("overwrite", all)}>Overwrite</button>
      </div>
    </Modal>
  );
}
