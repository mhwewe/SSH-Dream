// api/invoke.ts — the ONE place that calls Tauri's invoke(). Normalizes rejections to AppError.
// Every api/*.ts wrapper goes through `call`. Rejections are plain { code, message } objects.
import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "./types";

export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
  return { code: "internal", message: String(e) };
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}
