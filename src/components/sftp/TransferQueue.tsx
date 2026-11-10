// components/sftp/TransferQueue.tsx — collapsible transfer list at the bottom of the SFTP tab.
// Rows: direction arrow, name, progress bar, bytes, speed + time left, state / Cancel.
// Header: counts, overall progress of the live rows, "Cancel all", "Clear finished". Drags to Explorer show up here too
// (one "download" row per dragged item, fed by the backend: sftp/dragout.rs + dragprogress.rs). "Clear finished" removes
// done/failed/cancelled rows. Shows only the rows of the ACTIVE profile (each profile keeps its queue).
// Polish: SVG icons, the header is a real button (keyboard + aria-expanded), progress bars are ARIA progressbars.
// Used by: tabs/SftpTab.tsx.
import { useState } from "react";
import type { TransferRow } from "../../store/sftp";
import { formatBytes, formatEta, formatSpeed } from "../../lib/paths";
import { IconChevronDown, IconChevronRight, IconDownload, IconUpload } from "../icons";

interface Props {
  rows: TransferRow[];
  onCancel: (transferId: string) => void;
  onClear: () => void;
}

export function TransferQueue({ rows, onCancel, onClear }: Props) {
  const [open, setOpen] = useState(true);
  const liveRows = rows.filter((r) => r.state === "queued" || r.state === "running");
  const running = liveRows.length;
  const finished = rows.length - running;
  // Overall progress of everything still live (rows whose size is not known yet count as 0 of 0).
  const liveTotal = liveRows.reduce((n, r) => n + r.bytesTotal, 0);
  const liveDone = liveRows.reduce((n, r) => n + Math.min(r.bytesDone, r.bytesTotal), 0);
  const overall = liveTotal > 0 ? ` · ${Math.min(99, Math.floor((liveDone / liveTotal) * 100))}%` : "";

  return (
    <div className="tq">
      <div className="tq-head" onClick={() => setOpen(!open)}>
        <button className="tq-toggle" aria-expanded={open} aria-label="Show or hide the transfers list"
          onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <span>Transfers{rows.length ? ` (${running} active, ${finished} finished)${overall}` : ""}</span>
        </button>
        <span className="tq-head-btns">
          <button
            disabled={running === 0}
            title="Cancel every queued and running transfer"
            onClick={(e) => { e.stopPropagation(); liveRows.forEach((r) => onCancel(r.transferId)); }}
          >
            Cancel all
          </button>
          <button
            disabled={finished === 0}
            onClick={(e) => { e.stopPropagation(); onClear(); }}
          >
            Clear finished
          </button>
        </span>
      </div>
      {open && (
        <div className="tq-body">
          {rows.length === 0 && <div className="tq-empty">No transfers yet. Use Upload / Download, drop files from Explorer, or drag items out to Explorer.</div>}
          {rows.map((r) => {
            const pct = r.bytesTotal > 0 ? Math.min(100, (r.bytesDone / r.bytesTotal) * 100) : r.state === "done" ? 100 : 0;
            const live = r.state === "queued" || r.state === "running";
            return (
              <div key={r.transferId} className={`tq-row tq-${r.state}`}>
                <span className="tq-dir" title={r.direction === "upload" ? "Upload" : "Download"}>
                  {r.direction === "upload" ? <IconUpload size={14} /> : <IconDownload size={14} />}
                </span>
                <span className="tq-name" title={r.fileName}>{r.fileName}</span>
                <span className="tq-bar" role="progressbar" aria-label={`${r.fileName} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                  <span className={`tq-fill${r.state === "queued" ? " idle" : ""}`} style={{ width: `${pct}%` }} />
                </span>
                <span className="tq-bytes">
                  {r.state === "queued" ? "queued" : `${formatBytes(r.bytesDone)}${r.bytesTotal ? ` / ${formatBytes(r.bytesTotal)}` : ""}`}
                </span>
                <span className="tq-speed">
                  {r.state === "running" ? [formatSpeed(r.speed), r.bytesTotal > 0 && r.speed > 0 ? formatEta((r.bytesTotal - r.bytesDone) / r.speed) : ""].filter(Boolean).join(" · ") : ""}
                </span>
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
