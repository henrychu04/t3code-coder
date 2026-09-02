import { describe, expect, it } from "vite-plus/test";

import { truncateTerminalBufferToBytes } from "./terminalBuffer.ts";

describe("truncateTerminalBufferToBytes", () => {
  it("bounds UTF-8 without splitting a code point", () => {
    expect(truncateTerminalBufferToBytes("a🙂🙂", 4)).toMatchObject({
      buffer: "🙂",
      droppedCodeUnits: 3,
    });
  });

  it("does not begin a retained suffix inside a terminal control sequence", () => {
    expect(truncateTerminalBufferToBytes("aa\u001b[123456mzz", 8)).toMatchObject({
      buffer: "zz",
      droppedCodeUnits: 11,
    });
    expect(truncateTerminalBufferToBytes("aa\u001bXpayload\u001b\\zz", 8)).toMatchObject({
      buffer: "zz",
      droppedCodeUnits: 13,
    });
  });

  it("prefers the next complete line for history replay", () => {
    expect(
      truncateTerminalBufferToBytes("old line\nnew line\nlast", 15, {
        preferLineBoundary: true,
      }),
    ).toMatchObject({
      buffer: "new line\nlast",
      startsAtLineBoundary: true,
    });
  });
});
