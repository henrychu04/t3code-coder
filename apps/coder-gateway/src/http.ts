// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

export const CODER_GATEWAY_HOST = "127.0.0.1";
const MAX_CONFIG_BODY_BYTES = 64 * 1024;

export const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>T3 Coder</title>
  </head>
  <body>
    <main>
      <h1>T3 Coder</h1>
      <p>The local gateway is ready.</p>
    </main>
  </body>
</html>`;

export function sendText(
  response: NodeHttp.ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
  cacheHeaders: Readonly<Record<string, string>> = { "Cache-Control": "no-store" },
): void {
  response.writeHead(statusCode, {
    ...cacheHeaders,
    "Content-Type": contentType,
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' 'sha256-n0OPhj7RDHbzPYmNVtzBFHdU5YSjXCbQBVoFS8BcmDQ='; connect-src 'self' blob: https: http: ws://127.0.0.1:*; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; worker-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

/**
 * Build outputs named in Vite's manifest, which carry a content hash. Like upstream's static
 * route, only these are cached as immutable: a hash-like name alone is not enough.
 */
export async function readImmutableBuildAssets(staticDir: string): Promise<ReadonlySet<string>> {
  try {
    const manifest = JSON.parse(
      await NodeFS.readFile(NodePath.join(staticDir, ".vite", "manifest.json"), "utf8"),
    ) as Record<string, { file?: unknown; css?: unknown; assets?: unknown }>;
    const files = Object.values(manifest).flatMap((entry) => [
      entry.file,
      ...(Array.isArray(entry.css) ? entry.css : []),
      ...(Array.isArray(entry.assets) ? entry.assets : []),
    ]);
    return new Set(files.filter((file): file is string => typeof file === "string"));
  } catch {
    return new Set();
  }
}

export async function serveStaticFile(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  staticDir: string,
  pathname: string,
  immutableBuildAssets: ReadonlySet<string>,
): Promise<boolean> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = NodePath.resolve(staticDir, relativePath);
  const root = `${NodePath.resolve(staticDir)}${NodePath.sep}`;
  if (!candidate.startsWith(root)) return false;
  try {
    const info = await NodeFS.stat(candidate);
    if (!info.isFile()) return false;
    const extension = NodePath.extname(candidate);
    const contentType = STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream";
    // HTML names the current bundle, so it is always revalidated in full.
    if (extension === ".html") {
      sendText(response, 200, contentType, await NodeFS.readFile(candidate), {
        "Cache-Control": "no-cache",
      });
      return true;
    }
    const assetPath = NodePath.relative(staticDir, candidate).replaceAll("\\", "/");
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    const cacheHeaders = {
      "Cache-Control": immutableBuildAssets.has(assetPath)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      ETag: etag,
    };
    const ifNoneMatch = request.headers["if-none-match"];
    if (
      ifNoneMatch !== undefined &&
      ifNoneMatch
        .split(",")
        .some(
          (value) => value.trim() === "*" || value.trim().replace(/^W\//i, "") === etag.slice(2),
        )
    ) {
      response.writeHead(304, cacheHeaders);
      response.end();
      return true;
    }
    sendText(response, 200, contentType, await NodeFS.readFile(candidate), cacheHeaders);
    return true;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EISDIR" && code !== "ENOTDIR") throw cause;
    return false;
  }
}

export function readJsonBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_CONFIG_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (cause) {
        reject(cause);
      }
    });
    request.once("error", reject);
  });
}

export function rejectWebSocketUpgrade(
  socket: Duplex,
  statusCode: number,
  statusText: string,
): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

export function isServerNotRunningError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ERR_SERVER_NOT_RUNNING"
  );
}
