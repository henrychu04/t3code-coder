import type { EnvironmentId } from "@t3tools/contracts";
import { PULL_REQUEST_CHIP_KINDS, PullRequestChip, UnresolvedChip } from "./contextChipParts";
import { createContext, use, type ReactElement } from "react";
import type { CoderDraftContextRecord } from "~/lib/coderComposerContext";
import { createContextPresentationRegistry } from "./contextPresentationRegistry";
import { CoderComposerContextChip } from "./CoderComposerContextChip";
import { ComposerPendingTerminalContextChip } from "./chat/ComposerPendingTerminalContexts";

export type ComposerDraftContextRecords = ReadonlyMap<string, CoderDraftContextRecord>;
export const ComposerContextRecordsContext = createContext<ComposerDraftContextRecords>(new Map());
export const ComposerContextActionsContext = createContext({
  environmentId: null as EnvironmentId | null,
  openPullRequest: (_event: React.MouseEvent<HTMLElement>, _url: string) => {},
  openMention: (_path: string) => {},
  canOpenMention: (_path: string): boolean => false,
  replaceContext: (_id: string, _source: string) => {},
  disabled: false,
});

type RenderContext = {
  contextId: string;
  label: string;
  actions: React.ContextType<typeof ComposerContextActionsContext>;
};
function Unavailable({ label }: { label: string }) {
  return (
    <UnresolvedChip
      label={label || "Unavailable context"}
      tooltip="This context is no longer available. Remove it or attach it again."
    />
  );
}

function renderEditable(record: CoderDraftContextRecord, context: RenderContext) {
  return (
    <CoderComposerContextChip
      source={record.source}
      disabled={context.actions.disabled}
      onSave={(source) => context.actions.replaceContext(context.contextId, source)}
    />
  );
}
const registry = createContextPresentationRegistry<
  CoderDraftContextRecord,
  RenderContext,
  ReactElement
>({
  requiredKinds: ["image", "terminal", "review-comment"],
  handlers: [
    {
      kind: "terminal",
      canRender: (entry) => entry.terminal != null,
      render: (entry, context) =>
        entry.terminal ? (
          <ComposerPendingTerminalContextChip context={entry.terminal} />
        ) : (
          <Unavailable label={context.label} />
        ),
    },
    { kind: "image", render: renderEditable },
    {
      kind: "review-comment",
      render: (entry, context) => {
        const metadata =
          entry.context?.kind === "review-comment" ? entry.context.comment.pullRequest : undefined;
        return metadata ? (
          <PullRequestChip
            metadata={metadata}
            environmentId={context.actions.environmentId}
            label={`!${metadata.number}`}
            kindLabel="merge request"
            kind={
              PULL_REQUEST_CHIP_KINDS[
                metadata.state === "open" && metadata.isDraft ? "draft" : metadata.state
              ]
            }
            onOpen={context.actions.openPullRequest}
          />
        ) : (
          renderEditable(entry, context)
        );
      },
    },
  ],
  fallback: (_kind, entry, context) =>
    entry?.kind === "text" ? renderEditable(entry, context) : <Unavailable label={context.label} />,
});

export function ComposerContextReferenceChip(props: {
  kind: string;
  contextId: string;
  label: string;
}) {
  const records = use(ComposerContextRecordsContext);
  const actions = use(ComposerContextActionsContext);
  return registry.render(props.kind, records.get(props.contextId), { ...props, actions });
}
