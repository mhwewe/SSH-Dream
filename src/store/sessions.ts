// store/sessions.ts — zustand store: per-PROFILE session state + terminal tabs + credential prompt.
//
// Who uses it: ProfileSwitcher (dots), ActionBar (Log in / Log out / New terminal console),
//              TerminalTab / TerminalView, PasswordDialog, App.tsx (calls init() once).
//
// Key points (HANDOFF-2 §5.4):
//  * State is tracked per profile, so a background profile's dot is always right. It is updated
//    only by `session://state` events + the optimistic "connecting" set in connect().
//  * Terminal tabs belong to a profile and are never destroyed by switching profiles.

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppError, Profile, SessionState } from "../api/types";
import { sessionConnect, sessionDisconnect, type ConnectOverrides } from "../api/session";

export interface ProfileSession {
  sessionId: string | null;
  state: SessionState;
  /** Last error text, shown by the Login tab if you want to (optional). */
  lastError?: string;
}

export interface TermTab {
  /** Local id (stable before the backend's channelId exists). */
  id: string;
  profileId: string;
  sessionId: string;
  channelId: string | null;
  title: string;
  /** Set when `term://closed` arrives; the view prints "[Connection closed]". */
  closed: boolean;
  /** Terminal settings copied from the profile at open time (so background tabs keep theirs). */
  font: { fontFamily: string; fontSize: number; scrollback: number };
}

/** "Please type the password / key passphrase" request (rendered by PasswordDialog). */
export interface CredentialPrompt {
  profileId: string;
  kind: "ssh" | "key_passphrase";
}

interface SessionsStore {
  byProfile: Record<string, ProfileSession>;
  tabs: TermTab[];
  activeTabByProfile: Record<string, string>;
  credPrompt: CredentialPrompt | null;

  /** Subscribe to backend events. Safe to call more than once. */
  init: () => Promise<void>;
  connect: (profileId: string, overrides?: ConnectOverrides) => Promise<void>;
  disconnect: (profileId: string) => Promise<void>;
  submitCredential: (value: string, remember: boolean) => Promise<void>;
  cancelCredential: () => void;

  openTerminal: (profile: Profile) => string | null;
  closeTab: (tabId: string) => void;
  setActiveTab: (profileId: string, tabId: string) => void;
  setChannel: (tabId: string, channelId: string) => void;
}

const asAppError = (e: unknown): AppError =>
  typeof e === "object" && e !== null && "code" in e
    ? (e as AppError)
    : { code: "internal", message: String(e) };

let initPromise: Promise<void> | null = null;
let tabCounter = 0;

export const useSessions = create<SessionsStore>((set, get) => ({
  byProfile: {},
  tabs: [],
  activeTabByProfile: {},
  credPrompt: null,

  init: () => {
    if (!initPromise) {
      initPromise = (async () => {
        // Backend -> state of a profile's session.
        await listen<{ sessionId: string; profileId: string; state: SessionState }>("session://state", (e) => {
          const { sessionId, profileId, state } = e.payload;
          set((s) => ({
            byProfile: {
              ...s.byProfile,
              [profileId]: { sessionId, state, lastError: s.byProfile[profileId]?.lastError },
            },
          }));
        });
        // Backend -> a terminal ended (shell exit, server drop, logout).
        await listen<{ channelId: string; sessionId: string; exitStatus?: number }>("term://closed", (e) => {
          set((s) => ({
            tabs: s.tabs.map((t) => (t.channelId === e.payload.channelId ? { ...t, closed: true } : t)),
          }));
        });
      })();
    }
    return initPromise;
  },

  connect: async (profileId, overrides) => {
    set((s) => ({
      byProfile: {
        ...s.byProfile,
        [profileId]: { sessionId: s.byProfile[profileId]?.sessionId ?? null, state: "connecting" },
      },
    }));
    try {
      const sessionId = await sessionConnect(profileId, overrides);
      set((s) => ({
        byProfile: { ...s.byProfile, [profileId]: { sessionId, state: "connected" } },
      }));
    } catch (raw) {
      const err = asAppError(raw);
      if (err.code === "auth_failed" && (err.message === "password_required" || err.message === "passphrase_required")) {
        // Not a failure: ask the user for the secret, then retry (HANDOFF-2 §5.3).
        set((s) => ({
          byProfile: { ...s.byProfile, [profileId]: { sessionId: null, state: "disconnected" } },
          credPrompt: { profileId, kind: err.message === "password_required" ? "ssh" : "key_passphrase" },
        }));
        return;
      }
      set((s) => ({
        byProfile: {
          ...s.byProfile,
          [profileId]: { sessionId: null, state: "error", lastError: err.message },
        },
      }));
    }
  },

  disconnect: async (profileId) => {
    const sid = get().byProfile[profileId]?.sessionId;
    // While "connecting" there is no backend session yet (known limitation, see HANDOFF-LOG).
    if (!sid) return;
    try {
      await sessionDisconnect(sid);
    } catch {
      /* the session:// state event still arrives; nothing to do */
    }
  },

  submitCredential: async (value, remember) => {
    const prompt = get().credPrompt;
    if (!prompt) return;
    // Clear the prompt AND show "connecting" in one update, so anything waiting for the login to settle
    // (the auto-start flow in App.tsx) never sees a "disconnected, no prompt" gap.
    set((s) => ({
      credPrompt: null,
      byProfile: { ...s.byProfile, [prompt.profileId]: { sessionId: null, state: "connecting" } },
    }));
    if (remember) {
      // secret_set is a Handoff-1 command; the value goes straight to the OS keyring.
      try {
        await invoke("secret_set", { profileId: prompt.profileId, kind: prompt.kind, value });
      } catch {
        /* storing is best-effort; the login below still uses the typed value */
      }
    }
    await get().connect(
      prompt.profileId,
      prompt.kind === "ssh" ? { sshPassword: value } : { keyPassphrase: value },
    );
  },

  cancelCredential: () => set({ credPrompt: null }),

  openTerminal: (profile) => {
    const ps = get().byProfile[profile.id];
    if (!ps || ps.state !== "connected" || !ps.sessionId) return null;
    const id = `tab-${++tabCounter}`;
    const count = get().tabs.filter((t) => t.profileId === profile.id).length;
    const tab: TermTab = {
      id,
      profileId: profile.id,
      sessionId: ps.sessionId,
      channelId: null,
      title: `Terminal ${count + 1}`,
      closed: false,
      font: {
        fontFamily: profile.terminal.fontFamily,
        fontSize: profile.terminal.fontSize,
        scrollback: profile.terminal.scrollback,
      },
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabByProfile: { ...s.activeTabByProfile, [profile.id]: id },
    }));
    return id;
  },

  closeTab: (tabId) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId);
      if (!tab) return s;
      const rest = s.tabs.filter((t) => t.id !== tabId);
      const active = { ...s.activeTabByProfile };
      if (active[tab.profileId] === tabId) {
        const left = rest.filter((t) => t.profileId === tab.profileId);
        if (left.length) active[tab.profileId] = left[left.length - 1].id;
        else delete active[tab.profileId];
      }
      return { tabs: rest, activeTabByProfile: active };
    }),

  setActiveTab: (profileId, tabId) =>
    set((s) => ({ activeTabByProfile: { ...s.activeTabByProfile, [profileId]: tabId } })),

  setChannel: (tabId, channelId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, channelId } : t)) })),
}));
