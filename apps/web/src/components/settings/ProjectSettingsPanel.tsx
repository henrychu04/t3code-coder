import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { serverEnvironment } from "../../state/server";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowLeftIcon } from "lucide-react";

import { parseProjectSettingsKey, projectSettingsTarget } from "../../projectSettingsTarget";
import { readProject, useProject, useProjects } from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getModelOptionsByInstance, resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveCoderProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import {
  projectSettingsChanged,
  projectSettingsValues,
  validateProjectSettings,
} from "./ProjectSettingsPanel.logic";

/** Upstream's dedicated project route, scoped to a single workspace-owned checkout. */
export function ProjectSettingsPage({ projectKey }: { projectKey: string }) {
  const ref = parseProjectSettingsKey(projectKey);
  const project = useProject(ref);
  const projects = useProjects();
  const { environments, isReady } = useEnvironments();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const goBack = useCallback(() => {
    if (canGoBack) window.history.back();
    else void navigate({ to: "/" });
  }, [canGoBack, navigate]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      )
        return;
      event.preventDefault();
      goBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back from project settings"
          onClick={goBack}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="font-medium">Project settings</h1>
        <select
          aria-label="Project settings checkout"
          className="ml-auto min-w-0 max-w-sm rounded border bg-background p-1 text-sm"
          value={project ? projectSettingsTarget(project).params.projectKey : ""}
          onChange={(event) => {
            const selected = projects.find(
              (candidate) =>
                projectSettingsTarget(candidate).params.projectKey === event.target.value,
            );
            if (selected) void navigate(projectSettingsTarget(selected));
          }}
        >
          {!project && <option value="">Select a project</option>}
          {projects.map((candidate) => (
            <option
              key={projectSettingsTarget(candidate).params.projectKey}
              value={projectSettingsTarget(candidate).params.projectKey}
            >
              {candidate.title} ·{" "}
              {environments.find(
                (environment) => environment.environmentId === candidate.environmentId,
              )?.label ?? candidate.environmentId}
            </option>
          ))}
        </select>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          {project ? (
            <ProjectSettingsPanel key={projectKey} project={project} />
          ) : (
            <p role="status">
              {!ref
                ? "Invalid project settings link."
                : !isReady
                  ? "Loading project settings…"
                  : "Project unavailable. Connect its Coder workspace or select another project."}
            </p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

export function ProjectSettingsPanel({ project }: { project: EnvironmentProject }) {
  const environment = useEnvironment(project.environmentId);
  const settings = useEnvironmentSettings(project.environmentId);
  const resolvedProject = {
    ...project,
    autoPull: resolveProjectAutoPull(settings, project.id, project.autoPull),
    scripts: resolveProjectScripts(settings, project),
  };
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [baseline, setBaseline] = useState(() => projectSettingsValues(resolvedProject));
  const [values, setValues] = useState(baseline);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const connected = environment?.connection.phase === "connected";
  const stale = projectSettingsChanged(baseline, resolvedProject);
  const providers = environment?.serverConfig?.providers ?? [];
  const selection =
    values.defaultModelSelection ??
    settings.defaultModelSelection ??
    resolveAppModelSelectionState(settings, providers);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveCoderProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );

  const save = async () => {
    if (saving.current || !connected) return;
    const current = readProject({ environmentId: project.environmentId, projectId: project.id });
    if (
      !current ||
      projectSettingsChanged(baseline, {
        ...current,
        autoPull: resolveProjectAutoPull(settings, current.id, current.autoPull),
        scripts: resolveProjectScripts(settings, current),
      })
    ) {
      setNotice("Project settings changed elsewhere. Reload settings before saving.");
      return;
    }
    const normalized = {
      ...values,
      title: values.title.trim(),
      scripts: values.scripts.map((script) => ({
        ...script,
        name: script.name.trim(),
        command: script.command.trim(),
      })),
    };
    const validation = validateProjectSettings(normalized);
    if (validation) {
      setNotice(validation);
      return;
    }
    saving.current = true;
    setPending(true);
    setNotice(null);
    try {
      const result = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          ...normalized,
          autoPull:
            normalized.autoPull !== baseline.autoPull
              ? normalized.autoPull
              : (project.autoPull ?? false),
          scripts:
            JSON.stringify(normalized.scripts) !== JSON.stringify(baseline.scripts)
              ? normalized.scripts
              : project.scripts,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setNotice(error instanceof Error ? error.message : "Could not save project settings.");
        }
        return;
      }
      const patch = {
        ...(normalized.autoPull !== baseline.autoPull
          ? { projectAutoPullOverrides: { [project.id]: normalized.autoPull } }
          : {}),
        ...(JSON.stringify(normalized.scripts) !== JSON.stringify(baseline.scripts)
          ? { projectScriptOverrides: { [project.id]: normalized.scripts } }
          : {}),
      };
      const overrideResult = Object.keys(patch).length
        ? await updateSettings({ environmentId: project.environmentId, input: { patch } })
        : { _tag: "Success" };
      if (overrideResult._tag === "Failure") {
        setNotice("Project saved, but overrides could not be saved. Reload before retrying.");
        return;
      }
      setBaseline(normalized);
      setValues(normalized);
      setNotice("Project settings saved.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  const resetInherited = async (kind: "scripts" | "autoPull") => {
    if (saving.current || !connected) return;
    saving.current = true;
    setPending(true);
    setNotice(null);
    try {
      const clearLegacy = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          ...(kind === "scripts" ? { scripts: [] } : { autoPull: false }),
        },
      });
      if (clearLegacy._tag === "Failure") {
        setNotice("Could not reset the project setting.");
        return;
      }
      const result = await updateSettings({
        environmentId: project.environmentId,
        input: {
          patch:
            kind === "scripts"
              ? { projectScriptOverrides: { [project.id]: null } }
              : { projectAutoPullOverrides: { [project.id]: null } },
        },
      });
      if (result._tag === "Failure") {
        setNotice("Project updated, but the override could not be reset. Reload before retrying.");
        return;
      }
      const next = {
        ...baseline,
        ...(kind === "scripts"
          ? { scripts: settings.defaultProjectScripts }
          : { autoPull: settings.defaultAutoPull }),
      };
      setBaseline(next);
      setValues((current) => ({
        ...current,
        ...(kind === "scripts" ? { scripts: next.scripts } : { autoPull: next.autoPull }),
      }));
      setNotice("Now using the workspace default.");
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-8"
    >
      <p className="text-sm text-muted-foreground">
        Changes apply only to {project.title} in {environment?.label ?? "this Coder workspace"}.
        They are stored in the workspace; other checkouts are unchanged.
      </p>
      {!connected && (
        <p role="status">Connect this Coder workspace to edit its project settings.</p>
      )}
      {stale && (
        <p role="status">Project settings changed elsewhere. Reload settings before saving.</p>
      )}
      <fieldset disabled={pending || !connected} className="space-y-8 disabled:opacity-60">
        <SettingsSection title="Project">
          <SettingsRow
            title="Name"
            control={
              <Input
                aria-label="Project name"
                value={values.title}
                onChange={(event) => setValues({ ...values, title: event.target.value })}
              />
            }
          />
          <SettingsRow
            title="Model"
            description="Default model for new threads. Existing threads are unchanged."
            control={
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  aria-label="Override project model"
                  checked={values.defaultModelSelection !== null}
                  onCheckedChange={(enabled) =>
                    setValues({
                      ...values,
                      defaultModelSelection: enabled
                        ? createModelSelection(
                            selection.instanceId,
                            selection.model,
                            selection.options,
                          )
                        : null,
                    })
                  }
                />
                {values.defaultModelSelection ? (
                  <ProviderModelPicker
                    environmentId={project.environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    disabled={pending || !connected}
                    triggerAriaLabel="Project default model"
                    onInstanceModelChange={(instanceId, model) =>
                      setValues({
                        ...values,
                        defaultModelSelection: createModelSelection(instanceId, model),
                      })
                    }
                  />
                ) : (
                  <span className="text-sm">Use workspace default</span>
                )}
              </div>
            }
          />
          <SettingsRow
            title="Workspace"
            description="Where new threads start inside this Linux Coder workspace."
            control={
              <select
                aria-label="New-thread workspace"
                className="rounded border bg-background p-2 text-sm"
                value={values.defaultThreadEnvMode ?? "inherit"}
                onChange={(event) =>
                  setValues({
                    ...values,
                    defaultThreadEnvMode:
                      event.target.value === "worktree"
                        ? "worktree"
                        : event.target.value === "local"
                          ? "local"
                          : null,
                  })
                }
              >
                <option value="inherit">Use default</option>
                <option value="local">Current checkout</option>
                <option value="worktree">New worktree</option>
              </select>
            }
          />
          <SettingsRow
            title="Automatically pull"
            description="Fast-forward the default branch only when the checkout has no changed files, untracked files, or local commits."
            control={
              <Switch
                aria-label="Automatically pull the default branch"
                checked={values.autoPull}
                onCheckedChange={(autoPull) => setValues({ ...values, autoPull })}
              />
            }
          />
        </SettingsSection>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void resetInherited("autoPull")}>
            Use workspace automatic-pull default
          </Button>
          <Button type="button" variant="outline" onClick={() => void resetInherited("scripts")}>
            Use workspace default scripts
          </Button>
        </div>
        <SettingsSection title="Checkout">
          <SettingsRow
            title="Coder workspace"
            description={environment?.label ?? project.environmentId}
          />
          <SettingsRow title="Project path">
            <code className="break-all text-xs">{project.workspaceRoot}</code>
          </SettingsRow>
        </SettingsSection>
        <SettingsSection
          title="Scripts"
          description="Commands are stored with this project. Saving does not run them. At most one setup script can run when a new worktree is created in the workspace."
        >
          {values.scripts.map((script, index) => (
            <div key={script.id} className="space-y-3 p-4">
              <Input
                aria-label={`Script ${index + 1} name`}
                value={script.name}
                onChange={(event) =>
                  setValues({
                    ...values,
                    scripts: values.scripts.map((item) =>
                      item.id === script.id ? { ...item, name: event.target.value } : item,
                    ),
                  })
                }
              />
              <Textarea
                aria-label={`Script ${index + 1} command`}
                value={script.command}
                onChange={(event) =>
                  setValues({
                    ...values,
                    scripts: values.scripts.map((item) =>
                      item.id === script.id ? { ...item, command: event.target.value } : item,
                    ),
                  })
                }
              />
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label={`Run script ${index + 1} on worktree creation`}
                  checked={script.runOnWorktreeCreate}
                  onCheckedChange={(checked) =>
                    setValues({
                      ...values,
                      scripts: values.scripts.map((item) => ({
                        ...item,
                        runOnWorktreeCreate:
                          item.id === script.id
                            ? checked
                            : checked
                              ? false
                              : item.runOnWorktreeCreate,
                      })),
                    })
                  }
                />
                Run on worktree creation
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setValues({
                    ...values,
                    scripts: values.scripts.filter((item) => item.id !== script.id),
                  })
                }
              >
                Remove script {index + 1}
              </Button>
            </div>
          ))}
          <div className="p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setValues({
                  ...values,
                  scripts: [
                    ...values.scripts,
                    {
                      id: crypto.randomUUID(),
                      name: "",
                      command: "",
                      icon: "play",
                      runOnWorktreeCreate: false,
                    },
                  ],
                })
              }
            >
              Add script
            </Button>
          </div>
        </SettingsSection>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={pending || !connected || stale || !projectSettingsChanged(baseline, values)}
        >
          {pending ? "Saving…" : "Save project settings"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            const next = projectSettingsValues(resolvedProject);
            setBaseline(next);
            setValues(next);
            setNotice(null);
          }}
        >
          Reload settings
        </Button>
      </div>
    </form>
  );
}
