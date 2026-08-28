import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ActivityIcon,
  CpuIcon,
  HardDriveIcon,
  MemoryStickIcon,
  TimerIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";

import { useCoder } from "../coder/CoderBootstrap";
import { loadCoderWorkspaceMetrics, type CoderWorkspaceMetrics } from "../coder/api";
import { coderWorkspaceIdForEnvironment } from "../coder/environmentStore";
import { useEnvironments } from "../state/environments";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

const RESOURCE_REFRESH_MS = 10_000;
const AUTOSTOP_REFRESH_MS = 1_000;

export function formatCoderWorkspaceLatency(latencyMs: number): string {
  return latencyMs < 1 ? "<1 ms" : `${Math.round(latencyMs)} ms`;
}

export function formatCoderWorkspaceLatencyDetail(latencyMs: number): string {
  if (latencyMs < 0.1) return "<0.1 ms";
  return `${String(Math.round(latencyMs * 10) / 10)} ms`;
}

export function formatCoderAutostop(
  autostopAt: string,
  now = Date.now(),
  kind: "idle" | "required" = "idle",
): string | null {
  const deadline = Date.parse(autostopAt);
  if (!Number.isFinite(deadline)) return null;
  const label = kind === "required" ? "Required stop" : "Idle stop";
  const remainingMs = deadline - now;
  if (remainingMs <= 0) return `${label} due`;
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${label} in ${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${label} in ${String(hours)}h ${String(remainingMinutes)}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${label} in ${String(days)}d ${String(remainingHours)}h`;
}

export function formatCoderResourcePercent(used: number, total: number): string {
  return `${Math.round((used / total) * 100)}%`;
}

export function formatCoderResourceBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

function ResourceRow({
  icon: Icon,
  label,
  value,
  detail,
  percent,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly percent: number;
}) {
  return (
    <div>
      <div className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-2">
        <span className="grid size-6 place-items-center rounded-md bg-muted/60 text-muted-foreground">
          <Icon aria-hidden className="size-3" />
        </span>
        <div>
          <div className="font-medium text-foreground">{label}</div>
          <div className="mt-0.5 text-[10px] tabular-nums text-muted-foreground/75">{detail}</div>
        </div>
        <span className="font-medium tabular-nums text-foreground">{value}</span>
      </div>
      <div className="ml-8 mt-1.5 h-0.75 overflow-hidden rounded-full bg-muted/80">
        <div
          aria-hidden
          className="h-full rounded-full bg-foreground/45"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
    </div>
  );
}

function ResourceUsage({ usage }: { readonly usage: CoderWorkspaceMetrics }) {
  const cpuPercent = (usage.cpu.used / usage.cpu.total) * 100;
  const memoryPercent = (usage.memory.used / usage.memory.total) * 100;
  const diskPercent = (usage.disk.used / usage.disk.total) * 100;
  return (
    <div className="space-y-3">
      <ResourceRow
        detail={`${usage.cpu.used.toFixed(2)} of ${usage.cpu.total.toFixed(0)} cores`}
        icon={CpuIcon}
        label="CPU"
        percent={cpuPercent}
        value={formatCoderResourcePercent(usage.cpu.used, usage.cpu.total)}
      />
      <ResourceRow
        detail={`${formatCoderResourceBytes(usage.memory.used)} of ${formatCoderResourceBytes(usage.memory.total)}`}
        icon={MemoryStickIcon}
        label="Memory"
        percent={memoryPercent}
        value={formatCoderResourcePercent(usage.memory.used, usage.memory.total)}
      />
      <ResourceRow
        detail={`${formatCoderResourceBytes(usage.disk.used)} of ${formatCoderResourceBytes(usage.disk.total)}`}
        icon={HardDriveIcon}
        label="Home disk"
        percent={diskPercent}
        value={formatCoderResourcePercent(usage.disk.used, usage.disk.total)}
      />
    </div>
  );
}

export function CoderWorkspaceLatency({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { workspaceNetwork, workspaceRuntime } = useCoder();
  const { environments } = useEnvironments();
  const [cardOpen, setCardOpen] = useState(false);
  const [resourceUsage, setResourceUsage] = useState<CoderWorkspaceMetrics | null>(null);
  const [resourceError, setResourceError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const workspaceId = coderWorkspaceIdForEnvironment(environmentId);
  const network = workspaceId === null ? undefined : workspaceNetwork[workspaceId];
  const runtime = workspaceId === null ? undefined : workspaceRuntime[workspaceId];

  useEffect(() => {
    setResourceUsage(null);
    setResourceError(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!cardOpen || workspaceId === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const usage = await loadCoderWorkspaceMetrics(workspaceId);
        if (!cancelled) {
          setResourceUsage(usage);
          setResourceError(false);
        }
      } catch {
        if (!cancelled) setResourceError(true);
      }
      if (!cancelled) timer = window.setTimeout(() => void refresh(), RESOURCE_REFRESH_MS);
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cardOpen, workspaceId]);

  useEffect(() => {
    if (
      !cardOpen ||
      ((runtime?.autostopAt === null || runtime?.autostopAt === undefined) &&
        (runtime?.requiredStopAt === null || runtime?.requiredStopAt === undefined))
    ) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), AUTOSTOP_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [cardOpen, runtime?.autostopAt, runtime?.requiredStopAt]);

  if (environment?.connection.phase !== "connected" || workspaceId === null) return null;

  const latencyLabel =
    network === undefined
      ? "— ms"
      : `${network.stale ? "~" : ""}${formatCoderWorkspaceLatency(network.latencyMs)}`;
  const latencyDetailLabel =
    network === undefined
      ? "— ms"
      : `${network.stale ? "~" : ""}${formatCoderWorkspaceLatencyDetail(network.latencyMs)}`;
  const autostopAt = runtime?.autostopAt;
  const requiredStopAt = runtime?.requiredStopAt;
  const effectiveStopIsRequired =
    autostopAt !== null &&
    autostopAt !== undefined &&
    requiredStopAt !== null &&
    requiredStopAt !== undefined &&
    autostopAt === requiredStopAt;
  const idleStopLabel =
    autostopAt === null || autostopAt === undefined || effectiveStopIsRequired
      ? null
      : formatCoderAutostop(autostopAt, now);
  const idleStopIsSoon =
    idleStopLabel !== null &&
    typeof autostopAt === "string" &&
    Date.parse(autostopAt) - now <= 30 * 60_000;
  const requiredStopLabel =
    requiredStopAt === null || requiredStopAt === undefined
      ? null
      : formatCoderAutostop(requiredStopAt, now, "required");
  const requiredStopIsSoon =
    requiredStopLabel !== null &&
    typeof requiredStopAt === "string" &&
    Date.parse(requiredStopAt) - now <= 30 * 60_000;
  const healthy = resourceUsage?.healthy ?? runtime?.healthy;
  const healthLabel = healthy === true ? "Healthy" : healthy === false ? "Unhealthy" : "Connected";
  const healthDotClass =
    healthy === false ? "bg-destructive" : "bg-emerald-500 dark:bg-emerald-400";
  const healthPillClass =
    healthy === false
      ? "border-destructive/25 bg-destructive/10 text-destructive"
      : "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  return (
    <Popover onOpenChange={setCardOpen}>
      <PopoverTrigger
        closeDelay={100}
        delay={0}
        openOnHover
        render={
          <button
            aria-label={`Coder workspace health and resource usage. Latest latency: ${latencyLabel}`}
            className={`inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-sm px-1 text-xs tabular-nums outline-hidden transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${network?.slow ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/65"}`}
            type="button"
          >
            <ActivityIcon aria-hidden className="size-3" />
            {latencyLabel}
          </button>
        }
      />
      <PopoverPopup
        align="end"
        className="w-72 text-left text-xs"
        side="bottom"
        sideOffset={6}
        tooltipStyle
      >
        <div className="px-1.5 pb-2 pt-1.5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-semibold text-foreground">Coder workspace</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">Connected workspace</div>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${healthPillClass}`}
            >
              <span aria-hidden className={`size-1.5 rounded-full ${healthDotClass}`} />
              {healthLabel}
            </span>
          </div>

          <div className="mt-2.5 flex items-center justify-between border-b pb-2.5">
            <span className="inline-flex items-center gap-2 text-[10px] text-muted-foreground">
              <ActivityIcon aria-hidden className="size-3" />
              Latency
            </span>
            <span className="font-semibold tabular-nums text-foreground">{latencyDetailLabel}</span>
          </div>

          {network?.slow ? (
            <div className="mt-2.5 flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 p-2 text-amber-700 dark:text-amber-300">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span>Sustained high latency may make terminal and editor input feel delayed.</span>
            </div>
          ) : null}

          {idleStopLabel !== null ? (
            <div
              className={`mt-2.5 flex items-center gap-2 rounded-md border p-2 ${idleStopIsSoon ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}
            >
              <TimerIcon aria-hidden className="size-3 shrink-0" />
              <span>{idleStopLabel}</span>
            </div>
          ) : null}

          {requiredStopLabel !== null ? (
            <div
              className={`mt-2.5 flex items-center gap-2 rounded-md border p-2 ${requiredStopIsSoon ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}
            >
              <TimerIcon aria-hidden className="size-3 shrink-0" />
              <span>{requiredStopLabel}</span>
            </div>
          ) : null}

          <div className="pt-3">
            {resourceUsage !== null ? (
              <ResourceUsage usage={resourceUsage} />
            ) : (
              <div className="text-muted-foreground">
                {resourceError ? "Resource usage unavailable" : "Loading resource usage…"}
              </div>
            )}
          </div>
        </div>
        <div className="-mx-2 -mb-1 mt-1 flex items-center gap-1.5 border-t bg-muted/25 px-3.5 py-2 text-[10px] text-muted-foreground/75">
          <span aria-hidden className="size-1 rounded-full bg-current" />
          {network?.stale
            ? "Network sample is stale"
            : resourceError && resourceUsage !== null
              ? "Could not refresh usage"
              : "Updated just now"}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
