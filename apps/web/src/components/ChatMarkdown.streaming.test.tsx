import { afterEach, expect, it, vi } from "vite-plus/test";
import { act, create } from "react-test-renderer";
import ChatMarkdown from "./ChatMarkdown";

afterEach(() => vi.unstubAllGlobals());

it("keeps Markdown renderer instances mounted as streamed text changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <ChatMarkdown cwd={undefined} isStreaming text={"First paragraph\n\nSecond"} />,
    );
  });
  try {
    const first = renderer.root.findAllByType("p")[0];
    expect(first).toBeDefined();
    await act(async () => {
      renderer.update(
        <ChatMarkdown cwd={undefined} isStreaming text={"First paragraph\n\nSecond continued"} />,
      );
    });
    expect(renderer.root.findAllByType("p")[0]).toBe(first);
    expect(JSON.stringify(renderer.toJSON())).toContain("Second continued");
  } finally {
    await act(async () => renderer.unmount());
  }
});
