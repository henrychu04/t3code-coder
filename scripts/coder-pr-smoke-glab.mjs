#!/usr/bin/env node

import * as NodeFS from "node:fs/promises";

const statePath = process.env.T3_CODER_SMOKE_GLAB_STATE;
if (!statePath) throw new Error("T3_CODER_SMOKE_GLAB_STATE is required.");
const commandLogPath = process.env.T3_CODER_SMOKE_GLAB_LOG;

const now = "2026-08-28T14:00:00.000Z";
const baseSha = "1111111111111111111111111111111111111111";
const headSha = "2222222222222222222222222222222222222222";
const startSha = "1111111111111111111111111111111111111111";
const host = "gitlab.example.gs.com";
const repository = "goldman/smoke";
const mergeRequestUrl = `https://${host}/${repository}/-/merge_requests/42`;

const initialState = {
  title: "Restore the complete GitLab merge request panel",
  description:
    "This fixture exercises the restored summary, activity, diff, reviewer, merge, and branch-update controls through the Coder RPC boundary.",
  draft: false,
  mrState: "opened",
  autoMerge: false,
  reviewers: [{ id: 2, username: "reviewer", name: "Review User", avatar_url: null }],
  notes: [
    {
      id: 101,
      body: "The Coder RPC path is ready for a full UI smoke test.",
      author: { id: 2, username: "reviewer", name: "Review User", avatar_url: null },
      created_at: "2026-08-28T13:30:00.000Z",
      system: false,
      type: null,
    },
  ],
  actions: [],
};

async function loadState() {
  try {
    return JSON.parse(await NodeFS.readFile(statePath, "utf8"));
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "ENOENT") {
      await saveState(initialState);
      return structuredClone(initialState);
    }
    throw cause;
  }
}

