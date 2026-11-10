// api/secrets.ts — set / exists / delete. There is NO get: secrets can never be read back.
import { call } from "./invoke";

export type SecretKind = "ssh" | "rdp" | "key_passphrase";
export const SECRET_KINDS: SecretKind[] = ["ssh", "rdp", "key_passphrase"];

export const secretSet = (profileId: string, kind: SecretKind, value: string) =>
  call<void>("secret_set", { profileId, kind, value });
export const secretExists = (profileId: string, kind: SecretKind) =>
  call<boolean>("secret_exists", { profileId, kind });
export const secretDelete = (profileId: string, kind: SecretKind) =>
  call<void>("secret_delete", { profileId, kind });
