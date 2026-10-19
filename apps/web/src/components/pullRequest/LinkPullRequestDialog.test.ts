import { describe, expect, it } from "vite-plus/test";

import { resolveLinkPullRequestInput } from "@t3tools/client-runtime/pull-request-link-input";

import { resolveLinkPullRequestProject } from "./LinkPullRequestDialog";

// Coder: the dialog builds bare-number MR URLs with `gitLabMergeRequestBrowserUrl`.
describe("resolveLinkPullRequestProject", () => {
  it.each(["http://code.example:8080", "https://code.example:8443"])(
    "preserves %s when linking a bare MR number",
    (origin) => {
      const ownProject = resolveLinkPullRequestProject({
        provider: "gitlab",
        canonicalKey: "code.example/team/frontend",
        displayName: "team/frontend",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `${origin}/team/frontend.git`,
        },
      });
      expect(
        resolveLinkPullRequestInput({
          reference: "42",
          project: ownProject,
          hasProject: () => true,
        }),
      ).toEqual({
        link: {
          host: "code.example",
          repository: "team/frontend",
          number: 42,
          url: `${origin}/team/frontend/-/merge_requests/42`,
        },
      });
    },
  );
});
