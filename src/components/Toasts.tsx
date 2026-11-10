// Toasts.tsx — renders the queue from store/toasts.ts (bottom-right).
// Click or the × button dismisses; the timer pauses while the pointer is over a toast (so long errors can be read);
// errors are announced to screen readers (role="alert"), the rest politely.
// NOTE: ToastItem receives the STABLE `remove` function + the id (not a new `() => remove(id)` closure per render).
// A fresh closure would change the effect dependencies on every render and restart ALL toast timers whenever a
// new toast arrived, so old toasts would never expire while messages keep coming.
import { useEffect, useState } from "react";
import { useToasts, type Toast } from "../store/toasts";
import { IconAlert, IconCheck, IconClose, IconInfo } from "./icons";

function ToastItem({ t, remove }: { t: Toast; remove: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const id = t.id;
  const onClose = () => remove(id); // only used for the click handler below; the timer calls remove(id) directly
  useEffect(() => {
    if (paused) return;
    // Long messages stay longer: ~60 ms per character on top of the base time.
    const ms = (t.kind === "error" ? 7000 : 4000) + Math.min(t.text.length, 200) * 60;
    const timer = window.setTimeout(() => remove(id), ms);
    return () => window.clearTimeout(timer);
  }, [paused, t.stamp, t.kind, t.text, id, remove]);

  const Icon = t.kind === "error" ? IconAlert : t.kind === "success" ? IconCheck : IconInfo;
  return (
    <div className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <Icon size={16} className="toast-icon" />
      <span className="toast-text">{t.text}{t.count > 1 && <span className="toast-count"> ×{t.count}</span>}</span>
      <button className="toast-x" aria-label="Dismiss" title="Dismiss" onClick={onClose}><IconClose size={14} /></button>
    </div>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const remove = useToasts((s) => s.remove);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} t={t} remove={remove} />)}
    </div>
  );
}
