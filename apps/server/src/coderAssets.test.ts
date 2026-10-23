import * as NodeServices from "@effect/platform-node/NodeServices";
import { CODER_ASSET_BODY_CHUNK_BYTES, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { makeServeAsset } from "./coderAssets.ts";
import * as ServerConfig from "./config.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-coder-assets-test-",
});
const layerTest = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(null) }),
  layerConfig,
  WorkspacePaths.layer,
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(NodeServices.layer));

const serve = (input: Parameters<Effect.Success<typeof makeServeAsset>>[0]) =>
  Effect.gen(function* () {
    const serveAsset = yield* makeServeAsset;
    const parts = yield* Stream.runCollect(serveAsset(input));
    const [head, ...body] = parts;
    if (head?._tag !== "head") throw new Error("Expected the response head first.");
    return {
      head,
      chunks: body.map((part) => {
        if (part._tag !== "body") throw new Error("Expected only body parts after the head.");
        return Buffer.from(part.dataBase64, "base64");
      }),
    };
  });

const issueMediaFile = (contents: Uint8Array | string, name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-coder-assets-" });
    const filePath = path.join(directory, name);
    if (typeof contents === "string") yield* fs.writeFileString(filePath, contents);
    else yield* fs.writeFile(filePath, contents);
    return yield* issueAssetUrl({
      resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
    });
  });

describe("coder.serveAsset", () => {
  it.effect("streams a signed asset in bounded chunks with upstream's headers", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(CODER_ASSET_BODY_CHUNK_BYTES * 2 + 17);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
      const { relativeUrl } = yield* issueMediaFile(bytes, "large.png");
      const { head, chunks } = yield* serve({ method: "GET", path: relativeUrl });
      expect(head.status).toBe(200);
      expect(head.headers["content-type"]).toBe("image/png");
      expect(head.headers["cache-control"]).toBe("private, max-age=3600");
      expect(chunks.every((chunk) => chunk.byteLength <= CODER_ASSET_BODY_CHUNK_BYTES)).toBe(true);
      expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("answers media byte ranges and HEAD requests without a body", () =>
    Effect.gen(function* () {
      const { relativeUrl } = yield* issueMediaFile("0123456789", "clip.mp4");
      const ranged = yield* serve({ method: "GET", path: relativeUrl, range: "bytes=2-5" });
      expect(ranged.head.status).toBe(206);
      expect(ranged.head.headers["content-range"]).toBe("bytes 2-5/10");
      expect(Buffer.concat(ranged.chunks).toString()).toBe("2345");
      const head = yield* serve({ method: "HEAD", path: relativeUrl });
      expect(head.head.status).toBe(200);
      expect(head.chunks).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects unsigned and tampered asset paths", () =>
    Effect.gen(function* () {
      const { relativeUrl } = yield* issueMediaFile("png", "shot.png");
      const tampered = relativeUrl.replace(/\.([^./]+)\/shot\.png$/, ".AAAA$1/shot.png");
      for (const path of [tampered, "/api/assets/unsigned/shot.png", "/api/other"]) {
        expect((yield* serve({ method: "GET", path })).head.status).toBe(404);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
