// ActionBar.tsx — left button column (Bitvise style), now compact SQUARE icon buttons.
// Every button has a tooltip (title) and aria-label, because there is no text on the button itself.
// Size is one CSS variable: --ab-size in styles.css (.actionbar).
// Save / Save as call the profiles store.
//   * New terminal console (H2): opens a terminal on the active profile's session (if logged in).
//   * New SFTP window (H3): focuses the SFTP tab; the tab opens the profile's SFTP channel lazily
//     (one SFTP view per session is enough — HANDOFF-3 §3).
//   * New Remote Desktop: focuses the RDP tab.
import type { ReactNode } from "react";
import { useProfiles } from "../store/profiles";
import { useSessions } from "../store/sessions";
import { toast } from "../store/toasts";
import type { TabId } from "../App"; // type-only: no runtime circular import

/** 20x20 stroke icons that follow the text colour (no emoji: they render differently per Windows build). */
const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IconSave = () => (
  <Svg><path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M8 3v5h7V3" /><rect x="7" y="13" width="10" height="8" /></Svg>
);
const IconSaveAs = () => (
  <Svg><path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z" /><path d="M13 3v6h6" /><path d="M12 12v6" /><path d="M9 15h6" /></Svg>
);
const IconTerminal = () => (
  <Svg><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3" /><path d="M13 15h4" /></Svg>
);
const IconFolder = () => (
  <Svg><path d="M3 6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></Svg>
);
const IconDesktop = () => (
  <Svg><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6" /><path d="M12 16v4" /></Svg>
);

const IconLogin = () => (
  <Svg><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" /><path d="M10 8l4 4-4 4" /><path d="M14 12H4" /></Svg>
);
const IconLogout = () => (
  <Svg><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5" /><path d="M16 8l4 4-4 4" /><path d="M20 12H10" /></Svg>
);

export function ActionBar({ onTab }: { onTab: (t: TabId) => void }) {
  const activeId = useProfiles((s) => s.activeId);
  const sessionState = useSessions((s) => (activeId ? s.byProfile[activeId]?.state ?? "disconnected" : "disconnected"));

  const saveDraft = useProfiles((s) => s.saveDraft);
  const saveAs = useProfiles((s) => s.saveAs);
  const activeProfile = useProfiles((s) => s.profiles.find((p) => p.id === s.activeId) ?? null);
  const openTerminal = useSessions((s) => s.openTerminal);

  function newTerminal() {
    onTab("terminal");
    if (!activeProfile) return;
    if (!openTerminal(activeProfile)) toast("Log in first to open a terminal", "error");
  }

  async function logIn() {
    const { draft: d, saveDraft, pending } = useProfiles.getState();
    if (!d) return;
    if (!d.ssh.host.trim() || !d.ssh.username.trim()) { toast("Fill in host and username first", "error"); return; }
    const saved = await saveDraft(); // backend connects from the SAVED profile
    if (!saved) return;
    await useSessions.getState().connect(saved.id, {
      sshPassword: pending.ssh || undefined,          // one-time (not stored) secrets typed in the UI
      keyPassphrase: pending.key_passphrase || undefined,
    });
  }
  async function logOut() { if (activeId) await useSessions.getState().disconnect(activeId); }

  const btn = (label: string, icon: ReactNode, onClick: () => void) => (
    <button className="ab-btn" title={label} aria-label={label} onClick={onClick}>{icon}</button>
  );

  return (
    <aside className="actionbar">
      {/* One button: Log in -> Connecting… -> Log out (follows the profile shown in the header). */}
      {sessionState === "connected" ? (
        <button className="ab-btn ab-session" title="Log out" aria-label="Log out" onClick={() => void logOut()}>
          <IconLogout /><span>Log out</span>
        </button>
      ) : (
        <button className="ab-btn ab-session is-in" title="Log in" aria-label="Log in" disabled={sessionState === "connecting"}
          onClick={() => void logIn()}>
          <IconLogin /><span>{sessionState === "connecting" ? "Wait…" : "Log in"}</span>
        </button>
      )}
      <hr />
      {btn("Save profile", <IconSave />, () => void saveDraft())}
      {btn("Save profile as…", <IconSaveAs />, () => void saveAs())}
      <hr />
      {btn("New terminal console", <IconTerminal />, newTerminal)}
      {btn("New SFTP window", <IconFolder />, () => onTab("sftp"))}
      {btn("New Remote Desktop", <IconDesktop />, () => onTab("rdp"))}
    </aside>
  );
}
