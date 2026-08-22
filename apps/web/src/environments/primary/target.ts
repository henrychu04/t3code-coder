import * as Schema from "effect/Schema";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export class PrimaryEnvironmentUrlInvalidError extends Schema.TaggedErrorClass<PrimaryEnvironmentUrlInvalidError>()(
  "PrimaryEnvironmentUrlInvalidError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not resolve the local Coder gateway URL.";
  }
}

export class PrimaryEnvironmentProtocolUnsupportedError extends Schema.TaggedErrorClass<PrimaryEnvironmentProtocolUnsupportedError>()(
  "PrimaryEnvironmentProtocolUnsupportedError",
  { protocol: Schema.String },
) {
  override get message(): string {
    return `The local Coder gateway uses unsupported protocol ${this.protocol}.`;
  }
}

export interface PrimaryEnvironmentTarget {
  readonly source: "window-origin";
  readonly target: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(
    hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1"),
  );
}

export function isPrimaryEnvironmentUrlInvalidError(
  value: unknown,
): value is PrimaryEnvironmentUrlInvalidError {
  return Schema.is(PrimaryEnvironmentUrlInvalidError)(value);
}

export function isPrimaryEnvironmentProtocolUnsupportedError(
  value: unknown,
): value is PrimaryEnvironmentProtocolUnsupportedError {
  return Schema.is(PrimaryEnvironmentProtocolUnsupportedError)(value);
}

export function isDesktopEnvironmentBootstrapIncompleteError(): false {
  return false;
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget {
  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch (cause) {
    throw new PrimaryEnvironmentUrlInvalidError({ cause });
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new PrimaryEnvironmentUrlInvalidError({
      cause: new Error("T3 Coder only runs on the loopback interface."),
    });
  }
  const workspaceId = url.searchParams.get("workspace");
  if (!workspaceId) {
    throw new PrimaryEnvironmentUrlInvalidError({
      cause: new Error("No Coder workspace was selected."),
    });
  }
  const httpBaseUrl = url.origin;
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else {
    throw new PrimaryEnvironmentProtocolUnsupportedError({ protocol: url.protocol });
  }
  url.pathname = `/api/workspaces/${encodeURIComponent(workspaceId)}/rpc`;
  url.search = "";
  url.hash = "";
  return {
    source: "window-origin",
    target: { httpBaseUrl, wsBaseUrl: url.toString() },
  };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const url = new URL(pathname, readPrimaryEnvironmentTarget().target.httpBaseUrl);
  if (searchParams) url.search = new URLSearchParams(searchParams).toString();
  return url.toString();
}
