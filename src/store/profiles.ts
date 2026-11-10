// =============================================================================
// store/profiles.ts — the heart of the UI state.
//   profiles : saved profiles (as on disk)
//   activeId : selected profile (persisted via ui_state.json)
//   draft    : EDITED COPY of the active profile; tabs edit this, "Save" writes it to disk
//   pending  : secrets typed but not yet stored (password/passphrase text fields). Lives only in
//              memory; stored kinds are written to the keyring on save and then cleared.
//   exists   : whether the keyring holds a secret per kind (drives the "•••• (saved)" placeholder)
// Dirty = draft differs from saved copy OR there is a pending secret for a kind that will be stored.
// Which flag controls which secret: ssh & key_passphrase -> ssh.storePassword, rdp -> rdp.storePassword.
// =============================================================================
import { create } from "zustand";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Profile } from "../api/types";
import * as api from "../api/profiles";
import { SECRET_KINDS, secretDelete, secretExists, secretSet, type SecretKind } from "../api/secrets";
import { toAppError } from "../api/invoke";
import { toast } from "./toasts";
import { dialogs } from "./dialogs";
import { parseResolution, MIN_DIM, MAX_DIM } from "../lib/resolution";

type Flags<T> = Record<SecretKind, T>;
const emptyPending = (): Flags<string> => ({ ssh: "", rdp: "", key_passphrase: "" });
const noneExist = (): Flags<boolean> => ({ ssh: false, rdp: false, key_passphrase: false });

/** Defaults identical to the Rust Profile::default_new (README §5.1). */
export function defaultProfile(name: string): Profile {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, id: crypto.randomUUID(), name,
    ssh: { host: "", port: 22, username: "", authMethod: "password", keyPath: null, storePassword: false, autoLogin: true },
    rdp: { host: null, port: 3389, username: null, storePassword: false, fullscreen: false, resolution: null, smartResize: true },
    terminal: { fontFamily: "Cascadia Mono", fontSize: 14, scrollback: 5000, termType: "xterm-256color" },
    createdAt: now, updatedAt: now,
  };
}

/** Which secret kinds are persisted for this profile (according to the checkboxes). */
function storedFlag(d: Profile, kind: SecretKind): boolean {
  return kind === "rdp" ? d.rdp.storePassword : d.ssh.storePassword;
}

const stripTimes = (p: Profile) => JSON.stringify({ ...p, updatedAt: "", createdAt: "" });

interface ProfilesStore {
  profiles: Profile[];
  activeId: string | null;
  draft: Profile | null;
  pending: Flags<string>;
  exists: Flags<boolean>;
  loaded: boolean;

  init: () => Promise<void>;
  patchDraft: (fn: (d: Profile) => void) => void;
  setPending: (kind: SecretKind, value: string) => void;
  isDirty: () => boolean;
  switchTo: (id: string) => Promise<void>;
  createNew: () => Promise<void>;
  saveDraft: () => Promise<Profile | null>;
  saveAs: () => Promise<void>;
  rename: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  importProfile: () => Promise<void>;
  exportProfile: () => Promise<void>;
}

