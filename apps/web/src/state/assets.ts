/**
 * Coder: workspace images have no signed asset URLs. Each atom reads its image through the
 * helper's bounded chunk reads into the shared image store, and the store's object URL stands in
 * for upstream's asset URL. Mounting the atom starts the read; unmounting it releases the bytes.
 * Upstream's asset URL also carries the image's header size, kept after the bytes are gone; here a
 * separate size atom reads the start of the file and keeps what the browser decodes.
 */
import type { ToolOutputImageResource } from "@t3tools/client-runtime/work-log/item-detail";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  ScreenshotArtifactId,
  type ScreenshotArtifactDimensions,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
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

// Coder: matches upstream's asset URL idle TTL, so a size outlives scrolling its row away.
const IMAGE_SIZE_IDLE_TTL_MS = 60 * 60_000;
/** Covers PNG, GIF, and WebP headers and a JPEG frame header after typical EXIF segments. */
const IMAGE_SIZE_PROBE_BYTES = 64 * 1024;

// The helper reads a size from a workspace image's header; formats it cannot parse, and other
// resources, wait for the browser's decoded size, which callers write back.
const imageSizeFamily = Atom.family((key: string) => {
  const [environmentId, resource] = JSON.parse(key) as [EnvironmentId, ImageAssetResource];
  return Atom.writable(
    (get): ScreenshotArtifactDimensions | null => {
      if (resource._tag === "project-image") {
        const read = commandReader(get.registry, projectEnvironment.readImage);
        let active = true;
        get.addFinalizer(() => {
          active = false;
        });
        void read({
          environmentId,
          input: { ...resource.target, offset: 0, limit: IMAGE_SIZE_PROBE_BYTES },
        }).then(
          (chunk) => {
            if (!active || !chunk.dimensions) return;
            // A size the browser decoded first is already the image's.
            if (Option.getOrNull(get.self<ScreenshotArtifactDimensions | null>()) !== null) return;
            get.setSelf(chunk.dimensions);
          },
          () => undefined,
        );
      }
      return null;
    },
    (ctx, size: ScreenshotArtifactDimensions) => ctx.setSelf(size),
  ).pipe(
    Atom.setIdleTTL(IMAGE_SIZE_IDLE_TTL_MS),
    Atom.withLabel(`environment-data:assets:image-size:${key}`),
  );
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
  imageSize: (target: {
    readonly environmentId: EnvironmentId;
    readonly resource: ImageAssetResource;
  }) => imageSizeFamily(JSON.stringify([target.environmentId, target.resource])),
};
