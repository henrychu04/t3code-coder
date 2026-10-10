// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildBrowserOpenInvocation,
  buildCoderAuthStatusInvocation,
  buildCoderHelperInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderPortForwardInvocation,
  buildCoderRestartWorkspaceInvocation,
  buildCoderStartWorkspaceInvocation,
  buildCoderStopWorkspaceInvocation,
  buildCoderUpdateWorkspaceInvocation,
  buildCoderWorkspaceShellInvocation,
  buildCoderWorkspaceStatsInvocation,
  REMOTE_HELPER_BUNDLE_HASH_FILE,
  REMOTE_HELPER_COMMAND,
  REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL,
  REMOTE_HELPER_READY_SENTINEL,
  REMOTE_NODE_COMMAND,
  REMOTE_WORKSPACE_PREFLIGHT_COMMAND,
  REMOTE_WORKSPACE_STATS_COMMAND,
  quotePosixShellArgument,
  remoteHelperBundleCheck,
} from "./command.ts";
import type { CoderDeploymentProfile, CoderWorkspaceProfile } from "./profile.ts";

const deployment = {
  id: "goldman-us",
  name: "Goldman US",
  url: "https://coder.example.gs.com/",
  executable: String.raw`C:\Program Files\Coder\coder.exe`,
} satisfies CoderDeploymentProfile;

const workspace = {
  id: "goldman-us-equities",
  name: "Equities",
  deploymentId: "goldman-us",
  workspace: "equities-dev",
} satisfies CoderWorkspaceProfile;

