import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";

/**
 * Upstream's link opener without the in-app browser preview, which Coder omits. Every link goes
 * to the system browser through the validated HTTP(S)-only `shell.openExternal`.
 */
export function useOpenLink(_threadRef: ScopedThreadRef | null | undefined): (
  url: string,
  options?: {
    readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean };
    readonly threadRef?: ScopedThreadRef | undefined;
  },
) => Promise<void> {
  return useCallback(async (url) => {
    const api = readLocalApi();
    if (!api) throw new Error("Link opening is unavailable.");
    await api.shell.openExternal(url);
  }, []);
}
