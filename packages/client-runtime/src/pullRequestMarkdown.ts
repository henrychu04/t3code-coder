/** `id` is positional on purpose: the same attachment can be embedded twice in one body. */
export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: "markdown"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "attachment";
      readonly url: string;
      /** Coder: names the upload's host (GitLab or a self-hosted install), not always GitHub. */
      readonly hostLabel: string;
      /**
       * What the reader can be told the upload is. The uuid says nothing on its own — the type
       * only appears in the signed redirect GitHub answers with — but the shape does: GitHub
       * writes a dropped image into the body as an `<img>` tag, so a bare attachment link on its
       * own line is what it does with a video. Anything else keeps the neutral name.
       */
      readonly media: "video" | "image" | "unknown";
    };

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$/u;
/**
 * How far a `<video>` tag may reach for its closing tag. Real embeds are one to three lines,
 * and the bound keeps an unclosed tag from making each one rescan the rest of the body.
 */
const VIDEO_TAG_MAX_LINES = 8;
/** Four spaces open an indented code block, so its contents stay verbatim markdown. */
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;
// Coder: GitLab writes uploads as root-relative `/uploads/…` links.
const BARE_URL_PATTERN = /^<?((?:https?:\/\/|\/uploads\/)\S+?)>?$/u;
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])/iu;
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
/** A dropped video becomes a bare asset link; a dropped image becomes an `<img>` tag. */
const GITHUB_ASSET_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;
/** Only a tag that owns its line is an embed; inline, it is prose the renderer should keep. */
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;

/** Anything else — `javascript:`, `data:`, a relative path — is not an upload to link out to. */
function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function resolveAttachmentUrl(url: string, hostUrl?: string | null): string | null {
  if (isWebUrl(url)) return url;
  if (!url.startsWith("/uploads/") || hostUrl == null || !isWebUrl(hostUrl)) return null;
  return new URL(url, hostUrl).href;
}

function attachmentHostLabel(url: string): string {
  const hostname = new URL(url).hostname.toLowerCase();
  if (hostname === "github.com") return "GitHub";
  if (hostname === "gitlab.com") return "GitLab";
  return hostname;
}

function attachmentFromLine(
  line: string,
  hostUrl?: string | null,
): { url: string; hostLabel: string; media: "video" | "image" | "unknown" } | null {
  const reference =
    BARE_URL_PATTERN.exec(line.trim())?.[1] ?? MARKDOWN_LINK_PATTERN.exec(line.trim())?.[1];
  if (reference === undefined) return null;
  const url = resolveAttachmentUrl(reference, hostUrl);
  if (url === null) return null;
  const hostLabel = attachmentHostLabel(url);
  if (VIDEO_EXTENSION_PATTERN.test(url) || GITHUB_ASSET_PATTERN.test(url)) {
    return { url, hostLabel, media: "video" };
  }
  if (IMAGE_EXTENSION_PATTERN.test(url)) return { url, hostLabel, media: "image" };
  // Coder: a GitLab upload of any other type still lifts out as a neutral attachment.
  if (reference.startsWith("/uploads/")) return { url, hostLabel, media: "unknown" };
  return null;
}

/**
 * Lifts standalone media links and video tags out of prose for both clients.
 * Ordinary links and code examples remain markdown. Images already embedded
 * with markdown or HTML keep their original renderer. Coder: GitLab's root-relative
 * `/uploads/…` form is resolved against the merge request host before it is exposed.
 */
export function splitPullRequestBody(
  body: string,
  hostUrl?: string | null,
): ReadonlyArray<PullRequestBodySegment> {
  const segments: PullRequestBodySegment[] = [];
  const markdown: string[] = [];
  let openFence: string | null = null;

  // Blank lines around a run are dropped, but never leading spaces: four of them open an
  // indented code block, so trimming a run would silently turn code into prose.
  const flushMarkdown = () => {
    const text = markdown.join("\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
    markdown.length = 0;
    if (text.trim().length > 0) {
      segments.push({ id: `markdown:${segments.length}`, kind: "markdown", text });
    }
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1]!;
      // A fence closes only on the same marker, at least as long as the one that opened it,
      // and with nothing after it: `~~~` cannot end a ``` block, and ```` ```ts ```` is an
      // info string opening a nested fence, not a close.
      const closes =
        openFence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        fenceMatch[2]!.trim().length === 0;
      if (openFence === null) {
        openFence = fence;
      } else if (closes) {
        openFence = null;
      }
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }

    const bareAttachment = attachmentFromLine(line, hostUrl);
    if (bareAttachment !== null) {
      flushMarkdown();
      segments.push({ id: `attachment:${segments.length}`, kind: "attachment", ...bareAttachment });
      continue;
    }

    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line);
      continue;
    }
    // A tag can span lines, so look ahead for its close — bounded, and without building the
    // joined text until one is actually found.
    const lastCandidate = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1;
    let cursor = index;
    while (cursor < lastCandidate && !VIDEO_TAG_END_PATTERN.test(lines[cursor]!)) {
      cursor += 1;
    }
    const sourceReference = VIDEO_TAG_END_PATTERN.test(lines[cursor]!)
      ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).join("\n"))?.[1]
      : undefined;
    const source =
      sourceReference === undefined ? null : resolveAttachmentUrl(sourceReference, hostUrl);
    if (source !== null) {
      flushMarkdown();
      segments.push({
        id: `attachment:${segments.length}`,
        kind: "attachment",
        url: source,
        hostLabel: attachmentHostLabel(source),
        // The author wrote the tag, so this one is a video whatever the URL looks like.
        media: "video",
      });
      index = cursor;
    } else {
      // Unclosed, or nothing linkable in it: prose. Only this line is consumed, so the
      // lines that were looked at are still parsed on their own terms.
      markdown.push(line);
    }
  }

  flushMarkdown();
  return segments;
}
