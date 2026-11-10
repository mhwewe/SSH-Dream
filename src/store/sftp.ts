// store/sftp.ts — zustand store for the SFTP tab (HANDOFF-3 §5).
//
// Who uses it: tabs/SftpTab.tsx, components/sftp/*, App.tsx (init).
// What it calls: api/sftp.ts, store/sessions.ts (read-only: which session belongs to which profile).
//
// KEY IDEAS
//  * State is kept PER PROFILE (`panes[profileId]`), so switching profiles keeps each profile's remote
//    path, listing, selection and transfer queue (README §3 idea 2). The path is even kept after a
//    log-out, so logging in again returns to the same folder.
//  * The SFTP channel is opened lazily (first time the tab is shown for a connected profile).
//  * Transfers live in one flat list tagged with `profileId`; progress arrives through a Tauri Channel
//    created per transfer. Speed is computed here from successive events (smoothed).
//  * Conflicts (`transfer://conflict`) are queued globally and answered by components/sftp/ConflictDialog.
import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditEvent, FileEntry, TransferProgress } from "../api/types";
import * as api from "../api/sftp";
import { toAppError } from "../api/invoke";
import { useSessions } from "./sessions";
import { useSftpPrefs as usePrefs } from "./sftpPrefs";
import { toast } from "./toasts";
import { dialogs } from "./dialogs";
import { baseName, joinLocal, joinRemote, parentRemote } from "../lib/paths";

export interface Pane {
  sftpId: string | null;
  /** Session the sftpId belongs to (to detect a re-login). */
  sessionId: string | null;
  path: string;
  entries: FileEntry[];
  /** Selected entry PATHS. */
  selected: string[];
  /** Shift-click anchor (a path). */
  anchor: string | null;
  loading: boolean;
  opening: boolean;
  /** Set when opening SFTP failed (shown with a Retry button; stops the auto-open loop). */
  error: string | null;
  /** Visited folders (oldest first) for the Back/Forward buttons; `histIdx` is the current entry. */
  history: string[];
  histIdx: number;
}

export interface TransferRow extends TransferProgress {
  profileId: string;
  /** Smoothed bytes/second. */
  speed: number;
  lastBytes: number;
  lastTs: number;
}

export interface ConflictReq { transferId: string; path: string; }

const emptyPane = (): Pane => ({
  sftpId: null, sessionId: null, path: "", entries: [], selected: [], anchor: null,
  loading: false, opening: false, error: null, history: [], histIdx: -1,
});

const MAX_ROWS = 500;
/** `error` value of a drag row that Explorer never read (drop target without virtual-file support, or Esc): the row is
 *  removed instead of showing "Cancelled". Keep in sync with `UNUSED` in src-tauri/src/sftp/dragprogress.rs. */
const DRAG_UNUSED = "drag-unused";
const MAX_HISTORY = 100;
let started = false;
const navSeq: Record<string, number> = {};
const refreshTimers: Record<string, number> = {};
/** Remote item -> its copy in the temp folder (see prepareDrag). */
const dragCache = new Map<string, string>();

interface SftpStore {
  panes: Record<string, Pane>;
  transfers: TransferRow[];
  conflicts: ConflictReq[];

  init: () => void;
  paneOf: (profileId: string | null) => Pane | null;

  ensureOpen: (profileId: string, force?: boolean) => Promise<void>;
  /** Resolves true when the folder was listed (false: error toast shown / superseded).
   *  mode "push" (default) records the folder in the Back/Forward history; "keep" does not. */
  navigate: (profileId: string, path: string, mode?: "push" | "keep") => Promise<boolean>;
  refresh: (profileId: string) => Promise<void>;
  up: (profileId: string) => Promise<void>;
  back: (profileId: string) => Promise<void>;
  forward: (profileId: string) => Promise<void>;
  setSelection: (profileId: string, selected: string[], anchor: string | null) => void;

  /** Resolves with the new folder's path (null when it could not be created). */
  mkdir: (profileId: string, name: string) => Promise<string | null>;
  rename: (profileId: string, entry: FileEntry, newName: string) => Promise<void>;
  remove: (profileId: string, entries: FileEntry[]) => Promise<void>;

