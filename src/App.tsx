// =============================================================================
// App.tsx — layout shell: header (title + ProfileSwitcher), ActionBar, tab strip + tab panel,
// LogPane (the Log in / Log out button lives in the left ActionBar), plus global Toasts and Dialogs.
// On start: subscribes to backend events once and loads profiles (store/profiles.ts init).
// Window title = "<profile name>[*] - SSH Clone" (asterisk = unsaved changes).
// =============================================================================
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useProfiles } from "./store/profiles";
import { useSessions } from "./store/sessions";
import { useSftp } from "./store/sftp";
import { initLogListener } from "./store/logs";
import { profileSave } from "./api/profiles";
import { ActionBar } from "./components/ActionBar";
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
import { SftpTab } from "./tabs/SftpTab";

export type TabId = "login" | "options" | "terminal" | "rdp" | "sftp";
const TABS: { id: TabId; label: string }[] = [
  { id: "login", label: "Login" }, { id: "terminal", label: "Terminal" }, { id: "sftp", label: "SFTP" },
  { id: "options", label: "Options" }, { id: "rdp", label: "RDP" },
];

export default function App() {
  const [tab, setTab] = useState<TabId>("login");
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

  useEffect(() => {
    const t = `${draft?.name ?? "SSH Clone"}${dirty ? "*" : ""} - SSH Clone`;
    document.title = t;
    void getCurrentWindow().setTitle(t).catch(() => {});
  }, [draft?.name, dirty]);

  return (
    <div className="app">
      <header className="topbar"><span className="apptitle">SSH Clone</span><ProfileSwitcher /></header>
      <div className="body">
        <ActionBar onTab={setTab} />
        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </nav>
          <section className={tab === "terminal" || tab === "sftp" ? "tabpanel flush" : "tabpanel"}>
            {!loaded || !draft ? <div className="placeholder">Loading…</div> : (
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
