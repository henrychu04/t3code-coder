// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export function resolveCoderConfigPath(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}): string {
  const environment = input.environment ?? {};
  switch (input.platform) {
    case "win32": {
      const appData = environment.APPDATA?.trim();
      return NodePath.win32.join(
        appData && appData.length > 0
          ? appData
          : NodePath.win32.join(input.homeDirectory, "AppData", "Roaming"),
        "t3-coder",
        "config.json",
      );
    }
    case "darwin":
      return NodePath.posix.join(
        input.homeDirectory,
        "Library",
        "Application Support",
        "t3-coder",
        "config.json",
      );
    default: {
      const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
      return NodePath.posix.join(
        xdgConfigHome && xdgConfigHome.length > 0
          ? xdgConfigHome
          : NodePath.posix.join(input.homeDirectory, ".config"),
        "t3-coder",
        "config.json",
      );
    }
  }
}
