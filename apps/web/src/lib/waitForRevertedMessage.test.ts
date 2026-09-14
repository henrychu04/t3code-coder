import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { waitForRevertedMessage } from "./waitForRevertedMessage";

const state = vi.hoisted(() => ({
  thread: {
    messages: [{ id: "message" }],
    activities: [] as Array<{
      id: string;
      kind: string;
      summary: string;
      payload: { detail: string };
    }>,
    checkpoints: [] as Array<{ checkpointTurnCount: number; turnId: string }>,
    latestTurn: null as null | { turnId: string },
  },
  listeners: new Set<() => void>(),
}));
vi.mock("../state/threads", () => ({ environmentThreadDetails: { detailAtom: () => ({}) } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => state.thread,
    subscribe: (_atom: unknown, listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
  },
}));
const ref = { environmentId: EnvironmentId.make("workspace"), threadId: ThreadId.make("thread") };
const id = MessageId.make("message");
const emit = () => {
  for (const listener of state.listeners) listener();
};
beforeEach(() => {
  state.thread = { messages: [{ id }], activities: [], checkpoints: [], latestTurn: null };
  state.listeners.clear();
});
afterEach(() => vi.useRealTimers());
it("waits for the projected rewind after command acceptance and cleans up", async () => {
  const result = waitForRevertedMessage(ref, id, 0, async () => {});
  let completed = false;
  void result.then(() => {
    completed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(completed).toBe(false);
  state.thread.messages = [];
  state.thread.latestTurn = { turnId: "old-turn" };
  emit();
  await Promise.resolve();
  expect(completed).toBe(false);
  state.thread.latestTurn = null;
  emit();
  await result;
  expect(state.listeners.size).toBe(0);
});
it("rejects provider history failures without restoring a draft", async () => {
  const result = waitForRevertedMessage(ref, id, 0, async () => {
    state.thread.activities.push({
      id: "failure",
      kind: "checkpoint.revert.failed",
      summary: "Rewind failed",
      payload: { detail: "Native history unavailable" },
    });
    emit();
  });
  await expect(result).rejects.toThrow("Native history unavailable");
  expect(state.listeners.size).toBe(0);
});
it("bounds a stalled rewind and unsubscribes", async () => {
  vi.useFakeTimers();
  const result = waitForRevertedMessage(ref, id, 0, async () => {}, 20);
  const rejection = expect(result).rejects.toThrow("Timed out");
  await vi.advanceTimersByTimeAsync(20);
  await rejection;
  expect(state.listeners.size).toBe(0);
});
