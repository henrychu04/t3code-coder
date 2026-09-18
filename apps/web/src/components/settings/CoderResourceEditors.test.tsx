// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CoderProfileConfig, CoderPortForwardProfile } from "../../coder/api";
import { DeploymentEditor } from "./CoderDeploymentSettings";
import { PortForwardEditor } from "./PortForwardSettings";
const deployment = { id: "domain", name: "Work", url: "https://coder.example.com" };
const workspace = {
  id: "workspace",
  name: "Workspace",
  workspace: "owner/workspace",
  deploymentId: "domain",
};
const rule: CoderPortForwardProfile = {
  id: "forward",
  workspaceId: "workspace",
  protocol: "tcp",
  localPort: 3000,
  remotePort: 5173,
};
let config: CoderProfileConfig;
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  config = { version: 1, deployments: [deployment], workspaces: [workspace], portForwards: [rule] };
  close.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function assertAssociatedLabels() {
  const labels = Array.from(document.querySelectorAll("label"));
  expect(labels.length).toBeGreaterThan(0);
  for (const label of labels) {
    expect(label.htmlFor).not.toBe("");
    expect(document.getElementById(label.htmlFor)?.matches("input, select")).toBe(true);
  }
}
it("associates every deployment field and preserves its draft when saving fails", async () => {
  const update = vi.fn(async () => {
    throw new Error("Domain could not be reached");
  });
  await act(async () =>
    root.render(<DeploymentEditor deployment={deployment} updateConfig={update} onClose={close} />),
  );
  assertAssociatedLabels();
  await submit();
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Could not save domain");
  expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Work");
  expect(document.querySelector("details")?.textContent).toContain("Domain could not be reached");
});
it("edits an existing forward without changing its ID or duplicating it", async () => {
  await act(async () =>
    root.render(
      <PortForwardEditor
        rule={rule}
        existingRules={[rule]}
        workspaces={[workspace]}
        updateConfig={async (update) => {
          config = update(config);
        }}
        onClose={close}
      />,
    ),
  );
  assertAssociatedLabels();
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  await act(async () => {
    const protocol = document.querySelectorAll("select")[1]!;
    protocol.value = "udp";
    protocol.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await submit();
  expect(config.portForwards).toEqual([{ ...rule, protocol: "udp" }]);
  expect(close).toHaveBeenCalledTimes(1);
});
it("blocks duplicate local ports for the same protocol", async () => {
  await act(async () =>
    root.render(
      <PortForwardEditor
        rule={null}
        existingRules={[rule]}
        workspaces={[workspace]}
        updateConfig={vi.fn()}
        onClose={close}
      />,
    ),
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(document.body.textContent).toContain("already configured");
});
it("rechecks workspace existence against the latest configuration before saving", async () => {
  const latest = { ...config, workspaces: [] };
  await act(async () =>
    root.render(
      <PortForwardEditor
        rule={rule}
        existingRules={[rule]}
        workspaces={[workspace]}
        updateConfig={async (update) => {
          update(latest);
        }}
        onClose={close}
      />,
    ),
  );
  await submit();
  expect(close).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("The selected workspace connection was removed");
});
