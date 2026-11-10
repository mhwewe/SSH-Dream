// components/sftp/FileTable.tsx — the remote file list (HANDOFF-3 §2/§5).
//
// Built on maintained libraries instead of a hand-rolled table (README rule 2):
//   * TanStack Table  — column model, header sort handlers (sorting is MANUAL: we sort the data
//                       ourselves so folders always stay on top, the library only tracks the state).
//   * TanStack Virtual — only the visible rows are in the DOM, so a folder with 10,000 entries is fine.
//
// Selection model (kept here, state lives in store/sftp.ts): click = single, Ctrl+click = toggle,
// Shift+click = range from the anchor. Keyboard: Up/Down/Home/End move, Enter opens a folder, Backspace = up,
// F5 = refresh, F2 = rename, Delete = delete, Ctrl+A = select all.
//
// Used by: tabs/SftpTab.tsx.   Calls back through props only (no backend access here).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  createColumnHelper, flexRender, getCoreRowModel, useReactTable, type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileEntry } from "../../api/types";
import { formatBytes, formatDate } from "../../lib/paths";

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
  /** Folder highlighted as the target of an Explorer drag (native drags give no hover events). */
  dropDir?: string | null;
  /** Path of the row whose name is being edited in place (new folder / rename). */
  editPath?: string | null;
  /** Editing ended: `newName` is the typed name (Enter / click away) or null (Escape). */
  onEditDone: (entry: FileEntry, newName: string | null) => void;
}

const ROW_H = 22;
const col = createColumnHelper<FileEntry>();
const columns = [
  col.accessor("name", { id: "name", header: "Name", cell: (c) => `${c.row.original.isDir ? "📁" : "📄"} ${c.getValue()}` }),
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

export function FileTable({ entries, selected, anchor, onSelect, onOpen, onUp, onRefresh, onRename, onDelete, onMove, dropDir, editPath, onEditDone }: Props) {
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

  // Keep the keyboard cursor visible: scroll to the anchor when it changes through the keyboard.
  const lastKeyNav = useRef(false);
  useEffect(() => {
    if (!lastKeyNav.current || !anchor) return;
    lastKeyNav.current = false;
    const i = sorted.findIndex((e) => e.path === anchor);
    if (i >= 0) virt.scrollToIndex(i, { align: "auto" });
  }, [anchor, sorted, virt]);

  function click(e: MouseEvent, index: number) {
    const entry = sorted[index];
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
      }
      setGhost({ x: ev.clientX, y: ev.clientY, label });
    };
    const finish = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("ft-dragging");
      setGhost(null);
      dragCleanup.current = null;
    };
    const up = (ev: globalThis.MouseEvent) => {
      const dest = active ? targetAt(ev) : null;
      finish();
      if (active) { if (dest) onMove(dragged, dest); }
      else if (collapseTo) onSelect([collapseTo.path], collapseTo.path); // plain click inside a multi-selection
    };
    const key = (ev: globalThis.KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); finish(); } };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
    dragCleanup.current = finish;
  }

  function rowDown(e: MouseEvent, index: number) {
    if (e.button !== 0) return;
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
    const cur = anchor ? sorted.findIndex((x) => x.path === anchor) : -1;
    const move = (i: number) => {
      if (!sorted.length) return;
      const n = Math.min(sorted.length - 1, Math.max(0, i));
      lastKeyNav.current = true; // the effect above scrolls the new row into view
      onSelect([sorted[n].path], sorted[n].path);
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(cur + 1); break;
      case "ArrowUp": e.preventDefault(); move(cur < 0 ? 0 : cur - 1); break;
      case "Home": e.preventDefault(); move(0); break;
      case "End": e.preventDefault(); move(sorted.length - 1); break;
      case "Enter": if (cur >= 0) { e.preventDefault(); onOpen(sorted[cur]); } break;
      case "Backspace": e.preventDefault(); onUp(); break;
      case "F5": e.preventDefault(); onRefresh(); break;
      case "F2": e.preventDefault(); onRename(); break;
      case "Delete": if (selected.length) { e.preventDefault(); onDelete(); } break;
      case "a": case "A":
        if (e.ctrlKey) { e.preventDefault(); onSelect(sorted.map((x) => x.path), anchor); }
        break;
    }
  }

  return (
    <div className="ft" tabIndex={0} ref={ftRef} onKeyDown={onKeyDown}>
      {/* Header: click to sort. */}
      <div className="ft-row ft-head">
        {table.getHeaderGroups()[0].headers.map((h) => {
          const dir = h.column.getIsSorted();
          return (
            <div key={h.id} className="ft-cell ft-th" onClick={h.column.getToggleSortingHandler()}>
              {flexRender(h.column.columnDef.header, h.getContext())}
              {dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : ""}
            </div>
          );
        })}
      </div>

      {/* Body: virtualized. */}
      <div className="ft-scroll" ref={scrollRef}>
        <div style={{ height: virt.getTotalSize(), position: "relative" }}>
          {virt.getVirtualItems().map((v) => {
            const row = rows[v.index];
            const entry = row.original;
            const isSel = selSet.has(entry.path);
            return (
              <div
                key={row.id}
                className={`ft-row ft-body${isSel ? " is-sel" : ""}${dropDir && entry.path === dropDir ? " is-drop" : ""}`}
                style={{ position: "absolute", top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${v.start}px)` }}
                data-ft-dir={entry.isDir ? entry.path : undefined}
                onMouseDown={(e) => rowDown(e, v.index)}
                onDoubleClick={() => onOpen(entry)}
              >
                {row.getVisibleCells().map((c) => (
                  <div key={c.id} className={`ft-cell ft-${c.column.id}`}>
                    {c.column.id === "name" && editPath === entry.path
                      ? <InlineName entry={entry} onDone={(n) => endEdit(entry, n)} />
                      : flexRender(c.column.columnDef.cell, c.getContext())}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && <div className="ft-empty">This folder is empty.</div>}
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
      {entry.isDir ? "📁" : "📄"}{" "}
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
