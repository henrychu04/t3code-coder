// Upstream display formatting, shared by the Coder image chips.
export function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(sizeBytes / 1024))} KB`;
}

export function formatAttachmentUploadProgress(progress: number): string {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return `${Math.floor(bounded * 100)}%`;
}

/** User-facing rejection for a file over the effective upload limit. */
export function fileAttachmentTooLargeMessage(name: string, maxUploadBytes: number): string {
  const maxUploadSize =
    maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
      ? `${maxUploadBytes / (1024 * 1024)} MB`
      : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
        ? `${maxUploadBytes / 1024} KB`
        : `${maxUploadBytes} ${maxUploadBytes === 1 ? "byte" : "bytes"}`;
  return `'${name}' exceeds the ${maxUploadSize} attachment limit.`;
}
