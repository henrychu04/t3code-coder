import type { SourceControlMediaUrl } from "@t3tools/source-control-core/shared/definition";

/**
 * Coder: GitLab serves Markdown uploads only to a signed-in session, so a browser with none gets
 * a 404. Each spelling of an upload, below the project's path, below its numeric id, or the API
 * route itself, maps to that API route, which reads it with `glab`'s credential.
 */
const PROJECT_PATH_UPLOAD_PATTERN = /^\/((?:[^/]+\/)*[^/]+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/u;
const PROJECT_ID_UPLOAD_PATTERN = /^\/-\/project\/(\d+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/u;
const API_UPLOAD_PATTERN = /^\/api\/v4\/projects\/([^/]+)\/uploads\/([0-9a-f]{32})\/([^/]+)$/u;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function fileName(encoded: string): string {
  const name = (decode(encoded) ?? encoded).replace(/[\p{Cc}\\/]/gu, "");
  return name.length > 0 ? name : "gitlab-upload";
}

function projectFromPath(path: string): string | null {
  const segments = path.split("/");
  // `/-/` routes, the API, and group uploads are not project uploads.
  if (segments.includes("-") || segments[0] === "api" || segments[0] === "groups") return null;
  const decoded = decode(path);
  return decoded === null ? null : encodeURIComponent(decoded);
}

export function gitLabMediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const byApi = API_UPLOAD_PATTERN.exec(url.pathname);
  const byId = byApi ?? PROJECT_ID_UPLOAD_PATTERN.exec(url.pathname);
  const match = byId ?? PROJECT_PATH_UPLOAD_PATTERN.exec(url.pathname);
  if (!match) return null;
  const project = byId ? match[1]! : projectFromPath(match[1]!);
  if (project === null) return null;
  return {
    fetchUrl: `${url.protocol}//${url.host}/api/v4/projects/${project}/uploads/${match[2]}/${match[3]}`,
    fileName: fileName(match[3]!),
  };
}

/** The `glab api` endpoint for a `fetchUrl` `gitLabMediaUrl` returned. Null for any other URL. */
export function gitLabMediaApiEndpoint(fetchUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(fetchUrl);
  } catch {
    return null;
  }
  const match = API_UPLOAD_PATTERN.exec(url.pathname);
  return match ? `projects/${match[1]}/uploads/${match[2]}/${match[3]}` : null;
}
