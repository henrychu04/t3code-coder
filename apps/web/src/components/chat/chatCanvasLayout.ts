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

// Minimum space between chat and the workspace card. Chat stays centered while
// the card fits beside it with this much room.
export const DETAILS_CARD_CLEARANCE = 32;

/** Pure geometry shared by the conversation, composer, and workspace card. */
export function resolveChatCanvasLayout({
  container,
  padding = 48,
  maxChatWidth = 768,
  detailsCard = null,
}: {
  container: CanvasSize;
  preview?: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: ChatCanvasDetailsCardObstacle;
  /** The open find bar. It only keeps the floating preview clear; chat stays put. */
  findBar?: ChatCanvasDetailsCardObstacle;
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  // A workspace card that does not fit beside the centered chat first moves
  // chat left, only as far as it needs. Chat narrows only after it reaches the
  // left padding.
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const normalLeft = Math.max(
    padding,
    Math.min((container.width - normalWidth) / 2, laneRight - normalWidth),
  );
  const chat = {
    left: normalLeft,
    width: normalWidth,
    insetStart: 0,
    insetEnd: Math.max(0, container.width - normalLeft * 2 - normalWidth),
  };
  const frame: ChatCanvasFrame | null = null;
  return { chat, frame, overlapsChat: false, overlapsDetailsCard: false };
}
