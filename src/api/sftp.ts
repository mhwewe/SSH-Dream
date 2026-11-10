// api/sftp.ts — typed wrappers for the SFTP + transfer commands (README §5.2, Handoff 3).
//
// Who uses it: store/sftp.ts ONLY (components never call the backend directly).
// Rule (README §3): one file per domain, no logic here. Every call goes through `call`, so
// rejections are normalized to AppError { code, message }.
import type { Channel } from "@tauri-apps/api/core";
import { call } from "./invoke";
import type { EditEvent, FileEntry, TransferProgress } from "./types";

export type ConflictAction = "overwrite" | "skip" | "rename";

export const sftpOpen = (sessionId: string) => call<string>("sftp_open", { sessionId });
export const sftpClose = (sftpId: string) => call<void>("sftp_close", { sftpId });
export const sftpHome = (sftpId: string) => call<string>("sftp_home", { sftpId });
export const sftpList = (sftpId: string, path: string) => call<FileEntry[]>("sftp_list", { sftpId, path });
export const sftpMkdir = (sftpId: string, path: string) => call<void>("sftp_mkdir", { sftpId, path });
export const sftpRename = (sftpId: string, from: string, to: string) => call<void>("sftp_rename", { sftpId, from, to });
/** File, symlink or folder (folders are deleted recursively by the backend). */
export const sftpRemove = (sftpId: string, path: string) => call<void>("sftp_remove", { sftpId, path });

/**
 * Start one transfer (one file OR one folder). `localPath` / `remotePath` are the FULL paths of the
 * item on each side: for an upload the remote path already ends with the final name; for a download
 * the local path is <chosen folder>\<remote name>.
 */
export const transferStart = (
  sftpId: string,
  direction: "upload" | "download",
  localPath: string,
  remotePath: string,
  onProgress: Channel<TransferProgress>,
) => call<string>("transfer_start", { sftpId, direction, localPath, remotePath, onProgress });

/** A fresh temp folder for files about to be dragged out into Explorer. */
export const dragCacheDir = () => call<string>("drag_cache_dir");

// ---- Drag OUT to Explorer as "virtual files" (backend: src-tauri/src/sftp/dragout.rs) -------------------------
/** One file that will appear in Explorer. `relPath` is '/'-separated and relative to the drop folder. */
export interface DragFile { relPath: string; remotePath: string; size: number }
/** Step 1: flatten the dragged remote paths (folders are walked) into files. Call it when the drag BEGINS. */
export const dragPlan = (sftpId: string, remotePaths: string[]) =>
  call<DragFile[]>("sftp_drag_plan", { sftpId, remotePaths });
/** Step 2: start Windows' own drag. Resolves when the drag ends. The mouse button must still be held.
 *  `onProgress` receives the rows of the Transfers list (one per dragged item; same events as `transferStart`). */
export const dragStart = (sftpId: string, files: DragFile[], onProgress: Channel<TransferProgress>) =>
  call<void>("sftp_drag_start", { sftpId, files, onProgress });

export const transferCancel = (transferId: string) => call<void>("transfer_cancel", { transferId });
export const transferResolve = (transferId: string, action: ConflictAction, applyToAll: boolean) =>
  call<void>("transfer_resolve", { transferId, action, applyToAll });

// ---- Open in default app (backend: src-tauri/src/sftp/edit.rs) ---------------------------------------------------
/** Download the remote file to a temp folder, launch its default Windows app on it and upload every save back.
 *  Resolves with the editId once the app was launched; `onEvent` keeps reporting (uploading / saved / conflict ...). */
export const sftpEditOpen = (sftpId: string, remotePath: string, onEvent: Channel<EditEvent>) =>
  call<string>("sftp_edit_open", { sftpId, remotePath, onEvent });
/** Answer to an event with state "conflict": true = overwrite the server copy, false = keep it (this save is not uploaded). */
export const sftpEditResolve = (editId: string, overwrite: boolean) =>
  call<void>("sftp_edit_resolve", { editId, overwrite });
