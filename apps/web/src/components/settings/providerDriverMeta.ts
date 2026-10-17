import { ClaudeSettings, CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { piClient } from "@t3tools/provider-pi/client";

// Coder: only the registered Codex, Claude Code, Pi, and Kilo Code (ACP Registry) drivers can be
// configured or added.
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
  acpRegistryClient,
]);
