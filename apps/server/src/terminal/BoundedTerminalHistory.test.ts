import { describe, expect, it, vi } from "vite-plus/test";
import { BoundedTerminalHistory } from "./Manager.ts";

describe("incremental terminal history", () => {
  it("appends and evicts old lines without materializing the full history", () => {
    const history = new BoundedTerminalHistory(3, "");
    const materialize = vi.spyOn(history, "value");
    for (let i = 0; i < 100; i++) history.append(`line ${i}\n`);
    expect(materialize).not.toHaveBeenCalled();
    expect(history.value()).toBe("line 97\nline 98\nline 99\n");
  });

  it("handles lines, CRLF, and Unicode split across chunks", () => {
    const history = new BoundedTerminalHistory(2, "old\n");
    for (const chunk of ["first", "\r", "\n", "\ud83d", "\ude00", "\n", "last"])
      history.append(chunk);
    expect(history.value()).toBe("😀\nlast");
    history.append("\n");
    expect(history.value()).toBe("😀\nlast\n");
  });

  it("keeps the byte bound without cutting terminal control sequences or Unicode", () => {
    const history = new BoundedTerminalHistory(10000, "");
    history.append("x".repeat(600 * 1024) + "\u001b[31m😀\u001b[0m");
    const value = history.value();
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(512 * 1024);
    expect(value.endsWith("\u001b[31m😀\u001b[0m")).toBe(true);
    expect(value).not.toContain("�");
    expect(value.startsWith("\r\n")).toBe(true);
  });
});
