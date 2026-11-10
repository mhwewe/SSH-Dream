// components/TerminalView.tsx — ONE xterm.js terminal bound to ONE backend terminal channel.
//
// Who uses it: tabs/TerminalTab.tsx renders one <TerminalView> per terminal tab and keeps them
// ALL mounted (hidden with CSS) so scrollback and running programs survive tab/profile switches.
//
// Lifecycle: mount -> create xterm + fit addon -> term_open (gets channelId) -> stream output.
// Unmount (tab closed by the user) -> term_close + dispose. Hiding does NOT unmount.
// Uses the maintained @xterm/xterm library — no custom emulator (README rule 2).
// Zoom (this terminal only, not saved to the profile): Ctrl + mouse wheel, Ctrl + "+" / "-" / "0" (reset), like Windows Terminal.
// Find: Ctrl+Shift+F opens a search bar (xterm search addon); Enter / Shift+Enter = next / previous, Esc closes.
// Colours follow the app theme (light / dark) and change live when the theme is switched.

import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { termClose, termOpen, termResize, termWrite } from "../api/terminal";
import { useSessions, type TermTab } from "../store/sessions";
import { useTheme } from "../store/theme";
import { termContrast, termTheme } from "../lib/terminalTheme";
import { IconClose } from "./icons";

interface Props {
  tab: TermTab;
  /** True only for the tab the user is looking at (right profile + right sub-tab + Terminal tab). */
  visible: boolean;
}

const encoder = new TextEncoder();
const MIN_FONT = 8;
const MAX_FONT = 40;

