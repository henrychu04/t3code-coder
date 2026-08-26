import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, type ReviewDiffFileSnapshotResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";

import { createChunkedGitDiffFileContentsLoader } from "./diffFileContents";

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const ignoreTooLarge = () => undefined;
const sourceCacheNamespace = (source: typeof SOURCE) =>
  JSON.stringify([
    source.environmentId,
    source.cwd,
    source.sourceKind,
    source.baseRef,
    source.headRef,
    source.cacheKey,
  ]);

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "a/src/old-name.ts",
    name: "b/src/new-name.ts",
  } as FileDiffMetadata;
}

describe("createChunkedGitDiffFileContentsLoader", () => {
  it("reports an oversized open outcome without reading chunks", async () => {
    const maxBytes = 32 * 1024 * 1024;
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "tooLarge" as const,
        path: "src/new-name.ts",
        maxBytes,
      }),
    );
    const read = vi.fn();
    const report = vi.fn();
    const diff = fileDiff("new");
    const load = createChunkedGitDiffFileContentsLoader(
      open,
      read,
      {
        ...SOURCE,
        cacheKey: "oversized-comparison",
      },
      report,
    );

    await expect(load(diff)).resolves.toBeNull();
    expect(report).toHaveBeenCalledWith(diff, maxBytes);
    expect(read).not.toHaveBeenCalled();
  });

  it("passes unrelated command failures through to Pierre", async () => {
    const failure = new Error("snapshot expired");
    const open = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileSnapshotResult, Error>(Cause.fail(failure)),
    );
    const report = vi.fn();
    const load = createChunkedGitDiffFileContentsLoader(open, vi.fn(), SOURCE, report);

    await expect(load(fileDiff())).rejects.toBe(failure);
    expect(report).not.toHaveBeenCalled();
  });

  it("assembles bounded snapshots and reuses the in-memory file cache", async () => {
    const oldContents = "before\n";
    const newContents = "after\n";
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: { snapshotId: "old-snapshot", totalBytes: 7, contentHash: sha256(oldContents) },
        newFile: { snapshotId: "new-snapshot", totalBytes: 6, contentHash: sha256(newContents) },
      }),
    );
    const read = vi.fn(async ({ input }: { input: { snapshotId: string; offset: number } }) => {
      const contents = input.snapshotId === "old-snapshot" ? oldContents : newContents;
      const data = Buffer.from(contents, "utf8");
      return AsyncResult.success({
        snapshotId: input.snapshotId,
        offset: input.offset,
        totalBytes: data.byteLength,
        encoding: "base64" as const,
        decodedBytes: data.byteLength - input.offset,
        dataBase64: data.subarray(input.offset).toString("base64"),
        nextOffset: null,
      });
    });
    const chunkedSource = { ...SOURCE, cacheKey: "chunked-comparison" };
    const load = createChunkedGitDiffFileContentsLoader(open, read, chunkedSource, ignoreTooLarge);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: oldContents,
        cacheKey: `${sourceCacheNamespace(chunkedSource)}:old:src/old-name.ts`,
      },
      newFile: {
        name: "src/new-name.ts",
        contents: newContents,
        cacheKey: `${sourceCacheNamespace(chunkedSource)}:new:src/new-name.ts`,
      },
    });
    await expect(load(fileDiff())).resolves.toMatchObject({
      oldFile: { contents: oldContents },
      newFile: { contents: newContents },
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("hydrates a pure rename from its one shared snapshot", async () => {
    const contents = "unchanged\n";
    const bytes = Buffer.from(contents);
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "rename-snapshot",
          totalBytes: bytes.byteLength,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "rename-snapshot",
        offset: 0,
        totalBytes: bytes.byteLength,
        encoding: "base64" as const,
        decodedBytes: bytes.byteLength,
        dataBase64: bytes.toString("base64"),
        nextOffset: null,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(open, read, SOURCE, ignoreTooLarge);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents },
    });
  });

  it("decompresses gzip chunks before assembling file contents", async () => {
    const contents = "repeated source line\n".repeat(100);
    const bytes = new TextEncoder().encode(contents);
    const compressed = await new Response(
      new Blob([bytes.slice().buffer]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "gzip-snapshot",
          totalBytes: bytes.byteLength,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "gzip-snapshot",
        offset: 0,
        totalBytes: bytes.byteLength,
        encoding: "gzip-base64" as const,
        decodedBytes: bytes.byteLength,
        dataBase64: Buffer.from(compressed).toString("base64"),
        nextOffset: null,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(
      open,
      read,
      {
        ...SOURCE,
        cacheKey: "gzip-comparison",
      },
      ignoreTooLarge,
    );

    await expect(load(fileDiff("new"))).resolves.toMatchObject({
      oldFile: { contents: "" },
      newFile: { contents },
    });
  });

  it("assembles UTF-8 characters split across chunk boundaries", async () => {
    const contents = "a🙂b";
    const bytes = new TextEncoder().encode(contents);
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "utf8-snapshot",
          totalBytes: bytes.byteLength,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async ({ input }: { input: { snapshotId: string; offset: number } }) => {
      const nextOffset = Math.min(input.offset + 2, bytes.byteLength);
      const chunk = bytes.subarray(input.offset, nextOffset);
      return AsyncResult.success({
        snapshotId: input.snapshotId,
        offset: input.offset,
        totalBytes: bytes.byteLength,
        encoding: "base64" as const,
        decodedBytes: chunk.byteLength,
        dataBase64: Buffer.from(chunk).toString("base64"),
        nextOffset: nextOffset < bytes.byteLength ? nextOffset : null,
      });
    });
    const load = createChunkedGitDiffFileContentsLoader(
      open,
      read,
      {
        ...SOURCE,
        cacheKey: "utf8-comparison",
      },
      ignoreTooLarge,
    );

    await expect(load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents },
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["snapshot id", { snapshotId: "wrong-snapshot" }],
    ["offset", { offset: 1 }],
    ["total byte count", { totalBytes: 4 }],
    ["decoded byte count", { decodedBytes: 2 }],
    ["next offset", { nextOffset: 2 }],
  ] as const)("rejects a chunk with a mismatched %s", async (_label, override) => {
    const contents = "abc";
    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "invalid-frame-snapshot",
          totalBytes: 3,
          contentHash: sha256(contents),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "invalid-frame-snapshot",
        offset: 0,
        totalBytes: 3,
        encoding: "base64" as const,
        decodedBytes: 3,
        dataBase64: Buffer.from(contents).toString("base64"),
        nextOffset: null,
        ...override,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(
      open,
      read,
      {
        ...SOURCE,
        cacheKey: `invalid-frame-${_label}`,
      },
      ignoreTooLarge,
    );

    await expect(load(fileDiff("new"))).rejects.toThrow("Invalid review file chunk.");
  });

  it("rejects empty, incomplete, corrupted, and hash-mismatched snapshots", async () => {
    const cases = [
      {
        cacheKey: "empty-chunk",
        contentHash: sha256("abc"),
        chunk: { dataBase64: "", decodedBytes: 0, nextOffset: null },
        message: "Invalid review file chunk.",
      },
      {
        cacheKey: "incomplete-chunk",
        contentHash: sha256("abc"),
        chunk: {
          dataBase64: Buffer.from("ab").toString("base64"),
          decodedBytes: 2,
          nextOffset: null,
        },
        message: "Incomplete review file snapshot.",
      },
      {
        cacheKey: "hash-mismatch",
        contentHash: sha256("abd"),
        chunk: {
          dataBase64: Buffer.from("abc").toString("base64"),
          decodedBytes: 3,
          nextOffset: null,
        },
        message: "Invalid review file snapshot hash.",
      },
    ];

    for (const testCase of cases) {
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: {
            snapshotId: `${testCase.cacheKey}-snapshot`,
            totalBytes: 3,
            contentHash: testCase.contentHash,
          },
        }),
      );
      const read = vi.fn(async () =>
        AsyncResult.success({
          snapshotId: `${testCase.cacheKey}-snapshot`,
          offset: 0,
          totalBytes: 3,
          encoding: "base64" as const,
          ...testCase.chunk,
        }),
      );
      const load = createChunkedGitDiffFileContentsLoader(
        open,
        read,
        {
          ...SOURCE,
          cacheKey: testCase.cacheKey,
        },
        ignoreTooLarge,
      );

      await expect(load(fileDiff("new"))).rejects.toThrow(testCase.message);
    }

    const open = vi.fn(async () =>
      AsyncResult.success({
        _tag: "opened" as const,
        oldFile: null,
        newFile: {
          snapshotId: "corrupt-gzip-snapshot",
          totalBytes: 3,
          contentHash: sha256("abc"),
        },
      }),
    );
    const read = vi.fn(async () =>
      AsyncResult.success({
        snapshotId: "corrupt-gzip-snapshot",
        offset: 0,
        totalBytes: 3,
        encoding: "gzip-base64" as const,
        decodedBytes: 3,
        dataBase64: Buffer.from("not gzip").toString("base64"),
        nextOffset: null,
      }),
    );
    const load = createChunkedGitDiffFileContentsLoader(
      open,
      read,
      {
        ...SOURCE,
        cacheKey: "corrupt-gzip",
      },
      ignoreTooLarge,
    );

    await expect(load(fileDiff("new"))).rejects.toThrow();
  });

  it("isolates completed file caches by environment and repository", async () => {
    const makeLoader = (environmentId: string, cwd: string, contents: string) => {
      const bytes = Buffer.from(contents);
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: {
            snapshotId: `${environmentId}-snapshot`,
            totalBytes: bytes.byteLength,
            contentHash: sha256(contents),
          },
        }),
      );
      const read = vi.fn(async () =>
        AsyncResult.success({
          snapshotId: `${environmentId}-snapshot`,
          offset: 0,
          totalBytes: bytes.byteLength,
          encoding: "base64" as const,
          decodedBytes: bytes.byteLength,
          dataBase64: bytes.toString("base64"),
          nextOffset: null,
        }),
      );
      return {
        load: createChunkedGitDiffFileContentsLoader(
          open,
          read,
          {
            ...SOURCE,
            environmentId: EnvironmentId.make(environmentId),
            cwd,
            cacheKey: "shared-diff-hash",
          },
          ignoreTooLarge,
        ),
        open,
      };
    };
    const first = makeLoader("environment-cache-a", "/workspace/a", "first repo\n");
    const second = makeLoader("environment-cache-b", "/workspace/b", "second repo\n");

    await expect(first.load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents: "first repo\n" },
    });
    await expect(second.load(fileDiff("new"))).resolves.toMatchObject({
      newFile: { contents: "second repo\n" },
    });
    expect(first.open).toHaveBeenCalledTimes(1);
    expect(second.open).toHaveBeenCalledTimes(1);
  });

  it("bounds cached empty files by entry count", async () => {
    const loaders = Array.from({ length: 129 }, (_, index) => {
      const snapshotId = `empty-snapshot-${index}`;
      const open = vi.fn(async () =>
        AsyncResult.success({
          _tag: "opened" as const,
          oldFile: null,
          newFile: { snapshotId, totalBytes: 0, contentHash: sha256("") },
        }),
      );
      return {
        open,
        load: createChunkedGitDiffFileContentsLoader(
          open,
          vi.fn(async () => {
            throw new Error("empty snapshots should not request chunks");
          }),
          { ...SOURCE, cacheKey: `empty-cache-${index}` },
          ignoreTooLarge,
        ),
      };
    });

    for (const loader of loaders) {
      await loader.load(fileDiff("new"));
    }
    await loaders[0]!.load(fileDiff("new"));

    expect(loaders[0]!.open).toHaveBeenCalledTimes(2);
    expect(loaders.at(-1)!.open).toHaveBeenCalledTimes(1);
  });
});
