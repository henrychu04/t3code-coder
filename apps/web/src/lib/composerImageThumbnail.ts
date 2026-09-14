const thumbnails = new WeakMap<File, Promise<Blob | null>>();

/** Small, memory-only tile; the original file remains the upload and gallery source. */
export function createComposerImageThumbnail(file: File): Promise<Blob | null> {
  const cached = thumbnails.get(file);
  if (cached) return cached;
  const pending = (async () => {
    if (typeof createImageBitmap === "undefined" || typeof document === "undefined") return null;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file);
      const side = Math.min(bitmap.width, bitmap.height);
      if (side <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = Math.min(256, side);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } catch {
      return null;
    } finally {
      bitmap?.close();
    }
  })();
  thumbnails.set(file, pending);
  return pending;
}
