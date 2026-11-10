// =============================================================================
// api/types.ts — copy of README §5.1 contract types. KEEP IDENTICAL to the README.
// If the contract changes: change README first, then this file, then note in HANDOFF-LOG.md.
// =============================================================================

// ---- Profile (stored as <app_data>/profiles/<id>.json) ----
export interface Profile {
  schemaVersion: 1;
  id: string;
  name: string;
  ssh: {
    host: string;
    port: number;
    username: string;
    authMethod: "password" | "publickey";
    keyPath: string | null;
    storePassword: boolean;
    autoLogin: boolean;          // on app start: log in, open SFTP and open a terminal for this profile
  };
  rdp: {
    host: string | null;
    port: number;
    username: string | null;
    storePassword: boolean;
    fullscreen: boolean;
    resolution: string | null;   // "1920x1080"; null/"" = mstsc's own default size
    smartResize: boolean;        // true = resizing the RDP window resizes the remote desktop
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    termType: string;
  };
  createdAt: string;
  updatedAt: string;
}

// ---- Errors: every command rejects with this ----
export interface AppError { code: string; message: string; }

// ---- Sessions / logging ----
export type SessionState = "disconnected" | "connecting" | "connected" | "error";
export interface LogEvent { sessionId: string | null; ts: string; level: "info" | "warn" | "error"; message: string; }
export interface HostKeyPrompt {
  promptId: string; sessionId: string; host: string; port: number;
  algorithm: string; fingerprintSha256: string;
  status: "unknown" | "changed";
}

// ---- SFTP ----
export interface FileEntry {
  name: string; path: string; isDir: boolean; size: number;
  modified: string | null;
  permissions: string | null;
}
export interface TransferProgress {
  transferId: string; fileName: string; direction: "upload" | "download";
  bytesDone: number; bytesTotal: number;
  state: "queued" | "running" | "done" | "error" | "cancelled"; error?: string;
}
