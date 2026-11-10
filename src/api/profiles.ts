// api/profiles.ts — typed wrappers for the profile commands (README §5.2) + ui_state.
// JS args are camelCase; Tauri maps them to the Rust snake_case params.
import { call } from "./invoke";
import type { Profile } from "./types";

export const profileList = () => call<Profile[]>("profile_list");
export const profileGet = (id: string) => call<Profile>("profile_get", { id });
export const profileSave = (profile: Profile) => call<Profile>("profile_save", { profile });
export const profileSaveAs = (profile: Profile, newName: string) =>
  call<Profile>("profile_save_as", { profile, newName });
export const profileDelete = (id: string) => call<void>("profile_delete", { id });
export const profileExport = (id: string, path: string) => call<void>("profile_export", { id, path });
export const profileImport = (path: string) => call<Profile>("profile_import", { path });

// H1 contract additions (documented in README §5.2)
export const uiStateGet = () => call<{ lastActiveProfileId: string | null }>("ui_state_get");
export const uiStateSet = (lastActiveProfileId: string | null) =>
  call<void>("ui_state_set", { lastActiveProfileId });
