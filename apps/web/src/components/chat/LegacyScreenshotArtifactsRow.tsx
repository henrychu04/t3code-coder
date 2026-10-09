/**
 * Coder: screenshots a pre-v2 conversation saved on tool activities after an imported message.
 * Upstream's v1 importer carries messages only, so the helper looks these up in the v1 rows the
 * v2 database kept; imported messages are the ones without a run.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import type { ChatMessage } from "../../types";
import { ScreenshotArtifactsRow } from "./ScreenshotArtifactsRow";

export function LegacyScreenshotArtifactsRow({
  environmentId,
  message,
}: {
  environmentId: EnvironmentId;
  message: Pick<ChatMessage, "id" | "runId">;
}) {
  // Cached threads render before the workspace connects; look up once it is connected.
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const query = useEnvironmentQuery(
    connected && message.runId === null
      ? projectEnvironment.listLegacyScreenshotArtifacts({
          environmentId,
          input: { messageId: message.id },
        })
      : null,
  );
  const artifacts = query.data?.artifacts ?? [];
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-2 px-1">
      <ScreenshotArtifactsRow artifacts={artifacts} environmentId={environmentId} />
    </div>
  );
}
