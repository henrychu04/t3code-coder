// @effect-diagnostics nodeBuiltinImport:off
import { deepStrictEqual, match, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";

import {
  buildBrowserOpenInvocation,
  buildCoderHelperInvocation,
  buildCoderHelperInstallInvocation,
  buildCoderListWorkspacesInvocation,
  buildCoderLoginInvocation,
  buildCoderWorkspaceProbeInvocation,
  REMOTE_HELPER_COMMAND,
  REMOTE_HELPER_INSTALL_COMMAND,
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
  workspaceRoot: "/workspace/equities",
} satisfies CoderWorkspaceProfile;

describe("Coder CLI command construction", () => {
  it("builds login and workspace discovery without reading tokens", () => {
    deepStrictEqual(buildCoderLoginInvocation(deployment), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [
        "--disable-network-telemetry",
        "--disable-direct-connections",
        "login",
        "https://coder.example.gs.com",
      ],
    });
    deepStrictEqual(buildCoderListWorkspacesInvocation(deployment), {
      executable: String.raw`C:\Program Files\Coder\coder.exe`,
      args: [
        "--disable-network-telemetry",
        "--disable-direct-connections",
        "--url",
        "https://coder.example.gs.com",
        "list",
        "--output",
        "json",
      ],
    });
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
      "env",
      "'T3_CODER_CWD=/workspace/equities'",
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
      "'T3_CODER_CWD=/workspace/equities'",
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
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /Node\.js 24\.10 or newer/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /command -v claude/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /script -qefc true/u);
    match(REMOTE_WORKSPACE_PROBE_COMMAND, /T3_CODER_CWD/u);
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
    strictEqual(REMOTE_HELPER_COMMAND, '"$HOME/.t3-coder/bin/workspace-helper"');
  });
});
