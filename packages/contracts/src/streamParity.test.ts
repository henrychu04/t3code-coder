import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ShellStreamItem,
  OrchestrationV2SubscribeShellInput,
  OrchestrationV2SubscribeThreadInput,
} from "./orchestrationV2.ts";
import { CoderWsRpcGroup, WS_METHODS } from "./rpc.ts";
import { ServerConfigStreamEvent } from "./server.ts";

describe("stream wire contracts", () => {
  it("keeps completion markers and bounded snapshots opt-in", () => {
    expect(
      Schema.decodeUnknownSync(OrchestrationV2SubscribeShellInput)({
        requestCompletionMarker: true,
      }),
    ).toEqual({ requestCompletionMarker: true });
    expect(
      Schema.decodeUnknownSync(OrchestrationV2SubscribeThreadInput)({
        threadId: "thread",
        requestCompletionMarker: true,
        acceptBoundedSnapshot: true,
      }),
    ).toEqual({ threadId: "thread", requestCompletionMarker: true, acceptBoundedSnapshot: true });
    expect(
      Schema.decodeUnknownSync(OrchestrationV2ShellStreamItem)({ kind: "synchronized" }),
    ).toEqual({ kind: "synchronized" });
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationV2ShellStreamItem)({ kind: "cursor", sequence: 1 }),
    ).toThrow();
  });

  it("Coder: serves bounded thread snapshots and history pages over the helper group", () => {
    const tags = new Set(CoderWsRpcGroup.requests.keys());
    expect(tags.has(WS_METHODS.orchestrationGetThreadBoundedSnapshot)).toBe(true);
    expect(tags.has(WS_METHODS.orchestrationGetThreadHistoryPage)).toBe(true);
    expect(tags.has(WS_METHODS.assetsPersistChatAttachments)).toBe(false);
    expect(tags.has(WS_METHODS.serverSearchAcpRegistry)).toBe(false);
  });

  it("decodes full provider arrays and rejects removed provider diff events", () => {
    const event = { version: 1, type: "providerStatuses", payload: { providers: [] } };
    expect(Schema.decodeUnknownSync(ServerConfigStreamEvent)(event)).toEqual(event);
    expect(() =>
      Schema.decodeUnknownSync(ServerConfigStreamEvent)({
        version: 1,
        type: "providerRemoved",
        payload: { instanceId: "codex" },
      }),
    ).toThrow();
  });
});
