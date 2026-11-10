// store/logs.ts — Log pane data. Subscribes ONCE to `session://log` (README §5.3). Max 1000 lines.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { LogEvent } from "../api/types";

export interface LogLine extends LogEvent { key: number; }
const MAX_LINES = 1000;
let counter = 0;
let started = false;

export const useLogs = create<{ lines: LogLine[]; clear: () => void }>((set) => ({
  lines: [],
  clear: () => set({ lines: [] }),
}));

/** Frontend-originated log line (same format as backend events). Never pass secrets. */
export function logLocal(level: LogEvent["level"], message: string) {
  push({ sessionId: null, ts: new Date().toISOString(), level, message });
}

function push(ev: LogEvent) {
  useLogs.setState((s) => {
    const lines = [...s.lines, { ...ev, key: counter++ }];
    return { lines: lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines };
  });
}

export function initLogListener() {
  if (started) return;
  started = true;
  void listen<LogEvent>("session://log", (e) => push(e.payload));
}
