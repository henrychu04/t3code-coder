import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { type AssetResource, EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";

const requested = vi.hoisted(() => [] as Array<AssetResource | null>);
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => {
    requested.push(resource);
    return { _tag: "Loading" };
  },
}));

function setup() {
  requested.length = 0;
}

// Coder: only GitLab's definition is registered, so the hosts that break single newlines are
// represented by a context with `lineBreaks` set, and the context carries `repositoryUrl`.
async function renderBody(
  host: string | { readonly hardLineBreaks: boolean },
  options: { lineBreaks?: boolean; repository?: string; text?: string } = {},
) {
  const { repository = null, text = "first line\nsecond line", ...props } = options;
  const context = {
    remarkPlugins: [],
    lineBreaks:
      typeof host === "string"
        ? (sourceControlClients.get(host).hardLineBreaks ?? false)
        : host.hardLineBreaks,
    repositoryUrl: null,
    threadRef: null,
    repository,
  };
  return render(
    <PullRequestMarkdownContext value={context}>
      <PullRequestMarkdown
        text={text}
        cwd="/repo"
        environmentId={EnvironmentId.make("local")}
        {...props}
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

// Coder: GitLab uploads stand in for GitHub's user attachments.
it("loads the body's host media in the pull request's repository, not the checkout's", async () => {
  setup();
  const image =
    "https://gitlab.com/group/project/uploads/7195f96351a94331be743e06be760422/shot.png";
  const video =
    "https://gitlab.com/group/project/uploads/2f8c1a901b2c4d5e8f90abcdef123456/clip.mp4";
  await using _screen = await renderBody("gitlab", {
    repository: "enterprise/private",
    text: `![shot](${image})\n\n${video}`,
  });
  await vi.waitFor(() =>
    expect(requested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("7195f963"),
          repository: "enterprise/private",
        }),
        expect.objectContaining({
          cwd: "/repo",
          url: expect.stringContaining("2f8c1a90"),
          repository: "enterprise/private",
        }),
      ]),
    ),
  );
});
