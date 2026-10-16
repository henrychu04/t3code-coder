import type { ElementType } from "react";
import type { SourceControlProviderInfo } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type {
  ChangeRequestTerminology,
  SourceControlClientDefinition,
} from "@t3tools/client-runtime/source-control-clients";
import { GitLabIcon } from "./components/Icons";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";

type SourceControlIcon = ElementType<{ className?: string }>;

// Coder: GitLab is the only shipped host definition, so it is the only host with art.
const SOURCE_CONTROL_ICONS: Partial<Record<string, SourceControlIcon>> = {
  gitlab: GitLabIcon,
};

export function sourceControlIcon(definition: SourceControlClientDefinition): SourceControlIcon {
  return SOURCE_CONTROL_ICONS[definition.icon] ?? PullRequestGlyph.pullRequest;
}

export interface SourceControlPresentation {
  readonly definition: SourceControlClientDefinition;
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: SourceControlIcon;
}

function presentDefinition(
  definition: SourceControlClientDefinition,
  providerName: string,
): SourceControlPresentation {
  return {
    definition,
    providerName,
    terminology: definition.changeRequest,
    Icon: sourceControlIcon(definition),
  };
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const definition = sourceControlClients.get(provider?.kind);
  return presentDefinition(definition, provider?.name || definition.label);
}

export function getSourceControlPresentationForKind(kind: string): SourceControlPresentation {
  const definition = sourceControlClients.get(kind);
  return presentDefinition(definition, definition.label);
}
