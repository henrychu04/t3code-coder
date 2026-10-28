import { AuthMcpClientAccess } from "@t3tools/contracts";
import { EyeIcon, type LucideIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import type {
  CoderProfileConfig,
  CoderWorkspaceLinkProfile,
  CoderWorkspaceProfile,
} from "../../coder/api";
import { randomUUID } from "../../lib/utils";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./settingsSelect";
import {
  SettingsField,
  SettingsResource,
  SettingsResourceDialog,
  SettingsResourceEmpty,
  SettingsResourceError,
} from "./SettingsResource";
import type { UpdateCoderSettingsConfig } from "./useCoderSettingsConfig";
import { useSettingsOperation } from "./useSettingsOperation";

const EMPTY_LINKS: readonly CoderWorkspaceLinkProfile[] = [];

/** Upstream's link access labels (`ConnectAgentSurface.tsx`'s `accessConfig`, not carried). */
export const workspaceLinkAccessConfig: Record<
  AuthMcpClientAccess,
  { readonly label: string; readonly description: string; readonly icon: LucideIcon }
> = {
  "read-only": {
    label: "Read only",
    description: "Read projects and threads. Cannot start, message or change anything.",
    icon: EyeIcon,
  },
  ...runtimeModeConfig,
};

/**
 * Coder: link rules replace upstream's pairing. A rule lets agents in one workspace act in
 * another through the gateway while both are connected, capped at the rule's access.
 */
export function WorkspaceLinkSettings({
  config,
  updateConfig,
}: {
  config: CoderProfileConfig;
  updateConfig: UpdateCoderSettingsConfig;
}) {
  const links = config.workspaceLinks ?? EMPTY_LINKS;
  const [editing, setEditing] = useState<CoderWorkspaceLinkProfile | "new" | null>(null);
  const operation = useSettingsOperation();
  return (
    <>
      <SettingsSection
        id="workspace-links"
        title="Linked workspaces"
        description="Let agents in one workspace delegate tasks to and work in another while both are connected. Turn on Linked environments in Labs in both workspaces."
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={config.workspaces.length < 2 || operation.pending !== null}
            onClick={() => setEditing("new")}
          >
            <PlusIcon />
            Add link
          </Button>
        }
      >
        {links.length === 0 ? (
          <SettingsResourceEmpty>
            {config.workspaces.length < 2
              ? "Connect two workspaces before linking them."
              : "No workspaces are linked yet."}
          </SettingsResourceEmpty>
        ) : (
          links.map((link) => {
            const from = config.workspaces.find((entry) => entry.id === link.from);
            const to = config.workspaces.find((entry) => entry.id === link.to);
            if (!from || !to) return null;
            return (
              <SettingsResource
                key={link.id}
                title={`${from.name} → ${to.name}`}
                description={`Agents in ${from.name} may work in ${to.name}: ${workspaceLinkAccessConfig[link.access].label}.`}
                actions={
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Actions for the link from ${from.name} to ${to.name}`}
                          disabled={operation.pending !== null}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      }
                    />
                    <MenuPopup align="end">
                      <MenuItem onClick={() => setEditing(link)}>Edit link</MenuItem>
                      <MenuItem
                        onClick={() =>
                          void operation.run(link.id, "Could not remove link", () =>
                            updateConfig((current) => ({
                              ...current,
                              workspaceLinks: (current.workspaceLinks ?? []).filter(
                                (entry) => entry.id !== link.id,
                              ),
                            })),
                          )
                        }
                      >
                        Remove link
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                }
              >
                <SettingsResourceError
                  error={operation.error?.key === link.id ? operation.error : null}
                />
              </SettingsResource>
            );
          })
        )}
      </SettingsSection>
      {editing !== null ? (
        <WorkspaceLinkEditor
          key={editing === "new" ? "new" : editing.id}
          link={editing === "new" ? null : editing}
          existingLinks={links}
          workspaces={config.workspaces}
          updateConfig={updateConfig}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

export function WorkspaceLinkEditor({
  link,
  existingLinks,
  workspaces,
  updateConfig,
  onClose,
}: {
  link: CoderWorkspaceLinkProfile | null;
  existingLinks: readonly CoderWorkspaceLinkProfile[];
  workspaces: readonly CoderWorkspaceProfile[];
  updateConfig: UpdateCoderSettingsConfig;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(link?.from ?? workspaces[0]?.id ?? "");
  const [to, setTo] = useState(link?.to ?? workspaces[1]?.id ?? "");
  const [access, setAccess] = useState<AuthMcpClientAccess>(link?.access ?? "approval-required");
  const operation = useSettingsOperation();
  const fromFieldId = useId();
  const toFieldId = useId();
  const accessFieldId = useId();
  const sameWorkspace = from === to;
  const duplicate = existingLinks.some(
    (candidate) => candidate.from === from && candidate.to === to && candidate.id !== link?.id,
  );
  const known = (id: string) => workspaces.some((workspace) => workspace.id === id);
  return (
    <SettingsResourceDialog
      title={link ? "Edit link" : "Add link"}
      description="Agents in the first workspace may act in the second, never with more access than their own mode. Below full access, they can change only work they started there."
      pending={operation.pending !== null}
      error={operation.error}
      onClose={onClose}
      submitLabel={link ? "Save changes" : "Add link"}
      submitDisabled={!known(from) || !known(to) || sameWorkspace || duplicate}
      onSubmit={(event) => {
        event.preventDefault();
        if (!known(from) || !known(to) || sameWorkspace || duplicate) return;
        void operation
          .run("save", "Could not save link", () =>
            updateConfig((current) => {
              const next: CoderWorkspaceLinkProfile = {
                id: link?.id ?? `workspace-link-${randomUUID()}`,
                from,
                to,
                access,
              };
              const rules = current.workspaceLinks ?? [];
              if (link && !rules.some((entry) => entry.id === link.id))
                throw new Error("This link was removed. Close the editor and add it again.");
              return {
                ...current,
                workspaceLinks: link
                  ? rules.map((entry) => (entry.id === link.id ? next : entry))
                  : [...rules, next],
              };
            }),
          )
          .then((saved) => {
            if (saved) onClose();
          });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField id={fromFieldId} label="Agents in">
          <SettingsSelect
            ariaLabel="Agents in"
            className="w-full min-w-0"
            id={fromFieldId}
            onChange={setFrom}
            value={from}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.workspace}
              </option>
            ))}
          </SettingsSelect>
        </SettingsField>
        <SettingsField id={toFieldId} label="May work in">
          <SettingsSelect
            ariaLabel="May work in"
            className="w-full min-w-0"
            id={toFieldId}
            onChange={setTo}
            value={to}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} · {workspace.workspace}
              </option>
            ))}
          </SettingsSelect>
          {sameWorkspace ? (
            <p className="mt-1.5 text-xs text-destructive-foreground">
              Choose two different workspaces.
            </p>
          ) : duplicate ? (
            <p className="mt-1.5 text-xs text-destructive-foreground">
              These workspaces are already linked this way.
            </p>
          ) : null}
        </SettingsField>
        <SettingsField id={accessFieldId} label="Access">
          <SettingsSelect
            ariaLabel="Access"
            className="w-full min-w-0"
            id={accessFieldId}
            onChange={(value) => setAccess(value as AuthMcpClientAccess)}
            value={access}
          >
            {AuthMcpClientAccess.literals.map((option) => (
              <option key={option} value={option}>
                {workspaceLinkAccessConfig[option].label}
              </option>
            ))}
          </SettingsSelect>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {workspaceLinkAccessConfig[access].description}
          </p>
        </SettingsField>
      </div>
    </SettingsResourceDialog>
  );
}
