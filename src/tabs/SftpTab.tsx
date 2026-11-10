// tabs/SftpTab.tsx — the "SFTP" tab: ONE remote pane + transfer queue (HANDOFF-3 §1/§5).
//
// NO local file browser (user decision). Local files come only from the native dialog (Upload…) or
// from a drop out of Windows Explorer. Downloads ask for a destination folder through the dialog.
//
// Props: `profile` = the profile selected in the switcher, `active` = this top-level tab is visible.
// Kept mounted by App.tsx (hidden with CSS) — all state lives in store/sftp.ts anyway, per profile.
//
// Used by: App.tsx.   Calls: store/sftp.ts, store/sessions.ts, components/sftp/*.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileEntry, Profile } from "../api/types";
import { useSessions } from "../store/sessions";
import { useSftp } from "../store/sftp";
import { useSftpPrefs, type Bookmark } from "../store/sftpPrefs";
import { parentRemote } from "../lib/paths";
import { dialogs } from "../store/dialogs";
import { toast } from "../store/toasts";
import { logLocal } from "../store/logs";
import { useDragSize } from "../lib/useDragSize";
import { FileTable } from "../components/sftp/FileTable";
import { TransferQueue } from "../components/sftp/TransferQueue";

/** Dialog results: string | string[] | null depending on options -> always string[]. */
const asPaths = (r: unknown): string[] => (Array.isArray(r) ? (r as string[]) : typeof r === "string" ? [r] : []);
const NO_BOOKMARKS: Bookmark[] = []; // stable reference, so the zustand selector does not re-render needlessly

