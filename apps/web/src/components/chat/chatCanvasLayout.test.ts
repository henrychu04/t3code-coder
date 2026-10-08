import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

// Coder: there is no floating preview, so the chat lane is always centered.
describe("chat canvas layout", () => {
  it("centers chat in the whole container", () => {
    const resolve = (width: number) =>
      resolveChatCanvasLayout({ container: { width, height: 900 }, composerHeight: 180 });
    expect(resolve(1344).chat).toEqual({ left: 288, width: 768, insetStart: 0, insetEnd: 0 });
    expect(resolve(390).chat).toEqual({ left: 20, width: 350, insetStart: 0, insetEnd: 0 });
    expect(resolve(1344).frame).toBeNull();
  });
});

describe("thread details card layout", () => {
  it("uses the margin beside the chat lane at full height", () => {
    expect(
      resolveThreadDetailsCardLayout({
        container: { width: 1600, height: 900 },
        chat: { left: 416, width: 768 },
        frame: null,
      }),
    ).toEqual({ x: 1276, width: 312, y: 12, height: 876 });
    expect(
      resolveThreadDetailsCardLayout({
        container: { width: 1200, height: 900 },
        chat: { left: 216, width: 768 },
        frame: null,
      }),
    ).toBeNull();
  });

  it("folds content density to the available height", () => {
    expect(resolveThreadDetailsCardDensity(500, { full: 400, compact: 200 })).toBe("full");
    expect(resolveThreadDetailsCardDensity(300, { full: 400, compact: 200 })).toBe("compact");
    expect(resolveThreadDetailsCardDensity(100, { full: 400, compact: 200 })).toBe("essential");
  });
});
