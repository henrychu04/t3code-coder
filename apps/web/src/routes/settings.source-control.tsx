import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { SourceControlPreferences } from "../components/settings/SourceControlPreferences";
import { projectSettingsTarget } from "../projectSettingsTarget";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { useState } from "react";
import type { SourceControlWriteAccessStatus } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";

import { GitLabIcon } from "../components/Icons";
import { SettingsPage, SettingsRow, SettingsSection } from "../components/settings/SettingsPage";
import { ScopedSettingsTarget } from "../components/settings/ScopedSettingsTarget";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { useProjects } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useAtomCommand } from "../state/use-atom-command";

function WorkspaceSourceControlPreferences({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SourceControlPreferences
      environmentId={environment.environmentId}
      settings={settings}
      updateSettings={updateSettings}
      providers={environment.serverConfig?.providers ?? []}
    />
  );
}

function textOf(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

const WRITE_ACCESS_LABELS: Record<SourceControlWriteAccessStatus, string> = {
  unchecked: "Not checked",
  writable: "Available",
  "policy-blocked": "Blocked by policy",
  unauthenticated: "Authentication required",
  indeterminate: "Could not verify",
};

const WRITE_ACCESS_DESCRIPTIONS: Record<SourceControlWriteAccessStatus, string> = {
  unchecked: "Write access has not been checked for this workspace session.",
  writable: "The workspace write probe succeeded. GitLab write actions are enabled.",
  "policy-blocked": "Workspace policy blocked the probe or a later GitLab write operation.",
  unauthenticated: "The write probe reported that the GitLab CLI is not authenticated.",
  indeterminate: "The write probe failed without a recognized policy or authentication result.",
};

function EnvironmentSourceControlStatus({ environment }: { environment: EnvironmentPresentation }) {
  const query = useEnvironmentQuery(
    sourceControlEnvironment.discovery({
      environmentId: environment.environmentId,
      input: undefined,
    }),
  );
  const reprobeWriteAccess = useAtomCommand(sourceControlEnvironment.probeWriteAccess, {
    reportFailure: false,
  });
  const [probingWrites, setProbingWrites] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const git = query.data?.versionControlSystems.find((item) => item.kind === "git") ?? null;
  const gitLab = query.data?.sourceControlProviders.find((item) => item.kind === "gitlab") ?? null;
  const gitReady = git?.status === "available" && git.implemented;
  const gitLabReady = gitLab?.status === "available" && gitLab.auth.status === "authenticated";
  const account = gitLab ? textOf(gitLab.auth.account) : null;
  const host = gitLab ? textOf(gitLab.auth.host) : null;
  const writeAccess = gitLab?.writeAccess ?? { status: "unchecked" as const, writable: false };

  const handleReprobe = async () => {
    setProbingWrites(true);
    setProbeError(null);
    const result = await reprobeWriteAccess({
      environmentId: environment.environmentId,
      input: { provider: "gitlab" },
    });
    setProbingWrites(false);
    if (result._tag === "Failure") {
      setProbeError("The workspace write probe could not be run.");
      return;
    }
    query.refresh();
  };

  return (
    <div className="space-y-3 rounded-xl border bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">{environment.label}</h3>
          {environment.displayUrl ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{environment.displayUrl}</p>
          ) : null}
        </div>
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
          Rescan
        </Button>
      </div>

      {query.error && query.data === null ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground">
          {query.error}
        </p>
      ) : (
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border">
          <SettingsRow
            title="Git"
            description={
              git === null
                ? "Checking the workspace Git installation."
                : gitReady
                  ? `Available${textOf(git.version) ? ` · ${textOf(git.version)}` : ""}`
                  : git.installHint
            }
            control={
              <Badge variant={gitReady ? "success" : "warning"}>
                <GitBranchIcon /> {gitReady ? "Available" : "Setup required"}
              </Badge>
            }
          />
          <SettingsRow
            title="GitLab CLI"
            description={
              gitLab === null
                ? "Checking the workspace GitLab CLI installation and authentication."
                : gitLabReady
                  ? `Authenticated${account ? ` as ${account}` : ""}${host ? ` on ${host}` : ""}`
                  : gitLab.status !== "available"
                    ? gitLab.installHint
                    : (textOf(gitLab.auth.detail) ??
                      "Run glab auth login in a terminal inside this Coder workspace.")
            }
            control={
              <Badge variant={gitLabReady ? "success" : "warning"}>
                <GitLabIcon /> {gitLabReady ? "Authenticated" : "Setup required"}
              </Badge>
            }
          />
          <SettingsRow
            title="GitLab writes"
            description={
              probeError ?? writeAccess.detail ?? WRITE_ACCESS_DESCRIPTIONS[writeAccess.status]
            }
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge variant={writeAccess.writable ? "success" : "warning"}>
                  {WRITE_ACCESS_LABELS[writeAccess.status]}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={probingWrites}
                  onClick={() => void handleReprobe()}
                >
                  <RefreshCwIcon className={probingWrites ? "animate-spin" : undefined} />
                  Reprobe
                </Button>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}

function ProjectSettingsLinks() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  return (
    <SettingsSection
      title="Project settings"
      description="Automatic pull and other project defaults live on each project's settings page."
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
  const { environments, isReady } = useEnvironments();
  return (
    <SettingsPage>
      <SettingsSection
        title="GitLab source control"
        description="Git and GitLab commands run only inside each Linux Coder workspace. Authentication is owned by the workspace-installed glab CLI; T3 never reads or stores its token."
      >
        <SettingsRow
          title="Authentication"
          description="If a workspace is not authenticated, open one of its terminals and run glab auth login, then rescan below."
          control={
            <Badge variant="info">
              <CheckCircle2Icon /> Workspace-owned
            </Badge>
          }
        />
      </SettingsSection>

      <ScopedSettingsTarget>
        {(environment) => (
          <WorkspaceSourceControlPreferences
            key={environment.environmentId}
            environment={environment}
          />
        )}
      </ScopedSettingsTarget>

      <ProjectSettingsLinks />

      <section className="space-y-3" id="gitlab-workspace-status">
        <div className="px-3 sm:px-4">
          <h2 className="text-lg font-semibold tracking-tight">Connected workspaces</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Availability and authentication are checked independently in every workspace.
          </p>
        </div>
        {!isReady ? (
          <p className="rounded-xl border p-5 text-sm text-muted-foreground">Loading workspaces…</p>
        ) : environments.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            <CircleAlertIcon className="size-4" /> Connect a Coder workspace first.
          </p>
        ) : (
          environments.map((environment) => (
            <EnvironmentSourceControlStatus
              key={environment.environmentId}
              environment={environment}
            />
          ))
        )}
      </section>
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/source-control")({
  component: SourceControlSettingsView,
});
