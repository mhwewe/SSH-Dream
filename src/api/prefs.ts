// api/prefs.ts — raw load/save of sftp_prefs.json (last SFTP folder + bookmarks per profile).
// The shape is owned by store/sftpPrefs.ts; the backend just stores the JSON object.
import { call } from "./invoke";

export const sftpPrefsGet = () => call<Record<string, unknown>>("sftp_prefs_get");
export const sftpPrefsSet = (value: Record<string, unknown>) => call<void>("sftp_prefs_set", { value });
