import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";

// Coder: no hosted account or token settings (Coder and the workspace own credentials), so
// upstream's `readHostCredentialSettings` and its credential types are not carried.
export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlDefinition,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export const sourceControlClients = builtInSourceControlDefinitions;

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}
