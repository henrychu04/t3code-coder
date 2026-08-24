import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  LoaderCircleIcon,
  LogInIcon,
  PowerIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  checkCoderDeploymentAuthentication,
  loginToCoderDeployment,
  type CoderDeploymentAuthenticationStatus,
} from "../coder/api";
import { useCoder } from "../coder/CoderBootstrap";
import { coderWorkspaceIdForEnvironment } from "../coder/environmentStore";
import { useEnvironments } from "../state/environments";
import { summarizeCoderWorkspaceError } from "./CoderWorkspaceIssues";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";

export function workspaceConnectionStatusText(
  phase: EnvironmentConnectionPhase | null,
  label: string | null,
  error: string | null = null,
): { readonly title: string; readonly description: string } {
  const workspace = label ?? "Coder workspace";

  switch (phase) {
    case "offline":
      return {
        title: "Waiting for network…",
        description: `${workspace} will reconnect when the network is available.`,
      };
    case "error":
      return {
        title: `Couldn’t reconnect to ${workspace}`,
        description: error ?? "Check the workspace connection in Settings.",
      };
    case "connected":
      return {
        title: "Loading workspace data…",
        description: `${workspace} is connected and synchronizing.`,
      };
    case "available":
    case "connecting":
      return {
        title: `Connecting to ${workspace}…`,
        description: "Restoring projects and threads.",
      };
    case "reconnecting":
    case null:
      return {
        title: `Reconnecting to ${workspace}…`,
        description: "Restoring projects and threads.",
      };
  }
}

export function coderAuthenticationStatusText(
  deploymentLabel: string,
  workspaceLabel: string,
  waitingForTerminal: boolean,
): { readonly title: string; readonly description: string } {
  return waitingForTerminal
    ? {
        title: "Waiting for Coder sign-in…",
        description: "Complete authentication in the terminal running T3 Coder.",
      }
    : {
        title: "Coder sign-in required",
        description: `${deploymentLabel} needs a new session before ${workspaceLabel} can reconnect.`,
      };
}

type AuthenticationCheck = {
  readonly deploymentId: string;
  readonly status: CoderDeploymentAuthenticationStatus | "checking" | "unknown";
};

async function readCoderAuthenticationStatus(
  deploymentId: string,
): Promise<CoderDeploymentAuthenticationStatus | "unknown"> {
  try {
    return await checkCoderDeploymentAuthentication(deploymentId);
  } catch {
    return "unknown";
  }
}

