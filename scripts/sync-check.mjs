// Mechanical checks after an upstream merge (docs/internals/sync.md section 6).
//
//   node scripts/sync-check.mjs <PREV> <SHA> [--only markers|lost|both-sides|unused-locals]
//
// PREV is coder-only before the merge and SHA the merged upstream commit; the working tree is the
// merge result. Each check prints what a human must read; none changes a file.
//
// - markers: upstream-modified files whose `Coder:` marker count differs from PREV. A drop must
//   be inside a block upstream deleted, or a seam upstream's own mechanism now expresses.
// - lost: lines upstream added in MB..SHA that the result lacks. Each must be a listed seam or a
//   deleted surface.
// - both-sides: lines both PREV and SHA have but the result lacks; neither side deleted them, so
//   each is a merge loss unless the line moved.
// - unused-locals: unused imports and locals (tsc --noUnusedLocals) the fork caused; a name that
//   upstream's own file has as often is upstream's and is skipped.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args.splice(onlyAt, 2)[1] : undefined;
const [prev, sha] = args;
if (!prev || !sha) {
  console.error("usage: node scripts/sync-check.mjs <PREV> <SHA> [--only <check>]");
  process.exit(2);
}

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 1 << 30, shell: false });
const show = (ref, file) => {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const names = (...diffArgs) =>
  git("diff", "--no-renames", "--name-only", "-z", ...diffArgs)
    .split("\0")
    .filter(Boolean);
const meaningful = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 3);
const counts = (text) => {
  const map = new Map();
  for (const line of meaningful(text)) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
};
const mb = git("merge-base", prev, sha).trim();
let reported = 0;
const report = (title, lines) => {
  if (lines.length === 0) return;
  reported += lines.length;
  console.log(`\n${title} (${lines.length}):`);
  for (const line of lines) console.log(`  ${line}`);
};

const checks = {
  markers() {
    const out = [];
    for (const file of names(mb, sha)) {
      const result = read(file);
      if (result === null) continue;
      const count = (text) => text.split("\n").filter((line) => line.includes("Coder:")).length;
      const before = count(show(prev, file) ?? "");
      const after = count(result);
      if (before !== after) out.push(`${file}: ${before} -> ${after}`);
    }
    report("Coder: marker counts that changed", out);
  },

  lost() {
    const files = names("--diff-filter=AM", mb, sha, "--", "apps", "packages", ":!*.test.*");
    const out = [];
    let file;
    let result;
    for (const line of git("diff", "--no-renames", "-U0", mb, sha, "--", ...files).split("\n")) {
      if (line.startsWith("diff --git ")) {
        file = line.slice(line.lastIndexOf(" b/") + 3);
        result = read(file);
      } else if (result !== null && line.startsWith("+") && !line.startsWith("+++ ")) {
        const added = line.slice(1).trimStart();
        if (added.length > 3 && !result.includes(added)) out.push(`${file}: ${added}`);
      }
    }
    report(`Lines upstream added in ${mb.slice(0, 10)}..${sha} that the result lacks`, out);
  },

  "both-sides"() {
    const out = [];
    for (const file of names("--diff-filter=AM", prev, "--", "apps", "packages")) {
      const [before, upstream, result] = [show(prev, file), show(sha, file), read(file)];
      if (before === null || upstream === null || result === null) continue;
      const [inPrev, inSha, inResult] = [counts(before), counts(upstream), counts(result)];
      for (const [line, n] of inPrev) {
        if ((inResult.get(line) ?? 0) < Math.min(n, inSha.get(line) ?? 0))
          out.push(`${file}: ${line}`);
      }
    }
    report("Lines both PREV and SHA have that the result lacks", out);
  },

  "unused-locals"() {
    const require = createRequire(import.meta.url);
    const tsc = NodePath.join(
      NodePath.dirname(require.resolve("typescript/package.json")),
      "bin/tsc",
    );
    const projects = ["apps/web", "apps/server", "apps/coder-gateway"];
    for (const entry of readdirSync("packages")) projects.push(`packages/${entry}`);
    const diagnostics = new Set();
    for (const project of projects) {
      const config = `${project}/tsconfig.json`;
      if (!existsSync(config)) continue;
      let output = "";
      try {
        output = execFileSync(
          process.execPath,
          [tsc, "--noEmit", "-p", config, "--noUnusedLocals"],
          {
            encoding: "utf8",
            maxBuffer: 1 << 28,
          },
        );
      } catch (error) {
        output = `${error.stdout ?? ""}`;
      }
      for (const line of output.split("\n"))
        if (/error TS61(?:33|92|96)/.test(line)) diagnostics.add(line.trim());
    }
    const out = [];
    for (const line of [...diagnostics].sort()) {
      const match = /^(\S+)\((\d+),\d+\): error TS\d+: (?:.(\w+).|All imports)/.exec(line);
      if (!match) continue;
      const [, file, lineNumber, declared] = match;
      const text = read(file) ?? "";
      const name =
        declared ?? /\w+/.exec(text.split("\n")[Number(lineNumber) - 1].split("{").at(-1))?.[0];
      const pattern = new RegExp(`\\b${name}\\b`, "g");
      const upstream = show(sha, file);
      const count = (source) => source.match(pattern)?.length ?? 0;
      if (upstream === null || count(upstream) !== count(text)) out.push(line);
    }
    report("Unused imports and locals the fork caused (remove, then rerun)", out);
  },
};

if (only && !(only in checks)) {
  console.error(`unknown check "${only}"; use one of ${Object.keys(checks).join(", ")}`);
  process.exit(2);
}
for (const [name, run] of Object.entries(checks)) if (!only || only === name) run();
if (reported === 0) console.log("Nothing to report.");
