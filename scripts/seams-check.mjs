// Checks that docs/internals/coder-only.md still describes the fork's delta from upstream.
//
//   node scripts/seams-check.mjs [upstream base]
//
// (a) Every backticked path or identifier in the "Upstream seams" and "Cut surfaces" sections
//     exists in the checkout (tracked files) or in the upstream base tree, so an entry for code that is gone from both
//     is reported as stale.
// (b) Every upstream file the fork modified (outside tests and docs) either has a `Coder:` marker
//     in a line the fork added, is named in coder-only.md, or differs only by the merge-request
//     wording swap the seams doc exempts from markers.
//
// The base defaults to SYNC_BASE, the upstream commit of the last sync (sync.md section 8 bumps
// it). Exits 1 when either check reports something.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SYNC_BASE = "80a2351fcb";
const base = process.argv[2] ?? SYNC_BASE;
const DOC = "docs/internals/coder-only.md";
const SECTIONS = ["Upstream seams", "Cut surfaces"];

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, shell: false });

const doc = readFileSync(DOC, "utf8");
const sectionText = (title) => {
  const start = doc.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`${DOC} has no "## ${title}" section`);
  const end = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
};
const tokensOf = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

// --- (a) names in the seams sections exist in the checkout or the base ---

const split = (out) => out.split("\0").filter(Boolean);
const checkoutFiles = split(git("ls-files", "-z"));
// The doc names files by their tail, often package-relative without `src/`
// (`contracts/assets.ts` for `packages/contracts/src/assets.ts`), so each path is also listed
// without its first `src/` segment.
const trees = [
  ...new Set([...checkoutFiles, ...split(git("ls-tree", "-r", "--name-only", "-z", base))]),
].flatMap((file) => [`/${file}`, `/${file.replace("/src/", "/")}`]);
const PATH_EXTENSION =
  /\.(?:[cm]?[jt]sx?|json|jsonc|md|css|html|patch|ya?ml|sql|sh|wasm|mp3|svg|png)$/;

// A path token names a file or directory by its tail (`ws.ts`, `state/primaryEnvironment.ts`,
// `apps/server/src/guest/**`); a trailing `/` or `*` matches any continuation.
const pathExists = (token) => {
  const tail = `/${token.replace(/\/\*\*$/, "/").replace(/^\.?\//, "")}`;
  const needle = tail.replace(/\*$/, "");
  return tail.endsWith("*") || tail.endsWith("/")
    ? trees.some((file) => file.includes(needle))
    : trees.some((file) => file.endsWith(needle) || `${file}/`.includes(`${needle}/`));
};

// Tokens that are prose, commands, URLs, or literals rather than names.
const skip = (token) =>
  /[\s<>{}$=()"'[\]\\|,;@:]/.test(token) ||
  /^[-!#/~^@:.0-9]/.test(token) ||
  token.includes("://") ||
  token.length < 3;

// A token that is not a path in either tree (an RPC name like `configRequirements/read`, a
// gitignored script, a patch section) must still occur as text in one of them.
const textTokens = new Set();
for (const title of SECTIONS) {
  for (const token of tokensOf(sectionText(title))) {
    if (skip(token)) continue;
    const isPath = PATH_EXTENSION.test(token) || /\/\**$/.test(token);
    if (!isPath || !pathExists(token)) textTokens.add(token.replace(/\/?\**$/, ""));
  }
}

// Text is searched in the checkout's tracked files first, then with `git grep` in the base,
// outside Markdown so the docs never vouch for themselves.
const checkoutText = checkoutFiles
  .filter((file) => !file.endsWith(".md"))
  .map((file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");
const inBase = (text) =>
  new Promise((resolve, reject) =>
    execFile("git", ["grep", "-q", "-F", "-e", text, base, "--", ".", ":!*.md"], (error) =>
      error && error.code !== 1 ? reject(error) : resolve(!error),
    ),
  );
// A member path (`RuntimePolicy.providerRuntimeMode`), test stem (`CommandPalette.composition`),
// or pattern (`primaryServer*Atom`) passes when each of its parts occurs; a file name does not.
const allPartsFound = async (text) => {
  const parts = text.split(/[.*]/).filter((part) => part.length >= 3);
  if (parts.length < 2 || PATH_EXTENSION.test(text)) return false;
  for (const part of parts) {
    if (!checkoutText.includes(part) && !(await inBase(part))) return false;
  }
  return true;
};
const missing = [];
const queue = [...textTokens].filter((text) => !checkoutText.includes(text));
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
      if (!(await inBase(text)) && !(await allPartsFound(text))) missing.push(text);
    }
  }),
);

