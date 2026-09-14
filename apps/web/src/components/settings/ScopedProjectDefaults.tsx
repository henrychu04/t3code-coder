import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { DefaultsForm } from "./ProjectsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsPage";
import { projectSettingsTarget } from "../../projectSettingsTarget";
import { useProjects } from "../../state/entities";

export function ScopedProjectDefaults() {
  const { search, targets } = useSettingsScope();
  return (
    <ScopedProjectDefaultsForm
      key={JSON.stringify([
        search,
        targets.map((target) => [target.environmentId, target.projectId]),
      ])}
    />
  );
}

function ScopedProjectDefaultsForm() {
  const { environment, targets, scope, search } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const projects = useProjects();
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  return (
    <SettingsPage>
      <SettingsSection
        title={
          scope.kind === "project" || scope.kind === "checkout"
            ? "Project overrides"
            : "Project defaults"
        }
        description="Only edited fields are saved to the selected connected workspaces. Reset an override to inherit its workspace value."
      >
        {targets.length && environment?.serverConfig ? (
          <DefaultsForm
            key={JSON.stringify([search, revision])}
            settings={settings}
            providers={environment.serverConfig.providers}
            disabled={pending}
            onSave={async (patch) => {
              if (pending) return;
              setPending(true);
              try {
                if (await update(patch)) setRevision((value) => value + 1);
              } finally {
                setPending(false);
              }
            }}
          />
        ) : (
          <p role="status" className="p-4">
            Connect a selected workspace to edit project defaults.
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Project details"
        description="Open a checkout to rename it, edit its scripts, or manage its existing project preferences."
      >
        {projects
          .filter(
            (project) =>
              scope.environmentIds.includes(project.environmentId) &&
              (!scope.members.length ||
                scope.members.some(
                  (member) =>
                    member.id === project.id && member.environmentId === project.environmentId,
                )),
          )
          .map((project) => (
            <SettingsRow
              key={`${project.environmentId}:${project.id}`}
              title={project.title}
              description={project.workspaceRoot}
              control={
                <Link
                  {...projectSettingsTarget(project)}
                  className="text-sm text-primary underline"
                >
                  Open project settings
                </Link>
              }
            />
          ))}
      </SettingsSection>
    </SettingsPage>
  );
}
