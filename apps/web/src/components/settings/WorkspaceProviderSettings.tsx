"use client";

import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ClaudeSettings,
  type CodexSettings,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./SettingsPage";
import {
  PROVIDER_CLIENT_DEFINITIONS,
  getProviderClientDefinition,
  type ProviderClientDefinition,
} from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import {
  deriveProviderInstanceId,
  providerInstanceFallbackLabel,
  validateProviderInstanceId,
} from "./WorkspaceProviderSettings.logic";

const CODEX = "codex" as const;
const CLAUDE = "claudeAgent" as const;

function liveProviderForInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ServerProvider | undefined {
  return providers.find((provider) => provider.instanceId === instanceId);
}

function providerStatusLabel(provider: ServerProvider | undefined): string {
  if (!provider) return "Checking workspace";
  if (provider.status === "ready") return "Ready";
  if (provider.status === "disabled") return "Disabled";
  if (provider.auth.status === "unauthenticated") return "Sign in required";
  if (provider.availability === "unavailable" || !provider.installed) return "Unavailable";
  return provider.status === "warning" ? "Needs attention" : "Error";
}

function WorkspaceProviderCard(props: {
  readonly instanceId: ProviderInstanceId;
  readonly definition: ProviderClientDefinition | undefined;
  readonly instance: ProviderInstanceConfig;
  readonly liveProvider: ServerProvider | undefined;
  readonly isDefault: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
  readonly onDelete?: (() => void) | undefined;
}) {
  const displayName =
    props.instance.displayName ??
    props.definition?.label ??
    providerInstanceFallbackLabel(props.instanceId);
  const Icon = props.definition?.icon;
  const enabled = resolveProviderInstanceEnabled(props.instance);

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? <Icon className="mt-0.5 size-5 shrink-0" aria-hidden /> : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-medium">{displayName}</h3>
              <span className="text-xs text-muted-foreground">
                {providerStatusLabel(props.liveProvider)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {props.isDefault
                ? `Uses the workspace's default ${props.definition?.label ?? props.instance.driver} installation.`
                : `Instance ID: ${props.instanceId}`}
            </p>
            {props.liveProvider?.message ? (
              <p className="mt-1 text-xs text-muted-foreground">{props.liveProvider.message}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.onDelete ? (
            <Button
              aria-label={`Delete ${displayName}`}
              size="icon-sm"
              variant="destructive-outline"
              onClick={props.onDelete}
            >
              <Trash2Icon />
            </Button>
          ) : null}
          <Switch
            aria-label={`Enable ${displayName}`}
            checked={enabled}
            onCheckedChange={(checked) =>
              props.onUpdate({ ...props.instance, enabled: Boolean(checked) })
            }
          />
        </div>
      </div>

      {!props.isDefault ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-foreground">Display name</span>
            <DraftInput
              className="mt-1.5"
              value={props.instance.displayName ?? ""}
              placeholder={providerInstanceFallbackLabel(props.instanceId)}
              onCommit={(value) => {
                const displayName = value.trim();
                const { displayName: _displayName, ...rest } = props.instance;
                props.onUpdate(displayName ? { ...rest, displayName } : rest);
              }}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-foreground">Accent color</span>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                aria-label={`${displayName} accent color`}
                className="h-8 w-11 cursor-pointer rounded-md border border-input bg-background p-0.5"
                type="color"
                value={normalizeProviderAccentColor(props.instance.accentColor) ?? "#2563eb"}
                onChange={(event) =>
                  props.onUpdate({ ...props.instance, accentColor: event.target.value })
                }
              />
              {props.instance.accentColor ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const { accentColor: _accentColor, ...rest } = props.instance;
                    props.onUpdate(rest);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </label>
        </div>
      ) : null}

      {props.definition ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <ProviderSettingsForm
            definition={props.definition}
            value={props.instance.config}
            idPrefix={`provider-${props.instanceId}`}
            variant="card"
            onChange={(config) => {
              const { config: _config, ...rest } = props.instance;
              props.onUpdate(config ? { ...rest, config } : rest);
            }}
          />
        </div>
      ) : (
        <p className="rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          This provider driver is not included in T3 Coder. Its workspace configuration is preserved
          but cannot be edited here.
        </p>
      )}
    </div>
  );
}

