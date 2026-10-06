import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationShellStreamItem,
  OrchestrationSubscribeShellInput,
  OrchestrationSubscribeThreadInput,
  OrchestrationGetThreadSnapshotInput,
} from "./orchestration.ts";
import { ServerConfigStreamEvent } from "./server.ts";

describe("pre-v2 stream wire contracts", () => {
  it("keeps completion markers opt-in and fallback turn limits optional", () => {
    expect(
      Schema.decodeUnknownSync(OrchestrationSubscribeShellInput)({ requestCompletionMarker: true }),
    ).toEqual({ requestCompletionMarker: true });
    expect(
      Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({
        threadId: "thread",
        reasoningMessages: true,
        requestCompletionMarker: true,
      }),
    ).toEqual({ threadId: "thread", reasoningMessages: true, requestCompletionMarker: true });
    expect(
      Schema.decodeUnknownSync(OrchestrationShellStreamItem)({ kind: "synchronized" }),
    ).toEqual({ kind: "synchronized" });
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationShellStreamItem)({ kind: "cursor", sequence: 1 }),
    ).toThrow();
  });
  it("bounds Coder snapshot target sizes and preserves reasoning opt-in", () => {
    const request = {
      threadId: "thread",
      turnLimit: 10,
      targetBytes: 4 * 1024 * 1024,
      reasoningMessages: true,
    };
    expect(Schema.decodeUnknownSync(OrchestrationGetThreadSnapshotInput)(request)).toEqual(request);
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationGetThreadSnapshotInput)({
        ...request,
        targetBytes: request.targetBytes + 1,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({
        ...request,
        targetBytes: request.targetBytes + 1,
      }),
    ).toThrow();
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
