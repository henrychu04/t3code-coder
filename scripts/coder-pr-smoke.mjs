import { spawnSync } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { startLocalCoderGateway } from "../apps/coder-gateway/src/server.ts";
import { connectCoderHelper as connectCoderHelperEffect } from "../packages/coder-cli/src/helperConnection.ts";
import { saveCoderProfileConfig } from "../packages/coder-cli/src/configStore.ts";

// The root package intentionally has no runtime dependencies. Resolve Effect from the package
// whose connection lifecycle this smoke adapter owns instead of widening the shipped dependency
// surface for a development-only script.
const requireCoderCliDependency = createRequire(
  new URL("../packages/coder-cli/package.json", import.meta.url),
);
const Effect = requireCoderCliDependency("effect/Effect");
const Exit = requireCoderCliDependency("effect/Exit");
const Scope = requireCoderCliDependency("effect/Scope");

const repositoryRoot = NodePath.dirname(NodePath.dirname(fileURLToPath(import.meta.url)));
const helperPath = NodePath.join(repositoryRoot, "apps", "coder-helper", "src", "bin.ts");
const fixturePath = NodePath.join(repositoryRoot, "scripts", "coder-pr-smoke-glab.mjs");
const staticDir = NodePath.join(repositoryRoot, "apps", "web", "dist");

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => value?.trim())
      .join("\n")
      .trim();
    throw new Error(
      `${executable} ${args.join(" ")} exited with ${String(result.status)}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

async function seedRepository(root) {
  const repository = NodePath.join(root, "smoke-repo");
  await NodeFS.mkdir(NodePath.join(repository, "src"), { recursive: true });
  await NodeFS.writeFile(
    NodePath.join(repository, "src", "greeting.ts"),
    "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const greeting = 'hello';\nexport const six = 6;\nexport const seven = 7;\nexport const eight = 8;\nexport const nine = 9;\nexport const ten = 10;\n",
    "utf8",
  );
  run("git", ["init", "--initial-branch=main"], repository);
  run("git", ["config", "user.name", "Smoke User"], repository);
  run("git", ["config", "user.email", "smoke@example.com"], repository);
  run("git", ["add", "src/greeting.ts"], repository);
  run("git", ["commit", "-m", "Initial greeting"], repository);
  const base = run("git", ["rev-parse", "HEAD"], repository);
  run("git", ["switch", "-c", "feature/smoke"], repository);
  await NodeFS.writeFile(
    NodePath.join(repository, "src", "greeting.ts"),
    "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const greeting = 'hello from Coder RPC';\n\nexport const provider = 'GitLab';\nexport const six = 6;\nexport const seven = 7;\nexport const eight = 8;\nexport const nine = 9;\nexport const ten = 10;\n",
    "utf8",
  );
  run("git", ["add", "src/greeting.ts"], repository);
  run("git", ["commit", "-m", "Restore GitLab merge request detail panel"], repository);
  const head = run("git", ["rev-parse", "HEAD"], repository);
  run(
    "git",
    ["remote", "add", "origin", "https://gitlab.example.gs.com/goldman/smoke.git"],
    repository,
  );
  run("git", ["update-ref", "refs/remotes/origin/main", base], repository);
  run("git", ["update-ref", "refs/remotes/origin/feature/smoke", head], repository);
  run("git", ["config", "branch.feature/smoke.remote", "origin"], repository);
  run("git", ["config", "branch.feature/smoke.merge", "refs/heads/feature/smoke"], repository);
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repository);
  return repository;
}

async function connectLocalHelper(environment) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  try {
    const connection = await Effect.runPromise(
      connectCoderHelperEffect(
        { executable: process.execPath, args: [helperPath] },
        { environment, terminationGraceMs: 2_000 },
      ).pipe(Scope.provide(scope)),
    );
    const closed = Effect.runPromise(connection.closed);
    void closed
      .then(
        () => Effect.runPromise(Scope.close(scope, Exit.void)),
        () => Effect.runPromise(Scope.close(scope, Exit.void)),
      )
      .catch(() => undefined);
    return {
      ...connection,
      closed,
      sendRpc: (message) => Effect.runSync(connection.sendRpc(message)),
      close: () => {
        void Effect.runPromise(connection.close).catch(() => undefined);
      },
    };
  } catch (cause) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw cause;
  }
}

const smokeRoot = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-pr-smoke-"));
const helperHome = NodePath.join(smokeRoot, "home");
const fakeBin = NodePath.join(smokeRoot, "bin");
const configPath = NodePath.join(smokeRoot, "gateway", "config.json");
const statePath = NodePath.join(smokeRoot, "glab-state.json");
const commandLogPath = NodePath.join(smokeRoot, "glab-commands.ndjson");
await NodeFS.mkdir(helperHome, { recursive: true });
await NodeFS.mkdir(fakeBin, { recursive: true });
await NodeFS.mkdir(NodePath.dirname(configPath), { recursive: true });
const repository = await seedRepository(helperHome);
const glabPath = NodePath.join(fakeBin, "glab");
await NodeFS.copyFile(fixturePath, glabPath);
await NodeFS.chmod(glabPath, 0o755);

await saveCoderProfileConfig(configPath, {
  version: 1,
  deployments: [
    {
      id: "smoke-deployment",
      name: "GitLab smoke deployment",
      url: "https://coder.example.gs.com",
    },
  ],
  workspaces: [
    {
      id: "smoke-workspace",
      name: "GitLab MR smoke workspace",
      deploymentId: "smoke-deployment",
      workspace: "smoke-user/gitlab-smoke",
    },
  ],
  portForwards: [],
});

const helperEnvironment = {
  ...process.env,
  HOME: helperHome,
  PATH: `${fakeBin}${NodePath.delimiter}${process.env.PATH ?? ""}`,
  T3_CODER_CWD: repository,
  T3_CODER_HOME: NodePath.join(helperHome, ".t3-coder"),
  T3_CODER_WORKSPACE_LABEL: "GitLab MR smoke workspace",
  T3_CODER_SMOKE_GLAB_LOG: commandLogPath,
  T3_CODER_SMOKE_GLAB_STATE: statePath,
};

const gateway = await startLocalCoderGateway({
  configPath,
  staticDir,
  checkAuthentication: async () => "authenticated",
  probeWorkspace: async () => undefined,
  listWorkspaces: async () => [
    {
      name: "gitlab-smoke",
      target: "smoke-user/gitlab-smoke",
      status: "running",
      updateAvailable: false,
      healthy: true,
      autostopAt: null,
    },
  ],
  connectHelper: async () => connectLocalHelper(helperEnvironment),
  connectWorkspacePing: async () => {
    let close;
    const closed = new Promise((resolve) => {
      close = () => resolve({ code: 130, signal: null, expected: true });
    });
    return {
      closed,
      close,
      latestSample: () => ({ latencyMs: 12, sampledAt: Date.now() }),
    };
  },
  readWorkspaceResourceUsage: async () => ({
    cpu: { used: 1, total: 8, unit: "cores" },
    memory: { used: 2 * 1024 ** 3, total: 16 * 1024 ** 3, unit: "B" },
    disk: { used: 10 * 1024 ** 3, total: 100 * 1024 ** 3, unit: "B" },
  }),
});

console.log(`T3 Coder GitLab MR smoke gateway listening on ${gateway.url}`);
console.log(`Smoke repository: ${repository}`);
console.log(`Mutable glab state: ${statePath}`);
console.log(`glab command trace: ${commandLogPath}`);
console.log(
  'Change writeAccess in the mutable state to "writable", "policy-blocked", or "indeterminate", then use Recheck write access in Settings.',
);
console.log("Add the smoke-repo project, then open Merge Requests in the sidebar.");

await new Promise((resolve, reject) => {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void gateway
      .close()
      .then(() => NodeFS.rm(smokeRoot, { recursive: true, force: true }))
      .then(resolve, reject);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
});
