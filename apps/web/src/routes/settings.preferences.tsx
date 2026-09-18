import { BackgroundActivitySettings } from "../components/settings/BackgroundActivitySettings";
import { ENVIRONMENT_MACHINE_KINDS, type EnvironmentMachineKind } from "@t3tools/contracts";
import {
  EnvironmentMachineIcon,
  ENVIRONMENT_MACHINE_KIND_LABELS,
} from "../components/EnvironmentMachineIcon";
import { NotificationSettings } from "../components/settings/NotificationSettings";
import { DraftInput } from "../components/ui/draft-input";
import { ProjectActionsSettings } from "../components/settings/ProjectActionsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { useT3ProjectFile } from "../hooks/useT3ProjectFile";
import { ProjectDefaultModelSetting } from "../components/settings/ProjectDefaultSettings";
import { ScopedSwitch } from "../components/settings/ScopedSwitch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { ResponseSettings } from "../components/settings/ResponseSettings";
import { RestoreWorkspaceSettings } from "../components/settings/RestoreSettings";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type DiffLayout,
  type SidebarProjectGroupingMode,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  type TimestampFormat,
} from "@t3tools/contracts/settings";
import { useEffect, useRef, useState } from "react";
import {
  isProjectGroupingEnabled,
  projectGroupingModeFromToggle,
  readLastEnabledProjectGroupingMode,
  rememberEnabledProjectGroupingMode,
} from "../components/settings/projectGroupingSettings";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingResetButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../components/settings/SettingsPage";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { TextGenerationModelSettings } from "../components/settings/TextGenerationModelSettings";
import type { EnvironmentPresentation } from "../state/environments";
import { ScopedSettingsTarget } from "../components/settings/ScopedSettingsTarget";

const TIMESTAMP_FORMAT_LABELS: Record<TimestampFormat, string> = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
};

const DIFF_LAYOUT_LABELS: Record<DiffLayout, string> = {
  stacked: "Stacked",
  split: "Split",
};

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Days of inactivity before auto-settle"
    />
  );
}

