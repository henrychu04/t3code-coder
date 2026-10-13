import {
  findAndReplaceText,
  type MarkdownNode,
  type TextMatch,
} from "~/vendor/mdast-find-and-replace";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

// Coder: GitLab references merge requests as `!123`; `#123` is an issue.
const AUTOLINK_CANDIDATE_PATTERN = /![1-9]\d*|#[1-9]\d*|[0-9a-f]{40}/giu;
const AUTOLINK_WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/u;
const AUTOLINK_COMMIT_PREFIX_PATTERN = /[\s([{]/u;
const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

/** GitLab same-repository references for merge-request prose, never code or authored links. */
export function remarkPullRequestAutolinks(options: { readonly repositoryUrl: string }) {
  const repositoryUrl = options.repositoryUrl.replace(/\/+$/u, "");
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      AUTOLINK_CANDIDATE_PATTERN,
      (matched: string, match: TextMatch) => {
        const reference = matched.startsWith("!") || matched.startsWith("#");
        const before = match.input[match.index - 1];
        const after = match.input[match.index + matched.length];
        if (
          (before !== undefined &&
            (reference
              ? AUTOLINK_WORD_CHARACTER_PATTERN.test(before)
              : !AUTOLINK_COMMIT_PREFIX_PATTERN.test(before))) ||
          (after !== undefined && AUTOLINK_WORD_CHARACTER_PATTERN.test(after))
        ) {
          return false;
        }
        const kind = matched.startsWith("!")
          ? "merge-request"
          : matched.startsWith("#")
            ? "issue"
            : "commit";
        const url =
          kind === "merge-request"
            ? `${repositoryUrl}/-/merge_requests/${matched.slice(1)}`
            : kind === "issue"
              ? `${repositoryUrl}/-/issues/${matched.slice(1)}`
              : `${repositoryUrl}/-/commit/${matched}`;
        return {
          type: "link",
          url,
          data: { hProperties: { dataPullRequestAutolink: kind } },
          children: [{ type: "text", value: kind === "commit" ? matched.slice(0, 7) : matched }],
        };
      },
      AUTOLINK_IGNORED_TYPES,
    );
  };
}
