// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TerminalContextInlineChip } from "./chat/TerminalContextInlineChip";
import { CoderComposerContextChip, ComposerImagesContext } from "./ComposerContextNode";
import { imageContextReference } from "../lib/composerInlineContext";
vi.mock("../hooks/useComposerImageThumbnail", () => ({
  useComposerImageThumbnail: () => undefined,
}));
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}
it("opens the complete captured terminal excerpt in a popover", async () => {
  await render(
    <TerminalContextInlineChip
      label="Terminal 1 lines 3–4"
      terminalLabel="Terminal 1"
      lineStart={3}
      lineEnd={4}
      text={"first line\nsecond line"}
      detailsMode="popover"
    />,
  );
  const button = container.querySelector<HTMLButtonElement>("button")!;
  await act(async () => button.click());
  expect(document.querySelector('[aria-label="Captured terminal output"]')?.textContent).toBe(
    "first line\nsecond line",
  );
  expect(document.body.textContent).toContain("Lines 3–4");
});
it("shows image size and upload percentage through the upstream image chip", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const image = {
    id,
    file: new File([new Uint8Array(2048)], "diagram.png", { type: "image/png" }),
    workspaceId: "workspace",
    status: "uploading" as const,
    progress: 0.42,
  };
  await render(
    <ComposerImagesContext value={[image]}>
      <CoderComposerContextChip
        source={imageContextReference(id)}
        disabled={false}
        onSave={() => {}}
      />
    </ComposerImagesContext>,
  );
  expect(
    container.querySelector('[aria-label="Image attachment, diagram.png, 2 KB"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain("42%");
});
it("marks missing image payloads unresolved without exposing a file action", async () => {
  await render(
    <CoderComposerContextChip
      source={imageContextReference("00000000-0000-4000-8000-000000000001")}
      disabled={false}
      onSave={() => {}}
    />,
  );
  expect(container.querySelector('[data-context-unresolved="true"]')).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
});
