import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { ArchiveIcon, ArchiveRestoreIcon, LoaderCircleIcon } from "lucide-react";
import { useMemo } from "react";

import { SettingsPage, SettingsRow, SettingsSection } from "../components/settings/SettingsPage";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useThreadActions } from "../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useEnvironments } from "../state/environments";
import { formatRelativeTimeLabel } from "../timestampFormat";

function ArchivedThreadsView() {
  const { environments } = useEnvironments();
  const environmentIds = useMemo(
    () => environments.map((environment) => environment.environmentId),
    [environments],
  );
  const { unarchiveThread } = useThreadActions();
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);

  const groups = useMemo(() => {
    return snapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.projects.flatMap((project) => {
        const threads = snapshot.threads
          .filter((thread) => thread.projectId === project.id)
          .toSorted((left, right) => {
            const leftDate = left.archivedAt ?? left.createdAt;
            const rightDate = right.archivedAt ?? right.createdAt;
            return rightDate.localeCompare(leftDate);
          });
        return threads.length === 0 ? [] : [{ environmentId, project, threads }];
      }),
    );
  }, [snapshots]);

  const handleUnarchive = async (environmentId: EnvironmentId, threadId: ThreadId) => {
    const result = await unarchiveThread(scopeThreadRef(environmentId, threadId));
    if (result._tag === "Success") {
      refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to unarchive thread",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <SettingsPage>
      <div className="contents" id="archived-threads">
        {groups.length === 0 ? (
          <SettingsSection title="Archived threads">
            <SettingsRow
              title={
                isLoading
                  ? "Loading archived threads"
                  : error
                    ? "Could not load archived threads"
                    : "No archived threads"
              }
              description={
                isLoading
                  ? "Checking connected Coder workspaces."
                  : (error ?? "Archived threads will appear here.")
              }
              control={
                isLoading ? (
                  <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-4 text-muted-foreground" />
                )
              }
            />
          </SettingsSection>
        ) : (
          groups.map(({ environmentId, project, threads }) => (
            <SettingsSection key={`${environmentId}:${project.id}`} title={project.title}>
              {threads.map((thread) => (
                <SettingsRow
                  key={thread.id}
                  title={thread.title}
                  description={`Archived ${formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}`}
                  control={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleUnarchive(environmentId, thread.id)}
                    >
                      <ArchiveRestoreIcon />
                      Unarchive
                    </Button>
                  }
                />
              ))}
            </SettingsSection>
          ))
        )}
      </div>
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/archived")({
  component: ArchivedThreadsView,
});
