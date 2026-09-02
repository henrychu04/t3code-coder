import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  applyEnvironmentClientSettingsPatch,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

  it("isolates provider preferences by environment and falls back to legacy preferences", () => {
    const workspaceA = EnvironmentId.make("workspace-a");
    const workspaceB = EnvironmentId.make("workspace-b");
    const legacyFavorite = {
      provider: ProviderInstanceId.make("codex"),
      model: "legacy-model",
    };
    const scopedFavorite = {
      provider: ProviderInstanceId.make("codex"),
      model: "workspace-a-model",
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [legacyFavorite],
      providerPreferencesByEnvironment: {
        [workspaceA]: {
          favorites: [scopedFavorite],
          providerModelPreferences: {},
        },
      },
    };

    expect(
      mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, clientSettings, workspaceA).favorites,
    ).toEqual([scopedFavorite]);
    expect(
      mergeEnvironmentSettings(DEFAULT_SERVER_SETTINGS, clientSettings, workspaceB).favorites,
    ).toEqual([legacyFavorite]);
  });

  it("migrates legacy provider preferences when an environment first changes them", () => {
    const environmentId = EnvironmentId.make("workspace-a");
    const legacyPreferences = {
      [ProviderInstanceId.make("codex")]: {
        hiddenModels: ["hidden"],
        modelOrder: ["first"],
      },
    };
    const next = applyEnvironmentClientSettingsPatch(
      {
        ...DEFAULT_CLIENT_SETTINGS,
        providerModelPreferences: legacyPreferences,
      },
      {
        favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-5.4" }],
      },
      environmentId,
    );

    expect(next.favorites).toEqual([]);
    expect(next.providerPreferencesByEnvironment[environmentId]).toEqual({
      favorites: [{ provider: ProviderInstanceId.make("codex"), model: "gpt-5.4" }],
      providerModelPreferences: legacyPreferences,
    });
  });
});
