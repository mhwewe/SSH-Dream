// lib/useDragSize.ts — a size (px) the user changes by dragging a splitter handle; remembered in localStorage.
// axis "x": width grows when dragging right (invert: grows when dragging left).
// collapseBelow > 0 makes the pane collapsible (size 0, remembered).
// axis "y": height grows when dragging down (invert: grows when dragging up — for a pane docked at the bottom).
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const read = (key: string, fallback: number) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback; // 0 = collapsed
  } catch { return fallback; }
};

export function useDragSize(key: string, initial: number, min: number, max: number | (() => number), axis: "x" | "y", invert = false, collapseBelow = 0) {
  const [size, setSize] = useState(() => read(key, initial));
  const cur = useRef(size);
  cur.current = size;

  function onMouseDown(e: ReactMouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const s0 = cur.current;
    let last = s0;
    const move = (ev: MouseEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - p0;
      const hi = typeof max === "function" ? max() : max;
      const raw = s0 + (invert ? -d : d);
      if (collapseBelow > 0) {
        // Collapsible: dragging below the threshold folds the pane to 0; dragging a collapsed pane open
        // makes it appear at the threshold size straight away.
        last = raw <= 0 ? 0 : raw < collapseBelow ? (s0 === 0 ? collapseBelow : 0) : Math.round(Math.min(hi, raw));
      } else {
        last = Math.round(Math.min(hi, Math.max(min, raw)));
      }
      setSize(last);
    };
    const cls = axis === "x" ? "resizing-x" : "resizing-y";
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove(cls);
      try { localStorage.setItem(key, String(last)); } catch { /* not persisted: fine */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.classList.add(cls);
  }
  return [size, onMouseDown] as const;
}
