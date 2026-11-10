// components/sftp/FileTable.tsx — the remote file list (HANDOFF-3 §2/§5).
//
// Built on maintained libraries instead of a hand-rolled table (README rule 2):
//   * TanStack Table  — column model, header sort handlers (sorting is MANUAL: we sort the data
//                       ourselves so folders always stay on top, the library only tracks the state).
//   * TanStack Virtual — only the visible rows are in the DOM, so a folder with 10,000 entries is fine.
//
// Selection model (kept here, state lives in store/sftp.ts): click = single, Ctrl+click = toggle,
// Shift+click = range from the anchor, drag on empty space / on a row outside its icon+name = rubber-band select
// (Ctrl = add to the current selection; the list scrolls by itself when the pointer nears the top or bottom edge).
// Dragging the icon or the name of a row moves the item(s) instead (drop on a folder = move; drop folders on the
// bookmarks panel = pin them as bookmarks). Keyboard: Up/Down/Home/End/PageUp/PageDown move (hold Shift to extend the
// selection from the anchor), typing letters jumps to the next name starting with them (like Explorer), Enter opens a
// folder, Backspace = up, F5 = refresh, F2 = rename, Delete = delete, Ctrl+A = select all.
// Accessibility: the list is a role="grid" (rows / cells / aria-selected / aria-sort).
//
// Used by: tabs/SftpTab.tsx.   Calls back through props only (no backend access here).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  createColumnHelper, flexRender, getCoreRowModel, useReactTable, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileEntry } from "../../api/types";
import { formatBytes, formatDate } from "../../lib/paths";
import { EntryIcon } from "../icons";

interface Props {
  entries: FileEntry[];
  selected: string[];
  anchor: string | null;
  onSelect: (selected: string[], anchor: string | null) => void;
  /** Double-click / Enter on a row. */
  onOpen: (entry: FileEntry) => void;
  onUp: () => void;
  onRefresh: () => void;
  onRename: () => void;
  onDelete: () => void;
  /** Items dragged onto a folder (a folder row, the Up button or a bookmark: anything with data-ft-dir). */
  onMove: (entries: FileEntry[], destDir: string) => void;
  /** Folders dropped on an element with data-ft-pin (the bookmarks panel) that is not itself a folder target. */
  onPin?: (dirs: FileEntry[]) => void;
  /** Folder highlighted as the target of an Explorer drag (native drags give no hover events). */
  dropDir?: string | null;
  /** Path of the row whose name is being edited in place (new folder / rename). */
  /** Right-click: `entry` = the row (it has just been selected if it was not), null = empty space. */
  onContextMenu?: (x: number, y: number, entry: FileEntry | null) => void;
  /** The pointer left the window while dragging rows (towards Explorer). `held()` says whether the mouse button is
   *  still down; the promise ends when the hand-over is finished (the drag UI is removed then). */
  onDragOut?: (entries: FileEntry[], held: () => boolean) => Promise<void>;
  /** Lets the parent prepare the drag-out to Explorer in the background, so it is ready when the pointer reaches
   *  the window edge. "start" = the row drag really began (pointer moved a few pixels); "near-edge" = the pointer is
   *  now close to the window edge (called at most once per drag). The parent decides what is worth preparing when. */
  onDragBegin?: (entries: FileEntry[], phase: "start" | "near-edge") => void;
  editPath?: string | null;
  /** Text shown when the list is empty (default: "This folder is empty."). */
  emptyText?: string;
  /** Editing ended: `newName` is the typed name (Enter / click away) or null (Escape). */
  onEditDone: (entry: FileEntry, newName: string | null) => void;
}

