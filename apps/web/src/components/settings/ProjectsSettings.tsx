import { useState } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  type ProjectScript,
} from "@t3tools/contracts";
import { useOptionalScopedSettingsMixed } from "./useScopedSettings";
import { SettingsRow } from "./SettingsPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { validateProjectSettings } from "./ProjectSettingsPanel.logic";

export function DefaultsForm({
  settings,
  providers,
  disabled,
  onSave,
}: {
  settings: typeof DEFAULT_SERVER_SETTINGS;
  providers: ReadonlyArray<import("@t3tools/contracts").ServerProvider>;
  disabled: boolean;
  onSave: (
    patch: Partial<{
      defaultModelSelection: ModelSelection | null;
      defaultAutoPull: boolean;
      defaultThreadEnvMode: "local" | "worktree";
      defaultProjectScripts: ProjectScript[];
    }>,
  ) => Promise<void>;
}) {
  const mixedModel = useOptionalScopedSettingsMixed(["defaultModelSelection"]);
  const mixedMode = useOptionalScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedAutoPull = useOptionalScopedSettingsMixed(["defaultAutoPull"]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const mark = (key: string) => setDirty((current) => new Set([...current, key]));
  const [modelDraft, setModelValue] = useState(settings.defaultModelSelection);
  const [autoPullDraft, setAutoPullValue] = useState(settings.defaultAutoPull);
  const [modeDraft, setModeValue] = useState(settings.defaultThreadEnvMode);
  const [scriptsDraft, setScriptsValue] = useState([...settings.defaultProjectScripts]);
  // Follow subscription updates and inheritance resets for untouched fields,
  // while preserving unsaved edits (including drafts from failed saves).
  const model = !dirty.has("defaultModelSelection") ? settings.defaultModelSelection : modelDraft;
  const autoPull = !dirty.has("defaultAutoPull") ? settings.defaultAutoPull : autoPullDraft;
  const mode = !dirty.has("defaultThreadEnvMode") ? settings.defaultThreadEnvMode : modeDraft;
  const scripts = !dirty.has("defaultProjectScripts")
    ? settings.defaultProjectScripts
    : scriptsDraft;
  const setModel = (value: ModelSelection | null) => {
    mark("defaultModelSelection");
    setModelValue(value);
  };
  const setAutoPull = (value: boolean) => {
    mark("defaultAutoPull");
    setAutoPullValue(value);
  };
  const setMode = (value: "local" | "worktree") => {
    mark("defaultThreadEnvMode");
    setModeValue(value);
  };
  const setScripts = (value: ProjectScript[]) => {
    mark("defaultProjectScripts");
    setScriptsValue(value);
  };
  const [error, setError] = useState<string | null>(null);
  const models = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.map((entry) => ({ instanceId: provider.instanceId, model: entry.slug })),
    );
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || dirty.size === 0) return;
        const validation = validateProjectSettings({
          title: "Defaults",
          defaultModelSelection: model,
          defaultThreadEnvMode: mode,
          autoPull,
          scripts,
        });
        setError(validation);
        if (!validation)
          void onSave(
            Object.fromEntries(
              Object.entries({
                defaultModelSelection: model,
                defaultAutoPull: autoPull,
                defaultThreadEnvMode: mode,
                defaultProjectScripts: scripts,
              }).filter(([key]) => dirty.has(key)),
            ),
          );
      }}
    >
      <fieldset disabled={disabled} className="space-y-4">
        <SettingsRow
          title="Default model"
          settingKeys={["defaultModelSelection"]}
          control={
            <select
              aria-label="Default model"
              className="rounded border bg-background p-2"
              value={
                mixedModel && !dirty.has("defaultModelSelection")
                  ? "mixed"
                  : model
                    ? JSON.stringify([model.instanceId, model.model])
                    : ""
              }
              onChange={(event) => {
                const selected = models.find(
                  (entry) => JSON.stringify([entry.instanceId, entry.model]) === event.target.value,
                );
                setModel(selected ?? null);
              }}
            >
              {mixedModel && !dirty.has("defaultModelSelection") && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="">Use provider default</option>
              {models.map((entry) => (
                <option
                  key={JSON.stringify([entry.instanceId, entry.model])}
                  value={JSON.stringify([entry.instanceId, entry.model])}
                >
                  {entry.instanceId} · {entry.model}
                </option>
              ))}
            </select>
          }
        />
        <SettingsRow
          title="New threads"
          settingKeys={["defaultThreadEnvMode"]}
          control={
            <select
              aria-label="Default checkout mode"
              value={mixedMode && !dirty.has("defaultThreadEnvMode") ? "mixed" : mode}
              className="rounded border bg-background p-2"
              onChange={(event) =>
                setMode(event.target.value === "worktree" ? "worktree" : "local")
              }
            >
              {mixedMode && !dirty.has("defaultThreadEnvMode") && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="local">Current checkout</option>
              <option value="worktree">New worktree</option>
            </select>
          }
        />
        <SettingsRow title="Automatic pull" settingKeys={["defaultAutoPull"]}>
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={mixedAutoPull && !dirty.has("defaultAutoPull") ? false : autoPull}
              aria-checked={mixedAutoPull && !dirty.has("defaultAutoPull") ? "mixed" : autoPull}
              ref={(input) => {
                if (input) input.indeterminate = mixedAutoPull && !dirty.has("defaultAutoPull");
              }}
              onChange={(event) => setAutoPull(event.target.checked)}
            />
            Automatically pull clean default-branch checkouts when the helper starts
          </label>
        </SettingsRow>
        <SettingsRow title="Project scripts" settingKeys={["defaultProjectScripts"]}>
          <p className="text-sm">
            Default scripts apply to projects that inherit actions. Saving does not run them.
          </p>
          {scripts.map((script, index) => (
            <div key={script.id} className="space-y-2 rounded border p-3">
              <Input
                aria-label={`Default script ${index + 1} name`}
                value={script.name}
                onChange={(event) =>
                  setScripts(
                    scripts.map((entry) =>
                      entry.id === script.id ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Textarea
                aria-label={`Default script ${index + 1} command`}
                value={script.command}
                onChange={(event) =>
                  setScripts(
                    scripts.map((entry) =>
                      entry.id === script.id ? { ...entry, command: event.target.value } : entry,
                    ),
                  )
                }
              />
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={script.runOnWorktreeCreate}
                  onChange={(event) =>
                    setScripts(
                      scripts.map((entry) => ({
                        ...entry,
                        runOnWorktreeCreate:
                          entry.id === script.id
                            ? event.target.checked
                            : event.target.checked
                              ? false
                              : entry.runOnWorktreeCreate,
                      })),
                    )
                  }
                />
                Run when a worktree is created
              </label>
              <Button
                type="button"
                variant="outline"
                onClick={() => setScripts(scripts.filter((entry) => entry.id !== script.id))}
              >
                Remove script
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setScripts([
                  ...scripts,
                  {
                    id: crypto.randomUUID(),
                    name: "",
                    command: "",
                    icon: "play",
                    runOnWorktreeCreate: false,
                  },
                ])
              }
            >
              Add script
            </Button>
          </div>
        </SettingsRow>
        <div>
          <Button type="submit" disabled={disabled || dirty.size === 0}>
            {disabled ? "Saving…" : "Save defaults"}
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  );
}
