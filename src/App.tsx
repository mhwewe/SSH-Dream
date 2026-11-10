// =============================================================================
// App.tsx — layout shell: header (title + ProfileSwitcher), ActionBar, tab strip + tab panel,
// LogPane (the Log in / Log out button lives in the left ActionBar), plus global Toasts and Dialogs.
// On start: subscribes to backend events once and loads profiles (store/profiles.ts init).
// Window title = "<profile name>[*] - SSH Dream" (asterisk = unsaved changes).
// Also here (polish): global keyboard shortcuts, the "unsaved changes / running transfers" guard when the window is
// closed, and the cancelling of browser-only keys (F5 / Ctrl+R reload, page zoom, F7 caret browsing) that would wreck
// the UI state while the SSH sessions keep running in the backend.
//   Ctrl+1..4 tabs (Login, Terminal, SFTP, RDP) · Ctrl+, Options (the cogwheel, top right) · Ctrl+S save profile · Ctrl+Enter log in · Ctrl+Shift+T new terminal
// =============================================================================
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useProfiles } from "./store/profiles";
import { useSessions } from "./store/sessions";
import { useSftp } from "./store/sftp";
import { initLogListener } from "./store/logs";
import { profileSave } from "./api/profiles";
import { ActionBar, logInActive } from "./components/ActionBar";
import { dialogs } from "./store/dialogs";
import { toast } from "./store/toasts";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { LogPane } from "./components/LogPane";
import { Toasts } from "./components/Toasts";
import { Dialogs } from "./components/Dialogs";
import HostKeyDialog from "./components/HostKeyDialog";           // H2
import PasswordDialog from "./components/PasswordDialog";         // H2
import { ConflictDialog } from "./components/sftp/ConflictDialog"; // H3
import { LoginTab } from "./tabs/LoginTab";
import { OptionsTab } from "./tabs/OptionsTab";
import TerminalTab from "./tabs/TerminalTab"; // H2: default export
import { RdpTab } from "./tabs/RdpTab";
import { IconCog } from "./components/icons";
import { SftpTab } from "./tabs/SftpTab";

export type TabId = "login" | "options" | "terminal" | "rdp" | "sftp";
// The tab strip. "options" is NOT in it: it has its own cogwheel button in the top right corner (see the header below).
const TABS: { id: Exclude<TabId, "options">; label: string }[] = [
  { id: "login", label: "Login" }, { id: "terminal", label: "Terminal" }, { id: "sftp", label: "SFTP" }, { id: "rdp", label: "RDP" },
];

/** True when the key event comes from inside a terminal (it has its own zoom / copy / paste rules). */
const inTerminal = (t: EventTarget | null) => t instanceof Element && !!t.closest(".term-host");