function AddWorkspaceProviderDialog(props: {
  readonly open: boolean;
  readonly reservedIds: ReadonlySet<string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => void;
}) {
  const [driver, setDriver] = useState<ProviderDriverKind>(PROVIDER_CLIENT_DEFINITIONS[0]!.value);
  const [displayName, setDisplayName] = useState("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  const [accentColor, setAccentColor] = useState("");
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [attempted, setAttempted] = useState(false);

  const definition = getProviderClientDefinition(driver) ?? PROVIDER_CLIENT_DEFINITIONS[0]!;
  const instanceId = instanceIdOverride ?? deriveProviderInstanceId(driver, displayName);
  const validationError = validateProviderInstanceId(instanceId, props.reservedIds);
  const config = configByDriver[driver];

  const reset = () => {
    setDriver(PROVIDER_CLIENT_DEFINITIONS[0]!.value);
    setDisplayName("");
    setInstanceIdOverride(null);
    setAccentColor("");
    setConfigByDriver({});
    setAttempted(false);
  };

  const setOpen = (open: boolean) => {
    props.onOpenChange(open);
    if (!open) reset();
  };

  const save = () => {
    setAttempted(true);
    if (validationError) return;
    const normalizedAccent = normalizeProviderAccentColor(accentColor);
    const label = displayName.trim();
    props.onAdd(ProviderInstanceId.make(instanceId.trim()), {
      driver,
      enabled: true,
      ...(label ? { displayName: label } : {}),
      ...(normalizedAccent ? { accentColor: normalizedAccent } : {}),
      ...(config && Object.keys(config).length > 0 ? { config } : {}),
    });
    setOpen(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add provider instance</DialogTitle>
          <DialogDescription>
            Add another workspace Codex or Claude identity, installation, or configuration.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium">
            Provider
            <select
              className="h-8 rounded-md border border-input bg-background px-2.5 text-sm"
              value={driver}
              onChange={(event) => {
                setDriver(event.target.value as ProviderDriverKind);
                setInstanceIdOverride(null);
              }}
            >
              {PROVIDER_CLIENT_DEFINITIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Display name
            <Input
              className="bg-background"
              placeholder="e.g. Work"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Instance ID
            <Input
              aria-invalid={attempted && validationError !== null}
              className="bg-background"
              placeholder={`${driver}_work`}
              value={instanceId}
              onChange={(event) => setInstanceIdOverride(event.target.value)}
            />
            <span
              className={
                attempted && validationError ? "text-destructive" : "text-muted-foreground"
              }
            >
              {attempted && validationError
                ? validationError
                : "Stable routing key used by threads and provider sessions."}
            </span>
          </label>
          <label className="grid gap-1.5 text-xs font-medium">
            Accent color
            <div className="flex items-center gap-2">
              <input
                aria-label="Provider instance accent color"
                className="h-8 w-11 cursor-pointer rounded-md border border-input bg-background p-0.5"
                type="color"
                value={normalizeProviderAccentColor(accentColor) ?? "#2563eb"}
                onChange={(event) => setAccentColor(event.target.value)}
              />
              <span className="font-normal text-muted-foreground">Optional picker marker</span>
            </div>
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <ProviderSettingsForm
              definition={definition}
              value={config}
              idPrefix={`add-provider-${driver}`}
              variant="dialog"
              onChange={(next) =>
                setConfigByDriver((current) => {
                  const updated = { ...current };
                  if (next && Object.keys(next).length > 0) updated[driver] = next;
                  else delete updated[driver];
                  return updated;
                })
              }
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Add instance</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function WorkspaceProviderSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [addOpen, setAddOpen] = useState(false);

  const reservedIds = useMemo(
    () =>
      new Set([
        ...Object.keys(settings.providerInstances),
        ...PROVIDER_CLIENT_DEFINITIONS.map((definition) => definition.value),
      ]),
    [settings.providerInstances],
  );

  const updateInstance = (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
    updateSettings({
      providerInstances: { ...settings.providerInstances, [instanceId]: instance },
    });
  };

  const deleteInstance = async (instanceId: ProviderInstanceId, displayName: string) => {
    const confirmed = await readLocalApi()?.dialogs.confirm(`Delete ${displayName}?`, {
      variant: "destructive",
    });
    if (!confirmed) return;
    const next = { ...settings.providerInstances };
    delete next[instanceId];
    updateSettings({ providerInstances: next });
  };

  return (
    <>
      <SettingsSection
        title="Providers"
        description="Codex and Claude run in this Coder workspace and use its installations, login, and policy."
      >
        {PROVIDER_CLIENT_DEFINITIONS.map((definition) => {
          const instanceId = defaultInstanceIdForDriver(definition.value);
          const explicit = settings.providerInstances[instanceId];
          if (explicit) {
            return (
              <WorkspaceProviderCard
                key={instanceId}
                instanceId={instanceId}
                definition={getProviderClientDefinition(explicit.driver)}
                instance={explicit}
                liveProvider={liveProviderForInstance(providers, instanceId)}
                isDefault
                onUpdate={(next) => updateInstance(instanceId, next)}
              />
            );
          }

          const legacyConfig =
            definition.value === CODEX ? settings.providers.codex : settings.providers.claudeAgent;
          const instance: ProviderInstanceConfig = {
            driver: definition.value,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          };
          return (
            <WorkspaceProviderCard
              key={instanceId}
              instanceId={instanceId}
              definition={definition}
              instance={instance}
              liveProvider={liveProviderForInstance(providers, instanceId)}
              isDefault
              onUpdate={(next) => {
                const config = {
                  ...(next.config as Record<string, unknown>),
                  enabled: next.enabled,
                };
                if (definition.value === CODEX) {
                  updateSettings({ providers: { codex: config as CodexSettings } });
                } else if (definition.value === CLAUDE) {
                  updateSettings({ providers: { claudeAgent: config as ClaudeSettings } });
                }
              }}
            />
          );
        })}

        {Object.entries(settings.providerInstances)
          .filter(
            ([instanceId]) =>
              !PROVIDER_CLIENT_DEFINITIONS.some((definition) => definition.value === instanceId),
          )
          .map(([rawInstanceId, instance]) => {
            const instanceId = ProviderInstanceId.make(rawInstanceId);
            const displayName = instance.displayName ?? providerInstanceFallbackLabel(instanceId);
            return (
              <WorkspaceProviderCard
                key={instanceId}
                instanceId={instanceId}
                definition={getProviderClientDefinition(instance.driver)}
                instance={instance}
                liveProvider={liveProviderForInstance(providers, instanceId)}
                isDefault={false}
                onUpdate={(next) => updateInstance(instanceId, next)}
                onDelete={() => void deleteInstance(instanceId, displayName)}
              />
            );
          })}

        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div>
            <h3 className="text-sm font-medium">Additional instances</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Use another workspace installation or provider home without changing the defaults.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <PlusIcon />
            Add instance
          </Button>
        </div>
      </SettingsSection>

      <AddWorkspaceProviderDialog
        open={addOpen}
        reservedIds={reservedIds}
        onOpenChange={setAddOpen}
        onAdd={updateInstance}
      />
    </>
  );
}