  /** `destDir` = remote folder to upload into (default: the folder currently shown). */
  upload: (profileId: string, localPaths: string[], destDir?: string) => Promise<void>;
  /** Move remote items into another remote folder (drag & drop inside the file list). */
  move: (profileId: string, entries: FileEntry[], destDir: string) => Promise<void>;
  download: (profileId: string, entries: FileEntry[], localFolder: string) => Promise<void>;
  /** "Open" a remote FILE: it is fetched to a temp folder, opened in its default Windows app, and every save in that
   *  app is uploaded back to the server (backend: sftp/edit.rs). Progress / conflicts come back as toasts + a dialog. */
  openInDefaultApp: (profileId: string, entry: FileEntry) => Promise<void>;
  /** Download items into a temp folder so they can be dragged out into Explorer. Resolves their local paths
   *  (null when a download failed). Items already fetched earlier (same size + date) are reused. */
  prepareDrag: (profileId: string, entries: FileEntry[]) => Promise<string[] | null>;
  /** Virtual-file drag-out, step 1 (see api/sftp.ts). Rejects with an AppError. */
  planDrag: (profileId: string, entries: FileEntry[]) => Promise<api.DragFile[]>;
  /** Virtual-file drag-out, step 2: Windows' drag loop; resolves when the drag ends. While Explorer copies, one row per
   *  dragged item shows in the Transfers list (progress comes from the backend, like a Download). */
  startVirtualDrag: (profileId: string, files: api.DragFile[]) => Promise<void>;
  cancel: (transferId: string) => Promise<void>;
  clearFinished: (profileId: string) => void;
  answerConflict: (action: api.ConflictAction, applyToAll: boolean) => Promise<void>;
}

function patchPane(profileId: string, patch: Partial<Pane>) {
  useSftp.setState((s) => ({ panes: { ...s.panes, [profileId]: { ...(s.panes[profileId] ?? emptyPane()), ...patch } } }));
}

