const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface TruncatedTerminalBuffer {
  readonly buffer: string;
  /** Number of UTF-16 code units removed from the front of `buffer`. */
  readonly droppedCodeUnits: number;
  readonly startsAtLineBoundary: boolean;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) return index + 1;
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return null;
}

function findCsiEndIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    if (isCsiFinalByte(input.charCodeAt(index))) return index + 1;
  }
  return null;
}

function findEscapeEndIndex(input: string, start: number): number | null {
  let index = start;
  while (index < input.length) {
    const codePoint = input.charCodeAt(index);
    if (codePoint < 0x20 || codePoint > 0x2f) {
      return codePoint >= 0x30 && codePoint <= 0x7e ? index + 1 : start;
    }
    index += 1;
  }
  return null;
}

function terminalTokenEnd(input: string, start: number): number {
  const codePoint = input.charCodeAt(start);
  if (codePoint === 0x1b) {
    const next = input.charCodeAt(start + 1);
    if (Number.isNaN(next)) return input.length;
    if (next === 0x5b) return findCsiEndIndex(input, start + 2) ?? input.length;
    if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
      return findStringTerminatorIndex(input, start + 2) ?? input.length;
    }
    return findEscapeEndIndex(input, start + 1) ?? input.length;
  }
  if (codePoint === 0x9b) return findCsiEndIndex(input, start + 1) ?? input.length;
  if (
    codePoint === 0x9d ||
    codePoint === 0x90 ||
    codePoint === 0x98 ||
    codePoint === 0x9e ||
    codePoint === 0x9f
  ) {
    return findStringTerminatorIndex(input, start + 1) ?? input.length;
  }
  const scalar = input.codePointAt(start);
  return start + (scalar !== undefined && scalar > 0xffff ? 2 : 1);
}

function safeTerminalStart(input: string, target: number): number {
  let index = 0;
  while (index < target) index = terminalTokenEnd(input, index);
  return index;
}

function nextTerminalLineStart(input: string, start: number): number | null {
  let index = start;
  while (index < input.length) {
    const end = terminalTokenEnd(input, index);
    if (end === index + 1 && input.charCodeAt(index) === 0x0a) return end;
    index = end;
  }
  return null;
}

/**
 * Retains a UTF-8-bounded suffix without beginning inside a terminal control
 * sequence. History callers can additionally prefer the next complete line.
 */
export function truncateTerminalBufferToBytes(
  input: string,
  maxBytes: number,
  options: { readonly preferLineBoundary?: boolean } = {},
): TruncatedTerminalBuffer {
  if (maxBytes <= 0) {
    return {
      buffer: "",
      droppedCodeUnits: input.length,
      startsAtLineBoundary: input.length === 0 || input.endsWith("\n"),
    };
  }

  const encoded = textEncoder.encode(input);
  if (encoded.byteLength <= maxBytes) {
    return { buffer: input, droppedCodeUnits: 0, startsAtLineBoundary: true };
  }

  let byteStart = encoded.byteLength - maxBytes;
  while (byteStart < encoded.length && (encoded[byteStart]! & 0b1100_0000) === 0b1000_0000) {
    byteStart += 1;
  }
  const byteBoundedSuffix = textDecoder.decode(encoded.subarray(byteStart));
  const target = input.length - byteBoundedSuffix.length;
  let start = safeTerminalStart(input, target);
  const alreadyAtLineBoundary = start === 0 || input.charCodeAt(start - 1) === 0x0a;
  if (options.preferLineBoundary && !alreadyAtLineBoundary) {
    start = nextTerminalLineStart(input, start) ?? start;
  }
  return {
    buffer: input.slice(start),
    droppedCodeUnits: start,
    startsAtLineBoundary: start === 0 || input.charCodeAt(start - 1) === 0x0a,
  };
}
