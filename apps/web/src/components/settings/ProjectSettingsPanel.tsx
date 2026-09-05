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
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [baseline, setBaseline] = useState(() => projectSettingsValues(project));
  const [values, setValues] = useState(baseline);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const connected = environment?.connection.phase === "connected";
  const stale = projectSettingsChanged(baseline, project);
  const providers = environment?.serverConfig?.providers ?? [];
  const selection =
    values.defaultModelSelection ?? resolveAppModelSelectionState(settings, providers);
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
    if (!current || projectSettingsChanged(baseline, current)) {
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
        input: { projectId: project.id, ...normalized },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setNotice(error instanceof Error ? error.message : "Could not save project settings.");
        }
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
            const next = projectSettingsValues(project);
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
