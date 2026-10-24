import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkPullRequestAutolinks } from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

// Coder: GitLab is the only host, so the autolinks follow GitLab's grammar.
function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "gitlab",
    url: "https://gitlab.example/group/project/-/merge_requests/8",
  })!;
  const tree = unified().use(remarkParse).parse(markdown) as Node;
  remarkPullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, string | undefined, unknown]> = [];
  const visit = (node: Node) => {
    if (node.type === "link") {
      found.push([
        node.children?.[0]?.value,
        node.url,
        node.data?.hProperties?.["dataPullRequestAutolink"],
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("remarkPullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(links(`See !42, #17, and **${commit}**. [!13](https://example.com) \`#14\``)).toEqual([
      ["!42", "https://gitlab.example/group/project/-/merge_requests/42", "reference"],
      ["#17", "https://gitlab.example/group/project/-/issues/17", "reference"],
      ["0123456", `https://gitlab.example/group/project/-/commit/${commit}`, "commit"],
      ["!13", "https://example.com", undefined],
    ]);
  });

  it("leaves word-like reference fragments alone", () => {
    expect(links("team!42 abc#17")).toEqual([]);
  });
});
