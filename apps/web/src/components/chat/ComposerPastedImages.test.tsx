// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ComposerPastedImages } from "./ComposerPastedImages";
import type { ComposerPastedImage } from "../../lib/composerPastedImages";

let root: Root;
let container: HTMLDivElement;
const revoke = vi.fn();
const file = new File(["image"], "Screenshot.png", { type: "image/png" });
const uploaded: ComposerPastedImage = {
  id: "one",
  file,
  status: "uploaded",
  workspaceId: "workspace",
  path: "/uploaded.png",
};
const remove = vi.fn();
const retry = vi.fn();
async function render(images: ReadonlyArray<ComposerPastedImage>, compact = false) {
  await act(async () =>
    root.render(
      <ComposerPastedImages images={images} compact={compact} onRemove={remove} onRetry={retry} />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps a stable thumbnail through progress and completion, then releases it on removal", async () => {
  await render([
    { id: "one", file, status: "uploading", workspaceId: "workspace", progress: 0.25 },
  ]);
  expect(container.textContent).toContain("25%");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Remove Screenshot.png"]')!.click(),
  );
  expect(remove).toHaveBeenCalledWith("one");
  await render([{ id: "one", file, status: "uploading", workspaceId: "workspace", progress: 1 }]);
  expect(container.textContent).toContain("100%");
  await render([uploaded]);
  expect(container.textContent).not.toContain("100%");
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  await render([]);
  expect(container.children).toHaveLength(0);
  expect(revoke).toHaveBeenCalledWith("blob:preview");
});

it("displays submitted images with a gallery and no editing controls", async () => {
  await act(async () => root.render(<ComposerPastedImages images={[uploaded]} />));
  expect(container.querySelector("img")?.src).toBe("blob:preview");
  expect(container.querySelector('[aria-label="Remove Screenshot.png"]')).toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Preview Screenshot.png"]')!.click(),
  );
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain("Remove image");
});

it("offers retry for failed uploads without re-pasting", async () => {
  await render([
    { id: "one", file, workspaceId: "workspace", status: "failed", error: "Connection lost" },
  ]);
  expect(container.textContent).toContain("Connection lost");
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Retry upload for Screenshot.png"]')!
      .click(),
  );
  expect(retry).toHaveBeenCalledWith("one");
});

it("opens all compact thumbnails in one keyboard-navigable gallery", async () => {
  const images = Array.from({ length: 5 }, (_, index) => ({
    ...uploaded,
    id: String(index),
    file: new File(["image"], `${index}.png`, { type: "image/png" }),
  }));
  await render(images, true);
  expect(container.querySelectorAll("img")).toHaveLength(3);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="View all 5 images"]')!.click(),
  );
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("3.png");
  await act(async () =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("4.png");
  expect(document.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.disabled).toBe(
    false,
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Previous image"]')!.click(),
  );
  expect(document.querySelector('[role="dialog"] img')?.getAttribute("alt")).toBe("3.png");
});
