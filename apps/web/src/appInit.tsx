import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { createBrowserHistory } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { applyAppearanceContrast } from "./appearanceContrast";
import { applyAppearanceFontVariables, TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "./appearanceFonts";
import { retainThreadOverlaysForThread } from "./components/chat/threadOverlayRetention";
import { resolveWindowTitleThreadStatus } from "./components/Sidebar.logic";
import { startBackgroundThreadAnnouncements } from "./components/BackgroundThreadAnnouncer";
import { startKeybindingsUpdateToasts } from "./components/KeybindingsUpdateToast";
import { startLegacyThreadMigrationToast } from "./components/LegacyThreadMigrationToast";
import { startMainAppLocationTracking } from "./components/sidebar/mainAppLocation";
import { startSlowRpcRequestToasts } from "./components/SlowRpcRequestToastCoordinator";
import { startThreadNotifications } from "./components/ThreadNotificationCoordinator";
import { startGuideRunNotifications } from "./components/pullRequest/guide/PullRequestGuideRunCoordinator";
import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "./branding";
import { resolveServerBackedAppDisplayName, resolveWindowTitle } from "./branding.logic";
import { isElectron } from "./env";
import {
  subscribeComposerDraftModelReconciliation,
  subscribeDraftThreadPromotion,
  useComposerDraftStore,
} from "./composerDraftStore";
import { startEnvironmentThemeRepaint } from "./hooks/useEnvironmentTheme";
import { readLocalStorageValue, subscribeLocalStorageKey } from "./hooks/useLocalStorage";
import {
  getClientSettings,
  startModelPreferencesMigration,
  subscribeClientSettings,
} from "./hooks/useSettings";
import { syncBrowserChromeTheme } from "./hooks/useTheme";
import { startThreadVisitedMigration } from "./hooks/useThreadVisitedMigration";
import { getRouter, type AppRouter } from "./router";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentProjects } from "./state/projects";
import { primaryServerConfigAtom } from "./state/server";
import { environmentShell } from "./state/shell";
import { installChatRouteCommands } from "./shortcuts/chatRouteCommands";
import { startWorkspaceFocus } from "./lib/workspaceFocus";
import { startI18n } from "./i18n/runtime";
import { installCommandPaletteCommands } from "./shortcuts/commandPaletteCommands";
import { environmentThreadShells, threadEnvironment } from "./state/threads";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "./threadRoutes";

/** Writes appearance settings onto the document, touching only the groups that changed. */
function startClientAppearance(): void {
  const root = document.documentElement;
  let applied: ClientSettings | null = null;
  let appliedSeparateFonts: boolean | null = null;
  const apply = () => {
    const settings = getClientSettings();
    const previous = applied;
    applied = settings;
    const separateFonts = readLocalStorageValue(
      TYPOGRAPHY_ADVANCED_STORAGE_KEY,
      false,
      Schema.Boolean,
    );
    const previousSeparateFonts = appliedSeparateFonts;
    appliedSeparateFonts = separateFonts;
    if (previous?.diffColorScheme !== settings.diffColorScheme) {
      root.dataset.diffColorScheme = settings.diffColorScheme;
    }
    if (previous?.chatWidth !== settings.chatWidth) {
      root.dataset.chatWidth = settings.chatWidth;
    }
    if (previous?.appearanceContrast !== settings.appearanceContrast) {
      applyAppearanceContrast(root, settings.appearanceContrast);
    }
    if (previous?.glassOpacity !== settings.glassOpacity) {
      root.style.setProperty("--glass-opacity", `${settings.glassOpacity}%`);
      if (settings.glassOpacity === 100) {
        root.style.setProperty("--glass-blur", "0px");
      } else {
        root.style.removeProperty("--glass-blur");
      }
    }
    if (
      previous?.fontFamilySans !== settings.fontFamilySans ||
      previous.fontFamilyCode !== settings.fontFamilyCode ||
      previous.fontFamilyComposer !== settings.fontFamilyComposer ||
      previous.fontSizeInterface !== settings.fontSizeInterface ||
      previous.fontSizePrompt !== settings.fontSizePrompt ||
      previous.fontSizeCode !== settings.fontSizeCode ||
      previous.fontSmoothing !== settings.fontSmoothing ||
      previousSeparateFonts !== separateFonts
    ) {
      applyAppearanceFontVariables(root, {
        sans: settings.fontFamilySans,
        code: settings.fontFamilyCode,
        composer: settings.fontFamilyComposer,
        sizeInterface: settings.fontSizeInterface,
        sizePrompt: settings.fontSizePrompt,
        sizeCode: settings.fontSizeCode,
        smoothing: settings.fontSmoothing,
        separate: separateFonts,
      });
    }
  };
  subscribeClientSettings(apply);
  subscribeLocalStorageKey(TYPOGRAPHY_ADVANCED_STORAGE_KEY, apply);
  apply();
}

function readOpenThreadRef(router: AppRouter): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const draft =
    target?.kind === "draft"
      ? useComposerDraftStore.getState().getDraftSession(target.draftId)
      : null;
  return resolveActiveThreadRouteRef(target, draft);
}

/**
 * Names the open thread and its project in the window title, or the app when none is open.
 * Screen readers read it on Alt+Tab, so it can lead with the thread and what it's doing.
 */
