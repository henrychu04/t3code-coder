// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";

import {
  buildBrowserOpenInvocation,
  buildCoderAuthStatusInvocation,
  buildCoderHelperInvocation,
  buildCoderHelperInstallInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderWorkspaceProbeInvocation,
  REMOTE_HELPER_COMMAND,
  REMOTE_HELPER_INSTALL_COMMAND,
  REMOTE_NODE_COMMAND,
  REMOTE_WORKSPACE_PROBE_COMMAND,
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
        "--disable-network-telemetry",
        "--disable-direct-connections",
        "--no-open",
        "login",
        "https://coder.example.gs.com",
      ],
    });
    deepStrictEqual(buildCoderAuthStatusInvocation(deployment, options).args, [
      "--global-config",
      String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "whoami",
    ]);
    deepStrictEqual(buildCoderListWorkspacesInvocation(deployment, options), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [
        "--global-config",
        String.raw`C:\T3 Coder\coder-profiles\goldman-us`,
        "--disable-network-telemetry",
        "--disable-direct-connections",
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
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
    ]);
    deepStrictEqual(buildCoderHelperInvocation(deployment, workspace).args, [
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "env",
      "'T3_CODER_WORKSPACE_LABEL=Goldman US · Equities'",
      REMOTE_NODE_COMMAND,
      REMOTE_HELPER_COMMAND,
      "--stdio",
    ]);
    deepStrictEqual(buildCoderHelperInstallInvocation(deployment, workspace).args, [
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--url",
      "https://coder.example.gs.com",
      "ssh",
      "equities-dev",
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(REMOTE_HELPER_INSTALL_COMMAND),
    ]);
    match(
      REMOTE_WORKSPACE_PROBE_COMMAND,
      /if ! \[ -x .*node24\/bin\/node.*nix-env --profile .*node24.*nixpkgs\.nodejs_24.*; fi/u,
    );
    strictEqual(REMOTE_WORKSPACE_PROBE_COMMAND.includes("github:"), false);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /\.t3-coder\/node24\/bin\/node/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /command -v claude/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /script -qefc true/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /workspace HOME directory/u);
    strictEqual(quotePosixShellArgument("a b'c"), "'a b'\\''c'");
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
    strictEqual(REMOTE_HELPER_COMMAND, '"$HOME/.t3-coder/bin/workspace-helper"');
  });
});
