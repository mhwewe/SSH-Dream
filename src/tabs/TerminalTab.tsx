// tabs/TerminalTab.tsx — the "Terminal" tab: sub-tabs (one per terminal channel) + "+" button.
//
// IMPORTANT for App.tsx: keep this component MOUNTED when the user switches to another top-level
// tab (hide it with CSS, e.g. `display:none`), otherwise all terminals would be destroyed.
// Pass `active` = whether the Terminal tab is currently the visible top-level tab.
//
// It renders the terminals of ALL profiles (hidden unless they belong to the active profile and
// the selected sub-tab), so scrollback and running programs survive profile switching.
//
// Polish: sub-tabs are real ARIA tabs (arrow keys), middle-click or × closes, double-click renames, a tab whose shell has
// ended shows a bar with "Open a new terminal", and shortcuts work while this tab is visible:
//   Ctrl+Shift+W close tab · Ctrl+Tab / Ctrl+Shift+Tab next / previous tab · Ctrl+Shift+F find (inside the terminal).

import { useEffect, type KeyboardEvent } from "react";
import type { Profile } from "../api/types";
import TerminalView from "../components/TerminalView";
import { useSessions } from "../store/sessions";
import { dialogs } from "../store/dialogs";
import { IconClose, IconPlus } from "../components/icons";

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
  const renameTab = useSessions((s) => s.renameTab);
  const setActiveTab = useSessions((s) => s.setActiveTab);
  const connect = useSessions((s) => s.connect);

  const profileId = profile?.id ?? null;
  const state = (profileId && byProfile[profileId]?.state) || "disconnected";
  const myTabs = tabs.filter((t) => t.profileId === profileId);
  const activeId = profileId ? activeTabByProfile[profileId] : undefined;
  const activeTab = myTabs.find((t) => t.id === activeId);
  const connected = state === "connected";

  // Keyboard shortcuts for the terminal sub-tabs (only while the Terminal tab is in front).
  useEffect(() => {
    if (!active || !profileId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const list = useSessions.getState().tabs.filter((t) => t.profileId === profileId);
      const cur = useSessions.getState().activeTabByProfile[profileId];
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyW" && cur) {
        e.preventDefault();
        closeTab(cur);
      } else if (e.ctrlKey && !e.altKey && e.key === "Tab" && list.length > 1) {
        e.preventDefault();
        const i = list.findIndex((t) => t.id === cur);
        setActiveTab(profileId, list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, profileId, closeTab, setActiveTab]);

  async function rename(id: string, current: string) {
    const name = await dialogs.prompt("Rename terminal", current);
    if (name) renameTab(id, name);
  }
  function onTabKey(e: KeyboardEvent, i: number) {
    if (!profileId) return;
    const go = (n: number) => { e.preventDefault(); const t = myTabs[(n + myTabs.length) % myTabs.length]; setActiveTab(profileId, t.id); };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveTab(profileId, myTabs[i].id); }
    else if (e.key === "F2") { e.preventDefault(); void rename(myTabs[i].id, myTabs[i].title); }
    else if (e.key === "Delete") { e.preventDefault(); closeTab(myTabs[i].id); }
  }

  return (
    <div className="term-tab">
      {/* Sub-tab strip */}
      <div className="term-strip" role="tablist" aria-label="Terminals">
        {myTabs.map((t, i) => (
          <div
            key={t.id}
            role="tab"
            tabIndex={t.id === activeId ? 0 : -1}
            aria-selected={t.id === activeId}
            title={t.closed ? `${t.title} (ended) - double-click to rename` : `${t.title} - double-click to rename, middle-click to close`}
            className={`term-subtab${t.id === activeId ? " is-active" : ""}${t.closed ? " is-closed" : ""}`}
            onClick={() => profileId && setActiveTab(profileId, t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            onDoubleClick={() => void rename(t.id, t.title)}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); /* no autoscroll cursor */ }}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
          >
            <span className={`term-live${t.closed ? " off" : ""}`} aria-hidden="true" />
            <span className="term-title">{t.title}</span>
            {/* "Close tab" is offered for every tab; for a live one it also closes the channel. */}
            <button
              className="term-x"
              title="Close tab (Ctrl+Shift+W)"
              aria-label={`Close ${t.title}`}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <IconClose size={12} />
            </button>
          </div>
        ))}
        <button
          className="term-plus"
          title={connected ? "New terminal console (Ctrl+Shift+T)" : "Log in first"}
          aria-label="New terminal console"
          disabled={!connected || !profile}
          onClick={() => profile && openTerminal(profile)}
        >
          <IconPlus size={14} />
        </button>
      </div>

      {/* Viewport: every terminal of every profile stays mounted. */}
      <div className="term-viewport">
        {tabs.map((t) => {
          const visible = active && t.profileId === profileId && t.id === activeId;
          return (
            <div key={t.id} className="term-pane" role="tabpanel" style={{ display: visible ? "block" : "none" }}>
              <TerminalView tab={t} visible={visible} />
            </div>
          );
        })}

        {/* The shell of the shown tab has ended (exit, server drop, log out). */}
        {profile && activeTab?.closed && (
          <div className="term-ended" role="status">
            <span>This terminal has ended.</span>
            <button disabled={!connected} onClick={() => { closeTab(activeTab.id); openTerminal(profile); }}>
              {connected ? "Open a new terminal" : "Log in to open a new one"}
            </button>
          </div>
        )}

        {/* Empty states */}
        {profile && myTabs.length === 0 && !connected && (
          <div className="term-empty">
            <p>Log in first to open a terminal.</p>
            <button className="primary" disabled={state === "connecting"} onClick={() => void connect(profile.id)}>
              {state === "connecting" ? "Connecting…" : "Log in"}
            </button>
          </div>
        )}
        {profile && myTabs.length === 0 && connected && (
          <div className="term-empty">
            <p>No terminal open.</p>
            <button className="primary" onClick={() => openTerminal(profile)}>New terminal console</button>
          </div>
        )}
      </div>
    </div>
  );
}
