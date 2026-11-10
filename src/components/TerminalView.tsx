// components/TerminalView.tsx — ONE xterm.js terminal bound to ONE backend terminal channel.
//
// Who uses it: tabs/TerminalTab.tsx renders one <TerminalView> per terminal tab and keeps them
// ALL mounted (hidden with CSS) so scrollback and running programs survive tab/profile switches.
//
// Lifecycle: mount -> create xterm + fit addon -> term_open (gets channelId) -> stream output.
// Unmount (tab closed by the user) -> term_close + dispose. Hiding does NOT unmount.
// Uses the maintained @xterm/xterm library — no custom emulator (README rule 2).

import { useEffect, useRef } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { termClose, termOpen, termResize, termWrite } from "../api/terminal";
import { useSessions, type TermTab } from "../store/sessions";

interface Props {
  tab: TermTab;
  /** True only for the tab the user is looking at (right profile + right sub-tab + Terminal tab). */
  visible: boolean;
}

const encoder = new TextEncoder();

export default function TerminalView({ tab, visible }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
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
      theme: { background: "#0c0c0c" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
    });
    const paste = () => {
      void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey) return true;
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
      ro.disconnect();
      host.removeEventListener("contextmenu", onContext);
      const ch = channelRef.current;
      if (ch) void termClose(ch).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created exactly once per tab
  }, []);

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

  return <div ref={hostRef} className="term-host" />;
}
