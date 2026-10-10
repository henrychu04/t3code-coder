// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  NodeId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type TurnItemAssetReadInput,
} from "@t3tools/contracts";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readTurnItemAssetChunk } from "./TurnItemAssets.ts";

const now = DateTime.makeUnsafe("2026-10-09T00:00:00.000Z");
const threadId = ThreadId.make("thread:apps");
const itemId = TurnItemId.make("turn-item:apps");
const attachmentId = "thread-apps-550e8400-e29b-41d4-a716-446655440000-html";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

function toolItem(output: unknown, toolName = "todos.show"): OrchestrationV2TurnItem {
  return {
    id: itemId,
    threadId,
    runId: null,
    nodeId: NodeId.make("node:apps"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "dynamic_tool",
    toolName,
    input: {},
    output,
  };
}

const appOutput = {
  [MCP_APP_OUTPUT_KEY]: {
    attachmentId,
    server: "todos",
    tool: "show",
    resourceUri: "ui://todos/app.html",
  },
  result: { content: [] },
};
const imageOutput = {
  content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
};

let attachmentsDir: string;
beforeEach(async () => {
  attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), "turn-item-assets-"));
});
afterEach(async () => {
  await fs.rm(attachmentsDir, { recursive: true, force: true });
});

function read(
  item: OrchestrationV2TurnItem | null,
  asset: TurnItemAssetReadInput["asset"],
  offset = 0,
  limit = 512 * 1024,
) {
  return Effect.runPromise(
    readTurnItemAssetChunk(
      { threadId, itemId, asset, offset, limit },
      { attachmentsDir, getTurnItem: () => Effect.succeed(item) },
    ).pipe(Effect.result),
  );
}

describe("readTurnItemAssetChunk", () => {
  it("reads the app document the item carries, in chunks", async () => {
    const html = "<!doctype html><p>todos</p>";
    await fs.writeFile(path.join(attachmentsDir, `${attachmentId}.html`), html);

    const first = await read(toolItem(appOutput), { _tag: "mcp-app-document" }, 0, 10);
    expect(first._tag).toBe("Success");
    if (first._tag !== "Success") return;
    expect(first.success).toMatchObject({
      mimeType: "text/html",
      offset: 0,
      totalBytes: html.length,
      nextOffset: 10,
    });
    const rest = await read(toolItem(appOutput), { _tag: "mcp-app-document" }, 10);
    expect(rest._tag === "Success" && rest.success.nextOffset).toBeNull();
    expect(
      Buffer.concat(
        [first, rest].map((chunk) =>
          chunk._tag === "Success" ? Buffer.from(chunk.success.dataBase64, "base64") : Buffer.of(),
        ),
      ).toString(),
    ).toBe(html);
  });

  it("refuses documents the item does not own, symlinks, and missing items", async () => {
    await fs.writeFile(path.join(attachmentsDir, "outside.html"), "<p>outside</p>");
    await fs.symlink(
      path.join(attachmentsDir, "outside.html"),
      path.join(attachmentsDir, `${attachmentId}.html`),
    );
    const document = { _tag: "mcp-app-document" } as const;
    expect((await read(toolItem(appOutput), document))._tag).toBe("Failure");
    // A result that imitates the reference counts only for the server and tool it names.
    expect((await read(toolItem(appOutput, "other.show"), document))._tag).toBe("Failure");
    expect((await read(null, document))._tag).toBe("Failure");
  });

  it("decodes a tool output image by index and refuses one past the end", async () => {
    const image = await read(toolItem(imageOutput), { _tag: "tool-output-image", index: 0 });
    expect(image._tag).toBe("Success");
    if (image._tag !== "Success") return;
    expect(image.success.mimeType).toBe("image/png");
    expect(Buffer.from(image.success.dataBase64, "base64")).toEqual(png);
    expect((await read(toolItem(imageOutput), { _tag: "tool-output-image", index: 1 }))._tag).toBe(
      "Failure",
    );
  });
});
