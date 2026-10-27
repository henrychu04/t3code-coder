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

export const DETAILS_CARD_CLEARANCE = 32;

/** Pure geometry shared by the conversation, composer, and workspace card. */
export function resolveChatCanvasLayout({
  container,
  padding = 48,
  maxChatWidth = 768,
  detailsCard = null,
  centerBesideDetails = false,
}: {
  container: CanvasSize;
  preview?: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: ChatCanvasDetailsCardObstacle;
  findBar?: ChatCanvasDetailsCardObstacle;
  /** Center the chat in the space left of the details card when it would otherwise crowd it. */
  centerBesideDetails?: boolean;
}) {
  const centeredWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const laneRight = detailsCard
    ? detailsCard.left - DETAILS_CARD_CLEARANCE
    : container.width - padding;
  const normalWidth = Math.max(0, Math.min(centeredWidth, laneRight - padding));
  const canvasCenterLeft = (container.width - normalWidth) / 2;
  // Beside a card it would crowd, the chat centers between the card and the canvas edge. The shift
  // eases to zero as clearance grows, so very wide windows keep the chat still and a resize
  // never jumps it.
  const besideShift =
    detailsCard && centerBesideDetails
      ? Math.min(
          (container.width - detailsCard.left) / 2,
          Math.max(
            0,
            (container.width - detailsCard.left) / 2 - (laneRight - canvasCenterLeft - normalWidth),
          ),
        )
      : 0;
  const normalLeft = Math.max(
    padding,
    Math.min(canvasCenterLeft - besideShift, laneRight - normalWidth),
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