// --- (b) every modified upstream file is marked, documented, or a wording swap ---

// Tests (with their fixtures and testkits), docs, and the lockfile.
const SKIPPED_FILE =
  /(?:^docs\/|\.md$|\.(?:test|spec)\.[cm]?[jt]sx?$|\/(?:test|testkit|fixtures)\/|^pnpm-lock\.yaml$)/;
const modified = git("diff", "--no-renames", "--diff-filter=M", "--name-only", "-z", base)
  .split("\0")
  .filter((file) => file && !SKIPPED_FILE.test(file));

// A documented file is named by a backticked token anywhere in coder-only.md that ends the path.
// A stem token (`useComposerResume`) also names its file.
const docTokens = new Set(tokensOf(doc));
const docPaths = [...docTokens].filter((t) => PATH_EXTENSION.test(t) && !/[\s*<]/.test(t));
const stemOf = (file) => file.slice(file.lastIndexOf("/") + 1).replace(/\..*$/, "");
const documented = (file) =>
  docTokens.has(file) ||
  docPaths.some(
    (t) => file === t || file.endsWith(`/${t}`) || file.replace("/src/", "/").endsWith(`/${t}`),
  ) ||
  docTokens.has(stemOf(file));

// The seams doc exempts the merge-request wording swap from line markers. Undo the swap on the
// fork's lines; if they then equal upstream's, the file differs only in wording.
const unswap = (line) =>
  line
    .replace(/\bmerge requests\b/g, "pull requests")
    .replace(/\bMerge requests\b/g, "Pull requests")
    .replace(/\bMerge Requests\b/g, "Pull Requests")
    .replace(/\ban merge request\b/g, "a pull request")
    .replace(/\bmerge request\b/g, "pull request")
    .replace(/\bMerge request\b/g, "Pull request")
    .replace(/\bMerge Request\b/g, "Pull Request")
    .replace(/\ban MR\b/g, "a PR")
    .replace(/\bAn MR\b/g, "A PR")
    .replace(/\bMRs\b/g, "PRs")
    .replace(/\bMR\b/g, "PR")
    .replace(/\bT3 Coder\b/g, "T3 Code")
    .replace(/!(\$\{|\{|\d|N\b)/g, "#$1");
// One diff of every modified file, split per file into its removed and added lines.
const changes = new Map();
{
  let current;
  const diff = git("diff", "--no-renames", "-U0", base, "--", ...modified);
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { removed: [], added: [] };
      changes.set(line.slice(line.lastIndexOf(" b/") + 3), current);
    } else if (!current || line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
}
const sameLines = (a, b) => {
  if (a.length !== b.length) return false;
  const [x, y] = [[...a].sort(), [...b].sort()];
  return x.every((line, i) => line === y[i]);
};

const unmarked = [];
for (const file of modified) {
  if (documented(file)) continue;
  const { removed, added } = changes.get(file) ?? { removed: [], added: [] };
  if (added.some((line) => line.includes("Coder:"))) continue;
  if (added.length > 0 && sameLines(added.map(unswap), removed)) continue;
  unmarked.push(file);
}

if (missing.length > 0) {
  console.log(`Names in the seams sections found in neither HEAD nor ${base} (${missing.length}):`);
  for (const token of missing.sort()) console.log(`  ${token}`);
}
if (unmarked.length > 0) {
  console.log(
    `\nModified upstream files with no Coder: marker, doc entry, or wording-only diff (${unmarked.length}):`,
  );
  for (const file of unmarked) console.log(`  ${file}`);
}
if (missing.length > 0 || unmarked.length > 0) process.exit(1);
console.log(`Seams check passed against ${base}.`);
