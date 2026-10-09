import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

import { type ChatCanvasPreview } from "./chatCanvasLayout";
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

describe("workspace card beside chat", () => {
  const withCard = (width: number, player: ChatCanvasPreview | null = null, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
      preview: player,
    });
  it("keeps chat centered while the card fits beside it", () => {
    expect(withCard(1384).chat).toEqual({ left: 324, width: 736, insetStart: 0, insetEnd: 0 });
  });
  it("moves chat left only as far as the card requires", () => {
    expect(withCard(1383).chat).toEqual({ left: 323, width: 736, insetStart: 0, insetEnd: 1 });
    expect(withCard(1147).chat).toEqual({ left: 87, width: 736, insetStart: 0, insetEnd: 237 });
  });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1108).chat).toMatchObject({ left: 48, width: 736 });
    expect(withCard(1028).chat).toEqual({ left: 48, width: 656, insetStart: 0, insetEnd: 276 });
    expect(withCard(1012).chat).toMatchObject({ left: 48, width: 640 });
  });
  it("reserves the marker gutter across widths where the details card fits", () => {
    for (let width = 1012; width <= 1440; width++) {
      const container = { width, height: 900 };
      const card = resolveThreadDetailsCardLayout({
        container,
        lane: { padding: 48, minChatWidth: 640 },
        frame: null,
      })!;
      const chat = withCard(width).chat;
      expect(chat.left).toBeGreaterThanOrEqual(48);
      expect(chat.width).toBeGreaterThanOrEqual(640);
      expect(card.x - chat.left - chat.width).toBeGreaterThanOrEqual(32);
    }
  });
  it("keeps a full-width chat clear of the card", () => {
    expect(withCard(1147, null, 10_000).chat).toEqual({
      left: 48,
      width: 775,
      insetStart: 0,
      insetEnd: 276,
    });
  });
  it("keeps centered chat in place when a new preview opens below the card", () => {
    expect(withCard(1440, preview)).toEqual({
      chat: { left: 352, width: 736, insetStart: 0, insetEnd: 0 },
      frame: { x: 1108, y: 688, width: 320, height: 200 },
      overlapsChat: false,
      overlapsDetailsCard: false,
    });
  });
});
