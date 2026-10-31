import { useAtomValue } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  type DiscoveredLocalServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { GlobeIcon, LoaderCircleIcon, SquareIcon, UnplugIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

// Coder: no browser panel or desktop shell; Forward saves a port-forward rule and opens its
// laptop address in a new tab.
import { forwardedServerUrl, useServerForwards } from "../../coder/serverForwards";
import { cn } from "../../lib/utils";
import { useThreadDiscoveredPorts } from "../../portDiscoveryState";
import { useEnvironment } from "../../state/environments";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const serverKey = (server: DiscoveredLocalServer) => `${server.pid}:${server.port}`;

/** Local servers the thread's terminals and agent started. Hidden while none run. */
export function ThreadServersPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const servers = useThreadDiscoveredPorts(props);
  const canOpen = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  const canStop = useAtomValue(
    previewEnvironment.stopLocalServer.permissionAtom(props.environmentId),
  );
  const supportsStop =
    useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities.localServerStop ===
    true;
  const forwards = useServerForwards(props.environmentId);
  const [forwardingKey, setForwardingKey] = useState<string | null>(null);
  const [unforwardingKey, setUnforwardingKey] = useState<string | null>(null);
  const stopServer = useAtomCommand(previewEnvironment.stopLocalServer, {
    label: "thread server stop",
  });
  const [stoppingKey, setStoppingKey] = useState<string | null>(null);

  if (servers.length === 0) return null;

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  // Coder: a forwarded server opens at its laptop address; any other is forwarded first.
  const open = async (server: DiscoveredLocalServer, event: MouseEvent<HTMLElement>) => {
    if (event.button > 1) return;
    event.preventDefault();
    const existing = forwards.forwardFor(server.port);
    if (existing) {
      window.open(forwardedServerUrl(existing), "_blank", "noopener,noreferrer");
      return;
    }
    if (forwardingKey !== null) return;
    // Opened during the click, which a later window.open would lose, and pointed at the forward
    // once Coder reports it ready.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setForwardingKey(serverKey(server));
    const forwarded = await forwards.forward(server.port).then(
      (rule) => rule,
      (error: unknown) => {
        tab?.close();
        reportFailure("Could not forward server", error);
        return null;
      },
    );
    setForwardingKey(null);
    if (forwarded === null) return;
    const url = forwardedServerUrl(forwarded);
    if (tab) tab.location.href = url;
    else if (window.open(url, "_blank", "noopener,noreferrer") === null) {
      // The browser blocked the tab; the forward still runs, so say where it is.
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Server forwarded", description: url }),
      );
    }
  };

  const unforward = async (server: DiscoveredLocalServer) => {
    const existing = forwards.forwardFor(server.port);
    if (!existing || unforwardingKey !== null) return;
    setUnforwardingKey(serverKey(server));
    await forwards
      .stopForwarding(existing)
      .catch((error: unknown) => reportFailure("Could not stop forwarding", error));
    setUnforwardingKey(null);
  };

  const stop = async (server: DiscoveredLocalServer) => {
    if (server.pid === null || stoppingKey !== null) return;
    setStoppingKey(serverKey(server));
    const result = await stopServer({
      environmentId: props.environmentId,
      input: { pid: server.pid, port: server.port },
    });
    setStoppingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not stop server", squashAtomCommandFailure(result));
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-servers-heading" title="Servers">
      <ul className="m-0 list-none p-0">
        {servers.map((server) => {
          const key = serverKey(server);
          const stoppable = canStop && supportsStop && server.pid !== null;
          const forwarded = forwards.forwardFor(server.port);
          return (
            <li key={key} className="group relative flex items-center rounded-lg">
              <Tooltip>
                <TooltipTrigger
                  delay={200}
                  render={
                    <ThreadDetailsControl
                      size="sm"
                      variant="ghost"
                      part="row"
                      multiline
                      disabled={!canOpen || !forwards.canForward}
                      onClick={(event) => void open(server, event)}
                      onAuxClick={(event) => void open(server, event)}
                    />
                  }
                >
                  {forwardingKey === key ? (
                    <LoaderCircleIcon
                      aria-hidden
                      className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "animate-spin")}
                    />
                  ) : (
                    <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  )}
                  {/* The end padding keeps text clear of the stop button. */}
                  {/* Coder: and of the Stop forwarding button. */}
                  <span
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-0.5",
                      stoppable && "pe-6",
                      forwarded && (stoppable ? "pe-12" : "pe-6"),
                    )}
                  >
                    <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                      localhost:{server.port}
                    </span>
                    <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                      {/* Coder: a forwarded server leads with its laptop address. */}
                      {forwarded ? (
                        <>
                          <span
                            aria-hidden
                            className="me-1 inline-block size-1.5 rounded-full bg-success align-middle"
                          />
                          <span className="text-success-foreground">
                            127.0.0.1:{forwarded.localPort}
                          </span>
                          {" · "}
                        </>
                      ) : null}
                      {[server.terminal === null ? "Agent" : "Terminal", server.processName]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="left">
                  {forwarded
                    ? `Open 127.0.0.1:${forwarded.localPort} in a new tab.`
                    : "Forward to this computer and open it in a new tab."}
                </TooltipPopup>
              </Tooltip>
              {stoppable ? (
                <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={`Stop localhost:${server.port}`}
                          disabled={stoppingKey !== null}
                          onClick={() => void stop(server)}
                        />
                      }
                    >
                      {stoppingKey === key ? (
                        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                      ) : (
                        <SquareIcon aria-hidden className="size-3 fill-current" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">Stop server</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
              {/* Coder: removes the saved forward, left of Stop; the server keeps running. */}
              {forwarded ? (
                <div
                  className={cn(
                    "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                    stoppable ? "right-7" : "right-1",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          aria-label={`Stop forwarding localhost:${server.port}`}
                          disabled={unforwardingKey !== null}
                          onClick={() => void unforward(server)}
                        />
                      }
                    >
                      {unforwardingKey === key ? (
                        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                      ) : (
                        <UnplugIcon aria-hidden className="size-3" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">Stop forwarding</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
