// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { InlineButton } from "./ui/button";
import { ThreadPullRequestBadgeControl } from "./ThreadStatusIndicators";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderBadge(badge: Parameters<typeof ThreadPullRequestBadgeControl>[0]["badge"]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const onOpenList = vi.fn();
  const onOpenPullRequest = vi.fn((event: React.MouseEvent<HTMLElement>) => event.preventDefault());
  act(() =>
    root!.render(
      <ThreadPullRequestBadgeControl
        render={<InlineButton />}
        badge={badge}
        number={7}
        url="https://gitlab.example/group/repo/-/merge_requests/7"
        status={null}
        onOpenList={onOpenList}
        onOpenPullRequest={onOpenPullRequest}
      />,
    ),
  );
  return { onOpenList, onOpenPullRequest };
}

it("opens the linked list for multiple unrelated MRs", () => {
  const callbacks = renderBadge({ kind: "pull-request", others: 2, state: "merged" });
  const button = container!.querySelector("button")!;
  expect(button.textContent).toBe("+3");
  expect(button.getAttribute("aria-label")).toContain("MR !7");
  expect(button.getAttribute("aria-label")).toContain("overall merged");
  act(() => button.click());
  expect(callbacks.onOpenList).toHaveBeenCalledOnce();
  expect(callbacks.onOpenPullRequest).not.toHaveBeenCalled();
  expect(container!.querySelector("a")).toBeNull();
});

it("opens the linked list for a derived chain and shows the layer count", () => {
  const callbacks = renderBadge({ kind: "stack", layers: 3, state: "draft" });
  const button = container!.querySelector("button")!;
  expect(button.textContent).toBe("3");
  expect(button.getAttribute("aria-label")).toContain("3 merge requests");
  act(() => button.click());
  expect(callbacks.onOpenList).toHaveBeenCalledOnce();
});

it("keeps a single MR as a safe new-tab link and forwards modifier clicks", () => {
  const callbacks = renderBadge({ kind: "pull-request", others: 0, state: "open" });
  const link = container!.querySelector("a")!;
  expect(link.textContent).toBe("7");
  expect(link.rel).toBe("noopener noreferrer");
  expect(link.target).toBe("_blank");
  act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })));
  expect(callbacks.onOpenList).not.toHaveBeenCalled();
  expect(callbacks.onOpenPullRequest.mock.calls[0]?.[0].metaKey).toBe(true);
});
