import * as Option from "effect/Option";
import type { SourceControlWriteAccessStatus } from "@t3tools/contracts";
import { GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { GitLabIcon } from "../Icons";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import { SettingsResource, SettingsResourceEmpty, SettingsResourceError } from "./SettingsResource";
import { useSettingsOperation } from "./useSettingsOperation";
import { useSettingsScope } from "./SettingsScopeContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";

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

export function EnvironmentSourceControlStatus({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  const query = useEnvironmentQuery(
    sourceControlEnvironment.discovery({
      environmentId: environment.environmentId,
      input: undefined,
    }),
  );
  const reprobeWriteAccess = useAtomCommand(sourceControlEnvironment.probeWriteAccess, {
    reportFailure: false,
  });
  const operation = useSettingsOperation();
  const probingWrites = operation.pending !== null;
  const git = query.data?.versionControlSystems.find((item) => item.kind === "git") ?? null;
  const gitLab = query.data?.sourceControlProviders.find((item) => item.kind === "gitlab") ?? null;
  const gitReady = git?.status === "available" && git.implemented;
  const gitLabReady = gitLab?.status === "available" && gitLab.auth.status === "authenticated";
  const account = gitLab ? textOf(gitLab.auth.account) : null;
  const host = gitLab ? textOf(gitLab.auth.host) : null;
  const writeAccess = gitLab?.writeAccess ?? { status: "unchecked" as const, writable: false };

  const handleReprobe = () =>
    operation.run("probe", "Could not check GitLab write access", async () => {
      const result = await reprobeWriteAccess({
        environmentId: environment.environmentId,
        input: { provider: "gitlab" },
      });
      if (result._tag === "Failure") throw new Error("The workspace write probe could not be run.");
      query.refresh();
    });

  return (
    <SettingsResource
      title={environment.label}
      description={environment.displayUrl ?? undefined}
      actions={
        <Button size="xs" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
          Check status
        </Button>
      }
    >
      {query.error ? (
        <SettingsResourceError
          error={{ title: "Could not check GitLab status", details: query.error }}
        />
      ) : (
        <div className="mt-3 divide-y divide-border/50">
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
              <Badge variant={git === null ? "outline" : gitReady ? "success" : "warning"}>
                <GitBranchIcon />{" "}
                {git === null ? "Checking…" : gitReady ? "Available" : "Setup required"}
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
              <Badge variant={gitLab === null ? "outline" : gitLabReady ? "success" : "warning"}>
                <GitLabIcon />{" "}
                {gitLab === null ? "Checking…" : gitLabReady ? "Authenticated" : "Setup required"}
              </Badge>
            }
          />
          <SettingsRow
            title="GitLab writes"
            description={writeAccess.detail ?? WRITE_ACCESS_DESCRIPTIONS[writeAccess.status]}
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge
                  variant={
                    writeAccess.status === "unchecked"
                      ? "outline"
                      : writeAccess.writable
                        ? "success"
                        : "warning"
                  }
                >
                  {WRITE_ACCESS_LABELS[writeAccess.status]}
                </Badge>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={probingWrites || query.isPending || !gitLabReady}
                  onClick={() => void handleReprobe()}
                >
                  <RefreshCwIcon className={probingWrites ? "animate-spin" : undefined} />
                  Check write access
                </Button>
              </div>
            }
          />
        </div>
      )}
      <SettingsResourceError error={operation.error} />
    </SettingsResource>
  );
}

export function GitLabWorkspaceSettings() {
  const { environments } = useSettingsScope();
  const { isReady } = useEnvironments();
  return (
    <SettingsSection
      id="gitlab-workspace-status"
      title="Workspace GitLab status"
      description="Installation, authentication, and write access for the selected workspaces."
    >
      {!isReady ? (
        <SettingsResourceEmpty>Loading workspaces…</SettingsResourceEmpty>
      ) : environments.length === 0 ? (
        <SettingsResourceEmpty>
          Connect a selected Coder workspace to check GitLab status.
        </SettingsResourceEmpty>
      ) : (
        environments.map((environment) => (
          <EnvironmentSourceControlStatus
            key={environment.environmentId}
            environment={environment}
          />
        ))
      )}
    </SettingsSection>
  );
}
