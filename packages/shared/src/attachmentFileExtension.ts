/**
 * Coder: the stored extension of a composer file attachment, derived from its name exactly as the
 * workspace helper's `attachmentFileExtension` derives it, so the gateway can stage an upload
 * under the path the helper's claim expects. Unusual extensions fall back to `.bin`.
 */
export function attachmentFileExtension(fileName: string): string {
  const baseName = fileName.slice(fileName.lastIndexOf("/") + 1);
  const dotIndex = baseName.lastIndexOf(".");
  const extension = dotIndex <= 0 ? "" : baseName.slice(dotIndex).toLowerCase();
  // ".part" is reserved for in-flight uploads.
  if (extension === ".part" || !/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return ".bin";
  }
  return extension;
}
