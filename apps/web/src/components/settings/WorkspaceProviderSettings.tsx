"use client";

import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ClaudeSettings,
  type CodexSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import type { EnvironmentPresentation } from "../../state/environments";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsSection } from "./SettingsPage";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { ProviderSettingsForm, readProviderConfigString } from "./ProviderSettingsForm";
import { PROVIDER_CLIENT_DEFINITIONS, type ProviderClientDefinition } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import {
  getProviderSummary,
  getProviderVersionLabel,
  PROVIDER_STATUS_STYLES,
  type ProviderStatusKey,
} from "./providerStatus";
import { shouldResetTextGenerationSelectionOnDisable } from "./WorkspaceProviderSettings.logic";
import { WorkspaceSettingsTarget } from "./WorkspaceSettingsTarget";
import { ProviderUsageLimits } from "./ProviderUsageLimits";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_USER_SETTING_KEYS = ["autoCompactWindow"] as const;

interface WorkspaceProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly definition: ProviderClientDefinition;
  readonly instance: ProviderInstanceConfig;
  readonly explicit: boolean;
  readonly liveProvider: ServerProvider | undefined;
}

function withConfigValue(
  instance: ProviderInstanceConfig,
  key: string,
  value: unknown,
): ProviderInstanceConfig {
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? { ...(instance.config as Record<string, unknown>) }
      : {};
  config[key] = value;
  const { config: _config, ...rest } = instance;
  return { ...rest, config };
}

