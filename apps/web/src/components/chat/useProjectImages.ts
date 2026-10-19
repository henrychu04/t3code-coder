import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { ProjectImageTarget } from "../../lib/readProjectImageBlob";
import { assetEnvironment } from "../../state/assets";
import type { ImageResourceState } from "./imageResources";

const DISABLED_IMAGE_ATOM = Atom.make<ImageResourceState | undefined>(undefined);

export function useProjectImages(
  environmentId: EnvironmentId | undefined,
  target: ProjectImageTarget | undefined,
  enabled: boolean,
  priority = false,
) {
  return useAtomValue(
    enabled && environmentId && target
      ? assetEnvironment.createUrl({
          environmentId,
          input: { resource: { _tag: "project-image", target } },
          priority,
        })
      : DISABLED_IMAGE_ATOM,
  );
}
