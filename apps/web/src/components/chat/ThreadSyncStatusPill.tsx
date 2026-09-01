import { LoaderCircleIcon } from "lucide-react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const label = threadSyncLabel(phase);

  return (
    <ComposerBanner.Attachment data-thread-sync-drawer="true">
      <ComposerBanner.Root aria-label={label} className="pointer-events-none" role="status">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <LoaderCircleIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="truncate font-medium">{label}</ComposerBanner.Content>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
