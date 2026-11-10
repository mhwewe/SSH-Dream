// components/Modal.tsx — the ONE modal shell used by every dialog (prompt / choose / password / host key / conflict).
// What it adds over a bare <div>:
//   * role="dialog" + aria-modal + aria-labelledby, so screen readers announce it properly;
//   * focus moves INTO the dialog on open (the element marked data-autofocus, else the first control) and goes back to
//     where it was on close;
//   * Tab / Shift+Tab cycle inside the dialog (focus can never leak to the page behind it);
//   * Escape calls `onEscape` (when given). With several dialogs open only the TOPMOST one reacts.
// Mount it only while it should be visible, and give it a `key` that changes with the content (e.g. the prompt id) so
// focus is set again for the next queued dialog.
import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Open modals, oldest first. Only the last one handles the keyboard. */
const stack: symbol[] = [];

interface Props {
  title: string;
  onEscape?: () => void;
  /** Adds the red top bar used for dangerous confirmations. */
  danger?: boolean;
  children: ReactNode;
}

export function Modal({ title, onEscape, danger, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const escRef = useRef(onEscape);
  escRef.current = onEscape;

  useEffect(() => {
    const me = Symbol("modal");
    stack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      target.focus();
      if (target instanceof HTMLInputElement && target.type !== "checkbox") target.select();
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape" && escRef.current) {
        e.preventDefault();
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !ref.current.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !ref.current.contains(at))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return (
    <div className="dlg-backdrop">
      <div className={`dlg${danger ? " dlg-has-danger" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