export const useSftp = create<SftpStore>((set, get) => ({
  panes: {},
  transfers: [],
  conflicts: [],

  // ---- one-time wiring ----------------------------------------------------------------------
  init: () => {
    if (started) return;
    started = true;

    // Backend: a transfer hit an existing destination file.
    void listen<ConflictReq>("transfer://conflict", (e) => {
      set((s) => ({ conflicts: [...s.conflicts, e.payload] }));
    });

    // Sessions: when a profile's session ends or changes, its SFTP handle is dead (the backend already
    // dropped it). Forget the handle but KEEP the path, so a new login returns to the same folder.
    useSessions.subscribe((s) => {
      const panes = get().panes;
      for (const [profileId, pane] of Object.entries(panes) as [string, Pane][]) {
        if (!pane.sftpId) continue;
        const ps = s.byProfile[profileId];
        const alive = ps && ps.state === "connected" && ps.sessionId === pane.sessionId;
        if (!alive) {
          patchPane(profileId, { sftpId: null, sessionId: null, entries: [], selected: [], anchor: null, loading: false, opening: false });
          // Rows that never got their final event: show them as failed, not as "running" forever.
          set((st) => ({
            transfers: st.transfers.map((t) =>
              t.profileId === profileId && (t.state === "queued" || t.state === "running")
                ? { ...t, state: "error" as const, error: t.error ?? "Disconnected", speed: 0 }
                : t,
            ),
          }));
        }
      }
    });
  },

  paneOf: (profileId) => (profileId ? get().panes[profileId] ?? null : null),

  // ---- open / browse ------------------------------------------------------------------------
  async ensureOpen(profileId, force = false) {
    const ps = useSessions.getState().byProfile[profileId];
    if (!ps || ps.state !== "connected" || !ps.sessionId) return;
    const pane = get().panes[profileId] ?? emptyPane();
    if (pane.opening) return;
    if (pane.sftpId && pane.sessionId === ps.sessionId) return;
    if (pane.error && !force) return;

    patchPane(profileId, { opening: true, error: null });
    try {
      // The prefs file must be read before we pick the start folder (it holds the last folder of the previous run).
      await usePrefs.getState().load();
      const sftpId = await api.sftpOpen(ps.sessionId);
      // Start folder: this run's last folder, else the folder saved by the previous run, else home.
      const remembered = get().panes[profileId]?.path || usePrefs.getState().lastPathOf(profileId);
      const home = await api.sftpHome(sftpId);
      const start = remembered || home;
      patchPane(profileId, { sftpId, sessionId: ps.sessionId, opening: false });
      // The remembered folder may have been deleted meanwhile: fall back to home, then to the root.
      if (!(await get().navigate(profileId, start))) {
        if (start !== home && (await get().navigate(profileId, home))) return;
        if (start !== "/" && home !== "/") await get().navigate(profileId, "/");
      }
    } catch (e) {
      patchPane(profileId, { opening: false, error: toAppError(e).message });
    }
  },

  async navigate(profileId, path, mode = "push") {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) return false;
    const target = path.trim() || "/";
    const seq = (navSeq[profileId] = (navSeq[profileId] ?? 0) + 1);
    patchPane(profileId, { loading: true });
    try {
      const entries = await api.sftpList(pane.sftpId, target);
      if (navSeq[profileId] !== seq) return false; // a newer navigation won
      // History: a normal navigation drops everything "forward" of the current entry and appends the
      // new folder (skipped when it equals the current entry, e.g. Refresh). Back/Forward use "keep".
      const cur = get().panes[profileId] ?? pane;
      let { history, histIdx } = cur;
      if (mode === "push" && history[histIdx] !== target) {
        history = [...history.slice(0, histIdx + 1), target].slice(-MAX_HISTORY);
        histIdx = history.length - 1;
      }
      patchPane(profileId, { path: target, entries, selected: [], anchor: null, loading: false, history, histIdx });
      usePrefs.getState().setLastPath(profileId, target); // remembered for the next app start
      return true;
    } catch (e) {
      if (navSeq[profileId] !== seq) return false;
      const err = toAppError(e);
      patchPane(profileId, { loading: false });
      if (err.code === "not_found" && /SFTP view|session/i.test(err.message)) {
        // The backend lost this SFTP channel: drop it so the tab reopens it.
        patchPane(profileId, { sftpId: null, sessionId: null });
      } else {
        toast(`${target}: ${err.message}`, "error");
      }
      return false;
    }
  },

  refresh: async (profileId) => {
    const pane = get().panes[profileId];
    if (pane?.sftpId) await get().navigate(profileId, pane.path || "/");
  },

  up: async (profileId) => {
    const pane = get().panes[profileId];
    if (pane?.sftpId) await get().navigate(profileId, parentRemote(pane.path));
  },

  // Back/Forward: the history index moves immediately (so two quick clicks go two steps) and is put back
  // if the folder can no longer be listed.
  back: (profileId) => stepHistory(profileId, -1),
  forward: (profileId) => stepHistory(profileId, +1),

  setSelection: (profileId, selected, anchor) => patchPane(profileId, { selected, anchor }),

  // ---- changes ------------------------------------------------------------------------------
  async mkdir(profileId, name) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId || !name.trim()) return null;
    const path = joinRemote(pane.path, name.trim());
    let ok = true;
    try { await api.sftpMkdir(pane.sftpId, path); }
    catch (e) { toast(toAppError(e).message, "error"); ok = false; }
    await get().refresh(profileId);
    return ok ? path : null;
  },

  async rename(profileId, entry, newName) {
    const pane = get().panes[profileId];
    const nn = newName.trim();
    if (!pane?.sftpId || !nn || nn === entry.name) return;
    const to = joinRemote(pane.path, nn);
    let ok = true;
    try { await api.sftpRename(pane.sftpId, entry.path, to); }
    catch (e) { toast(toAppError(e).message, "error"); ok = false; }
    await get().refresh(profileId);
    // The refresh clears the selection: keep the renamed (or, on failure, the original) item selected.
    const keep = ok ? to : entry.path;
    get().setSelection(profileId, [keep], keep);
  },

  async remove(profileId, entries) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) return;
    for (const en of entries) {
      try { await api.sftpRemove(pane.sftpId, en.path); }
      catch (e) { toast(`${en.name}: ${toAppError(e).message}`, "error"); }
    }
    await get().refresh(profileId);
  },

  // ---- transfers ----------------------------------------------------------------------------
  async upload(profileId, localPaths, destDir) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) { toast("Log in first", "error"); return; }
    const dir = destDir ?? pane.path;
    for (const lp of localPaths) {
      await startTransfer(profileId, pane.sftpId, "upload", lp, joinRemote(dir, baseName(lp)));
    }
  },

  async move(profileId, entries, destDir) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) return;
    const dest = destDir.replace(/\/+$/, "") || "/";
    let moved = 0;
    for (const en of entries) {
      const to = joinRemote(dest, en.name);
      if (to === en.path) continue; // already in that folder
      const self = en.path.replace(/\/+$/, "");
      if (en.isDir && (dest === self || dest.startsWith(self + "/"))) {
        toast(`Cannot move "${en.name}" into itself`, "error");
        continue;
      }
      try { await api.sftpRename(pane.sftpId, en.path, to); moved++; }
      catch (e) { toast(`${en.name}: ${toAppError(e).message}`, "error"); }
    }
    if (moved) toast(`Moved ${moved} item${moved === 1 ? "" : "s"} to ${dest}`);
    await get().refresh(profileId);
  },

  async download(profileId, entries, localFolder) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) return;
    for (const en of entries) {
      await startTransfer(profileId, pane.sftpId, "download", joinLocal(localFolder, en.name), en.path);
    }
  },

  async openInDefaultApp(profileId, entry) {
    const sftpId = get().panes[profileId]?.sftpId;
    if (!sftpId) { toast("Log in first", "error"); return; }
    if (entry.isDir) return;
    const ch = new Channel<EditEvent>();
    ch.onmessage = (ev) => { void handleEditEvent(ev); };
    try { await api.sftpEditOpen(sftpId, entry.path, ch); }
    catch (e) { toast(`${entry.name}: ${toAppError(e).message}`, "error"); }
  },

  planDrag(profileId, entries) {
    const sftpId = get().panes[profileId]?.sftpId;
    if (!sftpId) return Promise.reject({ code: "not_found", message: "This SFTP view is not open (log in again)." });
    return api.dragPlan(sftpId, entries.map((e) => e.path));
  },

  async startVirtualDrag(profileId, files) {
    const sftpId = get().panes[profileId]?.sftpId;
    if (!sftpId) throw { code: "not_found", message: "This SFTP view is not open (log in again)." };
    const ch = new Channel<TransferProgress>();
    ch.onmessage = (p) => {
      if (p.state === "cancelled" && p.error === DRAG_UNUSED) {
        // Nothing was copied (the drag ended somewhere that does not read virtual files): drop the row quietly.
        useSftp.setState((s) => ({ transfers: s.transfers.filter((t) => t.transferId !== p.transferId) }));
        return;
      }
      applyProgress(profileId, p);
    };
    await api.dragStart(sftpId, files, ch);
  },

  async prepareDrag(profileId, entries) {
    const pane = get().panes[profileId];
    if (!pane?.sftpId) return null;
    const sftpId = pane.sftpId;
    const out: string[] = [];
    let dir: string | null = null;
    for (const en of entries) {
      const key = `${sftpId}|${en.path}|${en.size}|${en.modified ?? ""}`;
      const hit = dragCache.get(key);
      if (hit) { out.push(hit); continue; }
      try { dir ??= await api.dragCacheDir(); }
      catch (e) { toast(toAppError(e).message, "error"); return null; }
      const local = joinLocal(dir, en.name);
      if (!(await transferAndWait(profileId, sftpId, local, en.path))) return null;
      dragCache.set(key, local);
      out.push(local);
    }
    return out;
  },

  async cancel(transferId) {
    try { await api.transferCancel(transferId); } catch (e) { toast(toAppError(e).message, "error"); }
  },

  clearFinished: (profileId) =>
    set((s) => ({
      transfers: s.transfers.filter(
        (t) => t.profileId !== profileId || t.state === "queued" || t.state === "running",
      ),
    })),

  async answerConflict(action, applyToAll) {
    const [head, ...rest] = get().conflicts;
    if (!head) return;
    set({ conflicts: applyToAll ? [] : rest });
    const targets = applyToAll ? [head, ...rest] : [head];
    for (const c of targets) {
      try { await api.transferResolve(c.transferId, action, c === head ? applyToAll : false); }
      catch { /* the transfer may have been cancelled meanwhile */ }
    }
  },
}));

