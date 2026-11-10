// components/sftp/TransferQueue.tsx — collapsible transfer list at the bottom of the SFTP tab.
// Rows: direction arrow, name, progress bar, bytes, speed, state / Cancel. "Clear finished" removes
// done/failed/cancelled rows. Shows only the rows of the ACTIVE profile (each profile keeps its queue).
// Used by: tabs/SftpTab.tsx.
import { useState } from "react";
import type { TransferRow } from "../../store/sftp";
import { formatBytes, formatSpeed } from "../../lib/paths";

interface Props {
  rows: TransferRow[];
  onCancel: (transferId: string) => void;
  onClear: () => void;
}

export function TransferQueue({ rows, onCancel, onClear }: Props) {
  const [open, setOpen] = useState(true);
  const running = rows.filter((r) => r.state === "queued" || r.state === "running").length;
  const finished = rows.length - running;

  return (
    <div className="tq">
      <div className="tq-head" onClick={() => setOpen(!open)}>
        <span>{open ? "▼" : "▶"} Transfers{rows.length ? ` (${running} active, ${finished} finished)` : ""}</span>
        <button
          disabled={finished === 0}
          onClick={(e) => { e.stopPropagation(); onClear(); }}
        >
          Clear finished
        </button>
      </div>
      {open && (
        <div className="tq-body">
          {rows.length === 0 && <div className="tq-empty">No transfers yet. Use Upload / Download or drop files from Explorer.</div>}
          {rows.map((r) => {
            const pct = r.bytesTotal > 0 ? Math.min(100, (r.bytesDone / r.bytesTotal) * 100) : r.state === "done" ? 100 : 0;
            const live = r.state === "queued" || r.state === "running";
            return (
              <div key={r.transferId} className={`tq-row tq-${r.state}`}>
                <span className="tq-dir" title={r.direction}>{r.direction === "upload" ? "⬆" : "⬇"}</span>
                <span className="tq-name" title={r.fileName}>{r.fileName}</span>
                <span className="tq-bar"><span className="tq-fill" style={{ width: `${pct}%` }} /></span>
                <span className="tq-bytes">
                  {r.state === "queued" ? "queued" : `${formatBytes(r.bytesDone)}${r.bytesTotal ? ` / ${formatBytes(r.bytesTotal)}` : ""}`}
                </span>
                <span className="tq-speed">{r.state === "running" ? formatSpeed(r.speed) : ""}</span>
                <span className="tq-state" title={r.error}>
                  {live ? <button onClick={() => onCancel(r.transferId)}>Cancel</button>
                    : r.state === "error" ? `Error: ${r.error ?? "failed"}`
                    : r.state === "cancelled" ? "Cancelled" : "Done"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
