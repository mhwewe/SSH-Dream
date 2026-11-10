// api/session.ts — typed wrappers for the session + host-key commands (README §5.2).
//
// Who uses it:  store/sessions.ts (connect/disconnect) and components/HostKeyDialog.tsx.
// Rule (README §3): ONE file per domain, typed wrappers around invoke(), no logic.
//
// Every command rejects with an `AppError` ({ code, message }); see README §5.1.

import { invoke } from "@tauri-apps/api/core";
import type { SessionState } from "./types";

/** Optional secrets for one connect attempt. They are only passed through, never stored here. */
export interface ConnectOverrides {
  sshPassword?: string;
  keyPassphrase?: string;
}

/** Log in. Resolves with the sessionId (the existing one if the profile is already connected). */
export function sessionConnect(profileId: string, overrides?: ConnectOverrides): Promise<string> {
  return invoke<string>("session_connect", { profileId, overrides });
}

export function sessionDisconnect(sessionId: string): Promise<void> {
  return invoke<void>("session_disconnect", { sessionId });
}

export function sessionState(sessionId: string): Promise<SessionState> {
  return invoke<SessionState>("session_state", { sessionId });
}

/** Answer a `hostkey://prompt`. `remember` only matters when `accept` is true. */
export function hostKeyDecide(promptId: string, accept: boolean, remember: boolean): Promise<void> {
  return invoke<void>("host_key_decide", { promptId, accept, remember });
}