function WorkspaceGeneralSettings(props: { readonly environment: EnvironmentPresentation }) {
  const environmentId = props.environment.environmentId;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providers = props.environment.serverConfig?.providers ?? [];
  const { target, targets } = useSettingsScope();
  const repository = useT3ProjectFile(targets.length === 1 ? target : null);
  const repositoryDefault = repository.file?.defaultThreadEnvMode;
  const mixedCheckoutMode = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const checkoutMode =
    target?.sources.defaultThreadEnvMode === "project"
      ? settings.defaultThreadEnvMode
      : (repositoryDefault ?? settings.defaultThreadEnvMode);

  return (
    <>
      <SettingsSection title="Workspace identity">
        <SettingsRow
          title="Workspace icon"
          id="environment-icon"
          settingKeys={["environmentIcon"]}
          control={
            <Select
              value={settings.environmentIcon ?? "server"}
              onValueChange={(value) => {
                if (value && ENVIRONMENT_MACHINE_KINDS.includes(value as EnvironmentMachineKind))
                  updateSettings({ environmentIcon: value as EnvironmentMachineKind });
              }}
            >
              <SelectTrigger aria-label="Workspace icon">
                <EnvironmentMachineIcon
                  className="size-4"
                  kind={settings.environmentIcon ?? "server"}
                />
                <SelectValue>
                  {ENVIRONMENT_MACHINE_KIND_LABELS[settings.environmentIcon ?? "server"]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ENVIRONMENT_MACHINE_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ENVIRONMENT_MACHINE_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <BackgroundActivitySettings />
      <SettingsSection title="Recovery">
        <SettingsRow
          id="continue-threads-after-server-update"
          title="Continue threads after restarts"
          settingKeys={["continueThreadsAfterServerUpdate"]}
          description="Resume interrupted work when the workspace helper starts again after a crash or restart."
          control={
            <Switch
              aria-label="Continue threads after restarts"
              checked={settings.continueThreadsAfterServerUpdate}
              onCheckedChange={(continueThreadsAfterServerUpdate) =>
                updateSettings({ continueThreadsAfterServerUpdate })
              }
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Projects">
        <SettingsRow
          id="add-project-starts-in"
          title="Add project starts in"
          settingKeys={["addProjectBaseDirectory"]}
          description="Starting folder for Add Project in the selected workspace. Leave empty to use the workspace home."
          control={
            <DraftInput
              aria-label="Add project starts in"
              value={settings.addProjectBaseDirectory}
              onCommit={(addProjectBaseDirectory) => updateSettings({ addProjectBaseDirectory })}
              placeholder="~/"
            />
          }
        />
      </SettingsSection>

      <RestoreWorkspaceSettings environmentId={environmentId} settings={settings} />
      <TextGenerationModelSettings
        environmentId={environmentId}
        settings={settings}
        providers={providers}
        onChange={(textGenerationModelSelection) =>
          updateSettings({ textGenerationModelSelection })
        }
      />

      <SettingsSection
        title="New threads"
        description="Choose how new work starts inside the selected Coder workspace."
      >
        <ProjectDefaultModelSetting />
        <ResponseSettings settings={settings} onChange={updateSettings} />
        <SettingsRow
          id="default-checkout-mode"
          settingKeys={["defaultThreadEnvMode"]}
          title="Default checkout mode"
          description={
            repositoryDefault
              ? `Repository default: ${repositoryDefault === "worktree" ? "Worktree" : "Local"} (t3.json)`
              : "Work in the project checkout or create a dedicated Git worktree."
          }
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label="default checkout mode"
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={mixedCheckoutMode ? null : checkoutMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Default checkout mode"
              >
                <SelectValue>
                  {mixedCheckoutMode
                    ? "Mixed"
                    : { local: "Project checkout", worktree: "New worktree" }[checkoutMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  Project checkout
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  New worktree
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="worktrees-from-origin"
          settingKeys={["newWorktreesStartFromOrigin"]}
          title="Start worktrees from origin"
          description="Creates the worktree from the latest matching branch on origin instead of your local branch."
          resetAction={
            settings.newWorktreesStartFromOrigin !==
            DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin ? (
              <SettingResetButton
                label="new worktrees start from origin"
                onClick={() =>
                  updateSettings({
                    newWorktreesStartFromOrigin:
                      DEFAULT_SERVER_SETTINGS.newWorktreesStartFromOrigin,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["newWorktreesStartFromOrigin"]}
              checked={settings.newWorktreesStartFromOrigin}
              onCheckedChange={(checked) =>
                updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
              }
              aria-label="Start new worktrees from origin by default"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Thread settlement"
        description="Choose when this workspace moves inactive or merged threads into the settled shelf."
      >
        <SettingsRow
          id="auto-settle-inactive-threads"
          settingKeys={["sidebarAutoSettleAfterDays"]}
          title="Auto-settle inactive threads"
          description="Sidebar threads with no activity for this long settle automatically."
          resetAction={
            settings.sidebarAutoSettleAfterDays !==
            DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ? (
              <SettingResetButton
                label="auto-settle"
                onClick={() =>
                  updateSettings({
                    sidebarAutoSettleAfterDays: DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["sidebarAutoSettleAfterDays"]}
              checked={settings.sidebarAutoSettleAfterDays !== null}
              onCheckedChange={(checked) =>
                updateSettings({
                  sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                })
              }
              aria-label="Auto-settle inactive threads"
            />
          }
        />
        {settings.sidebarAutoSettleAfterDays !== null ? (
          <SettingsRow
            id="days-before-auto-settle"
            settingKeys={["sidebarAutoSettleAfterDays"]}
            title="Days before auto-settle"
            description="Any new activity un-settles a thread automatically."
            control={
              <AutoSettleDaysInput
                value={settings.sidebarAutoSettleAfterDays}
                onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
              />
            }
          />
        ) : null}
        <SettingsRow
          id="auto-settle-merged-threads"
          settingKeys={["sidebarAutoSettleOnMerge"]}
          title="Auto-settle merged threads"
          description="Settle a thread when its merge request merges. Closed merge requests still settle automatically."
          resetAction={
            settings.sidebarAutoSettleOnMerge !==
            DEFAULT_SERVER_SETTINGS.sidebarAutoSettleOnMerge ? (
              <SettingResetButton
                label="auto-settle on merge"
                onClick={() =>
                  updateSettings({
                    sidebarAutoSettleOnMerge: DEFAULT_SERVER_SETTINGS.sidebarAutoSettleOnMerge,
                  })
                }
              />
            ) : null
          }
          control={
            <ScopedSwitch
              settingKeys={["sidebarAutoSettleOnMerge"]}
              checked={settings.sidebarAutoSettleOnMerge}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
              }
              aria-label="Auto-settle merged threads"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

function GeneralSettingsView() {
  const { scope } = useSettingsScope();
  const lastEnabledProjectGroupingMode = useRef<SidebarProjectGroupingMode>(
    readLastEnabledProjectGroupingMode(),
  );
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPage>
      <ScopedSettingsTarget>
        {(environment) => (
          <WorkspaceGeneralSettings key={environment.environmentId} environment={environment} />
        )}
      </ScopedSettingsTarget>
      {scope.kind === "all" || scope.kind === "environment" ? <ProjectActionsSettings /> : null}
      <SettingsSection title="Composer">
        <SettingsRow
          id="plan-mode"
          title="Plan mode"
          description="Restore Build/Plan, /plan, /default, and Shift+Tab. Off uses build mode."
          control={
            <Switch
              aria-label="Plan mode"
              checked={settings.planModeEnabled}
              onCheckedChange={(planModeEnabled) => updateSettings({ planModeEnabled })}
            />
          }
        />
        <SettingsRow
          id="context-window-indicator"
          title="Context window indicator"
          description="Show context window usage in the composer."
          control={
            <Switch
              aria-label="Context window indicator"
              checked={settings.contextWindowMeterEnabled}
              onCheckedChange={(contextWindowMeterEnabled) =>
                updateSettings({ contextWindowMeterEnabled })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        id="notifications"
        title="Notifications"
        description="Alerts stay in this browser while T3 Coder is open."
      >
        <SettingsRow
          title="Thread alerts"
          description="Show alerts for completed threads and requests for input. Badge the browser tab while it is in the background."
          control={
            <Switch
              checked={settings.inAppNotificationsEnabled}
              onCheckedChange={(checked) => updateSettings({ inAppNotificationsEnabled: checked })}
            />
          }
        />
        <NotificationSettings />
      </SettingsSection>
      <SettingsSection title="Sidebar" description="Control project grouping and thread ordering.">
        <SettingsRow
          id="project-grouping"
          title="Group projects"
          description="Combine matching repositories across environments."
          resetAction={
            settings.sidebarProjectGroupingMode !==
            DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode ? (
              <SettingResetButton
                label="project grouping"
                onClick={() =>
                  updateSettings({
                    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={isProjectGroupingEnabled(settings.sidebarProjectGroupingMode)}
              onCheckedChange={(checked) => {
                if (!checked && settings.sidebarProjectGroupingMode !== "separate") {
                  lastEnabledProjectGroupingMode.current = settings.sidebarProjectGroupingMode;
                  rememberEnabledProjectGroupingMode(settings.sidebarProjectGroupingMode);
                }
                updateSettings({
                  sidebarProjectGroupingMode: projectGroupingModeFromToggle(
                    checked,
                    lastEnabledProjectGroupingMode.current,
                  ),
                });
              }}
              aria-label="Project grouping"
            />
          }
        />

        <SettingsRow
          id="project-order"
          title="Project order"
          resetAction={
            settings.sidebarProjectSortOrder !== DEFAULT_CLIENT_SETTINGS.sidebarProjectSortOrder ? (
              <SettingResetButton
                label="project order"
                onClick={() =>
                  updateSettings({
                    sidebarProjectSortOrder: DEFAULT_CLIENT_SETTINGS.sidebarProjectSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarProjectSortOrder}
              onValueChange={(value) => {
                if (value === "updated_at" || value === "created_at" || value === "manual") {
                  updateSettings({
                    sidebarProjectSortOrder: value satisfies SidebarProjectSortOrder,
                  });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Project order">
                <SelectValue>
                  {
                    {
                      updated_at: "Recently active",
                      created_at: "Recently added",
                      manual: "Manual",
                    }[settings.sidebarProjectSortOrder]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="updated_at">
                  Recently active
                </SelectItem>
                <SelectItem hideIndicator value="created_at">
                  Recently added
                </SelectItem>
                <SelectItem hideIndicator value="manual">
                  Manual
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="thread-order"
          title="Thread order"
          resetAction={
            settings.sidebarThreadSortOrder !== DEFAULT_CLIENT_SETTINGS.sidebarThreadSortOrder ? (
              <SettingResetButton
                label="thread order"
                onClick={() =>
                  updateSettings({
                    sidebarThreadSortOrder: DEFAULT_CLIENT_SETTINGS.sidebarThreadSortOrder,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarThreadSortOrder}
              onValueChange={(value) => {
                if (value === "updated_at" || value === "created_at") {
                  updateSettings({
                    sidebarThreadSortOrder: value satisfies SidebarThreadSortOrder,
                  });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Thread order">
                <SelectValue>
                  {
                    { updated_at: "Recently active", created_at: "Recently created" }[
                      settings.sidebarThreadSortOrder
                    ]
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="updated_at">
                  Recently active
                </SelectItem>
                <SelectItem hideIndicator value="created_at">
                  Recently created
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="visible-threads-per-project"
          title="Visible threads per project"
          description={`Show between ${MIN_SIDEBAR_THREAD_PREVIEW_COUNT} and ${MAX_SIDEBAR_THREAD_PREVIEW_COUNT} threads before expanding a project.`}
          resetAction={
            settings.sidebarThreadPreviewCount !==
            DEFAULT_CLIENT_SETTINGS.sidebarThreadPreviewCount ? (
              <SettingResetButton
                label="visible threads per project"
                onClick={() =>
                  updateSettings({
                    sidebarThreadPreviewCount: DEFAULT_CLIENT_SETTINGS.sidebarThreadPreviewCount,
                  })
                }
              />
            ) : null
          }
          control={
            <Input
              aria-label="Visible threads per project"
              className="w-24"
              inputMode="numeric"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              type="number"
              value={String(settings.sidebarThreadPreviewCount)}
              onValueChange={(value) => {
                const count = Number(value);
                if (
                  Number.isInteger(count) &&
                  count >= MIN_SIDEBAR_THREAD_PREVIEW_COUNT &&
                  count <= MAX_SIDEBAR_THREAD_PREVIEW_COUNT
                ) {
                  updateSettings({ sidebarThreadPreviewCount: count });
                }
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Editor and history">
        <SettingsRow
          id="proactive-panels"
          title="Proactive panels"
          description="Automatically open linked merge requests and completed-turn diffs when entering or working in a thread."
          resetAction={
            settings.proactivePanelsEnabled !== DEFAULT_CLIENT_SETTINGS.proactivePanelsEnabled ? (
              <SettingResetButton
                label="proactive panels"
                onClick={() =>
                  updateSettings({
                    proactivePanelsEnabled: DEFAULT_CLIENT_SETTINGS.proactivePanelsEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.proactivePanelsEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ proactivePanelsEnabled: Boolean(checked) })
              }
              aria-label="Proactive panels"
            />
          }
        />
        <SettingsRow
          id="skills-in-slash-menu"
          title="Skills in slash menu"
          description="Also include skills in the / command menu. Skills always appear when you type $."
          resetAction={
            settings.showSkillsInSlashMenu !== DEFAULT_CLIENT_SETTINGS.showSkillsInSlashMenu ? (
              <SettingResetButton
                label="skills in slash menu"
                onClick={() =>
                  updateSettings({
                    showSkillsInSlashMenu: DEFAULT_CLIENT_SETTINGS.showSkillsInSlashMenu,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSkillsInSlashMenu}
              onCheckedChange={(checked) =>
                updateSettings({ showSkillsInSlashMenu: Boolean(checked) })
              }
              aria-label="Show skills in slash menu"
            />
          }
        />
        <SettingsRow
          id="composer-rich-text"
          title="Rich text composer"
          description="Show formatted Markdown as you type."
          resetAction={
            settings.composerRichTextEnabled !== DEFAULT_CLIENT_SETTINGS.composerRichTextEnabled ? (
              <SettingResetButton
                label="rich text composer"
                onClick={() =>
                  updateSettings({
                    composerRichTextEnabled: DEFAULT_CLIENT_SETTINGS.composerRichTextEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerRichTextEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ composerRichTextEnabled: Boolean(checked) })
              }
              aria-label="Rich text composer"
            />
          }
        />

        <SettingsRow
          id="follow-up-behavior"
          title="Follow-up behavior"
          description="Queue follow-ups while the agent runs or steer the current run."
          resetAction={
            settings.followUpBehavior !== DEFAULT_CLIENT_SETTINGS.followUpBehavior ? (
              <SettingResetButton
                label="follow-up behavior"
                onClick={() =>
                  updateSettings({
                    followUpBehavior: DEFAULT_CLIENT_SETTINGS.followUpBehavior,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.followUpBehavior}
              onValueChange={(value) => {
                if (value === "queue" || value === "steer") {
                  updateSettings({ followUpBehavior: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-0" aria-label="Follow-up behavior">
                <SelectValue>
                  {settings.followUpBehavior === "queue" ? "Queue" : "Steer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="queue">Queue</SelectItem>
                <SelectItem value="steer">Steer</SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          id="composer-collapse-on-scroll"
          title="Collapse composer when scrolling"
          description="Rest the composer of an existing thread into a single line when you scroll the conversation. Focus the composer or start typing to expand it again."
          resetAction={
            settings.composerCollapseOnScroll !==
            DEFAULT_CLIENT_SETTINGS.composerCollapseOnScroll ? (
              <SettingResetButton
                label="collapse composer on scroll"
                onClick={() =>
                  updateSettings({
                    composerCollapseOnScroll: DEFAULT_CLIENT_SETTINGS.composerCollapseOnScroll,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.composerCollapseOnScroll}
              onCheckedChange={(checked) =>
                updateSettings({ composerCollapseOnScroll: Boolean(checked) })
              }
              aria-label="Collapse composer on scroll"
            />
          }
        />
        <SettingsRow
          id="time-format"
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_CLIENT_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="default-diff-file-state"
          title="Default diff file state"
          description="Start with files expanded or collapsed when opening diffs or a merge request's Code tab."
          resetAction={
            settings.diffFilesCollapsed !== DEFAULT_CLIENT_SETTINGS.diffFilesCollapsed ? (
              <SettingResetButton
                label="default diff file state"
                onClick={() =>
                  updateSettings({
                    diffFilesCollapsed: DEFAULT_CLIENT_SETTINGS.diffFilesCollapsed,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffFilesCollapsed ? "collapsed" : "expanded"}
              onValueChange={(value) => {
                if (value === "expanded" || value === "collapsed") {
                  updateSettings({ diffFilesCollapsed: value === "collapsed" });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Default diff file state"
              >
                <SelectValue>{settings.diffFilesCollapsed ? "Collapsed" : "Expanded"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="expanded">
                  Expanded
                </SelectItem>
                <SelectItem hideIndicator value="collapsed">
                  Collapsed
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="diff-layout"
          title="Diff layout"
          description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
          resetAction={
            settings.diffLayout !== DEFAULT_CLIENT_SETTINGS.diffLayout ? (
              <SettingResetButton
                label="diff layout"
                onClick={() => updateSettings({ diffLayout: DEFAULT_CLIENT_SETTINGS.diffLayout })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.diffLayout}
              onValueChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffLayout: value });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Diff layout">
                <SelectValue>{DIFF_LAYOUT_LABELS[settings.diffLayout]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="stacked">
                  {DIFF_LAYOUT_LABELS.stacked}
                </SelectItem>
                <SelectItem hideIndicator value="split">
                  {DIFF_LAYOUT_LABELS.split}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="wrap-long-lines"
          title="Wrap long lines"
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_CLIENT_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() => updateSettings({ wordWrap: DEFAULT_CLIENT_SETTINGS.wordWrap })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />
        <SettingsRow
          id="ignore-diff-whitespace"
          title="Ignore whitespace in diffs"
          description="Set whether the diff panel ignores whitespace-only edits by default."
          resetAction={
            settings.diffIgnoreWhitespace !== DEFAULT_CLIENT_SETTINGS.diffIgnoreWhitespace ? (
              <SettingResetButton
                label="diff whitespace changes"
                onClick={() =>
                  updateSettings({
                    diffIgnoreWhitespace: DEFAULT_CLIENT_SETTINGS.diffIgnoreWhitespace,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
              aria-label="Hide whitespace changes by default"
            />
          }
        />
        <SettingsRow
          id="confirm-thread-unpin"
          title="Confirm before unpinning"
          description="Ask before unpinning a thread from the pinned section."
          resetAction={
            settings.confirmThreadUnpin !== DEFAULT_CLIENT_SETTINGS.confirmThreadUnpin ? (
              <SettingResetButton
                label="unpin confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadUnpin: DEFAULT_CLIENT_SETTINGS.confirmThreadUnpin,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
              aria-label="Confirm thread unpinning"
            />
          }
        />
        <SettingsRow
          id="confirm-thread-archive"
          title="Confirm before archiving"
          description="Require a second click on the inline archive action before a thread is archived."
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_CLIENT_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label="archive confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_CLIENT_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label="Confirm thread archiving"
            />
          }
        />
        <SettingsRow
          id="confirm-thread-delete"
          title="Confirm before deleting"
          description="Ask before deleting a thread and its chat history."
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_CLIENT_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label="delete confirmation"
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_CLIENT_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label="Confirm thread deletion"
            />
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/preferences")({
  component: GeneralSettingsView,
});