function startDocumentTitle(router: AppRouter): void {
  // Coder: no guest page, which titles its own tab upstream.
  let openThreadRef = readOpenThreadRef(router);
  const write = () => {
    const thread =
      openThreadRef === null
        ? null
        : appAtomRegistry.get(environmentThreadShells.quietThreadShellAtom(openThreadRef));
    const project =
      thread === null
        ? null
        : appAtomRegistry.get(
            environmentProjects.projectAtom(
              scopeProjectRef(thread.environmentId, thread.projectId),
            ),
          );
    const title = resolveWindowTitle({
      appDisplayName: resolveServerBackedAppDisplayName({
        baseName: APP_BASE_NAME,
        fallbackDisplayName: APP_DISPLAY_NAME,
        fallbackStageLabel: APP_STAGE_LABEL,
        primaryServerVersion:
          appAtomRegistry.get(primaryServerConfigAtom)?.environment.serverVersion ?? null,
      }),
      projectTitle: project?.title ?? null,
      threadTitle: thread?.title ?? null,
      ...(getClientSettings().screenReaderWindowTitle && {
        screenReader: {
          threadStatus: thread === null ? null : resolveWindowTitleThreadStatus(thread),
        },
      }),
      desktop: isElectron,
    });
    // Projects change whenever any project does; most changes leave the title alone.
    if (document.title !== title) document.title = title;
  };
  // The open thread's own shell, since the shell lists skip threads hidden by a tag filter.
  let unsubscribeOpenThread = () => {};
  const watchOpenThread = () => {
    unsubscribeOpenThread();
    unsubscribeOpenThread =
      openThreadRef === null
        ? () => {}
        : appAtomRegistry.subscribe(
            environmentThreadShells.quietThreadShellAtom(openThreadRef),
            write,
          );
  };
  // The draft store changes on every keystroke; only a new open thread matters here.
  const updateOpenThread = () => {
    const next = readOpenThreadRef(router);
    if ((next && scopedThreadKey(next)) === (openThreadRef && scopedThreadKey(openThreadRef))) {
      return;
    }
    openThreadRef = next;
    watchOpenThread();
    write();
  };
  watchOpenThread();
  appAtomRegistry.subscribe(primaryServerConfigAtom, write, { immediate: true });
  appAtomRegistry.subscribe(environmentProjects.projectsAtom, write);
  subscribeClientSettings(write);
  router.subscribe("onResolved", updateOpenThread);
  useComposerDraftStore.subscribe(updateOpenThread);
}

/**
 * Each route paints its own surface, which the browser chrome samples once it is on screen.
 * onRendered only fires for a new href; onResolved also covers `router.invalidate()`, which
 * can swap the root between the bare outlet and the shell at the same address.
 */
function startBrowserChromeThemeSync(router: AppRouter): void {
  const resync = () => window.requestAnimationFrame(syncBrowserChromeTheme);
  router.subscribe("onRendered", resync);
  router.subscribe("onResolved", resync);
}

/** Chat overlays belong to the thread they were opened in, so leaving its route drops them. */
function startThreadOverlayRetention(router: AppRouter): void {
  router.subscribe("onResolved", () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const draftSession =
      target?.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)
        : null;
    const threadRef =
      target?.kind === "server"
        ? target.threadRef
        : draftSession
          ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
          : null;
    retainThreadOverlaysForThread(threadRef ? scopedThreadKey(threadRef) : null);
  });
}

/**
 * Starts every app-lifetime service once, before the first render, and returns the router.
 * They run for the life of the page, so their disposers are dropped here.
 */
export function startAppServices(): AppRouter {
  // Coder: a browser behind the loopback gateway only. There is no provider auth delivery,
  // Electron shell or desktop paste-as-text, default-theme adoption, agent-opened browser preview,
  // preview title recording or browser profile reporting, Open in editor command, SSH password
  // prompt, host-freeze toast, pairing-permission notice, or desktop update notice.
  const router = getRouter(createBrowserHistory());

  startClientAppearance();
  startI18n();
  startDocumentTitle(router);
  startEnvironmentThemeRepaint();
  startBrowserChromeThemeSync(router);
  startModelPreferencesMigration();
  installChatRouteCommands(router);
  installCommandPaletteCommands(router);
  startThreadOverlayRetention(router);
  // Drafts promote as their server threads arrive, wherever the user is.
  subscribeDraftThreadPromotion({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.quietThreadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
  });
  subscribeComposerDraftModelReconciliation({
    registry: appAtomRegistry,
    threadShellAtom: environmentThreadShells.threadShellAtom,
    threadRefsAtom: environmentThreadShells.threadRefsAtom,
    shellStateAtom: environmentShell.stateAtom,
    pendingThreadIdsAtom: threadEnvironment.pendingThreadIdsAtom,
  });
  startMainAppLocationTracking(router);
  startWorkspaceFocus(router);
  startBackgroundThreadAnnouncements(appAtomRegistry, router);
  startThreadVisitedMigration(appAtomRegistry);

  startKeybindingsUpdateToasts();
  startSlowRpcRequestToasts();
  startLegacyThreadMigrationToast();
  startThreadNotifications(appAtomRegistry, router);
  startGuideRunNotifications(appAtomRegistry, router);

  return router;
}
