// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
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
  buildCoderScpConfigInvocation,
  buildCoderWorkspaceShellInvocation,
  buildCoderWorkspaceStatsInvocation,
  buildCoderWorkspaceProbeInvocation,
  REMOTE_HELPER_COMMAND,
  REMOTE_HELPER_READY_SENTINEL,
  REMOTE_NODE_COMMAND,
  REMOTE_WORKSPACE_PROBE_COMMAND,
  REMOTE_WORKSPACE_STATS_COMMAND,
  quotePosixShellArgument,
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

  it("builds Linux probe and foreground helper invocations as argument arrays", () => {
    deepStrictEqual(buildCoderWorkspaceProbeInvocation(deployment, workspace).args, [
      "--no-version-warning",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "sh",
      "-l",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
    ]);
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
    match(REMOTE_WORKSPACE_STATS_COMMAND, /coder stat cpu --output=json/u);
    match(REMOTE_WORKSPACE_STATS_COMMAND, /coder stat mem --output=json/u);
    match(REMOTE_WORKSPACE_STATS_COMMAND, /coder stat disk --path "\$HOME" --output=json/u);
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
          "set -eu",
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
      REMOTE_WORKSPACE_PROBE_COMMAND,
      /if ! \[ -x .*node24\/bin\/node.*nix-env --profile .*node24.*nixpkgs\.nodejs_24.*; fi/u,
    );
    strictEqual(REMOTE_WORKSPACE_PROBE_COMMAND.includes("--attr-path"), false);
    strictEqual(REMOTE_WORKSPACE_PROBE_COMMAND.includes("github:"), false);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /process\.exit\(major >= 24 \? 0 : 1\)/u);
    strictEqual(REMOTE_WORKSPACE_PROBE_COMMAND.includes("24.10"), false);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /\.t3-coder\/node24\/bin\/node/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /command -v claude/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /script -qefc true/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /workspace HOME directory/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /\.t3-coder\/attachments/u);
    strictEqual(quotePosixShellArgument("a b'c"), "'a b'\\''c'");
  });

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

  it("builds temporary SCP configuration and remote commands through Coder", () => {
    const options = { globalConfig: String.raw`C:\T3 Coder\coder-profiles\goldman-us` };
    deepStrictEqual(
      buildCoderScpConfigInvocation(
        deployment,
        String.raw`C:\Temp\t3-coder\ssh-config`,
        "t3-coder-1234-",
        options,
      ).args,
      [
        "--global-config",
        String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
        "--no-version-warning",
        "--url",
        "https://coder.example.gs.com",
        "config-ssh",
        "--yes",
        "--wait=no",
        "--ssh-config-file",
        String.raw`C:\Temp\t3-coder\ssh-config`,
        "--ssh-host-prefix",
        "t3-coder-1234-",
      ],
    );
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