// ---- helpers (module-private) ------------------------------------------------------------------

async function stepHistory(profileId: string, delta: -1 | 1) {
  const pane = useSftp.getState().panes[profileId];
  if (!pane?.sftpId) return;
  const to = pane.histIdx + delta;
  if (to < 0 || to >= pane.history.length) return;
  patchPane(profileId, { histIdx: to });
  const ok = await useSftp.getState().navigate(profileId, pane.history[to], "keep");
  // Failed (folder deleted / no permission): go back to where we were — unless the user has moved on.
  if (!ok && useSftp.getState().panes[profileId]?.histIdx === to && !navSuperseded(profileId)) {
    patchPane(profileId, { histIdx: pane.histIdx });
  }
}

/** True while a newer navigation than the one we just awaited is still running. */
function navSuperseded(profileId: string) {
  return !!useSftp.getState().panes[profileId]?.loading;
}

async function startTransfer(
  profileId: string,
  sftpId: string,
  direction: "upload" | "download",
  localPath: string,
  remotePath: string,
) {
  const ch = new Channel<TransferProgress>();
  ch.onmessage = (p) => applyProgress(profileId, p);
  try {
    await api.transferStart(sftpId, direction, localPath, remotePath, ch);
  } catch (e) {
    toast(toAppError(e).message, "error");
  }
}

