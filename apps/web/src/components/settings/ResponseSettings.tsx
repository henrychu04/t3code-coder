import type {
  ProjectScopedServerSettingKey,
  ProjectSettingsOverrides,
  ServerSettings,
} from "@t3tools/contracts";
import { useOptionalScopedSettingsMixed } from "./useScopedSettings";
import { SettingsRow, SettingResetButton } from "./SettingsPage";

const PERMISSIONS = {
  "approval-required": "Ask for approval",
  "auto-accept-edits": "Accept edits",
  auto: "Automatic",
  "full-access": "Full access",
} as const;
const STREAMING = {
  turn: "Completed turn",
  paragraph: "Completed paragraphs",
  token: "Live tokens",
} as const;

export function ResponseSettings({
  settings,
  overrides,
  onChange,
  onReset,
}: {
  settings: ServerSettings;
  overrides?: ProjectSettingsOverrides;
  onChange: (patch: ProjectSettingsOverrides) => void;
  onReset?: (key: ProjectScopedServerSettingKey) => void;
}) {
  const mixedPermissions = useOptionalScopedSettingsMixed(["defaultRuntimeMode"]);
  const mixedStreaming = useOptionalScopedSettingsMixed(["responseStreamingMode"]);
  return (
    <>
      <SettingsRow
        id="default-permissions"
        settingKeys={["defaultRuntimeMode"]}
        title="Default permissions"
        description="Permissions for new threads. Existing threads keep their selected mode."
        resetAction={
          overrides?.defaultRuntimeMode !== undefined && onReset ? (
            <SettingResetButton
              label="project default permissions"
              onClick={() => onReset("defaultRuntimeMode")}
            />
          ) : null
        }
        control={
          <select
            aria-label="Default permissions"
            className="rounded border bg-background p-2 text-sm"
            value={mixedPermissions ? "mixed" : settings.defaultRuntimeMode}
            onChange={(event) => {
              const mode = event.target.value;
              if (
                mode === "approval-required" ||
                mode === "auto-accept-edits" ||
                mode === "auto" ||
                mode === "full-access"
              )
                onChange({ defaultRuntimeMode: mode });
            }}
          >
            {mixedPermissions && (
              <option disabled value="mixed">
                Mixed
              </option>
            )}
            {Object.entries(PERMISSIONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      />
      <SettingsRow
        id="response-streaming"
        settingKeys={["responseStreamingMode"]}
        title="Response streaming"
        description="Show completed turns, completed paragraphs and code blocks, or each token as it arrives."
        resetAction={
          overrides?.responseStreamingMode !== undefined && onReset ? (
            <SettingResetButton
              label="project response streaming"
              onClick={() => onReset("responseStreamingMode")}
            />
          ) : null
        }
        control={
          <select
            aria-label="Response streaming"
            className="rounded border bg-background p-2 text-sm"
            value={mixedStreaming ? "mixed" : settings.responseStreamingMode}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "turn" || mode === "paragraph" || mode === "token")
                onChange({ responseStreamingMode: mode });
            }}
          >
            {mixedStreaming && (
              <option disabled value="mixed">
                Mixed
              </option>
            )}
            {Object.entries(STREAMING).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        }
      />
    </>
  );
}
