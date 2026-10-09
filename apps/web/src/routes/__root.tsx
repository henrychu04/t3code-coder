import { useEnvironmentThemeSync } from "../hooks/useEnvironmentTheme";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import type {
  EnvironmentId,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";
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
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL, APP_VERSION } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { LegacyThreadMigrationToast } from "../components/LegacyThreadMigrationToast";
import { ThreadNotificationCoordinator } from "../components/ThreadNotificationCoordinator";
import { ReopenClosedViewShortcut } from "../components/ReopenClosedViewShortcut";
import { ProjectCloneToastCoordinator } from "../components/ProjectCloneToastCoordinator";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRpcRequestToastCoordinator";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { applyAppearanceFontVariables } from "~/appearanceFonts";
import { applyAppearanceContrast } from "~/appearanceContrast";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { useAtomValue } from "@effect/atom-react";
import { environmentServerStatesAtom, primaryServerConfigAtom } from "../state/server";
import { initializeActiveEnvironmentId, readProject } from "../state/entities";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";

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
  useEnvironmentThemeSync();
  const pathname = useLocation({ select: (location) => location.pathname });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

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
        <DocumentTitleSync />
        <ContrastAppearanceSync />
        <GlassAppearanceSync />
        <FontAppearanceSync />
        <ReopenClosedViewShortcut />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <ProjectCloneToastCoordinator />
        <SlowRpcRequestToastCoordinator />
        <LegacyThreadMigrationToast />
        <ProviderUpdateLaunchNotification />
        <ThreadNotificationCoordinator />
        <EventRouter />
        {appShell}
        <ThemeEditorHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function ContrastAppearanceSync() {
  const appearanceContrast = useClientSettings((settings) => settings.appearanceContrast);
  const diffColorScheme = useClientSettings((settings) => settings.diffColorScheme);

  useEffect(() => {
    document.documentElement.dataset.diffColorScheme = diffColorScheme;
  }, [diffColorScheme]);

  const chatWidth = useClientSettings((settings) => settings.chatWidth);
  useEffect(() => {
    document.documentElement.dataset.chatWidth = chatWidth;
  }, [chatWidth]);

  useEffect(() => {
    applyAppearanceContrast(document.documentElement, appearanceContrast);
  }, [appearanceContrast]);

  return null;
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    const style = document.documentElement.style;
    style.setProperty("--glass-opacity", `${glassOpacity}%`);
    if (glassOpacity === 100) {
      style.setProperty("--glass-blur", "0px");
    } else {
      style.removeProperty("--glass-blur");
    }
  }, [glassOpacity]);

  return null;
}

function FontAppearanceSync() {
  const fontFamilySans = useClientSettings((settings) => settings.fontFamilySans);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontFamilyComposer = useClientSettings((settings) => settings.fontFamilyComposer);
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  const fontSizePrompt = useClientSettings((settings) => settings.fontSizePrompt);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const fontSmoothing = useClientSettings((settings) => settings.fontSmoothing);

  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      sans: fontFamilySans,
      code: fontFamilyCode,
      composer: fontFamilyComposer,
      sizeInterface: fontSizeInterface,
      sizePrompt: fontSizePrompt,
      sizeCode: fontSizeCode,
      smoothing: fontSmoothing,
    });
  }, [
    fontFamilyCode,
    fontFamilyComposer,
    fontFamilySans,
    fontSizeCode,
    fontSizeInterface,
    fontSizePrompt,
    fontSmoothing,
  ]);

  return null;
}

function DocumentTitleSync() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = useMemo(() => errorReport(error, pathname), [error, pathname]);

  return (
    <StandalonePage tone="error">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Something went wrong."
        description={message}
      />

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

/** Copies the full error report and swaps to a check mark for a moment as confirmation. */
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

/**
 * Full error text for bug reports: app build, page path, time, then the stack
 * and any cause chain. Takes the pathname only so tokens in the query never
 * land on the clipboard.
 */
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
 * Coder: every workspace sends its own welcome and config events. The first welcome picks the
 * active (primary) workspace, so events are read per workspace rather than from the primary.
 */
function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const serverStates = useAtomValue(environmentServerStatesAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadsRef = useRef(new Set<string>());
  const rootBootstrapNavigationStartedRef = useRef(false);
  const handledConfigEventsRef = useRef(new Map<EnvironmentId, ServerConfigStreamEvent | null>());
  const keybindingsToastControllersRef = useRef(
    new Map<EnvironmentId, KeybindingsUpdateToastController>(),
  );

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

  const handleServerConfigUpdated = useEffectEvent(
    (environmentId: EnvironmentId, serverConfigEvent: ServerConfigStreamEvent) => {
      let controller = keybindingsToastControllersRef.current.get(environmentId);
      if (!controller) {
        controller = createKeybindingsUpdateToastController({});
        keybindingsToastControllersRef.current.set(environmentId, controller);
      }
      const decision = controller.handle(serverConfigEvent);
      if (!decision) {
        return;
      }

      if (decision._tag === "Success") {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Invalid keybindings configuration",
          description: decision.message,
        }),
      );
    },
  );

  useEffect(() => {
    for (const { config, welcome } of serverStates.values()) {
      handleWelcome(welcome, config);
    }
  }, [serverStates]);

  useEffect(() => {
    for (const [environmentId, { latestEvent }] of serverStates) {
      if (!handledConfigEventsRef.current.has(environmentId)) {
        handledConfigEventsRef.current.set(environmentId, latestEvent);
        continue;
      }
      if (
        latestEvent === null ||
        handledConfigEventsRef.current.get(environmentId) === latestEvent
      ) {
        continue;
      }
      handledConfigEventsRef.current.set(environmentId, latestEvent);
      handleServerConfigUpdated(environmentId, latestEvent);
    }

    for (const environmentId of handledConfigEventsRef.current.keys()) {
      if (!serverStates.has(environmentId)) {
        handledConfigEventsRef.current.delete(environmentId);
        keybindingsToastControllersRef.current.delete(environmentId);
      }
    }
  }, [serverStates]);

  return null;
}
