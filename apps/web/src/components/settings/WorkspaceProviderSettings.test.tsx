import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "./providerDriverMeta";
import { WorkspaceProviderEditor, WorkspaceProviderListRow } from "./WorkspaceProviderSettings";

const CODEX = ProviderDriverKind.make("codex");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

function codexProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: CODEX_INSTANCE_ID,
    driver: CODEX,
    enabled: true,
    installed: true,
    version: "0.148.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("workspace provider settings", () => {
  it("keeps the upstream compact provider row hierarchy", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[CODEX]!;
    const markup = renderToStaticMarkup(
      <WorkspaceProviderListRow
        row={{
          instanceId: CODEX_INSTANCE_ID,
          definition,
          instance: { driver: CODEX, enabled: true },
          explicit: false,
          liveProvider: codexProvider(),
        }}
        selected
        onSelect={() => {}}
        onEnabledChange={() => {}}
      />,
    );

    expect(markup).toContain("Codex");
    expect(markup).toContain("Available");
    expect(markup).not.toContain("Authenticated");
    expect(markup).toContain("v0.148.0");
    expect(markup).toContain('aria-label="Enable Codex"');
  });

  it("presents workspace availability without authentication details", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[CODEX]!;
    const markup = renderToStaticMarkup(
      <WorkspaceProviderListRow
        row={{
          instanceId: CODEX_INSTANCE_ID,
          definition,
          instance: { driver: CODEX, enabled: true },
          explicit: false,
          liveProvider: codexProvider({
            status: "warning",
            auth: { status: "unauthenticated" },
            message: "Run codex login",
          }),
        }}
        selected
        onSelect={() => {}}
        onEnabledChange={() => {}}
      />,
    );

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Workspace access for this provider is not ready.");
    expect(markup).not.toContain("authenticated");
    expect(markup).not.toContain("codex login");
  });

  it("shows only built-in models for Codex without an empty Configuration tab", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[CODEX]!;
    const markup = renderToStaticMarkup(
      <WorkspaceProviderEditor
        row={{
          instanceId: CODEX_INSTANCE_ID,
          definition,
          instance: { driver: CODEX, enabled: true },
          explicit: false,
          liveProvider: codexProvider({
            models: [
              {
                slug: "built-in",
                name: "Built In",
                isCustom: false,
                capabilities: null,
              },
              {
                slug: "custom-model",
                name: "Custom Model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }),
        }}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onUpdate={() => {}}
        onHiddenModelsChange={() => {}}
        onFavoriteModelsChange={() => {}}
        onModelOrderChange={() => {}}
      />,
    );

    expect(markup).toContain("Models");
    expect(markup).toContain("Built In");
    expect(markup).not.toContain("Configuration");
    expect(markup).not.toContain("Custom Model");
    expect(markup).not.toContain("Add provider");
    expect(markup).not.toContain("Add custom model");
  });

  it("exposes only Claude auto-compact under Configuration", () => {
    const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[CLAUDE]!;
    const markup = renderToStaticMarkup(
      <WorkspaceProviderEditor
        row={{
          instanceId: CLAUDE_INSTANCE_ID,
          definition,
          instance: {
            driver: CLAUDE,
            enabled: true,
            config: {
              binaryPath: "/workspace/bin/claude",
              homePath: "/workspace/.claude",
              autoCompactWindow: "300000",
            },
          },
          explicit: false,
          liveProvider: undefined,
        }}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onUpdate={() => {}}
        onHiddenModelsChange={() => {}}
        onFavoriteModelsChange={() => {}}
        onModelOrderChange={() => {}}
      />,
    );

    expect(markup).toContain("Configuration");
    expect(markup).toContain("Models");
    expect(markup).toContain("Auto-compact after");
    expect(markup).toContain('aria-label="Reset auto-compact window to default"');
    expect(markup).not.toContain("Binary path");
    expect(markup).not.toContain("CLAUDE_CONFIG_DIR path");
    expect(markup).not.toContain("Display name");
    expect(markup).not.toContain("Environment variables");
    expect(markup).not.toContain("Update now");
  });
});
