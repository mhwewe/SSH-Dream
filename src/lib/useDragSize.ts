// lib/useDragSize.ts — a size (px) the user changes by dragging a splitter handle; remembered in localStorage.
// axis "x": width grows when dragging right (invert: grows when dragging left).
// axis "y": height grows when dragging down (invert: grows when dragging up — for a pane docked at the bottom).
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

const read = (key: string, fallback: number) => {
  try { const v = Number(localStorage.getItem(key)); return v > 0 ? v : fallback; } catch { return fallback; }
};

export function useDragSize(key: string, initial: number, min: number, max: number | (() => number), axis: "x" | "y", invert = false) {
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
      last = Math.round(Math.min(hi, Math.max(min, s0 + (invert ? -d : d))));
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
