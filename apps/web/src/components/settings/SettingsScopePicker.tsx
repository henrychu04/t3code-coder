import { RestoreClientSettings } from "./RestoreSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

export function SettingsScopePicker({
  pathname = "/settings/projects",
  onRestoreDefaults,
}: {
  pathname?: string;
  onRestoreDefaults?: (() => void) | undefined;
}) {
  const {
    search,
    scope,
    selectScope,
    groups,
    connectedEnvironments,
    environments: selected,
  } = useSettingsScope();
  const { environments } = useEnvironments();
  const showScope = ![
    "/settings/appearance",
    "/settings/general",
    "/settings/open-source-licenses",
  ].includes(pathname);
  return (
    <>
      <WorkspacePageHeader>
        <SettingsBreadcrumb
          pathname={pathname}
          scope={
            showScope
              ? {
                  value: search,
                  groups,
                  environments,
                  onChange: selectScope,
                }
              : undefined
          }
        />
        {pathname === "/settings/preferences" ? (
          <RestoreClientSettings compact onRestored={onRestoreDefaults} />
        ) : null}
      </WorkspacePageHeader>
      {showScope &&
        (scope.kind === "unavailable" ? (
          <p role="status" className="px-5 py-2 text-sm text-muted-foreground">
            {scope.message}
          </p>
        ) : selected.length > connectedEnvironments.length ? (
          <p role="status" className="px-5 py-2 text-xs text-muted-foreground">
            Offline workspaces keep their current settings.
          </p>
        ) : null)}
    </>
  );
}
