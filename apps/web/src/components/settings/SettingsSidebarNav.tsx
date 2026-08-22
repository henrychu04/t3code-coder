import { ArchiveIcon, PaletteIcon, ServerIcon, Settings2Icon } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";

import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

const SETTINGS_NAV_ITEMS = [
  { label: "General", to: "/settings/preferences", icon: Settings2Icon },
  { label: "Appearance", to: "/settings/appearance", icon: PaletteIcon },
  { label: "Coder connections", to: "/settings/general", icon: ServerIcon },
  { label: "Archived threads", to: "/settings/archived", icon: ArchiveIcon },
] as const;

export function SettingsSidebarNav({ pathname }: { readonly pathname: string }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleNavigate = useCallback(
    (to: (typeof SETTINGS_NAV_ITEMS)[number]["to"]) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to });
    },
    [isMobile, navigate, setOpenMobile],
  );

  return (
    <>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={pathname === item.to}
                    onClick={() => handleNavigate(item.to)}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
