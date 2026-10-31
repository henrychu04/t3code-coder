import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

// Coder: only GitLab's definition is registered, so the hosts that break single newlines are
// represented by a context with `lineBreaks` set, and the context carries `repositoryUrl`.
async function renderBody(
  host: string | { readonly hardLineBreaks: boolean },
  options: { lineBreaks?: boolean } = {},
) {
  const context = {
    remarkPlugins: [],
    lineBreaks:
      typeof host === "string"
        ? (sourceControlClients.get(host).hardLineBreaks ?? false)
        : host.hardLineBreaks,
    repositoryUrl: null,
    threadRef: null,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={"first line\nsecond line"}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...options}
      />
    </PullRequestMarkdownContext>,
  );
}

it("a host with hard line breaks breaks a single newline", async () => {
  await using screen = await renderBody({ hardLineBreaks: true });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(1);
});

it.each(["gitlab", "unknown"])("%s joins a single newline", async (host) => {
  await using screen = await renderBody(host);
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});

it("lets text the host did not write opt out of the host's breaks", async () => {
  await using screen = await renderBody({ hardLineBreaks: true }, { lineBreaks: false });
  await expect.element(screen.getByText(/first line/)).toBeInTheDocument();
  expect(screen.container.querySelectorAll("p br")).toHaveLength(0);
});
