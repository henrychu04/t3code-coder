import { useCallback, useEffect, useRef } from "react";
import type { CoderProfileConfig } from "../../coder/api";

export type UpdateCoderSettingsConfig = (
  update: (current: CoderProfileConfig) => CoderProfileConfig,
) => Promise<void>;
/** Resource edits operate on the latest config and cannot overwrite another queued edit. */
export function useCoderSettingsConfig(
  config: CoderProfileConfig,
  save: (next: CoderProfileConfig) => Promise<CoderProfileConfig>,
): UpdateCoderSettingsConfig {
  const current = useRef(config);
  const saveRef = useRef(save);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    current.current = config;
    saveRef.current = save;
  }, [config, save]);
  return useCallback((update) => {
    const next = queue.current.then(async () => {
      current.current = await saveRef.current(update(current.current));
    });
    queue.current = next.catch(() => {});
    return next;
  }, []);
}
