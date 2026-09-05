import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { startLocalCoderGateway } from "../apps/coder-gateway/src/testUtils/gateway.ts";
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
const smokeProjectId = "00000000-0000-4000-8000-000000000045";

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

async function seedProject(environment, repository) {
  const connection = await connectLocalHelper(environment);
  const requestId = "smoke-project-create";
  try {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out while seeding the smoke project through RPC."));
      }, 10_000);
      const unsubscribe = connection.onRpcMessage((message) => {
        if (message?._tag !== "Exit" || message.requestId !== requestId) return;
        clearTimeout(timeout);
        unsubscribe();
        if (message.exit?._tag === "Success") {
          resolve(message.exit.value);
          return;
        }
        reject(new Error("The workspace helper rejected the smoke project."));
      });
    });
    connection.sendRpc({
      _tag: "Request",
      id: requestId,
      tag: "orchestration.dispatchCommand",
      payload: {
        type: "project.create",
        commandId: randomUUID(),
        projectId: smokeProjectId,
        title: "GitLab MR smoke repo",
        workspaceRoot: repository,
        createWorkspaceRootIfMissing: false,
        createdAt: new Date().toISOString(),
      },
      headers: [],
    });
    await response;
  } finally {
    connection.close();
    await connection.closed;
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

await seedProject(helperEnvironment, repository);

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
  readWorkspaceResourceUsage: async () => ({
    cpu: { used: 1, total: 8, unit: "cores" },
    memory: { used: 2 * 1024 ** 3, total: 16 * 1024 ** 3, unit: "B" },
    disk: { used: 10 * 1024 ** 3, total: 100 * 1024 ** 3, unit: "B" },
  }),
});

console.log(`T3 Coder GitLab MR smoke gateway listening on ${gateway.url}`);
console.log(
  `Open the seeded merge request: ${gateway.url}/pull-requests?repository=goldman%2Fsmoke&number=42&selectedProjectId=${smokeProjectId}&host=gitlab.example.gs.com`,
);
console.log(`Smoke repository: ${repository}`);
console.log(`Mutable glab state: ${statePath}`);
console.log(`glab command trace: ${commandLogPath}`);
console.log(
  'Change writeAccess in the mutable state to "writable", "policy-blocked", or "indeterminate", then use Reprobe in GitLab source control settings.',
);
console.log("The smoke project is already configured; open Merge Requests in the sidebar.");

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
