import {
  EnvironmentId,
  MessageId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type AssistantCitation,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "./assistantCitationNavigation";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "first line\n\tsecond line (with a #hash & spaces) 🚀",
  start: 12,
  end: 59,
  prefix: "Before:\n",
  suffix: "\nAfter.",
};

function createCitationRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("assistant citation navigation", () => {
  it("navigates a sendable citation with long Unicode text and comment", async () => {
    const longCitation = {
      ...citation,
      text: "界".repeat(6000),
      comment: "評".repeat(6000),
      start: 0,
      end: 6000,
    };
    expect(serializeAssistantCitation(longCitation).length).toBeLessThan(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(longCitation));
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(longCitation);
  });

  it("preserves encoded quote whitespace through router navigation and reload", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation));

    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
    let href = router.history.location.href;
    for (let reload = 0; reload < 3; reload++) {
      const reloaded = createCitationRouter(href);
      await reloaded.load();
      // Route normalization rebuilds the current location from its decoded hash.
      await reloaded.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: citation.environmentId, threadId: citation.threadId },
        hash: true,
        replace: true,
      });
      href = reloaded.history.location.href;
      expect(assistantCitationFromLocation(href)).toEqual(citation);
    }
  });

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation));
    const previous = router.state.location;
    await router.navigate(assistantCitationNavigation(citation));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
  });

  it("ignores non-citation fragments and missing fragments", () => {
    expect(assistantCitationFromLocation("/environment-one/thread-one")).toBeNull();
    expect(
      assistantCitationFromLocation("/environment-one/thread-one#ordinary-heading"),
    ).toBeNull();
    expect(assistantCitationFromLocation("/a/b#assistant-citation=%invalid")).toBeNull();
    expect(
      assistantCitationFromLocation(`/a/b#assistant-citation=${"a".repeat(140_000)}`),
    ).toBeNull();
  });
});
