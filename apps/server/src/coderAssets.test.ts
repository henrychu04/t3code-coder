import * as NodeServices from "@effect/platform-node/NodeServices";
import { CODER_ASSET_BODY_CHUNK_BYTES, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { makeServeAsset } from "./coderAssets.ts";
import * as ServerConfig from "./config.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as BuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-coder-assets-test-",
});
const layerTest = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({ getTurnItem: () => Effect.succeed(null) }),
  Layer.mock(DocumentText.DocumentText)({ ensure: () => Effect.succeed(undefined) }),
  Layer.succeed(BuiltInDrivers.SourceControlDrivers, []),
  layerConfig,
  WorkspacePaths.layer,
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

type ServeAsset = Effect.Success<typeof makeServeAsset>;

const collect = (assets: ServeAsset, input: Parameters<ServeAsset["serve"]>[0]) =>
  Effect.gen(function* () {
    const parts = yield* Stream.runCollect(assets.serve(input));
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

const serve = (input: Parameters<ServeAsset["serve"]>[0]) =>
  Effect.flatMap(makeServeAsset, (assets) => collect(assets, input));

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

  it.effect("stores an upload whose body arrives in chunks, and refuses a finished body", () =>
    Effect.gen(function* () {
      const assets = yield* makeServeAsset;
      const bytes = Buffer.alloc(CODER_ASSET_BODY_CHUNK_BYTES + 5, 7);
      const upload = yield* issueAttachmentUploadUrl({
        type: "file",
        name: "notes.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.byteLength,
      });
      const bodyId = "body-1";
      const response = yield* collect(assets, {
        method: "POST",
        path: upload.relativeUrl,
        contentType: "application/octet-stream",
        contentLength: bytes.byteLength,
        bodyId,
      }).pipe(Effect.forkChild);
      for (let offset = 0; offset < bytes.byteLength; offset += CODER_ASSET_BODY_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CODER_ASSET_BODY_CHUNK_BYTES);
        yield* assets.writeRequestBody({
          bodyId,
          dataBase64: chunk.toString("base64"),
          done: offset + CODER_ASSET_BODY_CHUNK_BYTES >= bytes.byteLength,
        });
      }
      const { head } = yield* Fiber.join(response);
      expect(head.status).toBe(204);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const stored = yield* fs.readFile(`${config.attachmentsDir}/${upload.attachmentId}.bin`);
      expect(Buffer.from(stored).equals(bytes)).toBe(true);
      const late = yield* assets
        .writeRequestBody({ bodyId, dataBase64: "", done: true })
        .pipe(Effect.flip);
      expect(late._tag).toBe("CoderRequestBodyError");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
