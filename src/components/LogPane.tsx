// LogPane.tsx — bottom log, Bitvise style: "HH:MM:SS.mmm  message" + icon per level.
// Data: store/logs.ts (subscribed to `session://log`).
// Polish: it only follows new lines while you are at the bottom (scroll up to read in peace; a "Jump to latest" button
// appears), text can be selected, "Copy" puts the whole log on the clipboard, and the lines are an ARIA log.
import { useEffect, useRef, useState } from "react";
import { useLogs } from "../store/logs";
import { toast } from "../store/toasts";
import { useDragSize } from "../lib/useDragSize";
import { IconAlert, IconError, IconInfo } from "./icons";

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
function fmt(ts: string) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const ICON = { info: IconInfo, warn: IconAlert, error: IconError } as const;

export function LogPane() {
  const { lines, clear } = useLogs();
  const bodyRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true); // true = at the bottom: new lines scroll into view
  // Drag the top edge to resize (up = taller). Remembered between runs.
  const [height, onResize] = useDragSize("logpane.height", 150, 0, () => Math.round(window.innerHeight * 0.7), "y", true, 70);

  useEffect(() => { if (stuck && height > 0) endRef.current?.scrollIntoView({ block: "end" }); }, [lines, stuck, height]);

  function onScroll() {
    const el = bodyRef.current;
    if (el) setStuck(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  }
  function copyAll() {
    const text = lines.map((l) => `${fmt(l.ts)}  ${l.level.toUpperCase().padEnd(5)} ${l.message}`).join("\n");
    navigator.clipboard.writeText(text).then(() => toast(`Copied ${lines.length} log line${lines.length === 1 ? "" : "s"}`, "success"), () => toast("Could not copy the log", "error"));
  }

  return (
    <>
    <div className={`splitter-y${height === 0 ? " is-collapsed" : ""}`} role="separator" aria-orientation="horizontal"
      title={height === 0 ? "Drag up to show the log" : "Drag to resize the log (drag all the way down to hide it)"} onMouseDown={onResize} />
    <div className={`logpane${height === 0 ? " is-collapsed" : ""}`} style={{ height }}>
      <div className="logpane-head">
        <span>Log{lines.length ? ` (${lines.length})` : ""}</span>
        <span className="logpane-btns">
          <button disabled={!lines.length} onClick={copyAll} title="Copy the whole log to the clipboard">Copy</button>
          <button disabled={!lines.length} onClick={clear}>Clear</button>
        </span>
      </div>
      <div className="logpane-body" ref={bodyRef} onScroll={onScroll} role="log" aria-live="off" tabIndex={0} aria-label="Connection log">
        {lines.length === 0 && <div className="log-empty">Nothing logged yet. Connection steps, host-key checks and errors show up here.</div>}
        {lines.map((l) => {
          const Icon = ICON[l.level];
          return (
            <div key={l.key} className={`logline log-${l.level}`}>
              <span className="log-ts">{fmt(l.ts)}</span>
              <span className="log-icon"><Icon size={12} /></span>
              <span className="log-msg">{l.message}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {!stuck && lines.length > 0 && (
        <button className="log-jump" onClick={() => { setStuck(true); endRef.current?.scrollIntoView({ block: "end" }); }}>Jump to latest</button>
      )}
    </div>
    </>
  );
}
