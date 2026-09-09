import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

/** Image bytes and upload state belong to the browser's in-memory draft. */
export type ComposerPastedImage = {
  readonly id: string;
  readonly file: File;
  readonly workspaceId: string;
} & (
  | { readonly status: "queued" }
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "uploaded"; readonly path: string }
);

export const EMPTY_PASTED_IMAGES: ReadonlyArray<ComposerPastedImage> = Object.freeze([]);

export function pastedImageSendBlockReason(
  images: ReadonlyArray<ComposerPastedImage>,
): string | null {
  if (images.some((image) => image.status === "failed"))
    return "Retry or remove failed image uploads before sending.";
  if (images.some((image) => image.status !== "uploaded"))
    return "Wait for image uploads to finish.";
  return null;
}

/** Keep workspace references out of the editor; add them at the send boundary. */
export function appendPastedImagesToPrompt(
  prompt: string,
  images: ReadonlyArray<ComposerPastedImage>,
): string {
  const blocked = pastedImageSendBlockReason(images);
  if (blocked) throw new Error(blocked);
  if (images.length === 0) return prompt;
  const links = images.flatMap((image) =>
    image.status === "uploaded" ? [serializeComposerFileLink(image.path)] : [],
  );
  return [prompt, links.join(" ")].filter((part) => part.length > 0).join("\n\n");
}