export default function TerminalView({ tab, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findMiss, setFindMiss] = useState(false);
  const theme = useTheme((s) => s.resolved);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const channelRef = useRef<string | null>(null);
  const refitRef = useRef<() => void>(() => {});
  const setChannel = useSessions((s) => s.setChannel);

  // ---- create once -------------------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      // Cascadia Mono ships with Windows 11; fall back to Consolas (HANDOFF-2 §7).
      fontFamily: `"${tab.font.fontFamily}", Consolas, monospace`,
      fontSize: tab.font.fontSize,
      scrollback: tab.font.scrollback,
      cursorBlink: true,
      theme: termTheme(themeRef.current),
      minimumContrastRatio: termContrast(themeRef.current),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    searchRef.current = search;
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* hidden at creation: size is fixed later when it becomes visible */
    }

    let disposed = false;

    // Backend -> screen. The channel delivers ordered chunks of raw bytes.
    const onData = new Channel<number[]>();
    onData.onmessage = (bytes) => term.write(new Uint8Array(bytes));

    termOpen(tab.sessionId, term.cols, term.rows, onData)
      .then((channelId) => {
        if (disposed) {
          void termClose(channelId); // tab was closed while the open was in flight
          return;
        }
        channelRef.current = channelId;
        setChannel(tab.id, channelId);
        refitRef.current(); // make sure the server knows the real size
      })
      .catch((e: { message?: string }) => {
        term.write(`\r\n\x1b[31m[Cannot open terminal: ${e?.message ?? String(e)}]\x1b[0m\r\n`);
      });

    // Screen -> backend. onData = text typed/pasted; onBinary = binary mouse reports.
    term.onData((s) => {
      const ch = channelRef.current;
      if (ch) void termWrite(ch, Array.from(encoder.encode(s))).catch(() => {});
    });
    term.onBinary((s) => {
      const ch = channelRef.current;
      if (ch) void termWrite(ch, Array.from(s, (c) => c.charCodeAt(0))).catch(() => {});
    });

    // Copy on selection. Ctrl+Shift+C also copies; plain Ctrl+C is NOT touched, so it still
    // reaches the remote shell as an interrupt (HANDOFF-2 §5.2).
    // Debounced: the event fires for every cell while the mouse is still dragging; copy once it settles.
    let selTimer: number | undefined;
    term.onSelectionChange(() => {
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      }, 150);
    });

    // Zoom this terminal. The refit below tells the server the new column / row count.
    const setFontSize = (n: number) => {
      const size = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(n)));
      if (size === term.options.fontSize) return;
      term.options.fontSize = size;
      refitRef.current();
    };
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return; // plain wheel scrolls the scrollback (xterm)
      ev.preventDefault();
      ev.stopPropagation();
      setFontSize((term.options.fontSize ?? tab.font.fontSize) + (ev.deltaY < 0 ? 1 : -1));
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    const paste = () => {
      void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // App-level shortcuts: do not let xterm turn them into input for the shell (the event still bubbles to the window).
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === "Tab" || (ev.shiftKey && (ev.code === "KeyW" || ev.code === "KeyT")))) return false;
      // Zoom keys (Ctrl without Alt). "+" needs Shift on many layouts, so Shift is allowed for "+" / "=".
      if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const cur = term.options.fontSize ?? tab.font.fontSize;
        // preventDefault: xterm does not do it for us, and WebView2 would zoom the whole page on these keys.
        if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); setFontSize(cur + 1); return false; }
        if (!ev.shiftKey && (ev.key === "-" || ev.key === "_")) { ev.preventDefault(); setFontSize(cur - 1); return false; }
        if (!ev.shiftKey && ev.key === "0") { ev.preventDefault(); setFontSize(tab.font.fontSize); return false; }
      }
      if (!ev.ctrlKey || !ev.shiftKey) return true;
      if (ev.code === "KeyF") { ev.preventDefault(); setFindOpen(true); return false; }
      if (ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.code === "KeyV") {
        paste();
        return false;
      }
      return true;
    });
    // Right-click pastes (configurable later).
    const onContext = (ev: MouseEvent) => {
      ev.preventDefault();
      paste();
    };
    host.addEventListener("contextmenu", onContext);

    // Refit when the container changes size (debounced ~100 ms) and tell the server.
    let timer: number | undefined;
    const refit = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!host.clientWidth || !host.clientHeight) return; // hidden: skip
        try {
          fit.fit();
        } catch {
          return;
        }
        const ch = channelRef.current;
        if (ch) void termResize(ch, term.cols, term.rows).catch(() => {});
      }, 100);
    };
    refitRef.current = refit;
    const ro = new ResizeObserver(refit);
    ro.observe(host);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearTimeout(selTimer);
      ro.disconnect();
      host.removeEventListener("contextmenu", onContext);
      host.removeEventListener("wheel", onWheel, { capture: true });
      const ch = channelRef.current;
      if (ch) void termClose(ch).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created exactly once per tab
  }, []);

  // ---- theme switched while the terminal is open ---------------------------------------------
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = termTheme(theme);
    term.options.minimumContrastRatio = termContrast(theme);
  }, [theme]);

  // ---- find bar ---------------------------------------------------------------------------------
  useEffect(() => { if (findOpen) { findInputRef.current?.focus(); findInputRef.current?.select(); } }, [findOpen]);
  const runFind = (text: string, dir: "next" | "prev", incremental = false) => {
    const s = searchRef.current;
    if (!s || !text) { setFindMiss(false); return; }
    const found = dir === "next" ? s.findNext(text, { incremental }) : s.findPrevious(text);
    setFindMiss(!found);
  };
  const closeFind = () => {
    setFindOpen(false);
    setFindMiss(false);
    searchRef.current?.clearDecorations();
    termRef.current?.focus();
  };

  // ---- becoming visible: fit + focus ---------------------------------------------------------
  useEffect(() => {
    if (!visible) return;
    refitRef.current();
    termRef.current?.focus();
  }, [visible]);

  // ---- connection closed notice ---------------------------------------------------------------
  useEffect(() => {
    if (tab.closed) termRef.current?.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");
  }, [tab.closed]);

  return (
    <div className="term-wrap">
      <div ref={hostRef} className="term-host" />
      {findOpen && visible && (
        <div className="term-find" role="search">
          <input ref={findInputRef} value={findText} placeholder="Find in terminal" aria-label="Find in terminal" spellCheck={false}
            className={findMiss ? "invalid" : ""}
            onChange={(e) => { setFindText(e.target.value); runFind(e.target.value, "next", true); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); runFind(findText, e.shiftKey ? "prev" : "next"); }
              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
            }} />
          <button title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => runFind(findText, "prev")}>▲</button>
          <button title="Next match (Enter)" aria-label="Next match" onClick={() => runFind(findText, "next")}>▼</button>
          <button className="icon-btn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}><IconClose size={14} /></button>
        </div>
      )}
    </div>
  );
}
