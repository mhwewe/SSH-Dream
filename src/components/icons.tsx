// components/icons.tsx — ONE shared set of stroke icons (no emoji: emoji render differently on every Windows build
// and ignore the text colour, which breaks dark mode). All icons use `currentColor`.
// Used by: ActionBar, SftpTab, FileTable, TransferQueue, Toasts, LoginTab, TerminalTab, LogPane.
import type { ReactNode } from "react";
import type { FileEntry } from "../api/types";

export function Svg({ children, size = 18, className }: { children: ReactNode; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>
      {children}
    </svg>
  );
}
type P = { size?: number; className?: string };

// ---- left action bar --------------------------------------------------------------------------
export const IconSave = (p: P) => (
  <Svg {...p}><path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M8 3v5h7V3" /><rect x="7" y="13" width="10" height="8" /></Svg>
);
export const IconSaveAs = (p: P) => (
  <Svg {...p}><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z" /><path d="M13 3v6h6" /><path d="M12 12v6" /><path d="M9 15h6" /></Svg>
);
export const IconTerminal = (p: P) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3" /><path d="M13 15h4" /></Svg>
);
export const IconFolder = (p: P) => (
  <Svg {...p}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></Svg>
);
export const IconDesktop = (p: P) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6" /><path d="M12 16v4" /></Svg>
);
export const IconLogin = (p: P) => (
  <Svg {...p}><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" /><path d="M10 8l4 4-4 4" /><path d="M14 12H4" /></Svg>
);
export const IconLogout = (p: P) => (
  <Svg {...p}><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5" /><path d="M16 8l4 4-4 4" /><path d="M20 12H10" /></Svg>
);

// ---- theme ------------------------------------------------------------------------------------
export const IconSun = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></Svg>
);
export const IconAuto = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></Svg>
);
// Catppuccin Latte = a cup of coffee with steam.
export const IconCoffee = (p: P) => (
  <Svg {...p}><path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" /><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" /><path d="M7 3v2M10 3v2M13 3v2" /></Svg>
);
// Cogwheel: the Options button in the top right corner (App.tsx).
export const IconCog = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></Svg>
);

// ---- generic ----------------------------------------------------------------------------------
export const IconClose = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const IconPlus = (p: P) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>);
export const IconCheck = (p: P) => (<Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>);
export const IconChevronRight = (p: P) => (<Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>);
export const IconChevronDown = (p: P) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>);
export const IconInfo = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Svg>);
export const IconAlert = (p: P) => (<Svg {...p}><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18h.01" /></Svg>);
export const IconError = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></Svg>);
export const IconEye = (p: P) => (<Svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>);
export const IconEyeOff = (p: P) => (<Svg {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.9" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></Svg>);
export const IconCopy = (p: P) => (<Svg {...p}><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></Svg>);
export const IconTrash = (p: P) => (<Svg {...p}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></Svg>);
export const IconSearch = (p: P) => (<Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></Svg>);
export const IconStar = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" fill={filled ? "currentColor" : "none"} /></Svg>
);
export const IconRetry = (p: P) => (<Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Svg>);

// ---- SFTP toolbar -----------------------------------------------------------------------------
export const IconBack = (p: P) => (<Svg {...p}><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></Svg>);
export const IconForward = (p: P) => (<Svg {...p}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></Svg>);
export const IconUp = (p: P) => (<Svg {...p}><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></Svg>);
export const IconRefresh = (p: P) => (<Svg {...p}><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v6h-6" /></Svg>);
export const IconNewFolder = (p: P) => (
  <Svg {...p}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M12 11v5M9.5 13.5h5" /></Svg>
);
export const IconRename = (p: P) => (<Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Svg>);
export const IconUpload = (p: P) => (<Svg {...p}><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Svg>);
export const IconDownload = (p: P) => (<Svg {...p}><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></Svg>);
export const IconEyeHidden = IconEyeOff;
export const IconPencil = IconRename;

// ---- file type icons (16px, tinted by the .fi-* classes in sftp.css) ---------------------------
export type FileKind = "dir" | "image" | "archive" | "code" | "doc" | "audio" | "video" | "file";
const EXT: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", ico: "image", avif: "image",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", bz2: "archive", xz: "archive", "7z": "archive", rar: "archive", zst: "archive",
  js: "code", mjs: "code", cjs: "code", ts: "code", tsx: "code", jsx: "code", json: "code", py: "code", rb: "code", go: "code", rs: "code",
  c: "code", h: "code", cpp: "code", hpp: "code", java: "code", cs: "code", php: "code", sh: "code", bash: "code", zsh: "code", ps1: "code",
  html: "code", css: "code", scss: "code", yml: "code", yaml: "code", toml: "code", xml: "code", sql: "code", conf: "code", ini: "code",
  env: "code", service: "code", lua: "code", vue: "code",
  txt: "doc", md: "doc", pdf: "doc", log: "doc", doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", csv: "doc", ppt: "doc", pptx: "doc", rtf: "doc",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio", opus: "audio",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video", m4v: "video",
};
export function fileKind(e: Pick<FileEntry, "name" | "isDir">): FileKind {
  if (e.isDir) return "dir";
  const i = e.name.lastIndexOf(".");
  return i > 0 ? EXT[e.name.slice(i + 1).toLowerCase()] ?? "file" : "file";
}

export function EntryIcon({ entry }: { entry: Pick<FileEntry, "name" | "isDir"> }) {
  const kind = fileKind(entry);
  const cls = `fi fi-${kind}`;
  switch (kind) {
    case "dir":
      return <Svg size={16} className={cls}><path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity={0.22} /></Svg>;
    case "image":
      return <Svg size={16} className={cls}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 17l-5-5-9 8" /></Svg>;
    case "archive":
      return <Svg size={16} className={cls}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 3v6M10 6h4M10 12h4M10 15h4" /></Svg>;
    case "code":
      return <Svg size={16} className={cls}><path d="M9 7l-5 5 5 5" /><path d="M15 7l5 5-5 5" /></Svg>;
    case "audio":
      return <Svg size={16} className={cls}><path d="M9 18V6l10-2v12" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="16" r="2.5" /></Svg>;
    case "video":
      return <Svg size={16} className={cls}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.5v5l4.5-2.5z" /></Svg>;
    case "doc":
      return <Svg size={16} className={cls}><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 15h6" /></Svg>;
    default:
      return <Svg size={16} className={cls}><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" /><path d="M14 3v4h4" /></Svg>;
  }
}