export default function App() {
  const [tab, setTab] = useState<TabId>("login");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  // The tab that was open before Options, so the cogwheel (or Ctrl+,) toggles back to it.
  const beforeOptions = useRef<TabId>("login");
  const toggleOptions = useCallback(() => {
    if (tabRef.current === "options") setTab(beforeOptions.current);
    else { beforeOptions.current = tabRef.current; setTab("options"); }
  }, []);
  const draft = useProfiles((s) => s.draft);
  const loaded = useProfiles((s) => s.loaded);
  const dirty = useProfiles((s) => s.isDirty());
  const activeId = useProfiles((s) => s.activeId);
  // The SAVED profile (terminal font, id). Terminal/SFTP tabs only need what is on disk.
  const activeProfile = useProfiles((s) => s.profiles.find((p) => p.id === s.activeId) ?? null);

  useEffect(() => {
    initLogListener();
    void useSessions.getState().init(); // H2: session://state + term://closed listeners
    useSftp.getState().init();          // H3: transfer://conflict listener + session watcher
    void useProfiles.getState().init();
  }, []);

  // Auto login: once, right after the profiles are loaded, log in every profile that has the flag.
  // One after the other, so host-key / password prompts never stack on top of each other.
  const autoLoginDone = useRef(false);
  useEffect(() => {
    if (!loaded || autoLoginDone.current) return;
    autoLoginDone.current = true;
    void (async () => {
      await useSessions.getState().init();
      // One-time: profiles saved before auto-connect became the default still have the flag OFF.
      // Switch it on once (the user can untick it afterwards and it stays off).
      try {
        if (!localStorage.getItem("autoConnectDefaultOn")) {
          for (const old of useProfiles.getState().profiles) {
            if (old.ssh.autoLogin) continue;
            const saved = await profileSave({ ...old, ssh: { ...old.ssh, autoLogin: true } });
            useProfiles.setState((s) => ({
              profiles: s.profiles.map((x) => (x.id === saved.id ? saved : x)),
              draft: s.draft && s.draft.id === saved.id && !s.isDirty() ? structuredClone(saved) : s.draft,
            }));
          }
          localStorage.setItem("autoConnectDefaultOn", "1");
        }
      } catch { /* non-fatal: the checkbox still works by hand */ }
      // The profile shown at start (the last one used) always connects; others only when they have the flag.
      const shownId = useProfiles.getState().activeId;
      const list = [...useProfiles.getState().profiles].sort((a, b) => Number(b.id === shownId) - Number(a.id === shownId));
      for (const p of list) {
        if ((p.id !== shownId && !p.ssh.autoLogin) || !p.ssh.host.trim() || !p.ssh.username.trim()) continue;
        const st = useSessions.getState().byProfile[p.id]?.state;
        if (st === "connecting" || st === "connected") continue;
        await useSessions.getState().connect(p.id);
        // A password / passphrase question may be open: wait until this login has settled
        // (connected, failed, or the question was cancelled) before starting the next profile.
        await new Promise<void>((resolve) => {
          const settled = (s: ReturnType<typeof useSessions.getState>) =>
            !s.credPrompt && s.byProfile[p.id]?.state !== "connecting";
          if (settled(useSessions.getState())) return resolve();
          const un = useSessions.subscribe((s) => { if (settled(s)) { un(); resolve(); } });
        });
        if (useSessions.getState().byProfile[p.id]?.state !== "connected") continue;
        // SSH is up: also open SFTP and a first terminal, without waiting for the user to visit those tabs.
        void useSftp.getState().ensureOpen(p.id);
        if (!useSessions.getState().tabs.some((t) => t.profileId === p.id)) useSessions.getState().openTerminal(p);
      }
    })();
  }, [loaded]);

  // ---- global keyboard shortcuts ---------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      // Keys that only make sense in a browser: the app is a UI over live sessions, a reload would lose its state.
      if (e.key === "F7" || (e.ctrlKey && (k === "r" || k === "p" || k === "u" || k === "j")) || (e.key === "F5" && !e.defaultPrevented)) {
        e.preventDefault();
        // F5 on the SFTP tab = refresh the folder (the file list does this itself when it has the focus).
        if (e.key === "F5" && tabRef.current === "sftp") { const id = useProfiles.getState().activeId; if (id) void useSftp.getState().refresh(id); }
        return;
      }
      // Page zoom (Ctrl + / - / 0). Terminals zoom their own font instead.
      if (e.ctrlKey && !e.altKey && ["+", "=", "-", "_", "0"].includes(e.key)) { e.preventDefault(); return; }

      if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        setTab(TABS[Number(e.key) - 1].id);
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault(); // Ctrl+, = Options (the usual settings shortcut)
        toggleOptions();
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && k === "s" && !inTerminal(e.target)) {
        e.preventDefault(); // (Ctrl+S in a terminal is XOFF: left alone)
        void useProfiles.getState().saveDraft().then((p) => { if (p) toast(`Saved "${p.name}"`, "success"); });
      } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "Enter" && !inTerminal(e.target) && !(typing && tabRef.current === "sftp")) {
        const id = useProfiles.getState().activeId;
        const st = id ? useSessions.getState().byProfile[id]?.state : undefined;
        if (st !== "connected" && st !== "connecting") { e.preventDefault(); void logInActive(); }
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyT") {
        e.preventDefault();
        setTab("terminal");
        const { profiles, activeId } = useProfiles.getState();
        const p = profiles.find((x) => x.id === activeId);
        if (p && !useSessions.getState().openTerminal(p)) toast("Log in first to open a terminal", "error");
      }
    };
    const onWheel = (e: WheelEvent) => { if (e.ctrlKey && !inTerminal(e.target)) e.preventDefault(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("wheel", onWheel); };
  }, [toggleOptions]);

  // ---- closing the window: do not lose unsaved edits or running transfers by accident --------------
  useEffect(() => {
    let un: (() => void) | undefined;
    let gone = false;
    const w = getCurrentWindow();
    void w.onCloseRequested(async (event) => {
      const unsaved = useProfiles.getState().isDirty();
      const live = useSftp.getState().transfers.filter((t) => t.state === "queued" || t.state === "running").length;
      if (!unsaved && !live) return; // nothing at risk: the window just closes
      event.preventDefault();
      const why = [
        unsaved ? "The current profile has unsaved changes." : "",
        live ? `${live} transfer${live === 1 ? " is" : "s are"} still running and will be stopped.` : "",
      ].filter(Boolean).join(" ");
      const pick = await dialogs.choose("Exit SSH Dream?", why, unsaved ? ["Save and exit", "Exit without saving", "Cancel"] : ["Exit", "Cancel"]);
      if (pick === "Cancel") return;
      if (pick === "Save and exit" && !(await useProfiles.getState().saveDraft())) return; // stay open when saving failed
      await w.destroy(); // destroy() skips this handler (close() would ask again)
    }).then((f) => { if (gone) f(); else un = f; }).catch(() => { /* not fatal: the window closes without the check */ });
    return () => { gone = true; un?.(); };
  }, []);

  useEffect(() => {
    const t = `${draft?.name ?? "SSH Dream"}${dirty ? "*" : ""} - SSH Dream`;
    document.title = t;
    void getCurrentWindow().setTitle(t).catch(() => {});
  }, [draft?.name, dirty]);

  // Arrow keys move between the tabs (roving tabindex).
  const onTabsKey = useCallback((e: ReactKeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tabRef.current);
    const go = (n: number) => {
      e.preventDefault();
      const next = TABS[(n + TABS.length) % TABS.length].id;
      setTab(next);
      requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    };
    // i === -1 while Options is open (no tab of the strip is selected): Right -> first tab, Left -> last tab.
    if (e.key === "ArrowRight") go(i < 0 ? 0 : i + 1);
    else if (e.key === "ArrowLeft") go(i < 0 ? TABS.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(TABS.length - 1);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <ProfileSwitcher />
        <nav className="tabs" role="tablist" aria-label="Sections" onKeyDown={onTabsKey}>
          {TABS.map((t, i) => (
            <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="main-panel" tabIndex={tab === t.id || (tab === "options" && i === 0) ? 0 : -1}
              className={tab === t.id ? "tab active" : "tab"} title={`${t.label} (Ctrl+${i + 1})`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        {/* Options cogwheel, top right. It also labels the panel while Options is open (aria-labelledby="tab-options"). */}
        <button id="tab-options" className="settings-btn" title="Options (Ctrl+,)" aria-label="Options" aria-pressed={tab === "options"}
          aria-controls="main-panel" onClick={toggleOptions}><IconCog size={18} /></button>
      </header>
      <div className="body">
        <ActionBar onTab={setTab} />
        <main className="main">
          <section id="main-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className={tab === "terminal" || tab === "sftp" ? "tabpanel flush" : "tabpanel"}>
            {!loaded || !draft ? <div className="placeholder" role="status">Loading…</div> : (
              <>
                {tab === "login" && <LoginTab />}
                {tab === "options" && <OptionsTab />}
                {tab === "rdp" && <RdpTab />}
                {/* Terminal and SFTP stay MOUNTED while another tab is shown (hidden with CSS):
                    unmounting the terminal would destroy running shells and their scrollback. */}
                <div className="panel-fill" style={{ display: tab === "terminal" ? "block" : "none" }}>
                  <TerminalTab profile={activeProfile} active={tab === "terminal"} />
                </div>
                <div className="panel-fill" style={{ display: tab === "sftp" ? "block" : "none" }}>
                  <SftpTab profile={activeProfile} active={tab === "sftp"} />
                </div>
              </>
            )}
          </section>
        </main>
      </div>
      <LogPane />
      <Toasts />
      <Dialogs />
      <HostKeyDialog />
      <PasswordDialog />
      <ConflictDialog />
    </div>
  );
}
