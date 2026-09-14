import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import {
  ALL_ENVIRONMENTS_VALUE,
  ALL_PROJECTS_VALUE,
  environmentAxisValue,
  projectAxisValue,
  selectEnvironmentAxis,
  selectProjectAxis,
  settingsScopeEnvironmentLabel,
} from "./settingsScopeAxis";

/** Both axes stay in the settings URL while categories and search targets change. */
export function SettingsScopePicker() {
  const {
    search,
    scope,
    selectScope,
    groups,
    connectedEnvironments,
    environments: selected,
  } = useSettingsScope();
  const { environments } = useEnvironments();
  const unavailable = scope.kind === "unavailable";
  const machine = environmentAxisValue(search);
  const project = projectAxisValue(search);
  return (
    <div className="shrink-0 border-b px-5 py-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">Settings apply to</span>
        <label>
          Workspace{" "}
          <select
            aria-label="Settings workspace"
            className="ml-2 rounded border bg-background p-1.5"
            value={machine}
            onChange={(event) => selectScope(selectEnvironmentAxis(search, event.target.value))}
          >
            <option value={ALL_ENVIRONMENTS_VALUE}>All workspaces</option>
            {search.machine &&
              !environments.some((environment) => environment.environmentId === search.machine) && (
                <option value={search.machine}>Unavailable workspace</option>
              )}
            {environments.map((environment) => (
              <option key={environment.environmentId} value={environment.environmentId}>
                {settingsScopeEnvironmentLabel(environment, environments)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project{" "}
          <select
            aria-label="Settings project"
            className="ml-2 rounded border bg-background p-1.5"
            value={project}
            onChange={(event) => selectScope(selectProjectAxis(search, event.target.value))}
          >
            <option value={ALL_PROJECTS_VALUE}>All projects</option>
            {search.project && !groups.some((group) => group.projectKey === search.project) && (
              <option value={search.project}>Unavailable project</option>
            )}
            {groups.map((group) => (
              <option key={group.projectKey} value={group.projectKey}>
                {group.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {unavailable ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {scope.message}
        </p>
      ) : selected.length > connectedEnvironments.length ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Offline workspaces keep their current settings.
        </p>
      ) : null}
    </div>
  );
}
