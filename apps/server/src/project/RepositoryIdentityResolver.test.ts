import { describe, expect, it } from "@effect/vitest";

import { repositoryPathFromRemoteUrl } from "./RepositoryIdentityResolver.ts";

describe("repositoryPathFromRemoteUrl", () => {
  it.each([
    ["https://gitlab.example.gs.com/goldman/smoke.git", "goldman/smoke"],
    ["ssh://git@gitlab.example.gs.com/goldman/platform/smoke.git", "goldman/platform/smoke"],
    ["git@gitlab.example.gs.com:goldman/platform/smoke.git", "goldman/platform/smoke"],
  ])("extracts the provider-native project path from %s", (remoteUrl, expected) => {
    expect(repositoryPathFromRemoteUrl(remoteUrl)).toBe(expected);
  });
});
