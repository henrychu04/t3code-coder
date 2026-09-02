import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";
import { truncateTerminalBufferToBytes } from "@t3tools/shared/terminalBuffer";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly sequence: number | null;
  /** UTF-16 offset of `buffer` within the current replacement epoch. */
  readonly bufferOffset: number;
  /** Changes when a snapshot, restart, or clear replaces terminal history. */
  readonly bufferEpoch: number;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly sequence: number | null;
  /** UTF-16 offset of `buffer` within the current replacement epoch. */
  readonly bufferOffset: number;
  /** Changes when a snapshot, restart, or clear replaces terminal history. */
  readonly bufferEpoch: number;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  sequence: null,
  bufferOffset: 0,
  bufferEpoch: 0,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  sequence: null,
  bufferOffset: 0,
  bufferEpoch: 0,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  bufferEpoch = 1,
): TerminalBufferState {
  const truncated = truncateTerminalBufferToBytes(snapshot.history, maxBufferBytes);
  return {
    buffer: truncated.buffer,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    sequence: snapshot.sequence ?? null,
    bufferOffset: truncated.droppedCodeUnits,
    bufferEpoch,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    sequence: buffer.sequence,
    bufferOffset: buffer.bufferOffset,
    bufferEpoch: buffer.bufferEpoch,
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "resumed":
      return { ...current, sequence: event.sequence };
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(
        event.snapshot,
        maxBufferBytes,
        current.bufferEpoch + 1,
      );
    case "output": {
      const truncated = truncateTerminalBufferToBytes(
        `${current.buffer}${event.data}`,
        maxBufferBytes,
      );
      return {
        ...current,
        buffer: truncated.buffer,
        bufferOffset: current.bufferOffset + truncated.droppedCodeUnits,
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        sequence: event.sequence ?? current.sequence,
        version: current.version + 1,
      };
    }
    case "cleared":
      return {
        ...current,
        buffer: "",
        bufferOffset: 0,
        bufferEpoch: current.bufferEpoch + 1,
        error: null,
        sequence: event.sequence ?? current.sequence,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        sequence: event.sequence ?? current.sequence,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        sequence: event.sequence ?? current.sequence,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        sequence: event.sequence ?? current.sequence,
        version: current.version + 1,
      };
    case "activity":
      return { ...current, sequence: event.sequence ?? current.sequence };
  }
}

export function terminalBufferAppend(
  previous: Pick<TerminalSessionState, "buffer" | "bufferOffset" | "bufferEpoch">,
  current: Pick<TerminalSessionState, "buffer" | "bufferOffset" | "bufferEpoch">,
): string | null {
  if (previous.bufferEpoch !== current.bufferEpoch) return null;
  const previousEnd = previous.bufferOffset + previous.buffer.length;
  const currentEnd = current.bufferOffset + current.buffer.length;
  if (previousEnd < current.bufferOffset || previousEnd > currentEnd) return null;
  return current.buffer.slice(previousEnd - current.bufferOffset);
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