/** One download that resolves when it is finished (true = done). It also shows up in the Transfers list. */
function transferAndWait(profileId: string, sftpId: string, localPath: string, remotePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ch = new Channel<TransferProgress>();
    ch.onmessage = (p) => {
      applyProgress(profileId, p);
      if (p.state === "done") resolve(true);
      else if (p.state === "error" || p.state === "cancelled") resolve(false);
    };
    api.transferStart(sftpId, "download", localPath, remotePath, ch).catch((e) => {
      toast(toAppError(e).message, "error");
      resolve(false);
    });
  });
}

function applyProgress(profileId: string, p: TransferProgress) {
  const now = performance.now();
  const finished = p.state === "done" || p.state === "error" || p.state === "cancelled";
  useSftp.setState((s) => {
    const i = s.transfers.findIndex((t) => t.transferId === p.transferId);
    let rows: TransferRow[];
    if (i < 0) {
      rows = [...s.transfers, { ...p, profileId, speed: 0, lastBytes: p.bytesDone, lastTs: now }];
      if (rows.length > MAX_ROWS) {
        // Drop the oldest FINISHED rows first; never drop a live one.
        const drop = rows.length - MAX_ROWS;
        let dropped = 0;
        rows = rows.filter((t) => !(dropped < drop && t.state !== "queued" && t.state !== "running" && ++dropped));
      }
    } else {
      const prev = s.transfers[i];
      const dt = (now - prev.lastTs) / 1000;
      let speed = prev.speed;
      let lastBytes = prev.lastBytes;
      let lastTs = prev.lastTs;
      if (dt >= 0.25) {
        const inst = Math.max(0, (p.bytesDone - prev.lastBytes) / dt);
        speed = prev.speed ? prev.speed * 0.6 + inst * 0.4 : inst; // light smoothing
        lastBytes = p.bytesDone;
        lastTs = now;
      }
      rows = s.transfers.slice();
      rows[i] = { ...prev, ...p, profileId, speed: finished ? 0 : speed, lastBytes, lastTs };
    }
    // A cancelled/failed transfer can no longer be waiting for a conflict answer.
    const conflicts = finished ? s.conflicts.filter((c) => c.transferId !== p.transferId) : s.conflicts;
    return { transfers: rows, conflicts };
  });

  // After an upload finished, refresh the listing (debounced: a 2,000-file batch refreshes once).
  if (p.state === "done" && p.direction === "upload") {
    window.clearTimeout(refreshTimers[profileId]);
    refreshTimers[profileId] = window.setTimeout(() => void useSftp.getState().refresh(profileId), 400);
  }
}

// ---- "Open in default app": reacting to the backend's edit events (src-tauri/src/sftp/edit.rs) -------------------------
// Every state becomes a toast; "conflict" (the server copy changed while the file was open) asks the user and answers the backend.
async function handleEditEvent(ev: EditEvent) {
  const name = ev.fileName;
  switch (ev.state) {
    case "downloading": toast(`Opening "${name}"…`); break;
    case "opened": toast(ev.message ?? `Opened "${name}". Saving it in the app uploads it to the server.`); break;
    case "uploading": break; // too short-lived for a toast; the Log pane has the outcome
    case "saved": toast(`Saved "${name}" to the server`, "success"); break;
    case "skipped": toast(ev.message ?? `"${name}": not uploaded`); break;
    case "stopped": toast(`"${name}": ${ev.message ?? "stopped watching for saves"}`); break;
    case "error": toast(`"${name}": ${ev.message ?? "something went wrong"}`, "error"); break;
    case "conflict": {
      // The overwrite button is the dangerous one (Dialogs.tsx): focus + Esc land on "Keep server copy".
      const pick = await dialogs.choose(
        "File changed on the server",
        `${ev.message ?? `"${name}" was changed on the server.`} Overwrite the server copy with your edited version, or keep the server copy and not upload this save?`,
        ["Overwrite server copy", "Keep server copy"],
      );
      try { await api.sftpEditResolve(ev.editId, pick === "Overwrite server copy"); }
      catch (e) { toast(toAppError(e).message, "error"); }
      break;
    }
  }
}