export function WorkspaceConnectionStatus({
  environmentId = null,
}: {
  readonly environmentId?: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const {
    config,
    connectionErrors,
    connectWorkspace,
    refreshWorkspaceRuntime,
    startWorkspace,
    workspaceRuntime,
  } = useCoder();
  const [retrying, setRetrying] = useState(false);
  const [startingWorkspace, setStartingWorkspace] = useState(false);
  const [authenticationCheckRequest, setAuthenticationCheckRequest] = useState(0);
  const [authenticationCheck, setAuthenticationCheck] = useState<AuthenticationCheck | null>(null);
  const [reauthenticating, setReauthenticating] = useState(false);
  const [reauthenticationError, setReauthenticationError] = useState<{
    readonly deploymentId: string;
    readonly message: string;
  } | null>(null);
  const environment =
    environmentId === null
      ? (environments.find(
          (candidate) =>
            candidate.connection.phase === "reconnecting" ||
            candidate.connection.phase === "connecting",
        ) ??
        environments[0] ??
        null)
      : (environments.find((candidate) => candidate.environmentId === environmentId) ?? null);
  const environmentWorkspaceId =
    environment === null ? null : coderWorkspaceIdForEnvironment(environment.environmentId);
  const failedWorkspace = config.workspaces.find(
    (workspace) => connectionErrors[workspace.id] !== undefined,
  );
  const workspace =
    config.workspaces.find((candidate) => candidate.id === environmentWorkspaceId) ??
    failedWorkspace ??
    (config.workspaces.length === 1 ? config.workspaces[0] : undefined);
  const deployment =
    workspace === undefined
      ? undefined
      : config.deployments.find((candidate) => candidate.id === workspace.deploymentId);
  const connectionError =
    environment?.connection.error ??
    (workspace === undefined ? null : (connectionErrors[workspace.id] ?? null));
  const phase = retrying
    ? "reconnecting"
    : (environment?.connection.phase ?? (connectionError === null ? null : "error"));
  const authenticationStatus =
    deployment !== undefined && authenticationCheck?.deploymentId === deployment.id
      ? authenticationCheck.status
      : null;
  const checkingAuthentication =
    phase === "error" &&
    deployment !== undefined &&
    (authenticationStatus === null || authenticationStatus === "checking");
  const authenticationRequired = phase === "error" && authenticationStatus === "unauthenticated";
  const workspaceLabel = environment?.label ?? workspace?.name ?? "Coder workspace";
  const runtime = workspace === undefined ? undefined : workspaceRuntime[workspace.id];
  const workspaceStopped = runtime?.status === "stopped";
  const workspaceStarting = runtime?.status === "starting" || startingWorkspace;
  const workspaceUnavailable = runtime?.status === "unavailable";
  const status = workspaceStopped
    ? {
        title: `${workspaceLabel} is stopped`,
        description: "Start the workspace when you’re ready to reconnect.",
      }
    : workspaceStarting
      ? {
          title: `Starting ${workspaceLabel}…`,
          description: "Coder is preparing the workspace. T3 Coder will reconnect automatically.",
        }
      : workspaceUnavailable
        ? {
            title: "Workspace status unavailable",
            description:
              runtime.error === undefined
                ? "Could not fetch workspace status."
                : summarizeCoderWorkspaceError(runtime.error),
          }
        : checkingAuthentication
          ? {
              title: "Checking Coder authentication…",
              description: `Verifying the session for ${deployment?.name ?? "the Coder deployment"}.`,
            }
          : authenticationRequired && deployment !== undefined
            ? coderAuthenticationStatusText(deployment.name, workspaceLabel, reauthenticating)
            : workspaceConnectionStatusText(
                phase,
                workspaceLabel,
                connectionError === null ? null : summarizeCoderWorkspaceError(connectionError),
              );

  useEffect(() => {
    if (phase !== "error" || deployment === undefined) return;

    let cancelled = false;
    setAuthenticationCheck({ deploymentId: deployment.id, status: "checking" });
    void readCoderAuthenticationStatus(deployment.id).then((status) => {
      if (!cancelled) {
        setAuthenticationCheck({
          deploymentId: deployment.id,
          status,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authenticationCheckRequest, deployment, phase]);

  const retry =
    phase === "error" &&
    workspace !== undefined &&
    !workspaceStopped &&
    !workspaceStarting &&
    !workspaceUnavailable
      ? async () => {
          setRetrying(true);
          try {
            await connectWorkspace(workspace.id);
          } catch {
            // CoderBootstrap exposes the failure through connectionErrors.
            setAuthenticationCheckRequest((request) => request + 1);
          } finally {
            setRetrying(false);
          }
        }
      : null;
  const start =
    workspaceStopped && workspace !== undefined
      ? async () => {
          setStartingWorkspace(true);
          try {
            await startWorkspace(workspace.id);
          } finally {
            setStartingWorkspace(false);
          }
        }
      : null;
  const reauthenticate =
    authenticationRequired &&
    !workspaceStopped &&
    !workspaceStarting &&
    !workspaceUnavailable &&
    deployment !== undefined &&
    workspace !== undefined
      ? async () => {
          setReauthenticating(true);
          setReauthenticationError(null);
          try {
            await loginToCoderDeployment(deployment.id);
            const status = await checkCoderDeploymentAuthentication(deployment.id);
            if (status !== "authenticated") {
              throw new Error(
                status === "unauthenticated"
                  ? "Coder sign-in did not complete successfully."
                  : "Could not verify the new Coder session.",
              );
            }
            setAuthenticationCheck({ deploymentId: deployment.id, status: "authenticated" });
            setRetrying(true);
            await connectWorkspace(workspace.id);
          } catch (cause) {
            setReauthenticationError({
              deploymentId: deployment.id,
              message: cause instanceof Error ? cause.message : "Coder login failed.",
            });
          } finally {
            setRetrying(false);
            setReauthenticating(false);
          }
        }
      : null;
  const currentReauthenticationError =
    deployment !== undefined && reauthenticationError?.deploymentId === deployment.id
      ? reauthenticationError.message
      : null;
  const showErrorIcon =
    workspaceUnavailable ||
    (phase === "error" &&
      !checkingAuthentication &&
      !reauthenticating &&
      !workspaceStopped &&
      !workspaceStarting);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <Empty className="flex-1" role="status" aria-live="polite">
        <EmptyHeader className="max-w-md">
          {workspaceStopped ? (
            <PowerIcon aria-hidden className="mb-4 size-5 text-muted-foreground" />
          ) : showErrorIcon ? (
            <CircleAlertIcon aria-hidden className="mb-4 size-5 text-destructive" />
          ) : (
            <LoaderCircleIcon
              aria-hidden
              className="mb-4 size-5 animate-spin text-muted-foreground"
            />
          )}
          <EmptyTitle className="text-foreground text-lg">{status.title}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {status.description}
          </EmptyDescription>
          {reauthenticate === null ? null : (
            <>
              <Button
                className="mt-5"
                disabled={reauthenticating}
                size="sm"
                onClick={() => void reauthenticate()}
              >
                {reauthenticating ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <LogInIcon className="size-4" />
                )}
                {reauthenticating ? "Waiting for terminal…" : "Reauthenticate"}
              </Button>
              {reauthenticating ? (
                <p className="mt-3 max-w-sm text-xs leading-5 text-muted-foreground">
                  Open the printed sign-in URL manually and paste the one-time Coder token at the
                  hidden prompt.
                </p>
              ) : null}
              {currentReauthenticationError === null ? null : (
                <p className="mt-3 max-w-sm text-xs leading-5 text-destructive-foreground">
                  {currentReauthenticationError}
                </p>
              )}
            </>
          )}
          {start === null ? null : (
            <Button className="mt-5" size="sm" onClick={() => void start()}>
              <PowerIcon className="size-4" />
              Start workspace
            </Button>
          )}
          {workspaceUnavailable ? (
            <Button className="mt-5" size="sm" onClick={() => void refreshWorkspaceRuntime()}>
              <RotateCcwIcon className="size-4" />
              Retry status
            </Button>
          ) : null}
          {reauthenticate !== null || retry === null ? null : (
            <Button className="mt-5" size="sm" onClick={() => void retry()}>
              <RotateCcwIcon className="size-4" />
              Try again
            </Button>
          )}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
