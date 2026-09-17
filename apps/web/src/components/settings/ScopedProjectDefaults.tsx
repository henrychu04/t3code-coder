import { EnvironmentId } from "@t3tools/contracts";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPage } from "./SettingsPage";

export function ScopedProjectDefaults() {
  const { search, scope } = useSettingsScope();
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  if (search.project && projectScope)
    return (
      <ProjectSettingsPanel
        projectKey={search.project}
        environmentId={search.machine ? EnvironmentId.make(search.machine) : null}
        checkoutKey={search.checkout ?? null}
      />
    );
  if (scope.kind === "unavailable")
    return (
      <SettingsPage>
        <p role="status">{scope.message}</p>
      </SettingsPage>
    );
  return (
    <SettingsScopeNotice target="project">
      Choose a project to manage its name, icon, checkouts and actions.
    </SettingsScopeNotice>
  );
}
