const NIGHTLY_SERVER_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly serverVersions: ReadonlyArray<string | null | undefined>;
  readonly fallbackStageLabel: string;
}): string {
  return input.serverVersions.some(
    (serverVersion) =>
      serverVersion !== null &&
      serverVersion !== undefined &&
      NIGHTLY_SERVER_VERSION_PATTERN.test(serverVersion),
  )
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly serverVersions: ReadonlyArray<string | null | undefined>;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    serverVersions: input.serverVersions,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
