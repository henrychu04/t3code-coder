// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("keeps common decisions visible and exposes session-scoped approval in the overflow menu", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const respond = vi.fn(async () => undefined);
    try {
      await act(async () =>
        root.render(
          <ComposerPendingApprovalActions
            requestId={ApprovalRequestId.make("approval")}
            isResponding={false}
            onRespondToApproval={respond}
          />,
        ),
      );
      expect(container.textContent).toContain("Approve");
      expect(container.textContent).toContain("Decline");
      const more = container.querySelector<HTMLButtonElement>(
        'button[aria-label="More approval options"]',
      )!;
      await act(async () => more.click());
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Always allow this session"),
      );
      const option = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
        item.textContent?.includes("Always allow this session"),
      )!;
      await act(async () => option.click());
      expect(respond).toHaveBeenCalledWith(ApprovalRequestId.make("approval"), "acceptForSession");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
