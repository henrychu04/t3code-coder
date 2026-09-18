import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsResourceFailure } from "./SettingsResource";

/** Serialize commands from one surface and keep their failure attached to the resource. */
export function useSettingsOperation() {
  const mounted = useRef(false);
  const running = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<(SettingsResourceFailure & { key: string }) | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (key: string, title: string, action: () => Promise<unknown>): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      setPending(key);
      setError(null);
      try {
        await action();
        return mounted.current;
      } catch (cause) {
        if (mounted.current)
          setError({
            key,
            title,
            details:
              cause instanceof Error ? cause.message : "The operation could not be completed.",
          });
        return false;
      } finally {
        running.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [],
  );
  return { pending, error, run };
}
