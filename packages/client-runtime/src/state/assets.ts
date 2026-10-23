import {
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type AssetImageDimensions,
  AssetResource,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export class InvalidAssetCollectionKeyError extends Schema.TaggedError<InvalidAssetCollectionKeyError>()(
  "InvalidAssetCollectionKeyError",
  {
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid asset collection atom key: ${JSON.stringify(this.key)}.`;
  }
}

const decodeAssetCollectionKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.Array(AssetResource)]),
);

function parseAssetCollectionKey(
  key: string,
): readonly [EnvironmentId, ReadonlyArray<AssetResource>] {
  try {
    return decodeAssetCollectionKey(JSON.parse(key));
  } catch (cause) {
    throw new InvalidAssetCollectionKeyError({ key, cause });
  }
}

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    // Coder: a workspace's `httpBaseUrl` is its gateway path (`/api/workspaces/<id>/`), so the
    // server's root-relative asset URL resolves below it.
    return new URL(relativeUrl.replace(/^\/+/, ""), httpBaseUrl).toString();
  } catch {
    return null;
  }
}

export const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("asset-url:empty"),
);

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | {
      readonly _tag: "Failure";
      readonly reason?: "missing-file-access";
    }
  | {
      readonly _tag: "Success";
      readonly url: string;
      readonly expiresAt: number;
      readonly sourcePath?: string;
      readonly imageDimensions?: AssetImageDimensions;
      readonly fileRevision?: string;
    };

export const MISSING_FILE_ACCESS_MESSAGE =
  "This connection cannot read host files. Pair again with a new link to view it.";

export function blockedAssetUrlState(
  resource: AssetResource | null,
  fileAccess: {
    readonly canReadFiles: boolean;
    readonly isPending: boolean;
    readonly error: string | null;
  },
): AssetUrlState | null {
  if (
    resource === null ||
    fileAccess.canReadFiles ||
    (resource._tag !== "workspace-file" &&
      resource._tag !== "media-file" &&
      resource._tag !== "draft-workspace-file")
  ) {
    return null;
  }
  if (fileAccess.isPending) return { _tag: "Loading" };
  return fileAccess.error === null
    ? { _tag: "Failure", reason: "missing-file-access" }
    : { _tag: "Failure" };
}

export function assetUrlStateFromResult(
  result: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
  httpBaseUrl: string | null,
): AssetUrlState {
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (httpBaseUrl === null || result._tag !== "Success") return { _tag: "Loading" };
  const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    expiresAt: result.value.expiresAt,
    ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
    ...(result.value.imageDimensions !== undefined
      ? { imageDimensions: result.value.imageDimensions }
      : {}),
    ...(result.value.fileRevision !== undefined ? { fileRevision: result.value.fileRevision } : {}),
  };
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  localMediaEnvironment?: Atom.Atom<{
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
  } | null>,
) {
  const execute = Effect.fn("assets.createUrl")(function* (input: AssetCreateUrlInput) {
    const result = yield* request(WS_METHODS.assetsCreateUrl, input).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    const error = result.failure;
    const resource = input.resource;
    const local = localMediaEnvironment
      ? (yield* AtomRegistry.AtomRegistry).get(localMediaEnvironment)
      : null;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    if (
      !local ||
      local.environmentId === supervisor.target.environmentId ||
      !(
        error._tag === "AssetWorkspaceAssetNotFoundError" ||
        error._tag === "AssetWorkspaceAssetInspectionError" ||
        error._tag === "AssetWorkspaceContextNotFoundError"
      ) ||
      resource._tag !== "media-file" ||
      !(resource.path.startsWith("/") || isWindowsAbsolutePath(resource.path)) ||
      mediaMimeTypeFromExtension(resource.path.slice(resource.path.lastIndexOf("."))) === null
    )
      return yield* error;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    // Map the full cause so retry defects and interruption survive.
    const asset = yield* registry
      .run(local.environmentId, request(WS_METHODS.assetsCreateUrl, input))
      .pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, () => error))));
    return { ...asset, relativeUrl: new URL(asset.relativeUrl, local.httpBaseUrl).href };
  });
  const createUrl = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:assets:create-url",
    execute,
    staleTimeMs: ASSET_URL_STALE_TIME_MS,
    idleTtlMs: ASSET_URL_IDLE_TTL_MS,
    refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
    refreshTrigger: ({ input }) =>
      input.resource._tag === "media-file" ? localMediaEnvironment : undefined,
  });
  const createUrlsFamily = Atom.family((key: string) => {
    const [environmentId, resources] = parseAssetCollectionKey(key);
    return Atom.make((get) =>
      resources.map((resource) =>
        get(
          createUrl({
            environmentId,
            input: { resource },
          }),
        ),
      ),
    ).pipe(
      Atom.setIdleTTL(ASSET_URL_IDLE_TTL_MS),
      Atom.withLabel(`environment-data:assets:create-urls:${key}`),
    );
  });

  return {
    createUrl,
    createUrls: (target: {
      readonly environmentId: EnvironmentId;
      readonly resources: ReadonlyArray<AssetResource>;
    }) => createUrlsFamily(JSON.stringify([target.environmentId, target.resources])),
  };
}

// Coder: project favicons are not carried.
