import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

// Coder: there is no floating preview, so these are upstream's cases without one.
describe("chat canvas layout", () => {
  it("centers chat in the whole container without a preview", () => {
    expect(
      resolveChatCanvasLayout({ container: { width: 1344, height: 900 }, composerHeight: 180 })
        .chat,
    ).toEqual({ left: 288, width: 768, insetStart: 0, insetEnd: 0 });
    expect(
      resolveChatCanvasLayout({
        container: { width: 390, height: 900 },
        preview: null,
        padding: 12,
      }).chat,
    ).toEqual({ left: 12, width: 366, insetStart: 0, insetEnd: 0 });
  });
});

describe("workspace card beside chat", () => {
  const withCard = (width: number, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
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
    expect(withCard(1147, 10_000).chat).toEqual({
      left: 48,
      width: 775,
      insetStart: 0,
      insetEnd: 276,
    });
  });
});
