// api/rdp.ts — launches mstsc.exe for a SAVED profile (backend reads the profile from disk).
import { call } from "./invoke";

export const rdpLaunch = (profileId: string) => call<void>("rdp_launch", { profileId });
