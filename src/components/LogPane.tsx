// LogPane.tsx — bottom log, Bitvise style: "HH:MM:SS.mmm  message" + icon per level.
// Data: store/logs.ts (subscribed to `session://log`). Auto-scrolls to the newest line.
import { useEffect, useRef } from "react";
import { useLogs } from "../store/logs";
import { useDragSize } from "../lib/useDragSize";

const pad = (n: number, l = 2) => String(n).padStart(l, "0");
function fmt(ts: string) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
const ICON = { info: "ℹ", warn: "⚠", error: "✖" } as const;

export function LogPane() {
  const { lines, clear } = useLogs();
  const endRef = useRef<HTMLDivElement>(null);
  // Drag the top edge to resize (up = taller). Remembered between runs.
  const [height, onResize] = useDragSize("logpane.height", 150, 60, () => Math.round(window.innerHeight * 0.7), "y", true);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  return (
    <>
    <div className="splitter-y" title="Drag to resize the log" onMouseDown={onResize} />
    <div className="logpane" style={{ height }}>
      <div className="logpane-head"><span>Log</span><button onClick={clear}>Clear</button></div>
      <div className="logpane-body">
        {lines.map((l) => (
          <div key={l.key} className={`logline log-${l.level}`}>
            <span className="log-ts">{fmt(l.ts)}</span>
            <span className="log-icon">{ICON[l.level]}</span>
            <span>{l.message}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
    </>
  );
}
