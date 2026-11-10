// store/sftpPrefs.ts — what the SFTP tab remembers between app runs, per profile:
//   * lastPath   — the last folder that was open (restored when the SFTP view opens)
//   * bookmarks  — the user's bookmarked folders
// plus one global flag: whether the bookmarks panel is shown.
// Persisted through api/prefs.ts into <app_data>/sftp_prefs.json (written ~0.4 s after the last change).
// Used by: store/sftp.ts (lastPath), tabs/SftpTab.tsx (bookmarks).
import { create } from "zustand";
import { sftpPrefsGet, sftpPrefsSet } from "../api/prefs";
import { baseName } from "../lib/paths";

export interface Bookmark { path: string; name: string; }
interface ProfilePrefs { lastPath: string; bookmarks: Bookmark[]; }

const MAX_BOOKMARKS = 200;
const empty = (): ProfilePrefs => ({ lastPath: "", bookmarks: [] });

interface PrefsStore {
  loaded: boolean;
  panelOpen: boolean;
  profiles: Record<string, ProfilePrefs>;

  /** Idempotent: loads the file once; later calls return the same promise. */
  load: () => Promise<void>;
  lastPathOf: (profileId: string) => string;
  bookmarksOf: (profileId: string) => Bookmark[];
  setLastPath: (profileId: string, path: string) => void;
  /** Adds the folder (no-op if already there). Default label = folder name. */
  addBookmark: (profileId: string, path: string, name?: string) => void;
  removeBookmark: (profileId: string, path: string) => void;
  renameBookmark: (profileId: string, path: string, name: string) => void;
  setPanelOpen: (open: boolean) => void;
}

let loading: Promise<void> | null = null;
let saveTimer: number | undefined;

/** Defensive parse: the file is user-editable, so never trust its shape. */
function parse(raw: Record<string, unknown>): { panelOpen: boolean; profiles: Record<string, ProfilePrefs> } {
  const out: Record<string, ProfilePrefs> = {};
  const src = (raw.profiles && typeof raw.profiles === "object" ? raw.profiles : {}) as Record<string, unknown>;
  for (const [id, v] of Object.entries(src)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const bookmarks: Bookmark[] = [];
    if (Array.isArray(o.bookmarks)) {
      for (const b of o.bookmarks) {
        const bb = b as Record<string, unknown>;
        if (bb && typeof bb.path === "string" && bb.path) {
          bookmarks.push({ path: bb.path, name: typeof bb.name === "string" && bb.name ? bb.name : labelFor(bb.path) });
        }
      }
    }
    out[id] = { lastPath: typeof o.lastPath === "string" ? o.lastPath : "", bookmarks: bookmarks.slice(0, MAX_BOOKMARKS) };
  }
  return { panelOpen: raw.panelOpen !== false, profiles: out };
}

/** "/srv/www" -> "www";  "/" -> "/". */
export const labelFor = (path: string) => baseName(path) || "/";

export const useSftpPrefs = create<PrefsStore>((set, get) => {
  function schedulePersist() {
    if (!get().loaded) return; // the file was not read yet: writing now would wipe it
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const { profiles, panelOpen } = get();
      void sftpPrefsSet({ version: 1, panelOpen, profiles }).catch(() => { /* non-fatal: memory only this run */ });
    }, 400);
  }
  function patch(profileId: string, fn: (p: ProfilePrefs) => ProfilePrefs) {
    set((s) => ({ profiles: { ...s.profiles, [profileId]: fn(s.profiles[profileId] ?? empty()) } }));
    schedulePersist();
  }

  return {
    loaded: false,
    panelOpen: true,
    profiles: {},

    load() {
      if (!loading) {
        loading = (async () => {
          try {
            const p = parse(await sftpPrefsGet());
            set({ profiles: p.profiles, panelOpen: p.panelOpen });
          } catch { /* unreadable: start empty */ }
          set({ loaded: true });
        })();
      }
      return loading;
    },

    lastPathOf: (id) => get().profiles[id]?.lastPath ?? "",
    bookmarksOf: (id) => get().profiles[id]?.bookmarks ?? [],

    setLastPath(profileId, path) {
      if (!get().loaded) return; // never overwrite the file before it was read
      if (get().profiles[profileId]?.lastPath === path) return;
      patch(profileId, (p) => ({ ...p, lastPath: path }));
    },

    addBookmark(profileId, path, name) {
      patch(profileId, (p) => {
        if (p.bookmarks.some((b) => b.path === path) || p.bookmarks.length >= MAX_BOOKMARKS) return p;
        return { ...p, bookmarks: [...p.bookmarks, { path, name: name?.trim() || labelFor(path) }] };
      });
    },
    removeBookmark(profileId, path) {
      patch(profileId, (p) => ({ ...p, bookmarks: p.bookmarks.filter((b) => b.path !== path) }));
    },
    renameBookmark(profileId, path, name) {
      const nn = name.trim();
      if (!nn) return;
      patch(profileId, (p) => ({ ...p, bookmarks: p.bookmarks.map((b) => (b.path === path ? { ...b, name: nn } : b)) }));
    },
    setPanelOpen(open) { set({ panelOpen: open }); schedulePersist(); },
  };
});
