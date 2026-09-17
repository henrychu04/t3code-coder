import { useCallback, useEffect, useRef, useState } from "react";

/** Read-only status polling: bounded, visibility-aware, with no overlapping scheduled reads. */
export function useSettingsPolling<A>({
  load,
  identity,
  intervalMs,
  enabled = true,
}: {
  load: (signal: AbortSignal) => Promise<A>;
  identity: string;
  intervalMs: number | null;
  enabled?: boolean;
}) {
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const [state, setState] = useState<{
    identity: string;
    data: A | null;
    error: string | null;
    pending: boolean;
  }>({ identity, data: null, error: null, pending: enabled });
  useEffect(() => {
    let active = true;
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ identity, data: null, error: null, pending: enabled });
    const refresh = async () => {
      if (!active || !enabled) return;
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const request = ++generation;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
      setState((previous) => ({ ...previous, pending: true }));
      try {
        const data = await latestLoad.current(signal);
        if (active && request === generation && !signal.aborted)
          setState({ identity, data, error: null, pending: false });
        else if (active && request === generation && signal.aborted)
          setState((previous) => ({
            ...previous,
            error: "The status check timed out.",
            pending: false,
          }));
      } catch (cause) {
        if (active && request === generation)
          setState((previous) => ({
            ...previous,
            pending: false,
            error: cause instanceof Error ? cause.message : "Status unavailable.",
          }));
      } finally {
        if (
          active &&
          request === generation &&
          intervalMs !== null &&
          document.visibilityState !== "hidden"
        )
          timer = setTimeout(() => void refresh(), intervalMs);
      }
    };
    refreshRef.current = refresh;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) clearTimeout(timer);
      } else void refresh();
    };
    if (enabled) {
      if (document.visibilityState !== "hidden") void refresh();
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      active = false;
      ++generation;
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [identity, enabled, intervalMs]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const current =
    state.identity === identity ? state : { data: null, error: null, pending: enabled };
  return { ...current, refresh };
}
