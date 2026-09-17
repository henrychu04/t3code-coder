import { createFileRoute, Link } from "@tanstack/react-router";
import { ProjectAutoPullSetting } from "../components/settings/ProjectDefaultSettings";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { SourceControlPreferences } from "../components/settings/SourceControlPreferences";
import { GitLabWorkspaceSettings } from "../components/settings/GitLabWorkspaceSettings";
import { projectSettingsTarget } from "../projectSettingsTarget";
import { SettingsPage, SettingsRow, SettingsSection } from "../components/settings/SettingsPage";
import { ScopedSettingsTarget } from "../components/settings/ScopedSettingsTarget";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { useProjects } from "../state/entities";

function WorkspaceSourceControlPreferences({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <>
      <SettingsSection title="Repositories">
        <ProjectAutoPullSetting />
      </SettingsSection>
      <SourceControlPreferences
        environmentId={environment.environmentId}
        settings={settings}
        updateSettings={updateSettings}
        providers={environment.serverConfig?.providers ?? []}
      />
    </>
  );
}

function ProjectSettingsLinks() {
  const { scope } = useSettingsScope();
  const projects = useProjects().filter(
    (project) =>
      scope.environmentIds.includes(project.environmentId) &&
      (scope.members.length === 0 ||
        scope.members.some(
          (member) => member.id === project.id && member.environmentId === project.environmentId,
        )),
  );
  const { environments } = useEnvironments();
  return (
    <SettingsSection
      title="Project settings"
      description="Manage names, icons, actions, and checkouts for projects in this selection."
    >
      {projects.length === 0 ? (
        <SettingsRow
          title="No projects"
          description="Add a project in a Coder workspace to configure its defaults."
        />
      ) : (
        projects.map((project) => (
          <SettingsRow
            key={projectSettingsTarget(project).params.projectKey}
            title={project.title}
            description={
              environments.find(
                (environment) => environment.environmentId === project.environmentId,
              )?.label ?? project.environmentId
            }
            control={
              <Link {...projectSettingsTarget(project)} className="text-sm text-primary underline">
                Open project settings
              </Link>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function SourceControlSettingsView() {
  return (
    <SettingsPage>
      <ScopedSettingsTarget>
        {(environment) => (
          <WorkspaceSourceControlPreferences
            key={environment.environmentId}
            environment={environment}
          />
        )}
      </ScopedSettingsTarget>
      <GitLabWorkspaceSettings />
      <ProjectSettingsLinks />
    </SettingsPage>
  );
}
export const Route = createFileRoute("/settings/source-control")({
  component: SourceControlSettingsView,
});
