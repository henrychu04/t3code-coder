import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const entryPoint = fileURLToPath(new URL("./bin.ts", import.meta.url));
const defaultOutfile = fileURLToPath(new URL("../dist/workspace-helper", import.meta.url));

export async function buildCoderHelper(outfile = defaultOutfile): Promise<void> {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
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
}

if (import.meta.main) {
  await buildCoderHelper();
}
