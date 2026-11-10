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
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import dragIcon from "../../src-tauri/icons/32x32.png?inline"; // data: URL, the plugin wants a PNG as base64
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileEntry, Profile } from "../api/types";
import type { DragFile } from "../api/sftp";
import { toAppError } from "../api/invoke";
import { useSessions } from "../store/sessions";
import { useSftp } from "../store/sftp";
import { useSftpPrefs, type Bookmark } from "../store/sftpPrefs";
import { formatBytes, parentRemote } from "../lib/paths";
import { dialogs } from "../store/dialogs";
import { toast } from "../store/toasts";
import { logLocal } from "../store/logs";
import { useDragSize } from "../lib/useDragSize";
import { FileTable } from "../components/sftp/FileTable";
import { TransferQueue } from "../components/sftp/TransferQueue";
import { ContextMenu, type MenuItem } from "../components/sftp/ContextMenu";
import {
  IconBack, IconDownload, IconEye, IconEyeOff, IconFolder, IconForward, IconNewFolder, IconRefresh, IconRename, IconStar,
  IconTrash, IconUp, IconUpload, IconClose, IconPencil,
} from "../components/icons";

/** Dialog results: string | string[] | null depending on options -> always string[]. */
const asPaths = (r: unknown): string[] => (Array.isArray(r) ? (r as string[]) : typeof r === "string" ? [r] : []);
const NO_BOOKMARKS: Bookmark[] = []; // stable reference, so the zustand selector does not re-render needlessly

/** "/srv/www/site" -> [{name:"/",path:"/"},{name:"srv",path:"/srv"},{name:"www",path:"/srv/www"},{name:"site",path:"/srv/www/site"}]. */
function crumbsOf(path: string): { name: string; path: string }[] {
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of path.split("/").filter(Boolean)) { acc += "/" + part; out.push({ name: part, path: acc }); }
  return out;
}

