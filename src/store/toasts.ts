// store/toasts.ts — tiny toast queue. `toast("text", "error")` from anywhere (also non-React code).
// Identical messages are merged into one toast with a counter ("×3") instead of stacking up; at most MAX_VISIBLE show at once.
// The auto-dismiss timer lives in components/Toasts.tsx (it pauses while the pointer is over a toast).
import { create } from "zustand";

export interface Toast { id: number; kind: "info" | "error" | "success"; text: string; count: number; stamp: number; }
const MAX_VISIBLE = 5;
let nextId = 1;

export const useToasts = create<{ toasts: Toast[]; remove: (id: number) => void }>((set) => ({
  toasts: [],
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(text: string, kind: Toast["kind"] = "info") {
  useToasts.setState((s) => {
    const same = s.toasts.find((t) => t.text === text && t.kind === kind);
    if (same) {
      // `stamp` changes -> the toast's timer starts again.
      return { toasts: s.toasts.map((t) => (t === same ? { ...t, count: t.count + 1, stamp: Date.now() } : t)) };
    }
    const next = [...s.toasts, { id: nextId++, kind, text, count: 1, stamp: Date.now() }];
    return { toasts: next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next };
  });
}
