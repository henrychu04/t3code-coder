// Coder: only the native session list and import are carried, for Kilo Code. Logout and agent
// provider configuration are account and provider management; session deletion is not carried
// because Kilo Code advertises no `session/delete`.
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import type {
  AcpRegistrySession,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useLayoutEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

interface AcpSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The ACP operation failed.",
  });
}

interface AcpSessionManagementProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly projects: ReadonlyArray<AcpSessionProject>;
  readonly readOnly: boolean;
}

export function AcpSessionManagementSection(props: AcpSessionManagementProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(null);
  const projectId =
    props.projects.find((project) => project.id === selectedProjectId)?.id ??
    props.projects[0]?.id ??
    null;
  if (selectedProjectId !== projectId) setSelectedProjectId(projectId);

  return (
    <InstanceSessionManagement
      key={JSON.stringify([props.environmentId, props.instanceId])}
      {...props}
      projectId={projectId}
      onProjectChange={setSelectedProjectId}
    />
  );
}

function InstanceSessionManagement(
  props: AcpSessionManagementProps & {
    readonly projectId: ProjectId | null;
    readonly onProjectChange: (projectId: ProjectId) => void;
  },
) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const { projectId } = props;
  const projectGeneration = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Late continuations must not act on a replaced project scope.
  useLayoutEffect(() => {
    return () => {
      projectGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retiring a project invalidates its pending operations even when the instance stays mounted.
  }, [projectId]);
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [previousProjectId, setPreviousProjectId] = useState(projectId);
  if (previousProjectId !== projectId) {
    setPreviousProjectId(projectId);
    setSessions([]);
    setNextCursor(null);
    setLoading(false);
    setImportingSessionId(null);
  }
  const listSessions = useAtomCommand(serverEnvironment.listAcpRegistrySessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importAcpRegistrySession, {
    reportFailure: false,
  });
  const canList = props.provider.nativeSessions?.canList === true;
  const canImport =
    props.provider.nativeSessions?.canLoad === true ||
    props.provider.nativeSessions?.canResume === true;
  const projectOperationPending = loading || importingSessionId !== null;

  if (!canList) return null;

  const loadSessions = async (cursor?: string) => {
    const generation = projectGeneration.current;
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    if (generation !== projectGeneration.current) return;
    setLoading(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        cursor === undefined ? result.value.sessions : [...current, ...result.value.sessions],
      );
      setNextCursor(result.value.nextCursor);
      return;
    }
    reportFailure("Could not list ACP sessions", result);
  };

  const importNativeSession = async (session: AcpRegistrySession) => {
    const generation = projectGeneration.current;
    if (
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope) ||
      projectId === null ||
      importingSessionId !== null
    )
      return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId: props.environmentId,
      input: {
        instanceId: props.instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    if (generation !== projectGeneration.current) return;
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.sessionId === session.sessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      toastManager.add({
        type: "success",
        title: result.value.imported ? "ACP session imported" : "ACP session already imported",
      });
      return;
    }
    reportFailure("Could not import ACP session", result);
  };

  return (
    <div className="grid gap-3">
      <SettingsRow
        title="Native sessions"
        description="Resume agent-owned conversations as T3 threads."
        status={
          canList && props.projects.length === 0
            ? "Add a project before importing sessions."
            : undefined
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {canList && props.projects.length > 0 ? (
              <>
                <Select
                  value={projectId ?? ""}
                  disabled={!canRead || projectOperationPending}
                  onValueChange={(value) => {
                    if (value === null) return;
                    props.onProjectChange(value as ProjectId);
                  }}
                >
                  <SelectTrigger aria-label="Project for ACP sessions" className="w-40" size="sm">
                    <SelectValue>
                      {props.projects.find((project) => project.id === projectId)?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {props.projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRead || loading || projectId === null}
                  onClick={() => void loadSessions()}
                >
                  {loading ? "Loading" : sessions.length === 0 ? "List sessions" : "Refresh"}
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {canList && (sessions.length > 0 || nextCursor !== null) ? (
          <>
            {sessions.length > 0 ? (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {sessions.map((session) => (
                  <div
                    key={session.sessionId}
                    className="flex min-w-0 items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">
                        {session.title ?? session.sessionId}
                      </p>
                      <code className="block truncate text-3xs text-muted-foreground">
                        {session.sessionId}
                      </code>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost-muted"
                        disabled={
                          !canOperate ||
                          !canImport ||
                          session.importedThreadId !== null ||
                          importingSessionId !== null
                        }
                        onClick={() => void importNativeSession(session)}
                      >
                        {session.importedThreadId !== null
                          ? "Imported"
                          : importingSessionId === session.sessionId
                            ? "Importing"
                            : "Import"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {nextCursor !== null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="w-fit"
                disabled={!canRead || loading}
                onClick={() => void loadSessions(nextCursor)}
              >
                {loading ? "Loading" : "Load more"}
              </Button>
            ) : null}
          </>
        ) : null}
      </SettingsRow>
    </div>
  );
}
