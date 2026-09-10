import {
  MAX_SCREENSHOT_ARTIFACTS_PER_TURN,
  MAX_SCREENSHOT_ARTIFACT_BYTES,
  type ProviderRuntimeEvent,
  type ScreenshotArtifactReference,
} from "@t3tools/contracts";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type { CapturedScreenshotArtifact } from "./ScreenshotArtifacts.ts";

export interface ScreenshotCaptureOptions {
  readonly captureScreenshotFile?: (input: {
    readonly cwd: string;
    readonly filePath: string;
    readonly existingOnly?: boolean;
    readonly sourceArtifact?: CapturedScreenshotArtifact;
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

/** One provider turn owns capture, limits, deduplication, and activity references. */
export const makeTurnScreenshotCapture = Effect.fn("makeTurnScreenshotCapture")(function* (
  cwd: string | undefined,
  options?: ScreenshotCaptureOptions,
) {
  const lock = yield* Semaphore.make(1);
  const capturedArtifacts = new Map<string, ScreenshotArtifactReference>();
  const capturedDigests = new Set<string>();
  let closed = false;
  const remember = (captured: CapturedScreenshotArtifact | undefined) => {
    if (!captured) return undefined;
    // Deduplicate bytes, not observations: a later activity must not inherit old paths.
    const { sourcePathKeys: _paths, ...storedReference } = captured.reference;
    capturedArtifacts.set(captured.digest, storedReference);
    capturedDigests.add(captured.digest);
    return captured.reference;
  };
  // Capture on the tool event, never by watching unrelated filesystem changes.
  const capture = (images: ReadonlyArray<ScreenshotImageInput>, filePath?: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const artifacts: ScreenshotArtifactReference[] = [];
        let imageCaptureWarning: string | undefined;
        const accept = (reference: ScreenshotArtifactReference | undefined) => {
          if (reference) {
            if (!artifacts.some((artifact) => artifact.id === reference.id))
              artifacts.push(reference);
          } else {
            imageCaptureWarning =
              capturedDigests.size >= MAX_SCREENSHOT_ARTIFACTS_PER_TURN
                ? "Image limit reached. Additional images were not preserved."
                : "Image could not be preserved.";
          }
        };
        if (closed) return { artifacts, imageCaptureWarning: "Image capture has ended." };
        for (const image of images) {
          if (closed) break;
          if (image.dataBase64.length > Math.ceil(MAX_SCREENSHOT_ARTIFACT_BYTES / 3) * 4 + 4) {
            accept(undefined);
            continue;
          }
          const digest = createHash("sha256")
            .update(Buffer.from(image.dataBase64, "base64"))
            .digest("hex");
          const existing = capturedArtifacts.get(digest);
          accept(
            existing ??
              (capturedDigests.size < MAX_SCREENSHOT_ARTIFACTS_PER_TURN &&
              options?.captureScreenshotBase64
                ? remember(yield* options.captureScreenshotBase64({ ...image, capturedDigests }))
                : undefined),
          );
        }
        if (filePath && images.length === 0) {
          accept(
            cwd && options?.captureScreenshotFile
              ? remember(
                  yield* options.captureScreenshotFile({
                    cwd,
                    filePath,
                    capturedDigests,
                    capturedArtifacts,
                  }),
                )
              : undefined,
          );
        }
        // A single tool image can be resized/re-encoded relative to its source. Preserve
        // those returned bytes and associate only the current validated path observation.
        // Multiple returned images remain ambiguous unless the file digest matches one.
        if (filePath && images.length > 0 && cwd && options?.captureScreenshotFile) {
          const source =
            images.length === 1 && artifacts.length === 1
              ? [...capturedArtifacts].find(([, reference]) => reference.id === artifacts[0]!.id)
              : undefined;
          const linked = yield* options.captureScreenshotFile({
            cwd,
            filePath,
            capturedDigests,
            capturedArtifacts,
            existingOnly: true,
            ...(source ? { sourceArtifact: { digest: source[0], reference: source[1] } } : {}),
          });
          if (linked && artifacts.some((artifact) => artifact.id === linked.reference.id)) {
            remember(linked);
            artifacts[artifacts.findIndex((artifact) => artifact.id === linked.reference.id)] =
              linked.reference;
          }
        }
        return { artifacts, ...(imageCaptureWarning ? { imageCaptureWarning } : {}) };
      }),
    );
  const dispose = () => {
    closed = true;
  };
  const finish: Effect.Effect<ArtifactPayload | undefined> = lock.withPermit(
    Effect.sync(() => {
      dispose();
      return undefined;
    }),
  );
  return { captureImages: capture, finish, dispose };
});

export type TurnScreenshotCapture = Effect.Success<ReturnType<typeof makeTurnScreenshotCapture>>;
