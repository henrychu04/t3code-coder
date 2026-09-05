// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ProjectTextSearchResult } from "@t3tools/contracts";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { useProjectTextSearch } from "./queries";

const state = vi.hoisted(() => ({
  reads: [] as (string | undefined)[],
  failFirstPage: false,
  successfulReads: 0,
}));
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Effect = await import("effect/Effect");
  const search = Atom.family((key: string) =>
    Atom.make(
      Effect.suspend(() => {
        const { input } = JSON.parse(key);
        state.reads.push(input.cursor);
        if (input.cursor || state.failFirstPage)
          return Effect.fail(new Error("Search continuation expired."));
        state.successfulReads += 1;
        return Effect.succeed({
          matches: [
            {
              path: "file.txt",
              lineNumber: 1,
              lineContent: `result ${state.successfulReads}`,
              matchRanges: [{ start: 0, end: 6 }],
            },
          ],
          truncated: true,
          nextCursor: `cursor-${state.successfulReads}`,
        } satisfies ProjectTextSearchResult);
      }),
    ).pipe(Atom.swr({ staleTime: 5_000, revalidateOnMount: true }), Atom.setIdleTTL(5 * 60_000)),
  );
  return {
    projectEnvironment: { searchText: (request: unknown) => search(JSON.stringify(request)) },
  };
});

it("restarts an expired page without reusing cached results, and permits retry after a first-page failure", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetAppAtomRegistryForTests();
  state.reads = [];
  state.successfulReads = 0;
  state.failFirstPage = false;
  let result!: ReturnType<typeof useProjectTextSearch>;
  function Consumer() {
    result = useProjectTextSearch({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      cwd: "/project",
      query: "result",
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <AppAtomRegistryProvider>
          <Consumer />
        </AppAtomRegistryProvider>,
      );
    });
    expect(result.matches[0]?.lineContent).toBe("result 1");
    await act(async () => {
      result.loadMore();
    });
    expect(state.reads).toContain("cursor-1");
    expect(state.reads.filter((cursor) => cursor === undefined)).toHaveLength(2);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineContent).toBe("result 2");
    expect(result.error).toBeNull();

    state.failFirstPage = true;
    await act(async () => {
      result.loadMore();
    });
    expect(state.reads).toContain("cursor-2");
    expect(result.error).not.toBeNull();
    state.failFirstPage = false;
    await act(async () => {
      result.restartSearch();
    });
    expect(result.error).toBeNull();
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.lineContent).toBe("result 3");
  } finally {
    await act(async () => root.unmount());
    resetAppAtomRegistryForTests();
    vi.unstubAllGlobals();
  }
});
