// lib/terminalTheme.ts — xterm colour themes. Dark = Windows Terminal "Campbell"; light = a readable light variant;
// latte = the official Catppuccin Latte terminal palette (https://catppuccin.com/palette).
// (xterm's `minimumContrastRatio` is set for the light theme in TerminalView so pale ANSI colours stay legible.)
import type { ITheme } from "@xterm/xterm";
import type { Resolved } from "../store/theme";

const dark: ITheme = {
  background: "#0c0c0c", foreground: "#cccccc", cursor: "#f2f2f2", cursorAccent: "#0c0c0c", selectionBackground: "#264f78",
  black: "#0c0c0c", red: "#c50f1f", green: "#13a10e", yellow: "#c19c00", blue: "#0037da", magenta: "#881798", cyan: "#3a96dd", white: "#cccccc",
  brightBlack: "#767676", brightRed: "#e74856", brightGreen: "#16c60c", brightYellow: "#f9f1a5", brightBlue: "#3b78ff", brightMagenta: "#b4009e", brightCyan: "#61d6d6", brightWhite: "#f2f2f2",
};
const light: ITheme = {
  background: "#fbfbfc", foreground: "#1f2328", cursor: "#1f2328", cursorAccent: "#fbfbfc", selectionBackground: "#b6d4f5",
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00", blue: "#0550ae", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01", brightBlue: "#0969da", brightMagenta: "#6639ba", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

// Catppuccin Latte: base #eff1f5 background, text #4c4f69, rosewater cursor, surface2 selection. ANSI colours follow the
// Catppuccin terminal mapping (black = subtext1, white = surface2, bright variants reuse the accent colours).
const latte: ITheme = {
  background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", cursorAccent: "#eff1f5", selectionBackground: "#acb0be",
  black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
  brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b", brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb", brightCyan: "#179299", brightWhite: "#bcc0cc",
};

export const termTheme = (r: Resolved): ITheme => (r === "dark" ? dark : r === "latte" ? latte : light);
// Light palettes get a minimum contrast ratio so pale ANSI colours stay readable; dark needs none.
export const termContrast = (r: Resolved) => (r === "dark" ? 1 : 4.5);
