// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ComposerImagePicker } from "./ComposerImagePicker";

it("opens the picker from a labeled button and permits choosing the same image again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const onFiles = vi.fn();
  try {
    await act(async () => root.render(<ComposerImagePicker onFiles={onFiles} />));
    const input = host.querySelector<HTMLInputElement>("input")!;
    const open = vi.spyOn(input, "click").mockImplementation(() => {});
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(open).toHaveBeenCalledOnce();
    const file = new File(["image"], "photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    for (let i = 0; i < 2; i++) {
      await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      expect(input.value).toBe("");
    }
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onFiles).toHaveBeenLastCalledWith([file]);
    await act(async () => root.render(<ComposerImagePicker disabled onFiles={onFiles} />));
    expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    expect(input.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
