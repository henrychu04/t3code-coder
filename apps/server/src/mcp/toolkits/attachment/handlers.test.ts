// Coder: upstream's attachment cases from `toolkits/core.test.ts`, which runs them through its MCP
// server; here they call the toolkit as the file bridge does.
// @effect-diagnostics nodeBuiltinImport:off -- the test writes the workspace file an agent uploads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ChatImageAttachment,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as AttachmentHandlers from "./handlers.ts";
import { McpAttachmentInput } from "./input.ts";
import { AttachmentToolkit } from "./tools.ts";

const decodeMcpAttachmentInput = Schema.decodeUnknownEffect(McpAttachmentInput);

const threadId = ThreadId.make("mcp-core-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-core-environment"),
  requestNamespace: "mcp-core-session",
  thread: {
    threadId,
    providerSessionId: "mcp-core-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

it.effect("resolves reused attachment references from stored metadata", () =>
  Effect.gen(function* () {
    const stored = ChatImageAttachment.make({
      type: "image",
      id: "owned-image",
      name: "original.png",
      mimeType: "image/png",
      sizeBytes: 12,
      source: {
        kind: "snap-shot",
        capturedAt: "2026-09-10T00:00:00.000Z",
        appName: "Terminal",
        windowTitle: "Test",
        accessibility: { format: "flat-text", text: "Stored context", truncated: false },
      },
    });
    const forged = yield* decodeMcpAttachmentInput({
      type: "image",
      id: stored.id,
      name: "changed.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 99,
    });
    const result = yield* AttachmentHandlers.resolveAttachmentReferences([forged], [stored]);
    expect(result).toEqual([stored]);
    const failure = yield* AttachmentHandlers.resolveAttachmentReferences(
      [{ ...forged, id: "other-image" }],
      [stored],
    ).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_request");
  }),
);

it.effect("only the caller that prepared a pending upload can discard it", () =>
  Effect.gen(function* () {
    const toolkit = yield* AttachmentToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(AttachmentHandlers.layer)),
    );
    const call = (
      name: keyof typeof AttachmentToolkit.tools,
      args: Record<string, unknown>,
      invocation: McpInvocationContext.McpInvocationScope,
    ) =>
      toolkit
        .handle(name, args as never)
        .pipe(
          Effect.flatMap(Stream.runLast),
          Effect.map(Option.getOrThrow),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        );
    // Coder: the upload names a workspace file instead of a URL the caller POSTs to.
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-attachment-file-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const path = NodePath.join(directory, "shot.png");
    yield* Effect.promise(() => NodeFSP.writeFile(path, Uint8Array.of(1, 2, 3, 4)));

    const prepared = yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "shot.png", mimeType: "image/png", sizeBytes: 4 }, path },
      scope,
    );
    expect(prepared.isFailure).toBe(false);
    const { attachmentId } = prepared.encodedResult as { readonly attachmentId: string };
    const config = yield* ServerConfig.ServerConfig;
    const staged = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(config.attachmentsDir, `${attachmentId}.png`)),
    );
    expect([...staged]).toEqual([1, 2, 3, 4]);
    const otherThread = {
      ...scope,
      requestNamespace: "other-session",
      thread: { ...scope.thread!, threadId: ThreadId.make("other-thread") },
    };

    const refused = yield* call("t3_attachment_discard", { attachmentId }, otherThread);
    expect(refused.isFailure).toBe(true);
    expect(refused.encodedResult).toMatchObject({ code: "invalid_request" });

    yield* TestClock.adjust(24 * 60 * 60 * 1000 + 5 * 60_000);
    yield* call(
      "t3_attachment_prepare_upload",
      { upload: { name: "later.png", mimeType: "image/png", sizeBytes: 4 }, path },
      scope,
    );

    const discarded = yield* call(
      "t3_attachment_discard",
      { attachmentId },
      { ...scope, requestNamespace: "mcp-core-session-2" },
    );
    expect(discarded.isFailure).toBe(false);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(McpToolAccessTestkit.liveThreadsLayer, ServerSecretStore.layer).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-attachment-" })),
        Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
    ),
  ),
);
