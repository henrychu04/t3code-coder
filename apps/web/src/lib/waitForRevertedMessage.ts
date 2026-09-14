import type { ScopedThreadRef, MessageId } from "@t3tools/contracts";
import { environmentThreadDetails } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";

export async function waitForRevertedMessage(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  turnCount: number,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
): Promise<void> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const initial = appAtomRegistry.get(threadAtom);
  if (!initial?.messages.some((message) => message.id === messageId)) {
    throw new Error("The message to rewind is no longer available.");
  }
  const previousFailures = new Set(
    initial.activities
      .filter((activity) => activity.kind === "checkpoint.revert.failed")
      .map((activity) => activity.id),
  );
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = appAtomRegistry.get(threadAtom);
      if (!thread) return;
      const failure = thread.activities.findLast(
        (activity) =>
          activity.kind === "checkpoint.revert.failed" && !previousFailures.has(activity.id),
      );
      if (failure) {
        const payload = failure.payload;
        finish(
          new Error(
            typeof payload === "object" &&
              payload !== null &&
              "detail" in payload &&
              typeof payload.detail === "string"
              ? payload.detail
              : failure.summary,
          ),
        );
      } else if (
        accepted &&
        !thread.messages.some((message) => message.id === messageId) &&
        thread.checkpoints.every((checkpoint) => checkpoint.checkpointTurnCount <= turnCount) &&
        (turnCount === 0
          ? thread.latestTurn === null
          : thread.checkpoints.some(
              (checkpoint) => checkpoint.turnId === thread.latestTurn?.turnId,
            ))
      ) {
        finish();
      }
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}
