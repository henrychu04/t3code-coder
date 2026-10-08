// Coder: there is no floating browser or device preview, so the chat lane never yields to a
// player. The shapes below keep upstream's canvas API; a reported preview is ignored.
interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

interface HorizontalSpan {
  readonly left: number;
  readonly right: number;
}

export interface ChatCanvasFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ChatCanvasDetailsCardObstacle = (HorizontalSpan & { readonly bottom: number }) | null;

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly source: CanvasSize;
  readonly lastInteraction?: "drag" | "resize" | null;
}

/** Pure geometry shared by the conversation and composer. */
export function resolveChatCanvasLayout({
  container,
  padding = 20,
  maxChatWidth = 768,
}: {
  container: CanvasSize;
  preview?: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: ChatCanvasDetailsCardObstacle;
}) {
  const width = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const chat = { left: (container.width - width) / 2, width, insetStart: 0, insetEnd: 0 };
  const frame: ChatCanvasFrame | null = null;
  return { chat, frame, overlapsChat: false, overlapsDetailsCard: false };
}
