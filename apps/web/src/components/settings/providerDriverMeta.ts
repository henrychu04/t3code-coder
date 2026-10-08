import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

import { ClaudeAI, type Icon, OpenAI } from "../Icons";

type ProviderSettingsSchema = {
  readonly fields: Readonly<Record<string, Schema.Top>>;
} & Schema.Top;

/**
 * Browser-safe provider definition. This is deliberately shaped like the
 * future provider package client export: the core web app gets a schema with
 * field annotations plus provider-level presentation metadata, then renders
 * settings generically.
 */
export interface ProviderClientDefinition {
  readonly value: ProviderDriverKind;
  readonly label: string;
  /** Coder: the workspace provider settings list shows each provider's mark. */
  readonly icon: Icon;
  readonly settingsSchema: ProviderSettingsSchema;
}

export const PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: ProviderDriverKind.make("codex"),
    label: "Codex",
    icon: OpenAI,
    settingsSchema: CodexSettings,
  },
  {
    value: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    icon: ClaudeAI,
    settingsSchema: ClaudeSettings,
  },
];

export const PROVIDER_CLIENT_DEFINITION_BY_VALUE: Partial<
  Record<ProviderDriverKind, ProviderClientDefinition>
> = Object.fromEntries(
  PROVIDER_CLIENT_DEFINITIONS.map((definition) => [definition.value, definition]),
);

export function getProviderClientDefinition(
  driver: ProviderDriverKind | undefined,
): ProviderClientDefinition | undefined {
  if (driver === undefined) return undefined;
  return PROVIDER_CLIENT_DEFINITION_BY_VALUE[driver];
}
