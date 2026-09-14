import { describe, expect, it } from "vite-plus/test";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  foldUserInputActivities,
  getQuestionAnswerHistory,
  isQuestionAnswer,
} from "./userInput.ts";
const activity = (
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  tone: OrchestrationThreadActivity["tone"] = "tool",
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  kind,
  payload,
  tone,
  summary: "Question",
  turnId: TurnId.make("turn-1"),
  createdAt: "2026-09-14T12:00:00.000Z",
});
const request = activity("request", "user-input.requested", {
  requestId: "q",
  questions: [
    { id: "choice", question: "Which option?", options: [{ value: "a", label: "Option A" }] },
  ],
});
describe("question history", () => {
  it("folds lifecycle events at the original position and resolves option labels", () => {
    const unrelated = activity("other", "tool.completed", {});
    const entries = foldUserInputActivities([
      request,
      unrelated,
      activity("answer", "user-input.resolved", {
        requestId: "q",
        answers: { choice: { answers: ["a"] } },
      }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).toBe(request.id);
    const answer = entries[0]?.payload;
    expect(isQuestionAnswer(answer)).toBe(true);
    if (isQuestionAnswer(answer))
      expect(getQuestionAnswerHistory(answer)).toBe("Which option?\nOption A");
    expect(entries[1]).toBe(unrelated);
  });
  it("removes the duplicate native question tool but retains failures and other turns", () => {
    const tool = activity("tool", "tool.completed", {
      toolCallId: "native",
      title: "AskUserQuestion",
      data: { input: { questions: [{ question: "Which option?" }] } },
    });
    const failed = { ...tool, id: EventId.make("failure"), tone: "error" as const };
    const otherTurn = { ...tool, id: EventId.make("other-turn"), turnId: TurnId.make("turn-2") };
    expect(
      foldUserInputActivities([tool, request, failed, otherTurn]).map((entry) => entry.id),
    ).toEqual([request.id, failed.id, otherTurn.id]);
  });
  it("retains unanswered questions without inventing an answer", () => {
    const answer = foldUserInputActivities([request])[0]?.payload;
    if (!isQuestionAnswer(answer)) throw new Error("Missing question");
    expect(answer.answers).toEqual({});
    expect(getQuestionAnswerHistory(answer)).toContain("Not answered");
  });
});
