// lib/resolution.ts — the RDP "Resolution" text box. Mirrors rdp.rs `parse_resolution` (keep both in sync).
// Accepts "1920x1080", "1920 x 1080", "1920*1080", "1920×1080", "1920,1080"; blank = "let mstsc decide".
export const MIN_DIM = 200;
export const MAX_DIM = 8192;

/** `null` = blank/default, `false` = invalid, otherwise [width, height]. */
export function parseResolution(text: string): [number, number] | null | false {
  const t = text.trim();
  if (!t) return null;
  const m = /^(\d+)\s*[xX*×,]\s*(\d+)$/.exec(t);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const ok = (n: number) => n >= MIN_DIM && n <= MAX_DIM;
  return ok(w) && ok(h) ? [w, h] : false;
}

/** Suggestions for the text box's drop-down list. */
export const RESOLUTION_PRESETS = ["1280x720", "1366x768", "1600x900", "1920x1080", "2560x1440", "3840x2160"];
