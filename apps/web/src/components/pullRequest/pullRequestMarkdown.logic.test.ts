import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";

import { remarkPullRequestAutolinks } from "./pullRequestMarkdown.logic";

describe("GitLab merge request markdown autolinks", () => {
  it("links same-project merge requests, issues, and full commit ids", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const tree: MarkdownNode = {
      type: "root",
      children: [{ type: "text", value: `See !42, #17, and ${commit}.` }],
    };

    remarkPullRequestAutolinks({ repositoryUrl: "https://gitlab.example/group/project/" })(tree);

    expect(tree.children).toEqual([
      { type: "text", value: "See " },
      {
        type: "link",
        url: "https://gitlab.example/group/project/-/merge_requests/42",
        data: { hProperties: { dataPullRequestAutolink: "merge-request" } },
        children: [{ type: "text", value: "!42" }],
      },
      { type: "text", value: ", " },
      {
        type: "link",
        url: "https://gitlab.example/group/project/-/issues/17",
        data: { hProperties: { dataPullRequestAutolink: "issue" } },
        children: [{ type: "text", value: "#17" }],
      },
      { type: "text", value: ", and " },
      {
        type: "link",
        url: `https://gitlab.example/group/project/-/commit/${commit}`,
        data: { hProperties: { dataPullRequestAutolink: "commit" } },
        children: [{ type: "text", value: "0123456" }],
      },
      { type: "text", value: "." },
    ]);
  });

  it("leaves authored links and word-like reference fragments alone", () => {
    const tree: MarkdownNode = {
      type: "root",
      children: [
        { type: "text", value: "team!42 abc#17" },
        {
          type: "link",
          url: "https://example.com",
          children: [{ type: "text", value: "!9" }],
        },
      ],
    };

    remarkPullRequestAutolinks({ repositoryUrl: "https://gitlab.example/group/project" })(tree);

    expect(tree.children).toEqual([
      { type: "text", value: "team!42 abc#17" },
      {
        type: "link",
        url: "https://example.com",
        children: [{ type: "text", value: "!9" }],
      },
    ]);
  });
});
