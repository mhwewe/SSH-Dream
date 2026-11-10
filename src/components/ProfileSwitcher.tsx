// ProfileSwitcher.tsx — header dropdown: pick the ACTIVE profile (never disconnects others),
// plus New / Rename / Duplicate(=save as) / Delete / Import / Export. Each row shows a state dot.
// Dirty-check (Save/Discard/Cancel) is handled inside the store's switchTo/createNew.
import { useEffect, useRef, useState } from "react";
import { useProfiles } from "../store/profiles";
import { useSessions } from "../store/sessions";
import { StatusDot } from "./StatusDot";

export function ProfileSwitcher() {
  const { profiles, activeId, switchTo, createNew, rename, saveAs, remove, importProfile, exportProfile } = useProfiles();
  const byProfile = useSessions((s) => s.byProfile);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close when clicking outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const active = profiles.find((p) => p.id === activeId);
  const stateOf = (id: string) => byProfile[id]?.state ?? "disconnected";
  const act = (fn: () => Promise<void>) => () => { setOpen(false); void fn(); };

  return (
    <div className="switcher" ref={ref}>
      <button className="switcher-btn" onClick={() => setOpen(!open)}>
        {activeId && <StatusDot state={stateOf(activeId)} />}
        <span>{active?.name ?? "No profile"}</span> ▾
      </button>
      {open && (
        <div className="switcher-menu">
          {profiles.map((p) => (
            <div key={p.id} className={`switcher-item ${p.id === activeId ? "active" : ""}`}
              onClick={() => { setOpen(false); void switchTo(p.id); }}>
              <StatusDot state={stateOf(p.id)} /> {p.name}
            </div>
          ))}
          <hr />
          <div className="switcher-item" onClick={act(createNew)}>＋ New profile</div>
          <div className="switcher-item" onClick={act(rename)}>Rename…</div>
          <div className="switcher-item" onClick={act(saveAs)}>Duplicate…</div>
          <div className="switcher-item" onClick={act(async () => { if (activeId) await remove(activeId); })}>Delete…</div>
          <div className="switcher-item" onClick={act(importProfile)}>Import…</div>
          <div className="switcher-item" onClick={act(exportProfile)}>Export…</div>
        </div>
      )}
    </div>
  );
}
