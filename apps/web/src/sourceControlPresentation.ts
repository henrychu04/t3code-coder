import { GitPullRequestIcon } from "lucide-react";
import { PullRequestGlyph } from "./components/pullRequest/pullRequestIcons";
import type { ElementType } from "react";
import type { SourceControlProviderInfo, SourceControlProviderKind } from "@t3tools/contracts";
export {
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import {
  getChangeRequestTerminology as getSharedChangeRequestTerminology,
  resolveChangeRequestPresentation as resolveSharedChangeRequestPresentation,
  type ChangeRequestPresentation,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import { GitLabIcon } from "./components/Icons";

// Coder: GitLab is the only hosted provider, so a status without one says "MR" and "merge
// request" rather than upstream's GitHub default.
const DEFAULT_SOURCE_CONTROL_PROVIDER: SourceControlProviderInfo = {
  kind: "gitlab",
  name: "",
  baseUrl: "",
};

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology =
  getSharedChangeRequestTerminology(DEFAULT_SOURCE_CONTROL_PROVIDER);

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  return getSharedChangeRequestTerminology(provider ?? DEFAULT_SOURCE_CONTROL_PROVIDER);
}

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  return resolveSharedChangeRequestPresentation(provider ?? DEFAULT_SOURCE_CONTROL_PROVIDER);
}

export interface SourceControlPresentation {
  readonly providerName: string;
  readonly terminology: ChangeRequestTerminology;
  readonly Icon: ElementType<{ className?: string }>;
}

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  const presentation = resolveChangeRequestPresentation(provider);
  switch (presentation.icon) {
    case "github":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
    case "forgejo":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
    case "gitlab":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitLabIcon,
      };
    case "azure-devops":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
    case "bitbucket":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: GitPullRequestIcon,
      };
    case "change-request":
      return {
        providerName: provider?.name || presentation.providerName,
        terminology: getChangeRequestTerminology(provider),
        Icon: PullRequestGlyph.pullRequest,
      };
  }
}

/** For surfaces that know only the host kind, such as a change request row or filter. */
export function getSourceControlPresentationForKind(
  kind: SourceControlProviderKind,
): SourceControlPresentation {
  return getSourceControlPresentation({ kind, name: "", baseUrl: "" });
}
