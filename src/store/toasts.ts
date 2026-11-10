// store/toasts.ts — tiny toast queue. `toast("text", "error")` from anywhere (also non-React code).
import { create } from "zustand";

export interface Toast { id: number; kind: "info" | "error" | "success"; text: string; }
let nextId = 1;

export const useToasts = create<{ toasts: Toast[]; remove: (id: number) => void }>((set) => ({
  toasts: [],
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => useToasts.getState().remove(id), kind === "error" ? 7000 : 4000);
}
