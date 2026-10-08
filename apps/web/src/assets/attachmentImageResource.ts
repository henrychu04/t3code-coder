import { ScreenshotArtifactMimeType, type ScreenshotArtifactReference } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Media types the helper serves for submitted images. */
export const isAttachmentImageMimeType = Schema.is(ScreenshotArtifactMimeType);

/** A submitted image the helper reads by attachment id. */
export interface AttachmentImageResource {
  readonly _tag: "attachment";
  readonly attachmentId: string;
  readonly mimeType: ScreenshotArtifactReference["mimeType"];
  readonly sizeBytes?: number | undefined;
}
