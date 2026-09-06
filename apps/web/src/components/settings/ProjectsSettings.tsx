import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectScript,
} from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { projectSettingsTarget } from "../../projectSettingsTarget";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { validateProjectSettings } from "./ProjectSettingsPanel.logic";

export function ProjectsSettings() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [scope, setScope] = useState<EnvironmentId | null>(null);
  const targets = environments.filter(
    (environment) =>
      (scope === null || environment.environmentId === scope) &&
      environment.connection.phase === "connected" &&
      environment.serverConfig !== null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return (
    <SettingsPage>
      <SettingsSection
        title="Project defaults"
        description="Defaults are stored in each selected Coder workspace. Explicit project overrides and existing actions are preserved. Offline workspaces keep their previous values."
      >
        <SettingsRow
          title="Coder workspace"
          control={
            <select
              aria-label="Project defaults workspace"
              className="rounded border bg-background p-2 text-sm"
              value={scope ?? "all"}
              onChange={(event) => {
                setScope(
                  event.target.value === "all" ? null : (event.target.value as EnvironmentId),
                );
                setNotice(null);
              }}
            >
              <option value="all">All connected workspaces</option>
              {environments.map((environment) => (
                <option key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </option>
              ))}
            </select>
          }
        />
        {targets.length === 0 ? (
          <p className="p-4" role="status">
            Connect a Coder workspace to edit defaults.
          </p>
        ) : (
          <DefaultsForm
            key={scope ?? "all"}
            settings={targets[0]!.serverConfig!.settings}
            providers={targets[0]!.serverConfig!.providers}
            disabled={pending}
            onSave={async (patch) => {
              if (pending) return;
              const selection = patch.defaultModelSelection;
              if (
                selection &&
                targets.some(
                  (target) =>
                    !target.serverConfig?.providers.some(
                      (provider) =>
                        provider.instanceId === selection.instanceId &&
                        provider.enabled &&
                        provider.models.some((model) => model.slug === selection.model),
                    ),
                )
              ) {
                setNotice(
                  "Select a model available in every selected workspace, or choose one workspace.",
                );
                return;
              }
              setPending(true);
              setNotice(null);
              try {
                const results = await Promise.all(
                  targets.map(async (target) => ({
                    label: target.label,
                    result: await update({ environmentId: target.environmentId, input: { patch } }),
                  })),
                );
                const failed = results.filter(({ result }) => result._tag === "Failure");
                setNotice(
                  failed.length
                    ? `Could not save defaults in: ${failed.map(({ label }) => label).join(", ")}. Other selected workspaces were updated.`
                    : "Project defaults saved.",
                );
              } finally {
                setPending(false);
              }
            }}
          />
        )}
        {targets.length > 1 && (
          <p className="p-4 text-sm text-muted-foreground">
            The form starts with {targets[0]!.label}'s defaults. Saving applies these values to all
            selected connected workspaces.
          </p>
        )}
        {notice && (
          <p role="status" className="p-4 text-sm">
            {notice}
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Project overrides"
        description="Open a project to change its model, checkout, automatic pull, or scripts."
      >
        {projects.map((project) => (
          <SettingsRow
            key={`${project.environmentId}:${project.id}`}
            title={project.title}
            description={
              environments.find(
                (environment) => environment.environmentId === project.environmentId,
              )?.label ?? project.environmentId
            }
            control={
              <Link {...projectSettingsTarget(project)} className="text-primary underline">
                Edit project
              </Link>
            }
          />
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}

function DefaultsForm({
  settings,
  providers,
  disabled,
  onSave,
}: {
  settings: typeof DEFAULT_SERVER_SETTINGS;
  providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>;
  disabled: boolean;
  onSave: (patch: {
    defaultModelSelection: ModelSelection | null;
    defaultAutoPull: boolean;
    defaultThreadEnvMode: "local" | "worktree";
    defaultProjectScripts: ProjectScript[];
  }) => Promise<void>;
}) {
  const [model, setModel] = useState(settings.defaultModelSelection);
  const [autoPull, setAutoPull] = useState(settings.defaultAutoPull);
  const [mode, setMode] = useState(settings.defaultThreadEnvMode);
  const [scripts, setScripts] = useState([...settings.defaultProjectScripts]);
  const [error, setError] = useState<string | null>(null);
  const models = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.map((entry) => ({ instanceId: provider.instanceId, model: entry.slug })),
    );
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const validation = validateProjectSettings({
          title: "Defaults",
          defaultModelSelection: model,
          defaultThreadEnvMode: mode,
          autoPull,
          scripts,
        });
        setError(validation);
        if (!validation)
          void onSave({
            defaultModelSelection: model,
            defaultAutoPull: autoPull,
            defaultThreadEnvMode: mode,
            defaultProjectScripts: scripts,
          });
      }}
    >
      <fieldset disabled={disabled} className="space-y-4">
        <SettingsRow
          title="Default model"
          control={
            <select
              aria-label="Default model"
              className="rounded border bg-background p-2"
              value={model ? JSON.stringify([model.instanceId, model.model]) : ""}
              onChange={(event) => {
                const selected = models.find(
                  (entry) => JSON.stringify([entry.instanceId, entry.model]) === event.target.value,
                );
                setModel(selected ?? null);
              }}
            >
              <option value="">Use provider default</option>
              {models.map((entry) => (
                <option
                  key={JSON.stringify([entry.instanceId, entry.model])}
                  value={JSON.stringify([entry.instanceId, entry.model])}
                >
                  {entry.instanceId} · {entry.model}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="New threads"
          control={
            <select
              aria-label="Default checkout mode"
              value={mode}
              className="rounded border bg-background p-2"
              onChange={(event) =>
                setMode(event.target.value === "worktree" ? "worktree" : "local")
              }
            >
              <option value="local">Current checkout</option>
              <option value="worktree">New worktree</option>
            </select>
          }
        />
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoPull}
            onChange={(event) => setAutoPull(event.target.checked)}
          />
          Automatically pull clean default-branch checkouts when the helper starts
        </label>
        <p className="text-sm">
          Default scripts apply to projects that inherit actions. Saving does not run them.
        </p>
        {scripts.map((script, index) => (
          <div key={script.id} className="space-y-2 rounded border p-3">
            <Input
              aria-label={`Default script ${index + 1} name`}
              value={script.name}
              onChange={(event) =>
                setScripts(
                  scripts.map((entry) =>
                    entry.id === script.id ? { ...entry, name: event.target.value } : entry,
                  ),
                )
              }
            />
            <Textarea
              aria-label={`Default script ${index + 1} command`}
              value={script.command}
              onChange={(event) =>
                setScripts(
                  scripts.map((entry) =>
                    entry.id === script.id ? { ...entry, command: event.target.value } : entry,
                  ),
                )
              }
            />
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={script.runOnWorktreeCreate}
                onChange={(event) =>
                  setScripts(
                    scripts.map((entry) => ({
                      ...entry,
                      runOnWorktreeCreate:
                        entry.id === script.id
                          ? event.target.checked
                          : event.target.checked
                            ? false
                            : entry.runOnWorktreeCreate,
                    })),
                  )
                }
              />
              Run when a worktree is created
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => setScripts(scripts.filter((entry) => entry.id !== script.id))}
            >
              Remove script
            </Button>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setScripts([
                ...scripts,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  command: "",
                  icon: "play",
                  runOnWorktreeCreate: false,
                },
              ])
            }
          >
            Add script
          </Button>
          <Button type="submit">{disabled ? "Saving…" : "Save defaults"}</Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}