export function SftpTab({ profile, active }: { profile: Profile | null; active: boolean }) {
  const profileId = profile?.id ?? null;
  const ps = useSessions((s) => (profileId ? s.byProfile[profileId] : undefined));
  const connect = useSessions((s) => s.connect);
  const pane = useSftp((s) => (profileId ? s.panes[profileId] : undefined));
  const allTransfers = useSftp((s) => s.transfers);
  const st = useSftp.getState; // actions are stable; read lazily to avoid re-render dependencies
  const bookmarks = useSftpPrefs((s) => (profileId ? s.profiles[profileId]?.bookmarks : undefined)) ?? NO_BOOKMARKS;
  const panelOpen = useSftpPrefs((s) => s.panelOpen);
  const prefs = useSftpPrefs.getState;

  const connected = ps?.state === "connected";
  const rows = useMemo(() => allTransfers.filter((t) => t.profileId === profileId), [allTransfers, profileId]);
  const selectedEntries = useMemo(
    () => (pane ? pane.entries.filter((e) => pane.selected.includes(e.path)) : []),
    [pane?.entries, pane?.selected],
  );

  // ---- lazy open: the first time the tab is shown for a connected profile --------------------
  useEffect(() => {
    if (active && connected && profileId) void st().ensureOpen(profileId);
  }, [active, connected, profileId, ps?.sessionId, pane?.sftpId]);

  // ---- editable path bar ---------------------------------------------------------------------
  const [pathText, setPathText] = useState("");
  useEffect(() => { setPathText(pane?.path ?? ""); }, [pane?.path, profileId]);

  // ---- Explorer drag & drop ------------------------------------------------------------------
  // Tauri reports the drop in PHYSICAL pixels; we only react when it lands on the file area
  // (data-sftp-drop), never on the toolbar or the transfer queue (HANDOFF-3 §8).
  const [dropHot, setDropHot] = useState(false);
  /** Remote path of the row whose name is being edited in place. */
  const [editPath, setEditPath] = useState<string | null>(null);
  /** Width of the bookmarks panel (drag its right edge). */
  const [bmWidth, bmResize] = useDragSize("sftp.bmWidth", 190, 110, 520, "x");
  /** Folder row under an Explorer drag (upload goes INTO it instead of the current folder). */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const latest = useRef({ profileId, ready: false });
  latest.current = { profileId, ready: !!pane?.sftpId };
  useEffect(() => {
    if (!active) return;
    let un: (() => void) | undefined;
    let gone = false;
    // The reported position is normally in physical pixels (divide by the display scale), but try the raw
    // value too so a different coordinate convention can never make every drop miss the list.
    const probe = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      for (const [x, y] of [[pos.x / dpr, pos.y / dpr], [pos.x, pos.y]]) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest("[data-sftp-drop]")) {
          return { inZone: true, dir: el.closest<HTMLElement>("[data-ft-dir]")?.dataset.ftDir ?? null };
        }
      }
      return { inZone: false, dir: null as string | null };
    };
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "leave") { setDropHot(false); setDropDir(null); return; }
        if (p.type === "enter") logLocal("info", "Files dragged over the window.");
        const { inZone, dir } = probe(p.position);
        if (p.type === "enter" || p.type === "over") {
          setDropHot(inZone && latest.current.ready);
          setDropDir(inZone && latest.current.ready ? dir : null);
          return;
        }
        // p.type === "drop"
        setDropHot(false);
        setDropDir(null);
        const { profileId: pid, ready } = latest.current;
        if (!inZone || !pid) { toast("Drop the files onto the file list", "error"); return; }
        if (!ready) { toast("Log in first", "error"); return; }
        logLocal("info", `Dropped ${p.paths.length} item(s); uploading to ${dir ?? "the current folder"}.`);
        // Dropped on a folder row -> into that folder; anywhere else in the list -> the current folder.
        if (p.paths.length) void st().upload(pid, p.paths, dir ?? undefined);
      })
      .then((f) => { if (gone) f(); else un = f; })
      .catch((e) => logLocal("error", `Drag & drop is unavailable: ${String(e)}`));
    return () => { gone = true; un?.(); };
  }, [active]);

  // ---- toolbar actions -----------------------------------------------------------------------
  async function uploadFiles() {
    if (!profileId) return;
    const r = await openDialog({ multiple: true, directory: false, title: "Select files to upload" });
    const paths = asPaths(r);
    if (paths.length) await st().upload(profileId, paths);
  }
  async function uploadFolder() {
    if (!profileId) return;
    const r = await openDialog({ multiple: true, directory: true, title: "Select folders to upload" });
    const paths = asPaths(r);
    if (paths.length) await st().upload(profileId, paths);
  }
  async function download() {
    if (!profileId || !selectedEntries.length) return;
    const r = await openDialog({ multiple: false, directory: true, title: "Choose the destination folder" });
    const folder = asPaths(r)[0];
    if (folder) await st().download(profileId, selectedEntries, folder);
  }
  // New folder: create "New folder" right away, then edit its name in place (whole name selected).
  async function newFolder() {
    if (!profileId || !pane?.sftpId) return;
    const taken = new Set(pane.entries.map((e) => e.name));
    let name = "New folder";
    for (let i = 2; taken.has(name); i++) name = `New folder (${i})`;
    const path = await st().mkdir(profileId, name);
    if (path) { st().setSelection(profileId, [path], path); setEditPath(path); }
  }
  function rename() {
    if (selectedEntries.length === 1) setEditPath(selectedEntries[0].path);
  }
  async function finishEdit(entry: FileEntry, newName: string | null) {
    setEditPath(null);
    const nn = newName?.trim();
    if (profileId && nn && nn !== entry.name) await st().rename(profileId, entry, nn);
  }
  // Ctrl+Shift+N anywhere in the SFTP tab.
  const newFolderRef = useRef(newFolder);
  newFolderRef.current = newFolder;
  useEffect(() => {
    if (!active || !connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newFolderRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, connected]);
  async function remove() {
    if (!profileId || !selectedEntries.length) return;
    const what = selectedEntries.length === 1 ? `"${selectedEntries[0].name}"` : `${selectedEntries.length} items`;
    const hasDir = selectedEntries.some((e) => e.isDir);
    const pick = await dialogs.choose(
      "Delete",
      `Delete ${what} from the server?${hasDir ? " Folders are deleted with everything inside them." : ""} This cannot be undone.`,
      ["Delete", "Cancel"],
    );
    if (pick === "Delete") await st().remove(profileId, selectedEntries);
  }
  // ---- bookmarks -----------------------------------------------------------------------------
  const isBookmarked = !!pane && bookmarks.some((b) => b.path === pane.path);
  function toggleBookmark() {
    if (!profileId || !pane?.path) return;
    if (isBookmarked) prefs().removeBookmark(profileId, pane.path);
    else prefs().addBookmark(profileId, pane.path);
  }
  async function renameBookmark(b: Bookmark) {
    if (!profileId) return;
    const name = await dialogs.prompt("Bookmark name", b.name);
    if (name) prefs().renameBookmark(profileId, b.path, name);
  }

  // ---- back / forward: buttons, Alt+Left / Alt+Right, and the mouse side buttons ---------------
  // WebView2 would otherwise treat these inputs as "browser history", so they are always cancelled.
  function onNavKey(e: ReactKeyboardEvent) {
    if (!profileId || !e.altKey || e.ctrlKey || e.shiftKey) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); void st().back(profileId); }
    else if (e.key === "ArrowRight") { e.preventDefault(); void st().forward(profileId); }
  }
  function onNavMouse(e: ReactMouseEvent) {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.type !== "mousedown" || !profileId) return; // act once, on PRESS
    void (e.button === 3 ? st().back(profileId) : st().forward(profileId));
  }

  function openEntry(e: FileEntry) {
    if (profileId && e.isDir) void st().navigate(profileId, e.path);
  }

  // ---- empty states --------------------------------------------------------------------------
  if (!profile) return <div className="placeholder">No profile selected.</div>;
  if (!connected) {
    const connecting = ps?.state === "connecting";
    return (
      <div className="sftp-empty">
        <p>Log in first to browse files.</p>
        <button disabled={connecting} onClick={() => void connect(profile.id)}>{connecting ? "Connecting…" : "Log in"}</button>
      </div>
    );
  }
  if (!pane || !pane.sftpId) {
    return (
      <div className="sftp-empty">
        {pane?.error ? (
          <>
            <p>Cannot open SFTP: {pane.error}</p>
            <button onClick={() => void st().ensureOpen(profile.id, true)}>Retry</button>
          </>
        ) : <p>Opening SFTP…</p>}
      </div>
    );
  }

  const ready = !!pane.sftpId;
  const canBack = pane.histIdx > 0;
  const canForward = pane.histIdx >= 0 && pane.histIdx < pane.history.length - 1;
  return (
    <div className="sftp" onKeyDown={onNavKey} onMouseDown={onNavMouse} onMouseUp={onNavMouse} onAuxClick={(e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }}>
      {/* Toolbar + path bar (a drop here must NOT start an upload). */}
      <div className="sftp-toolbar">
        <button className="sftp-nav" disabled={!canBack} aria-label="Back"
          title={canBack ? `Back to ${pane.history[pane.histIdx - 1]} (Alt+Left)` : "Back (Alt+Left)"}
          onMouseDown={(e) => { if (e.button === 0 && canBack) void st().back(profile.id); }}
          onClick={(e) => { if (e.detail === 0) void st().back(profile.id); /* keyboard activation only */ }}>◀</button>
        <button className="sftp-nav" disabled={!canForward} aria-label="Forward"
          title={canForward ? `Forward to ${pane.history[pane.histIdx + 1]} (Alt+Right)` : "Forward (Alt+Right)"}
          onMouseDown={(e) => { if (e.button === 0 && canForward) void st().forward(profile.id); }}
          onClick={(e) => { if (e.detail === 0) void st().forward(profile.id); /* keyboard activation only */ }}>▶</button>
        <button title="Up (Backspace). Drop items here to move them to the parent folder." data-ft-dir={parentRemote(pane.path)}
          onClick={() => void st().up(profile.id)}>⬆ Up</button>
        <button title="Refresh (F5)" onClick={() => void st().refresh(profile.id)}>⟳ Refresh</button>
        <button title="New folder (Ctrl+Shift+N)" onClick={() => void newFolder()}>New folder</button>
        <button disabled={selectedEntries.length !== 1} title="Rename (F2)" onClick={() => rename()}>Rename</button>
        <button disabled={!selectedEntries.length} title="Delete (Del)" onClick={() => void remove()}>Delete</button>
        <span className="sftp-sep" />
        <button disabled={!ready} onClick={() => void uploadFiles()}>Upload files…</button>
        <button disabled={!ready} onClick={() => void uploadFolder()}>Upload folder…</button>
        <button disabled={!selectedEntries.length} onClick={() => void download()}>Download</button>
        <span className="sftp-sep" />
        <button className={panelOpen ? "sftp-toggle on" : "sftp-toggle"} title="Show / hide the bookmarks panel"
          onClick={() => prefs().setPanelOpen(!panelOpen)}>★ Bookmarks</button>
      </div>
      <div className="sftp-pathbar">
        <button className={isBookmarked ? "sftp-star on" : "sftp-star"} aria-label="Bookmark this folder"
          title={isBookmarked ? "Remove this folder from bookmarks" : "Bookmark this folder"}
          onClick={toggleBookmark}>{isBookmarked ? "★" : "☆"}</button>
        <input
          value={pathText}
          spellCheck={false}
          onChange={(e) => setPathText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void st().navigate(profile.id, pathText);
            if (e.key === "Escape") setPathText(pane.path);
          }}
          onBlur={() => setPathText(pane.path)}
        />
        {pane.loading && <span className="sftp-loading">Loading…</span>}
      </div>

      <div className="sftp-split">
        {panelOpen && (
          <aside className="sftp-bm" aria-label="Bookmarks" style={{ width: bmWidth }}>
            <div className="sftp-bm-head">Bookmarks</div>
            <div className="sftp-bm-list">
              {bookmarks.length === 0 && (
                <div className="sftp-bm-empty">No bookmarks yet. Click ☆ next to the path to bookmark the current folder.</div>
              )}
              {bookmarks.map((b) => (
                <div
                  key={b.path}
                  role="button"
                  tabIndex={0}
                  className={`sftp-bm-item${b.path === pane.path ? " active" : ""}`}
                  title={`${b.path} (drop items here to move them into this folder)`}
                  data-ft-dir={b.path}
                  onClick={() => void st().navigate(profile.id, b.path)}
                  onKeyDown={(e) => { if (e.key === "Enter") void st().navigate(profile.id, b.path); }}
                >
                  <span className="sftp-bm-name">📁 {b.name}</span>
                  <button className="sftp-bm-act" title="Rename bookmark" aria-label="Rename bookmark"
                    onClick={(e) => { e.stopPropagation(); void renameBookmark(b); }}>✎</button>
                  <button className="sftp-bm-act" title="Remove bookmark" aria-label="Remove bookmark"
                    onClick={(e) => { e.stopPropagation(); prefs().removeBookmark(profile.id, b.path); }}>×</button>
                </div>
              ))}
            </div>
          </aside>
        )}
        {panelOpen && <div className="splitter-x" title="Drag to resize" onMouseDown={bmResize} />}

        {/* The ONLY drop target (the bookmarks panel and toolbar are outside it). */}
        <div className={`sftp-files${dropHot ? " drop-hot" : ""}`} data-sftp-drop>
          <FileTable
            entries={pane.entries}
            selected={pane.selected}
            anchor={pane.anchor}
            onSelect={(sel, anchor) => st().setSelection(profile.id, sel, anchor)}
            onOpen={openEntry}
            onUp={() => void st().up(profile.id)}
            onRefresh={() => void st().refresh(profile.id)}
            onRename={() => rename()}
            editPath={editPath}
            onEditDone={(en, name) => void finishEdit(en, name)}
            onDelete={() => void remove()}
            onMove={(entries, dest) => void st().move(profile.id, entries, dest)}
            dropDir={dropDir}
          />
          {dropHot && <div className="sftp-drop-hint">Drop to upload into {dropDir ?? pane.path}</div>}
        </div>
      </div>

      <TransferQueue
        rows={rows}
        onCancel={(id) => void st().cancel(id)}
        onClear={() => st().clearFinished(profile.id)}
      />
    </div>
  );
}
