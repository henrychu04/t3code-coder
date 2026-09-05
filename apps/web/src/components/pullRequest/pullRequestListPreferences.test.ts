import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pullRequestListPreferences,
  readPullRequestListPreferences,
  restorePullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";

describe("remembered pull request list controls", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
    };
  };

  it("restores presentation controls without persisting repository or search content", () => {
    const storage = makeStorage();
    const preferences = {
      involvement: "reviewing",
      state: "merged",
      environmentId: "env-1" as EnvironmentId,
      projectId: "project-1" as ProjectId,
      host: "gitlab.example.com",
      q: "workflow",
      draft: "hide",
      review: "approved",
      checks: "passing",
      author: "reviewer",
      labels: ["bug", "priority"],
      sort: "largest",
    } as const;

    writePullRequestListPreferences(preferences, storage);
    const presentation = {
      involvement: "reviewing",
      state: "merged",
      draft: "hide",
      review: "approved",
      checks: "passing",
      sort: "largest",
    };
    expect(readPullRequestListPreferences(storage)).toEqual(presentation);
    expect(JSON.parse(storage.getItem("t3.pullRequests.preferences")!)).toEqual(presentation);
    // Existing installations are scrubbed on read, not just on the next filter change.
    storage.setItem("t3.pullRequests.preferences", JSON.stringify(preferences));
    expect(readPullRequestListPreferences(storage)).toEqual(presentation);
    expect(JSON.parse(storage.getItem("t3.pullRequests.preferences")!)).toEqual(presentation);
  });

  it("omits the default sort while retaining an explicit recency sort", () => {
    expect(
      pullRequestListPreferences({ involvement: "all", state: "open", sort: "ready" }),
    ).toEqual({ involvement: "all", state: "open" });
    expect(
      pullRequestListPreferences({ involvement: "all", state: "open", sort: "updated" }),
    ).toEqual({ involvement: "all", state: "open", sort: "updated" });
  });

  it("restores direct visits without overriding explicit URL controls or restoring content", () => {
    const storage = makeStorage();
    storage.setItem(
      "t3.pullRequests.preferences",
      JSON.stringify({
        involvement: "reviewing",
        state: "merged",
        sort: "updated",
        q: "old secret",
        host: "private",
      }),
    );
    expect(restorePullRequestListPreferences({}, storage)).toEqual({
      involvement: "reviewing",
      state: "merged",
      sort: "updated",
    });
    expect(restorePullRequestListPreferences({ q: "current query" }, storage)).toEqual({
      involvement: "reviewing",
      state: "merged",
      sort: "updated",
      q: "current query",
    });
    expect(restorePullRequestListPreferences({ state: "open", sort: "ready" }, storage)).toEqual({
      state: "open",
      sort: "ready",
    });
    expect(storage.getItem("t3.pullRequests.preferences")).not.toContain("secret");
  });

  it("falls back when storage is corrupt or unavailable", () => {
    const storage = makeStorage();
    storage.setItem("t3.pullRequests.preferences", "{not json");
    expect(readPullRequestListPreferences(storage)).toEqual({ involvement: "all", state: "open" });

    const denied = {
      getItem: () => {
        throw new Error("storage denied");
      },
      setItem: () => {
        throw new Error("storage denied");
      },
    };
    expect(readPullRequestListPreferences(denied)).toEqual({ involvement: "all", state: "open" });
    expect(() =>
      writePullRequestListPreferences({ involvement: "all", state: "open" }, denied),
    ).not.toThrow();
  });
});