export function SftpTab({ profile, active }: { profile: Profile | null; active: boolean }) {
  const profileId = profile?.id ?? null;
  const ps = useSessions((s) => (profileId ? s.byProfile[profileId] : undefined));
  const connect = useSessions((s) => s.connect);
  const pane = useSftp((s) => (profileId ? s.panes[profileId] : undefined));
  const allTransfers = useSftp((s) => s.transfers);
  const st = useSftp.getState; // actions are stable; read lazily to avoid re-render dependencies
  const bookmarks = useSftpPrefs((s) => (profileId ? s.profiles[profileId]?.bookmarks : undefined)) ?? NO_BOOKMARKS;
  const panelOpen = useSftpPrefs((s) => s.panelOpen);
  const showHidden = useSftpPrefs((s) => s.showHidden);
  const prefs = useSftpPrefs.getState;

  const connected = ps?.state === "connected";
  const rows = useMemo(() => allTransfers.filter((t) => t.profileId === profileId), [allTransfers, profileId]);
  // "Show hidden files" off: names starting with "." are left out of the list (and of the selection).
  const visibleEntries = useMemo(
    () => (pane ? (showHidden ? pane.entries : pane.entries.filter((e) => !e.name.startsWith("."))) : []),
    [pane?.entries, showHidden],
  );
  const selectedEntries = useMemo(
    () => (pane ? visibleEntries.filter((e) => pane.selected.includes(e.path)) : []),
    [visibleEntries, pane?.selected],
  );

  // ---- lazy open: the first time the tab is shown for a connected profile --------------------
  useEffect(() => {
    if (active && connected && profileId) void st().ensureOpen(profileId);
  }, [active, connected, profileId, ps?.sessionId, pane?.sftpId]);

  // ---- editable path bar ---------------------------------------------------------------------
  const [pathText, setPathText] = useState("");
  useEffect(() => { setPathText(pane?.path ?? ""); }, [pane?.path, profileId]);
  // Path bar: breadcrumbs by default; click the empty part (or press Ctrl+L) to type a path.
  const [editingPath, setEditingPath] = useState(false);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (editingPath) pathInputRef.current?.select(); }, [editingPath]);
  useEffect(() => { const el = crumbsRef.current; if (el) el.scrollLeft = el.scrollWidth; }, [pane?.path, editingPath]);

  // ---- Explorer drag & drop ------------------------------------------------------------------
  // Tauri reports the drop in PHYSICAL pixels; we only react when it lands on the file area
  // (data-sftp-drop), never on the toolbar or the transfer queue (HANDOFF-3 §8).
  const [dropHot, setDropHot] = useState(false);
  /** Remote path of the row whose name is being edited in place. */
  const [editPath, setEditPath] = useState<string | null>(null);
  /** Open right-click menu: where, and for what (the items are rebuilt on every render from the live selection). */
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "row" | "bg" | "bm"; bm?: Bookmark } | null>(null);
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
  // Ctrl+Shift+N (new folder) and Ctrl+L (type a path) anywhere in the SFTP tab.
  const newFolderRef = useRef(newFolder);
  newFolderRef.current = newFolder;
  useEffect(() => {
    if (!active || !connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newFolderRef.current();
      } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setEditingPath(true); // like the address bar of Explorer
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
  // ---- drag OUT to Explorer ------------------------------------------------------------------
  // PRIMARY METHOD = Windows "virtual files" (backend: src-tauri/src/sftp/dragout.rs). Nothing is downloaded up
  // front: the drag starts at once and Explorer pulls the bytes straight from the server while it copies (its own
  // progress window + cancel button). No temp files, no size limit, folders work.
  //   1. `beginPlan` runs while the user starts dragging inside the window (files: at once; folders: when the
  //      pointer nears the window edge) -> a flat file list is ready in the background.
  //   2. `dragOut` runs when the pointer LEAVES the window (mouse button still down): waits for the plan, then
  //      starts Windows' own drag.
  // FALLBACK = `dragOutLegacy` (the old temp-folder download + tauri-plugin-drag). Used only if the primary method
  // fails to start for a technical reason (never for "too many files": that error is shown instead).
  // Known limit of the primary method: the drop target must understand virtual files (Explorer does; browser upload
  // areas and chat apps often do not -> use the Download button for those).
  // `at` = when the plan was made: a plan older than PLAN_TTL_MS is thrown away (the server folder may have changed).
  const planRef = useRef<{ key: string; promise: Promise<DragFile[]>; at: number } | null>(null);
  const PLAN_TTL_MS = 10_000;
  const freshPlan = (key: string) => (planRef.current && planRef.current.key === key && Date.now() - planRef.current.at < PLAN_TTL_MS ? planRef.current.promise : null);
  const planKey = (entries: FileEntry[]) => entries.map((e) => e.path).join("\n");

  function beginPlan(entries: FileEntry[], phase: "start" | "near-edge") {
    if (!profileId || !entries.length) return;
    const key = planKey(entries);
    if (freshPlan(key)) return; // already being prepared
    // Walking a big folder costs many SFTP round trips; do not do it for an ordinary move inside the window.
    if (phase === "start" && entries.some((e) => e.isDir)) return;
    const promise = st().planDrag(profileId, entries);
    promise.catch(() => { /* shown when dragOut awaits it; this only avoids an "unhandled rejection" */ });
    planRef.current = { key, promise, at: Date.now() };
  }

  async function dragOut(entries: FileEntry[], held: () => boolean) {
    if (!profileId) return;
    const key = planKey(entries);
    try {
      const plan = freshPlan(key) ?? st().planDrag(profileId, entries);
      const files = await plan;
      planRef.current = null;
      if (files.length === 0) { toast("Nothing to drag: the selected folders are empty.", "info"); return; }
      if (!held()) { toast("Hold the mouse button until you reach Explorer, then drag again.", "info"); return; }
      await st().startVirtualDrag(profileId, files);
      return;
    } catch (e) {
      planRef.current = null;
      const err = toAppError(e);
      // "invalid" = a rule of ours (e.g. too many files): tell the user, do NOT silently download everything instead.
      if (err.code === "invalid") { toast(err.message, "error"); return; }
      logLocal("warn", `Direct drag to Explorer failed (${err.message}). Using the temp-file method instead.`);
    }
    await dragOutLegacy(entries, held);
  }

  // The old method: the server's files do not exist on this PC, so they are downloaded to a temp folder first (the
  // progress shows in the Transfers list), then Windows' own drag starts. The mouse button has to still be held then.
  const MAX_DRAG_BYTES = 1024 * 1024 * 1024;
  async function dragOutLegacy(entries: FileEntry[], held: () => boolean) {
    if (!profileId) return;
    const bytes = entries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
    if (bytes > MAX_DRAG_BYTES) {
      toast(`Too big to drag out (${formatBytes(bytes)}). Use Download instead.`, "error");
      return;
    }
    const paths = await st().prepareDrag(profileId, entries);
    if (!paths) { toast("Could not fetch the files for dragging", "error"); return; }
    if (!held()) { toast("The files are ready - hold the mouse button until you reach Explorer, then drag again.", "info"); return; }
    try { await startDrag({ item: paths, icon: dragIcon }); }
    catch (e) { toast(`Drag to Explorer failed: ${String((e as { message?: string })?.message ?? e)}`, "error"); }
  }

  // ---- right-click menus ---------------------------------------------------------------------
  function copyText(text: string) {
    navigator.clipboard.writeText(text)
      .then(() => toast("Copied", "success"))
      .catch(() => toast("Could not copy to the clipboard", "error"));
  }
  async function uploadInto(dir: string) {
    if (!profileId) return;
    const paths = asPaths(await openDialog({ multiple: true, directory: false, title: `Select files to upload into ${dir}` }));
    if (paths.length) await st().upload(profileId, paths, dir);
  }
  function menuItems(): MenuItem[] {
    if (!menu || !pane || !profileId) return [];
    const sep: MenuItem = { separator: true };
    const bookmarkToggle = (path: string): MenuItem =>
      bookmarks.some((b) => b.path === path)
        ? { label: "Remove bookmark", onClick: () => prefs().removeBookmark(profileId, path) }
        : { label: "Bookmark this folder", onClick: () => prefs().addBookmark(profileId, path) };

    if (menu.kind === "bm" && menu.bm) {
      const b = menu.bm;
      return [
        { label: "Open", onClick: () => void st().navigate(profileId, b.path) },
        { label: "Rename bookmark…", onClick: () => void renameBookmark(b) },
        { label: "Remove bookmark", onClick: () => prefs().removeBookmark(profileId, b.path) },
        sep,
        { label: "Copy path", onClick: () => copyText(b.path) },
      ];
    }
    if (menu.kind === "row" && selectedEntries.length) {
      const one = selectedEntries.length === 1 ? selectedEntries[0] : null;
      const items: MenuItem[] = [];
      // Folder: go into it. File: open it in its default Windows app (saves are uploaded back to the server).
      if (one) items.push({ label: one.isDir ? "Open" : "Open in default app", hint: "Enter", onClick: () => openEntry(one) });
      items.push({ label: "Download…", onClick: () => void download() });
      if (one?.isDir) items.push({ label: "Upload files into this folder…", onClick: () => void uploadInto(one.path) });
      items.push(sep);
      items.push({ label: "Rename", hint: "F2", disabled: !one, onClick: () => rename() });
      items.push({ label: "Delete", hint: "Del", danger: true, onClick: () => void remove() });
      items.push(sep);
      items.push({
        label: one ? "Copy path" : "Copy paths",
        onClick: () => copyText(selectedEntries.map((e) => e.path).join("\n")),
      });
      if (one?.isDir) items.push(bookmarkToggle(one.path));
      items.push(sep);
      items.push({ label: "New folder", hint: "Ctrl+Shift+N", onClick: () => void newFolder() });
      items.push({ label: "Refresh", hint: "F5", onClick: () => void st().refresh(profileId) });
      return items;
    }
    return [
      { label: "New folder", hint: "Ctrl+Shift+N", onClick: () => void newFolder() },
      { label: "Upload files…", onClick: () => void uploadFiles() },
      { label: "Upload folder…", onClick: () => void uploadFolder() },
      sep,
      { label: "Refresh", hint: "F5", onClick: () => void st().refresh(profileId) },
      { label: "Copy current path", onClick: () => copyText(pane.path) },
      bookmarkToggle(pane.path),
    ];
  }

  // ---- bookmarks -----------------------------------------------------------------------------
  const isBookmarked = !!pane && bookmarks.some((b) => b.path === pane.path);
  function toggleBookmark() {
    if (!profileId || !pane?.path) return;
    if (isBookmarked) prefs().removeBookmark(profileId, pane.path);
    else prefs().addBookmark(profileId, pane.path);
  }
  // Folders dropped on the bookmarks panel are pinned (an already pinned folder is skipped).
  function pinDirs(dirs: FileEntry[]) {
    if (!profileId) return;
    const fresh = dirs.filter((d) => !bookmarks.some((b) => b.path === d.path));
    for (const d of fresh) prefs().addBookmark(profileId, d.path);
    if (fresh.length === 0) toast(dirs.length === 1 ? "Already in bookmarks" : "Already in bookmarks (all of them)", "info");
    else toast(fresh.length === 1 ? `Pinned ${fresh[0].name} to bookmarks` : `Pinned ${fresh.length} folders to bookmarks`, "success");
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

  // Double-click / Enter: a folder is entered; a file is opened in its default Windows app and every save in that app is
  // uploaded back to the server (store/sftp.ts openInDefaultApp -> backend sftp/edit.rs).
  function openEntry(e: FileEntry) {
    if (!profileId) return;
    if (e.isDir) void st().navigate(profileId, e.path);
    else void st().openInDefaultApp(profileId, e);
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
  const selBytes = selectedEntries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0);
  const hiddenCount = pane.entries.length - visibleEntries.length;
  const crumbs = crumbsOf(pane.path);
  const lbl = (t: string) => <span className="btn-label">{t}</span>;
  const goPath = () => { setEditingPath(false); void st().navigate(profile.id, pathText); };
  return (
    <div className="sftp" onContextMenu={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }} onKeyDown={onNavKey} onMouseDown={onNavMouse} onMouseUp={onNavMouse} onAuxClick={(e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }}>
      {/* Toolbar + path bar (a drop here must NOT start an upload). */}
      <div className="sftp-toolbar" role="toolbar" aria-label="SFTP actions">
        <button className="sftp-nav" disabled={!canBack} aria-label="Back"
          title={canBack ? `Back to ${pane.history[pane.histIdx - 1]} (Alt+Left)` : "Back (Alt+Left)"}
          onMouseDown={(e) => { if (e.button === 0 && canBack) void st().back(profile.id); }}
          onClick={(e) => { if (e.detail === 0) void st().back(profile.id); /* keyboard activation only */ }}><IconBack size={16} /></button>
        <button className="sftp-nav" disabled={!canForward} aria-label="Forward"
          title={canForward ? `Forward to ${pane.history[pane.histIdx + 1]} (Alt+Right)` : "Forward (Alt+Right)"}
          onMouseDown={(e) => { if (e.button === 0 && canForward) void st().forward(profile.id); }}
          onClick={(e) => { if (e.detail === 0) void st().forward(profile.id); /* keyboard activation only */ }}><IconForward size={16} /></button>
        <button title="Up (Backspace). Drop items here to move them to the parent folder." aria-label="Up" data-ft-dir={parentRemote(pane.path)}
          onClick={() => void st().up(profile.id)}><IconUp size={16} />{lbl("Up")}</button>
        <button title="Refresh (F5)" aria-label="Refresh" onClick={() => void st().refresh(profile.id)}><IconRefresh size={16} />{lbl("Refresh")}</button>
        <span className="sftp-sep" />
        <button title="New folder (Ctrl+Shift+N)" aria-label="New folder" onClick={() => void newFolder()}><IconNewFolder size={16} />{lbl("New folder")}</button>
        <button disabled={selectedEntries.length !== 1} title="Rename (F2)" aria-label="Rename" onClick={() => rename()}><IconRename size={16} />{lbl("Rename")}</button>
        <button disabled={!selectedEntries.length} title="Delete (Del)" aria-label="Delete" onClick={() => void remove()}><IconTrash size={16} />{lbl("Delete")}</button>
        <span className="sftp-sep" />
        <button disabled={!ready} title="Upload files…" aria-label="Upload files" onClick={() => void uploadFiles()}><IconUpload size={16} />{lbl("Upload files…")}</button>
        <button disabled={!ready} title="Upload folder…" aria-label="Upload folder" onClick={() => void uploadFolder()}><IconFolder size={16} />{lbl("Upload folder…")}</button>
        <button disabled={!selectedEntries.length} title="Download the selected items…" aria-label="Download" onClick={() => void download()}><IconDownload size={16} />{lbl("Download")}</button>
        <span className="sftp-sep" />
        <button className={showHidden ? "sftp-toggle on" : "sftp-toggle"} aria-pressed={showHidden}
          title={showHidden ? "Hidden files (names starting with a dot) are shown. Click to hide them." : "Hidden files are hidden. Click to show them."}
          aria-label="Show hidden files" onClick={() => prefs().setShowHidden(!showHidden)}>
          {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}{lbl("Hidden")}
        </button>
        <button className={panelOpen ? "sftp-toggle on" : "sftp-toggle"} aria-pressed={panelOpen} title="Show / hide the bookmarks panel"
          aria-label="Bookmarks panel" onClick={() => prefs().setPanelOpen(!panelOpen)}><IconStar size={16} filled={panelOpen} />{lbl("Bookmarks")}</button>
      </div>
      <div className="sftp-pathbar">
        <button className={isBookmarked ? "sftp-star on" : "sftp-star"} aria-label="Bookmark this folder" aria-pressed={isBookmarked}
          title={isBookmarked ? "Remove this folder from bookmarks" : "Bookmark this folder"}
          onClick={toggleBookmark}><IconStar size={16} filled={isBookmarked} /></button>
        {editingPath ? (
          <input
            ref={pathInputRef}
            className="sftp-pathinput"
            aria-label="Remote path"
            autoFocus
            value={pathText}
            spellCheck={false}
            onChange={(e) => setPathText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goPath();
              if (e.key === "Escape") { e.preventDefault(); setPathText(pane.path); setEditingPath(false); }
            }}
            onBlur={() => { setPathText(pane.path); setEditingPath(false); }}
          />
        ) : (
          <div className="crumbs" ref={crumbsRef} title="Click an empty part (or press Ctrl+L) to type a path"
            onClick={(e) => { if (e.target === e.currentTarget) setEditingPath(true); }}>
            <nav className="crumbs-nav" aria-label="Path">
              {crumbs.map((c, i) => (
                <span key={c.path} className="crumb-wrap">
                  {i > 1 && <span className="crumb-sep" aria-hidden="true">/</span>}
                  <button className={`crumb${i === crumbs.length - 1 ? " current" : ""}`} data-ft-dir={c.path}
                    aria-current={i === crumbs.length - 1 ? "page" : undefined}
                    title={`${c.path} (drop items here to move them into this folder)`}
                    onClick={() => void st().navigate(profile.id, c.path)}>{c.name}</button>
                </span>
              ))}
            </nav>
            <span className="crumbs-fill" onClick={() => setEditingPath(true)} />
          </div>
        )}
        {pane.loading && <span className="sftp-loading" role="status">Loading…</span>}
      </div>

      <div className="sftp-split">
        {panelOpen && (
          <aside className="sftp-bm" aria-label="Bookmarks" style={{ width: bmWidth }} data-ft-pin>
            <div className="sftp-bm-head">Bookmarks</div>
            <div className="sftp-bm-list">
              {bookmarks.length === 0 && (
                <div className="sftp-bm-empty">No bookmarks yet. Click the star next to the path, or drag a folder here, to bookmark it.</div>
              )}
              {bookmarks.map((b) => (
                <div
                  key={b.path}
                  role="button"
                  tabIndex={0}
                  className={`sftp-bm-item${b.path === pane.path ? " active" : ""}`}
                  title={`${b.path} (drop items here to move them into this folder)`}
                  data-ft-dir={b.path}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind: "bm", bm: b }); }}
                  onClick={() => void st().navigate(profile.id, b.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void st().navigate(profile.id, b.path);
                    else if (e.key === "Delete") prefs().removeBookmark(profile.id, b.path);
                    else if (e.key === "F2") void renameBookmark(b);
                  }}
                >
                  <span className="sftp-bm-name"><IconFolder size={14} className="fi fi-dir" /><span>{b.name}</span></span>
                  <button className="sftp-bm-act" title="Rename bookmark (F2)" aria-label="Rename bookmark"
                    onClick={(e) => { e.stopPropagation(); void renameBookmark(b); }}><IconPencil size={12} /></button>
                  <button className="sftp-bm-act" title="Remove bookmark (Del)" aria-label="Remove bookmark"
                    onClick={(e) => { e.stopPropagation(); prefs().removeBookmark(profile.id, b.path); }}><IconClose size={12} /></button>
                </div>
              ))}
            </div>
          </aside>
        )}
        {panelOpen && <div className="splitter-x" role="separator" aria-orientation="vertical" title="Drag to resize" onMouseDown={bmResize} />}

        {/* The ONLY drop target (the bookmarks panel and toolbar are outside it). */}
        <div className="sftp-main">
          <div className={`sftp-files${dropHot ? " drop-hot" : ""}`} data-sftp-drop>
            <FileTable
              entries={visibleEntries}
              emptyText={pane.entries.length > 0 && visibleEntries.length === 0 ? "Only hidden files here. Use the eye button in the toolbar to show them." : undefined}
              selected={pane.selected}
              anchor={pane.anchor}
              onSelect={(sel, anchor) => st().setSelection(profile.id, sel, anchor)}
              onOpen={openEntry}
              onUp={() => void st().up(profile.id)}
              onRefresh={() => void st().refresh(profile.id)}
              onRename={() => rename()}
              editPath={editPath}
              onDragOut={dragOut}
              onDragBegin={beginPlan}
              onContextMenu={(x, y, entry) => setMenu({ x, y, kind: entry ? "row" : "bg" })}
              onEditDone={(en, name) => void finishEdit(en, name)}
              onDelete={() => void remove()}
              onMove={(entries, dest) => void st().move(profile.id, entries, dest)}
              onPin={pinDirs}
              dropDir={dropDir}
            />
            {dropHot && <div className="sftp-drop-hint">Drop to upload into {dropDir ?? pane.path}</div>}
          </div>
          <div className="sftp-status" role="status">
            <span>
              {visibleEntries.length} item{visibleEntries.length === 1 ? "" : "s"}
              {!showHidden && hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
            </span>
            {selectedEntries.length > 0 && (
              <span>
                {selectedEntries.length} selected
                {selBytes > 0 ? ` · ${formatBytes(selBytes)}` : ""}
                {selectedEntries.length === 1 && selectedEntries[0].permissions ? ` · ${selectedEntries[0].permissions}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={() => setMenu(null)} />}

      <TransferQueue
        rows={rows}
        onCancel={(id) => void st().cancel(id)}
        onClear={() => st().clearFinished(profile.id)}
      />
    </div>
  );
}
