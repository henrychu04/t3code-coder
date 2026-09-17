import { useId, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import {
  checkCoderDeploymentAuthentication,
  loginToCoderDeployment,
  type CoderDeploymentAuthenticationStatus,
  type CoderDeploymentProfile,
  type CoderProfileConfig,
} from "../../coder/api";
import { randomUUID } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { SettingsSection } from "./SettingsPage";
import {
  SettingsField,
  SettingsResource,
  SettingsResourceDialog,
  SettingsResourceEmpty,
  SettingsResourceError,
} from "./SettingsResource";
import { useSettingsOperation } from "./useSettingsOperation";
import { useSettingsPolling } from "./useSettingsPolling";
import type { UpdateCoderSettingsConfig } from "./useCoderSettingsConfig";

type AuthStatus = "checking" | CoderDeploymentAuthenticationStatus;
export function CoderDeploymentSettings({
  config,
  updateConfig,
}: {
  config: CoderProfileConfig;
  updateConfig: UpdateCoderSettingsConfig;
}) {
  const [editing, setEditing] = useState<CoderDeploymentProfile | "new" | null>(null);
  const operation = useSettingsOperation();
  return (
    <>
      <SettingsSection
        id="coder-connections"
        title="Coder domains"
        description="Add the Coder domains you use. Sign in through the terminal running T3 Coder."
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={operation.pending !== null}
            onClick={() => setEditing("new")}
          >
            <PlusIcon />
            Add domain
          </Button>
        }
      >
        {config.deployments.length === 0 ? (
          <SettingsResourceEmpty>
            No Coder domains yet. Add one to connect a workspace.
          </SettingsResourceEmpty>
        ) : (
          config.deployments.map((deployment) => (
            <DeploymentRow
              key={deployment.id}
              deployment={deployment}
              hasWorkspaces={config.workspaces.some(
                (workspace) => workspace.deploymentId === deployment.id,
              )}
              operation={operation}
              onEdit={() => setEditing(deployment)}
              onRemove={() =>
                updateConfig((current) => {
                  if (
                    current.workspaces.some((workspace) => workspace.deploymentId === deployment.id)
                  )
                    throw new Error("Remove this domain's workspace connections first.");
                  return {
                    ...current,
                    deployments: current.deployments.filter((entry) => entry.id !== deployment.id),
                  };
                })
              }
            />
          ))
        )}
      </SettingsSection>
      {editing !== null ? (
        <DeploymentEditor
          key={editing === "new" ? "new" : editing.id}
          deployment={editing === "new" ? null : editing}
          updateConfig={updateConfig}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}
function DeploymentRow({
  deployment,
  hasWorkspaces,
  operation,
  onEdit,
  onRemove,
}: {
  deployment: CoderDeploymentProfile;
  hasWorkspaces: boolean;
  operation: ReturnType<typeof useSettingsOperation>;
  onEdit: () => void;
  onRemove: () => Promise<void>;
}) {
  const auth = useSettingsPolling({
    identity: JSON.stringify(deployment),
    intervalMs: null,
    load: (signal) => checkCoderDeploymentAuthentication(deployment.id, signal),
  });
  const status: AuthStatus = auth.error ? "unavailable" : (auth.data ?? "checking");
  const busy = operation.pending !== null;
  const authenticating = operation.pending === `login:${deployment.id}`;
  const error =
    operation.error &&
    [`login:${deployment.id}`, `remove:${deployment.id}`].includes(operation.error.key)
      ? operation.error
      : auth.error
        ? { title: "Could not check sign-in status", details: auth.error }
        : null;
  const login = () =>
    operation.run(`login:${deployment.id}`, "Could not sign in to Coder", async () => {
      await loginToCoderDeployment(deployment.id);
      await auth.refresh();
    });
  return (
    <SettingsResource
      title={deployment.name}
      description={deployment.url}
      status={<AuthBadge status={status} />}
      actions={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || auth.pending}
            onClick={() => {
              if (status === "unavailable") void auth.refresh();
              else void login();
            }}
          >
            {authenticating
              ? "Waiting for terminal…"
              : status === "authenticated"
                ? "Reauthenticate"
                : status === "unavailable"
                  ? "Check again"
                  : status === "checking"
                    ? "Checking…"
                    : "Sign in"}
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Actions for ${deployment.name}`}
                  disabled={busy}
                >
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>Edit domain</MenuItem>
              <MenuItem disabled={auth.pending} onClick={() => void auth.refresh()}>
                Check sign-in status
              </MenuItem>
              <MenuItem
                disabled={hasWorkspaces}
                onClick={() =>
                  void operation.run(`remove:${deployment.id}`, "Could not remove domain", onRemove)
                }
              >
                Remove domain
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      {authenticating ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Complete sign-in in the terminal running T3 Coder.
        </p>
      ) : null}
      {hasWorkspaces ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Remove its workspace connections before removing this domain.
        </p>
      ) : null}
      <SettingsResourceError error={error} />
    </SettingsResource>
  );
}
export function AuthBadge({ status }: { status: AuthStatus }) {
  if (status === "checking")
    return (
      <Badge variant="outline">
        <LoaderCircleIcon className="animate-spin" />
        Checking…
      </Badge>
    );
  if (status === "authenticated")
    return (
      <Badge variant="success">
        <CheckCircle2Icon />
        Signed in
      </Badge>
    );
  return (
    <Badge variant="warning">
      <CircleAlertIcon />
      {status === "unavailable" ? "Status unavailable" : "Sign-in required"}
    </Badge>
  );
}
export function DeploymentEditor({
  deployment,
  updateConfig,
  onClose,
}: {
  deployment: CoderDeploymentProfile | null;
  updateConfig: UpdateCoderSettingsConfig;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(deployment?.name ?? "");
  const [url, setUrl] = useState(deployment?.url ?? "");
  const [executable, setExecutable] = useState(deployment?.executable ?? "");
  const operation = useSettingsOperation();
  return (
    <SettingsResourceDialog
      title={deployment ? "Edit Coder domain" : "Add Coder domain"}
      description="Save the domain and optional Coder executable for this computer."
      pending={operation.pending !== null}
      error={operation.error}
      onClose={onClose}
      submitLabel={deployment ? "Save changes" : "Add domain"}
      submitDisabled={!name.trim() || !url.trim()}
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || !url.trim()) return;
        void operation
          .run("save", "Could not save domain", async () => {
            const next: CoderDeploymentProfile = {
              id: deployment?.id ?? `coder-${randomUUID()}`,
              name: name.trim(),
              url: url.trim(),
              ...(executable.trim() ? { executable: executable.trim() } : {}),
            };
            await updateConfig((current) => {
              if (deployment && !current.deployments.some((entry) => entry.id === deployment.id))
                throw new Error("This domain was removed. Close the editor and add it again.");
              return {
                ...current,
                deployments: deployment
                  ? current.deployments.map((entry) => (entry.id === deployment.id ? next : entry))
                  : [...current.deployments, next],
              };
            });
          })
          .then((saved) => {
            if (saved) onClose();
          });
      }}
    >
      <SettingsField id={`${id}-name`} label="Display name">
        <Input id={`${id}-name`} required value={name} onValueChange={setName} />
      </SettingsField>
      <SettingsField id={`${id}-url`} label="Coder domain">
        <Input
          id={`${id}-url`}
          inputMode="url"
          placeholder="https://coder.example.com"
          required
          value={url}
          onValueChange={setUrl}
        />
      </SettingsField>
      <SettingsField id={`${id}-executable`} label="Coder executable (optional)">
        <Input
          id={`${id}-executable`}
          placeholder="coder or C:\\path\\to\\coder.exe"
          value={executable}
          onValueChange={setExecutable}
        />
      </SettingsField>
    </SettingsResourceDialog>
  );
}
