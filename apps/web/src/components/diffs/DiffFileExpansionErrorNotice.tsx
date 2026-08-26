export interface DiffFileExpansionError {
  readonly fileKey: string;
  readonly filePath: string;
  readonly maxBytes: number;
}

export function DiffFileExpansionErrorNotice({
  errors,
}: {
  readonly errors: ReadonlyArray<DiffFileExpansionError>;
}) {
  if (errors.length === 0) return null;
  return (
    <div
      role="status"
      className="max-h-24 shrink-0 overflow-auto border-b border-border/70 bg-error/5 px-3 py-1.5 text-[11px] text-error/90"
    >
      {errors.map((error) => (
        <p key={error.fileKey}>
          {error.filePath} is too large to expand ({error.maxBytes / (1024 * 1024)} MiB maximum).
        </p>
      ))}
    </div>
  );
}
