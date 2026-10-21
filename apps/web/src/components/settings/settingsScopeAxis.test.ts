import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  selectEnvironmentAxis,
  selectProjectAxis,
  selectSingleEnvironmentScope,
} from "./settingsScopeAxis";
import type { ResolvedSettingsScope } from "./settingsScope";

const first = { environmentId: EnvironmentId.make("first") };
const second = { environmentId: EnvironmentId.make("second") };

describe("settings scope axes", () => {
  it("drops a checkout narrowing from older links when either axis changes", () => {
    const checkout = { project: "app", checkout: "app@first", machine: "first" };
    expect(selectEnvironmentAxis(checkout, "second")).toEqual({
      project: "app",
      machine: "second",
    });
    expect(selectProjectAxis(checkout, "app")).toEqual({ project: "app", machine: "first" });
  });
});

// Coder: the Providers page relies on this to pick the active workspace instead of "No
// environments".
describe("single-environment settings scope", () => {
  const all = {
    kind: "all",
    environmentIds: [first.environmentId, second.environmentId],
  } as unknown as ResolvedSettingsScope;
  const environments = [
    { environmentId: first.environmentId, connection: { phase: "available" as const } },
    { environmentId: second.environmentId, connection: { phase: "connected" as const } },
  ];

  it("selects the active environment, then a connected one", () => {
    expect(selectSingleEnvironmentScope({}, all, environments, first.environmentId)).toEqual({
      machine: first.environmentId,
    });
    expect(selectSingleEnvironmentScope({}, all, environments, null)).toEqual({
      machine: second.environmentId,
    });
  });

  it("keeps an explicit environment", () => {
    expect(
      selectSingleEnvironmentScope({ machine: "chosen" }, all, environments, first.environmentId),
    ).toEqual({ machine: "chosen" });
  });
});
