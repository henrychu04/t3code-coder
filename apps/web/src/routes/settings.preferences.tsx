import {
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type DiffRenderMode,
  type SidebarProjectGroupingMode,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  type TimestampFormat,
} from "@t3tools/contracts/settings";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings/SettingsPage";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";
import { WorkspaceProviderSettings } from "../components/settings/WorkspaceProviderSettings";

function GeneralSettingsView() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsPage>
      <WorkspaceProviderSettings />

      <SettingsSection
        title="New threads"
        description="Choose how new work starts inside the selected Coder workspace."
      >
        <SettingsRow
          title="Default checkout mode"
          description="Work in the project checkout or create a dedicated Git worktree."
          control={
            <SettingsSelect
              ariaLabel="Default checkout mode"
              value={settings.defaultThreadEnvMode}
              onChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <option value="local">Project checkout</option>
              <option value="worktree">New worktree</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Start worktrees from origin"
          description="Base new worktrees on the remote tracking branch instead of the local branch."
          control={
            <Switch
              aria-label="Start worktrees from origin"
              checked={settings.newWorktreesStartFromOrigin}
              onCheckedChange={(checked) =>
                updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar" description="Control project grouping and thread ordering.">
        <SettingsRow
          title="Group projects"
          description="Choose when checkouts of the same repository appear together."
          control={
            <SettingsSelect
              ariaLabel="Project grouping"
              value={settings.sidebarProjectGroupingMode}
              onChange={(value) => {
                if (value === "repository" || value === "repository_path" || value === "separate") {
                  updateSettings({
                    sidebarProjectGroupingMode: value satisfies SidebarProjectGroupingMode,
                  });
                }
              }}
            >
              <option value="repository">By repository</option>
              <option value="repository_path">By repository path</option>
              <option value="separate">Keep separate</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Project order"
          control={
            <SettingsSelect
              ariaLabel="Project order"
              value={settings.sidebarProjectSortOrder}
              onChange={(value) => {
                if (value === "updated_at" || value === "created_at" || value === "manual") {
                  updateSettings({
                    sidebarProjectSortOrder: value satisfies SidebarProjectSortOrder,
                  });
                }
              }}
            >
              <option value="updated_at">Recently active</option>
              <option value="created_at">Recently added</option>
              <option value="manual">Manual</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Thread order"
          control={
            <SettingsSelect
              ariaLabel="Thread order"
              value={settings.sidebarThreadSortOrder}
              onChange={(value) => {
                if (value === "updated_at" || value === "created_at") {
                  updateSettings({
                    sidebarThreadSortOrder: value satisfies SidebarThreadSortOrder,
                  });
                }
              }}
            >
              <option value="updated_at">Recently active</option>
              <option value="created_at">Recently created</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Visible threads per project"
          description={`Show between ${MIN_SIDEBAR_THREAD_PREVIEW_COUNT} and ${MAX_SIDEBAR_THREAD_PREVIEW_COUNT} threads before expanding a project.`}
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
        <SettingsRow
          title="Auto-settle inactive threads"
          description="Move inactive threads into the settled shelf after this many days."
          control={
            <SettingsSelect
              ariaLabel="Auto-settle inactive threads"
              value={
                settings.sidebarAutoSettleAfterDays === null
                  ? "off"
                  : String(settings.sidebarAutoSettleAfterDays)
              }
              onChange={(value) => {
                if (value === "off") {
                  updateSettings({ sidebarAutoSettleAfterDays: null });
                  return;
                }
                const days = Number(value);
                if (
                  Number.isFinite(days) &&
                  days >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
                  days <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
                ) {
                  updateSettings({ sidebarAutoSettleAfterDays: days });
                }
              }}
            >
              <option value="off">Off</option>
              <option value="1">After 1 day</option>
              <option value="3">After 3 days</option>
              <option value="7">After 7 days</option>
              <option value="14">After 14 days</option>
              <option value="30">After 30 days</option>
              <option value="90">After 90 days</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Auto-settle merged threads"
          description="Settle a thread automatically when its branch is merged."
          control={
            <Switch
              aria-label="Auto-settle merged threads"
              checked={settings.sidebarAutoSettleOnMerge}
              onCheckedChange={(checked) =>
                updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Editor and history">
        <SettingsRow
          title="Time format"
          control={
            <SettingsSelect
              ariaLabel="Time format"
              value={settings.timestampFormat}
              onChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value satisfies TimestampFormat });
                }
              }}
            >
              <option value="locale">System default</option>
              <option value="12-hour">12-hour</option>
              <option value="24-hour">24-hour</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Diff layout"
          description="Choose how diffs are displayed by default."
          control={
            <SettingsSelect
              ariaLabel="Diff layout"
              value={settings.diffRenderMode}
              onChange={(value) => {
                if (value === "stacked" || value === "split") {
                  updateSettings({ diffRenderMode: value satisfies DiffRenderMode });
                }
              }}
            >
              <option value="stacked">Stacked</option>
              <option value="split">Side by side</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Wrap long lines"
          description="Wrap long lines in diffs and file views by default."
          control={
            <Switch
              aria-label="Wrap long lines"
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Ignore whitespace in diffs"
          control={
            <Switch
              aria-label="Ignore whitespace in diffs"
              checked={settings.diffIgnoreWhitespace}
              onCheckedChange={(checked) =>
                updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
              }
            />
          }
        />
        <SettingsRow
          title="Confirm before unpinning"
          control={
            <Switch
              aria-label="Confirm before unpinning"
              checked={settings.confirmThreadUnpin}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadUnpin: Boolean(checked) })
              }
            />
          }
        />
        <SettingsRow
          title="Confirm before archiving"
          control={
            <Switch
              aria-label="Confirm before archiving"
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
            />
          }
        />
        <SettingsRow
          title="Confirm before deleting"
          control={
            <Switch
              aria-label="Confirm before deleting"
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
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
