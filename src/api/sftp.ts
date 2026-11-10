// api/sftp.ts — typed wrappers for the SFTP + transfer commands (README §5.2, Handoff 3).
//
// Who uses it: store/sftp.ts ONLY (components never call the backend directly).
// Rule (README §3): one file per domain, no logic here. Every call goes through `call`, so
// rejections are normalized to AppError { code, message }.
import type { Channel } from "@tauri-apps/api/core";
import { call } from "./invoke";
import type { FileEntry, TransferProgress } from "./types";

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

export const transferCancel = (transferId: string) => call<void>("transfer_cancel", { transferId });
export const transferResolve = (transferId: string, action: ConflictAction, applyToAll: boolean) =>
  call<void>("transfer_resolve", { transferId, action, applyToAll });
