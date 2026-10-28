import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import type { ServerConfig, ServerLifecycleWelcomePayload } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  Outlet,
  Link,
  useRouter,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ProjectCloneToastCoordinator } from "../components/ProjectCloneToastCoordinator";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { useAtomValue } from "@effect/atom-react";
import { environmentServerStatesAtom } from "../state/server";
import { initializeActiveEnvironmentId, readProject } from "../state/entities";

import { Check } from "lucide";
import { Copy } from "lucide";
import { cn } from "../lib/utils";
export const Route = createRootRoute({
  beforeLoad: () => ({}),
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to choose a project or
          start a thread.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <ProjectCloneToastCoordinator />
        <EventRouter />
        {appShell}
        <ThemeEditorHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <StandalonePage>
      <StandalonePageHeader title="Something went wrong." description={message} />

      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void router.invalidate()}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload app
        </Button>
        <CopyErrorButton report={report} />
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(report)}>
      <MorphIcon className={cn(isCopied && "text-success")} icon={isCopied ? Check : Copy} />
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

// Use only pathname to keep query tokens off the clipboard.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
/**
 * Coder: every workspace sends its own welcome. The first welcome picks the active (primary)
 * workspace, so welcomes are read per workspace rather than from the primary.
 */
function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverStates = useAtomValue(environmentServerStatesAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadsRef = useRef(new Set<string>());
  const rootBootstrapNavigationStartedRef = useRef(false);

  const handleWelcome = useEffectEvent(
    (payload: ServerLifecycleWelcomePayload | null, serverConfig: ServerConfig | null) => {
      if (!payload) return;
      const environmentId = payload.environment.environmentId;
      initializeActiveEnvironmentId(environmentId);

      void (async () => {
        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        const bootstrapThreadKey = `${environmentId}:${payload.bootstrapThreadId}`;
        if (handledBootstrapThreadsRef.current.has(bootstrapThreadKey)) {
          return;
        }
        handledBootstrapThreadsRef.current.add(bootstrapThreadKey);

        const bootstrapProject = readProject(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
        const bootstrapProjectKey =
          (bootstrapProject
            ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
            : null) ??
          (serverConfig?.cwd
            ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
            : null) ??
          scopedProjectKey(
            scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
          );
        useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

        if (readPathname() !== "/" || rootBootstrapNavigationStartedRef.current) {
          return;
        }
        rootBootstrapNavigationStartedRef.current = true;
        await navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: payload.environment.environmentId,
            threadId: payload.bootstrapThreadId,
          },
          replace: true,
        });
      })().catch(() => undefined);
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands the bootstrap project in the UI store and navigates the router on a server welcome
  useEffect(() => {
    for (const { config, welcome } of serverStates.values()) {
      handleWelcome(welcome, config);
    }
  }, [serverStates]);

  return null;
}
