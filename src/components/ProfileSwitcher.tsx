// ProfileSwitcher.tsx — header dropdown: pick the ACTIVE profile (never disconnects others),
// plus New / Rename / Duplicate(=save as) / Delete / Import / Export. Each row shows a state dot.
// Dirty-check (Save/Discard/Cancel) is handled inside the store's switchTo/createNew.
// Polish: fully keyboard-operable menu (Enter/Space/Down opens, Up/Down/Home/End move, Esc closes and returns focus,
// Tab closes), proper ARIA (menu / menuitemradio), unsaved-changes asterisk, and the host shown under each name.
import { useEffect, useRef, useState } from "react";
import { useProfiles } from "../store/profiles";
import { useSessions } from "../store/sessions";
import { StatusDot } from "./StatusDot";
import { IconChevronDown, IconCheck } from "./icons";

export function ProfileSwitcher() {
  const { profiles, activeId, switchTo, createNew, rename, saveAs, remove, importProfile, exportProfile } = useProfiles();
  const dirty = useProfiles((s) => s.isDirty());
  const byProfile = useSessions((s) => s.byProfile);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // Focus the active (or first) item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]");
    const active = menuRef.current?.querySelector<HTMLElement>("[aria-checked=true]");
    (active ?? items?.[0])?.focus();
  }, [open]);

  const active = profiles.find((p) => p.id === activeId);
  const stateOf = (id: string) => byProfile[id]?.state ?? "disconnected";
  const close = (refocus = true) => { setOpen(false); if (refocus) btnRef.current?.focus(); };
  const act = (fn: () => Promise<void>) => () => { close(false); void fn(); };

  function onMenuKey(e: React.KeyboardEvent) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") setOpen(false);
  }
  const itemKey = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };

  return (
    <div className="switcher" ref={ref}>
      <button ref={btnRef} className="switcher-btn" aria-haspopup="menu" aria-expanded={open} title="Switch profile"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }}>
        {activeId && <StatusDot state={stateOf(activeId)} />}
        <span className="switcher-name">{active?.name ?? "No profile"}{dirty ? " *" : ""}</span>
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="switcher-menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
          {profiles.map((p) => {
            const pick = () => { close(false); void switchTo(p.id); };
            return (
              <div key={p.id} role="menuitemradio" aria-checked={p.id === activeId} tabIndex={-1}
                className={`switcher-item ${p.id === activeId ? "active" : ""}`} onClick={pick} onKeyDown={itemKey(pick)}>
                <StatusDot state={stateOf(p.id)} />
                <span className="switcher-label">
                  <span>{p.name}</span>
                  {p.ssh.host && <span className="switcher-sub">{p.ssh.username ? `${p.ssh.username}@` : ""}{p.ssh.host}</span>}
                </span>
                {p.id === activeId && <IconCheck size={14} />}
              </div>
            );
          })}
          <div className="menu-sep" role="separator" />
          {([
            ["New profile…", createNew],
            ["Rename…", rename],
            ["Duplicate…", saveAs],
            ["Delete…", async () => { if (activeId) await remove(activeId); }],
            ["Import…", importProfile],
            ["Export…", exportProfile],
          ] as [string, () => Promise<void>][]).map(([label, fn]) => (
            <div key={label} role="menuitem" tabIndex={-1} className="switcher-item" onClick={act(fn)} onKeyDown={itemKey(act(fn))}>{label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
