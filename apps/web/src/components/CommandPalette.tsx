import { useAtomCommand } from "../state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { inferProjectTitleFromPath } from "@t3tools/client-runtime/state/projects";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { onOpenCommandPalette } from "../commandPaletteBus";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { newProjectId } from "../lib/utils";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function CommandPalette({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      onOpenCommandPalette(() => {
        setOpen(true);
      }),
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {children}
      {open ? <AddProjectDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddProjectDialog({ onClose }: { readonly onClose: () => void }) {
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const environmentId = usePrimaryEnvironmentId();
  const environment = usePrimaryEnvironment();
  const projects = useProjects();
  const createProject = useAtomCommand(projectEnvironment.create);
  const handleNewThread = useNewThreadHandler();

  const submit = useCallback(async () => {
    const cwd = workspaceRoot.trim();
    if (!cwd.startsWith("/")) {
      setError("Enter an absolute Linux path in the Coder workspace.");
      return;
    }
    if (environmentId === null) {
      setError("The Coder workspace is still connecting.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const existing = projects.find(
        (project) => project.environmentId === environmentId && project.workspaceRoot === cwd,
      );
      const projectId = existing?.id ?? newProjectId();
      if (!existing) {
        const result = await createProject({
          environmentId,
          input: {
            projectId,
            title: inferProjectTitleFromPath(cwd),
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: resolveDefaultProviderModelSelection(
              environment?.serverConfig?.providers ?? [],
              null,
            ),
          },
        });
        if (result._tag === "Failure") {
          throw squashAtomCommandFailure(result);
        }
      }
      await handleNewThread(scopeProjectRef(environmentId, projectId));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to add project.");
    } finally {
      setSubmitting(false);
    }
  }, [
    createProject,
    environment?.serverConfig?.providers,
    environmentId,
    handleNewThread,
    onClose,
    projects,
    workspaceRoot,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[15vh]"
      data-command-palette
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="w-full max-w-lg rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-base font-semibold">Add a workspace project</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter a path that already exists inside the remote Linux workspace. No files are copied.
        </p>
        <Input
          autoFocus
          className="mt-4"
          placeholder="/home/coder/project"
          value={workspaceRoot}
          onChange={(event) => setWorkspaceRoot(event.target.value)}
        />
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || workspaceRoot.trim().length === 0}>
            {submitting ? "Adding…" : "Add project"}
          </Button>
        </div>
      </form>
    </div>
  );
}
