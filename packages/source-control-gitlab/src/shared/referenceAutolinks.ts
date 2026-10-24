import type { ReferenceAutolink } from "@t3tools/source-control-core/shared/definition";

// Coder: GitLab's same-project references: `!12` is a merge request, `#12` an issue, and a full
// 40-character SHA a commit, each linked below the project with GitLab's `/-/` routes.
const CANDIDATE = /![1-9]\d*|#[1-9]\d*|[0-9a-f]{40}/giu;
const WORD_CHARACTER = /[A-Za-z0-9_]/u;
const COMMIT_PREFIX = /[\s([{]/u;
const SHORT_SHA_LENGTH = 7;

export function gitLabReferenceAutolinks(
  text: string,
  repositoryUrl: string,
): ReadonlyArray<ReferenceAutolink> {
  const base = repositoryUrl.replace(/\/+$/u, "");
  if (!/^https?:\/\//iu.test(base)) return [];
  const links: ReferenceAutolink[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const matched = match[0];
    const reference = matched.startsWith("!") || matched.startsWith("#");
    const before = text[match.index - 1];
    const after = text[match.index + matched.length];
    if (
      (before !== undefined &&
        (reference ? WORD_CHARACTER.test(before) : !COMMIT_PREFIX.test(before))) ||
      (after !== undefined && WORD_CHARACTER.test(after))
    ) {
      continue;
    }
    if (reference) {
      const route = matched.startsWith("!") ? "merge_requests" : "issues";
      links.push({
        index: match.index,
        text: matched,
        label: matched,
        url: `${base}/-/${route}/${matched.slice(1)}`,
        kind: "reference",
      });
    } else {
      links.push({
        index: match.index,
        text: matched,
        label: matched.slice(0, SHORT_SHA_LENGTH),
        url: `${base}/-/commit/${matched}`,
        kind: "commit",
      });
    }
  }
  return links;
}
