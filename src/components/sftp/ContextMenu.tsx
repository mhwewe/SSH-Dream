// components/sftp/ContextMenu.tsx — a small right-click menu (fixed position, kept inside the window).
// Used by: tabs/SftpTab.tsx (file rows, empty area of the file list, bookmarks).
//
// Mouse: closes on choosing an item, a click anywhere else, scrolling/resizing, or the window losing focus.
// Keyboard (polish): focus moves into the menu when it opens (first enabled item) and returns to where it was on
//   close; Up / Down move between items (wrapping, disabled items and separators are skipped), Home / End jump to the
//   first / last item, Enter or Space activates, Esc closes, Tab closes (focus goes back to the page).
// Accessibility: role="menu" + aria-orientation, role="menuitem" (aria-disabled when disabled), role="separator".
// The `onClose` prop may be a NEW function on every render (SftpTab passes an inline arrow): it is read through a ref so
// the window listeners are registered only once per open menu instead of being torn down and re-added on every render.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { separator: true }
  | { label: string; hint?: string; disabled?: boolean; danger?: boolean; onClick: () => void; separator?: false };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Keep the menu fully inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, items.length]);

  // Focus management: remember who had the focus, move it to the first enabled item, give it back on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    return () => { if (previous && document.contains(previous)) previous.focus({ preventScroll: true }); };
  }, []);

  // Close rules + keyboard navigation. Registered once; always calls the latest onClose.
  useEffect(() => {
    const close = () => closeRef.current();
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => {
      const enabled = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
      const at = enabled.indexOf(document.activeElement as HTMLElement);
      const focusAt = (i: number) => { e.preventDefault(); e.stopPropagation(); enabled[(i + enabled.length) % enabled.length]?.focus({ preventScroll: true }); };
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "Tab") close();
      else if (e.key === "ArrowDown") focusAt(at + 1);          // at = -1 (nothing focused) -> first item
      else if (e.key === "ArrowUp") focusAt(at < 0 ? -1 : at - 1); // nothing focused -> last item
      else if (e.key === "Home") focusAt(0);
      else if (e.key === "End") focusAt(enabled.length - 1);
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, []);

  return (
    <div className="ctx" ref={ref} style={pos} role="menu" aria-orientation="vertical" onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            className={`ctx-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            onClick={() => { closeRef.current(); it.onClick(); }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
