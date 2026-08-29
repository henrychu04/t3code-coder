import type { ProviderDriverKind } from "@t3tools/contracts";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;

export function slugifyProviderInstanceLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

export function deriveProviderInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyProviderInstanceLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

export function validateProviderInstanceId(
  instanceId: string,
  reservedIds: ReadonlySet<string>,
): string | null {
  const trimmed = instanceId.trim();
  if (trimmed.length === 0) return "Instance ID is required.";
  if (trimmed.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(trimmed)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (reservedIds.has(trimmed)) return `An instance named '${trimmed}' already exists.`;
  return null;
}

export function providerInstanceFallbackLabel(instanceId: string): string {
  return instanceId
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
