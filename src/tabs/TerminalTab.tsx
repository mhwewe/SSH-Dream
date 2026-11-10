// tabs/TerminalTab.tsx — the "Terminal" tab: sub-tabs (one per terminal channel) + "+" button.
//
// IMPORTANT for App.tsx: keep this component MOUNTED when the user switches to another top-level
// tab (hide it with CSS, e.g. `display:none`), otherwise all terminals would be destroyed.
// Pass `active` = whether the Terminal tab is currently the visible top-level tab.
//
// It renders the terminals of ALL profiles (hidden unless they belong to the active profile and
// the selected sub-tab), so scrollback and running programs survive profile switching.

import type { Profile } from "../api/types";
import TerminalView from "../components/TerminalView";
import { useSessions } from "../store/sessions";

interface Props {
  /** The profile selected in the profile switcher (null = none). */
  profile: Profile | null;
  /** True when the Terminal tab is the visible top-level tab. */
  active: boolean;
}

export default function TerminalTab({ profile, active }: Props) {
  const tabs = useSessions((s) => s.tabs);
  const activeTabByProfile = useSessions((s) => s.activeTabByProfile);
  const byProfile = useSessions((s) => s.byProfile);
  const openTerminal = useSessions((s) => s.openTerminal);
  const closeTab = useSessions((s) => s.closeTab);
  const setActiveTab = useSessions((s) => s.setActiveTab);
  const connect = useSessions((s) => s.connect);

  const profileId = profile?.id ?? null;
  const state = (profileId && byProfile[profileId]?.state) || "disconnected";
  const myTabs = tabs.filter((t) => t.profileId === profileId);
  const activeId = profileId ? activeTabByProfile[profileId] : undefined;
  const connected = state === "connected";

  return (
    <div className="term-tab">
      {/* Sub-tab strip */}
      <div className="term-strip">
        {myTabs.map((t) => (
          <div
            key={t.id}
            className={`term-subtab${t.id === activeId ? " is-active" : ""}${t.closed ? " is-closed" : ""}`}
            onClick={() => profileId && setActiveTab(profileId, t.id)}
          >
            <span>{t.title}</span>
            {/* "Close tab" is offered for every tab; for a live one it also closes the channel. */}
            <button
              className="term-x"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="term-plus"
          title={connected ? "New terminal console" : "Log in first"}
          disabled={!connected || !profile}
          onClick={() => profile && openTerminal(profile)}
        >
          +
        </button>
      </div>

      {/* Viewport: every terminal of every profile stays mounted. */}
      <div className="term-viewport">
        {tabs.map((t) => {
          const visible = active && t.profileId === profileId && t.id === activeId;
          return (
            <div key={t.id} className="term-pane" style={{ display: visible ? "block" : "none" }}>
              <TerminalView tab={t} visible={visible} />
            </div>
          );
        })}

        {/* Empty states */}
        {profile && myTabs.length === 0 && !connected && (
          <div className="term-empty">
            <p>Log in first to open a terminal.</p>
            <button disabled={state === "connecting"} onClick={() => void connect(profile.id)}>
              {state === "connecting" ? "Connecting…" : "Log in"}
            </button>
          </div>
        )}
        {profile && myTabs.length === 0 && connected && (
          <div className="term-empty">
            <p>No terminal open.</p>
            <button onClick={() => openTerminal(profile)}>New terminal console</button>
          </div>
        )}
      </div>
    </div>
  );
}
