import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { SettingsScopePicker } from "../components/settings/SettingsScopePicker";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { SidebarInset } from "../components/ui/sidebar";

function SettingsLayout() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const pathname = useLocation({ select: (location) => location.pathname });
  const canGoBack = useCanGoBack();
  const navigateBack = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      navigateBack();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [navigateBack]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <SettingsScopeProvider
        search={search}
        onChange={(next) =>
          void navigate({
            to: pathname,
            search: { project: undefined, machine: undefined, checkout: undefined, ...next },
            replace: true,
          })
        }
      >
        <SettingsScopePicker />
        <Outlet />
      </SettingsScopeProvider>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/preferences", replace: true });
    }
  },
  component: SettingsLayout,
});
