import type { PullRequestMergeMethod } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import type {
  EnvironmentId,
  ServerProvider,
  SourceControlWritingStyleMode,
} from "@t3tools/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { SettingsRow, SettingsSection, SettingsSelect } from "./SettingsPage";
import { Button } from "../ui/button";
import { ScopedSwitch } from "./ScopedSwitch";
import { Textarea } from "../ui/textarea";
import { getModelOptionsByInstance, resolveAppModelSelectionState } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveCoderProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
const WRITING_STYLE_LABELS: Record<SourceControlWritingStyleMode, string> = {
  repo_conventions: "Repository conventions",
  conventional_commits: "Conventional Commits",
  custom: "Custom instructions",
};

export function SourceControlPreferences({
  environmentId,
  settings,
  updateSettings,
  providers,
  projectScoped = false,
}: {
  environmentId: EnvironmentId;
  settings: UnifiedSettings;
  updateSettings: (patch: ServerSettingsPatch) => void;
  providers: ReadonlyArray<ServerProvider>;
  projectScoped?: boolean;
}) {
  const style = settings.sourceControlWritingStyle;
  const defaultSelection = resolveAppModelSelectionState(settings, providers);
  const resolvedWriterSelection = resolveSourceControlWriterModelSelection(settings);
  const usesDedicatedModel = settings.sourceControlWriterModelSelection !== null;
  const activeSelection =
    resolvedWriterSelection === settings.textGenerationModelSelection
      ? defaultSelection
      : resolvedWriterSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveCoderProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getModelOptionsByInstance(
    settings,
    providers,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const fetchSeconds = Math.round(Duration.toMillis(settings.automaticGitFetchInterval) / 1_000);

  return (
    <SettingsSection
      title="Source control behavior"
      description="Configure automatic GitLab refreshes and the text generated for commits and merge requests."
    >
      {!projectScoped && (
        <SettingsRow
          id="git-fetch-interval"
          settingKeys={["automaticGitFetchInterval"]}
          title="Fetch interval"
          description="Refresh remote branch and merge request status in the background. Set to 0 to disable."
          control={
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="number"
                min={0}
                step={5}
                value={fetchSeconds}
                aria-label="Automatic Git fetch interval in seconds"
                className="h-8 w-24 rounded-md border border-input bg-background px-2 text-right text-sm text-foreground"
                onChange={(event) =>
                  updateSettings({
                    automaticGitFetchInterval: Duration.seconds(
                      Math.max(0, Number.parseInt(event.currentTarget.value, 10) || 0),
                    ),
                  })
                }
              />
              seconds
            </label>
          }
        />
      )}
      {!projectScoped && (
        <SettingsRow
          id="default-merge-method"
          settingKeys={["pullRequestMergeMethod"]}
          title="Default merge method"
          description="Preferred method for GitLab merge requests. GitLab's allowed methods still apply."
          control={
            <SettingsSelect
              ariaLabel="Default merge method"
              value={settings.pullRequestMergeMethod}
              onChange={(value) =>
                updateSettings({ pullRequestMergeMethod: value as PullRequestMergeMethod })
              }
            >
              <option value="merge">Merge</option>
              <option value="squash">Squash</option>
              <option value="rebase">Rebase</option>
            </SettingsSelect>
          }
        />
      )}
      <SettingsRow
        id="source-control-writing-style"
        settingKeys={["sourceControlWritingStyle"]}
        title="Source control writing style"
        description={
          style.mode === "repo_conventions"
            ? "Matches recent commit subjects in each repository."
            : style.mode === "conventional_commits"
              ? "Uses Conventional Commit prefixes for generated commit subjects."
              : "Applies your instructions to generated commits and merge requests."
        }
        control={
          <SettingsSelect
            ariaLabel="Source control writing style"
            value={style.mode}
            onChange={(mode) =>
              updateSettings({
                sourceControlWritingStyle: {
                  mode: mode as SourceControlWritingStyleMode,
                },
              })
            }
          >
            {Object.entries(WRITING_STYLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SettingsSelect>
        }
      >
        {style.mode === "custom" ? (
          <Textarea
            defaultValue={style.customInstructions}
            rows={4}
            className="mt-3"
            placeholder="Keep titles concise. Use short bullet points in descriptions."
            aria-label="Custom source control writing instructions"
            onBlur={(event) =>
              updateSettings({
                sourceControlWritingStyle: {
                  customInstructions: event.currentTarget.value.trim(),
                },
              })
            }
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        id="follow-merge-request-templates"
        settingKeys={["sourceControlWritingStyle"]}
        title="Follow merge request templates"
        description="Use the repository's merge request template when generating a description."
        control={
          <ScopedSwitch
            settingKeys={["sourceControlWritingStyle"]}
            checked={style.followChangeRequestTemplates}
            aria-label="Follow merge request templates"
            onCheckedChange={(checked) =>
              updateSettings({
                sourceControlWritingStyle: { followChangeRequestTemplates: Boolean(checked) },
              })
            }
          />
        }
      />
      <SettingsRow
        id="source-control-writer-model"
        settingKeys={["sourceControlWriterModelSelection"]}
        title="Source control writer model"
        description="Optionally use a separate model for commit messages, branch names, and merge request content."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {usesDedicatedModel ? (
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={activeSelection.instanceId}
                model={activeSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerAriaLabel="Source control writer model"
                onInstanceModelChange={(instanceId, model) =>
                  updateSettings({
                    sourceControlWriterModelSelection: createModelSelection(instanceId, model),
                  })
                }
              />
            ) : null}
            <ScopedSwitch
              settingKeys={["sourceControlWriterModelSelection"]}
              checked={usesDedicatedModel}
              aria-label="Use a separate source control writer model"
              onCheckedChange={(checked) =>
                updateSettings({
                  sourceControlWriterModelSelection: checked
                    ? createModelSelection(
                        defaultSelection.instanceId,
                        defaultSelection.model,
                        defaultSelection.options,
                      )
                    : null,
                })
              }
            />
          </div>
        }
      />
      {!projectScoped &&
      (usesDedicatedModel ||
        style.mode !== DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.mode ||
        fetchSeconds !==
          Math.round(
            Duration.toMillis(DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval) / 1_000,
          )) ? (
        <SettingsRow
          id="reset-source-control-defaults"
          settingKeys={[
            "automaticGitFetchInterval",
            "sourceControlWritingStyle",
            "sourceControlWriterModelSelection",
          ]}
          title="Reset source control defaults"
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                updateSettings({
                  automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
                  sourceControlWritingStyle: DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
                  sourceControlWriterModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.sourceControlWriterModelSelection,
                })
              }
            >
              Reset
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