function providerPresentation(row: WorkspaceProviderRow) {
  const enabled = resolveProviderInstanceEnabled(row.instance);
  const statusKey: ProviderStatusKey = enabled
    ? ((row.liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
    : "disabled";
  const summary = enabled
    ? getProviderSummary(row.liveProvider)
    : {
        headline: "Disabled",
        detail: "This provider is disabled for new sessions in T3 Coder.",
      };
  return {
    enabled,
    statusKey,
    summary,
    versionLabel: getProviderVersionLabel(row.liveProvider?.version),
  };
}

export function WorkspaceProviderListRow(props: {
  readonly row: WorkspaceProviderRow;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onEnabledChange: (enabled: boolean) => void;
}) {
  const { enabled, statusKey, summary, versionLabel } = providerPresentation(props.row);
  const Icon = props.row.definition.icon;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const statusDot = needsAttention ? (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_STATUS_STYLES[statusKey].dot)}
      aria-hidden
    />
  ) : null;

  return (
    <div
      className={cn(
        "group flex h-19 items-start gap-3 rounded-md px-3 py-2 transition-colors",
        props.selected ? "bg-foreground/8" : "hover:bg-foreground/4",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-sm text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
          !enabled && !props.selected && "opacity-60 group-hover:opacity-100",
        )}
        onClick={props.onSelect}
        aria-pressed={props.selected}
      >
        <span className="inline-flex size-5 shrink-0 items-center justify-center">
          <Icon className="size-4 text-foreground/80" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {props.row.definition.label}
            </span>
            {versionLabel ? (
              <code className="text-xs text-muted-foreground">{versionLabel}</code>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
            {statusDot ? <span className="flex h-[1.45em] items-center">{statusDot}</span> : null}
            <span className="line-clamp-2 [overflow-wrap:anywhere]">
              {summary.headline}
              {needsAttention && summary.detail ? ` · ${summary.detail}` : null}
            </span>
          </span>
        </span>
      </button>
      <span className="flex h-5 shrink-0 items-center">
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => props.onEnabledChange(Boolean(checked))}
          aria-label={`Enable ${props.row.definition.label}`}
        />
      </span>
    </div>
  );
}

export function WorkspaceProviderEditor(props: {
  readonly row: WorkspaceProviderRow;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
}) {
  const hasConfiguration = props.row.definition.value === CLAUDE;
  const [activeTab, setActiveTab] = useState<"configuration" | "models">(
    hasConfiguration ? "configuration" : "models",
  );
  const { statusKey, summary, versionLabel } = providerPresentation(props.row);
  const Icon = props.row.definition.icon;
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const models = props.row.liveProvider?.models.filter((model) => !model.isCustom) ?? [];
  const autoCompactWindow = readProviderConfigString(
    props.row.instance.config,
    "autoCompactWindow",
  );

  return (
    <div className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div className="flex min-h-16 shrink-0 items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex size-5 shrink-0 items-center justify-center">
              <Icon className="size-4 text-foreground/80" aria-hidden />
            </span>
            <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
              {props.row.definition.label}
            </h3>
            {versionLabel ? (
              <code className="text-xs text-muted-foreground">{versionLabel}</code>
            ) : null}
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
            {needsAttention ? (
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  PROVIDER_STATUS_STYLES[statusKey].dot,
                )}
                aria-hidden
              />
            ) : null}
            <span>{summary.headline}</span>
            {summary.detail && !needsAttention ? <span>· {summary.detail}</span> : null}
          </p>
          {summary.detail && needsAttention ? (
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80 [overflow-wrap:anywhere]">
              {summary.detail}
            </p>
          ) : null}
        </div>
      </div>

      {resolveProviderInstanceEnabled(props.row.instance) ? (
        <ProviderUsageLimits limits={props.row.liveProvider?.usageLimits} />
      ) : null}
      {hasConfiguration ? (
        <div className="flex h-11 shrink-0 border-b border-border/70 px-1">
          <button
            type="button"
            aria-pressed={activeTab === "configuration"}
            className={providerSettingsTabClassName(activeTab === "configuration")}
            onClick={() => setActiveTab("configuration")}
          >
            Configuration
          </button>
          <button
            type="button"
            aria-pressed={activeTab === "models"}
            className={providerSettingsTabClassName(activeTab === "models")}
            onClick={() => setActiveTab("models")}
          >
            Models
          </button>
        </div>
      ) : null}

      <div className="lg:min-h-0 lg:flex-1">
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="lg:h-full"
          hidden={!hasConfiguration || activeTab !== "configuration"}
        >
          <div className="space-y-5 px-4 py-5">
            <ProviderSettingsForm
              definition={props.row.definition}
              value={props.row.instance.config}
              idPrefix={`provider-instance-${props.row.instanceId}`}
              variant="card"
              fieldKeys={CLAUDE_USER_SETTING_KEYS}
              {...(autoCompactWindow
                ? {
                    fieldActions: {
                      autoCompactWindow: (
                        <SettingResetButton
                          label="auto-compact window"
                          onClick={() =>
                            props.onUpdate(
                              withConfigValue(props.row.instance, "autoCompactWindow", ""),
                            )
                          }
                        />
                      ),
                    },
                  }
                : {})}
              onChange={(config) => {
                const { config: _config, ...rest } = props.row.instance;
                props.onUpdate({
                  ...rest,
                  config: {
                    ...config,
                    autoCompactWindow: readProviderConfigString(config, "autoCompactWindow"),
                  },
                });
              }}
            />
          </div>
        </ScrollArea>
        <div className="px-4 py-5 lg:h-full lg:min-h-0" hidden={activeTab !== "models"}>
          <ProviderModelsSection
            instanceId={props.row.instanceId}
            models={models}
            hiddenModels={props.hiddenModels}
            favoriteModels={props.favoriteModels}
            modelOrder={props.modelOrder}
            onHiddenModelsChange={props.onHiddenModelsChange}
            onFavoriteModelsChange={props.onFavoriteModelsChange}
            onModelOrderChange={props.onModelOrderChange}
          />
        </div>
      </div>
    </div>
  );
}

function withoutProviderKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  instanceId: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[instanceId];
  return next;
}