const ROW_H = 26;
/** Type-to-find: typing pauses longer than this start a new search word. */
const TYPE_RESET_MS = 700;
const col = createColumnHelper<FileEntry>();
const columns = [
  col.accessor("name", {
    id: "name", header: "Name",
    cell: (c) => (
      <span className="ft-name" title={c.getValue()}>
        <EntryIcon entry={c.row.original} /><span className="ft-name-text">{c.getValue()}</span>
      </span>
    ),
  }),
  col.accessor("size", { id: "size", header: "Size", cell: (c) => (c.row.original.isDir ? "" : formatBytes(c.getValue())) }),
  col.accessor("modified", { id: "modified", header: "Modified", cell: (c) => formatDate(c.getValue()) }),
  col.accessor("permissions", { id: "permissions", header: "Permissions", cell: (c) => c.getValue() ?? "" }),
];

/** Folders first (always), then by the chosen column. */
function sortEntries(entries: FileEntry[], sorting: SortingState): FileEntry[] {
  const s = sorting[0] ?? { id: "name", desc: false };
  const dir = s.desc ? -1 : 1;
  const byName = (a: FileEntry, b: FileEntry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let r = 0;
    if (s.id === "size") r = a.size - b.size;
    else if (s.id === "modified") r = (a.modified ?? "").localeCompare(b.modified ?? "");
    else if (s.id === "permissions") r = (a.permissions ?? "").localeCompare(b.permissions ?? "");
    else r = byName(a, b);
    return r !== 0 ? r * dir : byName(a, b);
  });
}

