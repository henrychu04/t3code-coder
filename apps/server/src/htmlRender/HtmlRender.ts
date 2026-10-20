/**
 * Coder: upstream's HTML render publishing without its headless-browser preview and height
 * measurement. T3 Coder downloads no preview browser, so pages publish at the agent's height and
 * the frame fits the page's own reported height, and `html_preview` is not carried. A page with
 * its images inlined is capped at the helper's bounded turn-item read.
 */
import { MAX_TURN_ITEM_ASSET_BYTES, type ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_MAX_TITLE_LENGTH,
  injectHtmlRenderBootstrap,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
// Coder: upstream allows 25 MiB; the helper reads a stored page through a 10 MiB bounded read.
const MAX_PAGE_BYTES = MAX_TURN_ITEM_ASSET_BYTES;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

export class HtmlRenderImagesNotFoundError extends Schema.TaggedError<HtmlRenderImagesNotFoundError>()(
  "HtmlRenderImagesNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These local images could not be read: ${this.paths.join(", ")}. Use absolute paths to existing image files, or remove them.`;
  }
}

export class HtmlRenderImageTooLargeError extends Schema.TaggedError<HtmlRenderImageTooLargeError>()(
  "HtmlRenderImageTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${formatMib(this.sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`;
  }
}

export class HtmlRenderPageTooLargeError extends Schema.TaggedError<HtmlRenderPageTooLargeError>()(
  "HtmlRenderPageTooLargeError",
  { sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `With its images inlined the page is ${formatMib(this.sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`;
  }
}

export class HtmlRenderViewportHeightError extends Schema.TaggedError<HtmlRenderViewportHeightError>()(
  "HtmlRenderViewportHeightError",
  { found: Schema.String },
) {
  override get message(): string {
    return `The page uses a viewport height unit (${this.found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`;
  }
}

// Only stylesheets and style attributes are checked, so page text that mentions
// a unit passes; comments match first so their contents are skipped. Scripts
// are still checked, since markup they insert applies. An unclosed comment,
// tag, or quote runs to the end of the page, which keeps both patterns linear
// on hostile input.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

const rejectViewportHeight = (html: string) => {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) return Effect.fail(new HtmlRenderViewportHeightError({ found }));
  }
  return Effect.void;
};

export class HtmlRenderStoreError extends Schema.TaggedError<HtmlRenderStoreError>()(
  "HtmlRenderStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The HTML render could not be saved.";
  }
}

export type HtmlRenderPrepareError =
  | HtmlRenderImagesNotFoundError
  | HtmlRenderImageTooLargeError
  | HtmlRenderPageTooLargeError
  | HtmlRenderViewportHeightError;

export class HtmlRender extends Context.Service<
  HtmlRender,
  {
    readonly prepare: (html: string) => Effect.Effect<string, HtmlRenderPrepareError>;
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly html: string;
      readonly title: string;
      readonly height: number;
    }) => Effect.Effect<HtmlRenderReference, HtmlRenderPrepareError | HtmlRenderStoreError>;
  }
>()("t3/htmlRender/HtmlRender") {}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
const ABSOLUTE_PATH = String.raw`(?:/(?!/)|[a-z]:[\\/])`;
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

const findLocalImages = (html: string) =>
  Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
const isImageBytes = (bytes: Uint8Array) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

const inlineLocalImages = Effect.fn("HtmlRender.inlineLocalImages")(function* (html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const references = findLocalImages(html);
  const files = yield* Effect.forEach(
    [...new Set(references.map((reference) => reference.path))],
    (path) =>
      fileSystem.stat(filePathFor(path)).pipe(
        Effect.map((info) => ({
          path,
          size: info.type === "File" ? Number(info.size) : undefined,
        })),
        Effect.orElseSucceed(() => ({ path, size: undefined })),
      ),
    { concurrency: 8 },
  );
  const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES);
  if (oversized?.size !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: oversized.path,
      sizeBytes: oversized.size,
    });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          Math.ceil(size / 3) * 4 -
          Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: pageBytes });
  }
  // Files can grow after `stat`. Each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  let readBytes = 0;
  const images = yield* Effect.forEach(
    files.filter((file) => file.size !== undefined),
    (file) =>
      Effect.gen(function* () {
        const read = yield* fileSystem
          .stream(filePathFor(file.path), { bytesToRead: MAX_IMAGE_BYTES + 1 })
          .pipe(Stream.mkUint8Array, Effect.option);
        if (Option.isNone(read) || !isImageBytes(read.value)) return [];
        const bytes = read.value;
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return yield* new HtmlRenderImageTooLargeError({
            path: file.path,
            sizeBytes: bytes.byteLength,
          });
        }
        readBytes += Math.ceil(bytes.byteLength / 3) * 4;
        if (readBytes > MAX_PAGE_BYTES) {
          return yield* new HtmlRenderPageTooLargeError({ sizeBytes: readBytes });
        }
        return [{ path: file.path, bytes }];
      }),
    { concurrency: 4 },
  ).pipe(Effect.map((entries) => entries.flat()));
  const dataUris = new Map(
    images.map(
      (image) =>
        [
          image.path,
          dataUriPrefix(image.path) + Buffer.from(image.bytes).toString("base64"),
        ] as const,
    ),
  );
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: inlinedBytes });
  }
  return {
    html: inlined,
    missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path),
  };
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const services = yield* Effect.context<FileSystem.FileSystem>();

  // The bootstrap goes in first so its head scan never runs over inlined image data.
  const inline = (html: string) =>
    inlineLocalImages(injectHtmlRenderBootstrap(html)).pipe(Effect.provideContext(services));

  const prepare = Effect.fn("HtmlRender.prepare")(function* (html: string) {
    yield* rejectViewportHeight(html);
    const inlined = yield* inline(html);
    if (inlined.missing.length > 0) {
      return yield* new HtmlRenderImagesNotFoundError({ paths: inlined.missing });
    }
    return inlined.html;
  });

  const publish = Effect.fn("HtmlRender.publish")(function* (input: {
    readonly threadId: ThreadId;
    readonly html: string;
    readonly title: string;
    readonly height: number;
  }) {
    const html = yield* prepare(input.html);
    // The `-html` id suffix makes the asset route serve it as a sandboxed text/html document.
    const attachmentId = createAttachmentId(input.threadId, "html");
    const filePath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          });
    if (attachmentId === null || filePath === null) {
      return yield* new HtmlRenderStoreError({ cause: new Error("Invalid thread id.") });
    }
    const reference: HtmlRenderReference = {
      attachmentId,
      title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
      height: clampHtmlRenderHeight(input.height),
    };
    return yield* fileSystem.writeFileString(filePath, html).pipe(
      Effect.mapError((cause) => new HtmlRenderStoreError({ cause })),
      Effect.uninterruptible,
      Effect.andThen(mcpSessions.recordHtmlRender(input.threadId, input, reference)),
      Effect.as(reference),
      // An interrupted publish must leave neither an attachment nor a recoverable reference.
      Effect.onError(() =>
        Effect.all(
          [
            fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore),
            mcpSessions.takeHtmlRender(input.threadId, input, reference).pipe(Effect.ignore),
          ],
          { discard: true },
        ),
      ),
    );
  });

  return HtmlRender.of({ prepare, publish });
});

export const layer = Layer.effect(HtmlRender, make);
