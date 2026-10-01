import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  expandedImageKey,
  resolveMarkdownMediaPreview,
  wrapExpandedImageIndex,
} from "./ExpandedImagePreview";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["http:", "http:"],
    ["https:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    async (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = await resolveMarkdownMediaPreview({ source });

      expect(preview?.images[0]).toMatchObject({
        src: `${mediaProtocol}${source}`,
        originalUrl: source,
        actionsSource: {
          src: `${mediaProtocol}${source}`,
          reference: { kind: "url", url: source },
        },
      });
      expect(preview?.images[0]?.projectVideo).toBeUndefined();
    },
  );

  // Coder: workspace media becomes a helper read, never a signed asset URL.
  it("resolves workspace media to helper sources rooted at the thread checkout", async () => {
    const opened: string[] = [];
    const image = await resolveMarkdownMediaPreview({
      source: "screens/shot.png#frame",
      cwd: "/repo",
      threadRef,
      onOpenFile: (path) => opened.push(path),
    });
    expect(image?.images[0]).toMatchObject({
      src: null,
      name: "shot.png",
      srcFragment: "#frame",
      projectImage: {
        environmentId: "env",
        target: { threadId: "thread", cwd: "/repo", filePath: "/repo/screens/shot.png" },
      },
    });
    image?.images[0]?.actionsSource?.onOpenFile?.();
    expect(opened).toEqual(["screens/shot.png"]);

    const video = await resolveMarkdownMediaPreview({
      source: "/elsewhere/clip.mp4",
      cwd: "/repo",
      threadRef,
    });
    expect(video?.images[0]).toMatchObject({
      type: "video",
      autoPlay: false,
      projectVideo: { target: { filePath: "/elsewhere/clip.mp4" } },
    });
    expect(video && expandedImageKey(video)).toContain("/elsewhere/clip.mp4");
  });

  it("refuses workspace media without a thread root", async () => {
    await expect(
      resolveMarkdownMediaPreview({ source: "/repo/shot.png", threadRef }),
    ).rejects.toThrow("Reconnect");
  });
});

it("keeps backward media navigation visible beyond a complete cycle", () => {
  const images = ["first", "second"];
  expect(
    Array.from({ length: 7 }, (_, step) => images[wrapExpandedImageIndex(-step, images.length)]),
  ).toEqual(["first", "second", "first", "second", "first", "second", "first"]);
});
