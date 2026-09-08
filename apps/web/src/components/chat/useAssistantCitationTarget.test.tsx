// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

type Input = Parameters<typeof useAssistantCitationTarget>[0];
const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
const message = {
  id: MessageId.make("source"),
  role: "assistant" as const,
  text: "quote",
  turnId: TurnId.make("turn"),
  createdAt: "2026-09-08T12:00:00Z",
  updatedAt: "2026-09-08T12:00:00Z",
  streaming: false,
};
const entry = {
  kind: "message" as const,
  id: "message:source",
  createdAt: message.createdAt,
  message,
};
const row = {
  ...entry,
  durationStart: message.createdAt,
  showAssistantMeta: true,
  showAssistantCopyButton: true,
  assistantCopyStreaming: false,
};
let root: Root;
let input: Input;
let value: ReturnType<typeof useAssistantCitationTarget>;
function Probe() {
  value = useAssistantCitationTarget(input);
  return null;
}
async function render(patch: Partial<Input> = {}) {
  input = { ...input, ...patch };
  await act(() => root.render(<Probe />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  toast.mockClear();
  root = createRoot(document.createElement("div"));
  input = {
    request: {
      key: "first",
      citation: {
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        messageId: message.id,
        text: message.text,
        start: 0,
        end: 5,
        prefix: "",
        suffix: "",
      },
    },
    entries: [],
    rows: [],
    listRef: { current: {} as LegendListRef },
    viewport: document.createElement("div"),
    historyLoading: false,
    loadEarlier: null,
    onExpandTurn: vi.fn(),
    onManualNavigation: vi.fn(),
  };
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it("loads earlier history, unfolds the cited turn, and waits for the list before positioning", async () => {
  const onLoadEarlier = vi.fn();
  await render({ loadEarlier: { loading: false, cursor: "page-1", onLoadEarlier } });
  expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  expect(value.positioning).toBe(true);
  expect(value.target).toBeNull();
  await render({ loadEarlier: { loading: true, cursor: "page-1", onLoadEarlier } });
  expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  await render({ entries: [entry], loadEarlier: null });
  expect(input.onExpandTurn).toHaveBeenCalledWith(message.turnId);
  await render({ rows: [row] });
  expect(value.target).toBeNull();
  await act(() => value.onListLoad());
  expect(value.target?.citation.messageId).toBe(message.id);
  expect(value.alwaysRender).toEqual({ keys: [entry.id] });
  await act(() => value.target?.onComplete());
  expect(value.positioning).toBe(false);
  expect(value.alwaysRender).toBeUndefined();
  expect(toast).not.toHaveBeenCalled();
});
it("cancels a pending jump on user navigation and does not resume when history arrives", async () => {
  await render({ historyLoading: true });
  await act(() => input.viewport?.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })));
  expect(value.positioning).toBe(false);
  await render({ historyLoading: false, entries: [entry], rows: [row] });
  await act(() => value.onListLoad());
  expect(value.target).toBeNull();
  expect(toast).not.toHaveBeenCalled();
});
it("stops with feedback when the source no longer exists", async () => {
  await render();
  expect(value.positioning).toBe(false);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "The cited response is unavailable" }),
  );
});
it("cancels the old scroll when another citation is activated", async () => {
  await render({ entries: [entry], rows: [row] });
  await act(() => value.onListLoad());
  const oldTarget = value.target!;
  const cancelScroll = vi.fn();
  oldTarget.activationRef.current.cancelScroll = cancelScroll;
  await render({ request: { ...input.request!, key: "second" } });
  expect(cancelScroll).toHaveBeenCalledOnce();
  expect(oldTarget.activationRef.current.dismissed).toBe(true);
  expect(value.target?.key).toBe("second");
  await act(() => oldTarget.onComplete());
  expect(value.positioning).toBe(true);
});
