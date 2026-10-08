import { createContext, useContext } from "react";
import type {
  ChatCanvasDetailsCardObstacle,
  ChatCanvasPreview,
  resolveChatCanvasLayout,
} from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  reportPreview: (preview: ChatCanvasPreview) => void;
  clearPreview: (key: string) => void;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: ChatCanvasDetailsCardObstacle) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
