import { useEffect, useState } from "react";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";

import {
  loadCoderWorkspaceDiagnostics,
  type WorkspaceDiagnosticEvent,
  type WorkspaceDiagnosticPhase,
} from "../coder/api";

const REFRESH_MS = 1_000;

export function coderDiagnosticPhaseLabel(phase: WorkspaceDiagnosticPhase): string {
  switch (phase) {
    case "preflight":
      return "Workspace preflight";
    case "installing_helper":
      return "Helper installation";
    case "negotiating_helper":
      return "Helper negotiation";
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
  }
}

function durationLabel(event: WorkspaceDiagnosticEvent): string {
  if (event.status === "running") return "In progress";
  if (event.durationMs === undefined) return event.status === "failed" ? "Failed" : "Complete";
  return `${event.status === "failed" ? "Failed after" : "Completed in"} ${String(event.durationMs)} ms`;
}

export function CoderWorkspaceDiagnostics({ workspaceId }: { readonly workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<readonly WorkspaceDiagnosticEvent[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadCoderWorkspaceDiagnostics(workspaceId);
        if (!cancelled) {
          setEvents(next);
          setUnavailable(false);
        }
      } catch {
        if (!cancelled) setUnavailable(true);
      }
      if (!cancelled) timer = window.setTimeout(() => void refresh(), REFRESH_MS);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, workspaceId]);

  return (
    <details
      className="mt-3 border-t pt-3 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none text-muted-foreground">
        Connection timeline
      </summary>
      <div className="mt-3 space-y-2">
        {unavailable ? (
          <p className="text-destructive">Connection diagnostics are unavailable.</p>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground">No connection attempts recorded yet.</p>
        ) : (
          events.map((event) => (
            <div className="grid grid-cols-[1rem_1fr_auto] items-start gap-2" key={event.id}>
              {event.status === "running" ? (
                <LoaderCircleIcon aria-hidden className="mt-0.5 size-3 animate-spin" />
              ) : event.status === "failed" ? (
                <CircleAlertIcon aria-hidden className="mt-0.5 size-3 text-destructive" />
              ) : (
                <CheckIcon aria-hidden className="mt-0.5 size-3 text-emerald-600" />
              )}
              <span>
                {coderDiagnosticPhaseLabel(event.phase)}
                <span className="ml-1 text-muted-foreground">· attempt {event.attempt}</span>
              </span>
              <span className="tabular-nums text-muted-foreground">{durationLabel(event)}</span>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
