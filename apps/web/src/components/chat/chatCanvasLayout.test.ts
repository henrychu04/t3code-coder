import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

// Coder: there is no floating preview, so these are upstream's cases without one.
describe("workspace card beside chat", () => {
  const withCard = (width: number, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
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
});
