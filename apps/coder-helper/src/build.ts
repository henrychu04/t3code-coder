import { build } from "esbuild";
import * as NodeFS from "node:fs/promises";
import { createRequire } from "node:module";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("./bin.ts", import.meta.url));
const defaultOutputDirectory = fileURLToPath(new URL("../dist/workspace-helper", import.meta.url));
type HelperNativeTarget = "darwin-arm64" | "darwin-x64" | "linux-x64-gnu" | "win32-x64";

const nativePackagesByTarget: Record<HelperNativeTarget, readonly [fff: string, ffi: string]> = {
  "darwin-arm64": ["@ff-labs/fff-bin-darwin-arm64", "@yuuang/ffi-rs-darwin-arm64"],
  "darwin-x64": ["@ff-labs/fff-bin-darwin-x64", "@yuuang/ffi-rs-darwin-x64"],
  "linux-x64-gnu": ["@ff-labs/fff-bin-linux-x64-gnu", "@yuuang/ffi-rs-linux-x64-gnu"],
  "win32-x64": ["@ff-labs/fff-bin-win32-x64", "@yuuang/ffi-rs-win32-x64-msvc"],
};

const nodePtyPrebuildByTarget: Record<HelperNativeTarget, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64-gnu": "linux-x64",
  "win32-x64": "win32-x64",
};

export function currentHelperNativeTarget(): HelperNativeTarget {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64-gnu";
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  throw new Error(`Unsupported helper build host: ${process.platform}/${process.arch}.`);
}

async function copyRuntimePackages(
  outputDirectory: string,
  nativeTarget: HelperNativeTarget,
): Promise<void> {
  const fffPackageJson = await NodeFS.realpath(
    fileURLToPath(
      new URL("../../server/node_modules/@ff-labs/fff-node/package.json", import.meta.url),
    ),
  );
  const requireFromFff = createRequire(fffPackageJson);
  const runtimePackages = [
    "@ff-labs/fff-node",
    "ffi-rs",
    ...nativePackagesByTarget[nativeTarget],
  ] as const;
  const packageJsonByName = new Map<string, string>([
    ["@ff-labs/fff-node", fffPackageJson],
    ...runtimePackages
      .slice(1)
      .map(
        (packageName) =>
          [packageName, requireFromFff.resolve(`${packageName}/package.json`)] as const,
      ),
  ]);

  await Promise.all(
    runtimePackages.map(async (packageName) => {
      const packageJson = packageJsonByName.get(packageName);
      if (!packageJson)
        throw new Error(`Could not resolve helper runtime package '${packageName}'.`);
      const destination = NodePath.join(outputDirectory, "node_modules", ...packageName.split("/"));
      await NodeFS.mkdir(NodePath.dirname(destination), { recursive: true });
      await NodeFS.cp(NodePath.dirname(packageJson), destination, { recursive: true });
    }),
  );

  const requireFromServer = createRequire(
    fileURLToPath(new URL("../../server/package.json", import.meta.url)),
  );
  const nodePtyPackageJson = await NodeFS.realpath(
    requireFromServer.resolve("node-pty/package.json"),
  );
  const nodePtySource = NodePath.dirname(nodePtyPackageJson);
  const nodePtyDestination = NodePath.join(outputDirectory, "node_modules", "node-pty");
  const prebuild = nodePtyPrebuildByTarget[nativeTarget];

  await NodeFS.mkdir(NodePath.join(nodePtyDestination, "prebuilds"), { recursive: true });
  await Promise.all([
    NodeFS.copyFile(nodePtyPackageJson, NodePath.join(nodePtyDestination, "package.json")),
    NodeFS.copyFile(
      NodePath.join(nodePtySource, "LICENSE"),
      NodePath.join(nodePtyDestination, "LICENSE"),
    ),
    NodeFS.cp(NodePath.join(nodePtySource, "lib"), NodePath.join(nodePtyDestination, "lib"), {
      recursive: true,
    }),
    NodeFS.cp(
      NodePath.join(nodePtySource, "prebuilds", prebuild),
      NodePath.join(nodePtyDestination, "prebuilds", prebuild),
      { recursive: true },
    ),
  ]);
}

export async function buildCoderHelper(
  outputDirectory = defaultOutputDirectory,
  nativeTarget: HelperNativeTarget = "linux-x64-gnu",
): Promise<void> {
  await NodeFS.rm(outputDirectory, { recursive: true, force: true });
  await NodeFS.mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [entryPoint],
    outfile: NodePath.join(outputDirectory, "index.mjs"),
    bundle: true,
    external: ["@ff-labs/fff-node", "node-pty"],
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __t3CreateRequire } from "node:module";',
        "const require = __t3CreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });
  await copyRuntimePackages(outputDirectory, nativeTarget);
}

if (import.meta.main) {
  await buildCoderHelper();
}
