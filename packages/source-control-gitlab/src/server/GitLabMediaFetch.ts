import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { gitLabMediaApiEndpoint } from "../shared/gitLabMedia.ts";

/** `glab api` hands over a whole upload at once, so this bounds the workspace's memory per file. */
export const GITLAB_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const GITLAB_MEDIA_TIMEOUT_MS = 60_000;
// An MR with many screenshots would otherwise start a `glab` for each at once.
const GITLAB_MEDIA_CONCURRENCY = { key: "GitLabMediaFetch", limit: 4 } as const;

/**
 * Coder: reads an upload through the API with `glab`, run in the repository the media was minted
 * for and without `--hostname`, so the credential goes only to the host `glab` already uses there.
 */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const respond = (status: number, body: Uint8Array<ArrayBuffer> | null = null) =>
      HttpClientResponse.fromWeb(
        HttpClientRequest.get(request.url),
        new Response(body, {
          status,
          headers: body === null ? {} : { "content-length": String(body.byteLength) },
        }),
      );
    const endpoint = gitLabMediaApiEndpoint(request.url);
    if (endpoint === null) return respond(404);
    const chunks: Uint8Array[] = [];
    const output = yield* process
      .run({
        operation: "GitLabMediaFetch.fetchMedia",
        command: "glab",
        args: ["api", endpoint],
        cwd: request.cwd,
        timeoutMs: GITLAB_MEDIA_TIMEOUT_MS,
        maxOutputBytes: GITLAB_MEDIA_MAX_BYTES,
        concurrency: GITLAB_MEDIA_CONCURRENCY,
        onStdoutChunk: (chunk) => chunks.push(chunk),
      })
      .pipe(
        Effect.tapError((cause) => Effect.logWarning("Failed to fetch GitLab media.", { cause })),
        Effect.option,
      );
    if (output._tag === "None") return respond(404);
    if (output.value.stdoutTruncated) return respond(413);
    return respond(200, Buffer.concat(chunks));
  });
});
