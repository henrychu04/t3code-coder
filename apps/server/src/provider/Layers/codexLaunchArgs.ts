import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

const CODEX_DISABLED_APP_ARGS = ["--config", "features.apps=false"] as const;

const codexDisabledIntegrationArgs = (mcpServerNames: ReadonlyArray<string>) => {
  const uniqueNames = Array.from(new Set(mcpServerNames));
  const mcpOverride = uniqueNames
    .map((name) => `${JSON.stringify(name)}={enabled=false}`)
    .join(",");
  return [
    ...(mcpOverride ? ["--config", `mcp_servers={${mcpOverride}}`] : []),
    ...CODEX_DISABLED_APP_ARGS,
  ];
};

const codexSharedLaunchArgs = (launchArgs: string | undefined, includeStrictConfig: boolean) => {
  const args = codexLaunchArgv(launchArgs);
  const sharedArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (
      (includeStrictConfig && arg === "--strict-config") ||
      arg.startsWith("--config=") ||
      arg.startsWith("-c=")
    ) {
      sharedArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        sharedArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      sharedArgs.push(arg);
    }
  }

  return sharedArgs;
};

/**
 * Resolve the launch arguments for Codex spawns. When
 * `T3CODE_CODEX_LAUNCH_ARGS` is set in the environment it takes precedence
 * over the user's configured launch arguments: the env var is an escape
 * hatch for support and debugging sessions, while the settings value is the
 * normal user-facing path.
 */
export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (
  launchArgs?: string,
  disabledMcpServerNames: ReadonlyArray<string> = [],
) => codexSessionAppServerArgs(launchArgs, disabledMcpServerNames);

export const codexExecLaunchArgs = (
  launchArgs?: string,
  disabledMcpServerNames: ReadonlyArray<string> = [],
) => [
  ...codexSharedLaunchArgs(launchArgs, true),
  ...codexDisabledIntegrationArgs(disabledMcpServerNames),
];

export const codexMcpListArgs = (launchArgs?: string) => [
  ...codexSharedLaunchArgs(launchArgs, false),
  ...CODEX_DISABLED_APP_ARGS,
  "mcp",
  "list",
  "--json",
];

export const codexSessionAppServerArgs = (
  launchArgs: string | undefined,
  disabledMcpServerNames: ReadonlyArray<string> = [],
) => {
  return [
    "app-server",
    ...codexLaunchArgv(launchArgs),
    ...codexDisabledIntegrationArgs(disabledMcpServerNames),
  ];
};
