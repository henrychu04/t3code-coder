/**
 * Coder: workspace images have no signed asset URLs. Each image is read through the helper's
 * bounded chunk reads and exposed as an in-memory object URL, so callers keep upstream's
 * `useAssetUrlState`, `useAssetUrlRefresh`, and `useAssetUrls` shapes. A refresh rereads the
 * image store's entry, and a read waiting for room in the store is `Loading` with `deferred`.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScreenshotArtifactDimensions } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import type { ImageResourceState } from "../components/chat/imageResources";
import { assetEnvironment, type ImageAssetResource } from "../state/assets";
import { useConnectedEnvironmentIds } from "../state/environments";

export { type AttachmentImageResource, isAttachmentImageMimeType } from "./attachmentImageResource";

export type AssetUrlState =
  | { readonly _tag: "Loading"; readonly deferred?: true }
  | { readonly _tag: "Failure" }
  | {
      readonly _tag: "Success";
      readonly url: string;
      readonly imageDimensions?: ScreenshotArtifactDimensions;
    };

const EMPTY_ASSET_URL_ATOM = Atom.make<ImageResourceState>({ status: "loading" }).pipe(
  Atom.withLabel("asset-url:empty"),
);
const LOADING: AssetUrlState = { _tag: "Loading" };
const DEFERRED: AssetUrlState = { _tag: "Loading", deferred: true };
const FAILURE: AssetUrlState = { _tag: "Failure" };
// Store states are replaced on every change, so each maps to one stable value.
const loadedStates = new WeakMap<ImageResourceState, AssetUrlState>();

function assetUrlStateFromImage(state: ImageResourceState): AssetUrlState {
  switch (state.status) {
    case "loading":
      return LOADING;
    case "deferred":
      return DEFERRED;
    case "error":
      return FAILURE;
    case "loaded": {
      let loaded = loadedStates.get(state);
      if (!loaded) {
        loaded = {
          _tag: "Success",
          url: state.url,
          ...(state.dimensions ? { imageDimensions: state.dimensions } : {}),
        };
        loadedStates.set(state, loaded);
      }
      return loaded;
    }
  }
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: ImageAssetResource | null,
  // Coder: the image the user opened displaces retained previews in the bounded store.
  options?: { readonly priority?: boolean },
): AssetUrlState {
  // Cached threads render before the workspace connects, so reads wait for the connection.
  const connectedIds = useConnectedEnvironmentIds();
  const result = useAtomValue(
    environmentId === null || resource === null || !connectedIds.includes(environmentId)
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({
          environmentId,
          input: { resource },
          priority: options?.priority,
        }),
  );
  return assetUrlStateFromImage(result);
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: ImageAssetResource | null,
): () => Promise<string | null> {
  const registry = useContext(RegistryContext);
  return async () => {
    if (environmentId === null || resource === null) return null;
    return rereadImage(
      registry,
      assetEnvironment.createUrl({ environmentId, input: { resource } }),
    );
  };
}

/**
 * Rereads a store entry and settles with its next object URL, which lives as long as the caller's
 * `useAssetUrlState` holds the image.
 */
function rereadImage(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<ImageResourceState>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (state: ImageResourceState) => {
      if (settled || (state.status !== "loaded" && state.status !== "error")) return;
      settled = true;
      unsubscribe();
      if (state.status === "loaded") resolve(state.url);
      else reject(new Error("The image could not be read."));
    };
    const unsubscribe = registry.subscribe(atom, settle);
    const current = registry.get(atom);
    if ("retry" in current) current.retry();
    settle(registry.get(atom));
  });
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<ImageAssetResource>,
): ReadonlyArray<string | null> {
  // Cached threads render before the workspace connects. Reads start once it is connected, and a
  // disconnect releases them so the next connection reads again instead of keeping a failure.
  const connected = useConnectedEnvironmentIds().includes(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: connected ? resources : [],
    }),
  );
  return resources.map((_resource, index) => {
    const result = results[index];
    return result?.status === "loaded" ? result.url : null;
  });
}
