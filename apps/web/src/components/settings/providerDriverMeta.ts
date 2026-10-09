import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
// Coder: only the registered Codex, Claude Code, and Pi drivers can be configured or added.
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  piClient,
]);
