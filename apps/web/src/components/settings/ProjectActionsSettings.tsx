import { useT3ProjectFile } from "../../hooks/useT3ProjectFile";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { useState } from "react";
import { PlusIcon } from "lucide-react";
import { useEnvironments } from "../../state/environments";
import {
  EMPTY_PROJECT_SCRIPT_INPUT,
  editorRequestForScript,
  ProjectScriptEditorDialog,
  type ProjectScriptEditorRequest,
} from "../projectScriptEditor";
import { Button } from "../ui/button";
import { ProjectActionsList } from "./ProjectActionsList";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { useSettingsScope } from "./SettingsScopeContext";

/** Upstream action editing, with workspace defaults and explicit imports from repository metadata. */
export function ProjectActionsSettings() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const config = useT3ProjectFile(isProjectScope ? target : null);
  const scripts = target?.settings.defaultProjectScripts ?? [];
  const importable = (config.file?.scripts ?? []).filter(
    (candidate) =>
      !scripts.some(
        (script) =>
          script.name.trim().toLowerCase() === candidate.name.trim().toLowerCase() ||
          script.command.trim() === candidate.command.trim(),
      ),
  );
  const mixed = targets.some(
    (candidate) =>
      JSON.stringify(candidate.settings.defaultProjectScripts) !== JSON.stringify(scripts),
  );
  const [request, setRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const memberById = new Map(
    isProjectScope
      ? scope.members.map((member) => [`${member.environmentId}:${member.id}`, member])
      : [],
  );
  const { saving, persist, submit } = useProjectScriptSettings(
    targets.flatMap((candidate) => {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      if (!environment?.serverConfig) return [];
      const member = candidate.projectId
        ? memberById.get(`${candidate.environmentId}:${candidate.projectId}`)
        : undefined;
      // An older server ignores the override record, so a project edit there
      // would report success and vanish; such environments are left out and
      // the legacy per-project map keeps serving them.
      if (
        member &&
        environment.serverConfig.environment?.capabilities.projectSettingsOverrides !== true
      ) {
        return [];
      }
      return [
        {
          environmentId: candidate.environmentId,
          // Writes read the raw environment settings so an override entry is
          // extended, not derived from already-resolved values.
          settings: environment.serverConfig.settings,
          ...(member ? { project: member } : {}),
        },
      ];
    }),
  );

  return (
    <SettingsSection
      id={isProjectScope ? "project-actions" : "default-project-actions"}
      title={isProjectScope ? "Actions" : "Default actions"}
    >
      <SettingsRow
        settingKeys={["defaultProjectScripts"]}
        title="Actions"
        description="Commands that run in the checkout or its worktree."
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            {importable.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="xs" variant="outline" disabled={saving}>
                      Import scripts
                    </Button>
                  }
                />
                <MenuPopup>
                  {importable.map((script, index) => (
                    <MenuItem
                      key={index}
                      onClick={() => {
                        const initial = {
                          ...script,
                          icon: script.icon ?? "play",
                          runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
                        };
                        void submit(null, initial).then((result) => {
                          if (result._tag === "Failure")
                            setRequest({
                              scriptId: null,
                              initial,
                              error: "Could not import this script. Review it and try again.",
                            });
                        });
                      }}
                    >
                      {script.name}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
            {isProjectScope && target?.projectId ? (
              <Button size="xs" variant="ghost" onClick={config.refresh}>
                Refresh t3.json
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={saving || targets.length === 0}
              onClick={() => setRequest({ scriptId: null, initial: EMPTY_PROJECT_SCRIPT_INPUT })}
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>
        }
      />
      {config.status === "invalid" ? (
        <SettingsRow
          title="Invalid t3.json"
          description="Fix the project's t3.json file, then refresh to import its scripts."
        />
      ) : null}
      {config.status === "unavailable" ? (
        <SettingsRow
          title="Repository settings unavailable"
          description="Connect the workspace and refresh to read t3.json."
        />
      ) : null}
      {mixed ? (
        <SettingsRow
          title="Different actions across environments"
          description="Choose one environment to edit its list. Adding an action here adds it on every selected environment."
        />
      ) : (
        <ProjectActionsList
          scripts={scripts}
          disabled={saving}
          onEdit={(script) => setRequest(editorRequestForScript(script))}
        />
      )}
      <ProjectScriptEditorDialog
        request={request}
        onSubmit={submit}
        onDelete={(id) => void persist((current) => current.filter((script) => script.id !== id))}
        onClose={() => setRequest(null)}
      />
    </SettingsSection>
  );
}
