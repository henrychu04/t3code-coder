import { expect, it } from "vite-plus/test";
import {
  projectSettingsChanged,
  projectSettingsValues,
  validateProjectSettings,
} from "./ProjectSettingsPanel.logic";

const base = {
  title: "Project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
};
it("detects stale defaults", () => {
  expect(projectSettingsChanged(base, { ...base })).toBe(false);
  expect(projectSettingsChanged(base, { ...base, autoPull: true })).toBe(true);
  expect(projectSettingsValues(base)).toEqual(base);
});
it("validates names, commands, and the single setup-script invariant", () => {
  const script = {
    id: "one",
    name: "Build",
    command: "npm run build",
    icon: "build" as const,
    runOnWorktreeCreate: true,
  };
  expect(validateProjectSettings(base)).toBeNull();
  expect(validateProjectSettings({ ...base, title: " " })).not.toBeNull();
  expect(
    validateProjectSettings({ ...base, scripts: [{ ...script, command: " " }] }),
  ).not.toBeNull();
  expect(
    validateProjectSettings({ ...base, scripts: [script, { ...script, id: "two" }] }),
  ).not.toBeNull();
  expect(validateProjectSettings({ ...base, scripts: [script] })).toBeNull();
});