async function saveState(state) {
  await NodeFS.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function mergeRequest(state) {
  return {
    iid: 42,
    title: state.title,
    web_url: mergeRequestUrl,
    description: state.description,
    author: { id: 1, username: "smoke-user", name: "Smoke User", avatar_url: null },
    source_branch: "feature/smoke",
    target_branch: "main",
    state: state.mrState,
    draft: state.draft,
    work_in_progress: state.draft,
    merge_status: "can_be_merged",
    has_conflicts: false,
    created_at: "2026-08-27T15:00:00.000Z",
    updated_at: now,
    merged_at: state.mrState === "merged" ? now : null,
    closed_at: state.mrState === "closed" ? now : null,
    reviewers: state.reviewers,
    labels: ["coder-rpc", "gitlab"],
    changes_count: "1",
    head_pipeline: {
      status: "success",
      web_url: `https://${host}/${repository}/-/pipelines/7`,
      source: "merge_request_event",
    },
    user: { can_merge: true },
    merge_when_pipeline_succeeds: state.autoMerge,
    auto_merge_enabled: state.autoMerge,
    diverged_commits_count: 2,
    diff_refs: { base_sha: baseSha, head_sha: headSha, start_sha: startSha },
    source_project_id: 7,
    target_project_id: 7,
    source_project: { path_with_namespace: repository },
    target_project: { path_with_namespace: repository },
  };
}

function project() {
  return {
    id: 7,
    path_with_namespace: repository,
    web_url: `https://${host}/${repository}`,
    http_url_to_repo: `https://${host}/${repository}.git`,
    ssh_url_to_repo: `git@${host}:${repository}.git`,
    default_branch: "main",
    merge_method: "merge",
    squash_option: "default_on",
  };
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk.toString("utf8");
  return value;
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

const args = process.argv.slice(2);
// The real process runner leaves an unused stdin stream open. `glab api --input -` is the only
// command in this fixture that consumes it, so reads must not wait for EOF on ordinary GETs.
const stdin = optionValue(args, "--input") === "-" ? await readStdin() : "";
if (commandLogPath) {
  await NodeFS.appendFile(
    commandLogPath,
    `${JSON.stringify({ args, stdin: stdin || null })}\n`,
    "utf8",
  );
}
const state = await loadState();

if (args[0] === "--version") {
  console.log("glab version 1.75.0");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  console.log(`${host}\n  ✓ Logged in to ${host} as smoke-user`);
  process.exit(0);
}

if (args[0] === "mr" && args[1] === "list") {
  console.log(JSON.stringify([mergeRequest(state)]));
  process.exit(0);
}

if (args[0] === "mr" && args[1] === "view") {
  console.log(JSON.stringify(mergeRequest(state)));
  process.exit(0);
}

if (args[0] === "mr") {
  const subcommand = args[1];
  if (subcommand === "update") {
    if (args.includes("--draft")) state.draft = true;
    if (args.includes("--ready")) state.draft = false;
  } else if (subcommand === "close") {
    state.mrState = "closed";
  } else if (subcommand === "reopen") {
    state.mrState = "opened";
  } else if (subcommand === "merge") {
    state.autoMerge = args.includes("--auto-merge=true");
    if (!state.autoMerge) state.mrState = "merged";
  }
  state.actions.push({ args, body: stdin || null });
  await saveState(state);
  console.log(JSON.stringify(mergeRequest(state)));
  process.exit(0);
}

if (args[0] !== "api") {
  console.error(`Unsupported smoke glab command: ${args.join(" ")}`);
  process.exit(2);
}

const path = args[1];
const method = optionValue(args, "--method") ?? "GET";
let body = null;
if (stdin.trim()) body = JSON.parse(stdin);

if (method !== "GET" && path !== "projects/:fullpath/ci/lint") {
  state.actions.push({ args, body });
}

if (path === "projects/:fullpath/ci/lint" && method === "POST") {
  console.log(JSON.stringify({ valid: true, errors: [], warnings: [] }));
  process.exit(0);
}

if (path === "user") {
  console.log(JSON.stringify({ username: "smoke-user" }));
  process.exit(0);
}

if (path === "graphql") {
  console.log(
    JSON.stringify({
      data: {
        currentUser: { username: "smoke-user" },
        project: {
          mergeRequest: {
            awardEmoji: { nodes: [] },
            notes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      },
    }),
  );
  process.exit(0);
}

if (path === "projects/:fullpath" || path === "projects/goldman%2Fsmoke") {
  console.log(JSON.stringify(project()));
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests?")) {
  console.log(JSON.stringify(state.mrState === "opened" ? [mergeRequest(state)] : []));
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke/merge_requests/42?include_diverged_commits_count=true") {
  console.log(JSON.stringify(mergeRequest(state)));
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke/merge_requests/42") {
  if (method === "PUT" && body) {
    if (typeof body.title === "string") state.title = body.title;
    if (typeof body.description === "string") state.description = body.description;
    if (Array.isArray(body.reviewer_ids)) {
      state.reviewers = body.reviewer_ids.includes(2)
        ? [{ id: 2, username: "reviewer", name: "Review User", avatar_url: null }]
        : [];
    }
    await saveState(state);
  }
  console.log(JSON.stringify(mergeRequest(state)));
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests/42/notes?")) {
  console.log(JSON.stringify(state.notes));
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke/merge_requests/42/notes" && method === "POST") {
  state.notes.push({
    id: 100 + state.notes.length + 1,
    body: body?.body ?? "",
    author: { id: 1, username: "smoke-user", name: "Smoke User", avatar_url: null },
    created_at: now,
    system: false,
    type: null,
  });
  await saveState(state);
  console.log(JSON.stringify(state.notes.at(-1)));
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests/42/notes/")) {
  const noteId = Number(path.split("/").at(-1));
  const note = state.notes.find((candidate) => candidate.id === noteId);
  if (note && method === "PUT" && typeof body?.body === "string") note.body = body.body;
  await saveState(state);
  console.log(JSON.stringify(note ?? {}));
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests/42/discussions?")) {
  console.log("[]");
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests/42/commits?")) {
  console.log(
    JSON.stringify([
      {
        id: headSha,
        title: "Restore GitLab merge request detail panel",
        committed_date: "2026-08-28T12:00:00.000Z",
        parent_ids: [baseSha],
        author_name: "Smoke User",
        author_email: "smoke@example.com",
        stats: { additions: 8, deletions: 1 },
      },
    ]),
  );
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/merge_requests/42/diffs?")) {
  console.log(
    JSON.stringify([
      {
        old_path: "src/greeting.ts",
        new_path: "src/greeting.ts",
        a_mode: "100644",
        b_mode: "100644",
        new_file: false,
        renamed_file: false,
        deleted_file: false,
        diff: "@@ -4,3 +4,5 @@\n export const four = 4;\n-export const greeting = 'hello';\n+export const greeting = 'hello from Coder RPC';\n+\n+export const provider = 'GitLab';\n export const six = 6;",
      },
    ]),
  );
  process.exit(0);
}

if (path?.startsWith("projects/goldman%2Fsmoke/repository/files/src%2Fgreeting.ts/raw?ref=")) {
  console.log(
    path.endsWith(headSha)
      ? "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const greeting = 'hello from Coder RPC';\n\nexport const provider = 'GitLab';\nexport const six = 6;\nexport const seven = 7;\nexport const eight = 8;\nexport const nine = 9;\nexport const ten = 10;"
      : "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const greeting = 'hello';\nexport const six = 6;\nexport const seven = 7;\nexport const eight = 8;\nexport const nine = 9;\nexport const ten = 10;",
  );
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke?license=false") {
  console.log(JSON.stringify(project()));
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke/users?per_page=100") {
  console.log(
    JSON.stringify([
      { id: 1, username: "smoke-user", name: "Smoke User", avatar_url: null },
      { id: 2, username: "reviewer", name: "Review User", avatar_url: null },
      { id: 3, username: "maintainer", name: "Merge Maintainer", avatar_url: null },
    ]),
  );
  process.exit(0);
}

if (path === "projects/goldman%2Fsmoke/merge_requests/42/cancel_merge_when_pipeline_succeeds") {
  state.autoMerge = false;
  await saveState(state);
  console.log("{}");
  process.exit(0);
}

if (method !== "GET") {
  await saveState(state);
  console.log("{}");
  process.exit(0);
}

console.error(`Unsupported smoke glab API path: ${String(path)}`);
process.exit(2);
