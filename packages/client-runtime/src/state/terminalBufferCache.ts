import type { TerminalAttachInput } from "@t3tools/contracts";

import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 128;

export class TerminalBufferCache {
  readonly #entries = new Map<
    string,
    { readonly state: TerminalBufferState; readonly bytes: number }
  >();
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #textEncoder = new TextEncoder();
  #bytes = 0;

  constructor(maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.#maxBytes = maxBytes;
    this.#maxEntries = maxEntries;
  }

  #key(environmentId: string, input: TerminalAttachInput): string {
    return JSON.stringify([environmentId, input.threadId, input.terminalId]);
  }

  read(environmentId: string, input: TerminalAttachInput): TerminalBufferState {
    const key = this.#key(environmentId, input);
    const cached = this.#entries.get(key);
    if (!cached) return EMPTY_TERMINAL_BUFFER_STATE;
    this.#entries.delete(key);
    this.#entries.set(key, cached);
    return cached.state;
  }

  write(environmentId: string, input: TerminalAttachInput, state: TerminalBufferState): void {
    const key = this.#key(environmentId, input);
    const bytes = this.#textEncoder.encode(state.buffer).byteLength;
    if (bytes > this.#maxBytes || this.#maxEntries <= 0) return;
    const existing = this.#entries.get(key);
    if (existing) {
      this.#entries.delete(key);
      this.#bytes -= existing.bytes;
    }
    while (
      this.#entries.size > 0 &&
      (this.#entries.size >= this.#maxEntries || this.#bytes + bytes > this.#maxBytes)
    ) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      this.#entries.delete(oldestKey);
      this.#bytes -= oldest?.bytes ?? 0;
    }
    this.#entries.set(key, { state, bytes });
    this.#bytes += bytes;
  }
}