function WorkspaceProviderSettingsForEnvironment(props: {
  readonly environment: EnvironmentPresentation;
}) {
  const environmentId = props.environment.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers = props.environment.serverConfig?.providers ?? [];
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId>(
    defaultInstanceIdForDriver(CODEX),
  );
  const selectedTextGenerationInstanceId = resolveAppModelSelectionState(
    settings,
    providers,
  ).instanceId;

  const rows: WorkspaceProviderRow[] = PROVIDER_CLIENT_DEFINITIONS.map((definition) => {
    const driver = definition.value;
    const instanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances[instanceId];
    const legacyConfig =
      driver === CODEX ? settings.providers.codex : settings.providers.claudeAgent;
    const { enabled, ...config } = legacyConfig;
    return {
      instanceId,
      definition,
      instance: explicitInstance ?? { driver, enabled, config },
      explicit: explicitInstance !== undefined,
      liveProvider: providers.find((provider) => provider.instanceId === instanceId),
    };
  });
  const selectedRow = rows.find((row) => row.instanceId === selectedInstanceId) ?? rows[0] ?? null;

  const updateProvider = (row: WorkspaceProviderRow, next: ProviderInstanceConfig) => {
    const shouldResetTextGeneration = shouldResetTextGenerationSelectionOnDisable({
      instanceId: row.instanceId,
      selectedInstanceId: selectedTextGenerationInstanceId,
      wasEnabled: resolveProviderInstanceEnabled(row.instance),
      nextEnabled: next.enabled,
    });
    const textGenerationPatch = shouldResetTextGeneration
      ? {
          textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
        }
      : {};

    if (row.explicit) {
      updateSettings({
        providerInstances: {
          ...settings.providerInstances,
          [row.instanceId]: next,
        },
        ...textGenerationPatch,
      });
      return;
    }

    const nextLegacyConfig = {
      ...(next.config as Record<string, unknown>),
      enabled: next.enabled,
    };
    if (row.definition.value === CODEX) {
      updateSettings({
        providers: { codex: nextLegacyConfig as CodexSettings },
        ...textGenerationPatch,
      });
    } else if (row.definition.value === CLAUDE) {
      updateSettings({
        providers: { claudeAgent: nextLegacyConfig as ClaudeSettings },
        ...textGenerationPatch,
      });
    }
  };

  const updateModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : { ...rest, [instanceId]: { hiddenModels, modelOrder } },
    });
  };

  const updateFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextModels: ReadonlyArray<string>,
  ) => {
    const models = [...new Set(nextModels.map((model) => model.trim()).filter(Boolean))];
    updateSettings({
      favorites: [
        ...(settings.favorites ?? []).filter((favorite) => favorite.provider !== instanceId),
        ...models.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  return (
    <div className="space-y-1">
      <div className="mx-3 overflow-hidden rounded-lg border border-border/70 sm:mx-4 lg:grid lg:h-[min(38rem,calc(100dvh-16rem))] lg:min-h-[30rem] lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="border-b border-border/70 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-b-0">
          <ScrollArea scrollFade chainVerticalScroll className="lg:min-h-0 lg:flex-1">
            <div className="divide-y divide-border/60">
              {rows.map((row) => (
                <div key={row.instanceId} className="p-1">
                  <WorkspaceProviderListRow
                    row={row}
                    selected={selectedRow?.instanceId === row.instanceId}
                    onSelect={() => setSelectedInstanceId(row.instanceId)}
                    onEnabledChange={(enabled) => updateProvider(row, { ...row.instance, enabled })}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        <div className="min-w-0 lg:min-h-0">
          {selectedRow ? (
            <WorkspaceProviderEditor
              key={selectedRow.instanceId}
              row={selectedRow}
              hiddenModels={
                settings.providerModelPreferences?.[selectedRow.instanceId]?.hiddenModels ?? []
              }
              favoriteModels={(settings.favorites ?? [])
                .filter((favorite) => favorite.provider === selectedRow.instanceId)
                .map((favorite) => favorite.model)}
              modelOrder={
                settings.providerModelPreferences?.[selectedRow.instanceId]?.modelOrder ?? []
              }
              onUpdate={(next) => updateProvider(selectedRow, next)}
              onHiddenModelsChange={(hiddenModels) =>
                updateModelPreferences(selectedRow.instanceId, {
                  hiddenModels,
                  modelOrder:
                    settings.providerModelPreferences?.[selectedRow.instanceId]?.modelOrder ?? [],
                })
              }
              onFavoriteModelsChange={(models) =>
                updateFavoriteModels(selectedRow.instanceId, models)
              }
              onModelOrderChange={(modelOrder) =>
                updateModelPreferences(selectedRow.instanceId, {
                  hiddenModels:
                    settings.providerModelPreferences?.[selectedRow.instanceId]?.hiddenModels ?? [],
                  modelOrder,
                })
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceProviderSettings() {
  return (
    <SettingsSection title="Providers" unframed>
      <WorkspaceSettingsTarget ariaLabel="Provider settings workspace">
        {(environment) => (
          <WorkspaceProviderSettingsForEnvironment
            key={environment.environmentId}
            environment={environment}
          />
        )}
      </WorkspaceSettingsTarget>
    </SettingsSection>
  );
}
