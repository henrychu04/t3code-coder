import type {
  EnvironmentId,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  Outlet,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRpcRequestToastCoordinator";
import { Button } from "../components/ui/button";
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
import { environmentServerStatesAtom } from "../state/server";
import { readProject } from "../state/entities";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";

export const Route = createRootRoute({
  beforeLoad: () => ({}),
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
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
        <ConfirmDialogHost />
        <SlowRpcRequestToastCoordinator />
        <EventRouter />
        {appShell}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function ContrastAppearanceSync() {
  const appearanceContrast = useClientSettings((settings) => settings.appearanceContrast);

  useEffect(() => {
    applyAppearanceContrast(document.documentElement, appearanceContrast);
  }, [appearanceContrast]);

  return null;
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    document.documentElement.style.setProperty("--glass-opacity", `${glassOpacity}%`);
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
  const serverStates = useAtomValue(environmentServerStatesAtom);
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    serverVersions: [...serverStates.values()].map(
      ({ config }) => config?.environment.serverVersion,
    ),
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
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

      void (async () => {
        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        const environmentId = payload.environment.environmentId;
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
