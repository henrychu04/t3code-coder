import { describe, expect, it } from "vite-plus/test";
import { MessageId, type TurnId } from "@t3tools/contracts";
import { deriveTimelineEntries, deriveTimelineEntriesWithState } from "./session-logic";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
} from "./components/chat/MessagesTimeline.logic";
import type { ChatMessage } from "./types";

const user: ChatMessage = {
  id: MessageId.make("user"),
  role: "user",
  text: "hello",
  turnId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  streaming: false,
};
const assistant: ChatMessage = {
  ...user,
  id: MessageId.make("assistant"),
  role: "assistant",
  text: "reply",
  createdAt: "2026-01-01T00:00:01Z",
  streaming: true,
};

describe("timeline projections", () => {
  it("reuses untouched entries and rows on streaming text updates", () => {
    const first = deriveTimelineEntriesWithState([user, assistant], [], []);
    const messages = [
      user,
      { ...assistant, text: "reply continued", updatedAt: "2026-01-01T00:00:02Z" },
    ];
    const next = deriveTimelineEntriesWithState(messages, [], [], first);
    expect(next.entries).toEqual(deriveTimelineEntries(messages, [], []));
    expect(next.entries[0]).toBe(first.entries[0]);
    const input = {
      timelineEntries: first.entries,
      expandedTurnIds: new Set<TurnId>(),
      isWorking: true,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const rows = deriveMessagesTimelineRowsWithState(input);
    const nextInput = { ...input, timelineEntries: next.entries };
    const updated = deriveMessagesTimelineRowsWithState(nextInput, rows);
    expect(updated.rows).toEqual(deriveMessagesTimelineRows(nextInput));
    expect(updated.rows.find((row) => row.kind === "message" && row.message.id === user.id)).toBe(
      rows.rows.find((row) => row.kind === "message" && row.message.id === user.id),
    );
  });

  it("matches full derivation on append, reorder, completion, and removal", () => {
    let previous = deriveTimelineEntriesWithState([user, assistant], [], []);
    for (const messages of [
      [user, assistant, { ...user, id: MessageId.make("later") }],
      [assistant, user],
      [user, { ...assistant, streaming: false }],
      [assistant],
    ]) {
      const next = deriveTimelineEntriesWithState(messages, [], [], previous);
      expect(next.entries).toEqual(deriveTimelineEntries(messages, [], []));
      previous = next;
    }
  });
});
