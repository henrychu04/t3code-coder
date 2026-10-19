/**
 * Coder: workspace images have no signed asset URLs. Each atom reads its image through the
 * helper's bounded chunk reads into the shared image store, and the store's object URL stands in
 * for upstream's asset URL. Mounting the atom starts the read; unmounting it releases the bytes.
 */
import type { ToolOutputImageResource } from "@t3tools/client-runtime/work-log/item-detail";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ScreenshotArtifactId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { AttachmentImageResource } from "../assets/attachmentImageResource";
import {
  type ImageResourceBlob,
  imageResources,
  type ImageResourceState,
} from "../components/chat/imageResources";
import { readProjectImageBlob, type ProjectImageTarget } from "../lib/readProjectImageBlob";
import { readScreenshotBlob } from "../lib/readScreenshotBlob";
import { readTurnItemAsset } from "../lib/readTurnItemAsset";
import { projectEnvironment } from "./projects";

/** A workspace image the helper can read. */
export type ImageAssetResource =
  | AttachmentImageResource
  | ToolOutputImageResource
  | { readonly _tag: "project-image"; readonly target: ProjectImageTarget };

interface ImageAssetTarget {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: ImageAssetResource };
  /** Lets the image the user opened displace retained previews. */
  readonly priority?: boolean | undefined;
}

// Readers of the same image share one store entry, and so one read and one object URL.
function imageResourceKey(environmentId: EnvironmentId, resource: ImageAssetResource): string {
  switch (resource._tag) {
    case "attachment":
      return JSON.stringify([environmentId, "attachment", resource.attachmentId]);
    case "tool-output-image":
      return JSON.stringify([
        environmentId,
        resource._tag,
        resource.threadId,
        resource.itemId,
        resource.index,
      ]);
    case "project-image":
      return JSON.stringify([environmentId, "project-image", JSON.stringify(resource.target)]);
  }
}

function commandReader<W, A, E>(
  registry: AtomRegistry.AtomRegistry,
  command: AtomCommand<W, A, E>,
) {
  return async (value: W): Promise<A> => {
    const result = await runAtomCommand(registry, command, value, { reportFailure: false });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
    return result.value;
  };
}

function readImageAsset(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  resource: ImageAssetResource,
  signal: AbortSignal,
): Promise<ImageResourceBlob> {
  switch (resource._tag) {
    case "attachment": {
      const read = commandReader(registry, projectEnvironment.readScreenshotArtifact);
      return readScreenshotBlob(
        {
          id: ScreenshotArtifactId.make(resource.attachmentId),
          name: resource.attachmentId,
          mimeType: resource.mimeType,
          ...(resource.sizeBytes === undefined ? {} : { sizeBytes: resource.sizeBytes }),
        },
        (input) => read({ environmentId, input }),
        signal,
      );
    }
    case "tool-output-image": {
      const read = commandReader(registry, projectEnvironment.readTurnItemAsset);
      return readTurnItemAsset(
        {
          threadId: resource.threadId,
          itemId: resource.itemId,
          asset: { _tag: "tool-output-image", index: resource.index },
        },
        (mimeType) => mimeType.startsWith("image/"),
        (input) => read({ environmentId, input }),
        signal,
      );
    }
    case "project-image": {
      const read = commandReader(registry, projectEnvironment.readImage);
      return readProjectImageBlob(
        resource.target,
        (input) => read({ environmentId, input }),
        signal,
      );
    }
  }
}

const createUrlFamily = Atom.family((key: string) => {
  const { environmentId, input, priority } = JSON.parse(key) as ImageAssetTarget;
  const resourceKey = imageResourceKey(environmentId, input.resource);
  return Atom.make((get): ImageResourceState => {
    get.addFinalizer(
      imageResources.subscribe(
        resourceKey,
        (signal) => readImageAsset(get.registry, environmentId, input.resource, signal),
        () => get.setSelf(imageResources.get(resourceKey)),
        priority,
      ),
    );
    return imageResources.get(resourceKey);
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:assets:create-url:${key}`));
});

const createUrlsFamily = Atom.family((key: string) => {
  const [environmentId, resources] = JSON.parse(key) as [
    EnvironmentId,
    ReadonlyArray<ImageAssetResource>,
  ];
  return Atom.make((get) =>
    resources.map((resource) =>
      get(assetEnvironment.createUrl({ environmentId, input: { resource } })),
    ),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-data:assets:create-urls:${key}`));
});

export const assetEnvironment = {
  createUrl: (target: ImageAssetTarget) =>
    createUrlFamily(
      JSON.stringify({
        environmentId: target.environmentId,
        input: { resource: target.input.resource },
        priority: target.priority ?? false,
      }),
    ),
  createUrls: (target: {
    readonly environmentId: EnvironmentId;
    readonly resources: ReadonlyArray<ImageAssetResource>;
  }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
};
