import {
  MAX_SCREENSHOT_ARTIFACTS_PER_TURN,
  type ProviderRuntimeEvent,
  type ScreenshotArtifactReference,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { CapturedScreenshotArtifact } from "./ScreenshotArtifacts.ts";

export interface ScreenshotCaptureOptions {
  readonly observeScreenshots?: (cwd: string) => Effect.Effect<{
    readonly close: () => ReadonlyArray<string>;
  }>;
  readonly captureScreenshotFile?: (input: {
    readonly cwd: string;
    readonly filePath: string;
    readonly capturedArtifacts?: ReadonlyMap<string, ScreenshotArtifactReference>;
    readonly capturedDigests: ReadonlySet<string>;
  }) => Effect.Effect<CapturedScreenshotArtifact | undefined>;
  readonly captureScreenshotBase64?: (input: {
    readonly dataBase64: string;
    readonly mimeType: string;
    readonly name?: string;
    readonly capturedDigests: ReadonlySet<string>;
  }) => Effect.Effect<CapturedScreenshotArtifact | undefined>;
}

export interface ScreenshotImageInput {
  readonly dataBase64: string;
  readonly mimeType: string;
  readonly name?: string;
}

type ArtifactPayload = Extract<ProviderRuntimeEvent, { type: "item.completed" }>["payload"];

/** One provider turn owns observation, limits, deduplication, and publication. */
export const makeTurnScreenshotCapture = Effect.fn("makeTurnScreenshotCapture")(function* (
  cwd: string | undefined,
  options?: ScreenshotCaptureOptions,
) {
  const observation =
    cwd && options?.observeScreenshots ? yield* options.observeScreenshots(cwd) : undefined;
  const lock = yield* Semaphore.make(1);
  const artifacts: ScreenshotArtifactReference[] = [];
  const capturedDigests = new Set<string>();
  const capturedArtifacts = new Map<string, ScreenshotArtifactReference>();
  let closed = false;
  const append = (captured: CapturedScreenshotArtifact | undefined) => {
    if (!captured) return;
    const existing = capturedArtifacts.get(captured.digest);
    if (!existing && artifacts.length >= MAX_SCREENSHOT_ARTIFACTS_PER_TURN) return;
    capturedArtifacts.set(captured.digest, captured.reference);
    if (existing) {
      artifacts[artifacts.findIndex((artifact) => artifact.id === existing.id)] =
        captured.reference;
      return;
    }
    capturedDigests.add(captured.digest);
    artifacts.push(captured.reference);
  };
  // Also used by scope finalizers when a turn fails before it can be published.
  const dispose = () => {
    if (closed) return;
    closed = true;
    observation?.close();
  };
  const captureImages = (images: ReadonlyArray<ScreenshotImageInput>) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (closed || !options?.captureScreenshotBase64) return;
        for (const image of images) {
          if (closed || artifacts.length >= MAX_SCREENSHOT_ARTIFACTS_PER_TURN) break;
          append(yield* options.captureScreenshotBase64({ ...image, capturedDigests }));
        }
      }),
    );
  const finish = lock.withPermit(
    Effect.gen(function* (): Effect.fn.Return<ArtifactPayload | undefined> {
      if (closed) return;
      closed = true;
      const paths = observation?.close() ?? [];
      if (cwd && options?.captureScreenshotFile) {
        // Even at the image cap, observed duplicates can add source keys without storing bytes.
        for (const filePath of paths) {
          append(
            yield* options.captureScreenshotFile({
              cwd,
              filePath,
              capturedDigests,
              capturedArtifacts,
            }),
          );
        }
      }
      if (artifacts.length === 0) return;
      return {
        itemType: "image_view",
        status: "completed",
        title: "Visual artifacts",
        detail: `${artifacts.length} screenshot${artifacts.length === 1 ? "" : "s"}`,
        artifacts: [...artifacts],
      };
    }),
  );
  return { captureImages, finish, dispose };
});

export type TurnScreenshotCapture = Effect.Success<ReturnType<typeof makeTurnScreenshotCapture>>;
