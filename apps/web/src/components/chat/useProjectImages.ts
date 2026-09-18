import { useEffect, useReducer } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { readProjectImageBlob, type ProjectImageTarget } from "../../lib/readProjectImageBlob";
import { imageResources } from "./imageResources";

export function useProjectImages(
  environmentId: EnvironmentId,
  target: ProjectImageTarget | undefined,
  enabled: boolean,
  priority = false,
) {
  "use no memo"; // Shared resource notifications must reread mutable entries.
  const read = useAtomCommand(projectEnvironment.readImage, { reportFailure: false });
  const [, rerender] = useReducer((value) => value + 1, 0);
  const serialized = target ? JSON.stringify(target) : null;
  const key = JSON.stringify([environmentId, "project-image", serialized]);
  useEffect(() => {
    if (!enabled || !serialized) return;
    const resource = JSON.parse(serialized) as ProjectImageTarget;
    return imageResources.subscribe(
      key,
      (signal) =>
        readProjectImageBlob(
          resource,
          async (input) => {
            const result = await read({ environmentId, input });
            if (result._tag !== "Success") throw squashAtomCommandFailure(result);
            return result.value;
          },
          signal,
        ),
      rerender,
      priority,
    );
  }, [key, serialized, environmentId, enabled, priority, read]);
  return enabled && target ? imageResources.get(key) : undefined;
}
