import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

export interface CoderWorkspaceEnvironment {
  readonly workspaceId: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

let environments: readonly CoderWorkspaceEnvironment[] = [];
let workspaceOrder: readonly string[] = [];
const listeners = new Set<() => void>();

function sortEnvironments(
  values: readonly CoderWorkspaceEnvironment[],
): readonly CoderWorkspaceEnvironment[] {
  const order = new Map(workspaceOrder.map((workspaceId, index) => [workspaceId, index] as const));
  return [...values].sort(
    (left, right) =>
      (order.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function readCoderWorkspaceEnvironments(): readonly CoderWorkspaceEnvironment[] {
  return environments;
}

export function coderWorkspaceIdForEnvironment(environmentId: string): string | null {
  return (
    environments.find((entry) => entry.descriptor.environmentId === environmentId)?.workspaceId ??
    null
  );
}

export function setCoderWorkspaceEnvironment(
  workspaceId: string,
  descriptor: ExecutionEnvironmentDescriptor,
): void {
  const next = environments.filter((entry) => entry.workspaceId !== workspaceId);
  environments = sortEnvironments([...next, { workspaceId, descriptor }]);
  for (const listener of listeners) listener();
}

export function setCoderWorkspaceOrder(workspaceIds: readonly string[]): void {
  workspaceOrder = workspaceIds;
  const allowed = new Set(workspaceIds);
  environments = sortEnvironments(environments.filter((entry) => allowed.has(entry.workspaceId)));
  for (const listener of listeners) listener();
}

export function removeCoderWorkspaceEnvironment(workspaceId: string): void {
  const next = environments.filter((entry) => entry.workspaceId !== workspaceId);
  if (next.length === environments.length) return;
  environments = next;
  for (const listener of listeners) listener();
}

export function subscribeCoderWorkspaceEnvironments(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
