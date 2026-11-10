// lib/paths.ts — the two tiny path helpers HANDOFF-3 §8 asks for, plus display formatters.
//   * REMOTE paths are always '/'-separated (POSIX).        -> joinRemote / parentRemote
//   * LOCAL paths are Windows paths (C:\...) from dialogs.   -> joinLocal / baseName
// Never mix the two.

/** "/home/me" + "a.txt" -> "/home/me/a.txt";  "/" + "a" -> "/a". */
export function joinRemote(dir: string, name: string): string {
  if (dir === "" || dir === "/") return "/" + name;
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

/** "/a/b/c" -> "/a/b";  "/a" -> "/";  "/" -> "/". */
export function parentRemote(p: string): string {
  const t = p.replace(/\/+$/, "");
  if (!t) return "/";
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

/** "C:\Users\me" + "x.txt" -> "C:\Users\me\x.txt" (keeps the separator style of `dir`). */
export function joinLocal(dir: string, name: string): string {
  if (dir.endsWith("\\") || dir.endsWith("/")) return dir + name;
  const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
  return dir + sep + name;
}

/** Last component of a LOCAL path (accepts both separators, ignores a trailing one). */
export function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  return t.slice(i + 1);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[u]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "";
}

/** Seconds left -> "0:42", "12:05", "1:02:05". Empty when unknown or absurd (more than a day). */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return "";
  const s = Math.max(1, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (x: number) => String(x).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** ISO-8601 -> "2026-11-09 14:03" (local time). */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
