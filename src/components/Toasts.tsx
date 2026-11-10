// Toasts.tsx — renders the queue from store/toasts.ts (bottom-right). Click to dismiss.
import { useToasts } from "../store/toasts";

export function Toasts() {
  const { toasts, remove } = useToasts();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => remove(t.id)}>{t.text}</div>
      ))}
    </div>
  );
}