describe("Coder CLI command construction", () => {
  it("isolates Coder 2.25 authentication by deployment without reading tokens", () => {
    const options = { globalConfig: String.raw`C:\T3 Coder\coder-profiles\goldman-us` };
    deepStrictEqual(buildCoderLoginInvocation(deployment, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [
        "--global-config",
        String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
        "--no-version-warning",
        "--no-open",
        "login",
        "https://coder.example.gs.com",
      ],
    });
    deepStrictEqual(buildCoderAuthStatusInvocation(deployment, options).args, [
      "--global-config",
      String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
      "--no-version-warning",
      "--verbose",
      "--url",
      "https://coder.example.gs.com",
      "whoami",
    ]);
    deepStrictEqual(buildCoderListWorkspacesInvocation(deployment, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [
        "--global-config",
        String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
        "--no-version-warning",
        "--url",
        "https://coder.example.gs.com",
        "list",
        "--output",
        "json",
      ],
    });
    throws(() => buildCoderLoginInvocation(deployment, { globalConfig: " " }));
  });

  it("builds the preflighted foreground helper invocation as an argument array", () => {
    deepStrictEqual(buildCoderWorkspaceStatsInvocation(deployment, workspace).args, [
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "sh",
      "-l",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_STATS_COMMAND),
    ]);
    match(REMOTE_WORKSPACE_STATS_COMMAND, /coder --no-version-warning stat cpu --output=json/u);
    match(REMOTE_WORKSPACE_STATS_COMMAND, /coder --no-version-warning stat mem --output=json/u);
    match(
      REMOTE_WORKSPACE_STATS_COMMAND,
      /coder --no-version-warning stat disk --path "\$HOME" --output=json/u,
    );
    deepStrictEqual(
      REMOTE_WORKSPACE_STATS_COMMAND.match(/\bcoder \S+/gu),
      Array.from({ length: 3 }, () => "coder --no-version-warning"),
    );
    deepStrictEqual(buildCoderHelperInvocation(deployment, workspace).args, [
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "sh",
      "-l",
      "-c",
      quotePosixShellArgument(
        [
          REMOTE_WORKSPACE_PREFLIGHT_COMMAND,
          "stty raw -echo 2>/dev/null || true",
          `printf '${REMOTE_HELPER_READY_SENTINEL}\\n'`,
          [
            "exec env",
            "'T3_CODER_WORKSPACE_LABEL=Goldman US · Equities'",
            REMOTE_NODE_COMMAND,
            REMOTE_HELPER_COMMAND,
            "--stdio",
            "2>/dev/null",
          ].join(" "),
        ].join("; "),
      ),
    ]);
    match(
      REMOTE_WORKSPACE_PREFLIGHT_COMMAND,
      /if ! \[ -x .*node24\/bin\/node.*nix-env --profile .*node24.*nixpkgs\.nodejs_24.*; fi/u,
    );
    strictEqual(REMOTE_WORKSPACE_PREFLIGHT_COMMAND.includes("--attr-path"), false);
    strictEqual(REMOTE_WORKSPACE_PREFLIGHT_COMMAND.includes("github:"), false);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /process\.exit\(major >= 24 \? 0 : 1\)/u);
    strictEqual(REMOTE_WORKSPACE_PREFLIGHT_COMMAND.includes("24.10"), false);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /\.t3-coder\/node24\/bin\/node/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /command -v claude/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /command -v codex/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /command -v pi/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /requires Claude Code, Codex, or Pi/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /workspace HOME directory/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /\.t3-coder\/attachments/u);
    match(REMOTE_WORKSPACE_PREFLIGHT_COMMAND, /T3_CODER_PREFLIGHT_FAILED: /u);
    strictEqual(quotePosixShellArgument("a b'c"), "'a b'\\''c'");
  });

  it("checks the installed helper bundle only when a hash is expected", () => {
    const hash = "a".repeat(64);
    const command = buildCoderHelperInvocation(deployment, workspace, {
      expectedBundleHash: hash,
    }).args.at(-1)!;
    match(command, new RegExp(`${REMOTE_HELPER_BUNDLE_HASH_FILE}.*= "${hash}"`, "u"));
    match(command, new RegExp(REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL, "u"));
    strictEqual(
      buildCoderHelperInvocation(deployment, workspace)
        .args.at(-1)!
        .includes(REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL),
      false,
    );
    throws(
      () =>
        buildCoderHelperInvocation(deployment, workspace, { expectedBundleHash: "abc; rm -rf ~" }),
      /SHA-256/u,
    );
  });

  it(
    "asks for an install unless the installed bundle hash matches",
    { skip: process.platform === "win32" },
    () => {
      const hash = "b".repeat(64);
      const bundleCheck = remoteHelperBundleCheck(hash);
      const home = mkdtempSync(join(tmpdir(), "t3-coder-bundle-"));
      try {
        const run = () =>
          spawnSync("/bin/sh", ["-c", `${bundleCheck}; printf 'LAUNCH\\n'`], {
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            shell: false,
            encoding: "utf8",
          });
        const missing = run();
        strictEqual(missing.status, 3);
        strictEqual(missing.stdout, `${REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL}\n`);
        mkdirSync(join(home, ".t3-coder", "bin", "workspace-helper"), { recursive: true });
        writeFileSync(
          join(home, ".t3-coder", "bin", "workspace-helper", REMOTE_HELPER_BUNDLE_HASH_FILE),
          `${"c".repeat(64)}\n`,
        );
        strictEqual(run().status, 3);
        writeFileSync(
          join(home, ".t3-coder", "bin", "workspace-helper", REMOTE_HELPER_BUNDLE_HASH_FILE),
          `${hash}\n`,
        );
        const current = run();
        strictEqual(current.status, 0);
        strictEqual(current.stdout, "LAUNCH\n");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it(
    "accepts a workspace that provides any one supported provider",
    { skip: process.platform === "win32" },
    () => {
      const providerCheck = REMOTE_WORKSPACE_PREFLIGHT_COMMAND.split("; ").find((clause: string) =>
        clause.startsWith("command -v claude"),
      );
      strictEqual(typeof providerCheck, "string");
      const binDirectory = mkdtempSync(join(tmpdir(), "t3-coder-probe-"));
      try {
        const run = () =>
          spawnSync("/bin/sh", ["-c", `fail() { exit 1; }; ${providerCheck}`], {
            env: { PATH: binDirectory },
            shell: false,
          }).status;
        strictEqual(run(), 1);
        for (const provider of ["claude", "codex", "pi"]) {
          const providerPath = join(binDirectory, provider);
          writeFileSync(providerPath, "#!/bin/sh\n", { mode: 0o755 });
          strictEqual(run(), 0, provider);
          rmSync(providerPath);
        }
      } finally {
        rmSync(binDirectory, { recursive: true, force: true });
      }
    },
  );

  it(
    "fails preflight with a clear message when a transfer tool is missing",
    { skip: process.platform === "win32" },
    () => {
      const binDirectory = mkdtempSync(join(tmpdir(), "t3-coder-transfer-tools-"));
      try {
        for (const [tool, message] of [
          ["tar", "T3 Coder requires tar to install its workspace helper."],
          ["sha256sum", "T3 Coder requires sha256sum to verify its workspace helper."],
          ["head", "T3 Coder requires head to receive transfers."],
        ] as const) {
          const check = REMOTE_WORKSPACE_PREFLIGHT_COMMAND.split("; ").find((clause: string) =>
            clause.startsWith(`command -v ${tool} `),
          );
          strictEqual(typeof check, "string", tool);
          const run = () =>
            spawnSync("/bin/sh", ["-c", `fail() { printf '%s\\n' "$1"; exit 1; }; ${check}`], {
              env: { PATH: binDirectory },
              encoding: "utf8",
              shell: false,
            });
          const missing = run();
          strictEqual(missing.status, 1, tool);
          strictEqual(missing.stdout, `${message}\n`);
          writeFileSync(join(binDirectory, tool), "#!/bin/sh\n", { mode: 0o755 });
          strictEqual(run().status, 0, tool);
        }
      } finally {
        rmSync(binDirectory, { recursive: true, force: true });
      }
    },
  );

  it("builds non-interactive workspace lifecycle invocations", () => {
    const options = {
      globalConfig: String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
    };
    const commonArgs = [
      "--global-config",
      String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
    ];
    deepStrictEqual(buildCoderStartWorkspaceInvocation(deployment, workspace, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [...commonArgs, "start", "--yes", "equities-dev"],
    });
    deepStrictEqual(buildCoderStopWorkspaceInvocation(deployment, workspace, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [...commonArgs, "stop", "--yes", "equities-dev"],
    });
    deepStrictEqual(buildCoderRestartWorkspaceInvocation(deployment, workspace, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [...commonArgs, "restart", "--yes", "equities-dev"],
    });
    deepStrictEqual(buildCoderUpdateWorkspaceInvocation(deployment, workspace, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [...commonArgs, "update", "equities-dev"],
    });
  });

  it("builds remote shell commands through Coder", () => {
    const options = { globalConfig: String.raw`C:\T3 Coder\coder-profiles\goldman-us` };
    deepStrictEqual(
      buildCoderWorkspaceShellInvocation(deployment, workspace, 'printf "%s\\n" "$HOME"', options)
        .args,
      [
        "--global-config",
        String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
        "--no-version-warning",
        "--url",
        "https://coder.example.gs.com",
        "ssh",
        "equities-dev",
        "--",
        "sh",
        "-l",
        "-c",
        quotePosixShellArgument('printf "%s\\n" "$HOME"'),
      ],
    );

    const commandWithShellSyntax = `printf "%s\\n" "$PATH"; echo 'still one argument'`;
    const shellInvocation = buildCoderWorkspaceShellInvocation(
      deployment,
      workspace,
      commandWithShellSyntax,
      options,
    );
    deepStrictEqual(shellInvocation.args.slice(-4), [
      "sh",
      "-l",
      "-c",
      quotePosixShellArgument(commandWithShellSyntax),
    ]);
    strictEqual(shellInvocation.args.filter((argument) => argument === "-l").length, 1);
    throws(() => buildCoderWorkspaceShellInvocation(deployment, workspace, "", options));
    throws(() => buildCoderWorkspaceShellInvocation(deployment, workspace, "printf ok\0", options));
  });

  it("builds loopback-only port forwards through the selected Coder deployment", () => {
    const options = { globalConfig: String.raw`C:\T3 Coder\coder-profiles\goldman-us` };
    deepStrictEqual(
      buildCoderPortForwardInvocation(
        deployment,
        workspace,
        {
          id: "web",
          workspaceId: workspace.id,
          protocol: "tcp",
          localPort: 8080,
          remotePort: 3000,
        },
        options,
      ),
      {
        executable: String.raw`C:\Program Files\Coder\coder.exe`,
        args: [
          "--global-config",
          String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
          "--no-version-warning",
          "--url",
          "https://coder.example.gs.com",
          "port-forward",
          "equities-dev",
          "--tcp",
          "127.0.0.1:8080:3000",
        ],
      },
    );
    throws(() =>
      buildCoderPortForwardInvocation(deployment, workspace, {
        id: "web",
        workspaceId: "another-workspace",
        protocol: "tcp",
        localPort: 8080,
        remotePort: 3000,
      }),
    );
  });

  it("rejects a workspace from another deployment", () => {
    throws(() =>
      buildCoderHelperInvocation(deployment, {
        ...workspace,
        deploymentId: "personal",
      }),
    );
  });

  it("opens loopback URLs with platform-native commands", () => {
    deepStrictEqual(buildBrowserOpenInvocation("darwin", "http://127.0.0.1:43127"), {
      executable: "open",
      args: ["http://127.0.0.1:43127/"],
    });
    deepStrictEqual(buildBrowserOpenInvocation("win32", "http://127.0.0.1:43127"), {
      executable: "explorer.exe",
      args: ["http://127.0.0.1:43127/"],
    });
    throws(() => buildBrowserOpenInvocation("win32", "http://localhost:43127"));
    throws(() => buildBrowserOpenInvocation("darwin", "https://example.com"));
    strictEqual(REMOTE_NODE_COMMAND, '"$HOME/.t3-coder/node24/bin/node"');
    strictEqual(REMOTE_HELPER_COMMAND, '"$HOME/.t3-coder/bin/workspace-helper/index.mjs"');
  });
});
