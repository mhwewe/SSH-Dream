// ActionBar.tsx — left button column (Bitvise style), compact SQUARE icon buttons.
// Every button has a tooltip (title, with its keyboard shortcut) and aria-label, because there is no text on the button.
// Size is one CSS variable: --ab-size in styles.css (.actionbar).
// Save / Save as call the profiles store.
//   * New terminal console (H2): opens a terminal on the active profile's session (if logged in).
//   * New SFTP window (H3): focuses the SFTP tab; the tab opens the profile's SFTP channel lazily
//     (one SFTP view per session is enough — HANDOFF-3 §3).
//   * New Remote Desktop: focuses the RDP tab.
//   * Bottom: theme switch (Follow Windows / Light / Dark / Catppuccin Latte; the Options page has a picker too).
// Polish: the Save button shows a dot when there are unsaved changes, and the theme button is new.
import type { ReactNode } from "react";
import { useProfiles } from "../store/profiles";
import { useSessions } from "../store/sessions";
import { themeLabel, useTheme, type ThemePref } from "../store/theme";
import { toast } from "../store/toasts";
import type { TabId } from "../App"; // type-only: no runtime circular import
import { IconAuto, IconCoffee, IconDesktop, IconFolder, IconLogin, IconLogout, IconMoon, IconSave, IconSaveAs, IconSun, IconTerminal } from "./icons";

/** One icon per theme choice (shown on the theme button at the bottom of the bar). */
const THEME_ICON: Record<ThemePref, ReactNode> = { auto: <IconAuto />, light: <IconSun />, dark: <IconMoon />, latte: <IconCoffee /> };

/** Log in with the profile shown in the header (shared by the action bar, the Login tab and the Ctrl+Enter shortcut). */
export async function logInActive() {
  const { draft: d, saveDraft, pending } = useProfiles.getState();
  if (!d) return;
  const now = useSessions.getState().byProfile[d.id]?.state;
  if (now === "connecting" || now === "connected") return; // a second click / Enter while logging in does nothing
  if (!d.ssh.host.trim() || !d.ssh.username.trim()) { toast("Fill in host and username first", "error"); return; }
  const saved = await saveDraft(); // backend connects from the SAVED profile
  if (!saved) return;
  await useSessions.getState().connect(saved.id, {
    sshPassword: pending.ssh || undefined,          // one-time (not stored) secrets typed in the UI
    keyPassphrase: pending.key_passphrase || undefined,
  });
}

export function ActionBar({ onTab }: { onTab: (t: TabId) => void }) {
  const activeId = useProfiles((s) => s.activeId);
  const dirty = useProfiles((s) => s.isDirty());
  const sessionState = useSessions((s) => (activeId ? s.byProfile[activeId]?.state ?? "disconnected" : "disconnected"));

  const saveDraft = useProfiles((s) => s.saveDraft);
  const saveAs = useProfiles((s) => s.saveAs);
  const activeProfile = useProfiles((s) => s.profiles.find((p) => p.id === s.activeId) ?? null);
  const openTerminal = useSessions((s) => s.openTerminal);
  const themePref = useTheme((s) => s.pref);
  const cycleTheme = useTheme((s) => s.cycle);

  function newTerminal() {
    onTab("terminal");
    if (!activeProfile) return;
    if (!openTerminal(activeProfile)) toast("Log in first to open a terminal", "error");
  }
  async function logOut() { if (activeId) await useSessions.getState().disconnect(activeId); }

  const btn = (label: string, icon: ReactNode, onClick: () => void, extra?: { badge?: boolean; shortcut?: string }) => (
    <button className="ab-btn" title={extra?.shortcut ? `${label} (${extra.shortcut})` : label} aria-label={label} onClick={onClick}>
      {icon}{extra?.badge && <span className="ab-badge" aria-hidden="true" />}
    </button>
  );

  return (
    <aside className="actionbar" aria-label="Actions">
      {/* One button: Log in -> Connecting… -> Log out (follows the profile shown in the header). */}
      {sessionState === "connected" ? (
        <button className="ab-btn ab-session" title="Log out" aria-label="Log out" onClick={() => void logOut()}>
          <IconLogout /><span>Log out</span>
        </button>
      ) : (
        <button className="ab-btn ab-session is-in" title="Log in (Ctrl+Enter)" aria-label="Log in" disabled={sessionState === "connecting"}
          onClick={() => void logInActive()}>
          <IconLogin /><span>{sessionState === "connecting" ? "Wait…" : "Log in"}</span>
        </button>
      )}
      <hr />
      {btn("Save profile", <IconSave />, () => void saveDraft(), { badge: dirty, shortcut: "Ctrl+S" })}
      {btn("Save profile as…", <IconSaveAs />, () => void saveAs())}
      <hr />
      {btn("New terminal console", <IconTerminal />, newTerminal, { shortcut: "Ctrl+Shift+T" })}
      {btn("New SFTP window", <IconFolder />, () => onTab("sftp"))}
      {btn("New Remote Desktop", <IconDesktop />, () => onTab("rdp"))}
      <span className="ab-spacer" />
      {btn(`Theme: ${themeLabel(themePref)} (click to change)`, THEME_ICON[themePref], cycleTheme)}
    </aside>
  );
}
