import { useStableCallback } from "../../hooks/useStableCallback";
import { type EnvironmentId } from "@t3tools/contracts";
import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { WifiOffIcon } from "lucide-react";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentStateHeldFor } from "../../hooks/useEnvironmentDisconnectDelay";
import { type EnvironmentPresentation } from "../../state/environments";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ENVIRONMENT_RECONNECT_WARNING_GRACE_MS } from "../ChatView.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: EnvironmentConnectionPresentation;
};

interface SystemComposerBannersInput {
  readonly activeEnvironment: EnvironmentPresentation | null;
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
}

/**
 * The composer banners about the machine itself: offline or reconnecting. Coder: the
 * workspace helper has no self-update, server-update notice, or disconnect action, and there
 * are no auto-balanced machines.
 */
export function useSystemComposerBanners(input: SystemComposerBannersInput) {
  const { activeEnvironment, activeEnvironmentUnavailableState } = input;
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  // Each reconnect attempt gets its own grace period, including a later one to
  // the same environment.
  const reconnectWarningGraceElapsed = useEnvironmentStateHeldFor(
    activeReconnectingEnvironmentId,
    ENVIRONMENT_RECONNECT_WARNING_GRACE_MS,
  );
  const handleReconnectActiveEnvironment = async (environmentId: EnvironmentId) => {
    // Coder: the Coder config enables every workspace, so none is switched off to turn back on.
    const result = await retryEnvironment(environmentId);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: error instanceof Error ? error.message : "Failed to reconnect.",
        }),
      );
    }
  };
  const handleReconnectActiveEnvironmentStable = useStableCallback(
    handleReconnectActiveEnvironment,
  );
  return (() => {
    const items: ComposerBannerStackItem[] = [];
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    // Coder: the workspace helper has no self-update, so only the reconnect grace applies.
    const suppressUnavailableBanner = environmentReconnecting && !reconnectWarningGraceElapsed;
    const showUnavailableBanner =
      activeEnvironmentUnavailableState !== null &&
      unavailableConnection !== null &&
      !suppressUnavailableBanner;
    if (showUnavailableBanner) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant: unavailableConnection.phase === "error" ? "error" : "warning",
        group: "environment",
        icon: <WifiOffIcon />,
        title: `${activeEnvironmentUnavailableState.label} is ${environmentReconnecting ? "reconnecting" : "offline"}`,
        actions: !environmentReconnecting ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void handleReconnectActiveEnvironmentStable(
                activeEnvironmentUnavailableState.environmentId,
              )
            }
          >
            Reconnect
          </Button>
        ) : undefined,
      });
    }
    return items;
  })() as ComposerBannerStackItem[];
}