export function FileTable({ entries, selected, anchor, onSelect, onOpen, onUp, onRefresh, onRename, onDelete, onMove, onPin, dropDir, editPath, emptyText, onEditDone, onContextMenu, onDragOut, onDragBegin }: Props) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const sorted = useMemo(() => sortEntries(entries, sorting), [entries, sorting]);
  const selSet = useMemo(() => new Set(selected), [selected]);

  const table = useReactTable({
    data: sorted,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  // Bring the row being edited into view (a new folder may sort far from the top).
  useEffect(() => {
    if (!editPath) return;
    const i = sorted.findIndex((e) => e.path === editPath);
    if (i >= 0) virt.scrollToIndex(i, { align: "auto" });
  }, [editPath, sorted, virt]);

  const ftRef = useRef<HTMLDivElement>(null);
  function endEdit(entry: FileEntry, name: string | null) {
    onEditDone(entry, name);
    requestAnimationFrame(() => ftRef.current?.focus()); // keep the keyboard working after the input is gone
  }

  // The keyboard cursor (the row the arrow keys move from). It differs from the anchor while a Shift+arrow range is
  // being extended: the anchor stays where the range started, the cursor is its moving end.
  const cursor = useRef<string | null>(null);
  // Type-to-find: the letters typed so far (cleared after TYPE_RESET_MS without typing).
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  function click(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, index: number) {
    const entry = sorted[index];
    cursor.current = entry.path;
    if (e.shiftKey && anchor) {
      const a = sorted.findIndex((x) => x.path === anchor);
      const [lo, hi] = a < 0 ? [index, index] : [Math.min(a, index), Math.max(a, index)];
      onSelect(sorted.slice(lo, hi + 1).map((x) => x.path), anchor);
    } else if (e.ctrlKey || e.metaKey) {
      onSelect(selSet.has(entry.path) ? selected.filter((p) => p !== entry.path) : [...selected, entry.path], entry.path);
    } else {
      onSelect([entry.path], entry.path);
    }
  }

  // ---- drag & drop of remote items (mouse events, NOT HTML5 drag: with Tauri's native file drop enabled,
  // WebView2 never delivers HTML5 drag events). Any element with data-ft-dir="<remote folder>" is a target;
  // while dragging, CSS highlights the hovered one (body.ft-dragging).
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  function beginDrag(e: MouseEvent, paths: string[], collapseTo: FileEntry | null) {
    const sx = e.clientX, sy = e.clientY;
    const dragged = sorted.filter((x) => paths.includes(x.path));
    const label = dragged.length === 1 ? dragged[0].name : `${dragged.length} items`;
    let active = false;
    let held = true;  // mouse button still down
    let out = false;  // the pointer left the window: handed over to the native drag-out
    let nearSent = false; // "near-edge" was already reported for this drag
    const targetAt = (ev: globalThis.MouseEvent): string | null => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-ft-dir]");
      const dir = el?.dataset.ftDir ?? null;
      return dir && !paths.includes(dir) ? dir : null; // never "into itself"
    };
    const move = (ev: globalThis.MouseEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        active = true;
        document.body.classList.add("ft-dragging");
        if (onPin && dragged.some((x) => x.isDir)) document.body.classList.add("ft-drag-dir"); // lights up the pin target
        onDragBegin?.(dragged, "start");
      }
      if (out) { setGhost({ x: ev.clientX, y: ev.clientY, label: "Preparing files…" }); return; }
      setGhost({ x: ev.clientX, y: ev.clientY, label });
      if (!nearSent && onDragBegin) {
        const M = 250; // px from the window edge
        if (ev.clientX < M || ev.clientY < M || ev.clientX > window.innerWidth - M || ev.clientY > window.innerHeight - M) {
          nearSent = true;
          onDragBegin(dragged, "near-edge");
        }
      }
      const outside = ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth - 1 || ev.clientY >= window.innerHeight - 1;
      if (outside && onDragOut) {
        out = true;
        void onDragOut(dragged, () => held).finally(finish);
      }
    };
    const finish = () => {
      held = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("ft-dragging", "ft-drag-dir");
      setGhost(null);
      dragCleanup.current = null;
    };
    const up = (ev: globalThis.MouseEvent) => {
      held = false;
      if (out) return; // the preparation for Explorer is still running; finish() runs when it ends
      const dest = active ? targetAt(ev) : null;
      // Not dropped on a folder: dropped on the pin target (bookmarks panel)? Then the folders are bookmarked.
      const pin = active && !dest && onPin && document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-ft-pin]");
      finish();
      if (active) {
        if (dest) onMove(dragged, dest);
        else if (pin) { const dirs = dragged.filter((x) => x.isDir); if (dirs.length) onPin!(dirs); }
      }
      else if (collapseTo) onSelect([collapseTo.path], collapseTo.path); // plain click inside a multi-selection
    };
    const key = (ev: globalThis.KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); finish(); } };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
    dragCleanup.current = finish;
  }

  // ---- rubber-band selection. Starts on empty space (below the rows) or on a row outside its icon + name (those two
  // still drag the item). Coordinates are in the scroll content's space, so the band keeps working while the list
  // scrolls. A press that never moves is a plain click (select the row / clear the selection).
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const bandCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => bandCleanup.current?.(), []);

  function beginBand(e: MouseEvent, rowIndex: number | null) {
    const el = scrollRef.current;
    if (!el) return;
    bandCleanup.current?.();
    const mods = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey };
    const additive = e.ctrlKey || e.metaKey;
    const origSel = selected, origAnchor = anchor;
    const toContent = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return { x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop };
    };
    const start = toContent(e.clientX, e.clientY);
    const sx = e.clientX, sy = e.clientY;
    const last = { x: sx, y: sy };
    let active = false;
    let lastKey = "";
    let raf = 0;
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const apply = () => {
      const p = toContent(last.x, last.y);
      const x1 = clamp(Math.min(start.x, p.x), el.scrollWidth), x2 = clamp(Math.max(start.x, p.x), el.scrollWidth);
      const y1 = clamp(Math.min(start.y, p.y), el.scrollHeight), y2 = clamp(Math.max(start.y, p.y), el.scrollHeight);
      setBand({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      const lo = Math.floor(y1 / ROW_H), hi = Math.min(sorted.length - 1, Math.ceil(y2 / ROW_H) - 1);
      const key = `${lo}:${hi}`;
      if (key === lastKey) return;
      lastKey = key;
      const hit = lo <= hi ? sorted.slice(lo, hi + 1).map((x) => x.path) : [];
      const paths = additive ? [...new Set([...origSel, ...hit])] : hit;
      cursor.current = hit.length ? hit[hit.length - 1] : cursor.current;
      onSelect(paths, additive ? origAnchor : (hit[0] ?? null));
    };
    const tick = () => { // auto-scroll while the pointer is near (or beyond) the top / bottom edge
      raf = requestAnimationFrame(tick);
      const r = el.getBoundingClientRect();
      const EDGE = 28;
      let dy = 0;
      if (last.y < r.top + EDGE) dy = -Math.ceil((r.top + EDGE - last.y) / 4);
      else if (last.y > r.bottom - EDGE) dy = Math.ceil((last.y - (r.bottom - EDGE)) / 4);
      dy = Math.max(-40, Math.min(40, dy));
      if (dy) { el.scrollTop += dy; apply(); }
    };
    const finish = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      el.removeEventListener("scroll", onScroll);
      setBand(null);
      bandCleanup.current = null;
    };
    const move = (ev: globalThis.MouseEvent) => {
      if (ev.buttons === 0) { finish(); return; } // the button was released outside the window
      last.x = ev.clientX; last.y = ev.clientY;
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        active = true;
        raf = requestAnimationFrame(tick);
      }
      apply();
    };
    const onScroll = () => { if (active) apply(); };
    const up = () => {
      finish();
      if (active) return;
      if (rowIndex !== null) click(mods, rowIndex);
      else if (!additive) onSelect([], null);
    };
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      finish();
      onSelect(origSel, origAnchor);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
    el.addEventListener("scroll", onScroll);
    bandCleanup.current = finish;
  }

  function rowDown(e: MouseEvent, index: number) {
    if (e.button !== 0) return;
    // Only the icon and the name drag the item; the rest of the row (size / date / permissions / blank space) rubber-bands.
    if (!(e.target as HTMLElement).closest(".ft-name > *")) { beginBand(e, index); return; }
    const entry = sorted[index];
    const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (plain && selSet.has(entry.path) && selected.length > 1) {
      beginDrag(e, selected, entry); // keep the multi-selection so it can be dragged as a group
    } else {
      click(e, index);
      if (plain) beginDrag(e, [entry.path], null);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const idxOf = (path: string | null) => (path ? sorted.findIndex((x) => x.path === path) : -1);
    let cur = idxOf(cursor.current);
    if (cur < 0) cur = idxOf(anchor);
    // Move the cursor to row `i`; with `extend` the selection becomes the range anchor..i (Shift+arrows).
    const move = (i: number, extend = false) => {
      if (!sorted.length) return;
      const n = Math.min(sorted.length - 1, Math.max(0, i));
      cursor.current = sorted[n].path;
      const a = extend ? idxOf(anchor) : -1;
      if (extend && a >= 0) {
        onSelect(sorted.slice(Math.min(a, n), Math.max(a, n) + 1).map((x) => x.path), anchor);
      } else {
        onSelect([sorted[n].path], sorted[n].path);
      }
      virt.scrollToIndex(n, { align: "auto" });
    };
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_H * 10) / ROW_H) - 1);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(cur + 1, e.shiftKey); return;
      case "ArrowUp": e.preventDefault(); move(cur < 0 ? 0 : cur - 1, e.shiftKey); return;
      case "PageDown": e.preventDefault(); move(cur + page, e.shiftKey); return;
      case "PageUp": e.preventDefault(); move(cur < 0 ? 0 : cur - page, e.shiftKey); return;
      case "Home": e.preventDefault(); move(0, e.shiftKey); return;
      case "End": e.preventDefault(); move(sorted.length - 1, e.shiftKey); return;
      case "Enter": if (cur >= 0) { e.preventDefault(); onOpen(sorted[cur]); } return;
      case "Backspace": e.preventDefault(); onUp(); return;
      case "F5": e.preventDefault(); onRefresh(); return;
      case "F2": e.preventDefault(); onRename(); return;
      case "Delete": if (selected.length) { e.preventDefault(); onDelete(); } return;
    }
    if (e.ctrlKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      onSelect(sorted.map((x) => x.path), anchor);
      return;
    }
    // Type-to-find: a printable character (no Ctrl / Alt / Meta) jumps to the next entry whose name starts with the
    // letters typed in the last TYPE_RESET_MS. Typing the same letter again cycles through the names starting with it.
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key !== " " || typed.current.text)) {
      e.preventDefault();
      const now = Date.now();
      const t = typed.current;
      t.text = now - t.at > TYPE_RESET_MS ? e.key : t.text + e.key;
      t.at = now;
      const text = t.text.toLowerCase();
      const same = text.length > 1 && [...text].every((c) => c === text[0]);
      const needle = same ? text[0] : text;
      // One letter (or the same letter repeated) starts AFTER the current row; a longer word may stay on it.
      const from = same || text.length === 1 ? cur + 1 : Math.max(cur, 0);
      for (let k = 0; k < sorted.length; k++) {
        const i = (from + k) % sorted.length;
        if (sorted[i].name.toLowerCase().startsWith(needle)) { move(i); break; }
      }
    }
  }

  return (
    <div className="ft" tabIndex={0} ref={ftRef} onKeyDown={onKeyDown} role="grid" aria-label="Remote files"
      aria-multiselectable="true" aria-rowcount={rows.length + 1} aria-colcount={4}>
      {/* Header: click to sort. */}
      <div className="ft-row ft-head" role="row" aria-rowindex={1}>
        {table.getHeaderGroups()[0].headers.map((h) => {
          const dir = h.column.getIsSorted();
          return (
            <div key={h.id} className="ft-cell ft-th" role="columnheader" onClick={h.column.getToggleSortingHandler()}
              aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}>
              {flexRender(h.column.columnDef.header, h.getContext())}
              {dir && <span className={`ft-sort ${dir}`} aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      {/* Body: virtualized. */}
      <div
        className="ft-scroll"
        ref={scrollRef}
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest(".ft-row")) return; // rows handle their own press
          const el = e.currentTarget, r = el.getBoundingClientRect();
          if (e.clientX >= r.left + el.clientWidth || e.clientY >= r.top + el.clientHeight) return; // a scrollbar
          beginBand(e, null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!onContextMenu) return;
          onSelect([], null); // right-click on empty space: no selection (like Explorer)
          onContextMenu(e.clientX, e.clientY, null);
        }}
      >
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index];
            const entry = row.original;
            const isSel = selSet.has(entry.path);
            return (
              <div
                key={row.id}
                className={`ft-row ft-body${isSel ? " is-sel" : ""}${dropDir && entry.path === dropDir ? " is-drop" : ""}`}
                role="row"
                aria-selected={isSel}
                aria-rowindex={v.index + 2}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${v.start}px)` }}
                data-ft-dir={entry.isDir ? entry.path : undefined}
                onMouseDown={(e) => rowDown(e, v.index)}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!onContextMenu) return;
                  if (!selSet.has(entry.path)) onSelect([entry.path], entry.path);
                  onContextMenu(e.clientX, e.clientY, entry);
                }}
              >
                {row.getVisibleCells().map((c) => (
                  <div key={c.id} className={`ft-cell ft-${c.column.id}`} role="gridcell">
                    {c.column.id === "name" && editPath === entry.path
                      ? <InlineName entry={entry} onDone={(n) => endEdit(entry, n)} />
                      : flexRender(c.column.columnDef.cell, c.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
          {band && <div className="ft-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
        </div>
        {rows.length === 0 && <div className="ft-empty">{emptyText ?? "This folder is empty."}</div>}
      </div>
      {ghost && <div className="ft-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>{ghost.label}</div>}
    </div>
  );
}

/** The name cell while renaming: the whole name starts selected, Enter / click away = save, Esc = cancel. */
function InlineName({ entry, onDone }: { entry: FileEntry; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (v: string | null) => { if (!finished.current) { finished.current = true; onDone(v); } };
  return (
    <span className="ft-inline">
      <EntryIcon entry={entry} />
      <input
        ref={ref}
        className="ft-edit"
        defaultValue={entry.name}
        spellCheck={false}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); finish(e.currentTarget.value); }
          else if (e.key === "Escape") { e.preventDefault(); finish(null); }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </span>
  );
}
