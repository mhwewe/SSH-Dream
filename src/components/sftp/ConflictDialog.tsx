// components/sftp/ConflictDialog.tsx — answers `transfer://conflict` (README §5.3, HANDOFF-3 §5).
// GLOBAL: mounted once in App.tsx (a conflict can arrive while another tab/profile is in front).
// Conflicts are queued in store/sftp.ts and shown one at a time. "Apply to all" answers the current
// AND every queued conflict, and the backend remembers it until its transfer queue is idle.
import { useEffect, useState } from "react";
import { useSftp } from "../../store/sftp";

export function ConflictDialog() {
  const head = useSftp((s) => s.conflicts[0]);
  const answer = useSftp((s) => s.answerConflict);
  const [all, setAll] = useState(false);

  // Fresh checkbox for every conflict.
  useEffect(() => { setAll(false); }, [head?.transferId, head?.path]);
  if (!head) return null;

  return (
    <div className="dlg-backdrop">
      <div className="dlg" role="dialog" aria-modal="true">
        <h2>File already exists</h2>
        <p>The destination already contains:</p>
        <p className="mono" style={{ wordBreak: "break-all" }}>{head.path}</p>
        <label className="dlg-check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Apply to all remaining conflicts
        </label>
        <div className="dlg-buttons">
          <button onClick={() => void answer("skip", all)}>Skip</button>
          <button onClick={() => void answer("rename", all)}>Keep both (rename)</button>
          <button className="danger" onClick={() => void answer("overwrite", all)}>Overwrite</button>
        </div>
      </div>
    </div>
  );
}
