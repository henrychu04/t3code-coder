import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect } from "react";

import { SidebarInset } from "../components/ui/sidebar";

function SettingsLayout() {
  const navigate = useNavigate();
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
      <Outlet />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/preferences", replace: true });
    }
  },
  component: SettingsLayout,
});
