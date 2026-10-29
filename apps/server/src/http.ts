// Coder: upstream's asset and attachment upload routes only. The helper opens no listener; the
// gateway forwards each `/api/assets/*` and `/api/attachments/upload/*` request to it over
// `coder.serveAsset` (see `coderAssets.ts`). Upstream's other HTTP routes are not carried.
import * as Mime from "effect/http/Mime";
import { injectMcpAppCookieBootstrap, injectMcpAppThemeBootstrap } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import { HttpRouter, HttpServerResponse, HttpServerRequest } from "effect/http";

import { ASSET_ROUTE_PREFIX, readMcpAppHtml, resolveAsset } from "./assets/AssetAccess.ts";
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";

const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
// Opaque origin blocks cookies, storage and API access while allowing scripts.
// Agent HTML can open without a click, so disallow blocking modals.
const HTML_CONTENT_SECURITY_POLICY =
  "sandbox allow-scripts allow-forms allow-popups allow-downloads";

// Proxies may strip disposition; force document-capable downloads to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineMediaMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && /^(?:audio|video)\//i.test(mimeType);
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

export function assetResponseHeaders(
  filePath: string,
  options?: {
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
  },
): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const inlineMimeType = options?.mimeType?.split(";", 1)[0]?.trim();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(options?.download
      ? {
          "Content-Disposition": downloadContentDisposition(options.fileName),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type":
            options.mimeType !== undefined && isSafeDownloadMimeType(options.mimeType)
              ? options.mimeType
              : "application/octet-stream",
        }
      : inlineMimeType !== undefined && isSafeInlineMediaMimeType(inlineMimeType)
        ? { "Content-Type": inlineMimeType }
        : inlineMimeType !== undefined && isSafeInlineDocumentMimeType(inlineMimeType)
          ? {
              "Content-Type":
                inlineMimeType.toLowerCase() === "text/html"
                  ? "text/html; charset=utf-8"
                  : "application/pdf",
              ...(inlineMimeType.toLowerCase() === "text/html"
                ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
                : {}),
            }
          : lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
            ? {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
              }
            : {}),
    ...(!options?.download && lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

function assetByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
    readonly renderIntent?: "mcp-app";
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  if (
    asset.renderIntent === "mcp-app" &&
    !asset.download &&
    headers["Content-Type"] === "text/html; charset=utf-8"
  ) {
    const bytes = yield* readMcpAppHtml(asset.path);
    if (bytes === null) {
      return HttpServerResponse.text("MCP app is too large to preview.", { status: 413 });
    }
    const body = pipe(
      new TextDecoder().decode(bytes),
      injectMcpAppThemeBootstrap,
      injectMcpAppCookieBootstrap,
      (html) => new TextEncoder().encode(html),
    );
    headers["Content-Length"] = String(body.byteLength);
    return method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.uint8Array(body, { headers });
  }
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isMedia = /^(?:audio|video)\//i.test(headers["Content-Type"] ?? "");
  if (isMedia) {
    // Without file identity, validators cannot guarantee byte equality; attachments must also expire with their URL.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Option.getOrElse(
      Mime.getType(asset.path),
      () => "application/octet-stream",
    );
    headers["Content-Length"] = String(size);
    if (!isMedia) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

export const layerAssetRoute = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (asset.kind === "bytes") {
      return HttpServerResponse.uint8Array(asset.bytes, {
        contentType: asset.mimeType,
        headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
      });
    }
    return yield* assetFileResponse(
      asset,
      request.method === "GET" ? request.headers.range : undefined,
      request.headers["if-range"],
      request.method === "HEAD" ? "HEAD" : "GET",
    ).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const layerAttachmentUploadRoute = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);