export const useProfiles = create<ProfilesStore>((set, get) => {
  /** Make `p` the active profile: load it into the draft, refresh secret flags, persist choice. */
  async function activate(p: Profile) {
    const exists = noneExist();
    for (const k of SECRET_KINDS) {
      try { exists[k] = await secretExists(p.id, k); } catch { /* keyring problem: treat as none */ }
    }
    set({ activeId: p.id, draft: structuredClone(p), pending: emptyPending(), exists });
    try { await api.uiStateSet(p.id); } catch { /* non-fatal */ }
  }

  /** Replace/insert a profile in the saved list (keeps it sorted by name). */
  function upsert(p: Profile) {
    set((s) => ({
      profiles: [...s.profiles.filter((x) => x.id !== p.id), p].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    }));
  }

  /** Write pending secrets / delete unticked ones for profile `p`. Throws on keyring errors. */
  async function applySecrets(p: Profile, pending: Flags<string>, exists: Flags<boolean>): Promise<Flags<boolean>> {
    const next = { ...exists };
    for (const kind of SECRET_KINDS) {
      if (!storedFlag(p, kind)) {
        if (next[kind]) { await secretDelete(p.id, kind); next[kind] = false; }
      } else if (pending[kind]) {
        await secretSet(p.id, kind, pending[kind]); next[kind] = true;
      }
    }
    return next;
  }

  /** If there are unsaved changes ask Save / Discard / Cancel. Returns false when cancelled. */
  async function guardDirty(): Promise<boolean> {
    if (!get().isDirty()) return true;
    const pick = await dialogs.choose("Unsaved changes", "The current profile has unsaved changes.", ["Save", "Discard", "Cancel"]);
    if (pick === "Save") return (await get().saveDraft()) !== null;
    return pick === "Discard";
  }

  const fail = (e: unknown) => toast(toAppError(e).message, "error");

  return {
    profiles: [], activeId: null, draft: null, pending: emptyPending(), exists: noneExist(), loaded: false,

    async init() {
      try {
        let list = await api.profileList();
        if (list.length === 0) list = [await api.profileSave(defaultProfile("New profile"))];
        set({ profiles: list });
        const last = (await api.uiStateGet()).lastActiveProfileId;
        await activate(list.find((p) => p.id === last) ?? list[0]);
      } catch (e) { fail(e); }
      set({ loaded: true });
    },

    patchDraft(fn) {
      set((s) => {
        if (!s.draft) return s;
        const d = structuredClone(s.draft); fn(d); return { draft: d };
      });
    },

    setPending(kind, value) { set((s) => ({ pending: { ...s.pending, [kind]: value } })); },

    isDirty() {
      const { draft, activeId, profiles, pending } = get();
      if (!draft) return false;
      const saved = profiles.find((p) => p.id === activeId);
      if (!saved || stripTimes(saved) !== stripTimes(draft)) return true;
      return SECRET_KINDS.some((k) => pending[k] !== "" && storedFlag(draft, k));
    },

    async switchTo(id) {
      if (id === get().activeId) return;
      if (!(await guardDirty())) return;
      const p = get().profiles.find((x) => x.id === id);
      if (p) await activate(p);
    },

    async createNew() {
      if (!(await guardDirty())) return;
      const name = await dialogs.prompt("New profile name", "New profile");
      if (!name || !name.trim()) return;
      try {
        const saved = await api.profileSave(defaultProfile(name.trim()));
        upsert(saved); await activate(saved);
      } catch (e) { fail(e); }
    },

    async saveDraft() {
      const { draft, pending, exists } = get();
      if (!draft) return null;
      if (!draft.name.trim()) { toast("Profile name must not be empty", "error"); return null; }
      if (!(draft.ssh.port >= 1 && draft.ssh.port <= 65535) || !(draft.rdp.port >= 1 && draft.rdp.port <= 65535)) {
        toast("Ports must be between 1 and 65535", "error"); return null;
      }
      if (parseResolution(draft.rdp.resolution ?? "") === false) {
        toast(`RDP resolution must look like 1920x1080 (each side ${MIN_DIM}-${MAX_DIM})`, "error"); return null;
      }
      try {
        const saved = await api.profileSave(draft);          // 1. profile JSON (no secrets)
        const nextExists = await applySecrets(saved, pending, exists); // 2. keyring
        const keep = emptyPending();                          // 3. clear stored kinds, keep session-only ones
        for (const k of SECRET_KINDS) if (!storedFlag(saved, k)) keep[k] = pending[k];
        upsert(saved);
        set({ draft: structuredClone(saved), pending: keep, exists: nextExists });
        return saved;
      } catch (e) { fail(e); return null; }
    },

    async saveAs() {
      const { draft, pending } = get();
      if (!draft) return;
      const name = await dialogs.prompt("Save profile as", `${draft.name} copy`);
      if (!name || !name.trim()) return;
      try {
        const copy = await api.profileSaveAs(draft, name.trim()); // backend copies stored secrets
        const exists = noneExist();
        for (const k of SECRET_KINDS) exists[k] = await secretExists(copy.id, k);
        const nextExists = await applySecrets(copy, pending, exists); // newly typed secrets go to the COPY
        upsert(copy);
        set({ activeId: copy.id, draft: structuredClone(copy), pending: emptyPending(), exists: nextExists });
        await api.uiStateSet(copy.id);
      } catch (e) { fail(e); }
    },

    async rename() {
      const { draft, activeId, profiles } = get();
      const saved = profiles.find((p) => p.id === activeId);
      if (!draft || !saved) return;
      const name = await dialogs.prompt("Rename profile", saved.name);
      if (!name || !name.trim()) return;
      try {
        // Only the name is written; other unsaved edits stay unsaved in the draft.
        const renamed = await api.profileSave({ ...saved, name: name.trim() });
        upsert(renamed);
        set({ draft: { ...draft, name: renamed.name } });
      } catch (e) { fail(e); }
    },

    async remove(id) {
      const p = get().profiles.find((x) => x.id === id);
      if (!p) return;
      const pick = await dialogs.choose("Delete profile", `Delete "${p.name}" and its stored passwords?`, ["Delete", "Cancel"]);
      if (pick !== "Delete") return;
      try {
        await api.profileDelete(id);
        const rest = get().profiles.filter((x) => x.id !== id);
        set({ profiles: rest });
        if (get().activeId === id) {
          const next = rest[0] ?? (await api.profileSave(defaultProfile("New profile")));
          if (!rest[0]) upsert(next);
          await activate(next);
        }
      } catch (e) { fail(e); }
    },

    async importProfile() {
      if (!(await guardDirty())) return;
      try {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Profile JSON", extensions: ["json"] }] });
        if (typeof path !== "string") return;
        const p = await api.profileImport(path);
        upsert(p); await activate(p);
      } catch (e) { fail(e); }
    },

    async exportProfile() {
      const { activeId, profiles } = get();
      const p = profiles.find((x) => x.id === activeId);
      if (!p) return;
      try {
        const path = await save({ defaultPath: `${p.name}.json`, filters: [{ name: "Profile JSON", extensions: ["json"] }] });
        if (typeof path !== "string") return;
        await api.profileExport(p.id, path); // exports the SAVED version, never secrets
        toast(`Exported "${p.name}"`, "success");
      } catch (e) { fail(e); }
    },
  };
});
