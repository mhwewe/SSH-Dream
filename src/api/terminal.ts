// api/terminal.ts — typed wrappers for the terminal commands (README §5.2).
//
// Who uses it:  components/TerminalView.tsx.
// Output bytes arrive through a tauri `Channel` (ordered stream); input goes through term_write.

import { Channel, invoke } from "@tauri-apps/api/core";

/** Open a PTY + shell on a connected session. `onData` receives the raw output bytes. */
export function termOpen(
  sessionId: string,
  cols: number,
  rows: number,
  onData: Channel<number[]>,
): Promise<string> {
  return invoke<string>("term_open", { sessionId, cols, rows, onData });
}

export function termWrite(channelId: string, data: number[]): Promise<void> {
  return invoke<void>("term_write", { channelId, data });
}

export function termResize(channelId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("term_resize", { channelId, cols, rows });
}

export function termClose(channelId: string): Promise<void> {
  return invoke<void>("term_close", { channelId });
}

const encoder = new TextEncoder();

/** Convenience: send a text string (UTF-8 encoded) to the terminal. */
export function termWriteText(channelId: string, text: string): Promise<void> {
  return termWrite(channelId, Array.from(encoder.encode(text)));
}
