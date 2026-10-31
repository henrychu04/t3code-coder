import {
  changeRequestReferenceAutolinker,
  resolveGitLabUploadUrl,
} from "@t3tools/client-runtime/pull-request-markdown";
import {
  sourceControlClients,
  type ReferenceAutolink,
} from "@t3tools/client-runtime/source-control-clients";
import type { PluggableList } from "unified";

export {
  splitPullRequestBody,
  type PullRequestBodySegment,
} from "@t3tools/client-runtime/pull-request-markdown";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: unknown;
};

const AUTOLINK_IGNORED_TYPES = new Set(["link", "linkReference"]);

export function remarkPullRequestAutolinks(options: {
  readonly autolinks: (text: string) => ReadonlyArray<ReferenceAutolink>;
}) {
  const visit = (node: MarkdownNode): void => {
    const children = node.children;
    if (children === undefined) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (AUTOLINK_IGNORED_TYPES.has(child.type)) continue;
      if (child.type !== "text" || child.value === undefined) {
        visit(child);
        continue;
      }
      const value = child.value;
      const links = options.autolinks(value);
      if (links.length === 0) continue;
      const replacements: MarkdownNode[] = [];
      let start = 0;
      for (const link of links) {
        if (start < link.index) {
          replacements.push({ type: "text", value: value.slice(start, link.index) });
        }
        replacements.push({
          type: "link",
          url: link.url,
          data: { hProperties: { dataPullRequestAutolink: link.kind } },
          children: [{ type: "text", value: link.label }],
        });
        start = link.index + link.text.length;
      }
      if (start < value.length) replacements.push({ type: "text", value: value.slice(start) });
      children.splice(index, 1, ...replacements);
      index += replacements.length - 1;
    }
  };
  return (tree: MarkdownNode) => visit(tree);
}

type MarkdownUrlNode = { type: string; url?: string; children?: MarkdownUrlNode[] };

const UPLOAD_URL_NODE_TYPES = new Set(["image", "link", "definition"]);

/** Coder: GitLab writes pasted files into Markdown as `/uploads/…` images and links. */
function remarkGitLabUploads(options: { readonly repositoryUrl: string }) {
  const visit = (node: MarkdownUrlNode): void => {
    if (UPLOAD_URL_NODE_TYPES.has(node.type) && node.url !== undefined) {
      node.url = resolveGitLabUploadUrl(node.url, options.repositoryUrl) ?? node.url;
    }
    node.children?.forEach(visit);
  };
  return (tree: MarkdownUrlNode) => visit(tree);
}

const NO_AUTOLINK_PLUGINS: PluggableList = [];
const autolinkPlugins = new Map<string, PluggableList>();

/**
 * One plugin list per repository, so every comment of a pull request shares one markdown
 * renderer and its parse cache instead of parsing again on each render.
 */
export function pullRequestAutolinkPlugins(
  changeRequest: { readonly provider: string; readonly url: string } | null,
): PluggableList {
  if (changeRequest === null) return NO_AUTOLINK_PLUGINS;
  const repositoryUrl = sourceControlClients.parseChangeRequestUrl(changeRequest.url)?.link
    .repositoryUrl;
  if (repositoryUrl === undefined) return NO_AUTOLINK_PLUGINS;
  const key = `${changeRequest.provider}\u0000${repositoryUrl}`;
  let plugins = autolinkPlugins.get(key);
  if (plugins === undefined) {
    const autolinks = changeRequestReferenceAutolinker(changeRequest);
    plugins = autolinks ? [[remarkPullRequestAutolinks, { autolinks }]] : [];
    // Coder: GitLab's root-relative `/uploads/…` links resolve against the repository.
    plugins.push([remarkGitLabUploads, { repositoryUrl }]);
    autolinkPlugins.set(key, plugins);
  }
  return plugins;
}
